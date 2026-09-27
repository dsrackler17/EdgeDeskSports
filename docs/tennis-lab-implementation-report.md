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

**The full archive is imported. All 14 parts verified and reconciled.**

| | |
|---|---:|
| parts declared | 14 |
| parts verified | **14** |
| parts missing | 0 |
| parts invalid | 0 |
| rows declared | 361,571 |
| rows counted | **361,571** |
| one column order | yes (108 columns) |
| **accepted** | **361,567** |
| **quarantined** | **4** |
| accounted for | 361,571 — **RECONCILED** |
| **stored as matches** | **361,567** — RECONCILED |

**The 4 quarantined rows** all fail the same rule — winner and loser are the
same player. Three are the archive's "U Unknown" placeholder playing itself;
one is a source error where a real name is duplicated on both sides. They are
kept in staging with their reason, not discarded.

**Coverage:** 361,567 matches (ATP 199,386 / WTA 162,181) · 15,515 players ·
723,134 point-in-time feature rows · 1967-12-25 → 2026-05-25 · 6,900 ranked.

The gate did its job before it opened. Part 11 arrived last; with thirteen parts
present `npm run tennis:record:verify` exited 1 and the importer refused before
reading a byte. That is the brief's own rule (*"Do not proceed with a partial
import"*) as code rather than as a remembered instruction — and it was the right
behaviour, because importing 13 of 14 would have **succeeded**: every total
would have reconciled against what was read, and the record would have been
permanently short 8,636 matches with nothing downstream ever saying so.

### The defect the real import found: 16 matches were being silently lost

The first import of the complete archive reconciled 361,571 read against
361,567 accepted + 4 quarantined — and stored only **361,551 matches**. Sixteen
accepted rows never became rows, and nothing said so.

Cause: a match's identity was its **draw slot** alone —
`(source, tour, tournament, match number)`. That is not unique in this archive.
Five WTA events restart `match_num` inside what the source calls one
`tourney_id` (combined draws and satellite series such as
`1973-W-SL-USA-01A-1973`), giving 16 slots that each hold two **different**
matches. The second silently overwrote the first. One of the casualties was a
Billie Jean King match.

This is exactly the failure the multi-part verifier exists to prevent, one layer
further down: everything succeeded, every total reconciled against what was
*read*, and the record was quietly short.

**Two fixes, both shipped:**

1. **Identity is the draw slot AND the unordered player pair.** The pair is
   unordered, which preserves the property the slot key existed for: a
   corrected result swaps winner and loser, the pair is unchanged, and the
   correction updates the match it corrects instead of creating a second one.
   Enforced by a unique index with `nulls not distinct`.
2. **The reconciliation is closed at the far end.** Both import paths now check
   accepted against **actually stored**, name the colliding slots, mark the run
   `error`, and derive nothing from it. A future collision cannot be silent.

Re-import with the fix: **361,567 accepted, 361,567 stored.** All 16 recovered.

### Also proven against a synthetic archive at the same scale

`tools/tennis/fixtures/make_archive.js` generates the real 108-column shape at
any cardinality via a two-phase forward walk, so the `*_pre` columns are
genuinely point-in-time and latent per-surface affinities are never exposed. Used
for the pre-import work and retained for CI.

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

Trained and evaluated on **the real archive**. Chronological split; test window
53,850 matches.

| | n | log loss | Brier | accuracy |
|---|---:|---:|---:|---:|
| **EdgeDesk** | 53,850 | **0.6144** | **0.2134** | **65.7%** |
| overall Elo | 53,850 | 0.6261 | 0.2185 | 64.4% |
| surface Elo | 53,850 | 0.6346 | 0.2223 | 63.4% |
| official ranking | 52,874 | 0.6310 | 0.2207 | 64.0% |
| market | — | **not possible** | | |

Calibration ECE **0.0177** across all ten bins, largest gap 3.5 points.

By segment: ATP 0.6131 / WTA 0.6158 · hard 0.6123 · clay 0.6205 · grass 0.6097.

### The promotion gate PASSED

| check | result |
|---|---|
| beats overall Elo | **yes** |
| beats surface Elo | **yes** |
| beats the ranking | **yes** |
| calibration ECE ≤ 0.05 | **yes** (0.0177) |
| **qualifies for production** | **YES** |

Registered as `tennis-baseline-2026.09.19.874`, **status active**.

Worth recording: on the synthetic stand-in the same model did **not** qualify —
it lost to surface Elo, which is near-optimal there by construction because the
generator decides winners from surface-adjusted running Elo. The gate refused to
promote it then and promoted it now. **The gate decides, not the operator**, and
it reached opposite conclusions on the two datasets for the right reason.

**No market baseline is possible.** No historical tennis odds exist for this
record, and the build says so on every run rather than passing over it. The model
has not been shown to beat a price.

---

## 6. Data-quality findings

Measured on the real archive.

