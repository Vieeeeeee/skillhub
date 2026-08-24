# SkillHub

把散落在不同 AI Agent 目录里的 Skills，集中到本地一处管理、体检和启用。

[![CI](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml/badge.svg)](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@wsiwsii/skillhub.svg)](https://www.npmjs.com/package/@wsiwsii/skillhub)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](./README.md)

> **当前状态：预发布。** 打包后的 CLI 已在 macOS 本机验证，并完成全局安装后的面板启动测试。当前提交也已通过 Linux、macOS、Windows × Node.js 20/22 的 GitHub Actions 检查。执行写命令前，请先阅读下方权限和第三方 Skill 风险说明。

SkillHub 盘点这台电脑上的全部 Skill，显示每个 Agent 能读到哪些，帮你补中文介绍和分类，并且只执行你明确点下或输入的写操作。唯一真身放在 `~/.agents/skills`。Web 面板只允许绑定本机回环地址。

## 30 秒上手

npm 安装需要 Node.js 20 或更新版本；运行源码还需要 Git。

推荐从 npm 安装公开 CLI：

```bash
npm install --global @wsiwsii/skillhub

# 先体检和查看，不改 Skill 内容
skillhub doctor
skillhub scan

# 打开本地面板：http://127.0.0.1:7777
skillhub open
```

希望直接运行源码时，GitHub 安装方式仍然完整保留：

```bash
git clone https://github.com/Vieeeeeee/skillhub.git
cd skillhub
npm ci

# 先体检和查看，不改 Skill 内容
./bin/skillhub doctor
./bin/skillhub scan

# 打开本地面板：http://127.0.0.1:7777
./bin/skillhub open
```

更新 npm CLI：`npm install --global @wsiwsii/skillhub@latest`。更新源码：

```bash
git pull --ff-only
npm ci
npm test
```

## 能做什么

| 能力 | 实际结果 |
|---|---|
| 统一清单 | 展示 Skill、来源、分类、Agent 可见状态和结构信息。 |
| 中文介绍与分类 | 规则先把大头粗分一遍；`pending` 列出还没补的，`describe` 和 `categorize` 把剩下的写回去。两者只写 SkillHub 自己的配置，不碰 Skill 内容。 |
| Agent 启用 | 为需要链接的 Agent 创建或移除链接，不会把真实目录当链接删除。 |
| 在用的 Agent | 没在用的 Agent 可以隐藏，不再出现在看板和同步计划里。隐藏不会删除已有链接，目录不存在的 Agent 默认就不显示。 |
| 同步计划 | 先展示完整计划；`sync --apply` 只补缺失链接，`--fix-broken` 只移除损坏链接。 |
| 健康体检 | 查找 frontmatter 缺失、坏链接、个人绝对路径、文件过大和疑似密钥特征，统一管理的 Skill 和仍留在各 Agent 目录里的 Skill 都会检查。全程只读。每条结果标明你能不能处理：来自随上游更新的 Skill 的结果只作参考，因为本地改动会被下次升级覆盖（`doctor --all` 可一并列出）。扫描属于启发式检查。 |
| Git 更新 | 对单个 Git Skill 或每个唯一 bundle 执行快进更新，部分失败会逐项显示。 |
| 卸载与恢复 | 真实 Skill 移到 `~/.agents/_trash/`，链接型 Skill 只移除链接。 |
| 本地面板 | 通过带会话令牌的本机 API，提供清单和明确的单项操作。 |

## 目录怎么分工

```text
~/.agents/skills/                     Skill 唯一真身或指向 bundle 的链接
~/.agents/_repos/                     统一管理的多 Skill 仓库
~/.agents/_trash/                     本地回收站
~/.skillhub/registry.json             自动生成的清单缓存
~/.skillhub/overrides.json            本地名称、分类和 Agent 选择
~/.skillhub/backups/                  支持回滚操作的 manifest
~/.skillhub/session                   面板令牌，POSIX 下权限为 0600

~/.claude/skills/<name>               指向唯一真身
~/.gemini/config/skills/<name>         指向唯一真身
~/.hermes/skills/claude-skills/<name> 指向唯一真身
~/.cursor/skills/<name>                实验性适配
```

Agent 路径来自 [`rules/agents.json`](./rules/agents.json)。Codex 当前配置采用原生扫描，不额外复制文件。需要链接的 Agent 在 macOS/Linux 使用相对软链接，在 Windows 使用目录 Junction。

## 权限和副作用

执行写命令前先看这张表：

| 操作 | 会读取 | 会写入 | 回滚边界 |
|---|---|---|---|
| `scan`、`list`、`doctor` | Skill 与 Agent 目录 | `~/.skillhub/` 下的缓存和状态 | 不改 Skill 内容。 |
| `open` | 同一批本地数据 | 会话令牌、清单与缓存 | 面板里的写入仍需明确点击按钮。 |
| `link`、`unlink` | 唯一真身和 Agent 路径 | Agent 链接、本地选择与 manifest | 有记录的链接操作可尝试 Undo。 |
| `describe`、`categorize` | 唯一真身中的 Skill 条目 | `~/.skillhub/overrides.json` 里的中文介绍与分类 | 有记录，Undo 可回滚。不碰 Skill 内容。 |
| `agents <名字> on\|off` | Agent 配置 | `~/.skillhub/overrides.json` 里的 Agent 可见性 | 有记录。已有链接一律不删，重新启用即恢复原样。 |
| `sync --apply` | 现场重新生成的同步计划 | 只补全缺失链接 | 有记录的链接操作可尝试 Undo。 |
| `sync --fix-broken` | 现场重新生成的同步计划 | 只移除损坏链接 | 有记录的链接操作可尝试 Undo。 |
| `update` / “更新全部” | 已有 Git 仓库 | 执行 `git pull --ff-only` | SkillHub Undo 不负责恢复，请使用 Git 或常规备份。 |
| 从 Git 添加 | GitHub 公开仓库 | 先克隆到隔离目录，通过检查后移入唯一真身 | 克隆成功不代表仓库可信，启用前仍需人工阅读。 |
| 卸载 | Agent 链接和唯一真身 | 解除链接或把数据移入 `_trash` | 从回收站恢复，或使用符合条件的 manifest。 |

`skillhub undo` 会尽力反向执行最新一份符合条件的 manifest。它会拒绝覆盖后来出现的新路径，失败的会话会保留，方便修正问题后重试。如果在文件变化与写入操作记录之间的极短时间内断电或进程崩溃，可能留下未记录的变化；写操作被中断后，请重新检查同步计划和各 Agent 目录。它无法替代 Time Machine、文件系统快照或 Git 历史。

## 第三方 Skill 风险

Skill 本质上是 Agent 会读取的指令内容，也可能引用以当前用户权限运行的脚本和工具。Star 数、熟悉的作者名字、SkillHub 没报错，都不能证明它可信。

启用外部 Skill 前建议逐项检查：

1. 阅读根目录 `SKILL.md`，继续检查它要求 Agent 执行的脚本和引用文件。
2. 核对仓库作者、近期提交、许可证，以及意外出现的二进制或生成文件。
3. 清理凭据、个人目录和只适用于作者电脑的配置。
4. 先用低权限、非重要数据测试，再放进正式项目。

Git 安装目前只接收 GitHub 仓库根地址和 HTTPS 协议。SkillHub 会先隔离克隆，要求根目录存在普通文件 `SKILL.md`，并含 `name` 与 `description`；同时关闭交互式凭据和 LFS smudge，并限制仓库体积。缺少根入口的多 Skill 仓库会被拒绝。这些措施用于减少误操作，不等同于恶意代码分析或沙箱。

## 会访问哪些网络

SkillHub 不包含遥测。以下动作会主动联网：

| 触发时机 | 目标 | 用途 |
|---|---|---|
| 多数交互式 CLI 命令执行后、面板启动时 | `api.github.com` | 查询本项目最新 GitHub Release，缓存 24 小时。 |
| 面板加载热门榜单 | `api.github.com` | 搜索公开 Skill 仓库，缓存一周。 |
| 从 Git 添加 | `github.com` | 克隆用户选中的公开仓库。 |
| 更新 Skill | 现有 Git remote | 执行仅快进的 pull。 |

断网或 GitHub 限流时，会显示错误或读取已有缓存，本地清单仍可使用。面板只接受 `127.0.0.1`、`localhost`、`::1`；绑定 `0.0.0.0` 或局域网地址会直接拒绝。浏览器写请求需要完全同源、JSON Content-Type 和有效会话令牌。

## 命令速查

```text
skillhub [命令] [参数]

open, start        启动本地面板
scan, list         生成并输出本地清单
pending            列出还缺中文介绍或还没归类的 Skill
describe <名字> <文本>   写入 Skill 的中文介绍
categorize <名字> <分类> 设置 Skill 的分类
agents [名字 on|off]     查看在用哪些 Agent，或开关某一个
sync               查看当前同步计划
link <名字> <agent>   为链接型 Agent 启用 Skill
unlink <名字> <agent> 为链接型 Agent 禁用 Skill
update <名字>      快进更新一个 Git Skill 或 bundle
doctor             执行 Tier A/B/C 体检规则
undo               重试回滚最新一份符合条件的备份 manifest
backups            列出备份 manifest
check-update       检查 SkillHub 是否有新版本

--json             在支持的命令中输出 JSON
--apply            配合 sync：只补全缺失链接
--fix-broken       配合 sync：只移除损坏链接
--all              配合 doctor：把随上游更新的 Skill 的结果也列出来
--port <number>    面板端口，默认 7777
--no-open          启动后不自动打开浏览器
```

## 支持状态

| 范围 | 状态 | 说明 |
|---|---|---|
| Node.js | 支持 20+ | CI 当前覆盖 Node 20、22。 |
| macOS | 本机已验证 | 源码测试和本地打包安装后的面板启动测试已通过。 |
| Linux | CI 已验证 | 当前 GitHub Actions 在 Node.js 20/22 下通过；使用前仍需核对本机 Agent 路径。 |
| Windows | CI 已验证 | 当前 GitHub Actions 在 Node.js 20/22 下通过。Junction 行为仍受本机文件系统策略和权限影响，建议先看 `sync`，再决定是否 `--apply`。 |
| Claude、Gemini、Hermes | 链接适配 | 路径可在 `rules/agents.json` 调整。 |
| Codex | 原生适配 | 使用配置中的共享 Skills 目录；请按本机 Codex 版本复核。 |
| Cursor | 实验性 | 用于验证配置驱动的 Agent 扩展，目前不宣称完整适配。 |

## 常见问题

| 现象 | 先检查什么 |
|---|---|
| 面板没打开 | 执行 `./bin/skillhub open --no-open` 查看终端，再访问 `http://127.0.0.1:7777`。端口占用可加 `--port 7788`。 |
| 看不到某个 Skill | 执行 `./bin/skillhub scan --json`，确认唯一真身根目录存在 `SKILL.md`。 |
| 链接状态不对 | 先运行不带写参数的 `./bin/skillhub sync`，逐项核对计划。 |
| Undo 失败 | 阅读每条日志。失败 manifest 会保留，也不会覆盖同位置后来出现的新文件。 |
| Git 更新失败 | 用 Git 处理本地改动、认证、remote 或非快进历史；SkillHub 固定使用 `--ff-only`。 |
| 热榜或版本查询失败 | 可能是断网或 GitHub 限流，不影响核心本地清单。 |

## 开发与验证

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
npm run pack:check
```

`npm run pack:check` 会预览 npm 包的准确内容，不会发布。测试、CI 配置和内部计划不会进入 npm 包。执行 `npm publish` 时，`prepublishOnly` 还会自动运行测试、生产依赖审计和包内容检查。行为改动请补回归测试，路径、同源校验和回滚护栏不得弱化。

## 私密报告安全问题

请勿在公开 Issue 披露漏洞。使用 [GitHub Security Advisories](https://github.com/Vieeeeeee/skillhub/security/advisories/new)，填写受影响版本、复现步骤和影响，去掉真实凭据与个人路径。更多说明见 [`SECURITY.md`](./SECURITY.md)。

## 许可证

[MIT](./LICENSE)
