# EdgeDesk Intelligence — repository audit (2026-09-16)

This is the audit that precedes the Slice 1 build ("truth and routing"). It was
produced by reading the repository, not by inference, and every claim below
names the file it was read from. Where something could not be verified from
this environment (no Supabase, no Anthropic key, no egress to production) it
says so rather than guessing.

The companion documents are `docs/intelligence.md` (the incident history and
the decision layer), `docs/intelligence-architecture.md` (what Slice 1 added
and how a turn flows now), `docs/data-providers.md`, `docs/model-card-football.md`
and `docs/runbooks/`.

---

## 1. The request flow, traced through one real question

Traced with `node tools/intelligence/conversation.js --json`, which drives the
deployed edge function's `handle()` through the same POST body `app.html`
sends, against the real committed FBS slate and fixture database rows.

```
browser  app.html  EDAI.sendText()
  │  matchupRoute(): EDINTEL.resolveFootballMatchup() over the college card
  │  (football/fbs/slate.json) and, when a club is named, the NFL card built
  │  in the browser from nflverse CSVs.  Resolved → matchupTurn():
  │     pass 1  researchCardHTML() from artifacts already loaded
  │     pass 2  matchupMarket() (signals + cfb.lines under the reader's JWT)
  │             + previousGames(), card re-rendered
  │     pass 3  callFn('chat', question, …, matchupPacket(R,res))
  │               POST /functions/v1/edgedesk_ai
  │               { mode, question, packet, history(≤6), presentation_mode,
  │                 research_context: {sport, game_id, home, away, ids, turns} }
  ▼
edge function  supabase/functions/edgedesk_ai/index.ts  handle()
  1. rateVerdict() — per-isolate 30/min, 300/hr
  2. subscriptionGate() — reads the caller's own `subscriptions` row (402 if present and not entitling)
  3. classify(question) — word-level intent (runs BEFORE any lookup)
  4. sanitizeSubject(research_context) — identifiers only
  5. runResearch():
       0a  resolveNamedMatchup() against the FBS artifact (re-verifies the browser's claim)
       0a-ii researchContextOf() → ONE resolved scope; classify() again with the sport known
       0a-iii escalateDepth() GLANCE → READ → DOSSIER by turns on the same subject
       A   Dal.getSlateIndex(): football/fbs/slate.json (HTTP, 6 MB) cross-checked with cfb.games
       B   rankSlate(): eligibility + research priority, orientToSelection()
       C   getCfbGameEvidence(): teams, records, SP+, season stats, roster, cfb.lines,
           signals, availability/current.json (HTTP), completed games
       D   decideSlate() → EDINTEL.decide() per quoted selection (nine gates)
       E   evidencePacket() one `edgedesk_game_evidence_v1` per researched game
       F   memory reads: research_facts, research_outcomes, research_patterns, research_calibration
  6. buildPresentation() (decision card), matchupSummary() (deterministic four-section read)
  7. buildUserContent() → ONE user message: plan, slate, ranked card, decisions,
     evidence packets (JSON), sport module, identity, coverage, integrity,
     evidence list, thesis attack, memory, client packet
  8. ONE Anthropic messages call: system = SYSTEM + MODE_PROMPT + MATCHUP_CONTRACT.
     No tools. The model receives the whole packet and writes prose.
  9. parseAiCopyBlock() validates the card copy; publishLedger() writes
     recommendation_ledger under the caller's JWT; rememberSession() writes
     research_sessions / research_outcomes / research_snapshots / research_findings
  10. response: { answer, matchup_summary, presentation, research (summary), ledger, narration }
  ▼
browser  matchupTurn(): the function's matchup_summary REPLACES the browser card's
         lede; deskProseHTML() promotes the four Desk headings; researchSectionsHTML()
         and traceHTMLFor() render the summary.
```

Measured on the six-turn conversation (fixtures, no model):

