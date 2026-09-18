# Model card — EdgeDesk baseball run model

`edgedesk_baseball_v1.0.0` · engine `mlb/engine.js` · constants `mlb/params.js`
· checks `mlb/tests.js` · surface `Research → Baseball` in `app.html`

This card describes what the desk is allowed to say about the baseball
projection it quotes. The short version, which nothing below softens: **this
model has never been graded against a closing line, and EdgeDesk counts it
nowhere.**

## What it is

A deterministic run-expectancy calculation, one call per game, no simulation.

Each club's expected runs are built multiplicatively from the league scoring
environment:

```
runs = league_rpg
     × offense        club runs/game, regressed toward the league by G/(G+k)
     × opposing_staff starter for his expected share of nine innings,
                      relief for the rest
     × park           the venue's run index, applied in full to each side
     × weather        temperature and the wind component along the field axis
     × home_away      the published home/away run split
```

The starter's rate is blended from xERA, FIP and ERA (0.40 / 0.35 / 0.25 —
a design choice, not a fit), converted from earned runs to runs allowed by a
published 1.08 factor, and regressed toward the league by IP/(IP+50). The
relief share carries the club's **whole-staff** runs-allowed rate, taxed by
the arms EdgeDesk has flagged, because EdgeDesk publishes no separate bullpen
rate — that approximation is named on screen rather than hidden.

Two run expectations become a **negative binomial** run distribution whose
variance-to-mean ratio matches real team-game scoring (2.00 for MLB, 2.35 for
college). Convolving the two sides gives, exactly and reproducibly: the win
probability, the total distribution (over / under / push against any posted
line), and the run line.

One correction sits on top. The home club bats last, so it does not bat in the
bottom of the ninth when leading, and it converts ties and one-run games at a
rate a symmetric run distribution cannot express. MLB home clubs have won
about 53.2% of games over the last decade while the observed run split alone
implies about 51.6%; that 1.6-point gap is added **to the home win probability
and to nothing else.** It must not move a total, and the test suite asserts it
does not.

### College baseball

The same engine over `cbb.team_seasons`, with two differences that matter.

- **There is no starting pitcher, and there never will be from this source.**
  Every college projection is therefore a club-level number and says so on
  every game.
- **Schedule strength is folded from the same table the records come from.**
  Games inside a conference cancel — a run one member scores is a run another
  member allows — so a conference's aggregate run differential was earned
  entirely in its non-conference games. Dividing by the non-conference games
  played (known from `games` minus `conf_wins + conf_losses`) gives runs per
  non-conference game. It is damped, clamped, and withheld entirely from a
  conference with under 20 non-conference games on file. No poll and no
  rating service is involved.

## What is quoted, and where

| Output | Shown on |
| --- | --- |
| Projected runs per club, fair total | board row, signal card, model-vs-market block |
| Home win probability, fair moneyline both sides | model-vs-market block, board row |
| Run line and its fair price | model-vs-market block |
| p10 / p50 / p90 of the total | the range band under the comparison |
| Gap vs the posted total, gap vs the market's fair probability | board row, signals, snapshot |

The market number beside it is the odds capture's own: `sharp_fair` when a
Pinnacle quote exists, else `consensus_fair`. A **one-sided** quote is never
turned into a fair number — the vig in it is unknown, and a fair number with
unknown vig in it is a made-up number.

## Validation

**None.** There is no walk-forward training, no fitted coefficient, and no
graded closing-line record, because EdgeDesk holds no MLB or college baseball
line archive to produce one from. `params.js → validation` says so in the
object itself (`walk_forward: false`, `beats_closing_line: null`), the model
status card says so on screen, and the "What has been checked" drawer says so
in the place a track record would otherwise be.

`mlb/tests.js` asserts **self-consistency**, which is a different claim:

- the run distribution sums to one and reproduces its stated mean and variance
- league-average inputs return the league average and the published home-field figure
- every input moves the number in the direction this card describes
- park and weather reach the total in full, not halved
- odds conversions round-trip; de-vig sums to one; hold is reported
- guard bounds fire, review thresholds fire, a one-sided quote produces no claim
- a missing input is reported rather than filled in
- no payload value is ever NaN or infinite

A model can pass all of that and still lose to the market.

## Consequence in the desk

- **Tier: RESEARCH.** The strongest word the surface may use is
  *disagreement*. It may order research and be quoted as an estimate. It may
  not be called an edge, a play, or value, and it produces no expected value.
- **Past the guard bound it is a DATA FAULT, not an opportunity** — 2.5 runs
  or 18 probability points for MLB, 4.0 runs or 22 points for college. A gap
  that large is a broken input far more often than a mispriced game.
- **Review thresholds** (where "disagree" starts): 0.75 runs / 4.0 points for
  MLB, 1.25 runs / 5.0 points for college. These are attention thresholds and
  nothing more; no threshold here has been shown to beat a close.
- It moves **no** projected line anywhere else in EdgeDesk, writes to no
  ledger, and is graded in no record.

## Known limitations

1. **It does not know the lineup.** No batting order, no rest day, no platoon
   card, no late scratch. A confirmed lineup can move a real total by more
   than the review threshold.
2. **A probable starter is probable.** `mlb_game_cards` carries no confirmed
   state at all, so neither does any number built on it.
3. **The relief rate is the whole staff's**, which is usually a little worse
   per nine than a bullpen actually is; the tax on top counts flagged arms
   only, and there is no rest state anywhere in this data.
4. **Weather is a forecast for the venue**, not a reading at first pitch. A
   retractable roof halves the effect because the roof state is never
   published. Rain is a postponement risk, never runs.
5. **College is club-level only**, its schedule adjustment measures a
   conference rather than a club, and no price is captured for college
   baseball — so no college game on the screen is compared with a market.
6. **Park factors are the card's**, single-season and not split by handedness.
7. **The league baseline is folded from the club rates on hand.** With fewer
   than eight clubs loaded the engine falls back to a published constant, and
   every projection running on the fallback says so.

## Changing it

Constants live in `mlb/params.js` with the reason for each value written
beside it. Change one, run `npm run mlb:model`, and expect the calibration
assertions (league-average total, home-field win rate) to move — they are
pinned deliberately so a constant cannot drift without someone deciding it
should. `npm run mlb:terminal` covers the surface that renders it.
