# football/cfb_validation — live validation, governance and the since-upgrade freeze

This directory holds **no model**. It reads what EdgeDesk already produces
(the Model Lab ledger, the research terminal's board and history, the
governance log, the V1 engine's own state) and turns it into evidence:
what the current version has earned on live games, apart from what it earned
in reconstruction, apart from what the market did, apart from what a betting
policy would have done.

| File | What it is |
|---|---|
| `core.js` | pure functions: views, scorecards, signals, postmortems, triggers, backlog, next-100, weekly report, projection-change attribution |
| `freeze.js` | the since-upgrade freeze: fingerprints the PRICING / RESEARCH / DECISION paths, writes `champion.json` and the RELEASE rows of `versions.jsonl`, and appends a PATCH row whenever a fingerprint drifts |
| `divergence_backtest.js` | walk-forward backtest of rating-state divergence vs error (DEV 2015–2021 / HOLDOUT 2022–2025 / LIVE 2026) |
| `build.js` | writes every artifact below; `--check` builds and prints without writing (a smoke run on the committed ledger), `--offline` uses the cached schedule feed only |
| `tests.js` | the core, freeze and backtest contracts |

## Artifacts

| Artifact | Written | Read by |
|---|---|---|
| `champion.json` | once, by `freeze.js --init` | build, dashboard, maturity page |
| `versions.jsonl` | append-only (one RELEASE row per path, then PATCH rows) | views (version / epoch of every snapshot) |
| `next100_plan.json` | once, by `freeze.js --init` | next-100 progress; never rewritten, so no baseline can be retrofitted |
| `live.json` | every build | dashboard (north star, views, separation, scorecard, triggers, backlog, next-100); research terminal record page |
| `divergence.json` | every build | dashboard (the 138-team monitor); the terminal build computes each game's value from the same inputs |
| `divergence_backtest.json` | `npm run cfb:validation:backtest` | the monitor's bands, the terminal build's game cut-offs, the backlog candidate |
| `maturity.json` | every build | maturity page (`research/cfb/#/maturity`), app model-status card, dashboard |
| `signals.json` | every build | verified-major vs investigate scorecards |
| `postmortems.json` | every build | win/loss postmortems |
| `slate_audit.json` | every build | current-slate status audit |
| `changes.json` | every build | what changed since last week / attribution |
| `weekly/<season>-wNN.{json,md}` | once per completed week | weekly executive report |
| `backlog.jsonl` | append-only | research backlog (OPENED / UPDATED / CLOSED events; never implemented automatically) |
| `system_history.jsonl` | append-only | "what changed since last visit" for the system itself |

## Commands

```
npm run cfb:validation            # build every artifact
npm run cfb:validation:check      # build and print, write nothing (smoke run)
npm run cfb:validation:test       # canon + core + UI contracts
npm run cfb:freeze:status         # fingerprints vs champion.json
npm run cfb:validation:backtest   # rebuild divergence_backtest.json from a replay
node football/cfb_validation/freeze.js --init --effective-at <ISO> --now <ISO>   # a NEW release only
```

`freeze.js --init` refuses to overwrite an existing `champion.json`: a freeze
is re-declared only by a governed promotion, never to reset a bad week.

Terminology, thresholds and every status word come from
`lib/edgedesk_canon.js`. See `docs/cfb-validation/DELIVERABLE.md`.
