# Bettor decision layer — engineering report

Branch `claude/lucid-lamport-19axzb`. The design is
[DESIGN.md](DESIGN.md); what existed before is [AUDIT.md](AUDIT.md).

## 1. Files changed

**New**
| File | Role |
|---|---|
| `lib/edgedesk_decision.js` | The engine: config, hierarchy, candidate selection, sizing, strength, playable-to, bet trigger, anomaly review, the canonical object (UMD, ES5) |
| `lib/edgedesk_decision_track.js` | Transitions, tracks, closing, CLV (via `EDResearch.clvPoints`), snapshots, the reader's entry vs the frozen recommendation, per-tier performance |
| `lib/edgedesk_bankroll.js` | Units → dollars, settings normalisation and storage mapping, exposure, correlation notes, guardrails |
| `lib/edgedesk_decision_inputs.js` | Facts adapters (terminal object, live research view, live evaluation) and the join into engine input |
| `lib/edgedesk_decision_ui.js`, `lib/edgedesk_decision.css` | Action card, board chip, overview banner, EdgeDesk Card page, bankroll form, onboarding, beginner mode, tooltips, BET PLACED, controller |
| `football/cfb_terminal/decisions.js` | The build's decision stage: per-game decide, append-only snapshot ledger, write-once grades, track replay, `decisions.json`, build refusals |
| `football/cfb_terminal/decisions_sync.js` | Insert-only mirror of the ledger to Supabase |
| `football/cfb_terminal/decisions.json` | The published decisions for the committed slate (built at its own timestamp) |
| `supabase/bettor_decisions.sql` | Bankroll unit convention, `user_bets`, decision snapshots/grades, views |
| `tools/bettor/decision.test.js`, `tools/bettor/bettor_sql.test.js`, `tools/bettor/decision_ui.e2e.js` | Tests |
| `docs/bettor-decision/{AUDIT,DESIGN,REPORT}.md` | Documentation |

**Modified**
| File | Change |
|---|---|
| `football/cfb_terminal/build.js` | `quoteEvOf` returns its model/quotes/context; `buildGame` calls the decision stage; board rows gain `decision_facts` and `bettor`; writes `decisions.json`; ledger append on a normal build; refusal checks |
| `football/cfb_terminal/board.json` | Only the two new row fields added (everything else byte-identical); the hourly build regenerates it |
| `app.html` | Stylesheet + five scripts; `#v-card` view, `show('card')`, `#card` deep link, a Card seat in the bottom bar beside Research; `fbDecisionCfb` / `fbDecisionNfl` / `fbDecisionsLive`; action card above the research on CFB and NFL cards; chip on FBS rows; overview banner; the summary's Decision cell now reads the canonical decision (governed verdict kept as its audit line) |
| `research/cfb/terminal.js` | The decision chip reads the board row's canonical `bettor` decision when present |
| `supabase/functions/edgedesk_ai/_stake.js` (+ inlined `index.ts`) | `unit_mode = 'percent'` derives the unit from the bankroll (the same unit the Card uses); rows without the column behave as before |
| `tools/personal/research_state.js` | New `bets` step: grades `user_bets` from the committed record |
| `tools/app/game_research.test.js` | Pins the new order (action card above the summary) and that research collapses only in beginner mode |
| `package.json` | `bettor:test`, `bettor:sql`, `bettor:e2e`, `bettor:sync`; bettor suites in `npm test` and `cfb:terminal:test` |
| `.github/workflows/{cfb-terminal,personal-tests,cfb-lab}.yml` | Bettor suites on PRs; ledger sync (fail-soft) in the hourly job |
| `README.md`, `supabase/README.md` | Sections for the layer and the SQL file |

## 2. New decision architecture

One pure function, `EDDecision.decide(input)`, over two halves of input:
**facts** (research status, integrity, market facts, reliability, confidence,
stability, QB, availability, support, anomaly context, governance) and
**pricing** (the EDQuoteEV model, quotes and evaluation the build/page already
computed). Hierarchy, first failure wins: game state → integrity → market
quality → calibration → price → information (WAIT) → anomaly (WAIT) →
calibrated advantage (PASS) → reliability/stability/market floors → sizing →
governance → BET. It returns one deterministic, versioned, content-hashed
object; every surface prints it. No probability or EV is computed outside
`lib/edgedesk_quote_ev.js`.

## 3. Unit sizing rules

