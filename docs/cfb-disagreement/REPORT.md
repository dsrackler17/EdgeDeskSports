# Making EdgeDesk earn the right to disagree — the major-disagreement report

**Scope.** The production CFB pricing engine (`football/cfb_p4/engine.js`, the
priced V1 number on the board) produced too many large model-vs-market
disagreements. This work audits where they come from, measures whether
EdgeDesk was right to disagree, and replaces the raw-size label
`MAJOR DISAGREEMENT` with an integrity gate. No new model was built. The pure
football number was not moved toward the market, and the market never became
a football input.

**Evidence base.** A cold walk-forward replay of the shipped engine, 2015–2026:
10,074 games priced at the Tuesday-12:00-UTC freeze, with production-equivalent
priced inputs (rating, home field, the stylistic matchup built by the same
efficiency adapter the board uses, schedule stress, conference), joined
afterwards to the cfbfastR multi-book opener/close archive (2015–2025) and the
Model Lab ledger (2026). It reproduces the published held-out record exactly
(2022–2025 closing-market MAE 12.015). Every measured parameter the gate uses
was fitted on **2015–2021** when the **2022–2025 holdout** was scored. 2026 is
the prospective check.

Every number below is copied from generated files:
`football/validation/disagreement/forensics_cfb.json` (and its rendering
`FORENSICS.md`) and `football/validation/disagreement/slate_2026_week_05.{json,md}`.
The design contract is [`DESIGN.md`](DESIGN.md).

---

## Headline

| | old system | new system |
|---|---|---|
| what a raw 7+ gap is called | MAJOR DISAGREEMENT | INVESTIGATE until it passes every check |
| holdout 2022–25 raw 7+ gaps | 462 labelled major | 98 verified (football checks) · 54 verified (strict market rules) |
| false extremes carrying the major label (holdout) | 129 | 24 (−81%) · 13 strict (−90%) |
| favourite-flip false extremes (holdout) | 31 | 4 |
| EdgeDesk closer to the final than the opener (holdout 7+) | 39.6% of major labels | 45.9% of verified (51.9% strict) · 37.9% of unverified |
| CLV, points, market moving toward EdgeDesk (holdout 7+) | +0.56 | +1.56 verified vs +0.30 unverified |
| priced fair spread, MAE | 12.910 | 12.910 (byte-identical; the gate never touches it) |
| current slate (2026 wk 5) | 6 MAJOR DISAGREEMENTs | 0 verified · 2 INVESTIGATE · 4 MARKET FAULT |
| 2026 to date (prospective, vs the close) | 38 major labels; EdgeDesk closer than the close in 23.7% | 35 INVESTIGATE (32 early-season prior) · 3 verified, none closer than the close (1 of 3 covered) |

The gate does what it was built to do: large false disagreements fall sharply,
and the survivors carry clearly more information than the raw gaps. The
evidence that verified gaps are *profitable* is weak, and it is not claimed.
Their market-movement edge on the holdout is modest (55.1% vs 51.1%), and none
of the three 2026 verifications finished closer than the close. VERIFIED is a
research flag that earned its place, not a bet signal.

---

## 1. The historical major-disagreement dataset

`football/validation/disagreement/major_disagreements_cfb.csv.gz`: **3,090
rows**, every completed game 2015–2026 with |pure fair − market| ≥ 5 at the
prediction instant (the opener; the close where none exists, most of 2026).
Columns: game, season, week, prediction timestamp, kickoff, teams,
conferences, FBS/FCS, neutral site, pure fair margin, opener, current
consensus, closing consensus, final margin, raw gap, reference, bucket,
direction, favourite flip, football confidence, reliability*, ensemble
disagreement (SD), prediction sigma, QB certainty*, roster certainty*, every
additive term (rating, home field, matchup, conference, schedule/rest/travel,
QB, injury, weather, special teams, rivalry), current-form adjustment, prior
contribution, roster contribution, team-state ratings (carried and
this-season, both teams), prior weight, games played, data completeness,
source freshness, book count, dispersion, the five V2 submodels and their
ensemble, and outcome columns (close moved toward, closer than opener /
close, side covered, false extreme, gate status, root cause). *Empty when the
historical corpus cannot carry it. Weather, special teams and roster
contribute 0 to the V1 mean by design.

13 archive openers were data faults (|line| > 60, or more than 17 points from a
multi-book close, e.g. UCF–Maryland 2016 opened −9 at one book and closed
+10.5 at seventeen). They are excluded as the prediction-time reference and
listed in `forensics_cfb.json` → `archive_opener_faults`.

