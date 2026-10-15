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
  const featureFile = path.join(directory, "features/gateway-features.json");
  const dependencies = { cli: true, python: { file: "/python3", launcher: false } };
  const installer = createProjectMemoryInstaller({ configRoot, bundleRoot, featureFile, probe: async () => dependencies, ...options });
  return { directory, configRoot, bundleRoot, target, featureFile, dependencies, installer };
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

test("an upstream-original clone or an older full-workflow install is a conflict and is never touched", async (t) => {
  for (const kind of ["clone", "older"]) {
    const f = fixture(t);
    fs.cpSync(f.bundleRoot, f.target, { recursive: true });
    if (kind === "clone") {
      fs.mkdirSync(path.join(f.target, ".git"));
      fs.unlinkSync(path.join(f.target, "LICENSE"));
      fs.unlinkSync(path.join(f.target, "SOURCE.md"));
    } else {
      for (const name of fs.readdirSync(f.target)) if (!["scripts", "references", "LICENSE", "SOURCE.md", "SKILL.md"].includes(name)) fs.rmSync(path.join(f.target, name), { recursive: true });
      fs.writeFileSync(path.join(f.target, "SKILL.md"), "older full-workflow skill");
    }
    const before = fs.readdirSync(f.target).sort();
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
    await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal((await f.installer.getStatus()).enabled, false);
    assert.deepEqual(fs.readdirSync(f.target).sort(), before);
  }
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
      await f.installer.install();
      fs.appendFileSync(path.join(f.target, "SKILL.md"), "keep");
    }
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.existsSync(f.target), true);
    if (kind === "modified") assert.ok(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8").endsWith("keep"));
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

test("an empty target appearing during the dependency probe or staging stays a conflict", async (t) => {
  for (const moment of ["probe", "stage"]) {
    const fsImpl = Object.create(fs);
    let f;
    const appear = () => fs.mkdirSync(f.target, { recursive: true });
    if (moment === "stage") fsImpl.writeFileSync = (file, ...args) => {
      fs.writeFileSync(file, ...args);
      if (file.endsWith("SOURCE.md")) appear();
    };
    f = fixture(t, { fsImpl, probe: async () => { if (moment === "probe") appear(); return { cli: true, python: true }; } });
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.deepEqual(fs.readdirSync(f.target), []);
    const privateRoot = path.join(f.configRoot, "claude-proxy");
    if (fs.existsSync(privateRoot)) assert.deepEqual(fs.readdirSync(privateRoot), []);
  }
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

test("uninstall removes only the exact deployed set through a private stage", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.installer.uninstall(), { ok: true, changed: false, ...await f.installer.getStatus() });
  await f.installer.install();
  const result = await f.installer.uninstall();
  assert.equal(result.changed, true);
  assert.equal(result.state, "absent");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
  for (const change of ["extra", "modified", "nested", "symlink"]) {
    await f.installer.install();
    if (change === "extra") fs.writeFileSync(path.join(f.target, "notes.txt"), "keep");
    else if (change === "modified") fs.appendFileSync(path.join(f.target, "scripts/pcm.py"), "# keep");
    else if (change === "nested") fs.mkdirSync(path.join(f.target, "scripts/__pycache__"));
    else if (process.platform !== "win32") fs.symlinkSync(f.bundleRoot, path.join(f.target, "link"));
    else continue;
    await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.existsSync(path.join(f.target, "SKILL.md")), true);
    assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["project-code-memory"]);
    fs.rmSync(f.target, { recursive: true });
  }
});

test("a target changed after the private rename is put back instead of removed", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  let renames = 0;
  fsImpl.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (path.basename(to).startsWith(".project-code-memory-remove-") && ++renames === 1) fs.writeFileSync(path.join(to, "late.txt"), "keep");
  };
  f = fixture(t, { fsImpl });
  await f.installer.install();
  await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.target, "late.txt"), "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["project-code-memory"]);
});

