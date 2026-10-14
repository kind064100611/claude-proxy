const test = require("node:test");
const assert = require("node:assert/strict");
const { createSummaryModel, pickModels, numberedInput, parseSummary, MAX_INPUT_BYTES } = require("../lib/summary-model");

const catalog = (ids) => async () => ({ object: "list", data: ids.map((id) => ({ id })) });
const reply = JSON.stringify({ summary: "build failed", highlights: [{ start: 2, end: 2, reason: "error" }] });

test("pickModels chooses the newest Luna and Haiku versions", () => {
  assert.deepEqual(pickModels(["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol", "claude-haiku-4.5", "claude-haiku-5.5", "claude-opus-5.5"]),
    { luna: "gpt-6-luna", haiku: "claude-haiku-5.5" });
  assert.deepEqual(pickModels(["claude-opus-5.5"]), { luna: undefined, haiku: undefined });
});

test("numbered input matches Read line numbers and keeps head and tail of oversized output", () => {
  assert.match(numberedInput("a\nb", { name: "Bash", input: { command: "make" } }), /Tool: Bash\nTool input: \{"command":"make"\}\nTotal lines: 2\n\n1: a\n2: b$/);
  const line = "x".repeat(1000);
  const input = numberedInput(Array(3000).fill(line).join("\n"), null);
  assert.ok(Buffer.byteLength(input) <= MAX_INPUT_BYTES + 2048);
  assert.match(input, /\n1: x+\n/);
  assert.match(input, /\n3000: x+$/);
  assert.match(input, /\[lines \d+-\d+ omitted\]/);
});

test("parseSummary validates JSON and clamps highlights to real line ranges", () => {
  const parsed = parseSummary('Here: {"summary":" s ","highlights":[{"start":3,"end":200,"reason":"r"},{"start":0,"end":1},{"start":9,"end":10},{"start":"1","end":2}]}', 50);
  assert.deepEqual(parsed, { summary: "s", highlights: [{ start: 3, end: 42, reason: "r" }, { start: 9, end: 10, reason: "" }] });
  assert.throws(() => parseSummary('{"highlights":[]}', 5));
  assert.throws(() => parseSummary("not json", 5));
});

test("Luna is preferred, called without replay memory, and the model choice is cached until restart", async () => {
  let catalogCalls = 0;
  const requests = [];
  const { summarize } = createSummaryModel({
    getAvailableModels: async () => { catalogCalls++; return catalog(["gpt-6-luna", "claude-haiku-5.5"])(); },
    requestResponsesImpl: async (body, options) => { requests.push({ body, options }); return { content: reply }; },
    fetchImpl: async () => { throw new Error("Haiku must not be called"); }
  });
  const first = await summarize("ok\nerror: failed", { name: "Bash", input: {} });
  assert.deepEqual(first, { model: "gpt-6-luna", summary: "build failed", highlights: [{ start: 2, end: 2, reason: "error" }] });
  await summarize("again", null);
  assert.equal(catalogCalls, 1);
  assert.equal(requests[0].body.model, "gpt-6-luna");
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].options.remember, false);
  assert.match(requests[0].body.messages[1].content, /2: error: failed/);
});

test("Haiku is used when Luna is absent or fails, and all failures return null", async () => {
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, options });
    return { ok: true, json: async () => ({ content: [{ type: "text", text: reply }] }) };
  };
  const loadClaudeAuth = async () => ({ baseUrl: "https://copilot.test", token: "test-token" });
  const warnings = [];
  const { summarize: failingLuna } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna", "claude-haiku-5.5"]),
    requestResponsesImpl: async () => { throw Object.assign(new Error("private upstream text"), { status: 429 }); },
    fetchImpl, loadClaudeAuth, onWarning: (event) => warnings.push(event) });
  assert.equal((await failingLuna("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(Object.keys(warnings[0]).sort(), ["model", "ms", "status"]);
  assert.equal(warnings[0].status, 429);
  assert.equal(sent[0].url, "https://copilot.test/v1/messages");
  assert.equal(sent[0].options.headers["X-Initiator"], "agent");
  assert.equal(JSON.parse(sent[0].options.body).model, "claude-haiku-5.5");

  const { summarize: failing } = createSummaryModel({ getAvailableModels: catalog(["claude-haiku-5.5"]), loadClaudeAuth,
    fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(await failing("a", null), null);
  assert.equal(await createSummaryModel({ getAvailableModels: catalog([]) }).summarize("a", null), null);
});

test("a slow summary model is aborted at the timeout", async () => {
  const { summarize } = createSummaryModel({ getAvailableModels: catalog(["gpt-6-luna"]), timeoutMs: 20,
    requestResponsesImpl: (body, { control }) => new Promise((_, reject) => {
      control.abort = (message, status) => reject(Object.assign(new Error(message), { status }));
    }) });
  assert.equal(await summarize("a", null), null);
});

test("an empty catalog is not cached so a later request can find the models", async () => {
  let ids = [];
  const { summarize } = createSummaryModel({ getAvailableModels: async () => catalog(ids)(),
    requestResponsesImpl: async () => ({ content: reply }) });
  assert.equal(await summarize("a\nb", null), null);
  ids = ["gpt-6-luna"];
  assert.equal((await summarize("a\nb", null)).model, "gpt-6-luna");
});

test("the user-selected model is tried first and falls back to the detected cheap models", async () => {
  const tried = [];
  let preferred = "claude-sonnet-5.5";
  const fetchImpl = async (url, options) => {
    const model = JSON.parse(options.body).model;
    tried.push(model);
    return model === "claude-sonnet-5.5" ? { ok: false, status: 503 } : { ok: true, json: async () => ({ content: [{ type: "text", text: reply }] }) };
  };
  const { summarize } = createSummaryModel({ getAvailableModels: catalog(["claude-haiku-5.5", "claude-sonnet-5.5"]),
    getPreferredModel: () => preferred, fetchImpl, loadClaudeAuth: async () => ({ baseUrl: "https://copilot.test", token: "t" }) });
  assert.equal((await summarize("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(tried, ["claude-sonnet-5.5", "claude-haiku-5.5"]);
  preferred = "z-ai/glm5";
  tried.length = 0;
  assert.equal((await summarize("a\nb", null)).model, "claude-haiku-5.5");
  assert.deepEqual(tried, ["claude-haiku-5.5"]);
});

test("default model and selectable list come from the catalog without failing the page", async () => {
  const model = createSummaryModel({ getAvailableModels: catalog(["z-ai/glm5", "gpt-6-luna", "claude-haiku-5.5", "gpt-6.1-sol", "gpt-6-luna"]) });
  assert.equal(await model.getDefaultModel(), "gpt-6-luna");
  assert.deepEqual(await model.listModels(), ["claude-haiku-5.5", "gpt-6-luna", "gpt-6.1-sol"]);
  const broken = createSummaryModel({ getAvailableModels: async () => { throw new Error("offline"); } });
  assert.equal(await broken.getDefaultModel(), null);
  assert.deepEqual(await broken.listModels(), []);
});
