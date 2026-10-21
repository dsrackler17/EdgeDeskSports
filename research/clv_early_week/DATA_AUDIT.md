# Data audit — line snapshots and feature timing for a CLV study

Written 2026-10-21, before any model was scored against an early line. Everything
below was established by running code on the data, not assumed. Reproduce with
`model_loop/clv_early/nfl_line_history.py` and `model_loop/clv_early/lines.py` (inputs are public;
the derived tables live in the gitignored `.cache/clv/`).

**Bottom line.** A real CLV study is possible for **CFB 2012–2019 and 2021–2025** (book
openers + closes, no timestamps) and for **NFL 2020–2026** (early-week lines with
provable timestamps, recovered from the commit history of nflverse's `games.csv`). There
are **no NFL early lines for 2015–2019 in any source this environment can reach**, no
team-total lines, no first-half lines, no historical CFB injury data, and no weather
forecasts. The existing walk-forward prediction files leak the game-day starting
quarterback and game-time weather and cannot be used as-is.

---

## 1. Line sources

| # | Source | Sport | Seasons | Snapshots | Known-at timestamp | Books | Markets | Prices |
|---|---|---|---|---|---|---|---|---|
| L1 | `nflverse/nfldata` `games.csv` (current file; `football/pricing/lines_nfl.json`) | NFL | 1999–2026 | close only | **none** | one consensus feed, unnamed | spread, total; ML 2006+ | spread/total juice on recent seasons |
| L2 | **git history of `nflverse/nfldata` `data/games.csv`** (52,279 commits, every ~10 min in season) | NFL | **2020-09 → 2026-10** | every change: lookahead → early week → Friday → close | **yes — commit time (UTC)** | same feed as L1 | spread, total, ML | **yes**, both sides, on every snapshot |
| L3 | EdgeDesk opener capture `football/pricing/openers_nfl.json` | NFL | 2026 only (from 2026-09-16), 105 games | open / latest / close | yes (`seen_at`) | the app's odds proxy | spread, total, ML | ML only |
| L4 | `sportsdataverse/cfbfastR-data` `betting/cfb_line_odds.csv.gz` via `football/cfb_p4/research/build_market.py` | CFB | 2006–2025 | **opener + close per book** | **none** (neither the open nor the close) | ~30 books; openers only from 5Dimes 2012–2019, Bovada 2021–2025, DraftKings 2023–2025, ESPN Bet 2024–2025 | spread, total, ML | 5Dimes yes (most seasons); **Bovada none** |
| L5 | EdgeDesk CFB lab quote ledger `football/cfb_lab/ledger/2026/quotes/` | CFB | 2026, weeks 4–9 (308 games with pregame quotes) | hourly DraftKings (ESPN) quotes, CFBD consensus | yes (`observed_at`) | DraftKings, consensus | spread, total, ML | mostly none |
| L6 | `record/football/cfb_2026.json` | CFB | 2026 | close (frozen at kickoff) | yes | DraftKings via ESPN | spread, total | no |

Checked and **not reachable / not existing**: sportsbookreviewsonline.com, aussportsbetting.com,
CollegeFootballData API and Kaggle are blocked by this environment's network policy (HTTP 403
from the egress proxy). The repository's own documentation already records that no historical
NFL openers were ever captured (`docs/model-loop/nfl/BACKTEST.md`). Nothing was substituted
for a missing line.

### 1a. NFL early-week coverage (L2), weeks 2+ (week 1 has no prior-week results and no in-season starter)

The **early-week checkpoint** τ for week W is the last kickoff of week W−1 plus 5 hours
(Tuesday ~01:00 ET in a normal week), so every result a model reads is final. The early
line is the last value the feed carried at τ; the close is the last value before kickoff. A
checkpoint is used only if the feed was **live** (some commit within 6 hours before it) —
in early 2020 the job was not yet running and a June lookahead value would otherwise pose
as a September line.

