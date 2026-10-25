# UFC_SIMULATOR_NOTES — UFC fights and the title path

The engineering record of the UFC seat of the Simulator: what it simulates,
what it stands on, what was measured, and what it does not know. Shared engine,
database and reader: [`SIMULATOR_NOTES.md`](SIMULATOR_NOTES.md). Dates are UTC;
"retrieved" is 2026-10-23. The registry previously said "UFC — Coming Soon: no
season structure"; the owner asked for two things instead, and both are built:
every upcoming fight simulated 100,000 times, and, for every division, how
likely each fighter who is not champion is to become champion.

---

## 1. Status

| Area | State | Evidence |
|---|---|---|
| Fights: every booked bout, who wins, finish or decision, the round | Implemented, tested; **ACTIVE** | `simulator/src/sports/ufc/`, §3 |
| Fight model | The model loop's served UFC Elo **1.3.0** (EXPERIMENTAL; 2026-10-24: 1.1.0 plus a prior from the pre-UFC record and an age curve (1.2.0), then the age curve by division (1.3.0)), ported line for line; reproduces all 20 published p_a and `model.py` itself at full precision (every 2026-10 parameter too); 1.1.0 kept runnable and shown beside it | `elo.ts`, §2, §2a, §2b |
| Market disagreement guard | Every booked bout beside DraftKings' latest no-vig price; a gap over 8 points is "Model disagrees with market", with its likely reasons and no fair odds; never a signal (not certified) | `guard.ts`, §2a |
| Finish / decision / round | Measured point in time from every bout since 2014, chosen on 2016-2022, tested on 2023 on | `finish.ts`, §4 |
| Title path (12 months, every division) | Implemented, tested; **Estimated** (the matchmaking rule); title-fight pace MEASURED from Wikipedia's title history | `module.ts`, §5 |
| Champions and rankings | ufc.com/rankings in every run (page sha256 recorded and checked against the saved page); Wikipedia's incumbents and ESPN's title accolades agree | `inputs.ts`, §6 |
| Reader | Fights, Title Path and Model Health tabs | `lib/edgedesk_simulator_ufc.js`, §8 |
| Nightly | Every night (the feeds refresh daily at 09:41 UTC, before the 10:17 run); dispatchable | `cli/plan.ts`, `.github/workflows/simulator.yml` |
| Database | No change: the run uses the generic `sim_*` tables; per-bout and per-division numbers ride in `validation_summary.sport_summary` | `supabase/simulator.sql` unchanged |

---

## 2. The fight model

Who wins every simulated fight comes from the model the loop serves for UFC:
the walk-forward Elo `model_loop/adapters/ufc/model.py walk()` with the served
configuration from `docs/model-loop/ufc/versions.json`. Since 2026-10-24 that is
**1.3.0** (`SERVED (EXPERIMENTAL)`, config sha256 `430f205a…`): 1.2.0 with the age
curve fitted per division (§2b). 1.2.0 (`e6f03e29…`) is 1.1.0's Elo (k 64,
a 1.5x step for a fighter's first 3 bouts in the data, a 25% regression toward
1500 after 365 days or more out, scale 400, no calibration) plus two changes the
2026-10 study kept (§2a): each fighter starts from a **prior built from the pro
record before the first bout in the data** (`debut_offset` 25, `prior_rec` 150,
`prior_exp` −25: 1525 for a 10-2 record), and an **age curve** (−15 Elo a year past
32, on the price). 1.2.0 is the rollback target; 1.1.0 (`7aeca585…`) stays runnable:
every booked bout carries its 1.1.0 price beside the served one.

The facts both read (each fighter's date of birth from ESPN's athlete document;
the pre-UFC record, reconstructed as ESPN's record as of one stated time less every
later result in the data) are one committed file, `model_loop/data/ufc/fighter_facts.csv`,
which the loop and the port both read (`factors.py`, `factors.ts`).

The text below describes the 1.1.0 walk; the 1.2.0 and 1.3.0 walk (`model.py _walk_extended`,
`elo.ts walkExtended`) is the same with the prior and the age points (1.3.0: by the
bout's division) added, and the
port reproduces it at full precision (and with every other 2026-10 parameter on too:
`simulator/tests/ufc_elo.test.ts`).

`simulator/src/sports/ufc/elo.ts` ports the walk line for line (the simulator is
TypeScript with no runtime dependency): bouts in (start time, bout id as text)
order, every row priced from the ratings before it (cancelled and scheduled rows
too), the layoff regression **stored** when it is applied (so a cancelled row
regresses a rating and the regression persists, exactly as `rating()` does),
draws and no contests absorbed as s = 0.5 (ESPN marks both winner flags false),
bout counts and last-bout times moved only by absorbed finals. Measured on the
committed data (`model_loop/data/ufc/bouts.csv`, 6,932 bouts):

- every one of the **25 p_a** in `model_loop/published/ufc/current.json`
  (generated 2026-10-23T19:39:03Z) is reproduced to its four published
  decimals, with the same fighters and bout counts, and no scheduled bout in the
  file's 14-day window is missing (gate `model.reproduces`, every run);
- against `model.py walk()` itself (run by the test when python3 + pandas are
  present): every bout's price within **4.4e-16** and every one of 2,421
  ratings within 2.3e-13 (`simulator/tests/ufc_elo.test.ts`).

Bouts beyond the loop's 14-day window (UFC 334, UFC 335 …) are priced by the same
walk continued over the ESPN feed's scheduled rows at their dates: what the
served model will publish for them when they enter its window, unless a result
in between moves a rating. A debutant starts from the served model's prior (1.2.0 on:
from the pre-UFC record; 1500 under 1.0/1.1).

