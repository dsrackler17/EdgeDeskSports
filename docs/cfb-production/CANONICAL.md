# The canonical CFB prediction pathway

One service makes every V2 number anyone may show. Everything else stores it,
reads it, or explains it. This document covers that service, what it refuses,
how its output is stored and read, and how it is tested: the input contract,
the feature monitor, numeric safety, stored reads, the golden games, the
replays, the trace and the final hardening test.

Governance, unchanged by this work: **no Model Championship has been run.** The
champion is V1 `edgedesk_cfb_p4_v1.0.0`. V2.1 `edgedesk_cfb_v2.1.0` is the hardened
production pathway, running in shadow and `ELIGIBLE_FOR_PROMOTION` on its
backtests. A person promotes it with `governance.js promote` once the promotion
guard passes (§13). Every manifest records `champion_selection: NOT_RUN`.
Betting is disabled (`bet_enabled: false`).

## 1. One pathway

`football/cfb_production/canonical.js` is the service:

| function | what it does |
|---|---|
| `pure(row)` | the ONLY call of `engine.pure()` on the production pathway. The row passes the input contract (§3) first; the engine's output then passes the numeric checks (§5). If either fails, the result is `UNAVAILABLE` with the reason, never a repaired or default number |
| `snapshot(row, { as_of_ts })` | `generateCfbPredictionSnapshot`: the canonical record. It carries versions, the engine's numbers, the input and projection hashes, the contract and numeric verdicts, the degraded modes, the fallback level and the public display policy. `as_of_ts` is required: there is no clock inside |
| `modes(row, ctx)` | the degraded modes (§11) |
| `resolve(snap, v1)` | the manifest's fallback order (§11) |
| `display(snap)` | what a public page may say (§11) |

**Consumers** (audited; each goes through `canonical.pure` or reads what it stored):

| consumer | how |
|---|---|
| the Model Lab adapters (`football/cfb_lab/models.js`) | `CANON.pure` for V2.1 and V2.0 rows (each through its own engine); the lab snapshot records `inputs_ref.canonical` |
| the decision shadow (`football/cfb_decision/shadow.js`) | `CANON.pure`, then the pinned policy (§12) |
| the V2 Postgres mirror, shadow decisions, the V1 board's v2_shadow block | `CANON.pure` |
| the stored projections (`projections.js`) | `CANON.snapshot` → `reports/projections.json` (§2) |
| the app's V2 panel (`app.html` `fbV2ShadowHTML`) | reads `projections.json`; loads no engine |
| the internal debug view (`admin/cfb-debug`) | reads `projections.json` and `traces.json` (§10) |
| the research terminal (`football/cfb_terminal/build.js`, `lib/cfb_terminal.js`, `research/cfb/`) | its hourly build takes V2.1's number from `CANON.pure`; its page reads the stored research objects |
| the AI explanation (`supabase/functions/edgedesk_ai/_cfb_explain.js`) | `cfbFacts()` takes a stored projection entry or lab row (SECURITY.md §5) |

**The contract test** (`canonical.test.js` §1) scans the repository. It fails when:
- any file outside `canonical.js` calls the V2 engine's `pure()`, through any receiver
  (`E2.pure`, `eng.engine.pure`, `window.EDCfbV2.pure`);
- `engine.decide()` runs outside the three stored-research producers;
- a page, admin view, edge function, newsletter or article loads the V2 engine;
- a node consumer bypasses `canonical.pure`;
- the app shows the stage-8 status as the official one (F-22, §12).

The scan cannot pass by seeing nothing: it asserts that it found every known consumer.

## 2. Stored projections and immutable snapshots

**The stored projections.** Each hour the Model Lab job (`cfb-lab.yml`, step
"Canonical projections") writes `football/cfb_production/reports/projections.json`
(`projections.js --write`). Per game in the next 10 days it holds:
- `canonical`: the snapshot;
- `v1`: the fallback board's number;
- `resolved`: the fallback level;
- `market`: the newest lab snapshot's market;
- `official_decision`: governed policy only;
- `research`: stage-8, labelled;
- `display` and `trace`.

