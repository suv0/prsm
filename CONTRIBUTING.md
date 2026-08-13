# Contributing to PRism

Thanks for helping. Keep changes focused and local-first.

## Dev setup

```bash
pnpm install
pnpm build
pnpm test
pnpm prsm --list-providers
pnpm prsm --doctor
pnpm demo
```

## Conventions

- **Product name:** PRism · **CLI:** `prsm` (`review-pr` is a legacy alias)
- **Packages:** `@review-os/*` is the internal monorepo codename for now — don’t rename packages in drive-by PRs
- Prefer small PRs: one feature or fix each
- Don’t commit `reviews/` output or secrets (`.env`, API keys)
- Never add auto-posting to GitHub unless it’s an explicit, opt-in feature

## Useful commands

| Goal | Command |
|---|---|
| Hub | `pnpm prsm --serve-ui --port 8788` |
| Doctor | `pnpm prsm --doctor` |
| Typecheck | `pnpm typecheck` |

## Pull requests

1. Describe the *why*
2. Note how you tested (commands / UI steps)
3. Update README/docs when user-facing behavior changes
