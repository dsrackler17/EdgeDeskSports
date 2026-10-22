# Evaluation protocol — written before any model was scored

Committed 2026-10-13, before the first walk-forward run. Nothing in this file
is edited to suit a result. A change to the protocol is a new dated section
below, with the reason, and every result produced under the old protocol keeps
its label.

## 1. What "a prediction" is

- A game is predicted at **14:00 UTC on its date** (10:00 Eastern, 07:00
  Pacific). First-pitch times are not carried by the source; the earliest
  plausible start is taken as 15:00 UTC (11:00 Eastern), and the prediction
  must precede it. Games on the same date never inform each other.
  *(Amended 2026-10-14 from 16:00 UTC, before the first walk-forward run: an
  11:00 Eastern start would have preceded a 16:00 UTC prediction.)*
- A completed game's facts become available at **06:00 UTC the next day**.
  `assumed_available_at` is written on every row; `known_at` is blank because
  no row in this source carries a true publication timestamp. Nothing is
  backdated.
- Every scored row passes `engine/validation.leakageAudit`: inputs strictly
  before the prediction time, the prediction strictly before the event.
- Every evaluation in this directory is therefore a **RETROSPECTIVE
  RECONSTRUCTION** from final data, not a verified live-simulation backtest.
  The source can revise historical box scores (corrections to earned runs,
  scoring changes); I cannot see what the record looked like on the day.
  That is stated on every output (`point_in_time: "RETROSPECTIVE"`).

## 2. Windows

Results-only models (team strength, run distributions), 2012–2026:

| Window | Seasons | Use |
|---|---|---|
| burn-in | 2012–2013 | ratings accumulate; nothing scored |
| SELECTION | 2014–2022 | choose model families, tune hyperparameters |
| VALIDATION | 2023–2024 | ensemble weights, calibration maps, promotion evidence |
| HOLDOUT | 2025–2026 | reported once per model version; never tuned on |

Box-score (pitcher-aware) models, 2024–2026 only:

| Window | Seasons | Use |
|---|---|---|
| burn-in / fit | 2024 | pitcher histories accumulate; models fitted |
| SELECTION | 2025 | choose and tune |
| HOLDOUT | 2026 | reported once per model version |

2020 (stopped 2020-03-15) is kept in the data and scored, but reported
separately; it is not used to choose anything on its own. 2023's season file
is incomplete in the source and is rebuilt from per-team files (ingest).

## 3. Choosing and promoting

- Candidates are listed in order of complexity before scoring. The simplest
  is the incumbent. A challenger replaces it only if its SELECTION log loss is
  lower by **≥ 0.001** (`engine/lab/protocol.js` RULES.challenger_margin).
- An ensemble is kept only if, on VALIDATION, a paired date-block bootstrap
  of its log loss against the best single model has a 95% interval wholly
  below zero.
- A feature group is kept only if its ablation (the model without it) is
  worse on VALIDATION by a margin whose 95% interval excludes zero. A feature
  that explains a memorable miss but does not pass this test is rejected and
  recorded.

## 4. Status rules (per market, on HOLDOUT)

Reused unchanged from `engine/lab/protocol.js`:

- moneyline: n ≥ 1000, ≥ 2 seasons, |mean p − mean y| ≤ 0.02, calibration
  slope in [0.85, 1.15], and a block-bootstrap 95% interval of the log-loss
  difference vs the best baseline wholly below zero → `OUTCOME_VALIDATED`;
  otherwise `PROVISIONAL` with the failed rules listed.
- run line / total / team total: 80% interval coverage in [0.77, 0.83], mean
  bias within 1% of the mean outcome (or 0.25 runs), and a CRPS (or ranked
  probability score) interval vs the baseline wholly below zero.
- market: `NOT_TESTED` until a licensed archive of timestamped prices is on
  file. There is none for college baseball.

## 5. Holdout discipline

