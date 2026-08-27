# Multi-Repo Statusline Mode — Design Spec

- **Date:** 2026-05-13
- **Plugin:** `plugins/statusline/`
- **Version:** `1.1.0` (minor — new mode, no breaking change to single-repo rendering)
- **Status:** Implemented

---

## 1. Goal

When the user's `cwd` is **not** a git repo but its direct children **are**
(e.g. `~/infra/` containing several service repos), the statusline replaces
line 1 with a compact summary of every child repo's state. The three pieces
of information that must always be visible at a glance:

1. **Which repo** (name)
2. **Which branch** (current `HEAD` ref name)
3. **Which PR** (number + state: open / draft / merged / closed-not-merged / none)

Plus a dirty-working-tree indicator so the user can scan for actionable work.

## 2. Non-goals

- **No recursion.** Only direct children of `cwd` are considered.
- **No new dependencies.** Stays dependency-free per repo `CLAUDE.md`.
- **No simultaneous single-repo + multi-repo display.** The two modes
  are mutually exclusive (see §3).
- **No first-run hint.** The rendered output is self-explanatory to
  anyone who already reads the single-repo statusline.
- **No config file.** A single env-var opt-out is the only mode toggle.

## 3. Activation

### 3.1 Trigger

Multi-repo mode activates when **all** of:

1. `gitBranch(cwd)` returns `null` (cwd is not inside a git worktree)
2. `cwd` has **≥ 2** direct children that are git repos
3. `STATUSLINE_MULTI_REPO` env var is not `"0"`

A "git repo child" is a direct subdirectory whose `.git` exists
(directory or pointer file — submodules and worktrees both qualify).

### 3.2 Single-child fallback

If detection produces exactly **1** child repo, multi-repo rendering
does not engage. The statusline:

- Renders the path segment as the parent dir (`~/infra`, not
  `~/infra/the-child`)
- Reuses single-repo branch + PR rendering against the lone child

This reads as: "I'm in a parent dir that happens to contain one repo;
show me that repo's info on the path line."

### 3.3 Mutual exclusion

`gitBranch(cwd) == null` is the precondition for multi-repo mode and
exactly the case where the single-repo branch + PR display would already
be hidden. No overlap.

## 4. Display format

### 4.1 Line allocation

Multi-repo mode owns **line 1 only**. Lines 2-5 (model, usage, todos,
skills, context warning) are unchanged.

Line 1 expands into:

- **Sub-line 1.a** — path + fleet summary
- **Sub-line(s) 1.b** — every repo, sorted by tier (active first, then
  quiet), wrapped across as many sub-lines as needed to fit the
  terminal width

Active (dirty / open PR / draft PR) and quiet (clean without active PR)
repos share a single wrapped stream rather than getting their own line
blocks. Tail of an active wrap line gets filled in with quiet repos when
there's room. The `!` suffix on dirty branches and the colored PR badges
already signal which repos need attention, so the active→quiet boundary
does not need a dedicated line break.

`compose()`'s `MAX_LINES` is set to **8** so wrapped repo lines + the
model line + an optional context warning all fit comfortably.

### 4.2 Format per repo

Each repo token has the shape:

```
 <repo-name> <branch>[!] [<pr-badge>]
```

- ` ` — Nerd Font branch glyph (matches single-repo rendering)
- `<repo-name>` — cyan
- `<branch>` — cyan; `(detached)` / `(rebase)` / `(merge)` in yellow
  when the working state is non-normal
- `!` — yellow suffix when the working tree is dirty or ahead/behind
- `<pr-badge>` — only present when a PR exists for the branch

PR badge formats:

| State | Badge | Color | Example |
|---|---|---|---|
| Open | `#<n>` | green | `#42` |
| Draft | `~#<n>` | yellow | `~#17` |
| Merged | `#<n>✓` | gray | `#5✓` |
| Closed (not merged) | `#<n>✗` | dim gray | `#99✗` |
| None | *(omitted)* | — | — |

PR numbers are OSC 8 hyperlinks to the PR URL.

### 4.3 Separators

- Within sub-line 1.a: existing `dim(" | ")` separator
- Within sub-line(s) 1.b: `"  " + dim("·") + "  "` (mid-dot, lighter
  than the full pipe)

### 4.4 Fleet summary (sub-line 1.a)

```
<path> | <N> repos · <D> dirty · <O> open PRs[ · <X> draft]
```

The draft count appears only if `X > 0`. Counts:

- `N` — total git-repo children
- `D` — repos with dirty working tree OR non-zero ahead/behind
- `O` — repos whose current branch has an `OPEN` non-draft PR
- `X` — repos with a draft PR

If `N == 0` (race: detection saw repos but the directory changed mid-render),
sub-line 1.a reads `<path> | 0 repos` and no repo line follows.

### 4.5 Sort

Lower tier renders first. Alphabetical tiebreaker by repo name within a tier.

