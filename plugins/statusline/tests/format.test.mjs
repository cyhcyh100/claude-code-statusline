import { test } from "node:test";
import assert from "node:assert/strict";
import { formatResetUntil } from "../statusline/lib/format.mjs";

const NOW = Date.parse("2025-01-01T00:00:00Z");

test("formatResetUntil 5h: minutes only", () => {
  const target = new Date(NOW + 12 * 60_000).toISOString();
  assert.equal(formatResetUntil(target, "5h", NOW), "12m");
});

test("formatResetUntil 5h: hours + minutes", () => {
  const target = new Date(NOW + (3 * 60 + 7) * 60_000).toISOString();
  assert.equal(formatResetUntil(target, "5h", NOW), "3h7m");
});

test("formatResetUntil wk: hours only", () => {
  const target = new Date(NOW + 5 * 3_600_000).toISOString();
  assert.equal(formatResetUntil(target, "wk", NOW), "5h");
});

test("formatResetUntil wk: days + hours", () => {
  const target = new Date(NOW + (2 * 24 + 11) * 3_600_000).toISOString();
  assert.equal(formatResetUntil(target, "wk", NOW), "2d11h");
});

test("formatResetUntil empty/invalid → empty string", () => {
  assert.equal(formatResetUntil("", "5h", NOW), "");
  assert.equal(formatResetUntil(null, "5h", NOW), "");
  assert.equal(formatResetUntil("not-a-date", "5h", NOW), "");
});

test("formatResetUntil clamps negative deltas to 0", () => {
  const past = new Date(NOW - 60_000).toISOString();
  assert.equal(formatResetUntil(past, "5h", NOW), "0m");
});
