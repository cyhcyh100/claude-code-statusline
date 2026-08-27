# Statusline Plugin — Design Spec

- **Date:** 2026-05-11
- **Owner:** cyhcyh100
- **Repo:** `cyhcyh100/claude-code-statusline` (GitHub)
- **Distribution:** Private Claude Code plugin marketplace (this repo)
- **Status:** Implemented (`statusline-plugin-v1` branch, release `v1.0.0`). One PR ↔ one version.

---

## 1. Goal

Replace the OMC HUD statusline with a custom multi-line statusline that shows:

1. **cwd** — working directory (home-relative)
2. **gitBranch** — current git branch
3. **PR** — open PR for current branch (clickable hyperlink) + `(merged)` suffix when merged
4. **model** — current Claude model
5. **rateLimits** — 5h + weekly session usage % + reset times
6. **context** — context window % usage (numeric only; no progress bar)
7. **contextLimitWarning** — warning banner when context exceeds threshold
8. **thinking** — extended thinking active indicator
9. **todos** — current TodoWrite list with progress
10. **backgroundTasks** — running background bash/agent tasks
11. **lastSkill / activeSkills** — most recent invoked skill

Distributed as a **private Claude Code plugin** so the team gets auto-updates without `git pull` + reapply.

## 2. Non-goals

- Not replacing OMC HUD's workflow-mode features (mission board, ralph, autopilot, ultrawork, prdStory, etc.)
- Not supporting z.ai or non-Anthropic providers in v1
- Not configurable via UI in v1 — single hardcoded layout

## 3. Distribution model

This repo doubles as a Claude Code plugin **marketplace** that contains a single plugin: `statusline`.

**Repo layout:**

```
claude-code-statusline/
├── .claude-plugin/
│   └── marketplace.json              # marketplace manifest
├── plugins/
│   └── statusline/
│       ├── .claude-plugin/
│       │   └── plugin.json           # plugin manifest (NOTE: under .claude-plugin/)
│       ├── hooks/
│       │   └── hooks.json            # SessionStart hook → runs install.mjs once
│       ├── scripts/
│       │   ├── install.mjs           # idempotent: writes bootstrap.mjs to ~/.claude/...
│       │   │                         # and patches user settings.json statusLine.command
│       │   └── bootstrap.mjs         # template — copied to ~/.claude/<install-dir>/
│       │                              # at install time. Discovers latest plugin cache
│       │                              # version + dynamically imports index.mjs.
│       └── statusline/
│           ├── index.mjs             # main entry (stdin → stdout)
│           ├── find-node.sh          # nvm/fnm-safe node shim (for hook + wrapper)
│           └── lib/
│               ├── usage-api.mjs     # OAuth API + cache (5h/weekly)
│               ├── transcript.mjs    # JSONL scan: thinking, todos, skills, bg tasks
│               ├── git-info.mjs      # branch + PR + per-branch cache
│               ├── stdin-info.mjs    # cwd + model + contextBar from stdin JSON
│               ├── hyperlink.mjs     # OSC 8 helper
│               ├── colors.mjs        # ANSI color helpers
│               └── layout.mjs        # multi-line composition
└── docs/
    └── superpowers/specs/            # this spec lives here
```

**User onboarding (one-time):**

