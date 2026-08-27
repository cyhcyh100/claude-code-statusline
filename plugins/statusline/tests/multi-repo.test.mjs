// Unit tests for plugins/statusline/statusline/lib/multi-repo.mjs
// pure parse helpers. Uses Node's built-in test runner + temp dirs for
// fixture-based readBranchFromGitDir / resolveGitDir checks.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readBranchFromGitDir,
  parseStatusPorcelainV2,
  parseRemoteUrl,
  resolveGitDir,
  discoverRepos,
  fetchRepoStatuses,
  priorityTier,
  formatRepoToken,
  packLine,
  packLines,
  renderMultiRepoLines,
  tryMultiRepo,
  stripControl,
} from "../statusline/lib/multi-repo.mjs";
import { cacheDir } from "../statusline/lib/cache.mjs";

// Strip ANSI escapes + OSC 8 hyperlinks so we can compare plain text
// in golden assertions.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const strip = (s) => String(s).replace(ANSI_RE, "");

// ----- parseStatusPorcelainV2 -----

test("parseStatusPorcelainV2: clean tree returns dirty=false", () => {
  const out = parseStatusPorcelainV2(
    "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"
  );
  assert.deepEqual(out, { dirty: false, ahead: 0, behind: 0 });
});

test("parseStatusPorcelainV2: single modified file marks dirty", () => {
  const out = parseStatusPorcelainV2(
    "# branch.head main\n1 .M N... 100644 100644 100644 abc def README.md\n"
  );
  assert.equal(out.dirty, true);
  assert.equal(out.ahead, 0);
  assert.equal(out.behind, 0);
});

test("parseStatusPorcelainV2: untracked file marks dirty", () => {
  const out = parseStatusPorcelainV2("# branch.head main\n? new-file.txt\n");
  assert.equal(out.dirty, true);
});

test("parseStatusPorcelainV2: ahead/behind parsed and triggers dirty", () => {
  const out = parseStatusPorcelainV2(
    "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n"
  );
  assert.equal(out.ahead, 2);
  assert.equal(out.behind, 1);
  assert.equal(out.dirty, true, "non-zero ahead/behind must mark dirty");
});

test("parseStatusPorcelainV2: dirty + ahead combined", () => {
  const out = parseStatusPorcelainV2(
    "# branch.head main\n# branch.ab +3 -0\n1 .M N... 100644 100644 100644 a b README.md\n"
  );
  assert.deepEqual(out, { dirty: true, ahead: 3, behind: 0 });
});

test("parseStatusPorcelainV2: empty input returns safe default", () => {
  assert.deepEqual(parseStatusPorcelainV2(""), { dirty: false, ahead: 0, behind: 0 });
  assert.deepEqual(parseStatusPorcelainV2(null), { dirty: false, ahead: 0, behind: 0 });
  assert.deepEqual(parseStatusPorcelainV2(undefined), { dirty: false, ahead: 0, behind: 0 });
});

test("parseStatusPorcelainV2: CRLF line endings tolerated", () => {
  const out = parseStatusPorcelainV2(
    "# branch.head main\r\n# branch.ab +0 -0\r\n? foo\r\n"
  );
  assert.equal(out.dirty, true);
});

test("parseStatusPorcelainV2: unmerged conflict (u) marks dirty", () => {
  const out = parseStatusPorcelainV2(
    "# branch.head main\nu UU N... 100644 100644 100644 100644 a b c d conflict.txt\n"
  );
  assert.equal(out.dirty, true);
});

// ----- parseRemoteUrl -----

const cfg = (url) =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test("parseRemoteUrl: SSH form with .git suffix", () => {
  assert.deepEqual(
    parseRemoteUrl(cfg("git@github.com:foo/bar.git")),
    { owner: "foo", repo: "bar" }
  );
});

test("parseRemoteUrl: SSH form without .git suffix", () => {
  assert.deepEqual(
    parseRemoteUrl(cfg("git@github.com:octocat/hello-world")),
    { owner: "octocat", repo: "hello-world" }
  );
});

test("parseRemoteUrl: HTTPS form with .git", () => {
  assert.deepEqual(
    parseRemoteUrl(cfg("https://github.com/foo/bar.git")),
    { owner: "foo", repo: "bar" }
  );
});

