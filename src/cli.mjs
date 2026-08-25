#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getPaths, getAgentDirs, isAgentVisible, ROOT_DIR } from "./core/paths.mjs";
import { buildRegistry, loadUserOverrides } from "./core/registry.mjs";
import { buildSyncPlan, applySyncPlan } from "./core/sync.mjs";
import { runDoctor, isDefaultReportItem } from "./core/doctor/index.mjs";
import { undoLastBackup, listBackups } from "./core/backup.mjs";
import {
  toggleAgent, removeSkill, updateSkill, setMetadataOverride, setAgentVisibility,
  listTrash, restoreTrash,
} from "./core/ops.mjs";
import { checkSelfUpdate, getCurrentVersion } from "./core/update-check.mjs";
import { startServer, PORT, HOST } from "../server/server.mjs";

const args = process.argv.slice(2);
const command = args[0] || "open";
const UNCLASSIFIED = "其他 / 未分类";

function printUsage() {
  console.log(`
SkillHub · AI Agent Skills Manager & Health Inspector

Usage:
  skillhub [command] [options]

Commands:
  open, start        Start local web UI and open browser (default)
  scan, list         Scan SSOT and agent directories, show summary table
  doctor             Run health checks and inspection rules (Tier A/B/C)
  sync               View pending sync plan (--apply creates missing links only)
  undo               Undo the last modifying operation from backup manifest
  link <name> <ag>   Enable a skill for a configured link-based agent
  unlink <name> <ag> Disable a skill for an agent
  update <name>      Pull latest git commits for a skill
  backups            List recent backup sessions
  skill-path         Print this package's skill/ directory
  agents [k on|off]  List agents in use, or turn one on or off
  pending            List skills still missing a Chinese blurb or a category
  describe <n> <text>  Write the Chinese blurb for a skill
  categorize <n> <cat> Set the category for a skill
  note <n> <text>    Write a personal note on a skill
  remove <n> --yes   Move a skill to the trash (reversible)
  trash [restore <e>]  List the trash, or restore an entry from it
  check-update       Check whether a newer SkillHub has been published

Options:
  --json             Output raw JSON result
  --compact          With scan --json: only the fields a caller decides with
  --apply            Create missing agent links from the current server-side plan
  --fix-broken       Remove broken symlinks only (cannot be combined with --apply)
  --port <number>    Specify server port (default: 7777)
  --no-open          Do not automatically open browser
  --all              With doctor: also list findings in upstream-managed skills
  --yes              Required by remove, which moves data to the trash
`);
}

/**
 * Every write command answers in whichever form the caller asked for. Half of
 * them used to ignore --json and print a sentence, so a script got a parse
 * error with nothing to say why.
 */
function report(jsonMode, payload, humanLines) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
    return;
  }
  for (const line of [].concat(humanLines)) console.log(line);
}

/**
 * The registry carries 27 fields per Skill so the dashboard can render every
 * column. An agent reading `scan --json` needs five of them, and the full
 * payload runs to roughly 95k tokens on a library of 200 Skills — enough to
 * crowd out the task it was called for. This keeps what a caller decides with.
 */
function compactRegistry(reg) {
  const skills = {};
  for (const [name, s] of Object.entries(reg.skills || {})) {
    const description = s.description || "";
    const zh = s.zh || "";
    // A blurb derived from an already-Chinese description is a truncated copy
    // of the line above it. Repeating it doubles the payload and tells a caller
    // nothing, so only a blurb that says something new is worth sending.
    const zhIsOwnText = zh && !description.startsWith(zh.replace(/\.\.\.$/, ""));
    skills[name] = {
      description,
      ...(zhIsOwnText ? { zh } : {}),
      hasBlurb: Boolean(zh),
      category: s.category,
      type: s.type,
      agents: Object.entries(s.agents || {})
        .filter(([, visible]) => visible)
        .map(([agent]) => agent),
    };
  }
  return {
    ssot: reg.ssot,
    generatedAt: reg.generatedAt,
    total: Object.keys(skills).length,
    knownCategories: reg.knownCategories || [],
    skills,
  };
}