| turn | question | intent | depth | DB/HTTP reads | prompt chars | system chars |
|---|---|---|---|---|---|---|
| 1 | Any CFB matchups look good? | cfb_best_matchups | SLATE | 58 | 177,541 | 28,373 |
| 2 | Analyze North Texas versus Texas State. | cfb_research_matchup | DEEP | 46 | 74,997 | 31,093 |
| 3 | Who have they played? | cfb_research_matchup | DEEP | 46 | 74,050 | 31,093 |
| 6 | What price makes it a pass? | price | QUICK | 12 | 44,872 | 31,093 |

A slate question sends roughly 50,000 input tokens; a matchup question roughly
26,000, of which the system prompt is about 8,000. The evidence packet for one
game is delivered as raw JSON with every field wrapped in
`{value, source, provenance, observed_at, known_at, unit, basis, note}`, most
of them null — the 75 KB matchup prompt is mostly envelope.

**Finding.** The pipeline is deterministic-first and honest, and the routing
incidents in `docs/intelligence.md` §0–0B are fixed on this checkout. What it
is not is a *tool-using* research system: the model gets one enormous message
and is asked to behave. Nothing checks the prose afterwards except the
decision-card copy block. There is no normalised packet a reader, a test or a
grader can inspect, no deterministic recommendation label beyond the four
decision words, and no place where the model's explanation and the model's
number are separated in the response contract.

---

## 2. Every data source currently available

### 2.1 Committed artifacts (GitHub Pages serves them; the function fetches two of them)

| artifact | built by | schema | size | read by the edge function? |
|---|---|---|---|---|
| `football/fbs/slate.json` | `football/fbs/build_coverage.js` (football-weekly-build.yml) | `edgedesk_fbs_slate_v1` — 77 games, kickoff, venue, conference groups, **model_home_line, model_home_margin, model_fair_total, model_home_win_prob**, data_completeness, `input_contract[]` with per-field state/source/as_of/age, starters, QB EPA, shadow model | 6.1 MB | **yes** (memoised, one HTTP read per request) |
| `football/availability/current.json` | `football/availability/*` (availability-sync.yml) | 138 programs, 0 official reports, 5 records | 67 KB | **yes** |
| `football/rankings/current.json` | `football/rankings/build_rankings.js` | ETSR rating per team with `performance.offense_detail/defense_detail/sub_units`: success rate, early-down success, explosive pass/rush, YPA, YPC, sack rate, stuff rate, third down, red zone, turnover rate — each raw, **opponent-adjusted**, league mean, plays, reliability | 5.3 MB | **no** (the browser kernel reads it; the function never fetches it) |
| `football/matchup/profiles_2026.json` | `football/matchup/build_profiles.js` | per-team play profiles: pace, pass rate, explosive rates, sack rates, drives/game, scoring, with column gates | 1.7 MB | no |
| `football/fbs_epa/qb_epa_2026.json`, `index.json` | `football/fbs_epa/build_epa.js` | modelled QB EPA per dropback, career prior | — | no (the slate row carries `home_qb_epa/away_qb_epa`) |
| `football/starters/cfb_2026.json`, `nfl_2026.json`, `current.json` | `football/starters/build_starters.js` | projected starting QB per team with status (ANNOUNCED/EXPECTED/DEPTH_CHART/…) and availability | 1.1 MB / 98 KB | no |
| `football/injuries/nfl_2026.json` | `football/injuries/fetch_injuries.js` (injury-sync.yml, 6-hourly) | nflverse official NFL injury report: player, position, status, injury, practice | 50 KB | no |
| `football/venues/forecasts.json`, `resolved.json` | `football/venues/build_venues.js` | open-meteo forecast per game joined on venue coordinates; last observed forecast carried forward | — | no |
| `football/coaching/continuity.json` | `football/coaching/build_coaching.js` | head coach / coordinator continuity by season | — | no |
| `football/rating/current.json`, `2026.json` | `football/rating/build_rating.js` (rating-sync.yml) | EDR rating | — | no |
| `football/cfb_p4/params.js` (573 KB) | `football/research/*.py` training | the CFB model: seed ratings, hyperparameters, **validation_summary.market** (ATS vs close by disagreement band) | 573 KB | transcribed into `EDINTEL.MODEL_VALIDATION`; `intelligence.test.js` fails if the transcription drifts |
| `football/params.js` | training | the NFL model params | — | browser only |
| `record/grades.json` | `tools/record/grade_briefs.js` (grade-briefs.yml, hourly) | every published brief graded against the close and the final | — | no |
| `articles/*`, editorial snapshots | `tools/editorial/*` (editorial.yml) | immutable pregame snapshots, postgame theses grading, research lessons | — | no |

