import type { Finding, ReviewRun } from "@review-os/schemas";

function lineLabel(finding: Finding): string {
  if (finding.endLine && finding.endLine !== finding.line) {
    return `${finding.line}–${finding.endLine}`;
  }
  return String(finding.line);
}

function fence(lang: string, body: string): string {
  const safeLang = lang.trim() || "text";
  return ["```" + safeLang, body, "```"].join("\n");
}

export type FindingFixBriefOptions = {
  /** Include reviewer draft notes / edited paste comment (triage). */
  pasteComment?: string;
  notes?: string;
};

/**
 * One finding, framed for a coding agent that should check and fix the code
 * (not a second review agent doing stand/update/false-alarm).
 */
export function buildFindingFixBrief(
  finding: Finding,
  prNumber: number,
  options: FindingFixBriefOptions = {},
): string {
  const lang = finding.language || "ts";
  const paste =
    options.pasteComment?.trim() || finding.reviewComment || "(none)";
  const notes = options.notes?.trim() || "";
  const lines = [
    "You are helping the PR author fix a review finding in their own branch.",
    "Read the current code at the cited file/lines, decide if the finding is real,",
    "and if so apply a minimal focused fix. Skip it (with a one-line why) if it is a false alarm or already fixed.",
    "",
    `PR #${prNumber}`,
    `Finding id: ${finding.id}`,
    `Kind: ${finding.kind}`,
    `Disposition: ${finding.disposition ?? "open"}`,
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
    `File: ${finding.file}`,
    `Line: ${lineLabel(finding)}`,
    `Confidence: ${Math.round(finding.confidence * 100)}% · Importance: ${finding.importance}/10`,
    "",
    "## Issue",
    finding.issueSimple,
    "",
    "## Why it matters",
    finding.whyWeak,
    "",
    "## How to fix",
    finding.howToFix,
    "",
    "## Current code",
    fence(lang, finding.currentCode),
    "",
    "## Suggested code",
    fence(lang, finding.betterCode),
    "",
    "## Reviewer comment (context only — do not paste to GitHub unless asked)",
    paste,
  ];
  if (notes) {
    lines.push("", "## Author notes", notes);
  }
  if (finding.falseAlarmNote) {
    lines.push("", "## Marked false alarm", finding.falseAlarmNote);
  }
  lines.push(
    "",
    "Do not rewrite unrelated code. Prefer the suggested approach when it matches the repo style.",
  );
  return lines.join("\n");
}

export type ReviewFixBriefOptions = {
  /** Defaults to open issue/question findings (skips praise + false alarms). */
  findings?: Finding[];
  includeFalseAlarms?: boolean;
  includePraise?: boolean;
};

function defaultExportFindings(
  run: ReviewRun,
  options: ReviewFixBriefOptions,
): Finding[] {
  if (options.findings) return options.findings;
  return run.findings.filter((finding) => {
    if (!options.includePraise && finding.kind === "praise") return false;
    if (!options.includeFalseAlarms && finding.disposition === "false_alarm") {
      return false;
    }
    if (finding.disposition === "fixed") return false;
    return true;
  });
}

/** Full markdown doc for copy/download — paste into a coding agent or attach as a file. */
export function buildReviewFixBriefMarkdown(
  run: ReviewRun,
  options: ReviewFixBriefOptions = {},
): string {
  const findings = defaultExportFindings(run, options);
  const header = [
    `# PR #${run.prNumber} — fix brief for coding agent`,
    "",
    run.title ? `**Title:** ${run.title}` : "",
    run.prUrl ? `**URL:** ${run.prUrl}` : "",
    run.base && run.head
      ? `**Branches:** \`${run.base}\` ← \`${run.head}\``
      : "",
    `**Findings in this brief:** ${findings.length}`,
    "",
    "Paste this whole document into your coding agent (Cursor / Claude Code / Command Code / etc.).",
    "For each finding: verify against the current tree, fix real issues with minimal diffs, and skip false alarms with a short note.",
    "",
    "---",
    "",
  ].filter((line, index, arr) => !(line === "" && arr[index - 1] === ""));

  if (findings.length === 0) {
    return [...header, "_No open findings to export._", ""].join("\n");
  }

  const body = findings.map((finding, index) => {
    const brief = buildFindingFixBrief(finding, run.prNumber);
    return [`## Finding ${index + 1}`, "", brief, "", "---", ""].join("\n");
  });

  return [...header, ...body].join("\n").trimEnd() + "\n";
}

export function reviewFixBriefFilename(prNumber: number): string {
  return `pr-${prNumber}-fix-brief.md`;
}
