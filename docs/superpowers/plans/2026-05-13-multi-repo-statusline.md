# Multi-Repo Statusline Mode — Implementation Reference

Companion to `docs/superpowers/specs/2026-05-13-multi-repo-statusline.md`.
This file captures the as-built module layout, data flow, and test
strategy. The spec is the release-time source of truth; this file
exists to orient future maintainers.

## Module map

```
plugins/statusline/statusline/
├── index.mjs                       # entry; branches on single-repo /
│                                     multi-repo / single-child / path-only
├── lib/
│   ├── multi-repo.mjs              # core: discovery, parse, status batch,
│   │                                 PR cache, sort + pack + format,
│   │                                 tryMultiRepo orchestrator,
│   │                                 renderMultiRepoLines
│   ├── gh-prs.mjs                  # GraphQL query builder + runGhPrs
│   │                                 + parsePrsResponse + prToBadge
│   ├── layout.mjs                  # compose + truncateLine +
│   │                                 effectiveTermWidth (shared width source)
│   ├── git-info.mjs                # unchanged — single-repo branch + PR
│   ├── cache.mjs                   # unchanged — cacheDir + atomic JSON
│   ├── colors.mjs                  # unchanged — ANSI helpers
│   ├── hyperlink.mjs               # unchanged — OSC 8 helper
│   └── stdin-info.mjs              # unchanged — stdin JSON parsing
├── tests/
│   ├── multi-repo.test.mjs
│   ├── gh-prs.test.mjs
│   └── (existing tests untouched)
└── test-fixtures/
    ├── gh-prs-mixed.json
    ├── gh-prs-empty.json
    ├── gh-prs-real-sample.json
    └── build-multi-repo-tree.mjs   # used by scripts/verify.sh smoke
```

## Data flow per render

```
index.mjs main()
  │
  ├── parseStdin(raw)                       (existing)
  ├── gitBranch(info.cwd)                   (existing single-repo path)
  │
  └── if branch is null:
        tryMultiRepo(info.cwd)
          │
          ├── discoverRepos(cwd)                          (mtime-cached)
          │     └── readdirSync → resolveGitDir per child
          │
          ├── per repo: readBranchFromGitDir(gitDir)      (pure FS)
          ├── per repo: parseRemoteUrl(<gitDir>/config)   (pure FS)
          │
          ├── Promise.all(
          │     fetchRepoStatuses(repos)                  (5 s TTL,
          │       └── parallel `git status --porcelain=v2 --branch`)
          │     fetchPrsCached(cwd, entries)              (60 s TTL,
          │       └── single `gh api graphql` for all repos at once)
          │   )
          │
          └── merge results → records[]
        │
        └── renderMultiRepoLines(records, { path, termWidth })
              ├── sortByTierThenName(repos)               (active first)
              ├── formatRepoToken(repo) per repo
              └── packLines(tokens, termWidth)            (greedy wrap)

  → compose([...line1s, line2, line3, line4, line5])
    (MAX_LINES = 8, truncateLine clips each line at termWidth)
```

## Test strategy

`node:test` (built-in) under `plugins/statusline/tests/*.test.mjs`,
run via `bash scripts/verify.sh` locally and in `.github/workflows/test.yml`.

- **Pure helpers** (`parseStatusPorcelainV2`, `parseRemoteUrl`,
  `readBranchFromGitDir`, `resolveGitDir`, `buildPrsQuery`,
  `parsePrsResponse`, `prToBadge`, `escapeGraphqlString`,
  `priorityTier`, `formatRepoToken`, `packLine`, `packLines`,
  `renderMultiRepoLines`) — direct unit tests with golden inputs.
- **`discoverRepos` cache** — temp-dir fixtures + `CLAUDE_CONFIG_DIR`
  env override; asserts cache hit (file mtime unchanged) and
  invalidation on parent-dir mtime change.
- **`fetchRepoStatuses`** — injected `exec` stub records calls; asserts
  cold-start awaits, warm cache skips exec, stale path returns immediately
  and triggers bg refresh, per-repo failures yield `abError` without
  poisoning siblings.
- **`runGhPrs`** — injected `exec` stub covers every `reason` branch
  (`missing` / `unauth` / `timeout` / `errors` / `error` / success).
  Real `gh` is never invoked in unit tests.
- **Smoke (in `verify.sh`)** — builds a 3-repo fixture tree under
  `mktemp -d`, renders `index.mjs` with
  `STATUSLINE_MULTI_REPO_FORCE_FIXTURE` pointed at a recorded GraphQL
  response, asserts non-empty multi-line output and cleans up.

Total: 135 unit tests + 2 smoke renders, all dependency-free.

## Caching summary

| Cache | Path | TTL | Invalidation |
|---|---|---|---|
| Repo list | `parent-repos-<hash>.json` | none | parent dir `mtimeMs` change |
| Dirty / ahead-behind | `repo-status-<hash>.json` | 5 s | time-based + stale-while-revalidate |
| PR batch | `parent-prs-<hash>.json` | 60 s ok / 60 s empty / 5 min disabled | time-based + stale-while-revalidate |
| (existing) Single-repo PR | `pr-<hash>.json` | 60 / 60 / 300 s | unchanged |

Cache directory: `~/.claude/claude-code-statusline/cache/` (the existing
`cacheDir()` helper).

## Configuration knobs

| Env var | Default | Purpose |
|---|---|---|
| `STATUSLINE_MULTI_REPO` | (enabled) | `=0` disables multi-repo mode |
| `STATUSLINE_WIDTH` | 80 | render width override; takes precedence over `COLUMNS` |
| `COLUMNS` | (Claude Code does not set this) | fallback width if `STATUSLINE_WIDTH` is not set |
| `STATUSLINE_MULTI_REPO_FORCE_FIXTURE` | (unset) | path to a recorded GraphQL JSON; bypasses `gh` for dev / smoke |
| `STATUSLINE_DEBUG` | (off) | `=1` emits one-line diagnostics to stderr |

## Future considerations

- **Numeric ahead/behind** — surface `↑2 ↓1` after the branch instead
  of (or in addition to) `!`. Held until requested.
- **MAX_LINES overflow fallback** — if `compose()` is forced to drop
  wrapped repo lines often, switch to `packLine`'s `…+N more` label
  to make the cap visible.
- **`remote.origin.url` parse cache** — the file is re-read every
  render; a long-TTL cache (1 h) could shave µs. Not worth the
  complexity yet.
- **Multi-line model / usage row** when the statusline pane is
  unusually narrow — out of scope for this change.