### 2.2 Supabase tables the function reads (under the caller's JWT)

`public`: `signals` (capture v9: best price, book, sharp/consensus fair,
reference_type, quote ages, first_* opener columns, flagged_* freeze,
closing_* from `close`), `book_quotes` (per-book quotes with family/tier),
`signal_ticks` (price history per selection), `games`, `team_features`,
`qb_features`, `matchup_context`, `game_stats`, `stats_players`,
`venue_weather`, `model_predictions`, `market_residual`, `subscriptions`,
`research_sessions`, `research_facts`, `research_outcomes`, `research_patterns`,
`research_calibration`, `research_snapshots`, `research_findings`,
`research_source_stats`, `recommendation_ledger`, `rankings_current`, and the
MLB feature tables.

`cfb` schema (PostgREST `Accept-Profile: cfb`): `games`, `teams`, `ratings`
(SP+), `records`, `rankings`, `team_season_stats`, `roster`, `recruiting`,
`lines` (consensus handicap/total/moneylines, no book, no timestamp).

### 2.3 Deployed-only writers (no source in this repository)

`ingest_multisport` (writes `games`, `team_features`, `qb_features`,
`matchup_context`), `cfb_ingest` (the `cfb` schema), `venue_weather`,
`model_conf_odds` (`model_predictions`), `odds`, `team_brief`, and the
migrations that created `signals`, `book_quotes`, `signal_ticks`, `games`,
`subscriptions` and every `research_*` table. `supabase/functions/README.md`
counts 68 deployed functions, 8 of them in the repository.

### 2.4 External providers actually in use

| provider | used by | licence posture (from `docs/football-data-sources.md`) |
|---|---|---|
| The Odds API | `capture` (server), `index.html` (personal key) | licensed API key; server-side in capture |
| cfbfastR-data / sportsdataverse (GitHub raw + releases) | slate, rankings, players, profiles, EPA | public, keyless |
| nflverse (`nfldata/games.csv`, `stats_team_week`, rosters, injuries) | browser NFL board, injuries sync, starters | public, keyless, CORS-open |
| ESPN (rosters, depth via sportsdataverse, finals) | rosters sync, availability collectors, settlers | public endpoints; depth endpoint 404s for CFB, participation 403s (documented) |
| CollegeFootballData (via `cfb_ingest`, and adapters gated on `CFBD_API_KEY`) | `cfb.*` schema | key required; adapters dark without it |
| open-meteo | venues/forecasts.json (server build), browser board | keyless |
| MLB Stats API / Baseball Savant | MLB modules | keyless |
| Anthropic Messages API | `edgedesk_ai` narration (`claude-sonnet-5` default) | server-side key |

---

## 3. Live, stale, incomplete, duplicated or unused

