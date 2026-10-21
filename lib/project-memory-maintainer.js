"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { createSetupProbe, pythonEnvironment } = require("./claude-probes");

const MEMORY_DIR = "projectCodeMemory";
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_AFFECTED = 12;
const MAX_NEW_RECORDS = 3;
const MAX_CHANGED_PATHS = 50;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_ITEMS = 16;
const MAX_TEXT = 600;
const MAX_OTHER_IDS = 200;
const MODEL_TIMEOUT_MS = 120000;
const PYTHON_TIMEOUT_MS = 30000;
const MAX_RUNNING = 2;
const MAX_PENDING = 16;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// 由 references/record-format.md 与原技能的保存门槛压缩而来。
const PROMPT = [
  "You maintain projectCodeMemory records for a code repository. A coding model changed or read files and reported what it learned.",
  "You get the affected existing records, the reported knowledge and the current content of every file you may cite, with 1-based line numbers.",
  "Decide which records to save (refresh an existing id or create a new one) and which to delete.",
  "Rules:",
  "- Current source is the only authority. Every fact, flow, invariant and side effect must be directly supported by the listed files as they are now.",
  "  Correct or drop any claim you cannot confirm; never copy old or reported claims unchecked.",
  "- Refresh a record that is still useful by saving it with its existing id. Delete a record that is wrong, obsolete or not useful.",
  "  A stale record you neither refresh nor delete is deleted.",
  "- Create a new record only for stable, reusable, non-obvious knowledge: a flow, ownership boundary, invariant, persistence or event side effect,",
  `  or configuration gate likely to help a future task. Prefer refreshing an overlapping record. At most ${MAX_NEW_RECORDS} new records.`,
  "- Never store line numbers, code dumps, localized trivia, transient failures, guesses, task narration or secrets.",
  "- id: stable topic name matching [a-z0-9][a-z0-9._-]{0,79}; never reuse an id listed as another existing record.",
  "- keywords: user vocabulary plus exact domain terms a future query is likely to contain.",
  "- paths: the smallest set of the listed files that supports every claim, written exactly as listed. Files you must not cite cannot be used.",
  "- symbols: exact identifiers copied verbatim from those files (functions, classes, constants, endpoints, event names).",
  "- summary: one compact routing or ownership sentence. facts: dense, independently useful statements.",
  "- flows: entry-to-effect chains with arrows. invariants: conditions that must stay true. side_effects: persistence, event, network or lifecycle effects.",
  `- At most ${MAX_ITEMS} items per list and ${MAX_TEXT} characters per item.`,
  "Reply with JSON only:",
  '{"save":[{"id":"...","keywords":["..."],"paths":["..."],"symbols":["..."],"summary":"...","facts":["..."],"flows":[],"invariants":[],"side_effects":[]}],"delete":["record-id"]}',
  "Use empty arrays when nothing should change."
].join("\n");

// 导入包内原样的 pcm.py：inventory 只读；apply 在 pcm 自己的锁内删除、保存并重建索引。
// 不创建缓存、不改 .gitignore；pcm 的输出被吞掉，只在最后打印一行 JSON。
const DRIVER = String.raw`
import contextlib, io, json, os, sys, tempfile
from pathlib import Path
scripts, operation, root_text = sys.argv[1:4]
sys.path.insert(0, scripts)
import pcm
pcm.ensure_ignored = lambda root: None
root = pcm.resolve_root(root_text)
memory, index, records = pcm.memory_paths(root)
drafts = memory / "drafts"
lock = memory / ".lock"

def unsafe():
    if memory.is_symlink() or not memory.is_dir():
        return True
    if lock.is_symlink() or (lock.exists() and not lock.is_file()):
        return True
    return any(item.is_symlink() or (item.exists() and not item.is_dir()) for item in (records, drafts))

if unsafe():
    sys.exit(3)
with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    if operation == "inventory":
        items = []
        for path in pcm.record_files(records):
            try:
                record = pcm.load_record(path)
                if path.name != record["id"] + ".json":
                    continue
                valid, _ = pcm.freshness(root, record)
            except pcm.MemoryError:
                continue
            items.append({"id": record["id"], "keywords": record["k"], "paths": record["p"], "symbols": record["s"],
                "summary": record["sum"], "facts": record["f"], "flows": record["flow"], "invariants": record["inv"],
                "side_effects": record["fx"], "valid": valid})
        result = {"records": items}
    else:
        plan = json.loads(sys.stdin.read())
        saved = deleted = failed = 0
        with pcm.memory_lock(root):
            if unsafe():
                sys.exit(3)
            for identifier in plan["delete"]:
                path = records / (identifier + ".json")
                if path.is_file() or path.is_symlink():
                    pcm.prune_record(records, path, identifier)
                    deleted += 1
            drafts.mkdir(exist_ok=True)
            for item in plan["save"]:
                current = all((root / relative).is_file() and pcm.fingerprint(root / relative) == digest for relative, digest in item["fp"].items())
                if not current:
                    failed += 1
                    continue
                descriptor, name = tempfile.mkstemp(prefix=".gateway-", suffix=".json", dir=drafts)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump(item["draft"], handle, ensure_ascii=False)
                try:
                    if pcm._save_record(root, name) == 0:
                        saved += 1
                    else:
                        failed += 1
                except pcm.MemoryError:
                    failed += 1
                finally:
                    Path(name).unlink(missing_ok=True)
            pcm._rebuild_index(root)
        result = {"saved": saved, "deleted": deleted, "failed": failed}
print(json.dumps(result))
`;

