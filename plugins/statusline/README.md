# statusline

Custom Claude Code statusline for personal use.

Shows what you actually want to see during a session: where you are, what
model you're using, your branch + open PR, your Anthropic quota, the
context window, and what Claude is currently doing (thinking, todos, last
skill, background tasks).

## Example output

```
~/work/project |  main | #42 (merged)
🤖 Opus 4.7 | 5h:24%(2m) | wk:37%(2d20h) | ctx:41% | *thinking*
▶ Build feature foo | ☐ Test foo | ☐ Document
🔧 superpowers:brainstorming | ⚙ 2 bg
```

The ` | ` separator is dimmed so it groups segments without competing
with the content.

If context goes over 80% a warning banner appears as line 5:

```
⚠ Context at 82% — consider /compact
```

Sections auto-degrade when their inputs are missing — no errors, just
fewer segments. Outside a git repo? branch + PR drop. No `gh`? PR drops.
No OAuth creds? `5h` / `wk` drop. No active thinking? `*thinking*` drops. And so on.

## What each segment means

| Segment | Source | Notes |
|---|---|---|
| `~/path` cyan | stdin `cwd`, home-relativized | always shown |
| `🤖 Opus 4.7` magenta | stdin `model.display_name` | always shown |
| ` main` cyan | `git rev-parse --abbrev-ref HEAD` | git repos only |
| `#42` green / `#42 (merged)` gray | `gh pr view --json number,url,state` (cached 60s per branch); OSC 8 hyperlink to the PR | hidden if `gh` missing, no remote, no auth, or no PR |
| `5h:24%(2m)` | Anthropic OAuth API `/api/oauth/usage`, cached 90s; reset wrapped in dim parens | hidden if no Anthropic creds |
| `wk:37%(2d20h)` | same API, weekly bucket | label dimmed (secondary signal) |
| `ctx:41%` | stdin `context_window.used_percentage`, fallback computed | colored: green <70, yellow <85, red ≥85 |
| `*thinking*` magenta | transcript JSONL scan: `thinking`/`reasoning` block within last 30s | hidden when inactive |
| `▶ Build foo` yellow / `☐ Test foo` | latest `TodoWrite` tool_use in transcript; `▶` = in_progress, `☐` = pending; up to 5 + `… +N more` | hidden if no list / all completed |
| `🔧 superpowers:foo` magenta | latest `Skill` tool_use in transcript | hidden if none |
| `⚙ 2 bg` gray | count of `Bash` `run_in_background:true` tool_use blocks without a matching `tool_result` | hidden when 0 |
| `⚠ Context at N% — consider /compact` | derived banner | shown when ctx ≥ 80; bold yellow at 80–89, bold red at ≥ 90 |

## Multi-repo mode

When `cwd` is **not** a git repo but its direct children **are** (e.g.
`~/infra/` containing several service repos), the path + branch + PR
line expands into a compact fleet summary so you can see every child
repo's state at a glance.

Example:

```
~/infra/ | 5 repos · 2 dirty · 2 open PRs · 1 draft
 alpha main!  #42  ·   beta fix-bug  ~#17  ·   shared rename!  #99✗
 gamma main  ·   old feature  #5✓
```

- **Trigger**: cwd is outside any git worktree AND has ≥ 2 direct
  child directories that are git repos (regular repos, submodules, or
  worktrees all qualify). Auto-detected — no config.
- **Single child**: exactly 1 child repo falls back to single-repo
  rendering against that child, with the parent path still shown.
- **Opt-out**: set `STATUSLINE_MULTI_REPO=0` in your environment.
- **Width**: Claude Code does not currently publish the statusline pane
  width to its subprocess (no TTY, no `COLUMNS`), so the renderer
  defaults to **80** columns. If your terminal is wider, set
  `STATUSLINE_WIDTH=<cols>` (e.g. 160) in your shell rc so more repos
  fit inline before the `…+N more` / `…+N quiet` overflow kicks in.

PR badge legend:

| Badge | State |
|---|---|
| `#42` green | open |
| `~#17` yellow | draft |
| `#5✓` gray | merged |
| `#99✗` dim | closed (not merged) |

`!` after the branch name means the working tree is dirty or
ahead/behind the upstream.

Repos sort by urgency: dirty + open PR first, then dirty + draft,
dirty without PR, clean + open / draft, then quiet repos (merged →
closed → no PR), alphabetical tiebreaker. The bottom "quiet" line
overflows first when terminal width is tight, so the repos that need
attention stay visible. PR data is one batched `gh api graphql` call
cached 60s per parent directory.

## Install

Adds the marketplace once, installs the plugin, restart. That's it.

