# Model Collective football grading — audit and the football-v2 repair (NFL + CFB, 2026)

Branch `claude/dazzling-davinci-6bewtf`. Grading version introduced: **`football-v2`**.

## 0. What could and could not be checked from here

The Collective's database (`iattxbkbufslbauoumga.supabase.co`) was **not reachable** from the
environment this was written in: its network policy refuses the host and no database credential
was present. So:

* **Everything about the code** — every grader, every join, every route — was read, fixed and tested.
* **Everything the repository holds** — the committed settlement records
  (`collective/settled/{NFL,CFB}_2026.json`) and EdgeDesk's own ledgers
  (`football/cfb_lab`, `football/cfb_market`) — was measured, and 40 games were verified by hand.
* **The per-game A–L classification and the per-model corrected records need the database**:
  the predictions, the Collective's odds snapshots (`odds.*`) and EdgeDesk's capture history
  (`public.signals` / `signal_ticks`) live only there. The repair ships the routine that
  produces them (`collective.fg2_rebuild`, `collective.fg2_report`) and a one-click workflow
  that runs it (`.github/workflows/football-regrade.yml`). §9 is the runbook. No number in
  this document is presented as a production result unless it came from the committed record.

## 1. The ten questions

**1. Where ATS was calculated.** In four places that disagreed:

| Where | Side rule | Close it used |
|---|---|---|
| `collective.grade_game(game_id)` (deployed only; writes `collective.grades`) | stated `pick_side` only | `results.closing_spread` at settle time |
| `tools/collective/settle_finals.js` `gradeProjection` (L936) | stated side only — *"a side is never inferred here"* (L932) | same |
| `collective/index.html` `localGrade` (L2236) + `impliedSide` (L2225) | stated side, **else derived** from the model's spread vs the close | whatever the page could find: payload, committed JSON, odds board, per-game route |
| `collective/index.html` `consensusSeasonStats` (L2052) | the consensus view's `pct_picks_home` — **stated picks only** | payload close |

and the page chose between them with `rowGrade`: `return sg||localGrade(g,mr)` (L2331) — **any**
database grade won, including one with `pick_result: null`.

**2. Where closing lines were stored.** `collective.results.closing_spread` (read through
`collective.game_detail`); the Collective's odds feed (`odds.events` + a `closing` object served
by the deployed `collective_odds` function as `closing['spread:home']`); the committed JSON
record (`closing_spread`, `close_source`); and in-browser `g.result.closing_spread`, mutated by
`fillCapturedCloses` (L3336). EdgeDesk's own capture (`public.signals`, `signal_ticks`,
`book_quote_ticks`) and the CFB lab ledgers held further first-party prices nothing consulted.

**3. How a close was chosen.** Not by anything in this repository. The deployed odds pipeline
writes `closing` "after kickoff"; the Collective only ever read that one value — without its
observation time or book — through two routes, both keyed on the old link:
`/v1/<league>/closing/<game_id>` (needs `odds.events.collective_game_id`) and the week board
`/v1/<league>/odds?week=N` (a time window, `back` ≤ 8–28 days, whose `week` is only set on
linked events). Nothing selected "the final pregame snapshot"; nothing re-looked once a game
fell out of the window.

**4. How submissions matched games.** `collective_ingest` hands each row to the database's
`ingest_submission` (game ref, both teams, kickoff), which resolves it to a `collective.games`
id; the lock trigger (`supabase/lock_rule.sql`) marks the latest pre-lock row
`is_graded_candidate`. But `collective_public` showed each model's **first** on-time row
(`list.find(m => !m.is_late) ?? list[0]`, L550) and its rules text still said *"graded on its
first pre-kickoff live submission"* (L888) — the board showed one version, the grader graded
another.

**5. Why NFL had ~16 ATS grades from 47 finals.** From the committed NFL record:

| Week | Finals | Close in the record | Where the close came from |
|---|---|---|---|
| 1 | 16 | 16 | `collective` — `results.closing_spread` held it at settle time |
| 2 | 16 | 16 | `collective_odds` — the per-game route answered **after** settlement |
| 3 | 15 | 1 | `collective_odds` for TNF only; 14 Sunday/Monday games have none |

