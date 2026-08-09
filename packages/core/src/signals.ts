export type ReviewSignal =
  | "typescript"
  | "react"
  | "next"
  | "api"
  | "security"
  | "performance"
  | "accessibility"
  | "testing"
  | "content"
  | "styles"
  | "database"
  | "infra";

export interface SignalReport {
  signals: ReviewSignal[];
  reasons: Record<ReviewSignal, string[]>;
}

function addReason(
  reasons: Record<string, string[]>,
  signal: ReviewSignal,
  reason: string,
): void {
  const list = reasons[signal] ?? [];
  if (!list.includes(reason)) list.push(reason);
  reasons[signal] = list;
}

/** Heuristic signals from changed file paths (no LLM). */
export function detectSignals(changedFiles: string[]): SignalReport {
  const reasons: Record<string, string[]> = {};

  for (const file of changedFiles) {
    const lower = file.toLowerCase().replaceAll("\\", "/");

    if (/\.(ts|tsx|mts|cts)$/.test(lower)) {
      addReason(reasons, "typescript", file);
    }
    if (/\.(tsx|jsx)$/.test(lower) || /(^|\/)components?\//.test(lower)) {
      addReason(reasons, "react", file);
    }
    if (
      /(^|\/)app\//.test(lower) ||
      /(^|\/)pages\//.test(lower) ||
      lower.includes("next.config") ||
      lower.includes("landing-nextjs")
    ) {
      addReason(reasons, "next", file);
    }
    if (
      /(^|\/)(api|server|backend|services?)\//.test(lower) ||
      /route\.(ts|js)$/.test(lower) ||
      /controller|resolver|handler/.test(lower)
    ) {
      addReason(reasons, "api", file);
    }
    if (
      /\.(ts|tsx|js|jsx|py|go|rs)$/.test(lower) &&
      /auth|permission|session|csrf|xss|secret|password|token/.test(lower)
    ) {
      addReason(reasons, "security", file);
    }
    if (/perf|benchmark|cache|lazy|bundle|memo/.test(lower)) {
      addReason(reasons, "performance", file);
    }
    if (/a11y|aria|accessibility/.test(lower)) {
      addReason(reasons, "accessibility", file);
    }
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(lower) || /(^|\/)__tests__\//.test(lower)) {
      addReason(reasons, "testing", file);
    }
    if (/\.(md|mdx|json)$/.test(lower) && /content|posts|journal|blog/.test(lower)) {
      addReason(reasons, "content", file);
    }
    if (/\.(css|scss|sass|less)$/.test(lower) || /tailwind/.test(lower)) {
      addReason(reasons, "styles", file);
    }
    if (
      /prisma|drizzle|sql|migration|schema\.|mongoose|typeorm|sequelize/.test(
        lower,
      )
    ) {
      addReason(reasons, "database", file);
    }
    if (
      /dockerfile|docker-compose|\.yml$|\.yaml$|terraform|k8s|helm|github\/workflows/.test(
        lower,
      )
    ) {
      addReason(reasons, "infra", file);
    }
  }

  const signals = Object.keys(reasons) as ReviewSignal[];
  return {
    signals,
    reasons: reasons as Record<ReviewSignal, string[]>,
  };
}
