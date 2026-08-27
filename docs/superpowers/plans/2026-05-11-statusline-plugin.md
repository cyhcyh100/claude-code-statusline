# Statusline Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship a private Claude Code statusline plugin (per `docs/superpowers/specs/2026-05-11-statusline-plugin-design.md`) that auto-updates from the team's GitHub marketplace.

**Architecture:** This repo doubles as a Claude Code plugin marketplace. The single `statusline` plugin contains a Node.js statusline script that reads `cwd`, `model`, `context_window` from stdin; runs `git`/`gh` for branch+PR; calls Anthropic's OAuth usage API for 5h/weekly quota; tail-scans the transcript JSONL for thinking/todos/skills/background tasks. Renders a 4-line (+ optional warning) statusline with ANSI colors and OSC 8 hyperlinks.

**Tech Stack:** Node.js (ESM), POSIX shell shim (`find-node.sh`), `git` + `gh` CLIs, macOS Keychain (`security`), HTTPS to `api.anthropic.com` and `platform.claude.com`.

**Test strategy:** Each task ends with a **manual verification step** that runs the script against fixture stdin and visually checks the rendered output. Fixtures live under `plugins/statusline/test-fixtures/`. Pure functions with combinatoric edge cases (semver compare, transcript scan, layout/truncation, format, parse) have node:test unit tests under `plugins/statusline/tests/` — run with `node --test 'plugins/statusline/tests/*.test.mjs'`.

---

## Pre-flight: Plugin manifest verification (RESOLVED 2026-05-11)

**Findings recorded in spec §3 + §14. Summary:**

- `plugin.json` does NOT support a `statusLine` field. Plugin `settings.json` only supports `agent` and `subagentStatusLine`.
- Plugin manifest must live at `<plugin>/.claude-plugin/plugin.json` (NOT plugin root).
- Marketplace manifest schema confirmed: required `name` (kebab-case), `owner.name`, `plugins[]`. Each plugin needs `name` + `source` (relative path or github/url/git-subdir/npm).
- `${CLAUDE_PLUGIN_ROOT}` env var works in hooks/MCP commands and points to the plugin's installed cache directory.

**Decision: SessionStart-hook-based installer.** Plugin ships:

- `hooks/hooks.json` — `SessionStart` event runs `scripts/install.mjs`
- `scripts/install.mjs` — idempotent: copies `bootstrap.mjs` to `~/.claude/claude-code-statusline/bootstrap.mjs` and patches `~/.claude/settings.json` `statusLine.command` once per version
- `scripts/bootstrap.mjs` — version-discovery wrapper: scans `~/.claude/plugins/cache/claude-code-statusline/statusline/<version>/` for the latest cached plugin and dynamically imports its `statusline/index.mjs`

User flow becomes:
```
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
# restart Claude Code → SessionStart hook installs wrapper + patches settings → statusline appears next session
```

Pre-flight findings already committed (this plan + spec edits land together). No code in Pre-flight.

---

## Task 1: Plugin scaffolding + installer + minimal end-to-end

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/statusline/.claude-plugin/plugin.json`
- Create: `plugins/statusline/hooks/hooks.json`
- Create: `plugins/statusline/scripts/install.mjs`
- Create: `plugins/statusline/scripts/bootstrap.mjs`
- Create: `plugins/statusline/statusline/index.mjs`
- Create: `plugins/statusline/statusline/find-node.sh`
- Create: `.gitignore` (if missing) — exclude `.omc/`, `plugins/statusline/test-fixtures/local-*`

- [ ] **Step 1: Write marketplace manifest**

Create `.claude-plugin/marketplace.json`:

```json
{
  "name": "claude-code-statusline",
  "owner": { "name": "cyhcyh100" },
  "plugins": [
    {
      "name": "statusline",
      "source": "./plugins/statusline",
      "description": "Custom statusline: branch, PR, 5h/weekly usage, context %, thinking, todos, skills, bg tasks"
    }
  ]
}
```

- [ ] **Step 2: Write plugin manifest**

Create `plugins/statusline/.claude-plugin/plugin.json` (note `.claude-plugin/` subdirectory — required by Claude Code spec):

```json
{
  "name": "statusline",
  "version": "0.1.0",
  "description": "Multi-line statusline for Claude Code",
  "author": { "name": "cyhcyh100" }
}
```

Do NOT add a `statusLine` field — plugin manifest doesn't support it. Registration happens via the SessionStart hook (Step 4).

- [ ] **Step 3: Write find-node.sh**

Create `plugins/statusline/statusline/find-node.sh` (POSIX shell, locates node for nvm/fnm users):

```sh
#!/bin/sh
# Locates node binary across nvm/fnm/Homebrew/system installs and execs with passed args.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then NODE_BIN="node"; fi
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for _p in "$HOME/.nvm/versions/node/"*/bin/node; do [ -x "$_p" ] && NODE_BIN="$_p"; done
fi
if [ -z "$NODE_BIN" ]; then
  for _b in "$HOME/.fnm/node-versions" "$HOME/Library/Application Support/fnm/node-versions" "$HOME/.local/share/fnm/node-versions"; do
    [ -d "$_b" ] || continue
    for _p in "$_b/"*/installation/bin/node; do [ -x "$_p" ] && NODE_BIN="$_p"; done
    [ -n "$NODE_BIN" ] && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  for _p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$_p" ] && NODE_BIN="$_p" && break
  done
