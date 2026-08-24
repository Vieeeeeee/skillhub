import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";
import { getPaths } from "../paths.mjs";
import { buildSyncPlan } from "../sync.mjs";
import { parseSkillMeta } from "../registry.mjs";

const SECRET_PATTERNS = [
  { name: "OpenAI API Key", regex: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic API Key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google API Key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub Token", regex: /\b(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/ },
  { name: "Slack Token", regex: /\bxox[baprs]-[0-9A-Za-z-]{30,}\b/ },
  { name: "AWS Access Key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "npm Access Token", regex: /\bnpm_[0-9A-Za-z]{30,}\b/ },
  { name: "Private Key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// 公开文档里的占位值。把它们当成泄露会让最高级别的告警失去可信度。
const PLACEHOLDER_SECRETS = new Set(["AKIAIOSFODNN7EXAMPLE", "ASIAIOSFODNN7EXAMPLE"]);

// 模板文件按约定只有键没有值，本来就是要提交进仓库的。
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

// 教程和示例里的占位家目录。把它们当成硬编码路径会淹没真正不可移植的引用。
const PLACEHOLDER_HOME_NAMES = new Set([
  "username", "user", "xxx", "me", "you", "your-name", "yourname",
  "test", "example", "demo", "foo", "bar", "name", "path", "someone",
]);

function isPlaceholderHome(sample) {
  const leaf = sample.split(/[/\\]/).filter(Boolean).pop() || "";
  return PLACEHOLDER_HOME_NAMES.has(leaf.toLowerCase());
}

function isEnvTemplate(fileName) {
  return ENV_TEMPLATE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage", "vendor"]);
const MAX_SCAN_FILES = 200;
const MAX_SCAN_ENTRIES = 2_000;
const MAX_SCAN_DEPTH = 10;
const MAX_FILE_BYTES = 512 * 1024;

function scanSkillDirectory(dirPath) {
  const secrets = [];
  const hardcodedHomes = [];
  const skipped = { tooLarge: 0, fileLimit: false, entryLimit: false, depthLimit: false, unreadable: 0 };
  if (!existsSync(dirPath)) return { secrets, hardcodedHomes, skipped };

  const queue = [{ path: dirPath, depth: 0 }];
  let scannedFiles = 0;
  let visitedEntries = 0;

  while (queue.length && !skipped.entryLimit) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      skipped.unreadable += 1;
      continue;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_SCAN_ENTRIES) {
        skipped.entryLimit = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(current.path, entry.name);
      const relPath = relative(dirPath, fullPath);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SCAN_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          queue.push({ path: fullPath, depth: current.depth + 1 });
        } else if (current.depth >= MAX_SCAN_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
          skipped.depthLimit = true;
        }
        continue;
      }
      if (!entry.isFile()) continue;

      if ((entry.name === ".env" || entry.name.startsWith(".env.")) && !isEnvTemplate(entry.name)) {
        secrets.push({ file: relPath, type: "Env File (.env)" });
      }
      if (scannedFiles >= MAX_SCAN_FILES) {
        skipped.fileLimit = true;
        continue;
      }

      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        skipped.tooLarge += 1;
        continue;
      }

      scannedFiles += 1;
      let content;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      if (content.includes("\0")) continue;

      for (const pattern of SECRET_PATTERNS) {
        const match = content.match(pattern.regex);
        if (match && !PLACEHOLDER_SECRETS.has(match[0])) {
          secrets.push({ file: relPath, type: pattern.name });
        }
      }

      const match = content.match(/(\/Users\/[a-zA-Z0-9._-]+|\/home\/[a-zA-Z0-9._-]+|[A-Z]:\\Users\\[a-zA-Z0-9._-]+)/);
      if (match && !isPlaceholderHome(match[1])) {
        hardcodedHomes.push({ file: relPath, sample: match[1] });
      }
    }
  }

  return { secrets, hardcodedHomes, skipped };
}

// Findings that carry no decision. Nobody rewrites the description of a Skill
// they use every day because a rule said it was long, and an incomplete scan is
// a note about coverage rather than a problem. These stay out of the default
// list so what remains is the part worth answering.
const BACKGROUND_RULES = new Set([
  "long-description",
  "large-skill-md",
  "security-scan-incomplete",
]);

