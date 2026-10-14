const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProjectMemoryInstaller, INSTALL_FILES } = require("../lib/project-memory-install");

function lockFile(configRoot) {
  return path.join(configRoot, "claude-proxy", ".project-code-memory-install.lock");
}

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
  const privatePaths = [];
  const fsImpl = Object.create(fs);
  fsImpl.openSync = (file, flags, mode) => {
    if (flags === "wx" && file.endsWith(".lock")) privatePaths.push(file);
    return fs.openSync(file, flags, mode);
  };
  fsImpl.mkdtempSync = (prefix) => { privatePaths.push(prefix); return fs.mkdtempSync(prefix); };
  const f = fixture(t, { fsImpl });
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
  const privateRoot = path.join(f.configRoot, "claude-proxy");
  assert.deepEqual(privatePaths, [lockFile(f.configRoot), path.join(privateRoot, ".project-code-memory-stage-")]);
  assert.deepEqual(fs.readdirSync(privateRoot), []);
  if (process.platform !== "win32") assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o700);
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

test("private lock and staging root is confined to claude-proxy and unsafe roots are rejected", async (t) => {
  const kinds = process.platform === "win32" ? ["link"] : ["open", "link"];
  for (const kind of kinds) {
    const f = fixture(t);
    fs.mkdirSync(f.configRoot);
    const privateRoot = path.join(f.configRoot, "claude-proxy");
    if (kind === "open") {
      fs.mkdirSync(privateRoot, { mode: 0o755 });
      if (process.platform !== "win32") fs.chmodSync(privateRoot, 0o755);
    } else {
      const external = path.join(f.directory, "external-private-root");
      fs.mkdirSync(external);
      fs.symlinkSync(external, privateRoot, "dir");
    }
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.existsSync(path.join(f.configRoot, "skills")), false);
    if (kind === "open" && process.platform !== "win32") assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o755);
  }
});

