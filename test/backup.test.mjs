import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupSession, recordOperation, listBackups, undoLastBackup } from "../src/core/backup.mjs";
import { createLink, isSymlink } from "../src/core/link.mjs";

test("backup session logs operations and undoLastBackup reverses them", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const backupsDir = join(tmp, "backups");
  const ssotDir = join(tmp, "ssot");
  const claudeDir = join(tmp, "claude");
  mkdirSync(ssotDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const skillPath = join(ssotDir, "test-skill");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(join(skillPath, "SKILL.md"), "test");

  const linkPath = join(claudeDir, "test-skill");

  // Perform an operation with backup session
  const session = createBackupSession(backupsDir, "test-link");
  createLink(skillPath, linkPath);
  recordOperation(session, {
    type: "create-link",
    linkPath,
    targetPath: skillPath,
  });

  assert.ok(existsSync(linkPath));
  assert.ok(isSymlink(linkPath));

  const backups = listBackups(backupsDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].manifest.action, "test-link");

  // Perform undo
  const undoRes = undoLastBackup(backupsDir);
  assert.ok(undoRes.ok);
  assert.ok(!existsSync(linkPath), "Link should be removed after undo");
  assert.ok(existsSync(skillPath), "SSOT skill should remain intact");
});

test("undo failure stays retryable and does not claim success", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-retry-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, "backups");
  const target = join(tmp, "target");
  const linkPath = join(tmp, "links", "skill");
  mkdirSync(target);

  createLink(target, linkPath, { relative: true });
  const previousTarget = "../target";
  rmSync(linkPath);
  const session = createBackupSession(backupsDir, "remove-link");
  recordOperation(session, { type: "remove-link", linkPath, targetPath: previousTarget });

  mkdirSync(linkPath, { recursive: true });
  const first = undoLastBackup(backupsDir);
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.ok(existsSync(linkPath), "new user path must remain untouched");

  let manifest = JSON.parse(readFileSync(session.manifestPath, "utf8"));
  assert.equal(manifest.undoneAt, null);
  assert.equal(manifest.undoError.operationIndex, 0);

  rmSync(linkPath, { recursive: true });
  const retried = undoLastBackup(backupsDir);
  assert.equal(retried.ok, true);
  assert.ok(isSymlink(linkPath));
  manifest = JSON.parse(readFileSync(session.manifestPath, "utf8"));
  assert.ok(manifest.undoneAt);
  assert.equal(manifest.undoError, undefined);
});

test("undo refuses to remove a replacement symlink", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-new-link-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, "backups");
  const originalTarget = join(tmp, "original");
  const newTarget = join(tmp, "new-target");
  const linkPath = join(tmp, "links", "skill");
  mkdirSync(originalTarget);
  mkdirSync(newTarget);

  const session = createBackupSession(backupsDir, "create-link");
  createLink(originalTarget, linkPath, { relative: true });
  recordOperation(session, { type: "create-link", linkPath, targetPath: originalTarget, relative: true });
  rmSync(linkPath);
  createLink(newTarget, linkPath, { relative: true });

  const result = undoLastBackup(backupsDir);
  assert.equal(result.ok, false);
  assert.ok(isSymlink(linkPath), "replacement link must remain untouched");
  const manifest = JSON.parse(readFileSync(session.manifestPath, "utf8"));
  assert.equal(manifest.undoneAt, null);
});

test("partial undo progress is persisted and a retry resumes safely", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-partial-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, "backups");
  const target = join(tmp, "target");
  const removedLink = join(tmp, "links", "removed");
  const createdLink = join(tmp, "links", "created");
  mkdirSync(target);

  const session = createBackupSession(backupsDir, "partial");
  recordOperation(session, { type: "remove-link", linkPath: removedLink, targetPath: target });
  createLink(target, createdLink, { relative: true });
  recordOperation(session, { type: "create-link", linkPath: createdLink, targetPath: target, relative: true });
  mkdirSync(removedLink, { recursive: true });

  const first = undoLastBackup(backupsDir);
  assert.equal(first.ok, false);
  assert.ok(!existsSync(createdLink), "the already-reversed operation remains reversed");
  let manifest = JSON.parse(readFileSync(session.manifestPath, "utf8"));
  assert.deepEqual(manifest.undoCompletedOperations, [1]);

  rmSync(removedLink, { recursive: true });
  const second = undoLastBackup(backupsDir);
  assert.equal(second.ok, true);
  assert.ok(isSymlink(removedLink));
  assert.ok(!existsSync(createdLink));
});

test("backup session IDs do not collide and manifests leave no temp files", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-collision-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, "backups");
  const sessions = Array.from({ length: 20 }, () => createBackupSession(backupsDir, "collision"));
  assert.equal(new Set(sessions.map((session) => session.manifest.sessionId)).size, sessions.length);
  assert.deepEqual(
    listBackups(backupsDir).map((backup) => backup.id),
    [...sessions].reverse().map((session) => session.manifest.sessionId),
  );
  for (const session of sessions) {
    assert.deepEqual(readdirSync(session.sessionDir), ["manifest.json"]);
  }
});

test("remove-empty-dir is recorded and restored without overwriting a new path", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-empty-dir-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, "backups");
  const emptyDir = join(tmp, "empty");
  mkdirSync(emptyDir);
  const session = createBackupSession(backupsDir, "remove-empty");
  rmSync(emptyDir, { recursive: true });
  recordOperation(session, { type: "remove-empty-dir", path: emptyDir, mode: 0o755 });

  const result = undoLastBackup(backupsDir);
  assert.equal(result.ok, true);
  assert.ok(existsSync(emptyDir));
});

test("undo rejects tampered manifest paths outside the managed home", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "skillhub-backup-boundary-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const backupsDir = join(tmp, ".skillhub", "backups");
  const outside = join(tmp, "Desktop", "unmanaged-link");
  const target = join(tmp, ".agents", "skills", "target");
  mkdirSync(target, { recursive: true });
  createLink(target, outside, { relative: true });

  const session = createBackupSession(backupsDir, "tampered");
  recordOperation(session, { type: "create-link", linkPath: outside, targetPath: target, relative: true });
  const result = undoLastBackup(backupsDir);
  assert.equal(result.ok, false);
  assert.match(result.error, /Security Exception/);
  assert.ok(isSymlink(outside), "outside link must remain untouched");
  const manifest = JSON.parse(readFileSync(session.manifestPath, "utf8"));
  assert.equal(manifest.undoneAt, null);
});
