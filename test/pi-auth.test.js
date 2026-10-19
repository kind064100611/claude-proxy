const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadPiAuth: loadStoredAuth, readCredentialAvailability } = require("../lib/pi-auth");
const { createCredentialStore } = require("../lib/credential-store");
const { requestResponses: requestStoredResponses, toResponsesBody, getPromptCacheKey } = require("../lib/openai-responses");
let store;
const loadPiAuth = (options) => loadStoredAuth({ ...options, store });
const requestResponses = (body, options) => requestStoredResponses(body, { ...options, loadAuth: loadPiAuth });

test("local credential availability validates structure without refreshing, migrating or writing", (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("must not make network requests"));
  const oauth = { type: "oauth", access: "access", refresh: "refresh", expires: 0 };
  const api = { type: "api_key", key: "key" };
  const cases = [
    [{}, {}, false, false],
    [{}, { OPENAI_API_KEY: " key " }, true, false],
    [{}, { OPENAI_API_KEY: " \t" }, false, false],
    [{}, { OPENAI_API_KEY: 123 }, false, false],
    [{ "github-copilot": oauth }, {}, false, true],
    [{ "github-copilot": api }, {}, false, false],
    [{ openai: api }, {}, true, false],
    [{ "openai-codex": api }, {}, true, false],
    [{ openai: oauth, "github-copilot": oauth }, {}, true, true],
    [{ "openai-codex": oauth }, {}, true, false],
    // Legacy openai wins unless codex carries a loginVersion, even if the selected value is invalid.
    [{ openai: api, "openai-codex": {} }, {}, true, false],
    [{ openai: {}, "openai-codex": oauth }, {}, false, false],
    [{ openai: api, "openai-codex": { loginVersion: "new" } }, {}, false, false],
    [{ openai: {}, "openai-codex": { ...oauth, loginVersion: "new" } }, {}, true, false]
  ];
  for (const invalid of [null, {}, { ...api, key: " " }, { ...api, key: 1 },
    { ...oauth, access: " " }, { ...oauth, refresh: "\t" }, { ...oauth, expires: "0" },
    { ...oauth, expires: Infinity }, { ...oauth, expires: NaN }]) {
    cases.push([{ openai: invalid, "github-copilot": invalid }, {}, false, false]);
  }
  for (const [auth, env, openai, copilot] of cases) {
    let reads = 0;
    const store = {
      readAuth(options) { reads++; assert.deepEqual(options, { readOnly: true }); return auth; },
      migrate() { assert.fail("must not migrate"); },
      updateProvider() { assert.fail("must not write"); },
      saveLogin() { assert.fail("must not save"); }
    };
    const before = JSON.stringify(auth);
    assert.deepEqual(readCredentialAvailability({ env, store }), { openai, copilot });
    assert.equal(reads, 1);
    assert.equal(JSON.stringify(auth), before);
  }
});

test("local credential availability propagates storage failures even with an environment key", () => {
  const error = new Error("storage failure");
  for (const env of [{}, { OPENAI_API_KEY: "key" }]) {
    assert.throws(() => readCredentialAvailability({ env, store: { readAuth() { throw error; } } }),
      (actual) => actual === error);
  }
});

