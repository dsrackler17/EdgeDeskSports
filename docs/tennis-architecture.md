# EdgeDesk Tennis — architecture

**Research, not picks.** Nothing in this system publishes a selection, a stake
or a claim that a match is settled before it is played. It publishes a
probability, the price that probability implies, the market's own number beside
it, and the reasons the gap between them might not be real.

---

## 1. Why this exists, and what was already here

`app.html` has read `tennis.players`, `tennis.matches`, `tennis.rankings_current`
and five record views since the Tennis panel shipped. `tools/tennis/db.js`
resolves identity against them. `tools/tennis/build_baselines.js` counts career,
surface and form from them.

**None of it was ever installed.** The module's own comment points at a
migration (`migrations/020_tennis_schema.sql`) that is in no repository, and the
panel has rendered its honest empty state ever since:

> *"The database refuses to store any source not cleared for commercial use, so
> this module is empty until a licensed feed is loaded."*

That sentence was a promise about a schema that did not exist. This work is that
schema, and it is that refusal made real.

### What was already here and is untouched

| layer | files | status |
|---|---|---|
| Live match centre | `supabase/tennis_live_center.sql`, `tools/tennis/{sync_events,live_poll,live_gate,espn,sync_players}.js` | **unchanged** |
| Provider directory | `supabase/tennis_player_directory.sql` | **unchanged** |
| Shared live engine | `lib/tennis_research.js` | **unchanged** |
| Live workflows | `.github/workflows/tennis-{sync,live}.yml` | paths and pre-write guards extended only |

`tennis.tournaments` is the one shared table. It was already multi-provider
(`provider` + `unique (provider, provider_tournament_id)`, ids shaped
`'<provider>:<id>'`), so archive events are **added** to it under
`provider='archive'` with `state='final'` rather than given a second table
meaning the same thing. Every existing read is either keyed by `tournament_id`
or filtered `state in ('scheduled','live')`, so an archived event is invisible to
all of them. The record contract adds columns; it does not alter one.

---

## 2. The eleven layers

```
                    ┌──────────────────────────────────────────────┐
  0  LICENSING      │ tennis.source_licenses                       │  every stored fact
                    │ tennis.enforce_source_license (trigger)      │  names its source
                    └───────────────────┬──────────────────────────┘
                                        │
  1  RAW/STAGING    tennis.stg_archive_matches        PRIVATE — 108 text columns, nothing trusted yet
                                        │
  2  ENTITIES       tennis.players · tennis.venues · tennis.tournaments (extended)
                                        │
  3  HISTORY        tennis.matches                    one row per DRAW SLOT, not per result
                                        │
  4  POINT-IN-TIME  tennis.player_match_features      PRIVATE — only what was knowable BEFORE
                                        │
  5  CURRENT STATE  tennis.player_ratings_current · tennis.rankings_current
                                        │
  6  MARKET         tennis.odds_snapshots             append-only; a price is a moment
                                        │
  7  MODEL          tennis.model_registry · tennis.model_predictions   both immutable
                                        │
  8  RESEARCH       tennis.research_opportunities     the mutable surface; superseded, never deleted
                                        │
  9  AI CONTEXT     tennis.ai_* (5 bounded security-definer functions)
                                        │
 10  PUBLIC RECORD  tennis.prediction_record · public_record_{summary,calibration}
                                        │
 11  OPERATIONS     tennis.ingestion_runs · tennis.data_quality_issues · tennis.weather_observations
```

### Table map

