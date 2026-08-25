import {
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  cpSync,
  rmSync,
} from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { isWindows } from "./paths.mjs";

/**
 * Check if a path is a symbolic link or junction without following target.
 */
export function isSymlink(p) {
  try {
    const stat = lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Safely read a link target if it is a link.
 */
export function readLinkSafe(p) {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * Check if a link is broken (is a symlink but target does not exist).
 */
export function isBrokenLink(p) {
  if (!isSymlink(p)) return false;
  try {
    return !existsSync(p);
  } catch {
    return true;
  }
}

/**
 * Create a cross-platform link.
 * POSIX: Relative or absolute symlink ('dir').
 * Windows: NTFS Directory Junction ('junction', requires no admin privilege).
 */
export function createLink(targetPath, linkPath, { relative: useRelative = false } = {}) {
  const linkDir = dirname(linkPath);
  if (!existsSync(linkDir)) {
    mkdirSync(linkDir, { recursive: true });
  }

  // Never replace an existing entry here. Callers that intentionally remove a
  // link must do so explicitly and record that separate operation first.
  if (isSymlink(linkPath)) {
    throw new Error(`Cannot create link at "${linkPath}": a symbolic link already exists.`);
  } else if (existsSync(linkPath)) {
    throw new Error(`Cannot create link at "${linkPath}": a regular file or directory already exists.`);
  }

  if (isWindows) {
    // Windows junction requires absolute target path
    const absTarget = resolve(targetPath);
    symlinkSync(absTarget, linkPath, "junction");
  } else {
    // POSIX
    let finalTarget = targetPath;
    if (useRelative) {
      finalTarget = relative(linkDir, targetPath);
    }
    symlinkSync(finalTarget, linkPath, "dir");
  }
}

/**
 * Safely remove a symlink. Refuses to remove real files or directories!
 */
export function unlinkSafe(linkPath) {
  if (!existsSync(linkPath) && !isSymlink(linkPath)) {
    return { ok: true, skipped: true, reason: "does not exist" };
  }

  if (!isSymlink(linkPath)) {
    throw new Error(`Safety Violation: Refusing to unlink "${linkPath}" because it is a real file/directory, not a symlink.`);
  }

  unlinkSync(linkPath);
  return { ok: true, unlinked: linkPath };
}

/**
 * Move a file or directory into a timestamped trash directory instead of deleting.
 */
export function moveToTrash(sourcePath, trashDir) {
  if (!existsSync(sourcePath) && !isSymlink(sourcePath)) {
    return { ok: true, skipped: true, reason: "does not exist" };
  }

  if (!existsSync(trashDir)) {
    mkdirSync(trashDir, { recursive: true });
  }

  const base = sourcePath.split(/[/\\]/).filter(Boolean).pop();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destName = `${base}.${timestamp}`;
  const destPath = join(trashDir, destName);

  try {
    renameSync(sourcePath, destPath);
  } catch (error) {
    // rename cannot cross a filesystem. If ~/.agents/skills sits on an external
    // volume or a different mount, uninstalling failed with EXDEV — invisible
    // on a single-disk Mac, and exactly the shape of problem that only shows up
    // on someone else's machine.
    if (error.code !== "EXDEV") throw error;
    cpSync(sourcePath, destPath, { recursive: true, verbatimSymlinks: true });
    rmSync(sourcePath, { recursive: true, force: true });
  }
  return { ok: true, trashed: sourcePath, destination: destPath, entry: destName };
}