const strings = (value, max, length) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, length)).filter(Boolean))].slice(0, max) : [];

// 主模型传来的参数只做形状整理；路径在拿到真实根目录后再规范化。
function normalizeInput(input) {
  if (!input || typeof input !== "object" || typeof input.root !== "string" || !path.isAbsolute(input.root)) return null;
  const learned = (Array.isArray(input.learned) ? input.learned : []).filter((item) => item && typeof item === "object").slice(0, MAX_NEW_RECORDS)
    .map((item) => ({ topic: typeof item.topic === "string" ? item.topic.trim().slice(0, 200) : "",
      facts: strings(item.facts, MAX_ITEMS, MAX_TEXT), paths: strings(item.paths, MAX_ITEMS, 300), symbols: strings(item.symbols, MAX_ITEMS, 200) }));
  return { root: input.root, changedPaths: strings(input.changed_paths, MAX_CHANGED_PATHS, 300), learned,
    obsolete: strings(input.obsolete, MAX_AFFECTED, 80).filter((id) => ID.test(id)) };
}

// 返回仓库内的 POSIX 相对路径；绝对路径按主模型给的根或真实根换算，越界或指向缓存本身的返回 null。
function relativePath(value, roots) {
  if (value.includes("\0")) return null;
  for (const root of roots) {
    const candidate = path.isAbsolute(value) ? path.relative(root, value) : value;
    const normalized = path.posix.normalize(candidate.split(path.sep).join("/")).replace(/^\.\//, "");
    if (normalized && normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && !path.isAbsolute(normalized) &&
      !path.posix.isAbsolute(normalized) && normalized !== MEMORY_DIR && !normalized.startsWith(MEMORY_DIR + "/")) return normalized;
  }
  return null;
}

// 只维护已有的缓存：根目录与 projectCodeMemory/ 必须是当前用户拥有的真实目录（缓存不能是符号链接）。
function gateRoot(root) {
  const owned = (stat) => !process.getuid || stat.uid === process.getuid();
  const real = fs.realpathSync(root);
  const stat = fs.statSync(real);
  const memory = fs.lstatSync(path.join(real, MEMORY_DIR));
  return stat.isDirectory() && owned(stat) && memory.isDirectory() && owned(memory) ? real : null;
}

// 证据文件必须是根目录内未经符号链接改道的普通文本文件；单个 96 KB（放得下约 73 KB 的 proxy.js）、合计 256 KB。
function readEvidence(real, relatives) {
  const files = new Map();
  const omitted = new Map();
  let total = 0;
  for (const relative of relatives) {
    if (files.has(relative) || omitted.has(relative)) continue;
    const full = path.join(real, ...relative.split("/"));
    let bytes;
    try {
      if (fs.realpathSync(full) !== full) { omitted.set(relative, "redirected"); continue; }
      const stat = fs.statSync(full);
      if (!stat.isFile()) { omitted.set(relative, "not a regular file"); continue; }
      if (stat.size > MAX_FILE_BYTES) { omitted.set(relative, "too large"); continue; }
      if (total + stat.size > MAX_EVIDENCE_BYTES) { omitted.set(relative, "over the evidence budget"); continue; }
      bytes = fs.readFileSync(full);
    } catch (_) { omitted.set(relative, "missing"); continue; }
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) { omitted.set(relative, "binary or changed"); continue; }
    total += bytes.length;
    files.set(relative, { text: bytes.toString("utf8"), sha256: hash(bytes) });
  }
  return { files, omitted };
}

