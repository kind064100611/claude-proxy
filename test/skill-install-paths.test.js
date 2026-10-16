"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveSkillPaths } = require("../lib/skill-install-paths");
const { createProjectMemoryInstaller } = require("../lib/project-memory-install");
const { createCodingDisciplineInstaller } = require("../lib/coding-discipline-install");

const link = (target, name) => fs.symlinkSync(target, name, process.platform === "win32" ? "junction" : "dir");
function fixture(t, kind = "memory", options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-junction-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "cli");
  const real = path.join(root, "agents", "skills");
  fs.mkdirSync(configRoot);
  fs.mkdirSync(real, { recursive: true });
  const alias = path.join(configRoot, "skills");
  link(real, alias);
  fs.writeFileSync(path.join(real, "sibling"), "leave alone");
  const create = kind === "memory" ? createProjectMemoryInstaller : createCodingDisciplineInstaller;
  const name = kind === "memory" ? "project-code-memory" : "coding-discipline";
  const installer = create({ configRoot, featureFile: path.join(root, "features.json"),
    probe: async () => ({ cli: true, python: true }), ...options });
  return { root, configRoot, real, alias, target: path.join(real, name), installer,
    backups: path.join(path.dirname(real), "claude-proxy", "skill-backups") };
}

for (const kind of ["memory", "discipline"]) {
  test(`${kind}: install and status use the real Junction target without changing the link`, async (t) => {
    const f = fixture(t, kind);
    const before = fs.lstatSync(f.alias);
    assert.equal((await f.installer.getStatus()).state, "absent");
    assert.deepEqual(fs.readdirSync(f.real), ["sibling"]);
    await f.installer.install();
    assert.equal((await f.installer.getStatus()).installed, true);
    assert.equal(fs.lstatSync(f.alias).ino, before.ino);
    assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(f.real, "sibling"), "utf8"), "leave alone");
    assert.equal(fs.existsSync(path.join(f.configRoot, "claude-proxy")), false);
    if (kind === "memory") {
      await f.installer.uninstall();
      assert.equal(fs.existsSync(f.target), false);
      assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
    } else {
      fs.writeFileSync(path.join(f.target, "extra"), "replace");
      await f.installer.install();
      assert.equal(fs.existsSync(path.join(f.target, "extra")), false);
    }
  });

  for (const timing of ["probe", "stage", "backup", "publish"]) {
    test(`${kind}: Junction retargeting during ${timing} never installs into the new destination`, async (t) => {
      let f, switched = false;
      const fsImpl = Object.create(fs);
      const retarget = () => {
        if (switched) return;
        switched = true;
        fs.unlinkSync(f.alias);
        link(path.join(f.root, "other"), f.alias);
      };
      const probe = async () => { if (timing === "probe") retarget(); return { cli: true, python: true }; };
      fsImpl.writeFileSync = (file, ...args) => {
        const result = fs.writeFileSync(file, ...args);
        if (timing === "stage" && file.includes("-stage-")) retarget();
        return result;
      };
      fsImpl.renameSync = (from, to) => {
        const result = fs.renameSync(from, to);
        if (timing === "backup" && from === f.target || timing === "publish" && from.includes("-stage-") && to === f.target) retarget();
        return result;
      };
      f = fixture(t, kind, { fsImpl, probe });
      fs.mkdirSync(path.join(f.root, "other"));
      fs.mkdirSync(f.target);
      fs.writeFileSync(path.join(f.target, "old"), "preserve");
      await assert.rejects(kind === "memory" ? f.installer.configure(true) : f.installer.install());
      assert.deepEqual(fs.readdirSync(path.join(f.root, "other")), []);
      assert.equal(fs.readFileSync(path.join(f.target, "old"), "utf8"), "preserve");
    });
  }

  test(`${kind}: publishing failure through a Junction restores the old skill`, async (t) => {
    let f;
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => {
      if (from.includes("-stage-") && to === f.target) throw Object.assign(new Error("publish failed"), { code: "EXDEV" });
      return fs.renameSync(from, to);
    };
    f = fixture(t, kind, { fsImpl });
    fs.mkdirSync(f.target);
    fs.writeFileSync(path.join(f.target, "old"), "preserve");
    await assert.rejects(kind === "memory" ? f.installer.configure(true) : f.installer.install());
    assert.equal(fs.readFileSync(path.join(f.target, "old"), "utf8"), "preserve");
    assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
  });

  test(`${kind}: invalid Junction destinations fail without being replaced`, async (t) => {
    for (const invalid of ["missing", "file"]) {
      const f = fixture(t, kind);
      fs.unlinkSync(f.alias);
      const dest = path.join(f.root, invalid);
      if (invalid === "file") fs.writeFileSync(dest, "file");
      link(dest, f.alias);
      await assert.rejects(f.installer.install());
      assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
      if (invalid === "file") assert.equal(fs.readFileSync(dest, "utf8"), "file");
    }
  });
}

