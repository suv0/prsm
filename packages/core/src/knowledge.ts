import type { SignalReport } from "./signals.js";

export interface KnowledgeInput {
  prNumber: number;
  title: string;
  base?: string;
  head?: string;
  changedFiles: string[];
  signals: SignalReport;
  additions?: number;
  deletions?: number;
}

export interface KnowledgePack {
  /** filename -> markdown body */
  docs: Record<string, string>;
}

function topDirs(files: string[], limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const parts = normalized.split("/");
    const key = parts.length > 1 ? `${parts[0]}/` : "./";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name} (${count} files)`);
}

export function buildKnowledgePack(input: KnowledgeInput): KnowledgePack {
  const docs: Record<string, string> = {};
  const filePreview = input.changedFiles.slice(0, 40);

  docs["project.md"] = [
    `# Project context — PR #${input.prNumber}`,
    "",
    `**Title:** ${input.title}`,
    input.base && input.head ? `**Branches:** \`${input.base}\` ← \`${input.head}\`` : "",
    `**Changed files:** ${input.changedFiles.length}`,
    input.additions !== undefined ? `**Additions:** +${input.additions}` : "",
    input.deletions !== undefined ? `**Deletions:** -${input.deletions}` : "",
    "",
    "## Top areas touched",
    "",
    ...topDirs(input.changedFiles).map((line) => `- ${line}`),
    "",
    "## Detected signals",
    "",
    ...(input.signals.signals.length
      ? input.signals.signals.map((signal) => `- ${signal}`)
      : ["- none"]),
    "",
  ]
    .filter(Boolean)
    .join("\n");

  docs["architecture.md"] = [
    `# Architecture notes — PR #${input.prNumber}`,
    "",
    "Generated from changed paths (heuristic, not a full architecture audit).",
    "",
    "## Likely layers in this diff",
    "",
    input.signals.signals.includes("next") || input.signals.signals.includes("react")
      ? "- Frontend / UI layer touched"
      : "- No clear UI layer signal",
    input.signals.signals.includes("api")
      ? "- API / server layer touched"
      : "- No clear API layer signal",
    input.signals.signals.includes("database")
      ? "- Database / persistence layer touched"
      : "- No database signal",
    input.signals.signals.includes("content")
      ? "- Content / publishing layer touched"
      : "- No content signal",
    "",
    "## Files (sample)",
    "",
    ...filePreview.map((file) => `- \`${file}\``),
    input.changedFiles.length > filePreview.length
      ? `- … +${input.changedFiles.length - filePreview.length} more`
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  if (
    input.signals.signals.includes("react") ||
    input.signals.signals.includes("next")
  ) {
    const componentFiles = input.changedFiles.filter((file) =>
      /\.(tsx|jsx)$/.test(file) || /components?\//i.test(file),
    );
    docs["components.md"] = [
      `# Components — PR #${input.prNumber}`,
      "",
      `UI-related files in this diff: **${componentFiles.length}**`,
      "",
      ...componentFiles.slice(0, 60).map((file) => `- \`${file}\``),
      "",
    ].join("\n");
  }

  if (input.signals.signals.includes("next")) {
    const routeFiles = input.changedFiles.filter((file) =>
      /(^|\/)app\/|(^|\/)pages\//i.test(file.replaceAll("\\", "/")),
    );
    docs["routing.md"] = [
      `# Routing / Next.js — PR #${input.prNumber}`,
      "",
      "App Router / Pages files touched:",
      "",
      ...(routeFiles.length
        ? routeFiles.map((file) => `- \`${file}\``)
        : ["- No explicit `app/` or `pages/` files; Next signal came from package/config paths."]),
      "",
    ].join("\n");
  }

  if (input.signals.signals.includes("api")) {
    docs["api.md"] = [
      `# API — PR #${input.prNumber}`,
      "",
      "API/server-related paths detected in this PR.",
      "",
      ...input.changedFiles
        .filter((file) =>
          /(api|server|backend|route\.(ts|js)|controller|handler)/i.test(file),
        )
        .slice(0, 60)
        .map((file) => `- \`${file}\``),
      "",
    ].join("\n");
  }

  if (input.signals.signals.includes("content")) {
    docs["content.md"] = [
      `# Content — PR #${input.prNumber}`,
      "",
      "Markdown/MDX/content files dominate or appear in this diff.",
      "",
      ...input.changedFiles
        .filter((file) => /\.(md|mdx)$/i.test(file) || /content\//i.test(file))
        .slice(0, 80)
        .map((file) => `- \`${file}\``),
      "",
    ].join("\n");
  }

  if (input.signals.signals.includes("database")) {
    docs["dependencies.md"] = [
      `# Data / dependencies — PR #${input.prNumber}`,
      "",
      "Database-related paths were detected. Review schema and migration safety carefully.",
      "",
      ...input.changedFiles
        .filter((file) =>
          /prisma|drizzle|sql|migration|schema/i.test(file),
        )
        .map((file) => `- \`${file}\``),
      "",
    ].join("\n");
  }

  return { docs };
}
