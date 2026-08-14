import type { Finding, ReviewRun } from "@review-os/schemas";
import { githubFileUrl } from "./github-file-link.js";
import { renderOverviewHtml } from "./overview.js";
import { agentFindingsNavHtml, latestRunPerAgent, workspaceChromeCloseHtml, workspaceChromeCss, workspaceChromeOpenHtml } from "./agent-nav.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function encodeCopyPayload(value: string): string {
  return encodeURIComponent(value);
}

function lineLabel(finding: Finding): string {
  if (finding.endLine && finding.endLine !== finding.line) {
    return `${finding.line}–${finding.endLine}`;
  }
  return String(finding.line);
}

function fileName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] || path;
}

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "import",
  "from",
  "export",
  "default",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "new",
  "class",
  "extends",
  "type",
  "interface",
  "enum",
  "public",
  "private",
  "protected",
  "readonly",
  "typeof",
  "instanceof",
  "null",
  "undefined",
  "true",
  "false",
  "create",
  "table",
  "references",
  "select",
  "insert",
  "update",
  "delete",
  "from",
  "where",
  "and",
  "or",
  "not",
  "null",
  "primary",
  "key",
  "foreign",
  "unique",
  "index",
  "alter",
  "drop",
  "into",
  "values",
  "set",
  "join",
  "on",
  "as",
  "text",
  "integer",
  "boolean",
  "uuid",
  "timestamp",
]);

/**
 * Tokenize plain text first, then escape — never regex-replace through HTML.
 * That avoids corrupting tags (e.g. matching the word "class" inside class="...").
 */
function highlightLine(line: string): string {
  if (line.length === 0) return "&nbsp;";

  const commentMatch = /^(.*?)(\/\/.*)$/.exec(line);
  if (commentMatch) {
    const [, codePart = "", commentPart = ""] = commentMatch;
    return `${highlightCodePart(codePart)}<span class="tok-comment">${escapeHtml(commentPart)}</span>`;
  }

  return highlightCodePart(line);
}

function highlightCodePart(input: string): string {
  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\s+|.)/g;

  let out = "";
  for (const match of input.matchAll(tokenRe)) {
    const [full, stringTok, numberTok, wordTok] = match;

    if (stringTok !== undefined) {
      out += `<span class="tok-string">${escapeHtml(stringTok)}</span>`;
      continue;
    }
    if (numberTok !== undefined) {
      out += `<span class="tok-number">${escapeHtml(numberTok)}</span>`;
      continue;
    }
    if (wordTok !== undefined) {
      const lower = wordTok.toLowerCase();
      if (KEYWORDS.has(lower)) {
        out += `<span class="tok-keyword">${escapeHtml(wordTok)}</span>`;
      } else if (/^[A-Z]/.test(wordTok)) {
        out += `<span class="tok-type">${escapeHtml(wordTok)}</span>`;
      } else {
        out += escapeHtml(wordTok);
      }
      continue;
    }

    out += escapeHtml(full);
  }

  return out || "&nbsp;";
}

function renderEditor(options: {
  code: string;
  file: string;
  language: string;
  startLine: number;
  variant?: "code" | "comment";
}): string {
  const variant = options.variant ?? "code";
  const lines = options.code.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(1, options.startLine || 1);
  const lang = options.language || "txt";
  const name = fileName(options.file);

  if (variant === "comment") {
    return `<div class="editor editor-comment">
  <div class="editor-titlebar">
    <div class="editor-tab active">review-comment.md</div>
    <div class="editor-lang">markdown</div>
  </div>
  <div class="editor-body">
    <pre class="comment-body"><code>${escapeHtml(options.code)}</code></pre>
  </div>
</div>`;
  }

  const rowHtml = lines
    .map((line, index) => {
      const n = start + index;
      return `<div class="editor-row">
  <span class="editor-gutter" aria-hidden="true">${n}</span>
  <span class="editor-line">${highlightLine(line)}</span>
</div>`;
    })
    .join("");

  return `<div class="editor">
  <div class="editor-titlebar">
    <div class="editor-tab active" title="${escapeHtml(options.file)}">${escapeHtml(name)}</div>
    <div class="editor-lang">${escapeHtml(lang)}</div>
  </div>
  <div class="editor-breadcrumb">${escapeHtml(options.file)}:${start}</div>
  <div class="editor-body">
    <div class="editor-code" role="region" aria-label="Code editor">${rowHtml}</div>
  </div>
</div>`;
}

