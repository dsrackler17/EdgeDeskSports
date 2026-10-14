# Model versions

A model version is the code, the tuned parameters and the evidence it was
promoted on. The version string is `MODEL_VERSION` in `config.js`; every board
file, registry record and audit entry carries it. Promotion is recorded by
`audit.js --promote` in `params/production.json` (current) and
`research/audit_log.jsonl` (every promotion and refusal, append-only), with a
SHA-256 fingerprint of the evidence files.

| Version | Date | What it is | Promotion evidence |
|---|---|---|---|
| cbase_v1.0.0 | 2026-10-14 | First version. Hierarchical team model (tuning round 3), negative-binomial runs, run-space calibration, rest challenger, stacked ensemble when it beats the single model, inning simulator, pitcher engines as scenarios only. | `params/production.json` and `research/audit_log.jsonl` (fingerprint of walkforward, pitcher, distribution and simulator evaluations, tuning and constants) |

## Rules for a new version

- Any change to a model, a tuned parameter, the calibration or the pricing
  path bumps `MODEL_VERSION` (minor for a re-tune, major for a new family).
- A new version gets its own holdout look (`walkforward.js --holdout`), which
  counts against the three-looks-per-family limit in `PROTOCOL.md`.
- A version that fails a critical audit check is never promoted; production
  stays on the previous version and the refusal is logged.
- Rollback: restore the previous `params/` and `board/` from git and re-run
  `build_slate.js` (docs/college-baseball/DEPLOYMENT.md).