```
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

Restart Claude Code. On the next session start, an installer hook
copies a small wrapper to `~/.claude/claude-code-statusline/` and patches
your `~/.claude/settings.json` `statusLine.command`. Claude Code re-reads
settings after hooks run, so the new statusline takes effect in the same
session — no second restart.

### Auto-updates

Enable in the `/plugin` UI for this marketplace (default on). For a private
GitHub repo, Claude Code's startup auto-update runs **non-interactively**, so
git credential helpers don't apply — set `GITHUB_TOKEN` in your shell rc:

```bash
# ~/.zshrc or ~/.bashrc
export GITHUB_TOKEN="$(gh auth token)"
```

When a new plugin version is released (the maintainer bumps `plugin.json`'s
`version`), Claude Code re-extracts the new version into the plugin cache on
next start, the wrapper picks it up automatically (it discovers the latest
cached version at render time), and your statusline reflects the new code
without any manual reapply.

### Manual refresh

If auto-update is off or you want to pull a new version right now:

```
/plugin marketplace update claude-code-statusline
/plugin install statusline@claude-code-statusline
```

Then restart.

### Local / dev install (for working on this plugin)

If you have this repo checked out locally:

```
/plugin marketplace add /absolute/path/to/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

Local-path marketplaces don't auto-update — to pick up changes, bump
`plugins/statusline/.claude-plugin/plugin.json` `version`, then re-run
`/plugin install statusline@claude-code-statusline` and restart.

## How it works

There's no plugin-manifest field for the main statusline in Claude Code, so
this plugin uses a `SessionStart` hook (`hooks/hooks.json`) that runs
`scripts/install.mjs` on every session start. The installer is idempotent
(tracked via a `.installed` marker keyed on plugin version):

1. Copies `scripts/bootstrap.mjs` to `~/.claude/claude-code-statusline/bootstrap.mjs`.
2. Copies `statusline/find-node.sh` so nvm/fnm users have a working shim.
3. Patches `~/.claude/settings.json` `statusLine.command` to invoke the wrapper. Backs up any existing non-ours `statusLine` to `_statusLineBackup`.

The wrapper (`bootstrap.mjs`) is small: it scans
`~/.claude/plugins/cache/claude-code-statusline/statusline/<version>/`
on every render, picks the highest-version directory with a built
`statusline/index.mjs`, and dynamically imports it. This is the same
"wrapper-finds-cache" pattern OMC HUD uses, and it's why version bumps
flow through automatically without re-patching your `settings.json`.

## Requirements

- **Node.js** — any recent version. nvm/fnm OK (`find-node.sh` handles location).
- **`git`** — optional. branch hidden if missing or outside a repo.
- **`gh` CLI** — optional. PR hidden if missing, no remote, or not authenticated.
- **Anthropic OAuth credentials** — optional. Read from macOS Keychain
  (service `Claude Code-credentials`) or `~/.claude/.credentials.json`.
  Refreshed automatically when expired (`platform.claude.com`). Usage segments hidden if not present.
- **macOS or Linux**. Windows not exercised in v1.

## Cache

`~/.claude/claude-code-statusline/cache/`:

- `usage.json` — 5h + weekly OAuth usage. TTL 90s on success, 15s on auth/cred failure, 2min on network failure, exponential backoff on 429.
- `pr-<sha256(branch)[:8]>.json` — per-branch PR result. TTL 60s for OK / 60s for "no PR" / 5min when `gh` is unavailable.

Safe to delete; rebuilt on next render.

## Debugging

Statusline is silent by default per spec (must never `stderr` during normal
operation). To surface installer/wrapper errors:

```bash
export STATUSLINE_DEBUG=1
```

Then watch Claude Code's startup output, or run the wrapper manually:

```bash
echo '{"cwd":"/tmp"}' | STATUSLINE_DEBUG=1 sh ~/.claude/claude-code-statusline/find-node.sh ~/.claude/claude-code-statusline/bootstrap.mjs
```

You can also run the plugin directly against fixture stdin in this repo:

```bash
cat plugins/statusline/test-fixtures/stdin-with-transcript.json \
  | node plugins/statusline/statusline/index.mjs
```

## Uninstall

```
/plugin uninstall statusline@claude-code-statusline
```

The wrapper + patched `statusLine.command` in `~/.claude/settings.json`
remain after uninstall. To fully remove:

```bash
rm -rf ~/.claude/claude-code-statusline
# Then edit ~/.claude/settings.json and either remove the `statusLine`
# key entirely or restore from `_statusLineBackup` if you had a previous one.
```

## For maintainers (release flow)

1. Make changes on a branch.
2. Bump `plugins/statusline/.claude-plugin/plugin.json` `version` (SemVer).
   This is **required** for users to see the change — Claude Code skips
   re-extraction when the cached version matches.
3. Open a PR, merge to `main`.
4. Users with `GITHUB_TOKEN` and auto-update on get the new version on next session start.

To omit explicit version-pinning and have every commit count as a new
version (handy during rapid iteration), remove the `version` field from
`plugin.json` entirely; Claude Code will fall back to the git commit SHA.

## Design

Full design spec: `docs/superpowers/specs/2026-05-11-statusline-plugin-design.md`.
Implementation plan: `docs/superpowers/plans/2026-05-11-statusline-plugin.md`.
