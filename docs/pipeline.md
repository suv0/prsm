# Pipeline

```text
Load PR (GitHub API; gh optional) → knowledge + plan → shared overview
  → agents in parallel
       each agent: 3 specialist passes in parallel
         (Command Code queues to one process at a time — three at once hung on Windows)
       each finished agent: snapshot under runs/ + rebuild merged triage
         per-agent triage: /pr/<n>/runs/<id>/triage.html
  → evidence / documented-intent / judge → render
```

Default path is **agent-first** (local CLIs, no PRism API key). Optional `--provider anthropic` uses `ANTHROPIC_API_KEY`.

## Merge

Similar findings from different agents become **one card** (`mergeAgentFindings`). Extra agents attach as views (agree / extend / dissent). Unique findings stay separate.

This rebuild happens **when each agent finishes**, not only at the end. You can open `http://127.0.0.1:8788/pr/<n>/` after the first agent.

Markdown/HTML are render-only. `findings.json` / `run.json` are the source of truth.

Hands-off: `pnpm prsm --run <url>` or the hub **Run review** button (`pnpm prsm`).  
Chat path: prepare → write `passes/*.findings.json` → `--finalize <n>`.
