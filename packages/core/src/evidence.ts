import type { Finding } from "@review-os/schemas";

export interface EvidenceFilterOptions {
  confidenceFloor?: number;
}

export interface EvidenceFilterResult {
  kept: Finding[];
  removed: Array<{ id: string; reason: string }>;
  demoted: Array<{ id: string; reason: string }>;
}

/**
 * Drop or demote findings that cannot be anchored in evidence.
 * High importance + weak proof becomes a question, not a blocker assertion.
 */
export function filterFindingsByEvidence(
  findings: Finding[],
  options: EvidenceFilterOptions = {},
): EvidenceFilterResult {
  const confidenceFloor = options.confidenceFloor ?? 0.8;
  const kept: Finding[] = [];
  const removed: Array<{ id: string; reason: string }> = [];
  const demoted: Array<{ id: string; reason: string }> = [];

  for (const finding of findings) {
    if (finding.kind === "praise") {
      kept.push(finding);
      continue;
    }

    const hasEvidence =
      finding.evidence.length > 0 &&
      finding.evidence.some((item) => item.quote.trim().length > 0);
    const hasCodeAnchor =
      finding.currentCode.trim().length > 0 && finding.file.trim().length > 0;

    if (!hasEvidence && !hasCodeAnchor) {
      removed.push({
        id: finding.id,
        reason: "No evidence quote and no currentCode anchor",
      });
      continue;
    }

    if (
      finding.kind === "issue" &&
      finding.importance >= 8 &&
      finding.confidence < confidenceFloor
    ) {
      demoted.push({
        id: finding.id,
        reason:
          "High importance but confidence below floor — demoted to question",
      });
      kept.push({
        ...finding,
        kind: "question",
        severity: "question",
      });
      continue;
    }

    if (
      finding.kind === "issue" &&
      finding.confidence < confidenceFloor &&
      finding.importance <= 2
    ) {
      removed.push({
        id: finding.id,
        reason: "Low confidence and low importance nit removed",
      });
      continue;
    }

    if (finding.kind === "issue" && !hasEvidence) {
      demoted.push({
        id: finding.id,
        reason: "Issue without evidence quote — demoted to question",
      });
      kept.push({
        ...finding,
        kind: "question",
        severity: "question",
      });
      continue;
    }

    kept.push(finding);
  }

  return { kept, removed, demoted };
}
