---
name: skillhub
description: >-
  盘点和管理本地 AI Agent Skills：出一份现状报告并打开本地面板，再引导补中文介绍、归类、选择同步到哪些 agent。覆盖 Claude Code、Codex、Gemini、Cursor、Hermes。触发：技能太乱、整理技能、看看装了哪些技能、打开技能面板、技能体检。
---

# SkillHub

对本机全部 Agent Skills 做一次只读盘点，打开本地面板看现状，再按用户的选择去整理。流程：确认命令可用 → 只读盘点 → 打开面板 → 对话里给摘要和下一步。

## 铁律

- **盘点不碰用户的 skill。** `scan`、`pending`、`agents`、`doctor` 和不带参数的 `sync` 随便跑，它们只在 `~/.agents/skills`、`~/.skillhub/` 下建立自己的目录、清单缓存和版本检查缓存，一个 skill 目录都不动。
- **写操作先确认。** `sync --apply`、`link`/`unlink`、卸载这些动之前，把影响范围说清楚再等用户点头。即使用户说"你看着办"，也要先讲清楚会建哪些链接、动哪几个 agent。
- **不碰 skill 内容。** 中文介绍、分类、agent 可见性都只写 SkillHub 自己的配置（`~/.skillhub/`），SKILL.md 一个字节都不动。
- **卸载不是删除**，东西进 `~/.agents/_trash/`，随时能恢复。
- 每次写操作都留备份，`skillhub undo` 回滚上一次。

## 执行流程

### Step 0 确保命令可用

当前目录里有 `bin/skillhub` 时那就是 SkillHub 的源码仓库，用 `./bin/skillhub --version`，后续所有命令都走这个路径。否则跑 `skillhub --version`。有版本号就往下走。

这一步分清楚很重要：在源码仓库里装一份全局版，之后所有命令跑的都是 npm 那份，用户改的代码一点效果看不到，而且很难想到原因。

`skillhub` 报 command not found 就装一次：

```bash
npm install --global @wsiwsii/skillhub
```

全局安装因为权限失败时，装到固定位置再用绝对路径调用。macOS 和 Linux：

```bash
npm install --prefix ~/.skillhub/cli @wsiwsii/skillhub
node ~/.skillhub/cli/node_modules/@wsiwsii/skillhub/bin/skillhub --version
```

Windows 的 PowerShell 不展开 `~`，路径要写 `$env:USERPROFILE`：

```powershell
npm install --prefix "$env:USERPROFILE\.skillhub\cli" @wsiwsii/skillhub
node "$env:USERPROFILE\.skillhub\cli\node_modules\@wsiwsii\skillhub\bin\skillhub" --version
```

装完再确认一次版本号，后续所有命令都用同一个调用方式。

### Step 1 只读盘点

```bash
skillhub scan --json --compact   # 装了哪些、分类、各 agent 可见性
skillhub agents --json           # 在用哪些 agent
skillhub pending --json          # 还缺中文介绍或还没归类的
skillhub doctor --json           # 体检
```

`--compact` 只给做判断要用的字段：描述、分类、有没有中文介绍、哪些 agent 能读到。技能两百个左右时它约是完整清单的三分之一。需要来源、commit、软链目标这些细节时才去掉它，那份完整输出在大库上足以占满上下文。

同步和可见性上拿不准时，读 [references/agents.md](references/agents.md)——那里讲各家 agent 的实际行为（谁需要软链、触发名的两套规则、哪些自管的 skill 不该动）。

### Step 2 打开面板

```bash
skillhub open
```

**这是常驻服务，必须放到后台跑**，否则会一直占着不返回。它会自己打开浏览器到 `http://127.0.0.1:7777`。

提示 already running 说明面板本来就开着，它会直接把页面打开，这不是错误。

### Step 3 对话里给摘要和下一步

面板打开之后，在对话里用一小段话说清楚三件事：**现在什么状况、最明显的两三个落差、接下来可以做什么**。

摘要要短，细节让用户看网页。下一步用编号列出来让他点菜，比如：

1. 分批补中文介绍（还缺 84 个，先做 15 个，随时可停）
2. 把没归类的 29 个归一归
3. 同步软链给某个 agent（先看计划再决定）

挑他这份数据里真正有落差的说，不要把所有能做的都列一遍。

## 补中文介绍和分类

这是最常被需要的两件事。很多 skill 是英文的，列表里扫过去认不出干什么用；分类规则靠关键词粗分一遍，中文小众领域会归不进去。规则只负责把大头分对，剩下的本来就是交给你和用户一起收拾，不必苛求规则本身多准。

