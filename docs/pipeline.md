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

On rebuild, only the **latest snapshot per agent** feeds the open merge (older runs stay under `runs/`). Previous open findings are reconciled against the new wave: matched cards keep triage/verify state; unmatched ones whose `currentCode` is gone from the diff are dropped as fixed; still-present misses are carried forward so a flaky second pass cannot erase a real issue.

This rebuild happens **when each agent finishes**, not only at the end. You can open `http://127.0.0.1:8788/pr/<n>/` after the first agent.

**Verify** — Triage **Verify this finding** checks the current card only; List **Verify all open findings** checks every open card. Rollup `resolved` / `accepted` sets `disposition: fixed` (Fixed) and removes the card from the open queue (not a false alarm). The **Report** tab (`verify-report.html`) is the last job only: scope (`finding` \| `all`), this-job verdicts, and a cumulative Open / Fixed / False alarms snapshot after apply — not a second source of truth for the queue.

## Finding kinds

`issue` (the default), `question` (can't be proven from the diff), and `praise`. Praise is
deliberately rare: the shared output contract (`buildReviewUserPrompt`) tells every pass to
default to silence and only emit it for something objectively excellent (confidence ≥ 0.9,
a concrete reason — algorithmic complexity, precise naming, real edge-case coverage — not
"clean code"), capped at one per pass. Praise cards render alongside issues in the final
report but are excluded from the triage queue (nothing to act on).

Markdown/HTML are render-only. `findings.json` / `run.json` are the source of truth.

Hands-off: `pnpm prsm --run <url>` or the hub **Run review** button (`pnpm prsm`).  
Chat path: prepare → write `passes/*.findings.json` → `--finalize <n>`.
