const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createObservationPack, getFeatureConfigPath, migrateFeatureConfig, getStatus, THRESHOLD_BYTES } = require("../lib/observation-pack");

const large = "BEGIN\n" + "exact archived line\n".repeat(1800) + "END\n";
const readTool = { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } };
const initial = (session = "test-session") => ({ model: "gpt-6.1-sol", metadata: { user_id: session },
  tools: [readTool], system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Test" }] });
function addResult(body, id, text = large, options = {}) {
  return { ...body, messages: [...body.messages,
    { role: "assistant", content: [{ type: "thinking", thinking: "public summary", signature: "opaque-signature" },
      { type: "tool_use", id, name: "Read", input: { file_path: "/source.txt" }, ...(options.call || {}) }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id,
      content: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } }], ...(options.result || {}) }] }] };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observation-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveRoot = path.join(root, "gateway-observations");
  const warnings = [];
  const toggle = (enabled) => fs.writeFileSync(path.join(root, "gateway-features.json"), JSON.stringify({ version: 1, observationPack: enabled }));
  toggle(true);
  const create = () => createObservationPack({ configFile: path.join(root, "gateway-features.json"), archiveRoot, onWarning: (event) => warnings.push(event) });
  return { root, archiveRoot, create, toggle, warnings, pack: create() };
}
const lastText = (body) => body.messages.at(-1).content[0].content[0].text;
const archiveFile = (text) => JSON.parse(text.match(/file_path=("(?:[^"\\]|\\.)*")/)[1]);

function featureFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "feature-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacyFile = path.join(home, "legacy", "gateway-features.json");
  fs.mkdirSync(path.dirname(legacyFile));
  return { home, legacyFile, filename: getFeatureConfigPath(home),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, "other-cli-root") } };
}

test("default feature toggle and CLI use user HOME, not repository, cwd or CLAUDE_CONFIG_DIR; reads never create files", (t) => {
  const { home, filename, env } = featureFixture(t);
  const modulePath = path.resolve(__dirname, "../lib/observation-pack");
  const scriptPath = path.resolve(__dirname, "../scripts/toggle-observation-pack.js");
  const read = () => JSON.parse(execFileSync(process.execPath, ["-e", `const p = require(${JSON.stringify(modulePath)}); console.log(JSON.stringify({file:p.getFeatureConfigPath(),status:p.createObservationPack().getStatus()}));`], { cwd: home, env, encoding: "utf8" }));
  assert.deepEqual(read(), { file: filename, status: { observationPack: true } });
  execFileSync(process.execPath, [scriptPath, "status"], { cwd: home, env });
  assert.equal(fs.existsSync(path.dirname(filename)), false);
  const disabled = execFileSync(process.execPath, [scriptPath, "off"], { cwd: home, env, encoding: "utf8" });
  assert.match(disabled, /Observation Pack: OFF/);
  assert.equal(read().status.observationPack, false);
  assert.equal(fs.existsSync(path.join(home, "gateway-features.json")), false);
  assert.equal(fs.existsSync(env.CLAUDE_CONFIG_DIR), false);
  execFileSync(process.execPath, [scriptPath, "on"], { cwd: home, env });
  assert.equal(read().status.observationPack, true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ["gateway-features.json"]);
});

test("explicit startup migration preserves original bytes and OFF state, is idempotent, and never overrides existing user settings", (t) => {
  const { home, legacyFile, filename } = featureFixture(t);
  const bytes = Buffer.from('{ "version": 1, "observationPack": false, "futureOption": "retained" }\n');
  fs.writeFileSync(legacyFile, bytes);
  assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: true });
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.deepEqual(fs.readFileSync(legacyFile), bytes);
  assert.equal(getStatus(filename).observationPack, false);
  fs.writeFileSync(legacyFile, '{"version":1,"observationPack":true}');
  assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: false });
  assert.deepEqual(fs.readFileSync(filename), bytes);
  fs.writeFileSync(filename, "broken user configuration");
  assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: false });
  assert.equal(fs.readFileSync(filename, "utf8"), "broken user configuration");
  assert.equal(getStatus(filename).observationPack, false);
  if (process.platform !== "win32") assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test("feature migration never overwrites a user file created concurrently during publication", (t) => {
  const { home, legacyFile, filename } = featureFixture(t);
  fs.writeFileSync(legacyFile, '{"version":1,"observationPack":false}');
  const external = '{"version":1,"observationPack":true,"createdBy":"other-process"}';
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = (source, target) => {
      assert.equal(target, filename);
      fs.writeFileSync(target, external, { flag: "wx" });
      return originalLink(source, target);
    };
    assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: false });
  } finally { fs.linkSync = originalLink; }
  assert.equal(fs.readFileSync(filename, "utf8"), external);
  assert.deepEqual(fs.readdirSync(path.dirname(filename)), ["gateway-features.json"]);
});

