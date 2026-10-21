# Data audit for the CLV programme (Phase 1)

**Written:** 2026-10-21, before any model was scored against a line. Every count comes from `python3 -m research.clv.audit`, which writes `research/clv/results/data_audit.json`, using the same readers as the studies (`model_loop/clv/sources.py`).

**What CLV needs per game:**
- an OPENING (or earliest available) number;
- the CLOSING number for the same market;
- a model number built only from what was known when the opener was posted.

Each section below says how much of that exists.

## Rules applied to every source (decided before any result)

**Hygiene.** A number is DROPPED, never repaired by guesswork, when it cannot be a market:
- a spread beyond ±30 (NFL, NBA, WNBA), ±45 (CBB) or ±70 (CFB);
- an open-to-close move beyond 14 (NFL), 15 (NBA, CBB, WNBA) or 21 (CFB) points;
- a total outside the sport's range, or moving more than 14 (NFL), 20 (NBA, CBB, WNBA), 21 (CFB), 2 goals (NHL) or 3 runs (MLB);
- a moneyline pair whose implied probabilities sum outside [0.98, 1.20], or with |odds| < 100;
- the scraper's 0 placeholders.

Every drop is counted per source in `data_audit.json` (`qa`).

**One repair, exact.** In the SBR NFL and NBA archive, the CLOSING spread and total trade places in 259 NFL rows (8.8%) and 933 NBA rows (6.7%). For example, `home_close_spread = 178, close_over_under = 4.0`.
- The misplaced field keeps the spread's sign. This was checked on every such row against the closing moneyline's favourite.
- The repair is therefore exact: spread = sign × the `close_over_under` value, total = |field|.
- These rows are mostly games whose favourite flipped near pick'em. Dropping them would bias the move sample toward small moves.

**Same-book moves first.** Where several books exist (CFB), the PRIMARY move is the opener book's own open and close (the median over that era's opener books). The all-book consensus close and Pinnacle's close are secondary.

**Prices.** Where a source carries no spread or total prices (CFB archive, SBR), the harness assumes -110 both sides at open and close. This is stated with every result. Price CLV for moneylines always uses the real prices on both sides.

**Season labels.** SBR labels NBA and NHL seasons by start year (SBR 2011 = 2011-12 = repo 2012).

**Timestamps.** No historical archive here has quote timestamps. "Open" means the first number the source recorded, usually Sunday or Monday for football and the evening before for the daily sports. "Close" means the last pregame number. Only the 2026 EdgeDesk ledgers have `observed_at` / `seen_at`.

---

## CFB

### Lines

Source: cfbfastR archive (`cfb_line_odds.csv.gz`, 1,183,529 rows), oriented by the repo's own `football/cfb_p4/research/build_market.py` (rule `cfb_market_orientation_v2`), run into `.cache/clv/cfb_market/`.

| Season | Games (any FBS) | Spread open+close | Mean \|move\| | Share moved | Total open+close | ML open+close | Opener book(s) | Pinnacle close |
|---|---|---|---|---|---|---|---|---|
| 2006–2011 | 304–740 | 1–5 | – | – | 3–15 | 0 | 5Dimes (stray) | 301–721 |
| 2012 | 768 | 751 | 1.48 | 0.87 | 670 | 731 | 5Dimes | 661 |
| 2013 | 780 | 765 | 1.74 | 0.89 | 778 | 751 | 5Dimes | 663 |
| 2014 | 792 | 777 | 1.88 | 0.90 | 780 | 767 | 5Dimes | 775 |
| 2015 | 793 | 787 | 1.94 | 0.91 | 792 | 779 | 5Dimes | 784 |
| 2016 | 782 | 775 | 2.04 | 0.89 | 782 | 770 | 5Dimes | 770 |
| 2017 | 794 | 773 | 1.96 | 0.89 | 774 | 761 | 5Dimes | 774 |
| 2018 | 815 | 801 | 1.69 | 0.88 | 814 | 790 | 5Dimes | 800 |
| 2019 | 810 | 793 | 1.84 | 0.89 | 810 | 785 | 5Dimes | 797 |
| **2020** | 541 | **0** | – | – | 0 | 0 | none | 0 |
| 2021 | 849 | 838 | 1.11 | 0.80 | 841 | 0 | Bovada | 0 |
| 2022 | 1,413 | 801 | 1.29 | 0.82 | 811 | 0 | Bovada | 0 |
| 2023 | 1,393 | 859 | 1.33 | 0.90 | 869 | 0 | Bovada, DraftKings | 0 |
| 2024 | 1,556 | 862 | 1.46 | 0.87 | 863 | 0 | Bovada, DraftKings, ESPN Bet | 0 |
| **2025 (holdout)** | 1,596 | **938** | 1.56 | 0.86 | 938 | 0 | Bovada, DraftKings, ESPN Bet | 0 |

