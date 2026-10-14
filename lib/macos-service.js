const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, fork } = require("child_process");
const { getClaudeConfigRoot } = require("./claude-setup");

const SERVICE_LABEL = "com.shanshazhe.claude-proxy";
const NOTICE = "The service starts at login and uses this repository and Node installation. Moving either requires manual repair. Active requests and login flows may be interrupted; the page will reconnect.";
const MESSAGES = {
  unsupported: "macOS service registration is available only on macOS.",
  gui: "A current-user GUI login session is required. Sign in to macOS normally first.",
  conflict: "The existing service or files are unsafe, damaged, or belong to another installation. Resolve them manually; nothing was replaced.",
  environment: "The current startup environment or Node arguments cannot be safely preserved. Remove unsupported overrides and restart the proxy manually.",
  environment_key: "OPENAI_API_KEY cannot be transferred to launchd. Save supported credentials on this page, remove the environment override, and restart the proxy first.",
  files: "Service files or directories are unsafe or not writable. Fix their ownership and permissions first.",
  preparation: "The service helper could not prepare. The current proxy is still running.",
  interrupted: "The previous service operation ended unexpectedly. Inspect the service and start mac/start-proxy.sh manually if needed.",
  handoff: "Service registration failed. Recovery was attempted; start mac/start-proxy.sh manually if recovery failed."
};
const serviceError = (code) => Object.assign(new Error(MESSAGES[code] || MESSAGES.handoff), { serviceCode: code });
function serviceFailure(error) {
  const code = Object.hasOwn(MESSAGES, error?.serviceCode) ? error.serviceCode : "handoff";
  return { status: code === "unsupported" ? 400 : ["conflict", "environment", "environment_key"].includes(code) ? 409 : 503,
    body: { error: MESSAGES[code], code } };
}
const xml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

