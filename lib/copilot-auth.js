const { defaultStore } = require("./credential-store");

const refreshes = new Map();
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat"
};
const authError = (message) => Object.assign(new Error(message), { status: 401 });

function getCopilotBaseUrl(token, enterpriseDomain) {
  const proxyHost = token.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
  if (proxyHost) {
    if (!/^[a-z0-9.-]+$/i.test(proxyHost)) throw authError("Invalid Copilot proxy endpoint");
    return `https://${proxyHost.replace(/^proxy\./, "api.")}`;
  }
  return enterpriseDomain ? `https://copilot-api.${enterpriseDomain}` : "https://api.individual.githubcopilot.com";
}

async function loadCopilotAuth({ fetchImpl = fetch, signal, store = defaultStore } = {}) {
  const file = store.authFile;
  if (refreshes.has(file)) return refreshes.get(file);
  const operation = (async () => {
    let data;
    try { data = store.readAuth(); }
    catch (_) { throw authError("\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u8BA4\u8BC1\u6587\u4EF6\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6216\u6253\u5F00 http://localhost:8082/login"); }
    let credential = data["github-copilot"];
    if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access ||
      typeof credential.refresh !== "string" || !credential.refresh || !Number.isFinite(credential.expires)) {
      throw authError("缺少 github-copilot OAuth 凭据；请打开 http://localhost:8082/login 登录 Copilot");
    }
    let enterpriseDomain;
    if (credential.enterpriseUrl) {
      try {
        const url = new URL(credential.enterpriseUrl.includes("://") ? credential.enterpriseUrl : `https://${credential.enterpriseUrl}`);
        if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error();
        enterpriseDomain = url.hostname;
      } catch (_) { throw authError("Invalid Copilot enterprise domain"); }
    }
    if (credential.expires <= Date.now() + 60000) {
      const timeout = AbortSignal.timeout(30000);
      let token;
      try {
        const response = await fetchImpl(`https://api.${enterpriseDomain || "github.com"}/copilot_internal/v2/token`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${credential.refresh}`, ...COPILOT_HEADERS },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error"
        });
        if (!response.ok) throw new Error();
        token = await response.json();
      } catch (_) { throw authError("Copilot token refresh failed；请打开 http://localhost:8082/login 重新登录"); }
      if (typeof token?.token !== "string" || !token.token || !Number.isFinite(token.expires_at) || token.expires_at * 1000 <= Date.now()) {
        throw authError("Copilot refresh response is missing valid token fields");
      }
      credential = { ...credential, access: token.token, expires: token.expires_at * 1000 - 300000 };
      try {
        if (!store.updateProvider("github-copilot", { access: credential.access, expires: credential.expires }, data["github-copilot"])) throw new Error();
      } catch (_) { throw authError("\u672C\u5730\u51ED\u636E\u5728 Copilot refresh \u671F\u95F4\u53D1\u751F\u53D8\u5316\u6216\u65E0\u6CD5\u4FDD\u5B58\uFF1B\u8BF7\u91CD\u8BD5"); }
    }
    return { token: credential.access, baseUrl: getCopilotBaseUrl(credential.access, enterpriseDomain) };
  })();
  refreshes.set(file, operation);
  try { return await operation; }
  finally { refreshes.delete(file); }
}

module.exports = { loadCopilotAuth, getCopilotBaseUrl, COPILOT_HEADERS };
