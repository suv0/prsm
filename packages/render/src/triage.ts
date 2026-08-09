import type { Finding, ReviewRun } from "@review-os/schemas";
import { renderOverviewHtml } from "./overview.js";
import { sortFindingsForTriage } from "./sort-findings.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

type TriageFinding = {
  id: string;
  storageId: string;
  kind: Finding["kind"];
  file: string;
  line: number;
  endLine?: number;
  severity: Finding["severity"];
  category: string;
  disposition: "open" | "false_alarm";
  falseAlarmNote?: string;
  issueSimple: string;
  whyWeak: string;
  howToFix: string;
  betterCode: string;
  currentCode: string;
  reviewComment: string;
  language: string;
};

function toTriageFinding(finding: Finding): TriageFinding {
  return {
    id: finding.id,
    storageId: encodeURIComponent(finding.id),
    kind: finding.kind,
    file: finding.file,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    severity: finding.severity,
    category: finding.category,
    disposition: finding.disposition ?? "open",
    ...(finding.falseAlarmNote !== undefined
      ? { falseAlarmNote: finding.falseAlarmNote }
      : {}),
    issueSimple: finding.issueSimple,
    whyWeak: finding.whyWeak,
    howToFix: finding.howToFix,
    betterCode: finding.betterCode,
    currentCode: finding.currentCode,
    reviewComment: finding.reviewComment,
    language: finding.language || "ts",
  };
}

