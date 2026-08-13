import type {
  AppConfig,
  Finding,
  PassResult,
  ReviewPlan,
  ReviewRun,
} from "@review-os/schemas";

/** Context passed into every pass. Specialists stay blind to other findings. */
export interface PassContext {
  config: AppConfig;
  prNumber: number;
  prUrl?: string;
  title?: string;
  base?: string;
  head?: string;
  demo: boolean;
  /** Absolute path to repo root being reviewed (later phases). */
  repoRoot?: string;
  /** Absolute path to this run's reviews/<n> output directory. */
  outputDir?: string;
  changedFiles: string[];
  /** Unified diff for this review (may be truncated). */
  diffText?: string;
  knowledge: Record<string, string>;
  rules: Record<string, string>;
  companyStandards?: string;
  /** Free-text guidance from the hub (or extra-instructions.md) for this run. */
  extraInstructions?: string;
  plan?: ReviewPlan;
  /** Optional progress logger (serve-ui / CLI). */
  log?: (line: string) => void;
}

export interface ProviderRequest {
  passId: string;
  prompt: string;
  rules: string;
  context: PassContext;
}

export interface ProviderResponse {
  provider: string;
  rawText: string;
  findings: Finding[];
}

export interface Provider {
  readonly id: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface Pass {
  readonly id: string;
  readonly title: string;
  run(context: PassContext, provider: Provider): Promise<PassResult>;
}

export interface PipelineResult {
  run: ReviewRun;
  outputDir: string;
  /** Pass ids that threw (provider/tool failures). */
  failedPasses: string[];
  /** True when a credit/quota/auth failure stopped remaining passes. */
  abortedForProviderLimit: boolean;
}

export type ReviewRenderer = (
  run: ReviewRun,
  outputDir: string,
  diffText?: string,
) => Promise<void>;