test("enabling checks dependencies even when installed, and the flag follows a successful install", async (t) => {
  let probes = 0;
  const f = fixture(t, { probe: async () => { probes++; return f.dependencies; } });
  assert.equal((await f.installer.getStatus()).enabled, false);
  f.dependencies.python = null;
  await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.existsSync(f.configRoot), false);
  assert.equal(fs.existsSync(f.featureFile), false);
  f.dependencies.python = { file: "/python3", launcher: false };
  const enabled = await f.installer.configure(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.installed, true);
  assert.equal(JSON.parse(fs.readFileSync(f.featureFile, "utf8")).projectMemory, true);
  f.dependencies.python = null;
  const before = probes;
  await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(probes, before + 1);
  f.dependencies.python = { file: "/python3", launcher: false };
  assert.equal((await f.installer.configure(true)).changed, false);
});

test("disabling clears the flag first, removes our skill, and leaves a changed skill in place", async (t) => {
  const f = fixture(t);
  await f.installer.configure(true);
  const disabled = await f.installer.configure(false);
  assert.deepEqual([disabled.enabled, disabled.changed, disabled.installed], [false, true, false]);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal((await f.installer.getStatus()).enabled, false);
  await f.installer.configure(true);
  fs.appendFileSync(path.join(f.target, "SKILL.md"), "user note");
  await assert.rejects(f.installer.configure(false), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(JSON.parse(fs.readFileSync(f.featureFile, "utf8")).projectMemory, false);
  assert.ok(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8").endsWith("user note"));
  const status = await f.installer.getStatus();
  assert.deepEqual([status.enabled, status.state], [false, "conflict"]);
});

test("the enabled flag in status is read fresh while file checks stay cached", async (t) => {
  let clock = 0;
  const f = fixture(t, { now: () => clock });
  assert.equal((await f.installer.getStatus()).enabled, false);
  fs.mkdirSync(path.dirname(f.featureFile));
  fs.writeFileSync(f.featureFile, JSON.stringify({ version: 1, projectMemory: true }));
  assert.equal((await f.installer.getStatus()).enabled, true);
  fs.writeFileSync(f.featureFile, "{broken");
  assert.equal((await f.installer.getStatus()).enabled, false);
});

test("autoEnable installs and turns on only when the user never chose and installation is possible", async (t) => {
  const f = fixture(t);
  const result = await f.installer.autoEnable();
  assert.deepEqual([result.enabled, result.changed, result.installed], [true, true, true]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.featureFile, "utf8")), { version: 1, projectMemory: true });
  assert.equal(await f.installer.autoEnable(), null);
  await f.installer.configure(false);
  assert.equal(await f.installer.autoEnable(), null);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(JSON.parse(fs.readFileSync(f.featureFile, "utf8")).projectMemory, false);

  const existing = fixture(t, { probe: async () => existing.dependencies });
  await existing.installer.install();
  fs.mkdirSync(path.dirname(existing.featureFile));
  fs.writeFileSync(existing.featureFile, JSON.stringify({ version: 1, onlineSummary: false }));
  assert.equal((await existing.installer.autoEnable()).changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(existing.featureFile, "utf8")), { version: 1, onlineSummary: false, projectMemory: true });
});

test("autoEnable writes nothing without dependencies, over a conflicting skill or with a malformed configuration", async (t) => {
  const missing = fixture(t);
  missing.dependencies.python = null;
  await assert.rejects(missing.installer.autoEnable(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.existsSync(missing.configRoot), false);
  assert.equal(fs.existsSync(missing.featureFile), false);
  const status = await missing.installer.getStatus();
  assert.deepEqual([status.enabled, status.ready, status.state], [false, false, "unavailable"]);

  const conflict = fixture(t);
  fs.mkdirSync(conflict.target, { recursive: true });
  fs.writeFileSync(path.join(conflict.target, "SKILL.md"), "full workflow");
  await assert.rejects(conflict.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.deepEqual(fs.readdirSync(conflict.target), ["SKILL.md"]);
  assert.equal(fs.existsSync(conflict.featureFile), false);

  const malformed = fixture(t);
  fs.mkdirSync(path.dirname(malformed.featureFile));
  fs.writeFileSync(malformed.featureFile, "{broken");
  assert.equal(await malformed.installer.autoEnable(), null);
  assert.equal(fs.readFileSync(malformed.featureFile, "utf8"), "{broken");
  assert.equal(fs.existsSync(malformed.configRoot), false);
});