Week 2 is the whole story of the ~16: its closes were found by the settle job's record pass,
which wrote them **only to the JSON file** (`mergeRecord`, L1716) and never back to the database.
`grade_game` had run with no close, so every database grade on week 2 carried
`pick_result: null`, and the page — preferring any database grade — never graded those games
itself (and `atsReason` returned `null` for them, L2587, so they were counted neither as graded
nor as missing). Every model therefore had ≈ week 1 only: 16, or 15 where it skipped a game.
Week 3's 14 games had no close on either route when the record was last written
(2026-09-28 06:30Z); whether the feed holds pregame snapshots for them is exactly what
`fg2_rebuild` determines (class B/C recovered, or I/J/L).

**6. Why CFB reported ~614 model-games with "no captured close".** The committed CFB record
has a close on **56 of 246** finals (week 1: 48/58; weeks 2–4: 8/188). The closes were not
reaching the games because of identity, not capture:

* The schedule stores college teams as **ten-character codes** (`MISSISSIPP`, `WESTVIRGIN`,
  `COASTALCAR`); `game_detail.home/away` are those codes.
* `odds.link_collective_games` — even after the 2026-09-22 league-mapping fix — joins
  `odds.resolve_team(league, g.home)` on that code and requires `commence_date` to match
  exactly (migration L27–L48). A truncated code is not a name any odds provider uses, so the
  CFB events stayed **unlinked**, the per-game route answered "unavailable", and the week board
  (filtered on `week`, which only linked events carry, inside a moving time window) returned
  nothing once a week passed.
* The page's 10-character prefix join could only reach games still on the moving board.

So the "614" is (≈190 games × the models posting them), overwhelmingly classes **C/E** in the
new taxonomy: prices captured under an odds event id never linked to the game. The identity
layer in this repair resolves those names properly — measured on real data in §5.

**7. Whether historical snapshots exist to recover them.** In the **repository**: no legitimate
ones. EdgeDesk's CFB lab ledger's spread quotes on played games are either provider closes
fetched **after** kickoff (231) or pregame prices **23–74 hours** before kickoff (71) — neither
is a captured close under the rule (§6), so none is used. In the **database**: the Collective's
own feed (`odds.*`) and EdgeDesk's capture (`public.signals`/`signal_ticks`, hourly inside 30h,
every 10 minutes near kickoff) are the sources `fg2_rebuild` searches. Which games they recover
is its report's first table.

**8. Duplicate / mismatched event ids.** The committed records contain **no duplicate fixtures**
(0 in NFL, 0 in CFB by the canonical duplicate test). The mismatch is between the schedule's
identity (truncated codes) and the odds feed's (full names): measured in §5.

**9. Frontend live grading vs persisted settlement.** They differed in five ways: the side rule
(page derived, database did not); precedence (`sg||localGrade`); the record shown
(`shownRecord` preferred any server record, L3722, so the legacy ~16-game NFL records won over
the page's own); the consensus (stated picks only vs the members' grades); and the version
graded (first vs latest pre-lock).

**10. Files changed** — §8.

## 2. The data path, per sport

| Step | NFL | CFB |
|---|---|---|
| Model submission | `collective_ingest` → `collective.ingest_submission` → `collective.projections` (append-only; lock trigger) | same |
| Canonical sport | `NFL` | `CFB` (`CFB-P4`, `NCAAF` fold to it) |
| Canonical game | `collective.games` (+ `external_ref "espn:<id>"` when synced) | same; team codes cut to 10 chars |
| Teams | `collective.teams` (code = whole abbreviation, e.g. `KC`) + `team_aliases` | `collective.teams` (code = truncated name) + `team_aliases` |
| Market events | `odds.events` (league `nfl`); `public.signals` (`americanfootball_nfl`) | `odds.events` (league `ncaaf`); `public.signals` (`americanfootball_ncaaf`) |
| Link (before) | `odds.link_collective_games('nfl')`: resolve_team on code, exact date | same on truncated code → mostly unlinked |
| Link (now) | `collective.fg2_link_events` → `fg2_event_links` | same |
| Close (before) | `closing['spread:home']` via `/closing/<id>` or the week board | same, rarely reachable |
| Close (now) | `collective.fg2_compute_close` → `fg2_official_closes` | same |
| Lock | `collective.lock_at(kickoff)` = kickoff − 30 min | same |
| Final score | `tools/collective/settle_finals.js` (ESPN + nflverse) → `collective.results` | ESPN + cfbfastR |
| Grade (before) | `grade_game` → `collective.grades`; page `rowGrade` | same |
| Grade (now) | `collective.fg2_settle_game` → `fg2_settlements` (+ legacy sync) | same |
| Standings | `fg2_model_standings`, `fg2_model_rankings` → `collective_public` `/v1/wall`, `/v1/rankings` | same |
| UI | `collective/index.html` reads the settlement; grades locally only with `lib/football_grading.js` | same |
| Cron | `settle-finals.yml` hourly: settle → hand recovered closes over → `fg2_rebuild` | same |