| source | state | evidence |
|---|---|---|
| `signals` capture | **was silent until 2026-09-15** (`docs/intelligence.md` §3.5) — no cron called `capture`; `capture_cron.sql` + `capture.yml` now schedule it. Not verifiable here whether pg_cron is applied in production | `supabase/capture_cron.sql`, `.github/workflows/capture.yml` |
| NFL market in `signals` | **not captured** — `app.html:4666` says "NCAAF captured today; NFL when capture scope adds it" | `app.html` |
| `cfb.lines` | consensus numbers only, no book, no timestamp; the function correctly refuses to price against them | `docs/intelligence.md` §4 |
| `football/rankings/current.json` matchup detail | **stored, published, never routed to the function**; the CFB packet says per-play efficiency is "NOT ingested" while opponent-adjusted success/explosive/sack/stuff rates sit in this artifact | `index.ts` reads only slate + availability; `_intelligence.js matchupDrivers()` reads it in the browser |
| `football/injuries/nfl_2026.json` | **published, read by the browser desk, not by the function**; the NFL module still declares `injuries_team_wide: NOT_AVAILABLE` and the system prompt says "EdgeDesk has NO INJURY REPORT" for the NFL | `index.ts` SPORT_INTELLIGENCE, SYSTEM prompt |
| `football/starters/*.json` | published, not read by the function; the CFB packet lists roster quarterbacks, not the projected starter | `index.ts getCfbGameEvidence` |
| `football/venues/forecasts.json` | published, not read by the function; `venue_weather` is probed instead and "may or may not exist" for football | `index.ts` |
| NFL model projection | **browser only** (`fbPredict()` over nflverse CSVs in `app.html`). The function's NFL slate comes from `public.games` for today+2 days with no model line, no week, no ids | `index.ts getSlateIndex` non-CFB branch |
| `research_facts / research_patterns / research_calibration` | read by the function; written by deployed-only `learn`; **no migration in the repo** | grep of `supabase/*.sql` |
| `recommendation_ledger` | migration in repo; §0.1 doctor run reported NOT_APPLIED in production; unverified since | `docs/intelligence.md` §0A.6 |
| `model_predictions` | designed extension point for football (INTEGRATION.md); no football rows are written by anything in the repo | `football/INTEGRATION.md` |
| MLB modules | full, live in season; out of scope here | `index.ts` |
| two alias tables | fixed: `fbs.js` markers are inlined into `_intelligence.js` and on into both hosts | `tools/presentation/inline.js` |
| `docs/intelligence-conversation.txt` | example transcript, produced by `answer.js` | informational |

---

## 4. Existing tables, views, RPCs and identity maps

- **Tables/views with migrations in the repo:** `recommendation_ledger` (+ `recommendation_record` view, immutability triggers), `book_quote_ticks` (+ `public_brief_book_closes`), `publisher_briefs`, `publisher_brief_internal`, `public_brief_closes` view, `editorial_*` (featured games, immutable snapshots, thesis audits, game grades, research lessons, model reviews, runs, `editorial_research_memory` view), `newsletter*`, `community_posts`, `site_articles`, `issue_reports`, billing/stripe, `capture_poke()` RPC, `ufc.*`, `wta.*` schemas, games/collective tables.
- **Model outputs:** `slate.json` rows (CFB), `shadow_*` fields (CFB shadow model), browser NFL projection, `model_predictions` (MLB).
- **Market snapshots:** `signals` (current + `first_*` opener + `flagged_*` freeze + `closing_*`), `book_quotes`, `signal_ticks`, `book_quote_ticks`.
- **Results/CLV:** `signals.result / clv / beat_close / closing_sharp_fair` (written by `close`), `record/grades.json`, `editorial_game_grades`, `research_outcomes`.
- **Identity:** `EDINTEL.TEAM_ALIASES` + `resolveTeam` (FBS, from `fbs.js`), `CANONICAL_TEAMS` registry in `index.ts` (NFL 32, MLB 30, NBA/NHL/WNBA, college), `nflverse` GSIS ids in injuries/starters, cfbfastR team ids in the slate. Display names are still the join key between `signals` and the schedule (`joinSignalsToGames` resolves through the alias table); `cfb_game_id` is carried onto artifact rows when the pair matches.

---

## 5. Where the assistant answers from generic knowledge

1. **The narration itself.** The model writes free prose over the packet. The
   system prompt forbids invention, but nothing verifies the output: a number,
   an injury or a "trend" that is not in the packet reaches the reader
   unchanged. Only the decision-card copy block is parsed and validated.
2. **Betting education** questions ("what is CLV?") have no intent and no
   packet; they are answered from the model's own knowledge. Acceptable, but
   unlabeled.
