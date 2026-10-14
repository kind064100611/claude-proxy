const test = require("node:test");
const assert = require("node:assert/strict");
const { toResponsesBody, fromResponses } = require("../lib/openai-responses");
const { rememberReplay } = require("../lib/responses-replay");

const auth = { kind: "codex", accountId: "replay-account", token: "test-token" };
const response = {
  status: "completed", output: [
    { type: "reasoning", id: "rs_test", encrypted_content: "opaque-not-plaintext", summary: [] },
    { type: "function_call", id: "fc_original", call_id: "call_original", name: "read", arguments: '{ "path": "file", "n": 1 }', status: "completed" }
  ], usage: { input_tokens: 2000, output_tokens: 3 }
};
const request = (session) => ({ model: "gpt-6-sol", prompt_cache_key: session,
  messages: [{ role: "system", content: "instructions" }, { role: "user", content: "read file" }] });
const continuation = (body) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: null, tool_calls: [{ id: "call_original", function: { name: "read", arguments: '{"n":1,"path":"file"}' } }] },
  { role: "tool", tool_call_id: "call_original", content: "result" }] });

test("tool round trip preserves exact native IDs, argument bytes and encrypted reasoning", () => {
  const body = request("replay-tools");
  rememberReplay(body, auth, response, fromResponses(response, body.model));
  const next = continuation(body);
  const payload = toResponsesBody(next, auth);
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(payload.input.slice(1, 3), response.output);
  assert.deepEqual(payload.input[3], { type: "function_call_output", call_id: "call_original", output: "result" });
  assert.equal(next.messages[2].tool_calls[0].function.arguments, '{"n":1,"path":"file"}');
  // Consumers cannot mutate the stored native turn.
  payload.input[1].encrypted_content = "changed";
  assert.equal(toResponsesBody(next, auth).input[1].encrypted_content, "opaque-not-plaintext");
});

test("replay is isolated by model, account, session and complete preceding history", () => {
  const body = request("replay-isolation");
  rememberReplay(body, auth, response, fromResponses(response, body.model));
  for (const [next, credentials] of [
    [{ ...continuation(body), model: "gpt-5.6-sol" }, auth],
    [continuation(body), { ...auth, accountId: "another-account" }],
    [{ ...continuation(body), prompt_cache_key: "another-session" }, auth],
    [continuation({ ...body, messages: [{ role: "user", content: "different history" }] }), auth]
  ]) {
    assert.ok(!toResponsesBody(next, credentials).input.some((item) => item.type === "reasoning"));
  }
  assert.ok(toResponsesBody(continuation(body), { ...auth, token: "rotated-token" }).input.some((item) => item.type === "reasoning"));
});

test("native text items keep IDs and phase, while edited answers fall back safely", () => {
  const body = request("replay-text");
  const native = { status: "completed", output: [{ type: "message", role: "assistant", id: "msg_native", phase: "final_answer",
    content: [{ type: "output_text", text: "OK", annotations: [] }] }] };
  rememberReplay(body, auth, native, fromResponses(native, body.model));
  const next = { ...body, messages: [...body.messages, { role: "assistant", content: "OK" }] };
  assert.deepEqual(toResponsesBody(next, auth).input.at(-1), native.output[0]);
  next.messages.at(-1).content = "edited";
  assert.equal(toResponsesBody(next, auth).input.at(-1).id, undefined);
});

test("replay state is bounded and evicts oldest turns", () => {
  for (let i = 0; i < 513; i++) {
    const body = request(`replay-eviction-${i}`);
    rememberReplay(body, auth, response, fromResponses(response, body.model));
  }
  assert.ok(!toResponsesBody(continuation(request("replay-eviction-0")), auth).input.some((item) => item.type === "reasoning"));
  assert.ok(toResponsesBody(continuation(request("replay-eviction-512")), auth).input.some((item) => item.type === "reasoning"));
});