| table | posture | what it holds |
|---|---|---|
| `tennis.source_licenses` | public read | every source and what it may be used for |
| `tennis.stg_archive_matches` | **private** | the import surface, all text |
| `tennis.players` | public read | identity, one row per (source, tour, source id) |
| `tennis.venues` | public read | venue identity, separate from weather |
| `tennis.tournaments` | public read | shared with the live layer; archive rows are `provider='archive'` |
| `tennis.matches` | public read | one canonical row per match |
| `tennis.player_match_features` | **private** | pre-match features, ~2 rows per match |
| `tennis.player_ratings_current` | public read | the fast table the website reads |
| `tennis.rankings_current` | public read | latest rank on file |
| `tennis.odds_snapshots` | **subscriber** | normalised market prices |
| `tennis.model_registry` | public read | model versions, immutable |
| `tennis.model_predictions` | **subscriber** | append-only predictions |
| `tennis.research_opportunities` | **subscriber** | the current research layer |
| `tennis.prediction_record` | public once started | the published record, immutable |
| `tennis.ingestion_runs` | **private** | the pipeline's diary |
| `tennis.data_quality_issues` | **private** | what was wrong, deduplicated |
| `tennis.weather_observations` | public read | tournament-week reanalysis |

### Views (all `security_invoker = true`)

`player_match_rows` · `player_career` · `player_season` · `player_surface` ·
`player_form` · `h2h` · `player_profile` · `board_public` · `board_research` ·
`board_current` · `match_context` · `record_health` · `public_record_summary` ·
`public_record_calibration`

`board_research`, `board_current` and `match_context` are revoked from `anon`
entirely; the rest are readable by anyone and return what the reader's own RLS
policies allow.

---

## 3. The four rules everything else follows from

### A missing value is never a zero

An empty cell, `NA`, `nan`, `None` and a lone dash are all **absent**. A zero is
a measurement. `lib/tennis_model.js:num()` refuses to blur them, every feature
row carries `missing_fields` and `completeness`, and a match whose completeness
falls below `GATES.minCompleteness` is refused a price rather than given a
confident one built on holes.

### A match's identity is its draw slot, not its result

The archive's own `match_uid` is `TOUR_tourney_matchnum_winnerid_loserid`. It
identifies a *result*: correct a mis-recorded winner upstream and the uid
changes, so keying on it would store the correction as a second match. Identity
here is `(source, tour, tournament, match number)`. A corrected result therefore
**updates the match it corrects**, which `tools/tennis/import.test.js` proves.

### The leakage boundary is a SQL window frame, not a convention

```sql
rows between unbounded preceding and 1 preceding
```

That clause in `tools/tennis/build_features.js` is the whole guarantee: the
current match cannot enter its own rolling aggregate, not by accident and not
after a refactor. `tools/tennis/leakage.test.js` checks it from the other side,
recomputing a player's history by hand in JavaScript and failing on any
disagreement — then proving a *future* match cannot change an earlier feature
row, and that a correction propagates forward and only forward.

### A multi-part dataset is whole or it is nothing

The archive ships as fourteen compressed parts. Importing thirteen of them
**succeeds**: every total reconciles against what was read, the run is marked
`ok`, and the record is permanently missing a tour-decade with nothing
downstream ever saying so. The manifest is the only thing that knows how much
there should have been, so `tools/tennis/verify_parts.js` checks it first — by
checksum, by decompressed row count, and by column order — and the importer
refuses on any gap, naming the exact file.

### A published claim is immutable, including to its own writer

`tennis.freeze_prediction()`, `tennis.freeze_model_version()` and
`tennis.freeze_published_record()` raise on any attempt to rewrite a prediction,
a model version's evaluation, or a published claim — for every role, service
role included. Settlement may write the result *beside* a claim, once. A public
record its own pipeline can edit is not a record.

---

## 4. The licence gate

The historical archive is **CC BY-NC-SA 4.0**: research, non-commercial,
share-alike.

```sql
select source_key, licence, commercial_use, allowed_uses from tennis.source_licenses;
--  archive     | CC BY-NC-SA 4.0 | f | {research}
--  espn        | Publisher terms | f | {research,display}
--  open-meteo  | CC BY 4.0 (nc)  | f | {research}
--  odds_api    | Commercial      | t | {research,commercial,display}
--  edgedesk    | Proprietary     | t | {research,commercial,internal,display}
```

Three things enforce it:

1. **A trigger on every table that stores a fact.** A row naming an unregistered
   source is refused with a message that names the source and the table to fix
   it in. EdgeDesk stores no fact of unknown provenance.