| season | games (wk ≥ 2) | early spread | early total | early spread price | close spread | Friday spread | share moved τ→close | mean \|move\| spread | mean \|move\| total |
|---|---|---|---|---|---|---|---|---|---|
| 2015–2019 | 1,255 | **0** | 0 | 0 | 0 | 0 | — | — | — |
| 2020 | 264 | 256 | 211 | 256 | 238 | 199 | 0.81 | 1.36 | 1.30 |
| 2021 | 269 | 261 | 261 | 261 | 259 | 267 | 0.81 | 1.27 | 1.16 |
| 2022 | 269 | 263 | 263 | 263 | 269 | 269 | 0.75 | 1.04 | 1.16 |
| 2023 | 270 | 269 | 269 | 269 | 269 | 268 | 0.77 | 0.98 | 1.11 |
| 2024 | 269 | 260 | 260 | 259 | 264 | 255 | 0.75 | 0.93 | 1.00 |
| 2025 (holdout) | 269 | 264 | 264 | 264 | 269 | 262 | — | — | — |
| 2026 (holdout, to wk 7) | 272 scheduled | 91 | 91 | 91 | 77 played | 78 | — | — | — |

(Holdout rows show coverage counts only; no movement or model statistic was computed on them.)
The last pre-kick snapshot equals the published close in 93–99% of games from 2021 on (69% in
2020, when the job ran hourly). Median time from τ to kickoff: 5.5 days.

### 1b. CFB opener coverage (L4), bet book fixed per era before any scoring

| season | games with an FBS side | FBS v FBS | book | opener spread | opener total | opener price | mean \|open→close\| |
|---|---|---|---|---|---|---|---|
| 2012 | 841 | 733 | 5Dimes | 783 | 701 | 752 | 1.48 |
| 2013 | 849 | 738 | 5Dimes | 795 | 809 | 643 | 1.69 |
| 2014 | 868 | 760 | 5Dimes | 813 | 817 | 790 | 1.82 |
| 2015 | 877 | 772 | 5Dimes | 830 | 833 | 135 | 1.93 |
| 2016 | 873 | 760 | 5Dimes | 809 | 819 | 711 | 1.98 |
| 2017 | 880 | 782 | 5Dimes | 810 | 811 | 590 | 1.87 |
| 2018 | 891 | 776 | 5Dimes | 834 | 850 | 780 | 1.66 |
| 2019 | 891 | 777 | 5Dimes | 823 | 849 | 747 | 1.74 |
| **2020** | 568 | 534 | — | **0** | **0** | — | — |
| 2021 | 887 | 770 | Bovada | 871 | 877 | 0 | 1.15 |
| 2022 | 896 | 776 | Bovada | 815 | 822 | 0 | 1.34 |
| 2023 | 910 | 792 | Bovada | 817 | 827 | 0 | 1.67 |
| 2024 | 920 | 799 | Bovada | 796 | 795 | 0 | 1.38 |
| 2025 (holdout) | 934 | 808 | Bovada | 924 | 928 | 0 | — |

* **No 2020 openers exist** in the archive (every book). 2020 is skipped for CFB.
* **No timestamps.** The archive's opener is "the book's first number"; when it was posted is
  not recorded. Standard practice is Sunday after the prior Saturday, but lookahead lines exist.
  Mitigation (pre-registered in EXPERIMENTS.md): every CFB CLV result is re-run with model
  ratings frozen one week earlier (through week W−2); a result that survives only with
  W−1 ratings is treated as possibly leaked.
* Bovada carries **no prices** in the archive, and 5Dimes 2015 prices mostly fail an
  unambiguous side match; where prices are missing the harness assumes −110/−110 (stated, not
  imputed into the data).
* DraftKings' "openers" in 2023 moved in only 53% of games (vs 80–90% elsewhere): they look
  captured late, which is one reason Bovada was fixed as the 2021+ bet book.

### 1c. Data-quality rule (fixed before any model was scored)

A book's open/close pair is dropped when |close − open| > 10 spread points (12 total points),
and a CFB book close is dropped when it is more than 3 points from the across-book median close.
The rule was set from rows like these, all in the archive: a 5Dimes opener of **334**
(Wisconsin–Central Michigan 2019), **−185** (Texas A&M–Alabama 2019), Vanderbilt–South
Carolina 2014 opening +20.5 and closing −21.5 (a sign flip), DraftKings openers on the wrong side
in 2023–2025. It drops 4–13 CFB games a season and 4 NFL games (2020).

### Markets

| market | NFL | CFB |
|---|---|---|
| game spread | early + Friday + close, 2020–2026 (L2) | open + close 2012–19, 2021–25 (L4) |
| game total | early + Friday + close, 2020–2026 (L2) | open + close 2012–19, 2021–25 (L4) |
| moneyline | snapshots 2020–2026 (L2) | 5Dimes open+close 2012–19 |
| **team totals** | **none anywhere** | **none anywhere** |
| **first half (1H)** | **none anywhere** | **none anywhere** |