test("parseRemoteUrl: HTTPS form without .git", () => {
  assert.deepEqual(
    parseRemoteUrl(cfg("https://github.com/foo/bar")),
    { owner: "foo", repo: "bar" }
  );
});

test("parseRemoteUrl: HTTPS with embedded token in URL", () => {
  assert.deepEqual(
    parseRemoteUrl(cfg("https://x-access-token:abc@github.com/foo/bar.git")),
    { owner: "foo", repo: "bar" }
  );
});

test("parseRemoteUrl: GitLab origin returns null", () => {
  assert.equal(parseRemoteUrl(cfg("git@gitlab.com:foo/bar.git")), null);
  assert.equal(parseRemoteUrl(cfg("https://gitlab.com/foo/bar.git")), null);
});

test("parseRemoteUrl: empty / missing input returns null", () => {
  assert.equal(parseRemoteUrl(""), null);
  assert.equal(parseRemoteUrl(null), null);
  assert.equal(parseRemoteUrl("[core]\n\trepositoryformatversion = 0\n"), null);
});

test("parseRemoteUrl: only non-origin remotes returns null", () => {
  const c =
    `[remote "upstream"]\n\turl = git@github.com:foo/bar.git\n` +
    `[remote "fork"]\n\turl = git@github.com:me/bar.git\n`;
  assert.equal(parseRemoteUrl(c), null);
});

test("parseRemoteUrl: origin among many remotes still parsed", () => {
  const c =
    `[remote "upstream"]\n\turl = git@github.com:upstream/x.git\n` +
    `[remote "origin"]\n\turl = git@github.com:me/x.git\n`;
  assert.deepEqual(parseRemoteUrl(c), { owner: "me", repo: "x" });
});

// ----- readBranchFromGitDir + resolveGitDir (fixture-based) -----

function makeTempGitDir() {
  const root = mkdtempSync(join(tmpdir(), "statusline-mr-"));
  return root;
}

