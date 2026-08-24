---
name: skillhub
description: >-
  盘点和管理本地 AI Agent Skills：出一份现状报告并打开本地面板，再引导补中文介绍、归类、选择同步到哪些 agent。覆盖 Claude Code、Codex、Gemini、Cursor、Hermes。触发：技能太乱、整理技能、看看装了哪些技能、打开技能面板、技能体检。
---

# SkillHub

对本机全部 Agent Skills 做一次只读盘点，打开本地面板看现状，再按用户的选择去整理。流程：确认命令可用 → 只读盘点 → 打开面板 → 对话里给摘要和下一步。

## 铁律

- **盘点全程只读。** `scan`、`pending`、`agents`、`doctor` 和不带参数的 `sync` 都不改任何文件，随便跑。
- **写操作先确认。** `sync --apply`、`link`/`unlink`、卸载这些动之前，把影响范围说清楚再等用户点头。即使用户说"你看着办"，也要先讲清楚会建哪些链接、动哪几个 agent。
- **不碰 skill 内容。** 中文介绍、分类、agent 可见性都只写 SkillHub 自己的配置文件（`~/.skillhub/`），SKILL.md 一个字节都不动。
- **卸载不是删除**，东西进 `~/.agents/_trash/`，随时能恢复。
- 每次写操作都留备份，`skillhub undo` 回滚上一次。

## 执行流程

### Step 0 确保命令可用

先跑 `skillhub --version`。有版本号就往下走。

报 command not found 就装一次：

```bash
npm install --global @wsiwsii/skillhub
```

全局安装因为权限失败时，装到固定位置再用绝对路径调用（macOS/Linux 是 `~/.skillhub/cli`，Windows 是 `%USERPROFILE%\.skillhub\cli`）：

```bash
npm install --prefix ~/.skillhub/cli @wsiwsii/skillhub
node ~/.skillhub/cli/node_modules/@wsiwsii/skillhub/bin/skillhub --version
```

装完再确认一次版本号，然后后续所有命令都用同一个调用方式。

### Step 1 只读盘点

```bash
skillhub scan --json      # 装了哪些、分类、各 agent 可见性
skillhub pending --json   # 还缺中文介绍或还没归类的
skillhub agents --json    # 在用哪些 agent
skillhub doctor --json    # 体检
```

`scan` 的输出在技能多的时候很大，只取需要的字段，别整段读进来。

### Step 2 打开面板

```bash
skillhub open
```

**这是常驻服务，必须放到后台跑**，否则会一直占着不返回。它会自己打开浏览器到 `http://127.0.0.1:7777`。

如果提示 already running，说明面板本来就开着，它会直接把页面打开，这不是错误。端口被别的程序占用时加 `--port 7788`。

### Step 3 对话里给摘要和下一步

面板打开之后，在对话里用一小段话说清楚三件事：**现在什么状况、最明显的两三个落差、接下来可以做什么**。

摘要要短，细节让用户看网页。下一步用编号列出来让他点菜，比如：

1. 分批补中文介绍（还缺 84 个，先做 15 个，随时可停）
2. 把没归类的 29 个归一归
3. 同步软链给某个 agent（先看计划再决定）
4. 逐条处理体检里的线索

不要一次把所有能做的都列出来，挑他这份数据里真正有落差的说。

## 补中文介绍和分类

这是最常被需要的两件事。很多 skill 是英文的，列表里扫过去认不出干什么用；分类规则靠关键词粗分一遍，中文小众领域会归不进去。规则只负责把大头分对，剩下的本来就是交给你和用户一起收拾，不必苛求规则本身多准。

`skillhub pending --json` 给出待补清单，每条带 name、description、当前分类，外加一份 `categories` 可选分类列表。逐个写回去：

```bash
skillhub describe <名字> "<中文介绍>"
skillhub categorize <名字> "<分类>"
```

中文介绍写一句话就够，说清楚"什么时候会用到它"比翻译原文有用。分类优先复用 `categories` 里已有的，用户有自己的叫法时也可以新建。

数量多就分批，每批做完报一下补了哪几个、还剩多少，让用户能随时喊停或改方向。

## 用哪些 agent 由用户决定

一台电脑未必每家 agent 都在用，没在用的一直显示"未启用"只会碍眼。

```bash
skillhub agents              # 看当前状态
skillhub agents cursor off   # 不用 Cursor
```

关掉之后它从看板和同步计划里消失，**已经建好的软链一根都不会删**，哪天再打开就是原样。目录压根不存在的 agent 默认就不显示。

同理，一个 skill 要不要同步给别家也是用户的选择。`skillhub sync` 不带参数只列计划，先跑一次给他看会新建哪些链接、影响哪几个 agent，点头之后再 `sync --apply`。

## 体检

体检是辅助功能，报出来的多数不紧急，别搞得吓人。

A 级是真损坏（缺 SKILL.md、缺 name 或 description、name 与目录名不一致、软链断了、目录里有疑似 API key），B 级是提醒（硬编码了别人的家目录、某个 skill 只有单个 agent 能读到），C 级是优化建议（description 偏长、SKILL.md 偏大）。

每条带 `owned` 字段：为真的是用户自己的 skill，改了算数；为假的来自随上游更新的 skill，本地改动会被下次升级覆盖。默认只列为真的，`--all` 两类都列。

汇报先看 A 级。没有就直接说"没有真问题"，剩下的当作可以慢慢处理的建议，不要逐条念完。规则是启发式的会有误报，讲成"值得看一眼的线索"就好。

## 依赖与运行前提

- 需要 **Node.js 20 或更新版本**，没有其他依赖。
- 数据都在本机：统一管理目录 `~/.agents/skills`，SkillHub 自己的配置和备份在 `~/.skillhub/`。
- 面板只监听本机回环地址，写接口要求同源请求加会话令牌，局域网访问不到。
- 联网只有三处：查自己有没有新版、面板上的 GitHub 热榜、从 git 安装或更新 skill。离线时这些降级，本地功能照常。
- **Windows**：npm 全局安装会生成 `skillhub.cmd`，命令名一样。但 `~` 在 cmd 和 PowerShell 里不会展开，路径要写 `%USERPROFILE%` 或 `$env:USERPROFILE`。软链走的是目录 junction，不需要管理员权限。

## 平台状态

- **macOS**：完整实测（安装、面板、同步、回滚全走过）。
- **Linux / Windows**：CI 三平台 × Node 20/22 全绿，但**没在真机上走完整流程**。首次在这两个系统上用，先跑 `skillhub sync` 看计划，确认路径对了再 `--apply`。
