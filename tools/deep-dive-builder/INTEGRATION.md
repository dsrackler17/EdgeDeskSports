# Deep-dive builder — integration status

This directory holds the uploaded **EdgeDesk UFC + WTA + ATP deep-dive dataset
builder** exactly as delivered (`build_dataset.py`, `requirements.txt`,
`ufc_schema.csv`, `README.md`). It is an **offline Python ETL**. It is not wired
into `app.html` and cannot be: it downloads CSVs, writes a local warehouse and
an Excel workbook, and the app is a browser-only client reading Supabase.

## What was implemented into the app

Only the part that is frontend-implementable without inventing data — the
**UFC source field dictionary** (`ufc_schema.csv`):

- Transcribed verbatim into `RS_FIELDS.ufc` (field, definition, source, tier).
- Rendered as a **Source field dictionary** panel in the UFC research module,
  showing each field, the source's own definition, its tier badge, and whether
  this build reads it or not.
- Attached to the **displayed stats**: every UFC career-microstat label in the
  fighter profile and stat grid now carries the source's definition, so a
  number's meaning comes from the schema rather than from a hand-written label.
- A **Deep-dive dataset coverage** block states, per module, what the builder
  defines versus what the live pipeline actually owns.

17 of the schema's 21 fields map to columns this build reads. The other four
(`dob`, `record_nc`, `knockdowns`, `fight_time`) are marked "defined in the
source schema, not read by this app" and are displayed nowhere.

## What was NOT implemented, and why

- **The tennis half (ATP + WTA aggregates).** The builder produces season,
  surface and head-to-head aggregates from the Jeff Sackmann archives. Loading
  them needs tables and a pipeline; creating schema objects is out of scope for
  this work. No aggregate is displayed anywhere, and the WTA module says so.
- **An ATP module.** The app has no ATP data, no ATP tables and no ATP research
  surface — `tennis_atp` exists only as a sport-key *label* on the Record and
  Discipline views. Adding an inactive ATP tab is a product decision, not a
  data one, so it was left to the owner rather than assumed.
- **Running the builder.** Its downloads are blocked from the build sandbox,
  and its output belongs in a warehouse, not in this repo.

## Licensing — unresolved, flagged

The builder's own README states it: the Jeff Sackmann ATP/WTA datasets are
licensed **CC BY-NC-SA 4.0 — non-commercial and share-alike**. EdgeDesk sells
subscriptions, so ingesting those files into its production database is a
licensing question that must be resolved before any tennis aggregate ships.
The UFCStats-derived UFC schema is not covered by that licence; the UFC field
dictionary implemented above is a schema description, not the data itself.

## Inconsistencies the dictionary surfaced (reported, not changed)

Wiring the source definitions to the live labels exposed three places where the
app's label and the source's definition disagree. Each is a presentation or
protocol decision, so none was changed:

1. `submission_avg` renders as **"Sub attempts / fight"** on the stat grid and
   **"Submission att/15min"** on the profile — one column, two different claims.
   The source defines it per 15 minutes.
2. `knockdown_avg` renders as **"Knockdowns/15min"**, while the source schema
   defines `knockdowns` as a **career count**. The app displays an average from
   a differently-named column; the two are not the same measure.
3. The stat grid's footer says per-minute microstats "aren't in this source, so
   they're omitted", but the fighter profile displays both **SLpM** and
   **control time**. One of the two statements is stale.