The HOLDOUT seasons are evaluated by `node college_baseball/walkforward.js
--holdout`, which registers the result with `holdout_evaluated: true`. The
registry counts holdout looks per model family; more than three distinct looks
for one family fails audit check 11 ("overfitting to the holdout"). Re-running
an unchanged model is not a new look.

## 6. Baselines (always reported)

1. Home rate: P(home win) = the burn-in/selection-era home win rate; neutral
   games get 0.5.
2. Season run differential (Pythagenpat) with no opponent adjustment.
3. Elo on results only (K and home advantage tuned on SELECTION).

A model that does not beat baseline 3 on log loss with a 95% interval below
zero is not promoted, however complex it is.

## Amendment 2026-10-21: a weekly learning loop (`college_baseball/loop.js`)

Added at the owner's direction that every model learn from its misses every
week, written so the windows above keep their meaning. Every result produced
before it keeps its label.

- **What it may read.** SELECTION + VALIDATION (2014–2024): the seasons §2
  allows for tuning and promotion evidence. It never loads the HOLDOUT
  (`walkforward.js runAll` is called with `until` = the last VALIDATION
  season).
- **What it tries.** Changes from a fixed catalogue to the served run model's
  configuration: its five tuned parameters, the five hierarchy parameters that
  were never tuned (`sigma_div`, `sigma_park`, `carry_conf`, `carry_div`,
  `carry_park`), and the run distribution's dispersion. Patterns in the
  VALIDATION misses (binomial z ≥ 2) choose which go first; the rest rotate.
- **The rule.** A change is kept only if, over SELECTION + VALIDATION, its log
  loss is lower by ≥ 0.0002 with a date-block bootstrap 95% interval wholly
  below zero, its Brier score is no worse, and it is no worse on VALIDATION.
  Every candidate is logged (`docs/model-loop/college_baseball/
  candidates.jsonl`).
- **Staged, not served.** A kept change becomes a STAGED version. It is served
  only when the owner runs `node college_baseball/loop.js release`, which
  takes that version's one HOLDOUT look (§5) and records what it said. A
  version is a model version for §5's count; staging many changes and
  releasing rarely keeps the looks few.
- **One look per configuration.** A holdout look is stored by the
  configuration it measured (`validation/holdout_looks.json`, keyed by
  `config_sha256`) and carried forward only to a report of that exact
  configuration. A rollback finds its own look and spends none.
- **Features from data we did not hold (added 2026-10-21).** The catalogue may
  carry a change that needs an input the record does not have yet; the first
  is roster continuity (`tq.cont_k`, `lib/continuity.js`): the share of last
  season's roster that came back, from the rosters each school publishes
  (`collegiate/`), moving how much of last season's strength a team carries.
  Such a change is **inactive** — never tried, never ranked, and named in the
  weekly report with its coverage — until the input covers at least 80% of
  D-I team-seasons in SELECTION + VALIDATION. Once active it is tried under
  the same rule as every other change. A team-season the input does not
  cover is priced exactly as before; nothing stands in for missing data.

## Amendment 2026-10-21 (b): the market, tested forward on prices captured after the model was frozen

Added before any college baseball price existed. Everything above keeps its meaning; §4's market rule ("`NOT_TESTED` until a licensed archive of timestamped prices is on file") is now answered as follows.

- **The archive.** `college_baseball/market/fetch_quotes.js` keeps every college baseball price the odds gateway serves. It runs only when both the repository variable `CBASE_PRICES` and the gateway's `baseball_ncaa` row are on (`supabase/cbase_odds_sport.sql` creates the row disabled). It keeps every changed price, each game's first price and its last pregame price per book, and the model's number the first time the game is seen with a price. Each price is stamped with the snapshot's own time. A price at or after the first pitch is never a pregame price.
- **The test.** EXPERIMENTS.md "College baseball: a forward holdout", CBASE-H1, written before the first price, under the global CLV protocol (G1-G9) unchanged:
  - the frozen model against the close, moneyline at |model − open| ≥ 0.02;
  - the open is the price in force when the model's number was taken;
  - read ONCE, at 500 bets or from 2027-06-30;
  - until then, counts only.
