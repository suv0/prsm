import type { Finding, ReviewRun } from "@review-os/schemas";
import { applyDocumentedIntent, intentEvidenceFromFinding } from "./documented-intent.js";
import { buildJudgeResult } from "./finalize.js";
import {
  listReviewRuns,
  loadRunFindings,
  tagFindingsWithAgent,
  writeAgentsIndex,
  type ReviewRunMeta,
} from "./versioning.js";

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 6,
  major: 5,
  minor: 4,
  suggestion: 3,
  nit: 2,
  question: 1,
};

/** High-signal tokens that often mark "same bug, different wording". */
const SIGNAL_TOKENS = new Set([
  "otp",
  "courier",
  "logger",
  "logging",
  "logged",
  "payload",
  "mock",
  "mocked",
  "sms",
  "cookie",
  "cors",
  "kratos",
  "session",
  "reauth",
  "unifonic",
]);

function score(finding: Finding): number {
  return finding.confidence * 10 + finding.importance + SEVERITY_RANK[finding.severity];
}

function normalizePath(file: string): string {
  return file.replaceAll("\\", "/").toLowerCase();
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const word of a) {
    if (b.has(word)) inter += 1;
  }
  return inter / (a.size + b.size - inter);
}

function sameNeighborhood(a: Finding, b: Finding): boolean {
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  if (a.kind !== b.kind) return false;
  return Math.abs(a.line - b.line) <= 5;
}

function signalOverlap(a: Finding, b: Finding): number {
  const bag = (finding: Finding) =>
    tokens(
      `${finding.issueSimple} ${finding.whyWeak} ${finding.currentCode} ${finding.category}`,
    );
  const left = bag(a);
  const right = bag(b);
  let shared = 0;
  for (const word of SIGNAL_TOKENS) {
    if (left.has(word) && right.has(word)) shared += 1;
  }
  return shared;
}

function isDocumentedDebt(finding: Finding): boolean {
  return (
    finding.category === "documented-debt" ||
    intentEvidenceFromFinding(finding) !== null ||
    finding.views.some((view) => view.model === "documented-intent")
  );
}

/** True when two agents are talking about the same underlying issue. */
export function findingsLikelySame(a: Finding, b: Finding): boolean {
  if (!sameNeighborhood(a, b)) return false;

  const issueOverlap = jaccard(tokens(a.issueSimple), tokens(b.issueSimple));
  if (issueOverlap >= 0.34) return true;

  const categorySame =
    a.category.trim().toLowerCase() === b.category.trim().toLowerCase() ||
    a.category === "documented-debt" ||
    b.category === "documented-debt";
  const whyOverlap = jaccard(tokens(a.whyWeak), tokens(b.whyWeak));
  if (categorySame && whyOverlap >= 0.28) return true;

  const codeOverlap = jaccard(tokens(a.currentCode), tokens(b.currentCode));
  if (codeOverlap >= 0.45 && issueOverlap >= 0.18) return true;

  // Same file/lines + shared domain signals (otp+courier+log, etc.)
  if (signalOverlap(a, b) >= 2 && (issueOverlap >= 0.15 || codeOverlap >= 0.35)) {
    return true;
  }

  return false;
}

function stanceForLoser(
  winner: Finding,
  loser: Finding,
): "agree" | "extend" | "dissent" {
  if (SEVERITY_RANK[loser.severity] > SEVERITY_RANK[winner.severity] + 1) {
    return "dissent";
  }
  const fixOverlap = jaccard(tokens(winner.howToFix), tokens(loser.howToFix));
  if (fixOverlap < 0.25) return "extend";
  return "agree";
}

function mergePair(winner: Finding, loser: Finding, loserAgent: string): Finding {
  const stance = stanceForLoser(winner, loser);
  const note =
    stance === "extend"
      ? `${loser.issueSimple} · alt fix: ${loser.howToFix.slice(0, 160)}`
      : loser.issueSimple;

  const views = [
    ...winner.views,
    {
      model: loserAgent,
      stance,
      note,
    },
  ];

  const eitherDocumented = isDocumentedDebt(winner) || isDocumentedDebt(loser);

  // Prefer higher severity wording when loser is harsher — unless either side
  // already marked documented intent (don't re-escalate mock/local debt).
  const preferLoser =
    !eitherDocumented &&
    (SEVERITY_RANK[loser.severity] > SEVERITY_RANK[winner.severity] ||
      (score(loser) > score(winner) && stance !== "dissent"));

  // When one side is documented-debt, keep the softer card as the body.
  const preferDebtBody =
    eitherDocumented &&
    (isDocumentedDebt(loser) && !isDocumentedDebt(winner)
      ? true
      : isDocumentedDebt(winner) && !isDocumentedDebt(loser)
        ? false
        : score(loser) > score(winner));

  const source = preferLoser || preferDebtBody ? loser : winner;
  const other = source === loser ? winner : loser;

  const softerComment = [winner, loser].find(
    (finding) =>
      finding.category === "documented-debt" ||
      /appreciate the note|follow-up|fair for now|documented/i.test(
        finding.reviewComment,
      ),
  )?.reviewComment;

  let base: Finding = {
    ...winner,
    severity: source.severity,
    category: eitherDocumented ? "documented-debt" : source.category,
    importance: Math.max(winner.importance, loser.importance),
    confidence: Math.max(winner.confidence, loser.confidence),
    issueSimple: source.issueSimple,
    whyWeak: source.whyWeak,
    howToFix: source.howToFix,
    betterCode:
      source.betterCode.length >= other.betterCode.length
        ? source.betterCode
        : other.betterCode,
    reviewComment: softerComment ?? source.reviewComment,
  };

  if (eitherDocumented && SEVERITY_RANK[base.severity] > SEVERITY_RANK.suggestion) {
    base = {
      ...base,
      severity: "suggestion",
      category: "documented-debt",
      importance: Math.min(base.importance, 6),
      issueSimple: base.issueSimple.startsWith("Documented tradeoff:")
        ? base.issueSimple
        : `Documented tradeoff: ${base.issueSimple}`,
    };
  }

  return {
    ...base,
    id: winner.id,
    evidence: [...winner.evidence, ...loser.evidence].slice(0, 12),
    views,
  };
}