function clientScript(): string {
  return `<script>
(function () {
  const data = window.__TRIAGE__;
  if (!data || !Array.isArray(data.findings)) return;

  const PR = data.prNumber;
  const STORAGE_KEY = "review-os:pr-" + PR + ":triage:v1";
  const SERVED = location.protocol === "http:" || location.protocol === "https:";
  let all = data.findings.slice();
  let queueIndex = 0;
  let showResolved = false;
  let showFalseAlarms = false;
  let rechecking = false;

  const els = {
    empty: document.getElementById("empty"),
    panel: document.getElementById("panel"),
    progress: document.getElementById("progress-text"),
    sev: document.getElementById("sev-badge"),
    faBadge: document.getElementById("fa-badge"),
    title: document.getElementById("finding-title"),
    meta: document.getElementById("finding-meta"),
    issue: document.getElementById("issue-simple"),
    code: document.getElementById("current-code"),
    why: document.getElementById("why-weak"),
    how: document.getElementById("how-fix"),
    better: document.getElementById("better-code"),
    comment: document.getElementById("simple-comment"),
    original: document.getElementById("original-comment"),
    notes: document.getElementById("notes"),
    flash: document.getElementById("flash"),
    resolveBtn: document.getElementById("btn-resolve"),
    restoreBtn: document.getElementById("btn-restore"),
    falseAlarmBtn: document.getElementById("btn-false-alarm"),
    reopenBtn: document.getElementById("btn-reopen"),
    showResolved: document.getElementById("show-resolved"),
    showFalseAlarms: document.getElementById("show-false-alarms"),
    provider: document.getElementById("provider"),
    recheckBtn: document.getElementById("btn-recheck"),
    serveHint: document.getElementById("serve-hint"),
    recheckStatus: document.getElementById("recheck-status"),
  };

  let flashTimer = 0;

  function showFlash(msg) {
    if (!els.flash) return;
    els.flash.textContent = msg;
    els.flash.hidden = false;
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(function () { els.flash.hidden = true; }, 2200);
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { resolved: [], comments: {}, notes: {} };
      var parsed = JSON.parse(raw);
      return {
        resolved: Array.isArray(parsed.resolved) ? parsed.resolved : [],
        comments: parsed.comments && typeof parsed.comments === "object" ? parsed.comments : {},
        notes: parsed.notes && typeof parsed.notes === "object" ? parsed.notes : {},
      };
    } catch (e) {
      return { resolved: [], comments: {}, notes: {} };
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  var state = loadState();

  function isResolved(f) {
    return state.resolved.indexOf(f.storageId) !== -1;
  }

  function isFalseAlarm(f) {
    return f.disposition === "false_alarm";
  }

  function queue() {
    return all.filter(function (f) {
      if (!showFalseAlarms && isFalseAlarm(f)) return false;
      if (!showResolved && isResolved(f)) return false;
      if (showFalseAlarms && !showResolved) {
        // when only viewing false alarms path via toggle, still allow FA items
      }
      return true;
    });
  }

  function lineLabel(f) {
    if (f.endLine && f.endLine !== f.line) return f.line + "–" + f.endLine;
    return String(f.line);
  }

  function current() {
    var q = queue();
    if (!q.length) return null;
    if (queueIndex < 0) queueIndex = 0;
    if (queueIndex >= q.length) queueIndex = q.length - 1;
    return q[queueIndex];
  }

  function clampIndex() {
    var q = queue();
    if (!q.length) {
      queueIndex = 0;
      return;
    }
    if (queueIndex >= q.length) queueIndex = q.length - 1;
    if (queueIndex < 0) queueIndex = 0;
  }

  function focusById(id) {
    var q = queue();
    var idx = q.findIndex(function (item) { return item.id === id; });
    if (idx >= 0) queueIndex = idx;
  }

  function findingFromApi(f) {
    return {
      id: f.id,
      storageId: encodeURIComponent(f.id),
      kind: f.kind,
      file: f.file,
      line: f.line,
      endLine: f.endLine,
      severity: f.severity,
      category: f.category,
      disposition: f.disposition || "open",
      falseAlarmNote: f.falseAlarmNote,
      issueSimple: f.issueSimple,
      whyWeak: f.whyWeak,
      howToFix: f.howToFix,
      betterCode: f.betterCode,
      currentCode: f.currentCode,
      reviewComment: f.reviewComment,
      language: f.language || "ts",
    };
  }

  function fileName(path) {
    var parts = String(path || "").replace(/\\\\/g, "/").split("/");
    return parts[parts.length - 1] || path || "file";
  }

  var KEYWORDS = {
    const:1, let:1, var:1, function:1, return:1, if:1, else:1, for:1, while:1,
    switch:1, case:1, break:1, continue:1, import:1, from:1, export:1, default:1,
    async:1, await:1, try:1, catch:1, throw:1, new:1, class:1, extends:1, type:1,
    interface:1, enum:1, public:1, private:1, protected:1, readonly:1, typeof:1,
    instanceof:1, null:1, undefined:1, true:1, false:1
  };

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightCodePart(input) {
    var tokenRe = /("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b[A-Za-z_][A-Za-z0-9_]*\\b)|(\\s+|.)/g;
    var out = "";
    var match;
    while ((match = tokenRe.exec(input)) !== null) {
      var full = match[0];
      var stringTok = match[1];
      var numberTok = match[2];
      var wordTok = match[3];
      if (stringTok !== undefined) {
        out += '<span class="tok-string">' + esc(stringTok) + "</span>";
      } else if (numberTok !== undefined) {
        out += '<span class="tok-number">' + esc(numberTok) + "</span>";
      } else if (wordTok !== undefined) {
        var lower = wordTok.toLowerCase();
        if (KEYWORDS[lower]) out += '<span class="tok-keyword">' + esc(wordTok) + "</span>";
        else if (/^[A-Z]/.test(wordTok)) out += '<span class="tok-type">' + esc(wordTok) + "</span>";
        else out += esc(wordTok);
      } else {
        out += esc(full);
      }
    }
    return out || "&nbsp;";
  }

  function highlightLine(line) {
    if (!line) return "&nbsp;";
    var commentMatch = /^(.*)(\\/\\/.*)$/.exec(line);
    if (commentMatch) {
      return highlightCodePart(commentMatch[1] || "") +
        '<span class="tok-comment">' + esc(commentMatch[2] || "") + "</span>";
    }
    return highlightCodePart(line);
  }

  function renderEditor(host, options) {
    if (!host) return;
    var code = String(options.code || "").replace(/\\r\\n/g, "\\n");
    var lines = code.split("\\n");
    var start = Math.max(1, options.startLine || 1);
    var lang = options.language || "ts";
    var file = options.file || "file";
    var name = fileName(file);
    var rows = lines.map(function (line, index) {
      var n = start + index;
      return '<div class="editor-row">' +
        '<span class="editor-gutter" aria-hidden="true">' + n + "</span>" +
        '<span class="editor-line">' + highlightLine(line) + "</span>" +
        "</div>";
    }).join("");
    host.innerHTML =
      '<div class="editor">' +
        '<div class="editor-titlebar">' +
          '<div class="editor-tab active" title="' + esc(file) + '">' + esc(name) + "</div>" +
          '<div class="editor-lang">' + esc(lang) + "</div>" +
        "</div>" +
        '<div class="editor-breadcrumb">' + esc(file) + ":" + start + "</div>" +
        '<div class="editor-body">' +
          '<div class="editor-code" role="region" aria-label="Code">' + rows + "</div>" +
        "</div>" +
      "</div>";
  }

  function paint() {
    clampIndex();
    var q = queue();
    var f = current();
    var resolvedCount = state.resolved.length;
    var falseAlarmCount = all.filter(isFalseAlarm).length;
    var openCount = all.filter(function (item) {
      return !isFalseAlarm(item) && !isResolved(item);
    }).length;

    if (els.progress) {
      els.progress.textContent =
        "Open " + openCount +
        " · False alarms " + falseAlarmCount +
        " · Resolved " + resolvedCount +
        (f ? " · Card " + (queueIndex + 1) + " / " + q.length : "");
    }

    if (!f) {
      if (els.empty) els.empty.hidden = false;
      if (els.panel) els.panel.hidden = true;
      return;
    }

    if (els.empty) els.empty.hidden = true;
    if (els.panel) els.panel.hidden = false;

    var resolved = isResolved(f);
    var falseAlarm = isFalseAlarm(f);
    if (els.sev) {
      els.sev.textContent = f.severity;
      els.sev.setAttribute("data-severity", f.severity);
    }
    if (els.faBadge) els.faBadge.hidden = !falseAlarm;
    if (els.title) {
      els.title.textContent = falseAlarm
        ? "False alarm — was " + f.severity
        : (f.kind === "praise" ? "Praise" : "Finding") + " — " + f.severity;
    }
    if (els.meta) {
      els.meta.innerHTML = "<code></code> · Line " + lineLabel(f);
      els.meta.querySelector("code").textContent = f.file;
    }
    if (els.issue) {
      els.issue.textContent = falseAlarm && f.falseAlarmNote
        ? f.falseAlarmNote
        : f.issueSimple;
    }
    renderEditor(els.code, {
      code: f.currentCode,
      file: f.file,
      language: f.language || "ts",
      startLine: f.line,
    });
    if (els.why) els.why.textContent = f.whyWeak;
    if (els.how) els.how.textContent = f.howToFix;
    renderEditor(els.better, {
      code: f.betterCode,
      file: f.file,
      language: f.language || "ts",
      startLine: f.line,
    });
    if (els.original) els.original.textContent = f.reviewComment;
    if (els.comment) {
      els.comment.value = state.comments[f.storageId] || f.reviewComment;
    }
    if (els.notes) {
      els.notes.value = state.notes[f.storageId] || "";
    }
    if (els.resolveBtn) els.resolveBtn.hidden = resolved;
    if (els.restoreBtn) els.restoreBtn.hidden = !resolved;
    if (els.falseAlarmBtn) els.falseAlarmBtn.hidden = falseAlarm || !SERVED;
    if (els.reopenBtn) els.reopenBtn.hidden = !falseAlarm || !SERVED;
    if (els.panel) {
      els.panel.classList.toggle("is-resolved", resolved);
      els.panel.classList.toggle("is-false-alarm", falseAlarm);
    }
    if (els.recheckBtn) els.recheckBtn.disabled = !SERVED || rechecking;
  }

  function go(delta) {
    var q = queue();
    if (!q.length) return;
    queueIndex = Math.max(0, Math.min(q.length - 1, queueIndex + delta));
    paint();
  }

  function toggleResolve(resolve) {
    var f = current();
    if (!f) return;
    if (resolve) {
      if (state.resolved.indexOf(f.storageId) === -1) state.resolved.push(f.storageId);
      saveState(state);
      if (!showResolved) clampIndex();
      showFlash("Resolved");
    } else {
      state.resolved = state.resolved.filter(function (id) { return id !== f.storageId; });
      saveState(state);
      showFlash("Restored");
    }
    paint();
  }

  function saveComment() {
    var f = current();
    if (!f || !(els.comment instanceof HTMLTextAreaElement)) return;
    state.comments[f.storageId] = els.comment.value.trim();
    saveState(state);
    showFlash("Comment saved");
  }

  function resetComment() {
    var f = current();
    if (!f || !(els.comment instanceof HTMLTextAreaElement)) return;
    els.comment.value = f.reviewComment;
    delete state.comments[f.storageId];
    saveState(state);
    showFlash("Reset to original");
  }

  async function copyText(label, text) {
    try {
      await navigator.clipboard.writeText(String(text || ""));
      showFlash(label + " copied");
    } catch (e) {
      showFlash("Copy failed");
    }
  }

  async function copyComment() {
    var f = current();
    if (!f) return;
    var text = els.comment instanceof HTMLTextAreaElement ? els.comment.value : f.reviewComment;
    await copyText("Comment", text);
  }

  async function copyCurrentCode() {
    var f = current();
    if (!f) return;
    await copyText("Current code", f.currentCode);
  }

  async function copyBetterCode() {
    var f = current();
    if (!f) return;
    await copyText("Better code", f.betterCode);
  }

  async function copyOriginalComment() {
    var f = current();
    if (!f) return;
    await copyText("Original comment", f.reviewComment);
  }

  async function copyNotes() {
    var f = current();
    if (!f) return;
    var notes = els.notes instanceof HTMLTextAreaElement ? els.notes.value : "";
    await copyText("Notes", notes);
  }

  function buildAgentPacket(f) {
    var notes = els.notes instanceof HTMLTextAreaElement ? els.notes.value.trim() : "";
    var comment = els.comment instanceof HTMLTextAreaElement
      ? els.comment.value.trim()
      : (f.reviewComment || "");
    var line = lineLabel(f);
    return [
      "Please verify this PR review finding. Is it a real issue, should it be softened, or is it a false alarm?",
      "",
      "PR #" + PR,
      "Finding id: " + f.id,
      "Disposition: " + (f.disposition || "open"),
      "Severity: " + f.severity,
      "Category: " + f.category,
      "File: " + f.file,
      "Line: " + line,
      "",
      "## Issue (simple)",
      f.issueSimple || "",
      "",
      "## Why weak",
      f.whyWeak || "",
      "",
      "## How to fix",
      f.howToFix || "",
      "",
      "## Current code",
      "\`\`\`",
      f.currentCode || "",
      "\`\`\`",
      "",
      "## Better code",
      "\`\`\`",
      f.betterCode || "",
      "\`\`\`",
      "",
      "## Paste comment",
      comment,
      "",
      "## My notes",
      notes || "(none)",
      "",
      "Reply with: stand | update (what to change) | false alarm (why). Keep any revised reviewComment to 1–3 short sentences.",
    ].join("\\n");
  }

  async function copyForAgent() {
    var f = current();
    if (!f) return;
    var text = buildAgentPacket(f);
    try {
      await navigator.clipboard.writeText(text);
      showFlash("Copied finding for another agent");
    } catch (e) {
      showFlash("Copy failed");
    }
  }

  async function loadProviders() {
    if (!SERVED || !(els.provider instanceof HTMLSelectElement)) {
      if (els.serveHint) {
        els.serveHint.hidden = false;
        els.serveHint.textContent =
          "Recheck needs the local server. From the repo root run: pnpm prsm --serve " + PR;
      }
      if (els.recheckBtn) els.recheckBtn.disabled = true;
      return;
    }
    try {
      var res = await fetch("/api/providers");
      var body = await res.json();
      var list = Array.isArray(body.providers) ? body.providers : [];
      els.provider.innerHTML = "";
      if (!list.length) {
        var opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No providers available";
        els.provider.appendChild(opt);
        if (els.recheckBtn) els.recheckBtn.disabled = true;
        return;
      }
      list.forEach(function (id) {
        var o = document.createElement("option");
        o.value = id;
        o.textContent = id;
        els.provider.appendChild(o);
      });
      var preferred = ["cursor", "claude-code", "command-code", "anthropic"];
      for (var i = 0; i < preferred.length; i++) {
        if (list.indexOf(preferred[i]) !== -1) {
          els.provider.value = preferred[i];
          break;
        }
      }
      if (els.serveHint) els.serveHint.hidden = true;
      if (els.recheckBtn) els.recheckBtn.disabled = false;
    } catch (e) {
      if (els.serveHint) {
        els.serveHint.hidden = false;
        els.serveHint.textContent = "Could not reach /api/providers. Is --serve running?";
      }
      if (els.recheckBtn) els.recheckBtn.disabled = true;
    }
  }

  async function recheck() {
    var f = current();
    if (!f || !SERVED || rechecking) return;
    if (!(els.provider instanceof HTMLSelectElement) || !els.provider.value) {
      showFlash("Pick a provider first");
      return;
    }
    var notes = els.notes instanceof HTMLTextAreaElement ? els.notes.value : "";
    state.notes[f.storageId] = notes;
    saveState(state);

    rechecking = true;
    if (els.recheckBtn) {
      els.recheckBtn.disabled = true;
      els.recheckBtn.textContent = "Rechecking…";
    }
    if (els.recheckStatus) {
      els.recheckStatus.hidden = false;
      els.recheckStatus.textContent =
        "Running " + els.provider.value + " on this finding only… (can take a few minutes)";
    }

    try {
      var res = await fetch("/api/reverify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          findingId: f.id,
          prompt: notes,
          provider: els.provider.value,
        }),
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));

      if (body.payload && Array.isArray(body.payload.findings)) {
        all = body.payload.findings.map(findingFromApi);
      }

      if (body.action === "false_alarm" || body.action === "drop") {
        var faId = body.finding && body.finding.id ? body.finding.id : f.id;
        if (body.finding && body.finding.reviewComment) {
          state.comments[encodeURIComponent(faId)] = body.finding.reviewComment;
          saveState(state);
        }
        showFlash("False alarm — kept in review (not deleted)");
        if (els.recheckStatus) {
          els.recheckStatus.hidden = false;
          els.recheckStatus.textContent =
            (body.note || "Marked false alarm.") + " Toggle “Include false alarms” to revisit.";
        }
        clampIndex();
      } else if (body.action === "update") {
        var updatedId = body.finding && body.finding.id ? body.finding.id : f.id;
        if (body.finding && body.finding.reviewComment) {
          var updatedStorage = encodeURIComponent(updatedId);
          state.comments[updatedStorage] = body.finding.reviewComment;
          if (updatedStorage !== f.storageId) {
            state.notes[updatedStorage] = state.notes[f.storageId] || "";
            delete state.comments[f.storageId];
            delete state.notes[f.storageId];
          }
          saveState(state);
        }
        focusById(updatedId);
        showFlash("Updated — " + (body.note || "saved"));
        if (els.recheckStatus) {
          els.recheckStatus.hidden = false;
          els.recheckStatus.textContent = body.note || "Finding updated on disk.";
        }
      } else {
        focusById(body.finding && body.finding.id ? body.finding.id : f.id);
        showFlash("Stood — " + (body.note || "no change"));
        if (els.recheckStatus) {
          els.recheckStatus.hidden = false;
          els.recheckStatus.textContent = body.note || "No material change.";
        }
      }
      paint();
    } catch (e) {
      showFlash(e && e.message ? e.message : "Recheck failed");
      if (els.recheckStatus) {
        els.recheckStatus.hidden = false;
        els.recheckStatus.textContent = e && e.message ? e.message : "Recheck failed";
      }
    } finally {
      rechecking = false;
      if (els.recheckBtn) {
        els.recheckBtn.disabled = !SERVED;
        els.recheckBtn.textContent = "Recheck";
      }
      paint();
    }
  }

  async function setDisposition(disposition) {
    var f = current();
    if (!f || !SERVED) return;
    var notes = els.notes instanceof HTMLTextAreaElement ? els.notes.value : "";
    state.notes[f.storageId] = notes;
    saveState(state);
    try {
      var res = await fetch("/api/disposition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          findingId: f.id,
          disposition: disposition,
          note: notes,
        }),
      });
      var body = await res.json();
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      if (body.payload && Array.isArray(body.payload.findings)) {
        all = body.payload.findings.map(findingFromApi);
      }
      if (disposition === "false_alarm") {
        showFlash("False alarm — kept in review");
      } else {
        focusById(f.id);
        showFlash("Reopened");
      }
      clampIndex();
      paint();
    } catch (e) {
      showFlash(e && e.message ? e.message : "Failed to update disposition");
    }
  }

  document.getElementById("btn-back").addEventListener("click", function () { go(-1); });
  document.getElementById("btn-next").addEventListener("click", function () { go(1); });
  document.getElementById("btn-resolve").addEventListener("click", function () { toggleResolve(true); });
  document.getElementById("btn-restore").addEventListener("click", function () { toggleResolve(false); });
  document.getElementById("btn-save-comment").addEventListener("click", saveComment);
  document.getElementById("btn-copy-comment").addEventListener("click", copyComment);
  document.getElementById("btn-copy-current-code").addEventListener("click", copyCurrentCode);
  document.getElementById("btn-copy-better-code").addEventListener("click", copyBetterCode);
  document.getElementById("btn-copy-original").addEventListener("click", copyOriginalComment);
  document.getElementById("btn-copy-notes").addEventListener("click", copyNotes);
  document.getElementById("btn-reset-comment").addEventListener("click", resetComment);
  document.getElementById("btn-copy-agent").addEventListener("click", copyForAgent);
  document.getElementById("btn-copy-agent-top").addEventListener("click", copyForAgent);
  document.getElementById("btn-recheck").addEventListener("click", recheck);
  document.getElementById("btn-false-alarm").addEventListener("click", function () {
    setDisposition("false_alarm");
  });
  document.getElementById("btn-reopen").addEventListener("click", function () {
    setDisposition("open");
  });

  if (els.showResolved) {
    els.showResolved.addEventListener("change", function () {
      showResolved = Boolean(els.showResolved.checked);
      queueIndex = 0;
      paint();
    });
  }
  if (els.showFalseAlarms) {
    els.showFalseAlarms.addEventListener("change", function () {
      showFalseAlarms = Boolean(els.showFalseAlarms.checked);
      queueIndex = 0;
      paint();
    });
  }
  document.addEventListener("keydown", function (event) {
    var t = event.target;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      var f = current();
      if (!f) return;
      toggleResolve(!isResolved(f));
    }
  });

  loadProviders();
  paint();
})();
</script>`;
}

