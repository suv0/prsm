import type { Finding, ReviewRun } from "@review-os/schemas";
import { FindingSchema } from "@review-os/schemas";
import { buildJudgeResult } from "./finalize.js";

export type ReverifyAction = "stand" | "update" | "false_alarm";

export type ReverifyApplyResult = {
  action: ReverifyAction;
  note: string;
  finding: Finding | null;
  run: ReviewRun;
};

const MAX_DIFF_CHARS = 40_000;

const FALSE_ALARM_HINT =
  /\b(drop|remove|skip|false\s*positive|false\s*alarm|not\s+an\s+issue|no\s+issue|dismiss|not\s+real)\b/i;

/** True when reviewer notes clearly say this is not a real issue. */
export function notesAllowDrop(userPrompt: string): boolean {
  return FALSE_ALARM_HINT.test(userPrompt.trim());
}

export function notesMarkFalseAlarm(userPrompt: string): boolean {
  return notesAllowDrop(userPrompt);
}

/**
 * Merged reviews sometimes reuse the same finding id across agents.
 * Give later copies a stable unique suffix so updates can't wipe siblings.
 */
export function ensureUniqueFindingIds(findings: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const count = seen.get(finding.id) ?? 0;
    seen.set(finding.id, count + 1);
    if (count === 0) return finding;
    return {
      ...finding,
      id: `${finding.id}__dup${count + 1}`,
    };
  });
}

export function markFindingFalseAlarm(
  finding: Finding,
  note: string,
): Finding {
  const cleaned = note.trim();
  const shortNote =
    cleaned.length > 0
      ? cleaned.slice(0, 280)
      : "Not a real issue after re-check.";
  return FindingSchema.parse({
    ...finding,
    disposition: "false_alarm",
    category: "false-alarm",
    falseAlarmNote: shortNote,
    reviewComment: `False alarm — ${shortNote}`,
  });
}

export function reopenFinding(finding: Finding): Finding {
  const { falseAlarmNote: _removed, ...rest } = finding;
  return FindingSchema.parse({
    ...rest,
    disposition: "open",
    category:
      finding.category === "false-alarm" ? "needs-review" : finding.category,
  });
}

/** Pull the unified-diff hunk(s) for one file path. */
export function extractDiffForFile(
  diffText: string | undefined,
  filePath: string,
): string {
  if (!diffText) return "(no diff available)";
  const wanted = filePath.replaceAll("\\", "/");
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);
  const kept: string[] = [];

  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0] ?? "";
    const pathMatch = header.match(/b\/(.+)$/);
    const file = pathMatch?.[1]?.trim().replaceAll("\\", "/");
    if (file === wanted) {
      kept.push(`diff --git ${chunk}`);
    }
  }

  if (kept.length === 0) {
    return `(no diff hunk found for ${wanted})\n\n${diffText.slice(0, 8_000)}`;
  }

  const joined = kept.join("\n");
  if (joined.length <= MAX_DIFF_CHARS) return joined;
  return `${joined.slice(0, MAX_DIFF_CHARS)}\n\n…[truncated]`;
}

export function buildReverifyPrompt(options: {
  finding: Finding;
  userPrompt: string;
  prNumber: number;
  title?: string;
  fileDiff: string;
}): string {
  const { finding, userPrompt, prNumber, title, fileDiff } = options;
  const findingJson = JSON.stringify(finding, null, 2);
  const markFa = notesMarkFalseAlarm(userPrompt);

  return [
    "# Single-finding re-verify",
    "",
    "You are re-checking ONE existing review finding. Do not invent new findings.",
    "Use the reviewer notes + the finding details + the file diff.",
    "",
    `## PR #${prNumber}${title ? ` — ${title}` : ""}`,
    "",
    "## Reviewer notes (authoritative for this pass)",
    userPrompt.trim() || "(none — verify from evidence alone)",
    "",
    "## Existing finding (JSON)",
    "```json",
    findingJson,
    "```",
    "",
    "## Key fields (human-readable)",
    `- file: ${finding.file}`,
    `- line: ${finding.line}${finding.endLine ? `–${finding.endLine}` : ""}`,
    `- severity: ${finding.severity}`,
    `- category: ${finding.category}`,
    `- disposition: ${finding.disposition ?? "open"}`,
    `- issueSimple: ${finding.issueSimple}`,
    `- whyWeak: ${finding.whyWeak}`,
    `- howToFix: ${finding.howToFix}`,
    `- reviewComment: ${finding.reviewComment}`,
    "",
    "## Current code",
    "```",
    finding.currentCode,
    "```",
    "",
    "## Suggested better code",
    "```",
    finding.betterCode,
    "```",
    "",
    "## File diff (head / + side)",
    fileDiff,
    "",
    "## Output contract",
    "Return ONLY a JSON array with exactly one finding object. Never delete by returning [].",
    "",
    markFa
      ? '- Reviewer believes this may be a false alarm. If you agree, set disposition to "false_alarm", category "false-alarm", and a short reviewComment starting with "False alarm — …". Keep the original file/line/code for the record.'
      : '- Keep disposition "open" unless evidence clearly shows it is not an issue; only then set disposition "false_alarm".',
    "- If it STANDS or should be UPDATED but still an issue: disposition \"open\", update fields as needed.",
    "",
    "Rules for the finding object:",
    `- Keep id exactly: "${finding.id}"`,
    '- disposition: "open" | "false_alarm"',
    "- Keep file/line accurate (head-side lines from the diff).",
    "- Soften severity when reviewer notes or documented intent say so.",
    "- reviewComment must be SUPER SHORT: 1–3 plain polite sentences (paste-ready).",
    "- issueSimple must stay dummy-friendly and short.",
    "- Fill currentCode, whyWeak, howToFix, betterCode, evidence as usual.",
    "- Prefer category documented-debt + severity suggestion when intentional/mocked.",
    "",
    "No prose outside the JSON array.",
  ].join("\n");
}

