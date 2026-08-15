# Tennis data sourcing — where the data can legally come from

The question this answers: *where do ATP/WTA results, rankings and player facts
come from without a licensing problem?* Short version: **not from the free
archives, and the schema now enforces that rather than trusting anyone to
remember it.**

## What is established

**The uploaded builder's own source is unusable here.** `build_dataset.py`
downloads the Jeff Sackmann `tennis_atp` / `tennis_wta` archives. Those are
licensed **CC BY-NC-SA 4.0** — non-commercial and share-alike. The builder's
README states this itself and warns against putting the raw files into a
commercial database. EdgeDesk sells subscriptions, so this is a real blocker,
not a technicality. Both Sackmann keys are registered in `tennis.sources` with
`commercial_use = false` so the block is explicit and auditable rather than
implied by absence.

**Free results archives are not automatically free to use.** A search for
`tennis-data.co.uk`'s terms surfaced copyright and non-commercial statements in
the surrounding tennis-data ecosystem, and the name collides with *Tennis Data
Innovations*, the official ATP data rights company. I could not read either
site's terms directly from the build sandbox (egress to those domains is
blocked), so **treat this as unresolved rather than cleared** — do not load it
without reading the terms yourself.

**The one licence EdgeDesk already holds is The Odds API**, already wired for
odds and already carrying `tennis_atp` / `tennis_wta` sport keys. Its scores
endpoint reaches back only a few days, so it can maintain *current form* but can
never build history, head-to-head, or surface splits. It is registered as a
source, uncleared, with that limitation recorded.

## The recommendation

**Buy a commercial tennis data licence.** For a paid product this is the clean
answer and usually a modest cost: providers in this space (API-Tennis /
api-sports.io, tennis-api.com, SportDevs, Goalserve, and at the enterprise end
Sportradar and Genius Sports) sell exactly this — ATP/WTA rankings, results,
player bios and head-to-head, with commercial use being the product. **I could
not read their terms of service from this sandbox**, so pick one, read the plan
you are buying, and record it in `tennis.sources` when you clear it.

Two things worth knowing while you evaluate:

- **Facts vs. databases.** Individual match results and rankings are facts, and
  facts are generally not copyrightable in the US. What licences protect is the
  *compilation* — and in the EU/UK a separate database right protects
  substantial extraction from one. So "the score was 6-4 6-3" is not owned by
  anyone, but *Sackmann's CSV of every score* is. Getting the same facts from a
  feed you licensed is clean; copying his files is not. Confirm with counsel
  before relying on that distinction.
- **Attribution.** Several licences require a credit line. `tennis.sources` has
  an `attribution` column for exactly that; put the required string there and it
  travels with the data.

## How the constraint is enforced

Not by documentation. By the schema:

- every fact row in `tennis.players`, `tennis.rankings` and `tennis.matches`
  carries a `source_key` referencing `tennis.sources`;
- `tennis.sources.commercial_use` is the gate, and it defaults to **false**;
- a `BEFORE INSERT OR UPDATE` trigger raises if the source is unknown or not
  cleared, so ingestion **fails closed**;
- `tennis_ingest` re-checks the same flag before it fetches a single row, so the
  refusal message appears at the pipeline, not just at the database.

Verified by executing it (`migrations/tests/020_tennis_schema_test.sql`) on
PostgreSQL 16: inserts under `sackmann_atp`, under an unregistered key, and
under `licensed_feed` *before* clearing are all refused; after a human sets
`commercial_use = true` with `cleared_by`/`cleared_at`, the same inserts
succeed and the derived views compute correctly.

## Clearing a source (the deliberate step)

```sql
update tennis.sources
   set commercial_use = true,
       display_name  = '<provider>',
       licence       = '<exact plan or licence name>',
       licence_url   = '<terms URL>',
       attribution   = '<required credit line, or null>',
       cleared_by    = '<who read the contract>',
       cleared_at    = now()
 where source_key = 'licensed_feed';
```

Until that runs, the ATP module renders its honest empty state — which is the
correct product behaviour, not a bug.
