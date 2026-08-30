import {
  ExternalMatchSchema,
  dispositionFromVerification,
  type ExternalMatch,
  type ExternalMatchAction,
  type Finding,
  type ReviewRun,
} from "@review-os/schemas";
import type { VerifyThread } from "./verify-fixes.js";

function normPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Findings within this many lines of a thread can match at all. */
const MAX_LINE_DISTANCE = 5;
/** Below this text overlap, proximity alone never counts as a match. */
const MIN_TEXT_JACCARD = 0.12;
/** Combined score floor — deliberately conservative: false negatives (a
 *  missed real duplicate) are far cheaper than false positives (badging a
 *  genuinely distinct issue as "already covered" and getting it skipped). */
export const EXTERNAL_MATCH_MIN_SCORE = 0.5;

/**
 * Score how likely `thread` (a pre-existing GitHub review comment thread —
 * PRism never posts its own, so every thread here is from someone else, human
 * or bot) already covers `finding`. Requires same file AND a nearby line AND
 * meaningful text overlap; proximity or text overlap alone are not enough.
 */
export function scoreExternalMatch(
  finding: Finding,
  thread: VerifyThread,
): number {
  if (!thread.file || normPath(thread.file) !== normPath(finding.file)) {
    return 0;
  }
  if (thread.line === undefined) return 0;
  const dist = Math.abs(thread.line - finding.line);
  if (dist > MAX_LINE_DISTANCE) return 0;

  const findingText = tokenize(
    `${finding.issueSimple} ${finding.reviewComment} ${finding.whyWeak}`,
  );
  const threadText = tokenize(thread.excerpt);
  const textScore = jaccard(findingText, threadText);
  if (textScore < MIN_TEXT_JACCARD) return 0;

  const lineScore = dist === 0 ? 0.4 : 0.25;
  return lineScore + textScore * 0.6;
}

export type ExternalMatchCandidate = {
  finding: Finding;
  thread: VerifyThread;
  score: number;
};

/**
 * Pick open findings that overlap an existing third-party GitHub thread and
 * haven't been checked yet (findings that already carry `externalMatch` are
 * skipped — re-running an agent shouldn't re-spend a check on them).
 */
export function matchFindingsToExternalThreads(
  findings: Finding[],
  threads: VerifyThread[],
  options?: { minScore?: number },
): ExternalMatchCandidate[] {
  const minScore = options?.minScore ?? EXTERNAL_MATCH_MIN_SCORE;
  const eligible = findings.filter(
    (f) =>
      f.kind !== "praise" &&
      (f.disposition ?? "open") === "open" &&
      !f.externalMatch,
  );

  const candidates: ExternalMatchCandidate[] = [];
  for (const finding of eligible) {
    let best: VerifyThread | undefined;
    let bestScore = 0;
    for (const thread of threads) {
      const score = scoreExternalMatch(finding, thread);
      if (score > bestScore) {
        bestScore = score;
        best = thread;
      }
    }
    if (best && bestScore >= minScore) {
      candidates.push({ finding, thread: best, score: bestScore });
    }
  }
  return candidates;
}

const CANDIDATE_DIFF = 800;

