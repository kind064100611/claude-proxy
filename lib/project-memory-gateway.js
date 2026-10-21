"use strict";

const TOOL_NAME = "ProjectMemoryUpdate";
const QUEUED = "Queued.";
const MAX_SEEN_CALLS = 1000;
// 工具定义与系统提示逐字节固定，提示缓存前缀稳定；开关切换只多一次缓存重写。
const TOOL_JSON = JSON.stringify({
  name: TOOL_NAME,
  description: "Queue background maintenance of the repository's projectCodeMemory/ records after code changes, new source-verified findings from read-only analysis, or records found wrong. " +
    "The gateway maintains the records with a cheaper model, consumes this call before it reaches the client, and adds a plain-text queue acknowledgement; no local tool or follow-up is needed.",
  input_schema: {
    type: "object",
    properties: {
      root: { type: "string", description: "Absolute path of the repository root that contains projectCodeMemory/." },
      changed_paths: { type: "array", items: { type: "string" }, description: "Repository-relative source and test files changed in this task. Use an empty array for read-only analysis; never report unchanged files as changed." },
      learned: {
        type: "array", maxItems: 3,
        description: "At most 3 items of stable, reusable, non-obvious knowledge verified in this task; omit trivia and task narration.",
        items: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Short topic name." },
            facts: { type: "array", items: { type: "string" }, description: "Dense, independently useful statements." },
            paths: { type: "array", items: { type: "string" }, description: "Repository-relative files that directly support the facts." },
            symbols: { type: "array", items: { type: "string" }, description: "Exact identifiers that appear verbatim in those files." }
          },
          required: ["topic", "facts", "paths"]
        }
      },
      obsolete: { type: "array", items: { type: "string" }, description: "IDs of records this task showed to be wrong or useless." }
    },
    required: ["root", "changed_paths"]
  }
});
const SYSTEM_TEXT = [
  "Project Code Memory maintenance: after a task in a repository that has a projectCodeMemory/ directory, if you changed source or test files",
  "or discovered new, stable, reusable, non-obvious code knowledge verified against current source during read-only analysis, or found records wrong or useless,",
  `write your final answer to the user first, then make exactly one ${TOOL_NAME} call as the last block of that same response, with no other tool call in it.`,
  "Pass the repository root, the changed source/test paths, at most 3 learned items (only knowledge verified in this task,",
  "with the files you actually read and the exact symbols that support it) and the IDs of records you found wrong or useless.",
  "For read-only analysis, pass an empty changed_paths array and include the new verified knowledge and its evidence paths in learned; never invent code changes.",
  `Do not call ${TOOL_NAME} when there are no source/test changes, new verified reusable knowledge or wrong records to report, or the repository has no projectCodeMemory/ directory.`,
  "Simple lookups, repeated findings already covered by existing records, speculation and task narration are not new knowledge.",
  "Do not call it when your final answer goes to another agent instead of the user (you are a subagent); the agent that answers the user reports the changes or findings.",
  "Never create, edit, save or prune files under projectCodeMemory/ yourself; the gateway maintains them in the background."
].join(" ");

const blocksOf = (message) => Array.isArray(message?.content) ? message.content : [];
const isOurCall = (block) => block?.type === "tool_use" && block.name === TOOL_NAME && typeof block.id === "string";