**2026 (holdout)** comes from `football/cfb_lab/ledger/2026/lines.jsonl`:
- 413 games; 251 with an OBSERVED open (first DraftKings quote seen, `observed_at`) and a close; mean |move| 1.28.
- The 160 earlier-season games without an observed open are reported, not filled.

**Gaps:**
- No moneyline openers after 2019.
- No spread prices in the archive.
- 2020 has no openers at all.
- 2012–19 openers come from one offshore book (5Dimes); 2021+ from US retail books (Bovada / DraftKings / ESPN Bet), which open later and less sharply. The same model can therefore show different CLV by era for reasons that are not the model's. Results are reported per era.

### Features and when they are known

| Feature | Known at the opener? | Evidence |
|---|---|---|
| Team ratings from prior games (cfb_p4, loop v2) | yes | walk-forward refits on games before the week |
| Market rating (loop v2 `c_market`) | yes | `model_loop/adapters/cfb/ratings.py`: prior weeks' closes only |
| Starting QB in the loop v2 **backtest** | **no** | `ratings.py:305-308`: the backtest prices "the quarterback who actually took the most dropbacks". A starter change announced after the open leaks into the number. The admissible substitute is the previous game's starter |
| QB in cfb_p4 | not priced | `football/matchup/inputs.js:84` `PRICED_STARTER_STATUSES = []` |
| Injuries, weather | none historically | `docs/model-loop/cfb/BACKTEST.md` |
| Rest, travel, conference, division, Power-4 status | yes | schedule |

**Phases feasible:** all.
- Walk-forward: 2012–2019 and 2021–2024.
- Holdout: 2025 + 2026.

---

## NFL

### Lines

**Openers exist only in the SBR archive** (2011–2021) and EdgeDesk's 2026 capture. nflverse has consensus closes for 1999–2026 and no openers.

| SBR season | Games | Spread open+close | Mean \|move\| | Share moved | Total open+close | Mean \|move\| | Moneyline |
|---|---|---|---|---|---|---|---|
| 2011 | 267 | 266 | 1.06 | 0.79 | 267 | 1.33 | close only |
| 2012 | 267 | 266 | 0.94 | 0.76 | 267 | 1.34 | close only |
| 2013 | 267 | 266 | 1.28 | 0.82 | 266 | 1.55 | close only |
| 2014 | 267 | 266 | 1.06 | 0.76 | 267 | 1.07 | close only |
| 2015 | 267 | 266 | 1.15 | 0.79 | 266 | 1.33 | close only |
| 2016 | 267 | 266 | 1.06 | 0.76 | 266 | 1.37 | close only |
| 2017 | 267 | 266 | 1.10 | 0.81 | 266 | 1.47 | close only |
| 2018 | 267 | 266 | 1.11 | 0.81 | 266 | 1.52 | close only |
| 2019 | 267 | 266 | 1.50 | 0.88 | 266 | 1.80 | close only |
| 2020 | 269 | 268 | 1.66 | 0.87 | 267 | 1.91 | close only |
| 2021 | 284 | 280 | 2.02 | 0.85 | 282 | 1.83 | close only |
| 2022–2024 | – | **none** | | | | | |
| **2025 (holdout)** | – | **none** | | | | | |
| **2026 (holdout)** | 105 | 77 closed with an open | 1.21 | | | | open and close ML |

