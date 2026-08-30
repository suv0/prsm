/**
 * Shared in-UI help: short hover tooltips for buttons, tabs, and sections.
 * Use tip("…") on interactive elements; CSS in uiHelpCss() styles data-help.
 */

export function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** title + data-help for native + styled tooltips. */
export function tip(text: string): string {
  const e = escapeAttr(text.trim());
  return `data-help="${e}" title="${e}"`;
}

/** Shared copy — keep each line one clear action or meaning. */
export const Help = {
  // Workspace chrome
  navHome: "Home — inbox of local PR reviews on this machine.",
  navNewReview: "New Review — paste a PR URL and run selected agents.",
  navSettings: "Settings — Connect GitHub (private repos) and manage AI agent CLIs.",
  navLive: "Live run — watch agent progress and logs for the current job.",
  tabLive: "Live run — real-time status while agents review the PR.",
  tabTriage: "Triage — one finding at a time: teach, recheck, verify, mark false alarm or done.",
  tabList: "List — all open findings on one page; copy fix briefs; verify all open.",
  tabVerify:
    "Report — last verify job only (this-job verdicts). Not the cumulative Fixed queue; run Verify from Triage or List.",
  tabVerifySoon:
    "No verify report yet. Triage → Verify this finding, or List → Verify all open findings.",
  sidebarToggle: "Collapse or expand the sidebar (icons-only vs labels).",

  // Hub inbox / settings / run
  btnNewReview: "Open the New Review wizard to start agents on a PR URL.",
  btnRefreshReviews: "Reload the list of local reviews from disk.",
  inboxTable:
    "Each row is a local review folder reviews/<PR number>/ (e.g. reviews/43/). Status is your hub label; Actions open triage or delete.",
  activityBox: "Pick a PR row to see a short activity snapshot for that review.",
  metricsBox: "Rough counts across local reviews (open findings / blockers).",
  githubSave: "Save a GitHub token in ~/.prsm (not git) for private PR access.",
  githubClear: "Remove the saved token from this machine.",
  agentsRecheck: "Re-scan PATH for installed agent CLIs and refresh Detected status.",
  addAgent: "Register another CLI by command name so it appears in agent pickers.",
  runReview: "Start the multi-agent review job for this PR URL (no GitHub posting).",
  resetInstructions: "Restore the default extra-instructions text for agent prompts.",
  requireDecisions: "When on, missing/thin design-decision .md files become blockers.",
  forceStop: "Kill the running review job and its agent child processes.",
  restartJob: "Start the same review again with the previous settings.",
  statusPillGithub: "GitHub auth state for private repos. Public PRs work without login.",
  statusPillAgents: "How many local agent CLIs are detected and ready.",

  // Agent findings strip
  mergedNav: "Merged triage — combined findings from every agent (deduped into one queue).",
  agentNav: "This agent’s own snapshot only — not the merged queue.",

  // Triage queue / status
  queuePane: "Open findings for this PR. Click a row to focus that card.",
  queueCount: "How many findings match the current filters.",
  includeResolved:
    "Also show browser “Resolved” and Verify “Fixed” cards that are hidden from the open queue by default.",
  includeFalseAlarms:
    "Also show findings you marked as false alarms (kept on disk, not deleted).",
  progressCounts:
    "Open = still need work. Fixed = Verify said resolved/accepted (on disk). False alarms = you said not real. Marked done = Resolved in this browser only. Card = place in the filtered queue.",
  badgeSeverity: "Severity the reviewer agents assigned to this finding.",
  badgeFalseAlarm: "You marked this as not a real issue. Still stored on disk.",
  badgeFixed: "Verify marked this resolved or accepted. Removed from the open queue.",
  badgeExternalMatch:
    "Someone else already left a GitHub comment near this — click to see the covered/skip note or the proposed follow-up.",

  // Triage actions
  verifyThis:
    "Verify this card only: fetch latest PR + threads, ask the selected agent if it is addressed. Opens an inline panel (does not cover the finding). Resolved/accepted → Fixed on disk. For every open finding, use List → Verify all open.",
  verifyThisBtn:
    "Run verify for the finding on screen. Updates disposition and refreshes queue counts.",
  verifyClose:
    "Hide this verify panel so the finding is readable again. A running job keeps going in the background — reopen Verify to watch logs.",
  verifyAgents: "Which local agent CLI judges this finding. Tick at least one.",
  overviewFold: "Short PR summary from the overview pass — what changed and what to watch.",
  sectionIssue: "Plain-language statement of the problem.",
  sectionCurrentCode: "Code at the cited location when the review ran.",
  copyCode: "Copy the current-code snippet to the clipboard.",
  copyFixBrief:
    "Copy a paste-ready brief for your coding agent (file, issue, why, fix). Does not post to GitHub.",
  sectionComment: "Your short GitHub paste comment for this finding (edit, then Copy).",
  resetComment: "Restore the originally generated review comment in the paste box.",
  copyComment: "Copy the paste-box text to put on the PR yourself. PRism never auto-posts.",
  saveComment: "Save the paste comment in this browser for this PR (local only).",
  originalComment: "The model’s first suggested comment, before your edits.",
  detailsFold: "Why it matters, how to fix, and a suggested better snippet.",
  copyBetter: "Copy the suggested better-code snippet.",
  teachFold:
    "Generate a teammate-style lesson for this finding (one agent). Saved under Recheck history.",
  teachMe: "Ask the selected agent to explain this finding simply; result appears above and in history.",
  copyLesson: "Copy the Teach me lesson text.",
  teachAgent: "Which CLI writes the Teach me lesson.",
  recheckFold:
    "Ask a follow-up about this finding. Answer + optional paste comment go to Recheck history.",
  recheckAsk: "Send your question to the selected agent. Does not post to GitHub.",
  recheckProvider: "Which CLI answers this Recheck question.",
  copyNotes: "Copy the notes/question text from the box.",
  recheckHistory: "Past Teach me / Recheck answers for this finding (newest first).",
  navBack: "Previous finding in the filtered queue (keyboard: k or ←).",
  navNext: "Next finding in the filtered queue (keyboard: j or →).",
  falseAlarm:
    "Mark as not a real issue. Kept on disk under False alarms; removed from the open queue.",
  reopen: "Return a false alarm to the open queue.",
  resolveBrowser:
    "Mark done in this browser only (localStorage). Does not change disk disposition. Keyboard: R.",
  restoreBrowser: "Undo browser Resolved — put the card back in the open queue view.",
  kbdHint: "Keyboard: j/k or arrows move between findings; R toggles browser Resolved.",

  // List page
  listOpen: "Findings still open (not false alarm, not Verify-fixed).",
  listFixed: "Findings Verify marked resolved/accepted — left the open queue.",
  listBrowserResolved: "Cards you marked Resolved in this browser (local only).",
  copyAllFix: "Copy every open finding as one markdown brief for a coding agent.",
  downloadFix: "Download the same open-findings brief as a .md file.",
  verifyAll:
    "Verify every open finding against the latest PR with selected agents. Resolved/accepted → Fixed on disk. Triage Verify checks only the current card.",
  verifyAllBtn:
    "Run verify for all open findings. Writes verify-report.html and refreshes this page when done.",
  cardResolve: "Mark done in this browser only — does not set disk Fixed.",
  cardRestore: "Undo browser Resolved and show this card under Open again.",
  saveNotes: "Save private notes for this finding in this browser.",

  // Verify report
  verifyReport:
    "Last verify job’s report only. Counts below are this job’s verdicts — not all Fixed cards on disk. Run verify from Triage (one card) or List (all open).",
  verifyJobCounts:
    "Verdicts from this verify job only. Resolved/accepted here become Fixed on disk; earlier Fixed cards stay Fixed even if this job checked one finding.",
  verifyQueue:
    "Open / Fixed / False alarms on disk after applying this job — same numbers as Triage status counts.",
  countResolved:
    "This job: agent said the code change adequately addresses the finding → Fixed on disk.",
  countAccepted:
    "This job: agent accepted the author’s explanation → Fixed on disk.",
  countNeedsLook: "This job: partial or ambiguous — you should still look (stays open).",
  countStillOpen: "This job: not addressed or still incorrect (stays open).",
  unmatchedThreads: "GitHub review threads that did not match a local finding id.",
} as const;