3. **Follow-ups outside the packet** ("did their coach change?") — the CFB
   packet carries no coaching layer, so a confident answer can only come from
   memory. The prompt says to refuse; nothing enforces it.
4. **History turns** are replayed to the model verbatim (`history.slice(-8)`),
   so an earlier turn's prose becomes context for the next one. Chat history is
   not written to `research_facts`, so it does not become *stored* truth — but
   within a conversation it is re-fed uncritically.

---

## 6. Stored data that exists and is not routed to the assistant

Ranked by how much it would change a football answer:

1. `football/rankings/current.json` opponent-adjusted unit metrics (drivers).
2. `football/injuries/nfl_2026.json` (the official NFL report).
3. `football/starters/*` (projected starting QB with status and availability).
4. `football/venues/forecasts.json` (wind, precipitation per game).
5. `football/matchup/profiles_2026.json` (pace, pass rate, explosive and sack rates).
6. `football/coaching/continuity.json`.
7. `signal_ticks` / `book_quotes` are read for the MLB movement layer but the
   football packet does not render a per-book board or a movement series.
8. `record/grades.json` and `editorial_game_grades` (what EdgeDesk previously
   said and how it graded) — nothing in the function reads them for "what did
   EdgeDesk previously believe?"
9. The NFL model projection (browser only).

Slice 1 routes the market and the model through a normalised packet and makes
the gaps explicit. Slice 2 is the football layers above; the compact-artifact
approach (build a small per-team metrics file from `current.json` in the weekly
build, fetch that from the function) is recorded in
`docs/intelligence-architecture.md` as the next step.

---

## 7. Unsupported or unverifiable claims the assistant can currently make

- Any sentence in the prose that is not a decision-card field. Numbers,
  injuries, "sharp money", weather, trends.
- "No injury news" — the packet's availability block distinguishes
  UNKNOWN from NO_REPORTED_INJURIES, but the prose is free to blur it.
- Line-movement causes. `signals.first_*` gives an opener and `signal_ticks`
  a history; there is no handle, limit or timing data, so any cause stated is a
  guess. The MLB residual layer is explicit about this; football has no
  movement read at all.
- Stale prices presented as available (guarded deterministically in the card;
  not in the prose).
- Home/away and sign orientation in prose (guarded in `orientToSelection()`
  for the decision; not checked in the answer).
- Wording: nothing rejects "lock", "guaranteed", "can't lose" in the prose (the
  copy block rejects them, the answer does not).

---

## 8. Latency, token cost, retrieval limits, failure behaviour

- **Reads per turn:** 12–58 (budget by depth: QUICK 5, STANDARD 16, DEEP 22, SLATE 28, FULL 32, escalating by conversation turn). Each read is a PostgREST round trip; the 6 MB slate artifact is fetched over HTTP on every request (memoised per request only; `CACHE` is per isolate and excludes odds).
- **Prompt:** 45–178 K characters per turn; system prompt 28–31 K. Roughly 12–50 K input tokens. `max_tokens` 800–3,400 by depth (+400 with a card). An empty completion triggers one retry with a trimmed packet.
- **Rate limits:** 30/min, 300/hr per caller, per isolate.
- **Failure behaviour:** model 502 → research still returned; retrieval exception → packet-only narration; ledger failure → one-line notice, detail redacted; memory writes fire-and-forget. Good.
- **Cost controls missing:** no per-user usage record (only the in-memory rate book), no token accounting in the response, no cache of the answer, no cap on history size beyond 8 turns.
- **Observability:** `?probe=1` (build, env presence, ledger/memory health), `retrieval_log` in `?dry=1`, `research_source_stats`. No latency/cost metric is persisted per request.

---

## 9. Tests: what exists and what is missing

