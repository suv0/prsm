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
