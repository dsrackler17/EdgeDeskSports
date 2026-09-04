# EdgeDesk Football Engine (NFL + NCAA FBS)

One shared modeling architecture with two sport-specific feature layers,
integrated into the EdgeDesk app as the **Football** research module.

```
football/
  engine.js     the deterministic engine (browser + node, ES5)
                shared: odds/de-vig/EV/CLV math, margin & total distributions
                        with LEARNED key-number mass, win probability,
                        market comparison + honest edge classification,
                        data-quality gate, versioning, fingerprint caching
                nfl:    opponent-adjusted EPA rating recursion + QB layer +
                        koerner/sharp/stuckey/fezzik submodels
                cfb:    capped-margin iterative rating recursion + scoring
                        EWMAs, with CFB's OWN learned constants
  params.js     GENERATED trained parameters + provenance + the honest
                validation summary (never edit by hand)
  tests.js      node/browser test suite incl. python-parity goldens (1e-9)
  research/     the full reproducible training pipeline + backtest report
  INTEGRATION.md  how this plugs into the existing EdgeDesk/Supabase stack

  cfb_p4/       the CFB POWER 4 INTELLIGENCE MODEL — a separate, deeper engine
                for the SEC / Big Ten / Big 12 / ACC, with its own five-layer
                architecture (strength, talent, situation, matchup,
                uncertainty), its own parameters, and its own backtest against
                a real CFB line archive. See cfb_p4/README.md.

  players/      the PLAYER QUALITY + SCHEME MATCHUP ENGINE — every active FBS
                player rated 0-100 with provenance, rolled into position
                groups, team units, scheme profiles, a matchup engine, a
                run-defence gate and a seeded head-to-head simulator.
                It moves NO projection: its own walk-forward says it does not
                beat the Power 4 rating core out of sample, so it ships with
                `points_applied:false` and is published as research.
                See players/README.md.
```

## The honesty contract

The 2016–2025 walk-forward shows the NFL model **does not beat the closing
line** (49–51% ATS by gap size; market MAE 9.78 vs model 10.20). That result
ships inside `params.js` (`validation_summary`) and the engine's
`classifyEdge()` therefore never emits anything stronger than
`RESEARCH_LEAN`, always with `validated:false`. Per EdgeDesk doctrine the
model is UNPROVEN and counted nowhere until its own graded CLV against real
captured quotes beats the close. The v1 CFB layer was trained
without market data and therefore makes **no market claim at all**.

**Correction (superseded by `cfb_p4/`):** an earlier version of this file said
no public historical CFB line archive exists. That was wrong.
`sportsdataverse/cfbfastR-data` ships `betting/csv/cfb_line_odds.csv.gz` —
1.18M rows, 2006–2025, spread + total + moneyline, opening and closing, across
multiple books including Pinnacle, covering 94–100% of FBS-vs-FBS games from
2012. `football/cfb_p4` trains against it, and the honest answer is that that
model loses to the closing line by ~0.9 points of MAE
(`cfb_p4/research/report/BACKTEST.md`). The v1 constants in `params.js` are
unchanged: they were genuinely trained without market data, and re-labelling
them would be worse than leaving the record as it stands.

What IS validated out of sample:

* NFL projections track the market at 0.85 correlation with every layer
  earning its keep in ablations (EPA over points −0.64 MAE, season carryover
  −0.17, QB layer −0.03).
* CFB margin projections match the third-party pregame-Elo benchmark
  (13.11 vs 13.16 MAE) and crush home-field-only (16.37), with clean
  probability calibration (Brier 0.183).
* Key-number mass is learned, sport-specific, and conditioned on the spread:
  P(margin=3 | spread=3) = 8.8% in the NFL; CFB's 3 carries far less mass.
  (In `cfb_p4` the CFB conditioning variable is the real MARKET spread rather
  than the model's own projection, which the line archive made possible.)

## Running the tests

```
node football/tests.js           # exit 0 = green (69 checks incl. parity goldens)
node football/cfb_p4/tests.js    # exit 0 = green (65 checks incl. parity goldens)
```

## Daily self-check & model health

The models learn at runtime — every board load absorbs the latest completed
games into the trained seeds — and a scheduled job proves that path still
works every day:

```
node football/health/daily_check.js     # the same run the workflow does
```

`.github/workflows/model-health.yml` runs it daily (09:30 UTC, plus manual
dispatch and on engine/params changes). It re-runs the app's whole data path
headless: both engine test suites (python-parity goldens), the NFL and Power 4
ingest against the live feeds, projections over the upcoming slate with sanity
bounds, and a **line guard** that compares model fair spreads to the joined
market numbers — a gap beyond the hard bound (14 pts NFL / 21 pts CFB) is
flagged as a probable data fault (bad join, sign flip, FCS absorbed as FBS),
never presented as an edge. It also says loudly when the current season is
about to leave the engines' `trained_through + 1` window and a retrain is due.

The run commits `football/health.json`. The app reads that record and nothing
else: a clean run advances the Football module's freshness stamp (so the
"Stale — past its expected cadence" banner clears only when the pipeline
really ran), the per-job results render in the pipeline ledger, and every
board shows a **Model health** panel — the daily results plus a live line
guard computed from the numbers on screen right now. A failed run keeps the
last clean stamp, so a broken pipeline goes visibly stale instead of quietly
looking fresh; a missing file renders as "no published run", never invented.
The workflow turns red on any failing check so the repo owner is notified.

