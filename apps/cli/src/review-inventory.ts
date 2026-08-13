import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewRunSchema, VerifyReportSchema } from "@review-os/schemas";

export type ReviewHubStatus =
  | "running"
  | "needs_triage"
  | "awaiting_author"
  | "ready_to_verify"
  | "verified"
  | "cleared"
  | "incomplete";

export type ReviewHubMeta = {
  /** Manual workflow mark from the home list. */
  status?: "awaiting_author" | "ready_to_verify" | "needs_triage";
  note?: string;
  updatedAt?: string;
};

export type ReviewSummary = {
  prNumber: number;
  title: string;
  prUrl?: string;
  status: ReviewHubStatus;
  statusLabel: string;
  note?: string;
  openFindings: number;
  falseAlarms: number;
  blockers: number;
  majors: number;
  readiness?: string;
  verify?: {
    resolved: number;
    accepted: number;
    needs_look: number;
    still_open: number;
    createdAt: string;
  };
  updatedAt: string;
  href: string;
  listHref: string;
  verifyHref: string;
  hasTriage: boolean;
  hasVerifyReport: boolean;
};

const META_FILE = "hub.json";

function statusLabel(status: ReviewHubStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "needs_triage":
      return "Needs triage";
    case "awaiting_author":
      return "Awaiting author";
    case "ready_to_verify":
      return "Ready to verify";
    case "verified":
      return "Verified";
    case "cleared":
      return "Cleared";
    case "incomplete":
      return "Incomplete";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

async function readHubMeta(dir: string): Promise<ReviewHubMeta> {
  try {
    const raw = await readFile(path.join(dir, META_FILE), "utf8");
    return JSON.parse(raw) as ReviewHubMeta;
  } catch {
    return {};
  }
}

export async function writeHubMeta(
  dir: string,
  meta: ReviewHubMeta,
): Promise<ReviewHubMeta> {
  const next: ReviewHubMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, META_FILE), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function deriveStatus(options: {
  openFindings: number;
  hasVerifyReport: boolean;
  meta: ReviewHubMeta;
  hasRun: boolean;
}): ReviewHubStatus {
  if (!options.hasRun) return "incomplete";
  if (options.meta.status === "awaiting_author") return "awaiting_author";
  if (options.meta.status === "ready_to_verify") return "ready_to_verify";
  if (options.meta.status === "needs_triage") return "needs_triage";
  if (options.openFindings === 0) return "cleared";
  if (options.hasVerifyReport) return "verified";
  return "needs_triage";
}

export async function listReviewSummaries(
  reviewsRoot: string,
  options?: { runningPrNumbers?: number[] },
): Promise<ReviewSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(reviewsRoot);
  } catch {
    return [];
  }

  const running = new Set(options?.runningPrNumbers ?? []);
  const summaries: ReviewSummary[] = [];

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const prNumber = Number(name);
    const dir = path.join(reviewsRoot, name);
    let dirStat;
    try {
      dirStat = await stat(dir);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = await readHubMeta(dir);
    let title = `PR #${prNumber}`;
    let prUrl: string | undefined;
    let openFindings = 0;
    let falseAlarms = 0;
    let blockers = 0;
    let majors = 0;
    let readiness: string | undefined;
    let updatedAt = dirStat.mtime.toISOString();
    let hasRun = false;
    let hasTriage = false;
    let hasVerifyReport = false;
    let verify: ReviewSummary["verify"];

    try {
      await stat(path.join(dir, "triage.html"));
      hasTriage = true;
    } catch {
      hasTriage = false;
    }

    try {
      const raw = await readFile(path.join(dir, "run.json"), "utf8");
      const run = ReviewRunSchema.parse(JSON.parse(raw));
      hasRun = true;
      title = run.title?.trim() || title;
      prUrl = run.prUrl;
      readiness = run.judge?.readiness;
      openFindings = run.findings.filter(
        (f) =>
          f.kind !== "praise" && (f.disposition ?? "open") !== "false_alarm",
      ).length;
      falseAlarms = run.findings.filter(
        (f) => (f.disposition ?? "open") === "false_alarm",
      ).length;
      blockers = run.findings.filter(
        (f) =>
          f.severity === "blocker" &&
          f.kind !== "praise" &&
          (f.disposition ?? "open") !== "false_alarm",
      ).length;
      majors = run.findings.filter(
        (f) =>
          f.severity === "major" &&
          f.kind !== "praise" &&
          (f.disposition ?? "open") !== "false_alarm",
      ).length;
      try {
        const runStat = await stat(path.join(dir, "run.json"));
        updatedAt = runStat.mtime.toISOString();
      } catch {
        /* keep dir mtime */
      }
    } catch {
      hasRun = false;
    }

    try {
      const verifyRaw = await readFile(
        path.join(dir, "verify-report.json"),
        "utf8",
      );
      const report = VerifyReportSchema.parse(JSON.parse(verifyRaw));
      hasVerifyReport = true;
      verify = {
        resolved: report.counts.resolved,
        accepted: report.counts.accepted,
        needs_look: report.counts.needs_look,
        still_open: report.counts.still_open,
        createdAt: report.createdAt,
      };
      if (report.createdAt > updatedAt) updatedAt = report.createdAt;
    } catch {
      hasVerifyReport = false;
    }

    const status = running.has(prNumber)
      ? "running"
      : deriveStatus({
          openFindings,
          hasVerifyReport,
          meta,
          hasRun,
        });

    const summary: ReviewSummary = {
      prNumber,
      title,
      status,
      statusLabel: statusLabel(status),
      openFindings,
      falseAlarms,
      blockers,
      majors,
      updatedAt,
      href: `/pr/${prNumber}/`,
      listHref: `/pr/${prNumber}/final-review.html`,
      verifyHref: `/pr/${prNumber}/verify-report.html`,
      hasTriage,
      hasVerifyReport,
    };
    if (prUrl) summary.prUrl = prUrl;
    if (meta.note) summary.note = meta.note;
    if (readiness) summary.readiness = readiness;
    if (verify) summary.verify = verify;
    summaries.push(summary);
  }

  summaries.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return b.prNumber - a.prNumber;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  return summaries;
}

export async function deleteReviewDir(
  reviewsRoot: string,
  prNumber: number,
): Promise<void> {
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error("Invalid PR number");
  }
  const dir = path.join(reviewsRoot, String(prNumber));
  await rm(dir, { recursive: true, force: true });
}

export async function setReviewHubStatus(
  reviewsRoot: string,
  prNumber: number,
  patch: {
    status?: ReviewHubMeta["status"] | null;
    note?: string;
  },
): Promise<ReviewHubMeta> {
  const dir = path.join(reviewsRoot, String(prNumber));
  const prev = await readHubMeta(dir);
  const next: ReviewHubMeta = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.note !== undefined) next.note = patch.note;
  else if (prev.note !== undefined) next.note = prev.note;

  if (patch.status === null) {
    // omit status → auto
  } else if (patch.status !== undefined) {
    next.status = patch.status;
  } else if (prev.status !== undefined) {
    next.status = prev.status;
  }

  await writeFile(path.join(dir, META_FILE), JSON.stringify(next, null, 2), "utf8");
  return next;
}
