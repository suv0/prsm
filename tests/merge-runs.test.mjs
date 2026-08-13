import assert from "node:assert/strict";
import test from "node:test";
import {
  findingsLikelySame,
  mergeAgentFindings,
} from "../packages/core/dist/merge-runs.js";

function finding(overrides) {
  return {
    id: "f1",
    kind: "issue",
    file: "apps/api/sms.ts",
    line: 10,
    severity: "major",
    category: "correctness",
    confidence: 0.9,
    importance: 8,
    currentCode: "return mockSend()",
    issueSimple: "SMS factory returns a mock in production paths",
    whyWeak: "Callers may send fake SMS in prod",
    howToFix: "Gate mock behind NODE_ENV === 'test'",
    betterCode: "if (process.env.NODE_ENV === 'test') return mockSend()",
    reviewComment: "Please gate the mock behind test env.",
    evidence: [{ quote: "return mockSend()" }],
    githubCommentTarget: { target: "line", reason: "x" },
    autofixPossible: false,
    views: [],
    language: "ts",
    ...overrides,
  };
}

test("findingsLikelySame matches paraphrases on same line", () => {
  const a = finding({});
  const b = finding({
    id: "f2",
    issueSimple: "Production code path can return the SMS mock factory",
    whyWeak: "Fake SMS could be sent outside tests",
    howToFix: "Only enable mock when running tests",
  });
  assert.equal(findingsLikelySame(a, b), true);
});

test("findingsLikelySame rejects different files", () => {
  const a = finding({});
  const b = finding({ file: "apps/api/email.ts", issueSimple: "SMS factory returns a mock in production paths" });
  assert.equal(findingsLikelySame(a, b), false);
});

test("mergeAgentFindings collapses paraphrases and keeps views", () => {
  const merged = mergeAgentFindings([
    {
      agent: "command-code",
      findings: [finding({ id: "cc-1" })],
    },
    {
      agent: "cursor",
      findings: [
        finding({
          id: "cu-1",
          severity: "blocker",
          issueSimple: "Mock SMS factory can leak into production",
          whyWeak: "Production may send mock SMS",
          howToFix: "Split test factory from prod client",
        }),
      ],
    },
  ]);

  assert.equal(merged.length, 1);
  const agents = new Set(merged[0].views.map((view) => view.model));
  assert.ok(agents.has("command-code"));
  assert.ok(agents.has("cursor"));
});

test("mergeAgentFindings keeps unrelated findings separate", () => {
  const merged = mergeAgentFindings([
    {
      agent: "a",
      findings: [finding({ id: "1", line: 10 })],
    },
    {
      agent: "b",
      findings: [
        finding({
          id: "2",
          line: 40,
          issueSimple: "Missing null check on user id",
          whyWeak: "Crash on undefined",
          howToFix: "Validate user id",
          currentCode: "user.id.toString()",
          category: "null-safety",
        }),
      ],
    },
  ]);
  assert.equal(merged.length, 2);
});

test("mergeAgentFindings is transitive across paraphrases", () => {
  const code = 'const [query, setQuery] = React.useState(searchParams.get("query") ?? "");';
  const merged = mergeAgentFindings([
    {
      agent: "cursor",
      findings: [
        finding({
          id: "cu",
          file: "apps/operator/src/components/access/operators-screen.tsx",
          line: 27,
          currentCode: code,
          issueSimple: "Topbar search can update the URL without updating the list filter.",
          whyWeak: "Local state is not synced when searchParams change again.",
          howToFix: "Derive query from searchParams or sync with an effect.",
        }),
      ],
    },
    {
      agent: "claude-code",
      findings: [
        finding({
          id: "cl",
          file: "apps/operator/src/components/access/operators-screen.tsx",
          line: 27,
          currentCode: code,
          issueSimple:
            "Searching from the top bar does not filter this list if you are already on the Operators page.",
          whyWeak: "The screen never re-reads the query param after mount.",
          howToFix: "Use searchParams as the source of truth for filtering.",
        }),
      ],
    },
    {
      agent: "command-code",
      findings: [
        finding({
          id: "cc",
          file: "apps/operator/src/components/access/operators-screen.tsx",
          line: 27,
          currentCode: code,
          issueSimple:
            "Top-bar searches can change the URL without changing the operators list filter.",
          whyWeak: "URL updates and list filtering are out of sync.",
          howToFix: "Filter from the URL query on every render.",
        }),
      ],
    },
  ]);

  assert.equal(merged.length, 1);
  const agents = new Set(merged[0].views.map((view) => view.model));
  assert.ok(agents.has("cursor"));
  assert.ok(agents.has("claude-code"));
  assert.ok(agents.has("command-code"));
});

test("mergeAgentFindings merges issue with question on same snippet", () => {
  const code = "<Button variant=\"outline\">New role</Button>";
  const merged = mergeAgentFindings([
    {
      agent: "cursor",
      findings: [
        finding({
          id: "cu",
          kind: "issue",
          line: 91,
          currentCode: code,
          issueSimple: "The New role button is rendered but does nothing.",
          category: "dead-code",
        }),
      ],
    },
    {
      agent: "claude-code",
      findings: [
        finding({
          id: "cl",
          kind: "question",
          severity: "question",
          line: 91,
          currentCode: code,
          issueSimple:
            "The New role button does not do anything yet and nothing says it is a placeholder.",
          category: "unclear-intent",
        }),
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, "issue");
});

test("merge prefers documented-debt over major for same courier log", () => {
  const merged = mergeAgentFindings([
    {
      agent: "command-code",
      findings: [
        finding({
          id: "harsh",
          line: 37,
          severity: "major",
          category: "security",
          importance: 9,
          issueSimple:
            "The courier endpoint logs the entire unvalidated payload, including phone numbers and OTP bodies.",
          currentCode:
            'this.logger.log(`[sms] courier payload: ${JSON.stringify(payload)}`);',
          evidence: [
            {
              quote:
                "Safe only because delivery is mocked and no number is reachable.",
            },
          ],
        }),
      ],
    },
    {
      agent: "cursor",
      findings: [
        finding({
          id: "soft",
          line: 34,
          severity: "suggestion",
          category: "documented-debt",
          importance: 6,
          issueSimple:
            "Courier SMS endpoint logs full OTP payloads on the public Nest path",
          currentCode:
            'this.logger.log(`[sms] courier payload: ${JSON.stringify(payload)}`);',
          reviewComment:
            "Appreciate the note that logging is intentional while mocked. Follow-up before Unifonic?",
        }),
      ],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, "suggestion");
  assert.equal(merged[0].category, "documented-debt");
});
