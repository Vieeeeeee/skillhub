---
name: skillhub
description: 体检和盘点本地 AI Agent Skills，覆盖 Claude Code、Codex、Gemini、Cursor、Hermes 各家目录。用户问技能有没有毛病、技能太乱、密钥泄露、哪个 agent 能读到哪些技能、打开技能面板、撤销技能操作时使用。Inspect and inventory local Agent Skills across every agent directory.
version: 1.1.0
---

# SkillHub

SkillHub 是一个本地命令行工具加网页面板，用来看清楚这台电脑上装了哪些 Agent Skills、它们的健康状况如何、各家 agent 分别能读到哪几个。它默认只读：`doctor` 和 `scan` 不改动任何 skill 的内容，只把事实摆出来。

用户装 skill 的地方各不相同——Claude Code 读 `~/.claude/skills`，Codex 原生扫 `~/.agents/skills`，Gemini、Cursor、Hermes 各有各的目录。SkillHub 把这些目录一起扫，所以用户当前在用哪个 agent 都不影响体检结果。

## 什么时候用得上

用户说"给我的 skill 做个体检"、"看看哪个 skill 有问题"、"我的技能太乱了"、"有没有 API key 泄露"，说的就是 `doctor`。

用户说"我装了哪些 skill"、"Claude 和 Codex 分别能读到什么"、"打开面板看看"，说的是 `scan` 和 `open`。

用户说"撤销刚才那步"、"恢复一下"，说的是 `undo`。

## 命令

| 命令 | 它做什么 | 动不动文件 |
|---|---|---|
| `skillhub doctor` | 跑全部体检规则，输出 A/B/C 三级问题清单 | 只读 |
| `skillhub scan` | 列出统一管理的 skill、来源、分类、各 agent 可见性 | 只读 |
| `skillhub sync` | 显示待办的软链计划，不执行 | 只读 |
| `skillhub sync --apply` | 按计划补齐缺失的软链 | 只新建软链，留备份 |
| `skillhub sync --fix-broken` | 清掉指向空处的坏软链 | 只删坏链，留备份 |
| `skillhub open` | 起本地面板，默认 `http://127.0.0.1:7777` | 只写自己的缓存 |
| `skillhub undo` | 回滚最近一次有备份记录的写操作 | 反向恢复 |

加 `--json` 可以拿到结构化输出，便于把结果讲给用户听。

## 体检查什么

A 级是真损坏：SKILL.md 缺失、frontmatter 缺 name 或 description、frontmatter 的 name 与目录名对不上（会导致两端触发命令不一致）、软链断掉、目录里躺着疑似 API key 或 `.env` 文件。

B 级是过时与隔离：硬编码了别人的绝对家目录、某个 skill 只有单个 agent 能读到。

C 级是体积：description 超过 200 字（每次会话都要加载，是天天在烧的 token）、SKILL.md 行数过大。

体检结果里的 `location` 字段说明这个 skill 的实体目录在哪儿。没有这个字段的，就在统一管理目录 `~/.agents/skills` 里。

每条结果还带一个 `owned` 字段。`owned` 为真的是用户自己的 skill，改了就算数；为假的来自随上游更新的 skill，本地改动会被下次升级覆盖，属于知道即可。默认报告只列 `owned` 为真的，`skillhub doctor --all` 才把两类都列出来。用户问"我这怎么这么多问题"时，先按这条分开讲，通常能处理的那部分要少得多。

## 同步这件事由用户决定

一个 skill 要不要软链到其他 agent，是用户的选择，不是可以替他做的默认动作。有人只用一个 agent，把技能同步得到处都是反而是干扰；有人希望三家都能读到同一份。

所以体检发现"仅单个 Agent 可见"时，合适的做法是把情况讲清楚——这个 skill 现在只有某个 agent 能读到，保持现状完全能正常用，如果希望其他 agent 也能用，需要哪一步——然后让用户回答。用户点头之后再跑 `sync --apply`。

`sync` 不带参数时只是列计划，可以放心先跑一次给用户看，再问他要不要执行。

## 安全边界

写操作只有三个：`sync --apply` 新建软链、`sync --fix-broken` 删除坏链、`undo` 反向恢复。它们都会写一份备份清单，`undo` 能回滚。

`doctor` 和 `scan` 不碰用户的 skill 内容，跑多少次都安全。

`update` 走的是 `git pull --ff-only`，属于 git 的范畴，`undo` 管不到它，用 git 自己恢复。

面板只监听本机回环地址，写接口要求同源请求加会话令牌。

## 把结果讲给用户

体检输出是给人看的，不是原样贴出来。合适的做法是先说结论——几个真问题、有没有密钥泄露这类要紧的——再按严重度展开，每条说清楚是什么、为什么要紧、怎么修。

发现疑似密钥泄露时值得单独强调一句，因为 skill 目录经常会被同步或分享出去。

规则是启发式的，会有误报。把它当作"值得看一眼的线索"讲给用户，而不是判决。
