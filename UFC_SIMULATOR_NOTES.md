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
| Fight model | The model loop's served UFC Elo **1.1.0** (EXPERIMENTAL), ported line for line; reproduces all 25 published p_a and `model.py` itself to 4e-16 | `elo.ts`, §2 |
| Finish / decision / round | Measured point in time from every bout since 2014, chosen on 2016-2022, tested on 2023 on | `finish.ts`, §4 |
| Title path (12 months, every division) | Implemented, tested; **Estimated** (the matchmaking rule); title-fight pace MEASURED from Wikipedia's title history | `module.ts`, §5 |
| Champions and rankings | ufc.com/rankings in every run (page sha256 recorded and checked against the saved page); Wikipedia's incumbents and ESPN's title accolades agree | `inputs.ts`, §6 |
| Reader | Fights, Title Path and Model Health tabs | `lib/edgedesk_simulator_ufc.js`, §8 |
| Nightly | Every night (the feeds refresh daily at 09:41 UTC, before the 10:17 run); dispatchable | `cli/plan.ts`, `.github/workflows/simulator.yml` |
| Database | No change: the run uses the generic `sim_*` tables; per-bout and per-division numbers ride in `validation_summary.sport_summary` | `supabase/simulator.sql` unchanged |

---

## 2. The fight model (no new model)

Who wins every simulated fight comes from the model the loop serves for UFC:
the walk-forward Elo `model_loop/adapters/ufc/model.py walk()` with the served
configuration from `docs/model-loop/ufc/versions.json` (current **1.1.0**,
status `SERVED (EXPERIMENTAL)`: k 64, a 1.5x step for a fighter's first 3 bouts
in the data, a 25% regression toward 1500 after 365 days or more out, scale 400,
no calibration; config sha256 `7aeca585…`).

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
in between moves a rating. A debutant is priced at 1500 ("an average fighter"),
as the served model does.

The model's record (the loop's own evaluation, `model_loop/published/ufc/validation.json`):
validation 2021-2024 log loss **0.6756** (n 2,225) against a coin's 0.6931;
2025 holdout 0.6657 (n 563); 2026 so far, served 1.1.0, 0.6712 (n 498).
Favourites: said 56.1% and won 56.5% in 2021-2024; 56.4% / 60.9% in 2025. The
validation and holdout scored the tuned configuration (1.0.0); 1.1.0 changed only
the new-fighter step (promoted for a log loss 0.0016 lower over 2016 to date).
No closing-price archive exists, so it has never been compared with a market.

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

Streams (fixed numbers, `core/prng.ts`): booked winners 2 (games), endings 12
(method), title-fight dates 13 (schedule), title-fight winners 3 (postseason).
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
as-of time, with the served layoff rule at the fight's date. A simulated fight
never moves a rating.

