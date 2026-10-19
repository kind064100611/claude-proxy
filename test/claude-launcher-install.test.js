"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createClaudeLauncherInstaller } = require("../lib/claude-launcher-install");
const { getStatus, setFeatures } = require("../lib/online-summary");

const START = "# >>> claude-proxy capacity launcher >>>";
const END = "# <<< claude-proxy capacity launcher <<<";
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const signedInStore = { readAuth: () => ({ openai: { type: "api_key", key: "test-gpt-key" } }) };
function block(node, launcher, eol = "\n") {
  return [START, "claude() {", "  local node_command",
    `  node_command="$(whence -p node)" || node_command=${quote(node)}`,
    `  "$node_command" ${quote(launcher)} "$@"`, "}", END].join(eol) + eol;
}
function testZsh(name, options, run) {
  if (typeof options === "function") { run = options; options = {}; }
  return test(name, { ...options, skip: process.platform === "win32"
    ? "zsh filesystem/install/status tests require POSIX paths and permissions"
    : options.skip }, run);
}
function fixture(t, options = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-install-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configRoot = path.join(home, "cli-config");
  const featureFile = path.join(home, "features.json");
  const target = path.join(home, ".zshrc");
  const launcher = path.resolve(__dirname, "../lib/claude-launch.js");
  const installer = createClaudeLauncherInstaller({ home, configRoot, featureFile, env: {}, store: signedInStore, platform: "darwin", ...options });
  const backups = () => {
    const directory = path.join(configRoot, "claude-proxy/zsh-backups");
    return fs.existsSync(directory) ? fs.readdirSync(directory).map((name) => path.join(directory, name)) : [];
  };
  return { home, configRoot, featureFile, target, launcher, installer, backups };
}

testZsh("first install preserves bytes and mode, creates private digest backup, and is idempotent", async (t) => {
  const f = fixture(t);
  const original = Buffer.from("# user config\r\nexport EXAMPLE=yes");
  fs.writeFileSync(f.target, original, { mode: 0o640 });
  assert.equal((await f.installer.getStatus()).state, "absent");
  assert.equal(f.backups().length, 0);
  assert.equal((await f.installer.autoEnable()).changed, true);
  const installed = fs.readFileSync(f.target);
  assert.ok(installed.subarray(0, original.length).equals(original));
  assert.ok(installed.toString().includes(block(process.execPath, f.launcher)));
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o640);
  assert.equal(f.backups().length, 1);
  assert.deepEqual(fs.readFileSync(f.backups()[0]), original);
  assert.equal(fs.statSync(f.backups()[0]).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.backups()[0])).mode & 0o777, 0o700);
  const before = fs.statSync(f.target);
  const featureBefore = fs.statSync(f.featureFile);
  await Promise.all([f.installer.autoEnable(), f.installer.autoEnable()]);
  assert.deepEqual(fs.readFileSync(f.target), installed);
  assert.equal(fs.statSync(f.target).ino, before.ino);
  assert.equal(fs.statSync(f.featureFile).ino, featureBefore.ino);
  assert.equal(f.backups().length, 1);
});

testZsh("missing file is created privately without an invented backup", async (t) => {
  const f = fixture(t);
  await f.installer.autoEnable();
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
  assert.equal(f.backups().length, 0);
  assert.equal(getStatus(f.featureFile).claudeLauncher, true);
});

testZsh("exact manual block is adopted without touching zshrc or making backups", async (t) => {
  const f = fixture(t);
  const original = "# before\n" + block(process.execPath, f.launcher) + "# after\n";
  fs.writeFileSync(f.target, original);
  const before = fs.statSync(f.target);
  assert.equal((await f.installer.autoEnable()).changed, false);
  assert.equal(fs.statSync(f.target).ino, before.ino);
  assert.equal(fs.readFileSync(f.target, "utf8"), original);
  assert.equal(f.backups().length, 0);
});

