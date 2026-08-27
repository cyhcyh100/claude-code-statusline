// Multi-repo statusline mode — pure parse helpers + (in later tasks)
// repo discovery, dirty-status fetching, sort/pack/format.
//
// This task (Task 1 in
// docs/superpowers/plans/2026-05-13-multi-repo-statusline.md) covers
// only the pure parse helpers + resolveGitDir. The functions below
// take strings (or do minimal FS reads with no subprocess) so they're
// trivially testable.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { cacheDir, readJson, writeJsonAtomic, isExpired } from "./cache.mjs";
import { cyan, dim, gray, green, yellow } from "./colors.mjs";
import { visibleLength } from "./layout.mjs";
import { osc8 } from "./hyperlink.mjs";
import { runGhPrs, prToBadge } from "./gh-prs.mjs";

const execFileAsync = promisify(execFileCb);

// TTL for dirty/ahead-behind status cache. 5s matches spec §5.3 — the
// status changes only on explicit tool use, not between keystrokes,
// so a short TTL is fine.
const STATUS_TTL_MS = 5_000;

// Reads <gitDir>/HEAD and detects mid-op state.
//
// Returns { branch: string|null, detached: boolean, midOp: "rebase"|"merge"|null }
//
// - branch  : ref name when HEAD points at refs/heads/<name>
// - detached: true when HEAD is a raw object id (no symbolic ref)
// - midOp   : "rebase" if rebase-merge/ or rebase-apply/ exists;
//             "merge" if MERGE_HEAD exists; null otherwise.
//
// All errors swallow to a safe default — a missing or unreadable git
// dir produces { branch: null, detached: false, midOp: null } rather
// than throwing, because the statusline never wants to die over a
// degenerate child repo.
export function readBranchFromGitDir(gitDir) {
  let midOp = null;
  try {
    if (existsSync(join(gitDir, "rebase-merge")) ||
        existsSync(join(gitDir, "rebase-apply"))) {
      midOp = "rebase";
    } else if (existsSync(join(gitDir, "MERGE_HEAD"))) {
      midOp = "merge";
    }
  } catch { /* ignore */ }

  let branch = null;
  let detached = false;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (m) {
      branch = m[1];
    } else if (/^[0-9a-f]{40,64}$/i.test(head)) {
      detached = true;
    }
  } catch { /* ignore — branch stays null */ }

  return { branch, detached, midOp };
}

// Parses `git status --porcelain=v2 --branch` output.
//
// Returns { dirty: boolean, ahead: number, behind: number }
//
// dirty  = any tracked-change line ("1 ", "2 ", "u "), any untracked
//          ("? "), OR non-zero ahead/behind (the spec treats both as
//          "needs attention" → renders the yellow "!" suffix)
// ahead  = N from "# branch.ab +N -M"
// behind = M from same line
//
// Header lines start with "# branch.<something>". Non-header lines
// are entries. The function tolerates trailing newlines and Windows
// line endings.
export function parseStatusPorcelainV2(text) {
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/^# branch\.ab\s+\+(\d+)\s+-(\d+)\s*$/);
      if (m) {
        ahead = parseInt(m[1], 10) || 0;
        behind = parseInt(m[2], 10) || 0;
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    // any non-header line is an entry → working tree is dirty
    dirty = true;
  }
  if (ahead > 0 || behind > 0) dirty = true;
  return { dirty, ahead, behind };
}

// Parses a git `config` file's text and extracts the GitHub
// {owner, repo} slug from [remote "origin"].url.
//
// Returns { owner, repo } | null
//
// Handles SSH (git@github.com:owner/repo[.git]) and HTTPS
// (https://github.com/owner/repo[.git][/]) URL forms. Returns null
// when:
//  - the input is empty or missing
//  - no [remote "origin"] section exists
//  - the url isn't a GitHub URL (gitlab, bitbucket, custom hosts, etc.)
//
// Only the first url= line inside the origin section is used.
export function parseRemoteUrl(configText) {
  if (!configText) return null;
  const lines = String(configText).split(/\r?\n/);
  let inOrigin = false;
  let url = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[(.+?)(?:\s+"(.*)")?\]$/);
    if (sectionMatch) {
      inOrigin = sectionMatch[1] === "remote" && sectionMatch[2] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const kv = line.match(/^url\s*=\s*(.+?)\s*$/);
    if (kv) { url = kv[1]; break; }
  }
  if (!url) return null;

  // SSH form: git@github.com:owner/repo(.git)?
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  // HTTPS form: https://github.com/owner/repo(.git)?
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}