const jwt = (accountId) => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.signature`;

async function withAuth(data, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-test-"));
  const file = path.join(directory, "auth.json");
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  store = createCredentialStore({ directory });
  fs.writeFileSync(file, JSON.stringify(data));
  try { await callback(file); }
  finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    store = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("copied Pi API-key and OAuth credentials select correct auth", async () => {
  await withAuth({ openai: { type: "api_key", key: "test-key" } }, async () => {
    assert.deepEqual(await loadPiAuth(), { token: "test-key", kind: "api" });
  });
  await withAuth({ openai: { type: "oauth", access: "direct-token", refresh: "refresh", expires: Date.now() + 3600000, clientId: "client-test" } }, async () => {
    assert.equal((await loadPiAuth()).kind, "chatgpt");
  });
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    assert.equal((await loadPiAuth()).accountId, "account-test");
  });
});

test("expired copied OAuth credentials refresh once and persist rotation atomically", async () => {
  for (const provider of ["openai", "openai-codex"]) {
    await withAuth({ [provider]: { type: "oauth", access: "old", refresh: "refresh-old", expires: 0, clientId: "client-test" }, other: { keep: true } }, async (file) => {
      let calls = 0;
      const fetchImpl = async (url, options) => {
        calls++;
        assert.equal(url, provider === "openai" ? "https://auth.openai.com/api/accounts/oauth/token" : "https://auth.openai.com/oauth/token");
        assert.equal(options.body.get("grant_type"), "refresh_token");
        assert.equal(options.body.get("client_id"), provider === "openai" ? "client-test" : "app_EMoamEEZ73f0CkXaXp7hrann");
        return { ok: true, json: async () => ({ access_token: jwt("new-account"), refresh_token: "refresh-new", expires_in: 3600 }) };
      };
      const results = await Promise.all([loadPiAuth({ fetchImpl }), loadPiAuth({ fetchImpl })]);
      assert.equal(calls, 1);
      assert.equal(results[0].token, results[1].token);
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(stored[provider].refresh, "refresh-new");
      assert.deepEqual(stored.other, { keep: true });
      assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
    });
  }
});

test("new ChatGPT login wins over legacy openai and stale same-refresh requests cannot overwrite it", async () => {
  await withAuth({ openai: { type: "api_key", key: "legacy" }, "openai-codex": { type: "oauth", access: jwt("old"), refresh: "same", expires: 0 } }, async () => {
    assert.equal((await loadPiAuth()).token, "legacy");
    store.saveLogin("openai-codex", { type: "oauth", access: jwt("first-login"), refresh: "same", expires: 0 });
    await assert.rejects(loadPiAuth({ fetchImpl: async () => {
      store.saveLogin("openai-codex", { type: "oauth", access: jwt("new-login"), refresh: "same", expires: Date.now() + 3600000 });
      return new Response(JSON.stringify({ access_token: jwt("stale"), refresh_token: "same", expires_in: 3600 }));
    } }), /发生变化/);
    assert.equal((await loadPiAuth()).accountId, "new-login");
    process.env.OPENAI_API_KEY = "environment-secret";
    assert.deepEqual(await loadPiAuth(), { token: "environment-secret", kind: "api" });
    assert.ok(!JSON.stringify(store.readAuth()).includes("environment-secret"));
  });
});

test("OAuth failure is safe and leaves copied credentials unchanged", async () => {
  await withAuth({ openai: { type: "oauth", access: "old", refresh: "private-refresh", expires: 0, clientId: "client-test" } }, async (file) => {
    const previous = fs.readFileSync(file, "utf8");
    await assert.rejects(loadPiAuth({ fetchImpl: async () => ({ ok: false, status: 401 }) }), /refresh failed/);
    assert.equal(fs.readFileSync(file, "utf8"), previous);
  });
});

test("Codex uses ChatGPT Responses and aggregates SSE for non-streaming client", async () => {
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    const response = { id: "resp_test", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 2000, output_tokens: 1, input_tokens_details: { cached_tokens: 1536 } } };
    const assembled = await requestResponses({ model: "gpt-5", stream: false, messages: [{ role: "system", content: "instructions" }], prompt_cache_key: "stable-key" }, {
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
        assert.equal(options.headers["chatgpt-account-id"], "account-test");
        assert.equal(options.headers["session-id"], "stable-key");
        assert.equal(options.headers["x-client-request-id"], "stable-key");
        const body = JSON.parse(options.body);
        assert.equal(body.instructions, "instructions");
        assert.equal(body.stream, true);
        assert.equal(body.max_output_tokens, undefined);
        assert.equal(body.prompt_cache_key, "stable-key");
        return { ok: true, body: (async function* () {
          yield Buffer.from(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: response.output[0] })}\n\n`);
          yield Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { ...response, output: [] } })}\n\n`);
        })() };
      }
    });
    assert.equal(assembled.content, "ok");
    assert.equal(assembled.usage.cached_tokens, 1536);
  });
  const direct = toResponsesBody({ model: "gpt-5", messages: [], max_tokens: 128, temperature: 1 }, { kind: "chatgpt" });
  assert.equal(direct.max_output_tokens, undefined);
  assert.equal(direct.temperature, undefined);
});

test("Codex tool SSE output is replayed natively on the next tool-result turn", async () => {
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("tool-replay-account"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    const first = { model: "gpt-6-sol", prompt_cache_key: "tool-replay-integration", stream: true,
      messages: [{ role: "user", content: "call read" }] };
    const output = [{ type: "reasoning", id: "rs_native", encrypted_content: "opaque-state", summary: [] },
      { type: "function_call", id: "fc_native", call_id: "call_native", name: "read", arguments: '{ "n": 1 }' },
      { type: "function_call", id: "fc_second", call_id: "call_second", name: "read", arguments: '{ "n": 2 }' }];
    await requestResponses(first, { fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(options.body).include, ["reasoning.encrypted_content"]);
      return { ok: true, body: (async function* () {
        for (const index of [0, 2, 1]) yield Buffer.from(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item: output[index] })}\n\n`);
        yield Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`);
      })() };
    } });
    const stats = [];
    await requestResponses({ ...first, messages: [...first.messages,
      { role: "assistant", content: null, tool_calls: [
        { id: "call_second", function: { name: "read", arguments: '{"n":2}' } },
        { id: "call_native", function: { name: "read", arguments: '{"n":1}' } }] },
      { role: "tool", tool_call_id: "call_native", content: "result" }] }, {
      onCacheUsage: (value) => stats.push(value),
      fetchImpl: async (_, options) => {
        const payload = JSON.parse(options.body);
        assert.deepEqual(payload.input.slice(1, 4), output);
        assert.equal(payload.input[4].call_id, "call_native");
        assert.equal(payload.replayed_assistant_turns, undefined);
        return { ok: true, body: (async function* () { yield Buffer.from('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'); })() };
      }
    });
    assert.equal(stats[0].replayed_assistant_turns, 1);
    assert.ok(!JSON.stringify(stats).includes("opaque-state"));
  });
});

test("Codex affinity and cache diagnostics stay stable, private and accurate across turns", async () => {
  await withAuth({ "openai-codex": { type: "oauth", access: jwt("account-test"), refresh: "refresh", expires: Date.now() + 3600000 } }, async () => {
    const stats = [];
    const key = getPromptCacheKey({ metadata: { user_id: "private-session-a" } });
    const messages = [{ role: "system", content: "private-instructions" }, { role: "user", content: "private-prompt" }];
    const cases = [
      { model: "gpt-5", stream: false, prompt_cache_key: key, messages },
      { model: "gpt-5", stream: true, prompt_cache_key: key, messages: [...messages, { role: "assistant", content: "reply" }, { role: "user", content: "next" }] },
      { model: "gpt-5", stream: false, prompt_cache_key: getPromptCacheKey({ metadata: { user_id: "private-session-b" } }), messages,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] },
      { model: "gpt-5", stream: true, messages }
    ];
    for (const body of cases) {
      await requestResponses(body, {
        onCacheUsage: (usage) => stats.push(usage),
        fetchImpl: async (_, options) => {
          assert.equal(options.headers["session-id"], body.prompt_cache_key);
          assert.equal(options.headers["x-client-request-id"], body.prompt_cache_key);
          const response = { status: "completed", output: [], usage: { input_tokens: body.prompt_cache_key ? 2000 : 0,
            output_tokens: 1, input_tokens_details: { cached_tokens: body.prompt_cache_key ? 1536 : 0 } } };
          return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`); })() };
        }
      });
    }
    assert.equal(stats.length, 4);
    assert.equal(stats[0].total_input_tokens, 2000);
    assert.equal(stats[0].cache_read_input_tokens, 1536);
    assert.equal(stats[0].uncached_input_tokens, 464);
    assert.equal(stats[0].cache_hit_percent, 76.8);
    assert.equal(stats[0].auth_kind, "codex");
    assert.equal(stats[0].cache_key_id, stats[1].cache_key_id);
    assert.equal(stats[0].prefix_id, stats[1].prefix_id);
    assert.notEqual(stats[0].cache_key_id, stats[2].cache_key_id);
    assert.notEqual(stats[0].prefix_id, stats[2].prefix_id);
    assert.equal(stats[3].cache_key_id, "none");
    assert.equal(stats[3].cache_hit_percent, 0);
    const serialized = JSON.stringify(stats);
    for (const secret of ["private-session-a", "private-prompt", "private-instructions", key, jwt("account-test")]) {
      assert.ok(!serialized.includes(secret));
    }
  });
});
