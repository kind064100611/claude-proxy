const test = require("node:test");
const assert = require("node:assert/strict");
const { createProjectMemoryGateway, TOOL_NAME, QUEUED } = require("../lib/project-memory-gateway");

const tools = [{ name: "Read", input_schema: { type: "object" } }, { name: "Edit", input_schema: { type: "object" } }];
const call = (id, input = { root: "/repo", changed_paths: ["src/a.js"] }) => ({ type: "tool_use", id, name: TOOL_NAME, input });
const error = (id) => ({ type: "tool_result", tool_use_id: id, content: "<tool_use_error>Error: No such tool available: ProjectMemoryUpdate</tool_use_error>", is_error: true });
function conversation(last = [{ type: "text", text: "Done." }, call("toolu_new")], reply = [error("toolu_new")]) {
  return { model: "claude-opus-5.5", system: [{ type: "text", text: "You are Claude Code." }], tools, messages: [
    { role: "user", content: "change it" },
    { role: "assistant", content: [{ type: "text", text: "Earlier." }, call("toolu_old")] },
    { role: "user", content: [error("toolu_old")] },
    { role: "assistant", content: last },
    { role: "user", content: reply }
  ] };
}

test("injection needs the flag and an Edit or Write tool, and appends one constant tool and system block last", () => {
  const gateway = createProjectMemoryGateway();
  const plain = { tools, system: "You are Claude Code.", messages: [{ role: "user", content: "hi" }] };
  assert.equal(gateway.prepare(plain, { enabled: false }).body, plain);
  const readOnlyTools = { ...plain, tools: [tools[0]] };
  assert.equal(gateway.prepare(readOnlyTools, { enabled: true }).body, readOnlyTools);
  assert.equal(gateway.prepare({ messages: [] }, { enabled: true }).body.tools, undefined);
  const injected = gateway.prepare(plain, { enabled: true }).body;
  assert.deepEqual(injected.tools.map((tool) => tool.name), ["Read", "Edit", TOOL_NAME]);
  assert.deepEqual(injected.system.map((block) => block.type), ["text", "text"]);
  assert.equal(injected.system[0].text, "You are Claude Code.");
  assert.match(injected.system[1].text, /exactly one ProjectMemoryUpdate call as the last block/);
  assert.match(injected.system[1].text, /during read-only analysis, or found records wrong or useless,/);
  assert.match(injected.system[1].text, /pass an empty changed_paths array/);
  assert.match(injected.system[1].text, /when there are no source\/test changes, new verified reusable knowledge or wrong records to report/);
  assert.match(injected.tools.at(-1).input_schema.properties.changed_paths.description, /Use an empty array for read-only analysis/);
  assert.equal(plain.tools.length, 2);
  assert.equal(typeof plain.system, "string");
  for (const system of [undefined, ""]) assert.equal(gateway.prepare({ ...plain, system }, { enabled: true }).body.system.length, 1);
  const write = gateway.prepare({ ...plain, tools: [{ name: "Write" }] }, { enabled: true }).body;
  assert.equal(write.tools.at(-1).name, TOOL_NAME);
  assert.equal(gateway.prepare(write, { enabled: true }).body.tools.filter((tool) => tool.name === TOOL_NAME).length, 1);
});

test("injected tool and system text are byte-identical across requests and never shared", () => {
  const gateway = createProjectMemoryGateway();
  const first = gateway.prepare(conversation(), { enabled: true, readOnly: true }).body;
  first.tools.at(-1).cache_control = { type: "ephemeral" };
  first.system.at(-1).cache_control = { type: "ephemeral" };
  const second = gateway.prepare({ tools: [{ name: "Write" }], system: [{ type: "text", text: "other" }], messages: [] }, { enabled: true }).body;
  const strip = ({ cache_control, ...value }) => value;
  assert.equal(JSON.stringify(second.tools.at(-1)), JSON.stringify(strip(first.tools.at(-1))));
  assert.equal(JSON.stringify(second.system.at(-1)), JSON.stringify(strip(first.system.at(-1))));
  assert.equal(second.tools.at(-1).cache_control, undefined);
  assert.deepEqual(second.tools.at(-1).input_schema.required, ["root", "changed_paths"]);
  assert.equal(second.tools.at(-1).input_schema.properties.learned.maxItems, 3);
});

