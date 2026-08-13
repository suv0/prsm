# Providers

All providers implement the same `Provider.complete()` contract. PRism does **not** ship a model — it drives CLIs on your machine.

| Id | How it runs | Auth in PRism? | Notes |
|---|---|---|---|
| `cursor` | Cursor Agent CLI (`agent -p`) | No — Cursor login / `CURSOR_API_KEY` | Ask mode, read-only |
| `claude-code` | Claude Code CLI (`claude -p`) | No — Claude Code login | Stdin is closed; prompt is `-p` |
| `command-code` | Command Code CLI (`command-code -p`) | No — Command Code login | `--skip-onboarding --no-session` |
| `anthropic` | Anthropic HTTP API | Yes — `ANTHROPIC_API_KEY` | Optional; not the default path |
| `demo` | Local fixtures | No | `pnpm demo` |

## Clone → first agent

You only need **one** of cursor / claude-code / command-code.

```bash
pnpm install && pnpm build
pnpm prsm --doctor          # prints install URLs for missing CLIs
pnpm prsm --serve-ui        # Connect agents panel → Re-check
```

1. Install the CLI from the doctor link (or the table in the README)
2. Finish that product’s login
3. Hub → **Connect agents** → **Re-check**
4. Tick that agent and run a PR

To add another agent later: install + login + Re-check + tick the new box. No extra PRism config.

```bash
gh auth login          # required — PR fetch via `gh`
agent login            # if using cursor (or set CURSOR_API_KEY)
```

## Recommended usage

1. **Local hub:** `pnpm prsm --serve-ui` → Connect agents → paste any GitHub PR URL  
2. **CLI auto-run:** `pnpm prsm --run <url>` (every **available** CLI agent, **in parallel**)  
3. **Single provider:** `pnpm prsm --provider claude-code <url>`  
4. **Chat skill:** `prsm <url>` or `review-pr <url>` inside Cursor / Claude / Command Code in this repo  

Failed CLI auth shows as a failed agent in the job log; other agents can still finish and merge.
