const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { fork } = require("child_process");
const { EventEmitter } = require("events");
const { createMacosService, SERVICE_LABEL } = require("../lib/macos-service");
const { runHelper, verifyInstance } = require("../lib/macos-service-helper");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await pause(25);
  }
  throw new Error("fixture deadline exceeded");
}
const send = (port, route, options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: "127.0.0.1", port, path: route, ...options }, (res) => {
    let text = "";
    res.on("data", (data) => { text += data; });
    res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  req.on("error", reject);
  req.end(options.body);
});
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 8082);
  return port;
}
function processIdentity(pid) {
  try { process.kill(pid, 0); return `fixture-process-${pid}`; }
  catch (_) { return null; }
}

async function lifecycleFixture(t, mode = "success") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "service-lifecycle-")));
  const home = path.join(root, "home");
  const configRoot = path.join(home, "cli");
  const repository = path.join(root, "repo");
  const proxyPath = path.join(repository, "mac", "proxy.js");
  const privateRoot = path.join(configRoot, "claude-proxy", "macos-service");
  const plistPath = path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const port = await freePort();
  for (const directory of [path.dirname(proxyPath), privateRoot, path.dirname(plistPath)]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const modulePath = path.resolve(__dirname, "../lib/macos-service.js");
  const authPath = path.resolve(__dirname, "../lib/auth-server.js");
  const helperPath = path.resolve(__dirname, "../lib/macos-service-helper.js");
  const commonPath = path.join(root, "common.js");
  const helperWrapper = path.join(root, "helper.js");
  const launchctlPath = path.join(root, "launchctl");
  const plutilPath = path.join(root, "plutil");
  const blockerPath = path.join(root, "unrelated-listener.js");
  const eventsPath = path.join(root, "events.log");
  const pidsPath = path.join(root, "pids.jsonl");
  const jobPath = path.join(root, "job.json");
  const options = { platform: "darwin", home, configRoot, nodePath: process.execPath, proxyPath, uid: process.getuid(), port, execArgv: [] };
  fs.writeFileSync(commonPath, `const fs = require("fs"); const {execFile} = require("child_process");
const options = ${JSON.stringify(options)};
const eventsPath = ${JSON.stringify(eventsPath)}; const jobPath = ${JSON.stringify(jobPath)};
const mode = ${JSON.stringify(mode)};
function event(value) { fs.appendFileSync(eventsPath, value + "\\n"); }
function identity(pid) { try { process.kill(pid,0); return "fixture-process-"+pid; } catch (_) { return ""; } }
function track() { const currentIdentity = identity(process.pid); fs.appendFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({pid:process.pid,identity:currentIdentity})+"\\n"); }
function exec(file,args,settings,callback) { if(file==="/bin/ps") return callback(null,identity(Number(args[1])),""); if(file==="/usr/sbin/lsof") { const pid=args[args.indexOf("-p")+1]; const wrong=mode==="wrong_socket_owner" && fs.existsSync(jobPath) && String(JSON.parse(fs.readFileSync(jobPath)).pid)===pid; return callback(null,"p"+(wrong?"999999":pid)+"\\n"); } if(file!=="/bin/launchctl" && file!=="/usr/bin/plutil") throw new Error("Unmocked system command: "+file); execFile(file === "/bin/launchctl" ? ${JSON.stringify(launchctlPath)} : ${JSON.stringify(plutilPath)},args,settings,callback); }
function decode(s) { return s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&"); }
function plist(file) { const xml=fs.readFileSync(file,"utf8"); const strings=(s)=>Array.from(s.matchAll(/<string>([\\s\\S]*?)<\\/string>/g),m=>decode(m[1])); const env={}; const block=xml.match(/<key>EnvironmentVariables<\\/key><dict>([\\s\\S]*?)<\\/dict>/)[1]; for(const pair of block.matchAll(/<key>(.*?)<\\/key><string>(.*?)<\\/string>/g)) env[decode(pair[1])]=decode(pair[2]); return {Label:${JSON.stringify(SERVICE_LABEL)},ProgramArguments:strings(xml.match(/<array>([\\s\\S]*?)<\\/array>/)[1]),WorkingDirectory:options.proxyPath.replace(/\\/mac\\/proxy\\.js$/,""),RunAtLoad:true,KeepAlive:true,EnvironmentVariables:env}; }
module.exports={fs,options,eventsPath,jobPath,mode,event,track,exec,plist};\n`);
  fs.writeFileSync(plutilPath, `#!${process.execPath}\nconst c=require(${JSON.stringify(commonPath)}); if(process.argv[2]==="-lint") { c.plist(process.argv[3]); } else process.stdout.write(JSON.stringify(c.plist(process.argv.at(-1))));\n`, { mode: 0o700 });
  fs.writeFileSync(launchctlPath, `#!${process.execPath}\nconst c=require(${JSON.stringify(commonPath)}); const {spawn}=require("child_process"); const args=process.argv.slice(2);
if(args[0]==="print-disabled") process.stdout.write("{}");
else if(args[0]==="print" && args[1]=== "gui/"+c.options.uid) process.stdout.write("GUI domain");
else if(args[0]==="print") { if(!c.fs.existsSync(c.jobPath)) { if(c.mode==="external_change" && c.fs.existsSync(c.eventsPath) && c.fs.readFileSync(c.eventsPath,"utf8").includes("old_exit:") && !c.fs.existsSync(${JSON.stringify(plistPath)})) c.fs.writeFileSync(${JSON.stringify(plistPath)},"external plist bytes"); process.exit(113); } if(c.mode==="print_failure") process.exit(1); const j=JSON.parse(c.fs.readFileSync(c.jobPath)); const v=c.plist(j.file); process.stdout.write(args[1]+" = {\\n path = "+j.file+"\\n program = "+v.ProgramArguments[0]+"\\n working directory = "+v.WorkingDirectory+"\\n arguments = {\\n"+v.ProgramArguments.map(s=>"  "+s).join("\\n")+"\\n }\\n environment = {\\n"+Object.entries(v.EnvironmentVariables).map(([k,v])=>"  "+k+" => "+v).join("\\n")+"\\n }\\n state = "+(j.stopped?"waiting":"running")+"\\n pid = "+j.pid+"\\n}\\n"); }
else if(args[0]==="bootstrap") { c.event("bootstrap"); if(c.mode==="bootstrap_failure" || c.mode==="recovery_failure") process.exit(1); const v=c.plist(args[2]); if(c.mode==="kickstart_failure") { c.fs.writeFileSync(c.jobPath,JSON.stringify({pid:null,file:args[2],stopped:true})); process.exit(0); } const child=spawn(v.ProgramArguments[0],v.ProgramArguments.slice(1),{cwd:v.WorkingDirectory,env:{...v.EnvironmentVariables,FIXTURE_LAUNCHD:"1"},detached:true,stdio:"ignore"}); c.fs.writeFileSync(c.jobPath,JSON.stringify({pid:child.pid,file:args[2]})); child.unref(); }
else if(args[0]==="bootout") { const j=JSON.parse(c.fs.readFileSync(c.jobPath)); if(j.pid) process.kill(j.pid,"SIGTERM"); c.fs.unlinkSync(c.jobPath); c.event("bootout"); }
else if(args[0]==="kickstart") { if(c.mode==="kickstart_failure") process.exit(1); }
else process.exit(1);\n`, { mode: 0o700 });
  fs.writeFileSync(helperWrapper, `const c=require(${JSON.stringify(commonPath)}); c.track(); const options={...c.options,execFileImpl:c.exec,exitTimeoutMs:4000,portTimeoutMs:1000,verifyTimeoutMs:1200,recoveryTimeoutMs:3000,pollMs:25}; if(c.mode==="recovery_failure") options.spawnImpl=()=>{throw new Error("sensitive subprocess text");}; require(${JSON.stringify(helperPath)}).runHelper(process.argv[2],options).then(()=>process.exit(0),()=>process.exit(1));\n`);
  fs.writeFileSync(blockerPath, `const c=require(${JSON.stringify(commonPath)});c.track();require("http").createServer((req,res)=>res.end("unrelated healthy listener")).listen(c.options.port,()=>process.send({ready:true}));\n`);
  fs.writeFileSync(proxyPath, `const c=require(${JSON.stringify(commonPath)}); const http=require("http"); const {fork}=require("child_process"); c.track();
let server; const service=require(${JSON.stringify(modulePath)}).createMacosService({...c.options,env:process.env,execFileImpl:c.exec,forkImpl:(_file,args,options)=>fork(${JSON.stringify(helperWrapper)},args,options),onHandoff:()=>{c.event("handoff:"+process.pid); server.close(()=>{c.event("old_exit:"+process.pid);if(c.mode==="port_busy") {const blocker=fork(${JSON.stringify(blockerPath)},[],{stdio:["ignore","ignore","ignore","ipc"],execArgv:[]});blocker.once("message",()=>process.exit(0));}else process.exit(0);});server.closeIdleConnections();}});
if(c.mode==="wrong_identity" && process.env.FIXTURE_LAUNCHD) { const get=service.getStatus; service.getStatus=async()=>{const s=await get();return {...s,instance:{...s.instance,pid:process.pid+1000}};}; }
const router=require(${JSON.stringify(authPath)}).createAuthRouter({port:c.options.port,macosService:service,store:{directory:"temporary",readAuth:()=>({})},login:{close(){}}});
server=http.createServer(async(req,res)=>{res.once("finish",()=>{if(req.method==="POST")c.event("response_finish:"+process.pid);});if(await router(req,res))return;res.end("wrong health cannot verify identity");});
process.once("SIGTERM",()=>{server.closeAllConnections();server.close(()=>process.exit(0));});server.listen(c.options.port,()=>{c.event("listening:"+process.pid);if(process.send)process.send({ready:true});});\n`);
  const old = fork(proxyPath, [], { cwd: repository, env: { HOME: home, CLAUDE_CONFIG_DIR: configRoot, PATH: "/usr/bin:/bin" }, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => {
    if (fs.existsSync(pidsPath)) {
      const processes = fs.readFileSync(pidsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      for (const child of processes) {
        if (processIdentity(child.pid) === child.identity) { try { process.kill(child.pid, "SIGTERM"); } catch (_) {} }
      }
      await pause(100);
      for (const child of processes) {
        if (processIdentity(child.pid) === child.identity) { try { process.kill(child.pid, "SIGKILL"); } catch (_) {} }
      }
    }
    if (old.connected) old.disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture did not start")), 5000);
    old.once("message", () => { clearTimeout(timer); resolve(); });
    old.once("error", reject);
    old.once("exit", () => { clearTimeout(timer); reject(new Error("fixture exited early")); });
  });
  const page = await send(port, "/login");
  const nonce = page.text.match(/nonce="([a-zA-Z0-9_-]{43})"/)[1];
  const register = () => send(port, "/api/auth/macos/service/configure", { method: "POST", body: "{}", headers: {
    "X-Auth-Nonce": nonce, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json"
  } });
  const result = async () => until(() => {
    const current = path.join(privateRoot, "current.json");
    if (!fs.existsSync(current)) return false;
    const id = JSON.parse(fs.readFileSync(current)).id;
    const operation = JSON.parse(fs.readFileSync(path.join(privateRoot, `${id}.json`)));
    return ["completed", "failed", "cancelled"].includes(operation.phase) ? operation : false;
  });
  return { root, home, configRoot, proxyPath, privateRoot, plistPath, old, port, register, result, eventsPath, jobPath };
}

const lifecycleOptions = { skip: typeof process.getuid !== "function", timeout: 20000 };
test("offline lifecycle finishes the POST before exit, verifies launchd and protected instance, and no-ops repeat registration", lifecycleOptions, async (t) => {
  const h = await lifecycleFixture(t);
  const accepted = await h.register();
  assert.equal(accepted.status, 202, accepted.text);
  const operationId = JSON.parse(accepted.text).operationId;
  const operation = await h.result();
  assert.equal(operation.phase, "completed", JSON.stringify(operation));
  assert.equal(operation.id, operationId);
  assert.notEqual(operation.verifiedPid, h.old.pid);
  assert.equal(await verifyInstance(h.port, operation.verifiedPid, operation.installationId), true);
  assert.equal(fs.statSync(h.plistPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(h.privateRoot).mode & 0o777, 0o700);
  const events = fs.readFileSync(h.eventsPath, "utf8").split("\n");
  assert.ok(events.indexOf(`response_finish:${h.old.pid}`) < events.indexOf(`handoff:${h.old.pid}`));
  assert.ok(events.indexOf(`old_exit:${h.old.pid}`) < events.indexOf("bootstrap"));
  const page = await send(h.port, "/login");
  const nonce = page.text.match(/nonce="([a-zA-Z0-9_-]{43})"/)[1];
  const repeat = await send(h.port, "/api/auth/macos/service/configure", { method: "POST", body: "{}", headers: {
    "X-Auth-Nonce": nonce, Origin: `http://127.0.0.1:${h.port}`, "Content-Type": "application/json"
  } });
  assert.equal(repeat.status, 200, repeat.text);
  assert.equal(JSON.parse(repeat.text).state, "already_registered");
  assert.equal(fs.readFileSync(h.eventsPath, "utf8").split("\n").filter((event) => event === "bootstrap").length, 1);
  assert.equal(fs.existsSync(path.join(h.privateRoot, "operation.lock")), false);
});

for (const mode of ["bootstrap_failure", "wrong_identity", "wrong_socket_owner", "kickstart_failure", "recovery_failure"]) {
  test(`offline lifecycle ${mode} never reports health as success and persists accurate recovery`, lifecycleOptions, async (t) => {
    const h = await lifecycleFixture(t, mode);
    const accepted = await h.register();
    assert.equal(accepted.status, 202, accepted.text);
    const operation = await h.result();
    assert.equal(operation.phase, "failed");
    assert.equal(operation.recovery, mode === "recovery_failure" ? "recovery_failed" : "recovered", JSON.stringify(operation));
    assert.equal(fs.existsSync(h.plistPath), false);
    assert.doesNotMatch(JSON.stringify(operation), /sensitive subprocess|OPENAI_API_KEY|PRIVATE KEY/);
    if (operation.recovery === "recovered") {
      const page = await send(h.port, "/login");
      const nonce = page.text.match(/nonce="([a-zA-Z0-9_-]{43})"/)[1];
      const status = await until(async () => {
        const value = JSON.parse((await send(h.port, "/api/auth/status", { headers: { "X-Auth-Nonce": nonce } })).text);
        return value.macosService.operation?.phase === "failed" ? value : false;
      });
      assert.equal(status.macosService.operation.id, operation.id);
      assert.equal(status.macosService.operation.recovery, "recovered");
      assert.notEqual(status.macosService.instance.pid, h.old.pid);
    }
  });
}

test("external plist creation during handoff is preserved and the original proxy is recovered", lifecycleOptions, async (t) => {
  const h = await lifecycleFixture(t, "external_change");
  assert.equal((await h.register()).status, 202);
  const result = await h.result();
  assert.equal(result.phase, "failed");
  assert.equal(result.recovery, "recovered");
  assert.equal(fs.readFileSync(h.plistPath, "utf8"), "external plist bytes");
  assert.equal(fs.existsSync(h.jobPath), false);
});

test("an unrelated port owner is neither treated as successful registration nor killed for recovery", lifecycleOptions, async (t) => {
  const h = await lifecycleFixture(t, "port_busy");
  assert.equal((await h.register()).status, 202);
  const result = await h.result();
  assert.equal(result.phase, "failed");
  assert.equal(result.recovery, "recovery_failed");
  assert.equal(fs.existsSync(h.plistPath), false);
  assert.equal(fs.readFileSync(h.eventsPath, "utf8").includes("bootstrap"), false);
  assert.equal((await send(h.port, "/health")).text, "unrelated healthy listener");
});

test("launchctl print failure refuses unverified bootout and records recovery failure", lifecycleOptions, async (t) => {
  const h = await lifecycleFixture(t, "print_failure");
  assert.equal((await h.register()).status, 202);
  const result = await h.result();
  assert.equal(result.phase, "failed");
  assert.equal(result.recovery, "recovery_failed");
  assert.equal(fs.existsSync(h.plistPath), true);
  assert.equal(fs.readFileSync(h.eventsPath, "utf8").includes("bootout"), false);
});

for (const cancelled of [false, true]) {
  test(`helper without response-finish activation ${cancelled ? "cancels" : "expires"} without stopping the old proxy`, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "helper-no-activation-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const proxyPath = path.join(root, "repo", "mac", "proxy.js");
    fs.mkdirSync(path.dirname(proxyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(proxyPath, "// fixture");
    const uid = process.getuid();
    const execFileImpl = (file, args, options, callback) => {
      if (file === "/bin/ps") return callback(null, args[1] === String(process.pid) ? "parent" : "helper");
      if (file === "/bin/launchctl" && args[1].includes(SERVICE_LABEL)) return callback(Object.assign(new Error(), { code: 113 }));
      callback(null, "");
    };
    const forkImpl = () => {
      const child = new EventEmitter();
      Object.assign(child, { connected: true, unref() {}, channel: { unref() {} }, send(message, callback) {
        callback?.();
        if (message.type === "prepare") setImmediate(() => child.emit("message", { type: "ready", id: message.id }));
      } });
      return child;
    };
    const options = { platform: "darwin", home: root, configRoot: path.join(root, "cli"), proxyPath, nodePath: process.execPath,
      uid, env: {}, execArgv: [], execFileImpl, forkImpl };
    const service = createMacosService(options);
    const prepared = await service.configure();
    assert.equal(prepared.status, 202);
    const channel = new EventEmitter();
    channel.connected = true;
    channel.send = (message, callback) => {
      callback?.();
      if (message.type === "ready" && cancelled) setImmediate(() => channel.emit("message", { type: "cancel", id: message.id }));
    };
    channel.disconnect = () => { channel.connected = false; };
    const recordPath = service.internals.operationPath(prepared.body.operationId);
    const executing = runHelper(recordPath, { ...options, service, channel, selfPid: 9001, activationTimeoutMs: 20,
      prepareTimeoutMs: 200, spawnImpl() { assert.fail("must not recover before activation"); } });
    setImmediate(() => channel.emit("message", { type: "prepare", id: prepared.body.operationId,
      recovery: { env: {}, execArgv: [], cwd: root } }));
    await executing;
    const record = JSON.parse(fs.readFileSync(recordPath));
    assert.equal(record.phase, cancelled ? "cancelled" : "failed");
    assert.equal(record.recovery, "recovered");
    assert.equal(fs.existsSync(record.stagePath), false);
    assert.equal(fs.existsSync(service.internals.plistPath), false);
    assert.equal(fs.existsSync(service.internals.lockPath), false);
  });
}
