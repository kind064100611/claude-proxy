const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { createOnlineSummary, createSummarySettings, getFeatureConfigPath, getStatus, setFeatures, render, THRESHOLD_BYTES } = require("../lib/online-summary");

const large = "BEGIN\n" + "exact archived line\n".repeat(1800) + "END\n";
const readTool = { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } };
const initial = (session = "test-session") => ({ model: "gpt-6.1-sol", metadata: { user_id: session },
  tools: [readTool], system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Test" }] });
function addResult(body, id, text = large, options = {}) {
  return { ...body, messages: [...body.messages,
    { role: "assistant", content: [{ type: "thinking", thinking: "public summary", signature: "opaque-signature" },
      { type: "tool_use", id, name: "Bash", input: { command: "make test" }, ...(options.call || {}) }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id,
      content: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } }], ...(options.result || {}) }] }] };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "online-summary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, "gateway-observations");
  const warnings = [];
  const model = { calls: 0, fail: false };
  const summarize = async (text, call) => {
    model.calls++;
    model.lastCall = call;
    if (model.fail) return null;
    return { model: "gpt-test-luna", summary: model.summaryText || "synthetic summary", highlights: [{ start: 2, end: 3, reason: "key lines" }] };
  };
  const toggle = (enabled) => fs.writeFileSync(path.join(root, "gateway-features.json"), JSON.stringify({ version: 1, onlineSummary: enabled }));
  toggle(true);
  const create = () => createOnlineSummary({ configFile: path.join(root, "gateway-features.json"), archiveRoot, summarize,
    onWarning: (event) => warnings.push(event) });
  return { root, archiveRoot, create, toggle, warnings, model, pack: create() };
}
const lastText = (body) => body.messages.at(-1).content[0].content[0].text;
const archiveFile = (text) => JSON.parse(text.match(/file_path=("(?:[^"\\]|\\.)*")/)[1]);

function featureFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "feature-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, filename: getFeatureConfigPath(home),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, "other-cli-root") } };
}

test("feature toggle defaults on in user HOME, CLI preserves other fields, and reads never create files", (t) => {
  const { home, filename, env } = featureFixture(t);
  const modulePath = path.resolve(__dirname, "../lib/online-summary");
  const scriptPath = path.resolve(__dirname, "../scripts/toggle-online-summary.js");
  const read = () => JSON.parse(execFileSync(process.execPath, ["-e", `const p = require(${JSON.stringify(modulePath)}); console.log(JSON.stringify({file:p.getFeatureConfigPath(),status:p.createOnlineSummary().getStatus()}));`], { cwd: home, env, encoding: "utf8" }));
  assert.deepEqual(read(), { file: filename, status: { onlineSummary: true, summaryModel: null, summaryThreshold: 8192, summaryPrompt: null, archiveRetentionDays: 30, projectMemory: null, claudeLauncher: null } });
  execFileSync(process.execPath, [scriptPath, "status"], { cwd: home, env });
  assert.equal(fs.existsSync(path.dirname(filename)), false);
  fs.mkdirSync(path.dirname(filename), { mode: 0o700 });
  fs.writeFileSync(filename, JSON.stringify({ version: 1, observationPack: true, futureOption: "retained" }));
  assert.equal(read().status.onlineSummary, true);
  assert.match(execFileSync(process.execPath, [scriptPath, "off"], { cwd: home, env, encoding: "utf8" }), /Online Summary: OFF/);
  assert.equal(read().status.onlineSummary, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { version: 1, observationPack: true, futureOption: "retained", onlineSummary: false });
  assert.equal(fs.existsSync(env.CLAUDE_CONFIG_DIR), false);
  execFileSync(process.execPath, [scriptPath, "on"], { cwd: home, env });
  assert.equal(read().status.onlineSummary, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ["gateway-features.json"]);
});

test("malformed configuration disables new summaries; module creation is side-effect free", (t) => {
  const { home, filename } = featureFixture(t);
  fs.mkdirSync(path.dirname(filename));
  for (const bytes of ["{broken", '{"version":2,"onlineSummary":true}', '{"version":1,"onlineSummary":"true"}', "null", "x".repeat(65537)]) {
    fs.writeFileSync(filename, bytes);
    assert.equal(getStatus(filename).onlineSummary, false);
  }
  const pack = createOnlineSummary({ configFile: path.join(home, "missing.json"), archiveRoot: path.join(home, "archives") });
  assert.equal(pack.getStatus().onlineSummary, true);
  assert.equal(fs.existsSync(path.join(home, "archives")), false);
});

