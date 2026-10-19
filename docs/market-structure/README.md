# NFL Market Structure

A **Market Structure** section on every NFL game card, a **Drift** strip above
the NFL board, and four **EXPERIMENTAL** studies registered against them.

Everything here is a T0 observation or a T2 deterministic transform of data
EdgeDesk already owns. **No NFL projection, spread, probability, EV, ranking or
grade changes.** The football module calls `window.fbMarketStructureHTML()`
from three guarded one-line hooks and appends what it returns. Nothing here is
read back by the module, the decision engine or the record. Only a validation
report can later promote any of it into the prediction engine, one module at a
time, against the frozen baseline.

## The four modules

| Module | Tier | Data | Lives in |
|---|---|---|---|
| **Key numbers** | T2 | The final margins of 7,368 settled NFL games, 1999–2026 (`football/pricing/lines_nfl.json`, nflverse consensus close) | `lib/edgedesk_market_structure.js`, `football/market_structure/nfl.json`, `public.nfl_margin_frequency`, `public.half_point_value(line, window)` |
| **Snapshot delta** (stale line) | T0 + T2 | EdgeDesk's own capture history (`public.signal_ticks`, `public.signals`) | `public.nfl_line_snapshots`, `nfl_consensus_spread_at`, `nfl_line_snapshot_take`, `nfl_snapshot_board` |
| **Situational flags** | T0 + T2 | nflverse schedule (`div_game`, `location`), settled 2026 closes | `public.nfl_team_divisions` (seeded), `football/market_structure/nfl.json` `situational` |
| **Contest ownership** | T0 | Circa Sports Million weekly selections PDF | `supabase/functions/circa_ownership_sync`, `public.contest_ownership*` |

### Key numbers

The key numbers are 3, 6, 7, 10 and 14. These are capture's own
`KEY_NUMBERS.nfl`, and a test fails if the two lists drift.

Margins are measured in two windows (every settled game, and 2023 onward) and
on two bases:

- **abs:** the absolute margin.
- **fav_signed:** the closing favourite's score minus the underdog's. Pick'em
  closes are excluded and counted.

**The half-point value reads the favourite-signed mass.** A −6 or +6 side
pushes only when the favourite wins by exactly 6, which is 3.6% of games
overall and 4.6% since 2023. The absolute share at 6 (6.0%) also counts
underdog wins by 6, so it overstates the push. For each half point either way,
the card reports the share of games whose result changes:

- push → win
- push → loss
- loss → push
- win → push

It never reports a cover probability for the game. A league distribution does
not know the game.

`half_point_value()` in SQL and `halfPoint()` in JS are held equal at every
half point from −20 to +20 in both windows. `halfPoint()` is also checked
against the existing `EDExecution.halfPointValue()`.

**Six watch** marks a line at 5.5, 6 or 6.5.

**Drift** is the league's two-point try share, two-point tries ÷ all tries,
from nflverse play-by-play since 2015 (the season the extra point moved back).

> **Finding at build time.** The two-point share for 2026 is **9.2%** (43 of
> 467 tries) against **9.5%** pooled over 2023–25: z −0.18, **STABLE**. The
> data does not show rising two-point attempts this season.
>
> The favourite-by-six share is up from 3.6% to 4.6% since 2023. That is
> about 1.5 standard errors on n = 947, so it is suggestive and not
> established. H-NFL-KEY-01 is where it gets tested.
>
> `nflverse stats_team_week.def_2pt_atts` counts DEFENSIVE two-point returns,
> not attempts against, so it cannot measure this.

### Snapshot delta

The freeze is Thursday 13:00 America/New_York (`market_snapshot_config`;
configurable per sport). Every game kicking off in the six days after it is
frozen at the consensus main line, read by one rule. That one rule serves for
the freeze, the current number and the close:

1. Take the latest capture pass at or before the instant (it must be younger
   than 420 minutes).
2. Of the home side's spread rows on that pass, keep those whose de-vigged
   fair is near even money (0.35–0.65).
3. Pick the most books, then the fair nearest 50%, then the smaller number.

The freeze reads history at or before its instant. So a late cron run, a
retry or the backfill (`nfl_line_snapshot_backfill`) records the same number a
punctual run would, and `taken_at` says which it was.

