import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import {
  addSkillFromGit,
  removeBundle,
  removeSkill,
  resolveUpdateTarget,
  restoreTrash,
  setMetadataOverride,
  toggleAgent,
  updateSkill,
  validateGitUrl,
  validateStagedSkill,
} from "../src/core/ops.mjs";
import { getPaths } from "../src/core/paths.mjs";
import { createLink, isSymlink, unlinkSafe } from "../src/core/link.mjs";
import { undoLastBackup } from "../src/core/backup.mjs";

test("Git installs only accept root GitHub repositories over HTTPS", () => {
  assert.equal(
    validateGitUrl("https://github.com/example/a-skill.git").toString(),
    "https://github.com/example/a-skill.git"
  );
  assert.throws(() => validateGitUrl("git@github.com:example/a-skill.git"), /full HTTPS/);
  assert.throws(() => validateGitUrl("http://github.com/example/a-skill.git"), /Only HTTPS/);
  assert.throws(() => validateGitUrl("https://gitlab.com/example/a-skill.git"), /github.com/);
  assert.throws(() => validateGitUrl("https://user:token@github.com/example/a-skill.git"), /credentials/);
  assert.throws(() => validateGitUrl("https://github.com/example/a-skill/tree/main"), /repository root/);
});

test("staged Git install rejects multi-Skill repositories without a root SKILL.md", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-stage-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const nested = join(tmp, "skills", "one");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "SKILL.md"), "---\nname: one\ndescription: one\n---\n");

  assert.throws(() => validateStagedSkill(tmp), /multi-Skill bundle/);
  writeFileSync(join(tmp, "SKILL.md"), "# invalid\n");
  assert.throws(() => validateStagedSkill(tmp), /frontmatter name and description/);
  writeFileSync(join(tmp, "SKILL.md"), "---\nname: root\ndescription: root\n---\n");
  assert.doesNotThrow(() => validateStagedSkill(tmp));
});

test("toggle fails for a Skill that does not exist", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-toggle-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.throws(() => toggleAgent("missing", "claude", true, tmp), /not found/);
});

test("toggle is idempotent and refuses to replace a link to another target", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-toggle-link-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const skill = join(paths.SSOT, "demo");
  const claudeLink = join(tmp, ".claude", "skills", "demo");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  createLink(skill, claudeLink, { relative: true });
  assert.doesNotThrow(() => toggleAgent("demo", "claude", true, tmp));

  unlinkSafe(claudeLink);
  const other = join(tmp, "other");
  mkdirSync(other);
  createLink(other, claudeLink, { relative: true });
  assert.throws(() => toggleAgent("demo", "claude", true, tmp), /points elsewhere/);
  assert.throws(() => toggleAgent("demo", "claude", false, tmp), /points elsewhere/);
  assert.equal(isSymlink(claudeLink), true);
});

test("removeSkill refuses to remove an unrelated Agent link", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-remove-conflict-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const skill = join(paths.SSOT, "demo");
  const other = join(tmp, "other");
  const claudeLink = join(tmp, ".claude", "skills", "demo");
  mkdirSync(skill, { recursive: true });
  mkdirSync(other);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  createLink(other, claudeLink, { relative: true });

  assert.throws(() => removeSkill("demo", {}, tmp), /points elsewhere/);
  assert.equal(isSymlink(claudeLink), true);
  assert.equal(existsSync(skill), true);
});

test("removeBundle preflights Agent links before changing the bundle", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-bundle-conflict-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const bundle = join(paths.REPOS, "bundle");
  const bundledSkill = join(bundle, "skills", "demo");
  const ssotLink = join(paths.SSOT, "demo");
  const other = join(tmp, "other");
  const claudeLink = join(tmp, ".claude", "skills", "demo");
  mkdirSync(bundledSkill, { recursive: true });
  mkdirSync(other);
  createLink(bundledSkill, ssotLink, { relative: true });
  createLink(other, claudeLink, { relative: true });

  assert.throws(() => removeBundle("bundle", tmp), /points elsewhere/);
  assert.equal(isSymlink(ssotLink), true);
  assert.equal(isSymlink(claudeLink), true);
  assert.equal(existsSync(bundle), true);
});