testZsh("only exact stale templates are updated; disable keeps later user configuration", async (t) => {
  const f = fixture(t);
  const before = "# before\n";
  const after = "export LATER=keep\n";
  fs.writeFileSync(f.target, before + block("/old/node", "/old/repo/lib/claude-launch.js") + after);
  await f.installer.autoEnable();
  assert.equal(fs.readFileSync(f.target, "utf8"), before + block(process.execPath, f.launcher) + after);
  setFeatures({ onlineSummary: false, summaryModel: "example", projectMemory: true }, f.featureFile);
  await f.installer.configure(false);
  assert.equal(fs.readFileSync(f.target, "utf8"), before + after);
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
  assert.equal(await f.installer.autoEnable(), null);
  assert.equal(fs.readFileSync(f.target, "utf8"), before + after);
  await f.installer.configure(true);
  const features = getStatus(f.featureFile);
  assert.equal(features.claudeLauncher, true);
  assert.equal(features.onlineSummary, false);
  assert.equal(features.summaryModel, "example");
  assert.equal(features.projectMemory, true);
});

test("zsh adapter preserves the original function template, quoting and byte offsets", () => {
  const { createZshProfile } = require("../lib/claude-launcher-zsh");
  const profile = createZshProfile({ home: "/home/test", env: {}, platform: "darwin", start: START, end: END,
    execFileSync() { throw new Error("template checks must not execute a shell"); } });
  for (const eol of ["\n", "\r\n"]) {
    const node = "/node ' quoted";
    const launcher = "/repo ' quoted/lib/claude-launch.js";
    const rendered = profile.render(node, launcher, eol);
    assert.equal(rendered + eol, block(node, launcher, eol));
    assert.deepEqual(profile.parse(rendered, eol), { node, launcher });
  }
  const bytes = Buffer.from([35, 32, 255, 254, 10]);
  const view = profile.decode(bytes);
  assert.equal(view.offset(view.text.length), bytes.length);
  assert.equal(view.encoding, "utf8");
  assert.equal(profile.target(), path.join("/home/test", ".zshrc"));
});

test("unsupported platforms and shell configurations skip before touching any files or credentials", async () => {
  const fsImpl = new Proxy({}, { get() { throw new Error("must not access fs"); } });
  let credentialReads = 0;
  const store = { readAuth() { credentialReads++; throw new Error("must not read credentials"); } };
  for (const options of [{ platform: "linux" },
    { platform: "darwin", env: { SHELL: "/bin/bash" } },
    { platform: "darwin", env: { ZDOTDIR: "/custom/zsh" } }]) {
    const installer = createClaudeLauncherInstaller({ home: "/test/home", env: {}, fsImpl, store, ...options });
    assert.equal(await installer.autoEnable(), null);
    assert.equal((await installer.getStatus()).state, "skipped");
    assert.equal(await installer.configure(true), null);
  }
  assert.equal(credentialReads, 0);
});

test("automatic installation without GPT credentials never accesses shell, features or backups", async () => {
  const oauth = { type: "oauth", access: "copilot", refresh: "refresh", expires: 1 };
  for (const auth of [{}, { "github-copilot": oauth }, new Error("private credential error")]) {
    let reads = 0;
    let fileAccesses = 0;
    let shellCalls = 0;
    const warnings = [];
    const store = { readAuth(options) {
      reads++;
      assert.deepEqual(options, { readOnly: true });
      if (auth instanceof Error) throw auth;
      return auth;
    } };
    const fsImpl = new Proxy({}, { get() { fileAccesses++; throw new Error("must not access fs"); } });
    const installer = createClaudeLauncherInstaller({ home: "/test/home", platform: "darwin", env: {}, store, fsImpl,
      execFileSync() { shellCalls++; throw new Error("must not execute shell"); },
      onWarning: (message) => warnings.push(message) });
    assert.equal(await installer.autoEnable(), null);
    assert.equal(reads, 1);
    assert.equal(fileAccesses, 0);
    assert.equal(shellCalls, 0);
    assert.deepEqual(warnings, []);
  }
});

testZsh("OPENAI_API_KEY permits automatic installation without stored GPT credentials", async (t) => {
  const f = fixture(t, { env: { OPENAI_API_KEY: "test-env-key" }, store: { readAuth: () => ({}) } });
  assert.equal((await f.installer.autoEnable()).ok, true);
  assert.equal(getStatus(f.featureFile).claudeLauncher, true);
});

