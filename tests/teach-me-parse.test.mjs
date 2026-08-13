import assert from "node:assert/strict";
import test from "node:test";
import {
  applyRecheckToRun,
  buildConversationalPaste,
  extractTeachMeLoose,
  finalizeTeachMe,
  normalizeTeachMeContent,
  notesWantPasteComment,
  notesWantTeachMe,
  parseRecheckModelResponse,
} from "../packages/core/dist/reverify.js";

test("notesWantTeachMe detects teach prompts and disables paste-only heuristic", () => {
  const notes =
    "Teach me this finding the way a patient teammate would — deep, not a summary.\n" +
    "8) Short human GitHub comment.";
  assert.equal(notesWantTeachMe(notes), true);
  assert.equal(notesWantPasteComment(notes), false);
});

test("extractTeachMeLoose joins teachMeLines", () => {
  const raw = JSON.stringify({
    understood: "x",
    conclusion: "y",
    teachMeLines: [
      "Yes. start() is good. resend() is not.",
      "",
      "### resend()",
      "Input: flowId=ABC",
      "What happens: SMS sends before claim",
      "Output: unlocked send",
    ],
  });
  const lesson = extractTeachMeLoose(raw);
  assert.ok(lesson);
  assert.match(lesson, /start\(\) is good/);
  assert.match(lesson, /What happens: SMS sends before claim/);
});

test("extractTeachMeLoose does not truncate at quotes inside code fences", () => {
  const prose = [
    "## Punchline",
    "Two branches throw the same way.",
    "",
    "### good branch",
    "```ts:48",
    "if (response.data.success === false) {",
    "  const { message, errorCode } = response.data;",
    '  this.logger.error("rejected");',
    "  throw new Error(message);",
    "}",
    "```",
    "",
    "### bad branch",
    "```ts:56",
    "if (messageId == null) {",
    '  throw new Error("accepted but no MessageID");',
    "}",
    "```",
    "",
    "### Memory hook",
    "Only failover when Unifonic said success:false.",
    "",
    "extra padding ".repeat(30),
  ].join("\n");

  // Broken JSON-ish wrapper that used to truncate at error("
  const messy = [
    "{",
    '  "understood": "teach",',
    '  "teachMe": "truncated early at quotes",',
    prose,
    "",
  ].join("\n");

  const lesson = extractTeachMeLoose(messy);
  assert.ok(lesson);
  assert.match(lesson, /Memory hook/);
  assert.match(lesson, /success:false/);
  assert.ok(lesson.length > 400);
});

test("parseRecheckModelResponse salvages prose lesson when JSON is missing", () => {
  const prose = [
    "Yes. start() already does the right thing. resend() does not.",
    "",
    "### start() — good",
    "Snippet: this.cooldown.claim(phone);",
    "Input: phone=+15551112222",
    "What happens: reserves the phone before SMS.",
    "Output: locked before send.",
    "",
    "### Race",
    "Request A and Request B both pass the check and both pay.",
    "",
    "### Memory hook",
    "Claim first, send second.",
  ].join("\n");
  const padded = `${prose}\n\n${"extra context ".repeat(40)}`;
  const parsed = parseRecheckModelResponse(padded, "finding-1");
  assert.ok(parsed.teachMe);
  assert.match(parsed.teachMe, /Claim first, send second/);
  assert.match(parsed.conclusion, /recovered|Stand/i);
});

test("parseRecheckModelResponse reads teachMeLines from valid JSON", () => {
  const raw = JSON.stringify({
    understood: "teach request",
    conclusion: "stands",
    teachMeLines: [
      "Punchline: start claims first; resend sends first.",
      "Input: flowId=ABC123",
      "What happens: await resendCode pays for SMS",
      "Output: claim still missing",
    ],
    suggestedComment: "Could we claim before resendCode?",
  });
  const parsed = parseRecheckModelResponse(raw, "finding-1");
  assert.ok(parsed.teachMe);
  assert.match(parsed.teachMe, /Punchline/);
  assert.match(parsed.teachMe, /What happens/);
  assert.equal(parsed.suggestedComment, "Could we claim before resendCode?");
});

