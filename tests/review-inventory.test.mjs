import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listReviewSummaries,
  setReviewHubStatus,
} from "../apps/cli/dist/review-inventory.js";

test("listReviewSummaries derives status and respects awaiting_author", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prsm-reviews-"));
  const dir = path.join(root, "42");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "run.json"),
    JSON.stringify({
      prNumber: 42,
      title: "Demo PR",
      createdAt: "2026-08-09T12:00:00.000Z",
      findings: [
        {
          id: "a",
          kind: "issue",
          file: "a.ts",
          line: 1,
          severity: "major",
          category: "correctness",
          confidence: 0.9,
          importance: 8,
          currentCode: "x",
          issueSimple: "bad",
          whyWeak: "why",
          howToFix: "fix",
          betterCode: "y",
          reviewComment: "please",
          evidence: [],
          githubCommentTarget: { target: "line", reason: "x" },
          language: "ts",
          disposition: "open",
        },
      ],
      judge: {
        readiness: "needs_changes",
        topReasons: ["x"],
        counts: {
          blocker: 0,
          major: 1,
          minor: 0,
          nit: 0,
          suggestion: 0,
          question: 0,
          praise: 0,
        },
      },
      passResults: [],
    }),
    "utf8",
  );
  await writeFile(path.join(dir, "triage.html"), "<html></html>", "utf8");

  let list = await listReviewSummaries(root);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.prNumber, 42);
  assert.equal(list[0]?.status, "needs_triage");
  assert.equal(list[0]?.href, "/pr/42/");

  await setReviewHubStatus(root, 42, { status: "awaiting_author", note: "posted comments" });
  list = await listReviewSummaries(root);
  assert.equal(list[0]?.status, "awaiting_author");
  assert.equal(list[0]?.note, "posted comments");
});