function viewsHtml(finding: Finding): string {
  if (!finding.views.length) return "";
  const items = finding.views
    .map(
      (view) =>
        `<li><span class="chip">${escapeHtml(view.model)}</span> <span class="stance">${escapeHtml(view.stance)}</span> — ${escapeHtml(view.note)}</li>`,
    )
    .join("");
  return `<section>
    <h3>Agent perspectives</h3>
    <ul class="views">${items}</ul>
  </section>`;
}

function agentsSummaryHtml(run: ReviewRun): string {
  const agents = latestRunPerAgent(run);
  if (agents.length === 0) return "";
  const items = agents
    .map((agent) => {
      const href = `/pr/${run.prNumber}/runs/${encodeURIComponent(agent.id)}/triage.html`;
      return `<li><a href="${href}"><span class="chip">${escapeHtml(agent.agent)}</span> ${agent.findingCount} finding(s)</a> · <code>${escapeHtml(agent.id)}</code></li>`;
    })
    .join("");
  return `<section class="summary agents">
      <h2>Agent runs</h2>
      <p class="meta">Merged triage combines everyone. Click an agent to see <em>only</em> that agent’s findings.</p>
      <ul>${items}</ul>
    </section>`;
}

function buildAgentPacket(finding: Finding, prNumber: number): string {
  const line =
    finding.endLine && finding.endLine !== finding.line
      ? `${finding.line}–${finding.endLine}`
      : String(finding.line);
  return [
    "Please verify this PR review finding. Is it a real issue, should it be softened, or is it a false alarm?",
    "",
    `PR #${prNumber}`,
    `Finding id: ${finding.id}`,
    `Disposition: ${finding.disposition ?? "open"}`,
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
    `File: ${finding.file}`,
    `Line: ${line}`,
    "",
    "## Issue (simple)",
    finding.issueSimple,
    "",
    "## Why weak",
    finding.whyWeak,
    "",
    "## How to fix",
    finding.howToFix,
    "",
    "## Current code",
    "```",
    finding.currentCode,
    "```",
    "",
    "## Better code",
    "```",
    finding.betterCode,
    "```",
    "",
    "## Paste comment",
    finding.reviewComment,
    "",
    "Reply with: stand | update (what to change) | false alarm (why). Keep any revised reviewComment to 1–3 short sentences.",
  ].join("\n");
}

