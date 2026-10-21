# NFL model audit — KC @ SEA, Week 7 2026

**Scope:** the NFL model exactly as it stood at commit `72af3904` (before any change in this branch).
**Method:** read the code, then replay the live rating state outside the app and take it apart. Every number below was reproduced by a script, not read off a screen: `node tools/football/audit_kc_sea.js` (§3.0).

**The game:** `2026_07_KC_SEA`, Sunday 25 Oct 2026, 20:20 ET, Lumen Field (outdoors, FieldTurf). SEA rest 10 days, KC rest 7.

| | Model (live slate, 20 Oct 18:00Z) | Market (nflverse consensus) |
|---|---|---|
| Fair spread | SEA −6.72 (card shows −6.5, half-point display) | SEA −2.5 |
| Win prob | SEA 73.5% | SEA ~56% (−142 / +120, de-vigged) |
| Total | 42.58 | 42.5 |
| 80% range | KC by 8 → SEA by 26 | — |
| Moneyline | SEA −277 / KC +277 | |

---

## 0. Headline findings

Ordered by how much of the 4.2-point gap each one explains for this game, then by how much it damages the model league-wide.

1. **The 2025 prior is the gap.**
   - Replaying 2026 with no team prior, and with defenses correctly updated, gives **SEA −2.20**, which is the market number.
   - Replaying with the prior only (no 2026 game absorbed) gives **SEA −11.13**.
   - The live **−6.72** sits between the two because at 5–6 games played the prior still carries about half of every EPA rating and about two-thirds of every points rating (§2).
2. **Defensive ratings never update in season (live board), and are always zero (JS backtests).**
   - Training (`build_features.py`) builds `def_*` features from the opponent's offense row of the same game. None of the six JS callers of `absorbGame` does.
   - As a result:
     - Every `def_*` rating on the live board has been frozen at exactly `0.8 ×` its 2025 end-of-season value since Week 1.
     - The JS validation replays (`validate_pricing.js`, `linemaker_calibrate.js`) start cold, so their defenses are **zero in every season**. The published pricing tiers were measured on a defense-blind engine.
   - This is a training/serving mismatch on 6 of the 16 rating features.
   - For KC @ SEA it moves the number only 0.13 pts, because SEA's 2026 pass defense really is elite. It is the most damaging bug league-wide.
3. **The QB layer never updates in season.**
   - `absorbGame(…, [])` is always called with no QB starts, so every QB value is his 2025-and-earlier trained seed.
   - Darnold carries his 2025 Super Bowl-season value; Mahomes carries a near-league-average value.
   - Contribution to this game: **+0.45 SEA**.
4. **Home field is larger than the card says, and is shown three different ways.**
   - The card's "Home field 2.5" is only the strength-model intercept (2.48).
   - The context model adds its own intercept (+0.595) and a week term (+0.239), all of which favor the home side at an outdoor-turf venue. **The effective constant home edge for SEA is 3.31 pts.**
   - Measured HFA:
     - The closing market's average home spread is **1.63** (2021–25) and **1.78** (2026 to date).
     - The realized home margin is **2.06 ± 0.39** (2021–25).
   - Over 88 non-neutral 2026 games, the model's average home margin is **2.59** against a closing average of **1.78**, a **+0.8 pt systematic home lean**.
5. **The card's components cannot add up.**
   - `tools/football/build_nfl_slate.js:308–311` copies `contributions.spread` and `contributions.total` but drops `contributions.ctx`. That removes 0.87 pts from this card, and `drivers.reconciles` is false on 22 of 24 current NFL snapshots.
   - The card's basis text blames "Quarterback-regime and other post-model adjustments". **No such adjustment is applied** to this game: `regime.promoted:false`, coaching `adjustment_points:0`.
   - Two further presentation choices hide information:
     - The card shows unsigned points ("+X toward Team").
     - `net_pts` and `net_epa` are never surfaced as insights.
6. **Two different distributions describe the same margin.**
   - Win probability and moneyline use a Normal(6.72, σ=10.7), which gives 73.5%.
   - The 80% range and cover probabilities use the learned margin PMF, which gives 72.5% for the same quantity.
7. **The 80% range is right to be lopsided.**
   - Its median sits on the projection (p50 = 7).
   - Its midpoint (9) does not, because NFL margins around a 7-point favorite are right-skewed. Every closing home favorite of 6 to 7.5 from 2010–25 (n=558) finished at p10/p50/p90 = **−9 / 7 / 26**; the card says **−8 / 7 / 26**.
   - Forcing it symmetric would make it less accurate (§4).
   - Separately, the snapshot drops p50, so the card never shows where the median is.