test("missing or malformed legacy feature toggle is not imported and module creation/status remain side-effect free", (t) => {
  const { home, legacyFile, filename } = featureFixture(t);
  assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: false });
  for (const bytes of ["{broken", '{"version":2,"observationPack":false}', '{"version":1,"observationPack":"false"}', "null", "x".repeat(65537)]) {
    fs.writeFileSync(legacyFile, bytes);
    const result = migrateFeatureConfig({ home, legacyFile });
    assert.equal(result.migrated, false);
    assert.match(result.warning, /migration was not completed/);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(fs.existsSync(path.dirname(filename)), false);
  }
  const pack = createObservationPack({ configFile: filename, archiveRoot: path.join(home, "archives") });
  assert.equal(pack.getStatus().observationPack, true);
  assert.equal(fs.existsSync(path.join(home, "archives")), false);
});

test("feature migration and toggle writes refuse symlink targets/directories without modifying external files", { skip: process.platform === "win32" }, (t) => {
  const { home, legacyFile, filename, env } = featureFixture(t);
  const outside = path.join(home, "outside.json");
  const original = '{"version":1,"observationPack":true}';
  fs.writeFileSync(outside, original);
  fs.writeFileSync(legacyFile, '{"version":1,"observationPack":false}');
  fs.mkdirSync(path.dirname(filename));
  fs.symlinkSync(outside, filename);
  assert.deepEqual(migrateFeatureConfig({ home, legacyFile }), { migrated: false });
  assert.equal(getStatus(filename).observationPack, false);
  const script = path.resolve(__dirname, "../scripts/toggle-observation-pack.js");
  assert.throws(() => execFileSync(process.execPath, [script, "off"], { env, stdio: "pipe" }));
  assert.equal(fs.readFileSync(outside, "utf8"), original);
  fs.unlinkSync(filename);
  fs.rmdirSync(path.dirname(filename));
  const outsideDirectory = path.join(home, "outside-directory");
  fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory, path.dirname(filename));
  assert.equal(migrateFeatureConfig({ home, legacyFile }).migrated, false);
  assert.throws(() => execFileSync(process.execPath, [script, "on"], { env, stdio: "pipe" }));
  assert.deepEqual(fs.readdirSync(outsideDirectory), []);
});

test("symlink legacy source is never imported", { skip: process.platform === "win32" }, (t) => {
  const { home, legacyFile, filename } = featureFixture(t);
  const target = path.join(home, "external-source.json");
  fs.writeFileSync(target, '{"version":1,"observationPack":false}');
  fs.symlinkSync(target, legacyFile);
  assert.equal(migrateFeatureConfig({ home, legacyFile }).migrated, false);
  assert.equal(fs.existsSync(filename), false);
});

test("new results are archived exactly; schema, signatures, markers and input objects stay unchanged", (t) => {
  const { pack } = fixture(t);
  const first = initial();
  assert.strictEqual(pack.prepare(first).body, first);
  const body = addResult(first, "call_one");
  const snapshot = JSON.stringify(body);
  const prepared = pack.prepare(body);
  assert.equal(prepared.stats.packed_results, 1);
  assert.ok(prepared.stats.avoided_bytes > THRESHOLD_BYTES);
  const view = lastText(prepared.body);
  assert.ok(view.includes("Middle omitted"));
  const filename = archiveFile(view);
  assert.equal(fs.readFileSync(filename, "utf8"), large);
  assert.equal(JSON.stringify(body), snapshot);
  assert.strictEqual(prepared.body.tools, body.tools);
  assert.strictEqual(prepared.body.system, body.system);
  assert.strictEqual(prepared.body.messages[1], body.messages[1]);
  assert.deepEqual(prepared.body.messages[2].content[0].content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);
  }
});

test("all model families share stable projections across retries, restart and toggle changes", (t) => {
  const { pack, create, toggle } = fixture(t);
  const first = initial();
  pack.prepare(first);
  const one = addResult(first, "call_one");
  const view = lastText(pack.prepare(one).body);
  for (const model of ["gpt-6.1-sol", "claude-sonnet-5.5", "z-ai/glm5"]) {
    assert.equal(lastText(create().prepare({ ...one, model }).body), view);
  }
  toggle(false);
  const two = addResult(one, "call_two");
  const disabled = create().prepare(two);
  assert.equal(disabled.stats.enabled, false);
  assert.equal(disabled.body.messages[2].content[0].content[0].text, view);
  assert.equal(lastText(disabled.body), large);
  toggle(true);
  const three = addResult(two, "call_three");
  const enabled = create().prepare(three);
  assert.equal(enabled.body.messages[4].content[0].content[0].text, large);
  assert.notEqual(lastText(enabled.body), large);
  assert.deepEqual(enabled.body.messages.slice(0, disabled.body.messages.length), disabled.body.messages);
});

