import type { Finding } from "@review-os/schemas";

export interface DiffFileIndex {
  path: string;
  /** New-file side line number → exact line text. */
  lines: Map<number, string>;
  maxLine: number;
}

export interface LineReconcileResult {
  findings: Finding[];
  corrected: Array<{ id: string; from: number; to: number; reason: string }>;
  removed: Array<{ id: string; reason: string }>;
  demoted: Array<{ id: string; reason: string }>;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function stripDiffPrefix(filePath: string): string {
  return normalizePath(filePath).replace(/^[ab]\//, "");
}

function normalizeCodeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * Parse a unified diff into new-side line maps per file.
 * Line numbers are GitHub-reviewable numbers on the PR head file.
 */
export function buildDiffIndex(diffText: string): Map<string, DiffFileIndex> {
  const index = new Map<string, DiffFileIndex>();
  if (!diffText.trim()) return index;

  const chunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const header = lines[0] ?? "";
    const headerMatch = header.match(/^a\/(.+?)\s+b\/(.+)$/);
    let filePath = headerMatch?.[2] ? stripDiffPrefix(headerMatch[2]) : "";

    if (!filePath) {
      const plusLine = lines.find((line) => line.startsWith("+++ "));
      if (plusLine && !plusLine.startsWith("+++ /dev/null")) {
        filePath = stripDiffPrefix(plusLine.slice(4).trim());
      }
    }
    if (!filePath || filePath === "/dev/null") continue;

    const fileIndex: DiffFileIndex = {
      path: filePath,
      lines: new Map(),
      maxLine: 0,
    };

    let newLine = 0;
    for (const line of lines) {
      const hunk = /^\@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? \@@/.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (newLine <= 0) continue;

      if (line.startsWith("+") && !line.startsWith("+++")) {
        fileIndex.lines.set(newLine, line.slice(1));
        fileIndex.maxLine = Math.max(fileIndex.maxLine, newLine);
        newLine += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        // context line exists on both sides; still a valid head-file line
        fileIndex.lines.set(newLine, line.slice(1));
        fileIndex.maxLine = Math.max(fileIndex.maxLine, newLine);
        newLine += 1;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        // deleted from old side only — do not advance newLine
        continue;
      }
      // Ignore bare empties / metadata outside hunk content.
    }

    if (fileIndex.lines.size > 0) {
      index.set(filePath, fileIndex);
      // also index by basename collisions? keep exact path only
    }
  }

  return index;
}

function findFileIndex(
  index: Map<string, DiffFileIndex>,
  filePath: string,
): DiffFileIndex | undefined {
  const normalized = normalizePath(filePath);
  const direct = index.get(normalized);
  if (direct) return direct;

  for (const [key, value] of index.entries()) {
    if (key.endsWith(`/${normalized}`) || normalized.endsWith(`/${key}`)) {
      return value;
    }
  }
  return undefined;
}

function matchLineByCode(
  file: DiffFileIndex,
  currentCode: string,
): number | null {
  const codeLines = currentCode
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => normalizeCodeLine(line))
    .filter(Boolean);
  if (codeLines.length === 0) return null;

  const first = codeLines[0];
  if (!first) return null;

  const hits: number[] = [];
  for (const [lineNo, text] of file.lines.entries()) {
    if (normalizeCodeLine(text) === first) hits.push(lineNo);
  }

  if (hits.length === 1) return hits[0] ?? null;

