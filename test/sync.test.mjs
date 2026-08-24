import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyncPlan, applySyncPlan, resolvesInto } from "../src/core/sync.mjs";
import { isSymlink } from "../src/core/link.mjs";
import { undoLastBackup } from "../src/core/backup.mjs";

test("sync plan detects missing agent symlinks and applySyncPlan creates them", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ssot = join(tmp, ".agents", "skills");
  const claude = join(tmp, ".claude", "skills");
  mkdirSync(ssot, { recursive: true });
  mkdirSync(claude, { recursive: true });

  const skill1 = join(ssot, "skill-one");
  mkdirSync(skill1, { recursive: true });
  writeFileSync(join(skill1, "SKILL.md"), "---\nname: skill-one\ndescription: desc\n---\n");

  const plan = buildSyncPlan(tmp);
  const linkAction = plan.find((a) => a.kind === "link" && a.skill === "skill-one" && a.agent === "claude");
  assert.ok(linkAction, "Should propose creating link for skill-one in claude");

  const applied = applySyncPlan(plan, tmp);
  assert.ok(applied.applied.length > 0);

  const claudeLink = join(claude, "skill-one");
  assert.ok(existsSync(claudeLink));
  assert.ok(isSymlink(claudeLink));
});

test("applySyncPlan rejects client-forged link paths outside managed roots", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-forged-link-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const skill = join(tmp, ".agents", "skills", "safe-skill");
  const claude = join(tmp, ".claude", "skills");
  const outside = join(tmp, "outside-link");
  mkdirSync(skill, { recursive: true });
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# safe");

  const canonical = buildSyncPlan(tmp).find((action) =>
    action.kind === "link" && action.agent === "claude" && action.skill === "safe-skill"
  );
  assert.ok(canonical);
  const result = applySyncPlan([{ ...canonical, linkPath: outside }], tmp);
  assert.equal(result.applied[0].ok, false);
  assert.match(result.applied[0].error, /does not match/);
  assert.ok(!existsSync(outside));
  assert.ok(!existsSync(join(claude, "safe-skill")));
  assert.equal(result.sessionId, null, "rejected actions must not create a fake backup session");
});

test("applySyncPlan rejects writes through an agent directory symlink escaping home", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-parent-escape-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home");
  const skill = join(home, ".agents", "skills", "safe-skill");
  const outside = join(tmp, "outside-agent-skills");
  mkdirSync(skill, { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(skill, "SKILL.md"), "# safe");
  symlinkSync(outside, join(home, ".claude", "skills"), "dir");

  const action = buildSyncPlan(home).find((item) =>
    item.kind === "link" && item.agent === "claude" && item.skill === "safe-skill"
  );
  assert.ok(action);
  const result = applySyncPlan([action], home);
  assert.equal(result.applied[0].ok, false);
  assert.match(result.applied[0].error, /Security Exception/);
  assert.ok(!existsSync(join(outside, "safe-skill")));
});

test("harvest requires explicit enablement and ignores forged source paths", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-harvest-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const source = join(tmp, ".claude", "skills", "orphan");
  const outside = join(tmp, "outside", "orphan");
  mkdirSync(source, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# real orphan");
  writeFileSync(join(outside, "SKILL.md"), "# must stay outside");

  const action = buildSyncPlan(tmp, { allowHarvest: true }).find((item) =>
    item.kind === "harvest" && item.agent === "claude" && item.skill === "orphan"
  );
  assert.ok(action);

  const disabled = applySyncPlan([action], tmp);
  assert.equal(disabled.applied[0].ok, false);
  assert.match(disabled.applied[0].error, /disabled/);
  assert.ok(existsSync(source));

  const forged = applySyncPlan([{ ...action, path: outside }], tmp, { allowHarvest: true });
  assert.equal(forged.applied[0].ok, false);
  assert.match(forged.applied[0].error, /does not match/);
  assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), "# must stay outside");
  assert.ok(!existsSync(join(tmp, ".agents", "skills", "orphan")));
});

test("remove-empty-dir is logged and undo recreates it", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-empty-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const empty = join(tmp, ".agents", "skills", "empty-skill");
  mkdirSync(empty, { recursive: true });

  const action = buildSyncPlan(tmp).find((item) =>
    item.kind === "remove-empty-dir" && item.skill === "empty-skill"
  );
  assert.ok(action);
  const result = applySyncPlan([action], tmp);
  assert.equal(result.applied[0].ok, true);
  assert.ok(!existsSync(empty));

  const undo = undoLastBackup(join(tmp, ".skillhub", "backups"));
  assert.equal(undo.ok, true);
  assert.ok(existsSync(empty));
});

test("applySyncPlan rejects traversal names and unknown action types", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-invalid-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, ".agents", "skills"), { recursive: true });

  const result = applySyncPlan([
    { kind: "remove-empty-dir", skill: "../escape", path: join(tmp, "escape") },
    { kind: "delete", skill: "anything", path: join(tmp, "anything") },
  ], tmp);
  assert.equal(result.applied.length, 2);
  assert.equal(result.applied[0].ok, false);
  assert.equal(result.applied[1].ok, false);
  assert.equal(result.sessionId, null);
});

test("resolvesInto uses path boundaries instead of slash or prefix assumptions", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-sync-resolve-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = join(tmp, "skills");
  const sibling = join(tmp, "skills-copy");
  mkdirSync(join(root, "inside"), { recursive: true });
  mkdirSync(sibling);
  const insideLink = join(tmp, "inside-link");
  const siblingLink = join(tmp, "sibling-link");
  symlinkSync(join(root, "inside"), insideLink, "dir");
  symlinkSync(sibling, siblingLink, "dir");

  assert.equal(resolvesInto(insideLink, root), true);
  assert.equal(resolvesInto(siblingLink, root), false);
});
