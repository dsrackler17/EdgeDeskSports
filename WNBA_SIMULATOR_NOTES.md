# WNBA_SIMULATOR_NOTES — the WNBA postseason simulation

The engineering record of the WNBA seat of the Simulator: what it simulates,
what it stands on, what was measured, and what it does not know. Shared engine,
database and reader: [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md). Dates are UTC;
"retrieved" is 2026-10-23.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| Postseason simulation (open series, game by game) | Implemented, tested; **ACTIVE** | `simulator/src/sports/wnba/`, §3 |
| Game model | The served basketball walk-forward, replayed; reproduces `basketball/params/wnba_live.json` exactly | §2 |
| Shared series offset | Measured (new study), carved out of the served distribution | `simulator/data/wnba_strength_uncertainty.json`, §4 |
| Series formats and hosts | MEASURED from the schedule in every run (no standing blocker) | `config.ts`, §3.2 |
| Reader | Finals, Games and Model Health tabs | `lib/edgedesk_simulator_wnba.js`, §6 |
| Nightly | Through 2026-11-08 (Finals game 7 is 2026-11-01 00:00 UTC), then off until a 2027 configuration | `config.ts nightly_through`, `cli/plan.ts` |

On 2026-10-23 one series is open: the **Finals, Golden State Valkyries v Atlanta
Dream, Atlanta leading 2-1** (Golden State hosts games 1, 2, 5, 7; Atlanta 3, 4,
6). First round and semifinals are decided and kept as played.

---

## 2. The game model (no new model)

Every game is priced by the model the basketball pipeline serves for the WNBA:
points ratings (`basketball/model.js`, hyperparameters from
`docs/model-loop/wnba/versions.json` 1.0.0: half-life 365 days, prior 4 games,
carry 0.8) and the season's calibration fitted on the three seasons before it
(`basketball/walkforward.js calibrate`, `bb_cal_v2_home_intercept`):
P(home) = logistic(a·home + b·m). That is how `basketball/build_slate.js` prices
the board.

`model_adapter.ts replay()` loads and runs `walkforward.js pass` + `score` over
every committed season (nothing copied). Measured on the committed data:

- the replay's end-state ratings equal `basketball/params/wnba_live.json`:
  maximum difference **0** over every club, `mu` 81.149, `h` 2.055;
- the replay's 2026 calibration equals the live file's;
- game 4 (Golden State at Atlanta, 2026-10-24) is priced **0.617052**, the
  board's 0.6171 (`basketball/slate.json`).

Every played playoff game carries its point-in-time pre-game probability (the
pass absorbs a final only once it is assumed available, start + 4 h).

---

## 3. The simulation

