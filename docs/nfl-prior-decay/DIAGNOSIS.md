# NFL prior-season weighting — diagnosis (Week 7, KC @ SEA)

**Written before any model change.** Nothing in this file changed a weight, a feature or a served number.
Every figure is reproduced by one read-only script:

```
node tools/football/fetch_nfl_feeds.js --season 2026      # caches nflverse games.csv (closing consensus)
node tools/football/nfl_prior_diagnosis.js --md           # -> football/validation/nfl_prior_diagnosis.json
```

The script rebuilds the served rating state the way the board does: `football/nfl_model.js` from the
`edgedesk_nfl_v2.1.0` seeds, one season break, then every completed 2026 game through the one absorb
path, in the board's order. Each game is priced **pregame**, from a state holding exactly the games that
kicked off before it. For KC @ SEA the replay reproduces the published card to the cent: SEA by
**4.37588444599499**, **65.83%** (`football/nfl/slate.json` `model_home_margin_exact` 4.375884).

Beside the served model, the script runs the **same arithmetic on 2026 data only**. Every team prior,
every club QB level and every quarterback value is zeroed before Week 1. The league means are kept,
and then the same 2026 games are absorbed. That is what "this chip on 2026 data only" means below.

**Market.** The closing consensus from nflverse `games.csv`, de-vigged from its moneylines. A game not yet
final reads its latest line. Kalshi closes live only in Supabase (`kalshi_closing_snapshot`) and are not
in this repository. For KC @ SEA the two agree within 0.2 points: consensus −155/+130 de-vigs to
**58.3%**, against Kalshi's 58.5%.

---

## 0. Answers

1. **The suspicion is right for team strength.**
   - The card's base-strength row (SEA +2.71) is **+3.73 from the 2025 prior and −1.02 from 2026**.
   - The prior holds **70% of the weight** in that row's inputs after 5–6 games.
   - On 2026 data alone, the row is **KC +1.35**: a 4.06-point swing.
2. **The "Seahawks #2 vs #7 in overall efficiency" chip is mostly 2025.**
   - The ranks come from the blended ratings, which are 53% (SEA) and 59% (KC) carried 2025 prior on the EPA features.
   - Ranked on the 2026 opponent-adjusted means alone, the order **reverses: KC #3, SEA #8**.
   - On the 2025 prior alone it is SEA #1, KC #17.
3. **The QB chip is per-player, but it does not carry the quarterback's quality.** It carries the
   starter's distance from his own club's running QB level.
   - Darnold's 2026 decline already moved his value from +0.132 to −0.062 (EPA/dropback above league).
   - That is most of the chip's KC +1.78.
   - What the chip does not show: most of a regular starter's quality lives in the **team** pass, EPA and
     points ratings. Those are 53–73% 2025 at Week 7, so Darnold's 2025 season is still inside SEA's team
     strength.
   - As the club level catches up (α = 0.10 per game), the QB chip shrinks toward zero while the team
     ratings are still half 2025. That is the under-reaction.
