const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// 使用最小 DOM 与假 fetch 验证页面事件，不读取真实凭据或调用上游。
function pageHarness(_unused, { status, configure, requestImpl, fastWait = false } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", dataset: {}, hidden: true, disabled: ["cli-configure", "statusline-configure", "macos-service-configure", "project-memory-install"].includes(id), attributes: {}, listeners: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      replaceChildren(...children) { this.children = children; }
    });
    return elements.get(id);
  };
  const document = { hidden: false, listeners: {}, getElementById: element, createElement: () => ({ value: "", textContent: "" }),
    querySelector: () => ({ content: "test-page-nonce" }),
    addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const window = { location: { href: "http://localhost:8082/login", origin: "http://localhost:8082" },
    setTimeout, clearTimeout, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const requests = [];
  const context = {
    document, window, URL, Headers, AbortController,
    DOMParser: class { parseFromString(html) { return { querySelector: () => ({ content: html.match(/content="([a-zA-Z0-9_-]{43})"/)?.[1] }) }; } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requestImpl) return requestImpl(url, options);
      if (url.endsWith("/status")) return { ok: true, json: async () => status ? status() : ({ claudeCli: { installed: true, ready: true, configured: false }, statusline: { installed: true, ready: true, configured: false } }) };
      if (options.method === "POST") return configure ? configure(url, options) : { ok: true, json: async () => ({ success: true, message: "Done." }) };
      return { ok: true, json: async () => ({}) };
    }
  };
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8");
  vm.runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], context);
  if (fastWait) vm.runInNewContext("wait = async () => {};", context);
  return { element, document, window, requests,
    run: (source) => vm.runInNewContext(source, context),
    refresh: () => vm.runInNewContext("refreshStatus()", context),
    authorizationComplete: () => vm.runInNewContext('startLogin("chatgpt")', context),
  };
}

test("Project Code Memory card is independently gated and installation feedback is isolated", async () => {
  const page = pageHarness(async () => [], { status: () => ({ projectMemory: { ready: true } }),
    configure: async () => ({ ok: true, json: async () => ({ ok: true, installed: true, changed: false }) }) });
  assert.equal(page.element("project-memory-install").disabled, true);
  assert.equal(page.requests.filter((item) => item.url.endsWith("/status")).length, 1);
  await page.refresh();
  assert.equal(page.element("project-memory-install").disabled, false);
  await page.element("project-memory-install").listeners.click();
  assert.equal(page.requests.filter((item) => item.url.endsWith("/project-memory/install")).length, 1);
  assert.equal(page.requests.find((item) => item.url.endsWith("/project-memory/install")).options.body, "{}");
  assert.match(page.element("project-memory-status").textContent, /already installed.*new Claude session/i);
  assert.equal(page.requests.filter((item) => item.url.endsWith("/status")).length, 3);
});

