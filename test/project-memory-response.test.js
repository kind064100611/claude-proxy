const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("stream");
const { pipeline } = require("stream/promises");
const { createProjectMemoryGateway, TOOL_NAME } = require("../lib/project-memory-gateway");
const { createProjectMemoryResponseTransform } = require("../lib/project-memory-response");

async function transform(chunks, isStream, enqueue = () => true) {
  const handler = createProjectMemoryGateway().createResponseHandler({ enqueue });
  const output = [];
  await pipeline(Readable.from(chunks), createProjectMemoryResponseTransform(handler, isStream),
    new Writable({ write(chunk, _, callback) { output.push(chunk); callback(); } }));
  return Buffer.concat(output).toString("utf8");
}

const call = { type: "tool_use", id: "toolu_memory", name: TOOL_NAME, input: { root: "/repo", changed_paths: [], learned: [] } };
const frame = (value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

test("native JSON responses replace only memory calls and preserve errors verbatim", async () => {
  let queued = 0;
  const message = { type: "message", content: [{ type: "text", text: "完成。" }, call], stop_reason: "tool_use", usage: { output_tokens: 12 } };
  const output = JSON.parse(await transform([Buffer.from(JSON.stringify(message))], false, () => { queued++; return true; }));
  assert.deepEqual(output.content, [message.content[0], { type: "text", text: "\n\nQueued." }]);
  assert.equal(output.stop_reason, "end_turn");
  assert.deepEqual(output.usage, message.usage);
  assert.equal(queued, 1);
  for (const raw of ['{ "type": "error", "error": { "message": "rejected" } }', ' { "type": "message", "content": [] } ']) {
    assert.equal(await transform([Buffer.from(raw)], false), raw);
  }
});

test("native SSE handles split UTF-8, split JSON arguments and CRLF without leaking a tool call", async () => {
  const json = JSON.stringify({ ...call.input, root: "/repo/项目" });
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", content: [], usage: { input_tokens: 80 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "已完成。" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { ...call, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 15) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(15) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 25 } },
    { type: "message_stop" }
  ];
  const raw = ": keepalive\r\n\r\n" + events.map(frame).join("").replace(/\n/g, "\r\n");
  const bytes = Buffer.from(raw);
  const queued = [];
  const output = await transform(Array.from(bytes, (value) => Buffer.from([value])), true, (input) => { queued.push(input); return true; });
  assert.ok(output.startsWith(": keepalive\r\n\r\n" + events.slice(0, 4).map(frame).join("").replace(/\n/g, "\r\n")));
  assert.ok(!output.includes(TOOL_NAME));
  assert.ok(!output.includes("input_json_delta"));
  assert.ok(output.includes("Queued."));
  assert.equal(queued[0].root, "/repo/项目");
  const decoded = output.split(/\r?\n\r?\n/).filter((value) => value.startsWith("event:"))
    .map((value) => JSON.parse(value.split(/\r?\ndata: /)[1]));
  assert.equal(decoded.find((value) => value.type === "message_delta").delta.stop_reason, "end_turn");
  assert.equal(decoded.at(-1).type, "message_stop");
});

test("ordinary SSE, signatures and comments are forwarded without byte changes", async () => {
  const raw = ": ping\n\n" + frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } }) +
    frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read", id: "read_1", input: {} } });
  assert.equal(await transform([Buffer.from(raw)], true), raw);
});

test("an incomplete memory frame is rejected without enqueuing or leaking its tool name", async () => {
  let queued = 0;
  await assert.rejects(transform([Buffer.from(frame({ type: "content_block_start", index: 0, content_block: call }) +
    'event: content_block_delta\ndata: {"type":')], true, () => { queued++; return true; }), /Incomplete/);
  assert.equal(queued, 0);
});
