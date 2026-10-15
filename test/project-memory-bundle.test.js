"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const bundleRoot = path.resolve(__dirname, "../project-code-memory");
const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, "manifest.json"), "utf8"));
const sourceFiles = [
  "SKILL.md",
  "README.md",
  "agents/openai.yaml",
  "references/record-format.md",
  "scripts/pcm.py",
  "tests/test_pcm.py",
];
const extraFiles = ["LICENSE", "SOURCE.md"];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("bundle manifest identifies the pinned upstream and approved install files", () => {
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.upstream, {
    url: "https://github.com/shanshazhe/projectcodememory.git",
    commit: "7dc7b0dad137fa8e1e65af31143f4ead8109ca03",
  });
  assert.deepEqual(manifest.installFiles, [
    "scripts/pcm.py",
    "LICENSE",
    "SOURCE.md",
    "SKILL.md",
  ]);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...sourceFiles, ...extraFiles].sort());
  assert.deepEqual(Object.keys(manifest.upstreamFiles).sort(), sourceFiles.slice().sort());
});

test("every deployed file matches its manifest hash and has no unlisted files", () => {
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const info = fs.lstatSync(path.join(bundleRoot, relativePath));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    assert.equal(sha256(path.join(bundleRoot, relativePath)), expectedHash, relativePath);
  }
  assert.match(fs.readFileSync(path.join(bundleRoot, "LICENSE"), "utf8"), /MIT License[\s\S]*Permission is hereby granted/);
  assert.match(fs.readFileSync(path.join(bundleRoot, "SOURCE.md"), "utf8"), /source owner explicitly authorized/);
  const actualFiles = [];
  function visit(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(prefix, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relativePath);
      else if (relativePath !== "manifest.json") actualFiles.push(relativePath);
    }
  }
  visit(bundleRoot);
  assert.deepEqual(actualFiles.sort(), Object.keys(manifest.files).sort());
});

test("manifest retains real target and source previous-deployment fingerprints", () => {
  const deployments = manifest.previousDeployments;
  assert.ok(Array.isArray(deployments));
  const expected = [
    { commit: "f3fab02", files: [...Object.keys(manifest.files), "manifest.json"].sort(), method: /530542c\^/ },
    { commit: "ece898a", files: ["LICENSE", "SKILL.md", "SOURCE.md", "references/record-format.md", "scripts/pcm.py"] },
    { commit: "ece898a", files: [...Object.keys(manifest.files), "manifest.json"].sort() },
  ];
  for (const wanted of expected) {
    const deployment = deployments.find((entry) => entry.commit.startsWith(wanted.commit) &&
      Object.keys(entry.files).sort().join("\n") === wanted.files.slice().sort().join("\n"));
    assert.ok(deployment, `missing previous deployment ${wanted.commit}`);
    if (wanted.method) assert.match(deployment.method, wanted.method);
    for (const digest of Object.values(deployment.files)) assert.match(digest, /^[a-f0-9]{64}$/);
  }
});

test("core upstream originals are identified and the Python implementation is unmodified", () => {
  for (const relativePath of ["scripts/pcm.py", "references/record-format.md", "SKILL.md"]) {
    assert.match(manifest.upstreamFiles[relativePath], /^[a-f0-9]{64}$/);
  }
  assert.equal(
    sha256(path.join(bundleRoot, "scripts/pcm.py")),
    manifest.upstreamFiles["scripts/pcm.py"],
  );
});

test("bundle documentation names the Claude skill location, query-only use and operational constraints", () => {
  const skill = fs.readFileSync(path.join(bundleRoot, "SKILL.md"), "utf8");
  const readme = fs.readFileSync(path.join(bundleRoot, "README.md"), "utf8");
  assert.match(skill, /Python 3\.9 or newer/);
  assert.match(skill, /python -I -B/);
  assert.match(skill, /py -3 -I -B/);
  assert.match(skill, /absolute-skill-dir/);
  assert.doesNotMatch(skill, /references\/record-format\.md/);
  assert.match(skill, /Never maintain records yourself/);
  assert.match(skill, /Do not write drafts, run `save`, `audit`, or `reindex`/);
  assert.match(skill, /`VALID` only means the SHA-256 fingerprints/);
  assert.match(skill, /read the cited lines/);
  assert.match(skill, /ProjectMemoryUpdate/);
  assert.match(skill, /not an automatically installed hook/);
  assert.match(skill, /creating the target `projectCodeMemory\/` cache/);
  assert.match(readme, /~\/\.claude\/skills\/project-code-memory/);
  assert.match(readme, /not an automatically installed hook/);
  assert.match(readme, /python -I -B/);
  assert.match(readme, /query` is intentionally not read-only/);
});