export function applyReverifyToRun(
  run: ReviewRun,
  findingId: string,
  returned: Finding[],
  userPrompt = "",
): ReverifyApplyResult {
  const findings = ensureUniqueFindingIds(run.findings);
  const index = findings.findIndex((f) => f.id === findingId);
  if (index === -1) {
    throw new Error(`Finding not found: ${findingId}`);
  }
  const existing = findings[index]!;
  const wantsFalseAlarm = notesMarkFalseAlarm(userPrompt);

  if (returned.length === 0) {
    if (!wantsFalseAlarm) {
      const next: ReviewRun = {
        ...run,
        findings,
        judge: buildJudgeResult(findings),
      };
      return {
        action: "stand",
        note: "Provider returned empty — left unchanged. Say false alarm / not an issue in notes to mark it.",
        finding: existing,
        run: next,
      };
    }

    const marked = markFindingFalseAlarm(existing, userPrompt);
    const nextFindings = findings.map((f, i) => (i === index ? marked : f));
    const next: ReviewRun = {
      ...run,
      findings: nextFindings,
      judge: buildJudgeResult(nextFindings),
    };
    return {
      action: "false_alarm",
      note: "Marked false alarm — kept in review (not deleted).",
      finding: marked,
      run: next,
    };
  }

  const incoming = returned[0]!;
  const disposition =
    incoming.disposition === "false_alarm" || wantsFalseAlarm
      ? "false_alarm"
      : (incoming.disposition ?? existing.disposition ?? "open");

  let merged = FindingSchema.parse({
    ...existing,
    ...incoming,
    id: existing.id,
    disposition,
    views:
      Array.isArray(incoming.views) && incoming.views.length > 0
        ? incoming.views
        : existing.views,
  });

  if (disposition === "false_alarm") {
    merged = markFindingFalseAlarm(
      merged,
      userPrompt || incoming.falseAlarmNote || incoming.reviewComment || "",
    );
  }

  const unchanged =
    merged.severity === existing.severity &&
    merged.issueSimple === existing.issueSimple &&
    merged.reviewComment === existing.reviewComment &&
    merged.howToFix === existing.howToFix &&
    merged.whyWeak === existing.whyWeak &&
    merged.category === existing.category &&
    (merged.disposition ?? "open") === (existing.disposition ?? "open");

  const nextFindings = findings.map((f, i) => (i === index ? merged : f));
  const next: ReviewRun = {
    ...run,
    findings: nextFindings,
    judge: buildJudgeResult(nextFindings),
  };

  if (merged.disposition === "false_alarm") {
    return {
      action: "false_alarm",
      note: "Marked false alarm — kept in review (not deleted).",
      finding: merged,
      run: next,
    };
  }

  return {
    action: unchanged ? "stand" : "update",
    note: unchanged
      ? "Stood — no material change."
      : "Updated from re-verify.",
    finding: merged,
    run: next,
  };
}

export function applyDispositionToRun(
  run: ReviewRun,
  findingId: string,
  disposition: "open" | "false_alarm",
  note = "",
): ReverifyApplyResult {
  const findings = ensureUniqueFindingIds(run.findings);
  const index = findings.findIndex((f) => f.id === findingId);
  if (index === -1) {
    throw new Error(`Finding not found: ${findingId}`);
  }
  const existing = findings[index]!;
  const nextFinding =
    disposition === "false_alarm"
      ? markFindingFalseAlarm(existing, note)
      : reopenFinding(existing);
  const nextFindings = findings.map((f, i) => (i === index ? nextFinding : f));
  const next: ReviewRun = {
    ...run,
    findings: nextFindings,
    judge: buildJudgeResult(nextFindings),
  };
  return {
    action: disposition === "false_alarm" ? "false_alarm" : "update",
    note:
      disposition === "false_alarm"
        ? "Marked false alarm — kept in review."
        : "Reopened — back in the open queue.",
    finding: nextFinding,
    run: next,
  };
}
