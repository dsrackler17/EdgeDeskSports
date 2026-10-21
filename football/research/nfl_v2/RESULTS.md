# NFL model rebuild — results

Everything here is reproducible from the committed code and the public nflverse feeds
(`fetch_history.sh`). The protocol was committed before any candidate was looked at on the
2025 holdout (`preregistration.json`); every variant evaluated is in `results/variants.jsonl`.
The frozen CLV ranking protocol was not touched.

**Served now:** `edgedesk_nfl_v2.0.0` (`football/nfl_params_v2.js`, config sha `b2dac1c5eeacbfad`) =
the v1 engine with the Step 1 correctness fixes + the `net_pts` sign fix (Step 4, T5).
Every other candidate was rejected by the preregistered gate.

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
| **new: edgedesk_nfl_v2.0.0 (served)** | **10.168** | **12.83** | **0.2221** | **0.6339** | 0.068 | 0.88 | +0.74 |
| closing line | 9.670 | 12.24 | 0.2109 | 0.6070 | 0.047 | 1.01 | — |

**2010–2024 validation (n = 4,078)**

| model | margin MAE | Brier | log loss | ECE | cal. slope | home lean |
|---|---|---|---|---|---|---|
| old: v1 as served | 10.502 | 0.2250 | 0.6403 | 0.028 | 1.00 | +0.36 |
| v1 + Step 1 fixes | 10.397 | 0.2224 | 0.6349 | 0.023 | 1.09 | +0.36 |
| **new: v2.0.0** | **10.363** | **0.2203** | **0.6307** | 0.027 | 0.89 | +0.43 |
| closing line | 10.081 | 0.2111 | 0.6098 | 0.017 | 1.07 | — |

**2026 to date (n = 93; reported only — never used to choose anything)**

| model | margin MAE | Brier | log loss |
|---|---|---|---|
| old: v1 as served | 9.568 | 0.2314 | 0.6506 |
| v1 + Step 1 fixes | 9.657 | 0.2307 | 0.6502 |
| new: v2.0.0 | 9.789 | 0.2291 | 0.6472 |
| closing line | 9.307 | 0.2334 | 0.6614 |

Reading it honestly:

* The Step 1 fixes are the big gain: −0.26 MAE and −0.032 log loss on the holdout. The `net_pts`
  fix adds −0.026 MAE and −0.0012 log loss on the holdout, and −0.034 / −0.0042 on validation.
* **No version beats the closing line**, on any window, on either metric. The NFL spread pricing tier
  moved LEAN → RESEARCH after the defence fix (`football/validation/pricing_nfl.json`): the "edge" the
  old record showed was partly the bug.
* v2's win probabilities are slightly over-confident on 2025 (calibration slope 0.88 vs v1-fixed 0.98,
  ECE 0.068 vs 0.045) even though its log loss and Brier are better. Isotonic calibration (T4) was
  tested and rejected on validation.
* On 93 games of 2026 the old bugged model has the lowest MAE of the three. That is 93 games, and
  2026 is outside every decision by rule; the weekly loop watches it.

### Calibration, 2025 holdout (home win probability)

| bin | v2 n | v2 predicted | v2 observed | close n | close predicted | close observed |
|---|---|---|---|---|---|---|
| 0.1–0.2 | 5 | 17.5% | 60.0% | 10 | 16.9% | 10.0% |
| 0.2–0.3 | 22 | 24.2% | 22.7% | 25 | 24.7% | 24.0% |
| 0.3–0.4 | 24 | 34.1% | 29.2% | 36 | 34.6% | 41.7% |
| 0.4–0.5 | 53 | 47.3% | 45.3% | 48 | 44.1% | 41.7% |
| 0.5–0.6 | 56 | 52.7% | 44.6% | 47 | 55.4% | 57.4% |
| 0.6–0.7 | 54 | 66.3% | 55.6% | 48 | 64.5% | 54.2% |
| 0.7–0.8 | 41 | 76.3% | 82.9% | 41 | 74.9% | 73.2% |
| 0.8–0.9 | 25 | 84.9% | 80.0% | 26 | 85.7% | 92.3% |
| 0.9–1.0 | 4 | 91.4% | 100% | 3 | 90.5% | 100% |

### The home lean (Step 3: "check the +0.8 home lean disappears")

