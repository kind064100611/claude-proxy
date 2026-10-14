const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMacosService, SERVICE_LABEL } = require("../lib/macos-service");

const makeHarness = (overrides = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "macos-service-test-&<")));
  const configRoot = path.join(root, "config");
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(path.join(configRoot, "claude-proxy", "macos-service"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(configRoot, "claude-proxy"), 0o700);
  fs.chmodSync(path.join(configRoot, "claude-proxy", "macos-service"), 0o700);
  fs.mkdirSync(path.join(root, "Library", "LaunchAgents"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "mac"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "mac", "proxy.js"), "// test proxy");
  const calls = [];
  let forkCalls = 0;
  const plistPath = path.join(root, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    let result = { stdout: "", stderr: "", code: 0 };
    if (file === "/bin/launchctl" && args[0] === "print" && args[1] === `gui/${process.getuid()}`) {
      result = overrides.gui === false ? { code: 113, stderr: "Could not find domain" } : result;
    } else if (file === "/bin/launchctl" && args[0] === "print" && args[1].startsWith(`gui/${process.getuid()}/`)) {
      result = typeof overrides.job === "function" ? overrides.job(args) : overrides.job || { code: 113, stderr: "Could not find service" };
    } else if (file === "/usr/bin/plutil") {
      result = overrides.plutil || { code: 1, stderr: "missing plist" };
    } else if (file === process.execPath && args.includes("--help")) {
      result = { stdout: "--use-openssl-ca --use-system-ca --tls-min-v1.2 --tls-max-v1.3", code: 0 };
    } else if (file === "/bin/ps") {
      result = overrides.ps || { stdout: "", code: 1 };
    }
    callback(result.code ? Object.assign(new Error(result.stderr || "command failed"), { code: result.code, stdout: result.stdout, stderr: result.stderr }) : null, result.stdout, result.stderr);
  };
  const service = (options = {}) => createMacosService({
    platform: "darwin", home: root, configRoot, nodePath: process.execPath, proxyPath: path.join(repoRoot, "mac", "proxy.js"),
    uid: process.getuid(), env: {}, execArgv: [], fsImpl: fs, execFileImpl,
    forkImpl: () => {
      forkCalls++;
      const listeners = new Map();
      return { on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); return this; },
        once(name, fn) { return this.on(name, fn); }, removeListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((item) => item !== fn)); },
        send(message, callback) { callback?.(); if (message.type === "prepare") for (const fn of listeners.get("message") || []) fn({ type: "ready", id: message.id }); },
        unref() {}, connected: true, channel: { unref() {} } };
    }, now: () => Date.now(), readyTimeoutMs: 50,
    ...options
  });
  return { root, configRoot, repoRoot, plistPath, calls, service, forkCount: () => forkCalls };
};

test("service identity and paths are isolated under the selected CLI root", (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  assert.equal(SERVICE_LABEL, "com.shanshazhe.claude-proxy");
  const service = h.service();
  assert.equal(service.internals.plistPath, path.join(h.root, "Library", "LaunchAgents", "com.shanshazhe.claude-proxy.plist"));
  assert.equal(service.internals.privateRoot, path.join(h.configRoot, "claude-proxy", "macos-service"));
  assert.equal(h.calls.length, 0);
  assert.equal(h.forkCount(), 0);
});

test("unsupported platform reports unavailable without process, filesystem, or launchctl side effects", async () => {
  let commands = 0;
  const result = await createMacosService({ platform: "linux", home: "/never", configRoot: "/never", nodePath: "node", proxyPath: "/never", uid: 1,
    env: {}, execArgv: [], fsImpl: { ...fs, mkdirSync() { assert.fail("filesystem mutation"); } },
    execFileImpl() { commands++; }, forkImpl() { assert.fail("must not fork"); } }).getStatus();
  assert.equal(result.supported, false);
  assert.equal(commands, 0);
});