test("every result for our tool becomes Queued. while other results and the input stay untouched", () => {
  const gateway = createProjectMemoryGateway();
  const body = conversation();
  body.messages[4].content = [{ ...error("toolu_new"), cache_control: { type: "ephemeral" } }];
  body.messages[2].content.push({ type: "tool_result", tool_use_id: "toolu_bash", content: "real output", is_error: true });
  const original = JSON.stringify(body);
  for (const enabled of [true, false]) {
    const { messages } = gateway.prepare(body, { enabled, readOnly: true }).body;
    assert.deepEqual(messages[2].content[0], { type: "tool_result", tool_use_id: "toolu_old", content: QUEUED, is_error: false });
    assert.deepEqual(messages[2].content[1], body.messages[2].content[1]);
    assert.deepEqual(messages[4].content[0], { type: "tool_result", tool_use_id: "toolu_new", content: QUEUED, is_error: false, cache_control: { type: "ephemeral" } });
    assert.equal(messages[0], body.messages[0]);
  }
  assert.equal(JSON.stringify(body), original);
});

test("only a call in the last assistant message answered by the last user message triggers, once", () => {
  const gateway = createProjectMemoryGateway();
  assert.deepEqual(gateway.prepare(conversation(), { enabled: true, readOnly: true }).triggers, []);
  assert.deepEqual(gateway.prepare(conversation(), { enabled: false }).triggers, []);
  const first = gateway.prepare(conversation(), { enabled: true });
  assert.deepEqual(first.triggers, [{ root: "/repo", changed_paths: ["src/a.js"] }]);
  assert.deepEqual(gateway.prepare(conversation(), { enabled: true }).triggers, []);
  const resumed = conversation([{ type: "text", text: "Done." }, call("toolu_next")], [{ type: "text", text: "next question" }]);
  assert.deepEqual(createProjectMemoryGateway().prepare(resumed, { enabled: true }).triggers, []);
  const history = conversation();
  history.messages.push({ role: "assistant", content: [{ type: "text", text: "Anything else?" }] }, { role: "user", content: "no" });
  assert.deepEqual(createProjectMemoryGateway().prepare(history, { enabled: true }).triggers, []);
  assert.deepEqual(createProjectMemoryGateway().prepare(conversation([{ type: "text", text: "x" }, { ...call("toolu_bad"), input: "text" }], [error("toolu_bad")]), { enabled: true }).triggers, [{}]);
  // 排队的子代理回报或任务通知作为单独的 user 消息跟在工具结果之后，仍然触发，但不在本地结束这一轮。
  const queued = conversation();
  queued.messages.push({ role: "user", content: [{ type: "text", text: "<task-notification>done</task-notification>" }] }, { role: "user", content: "queued text" });
  const queuedResult = createProjectMemoryGateway().prepare(queued, { enabled: true });
  assert.deepEqual(queuedResult.triggers, [{ root: "/repo", changed_paths: ["src/a.js"] }]);
  assert.equal(queuedResult.reply, null);
  assert.deepEqual(createProjectMemoryGateway().prepare({ messages: [{ role: "user", content: [error("toolu_new")] }] }, { enabled: true }).triggers, []);
});

test("response messages consume memory calls before the client can dispatch them", () => {
  const gateway = createProjectMemoryGateway();
  const enqueued = [];
  const handler = gateway.createResponseHandler({ enqueue: (input) => { enqueued.push(input); return true; } });
  const answer = { type: "text", text: "Done." };
  const usage = { input_tokens: 100, output_tokens: 20 };
  const original = { type: "message", id: "msg_1", content: [answer, call("toolu_response")], stop_reason: "tool_use", usage };
  const result = handler.message(original);
  assert.equal(result.stop_reason, "end_turn");
  assert.deepEqual(result.content, [answer, { type: "text", text: "\n\nQueued." }]);
  assert.equal(result.usage, usage);
  assert.equal(original.content[1].type, "tool_use");
  handler.message(original);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(gateway.prepare(conversation([answer, call("toolu_response")], [error("toolu_response")]), { enabled: true }).triggers, []);
  const other = { type: "tool_use", id: "toolu_read", name: "Read", input: {} };
  assert.equal(handler.message({ ...original, content: [other, call("toolu_second")] }).stop_reason, "tool_use");
  const plain = { ...original, content: [answer, other] };
  assert.equal(handler.message(plain), plain);
});

const memoryEvents = (id, json = JSON.stringify(call(id).input), stop = "tool_use") => [
  { type: "content_block_start", index: 1, content_block: { ...call(id), input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(0, 9) } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json.slice(9) } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 40 } },
  { type: "message_stop" }
];

