# EdgeDesk Tennis Lab — implementation report

---

## 1. Files created and modified

**Created (11)**

| file | what |
|---|---|
| `lib/tennis_lab.js` | the research engine — surface translation, trajectory, workload, matchup projection, comparison, comparables, the brief |
| `supabase/tennis_lab.sql` | the schema layer, additive over `tennis_record.sql` |
| `tools/tennis/build_lab.js` | derived signals and classifications |
| `tools/tennis/build_history.js` | rating-history snapshots |
| `tools/tennis/build_brief.js` | the daily research brief (no odds, no schedule) |
| `tools/tennis/fixtures/make_archive.js` | synthetic archive at production cardinality |
| `tools/tennis/lab.test.js` | 153 engine assertions |
| `tools/tennis/lab_ui.test.js` | 130 rendered-UI assertions |
| `tools/tennis/lab_sql.test.js` | the real-PostgreSQL harness |
| `tools/tennis/sql/tennis_lab.test.sql` | 90 assertions, attacked as `anon` and `authenticated` |
| `docs/tennis-lab.md`, `docs/runbooks/tennis-lab.md` | architecture and operations |

**Modified (9)**

`app.html` (the Tennis Lab block, CSS, nav, two engine script tags) ·
`supabase/functions/edgedesk_ai/_tennis.js` (8 Lab intents, 4 retrievals, 8 rules) ·
`supabase/functions/edgedesk_ai/index.ts` (re-inlined) ·
`package.json` (9 scripts) ·
`.github/workflows/games-sql.yml` (lab SQL suite) ·
`.github/workflows/tennis-record.yml` (history, signals, brief) ·
`tools/tennis/ai_tennis.test.js`, `tools/tennis/board_ui.test.js` (assertions whose pinned facts legitimately changed) ·
18 captured fixtures under `tools/tennis/fixtures/`

36 files, +6,918 / −28.

---

## 2. Database objects created

Additive over `tennis_record.sql`. **No existing table's semantics were altered.**

- **3 tables** — `rating_history`, `research_briefs`, `lab_flags`
- **20 new nullable columns** on `player_ratings_current` — serve/return strength
  and sample, strength of schedule (recent + career), indoor/outdoor split,
  four per-surface win rates, `trajectory_class`, `trajectory_direction`,
  `workload_class`, `rating_delta_30d`, `rating_delta_90d`, `lab_version`
- **21 functions** — 17 `lab_*` reads + 4 `ai_lab_*` assistant doors
- **2 views** — `lab_player_row`, `lab_health`
- **15 indexes**, each existing because a query in this file orders by it
- **3 constraints** enforcing product rules: a brief cannot carry odds, cannot
  carry selections, and cannot be rewritten after publication
- **RLS on all 3 new tables**, no client write on any of them

The file refuses to apply at all if `tennis_record.sql` is not underneath it,
and says what to do.

---

## 3. Import reconciliation

**The historical import has not run. It is blocked, and the blocker is the
dataset, not the code.**

`00_manifest.json` declares 14 parts totalling exactly **361,571** rows.
Thirteen are present and verify exactly — checksum, byte size, decompressed row
count, and one consistent 108-column order across all of them.

**Part 11 is missing:**

```
11_EdgeDesk_Tennis_ATP_2021_2023.csv.gz
  8,636 rows · 1,906,112 bytes
  sha256 6a7a9dd4253fbf74863de95a8f51e8fefb086aee020a1d4985d338fde2da8909
```

| | |
|---|---:|
| parts declared | 14 |
| parts verified | 13 |
| parts missing | **1** |
| parts invalid | 0 |
| rows declared | 361,571 |
| rows counted | **352,935** |
| one column order | yes (108 columns) |

`npm run tennis:record:verify` exits 1 and the importer refuses before reading a
byte. That is the brief's own rule (*"Do not proceed with a partial import"*)
implemented as code rather than remembered as an instruction, and it is the
right behaviour: importing 13 of 14 parts would **succeed**. Every total would
reconcile against what was read, and the record would be permanently missing
8,636 matches with nothing downstream ever saying so.

**To unblock:** upload part 11, then