### Your hypotheses, checked

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Preseason priors still dominate at Week 7 | **Confirmed — the main cause** | prior-only −11.13, evidence-only −2.20, live −6.72; prior share at n=5–6 is 48–54% (EPA) and 64–69% (points) |
| Passing +2.3 SEA despite bottom-5 offense: pass defense overweighted, or 2025 QB baked in | **Partly right, for a different reason** | 85% of the passing row (+1.99 of +2.34) is SEA pass D vs KC pass D, and *both* are frozen 2025 values. The coefficient is symmetric (one `net_pass` feature), so defense isn't overweighted; it is **never updated**. 2025 QB value adds a separate +0.45 in the QB term. |
| Rushing only +1.0 KC despite KC top-2 / SEA bottom-3; Walker move ignored | **Partly** | The rushing row is the *least* prior-driven row: prior-only −0.03, live −1.00, evidence-only −0.77. It is small because the trained coefficient on rush EPA (7.05) is about half the pass coefficient (12.50), and some rushing value flows through `net_epa`. No non-QB personnel exists in the model, so the Walker move is invisible, but here the team-level rush prior is near zero either way. |
| HFA 2.5 is too high; rest/travel leaking in | **Confirmed, and worse** | Effective constant home edge is 3.31, not 2.5. Rest is a separate feature. Travel distance and time zone are not modelled at all, so whatever travel effect exists is absorbed into the intercept. |
| ~2.7 pts unattributed | **Confirmed: 2.90 exactly** | `net_pts` 0.55 + `net_epa` 0.44 + QB 0.45 + rest 0.59 + ctx 0.87 (§3) |
| 80% range centered on SEA by 9 | **True of the midpoint, not of the median** | median = 7 = projection; the skew is real (§4) |

---

## 1. Inventory — every piece of the NFL model

The NFL model is **not served from Postgres**. Every number a card shows is computed by `football/engine.js`:
- in the browser (`app.html`), or
- in Node by booting `app.html`'s football module (`tools/football/_module.js`),

over public nflverse CSVs. The results are committed as JSON artifacts by GitHub Actions. Supabase holds side tables and mirrors only.

### 1.1 Model code

| File | Role |
|---|---|
| `football/engine.js` | The engine (ES5, browser + Node). NFL rating recursion: `newState`, `seasonBreak`, `teamGameFromStw`, `absorbGame`, `gameFeatures`, `predict`. Also distributions (`winProb`, `coverProbSpread`, `marginQuantiles`), market blend, `classifyEdge`, `predictGame`. |
| `football/params.js` | GENERATED trained constants: hyperparams, ridge weights, PMFs, 2025 end-of-season seeds, QB seeds, validation summary. |
| `football/research/build_features.py` | Team-game feature tables from nflverse `stats_team_week`, `stats_player_week` and `games.csv`. **Defense = opponent's offense row of the same game.** |
| `football/research/train_nfl.py` | Python reference recursion (`Ratings`), hyperparameter grid (tuned on 2003–2015), walk-forward ridge, context layer, market blend, PMFs, final fit on all seasons ≤ 2025. |
| `football/research/make_params.py`, `gen_goldens.py`, `goldens.json` | Writes `params.js` and the parity goldens (`football/tests.js`, 1e-9). |
| `football/research/fetch_data.sh`, `fetch_nfl_data.sh` | Raw data fetch (nflverse, 1999–2025). |
| `football/research/nfl_regime.py` → `football/nfl/regime_nfl.js` | QB/HC regime signal: research-only, not promoted. |
| `football/nfl/coaching_staff.js` | Coaching residuals: research-only, `adjustment_points:0`. |
| `app.html` `fbLoadNfl` (50603) | **Live absorb pass**: seeds → `seasonBreak` → 2026 games. Also `fbNflGameReq` (50151), `fbPredict` (51043), `fbNflRanks` (63191), the brief's `fbNflDrivers` (63474). |
| `lib/edgedesk_game_snapshot.js` | Builds the game card (`fromNfl`, `nflDrivers`, `insights`, `range80`). |
| `lib/edgedesk_game_view.js`, `lib/edgedesk_game_graphic.js` | Render the card page and the share image. |

### 1.2 Callers of the rating recursion (all six share the defense bug)

| Caller | Starts from | What it feeds |
|---|---|---|
| `app.html` `fbLoadNfl` | 2025 seeds × 0.8 | the board, slate, cards, record |
| `tools/football/build_nfl_slate.js` (boots `fbLoadNfl`) | same | `football/nfl/slate.json` |
| `football/health/daily_check.js` | same | `football/health.json` |
| `football/research/live_check.js` | same | manual check |
| `tools/football/validate_pricing.js` | **cold (zeros) from 2006** | `football/validation/pricing_nfl.json`, edge tiers |
| `tools/football/linemaker_calibrate.js` | **cold from 2006** | `football/validation/linemaker_nfl.json` |
| `supabase/functions/ingest_nfl_features/index.ts` | embedded 2025 seeds | `nfl_team_features` → dashboard `nfl_game_v1` |

### 1.3 Artifacts

