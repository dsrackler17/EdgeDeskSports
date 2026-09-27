# Provider fixture payloads

Representative payloads for the provider contract tests (football/cfb_lab/providers.test.js,
docs/cfb-production/PROVIDERS.md). They are written in each provider's real shape as the lab's
parsers read it (ESPN site API scoreboard, The Odds API v4 /odds with decimal prices, the V2
pipeline's CFBD line ledger, the cfbfastR schedule CSV). The `*_schema_drift` files remove or
retype a required field; the `*_impossible` file carries values no market can have. Every
drift must be rejected and logged, and no missing field may ever be read as zero.
