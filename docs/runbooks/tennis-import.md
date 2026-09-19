# Runbook — importing the tennis archive

The short version. The long version is `docs/runbooks/tennis-record.md`.

```bash
export SUPABASE_DB_URL='...'                        # Supabase → Connect → Session pooler

# 1. install the contract (idempotent; read the report, every row must say ok)
psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql

# 2. look before you leap — reads, validates, reconciles, writes nothing
npm run tennis:record:dry -- --file EdgeDesk_Tennis_Dataset.zip \
                             --member tennis_matches_atp_wta_1968_2026.csv.gz

# 3. import
npm run tennis:record:import -- --file EdgeDesk_Tennis_Dataset.zip \
                                --member tennis_matches_atp_wta_1968_2026.csv.gz \
                                --chunk 20000 --fast --source-version 2026-09-19

# 4. derive, in this order (ratings read features; the model reads both)
npm run tennis:features:build
npm run tennis:ratings:build
npm run tennis:model:build
npm run tennis:board:build
```

## Every flag

| flag | what it does |
|---|---|
| `--file <path>` | `.csv`, `.csv.gz`, or `.zip` (with `--member`) |
| `--member <path>` | the member inside a `.zip` |
| `--dry-run` | read, validate, reconcile, write **nothing** |
| `--resume` | continue the last unfinished run **over the same bytes** |
| `--tour ATP\|WTA` | one tour only (still reconciles over the whole file) |
| `--season 2024` or `2015-2024` | one season or a range |
| `--chunk N` | rows per transaction, default 5000. Obeyed exactly. |
| `--limit N` | stop after N source rows (development) |
| `--no-features` | skip the point-in-time feature rows |
| `--fast` | drop expensive secondary indexes for the backfill, rebuild after |
| `--finalize-only` | recompute the derived layers, import nothing |
| `--source-version <s>` | the archive build id, stored on every row |
| `--source-key <s>` | which registered licence this file is under (default `archive`) |

## What "reconciled" means

```
  source rows read           361571
  accepted                   361XXX
  rejected (quarantined)        XXX
  skipped by filter               0
  accounted for              361571  RECONCILED
```

`read = accepted + rejected + skipped`, exactly. If it does not balance the run
is marked `error` and **nothing downstream is derived from it**. An import that
cannot account for every row it read is an import nobody can trust.

## Rejected rows are kept

```sql
select reject_reason, count(*) from tennis.stg_archive_matches
 where reject_reason is not null group by 1 order by 2 desc;
```

Nothing is silently dropped. A rejection is a fact about the source.

## Re-running is safe

A match's identity is its **draw slot** — tour, tournament, match number — not
its result. So the same file twice produces the same rows, and a file with a
**corrected winner updates the match it corrects** rather than storing both.
`tools/tennis/import.test.js` proves both against a real database.

## It died halfway

```bash
npm run tennis:record:resume -- --file <the same file> --member <the same member>
```

It matches the previous run by **sha256 of the file** and continues from the
chunk after the last committed one, adopting that run's chunk size — a resume
skips by chunk *index*, so a different size would skip a different set of rows.
A different file is a different run and it says so.

## ⚠ Licence

The archive is **CC BY-NC-SA 4.0 — non-commercial, share-alike.** The importer
prints this on every run:

```
source      : archive — CC BY-NC-SA 4.0 (NON-COMMERCIAL: research only)
```

The database will not let you mark it otherwise: `commercial_use = true`
requires a named clearer and a clearance date, and a row naming an unregistered
source is refused outright. Replace it with a licensed feed before it funds a
paid tennis surface — `docs/tennis-architecture.md` §4 is the three-step
procedure, and nothing downstream changes.
