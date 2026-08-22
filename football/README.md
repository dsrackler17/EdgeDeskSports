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

## Regenerating parameters

See `research/README.md`. Parameters are trained through the 2025 season;
the engine's data-quality gate BLOCKS predictions for seasons beyond
`trained_through_season + 1` rather than silently going stale.
