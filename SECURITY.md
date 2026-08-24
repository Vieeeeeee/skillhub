# Security Policy

SkillHub is a local filesystem tool. Treat third-party Skills and Git repositories as untrusted code, review a sync plan before applying it, and keep a separate backup of important Skills.

---

## Safety controls

### Permission levels

| Tier | Commands | Permissions | Trigger Method |
|---|---|---|---|
| **Read-Only** (Default) | `scan` / `doctor` / `list` | Reads skill folders and may refresh cache/state under `~/.skillhub/` | Direct invocation |
| **Link changes** | `link` / `unlink` / `sync --apply` / `sync --fix-broken` | Creates or removes validated links and records supported reversible steps | Explicit command or dashboard action |
| **Data and Git changes** | Add / uninstall / update | Stages a clone, moves data to Trash, or runs `git pull --ff-only` | Explicit command or confirmed dashboard action; Git updates are outside SkillHub Undo |

---

### Traceable operations and rollback (`skillhub undo`)

Operations that return a backup session record their reversible steps under `~/.skillhub/backups/`. `skillhub undo` attempts to reverse the latest eligible manifest in LIFO order. This is a convenience rollback mechanism, not a replacement for a filesystem backup; Git pulls and external repository changes may not be reversible by SkillHub.

---

### Filesystem and local API guardrails

- **Refusal to Unlink Real Files**: If an `unlink` is requested on a path that is a regular file/directory instead of a symlink/junction, SkillHub raises a safety violation and halts.
- **Root Validation**: Managed file operations validate lexical and resolved paths against configured user Skill roots (`~/.agents`, link-based Agent roots, and `~/.skillhub`).
- **Path Traversal Prevention**: All input paths and skill names are filtered against path traversal attempts (`..`, `/`, `\`, null bytes, colon).
- **Recycle Bin (Trash) Uninstallation**: When a real skill is uninstalled, it is moved to `~/.agents/_trash/` rather than destroyed with `rm -rf`.
- **CSRF & Local Origin Defense**: The local API binds only to a loopback host, requires a session token for writes, validates same-origin browser requests, and accepts only JSON write payloads.

---

## 🔒 Reporting Vulnerabilities

Please do not disclose a vulnerability in a public issue. Report it privately through [GitHub Security Advisories](https://github.com/Vieeeeeee/skillhub/security/advisories/new). Include the affected version, reproduction steps, and impact; omit real credentials and personal paths.