// 未知参数一律报错。静默忽略会让用户以为动作生效了，实际什么都没发生。
const KNOWN_OPTIONS = new Set([
  "--json", "--apply", "--fix-broken", "--port", "--no-open", "--all", "--compact",
  "--yes", "--help", "-h", "--version", "-v",
]);

// 取值型选项：它后面那个词是值，不是选项。
const VALUE_OPTIONS = new Set(["--port"]);

// 位置参数是用户自己写的文本——分类名、中文介绍、skill 名。这些完全可以以
// 短横线开头，扫描时必须跳过，否则 `categorize x "-实验"` 会被当成未知选项。
const POSITIONAL_ARG_COUNT = {
  describe: 2, categorize: 2, note: 2, link: 2, unlink: 2, update: 1,
  agents: 2, remove: 1, trash: 2,
};

function assertKnownOptions() {
  const skip = new Set();
  const positional = POSITIONAL_ARG_COUNT[command] || 0;
  for (let i = 1; i <= positional && i < args.length; i += 1) skip.add(i);
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_OPTIONS.has(args[i])) skip.add(i + 1);
  }

  const unknown = args.filter(
    (a, i) => !skip.has(i) && a.startsWith("-") && !KNOWN_OPTIONS.has(a)
  );
  if (unknown.length) {
    console.error(`Unknown option(s): ${unknown.join(", ")}`);
    printUsage();
    process.exit(1);
  }
}

/**
 * `--port` with a missing or non-numeric value used to fall back to the default
 * without saying so, which reads as "it ignored me".
 */