Beside it, `traces.json` holds the stage-by-stage trace (§10). A failed build
warns, and the previous file stays with its own `as_of_ts`.

**Immutable snapshots.** A snapshot is written once and never edited:

| brief | where |
|---|---|
| EARLY | the weekly engine's write-once freeze (Tuesday 12:00 UTC, `FREEZE_EARLY`; a rerun that differs is refused, `refused_overwrites`) and the Model Lab's `OPEN` / `WEEKLY_FREEZE` rows |
| MIDWEEK | the Model Lab's `T72`, `T48` windows |
| FINAL | `T24` (the official window), then `T12`, `T6`, `T2` up to kickoff |
| event-triggered | `ADHOC`, written within 72 h of kickoff when the canonical input hash changes (`inputs_ref.event = INPUT_CHANGED`, naming the row it supersedes) |

Each lab row carries:
- the model, feature, calibration and ensemble versions;
- `prediction_ts`, `feature_ts`, the market state and its integrity verdict;
- data quality and the canonical verdict (contract, modes, fallback level, input hash).

A correction is a new row, never an edit. The ledger is append-only, hashed and
verified (`ledger.verify`), and its Postgres mirror is insert-only.

Tested in `canonical.test.js` ("lab:"):
- an unchanged input writes nothing;
- a changed input inside 72 h is one ADHOC version;
- the earlier row is kept byte for byte;
- a repeat adds nothing;
- a row the service refuses is never snapshotted.

## 3. The model input contract (brief §33-34)

`football/cfb_production/contract/input_contract.json` (`cfb_input_contract_1`) declares:
- every one of the 60 inputs the frozen V2.1 artifact reads, with its type, null
  policy (56 REFUSE; 4 drive fields ALLOWED_BEFORE_FIRST_GAME, as in training),
  missing indicator and the model's behaviour on a null;
- the 23 row fields the engine reads (14 critical).

Ranges come from the training reference `feature_reference_edgedesk_cfb_v2.1.0.json`,
built once from the artifact's training rows: FBS vs FBS FINAL games 2012-2025,
10,555 rows. It reproduces C_ridge's stored training means to 1e-16.

| range | rule | outside it |
|---|---|---|
| HARD | training [min, max] widened by half the span on each side, intersected with natural bounds | CRITICAL |
| SOFT | training [p01, p99] | a legitimate extreme: counted by the monitor, never refused |

**Enforced before inference.**
- The weekly engine's features stage (`v2/weekly/contract.py enforce`) runs it on
  every upcoming game.
- A game with a CRITICAL violation is not inferred, not published and not decided:
  the release gate check "model inputs pass the input contract" withholds it
  (`WITHHOLD_GAME`), and more than 5% of a week withheld holds the week.
- Nothing is imputed, clipped or changed.

The node side (`canonical.checkRow`) applies the row contract to every row a consumer
runs. That includes the cross-field rules:
- home ≠ away;
- no input stamped after kickoff;
- the stacked margin equals the weighted submodels;
- the row's model version is the engine's.

Tests:
- `v2/weekly/tests_contract.py`: 51 checks fast, 54 on the real v2.1 build;
- `canonical.test.js` "contract:".

## 4. The feature-distribution monitor (brief §35)

`contract.monitor(X)` compares a slate (FBS vs FBS, at least 20 games) with the
training slates of the same week of the season (w0-w16, post). Each statistic must
stay inside the envelope the training slates spanned, widened by the envelope's
width on each side and by at least half a training SD:
- mean and SD;
- share outside the soft range (flagged only above 0.10);
- missing share (flagged only 0.20 above the training maximum).

It flags. It never refits, clips or blocks. The weekly engine writes the result
to `football/cfb_weekly/<season>/feature_monitor.json` and warns in the run log.

