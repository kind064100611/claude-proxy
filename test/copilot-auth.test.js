const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadCopilotAuth: loadStoredAuth, getCopilotBaseUrl } = require("../lib/copilot-auth");
const { createCredentialStore } = require("../lib/credential-store");
let store;
const loadCopilotAuth = (options) => loadStoredAuth({ ...options, store });

async function withAuth(data, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-copilot-test-"));
  const file = path.join(directory, "auth.json");
  store = createCredentialStore({ directory });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  try { await callback(file); }
  finally {
    store = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const credential = { type: "oauth", access: "test;proxy-ep=proxy.business.githubcopilot.com;", refresh: "github-test", expires: Date.now() + 3600000 };

test("copied Copilot auth uses its own endpoint independently of OpenAI API key", async () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "openai-test";
  try {
    await withAuth({ "github-copilot": credential }, async () => {
      assert.deepEqual(await loadCopilotAuth(), { token: credential.access, baseUrl: "https://api.business.githubcopilot.com" });
    });
    assert.equal(getCopilotBaseUrl("no-proxy"), "https://api.individual.githubcopilot.com");
    assert.equal(getCopilotBaseUrl("no-proxy", "company.ghe.com"), "https://copilot-api.company.ghe.com");
    assert.throws(() => getCopilotBaseUrl("proxy-ep=attacker.example/path;"), /Invalid Copilot proxy/);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("Copilot refresh deduplicates, keeps GitHub refresh token and atomically preserves other providers", async () => {
  await withAuth({ "github-copilot": { ...credential, expires: 0 }, "openai-codex": { untouched: true } }, async (file) => {
    let calls = 0;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const fetchImpl = async (url, options) => {
      calls++;
      assert.equal(url, "https://api.github.com/copilot_internal/v2/token");
      assert.equal(options.headers.Authorization, "Bearer github-test");
      const latest = JSON.parse(fs.readFileSync(file));
      latest.other = { preserved: true };
      latest["github-copilot"].availableModelIds = ["claude-new-model"];
      fs.writeFileSync(file, JSON.stringify(latest));
      return new Response(JSON.stringify({ token: "rotated;proxy-ep=proxy.business.githubcopilot.com;", expires_at: expiresAt }));
    };
    const results = await Promise.all([loadCopilotAuth({ fetchImpl }), loadCopilotAuth({ fetchImpl })]);
    assert.equal(calls, 1);
    assert.equal(results[0].token, results[1].token);
    const saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved["github-copilot"].refresh, "github-test");
    assert.equal(saved["github-copilot"].expires, expiresAt * 1000 - 300000);
    assert.deepEqual(saved["openai-codex"], { untouched: true });
    assert.deepEqual(saved.other, { preserved: true });
    assert.deepEqual(saved["github-copilot"].availableModelIds, ["claude-new-model"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["auth.json"]);
  });
});

test("Copilot refresh errors do not leak bodies or modify copied credentials", async () => {
  await withAuth({ "github-copilot": { ...credential, expires: 0 } }, async (file) => {
    const before = fs.readFileSync(file, "utf8");
    await assert.rejects(loadCopilotAuth({ fetchImpl: async () => new Response("private-secret-response", { status: 403 }) }), (error) => error.status === 401 && !error.message.includes("private-secret-response"));
    assert.equal(fs.readFileSync(file, "utf8"), before);
    await assert.rejects(loadCopilotAuth({ fetchImpl: async () => new Response(JSON.stringify({ token: "invalid", expires_at: 0 })) }), /valid token fields/);
  });
  await withAuth({}, async () => { await assert.rejects(loadCopilotAuth(), /github-copilot OAuth/); });
});

test("Copilot relogin with unchanged GitHub token invalidates an older refresh", async () => {
  await withAuth({ "github-copilot": { ...credential, expires: 0 } }, async () => {
    await assert.rejects(loadCopilotAuth({ fetchImpl: async () => {
      store.saveLogin("github-copilot", { ...credential, access: "new-login" });
      return new Response(JSON.stringify({ token: "stale", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    } }), /发生变化/);
    assert.equal((await loadCopilotAuth()).token, "new-login");
  });
});

test("Copilot refresh refuses concurrent credential replacement without exposing malformed contents", async () => {
  for (const replacement of [JSON.stringify({ "github-copilot": { ...credential, refresh: "different" } }), "private-malformed-contents"]) {
    await withAuth({ "github-copilot": { ...credential, expires: 0 } }, async (file) => {
      const fetchImpl = async () => {
        fs.writeFileSync(file, replacement);
        return new Response(JSON.stringify({ token: "rotated", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      };
      await assert.rejects(loadCopilotAuth({ fetchImpl }), (error) => error.status === 401 && !error.message.includes("private-malformed-contents"));
      assert.equal(fs.readFileSync(file, "utf8"), replacement);
    });
  }
});