| finding | handling |
|---|---|
| **16 matches silently lost to an identity collision** | fixed — see §3. Identity now includes the unordered player pair; reconciliation closed at the far end |
| **4 rows where winner and loser are the same player** | quarantined with the reason, kept in staging |
| **a placeholder competitor ("U Unknown") carrying 87 matches by 87 different people** | flagged `is_placeholder`; never listed as a player anywhere. Its **matches stay** — the opponents' records are real. "Unknown *Surname*" players are deliberately NOT suppressed: those are real people whose given name the archive lacks |
| **the archive ends 2026-05-25, 117 days before today** | form windows are anchored to the **last match on file**, not the wall clock, and the anchor is stored (`form_as_of`) and printed. Against `current_date` every one of 15,515 players had a null 30- and 90-day form and classified `returning`; two of the ten views rendered nothing |
| **surface rating vs overall rating measured at different career points** | the translator now differences the surface Elo against the overall Elo **from the same feature row**, so it compares one moment rather than two |
| serve statistics absent before 1991 (18% of players have a rolling rate) | `null`, named on the card as a gap, never 0 |
| 7,886 matches with unknown surface | carried as `unknown`, never assumed |
| environment on a minority of events (15% of players have an indoor split) | reported only where it exists; neither assumed |
| negative `rest_days` | the archive dates to the **tournament week**, so an event in progress looks forward-dated. Reported as unknown + a named `future_dated_match` issue; match counts still classify |
| power rating clamps at 0 and 100 (Sinner and Alcaraz both sit at 100) | leaderboards break ties on Elo; the rank-gap board excludes clamped players |
| 96% of players classify `returning` | correct — most players in a 60-year archive are retired. 580 are active at the anchor date; the labs filter on it |

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

`EXPLAIN (ANALYZE)` against the **real archive**: 361,567 matches / 723,134
feature rows / 15,515 players, PostgreSQL 16.

| read | measured | target | |
|---|---:|---:|---|
| dashboard leaders | 38.9 ms | 500 | OK |
| leaders, clay | 32.6 ms | 500 | OK |
| movers | 24.4 ms | 500 | OK |
| surface translator | 35.0 ms | 500 | OK |
| trajectory board | 24.3 ms | 500 | OK |
| fatigue board | 23.3 ms | 500 | OK |
| rank-gap board | 30.3 ms | 500 | OK |
| player card | 8.2 ms | 300 | OK |
| player history | 1.9 ms | 300 | OK |
| player splits | 15.6 ms | 300 | OK |
| player matches | 21.4 ms | 300 | OK |
| matchup inputs | 6.5 ms | 500 | OK |
| head to head | 3.5 ms | 500 | OK |
| explorer (page of 50) | 86.4 ms | paginated | OK |
| explorer summary | 72.1 ms | - | OK |
| player search | 11.1 ms | - | OK |
| lab health | 81 ms *(from 159)* | - | OK |

**Builders on the real archive:** import 2m52s (14 parts, ~2,100 rows/s) ·
features 128 s · ratings 13 s · history 192 s · signals 9 s · model 81 s ·
brief < 1 s.

`lab_health` is loaded on every render and was the dashboard's dominant read.
Three rounds of profiling its components:

- `min(season)`/`max(season)` each cost a sequential scan of 361k rows — the
  existing season index leads with `tour`, so a bare aggregate cannot use it. A
  plain btree took both to 0.1 ms.
- `lab_market_available()` was called twice for two fields of one answer. A
  lateral join calls it once.
- `count(*)` over `tennis.rating_history` — 435,350 rows, 21 ms — for a field
  **nothing displayed**. Replaced with `max(as_of)`, which answers the same
  operational question ("is the history current?") off an index.

159 ms to 81 ms, output verified identical each time.

**Keyset pagination proven:** three pages of 20 return 60 rows and 60 distinct
ids — no overlap, no gap. Page 400 costs what page 1 costs.

**Nothing bulk-loaded into the browser.** Every read is an RPC that caps its own
limit, because a PostgREST table read can be handed `?limit=100000` by anyone
and a function cannot.


---

## 9. Tests executed

| suite | assertions | database |
|---|---:|---|
| tennis lab engine | 153 | no |
| tennis lab UI | 130 | no (real captured fixtures) |
| tennis model engine | 200 | no |
| tennis providers | 101 | no |
| tennis AI retrieval | 83 | no |
| tennis research board UI | 100 | no |
| tennis pipeline | 283 | no |
| tennis match centre UI | 119 | no |
| **tennis lab SQL** | **90** | **yes** |
| tennis record SQL | 79 | yes |
| tennis importer | 89 | yes |
| tennis feature leakage | 86 | yes |
| tennis live centre SQL | 66 | yes |
| **total** | **1,576** | 410 against real PostgreSQL |

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

**None.**

The archive is imported and reconciled, the pipeline has run end to end, the
model qualified and is active, and the Lab serves the full record.

Two things are *absent rather than blocked*, and both are expected:

- **No current-results provider.** The archive ends 2026-05-25. Form windows are
  anchored to that date and labelled, so the product is correct rather than
  empty — but it describes the record through May, not this week. §12 is the
  exact next step.
- **No odds provider.** By design. The Market Comparison module is off and the
  Lab does not need it. §13 is the exact next step if one is ever wanted.


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
