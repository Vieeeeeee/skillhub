import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join, relative } from "node:path";
import { getPaths } from "../paths.mjs";
import { buildSyncPlan } from "../sync.mjs";

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

      if (entry.name === ".env" || entry.name.startsWith(".env.")) {
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
        if (pattern.regex.test(content)) secrets.push({ file: relPath, type: pattern.name });
      }

      const match = content.match(/(\/Users\/[a-zA-Z0-9._-]+|\/home\/[a-zA-Z0-9._-]+|[A-Z]:\\Users\\[a-zA-Z0-9._-]+)/);
      if (
        match &&
        !match[1].includes("/Users/username") &&
        !match[1].includes("/Users/xxx") &&
        !match[1].includes("/home/username")
      ) {
        hardcodedHomes.push({ file: relPath, sample: match[1] });
      }
    }
  }

  return { secrets, hardcodedHomes, skipped };
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
        title: "Agent 目录孤儿 Skill",
        reason: `位于 ${act.agent} 目录但未纳入 SSOT 统一管理`,
        recommendation: "可使用 harvest 收编进 SSOT",
        fixable: false,
        action: act,
      });
    }
  }

  // 2. Skill-level inspection
  for (const [name, s] of Object.entries(skills)) {
    // Missing SKILL.md
    if (!s.hasSkillMd) {
      issues.push({
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
      issues.push({
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
      issues.push({
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
      issues.push({
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
      issues.push({
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
      issues.push({
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
        issues.push({
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
        issues.push({
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
        issues.push({
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
  }

  // Sort by Tier (A -> B -> C)
  const tierOrder = { A: 1, B: 2, C: 3 };
  issues.sort((a, b) => (tierOrder[a.tier] || 9) - (tierOrder[b.tier] || 9));

  return issues;
}
