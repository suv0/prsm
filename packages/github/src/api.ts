import { z } from "zod";

const API_ROOT = "https://api.github.com";
const USER_AGENT = "PRism-prsm";

export class GithubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
    this.body = body;
  }
}

function authHeaders(token?: string, accept?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept ?? "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    const href = match?.[1];
    if (href) return href;
  }
  return undefined;
}

export function parseGithubNextLink(link: string | null): string | undefined {
  return nextLink(link);
}

async function githubRequest(options: {
  url: string;
  token?: string;
  accept?: string;
}): Promise<{ status: number; text: string; link: string | null }> {
  const res = await fetch(options.url, {
    headers: authHeaders(options.token, options.accept),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    link: res.headers.get("link"),
  };
}

function toUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${API_ROOT}${path}`;
}

export async function githubGetJson(
  pathOrUrl: string,
  token: string | undefined,
): Promise<unknown> {
  const { status, text } = await githubRequest({
    url: toUrl(pathOrUrl),
    ...(token ? { token } : {}),
  });
  if (status < 200 || status >= 300) {
    throw new GithubApiError(
      status,
      text,
      `GitHub API ${status}: ${text.slice(0, 240)}`,
    );
  }
  return JSON.parse(text) as unknown;
}

export async function githubGetText(
  pathOrUrl: string,
  token: string | undefined,
  accept: string,
): Promise<string> {
  const { status, text } = await githubRequest({
    url: toUrl(pathOrUrl),
    accept,
    ...(token ? { token } : {}),
  });
  if (status < 200 || status >= 300) {
    throw new GithubApiError(
      status,
      text,
      `GitHub API ${status}: ${text.slice(0, 240)}`,
    );
  }
  return text;
}

export async function githubPaginateJson<T>(
  pathOrUrl: string,
  token: string | undefined,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = toUrl(pathOrUrl);
  while (url) {
    const { status, text, link } = await githubRequest({
      url,
      ...(token ? { token } : {}),
    });
    if (status < 200 || status >= 300) {
      throw new GithubApiError(
        status,
        text,
        `GitHub API ${status}: ${text.slice(0, 240)}`,
      );
    }
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) out.push(schema.parse(item));
    url = nextLink(link);
  }
  return out;
}

export function explainGithubApiError(
  error: unknown,
  repo?: string,
): string {
  const status =
    error instanceof GithubApiError
      ? error.status
      : undefined;
  if (status === 401) {
    return "GitHub token is invalid. Hub → Connect GitHub, paste a new token.";
  }
  if (status === 404) {
    return (
      `PR not found, or this is a private repo.${
        repo ? ` (${repo})` : ""
      } Hub → Connect GitHub and paste a token that can read it.`
    );
  }
  if (status === 403) {
    const body =
      error instanceof GithubApiError ? error.body : String(error);
    if (/rate limit/i.test(body)) {
      return "GitHub rate limit hit. Paste a token in the hub (Connect GitHub) for a higher limit.";
    }
    return "GitHub refused access (403). For private repos, paste a token in the hub.";
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
