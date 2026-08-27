#!/usr/bin/env node
// Builds a synthetic parent-of-repos directory for smoke testing the
// multi-repo statusline rendering path. Used by scripts/verify.sh.
//
// Each child is a `git init`'d repo with one empty commit and a fake
// GitHub origin URL — that's enough for discoverRepos to find it,
// readBranchFromGitDir to return a branch name, parseRemoteUrl to
// extract a slug, and `git status` to report a clean tree.
//
// Usage:  node build-multi-repo-tree.mjs <output-dir>
//
// `<output-dir>` must already exist. The script creates 3 subdirs
// `alpha`, `beta`, `gamma` inside it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: build-multi-repo-tree.mjs <output-dir>");
  process.exit(2);
}
let st;
try { st = statSync(dir); } catch {
  console.error(`output dir does not exist: ${dir}`);
  process.exit(2);
}
if (!st.isDirectory()) {
  console.error(`output path is not a directory: ${dir}`);
  process.exit(2);
}

// Project guideline (CLAUDE.md): `execFileSync` always uses
// stdio: ["ignore", "pipe", "ignore"] so stray stderr from helper
// commands doesn't leak into the smoke test or CI logs.
const STDIO = { stdio: ["ignore", "pipe", "ignore"] };

const names = ["alpha", "beta", "gamma"];
for (const name of names) {
  const path = join(dir, name);
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path], STDIO);
  execFileSync("git", ["-C", path, "config", "user.email", "fixture@example.com"], STDIO);
  execFileSync("git", ["-C", path, "config", "user.name", "fixture"], STDIO);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", "init"], STDIO);
  execFileSync("git", ["-C", path, "remote", "add", "origin", `git@github.com:example/${name}.git`], STDIO);
}
