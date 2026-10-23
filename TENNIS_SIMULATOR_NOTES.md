# TENNIS_SIMULATOR_NOTES — tennis draws and matches

The engineering record of the tennis seat of the Simulator: what it
simulates, what it stands on, what was measured, how well it forecast matches
and draws it had not seen, and what it does not know. Shared engine, database
and reader: [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md). Dates are UTC;
"retrieved" is 2026-10-23.

Tennis was retired from EdgeDesk Research on 2026-09-27 (`lib/edgedesk_sports.js`:
no odds are bought for it, the research desk declines it). That is unchanged.
This is the Simulator's own tennis seat, built on public data, at the owner's
request.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| Match rating (new) | Point-in-time Elo per tour, moved by the share of games won; best of five through the set | `simulator/src/sports/tennis/elo.ts`, §3 |
| Draw simulation | Every match left in a singles main draw, results and byes kept; **ACTIVE** | `module.ts`, §4 |
| The day's matches | Every scheduled singles match with both players known (main draws and qualifying) | `module.ts matchesModule`, §4 |
| Draw order | Wikipedia's draw article confirmed against ESPN line by line; else ESPN's semifinals on | `wiki_draw.ts`, `inputs.ts`, §2.3 |
| Walk-forward evidence | 2025-2026 holdout: matches against a coin and FiveThirtyEight's Elo; draws against every entrant equally likely | `simulator/data/tennis_elo_study.json`, `tennis_backtest.json`, §5 |
| Reader | Draws, Matches, Model Health; a draw picker | `lib/edgedesk_simulator_tennis.js`, §7 |
| Publication | One competition per draw (`atp-<ESPN tournament id>`, `wta-<id>`) and `matches`, season `2026`; no SQL change | §6 |
| Nightly | Every draw whose order is known, and the day's matches, through 2026-12-02 | `config.ts nightly_through`, `cli/plan.ts` |

On 2026-10-23 five draws are simulated, all at the semifinals or about to
reach them: the BNP Paribas Fortis European Open, the Almaty Open and the
Grand Prix Auvergne-Rhône-Alpes (ATP), and the Kinoshita Group Japan Open and
the BNB Ningbo Open (WTA). Their order comes from Wikipedia's articles,
confirmed against 24 to 28 of ESPN's players each. The Erste Bank Open,
Swiss Indoors, Toray Pan Pacific Open, Guangzhou Open and others are listed
with their reason (their articles are not filled in yet, or ESPN lists none of
their players yet). Their qualifying matches are priced under Matches (48
matches).

---

## 2. Data

### 2.1 Matches (`simulator/data/feeds/tennis_matches.json.gz`)

ESPN's public tennis scoreboard (`site.api.espn.com/.../tennis/{atp,wta}/scoreboard`),
read on GitHub's runners by `simulator/src/cli/fetch_sports_data.ts --what tennis`
in half-month ranges from January 2022 (a slam fortnight carries hundreds of
competitions per tour; a request answers at most 900): 48,925 singles rows,
744 tournaments, 236 windows, none unread. The rows are parsed by the
repository's own adapter (`tools/tennis/espn.js parseScoreboard`), with one
shared row builder for the feed and a run's live read (`tennis/espn.ts`).

Two parser defects were found and fixed on the way:
- **The round.** `roundOf` read the competition's notes first. On the live
  feed the note is the result line ("A (ITA) bt B (AUT) 6-3 7-6 (7-4)"), so
  every round came out as "3 7-6 (7-4)". It now reads the competition's own
  round ("Round 1", "Qualifying Final", "Semifinal") and takes a note only
  when it is a round label. Every tennis suite still passes.
- **Duplicates.** ESPN lists 1,277 early-2022 matches twice under two ids
  (the same tournament, round and players). `elo.ts dedupeFeed` keeps one per
  (tour, tournament, round, pair): the lowest played id. Two groups whose
  played rows disagree on the winner (retirements scored both ways) are left
  out whole.

