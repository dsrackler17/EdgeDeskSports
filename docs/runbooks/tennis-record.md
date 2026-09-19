# Runbook — the EdgeDesk tennis research record

Everything here assumes a direct database connection. The record jobs are
set-based SQL over hundreds of thousands of rows; they speak `psql`, not
PostgREST, and they are the only tennis jobs that do.

```bash
export SUPABASE_DB_URL='...'    # Supabase → Connect → Session pooler
# or, locally / in CI:
export EDGD_PG='-h 127.0.0.1 -p 5432 -U postgres'
```

Without one, every job says so and exits rather than pretending to write.

---

## 1. Install the contract

```bash
psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql
```

Read the report at the end. **Every row must say `ok`.** Row 24 checks that
`tennis` is served by the Data API; if it says `CHECK THIS`, add `tennis` under
**Supabase → Project Settings → API → Exposed schemas** (it is already there for
the live match centre, so this normally passes).

The dashboard SQL editor truncates large pastes. If you are not using `psql`,
run `supabase/parts/tennis_record.part1-of-8.sql` … `part8-of-8.sql` **in
order**; the last part prints the report.

Safe to run again. It is idempotent, additive, and it applies in either order
relative to `supabase/tennis_live_center.sql`.

---

## 2. Import the historical archive

**This is a one-off administrative act against a licence-restricted dataset.**
It is deliberately not on any schedule.

```bash
# 1. look before you leap
npm run tennis:record:dry -- --file EdgeDesk_Tennis_Dataset.zip \
                             --member tennis_matches_atp_wta_1968_2026.csv.gz

# 2. the real thing. --fast drops the expensive secondary indexes for the
#    backfill and rebuilds them at the end.
npm run tennis:record:import -- --file EdgeDesk_Tennis_Dataset.zip \
                                --member tennis_matches_atp_wta_1968_2026.csv.gz \
                                --chunk 20000 --fast \
                                --source-version 2026-09-19
```

A plain `.csv` or `.csv.gz` works too — pass it to `--file` and drop `--member`.

**If the archive arrived as numbered parts**, verify and import the whole set:

```bash
node tools/tennis/verify_parts.js --manifest 00_manifest.json --dir ./parts
npm run tennis:record:import -- --manifest 00_manifest.json --dir ./parts --chunk 20000 --fast
```

The importer verifies every part by checksum before reading a byte and
**refuses the whole import if one is missing** — naming the exact file. A
partial import would otherwise succeed, reconcile, and leave the record
permanently short with nothing downstream ever saying so.

### What to check when it finishes

```
  ── reconciliation ─────────────────────────────────────────
  source rows read           361571
  accepted                   361XXX
  rejected (quarantined)        XXX
  skipped by filter               0
  accounted for              361571  RECONCILED
```

**If it says `MISMATCH`, the run is marked `error` and nothing is derived from
it.** That is the point: an import that cannot account for every row it read is
an import nobody can trust, however good the totals look.

Rejected rows are **kept**, in `tennis.stg_archive_matches` with their reason:

```sql
select reject_reason, count(*) from tennis.stg_archive_matches
 where reject_reason is not null group by 1 order by 2 desc;
```

### It died halfway

```bash
npm run tennis:record:resume -- --file <the same file> --member <the same member>
```

It finds the last unfinished run **over the same bytes** (matched by sha256) and
continues from the chunk after the last committed one. It adopts that run's
chunk size, announcing the change if you typed a different one — a resume skips
by chunk *index*, so a different size would skip a different set of rows.

A different file is a different run, and it says so rather than continuing into
the wrong one.

### Then build the derived layers, in this order

```bash
npm run tennis:features:build     # rolling serve/return/SOS — the ratings read these
npm run tennis:ratings:build      # Elo → the 0-100 power rating
npm run tennis:model:build        # train, evaluate, and promote only if it earns it
npm run tennis:board:build        # fair prices and research opportunities
```

Order matters: the rating layer reads the feature rows, so the reverse would
rate players against yesterday's features with nothing saying so.

Optionally seed the ratings from the archive's own snapshot, which is preferred
where it exists because it is the source's number rather than ours:

```bash
node tools/tennis/build_ratings.js --commit --strength player_strength_latest.csv
```

---

## 3. Daily operation

All of this runs itself from `.github/workflows/tennis-record.yml`. By hand:

| what | when | command |
|---|---|---|
| features + ratings | nightly 05:35 UTC | `npm run tennis:features:build && npm run tennis:ratings:build` |
| results + settlement + board | every 2h | `npm run tennis:incremental && npm run tennis:settle && npm run tennis:board:build` |
| rankings | nightly | `npm run tennis:rankings` |
| weather / venue backfill | weekly | `gh workflow run tennis-record.yml -f job=weather` |
| calibration review | weekly | `npm run tennis:model` |
| health | hourly | `npm run tennis:status` |

