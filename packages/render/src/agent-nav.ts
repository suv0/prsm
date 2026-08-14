import type { AgentRunSummary, ReviewRun } from "@review-os/schemas";

function latestRunPerAgent(run: ReviewRun): AgentRunSummary[] {
  if (!run.agents?.length) return [];
  const latest = new Map<string, AgentRunSummary>();
  for (const entry of run.agents) {
    const prev = latest.get(entry.agent);
    if (!prev || entry.createdAt > prev.createdAt) {
      latest.set(entry.agent, entry);
    }
  }
  return [...latest.values()];
}

export type WorkspaceTab = "live" | "triage" | "list" | "verify";

/** Shared workbench chrome (sidebar + sticky top tabs) for hub PR pages. */
export function workspaceChromeCss(): string {
  return `
    html, body.wb-page {
      height: 100%;
      margin: 0;
      overflow: hidden;
      color-scheme: dark;
    }
    .wb-app {
      display: grid;
      grid-template-columns: 260px 1fr;
      height: 100%;
      min-height: 0;
      background: #121414;
      color: #e2e2e2;
      font-family: "Hanken Grotesk", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      line-height: 20px;
    }
    .wb-sidebar {
      display: flex;
      flex-direction: column;
      background: #1a1c1c;
      border-right: 1px solid #3e4850;
      min-height: 0;
    }
    .wb-brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px;
    }
    .wb-logo {
      width: 28px;
      height: 28px;
      border-radius: 4px;
      background: #4fc1ff;
      color: #00344c;
      font: 700 14px/28px "Hanken Grotesk", sans-serif;
      text-align: center;
      flex-shrink: 0;
    }
    .wb-brand { color: #fff; font-weight: 600; font-size: 16px; line-height: 20px; }
    .wb-brand-sub {
      margin: 0;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: #bec8d1;
    }
    .wb-nav { display: flex; flex-direction: column; padding: 0; }
    .wb-nav a {
      display: block;
      color: #e2e2e2;
      text-decoration: none;
      font: 600 13px/20px "Hanken Grotesk", sans-serif;
      padding: 8px 16px;
      border-left: 2px solid transparent;
    }
    .wb-nav a:hover { background: #282a2b; color: #fff; }
    .wb-nav a.is-active {
      background: #282a2b;
      border-left-color: #4fc1ff;
      color: #fff;
    }
    .wb-side-foot {
      margin-top: auto;
      border-top: 1px solid #3e4850;
      padding: 8px 0;
    }
    .wb-side-foot a {
      display: block;
      color: #bec8d1;
      text-decoration: none;
      font: 600 13px/20px "Hanken Grotesk", sans-serif;
      padding: 8px 16px;
      border-left: 2px solid transparent;
    }
    .wb-side-foot a:hover { background: #282a2b; color: #fff; }
    .wb-stage {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: #121414;
    }
    .ws-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      height: 40px;
      padding: 0 16px;
      background: #1a1c1c;
      border-bottom: 1px solid #3e4850;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .ws-bar .ws-brand {
      color: #fff;
      font-weight: 600;
      text-decoration: none;
      font-size: 13px;
      white-space: nowrap;
    }
    .ws-bar nav {
      display: flex;
      gap: 4px;
      margin: 0 auto;
    }
    .ws-bar nav a {
      color: #bec8d1;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 2px solid transparent;
    }
    .ws-bar nav a:hover { color: #fff; }
    .ws-bar nav a.is-active {
      color: #fff;
      border-bottom-color: #4fc1ff;
    }
    .ws-bar nav a.is-disabled {
      opacity: 0.4;
      pointer-events: none;
    }
    .wb-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    .wb-body > main {
      max-width: 960px;
      margin: 0 auto;
      padding: 20px 24px 40px;
    }
  `;
}

export function workspaceChromeOpenHtml(options: {
  prNumber: number;
  active: WorkspaceTab;
  /** Soft-highlight a hub sidebar destination. */
  sideActive?: "home" | "run" | "settings" | "live" | "none";
  verifyAvailable?: boolean;
}): string {
  const n = options.prNumber;
  const side = options.sideActive ?? "home";
  const sideClass = (id: typeof side) =>
    side === id ? ' class="is-active"' : "";
  const tab = (id: WorkspaceTab, href: string, label: string, disabled = false) => {
    if (disabled) {
      return `<a href="#" class="is-disabled" aria-disabled="true" title="Not available yet">${label}</a>`;
    }
    return `<a href="${href}"${id === options.active ? ' class="is-active"' : ""}>${label}</a>`;
  };
  const verifyHref = `/pr/${n}/verify-report.html`;
  return `<div class="wb-app">
    <aside class="wb-sidebar" aria-label="PRism">
      <div class="wb-brand-row">
        <div class="wb-logo">P</div>
        <div>
          <div class="wb-brand">PRism</div>
          <p class="wb-brand-sub">Local Review Desk</p>
        </div>
      </div>
      <nav class="wb-nav">
        <a href="/#home"${sideClass("home")}>Home</a>
        <a href="/#run"${sideClass("run")}>New Review</a>
        <a href="/#settings"${sideClass("settings")}>Settings</a>
      </nav>
      <div class="wb-side-foot">
        <a href="/#live"${sideClass("live")}>Status</a>
      </div>
    </aside>
    <div class="wb-stage">
      <header class="ws-bar">
        <a class="ws-brand" href="/">PRism Workspace</a>
        <nav aria-label="Workspace">
          ${tab("live", "/#live", "Live run")}
          ${tab("triage", `/pr/${n}/`, "Triage")}
          ${tab("list", `/pr/${n}/final-review.html`, "List")}
          ${tab("verify", verifyHref, "Verify", options.verifyAvailable === false)}
        </nav>
      </header>
      <div class="wb-body">`;
}

export function workspaceChromeCloseHtml(): string {
  return `</div></div></div>`;
}

/** @deprecated Prefer open/close shell helpers for full sidebar chrome. */
export function workspaceChromeHtml(options: {
  prNumber: number;
  active: WorkspaceTab;
  verifyAvailable?: boolean;
}): string {
  return workspaceChromeOpenHtml(options);
}

/** Links to merged triage vs each agent's own snapshot under runs/. */
export function agentFindingsNavHtml(
  run: ReviewRun,
  escapeHtml: (value: string) => string,
): string {
  const n = run.prNumber;
  const merged = `/pr/${n}/`;
  const parts: string[] = [];
  const agents = latestRunPerAgent(run);
  const mergedCount = run.agent
    ? agents.reduce((sum, entry) => sum + entry.findingCount, 0)
    : (run.findings?.length ?? 0);

  if (agents.length > 0) {
    const mergedActive = !run.agent ? ' class="is-active"' : "";
    parts.push(
      `<a href="${merged}"${mergedActive}>Merged ${mergedCount}</a>`,
    );
    for (const entry of agents) {
      const href = `/pr/${n}/runs/${encodeURIComponent(entry.id)}/triage.html`;
      const active = run.agent === entry.agent ? ' class="is-active"' : "";
      parts.push(
        `<a href="${href}"${active}>${escapeHtml(entry.agent)} ${entry.findingCount}</a>`,
      );
    }
  } else if (run.agent) {
    parts.push(`<a href="${merged}">Merged</a>`);
    parts.push(
      `<span class="is-active">This page: ${escapeHtml(run.agent)} only</span>`,
    );
  }

  if (parts.length === 0) return "";
  return `<nav class="agent-findings-nav" aria-label="Agent findings">${parts.join("")}</nav>`;
}

export { latestRunPerAgent };