2. **A check constraint.** `commercial_use = true` requires `cleared_by` and
   `cleared_at`. "Somebody probably checked" is how a licence breach happens.
3. **The importer refuses before reading a byte** if the source key is not
   registered.

The research board states the restriction on screen, and `tennis.record_health`
exposes `record_cleared_for_commercial_use` so the page cannot forget to.

### Replacing it with a licensed feed

1. `insert into tennis.source_licenses (...) values ('your_feed', ..., commercial_use => true, cleared_by => '<who>', cleared_at => now());`
2. Set `TENNIS_FEED_API_KEY` and `TENNIS_FEED_BASE_URL`.
3. Implement `read()` / `fixtures()` / `results()` / `rankings()` in
   `tools/tennis/providers/licensed_feed.js` against the normalised shapes in
   `tools/tennis/providers/index.js`.
4. Raise its entry in `SOURCE_PRIORITY` so it wins a disagreement with the
   archive. The archive's rows are kept and the conflict is recorded.

**Nothing downstream changes.** The importer, the features, the model, the
board, the AI and the published record all read normalised shapes, never a
provider payload. `tools/tennis/providers.test.js` runs the contract tests
against the unimplemented stub, so the day it is written the shape is already
proven.

---

## 5. The model

A logistic model over **pre-match feature differences**. Coefficients are data,
stored on the registry row, so a model version is reproducible and can be rolled
back without a deploy.

Inputs (`lib/tennis_model.js:FEATURE_NAMES`): overall Elo difference, surface
Elo difference, log-rank difference, log ranking-points difference, 90-day form,
365-day form, rest (capped at 14 days — a fortnight off is a layoff, not
freshness), 14-day workload, shrunk career surface experience, age, rolling
serve strength, rolling return strength, strength of schedule, best-of-5,
tournament-level weight, and an Elo × best-of-5 interaction.

**Not inputs, ever:** the row's own serve statistics, its score, its duration or
its result. Serve and return strength come from a rolling aggregate over matches
strictly *earlier* (see §3).

### Training

- **Chronological splits only.** Train / validation / test are three consecutive
  windows in time. A random split lets the model see 2024 while being tested on
  2019, which tests nothing. The windows are stored on the registry row.
- **Symmetric by construction.** Every match enters training twice — once as
  `(winner, loser)` with `y=1` and once as `(loser, winner)` with `y=0`. The
  features are differences, so this forces anti-symmetry: the model cannot learn
  "the first player usually wins" because here they win exactly half the time.
- **Evaluated on one orientation per match,** chosen deterministically from
  `sha1(match_id)`, so the metrics describe a real 50/50 decision.
- **Walkovers are excluded.** Nobody struck a ball.

### Promotion

A candidate becomes `active` only if it beats the current active model **and**
the official-ranking, overall-Elo and surface-Elo baselines on log loss over the
test window, without a calibration failure. Otherwise it is registered as a
candidate and production does not move. `--force` records the override.

Calibration error is measured over bins holding at least 30 matches; the
excluded matches are counted and printed. A five-match bin has a binomial
standard error near 22 points, and because ECE is a weighted mean of *absolute*
gaps, that noise can only push it up — so including such a bin makes a
well-calibrated model look miscalibrated and never the reverse.

`tennis.model_registry` has a unique index enforcing **at most one active model
per family**: two active versions would mean two fair prices with nothing to say
which one the record is kept against.

---

## 6. Weather, stated plainly

The archive dates a match to its **tournament week**, not to first serve. The
weather attached to it is therefore a seven-day profile around an event, and
`temporal_precision = 'tournament_week'` says so on every row.

- **Indoor events get an explicit `'indoor'` row**, not a null. A null would look
  like a gap somebody could later fill in by mistake.
- **`'Outdoor/unknown'` in the source maps to `unknown`, not `outdoor`.** It is
  not a claim that the event was outside, so weather never attaches to it.
