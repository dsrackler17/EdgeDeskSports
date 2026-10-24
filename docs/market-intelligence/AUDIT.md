# Market intelligence program — the audit (Phases 1, 2 and 15.1–15.6)

**Date:** 2026-10-23. **Repository state:** `main` at `e4c20619` plus this branch. **Method:** the code and the committed ledgers were read, not the documentation alone. Every number below either comes from a committed file named beside it or was recomputed here by a script in `tools/market_intel/`. Items marked **(reported)** come from the read-through and were *not* reproduced in this session; they are listed so the next session can verify them, not as established facts.

The live numbers are one partial season (2026, from week 2 for CFB, through 2026-10-23). Every interval is a 95% cluster bootstrap (football: by week; probability sports: by US-Eastern slate day), from [`VALIDATION.md`](VALIDATION.md).

---

## 1. What exists (capability matrix)

| sport | served forecasting model (id on the record) | point-in-time forecast record | market data EdgeDesk observes | simulator | live graded games (2026) | status |
|---|---|---|---|---|---|---|
| CFB | `edgedesk_cfb_p4_v1.0.1` since 2026-10-19 (`v1.0.0` before) | `record/football/cfb_2026.json` (pick before kickoff, close, final); performance ledger (hash-chained); CFB Lab checkpoint ledger | DraftKings via ESPN (`record/football/quotes/cfb_2026.jsonl`, 13,830 readings from 2026-10-03); The Odds API capture (Supabase only; paid capture paused until 2026-11-01); cfbd consensus in the CFB Lab | season + CFP, 100k runs | 417 | production; model behind the close (§2) |
| NFL | `edgedesk_nfl_v2.1.0` since 2026-10-21 (`edgedesk_football_v1.0.0` before) | `record/football/nfl_2026.json`; performance ledger (mislabelled until this branch, §4 D-2) | DraftKings via ESPN (5,333 readings), nflverse consensus close | season + playoffs + Kalshi futures (352 mapped markets) | 78 (1 on v2.1.0) | production; v2.1.0 not yet evaluable live |
| NHL | `edgedesk_nhl_v1:xg_core` | performance ledger; `hockey/ledger/2027.jsonl` | DraftKings via ESPN in the performance ledger (book capture otherwise DISABLED) | season + playoffs | 76 (47 with a quote) | production; insufficient live evidence |
| NBA | `edgedesk_nba_v1:E_ridge_P` since 2026-10-21 18:20 (`G_stack_P` before) | performance ledger; `nba/ledger/2027.jsonl` | DraftKings via ESPN in the performance ledger | season + play-in + Cup | 16 | production; insufficient live evidence |
| WNBA | `edgedesk_bb_points_v1:points(+bb_cal_v2_home_intercept)` | performance ledger | none quoted | postseason | 3 | season over |
| NCAAM | `ncaam_adjeff@1.0.0` (champion 2026-10-23, not deployed) | none live | none | tournament (BLOCKED: 2027 format unverified) | 0 | not deployed |
| MLB | live card `edgedesk_baseball_v1.0.0` (hand-set, untrained) | **never logged** | none committed | season + playoffs + 2 Kalshi markets | 0 | unvalidated; off-season |
| College baseball | `cbase_v1.0.0 hier_cal` (promotion refused by its own gates) | research replay only | none (gateway row disabled) | none | 0 | off-season |
| UFC | model_loop Elo 1.1.0 (EXPERIMENTAL) | `model_loop/ledger/ufc/cards_2026.jsonl` | ESPN/ufc.com | none | — | experimental |
| Tennis | retired 2026-09-27 | DB only | — | — | — | retired |
| Golf | **no model** (partner redirect) | — | — | COMING SOON | — | none |

A sport appearing in the interface does not make it production-ready: MLB's live card has never logged a forecast, NCAAM's new system is not deployed, and golf has no model.