export type HelpKey = keyof typeof Help;

export function tipKey(key: HelpKey): string {
  return tip(Help[key]);
}

/** Styled floating tip + action-safe cursors. Include CSS once; script once. */
export function uiHelpCss(): string {
  return `
    /* Actions stay pointer; only non-click “explain” chips use help cursor */
    button[data-help],
    a[data-help],
    summary[data-help],
    .nav-item[data-help],
    .has-ico[data-help],
    label.toggle[data-help],
    select[data-help] {
      cursor: pointer;
    }
    .has-tip[data-help]:not(button):not(a):not(summary):not(label):not(select) {
      cursor: help;
    }
    #prsm-help-tip {
      position: fixed;
      z-index: 10050;
      box-sizing: border-box;
      max-width: min(320px, calc(100vw - 24px));
      padding: 0.5rem 0.7rem;
      border-radius: 6px;
      border: 1px solid #3e4850;
      background: #0d0e0f;
      color: #e2e2e2;
      font: 500 12px/1.4 "Hanken Grotesk", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      text-align: left;
      white-space: normal;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.1s ease;
    }
    #prsm-help-tip.is-on {
      opacity: 1;
      visibility: visible;
    }
  `;
}

/**
 * Viewport-clamped floating tooltip — avoids overflow:hidden clipping from cards/chrome.
 * Keep native title as fallback for long-press / accessibility.
 */
export function uiHelpScript(): string {
  return `(function(){
  if (window.__prsmHelpTip) return;
  window.__prsmHelpTip = true;
  var tip = document.createElement("div");
  tip.id = "prsm-help-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  var active = null;
  var hideTimer = 0;

  function hide() {
    active = null;
    tip.classList.remove("is-on");
    tip.hidden = true;
    tip.textContent = "";
  }

  function place(el) {
    var text = el.getAttribute("data-help");
    if (!text) return;
    tip.hidden = false;
    tip.textContent = text;
    tip.classList.add("is-on");
    var pad = 12;
    var gap = 8;
    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
    var top = r.top - th - gap;
    if (top < pad) top = r.bottom + gap;
    if (top + th > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - th - pad);
    }
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function showFor(el) {
    if (!el || !el.getAttribute) return;
    var host = el.closest ? el.closest("[data-help]") : null;
    if (!host) return;
    if (active === host) {
      place(host);
      return;
    }
    active = host;
    place(host);
  }

  document.addEventListener("mouseover", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var host = t.closest("[data-help]");
    if (!host) return;
    window.clearTimeout(hideTimer);
    showFor(host);
  });
  document.addEventListener("mouseout", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var host = t.closest("[data-help]");
    if (!host || host !== active) return;
    var to = e.relatedTarget;
    if (to instanceof Node && host.contains(to)) return;
    hideTimer = window.setTimeout(hide, 80);
  });
  document.addEventListener("focusin", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    showFor(t.closest("[data-help]"));
  });
  document.addEventListener("focusout", function () {
    hideTimer = window.setTimeout(hide, 80);
  });
  window.addEventListener("scroll", function () {
    if (active) place(active);
  }, true);
  window.addEventListener("resize", function () {
    if (active) place(active);
  });
})();`;
}
