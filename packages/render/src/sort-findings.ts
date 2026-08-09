import type { Finding } from "@review-os/schemas";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 6,
  major: 5,
  minor: 4,
  suggestion: 3,
  nit: 2,
  question: 1,
};

/** Critical → lower; then importance, then confidence. False alarms sink to the end. */
export function sortFindingsForTriage(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const aFa = a.disposition === "false_alarm" ? 1 : 0;
    const bFa = b.disposition === "false_alarm" ? 1 : 0;
    if (aFa !== bFa) return aFa - bFa;
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.confidence - a.confidence;
  });
}