0.25U ≥ 1.5% calibrated EV, reliability ≥ 60, ACCEPTABLE market · 0.50U ≥ 3%,
≥ 70, STRONG market, MEDIUM stability, ≥ 1 independent signal, composite ≥ 55,
no material warning · 0.75U ≥ 5%, ≥ 80, VERIFIED, HIGH, ≥ 2, ≥ 70 · 1.00U ≥ 7%,
≥ 85, VERIFIED, HIGH, ≥ 2, ≥ 82, QB and availability certain, no anomaly,
**and live validation of the tier**. Units are the minimum of the EV tier, the
requirement tier, the composite tier and every cap, rounded down; caps are
0.75U while unvalidated (1.00U recorded as `shadow_units`), 0.50U after a
cleared anomaly, 0.25U on a SEVERE extreme, 1.00U absolute. Raw EV and past
results have no input into sizing (tested).

## 4. Playable-price logic

From the BET quote (L₀, P₀): the worst line at P₀ that still clears the
calibrated-EV floor (inside the validated ±3-point tail), then the worst
whole-cent price at each line (bisection, rounded toward the bettor). The
corner (worst line, its worst price) clears, and every better line and price
clears by monotonicity; the frontier gives the juice limit at each number.
Displayed as `+6.5 to +5.5 · up to −115`, `… or better · maximum −112`, or
`CURRENT PRICE ONLY`, with "holding the rest of the market where it is" (the
calibrated probability is anchored at the market line). A price outside the
range turns BET → PASS / PRICE MOVED. PASS decisions get the bet trigger.

## 5. Bankroll handling

1 unit = 1% of bankroll by default ($250 → $2.50, $500 → $5, $1,000 → $10,
$2,500 → $25), or a custom unit, or a custom percent (≤ 10%). Stored locally
(`edgedesk_bankroll_v1`) and, when signed in, in `public.bankroll_settings`
(new columns), which the AI desk's staking engine also reads. Bankroll never
changes a unit classification. Maximum active exposure (default 5U) warns;
exposure limiting is opt-in.

## 6. UI changes

EDGEDESK ACTION card above the research on every CFB game panel and NFL card
(desktop: reasoning open; phone ≤ 560 px: decision, selection, price, dollars,
playable-to, two metrics, "View reasoning"); the summary's Decision cell and the
research terminal chip read the same decision; a decision chip on every FBS
board row; an EdgeDesk Card banner on the Football overview; bankroll & units
modal; four-page onboarding (first Card visit); beginner mode (research
collapsed behind VIEW FULL RESEARCH); tooltips with the spec's definitions;
BET PLACED with the entry compared against the frozen recommendation and CLV.
Tones: BET filled green badge and rule; WAIT amber, DO NOT BET YET; PASS
subdued; NO DECISION dashed neutral.

## 7. EdgeDesk Card page

`#card` / the Card seat beside Research in the bottom bar. Header: bets, total exposure (units and
dollars), watching, passes, no decision, last evaluated. Filters: All, Bets,
Watching, Pass, No decision, NFL, CFB, 0.25U–1.00U. Sorts: kickoff, strongest
qualified edge, calibrated EV, latest change, line movement. Sections: BET,
WATCHING, PASS (collapsed), NO DECISION (collapsed); exposure by sport, window
and market with correlation notes and the guardrail; the reader's recorded bets
and average CLV; per-tier decision performance; the validation note. Data: the
committed `decisions.json`, overlaid with every live decision the boards have
computed this session (newer wins).

## 8. State-transition logic

`EDDecisionTrack.transition(prev, next)` classifies every change (PRICE
IMPROVED, STILL PLAYABLE, PRICE MOVED, NEW INFORMATION, INFORMATION RESOLVED,
MARKET AVAILABLE/UNAVAILABLE) with time, reason and both quotes; `track()`
keeps current and previous state, first qualified (fixed), best observed (only
improves), last evaluated and the append-only transitions. The engine itself
uses the previous decision for PRICE_MOVED vs PROJECTION_CHANGED and for WAIT /
QUOTE_REFRESH_PENDING when a BET's quote goes stale. The build replays tracks
from its snapshot ledger; the page keeps a per-device copy and never records a
provisional decision made while the calibration loads.

## 9. Tests added

- `tools/bettor/decision.test.js` — **186** assertions: every scenario the
  spec lists (positive raw + negative calibrated = PASS; huge raw + market
  fault ≠ BET; huge gap + unverified = WAIT; no two-sided = NO DECISION; stale ≠
  BET; strong gates = BET; line / juice beyond the boundary = PASS; line improves
  = BET; QB unresolved BET → WAIT; QB resolves → re-evaluated; injury changes
  projection; market fault resolved; 0.25 / 0.50 / 0.75U; the 1.00U cap;
  bankroll conversion; custom unit; push; pick'em; plus money; alternate line;
  missing calibration; low reliability; extreme gap; books disagreeing;
  orientation; duplicates; cancellation; postponement) plus determinism, raw EV
  never sizes, no loss-chasing, governance, tracks, snapshots, CLV, the
  reader's entry, performance, the real slate and the renderers.