// Resolves the actual git directory for a child path that may be a
// normal repo, a submodule (.git is a file), or a worktree (.git is
// also a file pointing into the main repo's .git/worktrees/<name>).
//
// Returns absolute path to the git dir, or null when nothing usable
// is found.
export function resolveGitDir(childPath) {
  const dotGit = join(childPath, ".git");
  let st;
  try { st = statSync(dotGit); } catch { return null; }

  if (st.isDirectory()) return dotGit;

  if (st.isFile()) {
    try {
      const txt = readFileSync(dotGit, "utf-8");
      const m = txt.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const target = m[1];
      return isAbsolute(target) ? target : resolve(childPath, target);
    } catch {
      return null;
    }
  }

  return null;
}

// Cache path for the parent-repos list at a given cwd. Each parent
// directory gets its own cache file, keyed by sha256(cwd).
function reposCachePath(cwd) {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return join(cacheDir(), `parent-repos-${hash}.json`);
}

// Enumerates direct-child git repos of `cwd`, cached on the parent
// directory's mtime.
//
// Returns: Array<{ name: string, absPath: string, gitDir: string }>
//          sorted alphabetically by `name`.
//
// Cache invalidation: the parent dir's `mtimeMs` is the only signal.
// macOS / Linux both bump the dir's mtime when a child entry is added
// or removed, so cache hits are correct as long as nothing has been
// added or removed since the last scan.
//
// Errors are swallowed: a missing or unreadable cwd returns `[]`. The
// statusline must never die for filesystem reasons.
export function discoverRepos(cwd) {
  let mtimeMs;
  try { mtimeMs = statSync(cwd).mtimeMs; }
  catch { return []; }

  const cachePath = reposCachePath(cwd);
  const cached = readJson(cachePath);
  if (cached && cached.mtimeMs === mtimeMs && Array.isArray(cached.repos)) {
    return cached.repos;
  }

  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch { return []; }

  const repos = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    const absPath = join(cwd, entry.name);
    // Follow symlinks: readdirSync reports symlinks as such, not as
    // dirs even when the target is a directory.
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = statSync(absPath).isDirectory(); }
      catch { isDir = false; }
    }
    if (!isDir) continue;

    const gitDir = resolveGitDir(absPath);
    if (!gitDir) continue;

    repos.push({ name: entry.name, absPath, gitDir });
  }

  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  writeJsonAtomic(cachePath, {
    timestamp: Date.now(),
    mtimeMs,
    repos,
  });

  return repos;
}

// Cache path for a single repo's dirty/ahead-behind status. Keyed on
// the repo's absolute path, separate file per repo so writes don't
// contend.
function statusCachePath(repoAbsPath) {
  const hash = createHash("sha256").update(repoAbsPath).digest("hex").slice(0, 8);
  return join(cacheDir(), `repo-status-${hash}.json`);
}

