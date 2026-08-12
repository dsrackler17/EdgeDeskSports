# EdgeDesk Supabase functions

Single-file deployment discipline: the dashboard bundles only the folder of the
function being deployed, so a relative import that cannot resolve makes the
deploy fail *silently* — the previous version keeps serving. Every function here
is therefore self-contained with no `../_shared` imports.

## Functions

| Function | Build | Purpose |
|---|---|---|
| `edgedesk_ai` | `edgedesk_ai-2026-08-12-r3-sport-intelligence` | Research engine. Retrieval, evidence, coverage, integrity, learning. |
| `edgedesk_learn` | `2026-08-13.4-slope` | Cron. Turns graded signals into confirmed patterns + calibration. |
| `capture` | `capture-v5-flag-discipline` | Cron. Prices the board and writes `signals`. |

## Tests

Tests live outside the function folders so they are never bundled into a deploy.

```
node --experimental-strip-types supabase/tests/edgedesk_ai.test.ts
node --experimental-strip-types --import ./supabase/tests/_deno-shim.mjs supabase/tests/capture.test.ts
```

Under Deno: `deno test -A supabase/tests/edgedesk_ai.test.ts`.

## Environment

Required: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
(plus `SUPABASE_SERVICE_ROLE_KEY`, `ODDS_API_KEY`, `CRON_SECRET` for the crons).

Optional, all degrade one capability rather than a module:

| Var | Default | Effect |
|---|---|---|
| `EDGEDESK_AI_MODEL` | `claude-sonnet-5` | Analyst model. |
| `EDGEDESK_AI_RESEARCH` | `1` | `0` disables retrieval (packet-only narration). |
| `EDGEDESK_MLB_FALLBACK` | `1` | `0` keeps MLB strictly on owned tables. |
| `EDGEDESK_MIN_PATTERN_N` | `30` | Sample floor before a pattern may be quoted. |
| `EDGEDESK_EVIDENCE_MAX` | `240000` | Evidence character budget. |
| `CFBD_API_KEY` | — | Direct CFBD calls for returning production / portal. |
| `EDGEDESK_NFLVERSE` / `EDGEDESK_NFLVERSE_BASE` | off | nflverse adapter (endpoint must be supplied). |
| `EDGEDESK_CBB_RATINGS_URL` | — | External CBB ratings adapter (licensed/permitted source). |
| `CAPTURE_MAX_BEST_RATIO` | `1.35` | Max best-price/median-price ratio before a quote is treated as broken. |
| `CAPTURE_MIN_BOOKS` | `2` | Books required before a fair line may be flagged. |
| `LEARN_EDGE_MAX` | `0.25` | Shared sane-edge ceiling (capture + learn). |
| `CLOSE_MIN_DEC` / `CLOSE_MAX_DEC` | `1.02` / `30` | Shared tradeable price bound. |

## Schema dependencies

`edgedesk_ai` reads the `cfb` schema via PostgREST `Accept-Profile`. That schema
must be exposed under **Supabase → API settings → Exposed schemas** (same as
`ufc` and `wta`), or every CFB retrieval reports `cfb_identity` unavailable and
names this as the fix.

Optional table `research_source_stats` receives the source-reliability ledger.
If absent the write is swallowed like every other memory write and answers are
unaffected.
