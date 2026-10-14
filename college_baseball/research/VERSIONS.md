# Model versions

A model version is the code, the tuned parameters and the evidence it was
promoted on. The version string is `MODEL_VERSION` in `config.js`; every board
file, registry record and audit entry carries it. Promotion is recorded by
`audit.js --promote` in `params/production.json` (current) and
`research/audit_log.jsonl` (every promotion and refusal, append-only), with a
SHA-256 fingerprint of the evidence files.

| Version | Date | What it is | Promotion evidence |
|---|---|---|---|
| cbase_v1.0.0 | 2026-10-14 | First version. Hierarchical team model (tuning round 3) with run-space calibration (`hier_cal` prices; the ensemble and rest layer stay challengers); full-game prices from the negative-binomial closed form re-weighted to the validated P(home); the inning simulator for the first five only (research only); pitcher engines as scenarios only. | Promotion REFUSED by the auditor (critical TAILS check: P(side ≥ 15) over-predicted; U-15). `params/production.json` stays empty; the refusal, with its evidence fingerprint, is in `research/audit_log.jsonl`. Holdout looked at once: moneyline OUTCOME_VALIDATED on outcomes. |

## Rules for a new version

- Any change to a model, a tuned parameter, the calibration or the pricing
  path bumps `MODEL_VERSION` (minor for a re-tune, major for a new family).
- A new version gets its own holdout look (`walkforward.js --holdout`), which
  counts against the three-looks-per-family limit in `PROTOCOL.md`.
- A version that fails a critical audit check is never promoted; production
  stays on the previous version and the refusal is logged.
- Rollback: restore the previous `params/` and `board/` from git and re-run
  `build_slate.js` (docs/college-baseball/DEPLOYMENT.md).
