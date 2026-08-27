import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cacheDir, readJson, writeJsonAtomic, isExpired } from "./cache.mjs";

export function gitBranch(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch { return null; }
}

const TTL_OK_MS = 60_000;
const TTL_EMPTY_MS = 60_000;
const TTL_DISABLED_MS = 5 * 60_000;

function prCachePath(branch) {
  const hash = createHash("sha256").update(branch).digest("hex").slice(0, 8);
  return join(cacheDir(), `pr-${hash}.json`);
}

export function getPR(branch, cwd) {
  if (!branch) return null;
  const path = prCachePath(branch);
  const cached = readJson(path);
  if (cached) {
    const ttl = cached.disabled ? TTL_DISABLED_MS : (cached.empty ? TTL_EMPTY_MS : TTL_OK_MS);
    if (!isExpired(cached, ttl)) {
      if (cached.disabled || cached.empty) return null;
      return cached;
    }
  }
  // Cache miss / stale → re-query.
  let result;
  try {
    const out = execFileSync("gh", ["pr", "view", "--json", "number,url,state"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1500,
    });
    const data = JSON.parse(out);
    result = { timestamp: Date.now(), number: data.number, url: data.url, state: data.state };
  } catch (e) {
    const msg = (e && e.stderr && e.stderr.toString()) || (e && e.message) || "";
    if (/no pull requests found/i.test(msg)) {
      result = { timestamp: Date.now(), empty: true };
    } else {
      result = { timestamp: Date.now(), disabled: true };
    }
  }
  writeJsonAtomic(path, result);
  if (result.empty || result.disabled) return null;
  return result;
}
