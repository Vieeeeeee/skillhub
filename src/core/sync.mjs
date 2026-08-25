import {
  existsSync,
  readdirSync,
  rmdirSync,
  renameSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getPaths, getAgentDirs, isAgentVisible } from "./paths.mjs";
import { isSymlink, isBrokenLink, readLinkSafe, createLink, unlinkSafe } from "./link.mjs";
import { createBackupSession, recordOperation } from "./backup.mjs";
import { loadUserOverrides } from "./registry.mjs";
import {
  assertSafeName,
  assertSafePath,
  assertSafeRealPath,
  isInsideRoot,
} from "./guard.mjs";

const IGNORE_NAMES = new Set([
  "registry.json",
  "dist",
  ".system",
  ".backups",
  ".git",
  ".DS_Store",
]);

export function listDirectoryEntries(dirPath) {
  if (!existsSync(dirPath)) return [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => {
        const name = e.name;
        if (IGNORE_NAMES.has(name) || name.startsWith(".") || name.startsWith("_")) return false;
        return e.isDirectory() || e.isSymbolicLink();
      })
      .map((e) => ({
        name: e.name,
        path: join(dirPath, e.name),
        isSymlink: e.isSymbolicLink(),
        isDirectory: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

export function resolvesInto(targetPath, rootPath) {
  try {
    const realTarget = realpathSync(targetPath);
    const realRoot = realpathSync(rootPath);
    return isInsideRoot(realTarget, realRoot);
  } catch {
    return false;
  }
}

function getManagedSkillNames(ssotPath, containerNames = []) {
  const set = new Set();
  for (const containerName of containerNames) {
    try {
      assertSafeName(containerName, "managed Skill container");
      const containerDir = join(ssotPath, containerName);
      if (!existsSync(containerDir)) continue;
      const entries = readdirSync(containerDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          existsSync(join(containerDir, entry.name, "SKILL.md"))
        ) {
          set.add(entry.name);
        }
      }
    } catch {}
  }
  return set;
}

export function buildSyncPlan(customHome = null, { allowHarvest = false } = {}) {
  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  const overrides = loadUserOverrides(paths.OVERRIDES_FILE);
  const agentDisabled = overrides.agentDisabled || {};
  const agentSpecific = new Set(Object.keys(overrides.agentSpecificSkills || {}));
  const managedContainers = Array.isArray(overrides.managedSkillContainers)
    ? overrides.managedSkillContainers
    : [];

  const actions = [];
  const managedSkills = getManagedSkillNames(paths.SSOT, managedContainers);
  const ssotEntries = listDirectoryEntries(paths.SSOT);
  const ssotNames = new Set(ssotEntries.map((e) => e.name));

  // 1. Check broken links in SSOT
  for (const entry of ssotEntries) {
    if (entry.isSymlink && isBrokenLink(entry.path)) {
      actions.push({
        kind: "fix-broken-link",
        path: entry.path,
        skill: entry.name,
        target: readLinkSafe(entry.path),
        location: "ssot",
      });
    }
  }

  // 2. Check each link-based agent (Claude, Gemini, Hermes)
  for (const [agKey, agCfg] of Object.entries(agentDirs)) {
    if (agCfg.type !== "symlink") continue;
    // An Agent the user does not use is left alone entirely: no link proposals
    // and no reports about what sits in its directory.
    if (!isAgentVisible(agCfg, agKey, overrides)) continue;
    const agPath = agCfg.absPath;
    const disabledList = new Set(agentDisabled[agKey] || []);
    const entries = listDirectoryEntries(agPath);

    for (const entry of entries) {
      if (entry.isSymlink) {
        if (isBrokenLink(entry.path)) {
          actions.push({
            kind: "fix-broken-link",
            agent: agKey,
            path: entry.path,
            skill: entry.name,
            target: readLinkSafe(entry.path),
          });
        }
      } else if (entry.isDirectory) {
        // Real directory in agent folder. A name the SSOT already knows about is
        // maintained by whatever put it there (gstack keeps its own copies this
        // way), so it is not an unmanaged orphan.
        if (
          ssotNames.has(entry.name) ||
          managedSkills.has(entry.name) ||
          agentSpecific.has(entry.name)
        ) {
          continue;
        }
        const hasSkillMd = existsSync(join(entry.path, "SKILL.md"));
        if (!hasSkillMd) continue;

        if (allowHarvest) {
          actions.push({
            kind: "harvest",
            agent: agKey,
            path: entry.path,
            skill: entry.name,
            relink: [agKey],
          });
        } else {
          actions.push({
            kind: "report-agent-orphan",
            agent: agKey,
            path: entry.path,
            skill: entry.name,
            note: "Real directory in the agent folder, not managed in the SSOT. Move it into ~/.agents/skills to share it with other agents.",
          });
        }
      }
    }

    // Check missing links in agent folder for skills in SSOT
    for (const ssotSkill of ssotNames) {
      if (disabledList.has(ssotSkill)) continue;
      if (agentSpecific.has(ssotSkill)) continue;

      const agentSkillPath = join(agPath, ssotSkill);
      if (!existsSync(agentSkillPath) && !isSymlink(agentSkillPath)) {
        const ssotSkillDir = join(paths.SSOT, ssotSkill);
        if (existsSync(join(ssotSkillDir, "SKILL.md"))) {
          actions.push({
            kind: "link",
            agent: agKey,
            skill: ssotSkill,
            targetPath: ssotSkillDir,
            linkPath: agentSkillPath,
          });
        }
      }
    }
  }

  // 3. Check Codex redundant symlinks
  const codexSkillsDir = join(paths.HOME, ".codex", "skills");
  if (existsSync(codexSkillsDir)) {
    const codexEntries = listDirectoryEntries(codexSkillsDir);
    const claudePath = agentDirs.claude?.absPath || join(paths.HOME, ".claude", "skills");

    for (const entry of codexEntries) {
      if (!entry.isSymlink || isBrokenLink(entry.path)) continue;
      if (resolvesInto(entry.path, paths.AGENTS_ROOT)) {
        actions.push({
          kind: "prune-redundant-codex-link",
          path: entry.path,
          skill: entry.name,
          target: readLinkSafe(entry.path),
          note: "Points to SSOT. Codex natively scans SSOT.",
        });
      } else if (resolvesInto(entry.path, claudePath)) {
        actions.push({
          kind: "prune-redundant-codex-link",
          path: entry.path,
          skill: entry.name,
          target: readLinkSafe(entry.path),
          note: "Points to Claude skills. Codex natively scans SSOT.",
        });
      }
    }
  }

  // 4. Empty directories in SSOT
  for (const entry of ssotEntries) {
    if (entry.isDirectory && !entry.isSymlink) {
      const hasSkillMd = existsSync(join(entry.path, "SKILL.md"));
      const hasGit = existsSync(join(entry.path, ".git"));
      if (!hasSkillMd && !hasGit) {
        // A directory we cannot read is not a reason to fail the whole plan:
        // this function backs sync, doctor and two dashboard endpoints.
        let subFiles;
        try {
          subFiles = readdirSync(entry.path);
        } catch {
          continue;
        }
        if (subFiles.length === 0) {
          actions.push({
            kind: "remove-empty-dir",
            path: entry.path,
            skill: entry.name,
          });
        } else {
          actions.push({
            kind: "report-not-a-skill",
            path: entry.path,
            skill: entry.name,
          });
        }
      }
    }
  }

  return actions;
}

const MUTATING_KINDS = new Set([
  "link",
  "fix-broken-link",
  "prune-redundant-codex-link",
  "harvest",
  "remove-empty-dir",
]);

function actionKey(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("Invalid sync action");
  }
  if (!MUTATING_KINDS.has(action.kind)) {
    throw new Error(`Unsupported sync action: ${String(action.kind)}`);
  }
  assertSafeName(action.skill, "skill name");

  if (action.kind === "link" || action.kind === "harvest") {
    assertSafeName(action.agent, "agent key");
    return `${action.kind}|${action.agent}|${action.skill}`;
  }
  if (action.kind === "fix-broken-link") {
    if (action.location === "ssot") return `${action.kind}|ssot|${action.skill}`;
    assertSafeName(action.agent, "agent key");
    return `${action.kind}|${action.agent}|${action.skill}`;
  }
  return `${action.kind}|${action.skill}`;
}

function assertSameClientPaths(requested, canonical) {
  for (const field of ["path", "linkPath", "targetPath"]) {
    if (requested[field] === undefined) continue;
    if (typeof requested[field] !== "string" || canonical[field] === undefined) {
      throw new Error(`Invalid client-supplied ${field}`);
    }
    if (resolve(requested[field]) !== resolve(canonical[field])) {
      throw new Error(`Client-supplied ${field} does not match the current sync plan`);
    }
  }
}

function assertPhysicalHomePath(path, home, followFinalSymlink) {
  assertSafeRealPath(path, [home], { followFinalSymlink });
}

function validateCanonicalAction(action, paths, agentDirs) {
  const skill = action.skill;
  if (action.kind === "link") {
    const agent = agentDirs[action.agent];
    if (!agent || agent.type !== "symlink") throw new Error(`Unknown link-based agent: ${action.agent}`);
    const expectedTarget = join(paths.SSOT, skill);
    const expectedLink = join(agent.absPath, skill);
    if (resolve(action.targetPath) !== resolve(expectedTarget) || resolve(action.linkPath) !== resolve(expectedLink)) {
      throw new Error("Sync plan contains non-canonical link paths");
    }
    assertSafePath(action.targetPath, [paths.SSOT]);
    assertSafePath(action.linkPath, [agent.absPath]);
    assertPhysicalHomePath(action.targetPath, paths.HOME, true);
    assertPhysicalHomePath(action.linkPath, paths.HOME, false);
    if (!existsSync(join(action.targetPath, "SKILL.md"))) throw new Error(`Skill is missing SKILL.md: ${skill}`);
    if (existsSync(action.linkPath) || isSymlink(action.linkPath)) throw new Error(`Link path already exists: ${action.linkPath}`);
    return;
  }

  if (action.kind === "fix-broken-link") {
    const expectedRoot = action.location === "ssot"
      ? paths.SSOT
      : agentDirs[action.agent]?.absPath;
    if (!expectedRoot) throw new Error(`Unknown agent: ${action.agent}`);
    const expectedPath = join(expectedRoot, skill);
    if (resolve(action.path) !== resolve(expectedPath)) throw new Error("Sync plan contains a non-canonical broken-link path");
    assertSafePath(action.path, [expectedRoot]);
    assertPhysicalHomePath(action.path, paths.HOME, false);
    if (!isBrokenLink(action.path)) throw new Error(`Path is no longer a broken link: ${action.path}`);
    return;
  }

  if (action.kind === "prune-redundant-codex-link") {
    const codexRoot = join(paths.HOME, ".codex", "skills");
    const expectedPath = join(codexRoot, skill);
    if (resolve(action.path) !== resolve(expectedPath)) throw new Error("Sync plan contains a non-canonical Codex link path");
    assertSafePath(action.path, [codexRoot]);
    assertPhysicalHomePath(action.path, paths.HOME, false);
    const claudeRoot = agentDirs.claude?.absPath || join(paths.HOME, ".claude", "skills");
    if (!isSymlink(action.path) ||
        (!resolvesInto(action.path, paths.AGENTS_ROOT) && !resolvesInto(action.path, claudeRoot))) {
      throw new Error(`Path is no longer a redundant Codex link: ${action.path}`);
    }
    return;
  }

  if (action.kind === "harvest") {
    const agent = agentDirs[action.agent];
    if (!agent || agent.type !== "symlink") throw new Error(`Unknown link-based agent: ${action.agent}`);
    const expectedSource = join(agent.absPath, skill);
    if (resolve(action.path) !== resolve(expectedSource)) throw new Error("Sync plan contains a non-canonical harvest path");
    const destination = join(paths.SSOT, skill);
    assertSafePath(action.path, [agent.absPath]);
    assertSafePath(destination, [paths.SSOT]);
    assertPhysicalHomePath(action.path, paths.HOME, true);
    assertPhysicalHomePath(destination, paths.HOME, false);
    if (!existsSync(action.path) || isSymlink(action.path) || !existsSync(join(action.path, "SKILL.md"))) {
      throw new Error(`Harvest source is not a real Skill directory: ${action.path}`);
    }
    if (existsSync(destination) || isSymlink(destination)) throw new Error(`Harvest destination already exists: ${destination}`);
    return;
  }

  if (action.kind === "remove-empty-dir") {
    const expectedPath = join(paths.SSOT, skill);
    if (resolve(action.path) !== resolve(expectedPath)) throw new Error("Sync plan contains a non-canonical empty-directory path");
    assertSafePath(action.path, [paths.SSOT]);
    assertPhysicalHomePath(action.path, paths.HOME, true);
    if (!existsSync(action.path) || isSymlink(action.path) || !statSync(action.path).isDirectory()) {
      throw new Error(`Path is no longer a real directory: ${action.path}`);
    }
    if (readdirSync(action.path).length !== 0) throw new Error(`Directory is no longer empty: ${action.path}`);
  }
}

export function applySyncPlan(
  actions,
  customHome = null,
  { only = null, allowHarvest = false } = {},
) {
  if (!Array.isArray(actions)) throw new Error("Sync actions must be an array");
  if (only !== null && !Array.isArray(only)) throw new Error("Sync action filter must be an array");

  const paths = getPaths(customHome);
  const agentDirs = getAgentDirs(customHome);
  const onlySet = only ? new Set(only) : null;
  if (onlySet) {
    for (const kind of onlySet) {
      if (!MUTATING_KINDS.has(kind) || (kind === "harvest" && !allowHarvest)) {
        throw new Error(`Unsupported sync action filter: ${kind}`);
      }
    }
  }

  const authoritative = buildSyncPlan(customHome, { allowHarvest });
  const currentActions = new Map();
  for (const action of authoritative) {
    if (!MUTATING_KINDS.has(action.kind)) continue;
    currentActions.set(actionKey(action), action);
  }

  let session = null;
  const ensureSession = () => {
    session ||= createBackupSession(paths.BACKUPS_DIR, "sync-apply");
    return session;
  };
  const applied = [];
  const seen = new Set();

  for (const requested of actions) {
    if (onlySet && !onlySet.has(requested?.kind)) continue;

    try {
      if (requested?.kind === "harvest" && !allowHarvest) {
        throw new Error("Harvest is disabled for this sync operation");
      }
      const key = actionKey(requested);
      if (seen.has(key)) throw new Error("Duplicate sync action");
      seen.add(key);

      const action = currentActions.get(key);
      if (!action) throw new Error("Action is not present in the current authoritative sync plan");
      assertSameClientPaths(requested, action);
      validateCanonicalAction(action, paths, agentDirs);

      const backup = ensureSession();
      if (action.kind === "link") {
        createLink(action.targetPath, action.linkPath, { relative: true });
        recordOperation(backup, {
          type: "create-link",
          linkPath: action.linkPath,
          targetPath: action.targetPath,
          relative: true,
        });
      } else if (action.kind === "fix-broken-link" || action.kind === "prune-redundant-codex-link") {
        const prevTarget = readLinkSafe(action.path);
        unlinkSafe(action.path);
        recordOperation(backup, {
          type: "remove-link",
          linkPath: action.path,
          targetPath: prevTarget,
        });
      } else if (action.kind === "harvest") {
        const destination = join(paths.SSOT, action.skill);
        renameSync(action.path, destination);
        recordOperation(backup, { type: "move", src: action.path, dst: destination });

        const linkPath = join(agentDirs[action.agent].absPath, action.skill);
        createLink(destination, linkPath, { relative: true });
        recordOperation(backup, {
          type: "create-link",
          linkPath,
          targetPath: destination,
          relative: true,
        });
      } else if (action.kind === "remove-empty-dir") {
        const mode = statSync(action.path).mode;
        rmdirSync(action.path);
        recordOperation(backup, { type: "remove-empty-dir", path: action.path, mode });
      }
      applied.push({ ok: true, action });
    } catch (error) {
      applied.push({ ok: false, action: requested, error: error.message });
    }
  }

  return { sessionId: session?.manifest.sessionId || null, applied };
}
