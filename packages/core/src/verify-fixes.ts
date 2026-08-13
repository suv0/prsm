import {
  FindingVerificationSchema,
  VerifyReportSchema,
  type Finding,
  type FindingVerification,
  type ReviewRun,
  type VerifyItem,
  type VerifyReport,
  type VerifyStatus,
} from "@review-os/schemas";
import { extractDiffForFile } from "./reverify.js";

export type VerifyThreadMessage = {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
  url?: string;
};

export type VerifyThread = {
  id: string;
  file?: string;
  line?: number;
  url?: string;
  messages: VerifyThreadMessage[];
  excerpt: string;
};

const MAX_DIFF = 24_000;

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

function normPath(p: string): string {
  return p.replaceAll("\\", "/");
}

export function scoreFindingThread(
  finding: Finding,
  thread: VerifyThread,
): number {
  let score = 0;
  if (thread.file && normPath(thread.file) === normPath(finding.file)) {
    score += 0.55;
    if (thread.line !== undefined) {
      const dist = Math.abs(thread.line - finding.line);
      if (dist === 0) score += 0.35;
      else if (dist <= 5) score += 0.25;
      else if (dist <= 20) score += 0.12;
    }
  }
  const findingText = tokenize(
    `${finding.issueSimple} ${finding.reviewComment} ${finding.whyWeak}`,
  );
  const threadText = tokenize(thread.excerpt);
  score += jaccard(findingText, threadText) * 0.45;
  return score;
}

export function matchFindingsToThreads(
  findings: Finding[],
  threads: VerifyThread[],
): {
  pairs: Array<{ finding: Finding; thread?: VerifyThread }>;
  unmatchedThreads: VerifyThread[];
} {
  const openFindings = findings.filter(
    (f) => f.kind !== "praise" && (f.disposition ?? "open") !== "false_alarm",
  );
  const used = new Set<string>();
  const pairs: Array<{ finding: Finding; thread?: VerifyThread }> = [];

  for (const finding of openFindings) {
    let best: VerifyThread | undefined;
    let bestScore = 0;
    for (const thread of threads) {
      if (used.has(thread.id)) continue;
      const s = scoreFindingThread(finding, thread);
      if (s > bestScore) {
        bestScore = s;
        best = thread;
      }
    }
    if (best && bestScore >= 0.35) {
      used.add(best.id);
      pairs.push({ finding, thread: best });
    } else {
      pairs.push({ finding });
    }
  }

  const unmatchedThreads = threads.filter((t) => !used.has(t.id));
  return { pairs, unmatchedThreads };
}

export function buildVerifyFixPrompt(options: {
  finding: Finding;
  thread?: VerifyThread;
  fileDiff: string;
  prNumber: number;
  title?: string;
}): string {
  const { finding, thread, fileDiff, prNumber, title } = options;
  return [
    "# Verify author updates (round-2 review)",
    "",
    "You previously raised a finding on this PR. The author may have replied and/or pushed new commits.",
    "Judge whether THIS finding is addressed. Do not invent unrelated new findings.",
    "",
    `## PR #${prNumber}${title ? ` — ${title}` : ""}`,
    "",
    "## Original finding",
    `- id: ${finding.id}`,
    `- file: ${finding.file}:${finding.line}`,
    `- severity: ${finding.severity}`,
    `- issueSimple: ${finding.issueSimple}`,
    `- whyWeak: ${finding.whyWeak}`,
    `- howToFix: ${finding.howToFix}`,
    `- reviewComment: ${finding.reviewComment}`,
    "",
    "### Current code (at review time)",
    "```",
    finding.currentCode,
    "```",
    "",
    "### Suggested better code",
    "```",
    finding.betterCode,
    "```",
    "",
    "## Author discussion (GitHub thread if matched)",
    thread
      ? thread.messages
          .map((m) => `@${m.author}:\n${m.body}`)
          .join("\n\n---\n\n")
          .slice(0, 4_000)
      : "(no matching GitHub review thread found — judge from the new diff only)",
    "",
    "## Current file diff (head)",
    fileDiff.slice(0, MAX_DIFF),
    "",
    "## Output",
    "Return ONLY a JSON object (no markdown fence if possible):",
    "{",
    '  "status": "resolved" | "needs_look" | "still_open" | "accepted",',
    '  "summary": "1–2 plain sentences for the reviewer",',
    '  "betterThanSuggested": true/false,',
    '  "followUpComment": "optional short paste-ready GitHub reply if still open / needs look",',
    '  "authorReplyNote": "optional one line about their explanation"',
    "}",
    "",
    "Status meanings:",
    '- resolved: code change adequately addresses the finding (or clearly better).',
    '- accepted: no/partial code change but author explanation is solid — OK to close.',
    '- needs_look: partial fix, ambiguous, or different approach that still has risk.',
    '- still_open: not addressed or still incorrect.',
    "Be fair. Prefer short plain English.",
  ].join("\n");
}

