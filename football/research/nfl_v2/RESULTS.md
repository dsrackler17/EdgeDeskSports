# NFL model rebuild — results

Everything here is reproducible from the committed code and the public nflverse feeds
(`fetch_history.sh`). The protocol was committed before any candidate was looked at on the
2025 holdout (`preregistration.json`); every variant evaluated is in `results/variants.jsonl`.
The frozen CLV ranking protocol was not touched.

**Served now:** `edgedesk_nfl_v2.1.0` (`football/nfl_params_v2.js`, config sha `6c79095675f8a223`) =
`edgedesk_nfl_v2.0.0` (the v1 engine with the Step 1 correctness fixes + the `net_pts` sign fix,
Step 4 T5) + round 2: a lower prior for quarterbacks with little history (−0.16 EPA/dropback,
shrinkage 6), a "regular starter out" feature, and a standardised strength ridge (λ 240). Every
other candidate was rejected by the preregistered gate. `v2.0.0` is archived under `versions/`
(`weekly_loop.js --rollback edgedesk_nfl_v2.0.0` restores it byte for byte).

## Acceptance 1 — parity: live ratings match training

`football/parity.test.js` replays all of 2025 and 2026 to date (378 games) through
`nfl.absorbCompleted` — the one absorb path the live board, the slate builder, the daily check, the
live check and both JS validators now share — and compares every team rating, team QB level, league
mean and credited QB value after **every** game with the python training pass's own recorded state
(`parity/nfl_parity_2025_2026.json.gz`, written by `parity_dump.py` from the unmodified
`build_features.py` / `train_nfl.py`).

* worst difference: **1.4e-16** (tolerance 1e-9) — **PASS**
* the old offence-only absorb is caught by the same comparison (worst difference > 1e-3), so the
  test cannot pass by comparing a thing with itself
* no club's pass-defence rating sits at its carried 2025 value after 2026 is absorbed
* a source check proves every caller uses the shared path; `supabase/functions/ingest_nfl_features`
  carries its own Deno copy of the mirror (cross-checked identical)
* `football/nfl_model.test.js`: the v2 model in its v1 configuration reproduces the v1 engine
  exactly over 378 games (worst 7e-15)

## Acceptance 2 — backtest: old vs new vs the closing line

Walk-forward: for every season S the ridge weights, the margin PMF and any calibration are fitted on
2002..S−1 only; S is predicted game by game from the rating state before each game. Every
2010–2025 game (regular season and postseason) with a closing spread and a final is scored.
`results/final.json` holds every number below; `results/oos_v2.csv.gz` holds every v2 prediction.

**2025 holdout (n = 285)**

| model | margin MAE | RMSE | Brier | log loss | ECE | cal. slope | home lean |
|---|---|---|---|---|---|---|---|
| old: v1 as served (frozen defence, frozen QB layer, Normal win prob) | 10.456 | 13.39 | 0.2372 | 0.6673 | 0.077 | 0.70 | +0.68 |
| v1 + Step 1 correctness fixes | 10.194 | 12.94 | 0.2229 | 0.6351 | 0.045 | 0.98 | +0.72 |
| edgedesk_nfl_v2.0.0 (Step 4) | 10.168 | 12.83 | 0.2221 | 0.6339 | 0.068 | 0.88 | +0.74 |
| **new: edgedesk_nfl_v2.1.0 (served; round 2)** | **10.076** | **12.68** | **0.2172** | **0.6212** | 0.066 | 0.93 | +0.72 |
| closing line | 9.670 | 12.24 | 0.2109 | 0.6070 | 0.047 | 1.01 | — |

**2010–2024 validation (n = 4,078)**

| model | margin MAE | Brier | log loss | ECE | cal. slope | home lean |
|---|---|---|---|---|---|---|
| old: v1 as served | 10.502 | 0.2250 | 0.6403 | 0.028 | 1.00 | +0.36 |
| v1 + Step 1 fixes | 10.397 | 0.2224 | 0.6349 | 0.023 | 1.09 | +0.36 |
| v2.0.0 | 10.363 | 0.2203 | 0.6307 | 0.027 | 0.89 | +0.43 |
| **new: v2.1.0** | **10.303** | **0.2177** | **0.6246** | 0.025 | 0.94 | +0.40 |
| closing line | 10.081 | 0.2111 | 0.6098 | 0.017 | 1.07 | — |

**2026 to date (n = 93; reported only — never used to choose anything)**

| model | margin MAE | Brier | log loss |
|---|---|---|---|
| old: v1 as served | 9.568 | 0.2314 | 0.6506 |
| v1 + Step 1 fixes | 9.657 | 0.2307 | 0.6502 |
| v2.0.0 | 9.789 | 0.2291 | 0.6472 |
| new: v2.1.0 | 9.728 | 0.2289 | 0.6475 |
| closing line | 9.307 | 0.2334 | 0.6614 |

