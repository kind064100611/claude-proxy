const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const THRESHOLD_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_SESSION_ARCHIVE_BYTES = 128 * 1024 * 1024;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function getFeatureConfigPath(home = os.homedir()) {
  return path.join(home, ".claude", "gateway-features.json");
}

// 启动入口显式迁移旧仓库开关；导入模块和 GET status 永远不写配置。
function migrateFeatureConfig({ home = os.homedir(), legacyFile = path.resolve(__dirname, "..", "gateway-features.json") } = {}) {
  const filename = getFeatureConfigPath(home);
  const directory = path.dirname(filename);
  const owner = (stat) => !process.getuid || stat.uid === process.getuid();
  let temporary;
  let fd;
  try {
    let parent;
    try { parent = fs.lstatSync(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink() || !owner(parent))) throw new Error();
    // 已有用户文件优先，损坏/符号链接目标也不得被迁移覆盖。
    try { fs.lstatSync(filename); return { migrated: false }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let source;
    try { source = fs.lstatSync(legacyFile); }
    catch (error) { if (error.code === "ENOENT") return { migrated: false }; throw error; }
    if (!source.isFile() || source.isSymbolicLink() || !owner(source) || source.size > 64 * 1024) throw new Error();
    fd = fs.openSync(legacyFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== source.ino || opened.dev !== source.dev || opened.size > 64 * 1024) throw new Error();
    const bytes = fs.readFileSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const config = JSON.parse(bytes.toString("utf8"));
    if (!config || config.version !== 1 || typeof config.observationPack !== "boolean") throw new Error();
    if (!parent) fs.mkdirSync(directory, { mode: 0o700 });
    temporary = path.join(directory, `.gateway-features-${crypto.randomBytes(12).toString("hex")}.tmp`);
    writeExclusive(temporary, bytes);
    // 同目录 hard-link 发布不覆盖并发创建的用户配置，源文件保留以便核对。
    try { fs.linkSync(temporary, filename); }
    catch (error) { if (error.code === "EEXIST") return { migrated: false }; throw error; }
    return { migrated: true };
  } catch (_) {
    return { migrated: false, warning: "Feature toggle migration was not completed. Check ~/.claude/gateway-features.json; the legacy file was kept." };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
}

function getStatus(configFile = getFeatureConfigPath()) {
  let fd;
  try {
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { observationPack: false };
    fd = fs.openSync(configFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 64 * 1024) return { observationPack: false };
    const config = JSON.parse(fs.readFileSync(fd, "utf8"));
    return { observationPack: config.version === 1 && config.observationPack === true };
  } catch (error) {
    return { observationPack: error.code === "ENOENT" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function privateDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Unsafe observation archive directory");
  }
  fs.chmodSync(directory, 0o700);
}

function writeExclusive(filename, contents) {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readState(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new Error("Invalid observation state file");
  }
  const state = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (state.version !== 1 || !state.entries || typeof state.entries !== "object" ||
      Array.isArray(state.entries) || !Number.isSafeInteger(state.archiveBytes) || state.archiveBytes < 0 ||
      Object.keys(state.entries).length > MAX_ENTRIES ||
      Object.entries(state.entries).some(([key, entry]) => !/^[a-f0-9]{64}$/.test(key) ||
        !entry || (entry.mode !== "full" && entry.mode !== "packed") ||
        (entry.mode === "packed" && (typeof entry.text !== "string" || entry.text.length > 8192)))) {
    throw new Error("Invalid observation state contents");
  }
  return state;
}

function resultText(block) {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content) && block.content.length === 1 &&
      block.content[0]?.type === "text" && typeof block.content[0].text === "string") {
    return block.content[0].text;
  }
  return null;
}

function preview(text, filename, bytes) {
  // Excerpts are not summaries. Exact evidence stays available through native Read.
  let head = text.slice(0, 1024);
  let tail = text.slice(-1024);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `[Gateway archived tool output: ${bytes} UTF-8 bytes; SHA-256 ${hash(text)}]\n` +
    `The following are excerpts, not the complete result. Use Read with file_path=${JSON.stringify(filename)} ` +
    `and offset/limit to retrieve the original text when needed. If unavailable, rerun the original tool; do not guess.\n` +
    `[Beginning]\n${head}\n[Middle omitted; original preserved in the file above]\n${tail}\n[End]`;
}

function collectResults(body) {
  const results = [];
  const calls = new Map();
  for (const [index, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      if (message.role === "assistant" && block?.type === "tool_use") calls.set(block.id, block);
      if (message.role !== "user" || block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const text = resultText(block);
      if (text === null) continue;
      results.push({ index, blockIndex, block, text, call: calls.get(block.tool_use_id),
        key: hash(JSON.stringify([block.tool_use_id, text])) });
    }
  }
  return results;
}

function project(body, results, entries) {
  let packedResults = 0;
  let avoidedBytes = 0;
  const messages = [...body.messages];
  const changed = new Set();
  for (const result of results) {
    const entry = entries[result.key];
    if (entry?.mode !== "packed") continue;
    if (!changed.has(result.index)) {
      messages[result.index] = { ...messages[result.index], content: [...messages[result.index].content] };
      changed.add(result.index);
    }
    const block = result.block;
    messages[result.index].content[result.blockIndex] = {
      ...block, content: typeof block.content === "string" ? entry.text : [{ ...block.content[0], text: entry.text }]
    };
    packedResults++;
    avoidedBytes += Math.max(0, Buffer.byteLength(result.text) - Buffer.byteLength(entry.text));
  }
  return { body: packedResults ? { ...body, messages } : body, packedResults, avoidedBytes };
}

function createObservationPack({ configFile = getFeatureConfigPath(),
  archiveRoot = path.join(os.homedir(), ".claude", "gateway-observations"), onWarning = () => {}, onEvent = () => {} } = {}) {
  const warn = (code) => { try { onWarning({ code }); } catch {} };
  let lastEnabled;
  const status = () => {
    const current = getStatus(configFile);
    if (current.observationPack !== lastEnabled) {
      lastEnabled = current.observationPack;
      try { onEvent({ event: "configuration", enabled: lastEnabled }); } catch {}
    }
    return current;
  };
  return {
    getStatus: status,
    prepare(body, { readOnly = false } = {}) {
      const enabled = status().observationPack;
      // Never infer session identity from system/tools: that could mix independent clients.
      const identity = body.metadata?.session_id || body.metadata?.user_id;
      if (typeof identity !== "string" || !identity || !Array.isArray(body.messages)) {
        return { body, stats: { enabled, packed_results: 0, avoided_bytes: 0 } };
      }
      const directory = path.join(archiveRoot, hash(identity));
      const stateFile = path.join(directory, "state.json");
      const lockFile = path.join(directory, "pending");
      let previous;
      try {
        if ((readOnly || !enabled) && !fs.existsSync(directory)) {
          return { body, stats: { enabled, packed_results: 0, avoided_bytes: 0 } };
        }
        privateDirectory(archiveRoot);
        privateDirectory(directory);
        previous = readState(stateFile);
      } catch {
        // An unreadable existing ledger may hold already-sent projections. Do not rewrite them.
        const error = new Error("Observation archive state is unreadable; restore it or start a new session");
        error.status = 503;
        throw error;
      }
      const results = collectResults(body);
      const baseline = previous || { version: 1, archiveBytes: 0, entries: {} };
      const interrupted = fs.existsSync(lockFile);
      let entries = baseline.entries;
      if (!readOnly && !interrupted) {
        const next = { ...baseline, entries: { ...baseline.entries } };
        let count = Object.keys(next.entries).length;
        const hasRead = body.tools?.some((tool) => tool.name === "Read" && tool.input_schema?.properties?.file_path);
        // Claude Code may append system reminders after the newest tool results.
        const currentTurn = body.messages.findLastIndex((message) => message?.role !== "system");
        const unknown = results.filter((result) => !next.entries[result.key]);
        if (!previous || unknown.length) {
          try {
            // A crash or write failure leaves this marker, freezing new packing for the session.
            writeExclusive(lockFile, "pending\n");
            for (const result of unknown) {
              if (next.entries[result.key]) continue;
              if (count >= MAX_ENTRIES) break;
              const bytes = Buffer.byteLength(result.text);
              const input = result.call?.input || {};
              const recalling = (result.call?.name === "Read" && typeof input.file_path === "string" &&
                path.resolve(input.file_path).startsWith(archiveRoot + path.sep)) ||
                (result.call?.name === "Bash" && typeof input.command === "string" && input.command.includes(archiveRoot));
              const canPack = previous && enabled && hasRead && result.call && !result.block.is_error &&
                result.index === currentTurn && !recalling &&
                bytes >= THRESHOLD_BYTES && bytes <= MAX_RESULT_BYTES &&
                next.archiveBytes + bytes <= MAX_SESSION_ARCHIVE_BYTES;
              let entry = { mode: "full" };
              if (canPack) {
                const filename = path.join(directory, `${hash(result.text)}.txt`);
                if (fs.existsSync(filename)) {
                  const stat = fs.lstatSync(filename);
                  if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(filename).equals(Buffer.from(result.text))) {
                    throw new Error("Archive integrity check failed");
                  }
                } else {
                  writeExclusive(filename, result.text);
                }
                entry = { mode: "packed", text: preview(result.text, filename, bytes) };
                next.archiveBytes += bytes;
              }
              next.entries[result.key] = entry;
              count++;
            }
            const serialized = JSON.stringify(next);
            if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Observation state limit reached");
            const temporary = path.join(directory, `${crypto.randomBytes(12).toString("hex")}.tmp`);
            writeExclusive(temporary, serialized);
            fs.renameSync(temporary, stateFile);
            // The committed ledger is authoritative even if removing the marker fails.
            entries = next.entries;
            fs.unlinkSync(lockFile);
          } catch {
            warn("observation_archive_append_failed");
          }
        }
      }
      if (interrupted) warn("observation_archive_session_frozen");
      const projected = project(body, results, entries);
      return { body: projected.body, stats: { enabled, packed_results: projected.packedResults, avoided_bytes: projected.avoidedBytes } };
    }
  };
}

module.exports = { createObservationPack, getFeatureConfigPath, migrateFeatureConfig, getStatus, THRESHOLD_BYTES };
