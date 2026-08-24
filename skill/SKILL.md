---
name: skillhub
description: 管理本地 AI Agent Skills：查看装了哪些、同步到各家 agent、补中文介绍、归类、更新和卸载，顺带做健康体检。覆盖 Claude Code、Codex、Gemini、Cursor、Hermes。用户说技能太乱、想整理技能、看看装了什么、打开技能面板时使用。
version: 1.2.0
---

# SkillHub

SkillHub 管理这台电脑上的 AI Agent Skills。它知道装了哪些、分别放在哪儿、哪家 agent 能读到，也负责补中文介绍、归类、更新、卸载和跨 agent 同步。

各家 agent 的目录不一样——Claude Code 读 `~/.claude/skills`，Codex 原生扫 `~/.agents/skills`，Gemini、Cursor、Hermes 各有各的位置。SkillHub 把这些一起扫，用户当前在用哪个 agent 都不影响。

统一管理目录是 `~/.agents/skills`。放在这里的 skill 可以一键同步给其他 agent；只待在某个 agent 目录里的 skill 也能正常用，只是别家读不到。

## 常用操作

| 命令 | 它做什么 |
|---|---|
| `skillhub scan` | 列出所有 skill、来源、分类、各 agent 可见性 |
| `skillhub pending` | 列出还缺中文介绍或还没归类的 skill |
| `skillhub describe <名字> "<中文介绍>"` | 写中文介绍 |
| `skillhub categorize <名字> "<分类>"` | 归类 |
| `skillhub sync` | 显示待办的软链计划，不执行 |
| `skillhub sync --apply` | 补齐缺失的软链 |
| `skillhub link/unlink <名字> <agent>` | 单个开关某家 agent |
| `skillhub update <名字>` | 拉取上游更新 |
| `skillhub doctor` | 健康体检 |
| `skillhub undo` | 回滚最近一次写操作 |
| `skillhub open` | 打开本地面板 |

`--json` 可以拿到结构化输出。

## 补中文介绍和归类

这是最常被需要的两件事。很多 skill 是英文的，列表里看过去认不出是干什么的；分类规则靠关键词，遇到中文小众领域会归不进去。

`skillhub pending --json` 会给出待补清单，每条带 name、description、当前分类，以及一份 `categories` 可选分类列表。读完之后逐个调 `describe` 和 `categorize` 写回去。

中文介绍写一句话就够，说清楚"什么时候会用到它"，比翻译原文有用。分类优先复用 `categories` 里已有的，用户有自己的叫法时也可以新建。

这两个动作只写 SkillHub 自己的配置文件，不碰 skill 内容，写之前会留备份，`undo` 能回滚。

## 同步这件事由用户决定

一个 skill 要不要软链到其他 agent，是用户的选择。有人只用一个 agent，同步得到处都是反而是干扰；有人希望几家都读到同一份。

`skillhub sync` 不带参数只列计划，可以先跑一次给用户看，说明会新建哪些链接、影响哪几个 agent，等用户点头再跑 `--apply`。

## 体检

体检是个辅助功能，不是重点，报出来的东西大多不紧急。

`skillhub doctor` 分三级：A 级是真损坏（缺 SKILL.md、缺 name 或 description、name 与目录名不一致、软链断了、目录里有疑似 API key），B 级是提醒（硬编码了别人的家目录、某个 skill 只有单个 agent 能读到），C 级是优化建议（description 偏长、SKILL.md 偏大）。

每条带一个 `owned` 字段。`owned` 为真的是用户自己的 skill，改了算数；为假的来自随上游更新的 skill，本地改动会被下次升级覆盖，知道即可。默认只列 `owned` 为真的，`--all` 才两类都列。

汇报的时候先看 A 级有没有，没有就直接说"没有真问题"，剩下的当作可以慢慢处理的建议，不必逐条念完。规则是启发式的，会有误报，讲成"值得看一眼的线索"就好。

## 安全边界

`scan`、`pending`、`doctor`、`sync` 不带参数时都只读，跑多少次都安全。

会写文件的是：`sync --apply` 新建软链、`sync --fix-broken` 删坏链、`link`/`unlink` 开关单个链接、`describe`/`categorize` 写配置、卸载移入回收站。它们都留备份，`undo` 能回滚。

`update` 走 `git pull --ff-only`，属于 git 的范畴，`undo` 管不到，用 git 自己恢复。

卸载不是真删，东西进 `~/.agents/_trash/`，面板的回收站能恢复。

面板只监听本机回环地址，写接口要求同源请求加会话令牌。
