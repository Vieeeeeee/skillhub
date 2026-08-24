import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPaths, ROOT_DIR } from "./paths.mjs";

const CACHE_TTL_MS = 24 * 3600 * 1000; // 24 hours
const DEFAULT_REPO = "Vieeeeeee/skillhub";
const UPDATE_COMMAND = "git pull --ff-only && npm ci && npm test";

export function getCurrentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf-8"));
    return pkg.version || "0.2.0";
  } catch {
    return "0.2.0";
  }
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
          updateCommand: UPDATE_COMMAND,
        };
      }
    } catch {}
  }

  let latestVersion = currentVersion;
  let releaseUrl = `https://github.com/${repo}/releases`;
  let releaseNotes = "";

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "SkillHub-SelfUpdate-Checker",
      },
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = await res.json();
      latestVersion = (data.tag_name || data.name || currentVersion).replace(/^v/, "");
      releaseUrl = data.html_url || releaseUrl;
      releaseNotes = (data.body || "").slice(0, 300);
    } else if (res.status === 404) {
      // If no releases yet, check latest tag
      const tagRes = await fetch(`https://api.github.com/repos/${repo}/tags`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "SkillHub-SelfUpdate-Checker",
        },
        signal: AbortSignal.timeout(4000),
      });
      if (tagRes.ok) {
        const tags = await tagRes.json();
        if (tags && tags.length > 0) {
          latestVersion = (tags[0].name || currentVersion).replace(/^v/, "");
        }
      }
    }
  } catch (err) {
    // Offline or rate-limited; fallback gracefully
  }

  const hasUpdate = compareVersions(currentVersion, latestVersion) > 0;

  const result = {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseUrl,
    releaseNotes,
    updateCommand: UPDATE_COMMAND,
    checkedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(paths.CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  } catch {}

  return result;
}
