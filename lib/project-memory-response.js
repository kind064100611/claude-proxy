"use strict";

const { Transform } = require("stream");

// 原生 Claude 响应的出口适配；普通帧保持原样，只有虚拟工具替换为文本。
function createProjectMemoryResponseTransform(handler, isStream) {
  const decoder = new TextDecoder();
  const originals = new WeakMap();
  const limit = 32 * 1024 * 1024;
  let buffer = "";
  const encode = (event) => originals.get(event) || `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new Transform({
    transform(chunk, _, callback) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        if (isStream) {
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const raw = buffer.slice(0, match.index + match[0].length);
            buffer = buffer.slice(raw.length);
            const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart()).join("\n");
            let value;
            try { value = JSON.parse(data); } catch (_) { this.push(raw); continue; }
            if (!value || typeof value !== "object" || Array.isArray(value)) { this.push(raw); continue; }
            originals.set(value, raw);
            for (const event of handler.event(value)) this.push(encode(event));
          }
        }
        if (buffer.length > limit) throw new Error("Project memory response exceeds the buffer limit");
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        buffer += decoder.decode();
        if (isStream) {
          for (const event of handler.finish()) this.push(encode(event));
          // 未完成的数据帧不能泄露虚拟工具，也不能触发后台任务。
          if (buffer.trim() && !buffer.trimStart().startsWith(":")) throw new Error("Incomplete project memory response frame");
          if (buffer) this.push(buffer);
        } else {
          let value;
          try { value = JSON.parse(buffer); } catch (_) { this.push(buffer); callback(); return; }
          const result = handler.message(value);
          this.push(result === value ? buffer : JSON.stringify(result));
        }
        callback();
      } catch (error) { callback(error); }
    }
  });
}

module.exports = { createProjectMemoryResponseTransform };