test("trailing system messages after the newest result do not block packing", (t) => {
  const { pack } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const one = addResult(base, "call_one");
  const reminder = { role: "system", content: [{ type: "text", text: "reminder" }] };
  const body = { ...one, messages: [...one.messages, reminder] };
  const prepared = pack.prepare(body);
  assert.equal(prepared.stats.packed_results, 1);
  assert.ok(prepared.body.messages.at(-2).content[0].content[0].text.includes("Middle omitted"));
  assert.strictEqual(prepared.body.messages.at(-1), reminder);
});

test("initial history and previously unseen older results are never retroactively packed", (t) => {
  const { pack } = fixture(t);
  const warm = addResult(initial(), "old_call");
  assert.strictEqual(pack.prepare(warm).body, warm);
  const past = addResult(warm, "previously_unseen_old");
  const fresh = addResult(past, "new_call");
  const output = pack.prepare(fresh).body;
  assert.equal(output.messages[2].content[0].content[0].text, large);
  assert.equal(output.messages[4].content[0].content[0].text, large);
  assert.notEqual(lastText(output), large);
});

test("native archive recalls, errors, small output, mixed content and absent Read/session fail safe", (t) => {
  const { pack, archiveRoot } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const cases = [
    addResult(base, "small", "small"),
    addResult(base, "error", large, { result: { is_error: true } }),
    addResult(base, "mixed", large, { result: { content: [{ type: "text", text: large }, { type: "image", source: {} }] } }),
    addResult(base, "recall", large, { call: { input: { file_path: path.join(archiveRoot, "archive.txt") } } }),
    { ...addResult(base, "no_read"), tools: [] },
    { ...addResult(base, "no_session"), metadata: {} },
    addResult(base, "extra_blocks", large, { result: { content: [{ type: "text", text: large }, { type: "text", text: "extra" }] } })
  ];
  for (const body of cases) assert.strictEqual(pack.prepare(body).body, body);
});

test("string results and read-only token counts preserve pinned state without advancing it", (t) => {
  const { pack } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const body = addResult(base, "string", large, { result: { content: large } });
  assert.strictEqual(pack.prepare(body, { readOnly: true }).body, body);
  const view = pack.prepare(body).body.messages.at(-1).content[0].content;
  assert.equal(typeof view, "string");
  assert.equal(pack.prepare(body, { readOnly: true }).body.messages.at(-1).content[0].content, view);
});

test("session and content isolation; duplicate old results cannot alter the prefix", (t) => {
  const { pack } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const first = addResult(base, "same_id");
  const view = lastText(pack.prepare(first).body);
  const other = { ...first, metadata: { user_id: "other_session" } };
  assert.strictEqual(pack.prepare(other).body, other);
  const changed = addResult(base, "same_id", large + "edited");
  assert.notEqual(lastText(pack.prepare(changed).body), view);
  const duplicate = addResult(addResult(first, "duplicate"), "duplicate");
  const result = pack.prepare(duplicate).body;
  assert.equal(result.messages[4].content[0].content[0].text, large);
  assert.equal(lastText(result), large);
});

test("interrupted writes freeze new packing while preserving existing projections and privacy", (t) => {
  const { pack, create, warnings } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const first = addResult(base, "one");
  const packed = pack.prepare(first);
  const file = archiveFile(lastText(packed.body));
  fs.writeFileSync(path.join(path.dirname(file), "pending"), "interrupted");
  const next = addResult(first, "two");
  const output = create().prepare(next).body;
  assert.deepEqual(output.messages.slice(0, packed.body.messages.length), packed.body.messages);
  assert.equal(lastText(output), large);
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((warning) => Object.keys(warning).join() === "code"));
});

test("append failures fail open, but unreadable existing ledgers never rewrite history", (t) => {
  const { pack, create, warnings } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const first = addResult(base, "one");
  const packed = pack.prepare(first);
  const directory = path.dirname(archiveFile(lastText(packed.body)));
  const second = addResult(first, "two", large + "new bytes");
  const crypto = require("crypto");
  const filename = crypto.createHash("sha256").update(large + "new bytes").digest("hex") + ".txt";
  fs.mkdirSync(path.join(directory, filename));
  const output = pack.prepare(second).body;
  assert.equal(lastText(output), large + "new bytes");
  assert.deepEqual(output.messages.slice(0, packed.body.messages.length), packed.body.messages);
  assert.ok(fs.existsSync(path.join(directory, "pending")));
  assert.ok(warnings.some((warning) => warning.code === "observation_archive_append_failed"));
  fs.writeFileSync(path.join(directory, "state.json"), "{broken");
  assert.throws(() => create().prepare(second), (error) => error.status === 503);
});

test("malformed configuration disables new packing without removing existing views", (t) => {
  const { pack, root } = fixture(t);
  const base = initial();
  pack.prepare(base);
  const one = addResult(base, "one");
  const packed = pack.prepare(one).body;
  fs.writeFileSync(path.join(root, "gateway-features.json"), "{broken");
  assert.equal(pack.getStatus().observationPack, false);
  assert.deepEqual(pack.prepare(one).body, packed);
  assert.equal(lastText(pack.prepare(addResult(one, "two")).body), large);
});