test("toggle writes refuse symlink targets/directories without modifying external files", { skip: process.platform === "win32" }, (t) => {
  const { home, filename, env } = featureFixture(t);
  const outside = path.join(home, "outside.json");
  const original = '{"version":1,"onlineSummary":true}';
  fs.writeFileSync(outside, original);
  fs.mkdirSync(path.dirname(filename));
  fs.symlinkSync(outside, filename);
  assert.equal(getStatus(filename).onlineSummary, false);
  const script = path.resolve(__dirname, "../scripts/toggle-online-summary.js");
  assert.throws(() => execFileSync(process.execPath, [script, "off"], { env, stdio: "pipe" }));
  assert.equal(fs.readFileSync(outside, "utf8"), original);
  fs.unlinkSync(filename);
  fs.rmdirSync(path.dirname(filename));
  const outsideDirectory = path.join(home, "outside-directory");
  fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory, path.dirname(filename));
  assert.throws(() => execFileSync(process.execPath, [script, "on"], { env, stdio: "pipe" }));
  assert.deepEqual(fs.readdirSync(outsideDirectory), []);
});

test("new results are summarized with verbatim excerpts and archived exactly; schema and inputs stay unchanged", async (t) => {
  const { pack, model } = fixture(t);
  const first = initial();
  assert.strictEqual((await pack.prepare(first)).body, first);
  const body = addResult(first, "call_one");
  const snapshot = JSON.stringify(body);
  const prepared = await pack.prepare(body);
  assert.equal(prepared.stats.packed_results, 1);
  assert.equal(prepared.stats.summarized_results, 1);
  assert.equal(prepared.stats.summary_models, "gpt-test-luna");
  assert.ok(prepared.stats.avoided_bytes > THRESHOLD_BYTES);
  assert.equal(model.lastCall.name, "Bash");
  const view = lastText(prepared.body);
  assert.ok(view.startsWith("[Gateway online summary of tool output by gpt-test-luna:"));
  assert.ok(view.includes("[Summary]\nsynthetic summary"));
  assert.ok(view.includes("[Lines 2-3: key lines]\n2: exact archived line\n3: exact archived line\n"));
  const filename = archiveFile(view);
  assert.equal(fs.readFileSync(filename, "utf8"), large);
  assert.equal(JSON.stringify(body), snapshot);
  assert.strictEqual(prepared.body.tools, body.tools);
  assert.strictEqual(prepared.body.system, body.system);
  assert.strictEqual(prepared.body.messages[1], body.messages[1]);
  assert.deepEqual(prepared.body.messages[2].content[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
  }
});

test("later requests that reuse a pinned summary still report its model", async (t) => {
  const { pack, model } = fixture(t);
  const first = initial();
  await pack.prepare(first);
  const summarized = addResult(first, "call_one");
  await pack.prepare(summarized);
  const reused = await pack.prepare(addResult(summarized, "call_small", "short output"));
  assert.equal(model.calls, 1);
  assert.equal(reused.stats.summarized_results, 0);
  assert.equal(reused.stats.packed_results, 1);
  assert.equal(reused.stats.summary_models, "gpt-test-luna");
  assert.equal((await pack.prepare(addResult(first, "call_tiny", "short output"))).stats.summary_models, undefined);
});

test("render keeps excerpts verbatim, truncates long lines, skips repeated lines and lists ranges beyond the budget", () => {
  const text = Array.from({ length: 4000 }, (_, index) => `line ${index + 1} ${"x".repeat(index === 9 ? 500 : 40)}`).join("\n");
  const highlights = [{ start: 1, end: 40, reason: "first" }, { start: 20, end: 45, reason: "overlap" },
    ...Array.from({ length: 18 }, (_, index) => ({ start: index * 100 + 200, end: index * 100 + 239, reason: `r${index}` }))];
  const output = render(text, "/archive/file.txt", Buffer.byteLength(text), { model: "m", summary: "s", highlights });
  assert.ok(output.length <= 16384);
  assert.ok(output.includes("[Lines 1-40: first]\n1: line 1 "));
  assert.ok(output.includes(`10: line 10 ${"x".repeat(300 - "line 10 ".length)}…\n`));
  assert.ok(output.includes("[Lines 41-45: overlap]\n41: line 41 "));
  assert.equal(output.match(/\n20: line 20 /g).length, 1);
  assert.match(output, /\[More key lines not shown; Read these line ranges if needed\]\n(\d+-\d+: r\d+\n)+\[End\]$/);
  const small = render("a\nb\n" + "c".repeat(9000), "/f", 9004, { model: "m", summary: "s", highlights: [{ start: 1, end: 2, reason: "" }] });
  assert.ok(small.includes("[Lines 1-2]\n1: a\n2: b\n"));
});

test("projections stay stable across retries, restart, models and toggle changes", async (t) => {
  const { pack, create, toggle, model } = fixture(t);
  const first = initial();
  await pack.prepare(first);
  const one = addResult(first, "call_one");
  const view = lastText((await pack.prepare(one)).body);
  for (const name of ["gpt-6.1-sol", "claude-sonnet-5.5", "z-ai/glm5"]) {
    assert.equal(lastText((await create().prepare({ ...one, model: name })).body), view);
  }
  assert.equal(model.calls, 1);
  toggle(false);
  const two = addResult(one, "call_two");
  const disabled = await create().prepare(two);
  assert.equal(disabled.stats.enabled, false);
  assert.equal(disabled.body.messages[2].content[0].content[0].text, view);
  assert.equal(lastText(disabled.body), large);
  assert.equal(model.calls, 1);
  toggle(true);
  const three = addResult(two, "call_three");
  const enabled = await create().prepare(three);
  assert.equal(enabled.body.messages[4].content[0].content[0].text, large);
  assert.notEqual(lastText(enabled.body), large);
  assert.deepEqual(enabled.body.messages.slice(0, disabled.body.messages.length), disabled.body.messages);
});

test("Read output stays verbatim and summary failures keep the original pinned", async (t) => {
  const { pack, model } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const read = addResult(base, "read", large, { call: { name: "Read", input: { file_path: "/source.txt" } } });
  assert.strictEqual((await pack.prepare(read)).body, read);
  assert.equal(model.calls, 0);
  model.fail = true;
  const failed = addResult(read, "failed");
  const output = await pack.prepare(failed);
  assert.equal(model.calls, 1);
  assert.equal(output.stats.summarized_results, 0);
  assert.equal(lastText(output.body), large);
  model.fail = false;
  assert.equal(lastText((await pack.prepare(failed)).body), large);
  assert.equal(model.calls, 1);
});

test("trailing system messages after the newest result do not block summaries", async (t) => {
  const { pack } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const one = addResult(base, "call_one");
  const reminder = { role: "system", content: [{ type: "text", text: "reminder" }] };
  const body = { ...one, messages: [...one.messages, reminder] };
  const prepared = await pack.prepare(body);
  assert.equal(prepared.stats.packed_results, 1);
  assert.ok(prepared.body.messages.at(-2).content[0].content[0].text.includes("[Gateway online summary"));
  assert.strictEqual(prepared.body.messages.at(-1), reminder);
});

test("initial history and previously unseen older results are never retroactively summarized", async (t) => {
  const { pack } = fixture(t);
  const warm = addResult(initial(), "old_call");
  assert.strictEqual((await pack.prepare(warm)).body, warm);
  const past = addResult(warm, "previously_unseen_old");
  const fresh = addResult(past, "new_call");
  const output = (await pack.prepare(fresh)).body;
  assert.equal(output.messages[2].content[0].content[0].text, large);
  assert.equal(output.messages[4].content[0].content[0].text, large);
  assert.notEqual(lastText(output), large);
});

test("archive recalls, errors, small output, mixed content and absent Read/session fail safe", async (t) => {
  const { pack, archiveRoot, model } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const recall = addResult(base, "recall", large, { call: { input: { command: `sed -n 1,9p ${path.join(archiveRoot, "a.txt")}` } } });
  const cases = [
    addResult(base, "small", "small"),
    addResult(base, "error", large, { result: { is_error: true } }),
    addResult(base, "mixed", large, { result: { content: [{ type: "text", text: large }, { type: "image", source: {} }] } }),
    recall,
    { ...addResult(base, "no_read"), tools: [] },
    { ...addResult(base, "no_session"), metadata: {} },
    addResult(base, "extra_blocks", large, { result: { content: [{ type: "text", text: large }, { type: "text", text: "extra" }] } })
  ];
  for (const body of cases) assert.strictEqual((await pack.prepare(body)).body, body);
  assert.equal(model.calls, 0);
  const again = await pack.prepare(addResult(base, "recall_again", large + "x", { call: { name: "Read", input: { file_path: path.join(archiveRoot, "a.txt") } } }));
  assert.equal(again.stats.recalled_results, 1);
});

test("string results and read-only token counts preserve pinned state without advancing it", async (t) => {
  const { pack, model } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const body = addResult(base, "string", large, { result: { content: large } });
  assert.strictEqual((await pack.prepare(body, { readOnly: true })).body, body);
  assert.equal(model.calls, 0);
  const view = (await pack.prepare(body)).body.messages.at(-1).content[0].content;
  assert.equal(typeof view, "string");
  assert.equal((await pack.prepare(body, { readOnly: true })).body.messages.at(-1).content[0].content, view);
});

test("session and content isolation; duplicate old results cannot alter the prefix", async (t) => {
  const { pack } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const first = addResult(base, "same_id");
  const view = lastText((await pack.prepare(first)).body);
  const other = { ...first, metadata: { user_id: "other_session" } };
  assert.strictEqual((await pack.prepare(other)).body, other);
  const changed = addResult(base, "same_id", large + "edited");
  assert.notEqual(lastText((await pack.prepare(changed)).body), view);
  const duplicate = addResult(addResult(first, "duplicate"), "duplicate");
  const result = (await pack.prepare(duplicate)).body;
  assert.equal(result.messages[4].content[0].content[0].text, large);
  assert.equal(lastText(result), large);
});

test("concurrent requests re-read the ledger after summarizing and agree on one projection", async (t) => {
  const { pack, create } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const body = addResult(base, "parallel");
  const [left, right] = await Promise.all([pack.prepare(body), create().prepare(body)]);
  assert.equal(lastText(left.body), lastText(right.body));
  assert.equal(left.stats.summarized_results + right.stats.summarized_results, 1);
});

test("interrupted writes freeze new summaries while preserving existing projections and privacy", async (t) => {
  const { pack, create, warnings, model } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const first = addResult(base, "one");
  const packed = await pack.prepare(first);
  const file = archiveFile(lastText(packed.body));
  fs.writeFileSync(path.join(path.dirname(file), "pending"), "interrupted");
  const next = addResult(first, "two");
  const output = (await create().prepare(next)).body;
  assert.deepEqual(output.messages.slice(0, packed.body.messages.length), packed.body.messages);
  assert.equal(lastText(output), large);
  assert.equal(model.calls, 1);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((warning) => Object.keys(warning).join() === "code"));
});

