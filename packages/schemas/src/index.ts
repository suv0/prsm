import { z } from "zod";

export const FindingKindSchema = z.enum(["issue", "question", "praise"]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

export const SeveritySchema = z.enum([
  "blocker",
  "major",
  "minor",
  "nit",
  "suggestion",
  "question",
]);
export type Severity = z.infer<typeof SeveritySchema>;

export const GithubCommentTargetSchema = z.object({
  target: z.enum(["line", "summary"]),
  reason: z.string().min(1),
});
export type GithubCommentTarget = z.infer<typeof GithubCommentTargetSchema>;

export const EvidenceSchema = z.object({
  quote: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingViewSchema = z.object({
  model: z.string().min(1),
  stance: z.enum(["new", "agree", "extend", "dissent"]),
  note: z.string().min(1),
});
export type FindingView = z.infer<typeof FindingViewSchema>;

export const FindingDispositionSchema = z.enum(["open", "false_alarm"]);
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>;

export const RecheckActionSchema = z.enum(["stand", "update", "false_alarm"]);
export type RecheckAction = z.infer<typeof RecheckActionSchema>;

/** One triage “Recheck this finding” interaction (newest first in the array). */
export const RecheckEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  provider: z.string().min(1),
  /** Exact notes the reviewer typed. */
  userAsked: z.string().min(1),
  /** One short line: how the model understood the ask. */
  understood: z.string().min(1),
  /** One short line: the verdict / finding takeaway. */
  conclusion: z.string().min(1),
  action: RecheckActionSchema,
  /**
   * Plain line-by-line teaching for the reviewer (not GitHub paste).
   * Numbered short steps: what the code does, what's wrong, why the fix/comment fit.
   */
  teachMe: z.string().optional(),
  /** Optional longer reasoning (not for GitHub paste). */
  details: z.string().optional(),
  /** Suggested paste-ready PR comment — never auto-applied. */
  suggestedComment: z.string().optional(),
});
export type RecheckEntry = z.infer<typeof RecheckEntrySchema>;

export const VerifyStatusSchema = z.enum([
  "resolved",
  "needs_look",
  "still_open",
  "accepted",
]);
export type VerifyStatus = z.infer<typeof VerifyStatusSchema>;

export const FindingVerificationSchema = z.object({
  status: VerifyStatusSchema,
  summary: z.string().min(1),
  verifiedAt: z.string().min(1),
  provider: z.string().min(1),
  betterThanSuggested: z.boolean().default(false),
  followUpComment: z.string().optional(),
  threadMatched: z.boolean().default(false),
  authorReplyExcerpt: z.string().optional(),
});
export type FindingVerification = z.infer<typeof FindingVerificationSchema>;

export const VerifyItemSchema = z.object({
  findingId: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  issueSimple: z.string().min(1),
  /** Rollup judgment (conservative across agents). */
  verification: FindingVerificationSchema,
  /** Per-agent judgments kept so disagreements stay visible. */
  byAgent: z.array(FindingVerificationSchema).default([]),
});
export type VerifyItem = z.infer<typeof VerifyItemSchema>;

export const VerifyReportSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().optional(),
  title: z.string().optional(),
  createdAt: z.string().min(1),
  /** Comma-joined for older UI; prefer `providers`. */
  provider: z.string().min(1),
  providers: z.array(z.string().min(1)).default([]),
  counts: z.object({
    resolved: z.number().int().nonnegative(),
    needs_look: z.number().int().nonnegative(),
    still_open: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  items: z.array(VerifyItemSchema),
  unmatchedThreads: z
    .array(
      z.object({
        id: z.string(),
        file: z.string().optional(),
        line: z.number().optional(),
        excerpt: z.string(),
      }),
    )
    .default([]),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

export const FindingSchema = z.object({
  id: z.string().min(1),
  kind: FindingKindSchema,
  file: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  severity: SeveritySchema,
  category: z.string().min(1),
  confidence: z.number().min(0).max(1),
  importance: z.number().int().min(1).max(10),
  currentCode: z.string().min(1),
  issueSimple: z.string().min(1),
  whyWeak: z.string().min(1),
  howToFix: z.string().min(1),
  betterCode: z.string().min(1),
  reviewComment: z.string().min(1),
  evidence: z.array(EvidenceSchema).default([]),
  githubCommentTarget: GithubCommentTargetSchema,
  autofixPossible: z.boolean().default(false),
  views: z.array(FindingViewSchema).default([]),
  language: z.string().default("ts"),
  /** Kept on disk when recheck shows it is not a real issue (never delete). */
  disposition: FindingDispositionSchema.default("open"),
  falseAlarmNote: z.string().optional(),
  /** Rollup of latest verify pass (conservative across agents). */
  verification: FindingVerificationSchema.optional(),
  /** Latest verify judgment per agent (re-runs replace that agent's entry). */
  verifications: z.array(FindingVerificationSchema).default([]),
  /** Recheck history from triage (newest first). */
  rechecks: z.array(RecheckEntrySchema).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReadinessSchema = z.enum([
  "blocked",
  "needs_changes",
  "approved_with_nits",
]);
export type Readiness = z.infer<typeof ReadinessSchema>;

export const JudgeResultSchema = z.object({
  readiness: ReadinessSchema,
  topReasons: z.array(z.string()).max(5),
  counts: z.object({
    blocker: z.number().int().nonnegative(),
    major: z.number().int().nonnegative(),
    minor: z.number().int().nonnegative(),
    nit: z.number().int().nonnegative(),
    suggestion: z.number().int().nonnegative(),
    question: z.number().int().nonnegative(),
    praise: z.number().int().nonnegative(),
  }),
  score: z.number().min(0).max(100).optional(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const PassResultSchema = z.object({
  passId: z.string().min(1),
  provider: z.string().min(1),
  findings: z.array(FindingSchema),
});
export type PassResult = z.infer<typeof PassResultSchema>;

export const ReviewPlanSchema = z.object({
  selectedPasses: z.array(z.string().min(1)),
  skippedPasses: z.array(
    z.object({
      id: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
  rationale: z.string().min(1),
});
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;

export const ChangedFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  changeType: z.string().default("MODIFIED"),
});
export type ChangedFileMeta = z.infer<typeof ChangedFileSchema>;

export const ReviewLoadSchema = z.object({
  source: z.enum(["pr", "branch", "demo"]),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  files: z.array(ChangedFileSchema).default([]),
  diffTruncated: z.boolean().default(false),
  diffPath: z.string().optional(),
  note: z.string().optional(),
});
export type ReviewLoad = z.infer<typeof ReviewLoadSchema>;

export const PrOverviewSchema = z.object({
  /** Plain-English: what this PR is trying to do. */
  summary: z.string().min(1),
  /** Bullet list of noteworthy changes. */
  whatChanged: z.array(z.string().min(1)).default([]),
  /** Things a human reviewer should watch. */
  mainRisks: z.array(z.string().min(1)).default([]),
  /** Suggested manual test focus. */
  testFocus: z.array(z.string().min(1)).default([]),
  provider: z.string().optional(),
});
export type PrOverview = z.infer<typeof PrOverviewSchema>;

export const AgentRunSummarySchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  createdAt: z.string().min(1),
  findingCount: z.number().int().nonnegative(),
});
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;

export const ReviewRunSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().url().optional(),
  title: z.string().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  createdAt: z.string().datetime(),
  demo: z.boolean().default(false),
  /** Agent that produced this run (per-run snapshot or merged label). */
  agent: z.string().optional(),
  /** Folder id under reviews/<n>/runs/<runId>/ */
  runId: z.string().optional(),
  /** Present on the merged top-level review. */
  agents: z.array(AgentRunSummarySchema).optional(),
  load: ReviewLoadSchema.optional(),
  /** Human-facing PR overview (what it does / risks / test focus). */
  overview: PrOverviewSchema.optional(),
  plan: ReviewPlanSchema.optional(),
  judge: JudgeResultSchema.optional(),
  /** PR-scoped knowledge markdown bodies, keyed by filename. */
  knowledgeDocs: z.record(z.string(), z.string()).default({}),
  findings: z.array(FindingSchema),
  passResults: z.array(PassResultSchema).default([]),
});
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

export const ConfigSchema = z.object({
  outputDir: z.string().default("reviews"),
  confidenceFloor: z.number().min(0).max(1).default(0.8),
  parallelism: z.number().int().positive().default(2),
  harshness: z.enum(["normal", "high", "extreme"]).default("high"),
  providers: z.object({
    default: z.string().min(1).default("demo"),
    anthropic: z
      .object({
        model: z.string().default("claude-sonnet-4-20250514"),
        maxTokens: z.number().int().positive().default(8192),
      })
      .default({}),
    openai: z
      .object({
        model: z.string().default("gpt-4.1"),
        maxTokens: z.number().int().positive().default(8192),
        baseUrl: z.string().default("https://api.openai.com/v1"),
      })
      .default({}),
  }),
  passes: z.array(
    z.object({
      id: z.string().min(1),
      enabled: z.boolean().default(true),
      provider: z.string().optional(),
    }),
  ),
  publish: z
    .object({
      includeNits: z.boolean().default(true),
      includePraise: z.boolean().default(true),
      includeQuestions: z.boolean().default(true),
    })
    .default({}),
});
export type AppConfig = z.infer<typeof ConfigSchema>;
