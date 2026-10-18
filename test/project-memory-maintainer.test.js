const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");
const { createProjectMemoryMaintainer } = require("../lib/project-memory-maintainer");
const { createSetupProbe } = require("../lib/claude-probes");

const pcm = path.resolve(__dirname, "../project-code-memory/scripts/pcm.py");
const query = path.resolve(__dirname, "../project-code-memory/scripts/query.py");
let python = null;
test.before(async () => {
  const dependencies = await createSetupProbe({ includePython: true })();
  if (dependencies.python) {
    const { file, launcher } = dependencies.python;
    python = execFileSync(file, [...(launcher ? ["-3"] : []), "-I", "-B", "-c", "import sys; print(sys.executable)"],
      { encoding: "utf8", timeout: 1800, windowsHide: true }).trim();
  }
});
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function repository(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcm-maintainer-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/auth.js"), "function authenticate(user) {\n  return SessionStore.create(user);\n}\n");
  fs.writeFileSync(path.join(root, "src/store.js"), "class SessionStore {\n  static create(user) { return { user }; }\n}\n");
  return root;
}
// Seeds records through pcm's own CLI, as the main model's old workflow did.
function seed(root, draft) {
  execFileSync(python, ["-I", "-B", pcm, "init", "--root", root]);
  const file = path.join(root, "projectCodeMemory/drafts", `${draft.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ keywords: ["auth"], summary: "Seeded topic", facts: ["seeded fact"], verification: ["seeded"], ...draft }));
  execFileSync(python, ["-I", "-B", pcm, "save", "--root", root, file]);
}
const record = (root, id) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, "projectCodeMemory/records", `${id}.json`), "utf8")); } catch (_) { return null; }
};
const draft = (fields) => ({ keywords: ["auth", "login"], summary: "Authentication creates sessions", facts: ["authenticate delegates to SessionStore.create"], ...fields });

function maintainer(reply, options = {}) {
  const calls = [];
  const events = [];
  const warnings = [];
  const complete = options.complete || (async (request) => {
    calls.push(request);
    return reply === null ? null : { model: "gpt-test-luna", text: typeof reply === "string" ? reply : JSON.stringify(reply) };
  });
  const instance = createProjectMemoryMaintainer({ complete, findPython: async () => ({ file: python, launcher: false }),
    onEvent: (event) => events.push(event), onWarning: (warning) => warnings.push(warning), now: () => new Date("2026-10-15T08:00:00Z"), ...options });
  return { ...instance, calls, events, warnings };
}

test("a stale record is refreshed under its id with gateway provenance and current fingerprints", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const m = maintainer({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate", "SessionStore"] })], delete: [] });
  const result = await m.enqueue({ root, changed_paths: [path.join(root, "src/auth.js")] });
  assert.deepEqual([result.saved, result.deleted, result.rejected, result.model], [1, 0, 0, "gpt-test-luna"]);
  const saved = record(root, "auth-flow");
  assert.deepEqual(saved.p, ["src/auth.js"]);
  assert.deepEqual(saved.s, ["authenticate", "SessionStore"]);
  assert.equal(saved.fp["src/auth.js"], sha(path.join(root, "src/auth.js")));
  assert.deepEqual(saved.verify, ["Gateway-maintained by gpt-test-luna from current source on 2026-10-15; not test-verified."]);
  assert.match(fs.readFileSync(path.join(root, "projectCodeMemory/index.tsv"), "utf8"), /^auth-flow\t/m);
  assert.deepEqual(fs.readdirSync(path.join(root, "projectCodeMemory/drafts")), []);
  const input = m.calls[0].input;
  assert.match(input, /"status":"stale"/);
  assert.match(input, /=== src\/auth\.js ===\n1: function authenticate\(user\) \{/);
  assert.match(m.calls[0].system, /Reply with JSON only/);
  assert.equal(m.calls[0].timeoutMs, 120000);
  assert.deepEqual(Object.keys(m.events[0]).sort(), ["deleted", "model", "ms", "project", "rejected", "saved"]);
});

test("a learned topic becomes a new record and an obsolete record is deleted", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "old-topic", paths: ["src/store.js"], keywords: ["legacy"] });
  const m = maintainer({ save: [draft({ id: "session-store", paths: ["src/store.js"], symbols: ["SessionStore"] })], delete: ["old-topic"] });
  const result = await m.enqueue({ root, changed_paths: [], obsolete: ["old-topic"],
    learned: [{ topic: "sessions", facts: ["SessionStore creates sessions"], paths: ["src/store.js"], symbols: ["SessionStore"] }] });
  assert.deepEqual([result.saved, result.deleted], [1, 1]);
  assert.equal(record(root, "old-topic"), null);
  assert.deepEqual(record(root, "session-store").s, ["SessionStore"]);
  assert.match(m.calls[0].input, /"reported_obsolete":true/);
  assert.match(m.calls[0].input, /SessionStore creates sessions/);
});

test("a read-only analysis refreshes the valid record that cites its learned files", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  seed(root, { id: "store-topic", paths: ["src/store.js"], keywords: ["store"] });
  const m = maintainer({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate", "SessionStore"] })], delete: [] });
  const result = await m.enqueue({ root, changed_paths: [],
    learned: [{ topic: "auth", facts: ["authenticate delegates to SessionStore.create"], paths: ["src/auth.js"], symbols: ["authenticate"] }] });
  assert.deepEqual([result.saved, result.deleted, result.rejected], [1, 0, 0]);
  assert.deepEqual(record(root, "auth-flow").s, ["authenticate", "SessionStore"]);
  assert.notEqual(record(root, "store-topic"), null);
  assert.match(m.calls[0].input, /Changed paths: \(none reported\)/);
  assert.match(m.calls[0].input, /Affected records:\n.*"id":"auth-flow"/);
  assert.match(m.calls[0].input, /Other existing record ids \(never reuse\): store-topic\n/);
});

test("a stale record the model neither refreshes nor deletes is deleted, and valid unrelated records stay", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "store-topic", paths: ["src/store.js"], keywords: ["store"] });
  seed(root, { id: "auth-topic", paths: ["src/auth.js"], keywords: ["auth"] });
  fs.appendFileSync(path.join(root, "src/store.js"), "// changed\n");
  const m = maintainer({ save: [], delete: ["auth-topic"] });
  const result = await m.enqueue({ root, changed_paths: ["src/store.js"] });
  assert.deepEqual([result.saved, result.deleted], [0, 1]);
  assert.equal(record(root, "store-topic"), null);
  assert.notEqual(record(root, "auth-topic"), null);
});

test("the skill's query keeps a stale record for the gateway to refresh and still prunes malformed ones", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  seed(root, { id: "broken", paths: ["src/store.js"], keywords: ["auth"] });
  fs.writeFileSync(path.join(root, "projectCodeMemory/records/broken.json"), "{not-json");
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const run = () => execFileSync(python, ["-I", "-B", query, "--root", root, "--limit", "1", "auth"], { encoding: "utf8" });
  const output = run();
  assert.match(output, /^STALE auth-flow src\/auth\.js:changed$/m);
  assert.match(output, /^PRUNED broken$/m);
  assert.doesNotMatch(output, /PRUNED auth-flow/);
  assert.equal(record(root, "broken"), null);
  assert.match(fs.readFileSync(path.join(root, "projectCodeMemory/index.tsv"), "utf8"), /^auth-flow\t/m);
  assert.match(run(), /^STALE auth-flow/m);
  assert.equal(fs.existsSync(path.join(path.dirname(query), "__pycache__")), false);
  const m = maintainer({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] })], delete: [] });
  assert.equal((await m.enqueue({ root, changed_paths: [] })).saved, 1);
  assert.match(run(), /^VALID auth-flow/m);
});

test("hallucinated symbols, uncited or outside paths, reused ids and excess new records are rejected, keeping the old record", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  seed(root, { id: "unrelated", paths: ["src/store.js"], keywords: ["store"] });
  fs.writeFileSync(path.join(path.dirname(root), "outside.js"), "authenticate");
  t.after(() => fs.rmSync(path.join(path.dirname(root), "outside.js"), { force: true }));
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const m = maintainer({ save: [
    draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate", "inventedHelper"] }),
    draft({ id: "outside", paths: ["../outside.js"] }),
    draft({ id: "uncited", paths: ["src/store.js"] }),
    draft({ id: "unrelated", paths: ["src/auth.js"] }),
    draft({ id: "Bad ID", paths: ["src/auth.js"] }),
    draft({ id: "no-facts", paths: ["src/auth.js"], facts: [] })
  ], delete: ["unrelated"] });
  const result = await m.enqueue({ root, changed_paths: ["src/auth.js", "../outside.js", "projectCodeMemory/index.tsv"] });
  assert.deepEqual([result.saved, result.deleted, result.rejected], [0, 0, 6]);
  // 被拒的刷新稿不会让原记录被当作“未刷新的过期记录”删掉。
  assert.equal(record(root, "auth-flow").sum, "Seeded topic");
  assert.equal(record(root, "unrelated").sum, "Seeded topic");
  assert.equal(record(root, "outside"), null);
  assert.doesNotMatch(m.calls[0].input, /outside\.js|index\.tsv/);
});

test("roots without an owned real cache directory are rejected before any model call", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  const m = maintainer({ save: [], delete: [] });
  assert.equal(await m.enqueue({ root, changed_paths: ["src/auth.js"] }), null);
  assert.equal(fs.existsSync(path.join(root, "projectCodeMemory")), false);
  assert.equal(await m.enqueue({ root: "relative/root", changed_paths: [] }), null);
  assert.equal(await m.enqueue({ root: path.join(root, "missing"), changed_paths: [] }), null);
  if (process.platform !== "win32") {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(root, "projectCodeMemory"));
    assert.equal(await m.enqueue({ root, changed_paths: ["src/auth.js"], learned: [{ topic: "x", facts: ["y"], paths: ["src/auth.js"] }] }), null);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  }
  assert.equal(m.calls.length, 0);
  assert.ok(m.warnings.length >= 3 && m.warnings.every((warning) => warning.code === "root_rejected"));
  assert.ok(!JSON.stringify(m.warnings).includes(root));
});

test("model failure or invalid output writes nothing, and .gitignore is never edited", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const before = fs.readFileSync(path.join(root, "projectCodeMemory/records/auth-flow.json"));
  for (const [reply, code] of [[null, "model_failed"], ["not json", "invalid_output"], ['{"save":{}}', "invalid_output"]]) {
    const m = maintainer(reply);
    assert.equal(await m.enqueue({ root, changed_paths: ["src/auth.js"] }), null);
    assert.deepEqual(m.warnings, [{ code, project: path.basename(root) }]);
    assert.deepEqual(fs.readFileSync(path.join(root, "projectCodeMemory/records/auth-flow.json")), before);
  }
  const m = maintainer({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] })] });
  assert.equal((await m.enqueue({ root, changed_paths: ["src/auth.js"] })).saved, 1);
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "node_modules/\n");
});

test("a file changed after the model saw it is not fingerprinted, and nothing to maintain skips the model", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const m = maintainer(undefined, { complete: async () => {
    fs.appendFileSync(path.join(root, "src/auth.js"), "// changed again\n");
    return { model: "gpt-test-luna", text: JSON.stringify({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] })] }) };
  } });
  const result = await m.enqueue({ root, changed_paths: ["src/auth.js"] });
  assert.deepEqual([result.saved, result.rejected], [0, 1]);
  assert.notEqual(record(root, "auth-flow").fp["src/auth.js"], sha(path.join(root, "src/auth.js")));
  const cleanup = maintainer({ save: [] });
  assert.deepEqual((await cleanup.enqueue({ root, changed_paths: ["src/store.js"] })).deleted, 1);
  assert.equal(record(root, "auth-flow"), null);
  const idle = maintainer({ save: [] });
  const skipped = await idle.enqueue({ root: path.join(root, "src", ".."), changed_paths: ["src/store.js"] });
  assert.deepEqual([skipped.model, skipped.saved, skipped.deleted], ["none", 0, 0]);
  assert.equal(idle.calls.length, 0);
});

test("jobs for one root run one at a time with isolated, shell-free Python", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  fs.appendFileSync(path.join(root, "src/auth.js"), "// changed\n");
  const executions = [];
  let release;
  let active = 0;
  let maxActive = 0;
  const m = maintainer(undefined, {
    execFileImpl: (file, args, options, callback) => { executions.push({ file, args, options }); return execFile(file, args, options, callback); },
    complete: async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (!release) await new Promise((resolve) => { release = resolve; });
      active--;
      return { model: "gpt-test-luna", text: JSON.stringify({ save: [draft({ id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] })] }) };
    } });
  const first = m.enqueue({ root, changed_paths: ["src/auth.js"] });
  const second = m.enqueue({ root, changed_paths: ["src/auth.js"] });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(maxActive, 1);
  assert.equal(results[0].saved, 1);
  assert.equal(results[1].saved, 1);
  for (const { file, args, options } of executions) {
    assert.equal(file, python);
    assert.deepEqual(args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, path.dirname(pcm));
    assert.ok(options.timeout > 0);
  }
  assert.equal(fs.existsSync(path.join(path.dirname(pcm), "__pycache__")), false);
});

test("a file the size of proxy.js can be cited, while files over 96 KB cannot", async (t) => {
  if (!python) return t.skip("Python 3.9+ is required");
  const root = repository(t);
  seed(root, { id: "auth-flow", paths: ["src/auth.js"], symbols: ["authenticate"] });
  const line = "// padding to grow the file beyond the old 64 KB evidence limit\n";
  fs.writeFileSync(path.join(root, "src/proxy.js"), "function routeRequest() {}\n" + line.repeat(Math.ceil(75 * 1024 / line.length)));
  fs.writeFileSync(path.join(root, "src/huge.js"), "function hugeHelper() {}\n" + line.repeat(Math.ceil(97 * 1024 / line.length)));
  const m = maintainer({ save: [draft({ id: "proxy-routing", paths: ["src/proxy.js"], symbols: ["routeRequest"] }),
    draft({ id: "huge-helper", paths: ["src/huge.js"], symbols: ["hugeHelper"] })] });
  const result = await m.enqueue({ root, changed_paths: ["src/proxy.js", "src/huge.js"],
    learned: [{ topic: "routing", facts: ["routeRequest routes requests"], paths: ["src/proxy.js", "src/huge.js"], symbols: ["routeRequest", "hugeHelper"] }] });
  assert.deepEqual([result.saved, result.rejected], [1, 1]);
  assert.deepEqual(record(root, "proxy-routing").p, ["src/proxy.js"]);
  assert.equal(record(root, "huge-helper"), null);
  assert.match(m.calls[0].input, /=== src\/proxy\.js ===/);
  assert.match(m.calls[0].input, /Files you must not cite: src\/huge\.js \(too large\)/);
});
