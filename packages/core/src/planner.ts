import type { ReviewPlan } from "@review-os/schemas";
import type { SignalReport } from "./signals.js";

export interface PlannerInput {
  availablePassIds: string[];
  signals: SignalReport;
  /** Always keep these if available. */
  alwaysInclude?: string[];
}

const PASS_SIGNAL_MAP: Record<string, Array<SignalReport["signals"][number] | "*">> = {
  correctness: ["*"],
  nitpick: ["*"],
  "devils-advocate": ["*"],
  architecture: ["*"],
  typescript: ["typescript"],
  react: ["react", "next"],
  next: ["next"],
  security: ["security", "api"],
  performance: ["performance", "react", "next"],
  accessibility: ["accessibility", "react", "next"],
  api: ["api"],
  testing: ["testing"],
  database: ["database"],
};

function passMatches(passId: string, signals: SignalReport): boolean {
  const needed = PASS_SIGNAL_MAP[passId] ?? ["*"];
  if (needed.includes("*")) return true;
  return needed.some((signal) => signals.signals.includes(signal as never));
}

export function planReview(input: PlannerInput): ReviewPlan {
  const always = new Set(input.alwaysInclude ?? ["correctness", "nitpick", "devils-advocate"]);
  const selected: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const passId of input.availablePassIds) {
    if (always.has(passId) || passMatches(passId, input.signals)) {
      selected.push(passId);
      continue;
    }
    skipped.push({
      id: passId,
      reason: `No matching file signals for this pass (signals: ${input.signals.signals.join(", ") || "none"})`,
    });
  }

  const signalSummary =
    input.signals.signals.length > 0
      ? input.signals.signals.join(", ")
      : "none detected";

  return {
    selectedPasses: selected,
    skippedPasses: skipped,
    rationale: `Planner selected passes from path signals: ${signalSummary}. Core passes always run when available.`,
  };
}