- `tennis.weather_is_usable()` is one rule, in one place, shared by the importer,
  the model and the page.

---

## 7. Data flow

```
  the archive (.csv.gz)
        │  tools/tennis/import_archive.js      chunked COPY, resumable, reconciling
        ▼
  tennis.stg_archive_matches ──► players · venues · tournaments · matches · features · weather
        │
        │  tools/tennis/build_features.js      rolling serve/return/SOS, window frame excludes self
        ▼
  tennis.player_match_features
        │
        │  tools/tennis/build_ratings.js       Elo → 0-100, shrunk by sample
        ▼
  tennis.player_ratings_current ─────────────┐
        │                                     │
        │  tools/tennis/build_model.js        │
        ▼                                     │
  tennis.model_registry (active version)      │
        │                                     │
        └──────────────┬──────────────────────┘
                       │  tools/tennis/price_board.js
   tennis.live_matches │  (fixtures, from the EXISTING sync)
   tennis.market_captures / public.signals ──► tennis.odds_snapshots
                       ▼
       tennis.model_predictions ──► tennis.research_opportunities
                       │                    │
                       │                    └──► app.html  (board_current, match_context)
                       ▼
       tennis.prediction_record  ──  tools/tennis/settle_record.js  ──► record.html
```

---

## 8. Security posture

| posture | tables | who reads |
|---|---|---|
| **private** | staging, features, ingestion runs, data-quality issues | nobody but the service role — RLS on, **no grant at all** to `anon` or `authenticated` |
| **public** | players, matches, tournaments, venues, weather, rankings, ratings, licences, model registry | anyone |
| **subscriber** | predictions, odds snapshots, research opportunities | `authenticated` where `tennis.viewer_is_entitled()` |
| **record** | `prediction_record` | public once the match has started or settled; subscriber before |

- Entitlement **delegates to `public.community_is_entitled(uuid)`** — the same
  rule the rest of the product uses — with an identical-predicate fallback only
  so the contract applies to a database that has tennis but not yet the
  community contract.
- The paywall is **in the database**. An unentitled reader gets zero rows from
  Postgres, not a redacted row from the application.
- No client role has `INSERT`, `UPDATE` or `DELETE` on anything.
- Every `security definer` function has a fixed `search_path` and `execute`
  revoked from `public`.
- No service-role key or database URL appears in `app.html`, `record.html`, or
  any Edge Function. The record jobs hold `SUPABASE_DB_URL` and run on a runner.

`tools/tennis/sql/tennis_record.test.sql` attacks all of this as `anon`, as a
signed-in free account and as an entitled subscriber, against a real PostgreSQL.

---

## 9. Performance

Indexes target the actual query patterns: `(tour, match_date)`,
`(tournament_id, round_order)`, `(winner_id, match_date)`,
`(loser_id, match_date)`, `(surface, match_date)`, `(tour, season, match_date)`,
`(model_version, generated_at)`, `(match_scope, match_ref, captured_at)`,
`(status, generated_at) where status='open'`, and the per-tour rating orderings.

The board reads `tennis.board_current`, which is `distinct on (match_ref)` over
the latest prediction per match — predictions are append-only, so the page wants
the current one and PostgREST cannot express `distinct on`. So the contract does.

Expensive secondary indexes are dropped for a bulk backfill
(`tennis.drop_backfill_indexes()`) and rebuilt after
(`tennis.rebuild_backfill_indexes()`), which `--fast` does automatically.

Measured plans are in `docs/tennis-performance.md`.

---

## 10. What EdgeDesk does not have

Stated here so an answer can say it rather than improvise around it:

- **No injury or withdrawal source.** None. Not modelled, not guessed.
- **No point-by-point data.**
- **No doubles ratings.** A pair is a team, never a player, and is never priced.
- **No exact first-serve time for a historical match** — the archive dates a
  match to its tournament week.
- **No historical market prices**, so the model has not been shown to beat a
  price. It has been shown to beat the ranking and Elo baselines. The model
  build says so explicitly rather than passing over it.