| Artifact | Built by | Workflow |
|---|---|---|
| `football/nfl/slate.json` | `tools/football/build_nfl_slate.js` | `starter-context.yml` |
| `football/game_research/current.json` (the card) | `tools/football/build_game_research.js` | `starter-context.yml` / `game-research` |
| `football/nfl/stats_team_week_2026.csv` | `football/nfl/build_team_week.js` | `starter-context.yml` |
| `football/starters/nfl_2026.json` (QB only) | `football/starters/build_starters.js` | `starter-context.yml` |
| `football/pricing/lines_nfl.json`, `openers_nfl.json` | `tools/football/build_lines_archive.js` | `injury-sync.yml`, `learning-loop.yml` |
| `football/pricing/qb_starts_nfl.json` | `tools/football/build_qb_starts_archive.js` | `injury-sync.yml` |
| `football/validation/pricing_nfl.json` | `tools/football/validate_pricing.js` | `football-weekly-build.yml`, `learning-loop.yml` |
| `football/linemaker/fair_lines.json`, `grades.json` | `build_fair_lines.js`, `linemaker_grade.js` | `linemaker-build.yml` |
| `football/health.json` | `football/health/daily_check.js` | `model-health.yml` |
| **`record/football/nfl_2026.json`, `summary.json`**: the public NFL record (pregame number graded against the close: ATS, CLV pts, margin error, Brier) | `tools/record/football_record.js` | `football-model-record.yml` |
| `performance/ledger/*/nfl-2026.jsonl` (Model Performance page) | `tools/performance/run.js` | `performance.yml` |

### 1.4 Supabase

- **Tables**
  - `nfl_team_features` (`football/sql/010_nfl_team_features.sql`), written by edge function `ingest_nfl_features` (pg_cron `ingest_nfl_features_daily`, 09:00 UTC).
  - `nfl_line_snapshots` and related market-structure objects (`supabase/nfl_market_structure*.sql`, pg_cron Thu freeze).
- **Mirrors:** `model_pnl*`, `perf_*`, `recommendation_ledger`, `desk_prediction_history`, `projection_snapshots`, `market_comparisons`.
- **Edge functions touching NFL:** `capture`, `close` (odds and CLV on `signals`), `edgedesk_ai` (reads the slate), `ingest_nfl_features`, `research_cron`.
- **Research registry**
  - `research_models`, `research_model_versions`, `research_model_results` and `research_model_current` **exist only in production**; the repo has never held their DDL (`tools/football/build_prereg_sql.js:6–15`).
  - The only writer in the repo (`supabase/nfl_market_structure_studies.sql`) discovers column names at run time through `pg_attribute`.
- **Frozen protocols — not touched by this work**
  - The CLV ranking protocol: the scored `verdict` / `score` / slate `priority` in `app.html`'s edge layer (comment at 38341).
  - The model-predictions "frozen CLV baseline".
  - `football/market_structure/preregistration.json`'s `frozen_protocol`.

### 1.5 Data the repo owns or ingests

| Feed | Repo use | Notes |
|---|---|---|
| nflverse `games.csv` | scores, closing spread / total / moneyline, rest, roof, surface, QB ids | |
| nflverse `stats_team_week` | the rating inputs | |
| nflverse `stats_player_week` | QB layer in training | |
| play-by-play | market structure, starters, props | **not** the model |
| depth charts | QB only | |
| snap counts, rosters | props only | |
| injuries | | |
| `football/venues/nfl_stadiums.json` | verified stadium table | |

**Not owned:**
- per-player OL grades (PFF)
- preseason win totals after 2020: `nfldata/win_totals.csv` ends at 2020 (§6.7)
- any paid feed

---

## 2. How preseason priors are set, and how fast they decay

### 2.1 Mechanism (`engine.js` `newState` / `seasonBreak` / `absorbGame`; `train_nfl.py` `Ratings`)

1. **Seed.** Each team's 16 rating features at the end of the 2025 regular + postseason, from the Python training pass (`params.seed_ratings`). These are opponent-adjusted deviations from the league mean.
2. **Season break.** Every feature is multiplied by `carry = 0.8`, which regresses it 20% toward league average. QB values (`seed_qb_values`) are **not** regressed; each team's baked-in QB level (`teamQb`) is.
3. **In-season update.** After each game, `r ← (1−α)·r + α·perf`, where `perf = observed − league_mean − opponent's counter-rating`.
   - α = 0.10 for EPA-type features.
   - α_pts = 0.06 for points for/against.

So after *n* games the rating is:

```
r_n = 0.8·(1−α)^n · R_2025  +  Σ_i α(1−α)^(n−i) · perf_i
      └─ prior weight ──┘      └─ 2026 evidence, recency-weighted ─┘
```

The weights don't sum to 1. The remainder, `0.2·(1−α)^n`, is implicit shrinkage to league average.

### 2.2 Decay table (exact)

| games played *n* | EPA prior wt | EPA 2026 wt | prior share of signal | points prior wt | points 2026 wt | prior share |
|---|---|---|---|---|---|---|
| 0 | 0.800 | 0.000 | 100% | 0.800 | 0.000 | 100% |
| 2 | 0.648 | 0.190 | 77% | 0.707 | 0.116 | 86% |
| 4 | 0.525 | 0.344 | 60% | 0.625 | 0.219 | 74% |
| **5 (KC)** | **0.472** | **0.410** | **54%** | **0.587** | **0.266** | **69%** |
| **6 (SEA)** | **0.425** | **0.469** | **48%** | **0.552** | **0.310** | **64%** |
| 8 (midseason) | 0.344 | 0.570 | 38% | 0.488 | 0.390 | 56% |
| 12 | 0.226 | 0.718 | 24% | 0.381 | 0.524 | 42% |
| 17 | 0.133 | 0.833 | 14% | 0.279 | 0.651 | 30% |

**What the live board actually does is worse than this table**, because of two bugs:

| Component | Prior weight, all season |
|---|---|
| `def_*` (6 features) | **0.8 at every n**: never decays (bug §0.2) |
| QB values | **1.0 at every n**: never update (bug §0.3) |

### 2.3 How the constants were chosen

- `carry` and `α` came from a 3×3 grid in `train_nfl.py:294–299`:
  - carry ∈ {0.50, 0.65, 0.80}
  - α ∈ {0.07, 0.10, 0.14}
  - α_qb ∈ {0.08, 0.12, 0.18}
- The grid was scored on walk-forward MAE for 2003–2015.
- **carry = 0.8 is the top edge of its grid, so the optimum was never bracketed.**
- The prior is purely team-level. There is:
  - no personnel adjustment: a starting QB change moves the QB term only; RB, WR and OL moves move nothing;
  - no market information.

---

## 3. KC @ SEA, fully decomposed

### 3.0 How this was measured

`node tools/football/audit_kc_sea.js` loads `football/engine.js` and `params.js`, rebuilds the state exactly as `fbLoadNfl` did (same seeds, same season break, same 93 games in the same order, same `stats_team_week_2026.csv`), and predict the game with the slate's inputs:
- Darnold `00-0034869` vs Mahomes `00-0033873`
- rest 10 / 7, outdoors, FieldTurf, week 7

The replay reproduces the live slate to the cent: 6.72, 73.5%, −8/7/26.

Each scenario changes one thing:
- **prior only**: absorb no 2026 games.
- **no prior**: zero every team seed and the QB layer, then absorb 2026.
- **parity**: fill `def_*` from the opponent's offense row exactly as `build_features.py` does (what training saw).

### 3.1 The fair margin is the sum of 15 terms (SEA positive)

**Strength model** (`koerner`, `w_spread`). Feature value × weight = points:

| Term | Feature value | Weight | Points | On card? |
|---|---|---|---|---|
| intercept ("Home field") | — | 2.48073 | **+2.481** | yes (+2.5) |
| `net_pts`: points for − against | 3.2540 | 0.16780 | +0.546 | **no** |
| `net_epa`: overall EPA/play, O − D | 0.04391 | 10.09991 | +0.443 | **no** |
| `net_pass`: pass EPA/db, O − D | 0.18690 | 12.49957 | **+2.336** | yes (+2.3) |
| `net_rush`: rush EPA/att, O − D | −0.14187 | 7.04529 | **−0.999** | yes (−1.0) |
| `qb_adj_diff`: QB vs baked-in level | 0.07954 | 5.69666 | +0.453 | **no** |
| `rest_diff`: (10−7)/7 | 0.42857 | 1.36856 | +0.587 | **no** |
| `div_game` | 0 | −0.65617 | 0 | — |
| **subtotal** | | | **5.846** | |

