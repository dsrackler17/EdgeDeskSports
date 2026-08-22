# CFB Power 4 — research pipeline

Fully reproducible: public data → features → walk-forward training → parameters,
goldens and the backtest report. No API keys, no scraped private data.

```
./fetch_data.sh data              # cfbfastR-data raw files (~1.5 GB)
export CFB_P4_DATA=data
python3 ep_surface.py fit out      # EP surface fitted to real pbp EPA
python3 build_market.py out        # the CFB line archive -> one row per game
python3 build_team_game.py out     # play feed -> team-game efficiency + QB games
python3 features_roster.py out     # rosters -> continuity, portal, class mix
python3 train_p4.py out            # ratings, venue, rivalry, blend, volatility, market backtest
python3 train_layers.py out        # QB, QB absence, schedule, total, score weights
node backtest_engine.js --data "$CFB_P4_DATA" --from 2022 --to 2025
                                   # replays the SHIPPED engine over the held-out
                                   # seasons; this is the headline, because
                                   # train_p4.py scores the rating core rather
                                   # than the nine-term number engine.js emits
python3 make_params.py out         # -> ../params.js
python3 gen_goldens.py out         # -> ../goldens.json
python3 gen_report.py out          # -> report/BACKTEST.md
node ../tests.js                   # must exit 0
```

Requires `python3` with `pandas`, `numpy` and `pyarrow`, and `node`.

## Discipline rules (why the numbers can be trusted)

* **Chronological only.** One sequential pass in kickoff order. A game is
  predicted from the state before it, then absorbed. Never a random split.
* **A layered tune/test firewall**, because the sources do not all start in the
  same year:

  | layer | what | tuned on | tested on |
  |---|---|---|---|
  | A | ratings, venue HFA, travel, rivalry, conference | 2001–2013 | 2014–2025 |
  | B | efficiency, matchup, blend, QB, schedule, total | 2014–2019 | 2020–2025 |
  | C | roster continuity, volatility, confidence | 2018–2021 | 2022–2025 |

  The headline market backtest is **2022–2025**, untouched by every layer.
* **Effects are permutation-tested.** A coefficient that a shuffled feature
  reproduces is reported as such, and its confidence is set from the test.
* **Nothing is asserted.** Rivalries are detected from meeting frequency,
  campus proximity and measured residual behaviour, never typed in. Conference
  membership is derived from the schedules. Venue geography comes from the data.
* **Negative results ship.** `report/BACKTEST.md` leads with the fact that the
  model loses to the closing line, and lists everything the fits rejected.

## Data traps this pipeline exists to handle

Each was found by execution, and each would silently corrupt the model:

1. **`team` in `player_stats` is not reliably the offence.** On 31% of sack
   rows it is the team that MADE the sack, and 7% of drives carry more than one
   `team` value. Every row is re-anchored to its drive's offence, derived from
   unambiguous rushes and completions.
2. **`team_score`/`opponent_score` follow `team`,** so they flip perspective on
   exactly those rows — and they are POST-play, so the pre-play state used for
   garbage time is the previous play's value.
3. **`team_info` carries a CURRENT-SNAPSHOT conference for every season.** The
   2014 file lists the 2024 realignment. It is used only for venue geography;
   season-accurate membership comes from the schedules themselves.
4. **The bare `down`/`distance` columns in the pbp files are junk** (93.7% null,
   every non-null value 1 and 10). The real state lives in `start.*`.
5. **pbp 2016 week 2 is corrupt** — end-of-play field position pinned at 99,
   which alone drags 2016's team-game EPA SD from ~0.23 to 0.76. It is excluded.
6. **Play-by-play stops at 2022** while `player_stats` runs to the current
   season, so recent efficiency is rebuilt from the lighter table and scored
   with an EP surface fitted to the real pbp. That reconstruction is
   cross-validated on the 2014–2022 overlap (team-season EPA/play r = 0.92,
   success rate r = 0.96, yards/play r = 0.97).
7. **Roster class year is unusable before 2014** and only reaches 75% coverage
   in **2018**, which is why the roster-dependent layer is tuned from 2018.
8. **`recruit_ids` ships empty** in the public roster feed, so per-player
   recruiting stars — and therefore any true blue-chip ratio — do not exist
   here. That layer stays dark rather than being faked.

## Files

| file | role |
|---|---|
| `fetch_data.sh` | download the raw public datasets |
| `common.py` | canonical team identity, season-accurate conferences, venues |
| `ep_surface.py` | fit and apply the Expected Points surface |
| `build_market.py` | the betting archive → one market row per game |
| `build_team_game.py` | play feed → per-team-game efficiency and QB games |
| `features_roster.py` | rosters → continuity, portal flow, class mix, production |
| `train_p4.py` | ratings, venue HFA, rivalry, blend, volatility, distributions, market backtest |
| `train_layers.py` | QB, QB absence, schedule stress, total pace, score weights |
| `make_params.py` | bundle → `../params.js` with provenance and the record |
| `gen_goldens.py` | python-reference parity vectors for `../tests.js` |
| `gen_report.py` | render `report/BACKTEST.md` |
| `report/` | the committed backtest report |
