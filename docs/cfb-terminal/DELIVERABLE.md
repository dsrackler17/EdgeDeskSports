# EdgeDesk CFB Research Terminal — deliverable

> EV tools begin with the market. EdgeDesk begins with the game.

This change turns EdgeDesk's existing CFB production outputs into a research
terminal: one canonical research object per game, one canonical research page,
a research queue, a record that grades process apart from outcome, and an
assistant that answers only from stored data. **No model was added, retrained or
redesigned.** Every number comes from an existing production component; the new
code composes, presents and guards them.

Contents: [1 audit](#1-current-product-audit) · [2 workflow](#2-canonical-research-workflow) ·
[3-21 the research page and its features](#3-the-canonical-game-research-page) · [22 AI](#22-ai-research-assistant) ·
[23-24 record](#23-record-transparency) · [25-30 quality, filters, watchlist, brief](#25-30-data-quality-filters-cleanest-research-uncertainty-watchlist-weekly-brief) ·
[31 postgame](#31-postgame-research) · [32 positioning](#32-why-edgedesk-page) ·
[33 terms](#33-canonical-terminology) · [34 mobile](#34-mobile) · [35 removed](#35-removed-low-value-ui) ·
[36 analytics](#36-product-analytics) · [37 user tests](#37-user-testing) ·
[38 before/after](#38-before-and-after) · [39 demos](#39-current-slate-demonstrations) ·
[40 gaps](#40-remaining-product-gaps) · [41 files](#41-files-functions-tables) ·
[42 readiness](#42-production-readiness)

---

## 1. Current product audit
See [`AUDIT.md`](AUDIT.md). In one paragraph: the ingredients of a research
terminal already existed — an additive champion engine whose terms sum to the
fair line, an empirical margin PMF with real key-number mass, a major-gap
integrity gate, a fail-closed decision engine with price targets, point-in-time
Model Lab ledgers, an immutable record and opponent-adjusted unit metrics. They
were spread across a 25-section card, an admin-only lab and research documents,
with about 25 status words across four vocabularies. The decision engine's
verdict (betting disabled; calibrated EV −3.2% at every price) was not visible
to readers at all.

## 2. Canonical research workflow
**Board → research page → decision → monitor → review**, one route per step:

| Step | Where | What the reader gets |
|---|---|---|
| Identify an interesting game | `research/cfb/#/` — the research queue | rows ranked by research interest (not gap); status counts; 12 filters |
| Open the research card | `#/game/<id>` | the 15-second summary: EdgeDesk fair, market, gap, win vs cover probability, reliability, why, risk, price, needs |
| Understand projection → disagreement → why → risks → price | sections A–H | progressive disclosure: summary → why → advanced → raw data |
| Decide BET / WAIT / RESEARCH / PASS | the status chip + *Why not bet this?* | one of seven words, always with its reason and the price that matters |
| Monitor | `#/watch` | watchlist with fair/market/QB/status diffs, a stored target price, the reader's own books |
| Review | `#/record`, postgame cards | frozen number vs close vs final, CLV, process vs outcome, postmortem class |

The in-app CFB board and every in-app game card link into this workflow
("Full research page →" with the canonical status; "RESEARCH QUEUE" on the board).

## 3. The canonical game research page
`research/cfb/index.html` + `terminal.js` + `terminal.css`, reading
`football/cfb_terminal/{board,games,record,brief}.json`. The page runs **no
model** (tested). Sections:

| | Section | Content (source) |
|---|---|---|
| — | **Summary** | Model says / Market says / Gap / Win prob / Cover prob / Reliability / Why / Risk / Price / Needs, status + verified badge |
| A | EdgeDesk view | fair spread, projected score, win probability, fair total, 80% range, football confidence, outcome-distribution strip (10/25/50/75/90th) |
| B | Market | consensus, opener, move since open, best line each side, book count, quote freshness, line shopping (per-quote model EV, stale candidates), the reader's books |
| C | Disagreement | raw gap, class, verification, market direction, integrity checks, model-vs-market timeline, events, edge decay, *is the market telling us something?*, contradiction panel |
| D | Why EdgeDesk sees it differently | fair-line waterfall, where the disagreement sits, V2.1 drivers, model consensus + agreement, why the models disagree, matchup cards, what changed, projection history |
| E | What could make EdgeDesk wrong | risks, *what would have to be wrong*, sensitivity, path to cover / failure, data quality |
| F | Price decision | status, why-not-bet, current / cover / break-even / edge / EV / preferred / bettable-to / pass-beyond / worst price, reality check from the record, price curve, key numbers |
| G | Market timing | only validated evidence (the policy's WAIT rule is disabled, and the page says so) |
| H | Historical context | comparable sets from the record, each with n and a Wilson CI, printed as a rate only at n ≥ 30 |
| — | Ask this game | suggested questions + free text, answered from the object with sources |
| — | Advanced | sources and the full research object |

## 4. Fair-line decomposition
`T.decomposition`: the champion's additive terms (`projectGame` contributions,
carried in the slate's `disagreement_inputs` from the next slate build on),
summed and reconciled to the fair margin (tested). Zero-point terms are listed as
*not priced today* instead of drawn as reasons. The football-only calibration is
shown as *computed, not promoted* (it is not applied in production). Until the
first slate build that carries the terms, a **partial** decomposition is shown:
the neutral-field rating term from the published team ratings plus a labelled
remainder. Demo (Purdue @ Illinois, regenerated slate): team strength +10.3,
home field +4.1, matchup +0.5 → **Illinois −14.9**; not priced: QB, availability,
travel, conference, rivalry. **Where it sits:** "Holding everything else at
EdgeDesk's values, the market's number implies Illinois 5.4 pts better — the
disagreement sits in team strength."

## 5. Sensitivity analysis
`T.sensitivity`, from actual components only: each team's rating and home field
±1 SD (the champion's own perturbation SDs, 64 stability scenarios); each QB
OUT / CONFIRMED (V2.1's measured starter-change level effect, −1.16 pts, 95% CI
−2.0 to −0.2, n=1,567); wind 15/25 mph and a starting lineman out (production
widens the range and moves no spread — shown as a σ change, never as a line
move).

**What would have to be wrong** (`T.reconcile`): each uncertain input asked to
absorb the whole gap, ranked by how many of *its own* SDs that takes; terms that
could simply be unreal (e.g. the matchup term) with the share of the gap they
hold; the QB effect's share; a sibling model already closer to the market; and,
separately, ordinary model error as a baseline ("the whole gap is 41% of
EdgeDesk's typical miss"). Not presented as equally likely.

## 6. What changed
`T.whatChanged`: between two stored EdgeDesk numbers. With the terminal's own
snapshots (which store the terms and the QB state), attribution is exact
arithmetic over the engine's additive terms; with Lab checkpoints (number only)
the change is reported without attribution, and says so. QB state and model
version changes are named. The market's move is reported separately and never
as a cause (tested: a different market leaves the EdgeDesk view, decomposition
and sensitivity byte-identical).

## 7. Projection timeline
Sources, merged and de-duplicated: Model Lab checkpoints (OPEN, T72 … T2,
append-only), the record's first/pick, the terminal's append-only history
(`football/cfb_terminal/history/<season>/snapshots.jsonl`, one row per change,
hash ids, with terms). Mon–Fri labels on every point.

## 8. EdgeDesk vs market timeline
`T.timelines`: EdgeDesk fair and the market consensus (median of each book's
latest line at each capture) as step lines, point-in-time (nothing after the
build or, for a settled game, after kickoff — tested). Events: disagreement
opened, market toward / away from EdgeDesk, EdgeDesk moved, edge gone/reversed.

## 9. Edge decay
`T.edgeDecay`: initial vs current gap on the initial side, the market's
contribution and EdgeDesk's own, and a verdict: MOST OF THE VALUE IS GONE /
PART OF THE VALUE IS GONE / INTACT / GROWN / REVERSED. Postgame example
(Minnesota @ Washington): *initial 7.0 → 1.4 pts, EdgeDesk moved 5.6 back toward
the market — most of the value is gone.*

## 10. Price curve (and 18. the cover-probability curve)
Every status carries its price: *now / preferred / bettable to / pass beyond*,
e.g. **"Illinois: now −10 −110 · preferred and bettable to −12.5 −110 · pass at
−13 or worse"**. The curve is the champion's empirical PMF conditioned on the
current market number (as the engine conditions it), evaluated at each half
point; at the market number it reproduces `EDCfbP4.dist.coverProbSpread` to
1e-9 (tested on the real slate). Grades: strong ≥ +4 pp, acceptable ≥ +2 pp
(policy ideal), marginal ≥ +1 pp (policy minimum). A stale quote is never priced.

## 11. Research queue (with the four separate fields)
`T.fields`: **football_disagreement**, **price_value**, **research_interest**,
**bet_quality** — four fields, never merged. The queue sorts verified majors
first, then research interest (formula in `TERMINOLOGY.md`); raw gap is a
secondary sort. Tested: a 9-pt gap on reliability 45 ranks below a clean 3.5-pt
gap; DATA FAULT / NO MARKET are capped at 10.

## 12. Why not bet this? (PASS builds trust)
Every non-BET lists its blockers in order: the decision engine's own reason
(today: *the calibration was validated for a different model version*), betting
disabled by the frozen policy, the calibrated-EV reality read from the artifact
(*highest value −3.2% at any price*), then game-specific ones — QB not confirmed,
model agreement, thin market, cover vs break-even vs typical miss, unverified.
A PASS prints why EdgeDesk refused.

## 13-14. Component-model panel and the model-agreement system
V1 champion, V2.1 ensemble, V2.1 ridge efficiency model, V2.1 boosted matchup
model, V2.0 five-submodel candidate — a dot plot against the market line.
Agreement is the **SD of the independent numbers** (0-100, 0 at the policy's
6-pt limit), never a side count (tested: −5.2/−5.4/−5.7/−5.1 HIGH,
−2/−4/−7/−9 LOW). "Why they disagree" names only what the components say (ridge
vs boosted matchup model; V1's largest term vs V2.1's largest driver).

## 15. Matchup cards (continuous data, not ranks)
Pass game, run game, trenches, explosive plays, early downs, finishing drives,
turnovers — each offence against the other defence in league SDs from the
opponent-adjusted unit metrics, with side, magnitude, confidence (reliability
and sample) and the adjusted rates beside the league rate. No ranks. Not
measured, and said: havoc rate, QB mobility, pace.

## 16-17. Path to cover / failure, and the distribution view
Measurable conditions from the distribution, the matchup cards and the
reconciliation ("Illinois has to win by more than 10.0; EdgeDesk's median is 14.9;
hold the run-game edge (1.59 SD; YPC 7.2); failure: Purdue's pass game plays to
form (0.94 SD) … in a quarter of outcomes Illinois wins by only 3 or worse"),
explicitly not a prediction.

## 19. Key-number pricing
Empirical FBS final-margin frequencies (3 = 9.3%, 7 = 8.5%, 10 and 14 = 4.6%);
the half-point value at the current number from the PMF; a warning when the
market moved through a primary key number since the open.

## 20. Line shopping (model edge vs stale-book edge)
Every fresh quote with its model EV on both sides and a stale-candidate flag (a
fresh quote ≥ 1 pt off the consensus). Model edge (EdgeDesk vs consensus) and
book-price edge (best book vs consensus) are computed apart and named:
MODEL_EDGE, BOOK_PRICE_EDGE, BOTH, NONE.

## 21. Market contradiction view (and "is the market telling us something?")
Triggered when the market moved away from EdgeDesk or the gap is major. It
inspects QB, injury, roster, weather, mapping (the integrity gate's GAME group —
by group, not by words; a regression test pins the false positive that motivated
this) and market quality, and returns POSSIBLE EXPLANATION FOUND / NO NEW
FOOTBALL INFORMATION FOUND — BUT (unresolved items) / NO NEW FOOTBALL INFORMATION
FOUND. The projection never changes. Major gaps get EdgeDesk evidence / market
evidence / unresolved / status (HOLDS, RECHECK, INVESTIGATE, DATA FAULT).

### Verified disagreement is special — and rare
Only VERIFIED MAJOR DISAGREEMENT gets the gold badge and border; INVESTIGATE a
warning edge; PASS / NO MARKET are dimmed. No quotas: this week **0** verified,
9 INVESTIGATE (the integrity gate: one book cannot verify a 7+ gap).

## 22. AI research assistant
`T.ask(question, object, slate)` answers from the object with a source,
updated time and confidence for every claim, and reads the status without being
able to write it (objects are deep-frozen; tested). Intents: why EdgeDesk
disagrees, what changed, what would make it a pass, has the market moved, is the
price still good, how sensitive, which player matters, similar games, model
agreement; slate intents: highest agreement, deteriorated lines, biggest
verified discrepancies, research queue. **UNKNOWN** for betting splits, sharp
money, handle, scheme, motivation, and any injury or weather EdgeDesk does not
hold. "Ask this game" loads the context automatically; suggested questions come
from what the object carries.

The LLM boundary (`_cfb_explain.js`) now knows the seven canonical words, and
`T.explainSource(o)` feeds it the canonical object — an LLM calling an
INVESTIGATE game a PASS, or anything a bet, is refused and replaced by the
deterministic text (tested).

## 23. Record transparency
`#/record`: per graded game the frozen fair (the published pregame number, not a
later one — tested), entry market, close, final, side, ATS, CLV, process /
outcome, reliability at publication, model version; filters (BET only, LEAN,
gap buckets, reliability, favourite/underdog, conference, week). Today: **104-125-2
ATS (45.4%, 95% CI 39.1–51.9%, n=229)**, **CLV −0.15 pts (n=71, 23.9% beat the
close)**, EdgeDesk closer to the final than the close in 37.7% of games (MAE 12.9
vs 10.8, n=231). Printed first, not hidden.

## 24. Calibration and CLV presentation
"When EdgeDesk says X%, it happened Y%" for the published win probability, a
rate only at n ≥ 30 (today only the 90–100% bucket qualifies: said 96.5%, happened
97.9%, n=48). Cover-probability calibration is not measurable for the champion
from the record, and the page says so; the terminal stores cover probability
from its first build on. Process vs outcome: GOOD PROCESS / BAD PRICE / NEUTRAL
PRICE × WON / LOST / PUSH from CLV, UNKNOWN when no same-source close exists.

## 25-30. Data quality, filters, cleanest research, uncertainty, watchlist, weekly brief
- **Data quality** (#48-49): coverage rows (team data, QB, availability, player quality, environment, stability, live market), the main deduction, FCS explanation; always beside, never inside, a probability.
- **Trust panel** (#47): model version, build age, decision policy and betting state, operations status, warnings (today: *Operations CRITICAL — the V2.1 weekly refresh has not run*).
- **Filters** (#50): verified, model aligned, high confidence, QB confirmed, low model disagreement, best prices, moving toward / away, near pick'em, FCS/thin data, cleanest research, most uncertain.
- **Cleanest research** (#52): confidence ≥ 60, reliability ≥ 80, model SD < 3, fresh market, gap 2–7, no fault.
- **Most uncertain** (#53): QB contested/unknown, model SD ≥ 3, wide range, thin current-season data, FCS, low reliability.
- **Watchlist** (#55-57): stored per device; diffs for fair, market, QB and status; a clean target `{side, target_line, target_price}` defaulting to EdgeDesk's preferred entry, with TARGET_REACHED when the reader's books offer it; personal books restrict every best-price claim.
- **Weekly brief** (#62): largest verified, cleanest setups, most uncertain, biggest projection changes, market toward EdgeDesk, prices already gone, QB situations — with "No certified bets this week. That is a normal answer" when true.

## 31. Postgame research
146 postgame cards (last 10 days): timeline, edge decay, record grade and a
postmortem class — PROJECTION HELD / BAD PROJECTION / BAD VARIANCE /
DATA PROBLEM / UNKNOWN — with what is not measured (turnovers, inactive lists)
and the rule that a postmortem changes nothing in production.

## 32. Why EdgeDesk page
`#/why`: independent number first; why, in points; what would have to be wrong;
integrity before interest; price discipline; visible uncertainty; market context;
an unedited record (with its actual numbers); PASS as an answer. No performance
claim is made.

## 33. Canonical terminology
[`TERMINOLOGY.md`](TERMINOLOGY.md) — and the page's Terms tab renders the same objects.

## 34. Mobile
Queue rows collapse to GAME + STATUS with ED / MKT / GAP beneath; no horizontal
scroll at 390 px (checked in Chromium); the summary is two columns; sections
collapse; the flag menu is one button.

## 35. Removed low-value UI
- The ten-chip *Model scores* panel on the app card (volatility is documented as non-discriminating; none was a reason or risk).
- The legacy edge tag in *Model and market detail* (a second status system).
- The data-completeness line survives, inside *Data quality and methodology*.
- On the terminal: zero-point terms are listed as *not priced* rather than shown as reasons; a stale quote is never priced; weather never appears as a line move.

## 36. Product analytics
`supabase/cfb_terminal_analytics.sql`: an insert-only `cfb_terminal_events`
table reachable only through `cfb_terminal_track()` (fixed event list, clipped
fields, no identity columns, 120 events/visitor/hour), admin-only roll-ups
(`cfb_terminal_usage`, `cfb_terminal_return_rate`: returning visitors, record
viewers, explanation openers, market openers). Tested against a real PostgreSQL
(18/18). A test fails if any `football/`, `lib/` or `tools/` code references the
table — engagement never reaches a model. Feedback (#78-79) reuses the one
report-a-problem library with the game prefilled (player status / market quote /
confusing explanation); reports go to review and change nothing by themselves.

## 37. User testing
`football/cfb_terminal/user_test.js` — an **answerability audit**, not a study
with people. For 20 games stratified by status it checks that each of the six
questions (what EdgeDesk thinks, why, what is uncertain, the market, the price
required, what would invalidate it) has an explicit answer where a reader would
look: **20/20**. New-user checks (win vs cover probability defined on every
summary, reliability labelled not-a-probability, EV labelled research, a Terms
page): 4/4. Advanced-user checks (reasoning, data quality, market state and raw
sources inspectable without code): 4/4. A study with real bettors is still owed
(see gaps).

## 38. Before and after
| | Before | After |
|---|---|---|
| Screens to understand a game | app → Football → Power 4 → expand row → a 25-section card | queue row (5 fields) → one research page whose summary answers 8 questions |
| Status words on one card | ~25 across four vocabularies (board chip, research label, edge tag, decision) | 7, one function, one reason, plus the verified badge |
| Why | three overlapping views | one waterfall that sums, plus where the disagreement sits |
| Price context | a collapsed *Price and break-even* near the bottom; no curve | *now / preferred / bettable to / pass beyond* in the summary; a price curve with pushes; key numbers; a record reality check |
| Risk context | *Why this number could be wrong* list | risks + what would have to be wrong (ranked, in SDs) + sensitivity + paths |
| Market | one line, one book | consensus, opener, move, freshness, line shopping, timeline, edge decay, market check |
| Honesty | decision engine invisible | the policy's verdict is the first *why not bet* line; the record is on the page |

Time-to-understand was not measured with people. The structural proxy: the
answer to "what does EdgeDesk think, what does the market think, and what is the
status" moved from a board chip plus an expanded card to the first card on the
page.

## 39. Current-slate demonstrations
Rendered in headless Chromium from the demo build (the committed artifacts plus a
slate regenerated with the engine's terms — what the first hourly build after
merge publishes). Screenshots: [`demo/`](demo/).

| Case | Game | What the reader sees |
|---|---|---|
| Market aligned | Western Kentucky @ New Mexico State | PASS — 0.1 pts apart; "WKU becomes interesting at +3.5 or better; pass at +2.5 or worse" ([png](demo/d_aligned.png)) |
| Moderate research | Purdue @ Illinois | RESEARCH — Illinois −14.9 vs −10.0; team strength +10.3, home field +4.1, matchup +0.5; model SD 0.46 (HIGH); cover 60.9% vs 52.4%; reality check: 4–7-pt gaps went 27-22 (n=49, CI 41–68%); *why not bet*: wrong-model calibration, betting disabled, calibrated EV −3.2%, QBs unconfirmed, one book ([png](demo/d_research.png), [D](demo/d_research_d.png), [E](demo/d_research_e.png), [F](demo/d_research_f.png)) |
| INVESTIGATE | Ohio State @ Iowa | 7.7 pts toward Iowa; integrity gate: *1 book behind the consensus; football-only calibration puts the gap at 6.6*; not priced until verified; market check: unresolved QB/injury/market; history: 7+ gaps went 32-47 (n=79) ([png](demo/d_investigate.png), [C](demo/d_investigate_c.png)) |
| VERIFIED MAJOR | — | **None genuinely exists this week.** With one captured book no 7+ gap can pass the market checks; the page says so instead of promoting one |
| PASS | Texas Tech @ Colorado | 1.8 pts apart; models disagree (SD 4.2); pass at −14.5 ([png](demo/d_pass.png)) |
| NO MARKET / thin data | Samford @ UAB | no quote; FCS explanation; reliability 59; fair UAB −21.0 with range ([png](demo/d_nomarket.png)) |
| WAIT | Akron @ Central Michigan | 3.2 pts toward CMU; "wait for the quarterback decision: a contested job" ([png](demo/d_wait.png)) |

Also: the queue ([desktop](demo/d_queue.png), [mobile](demo/d_queue_mobile.png)),
a research page on mobile ([png](demo/d_research_mobile.png)), Ask this game
([png](demo/d_ask.png)), the brief ([png](demo/d_brief.png)) and the record
([png](demo/d_record.png)). Counts at the demo time (18:10 UTC): 0 BET, 14
RESEARCH, 7 WAIT, 9 INVESTIGATE, 13 PASS, 0 DATA FAULT, 17 NO MARKET, 0 verified.
In the committed build (19:20 UTC) more quotes had aged past the 180-minute
window: 0 BET, 12 RESEARCH, 6 WAIT, 9 INVESTIGATE, 10 PASS, 0 DATA FAULT,
23 NO MARKET — the freshness rule doing its job; the next hourly Lab capture
refreshes them.

### Final differentiation test
*If a reader already subscribes to an EV scanner, what does EdgeDesk give them
that the scanner does not?* Only implemented capabilities:
1. An independent fair line with its own additive explanation, and the market's implied number set against it term by term.
2. What would have to be wrong for the market to be right, ranked by each input's own measured uncertainty, and a sensitivity table from the model's components.
3. An integrity gate that refuses to call a big gap an edge until it is verified — and says why when it cannot.
4. A price ladder from EdgeDesk's own key-number-aware margin distribution (now / preferred / bettable to / pass beyond), with model edge separated from stale-book edge.
5. The model-versus-market timeline and edge decay: whether EdgeDesk was early and how much value is already gone.
6. Model agreement from dispersion across five EdgeDesk models and a *why they disagree* line.
7. A record graded as published, with CLV and process-vs-outcome, and a "reality check" beside every price.
8. A reason for every PASS.

## 40. Remaining product gaps
Prioritised; none was built here.
1. **No certifiable price exists today.** The decision calibration is validated for V2.1, the champion is V1, betting is disabled and the calibrated EV maps to −3.2% everywhere. A governance decision, not a product one.
2. **Market breadth.** The committed ledger holds essentially one book (ESPN's DraftKings line). Line shopping is single-book and no 7+ gap can be verified until the per-sportsbook capture (`cfb_lab_market_quotes`) flows into the Lab's hourly pull.
3. **The app board still speaks its legacy nine labels.** Converging it on the seven words touches CSV exports, articles, the newsletter and ~15 suites; the card now carries the canonical status beside them.
4. **The deployed AI desk (`index.ts`) does not yet route CFB game questions through `T.ask` / `_cfb_explain`.** The boundary and adapter are tested; wiring and deploying the edge function is the next step.
5. **Watchlist and price targets are device-local.** Syncing them to the personal-research watchlist and letting its alert engine read `target_line` is the path to notifications.
6. **A study with real bettors** (time-to-understand, misreadings) — the answerability audit is a proxy.
7. **History depth.** Term-level history starts with this build; the opener archive covers 71 games; cover-probability calibration starts now.
8. **Postmortems** lack turnovers and inactive lists; miss classes are partial.
9. **Matchup gaps**: havoc, QB mobility and pace are not measured.
10. **Timing** has no validated evidence (the policy's WAIT rule is disabled).
11. **Access**: whether `research/cfb/` sits behind the subscription is the owner's call (the page is `noindex` and not in the sitemap).
12. **Operations**: the V2.1 weekly engine has not run this season (ops CRITICAL); the trust panel shows it.

## 41. Files, functions, tables
| File | What |
|---|---|
| `lib/cfb_terminal.js` (new) | `EDCfbTerminal`: `build`, `edgedeskView`, `marketView`, `disagreementView`, `decomposition`, `priceView`, `coverCurve`, `keyNumbers`, `lineShopping`, `consensus`, `sensitivity`, `reconcile`, `risks`, `dataQuality`, `trust`, `matchupCards`, `paths`, `timelines`, `edgeDecay`, `whatChanged`, `marketCheck`, `contradiction`, `status`, `fields`, `FILTERS`, `isCleanest`, `uncertainty`, `summary`, `questions`, `timing`, `queue`, `counts`, `filter`, `brief`, `recordRows`, `RECORD_FILTERS`, `recordSummary`, `calibration`, `benchmark`, `postmortem`, `historicalContext`, `watchEntry`, `watchDiff`, `bestForBooks`, `ask`, `askSlate`, `explainSource`, `exportCard`, `TERMS`, `STATUS`, `LEGACY_MAP` |
| `football/cfb_terminal/build.js` (new) | the hourly build: governance → champion, V1/V2 distributions (`v1CoverConditioned`), integrity gate, decision engine, history, board/games/record/brief |
| `football/cfb_terminal/{board,games,record,brief}.json` (new, generated) | the cached research objects |
| `football/cfb_terminal/history/2026/snapshots.jsonl` (new, append-only) | projection history with terms and QB state |
| `football/cfb_terminal/tests.js`, `user_test.js`, `analytics_sql.test.js` (new) | 111 rules; the 20-game audit; 18 SQL checks |
| `research/cfb/index.html`, `terminal.js`, `terminal.css` (new) | the research terminal |
| `supabase/cfb_terminal_analytics.sql` (new) | `cfb_terminal_events`, `cfb_terminal_track`, `cfb_terminal_usage`, `cfb_terminal_return_rate` |
| `supabase/functions/edgedesk_ai/_cfb_explain.js` | the boundary knows the seven canonical statuses |
| `app.html` | `fbTermLoad`, `fbTermLink`; card links to the research page; *Model scores* panel and legacy edge tag removed; board link |
| `tools/app/game_research.test.js` | card structure updated to the new truth |
| `.github/workflows/cfb-lab.yml` | the hourly build step and publish path |
| `.github/workflows/cfb-terminal.yml` (new) | the terminal's CI with a PostgreSQL service |
| `package.json` | `cfb:terminal`, `cfb:terminal:check`, `cfb:terminal:test`, `cfb:terminal:usertest`; terminal tests in `npm test` |

## 42. Production readiness
**Ready to merge.** The page is static and reads cached objects; the build is
deterministic from committed inputs, refuses to write when a rule breaks (fair ≠
champion slate, actionable status on a stale market, BET while betting is off),
and runs after the Lab's hourly append with a fail-soft step (the last objects
stay up). Immutability (append-only history, frozen record), versioning (the
champion from governance; the model version on every page), source freshness
(stale quotes are never priced), the fail-closed decision policy and the
canonical prediction path are unchanged. Tests: terminal 111/0, user audit 20/20,
analytics SQL 18/0; existing suites re-run green (game research 186, research
view UI 200, disagreement 169, FBS board 185, press brief 65, brief research 162,
reliability 111, Lab 275, Lab UI 83, production 118, decision 101, explain guard
37, research core parity 1,254 …).

**Before announcing it:** apply `supabase/cfb_terminal_analytics.sql` (until then
the page's analytics call fails harmlessly); decide access; let one hourly slate
build publish the engine's terms (the full decomposition and the integrity gate
switch on automatically).
