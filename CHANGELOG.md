# Changelog

## 2026-10-01 — profit and loss of every flagged edge, written by the database at settlement

Every flag in `signals` now carries a recorded P&L: 1 unit flat, at the price frozen when the edge was flagged. It is written in the same transaction as its settlement, and shown on the public record beside closing-line value. `docs/pnl/EDGE_PNL.md` has the full account.

- **Database** (`supabase/signal_pnl.sql`, `signal_pnl_summary.sql`, `signal_pnl_sync.sql`):
  - `pnl_grades`: one row per `sig_key`, foreign-keyed to the signal.
  - `pnl_grade_history`: append-only.
  - `pnl_summary`: by sport, tier, market, day / week / month and all-time.
  - `pnl_reconciliation()`, `pnl_verify()`, `pnl_handcheck()`.
- **The math.** +150 win = 1.50, −110 win = 0.909, loss = −1, push = 0. Void is not a bet. A missing flag price is counted and never estimated. P&L at the closing book price is stored for comparison only. Every row is stamped `calc_version = pnl-v1`.
- **The hook.** A trigger on `signals` fires on the columns `settle` and `close` write. It never fails a settlement; errors are logged and reconciled.
- **Backfill.** `pnl_backfill()` is a dry run: counts, a 20-row sample, totals per sport. `pnl_backfill(true)` commits it, idempotently.
- **`record.html#edge-pnl`**, read live from `pnl_summary`:
  - units, ROI and W–L–P;
  - Tier A vs Tier B in plain words (the tier is the one capture froze; nothing is re-classified);
  - a sport filter and a running-total chart;
  - the closing-price comparison;
  - every flag not counted, with its reason;
  - the method note.
- **Records tab:**
  - a **P&L** column on every graded row, on the receipt and in the exports;
  - the old simulated column is labelled **Sim P/L**;
  - a **P&L sync** row in Pipeline health (settled flags with no P&L row: 0).
- **Unchanged:** capture, close, settle, flags, tiers, thresholds and every model. Nothing writes to `signals`.
- **Tests:**
  - `tools/record/signal_pnl.test.js`: the math.
  - `signal_pnl_sql.test.js`: real PostgreSQL. Covers the dry run, idempotent backfill, the hook in the settlement's transaction, a sabotaged hook that still lets the settlement commit, summary = raw sum, a three-way hand-check, and RLS.
  - `signal_pnl_ui.test.js`: Chromium at 375–1440 px, fed the database's own anonymous output.

## 2026-09-30 — second follow-up: corrected intervals, the NFL regime signal (#4), the NFL neutral site, the audit's CLV cuts (#5), the two root causes (#3)

While this pass was in progress, #444 and #445 (another session) shipped items 1, 2, 3, 5 and 6 of the follow-up (the
section below). This pass re-ran their reports rather than re-implementing them. It keeps their work and adds what was
wrong or missing:
- three of their reports' bootstrap intervals were too narrow, and two "significant" claims are not;
- item 4 (an NFL regime signal) had not been done, and the NFL board priced Washington with a quarterback who is out;
- the NFL engine applied its home field at neutral and international sites;
- the CLV report did not have the cuts the audit asked for (2+ / 3+ / 5+, regime / not);
- the root causes for North Texas @ Tulsa and Syracuse @ UConn.

Every parameter below was fitted walk-forward. None was fitted on 2024-2025 before its holdout report. "Significant"
means the 95% interval excludes zero. The market is never an input to a rating.

### Corrected — the bootstrap intervals (items 1 and 5, and the first pass's #1)

**Root cause.** `regime_backtest.js`, `regime_magnitude_backtest.js` and `clv_report.js` drew their resamples from
`(seed * 1103515245 + 12345) % 2147483648` computed in doubles. The product passes 2^53, so the low bits are lost and the
sequence falls into a cycle of about 10,466 draws. A 2,000-rep bootstrap of 500+ games therefore re-used the same few
thousand indices, and every interval came out too narrow. It was found because one interval printed as [0.22, 0.32]
around a point estimate of +0.32.

**Change.** All three use an exact 32-bit generator, `seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0` (period
2^32). Each report was re-run with `--write`. `regime_backtest.js` now records `significant` in the pooled record and in
the shipped artifact.

