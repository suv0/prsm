import type { Provider, ProviderRequest, ProviderResponse } from "@review-os/core";
import type { Finding } from "@review-os/schemas";

const DEMO_FINDINGS: Record<string, Finding[]> = {
  correctness: [
    {
      id: "demo-correctness-1",
      kind: "issue",
      file: "apps/api/user/service.ts",
      line: 214,
      endLine: 215,
      severity: "major",
      category: "correctness",
      confidence: 0.94,
      importance: 9,
      language: "ts",
      currentCode: `const user = await repo.findById(id);
return user.email;`,
      issueSimple:
        "This can crash if the user does not exist in the database.",
      whyWeak:
        "`findById` can return null. Reading `user.email` without a check throws at runtime and usually becomes a 500 instead of a clean 404.",
      howToFix:
        "After loading the user, check for null/undefined and throw a NotFound error before using any fields.",
      betterCode: `const user = await repo.findById(id);
if (!user) {
  throw new NotFoundException(\`User \${id} not found\`);
}
return user.email;`,
      reviewComment:
        "Could we guard against a null user here and return `NotFoundException` instead of failing later with an unexpected runtime error?",
      evidence: [
        {
          quote: "return user.email;",
          file: "apps/api/user/service.ts",
          line: 215,
        },
      ],
      githubCommentTarget: {
        target: "line",
        reason: "Single-line null dereference risk.",
      },
      autofixPossible: true,
      disposition: "open",
      views: [],
    },
  ],
  nitpick: [
    {
      id: "demo-nitpick-1",
      kind: "issue",
      file: "apps/web/components/UserCard.tsx",
      line: 42,
      severity: "nit",
      category: "naming",
      confidence: 0.91,
      importance: 3,
      language: "tsx",
      currentCode: `const d = user.createdAt;`,
      issueSimple: "The variable name `d` does not explain what it stores.",
      whyWeak:
        "One-letter names make the component harder to read during review and maintenance, especially next to dates and display logic.",
      howToFix: "Rename `d` to something that says what the value is.",
      betterCode: `const createdAt = user.createdAt;`,
      reviewComment:
        "Would you mind renaming `d` to something more descriptive like `createdAt`? It would make this block easier to follow.",
      evidence: [
        {
          quote: "const d = user.createdAt;",
          file: "apps/web/components/UserCard.tsx",
          line: 42,
        },
      ],
      githubCommentTarget: {
        target: "line",
        reason: "Local rename on a single line.",
      },
      autofixPossible: true,
      disposition: "open",
      views: [],
    },
    {
      id: "demo-praise-1",
      kind: "praise",
      file: "apps/api/user/dto.ts",
      line: 12,
      severity: "suggestion",
      category: "maintainability",
      confidence: 0.99,
      importance: 2,
      language: "ts",
      currentCode: `export class CreateUserDto {
  @IsEmail()
  email!: string;
}`,
      issueSimple: "Clear DTO with validation looks solid.",
      whyWeak:
        "Not a weakness — this is a positive signal that validation belongs at the boundary.",
      howToFix: "No change needed. Keep using validated DTOs at the API edge.",
      betterCode: `// Keep this pattern
export class CreateUserDto {
  @IsEmail()
  email!: string;
}`,
      reviewComment:
        "Nice boundary validation here — keeping email checks on the DTO makes the service easier to trust.",
      evidence: [],
      githubCommentTarget: {
        target: "summary",
        reason: "Positive note; better as a summary mention.",
      },
      autofixPossible: false,
      disposition: "open",
      views: [],
    },
  ],
  "devils-advocate": [
    {
      id: "demo-devil-1",
      kind: "question",
      file: "apps/api/user/service.ts",
      line: 188,
      severity: "question",
      category: "devils-advocate",
      confidence: 0.72,
      importance: 8,
      language: "ts",
      currentCode: `await cache.set(userId, profile);`,
      issueSimple:
        "Unclear whether stale cache can serve an old profile after an update.",
      whyWeak:
        "If profile updates do not invalidate this cache key, users may keep seeing old data after edits — a classic production footgun.",
      howToFix:
        "Confirm invalidation on update, or document why this key is safe without it.",
      betterCode: `await cache.set(userId, profile, { tags: [\`user:\${userId}\`] });
// and on update:
await cache.invalidateTags([\`user:\${userId}\`]);`,
      reviewComment:
        "Quick question: do we invalidate this cache entry when the profile is updated? If not, we might serve stale data after edits.",
      evidence: [
        {
          quote: "await cache.set(userId, profile);",
          file: "apps/api/user/service.ts",
          line: 188,
        },
      ],
      githubCommentTarget: {
        target: "line",
        reason: "Question anchored to the cache write.",
      },
      autofixPossible: false,
      disposition: "open",
      views: [],
    },
  ],
};

export class DemoProvider implements Provider {
  readonly id = "demo";

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const findings = DEMO_FINDINGS[request.passId] ?? [];
    return {
      provider: this.id,
      rawText: JSON.stringify(findings, null, 2),
      findings,
    };
  }
}
