# Agents — PRism

This repo is **agent-first**. Cursor, Claude Code, and Command Code are the models.
Product: **PRism** · CLI: **`prsm`** (`review-pr` alias) · packages: `@review-os/*` (internal).

## Easiest path (clone / other users)

```bash
pnpm install && pnpm build
pnpm prsm --doctor
pnpm prsm --serve-ui --port 8788
```

Open http://127.0.0.1:8788/ → **Connect agents** → paste a PR URL. Need `gh auth login` plus any one agent CLI.

## Chat command

```text
prsm https://github.com/org/repo/pull/123
# or
review-pr https://github.com/org/repo/pull/123
```

Follow `.cursor/skills/review-pr/SKILL.md`.

Hands-off CLI: `pnpm prsm --run <url>` (available agents in parallel).

Triage lives at `http://127.0.0.1:8788/pr/<n>/` (Teach me, Recheck, Verify). Disk refresh: `pnpm prsm --render <n>`.

No PRism API key for the default path. Never auto-post to GitHub.