test("missing GUI domain or uid is unavailable and sanitized", async (t) => {
  const h = makeHarness({ gui: false });
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const status = await h.service().getStatus();
  assert.equal(status.ready, false);
  assert.equal(status.registered, false);
  assert.equal(status.running, false);
  assert.doesNotMatch(JSON.stringify(status), /\/Users\/|config|stderr/i);
});

test("unsafe plist symlink and malformed plist are rejected", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(h.plistPath), { recursive: true });
  fs.symlinkSync(path.join(h.root, "outside"), h.plistPath);
  assert.equal((await h.service().getStatus()).ready, false);
  fs.unlinkSync(h.plistPath);
  fs.writeFileSync(h.plistPath, "bad");
  const status = await h.service().getStatus();
  assert.equal(status.ready, false);
  assert.equal(status.registered, false);
});

test("launchctl absence codes 113 and 3 are treated as an unregistered job", async (t) => {
  for (const code of [113, 3]) {
    const h = makeHarness({ job: { code, stderr: "absent" } });
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    const result = await h.service().getStatus();
    assert.equal(result.registered, false);
    assert.equal(result.running, false);
    assert.equal(result.ready, true, JSON.stringify(result));
    assert.equal(result.state, "missing");
    assert.equal(h.forkCount(), 0);
  }
});

test("unsafe environment and unsupported TLS arguments are rejected without exposing values", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  for (const env of [{ OPENAI_API_KEY: "secret" }, { PI_AUTH_FILE: "/private/auth.json" },
    { OPENAI_BASE_URL: "https://custom.example/v1" }]) {
    const status = await h.service({ env }).getStatus();
    assert.equal(status.ready, false);
    assert.doesNotMatch(JSON.stringify(status), /secret|auth\.json|custom\.example/);
  }
  const tlsStatus = await h.service({ execArgv: ["--tls-reject-unauthorized=0"] }).getStatus();
  assert.equal(tlsStatus.ready, false);
  assert.doesNotMatch(JSON.stringify(tlsStatus), /tls-reject|unauthorized/);
});

test("launchctl job parser returns the expected protected identity fields", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const args = [process.execPath, path.join(h.repoRoot, "mac", "proxy.js")];
  const output = `gui/${process.getuid()}/${SERVICE_LABEL} = {\n path = ${h.plistPath}\n program = ${process.execPath}\n working directory = ${h.repoRoot}\n arguments = {\n  0 = ${args[0]}\n  1 = ${args[1]}\n }\n state = running\n pid = ${process.pid}\n}\n`;
  const service = h.service({ execFileImpl: (file, commandArgs, options, callback) => {
    const isJob = file === "/bin/launchctl" && commandArgs[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`;
    callback(isJob ? null : Object.assign(new Error("unexpected mock command"), { code: 113 }), isJob ? output : "", "");
  } });
  const job = await service.internals.job();
  assert.deepEqual(job, { program: process.execPath, path: h.plistPath, args, workingDirectory: h.repoRoot, environment: {}, pid: process.pid, running: true });
});

test("matching running service is a no-op even with transfer-blocked environment", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const args = [process.execPath, path.join(h.repoRoot, "mac", "proxy.js")];
  const plist = { Label: SERVICE_LABEL, ProgramArguments: args, WorkingDirectory: h.repoRoot, RunAtLoad: true, KeepAlive: true };
  fs.writeFileSync(h.plistPath, "stable plist bytes");
  const originalBytes = fs.readFileSync(h.plistPath);
  const jobOutput = `gui/${process.getuid()}/${SERVICE_LABEL} = {\n path = ${h.plistPath}\n program = ${process.execPath}\n working directory = ${h.repoRoot}\n arguments = {\n  0 = ${args[0]}\n  1 = ${args[1]}\n }\n state = running\n pid = ${process.pid}\n}\n`;
  const execFileImpl = (file, commandArgs, options, callback) => {
    if (file === "/usr/bin/plutil") return callback(null, JSON.stringify(plist), "");
    if (file === "/bin/launchctl" && commandArgs[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`) return callback(null, jobOutput, "");
    if (file === "/bin/ps") return callback(null, "identity", "");
    return callback(null, "", "");
  };
  const service = h.service({ env: { OPENAI_API_KEY: "not-transferable" }, execFileImpl });
  const status = await service.getStatus(true);
  assert.equal(status.running, true, JSON.stringify(status));
  assert.equal(status.ready, true);
  assert.equal(status.instance.pid, process.pid);
  assert.match(status.instance.installationId, /^[a-f0-9]{64}$/);
  const result = await service.configure();
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "already_registered");
  assert.equal(h.forkCount(), 0);
  assert.deepEqual(fs.readFileSync(h.plistPath), originalBytes);
});