- **Market status.** `MARKET_VALIDATED` is the G7 PASS on at least 500 bets, for the configuration that was served when the prices were captured. A version released later starts its own forward test.
- **The board.** It makes a value claim only when `college_baseball/lib/market_gate.js` allows it: `MARKET_VALIDATED` for the served configuration, the release gates passing (G12, the books' settlement rules, among them), and a live board. Until then it shows probabilities only, with the model's outcome status, and no value claim.
- **No backtest stands in for it.** The walk-forward's own market status stays `NOT_TESTED`: it is a retrospective reconstruction with no prices. The only market evidence is the forward test.

## Amendment 2026-10-22: projected starters from the schools' box scores, 2014–2024

Added before any model with the starter term was scored. Everything above keeps its meaning. §2's box-score windows (2024–2026) were set by the box scores we held then (baseballr-data). The collegiate collector now holds the schools' own box scores from 2013 on (`collegiate/`; joined to our contests by `ingest/school_box.js`), so a pitcher-aware term can be scored on the results windows.

- **The windows.** A starter term read from the schools' box scores uses the results-only windows of §2:
  - **burn-in / fit 2013**: the linear weights and the starter-projection logit are fitted here and nowhere else;
  - **SELECTION 2014–2022** and **VALIDATION 2023–2024**, which the learning loop reads;
  - **HOLDOUT 2025–2026**, read once per model version by `loop.js release`, as before.
  - The baseballr pitcher study (`pitcher_walkforward.js`, §2's box-score windows) is unchanged and keeps its own record.
- **The term.** `lib/starters.js`, entering the run model as `tq.sp_k` (0, off, in every version so far). For each staff it computes:
  - the starter projected from the team's own recent starts (the same weekday slot last week, rest, recent start share; `lib/pitchers.js` projectStarter);
  - each candidate's shrunk run value per batter faced, from boxes dated before the game;
  - q = log(1 + Σ p_i s_i (rv_i − rv_staff) / rv_staff), which moves the opposing side's expected runs by exp(sp_k · q).
- **What it never reads.** The game's own box. The actual starter is oracle: the pitching state folds in only appearances dated before the game, and `tools/college_baseball/starters.test.js` checks that rewriting a game's box leaves that game's number unchanged.
- **Missing data.** A side has no value unless its last 28 days are boxed (at least 3 contests and 80% of them). A side without a value is priced exactly as before. Home runs allowed are missing from older SIDEARM boxes, so the weights have no home-run term. A pitcher who changes schools starts again.
- **When it is tried.** Under the 2026-10-21 amendment's rule for data we did not hold:
  - inactive until the input covers at least 80% of D-I team-seasons in SELECTION + VALIDATION;
  - a team-season counts as covered when at least 80% of its contests are boxed.
  - Once active, the four catalogue changes (`starter_quality`, `_half`, `_stronger`, `_weaker`) are tried under the full-window rule, like every other.
- **The ceiling, stated now.** From the schedules held on 2026-10-22, about 83% of D-I team-seasons will be covered in 2022 and 2024, but about 22% in 2014. Older seasons' schedules link fewer box scores, and the WMT sites' boxes are not read. So the term may stay inactive until more older-season boxes are found. The weekly report names its coverage every week. A lower bar would test the term mostly on recent seasons, so the bar is not lowered for it.
- **Platoon (step 6), the same rule.** `tq.pl_k` (0, off) reads two inputs:
  - the opposing nine's usual bats: its starting nines in its own boxed games of the last 28 days, never today's lineup;
  - the projected starter's throwing hand.
  - The term is pl = Σ p_i s_i (advantaged share against hand_i − the league's share against that hand, measured on the 2013 burn-in).
  - A hand comes from the box, or else from the school's roster for the same name. Only a name that matches exactly one roster player counts, and nothing stands in for an unknown hand.
  - It is inactive until both hands are known for 80% of the contests of 80% of D-I team-seasons in SELECTION + VALIDATION. Its catalogue changes are `platoon`, `_half`, `_stronger` and `_weaker`.
