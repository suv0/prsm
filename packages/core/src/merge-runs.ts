import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, ReviewRun } from "@review-os/schemas";
import { isFindingOpen } from "@review-os/schemas";
import { applyDocumentedIntent, intentEvidenceFromFinding } from "./documented-intent.js";
import { findingCodeStillInDiff } from "./diff-index.js";
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

function compatibleKinds(a: Finding, b: Finding): boolean {
  if (a.kind === b.kind) return true;
  // Agents often phrase the same defect as issue vs question.
  const kinds = new Set([a.kind, b.kind]);
  return kinds.has("issue") && kinds.has("question");
}

function sameNeighborhood(a: Finding, b: Finding): boolean {
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  if (!compatibleKinds(a, b)) return false;
  const aEnd = a.endLine ?? a.line;
  const bEnd = b.endLine ?? b.line;
  const overlap =
    Math.max(a.line, b.line) <= Math.min(aEnd, bEnd) ||
    Math.abs(a.line - b.line) <= 8;
  return overlap;
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
  const whyOverlap = jaccard(tokens(a.whyWeak), tokens(b.whyWeak));
  const codeOverlap = jaccard(tokens(a.currentCode), tokens(b.currentCode));

  // Same (or nearly same) code snippet on the same lines → one card.
  if (codeOverlap >= 0.85) return true;
  if (codeOverlap >= 0.7 && issueOverlap >= 0.12) return true;

  if (issueOverlap >= 0.28) return true;

  const categorySame =
    a.category.trim().toLowerCase() === b.category.trim().toLowerCase() ||
    a.category === "documented-debt" ||
    b.category === "documented-debt";
  if (categorySame && whyOverlap >= 0.24) return true;

  if (codeOverlap >= 0.45 && issueOverlap >= 0.16) return true;

  // Same file/lines + shared domain signals (otp+courier+log, etc.)
  if (signalOverlap(a, b) >= 2 && (issueOverlap >= 0.12 || codeOverlap >= 0.3)) {
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
 *
 * Uses union-find so merges are transitive (A≈C and B≈C ⇒ A+B+C one card),
 * which greedy cluster-first placement misses.
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

  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (findingsLikelySame(items[i]!.finding, items[j]!.finding)) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, Item[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const list = clusters.get(root) ?? [];
    list.push(items[i]!);
    clusters.set(root, list);
  }

  const merged: Finding[] = [];
  for (const cluster of clusters.values()) {
    const ranked = [...cluster].sort((a, b) => {
      const scoreDiff = score(b.finding) - score(a.finding);
      if (Math.abs(scoreDiff) > 1.5) return scoreDiff;
      if (a.finding.kind === "issue" && b.finding.kind !== "issue") return -1;
      if (b.finding.kind === "issue" && a.finding.kind !== "issue") return 1;
      return scoreDiff;
    });

    let winner = ranked[0]!.finding;
    const winnerAgent = ranked[0]!.agent;
    for (const other of ranked.slice(1)) {
      if (other.agent === winnerAgent && other.finding.id === winner.id) {
        continue;
      }
      winner = mergePair(winner, other.finding, other.agent);
    }
    // One view per agent: keep "new"/owner first, else richest note.
    const stanceRank: Record<string, number> = {
      new: 4,
      dissent: 3,
      extend: 2,
      agree: 1,
    };
    const byModel = new Map<string, (typeof winner.views)[number]>();
    for (const view of winner.views) {
      const prev = byModel.get(view.model);
      if (!prev) {
        byModel.set(view.model, view);
        continue;
      }
      const prevRank = stanceRank[prev.stance] ?? 0;
      const nextRank = stanceRank[view.stance] ?? 0;
      if (
        nextRank > prevRank ||
        (nextRank === prevRank && view.note.length > prev.note.length)
      ) {
        byModel.set(view.model, {
          ...view,
          note:
            prev.note && view.note && prev.note !== view.note
              ? `${view.note} · also: ${prev.note.slice(0, 120)}`
              : view.note || prev.note,
        });
      } else if (view.note && view.note !== prev.note) {
        byModel.set(view.model, {
          ...prev,
          note: `${prev.note} · also: ${view.note.slice(0, 120)}`,
        });
      }
    }
    winner = {
      ...winner,
      views: [...byModel.values()],
    };
    merged.push(winner);
  }

  return merged.sort((a, b) => score(b) - score(a));
}

/** Keep only the newest snapshot per agent (history under runs/ stays on disk). */
export function latestRunsPerAgent(runs: ReviewRunMeta[]): ReviewRunMeta[] {
  const byAgent = new Map<string, ReviewRunMeta>();
  for (const meta of runs) {
    const prev = byAgent.get(meta.agent);
    if (!prev || meta.createdAt.localeCompare(prev.createdAt) >= 0) {
      byAgent.set(meta.agent, meta);
    }
  }
  return [...byAgent.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

function preserveTriageFields(from: Finding, onto: Finding): Finding {
  const keepDisposition =
    from.disposition && from.disposition !== "open"
      ? from.disposition
      : onto.disposition;
  return {
    ...onto,
    disposition: keepDisposition ?? "open",
    ...(from.falseAlarmNote || onto.falseAlarmNote
      ? { falseAlarmNote: from.falseAlarmNote ?? onto.falseAlarmNote }
      : {}),
    rechecks:
      from.rechecks && from.rechecks.length > 0
        ? from.rechecks
        : (onto.rechecks ?? []),
    verifications:
      from.verifications && from.verifications.length > 0
        ? from.verifications
        : (onto.verifications ?? []),
    ...(from.verification || onto.verification
      ? { verification: from.verification ?? onto.verification }
      : {}),
  };
}

export type ReconcileWavesResult = {
  findings: Finding[];
  dropped: number;
  carried: number;
  matched: number;
};

/**
 * After merging the latest agent wave, drop previous open findings that look
 * fixed (code gone from diff), carry ones still present that the new wave
 * missed, and preserve triage/verify state on matches (including false alarms).
 */
export function reconcileAcrossReviewWaves(options: {
  previousFindings: Finding[];
  nextFindings: Finding[];
  diffText?: string;
}): ReconcileWavesResult {
  const { previousFindings, nextFindings } = options;
  const diffText = options.diffText ?? "";
  const usedNext = new Set<number>();
  const out: Finding[] = [];
  let matched = 0;
  let dropped = 0;
  let carried = 0;

  // Match all previous cards first so FA/fixed dispositions stick across waves.
  for (const prev of previousFindings) {
    let matchIndex = -1;
    for (let i = 0; i < nextFindings.length; i++) {
      if (usedNext.has(i)) continue;
      if (findingsLikelySame(prev, nextFindings[i]!)) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex >= 0) {
      usedNext.add(matchIndex);
      out.push(preserveTriageFields(prev, nextFindings[matchIndex]!));
      matched += 1;
    }
  }

  for (const prev of previousFindings) {
    if (!isFindingOpen(prev)) continue;
    const alreadyKept = out.some((f) => findingsLikelySame(prev, f));
    if (alreadyKept) continue;

    if (findingCodeStillInDiff(prev, diffText)) {
      out.push(prev);
      carried += 1;
    } else {
      dropped += 1;
    }
  }

  // Keep closed cards (false alarm / verify-fixed) even if this wave missed them.
  for (const prev of previousFindings) {
    if (isFindingOpen(prev)) continue;
    const alreadyKept = out.some((f) => findingsLikelySame(prev, f));
    if (!alreadyKept) out.push(prev);
  }

  for (let i = 0; i < nextFindings.length; i++) {
    if (usedNext.has(i)) continue;
    out.push(nextFindings[i]!);
  }

  return {
    findings: out.sort((a, b) => score(b) - score(a)),
    dropped,
    carried,
    matched,
  };
}

async function loadPreviousMergedFindings(
  outputDir: string,
): Promise<Finding[]> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(outputDir, "run.json"), "utf8"),
    ) as { findings?: Finding[] };
    return Array.isArray(raw.findings) ? raw.findings : [];
  } catch {
    return [];
  }
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
  log?: (line: string) => void;
}): Promise<{
  findingCount: number;
  runCount: number;
  runs: ReviewRunMeta[];
  run: ReviewRun;
  reconcile?: { dropped: number; carried: number; matched: number };
}> {
  const allRuns = await listReviewRuns(options.outputDir);
  const runs = latestRunsPerAgent(allRuns);
  const previousFindings = await loadPreviousMergedFindings(options.outputDir);

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

  const reconciled = reconcileAcrossReviewWaves({
    previousFindings,
    nextFindings: intent.findings,
    ...(options.diffText !== undefined ? { diffText: options.diffText } : {}),
  });
  const findings = reconciled.findings;
  const judge = buildJudgeResult(findings);
  const agents = allRuns.map((meta) => ({
    id: meta.id,
    agent: meta.agent,
    createdAt: meta.createdAt,
    findingCount: meta.findingCount,
  }));

  if (
    options.log &&
    (reconciled.dropped > 0 ||
      reconciled.carried > 0 ||
      allRuns.length !== runs.length)
  ) {
    options.log(
      `reconcile: latest ${runs.length}/${allRuns.length} agent snapshot(s); matched ${reconciled.matched}, dropped ${reconciled.dropped} fixed, carried ${reconciled.carried} still-open`,
    );
  }

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
            `Merged view across latest ${runs.length} agent run(s) (${allRuns.length} on disk). Individual runs live under runs/.`,
            intent.demoted.length > 0
              ? `Documented-intent demoted ${intent.demoted.length} finding(s).`
              : "",
            reconciled.dropped > 0 || reconciled.carried > 0
              ? `Reconcile dropped ${reconciled.dropped} fixed, carried ${reconciled.carried}.`
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
          note: `Merged view across latest ${runs.length} agent run(s) (${allRuns.length} on disk).`,
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
  // Index keeps full history; merge used latest-per-agent only.
  await writeAgentsIndex(options.outputDir, options.prNumber, allRuns);

  return {
    findingCount: findings.length,
    runCount: allRuns.length,
    runs: allRuns,
    run: mergedRun,
    reconcile: {
      dropped: reconciled.dropped,
      carried: reconciled.carried,
      matched: reconciled.matched,
    },
  };
}