1. Dirty AND open PR
2. Dirty AND draft PR
3. Dirty (no PR or merged/closed)
4. Clean AND open PR
5. Clean AND draft PR
6. Clean + merged PR
7. Clean + closed PR
8. Clean, no PR

### 4.6 Wrapping

`packLines(tokens, maxVisible)` is a plain greedy wrap: append tokens
until the next one wouldn't fit, then start a new sub-line. No
`…+N more` overflow label — every repo ends up on some line. A token
wider than `maxVisible` (an unusually long repo+branch combo) still
occupies its own line; the line-level `truncateLine()` in `compose()`
clips it cosmetically at the right edge.

The legacy single-line `packLine()` (with overflow label) remains
exported for callers that want that behavior. Default render uses
`packLines`.

If wrapped repo lines + the model line + the context warning exceed
`MAX_LINES` (8), `compose()` drops the tail. The fleet summary's
"N repos" count gives the user a built-in cue when that happens.

## 5. Data pipeline

Performance is the binding constraint. With up to ~30 child repos,
steady-state render must stay under ~50ms. Cold-start is allowed up to
~500ms once.

### 5.1 Repo discovery

- **Mechanism:** `readdirSync(cwd, { withFileTypes: true })` filtered
  to directories; `resolveGitDir(child)` per candidate (handles
  pointer files for submodules / worktrees).
- **Cache:** `parent-repos-<sha256(cwd):8>.json` in the existing
  `cacheDir()` (`~/.claude/claude-code-statusline/cache/`).
- **Invalidation:** parent directory's `mtimeMs`. No TTL — the OS
  bumps mtime on child add/remove.

### 5.2 Branch

- **Mechanism:** direct `readFileSync(<gitDir>/HEAD)` + parse the
  `ref: refs/heads/<name>` line. No subprocess.
- **Cache:** none (pure FS, ~0.1 ms per repo).
- **Mid-op detection:** `<gitDir>/rebase-merge`, `<gitDir>/rebase-apply`,
  or `<gitDir>/MERGE_HEAD` render the branch slot as
  `yellow("(rebase)")` or `yellow("(merge)")`.

### 5.3 Dirty / ahead-behind

- **Mechanism:** `git -C <repo> status --porcelain=v2 --branch` per
  repo, **async parallel** via `execFile` with 2 s per-call timeout.
- **Cache:** `repo-status-<sha256(repoAbsPath):8>.json`, **5 s** TTL.
- **Stale-while-revalidate:** stale entries return the cached value
  immediately and trigger an async refresh whose result lands in cache
  for the next render. Cold start (no cache yet) awaits the refresh.
- **Failure:** a rejected/timed-out call yields `{ dirty: false,
  abError: true }` — branch still renders, `!` suffix omitted.

### 5.4 PR state — single batched GraphQL call

- **Mechanism:** one `gh api graphql` call per cache miss. The query
  has a per-repo alias:

  ```graphql
  query {
    r0: repository(owner: "owner1", name: "repo1") {
      pullRequests(
        headRefName: "main",
        first: 3,
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes { number url state isDraft mergedAt updatedAt headRefName }
      }
    }
    r1: repository(owner: "owner2", name: "repo2") { ... }
    ...
  }
  ```

  Repo slugs come from each repo's `<gitDir>/config` `remote.origin.url`
  parsed locally (pure FS). Non-GitHub origins, detached HEAD, and
  mid-op repos are excluded from the batch.