**Context model** (`stuckey`, `w_ctx`, fit on the strength model's residuals). Every row here is **dropped by the slate builder**:

| Term | Feature value | Weight | Points |
|---|---|---|---|
| intercept | — | 0.59499 | +0.595 |
| `week_frac`: 7/18 | 0.38889 | 0.61437 | +0.239 |
| `rest_diff` | 0.42857 | 0.09385 | +0.040 |
| `is_dome`, `grass`, `home_short`, `away_short`, `home_off_bye`, `away_off_bye`, `div_game` | 0 | — | 0 |
| **subtotal** | | | **0.874** |

**Fair margin = 5.846 + 0.874 = 6.720.**

**The unattributed residual:**

| Shown on card | Not shown |
|---|---|
| 2.481 + 2.336 − 0.999 = **3.818** | `net_pts` 0.546 + `net_epa` 0.443 + QB 0.453 + rest 0.587 + ctx 0.874 = **2.903** |

### 3.2 Where each row comes from: prior vs 2026

Each column is a full replay. "Evidence only" uses the corrected (parity) defense.

| Term | Live | Prior only (no 2026 games) | Evidence only, parity defense | Parity (as trained) |
|---|---|---|---|---|
| Home field (intercept) | 2.48 | 2.48 | 2.48 | 2.48 |
| `net_pts` | 0.55 | 0.66 | 0.09 | 0.55 |
| `net_epa` | 0.44 | 1.91 | −0.71 | 0.46 |
| `net_pass` | 2.34 | **4.19** | **−0.35** | 2.23 |
| `net_rush` | −1.00 | −0.03 | −0.77 | −0.78 |
| QB | 0.45 | 0.45 | 0.00 | 0.45 |
| rest | 0.59 | 0.59 | 0.59 | 0.59 |
| context | 0.87 | 0.87 | 0.87 | 0.87 |
| **Fair margin** | **6.72** | **11.13** | **2.20** | **6.85** |
| Win prob (Normal) | 73.5% | 85.1% | 58.1% | 73.9% |

Reading this table:
- **The prior is worth +4.65 pts to SEA** (6.85 − 2.20, under parity).
- Of that, the passing row is +2.58, `net_epa` +1.17, QB +0.45 and points +0.46.
- The defense-freeze bug costs only −0.13 for this game.
- With no prior, the model would be at SEA −2.2 against a market at −2.5.

### 3.3 The passing row, unbundled

`net_pass = (SEA passO − KC passO) + (KC passD − SEA passD)`. Both pieces share one weight (12.50).

| Piece | SEA | KC | Difference | × 12.50 |
|---|---|---|---|---|
| Pass offense rating (EPA/db above avg) | +0.0351 | +0.0073 | +0.0278 | **+0.35** |
| Pass defense rating (allowed; lower is better) | −0.1912 | −0.0321 | +0.1591 | **+1.99** |

Both defense values are exactly `0.8 ×` the 2025 seeds (SEA −0.23898, KC −0.04017): **frozen**.

| Raw 2026, unadjusted | SEA | KC |
|---|---|---|
| Pass defense | −0.130 (#2) | −0.087 (#3) |
| Pass offense | +0.007 (#19) | +0.174 (#8) |

So:
- The model is right that SEA's pass D is good.
- It cannot see that KC's pass D is also good this year.
- It rates KC's pass offense #16 because KC's 2025 seed (−0.106) still drags it.

### 3.4 The rushing row

`net_rush = (SEA rushO − KC rushO) + (KC rushD − SEA rushD) = (−0.0831 − 0.0809) + (−0.0466 + 0.0687) = −0.1640 + 0.0221 = −0.1419`, × 7.045 = **−1.00**.

- KC's rush offense edge alone is −1.16 pts. SEA's frozen 2025 rush D gives back +0.16.
- The rush coefficient (7.05) is roughly half the pass coefficient (12.50), and `net_epa` carries another share of rushing through `off_epa_play`.
- That is why KC #2 vs SEA #30 in rush EPA moves only 1 point.
- Personnel is not modelled. Kenneth Walker III is on KC's 2026 roster (68–82% of offensive snaps in nflverse snap counts), but he exists in the model only through KC's 2026 team rushing EPA.

### 3.5 Efficiency ranks on the card

- "Overall" = rank of `off_epa_play − def_epa_play` from the live rating state.
- SEA #5 = −0.0199 − (−0.1416) = 0.1217. KC #9 = 0.0396 − (−0.0382) = 0.0778.
- Both are blended with the 2025 prior, and the defensive half is entirely 2025.
- KC 5-0 at +11.4/game and SEA 3-3 at +4.3/game feed only the slow `pts_*` ratings (α = 0.06). Even those are 64–69% prior.

---

## 4. The 80% outcome range

### 4.1 How it is computed

`predictGame` → `dist.marginQuantiles('nfl', 6.72, [0.1, 0.5, 0.9])` (`engine.js:298–323`):

1. `margin_pmf_by_spread` is a table of P(final margin = m | **closing** spread = s) for s = −14 … +14. It is a Gaussian kernel (bandwidth 3) over 2003–2025 closing spreads, with real key-number spikes.
2. `centredOn` (audit 2026-09-30 #4) finds the two adjacent keys whose medians bracket 6.72 (keys 8.5 and 9.0) and mixes them so the mixture's **median is exactly 6.72**. Spikes stay on 3, 7, 10, 14.
3. Quantiles are read off the cumulative mass.
   - For KC @ SEA: p10/p25/p50/p75/p90 = **−8 / −2 / 7 / 17 / 26**; mean 7.56.
   - The slate stores p10/p50/p90. The snapshot (`edgedesk_game_snapshot.js:645`) keeps only p10/p90.

### 4.2 Why its midpoint is 9, not 6.7

- The distribution is skewed toward the favorite: a 7-point favorite loses by 8+ less often than it wins by 26+.
- This is a fact about NFL outcomes, not a defect:

  | Source (2010–2025) | p10 | p50 | p90 | mean − median |
  |---|---|---|---|---|
  | All closing home favorites of 6 to 7.5 (n=558) | −9 | 7 | 26 | +0.63 |
  | The card | −8 | 7 | 26 | |

- **The range is already centred on the projection in the sense that matters (its median).** A symmetric 6.72 ± 17 interval would over-cover the underdog side and under-cover the favorite side.
- The fix that keeps the range honest is to show the median marker and label it. The card currently drops p50.

### 4.3 What is actually wrong with the distributions

| Number | Distribution | KC @ SEA value |
|---|---|---|
| Win prob, moneyline | Normal(fair, 10.7) | 73.5% |
| Range, cover probabilities | margin PMF | P(SEA wins) = 72.5% |

- These are two models of one quantity, and they disagree by about 1 pt here.
- The PMF is conditioned on *closing* spreads. When it is fed the model's (noisier) number, it is only as wide as the market's uncertainty. Whether that is well calibrated for the model is an empirical question; it is the isotonic-calibration toggle in the build plan.

---

## 5. Are offense and defense rated separately for pass and rush?

**In the rating state: yes.** There are 16 features per team, separately for O and D:

| Pass | Rush | Overall / other |
|---|---|---|
| `pass_epa_db`, `def_pass_epa_db` | `rush_epa_att`, `def_rush_epa_att` | `off_epa_play`, `def_epa_play` |
| `expl_pass`, `def_expl_pass` | `expl_rush`, `def_expl_rush` | `sack_rate_all`, `sack_rate_made`, `pass_rate`, `plays`, `pts_for`, `pts_against` |

Each feature is opponent-adjusted against its counter (e.g. pass O against the opponent's pass D).

**In the spread model: no.**
- The spread sees `net_pass = (passO_h − passD_h) − (passO_a − passD_a)` and the same for rush. Offense and defense are forced to share one coefficient.
- So a point of pass-defense EPA counts exactly as much as a point of pass-offense EPA. Year-to-year, defensive EPA is known to be less stable than offensive EPA; the model cannot learn that.
- `net_epa` overlaps with both rows (it is a dropback/carry-weighted mix of them), so per-row attribution is soft.

**In the live state: no, because of the bug.** Only offense updates; every defensive rating is frozen at 2025 × 0.8.

The total model does split them (`pass_matchup`, `rush_matchup`, `off_epa_sum`, `def_epa_sum`). It has the same frozen-defense input.

---

## 6. Everything else found

1. **Validation drift.**
   - The README / `params.js` validation (MAE 10.20 vs close 9.78, Brier 0.2232 vs 0.2106) is the Python walk-forward with defenses on.
   - `pricing_nfl.json` and the board's LEAN/VALIDATED tiers come from `validate_pricing.js`, a JS cold replay with defenses always zero.
   - Neither is the live model (defenses frozen).
2. **Absorb order within a game.**
   - Python absorbs the two teams in `stats_team_week` row order (alphabetical); the app absorbs home first.
   - League means update sequentially inside `absorbGame`, so the second team's update differs by ~1e-6. A strict parity test catches it.
3. **QB starts in training vs. live.**
   - Training credits each team-game's QB with the most dropbacks (`stats_player_week`, position QB, dev = passing EPA/dropback − league pass mean before the game, ≥ 10 dropbacks).
   - The live board feeds none. `validate_pricing.js` can feed `qb_starts_nfl.json`, which uses the *listed* starter, not the top passer: a third rule.
4. **The context intercept survives neutral sites.** `nfl.predict` zeroes only the strength intercept, so +0.595 + week term still goes to the nominal home team at a neutral site.
5. **`ngames` sentinel.** Seeded teams start at `ngames = 99`, so the `known` field (104 on this card) is meaningless.
6. **The card's driver basis text** claims post-model adjustments explain the reconciliation gap; it is the dropped ctx model. The brief (`fbNflDrivers`) merges spread + ctx but truncates to 9, then 6 rows, while its text says the rows "add up to the projected spread exactly".
7. **`net_pts` has the wrong sign on points allowed.**
   - The definition in both `train_nfl.py:172` and `engine.js` is `(pts_for + pts_against)_home − (pts_for + pts_against)_away`.
   - `pts_against` is points *allowed* above average (higher is worse), so the feature measures a scoring *environment*, not a margin; the intended sum is `pts_for − pts_against`.
   - The card labels it "Scoring margin". It got a small weight (0.168).
   - Training and serving agree, so this is a formula error, not a parity bug. The fix is a backtest-gated candidate in the build.
   - For KC @ SEA the two definitions happen to give similar values: 3.25 now vs 3.83 corrected.
8. **Preseason win totals stop at 2020.** `nflverse/nfldata/data/win_totals.csv` carries 32 teams × 2003–2020 (one consensus line per team, no book). It has nothing for 2021–2026, so a win-total prior can be neither validated on the 2025 holdout nor served for 2026. We own no other source, so it stays inactive. Prior-week **closing spreads** are in `games.csv` for every game since 1999 and can be used.

---

## 7. What the build changes

Steps 1–6 of the build follow in this branch, in order, with a backtest after each:

1. correctness fixes
2. prior decay, personnel and market priors
3. HFA and context
4. core toggles
5. the weekly loop
6. the other sports

The results — every promoted change and every rejected candidate — are in `football/research/nfl_v2/RESULTS.md`, and the preregistration is in `football/research/nfl_v2/preregistration.json`, written before any 2025 holdout number was computed.

## 8. Step 6 — the other models, audited for the same four bug classes

The same four classes as the NFL: **(1)** a frozen opponent/defence layer, **(2)** a frozen player
layer, **(3)** a training/serving mismatch, **(4)** dropped components or two distributions describing
one number. Read-only audits, reproduced from committed artifacts; the scratch scripts are named
where a number comes from one. What was fixed is in §9.

### 8.1 College football (`football/cfb_p4`, live and priced; `cfb_v2` shadow)

| # | class | finding | size |
|---|---|---|---|
| C1 | 2 | 16 of 34 efficiency features (EPA/play, EPA pass, EPA rush, passing-down success, explosive EPA rate, front disruption, points/drive, start field position, and their `def_` mirrors) are never supplied by `football/rankings/engine_efficiency.js`, so `engine.js` never updates them: 2,176 of 2,176 such team-feature cells sit at exactly 0.5 × the 2025 close all season. They are labelled "updated this season" with confidence 1, and `effFresh` counts feature updates, not games ("126 play-level games" for a 7-game team). The held-out record fed them every week from `team_game.csv`, so the record measures a different matchup layer from the served one. | mean 0.42 pts on the slate's fair spread, max 1.56 |
| C2 | 3 | The measured efficiency features are defined differently in training (`build_team_game.py`) and serving (`engine_efficiency.js` via `players/build_players.js`): sacks credited to the row's `team` (44.6% of 2026 sack rows carry the DEFENCE) vs the drive's offence; garbage time by post-play margin at weight 0.35 vs pre-play margin at weight 0; yards/play without vs with sack yardage; FCS opponents pooled vs keyed. | matchup term moves mean 0.40, max 1.45 pts; 19 of 62 games ≥ 0.5 |
| C3 | 4 | Three distributions for one margin: the win probability and moneyline from a Normal on the fair margin; the 80% range from `margin_resid_pmf` (mean −1.16, fitted on a core that used HFA 4.08 while the engine now uses 2.8); cover and alternate lines from the market-conditioned PMF. The range median sits exactly 1.00 pt below the fair margin on all 62 cards, P(home) differs by up to 5.1 pp between them, and the range's basis text says "conditioned on the current market spread" when it is not. The terminal's `games.json` says v1.0.0 on 59 of 59 games while the slate prices v1.0.1. | every card |
| C4 | 3 | The calibrators (`tools/football/linemaker_calibrate.js`, `cfb_p4/research/hfa_unify.js`, `research/calibrate.js`, `health/daily_check.js`) replay an engine with no matchup term and no pace term (they wipe `st.eff` and absorb without `team_stats`); only `backtest_engine.js` passes efficiency. The CFB linemaker's CALIBRATED statuses and the shipped HFA of 2.8 were measured on that engine. | linemaker record |
| C5 | 4 | The card's scoring-distribution block is centred on a different total than the header's fair total (mean 1.78 pts apart). | display |
| C6 | 4 | (shadow only) `cfb_v2/research/v2/predict_live.py:110` multiplies drivers by max/max = 1 instead of the stack weight 0.5, and the GBM half is never attributed. | 2× the drivers |

Clean: the rating tracks and scoring EWMAs update both teams through one code path shared by the
build, the app and the backtest; game order, identity and FBS flags match training; the MEASURED
defensive features are mirrored from the opponent's offence row (all 2,448 cells moved); the
conference term reads only the prior season; the P4 QB layer is dormant in both training and serving;
driver rows sum to the published margin on 62 of 62 cards. `football/engine.js`'s CFB layer is not live.

### 8.2 Basketball lab (`basketball/`: WNBA, NCAAM, NCAAW, the lab's NBA ratings)

| # | class | finding | size |
|---|---|---|---|
| B1 | 1, 3 | Team ratings are refit only weekly (`basketball/walkforward.js`, `lab-validate.yml`, Wednesdays) while prices are published daily (`lab-build.yml` → `build_slate.js`) from the stale `params/<league>_live.json`. The validated record absorbs every game as it finishes, so serving lags it by up to 7 days, and week 1 runs on preseason priors. `inputs_known_at` is the latest final in the data, not the ratings' last game, so the freshness gate passes regardless. | mean \|Δp\| 1.4–1.6 pp, max 22–40 pp |
| B2 | 4 | Two distributions: the moneyline from a logistic fit, the margin, spreads and cover from a separate Normal(mu, sd_margin); up to 3.05 pp apart on the NBA slate. The spread row at line 0 carries a 2.8% push in a sport that cannot tie. | up to 3 pp |
| B3 | 3 | The serving b2b flag counts a postponed (scheduled, unplayed) game; training counted finals only. | negligible |

### 8.3 NBA (`nba/`)

| # | class | finding | size |
|---|---|---|---|
| N1 | 3 | `nba/ingest/season.js` advances `last` / `recent` / `streak` only over FINAL games, so a game whose team's previous game is not yet played is served rest = 3, b2b = 0, games_7d = 0, travel = 0 — values no training row had. 423 real back-to-backs among 2026-27 scheduled rows, 0 flagged; 14 of 22 games on the slate were a second game inside 72 hours. Self-corrects once the first leg is final, so the final pregame number is usually right and earlier ones are not. Props inherit it. | ridge −4.6 pts on a mis-served away b2b |
| N2 | 4 | "What moved the number" shows ridge contributions while the published price is the G_stack_P model: the rows miss the published margin by 2.51 pts on average (max 4.18) and point the other way in 9 of 22 games. | every card |
| N3 | 4 | The board's NBA candidates come from the basketball lab's model, not the NBA engine, so the board and the NBA page show two numbers for one game (PHI @ NY 0.811 vs 0.773). | cross-surface |
| N4 | 3 | (comparison row only) the lab-points row reads the weekly lab params while training used a point-in-time pass. | none on the price |

Clean: every NBA state (Elo, Glicko, Kalman, adjusted efficiency, the RAPM player layer) is re-run
through the same `pass.js` at serve time every 3 hours; moneyline, spread, total and intervals come
from one distribution.

### 8.4 The rest

* **NHL** — clean: ratings and the goalie layer re-run every build, rest from the schedule including
  unplayed games (matches training), the explanation sums exactly (max residual 5e-5), every market
  from one distribution.
* **MLB** — the run model is untrained (constants in `mlb/params.js`), so class 3 has no training to
  compare with; season inputs are read live from Supabase. M1 (minor, 4): a +0.016 last-bat bonus is
  added to the win probability only, so the moneyline (0.604) and the run distribution (0.588)
  disagree — documented as a design choice in `params.js`. M2 (minor, 3): the starter's ratios and his
  shrinkage innings come from different tables; a name-key miss regresses him to league average (a
  warning shows).
* **College basketball** — the lab (B1–B3 above) plus `basketball/ncaam_research`, which is clean (one
  normal for everything; a static pack with no in-season feed, by design).
* **College baseball** — the lab is clean (deterministic replay, same rest rule as training,
  projected not oracle starters, coherence check; off-season). The app's `projectCbbGame` has M1's
  bonus and is a second number beside the lab board (minor).
* **UFC** — no model is registered (`lib/ufc_research.js`; `engine/lab/ufc_elo.js` measures, publishes
  nothing). Nothing to audit.
* **Tennis** — retired 2026-09-27. Latent if revived: the rating layer is frozen at the archive's end
  (live results never reach the feature rows; class 1/2, would be critical), and serve-time rest,
  workload and form are anchored to the record's last date while serve/return strength are null at
  serve time (class 3).

Severity: no critical finding in a live product. Material: C1, C2, C3, C4, B1, B2, N1, N2, N3.

## 9. Step 6 — what was fixed, and what was not

The rule for Step 6 was the NFL's: correctness fixes (serving must equal what was validated; one
distribution per number; components that add up) ship; anything that changes a validated number goes
through its sport's backtest first. Each fix below has a test.

**Fixed**

| finding | fix | test |
|---|---|---|
| N1 NBA schedule context | `nba/ingest/season.js` advances rest / b2b / games-in-7 / travel / streaks over every game that is final **or still ahead** (a past-dated unplayed game is postponed and never counts); box-score fields stay final-only. Historical (all-final) training rows are unchanged. | `tools/nba/nba.test.js` (3 checks) |
| N2 NBA drivers don't add up | `nba/build_slate.js` keeps the ridge model's largest rows and adds three reconciling rows — its other inputs, its value at an average matchup, and what the other blended models and the calibration add — so the rows sum to the published margin exactly; the page says so; the graphic's headline driver never picks a reconciling row. | `tools/nba/nba.test.js` (on the next slate build) |
| B1 lab ratings a week stale | fixed on main by cfcd580c (the daily lab build now re-runs the walk-forward, so the live ratings are refit every day and `basketball/params` is published); this branch adds that the projection's `inputs_known_at` is the last game the ratings absorbed (`ratings_through`), not the last final in the data. | `basketball/build_slate.js --check`, `tools/lab/lab.test.js` |
| B2 (part) push at a pick'em | a basketball final margin includes overtime, so a pick'em spread line splits the regulation-tie mass between the sides instead of pricing a push. | `tools/lab/lab.test.js` (2 checks) |
| C3 CFB range off-centre / mislabelled | the terminal's range is read off the same conditioned PMF that prices every line, so its stated basis is true; the engine's fallback range is centred on the fair margin. Across 61 games the range median moved from 0.97 pts below the fair margin on average (exactly 1.00 on every card) to +0.02. | `football/cfb_terminal/build.js --check`, the CFB suites |
| C1 (label) CFB seed features shown as current | each efficiency feature is labelled by its own updates: one the play-level feed never supplies says "trained seed, not updated since" at seed confidence and is listed in `efficiency_seed_features`; absorbed games are counted once per game. | `football/cfb_p4/tests.js` |

**Not fixed here, and why**

| finding | why not | what it needs |
|---|---|---|
| C1 (numbers) CFB matchup uses 16 frozen features | serving ≠ the record either way: feeding them needs a live play-level EPA pipeline (`ep_surface`) that does not exist; dropping them changes the matchup in a way no backtest measured | build the live EPA features, then re-run `research/backtest_engine.js` on the served definitions |
| C2 CFB feature definitions differ | a re-definition changes every matchup term (mean 0.40 pts) | emit the serving artifact with `build_team_game.py`'s definitions and re-validate, or retrain on the serving ones |
| C4 CFB calibrators replay without efficiency | the calibrations they produced (linemaker statuses, HFA 2.8) would all be re-measured, i.e. re-decided | one shared replay helper passing per-game efficiency, then re-run each calibration through its gate |
| C3 (rest) CFB win probability from a Normal | moving the moneyline onto the PMF changes the validated CFB moneyline | a backtest of the PMF moneyline against the Normal one |
| B2 (rest) lab moneyline logistic vs Normal spreads | the logistic moneyline is the validated product (OUTCOME_VALIDATED); replacing it is a model change | run the walk-forward with the moneyline read off the margin distribution, promote only if it wins |
| N3 board NBA ≠ NBA page | not a bug inside either system: the engine registry's NBA brain *is* the lab model, with the lab's validation as its evidence; choosing which NBA model the board shows is a product decision | the owner's call |
| C5, C6, F3, N4, M1, M2, the tennis findings | display-only, shadow-only, comparison-only, documented design choices, or a retired product | — |

The weekly improvement loop exists for the NFL only (§ Step 5). The other sports keep the loops
they already had (the lab's weekly walk-forward, now with a daily refit; the NBA engine's 3-hourly
pass; the CFB lab). A separate session is building a cross-sport loop in `model_loop/` (merged in
PR #633); this branch does not touch it.
