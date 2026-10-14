const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCredentialStore } = require("../lib/credential-store");

test("store construction and import without an explicit source leave disk untouched", (t) => {
  const { repository, store } = fixture(t);
  const source = path.join(repository, "auth.json");
  fs.writeFileSync(source, JSON.stringify({ openai: credential }));
  assert.equal(fs.existsSync(store.directory), false);
  store.migrate({ repository, piAuthFile: null });
  assert.equal(fs.existsSync(store.directory), false);
  assert.equal(fs.readFileSync(source, "utf8"), JSON.stringify({ openai: credential }));
});

test("explicit BOM import leaves source bytes unchanged and creates only private auth.json", (t) => {
  const { repository, store, migrate } = fixture(t);
  const source = path.join(repository, "auth.json");
  const original = "﻿" + JSON.stringify({ "openai-codex": credential });
  fs.writeFileSync(source, original);
  migrate();
  assert.deepEqual(store.readAuth(), { "openai-codex": credential });
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.deepEqual(fs.readdirSync(store.directory), ["auth.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.authFile).mode & 0o777, 0o600);
  }
});

test("invalid import and failed writes preserve external sources", (t) => {
  const { repository, store, migrate } = fixture(t);
  const source = path.join(repository, "auth.json");
  fs.writeFileSync(source, "invalid private source");
  migrate();
  assert.equal(fs.existsSync(store.authFile), false);
  assert.equal(fs.readFileSync(source, "utf8"), "invalid private source");
  fs.writeFileSync(source, JSON.stringify({ openai: credential }));
  fs.writeFileSync(store.directory, "blocked");
  migrate();
  assert.equal(fs.readFileSync(source, "utf8"), JSON.stringify({ openai: credential }));
});

const credential = { type: "oauth", access: "private-access", refresh: "private-refresh", expires: 12345 };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  fs.mkdirSync(repository);
  const store = createCredentialStore({ directory: path.join(root, "store"), now: () => 100 });
  const warnings = [];
  const migrate = (options = {}) => store.migrate({ piAuthFile: path.join(repository, "auth.json"), onWarning: (warning) => warnings.push(warning), ...options });
  return { root, repository, store, warnings, migrate };
}

test("existing and corrupt targets are never replaced by migration or login", (t) => {
  const { repository, store, warnings, migrate } = fixture(t);
  const source = path.join(repository, "auth.json");
  fs.writeFileSync(source, JSON.stringify({ openai: credential }));
  fs.mkdirSync(store.directory);
  fs.writeFileSync(store.authFile, "private malformed contents");
  migrate();
  assert.equal(fs.readFileSync(store.authFile, "utf8"), "private malformed contents");
  assert.ok(fs.existsSync(source));
  assert.throws(() => store.saveLogin("openai-codex", credential), (error) => !error.message.includes("private malformed"));
  fs.writeFileSync(store.authFile, JSON.stringify({ "github-copilot": credential }));
  migrate();
  assert.deepEqual(store.readAuth(), { "github-copilot": credential });
  assert.ok(fs.existsSync(source));
  assert.equal(warnings.length, 2);
});

test("external PI_AUTH_FILE is an import source only and partial unsupported sources are retained", (t) => {
  const { root, repository, store, warnings, migrate } = fixture(t);
  const external = path.join(root, "pi-auth.json");
  const original = JSON.stringify({ "github-copilot": credential, unrelated: credential });
  fs.writeFileSync(external, original);
  migrate({ piAuthFile: external });
  assert.deepEqual(store.readAuth(), { "github-copilot": credential });
  store.saveLogin("github-copilot", { ...credential, access: "new" });
  assert.equal(fs.readFileSync(external, "utf8"), original);
  assert.equal(warnings.length, 1);
  fs.unlinkSync(store.authFile);
  const repoSource = path.join(repository, "auth.json");
  fs.writeFileSync(repoSource, original);
  migrate({ piAuthFile: repoSource });
  assert.ok(fs.existsSync(repoSource));
  assert.deepEqual(Object.keys(store.readAuth()), ["github-copilot"]);
});

test("migration does not treat unsupported Copilot API-key credentials as supported import content", (t) => {
  const { repository, store, migrate } = fixture(t);
  const source = path.join(repository, "auth.json");
  fs.writeFileSync(source, JSON.stringify({ "github-copilot": { type: "api_key", key: "unsupported" } }));
  migrate();
  assert.equal(fs.existsSync(store.authFile), false);
  assert.ok(fs.existsSync(source));
  fs.writeFileSync(source, JSON.stringify({ openai: credential, "github-copilot": { type: "api_key", key: "unsupported" } }));
  migrate();
  assert.deepEqual(Object.keys(store.readAuth()), ["openai"]);
  assert.ok(fs.existsSync(source));
});

test("provider updates preserve latest data and reject a stale refresh after same-token relogin", (t) => {
  const { store } = fixture(t);
  store.saveLogin("openai-codex", credential);
  const expected = store.readAuth()["openai-codex"];
  store.saveLogin("github-copilot", { ...credential, enterpriseUrl: "old.ghe.com", availableModelIds: ["old"] });
  store.saveLogin("github-copilot", credential);
  assert.equal(store.readAuth()["github-copilot"].enterpriseUrl, undefined);
  assert.equal(store.readAuth()["github-copilot"].availableModelIds, undefined);
  assert.equal(store.updateProvider("openai-codex", { access: "rotated" }, expected), true);
  assert.equal(store.readAuth()["github-copilot"].access, credential.access);
  store.saveLogin("openai-codex", { ...credential, access: "new-login" });
  assert.equal(store.updateProvider("openai-codex", { access: "stale" }, expected), false);
  const current = store.readAuth()["openai-codex"];
  assert.equal(current.access, "new-login");
  assert.notEqual(current.loginVersion, expected.loginVersion);
  assert.equal(current.loginAt, 100);
  assert.equal(store.updateProvider("openai-codex", { access: "stale" }, { ...current, refresh: "other" }), false);
  assert.deepEqual(fs.readdirSync(store.directory).sort(), ["auth.json"]);
});

test("reads tighten existing private store permissions without changing external import permissions", { skip: process.platform === "win32" }, (t) => {
  const { root, store, migrate } = fixture(t);
  const external = path.join(root, "external.json");
  fs.writeFileSync(external, JSON.stringify({ openai: credential }));
  fs.chmodSync(external, 0o644);
  migrate({ piAuthFile: external });
  assert.equal(fs.statSync(external).mode & 0o777, 0o644);
  fs.chmodSync(store.directory, 0o755);
  fs.chmodSync(store.authFile, 0o644);
  assert.equal(store.readAuth().openai.access, credential.access);
  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.authFile).mode & 0o777, 0o600);
});
