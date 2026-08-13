import { createHash } from "node:crypto";

/**
 * Build a GitHub PR Changes URL for a finding's file + lines.
 * Example:
 * https://github.com/org/repo/pull/41/changes#diff-<sha256>R105-R117
 *
 * The hash is SHA-256 of the repo-relative file path (GitHub's PR diff anchor).
 * `R` = right side (new/head) line numbers — what review findings refer to.
 */
export function githubFileUrl(options: {
  prUrl?: string;
  /** Unused for PR links; kept for call-site compatibility. */
  head?: string;
  file: string;
  line: number;
  endLine?: number;
}): string | null {
  const prUrl = options.prUrl?.trim();
  if (!prUrl) return null;

  const match = prUrl.match(
    /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i,
  );
  if (!match) return null;

  const [, origin, owner, repo, prNumber] = match;
  const filePath = options.file.replace(/^\/+/, "").replaceAll("\\", "/");
  if (!filePath) return null;

  const diffHash = createHash("sha256").update(filePath).digest("hex");
  let anchor = `diff-${diffHash}R${options.line}`;
  if (
    options.endLine !== undefined &&
    options.endLine !== options.line
  ) {
    anchor += `-R${options.endLine}`;
  }

  return `${origin}/${owner}/${repo}/pull/${prNumber}/changes#${anchor}`;
}
