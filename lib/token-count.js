// The Codex transport has no Anthropic count_tokens endpoint. Return an explicit
// conservative local estimate without generation, auth, billing or history edits.
// UTF-8 byte length bounds byte-fallback text tokenization; JSON and per-block
// framing intentionally overcount. This is not an exact provider tokenizer.
function estimateInputTokens(body) {
  const input = {
    system: body.system || [],
    messages: body.messages || [],
    tools: body.tools || [],
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {})
  };
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  return bytes + 256 + (input.messages.length + input.tools.length) * 16;
}

module.exports = { estimateInputTokens };
