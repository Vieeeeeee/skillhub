import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPaths, ROOT_DIR } from "./paths.mjs";

const CACHE_TTL_MS = 24 * 3600 * 1000; // 24 hours
const DEFAULT_REPO = "Vieeeeeee/skillhub";

function readPackageJson() {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8"));
  } catch {
    return {};
  }
}

export function getPackageName() {
  return readPackageJson().name || "@wsiwsii/skillhub";
}

export function getCurrentVersion() {
  return readPackageJson().version || "unknown";
}

/**
 * How the user actually installs this. The README teaches a global npm
 * install, so telling them to pull a git checkout they never made was a dead
 * end at the exact moment they wanted to act.
 */
export function getUpdateCommand() {
  return `npm install --global ${getPackageName()}@latest`;
}

function compareVersions(v1, v2) {
  // Returns 1 if v2 > v1, -1 if v1 > v2, 0 if equal
  const p1 = (v1 || "").replace(/^v/, "").split(".").map(Number);
  const p2 = (v2 || "").replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num2 > num1) return 1;
    if (num1 > num2) return -1;
  }
  return 0;
}

export async function checkSelfUpdate({ force = false, customHome = null, repo = DEFAULT_REPO } = {}) {
  const currentVersion = getCurrentVersion();
  const paths = getPaths(customHome);
  const cacheFile = join(paths.CACHE_DIR, "self-update.json");

  // Read from cache if valid
  if (!force && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      if (Date.now() - new Date(cached.checkedAt).getTime() < CACHE_TTL_MS) {
        return {
          ...cached,
          currentVersion,
          hasUpdate: compareVersions(currentVersion, cached.latestVersion) > 0,
          updateCommand: getUpdateCommand(),
        };
      }
    } catch {}
  }

  let latestVersion = currentVersion;
  const releaseUrl = `https://github.com/${repo}/releases`;

  // The registry that actually serves this package is the one worth asking.
  // Reading GitHub releases meant a tag without a publish reported a version
  // nobody could install, and a publish without a tag reported nothing at all.
  try {
    const res = await fetch(`https://registry.npmjs.org/${getPackageName()}/latest`, {
      headers: { Accept: "application/json", "User-Agent": "SkillHub-SelfUpdate-Checker" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.version === "string") latestVersion = data.version;
    }
  } catch {
    // Offline or rate-limited; the cached or current version stands.
  }

  const hasUpdate = compareVersions(currentVersion, latestVersion) > 0;

  const result = {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseUrl,
    releaseNotes: "",
    updateCommand: getUpdateCommand(),
    checkedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(paths.CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  } catch {}

  return result;
}
