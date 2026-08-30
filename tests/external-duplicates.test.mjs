import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTERNAL_MATCH_MIN_SCORE,
  applyExternalMatchesToRun,
  matchFindingsToExternalThreads,
  parseExternalMatchModelResponse,
  scoreExternalMatch,
  toExternalMatch,
} from "../packages/core/dist/external-duplicates.js";

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
  whyWeak: "user may be null and this dereferences it directly",
  howToFix: "Guard null before reading email",
  betterCode: "if (!user) throw e;\nreturn user.email;",
  reviewComment: "Could we guard against a null user here before reading email?",
  evidence: [],
  githubCommentTarget: { target: "line", reason: "single line" },
  language: "ts",
  disposition: "open",
  views: [],
  rechecks: [],
  verifications: [],
};

test("scoreExternalMatch requires same file, nearby line, AND text overlap", () => {
  const onTopic = {
    id: "1",
    file: "src/auth.ts",
    line: 42,
    messages: [{ id: "1", author: "coderabbitai[bot]", body: "guard against null user before reading email" }],
    excerpt: "@coderabbitai[bot]: guard against null user before reading email",
  };
  const wrongFile = {
    id: "2",
    file: "src/other.ts",
    line: 42,
    messages: [{ id: "2", author: "bot", body: "guard against null user before reading email" }],
    excerpt: "@bot: guard against null user before reading email",
  };
  const tooFar = {
    id: "3",
    file: "src/auth.ts",
    line: 200,
    messages: [{ id: "3", author: "bot", body: "guard against null user before reading email" }],
    excerpt: "@bot: guard against null user before reading email",
  };
  const nearbyButUnrelated = {
    id: "4",
    file: "src/auth.ts",
    line: 43,
    messages: [{ id: "4", author: "bot", body: "please rename this variable for clarity" }],
    excerpt: "@bot: please rename this variable for clarity",
  };

  assert.ok(scoreExternalMatch(finding, onTopic) >= EXTERNAL_MATCH_MIN_SCORE);
  assert.equal(scoreExternalMatch(finding, wrongFile), 0);
  assert.equal(scoreExternalMatch(finding, tooFar), 0);
  assert.equal(scoreExternalMatch(finding, nearbyButUnrelated), 0);
});

test("matchFindingsToExternalThreads skips praise, false_alarm, and already-checked findings", () => {
  const thread = {
    id: "1",
    file: "src/auth.ts",
    line: 42,
    messages: [{ id: "1", author: "reviewer", body: "guard against null user before reading email" }],
    excerpt: "@reviewer: guard against null user before reading email",
  };

  const openMatch = matchFindingsToExternalThreads([finding], [thread]);
  assert.equal(openMatch.length, 1);
  assert.equal(openMatch[0].finding.id, finding.id);
  assert.equal(openMatch[0].thread.id, "1");

  const praise = { ...finding, kind: "praise" };
  assert.equal(matchFindingsToExternalThreads([praise], [thread]).length, 0);

  const falseAlarm = { ...finding, disposition: "false_alarm" };
  assert.equal(matchFindingsToExternalThreads([falseAlarm], [thread]).length, 0);

  const alreadyChecked = {
    ...finding,
    externalMatch: {
      author: "reviewer",
      threadExcerpt: "already looked at this",
      score: 0.9,
      action: "skip",
      checkedAt: new Date().toISOString(),
      provider: "cursor",
    },
  };
  assert.equal(matchFindingsToExternalThreads([alreadyChecked], [thread]).length, 0);
});

test("parseExternalMatchModelResponse reads fenced json and drops orphan followUpComment", () => {
  const parsed = parseExternalMatchModelResponse(`\`\`\`json
[
  {"findingId":"a","action":"skip"},
  {"findingId":"b","action":"follow_up","followUpComment":"Also worth checking the retry path"},
  {"findingId":"c","action":"follow_up"}
]
\`\`\``);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].findingId, "a");
  assert.equal(parsed[0].action, "skip");
  assert.equal(parsed[1].action, "follow_up");
  assert.match(parsed[1].followUpComment, /retry path/);
  // action=follow_up with no comment text isn't a usable follow-up — falls back to skip.
  assert.equal(parsed[2].action, "skip");
});

test("toExternalMatch + applyExternalMatchesToRun merge into the run's findings", () => {
  const thread = {
    id: "1",
    file: "src/auth.ts",
    line: 42,
    url: "https://github.com/org/repo/pull/1#discussion_r1",
    messages: [{ id: "1", author: "reviewer", body: "guard against null user before reading email" }],
    excerpt: "@reviewer: guard against null user before reading email",
  };
  const match = toExternalMatch(
    { action: "follow_up", followUpComment: "Also handle the retry path" },
    { provider: "cursor", thread, score: 0.7 },
  );
  assert.equal(match.author, "reviewer");
  assert.equal(match.action, "follow_up");
  assert.equal(match.followUpComment, "Also handle the retry path");

  const run = {
    prNumber: 1,
    createdAt: new Date().toISOString(),
    demo: false,
    load: {
      source: "pr",
      additions: 0,
      deletions: 0,
      files: [],
      diffTruncated: false,
    },
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
      score: 50,
    },
    knowledgeDocs: {},
    findings: [finding],
    passResults: [],
  };
  const byId = new Map([[finding.id, match]]);
  const next = applyExternalMatchesToRun(run, byId);
  assert.equal(next.findings[0].externalMatch?.action, "follow_up");
  assert.equal(next.findings[0].externalMatch?.url, thread.url);
  // follow_up still needs a comment posted — stays in the open queue.
  assert.equal(next.findings[0].disposition, "open");
});

test("a skip match flips disposition to fixed (drops out of the open queue) — follow_up does not", async () => {
  const { isFindingOpen } = await import("../packages/schemas/dist/index.js");
  const thread = {
    id: "1",
    file: "src/auth.ts",
    line: 42,
    messages: [{ id: "1", author: "reviewer", body: "guard against null user before reading email" }],
    excerpt: "@reviewer: guard against null user before reading email",
  };
  const skipMatch = toExternalMatch(
    { action: "skip" },
    { provider: "cursor", thread, score: 0.7 },
  );
  const run = {
    prNumber: 1,
    createdAt: new Date().toISOString(),
    demo: false,
    load: { source: "pr", additions: 0, deletions: 0, files: [], diffTruncated: false },
    judge: {
      readiness: "needs_changes",
      topReasons: ["x"],
      counts: { blocker: 0, major: 1, minor: 0, nit: 0, suggestion: 0, question: 0, praise: 0 },
      score: 50,
    },
    knowledgeDocs: {},
    findings: [finding],
    passResults: [],
  };
  const skipped = applyExternalMatchesToRun(run, new Map([[finding.id, skipMatch]]));
  assert.equal(skipped.findings[0].disposition, "fixed");
  assert.equal(isFindingOpen(skipped.findings[0]), false);

  const followUpMatch = toExternalMatch(
    { action: "follow_up", followUpComment: "Also check the retry path" },
    { provider: "cursor", thread, score: 0.7 },
  );
  const followedUp = applyExternalMatchesToRun(run, new Map([[finding.id, followUpMatch]]));
  assert.equal(followedUp.findings[0].disposition, "open");
  assert.equal(isFindingOpen(followedUp.findings[0]), true);
});
