import assert from "node:assert/strict";
import test from "node:test";
import { applyRecheckToRun } from "../packages/core/dist/reverify.js";

function baseFinding(overrides = {}) {
  return {
    id: "nitpick-1",
    kind: "issue",
    file: "a.ts",
    line: 10,
    severity: "minor",
    category: "duplication",
    confidence: 0.9,
    importance: 5,
    currentCode: "x",
    issueSimple: "Duped helper.",
    whyWeak: "Two copies.",
    howToFix: "Share one.",
    betterCode: "shared()",
    reviewComment: "Could we share this?",
    evidence: [{ quote: "x" }],
    githubCommentTarget: { target: "line", reason: "here" },
    autofixPossible: false,
    views: [
      { model: "cursor", stance: "new", note: "found" },
      { model: "claude", stance: "agree", note: "same" },
    ],
    language: "ts",
    disposition: "open",
    ...overrides,
  };
}

function baseRun(finding) {
  return {
    prNumber: 40,
    createdAt: new Date().toISOString(),
    demo: false,
    knowledgeDocs: {},
    findings: [finding],
    passResults: [],
  };
}

test("applyRecheckToRun keeps existing views when model returns stance stand", () => {
  const existing = baseFinding();
  const run = baseRun(existing);
  const result = applyRecheckToRun(
    run,
    existing.id,
    {
      understood: "checking",
      conclusion: "stands",
      incoming: {
        ...existing,
        issueSimple: "Still duplicated.",
        views: [
          { model: "cursor", stance: "stand", note: "still valid" },
          { model: "x", stance: "stand", note: "y" },
        ],
      },
    },
    { userAsked: "does this still make sense?", provider: "cursor" },
  );

  assert.equal(result.finding.views.length, 2);
  assert.equal(result.finding.views[0].stance, "new");
  assert.equal(result.finding.views[1].stance, "agree");
  assert.equal(result.finding.issueSimple, "Still duplicated.");
  assert.equal(result.action, "update");
});
