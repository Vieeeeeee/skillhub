---
name: skillhub
description: 管理本地 AI Agent Skills：看板盘点、补中文介绍、归类、选择同步到哪些 agent、更新和卸载，附带健康体检。覆盖 Claude Code、Codex、Gemini、Cursor、Hermes。用户说技能太乱、想整理技能、看看装了什么、打开技能面板时使用。
version: 1.3.0
---

# SkillHub

SkillHub 管理这台电脑上的 AI Agent Skills：装了哪些、放在哪儿、哪家 agent 能读到、分别是干什么用的。

各家 agent 的目录不一样——Claude Code 读 `~/.claude/skills`，Codex 原生扫 `~/.agents/skills`，Gemini、Cursor、Hermes 各有各的位置。统一管理目录是 `~/.agents/skills`，放在这里的 skill 可以同步给其他 agent；只待在某个 agent 目录里的 skill 也能正常用，只是别家读不到。

## 用户第一次进来的时候

先跑 `skillhub scan --json` 和 `skillhub pending --json`，用真实数字告诉他现在是什么状况，再说清楚在这儿能做哪几件事。比如"你有 211 个 skill，93 个还没有中文介绍，30 个没归类；你配了 5 个 agent，其中 cursor 只链了 8 个"——这样他才知道有哪些活儿可以派给你。

不用把所有命令念一遍，挑他这份数据里真正有落差的两三件说。

## 能做的事

| 命令 | 它做什么 |
|---|---|
| `skillhub scan` | 列出所有 skill、来源、分类、各 agent 可见性 |
| `skillhub pending` | 列出还缺中文介绍或还没归类的 skill |
| `skillhub describe <名字> "<中文介绍>"` | 写中文介绍 |
| `skillhub categorize <名字> "<分类>"` | 归类 |
| `skillhub agents` | 看在用哪些 agent；`agents <名字> on\|off` 开关 |
| `skillhub sync` | 显示待办的软链计划，不执行 |
| `skillhub sync --apply` | 补齐缺失的软链 |
| `skillhub link/unlink <名字> <agent>` | 单个开关某家 agent |
| `skillhub update <名字>` | 拉取上游更新 |
| `skillhub doctor` | 健康体检 |
| `skillhub undo` | 回滚最近一次写操作 |
| `skillhub open` | 打开本地面板 |

`--json` 可以拿到结构化输出。

## 补中文介绍和归类

这是最常被需要的两件事。很多 skill 是英文的，列表里看过去认不出是干什么的；分类规则靠关键词粗粗分一遍，遇到中文小众领域会归不进去。

规则只负责把大头分对，剩下的本来就是交给你和用户一起收拾的，不必追求规则本身有多准。

`skillhub pending --json` 给出待补清单，每条带 name、description、当前分类，外加一份 `categories` 可选分类列表。读完逐个调 `describe` 和 `categorize` 写回去。

中文介绍写一句话就够，说清楚"什么时候会用到它"，比翻译原文有用。分类优先复用 `categories` 里已有的，用户有自己的叫法时也可以新建。

数量多的时候分批做，每批做完报一下这批补了哪几个、还剩多少，让用户能随时喊停或改方向。

## 用哪些 agent 由用户决定

一台电脑上未必每家 agent 都在用。没在用的那些如果一直显示"未启用"，只会碍眼。

`skillhub agents` 列出当前状态。用户说他不用 Cursor，就 `skillhub agents cursor off`——这个 agent 从看板和同步计划里消失，但**已经建好的软链一根都不会删**，哪天再打开就是原样。目录压根不存在的 agent 默认就不显示。

同理，一个 skill 要不要同步到其他 agent 也是用户的选择。`skillhub sync` 不带参数只列计划，先跑一次给用户看会新建哪些链接、影响哪几个 agent，等他点头再跑 `--apply`。

## 体检

体检是辅助功能，报出来的东西大多不紧急。

`skillhub doctor` 分三级：A 级是真损坏（缺 SKILL.md、缺 name 或 description、name 与目录名不一致、软链断了、目录里有疑似 API key），B 级是提醒（硬编码了别人的家目录、某个 skill 只有单个 agent 能读到），C 级是优化建议（description 偏长、SKILL.md 偏大）。

每条带一个 `owned` 字段。为真的是用户自己的 skill，改了算数；为假的来自随上游更新的 skill，本地改动会被下次升级覆盖。默认只列为真的，`--all` 才两类都列。

汇报时先看 A 级有没有。没有就直接说"没有真问题"，剩下的当作可以慢慢处理的建议，不要逐条念完吓人。规则是启发式的会有误报，讲成"值得看一眼的线索"就好。

## 做完要让用户看见

每次写操作之后说清楚三件事：改了什么、现在是什么状态、怎么撤销。

比如补完中文介绍就说"这 12 个补好了，还剩 81 个"；同步完就说"给 gemini 补了 7 条链接，claude 那边本来就全"；跑完 `sync --apply` 顺带提一句 `skillhub undo` 能整批回滚。

用户想自己看的时候，`skillhub open` 打开面板，看板上有分类分布、各 agent 覆盖情况和体检摘要。

## 安全边界

`scan`、`pending`、`agents`、`doctor`、`sync` 不带参数时都只读，跑多少次都安全。

会写文件的是：`sync --apply` 新建软链、`sync --fix-broken` 删坏链、`link`/`unlink` 开关单个链接、`describe`/`categorize` 写配置、`agents on/off` 写配置、卸载移入回收站。它们都留备份，`undo` 能回滚。

隐藏 agent、写中文介绍、改分类都只动 SkillHub 自己的配置文件，不碰 skill 内容。

卸载不是真删，东西进 `~/.agents/_trash/`，面板的回收站能恢复。

`update` 走 `git pull --ff-only`，属于 git 的范畴，`undo` 管不到，用 git 自己恢复。

面板只监听本机回环地址，写接口要求同源请求加会话令牌。
