# Player Props — architecture

EdgeDesk Player Props is a player-level research system for NFL and FBS
football. It answers, for every projected prop:

1. **Opportunity.** How many snaps, routes, targets or carries the player is likely to get.
2. **Production.** What he is likely to do with them.
3. **The full distribution.** The whole outcome distribution, not a point estimate.
4. **The book.** The sportsbook's line and price.
5. **Fair line.** EdgeDesk's fair line: the distribution's median.
6. **Fair odds.** EdgeDesk's fair odds at the book's line.
7. **No-vig market.** The market's own probability, de-vigged.
8. **EV.** Expected value at the exact price and book.
9. **Reliability.** How reliable the number is, which is never the size of the edge.
10. **Assumptions.** What the number assumes: its drivers, and the risks against it.
11. **Other lines.** How the price changes at every other line and alternate.
12. **What to do.** Research, watch, pass, or a sized, exposure-capped stake.

**Research, not picks.** A decision exists only against a real, fresh sportsbook
price. With no price, the board says **PROJECTION ONLY** and shows fair lines
and distributions. EdgeDesk never invents a price.

## The one pipeline

```
football/nfl/slate.json, football/fbs/slate.json   EdgeDesk's own game models
   (fair margin, fair total, their sigma, QBs, forecast)
        │  GAME ENVIRONMENT — one draw of margin and total per simulation,
        ▼  shared by both teams
football/props/project.js  ── TEAM OPPORTUNITY    plays, pass rate, dropbacks,
                              (fitted OLS on env)   sacks, scrambles, attempts
                           ── PLAYER OPPORTUNITY  recency-weighted shares shrunk
                              to role priors; Dirichlet-multinomial with the
                              share itself drawn from its posterior
                           ── AVAILABILITY        Q/D/unresolved players are a
                              scenario inside each simulation; OUT players are
                              redistributed (model.js redistributionPlan)
                           ── EFFICIENCY          empirical-Bayes catch rate,
                              yards per catch/carry; per-play gains drawn from
                              EMPIRICAL league pools, rescaled
football/props/engine.js   ── MONTE CARLO         10,000 seeded simulations per
                              game → integer pmfs (never a Normal)
football/props/calibrate.js── per-prop λ/κ fitted on a tuning fold
football/props/assemble.js ── EDProps.prepare() against the captured market
        ▼
football/props/<league>/board.json · games/<id>.json · markets/<id>.json
        ▼
Research → Props · the drawer · game cards · /players/… · Lab · record · AI desk
```

Every surface calls **`EDProps.prepare(projection, quotes, context)`** in
`lib/edgedesk_props.js`. The build calls it for the board, and the browser drawer
calls it again on the same files. The AI desk, inlined into
`supabase/functions/edgedesk_ai/index.ts`, and the record's freeze both call it
too. Each call uses the same inputs, so a fair line, a probability, an EV and a
decision read the same everywhere. `EDProps` prices every quote through
`lib/research_core.js`, the one EV engine (`americanToDecimal`, `noVigTwoWay`,
`priceAssessment`, `expectedRoi`). It classifies through `EDDecision.priceClass`
when that module is loaded, and otherwise through a verbatim copy of the same
rule. There is no second EV engine.

## Files

| File | Role |
|---|---|
| `lib/edgedesk_props.js` | The core. It covers: prop catalog; identity (`resolvePlayer`, `mintPlayerId`); distributions; pricing; market (pairing, no-vig, consensus, movement, freshness); reliability; stages; evaluate / ladder / sizing / exposure; correlation; grading, CLV and freezing; metrics; `prepare`. UMD: browser, Node, Deno. |
| `lib/edgedesk_props_ui.js`, `lib/edgedesk_props.css` | Every browser surface ([UI.md](UI.md)). |
| `football/props/sources.js`, `nfl_data.js`, `cfb_data.js` | Public data (nflverse, cfbfastR) → one normalised shape ([DATA.md](DATA.md)). |
| `football/props/model.js`, `priors.js`, `project.js`, `engine.js`, `calibrate.js` | The model ([MODEL.md](MODEL.md)). |
| `football/props/registry.js`, `identity_overrides.json` | Durable player ids ([IDENTITY.md](IDENTITY.md)). |
| `football/props/capture.js` | Sportsbook prop capture ([MARKET.md](MARKET.md)). |
| `football/props/assemble.js`, `build.js`, `cfb_build.js` | Board + game files; `--reprice` re-prices without re-simulating. |
| `football/props/backtest.js` | Walk-forward validation and calibration ([VALIDATION.md](VALIDATION.md)). |
| `football/props/record.js` | Freeze / grade / verify ([RECORD.md](RECORD.md)). |
| `football/props/desk.js` | The AI desk's prop answers ([AI.md](AI.md)). |
| `football/props/sync_supabase.js`, `supabase/player_props.sql` | The insert-only mirror and schema ([SCHEMA.md](SCHEMA.md)). |
| `.github/workflows/player-props.yml` | The hourly job: test → capture → build → freeze/grade → verify → publish → mirror. |
| `.github/workflows/player-props-tests.yml` | PR CI: suites, SQL against a real PostgreSQL, the browser. |

## Storage and immutability

- **Git.** Holds the deterministic model files (`games/<id>.json`, rewritten only
  when an input changes), the compact per-game market files and the append-only
  prediction ledger (`football/props/ledger/<league>/<season>/predictions.jsonl`).
  Git history is the snapshot archive. `record.js verify` fails the hourly job if
  the committed ledger is not a prefix of the new one.
- **Supabase** (optional). Holds the full quote tick history and mirrors of the
  registry, projections, distributions, decisions and grades. Every table is
  append-only (UPDATE and DELETE are refused, even for the service role).
- **Seeds.** Every seed and every projection id derives from the game, the model
  version and a hash of the inputs, never from the clock. An unchanged slate
  therefore rewrites nothing.

## Stages (objective gates, never assigned)

`EXPERIMENTAL → TRACKING → RESEARCH GRADE → PRODUCTION`, per prop type, from
`EDProps.stageOf`. The gates are listed in [VALIDATION.md](VALIDATION.md).

- An EXPERIMENTAL market informs but never stakes: its class is capped at LEAN.
- A TRACKING market may reach BET, but is sized at no more than 0.25U (a
  model-estimated source).

## Extending beyond football

The core is sport-agnostic. A new sport needs:

- a data loader producing `{players, games, playerGames, teamGames, …}`;
- a projector that emits the same projection record with an integer `dist`;
- catalog entries in `PROP_TYPES`.

The board, drawer, record, desk and schema then work unchanged.