testZsh("automatic installation checks credentials only after earlier queued work finishes", async (t) => {
  let auth = { openai: { type: "api_key", key: "test-key" } };
  let reads = 0;
  const f = fixture(t, { store: { readAuth() { reads++; return auth; } }, execFileSync(command, args) {
    if (args[0] === "--version") {
      auth = {};
      return process.version;
    }
  } });
  const install = f.installer.configure(true);
  const automatic = f.installer.autoEnable();
  assert.equal(reads, 0);
  assert.equal((await install).ok, true);
  assert.equal(await automatic, null);
  assert.equal(reads, 1);
  assert.equal(fs.readFileSync(f.target, "utf8"), block(process.execPath, f.launcher));
});

testZsh("logout preserves an installed launcher and feature state but does not prevent manual disable", async (t) => {
  let auth = { openai: { type: "api_key", key: "test-key" } };
  let reads = 0;
  const f = fixture(t, { store: { readAuth() { reads++; return auth; } } });
  fs.writeFileSync(f.target, "# user config\n");
  assert.equal((await f.installer.autoEnable()).ok, true);
  const installed = fs.readFileSync(f.target);
  const feature = fs.readFileSync(f.featureFile);
  const backups = f.backups();
  const shellInfo = fs.statSync(f.target);
  const featureInfo = fs.statSync(f.featureFile);
  auth = {};
  assert.equal(await f.installer.autoEnable(), null);
  assert.deepEqual(fs.readFileSync(f.target), installed);
  assert.deepEqual(fs.readFileSync(f.featureFile), feature);
  assert.equal(fs.statSync(f.target).ino, shellInfo.ino);
  assert.equal(fs.statSync(f.featureFile).ino, featureInfo.ino);
  assert.deepEqual(f.backups(), backups);
  assert.equal(reads, 2);
  assert.equal((await f.installer.configure(false)).ok, true);
  assert.equal(reads, 2);
  assert.equal(fs.readFileSync(f.target, "utf8"), "# user config\n");
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
});

