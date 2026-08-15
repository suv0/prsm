import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AppConfig } from "@review-os/schemas";
import {
  killActiveCliChildren,
  listAvailableProviders,
} from "@review-os/providers";
import {
  clearGithubToken,
  fetchUserLogin,
  probeGithubAccess,
  resolveGithubToken,
  saveGithubToken,
} from "@review-os/github";
import { readFile, access } from "node:fs/promises";
import {
  ICON_INNER,
  iconHtml,
  iconTextHtml,
  renderReviewFromDir,
  renderVerifyPlaceholderHtml,
  sidebarChromeCss,
  sidebarToggleButtonHtml,
  sidebarToggleScript,
  workspaceChromeHeadHtml,
} from "@review-os/render";
import {
  DEFAULT_MULTI_AGENTS,
  runAllCliAgents,
  type AgentRunResult,
} from "./run-provider.js";
import { detectAgentStatuses } from "./agent-catalog.js";
import { addCustomAgent, removeCustomAgent } from "./custom-agents.js";
import { createLiveRegistry } from "./live-registry.js";
import {
  deleteReviewDir,
  listReviewSummaries,
  setReviewHubStatus,
  type ReviewHubMeta,
} from "./review-inventory.js";
import {
  handleTriageApi,
  serveReviewStatic,
  type TriageControllerOptions,
} from "./serve-triage.js";
import {
  applyLogToProgress,
  initJobProgress,
  syncTracksFromResults,
  type JobProgress,
} from "./job-progress.js";

export type ServeUiOptions = {
  repoRoot: string;
  config: AppConfig;
  port: number;
  /** Optional PR to highlight in logs after start. */
  focusPr?: number;
};

type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

type Job = {
  id: string;
  prRef: string;
  agents: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  logs: string[];
  progress: JobProgress;
  results: AgentRunResult[];
  cancelRequested: boolean;
  extraInstructions?: string;
  requireDecisionsMd?: boolean;
  prNumber?: number;
  outputDir?: string;
  mergedFindingCount?: number;
  error?: string;
};

/** Prefill for the hub “extra instructions” box (user-editable). */
const DEFAULT_EXTRA_INSTRUCTIONS = `High bar for this review. Prefer fewer, sharper findings over noise.

Naming & meaning (important):
- Judge function, variable, type, and parameter names against what the code actually does AND names used nearby / in related changed files — not only whether a name looks fine in isolation.
- Flag names that understate or overstate responsibility (e.g. a helper named like a narrow check but used as broader “can manage” logic).
- Prefer names a teammate would still trust after reading the whole PR.

Hard review lenses (cover as applicable):
1. Correctness — does it actually work?
2. Authorization/security — can someone do something they shouldn't?
3. State consistency — can UI/state get into an invalid state?
4. Edge cases — missing/invalid/unexpected data?
5. Architecture — duplicated logic, wrong abstraction, drift between screens.
6. UX — destructive actions, misleading controls, broken/loading states.
7. Dead code/scope — unnecessary code or unrelated changes.
8. Maintainability — fragile assumptions, positional mappings, hardcoded policy.
9. Tests — important behavior that isn't covered.

Stance:
- Be skeptical: verify claimed behavior from the code and related call sites.
- Distinguish real bugs from design preferences/nits.
- Prefer evidence from the diff; ask instead of guessing.
- Keep reviewComment like a teammate reading the code — concrete names, a realistic scenario, a plain ask. Do not stamp every comment with “Hm… interesting.” or a compressed “Could we…?” scanner line.`;

const EXTRA_INSTRUCTIONS_STORAGE_KEY = "prism:extra-instructions:v2";
const REQUIRE_DECISIONS_MD_STORAGE_KEY = "prism:require-decisions-md:v1";

/**
 * Optional Allchrono-style team rule. Only injected when the hub checkbox is on.
 * Open-source / generic runs leave the box unchecked and never see this.
 */
const REQUIRE_DESIGN_DECISIONS_MD_RULE = `## Team rule (enabled for this run): design-decision docs required

Every PR must include a markdown file that records design decisions for the module/task (what was decided, why, alternatives considered, and what others need to know).

Check the diff for new or updated \`.md\` decision docs (e.g. under \`docs/\`, \`.idea/\`, \`decisions/\`, ADR-style files, or a clearly named decisions note in the PR). A PR description alone is not enough unless the project already treats a specific path as the decision log — prefer a real \`.md\` file in the change set.

If missing or too thin to capture real decisions:
- Emit a finding with severity **blocker** (or **major** only if a partial doc exists but is incomplete).
- Category: \`process\` or \`documentation\`.
- Say which decision topics from the code change still need writing down.
- Keep \`reviewComment\` polite and paste-ready (Could we add …?).

If an adequate decisions \`.md\` is present and matches the change, do not invent a finding for this rule.`;

const jobs = new Map<string, Job>();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function providersPayload(): Promise<Record<string, unknown>> {
  const detected = await detectAgentStatuses();
  const { providers } = await createLiveRegistry();
  const available = await listAvailableProviders(providers);
  return {
    providers: detected.readyIds,
    readyIds: detected.readyIds,
    readyCount: detected.readyCount,
    agents: detected.agents,
    all: available,
    defaults: [...DEFAULT_MULTI_AGENTS],
  };
}