`loadMatches` keeps a match only if it was played to a result between two
named players: 46,413. Left out: 904 not final, 290 walkovers, 22 cancelled,
17 with no winner. A retirement counts (a ball was struck); a walkover does
not.

### 2.2 Today's scoreboards, rankings

`tennis_current.json.gz`: the tournaments in progress or starting within two
weeks, and both tours' plain scoreboards whole (every competition of the
tournaments in play). A run re-reads these live on the runner and lays them
over the history. `tennis_rankings.json`: ESPN's ATP and WTA top 150, shown
beside a player, never an input to a price. The first run requested the
rankings with the `{via, url}` object instead of its URL (12 errors); fixed.
ESPN's tennis summary endpoint answers 400 for every tournament and is no
longer called.

### 2.3 The draw's order (`tennis_draws.json.gz`)

**The problem.** ESPN's scoreboard lists a draw's matches by time, with no
position in the draw, and lists every match not yet scheduled as TBD v TBD.
Its match ids do not follow the draw either: in 727 rebuilt draws, two matches
feeding the same next-round match are adjacent in id order only about half
the time. ESPN's bracket page (`espn.com/tennis/bracket/...`) answers GitHub's
runners with an AWS WAF bot challenge (HTTP 202, 2,015 bytes). Its core API
event (`sports.core.api.espn.com/v2/.../events/{id}`) carries `bracketAvailable`
but no position.

**The source.** Wikipedia's singles draw article ("2026 Swiss Indoors –
Singles") lays the main draw out in bracket templates. Their first-round
parameters `RD1-team01, 02, ...` are the lines top to bottom. The fetcher
asks Wikipedia's search API (with an identifying user agent) and keeps up to
four candidate articles per draw:
- a draw article among the hits;
- this year's tournament articles among them, plus " – Singles";
- ESPN's own name plus " – Singles".

The search's first guess is often wrong: the Guangzhou Open's hits included
the Wuhan Open's article, and the Paris Masters' the Shanghai Masters'.

**Parsing** (`wiki_draw.ts`). The main draw is the article's Draw section up
to the next level-2 heading. Its bracket templates in document order are the
draw's sections, except the Finals bracket, which repeats lines already
listed. In a "-Byes" template a bye leaves out its pair of first-round
parameters, and the seed appears straight in the second round. A line is the
link's target ("Tommy Paul (tennis)" read as Tommy Paul), the plain text, a
bye, or empty: an article not yet filled in leaves `{{flagicon|}}` lines, and
is not used.

**Confirmation** (`inputs.ts drawFromArticle`). Only the order is taken from
Wikipedia. The order is used only if all of these hold:
1. ESPN lists at least half the draw's players; otherwise the article cannot
   be confirmed, which also stops a different tournament's article from
   passing.
2. At least 90% of ESPN's players are named on a line (exact name, the same
   words in any order, or the same surname and first initial, unique only).
3. Every player ESPN lists opposite a placed player goes on that player's
   sibling line. This places a qualifier the article had not named yet, or a
   lucky loser replacing a withdrawal.
4. Every listed match fits the lines: its two players meet in one match of
   its round, from different halves of it.
5. No line is left without a player.

A named player ESPN has not listed yet in this draw is found among the tour's
players by name.

**The fallback** (`drawFromLateRounds`). From the semifinals on, ESPN's own
listing is the draw (both semifinals with their players, or the final).

A draw is never guessed. One with no confirmed order is skipped with the
reason: every article tried and why it failed.

---

## 3. The rating (`elo.ts`, `simulator/src/research/tennis_elo_study.ts`)

Each tour separately (men and women never meet). Every player starts at 1500.
Before a match side a is expected to win with
`p = 1 / (1 + 10^(-(R_a - R_b)/400))`. After it each rating moves by
`K_i × (target − expected)`, with FiveThirtyEight's shrinking step
`K_i = k_num / (n_i + 5)^k_exp`. The target is taken from the share of games
won, `sigmoid(mov_stretch × 12 × (games share − 1/2))`, blended with the
result by `mov_weight`. A retirement counts as the result only.

