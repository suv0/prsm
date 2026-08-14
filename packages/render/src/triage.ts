import type { Finding, RecheckEntry, ReviewRun } from "@review-os/schemas";
import { normalizeTeachMeContent } from "@review-os/core";
import { githubFileUrl } from "./github-file-link.js";
import { renderOverviewHtml } from "./overview.js";
import {
  agentFindingsNavHtml,
  workspaceChromeCloseHtml,
  workspaceChromeCss,
  workspaceChromeHeadHtml,
  workspaceChromeOpenHtml,
} from "./agent-nav.js";
import { iconHtml, iconTextHtml, ICON_INNER } from "./ui-icons.js";
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
  githubUrl?: string;
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
  rechecks: RecheckEntry[];
};

function toTriageFinding(
  finding: Finding,
  link?: { prUrl?: string; head?: string },
): TriageFinding {
  const githubUrl = githubFileUrl({
    ...(link?.prUrl !== undefined ? { prUrl: link.prUrl } : {}),
    ...(link?.head !== undefined ? { head: link.head } : {}),
    file: finding.file,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
  });
  return {
    id: finding.id,
    storageId: encodeURIComponent(finding.id),
    kind: finding.kind,
    file: finding.file,
    line: finding.line,
    ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
    ...(githubUrl ? { githubUrl } : {}),
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
    rechecks: Array.isArray(finding.rechecks)
      ? finding.rechecks.map((entry) => {
          if (!entry.teachMe?.trim()) return entry;
          const teachMe = normalizeTeachMeContent(entry.teachMe);
          return teachMe === entry.teachMe ? entry : { ...entry, teachMe };
        })
      : [],
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
  // Works for /pr/22/, /pr/22/triage.html, and legacy single-PR /
  const BASE = (function () {
    var p = location.pathname || "/";
    var parts = p.split("/");
    if (parts[1] === "pr" && /^[0-9]+$/.test(parts[2] || "")) {
      return "/pr/" + parts[2];
    }
    if (p.endsWith("/triage.html")) p = p.slice(0, -"/triage.html".length);
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p === "/" ? "" : p;
  })();
  function apiUrl(path) {
    return BASE + "/api" + path;
  }
  var ICO = ${JSON.stringify(ICON_INNER)};
  function ico(name) {
    return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICO[name] || "") + "</svg>";
  }
  function setBtnLabel(el, text) {
    if (!el) return;
    var lab = el.querySelector(".btn-label");
    if (lab) lab.textContent = text;
    else el.textContent = text;
  }
  let all = data.findings.slice();
  let queueIndex = 0;
  let showResolved = false;
  let showFalseAlarms = false;
  let rechecking = false;
  let verifying = false;
  let paintedFindingId = "";

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
    teachSimple: document.getElementById("teach-simple"),
    teachBtn: document.getElementById("btn-teach-me"),
    copyTeachBtn: document.getElementById("btn-copy-teach"),
    notes: document.getElementById("notes"),
    flash: document.getElementById("flash"),
    resolveBtn: document.getElementById("btn-resolve"),
    restoreBtn: document.getElementById("btn-restore"),
    falseAlarmBtn: document.getElementById("btn-false-alarm"),
    reopenBtn: document.getElementById("btn-reopen"),
    showResolved: document.getElementById("show-resolved"),
    showFalseAlarms: document.getElementById("show-false-alarms"),
    provider: document.getElementById("provider"),
    providerTeach: document.getElementById("provider-teach"),
    recheckBtn: document.getElementById("btn-recheck"),
    recheckStatus: document.getElementById("recheck-status"),
    recheckLogs: document.getElementById("recheck-logs"),
    recheckLive: document.getElementById("recheck-live"),
    recheckPanel: document.getElementById("recheck-live-panel"),
    verifyBtn: document.getElementById("btn-verify"),
    verifyStatus: document.getElementById("verify-status"),
    verifyLive: document.getElementById("verify-live"),
    verifyLogs: document.getElementById("verify-logs"),
    verifyPanel: document.getElementById("verify-panel"),
    serveHint: document.getElementById("serve-hint"),
  };

  let verifyPollTimer = 0;
  let verifyJobId = "";
  let lastVerifyLogCount = 0;

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

  function buildSimpleTeach(f) {
    var latest = Array.isArray(f.rechecks) && f.rechecks[0] && f.rechecks[0].teachMe
      ? String(f.rechecks[0].teachMe).trim()
      : "";
    if (latest) return latest;
    return [
      "Yes — look at " + f.file + " around line " + lineLabel(f) + ".",
      "",
      "What's going wrong: " + (f.issueSimple || ""),
      "",
      "Why it matters: " + (f.whyWeak || ""),
      "",
      "Smallest fix: " + (f.howToFix || ""),
      "",
      "A natural PR comment: " + (f.reviewComment || ""),
    ].join("\\n");
  }

  function paintTeachSimple(f) {
    if (!els.teachSimple) return;
    var text = buildSimpleTeach(f);
    els.teachSimple.innerHTML = formatTeachHtml(text, f);
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
      githubUrl: f.githubUrl,
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
      rechecks: Array.isArray(f.rechecks) ? f.rechecks : [],
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
    host.innerHTML = buildEditorHtml(options);
  }

  /** Shared VS Code-like block used by Current code + Teach me fences. */
  function buildEditorHtml(options) {
    var code = String(options.code || "").replace(/\\r\\n/g, "\\n");
    if (!code.trim()) return "";
    var lines = code.replace(/\\n$/, "").split("\\n");
    var start = Math.max(1, Number(options.startLine) || 1);
    var lang = options.language || "ts";
    var file = options.file || "file";
    var name = fileName(file);
    var compact = Boolean(options.compact);
    var end = start + Math.max(0, lines.length - 1);
    var rows = lines.map(function (line, index) {
      var n = start + index;
      return '<div class="editor-row">' +
        '<span class="editor-gutter" aria-hidden="true">' + n + "</span>" +
        '<span class="editor-line">' + highlightLine(line) + "</span>" +
        "</div>";
    }).join("");
    return (
      '<div class="editor' + (compact ? " editor-compact" : "") + '">' +
        '<div class="editor-titlebar">' +
          '<div class="editor-tab active" title="' + esc(file) + '">' + esc(name) + "</div>" +
          '<div class="editor-lang">' + esc(lang) + (lines.length > 1 ? " · L" + start + "–" + end : " · L" + start) + "</div>" +
        "</div>" +
        '<div class="editor-breadcrumb">' + esc(file) + ":" + start + (lines.length > 1 ? "–" + end : "") + "</div>" +
        '<div class="editor-body">' +
          '<div class="editor-code" role="region" aria-label="Code">' + rows + "</div>" +
        "</div>" +
      "</div>"
    );
  }

  function inferSnippetStartLine(code, finding, explicitStart) {
    if (explicitStart && explicitStart > 0) return explicitStart;
    if (!finding) return 1;
    var base = Math.max(1, Number(finding.line) || 1);
    var current = String(finding.currentCode || "").replace(/\\r\\n/g, "\\n");
    var snippet = String(code || "").replace(/\\r\\n/g, "\\n").replace(/\\n$/, "");
    if (current && snippet) {
      var idx = current.indexOf(snippet);
      if (idx >= 0) {
        return base + current.slice(0, idx).split("\\n").length - 1;
      }
      var first = snippet.split("\\n").map(function (l) { return l.trim(); }).find(Boolean);
      if (first) {
        var curLines = current.split("\\n");
        for (var i = 0; i < curLines.length; i += 1) {
          if (curLines[i].indexOf(first) !== -1 || curLines[i].trim() === first) {
            return base + i;
          }
        }
      }
    }
    return base;
  }

  function renderQueue() {
    var host = document.getElementById("finding-queue");
    var countEl = document.getElementById("queue-count");
    if (!host) return;
    var q = queue();
    if (countEl) countEl.textContent = q.length + " open";
    var groups = [
      { key: "blocker", title: "Critical", cls: "is-crit", items: [] },
      { key: "major", title: "Major", cls: "", items: [] },
      { key: "rest", title: "Other", cls: "", items: [] },
    ];
    q.forEach(function (item) {
      if (item.severity === "blocker") groups[0].items.push(item);
      else if (item.severity === "major") groups[1].items.push(item);
      else groups[2].items.push(item);
    });
    var currentId = current() ? current().id : "";
    host.innerHTML = groups.filter(function (g) { return g.items.length; }).map(function (g) {
      return '<p class="queue-group ' + g.cls + '">' + g.title + " (" + g.items.length + ")</p>" +
        g.items.map(function (item) {
          var loc = String(item.file || "").split("/").pop() + ":" + item.line;
          var title = String(item.issueSimple || "Finding");
          if (title.length > 72) title = title.slice(0, 69) + "…";
          var active = item.id === currentId ? " is-active" : "";
          return '<button type="button" class="queue-item' + active + '" data-id="' + escapeText(item.id) + '">' +
            '<span class="queue-title">' + escapeText(title) + "</span>" +
            '<span class="queue-file">' + escapeText(loc) + "</span></button>";
        }).join("");
    }).join("");
    host.querySelectorAll(".queue-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id") || "";
        var next = queue();
        for (var i = 0; i < next.length; i += 1) {
          if (next[i].id === id) {
            queueIndex = i;
            paint();
            return;
          }
        }
      });
    });
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
    renderQueue();

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
      var label = lineLabel(f);
      if (f.githubUrl) {
        els.meta.innerHTML =
          '<a class="file-link" target="_blank" rel="noopener noreferrer"><code></code> · Line ' +
          label +
          "</a>";
        els.meta.querySelector("a").href = f.githubUrl;
        els.meta.querySelector("code").textContent = f.file;
      } else {
        els.meta.innerHTML = "<code></code> · Line " + label;
        els.meta.querySelector("code").textContent = f.file;
      }
    }
    if (els.issue) {
      els.issue.textContent = falseAlarm && f.falseAlarmNote
        ? f.falseAlarmNote
        : f.issueSimple;
    }
    paintTeachSimple(f);
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
      els.notes.disabled = rechecking;
    }
    if (els.provider) els.provider.disabled = rechecking || !SERVED;
    if (f.id !== paintedFindingId) {
      paintedFindingId = f.id;
      if (!rechecking) clearRecheckLivePanel();
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
    if (els.teachBtn) els.teachBtn.disabled = !SERVED || rechecking;
    if (els.provider) els.provider.disabled = rechecking || !SERVED;
    if (els.providerTeach) els.providerTeach.disabled = rechecking || !SERVED;
    renderRecheckHistory(f);
  }

  function renderRecheckHistory(f) {
    var host = document.getElementById("recheck-history");
    if (!host) return;
    var items = Array.isArray(f.rechecks) ? f.rechecks : [];
    if (!items.length) {
      host.innerHTML = '<p class="hint">No rechecks yet. Hit <strong>Teach me</strong> for a plain walkthrough, or type a question and hit Recheck.</p>';
      return;
    }
    host.innerHTML = items.map(function (entry, idx) {
      var teach = entry.teachMe
        ? '<div class="recheck-teach"><div class="teach-head"><p class="hint" style="margin:0"><strong>Teach me</strong></p><button type="button" class="btn-copy-teach-entry" data-idx="' + idx + '">' + ico("copy") + '<span class="btn-label">Copy lesson</span></button></div><div class="teach-prose recheck-teach-body"></div></div>'
        : "";
      var details = entry.details
        ? '<details><summary>More details</summary><p class="recheck-details"></p></details>'
        : "";
      var suggest = entry.suggestedComment
        ? '<div class="recheck-suggest"><p class="hint">Suggested GitHub comment <strong>(for the PR author — Copy to paste on the PR)</strong></p><pre class="recheck-suggest-body"></pre><div class="toolbar"><button type="button" class="btn-copy-suggest" data-idx="' + idx + '">' + ico("copy") + '<span class="btn-label">Copy</span></button><button type="button" class="btn-secondary btn-apply-suggest" data-idx="' + idx + '">' + ico("check") + '<span class="btn-label">Use in paste box</span></button></div></div>'
        : "";
      var latest = idx === 0 ? ' is-latest' : '';
      return (
        '<article class="recheck-entry' + latest + '">' +
          '<header><span class="badge">' + escapeText(entry.action || "") + '</span> ' +
          (idx === 0 ? '<span class="badge badge-latest">Latest</span> ' : '') +
          '<span class="meta">' + escapeText(entry.provider || "") + ' · ' + escapeText(String(entry.createdAt || "").replace("T", " ").slice(0, 16)) + '</span></header>' +
          teach +
          '<p><strong>You asked</strong><br><span class="recheck-asked"></span></p>' +
          '<p><strong>In short</strong><br><span class="recheck-conclusion"></span></p>' +
          details +
          suggest +
        '</article>'
      );
    }).join("");
    var nodes = host.querySelectorAll(".recheck-entry");
    items.forEach(function (entry, idx) {
      var node = nodes[idx];
      if (!node) return;
      var asked = node.querySelector(".recheck-asked");
      var conclusion = node.querySelector(".recheck-conclusion");
      if (asked) asked.textContent = entry.userAsked || "";
      if (conclusion) conclusion.textContent = entry.conclusion || "";
      var teachBody = node.querySelector(".recheck-teach-body");
      if (teachBody && entry.teachMe) teachBody.innerHTML = formatTeachHtml(entry.teachMe, f);
      var det = node.querySelector(".recheck-details");
      if (det && entry.details) det.textContent = entry.details;
      var sug = node.querySelector(".recheck-suggest-body");
      if (sug && entry.suggestedComment) sug.textContent = entry.suggestedComment;
    });
    host.querySelectorAll(".btn-copy-teach-entry").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.getAttribute("data-idx"));
        var entry = items[i];
        if (!entry || !entry.teachMe) return;
        copyText("Lesson", entry.teachMe);
      });
    });
    host.querySelectorAll(".btn-copy-suggest").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.getAttribute("data-idx"));
        var entry = items[i];
        if (!entry || !entry.suggestedComment) return;
        copyText("Suggested comment", entry.suggestedComment);
      });
    });
    host.querySelectorAll(".btn-apply-suggest").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.getAttribute("data-idx"));
        var entry = items[i];
        if (!entry || !entry.suggestedComment || !els.comment) return;
        els.comment.value = entry.suggestedComment;
        state.comments[f.storageId] = entry.suggestedComment;
        saveState(state);
        showFlash("Loaded into paste box above (edit freely, then Copy comment)");
      });
    });
  }

  function escapeText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Lightweight markdown for Teach me lessons (headings, fences → editor, bold, code). */
  function formatTeachHtml(raw, finding) {
    var tick = String.fromCharCode(96);
    var text = recoverTeachMeDump(String(raw || "").replace(/\\r\\n/g, "\\n"));
    // Fenced code at line starts only — avoids mid-JSON garbage matching fences.
    // lang optional, optional :startLine (e.g. ts:108). Skip json fences (not lesson snippets).
    var fenceRe = new RegExp(
      "(?:^|\\n)" +
        tick + tick + tick +
        "([\\\\w-]*)(?::(\\\\d+))?(?:[^\\\\n]*)\\\\n([\\\\s\\\\S]*?)" +
        tick + tick + tick,
      "g"
    );
    var parts = [];
    var last = 0;
    var m;
    while ((m = fenceRe.exec(text)) !== null) {
      var lang = (m[1] || "").toLowerCase();
      if (lang === "json") continue;
      var matchStart = m.index;
      if (text.charAt(m.index) === "\\n") matchStart = m.index + 1;
      if (matchStart > last) {
        parts.push({ type: "text", value: text.slice(last, matchStart) });
      }
      parts.push({
        type: "code",
        lang: (lang || (finding && finding.language) || "ts").toLowerCase(),
        startLine: m[2] ? Number(m[2]) : 0,
        value: m[3] || "",
      });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
    if (!parts.length) parts.push({ type: "text", value: text });

    function recoverTeachMeDump(input) {
      var src = String(input || "");
      if (src.indexOf('"teachMeLines"') < 0) return src;
      var key = src.indexOf('"teachMeLines"');
      var bracket = src.indexOf("[", key);
      if (bracket < 0) return src;
      var depth = 0;
      var inStr = false;
      var esc = false;
      for (var i = bracket; i < src.length; i += 1) {
        var c = src.charAt(i);
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === "\\\\") { esc = true; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === "[") depth += 1;
        if (c === "]") {
          depth -= 1;
          if (depth === 0) {
            try {
              var arr = JSON.parse(src.slice(bracket, i + 1));
              if (
                Array.isArray(arr) &&
                arr.length > 0 &&
                arr.every(function (item) { return typeof item === "string"; })
              ) {
                return arr.join("\\n");
              }
            } catch (_err) {
              return src;
            }
            return src;
          }
        }
      }
      return src;
    }

    function lineHintFromText(chunk) {
      var hits = String(chunk || "").match(/\\b(?:[Ll]ines?|L)\\s*(\\d{1,5})\\b/g);
      if (!hits || !hits.length) return 0;
      var lastHit = hits[hits.length - 1];
      var num = lastHit.match(/(\\d{1,5})/);
      return num ? Number(num[1]) : 0;
    }

    function formatInlineBits(escaped) {
      var html = escaped;
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|[^*])\\*([^*]+)\\*(?!\\*)/g, "$1<em>$2</em>");
      html = html.replace(
        new RegExp(tick + "([^" + tick + "\\\\n]+)" + tick, "g"),
        "<code>$1</code>"
      );
      return html;
    }

    function formatInline(chunk) {
      var html = escapeText(chunk);
      html = formatInlineBits(html);
      html = html.replace(/^(#{1,3})\\s+(.+)$/gm, function (_all, hashes, title) {
        var level = Math.min(3, hashes.length);
        return "<h" + (level + 2) + ' class="teach-h">' + title + "</h" + (level + 2) + ">";
      });
      html = html.replace(/^---$/gm, '<hr class="teach-hr" />');
      html = html.replace(
        /^(Input:|Output:|What happens:|Snippet:)(\\s+)/gm,
        '<span class="teach-label">$1</span>$2'
      );
      return html;
    }

    function splitTableCells(line) {
      var t = String(line || "").trim();
      if (t.charAt(0) === "|") t = t.slice(1);
      if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
      return t.split("|").map(function (c) { return c.trim(); });
    }

    function isTableSeparator(line) {
      var cells = splitTableCells(line);
      if (cells.length < 2) return false;
      return cells.every(function (c) {
        return /^:?-{3,}:?$/.test(c);
      });
    }

    function isTableRow(line) {
      var t = String(line || "").trim();
      return t.indexOf("|") !== -1;
    }

    function renderMarkdownTable(tableLines) {
      if (!tableLines || tableLines.length < 2) return "";
      var header = splitTableCells(tableLines[0]);
      var bodyLines = tableLines.slice(1).filter(function (line) {
        return !isTableSeparator(line);
      });
      var thead =
        "<thead><tr>" +
        header.map(function (cell) {
          return "<th>" + formatInlineBits(escapeText(cell)) + "</th>";
        }).join("") +
        "</tr></thead>";
      var tbody =
        "<tbody>" +
        bodyLines.map(function (line) {
          return (
            "<tr>" +
            splitTableCells(line).map(function (cell) {
              return "<td>" + formatInlineBits(escapeText(cell)) + "</td>";
            }).join("") +
            "</tr>"
          );
        }).join("") +
        "</tbody>";
      return '<div class="teach-table-wrap"><table class="teach-table">' + thead + tbody + "</table></div>";
    }

    function formatTextChunk(chunk) {
      var lines = String(chunk || "").split("\\n");
      var pieces = [];
      var i = 0;
      while (i < lines.length) {
        if (
          isTableRow(lines[i]) &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1])
        ) {
          var tableLines = [];
          while (i < lines.length && isTableRow(lines[i])) {
            tableLines.push(lines[i]);
            i += 1;
          }
          pieces.push(renderMarkdownTable(tableLines));
          continue;
        }
        var buf = [];
        while (i < lines.length) {
          if (
            isTableRow(lines[i]) &&
            i + 1 < lines.length &&
            isTableSeparator(lines[i + 1])
          ) {
            break;
          }
          buf.push(lines[i]);
          i += 1;
        }
        if (buf.length) {
          pieces.push('<div class="teach-block">' + formatInline(buf.join("\\n")) + "</div>");
        }
      }
      return pieces.join("");
    }

    var out = [];
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (part.type === "code") {
        var priorText = i > 0 && parts[i - 1].type === "text" ? parts[i - 1].value : "";
        var hinted = lineHintFromText(priorText);
        var startLine = inferSnippetStartLine(
          part.value,
          finding,
          part.startLine || hinted || 0
        );
        out.push(
          buildEditorHtml({
            code: part.value,
            file: finding && finding.file ? finding.file : "snippet",
            language: part.lang || "ts",
            startLine: startLine,
            compact: true,
          })
        );
      } else {
        out.push(formatTextChunk(part.value));
      }
    }
    return out.join("");
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

  async function copyTeachLesson() {
    var f = current();
    if (!f) return;
    await copyText("Lesson", buildSimpleTeach(f));
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
    var rechecks = Array.isArray(f.rechecks) ? f.rechecks : [];
    var history = rechecks.length
      ? rechecks.map(function (entry, idx) {
          return [
            "### Recheck " + (idx + 1) + " — " + (entry.action || "") + " · " + (entry.provider || "") + " · " + (entry.createdAt || ""),
            "You asked:",
            entry.userAsked || "",
            "",
            "AI understood:",
            entry.understood || "",
            "",
            "Finding:",
            entry.conclusion || "",
            entry.details ? "\\nDetails:\\n" + entry.details : "",
            entry.suggestedComment ? "\\nSuggested paste comment:\\n" + entry.suggestedComment : "",
          ].filter(Boolean).join("\\n");
        }).join("\\n\\n")
      : "(none yet)";
    return [
      "Please help with this PR review finding. Use the full recheck thread below as context.",
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
      "## Current paste comment (may be edited by reviewer)",
      comment,
      "",
      "## Draft notes (not submitted yet)",
      notes || "(none)",
      "",
      "## Recheck history (newest first — full thread)",
      history,
      "",
      "Reply with: stand | update (what to change) | false alarm (why).",
      "If asked for a GitHub paste comment, give 1–3 short polite sentences (Could we…?).",
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

  function syncProviderSelects(fromTeach) {
    if (!(els.provider instanceof HTMLSelectElement)) return;
    if (!(els.providerTeach instanceof HTMLSelectElement)) return;
    if (fromTeach) {
      if (els.providerTeach.value) els.provider.value = els.providerTeach.value;
    } else if (els.provider.value) {
      els.providerTeach.value = els.provider.value;
    }
  }

  function fillProviderSelect(select, list, preferredValue) {
    if (!(select instanceof HTMLSelectElement)) return;
    select.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "No providers";
      select.appendChild(empty);
      return;
    }
    list.forEach(function (id) {
      var o = document.createElement("option");
      o.value = id;
      o.textContent = id;
      select.appendChild(o);
    });
    if (preferredValue && list.indexOf(preferredValue) !== -1) {
      select.value = preferredValue;
      return;
    }
    var preferred = ["cursor", "claude-code", "command-code", "anthropic"];
    for (var i = 0; i < preferred.length; i++) {
      if (list.indexOf(preferred[i]) !== -1) {
        select.value = preferred[i];
        break;
      }
    }
  }

  async function loadProviders() {
    if (!SERVED || !(els.provider instanceof HTMLSelectElement)) {
      if (els.serveHint) {
        els.serveHint.hidden = false;
        els.serveHint.textContent =
          "Recheck needs the local server. From the repo root run: pnpm prsm --serve-ui then open /pr/" + PR + "/";
      }
      if (els.recheckBtn) els.recheckBtn.disabled = true;
      if (els.teachBtn) els.teachBtn.disabled = true;
      if (els.verifyBtn) els.verifyBtn.disabled = true;
      return;
    }
    try {
      var res = await fetch(apiUrl("/providers"));
      var body = await res.json();
      var list = Array.isArray(body.providers) ? body.providers : [];
      var cliOnly = list.filter(function (id) {
        return id === "cursor" || id === "claude-code" || id === "command-code";
      });
      var previous = els.provider.value;
      fillProviderSelect(els.provider, list, previous);
      fillProviderSelect(els.providerTeach, list, previous || els.provider.value);
      syncProviderSelects(false);

      if (!list.length) {
        if (els.recheckBtn) els.recheckBtn.disabled = true;
        if (els.teachBtn) els.teachBtn.disabled = true;
        if (els.verifyBtn) els.verifyBtn.disabled = true;
        return;
      }

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

      if (els.serveHint) els.serveHint.hidden = true;
      if (els.recheckBtn) els.recheckBtn.disabled = rechecking;
      if (els.teachBtn) els.teachBtn.disabled = rechecking;
      if (els.verifyBtn) els.verifyBtn.disabled = verifying;
      if (els.notes) els.notes.disabled = rechecking;
      if (els.provider) els.provider.disabled = rechecking;
      if (els.providerTeach) els.providerTeach.disabled = rechecking;
    } catch (e) {
      if (els.serveHint) {
        els.serveHint.hidden = false;
        els.serveHint.textContent = "Could not reach /api/providers. Is --serve running?";
      }
      if (els.recheckBtn) els.recheckBtn.disabled = true;
      if (els.teachBtn) els.teachBtn.disabled = true;
      if (els.verifyBtn) els.verifyBtn.disabled = true;
    }
  }

  function selectedVerifyAgents() {
    return Array.from(document.querySelectorAll('input[name="verify-agent"]:checked'))
      .map(function (el) { return el instanceof HTMLInputElement ? el.value : ""; })
      .filter(Boolean);
  }

  function setVerifyUiRunning(running) {
    verifying = Boolean(running);
    if (els.verifyBtn) {
      els.verifyBtn.disabled = running || !SERVED;
      setBtnLabel(els.verifyBtn, running ? "Verifying…" : "Verify author updates");
    }
    if (els.verifyPanel) els.verifyPanel.hidden = false;
  }

  function renderVerifyJob(job) {
    if (!job) return;
    if (els.verifyPanel) els.verifyPanel.hidden = false;
    var progress = job.progress;
    var headline =
      job.status === "running"
        ? "VERIFYING"
        : job.status === "done"
          ? "VERIFY DONE"
          : "VERIFY FAILED";
    if (els.verifyStatus) {
      els.verifyStatus.hidden = false;
      els.verifyStatus.className = "verify-status " + job.status;
      if (job.status === "done" && job.counts) {
        var c = job.counts;
        els.verifyStatus.innerHTML =
          headline +
          " · resolved " +
          (c.resolved || 0) +
          " · accepted " +
          (c.accepted || 0) +
          " · needs look " +
          (c.needs_look || 0) +
          " · still open " +
          (c.still_open || 0) +
          ' · <a href="verify-report.html">Open report</a>';
      } else if (job.status === "error") {
        els.verifyStatus.textContent = headline + " · " + (job.error || "unknown error");
      } else {
        els.verifyStatus.textContent =
          headline +
          (progress && progress.label ? " · " + progress.label : "");
      }
    }
    if (els.verifyLive) {
      els.verifyLive.hidden = false;
      var ageMs = Date.now() - Date.parse(job.updatedAt || job.createdAt || "");
      var age =
        !Number.isFinite(ageMs) || ageMs < 0
          ? ""
          : ageMs < 2000
            ? "just now"
            : ageMs < 60000
              ? Math.floor(ageMs / 1000) + "s ago"
              : Math.floor(ageMs / 60000) + "m ago";
      var pct =
        progress && progress.total
          ? " · " + progress.current + "/" + progress.total
          : "";
      els.verifyLive.textContent =
        job.status === "running"
          ? "Live" + pct + " · last update " + age + " (agent may sit quiet while the model thinks)"
          : "Finished · last update " + age;
    }
    if (els.verifyLogs) {
      var logs = Array.isArray(job.logs) ? job.logs : [];
      els.verifyLogs.textContent = logs.join("\\n");
      if (logs.length !== lastVerifyLogCount) {
        els.verifyLogs.scrollTop = els.verifyLogs.scrollHeight;
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

  function startVerifyPoll(id) {
    verifyJobId = id;
    stopVerifyPoll();
    verifyPollTimer = window.setInterval(pollVerifyJob, 1000);
    pollVerifyJob();
  }

  async function pollVerifyJob() {
    if (!verifyJobId) return;
    try {
      var res = await fetch(apiUrl("/verify/" + verifyJobId));
      var job = await res.json();
      if (!res.ok) throw new Error(job.error || ("HTTP " + res.status));
      renderVerifyJob(job);
      if (job.status === "done" || job.status === "error") {
        stopVerifyPoll();
        setVerifyUiRunning(false);
        if (job.status === "done") {
          if (job.payload && Array.isArray(job.payload.findings)) {
            all = job.payload.findings.map(findingFromApi);
          }
          var c = job.counts || {};
          showFlash(
            "Verify done · resolved " +
              (c.resolved || 0) +
              " · still open " +
              (c.still_open || 0),
          );
          clampIndex();
          paint();
        } else {
          showFlash(job.error || "Verify failed");
        }
      } else {
        setVerifyUiRunning(true);
      }
    } catch (e) {
      if (els.verifyLive) {
        els.verifyLive.hidden = false;
        els.verifyLive.textContent =
          "Poll error — retrying… " + (e && e.message ? e.message : "");
      }
    }
  }

  async function attachActiveVerify() {
    if (!SERVED) return;
    try {
      var res = await fetch(apiUrl("/verify/active"));
      var body = await res.json();
      if (body && body.job && body.job.id && body.job.prNumber === PR) {
        renderVerifyJob(body.job);
        if (body.job.status === "running") {
          setVerifyUiRunning(true);
          startVerifyPoll(body.job.id);
        }
      }
    } catch (e) { /* ignore */ }
  }

  async function verifyAuthorUpdates() {
    if (!SERVED || verifying || rechecking) return;
    var agents = selectedVerifyAgents();
    if (!agents.length) {
      showFlash("Pick at least one agent for verify");
      return;
    }
    setVerifyUiRunning(true);
    lastVerifyLogCount = 0;
    if (els.verifyStatus) {
      els.verifyStatus.hidden = false;
      els.verifyStatus.className = "verify-status running";
      els.verifyStatus.textContent = "Starting verify with " + agents.join(", ") + "…";
    }
    if (els.verifyLive) {
      els.verifyLive.hidden = false;
      els.verifyLive.textContent = "Starting…";
    }
    if (els.verifyLogs) els.verifyLogs.textContent = "";
    try {
      var res = await fetch(apiUrl("/verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers: agents }),
      });
      var body = await res.json();
      if (res.status === 409 && body.jobId) {
        showFlash("Already verifying — showing live progress");
        startVerifyPoll(body.jobId);
        if (body.job) renderVerifyJob(body.job);
        return;
      }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      var jobId = body.jobId || (body.job && body.job.id);
      if (!jobId) throw new Error("Verify job did not return an id");
      if (body.job) renderVerifyJob(body.job);
      startVerifyPoll(jobId);
    } catch (e) {
      setVerifyUiRunning(false);
      showFlash(e && e.message ? e.message : "Verify failed");
      if (els.verifyStatus) {
        els.verifyStatus.hidden = false;
        els.verifyStatus.className = "verify-status error";
        els.verifyStatus.textContent =
          e && e.message ? e.message : "Verify failed";
      }
    }
  }

  let recheckPollTimer = 0;
  let recheckJobId = "";
  let lastRecheckLogCount = 0;

  function clearRecheckLivePanel() {
    if (els.recheckPanel) els.recheckPanel.hidden = true;
    if (els.recheckStatus) {
      els.recheckStatus.hidden = true;
      els.recheckStatus.textContent = "";
      els.recheckStatus.className = "recheck-status";
    }
    if (els.recheckLive) {
      els.recheckLive.hidden = true;
      els.recheckLive.textContent = "";
    }
    if (els.recheckLogs) els.recheckLogs.textContent = "";
    lastRecheckLogCount = 0;
  }

  function setRecheckUiRunning(running) {
    rechecking = Boolean(running);
    if (els.recheckBtn) {
      els.recheckBtn.disabled = running || !SERVED;
      setBtnLabel(els.recheckBtn, running ? "Rechecking…" : "Ask");
    }
    if (els.teachBtn) {
      els.teachBtn.disabled = running || !SERVED;
      setBtnLabel(els.teachBtn, running ? "Teaching…" : "Teach me");
    }
    if (els.notes) els.notes.disabled = running;
    if (els.provider) els.provider.disabled = running || !SERVED;
    if (els.providerTeach) els.providerTeach.disabled = running || !SERVED;
    if (running && els.recheckPanel) els.recheckPanel.hidden = false;
  }

  function renderRecheckJob(job) {
    if (els.recheckPanel) els.recheckPanel.hidden = false;
    if (els.recheckStatus) {
      els.recheckStatus.hidden = false;
      els.recheckStatus.className =
        "recheck-status " +
        (job.status === "running"
          ? "running"
          : job.status === "done"
            ? "done"
            : "error");
      els.recheckStatus.textContent =
        (job.status === "running" ? "RUNNING · " : job.status === "done" ? "DONE · " : "FAILED · ") +
        (job.label || job.note || "");
    }
    if (els.recheckLive) {
      els.recheckLive.hidden = false;
      var ageMs = Date.now() - Date.parse(job.updatedAt || job.createdAt || "");
      var age =
        !Number.isFinite(ageMs) || ageMs < 0
          ? ""
          : ageMs < 2000
            ? "just now"
            : ageMs < 60000
              ? Math.floor(ageMs / 1000) + "s ago"
              : Math.floor(ageMs / 60000) + "m ago";
      els.recheckLive.textContent =
        job.status === "running"
          ? "Live progress for this run only · last update " + age
          : "Finishing… · last update " + age;
    }
    if (els.recheckLogs) {
      var logs = Array.isArray(job.logs) ? job.logs : [];
      els.recheckLogs.textContent = logs.join("\\n");
      if (logs.length !== lastRecheckLogCount) {
        els.recheckLogs.scrollTop = els.recheckLogs.scrollHeight;
        lastRecheckLogCount = logs.length;
      }
    }
  }

  function stopRecheckPoll() {
    if (recheckPollTimer) {
      window.clearInterval(recheckPollTimer);
      recheckPollTimer = 0;
    }
  }

  function finishRecheckJob(job) {
    stopRecheckPoll();
    setRecheckUiRunning(false);
    clearRecheckLivePanel();
    if (job.payload && Array.isArray(job.payload.findings)) {
      all = job.payload.findings.map(findingFromApi);
    }
    var action = job.action || "";
    if (action === "false_alarm") {
      showFlash("Saved in Recheck history · marked false alarm (paste comment unchanged)");
      clampIndex();
    } else if (action === "update") {
      showFlash("Saved in Recheck history · analysis updated (suggested paste is there)");
      if (job.finding && job.finding.id) focusById(job.finding.id);
    } else {
      showFlash("Saved in Recheck history · stood (see newest card below)");
      if (job.finding && job.finding.id) focusById(job.finding.id);
    }
    paint();
    var host = document.getElementById("recheck-history");
    if (host) host.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function pollRecheckJob() {
    if (!recheckJobId) return;
    try {
      var res = await fetch(apiUrl("/reverify/" + recheckJobId));
      var job = await res.json();
      if (!res.ok) throw new Error(job.error || ("HTTP " + res.status));
      renderRecheckJob(job);
      if (job.status === "done" || job.status === "error") {
        if (job.status === "error") {
          stopRecheckPoll();
          setRecheckUiRunning(false);
          showFlash(job.error || "Recheck failed");
          // Leave the live panel visible briefly so the failure is readable,
          // but mark it clearly — editing notes will hide it.
          if (els.recheckStatus) {
            els.recheckStatus.hidden = false;
            els.recheckStatus.className = "recheck-status error";
            els.recheckStatus.textContent = job.error || "Recheck failed";
          }
        } else {
          finishRecheckJob(job);
        }
      } else {
        setRecheckUiRunning(true);
      }
    } catch (e) {
      if (els.recheckLive) {
        els.recheckLive.hidden = false;
        els.recheckLive.textContent =
          "Poll error — retrying… " + (e && e.message ? e.message : "");
      }
    }
  }

  function startRecheckPoll(id) {
    recheckJobId = id;
    stopRecheckPoll();
    recheckPollTimer = window.setInterval(pollRecheckJob, 1000);
    pollRecheckJob();
  }

  async function attachActiveRecheck() {
    if (!SERVED) return;
    try {
      var res = await fetch(apiUrl("/reverify/active"));
      var body = await res.json();
      if (body && body.job && body.job.id && body.job.prNumber === PR) {
        renderRecheckJob(body.job);
        if (body.job.status === "running") {
          setRecheckUiRunning(true);
          startRecheckPoll(body.job.id);
        }
      }
    } catch (e) { /* ignore */ }
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

    setRecheckUiRunning(true);
    lastRecheckLogCount = 0;
    if (els.recheckPanel) els.recheckPanel.hidden = false;
    if (els.recheckStatus) {
      els.recheckStatus.hidden = false;
      els.recheckStatus.className = "recheck-status running";
      els.recheckStatus.textContent =
        "Starting " + els.provider.value + "…";
    }
    if (els.recheckLogs) els.recheckLogs.textContent = "";
    if (els.recheckLive) {
      els.recheckLive.hidden = false;
      els.recheckLive.textContent = "Starting…";
    }

    try {
      var res = await fetch(apiUrl("/reverify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          findingId: f.id,
          prompt: notes,
          provider: els.provider.value,
        }),
      });
      var body = await res.json();
      if (res.status === 409 && body.jobId) {
        showFlash("Already rechecking — showing live progress");
        startRecheckPoll(body.jobId);
        if (body.job) renderRecheckJob(body.job);
        return;
      }
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      var jobId = body.jobId || (body.job && body.job.id);
      if (!jobId) throw new Error("Recheck job did not return an id");
      if (body.job) renderRecheckJob(body.job);
      startRecheckPoll(jobId);
    } catch (e) {
      setRecheckUiRunning(false);
      clearRecheckLivePanel();
      showFlash(e && e.message ? e.message : "Recheck failed");
    }
  }

  async function setDisposition(disposition) {
    var f = current();
    if (!f || !SERVED) return;
    var notes = els.notes instanceof HTMLTextAreaElement ? els.notes.value : "";
    state.notes[f.storageId] = notes;
    saveState(state);
    try {
      var res = await fetch(apiUrl("/disposition"), {
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
  if (els.copyTeachBtn) {
    els.copyTeachBtn.addEventListener("click", copyTeachLesson);
  }
  var copyTeachBottom = document.getElementById("btn-copy-teach-bottom");
  if (copyTeachBottom) {
    copyTeachBottom.addEventListener("click", copyTeachLesson);
  }
  document.getElementById("btn-copy-comment").addEventListener("click", copyComment);
  document.getElementById("btn-copy-current-code").addEventListener("click", copyCurrentCode);
  document.getElementById("btn-copy-better-code").addEventListener("click", copyBetterCode);
  document.getElementById("btn-copy-original").addEventListener("click", copyOriginalComment);
  document.getElementById("btn-copy-notes").addEventListener("click", copyNotes);
  document.getElementById("btn-reset-comment").addEventListener("click", resetComment);
  document.getElementById("btn-copy-agent").addEventListener("click", copyForAgent);
  document.getElementById("btn-copy-agent-top").addEventListener("click", copyForAgent);
  document.getElementById("btn-recheck").addEventListener("click", recheck);
  if (els.teachBtn) {
    els.teachBtn.addEventListener("click", function () {
      syncProviderSelects(true);
      if (!(els.notes instanceof HTMLTextAreaElement)) return;
      els.notes.value =
        "Teach me this finding the way a patient teammate would — deep, not a summary.\\n\\n" +
        "I need a full classroom walkthrough:\\n" +
        "1) Punchline first (what is already correct vs what is wrong).\\n" +
        "2) Exact file/function/line numbers.\\n" +
        "3) Tiny real code snippets in fenced blocks tagged with PR line numbers (example: triple-backtick ts:108).\\n" +
        "4) Under EACH important line: Input (sample values) → What happens → Output/next state.\\n" +
        "5) Side-by-side with any already-correct function if one exists.\\n" +
        "6) Request A / Request B timeline if concurrency matters.\\n" +
        "7) What the reviewer wants, step by step.\\n" +
        "8) Short human GitHub comment.\\n\\n" +
        "Put the full lesson in teachMe. Depth beats brevity. Do NOT use a READ/WRITE/CALL/WAIT checklist.";
      recheck();
    });
  }
  if (els.provider instanceof HTMLSelectElement) {
    els.provider.addEventListener("change", function () { syncProviderSelects(false); });
  }
  if (els.providerTeach instanceof HTMLSelectElement) {
    els.providerTeach.addEventListener("change", function () { syncProviderSelects(true); });
  }
  if (els.notes instanceof HTMLTextAreaElement) {
    els.notes.addEventListener("input", function () {
      if (!rechecking) clearRecheckLivePanel();
    });
  }
  if (els.verifyBtn) {
    els.verifyBtn.addEventListener("click", verifyAuthorUpdates);
  }
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
    if (event.key === "ArrowLeft" || event.key === "k") { event.preventDefault(); go(-1); }
    if (event.key === "ArrowRight" || event.key === "j") { event.preventDefault(); go(1); }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      var f = current();
      if (!f) return;
      toggleResolve(!isResolved(f));
    }
  });

  loadProviders();
  attachActiveVerify();
  attachActiveRecheck();
  paint();
})();
</script>`;
}

export function renderFinalReviewTriage(run: ReviewRun): string {
  const ordered = sortFindingsForTriage(
    run.findings.filter((f) => f.kind !== "praise"),
  );
  const link = {
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
  };
  const payload = {
    prNumber: run.prNumber,
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
    findings: ordered.map((finding) => toTriageFinding(finding, link)),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${workspaceChromeHeadHtml()}
  <title>PR #${run.prNumber} — Triage</title>
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
      --inset: #0d0e0f;
      --line: #3e4850;
      --accent: #4fc1ff;
      --accent-hover: #84cfff;
      --code-bg: #0d0e0f;
      --comment-bg: #1b3a4b;
      --blocker: #f14c4c;
      --major: #dcdcaa;
      --minor: #9cdcfe;
      --nit: #808080;
      --question: #c586c0;
      --button-fg: #00344c;
      --copied: #388a34;
      --resolved: #3d7a45;
    }
    * { box-sizing: border-box; }
    ${workspaceChromeCss()}
    html, body.wb-page {
      height: 100%;
      overflow: hidden;
      color-scheme: dark;
    }
    body.wb-page {
      margin: 0;
      font-family: "Hanken Grotesk", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      font-size: 13px;
      color: var(--ink);
      background: var(--bg);
      line-height: 20px;
    }
    .wb-body:has(.triage-shell) {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0;
    }
    .triage-shell {
      flex: 1;
      display: grid;
      grid-template-columns: 248px 1fr;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .queue-pane {
      border-right: 1px solid var(--line);
      background: var(--bg-elevated);
      overflow: auto;
      padding: 0;
      min-height: 0;
    }
    .queue-head {
      position: sticky; top: 0; z-index: 2;
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px;
      padding: 12px 12px 8px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--muted);
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--line);
    }
    .queue-filters {
      display: flex; flex-direction: column; gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
    }
    .queue-group {
      margin: 14px 12px 4px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
    }
    .queue-group.is-crit { color: var(--blocker); }
    .queue-item {
      display: block; width: 100%; text-align: left;
      background: transparent; border: 0; border-left: 2px solid transparent;
      color: var(--ink); padding: 8px 12px 10px; cursor: pointer;
      font: 400 12px/16px "Hanken Grotesk", sans-serif;
    }
    .queue-item:hover { background: #282a2b; }
    .queue-item.is-active { background: #282a2b; border-left-color: var(--accent); }
    .queue-item .queue-title {
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; color: #e2e2e2;
    }
    .queue-item .queue-file {
      display: block; margin-top: 3px; color: var(--muted);
      font: 11px/16px "JetBrains Mono", ui-monospace, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .triage-stage {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background-color: var(--bg);
      background-image: radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px);
      background-size: 14px 14px;
    }
    .stage-head {
      flex-shrink: 0;
      padding: 12px 20px 0;
      background: var(--bg);
      border-bottom: 1px solid var(--line);
    }
    .stage-title-row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
    .stage-title-row h1 { font-size: 16px; margin: 0; font-weight: 600; color: #fff; }
    .stage-title-row .lede { margin: 0; font-size: 12px; }
    .stage-tools {
      display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
      padding: 8px 0 10px;
    }
    .stage-tools #progress-text { font-size: 12px; font-weight: 600; color: var(--muted); }
    .stage-scroll {
      flex: 1;
      overflow: auto;
      padding: 16px 20px 20px;
    }
    main { max-width: 860px; margin: 0; padding: 0; }
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
    .agent-findings-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0;
      margin: 0;
      padding: 0;
      border-bottom: 0;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      color: var(--muted);
    }
    .agent-findings-nav a, .agent-findings-nav span {
      color: var(--muted);
      text-decoration: none;
      padding: 8px 12px;
      border-bottom: 2px solid transparent;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .agent-findings-nav a:hover { color: #fff; }
    .agent-findings-nav a.is-active, .agent-findings-nav span.is-active {
      color: #fff;
      border-bottom-color: var(--accent);
    }
    .agent-findings-nav { margin: 0; }
    a { color: var(--accent); }
    .overview-fold {
      margin: 0 0 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--card);
      padding: 0 12px 4px;
    }
    .overview-fold > summary {
      padding: 10px 0;
      color: #fff;
      font-weight: 600;
      font-size: 13px;
    }
    .overview-fold .overview {
      border: 0;
      background: transparent;
      margin: 0;
      padding: 0 0 12px;
      display: block;
    }
    .overview-fold .overview h2 { display: none; }
    .overview-fold .overview p, .overview-fold .overview li { color: var(--muted); font-size: 13px; }
    .verify-fold {
      margin-left: auto;
    }
    .verify-fold > summary {
      list-style: none;
      color: var(--accent);
      font-weight: 600;
      font-size: 12px;
      cursor: pointer;
    }
    .verify-fold > summary::-webkit-details-marker { display: none; }
    .verify-fold .verify-body {
      position: absolute;
      right: 20px;
      margin-top: 6px;
      z-index: 5;
      min-width: 280px;
      padding: 12px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 4px;
    }
    .stage-tools { position: relative; }
    #progress-text { font-weight: 600; color: #fff; }
    .hint { color: var(--muted); font-size: 0.88rem; }
    #flash, #serve-hint {
      margin: 0.5rem 0 0;
      color: #9cdcfe;
      font-size: 0.9rem;
      min-height: 1.2em;
    }
    #serve-hint { color: #dcdcaa; }
    #panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 16px;
      border-left: 3px solid var(--minor);
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
    #recheck-status[hidden],
    #recheck-live-panel[hidden],
    #recheck-live[hidden] {
      display: none !important;
    }
    .meta { color: var(--muted); margin: 0.25rem 0 0; font-size: 0.92rem; }
    .meta a.file-link { color: var(--accent); text-decoration: none; }
    .meta a.file-link:hover { color: var(--accent-hover); text-decoration: underline; }
    .meta a.file-link code { color: inherit; }
    .teach-section {
      background: #1b2838;
      border: 1px solid #2d4a66;
      border-radius: 4px;
      padding: 0.85rem 1rem 1rem;
    }
    .teach-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      position: sticky;
      top: 0;
      z-index: 3;
      background: #1b2838;
      margin: -0.35rem -0.15rem 0.35rem;
      padding: 0.35rem 0.15rem 0.45rem;
    }
    .teach-head h3 { margin: 0; }
    .teach-head .hint { margin: 0; }
    .recheck-teach .teach-head {
      background: #1e2a24;
      margin: -0.15rem 0 0.45rem;
      padding: 0.15rem 0 0.35rem;
      position: sticky;
      top: 0;
    }
    .teach-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .teach-provider-label {
      margin: 0;
      color: var(--muted);
      font-size: 0.88rem;
      text-transform: none;
      letter-spacing: 0;
    }
    #provider-teach {
      min-width: 9rem;
      background: var(--inset);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 8px 28px 8px 10px;
      color-scheme: dark;
    }
    .teach-simple,
    .teach-prose {
      margin-top: 0.35rem;
      white-space: pre-wrap;
      font-family: "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
      font-size: 0.92rem;
      line-height: 1.55;
      color: var(--ink);
    }
    .teach-prose {
      margin: 0.35rem 0 0;
      padding: 0;
      background: transparent;
      border: 0;
      overflow-x: auto;
    }
    .teach-block { white-space: pre-wrap; }
    .teach-h {
      margin: 0.85rem 0 0.35rem;
      font-size: 1rem;
      font-weight: 650;
      color: #d7e7dd;
    }
    .teach-label {
      font-weight: 650;
      color: #9ad0b0;
    }
    .teach-code {
      margin: 0.45rem 0;
      padding: 0.55rem 0.7rem;
      background: #141a16;
      border: 1px solid #2f3d34;
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.84rem;
      line-height: 1.4;
    }
    .editor-compact {
      margin: 0.55rem 0 0.75rem;
    }
    .editor-compact .editor-body { max-height: 18rem; }
    .teach-block .editor { margin-top: 0.35rem; }
    .teach-hr {
      border: 0;
      border-top: 1px solid #3d5a45;
      margin: 0.75rem 0;
    }
    .teach-table-wrap {
      margin: 0.55rem 0 0.85rem;
      overflow-x: auto;
      border: 1px solid #3d5a45;
      border-radius: 6px;
      background: #18231d;
    }
    .teach-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
      line-height: 1.4;
    }
    .teach-table th,
    .teach-table td {
      padding: 0.45rem 0.65rem;
      border-bottom: 1px solid #2f3d34;
      text-align: left;
      vertical-align: top;
    }
    .teach-table th {
      background: #24332a;
      color: #d7e7dd;
      font-weight: 650;
      white-space: nowrap;
    }
    .teach-table tr:last-child td { border-bottom: 0; }
    .teach-table td code,
    .teach-table th code {
      color: #9cdcfe;
      font-size: 0.9em;
    }
    .teach-table em { color: #b8a0a0; font-style: italic; }
    .recheck-teach {
      background: #1e2a24;
      border: 1px solid #3d5a45;
      border-radius: 6px;
      padding: 0.65rem 0.75rem;
      margin: 0.55rem 0 0.75rem;
    }
    code {
      font-family: "JetBrains Mono", ui-monospace, monospace;
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
      font-family: "JetBrains Mono", ui-monospace, monospace;
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
      font-family: "JetBrains Mono", ui-monospace, monospace;
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
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 0.9rem;
      line-height: 1.55;
    }
    textarea, select {
      width: 100%;
      margin-top: 0.35rem;
      background: var(--inset);
      color: var(--ink);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 10px 12px;
      font: 13px/20px "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
      color-scheme: dark;
      accent-color: var(--accent);
    }
    select {
      width: auto;
      min-width: 12rem;
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
    textarea { resize: vertical; }
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
      padding: 8px 12px;
      font: 600 12px/16px "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    textarea:disabled,
    select:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    button.btn-secondary {
      background: transparent;
      border-color: var(--line);
      color: var(--ink);
    }
    button.btn-secondary:hover { background: #282a2b; }
    #panel > section + section,
    #panel > details + section,
    #panel > section + details,
    #panel > details + details {
      margin-top: 16px;
    }
    #panel > header { margin-bottom: 12px; }
    .bottom-nav {
      flex-shrink: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 8px 20px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--line);
    }
    .bottom-nav .kbd-hint { margin-right: auto; color: var(--muted); font-size: 12px; }
    kbd {
      display: inline-block; padding: 0 5px; border: 1px solid var(--line);
      border-radius: 3px; font: 11px "JetBrains Mono", ui-monospace, monospace;
    }
    details.block {
      margin-top: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--bg-elevated);
      padding: 0 12px 8px;
    }
    .queue-head-label { display: inline-flex; align-items: center; gap: 6px; }
    details.block > summary {
      padding: 10px 0;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    summary { cursor: pointer; }
    #empty {
      background: var(--bg-elevated);
      border: 1px dashed var(--line);
      border-radius: 4px;
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
    #btn-verify { margin: 0; }
    .verify-agents {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      align-items: flex-start;
      padding: 0 0 8px;
      border: 0;
      background: transparent;
    }
    .verify-agents label {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      margin: 0;
      color: var(--ink);
      font-size: 0.82rem;
      cursor: pointer;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 500;
    }
    .badge-fa {
      background: #3d2a12;
      border-color: #a37a2c;
      color: #dcdcaa;
      margin-left: 0.35rem;
    }
    #panel.is-false-alarm { border-left-color: #dcdcaa; }
    .verify-panel {
      background: var(--bg-elevated);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0.75rem 0.9rem;
      margin: 0.75rem 0 1rem;
    }
    .verify-status { margin: 0 0 0.35rem; font-weight: 600; }
    .verify-status.running { color: var(--major); }
    .verify-status.done { color: #9cdcfe; }
    .verify-status.error { color: var(--blocker); }
    .verify-logs,
    .recheck-logs {
      margin: 0.45rem 0 0;
      max-height: 14rem;
      overflow: auto;
      background: #1e1e1e;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.65rem 0.75rem;
      font: 0.78rem/1.45 "JetBrains Mono", ui-monospace, monospace;
      white-space: pre-wrap;
      color: #cccccc;
    }
    .recheck-live-panel {
      background: var(--bg-elevated);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0.75rem 0.9rem;
      margin: 0.75rem 0 0;
    }
    .recheck-status { margin: 0 0 0.35rem; font-weight: 600; color: #9cdcfe; }
    .recheck-status.running { color: var(--major); }
    .recheck-status.done { color: #9cdcfe; }
    .recheck-status.error { color: var(--blocker); }
    #recheck-history { margin-top: 1rem; display: grid; gap: 0.75rem; }
    .recheck-entry {
      background: var(--bg-elevated);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 0.75rem 0.9rem;
    }
    .recheck-entry.is-latest {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .badge-latest {
      background: #1e3a5f;
      border-color: var(--accent);
      color: #9cdcfe;
      text-transform: none;
      letter-spacing: 0;
    }
    .recheck-entry header {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.55rem;
    }
    .recheck-entry p { margin: 0.35rem 0; }
    .recheck-entry details { margin-top: 0.45rem; }
    .recheck-details { white-space: pre-wrap; color: var(--muted); font-size: 0.9rem; }
    .recheck-suggest {
      margin-top: 0.65rem;
      padding-top: 0.55rem;
      border-top: 1px solid var(--line);
    }
    .recheck-suggest-body {
      margin: 0.35rem 0 0.55rem;
      white-space: pre-wrap;
      background: #1e1e1e;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.55rem 0.7rem;
      font: 0.88rem/1.45 "JetBrains Mono", ui-monospace, monospace;
      color: #d4d4d4;
    }
  </style>
</head>
<body class="wb-page">
  ${workspaceChromeOpenHtml({ prNumber: run.prNumber, active: "triage" })}
  <div class="triage-shell">
    <aside class="queue-pane">
      <div class="queue-head"><span class="queue-head-label">${iconHtml("list")} Queue</span> <span id="queue-count">…</span></div>
      <div class="queue-filters">
        <label class="toggle"><input type="checkbox" id="show-resolved" /> Include resolved</label>
        <label class="toggle"><input type="checkbox" id="show-false-alarms" /> Include false alarms</label>
      </div>
      <div id="finding-queue"></div>
    </aside>
    <div class="triage-stage">
      <header class="stage-head">
        <div class="stage-title-row">
          <h1>PR #${run.prNumber}</h1>
          <p class="lede">${escapeHtml(run.title ?? "")}</p>
        </div>
        ${agentFindingsNavHtml(run, escapeHtml)}
        <div class="stage-tools">
          <span id="progress-text">…</span>
          <details class="verify-fold">
            <summary>${iconHtml("shield-check")} Verify updates</summary>
            <div class="verify-body">
              <div class="verify-agents" id="verify-agents" aria-label="Agents for verify"></div>
              <button type="button" id="btn-verify" disabled>${iconTextHtml("shield-check", "Verify author updates")}</button>
              <section id="verify-panel" class="verify-panel" hidden>
                <p id="verify-status" class="verify-status"></p>
                <p id="verify-live" class="hint" hidden></p>
                <pre id="verify-logs" class="verify-logs" aria-live="polite"></pre>
              </section>
            </div>
          </details>
        </div>
      </header>
      <div class="stage-scroll">
  <main>
    ${run.overview ? `<details class="overview-fold"><summary>${iconHtml("book-open")} PR overview</summary>${renderOverviewHtml(run.overview, escapeHtml)}</details>` : ""}
    <p id="serve-hint" hidden></p>
    <p id="flash" hidden></p>

    <div id="empty" hidden>
      <p>All caught up — nothing left in the open queue.</p>
      <p class="hint">Toggle “Include false alarms” or “Include resolved” in the queue to revisit.</p>
    </div>

    <article id="panel" hidden>
      <header>
        <span class="badge" id="sev-badge">—</span>
        <span class="badge badge-fa" id="fa-badge" hidden>False alarm</span>
        <h2 id="finding-title">Finding</h2>
        <p class="meta" id="finding-meta"></p>
      </header>

      <section>
        <h3>Issue</h3>
        <p id="issue-simple"></p>
      </section>

      <section>
        <h3>Current code</h3>
        <div class="toolbar">
          <button type="button" class="btn-secondary" id="btn-copy-current-code">${iconTextHtml("copy", "Copy code")}</button>
          <button type="button" class="btn-secondary" id="btn-copy-agent-top">${iconTextHtml("clipboard", "Copy for agent")}</button>
        </div>
        <div class="editor-host" id="current-code"></div>
      </section>

      <section>
        <div class="suggest-head">
          <h3>Suggested comment</h3>
          <div class="toolbar">
            <button type="button" class="btn-secondary" id="btn-reset-comment">${iconTextHtml("rotate-ccw", "Reset")}</button>
            <button type="button" class="btn-secondary" id="btn-copy-comment">${iconTextHtml("copy", "Copy")}</button>
            <button type="button" id="btn-save-comment">${iconTextHtml("save", "Save")}</button>
          </div>
        </div>
        <textarea id="simple-comment" rows="5" placeholder="Short polite comment…"></textarea>
        <details>
          <summary>Original generated comment</summary>
          <div class="toolbar">
            <button type="button" class="btn-secondary" id="btn-copy-original">${iconTextHtml("copy", "Copy original")}</button>
          </div>
          <pre class="comment-body" id="original-comment"></pre>
        </details>
      </section>

      <details class="block">
        <summary>${iconHtml("sliders")} Details (why / fix / better code)</summary>
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
            <button type="button" class="btn-secondary" id="btn-copy-better-code">${iconTextHtml("copy", "Copy better code")}</button>
          </div>
          <div class="editor-host" id="better-code"></div>
        </section>
      </details>

      <details class="block">
        <summary>${iconHtml("graduation-cap")} Teach me (Generate lesson)</summary>
        <section class="teach-section">
        <div class="teach-head">
          <h3>Explain simply</h3>
          <button type="button" id="btn-copy-teach">${iconTextHtml("copy", "Copy lesson")}</button>
        </div>
        <p class="hint">A plain walkthrough of this finding. Teach me runs one agent for a teammate-style lesson, then saves it in Recheck history.</p>
        <div id="teach-simple" class="teach-simple"></div>
        <div class="toolbar teach-actions" style="margin-top:0.5rem">
          <label for="provider-teach" class="teach-provider-label">Agent</label>
          <select id="provider-teach" aria-label="Teach me agent"></select>
          <button type="button" id="btn-teach-me" disabled>${iconTextHtml("graduation-cap", "Teach me")}</button>
          <button type="button" class="btn-secondary" id="btn-copy-teach-bottom">${iconTextHtml("copy", "Copy lesson")}</button>
        </div>
        </section>
      </details>

      <details class="block" open>
        <summary>${iconHtml("message-circle")} Recheck (Ask follow-up)</summary>
      <section>
        <p class="hint">Ask a follow-up. Answers land in Recheck history.</p>
        <textarea id="notes" rows="3" placeholder="e.g., Does wrapping it in db.transaction() solve this entirely?"></textarea>
        <div class="provider-row">
          <label for="provider">Provider</label>
          <select id="provider" aria-label="Provider">
            <option value="">Loading…</option>
          </select>
          <button type="button" id="btn-recheck" disabled>${iconTextHtml("message-circle", "Ask")}</button>
          <button type="button" class="btn-secondary" id="btn-copy-notes">${iconTextHtml("copy", "Copy notes")}</button>
        </div>
        <div id="recheck-live-panel" class="recheck-live-panel" hidden>
          <p class="hint" style="margin:0 0 0.35rem"><strong>Live run</strong> — disappears when finished; the result card is saved in history.</p>
          <p id="recheck-status" class="recheck-status" hidden></p>
          <p id="recheck-live" class="hint" hidden></p>
          <pre id="recheck-logs" class="recheck-logs" aria-live="polite"></pre>
        </div>
      </section>
      </details>
      <details class="block">
        <summary>${iconHtml("layers")} Recheck history</summary>
        <p class="hint" style="margin-top:0">Newest first.</p>
        <div id="recheck-history"></div>
      </details>
    </article>
  </main>
      </div>
    <nav class="bottom-nav" aria-label="Triage navigation">
      <span class="kbd-hint"><kbd>j</kbd> <kbd>k</kbd> navigate · <kbd>R</kbd> resolve</span>
      <button type="button" class="btn-secondary" id="btn-back">${iconTextHtml("chevron-left", "Back")}</button>
      <button type="button" class="btn-secondary" id="btn-false-alarm" hidden>${iconTextHtml("bell-off", "False Alarm")}</button>
      <button type="button" class="btn-secondary" id="btn-copy-agent">${iconTextHtml("clipboard", "Copy for agent")}</button>
      <button type="button" class="btn-secondary" id="btn-restore" hidden>${iconTextHtml("undo", "Restore")}</button>
      <button type="button" class="btn-secondary" id="btn-reopen" hidden>${iconTextHtml("rotate-ccw", "Reopen")}</button>
      <button type="button" class="btn-secondary" id="btn-resolve">${iconTextHtml("check", "Resolved")}</button>
      <button type="button" id="btn-next">${iconTextHtml("chevron-right", "Next finding")}</button>
    </nav>
    </div>
  </div>
  ${workspaceChromeCloseHtml()}
  <script>window.__TRIAGE__ = ${embedJson(payload)};</script>
  ${clientScript()}
</body>
</html>`;
}
