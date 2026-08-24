import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, normalize, sep } from "node:path";

/**
 * Ensures that a skill name or folder name is safe and does not attempt path traversal.
 */
export function assertSafeName(name, label = "name") {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Invalid ${label}: cannot be empty`);
  }
  const trimmed = name.trim();
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes(":") ||
    trimmed.length > 255
  ) {
    throw new Error(`Invalid ${label}: "${name}" contains forbidden characters or attempts traversal`);
  }
}

/**
 * Returns true if childPath is located strictly inside parentRoot or is parentRoot.
 */
export function isInsideRoot(childPath, parentRoot) {
  if (!childPath || !parentRoot) return false;
  const absChild = resolve(normalize(childPath));
  const absParent = resolve(normalize(parentRoot));
  if (absChild === absParent) return true;
  return absChild.startsWith(absParent.endsWith(sep) ? absParent : absParent + sep);
}

/**
 * Asserts that targetPath resides inside at least one of the allowed roots.
 */
export function assertSafePath(targetPath, allowedRoots = []) {
  if (!targetPath) {
    throw new Error("Target path cannot be empty");
  }
  const isSafe = allowedRoots.some((root) => isInsideRoot(targetPath, root));
  if (!isSafe) {
    throw new Error(`Security Exception: path "${targetPath}" is outside allowed roots [${allowedRoots.join(", ")}]`);
  }
}

function nearestExistingPath(targetPath) {
  let current = resolve(normalize(targetPath));
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Like assertSafePath, but also follows the existing filesystem ancestry. This
 * prevents a lexically safe path from escaping through a symlinked parent.
 *
 * When operating on a symlink itself, set followFinalSymlink to false so the
 * link's parent is checked without treating its destination as the write path.
 */
export function assertSafeRealPath(
  targetPath,
  allowedRoots = [],
  { followFinalSymlink = true } = {},
) {
  assertSafePath(targetPath, allowedRoots);

  const checkPath = followFinalSymlink ? targetPath : dirname(targetPath);
  const existingPath = nearestExistingPath(checkPath);
  if (!existingPath) {
    throw new Error(`Security Exception: cannot resolve existing ancestry for "${targetPath}"`);
  }

  let realExisting;
  try {
    realExisting = realpathSync(existingPath);
  } catch {
    throw new Error(`Security Exception: cannot resolve real path for "${targetPath}"`);
  }

  const isSafe = allowedRoots.some((root) => {
    const absRoot = resolve(normalize(root));
    const existingRoot = nearestExistingPath(absRoot);
    if (!existingRoot) return false;

    let realRootAncestor;
    try {
      realRootAncestor = realpathSync(existingRoot);
    } catch {
      return false;
    }

    // If the full root exists, use its physical location. If it does not yet
    // exist, both paths must still share the same real existing ancestor and
    // lexical containment has already been established above.
    if (existsSync(absRoot)) {
      try {
        return isInsideRoot(realExisting, realpathSync(absRoot));
      } catch {
        return false;
      }
    }
    return realExisting === realRootAncestor || isInsideRoot(realExisting, realRootAncestor);
  });

  if (!isSafe) {
    throw new Error(
      `Security Exception: real path for "${targetPath}" escapes allowed roots [${allowedRoots.join(", ")}]`,
    );
  }
}

/**
 * Sanitize a URL to prevent javascript: or malicious protocol execution.
 * Only allows http: and https: protocols.
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // If not a full URL, check if it's a relative path or github shorthand
    if (trimmed.startsWith("github.com/")) {
      return "https://" + trimmed;
    }
  }
  return "";
}

/**
 * HTML escape helper
 */
export function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
