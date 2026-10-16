"use strict";

const path = require("path");

// Resolve only the shared skills parent, never an individual skill entry.
function resolveSkillPaths(configRoot, fsImpl) {
  const logical = path.join(path.resolve(configRoot), "skills");
  const statAt = (file) => {
    try { return fsImpl.lstatSync(file); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino && a.isSymbolicLink() === b.isSymbolicLink());
  const fail = () => { throw new Error("Skills directory changed or is unsafe"); };
  let anchor = logical;
  while (!statAt(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) fail();
    anchor = parent;
  }
  const anchorEntry = statAt(anchor);
  const anchorReal = fsImpl.realpathSync(anchor);
  const anchorDirectory = statAt(anchorReal);
  if (!anchorDirectory?.isDirectory() || anchorDirectory.isSymbolicLink()) fail();
  const skills = path.join(anchorReal, path.relative(anchor, logical));
  let entry = statAt(logical);
  let directory = statAt(skills);
  if (entry && (!directory?.isDirectory() || directory.isSymbolicLink())) fail();

  // Rollback uses the pinned physical path, even if the Junction was retargeted.
  function physicalValid() {
    try {
      if (fsImpl.realpathSync(anchorReal) !== anchorReal || !same(anchorDirectory, statAt(anchorReal))) return false;
      if (directory) return fsImpl.realpathSync(skills) === skills && same(directory, statAt(skills));
      let nearest = skills;
      while (!statAt(nearest)) nearest = path.dirname(nearest);
      const stat = statAt(nearest);
      return stat.isDirectory() && !stat.isSymbolicLink() && fsImpl.realpathSync(nearest) === nearest;
    } catch (_) { return false; }
  }
  function check() {
    if (!physicalValid() || !same(anchorEntry, statAt(anchor)) || fsImpl.realpathSync(anchor) !== anchorReal) fail();
    const current = statAt(logical);
    if (entry) {
      if (!same(entry, current) || fsImpl.realpathSync(logical) !== skills) fail();
    } else if (current) {
      // A missing parent may be created during dependency probing, but not redirected.
      if (!current.isDirectory() || current.isSymbolicLink() || fsImpl.realpathSync(logical) !== skills) fail();
      entry = current;
      directory = statAt(skills);
    }
  }
  function ensure() {
    check();
    if (!entry) fsImpl.mkdirSync(skills, { recursive: true, mode: 0o700 });
    check();
  }
  const redirected = path.relative(logical, skills) !== "";
  return { skills,
    privateRoot: redirected ? path.join(path.dirname(skills), "claude-proxy") : path.join(path.resolve(configRoot), "claude-proxy"),
    check, ensure, physicalValid };
}

module.exports = { resolveSkillPaths };