**About the 2026 openers** (`football/pricing/openers_nfl.json`):
- Each is the first number the nflverse consensus feed showed when EdgeDesk first looked (`seen_at`).
- The first capture was 2026-09-16, a median 11 days before the game, so these are early numbers for later weeks.
- They are "earliest available", not the book opener.

**Gaps:**
- No moneyline opener before 2026.
- No first-half lines anywhere: the 1H experiment is infeasible.
- No book names or timestamps before 2026.

### Features and when they are known

| Feature | Known at the opener? | Evidence |
|---|---|---|
| Unit and market ratings (loop v2, v1) | yes | prior weeks only (`ratings.py:9`) |
| Starting QB in every committed backtest | **no** | `ratings.py:229-233`: "the backtest passes none and prices the starter who actually played". The admissible substitute is the previous game's starter (`football/pricing/qb_starts_nfl.json`, 5,524 games, post-game record) |
| Injuries | partly | `football/pricing/injuries_nfl.json` 2009–2026; `as_of` only for 2010–2024 (weekly report, not opener time) |
| Weather (`temp`, `wind` in games.csv) | **no** | game-day observations, not the forecast at the open: unusable for opener bets |
| Rest, bye, travel, time zone | yes | schedule |

**Phases feasible:** baseline, residual and the weak-spot tests on 2011–2021, with the QB input replaced by the previous starter. The holdout (2025 + 2026) has openers for 2026 only (77 games), so a **proxy holdout** is also locked: SBR 2020–2021.

---

## NBA

### Lines

| Source | Repo seasons | Spread open+close | Mean \|move\| | Total open+close | Mean \|move\| | Moneyline |
|---|---|---|---|---|---|---|
| SBR (start-year label 2011–2021) | 2012–2022 | 1,073–1,322 per season (all but ~10) | 0.81–1.37 | ~all | 1.63–2.68 | close only |
| — | 2023–2025 | **none** (ESPN pickcenter has no open in sampled 2024–25 files) | | | | |
| ESPN pickcenter, DraftKings (`hoopR-nba-raw`) | **2026 (holdout)** | 1,068 / 1,322 finals | 1.46 | 1,069 | 2.61 | **open and close**, 1,064 games, mean \|move\| 3.7 pp |
| `performance/ledger/quotes/nba-2026.jsonl` | 2027 (holdout, to date) | 18 games, capture times, no close | | | | |

### Features and when they are known