// Async refresh: run `git status --porcelain=v2 --branch` against each
// repo in parallel, parse, write cache, return a Map of fresh values.
//
// A repo whose `git status` fails (timeout, missing git binary, etc.)
// is rendered with `{ dirty: false, abError: true }` and its cache is
// NOT overwritten — the existing (possibly stale) entry remains.
async function refreshStatuses(repos, runner) {
  const settled = await Promise.allSettled(
    repos.map(r =>
      runner("git", ["-C", r.absPath, "status", "--porcelain=v2", "--branch"], {
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    )
  );
  const out = new Map();
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const r = settled[i];
    if (r.status === "fulfilled" && r.value && typeof r.value.stdout === "string") {
      const parsed = parseStatusPorcelainV2(r.value.stdout);
      const entry = { timestamp: Date.now(), ...parsed };
      writeJsonAtomic(statusCachePath(repo.absPath), entry);
      out.set(repo.absPath, { ...parsed, stale: false });
    } else {
      out.set(repo.absPath, { dirty: false, ahead: 0, behind: 0, abError: true, stale: false });
    }
  }
  return out;
}

// Fetches dirty/ahead-behind status for each repo using a
// stale-while-revalidate strategy.
//
// Returns: { values, refresh }
//   values  — Map<repoAbsPath, { dirty, ahead, behind, stale?, abError? }>
//   refresh — Promise<void> for the in-flight background refresh.
//             Callers may ignore it (fire-and-forget) so the
//             statusline returns immediately; tests `await` it to
//             observe the mutated `values` deterministically.
//
// - Repos with a cache entry younger than `ttl` return that value.
// - Repos with an older cache entry return the stale value
//   (`stale: true`) *and* are included in the background refresh.
// - Repos with no cache entry are included in the refresh. If
//   *every* repo lacks a cache entry (cold start), the function
//   awaits the refresh before returning so the first render has data.
//   Otherwise the refresh runs in the background.
export async function fetchRepoStatuses(repos, { exec, ttl = STATUS_TTL_MS } = {}) {
  const runner = exec || ((f, a, o) => execFileAsync(f, a, o));
  const values = new Map();
  const needsRefresh = [];

  for (const repo of repos) {
    const cached = readJson(statusCachePath(repo.absPath));
    if (cached && typeof cached.timestamp === "number") {
      const stale = isExpired(cached, ttl);
      values.set(repo.absPath, {
        dirty: !!cached.dirty,
        ahead: cached.ahead || 0,
        behind: cached.behind || 0,
        stale,
      });
      if (stale) needsRefresh.push(repo);
    } else {
      needsRefresh.push(repo);
    }
  }

  if (needsRefresh.length === 0) {
    return { values, refresh: Promise.resolve() };
  }

  const refresh = refreshStatuses(needsRefresh, runner).then(fresh => {
    for (const [k, v] of fresh) values.set(k, v);
  });

  // Cold start: nothing cached yet for any repo. Block on the first
  // refresh so the render isn't empty. Subsequent renders hit cache.
  if (values.size === 0) await refresh;

  return { values, refresh };
}

// ============================================================================
// Sort + pack + format (Task 5)
// ============================================================================
//
// `multiRepo` records — the input shape consumed by the render layer —
// are `{ name, branch, detached, midOp, dirty, ahead, behind, pr }`
// where `pr` is a badge descriptor produced by `prToBadge` in
// `gh-prs.mjs`, or `null`. The render functions are pure: they take
// the merged record + a path/width and return strings.

// Priority tier for sub-line ordering. Lower numbers render first.
// Per spec §4.5:
//   1 — dirty + open PR        ← most urgent
//   2 — dirty + draft PR
//   3 — dirty (no PR or merged/closed)
//   4 — clean + open PR
//   5 — clean + draft PR
//   6 — clean + merged         ← quiet (sub-line 1.c)
//   7 — clean + closed
//   8 — clean + no PR
export function priorityTier(repo) {
  const dirty = !!(repo.dirty || repo.ahead || repo.behind);
  const kind = repo.pr && repo.pr.kind;
  if (dirty) {
    if (kind === "open") return 1;
    if (kind === "draft") return 2;
    return 3;
  }
  if (kind === "open") return 4;
  if (kind === "draft") return 5;
  if (kind === "merged") return 6;
  if (kind === "closed") return 7;
  return 8;
}

// Sort by tier ascending, then alphabetically by name for determinism
// (spec §4.5 + §13 open question — alphabetical chosen for stability).
function sortByTierThenName(repos) {
  return repos.slice().sort((a, b) => {
    const ta = priorityTier(a);
    const tb = priorityTier(b);
    if (ta !== tb) return ta - tb;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// Strip terminal control characters from user-controlled strings
// (repo directory names, branch refs) before they reach ANSI color
// helpers — defense in depth against a malformed `.git/HEAD` or a
// directory name containing `\x1b` that could otherwise inject extra
// escape sequences into the rendered line. Mirrors the sanitize done
// by `osc8()` for URLs. Exported so the single-repo render path in
// `index.mjs` can apply the same sanitize to its branch name.
export function stripControl(s) {
  return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]/g, "");
}

// Build the colorised PR badge for a repo. Returns null when there
// is no PR. The badge text is wrapped in an OSC 8 hyperlink to the
// PR URL so terminals that support it render a clickable link.
function formatPrBadge(pr) {
  if (!pr) return null;
  const n = pr.number;
  let text;
  switch (pr.kind) {
    case "open":   text = green(`#${n}`); break;
    case "draft":  text = yellow(`~#${n}`); break;
    case "merged": text = gray(`#${n}✓`); break;
    case "closed": text = dim(`#${n}✗`); break;
    default: return null;
  }
  return pr.url ? osc8(pr.url, text) : text;
}

// Render a single repo as a compact token for sub-lines 1.b/1.c.
//
// Shape (spec §4.2):
//    <repo> <branch>[!]  <pr-badge>?
//
//  ` ` — Nerd Font branch glyph (matches single-repo rendering)
//  Branch slot falls back to "(detached)" / "(rebase)" / "(merge)"
//  in yellow when the working state isn't on a normal branch.
//  Dirty / ahead-behind both render as a yellow "!" suffix.
export function formatRepoToken(repo) {
  const namePart = cyan(stripControl(repo.name));

  let branchPart;
  if (repo.midOp === "rebase") branchPart = yellow("(rebase)");
  else if (repo.midOp === "merge") branchPart = yellow("(merge)");
  else if (repo.detached || !repo.branch) branchPart = yellow("(detached)");
  else branchPart = cyan(stripControl(repo.branch));

  const dirty = !!(repo.dirty || repo.ahead || repo.behind);
  const dirtyMark = dirty ? yellow("!") : "";

  const badge = formatPrBadge(repo.pr);
  const badgePart = badge ? `  ${badge}` : "";

  return `${cyan("")} ${namePart} ${branchPart}${dirtyMark}${badgePart}`;
}

// Visible width of the inter-token separator "  ·  " (2 spaces + 1
// mid-dot + 2 spaces = 5 columns; the surrounding ANSI dim sequence
// is invisible).
const SEP = "  " + dim("·") + "  ";
const SEP_VISIBLE_W = 5;

// Greedy packer for repo tokens onto a single line.
//
// Used directly by tests; the multi-line variant `packLines` is what
// `renderMultiRepoLines` actually uses (we prefer wrapping over
// overflow labels so every repo stays visible by default).
//
// Returns: { visible: token[], dropped: number }
//
// `overflowLabelFn(n)` is a function that produces the ANSI-styled
// overflow label for `n` dropped tokens (e.g. "…+3 quiet"). It is
// invoked only to measure width while packing — the caller is
// responsible for appending the actual label after the join.
//
// If everything fits in `maxVisible`, all tokens are visible and
// `dropped` is 0. Otherwise the packer reserves room for the overflow
// label and drops the tail. A single token that exceeds the budget
// is still included as `visible[0]` (the layout truncation in
// `compose()` handles overshoots cosmetically).
export function packLine(tokens, maxVisible, { overflowLabelFn = null } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { visible: [], dropped: 0 };
  }

  const widths = tokens.map(t => visibleLength(t));
  const totalW = widths.reduce((s, w) => s + w, 0) +
                 SEP_VISIBLE_W * (tokens.length - 1);
  if (totalW <= maxVisible) {
    return { visible: tokens.slice(), dropped: 0 };
  }

  const visible = [];
  let widthSoFar = 0;
  for (let i = 0; i < tokens.length; i++) {
    const sepNeeded = visible.length > 0 ? SEP_VISIBLE_W : 0;
    const wouldDrop = tokens.length - 1 - i;
    const overflowSlot = wouldDrop > 0 && overflowLabelFn
      ? SEP_VISIBLE_W + visibleLength(overflowLabelFn(wouldDrop))
      : 0;
    if (widthSoFar + sepNeeded + widths[i] + overflowSlot <= maxVisible) {
      visible.push(tokens[i]);
      widthSoFar += sepNeeded + widths[i];
    } else {
      break;
    }
  }
  // Edge case: not even the first token fit. Include it anyway and
  // let the line-level truncation in layout.mjs ellipsize.
  if (visible.length === 0) visible.push(tokens[0]);
  return { visible, dropped: tokens.length - visible.length };
}

// Wrap a sequence of repo tokens across one or more lines so that
// each line stays within `maxVisible` columns. No overflow label —
// every token ends up on some line.
//
// Returns: string[]   (one element per wrapped sub-line)
//
// Pure greedy wrap: append to the current line until adding the next
// token (plus separator) would exceed `maxVisible`, then start a new
// line. A single token wider than `maxVisible` still occupies its
// own line by itself and is handled cosmetically by the line-level
// truncation in `compose()`.
export function packLines(tokens, maxVisible) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  const lines = [];
  let current = [];
  let widthSoFar = 0;
  for (const token of tokens) {
    const w = visibleLength(token);
    if (current.length === 0) {
      current.push(token);
      widthSoFar = w;
      continue;
    }
    if (widthSoFar + SEP_VISIBLE_W + w <= maxVisible) {
      current.push(token);
      widthSoFar += SEP_VISIBLE_W + w;
    } else {
      lines.push(current.join(SEP));
      current = [token];
      widthSoFar = w;
    }
  }
  if (current.length > 0) lines.push(current.join(SEP));
  return lines;
}

