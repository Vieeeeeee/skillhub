# SkillHub

Manage, inspect, and connect AI Agent Skills from one local source of truth.

[![CI](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml/badge.svg)](https://github.com/Vieeeeeee/skillhub/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@wsiwsii/skillhub.svg)](https://www.npmjs.com/package/@wsiwsii/skillhub)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文说明](./README.zh-CN.md)

SkillHub inventories the Skills on your machine, shows which Agents can see each one, helps you label and categorise them, and creates only the links you explicitly request. Canonical Skills live under `~/.agents/skills`. The web dashboard stays on your computer and refuses non-loopback bind addresses.

## Quick start

Requires Node.js 20 or newer.

**1. Install it**

```bash
npm install --global @wsiwsii/skillhub
```

**2. Register it as a Skill.** This is the step that lets you talk to it from your agent, and it is easy to miss.

```bash
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s "$(skillhub skill-path)" ~/.agents/skills/skillhub
ln -s ../../.agents/skills/skillhub ~/.claude/skills/skillhub
```

`skillhub skill-path` prints where the package actually is, so this does not depend on guessing an npm directory.

Codex reads `~/.agents/skills` natively, so the first link covers it. The second is for Claude Code. To add Gemini, Cursor or Hermes, link this one Skill on its own:

```bash
skillhub link skillhub gemini
```

(`skillhub sync` synchronises the whole library — every Skill to every Agent in use. It has its own place, but it is not the command for installing this one Skill.)

To uninstall later, delete those two links; nothing else is touched.

On Windows, run the equivalent from PowerShell, using the printed path:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills", "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.agents\skills\skillhub" -Target (skillhub skill-path)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\skillhub" -Target "$env:USERPROFILE\.agents\skills\skillhub"
```

**3. Open a new agent session and ask.**

| Agent | Trigger |
|---|---|
| Claude Code | `/skillhub`, or just say what you want |
| Codex | `$skillhub` |
| Gemini, Cursor, Hermes | `/skillhub` once linked |

A session that is already running will not see a newly installed Skill, so start a fresh one.

## What you can ask it to do

| Say this | It does this |
|---|---|
| Show me what I have installed | Lists every Skill, where it came from, its category, and which agents can read it |
| My skills are a mess | Reports the current state, then asks where you want to start |
| Write descriptions for these | Finds Skills with no local blurb and writes one for each |
| Sort the uncategorised ones | Groups whatever the rules could not place |
| I never use Cursor | Drops Cursor from the dashboard and from sync plans; existing links stay where they are |
| Share these with Codex | Shows the link plan first, applies it once you agree |
| Open the dashboard | Starts the local page at `http://127.0.0.1:7777` |
| Check my skills for problems | Looks for breakage, leaked keys and stale paths |
| Undo that | Rolls back the last write |

None of this edits the contents of a Skill. Writes are limited to links and to SkillHub's own config, and each one can be undone.

## Without an agent

The dashboard and the CLI work on their own:

```bash
skillhub open      # local dashboard
skillhub scan      # what is installed
skillhub pending   # what still needs a description or a category
skillhub doctor    # health report
```

## Running from source

```bash
git clone https://github.com/Vieeeeeee/skillhub.git
cd skillhub
npm ci
./bin/skillhub open
```

Register the source checkout as a Skill by linking its `skill/` directory instead:

```bash
ln -s "$PWD/skill" ~/.agents/skills/skillhub
```

Update the npm CLI with `npm install --global @wsiwsii/skillhub@latest`. Update a checkout with `git pull --ff-only && npm ci && npm test`.

## Capabilities in detail

| Capability | Result |
|---|---|
| Inventory | Lists Skills, sources, categories, Agent visibility, and structural metadata. A Skill that exists only inside one Agent's own folder is listed too, marked `仅 <Agent>` — SkillHub does not manage it, so the row is read-only and carries only that Agent's trigger word. |
| Labels and categories | Rules give every Skill a first-pass category. `pending` lists what is still unlabelled; `describe` and `categorize` write the rest. Both touch only SkillHub's own config, never Skill contents. |
| Link management | Creates or removes Agent links without replacing a real directory. |
| Agents in use | An Agent you do not use is hidden from the dashboard and left out of sync planning. Hiding never deletes existing links, and an Agent whose directory does not exist is hidden by default. |
| Sync planning | Shows the full plan first. `sync --apply` creates missing links only; `--fix-broken` removes broken links only. |
| Health checks | Flags missing frontmatter, broken links, hardcoded home paths, likely secret patterns and oversized files, across canonical Skills and Skill directories that still sit inside an Agent folder. Read-only. The default report lists only findings that carry a decision — nobody rewrites a Skill they use daily because a rule called its description long — so long descriptions, large files and scan-coverage notes become background. Findings inside upstream-managed Skills are informational, since an upgrade overwrites local edits. `doctor --all` lists everything. These checks are heuristic. |
| Git updates | Fast-forwards an individual Git-managed Skill or each unique bundle once. Partial failures remain visible. |
| Uninstall and restore | Moves real Skill directories to `~/.agents/_trash/`; link-only entries are unlinked. |
| Local dashboard | Provides the same inventory and explicit actions through a token-protected loopback API. |

## How it is organized

```text
~/.agents/skills/                     canonical Skill directories or links
~/.agents/_repos/                     managed multi-Skill repositories
~/.agents/_trash/                     locally removed Skill data (never cleared automatically)
~/.skillhub/registry.json             generated inventory cache
~/.skillhub/overrides.json            your blurbs, categories, and Agent choices
~/.skillhub/backups/                  manifests for supported reversible operations (newest 100 kept)
~/.skillhub/cache/                    version check and GitHub leaderboard cache
~/.skillhub/session                   local dashboard token (mode 0600 on POSIX)

~/.claude/skills/<name>               link to the canonical Skill
~/.gemini/config/skills/<name>         link to the canonical Skill
~/.hermes/skills/claude-skills/<name> link to the canonical Skill
~/.cursor/skills/<name>                experimental adapter
```

To put this data somewhere else, or to try SkillHub without touching an existing setup, use the environment:

| Variable | Effect |
|---|---|
| `SKILL_HUB_HOME` | Use a different home. Every path above follows it. |
| `SKILL_HUB_PORT` | Default dashboard port, same as `--port`. |
| `SKILL_HUB_HOST` | Dashboard bind address; only loopback is accepted. |
| `SKILL_HUB_NO_OPEN` | Set to anything to stop the browser opening. |

`overrides.json` holds what you wrote; SkillHub never overwrites it. Beyond blurbs, categories and Agent choices it also reads these, which currently have to be edited by hand:

| Field | Effect |
|---|---|
| `acceptedAliases` | `{"directory": "frontmatter name"}` — accept a mismatch and silence the matching health finding. |
| `agentSpecificSkills` | `{"name": {"claude": ".claude/skills/name", "codex": ".codex/skills/name"}}` — declare two versions as deliberate so sync stops trying to unify them. |
| `managedSkillContainers` | Directory names whose Skills another tool maintains; not reported as unmanaged orphans. |
| `localCanonical` | Names where the local copy is authoritative; shown with a ⭐. |

The three files under `rules/` are read once at startup, so editing them needs a restart.

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
note <name> <text>       Write a personal note on a Skill
remove <name> --yes      Uninstall a Skill (moved to the trash, reversible)
trash [restore <entry>]  List the trash, or restore an entry from it
agents [key on|off]      List Agents in use, or turn one on or off
sync               Show the current sync plan
link <name> <ag>   Enable a Skill for a link-based Agent
unlink <name> <ag> Disable a Skill for a link-based Agent
update <name>      Fast-forward one Git-managed Skill or bundle
doctor             Run Tier A/B/C inspection rules
undo               Retry reversal of the latest eligible backup manifest
backups            List backup manifests
skill-path         Print this package's skill/ directory
version            Print the installed version
check-update       Check whether a newer SkillHub release exists

--json             Print machine-readable output. Write commands (describe, categorize,
                   note, link, unlink, update, remove, trash restore, agents on|off)
                   return the result and the backup session id; scan, pending, doctor,
                   sync, backups and trash return data
--apply            With sync: create missing links only
--fix-broken       With sync: remove broken links only
--all              With doctor: also list background notes and upstream-managed findings
--port <number>    Dashboard port (default 7777)
--no-open          Start without launching a browser
```

## Support matrix

| Area | Status | Notes |
|---|---|---|
| Node.js | Supported: 20+ | The CI matrix covers Node 20, 22 and 24 across three operating systems — nine jobs. Node 24 is the version the release pipeline runs the suite on. |
| macOS | Locally verified | Source tests and packed global-install/dashboard smoke test passed. |
| Linux | CI verified | The latest GitHub Actions run passes on Node.js 20, 22 and 24; verify your local Agent paths. |
| Windows | CI verified | The latest GitHub Actions run passes on Node.js 20, 22 and 24. Junction behavior still depends on local filesystem policy and permissions; review `sync` before `--apply`. |
| Claude, Gemini, Hermes | Link adapters | Paths are configurable in `rules/agents.json`. |
| Codex | Native adapter | Reads the configured shared Skills directory directly, so it needs no links. It also scans its own `~/.codex/skills`, where the Skill Creator it ships with installs by default; a Skill that exists only there is reported in the sync plan. Verify behavior against your installed Codex version. |
| Cursor | Experimental | Included to exercise configuration-driven adapters; not claimed as fully verified. |

## Troubleshooting

| Symptom | Check |
|---|---|
| `skillhub: command not found` | The CLI is not installed or not on PATH. Install it, then confirm with `skillhub --version`. |
| `SkillHub is already running` | Not an error. The dashboard was open and that page is being brought forward. Use `--port 7788` to run a second one. |
| Dashboard does not open | Run `skillhub open --no-open`, read the terminal error, then visit `http://127.0.0.1:7777`. |
| A Skill is missing | Run `skillhub scan --json`; confirm a root `SKILL.md` exists under the canonical directory. |
| An edited category or blurb does not show | The dashboard is holding a cached inventory. Press Rescan, or run `skillhub scan`. |
| The Skill does not trigger in an agent | Agents load their Skill list at session start. Open a new session. |
| Links look wrong | Run `skillhub sync` with no write flags and review every planned action. |
| Undo reports a failure | Read each returned log. SkillHub keeps a failed manifest retryable and will not overwrite a newer replacement path. |
| Git update fails | Resolve local changes, authentication, remote, or non-fast-forward history directly with Git. SkillHub intentionally uses `--ff-only`. |
| Hot list or version check fails | GitHub may be offline or rate-limited. Core local inventory continues to work. |
| Stopping the dashboard | Press Ctrl-C in the terminal that started it. If that terminal is gone, identify the listener first with `lsof -nP -iTCP:7777 -sTCP:LISTEN`, then kill that one PID. Matching on the port alone also matches every process merely connected to it, which on a machine running a local proxy can be most of what is open. On Windows: `netstat -ano \| findstr :7777`, then `taskkill /PID <pid> /F`. |
| The trash is taking up space | It holds real Skill data and is never cleared automatically. Delete the directories under `~/.agents/_trash/` yourself once you are sure. |

## Development

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
npm run pack:check
```

`npm run pack:check` previews the exact npm package contents without publishing. Tests, CI configuration, and planning notes are excluded from the package. `npm publish` also runs the test suite, production dependency audit, and package-content check through `prepublishOnly`. Pull requests should include a regression test for behavior changes and must not weaken path, origin, or rollback checks.

Releases are tag-driven. Set the version in `package.json`, write the CHANGELOG entry, push a `v<version>` tag, then dispatch the publish workflow against that tag with `gh workflow run "Publish to npm" --ref v<version>`. The workflow rejects any ref whose name is not exactly `v` followed by the `package.json` version, and its `npm` environment holds the run for a manual approval, so nothing reaches the registry until a maintainer approves that deployment.

## Security reports

Do not disclose vulnerabilities in a public issue. Use [GitHub Security Advisories](https://github.com/Vieeeeeee/skillhub/security/advisories/new) and include the affected version, reproduction steps, and impact without real credentials or personal paths. See [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE)
