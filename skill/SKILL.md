---
name: skillhub
description: 本地 AI Agent Skills（Claude Code / Codex / Gemini / Hermes）的统一只读体检、多 Agent 软链同步与分类管理工具。当用户询问技能体检、技能排障、技能重复或缺失、管理与更新技能时使用。
version: 1.0.0
---

# SkillHub 技能管理与体检助手

SkillHub 是管理和维护本地全部 AI Agent Skills 的中枢系统。通过只读体检规则、跨平台软链抽象和安全回滚机制，帮助用户安全地管理各 Agent 的技能。

## 适用场景与触发规则

当用户提出以下需求时激活此 Skill：
1. **技能体检与排障**："给我的 skill 做个体检"、"检查下哪些 skill 有问题"、"排查坏链"、"检查密钥泄露"。
2. **多 Agent 状态查看**："看一下我装了哪些 skill"、"Claude 和 Codex 能读到哪些技能"、"打开 skill 面板"。
3. **分类与元数据整理**："帮我把没分类的 skill 归类"、"补充中文介绍"。
4. **回滚与撤销**："撤销刚才的 skill 操作"、"恢复误删的 skill"。

## 核心操作命令

执行命令行工具 `skillhub`：

```bash
# 1. 只读体检（输出结构损坏、密钥泄露、过时路径与超长描述问题）
skillhub doctor --json

# 2. 扫描 SSOT 与各 Agent 目录中的技能列表与状态
skillhub scan --json

# 3. 查看待执行的同步计划（默认不执行）
skillhub sync

# 4. 启动本地 Web 面板
skillhub open

# 5. 尝试回滚最近一次有备份记录的操作
skillhub undo
```

## 执行纪律（严格遵守）

1. **只读优先**：默认仅执行 `doctor` 与 `scan` 进行只读检查，并用大白话向用户汇报事实与修复建议。
2. **写操作先确认**：执行 `--apply`、`--fix-broken` 或 `unlink` 前，必须让用户确认具体作用范围。
3. **如实说明回滚范围**：只有返回备份会话的可逆操作才可以尝试 `skillhub undo`；Git 更新和外部仓库变化需要用 Git 或常规备份恢复。
