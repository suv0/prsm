import type { PrOverview, ReviewRun } from "@review-os/schemas";

export function overviewFromRun(run: ReviewRun): PrOverview | undefined {
  return run.overview;
}

export function renderOverviewMarkdown(overview: PrOverview): string[] {
  const lines = [
    "## PR overview",
    "",
    overview.summary,
    "",
  ];
  if (overview.whatChanged.length > 0) {
    lines.push("### What changed", "", ...overview.whatChanged.map((item) => `- ${item}`), "");
  }
  if (overview.mainRisks.length > 0) {
    lines.push("### What to watch", "", ...overview.mainRisks.map((item) => `- ${item}`), "");
  }
  if (overview.testFocus.length > 0) {
    lines.push("### Test focus", "", ...overview.testFocus.map((item) => `- ${item}`), "");
  }
  if (overview.provider) {
    lines.push(`_Overview by \`${overview.provider}\`_`, "");
  }
  return lines;
}

export function renderOverviewHtml(
  overview: PrOverview,
  escapeHtml: (value: string) => string,
): string {
  const list = (items: string[]) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";

  return `<section class="summary overview">
      <h2>PR overview</h2>
      <p>${escapeHtml(overview.summary)}</p>
      ${
        overview.whatChanged.length
          ? `<h3>What changed</h3>${list(overview.whatChanged)}`
          : ""
      }
      ${
        overview.mainRisks.length
          ? `<h3>What to watch</h3>${list(overview.mainRisks)}`
          : ""
      }
      ${
        overview.testFocus.length
          ? `<h3>Test focus</h3>${list(overview.testFocus)}`
          : ""
      }
      ${
        overview.provider
          ? `<p class="hint" style="margin:0">Overview by <code>${escapeHtml(overview.provider)}</code></p>`
          : ""
      }
    </section>`;
}
