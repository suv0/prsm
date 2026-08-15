import assert from "node:assert/strict";
import test from "node:test";
import { parseFindingsFromModelText } from "../packages/providers/dist/parse-findings.js";

const baseFinding = {
  kind: "issue",
  file: "src/a.ts",
  line: 10,
  severity: "major",
  category: "correctness",
  confidence: 0.9,
  importance: 8,
  currentCode: "return user.email;",
  issueSimple: "Can crash on null",
  whyWeak: "user may be null",
  howToFix: "Guard null",
  betterCode: "if (!user) throw e;\nreturn user.email;",
  reviewComment: "Could we guard null here?",
  evidence: [{ quote: "return user.email;", file: "src/a.ts", line: 10 }],
  githubCommentTarget: { target: "line", reason: "single line" },
  language: "ts",
};

test("parses fenced findings json", () => {
  const text = `Here you go:
\`\`\`json
[
  ${JSON.stringify(baseFinding)}
]
\`\`\``;

  const findings = parseFindingsFromModelText(text, {
    passId: "correctness",
    provider: "anthropic",
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/a.ts");
  assert.equal(findings[0]?.severity, "major");
});

test("salvages trailing commas", () => {
  const text = `[
  ${JSON.stringify(baseFinding)},
]`;
  const findings = parseFindingsFromModelText(text, {
    passId: "nitpick",
    provider: "cursor",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.id.startsWith("nitpick-cursor-"), true);
});

test("salvages when one object is broken but siblings are valid", () => {
  const broken = `{
    "kind": "issue",
    "file": "src/b.ts",
    "line": 2,
    "severity": "minor",
    "category": "naming",
    "confidence": 0.8,
    "importance": 3,
    "currentCode": "const x = 1;",
    "issueSimple": "bad",
    "whyWeak": "weak",
    "howToFix": "fix",
    "betterCode": "const count = 1;",
    "reviewComment": "rename please",
    "language": "ts",
    "broken": "unterminated
  }`;
  const text = `[
  ${JSON.stringify(baseFinding)},
  ${broken},
  ${JSON.stringify({ ...baseFinding, file: "src/c.ts", line: 3 })}
]`;
  const findings = parseFindingsFromModelText(text, {
    passId: "nitpick",
    provider: "cursor",
  });
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.file),
    ["src/a.ts", "src/c.ts"],
  );
});

test("salvages truncated array missing closing bracket", () => {
  const text = `[
  ${JSON.stringify(baseFinding)},
  ${JSON.stringify({ ...baseFinding, file: "src/d.ts", line: 4 })}
`;
  const findings = parseFindingsFromModelText(text, {
    passId: "correctness",
    provider: "claude-code",
  });
  assert.equal(findings.length, 2);
});

test("parses findings after a command-code session banner", () => {
  const text = `session: f91c3f00-0c34-40e7-b012-ad0abfdf011f
[${JSON.stringify(baseFinding)}]
`;
  const findings = parseFindingsFromModelText(text, {
    passId: "correctness",
    provider: "command-code",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/a.ts");
});

test("parses findings from command-code json print-mode result", () => {
  const text = [
    `{"type":"event","event":{"type":"tool_running","toolName":"read_file"}}`,
    `{"type":"result","subtype":"success","finalText":${JSON.stringify(JSON.stringify([baseFinding]))}}`,
  ].join("\n");
  const findings = parseFindingsFromModelText(text, {
    passId: "correctness",
    provider: "command-code",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/a.ts");
});

test("parses findings from command-code json print-mode result amid heavy delta noise", () => {
  const deltaLines = Array.from({ length: 5_000 }, (_, i) =>
    JSON.stringify({
      type: "thinking_delta",
      text: `reasoning token ${i} `.repeat(20),
    }),
  );
  const textDeltaLines = Array.from({ length: 200 }, () =>
    JSON.stringify({ type: "text_delta", text: "x".repeat(500) }),
  );
  const updateLines = Array.from({ length: 50 }, () =>
    JSON.stringify({ type: "message_update", message: { role: "assistant" } }),
  );
  const runEndLine = JSON.stringify({
    type: "run_end",
    messages: Array.from({ length: 1_000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "full transcript entry ".repeat(50),
    })),
  });
  const text = [
    `{"type":"event","event":{"type":"tool_running","toolName":"read_file"}}`,
    ...deltaLines,
    ...textDeltaLines,
    ...updateLines,
    runEndLine,
    `{"type":"result","subtype":"success","finalText":${JSON.stringify(JSON.stringify([baseFinding]))}}`,
  ].join("\n");

  const findings = parseFindingsFromModelText(text, {
    passId: "correctness",
    provider: "command-code",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/a.ts");
});

test("throws when JSON objects are not findings", () => {
  assert.throws(
    () =>
      parseFindingsFromModelText('[{"summary":"a plan, not findings"}]', {
        passId: "correctness",
        provider: "command-code",
      }),
    /not findings/i,
  );
});

test("accepts findings when models set null on defaulted fields", () => {
  const slim = {
    kind: "issue",
    file: "apps/seller/lib/kyc-identity.ts",
    line: 7,
    endLine: null,
    severity: "blocker",
    category: "documentation",
    confidence: 0.95,
    importance: 9,
    currentCode: "export const x = 1;",
    issueSimple: "Missing docs for KYC helper",
    whyWeak: "Callers cannot tell which errors are retryable",
    howToFix: "Document retryable errors in the module comment",
    betterCode: "/** Retryable KYC errors… */\nexport const x = 1;",
    reviewComment: "Could we document which KYC errors are retryable here?",
    evidence: null,
    views: null,
    verifications: null,
    rechecks: null,
    githubCommentTarget: null,
    language: null,
  };
  const findings = parseFindingsFromModelText(JSON.stringify([slim]), {
    passId: "nitpick",
    provider: "cursor",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "apps/seller/lib/kyc-identity.ts");
  assert.equal(findings[0]?.severity, "blocker");
  assert.equal(findings[0]?.disposition, "open");
});

test("coerces stringy numbers and alias field names from CLIs", () => {
  const loose = {
    kind: "issue",
    file: "apps/seller/components/kyc-identity/sumsub-websdk-frame.tsx",
    line: "1",
    severity: "blocker",
    category: "process",
    confidence: "95",
    importance: "8.6",
    title: "SDK frame mounts without a token gate",
    description: "The WebSDK can start before remint finishes",
    recommendation: "Gate mount on a ready token",
    code: "<SumsubWebSdk />",
    suggestedCode: "{token ? <SumsubWebSdk /> : null}",
    comment: "Could we wait for the reminted token before mounting Sumsub?",
    evidence: [{ quote: "", file: "x.ts" }, { quote: "<SumsubWebSdk />" }],
    githubCommentTarget: { target: "file", reason: "whole file" },
  };
  const findings = parseFindingsFromModelText(JSON.stringify([loose]), {
    passId: "correctness",
    provider: "cursor",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 1);
  assert.equal(findings[0]?.confidence, 0.95);
  assert.equal(findings[0]?.importance, 9);
  assert.equal(findings[0]?.issueSimple, "SDK frame mounts without a token gate");
  assert.equal(findings[0]?.githubCommentTarget.target, "line");
  assert.equal(findings[0]?.evidence.length, 1);
});
