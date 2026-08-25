import {
  existsSync,
  readdirSync,
  mkdirSync,
  renameSync,
  statSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { getPaths, getAgentDirs } from "./paths.mjs";
import { assertSafeName, assertSafeRealPath, isInsideRoot } from "./guard.mjs";
import { createLink, unlinkSafe, isSymlink, readLinkSafe, moveToTrash } from "./link.mjs";
import { createBackupSession, recordOperation, recordFileWrite } from "./backup.mjs";
import {
  loadUserOverrides,
  parseSkillMeta,
  saveUserOverrides,
  withOverridesLock,
} from "./registry.mjs";

const GIT_TIMEOUT_MS = 30_000;

// A blurb is one sentence about when to reach for the Skill, and a note is a
// reminder to yourself. Neither has a reason to be long, and both are read back
// into memory and re-serialised on every single scan.
const MAX_BLURB_CHARS = 500;
const MAX_NOTES_CHARS = 2_000;
const MAX_CATEGORY_CHARS = 60;
const MAX_REPOSITORY_BYTES = 100 * 1024 * 1024;
const MAX_REPOSITORY_ENTRIES = 10_000;

function assertManagedHomePath(path, paths, followFinalSymlink = true) {
  assertSafeRealPath(path, [paths.HOME], { followFinalSymlink });
}

function assertLinkPointsTo(linkPath, expectedTarget) {
  const rawTarget = readLinkSafe(linkPath);
  const actualTarget = rawTarget ? resolve(dirname(linkPath), rawTarget) : "";
  if (actualTarget !== resolve(expectedTarget)) {
    throw new Error(`Refusing to remove link at ${linkPath} because it points elsewhere`);
  }
  return rawTarget;
}

function assertWithinLength(value, limit, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error(`Invalid ${label}: expected text`);
  if (value.length > limit) {
    throw new Error(`${label} is too long: ${value.length} characters, limit is ${limit}`);
  }
}

function saveOverridesWithBackup(session, overridesFile, overrides) {
  const existedBefore = existsSync(overridesFile);
  const backupFile = existedBefore ? "overrides.before.json" : null;
  // A session joined by a later write already holds the pre-batch copy. Copying
  // again here would overwrite it with a mid-batch state, and undo would land
  // somewhere in the middle of the run instead of before it.
  const backupPath = backupFile ? join(session.sessionDir, backupFile) : null;
  if (backupPath && !existsSync(backupPath)) copyFileSync(overridesFile, backupPath);
  saveUserOverrides(overridesFile, overrides);
  recordFileWrite(session, {
    type: "write-file",
    targetFile: overridesFile,
    existedBefore,
    backupFile,
  });
}

export function toggleAgent(skillName, agentKey, enabled, customHome = null) {
  assertSafeName(skillName, "skill name");
  assertSafeName(agentKey, "agent key");

  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  const agCfg = agentDirs[agentKey];

  if (!agCfg) {
    throw new Error(`Unknown agent: "${agentKey}"`);
  }
  if (agCfg.type !== "symlink") {
    throw new Error(`Agent "${agentKey}" uses native discovery and cannot be toggled by SkillHub`);
  }

  const skillInSSOT = join(paths.SSOT, skillName);
  const linkPath = join(agCfg.absPath, skillName);

  assertManagedHomePath(skillInSSOT, paths, true);
  assertManagedHomePath(linkPath, paths, false);
  assertManagedHomePath(paths.OVERRIDES_FILE, paths, false);

  if (!existsSync(skillInSSOT) || !existsSync(join(skillInSSOT, "SKILL.md"))) {
    throw new Error(`Skill "${skillName}" not found or missing its root SKILL.md at ${skillInSSOT}`);
  }

  // A real directory in the Agent folder belongs to whatever put it there —
  // some tools keep their own copies and upgrade them themselves. SkillHub
  // never deletes it, but it must not report the Skill as disabled either: the
  // Agent goes on reading that directory regardless of what we record.
  if (!enabled && !isSymlink(linkPath) && existsSync(linkPath)) {
    throw new Error(
      `Cannot disable "${skillName}" for "${agentKey}": ${linkPath} is a real directory, not a link SkillHub created. ` +
        `Whatever manages that copy still owns it — remove or reconfigure it there.`
    );
  }

  return withOverridesLock(paths.OVERRIDES_FILE, () => {
  const overrides = loadUserOverrides(paths.OVERRIDES_FILE);
  overrides.agentDisabled ||= {};
  overrides.agentDisabled[agentKey] ||= [];
  const disabledSet = new Set(overrides.agentDisabled[agentKey]);

  const session = createBackupSession(paths.BACKUPS_DIR, `toggle-${agentKey}-${skillName}`);

  if (enabled) {
    disabledSet.delete(skillName);
    if (isSymlink(linkPath)) {
      const currentTarget = readLinkSafe(linkPath);
      const absoluteTarget = currentTarget ? resolve(dirname(linkPath), currentTarget) : "";
      if (absoluteTarget !== resolve(skillInSSOT)) {
        throw new Error(`Refusing to replace an existing link at ${linkPath} that points elsewhere`);
      }
    } else {
      createLink(skillInSSOT, linkPath, { relative: true });
      recordOperation(session, {
        type: "create-link",
        linkPath,
        targetPath: skillInSSOT,
        relative: true,
      });
    }
  } else {
    disabledSet.add(skillName);
    if (isSymlink(linkPath)) {
      const prevTarget = assertLinkPointsTo(linkPath, skillInSSOT);
      unlinkSafe(linkPath);
      recordOperation(session, {
        type: "remove-link",
        linkPath,
        targetPath: prevTarget,
      });
    }
  }

  overrides.agentDisabled[agentKey] = [...disabledSet].sort();
  saveOverridesWithBackup(session, paths.OVERRIDES_FILE, overrides);

  return { ok: true, skill: skillName, agent: agentKey, enabled, sessionId: session.manifest.sessionId };
  });
}

/**
 * Record whether an Agent is in use. This only changes what SkillHub shows and
 * what it proposes to sync; existing links are never removed, so turning an
 * Agent back on restores exactly what was there before.
 */
export function setAgentVisibility(agentKey, visible, customHome = null) {
  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  if (!agentDirs[agentKey]) throw new Error(`Unknown agent: "${agentKey}"`);
  assertManagedHomePath(paths.OVERRIDES_FILE, paths, false);

  return withOverridesLock(paths.OVERRIDES_FILE, () => {
    const overrides = loadUserOverrides(paths.OVERRIDES_FILE);
    const session = createBackupSession(paths.BACKUPS_DIR, `agent-visibility-${agentKey}`);
    overrides.agentVisibility ||= {};
    overrides.agentVisibility[agentKey] = Boolean(visible);
    saveOverridesWithBackup(session, paths.OVERRIDES_FILE, overrides);
    return {
      ok: true,
      agent: agentKey,
      visible: Boolean(visible),
      sessionId: session.manifest.sessionId,
    };
  });
}

export function setMetadataOverride(skillName, { zh, notes, category }, customHome = null) {
  assertSafeName(skillName, "skill name");
  const paths = getPaths(customHome);
  const skillPath = join(paths.SSOT, skillName);
  assertManagedHomePath(skillPath, paths, true);
  assertManagedHomePath(paths.OVERRIDES_FILE, paths, false);
  if (!existsSync(skillPath) || !existsSync(join(skillPath, "SKILL.md"))) {
    throw new Error(`Skill "${skillName}" not found or missing its root SKILL.md at ${skillPath}`);
  }
  assertWithinLength(zh, MAX_BLURB_CHARS, "Chinese blurb");
  assertWithinLength(notes, MAX_NOTES_CHARS, "note");
  assertWithinLength(category, MAX_CATEGORY_CHARS, "category name");

  return withOverridesLock(paths.OVERRIDES_FILE, () => {
    const overrides = loadUserOverrides(paths.OVERRIDES_FILE);
    // Writing a blurb touches one JSON file and nothing else, so a run of them
    // shares one session: one undo puts the file back to before the run.
    const session = createBackupSession(paths.BACKUPS_DIR, `metadata-${skillName}`, {
      coalesceWith: "metadata-",
    });

    if (zh !== undefined) {
      overrides.zhOverrides ||= {};
      if (zh) overrides.zhOverrides[skillName] = zh;
      else delete overrides.zhOverrides[skillName];
    }

    if (notes !== undefined) {
      overrides.notesOverrides ||= {};
      if (notes) overrides.notesOverrides[skillName] = notes;
      else delete overrides.notesOverrides[skillName];
    }

    if (category !== undefined) {
      overrides.categoryOverrides ||= {};
      if (category) overrides.categoryOverrides[skillName] = category;
      else delete overrides.categoryOverrides[skillName];
    }

    saveOverridesWithBackup(session, paths.OVERRIDES_FILE, overrides);
    return { ok: true, sessionId: session.manifest.sessionId };
  });
}

export function addSkillFromGit(gitUrl, { name: customName = null } = {}, customHome = null) {
  const paths = getPaths(customHome);
  const parsedUrl = validateGitUrl(gitUrl);
  const url = parsedUrl.toString();

  let repoName = customName;
  if (!repoName) {
    repoName = parsedUrl.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "");
  }
  if (!repoName) throw new Error("Unable to determine a local skill name from the repository URL");
  assertSafeName(repoName, "local name");

  const destPath = join(paths.SSOT, repoName);
  assertManagedHomePath(paths.SSOT, paths, true);
  assertManagedHomePath(destPath, paths, false);
  if (existsSync(destPath)) {
    throw new Error(`Skill "${repoName}" already exists at ${destPath}`);
  }

  mkdirSync(paths.SSOT, { recursive: true });
  assertManagedHomePath(paths.SSOT, paths, true);
  const stagingRoot = mkdtempSync(join(paths.SSOT, ".skillhub-install-"));
  const stagedRepo = join(stagingRoot, "repo");

  try {
    execFileSync(
      "git",
      [
        "-c", "credential.helper=",
        "-c", "core.askPass=",
        "-c", "http.extraHeader=",
        "clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:none", url, stagedRepo,
      ],
      {
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      }
    );

    validateStagedSkill(stagedRepo);
    assertRepositoryWithinLimits(stagedRepo);
    renameSync(stagedRepo, destPath);
    return { ok: true, name: repoName, path: destPath, source: url };
  } catch (error) {
    const reason = error?.code === "ETIMEDOUT" ? "Git clone timed out" : error?.message || String(error);
    throw new Error(`Unable to install Skill: ${reason}`);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function validateGitUrl(gitUrl) {
  if (!gitUrl || typeof gitUrl !== "string") {
    throw new Error("gitUrl is required");
  }

  let parsed;
  try {
    parsed = new URL(gitUrl.trim());
  } catch {
    throw new Error("Git URL must be a full HTTPS GitHub repository URL");
  }

  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only HTTPS repositories hosted on github.com are supported");
  }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error("Git URL must not contain credentials, a custom port, query parameters, or a fragment");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const validSegment = /^[A-Za-z0-9._-]+$/;
  if (
    parts.length !== 2 ||
    parts.some((part) => !validSegment.test(part) || part === "." || part === "..") ||
    parts[1].replace(/\.git$/i, "") === ""
  ) {
    throw new Error("Git URL must point to a repository root, for example https://github.com/owner/repo.git");
  }
  parsed.pathname = `/${parts[0]}/${parts[1]}`;
  return parsed;
}

export function validateStagedSkill(stagedRepo) {
  const rootSkill = join(stagedRepo, "SKILL.md");
  if (existsSync(rootSkill) && lstatSync(rootSkill).isFile()) {
    const meta = parseSkillMeta(stagedRepo);
    if (!meta.hasName || !meta.hasDescription) {
      throw new Error("Root SKILL.md must contain frontmatter name and description fields");
    }
    return;
  }

  const nestedSkills = [];
  const queue = [{ path: stagedRepo, depth: 0 }];
  while (queue.length && nestedSkills.length < 6) {
    const current = queue.shift();
    if (current.depth >= 3) continue;
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const full = join(current.path, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") nestedSkills.push(relative(stagedRepo, full));
      if (entry.isDirectory()) queue.push({ path: full, depth: current.depth + 1 });
    }
  }

  if (nestedSkills.length) {
    throw new Error(
      `Repository has no root SKILL.md and appears to be a multi-Skill bundle (${nestedSkills.slice(0, 5).join(", ")}). Install individual Skills instead.`
    );
  }
  throw new Error("Repository root must contain a regular SKILL.md file");
}

function assertRepositoryWithinLimits(root) {
  const queue = [root];
  let entries = 0;
  let bytes = 0;

  while (queue.length) {
    const dir = queue.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      entries += 1;
      bytes += stat.size;
      if (entries > MAX_REPOSITORY_ENTRIES || bytes > MAX_REPOSITORY_BYTES) {
        throw new Error("Repository exceeds the installation limit (10,000 entries or 100 MB)");
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(full);
    }
  }
}

export function updateSkill(skillName, customHome = null) {
  assertSafeName(skillName, "skill name");
  const paths = getPaths(customHome);
  const skillPath = join(paths.SSOT, skillName);

  assertManagedHomePath(skillPath, paths, true);

  if (!existsSync(skillPath)) {
    throw new Error(`Skill "${skillName}" not found at ${skillPath}`);
  }

  const targetGitDir = resolveUpdateTarget(skillPath, paths);
  assertManagedHomePath(targetGitDir, paths, true);

  if (!existsSync(join(targetGitDir, ".git"))) {
    throw new Error(`"${skillName}" is not a git repository and cannot be updated via git.`);
  }

  const out = execFileSync("git", ["-C", targetGitDir, "pull", "--ff-only"], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });

  return { ok: true, output: out.trim(), repositoryPath: targetGitDir };
}