test("Project Memory backups are beside real skills and survive disabling", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, "old"), "user data");
  assert.equal((await f.installer.configure(true)).replaced, true);
  const [backup] = fs.readdirSync(f.backups);
  assert.equal(fs.readFileSync(path.join(f.backups, backup, "old"), "utf8"), "user data");
  fs.appendFileSync(path.join(f.target, "SKILL.md"), "modified");
  await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
  fs.copyFileSync(path.join(__dirname, "../project-code-memory/SKILL.md"), path.join(f.target, "SKILL.md"));
  await f.installer.configure(false);
  assert.deepEqual(fs.readdirSync(f.backups), [backup]);
});

test("Project Memory linked-root stage and backup renames stay on the target side", async (t) => {
  let f;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    const side = path.dirname(f.real) + path.sep;
    assert.equal(from.startsWith(side), true);
    assert.equal(to.startsWith(side), true);
    return fs.renameSync(from, to);
  };
  f = fixture(t, "memory", { fsImpl });
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, "old"), "old");
  await f.installer.configure(true);
  await f.installer.configure(false);
});

test("resolver detects same-path parent replacement and keeps status read-only", (t) => {
  const f = fixture(t);
  const l = resolveSkillPaths(f.configRoot, fs);
  fs.renameSync(f.real, f.real + "-old");
  fs.mkdirSync(f.real);
  assert.throws(() => l.check());
  assert.equal(l.physicalValid(), false);
  const missing = path.join(f.root, "missing");
  resolveSkillPaths(missing, fs).check();
  assert.equal(fs.existsSync(missing), false);
});

test("Project Memory auto-upgrades an exact historical deployment through a Junction", async (t) => {
  const f = fixture(t);
  const { execFileSync } = require("node:child_process");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../project-code-memory/manifest.json"), "utf8"));
  const previous = manifest.previousDeployments.find((item) => item.commit === "f3fab02");
  for (const name of Object.keys(previous.files)) {
    const bytes = execFileSync("git", ["show", `${previous.commit}:project-code-memory/${name}`], { cwd: path.join(__dirname, "..") });
    const file = path.join(f.target, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const result = await f.installer.autoEnable();
  assert.equal(result.enabled, true);
  assert.equal(result.replaced, true);
  assert.equal(fs.readdirSync(f.backups).length, 1);
});

test("individual skill Junctions are replaced as links without editing their referents", async (t) => {
  for (const kind of ["memory", "discipline"]) {
    const f = fixture(t, kind);
    const external = path.join(f.root, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "keep"), "external content");
    link(external, f.target);
    await (kind === "memory" ? f.installer.configure(true) : f.installer.install());
    assert.equal(fs.lstatSync(f.target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(external, "keep"), "utf8"), "external content");
  }
});

test("Project Memory rejects linked private and backup directories beside real skills", async (t) => {
  for (const kind of ["private", "backups"]) {
    const f = fixture(t);
    fs.mkdirSync(f.target);
    fs.writeFileSync(path.join(f.target, "keep"), "old skill");
    const external = path.join(f.root, "external");
    fs.mkdirSync(external);
    const location = kind === "private" ? path.dirname(f.backups) : f.backups;
    fs.mkdirSync(path.dirname(location), { recursive: true });
    link(external, location);
    await assert.rejects(f.installer.configure(true), { code: "PROJECT_MEMORY_CONFLICT" });
    assert.equal(fs.readFileSync(path.join(f.target, "keep"), "utf8"), "old skill");
    assert.deepEqual(fs.readdirSync(external), []);
  }
});

test("bundle attributes keep all tracked bundle files LF even with autocrlf enabled", () => {
  const { execFileSync } = require("node:child_process");
  const cwd = path.join(__dirname, "..");
  const files = execFileSync("git", ["ls-files", "-z", "--", "coding-discipline", "project-code-memory"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const attributes = execFileSync("git", ["-c", "core.autocrlf=true", "check-attr", "eol", "--", ...files], { cwd, encoding: "utf8" });
  assert.equal(attributes.trim().split(/\r?\n/).length, files.length);
  assert.ok(attributes.trim().split(/\r?\n/).every((line) => line.endsWith(": eol: lf")));
  for (const file of files) assert.equal(fs.readFileSync(path.join(cwd, file)).includes(Buffer.from("\r\n")), false, file);
});

test("retargeting during publication of a new skill rejects without enabling or keeping it", async (t) => {
  for (const kind of ["memory", "discipline"]) {
    let f, switched = false;
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => {
      const result = fs.renameSync(from, to);
      if (!switched && from.includes("-stage-") && to === f.target) {
        switched = true;
        fs.unlinkSync(f.alias);
        link(path.join(f.root, "other"), f.alias);
      }
      return result;
    };
    f = fixture(t, kind, { fsImpl });
    fs.mkdirSync(path.join(f.root, "other"));
    await assert.rejects(kind === "memory" ? f.installer.configure(true) : f.installer.install());
    assert.deepEqual(fs.readdirSync(path.join(f.root, "other")), []);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(path.join(f.root, "features.json")), false);
  }
});

test("resolver rejects a new intermediate linked directory before creating skills", (t) => {
  const f = fixture(t);
  const config = path.join(f.root, "new", "cli");
  const l = resolveSkillPaths(config, fs);
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  link(other, path.join(f.root, "new"));
  assert.throws(() => l.ensure());
  assert.deepEqual(fs.readdirSync(other), []);
});

test("Project Memory uses atomic target-side renames across actual volumes when available", async (t) => {
  const f = fixture(t);
  const repositoryRoot = path.resolve(__dirname, "..");
  if (fs.statSync(f.root).dev === fs.statSync(repositoryRoot).dev) return t.skip("No second writable test volume available");
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(repositoryRoot, ".junction-volume-")));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  const skills = path.join(remote, "skills");
  fs.mkdirSync(skills);
  fs.unlinkSync(f.alias);
  link(skills, f.alias);
  const target = path.join(skills, "project-code-memory");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep"), "old skill");
  assert.equal((await f.installer.configure(true)).replaced, true);
  const backups = path.join(remote, "claude-proxy", "skill-backups");
  const [backup] = fs.readdirSync(backups);
  assert.equal(fs.readFileSync(path.join(backups, backup, "keep"), "utf8"), "old skill");
  await f.installer.configure(false);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(f.alias).isSymbolicLink(), true);
});