- `tools/bettor/bettor_sql.test.js` — **48** assertions against a real
  PostgreSQL 16 (applied twice; readers A/B, anon, service role).
- `tools/bettor/decision_ui.e2e.js` — **41** assertions in Chromium at 1280 px
  and a 390 px phone (real slate, real engine, no sideways scroll).

## 10. Existing tests run

`npm test` — the whole chain, now ending with the bettor suites — **exit 0: 293
suites reporting green, 0 failures**; 20 pre-existing suites printed SKIP
because they need an external PostgreSQL server (games, tennis, UFC, billing,
issue-report and community SQL), exactly as before this change, and run in
their own CI jobs. Also: `npm run cfb:terminal:test` (terminal rules on the real slate,
Read, EV, quote EV, alternates, user test) green; `tools/football/quote_ev_ui.e2e.js`
34/34 and `tools/football/fbs_board.e2e.js` 58/58 in Chromium; the staking
suites (`stake.test.js` 384, `stake_host.test.js` 39) and
`presentation_sync.test.js` after the `_stake.js` change; `tools/validation/ui.test.js`
81/81 after the terminal change. PostgreSQL-service suites that need a running
server (games SQL, terminal analytics SQL) skip locally as before and run in
their own CI jobs.

## 11. Migrations required

Paste `supabase/bettor_decisions.sql` into the SQL editor **after**
`supabase/bankroll_and_stakes.sql`. Idempotent, additive, ends in a report.
Until it is applied: bankroll settings and placed bets stay on the device, and
the hourly sync warns and skips.

## 12. Environment / config changes

None required. The hourly `cfb-lab.yml` job already rebuilds and publishes
`football/cfb_terminal/` (so `decisions.json` and `decisions/<season>/` ship)
and now runs `decisions_sync.js` with the existing `SB_URL` /
`SB_SERVICE_ROLE` secrets (fail-soft). Thresholds live in
`EDDecision.DEFAULT_CONFIG`; `markets['CFB:spread'].bet_authority` can be set
to `GOVERNED_POLICY` to require the governed policy's `bet_enabled`.

## 13. Known limitations

- **Today's honest output is no BETs.** The promoted CFB calibrator puts the
  calibrated EV near minus the vig at every main-line price (0 of 60 priced
  quotes positive), and NFL has no calibration. The slate published with this
  change (built 2026-09-28 18:07Z) reads 0 BET · 0 WAIT · 18 PASS · 44 NO
  DECISION (38 stale quotes, 6 no market); the 17:07Z slate read 0 · 2 · 28 · 32.
  It moves every hour with the market. BET rendering is exercised by the engine
  on synthetic models in the tests.
- Most CFB games have one fresh book, so market quality is ACCEPTABLE and any
  BET would cap at 0.25U.
- The page decides live (live quotes); `decisions.json` is hourly. They can
  differ between refreshes; "Last evaluated" says when each was made.
- NFL decisions exist only in the browser (the build is CFB-only) and are NO
  DECISION until an NFL calibration exists.
- Totals and moneylines are unsupported (no validated probability).
- The alternate-spread capture is off, so alternatives are usually empty.
- The playable range assumes the rest of the market holds; a consensus move
  re-prices every number.
- Per-device tracks and placed bets sync to the account only after the SQL is
  applied; transitions in the server ledger have hourly granularity.

## 14. Still operating in shadow mode

The 1.00U tier (recorded as `shadow_units`, never recommended); the governed
CFB policy `cfb_decision_policy_v1` (SHADOW, `bet_enabled: false`, still logged
and shown as the Decision cell's audit line); the CFB EV calibrator (PROMOTED,
maturity SHADOW) and EV policy `cfb_ev_policy_v1` (SHADOW).

## 15. Must remain unvalidated until more live data exists

Every decision threshold (the 1.5% floor, the 3 / 5 / 7% tiers, reliability
60 / 70 / 80 / 85, the composite weights and cut-offs, the anomaly and WAIT
thresholds, the 0.50 / 0.25U anomaly caps), the market-quality and stability
mappings, the risk-adjusted (EV per unit of return SD) alternate selection, and
every stake tier. The per-tier record — `decisions.json` `performance` and
Supabase `bettor_decision_performance`, graded once at the Lab's consensus
close and the final — is the mechanism; no tier should be promoted before it
holds at least 50 settled bets.