### 3.1 One run
Played games are Observed. The open series is played forward at the schedule's
hosts until a club reaches the wins it needs. Outcomes per club: the rounds it
reached (Observed once a round's clubs are known), the title, the title in
exactly k games, each remaining game won. Sum rules after every run: one
champion, two finalists, four semifinalists; titles in k games sum to the
titles (checked by `run.sum_rules`).

### 3.2 Formats and hosts are measured, not assumed
`inputs.ts groupSeries` groups the playoff games by their two clubs; a series'
round is one more than the clubs' earlier series. A decided series' length is
Observed (2 wins in the first round, 3 in the semifinals); an open series' is
the number of games the schedule lists for it ("if necessary" ones included):
seven, first to four. Gates (`run.ts`): `schedule.series` refuses an
inconsistent series or more than one open series (not supported this season),
`schedule.final_round` refuses a round whose clubs are not known (the bracket is
never invented).

### 3.3 Other gates
`model.remaining_priced`; `strength.carve_out` (tau below the margin sd and
inside its interval); publication only: `postseason.open`, `results.current` (no
scheduled game started more than 6 h ago without a final in the source),
`model.served` (the replay equals the served file when both hold the same
finals); then the shared run gates and `sport.active`.

---

## 4. The shared series offset (`simulator/src/research/wnba_strength_uncertainty.ts`)

Whatever is wrong with the two clubs' ratings is wrong in every game of their
series. Estimate (served configuration, point-in-time, 2010-2024; 2025 held out;
2026 never used):

| Measure | Value |
|---|---|
| Club error sigma (two late-regular-season games of one club against different opponents, mean residual product) | 1.903 points (10,128 pairs) |
| **tau = sqrt(2) sigma** (error in the difference of two clubs' ratings) | **2.691 points, 95% CI [1.596, 3.556]** (season bootstrap, 2,000) |
| Postseason check (two games of one playoff series, same club's side) | 2.311 [0, 4.237] (294 pairs, 271 games) |
| 2025 holdout | 4.773 (late season); postseason pairs 0 |
| Served margin sd it is carved out of (2025 calibration) | 11.936 (2026: 12.516) |

Carve-out: with the served P(home) = Phi(z) and margin sd sigma, a game is won at
home with probability Phi((z·sigma + delta_home)/s), s = sqrt(sigma² − tau²),
delta ~ N(0, tau²) drawn once per run. Its average over delta is exactly Phi(z):
**every game keeps the board's probability**; only the games' dependence changes.
Tested (`wnba_sim.test.ts`): the simulated title probability equals an exact
series recursion integrated over delta at tau 0, 2.69 and 6 (within 4 Monte
Carlo SE, 200,000 runs), and game 4 (always played) is won at home at the served
rate.

The holdout season was more volatile than the estimate: series numbers may be
somewhat too confident. Stated in the limitations.

---

## 5. Dry run (committed data, 2026-10-23)

`node simulator/src/cli/run.ts --sport wnba --runs 100000 --workers 4 --offline --dry-run`
(inputs `f88cf08f65d3`, as of 2026-10-21, tau 2.6914, 1.0 s on 4 workers, peak
RSS 255 MB; every gate PASS, PUBLISHABLE):

| Club | Title | in 5 | in 6 | in 7 |
|---|---|---|---|---|
| Atlanta Dream (30-14) | **74.9% ± 0.3** | 30.2% | 30.3% | 14.4% |
| Golden State Valkyries (32-12) | 25.1% ± 0.3 | — | 8.6% | 16.5% |

| Game | Played | Home wins if played | Board price (home) |
|---|---|---|---|
| 4, Oct 24, GSV at ATL | 100% | 61.5% | 61.7% |
| 5, Oct 27, ATL at GSV | 100% | 51.9% | 51.6% |
| 6, Oct 30, GSV at ATL | 69.8% | 60.6% | 61.7% |
| 7, Nov 1, ATL at GSV | 30.9% | 53.5% | 51.6% |

A game's chance "if played" differs from its board price: game 7 is reached only
in series where Golden State won two of games 4-6, which says something about
the clubs (the shared offset). The online path (`--offline` omitted) refreshes
the schedule from wehoop first (`basketball/ingest.js`; needs pyarrow); on
2026-10-23 the source was unchanged (same input hash).

---

## 6. Reader (`lib/edgedesk_simulator_wnba.js`)

Registered with `EDSimUI.registerSport('wnba', …)`; reads the published run with
`EDSimUI.loadPublished`; every non-readable state through `EDSimUI.gateHtml`.
The per-game numbers and the model record ride in
`validation_summary.sport_summary` (`publish/publish.ts` carries a results
document's `sport_summary`; no SQL change).

- **Finals**: the series as it stands (Observed) and the next game; each
  finalist's title chance with ± and fair decimal and American odds; every exact
  result; the bracket so far.
- **Games**: every remaining game (how often it is played, the home side's
  chance if played, the board price, fair odds); every played playoff game with
  its score and the model's pre-game chance.
- **Model Health**: Brier, log loss and accuracy of the served pre-game
  probability on this postseason, this regular season, every postseason
  2010-2025 and every regular season, beside a coin and the home-win rate;
  playoff calibration bins; the shared offset and its holdout.

---

## 7. Limitations (also in the registry, shown in the reader)

- The served moneyline is PROVISIONAL: never compared with closing prices.
- The ratings are frozen at the last final; a simulated game does not update
  them. No player input: injuries, suspensions and returns after the as-of time
  are not in any number.
- The shared offset is estimated on regular seasons (2010-2024); the 2025
  holdout was more volatile.
- Formats and hosts come from the schedule, not a rulebook (`series_format` and
  `home_court` are MEASURED facts: they are checked each run and verified
  against the WNBA's published format when a source check reads it).
- Monte Carlo ± is simulation noise only.

## 8. For 2027

A configuration with the season's playoff bracket rule (pairings of rounds not
yet played, so a postseason can be simulated before its later rounds are paired)
and, ideally, a regular-season simulation; re-run the uncertainty study; set
`nightly_through`.

## 9. Tests (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/wnba_sim.test.ts` (SYNTHETIC grouping and Finals; exact recursion; gates; the committed data priced as the board; registry and plan) | 47 | pass |
| `simulator/tests/wnba_ui.test.ts` (states, tabs, fair odds, escaping) | 21 | pass |
| `simulator/tests/ui.test.ts`, `cli.test.ts`, `publish.test.ts` (shared) | 92, 39, 18 | pass |
