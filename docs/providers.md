# Providers

All providers implement the same `Provider.complete()` contract. PRism does **not** ship a model — it drives CLIs on your machine.

| Id | How it runs | Auth in PRism? | Notes |
|---|---|---|---|
| `cursor` | Cursor Agent CLI (`agent -p`) | No — Cursor login / `CURSOR_API_KEY` | Ask mode, read-only |
| `claude-code` | Claude Code CLI (`claude -p`) | No — Claude Code login | Unattended: `--output-format text` **before** bare `-p`; prompt piped on stdin (same Windows-safe pattern as Command Code). Empty stdin is never left open — that used to make Claude wait ~3s then exit 1. |
| `command-code` | Command Code CLI (`command-code -p`) | No — Command Code login | Unattended flags **before** `-p`: `--trust --skip-onboarding --no-session --permission-mode dont-ask --effort high --no-skills --output-format json --verbose --no-auto-update --max-turns 20`. Prompt is piped to stdin (bare `-p`) so Windows does not mangle it. `--effort high` overrides interactive **max** reasoning (that sat silent for 18 minutes; this model only accepts `high` or `max`). One Command Code process at a time. Silent stall is killed after 5 minutes. Print-mode JSON `finalText` is unwrapped before findings parse. Its NDJSON stream is read line-by-line and never buffered whole: `thinking_delta` / `text_delta` / `message_update` / `run_end` frames are dropped right after being logged, so a long high-effort thinking run cannot exceed the output buffer — only the final `result` frame's text is kept. |
| `anthropic` | Anthropic HTTP API | Yes — `ANTHROPIC_API_KEY` | Optional; not the default path |
| `demo` | Local fixtures | No | `pnpm demo` |
| *(your id)* | Any CLI you add in the hub | No — that CLI’s login | Saved in `~/.prsm/custom-agents.json` |

## Clone → first agent

```bash
pnpm install
pnpm prsm                 # hub at http://127.0.0.1:8788/
```

You only need **one** CLI: a built-in **or** hub → **Add your own agent**.

Public PRs need no GitHub login. Private: hub → **Connect GitHub** (token) or `gh auth login`.

1. Install a CLI, **or** **Add your own agent** (name + command on PATH)
2. Finish that product’s login
3. Hub → **Settings** → **Re-check**
4. Tick that agent and run a PR

Custom CLIs live on this machine only (`~/.prsm/custom-agents.json`). GitHub tokens: `~/.prsm/github.json`.

### Add your own CLI

Use this only for tools **PRism does not already list** (Cursor `agent`, Claude Code `claude`, and Command Code `command-code` are built-in).

The hub form asks for:

- **Name** — label on cards (id is a slug, e.g. `Codex` → `codex`)
- **Command** — the one-word program from that product’s install page, i.e. what you type in a terminal (`codex`, `gemini`, `aider`). Confirm with `codex --version` or Windows `where.exe codex`. Not a path with spaces, and not flags.
- **Extra flags** — optional. Copy **headless / print / CI** flags from that CLI’s docs so it prints and exits instead of opening a TUI. Typical examples: `--output-format text`, `--trust`, `--yes`. Leave blank if unsure; if a run hangs with no output, add the skip-prompt flags from their docs.
- **Pass prompt as `-p`** — on for Codex/Claude-style CLIs (`cli -p "prompt"`); off if the prompt is the last argument (`aider --yes "prompt"`)

PRism then runs: `command -p "<instruction>" [extra flags]` (or trailing prompt). The instruction tells the CLI to read a prompt file and return findings JSON — same contract as the built-ins.

## Recommended usage

1. **Local hub:** `pnpm prsm` → Settings (GitHub / agents) → New review → paste any GitHub PR URL  
2. **CLI auto-run:** `pnpm prsm --run <url>` (every **available** CLI agent, **in parallel**)  
3. **Single provider:** `pnpm prsm --provider claude-code <url>`  
4. **Chat skill:** `prsm <url>` or `review-pr <url>` inside Cursor / Claude / Command Code in this repo  

Failed CLI auth shows as a failed agent in the job log; other agents can still finish and merge.
