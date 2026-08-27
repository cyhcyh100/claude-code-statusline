# Repository conventions

## Plugin versioning

**One PR ↔ one `plugin.json` version bump.** Each merged PR ships exactly
one new version of the affected plugin; cosmetic exploration during PR
review stays inside the branch and is squash-merged into a single
release commit.

Why: Claude Code's plugin cache keys on the version string. Every version
bump triggers a re-extract for users on auto-update. We only want that
for shipped releases — not for in-flight tweaks during review.

How:
- New PR? Decide the SemVer bump (patch / minor / major) before merge.
- Iterating on review feedback? Don't bump the version mid-PR. Just
  commit changes; the final squash-merge lands as the one new version.
- Released? Tag the merge commit `<plugin>-v<version>` and push the tag.

Plugins covered today: `plugins/statusline/`. Future plugins under
`plugins/` follow the same policy.

## Testing & validation

### Where tests and fixtures live

- Unit tests: `plugins/<plugin>/tests/*.test.mjs` using Node's built-in
  `node:test`. Cover pure functions; inject `Date.now`, network calls,
  and other side effects as options so tests stay deterministic.
- Fixtures: `plugins/<plugin>/test-fixtures/`. Relative paths only —
  absolute paths break portability. Build paths at runtime when needed.

### Pre-PR validation

Run **`bash scripts/verify.sh`** from the repo root before you commit.
It runs every plugin's unit tests, syntax-checks every `.mjs`, validates
every plugin/marketplace JSON, and smoke-renders the statusline so a
crash regression fails loudly. CI runs the same script on every PR via
`.github/workflows/test.yml`.

Don't reply to review threads, commit, or push until this passes. If a
failure looks unrelated to your change, note the rationale in the PR
description rather than skipping the check.

### Conventions for new plugins

- ESM (`.mjs`). No `package.json`, no new runtime dependencies — stay
  dependency-free so users don't need an install step.
- Use `execFileSync` with `stdio: ["ignore", "pipe", "ignore"]`. Never
  build shell command strings with template literals.
- Sanitize external strings before emitting terminal escapes, inserting
  into JSON, or building file paths.
- Atomic writes go through `cache.mjs`'s `writeJsonAtomic(path, obj,
  { mode?, indent? })` — don't re-roll `tmp + rename`.
- Add a `tests/` directory that covers the new code's pure functions,
  and (if the plugin renders to stdout) wire a smoke check into
  `scripts/verify.sh`.

### Spec-first workflow

Non-trivial changes go through `docs/superpowers/specs/<date>-<name>.md`
(the design) and `docs/superpowers/plans/<date>-<name>.md` (the
implementation plan). Keep both in sync as the implementation evolves;
before opening / squash-merging the PR, update the spec so it matches
the merged state — the spec is the release-time source of truth.