  // Prefer multi-line exact sequence if available
  if (codeLines.length > 1 && hits.length > 1) {
    for (const start of hits) {
      let ok = true;
      for (let i = 0; i < codeLines.length; i += 1) {
        const expected = codeLines[i];
        const actual = file.lines.get(start + i);
        if (!expected || actual === undefined) {
          ok = false;
          break;
        }
        if (normalizeCodeLine(actual) !== expected) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
  }

  return hits.length > 0 ? (hits[0] ?? null) : null;
}

function lineMatchesCode(
  file: DiffFileIndex,
  line: number,
  currentCode: string,
): boolean {
  const first = currentCode
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((part) => normalizeCodeLine(part))
    .find(Boolean);
  if (!first) return false;
  const actual = file.lines.get(line);
  if (actual === undefined) return false;
  return normalizeCodeLine(actual) === first;
}

/**
 * Correct hallucinated line numbers using the PR diff.
 * Never invent lines outside the head-file side of the patch.
 */
export function reconcileFindingLines(
  findings: Finding[],
  diffText: string,
): LineReconcileResult {
  const index = buildDiffIndex(diffText);
  const out: Finding[] = [];
  const corrected: LineReconcileResult["corrected"] = [];
  const removed: LineReconcileResult["removed"] = [];
  const demoted: LineReconcileResult["demoted"] = [];

  if (index.size === 0) {
    return { findings, corrected, removed, demoted };
  }

  for (const finding of findings) {
    if (finding.kind === "praise") {
      out.push(finding);
      continue;
    }

    const file = findFileIndex(index, finding.file);
    if (!file) {
      // File not in diff — keep as summary-only question/suggestion
      demoted.push({
        id: finding.id,
        reason: `File not present in PR diff: ${finding.file}`,
      });
      out.push({
        ...finding,
        kind: finding.kind === "issue" ? "question" : finding.kind,
        severity: "question",
        githubCommentTarget: {
          target: "summary",
          reason: "File not found in PR diff; cannot anchor a line comment.",
        },
      });
      continue;
    }

    const claimedOk =
      finding.line >= 1 &&
      finding.line <= file.maxLine &&
      lineMatchesCode(file, finding.line, finding.currentCode);

    if (claimedOk) {
      const codeLineCount = Math.max(
        1,
        finding.currentCode.replace(/\r\n/g, "\n").split("\n").length,
      );
      const endLine = Math.min(file.maxLine, finding.line + codeLineCount - 1);
      out.push({
        ...finding,
        endLine,
        evidence: finding.evidence.map((item) =>
          item.file === finding.file || !item.file
            ? { ...item, line: finding.line, file: finding.file }
            : item,
        ),
      });
      continue;
    }

    const matched = matchLineByCode(file, finding.currentCode);
    if (matched !== null) {
      const codeLineCount = Math.max(
        1,
        finding.currentCode.replace(/\r\n/g, "\n").split("\n").length,
      );
      const endLine = Math.min(file.maxLine, matched + codeLineCount - 1);
      corrected.push({
        id: finding.id,
        from: finding.line,
        to: matched,
        reason: `Corrected from diff content match (file has ${file.maxLine} new/context lines)`,
      });
      out.push({
        ...finding,
        line: matched,
        endLine,
        githubCommentTarget: {
          target: "line",
          reason: "Anchored to verified PR diff line.",
        },
        evidence: finding.evidence.map((item) =>
          item.file === finding.file || !item.file
            ? { ...item, line: matched, file: finding.file }
            : item,
        ),
        views: [
          ...finding.views,
          {
            model: "diff-index",
            stance: "extend",
            note: `Line corrected ${finding.line} → ${matched} using diff.patch`,
          },
        ],
      });
      continue;
    }

    if (finding.line < 1 || finding.line > file.maxLine) {
      removed.push({
        id: finding.id,
        reason: `Invalid line ${finding.line} for ${finding.file} (valid 1–${file.maxLine}) and currentCode not found in diff`,
      });
      continue;
    }

    // Line exists but code snippet doesn't match — demote to summary question
    demoted.push({
      id: finding.id,
      reason: `Line ${finding.line} exists but currentCode does not match diff content`,
    });
    out.push({
      ...finding,
      kind: "question",
      severity: "question",
      githubCommentTarget: {
        target: "summary",
        reason: "Could not verify exact line content against the PR diff.",
      },
    });
  }

  return { findings: out, corrected, removed, demoted };
}