function createMacosService(options = {}) {
  const platform = options.platform || process.platform;
  const home = path.resolve(options.home || os.homedir());
  const env = options.env || process.env;
  const configRoot = path.resolve(options.configRoot || getClaudeConfigRoot(env, home));
  const nodePath = options.nodePath || process.execPath;
  const proxyPath = options.proxyPath || path.resolve(__dirname, "../mac/proxy.js");
  const repository = path.dirname(path.dirname(proxyPath));
  const uid = options.uid === undefined ? process.getuid?.() : options.uid;
  const fsImpl = options.fsImpl || fs;
  const execFileImpl = options.execFileImpl || execFile;
  const forkImpl = options.forkImpl || fork;
  const now = options.now || Date.now;
  const execArgv = options.execArgv || process.execArgv;
  const port = options.port || 8082;
  const privateRoot = path.join(configRoot, "claude-proxy", "macos-service");
  const agentsRoot = path.join(home, "Library", "LaunchAgents");
  const plistPath = path.join(agentsRoot, `${SERVICE_LABEL}.plist`);
  const currentPath = path.join(privateRoot, "current.json");
  const lockPath = path.join(privateRoot, "operation.lock");
  const installationId = crypto.createHash("sha256").update(`${nodePath}\0${proxyPath}`).digest("hex");
  let cache;
  let expires = 0;
  let pending;
  let preparing;

  // 所有进程调用有固定参数、有限输出和超时；原文永不离开此模块。
  function run(file, args, timeout = 5000) {
    return new Promise((resolve, reject) => execFileImpl(file, args,
      { timeout, killSignal: "SIGKILL", maxBuffer: 128 * 1024, encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } },
      (error, stdout) => error ? reject(Object.assign(new Error(), { code: error.code })) : resolve(String(stdout))));
  }
  function stat(file) {
    try { return fsImpl.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") return null; throw serviceError("files"); }
  }
  function directory(file, create = false, privateMode = false) {
    const parent = path.dirname(file);
    if (parent !== file) directory(parent, create, false);
    let info = stat(file);
    if (!info) {
      if (!create) return;
      fsImpl.mkdirSync(file, { mode: 0o700 });
      info = stat(file);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) && !(info.mode & 0o1000)) throw serviceError("files");
    if (privateMode && (info.uid !== uid || (info.mode & 0o077))) throw serviceError("files");
  }
  function writableDirectory(file) {
    directory(file);
    let existing = file;
    while (!stat(existing)) existing = path.dirname(existing);
    const info = stat(existing);
    if (!(info.mode & 0o222) || info.uid !== uid && existing !== path.parse(existing).root) throw serviceError("files");
    fsImpl.accessSync(existing, fsImpl.constants.W_OK | fsImpl.constants.X_OK);
  }
  function readFile(file, privateMode = false) {
    directory(path.dirname(file), false, privateMode);
    const info = stat(file);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 || info.uid !== uid ||
      privateMode && ((info.mode & 0o077) || info.nlink !== 1) || info.mode & 0o022) throw serviceError("files");
    const fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
    try {
      const opened = fsImpl.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw serviceError("files");
      return fsImpl.readFileSync(fd);
    } finally { fsImpl.closeSync(fd); }
  }
  function writeNew(file, bytes) {
    const fd = fsImpl.openSync(file, fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL |
      (fsImpl.constants.O_NOFOLLOW || 0), 0o600);
    try { fsImpl.writeFileSync(fd, bytes); fsImpl.fsyncSync(fd); }
    finally { fsImpl.closeSync(fd); }
  }
  function writeRecord(file, value, expected) {
    const before = readFile(file, true);
    if (expected !== undefined && (!before || !before.equals(Buffer.from(JSON.stringify(expected))))) throw serviceError("conflict");
    const temporary = path.join(privateRoot, `.record-${crypto.randomUUID()}`);
    writeNew(temporary, JSON.stringify(value));
    try {
      const current = readFile(file, true);
      if (before === null ? current !== null : !current || !current.equals(before)) throw serviceError("conflict");
      fsImpl.renameSync(temporary, file);
    } finally { if (stat(temporary)) fsImpl.unlinkSync(temporary); }
  }
  function readRecord(file) {
    const bytes = readFile(file, true);
    if (!bytes) return null;
    try { return JSON.parse(bytes.toString("utf8")); } catch (_) { throw serviceError("files"); }
  }
  function validateTarget(file, executable = false) {
    if (!path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw serviceError("conflict");
    directory(path.dirname(file));
    const info = stat(file);
    if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw serviceError("conflict");
    fsImpl.accessSync(file, fsImpl.constants.R_OK | (executable ? fsImpl.constants.X_OK : 0));
  }

  function pidAlive(pid) {
    if (options.isAliveImpl) return options.isAliveImpl(pid);
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  }
  async function identity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { return (await run("/bin/ps", ["-p", String(pid), "-o", "lstart="])).trim() || null; }
    catch (_) { return null; }
  }
  async function job() {
    let output;
    try { output = await run("/bin/launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`]); }
    catch (error) { if ([113, 3].includes(error.code)) return null; throw serviceError("gui"); }
    const field = (name) => output.match(new RegExp(`^\\s*${name} = (.+)$`, "m"))?.[1]?.trim();
    const args = output.match(/^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1]
      .split("\n").map((item) => item.trim().replace(/^\d+ = /, "")).filter(Boolean);
    if (!output.includes(`gui/${uid}/${SERVICE_LABEL} = {`)) throw serviceError("conflict");
    const environment = {};
    const block = output.match(/^\s*environment = \{\s*\n([\s\S]*?)^\s*\}/m)?.[1] || "";
    for (const line of block.split("\n")) {
      const entry = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*(?:=>|=)\s*(.*)$/);
      if (entry) environment[entry[1]] = entry[2];
    }
    const pid = Number(field("pid")) || null;
    return { program: field("program"), path: field("path"), args, workingDirectory: field("working directory"), environment,
      pid, running: field("state") === "running" && Number.isSafeInteger(pid) && pid > 0 };
  }
  async function plist() {
    const bytes = readFile(plistPath);
    if (!bytes) return null;
    let value;
    try { value = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath])); }
    catch (_) { throw serviceError("conflict"); }
    if (!readFile(plistPath)?.equals(bytes)) throw serviceError("conflict");
    const args = value.ProgramArguments;
    if (value.Label !== SERVICE_LABEL || !Array.isArray(args) || args.length < 2 || args[0] !== nodePath ||
      args.at(-1) !== proxyPath || args.some((item) => typeof item !== "string") || value.Program && value.Program !== nodePath ||
      value.WorkingDirectory !== repository || value.RunAtLoad !== true || value.KeepAlive !== true || value.Disabled === true || value.LaunchOnlyOnce === true ||
      value.LimitLoadToSessionType !== undefined && value.LimitLoadToSessionType !== "Aqua" ||
      args.slice(1, -1).some((item) => !TLS_FLAGS.includes(item))) throw serviceError("conflict");
    return { value, bytes };
  }
  async function inspect() {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw serviceError("gui");
    validateTarget(nodePath, true);
    validateTarget(proxyPath);
    writableDirectory(agentsRoot);
    writableDirectory(privateRoot);
    directory(privateRoot, false, true);
    try { await run("/bin/launchctl", ["print", `gui/${uid}`]); }
    catch (_) { throw serviceError("gui"); }
    let disabled;
    try { disabled = await run("/bin/launchctl", ["print-disabled", `gui/${uid}`]); }
    catch (_) { throw serviceError("gui"); }
    const label = SERVICE_LABEL.replaceAll(".", "\\.");
    if (new RegExp(`"${label}"\\s*=>\\s*true`).test(disabled)) throw serviceError("conflict");
    const existing = await plist();
    const loaded = await job();
    if (loaded && (!existing || loaded.path !== plistPath || loaded.program !== nodePath ||
      loaded.workingDirectory !== repository || !loaded.args || JSON.stringify(loaded.args) !== JSON.stringify(existing.value.ProgramArguments) ||
      Object.entries(existing.value.EnvironmentVariables || {}).some(([name, value]) => loaded.environment[name] !== value))) {
      throw serviceError("conflict");
    }
    return { existing, loaded };
  }
  const TLS_FLAGS = ["--use-system-ca", "--use-openssl-ca", "--use-bundled-ca", "--tls-min-v1.2", "--tls-min-v1.3", "--tls-max-v1.2", "--tls-max-v1.3"];
  async function launchEnvironment() {
    if (env.OPENAI_API_KEY) throw serviceError("environment_key");
    if (env.PI_AUTH_FILE || env.OPENAI_BASE_URL || env.DEBUG_VERBOSE === "1" || env.OPENSSL_CONF || env.OPENSSL_MODULES ||
      env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== "0" ||
      env.NODE_TLS_REJECT_UNAUTHORIZED && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1" || env.SSL_CERT_DIR) throw serviceError("environment");
    const nodeOptions = (env.NODE_OPTIONS || "").trim().split(/\s+/).filter(Boolean);
    const flags = [...execArgv, ...nodeOptions];
    if (env.NODE_USE_SYSTEM_CA && !["0", "1"].includes(env.NODE_USE_SYSTEM_CA)) throw serviceError("environment");
    if (env.NODE_USE_SYSTEM_CA === "1") flags.push("--use-system-ca");
    if (flags.some((flag) => !TLS_FLAGS.includes(flag))) throw serviceError("environment");
    const uniqueFlags = [...new Set(flags)];
    if (uniqueFlags.filter((flag) => flag.startsWith("--use-")).length > 1 ||
      uniqueFlags.filter((flag) => flag.startsWith("--tls-min-")).length > 1 || uniqueFlags.filter((flag) => flag.startsWith("--tls-max-")).length > 1) throw serviceError("environment");
    if (uniqueFlags.length) {
      const help = await run(nodePath, ["--help"]);
      if (uniqueFlags.some((flag) => !help.includes(flag))) throw serviceError("environment");
    }
    const result = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CLAUDE_CONFIG_DIR: configRoot };
    const formats = {
      OPENAI_PROMPT_CACHE: /^[01]$/, CLAUDE_PROMPT_CACHE: /^[01]$/, DISABLE_PROMPT_CACHING: /^[01]$/,
      DISABLE_PROMPT_CACHING_HAIKU: /^[01]$/, DISABLE_PROMPT_CACHING_SONNET: /^[01]$/, DISABLE_PROMPT_CACHING_OPUS: /^[01]$/,
      PI_CACHE_RETENTION: /^(short|long|none)$/, CODEX_CLIENT_VERSION: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
    };
    for (const [name, format] of Object.entries(formats)) {
      if (env[name] === undefined || env[name] === "") continue;
      if (!format.test(env[name])) throw serviceError("environment");
      result[name] = env[name];
    }
    for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) {
      if (!env[name]) continue;
      try {
        validateTarget(env[name]);
        const info = stat(env[name]);
        if (info.size > 2 * 1024 * 1024) throw new Error();
        const contents = fsImpl.readFileSync(env[name], "utf8");
        const certificates = contents.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
        if (!certificates?.length || /PRIVATE KEY/.test(contents)) throw new Error();
        for (const certificate of certificates) new crypto.X509Certificate(certificate);
        result[name] = env[name];
      } catch (_) { throw serviceError("environment"); }
    }
    return { env: result, args: [nodePath, ...uniqueFlags, proxyPath] };
  }
  function plistXml(settings) {
    const string = (value) => `<string>${xml(value)}</string>`;
    const values = Object.entries(settings.env).map(([name, value]) => `<key>${xml(name)}</key>${string(value)}`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n` +
      `<key>Label</key>${string(SERVICE_LABEL)}\n<key>ProgramArguments</key><array>${settings.args.map(string).join("")}</array>\n` +
      `<key>WorkingDirectory</key>${string(repository)}\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>15</integer>\n` +
      `<key>EnvironmentVariables</key><dict>${values}</dict>\n<key>StandardOutPath</key>${string(path.join(privateRoot, "stdout.log"))}\n` +
      `<key>StandardErrorPath</key>${string(path.join(privateRoot, "stderr.log"))}\n</dict></plist>\n`;
  }

  const operationPath = (id) => {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw serviceError("files");
    return path.join(privateRoot, `${id}.json`);
  };
  function currentOperation() {
    const pointer = readRecord(currentPath);
    if (!pointer) return null;
    const record = readRecord(operationPath(pointer.id));
    if (!record || record.id !== pointer.id || record.installationId !== installationId ||
      !["prepared", "pending", "draining", "starting", "verifying", "completed", "failed", "cancelled"].includes(record.phase)) throw serviceError("files");
    return record;
  }
  async function liveLock() {
    const lock = readRecord(lockPath);
    if (!lock) return null;
    operationPath(lock.id);
    if (!Number.isSafeInteger(lock.pid) || typeof lock.identity !== "string") throw serviceError("files");
    const actual = await identity(lock.pid);
    return { ...lock, alive: Boolean(lock.identity && actual === lock.identity || !actual && pidAlive(lock.pid)) };
  }
  function publicOperation(record) {
    if (!record) return undefined;
    return { id: record.id, phase: record.phase, ...(record.errorCode ? { errorCode: Object.hasOwn(MESSAGES, record.errorCode) ? record.errorCode : "handoff" } : {}),
      ...(["recovered", "recovery_failed"].includes(record.recovery) ? { recovery: record.recovery } : {}) };
  }
  async function getStatus(fresh = false) {
    const base = { supported: platform === "darwin", ready: false, registered: false, running: false,
      state: "unsupported", reason: MESSAGES.unsupported, notice: NOTICE,
      ...(platform === "darwin" ? { instance: { pid: process.pid, installationId } } : {}) };
    if (platform !== "darwin") return base;
    if (!fresh && cache && now() < expires) return cache;
    try {
      const { existing, loaded } = await inspect();
      const record = currentOperation();
      const lock = await liveLock();
      const active = lock?.alive && record && record.id === lock.id && !["completed", "failed", "cancelled"].includes(record.phase);
      const interrupted = record && !["completed", "failed", "cancelled"].includes(record.phase) && !lock?.alive;
      const failed = record?.phase === "failed" || interrupted;
      let reason = "";
      let ready = !active;
      if (!loaded?.running && !active) {
        try { await launchEnvironment(); } catch (error) { ready = false; reason = MESSAGES[error.serviceCode] || MESSAGES.environment; }
      }
      const operation = interrupted ? { ...record, phase: "failed", errorCode: "interrupted", recovery: "recovery_failed" } : record;
      cache = { ...base, supported: true, ready, registered: Boolean(existing), running: Boolean(loaded?.running),
        state: active ? "pending" : loaded?.running ? "registered" : failed ? "failed" : existing ? "stopped" : "missing",
        reason: reason || (failed ? MESSAGES[operation.errorCode] || MESSAGES.handoff : ""),
        ...(operation ? { operation: publicOperation(operation) } : {}), instance: { pid: process.pid, installationId } };
    } catch (error) {
      const code = error.serviceCode || "files";
      cache = { ...base, supported: true, state: code === "conflict" || code === "files" ? "conflict" : "unavailable", reason: MESSAGES[code] || MESSAGES.files };
      try {
        const record = currentOperation();
        if (record) cache.operation = publicOperation(record);
      } catch (_) {}
    }
    expires = now() + 1000;
    return cache;
  }
  const pendingResult = (id, hooks = {}) => ({ status: 202, body: { accepted: true, operationId: id, state: "pending",
    message: "Registration is pending. Requests may be interrupted; wait for the page to reconnect and verify the service." }, ...hooks });
  async function prepare() {
    if (platform !== "darwin") throw serviceError("unsupported");
    const snapshot = await inspect();
    if (snapshot.loaded?.running) return { status: 200, body: { state: "already_registered", message: "The matching macOS service is already running. Nothing was changed." } };
    const previousLock = await liveLock();
    if (previousLock?.alive) return pendingResult(previousLock.id, pending?.id === previousLock.id ? pending.hooks : {});
    const settings = await launchEnvironment();
    if (snapshot.existing) {
      const existingEnv = snapshot.existing.value.EnvironmentVariables || {};
      const legacyFlags = typeof existingEnv.NODE_OPTIONS === "string" ? existingEnv.NODE_OPTIONS.trim().split(/\s+/).filter(Boolean) : [];
      const existingFlags = [...snapshot.existing.value.ProgramArguments.slice(1, -1), ...legacyFlags];
      if (existingFlags.some((flag) => !TLS_FLAGS.includes(flag)) || existingEnv.NODE_OPTIONS !== undefined && typeof existingEnv.NODE_OPTIONS !== "string" ||
        JSON.stringify([...new Set(existingFlags)].sort()) !== JSON.stringify(settings.args.slice(1, -1).sort()) ||
        Object.entries(existingEnv).some(([name, value]) => name !== "NODE_OPTIONS" && settings.env[name] !== value) ||
        (env.CLAUDE_CONFIG_DIR && existingEnv.CLAUDE_CONFIG_DIR !== configRoot)) throw serviceError("conflict");
    }
    directory(path.dirname(privateRoot), true, true);
    directory(privateRoot, true, true);
    directory(agentsRoot, true);
    for (const name of ["stdout.log", "stderr.log"]) {
      const file = path.join(privateRoot, name);
      if (!readFile(file, true)) writeNew(file, "");
    }
    if (previousLock) {
      const before = readRecord(lockPath);
      const ownerIdentity = await identity(before.pid);
      if (before.id !== previousLock.id || before.pid !== previousLock.pid || ownerIdentity === before.identity || !ownerIdentity && pidAlive(before.pid)) throw serviceError("conflict");
      const previous = currentOperation();
      if (previous?.id === before.id && previous.stagePath) {
        const expected = path.join(agentsRoot, `.${SERVICE_LABEL}-${before.id}.tmp`);
        const bytes = previous.stagePath === expected ? readFile(expected) : null;
        if (previous.stagePath !== expected || bytes && crypto.createHash("sha256").update(bytes).digest("hex") !== previous.plistDigest) throw serviceError("conflict");
        if (bytes) fsImpl.unlinkSync(expected);
      }
      fsImpl.unlinkSync(lockPath);
    }
    const id = crypto.randomUUID();
    const parentIdentity = await identity(process.pid);
    if (!parentIdentity) throw serviceError("preparation");
    try { writeNew(lockPath, JSON.stringify({ id, pid: process.pid, identity: parentIdentity })); }
    catch (error) {
      if (error.code === "EEXIST") {
        const lock = await liveLock();
        if (lock?.alive) return pendingResult(lock.id);
      }
      throw serviceError("files");
    }
    const recordPath = operationPath(id);
    const stagePath = path.join(agentsRoot, `.${SERVICE_LABEL}-${id}.tmp`);
    let helper;
    let record;
    let stagedBytes;
    try {
      if (!snapshot.existing) {
        stagedBytes = Buffer.from(plistXml(settings));
        writeNew(stagePath, stagedBytes);
        await run("/usr/bin/plutil", ["-lint", stagePath]);
        if (!readFile(stagePath)?.equals(stagedBytes)) throw serviceError("conflict");
      }
      const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
      record = { id, phase: "prepared", installationId, parentPid: process.pid, parentIdentity, uid, home, configRoot, nodePath, proxyPath, port,
        plistPath, stagePath: snapshot.existing ? null : stagePath, plistDigest: digest(snapshot.existing?.bytes || stagedBytes),
        reused: Boolean(snapshot.existing), loaded: Boolean(snapshot.loaded), createdAt: now() };
      writeNew(recordPath, JSON.stringify(record));
      writeRecord(currentPath, { id });
      helper = forkImpl(path.join(__dirname, "macos-service-helper.js"), [recordPath], {
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execPath: nodePath, execArgv: settings.args.slice(1, -1), env: settings.env
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(false), options.readyTimeoutMs || 5000);
        const finish = (ready) => {
          clearTimeout(timer);
          helper.removeListener("message", onMessage);
          helper.removeListener("error", onError);
          helper.removeListener("exit", onError);
          ready ? resolve() : reject(serviceError("preparation"));
        };
        const onMessage = (message) => { if (message?.type === "ready" && message.id === id) finish(true); };
        const onError = () => finish(false);
        helper.on("message", onMessage);
        helper.once("error", onError);
        helper.once("exit", onError);
        helper.send({ type: "prepare", id, recovery: { env: { ...env }, execArgv: [...execArgv], cwd: process.cwd() } }, (error) => { if (error) finish(false); });
      });
      let activated = false;
      let cancelled = false;
      let handoffStarted = false;
      let activationTimer;
      const markUnavailable = async () => {
        if (handoffStarted) return;
        clearTimeout(activationTimer);
        cancelled = true;
        try {
          const owner = await liveLock();
          // 活着的 helper 是唯一写入者；不因超时抢锁或覆盖它的阶段。
          if (owner?.id === id && owner.alive && owner.pid !== process.pid) return;
          const latest = readRecord(recordPath);
          if (latest && ["prepared", "pending", "draining"].includes(latest.phase)) {
            if (latest.stagePath && readFile(latest.stagePath) && digest(readFile(latest.stagePath)) === latest.plistDigest) fsImpl.unlinkSync(latest.stagePath);
            writeRecord(recordPath, { ...latest, phase: "failed", errorCode: "preparation", recovery: "recovered" }, latest);
          }
          const remaining = readRecord(lockPath);
          if (remaining?.id === id && (remaining.pid === process.pid || !owner?.alive)) fsImpl.unlinkSync(lockPath);
          cache = null;
        } catch (_) { cache = null; }
      };
      helper.once("exit", markUnavailable);
      helper.once("disconnect", markUnavailable);
      const cancel = () => {
        if (activated || cancelled) return;
        cancelled = true;
        if (helper.connected) helper.send({ type: "cancel", id }, () => {});
        else markUnavailable();
      };
      const activate = () => {
        if (activated || cancelled) return;
        activated = true;
        activationTimer = setTimeout(() => { activated = false; cancel(); markUnavailable(); }, 5000);
        activationTimer.unref?.();
        helper.send({ type: "activate", id }, (error) => {
          if (error) { activated = false; cancel(); markUnavailable(); }
        });
      };
      helper.on("message", (message) => {
        if (message?.type !== "activated" || message.id !== id || !activated || handoffStarted) return;
        handoffStarted = true;
        clearTimeout(activationTimer);
        helper.disconnect();
        helper.unref();
        options.onHandoff?.();
      });
      helper.on("error", () => {});
      helper.unref();
      helper.channel?.unref();
      pending = { id, hooks: { activate, cancel } };
      cache = null;
      return pendingResult(id, pending.hooks);
    } catch (error) {
      if (helper?.connected) helper.send({ type: "cancel", id }, () => {});
      // 未握手时绝不退出旧代理；外部改过的暂存也不删除。
      if (stagedBytes && readFile(stagePath)?.equals(stagedBytes)) fsImpl.unlinkSync(stagePath);
      const owner = await liveLock();
      if (record && (!owner?.alive || owner.pid === process.pid)) writeRecord(recordPath, { ...record, phase: "failed", errorCode: "preparation", recovery: "recovered" });
      const lock = readRecord(lockPath);
      if (lock?.id === id && lock.pid === process.pid) fsImpl.unlinkSync(lockPath);
      throw serviceError(error.serviceCode === "conflict" ? "conflict" : "preparation");
    }
  }
  function configure() {
    if (preparing) return preparing;
    preparing = prepare().finally(() => { preparing = null; });
    return preparing;
  }

  return { getStatus, configure, installationId,
    // helper 复用同一套安全文件/归属验证，浏览器永远拿不到这些操作。
    internals: { run, stat, directory, readFile, readRecord, writeNew, writeRecord, identity, job, inspect,
      operationPath, privateRoot, plistPath, currentPath, lockPath, launchEnvironment, pidAlive } };
}

module.exports = { createMacosService, SERVICE_LABEL, serviceFailure };
