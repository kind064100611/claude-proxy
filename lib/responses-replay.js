const crypto = require("crypto");

// Anthropic clients cannot carry Responses item IDs/encrypted reasoning. Keep
// exact native output only in bounded process memory, never in logs or on disk.
const outputs = new Map();
const MAX_ENTRIES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
let bytes = 0;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function assistantView(message) {
  return {
    content: message.content || "",
    calls: (message.tool_calls || []).map((call) => {
      let args = call.function.arguments;
      try { args = JSON.parse(args); } catch (_) { /* Preserve malformed arguments as text. */ }
      return { id: call.id, name: call.function.name, args };
    })
  };
}

function replayKey(body, auth, prefix, assistant) {
  const identity = auth.accountId || crypto.createHash("sha256").update(auth.token || "").digest("hex");
  const value = { provider: auth.kind, identity, model: body.model.replace(/^openai\//i, ""),
    session: body.prompt_cache_key || "", prefix, assistant: assistantView(assistant) };
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function messageView(message) {
  return message.role === "assistant" ? { role: "assistant", ...assistantView(message) } : message;
}

function historyHash(messages, prefixes) {
  const hash = crypto.createHash("sha256");
  for (const message of messages) {
    if (prefixes) prefixes.push(hash.copy().digest("hex"));
    hash.update(JSON.stringify(canonical(messageView(message)))).update("\0");
  }
  return hash.digest("hex");
}

function createReplayReader(body, auth) {
  // Hash each message once rather than repeatedly hashing every growing prefix.
  const prefixes = [];
  historyHash(body.messages || [], prefixes);
  return (index) => {
    const key = replayKey(body, auth, prefixes[index], body.messages[index]);
    const entry = outputs.get(key);
    if (!entry) return undefined;
    outputs.delete(key);
    outputs.set(key, entry);
    return structuredClone(entry.output);
  };
}

function rememberReplay(body, auth, response, assembled) {
  if (response.status !== "completed" || !response.output?.length ||
    response.output.some((item) => !["message", "reasoning", "function_call"].includes(item.type))) return;
  const assistant = { content: assembled.content, tool_calls: assembled.tool_calls };
  const key = replayKey(body, auth, historyHash(body.messages || []), assistant);
  const size = Buffer.byteLength(JSON.stringify(response.output));
  if (size > MAX_BYTES) return;
  const previous = outputs.get(key);
  if (previous) { bytes -= previous.size; outputs.delete(key); }
  outputs.set(key, { output: structuredClone(response.output), size });
  bytes += size;
  while (outputs.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const oldest = outputs.keys().next().value;
    bytes -= outputs.get(oldest).size;
    outputs.delete(oldest);
  }
}

module.exports = { createReplayReader, rememberReplay };