test("append failures fail open, but unreadable existing ledgers never rewrite history", async (t) => {
  const { pack, create, warnings } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const first = addResult(base, "one");
  const packed = await pack.prepare(first);
  const directory = path.dirname(archiveFile(lastText(packed.body)));
  const second = addResult(first, "two", large + "new bytes");
  const filename = crypto.createHash("sha256").update(large + "new bytes").digest("hex") + ".txt";
  fs.mkdirSync(path.join(directory, filename));
  const output = (await pack.prepare(second)).body;
  assert.equal(lastText(output), large + "new bytes");
  assert.deepEqual(output.messages.slice(0, packed.body.messages.length), packed.body.messages);
  assert.ok(fs.existsSync(path.join(directory, "pending")));
  assert.ok(warnings.some((warning) => warning.code === "observation_archive_append_failed"));
  fs.writeFileSync(path.join(directory, "state.json"), "{broken");
  await assert.rejects(create().prepare(second), (error) => error.status === 503);
});

test("malformed configuration disables new summaries without removing existing views", async (t) => {
  const { pack, root } = fixture(t);
  const base = initial();
  await pack.prepare(base);
  const one = addResult(base, "one");
  const packed = (await pack.prepare(one)).body;
  fs.writeFileSync(path.join(root, "gateway-features.json"), "{broken");
  assert.equal(pack.getStatus().onlineSummary, false);
  assert.deepEqual((await pack.prepare(one)).body, packed);
  assert.equal(lastText((await pack.prepare(addResult(one, "two"))).body), large);
});

