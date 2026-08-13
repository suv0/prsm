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
  saveGithubToken,
} from "@review-os/github";
import { renderReviewFromDir } from "@review-os/render";
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
  <title>PRism — Start review</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --card: #252526;
      --line: #3c3c3c;
      --ink: #d4d4d4;
      --muted: #a0a0a0;
      --accent: #3794ff;
      --accent-hover: #4aa0ff;
      --ok: #3d7a45;
      --bad: #f14c4c;
      --warn: #dcdcaa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Consolas, ui-sans-serif, system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
    }
    main { max-width: 760px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
    h1 { margin: 0 0 0.35rem; font-size: 1.7rem; color: #fff; font-weight: 600; }
    .lede { color: var(--muted); margin: 0 0 1.5rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 1.15rem 1.25rem;
      margin-bottom: 1rem;
    }
    label { display: block; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 0.4rem; }
    input[type="url"], input[type="text"] {
      width: 100%;
      background: #1e1e1e;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--ink);
      padding: 0.7rem 0.8rem;
      font: 0.95rem Consolas, "Cascadia Code", ui-monospace, monospace;
    }
    input:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    textarea#extra-instructions {
      width: 100%;
      min-height: 11rem;
      resize: vertical;
      background: #1e1e1e;
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--ink);
      padding: 0.7rem 0.8rem;
      font: 0.9rem/1.45 Consolas, "Cascadia Code", ui-monospace, monospace;
    }
    textarea#extra-instructions:disabled { opacity: 0.65; cursor: not-allowed; }
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
      padding: 0.75rem 0.85rem;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #1b2838;
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
      color: #fff;
      border-radius: 4px;
      padding: 0.55rem 1rem;
      font: 600 0.9rem "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .hint { color: var(--muted); font-size: 0.88rem; margin-top: 0.75rem; }
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
      border-radius: 8px;
      padding: 0.55rem 0.7rem 0.65rem;
      background: #1e1e1e;
      cursor: pointer;
      border-left: 4px solid #6e6e6e;
    }
    .progress-track:hover { border-color: #555; }
    .progress-track.is-filter {
      outline: 1px solid var(--accent);
      background: #1a2430;
    }
    .progress-track.ag-cursor { border-left-color: #4fc1ff; }
    .progress-track.ag-claude { border-left-color: #e8a87c; }
    .progress-track.ag-command { border-left-color: #c9a0ff; }
    .progress-track.ag-other { border-left-color: #89d185; }
    .progress-top {
      display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
      gap: 0.35rem 0.75rem; margin-bottom: 0.35rem;
    }
    .progress-name { font-weight: 650; color: #fff; font-size: 0.92rem; }
    .progress-meta { color: var(--muted); font-size: 0.78rem; font-family: Consolas, "Cascadia Code", ui-monospace, monospace; }
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
    .progress-track.ag-cursor .bar > span { background: #4fc1ff; }
    .progress-track.ag-claude .bar > span { background: #e8a87c; }
    .progress-track.ag-command .bar > span { background: #c9a0ff; }
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
    .logs {
      margin: 0.5rem 0 0;
      max-height: 22rem;
      overflow: auto;
      background: #141414;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.55rem 0.7rem;
      font: 0.82rem/1.45 Consolas, "Cascadia Code", ui-monospace, monospace;
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
      font-family: Consolas, "Cascadia Code", ui-monospace, monospace;
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
      background: #2d2d2d;
      border-color: var(--line);
      color: #d4d4d4;
    }
    button.btn-secondary:hover { background: #3a3a3a; }
    #providers { color: var(--muted); font-size: 0.88rem; margin-bottom: 1rem; }
    .connect-head {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 0.75rem; margin-bottom: 0.85rem;
    }
    .connect-head h2 { margin: 0; font-size: 1.05rem; color: #fff; font-weight: 600; }
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
      border: 1px solid var(--line); border-radius: 8px; padding: 0.85rem 0.9rem;
      background: #1e1e1e; display: flex; flex-direction: column; gap: 0.45rem;
    }
    .agent-card.ready { border-color: #3d7a45; }
    .agent-card h3 { margin: 0; font-size: 0.95rem; color: #fff; }
    .agent-card p { margin: 0; font-size: 0.82rem; color: var(--muted); }
    .agent-card .cmd {
      font: 0.78rem Consolas, "Cascadia Code", ui-monospace, monospace;
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
      margin: 0.9rem 0 0; border: 1px dashed var(--line); border-radius: 8px;
      padding: 0.65rem 0.85rem; background: #1e1e1e;
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
    .add-agent .check { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; color: var(--ink); }
    #add-agent-msg { margin: 0.5rem 0 0; min-height: 1.1em; }
    #add-agent-msg.err { color: var(--bad); }
    #add-agent-msg.ok { color: #89d185; }
    #github-banner {
      margin: 0 0 0.65rem; padding: 0.65rem 0.75rem; border-radius: 6px;
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
      margin: 0 0 0.75rem; padding: 0.65rem 0.75rem; border-radius: 6px;
      font-size: 0.88rem; border: 1px solid var(--line);
    }
    #connect-banner.need { background: #2a1818; border-color: #8b2e2e; color: #f0c0c0; }
    #connect-banner.ready { background: #1f2a1f; border-color: #3d7a45; color: #c5e8c3; }
    #form.is-blocked { opacity: 0.55; pointer-events: none; }
    .reviews-head {
      display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
      gap: 0.5rem; margin-bottom: 0.75rem;
    }
    .reviews-head h2 { margin: 0; font-size: 1.05rem; color: #fff; font-weight: 600; }
    .review-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.65rem; }
    .review-item {
      border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem 0.9rem;
      background: #1e1e1e; display: grid; gap: 0.45rem;
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
      background: #1e1e1e; color: var(--ink); border: 1px solid var(--line);
      border-radius: 4px; padding: 0.25rem 0.4rem; font-size: 0.78rem;
    }
    .pill.running { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .pill.needs_triage { color: #9cdcfe; border-color: #3a5a7a; background: #1a2430; }
    .pill.awaiting_author { color: var(--warn); border-color: #6e6a3a; background: #2a2818; }
    .pill.ready_to_verify { color: #c5a3ff; border-color: #5a3a7a; background: #221830; }
    .pill.verified { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pill.cleared { color: #89d185; border-color: #3d7a45; background: #1f2a1f; }
    .pill.incomplete { color: var(--muted); }
    #reviews-empty { color: var(--muted); font-size: 0.9rem; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>PRism</h1>
    <p class="lede">Clone, <code>pnpm prsm</code>, review. Public PRs need no GitHub CLI. Add any AI agent from this page.</p>

    <section class="card" id="reviews-card">
      <div class="reviews-head">
        <h2>Your reviews</h2>
        <button type="button" class="btn-secondary" id="btn-refresh-reviews">Refresh</button>
      </div>
      <p id="reviews-empty" hidden>No local reviews yet. Run one below.</p>
      <ul class="review-list" id="review-list"></ul>
    </section>

    <section class="card" id="github-connect">
      <div class="connect-head">
        <h2>Connect GitHub</h2>
        <span class="pill warn" id="github-pill">Checking…</span>
      </div>
      <p id="github-banner" class="need">Checking GitHub access…</p>
      <p class="hint">Public pull requests work with no login. Private repos need a token (saved in ~/.prsm, not git) or the GitHub CLI.</p>
      <form id="github-form" class="github-fields">
        <label>Personal access token
          <input id="github-token" type="password" name="token" autocomplete="off" placeholder="ghp_… or github_pat_…" />
        </label>
        <button type="submit" class="btn-secondary" id="btn-github-save">Save token</button>
        <button type="button" class="btn-secondary" id="btn-github-clear" hidden>Disconnect</button>
      </form>
      <p class="hint" style="margin:0.45rem 0 0">Create a token with repo read access:
        <a href="https://github.com/settings/tokens/new?description=PRism&amp;scopes=repo" target="_blank" rel="noopener">github.com/settings/tokens/new</a>
      </p>
      <p id="github-msg" class="hint"></p>
    </section>

    <section class="card" id="connect">
      <div class="connect-head">
        <h2>Connect agents</h2>
        <div>
          <span class="pill warn" id="connect-pill">Checking…</span>
          <button type="button" class="btn-secondary" id="btn-recheck" style="margin-left:0.5rem">Re-check</button>
        </div>
      </div>
      <p id="connect-banner" class="need">Looking for local agent CLIs…</p>
      <div class="agent-grid" id="agent-grid"></div>
      <details class="add-agent" id="add-agent">
        <summary>Add your own agent</summary>
        <p class="hint">Any CLI on this machine that accepts a prompt. Saved in your user folder (~/.prsm), not in git. Examples: codex, gemini, aider.</p>
        <form id="add-agent-form" class="fields">
          <label>Name
            <input id="custom-name" type="text" name="name" placeholder="Codex" autocomplete="off" />
          </label>
          <label>Command
            <input id="custom-command" type="text" name="command" required placeholder="codex" autocomplete="off" />
          </label>
          <label class="span-2">Extra flags (optional)
            <input id="custom-flags" type="text" name="extraFlags" placeholder="--output-format text" autocomplete="off" />
          </label>
          <label class="check span-2">
            <input id="custom-dash-p" type="checkbox" checked />
            <span>Pass the prompt as -p (uncheck if the CLI wants the prompt as the last argument)</span>
          </label>
          <div class="span-2">
            <button type="submit" class="btn-secondary" id="btn-add-agent">Add agent</button>
          </div>
        </form>
        <p id="add-agent-msg" class="hint"></p>
      </details>
      <p class="hint" style="margin-bottom:0">PRism talks to CLIs on your machine — no PRism cloud account. Install any one agent to start, or add your own. More agents = more perspectives.</p>
    </section>

    <form class="card" id="form">
      <label for="pr">Pull request URL</label>
      <input id="pr" name="pr" type="url" required placeholder="https://github.com/org/repo/pull/123" autocomplete="off" />
      <label style="margin-top:0.9rem" for="extra-instructions">Review instructions</label>
      <p class="hint" style="margin:0 0 0.45rem">These ride along with every agent/pass for this run. Edit freely — defaults are naming-in-context + hard-review lenses. Cleared text = no extra section (built-in prompts/rules still apply).</p>
      <textarea id="extra-instructions" name="extra-instructions" spellcheck="true"></textarea>
      <div class="instr-toolbar">
        <button type="button" class="btn-secondary" id="btn-reset-instructions">Reset to default</button>
      </div>
      <div class="rule-toggles">
        <label for="require-decisions-md">
          <input type="checkbox" id="require-decisions-md" />
          <span>Require design-decision markdown on this PR</span>
        </label>
        <p class="hint">Team rule (optional). When checked, reviewers treat a missing/thin decisions <code>.md</code> as a <strong>blocker</strong>. Leave unchecked for generic / open-source reviews.</p>
      </div>
      <label style="margin-top:0.85rem">Use these agents</label>
      <div class="agents" id="agent-checks"></div>
      <button type="submit" id="submit">Run review</button>
      <p class="hint">Agents run in parallel. Each agent runs 3 specialist passes at once (correctness, nitpick, devil's-advocate). Live CLI output is color-coded per agent.</p>
    </form>

    <section class="card" id="job-panel" hidden>
      <div id="status">—</div>
      <p class="job-meta" id="job-meta"></p>
      <div class="job-actions">
        <button type="button" class="danger" id="btn-stop" hidden>Force stop</button>
        <button type="button" class="btn-secondary" id="btn-restart" hidden>Restart</button>
      </div>
      <div id="links"></div>
      <div id="agent-progress" class="agent-progress" hidden></div>
      <p id="log-filter-hint" class="log-filter-hint" hidden></p>
      <ul class="results" id="results"></ul>
      <div id="logs" class="logs"></div>
    </section>
  </main>
  <script>
(function () {
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
  let lastPrRef = "";
  let lastAgents = [];
  let lastExtraInstructions = "";
  let lastRequireDecisionsMd = false;
  let readyIds = [];
  let logFilter = "";

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
        ? "Showing " + logFilter + " only — click the agent card again to show everyone."
        : "";
    }
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
    progressEl.innerHTML = shared + tracks.map(function (track) {
      var pct = trackPercent(track);
      var doneCount = (track.passes || []).filter(function (p) {
        return p.status === "done" || p.status === "error";
      }).length;
      var total = (track.passes || []).length || 3;
      var elapsed = elapsedLabel(track);
      var chips = (track.passes || []).map(function (pass) {
        var extra = "";
        if (pass.status === "done" && pass.findings != null) extra = " · " + pass.findings;
        return '<span class="pass-chip ' + escapeLog(pass.status) + '">' +
          escapeLog(pass.id) + extra + "</span>";
      }).join("");
      var cls = "progress-track " + agentClass(track.agent);
      if (track.status === "done") cls += " is-done";
      if (track.status === "error") cls += " is-error";
      if (logFilter === track.agent) cls += " is-filter";
      return (
        '<article class="' + cls + '" data-agent="' + escapeLog(track.agent) + '">' +
          '<div class="progress-top">' +
            '<span class="progress-name">' + escapeLog(track.agent) + "</span>" +
            '<span class="progress-meta">' + doneCount + "/" + total +
            (elapsed ? " · " + elapsed : "") + " · " + pct + "%</span>" +
          "</div>" +
          '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="pass-row">' + chips + "</div>" +
          '<p class="progress-label">' + escapeLog(track.label || "") + "</p>" +
        "</article>"
      );
    }).join("");
    progressEl.querySelectorAll(".progress-track").forEach(function (node) {
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

  function setFormBlocked(blocked, message) {
    form.classList.toggle("is-blocked", Boolean(blocked));
    submit.disabled = Boolean(blocked);
    if (instructionsEl) instructionsEl.disabled = Boolean(blocked) || Boolean(pollTimer);
    if (resetInstrBtn) resetInstrBtn.disabled = Boolean(blocked) || Boolean(pollTimer);
    if (blocked) submit.textContent = message || "Connect an agent first";
    else if (!pollTimer) submit.textContent = "Run review";
  }

  function renderConnect(body) {
    const agents = Array.isArray(body.agents) ? body.agents : [];
    readyIds = Array.isArray(body.readyIds) ? body.readyIds.slice() : [];
    const readyCount = Number(body.readyCount || readyIds.length || 0);

    if (connectPill) {
      connectPill.textContent = readyCount
        ? (readyCount + " agent" + (readyCount === 1 ? "" : "s") + " ready")
        : "No agents found";
      connectPill.className = "pill " + (readyCount ? "ok" : "bad");
    }
    if (connectBanner) {
      connectBanner.className = readyCount ? "ready" : "need";
      connectBanner.textContent = readyCount
        ? "Ready to review. Pick which agents to run below — or install more for broader coverage."
        : "No local agent CLI found yet. Install one below, finish login, then hit Re-check.";
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
          a.className = "btn-link";
          a.href = agent.installUrl;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = agent.available ? "Docs" : "Install guide";
          row.appendChild(a);
        }
        if (agent.custom) {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "btn-remove";
          rm.textContent = "Remove";
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
        const box = document.createElement("input");
        box.type = "checkbox";
        box.name = "agent";
        box.value = agent.id;
        box.checked = Boolean(agent.available);
        box.disabled = !agent.available;
        label.style.opacity = agent.available ? "1" : "0.5";
        label.appendChild(box);
        label.appendChild(document.createTextNode(" " + (agent.name || agent.id)));
        agentChecks.appendChild(label);
      });
    }

    setFormBlocked(readyCount === 0);
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
      githubPill.textContent = connected
        ? (login ? "@" + login : "Connected")
        : source === "anonymous"
          ? "Public PRs"
          : "Needs token";
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
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(poll, 1000);
    poll();
  }

  function renderJob(job) {
    panel.hidden = false;
    statusEl.className = job.status;
    var errAgents = (job.results || []).filter(function (r) { return r.status === "error"; }).length;
    var okAgents = (job.results || []).filter(function (r) { return r.status === "ok"; }).length;
    if (job.status === "done" && errAgents > 0 && okAgents > 0) {
      statusEl.textContent =
        "DONE (partial) · " + okAgents + " ok / " + errAgents + " failed · " + (job.prRef || "");
    } else {
      statusEl.textContent = job.status.toUpperCase() + " · " + (job.prRef || "");
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
    stopBtn.textContent = "Force stop";
    restartBtn.hidden = false;
    restartBtn.disabled = false;
    restartBtn.textContent = active ? "Force stop & restart" : "Restart";
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

    if (instructionsEl) instructionsEl.disabled = active;
    if (resetInstrBtn) resetInstrBtn.disabled = active;
    if (requireDecisionsEl) requireDecisionsEl.disabled = active;

    if (active) {
      submit.disabled = true;
      submit.textContent = "Running…";
    } else {
      submit.disabled = false;
      submit.textContent = "Run review";
    }

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
      triage.textContent = active
        ? "Open triage now (partial merge) · /pr/" + job.prNumber + "/"
        : "Open triage · /pr/" + job.prNumber + "/";
      const list = document.createElement("a");
      list.href = "/pr/" + job.prNumber + "/final-review.html";
      list.textContent = "Open list";
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
    submit.textContent = "Starting…";
    if (instructionsEl) instructionsEl.disabled = true;
    if (resetInstrBtn) resetInstrBtn.disabled = true;
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
      submit.disabled = false;
      submit.textContent = "Run review";
      if (instructionsEl) instructionsEl.disabled = false;
      if (resetInstrBtn) resetInstrBtn.disabled = false;
      if (requireDecisionsEl) requireDecisionsEl.disabled = false;
      statusEl.className = "error";
      statusEl.textContent = e && e.message ? e.message : "Start failed";
    }
  });

  async function forceStop() {
    if (!jobId) return;
    stopBtn.disabled = true;
    restartBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
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
      submit.textContent = "Restarting…";
      if (instructionsEl) instructionsEl.disabled = true;
      if (resetInstrBtn) resetInstrBtn.disabled = true;
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
      submit.disabled = false;
      submit.textContent = "Run review";
      if (instructionsEl) instructionsEl.disabled = false;
      if (resetInstrBtn) resetInstrBtn.disabled = false;
      if (requireDecisionsEl) requireDecisionsEl.disabled = false;
      alert(e && e.message ? e.message : "Restart failed");
    }
  });

  if (recheckBtn) {
    recheckBtn.addEventListener("click", function () {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Checking…";
      loadProviders().finally(function () {
        recheckBtn.disabled = false;
        recheckBtn.textContent = "Re-check";
      });
    });
  }

  async function loadReviews() {
    const listEl = document.getElementById("review-list");
    const emptyEl = document.getElementById("reviews-empty");
    if (!listEl) return;
    try {
      const res = await fetch("/api/reviews");
      const body = await res.json();
      const reviews = Array.isArray(body.reviews) ? body.reviews : [];
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.hidden = reviews.length > 0;
      reviews.forEach(function (r) {
        const li = document.createElement("li");
        li.className = "review-item";

        const top = document.createElement("div");
        top.className = "top";
        const title = document.createElement("p");
        title.className = "title";
        title.textContent = "PR #" + r.prNumber + " — " + (r.title || "(untitled)");
        const pill = document.createElement("span");
        pill.className = "pill " + r.status;
        pill.textContent = r.statusLabel || r.status;
        top.appendChild(title);
        top.appendChild(pill);

        const meta = document.createElement("p");
        meta.className = "meta";
        var bits = [];
        bits.push(r.openFindings + " open");
        if (r.blockers) bits.push(r.blockers + " blocker");
        if (r.majors) bits.push(r.majors + " major");
        if (r.falseAlarms) bits.push(r.falseAlarms + " false alarm");
        if (r.readiness) bits.push(r.readiness);
        if (r.verify) {
          bits.push(
            "verify: " +
              r.verify.resolved +
              " resolved / " +
              r.verify.still_open +
              " open",
          );
        }
        bits.push("updated " + String(r.updatedAt || "").replace("T", " ").slice(0, 16));
        if (r.note) bits.push(r.note);
        meta.textContent = bits.join(" · ");

        const actions = document.createElement("div");
        actions.className = "actions";
        const open = document.createElement("a");
        open.className = "btn-link";
        open.href = r.href || ("/pr/" + r.prNumber + "/");
        open.textContent = "Open";
        const list = document.createElement("a");
        list.className = "btn-link";
        list.href = r.listHref || ("/pr/" + r.prNumber + "/final-review.html");
        list.textContent = "List";
        if (r.hasVerifyReport) {
          const v = document.createElement("a");
          v.className = "btn-link";
          v.href = r.verifyHref || ("/pr/" + r.prNumber + "/verify-report.html");
          v.textContent = "Verify report";
          actions.appendChild(v);
        }
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
              body: JSON.stringify({
                status: statusSel.value || null,
              }),
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
        removeBtn.className = "danger";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async function () {
          if (!confirm("Remove local review for PR #" + r.prNumber + "? This deletes reviews/" + r.prNumber + "/")) {
            return;
          }
          try {
            const res2 = await fetch("/api/reviews/" + r.prNumber, { method: "DELETE" });
            const body2 = await res2.json();
            if (!res2.ok) throw new Error(body2.error || ("HTTP " + res2.status));
            loadReviews();
          } catch (e) {
            alert(e && e.message ? e.message : "Remove failed");
          }
        });
        actions.appendChild(open);
        actions.appendChild(list);
        actions.appendChild(statusSel);
        actions.appendChild(removeBtn);

        li.appendChild(top);
        li.appendChild(meta);
        li.appendChild(actions);
        listEl.appendChild(li);
      });
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
    instructionsEl.addEventListener("change", saveInstructions);
    instructionsEl.addEventListener("blur", saveInstructions);
  }
  if (requireDecisionsEl instanceof HTMLInputElement) {
    requireDecisionsEl.addEventListener("change", saveRequireDecisionsMd);
  }
  if (resetInstrBtn) {
    resetInstrBtn.addEventListener("click", function () {
      if (!(instructionsEl instanceof HTMLTextAreaElement) || instructionsEl.disabled) return;
      instructionsEl.value = DEFAULT_EXTRA;
      saveInstructions();
    });
  }
  loadProviders();
  loadGithub();
  loadReviews();
  attachActive();
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
          const allowed = new Set([
            "/final-review.html",
            "/verify-report.html",
            "/findings.json",
            "/run.json",
            "/verify-report.json",
            "/final-review.md",
          ]);
          if (allowed.has(rest)) {
            await serveReviewStatic(res, path.join(outputDir, rest.slice(1)));
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
    server.once("error", reject);
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
