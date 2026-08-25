# 各家 Agent 的实际行为

分析同步和可见性问题时读这份。讲的是判断，不是路径表——路径在 `rules/agents.json` 里。

## 谁需要软链，谁不需要

| Agent | 目录 | 机制 |
|---|---|---|
| Claude Code | `~/.claude/skills` | 需要软链 |
| Codex | `~/.agents/skills`（统一管理目录本身） | **原生扫描，不需要软链** |
| Gemini CLI | `~/.gemini/config/skills` | 需要软链 |
| Hermes | `~/.hermes/skills/claude-skills` | 需要软链 |
| Cursor | `~/.cursor/skills` | 需要软链，实验性 |

Codex 那条最容易搞错：**它直接读统一管理目录**，所以面板上它永远显示"全部可见"。逐个 skill 的勾选格对它是灰的——不是坏了，是没有链接可建可删。

但整个 agent 的开关对它照样有效：`skillhub agents codex off` 之后，Codex 那一列、它的触发词、同步计划里跟它有关的部分都不再出现。这是"我不用这个 agent，别在界面上占位置"，不是"不让 Codex 读到 skill"——Codex 读不读取决于它自己扫不扫那个目录，SkillHub 管不着，也没打算管。

Codex 还会扫仓库级的 `.agents/skills` 和 `~/.codex/skills`。往 `~/.codex/skills` 里补软链是多余的——统一管理目录它本来就读。

`~/.codex/skills` 还有一个身份：**Codex 自己的 Skill Creator 默认装在那儿**（`$CODEX_HOME/skills/<name>`）。所以在 Codex 里现做的 skill，只有 Codex 看得见，别家 agent 一无所知。这类 skill 会出现在清单里，类型标成「仅 <Agent>」，触发词只显示那个 agent 的——它的实体不在统一管理目录，SkillHub 只读不写，补中文介绍和分类都得先把它搬进 `~/.agents/skills`。同步计划里也会有一条 `report-agent-orphan`。名字在统一管理目录里已经存在的副本不报——那是别的工具自己维护的拷贝，动它会在下次升级时被覆盖回去。

## 触发名的两套规则

Claude 用**目录名**（`/名字`），Codex 用 **frontmatter 里的 name**（`$名字`）。

这两个不一致时，同一个 skill 在两端要用不同的命令触发，用户会以为其中一个坏了。体检里的 `name-mismatch` 就是查这个，属于真损坏，值得修。

## 自带管理机制的 skill 不要动

有些工具会把自己的 skill 拷贝一份进 agent 目录，并且自己负责升级——gstack 就是这样，它往 `~/.claude/skills` 放 50 多个，由 `gstack-upgrade` 维护。

这类目录看起来像"没纳入统一管理的孤儿"，但**收编它们会在下次升级时被覆盖回去**。判断依据：统一管理目录里已经有同名条目，或者它属于某个自带升级命令的工具包。遇到就放着不动。

## 刻意的双版本

个别 skill 会在两端保留不同内容，比如同一个名字在 Claude 和 Codex 侧各写一份、互相指挥对方施工。这是设计，不是分叉。看到两端内容不同先问用户是不是故意的，不要直接判为需要统一。

## 上游管理的 skill 改了会白改

来自 git 仓库或 bundle 的 skill，本地怎么改都会被下次 `update` 覆盖。体检结果里 `owned` 为假的就是这类，只作参考，别建议用户去改。

## 卸载和恢复

卸载不是删除，东西进 `~/.agents/_trash/`，面板的回收站能恢复。软链型的条目只是解除链接，本体在别处，本来就不会丢。

## Windows

软链走目录 junction，不需要管理员权限。但 junction 只认绝对路径，也只能指向本地卷，不能跨网络位置。

`~` 在 cmd 和 PowerShell 里不会展开，路径要写 `%USERPROFILE%` 或 `$env:USERPROFILE`。

macOS 和 Windows 的文件系统默认不区分大小写，Linux 区分。`~/.codex` 和 `~/.Codex` 在前两者上是同一个目录，在 Linux 上不是——写死路径时按小写来。