Reading it honestly:

* The Step 1 fixes are the big gain: −0.26 MAE and −0.032 log loss on the holdout. The `net_pts`
  fix adds −0.026 MAE and −0.0012 log loss on the holdout, and −0.034 / −0.0042 on validation.
  Round 2 adds −0.060 MAE / −0.0061 log loss on validation (better in 13 of 15 seasons on each) and
  −0.092 / −0.0127 on the holdout — the largest step after the correctness fixes.
* **No version beats the closing line**, on any window, on either metric. The NFL spread pricing tier
  moved LEAN → RESEARCH after the defence fix (`football/validation/pricing_nfl.json`): the "edge" the
  old record showed was partly the bug.
* v2's win probabilities are slightly over-confident on 2025 (calibration slope 0.93 for v2.1.0,
  0.88 for v2.0.0, 0.98 for v1-fixed; ECE 0.066 / 0.068 / 0.045) even though its log loss and Brier
  are better. Isotonic calibration (T4) was tested and rejected on validation.
* On 93 games of 2026 the old bugged model has the lowest MAE of the four. That is 93 games, and
  2026 is outside every decision by rule; the weekly loop watches it. v2.1.0 is 0.06 better than
  v2.0.0 on 2026 MAE and 0.0003 worse on log loss.

### Calibration, 2025 holdout (home win probability, the served v2.1.0)

| bin | v2.1.0 n | v2.1.0 predicted | v2.1.0 observed | close n | close predicted | close observed |
|---|---|---|---|---|---|---|
| 0.1–0.2 | 7 | 17.2% | 42.9% | 10 | 16.9% | 10.0% |
| 0.2–0.3 | 25 | 25.8% | 20.0% | 25 | 24.7% | 24.0% |
| 0.3–0.4 | 26 | 34.0% | 38.5% | 36 | 34.6% | 41.7% |
| 0.4–0.5 | 50 | 47.1% | 48.0% | 48 | 44.1% | 41.7% |
| 0.5–0.6 | 53 | 52.8% | 41.5% | 47 | 55.4% | 57.4% |
| 0.6–0.7 | 49 | 66.0% | 57.1% | 48 | 64.5% | 54.2% |
| 0.7–0.8 | 40 | 76.7% | 72.5% | 41 | 74.9% | 73.2% |
| 0.8–0.9 | 27 | 84.7% | 88.9% | 26 | 85.7% | 92.3% |
| 0.9–1.0 | 7 | 90.9% | 100% | 3 | 90.5% | 100% |

### The home lean (Step 3: "check the +0.8 home lean disappears")

**It did not disappear in the served model** (2025: +0.72 points of home margin above the close;
2010–2024: +0.40; v2.0.0 had +0.74 / +0.43). The season home-field candidate (H1, ρ 0.7, m 250) removed it on validation
(−0.11) and cut it to +0.49 on 2025, and it improved 2025 log loss — but its 2025 MAE was
10.1989 against the incumbent's 10.1944, so the preregistered gate rejected it. The served model's
home field is now fully visible on the card (spread intercept 2.60 + context intercept 0.20 + the
early-season term, ≈ 3.06 points); before, 0.87 of it sat in a context term the card never showed.

## Acceptance 3 — KC @ SEA, re-run

| | old (as served) | v1 + fixes | v2.0.0 | **v2.1.0 (served)** |
|---|---|---|---|---|
| SEA margin | −6.72 | −5.69 | −5.94 | **−4.38** |
| SEA win probability | 73.5% | 68.6% | 69.6% (fair ML −229) | **65.8%** (fair ML −193) |
| 80% range (home margin p10 / p50 / p90) | −8 / 7 / 26 | −10 / 6 / 24 | −10 / 6 / 24 | **−11 / 4 / 23** (centred on the projection) |
| market (nflverse consensus) | SEA −3 | | SEA −3: model − market 2.94 | SEA −2.5: model − market **1.88** |

The v2.1.0 card — seven rows that sum exactly to the margin (`card.reconciles = true`); v2.0.0 in brackets:

| row | points (home +) | prior | this season |
|---|---|---|---|
| Base team strength | +2.71 (+3.26) | +3.73 (+4.31) | −1.02 (−1.05) |
| Passing | +0.24 (+0.16) | +0.25 | 0.00 |
| Rushing | −0.44 (−0.16) | −0.02 | −0.42 |
| Quarterback | −1.78 (−0.93) | | |
| Home field | +3.09 (+3.06) | | |
| Context (venue, division) | 0.00 | | |
| Rest / travel | +0.56 (+0.55) | | |
| **Total** | **+4.38** (+5.94) | | |

