# EdgeDesk Intelligence — architecture after Slice 1 (truth and routing)

This describes how a research turn flows now, what each layer owns, how to
switch each piece off, and what the next slices are. The audit that preceded
it is `docs/intelligence-audit.md`; the incident history and the decision
layer are in `docs/intelligence.md`.

## 1. The layers

```
question ─▶ classify (words) ─▶ resolve the game on the published cards
        ─▶ ONE research context ─▶ re-classify with the sport known
        ─▶ Dal: slate artifact + cfb schema + signals + availability (under the caller's JWT)
        ─▶ rankSlate ─▶ evidence packets ─▶ EDINTEL.decide() per quoted selection
        ─▶ EDRESEARCH.buildResearchPacket()          ← NEW: one normalised packet per game
        ─▶ EDRESEARCH.classifyResearch()             ← NEW: PASS / RESEARCH LEAD / PRICE DEPENDENT /
                                                        MODEL DISAGREEMENT / STALE MARKET / INSUFFICIENT DATA
        ─▶ prompt = evidence + RESEARCH PACKET (normalised) + answer contract
        ─▶ callModel()  (one call; optional bounded tool loop, off by default)
        ─▶ EDRESEARCH.critic()                       ← NEW: rejects prose the packet does not support
        ─▶ EDRESEARCH.structuredResponse()           ← NEW: nine sections, numbers EdgeDesk's, prose the model's
        ─▶ publishResearchPacket()                   ← NEW: write-once snapshot to research_packets
        ─▶ response: answer, matchup_summary, presentation, research, research_packet, structured, critic
browser ─▶ structuredLabelHTML() + Desk prose + structuredPanelsHTML()  ← NEW panels
```

| layer | file | owns |
|---|---|---|
| Presentation kernel `EDPRES` | `supabase/functions/edgedesk_ai/_presentation.js` | translating a decision into cards and copy |
| Intelligence kernel `EDINTEL` | `supabase/functions/edgedesk_ai/_intelligence.js` | slate state, fair-price provenance, quote freshness, push-aware EV, the model-validation gate, `decide()`, the ledger |
| **Research kernel `EDRESEARCH`** | `supabase/functions/edgedesk_ai/_research.js` | typed tools, calculators, request classification, entity resolution over cards, orientation, the ResearchPacket, the label rules, the source manifest, the answer contract, the critic, the deterministic rendering, the prediction record |
| Orchestrator | `supabase/functions/edgedesk_ai/index.ts` PART 2 | retrieval, decisions, prompt assembly, the model call, the critic gate, the snapshot write, the HTTP contract |
| Panel | `app.html` (`structuredLabelHTML`, `structuredPanelsHTML`, `DESK_SECTIONS`) | rendering the structured answer beside the Desk prose |

All three kernels are plain JavaScript UMD blocks inlined into `index.ts` by
`tools/presentation/inline.js`; `presentation_sync.test.js` fails on drift.
Edit the canonical file, run `node tools/presentation/inline.js`.

## 2. The typed tool layer

Every tool is registered in `EDRESEARCH.TOOLS` with a runtime input schema
(`T.obj`, `T.num`, …), an output schema, a category (`calc`, `data`,
`routing`) and an `llm` flag. `runTool(name, input, ctx)` validates the input,
enforces the per-request allowlist and budget, runs the tool, validates the
output and returns one envelope, whether it succeeded or not:

```
{ ok, tool, observed_at, ms, freshness, sources[], quality_flags[], missing[], data, error:{code, message, retryable} }
```

| tool | kind | reads |
|---|---|---|
| `resolve_sports_entity`, `classify_request` | routing | the published cards handed in by the host |
| `get_game_context`, `get_current_market`, `get_market_history`, `get_best_available_price`, `get_model_projection`, `get_projection_drivers`, `get_source_manifest`, `get_results_clv_and_calibration` | data | the packet already built for the turn (no database call inside a tool) |
| `calculate_implied_probability`, `remove_vig` (proportional / additive / power), `calculate_ev`, `calculate_kelly_fraction`, `run_scenario_analysis` (price ladder, line sensitivity) | calc | nothing |