```
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

After install, Claude Code auto-fetches updates from the marketplace on its standard cadence.

**Statusline registration (verified 2026-05-11):** Claude Code's `plugin.json` does NOT support a main `statusLine` field. Plugin-level `settings.json` only supports `agent` and `subagentStatusLine` keys. Therefore the plugin uses a `SessionStart` hook → `scripts/install.mjs` to (a) copy a small wrapper (`bootstrap.mjs`) to `~/.claude/claude-code-statusline/bootstrap.mjs`, (b) patch `~/.claude/settings.json` `statusLine.command` to invoke the wrapper. Idempotent: tracked via `~/.claude/claude-code-statusline/.installed` marker (re-runs only if version-stamp inside marker differs from current plugin version). The wrapper performs runtime version discovery on each render — scans `~/.claude/plugins/cache/claude-code-statusline/statusline/` for the latest version directory and dynamically imports its `statusline/index.mjs`. Mirrors OMC HUD's wrapper pattern so plugin auto-updates flow through without re-patching settings.

## 4. Output format

Multi-line layout (Claude Code statusline supports multi-line). Up to 4 base lines + 1 conditional warning banner.

**Full example (everything on):**

```
~/work/project |  main | #42 (merged)
🤖 Opus 4.7 | 5h:42%(3h12m) | wk:18%(5d4h) | ctx:47% | *thinking*
▶ Build feature foo | ☐ Test foo | ☐ Document
🔧 superpowers:brainstorming | ⚙ 2 bg
```

**With context warning (>80% threshold):**

```
~/work/project |  main | #42
🤖 Opus 4.7 | 5h:42%(3h12m) | wk:18%(5d4h) | ctx:82% | *thinking*
▶ Build feature foo | ☐ Test foo
🔧 superpowers:brainstorming
⚠ Context at 82% — consider /compact
```

The ` | ` separator is dimmed (ANSI dim) so it groups segments visually
without competing with content for attention.

### Element rules

| # | Element | Format | Notes |
|---|---|---|---|
| L1 | cwd | `~/work/project` (home-relative); root-relative if outside `$HOME` | Always shown. From stdin `cwd`. cyan. |
| L1 | gitBranch | ` <branch>` cyan | Only if in git repo. |
| L1 | PR | `#42` green (open) / `#42 (merged)` gray; OSC 8 hyperlink to PR URL | Only if `gh pr view` returns a result. CLOSED-not-merged hidden. |
| L2 | model | `🤖 Opus 4.7` (versioned short name) magenta | Always shown. From stdin `model.display_name`. |
| L2 | 5h | `5h:<pct>%(XhYm)` | label + colored pct + dim parens reset. Drops leading `0h` when hours = 0 (e.g. `(2m)`, not `(0h2m)`). Color: green<70 / yellow<85 / red≥85. Hidden if no OAuth creds. |
| L2 | wk | `wk:<pct>%(XdYh)` | Same shape as 5h; drops leading `0d` when days = 0. Same color thresholds. Hidden if no OAuth creds. |
| L2 | context | `ctx:<pct>%` | Always shown. From stdin `context_window.used_percentage` (or computed from `current_usage / context_window_size`). Same color thresholds. |
| L2 | thinking | `*thinking*` magenta | Hidden if not active. (Earlier prototype used `💭`; replaced for a quieter cue.) |
| L3 | todos | `☐ <name>` for pending; `▶ <name>` for in_progress (yellow); completed hidden | Up to 5 items shown, then `… +N more` in gray. From most recent TodoWrite tool_use in transcript. Hidden if no list (or all completed). |
| L4 | lastSkill | `🔧 <skill-name>` magenta | Most recent Skill tool_use in transcript. Hidden if none. |
| L4 | backgroundTasks | `⚙ N bg` gray (count only in v1) | From transcript: count of Bash tool_use entries with `run_in_background: true` whose tool_result hasn't appeared yet. Hidden if 0. |
| L5 | contextLimitWarning | `⚠ Context at <pct>% — consider /compact` bold yellow/red banner | Only when `ctx >= 80%`. Severity: bold yellow ≥80, bold red ≥90. |

### Separators

Dim ` | ` (vertical bar with spaces, ANSI dim) within every line.

### Width / wrapping

- Each line truncated to terminal width with `…` ellipsis (preserve ANSI codes).
- Total output capped at 5 lines max (4 base + 1 warning).

### Hidden states (auto-degrade)

- Non-git folder: branch + PR omitted.
- No OAuth creds: 5h + wk omitted, no error shown.
- `gh` missing / no remote / not authenticated: PR omitted silently.
- Thinking inactive: `*thinking*` omitted.
- No todos / no skills / no bg tasks: line omitted entirely if all elements on it are empty.

## 5. Data sources

| Element | Source | Cost |
|---|---|---|
| cwd | stdin `cwd` | free |
| model | stdin `model.display_name` | free |
| contextBar | stdin `context_window.used_percentage` (fallback compute from `current_usage` totals / `context_window_size`) | free |
| contextLimitWarning | derived from contextBar % vs threshold (default 80) | free |
| gitBranch | `git rev-parse --abbrev-ref HEAD` (execFileSync, cwd from stdin) | ~10ms |
| PR | `gh pr view --json number,url,state` | ~500-1500ms — **cached per branch 60s** |
| 5h / Weekly usage | `GET https://api.anthropic.com/api/oauth/usage` (Bearer token + `anthropic-beta: oauth-2025-04-20`) | ~200-500ms — **cached 90s** |
| thinking, todos, lastSkill, backgroundTasks | Single tail-scan of `transcript_path` JSONL (last ~64KB) | ~5-30ms — no cache, single pass produces all four |

