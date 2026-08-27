import { test } from "node:test";
import assert from "node:assert/strict";
import { contextPercent, modelDisplay, homeRelativize, parseStdin } from "../statusline/lib/stdin-info.mjs";

test("contextPercent uses used_percentage when present", () => {
  assert.equal(contextPercent({ used_percentage: 47 }), 47);
});

test("contextPercent rounds to integer", () => {
  assert.equal(contextPercent({ used_percentage: 47.6 }), 48);
});

test("contextPercent falls back to size + current_usage tokens", () => {
  const ctx = {
    context_window_size: 200000,
    current_usage: { input_tokens: 50000, cache_read_input_tokens: 30000, cache_creation_input_tokens: 20000 },
  };
  assert.equal(contextPercent(ctx), 50);
});

test("contextPercent returns null when no signals", () => {
  assert.equal(contextPercent(null), null);
  assert.equal(contextPercent({}), null);
  assert.equal(contextPercent({ context_window_size: 100 }), null);
});

test("modelDisplay prefers display_name", () => {
  assert.equal(modelDisplay({ id: "claude-opus-4-7", display_name: "Opus 4.7" }), "Opus 4.7");
});

test("modelDisplay falls back to id then '?'", () => {
  assert.equal(modelDisplay({ id: "claude-opus-4-7" }), "claude-opus-4-7");
  assert.equal(modelDisplay({}), "?");
  assert.equal(modelDisplay(null), "?");
});

test("homeRelativize collapses home prefix", () => {
  const home = process.env.HOME || "/Users/test";
  assert.equal(homeRelativize(home), "~");
  assert.equal(homeRelativize(`${home}/project`), "~/project");
  assert.equal(homeRelativize("/tmp/other"), "/tmp/other");
});

test("parseStdin tolerates malformed JSON", () => {
  assert.deepEqual(parseStdin("not-json"), {});
  assert.deepEqual(parseStdin(""), {});
});