```bash
npm run tennis:record:verify -- --manifest 00_manifest.json --dir <dir>
npm run tennis:record:import  -- --manifest 00_manifest.json --dir <dir> --chunk 20000 --fast
npm run tennis:features:build && npm run tennis:ratings:build
npm run tennis:history:build  && npm run tennis:lab:build && npm run tennis:brief:build
```

### What the Lab was proven against instead

A synthetic archive at **production cardinality**, generated in the real
108-column shape by a two-phase forward walk so the `*_pre` columns are genuinely
point-in-time:

**361,575 matches · 723,150 feature rows · 4,044 players · 1968–2026 · four
surfaces**, with the archive's real holes reproduced (no serve statistics before
1991, rankings absent for early years, environment on ~34% of events, weather on
a subset of outdoor ones). Players carry latent per-surface affinities that
nothing downstream is told.

Import reconciled exactly: 180,787 + 180,788 accepted, **0 rejected, 0
quarantined**.

---

## 4. Model methodology

Unchanged from the record contract — the Lab consumes it rather than replacing
it. Logistic regression over 16 feature **differences**, L2-regularised, fitted
in pure JS. Chronological train/validation/test split, never random. Training
rows are symmetric by construction. Every input is point-in-time: the leakage
suite recomputes the rolling aggregates by hand from strictly-earlier matches and
fails on any disagreement.

The Lab adds one thing: the matchup studio calls the model's **own**
`featureVector`/`predict` rather than re-deriving the differences, so the studio
and the model evaluation cannot disagree.

---

## 5. Evaluation results

Trained and evaluated on the production-scale record. Test window 54,237
matches, 2009-03-19 → 2026-09-26.

| | n | log loss | Brier | accuracy |
|---|---:|---:|---:|---:|
| **EdgeDesk** | 54,237 | **0.5865** | **0.2026** | **66.9%** |
| overall Elo | 53,161 | 0.6592 | 0.2333 | 60.6% |
| **surface Elo** | 53,161 | **0.5845** | 0.2017 | 67.3% |
| official ranking | 37,945 | 0.6622 | 0.2349 | 60.8% |
| market | — | **not possible** | | |

Calibration ECE **0.0060** across all ten bins, largest gap 1.1 points.

By segment: ATP 0.5850 / WTA 0.5880 · hard 0.5644 · clay 0.5840 · grass 0.6410 ·
carpet 0.6575.

### The promotion gate refused

| check | result |
|---|---|
| beats overall Elo | yes |
| **beats surface Elo** | **NO** (0.5865 vs 0.5845) |
| beats the ranking | yes |
| calibration ECE ≤ 0.05 | yes (0.0060) |
| **qualifies for production** | **no** |

The candidate was **registered and production did not move**. This is the brief's
own requirement — *"Do not activate the complex model if it fails to improve upon
or complement the simpler baselines"* — working, and it is reported rather than
overridden.

On this data that outcome is expected: the generator decides winners from
surface-adjusted running Elo, so surface Elo is near-optimal by construction. On
the real archive the comparison will differ. Either way, **the gate decides, not
the operator.** The Lab renders correctly with no active model and the studio
says so on the card rather than implying a trained model produced the number.

**No market baseline is possible.** No historical tennis odds exist for this
record, and the build says so on every run rather than passing over it. The model
has not been shown to beat a price.

---

## 6. Data-quality findings

| finding | handling |
|---|---|
| serve statistics absent before 1991 (~49% of feature rows) | `null`, named on the card as a gap, never 0 |
| strength of schedule computable for 97% of feature rows | the rest reported absent |
| recent SOS available for 27% of players | correct — most players in a 60-year archive are retired |
| ~82% of players classify `returning` | correct, same reason; live-player views filter on activity |
| environment on ~34% of events | indoor/outdoor split reported only where it exists; neither assumed |
| negative `rest_days` | the archive dates to the **tournament week**, so an event in progress looks forward-dated. Reported as unknown + a named `future_dated_match` issue; match counts still classify |
| power rating clamps at 0 and 100 | leaderboards break ties on Elo; the rank-gap board excludes clamped players |
| 2026 partial | declared as a quality signal; season totals are incomplete by construction |

