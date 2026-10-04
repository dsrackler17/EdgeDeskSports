# Runbook — tennis provider adapters

The point of this layer is that **replacing the non-commercial historical
archive with a licensed feed is a configuration change, not a rewrite.**
Nothing downstream — not the importer, not the feature builder, not the model,
not the board, not the AI, not the published record — ever sees a provider's own
payload. They see the normalised shapes in `tools/tennis/providers/index.js`.

## The five contracts

| kind | adapter | source key | credentials | what it does NOT carry |
|---|---|---|---|---|
| `historical` | `historical_archive.js` | `archive` | none | exact start time, doubles, point-by-point, market prices |
| `live_results` | `espn_results.js` | `espn` | none | pre-match ratings, historical archive, prices |
| `rankings` | `espn_results.js` | `espn` | none | the official tour table (this is the provider's view of it) |
| `odds` | `edgedesk_odds.js` | `odds_api` | none (uses the existing capture) | set betting where the feed omits it, tennis player props |
| `weather` | `open_meteo_weather.js` | `open-meteo` | none free / `OPEN_METEO_API_KEY` commercial | conditions at first serve, court microclimate, indoor venues (excluded by design) |
| *any* | `licensed_feed.js` | `licensed_feed` | `TENNIS_FEED_API_KEY`, `TENNIS_FEED_BASE_URL` | **unimplemented — and blocks nothing** |

## Rules every adapter obeys

- **Return the normalised shape, or throw.** A field the source does not carry
  is `null` and is **named in `unmapped`**. Never invented, never defaulted to
  zero.
- **Declare a `source_key` registered in `tennis.source_licenses`.** An
  unregistered source cannot write; the database refuses the row.
- **Be pure with respect to the database.** An adapter reads its source and
  returns rows. The job that called it writes.
- **Never expose a provider id, field name or status string downstream.**
- **Never delete.** A provider that stops mentioning a match has not un-played
  it. Absence is recorded as a data-quality observation; the row stays.

## Writing a new adapter

```js
const P = require('./index.js');
module.exports = P.defineProvider({
  kind: 'historical',                 // historical | live_results | rankings | odds | weather
  name: 'my_feed',
  source_key: 'my_feed',              // MUST exist in tennis.source_licenses
  credentials: ['MY_FEED_KEY'],
  capabilities: { pre_match_features: false, serve_statistics: true,
                  exact_start_time: true, live_score: true,
                  closing_price: false, doubles: true },
  async *read(opts) { /* yield normalised match rows */ },
  describe() { return { name: 'my_feed', coverage: '…', licence: '…',
                        not_carried: ['…'] }; }
});
```

Then:

```bash
node tools/tennis/providers.test.js     # the contract tests run against every adapter
```

## Incremental ingestion

```
cursor  = the last SUCCESSFUL run's end   (a failure re-reads its own window)
window  = [cursor − overlap, now]
overlap = results 48h · rankings 8d · odds 6h · historical 14d
```

The overlap is not paranoia. Results get corrected, retirements get
reclassified, rankings get republished — without it, the one thing an
incremental feed is worst at would never arrive.

Only a **material** change (score, winner, ranking, surface, round, best-of,
date) triggers the downstream recompute. A feed that rewrites `updated_at` on
every poll must not cost a full feature rebuild.

## When two sources disagree

`SOURCE_PRIORITY` decides what is written. The loser is **not discarded** — it
is recorded as a `source_conflict` data-quality row with both observations,
because a disagreement between two feeds is information about the feeds.

```
licensed_feed 100 > odds_api 90 > espn 50 > archive 30 > open-meteo 20 > unknown 10
```

## Swapping in a licensed feed

1. Register it:
   ```sql
   insert into tennis.source_licenses
     (source_key, title, licence, commercial_use, research_use, allowed_uses, cleared_by, cleared_at)
   values ('my_feed', 'Vendor X tennis feed', 'Commercial agreement', true, true,
           array['research','commercial','display'], 'your-name', now());
   ```
   The check constraint refuses `commercial_use = true` without a named clearer.
2. Set the credentials in repository secrets. They never reach a browser.
3. Implement the adapter against the normalised shapes.
4. Raise its `SOURCE_PRIORITY` so it wins a disagreement.

The archive's rows stay. Nothing downstream changes.
