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
} from "node:fs";
import { join, resolve, dirname, isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getPaths, getAgentDirs, RULES_DIR } from "./paths.mjs";
import { classifySkill, loadCategoriesConfig } from "./classify.mjs";
import { isSymlink, readLinkSafe } from "./link.mjs";
import { assertSafeName, assertSafeRealPath, isInsideRoot } from "./guard.mjs";

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
  return { verifiedSources: {}, inferredSources: {}, upstreamPaths: {}, acceptedAliases: {} };
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
      throw new Error(`Unable to read overrides file ${overridesFile}: ${error.message}`);
    }
  }
  return {};
}

export function saveUserOverrides(overridesFile, overrides) {
  writeJsonAtomic(overridesFile, overrides);
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
    if (statSync(skillMdPath).size > 1024 * 1024) {
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
  const upstreamPaths = { ...known.upstreamPaths, ...(overrides.upstreamPaths || {}) };
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

  const addSkillEntry = (name, entryPath, { agentSpecific = null } = {}) => {
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

    const meta = parseSkillMeta(entryPath);
    const desc = meta.description;
    const fmName = meta.fmName;
    const fmVersion = meta.version;

    let zh = "";
    if (zhOverrides[name]) {
      zh = zhOverrides[name];
    } else if (prev.zh) {
      zh = prev.zh;
    } else if (isChinese(desc)) {
      zh = desc.slice(0, 140);
    }

    // Determine agent visibility
    const agents = {};
    for (const [agKey, agCfg] of Object.entries(agentDirs)) {
      if (agCfg.type === "symlink") {
        const targetAgentPath = join(agCfg.absPath, name);
        agents[agKey] = existsSync(targetAgentPath) || isSymlink(targetAgentPath);
      } else if (agCfg.type === "native") {
        agents[agKey] = true;
      }
    }

    if (agentSpecific) {
      for (const [agentKey, variantPath] of Object.entries(agentSpecific)) {
        agents[agentKey] = existsSync(variantPath);
      }
    } else {
      // Codex natively scans SSOT
      for (const [agKey, agCfg] of Object.entries(agentDirs)) {
        if (agCfg.type === "native") agents[agKey] = true;
      }
    }

    const hasNameMismatch = Boolean(fmName) && fmName !== name && acceptedAliases[name] !== fmName;

    skills[name] = {
      type: agentSpecific ? "agent-specific" : stype,
      path: entryPath,
      bundle,
      origin,
      commit,
      fmName,
      nameMismatch: hasNameMismatch,
      aliasOf: acceptedAliases[name] === fmName ? acceptedAliases[name] : "",
      managed: typeof managedSkills[name] === "string" ? managedSkills[name] : "",
      verifiedSource: verifiedSources[name] || "",
      inferredSource: inferredSources[name] || "",
      upstreamPath: upstreamPaths[name] || "",
      localCanonical: localCanonical.has(name),
      hasUpdate: Boolean(prev.hasUpdate),
      latestUpstream: prev.latestUpstream || "",
      installedVersion: fmVersion,
      lastChecked: prev.lastChecked || "",
      category: classifySkill(name, desc, categoryOverrides),
      description: desc,
      zh,
      notes: notesOverrides[name] ?? prev.notes ?? "",
      hasSkillMd: meta.hasSkillMd,
      hasName: meta.hasName,
      hasDescription: meta.hasDescription,
      lineCount: meta.lineCount,
      agents,
      triggers: Object.fromEntries(
        Object.entries(agentDirs).map(([agentKey, cfg]) => [
          agentKey,
          `${cfg.triggerPrefix || "/"}${agentKey === "codex" ? fmName || name : name}`,
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
      if (entry.isSymbolicLink() && !existsSync(fullPath)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

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
    agents: {
      ...Object.fromEntries(
        Object.entries(agentDirs)
          .filter(([, cfg]) => cfg.type === "symlink")
          .map(([k, cfg]) => [k, cfg.absPath])
      ),
      codex: `${paths.SSOT} (原生扫描)`,
    },
    categories,
    skills,
  };

  writeJsonAtomic(paths.REGISTRY_FILE, registry);
  return registry;
}
