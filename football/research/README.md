# Football Engine — research pipeline

Fully reproducible: raw public data → features → walk-forward training →
parameters + goldens + report. No API keys, no scraped private data.

```
./fetch_data.sh data          # nflverse + cfbfastR-data raw CSVs (~220 MB)
python3 build_features.py data out
python3 train_nfl.py out      # tunes on ≤2015 OOS, freezes, scores 2016-2025
python3 train_cfb.py out
python3 make_params.py out    # -> ../params.js (bundle + validation summary)
python3 gen_goldens.py out    # -> goldens.json (python-reference vectors)
python3 gen_report.py out     # -> report/BACKTEST.md
node ../tests.js              # JS engine must match python at 1e-9
```

Requires `python3` with `pandas` + `numpy`, and `node`.

## Discipline rules (why the numbers can be trusted)

* **Chronological only.** Ratings are one sequential pass; a game's features
  use nothing after its kickoff. Ridge coefficients refit before each season
  on prior seasons only. Never a random split.
* **Tune/test firewall.** Hyperparameters (EWMA alphas, season carryover, QB
  shrinkage, kernel bandwidths, caps, HFA) are chosen on 2003–2015
  out-of-sample rows, frozen, then 2016–2025 is scored untouched.
* **No fabricated market data.** Only closing consensus lines exist publicly
  for the NFL (no openers → no CLV backtest; beating the close is reported
  instead, which is harder). CFB has no public line archive; the CFB report
  claims nothing about the market.
* **Every learned constant ships with provenance** in `../params.js`, and
  `bettor_methodology_research.json` maps each philosophy-layer feature to a
  cited public source or marks it UNKNOWN.

## Files

| file | role |
|---|---|
| `fetch_data.sh` | download raw public datasets |
| `build_features.py` | team-game / QB-game / CFB game tables |
| `train_nfl.py` | NFL ratings + submodels + backtest + params |
| `train_cfb.py` | CFB ratings + backtest + params (own constants) |
| `make_params.py` | bundle → `../params.js` with validation summary |
| `gen_goldens.py` | python-reference parity vectors for `../tests.js` |
| `gen_report.py` | render `report/BACKTEST.md` |
| `bettor_methodology_research.json` | sourced philosophy-layer research |
| `report/` | committed backtest report + raw metric JSONs |
