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

// A prerelease tag has to come off before the split: Number("0-beta") is NaN,
// and every comparison against NaN is false, so `0.4.0-beta.1` silently
// answered "no newer version" no matter what it was compared with.
function versionParts(v) {
  return String(v || "")
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((part) => {
      const n = Number(part);
      return Number.isFinite(n) ? n : 0;
    });
}

/** True when `candidate` is a higher version than `current`. */
export function isNewer(current, candidate) {
  return compareVersions(current, candidate) === 1;
}

// The tag that versionParts throws away. `0.4.0-beta.1` and `0.4.0` have the
// same numbers, so without this they compared equal and anyone running a
// prerelease was told they were up to date the day the stable version shipped.
function prereleaseTag(v) {
  return String(v || "").replace(/^v/, "").split("-").slice(1).join("-");
}

function compareVersions(v1, v2) {
  // Returns 1 if v2 > v1, -1 if v1 > v2, 0 if equal
  const p1 = versionParts(v1);
  const p2 = versionParts(v2);

  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num2 > num1) return 1;
    if (num1 > num2) return -1;
  }

  // Same numbers: a prerelease ranks below the release it leads to (semver).
  const tag1 = prereleaseTag(v1);
  const tag2 = prereleaseTag(v2);
  if (tag1 === tag2) return 0;
  if (tag1 && !tag2) return 1;
  if (!tag1 && tag2) return -1;
  return tag2 > tag1 ? 1 : -1;
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