fi
if [ -z "$NODE_BIN" ]; then exit 0; fi
exec "$NODE_BIN" "$@"
```

Then `chmod +x plugins/statusline/statusline/find-node.sh`.

- [ ] **Step 4: Write hooks.json (SessionStart → install.mjs)**

Create `plugins/statusline/hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh \"${CLAUDE_PLUGIN_ROOT}/statusline/find-node.sh\" \"${CLAUDE_PLUGIN_ROOT}/scripts/install.mjs\""
          }
        ]
      }
    ]
  }
}
```

The hook fires on every Claude Code session start. `install.mjs` is idempotent — short-circuits when already installed at the current version.

- [ ] **Step 5: Write scripts/install.mjs (idempotent installer)**

Create `plugins/statusline/scripts/install.mjs`:

```js
#!/usr/bin/env node
// Idempotent installer: runs from SessionStart hook. Copies bootstrap.mjs to
// ~/.claude/claude-code-statusline/ and patches user settings.json statusLine.
// Short-circuits when already installed at the current plugin version.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  // Read plugin version from sibling plugin.json
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = dirname(__dirname); // plugins/statusline
  const pluginJsonPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(pluginJsonPath, "utf-8")).version || version;
  } catch { /* fall through */ }

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const installDir = join(claudeDir, "claude-code-statusline");
  const markerPath = join(installDir, ".installed");
  const wrapperPath = join(installDir, "bootstrap.mjs");
  const findNodePath = join(installDir, "find-node.sh");
  const settingsPath = join(claudeDir, "settings.json");

  // Marker check: already installed at this version?
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      if (marker.version === version && existsSync(wrapperPath) && existsSync(findNodePath)) {
        // Verify settings.json still points at our wrapper
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (s.statusLine && typeof s.statusLine.command === "string" && s.statusLine.command.includes("claude-code-statusline")) {
            return; // fully installed, nothing to do
          }
        }
      }
    } catch { /* re-install on any error */ }
  }

  // (Re)install
  mkdirSync(installDir, { recursive: true });
  copyFileSync(join(__dirname, "bootstrap.mjs"), wrapperPath);
  copyFileSync(join(pluginRoot, "statusline", "find-node.sh"), findNodePath);
  try { (await import("node:fs")).chmodSync(findNodePath, 0o755); } catch { /* Windows */ }

  // Patch settings.json
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* start fresh */ }
  }
  // Backup any existing statusLine that isn't ours
  if (settings.statusLine && !(typeof settings.statusLine.command === "string" && settings.statusLine.command.includes("claude-code-statusline"))) {
    settings._statusLineBackup = settings._statusLineBackup || settings.statusLine;
  }
  settings.statusLine = {
    type: "command",
    command: `sh "${findNodePath}" "${wrapperPath}"`,
  };
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, settingsPath);

  writeFileSync(markerPath, JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2));
  // Hooks run silently; no stdout needed.
}
main().catch(() => { /* never crash the session */ });
```

- [ ] **Step 6: Write scripts/bootstrap.mjs (runtime version-discovery wrapper)**

Create `plugins/statusline/scripts/bootstrap.mjs`. This file is also COPIED to `~/.claude/claude-code-statusline/bootstrap.mjs` by `install.mjs` — keep it self-contained (no relative imports).

```js
#!/usr/bin/env node
// Runtime wrapper for the statusline plugin. Resolves the latest plugin cache
// version and dynamically imports its index.mjs. Mirrors OMC HUD's wrapper
// pattern so plugin auto-updates flow through without re-patching settings.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function semverCompareDesc(a, b) {
  const pa = String(a).split(/[.-]/).map(p => { const n = Number(p); return Number.isFinite(n) ? n : p; });
  const pb = String(b).split(/[.-]/).map(p => { const n = Number(p); return Number.isFinite(n) ? n : p; });
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === y) continue;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(y).localeCompare(String(x), undefined, { numeric: true });
  }
  return 0;
}