**Validation.**

| test set | weeks flagged | note |
|---|---|---|
| leave-one-season-out, 2020 aside | 33 of 180 training weeks | 2020 (the COVID season) is flagged as a whole, a true positive |
| the 2024-25 holdout | 4 of 28 | |
| 2026 live weeks | 9 of 13 | mostly `exp_plays_total`, whose level moved with the 2023 clock rule. That is a real drift the model was trained across, reported, not acted on |

## 5. Numeric safety, precision and time (brief §64-71)

`football/cfb_production/numeric.js` (`cfb_numeric_safety_v1`):

**Bounds.**

| quantity | bound |
|---|---|
| margin | ±80 |
| total | 10-160 |
| team points | 0-150 |
| sigma | 3-40 |
| win probability | strictly (0, 1), except exactly 0/1 at a margin of 40+ points, with a rounding note |

**Consistency.** The fair line equals the negated margin. The win probabilities sum
to 1 and sit on the margin's side. The intervals are ordered and nested. The score
difference equals the margin, and the cover probability matches the engine.
`policyConsistency` flags a BET while betting is disabled, a BET without side,
line or price, and a stake on a non-BET.

**Precision.**
- The pinned `engine.decide()` reads the pure projection's rounded margin (0.01) and
  sigma (0.001). This moves a cover probability by at most 1.8e-4 (bounded in the
  test at 2.5e-4).
- The Python `p_home` and the engine's agree to 1e-4.
- Display rounding is the only rounding the pathway adds. This is recorded, not
  fixed: `engine.js` is pinned.

**Time.**
- Every timestamp is normalised to UTC. A naive (zone-less) time is refused.
- Hours to kickoff are exact across the 2026-11-01 DST change.
- `canonical.js` and `numeric.js` never read the clock: `as_of_ts` is required and
  recorded.
- No production file uses a local-time getter.

**Reproducibility and determinism.** See §8.

## 6. Stored reads (brief §49-53)

| rule | how |
|---|---|
| precompute | no page computes a V2 number. `projections.json` is built hourly by the job; `current.json` by the weekly engine; `ops.json` by `health.js`. No user request triggers a computation (`canonical.test.js` scans the pages) |
| timeout | the app's V2 loader (`fbV2Ensure`) races the read against 10 s: a slow file is an error on the card, never a hung panel. The Postgres writers have a 60 s request timeout and classified, bounded retries (`db.js`) |
| cache | the loaded file is reused for an hour (the job refreshes it hourly); a failed read is retried after 5 minutes, not on every render. The files are static; the loader asks `cache: 'no-store'` so an hourly refresh is seen |
| invalidation | each file carries `as_of_ts`. A game that has kicked off is not in the next build (horizon: kickoff after `as_of`, within 10 days). A projection stored more than 3 h ago is labelled STALE on the card. A new weekly row changes the input hash and so the snapshot id |

Tested in `tools/football/cfb_v2_panel.test.js`: timeout, retry throttle, hourly
reuse, STALE label and display wording.

## 7. Golden games, property tests, chaos (brief §101-103)

**Golden games** (`golden.js`, `golden/games.json`, `golden/expected.json`; in CI):
15 cases on real rows, each with its stored invariant outputs:
- road favourite, and its final graded on the full score including overtime;
- neutral site (a V2.0 replay row through its own engine);
- QB change (starter OUT) against the baseline;
- FCS: projected, never priced;
- huge favourite, an FCS opponent;
- a synthetic 60-point favourite (not refused);
- an impossible 95-point margin (refused, falls to V1);
- stale market (fails closed in both engines);
- postponed and canceled (VOID, never a loss);
- four starters OUT against none reported (sigma widens, margin unchanged);
- degraded evidence.

`node football/cfb_production/golden.js --write` rewrites the expectations only on
a person's deliberate change.

