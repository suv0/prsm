import type { Finding } from "@review-os/schemas";
import { buildDiffIndex } from "./diff-index.js";

export interface DocumentedIntentResult {
  findings: Finding[];
  demoted: Array<{ id: string; reason: string; evidence: string }>;
}

/** Phrases authors use when a sharp edge is intentional / mock-only / deferred. */
export const INTENT_PATTERNS: RegExp[] = [
  /\bchosen here\b/i,
  /\bdeliberately\b/i,
  /\bintentionally\b/i,
  /\bby design\b/i,
  /\bfor now\b/i,
  /\btemporary\b/i,
  /\bworkaround\b/i,
  /\bknown (?:limitation|issue|debt|trade-?off)\b/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bHACK\b/,
  /\bXXX\b/,
  /\bbefore it can be selected\b/i,
  /\bneeds? .{0,40}(?:credentials|config|allow-?list|feature flag)/i,
  /\buntil\b.+\b(?:ready|available|settled|landed)\b/i,
  /\bnot yet\b/i,
  /\bwill (?:be|come) (?:later|with|when)\b/i,
  /\btracked (?:in|by)\b/i,
  /\brevisit\b/i,
  /\bfollow[- ]?up\b/i,
  // Mock / local-only safety notes (e.g. SMS courier OTP logging)
  /\bsafe only because\b/i,
  /\bacceptable (?:here|only)\b/i,
  /\bprecisely because\b/i,
  /\bbecause .{0,60}\bmocked\b/i,
  /\bwhile .{0,40}\bmocked\b/i,
  /\bdelivery is mocked\b/i,
  /\bno (?:real )?number is (?:ever )?reachable\b/i,
  /\bnot (?:wired|reachable|enabled) (?:in|for) (?:prod|production)\b/i,
  /\b(?:local|dev|development)(?:ly)? only\b/i,
  /\bnot for production\b/i,
  /\bmock(?:ed)? (?:only|path|adapter|provider)\b/i,
  /\bonly (?:safe|ok|fine|acceptable) (?:for|while|because|when)\b/i,
];

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function textMatchesIntent(text: string): boolean {
  return INTENT_PATTERNS.some((re) => re.test(text));
}

function nearbyCommentEvidence(
  diffText: string,
  filePath: string,
  line: number,
  radius = 8,
): string | null {
  const index = buildDiffIndex(diffText);
  const normalized = normalizePath(filePath);
  let file = index.get(normalized);
  if (!file) {
    for (const [key, value] of index.entries()) {
      if (key.endsWith(`/${normalized}`) || normalized.endsWith(`/${key}`)) {
        file = value;
        break;
      }
    }
  }
  if (!file) return null;

  const hits: string[] = [];
  for (let n = Math.max(1, line - radius); n <= line + radius; n += 1) {
    const text = file.lines.get(n);
    if (!text) continue;
    const trimmed = text.trim();
    const looksLikeComment =
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("--");
    if (!looksLikeComment && !textMatchesIntent(trimmed)) {
      continue;
    }
    if (textMatchesIntent(trimmed)) {
      hits.push(`L${n}: ${trimmed}`);
    }
  }

  if (hits.length === 0) return null;
  return hits.join(" | ");
}

/** Intent may also ride on the finding's own evidence quotes / code snippet. */
export function intentEvidenceFromFinding(finding: Finding): string | null {
  if (finding.category === "documented-debt") {
    return `category=documented-debt: ${finding.issueSimple}`;
  }
  for (const item of finding.evidence) {
    if (textMatchesIntent(item.quote)) {
      return item.quote;
    }
  }
  if (textMatchesIntent(finding.currentCode)) {
    return finding.currentCode.slice(0, 240);
  }
  if (textMatchesIntent(finding.whyWeak) && /author|comment|note|documented/i.test(finding.whyWeak)) {
    return finding.whyWeak.slice(0, 240);
  }
  return null;
}

function shouldRespectIntent(finding: Finding): boolean {
  if (finding.kind === "praise") return false;
  if (finding.category === "documented-debt" && finding.severity === "suggestion") {
    return false; // already soft
  }
  return (
    finding.severity === "blocker" ||
    finding.severity === "major" ||
    finding.severity === "minor"
  );
}

function demoteFinding(finding: Finding, evidence: string): Finding {
  const politeFollowUp =
    "I see the nearby comment explaining why this is the current choice — totally fair for the mock/local path. Could we track a short follow-up (redact OTP bodies / gate before a real provider) so we don’t forget the production path?";

  return {
    ...finding,
    kind: "issue",
    severity: "suggestion",
    category: "documented-debt",
    importance: Math.min(finding.importance, 6),
    issueSimple: finding.issueSimple.startsWith("Documented tradeoff:")
      ? finding.issueSimple
      : `Documented tradeoff: ${finding.issueSimple}`,
    whyWeak: `${finding.whyWeak}\n\nAuthor note nearby suggests this is intentional/deferred: ${evidence}`,
    howToFix: `Track a follow-up rather than blocking this PR if the documented reason still holds. ${finding.howToFix}`,
    reviewComment:
      finding.reviewComment.includes("follow-up") ||
      finding.reviewComment.includes("Appreciate the note")
        ? finding.reviewComment
        : `${finding.reviewComment}\n\n${politeFollowUp}`,
    views: [
      ...finding.views,
      {
        model: "documented-intent",
        stance: "extend",
        note: `Demoted ${finding.severity} → suggestion because of documented intent: ${evidence}`,
      },
    ],
  };
}

/**
 * If nearby comments/docs explain why the code is intentional / deferred,
 * demote hard bug severities into a polite "fix later" reminder.
 */
export function applyDocumentedIntent(
  findings: Finding[],
  diffText: string,
): DocumentedIntentResult {
  const out: Finding[] = [];
  const demoted: DocumentedIntentResult["demoted"] = [];

  for (const finding of findings) {
    if (!shouldRespectIntent(finding)) {
      out.push(finding);
      continue;
    }

    const fromDiff = diffText.trim()
      ? nearbyCommentEvidence(diffText, finding.file, finding.line)
      : null;
    const fromFinding = intentEvidenceFromFinding(finding);
    const evidence = fromDiff ?? fromFinding;
    if (!evidence) {
      out.push(finding);
      continue;
    }

    demoted.push({
      id: finding.id,
      reason:
        "Nearby comment/doc explains intentional tradeoff or deferred work",
      evidence,
    });
    out.push(demoteFinding(finding, evidence));
  }

  return { findings: out, demoted };
}
