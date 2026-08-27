import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleLength, truncateLine, effectiveTermWidth } from "../statusline/lib/layout.mjs";

// Capture / restore env vars so tests can't bleed into each other or
// into the surrounding `verify.sh` smoke runs.
function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("visibleLength counts only printable characters", () => {
  assert.equal(visibleLength("hello"), 5);
  assert.equal(visibleLength("\x1b[31mhello\x1b[0m"), 5);
});

test("visibleLength ignores OSC 8 hyperlink wrapper", () => {
  const link = "\x1b]8;;https://example.com\x1b\\foo\x1b]8;;\x1b\\";
  assert.equal(visibleLength(link), 3);
});

test("truncateLine short-circuits when under max", () => {
  assert.equal(truncateLine("hello", 10), "hello");
});

test("truncateLine truncates and appends ellipsis at the visible boundary", () => {
  const out = truncateLine("abcdefghij", 5);
  assert.equal(out, "abcd…\x1b[0m");
  assert.equal(visibleLength(out), 5);
});

test("truncateLine preserves ANSI codes inside the kept prefix", () => {
  const out = truncateLine("\x1b[31mabcdefghij\x1b[0m", 5);
  assert.equal(out, "\x1b[31mabcd…\x1b[0m");
  assert.equal(visibleLength(out), 5);
});

// ----- effectiveTermWidth -----

test("effectiveTermWidth: STATUSLINE_WIDTH wins over COLUMNS", () => {
  withEnv({ STATUSLINE_WIDTH: "120", COLUMNS: "200" }, () => {
    assert.equal(effectiveTermWidth(), 120);
  });
});

test("effectiveTermWidth: falls back to COLUMNS when STATUSLINE_WIDTH unset", () => {
  withEnv({ STATUSLINE_WIDTH: undefined, COLUMNS: "100" }, () => {
    assert.equal(effectiveTermWidth(), 100);
  });
});

test("effectiveTermWidth: defaults to 80 when neither is set", () => {
  withEnv({ STATUSLINE_WIDTH: undefined, COLUMNS: undefined }, () => {
    assert.equal(effectiveTermWidth(), 80);
  });
});

test("effectiveTermWidth: tiny values (≤ 20) are ignored, fallback continues", () => {
  // STATUSLINE_WIDTH=10 is too small → falls through to COLUMNS.
  withEnv({ STATUSLINE_WIDTH: "10", COLUMNS: "120" }, () => {
    assert.equal(effectiveTermWidth(), 120);
  });
  // Both too small → default 80.
  withEnv({ STATUSLINE_WIDTH: "5", COLUMNS: "0" }, () => {
    assert.equal(effectiveTermWidth(), 80);
  });
});

test("effectiveTermWidth: non-numeric values are ignored", () => {
  withEnv({ STATUSLINE_WIDTH: "wide", COLUMNS: "80" }, () => {
    assert.equal(effectiveTermWidth(), 80);
  });
  withEnv({ STATUSLINE_WIDTH: "", COLUMNS: "" }, () => {
    assert.equal(effectiveTermWidth(), 80);
  });
});
