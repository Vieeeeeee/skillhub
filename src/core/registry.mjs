import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, resolve, dirname, basename, isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getPaths, getAgentDirs, RULES_DIR, isAgentVisible } from "./paths.mjs";
import { classifySkill, loadCategoriesConfig } from "./classify.mjs";
import { isSymlink, readLinkSafe } from "./link.mjs";
import { assertSafeName, assertSafeRealPath, isInsideRoot } from "./guard.mjs";

const UNCLASSIFIED_CATEGORY = "其他 / 未分类";

let _knownSourcesCache = null;

export function loadKnownSources() {
  if (_knownSourcesCache) return _knownSourcesCache;
  const file = join(RULES_DIR, "known-sources.json");
  if (existsSync(file)) {
    try {
      _knownSourcesCache = JSON.parse(readFileSync(file, "utf-8"));
      return _knownSourcesCache;
    } catch {}
  }
  return { verifiedSources: {}, inferredSources: {}, acceptedAliases: {} };
}

export function loadUserOverrides(overridesFile) {
  if (existsSync(overridesFile)) {
    try {
      const parsed = JSON.parse(readFileSync(overridesFile, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root value must be a JSON object");
      }
      return parsed;
    } catch (error) {
      // This file holds the hand-written blurbs, categories and Agent choices.
      // Refusing to read a damaged one is right — silently starting over would
      // throw that work away — but the message has to say how to get unstuck.
      throw new Error(
        `Cannot read ${overridesFile}: ${error.message}\n` +
          `That file holds your Chinese blurbs, categories and Agent choices. ` +
          `Fix the JSON, or move it aside to start over (the blurbs are lost, nothing else is).`
      );
    }
  }
  return {};
}

export function saveUserOverrides(overridesFile, overrides) {
  writeJsonAtomic(overridesFile, overrides);
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialises one read-modify-write cycle on the override file.
 *
 * Every writer loads the whole object, changes one corner of it, and writes it
 * back. Two of them at once — an agent filling in Chinese blurbs one command
 * per Skill, say — used to overwrite each other's edits while both reported
 * success. `mkdir` is atomic on every platform this runs on, which is all the
 * mutual exclusion this needs.
 */
export function withOverridesLock(overridesFile, fn) {
  const lockPath = `${overridesFile}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A process killed mid-write leaves the directory behind. Reclaim it once
      // it is clearly older than any real operation would take.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${lockPath}. Another SkillHub write is still running; retry in a moment.`
        );
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {}
  }
}

function writeJsonAtomic(file, value) {
  const dir = dirname(file);
  const tempFile = join(dir, `.skillhub-write-${process.pid}-${randomUUID()}.tmp`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    writeFileSync(tempFile, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tempFile, file);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {}
    throw error;
  }
}

