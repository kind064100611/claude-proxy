const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProjectMemoryInstaller, INSTALL_FILES } = require("../lib/project-memory-install");

function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcm-install-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configRoot = path.join(directory, "cli");
  const bundleRoot = path.join(directory, "bundle");
  fs.cpSync(path.join(__dirname, "../project-code-memory"), bundleRoot, { recursive: true });
  const target = path.join(configRoot, "skills/project-code-memory");
  const dependencies = { cli: true, python: { file: "/python3", launcher: false } };
  const installer = createProjectMemoryInstaller({ configRoot, bundleRoot, probe: async () => dependencies, ...options });
  return { directory, configRoot, bundleRoot, target, dependencies, installer };
}

test("status/factory are read-only, private install is complete and repeated installs do not write", async (t) => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.configRoot), false);
  assert.equal((await f.installer.getStatus()).state, "absent");
  assert.equal(fs.existsSync(f.configRoot), false);
  const result = await f.installer.install();
  assert.equal(result.changed, true);
  for (const relative of INSTALL_FILES) {
    const file = path.join(f.target, relative);
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(f.bundleRoot, relative)));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  if (process.platform !== "win32") assert.equal(fs.statSync(f.target).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["project-code-memory"]);
  assert.deepEqual(fs.readdirSync(path.join(f.configRoot, "claude-proxy")), []);
  assert.equal(fs.existsSync(path.join(f.configRoot, "settings.json")), false);
  assert.equal((await f.installer.getStatus()).state, "installed");
  const before = fs.statSync(path.join(f.target, "SKILL.md"));
  f.dependencies.cli = false; f.dependencies.python = null;
  assert.equal((await f.installer.install()).changed, false);
  assert.equal(fs.statSync(path.join(f.target, "SKILL.md")).mtimeMs, before.mtimeMs);
});

test("full pinned original clone is no-op and preserves .git, cache and directory modes", async (t) => {
  const f = fixture(t, { probe: async () => { throw new Error("must not probe a no-op"); } });
  fs.cpSync(f.bundleRoot, f.target, { recursive: true });
  // Reconstruct the three documented text-only adaptations without consulting a personal installation.
  const original = fs.readFileSync(path.join(f.bundleRoot, "SKILL.md"), "utf8")
    .replace(" This is model-driven guidance, not an automatically installed hook.", "")
    .replace("python3 -I -B \"<absolute-skill-dir>/scripts/pcm.py\"", "python3 <skill-dir>/scripts/pcm.py")
    .replace(/Use Python 3\.9 or newer\.[^\n]*\n\n/, "")
    .replace("when absent, creating the target `projectCodeMemory/` cache,", "when absent,");
  const manifest = JSON.parse(fs.readFileSync(path.join(f.bundleRoot, "manifest.json")));
  assert.equal(require("crypto").createHash("sha256").update(original).digest("hex"), manifest.upstreamFiles["SKILL.md"]);
  fs.writeFileSync(path.join(f.target, "SKILL.md"), original);
  fs.mkdirSync(path.join(f.target, ".git"));
  fs.mkdirSync(path.join(f.target, "projectCodeMemory"));
  fs.writeFileSync(path.join(f.target, "projectCodeMemory/preserve"), "personal cache");
  fs.unlinkSync(path.join(f.target, "LICENSE"));
  fs.unlinkSync(path.join(f.target, "SOURCE.md"));
  const mode = fs.statSync(f.target).mode;
  assert.equal((await f.installer.getStatus()).installed, true);
  assert.equal((await f.installer.install()).changed, false);
  assert.equal(fs.statSync(f.target).mode, mode);
  assert.equal(fs.readFileSync(path.join(f.target, "projectCodeMemory/preserve"), "utf8"), "personal cache");
  assert.equal(fs.existsSync(path.join(f.target, ".git")), true);
});

test("missing dependencies, failed probe and damaged bundle cannot create user directories", async (t) => {
  for (const probe of [async () => ({ cli: false, python: true }), async () => ({ cli: true, python: null }), async () => { throw new Error("private output"); }]) {
    const f = fixture(t, { probe });
    assert.equal((await f.installer.getStatus()).ready, false);
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
    assert.equal(fs.existsSync(f.configRoot), false);
  }
  const f = fixture(t);
  fs.appendFileSync(path.join(f.bundleRoot, "scripts/pcm.py"), "damaged");
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.existsSync(f.configRoot), false);
});

test("partial, modified and non-directory targets are preserved conflicts", async (t) => {
  for (const kind of ["partial", "modified", "file"]) {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    if (kind === "file") fs.writeFileSync(f.target, "keep");
    else if (kind === "partial") fs.mkdirSync(f.target);
    else {
      fs.cpSync(f.bundleRoot, f.target, { recursive: true });
      fs.appendFileSync(path.join(f.target, "references/record-format.md"), "keep");
    }
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.existsSync(f.target), true);
    if (kind === "modified") assert.ok(fs.readFileSync(path.join(f.target, "references/record-format.md"), "utf8").endsWith("keep"));
  }
});

test("status shares pending probes and caches briefly, install always rechecks dependencies", async (t) => {
  let calls = 0;
  let clock = 0;
  const f = fixture(t, { now: () => clock, probe: async () => { calls++; return { cli: true, python: true }; } });
  await Promise.all([f.installer.getStatus(), f.installer.getStatus()]);
  await f.installer.getStatus();
  assert.equal(calls, 1);
  clock = 3000;
  await f.installer.getStatus();
  assert.equal(calls, 2);
  await f.installer.install();
  assert.equal(calls, 3);
});

test("concurrent installs are serialized and only the first writes", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.installer.install(), f.installer.install()]);
  assert.deepEqual(results.map((result) => result.changed), [true, false]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["project-code-memory"]);
});

test("write failure removes the private stage and leaves no target", async (t) => {
  const fsImpl = Object.create(fs);
  fsImpl.writeFileSync = (file, ...rest) => {
    if (file.endsWith("SOURCE.md")) throw new Error("synthetic write failure");
    return fs.writeFileSync(file, ...rest);
  };
  const f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
  assert.deepEqual(fs.readdirSync(path.join(f.configRoot, "claude-proxy")), []);
});

test("a target created during staging is preserved as a conflict", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.renameSync = (from, to) => {
    fs.mkdirSync(path.join(f.target, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(f.target, "scripts/pcm.py"), "competing");
    return fs.renameSync(from, to);
  };
  f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.target, "scripts/pcm.py"), "utf8"), "competing");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["project-code-memory"]);
});

test("existing user directory mode and settings are untouched", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.configRoot, { mode: 0o755 });
  fs.writeFileSync(path.join(f.configRoot, "settings.json"), "broken settings");
  const mode = fs.statSync(f.configRoot).mode;
  await f.installer.install();
  assert.equal(fs.statSync(f.configRoot).mode, mode);
  assert.equal(fs.readFileSync(path.join(f.configRoot, "settings.json"), "utf8"), "broken settings");
});