export function resolveUpdateTarget(skillPath, paths) {
  if (!isSymlink(skillPath)) return skillPath;

  const rawTarget = readLinkSafe(skillPath);
  if (!rawTarget) throw new Error(`Unable to resolve Skill link at ${skillPath}`);
  const absoluteTarget = resolve(dirname(skillPath), rawTarget);

  if (!isInsideRoot(absoluteTarget, paths.REPOS)) {
    throw new Error("Linked Skills can only be updated when they belong to a managed bundle in _repos");
  }

  const relativeTarget = relative(paths.REPOS, absoluteTarget);
  const bundle = relativeTarget.split(sep)[0];
  assertSafeName(bundle, "bundle name");
  return join(paths.REPOS, bundle);
}

// Uninstalling always goes through the trash. There used to be a `deleteData`
// option threaded all the way from a query parameter to here and then never
// read, which read as if a hard-delete path existed somewhere.
export function removeSkill(skillName, options = {}, customHome = null) {
  assertSafeName(skillName, "skill name");
  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  const skillPath = join(paths.SSOT, skillName);

  if (!existsSync(skillPath) && !isSymlink(skillPath)) {
    throw new Error(`Skill "${skillName}" is not a canonical SSOT entry and cannot be removed by SkillHub`);
  }
  assertManagedHomePath(skillPath, paths, !isSymlink(skillPath));
  assertManagedHomePath(paths.TRASH, paths, true);

  const managedAgentLinks = [];
  for (const agCfg of Object.values(agentDirs)) {
    if (agCfg.type !== "symlink") continue;
    const linkPath = join(agCfg.absPath, skillName);
    if (!isSymlink(linkPath)) continue;
    assertManagedHomePath(linkPath, paths, false);
    const prevTarget = assertLinkPointsTo(linkPath, skillPath);
    managedAgentLinks.push({ linkPath, prevTarget });
  }

  const session = createBackupSession(paths.BACKUPS_DIR, `remove-${skillName}`);

  // 1. Remove agent symlinks
  for (const { linkPath, prevTarget } of managedAgentLinks) {
    unlinkSafe(linkPath);
    recordOperation(session, {
      type: "remove-link",
      linkPath,
      targetPath: prevTarget,
    });
  }

  // 2. Remove / Trash SSOT entry
  if (isSymlink(skillPath)) {
    const prevTarget = readLinkSafe(skillPath);
    unlinkSafe(skillPath);
    recordOperation(session, {
      type: "remove-link",
      linkPath: skillPath,
      targetPath: prevTarget,
    });
  } else if (existsSync(skillPath)) {
    // Real directory: move to trash
    const trashRes = moveToTrash(skillPath, paths.TRASH);
    recordOperation(session, {
      type: "move",
      src: skillPath,
      dst: trashRes.destination,
    });
  }

  return { ok: true, skill: skillName };
}