export function renderFinalReviewTriage(run: ReviewRun): string {
  const ordered = sortFindingsForTriage(
    run.findings.filter((f) => f.kind !== "praise"),
  );
  const payload = {
    prNumber: run.prNumber,
    findings: ordered.map(toTriageFinding),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR #${run.prNumber} — Triage</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --bg-elevated: #252526;
      --ink: #d4d4d4;
      --muted: #a0a0a0;
      --card: #252526;
      --line: #3c3c3c;
      --accent: #3794ff;
      --accent-hover: #4aa0ff;
      --code-bg: #1e1e1e;
      --comment-bg: #1b3a4b;
      --blocker: #f14c4c;
      --major: #dcdcaa;
      --minor: #9cdcfe;
      --nit: #808080;
      --question: #c586c0;
      --button-fg: #ffffff;
      --copied: #388a34;
      --resolved: #3d7a45;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Consolas, ui-sans-serif, system-ui, sans-serif;
      color: var(--ink);
      background: var(--bg);
      line-height: 1.55;
    }
    main { max-width: 920px; margin: 0 auto; padding: 1.75rem 1.15rem 5rem; }
    h1 { font-size: 1.55rem; margin: 0 0 0.35rem; font-weight: 600; color: #fff; }
    h2 { margin: 0 0 0.35rem; font-size: 1.15rem; font-weight: 600; color: #fff; }
    h3 {
      margin: 1rem 0 0.35rem;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 600;
    }
    .lede { color: var(--muted); margin: 0 0 1rem; }
    .nav-links { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; align-items: center; }
    a { color: var(--accent); }
    .summary {
      background: var(--bg-elevated);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0.9rem 1.1rem;
      margin-bottom: 1rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1.25rem;
      align-items: center;
    }
    #progress-text { font-weight: 600; color: #fff; }
    .hint { color: var(--muted); font-size: 0.88rem; }
    #flash, #recheck-status, #serve-hint {
      margin: 0.5rem 0 0;
      color: #9cdcfe;
      font-size: 0.9rem;
      min-height: 1.2em;
    }
    #serve-hint { color: #dcdcaa; }
    #panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 1.1rem 1.2rem 1.35rem;
      border-left: 4px solid var(--minor);
    }
    #panel:has(#sev-badge[data-severity="blocker"]) { border-left-color: var(--blocker); }
    #panel:has(#sev-badge[data-severity="major"]) { border-left-color: var(--major); }
    #panel:has(#sev-badge[data-severity="minor"]) { border-left-color: var(--minor); }
    #panel:has(#sev-badge[data-severity="nit"]),
    #panel:has(#sev-badge[data-severity="suggestion"]) { border-left-color: var(--nit); }
    #panel:has(#sev-badge[data-severity="question"]) { border-left-color: var(--question); }
    #panel.is-resolved { border-left-color: var(--resolved); opacity: 0.92; }
    .badge {
      display: inline-block;
      background: #2d2d2d;
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0.1rem 0.45rem;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #9cdcfe;
    }
    .badge[hidden],
    #fa-badge[hidden],
    button[hidden],
    #empty[hidden],
    #panel[hidden],
    #flash[hidden],
    #serve-hint[hidden],
    #recheck-status[hidden] {
      display: none !important;
    }
    .meta { color: var(--muted); margin: 0.25rem 0 0; font-size: 0.92rem; }
    code {
      font-family: Consolas, "Cascadia Code", ui-monospace, monospace;
      font-size: 0.9em;
      color: #9cdcfe;
    }
    .editor-host { margin-top: 0.35rem; }
    .editor {
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
      background: var(--code-bg);
      box-shadow: 0 1px 0 rgba(0,0,0,0.25);
    }
    .editor-titlebar {
      display: flex;
      align-items: stretch;
      gap: 0;
      background: #2d2d2d;
      border-bottom: 1px solid var(--line);
      min-height: 34px;
    }
    .editor-tab {
      padding: 0.45rem 0.9rem;
      color: var(--muted);
      font-size: 0.82rem;
      border-right: 1px solid var(--line);
    }
    .editor-tab.active {
      background: var(--code-bg);
      color: #fff;
      box-shadow: inset 0 2px 0 var(--accent);
    }
    .editor-lang {
      margin-left: auto;
      align-self: center;
      padding: 0 0.75rem;
      color: var(--muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .editor-breadcrumb {
      padding: 0.28rem 0.75rem;
      border-bottom: 1px solid var(--line);
      font-family: Consolas, "Cascadia Code", ui-monospace, monospace;
      font-size: 0.78rem;
      color: #cccccc;
      overflow: auto;
      white-space: nowrap;
      background: #252526;
    }
    .editor-body { overflow: auto; background: var(--code-bg); max-height: 28rem; }
    .editor-code {
      margin: 0;
      padding: 0.45rem 0;
      font-family: Consolas, "Cascadia Code", "Fira Code", ui-monospace, monospace;
      font-size: 0.9rem;
      line-height: 1.65;
      min-width: max-content;
    }
    .editor-row {
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr);
    }
    .editor-row:hover { background: #2a2a2a; }
    .editor-gutter {
      color: #858585;
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
    .comment-body {
      margin: 0.35rem 0 0;
      padding: 0.85rem 1rem;
      white-space: pre-wrap;
      color: #e6edf3;
      background: var(--comment-bg);
      border: 1px solid #2a4a5a;
      border-radius: 6px;
      font-family: Consolas, "Cascadia Code", ui-monospace, monospace;
      font-size: 0.9rem;
      line-height: 1.55;
    }
    textarea, select {
      width: 100%;
      margin-top: 0.35rem;
      background: #1e1e1e;
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.65rem 0.75rem;
      font: 0.92rem/1.45 "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    textarea { resize: vertical; }
    select { width: auto; min-width: 12rem; }
    textarea:focus, select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .toolbar { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.55rem; align-items: center; }
    button {
      border: 1px solid transparent;
      background: var(--accent);
      color: var(--button-fg);
      border-radius: 4px;
      padding: 0.45rem 0.85rem;
      font: 600 0.82rem "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.btn-secondary {
      background: #2d2d2d;
      border-color: var(--line);
      color: #d4d4d4;
    }
    button.btn-secondary:hover { background: #3a3a3a; }
    .bottom-nav {
      position: sticky;
      bottom: 0;
      margin-top: 1.25rem;
      padding: 0.75rem 0;
      background: linear-gradient(transparent, var(--bg) 28%);
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    details { margin-top: 0.75rem; }
    summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 0.88rem;
    }
    #empty {
      background: var(--bg-elevated);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 2rem 1.25rem;
      text-align: center;
      color: var(--muted);
    }
    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--muted);
      font-size: 0.88rem;
      cursor: pointer;
    }
    .provider-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      align-items: center;
      margin-top: 0.45rem;
    }
    .provider-row label { color: var(--muted); font-size: 0.88rem; }
    .badge-fa {
      background: #3d2a12;
      border-color: #a37a2c;
      color: #dcdcaa;
      margin-left: 0.35rem;
    }
    #panel.is-false-alarm { border-left-color: #dcdcaa; }
  </style>
</head>
<body>
  <main>
    <h1>PR #${run.prNumber} — Triage</h1>
    <p class="lede">${escapeHtml(run.title ?? "")} · one finding at a time (critical → lower)</p>
    <div class="nav-links">
      <a href="final-review.html">Open list view</a>
      <label class="toggle"><input type="checkbox" id="show-resolved" /> Include resolved</label>
      <label class="toggle"><input type="checkbox" id="show-false-alarms" /> Include false alarms</label>
    </div>
    ${run.overview ? renderOverviewHtml(run.overview, escapeHtml) : ""}
    <section class="summary">
      <span id="progress-text">…</span>
      <span class="hint">← → navigate · R resolve · false alarms stay on disk</span>
    </section>
    <p id="serve-hint" hidden></p>
    <p id="flash" hidden></p>

    <div id="empty" hidden>
      <p>All caught up — nothing left in the open queue.</p>
      <p class="hint">Toggle “Include false alarms” or “Include resolved” to revisit.</p>
    </div>

    <article id="panel" hidden>
      <header>
        <span class="badge" id="sev-badge">—</span>
        <span class="badge badge-fa" id="fa-badge" hidden>False alarm</span>
        <h2 id="finding-title">Finding</h2>
        <p class="meta" id="finding-meta"></p>
        <div class="toolbar" style="margin-top:0.65rem">
          <button type="button" id="btn-copy-agent-top">Copy for agent</button>
        </div>
      </header>

      <section>
        <h3>Issue (simple)</h3>
        <p id="issue-simple"></p>
      </section>

      <section>
        <h3>Current code</h3>
        <div class="toolbar">
          <button type="button" class="btn-secondary" id="btn-copy-current-code">Copy code</button>
        </div>
        <div class="editor-host" id="current-code"></div>
      </section>

      <details>
        <summary>Details (why / fix / better code)</summary>
        <section>
          <h3>Why this is weak</h3>
          <p id="why-weak"></p>
        </section>
        <section>
          <h3>How to fix</h3>
          <p id="how-fix"></p>
        </section>
        <section>
          <h3>Better code</h3>
          <div class="toolbar">
            <button type="button" class="btn-secondary" id="btn-copy-better-code">Copy better code</button>
          </div>
          <div class="editor-host" id="better-code"></div>
        </section>
      </details>

      <section>
        <h3>Your paste comment (keep it short)</h3>
        <p class="hint">Edit into the simple GitHub comment you want. Synced with the list page in this browser.</p>
        <textarea id="simple-comment" rows="4" placeholder="Short polite comment…"></textarea>
        <div class="toolbar">
          <button type="button" id="btn-save-comment">Save comment</button>
          <button type="button" id="btn-copy-comment">Copy comment</button>
          <button type="button" class="btn-secondary" id="btn-reset-comment">Reset to original</button>
        </div>
        <details>
          <summary>Original generated comment</summary>
          <div class="toolbar">
            <button type="button" class="btn-secondary" id="btn-copy-original">Copy original</button>
          </div>
          <pre class="comment-body" id="original-comment"></pre>
        </details>
      </section>

      <section>
        <h3>Recheck this finding</h3>
        <p class="hint">Notes + this finding go to the provider. If it’s not a real issue, it becomes a <strong>false alarm</strong> (kept — not deleted). Tip: write “false alarm” in notes.</p>
        <textarea id="notes" rows="4" placeholder="e.g. False alarm — intentional mock. Or: stands, cookie Secure must match setCookie."></textarea>
        <div class="provider-row">
          <label for="provider">Provider</label>
          <select id="provider" aria-label="Provider">
            <option value="">Loading…</option>
          </select>
          <button type="button" id="btn-recheck" disabled>Recheck</button>
          <button type="button" class="btn-secondary" id="btn-copy-notes">Copy notes</button>
        </div>
        <p id="recheck-status" hidden></p>
      </section>
    </article>

    <nav class="bottom-nav" aria-label="Triage navigation">
      <button type="button" class="btn-secondary" id="btn-back">Back</button>
      <button type="button" class="btn-secondary" id="btn-next">Next</button>
      <button type="button" id="btn-copy-agent">Copy for agent</button>
      <button type="button" id="btn-resolve">Resolved</button>
      <button type="button" class="btn-secondary" id="btn-restore" hidden>Restore</button>
      <button type="button" class="btn-secondary" id="btn-false-alarm" hidden>False alarm</button>
      <button type="button" class="btn-secondary" id="btn-reopen" hidden>Reopen</button>
    </nav>
  </main>
  <script>window.__TRIAGE__ = ${embedJson(payload)};</script>
  ${clientScript()}
</body>
</html>`;
}
