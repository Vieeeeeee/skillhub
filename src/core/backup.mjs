import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { unlinkSafe, createLink, isSymlink } from "./link.mjs";
import { getAgentDirs, getPaths } from "./paths.mjs";
import { assertSafePath, assertSafeRealPath, isInsideRoot } from "./guard.mjs";

let atomicWriteCounter = 0;

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${atomicWriteCounter++}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { flag: "wx" });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function pathIdentity(path) {
  try {
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(path, expected) {
  if (!expected) return true;
  const actual = pathIdentity(path);
  return Boolean(actual && actual.dev === expected.dev && actual.ino === expected.ino);
}

function fileDigest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function resolvedLinkTarget(linkPath) {
  try {
    return resolve(dirname(linkPath), readlinkSync(linkPath));
  } catch {
    return null;
  }
}

function enrichOperation(operation) {
  if (operation.type === "create-link") {
    return {
      ...operation,
      createdIdentity: pathIdentity(operation.linkPath),
      createdLinkTarget: resolvedLinkTarget(operation.linkPath),
    };
  }
  if (operation.type === "move") {
    return { ...operation, movedIdentity: pathIdentity(operation.dst) };
  }
  if (operation.type === "modify-file") {
    return { ...operation, modifiedDigest: fileDigest(operation.targetFile) };
  }
  if (operation.type === "write-file") {
    return { ...operation, modifiedDigest: fileDigest(operation.targetFile) };
  }
  return operation;
}

// Sessions hold manifests and copies of overrides.json — small, but the
// directory only ever grew, and every `undo` reads all of them to find the
// newest. Keep a deep-but-bounded history.
const MAX_SESSIONS = 100;

function pruneOldSessions(backupsDir) {
  try {
    const dirs = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - MAX_SESSIONS))) {
      const dir = join(backupsDir, name);
      assertSafePath(dir, [backupsDir]);
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

/**
 * `coalesceWith` lets a run of same-kind writes share one session. Writing a
 * Chinese blurb touches exactly one JSON file, so a batch of eighty-four of
 * them used to leave eighty-four session directories that `undo` could only
 * walk back one at a time. Sharing a session means one undo returns the file to
 * how it looked before the batch started.
 */
export function createBackupSession(backupsDir, action = "operation", { coalesceWith = null } = {}) {
  const skillhubDir = dirname(backupsDir);
  const home = basename(skillhubDir) === ".skillhub" ? dirname(skillhubDir) : dirname(backupsDir);
  assertSafeRealPath(backupsDir, [home], { followFinalSymlink: true });
  mkdirSync(backupsDir, { recursive: true });
  assertSafeRealPath(backupsDir, [home], { followFinalSymlink: true });

  if (coalesceWith) {
    const existing = findCoalescableSession(backupsDir, coalesceWith);
    if (existing) {
      existing.manifest.batchedWrites = (existing.manifest.batchedWrites || 1) + 1;
      atomicWriteJson(existing.manifestPath, existing.manifest);
      return existing;
    }
  }
  pruneOldSessions(backupsDir);

  const createdAt = new Date().toISOString();
  const baseId = createdAt.replace(/[:.]/g, "-");
  let sessionId;
  let sessionDir;
  let sessionOrdinal = 0;
  for (let suffix = 0; ; suffix += 1) {
    sessionId = suffix === 0 ? baseId : `${baseId}-${suffix}`;
    sessionDir = join(backupsDir, sessionId);
    try {
      mkdirSync(sessionDir);
      sessionOrdinal = suffix;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  const manifest = {
    sessionId,
    sessionOrdinal,
    action,
    createdAt,
    undoneAt: null,
    operations: [],
  };

  const manifestPath = join(sessionDir, "manifest.json");
  atomicWriteJson(manifestPath, manifest);

  return { sessionDir, manifestPath, manifest };
}

// Only the newest session may be joined, and only while it is still the newest:
// appending to an older one would put operations out of order and break the
// last-in-first-out contract `undo` relies on.
const COALESCE_WINDOW_MS = 30 * 60 * 1000;

function findCoalescableSession(backupsDir, actionPrefix) {
  if (!existsSync(backupsDir)) return null;
  try {
    const newest = readdirSync(backupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .at(-1);
    if (!newest) return null;
    const sessionDir = join(backupsDir, newest);
    const manifestPath = join(sessionDir, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (manifest.undoneAt) return null;
    if (!String(manifest.action || "").startsWith(actionPrefix)) return null;
    if (Date.now() - new Date(manifest.createdAt).getTime() > COALESCE_WINDOW_MS) return null;
    return { sessionDir, manifestPath, manifest };
  } catch {
    return null;
  }
}

/**
 * A repeated write to the same file inside one session updates the operation
 * already recorded for it rather than stacking another. The saved copy stays
 * the pre-batch state; the digest has to move to the current state, or undo
 * would refuse the restore as "changed after the backup".
 */
export function recordFileWrite(session, operation) {
  const existing = session.manifest.operations.find(
    (op) => op.type === "write-file" && op.targetFile === operation.targetFile
  );
  if (!existing) return recordOperation(session, operation);
  existing.modifiedDigest = fileDigest(operation.targetFile);
  existing.timestamp = new Date().toISOString();
  atomicWriteJson(session.manifestPath, session.manifest);
}

export function recordOperation(session, operation) {
  session.manifest.operations.push({
    ...enrichOperation(operation),
    timestamp: new Date().toISOString(),
  });
  atomicWriteJson(session.manifestPath, session.manifest);
}

export function listBackups(backupsDir) {
  if (!existsSync(backupsDir)) return [];
  const skillhubDir = dirname(backupsDir);
  const home = basename(skillhubDir) === ".skillhub" ? dirname(skillhubDir) : dirname(backupsDir);
  assertSafeRealPath(backupsDir, [home], { followFinalSymlink: true });

  const entries = readdirSync(backupsDir, { withFileTypes: true });
  const backups = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(backupsDir, entry.name, "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        backups.push({ id: entry.name, dir: join(backupsDir, entry.name), manifest });
      } catch {}
    }
  }

  return backups.sort((a, b) => {
    const byTime = String(b.manifest.createdAt || "").localeCompare(String(a.manifest.createdAt || ""));
    if (byTime !== 0) return byTime;
    const byOrdinal = (b.manifest.sessionOrdinal || 0) - (a.manifest.sessionOrdinal || 0);
    return byOrdinal || b.id.localeCompare(a.id);
  });
}

function assertUndoPath(path, home, allowedRoots, followFinalSymlink = false) {
  if (typeof path !== "string" || !path) throw new Error("Backup operation contains an invalid path");
  assertSafePath(path, allowedRoots);
  assertSafeRealPath(path, [home], { followFinalSymlink });
}

function reverseOperation(op, backupDir, home, allowedRoots) {
  if (op.type === "create-link") {
    assertUndoPath(op.linkPath, home, allowedRoots, false);
    if (!existsSync(op.linkPath) && !isSymlink(op.linkPath)) {
      return `Link already absent: ${op.linkPath}`;
    }
    if (!isSymlink(op.linkPath)) {
      throw new Error(`Refusing to remove a new non-link path at ${op.linkPath}`);
    }
    if (!sameIdentity(op.linkPath, op.createdIdentity)) {
      throw new Error(`Refusing to remove a link created after the backup at ${op.linkPath}`);
    }
    const currentTarget = resolvedLinkTarget(op.linkPath);
    const expectedTarget = op.createdLinkTarget || resolve(dirname(op.linkPath), op.targetPath);
    if (currentTarget !== expectedTarget) {
      throw new Error(`Refusing to remove a changed link at ${op.linkPath}`);
    }
    unlinkSafe(op.linkPath);
    return `Removed link: ${op.linkPath}`;
  }

  if (op.type === "remove-link") {
    assertUndoPath(op.linkPath, home, allowedRoots, false);
    if (existsSync(op.linkPath) || isSymlink(op.linkPath)) {
      throw new Error(`Refusing to overwrite a path created after the backup at ${op.linkPath}`);
    }
    createLink(op.targetPath, op.linkPath, { relative: op.relative });
    return `Recreated link: ${op.linkPath} -> ${op.targetPath}`;
  }

  if (op.type === "move") {
    assertUndoPath(op.src, home, allowedRoots, false);
    assertUndoPath(op.dst, home, allowedRoots, false);
    const srcExists = existsSync(op.src) || isSymlink(op.src);
    const dstExists = existsSync(op.dst) || isSymlink(op.dst);
    if (srcExists) {
      if (!dstExists && sameIdentity(op.src, op.movedIdentity)) {
        return `Move already restored: ${op.dst} -> ${op.src}`;
      }
      throw new Error(`Refusing to overwrite a path created after the backup at ${op.src}`);
    }
    if (!dstExists) {
      throw new Error(`Cannot restore move because source data is missing at ${op.dst}`);
    }
    if (!sameIdentity(op.dst, op.movedIdentity)) {
      throw new Error(`Refusing to move data created after the backup at ${op.dst}`);
    }
    mkdirSync(dirname(op.src), { recursive: true });
    renameSync(op.dst, op.src);
    return `Restored move: ${op.dst} -> ${op.src}`;
  }

  if (op.type === "remove-empty-dir") {
    assertUndoPath(op.path, home, allowedRoots, false);
    if (existsSync(op.path) || isSymlink(op.path)) {
      try {
        if (lstatSync(op.path).isDirectory() && !isSymlink(op.path)) {
          return `Directory already restored: ${op.path}`;
        }
      } catch {}
      throw new Error(`Refusing to overwrite a new path at ${op.path}`);
    }
    mkdirSync(op.path, { mode: op.mode });
    return `Restored empty directory: ${op.path}`;
  }

  if (op.type === "modify-file" && op.backupFile) {
    const backupFilePath = join(backupDir, op.backupFile);
    assertUndoPath(op.targetFile, home, allowedRoots, true);
    assertSafePath(backupFilePath, [backupDir]);
    assertSafeRealPath(backupFilePath, [backupDir]);
    if (!existsSync(backupFilePath)) {
      throw new Error(`Backup file is missing: ${backupFilePath}`);
    }
    if (op.modifiedDigest && fileDigest(op.targetFile) !== op.modifiedDigest) {
      throw new Error(`Refusing to overwrite a file changed after the backup at ${op.targetFile}`);
    }
    copyFileSync(backupFilePath, op.targetFile);
    return `Restored file: ${op.targetFile}`;
  }

  if (op.type === "write-file") {
    assertUndoPath(op.targetFile, home, allowedRoots, true);
    if (op.modifiedDigest && fileDigest(op.targetFile) !== op.modifiedDigest) {
      throw new Error(`Refusing to overwrite a file changed after the backup at ${op.targetFile}`);
    }

    if (op.existedBefore) {
      const backupFilePath = join(backupDir, op.backupFile || "");
      assertSafePath(backupFilePath, [backupDir]);
      assertSafeRealPath(backupFilePath, [backupDir]);
      if (!op.backupFile || !existsSync(backupFilePath)) {
        throw new Error(`Backup file is missing: ${backupFilePath}`);
      }
      copyFileSync(backupFilePath, op.targetFile);
      return `Restored file: ${op.targetFile}`;
    }

    if (!existsSync(op.targetFile) && !isSymlink(op.targetFile)) {
      return `Created file already absent: ${op.targetFile}`;
    }
    if (isSymlink(op.targetFile) || !lstatSync(op.targetFile).isFile()) {
      throw new Error(`Refusing to remove a replacement path at ${op.targetFile}`);
    }
    unlinkSync(op.targetFile);
    return `Removed file created by operation: ${op.targetFile}`;
  }

  throw new Error(`Unsupported backup operation: ${op.type}`);
}

export function undoLastBackup(backupsDir) {
  const backups = listBackups(backupsDir);
  const target = backups.find((backup) =>
    !backup.manifest.undoneAt && backup.manifest.operations.length > 0
  );

  if (!target) {
    // Not a failure: a fresh install has nothing recorded yet, and calling that
    // "Undo failed" reads as breakage when nothing is wrong.
    return { ok: false, nothingToUndo: true, error: "No recorded operation to undo" };
  }

  const { manifest, dir } = target;
  const skillhubDir = dirname(backupsDir);
  const standardLayout = basename(skillhubDir) === ".skillhub";
  const home = standardLayout
    ? dirname(skillhubDir)
    : dirname(backupsDir);
  const paths = getPaths(home);
  const allowedRoots = standardLayout
    ? [
        paths.AGENTS_ROOT,
        paths.SKILLHUB_DIR,
        join(home, ".codex", "skills"),
        ...Object.values(getAgentDirs(home)).map((agent) => agent.absPath),
      ].filter((root) => isInsideRoot(root, home))
    : [home];
  const manifestPath = join(dir, "manifest.json");
  const completed = new Set(manifest.undoCompletedOperations || []);
  const logs = [...(manifest.undoLogs || [])];

  for (let index = manifest.operations.length - 1; index >= 0; index -= 1) {
    if (completed.has(index)) continue;
    const op = manifest.operations[index];
    try {
      logs.push(reverseOperation(op, dir, home, allowedRoots));
      completed.add(index);
      manifest.undoCompletedOperations = [...completed].sort((a, b) => a - b);
      manifest.undoLogs = logs;
      delete manifest.undoError;
      atomicWriteJson(manifestPath, manifest);
    } catch (error) {
      logs.push(`Error reversing operation ${index} (${op.type}): ${error.message}`);
      manifest.undoLogs = logs;
      manifest.undoCompletedOperations = [...completed].sort((a, b) => a - b);
      manifest.undoError = {
        operationIndex: index,
        type: op.type,
        message: error.message,
        failedAt: new Date().toISOString(),
      };
      atomicWriteJson(manifestPath, manifest);
      return {
        ok: false,
        sessionId: target.id,
        error: error.message,
        logs,
        retryable: true,
      };
    }
  }

  manifest.undoneAt = new Date().toISOString();
  manifest.undoLogs = logs;
  delete manifest.undoError;
  atomicWriteJson(manifestPath, manifest);

  return { ok: true, sessionId: target.id, logs };
}