function cardHtml(
  finding: Finding,
  index: number,
  prNumber: number,
  link?: { prUrl?: string; head?: string },
): string {
  const isPraise = finding.kind === "praise";
  const title = isPraise
    ? `Praise ${index}`
    : `Finding ${index} — ${finding.severity}`;
  const language = finding.language || "ts";
  const findingId = encodeURIComponent(finding.id);
  const agentPacket = encodeCopyPayload(buildAgentPacket(finding, prNumber));
  const href = githubFileUrl({
    ...(link?.prUrl !== undefined ? { prUrl: link.prUrl } : {}),
    ...(link?.head !== undefined ? { head: link.head } : {}),
    file: finding.file,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
  });
  const metaInner = href
    ? `<a class="file-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><code>${escapeHtml(finding.file)}</code> · Line ${escapeHtml(lineLabel(finding))}</a>`
    : `<code>${escapeHtml(finding.file)}</code> · Line ${escapeHtml(lineLabel(finding))}`;

  return `<article class="card" data-finding-id="${findingId}" data-original-comment="${encodeCopyPayload(finding.reviewComment)}" data-agent-packet="${agentPacket}" data-severity="${escapeHtml(finding.severity)}" data-index="${index}">
  <header class="card-header">
    <div>
      <h2>${escapeHtml(title)}</h2>
      <p class="meta">${metaInner}</p>
    </div>
    <div class="card-actions">
      <button type="button" data-action="copy-agent" data-label="Copy for agent">Copy for agent</button>
      <button type="button" class="btn-secondary" data-action="resolve">Resolved</button>
      <button type="button" class="btn-secondary" data-action="unresolve" hidden>Restore</button>
    </div>
  </header>
  ${
    finding.disposition === "false_alarm"
      ? `<p class="meta">False alarm${finding.falseAlarmNote ? ` — ${escapeHtml(finding.falseAlarmNote)}` : ""}</p>`
      : ""
  }
  ${viewsHtml(finding)}
  <section>
    <h3>Current code</h3>
    <div class="copy-row">
      <button type="button" data-copy="${encodeCopyPayload(finding.currentCode)}" data-label="Copy code">Copy code</button>
    </div>
    ${renderEditor({
      code: finding.currentCode,
      file: finding.file,
      language,
      startLine: finding.line,
    })}
  </section>
  <section>
    <h3>${isPraise ? "What looks good" : "Issue (simple)"}</h3>
    <p>${escapeHtml(finding.issueSimple)}</p>
  </section>
  ${
    isPraise
      ? ""
      : `<details class="details-block">
    <summary>Details (why / fix / better code)</summary>
    <section>
      <h3>Why this is weak</h3>
      <p>${escapeHtml(finding.whyWeak)}</p>
    </section>
    <section>
      <h3>How to fix</h3>
      <p>${escapeHtml(finding.howToFix)}</p>
    </section>
    <section>
      <h3>Better code</h3>
      <div class="copy-row">
        <button type="button" data-copy="${encodeCopyPayload(finding.betterCode)}" data-label="Copy fix">Copy fix</button>
      </div>
      ${renderEditor({
        code: finding.betterCode,
        file: finding.file,
        language,
        startLine: finding.line,
      })}
    </section>
  </details>`
  }
  <section class="review-workspace">
    <h3>Your paste comment (keep it short)</h3>
    <p class="hint">Edit this into the simple GitHub comment you want. Saved in this browser for PR #${prNumber}.</p>
    <textarea class="simple-comment" rows="4" data-field="simple-comment" placeholder="Short polite comment to paste on GitHub…">${escapeHtml(finding.reviewComment)}</textarea>
    <div class="copy-row toolbar-row">
      <button type="button" data-action="save-comment">Save comment</button>
      <button type="button" data-action="copy-simple" data-label="Copy comment">Copy comment</button>
      <button type="button" class="btn-secondary" data-action="reset-comment">Reset to original</button>
    </div>
    <details class="details-block">
      <summary>Original generated comment</summary>
      <div class="copy-row">
        <button type="button" data-copy="${encodeCopyPayload(finding.reviewComment)}" data-label="Copy original">Copy original</button>
      </div>
      ${renderEditor({
        code: finding.reviewComment,
        file: finding.file,
        language: "md",
        startLine: 1,
        variant: "comment",
      })}
    </details>
  </section>
  <section class="review-workspace">
    <h3>Double-check notes</h3>
    <p class="hint">After you verify in chat, jot the verdict here (stands / skip / soft). Local only.</p>
    <textarea class="notes" rows="3" data-field="notes" placeholder="e.g. Verified — post. Or: false positive, skip."></textarea>
    <div class="copy-row">
      <button type="button" class="btn-secondary" data-action="save-notes">Save notes</button>
    </div>
  </section>
</article>`;
}

