# PRism

**See every angle before you merge.**

Local, multi-agent pull request reviews — harsh analysis, polite paste-ready GitHub comments.

Point **`prsm`** at any GitHub PR URL. It fetches the diff with the GitHub CLI, runs specialist passes (correctness → nitpick → devil’s advocate) through local AI CLIs you already use (Cursor Agent, Claude Code, Command Code), and writes a triage-friendly review to disk.

**No PRism API key.** Auth lives in the agent CLIs you choose.  
**Never auto-posts to GitHub** — you paste comments yourself.

> Internal workspace packages still use the `@review-os/*` codename. The product is **PRism**; the CLI is **`prsm`** (`review-pr` remains an alias).

---

## Who it’s for

- Solo engineers who want a second (and third) set of AI eyes before merge
- Teams that want **local**, inspectable review artifacts instead of a black-box SaaS
- People already using Cursor / Claude Code / Command Code who want a repeatable PR pipeline

---

## Requirements

| Tool | Why |
|---|---|
| **Node.js 20+** | Runtime |
| **pnpm** | Workspace install / build |
| **[GitHub CLI](https://cli.github.com/) (`gh`)** | Fetches PR metadata + diff (`gh auth login`) |
| At least one AI CLI | See [Providers](#providers) |

Optional but recommended: a modern browser for the local UI.

---

## Quick start (< 10 minutes)

```bash
git clone https://github.com/suv0/prsm.git
cd prsm
pnpm install
pnpm build

# check setup
pnpm prsm --doctor

# GitHub access for private (and public) PRs
gh auth login
gh auth status

# See which local agent CLIs are available
pnpm prsm --list-providers
```

### Option A — Local UI (easiest)

```bash
pnpm prsm --serve-ui --port 8788
```

Open **http://127.0.0.1:8788/** → paste a PR URL → pick agents → **Run review**.

- Agents run **one after another** (often ~3–6 minutes per specialist pass)
- Live CLI output + heartbeats show in the log so long waits don’t look frozen
- **Force stop** / **Restart** are available if something stalls

When finished, open:

```text
reviews/<pr-number>/triage.html
reviews/<pr-number>/final-review.html
```

Or serve triage with live recheck:

```bash
pnpm prsm --serve <pr-number>
# → http://127.0.0.1:8787/
```

### Option B — CLI one-shot

```bash
pnpm prsm --run https://github.com/org/repo/pull/123
# or a single provider:
pnpm prsm --provider cursor https://github.com/org/repo/pull/123
pnpm prsm --provider claude-code https://github.com/org/repo/pull/123
pnpm prsm --provider command-code https://github.com/org/repo/pull/123
```

### Option C — Chat skill (Cursor / Claude / Command Code)

In the agent chat inside this repo:

```text
review-pr https://github.com/org/repo/pull/123
# or
prsm https://github.com/org/repo/pull/123
```

The skill follows `.cursor/skills/review-pr/SKILL.md` (prepare → specialist passes → finalize). Still no auto-post to GitHub.

### Sanity check without AI

```bash
pnpm demo
```

---

## Connect an agent (first-time setup)

PRism does **not** ship an AI model. It drives CLIs already on your machine.

1. Run `pnpm prsm --doctor` — see what’s missing  
2. Or open `pnpm prsm --serve-ui` → **Connect agents** panel  
3. Install **any one** of: Cursor Agent (`agent`), Claude Code (`claude`), Command Code (`command-code`)  
4. Finish that product’s login  
5. Hit **Re-check** in the UI (or re-run `--doctor`)

You only need **one** agent to review. Extra agents add more perspectives (runs take longer).

---

| Id | CLI | Auth (outside PRism) |
|---|---|---|
| `cursor` | `agent` (Cursor Agent CLI) | `agent login` or `CURSOR_API_KEY` |
| `claude-code` | `claude` | Claude Code / Anthropic login |
| `command-code` | `command-code` | Command Code login |
| `anthropic` | HTTP API | `ANTHROPIC_API_KEY` (optional path) |
| `demo` | fixtures | none |

Details: [docs/providers.md](docs/providers.md).

Install and log into whichever CLIs you want **before** the first run.  
`pnpm prsm --list-providers` shows what this machine can actually use.

---

## What you get

```text
reviews/<n>/
  final-review.md       # human-readable review (starts with PR overview)
  final-review.html     # rich view
  triage.html           # one-finding-at-a-time queue
  findings.json
  runs/<id>-<agent>/    # per-agent snapshots (multi-agent merges)
  agent/                # prompts sent to CLIs
  passes/
  knowledge/
  plan.md
  diff.patch
```

`reviews/` is gitignored — your PR text stays on your machine unless you choose to commit it.

---

## Common workflows

| Goal | Command |
|---|---|
| Multi-agent UI | `pnpm prsm --serve-ui` |
| Prepare only (briefs, no AI yet) | `pnpm prsm <url>` |
| Finalize after writing `passes/*.findings.json` | `pnpm prsm --finalize <n>` |
| Triage UI + recheck | `pnpm prsm --serve <n>` |
| Re-render HTML from disk | `pnpm prsm --render <n>` |
| List providers | `pnpm prsm --list-providers` |
| Setup doctor | `pnpm prsm --doctor` |

`pnpm review-pr …` works the same (legacy alias).

---

## Expectations (time & privacy)

- **Wall clock:** one PR overview, then 3 agents × 3 passes × a few minutes each is often **~30–50+ minutes**. That is mostly model API time, not a hang.
- **PR overview:** first section in `final-review` / triage — what the PR does, what changed, risks, test focus.
- **Logs:** `▶` / heartbeats / `cli:` lines mean work is in progress; `✓` / `✗` end a pass.
- **Privacy:** runs locally; PRism does **not** post comments. Use paste-ready text from triage / final review.
- **Network:** needs GitHub (`gh`) plus whatever your chosen agent CLIs call.

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| `gh` / auth errors | `gh auth login`, then `gh pr view <n> --repo owner/repo` |
| Provider missing | Install CLI; re-check `pnpm prsm --list-providers` |
| Cursor `Error: [unavailable]` | Transient Cursor API; re-run that pass/agent, or rely on other agents |
| JSON parse failures | Pipeline continues other passes; upgrade to latest PRism (resilient parser) |
| “Already running” in UI | Attach to the active job, or **Force stop** then restart |
| Empty log for minutes | Heartbeats should appear every ~20s; refresh serve-ui after upgrade |

---

## Project layout

```text
apps/cli/           # prsm CLI + serve-ui + triage server
packages/
  core/             # pipeline, finalize, merge, reverify  (@review-os/core)
  providers/        # cursor / claude-code / command-code / …
  github/           # gh-backed PR fetch
  render/           # HTML / markdown / triage
  schemas/          # shared Zod types
prompts/ + rules/   # specialist pass prompts
.cursor/skills/     # agent-first chat skill
docs/               # vision, pipeline, providers
```

More context: [docs/vision.md](docs/vision.md), [docs/pipeline.md](docs/pipeline.md).

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