const BATCH_ITEM_DIFF = 6_000;

export function buildBatchVerifyFixPrompt(options: {
  pairs: Array<{ finding: Finding; thread?: VerifyThread }>;
  diffText: string;
  prNumber: number;
  title?: string;
}): string {
  const { pairs, diffText, prNumber, title } = options;
  const blocks = pairs.map(({ finding, thread }, index) => {
    const fileDiff = extractDiffForFile(diffText, finding.file).slice(
      0,
      BATCH_ITEM_DIFF,
    );
    return [
      `### Finding ${index + 1}`,
      `- findingId: ${finding.id}`,
      `- file: ${finding.file}:${finding.line}`,
      `- severity: ${finding.severity}`,
      `- issueSimple: ${finding.issueSimple}`,
      `- whyWeak: ${finding.whyWeak}`,
      `- howToFix: ${finding.howToFix}`,
      `- reviewComment: ${finding.reviewComment}`,
      "",
      "currentCode:",
      "```",
      finding.currentCode.slice(0, 1_200),
      "```",
      "betterCode:",
      "```",
      finding.betterCode.slice(0, 1_200),
      "```",
      "Author thread:",
      thread
        ? thread.messages
            .map((m) => `@${m.author}: ${m.body}`)
            .join("\n")
            .slice(0, 1_500)
        : "(none matched)",
      "File diff:",
      fileDiff || "(no file hunk in current diff)",
    ].join("\n");
  });

  return [
    "# Verify author updates (batch)",
    "",
    "Judge whether EACH prior finding is addressed after author replies / new commits.",
    "Do not invent unrelated new findings. Return one result object per findingId.",
    "",
    `## PR #${prNumber}${title ? ` — ${title}` : ""}`,
    "",
    ...blocks,
    "",
    "## Output",
    "Return ONLY a JSON array:",
    "[",
    "  {",
    '    "findingId": "<exact id>",',
    '    "status": "resolved" | "needs_look" | "still_open" | "accepted",',
    '    "summary": "1–2 plain sentences",',
    '    "betterThanSuggested": true/false,',
    '    "followUpComment": "optional",',
    '    "authorReplyNote": "optional"',
    "  }",
    "]",
    "",
    "Include every findingId listed above. Be fair. Prefer short plain English.",
  ].join("\n");
}

function softenJson(text: string): string {
  return text.trim().replace(/,(\s*[\]}])/g, "$1");
}

type ParsedVerify = {
  status: VerifyStatus;
  summary: string;
  betterThanSuggested: boolean;
  followUpComment?: string;
  authorReplyNote?: string;
  findingId?: string;
};

function parseOneVerifyObject(raw: Record<string, unknown>): ParsedVerify {
  const status = String(raw.status ?? "needs_look") as VerifyStatus;
  const allowed: VerifyStatus[] = [
    "resolved",
    "needs_look",
    "still_open",
    "accepted",
  ];
  return {
    status: allowed.includes(status) ? status : "needs_look",
    summary:
      typeof raw.summary === "string" && raw.summary.trim()
        ? raw.summary.trim()
        : "Verification completed.",
    betterThanSuggested: Boolean(raw.betterThanSuggested),
    ...(typeof raw.followUpComment === "string" && raw.followUpComment.trim()
      ? { followUpComment: raw.followUpComment.trim() }
      : {}),
    ...(typeof raw.authorReplyNote === "string" && raw.authorReplyNote.trim()
      ? { authorReplyNote: raw.authorReplyNote.trim() }
      : {}),
    ...(typeof raw.findingId === "string" && raw.findingId.trim()
      ? { findingId: raw.findingId.trim() }
      : {}),
  };
}

export function parseVerifyModelResponse(text: string): ParsedVerify {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Verify response did not contain a JSON object");
  }
  const raw = JSON.parse(softenJson(candidate.slice(start, end + 1))) as Record<
    string,
    unknown
  >;
  return parseOneVerifyObject(raw);
}

/** Parse a batch verify response (array preferred; single object accepted). */
export function parseBatchVerifyModelResponse(
  text: string,
): ParsedVerify[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const arrStart = candidate.indexOf("[");
  const arrEnd = candidate.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const raw = JSON.parse(
      softenJson(candidate.slice(arrStart, arrEnd + 1)),
    ) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("Verify batch JSON was not an array");
    }
    return raw.map((item) =>
      parseOneVerifyObject(item as Record<string, unknown>),
    );
  }
  // Fallback: single object
  return [parseVerifyModelResponse(text)];
}

