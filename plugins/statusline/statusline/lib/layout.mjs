const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function visibleLength(s) {
  return s.replace(ANSI_RE, "").length;
}

// Truncate by visible columns, preserving ANSI codes. Adds "…" when truncated.
export function truncateLine(line, max) {
  if (max <= 0) return "";
  if (visibleLength(line) <= max) return line;
  const ELLIPSIS = "…";
  const target = Math.max(0, max - 1);
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < line.length && visible < target) {
    if (line[i] === "\x1b") {
      const m = line.slice(i).match(/^(\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += line[i]; visible++; i++;
  }
  return out + ELLIPSIS + "\x1b[0m";
}

// Raised from 5 → 8 so multi-repo mode can wrap many child tokens
// across several sub-lines and still leave room for the model line +
// optional context warning. Single-repo / no-repo paths emit 1-2 line-1
// strings, so the cap remains effectively unchanged for them.
const MAX_LINES = 8;

// Effective rendering width for the statusline.
//
// Claude Code's statusline subprocess runs with no TTY (stdout is
// piped, no /dev/tty access) and Claude Code does not currently
// publish a width in stdin or environment. So we fall back to 80
// chars — the POSIX-default terminal width and the safest narrow
// assumption. Users with wider statusline panes can set:
//   STATUSLINE_WIDTH=120   (preferred)
//   COLUMNS=120            (also honored)
// in their shell rc.
export function effectiveTermWidth() {
  for (const src of [process.env.STATUSLINE_WIDTH, process.env.COLUMNS]) {
    const n = parseInt(src || "", 10);
    if (Number.isFinite(n) && n > 20) return n;
  }
  return 80;
}

export function compose(lines) {
  const w = effectiveTermWidth();
  return lines
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map(l => truncateLine(l, w))
    .join("\n");
}
