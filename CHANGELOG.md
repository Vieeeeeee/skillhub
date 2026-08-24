# Changelog

All notable changes to SkillHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
