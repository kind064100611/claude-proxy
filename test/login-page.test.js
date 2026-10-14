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
      value: "", textContent: "", dataset: {}, hidden: true, disabled: ["cli-configure"].includes(id), attributes: {}, listeners: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; }
    });
    return elements.get(id);
  };
  const document = { hidden: false, listeners: {}, getElementById: element,
    querySelector: () => ({ content: "test-page-nonce" }),
    addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const window = { location: { href: "http://localhost:8082/login", origin: "http://localhost:8082" },
    setTimeout, clearTimeout, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }
  };
  const requests = [];
  const context = {
    document, window, URL, Headers, AbortController,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (requestImpl) return requestImpl(url, options);
      if (url.endsWith("/status")) return { ok: true, json: async () => status ? status() : ({ claudeCli: { installed: true, ready: true, configured: false } }) };
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