### 2a. The 2026-10 study and the disagreement guard

On UFC 333 the served 1.1.0 had Dvalishvili 54.6% (Kalshi about 41%) and Volkov
70.4% (Kalshi about 53%). `model_loop/adapters/ufc/study.py` measured why
(`docs/model-loop/ufc/study/README.md` has every table).

**The closing line.** No licensed, timestamped UFC close exists in the repository.
The study grades against a public archive's pre-fight moneyline (the Ultimate UFC
Dataset's `ufc-master.csv`: one line per side, a steady ~4% margin, 2010 to
2026-03; only its two odds columns are read, fetched at run time into `.cache`, sha256
recorded, never committed), matched to 5,662 ESPN bouts. It is **untimestamped**, so it
grades but never certifies.

**1.1.0, every decided bout since 2018** (4,853; 3,764 with a close): log loss
0.673, Brier 0.240; on the bouts with a close 0.671 against the closing line's
0.604 (Brier 0.239 v 0.209). Its stated chances are calibrated but it almost never
leaves 50-65%, where the close names 80-90% favourites and stays on the diagonal.
**Gaps over 10 points: 2,102 bouts, 586 resolved in the model's favour, 1,516 in the
market's.** Its blind spots (each bout read from the side of the fighter concerned,
said by the model / by the close / won): the older fighter at 37+ 47.8% / 38.4% /
33.6%; 8+ years older 45.9 / 36.3 / 32.2; a debutant 45.3 / 41.9 / 37.9; the fighter
with 1-10 UFC bouts against a more experienced one 49-50 / 51-54 / 52-55; out 540+
days 46.0 / 42.8 / 39.4. Division changes and rematches: small.

**One change at a time** (fit 2016-2020, kept only if the 2021-2023 log loss fell by
0.0005 or more; protocol hashed before any step, `protocol.json`): step-size re-tune
dropped; short-sample shrinkage and a debut prior dropped; **pre-UFC record prior
kept (−0.0114)**; layoff decay dropped; **age curve kept (−0.0070)**; division
change dropped; recency dropped (the fit chose none); head to head dropped
(−0.0003). **Promotion** (2024 on, read once, against 1.1.0 on the same 1,623
bouts): log loss 0.666 → 0.646 (−0.0199, card-blocked 95% interval −0.028 to
−0.011), Brier −0.0094: promoted as 1.2.0. Since 2018: 0.653 (1.1.0 0.673); on the
bouts with a close 0.650 against the close's 0.604.

**Hindsight in the record prior.** The reconstructed record of a fighter who also
fought outside the UFC after the first bout in the data carries those results back.
The record step's gain is about −0.019 on fighters who left the UFC and −0.005 on
those still there; on the test window with both fighters still in the UFC in 2026
(1,016 bouts, where it can barely act) the record step alone gains −0.0085 (95%
interval −0.016 to −0.001) and 1.2.0 −0.0186 (−0.029 to −0.008). So the record prior
helps, by about half what the full backtest shows. For a bout priced now the record is
exact. ESPN's athlete overview lists only the five latest UFC bouts, so no dated
career history (nor pre-UFC opponent quality) is available.

**What 1.2.0 still misread.** Debutants: 48.6% said, 41.9% the close, 37.9% won
(worse than 1.1.0). The age curve was one line for every division (§2b: now one per
division). The record prior sat at its grid's edge. The weekly loop tests
`record_prior_stronger`, `age_steeper`, `age_gentler`, `head_to_head`,
`debut_lower`, and now `age_by_division` and its reverse `age_shared`, under its
preregistered rule.

