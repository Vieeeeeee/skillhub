# Changelog

All notable changes to SkillHub will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-26

A second adversarial review, this time aimed at the health report itself. The
dominant defect was a different shape: spending the reader's attention on things
that were not wrong, and offering buttons for work that could not be done.

### Changed

- `undo` now names the size of what it is about to reverse and waits for `--yes`
  when a backup session covers more than one write. A run of `describe`,
  `categorize` or `note` inside 30 minutes shares one session, so a single
  `undo` could take back dozens of hand-written blurbs — and when that batch
  also created `overrides.json`, reversing it removed the file with no copy to
  restore and no redo. The count used to be printed after the fact.
- The published package no longer ships the local design workspace. `files`
  names `web/index.html` instead of all of `web/`, taking the tarball from
  11.2 MB unpacked back to 315 kB.

### Fixed

- Underscored directory names are no longer reported. `my_diary` loads and
  triggers exactly like `my-diary`, and calling it broken spent the report's
  highest severity on Skills that work.
- The trash lists its contents when one entry is a dangling link. `statSync`
  followed the link, threw, and emptied the whole listing — telling the user
  their trash was empty while their uninstalled Skill sat in it.
- A path carrying somebody else's username reads as what it is. These arrive
  inside third-party Skills, cannot usefully be edited locally, and now sit in
  the background notes instead of the list of decisions to make.
- Backup copies (`.bak`, `.orig`, `.old`, `~`) are no longer scanned for
  hardcoded paths. No Agent loads them, so a finding there asked the user to fix
  a file nobody reads. Credential scanning still covers them.
- Findings that nothing can act on no longer claim to be fixable. Redundant
  Codex links and empty SSOT directories are advisory, and the recommendation
  now gives the command to run.
- A prerelease is superseded by its own release. `0.4.0-beta.1` compared equal
  to `0.4.0`, so anyone on a prerelease was told they were current on the day
  the stable version shipped.
- A leaderboard missing its seed repositories expires in an hour instead of a
  week, so one rate-limited moment no longer leaves the list short for days.

### Documentation

- Both READMEs list every mutating command, say that the dashboard runs in the
  foreground and stops with Ctrl-C, and state plainly that the read-only-looking
  commands still create directories, refresh a cache, and check npm once a day.
- `skill/SKILL.md` carries the full command list, including the seven mutating
  commands an agent previously had no way to learn, and the `undo` batching trap.

## [0.4.0] - 2026-08-25

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
- A Skill that exists only in `~/.codex/skills` is reported. Codex reads the shared directory natively, but the Skill Creator it ships with installs into its own folder, so a Skill made inside Codex was invisible to the inventory that exists to hold every Skill.
- Every dashboard control is reachable from the keyboard, modals close on Escape, and the smallest text on the page meets AA contrast. The header wraps instead of pushing Rescan out of the viewport.
- Restoring from the trash in the dashboard names the Skill it restored, instead of reporting "已恢复 undefined" after a restore that worked.
- A command that fails answers in JSON when the caller asked for JSON.
- The request-size ceiling is no longer bypassed by a request that declines to declare its size.
- `undo` takes the same lock the three writers take.

### Added

- A Skill that lives only inside one Agent's own folder is listed in the inventory, marked `仅 <Agent>`. It shows that Agent's trigger word and no other, and SkillHub offers no edit, category, or uninstall control for a directory it does not own.
- `remove`, `trash`, and `note` on the CLI, so an agent can do everything the dashboard can.
- Chinese blurbs count towards categorisation; writing them now improves the other main job instead of nothing.
- `scan --json --compact` returns the fields a caller decides with — about a third of the tokens.
- Content-Security-Policy and `nosniff` on dashboard responses.
- Test coverage for the CLI layer, which had none and held five of the seven most serious findings.

### Changed

- A run of metadata writes shares one backup session, so one `undo` returns the file to how it looked before the run — and says how many writes that covers, in both the CLI and the dashboard. A session is joined only while every file it recorded still matches what it recorded, so an edit made by hand in between ends the run instead of being silently discarded by the next undo. Backups keep the newest 100 sessions, counting only directories that hold a manifest.
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

[0.4.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.4.0
[0.3.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.3.0
[0.2.0]: https://github.com/Vieeeeeee/skillhub/releases/tag/v0.2.0