**Champions against the Elo (MEASURED).** In those 187 title fights champions
won **123**; the Elo expected **106.0** (log loss 0.657 against a coin's 0.693).
The Elo underrates champions in title fights (most likely its layoff regression
and k step, tuned on all bouts); the title path uses it unchanged, so it likely
**understates a champion's chance to keep the belt**. Stated in the limitations
and the reader; not corrected (that would be a new model, not the served one).

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

Gates that block the simulation: `model.reproduces`, `fighters.rated` (every
fighter rated from the data or a debutant at 1500; no champion or ranked
contender without a UFC bout), `rankings.parsed`, `title_history.parsed`,
`schedule.single` (no fighter booked twice). Publication only: `model.served`,
`model.booked_priced` (the bouts the loop lists carry its published price),
`rankings.fresh` (≤ 8 days), `champions.agree`, `schedule.current`, then
`run.sum_rules`, `run.finite`, `run.count` (100,000), `sport.active`.

Registry: **ACTIVE** while the loop serves its Elo (`versions.json` status
SERVED) and the four feeds exist; every fact a result depends on is read and gated
in each run, and the matchmaking rule is labelled Estimated, not a fact to verify.

---

## 7. Dry run (committed data, 2026-10-23)

`node simulator/src/cli/run.ts --sport ufc --season 2026 --workers 4 --dry-run`
(`npm run sim:ufc:dry-run`): 100,000 runs, 1.7-7.2 s on 4 workers (machine
load), peak RSS 288 MB, input hash `ea3500c47b70…`, seed 16876396022525349366
(from the input hash), **PUBLISHABLE**.

**UFC 333 main event, featherweight title** (served 45.93% Volkanovski):
Volkanovski 45.9% ±0.3 (fair 2.18 / +118: by finish 20.7%, decision 25.3%),
**Evloev 54.1% ±0.3** (fair 1.85 / −118: finish 17.5%, decision 36.6%); a finish
38.2% (R1 13.8, R2 10.2, R3 7.4, R4 3.5, R5 3.3), the distance 61.8%; **new
champion 54.1%**. Co-main, bantamweight title: Dvalishvili 54.8% over the
champion Yan 45.2% (finish 30.7%). UFC 334: Gane 57.8% v Hokit; Harrison 37.2% v
Nunes 62.8%. UFC 335: Oliveira 69.4% v Lopes; Pereira 55.4% v Pavlovich.

**Title path to 2027-10-18** (hold the title at the horizon · win it · title
shot · beat the champion if given the shot; Estimated):

| Division | Expected title fights | Top of the table |
|---|---|---|
| Flyweight | 1.69 | Van (C) 54.7 · Kape 23.8 / 33.3 / 97.6 / 34.2 · Royval 16.6 / 18.6 / 59.8 / 31.2 |
| Bantamweight | 2.56 | O'Malley 30.2 / 41.5 / 96.0 / 43.2 · Dvalishvili 26.4 / 54.8 / 100 / 54.8 · Song 20.6 · Yan (C) 19.5 |
| Featherweight | 1.98 | Evloev 31.1 / 54.1 / 100 / 54.1 · Sterling 26.3 / 27.9 / 50.2 / 55.5 · Volkanovski (C) 25.2 |
| Lightweight | 1.49 | Gaethje (C) 39.5 · Tsarukyan 35.3 / 45.8 / 93.5 / 49.0 · Oliveira 15.7 |
| Welterweight | 1.39 | Makhachev (C) 68.1 · Prates 19.6 / 24.7 / 94.1 / 26.2 · Morales 10.7 |
| Middleweight | 1.91 | Du Plessis 40.6 / 60.7 / 99.3 / 61.1 · Imavov 25.4 · Strickland (C) 23.4 |
| Light heavyweight | 1.93 | Ankalaev 36.0 / 51.0 / 99.4 / 51.3 · Ulberg (C) 34.3 · Stirling 15.7 |
| Heavyweight | 1.33 | Gane (C) 48.8 · Hokit 34.8 / 42.2 / 100 / 42.2 · Volkov 12.6 |
| Women's strawweight | 1.39 | Dern (C) 43.7 · Jandiroba 19.8 · Gomes 17.7 · Suarez 17.4 |
| Women's flyweight | 1.06 | Silva (C) 59.1 · Shevchenko 32.6 / 36.6 / 83.8 / 43.7 · Grasso 7.8 |
| Women's bantamweight | 1.71 | Nunes 47.1 / 62.8 / 100 / 62.8 · Edwards 24.9 · Harrison (C) 24.8 |

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
  price beside the loop's published value.
- **Title Path**: the horizon and the rule in plain words, the measured share of
  challengers off a win; per division: champion and the chance to keep the belt,
  the booked title fight, the pace, contenders moved out, a table (hold, win,
  shot, beat the champion if given the shot), contenders with no shot in any
  simulated year listed apart with the reason.
- **Model Health**: the served Elo and the reproduction count, its record beside a
  coin (plain-language verdict; no closing-price test), champions against the
  Elo, the finish model out of sample, draws and no contests.

Tested in Chromium at 390 and 1440 px (`simulator/tests/ui.e2e.ts`): no
horizontal page scroll, no page error.

---

## 9. Limitations (also in the registry, shown in the reader)

1. The served Elo's edge over a coin flip is modest (about 2.5% lower log loss in
   validation, 4% in the 2025 holdout); never compared with closing prices.
2. No method in the data: KO/TKO and submission are not told apart; draws and no
   contests are not simulated.
3. The title path is Estimated: EdgeDesk's matchmaking rule, the measured pace,
   never the UFC's booking.
4. Rankings move only through booked bouts; interim titles, vacated or stripped
   titles, retirements, injuries and withdrawals are not modelled; a contender
   booked in another division is treated as having moved.
5. Champions have beaten the Elo's expectation in title fights since 2014 (123 v
   106 expected): the title path likely understates a champion's chance to keep
   the belt.
6. Ratings are frozen at the last result (the served layoff rule still applies at
   a fight's date).
7. The ± is simulation noise only.

---

## 10. Tests (2026-10-23, this environment)

| Suite | Result |
|---|---|
| `ufc_elo.test.ts` | 22 passed (SYNTHETIC walk cases; current.json reproduced; model.py at full precision) |
| `ufc_sim.test.ts` | 66 passed (gamma helpers; SYNTHETIC two-division fixture: sum rules, exact marginals, rounds, rank rule, per-run invariants over 3,000 traced runs; 1 v 3 workers; gates on mutated snapshots; committed data; registry, plan) |
| `ufc_ui.test.ts` | 33 passed (states, the three tabs, fair odds, escaping on every tab) |
| `ui.test.ts` | 92 passed (UFC ACTIVE with its three tabs) |
| `cli.test.ts` | 39 passed (the UFC in the nightly plan) |
| `ui.e2e.ts` (Chromium) | 87 passed (UFC at 390 and 1440 px) |
| `npm run sim:test` | every suite green |
| typecheck, `npm run sim:check` | clean, generated files current |