## 2. Raw gap distribution

Signed gap vs the opener, 2015–2025 (n 7,415): mean **+1.14**, median +1.18,
SD 4.72, p5 −6.56, p95 +8.62, p99 +12.37. The positive centre is the
home-field over-application (§14). Rate of 7+ gaps by week: weeks 0–2
**24.3%**, weeks 3–5 15.9%, weeks 6+ 10.5%.

## 3. Counts

| span | games | 5.0–6.9 | 7.0–9.9 | 10.0–14.9 | 15.0+ | 7+ | 7+ share |
|---|---|---|---|---|---|---|---|
| 2015–2025 | 7,357 | 1,092 | 689 | 263 | 46 | 998 | 13.6% |
| dev 2015–21 | 4,238 | 595 | 377 | 139 | 20 | 536 | 12.6% |
| holdout 2022–25 | 3,119 | 497 | 312 | 124 | 26 | 462 | 14.8% |
| 2026 to date (vs close) | 164 | — | — | 10 at 10+ | 3 | 38 | 23.2% |

**Was EdgeDesk right to disagree?** (2015–2025, vs the opener)

| gap | n | model MAE | opener MAE | closer than opener | close moved toward | CLV pts | side covered | false extremes |
|---|---|---|---|---|---|---|---|---|
| 0–1.9 | 2,541 | 12.25 | 12.23 | 49.3% | 43.2% | +0.02 | 50.9% | — |
| 2–4.9 | 2,726 | 12.73 | 12.45 | 45.8% | 46.7% | +0.23 | 50.8% | — |
| 5.0–6.9 | 1,092 | 13.65 | 12.52 | 40.2% | 50.3% | +0.29 | 47.2% | — |
| 7.0–9.9 | 689 | 13.50 | 12.01 | 41.1% | 53.8% | +0.55 | 51.5% | 27.4% |
| 10.0–14.9 | 263 | 15.25 | 12.19 | 38.0% | 56.7% | +0.91 | 51.2% | 27.0% |
| 15.0+ | 46 | 21.79 | 15.05 | 28.3% | 54.3% | +2.37 | 45.7% | 28.3% |

The market does move toward EdgeDesk's big disagreements more often than not.
There is price discovery in them. But the model is further from the result
than the opener in about 60% of 7+ gaps. The disagreement carries signal, and
its size overstates it.

## 4. Root-cause breakdown (holdout 2022–25, 7+ gaps, football checks)

| root cause | 7+ gaps | false extremes | moved toward | CLV |
|---|---|---|---|---|
| EARLY_SEASON_PRIOR_ERROR | 158 | 59 | 43.7% | −0.16 |
| VALID_MODEL_DISAGREEMENT (verified) | 98 | 24 | 55.1% | +1.56 |
| HFA_ERROR | 90 | 18 | 55.6% | +0.61 |
| TEAM_RATING_ERROR (independent submodels side with the market) | 81 | 18 | 59.3% | +0.89 |
| EXTREME_FAVORITE_NONLINEARITY | 24 | 7 | 58.3% | +0.46 |
| CROSS_CONFERENCE_SCALE_ERROR | 7 | 1 | 71.4% | +0.57 |
| MATCHUP_OVERADJUSTMENT | 2 | 1 | 0% | −2.0 |
| UNKNOWN (kept, never invented) | 2 | 1 | 0% | −2.6 |

Under strict market rules, THIN_MARKET and STALE_MARKET appear too (the
2022-era openers were single-book). Classification is automated: the first
failing check, in fixed priority order. Incomplete verification yields UNKNOWN.

## 5. Base-rating audit

In **63%** of 7+ gaps the neutral rating difference plus home field *already*
disagrees with the market by 7+ before any game adjustment. The remaining 37%
are created by an adjustment: the conference term (133 gaps), the matchup term
(224), or a combination (12). Base-driven gaps: moved toward 53.3%, false
extremes 27.2%. Conference-driven: 49.6%, 32.3% (noise). Matchup-driven:
61.6%, 25.0% (the most informative). **Rating construction is the main
source, and within it the early-season prior dominates (§7).**

## 6. Multi-season carryover

Outcome-implied weight on the carried (long-term) state vs the shipped blend:

