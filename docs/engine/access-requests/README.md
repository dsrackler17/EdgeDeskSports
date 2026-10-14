# Data access requests (drafts, not sent)

Each provider below publishes useful hockey data whose terms, as this build
understood them, do not cover EdgeDesk's use: a commercial, subscription
research product that stores data and fits models on it. None of them is
wired. Their **published methods** may be re-implemented independently, and
some are (see `hockey/sources/registry.json`, status `METHODOLOGY_ONLY`).

The build environment could not reach these sites, so every summary of terms
here is marked unverified. **Check the provider's current terms before sending**,
and send from the EdgeDesk owner's address. Nothing in the repository sends
these.

| Provider | Draft | What a "yes" would add, measured or expected |
|---|---|---|
| MoneyPuck | [`moneypuck.md`](moneypuck.md) | an independent xG to reconcile ours shot by shot, especially 2022-23 onward |
| Natural Stat Trick | [`natural-stat-trick.md`](natural-stat-trick.md) | line and score-state tables to reconcile our on-ice aggregation |
| Evolving-Hockey | [`evolving-hockey.md`](evolving-hockey.md) | a published RAPM/GAR series to benchmark an EdgeDesk player-impact model |
| HockeyViz | [`hockeyviz.md`](hockeyviz.md) | methodological review only |
| Sports Reference (Hockey-Reference) | [`sports-reference.md`](sports-reference.md) | pre-2010 history (little value: the NHL feed covers every modelled season) |
| The NHL (commercial use of NHL data) | [`nhl-commercial.md`](nhl-commercial.md) | clears the one open licensing question on the production data |

When a provider grants access: record the grant (who, when, scope, any
attribution wording) in `hockey/sources/registry.js` (`terms.verified: true`,
`authorised_for`), add a connector behind `engine/http.js` with its own quota,
and test the dataset in `hockey/lab/run.js` like every other: it earns weight
only if it improves held-out accuracy beyond what the existing data already
carries (the same underlying events counted twice add nothing).