`skillhub pending --json` 给出待补清单，每条带 name、description、当前分类，外加一份 `categories` 可选分类列表。逐个写回去：

```bash
skillhub describe <名字> "<中文介绍>"
skillhub categorize <名字> "<分类>"
```

中文介绍写一句话就够，说清楚"什么时候会用到它"比翻译原文有用。分类优先复用 `categories` 里已有的，用户有自己的叫法时也可以新建。

数量多就分批，每批做完报一下补了哪几个、还剩多少，让用户能随时喊停或改方向。

面板上的 GitHub 热榜是同一件事的另一半：那 40 多个仓库的描述全是英文原文，而用户正是在这儿决定要不要装。带他看热榜时顺手把描述讲成中文，一句话说清这东西干什么、跟他已经装的哪个重复了。这不需要工具支持，本来就是你比工具擅长的部分。

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

结果分三级：A 级是真损坏（缺 SKILL.md、缺 name 或 description、name 与目录名不一致、软链断了、目录里有疑似 API key），B 级是提醒（硬编码了别人的家目录、某个 skill 只有单个 agent 能读到），C 级是优化建议。

**A 级一律列出来。**密钥泄露、软链断掉这类事不会因为这个 skill 随上游更新就变得不重要。

B 级和 C 级要同时满足两个条件才默认显示：是用户自己的 skill，并且确实存在"要不要动它"这个决定。描述偏长、文件偏大、扫描覆盖不全属于背景信息，没有决策，默认不列，`--all` 才看得到。

每条带 `owned` 字段：为真的是用户自己的 skill，改了算数；为假的来自随上游更新的 skill，本地改动会被下次升级覆盖，只作参考。

汇报先看 A 级。没有就直接说"没有真问题"，剩下的当作可以慢慢处理的建议。规则是启发式的会有误报，讲成"值得看一眼的线索"就好。

## 汇报的口吻

写成产品说明，不是开发日志。直接讲这是什么、为什么值得处理、该往哪儿走。

不要写"我发现""提醒注意""看起来像是""踩到一个坑"这类暴露排查视角的话。用户要的是当前状况和下一步，不是你怎么查出来的。

数字如实说。估算的标明是估算，没验证的说没验证，误报可能存在就直说规则是启发式的。

## 排障

| 现象 | 原因和解法 |
|---|---|
| `skillhub: command not found` | 没装或不在 PATH。回 Step 0 装一次，再 `skillhub --version` 确认 |
| 面板打不开、浏览器空白 | 端口被别的程序占了，换 `skillhub open --port 7788` |
| 提示 already running | 面板本来就开着，不是错误，页面会自动打开 |
| 改了分类或中文介绍，列表没变 | 面板缓存了，点「重新扫描」，或跑一次 `skillhub scan` |
| `sync --apply` 说"全部已同步，没有可执行的动作" | 该建的链接都在了。如果它说"计划里的 N 项都是另一类动作"，那是些坏链接，用 `sync --fix-broken` 清 |
| 某个 agent 那列一直空着 | 可能是它压根没在用，`skillhub agents` 看状态，不用就关掉 |
| Codex 那列不能点 | 它原生读统一管理目录，没有链接可建可删。整列不想看就 `skillhub agents codex off` |
| 装了 skill 但 agent 里触发不了 | 会话是启动时加载技能列表的，要开一个新会话 |

## 依赖与运行前提

- 需要 **Node.js 20 或更新版本**，没有其他依赖。
- 数据都在本机：统一管理目录 `~/.agents/skills`，SkillHub 自己的配置和备份在 `~/.skillhub/`。
- 面板只监听本机回环地址，写接口要求同源请求加会话令牌，局域网访问不到。
- 联网只有三处：查自己有没有新版、面板上的 GitHub 热榜、从 git 安装或更新 skill。离线时这些降级，本地功能照常。
- **Windows**：npm 全局安装会生成 `skillhub.cmd`，命令名一样。`~` 在 cmd 和 PowerShell 里不展开，路径要写 `%USERPROFILE%`。软链走目录 junction，不需要管理员权限。

## 平台状态

- **macOS**：完整实测（安装、面板、同步、回滚全走过）。
- **Linux / Windows**：CI 三平台 × Node 20/22 全绿，但**没在真机上走完整流程**。首次在这两个系统上用，先跑 `skillhub sync` 看计划，确认路径对了再 `--apply`。