| claim | first published | corrected |
|---|---|---|
| first pass #1: v1 regime curve vs the standard curve, walk-forward 2014-2025 (`regime_curve.js` record) | −0.030 [−0.063, −0.006], significant | **−0.032 [−0.095, +0.033], not significant** |
| #444 #1: v1 vs standard on the regime subset, 2024-2025 holdout | −0.106 [−0.229, −0.011], significant | **−0.106 [−0.226, +0.017], not significant** |
| #444 #5: CFB CLV 2022-2025, all gaps | +0.21 [+0.14, +0.27] | +0.21 [+0.13, +0.29], still excludes zero |
| #444 #5: CFB CLV 2022-2025, gap 2-4 | +0.10 [+0.02, +0.19] | +0.10 [−0.03, +0.23], now includes zero |
| #444 #5: CFB CLV 2021 | +0.12 [+0.01, +0.22] | +0.12 [−0.01, +0.26], now includes zero |

- The section below is corrected in place (the #1 table, the v1 sentence, the #5 table) and says so where it changed.
- The first pass's MAE also reads 13.479 → 13.447 instead of 13.475 → 13.445. That is the fresh public download #444
  verified against, not the generator.
- **Nothing prices differently.** The v1 curve, N = 6 and the signal are unchanged. The magnitude refit was already a
  CANDIDATE.
- **The v1 regime curve still prices, and its gain is no longer significant.** Its point estimates still favour it, and it
  cuts the standard curve's +1.68 bias on the regime subset to +0.94. Keeping or reverting it is raised in the PR as a
  decision; this pass changes neither.
- The same generator is in `tools/intelligence/validate_staking.js`, outside this audit. It is left for a separate change.

### #4 — An NFL regime signal, and the starter the model prices (Washington without Jayden Daniels)

**Root cause (Daniels).** nflverse `games.csv` pre-fills each upcoming game's quarterback with the club's usual starter,
and it had not updated Washington's played week 3: it names Daniels, who left week 2 hurt and is OUT (elbow) on the
week-3 report. The player game logs (`football/props/nfl/players.json`) show Mariota on 100% of the week-3 snaps and
Daniels on 55% of week 2's. The board read the feed's starter, so it priced Washington with Daniels for weeks 4 and 5.

**Change (the starter).**
- `app.html` `fbNflReconcileStarters` reads the NFL injury report the research card already shows
  (`football/injuries/nfl_<season>.json`). A named starter listed OUT or DOUBTFUL is not priced. The club's most recent
  other starter is: the quarterback with the most starts this season, then last season, who is not himself OUT or
  DOUBTFUL. QUESTIONABLE is not a substitution.
- It runs over every unplayed game of the season, not only the board's window.
- When the report is an earlier week's than the game, the substitution is stated as PENDING.
- A club with nobody to name prices its carried quarterback level and says the starter is unknown.
- The substitution is a data-quality note beside the number (`home_qb_note` / `away_qb_note`, `football/engine.js`),
  never a number of its own.
- `tools/football/build_nfl_slate.js` publishes the starter it priced, with its status (`SCHEDULE_FEED`,
  `INJURY_REPORT_REPLACEMENT[_PENDING]`, `STARTER_UNKNOWN`) and the scheduled starter it replaced.

**Change (the regime signal).** `football/research/nfl_regime.py` measures three events per team-game from `games.csv`,
all known before kickoff:
- `hc_new`: the head coach's tenure began this season, including a mid-season change;
- `qb_new`: the starter is not last season's primary starter;
- `qb_out`: the club has started 2+ games and this starter is not its regular starter so far.

The NFL engine's quarterback layer already moves a club by its announced starter, so the signal is fitted on what is
left: the out-of-sample residual (`nfl_oos.csv`, itself walk-forward). The fit is OLS on the home-minus-away signals,
with `hc_new` and `qb_new` split at week 6. It is walk-forward from 2006, with validation 2016-2023. 2024 and 2025 were
scored once, with the fit through 2023, which is the shipped fit. `football/nfl/regime_nfl.js` carries the fit and its
record.

| regime subset (either side: `hc_new` or `qb_new` in weeks 1-6, or `qb_out`) | games | MAE model → adjusted | Δ [95% CI] | bias (regime side) |
|---|---|---|---|---|
| validation 2016-2023 | 1,062 | 10.224 → 10.085 | −0.139 [−0.275, −0.012] | +1.30 → +0.09 |
| **holdout 2024-2025** | 303 | 10.509 → 10.340 | **−0.169 [−0.394, +0.056]: not significant** | +1.29 → +0.17 |
| …2024 | 146 | 10.681 → 10.299 | −0.382 [−0.708, −0.048] | |
| …2025 | 157 | 10.350 → 10.378 | +0.028 [−0.280, +0.332] | |

- Coefficients (points to the club's side): new head coach −1.49 (weeks 1-6), −0.90 (later); new starter +0.13, −0.73;
  regular starter out −2.33.
- **Not promoted.** The adjustment prices only if the holdout interval excludes zero, and it does not. The board shows the
  signal per side and the adjustment the fit would make ("REGIME (not priced …)"), and adds nothing to the number.
- When the most starts this season are tied, the fit's own rule picks the earliest starter as "regular". The card says the
  starts are tied rather than naming a regular starter who is out.

**Live effect (model side, `football/nfl/slate.json` rebuilt at 20:41Z against main's 18:27Z build).**
- Colts @ Commanders (Tottenham): Colts by 0.80 → **Colts by 2.82**. Mariota for Daniels moves it +0.46 toward Washington
  (the engine's quarterback table rates Mariota slightly above Daniels). The neutral site (below) moves it −2.48.
- Giants @ Commanders: Washington by 2.49 → 2.95 (Mariota).
- 21 of 30 games show an active regime side, all unpriced.

### The NFL home field at neutral sites (found by item 3's home-field check)

**Root cause.** The NFL spread intercept (2.48 pts) is the fitted home-field advantage. It was applied to the nominal home
side of every game, including the international and neutral-site games nflverse marks `location = Neutral`.

**Change.**
- `football/engine.js` `nfl.predict` drops the intercept when `game.neutral === true`. The baseline term shows 0 and keeps
  its fitted weight.
- The board sets `neutral` from the feed's `location`, or from a verified international venue in
  `football/venues/nfl_stadiums.json`. The feed marks 57 of its 58 international games Neutral, including the 12 earlier
  games the Jaguars hosted. Only Eagles @ Jaguars (Tottenham, week 5) is marked Home. That game is priced neutral with a
  SITE note saying why.
- Without the venue table, only the feed's own designation counts.

**Result** (`football/research/nfl_neutral_site.js`, the walk-forward predictions on the feed's 90 neutral-site games,
2003-2025):
- The nominal home side finished 3.00 pts under the number: CI [−6.02, −0.01].
- Removing the intercept moved the MAE −0.28, CI [−0.75, +0.23]: **not significant**. This ships as a correction of what
  the term means (a neutral site has no home team), not as a fitted gain.
- Eagles @ Jaguars: Jaguars by 6.51 → 4.03. Colts @ Commanders: −2.48 of the move above.

### #5 — The audit's cuts on the CLV report (2+ / 3+ / 5+, regime / not)

**What was missing.** #444's report buckets by 0.5-2 / 2-4 / 4-7 / 7+ and has no regime split. The audit asked for 2+,
3+ and 5+ against the opener, split regime / not and CFB / NFL.

**Change.** Nothing is fitted and no cut is chosen here.
- `tools/football/clv_report.js` adds `by_threshold` to every sample: cumulative 2+ / 3+ / 5+. Each is split by the v1
  regime flag (either side's team-season fires the signal the shipped curve uses) and by games played against the curve's
  own fitted research minimum (`min_games_for_research` = 6).
- `football/cfb_p4/research/replay_rows.js` carries the flag and the projection's games-played count, on request only
  (`regime: true`). Every other number in the report is byte-identical.

| CFB replay 2022-2025 (the engine's held-out window) | 2+ | 3+ | 5+ |
|---|---|---|---|
| all: toward rate, CLV pts [95% CI] | 52.7%, +0.22 [+0.13, +0.32] | 52.8%, +0.23 [+0.12, +0.35] | 54.6%, +0.35 [+0.19, +0.51] |
| regime-flagged | 50.2%, +0.04 [−0.13, +0.21] | 49.1%, +0.01 [−0.18, +0.20] | 50.9%, +0.11 [−0.14, +0.38] |
| not flagged | 53.9%, +0.33 [+0.21, +0.45] | 55.1%, +0.37 [+0.23, +0.51] | 56.5%, +0.50 [+0.30, +0.72] |
| before 6 games played (either side) | 50.1%, +0.08 [−0.04, +0.20] | 48.4%, +0.04 [−0.11, +0.18] | 50.3%, +0.12 [−0.07, +0.30] |
| from 6 games | 55.1%, +0.35 [+0.22, +0.49] | 57.1%, +0.42 [+0.25, +0.59] | 59.4%, +0.61 [+0.35, +0.89] |

- **Reading.** The close follows EdgeDesk only on settled games. A regime-flagged gap, or one before either side has
  played six games, is followed at a coin flip at every size.
- 2021 (the engine's tune season, never pooled) shows the same direction: before 6 games 45.5%, from 6 57.0% at 2+.
- **NFL and CFB 2026:** 24 and 54 games at 2+, too small to read, with no flags on their rows. NFL history cannot be
  measured: no opener archive exists.
- **Leakage.** No readable cut is over 60% (the test holds it).
  - The replay projects each game before absorbing it, and no market field enters a projection.
  - Its state at kickoff also holds the week's earlier games, which the market also sees by the close.
  - N = 6 was fitted in the first pass on 2014-2025 by another criterion, so this split is not an independent test of it.
- **Proposed, not applied:** a WORTH RESEARCHING label at 5+ should require both sides to have played six games (the
  curve's own N, which today gates regime-flagged teams only). A regime-flagged gap should not be researched on its size
  alone. The 2-point threshold stays.

### #3 — Root causes: North Texas @ Tulsa and Syracuse @ UConn

The explainer's terms (#444) are exact additive pieces of the projection, so each term *is* the move a counterfactual
re-projection makes with that factor turned off. Below, each is credited undiscounted, and only toward closing the gap.
#444's explainer instead discounts each by how much the close has historically taken out. From the committed
`football/fbs/slate.json` (`disagreement_inputs.explainer_terms`).

**North Texas @ Tulsa.** EdgeDesk has North Texas by 9.24. The market has Tulsa −1.5 (one book, last capture). Gap:
10.74 toward North Texas, of which 10.00 (93%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| North Texas's long-run 2025 rating, still weighted 69% at four games (regime curve; 80% standard) | 7.56 | 70% |
| the matchup term: 2025 efficiency carried at half weight (`carry_eff` 0.5) | 2.44 | 23% |
| home field above the fitted 2.58 (4.08 applied) | favours Tulsa; widens the gap | 0 |
| conference | same conference | 0 |
| unexplained | 0.74 | 7% |

- **Root cause:** 2025 North Texas production is still counted as 2026, through the long-run prior and the matchup
  term's efficiency carry.
- On this season's centred track alone, North Texas is still 3.3 pts better than Tulsa.
- **Baylor Hayes** is Tulsa's quarterback (slot 1 on its depth chart; Dexter Williams II started the last game). His
  questionable status is **not read**: no availability record reached Tulsa's quarterbacks (UNKNOWN), and the college QB
  term prices 0 pts. His status could not have caused this gap.
- **North Texas's roster inputs are read correctly** after the coaching exodus. The regime record shows:
  - a new head coach;
  - returning roster share at the 8th percentile;
  - returning production at the 1st;
  - transfers out at the 87th.
- EdgeDesk's own V2 has North Texas by 5.9, between V1 and the market.

**Syracuse @ UConn.** EdgeDesk has UConn by 7.75. The market has Syracuse −6.5 (stale). Gap: 14.25 toward UConn, of which
4.10 (29%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| UConn's long-run rating (new coach, 2nd-percentile returning production; weighted 69%) | 2.60 | 18% |
| home field above the fitted 2.58 (Rentschler gets the league constant 4.08) | 1.50 | 11% |
| conference (UConn is independent) | 0 | 0 |
| unexplained | 10.15 | 71% |

- Ruled out:
  - **Misjoined results:** all 328 FBS results were checked against ESPN box scores before the network closed, and none
    differ.
  - **Schedule strength:** consistent. UConn's this-season number rests on 48-20 at Southern Miss and 14-38 vs Maryland.
  - **Orientation:** the first pass's #5 holds it as DATA FAULT.
- **Root cause:** the model, not the data. V1's margins-only rating still has UConn 1.3 pts better on this season's track
  alone, and the market has Syracuse about 9 better on a neutral field. EdgeDesk's own V2, on efficiency, has Syracuse by
  3.2: it sides with the market. The game stays DATA FAULT.

**Not done in this pass: the "unexplained disagreement" DATA FAULT rule and the research page's "why EdgeDesk disagrees"
section.** #444 put its explainer in the terminal's artifacts (`games.json`, `board.json`); no page renders it yet. With
its discounted terms (holdout R² 0.03), the unexplained part averages 89% of a 7+ gap on its own holdout (8.74 of 9.85
pts), so the rule would flag most large gaps. With the undiscounted terms above, North Texas @ Tulsa is 7% unexplained and
Syracuse @ UConn 71%. Which explainer drives the rule is a decision, raised in the PR. Nothing is excluded from ranking
until it is made.

### #6 — Live re-run: still not possible

At 2026-09-30T20:54Z this environment's network policy refused the capture host (`iattxbkbufslbauoumga.supabase.co`), The
Odds API, ESPN and CollegeFootballData. nflverse (GitHub) was reachable, which is how the NFL slate was rebuilt. No
market number here is reported as current. The Colts props group was not re-run.

### Pre-existing failures on `main`, unchanged here

- `football/cfb_terminal/tests.js`: the terminal build throws at `lib/cfb_terminal.js:1322` (`K.sd.toFixed` on a null
  SD). Texas Southern @ Florida Atlantic has only one independent model number, so its agreement tier is null at an 18.8-pt
  gap. The line is from 0314762b. A fail-closed guard is proposed separately.
- `tools/bettor/decision_ui.e2e.js`: the NFL card reads "…ResearchLabPASS…", and the test's `\bPASS\b` finds no word
  boundary after "Lab".
- `football/cfb_validation/divergence_backtest.js` needs a local replay cache that is not in the repository.

### Tests

- `tools/football/nfl_regime.test.js` (60 checks, new):
  - the fit's provenance: holdout never fitted, walk-forward, significance from the interval, promotion rule, no market
    input, signals known before kickoff;
  - the engine: the neutral site removes exactly the intercept and nothing else; the regime never reaches a number; the
    notes are stated and never priced;
  - the board helpers;
  - the real slate builder on fixture feeds: OUT → PENDING replacement, DOUBTFUL → STARTER_UNKNOWN, QUESTIONABLE kept,
    every unplayed game reconciled, both sides' regime, the Home-marked international venue priced neutral, an unreadable
    injury report said;
  - the committed slate and the neutral-site report.
- `tools/football/clv_report.test.js` §4 (9 checks): the cuts are cumulative; the regime and games-played parts add up; the
  minimum is the curve's; the 2026 samples say "not available"; no readable cut over 60%.
- `tools/football/regime.test.js`: the curve's record states its significance from its interval, and says it is not
  significant.
- A 326-file sweep of every test the workflows and `package.json` run: 323 pass. The three above fail identically on
  `main`.

## 2026-09-30 — CFB board market integrity: Step 1, the read-only audit

Nothing on the board changed. The week-5 board said NO MARKET for games the providers were quoting. This adds
the tools that measure where the quotes go missing, and a report
(`docs/cfb-board-integrity/AUDIT.md`) with every root cause reproduced before any fix:

- `tools/football/cfb_board_audit.js`: provider events → matched → shown with a market, Market vs the latest
  consensus, false staleness, week scoping and duplicate teams, over the committed ledger and board.
- `supabase/audits/cfb_board_market_audit.sql`: the same questions against production (`signals`, `cfb.games`,
  `cfb.lines`, `cfb_lab_market_quotes`). It is one read-only `select`.
- `tools/football/cfb_board_repro_app.js`: the board's own functions, lifted from `app.html`, on the rows each bug
  needs.
- `docs/cfb-board-integrity/FINDING_cover_probability_sd.md`: the "SD near 8" rows, investigated. The model is not
  changed.

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
| all FBS games (1,604) | 12.594 | 12.559 | 12.579 | −0.015 [−0.055, +0.023] | +0.020 [−0.013, +0.053] |
| v1 regime subset (537) | 13.027 | 12.921 | 12.946 | −0.080 [−0.181, +0.022] | +0.025 [−0.048, +0.099] |
| heavy turnover (284) | 12.719 | 12.662 | 12.619 | −0.101 [−0.256, +0.050] | −0.043 [−0.146, +0.061] |
| stable (80) | 13.536 | 13.536 | 13.542 | +0.006 | +0.006 |

- Bias on the regime subset (+ = the model overrates the flagged team): standard **+1.68**, v1 +0.94, v2 +0.79.
  The standard curve's figure is about 2.3 standard errors from zero.
- **v1 against the standard curve on the regime subset: −0.106, 95% CI [−0.226, +0.017]. Not significant.** *(Corrected in
  the second follow-up. This was first published as significant, CI [−0.229, −0.011], from a bootstrap whose generator
  cycled; see that section. The table's intervals above are the corrected ones.)* Its 2021-2023 refit gives the identical
  curve (w0 0.75, λ 0.02), so its sight of 2024-2025 did not change it.
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

### #2 — A σ-scaled EV plausibility check replaces the flat 25% guard (VERIFIED MAJOR is reachable)

**Root cause.** The first fix bounded raw EV at a flat 25% on a main-line spread. EV is a price-dependent function of
the gap measured in the game's own distribution width, so "25%" meant a different gap in every game. At −110 a
college gap of about 6 points already prices past it.
- A synthetic game that passed every gate read INVESTIGATE ("implausible EV") at every gap of 7+ pts, for any σ from
  13 to 16.
- On the 2024-2025 holdout the flat bound flagged **19.7%** of real college games and **26.0%** of NFL games.
- It left VERIFIED MAJOR reachable on **2.6%** of real CFB 7+ gaps, and on **0%** of NFL ones.

**Change.**
- `lib/edgedesk_quote_ev.js` `implausibleEv(g, model)`: a main-line quote is implausible when
  `z = |fair home margin − the quote's home margin| / σ` exceeds `PLAUSIBLE_Z[sport]`.
  - σ is `distributionSpread(model.home_cover)`: half the central-68% width of the same distribution the EV is priced
    from.
  - Where no width can be read (no fitted sport), the flat 25% bound applies and says so.
- `tools/football/ev_plausibility.js` fits z* as the declared 99.5th percentile of z over correctly-joined games in
  2021-2023, from cold replays of both shipped engines. The market is never an input to a projection. It then scores
  2024-2025 once. The result is `football/validation/ev_plausibility.json`: CFB z* = **0.960** (≈15.7 pts at the
  typical σ 16.3), NFL z* = **0.997** (≈13.0 pts at σ 13.0).
- **The stake is not loosened.** The flat 25% line is kept as `large_ev`, read only by the decision layer's new
  `LARGE_EV` cap (WATCH, no stake). Every decision the old guard held at WATCH is still WATCH with 0 units. A plausible
  large gap now reads VERIFIED MAJOR as a research status, and still carries no stake.
- `lib/edgedesk_canon.js` prints the quote-EV layer's own reason. `lib/edgedesk_decision.js` words IMPLAUSIBLE_EV in σ
  terms.

**Holdout (2024-2025, never fitted).**

| | CFB σ-scaled | CFB flat 25% | NFL σ-scaled | NFL flat 25% |
|---|---|---|---|---|
| real games flagged | 0.69% | 19.7% | 0.18% | 26.0% |
| real 7+ gaps left reachable for VERIFIED MAJOR | 95.2% (of 229) | 2.6% | 98.4% (of 62) | 0% |
| synthetic flipped side caught, with the orientation invariant and the 21-pt guard | 74.6% | 92.5% | 39.8% | 77.0% |
| synthetic mis-joined market caught, same stack | 47.5% | 81.7% | 17.8% | 60.9% |
| synthetic line off by 7 pts caught, same stack | 13.2% | 98.6% | 19.3% | 99.8% |

**What this costs.** Most of the old guard's catch rate came from flagging one real game in five. A line that is wrong
by 7 points cannot be told apart from a real 7-point disagreement by its size alone. That job belongs to the checks
that look at the quote rather than the gap:
- the market-consensus MARKET FAULT (first pass #2/#3);
- the stale-capture rules;
- the integrity gate that VERIFIED requires.

This is stated, not tuned away.

**Tests.**
- `tools/football/quote_ev.test.js` §14 (rewritten for the new rule):
  - the σ reading;
  - a 1.04 σ gap is implausible;
  - a +30% EV at 0.61 σ is not implausible, but is LARGE;
  - an alternate is exempt;
  - the flat fallback;
  - the constants equal the fitted artifact, and the artifact's holdout numbers;
  - **verified 7, 7.5, 9 and 11-pt college gaps at −110 read VERIFIED MAJOR**;
  - a 16-pt gap is still "implausible EV, check data";
  - an NFL 7-pt gap reads VERIFIED MAJOR.
- `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`: six scenarios move from WATCH ·
  IMPLAUSIBLE EV to WATCH · LARGE EV, all still with no stake. The gaps past z* stay IMPLAUSIBLE EV.

### #3 — A disagreement explainer (North Texas @ Tulsa, Syracuse @ UConn)

**What was missing.** A research label says how large a disagreement is and whether it passed the integrity gate. It
never says why. The 2026-09-27 forensic report decomposes EdgeDesk's number, not the gap between it and the market.

**Change.**
- `lib/edgedesk_explainer.js` splits a gap into eight terms read off the engine's own projection:
  - the rating scale;
  - last season's share of the rating, `w·(long-run − this season − track offset)`, and that share on a turned-over
    roster;
  - the home-field constant;
  - QB change;
  - conference;
  - matchup;
  - the rest.

  None of the terms comes from the market.
- `tools/football/explainer_fit.js` fits how much of each term the closing market has historically taken out. It runs
  OLS of `fair − close` on the terms over 2021-2023 FBS games (cold replay, `replay_rows.js --explainer`), scores
  2024-2025 once, and ships a 2021-2025 refit (`football/validation/disagreement_explainer.json`).
- Explained is the intercept plus Σ β·term. Unexplained is the rest.
- `football/cfb_p4/engine.js` publishes the tracks' centres in `layers.strength.track_centres`, for display only; no
  number reads them back.
- `football/fbs/build_coverage.js` publishes the market-free terms in `disagreement_inputs.explainer_terms`.
- `football/cfb_terminal/build.js` explains each game against the consensus it already shows (`games.json`
  `disagreement_explainer`, and a compact form in `board.json`).

**The fit (2021-2023, every term |t| ≥ 1.96).**

| term | β | what it says |
|---|---|---|
| home field | +0.43 | the market gives about 1.8 pts less home edge than the engine's 4.08 constant |
| QB change | +0.50 pts | the market prices a new starter the engine's (usually unavailable) QB term does not |
| last season's share | −0.42 | the market leans on last season *more* than the engine's this-season track does |
| …on a turned-over roster | +0.50 | …except on a turned-over roster, where it takes that back (net ≈ +0.08) |
| conference | +0.19 | |
| rating scale | −0.03 | |

- Matchup and "other" are 0 in every replayed game, because the cold replay has no efficiency or injury feed. They
  ship unfitted: shown, never discounted.
- **Holdout 2024-2025: R² = 0.03.** Mean |gap| 3.92 against mean |unexplained| 3.67; for 7+ gaps, 9.85 against 8.74.
  The measured terms explain a sliver of model-market disagreement, and the explainer says so rather than overstating
  it.

**Applied (terminal build of the committed 2026-09-30 captures, SNAPSHOT).**

| North Texas @ Tulsa: gap 10.74 toward North Texas (market Tulsa −1.5, one book) | term | β | explains |
|---|---|---|---|
| last season's share | −7.56 | −0.36 | +2.74 (toward Tulsa) |
| …on a turned-over roster (North Texas, index 0.86) | −4.84 | +0.48 | −2.33 (toward North Texas) |
| home field | 4.08 | +0.39 | +1.60 |
| rating scale | −10.89 | −0.02 | +0.21 |
| matchup (unfitted) | −2.44 | — | 0 |
| **unexplained** | | | **12.87 toward North Texas** |

The measured terms, taken together, lean 2.1 pts toward Tulsa, so nothing measured explains this gap. Even on this
season's centred track alone, North Texas rates about 4 pts better than Tulsa, and the market disagrees with that as
well. What remains is the market's view of this season's North Texas.

| Syracuse @ UConn: gap 14.25 toward UConn (market Syracuse −6.5, stale) | term | β | explains |
|---|---|---|---|
| home field | 4.08 | +0.39 | +1.60 |
| last season's share | +2.60 | −0.36 | −0.94 |
| …on a turned-over roster (UConn, index 0.87) | +0.58 | +0.48 | +0.28 |
| **unexplained** | | | **13.47 toward UConn** |

It remains DATA FAULT ("possible orientation flip", first pass #5) at a stale capture.

**Tests.** `tools/football/explainer.test.js` (21 checks, added to `football:audit:test` and `cfb:test`):
- the terms are exact pieces of an engine projection (prior share with the published offset, turnover index,
  contributions, QB change), with no market argument;
- explained + unexplained = the gap;
- unfitted terms are shown, never discounted;
- the fit's windows, significance flags and unfitted list;
- the slate and terminal wiring.

### #5 — A closing-line-value validation report

**What was missing.** The existing movement validation (`football/validation/movement_cfb.json`) tests CFBD's pregame
Elo, not EdgeDesk's own number. The scorecard has 6 packets and no reading. Nothing answered whether the market moves
toward EdgeDesk between the opener and the close.

**Change.** `tools/football/clv_report.js` writes `football/validation/clv_report.json`. Nothing is fitted, and the
market is never an input. Per game, on home margins:
- side = sign(fair − open), with no side under 0.5 pt;
- CLV points = side × (close − open);
- CLV probability = the cover probability of that side at the opener, on a distribution centred at the close, minus
  the same at the close.

Each sample reports games, the rate at which moved lines moved toward EdgeDesk (two-sided binomial p), mean CLV with a
bootstrap 95% CI, per season and per gap bucket. Samples under 100 moved games read "too small to read".

**Result.**

| sample | games | moved toward EdgeDesk | p | mean CLV (pts) | CLV (prob) |
|---|---|---|---|---|---|
| **CFB replay 2022-2025**, the engine's held-out window (hyperparameters tuned 2018-2021) | 2,843 | **52.9%** of 2,492 | **0.005** | **+0.21** [+0.13, +0.29] | +0.53 pp |
| …gap 0.5-2 | 737 | 53.2% | 0.11 | +0.16 [+0.02, +0.30] | +0.41 pp |
| …gap 2-4 | 846 | 51.2% | 0.56 | +0.10 [−0.03, +0.23] | +0.28 pp |
| …gap 4-7 | 795 | 52.1% | 0.27 | +0.21 [+0.06, +0.36] | +0.54 pp |
| …gap 7+ | 465 | **56.6%** | **0.009** | **+0.47** [+0.23, +0.74] | +1.19 pp |
| CFB replay 2021 (in-sample for the engine's tune; never pooled) | 686 | 50.8% | 0.74 | +0.12 [−0.01, +0.26] | +0.25 pp |
| CFB 2026 live (frozen record numbers vs the Model Lab's earliest capture) | 68 | 45.1% of 51 | 0.58 | +0.04 [−0.24, +0.35] | too small to read |
| NFL 2026 live (EdgeDesk's own opener ledger; no historical NFL openers exist) | 29 | 71.4% of 21 | 0.08 | +0.45 [−0.28, +1.14] | too small to read |

- By season 2022-2025 the toward-rate is 50.3%, 54.0%, 52.6% and 54.2%.
- *(Intervals corrected in the second follow-up: the report's bootstrap generator cycled, so the first-published
  intervals were too narrow. The 2-4 bucket and the 2021 sample no longer exclude zero; the headline still does.)*
- The college engine's pregame number has shown small, positive, statistically significant CLV on its held-out window,
  concentrated in the 7+ gaps.
- **This is a replay, not a record.** The replay's state is the one at kickoff, which also holds other games played
  between the opener and kickoff.
- The two live 2026 samples are too small to say anything yet.

**Tests.** `tools/football/clv_report.test.js` (16 checks, in `football:audit:test`) covers:
- the sign conventions;
- no side under 0.5 pt;
- a missing line is no CLV;
- the NFL price value;
- the summary arithmetic and the floor;
- the artifact's windows (headline 2022-2025, 2021 apart);
- that the market is not an input and nothing is fitted;
- that each reading follows its own numbers.

### #6 — Re-run both boards live: not possible from this environment

The live capture host (`iattxbkbufslbauoumga.supabase.co`) is denied by this environment's network policy. So are The
Odds API, CollegeFootballData and the SBR odds archive. No board was re-run live. The before/after tables in the PR
use the latest bot-committed captures, and every row is labelled SNAPSHOT with its capture time.

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
- **Corrected (second follow-up):** that interval came from a bootstrap whose generator cycled after ~10,466 draws.
  Re-run with an exact generator it is −0.032, CI [−0.095, +0.033]: **not significant**. The artifact now records
  `significant: false`.
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
