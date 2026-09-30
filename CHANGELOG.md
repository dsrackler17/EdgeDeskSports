# Changelog

## 2026-09-30 — audit follow-up: verification of the first pass, and the second pass

The first pass (the section below) was re-verified from its code and data before anything here was changed. Its
regime backtest reproduces from a fresh download of the public data (held-out MAE 13.479 → 13.447 against its
reported 13.475 → 13.445; the same curve, the same N = 6, an engine self-check of 7e-15); its eleven test suites
pass. Nothing of the second pass had been started. Each item below says what the data supports, including where it
does not support what the audit expected.

### #1 — The regime prior as a continuous magnitude (a CANDIDATE: it did not beat v1, so it does not price)

**Root cause of "Iowa State still ≈ −9 against West Virginia".** There were no magnitude inputs to wire in. The v1
signal is a yes/no, so Iowa State (4th-percentile returning production), North Texas, UConn, Penn State and Virginia
Tech (36th percentile) all got the same 69% long-run weight at four games. West Virginia (3rd-percentile returning
roster, no coach change) got no adjustment at all. The v1 fit also started in 2007, and the curve it ships was fitted
on seasons through 2025. The QB change and portal inflow were not inputs anywhere.

**Change.**
- `football/cfb_p4/research/build_regime_history.py` now also measures:
  - portal inflow, production-weighted: last season's units produced at another programme by players on this roster
    (the rating-weighted alternative needs a keyed feed; this was agreed as the substitute);
  - last season's primary QB and whether he is on the roster;
  - every team-game's starter (`qb_starts.csv`).

  `--current 2026` writes the same fields into `returning_production_2026.json` (schema v2).
- `football/coaching/regime_signal.js` holds the one magnitude definition. It has four hinge features, each zero at or
  better than the season median: new coach, returning production, QB change (the starter of the team's last completed
  game vs last season's primary QB), and portal inflow. An unmeasured input is 0.
- `football/cfb_p4/research/regime_magnitude_backtest.js` replays the shipped engine cold and fits on 2021+ only:
  - **A. Selection.** Three pricing forms (a weight cut onto the raw this-season track, the same onto the centred track,
    a signed level shift on the long-run rating) are fitted on 2021-2022 and scored on 2023.
  - **B. Holdout.** Each form is refitted on 2021-2023 and scored once on 2024-2025, which no fit it is judged on ever
    saw.
  - **C. Ship.** The chosen form is refitted on 2021-2025 and promoted only if the holdout shows it no worse than the
    standard curve and than v1.
- Disclosure: two of the three forms were each scored on the holdout once while the list of forms was being built, so
  read the holdout intervals as optimistic.
- `football/cfb_p4/engine.js` supports both v2 forms (`magnitude`, `prior_shift`). `football/matchup/contract.js`
  forwards them only when `priced`. `football/coaching/build_regime.js` publishes every programme's v2 inputs,
  features and magnitude under `by_team.<key>.magnitude`, with `priced: false` while the artifact is a candidate.

**Result (2024-2025 holdout, never fitted).** Stage A chose `w_raw` (2023 MAE 13.108; standard 13.126).

| subset (games) | standard | v1 (ships) | v2 w_raw | v2 − standard | v2 − v1 |
|---|---|---|---|---|---|
| all FBS games (1,604) | 12.594 | 12.559 | 12.579 | −0.015 [−0.044, +0.022] | +0.020 [−0.008, +0.036] |
| v1 regime subset (537) | 13.027 | 12.921 | 12.946 | −0.080 [−0.193, +0.017] | +0.025 [−0.056, +0.109] |
| heavy turnover (284) | 12.719 | 12.662 | 12.619 | −0.101 [−0.246, +0.065] | −0.043 [−0.133, +0.048] |
| stable (80) | 13.536 | 13.536 | 13.542 | +0.006 | +0.006 |

- Bias on the regime subset (+ = the model overrates the flagged team): standard **+1.68**, v1 +0.94, v2 +0.79.
  The standard curve's figure is about 2.3 standard errors from zero.
- **v1 against the standard curve on the regime subset is significant: −0.106, 95% CI [−0.229, −0.011].** Its 2021-2023
  refit gives the identical curve (w0 0.75, λ 0.02), so its sight of 2024-2025 did not change it.
- **No v2 form is significantly different from v1, and v2's point estimates are slightly worse.** It is not promoted.
  `football/cfb_p4/regime_magnitude.js` ships as `CANDIDATE`, fitted on 2021-2025 as coach 0.25, returning production
  0.05, QB 0, portal inflow 0. That would put Iowa State's long-run weight at about 60% at four games (×0.74), not under 50%:
  2021-2025 does not support the deep cut the audit expected.
- A fit-years-only diagnostic found the same thing. The best multiplier on the long-run weight is 0.8-0.85 for
  turnover profiles, and 1.0 for the most Iowa-State-like one (new coach, returning production at or under the 10th
  percentile, heavy inflow; 46 games).

**Found on the way: the this-season track is offset.** It starts every programme at `init_rating` (−12), and its FBS
mean stays about 8.6 pts under the long-run track's at every games-played count, 2021-2025 (sd 7.9-9.6 against
8.8-9.5, correlation 0.90+ from four games).
- The standard blend cancels this in the gap, because both teams share one weight. A per-team cut does not: moving
  weight onto the raw track also docks the team about Δw × 8.6 pts for no football reason.
