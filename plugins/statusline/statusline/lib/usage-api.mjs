import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { cacheDir, readJson, writeJsonAtomic, isExpired } from "./cache.mjs";

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_TTL_MS = 90_000;
const FAIL_TTL_MS = 15_000;
const NETWORK_FAIL_TTL_MS = 2 * 60_000;
const HTTP_TIMEOUT_MS = 5_000;

function keychainServiceName() {
  const cd = process.env.CLAUDE_CONFIG_DIR;
  if (!cd) return "Claude Code-credentials";
  const hash = createHash("sha256").update(cd).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function readKeychainCreds() {
  if (process.platform !== "darwin") return null;
  const service = keychainServiceName();
  const username = (() => { try { return userInfo().username; } catch { return null; } })();
  const accounts = [username, undefined].filter((v, i, a) => a.indexOf(v) === i);
  for (const acct of accounts) {
    try {
      const args = ["find-generic-password", "-s", service];
      if (acct) args.push("-a", acct);
      args.push("-w");
      const out = execFileSync("/usr/bin/security", args, {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!out) continue;
      const parsed = JSON.parse(out);
      const creds = parsed.claudeAiOauth || parsed;
      if (creds.accessToken) return { ...creds, source: "keychain" };
    } catch { /* try next account */ }
  }
  return null;
}

function readFileCreds() {
  try {
    const path = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const creds = parsed.claudeAiOauth || parsed;
    if (creds.accessToken) return { ...creds, source: "file" };
  } catch { /* ignore */ }
  return null;
}

function getCredentials() {
  return readKeychainCreds() || readFileCreds();
}

function isExpiredCreds(creds) {
  return creds.expiresAt != null && creds.expiresAt <= Date.now();
}

function writeBackFileCreds(creds) {
  try {
    const path = join(homedir(), ".claude", ".credentials.json");
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const target = parsed.claudeAiOauth || parsed;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    writeJsonAtomic(path, parsed, { mode: 0o600, indent: 2 });
  } catch { /* best effort */ }
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();
    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const p = JSON.parse(data);
          if (!p.access_token) return resolve(null);
          resolve({
            accessToken: p.access_token,
            refreshToken: p.refresh_token || refreshToken,
            expiresAt: p.expires_in ? Date.now() + p.expires_in * 1000 : p.expires_at,
          });
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

function fetchUsageHttp(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve({ ok: true, data: JSON.parse(data) }); } catch { resolve({ ok: false }); }
        } else {
          resolve({ ok: false, status: res.statusCode });
        }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, timeout: true }); });
    req.end();
  });
}

function clamp(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function parseUsage(api) {
  const fh = api.five_hour;
  const sd = api.seven_day;
  if (fh == null && sd == null) return null;
  return {
    fiveHourPercent: fh ? clamp(fh.utilization) : null,
    fiveHourResetsAt: fh && fh.resets_at ? fh.resets_at : null,
    weeklyPercent: sd ? clamp(sd.utilization) : null,
    weeklyResetsAt: sd && sd.resets_at ? sd.resets_at : null,
  };
}

const usageCachePath = () => join(cacheDir(), "usage.json");

export async function getUsage() {
  const path = usageCachePath();
  const cached = readJson(path);
  if (cached && !isExpired(cached, cached.error ? (cached.network ? NETWORK_FAIL_TTL_MS : FAIL_TTL_MS) : USAGE_TTL_MS)) {
    if (cached.error) return null;
    return cached.data;
  }
  let creds = getCredentials();
  if (!creds) {
    writeJsonAtomic(path, { timestamp: Date.now(), error: true, network: false });
    return null;
  }
  if (isExpiredCreds(creds) && creds.refreshToken) {
    const refreshed = await refreshAccessToken(creds.refreshToken);
    if (!refreshed) {
      writeJsonAtomic(path, { timestamp: Date.now(), error: true, network: false });
      return null;
    }
    creds = { ...creds, ...refreshed };
    if (creds.source === "file") writeBackFileCreds(creds);
  }
  const result = await fetchUsageHttp(creds.accessToken);
  if (!result.ok) {
    writeJsonAtomic(path, { timestamp: Date.now(), error: true, network: true });
    if (cached && cached.data) return cached.data;
    return null;
  }
  const data = parseUsage(result.data || {});
  if (!data) {
    writeJsonAtomic(path, { timestamp: Date.now(), error: true, network: true });
    return null;
  }
  writeJsonAtomic(path, { timestamp: Date.now(), data });
  return data;
}
