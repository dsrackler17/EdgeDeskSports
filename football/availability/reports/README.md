# Ingested official availability reports

One file per conference report EdgeDesk has read, written by
`football/availability/ingest_report.js` and merged at read time by
`football/availability/overlay.js`.

Each file is the output of `football/availability/reports.js` `ingest()` and
carries, for one team and one fixture:

* the conference and the policy scope the report was filed under
* the **source url**, the **publication time** (when the conference filed it)
  and the **retrieval time** (when EdgeDesk read it) — two clocks, never one
* every named player resolved to an athlete id on the current roster, with a
  status from that conference's own published vocabulary
* every line that named a rostered player and could **not** be parsed, kept so
  a parser gap is visible instead of looking like an absence
* `silence_means_available`, which is true only when the policy registry marks
  that conference's report COMPREHENSIVE **and** the document was read in full
  **and** it designates nobody on the roster

A read that failed is written with `ok: false` and the reason. Nothing
downstream may read a failed read as a report that named nobody.