- Iowa State's this-season −7.42 after four games is roughly where Iowa State 2025 (8-4) stood at the same point
  (−8.4). It is not by itself evidence that the team is bad.
- The v2 engine path moves the cut onto the centred track (`trackCentres`). v1 keeps the raw track, as it was fitted and
  validated, and its accidental level shift is part of why it works: regime teams really are overrated by their
  long-run rating.

**Unchanged by design.** All 109 games of a rebuilt `football/fbs/slate.json` have identical model margins and regime
weights (0 differences). Georgia and Ohio State have zero magnitude (the same coach and QB, continuity above the median).

**Tests.** `tools/football/regime.test.js` §9 (24 new checks) covers:
- the hinges and the unmeasured-input rule;
- both engine forms, exact to 1e-9, with the centring on and off;
- that magnitude 0 is the standard curve exactly;
- that a v1 record is byte-identical;
- the contract gating (an unpriced magnitude never reaches the engine);
- the artifact's provenance and verdict;
- the published 2026 record (Georgia and Ohio State at zero; Iowa State and North Texas new coach, new QB, bottom
  decile);
- `qbChangeOf`.

## 2026-09-30 — audit fixes: Week 5 CFB / Week 4 NFL board

These fixes come from a manual audit of the Week 5 CFB / Week 4 NFL board. They are listed in the audit's priority order.
No research gate or label definition was loosened. Where two copies of a rule disagreed, the stricter one was kept.
The "research, not picks" framing is unchanged.

### #1 — Regime change (Iowa State, North Texas, Penn State)

**Root cause.** Every programme's pricing state used one learned prior curve (`football/cfb_p4/params.js`,
`blend.prior_weight_by_week`): 100% long-run rating through 3 games, 80% at 4–5, 60% from 6.

For a programme whose coach and roster left, most of the Week 5 number still described the team that left:
- Iowa State: Campbell to Penn State.
- North Texas: Morris and the roster to Oklahoma State.
- Penn State: Franklin out.

Nothing in the repository supplied a coaching-change or roster-turnover signal. The coach table also had no 2025 row for
Penn State or Virginia Tech, so their changes could not be dated.

**Change.**
- `football/coaching/regime_signal.js` (new) holds the one definition of the signal, used by the fit, the builder and the
  tests. The signal fires on a new head coach AND roster continuity at or below the season's FBS median, or transfers out
  at or above its 75th percentile.
- `football/coaching/build_regime.js` (new) writes `football/coaching/regime.json` from:
  - `continuity.json`
  - the ESPN rosters, diffed on athlete id
  - `returning_production_2026.json`
  - `regime_overrides.json`, a hand-maintained, dated and sourced table (`team, season, new_coach,
    returning_production_pct`), documented in `football/coaching/README.md`
- `football/coaching/build_coaching.js` now walks back past a missing season when dating a tenure.
- `football/cfb_p4/research/regime_backtest.js` fits a separate, steeper curve walk-forward, on seasons before each one
  it is scored on: `w = min(w_standard(g), w0·e^(−λg))`, with w0 = 0.75 and λ = 0.02.
  - The fitted curve is written to `football/cfb_p4/regime_curve.js`.
  - The engine (`blendedRating`) applies it to a regime programme's long-run state.
  - The flag is also carried on a promoted canonical rating.
- **REGIME CHANGE flag.** `lib/edgedesk_canon.js` blocks WORTH RESEARCHING and VERIFIED MAJOR until the team has played
  N = 6 games. The status reads INVESTIGATE, with the flag and the team named.
  - N comes from the held-out cover-rate table: the first 2-game bucket from which regime games cover within 2.5 pp of
    every other game.
