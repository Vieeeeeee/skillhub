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

export function loadAgentsConfig() {
  const agentsFile = join(RULES_DIR, "agents.json");
  if (existsSync(agentsFile)) {
    try {
      return JSON.parse(readFileSync(agentsFile, "utf-8"));
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
      relPrefix: "../../.agents/skills/",
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.gemini) {
    result.gemini = {
      name: "Gemini CLI",
      absPath: join(home, ".gemini", "config", "skills"),
      relPrefix: "../../../.agents/skills/",
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.hermes) {
    result.hermes = {
      name: "Hermes Agent",
      absPath: join(home, ".hermes", "skills", "claude-skills"),
      relPrefix: "../../../.agents/skills/",
      triggerPrefix: "/",
      type: "symlink",
      status: "verified",
    };
  }
  if (!result.codex) {
    result.codex = {
      name: "OpenAI Codex",
      absPath: join(home, ".agents", "skills"),
      secondaryPath: join(home, ".codex", "skills"),
      secondaryAbsPath: join(home, ".codex", "skills"),
      type: "native",
      triggerPrefix: "$",
      status: "verified",
    };
  }

  return result;
}