/**
 * Merge findings from multiple agents: one card per issue, with agent views
 * when wording/severity differs.
 */
export function mergeAgentFindings(
  batches: Array<{ agent: string; findings: Finding[] }>,
): Finding[] {
  type Item = { finding: Finding; agent: string };
  const items: Item[] = [];
  for (const batch of batches) {
    const tagged = tagFindingsWithAgent(batch.findings, batch.agent);
    for (const finding of tagged) {
      items.push({ finding, agent: batch.agent });
    }
  }

  const clusters: Item[][] = [];
  for (const item of items) {
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.some((member) => findingsLikelySame(member.finding, item.finding))) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }

  const merged: Finding[] = [];
  for (const cluster of clusters) {
    const ranked = [...cluster].sort(
      (a, b) => score(b.finding) - score(a.finding),
    );
    let winner = ranked[0]!.finding;
    const winnerAgent = ranked[0]!.agent;
    for (const other of ranked.slice(1)) {
      if (other.agent === winnerAgent && other.finding.id === winner.id) {
        continue;
      }
      winner = mergePair(winner, other.finding, other.agent);
    }
    // Deduplicate views by model+stance+note prefix
    const seen = new Set<string>();
    winner = {
      ...winner,
      views: winner.views.filter((view) => {
        const key = `${view.model}|${view.stance}|${view.note.slice(0, 80)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
    merged.push(winner);
  }

  return merged.sort((a, b) => score(b) - score(a));
}

export async function rebuildMergedReview(options: {
  outputDir: string;
  prNumber: number;
  render: (
    run: ReviewRun,
    outputDir: string,
    diffText?: string,
  ) => Promise<void>;
  baseRun?: ReviewRun | null;
  diffText?: string;
}): Promise<{
  findingCount: number;
  runCount: number;
  runs: ReviewRunMeta[];
  run: ReviewRun;
}> {
  const runs = await listReviewRuns(options.outputDir);
  const batches: Array<{ agent: string; findings: Finding[] }> = [];
  let template: ReviewRun | null = options.baseRun ?? null;

  for (const meta of runs) {
    const loaded = await loadRunFindings(options.outputDir, meta);
    if (!template && loaded.run) template = loaded.run;
    else if (template && !template.overview && loaded.run?.overview) {
      template = { ...template, overview: loaded.run.overview };
    }
    if (loaded.findings.length > 0) {
      batches.push({ agent: meta.agent, findings: loaded.findings });
    }
  }

  const mergedRaw = mergeAgentFindings(batches);
  const intent = applyDocumentedIntent(
    mergedRaw,
    options.diffText ?? "",
  );
  const findings = intent.findings;
  const judge = buildJudgeResult(findings);
  const agents = runs.map((meta) => ({
    id: meta.id,
    agent: meta.agent,
    createdAt: meta.createdAt,
    findingCount: meta.findingCount,
  }));

  const mergedRun: ReviewRun = {
    prNumber: options.prNumber,
    ...(template?.prUrl !== undefined ? { prUrl: template.prUrl } : {}),
    title: template?.title ?? `PR #${options.prNumber}`,
    ...(template?.base !== undefined ? { base: template.base } : {}),
    ...(template?.head !== undefined ? { head: template.head } : {}),
    createdAt: new Date().toISOString(),
    demo: false,
    load: template?.load
      ? {
          ...template.load,
          note: [
            `Merged view across ${runs.length} agent run(s). Individual runs live under runs/.`,
            intent.demoted.length > 0
              ? `Documented-intent demoted ${intent.demoted.length} finding(s).`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        }
      : {
          source: "pr",
          additions: 0,
          deletions: 0,
          files: [],
          diffTruncated: false,
          note: `Merged view across ${runs.length} agent run(s).`,
        },
    ...(template?.plan !== undefined ? { plan: template.plan } : {}),
    ...(template?.overview !== undefined ? { overview: template.overview } : {}),
    judge,
    knowledgeDocs: template?.knowledgeDocs ?? {},
    findings,
    passResults: [],
    agents,
  };

  if (options.diffText !== undefined) {
    await options.render(mergedRun, options.outputDir, options.diffText);
  } else {
    await options.render(mergedRun, options.outputDir);
  }
  await writeAgentsIndex(options.outputDir, options.prNumber, runs);

  return {
    findingCount: findings.length,
    runCount: runs.length,
    runs,
    run: mergedRun,
  };
}
