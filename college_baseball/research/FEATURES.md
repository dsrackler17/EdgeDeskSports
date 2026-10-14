# Feature catalog

Every input a model sees. "Known at" is relative to the prediction time
(14:00 UTC on the game date, `PROTOCOL.md` §1); a feature known only after it is
a leak and is not used. Status: **PRICE** (in the published price), **TESTED**
(measured, recorded in the registry, not in the price), **REJECTED**,
**BLOCKED** (no authorised source).

## Team strength and context (all seasons, 2012–2026)

| Feature | Definition | Known at | Used by | Status |
|---|---|---|---|---|
| Final scores of earlier games | runs for/against of every completed game, opponent-adjusted | 06:00 UTC the next day | team quality, every baseline | PRICE |
| Home / neutral site | the source's venue flag; NCAA-tournament hosts by `bats_last` when two sources agree | schedule | team quality, calibration | PRICE |
| Conference and division membership | season-specific, from the source's team table | before the season | hierarchical prior | PRICE |
| Park | the home program's venue (neutral games share a pooled park) | schedule | park effect (shrunk) | PRICE |
| Last season's rating | carried over with tuned regression | before the season | prior | PRICE |
| Rating uncertainty | Laplace posterior sd, larger for weakly connected teams | as ratings | Gauss-Hermite integration | PRICE |
| Scheduled seven innings | doubleheader position and the measured share of seven-inning games | schedule | 7-inning mixture | PRICE |
| Run-rule probability | measured share of eligible games ended by the ten-run rule, by context | rules evidence (earlier seasons) | simulator | PRICE |
| Played yesterday (batting side, pitching side) | each team's previous game date | schedule | rest layer (H-ENV-1) | PRICE when `hier_rest_cal` is the pricing model, else TESTED |
| Doubleheader game 2 | second game of a same-day pair | schedule | rest layer | TESTED (coefficient ≈ 0) |
| Weekend, conference game, tournament, days into season | calendar facts | schedule | GLM / GBM (H-ML-1) | REJECTED |
| Elo, Massey, Pythagenpat probabilities | the baselines' own predictions | as ratings | stacked ensemble | PRICE when the ensemble is the pricing model |

## Pitching (box scores, 2024–2026)

| Feature | Definition | Known at | Used by | Status |
|---|---|---|---|---|
| Pitcher component rates | K, BB, HBP, HR, H per batter faced, shrunk (n0 63/53/113/334/195 BF) | after each game | starter and bullpen quality | TESTED (CBX-PITCHER-HYBRID not significant) |
| Pitch counts | box-score pitches, else 4.2 × batters faced | after each game | workload, availability | TESTED |
| Bullpen availability | logistic model of appearing given rest and recent pitches | after each game | available bullpen quality | TESTED |
| Projected starter | conditional-logit on rotation order, days of rest, recent starts, quality | after each game | starter scenarios (PROJECTED) | shown as a scenario; not in the price |
| Confirmed starter | an announced starter with a timestamp | — | — | BLOCKED (U-11) |

## Offense and defence (box scores, 2024–2026)

| Feature | Definition | Known at | Used by | Status |
|---|---|---|---|---|
| Component offense | opponent-adjusted 1B/2B/3B/HR/BB/HBP/K/SB rates × college linear weights | after each game | blend with the team model (H-OFF-1) | TESTED: accepted on 2025, not yet in the price (needs a fresh season) |
| Defence | errors, unearned-run share, double plays, stolen-base control, defensive efficiency | after each game | H-DEF-1 | REJECTED |

## Not available

| Feature | Why |
|---|---|
| Weather as forecast | no authorised forecast archive; realised weather would leak (U-06) |
| Lineups, injuries, travel distance | no authorised source carries them for college baseball |
| Market prices | no authorised `baseball_ncaa` odds feed (U-02) |
| Base-out states (RE24) | needs runner reconstruction from text (U-07) |
