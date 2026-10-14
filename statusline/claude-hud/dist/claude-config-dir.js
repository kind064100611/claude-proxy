import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
function expandHomeDirPrefix(inputPath, homeDir) {
    if (inputPath === '~') {
        return homeDir;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(homeDir, inputPath.slice(2));
    }
    return inputPath;
}
export function getClaudeConfigDir(homeDir) {
    const envConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();
    if (!envConfigDir) {
        return path.join(homeDir, '.claude');
    }
    return path.resolve(expandHomeDirPrefix(envConfigDir, homeDir));
}
export function getClaudeConfigJsonPath(homeDir) {
    return `${getClaudeConfigDir(homeDir)}.json`;
}
export function getHudPluginDir(homeDir) {
    const bundledDir = process.env.TOOLKIT_STATUSLINE_DIR?.trim();
    if (bundledDir) {
        // Resolve from this ESM file, not an MSYS /c/... environment path on Windows.
        return fileURLToPath(new URL('../plugins/claude-hud', import.meta.url));
    }
    return path.join(getClaudeConfigDir(homeDir), 'plugins', 'claude-hud');
}
//# sourceMappingURL=claude-config-dir.js.map