export function parseSkillMeta(skillDir) {
  const skillMdPath = join(skillDir, "SKILL.md");
  const result = {
    hasSkillMd: false,
    tooLarge: false,
    hasName: false,
    hasDescription: false,
    fmName: "",
    description: "",
    version: "",
    lineCount: 0,
  };

  if (!existsSync(skillMdPath)) {
    return result;
  }

  result.hasSkillMd = true;
  let text = "";
  try {
    // Bailing out silently left hasSkillMd true with an empty name and
    // description, so a perfectly good but very large SKILL.md collected two
    // Tier A findings for fields that were never actually read.
    if (statSync(skillMdPath).size > 1024 * 1024) {
      result.tooLarge = true;
      return result;
    }
    text = readFileSync(skillMdPath, "utf-8");
  } catch {
    return result;
  }

  const lines = text.split(/\r?\n/);
  result.lineCount = lines.length;

  if (lines.length === 0 || lines[0].trim() !== "---") {
    return result;
  }

  let key = null;
  let buf = [];
  let desc = "";
  let fmName = "";
  let version = "";

  const flush = () => {
    if (key === "description" && buf.length > 0) {
      let joined = buf.filter(Boolean).join(" ").trim();
      joined = joined.replace(/^["']|["']$/g, "");
      joined = joined.replace(/^[>|][+-]?\s*/, "");
      if (joined && !desc) {
        desc = joined;
      }
    }
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      break;
    }

    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      flush();
      key = match[1];
      const val = match[2].trim();
      buf = [val];
      if (key === "name") {
        fmName = val.replace(/^["']|["']$/g, "");
      } else if (key === "version") {
        version = val.replace(/^["']|["']$/g, "");
      }
    } else if (key && (line.startsWith("  ") || line.startsWith("\t") || !line.trim())) {
      buf.push(line.trim());
    }
  }
  flush();

  if (desc.length > 400) {
    desc = desc.slice(0, 397) + "...";
  }

  result.fmName = fmName;
  result.hasName = Boolean(fmName);
  result.description = desc;
  result.hasDescription = Boolean(desc);
  result.version = version;

  return result;
}

export function findGitRoot(startPath) {
  try {
    let current = resolve(realpathSync(startPath));
    while (current && current !== dirname(current)) {
      if (existsSync(join(current, ".git"))) {
        return current;
      }
      current = dirname(current);
    }
  } catch {}
  return null;
}

export function getGitInfo(path) {
  if (!path || !existsSync(path)) return { origin: "", commit: "" };
  try {
    const origin = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    const commit = execFileSync("git", ["-C", path, "log", "-1", "--format=%h %ci"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return { origin, commit };
  } catch {
    return { origin: "", commit: "" };
  }
}

export function getClawHubInfo(entryPath) {
  try {
    const real = realpathSync(entryPath);
    const originFile = join(real, ".clawhub", "origin.json");
    if (existsSync(originFile)) {
      const d = JSON.parse(readFileSync(originFile, "utf-8"));
      return {
        origin: `clawhub:${d.slug || ""}`,
        version: String(d.installedVersion || ""),
      };
    }
  } catch {}
  return { origin: "", version: "" };
}

function isChinese(text) {
  if (!text) return false;
  return /[\u4e00-\u9fa5]/.test(text);
}

export function buildRegistry(customHome = null) {
  const paths = getPaths(customHome);
  assertSafeRealPath(paths.SKILLHUB_DIR, [paths.HOME], { followFinalSymlink: true });
  assertSafeRealPath(paths.SSOT, [paths.HOME], { followFinalSymlink: true });
  const agentDirs = getAgentDirs(customHome);
  const known = loadKnownSources();
  const overrides = loadUserOverrides(paths.OVERRIDES_FILE);

  const verifiedSources = { ...known.verifiedSources, ...(overrides.verifiedSources || {}) };
  const inferredSources = { ...known.inferredSources, ...(overrides.inferredSources || {}) };
  const acceptedAliases = { ...known.acceptedAliases, ...(overrides.acceptedAliases || {}) };
  const localCanonical = new Set([...(overrides.localCanonical || [])]);
  const zhOverrides = overrides.zhOverrides || {};
  const notesOverrides = overrides.notesOverrides || {};
  const categoryOverrides = overrides.categoryOverrides || {};
  const managedSkills = overrides.managedSkills || {};

  // Read previous registry to preserve transient fields (notes, etc.)
  let prevSkills = {};
  if (existsSync(paths.REGISTRY_FILE)) {
    try {
      prevSkills = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8")).skills || {};
    } catch {}
  }

  // Ensure directories exist
  mkdirSync(paths.SSOT, { recursive: true });
  mkdirSync(paths.SKILLHUB_DIR, { recursive: true });

  const skills = {};

  const addSkillEntry = (name, entryPath, { agentSpecific = null, agentOnly = null } = {}) => {
    const prev = prevSkills[name] || {};
    const symlink = isSymlink(entryPath);
    let stype = "local";
    let bundle = "";
    let origin = "";
    let commit = "";

    if (symlink) {
      stype = "symlink";
      const target = readLinkSafe(entryPath) || "";
      const absoluteTarget = target ? resolve(dirname(entryPath), target) : "";
      if (absoluteTarget && isInsideRoot(absoluteTarget, paths.REPOS)) {
        const relativeTarget = relative(paths.REPOS, absoluteTarget);
        const candidateBundle = relativeTarget.split(sep)[0];
        if (candidateBundle && candidateBundle !== "." && candidateBundle !== "..") {
          stype = "bundle-symlink";
          bundle = candidateBundle;
          const bundleDir = join(paths.REPOS, bundle);
          const info = getGitInfo(bundleDir);
          origin = info.origin;
          commit = info.commit;
        }
      } else {
        const groot = findGitRoot(entryPath);
        if (groot) {
          const info = getGitInfo(groot);
          origin = info.origin;
          commit = info.commit;
        }
      }
    } else if (existsSync(join(entryPath, ".git"))) {
      stype = "git";
      const info = getGitInfo(entryPath);
      origin = info.origin;
      commit = info.commit;
    } else {
      stype = "local";
      const groot = findGitRoot(entryPath);
      if (groot) {
        const info = getGitInfo(groot);
        origin = info.origin;
        commit = info.commit;
      }
    }

    if (!origin) {
      const ch = getClawHubInfo(entryPath);
      if (ch.origin) origin = ch.origin;
    }

    // Whether the real content sits inside the home SkillHub manages. Reads
    // follow the link out; every write refuses to. Recording it here lets the
    // health report say so instead of leaving the user to hit a path guard.
    let outsideManagedHome = false;
    let realPath = "";
    try {
      realPath = realpathSync(entryPath);
      outsideManagedHome = !isInsideRoot(realPath, paths.HOME);
    } catch {}

    const meta = parseSkillMeta(entryPath);
    const desc = meta.description;
    const fmName = meta.fmName;

    // The override file is the only store for a hand-written blurb, so it is
    // also the only thing consulted here. Carrying the previous registry value
    // forward made an erased blurb come back on the next scan while the command
    // that erased it still reported success.
    let zh = "";
    if (zhOverrides[name]) {
      zh = zhOverrides[name];
    } else if (isChinese(desc)) {
      zh = desc.slice(0, 140);
    }

    // Determine agent visibility. An Agent the user turned off is left out
    // entirely: the sync planner already ignored it, so leaving it in here made
    // `scan` and the dashboard disagree about whether the switch did anything.
    const agents = {};
    for (const [agKey, agCfg] of Object.entries(agentDirs)) {
      if (!isAgentVisible(agCfg, agKey, overrides)) continue;
      if (agCfg.type === "symlink") {
        // existsSync already follows the link, so a broken one answers false.
        // Accepting isSymlink here reported a dangling link as "this Agent can
        // see it" while the sync plan called the same link broken.
        const targetAgentPath = join(agCfg.absPath, name);
        agents[agKey] = existsSync(targetAgentPath);
      } else if (agCfg.type === "native") {
        agents[agKey] = true;
      }
    }

    if (agentOnly) {
      // Exactly one Agent can read this, because the body sits in that Agent's
      // own folder. The native-agent branch below would otherwise claim Codex
      // sees a directory that lives under ~/.claude/skills.
      for (const [agKey, agCfg] of Object.entries(agentDirs)) {
        if (!isAgentVisible(agCfg, agKey, overrides)) continue;
        agents[agKey] = false;
      }
      agents[agentOnly] = true;
    } else if (agentSpecific) {
      for (const [agentKey, variantPath] of Object.entries(agentSpecific)) {
        agents[agentKey] = existsSync(variantPath);
      }
    } else {
      // Codex natively scans SSOT
      for (const [agKey, agCfg] of Object.entries(agentDirs)) {
        if (agCfg.type === "native") agents[agKey] = true;
      }
    }

    // A second name for one Skill is an alias, not a mismatch. Upstream bundles
    // ship these deliberately — gstack links open-gstack-browser a second time
    // as connect-chrome — and the real directory is named after the frontmatter
    // exactly as it should be. Calling that broken sent the user to edit a file
    // that gets overwritten on the next upstream update.
    // An alias needs all three: the entry goes by another name, it is reached
    // through a link, and the real directory is named after its own frontmatter.
    // Without the first condition this matches almost every ordinary Skill,
    // whose directory is of course named after its frontmatter.
    const isAliasLink =
      Boolean(fmName) && fmName !== name && Boolean(realPath) && basename(realPath) === fmName;
    const hasNameMismatch =
      Boolean(fmName) && fmName !== name && acceptedAliases[name] !== fmName && !isAliasLink;

    skills[name] = {
      type: agentOnly ? "agent-only" : agentSpecific ? "agent-specific" : stype,
      // Which Agent's folder holds the body. SkillHub does not manage it: every
      // write refuses, and the sync plan proposes nothing for it.
      ...(agentOnly ? { agentOnly } : {}),
      path: entryPath,
      bundle,
      origin,
      commit,
      fmName,
      nameMismatch: hasNameMismatch,
      managed: typeof managedSkills[name] === "string" ? managedSkills[name] : "",
      verifiedSource: verifiedSources[name] || "",
      inferredSource: inferredSources[name] || "",
      localCanonical: localCanonical.has(name),
      outsideManagedHome,
      // Only when it differs. For a real directory it repeats `path` verbatim,
      // which is over half the library paying for a field that says nothing.
      ...(realPath && realPath !== entryPath ? { realPath } : {}),
      ...(isAliasLink ? { aliasOf: fmName } : {}),
      // No hasUpdate / latestUpstream / lastChecked here: nothing ever queried
      // an upstream, so the dashboard spent six components reporting "all up to
      // date" from a field that was only ever copied forward as false. SkillHub
      // does not check for upstream versions; `update` performs a fast-forward
      // pull on demand and that is the whole of it.
      // The blurb the user wrote by hand is the most accurate description this
      // Skill has. Leaving it out of the haystack meant a full round of writing
      // blurbs — one of the two main jobs here — did nothing at all for
      // categorisation, the other one. The rules already carry Chinese keywords
      // and match CJK by substring, so this needs no new machinery.
      category: classifySkill(name, [desc, zh].filter(Boolean).join(" "), categoryOverrides),
      description: desc,
      zh,
      notes: notesOverrides[name] ?? prev.notes ?? "",
      hasSkillMd: meta.hasSkillMd,
      tooLarge: meta.tooLarge,
      hasName: meta.hasName,
      hasDescription: meta.hasDescription,
      lineCount: meta.lineCount,
      agents,
      // Codex triggers on the frontmatter name, the link-based Agents on the
      // directory name. That follows from the Agent's discovery model, not from
      // its key, so it is read off the type.
      triggers: Object.fromEntries(
        Object.entries(agentDirs)
          .filter(([agentKey, cfg]) => isAgentVisible(cfg, agentKey, overrides))
          // An Agent that cannot read the Skill has no trigger word for it.
          // Listing one told the user to type a command that does nothing.
          .filter(([agentKey]) => !agentOnly || agentKey === agentOnly)
          .map(([agentKey, cfg]) => [
            agentKey,
            `${cfg.triggerPrefix || "/"}${cfg.type === "native" ? fmName || name : name}`,
          ])
      ),
    };
  };

  // Scan SSOT directory
  if (existsSync(paths.SSOT)) {
    const entries = readdirSync(paths.SSOT, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") || name.startsWith("_") || name === "registry.json") continue;
      if (name.includes(".pre-import-")) continue;

      const fullPath = join(paths.SSOT, name);
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      // A dangling link used to be dropped here, so the dashboard listed
      // nothing at all and only the health report knew it existed.
      if (entry.isSymbolicLink() && !existsSync(fullPath)) {
        skills[name] = {
          type: "broken-symlink",
          broken: true,
          path: fullPath,
          target: readLinkSafe(fullPath) || "",
          category: UNCLASSIFIED_CATEGORY,
          description: "",
          zh: "",
          notes: "",
          agents: {},
          triggers: {},
        };
        continue;
      }

      addSkillEntry(name, fullPath);
    }
  }

  // Optional user-configured skills that intentionally differ per agent.
  for (const [name, configuredVariants] of Object.entries(overrides.agentSpecificSkills || {})) {
    if (skills[name]) continue;
    try {
      assertSafeName(name, "agent-specific skill name");
    } catch {
      continue;
    }
    if (!configuredVariants || typeof configuredVariants !== "object" || Array.isArray(configuredVariants)) continue;

    const variants = {};
    for (const [agentKey, configuredPath] of Object.entries(configuredVariants)) {
      if (typeof configuredPath !== "string" || !configuredPath.trim()) continue;
      const candidate = isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(paths.HOME, ...configuredPath.split(/[/\\]+/));
      if (isInsideRoot(candidate, paths.HOME)) variants[agentKey] = candidate;
    }
    const firstExisting = Object.values(variants).find((candidate) => existsSync(candidate));
    if (firstExisting) addSkillEntry(name, firstExisting, { agentSpecific: variants });
  }

  // Skills that only exist inside an Agent's own folder. Codex's bundled Skill
  // Creator installs into ~/.codex/skills, and a Skill made there is real, is
  // loadable, and is the user's — it just cannot be shared. An inventory that
  // calls itself complete has to show it, marked for what it is, rather than
  // mentioning it only in the health report.
  for (const [agentKey, agCfg] of Object.entries(agentDirs)) {
    if (!isAgentVisible(agCfg, agentKey, overrides)) continue;
    for (const dir of [agCfg.absPath, agCfg.secondaryAbsPath]) {
      // The native Agent's primary directory is the SSOT itself.
      if (!dir || dir === paths.SSOT || !existsSync(dir)) continue;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith(".") || name.startsWith("_")) continue;
        if (skills[name]) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const fullPath = join(dir, name);
        if (!existsSync(join(fullPath, "SKILL.md"))) continue;
        // A copy under a name some other tool maintains is not ours to list
        // twice; that rule already governs the sync plan.
        if (managedSkills[name]) continue;
        addSkillEntry(name, fullPath, { agentOnly: agentKey });
      }
    }
  }

  // Build categories map
  const categories = {};
  for (const [name, info] of Object.entries(skills)) {
    if (!categories[info.category]) {
      categories[info.category] = [];
    }
    categories[info.category].push(name);
  }
  for (const c of Object.keys(categories)) {
    categories[c].sort();
  }

  const registry = {
    version: 3,
    generatedAt: new Date().toISOString(),
    ssot: paths.SSOT,
    knownCategories: loadCategoriesConfig().map((c) => c.name),
    agents: Object.fromEntries(
      Object.entries(agentDirs)
        .filter(([key, cfg]) => isAgentVisible(cfg, key, overrides))
        .map(([key, cfg]) => [
          key,
          cfg.type === "native" ? `${cfg.absPath} (原生扫描)` : cfg.absPath,
        ])
    ),
    categories,
    skills,
  };

  writeJsonAtomic(paths.REGISTRY_FILE, registry);
  return registry;
}
