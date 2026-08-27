#!/usr/bin/env node
// Runtime wrapper for the statusline plugin. Resolves the latest plugin cache
// version and dynamically imports its index.mjs. Mirrors OMC HUD's wrapper
// pattern so plugin auto-updates flow through without re-patching settings.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Descending semver compare. Pure releases (1.0.1) outrank prereleases (1.0.1-rc.1).
// Exported for unit tests; bootstrap.mjs is also the runtime wrapper.
export function semverCompareDesc(a, b) {
  const pa = String(a).split(/[.-]/).map(p => { const n = Number(p); return Number.isFinite(n) ? n : p; });
  const pb = String(b).split(/[.-]/).map(p => { const n = Number(p); return Number.isFinite(n) ? n : p; });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (x === undefined) return typeof y === 'string' ? -1 : 1;
    if (y === undefined) return typeof x === 'string' ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(y).localeCompare(String(x), undefined, { numeric: true });
  }
  return 0;
}

async function main() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const cacheBase = join(claudeDir, "plugins", "cache", "claude-code-statusline", "statusline");
  if (!existsSync(cacheBase)) return;
  let versions;
  try { versions = readdirSync(cacheBase); } catch { return; }
  if (!versions.length) return;
  const sorted = [...versions].sort(semverCompareDesc);
  for (const v of sorted) {
    const indexPath = join(cacheBase, v, "statusline", "index.mjs");
    if (!existsSync(indexPath)) continue;
    try { await import(pathToFileURL(indexPath).href); return; } catch { /* try next version */ }
  }
}
// Only run when invoked as the entry script — keeps unit tests that
// `import { semverCompareDesc }` from this file side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    if (process.env.STATUSLINE_DEBUG) console.error('[statusline-bootstrap]', err);
  });
}