4. **Large gaps are common, and they do not earn closing-line value.**
   - **62 of 91** published cards in Weeks 2–7, and **60 of 107** v2.1 replays in Weeks 1–7, sit more than
     5 points of win probability from the close.
   - The largest row pushing toward the model's side is **base team strength in 37 of the 60** replays.
   - On the 62 published cards with a large gap, spread CLV (card's price lock → close) is +19 / 0 26 /
     −14, mean **+0.05 pts**. Moneyline CLV is +31 / 0 5 / −26, mean **−0.03 pp**.
   - In short, the market did not move toward these cards.
5. **Do not simply delete the prior.** Over the 102 played 2026 games the 2026-only replay is clearly
   worse: Brier **0.2519** against 0.2344 for the served model and 0.2380 for the close.
   - The fix to test is the *shape* of the decay and how QB play enters it (Step 3).
   - Turning the prior off is not the fix.
6. **One input is stale and wrong: the schedule feed's quarterback ids for completed games.**
   - nflverse `games.csv` still names **Drew Lock** as Seattle's quarterback for Weeks 3–6. Sam Darnold
     took every dropback of those games.
   - The board's own regime line reads that feed, so tonight's KC @ SEA board says "SEA: regular starter
     (Drew Lock) out".
   - The published SEA cards for Weeks 4 and 5 priced Lock: SF @ SEA 53.3% with Lock, 62.2% with Darnold.
   - It does not move KC @ SEA's number: the feed names Darnold for Week 7, and the model's own credit
     reads the game log. Fixed as a bug in Step 2.

---

## 1. How the two chips are computed

### 1.1 Team Strength

| | |
|---|---|
| Chip text | `lib/edgedesk_game_snapshot.js` `S.insights` (TEAM STRENGTH): the **ranks** of `net_epa` = `off_epa_play − def_epa_play` that the slate publishes per club (`football/nfl/slate.json` `teams[code].ranks.net_epa`, from the served state's blended ratings) |
| Chip effect label (`SEA +2.7`) | the card's **base-strength row** (`S.effectOf` → `EFFECT_TERMS.nfl.strength`), which is `net_pts_fix` (scoring margin rating, home − away) + `net_epa`. For this game it is **93% `net_pts_fix`** (2.51 of 2.71), so the chip's words (EPA ranks) and its number (mostly points) describe different inputs |
| Sources | nflverse `stats_team_week` (team EPA per play, pass EPA per dropback, rush EPA per carry), nflverse `games.csv` (scores) |
| Window | each rating = `w(n) · p + (1 − w(n)) · S/W`. Here `p` = **0.8 × the club's end-of-2025 rating** (2025 regular + postseason), `S/W` = this season's opponent-adjusted games, recency-weighted, and `n` = **games the club has played this season** |
| Decay | geometric: `w(n) = 0.9^n` for EPA ratings, `0.94^n` for points ratings (`football/nfl_params_v2.js` `cfg.prior`, unchanged from v1; the round-1 grid of 45 geometric and 288 hyperbolic settings kept it, `football/research/nfl_v2/RESULTS.md`) |

### 1.2 Quarterback

| | |
|---|---|
| Chip | the card's quarterback row = `qb_adj_diff × 12.087` + `qb_out_diff × −1.778` |
| Source | nflverse `stats_player_week` QB lines (`football/nfl/qb_games_2026.csv`). Each team-game credits the passer with the **most dropbacks**. His `dev` = EPA per dropback − league mean |
| Player value | `v` = a **career** EWMA of `dev`, α = 0.18 per credited start, never reset at a season break. It is shrunk toward −0.16 with 6 pseudo-starts: `qbEff = v·n/(n+6) − 0.16·6/(n+6)` |
| Club level | `teamQb` = EWMA of its credited starters' `qbEff`, α = 0.10, **carried × 0.8** at the season break |
| Term | `qb_adj = qbEff(starter) − teamQb(club)`, home minus away |
| Starter priced | the schedule feed's `home_qb_id` / `away_qb_id`, replaced by the depth chart (RECONCILED) or the injury report (OUT / DOUBTFUL) when the slate build can confirm it |
| Per-player or team? | **Both, and that is the problem.** The chip is per-player, but only as a deviation from the club's running level. A regular starter's quality is mostly carried by the team ratings (pass EPA, EPA per play, points), with the prior weights of §1.3 |

### 1.3 How the weight shifts by week (exact, by games played)

| games played | EPA ratings: 2025 / 2026 | points ratings: 2025 / 2026 | a QB's own value: before / this season | club QB level: carried / this season |
|---|---|---|---|---|
| 0 | 100% / 0% | 100% / 0% | 100% / 0% | 100% / 0% |
| 2 | 81% / 19% | 88% / 12% | 67% / 33% | 81% / 19% |
| 4 | 66% / 34% | 78% / 22% | 45% / 55% | 66% / 34% |
| **5 (KC)** | **59% / 41%** | **73% / 27%** | **37% / 63%** | **59% / 41%** |
| **6 (SEA)** | **53% / 47%** | **69% / 31%** | 30% / 70% | **53% / 47%** |
| 8 | 43% / 57% | 61% / 39% | 20% / 80% | 43% / 57% |
| 12 | 28% / 72% | 48% / 52% | 9% / 91% | 28% / 72% |
| 17 | 17% / 83% | 35% / 65% | 3% / 97% | 17% / 83% |

The carried prior is itself 0.8 × the 2025 rating, so 20% of last season is regressed to league average
before Week 1. A bye does not decay anything: the clock is games played, not weeks.

---

## 2. KC @ SEA, decomposed

**Card:** SEA by 4.38, 65.83%, `edgedesk_nfl_v2.1.0`. **2026 only:** SEA by 1.03, **51.31%**.
**Close:** SEA −3, 58.3% no-vig (Kalshi 58.5%).

### 2.1 Each row: raw input, points, where the points come from, and its value on 2026 data alone

Points are home-positive (SEA +, KC −).

| row | raw input (home − away) × weight | points | from the 2025 prior | from 2026 | data window | **2026 only** |
|---|---|---|---|---|---|---|
| Base team strength | `net_pts_fix` 3.849 × 0.6527 = 2.51; `net_epa` 0.0452 × 4.345 = 0.20 | **+2.71** | **+3.73** | **−1.02** | **2025 70% / 2026 30%** | **−1.35** |
| Passing | `net_pass` 0.1794 × 1.353 | +0.24 | +0.25 | −0.00 | 2025 56% / 2026 44% | −0.04 |
| Rushing | `net_rush` −0.1101 × 3.995 | −0.44 | −0.02 | −0.42 | 2025 56% / 2026 44% | −0.44 |
| Quarterback | `qb_adj_diff` −0.1473 × 12.087 (+ `qb_out_diff` 0) | **−1.78** | — | — | 2025 49% / 2026 51% | −0.79 |
| Home field | intercepts 2.599 + 0.211 + week 7/18 × 0.714 | +3.09 | — | — | fitted constant | +3.09 |
| Rest / travel | rest 10 v 7: 0.4286 × 1.308 | +0.56 | — | — | schedule fact | +0.56 |
| **Margin** | | **+4.38** | | | | **+1.03** |

**Where base strength's points come from.** Values are opponent-adjusted, per game, above league average.

| | SEA rating | SEA carried 2025 prior (weight) | SEA 2026 mean | KC rating | KC carried 2025 prior (weight) | KC 2026 mean |
|---|---|---|---|---|---|---|
| points for | +3.45 | +3.89 (0.69) | +2.49 | −0.12 | −1.75 (0.73) | **+4.37** |
| points against | −3.69 | −4.51 (0.69) | −1.87 | −3.42 | −2.78 (0.73) | **−5.17** |
| **net points** | **+7.15** | **+8.40** | **+4.36** | **+3.30** | **+1.03** | **+9.55** |
| EPA/play off − def | +0.127 | +0.185 | +0.061 | +0.082 | −0.004 | **+0.205** |
| pass EPA/db (offense) | +0.035 | +0.092 | −0.029 | +0.002 | −0.085 | **+0.127** |

By 2026 scoring margin, KC (+9.5 a game) is the better team. The card has SEA ahead by 3.8 points of
rating because 69–73% of that rating is still 2025.

### 2.2 The Team Strength chip under three windows

| `net_epa` rank of 32 | SEA | KC |
|---|---|---|
| as served (blend: 53% / 59% 2025) — **the chip** | **#2** | **#7** |
| 2025 carried prior alone | #1 | #17 |
| 2026 opponent-adjusted means alone (served state's `S/W`) | **#8** | **#3** |
| cold 2026-only replay | #11 | #2 |

### 2.3 The quarterbacks

| | Sam Darnold (SEA) | Patrick Mahomes (KC) |
|---|---|---|
| 2025 (nflverse, incl. postseason) | 66.7%, 8.31 Y/A, +0.164 EPA/db | 62.7%, 7.15 Y/A, +0.127 EPA/db |
| 2026 to date (Weeks 1–6) | **60.4%, 6.93 Y/A, 7 INT, −0.135 EPA/db** (163 db) | 66.5%, 8.28 Y/A, 3 INT, **+0.174 EPA/db** (164 db) |
| value `v` at end of 2025 → now | +0.132 → **−0.062** | −0.002 → +0.076 |
| credited starts this season | 4 (Week 1: 3 dropbacks, not credited) | 5 |
| `qbEff` | −0.068 | +0.067 |
| club QB level (carried 0.8 × end-2025 → now) | +0.064 → **+0.036** | +0.004 → +0.024 |
| `qb_adj` | **−0.1035** (−1.25 pts) | +0.0438 (+0.53 pts) |

Darnold has 7 INT; Herbert and Maye have 8 in the same feed.

The chip's KC +1.78 is mostly Darnold's own collapse already priced: his value fell 0.19 EPA/db in four
starts. What the chip cannot carry is the part of SEA's 2025 passing game that sits in SEA's **team**
ratings: pass EPA prior +0.092 at weight 0.53, and points prior +8.40 at 0.69. On 2026 data alone the QB
row is smaller (−0.79). The club level that Darnold is measured against has itself fallen, and both
quarterbacks' short 2026 histories are shrunk hard toward −0.16. In other words, the QB term as built
cannot hold a quarterback's 2026 play once the club level catches up. Only the team ratings can, at the
slow rate in §1.3.

---

## 3. Every Week 1–7 card more than 5 points of win probability from the close

**Flag:** `P` = the **published** card (`record/football/nfl_2026.json`, the price-locked pick, else the first
publication; Weeks 2–7, model version as published) is beyond 5 pp. `R` = the **v2.1 replay** is.

**Top chip:** the card row with the largest contribution toward the model's side of the close, from the
v2.1 replay's own rows. Home field is named only when no other row pushes that way: it is one constant
for every home team. The published Weeks 2–6 cards were the `edgedesk_football_v1.0.0` engine, whose rows
were not archived.

**CLV:** spread points the market moved toward the card's side from its price lock to the close (the
record's graded `clv_pick`), and the same for the de-vigged moneyline in percentage points.
`PREGAME` / `awaiting final` = not graded yet. Week 1 has no published record.

| wk | game | flag | published (version) | v2.1 replay | 2026 only | close no-vig | gap pub / replay (pp) | top chip toward model (v2.1) | chip window | chip on 2026 only | spread CLV, pts (lock → close) | ML CLV, pp (lock → close) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | NYJ @ TEN | R | — (no record) | 70.9% | 53.8% | 51.7% | — / +19.1 | Quarterback +2.87 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | NE @ SEA | R | — (no record) | 77.0% | 57.9% | 60.0% | — / +17.1 | Base team strength +2.90 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | WAS @ PHI | R | — (no record) | 80.9% | 52.0% | 68.1% | — / +12.9 | Base team strength +4.68 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | DAL @ NYG | R | — (no record) | 51.1% | 53.7% | 40.0% | — / +11.0 | Rushing +0.15 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | MIA @ LV | R | — (no record) | 50.0% | 53.1% | 60.4% | — / -10.4 | Base team strength -2.97 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | DEN @ KC | R | — (no record) | 48.6% | 52.0% | 54.3% | — / -5.7 | Base team strength -2.15 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | CLE @ JAX | R | — (no record) | 84.7% | 53.8% | 79.1% | — / +5.5 | Base team strength +5.82 | 2025 100% / 2026 0% | 0.00 | — | — |
| 1 | BAL @ IND | R | — (no record) | 45.9% | 54.9% | 40.7% | — / +5.2 | Home field +2.85 | — | +2.85 | — | — |
| 2 | JAX @ DEN | PR | 44.9% (football_v1.0.0) | 39.2% | 49.2% | 57.2% | -12.3 / -18.0 | Quarterback -3.08 | 2025 86% / 2026 14% | -0.35 | +0.5 | +1.1 |
| 2 | CAR @ ATL | PR | 60.5% (football_v1.0.0) | 53.7% | 50.1% | 41.7% | +18.7 / +12.0 | Base team strength +1.72 | 2025 93% / 2026 7% | +0.65 | 0.0 | -3.2 |
| 2 | GB @ NYJ | PR | 26.5% (football_v1.0.0) | 27.2% | 66.2% | 37.8% | -11.3 / -10.5 | Base team strength -6.33 | 2025 93% / 2026 7% | +1.35 | -1.0 | -2.2 |
| 2 | CIN @ HOU | PR | 71.2% (football_v1.0.0) | 67.3% | 53.7% | 57.2% | +14.0 / +10.1 | Base team strength +3.04 | 2025 93% / 2026 7% | -0.54 | +0.5 | +0.9 |
| 2 | PIT @ NE | PR | 81.2% (football_v1.0.0) | 75.7% | 60.4% | 66.4% | +14.8 / +9.3 | Base team strength +3.37 | 2025 93% / 2026 7% | -0.51 | 0.0 | +0.6 |
| 2 | SEA @ ARI | PR | 27.3% (football_v1.0.0) | 27.8% | 50.9% | 34.3% | -7.0 / -6.4 | Base team strength -8.96 | 2025 94% / 2026 6% | +0.43 | 0.0 | +1.3 |
| 2 | MIA @ SF | P | 72.9% (football_v1.0.0) | 82.4% | 66.3% | 86.3% | -13.4 / -3.9 | Context (venue, division) -0.73 | — | -0.73 | +1.0 | +0.5 |
| 2 | NO @ BAL | P | 69.2% (football_v1.0.0) | 78.7% | 62.8% | 75.7% | -6.5 / +3.0 | Base team strength +5.17 | 2025 94% / 2026 6% | +0.96 | -1.0 | +1.4 |
| 2 | IND @ KC | P | 52.5% (football_v1.0.0) | 67.0% | 65.5% | 69.6% | -17.0 / -2.6 | Context (venue, division) -0.73 | — | -0.73 | +0.5 | +1.4 |
| 2 | CLE @ TB | P | 62.9% (football_v1.0.0) | 75.2% | 60.0% | 77.7% | -14.8 / -2.5 | Context (venue, division) -0.73 | — | -0.73 | 0.0 | -1.1 |
| 3 | NYJ @ DET | PR | 92.3% (football_v1.0.0) | 88.1% | 54.0% | 73.4% | +18.9 / +14.8 | Base team strength +7.84 | 2025 87% / 2026 13% | -0.82 | +0.5 | -0.7 |
| 3 | PHI @ CHI | PR | 58.5% (football_v1.0.0) | 48.4% | 50.2% | 36.3% | +22.2 / +12.1 | Rushing +0.30 | 2025 81% / 2026 19% | +0.22 | 0.0 | -15.4 |
| 3 | KC @ MIA | PR | 44.4% (football_v1.0.0) | 27.6% | 49.2% | 17.8% | +26.6 / +9.9 | Home field +2.93 | — | +2.93 | +1.5 | -3.6 |
| 3 | LAC @ BUF | PR | 86.4% (football_v1.0.0) | 83.3% | 68.0% | 73.4% | +13.1 / +9.9 | Base team strength +5.51 | 2025 87% / 2026 13% | +1.79 | 0.0 | +7.6 |
| 3 | TEN @ NYG | PR | 71.8% (football_v1.0.0) | 63.9% | 53.7% | 54.3% | +17.5 / +9.6 | Base team strength +3.54 | 2025 88% / 2026 13% | -0.16 | 0.0 | -13.8 |
| 3 | LV @ NO | PR | 75.6% (football_v1.0.0) | 72.7% | 53.0% | 63.1% | +12.6 / +9.6 | Base team strength +2.48 | 2025 87% / 2026 13% | -0.77 | +0.5 | +3.8 |
| 3 | CIN @ PIT | R | 42.8% (football_v1.0.0) | 46.2% | 49.7% | 38.4% | +4.4 / +7.9 | Home field +2.93 | — | +2.93 | 0.0 | +6.5 |
| 3 | BAL @ DAL | PR | 46.7% (football_v1.0.0) | 32.3% | 49.6% | 39.6% | +7.0 / -7.3 | Base team strength -4.05 | 2025 87% / 2026 13% | -0.15 | 0.0 | -2.1 |
| 3 | NE @ JAX | P | 64.9% (football_v1.0.0) | 64.0% | 55.3% | 59.3% | +5.6 / +4.7 | Quarterback +2.68 | 2025 74% / 2026 26% | +0.31 | +0.5 | +4.2 |
| 3 | ARI @ SF | P | 69.8% (football_v1.0.0) | 80.1% | 66.9% | 76.6% | -6.7 / +3.5 | Base team strength +5.81 | 2025 88% / 2026 12% | +2.47 | +1.0 | +2.5 |
| 3 | HOU @ IND | P | 56.8% (football_v1.0.0) | 50.0% | 53.8% | 46.8% | +10.0 / +3.2 | Quarterback +0.48 | 2025 74% / 2026 26% | +0.03 | +1.0 | +1.9 |
| 3 | CAR @ CLE | P | 53.3% (football_v1.0.0) | 46.9% | 50.1% | 44.9% | +8.5 / +2.1 | Rushing +0.04 | 2025 81% / 2026 19% | -0.10 | 0.0 | 0.0 |
| 3 | SEA @ WAS | P | 29.8% (football_v1.0.0) | 23.8% | 49.6% | 22.9% | +7.0 / +1.0 | Quarterback +0.91 | 2025 74% / 2026 26% | -0.37 | -2.0 | +22.0 |
| 4 | NYJ @ CHI | PR | 86.6% (football_v1.0.0) | 79.7% | 51.8% | 63.1% | +23.5 / +16.6 | Base team strength +7.82 | 2025 82% / 2026 18% | +1.47 | 0.0 | +3.8 |
| 4 | IND @ WAS | PR | 39.6% (football_v1.0.0) | 48.3% | 47.0% | 33.1% | +6.5 / +15.2 | Quarterback +0.55 | 2025 71% / 2026 29% | -1.92 | 0.0 | -2.4 |
| 4 | LA @ PHI | PR | 46.8% (football_v1.0.0) | 47.9% | 51.1% | 36.3% | +10.5 / +11.6 | Rushing +0.16 | 2025 73% / 2026 27% | +0.21 | -0.5 | -8.6 |
| 4 | DET @ CAR | R | 37.0% (football_v1.0.0) | 45.3% | 54.1% | 33.6% | +3.4 / +11.6 | Home field +2.97 | — | +2.97 | +1.0 | +8.1 |
| 4 | JAX @ CIN | PR | 45.0% (football_v1.0.0) | 47.0% | 52.0% | 57.2% | -12.3 / -10.2 | Base team strength -4.13 | 2025 82% / 2026 18% | -1.33 | 0.0 | +2.1 |
| 4 | DEN @ SF | R | 60.2% (football_v1.0.0) | 68.0% | 71.3% | 60.0% | +0.3 / +8.0 | Quarterback +2.66 | 2025 64% / 2026 36% | +1.22 | 0.0 | +3.7 |
| 4 | LAC @ SEA | PR | 80.6% (football_v1.0.0) | 82.0% | 71.1% | 74.4% | +6.2 / +7.6 | Base team strength +7.43 | 2025 82% / 2026 18% | +2.52 | +0.5 | +3.5 |
| 4 | GB @ TB | R | 46.1% (football_v1.0.0) | 48.0% | 51.0% | 41.7% | +4.4 / +6.4 | Rushing +0.67 | 2025 73% / 2026 27% | +0.55 | +0.5 | +6.6 |
| 4 | ARI @ NYG | PR | 58.3% (football_v1.0.0) | 51.1% | 54.5% | 44.9% | +13.4 / +6.3 | Base team strength +0.97 | 2025 82% / 2026 18% | +0.09 | -1.0 | -11.5 |
| 4 | DAL @ HOU | PR | 67.7% (football_v1.0.0) | 64.6% | 50.6% | 58.3% | +9.4 / +6.3 | Base team strength +2.85 | 2025 81% / 2026 19% | -1.22 | +0.5 | -1.0 |
| 4 | NE @ BUF | R | 74.9% (football_v1.0.0) | 69.3% | 65.3% | 74.4% | +0.5 / -5.1 | Context (venue, division) -1.51 | — | -1.51 | 0.0 | +5.9 |
| 4 | ATL @ NO | P | 62.8% (football_v1.0.0) | 56.3% | 64.5% | 51.7% | +11.1 / +4.6 | Quarterback +1.03 | 2025 71% / 2026 29% | +1.95 | -1.0 | -10.5 |
| 4 | PIT @ CLE | P | 52.8% (football_v1.0.0) | 45.5% | 51.1% | 42.8% | +10.0 / +2.7 | Home field +2.97 | — | +2.97 | 0.0 | 0.0 |
| 4 | MIA @ MIN | P | 73.1% (football_v1.0.0) | 79.3% | 65.4% | 80.8% | -7.7 / -1.5 | Quarterback -1.31 | 2025 71% / 2026 29% | -2.11 | 0.0 | +3.8 |
| 5 | LV @ NE | PR | 79.3% (football_v1.0.0) | 74.5% | 51.1% | 61.6% | +17.7 / +12.8 | Base team strength +5.81 | 2025 76% / 2026 24% | -1.66 | 0.0 | -1.4 |
| 5 | CIN @ MIA | PR | 40.8% (football_v1.0.0) | 36.1% | 49.9% | 25.2% | +15.5 / +10.9 | Rushing +0.00 | 2025 66% / 2026 34% | +0.23 | 0.0 | 0.0 |
| 5 | DEN @ LAC | PR | 45.8% (football_v1.0.0) | 47.3% | 50.7% | 36.9% | +8.9 / +10.4 | Rushing +0.44 | 2025 66% / 2026 34% | +0.17 | 0.0 | -0.8 |
| 5 | TB @ DAL | PR | 70.5% (football_v1.0.0) | 71.4% | 69.6% | 80.8% | -10.3 / -9.4 | Rushing -0.62 | 2025 66% / 2026 34% | -0.20 | 0.0 | -0.4 |
| 5 | NYG @ WAS | PR | 55.6% (football_v1.0.0) | 52.3% | 51.9% | 61.6% | -6.0 / -9.4 | Base team strength -0.81 | 2025 78% / 2026 22% | -1.29 | 0.0 | +0.6 |
| 5 | BUF @ LA | PR | 47.7% (football_v1.0.0) | 52.8% | 53.7% | 62.3% | -14.5 / -9.4 | Base team strength -0.50 | 2025 77% / 2026 23% | -0.37 | -1.0 | -5.9 |
| 5 | CLE @ NYJ | PR | 36.8% (football_v1.0.0) | 48.7% | 55.2% | 56.4% | -19.6 / -7.6 | Base team strength -2.45 | 2025 76% / 2026 24% | +0.12 | -1.0 | -0.9 |
| 5 | BAL @ ATL | PR | 49.4% (football_v1.0.0) | 53.3% | 68.1% | 60.9% | -11.5 / -7.6 | Base team strength -3.43 | 2025 77% / 2026 23% | -0.53 | 0.0 | 0.0 |
| 5 | SF @ SEA | PR | 65.1% (football_v1.0.0) | 53.3% | 47.1% | 60.0% | +5.1 / -6.6 | Quarterback -3.65 | 2025 61% / 2026 39% | -2.73 | +0.5 | +2.8 |
| 5 | CHI @ GB | R | 48.7% (football_v1.0.0) | 52.0% | 50.2% | 46.8% | +1.9 / +5.2 | Quarterback +3.03 | 2025 65% / 2026 35% | +2.23 | +1.5 | +5.0 |
| 5 | MIN @ NO | P | 59.5% (football_v1.0.0) | 48.3% | 50.0% | 43.6% | +15.8 / +4.6 | Quarterback +1.91 | 2025 61% / 2026 39% | +0.42 | -1.0 | -2.1 |
| 5 | PHI @ JAX | P | 67.5% (football_v1.0.0) | 74.9% | 67.4% | 76.0% | -8.5 / -1.1 | — | — | — | -2.0 | +9.1 |
| 5 | IND @ PIT | P | 52.7% (football_v1.0.0) | 59.7% | 61.3% | 59.3% | -6.6 / +0.4 | Rest / travel +0.56 | — | +0.56 | -0.5 | -4.2 |
| 6 | DAL @ GB | PR | 58.1% (football_v1.0.0) | 66.1% | 54.5% | 48.9% | +9.2 / +17.2 | Base team strength +1.77 | 2025 70% / 2026 30% | +0.11 | -3.0 | -2.2 |
| 6 | NO @ NYG | R | 50.6% (football_v1.0.0) | 66.5% | 66.4% | 50.4% | +0.2 / +16.1 | Base team strength +1.28 | 2025 73% / 2026 27% | +1.34 | 0.0 | +3.0 |
| 6 | NYJ @ NE | PR | 91.7% (football_v1.0.0) | 85.7% | 65.4% | 74.4% | +17.3 / +11.3 | Base team strength +8.54 | 2025 72% / 2026 28% | +0.99 | +0.5 | +1.1 |
| 6 | CAR @ PHI | PR | 52.7% (football_v1.0.0) | 49.9% | 38.6% | 40.7% | +12.0 / +9.2 | Base team strength +2.58 | 2025 76% / 2026 25% | -1.49 | 0.0 | +0.6 |
| 6 | SEA @ DEN | R | 46.2% (football_v1.0.0) | 49.9% | 54.0% | 41.7% | +4.5 / +8.2 | Quarterback +1.00 | 2025 56% / 2026 44% | +1.33 | 0.0 | -1.9 |
| 6 | BAL @ CLE | PR | 33.0% (football_v1.0.0) | 47.5% | 53.6% | 39.6% | -6.6 / +7.8 | Quarterback +3.09 | 2025 59% / 2026 41% | +2.34 | 0.0 | +0.4 |
| 6 | WAS @ SF | R | 76.6% (football_v1.0.0) | 83.9% | 78.5% | 76.6% | 0.0 / +7.3 | Base team strength +5.92 | 2025 71% / 2026 29% | +3.85 | 0.0 | +1.6 |
| 6 | PIT @ TB | PR | 55.1% (football_v1.0.0) | 50.0% | 51.8% | 43.6% | +11.5 / +6.4 | Rest / travel +0.56 | — | +0.56 | +0.5 | +1.9 |
| 6 | TEN @ IND | PR | 80.3% (football_v1.0.0) | 77.9% | 65.4% | 71.8% | +8.5 / +6.1 | Base team strength +5.66 | 2025 72% / 2026 28% | +1.63 | -0.5 | -2.3 |
| 6 | CHI @ ATL | P | 57.9% (football_v1.0.0) | 50.2% | 66.5% | 48.3% | +9.7 / +1.9 | Rushing +0.26 | 2025 59% / 2026 41% | +0.39 | 0.0 | +0.4 |
| 6 | BUF @ LV | P | 23.0% (football_v1.0.0) | 30.6% | 51.6% | 32.5% | -9.5 / -1.9 | Base team strength -8.01 | 2025 72% / 2026 28% | -0.95 | +1.0 | -1.0 |
| 6 | ARI @ LA | P | 78.4% (football_v1.0.0) | 83.8% | 67.4% | 84.0% | -5.6 / -0.2 | Context (venue, division) -1.10 | — | -1.10 | 0.0 | +2.3 |
| 6 | LAC @ KC | P | 67.0% (football_v1.0.0) | 78.9% | 77.5% | 78.7% | -11.6 / +0.2 | Base team strength +2.95 | 2025 75% / 2026 25% | +3.29 | +1.0 | -2.7 |
| 7 | DAL @ PHI | PR | 57.7% (nfl_v2.1.0) | 57.7% | 50.0% | 34.3% | +23.4 / +23.4 | Base team strength +1.93 | 2025 68% / 2026 32% | -0.74 | pregame | 0.0 |
| 7 | MIA @ NYJ | PR | 51.8% (nfl_v2.1.0) | 51.8% | 62.6% | 65.8% | -14.0 / -14.0 | Rest / travel -1.78 | — | -1.78 | +1.0 | +1.1 |
| 7 | CIN @ BAL | PR | 46.9% (nfl_v2.1.0) | 48.5% | 47.4% | 40.7% | +6.3 / +7.9 | Base team strength +1.49 | 2025 70% / 2026 31% | +0.20 | +6.0 | +16.5 |
| 7 | NE @ CHI | PR | 50.0% (nfl_v2.1.0) | 50.8% | 52.5% | 58.3% | -8.3 / -7.5 | Base team strength -2.00 | 2025 67% / 2026 33% | -0.19 | 0.0 | -5.7 |
| 7 | KC @ SEA | PR | 65.8% (nfl_v2.1.0) | 65.8% | 51.3% | 58.3% | +7.5 / +7.5 | Base team strength +2.71 | 2025 70% / 2026 30% | -1.35 | pregame | +1.1 |
| 7 | IND @ MIN | PR | 79.5% (nfl_v2.1.0) | 79.5% | 72.2% | 73.4% | +6.1 / +6.1 | Base team strength +3.60 | 2025 69% / 2026 31% | +2.61 | 0.0 | +2.0 |
| 7 | TB @ CAR | PR | 67.8% (nfl_v2.1.0) | 65.9% | 72.0% | 60.0% | +7.8 / +5.9 | Quarterback +2.17 | 2025 51% / 2026 49% | +2.74 | -0.5 | -2.3 |
| 7 | GB @ DET | PR | 68.1% (nfl_v2.1.0) | 68.1% | 65.1% | 63.1% | +5.0 / +5.0 | Base team strength +1.57 | 2025 70% / 2026 30% | +0.36 | awaiting final | +3.8 |

**By week.** Prior share = the mean data window of that row over the week's games.

| week | games | replay cards > 5 pp | prior share: base strength / passing / QB | mean abs gap, replay / 2026 only (pp) | Brier, replay / 2026 only / close (n) |
|---|---|---|---|---|---|
| 1 | 16 | 8 | 100% / 100% / 100% | 6.5 / 11.7 | 0.2186 / 0.2382 / 0.2136 (16) |
| 2 | 16 | 6 | 93% / 90% / 86% | 5.694 / 14.669 | 0.2461 / 0.2572 / 0.2306 (16) |
| 3 | 16 | 8 | 87% / 81% / 76% | 6.487 / 10.1 | 0.2304 / 0.2382 / 0.2541 (16) |
| 4 | 16 | 11 | 81% / 73% / 66% | 7.244 / 11.725 | 0.2067 / 0.228 / 0.2193 (16) |
| 5 | 15 | 10 | 77% / 66% / 58% | 6.793 / 11.053 | 0.2098 / 0.264 / 0.2267 (14) |
| 6 | 14 | 9 | 72% / 60% / 52% | 6.986 / 9.414 | 0.2638 / 0.2573 / 0.2585 (14) |
| 7 | 14 | 8 | 68% / 54% / 47% | 6.807 / 7.85 | 0.2902 / 0.3061 / 0.2848 (9) |

**Summary**

| | published cards (Weeks 2–7) | v2.1 replay (Weeks 1–7) |
|---|---|---|
| beyond 5 pp | 62 of 91 | 60 of 107 |
| top chip | base strength 34, QB 11, rushing 7, context 4, rest/travel 3, home field 2, none 1 | base strength **37**, QB 9, rushing 7, home field 4, rest/travel 2, context 1 |
| spread CLV, lock → close (flagged cards) | +19 / 0 26 / −14, mean **+0.05 pts** | — |
| moneyline CLV, lock → close (flagged cards) | +31 / 0 5 / −26, mean **−0.03 pp** | +28 / 0 3 / −21, mean +0.16 pp |
| all published cards, spread CLV | +32 / 0 38 / −16, mean +0.20 pts (n 86) | |

**Reading it.**
- **CLV.** The large-gap cards show no consistent closing-line value. About as many moved against the
  card as toward it, with a mean within a few hundredths of zero.
- **KC @ SEA.** The card shows +0.5 pts (−2.5 → −3) and +0.9 pp since its lock. That is real, but it is
  small next to a 7.4-point gap.
- **Where the gaps are.** They cluster where base strength is ≥ 70% 2025 and a club's 2026 differs
  sharply from its 2025: NYJ @ CHI, LV @ NE, NYJ @ NE, NYJ @ DET, KC @ SEA.
- **Another cluster.** Starter changes the QB row prices weakly (DAL @ PHI with Hurts out: +23 pp).
- **Weeks 2–6.** These published cards also carry the old v1.0.0 engine's defects (frozen defence,
  frozen QB layer; `audit_report.md`), so their gaps mix two causes.

### 3.1 What the 2026-only replay says, and why it is not the answer

| 102 played 2026 games (reported only; the live season decides nothing) | served v2.1 | 2026 only | close |
|---|---|---|---|
| Brier | **0.2344** | 0.2519 | 0.2380 |
| margin MAE | 9.86 | 9.67 | **9.41** |
| mean abs gap vs close (pp) | 6.63 | 11.01 | — |

The prior earns its place early: in Weeks 1–5 the 2026-only replay has the worse Brier in every week.
In Week 6 it is slightly better (0.2573 vs 0.2638), and in Week 7 worse again on 9 games. The two
converge around Week 6, which is where a faster decay should help. The case for Step 3 is a
**faster, QB-aware decay**, not no prior. Nothing in this table is a basis for a promotion: 2026 is the
live season.

---

## 4. Inputs checked for staleness

| input | season / freshness | verdict |
|---|---|---|
| team rows `football/nfl/stats_team_week_2026.csv` | 2026 through Week 7's afternoon games (102 absorbed in the slate) | current |
| QB game log `football/nfl/qb_games_2026.csv` | 2026, same games | current |
| seeds `football/nfl_params_v2.js` | end of 2025, trained through 2025 | right season |
| **schedule feed QB ids for completed games** (`games.csv` `home_qb_id` / `away_qb_id`) | **11 of 204 team-games name a quarterback who did not take the dropbacks.** The 4 that are plain stale pre-fills are SEA Weeks 3–6 (Lock named, Darnold played). The rest are in-game changes | **BUG** (Step 2). The board's start history (`fbNflQbStarts`) reads them, so the regime line, the "most starts" replacement starter and the record's SEA Weeks 3–6 cards all used Lock |
| injury report `football/injuries/nfl_2026.json` | latest week per club, file-level `retrieved_at` | per-player `date_modified` is dropped and practice status is read by nothing on the card. **Gap** (Step 2): designation and practice status become Observed (T0) inputs with source and time |
| starter check (`starter_check`) | depth chart published 2026-10-25 12:30Z | current; SEA and KC both AGREE |

No team or QB input reads the wrong season. The over-weighting of 2025 is the model's design (§1), not
stale data, and it is addressed only as an experimental model (Step 3). The v1/v2.1 weights are not
touched.

---

## 5. Hypotheses, checked

| hypothesis | verdict | evidence |
|---|---|---|
| Team strength over-weights 2025 | **Confirmed** | base strength 70% 2025 at Week 7; +3.73 prior vs −1.02 2026; 2026-only −1.35 |
| The "#2 vs #7" chip leans on 2025 | **Confirmed** | 53–59% 2025 weight; 2026 alone KC #3, SEA #8 |
| The QB chip under-reacts to 2026 QB play | **Partly** | Darnold's own value moved fast (α 0.18). The under-reaction is structural: QB quality sits in team ratings, which decay slowly, and the QB term nets against a club level that catches up |
| QB value is per-player | **Yes, relative to the club** | `qbEff(player) − teamQb(club)` |
| An input uses stale data | **Yes, one** | schedule-feed QB ids for completed games (SEA Weeks 3–6) |
| Large-gap cards earn CLV | **No** | mean +0.05 pts spread, −0.03 pp moneyline, split evenly |