/**
 * A Skill that tracks an upstream source is not the user's to edit — a local
 * change there gets overwritten on the next update. Everything else counts as
 * the user's own, including Skills that only live in an Agent directory.
 */
function isThirdParty(s) {
  if (!s) return false;
  return (
    Boolean(s.origin) ||
    Boolean(s.bundle) ||
    s.type === "git" ||
    s.type === "bundle-symlink"
  );
}

/**
 * Runs every per-Skill rule against one Skill directory. `location` is set for
 * Skills that live inside an Agent folder rather than the SSOT, so the report
 * can say where the directory actually is.
 */
function inspectSkill(name, s, issues, location = "") {
  const found = [];
    // Missing SKILL.md
    if (!s.hasSkillMd) {
      found.push({
        id: "missing-skill-md",
        tier: "A",
        skill: name,
        path: s.path,
        title: "缺少 SKILL.md",
        reason: "目录内未找到入口文档 SKILL.md",
        recommendation: "补充 SKILL.md 文件",
        fixable: false,
      });
    }

    // Missing Name
    if (!s.hasName) {
      found.push({
        id: "missing-name",
        tier: "A",
        skill: name,
        path: s.path,
        title: "Frontmatter 缺少 name",
        reason: "YAML frontmatter 中缺少必填字段 name",
        recommendation: "在 SKILL.md 开头添加 name: <skill-name>",
        fixable: false,
      });
    }

    // Missing Description
    if (!s.hasDescription) {
      found.push({
        id: "missing-description",
        tier: "A",
        skill: name,
        path: s.path,
        title: "Frontmatter 缺少 description",
        reason: "YAML frontmatter 中缺少必填字段 description",
        recommendation: "在 SKILL.md 开头添加 description 说明",
        fixable: false,
      });
    }

    // Name Mismatch
    if (s.nameMismatch) {
      found.push({
        id: "name-mismatch",
        tier: "A",
        skill: name,
        fmName: s.fmName,
        path: s.path,
        title: "frontmatter name 与目录名不一致",
        reason: `frontmatter name 为 "${s.fmName}"，而目录名为 "${name}"，两端触发命令会不一致`,
        recommendation: `修改 SKILL.md 的 name 为 "${name}" 或重命名目录`,
        fixable: false,
      });
    }

    // Long Description (>200 chars)
    if (s.description && s.description.length > 200) {
      found.push({
        id: "long-description",
        tier: "C",
        skill: name,
        path: s.path,
        title: `description 过长 (${s.description.length} 字符)`,
        reason: "技能描述超过 200 字符，每次会话注入时将持续多消耗 Token",
        recommendation: "精简 description 至核心触发场景，详细说明移入正文",
        fixable: false,
      });
    }

    // Large SKILL.md (>500 lines)
    if (s.lineCount && s.lineCount > 500) {
      found.push({
        id: "large-skill-md",
        tier: "C",
        skill: name,
        path: s.path,
        title: `SKILL.md 行数过大 (${s.lineCount} 行)`,
        reason: "单文件超过 500 行，可能影响 Agent 上下文关注度",
        recommendation: "建议将长文档参考抽离至 references/ 目录",
        fixable: false,
      });
    }

    // Security & Secrets Scan
    if (s.path && existsSync(s.path)) {
      const scan = scanSkillDirectory(s.path);
      for (const sec of scan.secrets) {
        found.push({
          id: "secret-detected",
          tier: "A",
          skill: name,
          path: join(s.path, sec.file),
          title: `疑似包含凭据: ${sec.type}`,
          reason: `文件 "${sec.file}" 包含疑似敏感 Key 或环境变量`,
          recommendation: "移除敏感信息或加入 .gitignore",
          fixable: false,
        });
      }

      // Hardcoded personal home path
      for (const hc of scan.hardcodedHomes) {
        found.push({
          id: "hardcoded-user-path",
          tier: "B",
          skill: name,
          path: join(s.path, hc.file),
          title: `硬编码绝对路径 (${hc.file})`,
          reason: `检测到个人绝对路径: ${hc.sample}`,
          recommendation: "改用相对路径或环境变量",
          fixable: false,
        });
      }

      const skippedParts = [];
      if (scan.skipped.tooLarge) skippedParts.push(`${scan.skipped.tooLarge} 个文件超过 512 KB`);
      if (scan.skipped.fileLimit) skippedParts.push(`文件数量超过 ${MAX_SCAN_FILES}`);
      if (scan.skipped.entryLimit) skippedParts.push(`目录条目超过 ${MAX_SCAN_ENTRIES}`);
      if (scan.skipped.depthLimit) skippedParts.push(`目录深度超过 ${MAX_SCAN_DEPTH} 层`);
      if (scan.skipped.unreadable) skippedParts.push(`${scan.skipped.unreadable} 个路径无法读取`);
      if (skippedParts.length) {
        found.push({
          id: "security-scan-incomplete",
          tier: "B",
          skill: name,
          path: s.path,
          title: "安全扫描未完整覆盖",
          reason: skippedParts.join("；"),
          recommendation: "人工检查未扫描文件，或缩小文件后重新体检",
          fixable: false,
        });
      }
    }
  const owned = !isThirdParty(s);
  for (const issue of found) {
    if (location) issue.location = location;
    issue.owned = owned;
    issues.push(issue);
  }
}

