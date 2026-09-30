# football/coaching — who coaches a programme, and whether it is in a regime change

Two artifacts live here. The published CFB build (`football/fbs/build_coverage.js`) and the
board (`app.html`, through `football/matchup/contract.js`) both read them, so a number on the
board and the number in the published slate are priced from the same facts.

| file | built by | what it says |
|---|---|---|
| `continuity.json` | `build_coaching.js` | the head coach of every FBS programme and the season the tenure began (`new_hc` = the tenure began this season; `null` = unknown, never "continuous") |
| `regime.json` | `build_regime.js` | whether each programme is in a **REGIME CHANGE** this season, and why |
| `regime_overrides.json` | by hand | dated, sourced corrections the feeds miss (see below) |
| `returning_production_<season>.json` | `football/cfb_p4/research/build_regime_history.py` | the share of last season's production still on the roster |
| `regime_signal.js` | — | the one definition of the signal (shared by the fit, the builder and the tests) |

## The regime-change signal (audit 2026-09-30 #1)

A programme is in a regime change when its long-run pricing state describes a team that no
longer exists:

```
fires = new head coach (the tenure began this season)
        AND ( returning roster share   <= the season's FBS median
           OR returning production     <= the season's FBS median
           OR transfers out            >= the season's 75th percentile
           OR no continuity measurement at all )
```

Continuity is compared **within the season** (percentiles among that season's FBS teams),
because the level drifts with the portal. An unknown coach change (`null`) never fires.

When it fires:

* **the engine** (`football/cfb_p4/engine.js`) weights the programme's long-run state on a
  separate, steeper curve, `w = min(w_standard(g), w0·e^(−λg))`, fitted walk-forward on
  past coaching-change team-seasons (`football/cfb_p4/research/regime_backtest.js`, written to
  `football/cfb_p4/regime_curve.js`; the held-out record is in
  `football/cfb_p4/research/report/regime_backtest.json`). A promoted canonical rating is
  priced as published, but the flag is still carried on it.
* **the research gate** (`lib/edgedesk_canon.js`) blocks WORTH RESEARCHING and VERIFIED MAJOR
  DISAGREEMENT until the team has played `min_games_for_research` games this season (N, from
  the same backtest). The game reads **INVESTIGATE**, with the REGIME CHANGE flag named.
* **player props** (`football/props/model.js`) scale last season's usage and volume priors by
  the same curve, relative to the standard one, and cap a regime team's props below BET until
  N games (`REGIME_CHANGE`, `lib/edgedesk_props.js`).

## `regime_overrides.json`

A hand-maintained table for the facts the automated reads miss or get wrong. One entry per
team-season:

| field | meaning |
|---|---|
| `team` | the programme's school name, e.g. `"Iowa State"` |
| `season` | the season the entry applies to (only that season) |
| `new_coach` | `true` / `false`, or `null` to keep the coach table's answer |
| `returning_production_pct` | 0–100, the share of last season's production still on the roster, or `null` to keep the automated measure |
| `source` | where the fact was verified: a URL or a named document (**required**) |
| `note` | optional |
| `entered_at` | ISO date the entry was made (**required**) |

`build_regime.js` applies an entry over the automated reads for that team-season only, and
refuses — and lists in `regime.json` under `sources.overrides.refused` — any entry without a
team, a source or a valid `entered_at`, or with an out-of-range value. An override never invents a signal: it supplies a fact, and the same signal
function decides.

```
node football/coaching/build_coaching.js          # continuity.json
node football/coaching/build_regime.js            # regime.json (reads the overrides)
node football/coaching/build_regime.js --check    # build and print, write nothing
node tools/football/regime.test.js                # the signal, the curve, the engine, the gate
```