function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], {
            stdio: "ignore",
            windowsHide: true,
            detached: true,
          })
        : process.platform === "darwin"
          ? spawn("open", [url], { stdio: "ignore", detached: true })
          : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
    command.unref();
  } catch {
    // hub still works; user can paste the URL
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function touch(job: Job): void {
  job.updatedAt = new Date().toISOString();
}

function appendLog(job: Job, line: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  job.logs.push(`[${stamp}] ${line}`);
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
  applyLogToProgress(job.progress, line, job.agents);
  touch(job);
}

function homePage(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${workspaceChromeHeadHtml()}
  <title>PRism</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #121414;
      --surface: #1a1c1c;
      --card: #1e2020;
      --raised: #282a2b;
      --inset: #0d0e0f;
      --line: #3e4850;
      --ink: #e2e2e2;
      --muted: #bec8d1;
      --accent: #4fc1ff;
      --accent-hover: #84cfff;
      --on-primary: #00344c;
      --ok: #89d185;
      --bad: #ffb4ab;
      --warn: #ffc7a2;
      --cursor: #4fc1ff;
      --claude: #e9a97d;
      --command: #cda7ff;
      --radius: 4px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; color-scheme: dark; }
    .app { height: 100%; min-height: 0; }
    body {
      margin: 0;
      font-family: "Hanken Grotesk", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      line-height: 20px;
      background: var(--bg);
      color: var(--ink);
    }
    .app {
      display: grid;
      grid-template-columns: var(--sidebar-current) 1fr;
      min-height: 100%;
      transition: grid-template-columns 0.18s ease;
    }
    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--line);
      padding: 12px 0 0;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 16px 16px;
    }
    .logo-mark {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      background: var(--accent);
      color: var(--on-primary);
      font: 700 14px/28px "Hanken Grotesk", sans-serif;
      text-align: center;
      flex-shrink: 0;
    }
    .brand { font-size: 16px; font-weight: 600; line-height: 20px; color: #fff; }
    .brand-sub {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 0;
      border-left: 2px solid transparent;
      color: var(--ink);
      padding: 8px 16px;
      font: 600 13px/20px "Hanken Grotesk", sans-serif;
      cursor: pointer;
    }
    .nav-item:hover { background: var(--raised); }
    .nav-item.is-active {
      background: var(--raised);
      border-left-color: var(--accent);
      color: #fff;
    }
    .nav-ico { width: 16px; opacity: 0.8; }
    .statusbar span { display: inline-flex; align-items: center; gap: 6px; }
    .reviews-head > div { display: flex; flex-wrap: wrap; gap: 8px; }
    #links a { display: inline-flex; align-items: center; gap: 6px; }
    .sidebar-foot {
      margin-top: auto;
      border-top: 1px solid var(--line);
    }
    .stage {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background-color: var(--bg);
      background-image: radial-gradient(rgba(255,255,255,0.045) 1px, transparent 1px);
      background-size: 14px 14px;
    }
    .topbar {
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--line);
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .ws-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: #fff;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .ws-tabs {
      display: flex;
      gap: 2px;
      margin: 0 auto;
    }
    .ws-tabs a, .ws-tabs button {
      background: transparent;
      border: 0;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      color: var(--muted);
      padding: 10px 12px;
      font: 600 13px/16px "Hanken Grotesk", sans-serif;
      cursor: pointer;
      text-decoration: none;
    }
    .ws-tabs a:hover, .ws-tabs button:hover { color: #fff; background: transparent; }
    .ws-tabs a.is-active, .ws-tabs button.is-active {
      color: #fff;
      border-bottom-color: var(--accent);
    }
    .ws-tabs a.is-off { opacity: 0.45; pointer-events: none; }
    .ws-utils { display: flex; align-items: center; gap: 8px; }
    .stage-body {
      flex: 1;
      overflow: auto;
      padding: 20px 24px 28px;
    }
    .view { max-width: 1080px; }
    .display {
      margin: 0 0 4px;
      font: 600 18px/24px "Hanken Grotesk", sans-serif;
      color: #fff;
    }
    .statusbar {
      height: 22px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 12px;
      font: 11px/16px "JetBrains Mono", ui-monospace, monospace;
      background: var(--accent);
      color: var(--on-primary);
    }
    .statusbar span { white-space: nowrap; }
    .lede { color: var(--muted); margin: 0 0 12px; font-size: 13px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px 16px;
      margin-bottom: 12px;
    }
    .section-label {
      margin: 0 0 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--muted);
    }
    label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
    input[type="url"], input[type="text"], input[type="password"],
    textarea, select {
      width: 100%;
      background: var(--inset);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      padding: 8px 10px;
      font: 13px/20px "Hanken Grotesk", sans-serif;
      color-scheme: dark;
      accent-color: var(--accent);
    }
    input[type="url"], input[type="text"], input[type="password"],
    textarea#extra-instructions {
      font-family: "JetBrains Mono", ui-monospace, monospace;
    }
    select {
      width: auto;
      min-width: 9rem;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 14px) calc(50% - 2px),
        calc(100% - 9px) calc(50% - 2px);
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
      padding-right: 28px;
    }
    option, optgroup {
      background: var(--inset);
      color: var(--ink);
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    textarea#extra-instructions {
      width: 100%;
      min-height: 8rem;
      resize: vertical;
      background: var(--inset);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      color: var(--ink);
      padding: 8px 10px;
      font: 13px/20px "JetBrains Mono", ui-monospace, monospace;
    }
    .instr-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 0.45rem 0 0.75rem;
    }
    .agents { display: flex; flex-wrap: wrap; gap: 0.75rem 1.1rem; margin: 0.9rem 0 1.1rem; }
    .agents label { display: inline-flex; align-items: center; gap: 0.4rem; text-transform: none; letter-spacing: 0; font-size: 0.92rem; color: var(--ink); font-weight: 500; cursor: pointer; margin: 0; }
    .rule-toggles {
      margin: 0.85rem 0 0.35rem;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--inset);
    }
    .rule-toggles label {
      display: flex;
      align-items: flex-start;
      gap: 0.55rem;
      text-transform: none;
      letter-spacing: 0;
      font-size: 0.92rem;
      color: var(--ink);
      font-weight: 500;
      cursor: pointer;
      margin: 0;
    }
    .rule-toggles input { margin-top: 0.2rem; flex-shrink: 0; }
    .rule-toggles .hint { margin: 0.35rem 0 0 1.55rem; }
    button {
      border: 1px solid transparent;
      background: var(--accent);
      color: var(--on-primary);
      border-radius: var(--radius);
      padding: 6px 12px;
      font: 600 13px/20px "Hanken Grotesk", sans-serif;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.nav-item {
      background: transparent;
      color: var(--ink);
      border: 0;
      border-left: 2px solid transparent;
      border-radius: 0;
    }
    button.nav-item:hover { background: var(--raised); }
    button.nav-item.is-active {
      background: var(--raised);
      border-left-color: var(--accent);
      color: #fff;
    }
    .hint { color: var(--muted); font-size: 12px; line-height: 18px; margin-top: 8px; }
    #status { font-weight: 600; margin-bottom: 0.5rem; }
    #status.running { color: var(--warn); }
    #status.done { color: #9cdcfe; }
    #status.error { color: var(--bad); }
    #links a { color: var(--accent); margin-right: 1rem; }
    .agent-progress {
      display: grid;
      gap: 0.55rem;
      margin: 0.75rem 0 0.85rem;
    }
    .progress-shared {
      color: var(--muted);
      font-size: 0.82rem;
      margin: 0 0 0.15rem;
    }
    .progress-track {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 8px 12px;
      background: var(--surface);
      cursor: pointer;
      border-left: 2px solid #6e6e6e;
    }
    .progress-track:hover { background: var(--raised); }
    .progress-track.is-filter {
      background: var(--raised);
      border-left-width: 2px;
    }
    .progress-track.ag-cursor { border-left-color: var(--cursor); }
    .progress-track.ag-claude { border-left-color: var(--claude); }
    .progress-track.ag-command { border-left-color: var(--command); }
    .progress-track.ag-other { border-left-color: var(--ok); }
    .progress-top {
      display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
      gap: 0.35rem 0.75rem; margin-bottom: 0.35rem;
    }
    .progress-name { font-weight: 650; color: #fff; font-size: 0.92rem; }
    .progress-meta { color: var(--muted); font-size: 0.78rem; font-family: "JetBrains Mono", ui-monospace, monospace; }
    .bar {
      height: 8px;
      background: #2a2a2a;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid #3a3a3a;
    }
    .bar > span {
      display: block;
      height: 100%;
      width: 0%;
      border-radius: 999px;
      background: #6e6e6e;
      transition: width 0.35s ease;
    }
    .progress-track.ag-cursor .bar > span { background: var(--cursor); }
    .progress-track.ag-claude .bar > span { background: var(--claude); }
    .progress-track.ag-command .bar > span { background: var(--command); }
    .progress-track.ag-other .bar > span { background: #89d185; }
    .progress-track.is-done .bar > span { background: #3d7a45; }
    .progress-track.is-error .bar > span { background: var(--bad); }
    .pass-row {
      display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.45rem;
    }
    .pass-chip {
      font-size: 0.72rem;
      font-weight: 650;
      padding: 0.12rem 0.45rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #252526;
    }
    .pass-chip.pending { opacity: 0.7; }
    .pass-chip.running { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .pass-chip.done { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pass-chip.error { color: #f14c4c; border-color: #8b2e2e; background: #2a1818; }
    .progress-label { margin: 0.35rem 0 0; font-size: 0.8rem; color: var(--muted); }
    .progress-links { margin: 0.35rem 0 0; font-size: 0.8rem; }
    .progress-links a { color: var(--accent); display: inline-flex; align-items: center; gap: 4px; }
    .logs {
      margin: 8px 0 0;
      max-height: 22rem;
      overflow: auto;
      background: #0d0e0f;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 8px 10px;
      font: 12px/18px "JetBrains Mono", ui-monospace, monospace;
    }
    .log-line { white-space: pre-wrap; word-break: break-word; color: #9a9a9a; }
    .log-time { color: #6a6a6a; }
    .log-tag { font-weight: 700; }
    .log-line.ag-cursor { color: #b8e7ff; }
    .log-line.ag-cursor .log-tag { color: #4fc1ff; }
    .log-line.ag-claude { color: #f3d3b8; }
    .log-line.ag-claude .log-tag { color: #e8a87c; }
    .log-line.ag-command { color: #e2d2ff; }
    .log-line.ag-command .log-tag { color: #c9a0ff; }
    .log-line.ag-other { color: #c5e8c3; }
    .log-line.ag-other .log-tag { color: #89d185; }
    .log-filter-hint { color: var(--muted); font-size: 0.8rem; margin: 0.35rem 0 0; }
    ul.results { margin: 0.5rem 0 0; padding-left: 1.2rem; }
    ul.results .ok { color: #89d185; }
    ul.results .error { color: var(--bad); }
    ul.results .skipped { color: var(--muted); }
    #status.cancelled { color: var(--warn); }
    .job-meta {
      color: var(--muted);
      font-size: 0.88rem;
      margin: 0.35rem 0 0.75rem;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      word-break: break-all;
    }
    .job-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0 0.75rem; }
    button.danger {
      background: #5a1d1d;
      border-color: #8b2e2e;
      color: #f14c4c;
    }
    button.danger:hover { background: #6e2424; }
    button.btn-secondary {
      background: transparent;
      border-color: var(--line);
      color: var(--ink);
    }
    button.btn-secondary:hover { background: var(--raised); }
    #providers { color: var(--muted); font-size: 0.88rem; margin-bottom: 1rem; }
    .connect-head {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 0.75rem; margin-bottom: 0.85rem;
    }
    .view[hidden] { display: none !important; }
    .connect-head h2 { margin: 0; font-size: 13px; color: #fff; font-weight: 600; }
    .pill {
      display: inline-block; font-size: 0.75rem; font-weight: 600;
      padding: 0.15rem 0.5rem; border-radius: 999px; border: 1px solid var(--line);
    }
    .pill.ok { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pill.bad { color: #f14c4c; border-color: #8b2e2e; background: #2a1818; }
    .pill.warn { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .agent-grid { display: grid; gap: 0.75rem; }
    @media (min-width: 640px) { .agent-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); } }
    .agent-card {
      border: 1px solid var(--line); border-radius: var(--radius); padding: 0.85rem 0.9rem;
      background: var(--card); display: flex; flex-direction: column; gap: 0.45rem;
    }
    .agent-card.ready { border-color: #3d7a45; }
    .agent-card h3 { margin: 0; font-size: 0.95rem; color: #fff; }
    .agent-card p { margin: 0; font-size: 0.82rem; color: var(--muted); }
    .agent-card .cmd {
      font: 0.78rem "JetBrains Mono", ui-monospace, monospace;
      color: #9cdcfe;
    }
    .agent-card ol { margin: 0.25rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: 0.78rem; }
    .agent-card .row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem; }
    .agent-card a.btn-link {
      display: inline-block; font-size: 0.78rem; font-weight: 600;
      color: var(--accent); text-decoration: none; border: 1px solid var(--line);
      border-radius: 4px; padding: 0.25rem 0.5rem; background: #2d2d2d;
    }
    .agent-card a.btn-link:hover { border-color: var(--accent); }
    .agent-card button.btn-remove {
      display: inline-block; font-size: 0.78rem; font-weight: 600;
      color: #f14c4c; border: 1px solid #8b2e2e; background: #2a1818;
      border-radius: 4px; padding: 0.25rem 0.5rem;
    }
    .add-agent {
      margin: 0.9rem 0 0; border: 1px dashed var(--line); border-radius: var(--radius);
      padding: 0.65rem 0.85rem; background: var(--card);
    }
    .add-agent summary {
      cursor: pointer; color: #fff; font-weight: 600; font-size: 0.92rem;
    }
    .add-agent .fields {
      display: grid; gap: 0.55rem; margin-top: 0.75rem;
    }
    @media (min-width: 640px) {
      .add-agent .fields { grid-template-columns: 1fr 1fr; }
      .add-agent .fields .span-2 { grid-column: 1 / -1; }
    }
    .add-agent label { margin: 0; }
    .add-agent input[type="text"] { width: 100%; }
    .add-agent .field-hint {
      margin: 0.3rem 0 0; color: var(--muted); font-size: 0.8rem; font-weight: 400;
      line-height: 1.4;
    }
    .add-agent .check { display: flex; align-items: flex-start; gap: 0.45rem; font-size: 0.85rem; color: var(--ink); }
    #add-agent-msg { margin: 0.5rem 0 0; min-height: 1.1em; }
    #add-agent-msg.err { color: var(--bad); }
    #add-agent-msg.ok { color: #89d185; }
    #github-banner {
      margin: 0 0 0.65rem; padding: 0.65rem 0.75rem; border-radius: var(--radius);
      font-size: 0.88rem; border: 1px solid var(--line);
    }
    #github-banner.need { background: #2a1818; border-color: #8b2e2e; color: #f0c0c0; }
    #github-banner.ready { background: #1f2a1f; border-color: #3d7a45; color: #c5e8c3; }
    #github-banner.warn { background: #2a2818; border-color: #6e6a3a; color: var(--warn); }
    .github-fields { display: grid; gap: 0.5rem; margin-top: 0.55rem; }
    @media (min-width: 640px) {
      .github-fields { grid-template-columns: 1fr auto auto; align-items: end; }
    }
    #github-msg { margin: 0.45rem 0 0; min-height: 1.1em; }
    #github-msg.err { color: var(--bad); }
    #github-msg.ok { color: #89d185; }
    #connect-banner {
      margin: 0 0 0.75rem; padding: 0.65rem 0.75rem; border-radius: var(--radius);
      font-size: 0.88rem; border: 1px solid var(--line);
    }
    #connect-banner.need { background: #2a1818; border-color: #8b2e2e; color: #f0c0c0; }
    #connect-banner.ready { background: #1f2a1f; border-color: #3d7a45; color: #c5e8c3; }
    /* Only dim the Run button area — keep URL + instructions editable. */
    #form.is-blocked #submit { opacity: 0.55; }
    #form.is-blocked .agent-picks { opacity: 0.55; }
    .reviews-head {
      display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
      gap: 0.5rem; margin-bottom: 0.75rem;
    }
    .reviews-head h2 { margin: 0; font-size: 1.05rem; color: #fff; font-weight: 600; }
    .review-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.65rem; }
    .review-item {
      border: 1px solid var(--line); border-radius: var(--radius); padding: 0.8rem 0.9rem;
      background: var(--card); display: grid; gap: 0.45rem;
    }
    .review-item .top {
      display: flex; flex-wrap: wrap; gap: 0.45rem 0.75rem; align-items: center;
    }
    .review-item .title { color: #fff; font-weight: 600; margin: 0; font-size: 0.98rem; }
    .review-item .meta { color: var(--muted); font-size: 0.82rem; margin: 0; }
    .review-item .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    .review-item a.btn-link {
      display: inline-block; font-size: 0.78rem; font-weight: 600;
      color: var(--accent); text-decoration: none; border: 1px solid var(--line);
      border-radius: 4px; padding: 0.25rem 0.5rem; background: #2d2d2d;
    }
    .review-item a.btn-link:hover { border-color: var(--accent); }
    .review-item select {
      background: var(--inset);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 4px 28px 4px 8px;
      font-size: 12px;
      color-scheme: dark;
    }
    .pill.running { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .pill.needs_triage { color: #9cdcfe; border-color: #3a5a7a; background: #1a2430; }
    .pill.awaiting_author { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .pill.ready_to_verify { color: #c5a3ff; border-color: #5a3a7a; background: #221830; }
    .pill.verified { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pill.cleared { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pill.incomplete { color: var(--muted); }
    #reviews-empty { color: var(--muted); font-size: 0.9rem; margin: 0; }
    .review-table {
      width: 100%;
      border-collapse: collapse;
      font: 400 13px/20px "Hanken Grotesk", sans-serif;
    }
    .review-table th {
      text-align: left;
      font: 600 11px/16px "Hanken Grotesk", sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
    }
    .review-table td {
      padding: 8px 12px;
      min-height: 36px;
      height: auto;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    .review-table tr { cursor: pointer; }
    .review-table tr:hover td { background: var(--raised); }
    .review-table tr.is-selected td { background: var(--raised); }
    .review-table tr.is-warn td { color: var(--warn); }
    /* Never set display:flex on the <td> — that breaks table layout and stacks controls. */
    .review-table td.actions {
      width: 1%;
      white-space: nowrap;
    }
    .review-table .actions-inner {
      display: flex;
      flex-wrap: nowrap;
      gap: 6px;
      align-items: center;
    }
    .review-table .actions-inner a.btn-link {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 4px 8px;
      background: var(--inset);
      white-space: nowrap;
    }
    .review-table .actions-inner a.btn-link:hover { border-color: var(--accent); color: #fff; }
    .review-table .actions-inner select {
      max-width: 9.5rem;
      flex-shrink: 0;
    }
    .review-table .actions-inner .danger {
      padding: 4px 8px;
      font-size: 12px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .review-table .findings-cell { font-family: "Hanken Grotesk", sans-serif; font-size: 13px; }
    .review-table .findings-cell.is-block { color: var(--bad); font-weight: 600; }
    .status-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 99px;
      margin-right: 6px; background: var(--accent); vertical-align: middle;
    }
    .status-dot.verified, .status-dot.cleared { background: #6e6e6e; }
    .status-dot.awaiting_author, .status-dot.ready_to_verify { background: var(--warn); }
    .status-dot.running { background: var(--accent); }
    .dash-split {
      display: grid;
      grid-template-columns: 1fr 220px;
      gap: 12px;
      margin-top: 16px;
    }
    @media (max-width: 800px) { .dash-split { grid-template-columns: 1fr; } }
    .dash-box {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--card);
      padding: 16px;
      min-height: 88px;
    }
    .dash-box .section-label { margin: 0 0 10px; }
    .activity-empty {
      display: flex; align-items: center; gap: 10px;
      color: var(--muted); font-size: 13px; margin: 0;
    }
    .metric-row {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 8px 0; border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .metric-row:last-child { border-bottom: 0; }
    .metric-row .val { font-weight: 600; color: var(--accent); }
    .metric-row .val.bad { color: var(--bad); }
    .step {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 16px;
      background: var(--card);
    }
    .step details {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--inset);
      padding: 0 12px 8px;
    }
    .step details > summary {
      cursor: pointer;
      list-style: none;
      padding: 10px 0;
      color: #fff;
      font-weight: 600;
      font-size: 13px;
    }
    .step details > summary::-webkit-details-marker { display: none; }
    .step details > summary::after {
      content: "▾";
      float: right;
      color: var(--muted);
    }
    .step-head {
      display: flex; align-items: center; gap: 10px;
      margin: 0 0 12px; font-weight: 600; color: #fff;
    }
    .step-num {
      width: 22px; height: 22px; border-radius: 99px;
      background: var(--accent); color: var(--on-primary);
      font: 700 12px/22px "Hanken Grotesk", sans-serif;
      text-align: center;
    }
    .fetch-row { display: block; }
    .agent-picks {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }
    @media (max-width: 700px) { .agent-picks { grid-template-columns: 1fr; } }
    .agent-pick {
      display: grid; grid-template-columns: auto 1fr auto; gap: 8px;
      align-items: start; margin: 0; padding: 12px;
      border: 1px solid var(--line); border-radius: var(--radius);
      background: var(--card); cursor: pointer;
      text-transform: none; letter-spacing: 0; font-size: 13px;
      color: var(--ink); font-weight: 400;
    }
    .agent-pick.is-on {
      border-color: var(--accent);
      background: #152029;
    }
    .agent-pick.is-off { opacity: 0.55; cursor: default; }
    .agent-pick strong { display: block; color: #fff; font-size: 13px; }
    .agent-pick .pick-desc { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
    .agent-pick .setup-link {
      display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; color: var(--accent);
      font: 600 11px "Hanken Grotesk", sans-serif; padding: 0; cursor: pointer;
    }
    .agent-pick .setup-link:hover { background: none; text-decoration: underline; }
    .run-row { display: flex; justify-content: flex-end; margin-top: 8px; }
    .live-head {
      display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
      gap: 12px; margin-bottom: 12px;
    }
    .live-head h2 { margin: 0; font-size: 18px; color: #fff; }
    .factory {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px; margin: 8px 0 16px;
    }
    .factory-card {
      border: 1px solid var(--line); border-radius: var(--radius);
      background: var(--card); padding: 14px; cursor: pointer;
      border-top: 3px solid #6e6e6e;
    }
    .factory-card:hover { background: var(--raised); }
    .factory-card.ag-cursor { border-top-color: var(--cursor); }
    .factory-card.ag-claude { border-top-color: var(--claude); }
    .factory-card.ag-command { border-top-color: var(--command); }
    .factory-card.is-filter { outline: 1px solid var(--accent); }
    .factory-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .factory-name { font-weight: 700; color: #fff; letter-spacing: 0.04em; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
    .pass-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin: 10px 0; }
    .pass-stat {
      border: 1px solid var(--line); border-radius: var(--radius); padding: 6px;
      text-align: center; font-size: 11px; color: var(--muted);
    }
    .pass-stat b { display: block; color: #fff; font-size: 16px; }
    .factory-error {
      margin: 8px 0; padding: 8px; border-radius: var(--radius);
      background: #2a1818; border: 1px solid #8b2e2e; color: #ffdad6; font-size: 12px;
    }
    .factory-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .console-stream {
      border: 1px solid var(--line); border-radius: var(--radius); background: #0d0e0f;
    }
    .console-stream > summary {
      cursor: pointer; padding: 8px 12px; font-weight: 600; color: #fff;
    }
    .console-stream .logs { margin: 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; }
    ${sidebarChromeCss()}
    button.nav-item { justify-content: var(--sidebar-justify, flex-start); }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar hub-sidebar" id="hub-sidebar">
      <div class="brand-row">
        <div class="logo-mark">P</div>
        <div class="brand-copy">
          <div class="brand">PRism</div>
          <p class="brand-sub">Local Review Desk</p>
        </div>
        ${sidebarToggleButtonHtml()}
      </div>
      <nav>
        <button type="button" class="nav-item is-active" data-nav="inbox" title="Home" aria-label="Home">${iconTextHtml("home", "Home", "nav-label")}</button>
        <button type="button" class="nav-item" data-nav="run" title="New Review" aria-label="New Review">${iconTextHtml("plus", "New Review", "nav-label")}</button>
        <button type="button" class="nav-item" data-nav="settings" title="Settings" aria-label="Settings">${iconTextHtml("settings", "Settings", "nav-label")}</button>
      </nav>
      <div class="sidebar-foot">
        <button type="button" class="nav-item" data-nav="live" id="sidebar-status" title="Status" aria-label="Status">${iconTextHtml("activity", "Status", "nav-label")}</button>
      </div>
    </aside>
    <div class="stage">
      <header class="topbar">
        <p class="ws-title">${iconHtml("layers")} PRism Workspace</p>
        <nav class="ws-tabs" aria-label="Workspace">
          <button type="button" data-nav="live" id="tab-live" class="has-ico">${iconTextHtml("zap", "Live run")}</button>
          <a href="#" id="tab-triage" class="is-off has-ico">${iconTextHtml("list-checks", "Triage")}</a>
          <a href="#" id="tab-list" class="is-off has-ico">${iconTextHtml("list", "List")}</a>
          <a href="#" id="tab-verify" class="is-off has-ico">${iconTextHtml("shield-check", "Verify")}</a>
        </nav>
        <div class="ws-utils">
          <span class="pill warn" id="github-pill">${iconHtml("github")}<span class="pill-label">GitHub…</span></span>
          <span class="pill warn" id="connect-pill">${iconHtml("bot")}<span class="pill-label">Agents…</span></span>
        </div>
      </header>
      <div class="stage-body">

    <section class="view" data-view="inbox">
      <h2 class="display">${iconHtml("inbox")} Your reviews</h2>
      <p class="lede">Inbox of past reviews</p>
      <div class="card" id="reviews-card">
      <div class="reviews-head">
        <p class="section-label">${iconHtml("folder")} PRs on this machine</p>
        <div>
          <button type="button" id="btn-new-review" class="has-ico">${iconTextHtml("plus", "New review")}</button>
          <button type="button" class="btn-secondary has-ico" id="btn-refresh-reviews">${iconTextHtml("refresh", "Refresh")}</button>
        </div>
      </div>
      <p id="reviews-empty" hidden>No local reviews yet. Start a New review.</p>
      <table class="review-table" id="review-table" hidden>
        <thead>
          <tr><th>PR #</th><th>Title</th><th>Status</th><th>Findings</th><th>Actions</th></tr>
        </thead>
        <tbody id="review-list"></tbody>
      </table>
      </div>
      <div class="dash-split">
        <div class="dash-box" id="activity-box">
          <p class="section-label">${iconHtml("activity")} Activity context</p>
          <p class="activity-empty" id="activity-empty">Select a review row above to view dense analytics and activity streams</p>
          <div id="activity-detail" hidden></div>
        </div>
        <div class="dash-box">
          <p class="section-label">${iconHtml("layers")} Metrics</p>
          <div class="metric-row">${iconHtml("inbox")} Open findings <span class="val" id="metric-open">0</span></div>
          <div class="metric-row">${iconHtml("alert-triangle")} Pending blockers <span class="val bad" id="metric-blockers">0</span></div>
        </div>
      </div>
    </section>

    <section class="view" data-view="settings" hidden>
      <h2 class="display">${iconHtml("settings")} Settings</h2>
      <p class="lede">Setup only. GitHub is for private repos. Agents are CLIs already installed on this computer.</p>
    <section class="card" id="github-connect">
      <div class="connect-head">
        <h2>${iconHtml("github")} GitHub access</h2>
      </div>
      <p id="github-banner" class="need">Checking GitHub access…</p>
      <p class="hint">Public pull requests work with no login. Private repos need a token (saved in ~/.prsm, not git) or the GitHub CLI.</p>
      <form id="github-form" class="github-fields">
        <label>Personal access token
          <input id="github-token" type="password" name="token" autocomplete="off" placeholder="ghp_… or github_pat_…" />
        </label>
        <button type="submit" class="btn-secondary has-ico" id="btn-github-save">${iconTextHtml("save", "Save token")}</button>
        <button type="button" class="btn-secondary has-ico" id="btn-github-clear" hidden>${iconTextHtml("unplug", "Disconnect")}</button>
      </form>
      <p class="hint" style="margin:0.45rem 0 0">Create a token with repo read access:
        <a href="https://github.com/settings/tokens/new?description=PRism&amp;scopes=repo" target="_blank" rel="noopener">github.com/settings/tokens/new</a>
      </p>
      <p id="github-msg" class="hint"></p>
    </section>

    <section class="card" id="connect">
      <div class="connect-head">
        <h2>${iconHtml("bot")} AI agents</h2>
        <button type="button" class="btn-secondary has-ico" id="btn-recheck">${iconTextHtml("refresh", "Re-check")}</button>
      </div>
      <p id="connect-banner" class="need">Looking for local agent CLIs…</p>
      <div class="agent-grid" id="agent-grid"></div>
      <details class="add-agent" id="add-agent">
        <summary>${iconHtml("user-plus")} Add your own agent</summary>
        <p class="hint">For CLIs that are <strong>not</strong> already listed above (Cursor, Claude Code, Command Code are built-in). Install the product, then put the <em>terminal program name</em> here. Saved in ~/.prsm, not git.</p>
        <form id="add-agent-form" class="fields">
          <label>Name
            <input id="custom-name" type="text" name="name" placeholder="Codex" autocomplete="off" />
            <span class="field-hint">Label on cards. Example: Codex</span>
          </label>
          <label>Command
            <input id="custom-command" type="text" name="command" required placeholder="codex" autocomplete="off" />
            <span class="field-hint">The one word you type in a terminal after install. From that product’s docs (Codex → <code>codex</code>, Gemini CLI → <code>gemini</code>, Aider → <code>aider</code>). Check with <code>codex --version</code> or Windows <code>where.exe codex</code>.</span>
          </label>
          <label class="span-2">Extra flags (optional)
            <input id="custom-flags" type="text" name="extraFlags" placeholder="--output-format text --trust" autocomplete="off" />
            <span class="field-hint">Copy the <strong>non-interactive / print / CI</strong> flags from that CLI’s own docs so it prints an answer and exits (no TUI, no “trust this folder?” prompt). Leave blank if unsure. If a run hangs with an empty log, that’s usually a missing flag like <code>--trust</code>, <code>--yes</code>, or <code>--print</code>.</span>
          </label>
          <label class="check span-2">
            <input id="custom-dash-p" type="checkbox" checked />
            <span>Pass the prompt as <code>-p</code> (keep on for Codex / Gemini-style CLIs). Uncheck if the docs show the prompt as the last argument (Aider-style).</span>
          </label>
          <div class="span-2">
            <button type="submit" class="btn-secondary has-ico" id="btn-add-agent">${iconTextHtml("plus", "Add agent")}</button>
          </div>
        </form>
        <p id="add-agent-msg" class="hint"></p>
      </details>
      <p class="hint" style="margin-bottom:0">PRism talks to CLIs on this machine — no PRism cloud account. You need any one agent. More agents = more perspectives.</p>
    </section>
    </section>

    <section class="view" data-view="run" hidden>
    <h2 class="display">${iconHtml("plus")} New review setup wizard</h2>
    <p class="lede">Configure automated agents to review a specific pull request.</p>
    <form id="form">
      <div class="step">
        <p class="step-head">${iconHtml("link")}<span class="step-num">1</span> Repository context</p>
        <label for="pr">GitHub PR URL
          <input id="pr" name="pr" type="url" required placeholder="https://github.com/org/repo/pull/123" autocomplete="off" />
        </label>
        <p class="hint" style="margin:8px 0 0">Paste the URL and continue — the review job loads the PR when it starts. Private repos need Settings → Connect GitHub.</p>
      </div>
      <div class="step">
        <p class="step-head">${iconHtml("bot")}<span class="step-num">2</span> Select agents</p>
        <div class="agent-picks" id="agent-checks"></div>
      </div>
      <div class="step">
        <p class="step-head">${iconHtml("sliders")}<span class="step-num">3</span> Review options</p>
        <details>
          <summary>Review instructions (optional)</summary>
          <p class="hint" style="margin:8px 0">Editable. Sent to every agent on the next Run. Defaults are naming-in-context + hard-review lenses. Clear the box for built-in prompts only. Saved in this browser.</p>
          <textarea id="extra-instructions" name="extra-instructions" spellcheck="true" rows="12"></textarea>
          <div class="instr-toolbar">
            <button type="button" class="btn-secondary has-ico" id="btn-reset-instructions">${iconTextHtml("rotate-ccw", "Reset to default")}</button>
          </div>
        </details>
        <div class="rule-toggles" style="margin-top:12px">
          <label for="require-decisions-md">
            <input type="checkbox" id="require-decisions-md" />
            <span>Require design-decision <code>.md</code> output</span>
          </label>
          <p class="hint">Team rule (optional). When checked, missing/thin decisions <code>.md</code> is a <strong>blocker</strong>.</p>
        </div>
      </div>
      <div class="run-row">
        <button type="submit" id="submit" class="has-ico">${iconTextHtml("play", "Run Review")}</button>
      </div>
    </form>
    </section>

    <section class="view" data-view="live" hidden>
      <p class="lede" id="live-empty">No run in progress. Start a New Review, then watch agents here.</p>
    <section class="card" id="job-panel" hidden>
      <div class="live-head">
        <div>
          <h2 id="status">—</h2>
          <p class="lede" style="margin:4px 0 0">Real-time multi-agent factory status.</p>
          <p class="job-meta" id="job-meta"></p>
        </div>
        <div class="job-actions">
          <button type="button" class="danger has-ico" id="btn-stop" hidden>${iconTextHtml("square", "Force stop")}</button>
          <button type="button" class="btn-secondary has-ico" id="btn-restart" hidden>${iconTextHtml("rotate-cw", "Restart")}</button>
        </div>
      </div>
      <div id="links"></div>
      <div id="agent-progress" class="factory" hidden></div>
      <p id="log-filter-hint" class="log-filter-hint" hidden></p>
      <ul class="results" id="results"></ul>
      <details class="console-stream" open>
        <summary>${iconHtml("activity")} Multi-Agent Console Stream</summary>
        <div id="logs" class="logs"></div>
      </details>
    </section>
    </section>

      </div>
      <footer class="statusbar">
        <span id="statusbar-ok">${iconHtml("check")}<span class="bar-label">System Operational</span></span>
        <span id="statusbar-mid">${iconHtml("bot")}<span class="bar-label">localhost</span></span>
        <span id="statusbar-right">${iconHtml("zap")}<span class="bar-label">hub :${port}</span></span>
      </footer>
    </div>
  </div>
  <script>${sidebarToggleScript()}</script>
  <script>
(function () {
  var ICO = ${JSON.stringify(ICON_INNER)};
  function ico(name) {
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICO[name] || "") + "</svg>";
  }
  function setLabeled(el, text) {
    if (!el) return;
    var lab = el.querySelector(".btn-label, .pill-label, .bar-label, .nav-label");
    if (lab) lab.textContent = text;
    else el.textContent = text;
  }
  function fillIconLabel(el, iconName, text, labelClass) {
    if (!el) return;
    el.classList.add("has-ico");
    el.innerHTML = ico(iconName) + '<span class="' + (labelClass || "btn-label") + '"></span>';
    var span = el.querySelector("span");
    if (span) span.textContent = text;
  }

  const form = document.getElementById("form");
  const submit = document.getElementById("submit");
  const panel = document.getElementById("job-panel");
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("job-meta");
  const logsEl = document.getElementById("logs");
  const progressEl = document.getElementById("agent-progress");
  const logFilterHint = document.getElementById("log-filter-hint");
  const linksEl = document.getElementById("links");
  const resultsEl = document.getElementById("results");
  const providersEl = document.getElementById("providers");
  const stopBtn = document.getElementById("btn-stop");
  const restartBtn = document.getElementById("btn-restart");
  const agentGrid = document.getElementById("agent-grid");
  const agentChecks = document.getElementById("agent-checks");
  const addAgentForm = document.getElementById("add-agent-form");
  const addAgentMsg = document.getElementById("add-agent-msg");
  const connectPill = document.getElementById("connect-pill");
  const connectBanner = document.getElementById("connect-banner");
  const recheckBtn = document.getElementById("btn-recheck");
  const githubPill = document.getElementById("github-pill");
  const githubBanner = document.getElementById("github-banner");
  const githubForm = document.getElementById("github-form");
  const githubTokenEl = document.getElementById("github-token");
  const githubClearBtn = document.getElementById("btn-github-clear");
  const githubMsg = document.getElementById("github-msg");
  const instructionsEl = document.getElementById("extra-instructions");
  const resetInstrBtn = document.getElementById("btn-reset-instructions");
  const requireDecisionsEl = document.getElementById("require-decisions-md");
  const DEFAULT_EXTRA = ${JSON.stringify(DEFAULT_EXTRA_INSTRUCTIONS)};
  const INSTR_STORAGE_KEY = ${JSON.stringify(EXTRA_INSTRUCTIONS_STORAGE_KEY)};
  const REQUIRE_DECISIONS_STORAGE_KEY = ${JSON.stringify(REQUIRE_DECISIONS_MD_STORAGE_KEY)};
  let pollTimer = 0;
  let jobId = "";
  /** True while the attached Live job is queued/running — locks Run Review only then. */
  let jobIsActive = false;
  let lastPrRef = "";
  let lastAgents = [];
  let lastExtraInstructions = "";
  let lastRequireDecisionsMd = false;
  let readyIds = [];
  let logFilter = "";

  const VIEW_TITLES = {
    inbox: "home",
    run: "run",
    live: "live",
    settings: "settings",
  };
  let selectedPr = null;
  function syncWsTabs() {
    var n = selectedPr && selectedPr.prNumber;
    ["tab-triage", "tab-list", "tab-verify"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (!n) {
        el.href = "#";
        el.classList.add("is-off");
        return;
      }
      el.classList.remove("is-off");
      if (id === "tab-triage") el.href = "/pr/" + n + "/";
      if (id === "tab-list") el.href = "/pr/" + n + "/final-review.html";
      if (id === "tab-verify") el.href = "/pr/" + n + "/verify-report.html";
    });
  }
  function showView(name) {
    document.querySelectorAll("[data-view]").forEach(function (el) {
      el.hidden = el.getAttribute("data-view") !== name;
    });
    document.querySelectorAll(".sidebar .nav-item").forEach(function (el) {
      var nav = el.getAttribute("data-nav");
      el.classList.toggle("is-active", nav === name || (name === "inbox" && nav === "inbox"));
      if (nav === "live") el.classList.toggle("is-active", name === "live");
    });
    var liveTab = document.getElementById("tab-live");
    if (liveTab) liveTab.classList.toggle("is-active", name === "live");
    var hash = location.hash || "";
    if (hash.indexOf("#job=") !== 0) {
      var next = name === "inbox" ? "#home" : "#" + name;
      if (hash !== next) history.replaceState(null, "", next);
    }
  }
  document.querySelectorAll(".nav-item").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showView(btn.getAttribute("data-nav"));
    });
  });
  var btnNewReview = document.getElementById("btn-new-review");
  if (btnNewReview) {
    btnNewReview.addEventListener("click", function () { showView("run"); });
  }
  var liveTab = document.getElementById("tab-live");
  if (liveTab) {
    liveTab.addEventListener("click", function () { showView("live"); });
  }

  function agentClass(name) {
    var key = String(name || "").toLowerCase();
    if (key === "cursor") return "ag-cursor";
    if (key === "claude-code") return "ag-claude";
    if (key === "command-code") return "ag-command";
    return "ag-other";
  }

  function escapeLog(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function parseHubLogLine(line) {
    var m = String(line || "").match(/^\\[(\\d{2}:\\d{2}:\\d{2})\\]\\s*(?:\\[([^\\]]+)\\]\\s*)?([\\s\\S]*)$/);
    if (!m) return { time: "", agent: "", text: String(line || "") };
    return { time: m[1] || "", agent: m[2] || "", text: m[3] || "" };
  }

  function trackPercent(track) {
    if (!track) return 0;
    if (track.status === "done") return 100;
    if (track.status === "queued" || track.status === "skipped") return 0;
    var passes = Array.isArray(track.passes) ? track.passes : [];
    var total = Math.max(passes.length, 1);
    var score = 0;
    passes.forEach(function (pass) {
      if (pass.status === "done" || pass.status === "error") score += 1;
      else if (pass.status === "running") score += 0.45;
    });
    if (track.status === "running" && score === 0) return 8;
    var pct = Math.round((score / total) * 100);
    if (track.status === "error") return Math.min(99, Math.max(12, pct));
    return Math.min(99, pct);
  }

  function elapsedLabel(track) {
    var start = track && track.startedAt ? Date.parse(track.startedAt) : 0;
    if (!start) return "";
    var end = track.finishedAt ? Date.parse(track.finishedAt) : Date.now();
    var sec = Math.max(0, Math.round((end - start) / 1000));
    if (sec < 60) return sec + "s";
    return Math.floor(sec / 60) + "m" + String(sec % 60).padStart(2, "0") + "s";
  }

  function renderLogs(job) {
    var known = {};
    (job.agents || []).forEach(function (name) { known[name] = true; });
    var html = [];
    (job.logs || []).forEach(function (line) {
      var parsed = parseHubLogLine(line);
      var agent = known[parsed.agent] ? parsed.agent : "";
      if (logFilter && agent !== logFilter) return;
      var cls = "log-line" + (agent ? " " + agentClass(agent) : "");
      var tag = agent ? '<span class="log-tag">[' + escapeLog(agent) + ']</span> ' : "";
      html.push(
        '<div class="' + cls + '"><span class="log-time">' +
        escapeLog(parsed.time ? parsed.time : "") +
        "</span> " + tag + escapeLog(parsed.text) + "</div>"
      );
    });
    logsEl.innerHTML = html.join("") || '<div class="log-line">Waiting for output…</div>';
    logsEl.scrollTop = logsEl.scrollHeight;
    if (logFilterHint) {
      logFilterHint.hidden = !logFilter;
      logFilterHint.textContent = logFilter
        ? "Showing " + logFilter + " logs only — click the card again for everyone. Use “This agent’s findings” for that agent’s triage."
        : "";
    }
  }

  function agentRunLinks(job, agent) {
    if (!job.prNumber) return "";
    var runId = "";
    (job.results || []).forEach(function (r) {
      if (r.agent !== agent || r.status !== "ok") return;
      if (r.runId) {
        runId = r.runId;
        return;
      }
      if (typeof r.detail === "string" && r.detail.indexOf("runs/") === 0) {
        runId = r.detail.slice("runs/".length).split("/")[0];
      }
    });
    if (!runId) return "";
    var base = "/pr/" + job.prNumber + "/runs/" + encodeURIComponent(runId);
    return (
      '<span class="progress-links">' +
        '<a href="' + base + '/triage.html">' + ico("list-checks") + " View findings</a>" +
      "</span>"
    );
  }

  function renderProgress(job) {
    if (!progressEl) return;
    var tracks = job.progress && Array.isArray(job.progress.agents) ? job.progress.agents : [];
    if (!tracks.length) {
      progressEl.hidden = true;
      progressEl.innerHTML = "";
      return;
    }
    progressEl.hidden = false;
    var shared = job.progress && job.progress.sharedLabel
      ? '<p class="progress-shared">' + escapeLog(job.progress.sharedLabel) + "</p>"
      : "";
    progressEl.innerHTML = tracks.map(function (track) {
      var pct = trackPercent(track);
      var result = (job.results || []).find(function (r) { return r.agent === track.agent; });
      var passHtml = (track.passes || []).map(function (pass) {
        var label = pass.id === "devils-advocate" ? "Devil's Adv." : pass.id;
        var n = pass.findings != null ? pass.findings : "—";
        return '<div class="pass-stat">' + escapeLog(label) + "<b>" + n + "</b></div>";
      }).join("");
      var cls = "factory-card " + agentClass(track.agent);
      if (track.status === "done") cls += " is-done";
      if (track.status === "error") cls += " is-error";
      if (logFilter === track.agent) cls += " is-filter";
      var badge = track.status === "error"
        ? '<span class="pill bad">' + ico("x-circle") + '<span class="pill-label">Failed</span></span>'
        : track.status === "done"
          ? '<span class="pill ok">' + ico("check") + '<span class="pill-label">Done</span></span>'
          : '<span class="pill running">' + ico("activity") + '<span class="pill-label">' + pct + "%</span></span>";
      var err = "";
      if (track.status === "error" && result && result.detail) {
        err = '<p class="factory-error">' + escapeLog(result.detail) + "</p>";
      }
      var links = agentRunLinks(job, track.agent);
      var foot = track.status === "running"
        ? "Running…"
        : track.label || track.status;
      return (
        '<article class="' + cls + '" data-agent="' + escapeLog(track.agent) + '">' +
          '<div class="factory-top"><span class="factory-name">' + ico("bot") + " " + escapeLog(String(track.agent).toUpperCase()) + "</span>" + badge + "</div>" +
          '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
          (track.status === "error" ? err : '<div class="pass-stats">' + passHtml + "</div>") +
          '<div class="factory-foot"><span>' + escapeLog(foot) + "</span>" + (links || "") + "</div>" +
        "</article>"
      );
    }).join("");
    progressEl.querySelectorAll(".factory-card").forEach(function (node) {
      node.querySelectorAll("a").forEach(function (link) {
        link.addEventListener("click", function (ev) {
          ev.stopPropagation();
        });
      });
      node.addEventListener("click", function () {
        var name = node.getAttribute("data-agent") || "";
        logFilter = logFilter === name ? "" : name;
        renderProgress(job);
        renderLogs(job);
      });
    });
  }

  function loadInstructions() {
    if (!(instructionsEl instanceof HTMLTextAreaElement)) return;
    try {
      var saved = localStorage.getItem(INSTR_STORAGE_KEY);
      instructionsEl.value = saved != null ? saved : DEFAULT_EXTRA;
    } catch (e) {
      instructionsEl.value = DEFAULT_EXTRA;
    }
  }

  function loadRequireDecisionsMd() {
    if (!(requireDecisionsEl instanceof HTMLInputElement)) return;
    try {
      requireDecisionsEl.checked = localStorage.getItem(REQUIRE_DECISIONS_STORAGE_KEY) === "1";
    } catch (e) {
      requireDecisionsEl.checked = false;
    }
  }

  function saveRequireDecisionsMd() {
    if (!(requireDecisionsEl instanceof HTMLInputElement)) return;
    try {
      localStorage.setItem(
        REQUIRE_DECISIONS_STORAGE_KEY,
        requireDecisionsEl.checked ? "1" : "0",
      );
    } catch (e) { /* ignore */ }
  }

  function requireDecisionsMdEnabled() {
    return requireDecisionsEl instanceof HTMLInputElement && requireDecisionsEl.checked;
  }

  function saveInstructions() {
    if (!(instructionsEl instanceof HTMLTextAreaElement)) return;
    try {
      localStorage.setItem(INSTR_STORAGE_KEY, instructionsEl.value);
    } catch (e) { /* ignore */ }
  }

  function currentInstructions() {
    return instructionsEl instanceof HTMLTextAreaElement
      ? instructionsEl.value
      : DEFAULT_EXTRA;
  }

  /** Base instructions only — team rule flags are separate API fields. */
  function instructionsForRun() {
    return currentInstructions().trim();
  }

  function syncSubmitEnabled(blockedMessage) {
    const noAgents = form.classList.contains("is-blocked");
    submit.disabled = noAgents || jobIsActive;
    if (noAgents) {
      setLabeled(submit, blockedMessage || "Connect an agent first");
    } else if (jobIsActive) {
      setLabeled(submit, "Running…");
    } else {
      setLabeled(submit, "Run Review");
    }
  }

  function setFormBlocked(blocked, message) {
    form.classList.toggle("is-blocked", Boolean(blocked));
    // Do not key off pollTimer — that left Run Review stuck disabled after a finished job.
    syncSubmitEnabled(message);
  }

  function renderConnect(body) {
    const agents = Array.isArray(body.agents) ? body.agents : [];
    readyIds = Array.isArray(body.readyIds) ? body.readyIds.slice() : [];
    const readyCount = Number(body.readyCount || readyIds.length || 0);

    if (connectPill) {
      setLabeled(connectPill, readyCount
        ? (readyCount + " agent" + (readyCount === 1 ? "" : "s") + " ready")
        : "No agents found");
      connectPill.className = "pill " + (readyCount ? "ok" : "bad");
    }
    if (connectBanner) {
      connectBanner.className = readyCount ? "ready" : "need";
      connectBanner.textContent = readyCount
        ? "Ready. Start a New review and pick which agents to run."
        : "No local agent CLI found yet. Install one below, finish login, then Re-check.";
    }

    if (agentGrid) {
      agentGrid.innerHTML = "";
      agents.forEach(function (agent) {
        const card = document.createElement("article");
        card.className = "agent-card" + (agent.available ? " ready" : "");
        const title = document.createElement("h3");
        title.textContent = agent.name;
        const status = document.createElement("span");
        status.className = "pill " + (agent.available ? "ok" : "bad");
        status.textContent = agent.available ? "Detected" : "Not found";
        title.appendChild(document.createTextNode(" "));
        title.appendChild(status);
        const summary = document.createElement("p");
        summary.textContent = agent.summary || "";
        const cmd = document.createElement("div");
        cmd.className = "cmd";
        cmd.textContent = "CLI: " + agent.command;
        card.appendChild(title);
        card.appendChild(summary);
        card.appendChild(cmd);
        if (!agent.available && Array.isArray(agent.setupSteps)) {
          const ol = document.createElement("ol");
          agent.setupSteps.forEach(function (step) {
            const li = document.createElement("li");
            li.textContent = step;
            ol.appendChild(li);
          });
          card.appendChild(ol);
        } else if (agent.available && agent.loginHint) {
          const tip = document.createElement("p");
          tip.textContent = "If runs fail auth: " + agent.loginHint;
          card.appendChild(tip);
        }
        const row = document.createElement("div");
        row.className = "row";
        if (agent.installUrl) {
          const a = document.createElement("a");
          a.className = "btn-link has-ico";
          a.href = agent.installUrl;
          a.target = "_blank";
          a.rel = "noopener";
          fillIconLabel(a, "external-link", agent.available ? "Docs" : "Install guide");
          row.appendChild(a);
        }
        if (agent.custom) {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "btn-remove has-ico";
          fillIconLabel(rm, "trash", "Remove");
          rm.addEventListener("click", function () {
            removeCustom(agent.id, agent.name);
          });
          row.appendChild(rm);
        }
        card.appendChild(row);
        agentGrid.appendChild(card);
      });
    }

    if (agentChecks) {
      agentChecks.innerHTML = "";
      agents.forEach(function (agent) {
        const label = document.createElement("label");
        label.className = "agent-pick" + (agent.available ? " is-on" : " is-off");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.name = "agent";
        box.value = agent.id;
        box.checked = Boolean(agent.available);
        box.disabled = !agent.available;
        box.addEventListener("change", function () {
          label.classList.toggle("is-on", box.checked);
        });
        const body = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = agent.name || agent.id;
        const desc = document.createElement("p");
        desc.className = "pick-desc";
        desc.textContent = agent.summary || ("CLI: " + agent.command);
        body.appendChild(strong);
        body.appendChild(desc);
        if (!agent.available) {
          const setup = document.createElement("button");
          setup.type = "button";
          setup.className = "setup-link has-ico";
          fillIconLabel(setup, "settings", "Setup in Settings");
          setup.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            showView("settings");
          });
          body.appendChild(setup);
        }
        const badge = document.createElement("span");
        badge.className = "pill " + (agent.available ? "ok" : "bad");
        badge.textContent = agent.available ? "Ready" : "Not Configured";
        label.appendChild(box);
        label.appendChild(body);
        label.appendChild(badge);
        agentChecks.appendChild(label);
      });
    }

    setFormBlocked(readyCount === 0);
    var mid = document.getElementById("statusbar-mid");
    if (mid) {
      setLabeled(mid, readyCount
        ? readyCount + " agent" + (readyCount === 1 ? "" : "s") + " ready"
        : "connect an agent in Settings");
    }
    var okBar = document.getElementById("statusbar-ok");
    if (okBar) {
      setLabeled(okBar, readyCount ? "System Operational" : "Needs an agent");
    }
  }

  async function loadProviders() {
    try {
      const res = await fetch("/api/providers");
      const body = await res.json();
      renderConnect(body);
    } catch (e) {
      if (connectBanner) {
        connectBanner.className = "need";
        connectBanner.textContent = "Could not check agents. Is serve-ui still running?";
      }
      setFormBlocked(true, "Agents unavailable");
    }
  }

  function setGithubMsg(text, ok) {
    if (!githubMsg) return;
    githubMsg.textContent = text || "";
    githubMsg.className = "hint " + (text ? (ok ? "ok" : "err") : "");
  }

  function renderGithub(body) {
    const source = body && body.source ? String(body.source) : "anonymous";
    const ok = Boolean(body && body.ok);
    const login = body && body.login ? String(body.login) : "";
    const detail = body && body.detail ? String(body.detail) : "";
    const connected = ok && source !== "anonymous";
    if (githubPill) {
      setLabeled(githubPill, connected
        ? (login ? "@" + login : "Connected")
        : source === "anonymous"
          ? "Public PRs"
          : "Needs token");
      githubPill.className = "pill " + (ok ? (connected ? "ok" : "warn") : "bad");
    }
    if (githubBanner) {
      githubBanner.className = ok ? (connected ? "ready" : "warn") : "need";
      githubBanner.textContent = detail || "Checking GitHub access…";
    }
    if (githubClearBtn) githubClearBtn.hidden = source !== "file";
  }

  async function loadGithub() {
    try {
      const res = await fetch("/api/github");
      const body = await res.json();
      renderGithub(body);
    } catch (e) {
      renderGithub({
        ok: false,
        source: "anonymous",
        detail: "Could not check GitHub status.",
      });
    }
  }

  function setAddMsg(text, ok) {
    if (!addAgentMsg) return;
    addAgentMsg.textContent = text || "";
    addAgentMsg.className = "hint " + (text ? (ok ? "ok" : "err") : "");
  }

  async function removeCustom(id, name) {
    if (!window.confirm("Remove “" + name + "” from this machine?")) return;
    try {
      const res = await fetch("/api/custom-agents/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      const body = await res.json();
      if (!res.ok) {
        setAddMsg(body.error || "Could not remove agent", false);
        return;
      }
      setAddMsg("Removed " + name, true);
      renderConnect(body);
    } catch (e) {
      setAddMsg("Could not remove agent", false);
    }
  }

  if (githubForm) {
    githubForm.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      const token = githubTokenEl instanceof HTMLInputElement
        ? githubTokenEl.value.trim()
        : "";
      if (!token) {
        setGithubMsg("Paste a GitHub token first", false);
        return;
      }
      try {
        const res = await fetch("/api/github", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: token }),
        });
        const body = await res.json();
        if (!res.ok) {
          setGithubMsg(body.error || "Could not save token", false);
          return;
        }
        if (githubTokenEl instanceof HTMLInputElement) githubTokenEl.value = "";
        setGithubMsg("Saved. Private PRs on this machine can use this token.", true);
        renderGithub(body);
      } catch (e) {
        setGithubMsg("Could not save token", false);
      }
    });
  }
  if (githubClearBtn) {
    githubClearBtn.addEventListener("click", async function () {
      try {
        const res = await fetch("/api/github", { method: "DELETE" });
        const body = await res.json();
        setGithubMsg("Token removed from this machine.", true);
        renderGithub(body);
      } catch (e) {
        setGithubMsg("Could not disconnect", false);
      }
    });
  }

  if (addAgentForm) {
    addAgentForm.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      const nameEl = document.getElementById("custom-name");
      const cmdEl = document.getElementById("custom-command");
      const flagsEl = document.getElementById("custom-flags");
      const dashEl = document.getElementById("custom-dash-p");
      const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : "";
      const command = cmdEl instanceof HTMLInputElement ? cmdEl.value.trim() : "";
      const extraFlags = flagsEl instanceof HTMLInputElement ? flagsEl.value.trim() : "";
      const dashP = dashEl instanceof HTMLInputElement ? dashEl.checked : true;
      if (!command) {
        setAddMsg("Command is required", false);
        return;
      }
      try {
        const res = await fetch("/api/custom-agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: name || command,
            command: command,
            extraFlags: extraFlags,
            promptStyle: dashP ? "dash-p" : "trailing",
          }),
        });
        const body = await res.json();
        if (!res.ok) {
          setAddMsg(body.error || "Could not add agent", false);
          return;
        }
        setAddMsg((body.agent && body.agent.name ? body.agent.name : command) + " saved. Tick it below if Detected.", true);
        if (cmdEl instanceof HTMLInputElement) cmdEl.value = "";
        if (nameEl instanceof HTMLInputElement) nameEl.value = "";
        if (flagsEl instanceof HTMLInputElement) flagsEl.value = "";
        renderConnect(body);
      } catch (e) {
        setAddMsg("Could not add agent", false);
      }
    });
  }

  function selectedAgents() {
    return Array.from(document.querySelectorAll('input[name="agent"]:checked'))
      .map(function (el) { return el instanceof HTMLInputElement ? el.value : ""; })
      .filter(Boolean);
  }

  function startPolling(id) {
    jobId = id;
    var liveEmpty = document.getElementById("live-empty");
    if (liveEmpty) liveEmpty.hidden = true;
    showView("live");
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(poll, 1000);
    poll();
  }

  function renderJob(job) {
    panel.hidden = false;
    var liveEmpty = document.getElementById("live-empty");
    if (liveEmpty) liveEmpty.hidden = true;
    statusEl.className = job.status;
    var errAgents = (job.results || []).filter(function (r) { return r.status === "error"; }).length;
    var okAgents = (job.results || []).filter(function (r) { return r.status === "ok"; }).length;
    var title = job.prNumber ? ("PR #" + job.prNumber) : "Live run";
    if (job.prRef && String(job.prRef).indexOf("http") !== 0) title += ": " + job.prRef;
    var pillClass = job.status === "error" ? "bad" : job.status === "done" ? "ok" : "running";
    var pillText = job.status === "done" && errAgents > 0 && okAgents > 0
      ? "Partial"
      : job.status;
    statusEl.innerHTML = escapeLog(title) + ' <span class="pill ' + pillClass + '">' + escapeLog(pillText) + "</span>";
    if (job.prNumber) {
      selectedPr = { prNumber: job.prNumber, href: "/pr/" + job.prNumber + "/", listHref: "/pr/" + job.prNumber + "/final-review.html", verifyHref: "/pr/" + job.prNumber + "/verify-report.html" };
      syncWsTabs();
    }
    var meta = "Job " + job.id;
    if (job.agents && job.agents.length) meta += " · agents: " + job.agents.join(", ");
    if (job.requireDecisionsMd) meta += " · design-decision MD required";
    if (job.outputDir) meta += "\\nOutput: " + job.outputDir;
    else if (job.prNumber) meta += "\\nOutput: reviews/" + job.prNumber + "/";
    meta += "\\nWatch: http://127.0.0.1:" + location.port + "/#job=" + job.id;
    metaEl.textContent = meta;

    var active = job.status === "queued" || job.status === "running";
    stopBtn.hidden = !active;
    stopBtn.disabled = false;
    setLabeled(stopBtn, "Force stop");
    restartBtn.hidden = false;
    restartBtn.disabled = false;
    setLabeled(restartBtn, active ? "Force stop & restart" : "Restart");
    if (job.prRef) lastPrRef = job.prRef;
    if (job.agents && job.agents.length) lastAgents = job.agents.slice();
    if (typeof job.extraInstructions === "string") {
      lastExtraInstructions = job.extraInstructions;
      // Don't overwrite the editable box with server-merged rule text.
    }
    if (typeof job.requireDecisionsMd === "boolean") {
      lastRequireDecisionsMd = job.requireDecisionsMd;
      if (requireDecisionsEl instanceof HTMLInputElement && !active) {
        requireDecisionsEl.checked = job.requireDecisionsMd;
      }
    }

    // Instructions stay editable for the next run; only Run Review is locked while a job runs.
    if (requireDecisionsEl) requireDecisionsEl.disabled = active;
    jobIsActive = active;
    syncSubmitEnabled();

    renderProgress(job);
    renderLogs(job);

    resultsEl.innerHTML = "";
    (job.results || []).forEach(function (r) {
      const li = document.createElement("li");
      li.className = r.status;
      li.textContent = r.agent + ": " + r.status + " — " + r.detail +
        (r.rawFindingCount != null ? " (" + r.rawFindingCount + " raw)" : "");
      resultsEl.appendChild(li);
    });

    linksEl.innerHTML = "";
    var mergedReady = job.prNumber && (
      job.mergedFindingCount != null ||
      (job.results || []).some(function (r) { return r.status === "ok"; })
    );
    if (mergedReady) {
      const triage = document.createElement("a");
      triage.href = "/pr/" + job.prNumber + "/";
      fillIconLabel(triage, "list-checks", active
        ? "Open triage now (partial merge) · /pr/" + job.prNumber + "/"
        : "Open triage · /pr/" + job.prNumber + "/");
      const list = document.createElement("a");
      list.href = "/pr/" + job.prNumber + "/final-review.html";
      fillIconLabel(list, "list", "Open list");
      linksEl.appendChild(triage);
      linksEl.appendChild(list);
      if (active && okAgents > 0 && okAgents < (job.agents || []).length) {
        const note = document.createElement("p");
        note.className = "hint";
        note.style.margin = "0.45rem 0 0";
        note.textContent =
          okAgents + "/" + job.agents.length +
          " agent(s) merged so far (" + (job.mergedFindingCount != null ? job.mergedFindingCount + " cards" : "see triage") +
          "). You can start triaging — later agents add views onto the same cards when they find the same issue, rather than duplicating.";
        linksEl.appendChild(note);
      }
      loadReviews();
    }
    if (job.error) {
      const err = document.createElement("p");
      err.style.color = "var(--bad)";
      err.textContent = job.error;
      linksEl.appendChild(err);
    }
  }

  async function poll() {
    if (!jobId) return;
    try {
      const res = await fetch("/api/jobs/" + jobId);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || ("HTTP " + res.status));
      renderJob(job);
      if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
        window.clearInterval(pollTimer);
        pollTimer = 0;
        jobIsActive = false;
        syncSubmitEnabled();
      }
    } catch (e) {
      statusEl.className = "error";
      statusEl.textContent = e && e.message ? e.message : "Poll failed";
    }
  }

  async function attachActive() {
    try {
      const res = await fetch("/api/active");
      const body = await res.json();
      if (body && body.job && body.job.id) {
        startPolling(body.job.id);
      } else {
        var hash = (location.hash || "").replace(/^#job=/, "");
        if (hash) startPolling(hash);
      }
    } catch (e) { /* ignore */ }
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const pr = document.getElementById("pr");
    if (!(pr instanceof HTMLInputElement)) return;
    const agents = selectedAgents();
    if (!agents.length) {
      alert("Pick at least one available agent.");
      return;
    }
    submit.disabled = true;
    setLabeled(submit, "Starting…");
    if (requireDecisionsEl) requireDecisionsEl.disabled = true;
    panel.hidden = false;
    statusEl.className = "running";
    statusEl.textContent = "QUEUED";
    metaEl.textContent = "";
    logsEl.textContent = "";
    resultsEl.innerHTML = "";
    linksEl.innerHTML = "";

    const extraInstructions = instructionsForRun();
    const requireDecisionsMd = requireDecisionsMdEnabled();
    saveInstructions();
    saveRequireDecisionsMd();
    lastExtraInstructions = extraInstructions;
    lastRequireDecisionsMd = requireDecisionsMd;
    lastPrRef = pr.value.trim();
    lastAgents = agents.slice();

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prRef: pr.value.trim(),
          agents: agents,
          extraInstructions: extraInstructions,
          requireDecisionsMd: requireDecisionsMd,
        }),
      });
      const body = await res.json();
      if (res.status === 409 && body.jobId) {
        statusEl.className = "running";
        statusEl.textContent = "ALREADY RUNNING — attaching to that job";
        metaEl.textContent = "Job " + body.jobId + (body.prRef ? (" · " + body.prRef) : "");
        startPolling(body.jobId);
        return;
      }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      startPolling(body.jobId);
    } catch (e) {
      jobIsActive = false;
      syncSubmitEnabled();
      if (requireDecisionsEl) requireDecisionsEl.disabled = false;
      statusEl.className = "error";
      statusEl.textContent = e && e.message ? e.message : "Start failed";
    }
  });

  async function forceStop() {
    if (!jobId) return;
    stopBtn.disabled = true;
    restartBtn.disabled = true;
    setLabeled(stopBtn, "Stopping…");
    const res = await fetch("/api/jobs/" + jobId + "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    await poll();
  }

  stopBtn.addEventListener("click", async function () {
    try {
      await forceStop();
    } catch (e) {
      stopBtn.disabled = false;
      alert(e && e.message ? e.message : "Stop failed");
    }
  });

  restartBtn.addEventListener("click", async function () {
    try {
      const prInput = document.getElementById("pr");
      const prRef = lastPrRef || (prInput instanceof HTMLInputElement ? prInput.value.trim() : "");
      const agents = lastAgents.length ? lastAgents : selectedAgents();
      if (!prRef) {
        alert("No PR URL to restart.");
        return;
      }
      if (jobId) {
        try { await forceStop(); } catch (e) { /* continue restart */ }
      }
      submit.disabled = true;
      setLabeled(submit, "Restarting…");
      if (requireDecisionsEl) requireDecisionsEl.disabled = true;
      const extraInstructions =
        instructionsForRun() || lastExtraInstructions || DEFAULT_EXTRA;
      const requireDecisionsMd =
        requireDecisionsMdEnabled() || lastRequireDecisionsMd;
      saveInstructions();
      saveRequireDecisionsMd();
      lastExtraInstructions = extraInstructions;
      lastRequireDecisionsMd = requireDecisionsMd;
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prRef: prRef,
          agents: agents,
          extraInstructions: extraInstructions,
          requireDecisionsMd: requireDecisionsMd,
        }),
      });
      const body = await res.json();
      if (res.status === 409 && body.jobId) {
        startPolling(body.jobId);
        return;
      }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      if (prInput instanceof HTMLInputElement) prInput.value = prRef;
      startPolling(body.jobId);
    } catch (e) {
      jobIsActive = false;
      syncSubmitEnabled();
      if (requireDecisionsEl) requireDecisionsEl.disabled = false;
      alert(e && e.message ? e.message : "Restart failed");
    }
  });

  if (recheckBtn) {
    recheckBtn.addEventListener("click", function () {
      recheckBtn.disabled = true;
      setLabeled(recheckBtn, "Checking…");
      loadProviders().finally(function () {
        recheckBtn.disabled = false;
        setLabeled(recheckBtn, "Re-check");
      });
    });
  }

  async function loadReviews() {
    const listEl = document.getElementById("review-list");
    const emptyEl = document.getElementById("reviews-empty");
    const tableEl = document.getElementById("review-table");
    if (!listEl) return;
    try {
      const res = await fetch("/api/reviews");
      const body = await res.json();
      const reviews = Array.isArray(body.reviews) ? body.reviews : [];
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.hidden = reviews.length > 0;
      if (tableEl) tableEl.hidden = reviews.length === 0;
      var openSum = 0;
      var blockSum = 0;
      reviews.forEach(function (r) {
        openSum += Number(r.openFindings || 0);
        blockSum += Number(r.blockers || 0);
        const tr = document.createElement("tr");
        if (r.blockers) tr.className = "is-warn";
        if (selectedPr && selectedPr.prNumber === r.prNumber) tr.classList.add("is-selected");

        function td(text, cls) {
          const cell = document.createElement("td");
          if (cls) cell.className = cls;
          cell.textContent = text;
          return cell;
        }
        tr.appendChild(td("#" + r.prNumber, "pr-num"));
        tr.appendChild(td(r.title || "(untitled)"));
        const statusTd = document.createElement("td");
        const dot = document.createElement("span");
        dot.className = "status-dot " + r.status;
        statusTd.appendChild(dot);
        statusTd.appendChild(document.createTextNode(r.statusLabel || r.status));
        tr.appendChild(statusTd);
        const findTd = document.createElement("td");
        findTd.className = "findings-cell" + (r.blockers ? " is-block" : "");
        findTd.textContent = r.blockers
          ? r.blockers + " Blocker" + (r.blockers === 1 ? "" : "s")
          : r.openFindings
            ? r.openFindings + " Findings"
            : "0 Open";
        tr.appendChild(findTd);

        const actions = document.createElement("td");
        actions.className = "actions";
        const actionsInner = document.createElement("div");
        actionsInner.className = "actions-inner";
        const open = document.createElement("a");
        open.className = "btn-link has-ico";
        open.href = r.href || ("/pr/" + r.prNumber + "/");
        fillIconLabel(open, "list-checks", "Triage");
        const list = document.createElement("a");
        list.className = "btn-link has-ico";
        list.href = r.listHref || ("/pr/" + r.prNumber + "/final-review.html");
        fillIconLabel(list, "list", "List");
        actionsInner.appendChild(open);
        actionsInner.appendChild(list);
        const statusSel = document.createElement("select");
        statusSel.setAttribute("aria-label", "Mark status for PR " + r.prNumber);
        [
          ["", "Auto status"],
          ["needs_triage", "Needs triage"],
          ["awaiting_author", "Awaiting author"],
          ["ready_to_verify", "Ready to verify"],
        ].forEach(function (pair) {
          const opt = document.createElement("option");
          opt.value = pair[0];
          opt.textContent = pair[1];
          if (
            (pair[0] === "" &&
              ["awaiting_author", "ready_to_verify"].indexOf(r.status) === -1) ||
            pair[0] === r.status
          ) {
            opt.selected = true;
          }
          statusSel.appendChild(opt);
        });
        statusSel.addEventListener("change", async function () {
          try {
            const res2 = await fetch("/api/reviews/" + r.prNumber, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: statusSel.value || null }),
            });
            const body2 = await res2.json();
            if (!res2.ok) throw new Error(body2.error || ("HTTP " + res2.status));
            loadReviews();
          } catch (e) {
            alert(e && e.message ? e.message : "Could not update status");
          }
        });
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "danger has-ico";
        fillIconLabel(removeBtn, "trash", "Remove");
        removeBtn.addEventListener("click", async function (ev) {
          ev.stopPropagation();
          if (!confirm("Remove local review for PR #" + r.prNumber + "? This deletes reviews/" + r.prNumber + "/")) {
            return;
          }
          try {
            const res2 = await fetch("/api/reviews/" + r.prNumber, { method: "DELETE" });
            const body2 = await res2.json();
            if (!res2.ok) throw new Error(body2.error || ("HTTP " + res2.status));
            if (selectedPr && selectedPr.prNumber === r.prNumber) selectedPr = null;
            syncWsTabs();
            loadReviews();
          } catch (e) {
            alert(e && e.message ? e.message : "Remove failed");
          }
        });
        actionsInner.appendChild(statusSel);
        actionsInner.appendChild(removeBtn);
        actions.appendChild(actionsInner);
        actions.addEventListener("click", function (ev) { ev.stopPropagation(); });
        tr.appendChild(actions);
        tr.addEventListener("click", function () {
          selectedPr = r;
          syncWsTabs();
          var empty = document.getElementById("activity-empty");
          var detail = document.getElementById("activity-detail");
          if (empty) empty.hidden = true;
          if (detail) {
            detail.hidden = false;
            detail.innerHTML =
              "<p><strong>PR #" + r.prNumber + "</strong> · " + (r.statusLabel || r.status) + "</p>" +
              "<p class='hint'>" + (r.openFindings || 0) + " open · " +
              (r.blockers || 0) + " blockers · " + (r.majors || 0) + " majors" +
              (r.readiness ? " · " + r.readiness : "") + "</p>";
          }
          loadReviews();
        });
        listEl.appendChild(tr);
      });
      var metricOpen = document.getElementById("metric-open");
      var metricBlock = document.getElementById("metric-blockers");
      if (metricOpen) metricOpen.textContent = String(openSum);
      if (metricBlock) metricBlock.textContent = String(blockSum);
      if (!selectedPr && reviews[0]) {
        selectedPr = reviews[0];
        syncWsTabs();
      } else {
        syncWsTabs();
      }
    } catch (e) {
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.textContent = "Could not load reviews list.";
      }
    }
  }

  loadInstructions();
  loadRequireDecisionsMd();
  if (instructionsEl instanceof HTMLTextAreaElement) {
    instructionsEl.addEventListener("input", saveInstructions);
    instructionsEl.addEventListener("change", saveInstructions);
    instructionsEl.addEventListener("blur", saveInstructions);
  }
  if (requireDecisionsEl instanceof HTMLInputElement) {
    requireDecisionsEl.addEventListener("change", saveRequireDecisionsMd);
  }
  if (resetInstrBtn) {
    resetInstrBtn.addEventListener("click", function () {
      if (!(instructionsEl instanceof HTMLTextAreaElement)) return;
      instructionsEl.value = DEFAULT_EXTRA;
      saveInstructions();
      instructionsEl.focus();
    });
  }
  loadProviders();
  loadGithub();
  loadReviews();
  attachActive().then(function () {
    if (jobId) return;
    var h = (location.hash || "").replace(/^#/, "");
    if (h === "run" || h === "settings" || h === "live") showView(h);
    else if (h === "home" || h === "inbox") showView("inbox");
  });
  var refreshBtn = document.getElementById("btn-refresh-reviews");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      loadReviews();
    });
  }
})();
  </script>