**Statusline stdin shape (from Claude Code):**

```json
{
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/path/to/project",
  "model": { "id": "...", "display_name": "..." },
  "context_window": {
    "context_window_size": 200000,
    "used_percentage": 47,
    "current_usage": {
      "input_tokens": ...,
      "cache_creation_input_tokens": ...,
      "cache_read_input_tokens": ...
    }
  }
}
```

### Transcript scan details

The transcript is JSONL (one JSON object per line). We tail-read the last ~64KB and parse each line. Within a single pass we extract:

- **thinking**: any `message.content[]` entry with `type === "thinking"` or `type === "reasoning"`. Track most recent `timestamp`. Active if `now - lastSeen <= 30_000`.
- **todos**: locate the most recent `tool_use` block with `name === "TodoWrite"`. Read `input.todos: [{content, status, activeForm}]`.
- **lastSkill**: most recent `tool_use` block with `name === "Skill"` (or proxy variant). Read `input.skill`.
- **backgroundTasks**: walk `tool_use` blocks with `name === "Bash"` and `input.run_in_background === true`. For each, check whether a corresponding `tool_result` block (matching `tool_use_id`) appears later in the transcript. Count those without a result.

This is best-effort heuristic for backgroundTasks (matches our needs without installing tracking hooks). If accuracy issues arise, switch to a PostToolUse hook in a future version.

## 6. Caching

Statusline runs frequently (Claude Code throttles to ~300ms). Expensive sources MUST be cached.

**Cache directory:** `$HOME/.claude/claude-code-statusline/cache/`

| File | TTL | Contents |
|---|---|---|
| `usage.json` | 90s success / 15s failure / 2min network error / exponential backoff on 429 | `{ timestamp, fiveHourPercent, fiveHourResetsAt, weeklyPercent, weeklyResetsAt, error?, lastSuccessAt }` |
| `pr-<branch-hash>.json` | 60s positive, 60s "no PR" negative, 5min "disabled" (no `gh` etc.) | `{ timestamp, number, url, state, merged }` or `{ timestamp, empty: true }` or `{ timestamp, disabled: true }`. Filename hash = `sha256(branch).slice(0,8)`. |

cwd, model, contextBar, gitBranch, transcript-derived elements are read fresh every render (cheap).

**Cache hygiene:** Atomic writes (write to `.tmp` then rename). Stale-while-revalidate for usage cache (matches OMC behavior).

## 7. OAuth token handling