test("summary model selection persists, is validated and can return to automatic detection", async (t) => {
  const { home, filename } = featureFixture(t);
  let models = ["claude-haiku-5.5", "gpt-6-luna"];
  const settings = createSummarySettings({ configFile: filename, getDefaultModel: async () => "gpt-6-luna", listModels: async () => models });
  const thresholds = [4096, 8192, 16384, 32768];
  const prompts = { prompt: "", customPrompt: false, retentionDays: 30, retentionOptions: [7, 14, 30, 60, 90, 0] };
  assert.deepEqual(await settings.getStatus(), { enabled: true, model: null, defaultModel: "gpt-6-luna", models, threshold: 8192, thresholds, ...prompts });
  assert.equal(fs.existsSync(filename), false);
  assert.deepEqual(await settings.configure({ summaryModel: "claude-haiku-5.5" }), { enabled: true, model: "claude-haiku-5.5", defaultModel: "gpt-6-luna", models, threshold: 8192, thresholds, ...prompts });
  await settings.configure({ onlineSummary: false, summaryThreshold: 8192 });
  assert.deepEqual(getStatus(filename), { onlineSummary: false, summaryModel: "claude-haiku-5.5", summaryThreshold: 8192, summaryPrompt: null, archiveRetentionDays: 30, projectMemory: null, claudeLauncher: null });
  await assert.rejects(settings.configure({ summaryThreshold: 1000 }), { code: "INVALID_SUMMARY_THRESHOLD" });
  await assert.rejects(settings.configure({ summaryModel: "not-listed" }), { code: "UNKNOWN_SUMMARY_MODEL" });
  assert.equal(getStatus(filename).summaryModel, "claude-haiku-5.5");
  models = [];
  assert.equal((await settings.getStatus()).model, "claude-haiku-5.5");
  await settings.configure({ summaryModel: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { version: 1, onlineSummary: false, summaryThreshold: 8192 });
  assert.throws(() => setFeatures({ onlineSummary: "yes" }, filename));
  assert.throws(() => setFeatures({ summaryModel: "bad model id" }, filename));
  fs.writeFileSync(filename, JSON.stringify({ version: 1, summaryModel: "bad model id", summaryThreshold: 5000 }));
  assert.deepEqual(getStatus(filename), { onlineSummary: true, summaryModel: null, summaryThreshold: 8192, summaryPrompt: null, archiveRetentionDays: 30, projectMemory: null, claudeLauncher: null });
  assert.equal(fs.existsSync(path.join(home, "other-cli-root")), false);
});

test("project memory is unchosen by default, persists only a boolean and is off for malformed or unsafe configuration", (t) => {
  const { filename } = featureFixture(t);
  assert.equal(getStatus(filename).projectMemory, null);
  assert.throws(() => setFeatures({ projectMemory: "true" }, filename));
  assert.equal(fs.existsSync(filename), false);
  setFeatures({ projectMemory: true }, filename);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { version: 1, projectMemory: true });
  assert.equal(getStatus(filename).projectMemory, true);
  assert.equal(getStatus(filename).onlineSummary, true);
  setFeatures({ projectMemory: false }, filename);
  assert.equal(getStatus(filename).projectMemory, false);
  fs.writeFileSync(filename, '{"version":1,"onlineSummary":false}');
  assert.equal(getStatus(filename).projectMemory, null);
  for (const bytes of ['{"version":1,"projectMemory":"true"}', '{"version":1,"projectMemory":1}', '{"version":1,"projectMemory":null}', '{"version":2,"projectMemory":true}', "{broken"]) {
    fs.writeFileSync(filename, bytes);
    assert.equal(getStatus(filename).projectMemory, false);
  }
});

