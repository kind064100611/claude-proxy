const { defaultStore } = require("./credential-store");

const refreshes = new Map();
const authError = (message) => Object.assign(new Error(message), { status: 401 });

function selectOpenAIProvider(data) {
  return data["openai-codex"]?.loginVersion ? "openai-codex" : data.openai ? "openai" : "openai-codex";
}

async function loadPiAuth({ fetchImpl = fetch, store = defaultStore } = {}) {
  if (process.env.OPENAI_API_KEY) return { token: process.env.OPENAI_API_KEY, kind: "api" };
  const file = store.authFile;
  if (refreshes.has(file)) return refreshes.get(file);
  const operation = (async () => {
    let data;
    try { data = store.readAuth(); }
    catch (_) { throw authError("\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u8BA4\u8BC1\u6587\u4EF6\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6216\u6253\u5F00 http://localhost:8082/login"); }
    const provider = selectOpenAIProvider(data);
    let credential = data[provider];
    if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key) {
      return { token: credential.key, kind: "api" };
    }
    if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access ||
      typeof credential.refresh !== "string" || !credential.refresh || !Number.isFinite(credential.expires)) {
      throw authError("请打开 http://localhost:8082/login 登录 ChatGPT，或设置 OPENAI_API_KEY");
    }
    const kind = provider === "openai-codex" ? "codex" : "chatgpt";
    if (credential.expires <= Date.now() + 60000) {
      const clientId = kind === "codex" ? "app_EMoamEEZ73f0CkXaXp7hrann" : credential.clientId;
      if (!clientId) throw authError("OpenAI OAuth 缺少 clientId；请打开 http://localhost:8082/login 重新登录");
      const params = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh });
      if (kind === "chatgpt") params.set("resource", "https://api.openai.com/v1");
      let token;
      try {
        const response = await fetchImpl(kind === "codex" ? "https://auth.openai.com/oauth/token" : "https://auth.openai.com/api/accounts/oauth/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params,
          signal: AbortSignal.timeout(30000), redirect: "error"
        });
        if (!response.ok) throw new Error();
        token = await response.json();
      } catch (_) { throw authError("OAuth refresh failed；请打开 http://localhost:8082/login 重新登录"); }
      if (typeof token?.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" ||
        !token.refresh_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0 ||
        kind === "codex" && !getCodexAccountId(token.access_token)) {
        throw authError("Pi OAuth refresh response is missing token fields");
      }
      credential = { ...credential, access: token.access_token, refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000 - (kind === "chatgpt" ? 180000 : 0) };
      // \u65B0\u7F51\u9875\u767B\u5F55\uFF08\u5373\u4F7F refresh token \u76F8\u540C\uFF09\u4E5F\u4F18\u5148\u4E8E\u65E7\u5237\u65B0\u7ED3\u679C\u3002
      try {
        if (!store.updateProvider(provider, { access: credential.access, refresh: credential.refresh, expires: credential.expires }, data[provider])) throw new Error();
      } catch (_) { throw authError("\u672C\u5730\u51ED\u636E\u5728 refresh \u671F\u95F4\u53D1\u751F\u53D8\u5316\u6216\u65E0\u6CD5\u4FDD\u5B58\uFF1B\u8BF7\u91CD\u8BD5"); }
    }
    const result = { token: credential.access, kind };
    if (kind === "codex") {
      result.accountId = getCodexAccountId(credential.access);
      if (!result.accountId) throw authError("Codex token does not contain chatgpt_account_id；请打开 http://localhost:8082/login 重新登录");
    }
    return result;
  })();
  refreshes.set(file, operation);
  try { return await operation; }
  finally { refreshes.delete(file); }
}

function getCodexAccountId(access) {
  try {
    const accountId = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"))
      ["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
  } catch (_) { return undefined; }
}

module.exports = { loadPiAuth, selectOpenAIProvider };
