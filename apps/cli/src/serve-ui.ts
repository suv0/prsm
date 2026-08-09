import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "@review-os/schemas";
import {
  createProviderRegistry,
  killActiveCliChildren,
  listAvailableProviders,
} from "@review-os/providers";
import {
  DEFAULT_MULTI_AGENTS,
  runAllCliAgents,
  type AgentRunResult,
} from "./run-provider.js";
import { detectAgentStatuses } from "./agent-catalog.js";

export type ServeUiOptions = {
  repoRoot: string;
  config: AppConfig;
  port: number;
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
  results: AgentRunResult[];
  cancelRequested: boolean;
  prNumber?: number;
  outputDir?: string;
  mergedFindingCount?: number;
  error?: string;
};

const jobs = new Map<string, Job>();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
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
    input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .agents { display: flex; flex-wrap: wrap; gap: 0.75rem 1.1rem; margin: 0.9rem 0 1.1rem; }
    .agents label { display: inline-flex; align-items: center; gap: 0.4rem; text-transform: none; letter-spacing: 0; font-size: 0.92rem; color: var(--ink); font-weight: 500; cursor: pointer; margin: 0; }
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
    pre#logs {
      margin: 0.5rem 0 0;
      max-height: 22rem;
      overflow: auto;
      background: #1e1e1e;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.75rem 0.9rem;
      font: 0.82rem/1.45 Consolas, "Cascadia Code", ui-monospace, monospace;
      white-space: pre-wrap;
      color: #cccccc;
    }
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
    @media (min-width: 640px) { .agent-grid { grid-template-columns: 1fr 1fr 1fr; } }
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
    #connect-banner {
      margin: 0 0 0.75rem; padding: 0.65rem 0.75rem; border-radius: 6px;
      font-size: 0.88rem; border: 1px solid var(--line);
    }
    #connect-banner.need { background: #2a1818; border-color: #8b2e2e; color: #f0c0c0; }
    #connect-banner.ready { background: #1f2a1f; border-color: #3d7a45; color: #c5e8c3; }
    #form.is-blocked { opacity: 0.55; pointer-events: none; }
  </style>
</head>
<body>
  <main>
    <h1>PRism</h1>
    <p class="lede">See every angle before you merge. Connect a local AI agent, paste a GitHub PR URL, then run the review.</p>

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
      <p class="hint" style="margin-bottom:0">PRism talks to CLIs on your machine — no PRism cloud account. Install any one agent to start; more agents = more perspectives.</p>
    </section>

    <form class="card" id="form">
      <label for="pr">Pull request URL</label>
      <input id="pr" name="pr" type="url" required placeholder="https://github.com/org/repo/pull/123" autocomplete="off" />
      <label style="margin-top:0.9rem">Use these agents</label>
      <div class="agents" id="agent-checks"></div>
      <button type="submit" id="submit">Run review</button>
      <p class="hint">Agents run one after another (~3–6 min per specialist pass). Live CLI output and heartbeats appear in the log while a pass is running.</p>
    </form>

    <section class="card" id="job-panel" hidden>
      <div id="status">—</div>
      <p class="job-meta" id="job-meta"></p>
      <div class="job-actions">
        <button type="button" class="danger" id="btn-stop" hidden>Force stop</button>
        <button type="button" class="btn-secondary" id="btn-restart" hidden>Restart</button>
      </div>
      <div id="links"></div>
      <ul class="results" id="results"></ul>
      <pre id="logs"></pre>
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
  const linksEl = document.getElementById("links");
  const resultsEl = document.getElementById("results");
  const providersEl = document.getElementById("providers");
  const stopBtn = document.getElementById("btn-stop");
  const restartBtn = document.getElementById("btn-restart");
  const agentGrid = document.getElementById("agent-grid");
  const agentChecks = document.getElementById("agent-checks");
  const connectPill = document.getElementById("connect-pill");
  const connectBanner = document.getElementById("connect-banner");
  const recheckBtn = document.getElementById("btn-recheck");
  let pollTimer = 0;
  let jobId = "";
  let lastPrRef = "";
  let lastAgents = [];
  let readyIds = [];

  function setFormBlocked(blocked, message) {
    form.classList.toggle("is-blocked", Boolean(blocked));
    submit.disabled = Boolean(blocked);
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
        label.appendChild(document.createTextNode(" " + agent.id));
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
    statusEl.textContent = job.status.toUpperCase() + " · " + (job.prRef || "");
    var meta = "Job " + job.id;
    if (job.agents && job.agents.length) meta += " · agents: " + job.agents.join(", ");
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

    if (active) {
      submit.disabled = true;
      submit.textContent = "Running…";
    } else {
      submit.disabled = false;
      submit.textContent = "Run review";
    }

    logsEl.textContent = (job.logs || []).join("\\n");
    logsEl.scrollTop = logsEl.scrollHeight;

    resultsEl.innerHTML = "";
    (job.results || []).forEach(function (r) {
      const li = document.createElement("li");
      li.className = r.status;
      li.textContent = r.agent + ": " + r.status + " — " + r.detail +
        (r.rawFindingCount != null ? " (" + r.rawFindingCount + " raw)" : "");
      resultsEl.appendChild(li);
    });

    linksEl.innerHTML = "";
    if (job.prNumber) {
      const triage = document.createElement("a");
      triage.href = "/reviews/" + job.prNumber + "/triage.html";
      triage.target = "_blank";
      triage.rel = "noopener";
      triage.textContent = "Open triage";
      const list = document.createElement("a");
      list.href = "/reviews/" + job.prNumber + "/final-review.html";
      list.target = "_blank";
      list.rel = "noopener";
      list.textContent = "Open list";
      linksEl.appendChild(triage);
      linksEl.appendChild(list);
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
    panel.hidden = false;
    statusEl.className = "running";
    statusEl.textContent = "QUEUED";
    metaEl.textContent = "";
    logsEl.textContent = "";
    resultsEl.innerHTML = "";
    linksEl.innerHTML = "";

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prRef: pr.value.trim(), agents: agents }),
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
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prRef: prRef, agents: agents }),
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

  loadProviders();
  attachActive();
})();
  </script>