test("a custom summary prompt persists, is validated, and resetting or saving the default removes it", async (t) => {
  const { filename } = featureFixture(t);
  const defaultPrompt = "Built-in prompt.\nReply with JSON only.";
  const settings = createSummarySettings({ configFile: filename, getDefaultModel: async () => null, listModels: async () => [], defaultPrompt });
  const initial = await settings.getStatus();
  assert.deepEqual({ prompt: initial.prompt, customPrompt: initial.customPrompt }, { prompt: defaultPrompt, customPrompt: false });
  const custom = "自定义提示词。\nReply with JSON only.";
  const saved = await settings.configure({ summaryPrompt: custom });
  assert.deepEqual({ prompt: saved.prompt, customPrompt: saved.customPrompt }, { prompt: custom, customPrompt: true });
  assert.equal(getStatus(filename).summaryPrompt, custom);
  for (const invalid of ["", "  \n ", "x".repeat(8 * 1024 + 1), "汉".repeat(2731), '"'.repeat(4096), "\u0001".repeat(1366)]) {
    await assert.rejects(settings.configure({ summaryPrompt: invalid }), { code: "INVALID_SUMMARY_PROMPT" });
    assert.throws(() => setFeatures({ summaryPrompt: invalid }, filename));
  }
  assert.equal(getStatus(filename).summaryPrompt, custom);
  await settings.configure({ summaryPrompt: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { version: 1 });
  assert.equal((await settings.getStatus()).prompt, defaultPrompt);
  await settings.configure({ summaryPrompt: custom });
  await settings.configure({ summaryPrompt: `\n${defaultPrompt}  ` });
  assert.equal(getStatus(filename).summaryPrompt, null);
  assert.equal((await settings.getStatus()).customPrompt, false);
  // 手工写入的空白或超长提示词被忽略，回到默认值。
  for (const summaryPrompt of [" ", "x".repeat(8 * 1024 + 1), 42]) {
    fs.writeFileSync(filename, JSON.stringify({ version: 1, summaryPrompt }));
    assert.equal(getStatus(filename).summaryPrompt, null);
  }
});

test("configuration events report the enabled state, summary model and prompt choice", async (t) => {
  const { root, archiveRoot } = fixture(t);
  const events = [];
  const configFile = path.join(root, "gateway-features.json");
  const pack = createOnlineSummary({ configFile, archiveRoot, onEvent: (event) => events.push(event) });
  pack.getStatus();
  pack.getStatus();
  setFeatures({ summaryModel: "claude-haiku-5.5" }, configFile);
  pack.getStatus();
  setFeatures({ summaryPrompt: "private custom prompt" }, configFile);
  pack.getStatus();
  assert.deepEqual(events, [{ event: "configuration", enabled: true, summary_model: "auto", summary_threshold: 8192, summary_prompt: "default", archive_retention_days: 30 },
    { event: "configuration", enabled: true, summary_model: "claude-haiku-5.5", summary_threshold: 8192, summary_prompt: "default", archive_retention_days: 30 },
    { event: "configuration", enabled: true, summary_model: "claude-haiku-5.5", summary_threshold: 8192, summary_prompt: "custom", archive_retention_days: 30 }]);
});

test("the configured threshold decides which outputs are summarized and weak compression keeps the original", async (t) => {
  const { pack, root, model, warnings } = fixture(t);
  const medium = "BEGIN\n" + "exact archived line\n".repeat(400) + "END\n";
  const base = initial();
  await pack.prepare(base);
  const atDefault = await pack.prepare(addResult(base, "medium_default", medium));
  assert.equal(atDefault.stats.summarized_results, 0);
  assert.equal(model.calls, 0);
  fs.writeFileSync(path.join(root, "gateway-features.json"), JSON.stringify({ version: 1, onlineSummary: true, summaryThreshold: 4096 }));
  const lowered = await pack.prepare(addResult(base, "medium_lowered", medium));
  assert.equal(lowered.stats.summarized_results, 1);
  assert.ok(lastText(lowered.body).startsWith("[Gateway online summary"));
  const short = "line\n".repeat(1000);
  model.summaryText = "s".repeat(3600);
  const weak = await pack.prepare(addResult(base, "weak", short));
  assert.equal(model.calls, 2);
  assert.equal(weak.stats.summarized_results, 0);
  assert.equal(lastText(weak.body), short);
  assert.deepEqual(warnings, []);
});

test("cleanup deletes only expired session archives this module wrote and honors the configured retention", async (t) => {
  const { root, archiveRoot, pack } = fixture(t);
  const configFile = path.join(root, "gateway-features.json");
  const day = 24 * 60 * 60 * 1000;
  const age = (target, days) => { const time = new Date(Date.now() - days * day); fs.utimesSync(target, time, time); };
  const ageSession = (directory, days) => { for (const name of fs.readdirSync(directory)) age(path.join(directory, name), days); age(directory, days); };
  const base = initial("expiring-session");
  await pack.prepare(base);
  assert.match(lastText((await pack.prepare(addResult(base, "one"))).body), /Gateway online summary/);
  const [expired] = fs.readdirSync(archiveRoot).map((name) => path.join(archiveRoot, name));
  assert.equal(fs.readdirSync(expired).length, 2);

  const session = (name, files, days) => {
    const directory = path.join(archiveRoot, name);
    fs.mkdirSync(directory);
    for (const file of files) fs.writeFileSync(path.join(directory, file), "{}");
    ageSession(directory, days);
    return directory;
  };
  const recent = session("a".repeat(64), ["state.json"], 1);
  const activeLedger = session("b".repeat(64), ["state.json"], 40);
  age(path.join(activeLedger, "state.json"), 1);
  const unexpected = session("c".repeat(64), ["state.json", "notes.md"], 40);
  const unnamed = session("keep-me", ["state.json"], 40);
  fs.writeFileSync(path.join(archiveRoot, "e".repeat(64)), "not a directory");
  ageSession(expired, 31);

  assert.equal(pack.cleanup(), 1);
  assert.equal(fs.existsSync(expired), false);
  for (const directory of [recent, activeLedger, unnamed]) assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  assert.deepEqual(fs.readdirSync(unexpected).sort(), ["notes.md", "state.json"]);
  assert.ok(fs.statSync(path.join(archiveRoot, "e".repeat(64))).isFile());
  // A resumed session without its archive falls back to the original output.
  assert.equal(lastText((await pack.prepare(addResult(base, "one"))).body), large);

  setFeatures({ archiveRetentionDays: 0 }, configFile);
  ageSession(recent, 1000);
  assert.equal(pack.cleanup(), 0);
  setFeatures({ archiveRetentionDays: 7 }, configFile);
  ageSession(recent, 8);
  assert.equal(pack.cleanup(), 1);
  assert.equal(fs.existsSync(recent), false);
  assert.throws(() => setFeatures({ archiveRetentionDays: 5 }, configFile));
  const settings = createSummarySettings({ configFile, getDefaultModel: async () => null, listModels: async () => [] });
  await assert.rejects(settings.configure({ archiveRetentionDays: 365 }), { code: "INVALID_RETENTION_DAYS" });
  assert.equal((await settings.configure({ archiveRetentionDays: 60 })).retentionDays, 60);

  fs.writeFileSync(configFile, "{broken");
  ageSession(activeLedger, 1000);
  assert.equal(pack.cleanup(), 0);
  assert.equal(fs.existsSync(activeLedger), true);
});

test("cleanup never follows symlinked archive roots or session directories", { skip: process.platform === "win32" }, async (t) => {
  const { root, archiveRoot, pack } = fixture(t);
  const external = path.join(root, "external");
  const old = new Date(Date.now() - 1000 * 24 * 60 * 60 * 1000);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "state.json"), "{}");
  fs.utimesSync(path.join(external, "state.json"), old, old);
  fs.utimesSync(external, old, old);
  fs.mkdirSync(archiveRoot);
  fs.symlinkSync(external, path.join(archiveRoot, "d".repeat(64)));
  assert.equal(pack.cleanup(), 0);
  assert.deepEqual(fs.readdirSync(external), ["state.json"]);
  const linkedRoot = path.join(root, "linked-root");
  fs.mkdirSync(path.join(external, "f".repeat(64)));
  fs.utimesSync(path.join(external, "f".repeat(64)), old, old);
  fs.symlinkSync(external, linkedRoot);
  const linked = createOnlineSummary({ configFile: path.join(root, "gateway-features.json"), archiveRoot: linkedRoot });
  assert.equal(linked.cleanup(), 0);
  assert.equal(fs.existsSync(path.join(external, "f".repeat(64))), true);
});

