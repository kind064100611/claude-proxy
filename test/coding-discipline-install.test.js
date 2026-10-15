const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createCodingDisciplineInstaller, INSTALL_FILES } = require("../lib/coding-discipline-install");

function fixture(t, options = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coding-discipline-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configRoot = path.join(directory, "cli");
  const bundleRoot = path.join(directory, "bundle");
  fs.cpSync(path.join(__dirname, "../coding-discipline"), bundleRoot, { recursive: true });
  const target = path.join(configRoot, "skills/coding-discipline");
  const dependencies = { cli: true };
  const installer = createCodingDisciplineInstaller({ configRoot, bundleRoot, probe: async () => dependencies, ...options });
  return { directory, configRoot, bundleRoot, target, dependencies, installer };
}

function assertBundle(f) {
  assert.deepEqual(fs.readdirSync(f.target).sort(), [...INSTALL_FILES].sort());
  for (const relative of INSTALL_FILES) assert.deepEqual(fs.readFileSync(path.join(f.target, relative)), fs.readFileSync(path.join(f.bundleRoot, relative)));
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
}

test("bundle is the coding-discipline skill and manifest hashes match the files", () => {
  const bundleRoot = path.join(__dirname, "../coding-discipline");
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
  assert.match(fs.readFileSync(path.join(bundleRoot, "SKILL.md"), "utf8"), /^---\nname: coding-discipline\n/);
  assert.deepEqual(manifest.installFiles, INSTALL_FILES);
  for (const relative of INSTALL_FILES) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(bundleRoot, relative))).digest("hex"), manifest.files[relative]);
  }
  assert.match(fs.readFileSync(path.join(bundleRoot, "LICENSE"), "utf8"), /^MIT License\n/);
  assert.match(fs.readFileSync(path.join(bundleRoot, "SOURCE.md"), "utf8"), new RegExp(manifest.upstream.commit));
});

test("status/factory are read-only, private install is complete and every install replaces the target", async (t) => {
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
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
  assert.equal(fs.existsSync(path.join(f.configRoot, "settings.json")), false);
  const status = await f.installer.getStatus();
  assert.equal(status.state, "installed");
  assert.equal(status.ready, true);
  const before = fs.statSync(f.target).ino;
  assert.equal((await f.installer.install()).changed, true);
  assert.notEqual(fs.statSync(f.target).ino, before);
  assertBundle(f);
  f.dependencies.cli = false;
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
  assertBundle(f);
});

test("an identical SKILL.md-only install reports installed and is completed on install", async (t) => {
  const f = fixture(t, { probe: async () => { throw new Error("status must not probe when installed"); } });
  fs.mkdirSync(f.target, { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(f.bundleRoot, "SKILL.md"), path.join(f.target, "SKILL.md"));
  assert.equal((await f.installer.getStatus()).installed, true);
  const g = fixture(t);
  fs.mkdirSync(g.target, { recursive: true });
  fs.copyFileSync(path.join(g.bundleRoot, "SKILL.md"), path.join(g.target, "SKILL.md"));
  assert.equal((await g.installer.install()).changed, true);
  assertBundle(g);
});

test("missing CLI, failed probe and damaged bundle cannot create user directories", async (t) => {
  for (const probe of [async () => ({ cli: false }), async () => { throw new Error("private output"); }]) {
    const f = fixture(t, { probe });
    assert.equal((await f.installer.getStatus()).ready, false);
    await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
    assert.equal(fs.existsSync(f.configRoot), false);
  }
  const f = fixture(t);
  fs.appendFileSync(path.join(f.bundleRoot, "SKILL.md"), "damaged");
  assert.equal((await f.installer.getStatus()).state, "unavailable");
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
  assert.equal(fs.existsSync(f.configRoot), false);
});

test("partial, modified and non-directory targets are replaced without conflict checks", async (t) => {
  for (const kind of ["partial", "modified", "file"]) {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    if (kind === "file") fs.writeFileSync(f.target, "old");
    else if (kind === "partial") {
      fs.mkdirSync(f.target);
      fs.writeFileSync(path.join(f.target, "extra.md"), "old");
    } else {
      fs.cpSync(f.bundleRoot, f.target, { recursive: true });
      fs.appendFileSync(path.join(f.target, "SKILL.md"), "old");
    }
    const status = await f.installer.getStatus();
    assert.equal(status.state, "absent");
    assert.equal(status.ready, true);
    assert.equal((await f.installer.install()).changed, true);
    assertBundle(f);
  }
});

test("status shares pending probes and caches briefly, install always rechecks dependencies", async (t) => {
  let calls = 0;
  let clock = 0;
  const f = fixture(t, { now: () => clock, probe: async () => { calls++; return { cli: true }; } });
  await Promise.all([f.installer.getStatus(), f.installer.getStatus()]);
  await f.installer.getStatus();
  assert.equal(calls, 1);
  clock = 3000;
  await f.installer.getStatus();
  assert.equal(calls, 2);
  await f.installer.install();
  assert.equal(calls, 3);
});

test("concurrent installs are serialized and each replaces the target", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.installer.install(), f.installer.install()]);
  assert.deepEqual(results.map((result) => result.changed), [true, true]);
  assertBundle(f);
});