| current-season games | n | implied prior weight | shipped |
|---|---|---|---|
| 1–2 | 1,244 | 0.905 | 0.998 |
| 3–4 | 1,419 | 0.857 | 0.881 |
| 5–7 | 2,051 | 0.939 | 0.657 |
| 8+ | 2,768 | 1.228 | 0.600 |

By group at 3–7 games: power vs power 0.961 (shipped 0.746), other FBS 0.825
(0.737). The carried Elo already absorbs this season's games (k = 0.14), so
the this-season-only track adds little once it exists. A walk-forward re-fit
of the blend by games played (3–4, 5–7, 8+) improves MAE by **0.044** (95% CI
−0.069 to −0.020), better in 8 of 9 seasons. That is real, but **under the
repo's 0.05-point promotion bar**, so it is queued as research, not shipped.
Decay by returning production, QB continuity and coaching continuity cannot be
measured in this corpus and is named rather than assumed.

## 7. Recency audit

Residual (final − fair) on the teams' mean pregame residual over the last 3
games: coefficient **−0.080** (SE 0.017). Over the season: −0.084 (SE 0.024).
Long-term-vs-current delta: **−0.230** (SE 0.048). When this season's own
track disagrees with the long-term state, the result sides with the long-term
state more than the blend allows. Recent form is mildly **over**-weighted
(RECENT_FORM_OVERREACTION), consistent with §6. The margin cap (35) already
limits single blowouts. The gate refuses 7+ gaps on fewer than 3 games per
side, and the long-term-vs-current check fails 10+ gaps past 10 points of
delta.

## 8. Opponent-adjustment stress test

The **pricing state is a sequential Elo**: one update per game in kickoff
order. There is no iterative fixed point, so no convergence failure, no
schedule-strength loop and no opponent chain inside the priced number. The
**public** rating (EDR) is an iterative fixed point, and it is measurably
unstable early: weeks 0–2 MAE 14.80 vs engine base 14.10. FCS contamination:
no FBS–FCS game carried a market in the sample, and the gate fails an FCS
opponent at 10+. With only 3–4 games played, 7+ gaps had a 29.4% false-extreme
rate.

## 9. Cross-conference scale audit

Out-of-conference residuals (point-in-time), dev vs holdout: **no conference
shows a same-sign |t| ≥ 2 in both.** The closest: Conference USA −2.26
(t −2.18) dev, −2.43 (t −1.72) holdout (EdgeDesk overrates it); SEC +1.58
(t 1.59), +1.67 (t 1.45), and +6.4 on 30 games in 2026 (EdgeDesk underrates
it). No conference is re-scaled; nothing clears validation. The engine's
conference term (0.50 × prior-season differential, decayed by 6 games) earns
a coefficient of 0.85 (SE 0.085) in cross-conference games, so it is not
wrong on average. But the 7+ gaps it creates carry no market signal (moved
toward 49.6%, CLV +0.12), so the gate refuses to verify a gap the conference
term alone creates.

## 10. Connected-graph strength

7+ cross-conference gaps by the thinner side's cross-conference sample this
season: 0–4 games → moved toward 44.2%, false extremes 34.5%. 30+ games →
50.0%, 25.0%. Cross-conference MAE is 13.45 at low connectivity vs 13.32 at
high. Weak connectivity is early season by construction, and the
games-played and conference-term rules carry it. No separate uncertainty
inflation ships: V1's sigma model kept only the early-season driver.

## 11. QB audit

