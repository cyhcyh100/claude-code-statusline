// ANSI color helpers. All take a string, return wrapped string.
const E = "\x1b[";
const RESET = `${E}0m`;
const wrap = (code) => (s) => `${E}${code}m${s}${RESET}`;

export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);
export const gray = wrap(90);
export const bold = wrap(1);
export const dim = wrap(2);
export const underline = wrap(4);
// Compound styles — single SGR sequence avoids nested-reset issues when
// bold + color are combined.
export const boldRed = wrap("1;31");
export const boldYellow = wrap("1;33");

// Pick color by usage % using project-wide thresholds.
export function pctColor(pct) {
  if (pct >= 85) return red;
  if (pct >= 70) return yellow;
  return green;
}
