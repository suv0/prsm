import type { VerifyReport, VerifyStatus } from "@review-os/schemas";

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
  <h2>Unmatched GitHub threads</h2>
  <ul>${report.unmatchedThreads
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.file ?? "?")}${t.line ? `:${t.line}` : ""}</code> — ${escapeHtml(t.excerpt.slice(0, 180))}</li>`,
    )
    .join("")}</ul>
</section>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR #${report.prNumber} — Verify author updates</title>
  <style>
    :root { --bg:#1e1e1e; --card:#252526; --line:#3c3c3c; --ink:#d4d4d4; --muted:#a0a0a0; --ok:#3d7a45; --warn:#dcdcaa; --bad:#f14c4c; --acc:#3794ff; }
    body { margin:0; font-family:"Segoe UI",system-ui,sans-serif; background:var(--bg); color:var(--ink); line-height:1.5; }
    main { max-width:860px; margin:0 auto; padding:2rem 1.25rem 4rem; }
    h1 { color:#fff; margin:0 0 .35rem; }
    .lede { color:var(--muted); }
    .summary { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1rem 1.1rem; margin:1rem 0; }
    .counts { display:flex; flex-wrap:wrap; gap:.75rem 1.25rem; margin:.5rem 0 0; padding:0; list-style:none; }
    .item { background:var(--card); border:1px solid var(--line); border-left-width:4px; border-radius:8px; padding:1rem; margin:1rem 0; }
    .item.resolved, .item.accepted { border-left-color:var(--ok); }
    .item.needs_look { border-left-color:var(--warn); }
    .item.still_open { border-left-color:var(--bad); }
    .badge { display:inline-block; font-size:.75rem; font-weight:600; border:1px solid var(--line); border-radius:999px; padding:.1rem .5rem; margin-right:.35rem; }
    .badge.better { color:#89d185; border-color:var(--ok); }
    .meta, .muted { color:var(--muted); font-size:.88rem; }
    .follow { background:#1e1e1e; border:1px solid var(--line); border-radius:6px; padding:.65rem .75rem; white-space:pre-wrap; font:0.85rem Consolas,monospace; }
    .agents { margin:.5rem 0 0; padding-left:1.1rem; color:var(--muted); font-size:.88rem; }
    .agents strong { color:var(--ink); }
    a { color:var(--acc); }
    h3 { margin:.4rem 0; color:#fff; font-size:1.02rem; }
  </style>
</head>
<body>
  <main>
    <h1>PR #${report.prNumber} — Verify author updates</h1>
    <p class="lede">${escapeHtml(report.title ?? "")}${report.prUrl ? ` · <a href="${escapeHtml(report.prUrl)}">${escapeHtml(report.prUrl)}</a>` : ""}</p>
    <section class="summary">
      <strong>Provider:</strong> ${escapeHtml(report.provider)} · ${escapeHtml(report.createdAt)}
      <ul class="counts">
        <li>Resolved: <strong>${report.counts.resolved}</strong></li>
        <li>Accepted: <strong>${report.counts.accepted}</strong></li>
        <li>Needs look: <strong>${report.counts.needs_look}</strong></li>
        <li>Still open: <strong>${report.counts.still_open}</strong></li>
      </ul>
      <p class="muted" style="margin:.75rem 0 0">Agents: ${escapeHtml(
        report.providers?.length
          ? report.providers.join(", ")
          : report.provider,
      )}</p>
      <p class="muted" style="margin:.75rem 0 0"><a href="./">Back to triage</a> · <a href="final-review.html">Final review</a> · <a href="/">Home</a></p>
    </section>
    ${items || "<p class='muted'>No open findings to verify.</p>"}
    ${unmatched}
  </main>
</body>
</html>`;
}