async function main() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const cacheBase = join(claudeDir, "plugins", "cache", "claude-code-statusline", "statusline");
  if (!existsSync(cacheBase)) return; // plugin not installed
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
main().catch(() => {});
```

- [ ] **Step 7: Write minimal index.mjs**

Create `plugins/statusline/statusline/index.mjs`:

```js
#!/usr/bin/env node
// Minimal entry — verifies plumbing. Replaced incrementally in later tasks.
async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
  });
}
async function main() {
  const raw = await readStdin();
  let info = {};
  try { info = JSON.parse(raw); } catch { /* ignore */ }
  process.stdout.write(`statusline-plugin v0.1.0 · cwd=${info.cwd ?? "?"}\n`);
}
main().catch(() => { /* never crash visibly */ });
```

- [ ] **Step 8: Add .gitignore entries**

If `.gitignore` missing or doesn't include `.omc/`, create / append:

```
.omc/
plugins/statusline/test-fixtures/local-*
```

- [ ] **Step 9: Manual install + verify**

In Claude Code (UI):
```
/plugin marketplace add /path/to/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

Restart Claude Code → SessionStart hook fires → install.mjs creates `~/.claude/claude-code-statusline/{bootstrap.mjs, find-node.sh, .installed}` and patches `~/.claude/settings.json`. Restart Claude Code one more time (statusline registration takes effect on next session start).

Verify:
```bash
ls ~/.claude/claude-code-statusline/
cat ~/.claude/claude-code-statusline/.installed
grep -A2 statusLine ~/.claude/settings.json
```

Expected: install dir populated, marker shows `version: "0.1.0"`, settings.json `statusLine.command` references the wrapper.

Statusline visible in UI: `statusline-plugin v0.1.0 · cwd=...`.

If install fails, debug with:
```bash
sh ~/.claude/claude-code-statusline/find-node.sh /path/to/claude-code-statusline/plugins/statusline/scripts/install.mjs
```

- [ ] **Step 10: Commit**

```bash
git add .claude-plugin plugins/statusline .gitignore
git commit -m "$(cat <<'EOF'
add: statusline plugin scaffolding

Marketplace + plugin manifest, SessionStart-hook installer, runtime
version-discovery wrapper, and a minimal index.mjs that echoes
statusline-plugin v0.1.0. Verifies end-to-end plumbing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Color + hyperlink helpers

**Files:**
- Create: `plugins/statusline/statusline/lib/colors.mjs`
- Create: `plugins/statusline/statusline/lib/hyperlink.mjs`

- [ ] **Step 1: Write colors.mjs**

```js
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