test("matching stopped registration is reusable without rewriting its plist", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const args = [process.execPath, path.join(h.repoRoot, "mac", "proxy.js")];
  const plist = { Label: SERVICE_LABEL, ProgramArguments: args, WorkingDirectory: h.repoRoot, RunAtLoad: true, KeepAlive: true, EnvironmentVariables: {} };
  fs.writeFileSync(h.plistPath, "preexisting safe plist");
  const original = fs.readFileSync(h.plistPath);
  const execFileImpl = (file, commandArgs, options, callback) => {
    if (file === "/usr/bin/plutil") return callback(null, JSON.stringify(plist), "");
    if (file === "/bin/ps") return callback(null, "stable process start identity", "");
    if (file === "/bin/launchctl" && commandArgs[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`) return callback(Object.assign(new Error("absent"), { code: 113 }), "", "absent");
    return callback(null, "", "");
  };
  const service = h.service({ execFileImpl });
  const status = await service.getStatus(true);
  assert.equal(status.registered, true);
  assert.equal(status.running, false);
  assert.equal(status.state, "stopped");
  assert.equal(status.ready, true);
  const result = await service.configure();
  assert.equal(result.status, 202);
  assert.equal(typeof result.activate, "function");
  assert.equal(typeof result.cancel, "function");
  assert.equal(h.forkCount(), 1);
  assert.deepEqual(fs.readFileSync(h.plistPath), original);
});

test("new registration serializes only the allowlisted environment and XML-escapes paths", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  let stagedXml = "";
  const service = h.service({ env: { NODE_OPTIONS: "--use-system-ca", OPENAI_PROMPT_CACHE: "0", CLAUDE_PROMPT_CACHE: "1",
    DISABLE_PROMPT_CACHING_SONNET: "1", PI_CACHE_RETENTION: "long", CODEX_CLIENT_VERSION: "1.2.3",
    UNSUPPORTED_RATE_SETTING: "12.5", OPENAI_API_KEY: "", DEBUG_VERBOSE: "0" },
    execFileImpl: (file, args, options, callback) => {
      if (file === "/usr/bin/plutil" && args[0] === "-lint") return callback(null, "", "");
      if (file === "/bin/ps") return callback(null, "stable process identity", "");
      if (file === "/bin/launchctl" && args[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`) return callback(Object.assign(new Error("absent"), { code: 3 }), "", "");
      return callback(null, "--use-system-ca", "");
    },
    forkImpl: (helperPath, args) => {
      const record = JSON.parse(fs.readFileSync(args[0], "utf8"));
      stagedXml = fs.readFileSync(record.stagePath, "utf8");
      const listeners = new Map();
      return { on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); return this; }, once(name, fn) { return this.on(name, fn); },
        removeListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((item) => item !== fn)); },
        send(message, callback) { callback?.(); if (message.type === "prepare") for (const fn of listeners.get("message") || []) fn({ type: "ready", id: message.id }); },
        unref() {}, connected: true, channel: { unref() {} } };
    }
  });
  const result = await service.configure();
  assert.equal(result.status, 202);
  assert.match(stagedXml, /macos-service-test-&amp;&lt;/);
  assert.match(stagedXml, /--use-system-ca/);
  for (const [name, value] of Object.entries({ OPENAI_PROMPT_CACHE: "0", CLAUDE_PROMPT_CACHE: "1",
    DISABLE_PROMPT_CACHING_SONNET: "1", PI_CACHE_RETENTION: "long", CODEX_CLIENT_VERSION: "1.2.3" })) {
    assert.match(stagedXml, new RegExp(`<key>${name}<\\/key><string>${value}<\\/string>`));
  }
  assert.doesNotMatch(stagedXml, /UNSUPPORTED_RATE_SETTING|OPENAI_API_KEY|DEBUG_VERBOSE/);
});

