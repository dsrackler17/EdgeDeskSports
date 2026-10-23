# SIMULATOR_NOTES — EdgeDesk Simulator

The engineering record of the Simulator section: what was found, what was
built, what was measured, what is blocked and why. Runbook (Windows
PowerShell commands, deployment, disable and recovery):
[`docs/simulator/README.md`](docs/simulator/README.md).

Dates are UTC. "Retrieved" is the date a source was read for this work
(2026-10-23). Nothing here claims a validated edge, production readiness or a
deployment: §16 states exactly what exists and what does not.

---

## 1. Status in one table

| Area | State | Evidence |
|---|---|---|
| Shared engine (PRNG, runner, aggregation, statistics, hooks) | Implemented, tested | `simulator/src/core/`, §12 |
| NFL rules (tiebreakers, seeding, bracket) | Implemented; reproduces every division rank and seed 2002–2025 | `simulator/tests/nfl_rules_history.test.ts` (242 assertions) |
| NFL season simulation | Implemented, tested; **ACTIVE** — its three 2026 facts verified against the NFL's pages on 2026-10-23 | §7.5 |
| Strength uncertainty | Calibrated from frozen-forecast residuals | `simulator/data/nfl_strength_uncertainty.json`, §6.2 |
| Database layer | Tested on a real PostgreSQL 16; **applied to production** 2026-10-23 (*Deploy simulator SQL* run 39947585888, every report row `ok`) | `supabase/simulator.sql`, §9 |
| Kalshi futures comparison | **352 NFL markets mapped** exactly (Super Bowl, conference, division, playoffs, seeds 1–7); MLB: the World Series, pennants, divisions and playoff qualifiers by Kalshi's own wording (2 open 2026 markets mapped; 2027 not listed yet: `MLB_SIMULATOR_NOTES.md` §15.1); fee schedule verified from Kalshi's docs and API | `simulator/config/kalshi_futures.json`, §10 |
| Research registration | EXPERIMENTAL / T3; **applied** 2026-10-23 (same run) | `supabase/simulator_registry.sql`, §11 |
| Backtest 2010–2025 | Run (16 seasons × 4 as-of weeks × 2,000 runs) | `simulator/data/nfl_backtest.json`, §11.2 |
| Reader (Simulator seat in `app.html`) | Implemented, tested in Chromium at three widths | `lib/edgedesk_simulator.js`, §13 |
| GitHub Actions | Linted (actionlint 1.7.7); *Deploy simulator SQL* and *Simulator source check* have run on GitHub; the first *Simulator* publication runs from `main` | `.github/workflows/simulator*.yml`, `deploy-simulator.yml` |
| 100,000-run benchmark | Executed: 15.7 s on 4 workers | §14 |
| NHL season and Stanley Cup simulation | Implemented, tested (reproduces all 165 playoff series 2013-14..2025-26); 2026-27 facts verified from NHL.com; **ACTIVE**, published nightly | [`NHL_SIMULATOR_NOTES.md`](NHL_SIMULATOR_NOTES.md) |
| MLB season and postseason | Implemented, tested, studies committed; **ACTIVE** for the 2026 World Series: its facts read from MLB's Stats API, mlb.com and the 2026 Official Baseball Rules on GitHub's runners (2026-10-23); nightly through 2026-11-07 | [`MLB_SIMULATOR_NOTES.md`](MLB_SIMULATOR_NOTES.md) §15 |
| College football (season, title games, CFP) | Implemented, tested; **ACTIVE**: every conference procedure, the 2026 CFP format and North Dakota State's eligibility verified from the governing bodies' text on 2026-10-23; Sacramento State's eligibility measured per run | [`CFB_SIMULATOR_NOTES.md`](CFB_SIMULATOR_NOTES.md) |
| NBA season, NBA Cup, play-in and playoffs | Implemented, tested; **ACTIVE** (2026-27 facts verified; the NBA Cup played in every run and its 30 dependent games simulated until scheduled) | [`NBA_SIMULATOR_NOTES.md`](NBA_SIMULATOR_NOTES.md) |
| WNBA postseason (open series, game by game) | Implemented, tested; **ACTIVE** for the 2026 Finals: the served basketball walk-forward replayed (equal to the served ratings file), a measured shared series offset carved out of the served distribution, formats and hosts measured from the schedule; nightly through 2026-11-08 | [`WNBA_SIMULATOR_NOTES.md`](WNBA_SIMULATOR_NOTES.md) |
| Other sports | Not active: BLOCKED or COMING SOON with named blockers | §4 |

---

## 2. Starting point