test("managed root symlinks cannot escape the configured home", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-root-escape-test-"));
  const outside = mkdtempSync(join(tmpdir(), "skillhub-root-outside-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  mkdirSync(paths.AGENTS_ROOT, { recursive: true });
  createLink(outside, paths.SSOT);

  assert.throws(
    () => addSkillFromGit("https://github.com/example/a-skill.git", {}, tmp),
    /escapes allowed roots/
  );
});

test("restoreTrash refuses a trash root that resolves outside home", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-trash-escape-test-"));
  const outside = mkdtempSync(join(tmpdir(), "skillhub-trash-outside-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  mkdirSync(paths.AGENTS_ROOT, { recursive: true });
  createLink(outside, paths.TRASH);
  const entry = "demo.2026-01-01T00-00-00-000Z";
  mkdirSync(join(outside, entry));

  assert.throws(() => restoreTrash(entry, tmp), /escapes allowed roots/);
  assert.equal(existsSync(join(outside, entry)), true);
});

test("metadata writes refuse a state root that resolves outside home", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-state-escape-test-"));
  const outside = mkdtempSync(join(tmpdir(), "skillhub-state-outside-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const skill = join(paths.SSOT, "demo");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  createLink(outside, paths.SKILLHUB_DIR);

  assert.throws(() => setMetadataOverride("demo", { notes: "blocked" }, tmp), /escapes allowed roots/);
});

test("removeSkill rejects Agent-only entries instead of claiming success", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-agent-only-remove-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.throws(() => removeSkill("demo", {}, tmp), /not a canonical SSOT entry/);
});

test("undo restores both an Agent link and its persisted disabled state", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-toggle-undo-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const skill = join(paths.SSOT, "demo");
  const link = join(tmp, ".claude", "skills", "demo");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  createLink(skill, link, { relative: true });

  toggleAgent("demo", "claude", false, tmp);
  assert.equal(existsSync(link), false);
  assert.deepEqual(JSON.parse(readFileSync(paths.OVERRIDES_FILE, "utf8")).agentDisabled.claude, ["demo"]);

  const undo = undoLastBackup(paths.BACKUPS_DIR);
  assert.equal(undo.ok, true);
  assert.equal(existsSync(link), true);
  assert.equal(existsSync(paths.OVERRIDES_FILE), false);
});

test("metadata overrides are recorded and removable through undo", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-metadata-undo-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const skill = join(paths.SSOT, "demo");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");

  setMetadataOverride("demo", { notes: "local note" }, tmp);
  assert.equal(JSON.parse(readFileSync(paths.OVERRIDES_FILE, "utf8")).notesOverrides.demo, "local note");

  const undo = undoLastBackup(paths.BACKUPS_DIR);
  assert.equal(undo.ok, true);
  assert.equal(existsSync(paths.OVERRIDES_FILE), false);
});

test("bundle update target resolves relative links without slash assumptions", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-update-target-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const paths = getPaths(tmp);
  const target = join(paths.REPOS, "bundle", "skills", "demo");
  const link = join(paths.SSOT, "demo");
  mkdirSync(target, { recursive: true });
  createLink(target, link, { relative: true });

  assert.equal(resolveUpdateTarget(link, paths), join(paths.REPOS, "bundle"));
});

test("updateSkill fast-forwards a managed repository", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-update-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const remote = join(tmp, "remote.git");
  const seed = join(tmp, "seed");
  const skill = join(getPaths(tmp).SSOT, "demo");
  const git = (args, cwd = tmp) => execFileSync("git", args, { cwd, stdio: "ignore" });

  mkdirSync(seed, { recursive: true });
  git(["init", "--bare", remote]);
  git(["init"], seed);
  git(["checkout", "-b", "main"], seed);
  git(["config", "user.name", "SkillHub Test"], seed);
  git(["config", "user.email", "skillhub@example.invalid"], seed);
  writeFileSync(join(seed, "SKILL.md"), "---\nname: demo\ndescription: v1\n---\n");
  git(["add", "SKILL.md"], seed);
  git(["commit", "-m", "v1"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-u", "origin", "main"], seed);
  mkdirSync(getPaths(tmp).SSOT, { recursive: true });
  git(["clone", "--branch", "main", remote, skill]);

  writeFileSync(join(seed, "SKILL.md"), "---\nname: demo\ndescription: v2\n---\n");
  git(["add", "SKILL.md"], seed);
  git(["commit", "-m", "v2"], seed);
  git(["push"], seed);

  const result = updateSkill("demo", tmp);
  assert.equal(result.repositoryPath, skill);
  assert.match(readFileSync(join(skill, "SKILL.md"), "utf-8"), /description: v2/);
});

test("disabling an Agent copy that is a real directory fails loudly", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-disable-realdir-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = join(tmp, ".agents", "skills", "alpha");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n");

  // Some tools keep their own copy in the Agent folder and upgrade it
  // themselves. SkillHub must not delete it, and must not pretend it turned it
  // off either — the Agent goes on reading that directory.
  const agentCopy = join(tmp, ".claude", "skills", "alpha");
  mkdirSync(agentCopy, { recursive: true });
  writeFileSync(join(agentCopy, "SKILL.md"), "---\nname: alpha\ndescription: a copy\n---\n");

  assert.throws(
    () => toggleAgent("alpha", "claude", false, tmp),
    /real directory, not a link SkillHub created/
  );
  assert.ok(existsSync(join(agentCopy, "SKILL.md")), "the real directory must be left untouched");

  const overridesFile = join(tmp, ".skillhub", "overrides.json");
  const disabled = existsSync(overridesFile)
    ? (JSON.parse(readFileSync(overridesFile, "utf-8")).agentDisabled?.claude || [])
    : [];
  assert.ok(!disabled.includes("alpha"), "a refused disable must not be recorded as done");
});

test("parallel metadata writes keep every edit", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-parallel-meta-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const names = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
  for (const name of names) {
    const dir = join(tmp, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  // An agent filling in blurbs has no reason to serialise these calls: the
  // commands do not depend on each other. Each one rewrites the whole override
  // file, so without a lock most of them used to be lost while all of them
  // reported success.
  const cli = join(process.cwd(), "bin", "skillhub");
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve, reject) => {
          execFile(
            process.execPath,
            [cli, "describe", name, `${name} 的中文介绍`],
            { env: { ...process.env, SKILL_HUB_HOME: tmp } },
            (error) => (error ? reject(error) : resolve())
          );
        })
    )
  );

  const written = JSON.parse(readFileSync(join(tmp, ".skillhub", "overrides.json"), "utf-8")).zhOverrides || {};
  assert.deepEqual(Object.keys(written).sort(), [...names].sort());
});
