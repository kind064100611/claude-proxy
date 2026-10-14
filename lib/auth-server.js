const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { defaultStore } = require("./credential-store");
const { selectOpenAIProvider } = require("./pi-auth");
const { createDeviceLogin } = require("./device-login");
const { setupFailure } = require("./claude-setup");

const MAX_AUTH_BODY_BYTES = 16 * 1024;

function createAuthRouter({ port = 8082, store = defaultStore, login, setup, onCredentialsChanged = () => {}, env = process.env } = {}) {
  const nonce = crypto.randomBytes(32).toString("base64url");
  const flows = login || createDeviceLogin({ store, onCredentialsChanged });
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  function isLocal(req) {
    const address = req.socket.remoteAddress;
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) && hosts.has(req.headers.host?.toLowerCase());
  }

  function headers(res, page = false) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const resources = page ? `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` : "";
    res.setHeader("Content-Security-Policy", `default-src 'none'; ${resources}connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  }

  function json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let settled = false;
      const timer = setTimeout(() => fail(408), 10000);
      function fail(status) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chunks.length = 0;
        reject(Object.assign(new Error(), { status }));
      }
      req.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_AUTH_BODY_BYTES) { fail(413); return; }
        chunks.push(chunk);
      });
      req.on("error", () => fail(400));
      req.on("aborted", () => fail(400));
      req.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
          resolve(value);
        } catch (_) { reject(Object.assign(new Error(), { status: 400 })); }
      });
    });
  }

  function status() {
    const auth = store.readAuth();
    const selected = auth[selectOpenAIProvider(auth)];
    const configured = (value) => Boolean(value && (value.type === "api_key" && typeof value.key === "string" && value.key ||
      value.type === "oauth" && typeof value.access === "string" && value.access && typeof value.refresh === "string" && value.refresh && Number.isFinite(value.expires)));
    return {
      chatgpt: { configured: configured(selected), environmentOverride: Boolean(env.OPENAI_API_KEY) },
      copilot: { configured: auth["github-copilot"]?.type === "oauth" && configured(auth["github-copilot"]) },
      storagePath: store.directory
    };
  }
  async function handle(req, res) {
    const route = req.url?.split("?")[0];
    const setupRoute = route === "/api/auth/claude/configure";
    if (route !== "/login" && route !== "/api/auth" && !route?.startsWith("/api/auth/")) return false;
    headers(res);
    if (!isLocal(req)) { json(res, 403, { error: setupRoute ? "Configuration is available only through the local page." : "登录入口仅允许本机同源访问。" }); return true; }
    if (route === "/login") {
      if (req.method !== "GET") { json(res, 405, { error: "请求方法不支持。" }); return true; }
      try {
        const page = fs.readFileSync(path.join(__dirname, "..", "web", "login.html"), "utf8").replaceAll("__AUTH_NONCE__", nonce);
        headers(res, true);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
      } catch (_) { json(res, 503, { error: "本地登录页面不可用。" }); }
      return true;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      json(res, 405, { error: setupRoute ? "Request method is not supported." : "请求方法不支持。" }); return true;
    }
    if (req.headers["x-auth-nonce"] !== nonce) { json(res, 403, { error: setupRoute ? "Reload the local page before configuring." : "请从本地登录页面发起请求。" }); return true; }
    if (req.method === "POST" && (req.headers.origin !== `http://${req.headers.host}` ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || ""))) {
      json(res, 403, { error: setupRoute ? "Only local same-origin JSON requests are allowed." : "仅允许本机同源 JSON 请求。" }); return true;
    }
    try {
      if (req.method === "GET" && route === "/api/auth/status") {
        const unavailable = { installed: false, ready: false, configured: false, reason: "Local setup is unavailable." };
        json(res, 200, { ...status(), ...(setup ? await setup.getStatus() : { claudeCli: unavailable }) });
      } else if (req.method === "POST" && setupRoute) {
        const body = await readBody(req);
        if (Object.keys(body).length) { json(res, 400, { error: "Configuration requests must contain only an empty JSON object." }); return true; }
        if (!setup) { json(res, 503, { error: "Local setup is unavailable." }); return true; }
        const result = await setup.configureCli();
        json(res, 200, result);
      }
      else if (req.method === "GET" && /^\/api\/auth\/flow\/[a-zA-Z0-9_-]+$/.test(route)) {
        const flow = flows.get(route.slice("/api/auth/flow/".length));
        json(res, flow ? 200 : 404, flow || { error: "登录流程不存在或已过期。" });
      } else if (req.method === "POST" && ["/api/auth/chatgpt/start", "/api/auth/copilot/start"].includes(route)) {
        const body = await readBody(req);
        json(res, 200, await flows.start(route.includes("/chatgpt/") ? "chatgpt" : "copilot"));
      } else json(res, 404, { error: "登录接口不存在。" });
    } catch (error) {
      if (setupRoute) {
        if ([400, 408, 413].includes(error.status)) {
          json(res, error.status, { error: error.status === 413 ? "Request body is too large." : error.status === 408 ? "Configuration request timed out." : "An empty JSON object is required." });
        } else {
          const failure = setupFailure(error);
          json(res, failure.status, failure.body);
        }
      } else {
        const code = [400, 408, 413].includes(error.status) ? error.status : 503;
        json(res, code, { error: code === 413 ? "请求体过大。" : "登录操作未完成；请检查输入或稍后重试。" });
      }
    }
    return true;
  }
  handle.close = () => flows.close();
  return handle;
}

module.exports = { createAuthRouter, MAX_AUTH_BODY_BYTES };