</body>
</html>`;
}

export async function serveUi(options: ServeUiOptions): Promise<void> {
  const { repoRoot, config, port } = options;
  let busyJobId: string | null = null;

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

      if (method === "GET" && url.pathname === "/api/providers") {
        const detected = await detectAgentStatuses();
        const registry = createProviderRegistry();
        const available = await listAvailableProviders(registry);
        json(res, 200, {
          providers: detected.readyIds,
          readyIds: detected.readyIds,
          readyCount: detected.readyCount,
          agents: detected.agents,
          all: available,
          defaults: [...DEFAULT_MULTI_AGENTS],
        });
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
        if (busyJobId) {
          const busy = jobs.get(busyJobId);
          json(res, 409, {
            error: "A review is already running. Attaching to that job.",
            jobId: busyJobId,
            prRef: busy?.prRef,
            status: busy?.status,
            outputDir: busy?.outputDir,
            prNumber: busy?.prNumber,
          });
          return;
        }

        const raw = await readBody(req);
        let body: { prRef?: string; agents?: string[] };
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

        const job: Job = {
          id: randomUUID(),
          prRef,
          agents,
          status: "queued",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          logs: [],
          results: [],
          cancelRequested: false,
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
          try {
            const result = await runAllCliAgents({
              prRef,
              repoRoot,
              config,
              agents,
              log: (line) => appendLog(job, line),
              shouldCancel: () => job.cancelRequested,
            });
            job.prNumber = result.prNumber;
            job.outputDir = result.outputDir;
            job.mergedFindingCount = result.mergedFindingCount;
            job.results = result.results;
            job.status = result.cancelled ? "cancelled" : "done";
            appendLog(
              job,
              result.cancelled
                ? `Stopped. Partial merge at reviews/${result.prNumber}/ (${result.mergedFindingCount} findings)`
                : `Merged findings: ${result.mergedFindingCount} → reviews/${result.prNumber}/`,
            );
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

        json(res, 202, { jobId: job.id, watchUrl: `http://127.0.0.1:${port}/#job=${job.id}` });
        return;
      }

      // Static review artifacts for convenience after a run
      if (method === "GET" && url.pathname.startsWith("/reviews/")) {
        const rel = url.pathname.slice("/reviews/".length);
        if (rel.includes("..")) {
          json(res, 400, { error: "Invalid path" });
          return;
        }
        const filePath = path.resolve(
          repoRoot,
          config.outputDir,
          ...rel.split("/"),
        );
        const root = path.resolve(repoRoot, config.outputDir);
        if (!filePath.startsWith(root)) {
          json(res, 400, { error: "Invalid path" });
          return;
        }
        try {
          const { readFile } = await import("node:fs/promises");
          const body = await readFile(filePath);
          const type = filePath.endsWith(".html")
            ? "text/html; charset=utf-8"
            : filePath.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "text/plain; charset=utf-8";
          res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
          res.end(body);
        } catch {
          json(res, 404, { error: "Not found" });
        }
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

  console.log("████ PRism · serve-ui");
  console.log(`Open: http://127.0.0.1:${port}/`);
  console.log("Paste a PR URL and run cursor + claude-code + command-code.");
  console.log("Ctrl+C to stop.");
}
