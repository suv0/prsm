import { z } from "zod";
import {
  explainGithubApiError,
  GithubApiError,
  githubGetJson,
  githubGetText,
  githubPaginateJson,
} from "./api.js";
import { resolveGithubToken } from "./auth.js";
import { commandExists, execOrThrow } from "./exec.js";
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

const RestPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  additions: z.number().int().optional().default(0),
  deletions: z.number().int().optional().default(0),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
});

const RestFileSchema = z.object({
  filename: z.string(),
  additions: z.number().int().optional().default(0),
  deletions: z.number().int().optional().default(0),
  status: z.string().optional().default("modified"),
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

export function mapGithubRestPull(input: {
  ref: ParsedPrRef;
  pr: {
    number: number;
    title: string;
    html_url: string;
    additions: number;
    deletions: number;
    base: { ref: string };
    head: { ref: string };
  };
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  diff: string;
  diffTruncated: boolean;
}): LoadedPullRequest {
  return {
    ref: input.ref,
    number: input.pr.number,
    title: input.pr.title,
    url: input.pr.html_url,
    base: input.pr.base.ref,
    head: input.pr.head.ref,
    additions: input.pr.additions,
    deletions: input.pr.deletions,
    files: input.files.map((file) => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: (file.status || "modified").toUpperCase(),
    })),
    diff: input.diff,
    diffTruncated: input.diffTruncated,
  };
}

async function fetchPullRequestViaApi(
  ref: ParsedPrRef,
  token: string | undefined,
): Promise<LoadedPullRequest> {
  const repo = `${ref.owner}/${ref.repo}`;
  const prRaw = await githubGetJson(
    `/repos/${repo}/pulls/${ref.number}`,
    token,
  );
  const pr = RestPrSchema.parse(prRaw);
  const files = (
    await githubPaginateJson(
      `/repos/${repo}/pulls/${ref.number}/files?per_page=100`,
      token,
      RestFileSchema,
    )
  ).map((file) => ({
    filename: file.filename,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    status: file.status ?? "modified",
  }));

  let diff = "";
  let diffTruncated = false;
  try {
    diff = await githubGetText(
      `/repos/${repo}/pulls/${ref.number}`,
      token,
      "application/vnd.github.diff",
    );
    if (diff.length > DIFF_CHAR_LIMIT) {
      diff = diff.slice(0, DIFF_CHAR_LIMIT);
      diffTruncated = true;
    }
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 406) {
      diffTruncated = true;
      diff = "";
    } else {
      throw error;
    }
  }

  return mapGithubRestPull({
    ref,
    pr: {
      number: pr.number,
      title: pr.title,
      html_url: pr.html_url,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      base: { ref: pr.base.ref },
      head: { ref: pr.head.ref },
    },
    files,
    diff,
    diffTruncated,
  });
}

async function fetchPullRequestViaGh(
  ref: ParsedPrRef,
): Promise<LoadedPullRequest> {
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

export async function fetchPullRequest(
  input: string,
): Promise<LoadedPullRequest> {
  const ref = parsePrRef(input);
  const repo = `${ref.owner}/${ref.repo}`;
  const { token } = await resolveGithubToken();

  if (token) {
    try {
      return await fetchPullRequestViaApi(ref, token);
    } catch (error) {
      throw new Error(explainGithubApiError(error, repo));
    }
  }

  try {
    return await fetchPullRequestViaApi(ref, undefined);
  } catch (error) {
    if (await commandExists("gh")) {
      try {
        return await fetchPullRequestViaGh(ref);
      } catch (ghError) {
        const api = explainGithubApiError(error, repo);
        const gh = ghError instanceof Error ? ghError.message : String(ghError);
        throw new Error(`${api}\n(gh fallback: ${gh.slice(0, 200)})`);
      }
    }
    throw new Error(explainGithubApiError(error, repo));
  }
}
