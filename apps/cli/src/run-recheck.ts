import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyRecheckToRun,
  buildReverifyPrompt,
  extractDraftCommentFromNotes,
  extractSuggestedCommentLoose,
  extractTeachMeLoose,
  finalizeTeachMe,
  notesWantPasteComment,
  notesWantTeachMe,
  parseRecheckModelResponse,
  type ReverifyApplyResult,
} from "@review-os/core";
import {
  cliInvocation,
  createCliLogBridge,
  execCli,
} from "@review-os/providers";
import type { Finding, ReviewRun } from "@review-os/schemas";
import { loadCustomAgents } from "./custom-agents.js";

export type LogFn = (line: string) => void;

async function cliForProvider(providerId: string): Promise<{
  command: string;
  args: (instruction: string, cwd: string) => string[];
}> {
  const extras = await loadCustomAgents();
  return cliInvocation(providerId, extras);
}

export async function runRecheckFinding(options: {
  repoRoot: string;
  outputDir: string;
  run: ReviewRun;
  finding: Finding;
  userPrompt: string;
  providerId: string;
  fileDiff: string;
  log?: LogFn;
}): Promise<ReverifyApplyResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const { run, finding, userPrompt, providerId, fileDiff, repoRoot, outputDir } =
    options;

  const prompt = buildReverifyPrompt({
    finding,
    userPrompt,
    prNumber: run.prNumber,
    ...(run.title !== undefined ? { title: run.title } : {}),
    fileDiff,
  });

  const agentDir = path.join(outputDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const safe = finding.id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
  const promptPath = path.join(agentDir, `recheck-${safe}.prompt.txt`);
  await writeFile(promptPath, prompt, "utf8");

  log(`▶ recheck ${finding.id} via ${providerId}`);
  log(`  notes: ${(userPrompt || "(none)").slice(0, 160)}`);

  const instruction = [
    "You re-check ONE PR review finding using the reviewer's notes.",
    `Read and follow: ${promptPath}`,
    "Return ONLY one JSON object (not an array).",
    "Required keys: understood, conclusion, suggestedComment, finding.",
    "For Teach me / explain notes: REQUIRED teachMeLines (string array, one lesson line per element — safest) OR teachMe. Put the FULL classroom lesson there.",
    "suggestedComment must sound like a teammate (concrete, conversational) — NOT a compressed “Could we…?” scanner line, and NOT a fixed “Hm… interesting.” opener on every finding.",
    "understood/details answer the triage reviewer; suggestedComment is for the PR author.",
    "Never return [] or a findings array.",
    "Do not modify repository files.",
  ].join(" ");

  const { command, args } = await cliForProvider(providerId);
  const result = await execCli(command, args(instruction, repoRoot), {
    cwd: repoRoot,
    timeoutMs: 10 * 60 * 1000,
    ...createCliLogBridge(log, command),
  });
  if (result.code !== 0) {
    throw new Error(
      `recheck ${providerId} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  const rawOut = (result.stdout || "").trim();
  await writeFile(
    path.join(agentDir, `recheck-${safe}.raw.txt`),
    rawOut || "(empty stdout)",
    "utf8",
  );

  let parsed;
  try {
    parsed = parseRecheckModelResponse(rawOut, finding.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`  ⚠ parse failed (${detail}) — recovering from notes/thread/raw`);
    const draft = extractDraftCommentFromNotes(userPrompt);
    const prior = finding.rechecks?.find((r) => r.suggestedComment?.trim())
      ?.suggestedComment;
    const salvagedTeach = finalizeTeachMe(extractTeachMeLoose(rawOut));
    const salvagedComment = extractSuggestedCommentLoose(rawOut);
    if (
      !notesWantPasteComment(userPrompt) &&
      !notesWantTeachMe(userPrompt) &&
      !draft &&
      !prior &&
      !salvagedTeach
    ) {
      throw error instanceof Error ? error : new Error(detail);
    }
    parsed = {
      understood: notesWantTeachMe(userPrompt)
        ? "You want a deep teammate-style walkthrough of this finding."
        : "You want paste-ready wording for this finding (model reply was unusable).",
      conclusion: salvagedTeach
        ? "Stand — lesson recovered from model prose after JSON parse failed."
        : "Stand — finding still valid; synthesized suggestedComment from your notes/prior thread.",
      details: `Parser recovery after: ${detail}`,
      ...(salvagedTeach ? { teachMe: salvagedTeach } : {}),
      ...(salvagedComment || draft || prior
        ? {
            suggestedComment: (
              salvagedComment ||
              draft ||
              prior ||
              ""
            ).slice(0, 4_000),
          }
        : {}),
    };
  }

  log(`  understood: ${parsed.understood}`);
  log(`  conclusion: ${parsed.conclusion}`);
  if (parsed.suggestedComment) {
    log(`  suggestedComment: ${parsed.suggestedComment.slice(0, 120)}`);
  }
  const applied = applyRecheckToRun(run, finding.id, parsed, {
    userAsked: userPrompt,
    provider: providerId,
  });
  log(`✓ recheck ${applied.action} — ${applied.note}`);
  return applied;
}