(`football/linemaker` grades team totals against its *own* fair number, not a market line; it
is not a line archive.)

---

## 2. Feature timing inventory

"Usable at the early line" means knowable at τ (NFL) or plausibly at the CFB opener
(Sunday after week W−1).

| feature | source | timestamp | usable at early line? | treatment |
|---|---|---|---|---|
| unit ratings (EPA, points) through week W−1 | nflverse pbp / stats_team_week; sportsdataverse CFB pbp | game dates | **yes** (NFL τ is after the last W−1 game) | models price every week-W game from the rating state at the **start** of week W |
| market rating (prior weeks' closes) | lines above | prior weeks | yes | as is |
| **game-day starting QB** (`home_qb_id` in games.csv; first passer in CFB pbp) | nflverse / pbp | kickoff | **no** | replaced by the **previous game's starter** for every team (`qb_overrides`) |
| starter left last game early (share of team dropbacks) | pbp of week W−1 | Monday | yes | candidate feature (Phase 4) |
| starter was not the season's regular starter | prior games | prior weeks | yes | candidate feature |
| NFL injury report status (Out/Doubtful/Questionable) | `nflverse-data injuries_<season>.csv`, 2009–2026, one row per player-week, `date_modified` | final report (usually Friday) | **no at τ; yes at the Friday checkpoint** | used only by Friday-checkpoint experiments (Phase 5) |
| CFB injuries | none before 2025 (conference reports start 2025/2026, `football/availability/`) | — | no history | not used |
| weather (temp, wind) | nflverse games.csv | **observed at game time** | **no** (no forecast archive) | neutralised at prediction time (temp 68 / wind 0 / non-dome); roof is known |
| rest, bye, short week, travel, time zones, division | schedule | season start | yes | as is |
| line drift before τ (lookahead → τ) | L2 | yes | yes (NFL only) | candidate feature |

### Leaks found in existing artifacts (why the baselines are re-run, not read)

1. `docs/model-loop/{nfl,cfb}/predictions.csv.gz` (Loop v2.0.0) price the **starter who actually
   played** and, for totals, **game-time weather**. The starter differs from the previous game's
   starter in **10.4%** of NFL and **15.0%** of CFB team-games (2015–2024). These are exactly the
   games where lines move most, so using them against an early line would manufacture CLV.
2. The NFL v2.1.0 replay (`football/research/nfl_v2/backtest.js`) absorbs games in kickoff order,
   so a Sunday game's features include that week's Thursday result — after a Tuesday line. The
   replay here prices all of a week's games from the week-start state.
3. CFB V1 (`football/cfb_p4`, v1.0.1) carries constants (k, carry, blend curve, conference weight)
   trained on **2001–2025**, i.e. in-sample for every evaluation season. It is replayed as a
   baseline anyway; any CLV it shows is optimistic by construction and is flagged.
4. The loops' hyperparameters were tuned on 2011–2019 (NFL) and 2014–2020 (CFB). They are part of
   the production models being baselined; the CLV target was never used to tune them.

---

## 3. What this makes feasible

| phase | feasible? | scope |
|---|---|---|
| 2 harness | yes | spreads and totals; CLV in points and no-vig probability (prices where present, −110 otherwise) |
| 3 baseline | **partly** | **NFL 2020–2024 only** (2015–2019: no early lines exist — gap reported, not filled). **CFB 2015–2019 + 2021–2024** (2012–2014 available as training history) |
| 4 market-residual | yes | NFL: disagreement, lagged-QB flags, rest/travel, pre-τ drift; no injuries or weather at τ. CFB: disagreement, lagged-QB flags, rest; no timing features |
| 5 backup QB (NFL) | yes | Friday checkpoint + injury report status (timestamped) |
| 5 CFB non-Power-4 / early week | yes | the archive opener *is* the early-week line |
| 5 totals | yes | game totals, both sports |
| 5 team totals | **no** | no line data exists — skipped |
| 5 1H | **no** | no line data exists — skipped |
| 6 holdout | yes | NFL 2025 + 2026 wk 2–7 (L2); CFB 2025 (L4, Bovada) + 2026 wk 4–8 (L5, DraftKings, timestamped — a different book, stated) |

Sample sizes are the binding constraint: NFL dev has ~1,300 games with early lines, so a
threshold strategy places a few hundred bets; mean CLV must be large (≳0.3 pts) to be
distinguishable from zero with a week-clustered interval.
