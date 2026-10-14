"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");
const crypto = require("node:crypto");
const { createStatuslineInstaller } = require("../lib/statusline-install");

const bundleRoot = path.resolve(__dirname, "../");
function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function installerFor(configRoot, extra = {}) { return createStatuslineInstaller({ configRoot, bundleRoot, ...extra }); }
function remove(target) { fs.rmSync(target, { recursive: true, force: true }); }

test("runtime provenance digest, MIT metadata and adapted wrapper are retained without a personal archive", () => {
  const root = path.join(bundleRoot, "statusline");
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name !== "SOURCE.md") files.push(file);
    }
  };
  walk(root);
  const hash = crypto.createHash("sha256");
  for (const file of files.sort()) hash.update(path.relative(root, file).split(path.sep).join("/") + "\0").update(fs.readFileSync(file)).update("\0");
  assert.equal(files.length, 48);
  assert.equal(files.filter((file) => file.endsWith(".js")).length, 44);
  const digest = "3e4ef5b74c17e9d354767cbf045968df492668d2724656c2541f000429346d9a";
  assert.equal(hash.digest("hex"), digest);
  assert.ok(fs.readFileSync(path.join(root, "SOURCE.md"), "utf8").includes(digest));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "claude-hud/package.json"))).license, "MIT");
  assert.match(fs.readFileSync(path.join(root, "claude-hud/LICENSE"), "utf8"), /MIT License/);
  const wrapper = path.join(root, "statusline-command.sh");
  assert.doesNotMatch(fs.readFileSync(wrapper, "utf8"), /Users\/[^/]+|CLAUDE_CONFIG_DIR/);
  assert.equal(fs.existsSync(path.join(root, "original")), false);
  execFileSync("bash", ["-n", wrapper]);
});

test("synchronous deployment is idempotent, private, self-contained, and created-only cleanup", () => {
  const root = temp("statusline home 'quoted' ");
  try {
    const installer = installerFor(root);
    assert.equal(installer.validateBundle(), true);
    const first = installer.deploy({ node: process.execPath, bash: "/bin/bash", jq: "/usr/bin/jq" });
    assert.equal(first.created, true);
    assert.equal(installer.isConfigured({ type: "command", command: first.command }), true);
    const second = installer.deploy({ node: process.execPath, bash: "/bin/bash", jq: "/usr/bin/jq" });
    assert.equal(second.created, false);
    assert.equal(first.directory, second.directory);
    assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(first.directory, "statusline-launcher.sh")).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(first.directory, "original/statusline-command.sh")), false);
    assert.equal(installer.cleanup(second), false);
    assert.equal(fs.existsSync(first.directory), true);
    assert.equal(installer.cleanup(first), true);
    assert.equal(installer.cleanup(first), true);
    assert.equal(fs.existsSync(first.directory), false);
  } finally { remove(root); }
});

test("real launcher renders synthetic HUD and cache warm, dropped, and hit states", () => {
  const root = temp("statusline synthetic 'quoted' ");
  const cwd = path.join(root, "project with spaces");
  const transcript = path.join(root, "transcript with spaces.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "synthetic only" }, timestamp: new Date().toISOString() }) + "\n");
  const relocatedBundle = path.join(root, "repository-copy");
  fs.cpSync(path.join(bundleRoot, "statusline"), path.join(relocatedBundle, "statusline"), { recursive: true });
  const installer = installerFor(path.join(root, "claude config"), { bundleRoot: relocatedBundle });
  const preload = path.join(root, "mock-system-probes.cjs");
  fs.writeFileSync(preload, `const childProcess = require("node:child_process");
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, ...args) => {
  if (["ps", "/bin/ps", "/usr/bin/vm_stat"].includes(file)) return "";
  if (/launchctl|plutil|lsof/.test(file)) throw new Error("Unmocked system management command");
  return original(file, ...args);
};
require("node:module").syncBuiltinESMExports();\n`);
  try {
    const deployment = installer.deploy({ node: process.execPath, bash: "/bin/bash", jq: "/usr/bin/jq" });
    remove(relocatedBundle);
    const common = { cwd, transcript_path: transcript, model: { display_name: "Synthetic" }, context_window: { used_percentage: 25, remaining_percentage: 75, context_window_size: 200000, current_usage: { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 } } };
    const invoke = (value) => execSync(deployment.command, { input: JSON.stringify(value), cwd, encoding: "utf8", env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, USERPROFILE: root,
      CLAUDE_CONFIG_DIR: path.join(root, "claude config"), LANG: "en_US.UTF-8", NODE_OPTIONS: `--require=${JSON.stringify(preload)}`
    } });
    const warm = invoke({ ...common, prompt_cache: { caching_observed: true, warm: true, misses: 2, hit_ratio: 0.75 } });
    const dropped = invoke({ ...common, prompt_cache: { caching_observed: true, warm: false, misses: 4, hit_ratio: 0.5, last_miss_cause: { causes: ["synthetic cause"] } } });
    const hit = invoke({ ...common, prompt_cache: null });
    assert.match(warm, /Synthetic/);
    assert.match(warm, /warm/);
    assert.match(warm, /miss:2 hit:75%/);
    assert.match(dropped, /dropped/);
    assert.match(dropped, /synthetic cause/);
    assert.match(dropped, /miss:4 hit:50%/);
    assert.match(hit, /Cache:.*hit:60%/);
    const pluginRoot = path.join(deployment.directory, "claude-hud", "plugins", "claude-hud");
    assert.ok(fs.existsSync(pluginRoot));
    assert.ok(fs.readdirSync(pluginRoot).some((name) => name.endsWith(".json")));
    assert.equal(fs.existsSync(path.join(root, ".claude", "plugins", "claude-hud")), false);
    installer.cleanup(deployment);
  } finally { remove(root); }
});