## 3. football-v2: the rule (one implementation, three runtimes)

`lib/football_grading.js` (browser + Node) and its SQL twins `collective.fg2_*` — held equal by
`tools/collective/football_grading_sql.test.js`, which recomputes every settlement and every
close in JS, field by field.

* **Spread convention:** `home_spread < 0` home favoured; `away_spread = −home_spread`;
  `actual_margin = home − away`; `ats_margin_home = actual_margin + home_close`;
  `> 0` home covers, `< 0` away covers, `= 0` push.
* **Side:** the submitted side; else `model_edge_home = close − model_fair` (> 0 HOME, < 0 AWAY,
  0 no side). Fair −10 into −7 → HOME; fair −3 into −7 → AWAY.
* **Metrics, each with its own n and exclusion reason:** ATS needs a valid pre-lock prediction,
  a captured close, a side and a final; MAE needs a pre-lock margin and a final; Brier needs a
  pre-lock probability and a final with a winner. Reasons: `GAME_UNFINISHED`, `GAME_POSTPONED`,
  `GAME_CANCELLED`, `EXCLUDED_ORIGIN`, `LATE_SUBMISSION`, `MISSING_CLOSE`, `NO_ATS_SIDE`,
  `MISSING_FAIR_SPREAD`, `MISSING_PROBABILITY`, `TIE_NO_WINNER`. Nothing ungraded is a loss.
* **Prediction version:** the latest live, resolved row received strictly before
  `kickoff − 30 min` against the game's *current* kickoff; later edits are counted, never used.
* **The captured close — one row per game** (`fg2_official_closes`, key game + market): the
  final valid pregame snapshot — spread market, line oriented to the canonical home team,
  observed strictly before kickoff and within the window (default 360 min, per sport in
  `fg2_config`); sources in priority `collective_odds` → `collective_odds_close` (untimed) →
  `legacy_results_close` (untimed) → `edgedesk_capture`; lines sharing the final instant are
  settled by breadth (the point the most books quoted — one EdgeDesk capture pass stamps every
  point it saw with the same instant), then book priority, then snapshot id. A snapshot that is the exact negative of the published close is an
  orientation error and is refused. Never an in-game price, never a model's line, never invented.

## 4. The rebuild and the constraints

`collective.fg2_rebuild(sport, season, commit)`: duplicates → registry → import snapshots from
every source (insert-only) → link events → one close per game → latest pre-lock version →
settle → (views) MAE, Brier, consensus, calibration, diagnostics, standings, rankings → on
commit, bring `results.closing_spread` (fill-only) and `collective.grades` into line.
`fg2_rebuild_preview` runs the same and rolls it back. Re-running changes nothing and audits
nothing (proven in the SQL suite).

Keys: `fg2_event_links (source, source_event_id)`; `fg2_official_closes (game, market)`;
`fg2_settlements (model, game, grading_version)` and unique `(prediction, game, version)`;
`collective.games` unique `(sport, provider_ref)` and `(sport, season, home, away, kickoff)`,
created only where the data already satisfies them (duplicates are aliased in
`fg2_game_alias`, never deleted). Every settlement that is new or changed writes
`fg2_grade_audit` (old state — the legacy grade on first run — new state, reason, snapshot,
version). `collective.grade_game` now delegates football games to `fg2_settle_one`; the
original is kept as `grade_game_legacy_v1` for other sports.

## 5. Identity, measured on real 2026 data

The committed CFB record holds only the ten-character codes — production's weakest shape. Against
EdgeDesk's ESPN event ledger (full names, ESPN ids), the canonical resolver links **236 of 246**
played record games; **all 236 agree on the final score** (the one fact both sides hold
independently), **0 disagree, 0 conflicts**. The 10 it does not link are FCS-vs-FBS games absent
from that ledger. The same code, in SQL, links the scenario's truncated, mascot-suffixed,
neutral-site-swapped and provider-id cases (`football_grading_sql.test.js`).

## 6. Classification A–L

| Class | Meaning |
|---|---|
| A | valid captured close already on the game |
| B | snapshots linked to the game; the old close selector produced nothing (recovered) |
| C | snapshots under another event id / source, never linked (recovered) |
| D | market linked to a duplicate row of the game (recovered) |
| E | team-name mismatch: an event naming one of the teams could not be resolved |
| F | kickoff mismatch beyond tolerance |
| G | sportsbook/market key mismatch (only another market, or an unconfigured source) |
| H | spread orientation could not be determined, or conflicts with the published close |
| I | snapshots captured, all at or after kickoff |
| J | genuinely no snapshot in any source |
| K | every submission late |
| L | other: snapshots exist, none inside the final-pregame window |

