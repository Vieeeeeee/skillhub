import { homedir } from "node:os";
import { join, resolve, dirname, normalize, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const ROOT_DIR = resolve(__dirname, "../..");
export const RULES_DIR = join(ROOT_DIR, "rules");

export const isWindows = process.platform === "win32";

export function getHome() {
  return normalize(process.env.SKILL_HUB_HOME || homedir());
}

export function getPaths(customHome = null) {
  const home = customHome ? normalize(customHome) : getHome();
  const skillhubDir = join(home, ".skillhub");
  const agentsRoot = join(home, ".agents");
  const ssot = join(agentsRoot, "skills");
  const repos = join(agentsRoot, "_repos");
  const trash = join(agentsRoot, "_trash");

  return {
    HOME: home,
    AGENTS_ROOT: agentsRoot,
    SSOT: ssot,
    REPOS: repos,
    TRASH: trash,
    SKILLHUB_DIR: skillhubDir,
    BACKUPS_DIR: join(skillhubDir, "backups"),
    REGISTRY_FILE: join(skillhubDir, "registry.json"),
    OVERRIDES_FILE: join(skillhubDir, "overrides.json"),
    SESSION_FILE: join(skillhubDir, "session"),
    CONFIG_FILE: join(skillhubDir, "config.json"),
    CACHE_DIR: join(skillhubDir, "cache"),
  };
}

let _agentsConfigCache = null;

/**
 * Read once per process, like categories.json and known-sources.json.
 *
 * This one used to be re-parsed on every getAgentDirs() call — several times
 * per request — while its two neighbours in rules/ were cached forever. Three
 * config files in one directory behaved three different ways. They now share
 * one rule: rules/ is read at startup, so editing it needs a restart.
 */
export function loadAgentsConfig() {
  if (_agentsConfigCache) return _agentsConfigCache;
  const agentsFile = join(RULES_DIR, "agents.json");
  if (existsSync(agentsFile)) {
    try {
      _agentsConfigCache = JSON.parse(readFileSync(agentsFile, "utf-8"));
      return _agentsConfigCache;
    } catch {
      // fallback
    }
  }
  return {};
}

export function getAgentDirs(customHome = null) {
  const home = customHome ? normalize(customHome) : getHome();
  const agentsCfg = loadAgentsConfig();
  const result = {};

  for (const [key, cfg] of Object.entries(agentsCfg)) {
    const relPath = isWindows && cfg.windowsPath ? cfg.windowsPath : cfg.path;
    if (typeof relPath !== "string" || !relPath.trim()) continue;
    const pathParts = relPath.split(/[/\\]+/).filter(Boolean);
    const absPath = isAbsolute(relPath) ? normalize(relPath) : join(home, ...pathParts);
    result[key] = {
      ...cfg,
      absPath,
      available: existsSync(absPath),
      secondaryAbsPath:
        typeof cfg.secondaryPath === "string"
          ? isAbsolute(cfg.secondaryPath)
            ? normalize(cfg.secondaryPath)
            : join(home, ...cfg.secondaryPath.split(/[/\\]+/).filter(Boolean))
          : undefined,
    };
  }

  // Fallback defaults if agents.json not present
  if (!result.claude) {
    result.claude = {
      name: "Claude Code",
      absPath: join(home, ".claude", "skills"),
      available: existsSync(join(home, ".claude", "skills")),
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.gemini) {
    result.gemini = {
      name: "Gemini CLI",
      absPath: join(home, ".gemini", "config", "skills"),
      available: existsSync(join(home, ".gemini", "config", "skills")),
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.hermes) {
    result.hermes = {
      name: "Hermes Agent",
      absPath: join(home, ".hermes", "skills", "claude-skills"),
      available: existsSync(join(home, ".hermes", "skills", "claude-skills")),
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.codex) {
    result.codex = {
      name: "OpenAI Codex",
      absPath: join(home, ".agents", "skills"),
      available: existsSync(join(home, ".agents", "skills")),
      secondaryPath: join(home, ".codex", "skills"),
      secondaryAbsPath: join(home, ".codex", "skills"),
      type: "native",
      triggerPrefix: "$",
      status: "verified",
    };
  }

  return result;
}

/**
 * Whether an Agent should be shown and kept in sync. The user's explicit choice
 * wins; with no choice, an Agent whose directory does not exist on this machine
 * stays out of the way instead of sitting there permanently "not linked".
 *
 * Hiding an Agent only affects display and sync planning. Links that already
 * exist are left untouched, so unhiding restores the previous state.
 */
export function isAgentVisible(cfg, key, overrides) {
  const choice = overrides?.agentVisibility?.[key];
  if (typeof choice === "boolean") return choice;
  return Boolean(cfg?.available);
}
