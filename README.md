# SkillHub

Manage, inspect, and connect AI Agent Skills from one local source of truth.

[![CI](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml/badge.svg)](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@wsiwsii/skillhub.svg)](https://www.npmjs.com/package/@wsiwsii/skillhub)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文说明](./README.zh-CN.md)

> **Project status: pre-release.** The packaged CLI has been verified locally on macOS, including a global-install/dashboard smoke test. The current commit also passes the GitHub Actions matrix on Linux, macOS, and Windows with Node.js 20 and 22. Review the permission and third-party Skill sections before using write commands.

SkillHub inventories the Skills on your machine, shows which Agents can see each one, helps you label and categorise them, and creates only the links you explicitly request. Canonical Skills live under `~/.agents/skills`. The web dashboard stays on your computer and refuses non-loopback bind addresses.

## Quick start

The npm install requires Node.js 20 or newer. Running from source also requires Git.

Install the public CLI from npm:

```bash
npm install --global @wsiwsii/skillhub

# Inspect without changing Skill contents
skillhub doctor
skillhub scan

# Open the local dashboard at http://127.0.0.1:7777
skillhub open
```

Prefer running from source? Git remains fully supported:

```bash
git clone https://github.com/Vieeeeeee/skillhub.git
cd skillhub
npm ci

# Inspect without changing Skill contents
./bin/skillhub doctor
./bin/skillhub scan

# Open the local dashboard at http://127.0.0.1:7777
./bin/skillhub open
```

Update the npm CLI with `npm install --global @wsiwsii/skillhub@latest`. Update a source checkout with:

```bash
git pull --ff-only
npm ci
npm test
```

## What it does

| Capability | Result |
|---|---|
| Inventory | Lists Skills, sources, categories, Agent visibility, and structural metadata. |
| Labels and categories | Rules give every Skill a first-pass category. `pending` lists what is still unlabelled; `describe` and `categorize` write the rest. Both touch only SkillHub's own config, never Skill contents. |
| Link management | Creates or removes Agent links without replacing a real directory. |
| Agents in use | An Agent you do not use is hidden from the dashboard and left out of sync planning. Hiding never deletes existing links, and an Agent whose directory does not exist is hidden by default. |
| Sync planning | Shows the full plan first. `sync --apply` creates missing links only; `--fix-broken` removes broken links only. |
| Health checks | Flags missing frontmatter, broken links, hardcoded home paths, oversized files, and likely secret patterns, across canonical Skills and Skill directories that still sit inside an Agent folder. Read-only. Each finding says whether you can act on it: results inside upstream-managed Skills are informational, since an upgrade overwrites local edits (`doctor --all` lists those too). These checks are heuristic. |
| Git updates | Fast-forwards an individual Git-managed Skill or each unique bundle once. Partial failures remain visible. |
| Uninstall and restore | Moves real Skill directories to `~/.agents/_trash/`; link-only entries are unlinked. |
| Local dashboard | Provides the same inventory and explicit actions through a token-protected loopback API. |

## How it is organized

```text
~/.agents/skills/                     canonical Skill directories or links
~/.agents/_repos/                     managed multi-Skill repositories
~/.agents/_trash/                     locally removed Skill data
~/.skillhub/registry.json             generated inventory cache
~/.skillhub/overrides.json            local labels, categories, and Agent choices
~/.skillhub/backups/                  manifests for supported reversible operations
~/.skillhub/session                   local dashboard token (mode 0600 on POSIX)

~/.claude/skills/<name>               link to the canonical Skill
~/.gemini/config/skills/<name>         link to the canonical Skill
~/.hermes/skills/claude-skills/<name> link to the canonical Skill
~/.cursor/skills/<name>                experimental adapter
```

Agent paths come from [`rules/agents.json`](./rules/agents.json). Native discovery, such as the current Codex adapter, does not create a second copy. Link-based adapters use relative symlinks on POSIX and directory junctions on Windows.

## Permissions and side effects

Review this table before using write commands:

| Action | Reads | Writes | Undo boundary |
|---|---|---|---|
| `scan`, `list`, `doctor` | Skill and Agent directories | Cache/state under `~/.skillhub/` | Does not modify Skill contents. |
| `open` | Same local data | Session token, registry, and caches under `~/.skillhub/` | Web writes still require an explicit button action. |
| `link`, `unlink` | Canonical Skill and Agent path | Agent link plus local override/manifest state | Recorded link operations can be attempted with `undo`. |
| `describe`, `categorize` | Canonical Skill entry | Labels in `~/.skillhub/overrides.json` | Recorded, so `undo` reverts them. Skill contents are untouched. |
| `agents <key> on\|off` | Agent configuration | Agent visibility in `~/.skillhub/overrides.json` | Recorded. Existing links are never removed, so turning an Agent back on restores what was there. |
| `sync --apply` | Fresh server-side sync plan | Missing links only | Recorded link operations can be attempted with `undo`. |
| `sync --fix-broken` | Fresh server-side sync plan | Removes broken links only | Recorded link operations can be attempted with `undo`. |
| `update` / “update all” | Existing Git repositories | Runs `git pull --ff-only` | Not reverted by SkillHub Undo; use Git or your backup. |
| Add from Git | Public GitHub repository | Staged clone, then one canonical Skill directory | A successful clone is not a trust decision; review it before use. |
| Uninstall | Agent links and canonical entry | Unlinks or moves data to `_trash` | Restore from Trash or use an eligible backup manifest. |

`skillhub undo` is a best-effort reversal of the latest eligible manifest. It refuses to overwrite replacement paths and keeps failed sessions retryable. An unexpected power loss or process crash in the brief interval between a filesystem change and its manifest write can leave an unrecorded change, so inspect the sync plan and Agent directories after an interrupted write. Undo does not replace Time Machine, filesystem snapshots, or Git history.

## Third-party Skill risk

A Skill is instruction content that an Agent may load, and it can reference scripts or tools that run with your user permissions. Stars, a familiar owner name, and a clean SkillHub health report do not establish trust.

Before enabling an external Skill:

1. Read its root `SKILL.md` and every script or referenced file it asks the Agent to execute.
2. Check the repository owner, recent commits, license, and unexpected binaries or generated files.
3. Remove embedded credentials and replace personal absolute paths.
4. Test with limited data and permissions before using it in an important workspace.

Git installation currently accepts only a root GitHub repository over HTTPS, stages the clone, requires a regular root `SKILL.md` with `name` and `description`, disables interactive credentials and LFS smudging, and applies size limits. Multi-Skill repositories without a root entry are rejected. These checks reduce accidental exposure; they are not malware analysis or a sandbox.

## Network behavior

SkillHub has no telemetry. It can make these outbound requests:

| Trigger | Destination | Purpose |
|---|---|---|
| Most interactive CLI commands and dashboard startup | `api.github.com` | Check this project's latest release; cached for 24 hours. |
| Dashboard Hot list | `api.github.com` | Search public Skill repositories; cached for one week. |
| Add from Git | `github.com` | Clone the selected public repository. |
| Update | The existing Git remote | Run a fast-forward-only pull. |

Offline failures are reported or fall back to cached data. The dashboard listens only on `127.0.0.1`, `localhost`, or `::1`; attempts to bind `0.0.0.0` or a LAN address fail closed. Browser writes require exact same-origin JSON requests and a session token.

## CLI reference

```text
skillhub [command] [options]

open, start        Start the local dashboard
scan, list         Build and print the local inventory
pending            List Skills missing a Chinese blurb or a category
describe <name> <text>   Write a Skill's Chinese blurb
categorize <name> <cat>  Set a Skill's category
agents [key on|off]      List Agents in use, or turn one on or off
sync               Show the current sync plan
link <name> <ag>   Enable a Skill for a link-based Agent
unlink <name> <ag> Disable a Skill for a link-based Agent
update <name>      Fast-forward one Git-managed Skill or bundle
doctor             Run Tier A/B/C inspection rules
undo               Retry reversal of the latest eligible backup manifest
backups            List backup manifests
check-update       Check whether a newer SkillHub release exists

--json             Print machine-readable output where supported
--apply            With sync: create missing links only
--fix-broken       With sync: remove broken links only
--all              With doctor: also list findings in upstream-managed Skills
--port <number>    Dashboard port (default 7777)
--no-open          Start without launching a browser
```

## Support matrix

| Area | Status | Notes |
|---|---|---|
| Node.js | Supported: 20+ | CI matrix currently targets Node 20 and 22. |
| macOS | Locally verified | Source tests and packed global-install/dashboard smoke test passed. |
| Linux | CI verified | The current GitHub Actions run passes on Node.js 20 and 22; verify your local Agent paths. |
| Windows | CI verified | The current GitHub Actions run passes on Node.js 20 and 22. Junction behavior still depends on local filesystem policy and permissions; review `sync` before `--apply`. |
| Claude, Gemini, Hermes | Link adapters | Paths are configurable in `rules/agents.json`. |
| Codex | Native adapter | Uses the configured shared Skills directory; verify behavior against your installed Codex version. |
| Cursor | Experimental | Included to exercise configuration-driven adapters; not claimed as fully verified. |

## Troubleshooting

| Symptom | Check |
|---|---|
| Dashboard does not open | Run `./bin/skillhub open --no-open`, read the terminal error, then visit `http://127.0.0.1:7777`. Use `--port 7788` if the port is busy. |
| A Skill is missing | Run `./bin/skillhub scan --json`; confirm a root `SKILL.md` exists under the canonical directory. |
| Links look wrong | Run `./bin/skillhub sync` without write flags and review every planned action. |
| Undo reports a failure | Read each returned log. SkillHub keeps a failed manifest retryable and will not overwrite a newer replacement path. |
| Git update fails | Resolve local changes, authentication, remote, or non-fast-forward history directly with Git. SkillHub intentionally uses `--ff-only`. |
| Hot list or version check fails | GitHub may be offline or rate-limited. Core local inventory continues to work. |

## Development

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
npm run pack:check
```

`npm run pack:check` previews the exact npm package contents without publishing. Tests, CI configuration, and planning notes are excluded from the package. `npm publish` also runs the test suite, production dependency audit, and package-content check through `prepublishOnly`. Pull requests should include a regression test for behavior changes and must not weaken path, origin, or rollback checks.

## Security reports

Do not disclose vulnerabilities in a public issue. Use [GitHub Security Advisories](https://github.com/Vieeeeeee/skillhub/security/advisories/new) and include the affected version, reproduction steps, and impact without real credentials or personal paths. See [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE)