**Signal Center did not exist** when this audit was written (2026-10-23: no code, document or commit by that name). **Update 2026-10-24:** a Signal Center has since been merged to `main` (#737 and the commits before it; [`docs/signal-center/`](../signal-center/README.md)): a detection engine (`lib/edgedesk_signal_engine.js`), `sc_`-prefixed tables (`supabase/signal_center.sql`), a worker (`tools/signal_center/run.js`), signal graphics and a reader seat. It reads the same performance-ledger forecasts and quotes this program validates and delivers notices through `user_alerts`. It has not yet been reviewed against this program's validation evidence (NEXT_STEPS #7). What plays its part (§6): the reader alert bell (`public.user_alerts` / `alert_preferences`, `lib/edgedesk_personal.js`, `tools/personal/research_state.js`, NFL and CFB only), the CFB market-event ledger (`football/cfb_market/market_intel.js` → `public.cfb_market_events`, internal only), and the per-game research flags (`lib/game_research.js` `FLAG_RULES`).

---

## 2. Model audit (Phase 1.2–1.4)

| model | current version | available data | primary metric | sample | known bias | market comparison | calibration | validation quality | action |
|---|---|---|---|---|---|---|---|---|---|
| CFB board (`cfb_p4`) | v1.0.1 (7 graded) / v1.0.0 (410) | live 2026 record; 2001–2025 replays (partly in-sample before 2026) | spread MAE − close MAE | 417 games, 7 weeks | **FBS vs FCS: favourite priced 7.8 pts short of the close [−12.0, −6.6], n 73** (H-003). v1.0.0 home lean +1.40 [+0.98, +1.72] vs the close in FBS-vs-FBS games, reproducing the replay that motivated v1.0.1's fix | model MAE **worse** than the close by 1.44 [0.66, 2.22]; disagreement carries no information (slope −0.03 [−0.25, 0.22]); win-probability Brier worse than the no-vig close by 0.016 [0.009, 0.028] | slope 0.97 [0.68, 1.22]: **consistent with calibrated; the earlier "overconfident favourites" finding does not reproduce on 2026 live probabilities** (H-007 rejected) | good: every number pregame, named market source and time; few clusters (†) | **REPAIR** FBS-vs-FCS pricing (cause below); **MONITOR** v1.0.1 home field (H-013) |
| CFB v2.1.0 (shadow) | v2.1.0 | CFB Lab live checkpoints; 2016–2025 walk-forward | paired MAE at T24 | 180 common live games | — | not served | — | live, same games as the board | **MONITOR**: no live difference from the board (−0.09 [−0.60, 0.59]); errors correlate 0.96 |
| NFL board | v2.1.0 (1 graded) / v1.0.0 (77) | live 2026 record; 2006–2025 walk-forward (actual-QB inputs: optimistic) | spread MAE − close MAE | 78 games, 6 weeks | home lean +0.83 [−0.46, 2.03] (not demonstrated live; documented +0.9 historically) | MAE diff +0.27 [−0.25, 0.94]; information slope 0.57 [−0.01, 0.99] (not demonstrated, borderline); close moved toward the model 0.15 [0.05, 0.24] (exploratory; H-012) | slope 0.82 [0.51, 1.17] | v2.1.0 has one graded game | **INSUFFICIENT EVIDENCE** for v2.1.0; labelling **REPAIRED** (D-2) |
| NHL | `xg_core` | performance ledger, 10 slate days | Brier − no-vig DK | 47 quoted of 76 | live mean p(home) 0.530 vs observed home-win rate 0.632 (n 76) | Brier diff +0.004 [−0.010, 0.009]: no difference demonstrated | slope 0.89 [−0.46, 2.12] | ten days | **MONITOR** (home intercept) |
| NBA | `E_ridge_P` | performance ledger, 3 slate days | Brier − no-vig DK | 16 | — | +0.04 (no interval) | — | (reported) the engine does not reproduce its own committed selection (`EXPERIMENTS.md`); production model changed after the sealed test was opened | **INSUFFICIENT EVIDENCE**; reproducibility to fix before any claim |
| WNBA | `bb_points_v1` | 3 graded, 0 quoted | — | 3 | (reported) 2026 totals ran 4.1 pts low | none | — | — | **INSUFFICIENT EVIDENCE** |
| NCAAM | `ncaam_adjeff@1.0.0` | 2012–2026 backtest only | log loss | 37,450 (backtest) | — | none live | — | not deployed | **INSUFFICIENT EVIDENCE** (live) |
| MLB live card | `edgedesk_baseball_v1.0.0` | none (never logged) | — | 0 | (reported) a +0.016 home bonus added to the moneyline only | none | none | none | **INSUFFICIENT EVIDENCE**: log every published forecast before 2027; do not present as validated |
| College baseball | `cbase_v1.0.0` | 2014–2026 walk-forward | log loss | 16,696 holdout | (reported) home −1.5 run line over-predicted ~3 pts | none | slope 1.015 | gates G11/G12/G15 fail | **KEEP** its refusal |
| Season simulators | per sport | NFL 2010–2025, MLB 2022/23/25 backtests | Brier vs σ = 0 | NFL 2,048 team-snapshots | (reported) holdout under-dispersion NBA, NHL, NFL, WNBA; four sports stack a strength offset on the board's per-game distribution (NFL: 7-pt favourite 0.740 board vs 0.710 simulated) | Kalshi futures (NFL, MLB) | every season-level difference vs σ = 0 includes 0 | thin, no market baseline | **MONITOR**; dispersion is a research item, not a patch |

**The FBS-vs-FCS shortfall, traced to its cause.** Every FCS team is priced from one shared floor rating (`football/cfb_p4/params.js` `fcs_rating: −28`; `football/cfb_p4/engine.js` `rating()`), and every rating is learned from margins clamped at ±35 (`engine.js:737`, `hp.cap`). A rating difference therefore predicts a *capped* margin. The repo's own FCS-bridge validation (`football/validation/fcs_bridge_cfb.json`, walk-forward, n 122) shows it: against capped finals the floor's bias is +0.16 points; against real finals it is **−8.83**. That file's verdict ("not demonstrated") is judged on the capped metric, which cannot see the bias users get.

**Correction (2026-10-24), after the repair experiment ([`FCS_UNCAPPED.md`](FCS_UNCAPPED.md), H-014).** This paragraph first said the bias was "in the level, not the ordering" and that per-team FCS ratings were the wrong fix. The experiment says otherwise:
- **The level is small historically and rising.** Over 2016–2025 the replayed engine's FBS-vs-FCS shortfall averages about 2 points (season means from −0.5 to +5.1; 2024 3.4, 2025 5.1, about 8 in 2026 live).
- **A level map does not reduce error.** The pre-registered walk-forward map (shift or affine, each season fitted on earlier ones, n 1,072) removes the bias but lowers out-of-sample MAE by only 0.10 pts [−0.23, +0.02]. H-014 is **REJECTED**; the map is recorded in `football/cfb_p4/fcs_margin_map.js` with `survived: false`, never applied.
- **The gap to the market is ordering.** On games with a close, the engine's MAE is 15.1 against the close's 12.1; the map recovers almost none of that 3-point gap.
- **The bridge deserves a real test.** Re-scored on real finals, its own 2026 walk-forward lowers MAE by 0.95 pts [−1.46, +0.29] (n 122, 6 weeks: not demonstrated) where its capped verdict saw 0.02. Per-team FCS ordering is what is missing.

The next test is the bridge's per-team ratings on uncapped finals across several seasons (NEXT_STEPS #1). A frozen recent-level shift (+4.27) is tested forward only, as H-016, because it was designed after seeing the season means. Promotion stays a person's decision (`football/enrichment/fcs_ratings.json` `promotion`).

**What does not reproduce.** The CFB win probability is not overconfident live (slope 0.97). The large-favourite "inflation" in FBS-vs-FBS games is not present in 2026 (21+ point favourites: model lean −2.2 to −2.0 pts, result between; every interval includes zero, `VALIDATION.md` favourite table). The 21+ bucket's −6 pt lean is the FCS games above.

---

## 3. Market data and pricing (Phase 1.1, 2.4)

**Odds arithmetic — verified.** Seven American→decimal implementations (`research_core` ×2, `edgedesk_ev`, `edgedesk_odds_tools`, `edgedesk_calc`, `edgedesk_market_compare`, `edgedesk_fairodds`) agree on all 9,802 American prices from ±100 to ±5,000 (0 mismatches), and five two-way no-vig implementations agree to 1e-6 on seven test pairs. Shin, power, proportional and additive methods (`lib/edgedesk_odds_tools.js`) were read against the published formulas and are correct; each one's assumption is in its `METHODS` text. The no-vig result is never presented as a true probability by the calculator. Kept as a regression test: `tools/market_intel/validation_lab.test.js` pins the calibration fit to `edgedesk_ev`; the earlier consolidation audit is `docs/odds-helpers-audit.md`.

**What EdgeDesk actually observes.**
- One paid source (The Odds API, all calls through `supabase/functions/odds_gateway`), paused by its breaker until 2026-11-01; raw provider snapshots are overwritten and event-level ones purged after 72 h, so the full per-book board cannot be reconstructed after the fact. Per-book history survives only for actionable signals (`book_quote_ticks`), NCAAF (`cfb_lab_market_quotes`) and props.
- Free, committed, timestamped: DraftKings via ESPN for CFB, NFL, NBA, NHL (from 2026-10-03 in `record/football/quotes`, from 2026-10-16 in the performance ledger). **One sportsbook.** Source-disagreement and market-maker questions cannot be answered from it.
- Multi-season history is closes without timestamps (`football/pricing/lines_*.json`).
- "Opening" lines in the capture are EdgeDesk's first sighting of a point, not a market opener (reported).

**No source is established as informative.** `lib/edgedesk_market.js` weights Pinnacle, Circa, Bookmaker and BetCRIS ×2 (reported only, "never used as the line"); the capture anchors on Pinnacle; the only evidence-based weights (`football/cfb_market/artifacts/book_quality_v1.json`, 2016–19) are inactive because nothing beat the plain median, and in CFB Pinnacle was no better than other books (MAE difference +0.0018 [−0.012, 0.016], `docs/cfb-market/BACKTEST.md`). This audit makes no claim that any book is a market maker.

**Freshness limits disagree across the system** (reported; 15 to 420 minutes depending on module). The new market-intelligence engine uses `edgedesk_market_state`'s 180 minutes so the two never disagree.

---

## 4. Defects found (Phase 15.6–15.7)

Severity: **High** = a wrong number reaches a reader or a ledger; **Medium** = a wrong label or a latent wrong number; **Low** = documentation or cosmetics.

| id | severity | defect | evidence | status |
|---|---|---|---|---|
| D-1 | High | One sportsbook spelled two ways ("DraftKings", "Draft Kings" — both appear in ESPN feeds) counted as two independent books, so a lone DraftKings line reached `min_verified_books = 2` and the market was VERIFIED, which opens betting validation on one source | `lib/edgedesk_market_state.js` `latestPerBook` keyed on the lowercased name; reproduced (books 2, verified true) | **FIXED** (canonical `bookKey`, the rule in `lib/edgedesk_market.js`); regression S1b in `tools/resilience/resilience.test.js` fails on the old code |
| D-2 | High | Since 2026-10-21 every NFL projection, and so every performance-ledger forecast, carried the slate header's `edgedesk_football_v1.0.0` while every game was priced by `edgedesk_nfl_v2.1.0` | `lib/edgedesk_projections.js` read `engine.model_version`; all 27 slate games carry `model_version: edgedesk_nfl_v2.1.0`; 47 ledger rows affected (`model_registry.json`) | **FIXED forward** (the game's own version; edge-function copy re-inlined). The ledger is append-only, so the 47 rows keep their label; `model_registry.json` `label_issues` is the correction |
| D-3 | High | The `close` function could record an in-play price as a game's close: pending rows reach 180 min past the start, the sport-level board is not filtered to upcoming events, and nothing compared the board's observation time with the start | `supabase/functions/close/index.ts` run loop | **FIXED in code, needs deploy**: `closeRoute()` sends any row whose board was observed at or after its start to the existing last-tick-before-start path (tests Q9b in `tools/resilience/quota_guard.test.js`). Takes effect only when the owner redeploys `close` |
| D-4 | Medium (latent) | The Kalshi NFL mapping builder never checked the event ticker's season; the conference, division and playoff rules name none, so next season's `-28` markets would map onto this season's simulation | `simulator/src/cli/build_kalshi_mappings.ts` (MLB checks it; NFL did not) | **FIXED**; 4 tests in `simulator/tests/markets.test.ts`; all 352 committed mappings pass the new rule |
| D-5 | High (model) | CFB FBS-vs-FCS favourites priced 7.8 pts short of the close | §2 | **OPEN.** A level map was tested and REJECTED (H-014, 2026-10-24). Next: per-team FCS ratings on uncapped finals across seasons (NEXT_STEPS #1); a frozen +4.27 shift runs forward as H-016 |
| D-6 | Medium | `edp_entitled()` lets every signed-in reader in when `community_is_entitled()` is missing (fail-open); `sim_viewer_entitled()` fails closed | `supabase/personal_research.sql:138-148`; a test asserts the open behaviour for test databases | **OPEN — owner decision** (production has the function; risk is a mis-ordered deploy) |
| D-7 | Medium | Game graphics headline a raw model-vs-market difference as "EDGE: NE +3" (naming a side) and show "pts vs Kalshi" from 4 pp against the Kalshi mid, before fees; the CFB live record shows that disagreement carries no information beyond the close (H-001) | `lib/edgedesk_game_graphic.js:122, 476, 496` ("DIFFERENCE · BEFORE FEES" is disclosed) | **OPEN — owner decision** (product language, release gate 7) |
| D-8 | Medium | (reported) capture writes in-play prices into `signals`/`signal_ticks`; ticks within 10 min of kickoff are labelled `reference_type 'sharp'` while their fair is a consensus that includes the best-price book; `book_quote_ticks.seen_at` is the DB write time and `is_sharp` is never written | `supabase/functions/capture/index.ts:1939, 2617, 3666-3732`; `supabase/book_quote_ticks.sql:63-73` | **OPEN — to reproduce** before any change to the capture function |
| D-9 | Medium | (reported) CLV survivorship: a pregame row whose point moved is closed as `line_pulled_no_close` permanently, removing exactly the lines that moved. D-3 removes the started-game half of this; the pregame half remains | `close/index.ts` | **PARTLY ADDRESSED** |
| D-10 | Low | The performance ledger's `model.version` means the model version on one capture path and a feature/artifact/distribution version on another (`nfl_fv1`, `edgedesk_fbs_universe_v1.0.0`, `edgedesk_nba_dist_v1`) | `model_registry.json` | **OPEN**; the registry keys on `model.id` |
| D-11 | Low | CFB quote ledger heartbeat gaps in weeks 5–6: one hour before kickoff, the newest quote was over 3 h old in 21 of 54 (week 5) and 13 of 58 (week 6) games, 1 of 62 in week 7 | `MARKET_INTEL_BACKTEST.md` STALE_MARKET_DATA | **RESOLVED upstream** by week 7; recorded |
| D-12 | Low | (reported) MLB tiebreak step 3 coded as "interdivision" where MLB describes "intraleague"; "VERIFIED" rule facts are self-attested by coding sessions; WNBA is ACTIVE with zero verified rule facts; `cfb/module.ts:196` identical branches | simulator audit | **OPEN** (MLB is off-season; NEXT_STEPS) |
| D-13 | Low | `public_brief_book_closes` exposes post-kickoff per-book closes to the public anon key | `supabase/book_quote_ticks.sql:110-111` | **INTENDED** (the public brief grader runs on the shipped anon key); recorded as an owner trade-off |
| D-14 | Low | `cfb_market_*` tables are readable by any signed-in account | `supabase/cfb_market.sql:232` | **KNOWN** (the same data is committed as static files — "Phase 2b" in `lib/edgedesk_plans.js`) |

---

## 5. Sports-betting theory compliance (Phase 2): concept → code

Concepts drawn from public descriptions of *The Logic of Sports Betting* and *Interception* (Miller & Davidow) and from standard market-microstructure statistics; no book text is reproduced. Columns: what it means here · where EdgeDesk has it · correct? · data needed · how to test usefulness · decision.

| concept | meaning (testable form) | in EdgeDesk | correct? | data needed | usefulness test | decision |
|---|---|---|---|---|---|---|
| Market making vs following | Some sources set prices others copy; a source's informativeness is how well its price predicts the later consensus and the result | `lib/edgedesk_market.js` sharp weights; capture's Pinnacle anchor; CFB `book_quality_v1` | Weights are **asserted, not evidenced**; the CFB evidence says no book beat the median | multi-book timestamped history (paid capture) | lead-lag of each book vs the later consensus; MAE vs result | **DEFER** until multi-book history exists; never call a book sharp in copy |
| Price discovery | How a price develops from first sight to close | quote ledgers; CFB market events; new `MARKET_CONVERGENCE/DIVERGENCE`, `UNUSUAL_PRICE_MOVEMENT` | definitions of "open" differ by module (§3) | single-book timestamped ledger (have) | does the move predict the result (`MARKET_INTEL_BACKTEST.md` *market improvement*) | **BUILT** (engine) — informational only |
| Market agreement and resistance | A price that does not move despite news, or moves and returns | not implemented | — | multi-source ticks at ≤15-min cadence | — | **DEFER**: the free data is hourly and single-book; anything built now would be noise |
| Closing-line movement toward the model | If the model sees information early, later prices drift toward it (CLV) | `record/football` CLV; information slope in the lab | correct, now with intervals | have | slope of (close − first quote) on (model − first quote) | **TESTED**: CFB not demonstrated (0.05 [−0.01, 0.16]); FBS-vs-FBS 0.11 [0.05, 0.21] and NFL 0.15 [0.05, 0.24] do not survive BH (p 0.051); forward tests H-011, H-012 |
| No-vig and hold | Remove the margin from a complete market; hold = 1 − 1/Σq | `lib/edgedesk_odds_tools.js` (4 methods), `edgedesk_calc`, others | **verified** (§3) | — | — | **KEEP** |
| Synthetic hold / cross-book | Best opposing prices across books form a lower-hold market | none computed; arbitrage flagged as a data inconsistency (`lib/edgedesk_quote_ev.js:905-916`) | the framing is right | fresh multi-book quotes, limits, fees | — | **DEFER**: the free data has one book; never display as executable |
| Derivative relationships | A book's moneyline and its spread (or halves, team totals) should be consistent | linemaker derives every market from the model's own distribution; new `DERIVATIVE_RELATIONSHIP_ANOMALY` (moneyline vs the same book's spread) | engine fitted walk-forward on logit scale | have (DK ML + spread per capture) | anomalies found, and whether one was a stale side | **BUILT**; 0 anomalies at z ≥ 3 on 2026 football (one book, consistent) |
| Rules vs model | A probability and a price must settle on the same outcome, under that season's rules | simulator rule sets by season; Kalshi rules text hashed and matched; new `RULE_DEFINITION_CONFLICT` | NFL Kalshi season check was missing (D-4, fixed); MLB step 3 probably wrong (D-12) | rule texts | conflicts found | **FIXED/BUILT**; MLB step 3 open |
| Model vs market as forecasts | Score both on the same games, with a benchmark chosen before outcomes | new `lib/edgedesk_validation_lab.js` + `validation_report.js` | point-in-time benchmark (`marketAt`) fixed in code | have | paired Brier / MAE, information slope, calibration | **BUILT**; results in `VALIDATION.md` |
| Angles vs trends | A pattern needs a mechanism, a pre-registered test, out-of-sample data and multiplicity control | new `hypotheses.json` + `judge()` (mechanism, failure mode, window, acceptance; leave-one-cluster-out robustness; BH across information tests); existing: NFL v2 and CFB v2 pre-registration | — | — | — | **BUILT**; no trend-mined signal exists in EdgeDesk, and none was added |

---

## 6. Signal pipeline (Phase 6 groundwork)

*Written before the Signal Center (#737) was merged; see the update in §1. Integration now targets that system, not the design below.*

**Where a market-intelligence finding should go**, from the read-through of the existing infrastructure:
1. **Event store:** generalise the `cfb_market_events` pattern (closed vocabulary, hashed ids, pregame-only and append-only enforced in SQL, the no-myth wording check) to a multi-sport table, RLS on the fail-closed `sim_viewer_entitled()` pattern.
2. **Delivery:** extend `user_alerts` kinds and `alert_preferences` with toggles that default **off** (per-reader dark launch); the bell, dedupe, cooldown and copy rule then come with no new code.
3. **Shadow first** behind a server switch; `EDFlags` must not be used in the terminal (a test forbids it).

**Not done in this session, on purpose:** no finding kind has yet shown value beyond data-quality warnings (`MARKET_INTEL_BACKTEST.md`), so nothing was wired to subscriber alerts. The engine's findings already carry everything the store and the bell need (`finding_id`, `severity` in the bell's vocabulary, `importance` with parts, sources, the seven-part explanation, the wording guard).

---

## 7. What this audit did not verify

- Any claim marked (reported) in §2–§4.
- Production database state: policies and functions defined only in production (`has_active_sub`, `paywall.sql`, `signals` DDL) are not in the repository.
- Browser rendering of any page (no UI was changed).
