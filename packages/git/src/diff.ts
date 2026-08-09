import { execOrThrow } from "@review-os/github";

export interface BranchCompareInput {
  base: string;
  head: string;
  cwd: string;
}

export interface BranchCompareResult {
  base: string;
  head: string;
  files: string[];
  diff: string;
  diffTruncated: boolean;
  /** Synthetic PR number placeholder for folder naming when no PR exists. */
  syntheticPrNumber: number;
}

const DIFF_CHAR_LIMIT = 1_500_000;

function hashToPositiveInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return (hash % 900_000) + 100_000;
}

export async function compareBranches(
  input: BranchCompareInput,
): Promise<BranchCompareResult> {
  const range = `${input.base}...${input.head}`;

  const nameOnly = await execOrThrow(
    "git",
    ["diff", "--name-only", range],
    { cwd: input.cwd },
  );
  const files = nameOnly
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let diff = await execOrThrow("git", ["diff", "--find-renames", range], {
    cwd: input.cwd,
    maxBuffer: DIFF_CHAR_LIMIT + 1024,
  });
  let diffTruncated = false;
  if (diff.length > DIFF_CHAR_LIMIT) {
    diff = diff.slice(0, DIFF_CHAR_LIMIT);
    diffTruncated = true;
  }

  return {
    base: input.base,
    head: input.head,
    files,
    diff,
    diffTruncated,
    syntheticPrNumber: hashToPositiveInt(`${input.base}:${input.head}`),
  };
}
