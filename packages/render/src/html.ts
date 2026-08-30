import type { Finding, ReviewRun } from "@review-os/schemas";
import { isFindingOpen } from "@review-os/schemas";
import {
  buildFindingFixBrief,
  buildReviewFixBriefMarkdown,
  reviewFixBriefFilename,
} from "./agent-export.js";
import { githubFileUrl } from "./github-file-link.js";
import { renderOverviewHtml } from "./overview.js";
import { agentFindingsNavHtml, latestRunPerAgent, workspaceChromeCloseHtml, workspaceChromeCss, workspaceChromeHeadHtml, workspaceChromeOpenHtml } from "./agent-nav.js";
import { iconHtml, iconTextHtml } from "./ui-icons.js";
import { Help, tip } from "./ui-help.js";

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

/** disposition="fixed" purely from an existing-thread "skip" match, not an author code fix. */
function isExternallyCoveredOnly(finding: Finding): boolean {
  const status = finding.verification?.status;
  return (
    finding.externalMatch?.action === "skip" &&
    status !== "resolved" &&
    status !== "accepted"
  );
}

function externalMatchHtml(finding: Finding): string {
  const match = finding.externalMatch;
  if (!match) return "";
  const authorLine = match.url
    ? `<a href="${escapeHtml(match.url)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(match.author)}</a>`
    : `@${escapeHtml(match.author)}`;
  const note =
    match.action === "follow_up" && match.followUpComment
      ? `<p><strong>Follow-up (adds to what's already said):</strong> ${escapeHtml(match.followUpComment)}</p>`
      : `<p>Already covered — no comment needed here.</p>`;
  return `<section class="external-match">
    <p class="external-match-badge" ${tip(Help.badgeExternalMatch)}>${iconTextHtml("message-circle", "Already flagged by " + authorLine)}</p>
    <p class="meta">${escapeHtml(match.threadExcerpt)}</p>
    ${note}
  </section>`;
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
  return buildFindingFixBrief(finding, prNumber);
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
      <button type="button" class="has-ico" data-action="copy-agent" data-label="Copy fix brief" ${tip(Help.copyFixBrief)}>${iconTextHtml("clipboard", "Copy fix brief")}</button>
      <button type="button" class="btn-secondary has-ico" data-action="resolve" ${tip(Help.cardResolve)}>${iconTextHtml("check", "Resolved")}</button>
      <button type="button" class="btn-secondary has-ico" data-action="unresolve" hidden ${tip(Help.cardRestore)}>${iconTextHtml("undo", "Restore")}</button>
    </div>
  </header>
  ${
    finding.disposition === "false_alarm"
      ? `<p class="meta">False alarm${finding.falseAlarmNote ? ` — ${escapeHtml(finding.falseAlarmNote)}` : ""}</p>`
      : finding.disposition === "fixed"
        ? isExternallyCoveredOnly(finding)
          ? `<p class="meta">Already flagged — covered by an existing GitHub comment, not an author code fix</p>`
          : `<p class="meta">Fixed${finding.verification?.summary ? ` — ${escapeHtml(finding.verification.summary)}` : finding.verification?.status ? ` (${escapeHtml(finding.verification.status)})` : ""}</p>`
        : ""
  }
  ${externalMatchHtml(finding)}
  ${viewsHtml(finding)}
  <section>
    <h3>Current code</h3>
    <div class="copy-row">
      <button type="button" class="has-ico" data-copy="${encodeCopyPayload(finding.currentCode)}" data-label="Copy code" ${tip(Help.copyCode)}>${iconTextHtml("copy", "Copy code")}</button>
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
        <button type="button" class="has-ico" data-copy="${encodeCopyPayload(finding.betterCode)}" data-label="Copy fix" ${tip(Help.copyBetter)}>${iconTextHtml("copy", "Copy fix")}</button>
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
    <h3 class="has-tip" ${tip(Help.sectionComment)}>Your paste comment (keep it short)</h3>
    <p class="hint">Edit this into the simple GitHub comment you want. Saved in this browser for PR #${prNumber}.</p>
    <textarea class="simple-comment" rows="4" data-field="simple-comment" placeholder="Short polite comment to paste on GitHub…" ${tip(Help.sectionComment)}>${escapeHtml(finding.reviewComment)}</textarea>
    <div class="copy-row toolbar-row">
      <button type="button" class="has-ico" data-action="save-comment" ${tip(Help.saveComment)}>${iconTextHtml("save", "Save comment")}</button>
      <button type="button" class="has-ico" data-action="copy-simple" data-label="Copy comment" ${tip(Help.copyComment)}>${iconTextHtml("copy", "Copy comment")}</button>
      <button type="button" class="btn-secondary has-ico" data-action="reset-comment" ${tip(Help.resetComment)}>${iconTextHtml("rotate-ccw", "Reset to original")}</button>
    </div>
    <details class="details-block">
      <summary ${tip(Help.originalComment)}>Original generated comment</summary>
      <div class="copy-row">
        <button type="button" class="has-ico" data-copy="${encodeCopyPayload(finding.reviewComment)}" data-label="Copy original" ${tip(Help.originalComment)}>${iconTextHtml("copy", "Copy original")}</button>
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
    <h3 class="has-tip" ${tip(Help.saveNotes)}>Double-check notes</h3>
    <p class="hint">After you verify in chat, jot the verdict here (stands / skip / soft). Local only.</p>
    <textarea class="notes" rows="3" data-field="notes" placeholder="e.g. Verified — post. Or: false positive, skip." ${tip(Help.saveNotes)}></textarea>
    <div class="copy-row">
      <button type="button" class="btn-secondary has-ico" data-action="save-notes" ${tip(Help.saveNotes)}>${iconTextHtml("save", "Save notes")}</button>
    </div>
  </section>
</article>`;
}

function clientScript(
  prNumber: number,
  fixBriefMd: string,
  fixBriefFilename: string,
): string {
  return `<script>
(function () {
  const PR = ${prNumber};
  const FIX_BRIEF_MD = ${JSON.stringify(fixBriefMd)};
  const FIX_BRIEF_FILENAME = ${JSON.stringify(fixBriefFilename)};
  const STORAGE_KEY = "review-os:pr-" + PR + ":triage:v1";

  function setBtnLabel(el, text) {
    if (!el) return;
    const lab = el.querySelector(".btn-label");
    if (lab) lab.textContent = text;
    else el.textContent = text;
  }

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

  function collectOpenFixBrief() {
    const cards = openRoot ? openRoot.querySelectorAll(".card[data-agent-packet]") : [];
    if (!cards.length) return FIX_BRIEF_MD;
    const parts = [
      "# PR #" + PR + " — fix brief for coding agent",
      "",
      "Open findings on this List page (" + cards.length + "). Paste into your coding agent to verify and fix.",
      "",
      "---",
      "",
    ];
    cards.forEach(function (card, index) {
      const packet = decodeURIComponent(card.getAttribute("data-agent-packet") || "");
      if (!packet) return;
      parts.push("## Finding " + (index + 1), "", packet, "", "---", "");
    });
    return parts.join("\\n").trim() + "\\n";
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyFixBriefAll() {
    const text = collectOpenFixBrief();
    try {
      await navigator.clipboard.writeText(text);
      showFlash("Copied all open fix briefs — paste into your coding agent");
    } catch {
      showFlash("Copy failed");
    }
  }

  function downloadFixBrief() {
    downloadText(FIX_BRIEF_FILENAME, collectOpenFixBrief());
    showFlash("Downloaded " + FIX_BRIEF_FILENAME);
  }

  const copyAllBtn = document.getElementById("btn-copy-all-fix");
  const downloadBtn = document.getElementById("btn-download-fix");
  if (copyAllBtn) copyAllBtn.addEventListener("click", copyFixBriefAll);
  if (downloadBtn) downloadBtn.addEventListener("click", downloadFixBrief);

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

  document.querySelectorAll("#open-findings .card[data-finding-id], #resolved-findings .card[data-finding-id]").forEach(applyStateToCard);
  refreshCounts();

  // --- Verify all open (same API as triage; no findingIds) ---
  const SERVED = location.protocol === "http:" || location.protocol === "https:";
  const BASE = (function () {
    var p = location.pathname || "/";
    var parts = p.split("/");
    if (parts[1] === "pr" && /^[0-9]+$/.test(parts[2] || "")) {
      return "/pr/" + parts[2];
    }
    if (p.endsWith("/final-review.html")) p = p.slice(0, -"/final-review.html".length);
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p === "/" ? "" : p;
  })();
  function apiUrl(path) {
    return BASE + "/api" + path;
  }

  var verifyBtn = document.getElementById("btn-verify");
  var verifyStatus = document.getElementById("verify-status");
  var verifyLive = document.getElementById("verify-live");
  var verifyLogs = document.getElementById("verify-logs");
  var verifyPanel = document.getElementById("verify-panel");
  var verifying = false;
  var verifyPollTimer = 0;
  var verifyJobId = "";
  var lastVerifyLogCount = 0;

  function selectedVerifyAgents() {
    return Array.from(document.querySelectorAll('input[name="verify-agent"]:checked'))
      .map(function (el) { return el instanceof HTMLInputElement ? el.value : ""; })
      .filter(Boolean);
  }

  function setVerifyUiRunning(running) {
    verifying = Boolean(running);
    if (verifyBtn) {
      verifyBtn.disabled = running || !SERVED;
      setBtnLabel(verifyBtn, running ? "Verifying…" : "Verify all open findings");
    }
    if (verifyPanel) verifyPanel.hidden = false;
  }

  function renderVerifyJob(job) {
    if (!job) return;
    if (verifyPanel) verifyPanel.hidden = false;
    var progress = job.progress;
    var headline =
      job.status === "running"
        ? "VERIFYING"
        : job.status === "done"
          ? "VERIFY DONE"
          : "VERIFY FAILED";
    if (verifyStatus) {
      verifyStatus.hidden = false;
      verifyStatus.className = "verify-status " + job.status;
      if (job.status === "done" && job.counts) {
        var c = job.counts;
        verifyStatus.innerHTML =
          headline +
          " · resolved " + (c.resolved || 0) +
          " · accepted " + (c.accepted || 0) +
          " · needs look " + (c.needs_look || 0) +
          " · still open " + (c.still_open || 0) +
          ' · <a href="verify-report.html">Open report</a>';
      } else if (job.status === "error") {
        verifyStatus.textContent = headline + " · " + (job.error || "unknown error");
      } else {
        verifyStatus.textContent =
          headline + (progress && progress.label ? " · " + progress.label : "");
      }
    }
    if (verifyLive) {
      verifyLive.hidden = false;
      var ageMs = Date.now() - Date.parse(job.updatedAt || job.createdAt || "");
      var age =
        !Number.isFinite(ageMs) || ageMs < 0
          ? ""
          : ageMs < 5000
            ? "just now"
            : Math.round(ageMs / 1000) + "s ago";
      verifyLive.textContent =
        (job.status || "") +
        (progress && progress.label ? " · " + progress.label : "") +
        (age ? " · " + age : "");
    }
    if (verifyLogs) {
      var logs = Array.isArray(job.logs) ? job.logs : [];
      verifyLogs.textContent = logs.join("\\n");
      if (logs.length !== lastVerifyLogCount) {
        verifyLogs.scrollTop = verifyLogs.scrollHeight;
        lastVerifyLogCount = logs.length;
      }
    }
  }

  function stopVerifyPoll() {
    if (verifyPollTimer) {
      window.clearInterval(verifyPollTimer);
      verifyPollTimer = 0;
    }
  }

  async function pollVerifyJob() {
    if (!verifyJobId) return;
    try {
      var res = await fetch(apiUrl("/verify/" + verifyJobId));
      var job = await res.json();
      renderVerifyJob(job);
      if (job.status === "done" || job.status === "error") {
        stopVerifyPoll();
        setVerifyUiRunning(false);
        if (job.status === "done") {
          var c = job.counts || {};
          showFlash(
            "Verify done · resolved " +
              (c.resolved || 0) +
              " · accepted " +
              (c.accepted || 0) +
              " — refreshing…",
          );
          window.setTimeout(function () { location.reload(); }, 900);
        } else {
          showFlash(job.error || "Verify failed");
        }
      } else {
        setVerifyUiRunning(true);
      }
    } catch (e) {
      if (verifyLive) {
        verifyLive.hidden = false;
        verifyLive.textContent = "Poll error — retrying…";
      }
    }
  }

  function startVerifyPoll(id) {
    verifyJobId = id;
    stopVerifyPoll();
    verifyPollTimer = window.setInterval(pollVerifyJob, 1000);
    pollVerifyJob();
  }

  async function loadVerifyAgents() {
    if (!SERVED || !verifyBtn) return;
    try {
      var res = await fetch(apiUrl("/providers"));
      var body = await res.json();
      var list = Array.isArray(body.providers) ? body.providers : [];
      var cliOnly = list.filter(function (id) {
        return id !== "demo" && id !== "openai" && id !== "anthropic";
      });
      var agentBox = document.getElementById("verify-agents");
      if (agentBox) {
        agentBox.innerHTML = "";
        var source = cliOnly.length ? cliOnly : list;
        source.forEach(function (id, idx) {
          var label = document.createElement("label");
          var box = document.createElement("input");
          box.type = "checkbox";
          box.name = "verify-agent";
          box.value = id;
          box.checked = idx === 0;
          label.appendChild(box);
          label.appendChild(document.createTextNode(" " + id));
          agentBox.appendChild(label);
        });
      }
      verifyBtn.disabled = verifying || !sourceHasAgents(cliOnly.length ? cliOnly : list);
    } catch (e) {
      verifyBtn.disabled = true;
    }
  }

  function sourceHasAgents(list) {
    return Array.isArray(list) && list.length > 0;
  }

  async function attachActiveVerify() {
    if (!SERVED) return;
    try {
      var res = await fetch(apiUrl("/verify/active"));
      var body = await res.json();
      if (body && body.job) {
        renderVerifyJob(body.job);
        if (body.job.status === "running") {
          setVerifyUiRunning(true);
          startVerifyPoll(body.job.id);
        }
      }
    } catch (e) { /* ignore */ }
  }

  async function verifyAuthorUpdates() {
    if (!SERVED || verifying) return;
    var agents = selectedVerifyAgents();
    if (!agents.length) {
      showFlash("Pick at least one agent for verify");
      return;
    }
    setVerifyUiRunning(true);
    lastVerifyLogCount = 0;
    if (verifyStatus) {
      verifyStatus.hidden = false;
      verifyStatus.className = "verify-status running";
      verifyStatus.textContent = "Starting verify with " + agents.join(", ") + "…";
    }
    if (verifyLive) {
      verifyLive.hidden = false;
      verifyLive.textContent = "Starting…";
    }
    if (verifyLogs) verifyLogs.textContent = "";
    try {
      var res = await fetch(apiUrl("/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: agents }),
      });
      var body = await res.json();
      if (res.status === 409 && body.jobId) {
        showFlash("Already verifying — showing live progress");
        startVerifyPoll(body.jobId);
        if (body.job) renderVerifyJob(body.job);
        return;
      }
      if (!res.ok) throw new Error(body.error || "Verify failed to start");
      var jobId = body.jobId || (body.job && body.job.id);
      if (!jobId) throw new Error("Verify job did not return an id");
      if (body.job) renderVerifyJob(body.job);
      startVerifyPoll(jobId);
    } catch (e) {
      setVerifyUiRunning(false);
      showFlash(e && e.message ? e.message : "Verify failed");
      if (verifyStatus) {
        verifyStatus.hidden = false;
        verifyStatus.className = "verify-status error";
        verifyStatus.textContent = e && e.message ? e.message : "Verify failed";
      }
    }
  }

  if (verifyBtn) verifyBtn.addEventListener("click", verifyAuthorUpdates);
  loadVerifyAgents();
  attachActiveVerify();

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const encoded = button.getAttribute("data-copy") || "";
      const value = decodeURIComponent(encoded);
      const label = button.getAttribute("data-label") || "Copy";
      try {
        await navigator.clipboard.writeText(value);
        button.classList.add("copied");
        setBtnLabel(button, "Copied");
        setTimeout(() => {
          button.classList.remove("copied");
          setBtnLabel(button, label);
        }, 1200);
      } catch {
        setBtnLabel(button, "Copy failed");
      }
    });
  });

  document.addEventListener("click", async (event) => {
    const raw = event.target;
    if (!(raw instanceof Element)) return;
    const target = raw.closest("[data-action]");
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
        setBtnLabel(target, "Copied");
        setTimeout(() => {
          target.classList.remove("copied");
          setBtnLabel(target, label);
        }, 1200);
      } catch {
        setBtnLabel(target, "Copy failed");
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
        const label = target.getAttribute("data-label") || "Copy fix brief";
        setBtnLabel(target, "Copied");
        setTimeout(() => {
          target.classList.remove("copied");
          setBtnLabel(target, label);
        }, 1200);
        showFlash("Copied fix brief — paste into your coding agent");
      } catch {
        setBtnLabel(target, "Copy failed");
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
  const openFindings = run.findings.filter((f) => isFindingOpen(f));
  const fixedFindings = run.findings.filter((f) => f.disposition === "fixed");
  const issues = openFindings.filter((f) => f.kind !== "praise");
  const praise = openFindings.filter((f) => f.kind === "praise");
  const judge = run.judge;
  const fixBriefMd = buildReviewFixBriefMarkdown(run);
  const fixBriefFilename = reviewFixBriefFilename(run.prNumber);

  const link = {
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
  };
  const cards = [
    ...issues.map((f, i) => cardHtml(f, i + 1, run.prNumber, link)),
    ...praise.map((f, i) => cardHtml(f, i + 1, run.prNumber, link)),
  ].join("\n");
  const fixedCards = fixedFindings
    .map((f, i) => cardHtml(f, i + 1, run.prNumber, link))
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${workspaceChromeHeadHtml()}
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
    h1 { font-size: 1.85rem; margin: 0 0 0.45rem; font-weight: 600; color: #ffffff; display: flex; align-items: center; gap: 8px; }
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
      gap: 0.75rem;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      flex: 1 1 auto;
      justify-content: flex-end;
      min-width: 0;
      max-width: 100%;
    }
    .card-actions button {
      flex: 0 1 auto;
      white-space: nowrap;
    }
    @media (max-width: 720px) {
      .card-actions {
        justify-content: flex-start;
        width: 100%;
      }
    }
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
    .export-row {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      margin: 0.75rem 0 0;
    }
    .export-row .hint { flex: 1 1 220px; }
    button {
      border: 1px solid transparent;
      background: var(--accent);
      color: var(--button-fg);
      border-radius: 4px;
      padding: 0.4rem 0.8rem;
      font: 600 0.82rem "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
    .external-match {
      margin: 0.6rem 0;
      padding: 0.5rem 0.7rem;
      border: 1px solid #6b5a1f;
      background: #241f10;
      border-radius: 6px;
    }
    .external-match-badge {
      margin: 0 0 0.3rem;
      color: #e0c46a;
      font-weight: 600;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .external-match p { margin: 0.25rem 0; }
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
    .agent-findings-nav a { color: var(--accent); display: inline-flex; align-items: center; gap: 6px; }
    ${workspaceChromeCss()}
    .section-title { margin-top: 2rem; }
    .verify-row {
      margin-top: 1rem;
      padding-top: 0.85rem;
      border-top: 1px solid var(--line);
      display: grid;
      gap: 0.55rem;
    }
    .verify-agents {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem 0.85rem;
    }
    .verify-agents label {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: var(--muted);
      cursor: pointer;
    }
    .verify-panel { margin: 0; }
    .verify-status { margin: 0 0 0.35rem; font-weight: 600; }
    .verify-status.running { color: var(--major); }
    .verify-status.done { color: #9cdcfe; }
    .verify-status.error { color: var(--blocker); }
    .verify-logs {
      margin: 0;
      max-height: 10rem;
      overflow: auto;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--code-bg);
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.72rem;
      white-space: pre-wrap;
    }
  </style>
</head>
<body class="wb-page">
  ${workspaceChromeOpenHtml({ prNumber: run.prNumber, active: "list" })}
  <main data-pr="${run.prNumber}">
    <h1>${iconHtml("list")} PR #${run.prNumber} — Final Review</h1>
    <p class="lede">${escapeHtml(run.title ?? "")}${run.demo ? " · demo mode" : ""}${run.agent ? ` · agent ${escapeHtml(run.agent)}` : ""} · <a class="has-ico" href="triage.html">${iconHtml("list-checks")} Open triage (one at a time)</a></p>
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
        <span class="has-tip" ${tip(Help.listOpen)}>Open: <strong id="open-count">${issues.length + praise.length}</strong></span>
        <span class="has-tip" ${tip(Help.listBrowserResolved)}>Resolved: <strong id="resolved-count">0</strong></span>
        <span class="hint" style="margin:0">Browser Resolved is local; Verify fixed updates disk.</span>
      </div>
      <div class="export-row">
        <button type="button" class="has-ico" id="btn-copy-all-fix" ${tip(Help.copyAllFix)}>${iconTextHtml("clipboard", "Copy all open for agent")}</button>
        <button type="button" class="btn-secondary has-ico" id="btn-download-fix" ${tip(Help.downloadFix)}>${iconTextHtml("download", "Download .md")}</button>
        <span class="hint" style="margin:0">Paste into Cursor / Claude / Command Code to verify and fix on your branch.</span>
      </div>
      <div class="verify-row">
        <p class="hint" style="margin:0">Verify <strong>all open findings</strong> after the author pushed or replied. Pick agents, then run. Triage’s Verify checks only the card on screen.</p>
        <div class="verify-agents" id="verify-agents" aria-label="Agents for verify" ${tip(Help.verifyAgents)}></div>
        <button type="button" class="has-ico" id="btn-verify" disabled ${tip(Help.verifyAllBtn)}>${iconTextHtml("shield-check", "Verify all open findings")}</button>
        <section id="verify-panel" class="verify-panel" hidden>
          <p id="verify-status" class="verify-status"></p>
          <p id="verify-live" class="hint" hidden></p>
          <pre id="verify-logs" class="verify-logs" aria-live="polite"></pre>
        </section>
      </div>
      <p id="flash" hidden></p>
    </section>

    <h2 class="section-title has-tip" ${tip(Help.listOpen)}>Open findings</h2>
    <div id="open-findings">
      ${cards || `<p class="hint">No open findings.</p>`}
    </div>

    ${
      fixedFindings.length
        ? `<h2 class="section-title has-tip" ${tip(Help.listFixed)}>Fixed by verify (${fixedFindings.length})</h2>
    <div id="fixed-findings">
      ${fixedCards}
    </div>`
        : ""
    }

    <h2 id="resolved-heading" class="section-title has-tip" hidden ${tip(Help.listBrowserResolved)}>Resolved (this browser)</h2>
    <div id="resolved-findings" hidden></div>
  </main>
  ${workspaceChromeCloseHtml()}
  ${clientScript(run.prNumber, fixBriefMd, fixBriefFilename)}
</body>
</html>`;
}