test("cleanup keeps sessions that are still used, ignores invalid retention values and unsafe roots", { skip: process.platform === "win32" }, async (t) => {
  const { root, archiveRoot, pack } = fixture(t);
  const configFile = path.join(root, "gateway-features.json");
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  const base = addResult(initial("active-session"), "one");
  await pack.prepare(initial("active-session"));
  await pack.prepare(base);
  const [directory] = fs.readdirSync(archiveRoot).map((name) => path.join(archiveRoot, name));
  const ageAll = () => { for (const name of fs.readdirSync(directory)) fs.utimesSync(path.join(directory, name), old, old); fs.utimesSync(directory, old, old); };
  ageAll();
  // A request without new tool results still marks the session as used.
  await pack.prepare(base);
  assert.equal(pack.cleanup(), 0);
  ageAll();
  await pack.prepare(base, { readOnly: true });
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, archiveRetentionDays: 5 }));
  assert.equal(getStatus(configFile).archiveRetentionDays, 0);
  assert.equal(pack.cleanup(), 0);
  fs.writeFileSync(configFile, JSON.stringify({ version: 1 }));
  fs.chmodSync(archiveRoot, 0o770);
  assert.equal(pack.cleanup(), 0);
  fs.chmodSync(archiveRoot, 0o700);
  assert.equal(pack.cleanup(), 1);
});

