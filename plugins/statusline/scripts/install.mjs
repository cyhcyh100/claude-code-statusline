#!/usr/bin/env node
// Idempotent installer: runs from SessionStart hook. Copies bootstrap.mjs to
// ~/.claude/claude-code-statusline/ and patches user settings.json statusLine.
// Short-circuits when already installed at the current plugin version.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = dirname(__dirname);
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

  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      if (marker.version === version && existsSync(wrapperPath) && existsSync(findNodePath)) {
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (s.statusLine && typeof s.statusLine.command === "string" && s.statusLine.command.includes("claude-code-statusline")) {
            return;
          }
        }
      }
    } catch { /* re-install on any error */ }
  }

  mkdirSync(installDir, { recursive: true });
  copyFileSync(join(__dirname, "bootstrap.mjs"), wrapperPath);
  copyFileSync(join(pluginRoot, "statusline", "find-node.sh"), findNodePath);
  try { chmodSync(findNodePath, 0o755); } catch { /* Windows */ }

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Don't overwrite a malformed settings.json — that would erase the
      // user's other config (permissions, allowedTools, theme…). Back up
      // and bail out; we'll retry on the next SessionStart.
      try { copyFileSync(settingsPath, `${settingsPath}.bak.${Date.now()}`); } catch { /* best effort */ }
      return;
    }
  }
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
}
main().catch((err) => {
  if (process.env.STATUSLINE_DEBUG) console.error('[statusline-install]', err);
});