Chosen on 2023-2024 (2022 is warm-up), over 700 combinations of
`k_num` 200-800, `k_exp` 0.4-0.7, `mov_weight` 0-1 and `mov_stretch` 0.5-2.5:
**k 400/(n+5)^0.5, the games share alone, stretch 1.5** (tune log loss
0.63026; interior on the stretch, at the bound of the weight). The games won
say more about the gap between two players than the result alone.

**Best of five.** The rating is fitted on a mix that is mostly best of three.
A men's Grand Slam main-draw match is priced through the set: solve
`p = s²(3 − 2s)` for the set chance `s`, then
`P5 = s³(1 + 3(1−s) + 6(1−s)²)`. On the tuning window's 1,076 such matches
this lowers the log loss from 0.5628 to 0.5550, and on the holdout's 1,009
from 0.5731 to 0.5666. It is used.

**Sets are not independent.** The same set model predicts that 50% of
best-of-three matches between near-equals go three sets; 37% do (7,156
holdout matches; 44% v 31% at a 70-80% favourite). So no set-score figure is
published.

---

## 4. The simulation (`module.ts`)

**A draw.** Its lines in draw order, `L = 2^k` (a 28 draw is 32 lines with
four byes). A round's level is fixed from the final (`draw.ts`): Final 6,
Semifinal 5, Quarterfinal 4, the first round `7 − k`. ESPN names early
rounds up from Round 1 and the last three down from the final. Each run plays
every match bottom-up:
- a decided match keeps its winner (Observed; a retirement or a walkover is a
  result);
- a bye advances its player;
- any other match is drawn from the served price, on its own random stream
  (`STREAM.games`), from the ratings frozen at the as-of time.

Outcomes per player: win the title, reach the final, the semifinals and the
quarterfinals, and win their next match. A round already reached counts in
every run. A draw that starts at the semifinals counts its players as
quarterfinalists.

Sum rules after every run: one champion, two finalists, four semifinalists,
eight quarterfinalists (fewer only where a bye empties a first-round slot).
`exactReach` computes the same chances exactly through the bracket. The
snapshot carries them, and the tests check that the simulation converges to
them.

**The day's matches.** Each scheduled match with both players known in the
next three days, drawn from its price. An entity is a player in one match;
there is one winner per match in every run.

---

## 5. Evidence

### 5.1 Matches (`simulator/data/tennis_elo_study.json`, holdout 2025-01-01 to 2026-10-23)

| Tour | Matches | Log loss | FiveThirtyEight's Elo | Coin | v coin (95%) | v FiveThirtyEight (95%) |
|---|---|---|---|---|---|---|
| ATP | 7,447 | **0.6341** | 0.6440 | 0.6931 | −0.0590 (−0.0682 to −0.0498) | −0.0099 (−0.0133 to −0.0065) |
| WTA | 11,620 | **0.6227** | 0.6322 | 0.6931 | −0.0704 (−0.0780 to −0.0620) | −0.0095 (−0.0120 to −0.0071) |

Intervals come from a tournament bootstrap with 1,000 resamples. Accuracy is
63% (ATP) and 65% (WTA). Main draws score better than qualifying (ATP 0.624 v
0.655). Calibration: in ten bins of the favourite's price, the mean price and
the share won differ by 0.4% on average (bins of 30 or more matches).

### 5.2 Draws (`simulator/data/tennis_backtest.json`)

Every completed 2025-2026 main draw whose tree rebuilds from who advanced
(`draw.ts buildTree`): 299 draws (102 ATP, 197 WTA). 39 were refused with
their reason: 16 not finished, and the rest with data gaps such as matches
outside the tree or a player listed twice. Each draw is replayed from its
first round with the ratings frozen at its start, and each entrant's title
chance is computed exactly through the tree.

