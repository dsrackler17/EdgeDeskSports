# The EdgeDesk Quant Data Pack — how it was integrated

The pack arrived as four archives. It is imported, byte for byte, into
`datapack/quant_v1/` (`IMPORT.json` records each archive's size and SHA-256).
I read `CLAUDE_START_HERE.md` and `COVERAGE.md` first. The pack calls itself
historical research data with contracts, not a trained model or a betting
feed, and nothing here treats it as more than that.

## What arrived, and what did not

| Archive | Contents | State |
|---|---|---|
| `EdgeDesk_01_Core_and_Other_Sports.zip` | docs, 43 contracts, 136 features, 14 sources, scripts, 42 tables | imported |
| `EdgeDesk_02_NFL_2022.zip` | **0 bytes** | **NFL 2022 play-by-play is MISSING** (expected SHA-256 `0c69a71e…`, 49,434 rows); not reconstructed |
| `EdgeDesk_03_NFL_2023.zip` | NFL 2023 play-by-play, 19 MB | verified; kept outside git in `.cache/datapack` |
| `EdgeDesk_04_NFL_2024.zip` | NFL 2024 play-by-play, 19 MB | verified; kept outside git in `.cache/datapack` |

`tools/datapack/fetch_external.js` re-fetches the out-of-git files from
nflverse and accepts them **only on a matching SHA-256**. nflverse revises
play-by-play in place, so a changed file is `REVISED_AT_SOURCE` and is never
used as the pack's file.

## Verification (`tools/datapack/verify.js` → `EDGEDESK_VERIFICATION.json`)

This re-implements the pack's own `verify_pack.py` in Node. That script is
never executed: the pack is data, not trusted code. The verifier also adds
the checks the import needs. Result: **PASSED**. 44 of 45 tables are verified
by SHA-256, row and column counts; 1 is missing (above).

- `known_at` is blank on every historical row, so nothing is backdated.
- The 43 contract tables are unique, their columns match their JSON Schemas,
  and the SQLite DDL creates all 43.
- Every EMPTY_TEMPLATE is empty.
- All 40,992 NFL prior-5/10/20 lag values were recomputed, with target-game
  and same-day exclusion: 0 errors.
- NHL and goalie xG and GSAx were never invented.
- Tennis draws are separated and matches are unique.
- 584 source-manifest hashes are verified.
- No table is unlisted.

`engine/quant.js` ports the pack's `quant_math.py`: prices, no-vig, EV with
pushes and voids, quarter-line split settlement, baseball outs and the
fail-closed as-of rule. It is held to the pack's own test cases.

## The pack's instructions, step by step

1. **Contracts and ID mapping, without replacing working systems.** Ingestion
   (`*/ingest.js`), deterministic models (`*/model.js`, `*/walkforward.js`)
   and the desk's explanations stay separate. The desk reads probabilities
   from slates and never generates one. The ID mappings are:
   - ESPN↔NHL: `hockey/data/crosswalk/espn_nhl_2025.csv`, 1,398 games;
   - ESPN↔sportsdataverse: the same game IDs;
   - ESPN↔openfootball: by date and club;
   - nflverse game IDs.
2. **Native fields to canonical contracts, with units, availability and
   quality flags.** `hockey/contracts/canonical.js` validates three NHL tables
   row by row (zero errors) and gives a reason for every always-empty field.
   Time follows the pack's rule:
   - `known_at` is blank;
   - `assumed_available_at` is explicit;
   - `pit = RETRO`;
   - every record says RETROSPECTIVE.
3. **NHL first** (`docs/engine/NHL.md`):
   - **Shots:** approved shot data and the walk-forward xG model.
   - **Goalies:** starts are verified against a second source (156 of 160 are
     the most-TOI goalie; the 4 exceptions are pulled starters). Goals against
     agree 167 of 167.
   - **Strength-state rates:** time and xG by 5v5, 4v4/3v3, PP, SH and empty
     net.
   - **Lineup availability:** built and measured. Confirmed lineups help
     (−0.0009 log loss), but no pregame feed exists, so they are not in the
     price.
   - **Scoring distribution:** out of sample, with the moneyline and puck line
     validated against outcomes.
   - **Still missing:** shift charts (available at the source, not ingested),
     goalie TOI, and shots on goal faced.
4. **Every other sport, from its own data:**

   | Sport | Brain | Data |
   |---|---|---|
   | Basketball ×4 | `basketball/` | 2008/2010–2026 |
   | Soccer ×5 | `soccer/` | — |
   | MLB | `mlb/history/` | — |
   | UFC | measured only | — |
   | NFL, CFB | existing brains | — |

   The pack's ESPN seasons are reconciled against each brain's source
   (`EDGEDESK_CROSSCHECK.json`). Where the pack has games the source lacked,
   it fills them, labelled: 209 women's college games from 2024-25, mostly
   the March tournaments. 2024 MLB comes entirely from the pack (without
   starters). College baseball (313 games) and tennis (two four-date samples)
   are too sparse for a model and say so.
5. **Adapters.** All of them go through `engine/http.js`, which provides:
   - a disk cache and ETag revalidation (incremental: completed seasons are
     cached for 30 days, the current season for hours);
   - bounded retries honouring Retry-After;
   - in-flight dedupe;
   - per-provider run/day quotas and a circuit breaker;
   - registered free hosts only.

   Job dedupe is handled by workflow concurrency groups. Missingness
   diagnostics are in `engine/missingness.json`. No paid call was added. The
   odds key is reachable only through `odds_gateway`, and NHL prices stay
   disabled until authorised.
6. **Chronological train/tune/calibrate with held-out evaluation.** This is
   `engine/lab/protocol.js`, applied unchanged to every league. Revision
   leakage is audited on every prediction: 0 violations everywhere, after the
   NCAA audit caught and forced a fix of a day-grouping leak. No props were
   added: none has a validated model.
7. **One cross-sport board at verified, fresh prices.** `lib/edgedesk_xboard.js`
   v2 handles pushes, voids and split settlement, and adds a sensitivity gate
   (worst scenario, a worse tick, another reference). Without a fresh price
   every row is research, and the board says **PASS**.
8. **The UI keeps the stages apart.** The Engine panel's readiness ladder
   shows, per sport: historical data loaded · model trained · validation
   passed · tested against closing prices · market price verified now ·
   actionable signal.

## What is still missing

- Licensed, timestamped closing prices for any sport. Without them no market
  can be MARKET_VALIDATED, and no value claim is ever on.
- Injury, lineup and availability archives for every sport.
- NFL 2022 play-by-play (the upload was empty).
- Soccer xG; UFC round statistics (UFCStats refuses automated access); serve
  and return data for tennis; a complete college-baseball archive.
- Retrosheet's 2024 and 2026 game logs.
- Owner review of terms before any paid use. NHL.com, ESPN, MLB and Retrosheet
  each have their own terms; openfootball is public domain; nflverse is
  CC-BY-4.0.