**The flag.** A move is flagged when it is a full point or more, or when it
touches 3, 6, 7, 10 or 14. "Touches" uses capture's closed interval: 2.5 → 3
lands on 3, and 3 → 3.5 leaves it. The interval is signed, so a move through
PK (−3.5 → +3.5) touches 3, where capture's absolute-value comparison would
see no move at all.

**The CLV** is of the frozen best price on the side the market moved toward:
entry decimal × closing de-vigged fair − 1. That is the close pipeline's own
formula (`close/index.ts decideClose`). It uses the close pipeline's fair
where it priced that number, else the last capture tick before kickoff. Every
withheld CLV carries its reason.

**Injury and QB status after the freeze: Coming Soon.** EdgeDesk owns the
official report (`football/injuries/`, nflverse), but nflverse publishes no
change time for 2026 (`date_modified` is empty). So EdgeDesk cannot say a
status changed after the freeze, and the card says so instead of guessing.

### Situational flags

For each side the card shows:

- favourite or underdog;
- home, road or neutral (from nflverse `location`);
- divisional, from the seeded `nfl_team_divisions`, which agrees with
  nflverse `div_game` on all 107 games of 2026;
- divisional home dog.

It also shows the 2026 season-to-date ATS record of every bucket those flags
put the side in, against the closing consensus. Every record carries its W-L-P,
its n and a Wilson 95% interval. Pushes are shown and kept out of the rate.

### Contest ownership (Circa Million)

`circa_ownership_sync` does the following:

1. It finds the week's PDF: a link on circasports.com first, then the upload
   pattern `/wp-content/uploads/YYYY/MM/Circa-Sports-Million-<edition>-Week-<n>-Selections.pdf`.
   It tries the Saturday's month, the Thursday's, then the next.
2. It reads the PDF with `npm:unpdf@1.8.1`, rebuilding lines from text
   positions rather than trusting the PDF's own line breaks.
3. It parses every entry's five picks (`16. EAGLES +1`).
4. It resolves each club through `lib/football_identity.js`'s alias table
   (copied verbatim and drift-tested), and each club to the week's game
   through EdgeDesk's own captured events.
5. It writes through `contest_ownership_ingest()`.

**What it refuses:**

- **No PDF.** Before that week's Sunday 13:00 ET this raises a WARNING; after
  it, a FAILURE.
- **Unreadable.**
- **No entries.**
- **A stated entry total the rows do not reach.**
- **More than 1% of rows that are not five picks.**

Each of these is a **failed** run: nothing is published and
`market_structure_alerts` says why.

A pick that resolves to no club, an ambiguous city, a club with no game that
week, or a minority contest line is **quarantined** with its own text, and the
run publishes as **PARTIAL**, labelled so. The database refuses a run whose
picks do not add up (placed + quarantined = 5 × entries), and refuses a
"complete" run that carries quarantine.

The card never shows a failed run, and never lets an earlier week stand in for
this one. It shows the contest line beside the market's, because they differ
after the Thursday freeze. Ownership is **by entry, not unique player**.

## Research Models (Experimental)

`football/market_structure/preregistration.json` (sha256 pinned; append-only)
registers the four studies. Each one has:

- an objective;
- training, validation and holdout windows;
- a minimum sample;
- a primary metric;
- a decision rule (`passed = true` only on its holdout);
- a forking-paths disclosure.

All four primary tests are one-sided at α = 0.0125 (Bonferroni across four).

| Study | The test | Holdout |
|---|---|---|
| H-NFL-KEY-01 | Sides frozen at +6 / +6.5 / −5.5: rate of CLV > 0 vs every other frozen side | 2027–28 (≈ 2 sides a week, so n ≥ 80 takes two seasons) |
| H-NFL-STALE-01 | Games flagged **at Saturday 12:00 ET** (never at the close, which would be circular) vs unflagged movers | 2027 |
| H-NFL-OWN-01 | In games with a ≥ 70 / ≤ 30 ownership split, does the minority side cover the contest line above 50%? Descriptive until 60 such games | 2027 |
| H-NFL-DIV-01 | Divisional underdogs vs non-divisional underdogs at the same closing-line stratum (Mantel–Haenszel) | 2026 Week 8 – 2027 |

