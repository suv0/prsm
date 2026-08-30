import type { VerifyReport, VerifyStatus } from "@review-os/schemas";
import {
  workspaceChromeCloseHtml,
  workspaceChromeCss,
  workspaceChromeHeadHtml,
  workspaceChromeOpenHtml,
} from "./agent-nav.js";
import { iconHtml } from "./ui-icons.js";
import { Help, tip } from "./ui-help.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status: VerifyStatus): string {
  switch (status) {
    case "resolved":
      return "Resolved";
    case "accepted":
      return "Accepted";
    case "needs_look":
      return "Needs look";
    case "still_open":
      return "Still open";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function scopeLine(report: VerifyReport): string {
  const scope = report.scope ?? "all";
  const n = report.checkedCount ?? report.items.length;
  if (scope === "finding") {
    if (n <= 1) {
      return "This job checked <strong>one finding</strong> (Triage → Verify this finding).";
    }
    return `This job checked <strong>${n} findings</strong> (scoped verify).`;
  }
  return `This job checked <strong>all open findings</strong> (${n}) — List → Verify all open, or CLI.`;
}

function pageCss(): string {
  return `
    :root { --bg:#121414; --card:#1e2020; --line:#3e4850; --ink:#e2e2e2; --muted:#bec8d1; --ok:#3d7a45; --warn:#dcdcaa; --bad:#ffb4ab; --acc:#4fc1ff; }
    ${workspaceChromeCss()}
    .wb-body > main { max-width:860px; }
    h1 { color:#fff; margin:0 0 .35rem; font-size:18px; display:flex; align-items:center; gap:8px; }
    .counts li { display:inline-flex; align-items:center; gap:6px; }
    .lede { color:var(--muted); }
    .summary { background:var(--card); border:1px solid var(--line); border-radius:4px; padding:1rem 1.1rem; margin:1rem 0; }
    .counts { display:flex; flex-wrap:wrap; gap:.75rem 1.25rem; margin:.5rem 0 0; padding:0; list-style:none; }
    .queue { display:flex; flex-wrap:wrap; gap:.75rem 1.25rem; margin:.75rem 0 0; padding:0; list-style:none; }
    .queue li { display:inline-flex; align-items:center; gap:6px; color:var(--muted); font-size:.9rem; }
    .queue strong { color:var(--ink); }
    .item { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:4px; padding:1rem; margin:1rem 0; }
    .item.resolved, .item.accepted { border-left-color:var(--ok); }
    .item.needs_look { border-left-color:var(--warn); }
    .item.still_open { border-left-color:var(--bad); }
    .badge { display:inline-block; font-size:.75rem; font-weight:600; border:1px solid var(--line); border-radius:999px; padding:.1rem .5rem; margin-right:.35rem; }
    .badge.better { color:#89d185; border-color:var(--ok); }
    .meta, .muted { color:var(--muted); font-size:.88rem; }
    .follow { background:#0d0e0f; border:1px solid var(--line); border-radius:4px; padding:.65rem .75rem; white-space:pre-wrap; font:0.85rem "JetBrains Mono",ui-monospace,monospace; }
    .agents { margin:.5rem 0 0; padding-left:1.1rem; color:var(--muted); font-size:.88rem; }
    .agents strong { color:var(--ink); }
    a { color: var(--acc); }
    .muted a { display: inline-flex; align-items: center; gap: 4px; }
    h3 { margin:.4rem 0; color:#fff; font-size:1.02rem; }
    h2.section { color:#fff; font-size:1rem; margin:1.25rem 0 .5rem; }
  `;
}

/** Empty verify page when the PR has not been verified yet — keeps menus. */
export function renderVerifyPlaceholderHtml(options: {
  prNumber: number;
  title?: string;
}): string {
  const title = options.title ? escapeHtml(options.title) : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${workspaceChromeHeadHtml()}
  <title>PR #${options.prNumber} — Verify report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>${pageCss()}</style>
</head>
<body class="wb-page">
  ${workspaceChromeOpenHtml({ prNumber: options.prNumber, active: "verify" })}
  <main>
    <h1 ${tip(Help.verifyReport)}>${iconHtml("shield-check")} PR #${options.prNumber} — Verify report</h1>
    <p class="lede">${title || "No verify report on disk yet."}</p>
    <section class="summary">
      <p>This tab shows the <strong>last verify job’s report</strong> — not the cumulative Fixed queue.</p>
      <p>Run <strong>Verify this finding</strong> from Triage (one card) or <strong>Verify all open findings</strong> from List. That writes <code>verify-report.html</code> here.</p>
      <p class="muted" style="margin:.75rem 0 0"><a href="./">${iconHtml("list-checks")} Open triage</a> · <a href="final-review.html">${iconHtml("list")} List</a> · <a href="/">${iconHtml("home")} Home</a></p>
    </section>
  </main>
  ${workspaceChromeCloseHtml()}
</body>
</html>`;
}

export function renderVerifyReportHtml(report: VerifyReport): string {
  const items = report.items
    .map((item) => {
      const v = item.verification;
      return `<article class="item ${escapeHtml(v.status)}">
  <header>
    <span class="badge">${escapeHtml(statusLabel(v.status))}</span>
    ${v.betterThanSuggested ? `<span class="badge better">Better than suggested</span>` : ""}
    <h3>${escapeHtml(item.issueSimple)}</h3>
    <p class="meta"><code>${escapeHtml(item.file)}:${item.line}</code> · ${escapeHtml(item.findingId)}</p>
  </header>
  <p>${escapeHtml(v.summary)}</p>
  ${
    v.authorReplyExcerpt
      ? `<p class="muted"><strong>Author:</strong> ${escapeHtml(v.authorReplyExcerpt)}</p>`
      : ""
  }
  ${
    v.followUpComment
      ? `<pre class="follow">${escapeHtml(v.followUpComment)}</pre>`
      : ""
  }
  ${
    (item.byAgent?.length ?? 0) > 1
      ? `<ul class="agents">${item.byAgent
          .map(
            (a) =>
              `<li><strong>${escapeHtml(a.provider)}</strong> · ${escapeHtml(statusLabel(a.status))} — ${escapeHtml(a.summary)}</li>`,
          )
          .join("")}</ul>`
      : ""
  }
  <p class="muted">thread ${v.threadMatched ? "matched" : "not matched"} · via ${escapeHtml(v.provider)}</p>
</article>`;
    })
    .join("\n");

  const unmatched =
    report.unmatchedThreads.length > 0
      ? `<section class="summary">
  <h2 class="has-tip" ${tip(Help.unmatchedThreads)}>Unmatched GitHub threads</h2>
  <ul>${report.unmatchedThreads
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.file ?? "?")}${t.line ? `:${t.line}` : ""}</code> — ${escapeHtml(t.excerpt.slice(0, 180))}</li>`,
    )
    .join("")}</ul>
</section>`
      : "";

  const queue =
    report.queue != null
      ? `<p class="muted has-tip" style="margin:.85rem 0 0" ${tip(Help.verifyQueue)}>Queue on disk after this job (cumulative)</p>
      <ul class="queue">
        <li>Open: <strong>${report.queue.open}</strong></li>
        <li>Fixed: <strong>${report.queue.fixed}</strong></li>
        <li>False alarms: <strong>${report.queue.falseAlarm}</strong></li>
      </ul>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${workspaceChromeHeadHtml()}
  <title>PR #${report.prNumber} — Verify report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>${pageCss()}</style>
</head>
<body class="wb-page">
  ${workspaceChromeOpenHtml({ prNumber: report.prNumber, active: "verify" })}
  <main>
    <h1 ${tip(Help.verifyReport)}>${iconHtml("shield-check")} PR #${report.prNumber} — Verify report</h1>
    <p class="lede">${escapeHtml(report.title ?? "")}${report.prUrl ? ` · <a href="${escapeHtml(report.prUrl)}">${escapeHtml(report.prUrl)}</a>` : ""}</p>
    <section class="summary">
      <p>${scopeLine(report)}</p>
      <p class="muted" style="margin:.5rem 0 0"><strong>Agents:</strong> ${escapeHtml(
        report.providers?.length
          ? report.providers.join(", ")
          : report.provider,
      )} · ${escapeHtml(report.createdAt)}</p>
      <h2 class="section has-tip" ${tip(Help.verifyJobCounts)}>This job’s verdicts</h2>
      <ul class="counts">
        <li class="has-tip" ${tip(Help.countResolved)}>${iconHtml("check")} Resolved: <strong>${report.counts.resolved}</strong></li>
        <li class="has-tip" ${tip(Help.countAccepted)}>${iconHtml("check")} Accepted: <strong>${report.counts.accepted}</strong></li>
        <li class="has-tip" ${tip(Help.countNeedsLook)}>${iconHtml("alert-triangle")} Needs look: <strong>${report.counts.needs_look}</strong></li>
        <li class="has-tip" ${tip(Help.countStillOpen)}>${iconHtml("x-circle")} Still open: <strong>${report.counts.still_open}</strong></li>
      </ul>
      ${queue}
      <p class="muted" style="margin:.75rem 0 0"><a href="./">${iconHtml("list-checks")} Triage</a> · <a href="final-review.html">${iconHtml("list")} List</a> · <a href="/">${iconHtml("home")} Home</a></p>
    </section>
    ${items || "<p class='muted'>No findings in this verify job.</p>"}
    ${unmatched}
  </main>
  ${workspaceChromeCloseHtml()}
</body>
</html>`;
}
