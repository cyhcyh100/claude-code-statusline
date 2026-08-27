import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanTranscript } from "../statusline/lib/transcript.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TODO = join(__dirname, "..", "test-fixtures", "transcript.jsonl");
const FIXTURE_THINKING = join(__dirname, "..", "test-fixtures", "transcript-thinking.jsonl");

test("scanTranscript returns empty result when path missing", () => {
  const r = scanTranscript("/no/such/file.jsonl");
  assert.equal(r.thinking.active, false);
  assert.equal(r.todos, null);
  assert.equal(r.lastSkill, null);
  assert.equal(r.bgRunning, 0);
});

test("scanTranscript picks up latest TodoWrite", () => {
  const r = scanTranscript(FIXTURE_TODO);
  assert.ok(Array.isArray(r.todos));
  assert.equal(r.todos.length, 3);
  assert.equal(r.todos[0].status, "in_progress");
});

test("scanTranscript captures lastSkill", () => {
  const r = scanTranscript(FIXTURE_TODO);
  assert.equal(r.lastSkill.name, "superpowers:brainstorming");
});

test("scanTranscript counts only background tasks without a matching tool_result", () => {
  // Fixture has b1 (no result) and b2 (with result) — expect 1 running.
  const r = scanTranscript(FIXTURE_TODO);
  assert.equal(r.bgRunning, 1);
});

test("scanTranscript marks thinking active when now is within recency window", () => {
  // Fixture thinking timestamp: 2025-01-01T00:00:30Z.
  // Choose now just 5s later — well inside the 30s recency window.
  const justAfter = Date.parse("2025-01-01T00:00:35Z");
  const r = scanTranscript(FIXTURE_THINKING, { now: justAfter });
  assert.equal(r.thinking.active, true);
});

test("scanTranscript marks thinking inactive once outside the recency window", () => {
  // 60s after the thinking block — outside the 30s window.
  const later = Date.parse("2025-01-01T00:01:30Z");
  const r = scanTranscript(FIXTURE_THINKING, { now: later });
  assert.equal(r.thinking.active, false);
});
