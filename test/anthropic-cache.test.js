const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const { prepareClaudeCache, createClaudeCacheObserver } = require("../lib/anthropic-cache");

const body = () => ({ model: "claude-sonnet-5.5", system: "private-system", tools: [{ name: "read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "private-user" }] });

test("Claude fills Pi-style tool, system and last-user breakpoints without mutating input", () => {
  const original = body();
  const payload = prepareClaudeCache(original);
  for (const block of [payload.tools[0], payload.system[0], payload.messages[0].content[0]]) assert.deepEqual(block.cache_control, { type: "ephemeral" });
  assert.equal(original.system, "private-system");
  assert.equal(original.tools[0].cache_control, undefined);
  assert.deepEqual(prepareClaudeCache(payload), payload);
});

test("Claude preserves existing TTLs and nested markers without exceeding four points", () => {
  const original = body();
  original.system = [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }];
  original.messages = [{ role: "user", content: [{ type: "tool_result", content: [
    { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "5m" } }
  ] }] }];
  const payload = prepareClaudeCache(original);
  assert.equal(payload.tools[0].cache_control, undefined);
  assert.equal(payload.messages[0].content[0].cache_control, undefined);
  assert.deepEqual(payload, original);
  original.messages[0].content[0].content.pop();
  const filled = prepareClaudeCache(original);
  assert.deepEqual(filled.tools[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(filled.messages[0].content[0].cache_control, undefined);
});

test("Claude breakpoint TTL follows native tools-system-history ordering", () => {
  const original = body();
  original.system = [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }];
  original.messages[0].content = [{ type: "text", text: "earlier", cache_control: { type: "ephemeral", ttl: "5m" } }, { type: "text", text: "later" }];
  const payload = prepareClaudeCache(original);
  assert.equal(payload.tools[0].cache_control.ttl, "1h");
  assert.equal(payload.messages[0].content.at(-1).cache_control.ttl, undefined);
});

test("Claude automatic request caching and explicit disables are respected", () => {
  const original = { ...body(), cache_control: { type: "ephemeral" } };
  assert.equal(prepareClaudeCache(original), original);
  const old = process.env.CLAUDE_PROMPT_CACHE;
  process.env.CLAUDE_PROMPT_CACHE = "0";
  try { assert.equal(prepareClaudeCache(original), original); assert.equal(prepareClaudeCache(body()).system, "private-system"); }
  finally { if (old === undefined) delete process.env.CLAUDE_PROMPT_CACHE; else process.env.CLAUDE_PROMPT_CACHE = old; }
});

async function observe(raw, stream, callback) {
  const observer = createClaudeCacheObserver(prepareClaudeCache(body()), stream, callback);
  const chunks = [];
  observer.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { observer.on("end", resolve); observer.on("error", reject); });
  Readable.from([Buffer.from(raw.slice(0, 17)), Buffer.from(raw.slice(17))]).pipe(observer);
  await done;
  return Buffer.concat(chunks).toString();
}

test("Claude SSE observer forwards exact bytes and reports merged native cache counters once", async () => {
  const raw = 'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":600,"cache_creation_input_tokens":300}}}\r\n\r\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"private-answer"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n';
  const stats = [];
  assert.equal(await observe(raw, true, (usage) => stats.push(usage)), raw);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].total_input_tokens, 1000);
  assert.equal(stats[0].cache_read_input_tokens, 600);
  assert.equal(stats[0].cache_creation_input_tokens, 300);
  assert.equal(stats[0].cache_hit_percent, 60);
  assert.equal(stats[0].uncached_input_tokens, 400);
  assert.equal(stats[0].regular_input_tokens, 100);
  assert.equal(stats[0].cache_breakpoints, 3);
  assert.ok(!JSON.stringify(stats).includes("private-"));
});

test("Claude JSON observer preserves bytes and malformed/oversized output never interrupts delivery", async () => {
  const raw = '{"type":"message","content":[],"usage":{"input_tokens":0,"cache_read_input_tokens":0}}';
  const stats = [];
  assert.equal(await observe(raw, false, (usage) => stats.push(usage)), raw);
  assert.equal(stats[0].cache_hit_percent, 0);
  assert.equal(await observe("invalid-json", false, () => { throw Error("should not report"); }), "invalid-json");
  const large = "x".repeat(1024 * 1024 + 1);
  assert.equal(await observe(large, false, () => { throw Error("should not report"); }), large);
  assert.equal(await observe(raw, false, () => { throw Error("diagnostic failure"); }), raw);
});
