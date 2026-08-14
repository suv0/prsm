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

export function parseFindingsFromModelText(
  text: string,
  options: { passId: string; provider: string },
): Finding[] {
  const raw = extractJsonArray(stripHeadlessCliBanners(text));
  if (!Array.isArray(raw)) {
    throw new Error("Findings JSON must be an array");
  }

  const findings: Finding[] = [];
  for (const [index, item] of raw.entries()) {
    const withDefaults = {
      id: `${options.passId}-${options.provider}-${index + 1}`,
      language: "ts",
      evidence: [],
      views: [],
      autofixPossible: false,
      disposition: "open" as const,
      githubCommentTarget: {
        target: "line",
        reason: "Model-provided finding",
      },
      ...(typeof item === "object" && item !== null ? item : {}),
    };

    const parsed = FindingSchema.safeParse(withDefaults);
    if (!parsed.success) {
      continue;
    }
    findings.push(parsed.data);
  }

  if (findings.length === 0 && raw.length > 0) {
    const preview = text.slice(0, 180).replace(/\s+/g, " ");
    throw new Error(
      `CLI returned JSON that is not findings (${raw.length} object(s)): ${preview}…`,
    );
  }

  return findings;
}