Round 2 moved SEA 1.56 points toward the market. Mahomes' edge over Darnold is now weighted
(standardising the ridge stops it shrinking the QB and EPA terms for their units). The base-strength
prior falls for the same reason.

What changed against the audit (`audit_report.md`): the passing term that gave SEA +2.3 is now +0.16
(it was mostly SEA's frozen 2025 pass defence); the rushing term is no longer +1.0 KC (same cause);
the 0.87-point context term and the 2.03 points of rows the old page never showed are all on the card.
What did not change: SEA's 2025 prior (+4.31) still outweighs its 2026 evidence (−1.05) after six
games. The widened prior grid (carry 0.30–0.95, geometric and hyperbolic k/(k+n)) found the incumbent
decay best on 2010–2024, and the personnel prior (which would see the Walker move) did not beat the
incumbent on validation; both are in the table below.

## Acceptance 4 — every 2026 Week 7 card, old vs new

`week_cards_diff.js --prev 0b990e0c` → `results/week7_cards.json`. Old = git 72af3904 (the audit's
baseline); v1 fixed = git e9fed776 (the merged PR #634); previous = git 0b990e0c (v2.0.0, the slate on
main before round 2); v2 = `football/nfl/slate.json` now (v2.1.0). Feed changes between builds
(injury reports, starters) are part of each change.

**v2.0.0 → v2.1.0** (the same feeds within an hour; the quarterback row is the card's QB row):

| game | starters (home / away) | v2.0.0 | QB row | v2.1.0 | QB row | change | market | v2.1.0 − market |
|---|---|---|---|---|---|---|---|---|
| CIN @ BAL | Tyler Huntley / Joe Burrow | +0.78 / 50.7% | −1.03 | −1.87 / 46.9% | −3.70 | −2.65 | +3.00 | **−4.87 ⚑** |
| CLE @ TEN | Cam Ward / Deshaun Watson | −1.05 / 48.7% | −0.06 | −1.02 / 48.8% | −0.34 | +0.03 | −1.50 | +0.48 |
| DAL @ PHI | Tanner McKee / Dak Prescott | +3.79 / 64.3% | −0.21 | +0.58 / 50.3% | −2.99 | −3.21 | −4.50 | **+5.08 ⚑** |
| DEN @ ARI | Jacoby Brissett / Bo Nix | −5.32 / 30.7% | +0.32 | −4.00 / 34.5% | +0.58 | +1.32 | −4.50 | +0.50 |
| GB @ DET | Jared Goff / Jordan Love | +5.33 / 67.8% | +0.39 | +5.48 / 68.1% | +0.59 | +0.15 | +3.00 | +2.48 |
| IND @ MIN | Kyler Murray / Daniel Jones | +8.70 / 79.0% | +0.73 | +9.13 / 79.5% | +1.51 | +0.43 | +6.50 | +2.63 |
| KC @ SEA | Sam Darnold / Patrick Mahomes | +5.94 / 69.6% | −0.93 | +4.38 / 65.8% | −1.78 | −1.56 | +2.50 | +1.88 |
| LA @ LV | Kirk Cousins / Matthew Stafford | −4.32 / 33.2% | +1.25 | −3.04 / 40.9% | +2.21 | +1.28 | −4.50 | +1.46 |
| MIA @ NYJ | Geno Smith / Malik Willis | +0.23 / 50.0% | +0.52 | +1.23 / 51.8% | +1.42 | +1.00 | +4.50 | **−3.27 ⚑** |
| NE @ CHI | Caleb Williams / Drake Maye | −0.32 / 49.9% | +0.29 | +0.09 / 50.0% | +0.66 | +0.41 | +3.00 | −2.91 |
| NYG @ HOU | C.J. Stroud / Jameis Winston | +9.50 / 79.9% | +1.07 | +10.10 / 82.2% | +1.74 | +0.60 | +10.00 | +0.10 |
| PIT @ NO | Tyler Shough / Aaron Rodgers | −3.41 / 37.3% | +0.05 | −3.24 / 39.1% | +0.08 | +0.17 | −3.50 | +0.26 |
| SF @ ATL | Michael Penix Jr. / Brock Purdy | −2.54 / 45.2% | +0.03 | −2.04 / 46.5% | +0.07 | +0.50 | −3.00 | +0.96 |
| TB @ CAR | Bryce Young / Jalon Daniels | +2.56 / 55.3% | +0.72 | +5.31 / 67.8% | +3.81 | +2.75 | +3.50 | +1.81 |

Three games have a starter who is not his club's regular starter, and each takes the feature's
1.78 points: PHI (McKee for Hurts), BAL (Huntley) and TB (Daniels). DAL @ PHI moves 3.2 points
toward the market (8.29 → 5.08 off). It is still flagged: the market prices Hurts' absence at
about 8 points, the model at about 3. KC @ SEA, MIA @ NYJ, NE @ CHI and LA @ LV move toward the
market; CIN @ BAL and TB @ CAR move away from it, and both are backup games. Over all 27 slate
games the mean |model − market| goes 1.76 → 1.71. That is not the gate (the backtest is); it only
shows the change is not a general drift away from the market.

**Old → v1 fixed → served** (every column re-read from its committed slate):

| game | old margin / win | v1 fixed | v2 (served) | change from old | market | v2 − market | new card rows sum to the margin | old card: points in no row (dropped context term) |
|---|---|---|---|---|---|---|---|---|
| CIN @ BAL | +1.50 / 55.6% | −0.12 / 50.0% | −1.87 / 46.9% | −3.37 | +3.00 | **−4.87 ⚑** | yes (−1.87) | −0.70 |
| CLE @ TEN | −1.30 / 45.1% | −0.95 / 48.9% | −1.02 / 48.8% | +0.28 | −1.50 | +0.48 | yes (−1.03) | −0.25 |
| DAL @ PHI | +1.42 / 55.3% | +1.45 / 52.3% | +0.58 / 50.3% | −0.84 | −4.50 | **+5.08 ⚑** | yes (+0.59) | −0.31 |
| DEN @ ARI | −2.66 / 40.2% | −2.12 / 46.3% | −4.00 / 34.5% | −1.34 | −4.50 | +0.50 | yes (−4.01) | −0.30 |
| GB @ DET | +7.67 / 76.3% | +5.82 / 69.0% | +5.48 / 68.1% | −2.19 | +3.00 | +2.48 | yes (+5.49) | −0.26 |
| IND @ MIN | +5.08 / 68.3% | +6.27 / 70.6% | +9.13 / 79.5% | +4.05 | +6.50 | +2.63 | yes (+9.14) | −0.22 |
| KC @ SEA | +6.72 / 73.5% | +5.69 / 68.6% | +4.38 / 65.8% | −2.34 | +2.50 | +1.88 | yes (+4.38) | +0.87 |
| LA @ LV | −3.35 / 37.7% | −3.91 / 35.2% | −3.04 / 40.9% | +0.31 | −4.50 | +1.46 | yes (−3.03) | −1.12 |
| MIA @ NYJ | −2.54 / 40.6% | +2.42 / 54.5% | +1.23 / 51.8% | +3.77 | +4.50 | **−3.27 ⚑** | yes (+1.24) | +0.41 |
| NE @ CHI | −1.17 / 45.6% | −0.09 / 50.0% | +0.09 / 50.0% | +1.26 | +3.00 | −2.91 | yes (+0.11) | −0.98 |
| NYG @ HOU | +9.41 / 81.0% | +9.06 / 79.7% | +10.10 / 82.2% | +0.69 | +10.00 | +0.10 | yes (+10.10) | +0.83 |
| PIT @ NO | +2.18 / 58.1% | −2.01 / 46.6% | −3.24 / 39.1% | −5.42 | −3.50 | +0.26 | yes (−3.23) | −0.03 |
| SF @ ATL | +0.08 / 50.3% | −2.11 / 46.3% | −2.04 / 46.5% | −2.12 | −3.00 | +0.96 | yes (−2.04) | +0.84 |
| TB @ CAR | +4.38 / 65.9% | +3.67 / 63.9% | +5.31 / 67.8% | +0.93 | +3.50 | +1.81 | yes (+5.31) | −0.30 |

All 14 Week 7 cards (and all 27 on the slate) reconcile to the cent; three carry the
"Model disagrees with market by X pts" flag (v2.0.0 had three: DAL @ PHI, MIA @ NYJ, NE @ CHI).
**DAL @ PHI is still the one to distrust,** for a smaller reason: Hurts is out (calf). v2.0.0 moved
the QB row −0.21 where the market moved ~8 points; v2.1.0 moves it −2.99 (McKee's lower prior −1.22
and the starter-out feature −1.78). The regime layer's QB-out adjustment (−3.06) is still computed
and shown, not priced: it has never passed a holdout.

## Acceptance 5 — every change promoted, every candidate rejected

Gate (preregistered): a family's best setting on 2010–2024 is a finalist only if it beats the
incumbent on validation MAE **and** log loss; it is promoted only if it also beats it on the 2025
holdout on MAE **and** log loss. Changes accumulate step by step.

| step | candidate | 2010–24 MAE | 2010–24 LL | 2025 MAE | 2025 LL | verdict |
|---|---|---|---|---|---|---|
| 1 | defence mirrored from the opponent's offence in all five JS callers + the edge function | | | | | **SHIPPED** (correctness) |
| 1 | QB layer absorbed every game by training's rule; a new starter's value applies at once | | | | | **SHIPPED** (correctness) |
| 1 | card attribution: ctx and p50 kept; seven rows that sum exactly; "post-model adjustments" text removed | | | | | **SHIPPED** (correctness) |
| 1 | one distribution: win prob, cover, moneyline and range from the learned margin PMF | | | | | **SHIPPED** (correctness) |
| — | *incumbent after Step 1* | *10.397* | *0.6349* | *10.194* | *0.6351* | |
| 2 | P0 geometric decay, carry 0.30–0.95 × α 0.05–0.20 (45 settings) | best = incumbent (0.8, 0.1) | | | | rejected — the old grid's edge was not the optimum's |
| 2 | P1 hyperbolic k/(k+n), carry × k × k_pts (288 settings); best carry 0.85, k 6, k_pts 16 | 10.418 | 0.6349 | | | rejected on validation |
| 2 | P2 personnel prior (RB, WR/TE efficiency carried in/out; OL snap share returning) | 10.396 | 0.6349 | | | rejected on validation (MAE −0.0007, log loss not better) |
| 2 | P3 market rating from earlier closes, β 0.35, carry 0.6 | 10.274 | 0.6266 | 10.101 | 0.6388 | rejected on the holdout (log loss worse) |
| 2 | preseason win totals | | | | | **INACTIVE** — nfldata win_totals.csv ends at 2020 |
| 3 | H1 season home field with shrinkage, ρ 0.7, m 250 | 10.383 | 0.6335 | 10.199 | 0.6351 | rejected on the holdout (MAE 10.1989 > 10.1944) |
| 3 | H2 travel distance, time zones, west-coast early kickoff | 10.412 | 0.6359 | | | rejected on validation |
| 3 | H3 drop the dome / grass (outdoor-turf) context terms | 10.414 | 0.6351 | | | rejected — the terms stay (they survive the backtest) |
| 4 | T1 split pass O / pass D / rush O / rush D (no net features) | 10.429 | 0.6358 | | | rejected on validation |
| 4 | T2 in-season recency, λ 0.95 | 10.392 | 0.6342 | 10.220 | 0.6383 | rejected on the holdout |
| 4 | T3 garbage time removed (G1, play-by-play) | 10.393 | 0.6354 | | | rejected on validation (control G0 10.374 / 0.6338) |
| 4 | T4 isotonic calibration | 10.397 | 0.6381 | | | rejected on validation |
| 4 | **T5 `net_pts` = (for − against), home minus away** (audit §6.7: v1 added points allowed) | **10.363** | **0.6307** | **10.168** | **0.6339** | **PROMOTED → edgedesk_nfl_v2.0.0** |
| 4 | T2 + T5 combination | 10.362 | 0.6305 | 10.176 | 0.6349 | passes against the incumbent, loses to T5 alone on 2025 — not promoted (see round 2 on how that choice was made) |
| — | *incumbent after Step 4: edgedesk_nfl_v2.0.0* | *10.363* | *0.6307* | *10.168* | *0.6339* | |
| R2 | Q1 QB prior × shrinkage (11 settings); best −0.16 / 6 | 10.344 | 0.6294 | 10.123 | 0.6292 | passes alone |
| R2 | Q2 regular starter out (`qb_out_diff`) | 10.323 | 0.6274 | 10.143 | 0.6308 | passes alone |
| R2 | S1 standardised strength ridge (5 λ); best λ 240 | 10.343 | 0.6290 | 10.128 | 0.6273 | passes alone |
| R2 | Q1 + Q2 | 10.315 | 0.6263 | 10.112 | 0.6280 | passes |
| R2 | Q1 + S1 | 10.325 | 0.6272 | 10.068 | 0.6233 | passes |
| R2 | Q2 + S1 | 10.312 | 0.6256 | 10.125 | 0.6253 | passes |
| R2 | **Q1 + Q2 + S1** | **10.303** | **0.6246** | **10.076** | **0.6212** | **PROMOTED → edgedesk_nfl_v2.1.0** (the lowest 2010–24 MAE of the seven that pass) |
| R3 | Q3 QB out gap | 10.304 | 0.6248 | | | rejected on validation |
| R3 | Q1x QB prior past −0.16 (best −0.30 / k 6) | 10.301 | 0.6245 | | | rejected: better in 6 of 15 seasons (needs 9) |
| R3 | S1x λ past 240 (best 480) | 10.304 | 0.6250 | | | rejected on validation |
| R3 | T2r recency 0.95 on v2.1.0 | 10.301 | 0.6245 | 10.089 | 0.6229 | rejected by the gate (all three windows) |

Holdout looks: 7 before round 2 (Step 1: 2, the old and fixed models; Step 2: 1; Step 3: 1;
Step 4: 3) and 7 in round 2 (the three family picks and four combinations). Each is flagged in
`variants.jsonl`. Round 2's runner ran twice, so its 28 rows appear twice with identical numbers:
the second run only changed how passing options are ranked (below). 428 variant rows in total. The
final table above re-reads each model on 2025 for reporting, which decides nothing.

## Step 5 — the weekly loop

`.github/workflows/nfl-weekly-loop.yml`, Tuesdays 14:17 UTC (September–February):

1. refresh the board's feeds and re-absorb the completed week through the shared path;
2. `tools/record/nfl_weekly_eval.js` scores the settled week three ways — **published** (the number the
   site showed, from the model record), **replayed** (the served model on the same pregame state) and
   the **close** — margin error, Brier, log loss, calibration, CLV, 3+ point flags with card drivers,
   misses attributed to card components → `record/football/weekly/` and the NFL model record page;
3. `weekly_loop.js` reads repeat patterns in the season-to-date residuals (|t| ≥ 2, n ≥ 30, the same
   sign in ≥ 60% of weeks), maps each to preregistered candidate families (`preregistration.json`
   `weekly_loop`), backtests each on every season, and promotes only a candidate that beats the served
   model on MAE **and** log loss on the full backtest (2010 → this season), the 2025 holdout **and**
   2010–2025 without this season; promotions are versioned (`v2.N.0`), archived under `versions/` and
   recorded in `registry.json`; `--rollback <version>` restores one byte for byte;
4. `supabase/nfl_model_registry.sql` (research_model_versions / research_model_results), applied with
   psql when `SB_DB_URL` is set; statuses are never VALIDATED (no version beats the close);
5. the slate and cards are rebuilt and `weekly_model_report.md` is written.

**First run (2026 week 6):** published MAE 8.10 / replayed 8.47 / close 6.64 over 14 games;
season to date on the 77 games with all three numbers: published 9.14 / replayed 9.25 / close 8.90
(MAE), 0.666 / 0.652 / 0.670 (log loss). No pattern repeats (strongest: rest/travel slope t = 2.85 on
29 games, under the 30-game floor; home lean −1.99 pts, t = −1.58), so no candidate was generated
and nothing was promoted.

## Round 2 — backup quarterbacks and the standardised ridge

**Why.** Two problems were known after Step 4, both stated under "Known limitations" in the version
that shipped v2.0.0.

1. **Backup quarterbacks were priced too gently.** DAL @ PHI: Hurts out, QB row −0.21, about 8
   points less than the market's move.
2. **The raw-scale ridge shrank the EPA terms.** Their units are a few hundredths, so one λ
   penalised them far harder than `net_pts`.

**Preregistered first.** `preregistration.json` `round_2` (commit 5032d1827f, 2026-10-21 03:30 UTC)
was committed before any round-2 candidate was evaluated on any season. It names three families.

| family | what | grid |
|---|---|---|
| Q1 | the QB layer's prior and shrinkage: a starter with n games is valued at v·n/(n+k) + prior·k/(n+k) | prior −0.04, −0.08, −0.12, −0.16 × k 6, 12, 24 (the incumbent pair excluded) |
| Q2 | `qb_out_diff` = home OUT − away OUT. A side is OUT when its starter is not its regular starter, meaning the QB with the most starts in the club's last 8 games (ties go to the most recent; the window spans seasons). The ridge fits its weight. | on / off |
| S1 | the strength features scaled to unit SD on each fit's training rows before the ridge, weights mapped back to raw scale (serving reads raw weights unchanged) | λ 15, 30, 60, 120, 240 |

**Result** (`run_round2.js` → `results/round2.json`; incumbent v2.0.0 is 10.363 / 0.6307 on
2010–24 and 10.168 / 0.6339 on 2025):

| candidate | 2010–24 MAE | 2010–24 LL | seasons better (MAE / LL, of 15) | 2025 MAE | 2025 LL |
|---|---|---|---|---|---|
| Q1 prior −0.16, k 6 | 10.344 | 0.6294 | 13 / 13 | 10.123 | 0.6292 |
| Q2 regular starter out | 10.323 | 0.6274 | 13 / 13 | 10.143 | 0.6308 |
| S1 standardised, λ 240 | 10.343 | 0.6290 | 8 / 10 | 10.128 | 0.6273 |
| Q1 + Q2 | 10.315 | 0.6263 | 13 / 13 | 10.112 | 0.6280 |
| Q1 + S1 | 10.325 | 0.6272 | 10 / 13 | 10.068 | 0.6233 |
| Q2 + S1 | 10.312 | 0.6256 | 12 / 12 | 10.125 | 0.6253 |
| **Q1 + Q2 + S1 → v2.1.0** | **10.303** | **0.6246** | **13 / 13** | **10.076** | **0.6212** |

All seven pass the gate (MAE **and** log loss on 2010–24, then on 2025). The served one also
passes the weekly loop's stricter gate, beating v2.0.0 on MAE and log loss on all three windows:

| window | v2.0.0 MAE | v2.0.0 LL | v2.1.0 MAE | v2.1.0 LL |
|---|---|---|---|---|
| full backtest, 2010–2026 to date | 10.339 | 0.6313 | 10.277 | 0.6248 |
| 2025 holdout | 10.168 | 0.6339 | 10.076 | 0.6212 |
| 2010–2025 | 10.351 | 0.6309 | 10.288 | 0.6244 |

**How v2.1.0 was chosen from the seven, and a disclosure.** The runner's first version copied
Step 4's code: it ranked passing options by **2025** MAE, which picks Q1 + S1 (10.068). That breaks
the preregistration's own holdout rule: "2025 is never used to choose a hyperparameter, a feature or
a toggle" (`holdout_method`). It also differs from the weekly loop, which takes the lowest
full-window MAE. Ranking by 2025 would have let one season of 285 games decide whether Q2 ships, so
the runner was corrected to rank by 2010–24 MAE (then log loss) and run again before anything was
promoted. Both runs are in `variants.jsonl`.

The correction moved the choice *away* from the best 2025 MAE. The three-part model is better than
Q1 + S1 on:

* 2010–24 MAE, log loss and Brier;
* 2025 log loss and Brier;
* 2010–25 MAE (10.288 against 10.308).

**Step 4 under the same rule.** Its choice between T5 alone and T2 + T5 was made the same way. By
2010–24, T2 + T5 was ahead by 0.0009 MAE and 0.0002 log loss, so the corrected rule would have
served it. That decision is not re-opened here: it needs its own preregistered look. In-season
recency (T2, λ 0.95) on top of v2.1.0 is therefore an open candidate.

**What the weights did** (raw scale; v2.0.0 → v2.1.0):

| term | v2.0.0 | v2.1.0 |
|---|---|---|
| net_pts (for − against) | 0.838 | 0.653 |
| net_epa | 0.875 | 4.345 |
| net_pass | 0.894 | 1.353 |
| net_rush | 1.443 | 3.995 |
| qb_adj_diff | 7.259 | 12.087 |
| qb_out_diff | — | −1.778 |
| rest_diff, div_game, intercept | 1.226, −0.714, 2.597 | 1.308, −0.727, 2.599 |

Standardising moved weight from `net_pts` onto the EPA and quarterback terms, the terms the
raw-scale ridge was shrinking. A backup now costs his side the 1.78-point starter-out term, plus a
QB value pulled toward −0.16 EPA/dropback instead of −0.04.

**Serving.**
* `football/nfl_params_v2.js` is trained through 2025 by `train.js`. Its seeds carry each club's
  last 8 starts (`seeds.starts`), and the live board extends them with every 2026 start.
* The card's Quarterback row now includes the starter-out term.
* The board checks that the model file and the params agree on every feature name before it prices
  with v2. The two files load separately and GitHub Pages caches them apart, so a stale model file
  would otherwise price the new term as NaN. On a mismatch the board runs the v1 engine and says so.
* A change to `football/nfl_model.js` or `football/nfl_params_v2.js` on main now triggers the slate
  rebuild (`starter-context.yml`).

**What round 2 did not settle.**
* **Two picks sit on the edge of their grids:** Q1 at the lowest prior and the smallest shrinkage,
  S1 at the largest λ. The best setting may lie past the grid. Extending it is a new
  preregistration. *Round 3 did, and found nothing past either edge.*
* **The 2025 holdout has now gated 14 decisions.** The next round should lean on the weekly loop's
  full-window gate and on 2026 once it is complete, not on 2025 alone. *Round 3 added a
  season-breadth rule for this.*

## Round 3 — the QB out-gap, the grid edges, recency (nothing promoted)

`preregistration.json` `round_3` (commit ed7b1b10ea) was committed before any round-3 evaluation.
The incumbent is v2.1.0.

**The gate is stricter.** The 2025 holdout had already gated 14 decisions. So a finalist must also
have the lower MAE in **at least 9 of the 15** validation seasons. Promotion needs the weekly loop's
three-window gate (the full backtest, 2025, and 2010–2025). The holdout gates; it never ranks.

`run_round3.js` → `results/round3.json`:

| family | best setting (of n tried) | 2010–24 MAE | 2010–24 LL | seasons better (MAE) | gate windows | verdict |
|---|---|---|---|---|---|---|
| *incumbent v2.1.0* | | *10.3032* | *0.62458* | | 2025 10.076 / 0.6212 | |
| Q3 QB out gap: the regular starter's value minus his replacement's, when OUT | on (1) | 10.3040 | 0.62477 | 7 / 15 | — | rejected on validation |
| Q1x QB prior × shrinkage past round 2's edge | −0.30, k 6 (11) | 10.3005 | 0.62445 | 6 / 15 | — | beat validation by 0.003 MAE in only 6 seasons — rejected by the season rule |
| S1x standardised ridge λ past 240 | 480 (3) | 10.3044 | 0.62495 | 7 / 15 | — | rejected on validation (worse as λ grows: 960 10.310, 1920 10.319) |
| T2r in-season recency on v2.1.0 | 0.95 (3) | 10.3007 | 0.62453 | 9 / 15 | 2025 10.089 / 0.6229; 2010–26 10.276 / 0.6249; 2010–25 10.287 / 0.6244 | finalist; loses log loss on all three windows and 2025 MAE — rejected |

**What it settles.**
* **Round 2's grid edges were not hiding a better model.** Past the edge, the QB prior moves MAE
  by at most 0.003, scattered across seasons. The ridge gets worse above λ 240. v2.1.0 sits at a
  flat optimum on both knobs.
* **Step 4's open recency candidate is closed.** On top of v2.1.0, recency is a narrow validation
  edge that does not hold up on any gate window.
* **Scaling the out term by who is missing does not help.** The `qb_adj_diff` term already carries
  the regular starter's level through the team QB value. A separate gap term adds nothing the
  2002–2024 history can fit.

So the model prices Hurts' absence at about 3 points against the market's 8, and that is what this
history supports with these features. The market may know things the features don't. Two
examples are the backup's own quality beyond his few regular-season starts, and how long the
injury will last. Neither is in the model, and neither was a preregistered candidate.

**Holdout looks:** one this round (T2r), 15 in all. Variant rows: 447.

## Known limitations (stated, not fixed)

* **Backup quarterbacks, narrowed by round 2, not closed.** DAL @ PHI is still 5.1 points off a
  market that prices Hurts' absence at about 8. The starter-out term is one learned average (1.78
  points) for every replacement, whether he replaces an elite starter or a poor one, and the QB
  value of a starter with few games is still shrunk (now toward −0.16). Round 3 tested scaling the
  out term by the regular starter's own value (Q3) and a lower prior still (Q1x); neither helped. The
  regime layer's QB-out term (−3.06 here) is still computed and not priced.
* **A starter coming back counts as "not the regular starter"** until he again has the most starts
  in his club's last 8 games, so the first weeks of a return are priced like a backup's. The ridge
  weight was fitted with these cases in the history, but they are a different thing from an
  injury replacement.
* **The PMF near a pick'em.** The win probability is read off a median-centred discrete margin PMF;
  between fair margins of −0.5 and +0.5 it moves only 49.9% → 50.1%, because the median of a
  distribution with almost no mass at 0 sits in a gap. Monotone, but flatter than the market near 0.
* **Raw-scale ridge:** fixed in round 2 for the strength model (S1). The context and total models
  still fit on raw scale; neither was a candidate.
* **Grid edges and holdout reuse:** see the end of round 2.
* **Not owned (INACTIVE):** per-player OL grades and any other PFF data; preseason win totals after 2020.

## Files

| what | where |
|---|---|
| model | `football/nfl_model.js` (v2), `football/engine.js` (v1 + fixes, serving) |
| served params | `football/nfl_params_v2.js` (`train.js`) |
| backtest | `backtest.js`, `run_steps.js`, `run_round2.js`, `run_round3.js`, `data.js`, `results/step1-4.json`, `results/round2.json`, `results/round3.json`, `results/final.json`, `results/oos_v2.csv.gz` (now the v2.1.0 predictions) |
| parity | `football/parity.test.js`, `parity_dump.py`, `parity/` |
| weekly loop | `weekly_loop.js`, `registry.json`, `versions/`, `results/weekly/`, `tools/record/nfl_weekly_eval.js`, `tools/record/nfl_weekly_report.js`, `tools/football/build_nfl_registry_sql.js` |
| week cards | `week_cards_diff.js`, `results/week7_cards.json` |
