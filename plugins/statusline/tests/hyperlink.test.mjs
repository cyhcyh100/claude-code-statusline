import { test } from "node:test";
import assert from "node:assert/strict";
import { osc8 } from "../statusline/lib/hyperlink.mjs";

test("osc8 wraps text in an OSC 8 sequence", () => {
  const out = osc8("https://example.com", "click");
  assert.ok(out.startsWith("\x1b]8;;https://example.com\x1b\\"));
  assert.ok(out.includes("click"));
  assert.ok(out.endsWith("\x1b]8;;\x1b\\"));
});

test("osc8 returns plain text when URL missing", () => {
  assert.equal(osc8("", "fallback"), "fallback");
  assert.equal(osc8(null, "fallback"), "fallback");
  assert.equal(osc8(undefined, "fallback"), "fallback");
});

test("osc8 strips control characters from URL", () => {
  // ESC + BEL inside the URL would otherwise close the OSC sequence early
  // and allow injection of arbitrary terminal escapes. Stripping them
  // should yield the same wrapper as the clean URL.
  const dirty = osc8("https://example.com\x1b\x07", "text");
  const clean = osc8("https://example.com", "text");
  assert.equal(dirty, clean);
});

test("osc8 breaks OSC injection attempts mid-URL", () => {
  // Even with leftover ASCII after sanitization, the dangerous ESC and BEL
  // are gone so no nested OSC sequence can start.
  const out = osc8("https://example.com\x1b]2;evil\x07", "text");
  assert.ok(!out.includes("\x1b]2;"));
  assert.ok(!out.includes("\x07"));
});

test("osc8 falls back when sanitization empties the URL", () => {
  assert.equal(osc8("\x00\x1b\x07", "text"), "text");
});
