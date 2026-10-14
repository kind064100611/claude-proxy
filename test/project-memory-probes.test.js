const test = require("node:test");
const assert = require("node:assert/strict");
const { createSetupProbe } = require("../lib/claude-probes");

function fixture({ platform = "darwin", output = { implementation: "cpython", version: [3, 9, 0] }, launcher = false, error = null, includePython = true } = {}) {
  const calls = [];
  const windows = platform === "win32";
  const probe = createSetupProbe({ platform, includePython, home: windows ? "C:\\Users\\test" : "/test-home",
    env: { PATH: windows ? "C:\\bin;relative" : "/bin:relative", PYTHONPATH: "private", PYTHONHOME: "private", PYTHONSTARTUP: "private",
      PYTHONINSPECT: "1", _PYTHON_SYSCONFIGDATA_NAME: "private", LD_PRELOAD: "private", DYLD_INSERT_LIBRARIES: "private",
      VIRTUAL_ENV: "private", BASH_ENV: "private", NODE_OPTIONS: "private", PYLAUNCHER_ALLOW_INSTALL: "1",
      PYLAUNCHER_ALWAYS_INSTALL: "1", PYLAUNCHER_DRYRUN: "private", PY_PYTHON: "private", PYTHON_MANAGER_AUTOMATIC_INSTALL: "true" }, node: windows ? "C:\\node.exe" : "/node",
    fsImpl: { statSync(file) { return { isFile: () => /claude(?:\.exe)?$/.test(file) || (launcher ? /py\.exe$/.test(file) : /python3(?:\.exe)?$/.test(file)) }; } },
    execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      if (args.includes("-c")) done(error, typeof output === "string" ? output : JSON.stringify(output));
      else done(null, file.includes("claude") ? "2.1.299 (Claude Code)" : "v22.0.0");
    } });
  return { probe, calls };
}

test("optional Python probe uses isolated fixed shell-free CPython/std-library check", async () => {
  const f = fixture();
  const result = await f.probe();
  assert.equal(result.cli, true);
  assert.equal(result.python.file, "/bin/python3");
  const python = f.calls.filter((call) => call.args.includes("-c"));
  assert.ok(python.length > 0);
  for (const call of python) {
    assert.deepEqual(call.args.slice(0, 3), ["-I", "-B", "-c"]);
    assert.ok(call.args[3].includes("contextlib,typing"));
    assert.ok(!call.args[3].includes("pcm.py"));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 1800);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.cwd, "/test-home");
    assert.ok(!JSON.stringify(call.options.env).includes("private"));
    assert.ok(call.file.startsWith("/"));
  }
  const defaultProbe = fixture({ includePython: false });
  assert.equal(Object.hasOwn(await defaultProbe.probe(), "python"), false);
  assert.equal(defaultProbe.calls.some((call) => call.args.includes("-c")), false);
});

test("old versions, non-CPython, malformed output and timeout errors produce no subprocess output", async () => {
  for (const options of [
    { output: { implementation: "cpython", version: [3, 8, 20] } },
    { output: { implementation: "pypy", version: [3, 10, 1] } },
    { output: "private malformed output" },
    { output: { implementation: "cpython", version: ["3", 12, 0] } },
    { output: "private output", error: Object.assign(new Error("private timeout"), { killed: true }) }
  ]) {
    const result = await fixture(options).probe();
    assert.equal(result.python, null);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
  assert.ok((await fixture({ output: { implementation: "cpython", version: [3, 13, 1] } }).probe()).python);
});

test("Windows launcher uses absolute py.exe and fixed -3 -I -B, never .cmd wrappers", async () => {
  const f = fixture({ platform: "win32", launcher: true });
  const result = await f.probe();
  assert.equal(result.python.launcher, true);
  assert.equal(result.python.file, "C:\\bin\\py.exe");
  for (const call of f.calls.filter((item) => item.args.includes("-c"))) {
    assert.deepEqual(call.args.slice(0, 4), ["-3", "-I", "-B", "-c"]);
    assert.ok(/^[A-Z]:\\/.test(call.file));
    assert.equal(call.options.shell, false);
    assert.ok(!call.file.endsWith(".cmd"));
    assert.equal(call.options.env.PYLAUNCHER_ALLOW_INSTALL, undefined);
    assert.equal(call.options.env.PYLAUNCHER_ALWAYS_INSTALL, undefined);
    assert.equal(call.options.env.PYTHON_MANAGER_AUTOMATIC_INSTALL, "false");
    assert.ok(call.args.at(-1).includes("import msvcrt;"));
  }
});