test("Project Memory uninstall restores its original physical skill if the Junction changes", async (t) => {
  let f, retarget = false;
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = (from, to) => {
    const result = fs.renameSync(from, to);
    if (retarget && from === f.target && path.basename(to).startsWith(".project-code-memory-remove-")) {
      fs.unlinkSync(f.alias);
      link(path.join(f.root, "other"), f.alias);
    }
    return result;
  };
  f = fixture(t, "memory", { fsImpl });
  await f.installer.install();
  fs.mkdirSync(path.join(f.root, "other"));
  retarget = true;
  await assert.rejects(f.installer.uninstall(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.equal(fs.existsSync(path.join(f.target, "SKILL.md")), true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "other")), []);
});

test("replacement of the physical parent never restores or deletes through the substitute", async (t) => {
  for (const kind of ["memory", "discipline"]) {
    let f, moved = false;
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => {
      const result = fs.renameSync(from, to);
      if (!moved && from === f.target) {
        moved = true;
        fs.renameSync(f.real, f.real + "-old");
        fs.mkdirSync(f.real);
        fs.mkdirSync(f.target);
        fs.writeFileSync(path.join(f.target, "sentinel"), "do not touch");
      }
      return result;
    };
    f = fixture(t, kind, { fsImpl });
    fs.mkdirSync(f.target);
    fs.writeFileSync(path.join(f.target, "old"), "recover me");
    await assert.rejects(kind === "memory" ? f.installer.configure(true) : f.installer.install());
    assert.deepEqual(fs.readdirSync(f.target), ["sentinel"]);
    assert.equal(fs.readFileSync(path.join(f.target, "sentinel"), "utf8"), "do not touch");
    const backupRoot = kind === "memory" ? f.backups : f.real + "-old";
    const backup = fs.readdirSync(backupRoot).find((name) => name.startsWith(kind === "memory" ? "project-code-memory-" : ".coding-discipline-old-"));
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(backupRoot, backup, "old"), "utf8"), "recover me");
  }
});

test("Project Memory rejects a redirected workspace colliding with the skills root", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.alias);
  const real = path.join(f.root, "claude-proxy");
  fs.mkdirSync(real);
  link(real, f.alias);
  await assert.rejects(f.installer.install(), { code: "PROJECT_MEMORY_CONFLICT" });
  assert.deepEqual(fs.readdirSync(real), []);
});
