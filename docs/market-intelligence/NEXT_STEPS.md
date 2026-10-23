# Next steps, ranked (Phase 11)

Scores are engineering judgments on a 1–5 scale, not measured economics. A = research accuracy, B = model reliability, C = data integrity, D = subscriber value, E = revenue potential, F = engineering complexity (5 = simple), G = operating cost (5 = free), H = integration risk (5 = safe). **Benefit** = A + B + C + D + E; **ease** = F + G + H. Ranked by measurable benefit first, then ease.

| # | action | A | B | C | D | E | F | G | H | benefit | ease | why this rank |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Repair CFB FBS-vs-FCS pricing** (D-5): fit the map from rating gap to *uncapped* expected margin walk-forward on 2021–2025 FBS-vs-FCS games; judge on uncapped error (the bridge validation used capped error and could not see the −8.8-pt bias); promotion stays the owner's | 5 | 5 | 2 | 4 | 2 | 3 | 5 | 3 | 18 | 11 | the largest measured model error (7.8 pts vs the close, n 73, robust to dropping any week); one slice, one map, existing replay harness |
| 2 | **Deploy `close` (D-3)** and reproduce D-8 (capture's in-play writes, the "sharp" label on a consensus fair, `book_quote_ticks.seen_at`) before changing capture | 3 | 2 | 5 | 3 | 2 | 4 | 5 | 3 | 15 | 12 | CLV is the record the product points to; a close taken in-play corrupts it silently |
| 3 | **Show the validated calibration warning to readers**: route `MODEL_CALIBRATION_WARNING` (FBS-vs-FCS, from `validation.json`) into the research view's flags (`lib/game_research.js` `FLAG_RULES`) | 2 | 3 | 1 | 5 | 3 | 4 | 5 | 3 | 14 | 12 | the first finding with evidence behind it; a reader comparing the model with the close in those games deserves to know the model's record there |
| 4 | **Owner decision on D-7**: replace the graphics' "EDGE: NE +3" headline and the "pts vs Kalshi" strip (mid, before fees) with neutral "GAP" wording until a confirmatory hypothesis says a disagreement means something | 2 | 1 | 1 | 4 | 3 | 4 | 5 | 3 | 11 | 12 | the live record (H-001, H-006) says the market has been the better forecaster; release gate 7 |
| 5 | **Weekly re-run of the validation and backtest** (owner-triggered, or a workflow that uploads the generated docs as an artifact without committing) so the CONFIRMATORY hypotheses H-002, H-004, H-009–H-013 are judged as games are played | 4 | 3 | 2 | 2 | 1 | 5 | 5 | 5 | 12 | 15 | the infrastructure exists; only cadence is missing |
| 6 | Multi-book history once paid capture resumes (after 2026-11-01): keep a per-book, timestamped quote ledger for the probability sports, so SOURCE_DISAGREEMENT and reference quality (Phase 3.4) become measurable | 3 | 1 | 4 | 2 | 2 | 3 | 2 | 3 | 12 | 8 | blocked today by one free source |
| 7 | Signal store + dark-launched alert kinds (`AUDIT.md` §6) — only after a finding kind is ACCEPTED in a confirmatory test | 2 | 1 | 2 | 4 | 4 | 2 | 4 | 2 | 13 | 8 | the plumbing exists; the evidence does not yet |
| 8 | NBA reproducibility (the engine does not reproduce its committed selection; production changed after the sealed test opened) | 2 | 4 | 3 | 1 | 1 | 2 | 5 | 3 | 11 | 10 | a model that cannot be reproduced cannot be validated |
| 9 | Log the MLB live card's forecasts before the 2027 season; MLB tiebreak step 3 against the official text | 2 | 3 | 3 | 1 | 1 | 4 | 5 | 4 | 10 | 13 | off-season: cheap now, impossible to backfill later |
| 10 | `edp_entitled()` fail-closed like `sim_viewer_entitled()` (D-6) | 1 | 1 | 2 | 1 | 2 | 4 | 5 | 2 | 7 | 11 | latent; owner decision on how test databases should behave |

## The exact next implementation actions

1. **FBS-vs-FCS experiment** (action 1). Register it in `hypotheses.json` before fitting (H-014: "an uncapped margin map reduces FBS-vs-FCS MAE against real finals by ≥ 2 points, walk-forward 2021–2025, robust to dropping any season"). Data: the CFB replay harness (`football/fbs/efficiency_replay.test.js`, `model_loop/adapters/cfb/baselines/replay_cfb_p4.js`) and cfbfastR results (downloaded by `football/cfb_p4/research/fetch_data.sh`). Baseline: the shipped floor, scored **uncapped**. Keep the change behind a shadow file like `football/cfb_p4/margin_calibration.js` until the owner promotes it.
2. **Re-run** `npm run market-intel:report` after each week's games; read H-002, H-004, H-009–H-013.
3. **D-8 reproduction**: drive `supabase/functions/capture/index.ts` through the stubbed-import harness used by `tools/resilience/quota_guard.test.js` with a board that contains a started event, and check what reaches `signals` and `signal_ticks`.

## Commands

```
npm run market-intel:test       # the three suites (validation lab, engine, replay)
npm run market-intel:report     # regenerate VALIDATION.md, MARKET_INTEL_BACKTEST.md, model_registry.json
npm run market-intel:replay -- --event "CFB|401862801" --at 2026-10-16T18:00:00Z [--reveal]
npm run market-intel:replay -- --coverage
```
