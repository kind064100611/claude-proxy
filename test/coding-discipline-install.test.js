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
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
  assert.equal(fs.existsSync(path.join(f.configRoot, "settings.json")), false);
  assert.equal((await f.installer.getStatus()).state, "installed");
  const before = fs.statSync(path.join(f.target, "SKILL.md"));
  f.dependencies.cli = false;
  assert.equal((await f.installer.install()).changed, false);
  assert.equal(fs.statSync(path.join(f.target, "SKILL.md")).mtimeMs, before.mtimeMs);
});

test("an identical SKILL.md-only install is a no-op that does not probe or add files", async (t) => {
  const f = fixture(t, { probe: async () => { throw new Error("must not probe a no-op"); } });
  fs.mkdirSync(f.target, { recursive: true, mode: 0o755 });
  fs.copyFileSync(path.join(f.bundleRoot, "SKILL.md"), path.join(f.target, "SKILL.md"));
  const mode = fs.statSync(f.target).mode;
  assert.equal((await f.installer.getStatus()).installed, true);
  assert.equal((await f.installer.install()).changed, false);
  assert.deepEqual(fs.readdirSync(f.target), ["SKILL.md"]);
  assert.equal(fs.statSync(f.target).mode, mode);
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

test("partial, modified and non-directory targets are preserved conflicts", async (t) => {
  for (const kind of ["partial", "modified", "file"]) {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.target), { recursive: true });
    if (kind === "file") fs.writeFileSync(f.target, "keep");
    else if (kind === "partial") {
      fs.mkdirSync(f.target);
      fs.copyFileSync(path.join(f.bundleRoot, "LICENSE"), path.join(f.target, "LICENSE"));
    } else {
      fs.cpSync(f.bundleRoot, f.target, { recursive: true });
      fs.appendFileSync(path.join(f.target, "SKILL.md"), "keep");
    }
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
    assert.equal(fs.existsSync(f.target), true);
    if (kind === "modified") assert.ok(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8").endsWith("keep"));
    if (kind === "partial") assert.deepEqual(fs.readdirSync(f.target), ["LICENSE"]);
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

test("concurrent installs are serialized and only the first writes", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.installer.install(), f.installer.install()]);
  assert.deepEqual(results.map((result) => result.changed), [true, false]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
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

test("a target created during staging is preserved as a conflict", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.renameSync = (from, to) => {
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), "competing");
    return fs.renameSync(from, to);
  };
  f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "competing");
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
});

test("symlinked install paths are preserved conflicts", { skip: process.platform === "win32" }, async (t) => {
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
      fs.copyFileSync(path.join(f.bundleRoot, "SKILL.md"), path.join(external, "SKILL.md"));
      fs.symlinkSync(external, f.target);
    } else {
      fs.mkdirSync(f.target, { recursive: true });
      fs.copyFileSync(path.join(f.bundleRoot, "SKILL.md"), path.join(external, "SKILL.md"));
      fs.symlinkSync(path.join(external, "SKILL.md"), path.join(f.target, "SKILL.md"));
    }
    const before = fs.readdirSync(external);
    assert.equal((await f.installer.getStatus()).state, "conflict");
    await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
    assert.deepEqual(fs.readdirSync(external), before);
    const linked = kind === "config" ? f.configRoot : kind === "skills" ? path.dirname(f.target) : kind === "target" ? f.target : path.join(f.target, "SKILL.md");
    assert.ok(fs.lstatSync(linked).isSymbolicLink());
  }
});

test("writable install parents are refused and paths are rechecked after the async probe", { skip: process.platform === "win32" }, async (t) => {
  const unsafe = fixture(t);
  fs.mkdirSync(path.dirname(unsafe.target), { recursive: true });
  fs.chmodSync(path.dirname(unsafe.target), 0o777);
  await assert.rejects(unsafe.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
  assert.deepEqual(fs.readdirSync(path.dirname(unsafe.target)), []);
  let f;
  f = fixture(t, { probe: async () => {
    fs.mkdirSync(f.target, { recursive: true });
    fs.writeFileSync(path.join(f.target, "SKILL.md"), "created during probe");
    return { cli: true };
  } });
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.target, "SKILL.md"), "utf8"), "created during probe");
});

test("an empty target created during staging is not replaced", async (t) => {
  const fsImpl = Object.create(fs);
  let f;
  fsImpl.writeFileSync = (file, ...rest) => {
    fs.writeFileSync(file, ...rest);
    if (file.endsWith("SKILL.md")) fs.mkdirSync(f.target);
  };
  f = fixture(t, { fsImpl });
  await assert.rejects(f.installer.install(), { code: "CODING_DISCIPLINE_CONFLICT" });
  assert.deepEqual(fs.readdirSync(f.target), []);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), ["coding-discipline"]);
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