Eleven signals are tracked and surfaced: `sample_size`, `missing_ranking`,
`missing_surface`, `missing_serve_stats`, `uncertain_venue`,
`weather_unavailable`, `inactive`, `low_surface_experience`, `stale_source`,
`conflicting_identity`, `partial_2026_coverage`.

---

## 7. Security verification

90 assertions against a real PostgreSQL 16, attacked as `anon` and as a
signed-in free account. Every claim is tried, not reasoned about.

- RLS on all 3 new tables; no client role may write any of them
- `anon` cannot reach `player_match_features`, `stg_archive_matches`,
  `ingestion_runs` or `data_quality_issues` — by table, view or RPC
- `anon` **can** read the entire research product (20 assertions)
- every privileged function fixes its `search_path`; none is executable by
  `public`
- a published brief is immutable, including to its writer
- the licence gate reaches `rating_history`
- every read caps its own limit (proven by asking for 1,000,000)
- the cutoff is strict: a match planted after the cutoff cannot reach the answer

### The defect the attack suite found

`lab_matchup_inputs` and `lab_comparables` were `security invoker` and read the
**private** feature table. PostgreSQL checks table permissions when it *plans* a
statement, not when a branch returns rows — so **the Matchup Studio returned
`permission denied` to every signed-out visitor in both modes**, including the
one where the private branch produces nothing at all.

Now `security definer` with a fixed `search_path`: what leaves them is two rows
of pre-match state for two named players, and the table stays shut. The
migration report asserts it.

No amount of reading would have found this.

### A second, in the market gate

The gate asked "is any cleared source registered?" and "is any snapshot fresh?"
separately. The record contract **seeds** `odds_api` as commercially cleared, so
the provider half was already satisfied on a fresh install by a row that has
never delivered anything — the gate would have opened on the first snapshot from
any source. It now asks one question as a join: *has a cleared source recently
delivered*. A fresh snapshot from an uncleared source is proven not to open it.

---

## 8. Performance results

`EXPLAIN (ANALYZE, BUFFERS)` against 361,575 matches / 723,150 feature rows /
4,044 players.

| read | measured | target | |
|---|---:|---:|---|
| dashboard leaders | 13.7 ms | 500 | ✅ |
| surface board | 14.5 ms | 500 | ✅ |
| movers | 9.9 ms | 500 | ✅ |
| rank-gap board | 11.7 ms | 500 | ✅ |
| player card | 5.5 ms | 300 | ✅ |
| player history | 1.5 ms | 300 | ✅ |
| player splits | 17.1 ms | 300 | ✅ |
| matchup inputs | 9.2 ms | 500 | ✅ |
| head to head | 4.9 ms | 500 | ✅ |
| explorer (page of 50) | 72.5 ms | paginated | ✅ |
| lab health | 55 ms (was 171) | — | ✅ |

**Builders:** import 2×85 s · features 125 s · ratings 12 s · history 190 s ·
signals 8 s · brief < 1 s.

`lab_health` is loaded on every render and was the dashboard's dominant cost at
171 ms. Profiling its components found `min(season)` and `max(season)` each
costing a sequential scan of 361,575 rows — the existing season index leads with
`tour`, so a bare aggregate cannot use it — and `lab_market_available()` being
called twice for two fields of one answer. A plain btree on `season` and a
lateral join took it to 55 ms. **Output verified identical.**

**Keyset pagination proven:** three pages of 20 return 60 rows and 60 distinct
ids — no overlap, no gap. Page 400 costs what page 1 costs.

---

## 9. Tests executed

| suite | assertions | database |
|---|---:|---|
| tennis lab engine | 153 | no |
| tennis lab UI | 130 | no (real captured fixtures) |
| tennis model engine | 179 | no |
| tennis providers | 101 | no |
| tennis AI retrieval | 83 | no |
| tennis research board UI | 100 | no |
| tennis pipeline | 283 | no |
| tennis match centre UI | 119 | no |
| **tennis lab SQL** | **90** | **yes** |
| tennis record SQL | 75 | yes |
| tennis importer | 85 | yes |
| tennis feature leakage | 86 | yes |
| tennis live centre SQL | 66 | yes |
| **total** | **1,550** | 402 against real PostgreSQL |

Also green: `games:test` (114 + 43), `app navigation` (104), `research landing`
(107), `ufc`, `mlb`, `collective`, `articles`, `editorial`, `newsletter`.

