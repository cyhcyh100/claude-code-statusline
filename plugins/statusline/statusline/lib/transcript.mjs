import { existsSync, openSync, fstatSync, readSync, closeSync } from "node:fs";

const TAIL_BYTES = 64 * 1024;
const THINKING_RECENCY_MS = 30_000;

// Read last `bytes` of file as utf-8 string. Empty string on any error.
function tailRead(path, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - bytes);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8");
  } catch { return ""; }
  finally { if (fd != null) try { closeSync(fd); } catch { /* ignore */ } }
}

function parseTimestamp(t) {
  if (!t) return null;
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

// Walk message.content[] arrays returning all blocks.
function* iterContent(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  const msg = obj.message;
  const content = msg && msg.content;
  if (Array.isArray(content)) {
    for (const block of content) yield { obj, block, ts: parseTimestamp(obj.timestamp) };
  }
}

// Returns: { thinking:{active:boolean, lastSeen?:number}, todos:[{content,status,activeForm}]|null,
//            lastSkill:{name,args?}|null, bgRunning:number }
// `now` is injectable for deterministic tests of the thinking-recency window.
export function scanTranscript(path, { now = Date.now() } = {}) {
  const empty = { thinking: { active: false }, todos: null, lastSkill: null, bgRunning: 0 };
  if (!path || !existsSync(path)) return empty;
  const tail = tailRead(path, TAIL_BYTES);
  if (!tail) return empty;
  const lines = tail.split("\n").filter(Boolean);

  let lastThinkingTs = null;
  let lastTodos = null;
  let lastSkill = null;
  const bgUseIds = new Set();
  const seenResultIds = new Set();

  for (const line of lines) {
    for (const { block, ts } of iterContent(line)) {
      if (block.type === "thinking" || block.type === "reasoning") {
        if (ts != null) lastThinkingTs = lastThinkingTs == null ? ts : Math.max(lastThinkingTs, ts);
      } else if (block.type === "tool_use") {
        const name = block.name;
        const input = block.input || {};
        if (name === "TodoWrite" && Array.isArray(input.todos)) {
          lastTodos = input.todos;
        } else if (name === "Skill" || /Skill$/.test(name || "")) {
          lastSkill = { name: input.skill || input.name || "?" };
        } else if (name === "Bash" && input.run_in_background === true && block.id) {
          bgUseIds.add(block.id);
        }
      } else if (block.type === "tool_result" && block.tool_use_id) {
        seenResultIds.add(block.tool_use_id);
      }
    }
  }

  let bgRunning = 0;
  for (const id of bgUseIds) if (!seenResultIds.has(id)) bgRunning++;

  const thinkingActive = lastThinkingTs != null && (now - lastThinkingTs) <= THINKING_RECENCY_MS;
  return {
    thinking: { active: thinkingActive, lastSeen: lastThinkingTs ?? undefined },
    todos: lastTodos,
    lastSkill,
    bgRunning,
  };
}