**It did not disappear in the served model** (2025: +0.74 points of home margin above the close;
2010–2024: +0.43). The season home-field candidate (H1, ρ 0.7, m 250) removed it on validation
(−0.11) and cut it to +0.49 on 2025, and it improved 2025 log loss — but its 2025 MAE was
10.1989 against the incumbent's 10.1944, so the preregistered gate rejected it. The served model's
home field is now fully visible on the card (spread intercept 2.60 + context intercept 0.20 + the
early-season term, ≈ 3.06 points); before, 0.87 of it sat in a context term the card never showed.

## Acceptance 3 — KC @ SEA, re-run

| | old (as served) | v1 + fixes | **v2.0.0 (served)** |
|---|---|---|---|
| SEA margin | −6.72 | −5.69 | **−5.94** |
| SEA win probability | 73.5% | 68.6% | **69.6%** (fair ML −229) |
| 80% range (home margin p10 / p50 / p90) | −8 / 7 / 26 | −10 / 6 / 24 | **−10 / 6 / 24** (centred on the projection) |
| market (nflverse consensus) | SEA −3 | | model − market **2.94** (just under the 3-point flag) |

The v2 card — seven rows that sum exactly to the margin (`card.reconciles = true`):

| row | points (home +) | prior | this season |
|---|---|---|---|
| Base team strength | +3.26 | +4.31 | −1.05 |
| Passing | +0.16 | +0.16 | 0.00 |
| Rushing | −0.16 | −0.01 | −0.15 |
| Quarterback | −0.93 | | |
| Home field | +3.06 | | |
| Context (venue, division) | 0.00 | | |
| Rest / travel | +0.55 | | |
| **Total** | **+5.94** | | |

