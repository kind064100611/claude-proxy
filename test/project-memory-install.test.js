const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
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

function registerPreviousDeployment(f, files, commit = "synthetic-previous-deployment") {
  const manifestFile = path.join(f.bundleRoot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const deployment = {
    commit,
    method: "test fixture",
    files: Object.fromEntries(Object.entries(files).map(([relative, contents]) => [
      relative, crypto.createHash("sha256").update(contents).digest("hex"),
    ])),
  };
  manifest.previousDeployments = [...(manifest.previousDeployments || []), deployment];
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(f.target, relative)), { recursive: true });
    fs.writeFileSync(path.join(f.target, relative), contents);
  }
  return deployment;
}

const syntheticPreviousFiles = {
  "SKILL.md": "old full-workflow skill",
  "SOURCE.md": "old source",
  "LICENSE": "license",
  "scripts/pcm.py": "print(1)",
  "references/record-format.md": "format",
};

function historicalTarget(f, commit, deployment) {
  const root = path.resolve(__dirname, "..");
  const files = {};
  for (const [relative, expectedHash] of Object.entries(deployment.files)) {
    const bytes = execFileSync("git", ["show", `${commit}:project-code-memory/${relative}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(actualHash, expectedHash, `${commit}:${relative}`);
    const destination = path.join(f.target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    files[relative] = bytes;
  }
  return files;
}

test("status/factory are read-only, private install is complete and repeated installs do not write", async (t) => {
  const f = fixture(t);
  assert.equal(fs.existsSync(f.configRoot), false);
  assert.equal((await f.installer.getStatus()).state, "absent");
  assert.equal(fs.existsSync(f.configRoot), false);
  const result = await f.installer.install();
  assert.equal(result.changed, true);
  assert.equal(result.replaced, false);
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

test("install, uninstall and autoEnable preserve unknown conflicts; explicit enable backs them up", async (t) => {
  for (const kind of ["clone", "older"]) {
    const f = fixture(t);
    fs.cpSync(f.bundleRoot, f.target, { recursive: true });
    if (kind === "clone") {
      fs.mkdirSync(path.join(f.target, ".git"));
      fs.writeFileSync(path.join(f.target, ".git/HEAD"), "ref: refs/heads/main\n");
      fs.unlinkSync(path.join(f.target, "LICENSE"));
      fs.unlinkSync(path.join(f.target, "SOURCE.md"));
    } else {
      for (const name of fs.readdirSync(f.target)) if (!["scripts", "references", "LICENSE", "SOURCE.md", "SKILL.md"].includes(name)) fs.rmSync(path.join(f.target, name), { recursive: true });
      fs.writeFileSync(path.join(f.target, "SKILL.md"), "older full-workflow skill");
      fs.writeFileSync(path.join(f.target, "notes.txt"), "user extra");
    }
    const before = fs.readdirSync(f.target).sort();
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
    await assert.rejects(f.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal((await f.installer.getStatus()).enabled, false);
    assert.deepEqual(fs.readdirSync(f.target).sort(), before);

    const enabled = await f.installer.configure(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.replaced, true);
    for (const relative of INSTALL_FILES) assert.deepEqual(fs.readFileSync(path.join(f.target, relative)), fs.readFileSync(path.join(f.bundleRoot, relative)));
    const backups = path.join(f.configRoot, "claude-proxy/skill-backups");
    const [backup] = fs.readdirSync(backups);
    assert.deepEqual(fs.readdirSync(path.join(backups, backup)).sort(), before);
    if (kind === "clone") assert.equal(fs.readFileSync(path.join(backups, backup, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
    else {
      assert.equal(fs.readFileSync(path.join(backups, backup, "SKILL.md"), "utf8"), "older full-workflow skill");
      assert.equal(fs.readFileSync(path.join(backups, backup, "notes.txt"), "utf8"), "user extra");
    }
    const cache = path.join(f.directory, "project/projectCodeMemory");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "index.json"), "keep project cache");
    await f.installer.configure(false);
    assert.equal(fs.existsSync(f.target), false);
    assert.deepEqual(fs.readdirSync(backups), [backup]);
    assert.equal(fs.readFileSync(path.join(cache, "index.json"), "utf8"), "keep project cache");
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

test("dependency and private-stage failures leave a conflicting skill and backup untouched", async (t) => {
  const missing = fixture(t, { probe: async () => ({ cli: true, python: null }) });
  fs.mkdirSync(missing.target, { recursive: true });
  fs.writeFileSync(path.join(missing.target, "SKILL.md"), "keep missing-dependency conflict");
  await assert.rejects(missing.installer.configure(true), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.readFileSync(path.join(missing.target, "SKILL.md"), "utf8"), "keep missing-dependency conflict");
  assert.equal(fs.existsSync(path.join(missing.configRoot, "claude-proxy/skill-backups")), false);
  assert.equal(fs.existsSync(missing.featureFile), false);

  const fsImpl = Object.create(fs);
  fsImpl.writeFileSync = (file, ...args) => {
    if (file.endsWith("SOURCE.md")) throw new Error("synthetic stage failure");
    return fs.writeFileSync(file, ...args);
  };
  const failed = fixture(t, { fsImpl });
  fs.mkdirSync(failed.target, { recursive: true });
  fs.writeFileSync(path.join(failed.target, "SKILL.md"), "keep stage-failure conflict");
  await assert.rejects(failed.installer.configure(true), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.readFileSync(path.join(failed.target, "SKILL.md"), "utf8"), "keep stage-failure conflict");
  assert.equal(fs.existsSync(path.join(failed.configRoot, "claude-proxy/skill-backups")), false);
  assert.equal(fs.existsSync(failed.featureFile), false);
});

test("unsafe backup parents never move a conflicting skill", async (t) => {
  for (const kind of ["proxy-link", "proxy-file", "backup-link", "backup-file"]) {
    if (kind.endsWith("-link") && process.platform === "win32") continue;
    const f = fixture(t);
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), `keep ${kind}`);
    fs.writeFileSync(path.join(f.target, "extra.txt"), "also keep");
    const privateRoot = path.join(f.configRoot, "claude-proxy");
    const backupRoot = path.join(privateRoot, "skill-backups");
    const external = path.join(f.directory, "external-backups");
    if (kind.startsWith("proxy-")) {
      if (kind === "proxy-link") {
        fs.mkdirSync(external);
        fs.symlinkSync(external, privateRoot);
      } else fs.writeFileSync(privateRoot, "not a directory");
    } else {
      fs.mkdirSync(privateRoot);
      if (kind === "backup-link") {
        fs.mkdirSync(external);
        fs.symlinkSync(external, backupRoot);
      } else fs.writeFileSync(backupRoot, "not a directory");
    }
    await assert.rejects(f.installer.configure(true));
    assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), `keep ${kind}`);
    assert.equal(fs.readFileSync(path.join(f.target, "extra.txt"), "utf8"), "also keep");
    if (fs.existsSync(external)) assert.deepEqual(fs.readdirSync(external), []);
    assert.equal(fs.existsSync(f.featureFile), false);
  }
});

test("explicit enable stages completely before backing up and moves a conflicting symlink itself", async (t) => {
  if (process.platform === "win32") return;
  const fsImpl = Object.create(fs);
  let f;
  let completeStageSawOriginal = false;
  fsImpl.writeFileSync = (file, ...args) => {
    if (path.basename(file) === "SKILL.md" && file.includes(".project-code-memory-stage-")) {
      completeStageSawOriginal = fs.lstatSync(f.target).isSymbolicLink();
      assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "external skill");
    }
    return fs.writeFileSync(file, ...args);
  };
  f = fixture(t, { fsImpl });
  const external = path.join(f.directory, "external-skill");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "SKILL.md"), "external skill");
  fs.mkdirSync(path.dirname(f.target), { recursive: true });
  fs.symlinkSync(external, f.target);
  const result = await f.installer.configure(true);
  assert.equal(result.replaced, true);
  assert.equal(completeStageSawOriginal, true);
  const backups = path.join(f.configRoot, "claude-proxy/skill-backups");
  const [backup] = fs.readdirSync(backups);
  const savedLink = path.join(backups, backup);
  assert.equal(fs.lstatSync(savedLink).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(savedLink), external);
  assert.deepEqual(fs.readdirSync(external), ["SKILL.md"]);
  assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8"), "external skill");
});

test("failed publication restores its backup unless even an empty target has appeared", async (t) => {
  for (const occupied of [false, true]) {
    const fsImpl = Object.create(fs);
    let f;
    fsImpl.renameSync = (from, to) => {
      if (path.basename(from).startsWith(".project-code-memory-stage-") && to === f.target) {
        if (occupied) fs.mkdirSync(f.target);
        throw Object.assign(new Error("synthetic publish failure"), { code: "EIO" });
      }
      return fs.renameSync(from, to);
    };
    f = fixture(t, { fsImpl });
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), "previous user skill");
    fs.writeFileSync(path.join(f.target, "extra.txt"), "preserve me");
    await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_UNAVAILABLE" });
    const backups = path.join(f.configRoot, "claude-proxy/skill-backups");
    if (occupied) {
      assert.deepEqual(fs.readdirSync(f.target), []);
      const [backup] = fs.readdirSync(backups);
      assert.equal(fs.readFileSync(path.join(backups, backup, "SKILL.md"), "utf8"), "previous user skill");
      assert.equal(fs.readFileSync(path.join(backups, backup, "extra.txt"), "utf8"), "preserve me");
    } else {
      assert.deepEqual(fs.readdirSync(f.target).sort(), ["SKILL.md", "extra.txt"]);
      assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "previous user skill");
      assert.equal(fs.readFileSync(path.join(f.target, "extra.txt"), "utf8"), "preserve me");
      assert.deepEqual(fs.readdirSync(backups), []);
    }
    assert.equal(fs.existsSync(f.featureFile), false);
  }
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

test("autoEnable backs up only an exact registered previous deployment", async (t) => {
  const f = fixture(t);
  registerPreviousDeployment(f, syntheticPreviousFiles);
  const result = await f.installer.autoEnable();
  assert.deepEqual([result.enabled, result.replaced, result.installed], [true, true, true]);
  assert.equal(JSON.parse(fs.readFileSync(f.featureFile, "utf8")).projectMemory, true);
  const backups = path.join(f.configRoot, "claude-proxy/skill-backups");
  const [backup] = fs.readdirSync(backups);
  for (const [relative, contents] of Object.entries(syntheticPreviousFiles)) {
    assert.equal(fs.readFileSync(path.join(backups, backup, relative), "utf8"), contents, relative);
  }

  for (const change of ["modified", "extra file", "extra directory", "turned off"]) {
    const changed = fixture(t);
    registerPreviousDeployment(changed, syntheticPreviousFiles);
    if (change === "modified") fs.appendFileSync(path.join(changed.target, "SKILL.md"), " with user text");
    else if (change === "extra file") fs.writeFileSync(path.join(changed.target, "notes.md"), "keep");
    else if (change === "extra directory") fs.mkdirSync(path.join(changed.target, "projectCodeMemory"));
    else {
      fs.mkdirSync(path.dirname(changed.featureFile));
      fs.writeFileSync(changed.featureFile, JSON.stringify({ version: 1, projectMemory: false }));
    }
    const before = fs.readFileSync(path.join(changed.target, "SKILL.md"), "utf8");
    if (change === "turned off") assert.equal(await changed.installer.autoEnable(), null);
    else await assert.rejects(changed.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.readFileSync(path.join(changed.target, "SKILL.md"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(changed.configRoot, "claude-proxy/skill-backups")), false);
  }
});

test("autoEnable upgrades real historical button and whole-bundle targets from git blobs", async (t) => {
  const cases = [
    {
      revision: "f3fab02",
      deployment: (entry) => entry.commit === "ece898a" && entry.method === "install button",
    },
    {
      revision: "530542c^",
      deployment: (entry) => entry.commit === "f3fab02" && /whole claude-proxy bundle/.test(entry.method),
    },
  ];
  for (const item of cases) {
    const f = fixture(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.bundleRoot, "manifest.json"), "utf8"));
    const deployment = manifest.previousDeployments.find(item.deployment);
    assert.ok(deployment, `missing manifest entry for ${item.revision}`);
    const originals = historicalTarget(f, item.revision, deployment);
    const result = await f.installer.autoEnable();
    assert.deepEqual([result.enabled, result.replaced, result.installed], [true, true, true]);
    const backups = path.join(f.configRoot, "claude-proxy/skill-backups");
    const [backup] = fs.readdirSync(backups);
    for (const [relative, bytes] of Object.entries(originals)) {
      assert.deepEqual(fs.readFileSync(path.join(backups, backup, relative)), bytes, `${item.revision}:${relative}`);
    }
    for (const relative of INSTALL_FILES) {
      assert.deepEqual(fs.readFileSync(path.join(f.target, relative)), fs.readFileSync(path.join(f.bundleRoot, relative)));
    }
  }
});

test("explicit enable never backs up a new target created during probe or staging", async (t) => {
  for (const moment of ["probe", "stage"]) {
    const fsImpl = Object.create(fs);
    let f;
    const appear = () => {
      fs.mkdirSync(path.dirname(f.target), { recursive: true });
      fs.mkdirSync(f.target);
    };
    if (moment === "stage") fsImpl.writeFileSync = (file, ...args) => {
      fs.writeFileSync(file, ...args);
      if (file.endsWith("SOURCE.md")) appear();
    };
    f = fixture(t, {
      fsImpl,
      probe: async () => { if (moment === "probe") appear(); return { cli: true, python: true }; },
    });
    await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.deepEqual(fs.readdirSync(f.target), []);
    assert.equal(fs.existsSync(path.join(f.configRoot, "claude-proxy/skill-backups")), false);
    assert.equal(fs.existsSync(f.featureFile), false);
  }
});

test("replacement preserves a different target that takes the original skill's place", async (t) => {
  for (const operation of ["configure", "autoEnable"]) {
    for (const moment of ["probe", "stage"]) {
      const fsImpl = Object.create(fs);
      let f;
      const moved = () => path.join(f.directory, "externally-moved-skill");
      const replaceTarget = () => { fs.renameSync(f.target, moved()); fs.mkdirSync(f.target); };
      if (moment === "stage") fsImpl.writeFileSync = (file, ...args) => {
        fs.writeFileSync(file, ...args);
        if (file.endsWith("SOURCE.md")) replaceTarget();
      };
      f = fixture(t, { fsImpl, probe: async () => {
        if (moment === "probe") replaceTarget();
        return { cli: true, python: true };
      } });
      registerPreviousDeployment(f, syntheticPreviousFiles);
      await assert.rejects(operation === "configure" ? f.installer.configure(true) : f.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
      assert.deepEqual(fs.readdirSync(f.target), []);
      assert.equal(fs.readFileSync(path.join(moved(), "SKILL.md"), "utf8"), syntheticPreviousFiles["SKILL.md"]);
      assert.equal(fs.existsSync(path.join(f.configRoot, "claude-proxy/skill-backups")), false);
      assert.equal(fs.existsSync(f.featureFile), false);
    }
  }
});

test("automatic upgrade revalidates previous-deployment bytes after probe and staging", async (t) => {
  for (const moment of ["probe", "stage"]) {
    const fsImpl = Object.create(fs);
    let f;
    const mutate = () => fs.appendFileSync(path.join(f.target, "SKILL.md"), " external edit");
    if (moment === "stage") fsImpl.writeFileSync = (file, ...args) => {
      fs.writeFileSync(file, ...args);
      if (file.endsWith("SOURCE.md")) mutate();
    };
    f = fixture(t, {
      fsImpl,
      probe: async () => { if (moment === "probe") mutate(); return { cli: true, python: true }; },
    });
    registerPreviousDeployment(f, syntheticPreviousFiles);
    await assert.rejects(f.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), `${syntheticPreviousFiles["SKILL.md"]} external edit`);
    assert.equal(fs.existsSync(path.join(f.configRoot, "claude-proxy/skill-backups")), false);
    assert.equal(fs.existsSync(f.featureFile), false);
  }
});

test("automatic upgrade revalidates a moved backup and rolls back a post-rename edit", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  let mutated = false;
  fsImpl.renameSync = (from, to) => {
    const result = fs.renameSync(from, to);
    if (!mutated && from === f.target && path.dirname(to) === path.join(f.configRoot, "claude-proxy/skill-backups")) {
      mutated = true;
      fs.appendFileSync(path.join(to, "SKILL.md"), " edited during backup move");
    }
    return result;
  };
  f = fixture(t, { fsImpl });
  registerPreviousDeployment(f, syntheticPreviousFiles);
  await assert.rejects(f.installer.autoEnable(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(mutated, true);
  assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), `${syntheticPreviousFiles["SKILL.md"]} edited during backup move`);
  assert.equal(fs.readFileSync(path.join(f.target, "scripts/pcm.py"), "utf8"), syntheticPreviousFiles["scripts/pcm.py"]);
  assert.deepEqual(fs.readdirSync(path.join(f.configRoot, "claude-proxy/skill-backups")), []);
  assert.equal(fs.existsSync(f.featureFile), false);
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
