# GOLF_SIMULATOR_NOTES — the golf tournament simulation

The engineering record of the golf seat of the Simulator: what it simulates,
what it stands on, what was measured, how well it forecast tournaments it had
not seen, and what it does not know. Shared engine, database and reader:
[`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md). Dates are UTC; "retrieved" is
2026-10-23.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| Tournament simulation (rounds left, the cut, a playoff, finishing places) | Implemented, tested; **ACTIVE** | `simulator/src/sports/golf/`, §4 |
| Player skill model (new) | Point-in-time, field-relative, time-decayed, shrunk toward measured priors; PGA Tour + DP World Tour on one scale | `model.ts`, `simulator/data/golf_skill_study.json`, §3 |
| Per-tournament uncertainty | Measured from within-event residual products (2024-2026) | §3.4 |
| Cut rules, round counts | MEASURED from each tour's 2023-2026 history per event; never assumed silently | `rules.ts`, §4.2 |
| Walk-forward backtest | 2025-2026 holdout, three tours, against honest baselines; every activation condition holds | `simulator/data/golf_backtest.json`, §5 |
| Reader | Leaderboard, Finishes, Model Health; a tour picker | `lib/edgedesk_simulator_golf.js`, §7 |
| Publication | One competition per tour event (`pga-<id>`, `lpga-<id>`, `eur-<id>`), season `2026`; no SQL change | §6 |
| Nightly | Every tour's event in play, through 2026-12-20 | `config.ts nightly_through`, `cli/plan.ts` |

On 2026-10-23 three events are in play: the **Butterfield Bermuda Championship**
(PGA Tour, round 2 in progress, 30 players on the course, the cut not yet made),
the **BMW Ladies Championship** (LPGA, after round 2, no cut) and the **Genesis
Championship** (DP World Tour, after round 2, the cut made: 70 play on).

---

## 2. Data

- `simulator/data/feeds/golf_events.json.gz` (ESPN, fetched on GitHub's runners
  by `simulator/src/cli/fetch_sports_data.ts`, the refetch of PR #722): PGA
  Tour, LPGA and DP World Tour 2023-2026, 434 events, 53,703 player-events.
  `model.ts cleanEvent` keeps **412** (19 excluded with their reason: team
  events such as the Zurich Classic, match play and team cups with fewer than
  10 competitors, the modified-Stableford Barracuda Championship) and only
  complete 18-hole rounds: **161,352**. A round is complete only if its strokes
  minus its score to par equals one of the event's 18-hole pars (the values at
  least 5% of its rounds share, so multi-course events keep each course's par);
  a round abandoned by a withdrawal (41 strokes over 10 holes), a round in
  progress and a playoff (a linescore after the last regulation round) all fail
  that test.
- `simulator/data/feeds/golf_current.json`: each league's current scoreboard
  event read from ESPN's leaderboard (status cut / WD, position, thru, tee
  time) and the next two events (fields empty this far out).
- On GitHub's runners a golf run reads the live leaderboard
  (`site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=…&event=…`)
  with the same parser the fetcher uses (`simulator/src/sports/golf/espn.ts`,
  moved out of the fetcher); if the live read fails, or with `--offline`, the
  committed feed is used and the snapshot records it (`meta.source`). A
  leaderboard older than 6 hours never publishes (`results.current`).
- ESPN's own `score` string lags a round in progress (Jesper Svensson, −8 thru
  15, read "−2"): the reader shows the score to par computed from the rounds.

**Fetcher change (needs a refetch):** `espn.ts` now also stores, per event,
ESPN's `tournament` and `playoffType` scalar fields (number of rounds, cut round
and count, playoff format, as ESPN states them) and, per round, the tee time and
the `isPlayoff` flag. `rules.ts` already reads `tournament.cutCount`,
`cutRound` and `numberOfRounds` when present (stated rule cross-checked against
history); until the refetch lands every rule comes from history alone.

---

## 3. The skill model (`model.ts`, study `simulator/src/research/golf_skill_study.ts`)

### 3.1 Model
A complete round's strokes `y = a_k + theta_p + noise`: `a_k` is the
event-round's level (course, set-up, weather, shared by the field), `theta_p`
the player's skill in strokes per round. Fitted at the event's start from
earlier rounds only, by penalised least squares (alternating closed forms):

    min  sum w (y - a_k - theta_p)^2 + kappa sum_p (theta_p - m_p)^2,   w = 0.5^(age / half_life)

`kappa = sigma^2 / tau^2` is the prior's weight in rounds. The penalty anchors
the scale on the average player in the window; players the window holds 1-24
rounds of have their prior shifted by `prior_shift_few`, an unseen player sits
at `prior_shift_new` (measured: they score worse than the average player).
Posterior variance `sigma^2 / (n_eff + kappa)`; per-player round sd shrunk
toward the tour's with weight `nu0` rounds. Reported relative to an average
round (negative is better).

### 3.2 Hyperparameters (tuned on 2024, holdout 2025-2026)

| Fit | Half-life | kappa | Few-round shift | Newcomer prior | nu0 |
|---|---|---|---|---|---|
| PGA Tour + DP World Tour (joint) | 300 d | 4 | +0.60 | PGA +1.32, DPWT +1.76 strokes | 100 / 200 |
| LPGA (separate) | 180 d | 6 | +0.76 | +1.96 | 100 |

Grid: half-life 120-730 days × kappa 1.5-20 (interior optima). **Joint or
separate:** the joint PGA+DPWT fit lowered both tours' tuning error (PGA 7.794
vs 7.821, DPWT 8.612 vs 8.691 strokes²) and their holdout error (7.723 vs 7.746;
8.870 vs 8.940), so the data support one scale; the LPGA shares no players.
Within the joint fit each tour's unseen players get that tour's own newcomer
mean (tuning season).

### 3.3 Out of sample (a round's residual against the field, before the event)

| Tour | Holdout rounds (2025-2026) | MSE, model | MSE, every player equal |
|---|---|---|---|
| PGA Tour | 32,142 | 7.723 | 8.309 |
| LPGA | 20,311 | 8.151 | 9.150 |
| DP World Tour | 24,223 | 8.870 | 9.667 |

Newcomers (players with no round in the window), mean residual against their
prior: zero on the tuning season by construction; on the holdout PGA +0.21
(± 0.12), LPGA +0.08 (± 0.15), DPWT +0.26 (± 0.14) strokes per round. The
newcomer prior is, if anything, slightly generous. (Before each tour got its
own newcomer mean within the joint fit, the DPWT holdout residual was +0.45 and
the PGA's +0.00.)

### 3.4 How sure: the per-tournament draw
Within one event a player's residuals share what is wrong with their pre-event
skill and what is particular to the week. Measured (event bootstrap, 1,000):

| Tour | Cross-half product (rounds 1-2 × 3-4) | Its mean var_post | Rounds 1-2 product | Rounds 3-4 | c2 | W1 | W2 | Round noise (R1-2 / R3-4) |
|---|---|---|---|---|---|---|---|---|
| PGA Tour | 0.124 [0.051, 0.195] | 0.199 | 0.513 | −0.098 | 0.622 | 0.355 | 0 | 2.736 / 2.683 |
| LPGA | 0.266 [0.160, 0.384] | 0.253 | 0.841 | 0.449 | 1.052 | 0.514 | 0.187 | 2.752 / 2.694 |
| DP World Tour | 0.201 [0.100, 0.306] | 0.262 | 0.968 | 0.164 | 0.767 | 0.692 | 0 | 2.841 / 2.838 |

Per player per simulated tournament: `delta ~ N(0, c2 · var_post)` in every
round (the analog of the other sports' strength offset: a player the model knows
little about varies more), `omega1 ~ N(0, W1)` in rounds 1-2 and
`omega2 ~ N(0, W2)` in rounds 3-4 (what two rounds of the same half share
beyond delta: mostly the tee-time draw, which swaps waves between the first two
days, and course rotations). The round-1-2 product is four times the
cross-half one: much of what looks like "form" over the first two days does not
carry into the weekend. The weekend's noise is measured separately (those who
make the cut are steadier). The cross-half pairs are played by those who made
the cut, a selected sample (stated in the study).

---

## 4. The simulation (`module.ts`)

### 4.1 One run
Completed rounds, the strokes of a round in progress, the cut once made and
players who withdrew are Observed. A round still to play:
`round(par + l_r + theta + delta + omega_h + s_p Z)` — whole strokes, so ties
happen. `l_r` is shared by the field: estimated from the field for a round
complete or in progress (holes-weighted), drawn per run for a future round
(course level + day effect, sd measured on the tour's last two seasons). Shared,
it moves the scores to par (the projected winning score), never who beats whom.
A round in progress adds only its remaining holes (their par, the same terms
scaled by the share left, noise by its square root). The offsets are drawn from
their posterior given this event's rounds and holes (exact Gaussian update,
`offsetPosterior`, tested to 1e-9).

The cut, after its round: top N and ties (plus the 10-shot rule where an
event's editions need it). The lowest total wins; a tie for the lead goes to a
**sudden-death playoff, hole by hole** (each hole a rounded normal around
skill/18 with variance s²/18 less the rounding's 1/12: an Estimated
approximation; no hole-by-hole history; aggregate playoffs treated as sudden
death). Places 2.. by total with **ties broken at random**, so top 5/10/20 hold
exactly 5/10/20 players per run: a player tied for 10th with three others is in
the top 10 a quarter of the time, which is exactly the dead-heat settlement's
expected value. Withdrawals after the as-of time are not simulated (measured
rates per round: PGA 0.12 / 0.46 / 0.21 / 0.09%, LPGA under 0.1%, DPWT
0.12 / 0.28 / 0.05 / 0.01%).

Outcomes per player: win (sum rule 1 per run), top_5 / top_10 / top_20 (sum
rules 5/10/20, only when that many players are certain to finish), make_cut (no
sum rule: ties at the line), and the finishing place histogram (places, missed
cut, withdrawn; the record carries the bands, the median and the mean place).
Provenance: completed rounds Observed; simulated outcomes Research; make_cut
Observed once the cut is made and Estimated when its rule is an interval the
editions cannot narrow; every finish Estimated when the round count was assumed
from the tour's usual format.

Determinism: per-run streams (strength = offsets, games = rounds, coin =
tie-breaks, overtime = playoff holes); 1 and 3 workers give identical counts
(tested).

### 4.2 The cut is measured (`rules.ts`)
`measureCut` finds, for every finished event, the round after which the cut
fell and the interval of N for which "top N and ties" reproduces exactly who
made it. The tour standard is the N contained in the most round-2 cuts and is
**pinned** when one event has `n_lo = N` and another `n_hi = N`:

| Tour | Standard | Round-2 cuts (2023-2026) | Containing it | Pinned by |
|---|---|---|---|---|
| PGA Tour | top 65 and ties | 133 | 115 | 2023 Arnold Palmer (N ≥ 65), 2023 U.S. Open (N ≤ 65) |
| LPGA | top 65 and ties | 86 | 80 | 2023 Drive On (≥), 2024 LOTTE (≤) |
| DP World Tour | top 65 and ties | 103 | 101 | 2023 Dubai Desert Classic (≥), 2024 SDC (≤) |

An event's rule, in order: the cut already made (Observed); ESPN's stated
fields when the feed carries them and history agrees; the format of its latest
editions (a latest edition with no cut = no cut, as when a full-field event
became a signature event; otherwise the editions since the last change: the
standard when every one is consistent with it, Research; else the common
interval at its smallest multiple of 5, Estimated, e.g. the Masters 50-53 → 50,
the PGA Championship 68-74 → 70); an event never seen takes the standard only
with a full field (Estimated); anything else is **undetermined and not
simulated**. The data cannot separate N within an interval: the U.S. Open's
editions are consistent with 60-65, so the standard (65) is used — ESPN's
`cutCount` will settle such cases after the refetch.

On 2026-10-23: Bermuda — top 65 and ties after round 2, Research (editions
2023-2025: any N in 60-81, 59-75, 60-70); BMW Ladies — no cut (2023-2025, and
round 2 complete with nobody cut); Genesis — Observed.

### 4.3 Gates (`run.ts`)
Simulation: `field.present` (≥ 10 playing), `rounds.known`, `cut.rule` (never
undetermined; a cut round not before the last round is refused),
`data.consistent`, `model.study`. Publication: `players.rated` (counts of rated,
few-round and newcomer players; refused when more than a third of those playing
are on the prior), `event.open`, `results.current` (6 h); then the shared run
gates and `sport.active` (the backtest's activation conditions,
`activation.ts`).

---

## 5. Backtest (`simulator/src/research/golf_backtest.ts`, `simulator/data/golf_backtest.json`)

Every finished event replayed point-in-time with the production code: **before
round 1** (the field that teed off; the cut rule and round count from earlier
editions only — events production would refuse are skipped and listed: PGA 8,
LPGA 6, DPWT 5 event-stages) and **after round 2** with the cut applied
(Observed). 4,000 runs per event-arm. Targets: the winner; top k as the
dead-heat share; made the cut. Log loss of `(count + 0.5)/(N + 1)`; event
bootstrap within season (1,000) for every difference. Lower is better.

**Uncertainty scale** (a multiplier on c2, W1, W2) checked on 2024: the summed
log loss curve over 0, 0.5, 1, 1.5, 2 is flat to the fourth decimal (PGA lowest
at 0.5, −0.0005 [−0.0021, 0.0012] vs 1; LPGA 0.5, −0.0002 [−0.0026, 0.0027];
DPWT 1). Rule: keep the measured variances unless another scale beats them with
an interval below zero → **scale 1 on every tour**.

### 5.1 Before round 1 (holdout 2025-2026): log loss

| Tour (events, player-events) | Outcome | Model | Field size | Skill as a point | Model − field size [95%] |
|---|---|---|---|---|---|
| PGA Tour (81, 9,863) | Win | 0.0422 | 0.0471 | 0.0424 | −0.0049 [−0.0070, −0.0027] |
| | Top 10 | 0.2531 | 0.2782 | 0.2538 | −0.0251 [−0.0294, −0.0211] |
| | Top 20 | 0.3927 | 0.4335 | 0.3932 | −0.0408 [−0.0468, −0.0355] |
| | Make cut | 0.6385 | 0.6914 | 0.6382 | −0.0529 [−0.0598, −0.0456] |
| LPGA (54, 6,601) | Win | 0.0377 | 0.0471 | 0.0378 | −0.0094 [−0.0118, −0.0068] |
| | Top 10 | 0.2361 | 0.2785 | 0.2379 | −0.0424 [−0.0476, −0.0369] |
| | Top 20 | 0.3679 | 0.4349 | 0.3686 | −0.0671 [−0.0744, −0.0593] |
| | Make cut | 0.6247 | 0.6903 | 0.6243 | −0.0656 [−0.0729, −0.0584] |
| DP World Tour (57, 8,154) | Win | 0.0384 | 0.0415 | 0.0386 | −0.0032 [−0.0050, −0.0014] |
| | Top 10 | 0.2249 | 0.2520 | 0.2248 | −0.0271 [−0.0316, −0.0221] |
| | Top 20 | 0.3639 | 0.4014 | 0.3653 | −0.0375 [−0.0433, −0.0312] |
| | Make cut | 0.6527 | 0.6992 | 0.6538 | −0.0465 [−0.0536, −0.0389] |

Brier moves the same way (PGA win 0.0079 vs 0.0081; top 10 0.0646 vs 0.0692).
The per-tournament draw against skill as a point is **within noise** before
round 1 on every tour (e.g. PGA win −0.0003 [−0.0010, 0.0004]): honest
uncertainty does not cost accuracy, and does not measurably add it either.

### 5.2 After round 2 (cut applied): log loss

| Tour (events) | Outcome | Model | Scores only | Skill as a point | Field size | Model − scores only [95%] |
|---|---|---|---|---|---|---|
| PGA Tour (82) | Win | 0.0491 | 0.0522 | 0.0498 | 0.0741 | −0.0031 [−0.0052, −0.0010] |
| | Top 10 | 0.2875 | 0.2998 | 0.2882 | 0.4045 | −0.0122 [−0.0158, −0.0083] |
| LPGA (54) | Win | 0.0389 | 0.0436 | 0.0387 | 0.0751 | −0.0047 [−0.0070, −0.0026] |
| | Top 10 | 0.2606 | 0.2786 | 0.2621 | 0.4097 | −0.0180 [−0.0232, −0.0127] |
| DP World Tour (55) | Win | 0.0498 | 0.0511 | 0.0499 | 0.0727 | −0.0013 [−0.0032, 0.0007] |
| | Top 10 | 0.2927 | 0.3083 | 0.2927 | 0.3997 | −0.0156 [−0.0192, −0.0115] |

"Scores only" is the same simulation with every player equally skilled: what
the leaderboard alone says. Skill adds to it everywhere except the DP World
Tour's winner, where the gain is within noise. After round 2 the offsets'
update from the rounds played helps the PGA Tour's winner forecast against
skill as a point (−0.0007 [−0.0014, −0.0002]); elsewhere within noise.

### 5.3 Calibration (before round 1, holdout; mean forecast / observed)
- Top 10, PGA: 1.5/1.6, 3.5/3.4, 7.4/7.8, 13.5/12.7, 24.8/26.6, 39.9/37.7, 61.5/66.7%.
- Win, PGA: 0.2/0.2, 0.7/0.8, 1.4/1.6, 2.9/1.5 (671), 6.2/9.5 (63), 16.1/13.8 (29)%.
- Make cut, PGA: 15.6/17.0, 28.8/33.3, 43.4/46.4, 59.2/62.2, 75.6/76.3, 93.5/98.9% — the
  cut is **under-forecast by about 3 points** on the PGA Tour (the simulated
  field includes players who in fact withdrew before the cut, and they take
  places at the line). LPGA and DPWT within 1-2 points in the populated bins.
- After round 2 longshots (0.5-2%) won about half as often as forecast on the
  PGA Tour and LPGA: the trailing pack is slightly over-rated late.

### 5.4 Playoffs
The simulated share of holdout tournaments ending in a playoff (scale 1): PGA
18.2%, LPGA 17.3%, DPWT 17.9%. The feed shows a playoff for 11 of 81 PGA Tour
holdout events (13.6%); the LPGA's and DPWT's feeds mostly do not record
playoffs. The simulated rate is somewhat high against the PGA Tour's record.

### 5.5 Activation (`activation.ts`, written before the backtest was run)
For each tour on the holdout: (1) the study and backtest exist; (2) before
round 1, win / top 10 / top 20 / make cut beat the field-size baseline with the
interval below zero; (3) after round 2, win and top 10 beat scores only (point
estimate); (4) the per-tournament uncertainty is not significantly worse than
skill as a point (win, top 10, top 20). **All hold → ACTIVE.** An earlier run
failed condition 2 for the cut on the PGA Tour and DP World Tour: a bug (a
weather-shortened edition set the round count to 3 while the editions put the
cut after round 3, so no simulated player could make it; and a format change to
no cut was not followed). Both were fixed in `rules.ts`/`inputs.ts` and the
backtest re-run; the fix is in the commit history.

---

## 6. Publication and wiring
One run per tour event in one invocation: `executeGolf` builds a snapshot per
tour (live, else committed), gates and simulates each, writes
`<out>/<competition>/{snapshot,results,gates,manifest}.json` and
`<out>/golf_runs.json`; `publishGolf` publishes each publishable event through
`publish/publish.ts` (exit 1 if any event was refused or blocked, 3 on a publish
failure). `supabase/simulator.sql` already keys runs by sport, competition and
season: no SQL change. The reader's per-player histogram travels in each
`sim_entity_summary.record`; the tournament state in
`validation_summary.sport_summary`. Kalshi: no golf market is mapped (the
workflow's markets job only reads top-level `publish.json`, so golf is not
compared).

Wiring as the WNBA: `registry.ts` (ACTIVE from `activation.ts`; tabs
leaderboard / finishes / model_health; limitations), `factory.ts` (sigma = the
offsets' scale), `cli/run.ts` (`--sport golf`, `--tour pga,lpga,eur`, one
dispatch line, `printGolfSummary`, `publishGolf`), `cli/plan.ts` (RUNNABLE,
NIGHTLY through 2026-12-20), `cli/build_ui_registry.ts`, both workflows, root
`package.json` (`sim:golf:test`, `sim:golf:dry-run`, `sim:golf:study`,
`sim:golf:backtest`; `sim:test`), `app.html`. Core changes: `OutcomeDef`
categories `finish` and `cut`; `EDSimUI.loadPublished(get, sport, season,
competition)` (optional competition); adapters may handle their own controls
(`data-sim-act` → `onAction`).

---

## 7. Reader (`lib/edgedesk_simulator_golf.js`)
A tour picker (each tour's latest published event). **Leaderboard**: the event
card (Observed: course, par, round state, leaderboard time; the cut as measured
with its provenance and the projected cut line; the projected winning score and
playoff share), then every player: position, score to par, thru; win, top 5,
10, 20 and make cut with ±; fair decimal odds with American beneath; the number
of simulated tournaments won; average place; skill (a "new" tag for the prior);
sortable; players out of the event last; the dead-heat note. **Finishes**: the
six most likely winners (fair decimal and American, wins of N), where every
player finishes (bands 1, 2-5, 6-10, 11-20, 21-30, 31+, MC; their most likely band
in bold; median and average place), fair decimal and American odds for every
market (with the dead-heat explanation), the winning-score distribution.
**Model Health**: the backtest in plain words, the before-round-1 and
after-round-2 tables against every baseline, calibration (top 10, the cut, the
winner), the skill model's own record, the playoff check, what the model does
not know. Every value through `esc()`; tested at 390 and 1440 px in Chromium.

---

## 8. Dry run (committed feeds, 2026-10-23, 100,000 runs, 4 workers)

`node simulator/src/cli/run.ts --sport golf --season 2026 --workers 4 --dry-run`
(the live reads failed from this environment, so the committed feed of
20:27 UTC was used; each event 2.1-3.4 s on 4 workers; every gate PASS,
PUBLISHABLE; replaying the PGA snapshot reproduces it exactly):

**Butterfield Bermuda Championship** (inputs `ae04e8d0afc9`; round 2 in
progress; cut top 65 and ties, projected line −5 in 99.3% of runs; winning
score median −24, 80% between −28 and −21; a playoff in 21.3% of runs):

| Player | Pos | To par | Skill | Win (± 0.2) | Top 5 | Top 10 | Top 20 |
|---|---|---|---|---|---|---|---|
| Corey Conners | T3 | −12 | −0.98 | 13.4% | 44.2% | 64.9% | 85.0% |
| Eric Cole | T3 | −12 | −0.70 | 12.2% | 38.9% | 57.9% | 78.7% |
| Séamus Power | T3 | −12 | −0.50 | 8.5% | 34.1% | 55.1% | 78.7% |
| Chandler Blanchet | T1 | −13 | +0.39 | 7.2% | 28.9% | 47.7% | 71.0% |
| Ben Kohles | T7 | −11 | −0.66 | 6.7% | 28.4% | 47.5% | 72.0% |
| Kensei Hirata | T1 | −13 | +0.84 | 4.5% | 21.7% | 39.1% | 63.9% |

**BMW Ladies Championship** (no cut; winning score median −22; playoff 15.2%):
Haeran Ryu (1st, −13) 47.9%, Lauren Coughlin (T2, −11) 14.0%, Minsun7 Kim (T2,
−11, skill +1.22) 5.4%, Karis Davidson (T4) 5.2%.
**Genesis Championship** (cut made; median −15; playoff 17.7%): Casey Jarvis
(T1, −10) 24.2%, Antoine Rozner (T1, −10) 22.9%, Si Woo Kim (T7, −6) 10.2%,
Ryan Fox (T3, −7) 8.3%.

The leaders' gap to the chasers is small, so skill matters: Conners (−0.98
strokes per round better than an average round) is the favourite from one
behind; the two co-leaders, both rated worse than average, are 7.2% and 4.5%.
Korean Tour regulars at the Genesis (14 players) and the BMW Ladies (7) have no
rounds in the history and sit at the newcomer prior (an unseen player is +2.2
strokes per round against an average round on the PGA Tour, +2.5 on the LPGA,
+2.6 on the DP World Tour): see §9.

---

## 9. Limitations (also in the registry, shown in the reader)
- Skill is strokes against the field from these three tours only: players whose
  golf is mostly elsewhere (LIV Golf, the Korn Ferry Tour, the Asian Tour, the
  KPGA/KLPGA, college) start near the newcomer level and are underrated when
  they are good.
- Not modelled: course fit and course history, the weather and the tee-time
  wave (only its average effect on rounds 1-2 is in each player's draw),
  injuries and news, withdrawals after the leaderboard was read, aggregate
  playoffs.
- The cut rule is measured; where the editions leave an interval it is labelled
  Estimated; an event history cannot read is refused.
- The playoff hole model is an approximation, and the simulated playoff rate
  runs above the PGA Tour's recorded one.
- The PGA Tour cut is under-forecast by about 3 points; late longshots are
  slightly over-rated (§5.3).
- One event per tour per run: in a week with a second event on the same tour
  (an opposite-field event) the scoreboard's first is simulated and the other is
  reported as skipped.
- Monte Carlo ± is simulation noise only.

## 10. Next season
Let the feeds refresh (ESPN's tournament fields arrive with the fetcher change),
re-run `npm run sim:golf:study` and `npm run sim:golf:backtest`, then set the new
season and `nightly_through` in `simulator/src/sports/golf/config.ts`.

## 11. Tests (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/golf_sim.test.ts` (SYNTHETIC cut rules, skill fit, tournaments: sum rules, dead heats, the playoff, conditioning, the posterior, provenance, gates, ESPN grammar, which event a tour simulates; worker independence; the committed data) | 79 | pass |
| `simulator/tests/golf_ui.test.ts` (states, tabs, sorting, fair odds, dead heat, backtest text, the loader over several competitions, escaping) | 39 | pass |
| `simulator/tests/ui.e2e.ts` (Chromium; golf at 390 and 1440 px: tabs, tour switch, sort, no horizontal scroll, no page error) | 113 (22 golf), after merging the UFC branch | pass |
| `npm run sim:test` (every suite) | — | pass |
| `simulator/tests/cli.test.ts` (golf in the nightly plan through its window) | 46 | pass |
| `simulator/tests/ui.test.ts` (registry carries no probability) | 99 | pass |
| typecheck, `npm run sim:check` | — | pass |
