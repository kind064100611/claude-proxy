const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const THRESHOLD_BYTES = 16 * 1024;
const THRESHOLD_OPTIONS = [4 * 1024, 8 * 1024, 16 * 1024, 32 * 1024];
const MAX_PROJECTION_RATIO = 0.7;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_SESSION_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PROJECTION_CHARS = 12000;
const MIN_PROJECTION_CHARS = 2000;
const MAX_LEDGER_TEXT_CHARS = 16384;
const MAX_EXCERPT_LINE_CHARS = 300;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const MAX_PROMPT_BYTES = 8 * 1024;
const RETENTION_DAYS = 30;
// 0 表示从不自动删除归档。
const RETENTION_OPTIONS = [7, 14, 30, 60, 90, 0];
const DAY_MS = 24 * 60 * 60 * 1000;
// 清理时只删除本模块写入的文件名，遇到其他文件则保留整个会话目录。
const ARCHIVE_FILE = /^(?:state\.json|pending|[a-f0-9]{64}\.txt|[a-f0-9]{24}\.tmp)$/;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
// 按 JSON 编码后的字节计算上限，保证提示词总能放进 16 KiB 的设置请求体。
const validPrompt = (value) => typeof value === "string" && value.trim() !== "" && Buffer.byteLength(JSON.stringify(value)) <= MAX_PROMPT_BYTES;

function getFeatureConfigPath(home = os.homedir()) {
  return path.join(home, ".claude", "gateway-features.json");
}