function resolvePort() {
  const idx = args.indexOf("--port");
  if (idx === -1) return PORT;

  const raw = args[idx + 1];
  const port = Number(raw);
  if (raw === undefined || raw.startsWith("-") || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port needs a number between 1 and 65535${raw === undefined ? " (none given)" : `, got "${raw}"`}`);
    process.exit(1);
  }
  return port;
}

async function main() {
  const jsonMode = args.includes("--json");
  const paths = getPaths();
  assertKnownOptions();

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;

    // A plain way to answer "is this installed?" before anything else runs.
    case "version":
    case "--version":
    case "-v":
      console.log(getCurrentVersion());
      break;

    case "open":
    case "start": {
      const port = resolvePort();
      const noOpen = args.includes("--no-open");
      startServer({ port, autoOpen: !noOpen });
      break;
    }

    case "scan":
    case "list": {
      const reg = buildRegistry();
      if (jsonMode) {
        // Compact output is read by a program, so it skips the indentation too.
        console.log(
          args.includes("--compact")
            ? JSON.stringify(compactRegistry(reg))
            : JSON.stringify(reg, null, 2)
        );
        return;
      }
      const count = Object.keys(reg.skills || {}).length;
      console.log(`\n⬢ SkillHub SSOT (${paths.SSOT})`);
      console.log(`Total Skills: ${count}\n`);

      const categories = reg.categories || {};
      for (const [cat, names] of Object.entries(categories)) {
        console.log(`\x1b[1m[${cat}]\x1b[0m (${names.length})`);
        for (const name of names) {
          const s = reg.skills[name];
          const typeStr = s.type === "agent-specific" ? "variant" : s.type;
          const agentsStr = Object.entries(s.agents || {})
            .filter(([, ok]) => ok)
            .map(([ag]) => ag)
            .join(",");
          console.log(`  • ${name.padEnd(30)} [${typeStr.padEnd(10)}] (${agentsStr || "none"})`);
        }
        console.log("");
      }
      break;
    }

    case "doctor": {
      const reg = buildRegistry();
      const issues = runDoctor(reg);
      if (jsonMode) {
        console.log(JSON.stringify(issues, null, 2));
        return;
      }

      // Findings in Skills that track an upstream source are informational: a
      // local edit there is overwritten on the next update. They stay out of
      // the default report and out of its headline count. Tier A is the
      // exception — a leaked key or a broken link is worth reading wherever it
      // lives, so isDefaultReportItem always lets it through.
      const showAll = args.includes("--all");
      const shown = showAll ? issues : issues.filter(isDefaultReportItem);
      const hidden = issues.filter((i) => !isDefaultReportItem(i));
      const upstream = hidden.filter((i) => !i.owned);
      const background = hidden.filter((i) => i.owned && !i.decision);

      console.log(`\n🩺 SkillHub Health Doctor Report`);
      console.log(`Found ${shown.length} item(s):\n`);

      if (shown.length === 0) {
        console.log(`✅ No issues found by the current inspection rules.\n`);
        printFooter();
        return;
      }

      for (const iss of shown) {
        const tierColor = iss.tier === "A" ? "\x1b[31m" : iss.tier === "B" ? "\x1b[33m" : "\x1b[34m";
        const where = iss.location ? ` \x1b[2m(${iss.location})\x1b[0m` : "";
        console.log(`${tierColor}[Tier ${iss.tier}]\x1b[0m \x1b[1m${iss.title}\x1b[0m: ${iss.skill || iss.path}${where}`);
        console.log(`  Reason: ${iss.reason}`);
        console.log(`  Action: ${iss.recommendation}\n`);
      }
      printFooter();
      break;

      function printFooter() {
        if (showAll) return;
        const notes = [];
        if (background.length) notes.push(`${background.length} background note(s) (long descriptions, large files)`);
        if (upstream.length) notes.push(`${upstream.length} in Skills managed upstream`);
        if (notes.length) console.log(`ℹ Not listed: ${notes.join(", ")}. Run with --all to see them.\n`);
      }
    }

    case "sync": {
      const applyMode = args.includes("--apply");
      const fixBrokenMode = args.includes("--fix-broken");
      if (applyMode && fixBrokenMode) {
        console.error("Choose one action: --apply or --fix-broken");
        process.exitCode = 1;
        return;
      }
      const plan = buildSyncPlan();

      if (jsonMode && !applyMode && !fixBrokenMode) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }

      if (!jsonMode) console.log(`\n🔄 SkillHub Sync Plan (${plan.length} action(s)):`);
      if (plan.length === 0 && !applyMode && !fixBrokenMode) {
        console.log(`✅ Everything is already synced.\n`);
        return;
      }

      if (!jsonMode) {
        for (const act of plan) {
          console.log(`  • [${act.kind}] ${act.skill || act.path} ${act.agent ? `(Agent: ${act.agent})` : ""}`);
        }
      }

      if (applyMode || fixBrokenMode) {
        const kind = applyMode ? "link" : "fix-broken-link";
        const selected = plan.filter((action) => action.kind === kind);
        if (!jsonMode && selected.length === 0) {
          console.log(
            plan.length
              ? `\n✅ 没有需要${applyMode ? "补的链接" : "清理的坏链接"}。计划里的 ${plan.length} 项都是另一类动作，这条命令不碰。\n`
              : `\n✅ 全部已同步，没有可执行的动作。\n`
          );
          return;
        }
        if (!jsonMode) console.log(`\nApplying ${selected.length} ${kind} action(s)...`);
        const result = selected.length ? applySyncPlan(selected) : { sessionId: null, applied: [] };
        if (selected.length) buildRegistry();
        const failures = result.applied.filter((item) => !item.ok);
        const successes = result.applied.length - failures.length;
        if (jsonMode) {
          console.log(JSON.stringify({
            ok: failures.length === 0,
            kind,
            attempted: result.applied.length,
            succeeded: successes,
            failed: failures.length,
            sessionId: result.sessionId,
            results: result.applied,
          }, null, 2));
          if (failures.length) process.exitCode = 1;
          return;
        }
        const backupText = result.sessionId ? ` Backup session: ${result.sessionId}` : "";
        console.log(`Applied ${successes}/${result.applied.length} action(s).${backupText}`);
        for (const failure of failures) {
          console.error(`  ✗ ${failure.action?.skill || failure.action?.path || kind}: ${failure.error}`);
        }
        if (failures.length) process.exitCode = 1;
      } else {
        console.log(`\n💡 Run skillhub sync --apply to create missing links, or --fix-broken to remove broken links.\n`);
      }
      break;
    }

    case "undo": {
      const result = undoLastBackup(paths.BACKUPS_DIR);
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.ok) {
        buildRegistry();
        console.log(`\n✓ Undone backup session: ${result.sessionId}`);
        if (result.batchedWrites > 1) {
          console.log(`  这一批合并了 ${result.batchedWrites} 次写入，一起回到了那之前的状态`);
        }
        for (const log of result.logs) {
          console.log(`  ${log}`);
        }
        console.log("");
      } else if (result.nothingToUndo) {
        console.log(`\n没有需要撤销的操作。\n`);
      } else {
        console.log(`\n⚠ Undo failed: ${result.error}\n`);
      }
      break;
    }

    case "backups": {
      const backups = listBackups(paths.BACKUPS_DIR);
      if (jsonMode) {
        console.log(JSON.stringify(backups, null, 2));
        return;
      }
      console.log(`\n📦 SkillHub Backups (${backups.length}):`);
      for (const b of backups) {
        const undone = b.manifest.undoneAt ? " (Undone)" : "";
        // A run of writes shares one session, so "1 op" is not the whole story:
        // undoing this entry may take back eighty-four blurbs.
        const batched = b.batchedWrites > 1 ? `，合并了 ${b.batchedWrites} 次写入` : "";
        console.log(`  • ${b.id} - ${b.manifest.action} [${b.manifest.operations.length} ops${batched}]${undone}`);
      }
      console.log("");
      break;
    }

    case "skill-path": {
      // Printed so the install instructions never have to guess where npm put
      // the package. Works the same from a global install or a checkout.
      report(jsonMode, { command: "skill-path", path: join(ROOT_DIR, "skill") }, join(ROOT_DIR, "skill"));
      break;
    }

    case "agents": {
      const key = args[1];
      const state = args[2];
      if (key && state) {
        if (state !== "on" && state !== "off") {
          console.error("Usage: skillhub agents <agentKey> on|off");
          process.exit(1);
        }
        const visibility = setAgentVisibility(key, state === "on");
        buildRegistry();
        report(jsonMode, { command: "agents", agent: key, visible: state === "on", sessionId: visibility.sessionId },
          `✓ ${key} ${state === "on" ? "已启用" : "已隐藏"}`);
        break;
      }
      const overrides = loadUserOverrides(paths.OVERRIDES_FILE);
      const rows = Object.entries(getAgentDirs()).map(([k, cfg]) => ({
        key: k,
        name: cfg.name || k,
        type: cfg.type,
        path: cfg.absPath,
        available: Boolean(cfg.available),
        visible: isAgentVisible(cfg, k, overrides),
      }));
      if (jsonMode) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      console.log("");
      for (const r of rows) {
        const mark = r.visible ? "✓ 使用中" : "· 已隐藏";
        const note = r.available ? "" : "（目录不存在）";
        console.log(`  ${mark}  ${r.key.padEnd(10)} ${(r.name || "").padEnd(24)} ${note}`);
      }
      console.log("");
      break;
    }

    case "pending": {
      const reg = buildRegistry();
      const items = [];
      for (const [name, s] of Object.entries(reg.skills || {})) {
        // Only list what `describe` and `categorize` can actually write to.
        // A Skill whose body lives in an Agent folder — a deliberate two-sided
        // version, or a dangling link — used to appear here and then fail on
        // the very next command, with no way for the caller to know why.
        if (s.broken || s.type === "agent-specific" || s.type === "agent-only") continue;
        const needsZh = !s.zh;
        const needsCategory = s.category === UNCLASSIFIED;
        if (!needsZh && !needsCategory) continue;
        items.push({
          name,
          needsZh,
          needsCategory,
          category: s.category,
          description: s.description || "",
        });
      }
      if (jsonMode) {
        // 规则能产出的分类 + 当前实际用到的。只给后者会让调用方永远看不到
        // 一个当前还没有成员的分类，也就永远不会把 skill 归进去。
        const categories = [...new Set([
          ...(reg.knownCategories || []),
          ...Object.keys(reg.categories || {}),
        ])].sort();
        console.log(JSON.stringify({ total: items.length, categories, items }, null, 2));
        return;
      }
      console.log(`\n📝 待补充 ${items.length} 项\n`);
      for (const it of items) {
        const need = [it.needsZh ? "中文介绍" : null, it.needsCategory ? "分类" : null].filter(Boolean).join(" + ");
        console.log(`  ${it.name.padEnd(30)} 缺: ${need}`);
      }
      console.log("");
      break;
    }

    case "describe": {
      const name = args[1];
      const text = args[2];
      if (!name || text === undefined) {
        console.error('Usage: skillhub describe <skillName> "<中文介绍>"');
        process.exit(1);
      }
      const described = setMetadataOverride(name, { zh: text });
      buildRegistry();
      report(jsonMode, { command: "describe", skill: name, zh: text, sessionId: described.sessionId },
        `✓ ${name} 的中文介绍已写入`);
      break;
    }

    case "categorize": {
      const name = args[1];
      const category = args[2];
      if (!name || !category) {
        console.error('Usage: skillhub categorize <skillName> "<分类名>"');
        process.exit(1);
      }
      const categorized = setMetadataOverride(name, { category });
      buildRegistry();
      report(jsonMode, { command: "categorize", skill: name, category, sessionId: categorized.sessionId },
        `✓ ${name} 已归入「${category}」`);
      break;
    }

    case "note": {
      const name = args[1];
      const text = args[2];
      if (!name || text === undefined) {
        console.error('Usage: skillhub note <skillName> "<备注>"');
        process.exit(1);
      }
      const noted = setMetadataOverride(name, { notes: text });
      buildRegistry();
      report(jsonMode, { command: "note", skill: name, notes: text, sessionId: noted.sessionId },
        text ? `✓ ${name} 的备注已写入` : `✓ ${name} 的备注已清空`);
      break;
    }

    // Uninstalling was only ever possible from the dashboard, which left an
    // agent unable to do the one thing the Skill's own rules describe as
    // reversible. --yes is required so the intent is explicit in the command.
    case "remove": {
      const name = args[1];
      if (!name) {
        console.error("Usage: skillhub remove <skillName> --yes");
        process.exit(1);
      }
      if (!args.includes("--yes")) {
        console.error(`Refusing to remove "${name}" without --yes.`);
        console.error("It moves the Skill to ~/.agents/_trash/ and unlinks it from every agent.");
        process.exit(1);
      }
      const removed = removeSkill(name);
      buildRegistry();
      report(jsonMode, { command: "remove", skill: name, ...removed }, [
        `✓ 已卸载 ${name}`,
        `  实体在 ~/.agents/_trash/，用 skillhub trash 查看，skillhub undo 可连链接一起还原`,
      ]);
      break;
    }

    case "trash": {
      if (args[1] === "restore") {
        const entry = args[2];
        if (!entry) {
          console.error("Usage: skillhub trash restore <entry>");
          process.exit(1);
        }
        const r = restoreTrash(entry);
        buildRegistry();
        report(jsonMode, { command: "trash-restore", ...r },
          `✓ 已恢复 ${r.restored}，各 agent 的链接需要重新同步`);
        break;
      }
      const items = listTrash();
      if (jsonMode) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      console.log(`\n🗑 回收站 (${items.length})\n`);
      for (const it of items) {
        console.log(`  ${it.entry.padEnd(46)} ${it.mtime.slice(0, 16).replace("T", " ")}`);
      }
      if (items.length) {
        console.log(`\n  恢复： skillhub trash restore <上面的名字>`);
        // The trash holds real Skill data, so nothing here is deleted on a
        // schedule. Saying how old the pile is turns "it only ever grows" into
        // something the user can act on.
        const monthAgo = Date.now() - 30 * 86400 * 1000;
        const stale = items.filter((it) => new Date(it.mtime).getTime() < monthAgo).length;
        if (stale) {
          console.log(`  其中 ${stale} 项超过 30 天。回收站不会自动清空，确认不要了就删 ~/.agents/_trash/ 下对应目录`);
        }
      }
      console.log("");
      break;
    }

    case "link": {
      const skillName = args[1];
      const agentKey = args[2];
      if (!skillName || !agentKey) {
        console.error("Usage: skillhub link <skillName> <agentKey>");
        process.exit(1);
      }
      const r = toggleAgent(skillName, agentKey, true);
      buildRegistry();
      report(jsonMode, { command: "link", skill: skillName, agent: agentKey, sessionId: r.sessionId }, [
        `✓ Linked "${skillName}" to agent "${agentKey}"`,
        `  备份会话 ${r.sessionId}（skillhub undo 可撤销）`,
      ]);
      break;
    }

    case "unlink": {
      const skillName = args[1];
      const agentKey = args[2];
      if (!skillName || !agentKey) {
        console.error("Usage: skillhub unlink <skillName> <agentKey>");
        process.exit(1);
      }
      const r = toggleAgent(skillName, agentKey, false);
      buildRegistry();
      report(jsonMode, { command: "unlink", skill: skillName, agent: agentKey, sessionId: r.sessionId }, [
        `✓ Unlinked "${skillName}" from agent "${agentKey}"`,
        `  备份会话 ${r.sessionId}（skillhub undo 可撤销）`,
      ]);
      break;
    }

    case "update": {
      const skillName = args[1];
      if (!skillName) {
        console.error("Usage: skillhub update <skillName>");
        process.exit(1);
      }
      const r = updateSkill(skillName);
      buildRegistry();
      report(jsonMode, { command: "update", skill: skillName, ...r }, [
        `✓ Updated "${skillName}": ${r.output}`,
        r.sessionId ? `  备份会话 ${r.sessionId}（skillhub undo 可撤销）` : "",
      ].filter(Boolean));
      break;
    }

    case "check-update": {
      const info = await checkSelfUpdate({ force: true });
      if (jsonMode) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(`\n⬢ SkillHub 版本检测:`);
      console.log(`  当前版本: v${info.currentVersion}`);
      console.log(`  最新版本: v${info.latestVersion}`);
      if (info.hasUpdate) {
        console.log(`\n\x1b[33m⚡ 发现新版本可用!\x1b[0m`);
        console.log(`  更新方式: ${info.updateCommand}`);
        console.log(`  发布地址: ${info.releaseUrl}\n`);
      } else {
        console.log(`\n\x1b[32m✅ 当前已是最新版本。\x1b[0m\n`);
      }
      break;
    }

    default:
      console.error(`Unknown command: "${command}"`);
      printUsage();
      process.exit(1);
  }

  // Non-blocking update check for interactive CLI commands
  if (!jsonMode && command !== "check-update" && command !== "open" && command !== "start") {
    try {
      const updateInfo = await checkSelfUpdate({ force: false });
      if (updateInfo && updateInfo.hasUpdate) {
        console.log(`\n\x1b[33m─────────────────────────────────────────────────────────────\x1b[0m`);
        console.log(`\x1b[33m⚡ SkillHub 发现新版本: v${updateInfo.currentVersion} → v${updateInfo.latestVersion}\x1b[0m`);
        console.log(`  更新命令: \x1b[36m${updateInfo.updateCommand}\x1b[0m`);
        console.log(`\x1b[33m─────────────────────────────────────────────────────────────\x1b[0m\n`);
      }
    } catch {}
  }
}

main().catch((err) => {
  // A caller that asked for JSON gets JSON on the way out too. Answering a
  // failure in prose meant a script got a parse error instead of a reason —
  // the same half-kept promise the success path used to make.
  if (process.argv.slice(2).includes("--json")) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  } else {
    console.error("Error:", err.message);
  }
  process.exit(1);
});
