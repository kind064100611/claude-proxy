const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { createMacosService, SERVICE_LABEL } = require("./macos-service");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const failure = (code) => Object.assign(new Error(), { helperCode: code });

function request(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: route, headers, timeout: 1500 }, (res) => {
      let text = "";
      res.on("data", (chunk) => {
        text += chunk;
        if (text.length > 128 * 1024) req.destroy(failure("verification"));
      });
      res.on("error", reject);
      res.on("end", () => res.statusCode === 200 ? resolve(text) : reject(failure("verification")));
    });
    const deadline = setTimeout(() => req.destroy(failure("verification")), 2000);
    req.once("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(failure("verification")));
    req.on("error", reject);
  });
}
async function verifyInstance(port, pid, installationId) {
  try {
    const page = await request(port, "/login");
    const nonce = page.match(/nonce="([a-zA-Z0-9_-]{43})"/)?.[1];
    if (!nonce) return false;
    const status = JSON.parse(await request(port, "/api/auth/status", { "X-Auth-Nonce": nonce }));
    return status.macosService?.instance?.pid === pid && status.macosService.instance.installationId === installationId;
  } catch (_) { return false; }
}
function portAvailable(port) {
  const check = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
  return Promise.all([check("127.0.0.1"), check("::1")]).then((values) => values.every(Boolean));
}

