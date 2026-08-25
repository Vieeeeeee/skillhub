# Changelog

All notable changes to SkillHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

An adversarial pre-release review of the whole project. The dominant defect was
one shape repeated in many places: reporting confident success for work that had
not happened.

### Fixed

- Commands no longer report success for writes that were skipped, lost, or never attempted. Concurrent metadata writes take a lock instead of overwriting each other, and an erased blurb stays erased across a rescan.
- The health report finds what actually breaks a Skill: invalid directory names, colliding trigger words, broken internal links, and non-Skill directories. An Agent's own directory being under git no longer marks every finding in the library as somebody else's problem.
- `--port` refuses a missing or unusable value; a positional argument may start with a dash; `undo` with nothing recorded is not a failure; a port already in use is probed before the message names a cause.
- Hiding an Agent takes effect in the registry, not only in the sync plan. A broken link stays visible in the inventory instead of disappearing from it.
- The leaderboard marks a repository installed only on a full `owner/repo` match. One local directory called `skills` used to claim three of them.
- A prerelease version number compares correctly instead of answering "no update" through NaN.
- A SKILL.md too large to parse is reported as exactly that, rather than as two missing frontmatter fields that are sitting in the file.
- Uninstalling falls back to copy-and-remove when the trash is on another filesystem.
- A link created outside SkillHub shows up without a manual rescan.
- Every dashboard control is reachable from the keyboard, modals close on Escape, and the smallest text on the page meets AA contrast. The header wraps instead of pushing Rescan out of the viewport.

### Added

- `remove`, `trash`, and `note` on the CLI, so an agent can do everything the dashboard can.
- Chinese blurbs count towards categorisation; writing them now improves the other main job instead of nothing.
- `scan --json --compact` returns the fields a caller decides with — about a third of the tokens.
- Content-Security-Policy and `nosniff` on dashboard responses.
- Test coverage for the CLI layer, which had none and held five of the seven most serious findings.

### Changed

- A run of metadata writes shares one backup session, so one `undo` returns the file to how it looked before the run. Backups keep the newest 100 sessions.
- The packaged rules no longer ship 61 hardcoded "Skill name → upstream repo" guesses. A source comes from a real git remote, or it is not shown.
- The dashboard leads with the two main jobs rather than one tile per Agent.
- Upgrade instructions install the published npm package instead of pulling a git checkout that was never made.
- The CI matrix includes Node 24, the version the release pipeline runs the suite on.

### Removed

- `hasUpdate`, `latestUpstream`, `lastChecked`, `aliasOf`, `upstreamPath`, `installedVersion` and `relPrefix`: fields and configuration that were written everywhere and read nowhere.

## [0.3.0] - 2026-08-24

First-contact fixes, after watching a real session start with `skillhub: command not found`.

### Added

- `skill-path` prints the packaged `skill/` directory, so installation instructions no longer guess an npm path.
- `--version` answers "is this installed?" before anything else runs.
- `pending`, `describe` and `categorize` let an agent fill in Chinese blurbs and categories without the dashboard.
- `agents <key> on|off` hides an agent you do not use. Existing links are never removed.

### Changed

- The Skill opens the dashboard as part of its flow and reports a short summary with numbered next steps, rather than printing tables into the conversation.
- Classification rules order specific categories ahead of generic ones, match ASCII keywords on word boundaries, and cover common Chinese terms. Added 投资 / 金融 and 商业 / 运营.
- Health findings carry an `owned` flag; upstream-managed results are folded away and `doctor --all` lists them.

### Fixed

- Starting the dashboard on a port that is already serving SkillHub opens that page instead of throwing an unhandled `EADDRINUSE` stack trace.

### Removed

- The legacy `skill-hub` binary alias. It collided with older installs and earned nothing.


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

[0.3.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.3.0
[0.2.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.2.0