</body>
</html>`;
}

export async function serveUi(options: ServeUiOptions): Promise<void> {
  const { repoRoot, config, port, focusPr } = options;
  let busyJobId: string | null = null;
  let triageBusy = false;
  const reviewsRoot = path.resolve(repoRoot, config.outputDir);

  function triageCtrlFor(prNumber: number): TriageControllerOptions {
    return {
      repoRoot,
      outputDir: path.join(reviewsRoot, String(prNumber)),
      config,
      isBusy: () => Boolean(busyJobId) || triageBusy,
      setBusy: (busy) => {
        triageBusy = busy;
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(homePage(port));
        return;
      }

      if (method === "GET" && url.pathname === "/api/reviews") {
        const running = [...jobs.values()]
          .filter((j) => j.status === "queued" || j.status === "running")
          .map((j) => j.prNumber)
          .filter((n): n is number => typeof n === "number");
        const reviews = await listReviewSummaries(reviewsRoot, {
          runningPrNumbers: running,
        });
        json(res, 200, { reviews });
        return;
      }

      const reviewMatch = url.pathname.match(/^\/api\/reviews\/(\d+)$/);
      if (reviewMatch) {
        const prNumber = Number(reviewMatch[1]);
        if (method === "DELETE") {
          if (busyJobId) {
            const busy = jobs.get(busyJobId);
            if (busy?.prNumber === prNumber) {
              json(res, 409, { error: "PR has a running job — force-stop it first" });
              return;
            }
          }
          await deleteReviewDir(reviewsRoot, prNumber);
          json(res, 200, { ok: true, prNumber });
          return;
        }
        if (method === "PATCH") {
          const raw = await readBody(req);
          let body: { status?: ReviewHubMeta["status"] | null; note?: string };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            json(res, 400, { error: "Invalid JSON body" });
            return;
          }
          const allowed = new Set([
            "awaiting_author",
            "ready_to_verify",
            "needs_triage",
          ]);
          if (
            body.status !== undefined &&
            body.status !== null &&
            !allowed.has(body.status)
          ) {
            json(res, 400, {
              error:
                "status must be awaiting_author|ready_to_verify|needs_triage|null",
            });
            return;
          }
          const meta = await setReviewHubStatus(reviewsRoot, prNumber, {
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
          });
          json(res, 200, { ok: true, meta });
          return;
        }
      }

      // Prefer /pr/<n>/… ; keep /reviews/<n>/… as redirect
      if (method === "GET" && url.pathname.startsWith("/reviews/")) {
        const rest = url.pathname.slice("/reviews/".length);
        res.writeHead(302, { location: `/pr/${rest}${url.search}` });
        res.end();
        return;
      }

      const prMount = url.pathname.match(/^\/pr\/(\d+)(\/.*)?$/);
      if (prMount) {
        const prNumber = Number(prMount[1]);
        const rest = prMount[2] || "/";
        const outputDir = path.join(reviewsRoot, String(prNumber));

        if (rest === "/api" || rest.startsWith("/api/")) {
          const apiPath = rest.slice("/api".length) || "/";
          try {
            const handled = await handleTriageApi(
              triageCtrlFor(prNumber),
              method,
              apiPath,
              req,
              res,
            );
            if (!handled) json(res, 404, { error: "Not found" });
          } catch (error) {
            triageBusy = false;
            const message =
              error instanceof Error ? error.message : String(error);
            json(res, 500, { error: message });
          }
          return;
        }

        if (method === "GET") {
          if (rest === "/" || rest === "/triage.html") {
            try {
              await renderReviewFromDir(outputDir);
            } catch {
              /* serve whatever is on disk */
            }
            await serveReviewStatic(res, path.join(outputDir, "triage.html"));
            return;
          }
          if (rest === "/final-review.html") {
            try {
              await renderReviewFromDir(outputDir);
            } catch {
              /* serve whatever is on disk */
            }
            await serveReviewStatic(
              res,
              path.join(outputDir, "final-review.html"),
            );
            return;
          }
          if (rest === "/verify-report.html") {
            const verifyPath = path.join(outputDir, "verify-report.html");
            try {
              await access(verifyPath);
              await serveReviewStatic(res, verifyPath);
            } catch {
              let title = "";
              try {
                const raw = await readFile(
                  path.join(outputDir, "run.json"),
                  "utf8",
                );
                const parsed = JSON.parse(raw) as { title?: string };
                title = parsed.title ?? "";
              } catch {
                /* empty title */
              }
              res.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
              });
              res.end(
                renderVerifyPlaceholderHtml({ prNumber, title }),
              );
            }
            return;
          }
          const allowed = new Set([
            "/findings.json",
            "/run.json",
            "/verify-report.json",
            "/final-review.md",
          ]);
          if (allowed.has(rest)) {
            await serveReviewStatic(res, path.join(outputDir, rest.slice(1)));
            return;
          }
          const runAsset = rest.match(
            /^\/runs\/([A-Za-z0-9._-]+)\/(triage\.html|final-review\.html|findings\.json|run\.json)$/,
          );
          if (runAsset) {
            const runId = runAsset[1]!;
            const file = runAsset[2]!;
            await serveReviewStatic(
              res,
              path.join(outputDir, "runs", runId, file),
            );
            return;
          }
        }

        json(res, 404, { error: "Not found" });
        return;
      }

      if (method === "GET" && url.pathname === "/api/providers") {
        json(res, 200, await providersPayload());
        return;
      }

      if (method === "GET" && url.pathname === "/api/github") {
        json(res, 200, await probeGithubAccess());
        return;
      }

      if (method === "POST" && url.pathname === "/api/github") {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw || "{}") as { token?: string };
          const token = body.token?.trim() ?? "";
          const login = await fetchUserLogin(token);
          await saveGithubToken(token);
          json(res, 200, {
            ...(await probeGithubAccess()),
            saved: true,
            login,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          json(res, 400, { error: message });
        }
        return;
      }

      if (method === "DELETE" && url.pathname === "/api/github") {
        await clearGithubToken();
        json(res, 200, await probeGithubAccess());
        return;
      }

      if (method === "POST" && url.pathname === "/api/custom-agents") {
        try {
          const raw = await readBody(req);
          const body = JSON.parse(raw || "{}") as {
            name?: string;
            command?: string;
            extraFlags?: string;
            promptStyle?: "dash-p" | "trailing";
          };
          const agent = await addCustomAgent({
            name: body.name ?? "",
            command: body.command ?? "",
            ...(body.extraFlags !== undefined
              ? { extraFlags: body.extraFlags }
              : {}),
            ...(body.promptStyle !== undefined
              ? { promptStyle: body.promptStyle }
              : {}),
          });
          json(res, 200, { ...(await providersPayload()), agent });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          json(res, 400, { error: message });
        }
        return;
      }

      if (
        method === "DELETE" &&
        url.pathname.startsWith("/api/custom-agents/")
      ) {
        const id = decodeURIComponent(
          url.pathname.slice("/api/custom-agents/".length),
        );
        if (!id) {
          json(res, 400, { error: "Missing agent id" });
          return;
        }
        const removed = await removeCustomAgent(id);
        if (!removed) {
          json(res, 404, { error: `No custom agent “${id}”` });
          return;
        }
        json(res, 200, await providersPayload());
        return;
      }

      if (method === "GET" && url.pathname === "/api/active") {
        const job = busyJobId ? jobs.get(busyJobId) : undefined;
        json(res, 200, { job: job ?? null });
        return;
      }

      if (
        method === "POST" &&
        url.pathname.startsWith("/api/jobs/") &&
        url.pathname.endsWith("/cancel")
      ) {
        const id = url.pathname.slice("/api/jobs/".length, -"/cancel".length);
        const job = jobs.get(id);
        if (!job) {
          json(res, 404, { error: "Job not found" });
          return;
        }

        let force = true;
        try {
          const raw = await readBody(req);
          if (raw.trim()) {
            const body = JSON.parse(raw) as { force?: boolean };
            if (body.force === false) force = false;
          }
        } catch {
          // empty body → force
        }

        job.cancelRequested = true;
        if (force) {
          const killed = killActiveCliChildren();
          appendLog(
            job,
            `Force stop — killed ${killed} in-flight CLI process(es).`,
          );
          job.status = "cancelled";
          job.error = "Force stopped by user.";
          for (const track of job.progress.agents) {
            if (track.status === "running" || track.status === "queued") {
              track.status = "error";
              track.label = "Stopped";
              track.finishedAt = new Date().toISOString();
            }
          }
          if (busyJobId === job.id) busyJobId = null;
          touch(job);
        } else {
          appendLog(
            job,
            "Cancel requested — will stop after the current agent finishes.",
          );
        }
        json(res, 200, { ok: true, jobId: job.id, force });
        return;
      }

      if (method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const id = url.pathname.slice("/api/jobs/".length);
        const job = jobs.get(id);
        if (!job) {
          json(res, 404, { error: "Job not found" });
          return;
        }
        json(res, 200, job);
        return;
      }

      if (method === "POST" && url.pathname === "/api/review") {
        if (busyJobId || triageBusy) {
          const busy = busyJobId ? jobs.get(busyJobId) : undefined;
          json(res, 409, {
            error: busyJobId
              ? "A review is already running. Attaching to that job."
              : "A triage/verify job is running. Wait for it to finish.",
            jobId: busyJobId,
            prRef: busy?.prRef,
            status: busy?.status,
            outputDir: busy?.outputDir,
            prNumber: busy?.prNumber,
          });
          return;
        }

        const raw = await readBody(req);
        let body: {
          prRef?: string;
          agents?: string[];
          extraInstructions?: string;
          requireDecisionsMd?: boolean;
        };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }

        const prRef = body.prRef?.trim();
        if (!prRef) {
          json(res, 400, { error: "prRef is required" });
          return;
        }

        const agents =
          Array.isArray(body.agents) && body.agents.length > 0
            ? body.agents.map(String)
            : [...DEFAULT_MULTI_AGENTS];

        const requireDecisionsMd = Boolean(body.requireDecisionsMd);
        const baseInstructions = (body.extraInstructions ?? "").trim();
        const extraInstructions = requireDecisionsMd
          ? baseInstructions.includes("design-decision docs required")
            ? baseInstructions
            : [baseInstructions, REQUIRE_DESIGN_DECISIONS_MD_RULE]
                .filter(Boolean)
                .join("\n\n")
          : baseInstructions;

        const job: Job = {
          id: randomUUID(),
          prRef,
          agents,
          status: "queued",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          logs: [],
          progress: initJobProgress(agents),
          results: [],
          cancelRequested: false,
          requireDecisionsMd,
          ...(extraInstructions
            ? { extraInstructions }
            : {}),
        };
        jobs.set(job.id, job);
        busyJobId = job.id;
        appendLog(job, `Job ${job.id}`);
        appendLog(job, `Watch: http://127.0.0.1:${port}/#job=${job.id}`);

        void (async () => {
          job.status = "running";
          touch(job);
          appendLog(job, `Starting multi-agent review for ${prRef}`);
          appendLog(job, `Agents: ${agents.join(", ")}`);
          if (requireDecisionsMd) {
            appendLog(
              job,
              "Team rule ON: require design-decision markdown (missing/thin → blocker)",
            );
          }
          if (extraInstructions.trim()) {
            appendLog(
              job,
              `Extra instructions: ${extraInstructions.trim().slice(0, 160)}${extraInstructions.trim().length > 160 ? "…" : ""}`,
            );
          }
          try {
            const result = await runAllCliAgents({
              prRef,
              repoRoot,
              config,
              agents,
              ...(extraInstructions.trim()
                ? { extraInstructions: extraInstructions.trim() }
                : {}),
              log: (line) => appendLog(job, line),
              shouldCancel: () => job.cancelRequested,
              onProgress: (event) => {
                if (event.prNumber) job.prNumber = event.prNumber;
                if (event.outputDir) job.outputDir = event.outputDir;
                if (event.mergedFindingCount != null) {
                  job.mergedFindingCount = event.mergedFindingCount;
                }
                if (event.result) {
                  const idx = job.results.findIndex(
                    (row) => row.agent === event.result!.agent,
                  );
                  if (idx >= 0) job.results[idx] = event.result;
                  else job.results.push(event.result);
                  if (event.result.status === "ok" && job.prNumber) {
                    const done = job.results.filter((row) => row.status === "ok")
                      .length;
                    const waiting = job.agents.filter(
                      (name) => !job.results.some((row) => row.agent === name),
                    );
                    const more =
                      waiting.length > 0
                        ? ` ${waiting.join(" + ")} still running — similar findings collapse into one card as they finish.`
                        : "";
                    appendLog(
                      job,
                      `✓ ${event.result.agent} merged into triage (${event.mergedFindingCount ?? "?"} finding(s) from ${event.runCount ?? done} agent run(s)). Open /pr/${job.prNumber}/ now.${more}`,
                    );
                  }
                }
                touch(job);
              },
            });
            job.prNumber = result.prNumber;
            job.outputDir = result.outputDir;
            job.mergedFindingCount = result.mergedFindingCount;
            job.results = result.results;
            syncTracksFromResults(job.progress, result.results);
            job.status = result.cancelled ? "cancelled" : "done";
            appendLog(
              job,
              result.cancelled
                ? `Stopped. Partial merge at reviews/${result.prNumber}/ (${result.mergedFindingCount} findings)`
                : `Merged findings: ${result.mergedFindingCount} → /pr/${result.prNumber}/`,
            );
            const ok = result.results.filter((r) => r.status === "ok").length;
            const err = result.results.filter((r) => r.status === "error").length;
            if (err > 0 && ok > 0) {
              appendLog(
                job,
                `Partial success: ${ok} agent(s) ok, ${err} failed — review still finished with what we have.`,
              );
            }
            for (const r of result.results) {
              if (r.status === "error") {
                appendLog(job, `  ✗ ${r.agent}: ${r.detail}`);
              } else if (r.status === "ok") {
                appendLog(
                  job,
                  `  ✓ ${r.agent}${r.rawFindingCount != null ? ` (${r.rawFindingCount} raw)` : ""}`,
                );
              }
            }
          } catch (error) {
            job.status = "error";
            job.error =
              error instanceof Error ? error.message : String(error);
            appendLog(job, `FAILED: ${job.error}`);
          } finally {
            touch(job);
            busyJobId = null;
          }
        })();

        json(res, 202, {
          jobId: job.id,
          watchUrl: `http://127.0.0.1:${port}/#job=${job.id}`,
        });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already a PRism hub (http://127.0.0.1:${port}/). Stop that process (Ctrl+C) and start again so this machine loads the latest code.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  console.log("████ PRism · hub");
  console.log(`Home:   http://127.0.0.1:${port}/`);
  if (focusPr) {
    console.log(`Focus:  http://127.0.0.1:${port}/pr/${focusPr}/`);
  }
  console.log("Each PR lives at /pr/<n>/ (triage, list, verify).");
  console.log("Ctrl+C to stop.");
  openBrowser(`http://127.0.0.1:${port}/`);
}
