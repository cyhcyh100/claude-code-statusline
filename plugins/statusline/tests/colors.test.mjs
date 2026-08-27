import { test } from "node:test";
import assert from "node:assert/strict";
import { pctColor, red, yellow, green, boldRed, boldYellow } from "../statusline/lib/colors.mjs";

test("pctColor: <70 → green", () => {
  assert.equal(pctColor(0), green);
  assert.equal(pctColor(69), green);
});

test("pctColor: 70–84 → yellow", () => {
  assert.equal(pctColor(70), yellow);
  assert.equal(pctColor(84), yellow);
});

test("pctColor: >=85 → red", () => {
  assert.equal(pctColor(85), red);
  assert.equal(pctColor(100), red);
});

test("boldRed emits a single combined SGR sequence", () => {
  assert.equal(boldRed("x"), "\x1b[1;31mx\x1b[0m");
});

test("boldYellow emits a single combined SGR sequence", () => {
  assert.equal(boldYellow("x"), "\x1b[1;33mx\x1b[0m");
});
