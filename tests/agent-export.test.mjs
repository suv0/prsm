import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFindingFixBrief,
  buildReviewFixBriefMarkdown,
  reviewFixBriefFilename,
} from "../packages/render/dist/agent-export.js";

const finding = {
  id: "correctness-cursor-1",
  kind: "issue",
  file: "apps/seller/lib/kyc-identity.ts",
  line: 7,
  endLine: 9,
  severity: "blocker",
  category: "documentation",
  confidence: 0.9,
  importance: 8,
  currentCode: "export function mint() {}",
  issueSimple: "Missing docs for retryable KYC errors",
  whyWeak: "Callers cannot tell which errors are safe to retry",
  howToFix: "Document retryable errors above the helper",
  betterCode: "/** Retryable… */\\nexport function mint() {}",
  reviewComment: "Could we document which KYC errors are retryable?",
  evidence: [],
  views: [],
  autofixPossible: false,
  disposition: "open",
  githubCommentTarget: { target: "line", reason: "helper" },
  language: "ts",
  verifications: [],
  rechecks: [],
};

test("buildFindingFixBrief is framed for a coding agent fix pass", () => {
  const text = buildFindingFixBrief(finding, 44);
  assert.match(text, /helping the PR author fix/i);
  assert.match(text, /File: apps\/seller\/lib\/kyc-identity\.ts/);
  assert.match(text, /Line: 7–9/);
  assert.match(text, /## How to fix/);
  assert.match(text, /## Suggested code/);
  assert.doesNotMatch(text, /stand \| update \| false alarm/i);
});

test("buildReviewFixBriefMarkdown skips praise and false alarms by default", () => {
  const md = buildReviewFixBriefMarkdown({
    prNumber: 44,
    title: "KYC remint",
    prUrl: "https://github.com/org/repo/pull/44",
    createdAt: "2026-08-15T00:00:00.000Z",
    findings: [
      finding,
      {
        ...finding,
        id: "praise-1",
        kind: "praise",
        issueSimple: "Nice helper",
      },
      {
        ...finding,
        id: "fa-1",
        disposition: "false_alarm",
        falseAlarmNote: "Already documented",
      },
    ],
  });
  assert.match(md, /# PR #44 — fix brief for coding agent/);
  assert.match(md, /Findings in this brief:\*\* 1/);
  assert.match(md, /correctness-cursor-1/);
  assert.doesNotMatch(md, /praise-1/);
  assert.doesNotMatch(md, /fa-1/);
  assert.equal(reviewFixBriefFilename(44), "pr-44-fix-brief.md");
});