**The engine suite is mutation-tested.** Six deliberate breaks — disabling the
softer-draw rule, removing the uncertainty floor, removing surface shrinkage,
defaulting a missing workload to normal, projecting a sparse matchup instead of
declining, and coercing a null Elo to zero — each fail it. The assertions are
load-bearing, not decorative.

**Pre-existing failure, not from this work:** `tools/intelligence/evals.test.js`
fails 2 of 258 on date-dependent fixtures. Verified identical on clean
`origin/main`; this branch touches nothing under `tools/intelligence/`.

---

## 10. Deployment steps

```bash
# 1. schema, in order
psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql    # if not already applied
psql "$SUPABASE_DB_URL" -f supabase/tennis_lab.sql       # every report row must read ok

# 2. expose the schema
#    Project Settings → API → Exposed schemas → include `tennis`

# 3. the pipeline, in order
npm run tennis:features:build
npm run tennis:ratings:build
npm run tennis:history:build      # before the signals — the deltas measure against these
npm run tennis:lab:build
npm run tennis:brief:build

# 4. deploy the assistant
supabase functions deploy edgedesk_ai
```

Nightly thereafter via `tennis-record.yml` (`nightly` job). No new secret: it
uses the existing `SB_DB_URL`.

---

## 11. Remaining blockers

**One, and it is the dataset.**

Archive **part 11** (`11_EdgeDesk_Tennis_ATP_2021_2023.csv.gz`, 8,636 rows,
sha256 `6a7a9dd…8909`) has not been uploaded. 13 of 14 parts verify exactly. The
verifier exits 1 and the importer refuses.

Nothing else is blocked. Schema, engine, builders, UI, AI, brief, tests and docs
are complete and proven at production cardinality against a stand-in of the same
shape and size.

No credential blockers. No architectural blockers.

---

## 12. Exact next step: a licensed current-results provider

1. Register it:

```sql
insert into tennis.source_licenses
  (source_key, title, licence, commercial_use, research_use, cleared_by, cleared_at)
values ('your_results_feed', 'Provider Name', 'commercial', true, true, 'who cleared it', now());
```

2. Implement the adapter at `tools/tennis/providers/<name>_results.js` against
   the existing `TennisResultsProvider` contract (`providers/index.js`), and
   register it in `providers/index.js`.

3. Ingest under that `source_key`:
   `node tools/tennis/incremental.js results --commit`

4. Rebuild: `features → ratings → history → lab`.

**No downstream contract changes.** Player pages, the matchup studio, the
explorer and the AI are keyed on the schema, not the provider. The archive can
be retired by stopping its ingest; its rows stay, labelled with their own
`source_key` and licence.

---

## 13. Exact next step: optional live odds

1. Register the provider **with its commercial clearance named and dated** (as
   above, `commercial_use = true` plus `cleared_by` / `cleared_at` — the check
   constraint refuses commercial clearance without a named clearer).

2. Implement `TennisOddsProvider` and ingest into `tennis.odds_snapshots` under
   that `source_key`.

3. Only then:

```sql
update tennis.lab_flags set enabled = true, updated_by = 'you', updated_at = now()
 where flag_key = 'market_comparison';
```

4. Verify the gate actually opened:

```sql
select * from tennis.lab_market_available();   -- available must be true
```

All three conditions must hold: flag on, a commercially cleared provider, and a
snapshot from **that** provider inside six hours. The flag alone does nothing.

**Do not mark the historical archive commercially cleared.** It is CC BY-NC-SA —
non-commercial research — and the licence gate exists to refuse exactly that.

The core Lab does not depend on any of this and never will: ratings, surface
translation, form, workload, the studio, the explorer, the brief and the AI all
answer from the record alone.

---

## 14. What the Lab still does not have

- injuries and withdrawals — no source, and EdgeDesk holds no medical
  information about any player
- point-by-point — no source
- doubles ratings — a pair is a team
- exact first-serve times for historical matches — the archive dates to the
  tournament week
- historical odds — none exist, which is why there is no market baseline
- a verified current schedule — until one is registered the brief falls back to
  a trends or record brief and says which

Each is declared to the assistant as a capability set to `false`, so an answer
says so rather than substituting.
