const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelDiscovery } = require("../lib/model-discovery");

const ok = (data) => ({ ok: true, json: async () => data });

test("invalidation refreshes immediately and an older pending catalog cannot restore stale cache", async () => {
  let release;
  let calls = 0;
  const getModels = createModelDiscovery({
    now: () => 1,
    loadAuth: async () => ({ kind: "api", token: "test" }),
    loadClaudeAuth: async () => { throw new Error("no Copilot auth"); },
    fetchImpl: async () => {
      const index = ++calls;
      if (index === 1) await new Promise((resolve) => { release = resolve; });
      return ok({ data: [{ id: `gpt-${index}.4` }] });
    }
  });
  const old = getModels();
  await new Promise((resolve) => setImmediate(resolve));
  getModels.invalidate();
  const fresh = await getModels();
  assert.equal(fresh.data[0].id, "gpt-2.4");
  release();
  await old;
  assert.equal((await getModels()).data[0].id, "gpt-2.4");
  assert.equal(calls, 2);
  getModels.invalidate();
  assert.equal((await getModels()).data[0].id, "gpt-3.4");
});

test("OpenAI Responses and Copilot Claude catalogs merge, coalesce, and cache", async () => {
  let clock = 0;
  let calls = 0;
  let fail = false;
  const warnings = [];
  const getModels = createModelDiscovery({
    now: () => clock,
    onWarning: (source) => warnings.push(source),
    loadClaudeAuth: async () => ({ token: "copilot-test", baseUrl: "https://api.business.githubcopilot.com" }),
    loadAuth: async () => ({ kind: "api", token: "openai-test" }),
    fetchImpl: async (url, options) => {
      calls++;
      if (fail) throw new Error("offline");
      assert.equal(options.redirect, "error");
      if (url.includes("githubcopilot.com")) {
        assert.equal(options.headers.Authorization, "Bearer copilot-test");
        return ok({ data: [
          { id: "claude-sonnet-4", model_picker_enabled: true },
          { id: "gpt-5.4", model_picker_enabled: true }
        ] });
      }
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.Authorization, "Bearer openai-test");
      return ok({ data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-realtime" }, { id: "text-embedding-3-large" }] });
    }
  });
  const [first, joined] = await Promise.all([getModels(), getModels()]);
  assert.equal(calls, 2);
  assert.deepEqual(first.data.map((model) => model.id), ["gpt-5.4", "claude-sonnet-4"]);
  assert.deepEqual(joined, first);
  await getModels();
  assert.equal(calls, 2);
  clock = 300001;
  fail = true;
  assert.deepEqual((await getModels()).data, first.data);
  assert.deepEqual(warnings, ["OpenAI Responses", "GitHub Copilot"]);
  assert.equal(calls, 4);
});

test("Codex catalog honors visibility and API support filters", async () => {
  const getModels = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("No Copilot credentials"); },
    loadAuth: async () => ({ kind: "codex", token: "codex-test", accountId: "account-test" }),
    fetchImpl: async (url, options) => {
      assert.ok(url.includes("/codex/models?client_version="));
      assert.equal(options.headers["chatgpt-account-id"], "account-test");
      return ok({ models: [
        { slug: "gpt-5.4", visibility: "list" },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "gpt-unsupported", supported_in_api: false }
      ] });
    }
  });
  assert.deepEqual((await getModels()).data.map((model) => model.id), ["gpt-5.4"]);
});

test("a source that has never answered is omitted while the other source works", async () => {
  const getModels = createModelDiscovery({
    loadClaudeAuth: async () => { throw new Error("No Copilot credentials"); },
    loadAuth: async () => ({ kind: "api", token: "test" }),
    fetchImpl: async () => ok({ data: [{ id: "gpt-5.4" }] })
  });
  assert.deepEqual((await getModels()).data.map((model) => model.id), ["gpt-5.4"]);
});

test("Claude catalog failures preserve only the stale Claude source", async () => {
  let clock = 0;
  let failCopilot = false;
  const getModels = createModelDiscovery({
    now: () => clock,
    loadAuth: async () => ({ kind: "api", token: "test" }),
    loadClaudeAuth: async () => ({ token: "test", baseUrl: "https://api.business.githubcopilot.com" }),
    fetchImpl: async (url) => {
      if (url.includes("githubcopilot.com")) {
        if (failCopilot) throw new Error("Copilot offline");
        return ok({ data: [{ id: "claude-sonnet-4", model_picker_enabled: true }] });
      }
      return ok({ data: [{ id: "gpt-5.4" }] });
    }
  });
  const initial = await getModels();
  clock = 300001;
  failCopilot = true;
  assert.deepEqual((await getModels()).data, initial.data);
});