// Build the fleet summary segment of sub-line 1.a — "5 repos · 2
// dirty · 2 open PRs · 1 draft". The summary is entirely dim/gray so
// it visually defers to the per-repo tokens on sub-line 1.b.
function formatFleetSummary(repos) {
  const N = repos.length;
  const D = repos.filter(r => r.dirty || r.ahead || r.behind).length;
  const O = repos.filter(r => r.pr && r.pr.kind === "open").length;
  const X = repos.filter(r => r.pr && r.pr.kind === "draft").length;
  const parts = [`${N} repos`];
  if (D > 0) parts.push(`${D} dirty`);
  if (O > 0) parts.push(`${O} open PR${O === 1 ? "" : "s"}`);
  if (X > 0) parts.push(`${X} draft`);
  return gray(parts.join(" · "));
}

// Top-level orchestrator: turn `repos` into the sub-lines that
// replace line 1 of the statusline in multi-repo mode.
//
// Returns: string[] (path summary followed by wrapped repo lines).
//
// `path` is the already-home-relativized path (`~/infra/`); the
// caller is responsible for relativizing. Repo tokens wrap across
// additional sub-lines when they don't fit on one — every repo
// stays visible by default.
//
// Active (dirty / open / draft PR) repos sort before quiet (clean
// without active PR), but the renderer feeds the entire sorted
// stream into a single packer rather than wrapping active and quiet
// separately. That means the tail end of an active wrap line can
// be filled in with quiet repos — saves a sub-line when the active
// run ends mid-row. The `!` suffix and badge colors already signal
// dirty / PR status, so the active→quiet boundary doesn't need a
// dedicated line break.
export function renderMultiRepoLines(repos, { path, termWidth = 80 } = {}) {
  // Normalize first so the downstream helpers never see a non-array.
  if (!Array.isArray(repos)) repos = [];

  const FLEET_SEP = dim(" | ");
  const summary = formatFleetSummary(repos);
  const lineA = [cyan(path), summary].filter(Boolean).join(FLEET_SEP);

  if (repos.length === 0) return [lineA];

  const tokens = sortByTierThenName(repos).map(formatRepoToken);
  return [lineA, ...packLines(tokens, termWidth)];
}

