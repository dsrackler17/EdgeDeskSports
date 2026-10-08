# System integrity

**Accuracy first. Reliability second. Reader value third. Distribution and monetization fourth.**

| Document | What it is |
|---|---|
| [`REPORT.md`](REPORT.md) | the final report: root causes, files, migrations, rules, tests, risks, cost, deployment status, manual actions, before/after, what was not modified |
| [`OPERATING_GUIDE.md`](OPERATING_GUIDE.md) | the owner's daily research check and article approval, step by step |
| [`AUDIT.md`](AUDIT.md) | the Phase 1 audit, with every figure measured and cited |
| [`DATA_CONTRACT.md`](DATA_CONTRACT.md) | the research record, the calculation layer, time, the two classifications, availability, artifact and database fields |
| [`RULES.md`](RULES.md) | every integrity, editorial and export rule, per boundary (generated from the code) |
| [`RELIABILITY.md`](RELIABILITY.md) | what each confidence and reliability number measures, and what it does not |
| [`PERFORMANCE.md`](PERFORMANCE.md) | live-forward vs backtest monitoring (generated) |
| [`TEMPLATES.md`](TEMPLATES.md) | the eight article templates and story selection |
| [`COST.md`](COST.md) | the content engine's $10 monthly AI budget |
| [`MIGRATION.md`](MIGRATION.md) | rollout order, verification and rollback |

```
npm run integrity:test          # the 17 regression cases + the integration test (needs PostgreSQL)
npm run integrity:audit         # the audit's figures, reproduced from committed data
npm run integrity:performance   # refresh PERFORMANCE.md
node tools/integrity/rules_doc.js --check
```