function clientScript(prNumber: number): string {
  return `<script>
(function () {
  const PR = ${prNumber};
  const STORAGE_KEY = "review-os:pr-" + PR + ":triage:v1";

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { resolved: [], comments: {}, notes: {} };
      const parsed = JSON.parse(raw);
      return {
        resolved: Array.isArray(parsed.resolved) ? parsed.resolved : [],
        comments: parsed.comments && typeof parsed.comments === "object" ? parsed.comments : {},
        notes: parsed.notes && typeof parsed.notes === "object" ? parsed.notes : {},
      };
    } catch {
      return { resolved: [], comments: {}, notes: {} };
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const state = loadState();
  const openRoot = document.getElementById("open-findings");
  const resolvedRoot = document.getElementById("resolved-findings");
  const openCount = document.getElementById("open-count");
  const resolvedCount = document.getElementById("resolved-count");
  const flash = document.getElementById("flash");
  let flashTimer = 0;

  function showFlash(msg) {
    if (!flash) return;
    flash.textContent = msg;
    flash.hidden = false;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { flash.hidden = true; }, 1600);
  }

  function cardId(card) {
    return card.getAttribute("data-finding-id") || "";
  }

  function originalComment(card) {
    return card.getAttribute("data-original-comment") || "";
  }

  function refreshCounts() {
    const open = openRoot ? openRoot.querySelectorAll(".card").length : 0;
    const resolved = resolvedRoot ? resolvedRoot.querySelectorAll(".card").length : 0;
    if (openCount) openCount.textContent = String(open);
    if (resolvedCount) resolvedCount.textContent = String(resolved);
    if (resolvedRoot) {
      resolvedRoot.hidden = resolved === 0;
      const heading = document.getElementById("resolved-heading");
      if (heading) heading.hidden = resolved === 0;
    }
  }

  function setResolvedUi(card, resolved) {
    const resolveBtn = card.querySelector('[data-action="resolve"]');
    const unresolveBtn = card.querySelector('[data-action="unresolve"]');
    if (resolveBtn) resolveBtn.hidden = resolved;
    if (unresolveBtn) unresolveBtn.hidden = !resolved;
    card.classList.toggle("is-resolved", resolved);
  }

  function placeCard(card, resolved) {
    const target = resolved ? resolvedRoot : openRoot;
    if (!target) return;
    target.appendChild(card);
    setResolvedUi(card, resolved);
  }

  function applyStateToCard(card) {
    const id = cardId(card);
    const commentBox = card.querySelector('[data-field="simple-comment"]');
    const notesBox = card.querySelector('[data-field="notes"]');
    if (commentBox && state.comments[id]) commentBox.value = state.comments[id];
    if (notesBox && state.notes[id]) notesBox.value = state.notes[id];
    placeCard(card, state.resolved.includes(id));
  }

  document.querySelectorAll(".card[data-finding-id]").forEach(applyStateToCard);
  refreshCounts();

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const encoded = button.getAttribute("data-copy") || "";
      const value = decodeURIComponent(encoded);
      const label = button.getAttribute("data-label") || "Copy";
      try {
        await navigator.clipboard.writeText(value);
        button.classList.add("copied");
        button.textContent = "Copied";
        setTimeout(() => {
          button.classList.remove("copied");
          button.textContent = label;
        }, 1200);
      } catch {
        button.textContent = "Copy failed";
      }
    });
  });

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    const card = target.closest(".card");
    if (!(card instanceof HTMLElement)) return;
    const id = cardId(card);

    if (action === "resolve") {
      if (!state.resolved.includes(id)) state.resolved.push(id);
      saveState(state);
      placeCard(card, true);
      refreshCounts();
      showFlash("Moved to Resolved");
      return;
    }

    if (action === "unresolve") {
      state.resolved = state.resolved.filter((x) => x !== id);
      saveState(state);
      placeCard(card, false);
      refreshCounts();
      showFlash("Restored to Open");
      return;
    }

    if (action === "save-comment") {
      const box = card.querySelector('[data-field="simple-comment"]');
      if (box instanceof HTMLTextAreaElement) {
        state.comments[id] = box.value.trim();
        saveState(state);
        showFlash("Comment saved");
      }
      return;
    }

    if (action === "reset-comment") {
      const box = card.querySelector('[data-field="simple-comment"]');
      if (box instanceof HTMLTextAreaElement) {
        box.value = decodeURIComponent(originalComment(card));
        delete state.comments[id];
        saveState(state);
        showFlash("Reset to original");
      }
      return;
    }

    if (action === "copy-simple") {
      const box = card.querySelector('[data-field="simple-comment"]');
      const text = box instanceof HTMLTextAreaElement
        ? box.value
        : decodeURIComponent(originalComment(card));
      try {
        await navigator.clipboard.writeText(text);
        target.classList.add("copied");
        const label = target.getAttribute("data-label") || "Copy comment";
        target.textContent = "Copied";
        setTimeout(() => {
          target.classList.remove("copied");
          target.textContent = label;
        }, 1200);
      } catch {
        target.textContent = "Copy failed";
      }
      return;
    }

    if (action === "copy-agent") {
      const packet = decodeURIComponent(card.getAttribute("data-agent-packet") || "");
      const notesBox = card.querySelector('[data-field="notes"]');
      const commentBox = card.querySelector('[data-field="simple-comment"]');
      const notes = notesBox instanceof HTMLTextAreaElement ? notesBox.value.trim() : "";
      const comment = commentBox instanceof HTMLTextAreaElement ? commentBox.value.trim() : "";
      let text = packet;
      if (comment) text += "\\n\\n## Edited paste comment\\n" + comment;
      if (notes) text += "\\n\\n## My notes\\n" + notes;
      try {
        await navigator.clipboard.writeText(text);
        target.classList.add("copied");
        const label = target.getAttribute("data-label") || "Copy for agent";
        target.textContent = "Copied";
        setTimeout(() => {
          target.classList.remove("copied");
          target.textContent = label;
        }, 1200);
        showFlash("Copied finding for another agent");
      } catch {
        target.textContent = "Copy failed";
      }
      return;
    }

    if (action === "save-notes") {
      const box = card.querySelector('[data-field="notes"]');
      if (box instanceof HTMLTextAreaElement) {
        state.notes[id] = box.value;
        saveState(state);
        showFlash("Notes saved");
      }
    }
  });
})();
</script>`;
}

