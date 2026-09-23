# EdgeDesk Intelligence — architecture after Slice 7 (truth, routing, football intelligence, the active analyst, the pricer, the board)

This describes how a research turn flows now, what each layer owns, how to
switch each piece off, and what the next slices are. The audit that preceded
it is `docs/intelligence-audit.md`; the incident history and the decision
layer are in `docs/intelligence.md`.

## 1. The layers

```
question ─▶ classify (words) ─▶ resolve the game on the published cards
        ─▶ ONE research context ─▶ re-classify with the sport known
        ─▶ Dal: slate artifacts (FBS card, NFL card) + cfb schema + signals + availability (under the caller's JWT)
        ─▶ Dal.getFootballContext(): matchup metrics + forecast for the one game  ← Slice 2
        ─▶ Dal.getIdentity(): both teams' identity profiles                           ← Slice 3
        ─▶ investigate(): the bounded research loop over configured providers        ← Slice 3
        ─▶ EDANALYST.analyse(): interactions, form, sensitivity, scenarios, state     ← Slice 3
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
| **Analyst kernel `EDANALYST`** | `supabase/functions/edgedesk_ai/_analyst.js` | the ten matchup interaction modules, the recent-form read, nearby-line sensitivity from the registered margin distributions, conditional scenarios, follow-up resolution and the conversation state, the investigation planner, the packet diff, the analyst tools |
| Panel | `app.html` (`structuredLabelHTML`, `structuredPanelsHTML`, `analystLeadHTML`, `analystMoreHTML`, `DESK_SECTIONS`) | rendering the structured answer beside the Desk prose |

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

Slice 2 added the football tools over the packet's new layers:
`get_matchup_metrics` (opponent-adjusted unit pairs, ratings, profiles),
`get_injury_report` (availability per side plus the official NFL report),
`get_weather_and_venue`, `get_roster_and_depth_chart` (projected
quarterbacks only; no full depth chart is published),
`get_schedule_rest_and_travel`, `get_team_profile` (`{side}`),
`get_recent_form`, `get_opponent_adjusted_form` and
`get_coaching_and_scheme_context`. Every one reads the packet, so a layer
that was not retrieved is a failure envelope naming the missing field.
Still absent on purpose rather than stubbed: `get_player_profile`,
`get_historical_comparables`, `get_public_sharp_context`,
`search_internal_research`.

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

## 9. Slice 2 — football intelligence (shipped)

The audit's largest unrouted data is now routed through two committed
artifacts, both compact copies of what the football builds already publish.
Neither computes anything new.

| artifact | schema | built by | carries |
|---|---|---|---|
| `football/matchup/metrics.json` | `edgedesk_matchup_metrics_v1` | `tools/football/build_matchup_metrics.js` (starter-context, injury-sync and weekly-build jobs) | per FBS team: ETSR and rating confidence, the offense/defense/sub-unit metric records the rankings build used (raw, adjusted, league, z, sample), the play profile, the projected starter, coaching continuity; per NFL club: the projected starter and the official injury report |
| `football/nfl/slate.json` | `edgedesk_nfl_slate_v1` | `tools/football/build_nfl_slate.js` (starter-context job; `--offline` from the cache) | the browser's own `edgedesk_football` projection run through the same module in Node: fair spread and total, win probability, p10/p50/p90 home margin, the engine's contributions, rest, roof, surface, the schedule feed's starter, and the engine's validation record |

`Dal.getFootballContext()` reads both (memoised, counted against the
retrieval budget, which rose by three per depth) for a single-game football
turn, plus `football/venues/forecasts.json` for a college game with a
forecast row. `turnResearchPacket` then fills the packet's `drivers`
(`EDINTEL.matchupDrivers` both directions, top four each), `starters`,
`injuries`, `coaching`, `profiles`, `ratings`, `situation.weather`, rest,
roof and surface. An NFL side with an official report becomes
`availability.state = OFFICIAL_REPORT` with the listed players; the NFL model
fields, interval, contributions (as `model.drivers`) and validation come
from the NFL artifact, so an NFL game now carries a projection the desk may
quote under the same RESEARCH tier the browser applies.

The NFL card is read only when the turn wants it (the client claims the NFL,
the words say so, an NFL club resolves, or a carried game id is not on the
FBS card), so a college question costs no NFL read. The prompt's NFL
paragraph says what is and is not on file; the college bullet says the
drivers are unit pairs to be read as such. The panel renders the drivers (or
the NFL engine's contributions), availability with the report, the projected
quarterbacks marked not confirmed, and the situation, each with its source,
observed time and freshness badge (`footballEvidenceHTML` in `app.html`,
covered by `structured_ui.test.js`).

Verified by `tools/football/matchup_metrics.test.js`,
`tools/football/nfl_slate.test.js`, the `golden NFL` and `football
intelligence` families in `evals.test.js`, and the existing suites.

## 10. Slice 3 — the active analyst (shipped)

The desk investigates a matchup instead of listing what it holds. Every
piece below is deterministic, reads the packet, and is off with
`EDGEDESK_ANALYST=0` (the r13 answer), which is what the before/after
harness compares against.

**The research loop (`investigate()` in `index.ts`).** After the packet is
built, `EDANALYST.investigationPlan` ranks the unanswered questions most
likely to change the analysis — starting quarterback, offensive-line
availability, opponent-adjusted performance, defensive personnel, weather,
the current price — and the loop sends each to the configured providers
that can answer it (`RESEARCH_PROVIDERS`): the live nflverse injury report
(keyless), the live open-meteo kickoff forecast (keyless; needs the home
venue's geography from the identity profile), CollegeFootballData advanced
stats (`CFBD_API_KEY`), a re-read of EdgeDesk's own `book_quotes`, and web
search (Brave, `EDGEDESK_SEARCH_API_KEY`). Free and official providers run
first; paid search only for what they could not answer. Budgets:
`EDGEDESK_INVESTIGATE_MS` (2500), `_REQUESTS` (4), `_SEARCH_CALLS` (2).
Findings are cached per isolate with a TTL per provider. Every question ends
FOUND, UNAVAILABLE, BLOCKED (naming the env var or access that would fix
it), SKIPPED (budget) or ERROR, and the log rides in the packet, the prompt,
the panel and the critic: the prose may say "EdgeDesk checked X" only for a
question in the log, and a "confirmed" claim needs a FOUND question on that
subject. A live finding that is fresher than the artifact copy (the injury
report, the forecast) is applied to the research context and the packet is
rebuilt; a conflict between the artifact and the live read is resolved by
source tier then time (`EDANALYST.resolveConflicts`) and the resolution is
logged.

**Identity profiles (`football/identity/`).** `tools/football/build_team_identity.js`
writes one dated file per FBS team and NFL club (`index.json` plus
`teams/<key>.json`, ≤17 KB each) with `measured` (unit records with sample
and source; play profile; rating; quarterback with starter, backup and
competition; coaching; offensive-line continuity as the headcount share it
is; pressure counts; availability; talent; schedule; home venue geography),
`qualitative` (sourced statements with feed and date), `inferences` (labels
from a stated rule over measured inputs, with inputs and a confidence),
`trend` (the weekly rating series and per-game EPA rows; early-vs-recent
deltas, called a hypothesis under four snapshots) and `not_measured`.
Season, `effective_from`, `verified_at`; a profile from another season is
refused at read time. The function reads the two files per game, budget-free.

**Interactions (`EDANALYST.interactions`).** Ten modules — pass rush v
protection, quarterback under pressure v expected pressure, rushing v front,
explosive passing v coverage, personnel v availability, tempo v depth,
finishing drives, weather v style, special teams and field position,
late-game backdoor exposure — each returning the advantage, evidence from
both sides, the mechanism, the counter-argument, the uncertainty and
`in_model` (what edgedesk_cfb_p4 or the NFL engine already prices, per
`IN_MODEL`). A module without a measured input says NOT_MEASURED; no
coverage, route, personnel-grouping, snap-count or tracking statistic is
ever invented. The three decisive factors and the strongest counter-case
(the widest measured factor favouring the other side from the model
favourite) lead the answer.

**Recent form (`EDANALYST.formAssessment`).** Each previous game against the
opponent's rating now (SP+ for college, the engine's net-EPA rank for the
NFL, both marked as-assessed-now), the SP+-implied margin, garbage-time
share, turnover margin, explosive dependence, and the three questions:
improved or weak opponents, does the dominant win translate, is the
defensive reputation supported. Under four games everything is a hypothesis.

**Price connection (`EDANALYST.lineSensitivity`).** Cover / push / lose at
nearby lines under the model's own residual distribution (the registered
college pmf; the NFL build's spread-conditioned cover curve), key numbers
named, the probability the price requires (arithmetic on the price alone)
and a verdict that separates "likely to cover if the model is right" from
"worth betting". The validation registry decides whether the figures are
betting probabilities; for both football spreads they are MODEL_CONDITIONAL
and feed no expected value. "Does that change at +7?" widens the ladder to
the reader's line and labels it by the gap alone.

**Scenarios (`EDANALYST.scenarios`).** Starter out (an engine re-run with
the starter id removed, published per game by the NFL build as a
CONDITIONAL_ESTIMATE; qualitative for college with the backup and the
room), the favourite cannot protect, a slower game, win without covering
(model-conditional from the same distribution), and which assumption
carries the projection. None is the projection; the baseline is unchanged.

**Follow-ups and state.** `conversation_state` (game, side, market, quoted
line and odds, evidence retrieved, unresolved questions, turns) is returned
with every turn and carried back inside `research_context.state`;
`sanitizeState` keeps identifiers and the server's own numbers only, and
every time-sensitive item is re-read. `EDANALYST.followUp` routes "what
about their line?", "does that change at +7?", "who have they played?",
"strongest case against us?" to the layer that answers it; a stated belief
is a hypothesis to investigate, never a fact to save.

**Memory.** `Dal.getPreviousPacket` reads the caller's own last snapshot of
the game from `research_packets` and `EDANALYST.packetDiff` names what
changed; `tools/intelligence/postmortem.js` classifies graded packets into
data failures, analytical errors, model errors and variance, and turns
repeats past a sample floor into candidates that must pass a time-separated
held-out evaluation before anyone proposes promotion. Nothing generated
becomes a fact.

**Tools.** `get_matchup_interactions`, `get_line_sensitivity`,
`run_matchup_scenario`, `get_recent_form_assessment`,
`get_investigation_log`, `get_team_identity`, `get_what_changed`, registered
into the same `runTool` envelope, budget and allowlist.

**Proof.** `tools/intelligence/analyst.test.js` (the kernel),
`tools/football/team_identity.test.js`, `tools/intelligence/postmortem.test.js`,
the structured-panel test, the existing evals, and
`tools/intelligence/analyst_evals.test.js`, which runs the same CFB and NFL
questions and evidence cutoff with the layer off and on and prints the
scorecard (supported claims, evidence sources, questions investigated,
interactions measured, follow-ups resolved, bad answers let through, prompt
size, latency, provider cost).

## 11. Slice 4 — the pricer (shipped)

The desk now quotes a price before it looks at a book, and says exactly
what that price is worth. Every piece is built on the closing-line archive
and a time-separated validation; nothing prices itself.

**The closing-line archive** (`tools/football/build_lines_archive.js` →
`football/pricing/lines_nfl.json`): every NFL game since 1999 with the
consensus close (spread, total, moneyline from 2006), the result, roof,
temperature, wind, rest, division flag and starting quarterbacks, with the
sign convention written into the file (`close.home_line = -spread_line`).
The CFB archive is `sportsdataverse/cfbfastR-data` `cfb_line_odds.csv.gz`,
read by the Power 4 walk-forward; its backtest is copied, not re-run.

**The pricing validation** (`tools/football/validate_pricing.js` →
`football/validation/pricing_<sport>.json`): the shipped NFL engine
replayed cold from 2006 in kickoff order (seeds discarded; a game projected
before it is absorbed), scored on 2016-2025 against the close. Per market:
model vs close MAE; a blend `margin ~ a + b·close + c·(model − close)`
fitted on 2016..S−1 and scored on S for S = 2019..2025; ATS by
disagreement threshold with a one-sided binomial p; cover-probability
calibration; the required edge. Tiers:

| tier | rule |
|---|---|
| VALIDATED | 53.5%+ (a point above break-even), p < 0.01, n ≥ 500, most seasons, holds on 2019-2025 |
| LEAN | 52.38%+ (break-even at −110), p < 0.05, n ≥ 300, most seasons: not a losing side, not a profit |
| PROBABILITY | no threshold cleared; the cover probabilities are calibrated (Brier beats 0.25 by 0.002) |
| RESEARCH | none of the above |

Results at build time: NFL spread LEAN at 1.5+ points (52.75% over 1,892
picks, p 0.009, 7 of 10 seasons; blend held-out MAE 9.81 vs close 9.81, c =
0.23); NFL total and moneyline RESEARCH; CFB spread, total and moneyline
RESEARCH (no threshold clears break-even; the biggest disagreements are the
worst), with the open-to-close movement table (53.5-56% moved toward the
model by gap) carried as a LEAN, not a record.

**The feature intake** (same script → `football/validation/feature-status-nfl.json`):
rest difference, division game, dome, cold, wind and an unknown starter,
each fitted as a term on the blend on seasons before the held-out season
and scored on it with a paired test, under the CFB walk-forward's rules
(two held-out seasons, 0.02 points of MAE, p < 0.05, no season degraded by
more than 0.15). All ten arms are REJECTED and the file says why. A
validated arm would be a reviewed change to the engine, never applied here.
OL availability cannot be evaluated this way yet: no historical injury
archive is on file for either league.

**The pricing kernel** (`supabase/functions/edgedesk_ai/_pricing.js`,
`EDPRICE`, inlined into the function):

1. **Fair line.** The validated blend of projection and market; with no
   market the projection alone (MODEL_ONLY); with no validated blend the
   market is the fair price and the projection a stated disagreement
   (MARKET_ANCHORED).
2. **Cover probability** at any line from the blend's held-out residual
   sigma, with a one-point push mass on whole numbers; break-even from the
   quoted price with pushes refunded.
3. **Bet-to.** The selection line where the fair cover meets break-even,
   rounded to the half point, and the price at which the market line is
   break-even.
4. **Status per side**, governed by the tier: PLAY (VALIDATED, disagreement
   at or past the required edge, price at or better than bet-to),
   LEAN_PLAY (the same under LEAN: break-even history, not a profit), PASS
   (below the threshold, the projection favours the other side, or the
   price is short), PROBABILITY (calibrated only), CONDITIONAL (RESEARCH:
   arithmetic, never a recommendation), NO_MARKET.
5. **The ranked board.** Every side by edge (cover minus break-even, in
   percentage points) times data completeness, PLAY above PASS, published in
   `football/nfl/slate.json` (`pricing`) and recomputed per turn with a
   captured price.
6. **Sizing** only for a VALIDATED tier: quarter Kelly capped at 2%.
   Otherwise null with the reason.
7. **Critic extras**: a bet, an EV, a profit or a stake the block did not
   produce fails the answer; a LEAN called an edge without the word LEAN is
   a warning.

The handler (build r15) loads the validation record as a budget-free
artifact, prices the packet after the analyst layer, ranks the NFL slate
for the turn, adds the pricing block to the prompt and its numbers to the
critic's allowed set, exposes `get_price_ranges` and `get_ranked_slate`,
and snapshots `pricing_summary` (the quoted side, line, price, book,
observation time, status, bet-to, fair and market lines) into the packet
for closing-line grading. `EDGEDESK_PRICING=0` restores the r14 answer.

**The scorecard.** `research_packet_pricing` (view) reads the quoted price
through from the packet beside the grades; `tools/intelligence/clv.js`
grades the quoted line against the archive close in points from the
selection's side (quoted − close: home −4.5 that closed −6 is +1.5) and the
result, grouped by sport, tier and status with a 50-packet floor; the
postmortem carries `clv_points` on every classified row. None of it claims
a profit.

**The Desk.** The price is the first panel of the analyst lead: the
headline, each spread side's required vs fair probability, bet-to, the
break-even price at the market line and a status chip (LEAN never renders
as PLAY), the total and moneyline lines, sizing and the tier basis; the
priced board is expandable below.

**Data (Slice 5 closed the gaps).** NFL starters and depth-chart backups
carry this season's EPA per dropback and CPOE from the player-week feed
(`tools/football/fetch_nfl_feeds.js` caches games, team-week and
player-week). The five limitations the pricer shipped with are now data
sets of their own:

| gap | what was built | source | how it is checked |
|---|---|---|---|
| NFL venue geography | `football/venues/nfl_stadiums.json`: 40 stadiums (30 home venues with aliases for renamings, 10 international) with coordinates, roof, surface, time zone | hand-entered; no geocoder or reference API is reachable from the build environment | `tools/football/verify_nfl_stadiums.js`: within 2 km of the college venue register where a stadium also hosts college games (5 stadiums, all within 0.01 km), roof and surface against nflverse games.csv (three games minimum), the home state's bounding box, the time zone against the longitude; a failed row is REFUSED and never read. The identity build puts the verified venue on every NFL profile, the slate build fetches the kickoff forecast from open-meteo through the same module the college build uses, and the live forecast provider is no longer BLOCKED for the NFL |
| OL availability history | `football/pricing/injuries_nfl.json`: the official report 2009-2025 as counts by position group per team-week, with the linemen and quarterbacks listed Out or Doubtful named | nflverse injuries_<season>.csv (public, keyless) | `tools/football/build_injury_archive.js --check`; the feature intake gains nine injury arms (OL, QB, all-position, DL, DB, WR/TE differences; sums for the total). On 2019-2025 none is VALIDATED: `out_diff` and `qb_out_sum` are CANDIDATES, the rest REJECTED, each with its reasons |
| NFL openers | `football/pricing/openers_nfl.json`: EdgeDesk's own opener ledger, the first number the build sees for every upcoming game, every later number, and the last before the result | the nflverse consensus feed, captured by the injury sync every six hours, the starter build daily and the weekly build | nothing is backfilled: a game first seen with a result gets no opener; the CLV scorecard reports whether the market moved from the opener toward the desk's fair line; per-book openers for captured signals stay in `book_quote_ticks` |
| web search | `football/notes/current.json`, the desk's notebook: what a person looked up, with the team, the question it answers, the text, the source name and url, the publication time, the recorder and an expiry (`tools/football/add_note.js`) | a person, with a receipt | the investigation loop reads it as the `desk_notes` provider and reports each note as FOUND from its source at its publication time, never as a search; a note without a url, a publication time or a recorder is refused; expired notes are not read |
| CFB availability | `football/availability/manual/<week>.csv` + `football/availability/import_corrections.js`: a batch of operator corrections through the same narrow door as `record_correction.js` | a person, from the conference report or the school's release | every row is validated by `operator.js` (named player, fixture, source name and url, publication time, recorder); refused rows are printed with reasons and never written. ESPN's depth and participation endpoints still answer 403/404 to the sync, so the official feed stays down and the manual path is the live one |

## 12. Slice 6 — the linemaker's timing and the learning loop (shipped)

Every validation so far says the projections do not beat the close. What a
linemaker gets paid for is knowing where the number is going. Slice 6 builds
that read on data and holds it to the same rules.

**The CFB archive with openers** (`tools/football/build_lines_archive.js --sport cfb`
→ `football/pricing/lines_cfb.json`, 11,502 FBS games 2006-2025, 8,557 with
an opener from 2015 on): sportsdataverse's per-book opening and closing
numbers, medians across books after exact duplicates are dropped, each
spread row resolved to home-relative by the abbreviation's data-derived
team id (the one id present in every game it appears in), then the teams
file, then elimination; the schedules supply the result, week, neutral
site and both sides' pregame Elo. `football/pricing/openers_cfb.json` is the
last season's openers, compact, for the edge function.

**The movement validation** (`tools/football/validate_movement.js` →
`football/validation/movement_<sport>.json`): a rating line from pregame
Elo and home field fitted on seasons before each held-out season (2011 on,
in practice 2016 on where openers exist); the gap is the rating home line
minus the opener; a move is the close minus the opener. Graded: the share
of moves toward the rating by gap threshold with a one-sided binomial p and
a later-window check; a move regression scored against the no-move
baseline; and open-vs-close, the cover rate of the rating's side at the
opening number against the close. Tiers: VALIDATED (55%+, p < 0.01, n ≥
500, most seasons, holds later), LEAN (52.5%+, p < 0.05, n ≥ 300), RESEARCH.

Result at build time: CFB LEAN at 2+ points (the number moved toward the
rating 53.0% of the time, n 4,369, p ≈ 0; 50.9% on 2019-2025; the rating's
side gained 0.26 points by betting at the open). The move regression did
not beat the no-move baseline (1.64 vs 1.60), so the size of a move is not
quoted, only its direction. NFL: NOT_ESTABLISHED, accumulating from the
opener ledger (300 closed games are the floor).

**The kernel's movement read** (`EDPRICE.movement`): from the opener, the
current number and the fair line, with the tendency: READ / LEAN_READ (the
gap clears the graded threshold), MOVED_PAST (the number already went
through the fair line), NO_READ (below the threshold or a RESEARCH tier),
NO_OPENER. Under a read, BET NOW for the side the fair line favours over
the opener and WAIT for the other, as statements about the number, never
the result. The expected close is quoted only when the regression beat the
baseline. The prompt carries the read; the critic fails a "bet now" or
"wait" the layer did not make; the Desk shows it in the price panel; the
snapshot keeps the opener and the verdicts for grading.

**The learning loop** (`tools/intelligence/learning_loop.js`,
`.github/workflows/learning-loop.yml`, nightly): refreshes both archives,
the injury archive, the pricing and movement validations; reads the desk's
quoted prices from `research_packet_pricing` when `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set (names only; the workflow maps the
repository's `SB_URL` and `SB_SERVICE_ROLE` secrets to them) or from an export; joins
every quote to its close, result and opener; runs the CLV scorecard and the
postmortem; and publishes `football/validation/scorecard.json` with the
tiers by market, the movement tiers, the feature verdicts and the counts by
model version. Without database access it says NO_DATABASE_ACCESS and still
runs the archive parts. Nothing in the loop promotes a tier, a coefficient
or a prompt.

## 13. Slice 7 — the board (a card-wide question, answered across the card)

**What was broken.** "What are the best bets today?" resolved no sport, so
`runResearch` read no slate index at all; `getSlate()` read the flagged
`signals` rows across every sport for the next 30 UTC hours and the top row
by edge became the turn's "focus" — one cached signal standing in for the
board, decided in isolation, with no projection, no pricing tier, no critic
and no record. Two faults sat underneath: the MLB module registered the
generic `best_bets` intent as its own, so `sportOfIntent()` locked every
best-bets question with no league word to baseball; and the browser's
`isDailyScan()` caught "best bet", "what should I bet" and "find me an edge"
and ran its own scan of captured prices without ever calling the desk. Time
was UTC throughout; nothing excluded a game that had already kicked off;
follow-ups had no state to carry exclusions or a changed price.

**The kernel (`supabase/functions/edgedesk_ai/_board.js`, `EDBOARD`,
inlined like the others).** Deterministic and dependency-free; it reads
EDINTEL and EDPRICE and computes no probability of its own.

| step | owns |
|---|---|
| `resolveScope` | sports (the league named > the reader's open game or board > the carried board > every supported sport in season), the window as a calendar span in the reader's IANA zone (`today` = now to local midnight; `tonight` to 06:00; `tomorrow`; `this weekend` Friday–Monday morning; `this week` = 7 days; football with no day = 7 days; otherwise today, said so), markets, unsupported markets (props, team totals, derivatives, futures: declared, never approximated), book preferences, exclusions carried from earlier turns. A missing or invalid zone falls back to `EDGEDESK_DEFAULT_TIMEZONE` (America/New_York) and the answer says so. |
| `eligible` | drops STARTED (kickoff passed or status final/in-progress), NO_KICKOFF, BEFORE/AFTER_WINDOW, EXCLUDED (by game id or team) and DUPLICATE (same sides, same day, mascot-suffixed names included), and lists what it dropped with why. |
| `fromDecision` | the MARKET_DEVIG candidate from a decision-layer row: quote (book, line, odds, capture time, kickoff-ladder freshness), the de-vig fair with its method, EV per unit and the probability edge in separate units, the price limit at this line, sourced reasons, the counter-case, what would change it. |
| `fromPricingRow` | the MODEL_BLEND candidate from the pricing kernel: fair line or total from the validated blend, cover vs break-even, tier, bet-to under VALIDATED/LEAN only, executable or reference-only. Totals and spreads both. |
| `qualify` | the printed rules R0–R7: outlier → DATA_CHECK (EV past capture's sanity ceiling, or a 7+ point disagreement) and never promoted; fresh executable quote required; market BET CANDIDATE qualifies, WATCH watches, a BET CANDIDATE failing only freshness watches with a re-check; model PLAY qualifies, LEAN_PLAY qualifies only with a live quote and is labelled LEAN, CONDITIONAL/PROBABILITY never; a reference line can only watch with its bet-to. |
| `rankScore` | edge × freshness weight × tier weight × completeness, labelled UNVALIDATED: it orders what already qualified and cannot promote anything. One emitted opportunity per game. |
| `build` | coverage per sport (EVALUATED / NO_GAMES / NO_ELIGIBLE_GAMES / RETRIEVAL_FAILED / OUT_OF_SEASON / NOT_SUPPORTED), the ranked list, the watchlist with thresholds, research leads (the favoured side under a RESEARCH tier, research only) when nothing qualifies or watches, data checks, separate quote and research freshness, no forced pick, no bankroll assumption. |
| `followUp` / `conversationState` / `sanitizeState` | "take that game out", "take North Texas out", "only college football", "another single that isn't in my parlay", "why that one", "what about the under", "I can only get +3 now", "now it's -125", "what would change your mind". The state the client carries is identifiers and the desk's own numbers; everything else is dropped; every price is re-read. |
| `reprice` | a changed price re-evaluates the de-vig EV at that price; a changed line moves along the model case's cover curve labelled by its tier, or is refused when no model case exists ("needs a captured quote at that number"). |
| `records` | one `research_packets` row per emitted opportunity (label PRICE DEPENDENT) and per watchlist item (RESEARCH LEAD), packet id a hash of sport, game, market, side, line, odds, book, capture time, method, model version and day — a retry writes nothing twice; the `packet` carries the request scope and exclusions, the quote, fair, edge, threshold, qualification, rank, reasons, assumptions and coverage. A started game never becomes a record. |
| `promptBlock` / `criticExtras` / `render` | the block the model writes from; the checks that fail an answer recommending a watchlist or data-check side, forcing a pick, sizing a bet, promising, multiplying parlay legs, or naming a selection not on the board; the deterministic answer that replaces rejected prose. |

**The sweep (`sweepBoard` in `index.ts`).** For a SLATE-depth question with
no single game — a board intent, or a betting word, or a carried-board
follow-up — every sport in scope is read through the same `getSlateIndex`,
ranked and decided by the same `rankSlate`/`decideSlate`, and priced by
`priceBoardGames` (every spread side and total side through EDPRICE, with
the captured price attached to the side it was captured for and reference
lines marked non-executable). A sport whose card cannot be read is
RETRIEVAL_FAILED in coverage, not silence; a card-read failure on a
question that named no team no longer counts as an ambiguity. The decisions
and ledger rows the turn publishes become the board's, not the top
signal's. `research_error` now travels on a dry run when retrieval throws.

**The authorised refresh.** Off by default (`EDGEDESK_QUOTE_REFRESH=0`)
because it spends odds-API credits. On, a board with a STALE or AGING
captured price asks the capture function for one pass with the same
`x-cron-secret` capture checks, once per sport per gap, under a timeout,
then re-reads. Every outcome is in coverage: NOT_CONFIGURED (naming the
variables), BLOCKED (CRON_SECRET missing on this function), THROTTLED,
REFRESHED, FAILED, TIMED_OUT, NOT_NEEDED. An old quote's timestamp is never
touched.

**The handler.** `body.timezone` (validated) and `research_context.board`
(sanitised) come in; `board`, `board_state`, `board_write` and, on the
failure paths, `deterministic_board_answer` go out. The system prompt gains
`BOARD_CONTRACT`; the user message leads with the board block and the
evidence budget is cut to 20 KB. `boardCritic` runs the kernel's checks,
the research kernel's injection scan and a numbers-in-block check; a FAIL
replaces the prose with `EDBOARD.render`. `publishBoardRecords` writes the
rows with `on_conflict=packet_id` and ignore-duplicates. `?probe=1` reports
the kernel, the default zone, the sports and the refresh configuration.

**The client.** `wantsBoard()` routes best-bet phrasings to the desk;
`isDailyScan()` keeps only the explicit "daily scan / today's research /
scan the slate" phrasings for the browser's own scan, which is now the
announced offline fallback when the desk cannot be reached. Every call sends
the browser's IANA zone and carries `research_context.board` back.
`boardAnswerHTML` renders the prose, the ranked list with expandable
evidence (source and time on every reason), the watchlist with thresholds,
research leads, data checks, unsupported markets, coverage, the window and
zone, and the two freshness dates; operational states stay in the trace.

**Proof.** `tools/intelligence/board.test.js` (118 assertions: zones and
windows, started games and duplicates, sign and side, freshness, EV with
pushes, tiers, one-per-game, no forced pick, follow-ups, repricing, records
and idempotency, the critic, source text as data), the `board` family in
`evals.test.js` (42 assertions through the real handler, including the
record write, the retry, the rejected prose and every follow-up), the panel
renderer in `structured_ui.test.js`, and `tools/intelligence/board_probe_live.js`
for the live read-only check against a deployment.

**The MLB faults a live packet showed (2026-09-16), and their fixes.** A
production answer to a card-wide MLB question came back EVIDENCE INTEGRITY:
FAIL with 21 items dated the previous day, 26 starters "attached to two
teams", 4 matchups under two event ids, "column games.sport_key does not
exist" on the schedule read, empty season tables and a memory read that
failed on `research_sessions.confidence`. Each was traced:

| symptom | cause | fix |
|---|---|---|
| yesterday's games in tonight's packet (temporal, duplicate events) | the only finished-game test was `status === "final"`; the MLB ingest writes other words ("Game Over", "Completed Early") or never updates the status | `mlbGameFinished()`: the feed's status words, then the clock (dated before today ET with a start more than six hours past); postponed and cancelled games off the card; one row per pairing, date and game number; applied in the card read, the pitcher read, the slate scope and the board's MLB schedule |
| 26 starters on two teams | `mlb_game_cards` and `games` spell one club two ways ("NY Yankees" / "New York Yankees") and the subject check compared raw strings | `mlbClubKey()` resolves any spelling through the MLB alias registry; the subject check compares clubs, not spellings |
| a series read as a duplicate | the duplicate check keyed on the matchup name alone | keyed on matchup and date: the same pairing on the same day under two ids is still flagged |
| "column games.sport_key does not exist" | the deployed `games` table is the MLB schedule and carries no sport column; the multisport branch filtered on one | the board reads MLB from `games` by date with the finished rule; another sport's 400 falls back to the captured markets as its universe and says so (NO_GAMES with the source named), never a silent RETRIEVAL_FAILED |
| memory read failed | the prior-session read selected `confidence`, which is neither written nor present | column dropped from the select |
| "timestamped in the future" | the card's game item used the start time as its observation time | observation time is null; the start rides in the value |
| `pitcher_season` / `team_season` empty | the deployed `ingest_pitcher_season` has not run; the tables are genuinely empty | not a code fault; the answer already names it. Operational: run the ingest |
| a 1169-minute-old quote | the capture job had not run in nineteen hours | not a code fault; the desk reports it stale and never acts on it. Operational: the capture schedule, or `EDGEDESK_QUOTE_REFRESH=1` with `CRON_SECRET` on the function |

The fixture reproduces the live shape (a "Game Over" game on the previous
day, reversed sides the next day, two spellings of one club, a schedule
table that answers 400 to a sport filter, the missing memory column) and the
`mlb data faults` family in `evals.test.js` (23 assertions) drives both the
board and the MLB matchup path over it.

**Still not verified here, and why.** The live Supabase tables and the
deployed function (no credentials in the build environment; run
`intel:board:live`); the writing model's prose (the critic is exercised
with chosen texts); the capture refresh against the real function (off by
default; the call shape and the throttle are unit-exercised, the credit
cost is a decision for the account that pays).

## 14. Next slices

**Market intelligence.** Per-book board from `book_quotes`, movement series
from `signal_ticks` folded into the movement read (a per-book number that
lags the consensus is where a validated tendency is worth the most), and
the NFL movement test once the ledger reaches its floor. The desk's own
fair line replaces the Elo rating in the movement test as packets accumulate
with closes (the scorecard already joins them).
Still open: an independent coordinate check for the 35 NFL stadiums the
college register does not cover (a reachable geocoder or a sourced table),
travel distance, coordinator turnover, an NFL opponent-adjusted expected
margin for the form read, a reachable official CFB availability feed, and
the web-search provider verified against a live key.

**Slice 5 — the learning loop, scheduled.** Grade `research_packets` on a
schedule, run the postmortem over the grades view, publish drift and
calibration by model version, and hold candidate improvements to the
held-out evaluation the postmortem names.

**Slice 6 — UFC and tennis adapters** over the existing `ufc.*` / `wta.*`
schemas and `lib/ufc_research.js`, `lib/tennis_research.js`.

## 14. Slice 8 — the staking engine (the best bet, and how much of a unit)

**What was broken.** The board could rank an opportunity and could not say
how much of one it was. Every phrasing a reader actually uses — "how many
units?", "build my card", "what's most mispriced?", "is the spread or the
moneyline better?", "should I bet the over or the under?" — reached either a
generic answer or the board with `no_bankroll_assumption` printed under it,
and the one number people were asking for was the one number nothing in the
stack produced. Worse, the only place a unit size could have come from was the
writing model, which is exactly where it must never come from.

**The kernel (`supabase/functions/edgedesk_ai/_stake.js`, `EDSTAKE`, inlined
like the others).** Deterministic, dependency-free, and it computes no
probability of its own: every probability, fair price and line is read from
EDINTEL or EDPRICE, which own them.

| step | owns |
|---|---|
| `settings` | the reader's policy from `bankroll_settings`, every field with its SOURCE (stored / deployment / default). The base unit has a default ($25); **a bankroll does not**. An unknown bankroll costs the dollar figure and never the unit figure, and `dollars_note` says which. An incoherent stored policy (a single cap above the game cap) is reported, not silently obeyed. |
| `noVig` | the no-vig probability from BOTH sides of the SAME market at the SAME number. One side is refused with the reason, because the break-even at a single offered price is vig-inflated and must never reach an edge calculation. |
| `reliability` | a score in [0.05, 0.95] from eight named, weighted components — the calibration record for that sport and market, the effective sample behind it, data completeness, price freshness, book agreement (the decision layer's own confirmation verdict, never a count of quote objects), availability certainty, distribution stability, model-version validation. Every component, its weight, its value and its input are stored with the recommendation. The score is never 1: a reliability of 1 would be a claim of certainty. |
| `conservativeProbability` | the number staking uses, and the only one. An empirical lower bound where one is handed in; otherwise the fair line's own standard error pushed through the same cover curve (a real lower confidence bound from the same held-out residuals); otherwise `0.50 + (calibrated − 0.50) × reliability`, with the method named in the output. |
| `expectedValue` | `EV = (p × d) − 1` at the exact executable price with the conservative probability, pushes returning the stake, plus `model_edge`, `conservative_edge`, `expected_profit_per_unit` and the fair decimal and American odds. |
| `kelly` → `roundUnits` → `tierFor` | `b = d − 1`, `full = ((b·p) − q)/b`, `fractional = max(0, full × multiplier)`; dollars from the bankroll when it is on file, units from the stated one-unit-is-1%-of-bankroll convention when it is not (a convention, not an assumed bankroll, and it is printed). Then every cap, then **rounded DOWN** to a permitted 0.25 unit. Below 0.25u is 0u. PASS / SMALL / STANDARD / STRONG / MAX MODEL POSITION. |
| `capsFor` | max single, the validation tier's own ceiling, the reliability ceiling, and game / team / daily / weekly less what is already staked. A cap that TRIMS is not a gate that refuses: 0.75u already on a game leaves 0.50u of a 1.25u cap, and 0.50u is the answer. Only a cap that leaves nothing is a PASS, and the cap is named. |
| `GATES` | sixteen named conditions, tested in the printed order, the first deciding the status: stale price, no executable quote, unverifiable odds, thin market, a market in SHADOW, no calibration, an unvalidated model version, completeness under the floor, an unresolved starter, an inferred input, reliability under the floor, non-positive conservative EV, a line past the playable price, an exposure cap, a size under the minimum. Every other gate that fired is still reported. |
| `exposureLedger` / `correlations` | pending singles, pending parlay legs and already-submitted positions in one ledger, by game, team, sport, day and week in the reader's own zone. A total is exposure to BOTH teams, because one game script decides it. Duplicate selections, opposing positions, same-game pairs and shared teams are NAMED rather than given a made-up coefficient. |
| `bestMarket` | the six markets of one game ranked by **conservative EV after uncertainty and the caps** — never by raw model disagreement — with the primary, a secondary only when it independently qualifies inside the game cap, and why each other market lost. |
| `alternates` | a captured, executable quote at another number, with the price, probability and EV differences. A point on a cover curve that no book is offering is not an alternative and is not shown as one. |
| `buildCard` | two passes: every candidate against the opening ledger so the ranking is not an artifact of commit order, then commit in ranked order against a live ledger so each accepted position is visible to the next one's caps. Portfolio rules remove the lower-EV duplicate, refuse an opposing position, and hold a second market on a game that already has one. |
| `buildParlay` | off unless asked for or enabled. Every leg clears every single-wager gate on its own, no leg is already a single, no team is reused, one leg per game, at most three legs, stake 0.10u–0.25u. **The combined price must be the book's own**: EdgeDesk will not multiply the leg prices, states no combined probability and no parlay EV, and says so. |
| `render` / `promptBlock` / `criticExtras` / `records` | the deterministic BEST BET / THE CARD / NO BET answer; the block the model writes from; eleven checks; and one write-once audit row per position, PASS included. |

**The validation mode.** `football/validation/staking_<sport>.json` carries a
MODE per market — BET, SHADOW or RESEARCH_ONLY — and `EDSTAKE` refuses to
stake a MODEL_BLEND candidate in a market the walk-forward did not release.
Absence of the artifact is not a block (the tier caps already govern); a
registered SHADOW is a decision and is obeyed. It governs the model path
only: a market-de-vig price is not what that file graded, and its record is
the CLV ledger.

**The database (`supabase/bankroll_and_stakes.sql`).** `bankroll_settings`
(one mutable row per reader, RLS, coherence enforced by check constraints so
a single cap cannot exceed the game cap), `stake_recommendations` (write-once,
no-delete, no-lookahead by trigger; a BET cannot be recorded at zero units and
a PASS cannot be recorded with a stake) and `stake_recommendation_responses`
(append-only, separate, so recording what a reader did can never rewrite what
EdgeDesk said). Views: `stake_recommendation_grades` joins the close by
`sig_key` and carries profit at the recommended size **beside a flat 0.5u and
a flat 1u on the same selections**; `stake_engine_scorecard` groups them with a
sample floor; `stake_pass_reasons` counts a pass like a result;
`stake_open_exposure` is what the engine reads back so the caps see more than
this turn.

**The handler.** `buildStakeCard` reads the policy and the open exposure under
the caller's own token (a missing settings row is a NORMAL state), loads the
staking validation as a budget-free artifact, and sizes every board turn — not
only when the reader said "units", because a best-bets answer that cannot say
how much is not an answer to the question people ask. A single-game staking
question is sized from the pricing kernel's own sides. The prompt gains
`STAKE_CONTRACT` and the staking block above every other block; `stakeCritic`
runs on the prose the model actually wrote (not on another critic's
replacement) and a FAIL swaps in EdgeDesk's own rendering;
`publishStakeRecords` writes the trail with `on_conflict=recommendation_id`, so
a retry cannot double-write. `EDGEDESK_STAKING=0` restores the r16 answer.
`?probe=1 → staking_kernel` reports the caps, the gates, the reliability
weights and the last write.

**The panel.** `stakeAnswerHTML` renders the sized positions (selection,
price, all three probabilities, EV, reliability, Kelly, the exposure after the
wager against each cap, the playable-through price, the reason, the main risk,
the invalidation conditions and any correlation), the NO BET block with the
count of markets evaluated and the strongest research candidate's specific
reason, the positive-value-no-stake list, the per-game market comparison, and
the bankroll editor when no bankroll is on file. `wantsBoard` routes the
staking vocabulary to the desk.

**Walk-forward validation (`tools/intelligence/validate_staking.js`).** The
real kernel is run over the closing-line archives, separately by sport and
market, one held-out season at a time, with the rating line, the blend, the
residual sigma and the tier all fitted on seasons BEFORE the scored one. It
reports the record, profit at the engine's sizes against flat 0.5u and flat
1u on the same selections at the same prices, maximum drawdown per arm, Brier
and log loss on both the calibrated and the conservative probability, CLV in
points at the opener, and a shrinkage ablation. At build time **no market
earned BET**: the NFL spread and total are SHADOW and both college markets are
RESEARCH_ONLY, with the numbers and the reason in the artifact. The caveats
are in the file, not in a footnote: the rating line is not the shipped
football engine (its replay needs feeds that are not committed), the total arm
uses a deliberately weak model, prices are the consensus close, and a backtest
cannot reproduce quote freshness or availability certainty.

**Proof.** `tools/intelligence/stake.test.js` (275 assertions: the odds
arithmetic, no-vig refusal, the reliability weights, the three conservative
methods, Kelly including a negative one, rounding down, every cap, every gate,
the bankroll states, the portfolio rules, best-market selection, the parlay
policy, the ask router, the audit trail and its idempotency, the critic, the
board adapter and the SHADOW mode),
`tools/intelligence/staking_validation.test.js` (58 assertions: the regression,
the sign conventions against a hand-worked game, the tier rules, drawdown, the
walk-forward's separation and the shipped artifacts),
`tools/intelligence/stake_sql.test.js` (63 assertions against a throwaway
PostgreSQL: immutability, no-delete, no-lookahead, the two size constraints,
the caps' coherence, the grades and the baselines, append-only responses, RLS),
the `staking` family in `evals.test.js` (38 assertions through the real
handler) and the staking panel in `structured_ui.test.js`.

## 15. Slice 9 — the desk (a short, direct answer from typed evidence)

A reader should be able to type "What's the best market line value today?"
or "Is Maryland -2.5 worth betting?" and get the answer first, then the
price, then why, then the risk, in three to eight sentences. They shouldn't
have to know where to look or what the fields are called.

```
question + desk_state ─▶ deskTurn (index.ts, only for a client sending desk:true)
   ─▶ Dal.getSlateIndex(CFB, NFL)  + FBS input contract + NFL injury report + pricing validation
   ─▶ EDDESK.evidence(game)        ← wraps EDGameResearch.build (lib/game_research.js) and EDPRICE
   ─▶ EDDESK.classify(question)    BOARD · MARKET · GAME · EXPLAIN · RISK · PASS_LINE ·
                                   LINE_CHANGE · COMPARE · CHOOSE · SAFER · DEEP · SIMILAR
   ─▶ EDDESK.answer()              deterministic: verdict, price, why, confidence, risk, price ladder
   ─▶ optional rephrase by the writing model, under EDDESK.critic (else EdgeDesk's words ship)
   ─▶ desk_prediction_history      the focus selection, write-once, pregame
   ─▶ { answer, desk, desk_state }  → app.html deskShortHTML, LAST_DESK carried back
anything else (staking, other sports, a question the desk doesn't answer) → the pipeline above, unchanged
```

| piece | file | owns |
|---|---|---|
| Desk kernel `EDDESK` | `supabase/functions/edgedesk_ai/_desk.js` | the evidence contract (`edgedesk_desk_evidence_v1`), verdicts, the price ladder, the board ranking, intent, the conversation state, Similar Situations' gate, the short answer, the rephrase critic |
| Research core + game contract | `lib/research_core.js`, `lib/game_research.js` (inlined as `EDRCORE`, `EDGAMERES`) | gap, movement, data quality, typed evidence items; the odds convention `R.odds` |
| Host | `index.ts` `deskTurn`, `deskGameInput`, `deskEvidence` | reading the cards and turning them into the kernel's input; never computes a number |
| History | `supabase/desk_prediction_history.sql`, `tools/intelligence/desk_history.js` | the frozen pregame record, finals, the settled view |

**The evidence contract.** Common fields for both sports: identity, the
projection, EDPRICE's fair lines and tiers, market state per market
(CURRENT / AGING / STALE / UNKNOWN / LINE_ONLY / STARTED / NONE), the gap,
reliability, the typed evidence items and the missing list. Then a
`specific.cfb` block (team rating, roster and recruiting talent, coaching,
QB and passing efficiency, schedule, venue, weather, availability) *or* a
`specific.nfl` block (starters, rest, roof, surface, the engine's drivers,
the official injury report for this week, the build's data quality). One
sport's fields never carry the other's evidence. Anything missing stays
null and goes on the `missing` list; an important one lowers certainty.

**Verdicts, at an actual line and price.** VALUE / THIN / NO_VALUE /
OVERPRICED. For a VALIDATED or LEAN tier they are EDPRICE's own statuses on
its blend. For a RESEARCH tier: the projection's own cover probability
(the NFL cover curve, else EDPRICE.coverAt with the kernel's sigma) against
the break-even, with VALUE needing the research gap (3 points, EDRESEARCH).
"Team X wins 70%" is never "Team X -7 is a good price": laying more than
EdgeDesk's number is OVERPRICED whatever the win probability.

**The price ladder** re-runs that verdict at every half point: *attractive*
is the worst number still VALUE, *playable* the worst still THIN or better.

**The ranking** is EDBOARD R6: edge in probability points × quote freshness
× validation tier × evidence quality. VALUE only, one selection per game.
Stale, unknown-age and reference-only prices never qualify, and a gap of 7+
points is held as a data check. Safety orders by confidence, then cushion;
"disagree most" orders by the raw gap. When nothing clears, the answer is
"Nothing stands out enough at current prices", with the closest number.

**Confidence** = evidence quality × tier weight × freshness weight
(HIGH ≥ 0.6, and only on a VALIDATED tier; MEDIUM ≥ 0.4; LOW otherwise;
INSUFFICIENT with no projection, no price or no current market). Evidence
quality = information confidence (else completeness) × 0.85 for each
important missing input.

**Similar Situations** is withheld until 150 settled pregame predictions exist
for the sport and market, and 50 of them are comparable. The server refuses
any record captured at or after kickoff, and any record whose features carry
a postgame key. Until then the desk says "building history".

**Switches.** `EDGEDESK_DESK=0` turns the desk turn off (every question takes
the pipeline). `EDGEDESK_DESK_NARRATE=0` ships EdgeDesk's words without a
rephrase.

**Verification.** `npm run intel:desk` (kernel + real handler),
`npm run intel:desk:sql` (live PostgreSQL), `tools/research/odds_parity.test.js`,
and section 6 of `tools/intelligence/desk_ui.e2e.js` (Chromium).