// 纯函数加进程内去重集合：注入工具与系统提示、改写我们工具的结果、找出本轮新触发的调用、判断能否由代理直接回答。
function createProjectMemoryGateway() {
  const seen = new Set();

  function prepare(body, { enabled = false, readOnly = false } = {}) {
    if (!body || !Array.isArray(body.messages)) return { body, triggers: [], reply: null };
    const ours = new Set();
    for (const message of body.messages) if (message?.role === "assistant") for (const block of blocksOf(message)) if (isOurCall(block)) ours.add(block.id);

    // 每次请求都确定性地改写，Claude Code 报的 "No such tool" 错误不进入上下文。
    let messages = body.messages;
    if (ours.size) {
      messages = body.messages.map((message) => {
        if (message?.role !== "user" || !blocksOf(message).some((block) => block?.type === "tool_result" && ours.has(block.tool_use_id))) return message;
        return { ...message, content: message.content.map((block) => block?.type === "tool_result" && ours.has(block.tool_use_id)
          ? { type: "tool_result", tool_use_id: block.tool_use_id, content: QUEUED, is_error: false, ...(block.cache_control ? { cache_control: block.cache_control } : {}) }
          : block) };
      });
    }
    const inject = enabled && Array.isArray(body.tools) && body.tools.some((tool) => tool?.name === "Edit" || tool?.name === "Write") &&
      !body.tools.some((tool) => tool?.name === TOOL_NAME);
    const prepared = messages === body.messages && !inject ? body : { ...body, messages };
    if (inject) {
      prepared.tools = [...body.tools, JSON.parse(TOOL_JSON)];
      const system = { type: "text", text: SYSTEM_TEXT };
      prepared.system = Array.isArray(body.system) ? [...body.system, system]
        : typeof body.system === "string" && body.system ? [{ type: "text", text: body.system }, system] : [system];
    }

    // 只看最后一条 assistant 与其后的 user 消息：恢复会话或重启不会重新触发旧调用。
    // 排队消息（子代理回报、任务通知）可能作为单独的 user 消息跟在工具结果之后。
    const last = body.messages.findLastIndex((message) => message?.role === "assistant");
    const assistant = body.messages[last];
    const users = body.messages.slice(last + 1);
    if (!enabled || readOnly || last < 0 || !users.length || users.some((message) => message?.role !== "user")) return { body: prepared, triggers: [], reply: null };
    const answered = new Set(users.flatMap(blocksOf).filter((block) => block?.type === "tool_result").map((block) => block.tool_use_id));
    const calls = blocksOf(assistant).filter((block) => isOurCall(block) && answered.has(block.id));
    const triggers = [];
    for (const call of calls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      if (seen.size > MAX_SEEN_CALLS) seen.delete(seen.values().next().value);
      triggers.push(call.input && typeof call.input === "object" ? call.input : {});
    }
    // 最终回答已写完、只剩我们一个调用、用户消息只有它的结果时，代理自己结束这一轮，不再请求上游。
    // 本地回复原样重复那段最终回答：子代理的父代理和 claude -p 只取最后一条消息，仍能拿到真正的回答。
    const blocks = blocksOf(assistant);
    const answer = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n\n");
    const local = calls.length === 1 && blocks.filter((block) => block?.type === "tool_use").length === 1 && answer.trim() &&
      blocks.every((block) => ["text", "tool_use", "thinking", "redacted_thinking"].includes(block?.type)) &&
      users.length === 1 && blocksOf(users[0]).length === 1 && blocksOf(users[0])[0].tool_use_id === calls[0].id;
    return { body: prepared, triggers, reply: local ? answer : null };
  }

  // 在响应出口消费虚拟工具；客户端只收到普通文本，不再执行不存在的本地工具。
  function createResponseHandler({ enqueue }) {
    let pending = null;
    let pendingBytes = 0;
    let clientTools = 0;

    function consume(call, complete) {
      if (!complete || !call.input || typeof call.input !== "object" || Array.isArray(call.input) ||
        typeof call.input.root !== "string" || !Array.isArray(call.input.changed_paths)) return "Project memory maintenance was not queued.";
      if (seen.has(call.id)) return QUEUED;
      try {
        if (!enqueue(call.input)) return "Project memory maintenance was not queued.";
      } catch (_) { return "Project memory maintenance was not queued."; }
      seen.add(call.id);
      if (seen.size > MAX_SEEN_CALLS) seen.delete(seen.values().next().value);
      return QUEUED;
    }

    function message(value) {
      if (value?.type !== "message" || !Array.isArray(value.content) || !value.content.some(isOurCall)) return value;
      const complete = value.stop_reason === "tool_use" || value.stop_reason === "end_turn";
      const content = value.content.map((block) => isOurCall(block)
        ? { type: "text", text: "\n\n" + consume(block, complete) } : block);
      return { ...value, content, stop_reason: value.stop_reason === "tool_use" && !content.some((block) => block?.type === "tool_use")
        ? "end_turn" : value.stop_reason };
    }

    function drain(complete) {
      const events = pending;
      pending = null;
      pendingBytes = 0;
      const calls = new Map();
      for (const value of events) {
        if (value.type === "content_block_start") {
          if (isOurCall(value.content_block)) calls.set(value.index, { call: value.content_block, json: "", stopped: false });
          else if (value.content_block?.type === "tool_use") clientTools++;
        }
        const entry = calls.get(value.index);
        if (entry && value.type === "content_block_delta" && value.delta?.type === "input_json_delta") entry.json += value.delta.partial_json;
        if (entry && value.type === "content_block_stop") entry.stopped = true;
      }
      const output = [];
      for (const value of events) {
        const entry = calls.get(value.index);
        if (entry && ["content_block_start", "content_block_delta", "content_block_stop"].includes(value.type)) {
          if (value.type !== "content_block_start") continue;
          let input = entry.call.input;
          try { if (entry.json) input = JSON.parse(entry.json); } catch (_) { input = null; }
          const text = "\n\n" + consume({ ...entry.call, input }, complete && entry.stopped);
          output.push(
            { type: "content_block_start", index: value.index, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: value.index, delta: { type: "text_delta", text } },
            { type: "content_block_stop", index: value.index });
        } else if (value.type === "message_delta" && value.delta?.stop_reason === "tool_use" && !clientTools) {
          output.push({ ...value, delta: { ...value.delta, stop_reason: "end_turn" } });
        } else output.push(value);
      }
      return output;
    }

    function event(value) {
      if (!pending && value.type === "content_block_start" && isOurCall(value.content_block)) pending = [];
      if (pending) {
        pendingBytes += Buffer.byteLength(JSON.stringify(value));
        if (pendingBytes > 32 * 1024 * 1024) throw new Error("Project memory response exceeds the buffer limit");
        pending.push(value);
        if (value.type === "message_delta" && value.delta?.stop_reason) return drain(["tool_use", "end_turn"].includes(value.delta.stop_reason));
        if (value.type === "error" || value.type === "message_stop") return drain(false);
        return [];
      }
      if (value.type === "content_block_start" && value.content_block?.type === "tool_use") clientTools++;
      return [value];
    }

    return { message, event, finish: () => pending ? drain(false) : [] };
  }

  return { prepare, createResponseHandler };
}

module.exports = { createProjectMemoryGateway, TOOL_NAME, QUEUED };