// Pick color by usage % using project-wide thresholds.
export function pctColor(pct) {
  if (pct >= 85) return red;
  if (pct >= 70) return yellow;
  return green;
}
```

- [ ] **Step 2: Write hyperlink.mjs**

```js
// OSC 8 terminal hyperlink. Falls back to plain text if URL invalid.
export function osc8(url, text) {
  if (!url || typeof url !== "string") return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
```

- [ ] **Step 3: Smoke test from index.mjs**

Temporarily edit `index.mjs` to import and use one helper:

```js
import { green } from "./lib/colors.mjs";
import { osc8 } from "./lib/hyperlink.mjs";
// ... in main(), replace stdout.write line with:
process.stdout.write(`${green("OK")} · ${osc8("https://example.com", "click")}\n`);
```

Run:
```
echo '{}' | node plugins/statusline/statusline/index.mjs
```

Expected stdout: `OK` shown in green; `click` is a clickable link in iTerm2/modern terminals. Revert the temporary edit after confirming.

- [ ] **Step 4: Commit**

```bash
git add plugins/statusline/statusline/lib
git commit -m "add: color and hyperlink helpers for statusline"
```

---

## Task 3: stdin-info.mjs (cwd, model, context %)

**Files:**
- Create: `plugins/statusline/statusline/lib/stdin-info.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Write stdin-info.mjs**

```js
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
```

- [ ] **Step 2: Wire into index.mjs (replace minimal output)**

Edit `index.mjs`:

```js
#!/usr/bin/env node
import { parseStdin, homeRelativize, modelDisplay, contextPercent } from "./lib/stdin-info.mjs";
import { cyan, magenta, pctColor } from "./lib/colors.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  const info = parseStdin(await readStdin());
  const cwd = cyan(homeRelativize(info.cwd));
  const model = magenta("🤖 " + modelDisplay(info.model));
  const ctxPct = contextPercent(info.context_window);
  const ctx = ctxPct == null ? "" : pctColor(ctxPct)(`ctx ${ctxPct}%`);
  const line1 = [cwd, model].join(" · ");
  const line2 = ctx;
  process.stdout.write([line1, line2].filter(Boolean).join("\n") + "\n");
}
main().catch(() => {});
```

- [ ] **Step 3: Verify with fixture stdin**

Create `plugins/statusline/test-fixtures/stdin-basic.json`:

```json
{
  "cwd": "/path/to/claude-code-statusline",
  "model": { "id": "claude-opus-4-7", "display_name": "Opus 4.7" },
  "context_window": { "context_window_size": 200000, "used_percentage": 47 }
}
```

Run:
```
cat plugins/statusline/test-fixtures/stdin-basic.json | node plugins/statusline/statusline/index.mjs
```

Expected: two lines — `~/claude-code-statusline · 🤖 Opus 4.7` (line 1, cyan + magenta) and `ctx 47%` (line 2, green).

- [ ] **Step 4: Commit**

```bash
git add plugins/statusline/statusline/lib/stdin-info.mjs plugins/statusline/statusline/index.mjs plugins/statusline/test-fixtures/stdin-basic.json
git commit -m "add: stdin-derived elements (cwd, model, context %)"
```

---

## Task 4: Cache infrastructure + git branch

**Files:**
- Create: `plugins/statusline/statusline/lib/cache.mjs`
- Create: `plugins/statusline/statusline/lib/git-info.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Write cache.mjs**

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function cacheDir() {
  const dir = join(homedir(), ".claude", "claude-code-statusline", "cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch { return null; }
}

export function writeJsonAtomic(path, obj) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(obj));
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
```

- [ ] **Step 2: Write git-info.mjs (branch only at this step)**

```js
import { execFileSync } from "node:child_process";

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
```

- [ ] **Step 3: Wire into index.mjs**

Add import and use:

```js
import { gitBranch } from "./lib/git-info.mjs";
// ... after computing cwd/model:
const branch = gitBranch(info.cwd);
const branchPart = branch ? cyan(` ${branch}`) : null;
const line1 = [cyan(homeRelativize(info.cwd)), magenta("🤖 " + modelDisplay(info.model)), branchPart].filter(Boolean).join(" · ");
```

- [ ] **Step 4: Verify**

Run from this repo (a git folder):
```
cat plugins/statusline/test-fixtures/stdin-basic.json | node plugins/statusline/statusline/index.mjs
```
Expected: line 1 includes ` main` (or current branch).

Run from `/tmp` (non-git):
```
cd /tmp && cat /path/to/claude-code-statusline/plugins/statusline/test-fixtures/stdin-basic.json | sed 's|/path/to/claude-code-statusline|/tmp|' | node /path/to/claude-code-statusline/plugins/statusline/statusline/index.mjs
```
Expected: line 1 has no branch segment.

- [ ] **Step 5: Commit**

```bash
git add plugins/statusline/statusline/lib/cache.mjs plugins/statusline/statusline/lib/git-info.mjs plugins/statusline/statusline/index.mjs
git commit -m "add: cache helpers and git branch detection"
```

---

## Task 5: PR detection (with cache + OSC 8 hyperlink)

**Files:**
- Modify: `plugins/statusline/statusline/lib/git-info.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Extend git-info.mjs with PR detection**

Append to `git-info.mjs`:

```js
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cacheDir, readJson, writeJsonAtomic, isExpired } from "./cache.mjs";

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
```

- [ ] **Step 2: Wire into index.mjs**

Add imports and usage:

```js
import { getPR } from "./lib/git-info.mjs";
import { osc8 } from "./lib/hyperlink.mjs";
import { green, gray } from "./lib/colors.mjs";

// ... after branchPart:
const pr = branch ? getPR(branch, info.cwd) : null;
let prPart = null;
if (pr && pr.state === "OPEN") {
  prPart = osc8(pr.url, green(`#${pr.number}`));
} else if (pr && pr.state === "MERGED") {
  prPart = osc8(pr.url, gray(`#${pr.number} (merged)`));
} // CLOSED → omit
const line1 = [cyan(homeRelativize(info.cwd)), magenta("🤖 " + modelDisplay(info.model)), branchPart, prPart].filter(Boolean).join(" · ");
```

- [ ] **Step 3: Verify (4 cases)**

Run from this repo (no PR yet expected):
```
cat plugins/statusline/test-fixtures/stdin-basic.json | node plugins/statusline/statusline/index.mjs
```
Expected: branch shown, no `#N`.

Manually create a test PR or test in a repo with one open. Expected: `#N` green clickable.

Test no `gh`: temporarily run with `PATH=/usr/bin` (no gh):
```
PATH=/usr/bin cat plugins/statusline/test-fixtures/stdin-basic.json | node plugins/statusline/statusline/index.mjs
```
Expected: PR omitted silently.

Confirm cache file exists: `ls ~/.claude/claude-code-statusline/cache/pr-*.json`

- [ ] **Step 4: Commit**

```bash
git add plugins/statusline/statusline/lib/git-info.mjs plugins/statusline/statusline/index.mjs
git commit -m "add: PR detection with caching and OSC 8 hyperlinks"
```