121 `*.test.js` files. Intelligence-specific:
`intelligence.test.js` (real slate + real validation artifact, 17 scenarios),
`matchup.test.js` (kernel against real artifacts), `acceptance.test.js`
(reported conversation through `handle()`), `conversation.test.js`,
`deploy_doctor.test.js`, `ledger_sql.test.js` (real PostgreSQL),
`chat.e2e.js` / `desk_ui.e2e.js` / `journey.e2e.js` (Chromium against the real
`app.html`). Baseline on this checkout: `npm run ai:test` ALL GREEN in ~5 s.

**Most important missing tests (Slice 1 adds the ones marked ●):**
- ● numeric calculators (implied probability, no-vig, EV, Kelly) as a typed tool layer
- ● an answer-level critic: numbers not in evidence, forbidden certainty words, stale price presented as live, orientation contradictions, invented injuries
- ● recommendation-label determinism (PASS / RESEARCH LEAD / PRICE DEPENDENT / MODEL DISAGREEMENT / STALE MARKET / INSUFFICIENT DATA)
- ● source manifest and freshness on every time-sensitive field
- ● request classification (task, market type, time frame, sportsbook)
- ● prompt-injection resistance for retrieved text
- ● a prediction snapshot that can be joined to closes and results, by model version
- NFL model projection reachable server-side (Slice 2)
- movement classification with honest unknown states (Slice 3)
- CI on pull requests for the intelligence suites without a manual deploy run (● `intelligence-ci.yml`)

---

## 10. Deployment gaps (GitHub code vs production)

- `supabase/functions/edgedesk_ai` deploys only via the manual `Deploy intelligence` workflow or a laptop; `intelligence-doctor.yml` reports drift daily. The last recorded doctor run (`docs/intelligence.md` §0.1) found production two builds behind and the ledger migration unapplied. **Not re-verifiable from this session** (no egress).
- `research_*` tables, `signals`, `games`, `subscriptions` have no migration in the repo; their production shape is whatever the deployed functions assume.
- `pg_cron` schedules (`capture_cron.sql`, `editorial_cron.sql`, `newsletter_cron.sql`) are applied by hand.
- The NFL board, NFL projections and NFL injuries exist only in the browser and committed artifacts; production's edge function has no NFL model to quote.
- Required GitHub secrets (names only): `SB_URL`, `SB_SERVICE_ROLE`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SB_DB_URL`, `ANTHROPIC_API_KEY`, `CAPTURE_CRON_SECRET`, `RESEND_API_KEY`, `COLLECTIVE_ADMIN_REFRESH_TOKEN`. No `.env.example` existed before this change.
- No lint or type-check step exists anywhere in CI; Node 22 type-stripping is the only "compile".

---

## 11. Decisions taken for Slice 1 (recorded so nobody has to ask)

1. **Keep the single-file edge function and the marker-inlining convention.** A new shared kernel, `supabase/functions/edgedesk_ai/_research.js` (`globalThis.EDRESEARCH`), is inlined into `index.ts` by `tools/presentation/inline.js` exactly as `_intelligence.js` is. It is plain JavaScript with runtime schemas because the repository has no TypeScript toolchain and every test imports the deployed file under Node's type stripping.
2. **Deterministic retrieval stays ahead of the model.** The typed tool layer is used by the orchestrator to build a normalised `ResearchPacket`; optionally the same tools are exposed to the model through a bounded tool-use loop (`EDGEDESK_TOOL_LOOP=1`, default off, verified only against a stubbed API in this environment).
3. **The four Desk headings stay** (the browser parses them and three suites assert them); the structured nine-section response wraps them: deterministic sections (bottom line label, model vs market, price discipline, confidence, sources) are computed by EdgeDesk, prose sections are written by the model and checked by the critic.
4. **The critic rejects, it does not edit.** Flagged prose is replaced by the deterministic rendering and the reason is returned; no model text is "fixed up" silently.
5. **Predictions are snapshotted to a new immutable table** (`research_packets`) keyed to the `signals` rows they priced against, so closes and results can be joined later without a second identity map.
6. **Nothing here deploys.** The manual deploy workflow gains the new migration as an option; the doctor learns the new probe fields.