- The board, the published build (`football/fbs/build_coverage.js` via `football/matchup/contract.js`), the research
  terminal and the props model all read the same record.

**Backtest.** Held-out 2014–2025, 2,203 games involving a regime team (`report/regime_backtest.json`):

| metric | standard curve | regime curve |
|---|---|---|
| MAE vs the final margin | 13.475 | 13.445 |
| mean \|fair − close\| | 4.249 | 4.206 |

- The MAE change is −0.030, 95% CI [−0.063, −0.006], and 7 of 12 seasons improved.
- The engine self-check re-projects 128 games; they match the counterfactual to 7e-15.

**Tests.**
- `tools/football/regime.test.js` covers the signal, the walk-back, the fitted curve, the engine shift (exactly
  (w_regime − w_standard)·(long-run − this season)), the contract, the research gate, the season record, the overrides and
  the published slate.
- `tools/football/label_parity.test.js` checks Pitt @ Virginia Tech in every view.

### #2 — Stale CFB market capture

**Root cause.** `fbP4Market` (app.html) used cfb.lines whenever the captured quote was older than its freshness window.
cfb.lines carries no book and no timestamp, and the board treated it as a current market (`stale: false`).

The gap, the label and the research priority were therefore measured against a different snapshot from the one the price
line prices, which reads captured quotes. The captured number itself was the first home `spreads` row returned (see #3).

**Change.**
- The market is the consensus of the CURRENT captured quotes (`fbMarketFromEvent`), which is the snapshot the price line
  prices.
- With no current quote, the consensus of every row is marked stale.
- cfb.lines is kept only as a labelled reference. Used alone it is STALE and reads STALE MARKET, and it is excluded from
  ranking (`rankable: false`).
- **Invariant.** |market spread − consensus of its own quotes| ≤ 1.5, else MARKET FAULT with the reason
  (`EDCanon.marketConsensusFault`). A MARKET FAULT is excluded from ranking.

**Tests.** `tools/football/market_join.test.js` (new), `tools/football/fbs_board_ui.test.js`,
`tools/app/worth_researching_ui.test.js` (reference-only fixtures read stale) and `tools/validation/canon.test.js`.

### #3 — NFL market mapping (SEA −3.0, BUF −3.0)

**Root cause.** `fbMarketFromEvent` took whichever home `spreads` row PostgREST returned first. It set the market's time
to the newest capture of any row.

`signals` keeps a row per point for good, and the capture files alternates under `market='spreads'`. So an August
look-ahead or an alternate at −3 stood as "the market" and looked minutes old, while every book dealt −6.5/−7.

**Change.**
- The main line is the books-weighted mode among the capture's modal rows, falling back to all current rows. It is
  timestamped by its own capture.
- **Self-check.** `fbNflMarketSelfCheck` fails the board (a banner above the rows) if any game's main line sits more than
  1.5 pts from the books-weighted median of its own captured books. That game reads MARKET FAULT.

**Tests.** `tools/football/market_join.test.js` (new) replays the audit's row order and covers:
- the self-check failing the board
- stale-only and reference-only markets
- the college path

`tools/articles/pipeline.test.js` also pins the sign convention of a replayed quote.

### #4 — NFL EV on the opposite side from the displayed model

**Root cause.**
- The NFL cover probabilities came from the margin tables centred on their mean, not their median. A table's median sits
  1–2.5 pts inside its mean, so at the market line the distribution could favour the side the displayed fair margin was
  against.
  - LAC @ SEA, model SEA −9.24, line −7: SEA −7 priced 49.6% and LAC +7 50.4%.
  - NE @ BUF, model BUF −7.18, line −7: NE +7 priced 56.2%, +6.9% EV.
- Separately, the NFL pricing blend could cross the market to the other side. CIN @ MIA: the model has CIN by 1.8, the
  market CIN −8.5, and the blended fair line was CIN −8.66, so the priced side was CIN.

**Change.**
- `football/engine.js` `centredOn` mixes adjacent tables so the distribution's continuous median is the fair margin
  exactly. Past one side's range it mirrors the other side's table; past both, it shifts the nearest extreme table.
- The kernel (`_pricing.js`) and the board hold the blend at the model side's 50% cover point when it would cross the line
  (BLENDED_HELD).
- **Invariant** (`lib/edgedesk_quote_ev.js` `sideInvariant`), checked on the one projection object that feeds both the
  display and EV:
  - If the model is past the line on side X, no side-Y quote at the same or a worse number may carry positive EV.
  - A violation is EV_SIDE_CONTRADICTION: NO DECISION, logged to `console.error`.
  - A display/EV centre mismatch of more than 0.5 pts is PROJECTION_MISMATCH.
- `tools/football/build_nfl_slate.js --reprice` recomputes the slate's pricing block.

**Tests.**
- `tools/football/quote_ev.test.js` §14: medians, sides, spikes, LAC @ SEA, PROJECTION_MISMATCH, and a reproduction of
  the old table off-centre.
- `tools/bettor/football_decision.test.js`, `decision.test.js`, `consistency.test.js`
- `tools/intelligence/pricing.test.js` (the kernel hold)

### #5 — Orientation flip (Syracuse @ UConn)

**Root cause.** The join was oriented correctly: UConn hosts, and the captured event resolves home and away strictly. The
number was not.

`situation.conference` in `football/cfb_p4/engine.js` treated "FBS Independents" as a conference. The group's 2025
cross-conference strength (+15.21, the highest of any group) is an average over unrelated programmes. It handed UConn
+3.8 pts over every ACC team early in the season. On top of that, UConn is in a regime change (#1).

**Change.**
- An independent carries no conference strength. The term is unavailable and says why. Two conferences still get the term.
- **Invariant** (`EDCanon.orientationSuspect`): a gap over 10 pts that flipping the model's sign would bring under 5 is
  DATA FAULT "possible orientation flip".
  - The game is excluded from ranking until resolved. Only a VERIFIED gap is exempt.
  - The check applies to both the CFB and NFL boards and the terminal.

**Backtest.** Held-out 2014–2025, the 522 games of an independent against a conference team
(`football/cfb_p4/research/independents_backtest.js`, `report/independents_backtest.json`):

| metric | before | after |
|---|---|---|
| MAE vs the final margin | 13.376 | 13.185 |
| mean \|fair − close\| | 4.914 | 4.800 |

- The MAE change is −0.192, 95% CI [−0.409, +0.033], so it is **not significant**. 8 of 12 seasons improved.
- The fix ships as a correction of what the term measures, not as a fitted gain.

**Tests.** `tools/football/orientation.test.js` covers the term, the invariant, the NFL board and the published slate.
`tools/bettor/football_decision.test.js` checks that Syracuse @ UConn gets no decision.

### #6 — Pitt @ Virginia Tech: conflicting labels

**Root cause.** Each view carried its own copy of the research rule:
- the board word
- the research view
- the Research Desk's row flags (`thin` from the engine's PASS_LOW_CONFIDENCE, `fault` from the guard gap alone)
- the offline exporter (`football/cfb_p4/export_csv.js`, "RESEARCH" for every gap under 7)
- the press brief (`tools/football/press_brief.js`, a copy of the page's old rule)
- the research terminal's seven-word status, which its brief prints

None of the copies had the stale-market, orientation, regime or implausible-EV rules. They could also disagree with each
other on the confidence and reliability floors.

**Change.**
- `lib/edgedesk_canon.js` `researchStatus` is the one classifier. Where two copies disagreed, the stricter rule was kept:
  unmeasured reliability is not a pass.
- `EDCanon.boardWord` names its result on the board. All of these now read it:
  - `fbP4StatusFor`
  - the research view
  - `fbGameRows` (the Desk and Top Research Priorities: thin, fault and stale are read off the canonical status)
  - the RESEARCH FLAGS queue (shows the word and excludes non-rankable statuses)
  - the CSV export
  - the counters
  - the offline exporter
  - the Read (`lib/edgedesk_read.js`)
  - the press brief, which reads the CSV's `board_status` and classifies nothing
- The terminal's seven-word status is reconciled to the canonical status. It can only be made stricter.

**Tests.** `tools/football/label_parity.test.js` (new) stages Pitt @ Virginia Tech with Virginia Tech in a regime change,
alongside aligned, research, orientation-flip and thin-data games. It checks that the label is identical across:
- the board, the card and the CFB desk
- the Desk rows and picks
- Top Research Priorities
- RESEARCH FLAGS
- the CSV export and the counters
- the offline exporter
- the press brief
- the research terminal

`tools/football/press_brief.test.js` pins the brief to the canon.

### #7 — Player props

**(a) Edge and EV at one quote.**
- Root cause: the table's Edge column showed the model at the consensus line minus the consensus no-vig (`edgeNv`), which
  is a different line and a different price from the EV beside it. A LEAN could show a negative edge.
- Change: the column shows the candidate's own edge (probability minus the break-even of the same book, line and price as
  the EV). The consensus comparison is labelled "nv".
- Self-check: `EDProps.edgeEvAgree` means a BET or LEAN without a positive edge AND EV at its quote is demoted to WATCH
  (EDGE_EV_MISMATCH, logged).

**(b) Correlated props.**
- Root cause: the correlation model lists no pair for most cross-player props, so √(uᵀRu) summed eight 0.25U Colts props
  as independent and the 2U game cap never bound. All 8 NFL BETs were IND @ WAS, 7 of them on the Colts' offence having a
  quiet day.
- Change: every selection that wins when one offence in one game has a big (or a quiet) day is one exposure group. The
  group carries at most the stake of its largest member (GROUP_EXPOSURE), and a defender's prop is grouped on the offence
  it plays against.

**(c) Opponent defensive availability.** It is not a model input: the defensive factors are season-to-date rates. It is
now a warning flag, OPP_DEFENSE_UNMODELED, which names the defenders the opponent's latest report lists OUT or DOUBTFUL
and which week's report that is.

**(d) Regime and usage/volume priors.** On a regime-change programme, last season's share prior and team volume are scaled
by the fitted regime curve relative to the standard curve. REGIME_CHANGE caps the prop below BET until N games.

**Week bug.** "Injury report on file" meant *any* team's report for this week, so a teammate the week-3 report listed OUT
read as back. IND's Alec Pierce did, and every Colts WR share was cut ×0.85. Now:
- the on-file flag is team-specific
- a teammate listed OUT on an earlier report, with his team's current report not on file, is PENDING: no dilution and no
  redistribution
- the prop carries a teammate-uncertain flag
- the player's own earlier listing caps at WATCH (AVAILABILITY_PENDING)

**(e) Tail pricing.** Every alternate line is flagged "tail pricing, uncalibrated" (TAIL_PRICING_UNCALIBRATED) and never
reaches BET.

**Tests.**
- `tools/props/props_core.test.js`:
  - the tail A/B: the same quote is a BET as a main line and a LEAN as an alternate
  - the regime cap, `edgeEvAgree` and the opponent warning
  - exposure groups, including the audit's Colts group on the real correlation model
- `football/props/pipeline.test.js`: the week bug on the fixture (Jayden Reed), the Edge column, and the opponent's
  availability.

### #8 — EV sanity guard (all sports)

**Root cause.** Nothing bounded a spread EV. A main-line spread at +30–45% raw EV, which is almost always a data error
(a stale or mis-joined line, a flipped side), could drive a BET. Player props already had their own bound: PRICE_ANOMALY
caps an uncorroborated EV above 15% at WATCH.

**Change.** Raw EV above 25% on a main-line spread sets the research status to INVESTIGATE, "implausible EV, check data"
(`EDCanon`, rule `implausible_ev`, still rankable but penalised). It also caps the decision at WATCH
(`lib/edgedesk_decision.js`) on the CFB board, the terminal and the NFL board.

**Scope.** The guard applies wherever `lib/edgedesk_quote_ev.js` evaluates a main-line spread. That is every sport this
board prices spreads for (CFB, NFL). The other sports' pipelines price no main-line spread through this path.

**Consequence.** Against live quotes a CFB main-line gap of roughly 5.5–6 pts or more already prices above 25% raw EV, so
a verified 7+ gap reads INVESTIGATE (implausible EV) and VERIFIED MAJOR is effectively unreachable at a live price. That
is a consequence of the bound the audit set, stated here rather than tuned away.

**Tests.** `tools/football/quote_ev.test.js`, `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`.

### Artifacts rebuilt

Everything below was rebuilt with the fixed code on top of the current `main` data. The build times match the base's
latest (2026-09-30 16:00–16:07Z), so the data is the same and only the code differs.

- `football/coaching/regime.json`, `continuity.json` and `returning_production_2026.json`
- `football/fbs/slate.json`, `coverage.json`, `reliability.json` and `football/enrichment/audit.json`
- the research terminal's published files (`football/cfb_terminal/*.json|csv`, `--now` the base's build time); the
  append-only history was not written
- `football/nfl/slate.json` (repriced)
- the NFL and college props boards (at the base's board times); the decision ledgers were not appended
- `football/matchup/metrics.json` and `football/validation/model_health.json`
- `football/cfb_validation/*`, with PATCH rows for the pricing and research code changes

New scripts: `npm run football:audit:test` (regime, orientation, label parity, market join). The same tests were added to
`cfb:test`.
