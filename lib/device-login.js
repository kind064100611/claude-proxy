// 改编自 @earendil-works/pi-ai/dist/auth/oauth/{openai-codex,github-copilot,device-code}.js
// 仅保留 device flow，不包含 CLI 或本地 callback server。
// 上游：https://github.com/earendil-works/pi（MIT，Copyright (c) 2025 Mario Zechner）
// 许可全文：../third-party/pi/LICENSE；来源：https://github.com/earendil-works/pi/blob/main/LICENSE
const crypto = require("node:crypto");
const { COPILOT_HEADERS } = require("./copilot-auth");

const OPENAI = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  tokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  exchangeUrl: "https://auth.openai.com/oauth/token",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  verificationUrl: "https://auth.openai.com/codex/device",
  deadlineMs: 15 * 60 * 1000
};
const COPILOT = {
  clientId: "Iv1.b507a08c87ecfe98",
  deviceUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  exchangeUrl: "https://api.github.com/copilot_internal/v2/token"
};
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_SECONDS = 5;
const MIN_INTERVAL_SECONDS = 1;
const SLOW_DOWN_SECONDS = 5;
const TERMINAL_TTL_MS = 30 * 60 * 1000;
const MAX_TERMINAL_SNAPSHOTS = 32;

function createDeviceLogin({ store, fetchImpl = fetch, now = Date.now, sleep = defaultSleep,
  onCredentialsChanged = () => {} } = {}) {
  if (!store || typeof store.saveLogin !== "function") throw new TypeError("A credential store is required");
  if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof sleep !== "function") {
    throw new TypeError("Invalid device login dependencies");
  }

  const sessions = new Map();
  const activeByProvider = new Map();
  let closed = false;

  function getSnapshot(entry) {
    const result = { id: entry.id, provider: entry.provider, status: entry.status };
    if (entry.userCode !== undefined) result.userCode = entry.userCode;
    if (entry.verificationUrl !== undefined) result.verificationUrl = entry.verificationUrl;
    if (entry.error !== undefined) result.error = entry.error;
    return result;
  }

  function prune() {
    const timestamp = now();
    for (const [id, entry] of sessions) {
      if (entry.terminalAt !== undefined && timestamp - entry.terminalAt >= TERMINAL_TTL_MS) sessions.delete(id);
    }
    const terminal = [...sessions.values()].filter((entry) => entry.terminalAt !== undefined);
    while (terminal.length > MAX_TERMINAL_SNAPSHOTS) {
      const oldest = terminal.shift();
      sessions.delete(oldest.id);
    }
  }

  function finish(entry, status, error) {
    if (entry.terminalAt !== undefined) return;
    entry.status = status;
    entry.error = error;
    entry.terminalAt = now();
    entry.secrets = undefined;
    if (activeByProvider.get(entry.provider) === entry.id) activeByProvider.delete(entry.provider);
    prune();
  }

  async function start(provider) {
    if (closed) throw new Error("Device login service is closed");
    if (provider !== "chatgpt" && provider !== "copilot") throw new Error("Unsupported device login provider");
    prune();
    const currentId = activeByProvider.get(provider);
    if (currentId) {
      const current = sessions.get(currentId);
      if (current) return current.startPromise || getSnapshot(current);
      activeByProvider.delete(provider);
    }

    const entry = {
      id: crypto.randomUUID(), provider, status: "starting", userCode: undefined,
      verificationUrl: undefined, error: undefined, controller: new AbortController(),
      deadlineAt: now() + OPENAI.deadlineMs,
      terminalAt: undefined, secrets: undefined, startPromise: undefined
    };
    sessions.set(entry.id, entry);
    activeByProvider.set(provider, entry.id);
    entry.startPromise = initialize(entry).catch((error) => {
      settleError(entry, error, "Unable to start login");
      return getSnapshot(entry);
    }).finally(() => { entry.startPromise = undefined; });
    return entry.startPromise;
  }

  function get(id) {
    prune();
    const entry = sessions.get(id);
    return entry ? getSnapshot(entry) : undefined;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const id of activeByProvider.values()) {
      const entry = sessions.get(id);
      if (!entry) continue;
      entry.controller.abort();
      finish(entry, "cancelled", "Login cancelled");
    }
    activeByProvider.clear();
  }

  async function initialize(entry) {
    if (entry.provider === "chatgpt") {
      const result = await request(entry, OPENAI.userCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: OPENAI.clientId })
      }, "Unable to start login");
      const data = result.data;
      const interval = parseInterval(data?.interval, true);
      if (!result.ok || !isNonEmptyString(data?.device_auth_id) || !isDisplayCode(data?.user_code) || interval === null) {
        throw new SafeLoginError("Unable to start login");
      }
      entry.secrets = { deviceAuthId: data.device_auth_id, intervalSeconds: interval };
      entry.userCode = data.user_code;
      entry.verificationUrl = OPENAI.verificationUrl;
    } else {
      const result = await request(entry, COPILOT.deviceUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": COPILOT_HEADERS["User-Agent"]
        },
        body: new URLSearchParams({ client_id: COPILOT.clientId, scope: "read:user" })
      }, "Unable to start login");
      const data = result.data;
      const interval = parseInterval(data?.interval, true);
      if (!result.ok || !isNonEmptyString(data?.device_code) || !isDisplayCode(data?.user_code) ||
        interval === null || !Number.isFinite(data?.expires_in) || data.expires_in <= 0) {
        throw new SafeLoginError("Unable to start login");
      }
      const verificationUrl = validateCopilotVerificationUrl(data.verification_uri);
      if (!verificationUrl) throw new SafeLoginError("Unable to start login");
      entry.deadlineAt = Math.min(entry.deadlineAt, now() + data.expires_in * 1000);
      entry.secrets = { deviceCode: data.device_code, intervalSeconds: interval };
      entry.userCode = data.user_code;
      entry.verificationUrl = verificationUrl;
    }
    if (entry.terminalAt !== undefined) return getSnapshot(entry);
    entry.status = "pending";
    entry.worker = drive(entry).catch((error) => settleError(entry, error, "Login failed"));
    return getSnapshot(entry);
  }

  async function drive(entry) {
    try {
      if (entry.provider === "chatgpt") await driveChatGpt(entry);
      else await driveCopilot(entry);
    } catch (error) {
      settleError(entry, error, "Login failed");
    }
  }

  function settleError(entry, error, fallback) {
    if (entry.terminalAt !== undefined) return;
    if (error instanceof DeadlineError) finish(entry, "expired", "Device login expired");
    else if (error instanceof RequestTimeoutError) finish(entry, "failed", "Login request timed out");
    else if (error instanceof CancelledError || entry.controller.signal.aborted) finish(entry, "cancelled", "Login cancelled");
    else if (error instanceof SafeLoginError) finish(entry, "failed", error.message);
    else finish(entry, "failed", fallback);
  }

  async function request(entry, url, init, failureMessage) {
    if (entry.controller.signal.aborted) throw new CancelledError();
    const remaining = entry.deadlineAt - now();
    if (remaining <= 0) throw new DeadlineError();
    const requestController = new AbortController();
    const signal = AbortSignal.any([entry.controller.signal, requestController.signal]);
    const deadlineLimited = remaining <= REQUEST_TIMEOUT_MS;
    let timer;
    let abortHandler;
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        requestController.abort();
        reject(deadlineLimited ? new DeadlineError() : new RequestTimeoutError());
      }, Math.min(REQUEST_TIMEOUT_MS, remaining));
    });
    const abortPromise = new Promise((resolve, reject) => {
      abortHandler = () => reject(new CancelledError());
      entry.controller.signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      return await Promise.race([
        (async () => {
          try {
            const response = await fetchImpl(url, { ...init, redirect: "error", signal });
            const data = await response.json().catch(() => null);
            return { ok: responseOk(response), status: response.status, data };
          } catch (error) {
            if (entry.controller.signal.aborted) throw new CancelledError();
            throw new SafeLoginError(failureMessage);
          }
        })(),
        timeoutPromise,
        abortPromise
      ]);
    } finally {
      clearTimeout(timer);
      entry.controller.signal.removeEventListener("abort", abortHandler);
    }
  }

  function checkDeadline(entry) {
    if (entry.controller.signal.aborted) throw new CancelledError();
    if (now() >= entry.deadlineAt) throw new DeadlineError();
  }

  async function waitForPoll(entry, milliseconds) {
    checkDeadline(entry);
    const delay = Math.max(0, Math.min(milliseconds, entry.deadlineAt - now()));
    if (!delay) throw new DeadlineError();
    let abortHandler;
    const abortPromise = new Promise((resolve, reject) => {
      abortHandler = () => reject(new CancelledError());
      entry.controller.signal.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => sleep(delay, entry.controller.signal)).catch((error) => {
          if (entry.controller.signal.aborted) throw new CancelledError();
          throw new SafeLoginError("Login failed");
        }),
        abortPromise
      ]);
    } finally {
      entry.controller.signal.removeEventListener("abort", abortHandler);
    }
    checkDeadline(entry);
  }

  async function driveChatGpt(entry) {
    let interval = entry.secrets.intervalSeconds;
    let authorization;
    while (!authorization) {
      checkDeadline(entry);
      const result = await request(entry, OPENAI.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: entry.secrets.deviceAuthId,
          user_code: entry.userCode
        })
      }, "Login failed");
      const data = result.data;
      const code = oauthErrorCode(data);
      if (isDenied(code)) throw new SafeLoginError("Login was denied");
      if (isExpired(code)) throw new DeadlineError();
      if (code === "slow_down") interval = slowDownInterval(interval, data?.interval);
      else if (code === "authorization_pending" || code === "deviceauth_authorization_pending" || result.status === 403 || result.status === 404) {
        // OpenAI reports a pending device authorization with either an error code or 403/404.
      } else if (result.ok && isNonEmptyString(data?.authorization_code) && isNonEmptyString(data?.code_verifier)) {
        authorization = { code: data.authorization_code, verifier: data.code_verifier };
      } else {
        throw new SafeLoginError("Login failed");
      }
      if (!authorization) await waitForPoll(entry, interval * 1000);
    }

    checkDeadline(entry);
    const exchanged = await request(entry, OPENAI.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI.clientId,
        code: authorization.code,
        code_verifier: authorization.verifier,
        redirect_uri: OPENAI.redirectUri
      })
    }, "Unable to exchange login code");
    if (!exchanged.ok || !isNonEmptyString(exchanged.data?.access_token) ||
      !isNonEmptyString(exchanged.data?.refresh_token) || !Number.isFinite(exchanged.data?.expires_in) ||
      exchanged.data.expires_in <= 0) throw new SafeLoginError("Unable to exchange login code");
    const accountId = openAiAccountId(exchanged.data.access_token);
    if (!accountId) throw new SafeLoginError("Unable to exchange login code");
    saveCredential(entry, {
      type: "oauth",
      access: exchanged.data.access_token,
      refresh: exchanged.data.refresh_token,
      expires: now() + exchanged.data.expires_in * 1000,
      accountId
    }, "openai-codex");
  }

  async function driveCopilot(entry) {
    let interval = entry.secrets.intervalSeconds;
    let oauthToken;
    while (!oauthToken) {
      await waitForPoll(entry, interval * 1000);
      const result = await request(entry, COPILOT.tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": COPILOT_HEADERS["User-Agent"]
        },
        body: new URLSearchParams({
          client_id: COPILOT.clientId,
          device_code: entry.secrets.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code"
        })
      }, "Login failed");
      const data = result.data;
      const code = oauthErrorCode(data);
      if (isDenied(code)) throw new SafeLoginError("Login was denied");
      if (isExpired(code)) throw new DeadlineError();
      if (code === "slow_down") interval = slowDownInterval(interval, data?.interval);
      else if (code === "authorization_pending") continue;
      else if (result.ok && isNonEmptyString(data?.access_token)) oauthToken = data.access_token;
      else throw new SafeLoginError("Login failed");
    }

    checkDeadline(entry);
    const exchanged = await request(entry, COPILOT.exchangeUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...COPILOT_HEADERS
      }
    }, "Unable to finish Copilot login");
    const data = exchanged.data;
    if (!exchanged.ok || !isNonEmptyString(data?.token) || !Number.isFinite(data?.expires_at) || data.expires_at * 1000 <= now()) {
      throw new SafeLoginError("Unable to finish Copilot login");
    }
    saveCredential(entry, {
      type: "oauth",
      refresh: oauthToken,
      access: data.token,
      expires: data.expires_at * 1000 - 5 * 60 * 1000
    }, "github-copilot");
  }

  function saveCredential(entry, credential, storeProvider) {
    checkDeadline(entry);
    try {
      store.saveLogin(storeProvider, credential);
    } catch (_) {
      throw new SafeLoginError("Unable to save login credentials");
    }
    try {
      Promise.resolve(onCredentialsChanged(storeProvider)).catch(() => {});
    } catch (_) { /* Credential persistence has already succeeded. */ }
    finish(entry, "complete");
  }

  return { start, get, close };
}