**The guard** (`model_loop/adapters/ufc/guard.py`, `simulator/src/sports/ufc/guard.ts`,
`docs/model-loop/ufc/guard.json`). Every booked bout carries DraftKings' latest
pregame moneyline as ESPN shows it (`research/clv/openers/ufc`, captured hourly),
the margin removed multiplicatively. A gap over **8 points** (`threshold_pp`) is
labelled **"Model disagrees with market"**: both numbers side by side, the factors
present that the model is known to misread (a debut or short UFC sample, a layoff of
365+ days, 35 or older, a weight change, a rematch) each with the served version's
measured record, no fair odds. A gap is a signal only when the study certifies that
gaps that size beat a **timestamped** close out of sample with n ≥ 300; on 2021 on,
1.2.0's 1,420 gaps over 8 points resolved 478 in its favour and 942 in the market's,
and the close on file is untimestamped: **not certified** (1.3.0: 1,408 gaps, 505 its
way, 903 the market's; still not certified). The loop publishes the
verdicts (`current.json` `guard`); the simulator's copy reproduces them (gate
`guard.agrees`); the Games page reads the loop's (`tools/slate/research.js`: a
disagreeing main event is a LIMITED projection, never a signal).

The model's record (the loop's own evaluation, `model_loop/published/ufc/validation.json`):
validation 2021-2024 log loss **0.6756** (n 2,225) against a coin's 0.6931;
2025 holdout 0.6657 (n 563); 2026 so far, served 1.2.0, 0.6509 (n 498).
Favourites: said 56.1% and won 56.5% in 2021-2024; 56.4% / 60.9% in 2025. The
validation and holdout are the preregistered backtest of the tuned 1.0.0; 1.1.0
changed only the new-fighter step (a log loss 0.0016 lower over 2016 to date), and
1.2.0 is measured against 1.1.0 and the closing line in §2a. No timestamped
closing archive exists, so nothing here is certified as beating the market.

### 2b. The age curve by division (1.3.0)

The question (2026-10-24): does age cost the same at every weight? Heavyweights,
and perhaps the lighter divisions, were thought to age later (Volkanovski at 38,
Dvalishvili at 35 and Yan at 33 still near the top).
`python3 -m model_loop.adapters.ufc.study age`, under `age_protocol.json` (sha256
`9bb8cad3…`, written before any fit), gave every division with 150+ bouts in
2016-2020 its own knee (28-40) and slope (0 to −40 Elo a year), fitted on those
years alone, so 2021 on is out of sample for it (`age_by_division.json`, README §5).

| Division | Decline from | Elo a year | Older fighter (33+, 3+ years older), every bout since 2016: 1.2.0 said / 1.3.0 said / won |
|---|---|---|---|
| Flyweight | shared (32) | −15 | 38.7 / 38.8 / 30.1 (83) |
| Bantamweight | 28 | −15 | 39.3 / 36.5 / 36.9 (198) |
| Featherweight | 28 | −15 | 40.1 / 37.1 / 37.2 (183) |
| Lightweight | 30 | −15 | 39.1 / 37.3 / 37.0 (262) |
| Welterweight | 33 | −25 | 40.5 / 38.4 / 37.9 (311) |
| Middleweight | 28 | −20 | 37.9 / 32.4 / 31.1 (270) |
| Light heavyweight | 40 | −25 | 38.8 / 45.1 / 44.4 (169) |
| Heavyweight | 31 | −15 | 39.0 / 38.1 / 36.4 (209) |
| Women's strawweight | 28 | −30 | 39.0 / 27.8 / 34.5 (110) |
| Women's fly-, bantam-, featherweight | shared | −15 | too few 2016-2020 bouts |

**What the data say.** The lighter men's divisions decline *earliest*, not latest
(bantam- and featherweight at 28, the grid's edge); light heavyweight latest (40);
heavyweight at 31. Older fighters at bantam- and featherweight were still overrated
by 1.2.0, not underrated. A heavyweight-only later knee made every window worse. An
elite UFC record (6+ wins at 70%+) does not slow the decline: 1.2.0 said 46.2% for
such fighters past the knee and they won 39.0%; a steeper curve for them helped
2021-2023 (−0.0008) but lost on 2024 on (+0.0003) and in 2025 and 2026: not adopted.

**How it was adopted.** Out of sample (2021-2026, 3,286 bouts) the curve by division
lowers log loss by 0.0020 (card-blocked 95% interval −0.0048 to +0.0008): better in
2022, 2024, 2025 and 2026, worse in 2021 and 2023. The study's own rule (2021-2023
alone) dropped it. The weekly rule every UFC change must clear (every bout since
2016 at least 0.0005 lower with the interval below zero, Brier no worse, not worse
on the last full season) passed it: −0.0025, 2025 −0.0050. It is served as 1.3.0,
**better, not proven**; the weekly loop retests it and its reverse (`age_shared`)
every week, so the same rule can take it back.

