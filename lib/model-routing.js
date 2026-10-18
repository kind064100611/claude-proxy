const { isClaudeModel } = require("./github-copilot");

const GATEWAY_MODEL_PREFIX = "claude-gateway/";

function selectModel(requestedModel, configuredModel) {
  if (typeof requestedModel !== "string" || !requestedModel.trim()) return configuredModel;
  const requested = requestedModel.trim();
  if (requested.startsWith(GATEWAY_MODEL_PREFIX)) return requested.slice(GATEWAY_MODEL_PREFIX.length);
  if (isClaudeModel(requested)) return requested;
  // Short aliases use the configured default; explicit IDs use their provider.
  if (/^(?:sonnet|opus|haiku|fable|default|opusplan)(?:\[|$)/i.test(requested)) return configuredModel;
  return requested;
}

function maximumContextWindow(model) {
  const limits = [model.context_window, model.max_context_window, model.runtime?.max_input_tokens,
    model.capabilities?.limits?.max_context_window_tokens]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return limits.length ? Math.max(...limits) : undefined;
}

function toGatewayModels(models) {
  return {
    ...models,
    data: models.data.map((model) => {
      const baseId = model.id.replace(/\[1m\]$/i, "");
      const contextWindow = maximumContextWindow(model);
      const hasContextWindow = Number.isSafeInteger(contextWindow) && contextWindow > 0;
      // Capacity is numeric metadata, never inferred from a name or a [1m] threshold.
      const displayId = hasContextWindow ? baseId : model.id;
      return {
        ...model,
        ...(hasContextWindow ? { context_window: contextWindow,
          runtime: { ...model.runtime, max_input_tokens: contextWindow },
          capabilities: { ...model.capabilities, limits: { ...model.capabilities?.limits,
            max_context_window_tokens: contextWindow } } } : {}),
        id: GATEWAY_MODEL_PREFIX + displayId,
        display_name: displayId,
        description: isClaudeModel(baseId) ? "GitHub Copilot" : /^(?:openai\/)?gpt-/i.test(baseId) ? "OpenAI Responses" : "Model"
      };
    })
  };
}

module.exports = { selectModel, toGatewayModels, maximumContextWindow };
