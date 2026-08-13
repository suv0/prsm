import { z } from "zod";
import { execOrThrow } from "./exec.js";
import { parsePrRef, type ParsedPrRef } from "./parse.js";

const GhReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string().optional(),
  path: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  original_line: z.number().nullable().optional(),
  user: z
    .object({
      login: z.string().optional(),
    })
    .optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  in_reply_to_id: z.number().nullable().optional(),
  html_url: z.string().optional(),
});

export type GhReviewComment = {
  id: number;
  body: string;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  in_reply_to_id?: number | null;
  html_url?: string;
};

function normalizeComment(
  raw: z.infer<typeof GhReviewCommentSchema>,
): GhReviewComment {
  const out: GhReviewComment = {
    id: raw.id,
    body: raw.body ?? "",
  };
  if (raw.path !== undefined) out.path = raw.path;
  if (raw.line !== undefined) out.line = raw.line;
  if (raw.original_line !== undefined) out.original_line = raw.original_line;
  if (raw.user) {
    out.user = raw.user.login ? { login: raw.user.login } : {};
  }
  if (raw.created_at !== undefined) out.created_at = raw.created_at;
  if (raw.updated_at !== undefined) out.updated_at = raw.updated_at;
  if (raw.in_reply_to_id !== undefined) out.in_reply_to_id = raw.in_reply_to_id;
  if (raw.html_url !== undefined) out.html_url = raw.html_url;
  return out;
}

export type ReviewThreadMessage = {
  id: string;
  author: string;
  body: string;
  createdAt?: string;
  url?: string;
};

export type ReviewCommentThread = {
  id: string;
  file?: string;
  line?: number;
  url?: string;
  messages: ReviewThreadMessage[];
  excerpt: string;
};

async function ghJsonPages<T>(
  pathAndQuery: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const raw = await execOrThrow("gh", [
    "api",
    "--paginate",
    pathAndQuery,
  ]);
  // paginate joins JSON arrays; handle both single array and concatenated
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Rare: concatenating page arrays → wrap
    parsed = JSON.parse(`[${trimmed.replace(/\]\s*\[/g, ",")}]`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item) => schema.parse(item));
}

/**
 * Fetch PR review comments (inline) and group into threads by root comment.
 */
export async function fetchPrReviewThreads(
  prRef: string | ParsedPrRef,
): Promise<{ ref: ParsedPrRef; threads: ReviewCommentThread[] }> {
  const ref = typeof prRef === "string" ? parsePrRef(prRef) : prRef;
  const comments = (
    await ghJsonPages(
      `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
      GhReviewCommentSchema,
    )
  ).map(normalizeComment);

  const byId = new Map<number, GhReviewComment>();
  for (const comment of comments) byId.set(comment.id, comment);

  const children = new Map<number, GhReviewComment[]>();
  const roots: GhReviewComment[] = [];
  for (const comment of comments) {
    if (comment.in_reply_to_id) {
      const list = children.get(comment.in_reply_to_id) ?? [];
      list.push(comment);
      children.set(comment.in_reply_to_id, list);
    } else {
      roots.push(comment);
    }
  }

  const threads: ReviewCommentThread[] = roots.map((root) => {
    const replies = (children.get(root.id) ?? []).sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
    const messages: ReviewThreadMessage[] = [root, ...replies].map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "unknown",
      body: c.body,
      ...(c.created_at ? { createdAt: c.created_at } : {}),
      ...(c.html_url ? { url: c.html_url } : {}),
    }));
    const file = root.path ?? undefined;
    const line = root.line ?? root.original_line ?? undefined;
    const excerpt = messages
      .map((m) => `@${m.author}: ${m.body.trim().slice(0, 280)}`)
      .join("\n---\n")
      .slice(0, 2_000);
    return {
      id: String(root.id),
      ...(file ? { file } : {}),
      ...(line !== undefined && line !== null ? { line } : {}),
      ...(root.html_url ? { url: root.html_url } : {}),
      messages,
      excerpt,
    };
  });

  return { ref, threads };
}