---

## Task 6: Transcript scan (thinking + todos + lastSkill + bg tasks)

**Files:**
- Create: `plugins/statusline/statusline/lib/transcript.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Write transcript.mjs**

```js
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
export function scanTranscript(path) {
  const empty = { thinking: { active: false }, todos: null, lastSkill: null, bgRunning: 0 };
  if (!path || !existsSync(path)) return empty;
  const tail = tailRead(path, TAIL_BYTES);
  if (!tail) return empty;
  const lines = tail.split("\n").filter(Boolean);

  let lastThinkingTs = null;
  let lastTodos = null;
  let lastSkill = null;
  // Track background bash by tool_use_id to determine if a result has arrived.
  const bgUseIds = new Map(); // id -> command (truncated)
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
          bgUseIds.set(block.id, String(input.command || "").slice(0, 60));
        }
      } else if (block.type === "tool_result" && block.tool_use_id) {
        seenResultIds.add(block.tool_use_id);
      }
    }
  }

  let bgRunning = 0;
  for (const id of bgUseIds.keys()) if (!seenResultIds.has(id)) bgRunning++;

  const now = Date.now();
  const thinkingActive = lastThinkingTs != null && (now - lastThinkingTs) <= THINKING_RECENCY_MS;
  return {
    thinking: { active: thinkingActive, lastSeen: lastThinkingTs ?? undefined },
    todos: lastTodos,
    lastSkill,
    bgRunning,
  };
}
```

- [ ] **Step 2: Wire into index.mjs**

Add imports and lines 3-4 composition:

```js
import { scanTranscript } from "./lib/transcript.mjs";

// ... after pr/line1:
const tr = scanTranscript(info.transcript_path);
const thinkingPart = tr.thinking.active ? magenta("💭") : null;
// line 2 will become: ctx + thinking (and later: 5h, wk)
const line2 = [ctx, thinkingPart].filter(Boolean).join(" · ");

// line 3 — todos
let line3 = null;
if (tr.todos && tr.todos.length) {
  const visible = tr.todos.filter(t => t.status !== "completed").slice(0, 5);
  const overflow = tr.todos.filter(t => t.status !== "completed").length - visible.length;
  const items = visible.map(t => {
    const text = t.content || t.activeForm || "";
    if (t.status === "in_progress") return yellow(`▶ ${text}`);
    return `☐ ${text}`;
  });
  if (overflow > 0) items.push(gray(`… +${overflow} more`));
  line3 = items.join(" · ");
}

// line 4 — last skill + background tasks
const skillPart = tr.lastSkill ? magenta(`🔧 ${tr.lastSkill.name}`) : null;
const bgPart = tr.bgRunning > 0 ? gray(`⚙ ${tr.bgRunning} bg`) : null;
const line4 = [skillPart, bgPart].filter(Boolean).join(" · ") || null;