// 缺失配置默认开启；损坏或不安全的配置关闭新的总结。summaryModel 为用户选择的总结模型，缺省为自动探测；summaryPrompt 缺省或无效时用内置提示词。
// archiveRetentionDays 缺省为 30 天；值无效或配置损坏、不安全时不删除任何归档。
function getStatus(configFile = getFeatureConfigPath()) {
  let fd;
  const disabled = { onlineSummary: false, summaryModel: null, summaryThreshold: THRESHOLD_BYTES, summaryPrompt: null, archiveRetentionDays: 0 };
  try {
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return disabled;
    fd = fs.openSync(configFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 64 * 1024) return disabled;
    const config = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (config?.version !== 1) return disabled;
    return { onlineSummary: (config.onlineSummary ?? true) === true,
      summaryModel: typeof config.summaryModel === "string" && MODEL_ID.test(config.summaryModel) ? config.summaryModel : null,
      summaryThreshold: THRESHOLD_OPTIONS.includes(config.summaryThreshold) ? config.summaryThreshold : THRESHOLD_BYTES,
      summaryPrompt: validPrompt(config.summaryPrompt) ? config.summaryPrompt : null,
      archiveRetentionDays: config.archiveRetentionDays === undefined ? RETENTION_DAYS
        : RETENTION_OPTIONS.includes(config.archiveRetentionDays) ? config.archiveRetentionDays : 0 };
  } catch (error) {
    return { onlineSummary: error.code === "ENOENT", summaryModel: null, summaryThreshold: THRESHOLD_BYTES, summaryPrompt: null,
      archiveRetentionDays: error.code === "ENOENT" ? RETENTION_DAYS : 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 只改传入的 onlineSummary/summaryModel/summaryPrompt（null 表示恢复自动探测或默认提示词），保留其他字段；拒绝符号链接与他人拥有的路径。
function setFeatures(patch, filename = getFeatureConfigPath()) {
  if (patch.onlineSummary !== undefined && typeof patch.onlineSummary !== "boolean") throw new Error("Invalid onlineSummary");
  if (patch.summaryModel !== undefined && patch.summaryModel !== null && !MODEL_ID.test(String(patch.summaryModel))) throw new Error("Invalid summaryModel");
  if (patch.summaryThreshold !== undefined && !THRESHOLD_OPTIONS.includes(patch.summaryThreshold)) throw new Error("Invalid summaryThreshold");
  if (patch.summaryPrompt !== undefined && patch.summaryPrompt !== null && !validPrompt(patch.summaryPrompt)) throw new Error("Invalid summaryPrompt");
  if (patch.archiveRetentionDays !== undefined && !RETENTION_OPTIONS.includes(patch.archiveRetentionDays)) throw new Error("Invalid archiveRetentionDays");
  const directory = path.dirname(filename);
  const owned = (stat) => !process.getuid || stat.uid === process.getuid();
  let parent;
  try { parent = fs.lstatSync(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!parent) fs.mkdirSync(directory, { mode: 0o700 });
  else if (!parent.isDirectory() || parent.isSymbolicLink() || !owned(parent)) throw new Error("Unsafe feature configuration directory");
  let previous;
  try { previous = fs.lstatSync(filename); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || !owned(previous))) throw new Error("Unsafe feature configuration file");
  let config = {};
  if (previous) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.version === 1) config = parsed;
    } catch (_) { /* 损坏的配置整体替换为有效配置。 */ }
  }
  const temporary = `${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    const next = { ...config, version: 1 };
    if (patch.onlineSummary !== undefined) next.onlineSummary = patch.onlineSummary;
    if (patch.summaryModel === null) delete next.summaryModel;
    else if (patch.summaryModel !== undefined) next.summaryModel = patch.summaryModel;
    if (patch.summaryThreshold !== undefined) next.summaryThreshold = patch.summaryThreshold;
    if (patch.summaryPrompt === null) delete next.summaryPrompt;
    else if (patch.summaryPrompt !== undefined) next.summaryPrompt = patch.summaryPrompt;
    if (patch.archiveRetentionDays !== undefined) next.archiveRetentionDays = patch.archiveRetentionDays;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (previous) {
      const current = fs.lstatSync(filename);
      if (current.ino !== previous.ino || current.dev !== previous.dev || current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        throw new Error("Feature configuration changed; retry the command");
      }
      fs.renameSync(temporary, filename);
    } else fs.linkSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
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
        (entry.mode === "packed" && (typeof entry.text !== "string" || entry.text.length > MAX_LEDGER_TEXT_CHARS)))) {
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

// 总结由便宜模型生成；摘录由代理按行号从原文逐字引用，行号与 Read 一致。
// 额度为原文一半（2000-12000 字符）；放不下的摘录列出行号，主模型可直接定位而不必搜索。
function render(text, filename, bytes, summary) {
  const lines = text.split("\n");
  const budget = Math.min(MAX_PROJECTION_CHARS, Math.max(MIN_PROJECTION_CHARS, Math.floor(text.length / 2)));
  let output = `[Gateway online summary of tool output by ${summary.model}: ${lines.length} lines, ${bytes} UTF-8 bytes; SHA-256 ${hash(text)}]\n` +
    `The summary is machine-generated; the excerpts below are verbatim with original line numbers. The complete original is at ` +
    `file_path=${JSON.stringify(filename)}; use Read with offset/limit around these lines when you need more. Do not guess.\n` +
    `[Summary]\n${summary.summary}\n`;
  const shown = new Set();
  const omitted = [];
  for (const item of summary.highlights) {
    const numbers = [];
    for (let number = item.start; number <= Math.min(item.end, lines.length); number++) if (!shown.has(number)) numbers.push(number);
    if (!numbers.length) continue;
    const label = `${numbers[0]}-${numbers.at(-1)}${item.reason ? `: ${item.reason}` : ""}`;
    const excerpt = numbers.map((number) => {
      const line = lines[number - 1];
      return `${number}: ${line.length > MAX_EXCERPT_LINE_CHARS ? Array.from(line).slice(0, MAX_EXCERPT_LINE_CHARS).join("") + "…" : line}`;
    });
    const block = `[Lines ${label}]\n${excerpt.join("\n")}\n`;
    if (output.length + block.length > budget) { omitted.push(label); continue; }
    for (const number of numbers) shown.add(number);
    output += block;
  }
  if (omitted.length) {
    let note = "[More key lines not shown; Read these line ranges if needed]\n";
    for (const label of omitted) {
      const entry = `${label}\n`;
      if (output.length + note.length + entry.length > MAX_LEDGER_TEXT_CHARS - 16) break;
      note += entry;
    }
    output += note;
  }
  return output + "[End]";
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

function createOnlineSummary({ configFile = getFeatureConfigPath(),
  archiveRoot = path.join(os.homedir(), ".claude", "gateway-observations"), summarize = async () => null,
  onWarning = () => {}, onEvent = () => {} } = {}) {
  const warn = (code) => { try { onWarning({ code }); } catch {} };
  let lastConfiguration;
  const status = () => {
    const current = getStatus(configFile);
    const configuration = `${current.onlineSummary}|${current.summaryModel}|${current.summaryThreshold}|${current.summaryPrompt}|${current.archiveRetentionDays}`;
    if (configuration !== lastConfiguration) {
      lastConfiguration = configuration;
      try { onEvent({ event: "configuration", enabled: current.onlineSummary, summary_model: current.summaryModel || "auto", summary_threshold: current.summaryThreshold,
        summary_prompt: current.summaryPrompt ? "custom" : "default", archive_retention_days: current.archiveRetentionDays }); } catch {}
    }
    return current;
  };
  return {
    getStatus: status,
    // 删除超过保留天数未使用的会话归档并返回删除的会话数。只处理本模块命名的目录和文件，不递归删除、不跟随符号链接、不碰他人拥有的路径。
    cleanup(now = Date.now()) {
      const days = status().archiveRetentionDays;
      if (!days) return 0;
      const owned = (stat) => !process.getuid || stat.uid === process.getuid();
      let entries;
      try {
        const root = fs.lstatSync(archiveRoot);
        // 他人可写的根目录里，会话目录可能在检查后被换成符号链接。
        if (!root.isDirectory() || root.isSymbolicLink() || !owned(root) || (process.getuid && (root.mode & 0o022))) return 0;
        entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
      } catch { return 0; }
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const directory = path.join(archiveRoot, entry.name);
        try {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory() || !owned(stat)) continue;
          let updated = stat.mtimeMs;
          try { updated = Math.max(updated, fs.lstatSync(path.join(directory, "state.json")).mtimeMs); } catch {}
          if (now - updated <= days * DAY_MS) continue;
          const files = fs.readdirSync(directory, { withFileTypes: true });
          if (files.some((file) => !file.isFile() || !ARCHIVE_FILE.test(file.name))) { warn("observation_archive_cleanup_skipped"); continue; }
          // 先删 ledger：中途失败也不会留下指向已删原文的摘要。
          const names = files.map((file) => file.name).sort((a, b) => (b === "state.json") - (a === "state.json"));
          for (const name of names) fs.unlinkSync(path.join(directory, name));
          fs.rmdirSync(directory);
          removed++;
        } catch {
          warn("observation_archive_cleanup_failed");
        }
      }
      return removed;
    },
    async prepare(body, { readOnly = false } = {}) {
      const { onlineSummary: enabled, summaryThreshold: threshold } = status();
      const passthrough = { body, stats: { enabled, packed_results: 0, avoided_bytes: 0, summarized_results: 0, recalled_results: 0 } };
      // Never infer session identity from system/tools: that could mix independent clients.
      const identity = body.metadata?.session_id || body.metadata?.user_id;
      if (typeof identity !== "string" || !identity || !Array.isArray(body.messages)) return passthrough;
      const directory = path.join(archiveRoot, hash(identity));
      const stateFile = path.join(directory, "state.json");
      const lockFile = path.join(directory, "pending");
      const load = () => {
        try {
          if ((readOnly || !enabled) && !fs.existsSync(directory)) return null;
          privateDirectory(archiveRoot);
          privateDirectory(directory);
          // 归档保留期按最后一次使用计算，正在使用的会话不会被清理。
          if (!readOnly) { try { const now = new Date(); fs.utimesSync(directory, now, now); } catch {} }
          return readState(stateFile);
        } catch {
          // An unreadable existing ledger may hold already-sent projections. Do not rewrite them.
          const error = new Error("Observation archive state is unreadable; restore it or start a new session");
          error.status = 503;
          throw error;
        }
      };
      let previous = load();
      if (previous === null && (readOnly || !enabled) && !fs.existsSync(directory)) return passthrough;
      const results = collectResults(body);
      const hasRead = body.tools?.some((tool) => tool.name === "Read" && tool.input_schema?.properties?.file_path);
      // Claude Code may append system reminders after the newest tool results.
      const currentTurn = body.messages.findLastIndex((message) => message?.role !== "system");
      const isRecall = (result) => {
        const input = result.call?.input || {};
        return (result.call?.name === "Read" && typeof input.file_path === "string" &&
          path.resolve(input.file_path).startsWith(archiveRoot + path.sep)) ||
          (result.call?.name === "Bash" && typeof input.command === "string" && input.command.includes(archiveRoot));
      };
      // Read output stays verbatim: edits need exact file text.
      const isCandidate = (result, ledger) => {
        const bytes = Buffer.byteLength(result.text);
        return Boolean(ledger) && enabled && hasRead && result.call && result.call.name !== "Read" && !result.block.is_error &&
          result.index === currentTurn && !isRecall(result) && bytes >= threshold && bytes <= MAX_RESULT_BYTES;
      };

      // Phase 1: summarize new candidates without holding the session marker; nothing is written.
      const summaries = new Map();
      if (!readOnly && previous && !fs.existsSync(lockFile)) {
        const pending = results.filter((result) => !previous.entries[result.key] && isCandidate(result, previous));
        await Promise.all(pending.map(async (result) => {
          try {
            const summary = await summarize(result.text, result.call);
            if (summary) summaries.set(result.key, summary);
          } catch (_) { /* A failed summary keeps the original output. */ }
        }));
        // Another request may have committed while summaries were generated.
        if (pending.length) previous = load();
      }

      // Phase 2: synchronous decision and commit; existing entries never change.
      const baseline = previous || { version: 1, archiveBytes: 0, entries: {} };
      const interrupted = fs.existsSync(lockFile);
      let entries = baseline.entries;
      let summarized = 0;
      let recalled = 0;
      const usedModels = new Set();
      if (!readOnly && !interrupted) {
        const next = { ...baseline, entries: { ...baseline.entries } };
        let count = Object.keys(next.entries).length;
        const unknown = results.filter((result) => !next.entries[result.key]);
        if (!previous || unknown.length) {
          try {
            // A crash or write failure leaves this marker, freezing new summaries for the session.
            writeExclusive(lockFile, "pending\n");
            for (const result of unknown) {
              if (next.entries[result.key]) continue;
              if (count >= MAX_ENTRIES) break;
              const bytes = Buffer.byteLength(result.text);
              if (isRecall(result)) recalled++;
              const summary = isCandidate(result, previous) && next.archiveBytes + bytes <= MAX_SESSION_ARCHIVE_BYTES &&
                summaries.get(result.key);
              let entry = { mode: "full" };
              const filename = path.join(directory, `${hash(result.text)}.txt`);
              const text = summary && render(result.text, filename, bytes, summary);
              // 压缩不到原文 70% 以下时不值得替换，保留原文。
              if (text && text.length <= result.text.length * MAX_PROJECTION_RATIO) {
                if (fs.existsSync(filename)) {
                  const stat = fs.lstatSync(filename);
                  if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(filename).equals(Buffer.from(result.text))) {
                    throw new Error("Archive integrity check failed");
                  }
                } else {
                  writeExclusive(filename, result.text);
                }
                entry = { mode: "packed", text };
                next.archiveBytes += bytes;
                summarized++;
                usedModels.add(summary.model);
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
      return { body: projected.body, stats: { enabled, packed_results: projected.packedResults, avoided_bytes: projected.avoidedBytes,
        summarized_results: summarized, recalled_results: recalled, ...(usedModels.size ? { summary_models: [...usedModels].join(",") } : {}) } };
    }
  };
}

// 本机设置页使用：开关、总结模型、提示词与归档保留天数保存在同一配置文件，代理每个请求重新读取，无需重启。
function createSummarySettings({ configFile = getFeatureConfigPath(), getDefaultModel, listModels, defaultPrompt = "" }) {
  async function getSettings() {
    const current = getStatus(configFile);
    const [defaultModel, models] = await Promise.all([getDefaultModel(), listModels()]);
    return { enabled: current.onlineSummary, model: current.summaryModel, defaultModel, models,
      threshold: current.summaryThreshold, thresholds: THRESHOLD_OPTIONS,
      prompt: current.summaryPrompt || defaultPrompt, customPrompt: current.summaryPrompt !== null,
      retentionDays: current.archiveRetentionDays, retentionOptions: RETENTION_OPTIONS };
  }
  async function configure(patch) {
    if (patch.summaryThreshold !== undefined && !THRESHOLD_OPTIONS.includes(patch.summaryThreshold)) {
      throw Object.assign(new Error("Invalid summary threshold"), { status: 400, code: "INVALID_SUMMARY_THRESHOLD" });
    }
    if (patch.archiveRetentionDays !== undefined && !RETENTION_OPTIONS.includes(patch.archiveRetentionDays)) {
      throw Object.assign(new Error("Invalid archive retention"), { status: 400, code: "INVALID_RETENTION_DAYS" });
    }
    if (typeof patch.summaryModel === "string" && !(await listModels()).includes(patch.summaryModel)) {
      throw Object.assign(new Error("Unknown summary model"), { status: 400, code: "UNKNOWN_SUMMARY_MODEL" });
    }
    if (typeof patch.summaryPrompt === "string") {
      if (!validPrompt(patch.summaryPrompt)) throw Object.assign(new Error("Invalid summary prompt"), { status: 400, code: "INVALID_SUMMARY_PROMPT" });
      // 与默认提示词相同时不固定保存，以后内置提示词更新仍会生效。
      if (patch.summaryPrompt.trim() === defaultPrompt.trim()) patch = { ...patch, summaryPrompt: null };
    }
    setFeatures(patch, configFile);
    return getSettings();
  }
  return { getStatus: getSettings, configure };
}

module.exports = { createOnlineSummary, createSummarySettings, getFeatureConfigPath, getStatus, setFeatures, render, THRESHOLD_BYTES, THRESHOLD_OPTIONS };
