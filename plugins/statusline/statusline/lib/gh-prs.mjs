// Batched PR lookup via `gh api graphql`.
//
// Why GraphQL: `gh search prs --json` does not expose `headRefName`, so
// PR↔branch matching by `gh search` is impossible. GraphQL lets us
// alias one `repository(owner, name) { pullRequests(headRefName: ...) }`
// per child repo in a single query — one network round trip for all N
// repos, returning only the PRs whose head ref matches each repo's
// current branch.
//
// All exports below are pure functions except `runGhPrs`, which is the
// async exec wrapper around `gh api graphql`.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFileCb);

// Escape a JS string for safe interpolation into a GraphQL string
// literal (non-block). Per the GraphQL spec, regular strings forbid
// raw line terminators and other control characters — they must
// appear as escape sequences. owner / repo / branch values originate
// from `.git/config` and `.git/HEAD`, so a clone-poisoning attacker
// could plant control bytes there.
const GRAPHQL_ESCAPES = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};
export function escapeGraphqlString(s) {
  return String(s)
    .replace(/[\\"\b\f\n\r\t]/g, c => GRAPHQL_ESCAPES[c])
    .replace(/[\x00-\x1f\x7f]/g, c =>
      "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// Build a batched GraphQL query that fetches the most-recent PR per
// (slug, branch) pair, aliased as r0, r1, ...
//
// Input:  Array<{ slug: "owner/name", branch: "ref" }>
// Output: GraphQL query string, or `null` when `entries` is empty.
//
// Each alias requests `first: 3` ordered by UPDATED_AT desc — only
// `nodes[0]` is consumed by the parser, but `first: 3` gives a small
// safety window if the orderBy semantics ever shift.
export function buildPrsQuery(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const blocks = entries.map((e, i) => {
    const [owner, repo] = String(e.slug || "").split("/");
    const o = escapeGraphqlString(owner);
    const r = escapeGraphqlString(repo);
    const b = escapeGraphqlString(e.branch || "");
    return `  r${i}: repository(owner: "${o}", name: "${r}") {
    pullRequests(headRefName: "${b}", first: 3, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number url state isDraft mergedAt updatedAt headRefName }
    }
  }`;
  });
  return `query {\n${blocks.join("\n")}\n}\n`;
}

// Map a PR record (with `state` and `isDraft`) to a badge descriptor.
// Pure mapping — callers (multi-repo render code) handle color/glyph
// styling. Returns `null` for unknown / null input.
export function prToBadge(pr) {
  if (!pr) return null;
  const state = String(pr.state || "").toUpperCase();
  if (state === "OPEN") {
    return pr.isDraft
      ? { kind: "draft", number: pr.number, url: pr.url }
      : { kind: "open", number: pr.number, url: pr.url };
  }
  if (state === "MERGED") return { kind: "merged", number: pr.number, url: pr.url };
  if (state === "CLOSED") return { kind: "closed", number: pr.number, url: pr.url };
  return null;
}

// Parse a `gh api graphql` response body and map per-alias results
// back to the input entries.
//
// Returns:
//   { ok: true, results: [{ slug, branch, pr: object|null }, ...] }
//   { ok: false, reason: "errors" | "malformed" }
//
// - `results` is aligned to `entries` by index (r0 → entries[0]).
// - `pr` is the GraphQL node verbatim (number/url/state/isDraft/…).
//   The render layer maps it to a badge via `prToBadge`.
// - When the API returned a non-empty `errors` array, the whole call
//   is rejected with `reason: "errors"` so a single bad repo doesn't
//   yield half-correct data.
export function parsePrsResponse(text, entries) {
  let body;
  try { body = JSON.parse(text); }
  catch { return { ok: false, reason: "malformed" }; }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return { ok: false, reason: "errors" };
  }

  const data = body.data || {};
  const results = entries.map((e, i) => {
    const alias = data[`r${i}`];
    const nodes = alias && alias.pullRequests && Array.isArray(alias.pullRequests.nodes)
      ? alias.pullRequests.nodes
      : [];
    return { slug: e.slug, branch: e.branch, pr: nodes[0] || null };
  });
  return { ok: true, results };
}

// Async invocation of `gh api graphql -f query=<built>`. Returns:
//   { ok: true, results: [...] }                  // success
//   { ok: false, reason: "empty" }                // entries was empty
//   { ok: false, reason: "missing"|"unauth"|"timeout"|"errors"|"error" }
//
// `exec` is injectable for tests; defaults to the real promisified
// `execFile`. Must conform to:
//   exec(file, args, opts) → Promise<{ stdout, stderr }>
// and throw an Error-shaped object with optional `.code` / `.signal`
// on failure.
export async function runGhPrs(entries, { timeout = 4000, exec } = {}) {
  const query = buildPrsQuery(entries);
  if (!query) return { ok: false, reason: "empty" };

  // Dev/test hook: serve a recorded GraphQL response from disk instead
  // of shelling out to `gh`. Useful for `verify.sh` smoke and for
  // exploring rendering without a live GitHub session.
  const fixturePath = process.env.STATUSLINE_MULTI_REPO_FORCE_FIXTURE;
  if (fixturePath) {
    try {
      const text = readFileSync(fixturePath, "utf-8");
      return parsePrsResponse(text, entries);
    } catch {
      return { ok: false, reason: "error" };
    }
  }

  const runner = exec || ((f, a, o) => execFileAsync(f, a, o));
  try {
    const { stdout } = await runner(
      "gh",
      ["api", "graphql", "-f", `query=${query}`],
      { timeout, maxBuffer: 8 * 1024 * 1024 }
    );
    return parsePrsResponse(stdout, entries);
  } catch (e) {
    return { ok: false, reason: classifyExecError(e) };
  }
}

// Map an execFile error shape to a coarse reason string. Conservative
// — anything we can't pattern-match falls into `"error"` so the cache
// layer disables PR fetch for the longer TTL.
function classifyExecError(e) {
  if (!e) return "error";
  if (e.code === "ENOENT") return "missing";
  if (e.signal === "SIGTERM") return "timeout";
  const msg = (e.stderr && e.stderr.toString && e.stderr.toString()) || e.message || "";
  if (/gh auth login|authentication|To get started with GitHub CLI/i.test(msg)) return "unauth";
  if (/command not found/i.test(msg)) return "missing";
  return "error";
}
