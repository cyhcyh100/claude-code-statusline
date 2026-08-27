import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cacheDir() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const dir = join(claudeDir, "claude-code-statusline", "cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch { return null; }
}

// options: { mode?: number, indent?: number }
export function writeJsonAtomic(path, obj, options = {}) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    try {
      const json = options.indent ? JSON.stringify(obj, null, options.indent) : JSON.stringify(obj);
      const writeOpts = options.mode != null ? { mode: options.mode } : undefined;
      writeFileSync(tmp, json, writeOpts);
      renameSync(tmp, path);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  } catch { /* swallow — cache writes are best-effort */ }
}

// Returns true if `cached.timestamp` is older than `ttlMs` from now.
export function isExpired(cached, ttlMs) {
  if (!cached || typeof cached.timestamp !== "number") return true;
  return Date.now() - cached.timestamp > ttlMs;
}