test("importing the installer is inert even with maintenance arguments", (t) => {
  const f = fixture(t);
  const modulePath = path.resolve(__dirname, "../lib/claude-launcher-install.js");
  const script = `const fs = require('fs');
    for (const name of ['writeFileSync','mkdirSync','chmodSync','renameSync','linkSync','unlinkSync'])
      fs[name] = () => { throw new Error('module import wrote files'); };
    for (const name of ['readFileSync','lstatSync','statSync','accessSync','existsSync','openSync']) {
      const original = fs[name];
      fs[name] = (file, ...args) => {
        if (typeof file === 'string' && file.startsWith(${JSON.stringify(f.home)})) throw new Error('module import read user files');
        return original(file, ...args);
      };
    }
    require(${JSON.stringify(modulePath)});`;
  const result = spawnSync(process.execPath, ["-e", script, "--", "--enable"], {
    env: { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.configRoot }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test("factory construction never accesses the injected filesystem", () => {
  const fsImpl = new Proxy({}, { get() { throw new Error("construction accessed fs"); } });
  assert.doesNotThrow(() => createClaudeLauncherInstaller({ platform: "darwin", env: {}, fsImpl }));
});

testZsh("maintenance commands enable/disable using only a temporary home and config root", (t) => {
  if (process.platform !== "darwin" || !fs.existsSync("/bin/zsh")) return t.skip("macOS + zsh required for maintenance commands");
  const f = fixture(t);
  const env = { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.configRoot, SHELL: "/bin/zsh", ZDOTDIR: f.home };
  const command = path.resolve(__dirname, "../lib/claude-launcher-install.js");
  for (const option of ["--enable", "--disable", "--enable"]) {
    const result = spawnSync(process.execPath, [command, option], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const enabled = option === "--enable";
    const featureFile = path.join(f.home, ".claude/gateway-features.json");
    assert.equal(getStatus(featureFile).claudeLauncher, enabled);
    assert.equal(fs.readFileSync(f.target, "utf8").includes(START), enabled);
  }
});

testZsh("construction is inert and status never writes or executes the shell", async (t) => {
  const f = fixture(t);
  const fsImpl = new Proxy(fs, { get(target, name) {
    if (/^(write|mkdir|chmod|rename|link|unlink)/.test(String(name))) return () => { throw new Error("write attempted"); };
    return target[name];
  } });
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot,
    featureFile: f.featureFile, platform: "darwin", env: {}, store: signedInStore, fsImpl,
    execFileSync() { throw new Error("status must not execute"); } });
  assert.equal((await installer.getStatus()).state, "absent");
  assert.deepEqual(fs.readdirSync(f.home), []);
});

testZsh("syntax failure and concurrent edits abort safely and clean temporary files", async (t) => {
  for (const concurrent of [false, true]) {
    let f;
    f = fixture(t, { execFileSync(command, args) {
      if (args[0] === "--version") return "v22.0.0";
      assert.equal(command, "/bin/zsh");
      assert.deepEqual(args.slice(0, 2), ["-f", "-n"]);
      if (concurrent) fs.writeFileSync(f.target, "# concurrent user edit\n");
      else throw new Error("syntax error");
    } });
    fs.writeFileSync(f.target, "# original\n");
    assert.equal((await f.installer.autoEnable()).ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), concurrent ? "# concurrent user edit\n" : "# original\n");
    assert.deepEqual(fs.readdirSync(f.home).filter((name) => name.endsWith(".tmp")), []);
  }
});

testZsh("a concurrent persistent opt-out is never reset by automatic installation", async (t) => {
  let f;
  f = fixture(t, { execFileSync(command, args) {
    if (args[0] === "--version") {
      setFeatures({ claudeLauncher: false }, f.featureFile);
      return process.version;
    }
  } });
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
  assert.equal(fs.existsSync(f.target), false);
});

testZsh("an existing syntax error is checked without executing user configuration", async (t) => {
  if (!fs.existsSync("/bin/zsh")) return t.skip("zsh unavailable");
  const f = fixture(t);
  const marker = path.join(f.home, "must-not-run");
  const content = `touch ${quote(marker)}\nif then\n`;
  fs.writeFileSync(f.target, content);
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), content);
  assert.equal(fs.existsSync(marker), false);
});

testZsh("new-file publish cannot overwrite a concurrent new zshrc", async (t) => {
  let f;
  f = fixture(t, { execFileSync(command, args) {
    if (args[0] === "--version") return "v22.0.0";
    fs.writeFileSync(f.target, "# created concurrently\n");
  } });
  assert.equal((await f.installer.autoEnable()).ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), "# created concurrently\n");
});

testZsh("symlinks, directories, wrong ownership and unwritable files are preserved", async (t) => {
  for (const kind of ["symlink", "directory", "readonly", "owner"]) {
    const f = fixture(t);
    const original = path.join(f.home, "original");
    fs.writeFileSync(original, "# original\n");
    if (kind === "symlink") fs.symlinkSync(original, f.target);
    else if (kind === "directory") fs.mkdirSync(f.target);
    else fs.writeFileSync(f.target, "# original\n", { mode: kind === "readonly" ? 0o400 : 0o600 });
    const fsImpl = new Proxy(fs, { get(target, name) {
      if (kind === "owner" && ["lstatSync", "fstatSync"].includes(name)) return (...args) => {
        const stat = target[name](...args);
        if (stat.ino === fs.statSync(f.target).ino) stat.uid = process.getuid() + 1;
        return stat;
      };
      return target[name];
    } });
    const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot,
      featureFile: f.featureFile, platform: "darwin", env: {}, store: signedInStore, fsImpl });
    assert.equal((await installer.autoEnable()).ok, false);
    assert.equal(fs.readFileSync(original, "utf8"), "# original\n");
    assert.equal(f.backups().length, 0);
  }
});