function modelInput({ project, changed, learned, affected, others, evidence, obsolete }) {
  const record = ({ valid, ...fields }) => JSON.stringify({ status: valid ? "current" : "stale", reported_obsolete: obsolete.includes(fields.id), ...fields });
  return [
    `Repository: ${project}`,
    `Changed paths: ${changed.join(", ") || "(none reported)"}`,
    `Knowledge reported by the coding model (unverified; keep only what the files confirm):\n${JSON.stringify(learned)}`,
    `Affected records:\n${affected.map(record).join("\n") || "(none)"}`,
    `Other existing record ids (never reuse): ${others.join(", ") || "(none)"}`,
    ...(evidence.omitted.size ? [`Files you must not cite: ${[...evidence.omitted].map(([file, reason]) => `${file} (${reason})`).join(", ")}`] : []),
    "Files you may cite (current content, 1-based line numbers):",
    ...[...evidence.files].map(([file, { text }]) => `=== ${file} ===\n${text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n")}`)
  ].join("\n\n");
}

function parseOutput(text) {
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    (parsed.save !== undefined && !Array.isArray(parsed.save)) || (parsed.delete !== undefined && !Array.isArray(parsed.delete))) throw new Error("Invalid output");
  return { save: parsed.save || [], delete: parsed.delete || [] };
}

// 草稿按 record-format 校验：路径只能是提供过内容的证据文件，每个符号必须逐字出现在它自己的某个路径里。
function validDraft(draft, files) {
  if (!draft || typeof draft !== "object" || typeof draft.id !== "string" || !ID.test(draft.id) ||
    typeof draft.summary !== "string" || !draft.summary.trim() || draft.summary.length > MAX_TEXT) return null;
  const list = (value, required) => {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > MAX_TEXT)) return null;
    const items = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    return (required && !items.length) || items.length > MAX_ITEMS ? null : items;
  };
  const fields = { keywords: list(draft.keywords, true), paths: list(draft.paths, true), symbols: list(draft.symbols),
    facts: list(draft.facts, true), flows: list(draft.flows), invariants: list(draft.invariants), side_effects: list(draft.side_effects) };
  if (Object.values(fields).includes(null) || !fields.paths.every((file) => files.has(file)) ||
    !fields.symbols.every((symbol) => fields.paths.some((file) => files.get(file).text.includes(symbol)))) return null;
  return { id: draft.id, ...fields, summary: draft.summary.trim() };
}

