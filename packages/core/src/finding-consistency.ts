import type { Finding } from "@review-os/schemas";
import { FindingSchema } from "@review-os/schemas";

const VAGUE_LOCATION =
  /\b(?:shared\s+)?data\/utils\b|\bshared\s+(?:data|utils|utilities)\b|\ba\s+shared\s+module\b|\bshared\s+helpers?\b/gi;

/**
 * Best-effort target module path from betterCode examples
 * (// path comments and @/… imports), resolved against the finding file.
 */
export function resolveSuggestedModulePath(
  findingFile: string,
  betterCode: string,
): string | undefined {
  const normalizedFile = findingFile.replaceAll("\\", "/");
  const commentPath = betterCode.match(
    /\/\/\s*((?:src\/|apps\/)[\w@./+-]+\.[a-zA-Z0-9]+)/,
  )?.[1];
  const importAlias = betterCode.match(
    /from\s+["'](@\/[\w@./+-]+)["']/,
  )?.[1];

  const pkgRootMatch = normalizedFile.match(/^(.*?\/src)\//);
  const pkgRoot = pkgRootMatch?.[1]; // e.g. apps/operator/src

  if (commentPath?.startsWith("apps/")) {
    return commentPath.replace(/\.(tsx?|jsx?|mjs|cjs)$/, (ext) => ext);
  }

  if (commentPath?.startsWith("src/") && pkgRoot) {
    // src/data/foo.ts under apps/operator → apps/operator/src/data/foo.ts
    return `${pkgRoot.replace(/\/src$/, "")}/${commentPath}`;
  }

  if (importAlias?.startsWith("@/") && pkgRoot) {
    const rel = importAlias.slice(2);
    const withExt = /\.[a-zA-Z0-9]+$/.test(rel) ? rel : `${rel}.ts`;
    return `${pkgRoot}/${withExt}`;
  }

  return commentPath ?? importAlias;
}

function displayPathForComment(absPath: string): string {
  // Prefer repo-relative apps/... when we have it; else leave as-is.
  return absPath.replaceAll("\\", "/");
}

function replaceVagueLocations(text: string, concrete: string): string {
  if (!VAGUE_LOCATION.test(text)) {
    // reset lastIndex because of /g
    VAGUE_LOCATION.lastIndex = 0;
    return text;
  }
  VAGUE_LOCATION.lastIndex = 0;
  const tick = concrete.includes("`") ? concrete : `\`${concrete}\``;
  return text.replace(VAGUE_LOCATION, tick);
}

/**
 * Keep howToFix + reviewComment aligned with the concrete path shown in betterCode.
 * Vague phrases like "data/utils" get rewritten to the betterCode module path.
 */
export function alignFindingSuggestionPaths(finding: Finding): Finding {
  const concreteRaw = resolveSuggestedModulePath(
    finding.file,
    finding.betterCode,
  );
  if (!concreteRaw) return finding;

  const concrete = displayPathForComment(concreteRaw);
  const howToFix = replaceVagueLocations(finding.howToFix, concrete);
  const reviewComment = replaceVagueLocations(finding.reviewComment, concrete);

  if (howToFix === finding.howToFix && reviewComment === finding.reviewComment) {
    return finding;
  }

  return FindingSchema.parse({
    ...finding,
    howToFix,
    reviewComment,
  });
}

export function alignFindingsSuggestionPaths(findings: Finding[]): Finding[] {
  return findings.map(alignFindingSuggestionPaths);
}