test("normalizeTeachMeContent recovers lesson from prose + json dump with nested fences", () => {
  const lessonLines = [
    "# Punchline",
    "Two throws live in UnifonicSmsAdapter.send().",
    "",
    "### Good branch",
    "```ts:48",
    "if (response.data.success === false) {",
    '  this.logger.error("rejected");',
    "  throw new Error(message);",
    "}",
    "```",
    "",
    "### Bad branch",
    "```ts:56",
    "if (messageId == null) {",
    '  throw new Error("accepted but no MessageID");',
    "}",
    "```",
    "",
    "### Memory hook",
    "Only failover when Unifonic said success:false.",
  ];
  const dump = [
    "Verified the actual PR diff — both confirmed. Here's the recheck.",
    "",
    "```json",
    JSON.stringify(
      {
        understood: "Walk me through the Unifonic throw",
        conclusion: "Stand — failover is unsafe for missing MessageID",
        teachMeLines: lessonLines,
        suggestedComment: "Hm... interesting.",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  const lesson = normalizeTeachMeContent(dump);
  assert.ok(lesson);
  assert.doesNotMatch(lesson, /teachMeLines/);
  assert.doesNotMatch(lesson, /```json/i);
  assert.match(lesson, /Memory hook/);
  assert.match(lesson, /success:false/);
  assert.match(lesson, /```ts:48/);
  assert.match(lesson, /```ts:56/);

  const finalized = finalizeTeachMe(dump);
  assert.equal(finalized, lesson);

  const parsed = parseRecheckModelResponse(dump, "finding-1");
  assert.ok(parsed.teachMe);
  assert.match(parsed.teachMe, /Punchline/);
  assert.doesNotMatch(parsed.teachMe, /"understood"/);
});

test("applyRecheckToRun rewrites formal Could we paste on Teach me notes", () => {
  const finding = {
    id: "correctness-1",
    kind: "issue",
    file: "services/backend/src/sms/adapters/unifonic-sms.adapter.ts",
    line: 56,
    severity: "major",
    category: "error-handling",
    confidence: 0.9,
    importance: 8,
    currentCode: "throw new Error(...)",
    issueSimple:
      "A missing MessageID after Unifonic accepts can trigger a second SMS via Twilio.",
    whyWeak:
      "The thrown error admits acceptance then SmsService fails over to Twilio.",
    howToFix:
      "Throw non-retryable or return a synthetic id instead of failing over.",
    betterCode: "return { messageId: `local-${Date.now()}` }",
    reviewComment:
      "Could we avoid failing over when Unifonic already accepted the message but omitted MessageID?",
    evidence: [{ quote: "accepted" }],
    githubCommentTarget: { target: "line", reason: "here" },
    autofixPossible: false,
    language: "ts",
    disposition: "open",
  };
  const run = {
    prNumber: 41,
    createdAt: new Date().toISOString(),
    demo: false,
    knowledgeDocs: {},
    findings: [finding],
    passResults: [],
  };
  const result = applyRecheckToRun(
    run,
    finding.id,
    {
      understood: "teach",
      conclusion: "Stand — lesson recovered from non-JSON model reply.",
      teachMe: "Punchline: missing MessageID should not failover.\n\n" + "pad ".repeat(80),
      suggestedComment: finding.reviewComment,
    },
    {
      userAsked:
        "Teach me this finding the way a patient teammate would — deep, not a summary.",
      provider: "claude-code",
    },
  );
  const latest = result.finding.rechecks[0];
  assert.ok(latest);
  assert.doesNotMatch(latest.suggestedComment, /^Could we\b/);
  assert.doesNotMatch(latest.suggestedComment, /^Hm\b/i);
  assert.match(latest.suggestedComment, /MessageID|failover|Twilio|OTP/i);
  const paste = buildConversationalPaste(finding);
  assert.doesNotMatch(paste, /^Hm\b/i);
  assert.match(paste, /MessageID|failover|OTP|Twilio/i);
});
