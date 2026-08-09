# Providers

All providers implement the same `Provider.complete()` contract.

| Id | How it runs | Auth in PRism? | Notes |
|---|---|---|---|
| `cursor` | Cursor Agent CLI (`agent -p`) | No — Cursor login / `CURSOR_API_KEY` | Ask mode, read-only |
| `claude-code` | Claude Code CLI (`claude -p`) | No — Claude Code login | |
| `command-code` | Command Code CLI (`command-code -p`) | No — Command Code login | Uses `--skip-onboarding --no-session` |
| `anthropic` | Anthropic HTTP API | Yes — `ANTHROPIC_API_KEY` | Optional; not required for default path |
| `demo` | Local fixtures | No | `pnpm demo` |

## Recommended usage

1. **Local UI:** `pnpm prsm --serve-ui` → pick agents → paste any GitHub PR URL  
2. **CLI auto-run:** `pnpm prsm --run <url>` (available CLI agents, sequential)  
3. **Single provider:** `pnpm prsm --provider claude-code <url>`  
4. **Chat skill:** `prsm <url>` or `review-pr <url>` inside Cursor / Claude / Command Code in this repo  

```bash
pnpm prsm --list-providers
```

## First-time connect

New clones often have zero AI CLIs. Use:

```bash
pnpm prsm --doctor
pnpm prsm --serve-ui
```

The UI **Connect agents** panel detects what’s installed, links to install docs, and unlocks **Run review** once at least one agent is ready.

Before first run:

```bash
gh auth login          # required — PR fetch
agent login            # if using cursor (or set CURSOR_API_KEY)
# log into Claude Code / Command Code via their usual install/login flows
```

Failed CLI auth shows up as a failed pass/agent in the job log; other agents can still finish.
