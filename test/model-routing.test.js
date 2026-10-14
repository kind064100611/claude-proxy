const test = require("node:test");
const assert = require("node:assert/strict");
const { selectModel, toGatewayModels } = require("../lib/model-routing");

test("CLI explicit model and discovery aliases override settings", () => {
  const fallback = "gpt-5.4";
  for (const model of ["gpt-5.4", "openai/gpt-5", "claude-sonnet-4"]) {
    assert.equal(selectModel(model, fallback), model);
    assert.equal(selectModel("claude-gateway/" + model, fallback), model);
  }
  assert.equal(selectModel("claude-gateway/" + fallback, "gpt-5"), fallback);
  assert.equal(selectModel("claude-sonnet-5.5", fallback), "claude-sonnet-5.5");
  assert.equal(selectModel("claude-gateway/claude-opus-5.5", fallback), "claude-opus-5.5");
  for (const alias of [undefined, "", "sonnet", "opus", "haiku"]) {
    assert.equal(selectModel(alias, fallback), fallback);
  }
});

test("selected model families get one 1m suffix without mutating upstream IDs", () => {
  const ids = ["gpt-6.1-sol", "gpt-5.6-sol", "openai/gpt-6-sol", "claude-sonnet-5.5", "claude-haiku-4.5", "claude-opus-4.5[1m]"];
  const original = { data: ids.map((id) => ({ id })) };
  const result = toGatewayModels(original);
  result.data.forEach((model, index) => {
    const expected = ids[index].replace(/\[1m\]$/i, "") + "[1m]";
    assert.equal(model.id, "claude-gateway/" + expected);
    assert.equal(model.display_name, expected);
    assert.equal(selectModel(model.id, "unused"), expected);
  });
  assert.deepEqual(original.data.map((model) => model.id), ids);
  for (const id of ["gpt-6-astra", "gpt-5.4-mini"]) {
    assert.equal(toGatewayModels({ data: [{ id }] }).data[0].display_name, id);
  }
});

test("GPT Luna and Terra get one 1m suffix without mutating upstream IDs", () => {
  for (const family of ["luna", "terra"]) {
    for (const prefix of ["", "openai/"]) {
      const id = prefix + "gpt-6-" + family;
      for (const inputId of [id, id + "[1m]"]) {
        const original = { data: [{ id: inputId }] };
        const model = toGatewayModels(original).data[0];
        assert.equal(model.id, "claude-gateway/" + id + "[1m]");
        assert.equal(model.display_name, id + "[1m]");
        assert.equal(selectModel(model.id, "unused"), id + "[1m]");
        assert.equal(original.data[0].id, inputId);
      }
    }
  }
});

test("unsupported model IDs do not receive extended context", () => {
  const unsupported = toGatewayModels({ data: [{ id: "unsupported-model" }] }).data[0];
  assert.equal(unsupported.display_name, "unsupported-model");
  assert.equal(unsupported.description, "Model");
  assert.equal(toGatewayModels({ data: [{ id: "gpt-5.4-mini" }] }).data[0].description, "OpenAI Responses");
});

test("discovery list passes Claude filter while displaying original IDs", () => {
  const original = { object: "list", data: [{ id: "gpt-5.4", owned_by: "openai" }, { id: "claude-sonnet-5.5", owned_by: "github-copilot" }] };
  const result = toGatewayModels(original);
  assert.ok(result.data.every((model) => /claude|anthropic/i.test(model.id)));
  assert.equal(result.data[0].display_name, "gpt-5.4");
  assert.equal(result.data[0].description, "OpenAI Responses");
  assert.equal(result.data[1].description, "GitHub Copilot");
  assert.equal(original.data[0].id, "gpt-5.4");
});
