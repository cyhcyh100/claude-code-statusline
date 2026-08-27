import { homedir } from "node:os";

export function parseStdin(raw) {
  let json = {};
  try { json = JSON.parse(raw); } catch { /* tolerate */ }
  return json;
}

export function homeRelativize(cwd) {
  if (!cwd) return "?";
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export function modelDisplay(modelObj) {
  if (!modelObj) return "?";
  return modelObj.display_name || modelObj.id || "?";
}

// Returns 0-100 (rounded) or null if not derivable.
export function contextPercent(ctx) {
  if (!ctx) return null;
  if (typeof ctx.used_percentage === "number") return Math.round(ctx.used_percentage);
  const size = ctx.context_window_size;
  const u = ctx.current_usage;
  if (!size || !u) return null;
  const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return Math.round((total / size) * 100);
}
