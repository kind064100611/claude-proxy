const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getStatus, getFeatureConfigPath } = require("../lib/observation-pack");

const filename = getFeatureConfigPath();
const action = process.argv[2] || "status";
if (!["on", "off", "status"].includes(action)) {
  console.error("Usage: node scripts/toggle-observation-pack.js [on|off|status]");
  process.exitCode = 1;
} else {
  if (action !== "status") {
    const directory = path.dirname(filename);
    let parent;
    try { parent = fs.lstatSync(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!parent) fs.mkdirSync(directory, { mode: 0o700 });
    else if (!parent.isDirectory() || parent.isSymbolicLink() || process.getuid && parent.uid !== process.getuid()) {
      throw new Error("Unsafe feature configuration directory");
    }
    let previous;
    try { previous = fs.lstatSync(filename); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous && (!previous.isFile() || previous.isSymbolicLink() || process.getuid && previous.uid !== process.getuid())) {
      throw new Error("Unsafe feature configuration file");
    }
    const temporary = `${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, observationPack: action === "on" }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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
  console.log(`[${new Date().toISOString()}] Observation Pack: ${getStatus(filename).observationPack ? "ON" : "OFF"} (all models)`);
  console.log("Existing history stays pinned; changes apply to new results without restarting the proxy.");
}