test("partial, modified, non-directory and symlink targets are preserved conflicts", async (t) => {
  for (const kind of ["partial", "modified", "file", "link", "core-link", "parent-link"]) {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    if (kind === "file") fs.writeFileSync(f.target, "keep");
    else if (kind === "link") fs.symlinkSync(f.bundleRoot, f.target, "dir");
    else if (kind === "parent-link") {
      fs.rmdirSync(path.dirname(f.target));
      fs.symlinkSync(f.bundleRoot, path.dirname(f.target), "dir");
    } else if (kind === "partial") fs.mkdirSync(f.target);
    else {
      fs.cpSync(f.bundleRoot, f.target, { recursive: true });
      if (kind === "modified") fs.appendFileSync(path.join(f.target, "references/record-format.md"), "keep");
      else {
        fs.unlinkSync(path.join(f.target, "scripts/pcm.py"));
        fs.symlinkSync(path.join(f.bundleRoot, "scripts/pcm.py"), path.join(f.target, "scripts/pcm.py"));
      }
    }
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.existsSync(f.target), kind !== "parent-link");
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

test("install queues serialize by root and existing live or stale lock is never stolen", async (t) => {
  const f = fixture(t);
  const other = createProjectMemoryInstaller({ configRoot: f.configRoot, bundleRoot: f.bundleRoot, probe: async () => f.dependencies });
  const results = await Promise.all([f.installer.install(), other.install(), f.installer.install()]);
  assert.equal(results.filter((result) => result.changed).length, 1);
  const locked = fixture(t);
  fs.mkdirSync(path.dirname(locked.target), { recursive: true });
  const lock = lockFile(locked.configRoot);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lock, "unknown old owner");
  await assert.rejects(locked.installer.install(), { code: "PROJECT_MEMORY_BUSY" });
  assert.equal(fs.readFileSync(lock, "utf8"), "unknown old owner");
});

test("separate proxy processes cannot publish under another process installation lock", async (t) => {
  const { spawn, execFile } = require("child_process");
  const f = fixture(t);
  const gate = path.join(f.directory, "release");
  const moduleFile = path.resolve(__dirname, "../lib/project-memory-install.js");
  const source = `
    const fs = require("fs");
    const [moduleFile, configRoot, bundleRoot, gate] = process.argv.slice(1);
    const fsImpl = Object.create(fs);
    if (gate) fsImpl.mkdtempSync = (prefix) => {
      const result = fs.mkdtempSync(prefix);
      process.stdout.write("LOCKED\\n");
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(gate)) {
        if (Date.now() > deadline) throw new Error("fixture deadline");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return result;
    };
    require(moduleFile).createProjectMemoryInstaller({ configRoot, bundleRoot, fsImpl,
      probe: async () => ({ cli: true, python: true }) }).install()
      .then((result) => process.stdout.write(JSON.stringify(result) + "\\n"))
      .catch((error) => process.stdout.write(JSON.stringify({ code: error.code }) + "\\n"));
  `;
  const child = spawn(process.execPath, ["-e", source, moduleFile, f.configRoot, f.bundleRoot, gate]);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fixture did not acquire lock")), 5000);
    child.stdout.once("data", () => { clearTimeout(timeout); resolve(); });
    child.once("error", reject);
  });
  assert.equal((await f.installer.getStatus()).state, "busy");
  const competing = await new Promise((resolve, reject) => execFile(process.execPath,
    ["-e", source, moduleFile, f.configRoot, f.bundleRoot], { timeout: 5000 },
    (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  assert.equal(competing.code, "PROJECT_MEMORY_BUSY");
  fs.writeFileSync(gate, "release");
  assert.equal(await exit, 0);
  assert.equal((await f.installer.install()).changed, false);
});

test("exclusive target mkdir cannot replace a competing empty or original directory", async (t) => {
  for (const complete of [false, true]) {
    let target;
    let bundleRoot;
    const fsImpl = Object.create(fs);
    fsImpl.mkdirSync = (file, options) => {
      if (file === target) {
        if (complete) fs.cpSync(bundleRoot, target, { recursive: true });
        else fs.mkdirSync(target);
      }
      return fs.mkdirSync(file, options);
    };
    const f = fixture(t, { fsImpl });
    target = f.target; bundleRoot = f.bundleRoot;
    if (complete) assert.equal((await f.installer.install()).changed, false);
    else {
      await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
      assert.deepEqual(fs.readdirSync(target), []);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ["project-code-memory"]);
  }
});

test("failed publication cleans only owned unchanged items, preserving external edits and extras", async (t) => {
  for (const change of ["none", "edit", "extra", "replace-directory"]) {
    let target;
    const fsImpl = Object.create(fs);
    fsImpl.linkSync = (source, file) => {
      if (file === path.join(target || "unset", "SKILL.md")) {
        if (change === "edit") fs.writeFileSync(path.join(target, "LICENSE"), "external edit");
        if (change === "extra") fs.writeFileSync(path.join(target, "user-file"), "external new file");
        if (change === "replace-directory") {
          fs.renameSync(target, target + "-owned");
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "LICENSE"), "replacement");
        }
        throw Object.assign(new Error("private failure output"), { code: "EIO" });
      }
      return fs.linkSync(source, file);
    };
    const f = fixture(t, { fsImpl }); target = f.target;
    await assert.rejects(f.installer.install(), { code: change === "none" ? "PROJECT_MEMORY_UNAVAILABLE" : "PROJECT_MEMORY_CONFLICT" });
    if (change === "none") assert.equal(fs.existsSync(target), false);
    if (change === "edit") assert.equal(fs.readFileSync(path.join(target, "LICENSE"), "utf8"), "external edit");
    if (change === "extra") assert.equal(fs.readFileSync(path.join(target, "user-file"), "utf8"), "external new file");
    if (change === "replace-directory") assert.equal(fs.readFileSync(path.join(target, "LICENSE"), "utf8"), "replacement");
    assert.equal(fs.existsSync(path.join(target, "SKILL.md")), false);
  }
});

test("known short writes are rolled back on lock/stage/target failures and external changes are retained", async (t) => {
  for (const phase of ["lock", "stage", "target", "external"]) {
    let target;
    let selectedFd;
    let writes = 0;
    const fsImpl = Object.create(fs);
    fsImpl.openSync = (file, flags, mode) => {
      const fd = fs.openSync(file, flags, mode);
      if (flags === "wx" && (phase === "lock" && file.endsWith(".lock") ||
        phase === "stage" && file.includes("stage-") && file.endsWith("pcm.py") ||
        ["target", "external"].includes(phase) && file === path.join(target || "unset", "scripts/pcm.py"))) selectedFd = fd;
      return fd;
    };
    fsImpl.writeSync = (fd, bytes, offset, length) => {
      if (fd === selectedFd) {
        writes++;
        if (writes === 1) return fs.writeSync(fd, bytes, offset, 1);
        if (phase === "external") fs.writeFileSync(path.join(target, "scripts/pcm.py"), "external edit");
        throw Object.assign(new Error("private short-write failure"), { code: "EIO" });
      }
      return fs.writeSync(fd, bytes, offset, length);
    };
    const f = fixture(t, { fsImpl }); target = f.target;
    await assert.rejects(f.installer.install(), { code: phase === "external" ? "PROJECT_MEMORY_CONFLICT" : "PROJECT_MEMORY_UNAVAILABLE" });
    if (phase === "external") assert.equal(fs.readFileSync(path.join(target, "scripts/pcm.py"), "utf8"), "external edit");
    else assert.equal(fs.existsSync(f.configRoot), false);
  }
});