// 只接收由服务器排他创建的固定私有 operation 文件；恢复环境仅通过 IPC 留在内存。
async function runHelper(recordPath, options = {}) {
  const service = options.service || createMacosService(options);
  const io = service.internals;
  const channel = options.channel || process;
  if (!channel.connected || typeof channel.send !== "function") throw failure("operation");
  const fsImpl = options.fsImpl || fs;
  const clock = options.now || Date.now;
  const pause = options.pause || delay;
  const verifyHttp = options.verifyInstance || verifyInstance;
  const verify = async (port, pid, installationId) => {
    try {
      const listeners = await io.run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
      if (!listeners.split("\n").includes(`p${pid}`)) return false;
      return verifyHttp(port, pid, installationId);
    } catch (_) { return false; }
  };
  const available = options.portAvailable || portAvailable;
  const spawnImpl = options.spawnImpl || spawn;
  const inbox = [];
  let disconnected = false;
  const onMessage = (message) => { if (message && typeof message.type === "string") inbox.push(message); };
  const onDisconnect = () => { disconnected = true; };
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  let record;
  let recovery;
  let active = false;
  let createdJob = false;
  let published = false;
  let recoveredChild;
  const started = clock();
  const deadline = started + (options.overallTimeoutMs || 90000);
  const opId = path.basename(recordPath, ".json");
  if (recordPath !== io.operationPath(opId)) throw failure("operation");
  record = io.readRecord(recordPath);
  if (!record || record.id !== opId || record.phase !== "prepared" || record.installationId !== service.installationId ||
    record.plistPath !== io.plistPath || record.uid !== (options.uid === undefined ? process.getuid?.() : options.uid) ||
    record.nodePath !== (options.nodePath || process.execPath) || record.proxyPath !== (options.proxyPath || path.resolve(__dirname, "../mac/proxy.js")) ||
    record.port !== (options.port || 8082) || record.stagePath !== (record.reused ? null : path.join(path.dirname(io.plistPath), `.${SERVICE_LABEL}-${opId}.tmp`))) throw failure("operation");
  const selfPid = options.selfPid || process.pid;
  const selfIdentity = await io.identity(selfPid);
  if (!selfIdentity || await io.identity(record.parentPid) !== record.parentIdentity) throw failure("identity");
  const lock = io.readRecord(io.lockPath);
  if (lock?.id !== opId || lock.pid !== record.parentPid || lock.identity !== record.parentIdentity || io.readRecord(io.currentPath)?.id !== opId) throw failure("operation");

  function checkBytes(file) {
    const bytes = io.readFile(file);
    if (!bytes || digest(bytes) !== record.plistDigest) throw failure("external_change");
    return bytes;
  }
  function update(phase, extras = {}) {
    const next = { ...record, ...extras, phase };
    io.writeRecord(recordPath, next, record);
    record = next;
  }
  function release() {
    const owner = io.readRecord(io.lockPath);
    if (owner?.id === opId && owner.pid === selfPid && owner.identity === selfIdentity) fsImpl.unlinkSync(io.lockPath);
  }
  function cleanStage() {
    if (record.stagePath && io.stat(record.stagePath)) {
      checkBytes(record.stagePath);
      fsImpl.unlinkSync(record.stagePath);
    }
  }
  async function waitUntil(check, timeout, code) {
    const until = Math.min(deadline, clock() + timeout);
    while (clock() < until) {
      if (await check()) return;
      await pause(options.pollMs || 250);
    }
    throw failure(code);
  }

  async function receive(type, timeout) {
    const until = Math.min(deadline, clock() + timeout);
    while (true) {
      if (disconnected || inbox.some((item) => item.type === "cancel" && item.id === opId)) throw failure("cancelled");
      if (clock() >= until) throw failure("preparation");
      const index = inbox.findIndex((item) => item.type === type && item.id === opId);
      if (index !== -1) return inbox.splice(index, 1)[0];
      await pause(Math.min(25, until - clock()));
    }
  }
  async function send(type) {
    await new Promise((resolve, reject) => channel.send({ type, id: opId }, (error) => error ? reject(failure("preparation")) : resolve()));
  }
  let launchedPid;
  let launchedIdentity;
  const target = `gui/${record.uid}/${SERVICE_LABEL}`;
  async function matchingJob() {
    const snapshot = await io.inspect();
    if (!snapshot.loaded) return null;
    checkBytes(io.plistPath);
    return snapshot.loaded;
  }
  async function restore() {
    let safe = true;
    if (createdJob) {
      try {
        const loaded = await matchingJob();
        if (loaded) {
          if (loaded.running && (!launchedPid || loaded.pid !== launchedPid || await io.identity(loaded.pid) !== launchedIdentity)) throw failure("external_change");
          await io.run("/bin/launchctl", ["bootout", target]);
          await waitUntil(async () => !await io.job(), 5000, "recovery");
        }
      } catch (_) { safe = false; }
    }
    if (published) {
      try {
        // 只删除本次无覆盖发布、字节仍一致的文件；既有 plist 从未改写。
        if (await io.job()) throw failure("external_change");
        checkBytes(io.plistPath);
        fsImpl.unlinkSync(io.plistPath);
      } catch (_) { safe = false; }
    }
    try { cleanStage(); } catch (_) { safe = false; }
    if (await io.identity(record.parentPid) === record.parentIdentity) {
      return safe && await verify(record.port, record.parentPid, record.installationId) ? "recovered" : "recovery_failed";
    }
    if (!safe || !recovery || !await available(record.port)) return "recovery_failed";
    const stdoutPath = path.join(io.privateRoot, "stdout.log");
    const stderrPath = path.join(io.privateRoot, "stderr.log");
    const descriptors = [];
    try {
      for (const file of [stdoutPath, stderrPath]) {
        io.readFile(file, true);
        descriptors.push(fsImpl.openSync(file, fsImpl.constants.O_WRONLY | fsImpl.constants.O_APPEND | (fsImpl.constants.O_NOFOLLOW || 0)));
      }
      recoveredChild = spawnImpl(record.nodePath, [...recovery.execArgv, record.proxyPath], {
        cwd: recovery.cwd, env: recovery.env, detached: true, stdio: ["ignore", ...descriptors]
      });
      recoveredChild.on("error", () => {});
      recoveredChild.unref();
      await waitUntil(() => verify(record.port, recoveredChild.pid, record.installationId), options.recoveryTimeoutMs || 15000, "recovery");
      return "recovered";
    } catch (_) { return "recovery_failed"; }
    finally { descriptors.forEach((fd) => fsImpl.closeSync(fd)); }
  }
  try {
    checkBytes(record.reused ? io.plistPath : record.stagePath);
    const snapshot = await io.inspect();
    if (Boolean(snapshot.existing) !== record.reused || Boolean(snapshot.loaded) !== record.loaded || snapshot.loaded?.running) throw failure("external_change");
    const message = await receive("prepare", options.prepareTimeoutMs || 5000);
    if (!message.recovery || typeof message.recovery.env !== "object" || !Array.isArray(message.recovery.execArgv) ||
      typeof message.recovery.cwd !== "string") throw failure("preparation");
    recovery = message.recovery;
    io.writeRecord(io.lockPath, { id: opId, pid: selfPid, identity: selfIdentity }, lock);
    update("pending");
    await send("ready");
    await receive("activate", options.activationTimeoutMs || 15000);
    update("draining");
    active = true;
    await send("activated");
    await waitUntil(async () => {
      const actual = await io.identity(record.parentPid);
      return actual ? actual !== record.parentIdentity : !io.pidAlive(record.parentPid);
    }, options.exitTimeoutMs || 20000, "old_process");
    await waitUntil(() => available(record.port), options.portTimeoutMs || 5000, "port_busy");
    checkBytes(record.reused ? io.plistPath : record.stagePath);
    const previous = await io.job();
    if (previous) {
      const latest = await io.inspect();
      if (!record.loaded || latest.loaded?.running) throw failure("external_change");
      await io.run("/bin/launchctl", ["bootout", target]);
    } else if (record.loaded) throw failure("external_change");
    if (!record.reused) {
      // link 的目标排他创建；并发创建永不被 rename 覆盖。
      fsImpl.linkSync(record.stagePath, io.plistPath);
      published = true;
      checkBytes(io.plistPath);
      cleanStage();
    }
    update("starting");
    await io.run("/bin/launchctl", ["bootstrap", `gui/${record.uid}`, io.plistPath], 10000);
    createdJob = true;
    let loaded = await matchingJob();
    if (!loaded) throw failure("launchctl");
    if (loaded.pid) { launchedPid = loaded.pid; launchedIdentity = await io.identity(loaded.pid); }
    if (!loaded.running) {
      // 不带 -k，且仅对本次 bootstrap 的停止 job 请求一次启动。
      await io.run("/bin/launchctl", ["kickstart", target], 5000);
    }
    update("verifying");
    await waitUntil(async () => {
      loaded = await matchingJob();
      if (!loaded?.running) return false;
      const currentIdentity = await io.identity(loaded.pid);
      if (!currentIdentity) return false;
      launchedPid = loaded.pid;
      launchedIdentity = currentIdentity;
      return verify(record.port, loaded.pid, record.installationId);
    }, options.verifyTimeoutMs || 20000, "verification");
    update("completed", { verifiedPid: launchedPid });
  } catch (error) {
    if (!active) {
      try { cleanStage(); } catch (_) {}
      update(error.helperCode === "cancelled" ? "cancelled" : "failed", { errorCode: "preparation", recovery: "recovered" });
    } else {
      update("failed", { errorCode: "handoff", recovery: await restore() });
    }
  } finally {
    recovery = null;
    channel.removeListener("message", onMessage);
    channel.removeListener("disconnect", onDisconnect);
    release();
    if (channel.connected) channel.disconnect();
  }
}

if (require.main === module) {
  runHelper(process.argv[2] || "").then(() => process.exit(0), () => process.exit(1));
}
module.exports = { runHelper, verifyInstance, portAvailable };
