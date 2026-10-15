const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const platform of ["mac", "windows"]) {
  test(`${platform} proxy keeps auth before API CORS and performs no startup settings writes`, () => {
    const source = fs.readFileSync(path.resolve(platform, "proxy.js"), "utf8");
    assert.ok(source.indexOf("if (await authRouter(req, res)) return;") < source.indexOf("Access-Control-Allow-Origin"));
    assert.match(source, /credentialStore\.migrate\(/);
    assert.match(source, /getSettingsPaths\(\) \{ return \[getClaudeSettingsPath\(\)\]; \}/);
    assert.match(source, /if \(!isResponsesModel\(model\)\) \{ sendJsonError\(res, 400/);
    assert.match(source, /onCacheUsage/);
    assert.match(source, /createMacosService\(\{ proxyPath: __filename, port: PORT, onHandoff: shutdownProxy \}\)/);
    assert.match(source, /const authRouter = createAuthRouter\(\{[\s\S]*?macosService,/);
    assert.doesNotMatch(source, /macosService\.configure\(/);
    assert.match(source, /projectMemory: projectMemoryInstaller/);
    assert.match(source, /projectMemoryInstaller\.autoEnable\(\)/);
    assert.match(source, /complete: summaryModel\.complete/);
    assert.match(source, /server\.listen\(PORT, "127\.0\.0\.1"/);
  });
}