/**
 * Real Skill directories that live inside an Agent folder and are not managed
 * in the SSOT. They are inspected in place and never modified.
 */
function collectAgentResidentSkills(syncActions, skills) {
  const out = [];
  const seen = new Set();
  for (const act of syncActions) {
    if (act.kind !== "report-agent-orphan" || !act.path) continue;
    if (skills[act.skill]) continue;
    let key;
    try {
      key = realpathSync(act.path);
    } catch {
      key = act.path;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = parseSkillMeta(act.path);
    out.push({
      name: act.skill,
      location: `${act.agent} 目录`,
      meta: {
        ...meta,
        path: act.path,
        nameMismatch: Boolean(meta.fmName) && meta.fmName !== act.skill,
      },
    });
  }
  return out;
}

export function runDoctor(registry, customHome = null) {
  const paths = getPaths(customHome);
  const issues = [];
  const skills = registry.skills || {};

  // 1. Sync & Structural issues from syncPlan
  const syncActions = buildSyncPlan(customHome);
  for (const act of syncActions) {
    if (act.kind === "fix-broken-link") {
      issues.push({
        id: "broken-symlink",
        tier: "A",
        skill: act.skill,
        path: act.path,
        title: "损坏的软链接",
        reason: `指向无效目标: ${act.target || "(unknown)"}`,
        recommendation: "清理断开的软链",
        fixable: true,
        action: act,
      });
    } else if (act.kind === "prune-redundant-codex-link") {
      issues.push({
        id: "redundant-codex-link",
        tier: "B",
        path: act.path,
        title: "Codex 冗余软链接",
        reason: act.note || "Codex 已原生扫描 SSOT",
        recommendation: "可安全清理该软链接",
        fixable: true,
        action: act,
      });
    } else if (act.kind === "remove-empty-dir") {
      issues.push({
        id: "empty-directory",
        tier: "B",
        path: act.path,
        skill: act.skill,
        title: "SSOT 空目录",
        reason: "目录内无任何文件且无 SKILL.md",
        recommendation: "清理空文件夹",
        fixable: true,
        action: act,
      });
    } else if (act.kind === "report-agent-orphan") {
      issues.push({
        id: "agent-orphan",
        tier: "B",
        skill: act.skill,
        agent: act.agent,
        path: act.path,
        title: "仅单个 Agent 可见",
        reason: `实体目录位于 ${act.agent} 目录，只有 ${act.agent} 能读到它`,
        recommendation:
          `保持现状即可正常使用。若希望其他 Agent 也能用，把该目录移入 ~/.agents/skills 后运行 skillhub sync --apply`,
        fixable: false,
        action: act,
      });
    }
  }

  // 2. Skill-level inspection. Covers SSOT Skills and, read-only, real Skill
  // directories that still live inside an Agent folder.
  for (const [name, s] of Object.entries(skills)) {
    inspectSkill(name, s, issues);
  }
  for (const entry of collectAgentResidentSkills(syncActions, skills)) {
    inspectSkill(entry.name, entry.meta, issues, entry.location);
  }

  for (const issue of issues) {
    if (issue.owned === undefined) issue.owned = true;
    issue.decision = !BACKGROUND_RULES.has(issue.id);
  }

  // Sort by Tier (A -> B -> C)
  const tierOrder = { A: 1, B: 2, C: 3 };
  issues.sort((a, b) => (tierOrder[a.tier] || 9) - (tierOrder[b.tier] || 9));

  return issues;
}
