// Pure presentation helpers. Kept separate from usage-api.mjs so callers
// that only need formatting don't pull in OAuth / HTTP / Keychain code.

// Formats milliseconds-until-reset for the usage segments.
// mode "5h" → "Hh Mm" (or "Mm" under an hour).
// mode "wk" → "Dd Hh" (or "Hh" under a day).
export function formatResetUntil(iso, mode, now = Date.now()) {
  if (!iso) return "";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "";
  const ms = Math.max(0, target - now);
  if (mode === "5h") {
    const totalMin = Math.floor(ms / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h === 0 ? `${m}m` : `${h}h${m}m`;
  }
  const totalH = Math.floor(ms / 3_600_000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return d === 0 ? `${h}h` : `${d}d${h}h`;
}
