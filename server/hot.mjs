import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "../src/core/paths.mjs";
import { loadCategoriesConfig } from "../src/core/classify.mjs";

const TTL_MS = 7 * 24 * 3600 * 1000; // 1 week

const SEED_REPOS = [
  "anthropics/skills",
  "openai/skills",
  "cloudflare/skills",
  "obra/superpowers",
];

const SEARCHES = [
  "q=" + encodeURIComponent("topic:claude-skills") + "&sort=stars&order=desc&per_page=50",
  "q=" + encodeURIComponent("topic:agent-skills") + "&sort=stars&order=desc&per_page=50",
  "q=" + encodeURIComponent("topic:codex-skills") + "&sort=stars&order=desc&per_page=30",
];

function classifyRepo(r) {
  const categories = loadCategoriesConfig();
  const hay = (r.full_name + " " + (r.description || "") + " " + (r.topics || []).join(" ")).toLowerCase();

  for (const cat of categories) {
    if (cat.keywords && cat.keywords.some((k) => hay.includes(k.toLowerCase()))) {
      return cat.name;
    }
  }
  return "其他 / 未分类";
}

async function gh(path) {
  const res = await fetch("https://api.github.com" + path, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "skillhub-cli" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path.slice(0, 60)}`);
  return res.json();
}

function normRepo(r) {
  const created = new Date(r.created_at);
  const days = Math.max(1, (Date.now() - created.getTime()) / 86400000);
  return {
    repo: r.full_name,
    url: r.html_url,
    stars: r.stargazers_count,
    description: (r.description || "").slice(0, 140),
    topics: (r.topics || []).slice(0, 6),
    createdAt: r.created_at?.slice(0, 10) || "",
    starsPerDay: Math.round((r.stargazers_count / days) * 10) / 10,
    rising: days <= 90 && r.stargazers_count / days >= 20,
  };
}

function installedRepoSet(registry) {
  const repos = new Set();
  const names = new Set();
  for (const [name, s] of Object.entries(registry.skills || {})) {
    names.add(name.toLowerCase());
    for (const src of [s.origin, s.verifiedSource, s.inferredSource]) {
      if (!src) continue;
      const m =
        String(src).match(/(?:github\.com[/:]|github:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i) ||
        String(src).match(/^([\w.-]+\/[\w.-]+)$/);
      if (m) repos.add(m[1].toLowerCase());
    }
  }
  return { repos, names };
}

export async function fetchHot(customHome = null) {
  const paths = getPaths(customHome);
  const byRepo = new Map();

  for (const qs of SEARCHES) {
    try {
      const d = await gh("/search/repositories?" + qs);
      for (const r of d.items || []) byRepo.set(r.full_name, r);
    } catch (e) {
      console.error("Hot search failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  try {
    const d = await gh(
      `/search/repositories?q=${encodeURIComponent(`topic:claude-skills created:>${since}`)}&sort=stars&order=desc&per_page=30`
    );
    for (const r of d.items || []) byRepo.set(r.full_name, r);
  } catch (e) {
    console.error("Rising search failed:", e.message);
  }

  for (const full of SEED_REPOS) {
    if (byRepo.has(full)) continue;
    try {
      byRepo.set(full, await gh("/repos/" + full));
    } catch (e) {
      console.error("Seed fetch failed:", full, e.message);
    }
  }

  let registry = { skills: {} };
  if (existsSync(paths.REGISTRY_FILE)) {
    try {
      registry = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
    } catch {}
  }

  const { repos: installedRepos, names: installedNames } = installedRepoSet(registry);
  const all = [...byRepo.values()].map(normRepo).map((r) => ({
    ...r,
    category: classifyRepo(r),
    installable: !SEED_REPOS.includes(r.repo.toLowerCase()),
    installNote: SEED_REPOS.includes(r.repo.toLowerCase())
      ? "Multi-Skill repository: browse and install an individual Skill manually"
      : "",
    installed:
      installedRepos.has(r.repo.toLowerCase()) ||
      installedNames.has(r.repo.split("/")[1]?.toLowerCase()),
  }));

  const categories = {};
  for (const r of all.sort((a, b) => b.stars - a.stars)) {
    categories[r.category] ||= [];
    if (categories[r.category].length < 5) categories[r.category].push(r);
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    totalScanned: byRepo.size,
    categories,
  };

  mkdirSync(paths.CACHE_DIR, { recursive: true });
  writeFileSync(join(paths.CACHE_DIR, "hot-skills.json"), JSON.stringify(data, null, 2));
  return data;
}

export async function getHot({ force = false, customHome = null } = {}) {
  const paths = getPaths(customHome);
  const cacheFile = join(paths.CACHE_DIR, "hot-skills.json");

  if (!force && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      if (Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS) {
        let registry = { skills: {} };
        if (existsSync(paths.REGISTRY_FILE)) {
          try {
            registry = JSON.parse(readFileSync(paths.REGISTRY_FILE, "utf-8"));
          } catch {}
        }
        const { repos, names } = installedRepoSet(registry);
        for (const list of Object.values(cached.categories || {})) {
          for (const r of list) {
            r.installable = !SEED_REPOS.includes(r.repo.toLowerCase());
            r.installNote = r.installable
              ? ""
              : "Multi-Skill repository: browse and install an individual Skill manually";
            r.installed =
              repos.has(r.repo.toLowerCase()) ||
              names.has(r.repo.split("/")[1]?.toLowerCase());
          }
        }
        return { ...cached, fromCache: true };
      }
    } catch {}
  }
  return fetchHot(customHome);
}
