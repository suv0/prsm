import type { Finding, RecheckEntry, ReviewRun } from "@review-os/schemas";
import { FindingSchema, RecheckEntrySchema } from "@review-os/schemas";
import { buildJudgeResult } from "./finalize.js";
import { alignFindingSuggestionPaths } from "./finding-consistency.js";
import { randomUUID } from "node:crypto";

export type ReverifyAction = "stand" | "update" | "false_alarm";

export type ReverifyApplyResult = {
  action: ReverifyAction;
  note: string;
  finding: Finding | null;
  run: ReviewRun;
};

const MAX_DIFF_CHARS = 40_000;

const FALSE_ALARM_HINT =
  /\b(drop|remove|skip|false\s*positive|false\s*alarm|not\s+an\s+issue|no\s+issue|dismiss|not\s+real)\b/i;

const WANTS_PASTE_COMMENT =
  /\b(paste|copy\s*[- ]?paste|github\s*comment|what\s+(i'?ll|should\s+i)\s+(copy|paste|comment)|give\s+me|giv\s*e?\s*me|wording|something\s+like|code\s+example|what\s+do\s+you\s+think)\b/i;

const WANTS_TEACH_ME =
  /\b(teach\s*me|classroom|walk\s*me\s*through|explain\s+(simply|like|this)|line[- ]?by[- ]?line|patient\s+teammate|full\s+lesson)\b/i;

const MAX_SUGGESTED_COMMENT = 4_000;
const MAX_DRAFT_FROM_NOTES = 4_000;
/** Deep teammate walkthroughs need room (line-by-line + timelines). */
const MAX_TEACH_ME = 16_000;
const MAX_RECHECK_DETAILS = 6_000;

const GENERIC_UNDERSTOOD = "Re-checked this finding against your notes.";
const GENERIC_CONCLUSION = "No material change.";

/** True when reviewer notes clearly say this is not a real issue. */
export function notesAllowDrop(userPrompt: string): boolean {
  return FALSE_ALARM_HINT.test(userPrompt.trim());
}

export function notesMarkFalseAlarm(userPrompt: string): boolean {
  return notesAllowDrop(userPrompt);
}

export function notesWantPasteComment(userPrompt: string): boolean {
  // Teach-me requests often mention "GitHub comment" as section 8 — don't
  // treat that as a paste-only recheck; teachMe is the primary deliverable.
  if (notesWantTeachMe(userPrompt)) return false;
  return WANTS_PASTE_COMMENT.test(userPrompt.trim());
}

export function notesWantTeachMe(userPrompt: string): boolean {
  return WANTS_TEACH_ME.test(userPrompt.trim());
}

/** True when text looks like a reply TO the triage reviewer, not a PR-author comment. */
export function looksLikeReviewerMetaReply(comment: string): boolean {
  const t = comment.trim();
  if (!t) return true;
  if (
    /^(good question|great question|fair question|to (be clear|clarify|answer)|as you (noted|said|asked)|you('re| are) right|yes[,.]?\s+(that'?s|you)|stand\s*[—-]|update\s*[—-])/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(the reviewer|your notes|you were asking|to answer your question|for you(,| as) the reviewer)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** Prefer author-facing PR voice (conversational teammate, not meta-reply). */
export function looksLikeAuthorFacingPrComment(comment: string): boolean {
  const t = comment.trim();
  if (!t || looksLikeReviewerMetaReply(t)) return false;
  return /^(could we|would it|mind if|quick question|hm\b|hey\b|so\b|then this|i noticed|curious if|please\b|is there any way)/i.test(
    t,
  );
}

function authorFacingFallbackComment(
  finding: Finding,
  conclusion: string,
): string {
  const prior = (finding.rechecks ?? []).find((r) =>
    looksLikeAuthorFacingPrComment(r.suggestedComment ?? ""),
  )?.suggestedComment;
  if (prior) return prior.trim();

  if (looksLikeAuthorFacingPrComment(finding.reviewComment)) {
    return finding.reviewComment.trim();
  }

  const soften = /\bsoften\b/i.test(conclusion);
  const how = finding.howToFix.trim().replace(/\s+/g, " ");
  const shortHow =
    how.length > 180 ? `${how.slice(0, 177).trimEnd()}…` : how;

  if (soften) {
    return `Could we keep any design-only columns clearly marked, but compute the shared access cells from the same permission source as the detail screen so the same role doesn’t read differently in two places? ${shortHow}`;
  }

  return `Could we align this with the executable permission source (same as the detail screen) so the matrix doesn’t contradict real access for this role? ${shortHow}`;
}

/**
 * Pull a draft GitHub comment out of free-form recheck notes when the reviewer
 * already wrote the wording (e.g. “something like … Hm… …”).
 */
export function extractDraftCommentFromNotes(userPrompt: string): string | undefined {
  const text = userPrompt.trim();
  if (!text) return undefined;

  const quoted = text.match(/["“]([\s\S]+?)["”]/);
  if (quoted?.[1] && quoted[1].trim().length >= 40) {
    return quoted[1].trim().slice(0, MAX_DRAFT_FROM_NOTES);
  }

  const hmAt = text.search(/\bHm\.{0,3}\b/i);
  if (hmAt >= 0) {
    let body = text.slice(hmAt);
    const cut = body.search(
      /\n\s*["”]?\s*with code example|\n\s*can you\b|\n\s*and what do you think\b/i,
    );
    if (cut >= 40) body = body.slice(0, cut);
    const cleaned = body.replace(/\s+$/g, "").trim();
    if (cleaned.length >= 40) return cleaned.slice(0, MAX_DRAFT_FROM_NOTES);
  }

  const couldWe = text.match(
    /((?:Could we|Would it help|Mind if we)[\s\S]{40,}?)(?:\n{2,}|$)/i,
  );
  if (couldWe?.[1]) {
    return couldWe[1].trim().slice(0, MAX_DRAFT_FROM_NOTES);
  }

  return undefined;
}

function formatPriorRechecks(finding: Finding): string {
  const items = finding.rechecks ?? [];
  if (!items.length) return "(none yet — this is the first recheck)";
  return items
    .slice(0, 8)
    .map((entry, idx) => {
      const n = idx + 1;
      return [
        `### Prior recheck #${n} (${entry.action} · ${entry.provider} · ${entry.createdAt})`,
        `You asked: ${entry.userAsked}`,
        `AI understood: ${entry.understood}`,
        `Finding: ${entry.conclusion}`,
        entry.details ? `Details: ${entry.details}` : "",
        entry.suggestedComment
          ? `Suggested paste: ${entry.suggestedComment}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Merged reviews sometimes reuse the same finding id across agents.
 * Give later copies a stable unique suffix so updates can't wipe siblings.
 */
export function ensureUniqueFindingIds(findings: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  return findings.map((finding) => {
    const count = seen.get(finding.id) ?? 0;
    seen.set(finding.id, count + 1);
    if (count === 0) return finding;
    return {
      ...finding,
      id: `${finding.id}__dup${count + 1}`,
    };
  });
}

export function markFindingFalseAlarm(
  finding: Finding,
  note: string,
  options?: { overwriteComment?: boolean },
): Finding {
  const cleaned = note.trim();
  const shortNote =
    cleaned.length > 0
      ? cleaned.slice(0, 280)
      : "Not a real issue after re-check.";
  const overwriteComment = options?.overwriteComment !== false;
  return FindingSchema.parse({
    ...finding,
    disposition: "false_alarm",
    category: "false-alarm",
    falseAlarmNote: shortNote,
    ...(overwriteComment
      ? { reviewComment: `False alarm — ${shortNote}` }
      : {}),
  });
}

export function reopenFinding(finding: Finding): Finding {
  const { falseAlarmNote: _removed, ...rest } = finding;
  return FindingSchema.parse({
    ...rest,
    disposition: "open",
    category:
      finding.category === "false-alarm" ? "needs-review" : finding.category,
  });
}

/** Pull the unified-diff hunk(s) for one file path. */
export function extractDiffForFile(
  diffText: string | undefined,
  filePath: string,
): string {
  if (!diffText) return "(no diff available)";
  const wanted = filePath.replaceAll("\\", "/");
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);
  const kept: string[] = [];

  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0] ?? "";
    const pathMatch = header.match(/b\/(.+)$/);
    const file = pathMatch?.[1]?.trim().replaceAll("\\", "/");
    if (file === wanted) {
      kept.push(`diff --git ${chunk}`);
    }
  }

  if (kept.length === 0) {
    return `(no diff hunk found for ${wanted})\n\n${diffText.slice(0, 8_000)}`;
  }

  const joined = kept.join("\n");
  if (joined.length <= MAX_DIFF_CHARS) return joined;
  return `${joined.slice(0, MAX_DIFF_CHARS)}\n\n…[truncated]`;
}

export function buildReverifyPrompt(options: {
  finding: Finding;
  userPrompt: string;
  prNumber: number;
  title?: string;
  fileDiff: string;
}): string {
  const { finding, userPrompt, prNumber, title, fileDiff } = options;
  const findingForModel = {
    ...finding,
    // History is listed in its own section so the model uses the thread intentionally.
    rechecks: undefined,
    // Multi-agent merge metadata — not for the recheck model to rewrite.
    // Echoing it back with stance "stand" (recheck jargon) breaks FindingSchema.
    views: undefined,
    verifications: undefined,
  };
  const findingJson = JSON.stringify(findingForModel, null, 2);
  const markFa = notesMarkFalseAlarm(userPrompt);
  const wantsPaste = notesWantPasteComment(userPrompt);

  return [
    "# Single-finding re-verify",
    "",
    "You are re-checking ONE existing review finding. Do not invent new findings.",
    "Use the reviewer notes + prior recheck thread + the finding details + the file diff.",
    "",
    `## PR #${prNumber}${title ? ` — ${title}` : ""}`,
    "",
    "## Reviewer notes (authoritative for this pass)",
    userPrompt.trim() || "(none — verify from evidence alone)",
    "",
    "## Prior recheck thread (newest first — continue this conversation)",
    formatPriorRechecks(finding),
    "",
    "## Existing finding (JSON)",
    "```json",
    findingJson,
    "```",
    "",
    "## Key fields (human-readable)",
    `- file: ${finding.file}`,
    `- line: ${finding.line}${finding.endLine ? `–${finding.endLine}` : ""}`,
    `- severity: ${finding.severity}`,
    `- category: ${finding.category}`,
    `- disposition: ${finding.disposition ?? "open"}`,
    `- issueSimple: ${finding.issueSimple}`,
    `- whyWeak: ${finding.whyWeak}`,
    `- howToFix: ${finding.howToFix}`,
    `- reviewComment: ${finding.reviewComment}`,
    "",
    "## Current code",
    "```",
    finding.currentCode,
    "```",
    "",
    "## Suggested better code",
    "```",
    finding.betterCode,
    "```",
    "",
    "## File diff (head / + side)",
    fileDiff,
    "",
    "## Output contract",
    "Return ONLY one JSON object (not an array):",
    "{",
    '  "understood": "one short line — what you think the reviewer is asking YOU (internal)",',
    '  "conclusion": "one short line — stand / soften / false alarm / skip scope / etc.",',
    '  "teachMe": "REQUIRED — FULL teammate classroom lesson (see teachMe style below). Escape real line breaks as \\n inside this JSON string. Typical length 4k–12k characters. NOT a 5-bullet summary.",',
    '  "teachMeLines": ["OPTIONAL safer alternative to teachMe — array of lesson lines; we join with newlines. Prefer this if escaping a long teachMe string is hard."],',
    '  "details": "optional longer notes; keep heavy jargon here, not in teachMe",',
    '  "suggestedComment": "paste-ready GitHub review comment FOR THE PR AUTHOR — human teammate voice",',
    '  "finding": { ...one finding object... }',
    "}",
    "",
    "### teachMe style (critical — match this depth)",
    "Sound like a patient teammate with the file open. NOT a checklist of READ/WRITE/CALL/WAIT labels.",
    "NOT a short executive summary. The reader wants to UNDERSTAND the code.",
    "",
    "Required structure (use markdown headings + fenced code; skip a section only if it truly does not apply):",
    "1. Punchline first — e.g. \"start() already does the right order. resend() does not.\"",
    "2. Open the good path (if one exists in the same file): show the function signature, then each important line as a tiny snippet, then plain English under it.",
    "3. Open the bad / reviewed path the same way.",
    "4. For EVERY important line in the buggy path, add a mini execution note:",
    "   - the exact line (or tiny snippet)",
    "   - sample Input (concrete values: flowId=ABC123, phone=+15551112222, waitFor=0, …)",
    "   - What happens (1–2 sentences)",
    "   - Output / next state (what variables / locks / SMS look like after)",
    "5. Side-by-side compare good vs bad (order of claim vs send, etc.).",
    "6. If concurrency: Request A / Request B timeline that makes the race obvious.",
    "7. What the reviewer wants — ordered steps in plain English.",
    "8. Walk the proposed fix the same way (claim → send; revert on failure if relevant).",
    "9. One memory hook: the entire finding in one contrast (🔒 first vs 💰 first).",
    "",
    "Rules:",
    "- Quote real symbols from finding/currentCode/diff. Do NOT invent APIs.",
    "- Prefer concrete values over abstract words like \"race\" / \"atomicity\".",
    "- Light markers (good/bad, lock then send) are OK. No emoji spam. No architecture dump.",
    "- If a broader gap needs new APIs not in the diff, mark it SEPARATE in one short note.",
    "- Depth beats brevity here. Incomplete line-by-line walkthroughs fail this field.",
    "- Prefer teachMeLines (string array) when the lesson is long — more reliable than one giant escaped string.",
    "- For every real code sample, use a fenced block tagged with the PR line number, e.g. ```ts:108 then the code. That line must match the finding/file in this PR.",
    "",
    "Mini shape (illustrative — replace with THIS finding's real code):",
    "Yes. start() is already doing the right thing. resend() is not.",
    "### start() — good",
    "Snippet: this.cooldown.claim(phone);",
    "Input: phone=+15551112222",
    "What happens: reserves the phone NOW so a second request sees the lock.",
    "Output: phone locked before any SMS.",
    "### resend() — problem",
    "Snippet: await this.idpFactory.get().resendCode(flowId);",
    "Input: flowId=ABC123",
    "What happens: SMS is sent HERE — before any claim().",
    "Output: money spent; lock still missing.",
    "### Race",
    "Request A and B both check cooldown=0, both call resendCode, both pay.",
    "### Memory hook",
    "start(): claim then send. resend(): send then claim. That difference is the finding.",
    "",
    "### Field split (critical)",
    "- understood / conclusion / details = talk to the human running triage (answer their question, clarify).",
    "- suggestedComment = the text they will paste on GitHub toward the PR author. Different audience.",
    "",
    "### suggestedComment rules (always, even on stand/soften)",
    "- ALWAYS fill suggestedComment with an updated author-facing PR comment that reflects this recheck.",
    "- Voice: teammate reading the code out loud — NOT a compressed “Could we…?” scanner line.",
    "- Prefer thought-order when it fits: notice → question → concrete scenario → plain consequence → ask.",
    "- Vary the opening. “Hm… interesting.” is ONE optional example of tone — do NOT start every comment with it, and do NOT stamp the same So…/Then…/Is there any way… script on every finding.",
    "- Many comments should just state what you noticed and ask plainly, without a theatrical opener.",
    "- Keep concrete product names and simple stakes (e.g. “costing us twice”), not abstract reviewer-ese.",
    "- If the triage notes already contain the user’s preferred wording, copy that voice closely (only fix clear typos/tech mistakes).",
    "- Bad AI vibe: “Could we classify retry-safe errors separately so failover does not double-deliver OTPs?”",
    "- Good human vibe (example shape, not a template to copy verbatim): notice the risky branch → say what could happen on a phone → ask to only failover when the provider clearly said send failed.",
    "- NEVER write a meta-reply to the reviewer. Bad examples:",
    '  - “Good question — the role names are probably fine…”',
    '  - “Yes, you’re right to ask…” / “As you noted…” / “To answer your question…”',
    "- DO incorporate their notes into the AUTHOR ask when they already drafted wording.",
    "- Soften when notes/evidence say so; false-alarm notes → disposition false_alarm and a short false-alarm style comment.",
    "",
    markFa
      ? '- Reviewer may want a false alarm. If you agree, set finding.disposition to "false_alarm" and category "false-alarm". Keep original file/line/code.'
      : '- Keep finding.disposition "open" unless evidence clearly shows it is not an issue.',
    "- finding.id must stay exactly:",
    `  "${finding.id}"`,
    "- Do not include or invent finding.views / verifications / rechecks — those are managed by triage.",
    "- Soften severity when reviewer notes or documented intent say so.",
    "- Prefer category documented-debt + severity suggestion when intentional/mocked/out-of-scope for this PR.",
    "- Keep howToFix, betterCode, and suggestedComment/reviewComment on the SAME concrete path (never “data/utils” vs src/data/foo.ts).",
    "- Do not put long triage reasoning into suggestedComment — use details for that.",
    "- When the analysis stands, still refresh suggestedComment so it matches the current conclusion.",
    wantsPaste
      ? "- CRITICAL: Reviewer explicitly wants paste wording. suggestedComment MUST be author-facing GitHub text (not an answer to them)."
      : "",
    "",
    "No prose outside the JSON object.",
  ]
    .filter(Boolean)
    .join("\n");
}

function softenJson(text: string): string {
  return text.trim().replace(/,(\s*[\]}])/g, "$1");
}

export type ParsedRecheckResponse = {
  understood: string;
  conclusion: string;
  teachMe?: string;
  details?: string;
  suggestedComment?: string;
  /** Partial finding fields from the model (merged onto the existing finding). */
  incoming?: Record<string, unknown>;
};

/** Plain walkthrough when the model omits teachMe. */
export function buildTeachMeFallback(finding: Finding): string {
  const line =
    finding.endLine && finding.endLine !== finding.line
      ? `${finding.line}–${finding.endLine}`
      : String(finding.line);
  return [
    `Yes — look at ${finding.file} around line ${line}.`,
    "",
    `What's going wrong: ${finding.issueSimple}`,
    "",
    `Why it matters: ${finding.whyWeak}`,
    "",
    `Smallest fix: ${finding.howToFix}`,
    "",
    `A natural PR comment: ${finding.reviewComment}`,
  ].join("\n");
}

function unescapeJsonString(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** Find a JSON array after `"teachMeLines"` with string-aware bracket matching. */
export function extractTeachMeLinesArray(raw: string): string[] | undefined {
  const key = raw.indexOf('"teachMeLines"');
  if (key < 0) return undefined;
  const bracket = raw.indexOf("[", key);
  if (bracket < 0) return undefined;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = bracket; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "[") depth += 1;
    if (c === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(bracket, i + 1)) as unknown;
          if (
            Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every((item) => typeof item === "string")
          ) {
            return parsed;
          }
        } catch {
          return undefined;
        }
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Pull a ```json ... ``` block without stopping at ``` inside JSON string values.
 */
export function extractJsonFenceContent(raw: string): string | undefined {
  const startMatch = raw.match(/```json\b[^\n]*\n?/i);
  if (!startMatch || startMatch.index === undefined) return undefined;
  const start = startMatch.index + startMatch[0].length;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "`" && raw.slice(i, i + 3) === "```") {
      return raw.slice(start, i).trim();
    }
  }
  // Unclosed fence — return rest (still better than truncating at inner ```).
  return raw.slice(start).trim() || undefined;
}

/**
 * If teachMe is a raw recheck JSON dump (common model failure mode), recover the lesson.
 */
export function normalizeTeachMeContent(text: string): string {
  const raw = text.trim();
  if (!raw) return raw;

  const looksLikeDump =
    /```json/i.test(raw) ||
    /"teachMeLines"\s*:/.test(raw) ||
    (/^\s*\{/.test(raw) && /"understood"\s*:/.test(raw));

  if (!looksLikeDump) return raw;

  const lines = extractTeachMeLinesArray(raw);
  if (lines && lines.length > 0) {
    const joined = lines.join("\n").trim();
    if (joined.length >= 80) return joined.slice(0, MAX_TEACH_ME);
  }

  const loose = extractTeachMeLoose(raw);
  if (loose && loose.length >= 80 && !/"teachMeLines"\s*:/.test(loose)) {
    return loose.slice(0, MAX_TEACH_ME);
  }

  // Strip a leading prose blurb + json fence if we can still read teachMeLines.
  const fence = extractJsonFenceContent(raw);
  if (fence) {
    const nested = extractTeachMeLinesArray(fence);
    if (nested && nested.length > 0) {
      return nested.join("\n").trim().slice(0, MAX_TEACH_ME);
    }
  }

  return raw.slice(0, MAX_TEACH_ME);
}

function looksTruncatedLesson(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const fences = t.match(/```/g);
  if (fences && fences.length % 2 === 1) return true;
  if (/```[\w:-]*\s*$/m.test(t)) return true;
  if (/(\berror\(|\bthrow new |\breturn |\bconst |\blet |\bif \()\s*$/.test(t)) {
    return true;
  }
  if (/["'`({\[]\s*$/.test(t)) return true;
  return false;
}

function looksLikeLessonProse(text: string): boolean {
  const raw = text.trim();
  if (raw.length < 400) return false;
  return (
    /\b(What happens|Input:|Output:|Request A|side-by-side|punchline)\b/i.test(
      raw,
    ) ||
    /^#{1,3}\s+/m.test(raw) ||
    /```/.test(raw)
  );
}

function stripToLessonProse(raw: string): string {
  let prose = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  // If the model mixed a broken JSON wrapper with prose, start at the lesson.
  const lessonStart = prose.search(
    /^(?:#{1,3}\s+|Punchline\b|Yes\b|VERDICT\b)/im,
  );
  if (lessonStart > 0) {
    prose = prose.slice(lessonStart).trim();
  }
  return prose;
}

/**
 * Pull teachMe out of messy model output: valid JSON, broken multiline JSON,
 * teachMeLines arrays, or long prose lessons when JSON is missing.
 */
export function extractTeachMeLoose(text: string): string | undefined {
  const raw = text.trim();
  if (!raw) return undefined;

  // teachMeLines array — string-aware (never non-greedy-regex to first ]).
  const lines = extractTeachMeLinesArray(raw);
  if (lines && lines.length > 0) {
    const joined = lines.join("\n").trim();
    if (joined) return joined.slice(0, MAX_TEACH_ME);
  }

  // Broken multiline: "teachMe": " .... until next top-level key
  const multi = raw.match(
    /"teachMe"\s*:\s*"([\s\S]*?)"\s*,\s*"(?:suggestedComment|details|finding|conclusion|understood|teachMeLines)"/,
  );
  if (multi?.[1] && multi[1].trim().length > 40) {
    const candidate = unescapeJsonString(multi[1]).trim();
    if (!looksTruncatedLesson(candidate)) {
      return candidate.slice(0, MAX_TEACH_ME);
    }
  }

  // Standard JSON string — ONLY if closing quote is real JSON punctuation.
  // Otherwise code like error(" inside the lesson truncates the match early.
  const singleLine = raw.match(
    /"teachMe"\s*:\s*"((?:\\.|[^"\\])*)"\s*[,}]/,
  );
  if (singleLine?.[1] && singleLine[1].length > 40) {
    const candidate = unescapeJsonString(singleLine[1]).trim();
    const restIsMuchLonger = raw.length > candidate.length * 2 + 200;
    if (!looksTruncatedLesson(candidate) && !restIsMuchLonger) {
      return candidate.slice(0, MAX_TEACH_ME);
    }
  }

  // Prose + ```json dump with nested code fences — recover via string-aware fence.
  if (/```json/i.test(raw) || /"teachMeLines"\s*:/.test(raw)) {
    const fence = extractJsonFenceContent(raw);
    if (fence) {
      const nested = extractTeachMeLinesArray(fence);
      if (nested && nested.length > 0) {
        return nested.join("\n").trim().slice(0, MAX_TEACH_ME);
      }
      try {
        const obj = JSON.parse(softenJson(fence)) as Record<string, unknown>;
        if (Array.isArray(obj.teachMeLines)) {
          const joined = obj.teachMeLines
            .filter((line): line is string => typeof line === "string")
            .join("\n")
            .trim();
          if (joined) return joined.slice(0, MAX_TEACH_ME);
        }
        if (typeof obj.teachMe === "string" && obj.teachMe.trim().length > 80) {
          return obj.teachMe.trim().slice(0, MAX_TEACH_ME);
        }
      } catch {
        // continue to prose path
      }
    }
  }

  // Prose lesson (no usable JSON field) — common when the model ignores JSON.
  if (looksLikeLessonProse(raw)) {
    const prose = stripToLessonProse(raw);
    if (prose.startsWith("{") && /"teachMe(?:Lines)?"/.test(prose)) {
      return undefined;
    }
    if (prose.startsWith("{")) return undefined;
    // Refuse to show a raw JSON dump with a short intro as the lesson.
    if (/```json/i.test(prose) && /"teachMeLines"\s*:/.test(prose)) {
      return undefined;
    }
    if (prose.length >= 400) return prose.slice(0, MAX_TEACH_ME);
  }

  return undefined;
}

/** Prefer a recovered lesson; never keep a raw recheck JSON dump as teachMe. */
export function finalizeTeachMe(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined;
  const normalized = normalizeTeachMeContent(text.trim()).trim();
  if (!normalized) return undefined;
  if (
    (/```json/i.test(normalized) || /"understood"\s*:/.test(normalized)) &&
    /"teachMeLines"\s*:/.test(normalized)
  ) {
    return undefined;
  }
  return normalized.slice(0, MAX_TEACH_ME);
}

/** Pull a paste comment out of messy model output / prose lessons. */
export function extractSuggestedCommentLoose(
  text: string,
): string | undefined {
  const raw = text.trim();
  if (!raw) return undefined;

  const fromJson = raw.match(
    /"suggestedComment"\s*:\s*"((?:\\.|[^"\\])*)"\s*[,}]/,
  );
  if (fromJson?.[1] && fromJson[1].trim().length >= 40) {
    const c = unescapeJsonString(fromJson[1]).trim();
    if (looksLikeAuthorFacingPrComment(c)) return c.slice(0, MAX_SUGGESTED_COMMENT);
  }

  const section = raw.match(
    /(?:^|\n)#{1,3}\s*(?:GitHub comment|Paste(?:-ready)? comment|Suggested(?: GitHub)? comment)\s*\n+([\s\S]+?)(?=\n#{1,3}\s|\n---\s*$|$)/i,
  );
  if (section?.[1]) {
    const c = section[1].trim().replace(/^>\s?/gm, "").trim();
    if (c.length >= 40) return c.slice(0, MAX_SUGGESTED_COMMENT);
  }

  const hm = raw.match(/\b(Hm\.{0,3}\b[\s\S]{40,}?)(?:\n#{1,3}\s|$)/i);
  if (hm?.[1] && looksLikeAuthorFacingPrComment(hm[1].trim())) {
    return hm[1].trim().slice(0, MAX_SUGGESTED_COMMENT);
  }

  return undefined;
}

/**
 * Author-facing paste when the model returned formal “Could we…?” voice
 * or salvage had to invent a comment.
 *
 * Deliberately NOT a fixed “Hm… interesting / So… / Then… / Is there any way…”
 * script — that was one good example of tone, not a house template.
 */
export function buildConversationalPaste(finding: Finding): string {
  const existing = finding.reviewComment?.trim() ?? "";
  if (
    existing &&
    looksLikeAuthorFacingPrComment(existing) &&
    !/^could we\b/i.test(existing) &&
    existing.length >= 60
  ) {
    return existing.slice(0, MAX_SUGGESTED_COMMENT);
  }

  const issue = finding.issueSimple.replace(/\s+/g, " ").trim();
  const why = finding.whyWeak.replace(/\s+/g, " ").trim();
  const whyShort =
    why.length > 220 ? `${why.slice(0, 217).trimEnd()}…` : why;
  const ask = finding.howToFix
    .replace(/\s+/g, " ")
    .replace(/^\d+\.\s*/g, "")
    .trim();
  const askShort =
    ask.length > 180 ? `${ask.slice(0, 177).trimEnd()}…` : ask;
  const issueLine = /[.?!]$/.test(issue) ? issue : `${issue}.`;
  const askLine = /[?]$/.test(askShort)
    ? askShort
    : `Worth ${askShort.charAt(0).toLowerCase()}${askShort.slice(1).replace(/\.$/, "")}?`;

  return [issueLine, whyShort, askLine]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_SUGGESTED_COMMENT);
}

export function parseRecheckModelResponse(
  text: string,
  findingId: string,
): ParsedRecheckResponse {
  // String-aware ```json fence — non-greedy regex stops at nested ``` in teachMeLines.
  const candidate = extractJsonFenceContent(text) || text.trim();
  const objStart = candidate.indexOf("{");
  const objEnd = candidate.lastIndexOf("}");
  const arrStart = candidate.indexOf("[");
  const arrEnd = candidate.lastIndexOf("]");
  const looseTeach = finalizeTeachMe(extractTeachMeLoose(text));
  const looseComment = extractSuggestedCommentLoose(text);

  // Prefer a top-level object when both exist — models often dump a findings
  // array by habit (pass format) after or around the real recheck object.
  const objectLooksLikeRecheck = (raw: Record<string, unknown>): boolean =>
    typeof raw.understood === "string" ||
    typeof raw.conclusion === "string" ||
    typeof raw.teachMe === "string" ||
    Array.isArray(raw.teachMeLines) ||
    typeof raw.suggestedComment === "string" ||
    (raw.finding !== undefined && typeof raw.finding === "object");

  const teachFromRaw = (raw: Record<string, unknown>): string | undefined => {
    if (Array.isArray(raw.teachMeLines)) {
      const joined = raw.teachMeLines
        .filter((line): line is string => typeof line === "string")
        .join("\n")
        .trim();
      if (joined) return finalizeTeachMe(joined) ?? joined.slice(0, MAX_TEACH_ME);
    }
    if (typeof raw.teachMe === "string" && raw.teachMe.trim()) {
      const t = raw.teachMe.trim();
      if (!looksTruncatedLesson(t)) return finalizeTeachMe(t) ?? t.slice(0, MAX_TEACH_ME);
    }
    return looseTeach;
  };

  const commentFromRaw = (
    raw: Record<string, unknown>,
    findingRaw?: Record<string, unknown>,
  ): string | undefined => {
    if (typeof raw.suggestedComment === "string" && raw.suggestedComment.trim()) {
      return raw.suggestedComment.trim();
    }
    if (looseComment) return looseComment;
    if (typeof findingRaw?.reviewComment === "string") {
      return String(findingRaw.reviewComment);
    }
    return undefined;
  };

  if (objStart !== -1 && objEnd > objStart) {
    try {
      const raw = JSON.parse(
        softenJson(candidate.slice(objStart, objEnd + 1)),
      ) as Record<string, unknown>;
      if (objectLooksLikeRecheck(raw) || arrStart === -1 || objStart < arrStart) {
        const findingRaw =
          raw.finding && typeof raw.finding === "object"
            ? ({ ...(raw.finding as object), id: findingId } as Record<
                string,
                unknown
              >)
            : undefined;
        const teachMe = teachFromRaw(raw);
        const suggestedComment = commentFromRaw(raw, findingRaw);
        return {
          understood:
            typeof raw.understood === "string" && raw.understood.trim()
              ? raw.understood.trim()
              : GENERIC_UNDERSTOOD,
          conclusion:
            typeof raw.conclusion === "string" && raw.conclusion.trim()
              ? raw.conclusion.trim()
              : typeof findingRaw?.issueSimple === "string"
                ? String(findingRaw.issueSimple)
                : "See details.",
          ...(teachMe ? { teachMe } : {}),
          ...(typeof raw.details === "string" && raw.details.trim()
            ? { details: raw.details.trim() }
            : {}),
          ...(suggestedComment ? { suggestedComment } : {}),
          ...(findingRaw ? { incoming: findingRaw } : {}),
        };
      }
    } catch {
      // Fall through — try array / loose teachMe salvage.
    }
  }

  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      const list = JSON.parse(
        softenJson(candidate.slice(arrStart, arrEnd + 1)),
      ) as unknown[];
      const first = (list[0] ?? null) as Record<string, unknown> | null;
      // Empty array / non-finding junk is NOT a successful recheck reply.
      if (!first || Object.keys(first).length === 0) {
        if (looseTeach) {
          return {
            understood: GENERIC_UNDERSTOOD,
            conclusion: "Stand — lesson recovered from non-JSON model reply.",
            teachMe: looseTeach,
            details:
              "Model returned an empty JSON array; salvaged teachMe from prose.",
            ...(looseComment ? { suggestedComment: looseComment } : {}),
          };
        }
        throw new Error(
          "Recheck model returned an empty JSON array instead of the required object",
        );
      }
      return {
        understood: GENERIC_UNDERSTOOD,
        conclusion:
          typeof first.issueSimple === "string"
            ? first.issueSimple
            : typeof first.conclusion === "string"
              ? first.conclusion
              : GENERIC_CONCLUSION,
        ...(looseTeach ? { teachMe: looseTeach } : {}),
        ...(looseComment
          ? { suggestedComment: looseComment }
          : typeof first.reviewComment === "string"
            ? { suggestedComment: first.reviewComment }
            : typeof first.suggestedComment === "string"
              ? { suggestedComment: first.suggestedComment }
              : {}),
        ...(typeof first.whyWeak === "string" ? { details: first.whyWeak } : {}),
        incoming: { ...first, id: findingId },
      };
    } catch (error) {
      if (looseTeach) {
        return {
          understood: GENERIC_UNDERSTOOD,
          conclusion: "Stand — lesson recovered from non-JSON model reply.",
          teachMe: looseTeach,
          details:
            error instanceof Error
              ? `Parser salvage after: ${error.message}`
              : "Parser salvage after JSON failure.",
          ...(looseComment ? { suggestedComment: looseComment } : {}),
        };
      }
      throw error;
    }
  }

  if (looseTeach) {
    return {
      understood: GENERIC_UNDERSTOOD,
      conclusion: "Stand — lesson recovered from non-JSON model reply.",
      teachMe: looseTeach,
      details: "Recheck response had no valid JSON object; used prose as teachMe.",
      ...(looseComment ? { suggestedComment: looseComment } : {}),
    };
  }

  throw new Error("Recheck response did not contain JSON");
}

/**
 * Apply a recheck: update analytical fields, append history, never auto-overwrite
 * the paste-ready reviewComment (stored as suggestedComment on the history entry).
 */
export function applyRecheckToRun(
  run: ReviewRun,
  findingId: string,
  parsed: ParsedRecheckResponse,
  options: { userAsked: string; provider: string },
): ReverifyApplyResult {
  const findings = ensureUniqueFindingIds(run.findings);
  const index = findings.findIndex((f) => f.id === findingId);
  if (index === -1) {
    throw new Error(`Finding not found: ${findingId}`);
  }
  const existing = findings[index]!;
  const userPrompt = options.userAsked;
  const wantsFalseAlarm = notesMarkFalseAlarm(userPrompt);
  const incoming = parsed.incoming;

  let action: ReverifyAction = "stand";
  let note = "Stood — no material change.";
  let merged = existing;

  if (!incoming) {
    if (wantsFalseAlarm) {
      merged = markFindingFalseAlarm(existing, userPrompt, {
        overwriteComment: false,
      });
      action = "false_alarm";
      note = "Marked false alarm — kept in review (paste comment unchanged).";
    }
  } else {
    const disposition =
      incoming.disposition === "false_alarm" || wantsFalseAlarm
        ? "false_alarm"
        : typeof incoming.disposition === "string"
          ? incoming.disposition
          : (existing.disposition ?? "open");

    merged = FindingSchema.parse({
      ...existing,
      ...incoming,
      id: existing.id,
      disposition,
      reviewComment: existing.reviewComment,
      evidence: incoming.evidence ?? existing.evidence,
      // Keep merge-time agent views; recheck must not invent/overwrite stances.
      views: existing.views,
      verifications: existing.verifications ?? [],
      rechecks: existing.rechecks ?? [],
      githubCommentTarget:
        incoming.githubCommentTarget ?? existing.githubCommentTarget,
      language: incoming.language ?? existing.language,
      currentCode: incoming.currentCode ?? existing.currentCode,
      issueSimple: incoming.issueSimple ?? existing.issueSimple,
      whyWeak: incoming.whyWeak ?? existing.whyWeak,
      howToFix: incoming.howToFix ?? existing.howToFix,
      betterCode: incoming.betterCode ?? existing.betterCode,
      kind: incoming.kind ?? existing.kind,
      severity: incoming.severity ?? existing.severity,
      category: incoming.category ?? existing.category,
      confidence: incoming.confidence ?? existing.confidence,
      importance: incoming.importance ?? existing.importance,
      file: existing.file,
      line: incoming.line ?? existing.line,
    });

    if (disposition === "false_alarm") {
      merged = markFindingFalseAlarm(merged, userPrompt, {
        overwriteComment: false,
      });
      action = "false_alarm";
      note = "Marked false alarm — kept in review (paste comment unchanged).";
    } else {
      const changed =
        merged.severity !== existing.severity ||
        merged.issueSimple !== existing.issueSimple ||
        merged.howToFix !== existing.howToFix ||
        merged.whyWeak !== existing.whyWeak ||
        merged.category !== existing.category ||
        merged.betterCode !== existing.betterCode;
      action = changed ? "update" : "stand";
      note = changed
        ? "Updated analysis fields. Suggested paste comment is in Recheck history (not auto-applied)."
        : "Stood — no material change. See Recheck history for the model reply.";
    }
  }

  const wantsPaste = notesWantPasteComment(userPrompt);
  const draftFromNotes = extractDraftCommentFromNotes(userPrompt);
  const fromThread = (existing.rechecks ?? []).find((r) =>
    looksLikeAuthorFacingPrComment(r.suggestedComment ?? ""),
  )?.suggestedComment?.trim();
  const weakModelReply =
    parsed.understood === GENERIC_UNDERSTOOD ||
    parsed.conclusion === GENERIC_CONCLUSION ||
    parsed.conclusion === "See details.";

  let understood = parsed.understood;
  let conclusion = parsed.conclusion;
  let details = parsed.details?.trim();
  let teachMe = finalizeTeachMe(parsed.teachMe) ?? parsed.teachMe?.trim();

  if (wantsPaste && weakModelReply) {
    understood =
      "You want an updated paste-ready GitHub comment for the PR author.";
    conclusion =
      "Stand — finding still valid; author-facing paste is in Recheck history.";
    if (!details) {
      details =
        "Model returned a weak/empty reply; synthesized an author-facing suggestedComment from notes/thread.";
    }
  }

  if (!teachMe) {
    teachMe = buildTeachMeFallback(merged);
  }

  let suggested =
    parsed.suggestedComment?.trim() ||
    (draftFromNotes && looksLikeAuthorFacingPrComment(draftFromNotes)
      ? draftFromNotes
      : undefined) ||
    (action === "false_alarm"
      ? `False alarm — ${(merged.falseAlarmNote ?? userPrompt).slice(0, 200)}`
      : undefined);

  const formalCouldWe = (s: string | undefined) =>
    Boolean(s && /^could we\b/i.test(s.trim()));

  // Teach-me / conversational voice: never leave a compressed scanner “Could we…?”
  // when the user asked for teammate wording.
  if (
    notesWantTeachMe(userPrompt) &&
    (!suggested || formalCouldWe(suggested) || looksLikeReviewerMetaReply(suggested))
  ) {
    suggested = buildConversationalPaste(merged);
  }

  // suggestedComment must be FOR the PR author. If the model answered the
  // triage reviewer instead ("Good question — …"), rewrite.
  if (
    !suggested ||
    looksLikeReviewerMetaReply(suggested) ||
    (wantsPaste && !looksLikeAuthorFacingPrComment(suggested))
  ) {
    suggested =
      (draftFromNotes && looksLikeAuthorFacingPrComment(draftFromNotes)
        ? draftFromNotes
        : undefined) ||
      (fromThread && !formalCouldWe(fromThread) ? fromThread : undefined) ||
      (notesWantTeachMe(userPrompt)
        ? buildConversationalPaste(merged)
        : undefined) ||
      fromThread ||
      authorFacingFallbackComment(merged, conclusion);
  }

  // Always produce an author-facing paste on recheck (unless empty after fallback).
  if (!suggested?.trim()) {
    suggested = notesWantTeachMe(userPrompt)
      ? buildConversationalPaste(merged)
      : authorFacingFallbackComment(merged, conclusion);
  }

  const entry = RecheckEntrySchema.parse({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: options.provider,
    userAsked: userPrompt.trim() || "(no notes)",
    understood: understood.slice(0, 280),
    conclusion: conclusion.slice(0, 280),
    action,
    teachMe: teachMe.slice(0, MAX_TEACH_ME),
    ...(details ? { details: details.slice(0, MAX_RECHECK_DETAILS) } : {}),
    ...(suggested ? { suggestedComment: suggested.slice(0, MAX_SUGGESTED_COMMENT) } : {}),
  });

  if (suggested) {
    note =
      action === "stand"
        ? "Stood — author-facing GitHub comment is in Recheck history (Copy)."
        : `${note} Author-facing GitHub comment is in Recheck history (Copy).`;
  }

  if (weakModelReply && !suggested) {
    note =
      "Model reply was empty/weak (often a bare JSON array). Try again, or paste notes that already contain the wording you want.";
  }

  merged = FindingSchema.parse({
    ...merged,
    rechecks: [entry, ...(existing.rechecks ?? [])].slice(0, 40),
  });
  merged = alignFindingSuggestionPaths(merged);

  const nextFindings = findings.map((f, i) => (i === index ? merged : f));
  const next: ReviewRun = {
    ...run,
    findings: nextFindings,
    judge: buildJudgeResult(nextFindings),
  };

  return {
    action,
    note,
    finding: merged,
    run: next,
  };
}

/** @deprecated Prefer applyRecheckToRun (keeps paste comment intact). */
export function applyReverifyToRun(
  run: ReviewRun,
  findingId: string,
  returned: Finding[],
  userPrompt = "",
): ReverifyApplyResult {
  const first = returned[0];
  return applyRecheckToRun(
    run,
    findingId,
    {
      understood: "Re-checked this finding against your notes.",
      conclusion: first?.issueSimple ?? "No material change.",
      ...(first?.reviewComment
        ? { suggestedComment: first.reviewComment }
        : {}),
      ...(first?.whyWeak ? { details: first.whyWeak } : {}),
      ...(first
        ? { incoming: first as unknown as Record<string, unknown> }
        : {}),
    },
    { userAsked: userPrompt, provider: "recheck" },
  );
}

export function applyDispositionToRun(
  run: ReviewRun,
  findingId: string,
  disposition: "open" | "false_alarm",
  note = "",
): ReverifyApplyResult {
  const findings = ensureUniqueFindingIds(run.findings);
  const index = findings.findIndex((f) => f.id === findingId);
  if (index === -1) {
    throw new Error(`Finding not found: ${findingId}`);
  }
  const existing = findings[index]!;
  const nextFinding =
    disposition === "false_alarm"
      ? markFindingFalseAlarm(existing, note, { overwriteComment: true })
      : reopenFinding(existing);
  const nextFindings = findings.map((f, i) => (i === index ? nextFinding : f));
  const next: ReviewRun = {
    ...run,
    findings: nextFindings,
    judge: buildJudgeResult(nextFindings),
  };
  return {
    action: disposition === "false_alarm" ? "false_alarm" : "update",
    note:
      disposition === "false_alarm"
        ? "Marked false alarm — kept in review."
        : "Reopened — back in the open queue.",
    finding: nextFinding,
    run: next,
  };
}

export type { RecheckEntry };