Tools listed in the spec that Slice 1 does not implement are absent from the
registry on purpose rather than stubbed: `get_team_profile`,
`get_player_profile`, `get_roster_and_depth_chart`, `get_injury_report`,
`get_weather_and_venue`, `get_schedule_rest_and_travel`,
`get_matchup_metrics`, `get_recent_form`, `get_opponent_adjusted_form`,
`get_coaching_and_scheme_context`, `get_historical_comparables`,
`get_public_sharp_context`, `search_internal_research`. Slice 2 adds the
football ones over the artifacts the audit found unrouted.

### The tool loop (off by default)

`EDGEDESK_TOOL_LOOP=1` sends the `llm: true` tools to the model as Anthropic
tool definitions. `callModel()` runs at most `EDGEDESK_TOOL_LOOP_ROUNDS`
(default 4) round trips under a budget of `EDGEDESK_TOOL_BUDGET` (default 8)
calls; every `tool_use` gets a `tool_result`, and a refused call returns the
failure envelope with `is_error: true`, so the model never sees a pretend
success. The trace rides back in `narration.tool_trace`. It has been verified
against a stubbed API only; leave it off until a live run has been read.

## 3. The ResearchPacket (`edgedesk_research_packet_v1`)

Built once per single-game football turn by `turnResearchPacket()` from
objects the orchestrator already produced. Every fact is
`{value, source, observed_at, freshness}` or `{missing: true, reason}`.

| section | carries |
|---|---|
| `game` | ids, teams, kickoff, venue, neutral site, season/week, status (SCHEDULED / IN_PROGRESS / FINAL) |
| `market` | state (LIVE / RECENT / STALE / UNKNOWN / LINE_ONLY / NO_MARKET), the primary quote with book, capture time, age, TTL, fair method and probability, every other quote, the consensus number, best captured price, opener→current movement with `cause: UNKNOWN` |
| `model` | home line and margin (both conventions named), total, win probability, interval (missing with reason), version, age, freshness, the validation record, drivers (missing with reason) |
| `comparison` | orientation onto the selection side, gap in points, EV at the price with its probability source, price ladder and limit, line sensitivity |
| `decision` | the kernel's own verdict, gates, price limit, what would change it |
| `availability`, `situation`, `matchup`, `previous_games`, `evidence`, `comparables` | what exists; missing with reason otherwise |
| `unknowns` | every named gap, in sentences |
| `confidence` | `data` and `conclusion`, scored separately from named parts |
| `label` | the rules that fired and why |
| `sources` | the manifest with kind, observed time and freshness |
| `packet_hash` / `packet_id` | FNV-1a over the decision-relevant fields |

### Label rules (`classifyResearch`), in order

1. game not SCHEDULED → INSUFFICIENT DATA
2. no price and no model → INSUFFICIENT DATA
3. data confidence under the floor (0.15) → INSUFFICIENT DATA
4. the only price is not actionable → STALE MARKET
5. |gap| ≥ 7 points → MODEL DISAGREEMENT
6. kernel BET CANDIDATE and EV actionable → PRICE DEPENDENT
7. positive EV but the kernel withheld → RESEARCH LEAD (the kernel caps the label)
8. EV positive but under the floor → PRICE DEPENDENT
9. model only, consensus gap ≥ 3 → RESEARCH LEAD, else INSUFFICIENT DATA
10. |gap| ≥ 3 → RESEARCH LEAD
11. otherwise → PASS

Thresholds are `EDRESEARCH.DEFAULT_THRESHOLDS` and are passed through the
packet builder's `thresholds` option.

## 4. The answer contract and the critic

The system prompt keeps the four Desk headings (the panel and three suites
depend on them) and adds a fifth, **The case for each side**. The user message
ends with the compact packet and the contract. After the model answers,
`critic()` runs eleven checks: certainty words, injection echo, unsupported
movement cause, stale price presented as live, numbers not in the packet,
people not in the packet, injury claims over unknown availability, spread
sign and favourite errors, label contradiction, sections and order, length.
A FAIL replaces the prose with `renderDeterministic()` and reports why; a WARN
ships the prose with the findings listed under it. The critic never edits.