From the repository alone: **NFL** — 16 A (week 1), 16 "close on the feed, none in the
database" (week 2: B in the new taxonomy), 1 more via the feed (week 3 TNF), 14 undetermined.
**CFB** — 56 A, 190 undetermined, whose evidence (above) points to C/E. The exact per-game
counts are `fg2_report(...).close_classes` after the production rebuild.

## 7. Before / after, and manual verification

What changes the moment the page is deployed, before any database work: the page now grades the
16 NFL week-2 games the database never graded (their closes are in the committed record) and
grades no-pick-side models by the one side rule — so NFL ATS samples go from ≈16 toward ≈32 per
model. CFB ATS samples stay bounded by the 56 closes until the production rebuild recovers more.

**Hand-verified covers** (the model-independent half of every ATS grade; `margin + close`):

NFL — GB@MIN 22-39, −2 → +15 home ✓ · JAX@DEN 13-20, −2.75 → +4.25 home ✓ · PIT@NE 3-20, −5.25 →
+11.75 home ✓ · DAL@NYG 20-28, +3 → +11 home ✓ · GB@NYJ 20-17, +3.5 → +0.5 home ✓ · CLE@TB 23-19,
−7.75 → −11.75 away ✓ · NO@DET 30-31, −7 → −6 away ✓ · DEN@KC 10-31, −2.5 → +18.5 home ✓ · LV@LAC
26-14, −6.75 → −18.75 away ✓ · CIN@HOU 20-6, −2.5 → −16.5 away ✓ · BAL@IND 41-23, +3.25 → −14.75
away ✓ · NYG@LAR 6-28, −6.5 → +15.5 home ✓ · MIA@SF 13-35, −13.5 → +8.5 home ✓ · NYJ@TEN 23-10,
−1.5 → −14.5 away ✓ · TB@CIN 27-33, −3.75 → +2.25 home ✓ · PHI@TEN 24-20, +7 → +3 home ✓ · DET@BUF
31-41, −5.5 → +4.5 home ✓ · ATL@PIT 13-20, −6.5 → +0.5 home ✓ · CAR@ATL 34-3, +2.75 → −28.25 away ✓ ·
NE@SEA 10-13, −3 → 0 push ✓

CFB — MARSHALL@PENNSTATE 0-45, −24.5 → +20.5 home ✓ · TEXASSTATE@TEXAS 7-59, −30.5 → +21.5 home ✓ ·
LOUISVILLE@OLEMISS 38-41, −6.5 → −3.5 away ✓ · SANJOSESTA@USC 26-42, −38.5 → −22.5 away ✓ ·
MIAMIOH@PITTSBURGH 14-59, −16.5 → +28.5 home ✓ · COASTALCAR@WESTVIRGIN 24-31, −21.5 → −14.5 away ✓ ·
WESTERNMIC@MICHIGAN 12-13, −27.5 → −26.5 away ✓ · LIBERTY@JAMESMADIS 13-20, −6.5 → +0.5 home ✓ ·
NCSTATE@VIRGINIA 8-34, −5.5 → +20.5 home ✓ · BOSTONCOLL@CINCINNATI 15-34, −7.5 → +11.5 home ✓ ·
BOISESTATE@OREGON 27-34, −24.5 → −17.5 away ✓ · FLORIDAATL@FLORIDA 21-66, −26.5 → +18.5 home ✓ ·
IOWASTATE@IOWA 13-16, −13.25 → −10.25 away ✓ · WESTERNKEN@NEVADA 14-49, +2.5 → +37.5 home ✓ ·
OKLAHOMA@MICHIGAN 10-17, −1.5 → +5.5 home ✓ · OHIO@NEBRASKA 21-49, −24 → +4 home ✓ ·
NORTHTEXAS@INDIANA 16-52, −40.5 → −4.5 away ✓ · AKRON@WAKEFOREST 16-38, −23.5 → −1.5 away ✓ ·
EASTCAROLI@ALABAMA 10-48, −28.5 → +9.5 home ✓ · ULMONROE@MISSISSIPP 13-62, −28.5 → +20.5 home ✓

All 40 agree with `lib/football_grading.js`. The model half (the side) is re-derived in JS for
every sampled row of the production report (`football_rebuild.js` fails on any that does not).

