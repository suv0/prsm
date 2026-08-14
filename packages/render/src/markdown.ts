import type { Finding, ReviewRun } from "@review-os/schemas";
import { renderOverviewMarkdown } from "./overview.js";

function severityLabel(severity: Finding["severity"]): string {
  switch (severity) {
    case "blocker":
      return "Blocker";
    case "major":
      return "Major";
    case "minor":
      return "Minor";
    case "nit":
      return "Nit";
    case "suggestion":
      return "Suggestion";
    case "question":
      return "Question";
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

function lineLabel(finding: Finding): string {
  if (finding.endLine && finding.endLine !== finding.line) {
    return `${finding.line}–${finding.endLine}`;
  }
  return String(finding.line);
}

function renderViews(finding: Finding): string {
  if (!finding.views.length) return "";
  const lines = finding.views.map(
    (view) =>
      `- **${view.model}** (${view.stance}): ${view.note}`,
  );
  return `

### Agent perspectives

${lines.join("\n")}
`;
}

function renderIssueCard(finding: Finding, index: number): string {
  const lang = finding.language || "ts";
  const titlePrefix =
    finding.kind === "question"
      ? "Question"
      : severityLabel(finding.severity);

  return `## Finding ${index} — ${titlePrefix}

**File:** \`${finding.file}\`  
**Line:** ${lineLabel(finding)}  
**Category:** ${finding.category}  
**Confidence:** ${Math.round(finding.confidence * 100)}% · **Importance:** ${finding.importance}/10
${renderViews(finding)}
### Current code

\`\`\`${lang}
${finding.currentCode}
\`\`\`

### Issue (simple)

${finding.issueSimple}

### Why this is weak

${finding.whyWeak}

### How to fix

${finding.howToFix}

### Better code

\`\`\`${lang}
${finding.betterCode}
\`\`\`

### Paste this comment

\`\`\`text
${finding.reviewComment}
\`\`\`
`;
}

function renderPraiseCard(finding: Finding, index: number): string {
  const lang = finding.language || "ts";
  return `## Praise ${index}

**File:** \`${finding.file}\`  
**Line:** ${lineLabel(finding)}

### What looks good

\`\`\`${lang}
${finding.currentCode}
\`\`\`

${finding.issueSimple}

### Paste this comment (optional)

\`\`\`text
${finding.reviewComment}
\`\`\`
`;
}

export function renderFinalReviewMarkdown(run: ReviewRun): string {
  const issues = run.findings.filter((f) => f.kind !== "praise");
  const praise = run.findings.filter((f) => f.kind === "praise");
  const judge = run.judge;
  const load = run.load;

  const lines: string[] = [
    `# PR #${run.prNumber} — Final Review`,
    "",
    run.title ? `**Title:** ${run.title}` : "",
    run.prUrl ? `**URL:** ${run.prUrl}` : "",
    run.base && run.head ? `**Branches:** \`${run.base}\` ← \`${run.head}\`` : "",
    run.demo ? "**Mode:** demo (fixture findings)" : "",
    load?.source === "pr" ? "**Mode:** PR load" : "",
    load?.source === "branch" ? "**Mode:** branch compare" : "",
    run.agent ? `**Agent run:** \`${run.agent}\`${run.runId ? ` (\`${run.runId}\`)` : ""}` : "",
    "",
  ];

  if (run.overview) {
    lines.push(...renderOverviewMarkdown(run.overview));
  }

  if (run.agents && run.agents.length > 0) {
    lines.push(
      "## Agent runs (merged)",
      "",
      ...run.agents.map((agent) => {
        const href = `runs/${agent.id}/triage.html`;
        return `- [\`${agent.agent}\`](${href}) · ${agent.findingCount} finding(s) · \`${agent.id}\``;
      }),
      "",
      "_Same issue from multiple agents is shown once below, with each agent's wording under **Agent perspectives**._",
      "",
    );
  }

  if (run.plan) {
    lines.push(
      "## Review plan",
      "",
      run.plan.rationale,
      "",
      "**Would run:** " +
        (run.plan.selectedPasses.length
          ? run.plan.selectedPasses.map((id) => `\`${id}\``).join(", ")
          : "_none yet (deferred)_"),
      "",
    );
    const deferred = run.plan.skippedPasses.filter((p) =>
      p.reason.toLowerCase().includes("deferred"),
    );
    if (deferred.length > 0) {
      lines.push(
        "**Planner selected (run next via chat skill or --run):** " +
          deferred.map((p) => `\`${p.id}\``).join(", "),
        "",
      );
    }
  }

  if (load) {
    lines.push(
      "## Changed files",
      "",
      `- **Files:** ${load.files.length}`,
      `- **Additions:** +${load.additions}`,
      `- **Deletions:** -${load.deletions}`,
      load.diffTruncated ? "- **Diff:** truncated (too large to store fully)" : "",
      load.note ? `- **Note:** ${load.note}` : "",
      Object.keys(run.knowledgeDocs ?? {}).length
        ? `- **Knowledge:** ${Object.keys(run.knowledgeDocs).map((name) => `\`${name}\``).join(", ")}`
        : "",
      "",
    );

    const preview = load.files.slice(0, 80);
    for (const file of preview) {
      lines.push(
        `- \`${file.path}\` (${file.changeType}, +${file.additions}/-${file.deletions})`,
      );
    }
    if (load.files.length > preview.length) {
      lines.push(
        `- …and ${load.files.length - preview.length} more (see \`run.json\`)`,
      );
    }
    lines.push("");
  }

  lines.push("## Merge readiness", "");

  if (judge) {
    lines.push(
      `- **Status:** \`${judge.readiness}\``,
      judge.score !== undefined ? `- **Score:** ${judge.score}/100` : "",
      `- **Blockers:** ${judge.counts.blocker}`,
      `- **Majors:** ${judge.counts.major}`,
      `- **Minors:** ${judge.counts.minor}`,
      `- **Nits:** ${judge.counts.nit}`,
      `- **Questions:** ${judge.counts.question}`,
      `- **Praise:** ${judge.counts.praise}`,
      "",
      "### Top reasons",
      "",
      ...(judge.topReasons.length
        ? judge.topReasons.map((reason, i) => `${i + 1}. ${reason}`)
        : ["1. No major issues in this run."]),
      "",
    );
  }

  if (issues.length === 0 && praise.length === 0) {
    lines.push(
      "---",
      "",
      "# Findings",
      "",
      "_No review findings yet._",
      "",
      "Phase 1 loaded this PR/branch successfully.",
      "Specialist AI review (correctness, nitpick, devil's advocate, …) arrives in Phase 3+.",
      "",
    );
  } else {
    lines.push("---", "", `# Findings (${issues.length})`, "");

    issues.forEach((finding, index) => {
      lines.push(renderIssueCard(finding, index + 1), "");
    });

    if (praise.length > 0) {
      lines.push("---", "", `# Things done well (${praise.length})`, "");
      praise.forEach((finding, index) => {
        lines.push(renderPraiseCard(finding, index + 1), "");
      });
    }
  }

  lines.push(
    "---",
    "",
    "_Generated by PRism. Comments are polite on purpose; analysis may be harsh._",
    "",
  );

  return lines.filter((line, index, arr) => {
    if (line === "" && arr[index - 1] === "") return false;
    return true;
  }).join("\n");
}