test("changed stage contents and lock bytes are preserved rather than recursively removed", async (t) => {
  for (const change of ["stage", "lock"]) {
    let target;
    let stage;
    const fsImpl = Object.create(fs);
    fsImpl.mkdtempSync = (prefix) => { stage = fs.mkdtempSync(prefix); return stage; };
    fsImpl.mkdirSync = (file, options) => {
      if (change === "stage" && file === target) fs.writeFileSync(path.join(stage, "SOURCE.md"), "external stage edit");
      return fs.mkdirSync(file, options);
    };
    fsImpl.linkSync = (source, file) => {
      if (change === "lock" && file === path.join(target || "unset", "SKILL.md")) {
        fs.writeFileSync(lockFile(path.dirname(path.dirname(target))), "external lock edit");
      }
      return fs.linkSync(source, file);
    };
    const f = fixture(t, { fsImpl }); target = f.target;
    await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
    const preserved = change === "stage" ? path.join(stage, "SOURCE.md") : lockFile(path.dirname(path.dirname(target)));
    assert.equal(fs.readFileSync(preserved, "utf8"), `external ${change} edit`);
    if (change === "stage") assert.equal(fs.existsSync(target), false);
  }
});

test("unsafe bundle files, ancestors and read-only directories cannot install", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.bundleRoot, "scripts/pcm.py"));
  fs.symlinkSync(path.join(__dirname, "../project-code-memory/scripts/pcm.py"), path.join(f.bundleRoot, "scripts/pcm.py"));
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
  assert.equal(fs.existsSync(f.configRoot), false);
  const ancestor = fixture(t);
  fs.mkdirSync(path.join(ancestor.directory, "real-cli"));
  fs.symlinkSync(path.join(ancestor.directory, "real-cli"), ancestor.configRoot, "dir");
  await assert.rejects(ancestor.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
  const readOnly = fixture(t);
  fs.mkdirSync(readOnly.configRoot, { mode: 0o500 });
  if (process.platform !== "win32") {
    await assert.rejects(readOnly.installer.install(), { code: "PROJECT_MEMORY_UNAVAILABLE" });
    assert.equal(fs.statSync(readOnly.configRoot).mode & 0o777, 0o500);
  }
});

test("prerequisite bytes are revalidated before publishing discoverable SKILL", async (t) => {
  let target;
  let publishedSkill = false;
  const fsImpl = Object.create(fs);
  fsImpl.openSync = (file, flags, mode) => {
    if (target && file.includes("stage-") && file.endsWith("SKILL.md") && typeof flags === "number" && fs.existsSync(path.join(target, "LICENSE"))) {
      fs.writeFileSync(path.join(target, "LICENSE"), "external late edit");
    }
    return fs.openSync(file, flags, mode);
  };
  fsImpl.linkSync = (source, file) => { publishedSkill = true; return fs.linkSync(source, file); };
  const f = fixture(t, { fsImpl }); target = f.target;
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(publishedSkill, false);
  assert.equal(fs.readFileSync(path.join(target, "LICENSE"), "utf8"), "external late edit");
});

test("atomic SKILL publication never overwrites a competing marker", async (t) => {
  let target;
  const fsImpl = Object.create(fs);
  fsImpl.linkSync = (source, file) => {
    if (file === path.join(target || "unset", "SKILL.md")) fs.writeFileSync(file, "external marker");
    return fs.linkSync(source, file);
  };
  const f = fixture(t, { fsImpl }); target = f.target;
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.deepEqual(fs.readdirSync(target), ["SKILL.md"]);
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "external marker");
});

test("SKILL is published last and existing user directory mode/settings are untouched", async (t) => {
  const writes = [];
  const fsImpl = Object.create(fs);
  fsImpl.openSync = (file, flags, mode) => {
    if (flags === "wx") {
      assert.ok(!file.endsWith("project-code-memory/SKILL.md"));
      writes.push(file);
    }
    return fs.openSync(file, flags, mode);
  };
  fsImpl.linkSync = (source, file) => { writes.push(file); return fs.linkSync(source, file); };
  const f = fixture(t, { fsImpl });
  fs.mkdirSync(f.configRoot, { mode: 0o755 });
  fs.writeFileSync(path.join(f.configRoot, "settings.json"), "broken settings");
  const mode = fs.statSync(f.configRoot).mode;
  await f.installer.install();
  assert.equal(writes.at(-1), path.join(f.target, "SKILL.md"));
  assert.equal(fs.statSync(f.configRoot).mode, mode);
  assert.equal(fs.readFileSync(path.join(f.configRoot, "settings.json"), "utf8"), "broken settings");
});