export function removeBundle(bundleName, customHome = null) {
  assertSafeName(bundleName, "bundle name");
  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  const bundleDir = join(paths.REPOS, bundleName);

  if (!existsSync(bundleDir) || isSymlink(bundleDir)) {
    throw new Error(`Bundle "${bundleName}" is not a managed repository directory`);
  }
  assertManagedHomePath(paths.SSOT, paths, true);
  assertManagedHomePath(bundleDir, paths, true);
  assertManagedHomePath(paths.TRASH, paths, true);

  const bundleSkills = [];
  if (existsSync(paths.SSOT)) {
    for (const e of readdirSync(paths.SSOT, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      const full = join(paths.SSOT, e.name);
      const target = readLinkSafe(full) || "";
      const absoluteTarget = target ? resolve(dirname(full), target) : "";
      if (!absoluteTarget || !isInsideRoot(absoluteTarget, bundleDir)) continue;

      const agentLinks = [];
      for (const agCfg of Object.values(agentDirs)) {
        if (agCfg.type !== "symlink") continue;
        const agLink = join(agCfg.absPath, e.name);
        if (!isSymlink(agLink)) continue;
        assertManagedHomePath(agLink, paths, false);
        const agTarget = assertLinkPointsTo(agLink, full);
        agentLinks.push({ agLink, agTarget });
      }
      bundleSkills.push({ full, target, agentLinks });
    }
  }

  const session = createBackupSession(paths.BACKUPS_DIR, `remove-bundle-${bundleName}`);

  // Remove only links that were preflighted to point to this bundle.
  for (const { full, target, agentLinks } of bundleSkills) {
    for (const { agLink, agTarget } of agentLinks) {
      unlinkSafe(agLink);
      recordOperation(session, {
        type: "remove-link",
        linkPath: agLink,
        targetPath: agTarget,
      });
    }
    unlinkSafe(full);
    recordOperation(session, {
      type: "remove-link",
      linkPath: full,
      targetPath: target,
    });
  }

  // Move bundle directory to trash
  if (existsSync(bundleDir)) {
    const trashRes = moveToTrash(bundleDir, paths.TRASH);
    recordOperation(session, {
      type: "move",
      src: bundleDir,
      dst: trashRes.destination,
    });
  }

  return { ok: true, bundle: bundleName };
}

export function listTrash(customHome = null) {
  const paths = getPaths(customHome);
  if (!existsSync(paths.TRASH)) return [];
  assertManagedHomePath(paths.TRASH, paths, true);

  try {
    const entries = readdirSync(paths.TRASH, { withFileTypes: true });
    return entries.map((e) => {
      const full = join(paths.TRASH, e.name);
      const stat = statSync(full);
      return {
        name: e.name,
        entry: e.name,
        isDir: e.isDirectory(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    });
  } catch {
    return [];
  }
}

export function restoreTrash(entryName, customHome = null) {
  assertSafeName(entryName, "trash entry");
  const paths = getPaths(customHome);
  const trashPath = join(paths.TRASH, entryName);

  assertManagedHomePath(paths.TRASH, paths, true);
  assertManagedHomePath(paths.SSOT, paths, true);
  assertManagedHomePath(trashPath, paths, true);

  if (!existsSync(trashPath)) {
    throw new Error(`Trash entry "${entryName}" does not exist`);
  }

  // Extract original name by stripping the timestamp suffix
  const originalName = entryName.replace(/\.\d{4}-\d{2}-\d{2}T[\d-]+Z?$/, "");
  assertSafeName(originalName, "original name");

  const destPath = join(paths.SSOT, originalName);
  assertManagedHomePath(destPath, paths, false);
  if (existsSync(destPath)) {
    throw new Error(`Cannot restore: destination "${originalName}" already exists in SSOT`);
  }

  renameSync(trashPath, destPath);
  return { ok: true, restored: originalName, from: entryName };
}