// ============================================================================
// PR cache + tryMultiRepo orchestrator (Task 6)
// ============================================================================

const PR_TTL_OK_MS = 60_000;
const PR_TTL_DISABLED_MS = 5 * 60_000;

// A repo can have a PR looked up only when it's on a normal branch
// (no mid-op / no detached HEAD), has a parseable GitHub origin, and
// the branch name is non-null. Centralised so the entries-filter
// and the record-merge can never drift apart.
function isPrEligible(r) {
  return !!(r.slug && r.branch && !r.midOp && !r.detached);
}

function prCachePath(cwd) {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return join(cacheDir(), `parent-prs-${hash}.json`);
}

// Cached wrapper around runGhPrs. Returns:
//   { byKey: Map<"slug#branch", prNode|null>, refresh: Promise<void> }
//
// - Cache file lives at parent-prs-<sha256(cwd):8>.json
// - Each entry is keyed `slug#branch` so changing branches doesn't
//   poison neighbours' cached values.
// - On TTL hit AND all current keys present in cache: pure cache read.
// - On TTL miss OR any key missing: schedule refresh.
//   - Cold start (nothing usable cached) → await refresh before return.
//   - Otherwise return stale data immediately; refresh fills cache for
//     the next render (stale-while-revalidate per spec §5.5).
async function fetchPrsCached(cwd, entries, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { byKey: new Map(), refresh: Promise.resolve() };
  }

  const cachePath = prCachePath(cwd);
  const cached = readJson(cachePath);

  const cachedPrs = (cached && cached.prs) || {};
  const cachedDisabled = !!(cached && cached.disabled);
  const ttl = cachedDisabled ? PR_TTL_DISABLED_MS : PR_TTL_OK_MS;
  const ttlExpired = isExpired(cached, ttl);

  // Build current view from cache (only for entries whose key is
  // present — branch changes since last fetch produce a miss).
  const byKey = new Map();
  if (!cachedDisabled) {
    for (const e of entries) {
      const k = `${e.slug}#${e.branch}`;
      if (k in cachedPrs) byKey.set(k, cachedPrs[k]);
    }
  }

  const allCovered = entries.every(e => byKey.has(`${e.slug}#${e.branch}`));
  const needsRefresh = ttlExpired || (!cachedDisabled && !allCovered);

  if (!needsRefresh) {
    return { byKey, refresh: Promise.resolve() };
  }

  const refresh = runGhPrs(entries, opts).then(res => {
    if (res.ok) {
      const newPrs = { ...cachedPrs };
      for (const r of res.results) {
        const k = `${r.slug}#${r.branch}`;
        newPrs[k] = r.pr || null;
        byKey.set(k, r.pr || null);
      }
      writeJsonAtomic(cachePath, { timestamp: Date.now(), prs: newPrs });
    } else if (res.reason !== "empty") {
      // Any real failure (missing, unauth, timeout, errors, error)
      // → disable PR badges for the longer TTL window.
      writeJsonAtomic(cachePath, { timestamp: Date.now(), disabled: true });
    }
  });

  // Cold start: byKey is empty, must await so the first render has data.
  if (byKey.size === 0) await refresh;
  return { byKey, refresh };
}