**Properties** (`canonical.test.js`, over every live row and a grid of lines and
prices): 0 violations of each:
- a better offered spread never lowers the cover probability (stage-8 and the policy's);
- a worse price never improves EV;
- a price-only change never moves the pure fair spread;
- the market context changes the modes, never the projection;
- the pure projection is frozen.

**Pipeline chaos:**
- in `canonical.test.js`:
  - garbage rows;
  - two different rows for one game (neither used);
  - identical duplicates;
  - home = away;
  - no input files;
  - a game already kicked off;
  - a stage-8 BET in the decision ledger;
  - a decision observed after `as_of`;
- in `final_hardening.test.js` (§9);
- H1's `football/cfb_lab/chaos.test.js` (providers, market, settlement).

## 8. Replay and reproducibility (brief §104-105, §66-67)

**Reproducibility** (`reproduce.js`, in `canonical.test.js`):
- **Snapshots:** every preserved LIVE lab snapshot names the input file it read by
  hash. The file is found in the tree or in git history and the row is re-run.
  174 of 174 snapshots reproduce (V1 60, V2.1 57, V2.0 57).
- **Settlement:** every committed evaluation re-grades identically from the
  committed ledger: 510 of 510.

**A played week, schedule to settlement** (`replay_week.js`, `replay.test.js` in CI).
The hourly job's pathway runs hour by hour through a played week into a throwaway
ledger:
- identity and duplicate checks;
- canonical projections through the rows' own engine;
- the captured quotes, integrity-screened;
- `checkpoint.run` every hour;
- settlement from the committed results.

Week 3 of 2026:
- 75 games, 57 PREDICTED and 18 NOT_PRICED;
- 455 snapshots with 0 duplicate windows and none after kickoff, 455 evaluations;
- a second settlement adds nothing;
- the ledger verifies, and two runs give byte-identical ledgers.

**Season to date:** weeks 1-4 give 331 games and 1,720 snapshots and evaluations,
deterministic (`--weeks 1-4`, about 85 s for two runs).

**Not possible here: a full-season replay of earlier seasons through this
pathway.** Preserved pregame rows exist only for 2026 (`replay_to_date.json`,
V2.0 rows). The 2012-2025 walk-forward backtests are the research pathway's, not
this one.

## 9. The final hardening test (brief §122)

`final_hardening.test.js` (23 checks, CI) takes a normal slate (every V2.1 row of
`current.json`, three books quoting each priced game). Every game must pass each
stage:
1. source validation (identity master, quote validity);
2. feature validation (the contract);
3. inference (PREDICTED, or NOT_PRICED for FBS vs FCS; numeric checks clean);
4. market ingestion (consensus ACTIONABLE);
5. decision policy (pinned policy and calibration: never a BET, policy-consistent);
6. snapshot write (one row per game, the ledger verifies, a second run writes
   nothing, the stored projections resolve every game).

Then each of these failures is injected and must fail safely:
- stale odds;
- a missing QB field;
- a NaN input;
- a wrong team mapping;
- an impossible quote;
- an incompatible artifact;
- a duplicate run;
- a provider timeout;
- a database deadlock (40P01: retried with jitter);
- duplicate game rows;
- a BET while betting is disabled;
- a missing decision calibration.

## 10. The prediction trace and the game-level debug view (brief §110-111)

`trace.js` builds, for every game in `projections.json`, the path from raw inputs
to decision. It stores the stages in `reports/traces.json`, beside the projections,
so the public page never downloads them:

| stage | contents |
|---|---|
| raw_inputs | the stored row: source, state, timestamps, ids, flags, quarterbacks |
| features | feature version, the contract's verdict, the stored feature drivers, the week's monitor |
| submodels | each submodel's margin, artifact weight and share |
| ensemble | the stacked margin, the weighted sum it must equal and their difference, fair line and total |
| calibration | sigma, t df, raw and calibrated probability, the weekly engine's probability and the difference, intervals, confidence, numeric verdict |
| market | the newest lab snapshot's market, its integrity verdict and the model-market gap |
| decision | the official decision and, apart, the research class |
| outcome | modes with reasons, fallback level, resolved, display, hashes |

The trace copies what the pathway made. The one number it forms is each
submodel's share (weight × margin), which the contract already checks sums to the
stacked margin.

**The debug view** is `admin/cfb-debug/index.html`:
- internal: `noindex, nofollow`, and `/admin/` is disallowed in robots.txt;
- `?game=<id>` shows one game, and the list links every game;
- it reads the two stored files, computes nothing and writes nothing;
- it escapes every string.

`debug_ui.test.js` (32 checks, CI) runs the page's own render block against:
- the real build;
- nothing at all;
- hostile files (markup in every field);
- files from different runs.

## 11. Degraded modes and the fallback order (brief §45-48)

**Modes** (`canonical.modes`). They are stored on every projection and every lab
snapshot:

| mode | when |
|---|---|
| FULL | none of the below |
| NO_PLAYER_DATA | the weekly engine's DEGRADED_AVAILABILITY, availability certainty < 60, or the availability source STALE / MISSING / DEGRADED / DOWN |
| NO_ADVANCED_PBP | the weekly engine's DEGRADED_PBP, or PBP completeness < 0.9 |
| QB_UNCERTAIN | a starting QB missing or unsettled in the row, or QB certainty < 70 |
| MARKET_DEGRADED | no captured market, or an integrity verdict other than OK. It never lowers the football level: the pure number does not read the market. It gates actionability |
| FALLBACK_MODEL | served by V1 |

**Fallback order** (manifest `fallback_hierarchy`, `canonical.resolve`):

| level | served | note |
|---|---|---|
| 1 FULL | V2.1 | |
| 2 DEGRADED | V2.1 | a football mode present |
| 3 FALLBACK_MODEL | V1's own stored number | only when V2.1 is unavailable |
| 4 UNAVAILABLE | nothing | never a substitute |

A fallback never borrows the other model's number. A V1 board that cannot be read
is reported (`sources.v1_error`), not silently dropped.

**Display.** Internal views show the modes by name and the level: the debug view, and the
ops dashboard's "Degraded games". A public page:
- shows a degraded mode in words (`PUBLIC_LABEL`);
- never shows a degraded projection's confidence score;
- shows win probability in whole percent at most, and a degraded favourite of 85%+
  as "strong favourite (reason)", never a precise number.

The app's V2 panel uses exactly this stored wording.

**2026-09-28 build** (60 games):
- level 1: 2; level 2: 55; NOT_PRICED: 3;
- modes: NO_PLAYER_DATA 53, QB_UNCERTAIN 19, MARKET_DEGRADED 57, NO_ADVANCED_PBP 3.

## 12. One official status (audit F-22, F-23)

**F-22.** Two engines used to produce a decision status: the stage-8
`engine.decide()` in `football/cfb_v2/engine.js`, and the governed policy
`cfb_decision_policy_v1` in `football/cfb_decision/decision.js`. The official status
now has exactly one definition: the governed policy's. `projections.officialDecision`
is the newest CHALLENGER (`cfb_decision_engine_v1`, `cfb_decision_policy_v1`)
decision per book at `as_of`, summarised in `decideGame`'s order
BET > RESEARCH > LEAN > PASS > NO_BET. With none, it is `NO_DECISION`.

The stage-8 output is stored only as a labelled `research` field. Neither
`engine.js` nor any ledger row was changed: the relabelling happens at the read
and display layer. It covers:
- the app panel ("Official decision" and "Research only");
- the Model Lab page ("Research class", "Research position");
- the ops dashboard (roles: CHALLENGER OFFICIAL, CURRENT RESEARCH);
- the debug view;
- the AI explanation boundary: a non-governed status is stated as NO BET. The research terminal's page
  words (RESEARCH, WAIT, INVESTIGATE, PASS, DATA FAULT, NO MARKET) cross as a labelled research status,
  and its BET crosses only as a governed decision.

`canonical.test.js` and `frontend_contract.test.js` fail if a consumer shows the
stage-8 status as official.

**F-23.** The P(positive CLV) tiers (0.52 / 0.58 in `policy.json`, unchanged) rank
closing-line movement, not bet quality: close-implied EV ≤ 0 in every tier. The
tier is shown as a "closing-line tendency" everywhere. The stage-8
`betting_edge_strength` is shown only as "Stage-8 EV strength · research only".
The explanation audit refuses "edge quality" wording.

The pinned decision artifacts (`compat.decisionArtifacts`): the decision shadow
loads the policy and calibration the active compatibility entry names, verified by
content hash, and fails closed if either is missing (VERSIONING.md §3).

## 13. Shadow validation and the promotion guard (brief §76, §100)

**Shadow.** V2.1 and V2.0 are snapshotted hourly beside the champion V1 in the Model
Lab, graded identically. The Lab's promotion evaluation compares them on the live
sample. The decision engine runs in shadow with betting disabled. The matchup
residual's challenger is recorded by the weekly engine's `MATCHUP_SHADOW` stage
(`matchup_shadow.jsonl`, `moves_production: false`; production applies
NO_ADJUSTMENT).

**The guard** (`promotion.js`, VERSIONING.md §4) is run by every
`governance.js promote`. It requires:
- an explicit version;
- registration;
- a COMPATIBLE entry;
- a verified artifact;
- the full compatibility tuple;
- passing tests;
- a complete shadow evaluation.

Today it refuses V2.1 only on the last check: `INSUFFICIENT_SAMPLE (n 0 of 150)`.

## 14. Cost, retired work, silent failures (brief §116-118)

**Cost of this pathway.**

| step | measured locally | runs |
|---|---|---|
| the Model Lab job's own work, all steps | 4.7 s (`last_run.json`) | hourly in season, and pg_cron pokes |
| canonical projections and traces | 1.5 s | same |
| market intelligence | 0.2 s | same |
| market mirror | about 0.1 s | same |

Runner start-up and checkout dominate each run. The steps added here add about
2 seconds per hourly run. The files published hourly are about 0.34 MB
(projections.json) and about 0.28 MB (traces.json). The public panel downloads
only the first, and only when the V2 panel is switched on (`?cfbv2=1`).

**Rejected models.** No scheduled job runs a model that governance or research
rejected:
- The rejected matchup families run nowhere. The matchup shadow stage records the
  frozen shadow challenger's number only, by the matchup deliverable's design.
- Candidate 001 (V2.0) is a governance *candidate* tracked for comparison, not
  rejected, and it costs one extra engine call per game from rows already stored.

Retiring it is a governance act: `governance.js retire`. **Recommendation:** once
V2.1's live comparison has its sample, retire candidate 001 and drop `c001` from
the lab's model list. Nothing was deleted here; the research code stays in
`football/cfb_v2/research/`.

**Zero silent failures.** Every production-path `catch` was reviewed. Each one:
- returns an explicit sentinel the caller reports (UNAVAILABLE, NO_SOURCE,
  NOT_PUBLISHED, a `problems` list);
- logs a warning;
- or reads an optional file whose absence is itself reported.

One silent drop was fixed: the V1 board failing to read now sets
`sources.v1_error` and warns, instead of quietly removing fallback level 3.

## 15. Suites

All are in CI:

| suite | checks |
|---|---|
| `canonical.test.js` | 117 |
| `final_hardening.test.js` | 23 |
| `replay.test.js` | 7 |
| `debug_ui.test.js` | 32 |
| `security.test.js` | 55 |
| `golden.js` | 15 cases |
| `v2/weekly/tests_contract.py` | 51 fast, 54 real |
| `tools/football/cfb_v2_panel.test.js` | 20 |
