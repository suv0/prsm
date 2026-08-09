export interface ParsedPrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const PR_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/)?(?:[?#].*)?$/i;

/**
 * Parse a GitHub pull request URL into owner/repo/number.
 * Also accepts `owner/repo#123` shorthand.
 */
export function parsePrRef(input: string): ParsedPrRef {
  const trimmed = input.trim();

  const urlMatch = trimmed.match(PR_URL_RE);
  if (urlMatch) {
    const owner = urlMatch[1];
    const repo = urlMatch[2];
    const number = Number(urlMatch[3]);
    if (!owner || !repo || !Number.isFinite(number)) {
      throw new Error(`Invalid PR URL: ${input}`);
    }
    return {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    };
  }

  const shortMatch = trimmed.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)$/);
  if (shortMatch) {
    const owner = shortMatch[1];
    const repo = shortMatch[2];
    const number = Number(shortMatch[3]);
    if (!owner || !repo || !Number.isFinite(number)) {
      throw new Error(`Invalid PR shorthand: ${input}`);
    }
    return {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    };
  }

  throw new Error(
    `Could not parse PR reference: ${input}\n` +
      "Expected https://github.com/owner/repo/pull/123 or owner/repo#123",
  );
}