Note: many published closes are quarter points (−3.75, −13.25) — averages across books, not a
sportsbook's line. Under football-v2 a timed final-pregame snapshot from the feed outranks that
untimed value; every close this supersedes is listed in the report with old and new values, and
every grade it moves is in the audit trail.

## 8. What changed

* `lib/football_grading.js` — the one grader. `lib/football_identity.js` — canonical teams and events.
* `supabase/migrations/20260928120000_football_grading_v2.sql` — the settlement in the database.
* `supabase/functions/collective_public/index.ts` — serves settlements, official closes,
  standings, rankings and the grading trace (legacy views when not installed); shows the latest
  pre-lock row; rules text matches the rule. Rule text also aligned in `collective_ingest`,
  `collective_admin`, `collective_join`.
* `collective/index.html` — grading delegated to the one grader; settlement precedence; legacy
  verdict kept only where it is a stated side on the same close; consensus and calibration from
  the members' own grades; standings show "Missing close / No ATS side / Late / …" per model.
* `tools/collective/settle_finals.js` — the one grader; recovered closes handed to the
  settlement; `--rebuild`; rebuild after every settle; ERROR diagnostics fail the run.
* `tools/collective/football_rebuild.js` — the operator's rebuild + reconciliation report.
* Workflows: `collective-tests.yml` (four new suites), `settle-finals.yml`, new `football-regrade.yml`.
* Tests: `football_grading.test.js` (123), `football_identity.test.js` (67),
  `football_grading_sql.test.js` (151, live PostgreSQL), `football_api.test.js` (14); updated
  suites keep every unchanged expectation and change only the ones that pinned the bugs above.

## 9. Runbook (production)

1. Merge, then deploy `collective_public` (the page reads the settlement once it is served; until
   then it grades with the same library).
2. Actions → **Football regrade (football-v2)** → `apply_migration: true`, `commit: false`.
   Read the preview in the run summary: close classes A–L, recovered closes, superseded closes,
   each model before/after, diagnostics.
3. Same workflow, `commit: true`. It writes the settlement, syncs the legacy tables, and commits
   `collective/reports/football-v2-2026-<date>.{md,json}`.
4. From then on the hourly settle job keeps it current with `fg2_refresh` (the games that kicked
   off in the last four days plus any finished game never processed) and fails loudly on an ERROR
   diagnostic. A full-season rebuild is only ever run through the workflow.

### Revision 2 (the first production run timed out)

The first `commit: true` run installed revision 1 cleanly and then hit Supabase's 2-minute
statement limit inside `fg2_import_edgedesk_capture`: it joined all of `public.signal_ticks`
(every sport's tick history) to `public.signals`, copied every tick of the season, and each game's
close lookup then scanned the whole snapshot store (`canonical_game_id = any(...) OR
<joined link>.canonical_game_id = ...` defeats both indexes), as did every per-game prediction
lookup (`game_id::text` casts). Being one statement, it rolled back: nothing was written.
Revision 2, re-applied in place:

* ticks are read per signal through `signal_ticks (sig_key, created_at)`, only inside
  `[kickoff − (window + margin), kickoff + margin]` (`snapshot_import_margin_minutes`, 120) —
  nothing earlier can ever be a close; the odds-feed relations take the same bound;
* the per-game close lookup is two index lookups (stamped with the game, or linked to it);
* expression indexes on exactly the `::text` casts the source views use;
* each capture pass stamps every point it saw with one instant, so lines tied at the final
  pregame instant are settled by **breadth** (`n_books`, the point the most books quoted) before
  book priority — before this, a tie fell to snapshot-id order, and on the load test below the
  one-book −7 would have been N4's close instead of the six-book −6.5;
* `football_rebuild.js` runs each rebuild in its own transaction with `SET LOCAL
  statement_timeout = '25min'` and refuses a database whose `install_revision` is older than it
  needs; the settle job calls the bounded `fg2_refresh` instead of a whole-season rebuild.

Load test (throwaway Postgres; scenario plus 2.0M other-sport ticks, 504k NFL ticks over 280
events, 60k other-sport projections): revision 1 took 28.7 s for NFL and copied 507,390
snapshots; revision 2 takes 1.9 s and copies 30,268, with identical closes and settlements
except where the breadth rule applies. Applying revision 2 over revision 1 yields exactly what a
fresh install does.

Rollback: the migration is additive. `collective.grade_game_legacy_v1` is the original grader;
the legacy grade rows changed by the sync are each recorded in `fg2_grade_audit` with their old state.
