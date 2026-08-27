#!/usr/bin/env bash
# Repo-wide validation gate. Run from the repo root before every PR
# (locally) and on every pull request / push to main (in CI via
# .github/workflows/test.yml). Dependency-free — only Node's built-in
# `--test` and `--check`. Uses bash for `set -o pipefail` so a failure
# anywhere in a pipeline (e.g., `find` failing before `xargs`) aborts
# the script.

set -euo pipefail
shopt -s nullglob

echo "→ unit tests"
# Same glob as `node --test` below — collect matches via shell expansion
# (with nullglob, no matches → empty array). Doesn't invoke `ls`, so we
# never accidentally hide permission errors or similar.
test_files=(plugins/*/tests/*.test.mjs)
if [ ${#test_files[@]} -eq 0 ]; then
  echo "ERROR: no test files match plugins/*/tests/*.test.mjs" >&2
  exit 1
fi
node --test 'plugins/*/tests/*.test.mjs'

echo "→ syntax check (.mjs)"
# `find -exec cmd {} \;` does NOT propagate cmd's non-zero exit through
# find's own status, so `set -e` wouldn't catch a failing `node --check`.
# Route through `xargs` which does propagate. `pipefail` covers the
# other direction: if `find` itself fails (missing dir, permissions),
# the whole pipeline aborts even though `xargs` would exit 0 with empty
# input. -print0 / -0 keeps weird filenames safe.
find plugins -type f -name '*.mjs' -print0 \
  | xargs -0 -n1 node --check

echo "→ JSON validation"
find .claude-plugin plugins -type f -name '*.json' -print0 \
  | xargs -0 -n1 node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8'))"

echo "→ smoke: statusline renders without throwing"
smoke_input=$(node -e 'process.stdout.write(JSON.stringify({cwd:process.cwd(),model:{id:"x",display_name:"X"},context_window:{used_percentage:42}}))')
smoke_out=$(printf '%s' "$smoke_input" | node plugins/statusline/statusline/index.mjs)
if [ -z "$smoke_out" ]; then
  echo "ERROR: statusline smoke render produced no output (renderer likely threw)" >&2
  exit 1
fi

echo "→ smoke: multi-repo statusline renders without throwing"
# Build a 3-repo fixture tree in a tempdir and render the multi-repo
# path with the PR fetch stubbed to a recorded GraphQL response (via
# STATUSLINE_MULTI_REPO_FORCE_FIXTURE). The render must produce output
# AND multiple lines (path summary + active + quiet sub-lines).
mr_dir=$(mktemp -d -t multi-repo-smoke.XXXXXX)
trap 'rm -rf "$mr_dir"' EXIT
node plugins/statusline/test-fixtures/build-multi-repo-tree.mjs "$mr_dir"
mr_input=$(TARGET_CWD="$mr_dir" node -e 'process.stdout.write(JSON.stringify({cwd:process.env.TARGET_CWD,model:{id:"x",display_name:"X"},context_window:{used_percentage:42}}))')
mr_out=$(printf '%s' "$mr_input" \
  | STATUSLINE_MULTI_REPO_FORCE_FIXTURE="$PWD/plugins/statusline/test-fixtures/gh-prs-mixed.json" \
    STATUSLINE_WIDTH=200 \
    node plugins/statusline/statusline/index.mjs)
if [ -z "$mr_out" ]; then
  echo "ERROR: multi-repo smoke render produced no output" >&2
  exit 1
fi
mr_line_count=$(printf '%s' "$mr_out" | wc -l | tr -d ' ')
# The model line + at least one repo line + the path line ≥ 3 lines.
# `wc -l` counts newlines, not lines, so a 3-line render reports 2.
if [ "$mr_line_count" -lt 2 ]; then
  echo "ERROR: multi-repo smoke produced too few lines ($mr_line_count)" >&2
  printf '%s\n' "$mr_out" >&2
  exit 1
fi
# main() swallows exceptions, so a multi-repo failure could silently
# fall back to a path-only line. Assert the fleet summary appears so
# the smoke can distinguish "multi-repo rendered" from "renderer threw
# and we got an unrelated line".
if ! printf '%s' "$mr_out" | grep -q "repos"; then
  echo "ERROR: multi-repo smoke output did not contain fleet summary 'repos' token" >&2
  printf '%s\n' "$mr_out" >&2
  exit 1
fi

echo "→ smoke: single-child fallback strips control chars from the branch"
# A parent dir with exactly one child repo exercises the single-child
# fallback (index.mjs → renderSingleRepoLine). The child's .git/HEAD is
# poisoned with a raw ESC-based SGR sequence; renderSingleRepoLine must
# sanitize it via stripControl so the injected `\033[31m` (plain red —
# never emitted by the statusline itself) does not survive into output.
poison_dir=$(mktemp -d -t single-child-smoke.XXXXXX)
trap 'rm -rf "$mr_dir" "$poison_dir"' EXIT
mkdir -p "$poison_dir/lone/.git"
printf 'ref: refs/heads/inject\033[31mX\n' > "$poison_dir/lone/.git/HEAD"
poison_input=$(TARGET_CWD="$poison_dir" node -e 'process.stdout.write(JSON.stringify({cwd:process.env.TARGET_CWD,model:{id:"x",display_name:"X"},context_window:{used_percentage:42}}))')
poison_out=$(printf '%s' "$poison_input" | node plugins/statusline/statusline/index.mjs)
if [ -z "$poison_out" ]; then
  echo "ERROR: single-child smoke render produced no output" >&2
  exit 1
fi
# -F: match the ESC + "[31m" byte sequence literally. Without it the
# "[31m" is parsed as a regex character class, which some grep
# implementations (e.g. ugrep) reject outright — the resulting exit 2
# would be silently treated as "no match" and the check would never
# fire.
if printf '%s' "$poison_out" | grep -qF $'\033[31m'; then
  echo "ERROR: single-child fallback did not strip the injected ANSI escape" >&2
  printf '%s\n' "$poison_out" | cat -v >&2
  exit 1
fi

echo "✓ all checks passed"
