import type { Finding } from "@review-os/schemas";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 6,
  major: 5,
  minor: 4,
  suggestion: 3,
  nit: 2,
  question: 1,
};

/** Critical → lower; then importance, then confidence. Closed (FA/fixed) sink to the end. */
export function sortFindingsForTriage(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const aClosed =
      a.disposition === "false_alarm" || a.disposition === "fixed" ? 1 : 0;
    const bClosed =
      b.disposition === "false_alarm" || b.disposition === "fixed" ? 1 : 0;
    if (aClosed !== bClosed) return aClosed - bClosed;
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.confidence - a.confidence;
  });
}
