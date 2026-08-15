import { FindingSchema, type Finding } from "@review-os/schemas";
import { stripHeadlessCliBanners } from "./run-cli.js";

/** Remove trailing commas that models often leave before } or ]. */
function stripTrailingCommas(jsonText: string): string {
  return jsonText.replace(/,(\s*[\]}])/g, "$1");
}

/** Best-effort repair for common LLM JSON damage. */
function softenJson(jsonText: string): string {
  let text = jsonText.trim();
  text = text.replace(/^\s*\/\/.*$/gm, "");
  text = stripTrailingCommas(text);
  return text;
}

function tryParseJson(text: string): unknown {
  return JSON.parse(softenJson(text));
}

/** Index of matching `}` for `{` at `start`, or -1 if malformed / truncated. */
function findMatchingBrace(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Pull every parseable `{ ... }` object from text.
 * Skips broken objects without discarding later siblings.
 */
function extractValidObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    const end = findMatchingBrace(text, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    const slice = text.slice(i, end + 1);
    try {
      out.push(tryParseJson(slice));
      i = end + 1;
    } catch {
      i += 1;
    }
  }
  return out;
}

/** Index of matching `]` for `[` at `start`, or -1 if truncated. */
function findMatchingBracket(text: string, start: number): number {
  if (text[start] !== "[") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractJsonArrayCandidate(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();

  const start = candidate.indexOf("[");
  if (start === -1) {
    return candidate;
  }
  const end = findMatchingBracket(candidate, start);
  if (end > start) {
    return candidate.slice(start, end + 1);
  }
  // Truncated / missing outer ] — take from first [ and salvage objects later.
  return candidate.slice(start);
}

function parseArrayLoose(arrayText: string): unknown[] {
  const attempts = [arrayText, softenJson(arrayText)].filter(Boolean);

  for (const attempt of attempts) {
    try {
      const parsed = tryParseJson(attempt);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // next strategy
    }
  }

  const salvaged = extractValidObjects(arrayText);
  if (salvaged.length > 0) return salvaged;

  throw new Error(
    `Could not parse findings JSON (len=${arrayText.length}): ${arrayText.slice(0, 180).replace(/\s+/g, " ")}…`,
  );
}

function extractJsonArray(text: string): unknown {
  const candidate = extractJsonArrayCandidate(text);
  try {
    return parseArrayLoose(candidate);
  } catch (error) {
    const fromFull = extractValidObjects(text);
    if (fromFull.length > 0) return fromFull;
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Drop null/undefined so they cannot wipe defaults (common LLM habit). */
function omitNullish(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function firstNonEmptyString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coerceConfidence(value: unknown): number | undefined {
  const n = coerceNumber(value);
  if (n === undefined) return undefined;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function coerceImportance(value: unknown): number | undefined {
  const n = coerceNumber(value);
  if (n === undefined) return undefined;
  return Math.round(n);
}

function normalizeEvidence(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map((entry) => {
      const row = asRecord(entry);
      if (!row) return null;
      const quote = firstNonEmptyString(row, ["quote", "text", "snippet"]);
      if (!quote) return null;
      const file = firstNonEmptyString(row, ["file", "path"]);
      const line = coerceNumber(row.line);
      return {
        quote,
        ...(file ? { file } : {}),
        ...(line !== undefined && line > 0 ? { line: Math.trunc(line) } : {}),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  return cleaned;
}

function normalizeGithubCommentTarget(value: unknown): unknown {
  const row = asRecord(value);
  if (!row) return undefined;
  const targetRaw = row.target;
  const target =
    targetRaw === "line" || targetRaw === "summary" ? targetRaw : undefined;
  const reason = firstNonEmptyString(row, ["reason", "why", "note"]);
  if (!target) return undefined;
  return { target, reason: reason ?? "Model-provided finding" };
}

/**
 * Soften common CLI / model deviations so FindingSchema can accept the object.
 * Returns null when the object is not finding-shaped enough to salvage.
 */
export function normalizeFindingCandidate(
  item: unknown,
): Record<string, unknown> | null {
  const raw = asRecord(item);
  if (!raw) return null;
  const record = omitNullish(raw);

  const file = firstNonEmptyString(record, ["file", "path", "filename"]);
  if (!file) return null;

  const line = coerceNumber(record.line);
  if (line === undefined || line <= 0) return null;

  const kindRaw = firstNonEmptyString(record, ["kind", "type"]);
  const kind =
    kindRaw === "issue" || kindRaw === "question" || kindRaw === "praise"
      ? kindRaw
      : "issue";

  const severityRaw = firstNonEmptyString(record, ["severity", "level"]);
  const severity =
    severityRaw === "blocker" ||
    severityRaw === "major" ||
    severityRaw === "minor" ||
    severityRaw === "nit" ||
    severityRaw === "suggestion" ||
    severityRaw === "question"
      ? severityRaw
      : "major";

  const issueSimple =
    firstNonEmptyString(record, [
      "issueSimple",
      "title",
      "summary",
      "message",
      "problem",
      "headline",
    ]) ?? `Issue in ${file}:${Math.trunc(line)}`;

  const whyWeak =
    firstNonEmptyString(record, [
      "whyWeak",
      "why",
      "rationale",
      "analysis",
      "description",
      "detail",
      "details",
    ]) ?? issueSimple;

  const howToFix =
    firstNonEmptyString(record, [
      "howToFix",
      "fix",
      "recommendation",
      "remediation",
      "suggestion",
    ]) ?? "Review this finding and apply the fix described in betterCode.";

  const currentCode =
    firstNonEmptyString(record, [
      "currentCode",
      "code",
      "snippet",
      "excerpt",
      "before",
    ]) ?? "(snippet omitted by model)";

  const betterCode =
    firstNonEmptyString(record, [
      "betterCode",
      "suggestedCode",
      "fixedCode",
      "after",
      "patch",
    ]) ?? currentCode;

  const reviewComment =
    firstNonEmptyString(record, [
      "reviewComment",
      "comment",
      "githubComment",
      "body",
      "prComment",
    ]) ?? issueSimple;

  const category =
    firstNonEmptyString(record, ["category", "area", "tag"]) ?? "general";

  const confidence = coerceConfidence(record.confidence) ?? 0.7;
  const importance = coerceImportance(record.importance) ?? 5;
  const endLine = coerceNumber(record.endLine);
  const evidence = normalizeEvidence(record.evidence);
  const githubCommentTarget = normalizeGithubCommentTarget(
    record.githubCommentTarget,
  );
  const language = firstNonEmptyString(record, ["language", "lang"]);

  const normalized: Record<string, unknown> = {
    ...record,
    kind,
    file,
    line: Math.trunc(line),
    severity,
    category,
    confidence: Math.min(1, Math.max(0, confidence)),
    importance: Math.min(10, Math.max(1, importance)),
    currentCode,
    issueSimple,
    whyWeak,
    howToFix,
    betterCode,
    reviewComment,
  };
  delete normalized.endLine;
  delete normalized.evidence;
  delete normalized.githubCommentTarget;
  if (endLine !== undefined && endLine > 0) {
    normalized.endLine = Math.trunc(endLine);
  }
  if (evidence !== undefined) normalized.evidence = evidence;
  if (githubCommentTarget !== undefined) {
    normalized.githubCommentTarget = githubCommentTarget;
  }
  if (language) normalized.language = language;
  return omitNullish(normalized);
}

function formatZodIssues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function parseFindingsFromModelText(
  text: string,
  options: { passId: string; provider: string },
): Finding[] {
  const raw = extractJsonArray(stripHeadlessCliBanners(text));
  if (!Array.isArray(raw)) {
    throw new Error("Findings JSON must be an array");
  }

  const findings: Finding[] = [];
  const rejectReasons: string[] = [];

  for (const [index, item] of raw.entries()) {
    const normalized = normalizeFindingCandidate(item);
    if (!normalized) {
      rejectReasons.push(`#${index + 1}: not finding-shaped`);
      continue;
    }

    const withDefaults = {
      id: `${options.passId}-${options.provider}-${index + 1}`,
      language: "ts",
      evidence: [],
      views: [],
      autofixPossible: false,
      disposition: "open" as const,
      githubCommentTarget: {
        target: "line" as const,
        reason: "Model-provided finding",
      },
      ...normalized,
    };

    const parsed = FindingSchema.safeParse(withDefaults);
    if (!parsed.success) {
      rejectReasons.push(`#${index + 1}: ${formatZodIssues(parsed.error)}`);
      continue;
    }
    findings.push(parsed.data);
  }

  if (findings.length === 0 && raw.length > 0) {
    const preview = text.slice(0, 180).replace(/\s+/g, " ");
    const why =
      rejectReasons.length > 0
        ? ` First failures: ${rejectReasons.slice(0, 3).join(" | ")}.`
        : "";
    throw new Error(
      `CLI returned JSON that is not findings (${raw.length} object(s)): ${preview}…${why}`,
    );
  }

  return findings;
}