test("failed helper readiness leaves recovery information but never hands off the proxy", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  let handoffs = 0;
  const service = h.service({ readyTimeoutMs: 5, onHandoff: () => { handoffs++; },
    execFileImpl: (file, args, options, callback) => {
      if (file === "/usr/bin/plutil" && args[0] === "-lint") return callback(null, "", "");
      if (file === "/bin/ps") return callback(null, "stable process identity", "");
      if (file === "/bin/launchctl" && args[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`) return callback(Object.assign(new Error("absent"), { code: 113 }), "", "");
      callback(null, "", "");
    },
    forkImpl: () => ({ on() { return this; }, once() { return this; }, removeListener() {}, send(message, callback) { callback?.(); },
      unref() {}, connected: true, channel: { unref() {} } })
  });
  await assert.rejects(service.configure(), /prepare/i);
  assert.equal(handoffs, 0);
  const status = await service.getStatus(true);
  assert.equal(status.state, "failed");
  assert.equal(status.operation.errorCode, "preparation");
});

test("loaded job or existing plist with a different installation is a conflict", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const plist = { Label: SERVICE_LABEL, ProgramArguments: [process.execPath, "/other/proxy.js"], WorkingDirectory: "/other", RunAtLoad: true, KeepAlive: true };
  fs.writeFileSync(h.plistPath, "conflicting plist");
  const service = h.service({ execFileImpl: (file, args, options, callback) => {
    if (file === "/usr/bin/plutil") return callback(null, JSON.stringify(plist), "");
    if (file === "/bin/launchctl" && args[1] === `gui/${process.getuid()}/${SERVICE_LABEL}`) return callback(null, `gui/${process.getuid()}/${SERVICE_LABEL} = {\n path = /other/job.plist\n program = /other/node\n working directory = /other\n arguments = {\n  0 = /other/node\n  1 = /other/proxy.js\n }\n state = running\n pid = ${process.pid}\n}\n`, "");
    return callback(null, "", "");
  } });
  const status = await service.getStatus(true);
  assert.equal(status.ready, false);
  assert.equal(status.state, "conflict");
  await assert.rejects(service.configure(), /existing service|files/i);
  assert.equal(h.forkCount(), 0);
});

function preparationExec(file, args, options, callback) {
  if (file === "/bin/ps") return callback(null, "stable identity");
  if (file === "/bin/launchctl" && args[1].includes(SERVICE_LABEL)) return callback(Object.assign(new Error(), { code: 113 }));
  callback(null, "");
}

test("readonly status performs no writes or service/model startup and is briefly cached", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const service = h.service({ fsImpl: { ...fs, writeFileSync() { assert.fail("status write"); }, mkdirSync() { assert.fail("status mkdir"); },
    renameSync() { assert.fail("status rename"); } } });
  const status = await service.getStatus();
  assert.equal(status.ready, true);
  const count = h.calls.length;
  await service.getStatus();
  assert.equal(h.calls.length, count);
  assert.equal(h.forkCount(), 0);
  assert.equal(h.calls.some((call) => ["bootstrap", "bootout", "kickstart"].includes(call.args[0])), false);
});

test("parallel registration uses one helper and preserves live lock despite age or unavailable process identity", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const service = h.service({ execFileImpl: preparationExec });
  const results = await Promise.all(Array.from({ length: 8 }, () => service.configure()));
  assert.equal(new Set(results.map((result) => result.body.operationId)).size, 1);
  assert.equal(h.forkCount(), 1);
  const other = h.service({ now: () => Date.now() + 1e12, isAliveImpl: () => true, execFileImpl: (file, args, options, callback) => {
    if (file === "/bin/ps") return callback(Object.assign(new Error(), { code: 1 }));
    preparationExec(file, args, options, callback);
  } });
  assert.equal((await other.getStatus(true)).state, "pending");
  assert.equal((await other.configure()).body.operationId, results[0].body.operationId);
  assert.equal(h.forkCount(), 1);
});

test("a helper that dies after ready cannot strand an active lock or stop the current proxy", async (t) => {
  const { EventEmitter } = require("events");
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  let child;
  let handoffs = 0;
  const service = h.service({ execFileImpl: preparationExec, onHandoff: () => { handoffs++; }, forkImpl: () => {
    child = new EventEmitter();
    Object.assign(child, { connected: true, unref() {}, channel: { unref() {} }, send(message, callback) {
      callback?.();
      if (message.type === "prepare") setImmediate(() => child.emit("message", { type: "ready", id: message.id }));
    } });
    return child;
  } });
  const pending = await service.configure();
  child.connected = false;
  child.emit("exit", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(handoffs, 0);
  const status = await service.getStatus(true);
  assert.equal(status.operation.id, pending.body.operationId);
  assert.equal(status.operation.phase, "failed");
  assert.equal(status.operation.recovery, "recovered");
  assert.equal(fs.existsSync(service.internals.lockPath), false);
});

test("external modification during lint prevents publishing and is never removed or replaced", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  let stage;
  const service = h.service({ execFileImpl: (file, args, options, callback) => {
    if (file === "/usr/bin/plutil" && args[0] === "-lint") { stage = args[1]; fs.writeFileSync(stage, "external content"); }
    preparationExec(file, args, options, callback);
  } });
  await assert.rejects(service.configure(), /existing service|files/);
  assert.equal(fs.readFileSync(stage, "utf8"), "external content");
  assert.equal(fs.existsSync(h.plistPath), false);
  assert.equal(h.forkCount(), 0);
});

test("launchd disabled overrides, invalid uid and unsupported Node certificate flags are rejected", async (t) => {
  const h = makeHarness();
  t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
  const disabled = h.service({ execFileImpl: (file, args, options, callback) => {
    if (args[0] === "print-disabled") return callback(null, `{ "${SERVICE_LABEL}" => true }`);
    preparationExec(file, args, options, callback);
  } });
  assert.equal((await disabled.getStatus()).state, "conflict");
  assert.equal((await h.service({ uid: 0 }).getStatus()).ready, false);
  const oldNode = h.service({ execArgv: ["--use-system-ca"], execFileImpl: (file, args, options, callback) => {
    if (args[0] === "--help") return callback(null, "Node 18: --use-openssl-ca");
    preparationExec(file, args, options, callback);
  } });
  assert.equal((await oldNode.getStatus()).ready, false);
  await assert.rejects(oldNode.configure(), /startup environment|Node arguments/);
});

test("private symlinks, loose permissions and hardlinked log files are refused", async (t) => {
  for (const unsafe of ["symlink", "permissions", "hardlink"]) {
    const h = makeHarness();
    t.after(() => fs.rmSync(h.root, { recursive: true, force: true }));
    const privateRoot = path.join(h.configRoot, "claude-proxy", "macos-service");
    if (unsafe === "symlink") fs.symlinkSync(path.join(h.root, "outside"), path.join(privateRoot, "current.json"));
    else if (unsafe === "permissions") fs.chmodSync(privateRoot, 0o755);
    else {
      const target = path.join(h.root, "ordinary-private-file");
      fs.writeFileSync(target, "do not append", { mode: 0o600 });
      fs.linkSync(target, path.join(privateRoot, "stdout.log"));
    }
    const service = h.service({ execFileImpl: preparationExec });
    if (unsafe !== "hardlink") assert.equal((await service.getStatus()).ready, false);
    await assert.rejects(service.configure());
    assert.equal(h.forkCount(), 0);
  }
});
