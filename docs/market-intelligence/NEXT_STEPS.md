# Next steps, ranked (Phase 11)

Scores are engineering judgments on a 1–5 scale, not measured economics. A = research accuracy, B = model reliability, C = data integrity, D = subscriber value, E = revenue potential, F = engineering complexity (5 = simple), G = operating cost (5 = free), H = integration risk (5 = safe). **Benefit** = A + B + C + D + E; **ease** = F + G + H. Ranked by measurable benefit first, then ease.

| # | action | A | B | C | D | E | F | G | H | benefit | ease | why this rank |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Repair CFB FBS-vs-FCS pricing, stage 2** (D-5): per-team FCS ratings (the bridge) walk-forward over several seasons, judged on **uncapped** finals. Stage 1, a level map, was tested and REJECTED (H-014: −0.10 pts [−0.23, +0.02]); the gap to the close is ordering (MAE 15.1 vs the close's 12.1), and the bridge's own 2026 rows show −0.95 [−1.46, +0.29] on real finals. Promotion stays the owner's | 5 | 5 | 2 | 4 | 2 | 2 | 4 | 3 | 18 | 9 | still the largest measured model error; needs historical FCS-vs-FCS results, which the bridge build only fetches for the base season |
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

1. **FBS-vs-FCS stage 2** (action 1). Stage 1 is done: `npm run cfb:fcs:uncapped` (`football/cfb_p4/research/fcs_uncapped.js`) ran the pre-registered level map, H-014 REJECTED ([`FCS_UNCAPPED.md`](FCS_UNCAPPED.md)). For stage 2:
   1. Fetch historical all-division results (FCS-vs-FCS included) for 2012–2025 into a cache: cfbfastR schedules via `football/cfb_p4/research/fetch_data.sh`. This is a free, public download; check the environment's network policy first.
   2. Generalise `football/enrichment/fcs/build_fcs.js` step 1 (base-season fit) and step 3 (in-season walk-forward) to run season by season, each FCS rating built only from games before kickoff.
   3. Register H-017 in `hypotheses.json` **before** the run: "per-team FCS ratings lower FBS-vs-FCS MAE against real finals versus the floor, pooled 2016–2025, interval below 0, a majority of seasons, robust to dropping any season".
   4. Score bridge vs floor (and bridge + the H-014 affine, if the bridge's own level is also short) with `lib/edgedesk_validation_lab.js`, on **uncapped** finals.
2. **Re-run** `npm run market-intel:report` after each week's games; read H-002, H-004, H-009–H-013, H-015, H-016.
3. **D-8 reproduction**: drive `supabase/functions/capture/index.ts` through the stubbed-import harness used by `tools/resilience/quota_guard.test.js` with a board that contains a started event, and check what reaches `signals` and `signal_ticks`.

## Commands

```
npm run market-intel:test       # the three suites (validation lab, engine, replay)
npm run market-intel:report     # regenerate VALIDATION.md, MARKET_INTEL_BACKTEST.md, model_registry.json
npm run market-intel:replay -- --event "CFB|401862801" --at 2026-10-16T18:00:00Z [--reveal]
npm run market-intel:replay -- --coverage
```