test("claudeLauncher is tri-state, preserves other fields, and is off for malformed configuration", (t) => {
  const { filename } = featureFixture(t);
  assert.equal(getStatus(filename).claudeLauncher, null);
  assert.throws(() => setFeatures({ claudeLauncher: "true" }, filename));
  assert.equal(fs.existsSync(filename), false);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, '{"version":1,"onlineSummary":false,"projectMemory":true}');
  assert.equal(getStatus(filename).claudeLauncher, null);
  setFeatures({ claudeLauncher: true }, filename);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { version: 1, onlineSummary: false, projectMemory: true, claudeLauncher: true });
  assert.equal(getStatus(filename).claudeLauncher, true);
  setFeatures({ claudeLauncher: false }, filename);
  assert.equal(getStatus(filename).claudeLauncher, false);
  for (const bytes of ['{"version":1,"claudeLauncher":"true"}', '{"version":1,"claudeLauncher":1}', '{"version":1,"claudeLauncher":null}', '{"version":2,"claudeLauncher":true}', "{broken"]) {
    fs.writeFileSync(filename, bytes);
    assert.equal(getStatus(filename).claudeLauncher, false);
  }
});

test("claudeLauncher is off for a real symlinked feature file", { skip: process.platform === "win32" }, (t) => {
  const { filename } = featureFixture(t);
  fs.mkdirSync(path.dirname(filename));
  const real = path.join(path.dirname(filename), "real.json");
  const original = Buffer.from('{"version":1,"claudeLauncher":true}');
  fs.writeFileSync(real, original);
  fs.symlinkSync(real, filename);
  assert.equal(getStatus(filename).claudeLauncher, false);
  assert.throws(() => setFeatures({ claudeLauncher: false }, filename), /Unsafe feature configuration file/);
  assert.deepEqual(fs.readFileSync(real), original);
});