In the browser the module also re-runs its own load (and re-absorbs new
results) when the tab has sat on it for 6+ hours — the model keeps itself
current without anyone pressing refresh.

## Rosters

`.github/workflows/roster-sync.yml` commits full FBS rosters from ESPN's
public APIs to `football/rosters/` (weekly, and on demand with any
`--season`). `fetch_rosters.js` takes the season's true FBS membership
from the core API group, tops each roster up past the site endpoint's
100-player cap via the core athlete index, and refuses to commit a
wrong-shaped dataset.

In the app, CFB lives entirely under the Football tab: the **CFB Rosters**
segment browses every FBS team's player-level roster (each player's
observed status — returning, transfer with the program they left, or new
to the covered set), and every Power 4 game card opens a **Rosters
head-to-head** panel: five players to watch per side (ordered by position
value — EdgeDesk view weights, not trained parameters — seniority, portal
status and the previous program's seed rating) plus a position-by-position
comparison graded on returning share + class-mix experience. Both say
plainly that production and per-player talent exist in no public feed:
they are roster-construction reads, never performance rankings, and no
model number reads them.

`espn_to_bundles.js` (browser + node) turns those datasets into the exact
roster bundles the Power 4 engine's talent layer reads: returning share
and portal in/out from athlete-id diffs against the previous season's
dataset, experience as the trained (class−1)/3 mix from ESPN's live
current class. The app uses cfbfastR as the primary roster source and
falls back to these bundles when cfbfastR has not published the season;
an FBS newcomer absent from the previous dataset gets continuity =
unknown, never zero. What the roster layer can and cannot move is the
engine's own honest contract: stability, youth, OL and volatility inputs
and fewer declared unknowns — the mean spread shifts only on per-player
recruiting stars, which no public feed carries.

## Player quality

`football/players/` answers the question the roster layer above cannot: not
*how many* players are back, but **who is back, how good they are, and whether
what they do well attacks what the opponent does badly.**

Every active FBS player carries an **EdgeDesk Player Impact Rating** (0-100,
where 50 is positional replacement and 12 points is one standard deviation of
that position's own qualified population), built from cfbfastR's public
play-attribution table, opponent-adjusted, and shrunk toward the prior by a
constant `k = n̄(1−r)/r` **measured** from each position group's own observed
season-to-season reliability. Every rating ships its confidence, its sample,
its data completeness, every component used and every component missing.

The layer feeds a matchup matrix, scheme edges, a **run-defence gate**, a
player edge board, a seeded Monte Carlo simulator, a sensitivity analysis and a
**Linemaker view** that keeps RAW MODEL, PLAYER-ADJUSTED, SCHEME-ADJUSTED,
SIMULATION and MARKET as five separate numbers. It lives in the Football tab's
**Players** segment and under every Power 4 game card.

**It changes no projection anywhere in EdgeDesk.** Held out on 2024-2025, the
player layer moves spread MAE by 0.018 points (paired p = 0.40, and worse in
2024), so `params.js` ships `points_applied:false` and the Linemaker view shows
the player and scheme rungs flat on the raw model with the p-value on screen.
The bar for moving a line is lower holdout MAE **and** a paired test at p<0.05
**and** an improvement in every holdout season separately; the day the layer
clears it, `validate.js` flips the flag and the ladder starts moving with no
code change. Full record: `players/README.md` and `players/report/BACKTEST.md`.

Three things it says out loud rather than hiding: no public feed publishes a
college snap count (role is touch share, and is labelled as such); no public
feed attributes a block, a tackle or a pressure short of a sack (so an
offensive lineman has an EMPTY measure contract and his unit is rated from the
team's own observed sack and stuff rates instead); and no legal public
recruiting feed is wired in (the adapter exists, every recruiting field is
null, and the recruiting data-quality dimension is zero on purpose).

```
node football/players/build_players.js --season 2026 --seasons 4
node football/players/players.test.js            # 275 checks
node tools/football/player_quality_ui.test.js    # 74 checks over the real page
```

`.github/workflows/player-ratings.yml` rebuilds and commits the datasets twice
a week in season. It deliberately does NOT run the validator: recalibrating on
a schedule is how a layer quietly starts fitting the recent past.

## Regenerating parameters

See `research/README.md`. Parameters are trained through the 2025 season;
the engine's data-quality gate BLOCKS predictions for seasons beyond
`trained_through_season + 1` rather than silently going stale.