test("write failure removes the private stage and leaves no target", async (t) => {
  const fsImpl = Object.create(fs);
  fsImpl.writeFileSync = (file, ...rest) => {
    if (file.endsWith("SOURCE.md")) throw new Error("synthetic write failure");
    return fs.writeFileSync(file, ...rest);
  };
  const f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
});

test("a non-empty target created during publishing fails safely and leaves no stage", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.renameSync = (from, to) => {
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), "competing");
    return fs.renameSync(from, to);
  };
  f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
  assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "competing");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
});

test("publishing failure restores the previous target", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.renameSync = (from, to) => {
    if (to === f.target && path.basename(from).startsWith(".coding-discipline-stage-")) throw new Error("synthetic publish failure");
    return fs.renameSync(from, to);
  };
  f = fixture(t, { fsImpl });
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(path.join(f.target, "SKILL.md"), "previous");
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_UNAVAILABLE" });
  assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "previous");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
});

test("symlinked install paths are used or replaced without touching linked target content", { skip: process.platform === "win32" }, async (t) => {
  for (const kind of ["config", "skills", "target", "skill"]) {
    const f = fixture(t);
    const external = path.join(f.directory, "external");
    fs.mkdirSync(external);
    if (kind === "config") fs.symlinkSync(external, f.configRoot);
    else if (kind === "skills") {
      fs.mkdirSync(f.configRoot);
      fs.symlinkSync(external, path.dirname(f.target));
    } else if (kind === "target") {
      fs.mkdirSync(path.dirname(f.target), { recursive: true });
      fs.writeFileSync(path.join(external, "SKILL.md"), "external");
      fs.symlinkSync(external, f.target);
    } else {
      fs.mkdirSync(f.target, { recursive: true });
      fs.writeFileSync(path.join(external, "SKILL.md"), "external");
      fs.symlinkSync(path.join(external, "SKILL.md"), path.join(f.target, "SKILL.md"));
    }
    assert.equal((await f.installer.install()).changed, true);
    assertBundle(f);
    if (kind === "target" || kind === "skill") {
      assert.equal(fs.lstatSync(f.target).isDirectory(), true);
      assert.equal(fs.readFileSync(path.join(external, "SKILL.md"), "utf8"), "external");
    }
  }
});

test("writable install parents and targets created during the async probe are replaced", { skip: process.platform === "win32" }, async (t) => {
  const writable = fixture(t);
  fs.mkdirSync(path.dirname(writable.target), { recursive: true });
  fs.chmodSync(path.dirname(writable.target), 0o777);
  await writable.installer.install();
  assertBundle(writable);
  let f;
  f = fixture(t, { probe: async () => {
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), "created during probe");
    return { cli: true };
  } });
  await f.installer.install();
  assertBundle(f);
});

test("an empty target created during staging is replaced", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.writeFileSync = (file, ...rest) => {
    fs.writeFileSync(file, ...rest);
    if (file.endsWith("SKILL.md")) fs.mkdirSync(f.target);
  };
  f = fixture(t, { fsImpl });
  await f.installer.install();
  assertBundle(f);
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
