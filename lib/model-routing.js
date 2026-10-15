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

function toGatewayModels(models) {
  return {
    ...models,
    data: models.data.map((model) => {
      const baseId = model.id.replace(/\[1m\]$/i, "");
      // 目录给出有效上下文上限时以它为准，否则保留现有型号规则。
      const contextWindow = model.capabilities?.limits?.max_context_window_tokens;
      const hasContextWindow = Number.isSafeInteger(contextWindow) && contextWindow > 0;
      const useExtendedContext = hasContextWindow ? contextWindow >= 1000000
        : /(?:^|\/)(?:gpt-[\d.]+-(?:sol|luna|terra)(?:-|$)|claude-)/i.test(baseId);
      const displayId = useExtendedContext ? baseId + "[1m]" : hasContextWindow ? baseId : model.id;
      return {
        ...model,
        id: GATEWAY_MODEL_PREFIX + displayId,
        display_name: displayId,
        description: isClaudeModel(baseId) ? "GitHub Copilot" : /^(?:openai\/)?gpt-/i.test(baseId) ? "OpenAI Responses" : "Model"
      };
    })
  };
}

module.exports = { selectModel, toGatewayModels };
