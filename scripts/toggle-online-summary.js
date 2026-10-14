const { getStatus, getFeatureConfigPath, setFeatures } = require("../lib/online-summary");

const filename = getFeatureConfigPath();
const action = process.argv[2] || "status";
if (!["on", "off", "status"].includes(action)) {
  console.error("Usage: node scripts/toggle-online-summary.js [on|off|status]");
  process.exitCode = 1;
} else {
  if (action !== "status") setFeatures({ onlineSummary: action === "on" }, filename);
  console.log(`[${new Date().toISOString()}] Online Summary: ${getStatus(filename).onlineSummary ? "ON" : "OFF"} (all models)`);
  console.log("Existing history stays pinned; changes apply to new tool results without restarting the proxy.");
}