test("readBranchFromGitDir: parses ref: refs/heads/<branch>", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    assert.deepEqual(
      readBranchFromGitDir(dir),
      { branch: "main", detached: false, midOp: null }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: branch with slashes preserved", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/feat/something-cool\n");
    assert.equal(readBranchFromGitDir(dir).branch, "feat/something-cool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: raw SHA marks detached, branch null", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "abc123def456abc123def456abc123def456abcd\n");
    const out = readBranchFromGitDir(dir);
    assert.equal(out.branch, null);
    assert.equal(out.detached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: missing HEAD returns nulls without throwing", () => {
  const dir = makeTempGitDir();
  try {
    const out = readBranchFromGitDir(dir);
    assert.deepEqual(out, { branch: null, detached: false, midOp: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: rebase-merge/ marks midOp=rebase", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "rebase-merge"));
    assert.equal(readBranchFromGitDir(dir).midOp, "rebase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: rebase-apply/ also marks midOp=rebase", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "rebase-apply"));
    assert.equal(readBranchFromGitDir(dir).midOp, "rebase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBranchFromGitDir: MERGE_HEAD marks midOp=merge", () => {
  const dir = makeTempGitDir();
  try {
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, "MERGE_HEAD"), "deadbeef\n");
    assert.equal(readBranchFromGitDir(dir).midOp, "merge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGitDir: real .git directory returns its absolute path", () => {
  const child = makeTempGitDir();
  try {
    const realGitDir = join(child, ".git");
    mkdirSync(realGitDir);
    writeFileSync(join(realGitDir, "HEAD"), "ref: refs/heads/main\n");
    assert.equal(resolveGitDir(child), realGitDir);
  } finally {
    rmSync(child, { recursive: true, force: true });
  }
});

test("resolveGitDir: pointer file with absolute gitdir is followed", () => {
  const main = makeTempGitDir();
  const child = makeTempGitDir();
  try {
    const realGitDir = join(main, "worktree-target");
    mkdirSync(realGitDir);
    writeFileSync(join(child, ".git"), `gitdir: ${realGitDir}\n`);
    assert.equal(resolveGitDir(child), realGitDir);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test("resolveGitDir: pointer file with relative gitdir resolves against child", () => {
  const child = makeTempGitDir();
  try {
    const realGitDir = join(child, "..", "shared-git");
    mkdirSync(realGitDir);
    writeFileSync(join(child, ".git"), `gitdir: ../shared-git\n`);
    const out = resolveGitDir(child);
    // resolve() canonicalizes the .. — both paths point to the same dir
    assert.ok(out, "expected a path");
    assert.equal(out, realGitDir);
  } finally {
    rmSync(child, { recursive: true, force: true });
    rmSync(join(child, "..", "shared-git"), { recursive: true, force: true });
  }
});

test("resolveGitDir: no .git at all returns null", () => {
  const child = makeTempGitDir();
  try {
    assert.equal(resolveGitDir(child), null);
  } finally {
    rmSync(child, { recursive: true, force: true });
  }
});

test("resolveGitDir: .git file without gitdir: line returns null", () => {
  const child = makeTempGitDir();
  try {
    writeFileSync(join(child, ".git"), "garbage content with no gitdir line\n");
    assert.equal(resolveGitDir(child), null);
  } finally {
    rmSync(child, { recursive: true, force: true });
  }
});

// ----- stripControl -----

test("stripControl: removes terminal control characters", () => {
  // ESC-based SGR injection — the clone-poisoning vector.
  assert.equal(stripControl("main\x1b[31mPWNED"), "main[31mPWNED");
  assert.equal(stripControl("\x1b]0;title\x07"), "]0;title");
  // Other C0 controls + DEL.
  assert.equal(stripControl("a\x00b\x07c\x7fd"), "abcd");
  assert.equal(stripControl("line\nbreak\ttab"), "linebreaktab");
});

test("stripControl: leaves normal strings untouched", () => {
  assert.equal(stripControl("feat/some-branch"), "feat/some-branch");
  assert.equal(stripControl("main"), "main");
  // Non-ASCII printable characters must survive.
  assert.equal(stripControl("브랜치-名前"), "브랜치-名前");
});

test("stripControl: null / undefined / non-string coerce to a safe string", () => {
  assert.equal(stripControl(null), "");
  assert.equal(stripControl(undefined), "");
  assert.equal(stripControl(42), "42");
});

// ----- priorityTier -----

const mkRepo = (name, opts = {}) => ({
  name,
  branch: opts.branch || "main",
  dirty: !!opts.dirty,
  ahead: opts.ahead || 0,
  behind: opts.behind || 0,
  detached: !!opts.detached,
  midOp: opts.midOp || null,
  pr: opts.pr || null,
});

test("priorityTier: dirty + open PR ranks first", () => {
  assert.equal(priorityTier(mkRepo("a", { dirty: true, pr: { kind: "open" } })), 1);
});
test("priorityTier: dirty + draft PR", () => {
  assert.equal(priorityTier(mkRepo("a", { dirty: true, pr: { kind: "draft" } })), 2);
});
test("priorityTier: dirty without active PR", () => {
  assert.equal(priorityTier(mkRepo("a", { dirty: true })), 3);
  assert.equal(priorityTier(mkRepo("a", { dirty: true, pr: { kind: "merged" } })), 3);
  assert.equal(priorityTier(mkRepo("a", { dirty: true, pr: { kind: "closed" } })), 3);
});
test("priorityTier: ahead/behind treated as dirty", () => {
  assert.equal(priorityTier(mkRepo("a", { ahead: 2, pr: { kind: "open" } })), 1);
  assert.equal(priorityTier(mkRepo("a", { behind: 1 })), 3);
});
test("priorityTier: clean + open / draft", () => {
  assert.equal(priorityTier(mkRepo("a", { pr: { kind: "open" } })), 4);
  assert.equal(priorityTier(mkRepo("a", { pr: { kind: "draft" } })), 5);
});
test("priorityTier: quiet — merged < closed < none", () => {
  assert.equal(priorityTier(mkRepo("a", { pr: { kind: "merged" } })), 6);
  assert.equal(priorityTier(mkRepo("a", { pr: { kind: "closed" } })), 7);
  assert.equal(priorityTier(mkRepo("a")), 8);
});

// ----- formatRepoToken -----

test("formatRepoToken: clean + no PR renders glyph, name, branch", () => {
  const s = strip(formatRepoToken(mkRepo("alpha")));
  assert.match(s, / alpha main$/);
});

test("formatRepoToken: dirty appends '!'", () => {
  const s = strip(formatRepoToken(mkRepo("alpha", { dirty: true })));
  assert.match(s, /alpha main!$/);
});

test("formatRepoToken: ahead/behind also produces '!'", () => {
  assert.match(strip(formatRepoToken(mkRepo("a", { ahead: 1 }))), /main!$/);
});

test("formatRepoToken: open PR badge", () => {
  const s = strip(formatRepoToken(mkRepo("alpha", { pr: { kind: "open", number: 42, url: "u" } })));
  assert.match(s, /alpha main\s+#42$/);
});

test("formatRepoToken: draft PR uses '~#N'", () => {
  const s = strip(formatRepoToken(mkRepo("a", { pr: { kind: "draft", number: 17, url: "u" } })));
  assert.match(s, /~#17$/);
});

test("formatRepoToken: merged uses '✓', closed uses '✗'", () => {
  assert.match(strip(formatRepoToken(mkRepo("a", { pr: { kind: "merged", number: 5, url: "u" } }))), /#5✓$/);
  assert.match(strip(formatRepoToken(mkRepo("a", { pr: { kind: "closed", number: 9, url: "u" } }))), /#9✗$/);
});

test("formatRepoToken: mid-op / detached overrides branch slot", () => {
  assert.match(strip(formatRepoToken(mkRepo("a", { midOp: "rebase" }))), /\(rebase\)/);
  assert.match(strip(formatRepoToken(mkRepo("a", { midOp: "merge" }))), /\(merge\)/);
  assert.match(strip(formatRepoToken(mkRepo("a", { detached: true, branch: null }))), /\(detached\)/);
});

// ----- packLine -----

test("packLine: empty input returns empty", () => {
  assert.deepEqual(packLine([], 100), { visible: [], dropped: 0 });
});

test("packLine: everything fits → all visible, dropped 0", () => {
  const tokens = ["aaa", "bbb", "ccc"]; // widths 3,3,3 + 2 seps of 6 = 21
  assert.deepEqual(packLine(tokens, 100), { visible: tokens, dropped: 0 });
});

test("packLine: drops tail when overflow needed", () => {
  // 12-char tokens, 5-char seps (`"  ·  "`), "…+N quiet" label = 9 chars.
  // 3 tokens with seps = 12+5+12+5+12 = 46. max=45 forces overflow,
  // but the 2-fit case (12+5+12+5+9=43) still fits. (Token width
  // must exceed the overflow-label width or the pre-reserved slot
  // dominates and we drop more than one tail entry.)
  const tokens = ["x".repeat(12), "y".repeat(12), "z".repeat(12)];
  const overflowLabelFn = (n) => `…+${n} quiet`;
  const out = packLine(tokens, 45, { overflowLabelFn });
  assert.equal(out.visible.length, 2);
  assert.equal(out.dropped, 1);
});

test("packLine: even a single oversized token is included", () => {
  // 50-char token, maxVisible 10 → still returned (truncated downstream).
  const tokens = ["x".repeat(50)];
  const out = packLine(tokens, 10, { overflowLabelFn: (n) => `…+${n} more` });
  assert.equal(out.visible.length, 1);
  assert.equal(out.dropped, 0);
});

// ----- renderMultiRepoLines -----

test("renderMultiRepoLines: 0 repos shows only line A with '0 repos'", () => {
  const lines = renderMultiRepoLines([], { path: "~/infra" });
  assert.equal(lines.length, 1);
  assert.match(strip(lines[0]), /^~\/infra\s+\|\s+0 repos$/);
});

test("renderMultiRepoLines: mixed scenario flows into a single wrap stream", () => {
  const repos = [
    mkRepo("alpha",  { branch: "main",       dirty: true, pr: { kind: "open",   number: 42, url: "u" } }),
    mkRepo("beta",   { branch: "fix-bug",                pr: { kind: "draft",  number: 17, url: "u" } }),
    mkRepo("shared", { branch: "rename-foo", dirty: true, pr: { kind: "closed", number: 99, url: "u" } }),
    mkRepo("gamma",  { branch: "main" }),
    mkRepo("old",    { branch: "feature",                pr: { kind: "merged", number:  5, url: "u" } }),
  ];
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 200 });
  // Wide termWidth → summary + one packed repo line.
  assert.equal(lines.length, 2);

  // Summary counts: 5 repos, 2 dirty, 1 open, 1 draft.
  assert.match(strip(lines[0]), /5 repos · 2 dirty · 1 open PR · 1 draft/);

  // Repo line contains every entry, in tier order.
  const repoLine = strip(lines[1]);
  assert.match(repoLine, /alpha\s+main!\s+#42/);
  assert.match(repoLine, /shared\s+rename-foo!\s+#99✗/);
  assert.match(repoLine, /beta\s+fix-bug\s+~#17/);
  assert.match(repoLine, /old\s+feature\s+#5✓/);
  assert.match(repoLine, /gamma\s+main/);

  // Tier ordering across the merged stream:
  //   alpha (dirty+open, 1) < shared (dirty+closed, 3) <
  //   beta (clean+draft, 5) < old (clean+merged, 6) < gamma (clean+no PR, 8)
  const order = ["alpha", "shared", "beta", "old", "gamma"];
  let prev = -1;
  for (const name of order) {
    const idx = repoLine.indexOf(name);
    assert.ok(idx > prev, `${name} should appear after the previous tier`);
    prev = idx;
  }
});

test("renderMultiRepoLines: only-quiet scenario still emits summary + 1 repo line", () => {
  const repos = [mkRepo("a"), mkRepo("b", { pr: { kind: "merged", number: 1, url: "u" } })];
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 200 });
  assert.equal(lines.length, 2);
  assert.match(strip(lines[1]), /b\s+main/);
});

test("renderMultiRepoLines: only-active scenario still emits summary + 1 repo line", () => {
  const repos = [mkRepo("a", { dirty: true, pr: { kind: "open", number: 1, url: "u" } })];
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 200 });
  assert.equal(lines.length, 2);
  assert.match(strip(lines[1]), /a\s+main!\s+#1/);
});

test("renderMultiRepoLines: quiet repo tail-fills the line after the last active repo", () => {
  // 4 dirty actives + 2 quiet (matches the user's split-pane case).
  // At wide termWidth (200), all 6 fit on one line — proving the
  // single-stream packer pulls quiet repos onto the same wrap line
  // as the trailing active(s) when there's room.
  const repos = [
    mkRepo("enterprise-eks",       { dirty: true }),
    mkRepo("enterprise-license",   { dirty: true }),
    mkRepo("staging-eks",          { dirty: true }),
    mkRepo("team-cloud-env-infra", { dirty: true }),
    mkRepo("dev-env-infra",        {}),  // clean → quiet
    mkRepo("helm-charts",          {}),  // clean → quiet
  ];
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 200 });
  assert.equal(lines.length, 2, "wide width → summary + 1 packed line");
  assert.match(strip(lines[1]), /team-cloud-env-infra.*dev-env-infra.*helm-charts/);
});

test("renderMultiRepoLines: wraps quiet repos across multiple lines (no overflow label)", () => {
  // 10 clean+no-pr repos. With a narrow termWidth they wrap rather
  // than overflow — every repo must appear somewhere in the output.
  const repos = Array.from({ length: 10 }, (_, i) => mkRepo(`repo${i}`));
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 50 });
  assert.ok(lines.length > 2, `expected wrapping (>2 lines), got ${lines.length}`);
  // No overflow markers
  for (const l of lines) {
    assert.equal(/…\+\d+ (more|quiet)/.test(strip(l)), false, "no overflow label expected");
  }
  // Every repo name appears at least once
  const joined = lines.map(strip).join("\n");
  for (let i = 0; i < 10; i++) {
    assert.match(joined, new RegExp(`\\brepo${i}\\b`));
  }
});

test("renderMultiRepoLines: wraps active repos across multiple lines", () => {
  // 10 dirty+open repos — all active. Narrow width forces wrap, not
  // overflow.
  const repos = Array.from({ length: 10 }, (_, i) =>
    mkRepo(`repo${i}`, { dirty: true, pr: { kind: "open", number: i + 1, url: "u" } })
  );
  const lines = renderMultiRepoLines(repos, { path: "~/infra", termWidth: 60 });
  assert.ok(lines.length >= 3, `expected ≥3 lines (summary + ≥2 wrapped active), got ${lines.length}`);
  const joined = lines.map(strip).join("\n");
  // Every PR number visible (no overflow truncation)
  for (let i = 1; i <= 10; i++) {
    assert.match(joined, new RegExp(`#${i}\\b`));
  }
});

// ----- packLines (multi-line wrap) -----

test("packLines: empty input returns empty array", () => {
  assert.deepEqual(packLines([], 100), []);
});

test("packLines: everything fitting on one line returns one entry", () => {
  // 3-char tokens × 3 + 2 separators × 6 = 21 cols
  const out = packLines(["aaa", "bbb", "ccc"], 100);
  assert.equal(out.length, 1);
  // single line contains all three tokens (separator characters between)
  assert.match(strip(out[0]), /aaa.*bbb.*ccc/);
});

test("packLines: wraps when a token won't fit on the current line", () => {
  // 12-char tokens; max 30 → roughly one per line (each token alone is
  // 12 cols, two tokens + sep = 30 exactly).
  const tokens = ["x".repeat(12), "y".repeat(12), "z".repeat(12)];
  const out = packLines(tokens, 30);
  assert.equal(out.length, 2, "should split into 2 lines");
  // Combined output contains every token, in order
  const flat = out.map(strip).join(" ");
  assert.match(flat, /xxxxxxxxxxxx.*yyyyyyyyyyyy.*zzzzzzzzzzzz/);
});

test("packLines: oversize single token still gets its own line", () => {
  const tokens = ["x".repeat(50), "y"];
  const out = packLines(tokens, 10);
  // First line has the oversize token alone; second line has "y".
  assert.equal(out.length, 2);
  assert.match(strip(out[0]), /^x{50}$/);
  assert.match(strip(out[1]), /^y$/);
});

// ----- discoverRepos -----
//
// Override CLAUDE_CONFIG_DIR so the cache writes go into a temp dir
// instead of the real ~/.claude/claude-code-statusline/cache. Each test
// sets its own override and restores afterward.

async function withTempCacheDir(fn) {
  // Always async — `fn` may be sync or async; we await either way so
  // the temp-dir cleanup in `finally` runs only after `fn` settles. A
  // sync-only variant that did `try { return fn() } finally { rm }`
  // would tear down the temp dir before an async `fn`'s promise
  // resolved, breaking tests that observe cache files mid-flight.
  const before = process.env.CLAUDE_CONFIG_DIR;
  const cacheRoot = mkdtempSync(join(tmpdir(), "statusline-cache-"));
  process.env.CLAUDE_CONFIG_DIR = cacheRoot;
  try { return await fn(cacheRoot); }
  finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function makeRepoChild(parent, name) {
  const child = join(parent, name);
  mkdirSync(child);
  mkdirSync(join(child, ".git"));
  writeFileSync(join(child, ".git", "HEAD"), "ref: refs/heads/main\n");
  return child;
}

test("discoverRepos: returns child repos sorted alphabetically", async () => {
  await withTempCacheDir(() => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      makeRepoChild(parent, "zeta");
      makeRepoChild(parent, "alpha");
      makeRepoChild(parent, "mid");
      // Non-repo subdirectory — must be excluded
      mkdirSync(join(parent, "not-a-repo"));
      // Regular file at parent level — must be excluded
      writeFileSync(join(parent, "README.md"), "hello\n");

      const repos = discoverRepos(parent);
      assert.equal(repos.length, 3, "exactly 3 git repos");
      assert.deepEqual(repos.map(r => r.name), ["alpha", "mid", "zeta"]);
      for (const r of repos) {
        assert.equal(typeof r.absPath, "string");
        assert.equal(typeof r.gitDir, "string");
        assert.ok(r.gitDir.endsWith(".git"), "gitDir ends with .git for plain repos");
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("discoverRepos: missing / unreadable cwd returns empty array", async () => {
  await withTempCacheDir(() => {
    assert.deepEqual(discoverRepos("/this/path/does/not/exist-xyz123"), []);
  });
});

test("discoverRepos: second call hits cache (cache file mtime unchanged)", async () => {
  await withTempCacheDir(async (cacheRoot) => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      makeRepoChild(parent, "alpha");
      makeRepoChild(parent, "beta");
      discoverRepos(parent);

      // Find the cache file just written for this parent.
      const cacheFiles = readdirSync(
        cacheDir()
      ).filter(n => n.startsWith("parent-repos-"));
      assert.equal(cacheFiles.length, 1, "exactly one parent-repos cache file");
      const cacheFile = join(cacheDir(), cacheFiles[0]);
      const mtimeBefore = statSync(cacheFile).mtimeMs;

      // Brief wait so the FS mtime resolution can distinguish a write —
      // we expect NO write, but if there were one the mtime would advance.
      await new Promise(r => setTimeout(r, 20));

      const second = discoverRepos(parent);
      assert.equal(second.length, 2);
      const mtimeAfter = statSync(cacheFile).mtimeMs;
      assert.equal(
        mtimeAfter, mtimeBefore,
        "cache file must not be rewritten on cache hit"
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("discoverRepos: new child invalidates cache (parent mtime changes)", async () => {
  await withTempCacheDir(async (cacheRoot) => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      makeRepoChild(parent, "alpha");
      const first = discoverRepos(parent);
      assert.equal(first.length, 1);

      // Wait long enough that the parent dir mtime visibly advances.
      await new Promise(r => setTimeout(r, 20));
      makeRepoChild(parent, "beta");

      const second = discoverRepos(parent);
      assert.equal(second.length, 2, "new repo appears after cache invalidation");
      assert.deepEqual(second.map(r => r.name), ["alpha", "beta"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ----- fetchRepoStatuses -----

// Fake exec: returns a canned stdout per repo path. Records every
// invocation so tests can assert when the bg refresh ran.
function makeFakeExec(responses) {
  const calls = [];
  const exec = async (file, args /* , opts */) => {
    calls.push({ file, args });
    const cwdIdx = args.indexOf("-C");
    const path = cwdIdx >= 0 ? args[cwdIdx + 1] : null;
    if (responses[path] instanceof Error) throw responses[path];
    if (responses[path] === undefined) throw new Error(`no canned response for ${path}`);
    return { stdout: responses[path], stderr: "" };
  };
  exec.calls = calls;
  return exec;
}

test("fetchRepoStatuses: cold start awaits, returns parsed statuses", async () => {
  await withTempCacheDir(async () => {
    const repos = [
      { name: "alpha", absPath: "/tmp/alpha", gitDir: "/tmp/alpha/.git" },
      { name: "beta",  absPath: "/tmp/beta",  gitDir: "/tmp/beta/.git" },
    ];
    const exec = makeFakeExec({
      "/tmp/alpha": "# branch.head main\n# branch.ab +2 -0\n",
      "/tmp/beta":  "# branch.head main\n? new-file.txt\n",
    });
    const { values } = await fetchRepoStatuses(repos, { exec });
    assert.equal(exec.calls.length, 2, "cold start calls exec for every repo");
    assert.deepEqual(values.get("/tmp/alpha"), {
      dirty: true, ahead: 2, behind: 0, stale: false,
    });
    assert.deepEqual(values.get("/tmp/beta"), {
      dirty: true, ahead: 0, behind: 0, stale: false,
    });
  });
});

test("fetchRepoStatuses: warm cache returns immediately without invoking exec", async () => {
  await withTempCacheDir(async () => {
    const repos = [{ name: "alpha", absPath: "/tmp/alpha", gitDir: "/tmp/alpha/.git" }];
    let exec = makeFakeExec({
      "/tmp/alpha": "# branch.head main\n1 .M N... 100644 100644 100644 a b README.md\n",
    });
    await fetchRepoStatuses(repos, { exec });
    assert.equal(exec.calls.length, 1, "first call populates cache");

    // Second call within TTL — should be a pure cache read.
    exec = makeFakeExec({});
    const { values } = await fetchRepoStatuses(repos, { exec });
    assert.equal(exec.calls.length, 0, "warm cache must not invoke exec");
    assert.equal(values.get("/tmp/alpha").dirty, true);
    assert.equal(values.get("/tmp/alpha").stale, false);
  });
});

test("fetchRepoStatuses: stale entries return stale:true + bg refresh fires", async () => {
  await withTempCacheDir(async () => {
    const repos = [{ name: "alpha", absPath: "/tmp/alpha", gitDir: "/tmp/alpha/.git" }];
    const exec = makeFakeExec({
      "/tmp/alpha": "# branch.head main\n? foo\n",
    });
    // Populate cache with a generous TTL so the first call writes
    // fresh data. The second call uses ttl: -1 to force every entry
    // to be considered stale regardless of how recently it was
    // written (the production check is `age > ttl`).
    await fetchRepoStatuses(repos, { exec, ttl: 1_000_000 });
    const callsAfterFirst = exec.calls.length;

    const { values, refresh } = await fetchRepoStatuses(repos, { exec, ttl: -1 });
    // Stale value returned immediately
    assert.equal(values.get("/tmp/alpha").stale, true);
    // bg refresh has been kicked off — wait for it
    await refresh;
    assert.equal(exec.calls.length, callsAfterFirst + 1, "stale entry triggers refresh");
    // After refresh resolves, `values` was mutated with stale:false
    assert.equal(values.get("/tmp/alpha").stale, false);
  });
});

test("fetchRepoStatuses: per-repo failure yields abError without poisoning siblings", async () => {
  await withTempCacheDir(async () => {
    const repos = [
      { name: "alpha", absPath: "/tmp/alpha", gitDir: "/tmp/alpha/.git" },
      { name: "beta",  absPath: "/tmp/beta",  gitDir: "/tmp/beta/.git" },
    ];
    const broken = new Error("timeout");
    broken.signal = "SIGTERM";
    const exec = makeFakeExec({
      "/tmp/alpha": "# branch.head main\n",
      "/tmp/beta":  broken,
    });
    const { values } = await fetchRepoStatuses(repos, { exec });
    assert.equal(values.get("/tmp/alpha").dirty, false, "good repo parses cleanly");
    assert.equal(values.get("/tmp/beta").abError, true, "broken repo flagged abError");
    assert.equal(values.get("/tmp/beta").dirty, false, "broken repo defaults to dirty:false");
  });
});

// ----- tryMultiRepo orchestrator branches -----

test("tryMultiRepo: STATUSLINE_MULTI_REPO=0 short-circuits to null", async () => {
  await withTempCacheDir(async () => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      makeRepoChild(parent, "alpha");
      makeRepoChild(parent, "beta");
      const before = process.env.STATUSLINE_MULTI_REPO;
      process.env.STATUSLINE_MULTI_REPO = "0";
      try {
        assert.equal(await tryMultiRepo(parent), null);
      } finally {
        if (before === undefined) delete process.env.STATUSLINE_MULTI_REPO;
        else process.env.STATUSLINE_MULTI_REPO = before;
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("tryMultiRepo: zero child repos returns null", async () => {
  await withTempCacheDir(async () => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      // No git children — just a regular subdirectory and a file.
      mkdirSync(join(parent, "not-a-repo"));
      writeFileSync(join(parent, "README.md"), "hello\n");
      assert.equal(await tryMultiRepo(parent), null);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("tryMultiRepo: exactly one child returns { singleChild }", async () => {
  await withTempCacheDir(async () => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      makeRepoChild(parent, "lone");
      const out = await tryMultiRepo(parent);
      assert.ok(out, "should return an object, not null");
      assert.ok(out.singleChild, "should expose singleChild");
      assert.equal(out.singleChild.name, "lone");
      assert.ok(out.singleChild.absPath.endsWith("/lone"));
      // index.mjs reads readBranchFromGitDir(singleChild.gitDir), so the
      // gitDir property must be present and point at the child's .git.
      assert.ok(out.singleChild.gitDir, "should expose gitDir");
      assert.ok(
        out.singleChild.gitDir.endsWith("/.git"),
        "gitDir points at the child's .git directory"
      );
      assert.ok(!out.records, "records must be absent for single-child case");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

test("discoverRepos: worktree-style .git pointer files are followed", async () => {
  await withTempCacheDir(() => {
    const parent = mkdtempSync(join(tmpdir(), "statusline-parent-"));
    try {
      // alpha is a normal repo
      makeRepoChild(parent, "alpha");

      // beta is a "worktree" — .git is a pointer file
      const beta = join(parent, "beta");
      mkdirSync(beta);
      const sharedGit = join(parent, ".shared-git-beta");
      mkdirSync(sharedGit);
      writeFileSync(join(sharedGit, "HEAD"), "ref: refs/heads/feat\n");
      writeFileSync(join(beta, ".git"), `gitdir: ${sharedGit}\n`);

      const repos = discoverRepos(parent);
      assert.equal(repos.length, 2);
      const betaEntry = repos.find(r => r.name === "beta");
      assert.ok(betaEntry, "beta is discovered via pointer file");
      assert.equal(betaEntry.gitDir, sharedGit);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
