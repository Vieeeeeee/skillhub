import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLink, unlinkSafe, isSymlink, isBrokenLink, moveToTrash } from "../src/core/link.mjs";

test("link operations: create, detect, and safe unlink", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-link-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const targetDir = join(tmp, "target-skill");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "SKILL.md"), "# Target Skill");

  const linkDir = join(tmp, "agent-skills");
  const linkPath = join(linkDir, "linked-skill");

  // Create link
  createLink(targetDir, linkPath, { relative: true });
  assert.ok(isSymlink(linkPath));
  assert.ok(existsSync(join(linkPath, "SKILL.md")));
  assert.ok(!isBrokenLink(linkPath));

  // Safe unlink
  const res = unlinkSafe(linkPath);
  assert.ok(res.ok);
  assert.ok(!existsSync(linkPath));
  assert.ok(existsSync(targetDir), "Target directory must remain intact after unlink");
});

test("unlinkSafe REFUSES to delete regular directories (Safety Red Line)", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-safety-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const realDir = join(tmp, "real-directory");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, "important.txt"), "Important user data");

  assert.throws(
    () => unlinkSafe(realDir),
    /Safety Violation: Refusing to unlink/
  );
  assert.ok(existsSync(realDir), "Real directory must not be deleted");
});

test("createLink refuses to replace an existing symlink", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-link-replace-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const firstTarget = join(tmp, "first");
  const secondTarget = join(tmp, "second");
  const linkPath = join(tmp, "links", "skill");
  mkdirSync(firstTarget);
  mkdirSync(secondTarget);
  writeFileSync(join(firstTarget, "marker"), "first");
  writeFileSync(join(secondTarget, "marker"), "second");
  createLink(firstTarget, linkPath, { relative: true });

  assert.throws(
    () => createLink(secondTarget, linkPath, { relative: true }),
    /symbolic link already exists/,
  );
  assert.equal(readFileSync(join(linkPath, "marker"), "utf8"), "first");
});

test("moveToTrash safely moves file to timestamped destination", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-trash-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const skillDir = join(tmp, "old-skill");
  const trashDir = join(tmp, "_trash");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "data.json"), "{}");

  const res = moveToTrash(skillDir, trashDir);
  assert.ok(res.ok);
  assert.ok(!existsSync(skillDir));
  assert.ok(existsSync(res.destination));
});