test("streamed memory input stays hidden until the complete response is accepted", () => {
  const enqueued = [];
  const handler = createProjectMemoryGateway().createResponseHandler({ enqueue: (input) => { enqueued.push(input); return true; } });
  const events = memoryEvents("toolu_stream");
  for (const value of events.slice(0, 4)) assert.deepEqual(handler.event(value), []);
  assert.equal(enqueued.length, 0);
  const usageOnly = { type: "message_delta", delta: {}, usage: { output_tokens: 30 } };
  assert.deepEqual(handler.event(usageOnly), []);
  assert.equal(enqueued.length, 0);
  const result = handler.event(events[4]).filter((event) => event !== usageOnly);
  assert.deepEqual(result.map((event) => event.type), ["content_block_start", "content_block_delta", "content_block_stop", "message_delta"]);
  assert.equal(result[0].content_block.type, "text");
  assert.equal(result[1].delta.text, "\n\nQueued.");
  assert.equal(result[3].delta.stop_reason, "end_turn");
  assert.equal(result[3].usage, events[4].usage);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(handler.event(events[5]), [events[5]]);
});

test("memory filtering preserves real tools before and after the virtual call", () => {
  for (const before of [true, false]) {
    const handler = createProjectMemoryGateway().createResponseHandler({ enqueue: () => true });
    const events = memoryEvents("toolu_mixed");
    const other = { type: "content_block_start", index: before ? 0 : 2,
      content_block: { type: "tool_use", id: "toolu_read", name: "Read", input: {} } };
    const input = before ? [other, ...events] : [...events.slice(0, 4), other, ...events.slice(4)];
    const result = input.flatMap((value) => handler.event(value));
    assert.ok(result.includes(other));
    assert.equal(result.find((value) => value.type === "message_delta").delta.stop_reason, "tool_use");
  }
});

test("invalid, truncated, failed and refused memory calls never claim queue success", () => {
  for (const [json, stop] of [["{", "tool_use"], ["null", "tool_use"], ["{}", "tool_use"], [JSON.stringify(call("x").input), "max_tokens"],
    [JSON.stringify(call("x").input), "refusal"]]) {
    let queued = 0;
    const handler = createProjectMemoryGateway().createResponseHandler({ enqueue: () => { queued++; return true; } });
    const result = memoryEvents("toolu_invalid", json, stop).flatMap((value) => handler.event(value));
    assert.equal(queued, 0);
    assert.match(result.find((value) => value.delta?.type === "text_delta").delta.text, /not queued/);
    assert.ok(!result.some((value) => value.content_block?.type === "tool_use"));
  }
  for (const enqueue of [() => false, () => { throw new Error("unavailable"); }]) {
    const handler = createProjectMemoryGateway().createResponseHandler({ enqueue });
    assert.match(handler.message({ type: "message", content: [call("toolu_rejected")], stop_reason: "tool_use" }).content[0].text, /not queued/);
  }
  let queued = 0;
  const handler = createProjectMemoryGateway().createResponseHandler({ enqueue: () => { queued++; return true; } });
  for (const value of memoryEvents("toolu_incomplete").slice(0, 3)) handler.event(value);
  assert.match(handler.finish()[1].delta.text, /not queued/);
  assert.equal(queued, 0);
});

test("a local reply repeating the answer only for a written answer followed by our single call and its bare result", () => {
  const prepare = (last, reply, options = { enabled: true }) => createProjectMemoryGateway().prepare(conversation(last, reply), options);
  const answer = { type: "text", text: "Done." };
  assert.equal(prepare([answer, call("toolu_new")]).reply, "Done.");
  assert.equal(prepare([{ type: "thinking", thinking: "t", signature: "s" }, answer, call("toolu_new")]).reply, "Done.");
  assert.equal(prepare([{ type: "text", text: "Part one." }, { type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "Part two.\n" }, call("toolu_new")]).reply,
    "Part one.\n\nPart two.\n");
  const bash = { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } };
  const extra = prepare([answer, call("toolu_new"), bash], [error("toolu_new"), { type: "tool_result", tool_use_id: "toolu_bash", content: "out" }]);
  assert.equal(extra.reply, null);
  assert.equal(extra.triggers.length, 1);
  assert.equal(prepare([call("toolu_new")]).reply, null);
  assert.equal(prepare([{ type: "text", text: "  \n" }, call("toolu_new")]).reply, null);
  assert.equal(prepare([answer, call("toolu_new")], [error("toolu_new"), { type: "text", text: "<system-reminder>x</system-reminder>" }]).reply, null);
  assert.equal(prepare([answer, call("toolu_new")], [error("toolu_new")], { enabled: true, readOnly: true }).reply, null);
  assert.equal(prepare([answer, call("toolu_new")], [error("toolu_new")], { enabled: false }).reply, null);
  assert.equal(prepare([answer, call("toolu_new"), call("toolu_two")], [error("toolu_new"), error("toolu_two")]).reply, null);
});
