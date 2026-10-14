const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// 固定版本探测，不执行 shell 或浏览器提供的命令。
function createSetupProbe({ env = process.env, platform = process.platform, home = os.homedir(),
  node = process.execPath, execFileImpl = execFile, fsImpl = fs } = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  const directories = [...new Set([
    ...String(env.PATH || "").split(platform === "win32" ? ";" : ":").filter((dir) => paths.isAbsolute(dir)).slice(0, 24),
    paths.join(home, ".local", "bin"), paths.join(home, ".npm-global", "bin"),
    ...(platform === "win32" ? [paths.join(env.APPDATA || paths.join(home, "AppData", "Roaming"), "npm"),
      paths.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin"),
      paths.join(env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin"),
      paths.join(home, "scoop", "shims")] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
  ])];
  const safeEnv = { ...env };
  for (const name of ["BASH_ENV", "ENV", "NODE_OPTIONS"]) delete safeEnv[name];
  const run = (file, args) => new Promise((resolve) => {
    execFileImpl(file, args, { timeout: 1800, maxBuffer: 4096, windowsHide: true,
      shell: false, cwd: home, env: safeEnv }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
  const exists = (file) => {
    try { return fsImpl.statSync(file).isFile(); } catch (_) { return false; }
  };
  async function find(name, accepts) {
    const candidates = directories.map((dir) => paths.join(dir, name + (platform === "win32" ? ".exe" : ""))).filter(exists);
    const results = await Promise.all(candidates.map(async (file) => accepts(await run(file, ["--version"])) ? file : null));
    return results.find(Boolean);
  }
  return async () => {
    const [nativeCli, nodeVersion] = await Promise.all([
      find("claude", (text) => /\b\d+\.\d+\.\d+\b.*Claude Code/i.test(text)),
      run(node, ["--version"])
    ]);
    let cli = nativeCli;
    // npm 在 Windows 上的 .cmd 不可经无 shell 的 execFile 启动；直接使用已知 cli.js。
    if (!cli) {
      const entries = directories.map((dir) => platform === "win32"
        ? paths.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
        : paths.join(dir, "..", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")).filter(exists);
      const results = await Promise.all(entries.map(async (file) => /\b\d+\.\d+\.\d+\b.*Claude Code/i.test(await run(node, [file, "--version"])) ? file : null));
      cli = results.find(Boolean);
    }
    return { cli: Boolean(cli), node: Number(nodeVersion.match(/^v(\d+)\./)?.[1]) >= 18 ? node : null };
  };
}

module.exports = { createSetupProbe };
