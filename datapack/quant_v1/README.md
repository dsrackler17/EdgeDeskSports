# EdgeDesk Quant Data Pack — historical starter + precise contracts

Start with `CLAUDE_START_HERE.md`, then `COVERAGE.md` and `DATA_INVENTORY.json`.

## What is actually included

- Three complete downloaded NFL PBP season files (2022–2024), each preserving all 372 source columns: EPA, completion models, game state, players, opportunities and contextual fields. These include provider model outputs and retrospective revisions.
- Computed NFL team/game efficiency, player/game opportunities, game labels and exposure-weighted prior-5/10/20-game features. Target-event statistics are excluded. These are historical research tables, not a validated betting model.
- MLB 2024 schedule/results and 8,800 measured pitches from 30 systematically spaced completed regular-season games: velocity, movement, release/plate location, spin and batted-ball measurements where actually available.
- NHL schedules/results and 72 sampled games with 23,203 native event records, 9,895 extracted shot attempts, deduplicated player boxes and 171 goalie appearances. Expected goals and GSAx are deliberately blank because no approved calibrated shot-quality feed/model was obtained.
- Historical NBA/WNBA, NCAA men's/women's basketball, CFB and college baseball samples; soccer results; filtered men's/women's tennis singles; 566 UFC bout results. Exact counts and grains are in `COVERAGE.md`. Some feeds are samples or filtered responses, not verified full seasons.
- 43 canonical relational contracts, 1,406 field definitions including shared metadata, valid JSON Schemas, header-only templates clearly outside `data/`, and SQLite DDL.
- 136 base quantitative feature definitions plus 508 explicit rolling-window configurations. Definitions are not assertions that every feature is computed/populated.
- Source/access/rights registry, verified download provenance, count/missingness inventory, published methodology references, collection priorities, working historical collection scripts, tested quant primitives, and implementation instructions.

## Folder guide

| Path | Purpose |
|---|---|
| `data/` | Real downloaded facts and explicitly named derived research tables |
| `schemas/` | Typed contracts, JSON Schema, dictionary, formulas and EMPTY templates |
| `docs/sports/` | Prioritized collection and feature plan for each primary league |
| `sources/` | Source registry, access gaps, hashes, timestamps and observed-column inventory |
| `scripts/` | Bounded public-data collection, deterministic NFL transforms, quant math, verification |
| `tests/` | Probability, settlement, time-availability and unit-conversion checks |
| `VERIFICATION.json` | Verification result; does not certify predictive performance |

## Scope and limitations

This ZIP contains real historical data, not every stat ever recorded across every sport. Primary coverage contracts: NFL, CFB, NHL, NBA, WNBA, NCAA men's/women's basketball, MLB, NCAA baseball, soccer, ATP/WTA tennis and UFC/MMA. Golf, cricket, rugby, boxing, motorsport and esports have extension specifications only.

Historical first-publication timestamps are not reconstructed. `known_at` remains blank where unknown; never substitute `retrieved_at` or scheduled start. No current quote dataset or claimed positive-EV bet is included. Provider restrictions and incomplete advanced feeds are recorded rather than disguised with synthetic rows.

Source facts are separate from modeled values. Native coordinates and labels remain native until mappings are verified. Clinical-looking confidence scores, guessed probabilities, fabricated injury history and invented tracking do not belong in this warehouse.

## Local use

Python 3.10+ is required. Quant math and verification use the standard library. The optional NFL recomputation requires pandas. There are no embedded credentials and no paid-provider calls.

```bash
python -m unittest discover -s tests -v
python scripts/verify_pack.py
# Optional; install pandas in your environment first:
python scripts/build_nfl_features.py
```

Attach this ZIP to Claude, ask it to read `CLAUDE_START_HERE.md`, and give it the existing EdgeDesk repository. Load the package as data/assets; preserve working model infrastructure.

Attribution: NFL PBP source data by nflverse, licensed CC-BY-4.0 at the repository; derived NFL tables in this pack are modifications. Other factual source records identify MLB/ESPN in their provenance; applicable provider terms remain in force. No permission for commercial redistribution is inferred from public API access. No MoneyPuck, StatsBomb, Sackmann mirror or UFCStats advanced dataset is included.