Read-only credential access (same flow as OMC HUD's `usage-api.ts`):

1. **macOS Keychain (primary):** `security find-generic-password -s "Claude Code-credentials" -a "<username>" -w` → JSON `{ accessToken, expiresAt, refreshToken }`. Service name suffix `-${sha256(CLAUDE_CONFIG_DIR)[0:8]}` if env var set.
2. **File fallback:** `~/.claude/.credentials.json` (supports both flat and `{ claudeAiOauth: {...} }` shapes).

**Token refresh:** If `expiresAt <= now`, POST `https://platform.claude.com/v1/oauth/token`:

- `grant_type=refresh_token`
- `refresh_token=<rt>`
- `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code public OAuth client_id)

On success, write back to `~/.claude/.credentials.json` (Keychain write-back not supported — best-effort).

**No credentials:** Silently omit usage section. No error shown.

## 8. PR detection

```
gh pr view --json number,url,state --jq '{n:.number,u:.url,s:.state}'
```

`gh` defaults to current branch. Outcomes:

- Success → parse + cache positive result 60s
- "no pull requests found for branch X" → cache empty result 60s
- Error (no `gh` / no remote / not authenticated) → cache `{disabled:true}` 5min, omit silently

State: `OPEN` → green / `MERGED` → gray + `(merged)` / `CLOSED` → omit

## 9. Thinking detection

Per §5 transcript scan. Active iff `now - lastSeen <= 30_000` ms. Matches OMC HUD `THINKING_RECENCY_MS`.

## 10. Context window display

`stdin.context_window.used_percentage` is authoritative when present. Fallback computation:

```
ctx = (current_usage.input_tokens
     + current_usage.cache_creation_input_tokens
     + current_usage.cache_read_input_tokens) / context_window_size * 100
```

Color thresholds (configurable in v2; hardcoded in v1):
- < 70%: green
- 70-79%: yellow (informational)
- 80-89%: yellow + show warning banner (line 5)
- ≥ 90%: red + warning banner

Warning banner is one line, full-width, prefixed with `⚠`. Suggests `/compact`.

## 11. Error handling

Statusline must NEVER:

- Throw uncaught exceptions (would break Claude Code's render)
- Block longer than ~500ms total wall time
- Print to stderr

All section renderers wrap in try/catch. Each subprocess and HTTP call has an explicit timeout (subprocess 1500ms, http 5000ms). Section failure → omit that section silently.

The single allowed failure path: if `index.mjs` itself crashes before producing output, Claude Code shows nothing (acceptable).

## 12. Security & SSRF

OAuth API endpoint hardcoded (`api.anthropic.com`) — no user-controlled URLs. `ANTHROPIC_BASE_URL` env var ignored in v1 to avoid SSRF surface (OMC supports z.ai via this; we don't need it).

OAuth token never leaves the machine except in requests to `api.anthropic.com` and `platform.claude.com` (token refresh).

## 13. Testing strategy

Unit tests out of scope for v1. Pre-merge manual verification checklist:

- [ ] git repo + open PR: line 1 shows `cwd | branch | #N` with hyperlink
- [ ] PR merged: `(merged)` suffix gray
- [ ] No PR: branch shown, PR omitted
- [ ] Non-git folder: branch + PR omitted
- [ ] Model badge `🤖 …` always present at start of line 2
- [ ] OAuth creds present: 5h + wk segments on line 2 in `label:N%(reset)` shape
- [ ] OAuth creds expired → refresh works (or degrades silently)
- [ ] context segment shows reasonable %
- [ ] Context >80%: warning banner appears (bold yellow), >=90% bold red
- [ ] Thinking active mid-response: `*thinking*` appears
- [ ] Active TodoWrite list: shows on line 3 with current item highlighted (`▶`)
- [ ] Last skill invocation: shows on line 4
- [ ] Background bash with `run_in_background:true`: shows `⚙ N bg`
- [ ] No `gh`: degrades silently
- [ ] Separator is dim ` | ` everywhere (no `·`)
- [ ] Total render time <300ms with warm caches
- [ ] Output capped at 5 lines

## 14. Open questions resolved (2026-05-11 docs verification)

1. ✅ **Plugin-native statusline registration**: `plugin.json` does NOT support `statusLine`. Plugin `settings.json` only supports `agent` + `subagentStatusLine`. Decision: SessionStart hook patches user `~/.claude/settings.json` (see §3).
2. ✅ **Marketplace JSON schema**: confirmed — required `name` (kebab-case), `owner.name`, `plugins[]`. Each plugin needs `name` + `source`. Optional `version`, `description`, `author`, etc. Sources: relative path (`./plugins/X`), `github`, `url`, `git-subdir`, `npm`.
3. ✅ **Plugin manifest location**: `.claude-plugin/plugin.json` inside each plugin directory (NOT plugin root).
4. ✅ **Plugin versioning policy**: SemVer in `plugin.json` `version`; bump on every release. Omit to fall back to git commit SHA (every commit = new version — handy during rapid iteration).
5. ⚠ **Multi-line statusline output**: Claude Code accepts multi-line stdout (OMC HUD does it). Specific max-line cap not documented; v1 self-caps at 5 lines via `layout.mjs`.

## 15. Out of scope (future)

- Configuration (theme, format toggles, color customization, threshold tuning)
- Per-project overrides
- Other Claude Code providers (z.ai, etc.)
- Custom rate limit providers
- Workflow modes (mission board / ralph / autopilot / ultrawork / prdStory)
- Tool/agent/skill call counts
- Session health (duration / health indicator / message count)
- AI-generated session summary
- API key source / profile name
- PostToolUse hook for accurate background task tracking (use OMC HUD if you need this)

## 16. Versioning policy

One PR ↔ one `plugin.json` version bump. Cosmetic exploration during PR
review happens in the branch and is squash-merged into a single release
commit; intermediate version-stamps are not preserved. The next PR bumps
to the next version (patch / minor / major per SemVer).

This avoids leaking exploratory cosmetics through the auto-update channel
(every version bump triggers a re-extract for users on auto-update; we
only want that for shipped releases, not in-progress tweaks).