const lines = [line1, line2, line3, line4].filter(Boolean);
process.stdout.write(lines.join("\n") + "\n");
```

Add `yellow` to imports from `./lib/colors.mjs`.

- [ ] **Step 3: Build a transcript fixture**

Create `plugins/statusline/test-fixtures/transcript.jsonl` with a few representative lines:

```jsonl
{"timestamp":"2026-05-11T11:00:00Z","message":{"content":[{"type":"text","text":"hi"}]}}
{"timestamp":"2026-05-11T11:01:00Z","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"Build feature foo","status":"in_progress","activeForm":"Building feature foo"},{"content":"Test foo","status":"pending"},{"content":"Document","status":"pending"}]}}]}}
{"timestamp":"2026-05-11T11:02:00Z","message":{"content":[{"type":"tool_use","id":"s1","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]}}
{"timestamp":"2026-05-11T11:03:00Z","message":{"content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"npm run build","run_in_background":true}}]}}
```

Then a stdin fixture pointing at it. Create `plugins/statusline/test-fixtures/stdin-with-transcript.json`:

```json
{
  "cwd": "/path/to/claude-code-statusline",
  "model": { "id": "claude-opus-4-7", "display_name": "Opus 4.7" },
  "context_window": { "context_window_size": 200000, "used_percentage": 47 },
  "transcript_path": "/path/to/claude-code-statusline/plugins/statusline/test-fixtures/transcript.jsonl"
}
```

- [ ] **Step 4: Verify**

```
cat plugins/statusline/test-fixtures/stdin-with-transcript.json | node plugins/statusline/statusline/index.mjs
```

Expected lines (thinking is **inactive** because the fixture timestamps are in 2026-05-11 — adjust to a fresh `now()` if needed for thinking active test):
```
~/claude-code-statusline · 🤖 Opus 4.7 ·  main
ctx 47%
▶ Build feature foo · ☐ Test foo · ☐ Document
🔧 superpowers:brainstorming · ⚙ 1 bg
```

- [ ] **Step 5: Commit**

```bash
git add plugins/statusline/statusline/lib/transcript.mjs plugins/statusline/statusline/index.mjs plugins/statusline/test-fixtures/transcript.jsonl plugins/statusline/test-fixtures/stdin-with-transcript.json
git commit -m "add: transcript scan for thinking, todos, skills, bg tasks"
```

---

## Task 7: OAuth usage API (5h + weekly)

**Files:**
- Create: `plugins/statusline/statusline/lib/usage-api.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Write usage-api.mjs (credentials)**

```js
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
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
      const out = execSync(`/usr/bin/security ${args.map(a => `"${a}"`).join(" ")} 2>/dev/null`, {
        encoding: "utf-8", timeout: 2000,
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
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
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
```

- [ ] **Step 2: Add fetch + parse + getUsage in same file**

Append to `usage-api.mjs`:

```js
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

function parseUsage(api) {
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

const CACHE_PATH = () => join(cacheDir(), "usage.json");

export async function getUsage() {
  const path = CACHE_PATH();
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
    if (cached && cached.data) return cached.data; // serve stale on failure
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

// Format helper exported for index.mjs.
export function formatResetUntil(iso, mode) {
  // mode: "5h" → "XhYm"; "wk" → "XdYh"
  if (!iso) return "";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "";
  const ms = Math.max(0, target - Date.now());
  if (mode === "5h") {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h${m}m`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${d}d${h}h`;
}
```

- [ ] **Step 3: Wire into index.mjs**

Make `main()` async-await `getUsage()` and append 5h/wk segments to line 2. Final `index.mjs` shape:

```js
#!/usr/bin/env node
import { parseStdin, homeRelativize, modelDisplay, contextPercent } from "./lib/stdin-info.mjs";
import { cyan, magenta, yellow, green, gray, pctColor } from "./lib/colors.mjs";
import { osc8 } from "./lib/hyperlink.mjs";
import { gitBranch, getPR } from "./lib/git-info.mjs";
import { scanTranscript } from "./lib/transcript.mjs";
import { getUsage, formatResetUntil } from "./lib/usage-api.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  const info = parseStdin(await readStdin());

  // Line 1: cwd · model · branch · PR
  const branch = gitBranch(info.cwd);
  const pr = branch ? getPR(branch, info.cwd) : null;
  let prPart = null;
  if (pr && pr.state === "OPEN") prPart = osc8(pr.url, green(`#${pr.number}`));
  else if (pr && pr.state === "MERGED") prPart = osc8(pr.url, gray(`#${pr.number} (merged)`));
  const line1 = [
    cyan(homeRelativize(info.cwd)),
    magenta("🤖 " + modelDisplay(info.model)),
    branch ? cyan(` ${branch}`) : null,
    prPart,
  ].filter(Boolean).join(" · ");

  // Line 2: 5h · wk · ctx · thinking
  const usage = await getUsage();
  const usageParts = [];
  if (usage && usage.fiveHourPercent != null) {
    const reset = formatResetUntil(usage.fiveHourResetsAt, "5h");
    usageParts.push(pctColor(usage.fiveHourPercent)(`5h ${usage.fiveHourPercent}%${reset ? " " + reset : ""}`));
  }
  if (usage && usage.weeklyPercent != null) {
    const reset = formatResetUntil(usage.weeklyResetsAt, "wk");
    usageParts.push(pctColor(usage.weeklyPercent)(`wk ${usage.weeklyPercent}%${reset ? " " + reset : ""}`));
  }
  const ctxPct = contextPercent(info.context_window);
  if (ctxPct != null) usageParts.push(pctColor(ctxPct)(`ctx ${ctxPct}%`));
  const tr = scanTranscript(info.transcript_path);
  if (tr.thinking.active) usageParts.push(magenta("💭"));
  const line2 = usageParts.join(" · ") || null;

  // Line 3: todos
  let line3 = null;
  if (tr.todos && tr.todos.length) {
    const visible = tr.todos.filter(t => t.status !== "completed").slice(0, 5);
    const overflow = tr.todos.filter(t => t.status !== "completed").length - visible.length;
    const items = visible.map(t => {
      const text = t.content || t.activeForm || "";
      return t.status === "in_progress" ? yellow(`▶ ${text}`) : `☐ ${text}`;
    });
    if (overflow > 0) items.push(gray(`… +${overflow} more`));
    line3 = items.join(" · ");
  }

  // Line 4: skill · bg
  const skillPart = tr.lastSkill ? magenta(`🔧 ${tr.lastSkill.name}`) : null;
  const bgPart = tr.bgRunning > 0 ? gray(`⚙ ${tr.bgRunning} bg`) : null;
  const line4 = [skillPart, bgPart].filter(Boolean).join(" · ") || null;

  // Line 5 (warning): only if context >= 80%
  let line5 = null;
  if (ctxPct != null && ctxPct >= 80) {
    const banner = `⚠ Context at ${ctxPct}% — consider /compact`;
    line5 = ctxPct >= 90 ? `\x1b[1;31m${banner}\x1b[0m` : `\x1b[1;33m${banner}\x1b[0m`;
  }

  const out = [line1, line2, line3, line4, line5].filter(Boolean).join("\n");
  if (out) process.stdout.write(out + "\n");
}
main().catch(() => {});
```

- [ ] **Step 4: Verify usage rendering**

Run with full fixture:
```
cat plugins/statusline/test-fixtures/stdin-with-transcript.json | node plugins/statusline/statusline/index.mjs
```

Expected (assuming OAuth creds present): line 2 has `5h N% XhYm · wk N% XdYh · ctx 47%`. Without creds: just `ctx 47%`.

Bump `used_percentage` in the fixture to `82` and verify warning banner appears (yellow).

Then `90` → red banner.

Confirm cache file: `cat ~/.claude/claude-code-statusline/cache/usage.json` shows `data` or `error`.

- [ ] **Step 5: Commit**

```bash
git add plugins/statusline/statusline/lib/usage-api.mjs plugins/statusline/statusline/index.mjs
git commit -m "add: OAuth usage API (5h/weekly) with caching and refresh"
```

---

## Task 8: Layout polish (truncation + max lines + degrade-to-empty)

**Files:**
- Create: `plugins/statusline/statusline/lib/layout.mjs`
- Modify: `plugins/statusline/statusline/index.mjs`

- [ ] **Step 1: Write layout.mjs**

```js
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

const MAX_LINES = 5;
const TERM_WIDTH = (() => {
  const w = parseInt(process.env.COLUMNS || "", 10);
  return Number.isFinite(w) && w > 20 ? w : 200; // generous default; Claude Code crops naturally
})();

export function compose(lines) {
  return lines
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map(l => truncateLine(l, TERM_WIDTH))
    .join("\n");
}
```

- [ ] **Step 2: Use compose() in index.mjs**

Replace the final block in `main()`:

```js
import { compose } from "./lib/layout.mjs";
// ... at end of main():
const out = compose([line1, line2, line3, line4, line5]);
if (out) process.stdout.write(out + "\n");
```

- [ ] **Step 3: Verify truncation**

Force a narrow width:
```
COLUMNS=40 cat plugins/statusline/test-fixtures/stdin-with-transcript.json | node plugins/statusline/statusline/index.mjs
```
Expected: each line truncates with `…` and resets ANSI at the end (no color bleed into next line).

- [ ] **Step 4: Commit**

```bash
git add plugins/statusline/statusline/lib/layout.mjs plugins/statusline/statusline/index.mjs
git commit -m "add: layout composition with ANSI-aware truncation"
```

---

## Task 9: Plugin install + end-to-end verification + spec checklist

**Files:**
- Modify: `plugins/statusline/.claude-plugin/plugin.json` (bump version to 1.0.0)

- [ ] **Step 1: Bump version**

Edit `plugins/statusline/.claude-plugin/plugin.json` `version` field: `0.1.0` → `1.0.0`.

- [ ] **Step 2: Reinstall plugin from local path**

In Claude Code (UI):
```
/plugin marketplace update claude-code-statusline
```
Restart Claude Code. The SessionStart hook detects the new version (marker mismatch in `~/.claude/claude-code-statusline/.installed`) and re-runs install.mjs. The bootstrap wrapper auto-picks the latest plugin cache version on each render — no settings.json re-patch needed once the wrapper path is set.

- [ ] **Step 3: Walk the spec §13 checklist**

Verify each item against your live statusline. Check off mentally:

- [ ] git repo + open PR: line 1 shows `cwd · model · branch · #N` with hyperlink
- [ ] PR merged → `(merged)` suffix gray
- [ ] No PR → branch shown, PR omitted
- [ ] Non-git folder → branch + PR omitted (`cd /tmp` and look)
- [ ] OAuth creds present → 5h + wk percentages on line 2
- [ ] OAuth creds expired → refresh works (manually expire `~/.claude/.credentials.json` `expiresAt` to test, or wait)
- [ ] contextBar shows reasonable %
- [ ] Context > 80% → warning banner appears (force a long session or edit fixture for offline test)
- [ ] Thinking active mid-response → 💭 appears (live during a model response)
- [ ] Active TodoWrite list → line 3 with current item highlighted
- [ ] Last skill invocation → line 4 shows
- [ ] `run_in_background:true` Bash → `⚙ N bg` shows
- [ ] No `gh` → degrades silently (`PATH=/usr/bin claude` or temporarily move `gh`)
- [ ] Render time `< 300ms` warm: `time (cat plugins/statusline/test-fixtures/stdin-with-transcript.json | node plugins/statusline/statusline/index.mjs)`
- [ ] Output capped at 5 lines (force all elements, count newlines)

If any check fails, fix and re-verify. Commit fixes individually.

- [ ] **Step 4: Add a one-screen README for the plugin**

Create `plugins/statusline/README.md`:

```markdown
# statusline

Custom Claude Code statusline showing git/PR status, 5h + weekly Anthropic
usage, context %, thinking indicator, todos, last skill, and background
task count.

## Install

```
/plugin marketplace add cyhcyh100/claude-code-statusline
/plugin install statusline@claude-code-statusline
```

Restart Claude Code.

## Updates

Auto-fetched from the marketplace. To force: `/plugin marketplace update claude-code-statusline`.

## Requirements

- Node.js (any recent version, located via `find-node.sh`)
- `git` (optional — branch hidden if missing)
- `gh` CLI (optional — PR hidden if missing or no auth)
- Anthropic OAuth credentials in macOS Keychain or `~/.claude/.credentials.json` (optional — usage hidden if missing)

## Cache

`~/.claude/claude-code-statusline/cache/` (usage.json + pr-*.json). Safe to delete; auto-rebuilt.

## Design spec

See `docs/superpowers/specs/2026-05-11-statusline-plugin-design.md` in this repo.
```

- [ ] **Step 5: Final commit + tag release**

```bash
git add plugins/statusline/.claude-plugin/plugin.json plugins/statusline/README.md
git commit -m "$(cat <<'EOF'
release: statusline plugin v1.0.0

End-to-end verified against the spec §13 checklist. Ready for team
install via `/plugin marketplace add cyhcyh100/claude-code-statusline`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git tag statusline-v1.0.0
git push origin main statusline-v1.0.0
```

---

## Self-Review (run before handing off)

**Spec coverage check:** Each spec section has at least one task implementing it:
- §1 Goal items 1-11 → Tasks 3-7
- §3 Distribution model + plugin scaffolding → Pre-flight + Task 1
- §4 Output format + element rules → Tasks 3-8 (composed in Task 7+8)
- §5 Data sources → Tasks 3 (stdin), 4-5 (git/PR), 6 (transcript), 7 (OAuth)
- §6 Caching → Task 4 (cache.mjs), reused in Tasks 5 + 7
- §7 OAuth handling → Task 7
- §8 PR detection → Task 5
- §9 Thinking → Task 6
- §10 Context display → Task 3 (parse) + Task 7 (warning banner)
- §11 Error handling → all tasks (try/catch + timeouts in helpers)
- §12 Security/SSRF → Task 7 (hardcoded `api.anthropic.com`, no env URL)
- §13 Testing checklist → Task 9

**Placeholder scan:** No "TBD", "TODO", "implement later". All code shown inline.

**Type consistency:** `getUsage()` returns `{ fiveHourPercent, fiveHourResetsAt, weeklyPercent, weeklyResetsAt }` (Task 7 parseUsage) and is consumed in Task 7 Step 3 with the same names. `scanTranscript()` returns `{ thinking, todos, lastSkill, bgRunning }` (Task 6) and Task 7 Step 3 uses the same names. `getPR()` returns `{ number, url, state }` or null (Task 5) and Task 7 Step 3 reads them.

---

## Plan vs. final v1.0.0 implementation

Tasks 1-9 produce the architectural baseline (plugin scaffolding, lib
modules, OAuth flow, transcript scan, layout). The exact visual format
in those task code blocks is a starting point, not the final v1.0.0
output — cosmetic choices (label format, separator, symbols) were
explored during PR review and squash-merged into the single v1.0.0
release.

**Final v1.0.0 output:**

```
~/work/project |  main | #42 (merged)
🤖 Opus 4.7 | 5h:42%(3h12m) | wk:18%(5d4h) | ctx:47% | *thinking*
▶ Build feature foo | ☐ Test foo | ☐ Document
🔧 superpowers:brainstorming | ⚙ 2 bg
```

Notable differences from the original task code:
- Separator is dim ` | `, not ` · `.
- Usage segments shaped as `5h:N%(reset)` / `wk:N%(reset)` / `ctx:N%`; reset wrapped in dim parens; leading `0h`/`0d` dropped from short durations.
- Model badge `🤖 …` lives at the start of line 2 (not line 1).
- Thinking indicator is text `*thinking*`, not the `💭` emoji.

The full final code is in the v1.0.0 release commit on `main`. Future
work follows the same one-PR-per-version policy (see spec §16).