- Repository: `dsrackler17/EdgeDeskSports`, branch `claude/simulator-monte-carlo-engine-nl41wq`
  created from `main` at commit `0efabe01` ("editorial: featured games, research
  snapshots and postgame audits (13 featured)").
- Pre-existing working-tree changes: **none** (`git status` was clean before
  any edit). Nothing unrelated was modified, reformatted or deleted.
- Build environment: linux/x64, Node v22.22.0, PostgreSQL 16 binaries,
  Chromium (Playwright 1.49 driver), outbound network through an egress proxy.

### Network reachability (it decides several blockers)

| Host | Reachable | Consequence |
|---|---|---|
| `raw.githubusercontent.com`, `github.com` releases (nflverse) | yes | schedule, results, standings, the tiebreaker procedure transcription |
| `registry.npmjs.org` | yes | the pinned dev-only typechecker |
| `operations.nfl.com`, `www.nfl.com` | **no** (blocked by policy) | 2026 rules facts cannot be verified from the official pages |
| `api.elections.kalshi.com`, `external-api.kalshi.com`, `kalshi.com` | **no** (from the build container) | read instead from GitHub's runners by `.github/workflows/simulator-sources.yml` (§7.5, §10) |
| `en.wikipedia.org`, ESPN | **no** | no secondary confirmation of the Super Bowl LXI venue/date |
| Supabase project | no credentials in the environment | nothing applied, nothing published |

---

## 3. Discovery evidence (what the simulator stands on)

**The served NFL game model.** `football/nfl_model.js` + `football/nfl_params_v2.js`
(`edgedesk_nfl_v2.1.0`, config sha `6c79095675f8a223`), priced through
`football/engine.js` `dist.coverProbSpread(sport, fair, line)`: a median-centred
margin PMF that includes the model's own tie mass. The board that prices the
live slate is `tools/football/build_nfl_slate.js` (`loadBoard`), with the
football module embedded in `app.html` (`tools/football/_module.js`). Its
walk-forward replay is `football/research/nfl_v2/backtest.js` (fit, `pmfFor`,
`predictRows`), with history from `football/research/nfl_v2/fetch_history.sh`.

**Team points.** `football/validation/linemaker_nfl.json`: the linemaker's
`team_total` method `KERNEL_JOINT` (CALIBRATED) — the only owned source of a
joint score distribution, used for points-based tiebreak steps (§6.3).

**Alignment and venues.** `supabase/nfl_market_structure.sql` seeds
`public.nfl_team_divisions` (32 clubs, nflverse codes, LA Rams = `LA`);
`football/venues/nfl_stadiums.json` holds roofs and surfaces.

**Supabase entitlement.** Premium access is decided by
`public.community_is_entitled(uuid)` (`supabase/community_posts.sql:126`,
hardened in `supabase/billing_hardening.sql:1224`), which applies
`public.billing_row_grants_access(...)` (`supabase/billing_hardening.sql:85`,
"THE rule. Every gate calls this."). The simulator's `sim_viewer_entitled()`
calls it and fails closed if it is missing.

**Kalshi.** The existing prediction-market layer is game-level only
(`supabase/kalshi_market_data.sql`: `kalshi_series`, `kalshi_markets`,
`kalshi_price_snapshots`, rules in `public.kalshi_rule()`, `max_spread` 0.06;
`docs/KALSHI_NOTES.md`; `tools/kalshi/`). No futures mapping existed.

**Frontend.** `app.html` is a single-page app with primary seats in
`NAV_PRIMARY` and hash routes; seat tests in `tools/app/navigation.test.js`,
`tools/app/navigation.e2e.js`, `tools/portfolio/portfolio_ui.test.js`.

**Conventions followed.** Test kit and real-PostgreSQL harness
`tools/personal/_pg.js`; SQL files idempotent, additive, pasted into the SQL
editor, no psql meta-commands, ending in a report
(`tools/collective/model_autocreate_sql.test.js` enforces this for every
`supabase/*.sql`); migrations mirrored under `supabase/migrations/`; workflows
pin `actions/*@v5`, Node 22, `permissions: contents: read`, explicit timeouts.

---

## 4. Capability matrix, every sport

Statuses come from one place, `simulator/src/sports/registry.ts`; the reader's
copy `lib/edgedesk_simulator_sports.js` is generated from it and CI fails if
it is stale.

| Sport | Status | Structure | Owned model / data (evidence) | Exact blockers |
|---|---|---|---|---|
| **NFL** | **ACTIVE** (verified 2026-10-23, §7.5) | season | served model `football/nfl_model.js`; schedule/results/standings from nflverse; rules engine reproduces 2002–2025 | 2026 tiebreaking procedures, 2026 playoff format and Super Bowl LXI venue/designated home not verified against the NFL's official pages (unreachable from the build environment) — §7.5 |
| **College football** | **ACTIVE** (verified 2026-10-23, CFB_SIMULATOR_NOTES.md §4) | season | `football/cfb_p4` engine replayed over the 2026 feed; ten conference procedures from their own text; 2026 CFP rules; an Estimated committee proxy — all in [`CFB_SIMULATOR_NOTES.md`](CFB_SIMULATOR_NOTES.md) | none standing; Sacramento State's MAC eligibility (no MAC statement) is measured each run and holds publication if any run depended on it |
| NBA | ACTIVE | season | the served `nba/` model (`edgedesk_nba_v1:E_ridge_P`, equal to the published slate); rules replay every postseason 2006-07..2025-26 and every NBA Cup knockout field 2023-24..2025-26; strength and return-hazard studies — **[`NBA_SIMULATOR_NOTES.md`](NBA_SIMULATOR_NOTES.md)** | none standing; the Cup-dependent games' pairings the league does not publish are Estimated (labelled) |
| **NHL** | **ACTIVE** | season | served `hockey/` model (regulation/OT/shootout); schedule from sportsdataverse; results from `hockey/data/team_games`; rules engine reproduces 2013-14..2025-26 playoff series; strength and goal-distribution studies (`NHL_SIMULATOR_NOTES.md`) | none (2026-27 tie-breaking, playoff format and home ice verified from NHL.com, 2026-10-23); no Kalshi NHL futures mapped yet |
| **WNBA** | **ACTIVE** (2026 postseason) | series | served `basketball/` walk-forward (points ratings + season calibration) replayed point-in-time; schedule and results from wehoop; shared series offset `simulator/data/wnba_strength_uncertainty.json` — [`WNBA_SIMULATOR_NOTES.md`](WNBA_SIMULATOR_NOTES.md) | none standing; formats and hosts are measured from the schedule each run; a round not yet paired is refused (2027 needs the bracket rule) |
| **MLB** | **ACTIVE** (verified 2026-10-23, MLB_SIMULATOR_NOTES.md §15) | season | served lab brain `mlb/history/model.js` replayed point-in-time; Retrosheet 2010–2025 (+ postseason 2012–2025); live 2026 from MLB's Stats API; rules reproduce every 2012–2025 postseason pairing and host | none standing; the tiebreak procedure is measured in every run (`run.tiebreak_measured` refuses a run in which a tie decided a reported place) — [`MLB_SIMULATOR_NOTES.md`](MLB_SIMULATOR_NOTES.md) §15 |
| College basketball | COMING SOON | tournament | `basketball/` | the 2026-27 season has not started; partial schedule with placeholder times; no conference membership, conference-tournament formats or NCAA selection/seed/bracket data |
| Tennis | COMING SOON | tournament | `tools/tennis/` | retired from coverage (2026-09-27); ratings only in the database; no owned draw structure; no validated point-level model |
| Golf | COMING SOON | tournament | — | no golf model, field data, round-score distribution or cut rules in the repository |
| UFC | COMING SOON | none | `tools/ufc/` (fight research) | no season or division championship structure to simulate; none will be invented |
| College baseball | COMING SOON | tournament | `college_baseball/` | out of season until February 2027; no 2027 schedule; release gates G11, G12, G15 fail |

"Active-ready" today: **none**. Accuracy took priority over the number of
active sports, as instructed.

---

## 5. Engine

- **Runtime.** TypeScript run directly by Node ≥ 22.18 (type stripping,
  erasable syntax only); `simulator/package.json` is `"type": "module"` with no
  runtime dependency and a dev-only, lockfile-pinned typechecker
  (`typescript 5.9.3`, `@types/node 22.20.5`). `tsconfig.json`: strict,
  `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- **PRNG.** xoshiro128** 1.1, seeded by SplitMix64 from (master seed, run
  index, stream id) — `PRNG_VERSION = xoshiro128starstar-1.1/splitmix64-seed/v1`.
  `Math.random` is never used. Streams: strength 1, games 2, postseason 3,
  coin 4, overtime 5, points 6, availability 7, drift 8. Each run's result
  depends only on (seed, run), so the worker count never changes a number
  (tested: 1 vs 3 workers byte-identical).
- **Normal quantile.** Wichura AS241 (`simulator/src/core/normal.ts`).
- **Runner.** `worker_threads`, contiguous run ranges per worker, integer
  counts merged; no HTTP and no database access inside an iteration (the
  snapshot is built and frozen before simulation).
- **Per-run invariants.** Every run is checked against the format's sum rules
  (one division winner per division, 7 playoff clubs and one club per seed per
  conference, 4 divisional-round and 2 conference-final clubs, one conference
  champion, one Super Bowl winner). A violation stops the run with the run
  index. The sum rules follow the rules version (6 seeds before 2020).
- **Canonical serialization and hashing.** Sorted-key JSON, SHA-256
  (`simulator/src/core/canonical.ts`). `input_hash = sha256(canonical(data))`;
  a snapshot whose content does not match its hash is refused.
- **Hooks** (`simulator/src/core/hooks.ts`): availability trajectories (one
  return draw per injury per run, from an owned distribution with a named
  source; refused otherwise) and within-season drift (a no-op when off;
  refused without named validation evidence). **Both are OFF for the NFL**;
  the fixed availability assumption is stated in `config.ts` and in the
  reader's limitations.

---

## 6. NFL model

### 6.1 Game outcomes
Every remaining regular-season game is drawn from the served model's margin
PMF at `fair + d_home − d_away` (§6.2). The integer PMF is reconstructed from
the engine as `P(margin ≥ k) = coverProbSpread(fair, k − 0.5).win`; at zero
offset it equals the engine's own win probability to 6.7e-16. Offsets are
cached on a 0.001-point grid (largest probability effect 5.1e-5). Regular-season
ties come from the model's own tie mass; nothing invents a tie rate. A
postseason game cannot end tied: a draw of the tie mass is resolved 50/50 on
the overtime stream — the convention of the model's two-way win probability
(P(win) + P(tie)/2) — and counted (4,295 of 100,000 runs in the benchmark).

### 6.2 Strength uncertainty (one persistent offset per club per run)
`d_t ~ Normal(0, σ²)`, drawn once per club per run and kept through the
regular season and postseason: it is the uncertainty in the frozen rating,
distinct from game randomness (which is the PMF itself).

Study: `simulator/src/research/nfl_strength_uncertainty.ts` over frozen
forecasts (served configuration replayed exactly as `backtest.js` does,
point-in-time by construction; weights for season S fitted on seasons < S),
estimation seasons 2006–2024, holdout 2025, 2,000 season-bootstrap resamples.

- **Within-club residual covariance** (pooled as-of weeks 6–8): σ_e = 3.85
  points, 95% CI [3.39, 4.28].
- **Double-counting check.** Frozen-residual MSE minus the served PMF's own
  variance (excess 13.8 at week 7) is *smaller* than 2σ_e² (29.6): the served
  PMF already carries part of the strength uncertainty, so adding σ_e on top
  would double count.
- **Production σ = win-total calibration**: the σ at which the simulated
  variance of remaining wins equals the historical mean squared deviation of
  frozen-forecast win totals (grid 0–8 by 0.1, 400 draws per cell). As-of
  week 7: **σ = 3.987787 points, 95% CI [3.215976, 4.637105]**. With σ = 0 the
  simulation under-disperses (simulated variance 2.29 vs empirical 3.72).
- **Holdout 2025** was more volatile than the calibration (empirical 5.60 vs
  simulated 4.08 at week 7): stated as a limitation, not tuned away.
- The snapshot records the σ, its interval, the method and the study file's
  sha256; `strength.calibrated` refuses a σ from another served-model config.

### 6.3 Tiebreak inputs the engine does not observe
- **Points rankings** (combined rank in points scored/allowed): scores for the
  simulated games are drawn, only when a tie reaches that step, from the
  linemaker `KERNEL_JOINT` team-points model conditioned on the simulated
  margin (H(h)·A(h − m)). Labelled **Estimated**; counted (29 of 100,000 runs).
- **Net touchdowns**: no model produces them. A run that reaches that step is
  flagged `tiebreak_unsupported_input` and resolved by the seeded coin toss;
  the `run.unsupported_tiebreaks` gate blocks publication above 1e-4 of runs
  (benchmark: 0).

### 6.4 Inputs and gates
`simulator/src/sports/nfl/inputs.ts` builds the snapshot: schedule and scores
(nflverse `games.csv`), the board's prices for every open game, the 1,216
postseason pairings in three contexts (default, home club off a bye, Super
Bowl with the designated home), reconciliation against nflverse
`standings.csv`, the strength calibration and the code identity (sha256 of the
model, parameters, board builder, linemaker file, stadium table, uncertainty
study and the football module inside `app.html`). Feeds are cached with
bounded retries (at most 4 attempts, transient network errors only) and every feed's sha256 is recorded.
`validate.ts` gates: schedule complete (272 games, 17 per club), alignment,
teams, completed scores, standings reconciliation (a mismatch blocks
simulation; an unavailable standings feed blocks publication), every remaining
game priced, postseason pairs, calibrated σ, points model, postseason not
started, replay code identity.

---

## 7. NFL rules (`simulator/src/sports/nfl/rules.ts`)

### 7.1 Source
Procedure text: NFL.com, *NFL Tiebreaking Procedures*,
<https://www.nfl.com/standings/tie-breaking-procedures>, fetched 2026-10-23 by
GitHub Actions run 39950435701 (*Simulator source check*; HTTP 200, page sha256
`268595de…`, text sha256 `876ae864…`), applied to the **2026 season** as rules
version `NFL-TB-2020` (2020–2026) and `NFL-TB-2002` (2002–2019, 6-club field,
for the history tests). The engine was first written from the same text as
transcribed in the nflverse **nflseedR** vignette
(<https://raw.githubusercontent.com/nflverse/nflseedR/master/vignettes/articles/tiebreaker.Rmd>).
`operations.nfl.com/the-rules/nfl-tiebreaking-procedures` answered 404 on
2026-10-23. **Verification status: VERIFIED (2026-10-23, §7.5).**

### 7.2 Procedure as implemented
Ties count half a win and half a loss.

| Division, two clubs | Division, three or more | Wild card, two clubs | Wild card, three or more |
|---|---|---|---|
| 1 head-to-head | 1 head-to-head (games among the clubs) | 1 head-to-head, if they played | 1 reduce to the top club of each division |
| 2 division record | 2 division record | 2 conference record | 2 head-to-head sweep |
| 3 common games | 3 common games | 3 common games, min. 4 | 3 conference record |
| 4 conference record | 4 conference record | 4 strength of victory | 4 common games, min. 4 |
| 5 strength of victory | 5 strength of victory | 5 strength of schedule | 5 strength of victory |
| 6 strength of schedule | 6 strength of schedule | 6 combined rank, conference (points) | 6 strength of schedule |
| 7 combined rank, conference (points) | 7–12 as two clubs | 7 combined rank, league | 7–11 as two clubs |
| 8 combined rank, league | | 8 net points, conference games | |
| 9 net points, common games | | 9 net points, all games | |
| 10 net points, all games | | 10 net touchdowns | |
| 11 net touchdowns | | 11 coin toss | |
| 12 coin toss | | | |

**Restart.** Only one club advances per step. When a step separates the best
clubs from the rest without naming a single winner, the rest are eliminated
and the remaining clubs restart (two clubs at step 1 of the two-club format;
three or more at step 1 for division, step 2 for wild card). When one club
wins, the others revert to step 1 for the next place. A mutation that removes
the restart fails the synthetic suite (verified). Strength of victory/schedule
are aggregated league-wide with ties as half. Every percentage is a single
division of two integers so equal rationals compare equal. The coin toss
draws from the seeded coin stream and is traced.

**Seeding and bracket (NFL-TB-2020).** 7 clubs per conference: 4 division
winners seeded 1–4 by record (ties by the wild-card procedure), 3 wild cards
5–7; seed 1 has the bye; wild card 2v7, 3v6, 4v5 at the better seed; the
divisional round is reseeded (seed 1 hosts the lowest remaining seed);
conference final at the better seed; Super Bowl at a neutral site with a
designated home club.

### 7.3 Reproduction against history
`nfl_rules_history.test.ts` replays every season 2002–2025 from nflverse
games and reproduces **every division rank and every playoff seed** in
nflverse's standings, and the 2020–2025 postseason pairings. nflverse itself
applies inconsistent SOV/SOS tie conventions across seasons (zero-as-loss
aggregate in 2002/08/12/14/18/19, half aggregate or average elsewhere, half
average in 2022); the engine keeps the rule text (ties half, aggregate) and the
test uses an independent reference with per-season convention detection.

### 7.4 Super Bowl designated home
The served model reads the designated home club's context terms even at a
neutral site (flipping the designation moves Super Bowl margins by up to 0.33
points; measured). NFL.com, *Bengals, not Rams, are official home team for
Super Bowl LVI at SoFi Stadium*: "The home team designation for the Super Bowl
alternates each year between the AFC and NFC champions." LVI was AFC (the
Bengals), so LVII NFC, LVIII AFC, LIX NFC, LX AFC, **LXI NFC** — the same
alternation nflverse shows for every Super Bowl 2002–2025 (24 of 24, re-derived
by `nfl_config.test.ts`). (An earlier draft said AFC from memory; the owned
data contradicted it and won — repair log §15.) Venue: NFL.com, *SoFi Stadium
approved to host Super Bowl LXI in 2027*: "Super Bowl LXI in February 2027 will
be played at SoFi Stadium in Inglewood" (dome, per the stadium table). Date:
not asserted (`null`) — the NFL text says February 2027, and no Super Bowl
price depends on the date (all 256 pairs unchanged with the date set, moved a
week, or absent; measured).

### 7.5 Verification (2026-10-23)
The build container cannot reach the NFL's sites, so
`.github/workflows/simulator-sources.yml` reads them from GitHub's runners and
prints each page whole with its sha256 (`simulator/src/cli/fetch_sources.ts`;
read-only, no secret). From run 39950435701:

- **Tiebreaking procedures** — the NFL.com text matches `rules.ts` step for
  step (§7.2) and in every "other procedure".
- **Playoff format** — the same page: three Wild-Card clubs per conference; the
  selection-meeting order has 18 non-playoff clubs, 6 Wild Card losers,
  4 Divisional losers and 2 Conference Championship losers (14 clubs, one bye
  per conference); home-field priority among division winners by the Wild Card
  tiebreakers. Seeding order and reseeding: the 2020–2025 postseasons in
  nflverse, reproduced by `nfl_rules_history.test.ts`.
- **Nothing changed for 2026** — the league's *Approved 2026 Playing Rules,
  Bylaws and Resolutions* (media.nfl.com, adopted March 31, 2026 in Phoenix:
  five playing rules on kickoffs, onside kicks, disqualification review and
  officiating; three roster and calendar bylaws; one free-agency resolution)
  and the 2026 proposals contain no tiebreaking, seeding or playoff change.
- **Super Bowl LXI** — §7.4.

Each fact in `simulator/src/sports/nfl/config.ts` is `VERIFIED` with its
sources, their sha256, `verified_by` (this session, at the owner's request,
naming the Actions run) and `verified_at: 2026-10-23`; the registry and the
publisher read them, so the NFL is **ACTIVE**. Postseason rest (bye and Super
Bowl clubs 14 days; others the model's 7-day default) remains an **Estimated**
input, labelled as such. Re-verify each season: re-run the source check.

---

## 8. Results and statistics

Per club and outcome: count, probability `k/N`, Monte Carlo standard error
`sqrt(p(1−p)/N)`, a 95% Wilson interval (exact 0 and 1 bounds at k = 0 and
k = N, so 0/N is reported with its upper bound instead of a false ±0), fair
decimal odds (none at p = 0), mean and distribution of regular-season wins,
math status (division/playoffs clinched or eliminated, from sound sufficient
conditions on current standings only). Provenance labels: **Observed**
(records, scores), **Research** (simulated probabilities), **Estimated**
(points-tiebreak scores, postseason rest). The ± shown is simulation noise
only, never model accuracy. Outcomes: make playoffs, win division, seeds 1–7,
reach divisional round, reach conference final, win conference, win Super Bowl.

---

## 9. Database (`supabase/simulator.sql`, mirrored in `supabase/migrations/20261023120000_simulator.sql`)

- **Tables:** `sim_runs`, `sim_input_snapshots` (immutable), `sim_team_results`
  (count/probability/MCSE/Wilson consistency checks), `sim_entity_summary`,
  `sim_trace_samples` (≤ 5 runs, ≤ 64 KB each), `sim_published` (one pointer
  per sport/competition/season; no delete), `sim_market_comparisons`,
  `sim_futures_quotes` (immutable), `sim_futures_edges` (an `actionable` row
  must be eligible, fresh, fee-verified, priced and unblocked — a CHECK),
  `sim_flag_snapshots` (immutable), `sim_closing_observations`, `sim_alerts`
  (immutable), `sim_config`.
- **Atomic publication.** `sim_begin_run` (idempotent on a key of sport,
  season, seed, run count, input hash, config, engine and model; a partial
  unique index excludes failed attempts; a running attempt older than 3 hours
  is marked abandoned) → `sim_put_snapshot/results/entities/traces` (rows of a
  running run only) → `sim_publish_run`: one transaction under an advisory lock
  on `hashtextextended('sim:'||sport||':'||competition||':'||season, 0)` that
  re-checks every row count, every probability against its count, every format
  sum (except a group the rule itself skips, as the engine's check does:
  college football's teams outside any title game) and every gate, then
  marks the run completed and moves the pointer —
  unless a newer input is already published, in which case the run is
  recorded `superseded`. `sim_fail_run` records a failure; **a failed run never
  replaces the published one**.
- **Access.** RLS on every `sim_*` table. Readers (`authenticated`) see only
  completed, published rows and only when `sim_viewer_entitled()` — the
  premium entitlement via `community_is_entitled(auth.uid())` — is true;
  `anon` sees nothing but `sim_public_status()` (statuses, blockers,
  limitations; never a number). Writes are `service_role` functions only;
  default DML grants are revoked from tables and views. Immutability triggers
  refuse UPDATE/DELETE/TRUNCATE on evidence tables.
- **Report rows** at the end of the file must all read `ok`.

---

## 10. Kalshi futures (`simulator/src/markets/`, `simulator/config/kalshi_futures.json`)

- **Exact mapping only.** NFL: 352 markets, generated by
  `simulator/src/cli/build_kalshi_mappings.ts` from the markets Kalshi's API
  returned to *Simulator source check* run 39952027751: Super Bowl (KXSB, 32),
  AFC/NFC champion (16 + 16), the eight division winners (4 each), playoff
  qualifiers (32), #1 seed (32) and seeds 2–7 (192). A market is mapped only
  when its rules match its series' template word for word, name the club its
  ticker and label name, carry nothing beyond Kalshi's standard disclaimer, and
  its series is the quadratic fee type with multiplier 1; each mapping stores
  the rules sha256, and a market whose wording later changes is excluded until
  it is mapped again. Exact division order, Super Bowl matchups, seed
  over/unders and other series with no simulated outcome are not mapped.
  25 complete, mutually exclusive sets (Super Bowl, each conference champion,
  each division, each conference's seed k) may be normalised; playoff
  qualifiers never are.
- **MLB** (`build_kalshi_mappings.ts --sport mlb`): the World Series, pennants,
  divisions and playoff qualifiers, by Kalshi's own 2026 wording with the
  season read from the rules and checked against the event ticker; the 2
  open 2026 World Series markets are mapped, 2027's are not listed yet
  (`MLB_SIMULATOR_NOTES.md` §15.1).
- **Reference vs executable, separately.** Reference = YES bid/ask midpoint,
  only when two-sided and the spread ≤ 0.06 (`kalshi_rule('max_spread')`);
  the midpoint is never executable. Executable = the YES ask at the configured
  quantity (10), only with displayed size at that quantity.
- **Normalization** only across a complete, mutually exclusive outcome set
  with every quote inside a 10-minute skew; otherwise none.
- **Fees** (verified 2026-10-23). Kalshi's quadratic taker fee
  0.07 × M × C × P × (1 − P): the docs' worked example (a $0.00363825 model fee
  on a $0.055 buy = 0.07 × 0.055 × 0.945) and the OpenAPI fee types; every
  mapped series is quadratic (or quadratic with maker fees, which changes only
  the maker side) with M = 1; no mapped event overrides it and no change is
  scheduled. The comparison rounds the order's fee up to the cent: exact on a
  $0.01 (FCM-cleared) balance grid, an upper bound by under $0.01 per order on a
  direct member's $0.0001 grid. The fee schedule PDF itself answered the runner
  with a 429 challenge page.
- **Flags** need a fresh (≤ 30 min) quote, a verified mapping, size, verified
  fees, an executable edge ≥ 3 points and ≥ 4 Monte Carlo SEs. A stale or
  ambiguous input blocks the flag with a reason. Flag snapshots are immutable.
  No rolled-up "Edge Score" exists.
- **Futures CLV.** `sim_grade_closes(window default 1,560 min)`: the last
  EdgeDesk-captured quote before the market's close time, inside the window;
  a close with no captured quote is recorded `missing`, never imputed.
- **Separate failure domain.** The market step runs after publication; its
  failure is recorded DEGRADED and never invalidates the simulation.

---

## 11. Research registry and validation

### 11.1 Registration (before validation)
`simulator/research/registration.json` → `supabase/simulator_registry.sql`
(generated; CI checks it is current): **SIM-NFL-SEASON v0.1.0, tier T3,
EXPERIMENTAL**, explicit version, limitations, primary metric, holdout seasons
2025–2027 with a minimum of 3 seasons, and promotion criteria written before
any holdout evaluation: C1 Brier vs the no-uncertainty baseline, C2
calibration, C3 against the market reference, C4 executable CLV. Nothing
promotes it automatically; no `research_model_results` row is written.

### 11.2 Backtest (`simulator/data/nfl_backtest.json`)
As-of replay of 2010–2025 at weeks 4, 8, 12, 16 (64 cells), 2,000 runs per
cell, production σ vs σ = 0, Brier and log loss (probabilities clipped at
`max(1e-6, 0.5/N)` = 0.00025, documented), calibration bins, season-cluster
bootstrap intervals (the four snapshots of a season share outcomes). 364 s.

| Family | Brier, production | Brier, σ = 0 | Δ 95% CI (season bootstrap) | Log loss prod / σ0 | 2025 holdout Brier prod / σ0 |
|---|---|---|---|---|---|
| Win division | 0.0994 | 0.1012 | [−0.0048, +0.0005] | 0.3074 / 0.3154 | 0.1897 / 0.2097 |
| Make playoffs | 0.1188 | 0.1208 | [−0.0046, +0.0002] | 0.3604 / 0.3687 | 0.1654 / 0.1787 |
| Win conference | 0.0479 | 0.0477 | [−0.0014, +0.0019] | 0.1654 / 0.1651 | 0.0598 / 0.0637 |
| Win Super Bowl | 0.0283 | 0.0288 | [−0.0012, +0.0002] | 0.1102 / 0.1116 | 0.0298 / 0.0311 |

Reading: the persistent strength offset scores slightly better than none on
three of four families, but **every interval includes zero**, 2010–2024 is
in-sample for σ, and 2025 is the only out-of-sample season (one season is not
evidence; C1 needs three holdout seasons). **No market baseline exists**:
EdgeDesk owns no historical Kalshi futures quotes, so nothing here says
anything about beating a market. Without a point-in-time points model, 65
backtest runs (of 128,000 production-σ runs) coin-tossed a points tie.

---

## 12. Tests and actual results (2026-10-23, this environment)

| Suite | Assertions | Result |
|---|---|---|
| `simulator/tests/core.test.ts` (PRNG, statistics, canonical, engine) | 37 | pass |
| `simulator/tests/hooks.test.ts` (availability, drift) | 23 | pass |
| `simulator/tests/nfl_rules_history.test.ts` (2002–2025) | 242 | pass |
| `simulator/tests/nfl_rules_synthetic.test.ts` (SYNTHETIC fixtures) | 62 | pass |
| `simulator/tests/nfl_sim.test.ts` | 32 | pass |
| `simulator/tests/nfl_config.test.ts` | 13 | pass |
| `simulator/tests/markets.test.ts` (SYNTHETIC markets) | 48 | pass |
| `simulator/tests/ui.test.ts` | 34 | pass |
| `simulator/tests/cli.test.ts` (args, plan, replay, worker independence) | 33 | pass |
| `simulator/tests/publish.test.ts` (PostgREST retries, key redaction, publish order, failure handling) | 18 | pass |
| `simulator/tests/sql.test.ts` (real PostgreSQL 16, incl. fail-closed entitlement) | 82 | pass |
| `simulator/tests/ui.e2e.ts` (Chromium, 3 widths) | 31 | pass |
| MLB suites (`mlb_rules_history`, `mlb_rules_synthetic`, `mlb_rotation`, `mlb_model`, `mlb_sim`, `mlb_statsapi`, `mlb_config`): see [`MLB_SIMULATOR_NOTES.md`](MLB_SIMULATOR_NOTES.md) §12 | 279 | pass |
| typecheck (`tsc --noEmit`, strict) | — | clean |
| generated files (`sim:check`), migration byte-identical | — | current |
| existing: `tools/app/navigation.test.js` | 256 | pass |
| existing: `tools/app/navigation.e2e.js` | 172 | pass |
| existing: `tools/portfolio/portfolio_ui.test.js` | 101 | pass |
| existing: `tools/collective/model_autocreate_sql.test.js` | 227 | pass |
| existing, also re-run: `tools/odds/no_bypass` 100, `tools/app/sports_config` 67, `tools/personal/personal_wiring` 74, `tools/app/app_update` 18, `first_run` 129, `portfolio_process` 52, `research_landing` 112, `operator_gate` 78, `db_session` 51, `game_research` 194, `worth_researching_ui` 278, `tools/intelligence/lint.js` | 1,153 | pass |

Synthetic fixtures are labelled SYNTHETIC in their suite names and never feed
production data. Failure injection covered: a failed publish leaves the
pointer, a superseded input, a tampered snapshot, code drift on replay, a
missing entitlement function (fail closed), stale/one-sided/wide/unsized
quotes, incomplete outcome sets, unverified fees, transient vs permanent
PostgREST errors, a Kalshi host fallback, a reader with failing requests and
hostile strings (escaped).

---

## 13. Reader

`app.html` gains a primary **Simulator** seat (bottom nav before More, hash
route `#simulator/<sport>`), `lib/edgedesk_simulator.js` + `.css`: sport picker
(Coming Soon / Blocked sports shown with their blockers), tabs Division /
Conference / Title / Futures Edges, cards, sortable tables (missing values
last), Observed/Research/Estimated badges, an EXPERIMENTAL badge, limitations,
loading/empty/blocked/not-entitled/error/stale states, responsive at phone
width, DOM built from escaped strings only. It reads `sim_public_status`,
`sim_viewer_entitled` and the `sim_current_*` views with the signed-in
session; no key is in the page.

---

## 14. Benchmark (actual, 2026-10-23, the committed code)

`node simulator/src/cli/run.ts --sport nfl --season 2026 --runs 100000 --workers 4 --dry-run`

| Measure | Value |
|---|---|
| Inputs | as-of week 7, 178 remaining games, input hash `e906d39ad048…` (the committed fixture), σ 3.988 |
| Simulation | **100,000 runs in 15.7 s** on 4 workers |
| Single thread | ≈ 1.6 ms per run |
| Peak RSS | 1,176 MB |
| Platform | linux/x64, Node v22.22.0 |
| Gates | all PASS except `sport.active` (BLOCKED, §7.5) |
| Points-ranking tiebreaks (Estimated) | 29 runs |
| Net-touchdown (unsupported) tiebreaks | 0 runs |
| Postseason tie-mass resolutions | 4,295 |

Top Super Bowl probabilities in that dry run (Research, not published): SF
12.0%, BUF 11.2%, JAX 9.5%, SEA 8.6%. These are benchmark output, not a
forecast EdgeDesk publishes.

**Seed check.** An earlier 100,000-run benchmark on the same games (only the
config's verification metadata differed, so the derived seed differed) agreed
within Monte Carlo error: the largest |difference| / combined SE over all 416
club × outcome cells was 2.92, about what 416 independent comparisons give
(SF title: 11.70% vs 12.02%, MCSE 0.10 each).

---

## 15. Repair log

| Problem found | Fix |
|---|---|
| Wilson bounds at p = 0/1 off by floating error | exact 0/1 bounds at k = 0 / k = N |
| SOV/SOS disagreed with nflverse in tie seasons | nflverse conventions differ by season; engine keeps the rule text, test detects the convention |
| Synthetic tiebreak fixtures with untied records (vacuous) | re-derived by hand; vacuous blocks removed |
| Offset grid 0.01 moved probabilities by 4.9e-4 | 0.001 grid (5.1e-5) |
| Covariance σ would double count uncertainty already in the PMF | production σ from win-total calibration; the consistency check is recorded |
| Calibration too slow (bisection inside the bootstrap) | σ grid 0–8 by 0.1 with per-season sums |
| Clinch/elimination conditions unsound | rewritten as sufficient conditions only |
| `--allow-unreconciled` produced a PASS | now WARN and blocks publication; publishable = no gate blocks |
| SQL: duplicate view columns; views kept default DML grants; `found` overwritten; `digest()` not on the search path; vacuous `|| true` assertions | columns fixed, grants revoked (report row), `had_cur`, built-in `sha256()`, strict assertions |
| Close grading test used a future close | past close time |
| Super Bowl LXI designated home set to AFC from memory | owned data (24/24 alternation) says NFC; fixed, fixture rebuilt, test added |
| Backtest crashed on 2010: sum rules hard-coded 7 seeds | outcomes and sum rules derived from the rules version (6 seeds before 2020) |
| Committed fixture's code identity stale after the study file was regenerated | fixture rebuilt from a fresh snapshot |
| Activation text promised `verified_by`/`verified_at` that the config lacked | fields added; VERIFIED counts only with both (tested) |
| Browser/SQL suites could skip silently in CI | `SIM_E2E_REQUIRED` / `SIM_SQL_REQUIRED` turn a skip into a failure |
| `db.ts` redacted the service-role key with `String.replace`: only the FIRST occurrence in an error body | `split(key).join('[redacted]')`; a test echoes the key twice (and fails on the old code) |
| Notes claimed PostgREST-retry and fail-closed tests that did not exist | `publish.test.ts` and SQL block 16 written; both pass |

---

## 16. Limitations and deployment status

**Limitations** (also shown in the reader): one persistent normal offset per
club; the 2025 holdout was more volatile than the calibration; game outcomes
are the served model's (which does not beat the closing line in its
walk-forward record); no injury return sampling and no new injuries; ratings
frozen at the as-of date and no drift; Estimated points for points-ranking
ties and coin tosses for net-touchdown ties (counted); Estimated postseason
rest; Monte Carlo ± is simulation noise only.

**Deployment status, exactly (2026-10-23):**
- Code, SQL, workflows, docs and tests: merged to `main` (#695, #696); the
  verification, the Kalshi mappings and the source check land with #697.
- Database: `supabase/simulator.sql` and `supabase/simulator_registry.sql`
  **applied to production** by *Deploy simulator SQL* run 39947585888; every
  report row `ok` (the entitlement gate finds `community_is_entitled`).
- NFL: **ACTIVE** (§7.5). The first 100,000-run publication is made from `main`
  by the *Simulator* workflow; the nightly job (10:17 UTC) publishes after it.
- Kalshi: 352 NFL markets and the 2 open 2026 MLB World Series markets mapped,
  fees verified; compared after each publication by the *markets* job. A
  mapping for a later season than the run's is not that run's (next season's
  futures listed while this one finishes); an earlier season's is an error. A flag still needs every condition in this section.
- Nothing here is a "validated edge": the model is EXPERIMENTAL (§11).

**Each season:** re-run *Simulator source check*, compare the NFL's pages with
§7, regenerate the Kalshi mappings (`build_kalshi_mappings.ts`), then verify
in a reviewed commit (docs/simulator/README.md, "Deployment sequence").

**The NHL** (season and Stanley Cup simulator, ACTIVE, a second leg of the
nightly workflow) has its own record: [`NHL_SIMULATOR_NOTES.md`](NHL_SIMULATOR_NOTES.md) — the
regulation/OT/shootout model check, the goal-distribution validation, the
strength study, the rules and their history evidence, goalie and overtime
limitations, and its verification.

---

## 17. File manifest

The MLB module's files are listed in [`MLB_SIMULATOR_NOTES.md`](MLB_SIMULATOR_NOTES.md) §3.

```
SIMULATOR_NOTES.md                         this file
docs/simulator/README.md                   runbook (Windows PowerShell)
simulator/package.json, package-lock.json, tsconfig.json
simulator/src/core/                        prng, normal, stats, canonical, csv, engine, hooks, runner, worker, results
simulator/src/sports/registry.ts           every sport's status, blockers, limitations
simulator/src/sports/factory.ts
simulator/src/sports/nfl/                  config, rules, model_adapter, points_model, inputs, validate, module
simulator/src/markets/                     compare.ts, kalshi.ts
simulator/src/publish/                     db.ts, publish.ts
simulator/src/cli/                         run, markets, kalshi_discover, fetch_sources, build_kalshi_mappings, plan, alert, build_ui_registry, build_fixture
simulator/src/research/                    nfl_replay, nfl_strength_uncertainty, nfl_backtest, build_nfl_history_fixture, build_registry_sql
simulator/research/registration.json
simulator/config/kalshi_futures.json
simulator/data/                            nfl_strength_uncertainty.json, nfl_backtest.json
simulator/fixtures/                        nfl_history.json.gz, nfl_2026_wk7_snapshot.json.gz
simulator/tests/                           12 suites + _kit.ts, _fixture.ts
supabase/simulator.sql, supabase/migrations/20261023120000_simulator.sql, supabase/simulator_registry.sql
lib/edgedesk_simulator.js, lib/edgedesk_simulator.css, lib/edgedesk_simulator_sports.js (generated)
.github/workflows/simulator.yml, simulator-tests.yml, deploy-simulator.yml, simulator-sources.yml
modified: app.html, lib/edgedesk_workspace_ui.js, package.json (sim:* scripts), .env.example, .gitignore, README.md, supabase/README.md,
          tools/app/navigation.test.js, tools/app/navigation.e2e.js, tools/portfolio/portfolio_ui.test.js
```