export function buildExternalMatchPrompt(options: {
  candidates: ExternalMatchCandidate[];
  prNumber: number;
  title?: string;
}): string {
  const { candidates, prNumber, title } = options;
  const blocks = candidates.map(({ finding, thread }, index) => {
    const threadBody = thread.messages
      .map((m) => `@${m.author}: ${m.body}`)
      .join("\n")
      .slice(0, 1_500);
    return [
      `### Candidate ${index + 1}`,
      `- findingId: ${finding.id}`,
      `- file: ${finding.file}:${finding.line}`,
      `- our issueSimple: ${finding.issueSimple}`,
      `- our whyWeak: ${finding.whyWeak}`,
      `- our howToFix: ${finding.howToFix}`,
      `- our reviewComment: ${finding.reviewComment}`,
      "our currentCode:",
      "```",
      finding.currentCode.slice(0, CANDIDATE_DIFF),
      "```",
      "",
      `Existing GitHub thread near this line (from ${thread.messages[0]?.author ?? "someone else"}, not us):`,
      threadBody || "(no text)",
    ].join("\n");
  });

  return [
    "# Check for duplicate review coverage",
    "",
    "For EACH candidate below, someone else (a human reviewer or another bot) already left a",
    "GitHub review comment near the same file/line as one of our findings. Decide whether",
    "that existing comment already covers our finding, or whether we still have something",
    "genuinely new to add.",
    "",
    `## PR #${prNumber}${title ? ` — ${title}` : ""}`,
    "",
    ...blocks,
    "",
    "## Rules",
    '- action="skip": the existing comment already raises the same point adequately.',
    "  Do not restate it in any form.",
    '- action="follow_up": the existing comment misses something real — a concrete edge',
    "  case, a different root cause, a sharper fix, or a genuine follow-up question.",
    "  followUpComment must ADD to what was already said, not repeat it: a short,",
    "  concrete, teammate-style note that explicitly builds on the existing comment",
    "  (e.g. \"Agree with @author's point — worth also checking X\").",
    "- When unsure whether it's truly new, prefer \"skip\" — we'd rather say nothing than",
    "  pile on a comment that just restates the same concern.",
    "",
    "## Output",
    "Return ONLY a JSON array, one object per candidate, in order:",
    "[",
    "  {",
    '    "findingId": "<exact id>",',
    '    "action": "skip" | "follow_up",',
    '    "followUpComment": "required only when action is follow_up"',
    "  }",
    "]",
  ].join("\n");
}

function softenJson(text: string): string {
  return text.trim().replace(/,(\s*[\]}])/g, "$1");
}

export type ParsedExternalMatch = {
  findingId?: string;
  action: ExternalMatchAction;
  followUpComment?: string;
};

function parseOneExternalMatch(
  raw: Record<string, unknown>,
): ParsedExternalMatch {
  const action = raw.action === "follow_up" ? "follow_up" : "skip";
  const followUpComment =
    typeof raw.followUpComment === "string" && raw.followUpComment.trim()
      ? raw.followUpComment.trim()
      : undefined;
  return {
    ...(typeof raw.findingId === "string" && raw.findingId.trim()
      ? { findingId: raw.findingId.trim() }
      : {}),
    action: action === "follow_up" && followUpComment ? "follow_up" : "skip",
    ...(action === "follow_up" && followUpComment ? { followUpComment } : {}),
  };
}

export function parseExternalMatchModelResponse(
  text: string,
): ParsedExternalMatch[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const arrStart = candidate.indexOf("[");
  const arrEnd = candidate.lastIndexOf("]");
  if (arrStart === -1 || arrEnd <= arrStart) {
    throw new Error("External-match response did not contain a JSON array");
  }
  const raw = JSON.parse(
    softenJson(candidate.slice(arrStart, arrEnd + 1)),
  ) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("External-match JSON was not an array");
  }
  return raw.map((item) => parseOneExternalMatch(item as Record<string, unknown>));
}

export function toExternalMatch(
  parsed: ParsedExternalMatch,
  options: { provider: string; thread: VerifyThread; score: number },
): ExternalMatch {
  const author = options.thread.messages[0]?.author ?? "unknown";
  return ExternalMatchSchema.parse({
    author,
    ...(options.thread.url ? { url: options.thread.url } : {}),
    threadExcerpt: options.thread.excerpt.slice(0, 500),
    score: options.score,
    action: parsed.action,
    ...(parsed.action === "follow_up" && parsed.followUpComment
      ? { followUpComment: parsed.followUpComment }
      : {}),
    checkedAt: new Date().toISOString(),
    provider: options.provider,
  });
}

/**
 * Merge checked candidates back into the run; findings not in `byId` are
 * untouched. A "skip" match (existing thread already covers it) also flips
 * disposition to "fixed" — same queue-exclusion as a verified fix, just from
 * a different source. A "follow_up" match leaves disposition alone (open):
 * there's still something worth saying.
 */
export function applyExternalMatchesToRun(
  run: ReviewRun,
  byId: Map<string, ExternalMatch>,
): ReviewRun {
  return {
    ...run,
    findings: run.findings.map((finding) => {
      const match = byId.get(finding.id);
      if (!match) return finding;
      const next = { ...finding, externalMatch: match };
      return { ...next, disposition: dispositionFromVerification(next) };
    }),
  };
}
