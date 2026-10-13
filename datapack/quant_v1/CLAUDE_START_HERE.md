# Implement EdgeDesk from this pack

You are extending my existing EdgeDesk Linemaker AI. Inspect the repository instructions and current architecture first. This archive contains real historical records plus exact schema/feature contracts; it is not a finished multi-sport model. I am the sole founder: use I/my. Preserve "Research, not picks."

Read README.md, COVERAGE.md, sources/source_registry.json, docs/TEMPORAL_AND_QUALITY_RULES.md and docs/PRIORITIES.md before touching data. Run the included verification and inspect provenance. Do not describe defined-but-uncollected fields as real data. Do not claim a sport works because its schema exists.

1. Integrate the relational contracts and source-ID mapping without replacing existing working systems. Inspect existing EdgeDesk caches before adding ingestion. Keep data ingestion, deterministic feature/model calculations and LLM explanations separate. The LLM explains measured outputs; it must not invent probabilities.
2. Map shipped native fields to canonical contracts with explicit units, availability and quality flags. Use NFL's measured and lagged feature tables as an example of honest data lineage. They are retrospective, not certified point-in-time. Keep unknown known_at blank; never backdate ingestion.
3. Complete NHL first: approved shot/shift data, verified goalie starts, strength-state rates, lineup availability and an out-of-sample calibrated scoring distribution. The sample NHL box/event data support mapping and exploration; missing xG/shift/lineup inputs remain missing until collected or modeled transparently.
4. Complete separate NFL/CFB, NBA/WNBA/NCAA men's/women's basketball, MLB/NCAA baseball, soccer, ATP/WTA and MMA integrations using per-sport docs. Prioritize P0 and validate before expensive tracking. Add extension sports only after sources and rules are established.
5. Implement source adapters, cache/incremental backfills, bounded retries, deduplicated jobs, missingness diagnostics and budget circuit breakers. No increased paid API use, new vendor purchases or blocked-source bypasses. Ask for a required missing credential/access only when genuinely blocked; continue independent work.
6. Train/tune/calibrate using chronological data and heldout evaluation. Audit model-derived historical stats for revision leakage. Add sport-specific fair moneyline/spread/total distributions and props only when a dedicated validated opportunity model exists.
7. Rank verified, fresh current market opportunities across sports using calibrated probabilities, uncertainty, evidence and available prices. Include pushes/voids/split settlement. No fresh odds means independent research only. Return PASS if no supported positive-value candidate survives sensitivity checks; never force profitability.
8. Integrate data/model readiness, sources, fair prices and evidence into the current UI. Maintain a clear distinction among historical data loaded, model trained, validation passed, market verified and actionable signal.

Work through implementation and relevant verification, not a proposal. Keep routine choices autonomous. Finish with what works, evidence, unresolved inputs and exact deployment steps. Do not call archived 2024 prices or final stats "live" or "pregame known".

Suggested local commands:

```bash
python -m unittest discover -s tests -v
python scripts/verify_pack.py
# Optional recalculation; requires pandas:
python scripts/build_nfl_features.py
```

The scripts/collect.py historical collector is opt-in and quota-bounded, uses no paid credentials and saves provenance. Its default outputs are samples and do not establish complete season coverage. scripts/expand_samples.py repairs draw grouping and expands explicit-date/NHL samples. Production adapters still need provider rights, incremental controls and reliable coverage audits.
