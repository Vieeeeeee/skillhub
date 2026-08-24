# Changelog

All notable changes to SkillHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-24

First-contact fixes, after watching a real session start with `skillhub: command not found`.

- `skill-path` prints the packaged `skill/` directory, so installation instructions no longer guess an npm path.
- `--version` answers "is this installed?" before anything else runs.
- Starting the dashboard on a port that is already serving SkillHub opens that page instead of throwing an unhandled `EADDRINUSE` stack trace.
- Dropped the legacy `skill-hub` binary alias. It collided with older installs and earned nothing.
- The Skill now opens the dashboard as part of its flow and reports a short summary with numbered next steps, rather than printing tables into the conversation.
- Classification rules order specific categories ahead of generic ones, match ASCII keywords on word boundaries, and cover common Chinese terms. Added 投资 / 金融 and 商业 / 运营.
- `pending`, `describe` and `categorize` let an agent fill in Chinese blurbs and categories without the dashboard.
- `agents <key> on|off` hides an agent you do not use. Existing links are never removed.
- Health findings carry an `owned` flag; upstream-managed results are folded away and `doctor --all` lists them.


## [0.2.0] - 2026-08-24

### Added

- Local dashboard and CLI for inventory, health checks, Agent visibility, and explicit link management.
- Support for Claude, Codex, Gemini, Hermes, and an experimental Cursor adapter.
- Reversible manifests for supported link, metadata, sync, and uninstall operations.
- Staged installation of single-Skill public GitHub repositories with structural and size checks.
- Cross-platform CI coverage for Linux, macOS, and Windows on Node.js 20 and 22.

### Security

- Restricted the dashboard to loopback addresses with same-origin, JSON content type, and session-token checks for writes.
- Added managed-root and real-path validation for filesystem operations.
- Disabled interactive Git credentials and LFS smudging during third-party repository installation.
- Added heuristic checks for likely secrets, unsafe paths, broken links, and oversized files.

### Known limitations

- Health checks reduce accidental exposure but do not provide malware analysis or sandbox third-party Skills.
- Undo is best effort and cannot cover an unexpected crash between a filesystem change and its manifest write.
- Cursor support remains experimental; Windows junction behavior depends on local policy and permissions.

[0.2.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.2.0
