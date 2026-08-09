import { z } from "zod";
import { execOrThrow } from "./exec.js";
import { parsePrRef, type ParsedPrRef } from "./parse.js";

const GhFileSchema = z.object({
  path: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changeType: z.string(),
});

const GhPrViewSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  baseRefName: z.string(),
  headRefName: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  files: z.array(GhFileSchema).default([]),
});

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface LoadedPullRequest {
  ref: ParsedPrRef;
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  files: ChangedFile[];
  /** Unified diff text (may be truncated for huge PRs). */
  diff: string;
  diffTruncated: boolean;
}

const DIFF_CHAR_LIMIT = 1_500_000;

export async function fetchPullRequest(
  input: string,
): Promise<LoadedPullRequest> {
  const ref = parsePrRef(input);
  const repo = `${ref.owner}/${ref.repo}`;

  const viewRaw = await execOrThrow("gh", [
    "pr",
    "view",
    String(ref.number),
    "--repo",
    repo,
    "--json",
    "number,title,url,baseRefName,headRefName,files,additions,deletions",
  ]);

  const view = GhPrViewSchema.parse(JSON.parse(viewRaw));

  let diff = "";
  let diffTruncated = false;
  try {
    diff = await execOrThrow(
      "gh",
      ["pr", "diff", String(ref.number), "--repo", repo],
      { maxBuffer: DIFF_CHAR_LIMIT + 1024 },
    );
    if (diff.length > DIFF_CHAR_LIMIT) {
      diff = diff.slice(0, DIFF_CHAR_LIMIT);
      diffTruncated = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("exceeded")) {
      diffTruncated = true;
      diff = "";
    } else {
      throw error;
    }
  }

  return {
    ref,
    number: view.number,
    title: view.title,
    url: view.url,
    base: view.baseRefName,
    head: view.headRefName,
    additions: view.additions,
    deletions: view.deletions,
    files: view.files,
    diff,
    diffTruncated,
  };
}