The priced QB value term is structurally 0 in production (the EPA series is
not on the coefficient's scale, and the pricing whitelist is empty). The only
QB effect that can move the number is the absence term (3.90 × status weight)
from an availability report. So the audit is a gate check on every 7+ gap:
starter resolved, a doubtful starter priced, and a new starter already
reflected in the rating (3+ starts, so no starter-loss penalty stacks on it).
Current slate: 114 of 120 starters PREVIOUS_GAME, 5 COMPETITION, 1 UNKNOWN.
All six current 7+ gaps passed the QB check. No historical starter record
exists, so a historical rate is not measured.

## 12. Roster double-count audit

V1 prices **no roster or talent points**: talent enters confidence and
volatility only. A roster double count in the mean is therefore structurally
impossible in the priced engine. The injury term was 0 on every historical
game. The gate still fails any priced absence the rating already reflects
(ROSTER_DOUBLE_COUNT) and any abnormal availability feed (FETCH_FAILED on 18
current team-sides).

## 13. Matchup-adjustment audit

| \|matchup\| | n | realized per predicted | 7+ gaps | moved toward | false extremes |
|---|---|---|---|---|---|
| <0.5 | 1,896 | −0.24 | 229 | 49.3% | 32.3% |
| 0.5–1 | 1,767 | 1.22 | 193 | 51.8% | 29.5% |
| 1–2 | 2,524 | 1.29 | 307 | 58.3% | 23.8% |
| 2–3 | 1,197 | 0.82 | 160 | 50.6% | 29.4% |
| 3–5 | 575 | 0.94 | 101 | 66.3% | 19.8% |
| 5+ | 51 | 0.53 | 8 | 62.5% | 25.0% |

Jointly with the rating, the matchup term earns **1.46** (SE 0.155). It is
under-weighted if anything, and it keeps its coefficient with the rating in
the fit, so it is residual rather than relearning team quality, although it
correlates 0.72 with the rating term. **3+ point matchup corrections do
improve prediction**, and their 7+ gaps are the most informative of any
source. So they are *not* shrunk. The 5+ tail (n 51) realizes about half, too
few games to act on. The gate flags matchup-dominated gaps (WARN) and fails
only a term past its validated p99.

## 14. HFA audit

| | 2015 | 2017 | 2019 | 2020 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|
| model home residual | −1.73 | −1.44 | −0.90 | −3.22 | −2.14 | −1.85 | −0.77 | −0.65 | −0.70 |
| model − close | +1.05 | +1.31 | +1.41 | +2.47 | +1.47 | +1.66 | +1.62 | +1.32 | +1.16 |

The home residual is negative in **every** season. Neutral sites: 0 of 360 got
home field, so there is no neutral-site application. The sign is correct and
it is not applied twice. It is **over-sized and internally inconsistent**:
the rating state is learned against a 3.2-point home field, but projections
add the 4.082-point constant measured on 2001–2013. The outcome-fitted value
on 2015–2025 is 2.4–2.6. Every home conference shows it (−0.54 Big 12 to −2.97
MAC). This is the HFA_ERROR behind 90 holdout 7+ gaps. The gate's calibration
check removes gaps that exist only because of it.

## 15. Extreme-favourite audit

| EdgeDesk favourite by | n | projected | realized | ratio | market on same games |
|---|---|---|---|---|---|
| 0–3 | 1,322 | 1.53 | 1.60 | 1.04 | 1.43 |
| 3–7 | 1,706 | 4.95 | 4.48 | 0.91 | 4.38 |
| 7–14 | 2,304 | 10.27 | 9.66 | 0.94 | 9.06 |
| 14–21 | 1,432 | 17.16 | 15.56 | 0.91 | 15.91 |
| 21–28 | 728 | 24.02 | 21.94 | 0.91 | 22.13 |
| 28+ | 518 | 33.71 | 32.25 | 0.96 | 31.90 |

Favourites realize about 91–96% of the projected margin. A piecewise tail
slope past 14 was tried and did not beat the linear calibrator walk-forward.

## 16. Raw-margin calibration

`final ~ raw margin` slope by season: 0.942, 0.974, 0.975, 0.949, 1.030,
0.960, 0.986, 0.906, 0.911, 0.937, 0.978, 0.969 (2015–2026). That is below 1
in 11 of 12 seasons, and the intercepts are all negative (the home bias). The
model's margins spread about as widely as the market's (SD 13.73 vs 13.94)
against outcomes with SD 20.98. The over-dispersion is mild (~3.5%), not the
20-behaves-like-15 case.

## 17. The football-only margin calibrator

`calibrated = 0.9637 × (raw − applied home field) + 2.582 × [home game]`,
fitted to final margins only, zero-preserving and antisymmetric at a neutral
site. Walk-forward 2018–2026: MAE **−0.041** (95% CI −0.082 to +0.004), better
in 7 of 9 seasons. Holdout 2022–25: −0.049. 14+ tail 13.164 → 13.102. 2026 to
date: +0.07 (n 213). Variants (per-component slopes, a tail slope, an
early-season shrink, rolling 3/4/6-season windows) gained ≤ 0.005 more.
**Not promoted to the priced number**, because it is under the repo's
pre-declared 0.05 bar. The engine publishes it as `model.margin_calibration`
(shadow) and the gate uses it as the calibration check.

## 18. Team-strength scale

1 EdgeDesk rating point = **0.904** scoreboard points (SE 0.023), jointly with
home, matchup and conference. By era: 0.943 (2015–19), 0.864 (2020–25). The
rating scale is slightly stretched, and increasingly so in the portal era.
That is the same finding as §16, and the calibrator absorbs it in the shadow.

## 19. Component-contribution distributions (|points|, 2015–2025, n 8,010)

| component | median | p75 | p90 | p95 | p99 | max | non-zero |
|---|---|---|---|---|---|---|---|
| rating (base) | 7.77 | 13.33 | 19.09 | 22.95 | 30.11 | 46.57 | 100% |
| of which long-term state | 5.64 | 9.79 | 14.38 | 17.63 | 24.48 | 39.03 | 100% |
| of which current form | 1.56 | 3.93 | 6.75 | 8.45 | 11.77 | 18.81 | 72% |
| home field | 4.08 | 4.08 | 4.08 | 4.08 | 4.08 | 4.08 | 96% |
| matchup | 1.10 | 1.91 | 2.78 | 3.41 | 4.56 | 7.57 | 100% |
| conference | 0 | 0 | 3.96 | 7.04 | 11.51 | 18.72 | 21% |
| schedule/rest | 0 | 0.001 | 0.003 | 0.004 | 0.013 | 0.022 | 4% |
| QB, injury, travel, rivalry, weather, special teams | 0 | 0 | 0 | 0 | 0 | 0 | 0% (unpriced by design) |

The p95/p99 ranges ship in `football/cfb_p4/disagreement_params.js`, and the
gate fails any term past its p99. The conference term's tail (p99 11.5, max
18.7) is the largest non-base adjustment by far.