**Against 1.1.0 and the close** (`comparison.json` now follows the served version):
2024 on, 1,623 bouts, log loss 0.666 → 0.640 (−0.0259, 95% interval −0.036 to
−0.016), Brier −0.0120; 1.2.0 was 0.646. 2024 on is no longer untouched for 1.3.0
(the weekly rule read it). Since 2018 on the bouts with a close: 0.648 against the
closing line's 0.604 (1.2.0 0.650). Gaps over 10 points out of sample: 1,186 (426
the model's way, 760 the market's; 1.2.0 1,209, 395 v 814).

---

## 3. The simulation (`module.ts`)

One run = every booked bout, then each division's title path to the horizon.

1. **Booked bouts**, in the schedule's order (65 on 2026-10-23, through UFC 335
   on 2026-12-13). The winner is drawn with the served price exactly (the
   published p_a: nothing is added to it, the marginal is kept). Then how it
   ends: a finish with P(finish | this winner), else a decision; a finish's
   round from the measured distribution (§4). Every simulated fight has a
   winner (§4: draws and no contests are measured and left out).
2. A bout between a division's **ufc.com champion** and another fighter at that
   weight is a **title fight**: its winner leaves as champion. On the committed
   data: Volkanovski v Evloev (featherweight, UFC 333), Yan v Dvalishvili
   (bantamweight, UFC 333), Gane v Hokit (heavyweight, UFC 334), Harrison v
   Nunes (women's bantamweight, UFC 334). ESPN's raw scoreboard marks each
   champion with the division's title accolade (all four agree).
3. **Title fights not yet booked** (§5) at the division's measured pace, the
   challenger by the Estimated rule, each priced by the served Elo.

Streams (fixed numbers, `core/prng.ts`): booked winners 2 (games), endings 13
(method), title-fight dates 14 (schedule), title-fight winners 3 (postseason).
Each run depends only on (seed, run): 1 and 3 workers give byte-identical
aggregates (tested).

Outcomes per fighter (all fighters booked, every champion, every ranked
contender: 257): win the next booked bout, by a finish, on the scorecards
(Research); a title shot (a champion: defends), a title won, the title held at
the horizon (**Estimated**). Sum rules after every run and on the aggregate:
one winner per booked bout; one champion per division at the horizon; finishes
and decisions sum to the wins; no title without a shot (gate `run.sum_rules`).

---

## 4. How fights end (`finish.ts`, measured every run)

Definitions: **decision** = the bout went the distance (it ended in the last
scheduled round at 5:00); **finish** = anything else with a winner. The data
carry **no method** (ESPN's monthly scoreboard has none; the raw scoreboard only
holds "Unofficial Winner …" for this month), so KO/TKO and submission are never
separated.

- Since 2014: 50.9% of three-round and 59.6% of five-round bouts with a winner
  were finishes. Division rates run from 34.8% (women's strawweight) to 67.0%
  (light heavyweight).
- **base(d, R)** = logistic(logit(rate of the format) + logit(rate of the
  division) − logit(overall rate)).
- Given that A beats B: logit P(finish) = logit base + dev_win(A) + dev_loss(B),
  each deviation the fighter's finishes over expectation **shrunk by m
  pseudo-bouts**. Point in time (each bout predicted from earlier bouts only), m
  chosen on 2016-2022 by log loss: **m = 10**. Holdout 2023 to the as-of time
  (2,126 bouts): log loss **0.661**, against 0.681 for the base rate alone and
  0.692 for one rate for all.
- **Round of a finish**: the division's distribution shrunk toward the format's
  with c pseudo-finishes, c chosen the same way (the format alone was a
  candidate): **c = 500** (holdout log likelihood −1,156.3 against −1,158.2 for
  the format alone). Three rounds: R1 52.2%, R2 31.4%, R3 16.4%; five rounds:
  36.1 / 26.8 / 18.9 / 9.6 / 8.7%. Independent of who wins (stated).
- **Draws and no contests**: 62 draws and 62 no contests in 6,905 finals
  (1.8%; 1.6% since 2021). Not simulated: the served Elo is a P(win | a winner)
  and keeping its price exact means every simulated fight has one.
- Excluded from the division rates: 40 bouts listed with 4 scheduled rounds
  (tournament finals with a possible extra round) and 111 outside the eleven
  divisions (catchweights, the defunct women's featherweight).

---

## 5. The title path

Horizon: **365 days** from the as-of time (the last result, 2026-10-18), so
through 2027-10-18.

**Pace (MEASURED).** Wikipedia's *List of UFC champions*
(`simulator/data/feeds/ufc_champions_wikipedia.html.gz`, Parsoid HTML, parsed by
`title_history.ts`: every reign row, every defence line, interim rows apart; no
line unparsed): undisputed title fights in the five years to 2026-10-18 —
flyweight 10, bantamweight 10, featherweight 7, lightweight 8, welterweight 8,
middleweight 10, light heavyweight 10, heavyweight 4 (plus 3 interim, not
modelled), women's strawweight 8, women's flyweight 7, women's bantamweight 6.
A division's mean gap is 365.25 / (fights per year). The gaps follow a gamma
whose shape is fitted to every division's gaps since 2014, each divided by its
division's mean (203 gaps, CV 0.472, **shape 4.49**). The next unbooked title
fight comes a gap after the division's last one (the booked title fight if any,
else Wikipedia's last undisputed title fight), drawn **conditionally** so that it
falls after the last card the schedule lists (2026-12-13): a title fight not
booked by now is not on a card already announced. Then gap after gap to the
horizon.

**Who gets the shot (ESTIMATED: EdgeDesk's rule, not the UFC's).** The champion
meets the highest-ranked contender who is coming off a win and has rested at
least **104 days** since the last fight. Measured from the 187 undisputed title
fights since 2014 with a champion defending and a winner, matched to the bouts
(191 of 192 matched): 154 of 181 challengers were coming off a win (85%), 24 off
a loss, 3 off a draw or no contest; rest p10 **104** days, median 196, p90 412
(the minimum is the p10). The order starts from ufc.com's ranks (ties in the
page's order); a booked bout moves its winner to the loser's place when the loser
was ranked higher; a champion who loses goes to the front of the order, coming
off a loss (so never regains it within the run); a ranked contender **booked in
another division** has moved (the schedule shows it) and counts there only:
Diego Lopes and Brian Ortega (featherweight → lightweight), Alex Pereira (light
heavyweight → heavyweight). A contender's rank cannot be measured historically
(no rankings history is owned), which is why the rule is Estimated.

**Each title fight** is priced by the served Elo on the ratings frozen at the
as-of time, with the served layoff rule at the fight's date and the served
champion term (`champ_bonus` Elo points to the champion going in; the served
1.1.0 has none, so 0). A simulated fight never moves a rating.

**Champions against the Elo (MEASURED, 2026-10-23).** In those 187 title fights
champions won **123**; the Elo expected **106.0** (log loss 0.657 against a
coin's 0.693). The gap is not spread evenly, so the record is published in two
periods (`title_record.periods`, split at `TITLE_SPLIT` = 2021-01-01):

| Title fights | N | Champions won | Elo expected | Champions ahead by |
|---|---|---|---|---|
| 2014–2020 | 100 | 71 | 54.8 | +16.2 |
| 2021–2026 | 87 | 52 | 51.2 | +0.8 |

Finer: 2014–15 +7.5 in 31, 2016–20 +8.7 in 69, 2021–24 +1.0 in 63, 2025 −1.2
in 17, 2026 +1.0 in 7. The Elo underrated champions before 2021; since then it
has matched them. Under the served 1.3.0 (2026-10-24) the same fights: 2014–2020
expected 58.3 (champions ahead by +12.7), 2021–2026 expected 51.1 (+0.9); the
reader reads the numbers from each run.

**The champion term (the fix belongs in the model, so it lives there).**
`model_loop/adapters/ufc/model.py` gained `champ_bonus`: Elo points added to the
champion going in for the bout's expectation (and so its update) in an
undisputed title fight. The champion going in is point in time (who holds the
belt, and that the bout is for it, is known when the bout is booked) and comes
from `model_loop/data/ufc/title_bouts.csv`, written by
`simulator/src/research/ufc_title_bouts.ts`: Wikipedia's title history matched
to bouts.csv and the ESPN feed (191 past fights; one unmatched since 2014, W
Flyweight 2020-02-08 Shevchenko v Chookagian, which ESPN does not list), plus
booked defences (a ufc.com champion at their own weight in a bout not yet
final: Volkanovski and Yan on 2026-10-24, Gane and Harrison on 2026-11-15).
With the term at 0 the walk is unchanged price for price.

Sized on the tune window alone (2016–2020 log loss over every decided bout:
0.67946 with no term, lowest at +100 of 0, 25, …, 150), the term went through
the preregistered weekly rule like every other change
(`docs/model-loop/ufc/candidates.jsonl`, 2026-10-23): log loss over every bout
since 2016 **+0.00009** (it needs −0.0005 with a paired 95% interval below zero;
the interval was [−0.00106, +0.00124]), Brier unchanged, 2025 **+0.00241**
(worse). Over 2016–2026 title fights alone it lifts the expected champion wins
from 90.5 to 109.6 against 100 won: it fixes 2016–2020 and overshoots since. So
it is **not served**. It is a permanent candidate in the loop's catalogue
(`loop.py` CATALOGUE `champion_term`), retested every week on fresh title flags
(the UFC loop workflow regenerates `title_bouts.csv` before each run); if
champions pull away from the Elo again it passes and is promoted.

The simulator is ready for that: the Elo port (`elo.ts`) reads `champ_bonus` and
`title_bouts.csv` exactly as model.py does, so the reproduction gate holds under
a promoted term, and the module prices every unbooked title fight with it. The
reader states the two periods and the latest weekly test (Model Health), read
from the run, never typed in.

**Not modelled** (stated in the registry and the reader): interim belts and
promotions; a champion vacating, being stripped or retiring; bouts not yet on the
schedule other than title fights (rankings move only through booked bouts);
injuries and withdrawals; draws and no contests.

---

## 6. Inputs and gates (`inputs.ts`, `run.ts`)

| Input | Source | Check |
|---|---|---|
| History and ratings | `model_loop/data/ufc/bouts.csv` (sha256 in the snapshot) | the port reproduces `current.json` |
| Schedule, newer results | `simulator/data/feeds/ufc_bouts.json.gz` (ESPN month by month on a GitHub runner, 6,972 bouts) | finals equal bouts.csv's; a newer result is walked |
| Champions, ranks 1-15 | `simulator/data/feeds/ufc_rankings.json` (ufc.com, fetched 2026-10-23T20:27:43Z, page sha256 `7e07e6f7…`) | the saved page (`ufc_rankings.html.gz`) hashes to the recorded sha256; 24 groupings → 11 divisions (11 repeats with empty lists deduplicated, 2 pound-for-pound lists dropped) |
| Names | ufc.com → ESPN ids | all 176 matched (accents, curly quotes, word order); one alias with its evidence: Muhammad Saidov = ESPN "Muhammad Said" (5369438, the only light heavyweight with that name stem) |
| Title history | Wikipedia (sha256 in the snapshot) | every table read; incumbents agree with ufc.com in 11 of 11 |
| Title accolades | `simulator/data/feeds/ufc_espn_samples.json.gz` (raw ESPN scoreboard; the fight-centre documents came back empty) | the four booked title fights: the holder is the ufc.com champion |
| Fighter facts | `model_loop/data/ufc/fighter_facts.csv` (date of birth from ESPN's athlete document; the pre-UFC record reconstructed: `factors.py`) | the loop and the port read the same file (sha256 in the snapshot); the reproduction gate holds only if they agree |
| Market, guard | `research/clv/openers/ufc/*.jsonl` (DraftKings via ESPN, observed_at stamped), `docs/model-loop/ufc/guard.json` | the guard's verdict on every bout the loop publishes is reproduced (`guard.agrees`) |
| Model record | `docs/model-loop/ufc/study/comparison.json` | read into Model Health as written |

Gates that block the simulation: `model.reproduces`, `fighters.rated` (every
fighter rated from the data or a debutant at 1500; no champion or ranked
contender without a UFC bout), `rankings.parsed`, `title_history.parsed`,
`schedule.single` (no fighter booked twice). Publication only: `model.served`,
`model.booked_priced` (the bouts the loop lists carry its published price),
`rankings.fresh` (≤ 8 days), `champions.agree`, `schedule.current`, `guard.agrees`
(this copy of the guard gives the loop's verdict on every bout both list, and no
disagreement is a signal without certification), then
`run.sum_rules`, `run.finite`, `run.count` (100,000), `sport.active`.

Registry: **ACTIVE** while the loop serves its Elo (`versions.json` status
SERVED) and the four feeds exist; every fact a result depends on is read and gated
in each run, and the matchmaking rule is labelled Estimated, not a fact to verify.

---

## 7. Dry run (committed data, 2026-10-24, served 1.3.0)

`node simulator/src/cli/run.ts --sport ufc --season 2026 --workers 4 --dry-run`
(`npm run sim:ufc:dry-run`): 100,000 runs, 2.4 s on 4 workers, peak RSS 339 MB,
input hash `903cd3aa4a14…`, seed 10393414768405040174 (from the input hash), model
`edgedesk_ufc_elo@1.3.0+cfg430f205a`, **PUBLISHABLE** (all 15 gates, `model.reproduces`
20 of 20 and `guard.agrees` 18 of 18 included).

**UFC 333** (1.1.0 → 1.2.0 → 1.3.0, the served price; the market is DraftKings' latest
no-vig price, 2026-10-24 07:37-12:14 UTC; DISAGREES: over 8 points):

| Bout | 1.1.0 | 1.2.0 | 1.3.0 | Market | Guard (1.3.0) |
|---|---|---|---|---|---|
| Volkanovski v Evloev (title) | 45.9 | 34.8 | 36.5 | 49.6 | DISAGREES −13.1 (Volkanovski 38) |
| Dvalishvili v Yan (title) | 54.7 | 51.3 | 52.8 | 43.6 | DISAGREES +9.2 (Dvalishvili 35; a rematch) |
| Temirov v Kavanagh | 55.7 | 50.4 | 50.3 | 48.9 | agrees |
| Volkov v Kuniev | 70.6 | 65.3 | 65.3 | 52.2 | DISAGREES +13.1 (Volkov 38) |
| Pico v Keita | 49.5 | 34.4 | 32.6 | 57.2 | DISAGREES −24.6 (both 2 UFC bouts) |
| Murzakanov v Reyes | 51.8 | 55.0 | 54.3 | 64.5 | DISAGREES −10.1 (both past 35) |
| Krylov v Yakhyaev | 38.5 | 26.0 | 31.7 | 18.8 | DISAGREES +12.8 (Krylov 8.8 years older) |
| Magomedov v Rowston | 47.7 | 42.5 | 39.8 | 53.3 | DISAGREES −13.5 (Magomedov 36) |
| Dawson v Aliev | 60.8 | 55.8 | 51.4 | 51.1 | agrees |
| Thicknesse v Chopurov | 56.2 | 46.0 | 45.0 | 17.8 | DISAGREES +27.2 (Chopurov's debut) |
| Vagaev v Malkoun | 40.0 | 42.7 | 41.4 | 59.3 | DISAGREES −18.0 (short sample, weight change) |
| Santos v Oki | 60.5 | 59.6 | 57.5 | 51.1 | agrees (+6.5) |
| Gugnon v Steele | 50.3 | 47.1 | 50.1 | 41.7 | DISAGREES +8.4 (short samples) |
| Caliari v Lucindo | 34.4 | 34.9 | 32.2 | 22.9 | DISAGREES +9.4 (Lucindo's layoff) |

Mean gap to the market: 1.1.0 13.0, 1.2.0 11.6, 1.3.0 12.0 points; over 8 points 10,
9, 11. 1.3.0 is nearer the market than 1.2.0 on 6 of the 14 and further on 7 (Volkov
unchanged): the curve by division moves Volkanovski toward the market (34.8 → 36.5)
and Dvalishvili, Krylov and Magomedov away. One card does not grade a model; §2b has
the out-of-sample record. The main event: Volkanovski 36.1% ±0.3 (finish 16.1%,
decision 20.0%), Evloev 63.8% (finish 20.8%, decision 43.1%); a finish 36.9%; **new
champion 63.8%**, fair odds withheld (the model disagrees with the market). UFC 334:
Gane 42.2% v Hokit (1.1.0 57.8%, market 69.6%: DISAGREES −27.4), Harrison 48.5% v
Nunes (1.1.0 37.0%, market 64.5%: DISAGREES −16.0). UFC 335: Oliveira 63.4% v Lopes;
Pavlovich 54.2% v Pereira.

**Title path to 2027-10-18** (hold the title at the horizon · win it · title
shot · beat the champion if given the shot; Estimated):

| Division | Expected title fights | Top of the table |
|---|---|---|
| Flyweight | 1.69 | Van (C) 58.7 · Kape 22.2 / 30.6 / 97.5 / 31.4 · Royval 14.2 / 16.2 / 59.9 / 27.0 |
| Bantamweight | 2.56 | O'Malley 32.0 / 45.0 / 96.0 / 46.9 · Song 22.9 · Dvalishvili 22.6 / 52.9 / 100 / 52.9 · Yan (C) 18.9 |
| Featherweight | 1.98 | Evloev 36.7 / 63.8 / 100 / 63.8 · Vallejos 21.2 · Volkanovski (C) 16.9 · Sterling 15.6 |
| Lightweight | 1.49 | Tsarukyan 46.3 / 56.1 / 93.5 / 60.0 · Gaethje (C) 32.8 · Oliveira 11.9 |
| Welterweight | 1.39 | Makhachev (C) 63.4 · Prates 19.7 / 26.5 / 94.1 / 28.2 · Morales 15.1 |
| Middleweight | 1.91 | Du Plessis 40.5 / 63.2 / 99.3 / 63.7 · Imavov 28.3 · Strickland (C) 20.1 |
| Light heavyweight | 1.93 | Ankalaev 38.4 / 52.9 / 99.4 / 53.2 · Ulberg (C) 33.0 · Stirling 15.3 |
| Heavyweight | 1.33 | Hokit 50.3 / 57.6 / 100 / 57.6 · Gane (C) 35.9 · Volkov 9.9 |
| Women's strawweight | 1.39 | Dern (C) 38.5 · Gomes 29.0 · Jandiroba 17.7 · Suarez 12.5 |
| Women's flyweight | 1.05 | Silva (C) 64.6 · Shevchenko 27.1 / 30.8 / 83.7 / 36.7 · Grasso 7.9 |
| Women's bantamweight | 1.71 | Nunes 34.3 / 51.4 / 100 / 51.4 · Harrison (C) 32.0 · Edwards 30.1 |

Several #1 contenders show nothing because the rule excludes a fighter coming
off a loss (Pantoja, Topuria, Machado Garry, Chimaev, Zhang) or a no contest
(Aspinall): the reader names each with the reason.

---

## 8. Reader (`lib/edgedesk_simulator_ufc.js`)

Registered with `EDSimUI.registerSport('ufc', …)`; reads the published run with
`EDSimUI.loadPublished`, renders every non-readable state through
`EDSimUI.gateHtml`, the run header through `renderMeta`; per-bout and per-division
numbers from `run.validation_summary.sport_summary` (about 150 KB); every value
through `esc()`.

- **Fights**: cards by date, main event first; each bout: both fighters with
  ufc.com champion/rank tags and debut marks, win share with its ±, fair decimal
  and American odds under it, by finish / by decision, finish v the distance,
  finish by round, a title badge and the chance of a new champion, the served
  price beside the loop's published value; **Model v market**: the market's no-vig
  price, the gap and 1.1.0's price; a gap over the threshold is labelled "Model
  disagrees with market" (on the bout and in its header), says it is not an edge,
  lists what the model likely misreads with the served version's record on it, and
  withholds the fair odds (the new champion's too).
- **Title Path**: the horizon and the rule in plain words, the measured share of
  challengers off a win; per division: champion and the chance to keep the belt,
  the booked title fight, the pace, contenders moved out, a table (hold, win,
  shot, beat the champion if given the shot), contenders with no shot in any
  simulated year listed apart with the reason.
- **Model Health**: the served Elo and the reproduction count, its record beside a
  coin; **against the closing line**: 1.1.0 and the served model by window (log loss,
  Brier, and on the bouts with a close beside the close itself), a calibration chart
  (favourite-side reliability of the close, 1.1.0 and the served model; colours
  checked for colour-vision deficiency on the dark surface, a dash and three marker
  shapes as well, a direct label per line, every point's numbers on hover and in a
  table), how gaps resolved by size, the certification in plain words, every change
  tried; champions against the Elo, the finish model out of sample, draws and no
  contests.

Tested in Chromium at 390 and 1440 px (`simulator/tests/ui.e2e.ts`): no
horizontal page scroll, no page error.

---

## 9. Limitations (also in the registry, shown in the reader)

1. The served Elo (1.3.0) beats 1.1.0 out of sample but still trails the market
   by a wide margin (since 2018 log loss about 0.65 v the closing line's 0.60). The
   close it is graded against is an untimestamped public archive, so no gap is
   certified as an edge: a gap over 8 points is "Model disagrees with market".
   Residual blind spots: debutants (overrated). The age curve by division is better
   out of sample since 2021 but not proven (§2b).
2. No method in the data: KO/TKO and submission are not told apart; draws and no
   contests are not simulated.
3. The title path is Estimated: EdgeDesk's matchmaking rule, the measured pace,
   never the UFC's booking.
4. Rankings move only through booked bouts; interim titles, vacated or stripped
   titles, retirements, injuries and withdrawals are not modelled; a contender
   booked in another division is treated as having moved.
5. Title fights are priced without a champion term: champions beat the Elo's
   expectation from 2014 to 2020 (under 1.3.0, 71 of 100 v 58.3 expected) but have
   matched it since 2021 (52 of 87 v 51.1). The term is retested every week
   (section 5) and served only if it clears the preregistered rule.
6. Ratings are frozen at the last result (the served layoff rule and age curve
   still apply at a fight's date; head to head is not carried into a simulated
   rematch).
7. The ± is simulation noise only.

---

## 10. Tests (2026-10-24, this environment)

| Suite | Result |
|---|---|
| `ufc_elo.test.ts` | 46 passed (SYNTHETIC walk cases; the 2026-10 parameters by hand and off; the age curve by division and the elite term by hand; current.json reproduced; model.py at full precision served, with the champion term and with every 2026-10 parameter on, the curve by division and the elite term included; 1.1.0 runnable) |
| `ufc_sim.test.ts` | 70 passed (gamma helpers; SYNTHETIC two-division fixture: sum rules, exact marginals, rounds, rank rule, per-run invariants over 3,000 traced runs; 1 v 3 workers; gates on mutated snapshots; committed data incl. the guard on every booked bout and 1.1.0's price beside the served one; registry, plan) |
| `ufc_ui.test.ts` | 48 passed (states, the three tabs, fair odds and their withholding, the guard label and reasons, the closing-line card and calibration chart, the age-by-division table and its adopted / not-adopted text, escaping on every tab) |
| `model_loop/tests` (Python) | 157 passed (the UFC suite: the extended walk off = 1.1.0, causal and symmetric on, prior and age by hand, the age curve by division and the elite term by hand, causal and symmetric, factors, no-vig and archive matching, the guard and its certification refusals, the pipeline's refresh with the guard) |
| `tools/slate/build.test.js`, `games.test.js`, `games_ui.e2e.js` | 67, 106, 105 passed (the UFC card's guard on the Games page) |
| `npm run sim:test` | every suite green |
| typecheck, `npm run sim:check` | clean, generated files current |