testZsh("unsafe backup path and damaged feature configuration prevent modification", async (t) => {
  for (const kind of ["backup-link", "backup-bytes", "damaged-feature"]) {
    const f = fixture(t);
    const original = "# original\n";
    fs.writeFileSync(f.target, original);
    if (kind === "damaged-feature") fs.writeFileSync(f.featureFile, "{broken");
    else {
      fs.mkdirSync(path.join(f.configRoot, "claude-proxy"), { recursive: true });
      const directory = path.join(f.configRoot, "claude-proxy/zsh-backups");
      if (kind === "backup-link") fs.symlinkSync(f.home, directory);
      else {
        fs.mkdirSync(directory);
        const hash = require("node:crypto").createHash("sha256").update(original).digest("hex");
        fs.writeFileSync(path.join(directory, `zshrc-${hash}`), "corrupted backup");
      }
    }
    const result = await f.installer.autoEnable();
    if (kind === "damaged-feature") assert.equal(result, null);
    else assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(f.target, "utf8"), original);
  }
});

testZsh("spaces and quotes are escaped, arguments survive, and Node fallback works in a fresh zsh", async (t) => {
  if (!fs.existsSync("/bin/zsh")) return t.skip("zsh unavailable");
  const f = fixture(t);
  const repoRoot = path.join(f.home, "repo ' quoted");
  fs.mkdirSync(path.join(repoRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "lib/claude-launch.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const nodePath = path.join(f.home, "node ' fallback");
  fs.symlinkSync(process.execPath, nodePath);
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot,
    featureFile: f.featureFile, env: {}, store: signedInStore, platform: "darwin", repoRoot, nodePath });
  assert.equal((await installer.autoEnable()).ok, true);
  assert.equal(spawnSync("/bin/zsh", ["-f", "-n", f.target]).status, 0);
  const pathBin = path.join(f.home, "path-bin");
  fs.mkdirSync(pathBin);
  fs.writeFileSync(path.join(pathBin, "node"), `#!/bin/sh\nprintf 'PATH_NODE\\n'\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  for (const PATH of ["/usr/bin:/bin", pathBin + ":/usr/bin:/bin"]) {
    const result = spawnSync("/bin/zsh", ["-f", "-c", '. "$1"; whence -w claude; claude --version "space arg" "quote\'arg"', "zsh", f.target],
      { env: { HOME: f.home, PATH }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'claude: function\n' + (PATH.startsWith(pathBin) ? "PATH_NODE\n" : "") + '["--version","space arg","quote\'arg"]');
  }
  assert.equal((await installer.autoEnable()).changed, false);
  assert.equal((await installer.configure(false)).ok, true);
  assert.equal(fs.readFileSync(f.target, "utf8"), "");
});

testZsh("installed zsh function passes --version through to the real official CLI", {
  skip: process.env.RUN_CLAUDE_CLI_TESTS !== "1" || !fs.existsSync("/bin/zsh")
}, async (t) => {
  const f = fixture(t);
  const env = { ...process.env, HOME: f.home, CLAUDE_CONFIG_DIR: f.configRoot };
  const direct = spawnSync("claude", ["--version"], { env, encoding: "utf8", timeout: 15000 });
  if (direct.error?.code === "ENOENT") return t.skip("official CLI unavailable");
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal((await f.installer.autoEnable()).ok, true);
  const wrapped = spawnSync("/bin/zsh", ["-f", "-c", '. "$1"; claude --version', "zsh", f.target],
    { env, encoding: "utf8", timeout: 15000 });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.equal(wrapped.stdout, direct.stdout);
});

testZsh("digest backups are verified and reused across disable/enable cycles", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, "# unchanged original\n");
  await f.installer.autoEnable();
  await f.installer.configure(false);
  const backups = f.backups().sort();
  assert.equal(backups.length, 2);
  await f.installer.configure(true);
  await f.installer.configure(false);
  assert.deepEqual(f.backups().sort(), backups);
  assert.equal(fs.readFileSync(f.target, "utf8"), "# unchanged original\n");
});

testZsh("no-final-newline and non-UTF-8 bytes outside a stale block remain unchanged", async (t) => {
  const f = fixture(t);
  const prefix = Buffer.from([35, 32, 255, 254, 13, 10]);
  const original = Buffer.concat([prefix, Buffer.from(block("/old/node", "/old/repo/lib/claude-launch.js").trimEnd())]);
  fs.writeFileSync(f.target, original);
  assert.equal((await f.installer.autoEnable()).ok, true);
  assert.deepEqual(fs.readFileSync(f.target), Buffer.concat([prefix, Buffer.from(block(process.execPath, f.launcher).trimEnd())]));
  await f.installer.configure(false);
  assert.deepEqual(fs.readFileSync(f.target), prefix);
});

testZsh("disable repairs damaged feature JSON and persists opt-out even with a modified block", async (t) => {
  const f = fixture(t);
  const modified = block(process.execPath, f.launcher).replace("local node_command", "local changed");
  fs.writeFileSync(f.target, modified);
  fs.writeFileSync(f.featureFile, "{ damaged");
  assert.equal((await f.installer.configure(false)).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(f.featureFile, "utf8")).claudeLauncher, false);
  assert.equal(await f.installer.autoEnable(), null);
  assert.equal(fs.readFileSync(f.target, "utf8"), modified);
});

testZsh("a missing feature file under a symlinked config parent is disabled", async (t) => {
  const f = fixture(t);
  const link = path.join(f.home, "linked-config");
  const destination = path.join(f.home, "destination");
  fs.mkdirSync(destination);
  fs.symlinkSync(destination, link);
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot,
    featureFile: path.join(link, "features.json"), platform: "darwin", env: {}, store: signedInStore });
  assert.equal(await installer.autoEnable(), null);
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(fs.readdirSync(destination), []);
});

testZsh("new-file atomic publication refuses a file created after final validation", async (t) => {
  const f = fixture(t);
  const fsImpl = new Proxy(fs, { get(target, name) {
    if (name === "linkSync") return (from, to) => {
      if (to === f.target) fs.writeFileSync(to, "# last-moment new file\n");
      return target.linkSync(from, to);
    };
    return target[name];
  } });
  const installer = createClaudeLauncherInstaller({ home: f.home, configRoot: f.configRoot,
    featureFile: f.featureFile, platform: "darwin", env: {}, store: signedInStore, fsImpl });
  assert.equal((await installer.autoEnable()).ok, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), "# last-moment new file\n");
  assert.equal(fs.readdirSync(f.home).some((file) => file.endsWith(".tmp")), false);
});

testZsh("invalid paths and failed Node probe never write shell configuration", async (t) => {
  for (const options of [{ nodePath: "/bad\nnode" }, { repoRoot: "/bad\tpath" },
    { execFileSync() { throw new Error("no Node"); } }]) {
    const f = fixture(t, options);
    assert.equal((await f.installer.autoEnable()).ok, false);
    assert.equal(fs.existsSync(f.target), false);
  }
});

for (const [name, content] of [
  ["alias", "alias claude='other'\n"], ["function", "function claude { print other; }\n"],
  ["function parentheses", "claude () { print other; }\n"],
  ["quoted alias", "alias 'claude=other'\n"],
  ["quoted alias name", "alias 'claude'='other'\n"],
  ["continued alias", "alias \\\n  claude=other\n"],
  ["inline conditional alias", "if true; then alias claude=other; fi\n"],
  ["quoted function name", "function 'claude' { print other; }\n"],
  ["missing end", START + "\n"], ["missing start", END + "\n"],
  ["duplicates", block("/node", "/repo/lib/claude-launch.js").repeat(2)],
  ["modified block", block("/node", "/repo/lib/claude-launch.js").replace('  local node_command', '  print modified')],
  ["outside definition", block("/node", "/repo/lib/claude-launch.js") + "alias claude=other\n"]
]) testZsh(`${name} conflict never overwrites user content`, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, content);
  const result = await f.installer.autoEnable();
  assert.equal(result.ok, false);
  assert.match(result.reason, /conflict|modified|marker|definition/i);
  assert.equal(fs.readFileSync(f.target, "utf8"), content);
  assert.equal(f.backups().length, 0);
  assert.equal(getStatus(f.featureFile).claudeLauncher, null);
  const disabled = await f.installer.configure(false);
  assert.equal(disabled.ok, false);
  assert.equal(getStatus(f.featureFile).claudeLauncher, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), content);
});