`supabase/nfl_market_structure_studies.sql` is generated from the document
(`tools/football/build_prereg_sql.js`). The registry's DDL is only in
production. So the file reads the live columns and enum labels, maps the
studies onto the names that exist, and stops before writing anything if a
required column has no mapping. It writes **no result row**.

## Deploy, in order

1. **`supabase/nfl_market_structure.sql`** — paste into the SQL editor. Every
   report row should read ok. Row 10 needs capture_v9's tick index.
2. **`supabase/nfl_market_structure_cron.sql`** — the Thursday freeze on
   pg_cron. It is pure SQL, with no HTTP and no secret.
3. **Reconstruct this season's freezes** from capture history, so that Weeks
   1–7 are there to check the pipeline (they are not evidence; see the
   studies):

   ```sql
   select public.nfl_line_snapshot_backfill('2026-09-01');
   ```

4. **`supabase/contest_ownership.sql`**.
5. **Deploy the function:**

   ```
   supabase functions deploy circa_ownership_sync --no-verify-jwt
   ```

   Set `CIRCA_CRON_SECRET` on it, and the same value in Vault:

   ```sql
   select vault.create_secret('<secret>', 'circa_cron_secret');
   ```

6. **`supabase/contest_ownership_cron.sql`** — Saturday 10:00–18:00 ET every
   two hours, and Sunday 08:00, 10:00 and 12:00 ET.
7. **`supabase/nfl_market_structure_studies.sql`** — the registration. Every
   report row should read ok.
8. **Run the *NFL market structure* workflow once** (or
   `node tools/football/market_structure_sync.js` with `SB_URL` and
   `SB_SERVICE_ROLE` set). It loads `nfl_margin_frequency` and
   `nfl_two_point_weekly`. After that it runs daily, and `injury-sync.yml`
   rebuilds the margin windows whenever the line archive moves.

Until a step is applied, the card shows that part as **Not deployed** and names
the file. It reads its own tables as the anon visitor, not through `sbFetch`,
so an unapplied table is never reported as a database outage on System health.

## The first live Circa week: check by hand

The parser has been proved only against a **synthetic** document built to the
published shape: `tools/football/fixtures/circa/`, with an entry that wraps, a
club that does not exist, a bye, an ambiguous city, and a layout whose cells
wrap inside themselves, which it must refuse. The build environment could not
reach circasports.com. Before trusting a live week:

1. Run a dry read, which writes nothing:

   ```
   curl -X POST .../functions/v1/circa_ownership_sync \
     -H 'x-cron-secret: …' -d '{"dry":true}'
   ```

2. Check that `run.entries_parsed` equals the entry count the PDF states.
3. Check that `run.picks_parsed` equals 5 × entries.
4. Check that `validation.rows_unread` is 0, and read every `quarantine` row.
5. If the PDF states no total, count its rows once by hand.

## Known limitations

These are things EdgeDesk does not own, so the card does not show them:

- injury-status timing (Coming Soon);
- margins before 1999;
- ownership by unique player.

Also:

- The freeze, the current number and the close are EdgeDesk's own capture
  (Odds API books), not Circa's line source.
- The season-to-date records are small samples. They describe; they do not
  predict.

## Tests

| Suite | What it covers |
|---|---|
| `tools/football/market_structure.test.js` | The core, the builder and the committed artifact (no network, no database) |
| `tools/football/market_structure_sql.test.js` | The migration on a real PostgreSQL: every snapshot status, DST, idempotent runs, the backfill, the board, both CLV sources, append-only, grants, SQL ↔ JS parity |
| `tools/football/circa_ownership.test.js` | Core, drift, the synthetic PDFs through unpdf, the database, and the edge function under Deno feeding the real database (`EDGEDESK_UNPDF`, `EDGEDESK_DENO`) |
| `tools/football/market_structure_prereg.test.js` | The document, and its registry SQL against six registry shapes, including two it must refuse |
| `tools/football/market_structure_ui.e2e.js` | Chromium, three scenarios: deployed, not deployed, and **frozen**. Frozen serves the committed `app.html` and this one and requires every NFL card line outside the new section to read the same |

All of them run in `.github/workflows/market-structure-tests.yml`.