export function renderFinalReviewHtml(run: ReviewRun): string {
  const issues = run.findings.filter((f) => f.kind !== "praise");
  const praise = run.findings.filter((f) => f.kind === "praise");
  const judge = run.judge;

  const link = {
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
  };
  const cards = [
    ...issues.map((f, i) => cardHtml(f, i + 1, run.prNumber, link)),
    ...praise.map((f, i) => cardHtml(f, i + 1, run.prNumber, link)),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR #${run.prNumber} — Final Review</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #121414;
      --bg-elevated: #1a1c1c;
      --ink: #e2e2e2;
      --muted: #bec8d1;
      --card: #1e2020;
      --line: #3e4850;
      --accent: #4fc1ff;
      --accent-hover: #84cfff;
      --code-bg: #1e1e1e;
      --comment-bg: #1b3a4b;
      --blocker: #f14c4c;
      --major: #dcdcaa;
      --minor: #9cdcfe;
      --nit: #808080;
      --question: #c586c0;
      --button-fg: #ffffff;
      --copied: #388a34;
      --gutter: #858585;
      --tab-bg: #2d2d2d;
      --tab-active: #1e1e1e;
      --breadcrumb: #cccccc;
      --fg: #d4d4d4;
      --resolved: #3d7a45;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      font-family: "Hanken Grotesk", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      color: var(--ink);
      background: var(--bg);
      line-height: 20px;
    }
    main { max-width: 960px; margin: 0 auto; padding: 2.25rem 1.25rem 4rem; }
    h1 { font-size: 1.85rem; margin: 0 0 0.45rem; font-weight: 600; color: #ffffff; }
    h2 { margin: 0 0 0.35rem; font-size: 1.2rem; font-weight: 600; color: #ffffff; }
    h3 {
      margin: 1rem 0 0.4rem;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    .lede { color: var(--muted); margin-bottom: 1.5rem; }
    .summary {
      background: var(--bg-elevated);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1.1rem 1.25rem;
      margin-bottom: 1.5rem;
    }
    .progress {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 0.75rem;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .progress strong { color: #ffffff; }
    #flash {
      margin-top: 0.65rem;
      color: #b5cea8;
      font-size: 0.88rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1.1rem 1.25rem;
      margin: 0.9rem 0 1.2rem;
    }
    .card.is-resolved { border-left: 4px solid var(--resolved); opacity: 0.92; }
    .card[data-severity="blocker"] { border-left: 4px solid var(--blocker); }
    .card[data-severity="major"] { border-left: 4px solid var(--major); }
    .card[data-severity="minor"] { border-left: 4px solid var(--minor); }
    .card[data-severity="nit"], .card[data-severity="suggestion"] { border-left: 4px solid var(--nit); }
    .card[data-severity="question"] { border-left: 4px solid var(--question); }
    .card.is-resolved[data-severity] { border-left-color: var(--resolved); }
    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
    }
    .card-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
    .meta { margin: 0; color: var(--muted); font-size: 0.9rem; }
    .meta a.file-link { color: var(--accent); text-decoration: none; }
    .meta a.file-link:hover { color: var(--accent-hover); text-decoration: underline; }
    .meta a.file-link code { color: inherit; }
    .meta code {
      color: #9cdcfe;
      background: #2d2d2d;
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.86rem;
    }
    p { margin: 0.35rem 0 0.55rem; color: var(--fg); }
    .hint { color: var(--muted); font-size: 0.86rem; margin: 0.2rem 0 0.55rem; }
    .review-workspace { margin-top: 0.75rem; }
    textarea.simple-comment, textarea.notes {
      width: 100%;
      resize: vertical;
      background: #0d0e0f;
      color: #e2e2e2;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 10px 12px;
      font: 13px/20px "JetBrains Mono", ui-monospace, monospace;
      color-scheme: dark;
    }
    textarea.simple-comment:focus, textarea.notes:focus {
      outline: 1px solid var(--accent);
      border-color: var(--accent);
    }
    .toolbar-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    details.details-block {
      margin-top: 0.75rem;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.55rem 0.85rem 0.75rem;
      background: #222223;
    }
    details.details-block > summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      list-style: none;
    }
    details.details-block > summary::-webkit-details-marker { display: none; }
    details.details-block[open] > summary { margin-bottom: 0.45rem; color: #cccccc; }

    .editor {
      margin-top: 0.45rem;
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: var(--code-bg);
    }
    .editor-titlebar {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: #2d2d2d;
      border-bottom: 1px solid var(--line);
      min-height: 34px;
      padding: 0 0.4rem;
    }
    .editor-tab {
      background: var(--tab-bg);
      color: #bbbbbb;
      font-size: 0.82rem;
      padding: 0.42rem 0.75rem;
      border-right: 1px solid var(--line);
      max-width: 70%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .editor-tab.active {
      background: var(--tab-active);
      color: #ffffff;
      box-shadow: inset 0 2px 0 var(--accent);
    }
    .editor-lang {
      margin-left: auto;
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding-right: 0.35rem;
    }
    .editor-breadcrumb {
      background: #252526;
      color: var(--breadcrumb);
      font-size: 0.75rem;
      padding: 0.28rem 0.75rem;
      border-bottom: 1px solid var(--line);
      font-family: "JetBrains Mono", ui-monospace, monospace;
      overflow: auto;
      white-space: nowrap;
    }
    .editor-body { overflow: auto; background: var(--code-bg); }
    .editor-code {
      margin: 0;
      padding: 0.5rem 0;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.9rem;
      line-height: 1.6;
      min-width: max-content;
    }
    .editor-row {
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr);
    }
    .editor-row:hover { background: #2a2a2a; }
    .editor-gutter {
      color: var(--gutter);
      text-align: right;
      padding: 0 14px 0 8px;
      user-select: none;
      border-right: 1px solid #2b2b2b;
      background: #1e1e1e;
    }
    .editor-line {
      padding: 0 16px 0 14px;
      white-space: pre;
      color: #d4d4d4;
    }
    .tok-keyword { color: #569cd6; }
    .tok-string { color: #ce9178; }
    .tok-comment { color: #6a9955; }
    .tok-number { color: #b5cea8; }
    .tok-type { color: #4ec9b0; }

    .editor-comment .editor-titlebar { background: #243b4a; }
    .editor-comment .editor-tab.active {
      background: var(--comment-bg);
      box-shadow: inset 0 2px 0 var(--accent);
    }
    .comment-body {
      margin: 0;
      padding: 0.95rem 1rem;
      white-space: pre-wrap;
      color: #e6edf3;
      background: var(--comment-bg);
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.9rem;
      line-height: 1.55;
    }

    .copy-row { margin: 0.35rem 0 0.5rem; }
    button {
      border: 1px solid transparent;
      background: var(--accent);
      color: var(--button-fg);
      border-radius: 4px;
      padding: 0.4rem 0.8rem;
      font: 600 0.82rem "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    button.copied { background: var(--copied); }
    button.btn-secondary {
      background: #2d2d2d;
      border-color: var(--line);
      color: #d4d4d4;
    }
    button.btn-secondary:hover { background: #3a3a3a; }
    ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
    li { margin: 0.15rem 0; }
    a { color: var(--accent); }
    .chip {
      display: inline-block;
      background: #2d2d2d;
      border: 1px solid var(--line);
      color: #9cdcfe;
      border-radius: 4px;
      padding: 0.05rem 0.4rem;
      font-size: 0.78rem;
      font-family: "JetBrains Mono", ui-monospace, monospace;
    }
    .stance {
      color: var(--muted);
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    ul.views { list-style: none; padding-left: 0; }
    ul.views li { margin: 0.35rem 0; }
    .agents { margin-top: 0; }
    .agents a { color: var(--accent); }
    .agent-findings-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      margin: 0.35rem 0 0.85rem;
      padding: 0 0 8px;
      border-bottom: 1px solid var(--line);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .agent-findings-nav a { color: var(--accent); }
    ${workspaceChromeCss()}
    .section-title { margin-top: 2rem; }
  </style>
</head>
<body class="wb-page">
  ${workspaceChromeOpenHtml({ prNumber: run.prNumber, active: "list" })}
  <main data-pr="${run.prNumber}">
    <h1>PR #${run.prNumber} — Final Review</h1>
    <p class="lede">${escapeHtml(run.title ?? "")}${run.demo ? " · demo mode" : ""}${run.agent ? ` · agent ${escapeHtml(run.agent)}` : ""} · <a href="triage.html">Open triage (one at a time)</a></p>
    ${agentFindingsNavHtml(run, escapeHtml)}
    ${agentsSummaryHtml(run)}
    ${run.overview ? renderOverviewHtml(run.overview, escapeHtml) : ""}
    <section class="summary">
      <h2>Merge readiness</h2>
      <p><strong>${escapeHtml(judge?.readiness ?? "unknown")}</strong>${judge?.score !== undefined ? ` · ${judge.score}/100` : ""}</p>
      <ul>
        <li>Blockers: ${judge?.counts.blocker ?? 0}</li>
        <li>Majors: ${judge?.counts.major ?? 0}</li>
        <li>Minors: ${judge?.counts.minor ?? 0}</li>
        <li>Nits: ${judge?.counts.nit ?? 0}</li>
        <li>Questions: ${judge?.counts.question ?? 0}</li>
      </ul>
      <div class="progress">
        <span>Open: <strong id="open-count">${issues.length + praise.length}</strong></span>
        <span>Resolved: <strong id="resolved-count">0</strong></span>
        <span class="hint" style="margin:0">Resolved state + your comments stay in this browser.</span>
      </div>
      <p id="flash" hidden></p>
    </section>

    <h2 class="section-title">Open findings</h2>
    <div id="open-findings">
      ${cards}
    </div>

    <h2 id="resolved-heading" class="section-title" hidden>Resolved</h2>
    <div id="resolved-findings" hidden></div>
  </main>
  ${workspaceChromeCloseHtml()}
  ${clientScript(run.prNumber)}
</body>
</html>`;
}