What changed against the audit (`audit_report.md`): the passing term that gave SEA +2.3 is now +0.16
(it was mostly SEA's frozen 2025 pass defence); the rushing term is no longer +1.0 KC (same cause);
the 0.87-point context term and the 2.03 points of rows the old page never showed are all on the card.
What did not change: SEA's 2025 prior (+4.31) still outweighs its 2026 evidence (−1.05) after six
games. The widened prior grid (carry 0.30–0.95, geometric and hyperbolic k/(k+n)) found the incumbent
decay best on 2010–2024, and the personnel prior (which would see the Walker move) did not beat the
incumbent on validation; both are in the table below.

## Acceptance 4 — every 2026 Week 7 card, old vs new

`week_cards_diff.js` → `results/week7_cards.json`. Old = git 72af3904 (the audit's baseline);
v1 fixed = git e9fed776 (the merged PR #634); v2 = `football/nfl/slate.json` now. Feed changes between
builds (injury reports, starters) are part of each change.

| game | old margin / win | v1 fixed | v2 (served) | change from old | market | v2 − market | new card rows sum to the margin | old card: points in no row (dropped context term) |
|---|---|---|---|---|---|---|---|---|
| CIN @ BAL | +1.50 / 55.6% | −0.12 / 50.0% | +0.78 / 50.7% | −0.72 | +3.00 | −2.22 | yes (+0.77) | −0.70 |
| CLE @ TEN | −1.30 / 45.1% | −0.95 / 48.9% | −1.05 / 48.7% | +0.25 | −1.50 | +0.45 | yes (−1.05) | −0.25 |
| DAL @ PHI | +1.42 / 55.3% | +1.45 / 52.3% | +3.79 / 64.3% | +2.37 | −4.50 | **+8.29 ⚑** | yes (+3.79) | −0.31 |
| DEN @ ARI | −2.66 / 40.2% | −2.12 / 46.3% | −5.32 / 30.7% | −2.66 | −4.50 | −0.82 | yes (−5.33) | −0.30 |
| GB @ DET | +7.67 / 76.3% | +5.82 / 69.0% | +5.33 / 67.8% | −2.34 | +3.00 | +2.33 | yes (+5.33) | −0.26 |
| IND @ MIN | +5.08 / 68.3% | +6.27 / 70.6% | +8.70 / 79.0% | +3.62 | +6.50 | +2.20 | yes (+8.70) | −0.22 |
| KC @ SEA | +6.72 / 73.5% | +5.69 / 68.6% | +5.94 / 69.6% | −0.78 | +3.00 | +2.94 | yes (+5.94) | +0.87 |
| LA @ LV | −3.35 / 37.7% | −3.91 / 35.2% | −4.32 / 33.2% | −0.97 | −4.50 | +0.18 | yes (−4.32) | −1.12 |
| MIA @ NYJ | −2.54 / 40.6% | +2.42 / 54.5% | +0.23 / 50.0% | +2.77 | +4.50 | **−4.27 ⚑** | yes (+0.23) | +0.41 |
| NE @ CHI | −1.17 / 45.6% | −0.09 / 50.0% | −0.32 / 49.9% | +0.85 | +3.00 | **−3.32 ⚑** | yes (−0.32) | −0.98 |
| NYG @ HOU | +9.41 / 81.0% | +9.06 / 79.7% | +9.50 / 79.9% | +0.09 | +10.00 | −0.50 | yes (+9.49) | +0.83 |
| PIT @ NO | +2.18 / 58.1% | −2.01 / 46.6% | −3.41 / 37.3% | −5.59 | −3.50 | +0.09 | yes (−3.41) | −0.03 |
| SF @ ATL | +0.08 / 50.3% | −2.11 / 46.3% | −2.54 / 45.2% | −2.62 | −3.00 | +0.46 | yes (−2.53) | +0.84 |
| TB @ CAR | +4.38 / 65.9% | +3.67 / 63.9% | +2.56 / 55.3% | −1.82 | +3.50 | −0.94 | yes (+2.55) | −0.30 |

All 14 Week 7 cards (and all 27 on the slate) reconcile to the cent; three carry the
"Model disagrees with market by X pts" flag. **DAL @ PHI is the one to distrust:** Jalen Hurts is out
(calf) and the model prices Tanner McKee, but with one start McKee's value is shrunk almost to the
league prior, so the QB row moves −0.21 where the market moved ~8 points. The regime layer's QB-out
adjustment (−3.06) is computed and shown but not priced — it has never passed a holdout. A
backup-QB prior is the first candidate for the next preregistration (see "Known limitations").

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
| 4 | T2 + T5 combination | 10.362 | 0.6305 | 10.176 | 0.6349 | passes against the incumbent, loses to T5 alone on 2025 — not promoted |

Holdout looks: 7 (Step 1: 2 — the old and fixed models; Step 2: 1; Step 3: 1; Step 4: 3), each
flagged in `variants.jsonl`; 372 variants evaluated in total. The final table above re-reads the
promoted model on 2025 for reporting, which decides nothing.

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

## Known limitations (stated, not fixed)

* **Backup quarterbacks.** A new starter's own value applies immediately, but a starter with little
  history is shrunk toward the league QB prior (−0.04 EPA/dropback), so an injury to an elite starter
  moves the number far less than the market (DAL @ PHI above). Fix candidate for the next
  preregistration: a lower prior for non-primary starters; the regime layer's QB-out term is the
  other, already-built, candidate.
* **The PMF near a pick'em.** The win probability is read off a median-centred discrete margin PMF;
  between fair margins of −0.5 and +0.5 it moves only 49.9% → 50.1%, because the median of a
  distribution with almost no mass at 0 sits in a gap. Monotone, but flatter than the market near 0.
* **Raw-scale ridge.** With the corrected `net_pts` the ridge shrinks the EPA terms hard (passing and
  rushing rows are small on every card). Standardising features before the ridge is a post-hoc idea
  from these results; it must be preregistered and pass the gate like anything else.
* **Not owned (INACTIVE):** per-player OL grades and any other PFF data; preseason win totals after 2020.

## Files

| what | where |
|---|---|
| model | `football/nfl_model.js` (v2), `football/engine.js` (v1 + fixes, serving) |
| served params | `football/nfl_params_v2.js` (`train.js`) |
| backtest | `backtest.js`, `run_steps.js`, `data.js`, `results/step1-4.json`, `results/final.json`, `results/oos_v2.csv.gz` |
| parity | `football/parity.test.js`, `parity_dump.py`, `parity/` |
| weekly loop | `weekly_loop.js`, `registry.json`, `versions/`, `results/weekly/`, `tools/record/nfl_weekly_eval.js`, `tools/record/nfl_weekly_report.js`, `tools/football/build_nfl_registry_sql.js` |
| week cards | `week_cards_diff.js`, `results/week7_cards.json` |