---

## 4. Is it healthy?

```bash
npm run tennis:status
```

```
job                       status     finished                       read   updated  reconciled
archive_import            ok         2026-09-19T05:31:43           361571        0  yes
feature_build             ok         2026-09-19T05:32:56                0   723142  yes
rating_build              ok         2026-09-19T05:34:16            15515    15515  yes
price_board               ok         2026-09-19T05:43:11               42        0  yes
```

Or in SQL:

```sql
select * from tennis.record_health;
select * from tennis.ai_data_health();
```

**What to act on:**

| symptom | what it means | what to do |
|---|---|---|
| `reconciled = NO` | an import could not account for every row | re-run it; nothing downstream used it |
| a job with no `ok` in 2 days | the scheduler or the credential | check `tennis-record.yml` and `SUPABASE_DB_URL` |
| `failed_runs_7d > 0` | see `error_summary` on the run | fix and re-run; the cursor did not advance |
| `open_data_issues` climbing | the source changed shape | `select * from tennis.data_quality_issues where resolved_at is null order by occurrences desc` |
| `active_model_version` null | no model is active | `npm run tennis:model:build` |
| board empty but fixtures exist | ratings or model missing | check `ratings_computed_at` in `record_health` |

---

## 5. Rolling back a model

Predictions already written are **not** rewritten — they are evidence and the
database refuses to alter them. A rollback changes which version the *next*
board run uses.

```bash
node tools/tennis/build_model.js --rollback tennis-baseline-1.0.0            # dry run
node tools/tennis/build_model.js --rollback tennis-baseline-1.0.0 --commit
npm run tennis:board:build
```

```sql
select model_version, status, activated_at, retired_at,
       eval_results->'test'->>'log_loss' as test_log_loss
  from tennis.model_registry order by created_at desc;
```

At most one version per family may be `active`; the unique index enforces it.

---

## 6. A result was wrong

Re-import the corrected file. The match's identity is its **draw slot**, so the
correction updates the match it corrects rather than creating a second one, and
`tools/tennis/incremental.js results --commit` recomputes the affected player's
features **and every later match they played** — the rolling aggregates are
cumulative, so the blast radius is forward-only and is computed rather than
guessed.

**A settled public-record row is never rewritten.** If a correction disagrees
with one, it is recorded as a `source_conflict` data-quality issue for a person
to look at. A public record that changes after the fact is not a record.

---

## 7. Replacing the non-commercial archive

See `docs/tennis-architecture.md` §4. Three steps, none of which touches
anything downstream:

1. register the source in `tennis.source_licenses` with `commercial_use => true`
   and a named clearer (the database refuses without one);
2. set `TENNIS_FEED_API_KEY` / `TENNIS_FEED_BASE_URL`;
3. implement `tools/tennis/providers/licensed_feed.js` against the normalised
   shapes in `providers/index.js`, and raise its `SOURCE_PRIORITY`.

Until then the archive stays `commercial_use = false`, the board says so on
screen, and `tennis.record_health.record_cleared_for_commercial_use` is `false`.

---

## 8. Troubleshooting

| message | cause | fix |
|---|---|---|
| `the tennis record contract is not installed` | migration not applied | §1 |
| `source "X" is not registered in tennis.source_licenses` | licence gate | register it first |
| `the source is missing required columns` | the archive changed shape | do not force it; look at what changed |
| `PGRST106 Invalid schema: tennis` | Data API | add `tennis` under Exposed schemas |
| `no database connection` | env | set `SUPABASE_DB_URL` or `EDGD_PG` |
| `permission denied for table model_predictions` (as a reader) | **working as designed** | prices are subscriber-only; the database enforces it |
| `no ACTIVE tennis model is registered` | never promoted | `npm run tennis:model:build` |
| board is empty, fixtures exist | no prices, or no ratings | check `tennis.odds_snapshots` and `ratings_computed_at` |
| `tennis.model_predictions is append-only` | something tried to edit a prediction | **working as designed** — write a new one |

---

## 9. Verify everything, end to end

```bash
npm run tennis:test          # engine, providers, AI, board UI, live pipeline   (no database)
npm run tennis:sql           # contract + RLS, importer, feature leakage        (needs PostgreSQL)
npm test                     # the whole estate, tennis included
```

The SQL suites skip loudly and pass without PostgreSQL; CI runs them with one in
`games-sql.yml`.
