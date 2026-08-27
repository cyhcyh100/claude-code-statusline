import { test } from "node:test";
import assert from "node:assert/strict";
import { semverCompareDesc } from "../scripts/bootstrap.mjs";

test("higher patch sorts first", () => {
  const sorted = ["1.0.0", "1.0.3", "1.0.1"].sort(semverCompareDesc);
  assert.deepEqual(sorted, ["1.0.3", "1.0.1", "1.0.0"]);
});

test("higher minor outranks patch", () => {
  const sorted = ["1.0.9", "1.1.0", "1.0.5"].sort(semverCompareDesc);
  assert.deepEqual(sorted, ["1.1.0", "1.0.9", "1.0.5"]);
});

test("pure release ranks above prerelease of same version", () => {
  const sorted = ["1.0.0-rc.1", "1.0.0", "1.0.0-beta.2"].sort(semverCompareDesc);
  assert.equal(sorted[0], "1.0.0");
});

test("non-semver directory names sort after releases", () => {
  const sorted = ["1.0.0", ".DS_Store", "1.0.1"].sort(semverCompareDesc);
  assert.equal(sorted[0], "1.0.1");
  assert.equal(sorted[1], "1.0.0");
});

test("equal versions return 0", () => {
  assert.equal(semverCompareDesc("1.2.3", "1.2.3"), 0);
});
