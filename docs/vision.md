# PRism vision

**PRism** (*see every angle before you merge*) is a local, multi-agent PR review product.

First vertical slice: pull request review.

North star later:

Design → Architecture review → Implementation → PR review → Security → Performance → Merge readiness → Release review

## Product promise

You run:

```bash
prsm https://github.com/org/repo/pull/1
```

You get:

```text
reviews/1/final-review.md
```

Harsh analysis. Polite paste-ready comments. No auto-posting to GitHub.

Internal monorepo packages still use the `@review-os/*` codename.