for (const operation of ["getStatus", "setFeatures"]) {
  test(`${operation} rejects a target reporting both file and symlink without opening, reading or writing`, (t) => {
    const { filename } = featureFixture(t);
    setFeatures({ onlineSummary: true, projectMemory: true, claudeLauncher: true }, filename);
    const original = fs.readFileSync(filename);
    const calls = [];
    const fsImpl = new Proxy(fs, { get(target, name) {
      if (name === "lstatSync") return (file, ...args) => {
        const stat = target.lstatSync(file, ...args);
        return file === filename ? Object.create(stat, {
          isFile: { value: () => true }, isSymbolicLink: { value: () => true }
        }) : stat;
      };
      if (/^(open|read|write)/.test(String(name)) && typeof target[name] === "function") return (...args) => {
        calls.push(name);
        return target[name](...args);
      };
      return target[name];
    } });
    const stat = fsImpl.lstatSync(filename);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), true);
    if (operation === "getStatus") {
      assert.deepEqual(getStatus(filename, fsImpl), { onlineSummary: false, summaryModel: null, summaryThreshold: 8192,
        summaryPrompt: null, archiveRetentionDays: 0, projectMemory: false, claudeLauncher: false });
    } else {
      assert.throws(() => setFeatures({ claudeLauncher: false }, filename, fsImpl), /Unsafe feature configuration file/);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readFileSync(filename), original);
  });
}

for (const existing of [false, true]) {
  test(`Windows junction config parent rejects reads and writes with ${existing ? "existing" : "missing"} feature file`, {
    skip: process.platform !== "win32"
  }, (t) => {
    const { home, filename } = featureFixture(t);
    const outside = path.join(home, "outside-directory");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "must remain unchanged\n");
    if (existing) fs.writeFileSync(path.join(outside, path.basename(filename)), '{"version":1,"claudeLauncher":true}');
    const names = fs.readdirSync(outside).sort();
    const bytes = names.map((name) => fs.readFileSync(path.join(outside, name)));
    fs.symlinkSync(outside, path.dirname(filename), "junction");
    assert.equal(fs.lstatSync(path.dirname(filename)).isSymbolicLink(), true);
    const status = getStatus(filename);
    assert.equal(status.onlineSummary, false);
    assert.equal(status.projectMemory, false);
    assert.equal(status.claudeLauncher, false);
    assert.throws(() => setFeatures({ claudeLauncher: false }, filename), /Unsafe feature configuration directory/);
    assert.deepEqual(fs.readdirSync(outside).sort(), names);
    assert.deepEqual(names.map((name) => fs.readFileSync(path.join(outside, name))), bytes);
  });
}

test("getStatus and setFeatures use an injected fs and reject other-owned files or parents", (t) => {
  const { filename } = featureFixture(t);
  setFeatures({ claudeLauncher: true }, filename);
  const calls = [];
  const spy = new Proxy(fs, { get: (target, key) => typeof target[key] === "function"
    ? (...args) => { calls.push(key); return target[key](...args); } : target[key] });
  assert.equal(getStatus(filename, spy).claudeLauncher, true);
  assert.ok(calls.includes("lstatSync") && calls.includes("openSync"));
  calls.length = 0;
  setFeatures({ claudeLauncher: false }, filename, spy);
  assert.ok(calls.includes("writeFileSync") && calls.includes("renameSync"));
  assert.equal(getStatus(filename).claudeLauncher, false);
  if (!process.getuid) return;
  const foreign = (match) => ({ ...fs, lstatSync: (file, ...rest) => {
    const stat = fs.lstatSync(file, ...rest);
    return match(file) ? Object.create(stat, { uid: { value: process.getuid() + 1 } }) : stat;
  } });
  for (const match of [(file) => file === filename, (file) => file === path.dirname(filename)]) {
    const status = getStatus(filename, foreign(match));
    assert.equal(status.claudeLauncher, false);
    assert.equal(status.onlineSummary, false);
    assert.equal(status.projectMemory, false);
  }
});

test("setFeatures leaves the file untouched when the resulting bytes are identical", (t) => {
  const { filename } = featureFixture(t);
  setFeatures({ claudeLauncher: true }, filename);
  const before = fs.statSync(filename);
  const writes = [];
  const spy = { ...fs, writeFileSync: (...args) => { writes.push(args[0]); return fs.writeFileSync(...args); } };
  setFeatures({ claudeLauncher: true }, filename, spy);
  assert.deepEqual(writes, []);
  assert.equal(fs.statSync(filename).ino, before.ino);
});