test("bundle graph is bundled or node builtins only and rejects missing files", () => {
  const root = temp("statusline graph ");
  try {
    assert.equal(installerFor(root).validateBundle(), true);
    assert.throws(() => installerFor(root, { bundleRoot: root }).validateBundle());
  } finally { remove(root); }
});

test("deployment rejects symlinked owned directories and failed staging leaves no generation", () => {
  const root = temp("statusline unsafe ");
  const outside = temp("statusline external ");
  try {
    const owned = path.join(root, "claude-proxy");
    fs.symlinkSync(outside, owned);
    assert.throws(() => installerFor(root).deploy(), /Unsafe statusline directory/);
  } finally { remove(root); remove(outside); }
  const failingRoot = temp("statusline failing ");
  try {
    const faultyFs = Object.create(fs);
    faultyFs.copyFileSync = () => { throw new Error("synthetic copy failure"); };
    assert.throws(() => installerFor(failingRoot, { fsImpl: faultyFs }).deploy(), /synthetic copy failure/);
    const installDir = path.join(failingRoot, "claude-proxy", "statusline");
    assert.deepEqual(fs.readdirSync(installDir), []);
  } finally { remove(failingRoot); }
});

test("reused generations verify runtime bytes and do not accept foreign commands", () => {
  const root = temp("statusline verify ");
  try {
    const installer = installerFor(root);
    const dependencies = { node: process.execPath, bash: "/bin/bash", jq: "/usr/bin/jq" };
    const installed = installer.deploy(dependencies);
    assert.equal(installer.isConfigured({ type: "command", command: installed.command.replace(root, "/foreign/root") }), false);
    const module = path.join(installed.directory, "claude-hud/dist/stdin.js");
    fs.appendFileSync(module, "\n// altered\n");
    assert.throws(() => installer.deploy(dependencies), /failed verification/);
    assert.ok(fs.readFileSync(module, "utf8").endsWith("// altered\n"));
  } finally { remove(root); }
});

test("Windows command and launcher convert drive paths and quote spaces/apostrophes without settings env", () => {
  const root = temp("statusline windows ");
  try {
    const installer = installerFor(root, { platform: "win32" });
    const installed = installer.deploy({ node: "C:\\Node's folder\\node.exe", bash: "C:\\Program Files\\Git\\bin\\bash.exe", jq: "C:\\Tools folder\\jq.exe" });
    assert.match(installed.command, /^'\/c\/Program Files\/Git\/bin\/bash.exe'/);
    const launcher = fs.readFileSync(path.join(installed.directory, "statusline-launcher.sh"), "utf8");
    assert.ok(launcher.includes("export TOOLKIT_NODE='/c/Node'\\''s folder/node.exe'"));
    assert.ok(launcher.includes("export TOOLKIT_JQ='/c/Tools folder/jq.exe'"));
    assert.ok(launcher.includes("exec '/c/Program Files/Git/bin/bash.exe'"));
    assert.doesNotMatch(launcher, /CLAUDE_CONFIG_DIR/);
    execFileSync("bash", ["-n", path.join(installed.directory, "statusline-launcher.sh")]);
  } finally { remove(root); }
});
