# football/cfb_ev — the EdgeDesk EV Intelligence Engine's research side

The engine itself is `lib/edgedesk_ev.js` (`window.EDEV`). This folder holds
the data, calibration, studies and governance behind it. For the method, see
`docs/edgedesk-ev/DESIGN.md`; for the pre-registered rules, `PREREG.md`; for the results,
`DELIVERABLE.md`.

| File | What |
|---|---|
| `dataset.js` | Calibration rows through the production curve path (`v1Dist → EDRead.buildCurve → sideProb`) → `data/cfb_ev_calibration_rows_v1.csv.gz` |
| `calibrators.js` | identity, temperature, Platt, beta, rolling Platt, isotonic, Venn-Abers; Brier, log loss, slope/CITL, ECE, reliability, Murphy decomposition |
| `tournament.js` | Walk-forward tournament, promotion (PREREG §5), audits, one-time 2026 holdout → `artifacts/cfb_ev_calibration_v1/` |
| `market_study.js` | De-vig benchmark, favourite-longshot, historical replay → `reports/market_study_v1.json`, `reports/replay_v1.json` |
| `staking_sim.js` | Kelly stress test (staking stays disabled) → `reports/staking_sim_v1.json` |
| `demo.js` | The current-slate demonstrations → `reports/demo_v1.json` |
| `freeze.js` | The prospective next-100 freeze → `next100_freeze.json`, `versions.jsonl` |
| `policy/cfb_ev_policy_v1.json` | The EV decision policy (SHADOW, betting off), with the provenance of every number |
| `current.json` | The calibrator, policy and engine the terminal build reads |
| `ev.test.js` | 232 checks: formulas, fixtures, fail-closed paths, properties, governance, the real slate |

```
npm run cfb:ev:test                 # the test suite (also part of npm test)
npm run cfb:ev:tournament:check     # rebuild the calibrator and fail if it differs from the committed one
npm run cfb:ev:freeze               # freeze status and drift
node football/cfb_ev/dataset.js --replay <dir>/out/disagreement_replay.jsonl --data <dir>   # rebuild the rows (needs the CFBD cache)
npm run cfb:ev:market               # needs the cfbfastR betting archive in the same cache
npm run cfb:ev:staking
npm run cfb:ev:demo
```

The rules:

- A new calibrator or policy is a **new version directory** plus an edit to `current.json`. It is never an edit in place.
- The 2026 holdout is read once: `tournament.js` logs the read in `holdout_access.jsonl` and refuses a second one.
- After the freeze, a change to `lib/edgedesk_ev.js`, `calibration.json` or the policy needs a version
  bump or `freeze.js --patch "reason"`. The test suite fails on unrecorded drift.
- Raw EV is always labelled EXPERIMENTAL. While the policy is SHADOW, a policy BET is shown as RESEARCH ONLY.
