// OSC 8 terminal hyperlink. Falls back to plain text if URL invalid.
// Strips control characters so a malformed URL can't smuggle in extra
// terminal escape sequences (defense in depth — the source is `gh pr view`).
export function osc8(url, text) {
  if (!url || typeof url !== "string") return text;
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, "");
  if (!safeUrl) return text;
  return `\x1b]8;;${safeUrl}\x1b\\${text}\x1b]8;;\x1b\\`;
}