export function toFindingVerification(
  parsed: ParsedVerify,
  options: {
    provider: string;
    threadMatched: boolean;
    authorReplyExcerpt?: string;
  },
): FindingVerification {
  return FindingVerificationSchema.parse({
    status: parsed.status,
    summary: parsed.summary,
    verifiedAt: new Date().toISOString(),
    provider: options.provider,
    betterThanSuggested: parsed.betterThanSuggested,
    ...(parsed.followUpComment
      ? { followUpComment: parsed.followUpComment }
      : {}),
    threadMatched: options.threadMatched,
    ...(options.authorReplyExcerpt
      ? { authorReplyExcerpt: options.authorReplyExcerpt }
      : {}),
  });
}

const STATUS_RANK: Record<VerifyStatus, number> = {
  still_open: 4,
  needs_look: 3,
  accepted: 2,
  resolved: 1,
};

/** Conservative rollup: worst status wins; summaries/comments from all agents kept. */
export function rollupVerifications(
  agents: FindingVerification[],
): FindingVerification | undefined {
  if (agents.length === 0) return undefined;
  const sorted = [...agents].sort(
    (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status],
  );
  const worst = sorted[0]!;
  const providers = [...new Set(agents.map((a) => a.provider))];
  const summaries = agents
    .map((a) => `[${a.provider}] ${a.status}: ${a.summary}`)
    .join(" · ");
  const followUps = agents
    .map((a) => a.followUpComment?.trim())
    .filter((v): v is string => Boolean(v));
  return FindingVerificationSchema.parse({
    status: worst.status,
    summary: summaries.slice(0, 900),
    verifiedAt: new Date().toISOString(),
    provider: providers.join("+"),
    betterThanSuggested: agents.some((a) => a.betterThanSuggested),
    ...(followUps.length
      ? { followUpComment: followUps.join("\n---\n").slice(0, 2_000) }
      : {}),
    threadMatched: agents.some((a) => a.threadMatched),
    ...(worst.authorReplyExcerpt
      ? { authorReplyExcerpt: worst.authorReplyExcerpt }
      : {}),
  });
}

/** Replace/merge one agent's result into the per-agent list. */
export function upsertAgentVerification(
  existing: FindingVerification[] | undefined,
  incoming: FindingVerification,
): FindingVerification[] {
  const list = [...(existing ?? [])].filter(
    (v) => v.provider !== incoming.provider,
  );
  list.push(incoming);
  return list.sort((a, b) => a.provider.localeCompare(b.provider));
}

export function buildVerifyReport(options: {
  run: ReviewRun;
  providers: string[];
  items: VerifyItem[];
  unmatchedThreads: VerifyThread[];
}): VerifyReport {
  const counts = {
    resolved: 0,
    needs_look: 0,
    still_open: 0,
    accepted: 0,
    skipped: 0,
  };
  for (const item of options.items) {
    counts[item.verification.status] += 1;
  }
  const providers = options.providers;
  return VerifyReportSchema.parse({
    prNumber: options.run.prNumber,
    ...(options.run.prUrl ? { prUrl: options.run.prUrl } : {}),
    ...(options.run.title ? { title: options.run.title } : {}),
    createdAt: new Date().toISOString(),
    provider: providers.join("+") || "unknown",
    providers,
    counts,
    items: options.items,
    unmatchedThreads: options.unmatchedThreads.map((t) => ({
      id: t.id,
      ...(t.file ? { file: t.file } : {}),
      ...(t.line !== undefined ? { line: t.line } : {}),
      excerpt: t.excerpt.slice(0, 400),
    })),
  });
}

/**
 * Merge this run's per-agent results into findings.
 * Re-running a different agent later replaces only that agent's entry.
 */
export function applyVerificationsToRun(
  run: ReviewRun,
  byId: Map<string, FindingVerification[]>,
): ReviewRun {
  return {
    ...run,
    findings: run.findings.map((finding) => {
      const incoming = byId.get(finding.id);
      if (!incoming?.length) return finding;
      let next = [...(finding.verifications ?? [])];
      for (const v of incoming) {
        next = upsertAgentVerification(next, v);
      }
      const rollup = rollupVerifications(next);
      return {
        ...finding,
        verifications: next,
        ...(rollup ? { verification: rollup } : {}),
      };
    }),
  };
}

export function fileDiffForFinding(
  finding: Finding,
  diffText: string | undefined,
): string {
  return extractDiffForFile(diffText, finding.file);
}

export function chunkPairs<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
