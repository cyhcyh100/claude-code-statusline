// Unit tests for plugins/statusline/statusline/lib/gh-prs.mjs.
// Real `gh` is never invoked here — `runGhPrs` accepts an injectable
// `exec` so we can drive every reason-mapping branch deterministically.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  escapeGraphqlString,
  buildPrsQuery,
  parsePrsResponse,
  prToBadge,
  runGhPrs,
} from "../statusline/lib/gh-prs.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");

// ----- escapeGraphqlString -----

test("escapeGraphqlString: backslash and double-quote escaped", () => {
  assert.equal(escapeGraphqlString('a"b'), 'a\\"b');
  assert.equal(escapeGraphqlString("a\\b"), "a\\\\b");
  assert.equal(escapeGraphqlString('mix"\\of'), 'mix\\"\\\\of');
});

test("escapeGraphqlString: plain identifiers pass through unchanged", () => {
  assert.equal(escapeGraphqlString("main"), "main");
  assert.equal(escapeGraphqlString("feat/branch-with-dashes"), "feat/branch-with-dashes");
  assert.equal(escapeGraphqlString("octocat"), "octocat");
});

test("escapeGraphqlString: coerces non-strings", () => {
  assert.equal(escapeGraphqlString(42), "42");
});

test("escapeGraphqlString: line terminators / tabs use named escapes", () => {
  assert.equal(escapeGraphqlString("a\nb"), "a\\nb");
  assert.equal(escapeGraphqlString("a\rb"), "a\\rb");
  assert.equal(escapeGraphqlString("a\tb"), "a\\tb");
  assert.equal(escapeGraphqlString("a\bb"), "a\\bb");
  assert.equal(escapeGraphqlString("a\fb"), "a\\fb");
});

test("escapeGraphqlString: other control chars become \\uXXXX", () => {
  // The clone-poisoning vector — ESC and friends — must not survive
  // into the GraphQL query as raw bytes.
  assert.equal(escapeGraphqlString("\x00"), "\\u0000");
  assert.equal(escapeGraphqlString("\x01"), "\\u0001");
  assert.equal(escapeGraphqlString("\x1b"), "\\u001b");
  assert.equal(escapeGraphqlString("\x7f"), "\\u007f");
  assert.equal(escapeGraphqlString("ref\x1b[31m"), "ref\\u001b[31m");
});

// ----- buildPrsQuery -----

test("buildPrsQuery: empty input returns null", () => {
  assert.equal(buildPrsQuery([]), null);
  assert.equal(buildPrsQuery(null), null);
  assert.equal(buildPrsQuery(undefined), null);
});

test("buildPrsQuery: emits sequential aliases r0, r1, ...", () => {
  const q = buildPrsQuery([
    { slug: "owner/repo1", branch: "main" },
    { slug: "owner/repo2", branch: "fix-bug" },
  ]);
  assert.match(q, /r0: repository\(owner: "owner", name: "repo1"\)/);
  assert.match(q, /r1: repository\(owner: "owner", name: "repo2"\)/);
  assert.match(q, /headRefName: "main"/);
  assert.match(q, /headRefName: "fix-bug"/);
});

test("buildPrsQuery: branch names with quotes are escaped", () => {
  const q = buildPrsQuery([{ slug: "o/r", branch: 'a"b' }]);
  assert.match(q, /headRefName: "a\\"b"/);
});

test("buildPrsQuery: requests the documented fields", () => {
  const q = buildPrsQuery([{ slug: "o/r", branch: "main" }]);
  for (const field of ["number", "url", "state", "isDraft", "mergedAt", "updatedAt", "headRefName"]) {
    assert.match(q, new RegExp(`\\b${field}\\b`), `query must select ${field}`);
  }
});

// ----- prToBadge -----

test("prToBadge: OPEN + !isDraft → kind=open", () => {
  assert.deepEqual(
    prToBadge({ state: "OPEN", isDraft: false, number: 42, url: "u" }),
    { kind: "open", number: 42, url: "u" }
  );
});

test("prToBadge: OPEN + isDraft → kind=draft", () => {
  assert.equal(prToBadge({ state: "OPEN", isDraft: true, number: 17, url: "u" }).kind, "draft");
});

test("prToBadge: MERGED → kind=merged", () => {
  assert.equal(prToBadge({ state: "MERGED", isDraft: false, number: 5, url: "u" }).kind, "merged");
});

test("prToBadge: CLOSED → kind=closed", () => {
  assert.equal(prToBadge({ state: "CLOSED", isDraft: false, number: 99, url: "u" }).kind, "closed");
});

test("prToBadge: null / unknown state → null", () => {
  assert.equal(prToBadge(null), null);
  assert.equal(prToBadge({ state: "DRAFT" /* not a real state */, number: 1 }), null);
});

// ----- parsePrsResponse -----

const readFixture = (name) =>
  readFileSync(join(FIXTURES, name), "utf-8");

test("parsePrsResponse: mixed fixture yields one PR per alias", () => {
  const entries = [
    { slug: "example/alpha", branch: "main" },
    { slug: "example/beta", branch: "fix-bug" },
    { slug: "example/gamma", branch: "feature" },
    { slug: "example/shared", branch: "rename-foo" },
  ];
  const res = parsePrsResponse(readFixture("gh-prs-mixed.json"), entries);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 4);
  assert.equal(prToBadge(res.results[0].pr).kind, "open");
  assert.equal(prToBadge(res.results[1].pr).kind, "draft");
  assert.equal(prToBadge(res.results[2].pr).kind, "merged");
  assert.equal(prToBadge(res.results[3].pr).kind, "closed");
  // Slug/branch round-trip
  assert.equal(res.results[0].slug, "example/alpha");
  assert.equal(res.results[0].branch, "main");
});