| Feature | Known at the opener? | Evidence |
|---|---|---|
| Team ratings (`nba/` engine, basketball lab) | yes | walk-forward |
| **Projected** availability (`G_stack_P`: previous game's rotation) | yes | `nba/model/walkforward.js` |
| **Confirmed** availability (`G_stack_C`: who played) | **no** | post-game. Never used for opener bets |
| Injury reports / late scratches with timestamps | **none** | no feed archived (`rotation_stale=true` on all 91 ledger rows) |
| Rest, back-to-back, travel, games in 7 days | yes | schedule (`nba/data/team_games/*.csv`) |

**Phases feasible:**
- Baseline and residual: walk-forward on SBR 2012–2022.
- Weak spots: rest/back-to-backs, totals, early season. Star absence only through projected availability. Late scratches cannot be tested: there are no timestamps.
- Holdout: ESPN DraftKings 2026 (1,068 games) plus 2027 to date.

---

## NHL

### Lines

| Source | Repo seasons | Moneyline open+close | Mean \|move\| (no-vig prob) | Total open+close | Share of totals whose LINE moved |
|---|---|---|---|---|---|
| SBR (2011–2021 start-year) | 2012–2022 | 805–1,397 per season | 1.8–2.6 pp | ~all | 2–30% |
| — | **2026 (holdout)** | **none** | | | |
| `performance/ledger/quotes/nhl-2026.jsonl` | 2027 (to date) | 35 games, DraftKings, capture times; the last capture is a median 3.3 h before start, so no close | | | |

**Gaps:**
- Totals carry ONE price per row (no under price), and the line itself rarely moves. Totals CLV can only be measured on the line, which is weak.
- Puck lines carry no opener.

### Features and when they are known

| Feature | Known at the opener? | Evidence |
|---|---|---|
| xG / goals ratings | yes | walk-forward |
| **Projected** goalie (recent usage + back-to-back rule; 66% right in 2025-26) | yes | `hockey/model/ratings.js` |
| **Confirmed** goalie | **no** | post-game `g_start`. No confirmation timestamps exist (`hockey/data/confirmed_starters.json` absent) |
| Projected / confirmed lineups | projected yes / confirmed no | `.cache/nhl_work/lineups_*` |
| Back-to-backs, travel | yes | schedule |

**Phases feasible:** baseline, residual and weak spots on SBR 2012–2020. The mandated holdout has no openers, so a **proxy holdout** is locked: repo 2021–2022 (SBR 2020–2021).

---

## MLB

### Lines

| Source | Seasons | Moneyline open+close passing hygiene | Mean \|move\| | Total open+close | Share of totals whose line moved |
|---|---|---|---|---|---|
| SBR | 2011–2021 | 1,015–1,464 of ~2,465 per season (**41–59% fail**) | 1.3–1.9 pp | ~all | 40–59% |
| — | **2025–2026 (holdout)** | **none** | | | |

**Quality warning.** 28–36% of SBR MLB moneyline pairs imply an overround below 0.98, i.e. both sides are better than fair at one book. Examples: home +230 / away +125; home -107 / away +122.
- So the two sides were not captured from one book at one time, and the source is low-confidence.
- Only pairs inside [0.98, 1.20] are used.
- NHL from the same scraper does not have this problem (3 drops).

### Features and when they are known

| Feature | Known at the opener? | Evidence |
|---|---|---|
| Team, park ratings | yes | walk-forward (`mlb/history`) |
| Starting pitcher (`sp_home` / `sp_away`) | **no** | Retrosheet records the ACTUAL starter. Probable starters were never archived. The admissible substitute is a rotation-projected starter from prior starts |
| Bullpen usage | not in the game logs | Retrosheet GL has starters and decision pitchers only |
| Weather | none historically | `mlb_game_cards` is live only |

**Phases feasible:** baseline and residual with the starter input replaced by the projected starter, on SBR 2011–2019. **Proxy holdout:** SBR 2020–2021. Bullpen fatigue and weather/park totals have no data and are documented as infeasible.

---

## WNBA

| Source | Seasons | Spread open+close | Total open+close | Moneyline open+close |
|---|---|---|---|---|
| ESPN pickcenter, DraftKings (`wehoop-wnba-raw`) | 2025 | **0** of 311 | 0 | 0 |
| | **2026** | 349 of 349 | 349 | 349 |

Both seasons are the mandated holdout (2025 completed, 2026 to date). **No pre-holdout opener exists.**
- Infeasible: Phase 3 walk-forward, Phase 4 and Phase 5.
- Phase 6 is a single pre-registered holdout run of the production model.

**Features:** no availability or injury data.

## NCAAM

| Source | Season | Spread open+close | Total | Moneyline |
|---|---|---|---|---|
| ESPN pickcenter, DraftKings (`hoopR-mbb-raw`) | 2026 (2025-26, the holdout) | 4,756 of 6,300 finals | 4,789 | 4,645 |
| | 2022–2025 | none (sampled files carry consensus or Caesars with no open) | | |

Same as WNBA: only the holdout season has openers, so Phase 6 is a single holdout run of the production model.
- No injury or lineup data.
- `known_at` is blank on every historical row.

## NCAAW, UFC, college baseball, tennis

| Sport | Opener data | Close data | Status |
|---|---|---|---|
| NCAAW | none (`wehoop-wbb-raw` sampled files have no pickcenter) | none | every phase after this one infeasible |
| UFC | none committed; DB-only `ufc.market_captures` (paused 2026-10-10) | DB-only untimestamped consensus | infeasible from the repo |
| College baseball | none (`baseball_ncaa` not in the odds gateway) | none | infeasible |
| Tennis (retired) | none historical | none | infeasible |

## Feasibility summary

| Sport | Ph 3 baseline | Ph 4 residual | Ph 5 weak spots | Ph 6 holdout data |
|---|---|---|---|---|
| CFB | yes, 2012–19, 2021–24 | yes | non-P4 (yes); "early-week" = the opener itself (no intra-week timestamps); totals (yes) | 2025: 938 games; 2026: 251 |
| NFL | yes, SBR 2011–19 (QB replaced by previous starter) | yes | backup QB (opener-knowable form); totals; 1H **infeasible** | proxy 2020–21 (548); 2026: 77 |
| NBA | yes, SBR 2012–22 (regenerated predictions) | yes | star absence (projected only); rest/B2B; totals; early season; late scratches **infeasible** | 2026: 1,068 |
| NHL | yes, SBR 2012–20 | yes | goalie (projected only; confirmation timing **infeasible**); B2B; totals (line-only) | proxy repo 2021–22 |
| MLB | yes, SBR 2011–19 (projected SP) | yes | SP changes (projected vs prior); bullpen and weather **infeasible** | proxy 2020–21 |
| WNBA | **infeasible** | **infeasible** | **infeasible** | 2026: 349 (single run) |
| NCAAM | **infeasible** | **infeasible** | **infeasible** | 2026: 4,756 (single run) |
| NCAAW, UFC, CBase, tennis | infeasible | infeasible | infeasible | none |

---

## Addendum (2026-10-21, found while preparing MLB; before any MLB CLV number)

### SBR MLB pairing defect: repaired
The low MLB overround pass rate is a scraper pairing defect, not bad prices.
- **What is wrong.** Each SBR MLB record holds the home side of one game and the away side of another. Matched to Retrosheet by exact date, team and runs scored, no game has both sides in one record. In 98.5% of games the home side is in the record after the away side's.
- **The repair.** Split every record into its two team rows, match each row to its game by exact date, team and runs, and take each side's prices from its own row.
- **Validation.** Repaired pairs pass the overround check 99.85% of the time (median 1.038, SD 0.008); unrepaired pairs pass about 55%.
- **Coverage.** 20,803 games 2012–2021 (2,200–2,235 per full season, 780 in 2020). 231 ambiguous and 1,699 unmatched games are dropped.
- **Totals.** These cannot be attributed: at the best alignment the closing total correlates 0.155 with runs scored. **MLB totals are infeasible** and are not used.

NFL, NBA and NHL from the same scraper join on both teams and the final score within a single record (2,946, about 14,000 and 11,529 games). Their pairing is intact.

### Player props (added 2026-10-21, before the props runs)

**Data:**

| League | Events | Games covered | Prices |
|---|---|---|---|
| NFL | 31 | 2026-10-02 to 10-14 | per player × book, timestamped main-line ticks and alternate-ladder open/close (`football/props/nfl/2026/closes.jsonl`, The Odds API) |
| CFB | 119 | same window | same (`football/props/cfb/2026/closes.jsonl`) |

- The model's timestamped evaluations are in `football/props/{nfl,cfb}/2026/evaluations.jsonl` (`edgedesk_props_model_v1`).
- No props prices exist before 2026, or after the 2026-10-10 credit stop.
- NBA and NHL props models exist (`nba/props`, `hockey/props`), but no props prices were ever captured for them.

**Feasibility:**
- NFL and CFB props: a single holdout run each.
- NBA and NHL props: infeasible.
