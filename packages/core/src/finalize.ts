import type { Finding, JudgeResult } from "@review-os/schemas";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 6,
  major: 5,
  minor: 4,
  suggestion: 3,
  nit: 2,
  question: 1,
};

function normalizeKey(finding: Finding): string {
  return [
    finding.file.replaceAll("\\", "/").toLowerCase(),
    String(finding.line),
    finding.category.toLowerCase(),
    finding.issueSimple.toLowerCase().slice(0, 80),
  ].join("|");
}

function score(finding: Finding): number {
  return finding.confidence * 10 + finding.importance + SEVERITY_RANK[finding.severity];
}

/** Merge near-duplicate findings; keep the stronger one and attach a view note. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = normalizeKey(finding);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }

    const winner = score(finding) >= score(existing) ? finding : existing;
    const loser = winner === finding ? existing : finding;
    byKey.set(key, {
      ...winner,
      views: [
        ...winner.views,
        {
          model: "finalize",
          stance: "agree",
          note: `Merged duplicate from ${loser.id}: ${loser.issueSimple}`,
        },
      ],
    });
  }

  return [...byKey.values()].sort((a, b) => score(b) - score(a));
}

export function buildJudgeResult(findings: Finding[]): JudgeResult {
  const counts = {
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
    suggestion: 0,
    question: 0,
    praise: 0,
  };

  for (const finding of findings) {
    if (finding.disposition === "false_alarm") {
      continue;
    }
    if (finding.kind === "praise") {
      counts.praise += 1;
      continue;
    }
    if (finding.kind === "question" || finding.severity === "question") {
      counts.question += 1;
      continue;
    }
    counts[finding.severity] += 1;
  }

  const readiness =
    counts.blocker > 0
      ? "blocked"
      : counts.major > 0
        ? "needs_changes"
        : "approved_with_nits";

  const topReasons = findings
    .filter((f) => f.kind === "issue" && f.disposition !== "false_alarm")
    .slice(0, 5)
    .map((f) => `${f.severity}: ${f.issueSimple}`);

  const scoreValue =
    readiness === "blocked" ? 30 : readiness === "needs_changes" ? 58 : 86;

  return {
    readiness,
    topReasons:
      topReasons.length > 0
        ? topReasons
        : ["No blocking issues after evidence filtering."],
    counts,
    score: scoreValue,
  };
}

export function finalizeFindings(findings: Finding[]): {
  findings: Finding[];
  judge: JudgeResult;
} {
  const deduped = dedupeFindings(findings);
  return {
    findings: deduped,
    judge: buildJudgeResult(deduped),
  };
}
