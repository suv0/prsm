import assert from "node:assert/strict";
import test from "node:test";
import { filterFindingsByEvidence } from "../packages/core/dist/evidence.js";

test("removes findings with no evidence and no code", () => {
  const result = filterFindingsByEvidence([
    {
      id: "x",
      kind: "issue",
      file: "",
      line: 1,
      severity: "major",
      category: "correctness",
      confidence: 0.9,
      importance: 8,
      currentCode: "",
      issueSimple: "bad",
      whyWeak: "because",
      howToFix: "fix",
      betterCode: "ok",
      reviewComment: "please",
      evidence: [],
      githubCommentTarget: { target: "line", reason: "x" },
      autofixPossible: false,
      views: [],
      language: "ts",
    },
  ]);
  assert.equal(result.kept.length, 0);
  assert.equal(result.removed.length, 1);
});

test("demotes high-importance low-confidence issues to questions", () => {
  const result = filterFindingsByEvidence([
    {
      id: "y",
      kind: "issue",
      file: "a.ts",
      line: 3,
      severity: "blocker",
      category: "security",
      confidence: 0.4,
      importance: 10,
      currentCode: "eval(x)",
      issueSimple: "maybe eval",
      whyWeak: "unclear",
      howToFix: "avoid",
      betterCode: "parse(x)",
      reviewComment: "Is eval intentional?",
      evidence: [{ quote: "eval(x)", file: "a.ts", line: 3 }],
      githubCommentTarget: { target: "line", reason: "x" },
      autofixPossible: false,
      views: [],
      language: "ts",
    },
  ]);
  assert.equal(result.kept[0]?.kind, "question");
  assert.equal(result.demoted.length, 1);
});