## 20–23. The integrity gate: 7+, 10+, 15+ and favourite-flip rules

Implemented in `lib/cfb_disagreement.js`. The full table with the evidence for
each rule is in [`DESIGN.md`](DESIGN.md). In short:

- **7+**: GAME (teams, identity, orientation, venue, kickoff, pregame), MARKET
  (2+ books, ≤ 24 h, dispersion ≤ archive p99, plausible), TEAM STATE (3+
  current-season games per side), QB (no unpriced doubtful starter, no unseen
  new starter), ROSTER (no abnormal feed, no double count), COMPONENT (every
  term inside its p99, no conference-carried gap), MODEL (valid distribution,
  confidence ≥ 35, reliability ≥ 60, calibrated gap ≥ 7, a majority of
  independent submodels and the ensemble on EdgeDesk's side).
- **10+**: plus 4+ games, ≤ 12 h quotes, QB resolved, long-term-vs-current
  ≤ 10, no FCS, independent ensemble ≥ 3 points on EdgeDesk's side, ensemble
  SD ≤ 6, and any single non-base term carrying the gap fails.
- **15+**: plus 3+ books, n − 1 submodels, ensemble ≥ 5 points, SD ≤ 5, and
  `manual_review` with an internal warning. A 15+ or past-the-guard gap that
  passes everything is **shown** as extraordinary. It is never hidden and never
  an automatic wager.
- **Favourite flip at 7+**: the 10+ sample and ensemble rules apply, and the
  independent ensemble must favour the same team as EdgeDesk.
- **Fail safe**: an exception or a missing gate gives `INVESTIGATE —
  VERIFICATION INCOMPLETE`. Nothing is verified by default.

## 24. Disagreement-quality model

A logistic score of P(market moves toward EdgeDesk) from pregame features
only (games played, submodel support and opposition, ensemble gap, the
conference and matchup shares of the gap, calibration retention, flip; never
the outcome, never gap size alone). Trained 2015–21 (n 1,023), scored
2022–25 (n 850): AUC **0.57**, Brier 0.2452 vs base rate 0.2471. The top
tercile moved toward EdgeDesk 64.0% (CLV +1.06) vs 49.1% (+0.01) for the
bottom. The pre-declared rule required AUC ≥ 0.55, a Brier gain ≥ 0.002 and
tercile ordering. The Brier gain was **0.0019**, so **the score failed and is
not shipped** (`disagreement_params.js` → `quality: null`). The individual
checks that carry the same information are in the gate.

## 25. Historical market movement

Close moved toward EdgeDesk, by gap: 43.2% (<2), 46.7% (2–5), 50.3% (5–7),
53.8% (7–10), 56.7% (10–15), 54.3% (15+). For 7+ gaps by week: weeks 0–2
**44.8%** (worse than a coin flip), weeks 3–5 54.2%, weeks 6+ 59.8%. Favourite
flips at 7+: 58.6% (vs 53.1% for the same favourite). Verified vs unverified:
dev 72.2% vs 54.3%, holdout 55.1% vs 51.1%.

## 26. Verified vs unverified CLV (points)

| | verified | unverified |
|---|---|---|
| dev 2015–21 | +2.45 (n 79) | +0.60 (n 457) |
| holdout 2022–25, football checks | +1.56 (n 98) | +0.30 (n 364) |
| holdout 2022–25, strict market | +1.45 (n 54) | +0.45 (n 408) |

## 27. Verified vs unverified MAE (holdout, football checks)

Verified: model MAE 13.85 vs opener 12.56; **EdgeDesk closer than the opener
45.9%**; side covered 55.7%; ROI at −110 +6.3% (secondary, n 98).
Unverified: 14.39 vs 11.93; closer 37.9%; covered 49.0%; ROI −6.4%. Strict
market rules: verified closer than the opener **51.9%**, covered 60.4% (n 54).
EdgeDesk still loses to the opener on MAE even when verified. Verification
selects the disagreements that are least often wrong. It does not make the
model better than the market.

## 28. Old vs new false-extreme count

| | old: major labels | new: verified | reduction |
|---|---|---|---|
| dev 2015–21 | 144 | 14 | −90% |
| holdout, football checks | 129 | 24 | −81% |
| holdout, strict market | 129 | 13 | −90% |
| 2023–25 multi-book, strict | 106 | 13 | −88% |
| favourite flips (holdout) | 31 | 4 | −87% |

False-extreme **rate**: raw 7+ 27.9% → verified 24.5% (holdout) / 24.1%
(strict). In dev: 26.9% → 17.7%.

## 29. Old vs new overall MAE

The priced fair spread is byte-identical: **12.910** before and after
(2018–2026 walk-forward window, n 6,046). The gate and the calibrator never
write to it. The unpromoted calibrated shadow scores 12.869.

## 30–31. Current-slate retest (2026 week 5) and every former MAJOR DISAGREEMENT

`tools/football/disagreement_slate.js` priced the slate exactly as the board
does and joined the Model Lab's captured quotes. It covered 59 games, 29 with
a market. OLD FAIR equals NEW PURE FAIR on every game, and re-pricing every
game **with** its market attached gave the identical number on all 59.
Circuit breaker: observed 7+/10+/15+ = 6/2/0 against a historical expectation
of 4.6/1.6/0.2. No MODEL_SCALE_ALERT.

| game (away @ home) | old fair (home margin) | new pure fair | market | old gap | new gap | calibrated gap | root cause | final label | survived |
|---|---|---|---|---|---|---|---|---|---|
| North Texas @ Tulsa | −8.98 | −8.98 | +1.5 | −10.48 | −10.48 | −11.51 | THIN_MARKET (1 book; long-term vs current 10.2) | MARKET FAULT | no |
| Vanderbilt @ Georgia | +16.58 | +16.58 | +24.0 | −7.42 | −7.42 | −9.37 | TEAM_RATING_ERROR (0 of 3 submodels with EdgeDesk; ensemble 2.6 pts on the market's side) | INVESTIGATE | no |
| Ohio State @ Iowa | −6.81 | −6.81 | −14.25 | +7.44 | +7.44 | +6.33 | HFA_ERROR (gap under 7 once home field is calibrated) | INVESTIGATE | no |
| Marshall @ James Madison | +26.23 | +26.23 | +14.0 | +12.23 | +12.23 | +9.93 | THIN_MARKET (1 book; availability feed failed; submodels flat) | MARKET FAULT | no |
| Maryland @ Nebraska | +19.75 | +19.75 | +12.5 | +7.25 | +7.25 | +5.18 | THIN_MARKET (1 book; calibration) | MARKET FAULT | no |
| Temple @ South Florida | +15.64 | +15.64 | +6.5 | +9.14 | +9.14 | +7.22 | THIN_MARKET (1 book) | MARKET FAULT | no |

**None of the six survives.** Four have only one book behind the quote. The
lab's captured market this week is DraftKings via ESPN plus a CFBD consensus
row, so a live board with more books may verify some. The per-game check
tables and evidence packets are in `slate_2026_week_05.md`.

2026 weeks already played (vs the close): raw 7+ gaps per week were 13, 14 and
11, with EdgeDesk closer than the close in 3, 6 and **0** of them. The gate,
run prospectively, would have verified 3 of 38 (none finished closer than the
close; 1 of 3 covered) and sent 35 to INVESTIGATE, 32 of them for early-season
prior error.

## 32. Database changes

`supabase/cfb_lab.sql` (and the regenerated `supabase/parts/cfb_lab.part*-of-7.sql`):

- seven columns on `cfb_lab_predictions`: `disagreement_version`,
  `disagreement_status`, `disagreement_tier`, `verified_market_gap`,
  `calibrated_market_gap`, `disagreement_root_cause`, `disagreement_checks`
  (jsonb). The raw gap is the existing `model_market_gap`. Idempotent
  `add column if not exists` upgrades for a deployed table;
- constraints `cfb_lab_pred_disagreement_status` (the six statuses; the
  retired MAJOR_DISAGREEMENT is refused) and `cfb_lab_pred_verified_gap` (a
  verified gap exists only on a VERIFIED 7+ snapshot and equals the raw gap);
- the view `cfb_lab_major_disagreements` (security invoker, authenticated
  read, anon none);
- report row 13.

Proved against a real PostgreSQL by `football/cfb_lab/sql.test.js` (443
checks, including the new refusals and a VERIFIED row read back through the
view).

## 33. Model Lab changes

Every V1 snapshot the lab takes against a market now carries the gate's
verdict. `football/cfb_lab/checkpoint.js` runs the gate with the market the
snapshot captured, the football inputs the slate artifact now publishes
(`slate.json` → `disagreement_inputs`), and the lab's own V2 projections as
the independent submodels. `football/cfb_lab/disagreement.js` builds
`lab.json` → `major_disagreement`, rendered as §8 of `admin/cfb-lab`: raw
major disagreements, verified (10+/15+), investigate, data fault, market
fault, verification not run, average raw gap (all and 7+), market movement
toward verified vs unverified gaps, verified-gap MAE, verified-gap CLV,
false-extreme rate raw vs verified, root causes of unverified gaps, and a
by-week table with favourite flips.

## 34. UI status changes

- The board status (`fbP4StatusFor`) now yields `VERIFIED MAJOR DISAGREEMENT`,
  `INVESTIGATE` (with the reason on hover), `MARKET FAULT` or `DATA FAULT` for
  7+ gaps. The status filter offers all of them, and the counts track
  verified / investigate / market faults.
- The research-view label (`lib/cfb_research_view.js`) replaces
  `MAJOR DISAGREEMENT` with the gate's verdict. It fails closed to
  `INVESTIGATE — VERIFICATION INCOMPLETE`.
- **Visual treatment**: only VERIFIED gets the filled gold chip with a glow.
  An unverified large gap is dimmed ("size alone is never a finding") and
  INVESTIGATE stays the quiet warn chip.
- **Click-through evidence packet** (the game card's first section for any 7+
  gap): EdgeDesk fair, market consensus, best available, raw / verified /
  calibrated gap, favourite flip, base rating difference split into long-term
  state and current form, base-rating gap to the market, every game
  adjustment, the equation, each submodel with its stance, ensemble agreement,
  QB state, roster/availability state, reliability, prediction uncertainty
  (σ, p10/p90), market depth and freshness, and every verification check with
  its result and cause.
- The headless publisher (`tools/articles/research_host.js`) loads the gate,
  so articles and briefs carry the same verdict. The published brief carries
  status, verified and calibrated gaps, root cause and failed checks, with
  nothing that ages with the clock.

## 35. Tests added

- `tools/football/disagreement.test.js`, **169 checks** in CI
  (`collective-tests.yml`) and in `npm run cfb:test` / `npm test`: raw gap and
  sign, favourites, market convention; decomposition reconciliation; the clean
  VERIFIED case; every GAME, MARKET, TEAM STATE, QB, ROSTER, COMPONENT and
  MODEL check; the 7+/10+/15+ thresholds; the favourite-flip gate; the guard
  (unverified → DATA FAULT, fully passing → shown); stale and thin markets; QB
  uncertainty, absence and changes; missing roster data; mapping and
  orientation errors; opponent-adjustment failure; cross-model disagreement;
  calibrator zero-preservation and antisymmetry; fail-closed behaviour
  (throwing input, missing gate, missing submodels); **purity** (the engine
  prices identically with no market, −30 and +45); the circuit breaker; the
  recheck; the false-extreme definition; research-view, Model Lab checkpoint
  and lab-section wiring; and the board's own `app.html` functions (VERIFIED
  only when the gate verifies, INVESTIGATE when the library is missing).
- Updated: `cfb_research_view.test.js` (306), `cfb_research_view_ui.test.js`
  (200), `research_view_publish.test.js` (92), `fbs_board_ui.test.js` (185),
  `football/cfb_lab/ui.test.js` (83), `football/cfb_lab/sql.test.js` (443).
  The full `npm run cfb:test` chain and the lab suites pass.

## 36. Files and functions

New: `lib/cfb_disagreement.js` (`evaluate`, `fromEngine`, `calibratedMargin`,
`decompose`, `circuitBreaker`, `movement`, `falseExtreme`, `params`),
`football/cfb_p4/disagreement_params.js` and `margin_calibration.js`
(generated), `football/cfb_p4/research/disagreement_eff.js`,
`disagreement_replay.js`, `disagreement_forensics.js`,
`football/cfb_lab/disagreement.js`, `tools/football/disagreement_slate.js`,
`tools/football/disagreement.test.js`, `football/validation/disagreement/*`,
`docs/cfb-disagreement/*`.

Modified: `football/cfb_p4/engine.js` (`projectGame`: `raw_game_margin`,
shadow `margin_calibration`, both sides' games played; the priced number is
unchanged), `lib/cfb_research_view.js` (`researchLabel`, `LABELS`,
`disagreementSummary`, `build`, `brief`, `deskSummary`), `app.html`
(`fbDgSubEnsure`, `fbP4DisagreementFor`, `fbP4UnitFor`, `fbP4GateStatus`,
`fbP4StatusFor`, `fbP4ForensicHTML`, `fbP4ViewFor`, `fbRvWeak`, `fbP4Counts`,
`FBP4_STATUSES`, the legend, CSS, loaders), `football/fbs/build_coverage.js`
(`disagreement_inputs`), `football/cfb_lab/checkpoint.js` (`submodelsFor`,
`disagreementFor`, `buildRow`), `football/cfb_lab/report.js`,
`admin/cfb-lab/index.html` (§8), `supabase/cfb_lab.sql` and its parts,
`tools/articles/research_host.js`, `tools/editorial/narrate.js`,
`package.json`, `.github/workflows/collective-tests.yml`, and the updated tests.

## 37. Unresolved causes

1. **Early-season prior error is the dominant false-extreme source** (127
   false extremes 2015–2025; 32 of 38 2026 gaps). The gate contains it. The
   *model* fix (the blend re-fit, §6, −0.044 walk-forward) is under the bar.
2. **Home-field over-application** (47 false extremes). The calibrator fixes
   it in the shadow. Promotion waits on the full 2026 season against the 0.05
   bar.
3. **Team-rating disagreement with the independent submodels** (36). Why V1's
   Elo state and V2's opponent-adjusted efficiency diverge on these teams is
   not diagnosed.
4. **Extreme-favourite nonlinearity** (18). A tail-specific calibration did
   not validate.
5. **Market depth in the lab.** One or two sources this week means most 7+
   gaps are MARKET FAULT. The board's captured multi-book quotes are the
   better input, and `cfb.lines` rows carry no capture time, so they can never
   verify.
6. The **SEC** out-of-conference residual (+1.6 dev, +1.7 holdout, +6.4 on 30
   2026 games) and **Conference USA** (−2.3, −2.4) sit just under significance.
   Watch them; do not boost them.
7. Historical QB, availability and reliability data do not exist, so those
   checks are validated only prospectively.

All seven are in `forensics_cfb.json` → `research_queue` (the four causes with
6+ false extremes and the two near-miss model changes).

## 38. Production recommendation

1. **Ship the gate now.** It changes no number. It removes 81–90% of the false
   extremes that carried a major label, verified gaps outperform unverified
   ones on every measure, and it fails closed.
2. **Keep VERIFIED away from staking.** Holdout verified gaps covered 55.7%
   (n 98) and none of the 2026 three beat the close. VERIFIED routes research attention;
   the decision layer's validated tiers alone gate a wager.
3. **Do not promote the calibrator or the blend re-fit mid-season** (repo
   policy: no midseason refit). Re-score both on the complete 2026 season. If
   either clears 0.05 walk-forward, promote it through governance. HFA_ERROR
   alone accounts for about a quarter of the holdout 7+ gaps that failed the
   gate (90 of 364).
4. **Feed the gate the board's multi-book captured quotes** (not the
   one-row `cfb.lines`), so a genuine verification can happen on a busy
   Saturday.
5. **Watch the circuit breaker.** It fired on 1 of 65 holdout slates
   (2023-11-21, 14 gaps of 7+ against 6.4 expected). A second alert inside a
   season is a scale investigation, not a quota.