// Top-level activation gate + data merge for multi-repo mode.
//
// Returns:
//   null                      — multi-repo mode does not apply
//   { singleChild }           — exactly one child repo; caller should
//                               render single-repo mode against it
//                               while keeping the parent path visible
//   { records, refresh }      — N ≥ 2 child repos; `records` is the
//                               array ready for `renderMultiRepoLines`
//
// The activation precondition (cwd-not-a-git-repo, env opt-out, ≥2
// children) is partially the caller's responsibility — this function
// assumes `cwd` is not a git repo when called. The env-var check is
// done here for convenience.
export async function tryMultiRepo(cwd, opts = {}) {
  if (process.env.STATUSLINE_MULTI_REPO === "0") return null;

  const repos = discoverRepos(cwd);
  if (repos.length === 0) return null;
  if (repos.length === 1) return { singleChild: repos[0] };

  // Decorate each repo with its HEAD / mid-op state + GitHub slug
  // (parsed locally from <gitDir>/config, no subprocess).
  const decorated = repos.map(r => {
    const head = readBranchFromGitDir(r.gitDir);
    let slug = null;
    try {
      const cfg = readFileSync(join(r.gitDir, "config"), "utf-8");
      const parsed = parseRemoteUrl(cfg);
      if (parsed) slug = `${parsed.owner}/${parsed.repo}`;
    } catch { /* leave slug=null */ }
    return {
      name: r.name,
      absPath: r.absPath,
      gitDir: r.gitDir,
      branch: head.branch,
      detached: head.detached,
      midOp: head.midOp,
      slug,
    };
  });

  // PRs are looked up only for repos that have a GitHub remote, a
  // non-null branch, and aren't mid-op / detached.
  const prEntries = decorated
    .filter(isPrEligible)
    .map(r => ({ slug: r.slug, branch: r.branch }));

  const [statusOut, prOut] = await Promise.all([
    fetchRepoStatuses(decorated, opts),
    fetchPrsCached(cwd, prEntries, opts),
  ]);

  const records = decorated.map(r => {
    const status = statusOut.values.get(r.absPath) || { dirty: false, ahead: 0, behind: 0 };
    let pr = null;
    if (isPrEligible(r)) {
      const node = prOut.byKey.get(`${r.slug}#${r.branch}`);
      pr = prToBadge(node);
    }
    return {
      name: r.name,
      branch: r.branch,
      detached: r.detached,
      midOp: r.midOp,
      dirty: !!status.dirty,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      pr,
    };
  });

  return {
    records,
    refresh: Promise.all([statusOut.refresh, prOut.refresh]).then(() => undefined),
  };
}