test("Project Code Memory prevents duplicate clicks and keeps other configure feedback", async () => {
  let finish;
  let installed = false;
  const page = pageHarness(async () => [], { status: () => ({ claudeCli: { ready: true }, statusline: { ready: true }, projectMemory: { ready: true, installed } }),
    configure: async (url) => {
      if (!url.endsWith("/install")) return response({ success: true });
      return new Promise((resolve) => { finish = () => { installed = true; resolve(response({ ok: true, installed: true, changed: true })); }; });
    } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.requests.filter((item) => item.url.endsWith("/status")).length, 1);
  await page.element("cli-configure").listeners.click();
  const cliMessage = page.element("cli-status").textContent;
  const first = page.element("project-memory-install").listeners.click();
  assert.equal(page.element("project-memory-install").disabled, true);
  assert.equal(page.element("statusline-configure").disabled, false);
  await page.element("project-memory-install").listeners.click();
  assert.equal(page.requests.filter((item) => item.url.endsWith("/install")).length, 1);
  finish(); await first;
  assert.match(page.element("project-memory-status").textContent, /installed.*new Claude session/i);
  assert.equal(page.element("project-memory-install").disabled, true);
  assert.equal(page.element("cli-status").textContent, cliMessage);
});

test("Project Code Memory errors are parsed and status failure disables installation", async () => {
  let failStatus = false;
  const page = pageHarness(async () => [], { status: () => {
    if (failStatus) throw new Error("offline");
    return { projectMemory: { ready: true } };
  }, configure: async () => response({ error: "Fixed install conflict." }, 409) });
  await page.refresh();
  await page.element("project-memory-install").listeners.click();
  assert.equal(page.element("project-memory-status").textContent, "Fixed install conflict.");
  failStatus = true; await page.refresh();
  assert.equal(page.element("project-memory-install").disabled, true);
  const unavailable = pageHarness(async () => [], { status: () => { throw new Error("offline"); } });
  await unavailable.refresh();
  assert.equal(unavailable.element("project-memory-install").disabled, true);
  assert.match(unavailable.element("project-memory-status").textContent, /Unable to load/);
});

test("macOS service UI polls verified identity and recovers nonce without executing markup", () => {
  const html = fs.readFileSync(path.join(__dirname, "../web/login.html"), "utf8");
  assert.match(html, /id="macos-service-card"[^>]*hidden/);
  assert.match(html, /id="macos-service-configure"[^>]*disabled/);
  assert.match(html, /id="statusline-configure"[^>]*disabled/);
  assert.match(html, /service\.operation\?\.id !== operationId/);
  assert.match(html, /service\.instance\.installationId !== installationId/);
  assert.match(html, /new DOMParser\(\)\.parseFromString\(html, "text\/html"\)/);
});

const serviceStatus = (values = {}) => ({ supported: true, ready: true, registered: false, running: false, state: "missing",
  instance: { pid: 101, installationId: "a".repeat(64) }, ...values });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("service card follows backend platform only, and status failure immediately disables registration", async () => {
  let supported = true;
  let fail = false;
  const page = pageHarness(async () => [], { status: () => {
    if (fail) throw new Error("status offline");
    return { macosService: serviceStatus({ supported }) };
  } });
  assert.equal(page.element("macos-service-configure").disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("macos-service-card").hidden, false);
  assert.equal(page.element("macos-service-configure").disabled, false);
  assert.equal(page.requests.length, 1);
  supported = false;
  await page.refresh();
  assert.equal(page.element("macos-service-card").hidden, true);
  assert.equal(page.element("macos-service-configure").disabled, true);
  supported = true;
  await page.refresh();
  fail = true;
  await page.refresh();
  assert.equal(page.element("macos-service-configure").disabled, true);
});

test("service registration has independent busy state, prevents duplicate POSTs, and accepts only verified completion", async () => {
  let finishPost;
  let posted = false;
  const page = pageHarness(async () => [], { fastWait: true,
    status: () => ({ claudeCli: { ready: true }, statusline: { ready: true }, macosService: serviceStatus(posted ? {
      registered: true, running: true, state: "registered", operation: { id: "op-1", phase: "completed" }
    } : {}) }),
    configure: () => new Promise((resolve) => { finishPost = resolve; posted = true; })
  });
  await new Promise((resolve) => setImmediate(resolve));
  const first = page.element("macos-service-configure").listeners.click();
  await page.element("macos-service-configure").listeners.click();
  assert.equal(page.element("macos-service-configure").disabled, true);
  assert.equal(page.element("cli-configure").disabled, false);
  assert.equal(page.element("statusline-configure").disabled, false);
  assert.doesNotMatch(page.element("macos-service-status").textContent, /running and registered/);
  finishPost(response({ accepted: true, operationId: "op-1", state: "pending" }, 202));
  await first;
  assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
  assert.match(page.element("macos-service-status").textContent, /running and registered/);
  assert.match(page.element("cli-status").textContent, /Ready to configure/);
  await page.refresh();
  assert.match(page.element("macos-service-status").textContent, /running and registered/);
});

test("already registered no-op and fixed backend errors keep independent persistent service feedback", async () => {
  let fails = false;
  const page = pageHarness(async () => [], { status: () => ({ macosService: serviceStatus(), statusline: { ready: true } }),
    configure: async () => fails ? response({ error: "Remove the environment override first." }, 409) : response({ state: "already_registered" }) });
  await new Promise((resolve) => setImmediate(resolve));
  await page.element("macos-service-configure").listeners.click();
  assert.match(page.element("macos-service-status").textContent, /Nothing was changed/);
  fails = true;
  await page.element("macos-service-configure").listeners.click();
  assert.match(page.element("macos-service-status").textContent, /environment override/);
  assert.match(page.element("statusline-status").textContent, /Ready/);
});

for (const lostPost of [false, true]) {
  test(`service ${lostPost ? "lost POST checks outcome" : "pending polling reconnects"} with a new nonce and never reposts`, async () => {
    let posted = false;
    let reconnected = false;
    const nextNonce = "b".repeat(43);
    const page = pageHarness(async () => [], { fastWait: true, requestImpl: async (url, options) => {
      if (url.endsWith("/login")) {
        reconnected = true;
        return { ok: true, text: async () => `<meta name="auth-nonce" content="${nextNonce}"><script>throw new Error("must not execute")</script>` };
      }
      if (options.method === "POST") {
        posted = true;
        if (lostPost) throw Object.assign(new Error("lost response"), { name: "AbortError" });
        return response({ accepted: true, operationId: "op-new", state: "pending" }, 202);
      }
      if (!posted) return response({ macosService: serviceStatus() });
      if (!reconnected) return response({}, 403);
      assert.equal(options.headers.get("X-Auth-Nonce"), nextNonce);
      return response({ macosService: serviceStatus({ registered: true, running: true, state: "registered", operation: { id: "op-new", phase: "completed" } }) });
    } });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.match(page.element("macos-service-status").textContent, /running and registered/);
    assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
    assert.equal(page.requests.filter((request) => request.url.endsWith("/login")).length, 1);
  });
}

for (const recovery of ["recovered", "recovery_failed"]) {
  test(`service ${recovery} displays an explicit failure, not success`, async () => {
    let posted = false;
    const page = pageHarness(async () => [], { fastWait: true,
      status: () => ({ macosService: serviceStatus(posted ? { state: "failed", operation: { id: "op-failed", phase: "failed", recovery } } : {}) }),
      configure: async () => { posted = true; return response({ accepted: true, operationId: "op-failed", state: "pending" }, 202); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.equal(page.element("macos-service-status").dataset.kind, "error");
    assert.match(page.element("macos-service-status").textContent, recovery === "recovered" ? /original proxy was recovered/ : /Start mac\/start-proxy.sh manually/);
  });
}

test("setup gates start disabled and one status refresh enables them without fetching credentials", async () => {
  const markup = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8");
  assert.match(markup, /id="cli-configure" type="button" disabled/);
  const page = pageHarness(async () => ["must-not-load"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("cli-configure").disabled, false);
  assert.equal(page.requests.length, 1);
  assert.ok(page.requests[0].url.endsWith("/status"));
  assert.equal(page.requests[0].options.headers.get("X-Auth-Nonce"), "test-page-nonce");
  assert.equal(page.requests[0].options.cache, "no-store");
});

test("independent configuration posts empty objects and presents English next steps", async () => {
  const page = pageHarness(async () => []);
  await new Promise((resolve) => setImmediate(resolve));
  await page.element("cli-configure").listeners.click();
  const request = page.requests.find((item) => item.url.endsWith("/claude/configure"));
  assert.equal(request.options.body, "{}");
  assert.match(page.element("cli-status").textContent, /Open a new terminal and run claude, then use \/model/);
});

test("credentials gate CLI, authorization updates readiness, and status failure disables configuration", async () => {
  let ready = false;
  let fail = false;
  const page = pageHarness(async () => [], { status: () => {
    if (fail) throw new Error("status failed");
    return { claudeCli: { ready, reason: ready ? "" : "Configure a credential first." } };
  }, configure: async () => ({ ok: true, json: async () => ({ status: "complete" }) }) });
  assert.equal(page.element("cli-configure").disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.element("cli-configure").disabled, true);
  assert.match(page.element("cli-status").textContent, /credential/);
  ready = false;
  await page.refresh();
  ready = true;
  await page.authorizationComplete();
  assert.equal(page.element("cli-configure").disabled, false);
  fail = true;
  await page.refresh();
  assert.equal(page.element("cli-configure").disabled, true);
});

test("parallel setup buttons keep independent busy, success and fixed backend errors", async () => {
  const pending = new Map();
  const page = pageHarness(async () => [], { configure: (url) => new Promise((resolve) => pending.set(url, resolve)) });
  await new Promise((resolve) => setImmediate(resolve));
  const cli = page.element("cli-configure").listeners.click();
  const statusline = page.element("statusline-configure").listeners.click();
  await page.element("statusline-configure").listeners.click();
  assert.equal(page.element("statusline-configure").dataset.busy, "true");
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  pending.get("http://localhost:8082/api/auth/statusline/configure")(response({ success: true, message: "Statusline done." }));
  await statusline;
  assert.match(page.element("statusline-status").textContent, /next refresh or new session/);
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  pending.get("http://localhost:8082/api/auth/claude/configure")(response({ error: "Handle authentication conflicts first." }, 409));
  await cli;
  assert.match(page.element("statusline-status").textContent, /Statusline done/);
  assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 2);
  assert.ok(page.requests.filter((request) => request.options.method === "POST").every((request) => request.options.body === "{}"));
});

for (const mismatch of ["operation", "installation", "socket"]) {
  test(`service refuses ${mismatch} mismatch without reporting success`, async () => {
    let posted = false;
    const page = pageHarness(null, { fastWait: true,
      status: () => ({ macosService: serviceStatus(posted ? {
        registered: true, running: true, operation: { id: mismatch === "operation" ? "op-other" : "op-1", phase: "completed" },
        ...(mismatch === "installation" ? { instance: { pid: 102, installationId: "b".repeat(64) } } : {}),
        ...(mismatch === "socket" ? { running: false } : {})
      } : {}) }),
      configure: async () => { posted = true; return response({ accepted: true, operationId: "op-1", state: "pending" }, 202); }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await page.element("macos-service-configure").listeners.click();
    assert.equal(page.element("macos-service-status").dataset.kind, "error");
    assert.doesNotMatch(page.element("macos-service-status").textContent, /running and registered/);
    assert.equal(page.requests.filter((request) => request.options.method === "POST").length, 1);
  });
}

test("configuration keeps busy state and presents fixed backend errors", async () => {
  const pending = new Map();
  const page = pageHarness(async () => [], { configure: (url) => new Promise((resolve) => pending.set(url, resolve)) });
  await new Promise((resolve) => setImmediate(resolve));
  const cli = page.element("cli-configure").listeners.click();
  assert.equal(page.element("cli-configure").dataset.busy, "true");
  assert.equal(page.element("cli-configure").disabled, true);
  assert.equal(page.element("cli-status").textContent, "Configuring…");
  pending.get("http://localhost:8082/api/auth/claude/configure")({ ok: false, status: 409, json: async () => ({ error: "Handle authentication conflicts first.", fields: ["apiKeyHelper"] }) });
  await cli;
  assert.match(page.element("cli-status").textContent, /apiKeyHelper/);
  assert.equal(page.element("cli-configure").dataset.busy, "false");
});

test("Online Summary toggle greys out the model select, defaults to the detected model and saves only the changed setting", async () => {
  let settings = { available: true, enabled: false, model: null, defaultModel: "gpt-6-luna", models: ["claude-haiku-5.5", "gpt-6-luna"] };
  const posts = [];
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: settings }),
    configure: async (url, options) => {
      const change = JSON.parse(options.body);
      posts.push({ url, change });
      if ("enabled" in change) settings = { ...settings, enabled: change.enabled };
      if ("model" in change) settings = { ...settings, model: change.model };
      return { ok: true, json: async () => ({ success: true, onlineSummary: settings }) };
    } });
  await page.refresh();
  const toggle = page.element("online-summary-enabled");
  const select = page.element("online-summary-model");
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(select.disabled, true);
  assert.equal(select.value, "gpt-6-luna");
  assert.deepEqual(select.children.map((option) => option.textContent), ["claude-haiku-5.5", "gpt-6-luna (detected cheap model)"]);
  assert.match(page.element("online-summary-status").textContent, /off/);

  toggle.checked = true;
  await toggle.listeners.change();
  assert.deepEqual(posts.at(-1), { url: "http://localhost:8082/api/auth/online-summary/configure", change: { enabled: true } });
  assert.equal(select.disabled, false);
  assert.equal(select.value, "gpt-6-luna");
  assert.match(page.element("online-summary-status").textContent, /Saved.*without restarting/);

  select.value = "claude-haiku-5.5";
  await select.listeners.change();
  assert.deepEqual(posts.at(-1).change, { model: "claude-haiku-5.5" });
  assert.equal(select.value, "claude-haiku-5.5");

  toggle.checked = false;
  await toggle.listeners.change();
  assert.deepEqual(posts.at(-1).change, { enabled: false });
  assert.equal(select.disabled, true);
  assert.equal(select.value, "claude-haiku-5.5");
});

test("Online Summary shows save failures and keeps controls disabled when settings are unavailable", async () => {
  const page = pageHarness(async () => [], { status: () => ({ onlineSummary: { available: true, enabled: true, model: null, defaultModel: "gpt-6-luna", models: ["gpt-6-luna"] } }),
    configure: async () => ({ ok: false, status: 400, json: async () => ({ error: "Choose a model from the list." }) }) });
  await page.refresh();
  await page.element("online-summary-model").listeners.change();
  assert.match(page.element("online-summary-status").textContent, /Choose a model from the list/);
  const unavailable = pageHarness(async () => [], { status: () => ({}) });
  await unavailable.refresh();
  assert.equal(unavailable.element("online-summary-enabled").disabled, true);
  assert.equal(unavailable.element("online-summary-model").disabled, true);
  assert.match(unavailable.element("online-summary-status").textContent, /unavailable/);
});