- **Identifier safety:** GraphQL aliases (`r0`, `r1`, ...) are
  sequential indices — no injection surface. Owner / name / branch
  strings are escaped (`\` → `\\`, `"` → `\"`) before being interpolated
  into string literals.

- **Match:** the response shape is `data.r0.pullRequests.nodes[]`.
  `nodes[0]` per alias is the most recently updated PR for that branch.
  Mapped to a badge via:

  | GraphQL state | `isDraft` | Badge | Color |
  |---|---|---|---|
  | `OPEN` | `false` | `#<n>` | green |
  | `OPEN` | `true` | `~#<n>` | yellow |
  | `MERGED` | (ignored) | `#<n>✓` | gray |
  | `CLOSED` | (ignored) | `#<n>✗` | dim gray |

- **Cache:** `parent-prs-<sha256(cwd):8>.json`. Keys are `slug#branch`
  so a branch change in one repo doesn't poison the others. TTL:
  **60 s** on success, **60 s** on empty result, **5 min** when `gh`
  is missing / unauthed / failed.

- **Failure:** any failure path (`gh` missing, auth missing, network
  error, non-zero exit, GraphQL `errors` populated) writes
  `{ disabled: true }` to the cache. All repos render without PR
  badges for the TTL window. Branches and dirty state are unaffected.

- **Rate limits:** GitHub GraphQL costs ~`1 + N` points per query
  with `first: 3`. Default user budget 5000 pts/hour. At `N=30` and
  60 s cache TTL, worst case ≈ 1860 pts/hour — well within budget.

### 5.5 Render budget

Steady state (warm caches): **5-15 ms** for 5-30 repos. Cold start
(no cache yet): **200-500 ms** once, then warm thereafter.

### 5.6 Process-spawn ceiling

`git status` fans out up to `N` concurrent processes (~3 FDs each).
At `N=30` that's ~90 FDs — well under macOS default `ulimit -n` 256.
No explicit throttling.

## 6. Configuration

| Env var | Effect | Default |
|---|---|---|
| `STATUSLINE_MULTI_REPO=0` | Disable multi-repo detection entirely | (enabled) |
| `STATUSLINE_WIDTH=<cols>` | Override rendering width for the packer + truncator | 80 |
| `COLUMNS=<cols>` | Same as above (POSIX-style fallback) | — |
| `STATUSLINE_MULTI_REPO_FORCE_FIXTURE=<path>` | Serve PR data from a recorded GraphQL response (dev / verify.sh smoke) | (unset) |
| `STATUSLINE_DEBUG=1` | Emit diagnostics to stderr | (off) |

Claude Code does not currently publish the statusline pane width to its
subprocess (no TTY, no `COLUMNS`), which is why the renderer needs the
explicit `STATUSLINE_WIDTH` override for users with wider statusline areas.

## 7. Affected files

New:
- `plugins/statusline/statusline/lib/multi-repo.mjs` — discovery,
  branch / status / remote parsing, sort + pack + format,
  `tryMultiRepo` orchestrator, PR cache.
- `plugins/statusline/statusline/lib/gh-prs.mjs` — GraphQL query
  builder, response parser, `runGhPrs` async exec wrapper, badge
  mapping.
- `plugins/statusline/tests/multi-repo.test.mjs` — unit tests
  (parse / sort / pack / wrap / render / discovery / status batch).
- `plugins/statusline/tests/gh-prs.test.mjs` — query builder, parser,
  reason-mapping tests with injected exec.
- `plugins/statusline/test-fixtures/gh-prs-mixed.json` — hand-built
  fixture covering open / draft / merged / closed.
- `plugins/statusline/test-fixtures/gh-prs-empty.json` — every alias
  empty.
- `plugins/statusline/test-fixtures/gh-prs-real-sample.json` — a
  recorded response from the live GitHub API.
- `plugins/statusline/test-fixtures/build-multi-repo-tree.mjs` —
  fixture builder used by `scripts/verify.sh` smoke.

Modified:
- `plugins/statusline/statusline/index.mjs` — line 1 branches on
  multi-repo / single-child / path-only.
- `plugins/statusline/statusline/lib/layout.mjs` — `MAX_LINES` 5 → 8;
  `effectiveTermWidth()` exported for shared use by `compose()` and
  the multi-repo packer.
- `plugins/statusline/.claude-plugin/plugin.json` — version bump
  `1.0.0` → `1.1.0`.
- `plugins/statusline/README.md` — new "Multi-repo mode" section.
- `scripts/verify.sh` — additional smoke that builds a 3-repo
  fixture tree, renders with `STATUSLINE_MULTI_REPO_FORCE_FIXTURE`,
  asserts non-empty multi-line output.

Existing modules reused as-is: `cache.mjs`, `colors.mjs`,
`hyperlink.mjs`, `stdin-info.mjs`. `git-info.mjs` (single-repo
branch + PR) is unchanged.

## 8. Versioning

Per repo `CLAUDE.md`: one PR ↔ one version bump. This PR bumps the
plugin to `1.1.0` (minor — additive). Tag at merge: `statusline-v1.1.0`.

## 9. Edge cases

| Case | Behavior |
|---|---|
| Zero child repos after activation (race) | Render only sub-line 1.a as `<path> \| 0 repos`. |
| Wrapped sub-lines exceed `MAX_LINES` | `compose()` drops tail lines silently; "N repos" in summary signals the cap. |
| Detached HEAD | Branch slot renders `yellow("(detached)")`; no PR badge. |
| Submodule / worktree (`.git` is a file) | `resolveGitDir` parses the `gitdir:` line; HEAD + status come from the real git dir. |
| Non-GitHub remote | Excluded from PR batch; branch + dirty indicator still render. |
| No remote | Same as non-GitHub. |
| Branch with no tracking remote | PR matching is by `headRefName` so a locally-pushed branch still resolves to its PR. |
| GraphQL rate limit / network failure | `{ disabled: true }` cache entry suppresses PR badges across all repos for 5 minutes; branches + dirty state remain. |

## 10. Open questions

- **Ahead/behind count as numerics** (e.g. `main!↑2`) — current
  design uses `!` only. Defer until requested.
- **Cache parsed `remote.origin.url` per repo** — currently re-parsed
  on every render. Cheap, but a long-TTL cache could shave a few µs.
  Defer.
- **Sort tiebreaker** — alphabetical for stability. Mtime-based
  ordering ("most recently touched first") was considered and
  rejected to keep the layout deterministic between renders.