// 后台维护：按真实根目录串行，全局最多同时 2 个、排队 16 个；任何失败只记录固定错误码，不写任何东西。
function createProjectMemoryMaintainer({ complete, env = process.env, platform = process.platform,
  bundleRoot = path.join(__dirname, "..", "project-code-memory"), execFileImpl = execFile,
  findPython = async () => (await createSetupProbe({ env, platform, includePython: true })()).python,
  onEvent = () => {}, onWarning = () => {}, now = () => new Date() }) {
  const scripts = path.join(bundleRoot, "scripts");
  const chains = new Map();
  const waiters = [];
  let running = 0;
  let pending = 0;
  let python = null;
  const warn = (code, project) => { try { onWarning({ code, ...(project ? { project } : {}) }); } catch (_) {} };

  function runDriver(operation, root, input) {
    return new Promise((resolve, reject) => {
      const failed = (code) => reject(Object.assign(new Error("Project memory driver failed"), { code }));
      const child = execFileImpl(python.file, [...(python.launcher ? ["-3"] : []), "-I", "-B", "-c", DRIVER, scripts, operation, root],
        { shell: false, windowsHide: true, timeout: PYTHON_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, cwd: scripts, env: pythonEnvironment(env, platform) },
        (error, stdout) => {
          if (error) return failed(error.code === 3 ? "root_rejected" : "python_failed");
          try { resolve(JSON.parse(stdout)); } catch (_) { failed("python_failed"); }
        });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ? JSON.stringify(input) : "");
    });
  }

  async function run(job, key) {
    const started = Date.now();
    const project = path.basename(key);
    let real = null;
    try { real = gateRoot(job.root); } catch (_) { /* 缺少缓存或无法访问。 */ }
    if (real !== key) return warn("root_rejected", project), null;
    try { python ||= await findPython(); } catch (_) { /* 下次再找。 */ }
    if (!python) return warn("python_failed", project), null;
    const roots = [job.root, real];
    const changed = job.changedPaths.map((file) => relativePath(file, roots)).filter(Boolean);
    const learned = job.learned.map((item) => ({ ...item, paths: item.paths.map((file) => relativePath(file, roots)).filter(Boolean) }));
    try {
      const records = ((await runDriver("inventory", real)).records || []).filter((record) => typeof record?.id === "string" && Array.isArray(record.paths));
      // 受影响：主模型指出的过时记录、引用了改动文件或新知识所引文件的记录、指纹已失效的记录。
      const cited = new Set([...changed, ...learned.flatMap((item) => item.paths)]);
      const rank = (record) => job.obsolete.includes(record.id) ? 0 : record.paths.some((file) => cited.has(file)) ? 1 : record.valid ? 3 : 2;
      const affected = records.filter((record) => rank(record) < 3).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, MAX_AFFECTED);
      const affectedIds = new Set(affected.map((record) => record.id));
      const existingIds = new Set(records.map((record) => record.id));
      let model = "none";
      let output = { save: [], delete: [] };
      const evidence = affected.length || learned.length
        ? readEvidence(real, [...affected.flatMap((record) => record.paths), ...learned.flatMap((item) => item.paths), ...changed])
        : { files: new Map(), omitted: new Map() };
      // 没有可引用的文件时不调用模型，只删除失效记录。
      if (evidence.files.size) {
        const reply = await complete({ system: PROMPT, maxTokens: 8192, timeoutMs: MODEL_TIMEOUT_MS,
          input: modelInput({ project, changed, learned, affected, evidence, obsolete: job.obsolete,
            others: [...existingIds].filter((id) => !affectedIds.has(id)).slice(0, MAX_OTHER_IDS) }) }).catch(() => null);
        if (!reply) return warn("model_failed", project), null;
        try { output = parseOutput(reply.text); } catch (_) { return warn("invalid_output", project), null; }
        model = reply.model;
      }
      const saves = [];
      const savedIds = new Set();
      let rejected = 0;
      let created = 0;
      for (const draft of output.save) {
        const valid = validDraft(draft, evidence.files);
        const isNew = valid && !affectedIds.has(valid.id);
        if (!valid || savedIds.has(valid.id) || (isNew && (existingIds.has(valid.id) || created >= MAX_NEW_RECORDS))) { rejected++; continue; }
        if (isNew) created++;
        savedIds.add(valid.id);
        // 来源由代理写入，模型不能声称跑过测试。
        saves.push({ draft: { ...valid, verification: [`Gateway-maintained by ${model} from current source on ${now().toISOString().slice(0, 10)}; not test-verified.`] },
          fp: Object.fromEntries(valid.paths.map((file) => [file, evidence.files.get(file).sha256])) });
      }
      // 模型尝试刷新、但草稿被拒或保存失败的记录保留原样，等下次维护再刷新。
      const attempted = new Set(output.save.map((draft) => draft?.id).filter((id) => typeof id === "string"));
      const deletes = new Set(output.delete.filter((id) => typeof id === "string" && affectedIds.has(id) && !attempted.has(id)));
      for (const record of affected) if (!record.valid && !attempted.has(record.id)) deletes.add(record.id);
      let applied = { saved: 0, deleted: 0, failed: 0 };
      if (saves.length || deletes.size) applied = await runDriver("apply", real, { save: saves, delete: [...deletes] });
      const result = { project, model, saved: applied.saved, deleted: applied.deleted, rejected: rejected + applied.failed, ms: Date.now() - started };
      try { onEvent(result); } catch (_) {}
      return result;
    } catch (error) {
      return warn(["root_rejected", "python_failed"].includes(error.code) ? error.code : "python_failed", project), null;
    }
  }

  function withSlot(work) {
    const start = running < MAX_RUNNING ? (running++, Promise.resolve()) : new Promise((resolve) => waiters.push(resolve));
    // 完成时把名额直接交给下一个等待者，避免短暂超出上限。
    return start.then(work).finally(() => { const next = waiters.shift(); if (next) next(); else running--; });
  }

  // accepted 同步报告是否入队；Promise 仍用于等待维护完成，代理不等待它，也不会被它拒绝。
  function enqueue(input) {
    const job = normalizeInput(input);
    let key = null;
    try { key = job && fs.realpathSync(job.root); } catch (_) { /* 根目录不存在。 */ }
    if (!key) return warn("root_rejected"), Object.assign(Promise.resolve(null), { accepted: false });
    if (pending >= MAX_PENDING) return warn("queue_full", path.basename(key)), Object.assign(Promise.resolve(null), { accepted: false });
    pending++;
    const tail = (chains.get(key) || Promise.resolve()).then(() => withSlot(() => run(job, key))).catch(() => null)
      .finally(() => { pending--; if (chains.get(key) === tail) chains.delete(key); });
    chains.set(key, tail);
    return Object.assign(tail, { accepted: true });
  }

  return { enqueue };
}

module.exports = { createProjectMemoryMaintainer, PROMPT };
