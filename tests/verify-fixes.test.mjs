import assert from "node:assert/strict";
import test from "node:test";
import {
  matchFindingsToThreads,
  parseVerifyModelResponse,
  scoreFindingThread,
} from "../packages/core/dist/verify-fixes.js";

const finding = {
  id: "correctness:src/auth.ts:42",
  kind: "issue",
  file: "src/auth.ts",
  line: 42,
  severity: "major",
  category: "correctness",
  confidence: 0.9,
  importance: 8,
  currentCode: "return user.email;",
  issueSimple: "Can crash on null user",
  whyWeak: "user may be null",
  howToFix: "Guard null",
  betterCode: "if (!user) throw e;\nreturn user.email;",
  reviewComment: "Could we guard null here?",
  evidence: [],
  githubCommentTarget: { target: "line", reason: "single line" },
  language: "ts",
  disposition: "open",
};

test("scoreFindingThread prefers same file+nearby line", () => {
  const thread = {
    id: "1",
    file: "src/auth.ts",
    line: 44,
    messages: [{ id: "1", author: "bot", body: "guard null user" }],
    excerpt: "@bot: guard null user",
  };
  const other = {
    id: "2",
    file: "src/other.ts",
    line: 10,
    messages: [{ id: "2", author: "bot", body: "unrelated" }],
    excerpt: "@bot: unrelated",
  };
  assert.ok(scoreFindingThread(finding, thread) > scoreFindingThread(finding, other));
});

test("matchFindingsToThreads pairs once and leaves unmatched", () => {
  const threads = [
    {
      id: "10",
      file: "src/auth.ts",
      line: 42,
      messages: [
        { id: "10", author: "reviewer", body: "Could we guard null here?" },
        { id: "11", author: "author", body: "Fixed with optional chaining" },
      ],
      excerpt: "@reviewer: Could we guard null here?\n---\n@author: Fixed",
    },
    {
      id: "20",
      file: "src/orphan.ts",
      line: 1,
      messages: [{ id: "20", author: "x", body: "orphan thread" }],
      excerpt: "@x: orphan thread",
    },
  ];
  const { pairs, unmatchedThreads } = matchFindingsToThreads([finding], threads);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.thread?.id, "10");
  assert.equal(unmatchedThreads.length, 1);
  assert.equal(unmatchedThreads[0]?.id, "20");
});

test("parseVerifyModelResponse reads fenced json", () => {
  const parsed = parseVerifyModelResponse(`Sure:
\`\`\`json
{"status":"resolved","summary":"Author guarded null.","betterThanSuggested":true}
\`\`\``);
  assert.equal(parsed.status, "resolved");
  assert.match(parsed.summary, /guarded/i);
  assert.equal(parsed.betterThanSuggested, true);
});

test("parseBatchVerifyModelResponse reads array", async () => {
  const { parseBatchVerifyModelResponse } = await import(
    "../packages/core/dist/verify-fixes.js"
  );
  const parsed = parseBatchVerifyModelResponse(`\`\`\`json
[
  {"findingId":"a","status":"resolved","summary":"fixed"},
  {"findingId":"b","status":"still_open","summary":"not yet"}
]
\`\`\``);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.findingId, "a");
  assert.equal(parsed[1]?.status, "still_open");
});