| Tour | Draws | Champion log loss | Everyone equal | Difference (95%) | FiveThirtyEight | Favourite won |
|---|---|---|---|---|---|---|
| ATP | 102 | **2.576** | 3.671 | −1.094 (−1.393 to −0.816) | 2.647 | 30 |
| WTA | 197 | **2.920** | 3.587 | −0.667 (−0.865 to −0.469) | 3.026 | 42 |

Title chances are calibrated. For the ATP, players given 10-25% won 16.8%
(191 players) and players given 25% or more won 40.4% (47). For the WTA the
same bins won 13.8% (405) and 25.6% (39). The reach-the-quarterfinals,
semifinals and final Brier scores beat both baselines on both tours.

### 5.3 Activation (`activation.ts`)

These conditions were written after this first study and backtest. They are a
floor the evidence must keep clearing on every refresh, not a preregistration:
- both tours beat a coin and FiveThirtyEight's Elo with the interval below
  zero;
- the calibration error is at most 0.03;
- the champion's log loss beats everyone-equal with the interval below zero.

All hold on 2026-10-23. `registry.ts` shows tennis ACTIVE only while they
hold.

---

## 6. Runs and gates (`run.ts`)

One competition per draw (`atp-440-2026`), plus `matches`, all under season
`2026`. Gates:

**Block simulation:**
- `model.study`
- `draw.order`: the source and the article's revision
- `draw.consistent`: every result on its winner's path; no line twice
- `matches.present`

**Block publication:**
- `players.rated`: at most a third of the players still in have fewer than 10
  matches on file
- `draw.open`
- `results.current`: the scoreboard at most 6 hours old

Then the shared `run.sum_rules`, `run.finite`, `run.count` (100,000) and
`sport.active`. A run with no draw to simulate says so. The nightly leg runs
at 10:17 UTC, after the 09:41 feed refresh, and re-reads today's scoreboards
live.

---

## 7. Reader (`lib/edgedesk_simulator_tennis.js`)

- **Draws.** A draw picker, built from one request for every tennis run's
  summary. For the selected draw:
  - the tournament, its stage, best of three or five, and where the order
    came from;
  - "Who wins the title": every player still in, with title, final,
    semifinal and quarterfinal chances (a column only while it is
    undecided), their next match, the Monte Carlo ±, and fair title odds
    (decimal · American);
  - the next matches, priced for both players;
  - the results so far (winner, loser, walkover or retirement).
- **Matches.** Every scheduled match by tournament: round, time (UTC), both
  players with seeds, each one's chance with its ±, and fair odds both ways.
- **Model Health.** The match holdout against FiveThirtyEight and a coin, the
  draw backtest against everyone equal with its interval, title-chance
  calibration, and what the model does not know.

Every value goes through `EDSimUI.esc`.

---

## 8. Known limitations

1. **No court surface.** ESPN does not carry it, so one rating covers clay,
   grass and hard courts. A clay or grass specialist is misjudged elsewhere.
2. **Not modelled:** injuries, fitness, travel, and withdrawals after the
   scoreboard was read. A match in progress is priced from before its first
   ball.
3. **A draw needs its order.** Draws whose Wikipedia article is not filled in
   yet are simulated only from the semifinals on. Before that, their matches
   appear under Matches.
4. **Frozen ratings.** A simulated win does not raise a rating.
5. **No set scores.** Only who wins is simulated (§3).
6. **Round robin.** The ATP and WTA Finals group stages are not simulated.
7. **Never compared with closing prices.**
8. **Noise only.** The ± is simulation noise, never model accuracy.

---

## 9. Reproduce

```bash
node simulator/src/cli/fetch_sports_data.ts --what tennis    # on a GitHub runner (ESPN, Wikipedia)
npm run sim:tennis:study                                      # the study and the backtest (about 15 s)
npm run sim:tennis:test                                       # 55 + 27 checks
node simulator/src/cli/run.ts --sport tennis --offline --dry-run --runs 20000
```
