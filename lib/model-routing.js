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
      const useExtendedContext = /(?:^|\/)(?:gpt-[\d.]+-(?:sol|luna|terra)(?:-|$)|claude-)/i.test(baseId);
      const displayId = useExtendedContext ? baseId + "[1m]" : model.id;
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