test("parsePrsResponse: empty fixture yields pr:null for every entry", () => {
  const entries = [
    { slug: "o/a", branch: "main" },
    { slug: "o/b", branch: "main" },
  ];
  const res = parsePrsResponse(readFixture("gh-prs-empty.json"), entries);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].pr, null);
  assert.equal(res.results[1].pr, null);
});

test("parsePrsResponse: real-sample fixture from Pre-flight parses", () => {
  // Three aliases — two with one MERGED PR each, one empty. Mirrors
  // the recorded response from the Pre-flight probe.
  const entries = [
    { slug: "octocat/hello-world", branch: "add-verify-and-ci" },
    { slug: "octocat/hello-world", branch: "statusline-plugin-v1" },
    { slug: "octocat/hello-world", branch: "main" },
  ];
  const res = parsePrsResponse(readFixture("gh-prs-sample.json"), entries);
  assert.equal(res.ok, true);
  assert.equal(prToBadge(res.results[0].pr).kind, "merged");
  assert.equal(prToBadge(res.results[1].pr).kind, "merged");
  assert.equal(res.results[2].pr, null);
});

test("parsePrsResponse: response with errors array is rejected", () => {
  const body = JSON.stringify({
    data: null,
    errors: [{ message: "Could not resolve to a Repository" }],
  });
  const res = parsePrsResponse(body, [{ slug: "o/missing", branch: "main" }]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "errors");
});

test("parsePrsResponse: malformed JSON returns ok:false", () => {
  const res = parsePrsResponse("not-json-at-all", [{ slug: "o/r", branch: "main" }]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "malformed");
});

test("parsePrsResponse: missing alias yields pr:null without throwing", () => {
  const body = JSON.stringify({ data: { r0: { pullRequests: { nodes: [] } } } });
  const res = parsePrsResponse(body, [
    { slug: "o/a", branch: "main" },
    { slug: "o/b", branch: "main" },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].pr, null);
  assert.equal(res.results[1].pr, null);
});

// ----- runGhPrs (injected exec) -----

test("runGhPrs: empty entries returns reason=empty without invoking exec", async () => {
  let called = false;
  const exec = async () => { called = true; return { stdout: "{}" }; };
  const res = await runGhPrs([], { exec });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "empty");
  assert.equal(called, false);
});

test("runGhPrs: success path returns parsed results", async () => {
  const entries = [{ slug: "example/alpha", branch: "main" }];
  const exec = async (file, args /* , opts */) => {
    assert.equal(file, "gh");
    assert.equal(args[0], "api");
    assert.equal(args[1], "graphql");
    assert.equal(args[2], "-f");
    assert.match(args[3], /^query=/);
    return {
      stdout: JSON.stringify({
        data: {
          r0: {
            pullRequests: {
              nodes: [{
                number: 1, url: "u", state: "OPEN", isDraft: false,
                mergedAt: null, updatedAt: "2026-01-01T00:00:00Z", headRefName: "main",
              }],
            },
          },
        },
      }),
    };
  };
  const res = await runGhPrs(entries, { exec });
  assert.equal(res.ok, true);
  assert.equal(prToBadge(res.results[0].pr).kind, "open");
});

test("runGhPrs: ENOENT → reason=missing", async () => {
  const exec = async () => {
    const e = new Error("spawn gh ENOENT");
    e.code = "ENOENT";
    throw e;
  };
  const res = await runGhPrs([{ slug: "o/r", branch: "main" }], { exec });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing");
});

test("runGhPrs: SIGTERM → reason=timeout", async () => {
  const exec = async () => {
    const e = new Error("timed out");
    e.signal = "SIGTERM";
    throw e;
  };
  const res = await runGhPrs([{ slug: "o/r", branch: "main" }], { exec });
  assert.equal(res.reason, "timeout");
});

test("runGhPrs: auth message in stderr → reason=unauth", async () => {
  const exec = async () => {
    const e = new Error("exit 4");
    e.stderr = "To get started with GitHub CLI, please run: gh auth login";
    throw e;
  };
  const res = await runGhPrs([{ slug: "o/r", branch: "main" }], { exec });
  assert.equal(res.reason, "unauth");
});

test("runGhPrs: unknown error → reason=error", async () => {
  const exec = async () => { throw new Error("kaboom"); };
  const res = await runGhPrs([{ slug: "o/r", branch: "main" }], { exec });
  assert.equal(res.reason, "error");
});

test("runGhPrs: GraphQL errors body → reason=errors", async () => {
  const exec = async () => ({
    stdout: JSON.stringify({ data: null, errors: [{ message: "bad" }] }),
  });
  const res = await runGhPrs([{ slug: "o/r", branch: "main" }], { exec });
  assert.equal(res.reason, "errors");
});
