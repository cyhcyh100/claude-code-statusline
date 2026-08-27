import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsage } from "../statusline/lib/usage-api.mjs";

test("parseUsage extracts five_hour and seven_day", () => {
  const out = parseUsage({
    five_hour: { utilization: 42, resets_at: "2026-05-11T08:00:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-05-16T00:00:00Z" },
  });
  assert.deepEqual(out, {
    fiveHourPercent: 42,
    fiveHourResetsAt: "2026-05-11T08:00:00Z",
    weeklyPercent: 18,
    weeklyResetsAt: "2026-05-16T00:00:00Z",
  });
});

test("parseUsage returns null when both buckets absent", () => {
  assert.equal(parseUsage({}), null);
});

test("parseUsage clamps utilization to [0,100]", () => {
  const out = parseUsage({
    five_hour: { utilization: 150, resets_at: null },
    seven_day: { utilization: -10, resets_at: null },
  });
  assert.equal(out.fiveHourPercent, 100);
  assert.equal(out.weeklyPercent, 0);
});

test("parseUsage tolerates a missing bucket", () => {
  const out = parseUsage({ five_hour: { utilization: 30, resets_at: null } });
  assert.equal(out.fiveHourPercent, 30);
  assert.equal(out.weeklyPercent, null);
  assert.equal(out.weeklyResetsAt, null);
});