class SafeLoginError extends Error {}
class RequestTimeoutError extends Error {}
class DeadlineError extends Error {}
class CancelledError extends Error {}

function defaultSleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(new CancelledError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function responseOk(response) {
  if (typeof response.ok === "boolean") return response.ok;
  return Number.isFinite(response.status) && response.status >= 200 && response.status < 300;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isDisplayCode(value) {
  return typeof value === "string" && /^[a-z0-9-]{4,32}$/i.test(value);
}

function parseInterval(value, allowMissing = false) {
  if (value === undefined && allowMissing) return DEFAULT_INTERVAL_SECONDS;
  const seconds = typeof value === "string" && value.trim() ? Number(value.trim()) : value;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds * 1000) / 1000);
}

function slowDownInterval(current, serverInterval) {
  if (Number.isFinite(serverInterval) && serverInterval > 0) {
    return Math.max(MIN_INTERVAL_SECONDS, Math.floor(serverInterval * 1000) / 1000);
  }
  return Math.max(MIN_INTERVAL_SECONDS, current + SLOW_DOWN_SECONDS);
}

function oauthErrorCode(data) {
  const error = data && typeof data === "object" ? data.error : undefined;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.code === "string") return error.code;
    if (typeof error.error === "string") return error.error;
  }
  return undefined;
}

function isDenied(code) {
  return ["access_denied", "authorization_declined", "deviceauth_denied", "device_code_denied"].includes(code);
}

function isExpired(code) {
  return ["expired", "expired_token", "deviceauth_expired", "device_code_expired"].includes(code);
}

function validateCopilotVerificationUrl(value) {
  if (!isNonEmptyString(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" ||
      (url.port && url.port !== "443") || url.username || url.password || url.pathname !== "/login/device") {
      return undefined;
    }
    return "https://github.com/login/device";
  } catch (_) {
    return undefined;
  }
}

function openAiAccountId(accessToken) {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return isNonEmptyString(accountId) ? accountId : undefined;
  } catch (_) {
    return undefined;
  }
}

module.exports = { createDeviceLogin };