## 5. Freshness

`freshness({observed_at, kickoff, category})` uses the same kickoff ladder
`capture` and `EDINTEL.quoteState` enforce for markets (5 / 15 / 45 / 90 /
180 / 360 minutes by time to kickoff) and fixed limits for projections
(24 h), availability and injuries (24 h), weather (6 h), schedules (72 h),
ratings and rosters (7 d). A market quote is actionable only when LIVE. An
unrecorded observation time is UNKNOWN and never actionable.

## 6. The prediction ledger

`supabase/research_packets.sql` creates `public.research_packets`
(write-once, no delete, no look-ahead, RLS by `user_id`), the
`research_packet_grades` view (joined to `signals` by `sig_key` for the close,
CLV, result and a Brier score) and `research_packet_calibration` (by model
version, sport, market and label, with a sample floor). The function writes
one row per packet under the caller's token; `?probe=1 → packet_health`
reports the last write.

## 7. Switches

| env | default | effect |
|---|---|---|
| `EDGEDESK_STRUCTURED_ANSWER` | 1 | 0: no packet in the prompt, no label, no critic, no structured response — the r11 behaviour |
| `EDGEDESK_TOOL_LOOP` | 0 | 1: the bounded tool loop |
| `EDGEDESK_DECISIONS_ENABLED` | 1 | 0: the kernel makes no decision; labels fall to RESEARCH LEAD / INSUFFICIENT DATA |
| `EDGEDESK_AI_RESEARCH` | 1 | 0: packet-only narration |

## 8. Verification

```
node tools/intelligence/lint.js                   # syntax, type-stripped import, kernel sync, secrets
node tools/intelligence/research.test.js          # 216 assertions: the kernel
node tools/intelligence/evals.test.js             # 100 assertions, 16 families, through the real handler
node tools/intelligence/structured_ui.test.js     # 46 assertions: the panel
node tools/intelligence/research_packets_sql.test.js   # 32 assertions against a throwaway PostgreSQL
npm run ai:test                                   # everything above plus the existing suites
node tools/intelligence/desk_ui.e2e.js            # Chromium, the panel
```

What is NOT verified here, and why: the writing model's prose (no key; the
critic is exercised with chosen texts), the live Supabase tables (fixtures),
the production build (no egress; `intel:doctor` from a machine that can reach
it), and the tool loop against the real API.

## 9. Next slices

**Slice 2 — football intelligence.** The audit's largest unrouted data:
`football/rankings/current.json` (opponent-adjusted unit metrics),
`football/injuries/nfl_2026.json`, `football/starters/*`,
`football/venues/forecasts.json`, `football/matchup/profiles_2026.json`,
`football/coaching/continuity.json`. Plan: a weekly-build step writes a
compact per-team `football/matchup/metrics.json` (~100 KB) from
`current.json` and `profiles_2026.json`; `Dal` reads it like the slate;
`turnResearchPacket` fills `drivers` via `EDINTEL.matchupDrivers` and
`matchup` with the metric pairs; `get_matchup_metrics`, `get_injury_report`,
`get_weather_and_venue`, `get_roster_and_depth_chart`,
`get_schedule_rest_and_travel` join the registry over the same artifacts.
The NFL projection needs a Node builder for `football/nfl/slate.json`
mirroring `fbPredict()` so the function has an NFL model to quote.

**Slice 3 — market intelligence.** Per-book board from `book_quotes`,
movement series from `signal_ticks`, opener point capture, movement
classification with honest unknown states, CLV against the correct close.

**Slice 4 — learning loop.** Grade `research_packets` on a schedule, drift
and calibration reports by model version, automated postmortems joining the
editorial system's graded theses, champion/challenger registry.

**Slice 5 — UFC and tennis adapters** over the existing `ufc.*` / `wta.*`
schemas and `lib/ufc_research.js`, `lib/tennis_research.js`.
