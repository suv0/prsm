import { readFile, writeFile } from "node:fs/promises";
import { renderFinalReviewHtml } from "../packages/render/dist/html.js";

const pr = process.argv[2] ?? "22";
const runPath = `reviews/${pr}/run.json`;
const outPath = `reviews/${pr}/final-review.html`;
const run = JSON.parse(await readFile(runPath, "utf8"));
const html = renderFinalReviewHtml(run);

if (/TABLE class="tok-/.test(html) || /class ="tok-/.test(html)) {
  console.error("Highlighter still leaking into visible text");
  process.exit(1);
}

await writeFile(outPath, html, "utf8");
console.log(`updated ${outPath}`);
