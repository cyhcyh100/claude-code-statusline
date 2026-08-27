#!/usr/bin/env node
import { parseStdin, homeRelativize, modelDisplay, contextPercent } from "./lib/stdin-info.mjs";
import { cyan, magenta, yellow, green, gray, dim, pctColor, boldRed, boldYellow } from "./lib/colors.mjs";
import { osc8 } from "./lib/hyperlink.mjs";
import { gitBranch, getPR } from "./lib/git-info.mjs";
import { scanTranscript } from "./lib/transcript.mjs";
import { getUsage } from "./lib/usage-api.mjs";
import { formatResetUntil } from "./lib/format.mjs";
import { compose, effectiveTermWidth } from "./lib/layout.mjs";
import { tryMultiRepo, renderMultiRepoLines, readBranchFromGitDir, stripControl } from "./lib/multi-repo.mjs";

async function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
  });
}

const SEP = dim(" | ");

async function main() {
  const info = parseStdin(await readStdin());

  // Line 1 has three modes:
  //  - inside a git repo            → existing branch + PR rendering
  //  - parent-of-repos (≥2 children) → multi-repo sub-lines (1.a/1.b/1.c)
  //  - parent-of-repos with 1 child  → single-repo render against the
  //                                    child, but keep parent path visible
  const branch = gitBranch(info.cwd);
  let line1s; // string[] — always one or more lines

  if (branch) {
    line1s = [renderSingleRepoLine(info.cwd, branch, info.cwd)];
  } else {
    const multi = await tryMultiRepo(info.cwd);
    if (multi && multi.singleChild) {
      // Use the pure-FS branch reader so the single-child fallback
      // matches the multi-repo path's branch / detached / mid-op
      // semantics (one source of truth, no subprocess).
      const childBranch = readBranchFromGitDir(multi.singleChild.gitDir).branch;
      line1s = [renderSingleRepoLine(multi.singleChild.absPath, childBranch, info.cwd)];
    } else if (multi && multi.records) {
      // The stale-while-revalidate refresh fires in the background.
      // Swallow rejections defensively — current implementation never
      // throws, but a future change could turn this into an
      // unhandled promise rejection after the statusline exits.
      multi.refresh.catch(() => {});
      line1s = renderMultiRepoLines(multi.records, {
        path: homeRelativize(info.cwd),
        termWidth: effectiveTermWidth(),
      });
    } else {
      line1s = [cyan(homeRelativize(info.cwd))];
    }
  }

  const usage = await getUsage();
  const usageParts = [];
  if (usage && usage.fiveHourPercent != null) {
    const reset = formatResetUntil(usage.fiveHourResetsAt, "5h");
    const pct = pctColor(usage.fiveHourPercent)(`${usage.fiveHourPercent}%`);
    usageParts.push(`5h:${pct}${reset ? dim(`(${reset})`) : ""}`);
  }
  if (usage && usage.weeklyPercent != null) {
    const reset = formatResetUntil(usage.weeklyResetsAt, "wk");
    const pct = pctColor(usage.weeklyPercent)(`${usage.weeklyPercent}%`);
    usageParts.push(`wk:${pct}${reset ? dim(`(${reset})`) : ""}`);
  }
  const ctxPct = contextPercent(info.context_window);
  if (ctxPct != null) {
    usageParts.push(`ctx:${pctColor(ctxPct)(`${ctxPct}%`)}`);
  }
  const tr = scanTranscript(info.transcript_path);
  const thinkingPart = tr.thinking.active ? magenta("*thinking*") : null;
  const line2 = [
    magenta("🤖 " + modelDisplay(info.model)),
    ...usageParts,
    thinkingPart,
  ].filter(Boolean).join(SEP);

  let line3 = null;
  if (tr.todos && tr.todos.length) {
    const incomplete = tr.todos.filter(t => t.status !== "completed");
    const visible = incomplete.slice(0, 5);
    const overflow = incomplete.length - visible.length;
    const items = visible.map(t => {
      const text = t.content || t.activeForm || "";
      return t.status === "in_progress" ? yellow(`▶ ${text}`) : `☐ ${text}`;
    });
    if (overflow > 0) items.push(gray(`… +${overflow} more`));
    line3 = items.join(SEP);
  }

  const skillPart = tr.lastSkill ? magenta(`🔧 ${tr.lastSkill.name}`) : null;
  const bgPart = tr.bgRunning > 0 ? gray(`⚙ ${tr.bgRunning} bg`) : null;
  const line4 = [skillPart, bgPart].filter(Boolean).join(SEP) || null;

  let line5 = null;
  if (ctxPct != null && ctxPct >= 80) {
    const banner = `⚠ Context at ${ctxPct}% — consider /compact`;
    line5 = ctxPct >= 90 ? boldRed(banner) : boldYellow(banner);
  }

  const out = compose([...line1s, line2, line3, line4, line5]);
  if (out) process.stdout.write(out + "\n");
}

// Render the existing single-repo line. `branchCwd` is where to look
// up the branch + PR; `displayCwd` is what to show in the path
// segment (these differ for the single-child fallback case, where the
// branch comes from the lone child but the path stays at the parent).
//
// `branchName` is sanitized through `stripControl` before it reaches
// `cyan()` — a branch ref read from `.git/HEAD` is attacker-influenced
// (clone poisoning) and could otherwise smuggle ANSI escapes into the
// rendered line. The multi-repo path already does this in
// `formatRepoToken`; doing it here keeps both single-repo render
// paths consistent.
function renderSingleRepoLine(branchCwd, branchName, displayCwd) {
  const safeBranch = branchName ? stripControl(branchName) : branchName;
  const pr = safeBranch ? getPR(safeBranch, branchCwd) : null;
  let prPart = null;
  if (pr && pr.state === "OPEN") prPart = osc8(pr.url, green(`#${pr.number}`));
  else if (pr && pr.state === "MERGED") prPart = osc8(pr.url, gray(`#${pr.number} (merged)`));
  return [
    cyan(homeRelativize(displayCwd)),
    safeBranch ? cyan(` ${safeBranch}`) : null,
    prPart,
  ].filter(Boolean).join(SEP);
}

main().catch(() => {});
