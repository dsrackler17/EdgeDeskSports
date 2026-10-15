# NHL — model card (`edgedesk_nhl_v1`, production candidate `xg_core`)

> Status: **validated against outcomes, not tested against the market.**
> Fair lines are published; value claims are off.
>
> Since 2026-10-13 the engine also has a model lab (`NHL_LAB.md`), player-prop
> research (`NHL_PROPS.md`), a data-source registry and a box-score
> reconciliation (`NHL_SOURCES.md`), a Supabase warehouse and operations
> notes (`NHL_OPERATIONS.md`), and the audit that preceded them
> (`NHL_AUDIT.md`). Two amendments changed the production model; both are
> in §3.

## 1. Data

| Layer | Source | Coverage | Files |
|---|---|---|---|
| Play-by-play | sportsdataverse `fastRhockey-nhl-data` (compiled from the NHL's api-web game feeds) | 2010-11 → 2026-27 in progress, regular season + playoffs, 20,676 games | `.cache/nhl_src` (not committed) |
| Starters | the same, goalie box score `starter` flag | as above | — |
| Schedule | sportsdataverse `fastRhockey-nhl-raw` season schedule; the NHL API `/v1/schedule/{date}` in CI | every scheduled game with UTC start | `hockey/sources/nhl_api.js` |
| Team-game table | built here (schema `edgedesk_nhl_team_games_v2`) | 41,352 rows, 2 per game | `hockey/data/team_games/<season>/<YYYY-MM>.csv`, `hockey/data/manifest.json` |
| Lineups | sportsdataverse skater box scores: who dressed, time on ice | every scored game since 2013-14 (17,236 of 17,236) | `.cache/nhl_work/lineups_<season>.json.gz` (`hockey/ingest/lineups.js`) |
| Second source | the NHL data pack's ESPN retrieval of 2024-25 (`datapack/nhl_v1`, verified by `tools/datapack/verify_nhl.js`) | the full season: 1,398 games, 448,177 events, 167,569 shot attempts, 53,259 player-games, 2,953 goalie-games, officials | `hockey/crosscheck/espn.js` → `hockey/validation/nhl_crosscheck_espn.json`, crosswalks in `hockey/data/crosswalk/` |
| Officials | the same pack (ESPN lists referees and linesmen) | 1,397 of 1,398 games of 2024-25 | `hockey/data/officials/2025.csv` (research only: no assignment time) |

**Time (the data pack's rule).** `known_at` is blank on every row: when the
source first published a game was never recorded, and nothing is backdated.
The walk-forward uses an explicit assumption instead — `assumed_available_at`,
the scheduled start plus four hours — and every row carries `pit = RETRO`:
retrieved after the fact from a source that can revise, so the record is a
retrospective test, not a certified point-in-time one.

**A second source agrees, event by event, over a full season.** The NHL data
pack (`datapack/nhl_v1`) is ESPN's retrieval of the whole 2024-25 season. Its
tables pass 34 of 34 independent checks in Node (`tools/datapack/verify_nhl.js`:
hashes, blank `known_at`, the 32-club scope, every measured and lagged feature
recomputed with the target game excluded); the pack's own Python is never run.
Reconciled against my NHL feed (`hockey/crosscheck/espn.js`):

- **Games**: 1,398 of 1,398 matched (`hockey/data/crosswalk/espn_nhl_2025.csv`);
  every final, every regulation / overtime / shootout decision and every
  team's regulation goals agree.
- **Shot attempts**: 167,013 of 167,061 non-shootout attempts matched to an NHL
  event by period, elapsed second (±1) and shooter. Their ids give a player
  crosswalk resting on id pairs, not names
  (`hockey/data/crosswalk/espn_nhl_players_2025.csv`: 1,027 of 1,027 players;
  1,020 from events, 7 by name within the team-game).
- **Coordinates**: ESPN's x/y, which the pack leaves unverified, are the NHL's
  raw rink coordinates in feet (99.4% within 1 ft).
- **Strength**: ESPN's "Even Strength" is 5v5 in 94.6% of attempts. The rest
  is 4v4 or 3v3, or time with a goalie pulled: it is a label, not a manpower
  count. My states come from on-ice skater counts.
- **Shot type**: the type ESPN's description implies agrees with the NHL's
  coded type in 99.5%.
- **Goalies and skaters**: goals against agree for every goalie my feed saw
  (2,950 of 2,953; the other three faced no unblocked attempt). Shots on goal
  faced agree in 2,930 of 2,950; the 20 others are exactly the rows where
  ESPN's GA counts a goal its SA does not. The goalie with the most ESPN time
  is my starter in every one-goalie game; the 72 exceptions are pulled
  starters. Every skater's TOI agrees within 5 s (50,306 of 50,306). ESPN's box
  lists one skater fewer in 15 team-games, and those hold all 33 of the pack's
  attempts with no shooting team.

**The pack found an error in my ingest.** On a `BLOCKED_SHOT` my feed's event
team is the *blocking* team, and its fixed-frame location is rotated 180° as if
the blocker had attacked. My ingest had credited blocked attempts to the
blocker. Two checks:

- **Every season:** the event team is the shooter's club in 1 of 610,859
  blocked attempts, 2010-11 to 2026-27 (`hockey/crosscheck/blocked.js` →
  `hockey/validation/nhl_blocked_attribution.json`).
- **Against ESPN, 2024-25:** ESPN's shooting team is the NHL event team in 0
  of 47,087 matched blocked attempts.

`hockey/ingest/game.js` `shooterView()` now credits the shooter and rotates
the location back: 47,087 of 47,087 agree with ESPN's shooter, and 99.9% sit
in the period's shot frame.

The fix moves blocked attempts to the right team's Corsi, and it changes three
xG context features:

- **Rebound and second chance:** a shot after the same team's blocked attempt
  now counts as a rebound or second chance, as the features were defined.
- **Rush:** such a shot is no longer flagged a rush.

The xG refit's pooled held-out log loss is unchanged: 0.212991 → 0.212986
over 1.64 million shots. It is slightly better in 2012–2021 and slightly
worse in 2024–2026. The features were not re-tuned on held-out seasons to
win that back.

**Officials** (research only; `hockey/research/officials.js` →
`hockey/validation/nhl_officials_research.json`). I tested 1,311
regular-season games for a repeatable referee effect. The test splits each
referee's games into alternating halves and compares them, against a
2,000-shuffle permutation null. No effect cleared p < 0.01:

| Outcome | Split-half r | p |
|---|---|---|
| Minor penalties | 0.27 | 0.065 |
| Power-play time | 0.16 | 0.19 |
| Regulation goals | −0.05 | 0.56 |

No assignment time is recorded, so no referee term may enter a price.

**The pack's lagged features** (research; `hockey/research/pack_features.js` →
`hockey/validation/nhl_pack_features.json`). Given my model's out-of-sample
moneyline probability, I tested whether the pack's prior-10 Corsi or Fenwick
share, prior-10 regulation goal difference, rest hours or games in the prior
7 days still predict the result. Each was fitted on the first half of 2024-25
and scored on the second. None clears the walk-forward bar (≥ 0.001 better
with a 95% interval below zero); the best is Fenwick share at −0.0028
(−0.0100 to +0.0050). None enters the price.

**Canonical contracts.** The shots, goalie-game and event-context tables are
mapped onto the pack's contracts and validated row by row
(`hockey/contracts/canonical.js` → `hockey/validation/nhl_contracts.json`):
119,357 shots, 2,939 goalie-games and 1,394 event contexts for 2025-26, zero
errors, and a stated reason for every field that is always empty (for
example, shots on goal faced are not stored, so `shots_faced` is left empty
rather than filled with unblocked attempts).

**Integrity, measured on ingest**: every game's play-by-play final equals the
official final (0 disagreements across 17 seasons); time on ice sums to 3,600 s
in every regulation game; one goal-attribution mismatch in 41,352 team-game
rows (`tools/hockey/hockey.test.js` tolerates none in the 2025-26 partition it
checks). 2009-10 is excluded (no strength state in the source).

Semantics verified on the source before any code relied on them: the home
team attacks +x; `event_team` is the shooter on shots, misses and goals, the
**blocker** on blocked attempts (turned around on ingest, above) and the
penalised team on penalties; a goal row's score already includes the goal;
`empty_net` is true exactly when the defending goalie is out.

## 2. Method

1. **xG** (`hockey/xg/model.js`). Shot-level logistic regression on distance
   (piecewise linear), angle, behind-the-net, shot type, rebound and its angle
   change, rush, cross-slot movement, puck speed from the previous event,
   turnovers, offensive-zone faceoffs and hits, strength state and
   interactions; a separate distance model for empty-net attempts. Fitted on
   the three seasons before the season it scores.
2. **Ratings** (`hockey/model/ratings.js`), point in time: score-and-venue
   adjusted, opponent-adjusted 5v5 xG for/against; all-situations goals;
   power-play xG and penalty-kill xG against; PP/PK minutes; finishing;
   goalie goals saved above expected shrunk toward a replacement-level prior;
   projected starters (recent usage, the league's measured back-to-back
   rule). Half-life 180 days, a 32-game prior (tuned on the selection window).
   Special-teams ratings are still computed and shown, but since 2026-10-13
   they are not in the price (§3, amendment 2).
3. **Goal model** (`hockey/model/glm.js`). Poisson regression of each team's
   regulation goals on the ratings (log ratios), home ice and back-to-backs,
   with the league's running scoring level as an offset; refitted each season
   on the five seasons before it. A two-number recalibration (shrink the
   predicted total, stretch the home/away split) is fitted on the three
   seasons' out-of-sample predictions before the season it applies to.
4. **Score distribution** (`hockey/model/distribution.js`, browser + Node).
   An exact 30-second dynamic programme over regulation with empirical
   score-effect multipliers by lead and time (they encode leaders sitting back,
   trailers pressing and goalie pulls). Since 2026-10-13 the first period is
   its own time bucket (§3, amendment 1). Overtime is 3-on-3 at a fitted rate,
   the shootout is at its observed home rate, and playoffs are sudden death.
   The same code re-prices any goalie or lineup scenario in the reader's
   browser.
5. **Markets** (`distribution.fullSheet`), each with its own settlement and
   held-out status:
   - 2-way moneyline (incl. OT/SO);
   - 60-minute 3-way;
   - puck lines ±1, ±1.5, ±2.5, ±3.5 (an OT/SO win is a one-goal win);
   - totals 4.5–8.5 (incl. OT; shootout winner credited one goal; whole lines
     push, with fair odds on the conditional ratio);
   - regulation totals;
   - team totals 1.5–4.5;
   - first-period 3-way and totals.
6. **Why the number** (`hockey/model/explain.js`). Each price is decomposed
   into its factors: home ice, and each club's 5v5 creation, 5v5 suppression,
   results beyond chances, and rest. The values are exact Shapley values
   through the whole chain and add up to the published probability. The
   narrative is a fixed template over these numbers; no language model
   writes it.

7. **Lineups** (`hockey/model/lineups.js`), point in time: a skater's value
   is his recent time on ice per game (his last 20 games, any team, shrunk
   toward 10 minutes); a lineup's value is the sum over the dressed skaters;
   the feature is the log ratio of tonight's lineup to the club's typical one
   (its last 10 lineups, re-valued today). *Projected*: the previous game's
   lineup. *Confirmed*: the lineup that dressed, treated as known at warmups
   (the prediction time) — the confirmed-goalie assumption applied to skaters.

Tested and rejected, recorded in the validation file: a bivariate-Poisson
common shock (maximum-likelihood share 0 in every season).

## 3. The walk-forward record (`hockey/validation/nhl_walkforward.json`)

Protocol (written into `hockey/model/walkforward.js` before scoring): one
chronological pass; games on date D are predicted from games on earlier dates
only, 30 minutes before the scheduled start; every parameter is fitted on
earlier seasons. Selection window 2014–2020, confirmation 2021–2026, live
2026-27. Leakage audit: **17,236 predictions, 0 violations**.

Moneyline log loss (lower is better):

| Model | Selection (n 9,205) | Confirmation (n 7,945) | Live 2026-27 (n 86) |
|---|---|---|---|
| Home ice only | 0.6899 | 0.6908 | 0.6894 |
| Elo (FiveThirtyEight MOV form, tuned on selection) | 0.6767 | 0.6665 | 0.6592 |
| Goals-only ratings | 0.6758 | 0.6649 | 0.6568 |
| **xG model (chosen)** | **0.6747** | **0.6627** | **0.6534** |
| xG + projected goalie | 0.6745 | 0.6625 | 0.6537 |
| xG + confirmed goalie | 0.6744 | 0.6626 | 0.6529 |
| xG + projected lineup | 0.6745 | 0.6625 | 0.6574 |
| xG + confirmed lineup | 0.6746 | 0.6618 | 0.6565 |
| xG + confirmed goalie and lineup | 0.6743 | 0.6617 | 0.6558 |
| **xG core (special-teams block removed): production since 2026-10-13** | **0.6746** | **0.6629** | 0.6541 (n 89) |

**Amendments on 2026-10-13** (`hockey/model/walkforward.js` header; full
evidence in `NHL_LAB.md`):

1. **The period profile.** Score effects separate the first period from the
   second. First-period prices had run 3–5 points too high. The moneyline is
   unchanged (−0.000006); the first-period score likelihood improves by
   +0.0036 per game on selection and +0.0087 on confirmation.
2. **Parsimony.** `xg_core` drops the four special-teams features. As a
   block they were indistinguishable from noise (selection −0.00007,
   confirmation +0.00015). Rule 4 already prefers the simpler model unless a
   richer one wins by 0.001 on selection. On confirmation it is not
   significantly worse (+0.00015, 95% −0.00048 to +0.00087), and it beats Elo
   by 0.0037 (95% −0.0054 to −0.0021).

Both amendments were declared after the confirmation window had been read.
The 2026-27 season is the clean test. The rows above the amendments are the
record as first published, kept for reference.

(Rescored after the blocked-shot fix: every selection and confirmation figure
is unchanged to four decimals, give or take one in the last digit, and so is
the choice.)

On confirmation the chosen model beats Elo by 0.0038 (block bootstrap 95%
interval −0.0056 to −0.0021) and goals-only by 0.0022 (−0.0035 to −0.0011).
Goalie information adds a statistically detectable but tiny amount
(−0.0002); under the pre-registered rule (a challenger must beat the
incumbent by 0.001 on selection) the goalie-free model was chosen, and the
goalie-aware variant drives the goalie scenarios instead.

Lineups (the data pack's P0 item), declared after the confirmation window had
been read for the first five candidates: the **projected** lineup does not
clear the selection bar (0.0001 better on selection; confirmation −0.0002,
interval −0.0009 to +0.0006). The **confirmed** lineup is better on held-out
games: −0.0009 log loss against the goalie-free model (95% −0.0017 to −0.0001),
and adding it to the confirmed goalie gives −0.0009 (−0.0017 to −0.0000).
Coefficients have the expected signs (own lineup +0.86, opponent's −0.40 per
unit of log lineup value). No pregame lineup feed is wired, so the price does
not use it; the slate shows each club's absent regulars and a lineup-aware
sensitivity, and the uncertainty spread includes it.

Status by market on confirmation (rules: n ≥ 1000, |mean p − mean y| ≤ 0.02,
calibration slope 0.85–1.15, and for the moneyline a 95% interval below the
best baseline):

| Market | Status | Notes |
|---|---|---|
| Moneyline | OUTCOME_VALIDATED | Brier 0.2353, slope 1.06, mean p − y +0.009 (`xg_core`) |
| Puck line home −1.5 / away −1.5 | OUTCOME_VALIDATED | slopes 0.94 / 0.98 |
| Alternate puck lines −2.5, +2.5, +3.5 | OUTCOME_VALIDATED | scored in the lab; −3.5 is PROVISIONAL (slope 0.77) |
| Team totals 1.5 / 2.5 / 3.5, both sides | OUTCOME_VALIDATED | scored in the lab; slopes 0.87–1.10 |
| First-period total 1.5 | OUTCOME_VALIDATED | scored in the lab; other first-period lines PROVISIONAL |
| Totals 4.5–8.5, regulation totals | PROVISIONAL | calibration slopes 0.69–0.82 (over-confident); neither a shape term nor a longer calibration window fixes it (lab, Model F) |
| 60-minute 3-way | PROVISIONAL | the draw is under-priced (20.3% vs 22.4%; slope 0.68) |
| **Against the close** | **NOT_TESTED** | no licensed closing archive (`hockey/model/market_test.js` is ready) |

xG (`hockey/xg/report.json`): beats a distance-only model in every season and
matches or beats the source's own xG through 2021-22; from 2022-23 the source
records shot locations differently and its own xG (whose training seasons are
undocumented, so possibly in-sample) is better calibrated than mine.

## 3a. EdgeDesk vs the market (`lib/edgedesk_nhl_compare.js`)

Since 2026-10-14, Research → Other → NHL sets EdgeDesk's own line beside a
book's price, game by game, and says which side EdgeDesk rates higher. The
same comparison appears in the Today's Games matchup view for an NHL game.

**The price.** NHL capture through the odds gateway stays off (`NHL_PRICES`).
The comparison uses the price Today's Games already captured: DraftKings as
republished by ESPN's public scoreboard (`today/slate.json`), or the games
strip's live merged prices when they are newer. ESPN posts NHL odds on game
day, so later games show "no price yet". A republished price is a
**reference**: it is named by its book ("DraftKings"), its age is shown, it is a
past price after the slate's 90-minute limit, and it never passes the
`price_verified` gate of `lib/edgedesk_nhl_market.js`.

**Two questions, answered apart.**

1. *Which side does EdgeDesk rate higher than the book?* EdgeDesk's
   probability minus the book's no-vig probability, both from the raw numbers,
   each rounded once to 0.1 %, so the gap is the difference of the two shown
   numbers. On a whole-number line both exclude the push. On the moneyline a
   gap inside the model's own variant spread (`uncertainty.moneyline_sd_pp`)
   is called agreement.
2. *Does the book's price pay enough?* EV at the book's price and EdgeDesk's
   probability, labelled by `EDNHLMarket.evaluate` with every failing gate
   listed: PASS, RESEARCH ONLY (a market the record has not validated, such as
   totals), or PROVISIONAL. VERIFIED VALUE cannot appear until the NHL is
   tested against closing prices. When nothing pays, the sentence gives the
   price it would take to clear the 2 % bar.

Like for like only: the book's 2-way moneyline, puck line and total include
overtime and the shootout, as EdgeDesk's do. A line EdgeDesk has no
probability for is listed as not compared, never interpolated.

**Who is better where.** Each game's Overview also lays out the slate's
evidence block on one scale (+ is better than league average): 5v5 chances
created and allowed, goals scored and allowed, power play, penalty kill, the
likeliest starter's goals saved above expected, and rest. Within one point is
even. It ends with EdgeDesk's projected goals for each club, the bottom line
that already weighs every row with home ice.

Tests: `node tools/hockey/nhl_compare.test.js`, the NHL and Today's Games
browser suites (`tools/engine/engine_ui.e2e.js`, `tools/slate/games_ui.e2e.js`).

## 4. Honest limits

- **Not tested against the market.** Beating Elo is not beating a sportsbook.
  Until `hockey/market/closing/` holds a licensed archive and the market test
  says `TESTED_AHEAD` (n ≥ 500), no NHL price is called an edge.
- The confirmation window was viewed while two structural defects were fixed
  (a scoring-level lag and the total/split recalibration, both diagnosed on
  the selection window). The 2026-27 season and every later one are the clean
  out-of-sample test; the ledger (`hockey/ledger/`) freezes every published
  price before the puck drops so that test is honest.
- Lineups are measured but not in the price: confirmed lineups help, and only
  arrive at warmups; no injury or line-rush feed is wired. Line combinations
  are not modelled. Travel and time zones are measured and shown, and add
  nothing out of sample.
- Retrospective data: `known_at` is unknown for every historical row; the
  walk-forward assumes a game is known four hours after its start.
- Starters are projected unless confirmed by hand with a source.
- Neutral-site games (the Global Series: four in 2024-25, flagged by ESPN) are
  priced with home ice: my feed carries no neutral flag.
- Referees are not modelled: one season of assignments, no assignment times,
  and no repeatable effect found.
- Totals are over-confident and the 60-minute draw is under-priced; both are
  labelled PROVISIONAL in every view. Overdispersion, draw inflation and a
  longer calibration window were each tested and rejected (`NHL_LAB.md` §4).
- Machine-learning challengers, ensembles, travel, time zones, congestion,
  recent form and luck regression were tested out of sample and do not clear
  the bar (`NHL_LAB.md`). They appear as research, never in the price.
- The starter projection is right about two times in three
  (`nhl_diagnostics.json`). A licensed confirmed-starter feed is the most
  valuable missing input.
