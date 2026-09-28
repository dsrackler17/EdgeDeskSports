# The EdgeDesk Read — deliverable

**One canonical, price-specific research read per game, built from what EdgeDesk
already produces.** No predictive model was added, retuned or redesigned; no
sportsbook price enters the fair line; no LLM produces a number, a status or a
narrative. Methodology: [DESIGN.md](DESIGN.md).

**The honest headline on today's slate.** Every read is **CALIBRATION PENDING**,
so none is a certified bet. The decision calibration on file is validated for
V2.1; EdgeDesk fair comes from the governance champion V1, and `decision.js`
refuses the mismatch. Betting is also disabled by the frozen policy. The Read
therefore answers every price question, and labels every answer that would
need a calibrated probability as RESEARCH ONLY. It never turns an uncalibrated
number into a BET. When governance aligns the champion with a validated
calibration and enables betting, the same code issues BET / BET EARLY. The
fixtures prove it.

Contents: [1 audit](#1-architecture-audit) · [2 files](#2-files-changed) · [3 database](#3-database-changes) ·
[4 schema](#4-the-canonical-edgedeskread-schema) · [5–27 methodology](#5-27-methodology) · [28 mobile](#28-mobile-ui) ·
[29 record](#29-record-integration) · [30 export](#30-export-integration) · [31 validation](#31-validation-dashboard) ·
[32 tests](#32-automated-tests) · [33 demos](#33-current-slate-demonstrations) · [34 limitations](#34-known-limitations) ·
[35 maturity](#35-maturity-of-each-submodule) · [36 UI](#36-ui) · [37 readiness](#37-production-readiness) · [38 blockers](#38-remaining-bugs-and-blockers)

---

## 1. Architecture audit

What already existed, and what the Read reuses (nothing is duplicated):

| Component | Where | Used by the Read for |
|---|---|---|
| Governance champion V1 (`edgedesk_cfb_p4_v1.0.0`) | `football/fbs/slate.json`, `football/cfb_p4/engine.js` | EdgeDesk fair (the only fair line) |
| Champion margin PMF, market-conditioned | `football/cfb_terminal/build.js v1Dist` (`margin_pmf_by_spread`) | the probability at every half point, stored as the curve |
| Research terminal | `lib/cfb_terminal.js`, `football/cfb_terminal/build.js`, `research/cfb/` | research status, decomposition, risks, agreement, edge decay, the page |
| Decision engine (shadow, fail closed) | `football/cfb_decision/decision.js` | odds math, de-vig, calibration, market confidence, the governed BET per quote |
| Decision calibration / policy | `football/cfb_v2/artifacts/decision/cfb_decision_{calibration,policy}_v1` | thresholds; the calibration (validated for V2.1 only) |
| Market integrity | `football/cfb_lab/integrity.js` | freshness rules, the MAD outlier screen |
| Model Lab ledger | `football/cfb_lab/ledger/<season>/` | quotes (DraftKings via ESPN, priced; CFBD consensus, unpriced), opener, close, results |
| Integrity gate for 7+ gaps | `lib/cfb_disagreement.js` | INVESTIGATE / MARKET FAULT / DATA FAULT / VERIFIED |
| Explanation boundary | `supabase/functions/edgedesk_ai/_cfb_explain.js` | the AI's facts and refusals |
| Market intelligence | `football/cfb_market/market_intel.js` | its language audit (tests) |

Findings that shaped the design:
- **No alternate spread is captured anywhere.** The capture function asks for
  h2h, spreads and totals. The Lab's consensus, opener, close and `decideGame`
  all exclude `alternate`.
- **One priced book.** The committed ledger holds DraftKings (ESPN) with prices,
  plus CFBD consensus lines without prices. Line shopping and consensus work for
  any number of books but show one today.
- **The calibration is V2.1's.** The champion is V1, so the only honest
  calibration status is PENDING (§9).
- **The V1 PMF is key-number-aware but shifts by an integer** when EdgeDesk and
  the market differ (§34).
- `projections.json`'s market (shown in the app's V2 panel) lags the ledger. That
  is exactly the "stored +16 vs live +13.5" pattern, and the Read's quote check
  now flags it.

## 2. Files changed

| File | What |
|---|---|
| `lib/edgedesk_read.js` (new, ES5, browser + node) | the Read: odds normalisation, the curve, options, calibration, consensus, freshness audit, quote check, main-vs-alt, best value, price curve, frontier, bettable-to / target / price gone, the timing engine, movement, edge kind, explanations, compare / what-if / manual entry / parser, ask, snapshot, grade, validation, filters, ranking, export, the terminal adapter |
| `football/cfb_terminal/build.js` | stores the Read's inputs per game (`readBase`: the curve, calibration verdict, policy, every quote including alternates, opener, stored numbers, moneyline, the governed decision per quote), builds the read, the append-only read record and grades, `read_validation.json`, `read.csv`, board read summary/filters/counts, refusals (an actionable read while betting is off, on a stale quote, on an unverified gap, with banned words, or with a fair line that differs) |
| `football/cfb_terminal/alternates.js` (new) | opt-in alternate-spread capture from The Odds API event endpoint, budgeted, its own ledger |
| `football/cfb_terminal/read.test.js` (new) | 178 checks |
| `lib/cfb_terminal.js` | `T.ask` routes price questions to the Read (after the sharp-money guard); `exportCard` appends the Read; `explainSource` carries it |
| `research/cfb/index.html`, `terminal.js`, `terminal.css` | the EDGEDESK READ card (first on the game page), its sections and tools, the frontier chart, queue Read filters and chips, the "Read record" page, read-at-decision on postgame cards, watchlist targets from the Read |
| `supabase/functions/edgedesk_ai/_cfb_explain.js` (+ regenerated `index.ts` block) | the Read as explanation facts; refuses a "certified" or bet claim on a non-certified read |
| `football/cfb_terminal/{games,board,record,brief}.json`, `read.csv`, `read_validation.json`, `read/2026/reads.jsonl` | rebuilt artifacts; regenerated by the hourly build (the §33 values are at commit `48ca6a7`, 21:35 UTC Sept 27 clock) |
| `package.json`, `.github/workflows/cfb-terminal.yml` | `cfb:read:test`, `cfb:read:alternates`; the suite on every PR |
| `docs/edgedesk-read/` | this document, DESIGN.md, demo screenshots |

## 3. Database changes

**None.** The existing tables were audited and none was redundant to add.
- The Read record is an append-only JSONL ledger in the repository, the same
  pattern as the terminal's history and the Model Lab ledgers, which are the
  source of truth; Postgres is only their insert-only mirror.
- `cfb_decision_snapshots` already mirrors governed decisions, and
  `cfb_lab_market_quotes` holds quotes.
- A future Postgres mirror of `reads.jsonl` / `grades.jsonl` would follow
  `football/cfb_decision/sync_supabase.js`. It is not needed for the product to
  work, and it is not built.

## 4. The canonical `edgeDeskRead` schema

`games.json → games[id].read` (schema `edgedesk_read_v1`), recomputed live by the page:

```
game_id, generated_at, model_version, home, away, kickoff, view{mode,book,books}
fair_spread{home_margin,home_line,text}, fair_total, projected_margin, projected_score
market_consensus_spread{home_line,text,n_books,method,stale,as_of}, consensus{…}
side, side_team, fair_line_for_side
selected_book, selected_book_spread, selected_book_price, selected{option}, quote_age_seconds, valid_until
model_market_gap{points,toward,toward_team,signed_home}, cushion
cover_probability, raw_cover_probability, calibrated_cover_probability, push_probability, loss_probability, win_probability
break_even_probability, estimated_ev, raw_ev, decision_ev, ev_after_buffer, edge, probability_basis, calibration{status,version,base_model_version,reason}
football_confidence, reliability, model_agreement{label STRONG|MODERATE|WEAK, sd, components[]…}, market_freshness{score,label,basis}
research_status{status,label,reason,integrity_gate,blocks_action,caps_at_research,verified}
decision_status  BET_EARLY | BET | WAIT | PASS | RESEARCH_ONLY | NO_DECISION
timing_read      BET_EARLY | BET | WAIT | PRICE_TARGET | PASS | PRICE_GONE | RESEARCH | INVESTIGATE | NO_DECISION
timing_reason, timing_code, actionable, urgency{reasons,support}
preferred_line, preferred_price, bettable_to{label BETTABLE TO|NEEDS|CLEARS AT|RAW THRESHOLD, line, price_at_current_line, preferred_line, pass_beyond, text}
target_price{line,price,text,distance_pts}, price_status{key,label}, price_is_gone{state,initial,current,text}
best_value_market{type MAIN_SPREAD|ALTERNATE_SPREAD|NONE,…}, best_available, consensus_read
main_vs_alt_summary{main_line,best_alt,safest_alt,best_value,alt_verdict,text,captured}, alternates{rows[{option,vs_main,verdict,text,liquidity}],overpriced}
line_shopping[], price_curve{offered[],ladder[]}, frontier{points,efficient_to}
market_movement_summary{open,consensus,best_available,selected,movement_pts,direction TOWARD|AWAY|STABLE,text}
edge_decay{initial_model_gap,current_model_gap,decay_pct,verdict,text}, edge_kind{kind,model_edge_pts,book_price_edge_pts,text}
stale_market{stale,text}, quote_freshness{quotes[],checks[]}, market_quote_check[]
why_edgedesk_differs{rows,final_fair,market_implied}, risk_summary[], what_would_make_us_wrong[], qb_status
why_not_bet[], why_wait[], why_bet_early[], integrity_status{gate,status,blocks_action,quote_check_blocks}
user_quotes[], markets{spread,total,team_total,moneyline}, maturity[], config, principle, headline{…}, language{ok,problems}
```

Every option (`selected`, `line_shopping[]`, alternates, typed quotes) carries
side, team, line, book, source, origin (`LEDGER` / `USER` / `CONSENSUS` /
`HYPOTHETICAL`), alternate, quote_id, observed_at, age, freshness, and a price
normalised to American, decimal, payout, break-even and precision. It also
carries `probability{win,push,loss,cover}`, `fair_price`, `cushion`,
`break_even`, `raw_cover`, `raw_edge`, `raw_ev`, `market_probability{value,method}`,
`calibrated{…}`, `cover_used`, `cover_basis`, `decision_ev`, `buffered_ev`,
`ev`, `ev_threshold`, `edge`, `clears`, `threshold{edge_ok,ev_ok,text}`, `grade`
and `within_price_limit`.

## 5-27. Methodology

See [DESIGN.md](DESIGN.md), section by section:

| # | Topic | DESIGN.md |
|---|---|---|
| 5 | odds conversion (American / decimal / implied, source precision) | §2 |
| 6 | cover probability (the stored champion PMF curve, side orientation, signs) | §1, §3 |
| 7 | pushes (integer lines carry the PMF's mass; +7 ≠ +7.5) | §3 |
| 8 | EV (raw / decision / after buffer) | §4 |
| 9 | calibration (PENDING for the champion; the decision.js path when validated) | §5 |
| 10 | uncertainty (the policy edge floor + the calibration's 95% weight interval; gates) | §6 |
| 11 | main vs alt engine | §7 |
| 12 | price curve (offered at their own juice + a reference ladder) | §7, UI |
| 13 | key numbers (3, 7, 10, 14; game mass and FBS share) | §8 |
| 14 | best value (EV after the buffer, clearing, fresh, not thin) | §7 |
| 15 | bettable to (−110 equivalent line, worst price at the current line) | §9 |
| 16 | target price (by number, inside typical movement; by price, the standard −110) | §9 |
| 17 | price gone / mostly gone | §9 |
| 18 | BET EARLY (certified + market toward or key number at risk) | §10 |
| 19 | WAIT (named information or a named target, never "maybe") | §10 |
| 20 | PASS (every blocker listed in *why not bet*) | §10 |
| 21 | market movement (factual words, never "sharp") | §11 |
| 22 | edge decay | §11 |
| 23 | quote freshness + MARKET QUOTE CHECK | §11 |
| 24 | line shopping (EV at each book's own line and price) | §11 |
| 25 | selected-book support (one book, my books, best available, consensus) | §11 |
| 26 | manual price entry (USER QUOTE: never consensus, never certified) | UI §36 |
| 27 | AI integration | below |

**27. AI integration.**
- **"Ask this game"** (the research page) answers the brief's price questions
  from the stored read: *Would you take +6.5 or +7.5?*, *Is the extra juice worth
  it?*, *Should I bet this now?*, *Would you wait?*, *What's the worst number
  you'd take?*, *What price would make this a pass?*, *Which book has the best
  price?*, *Has the value disappeared?*, *Is this model edge or stale-book
  edge?*, *Why isn't this a bet?*
- Routing: `T.ask` sends price intents to `EDRead.ask` after the guard that
  answers UNKNOWN to sharp money, splits and handle. Each answer carries the
  deterministic facts it came from. The context is the open game, so nothing has
  to be restated.
- The AI never recomputes: `EDRead.ask` only names numbers the deterministic
  functions produced.
- The LLM boundary (`_cfb_explain.js`) now carries the read as facts: timing,
  decision, line, price, cover and its basis, break-even, EV, bettable-to,
  target. Its audit refuses an LLM text that calls the read certified, calls it a
  bet, or writes a number the facts don't hold, and replaces it with the
  deterministic text (tested).

## 28. Mobile UI

- **First viewport** (390 px): the read chip (WHAT), the best-value or current
  price with book and age (PRICE), fair / market / cushion / cover (VALUE),
  break-even / EV / bettable-to / price status. Then the timing sentence.
- **Behind one tap each:** Why · Risk · Market · Alternates · Price curve · Tools
  · Advanced.
- The grid is two columns and the book selector is full width. No horizontal
  scroll (measured: scrollWidth 390 = viewport). Screenshot:
  [`r_mobile_first_view.png`](demo/r_mobile_first_view.png).

## 29. Record integration

- **Frozen reads:** `football/cfb_terminal/read/2026/reads.jsonl`, append-only
  with deterministic ids. A snapshot is written only when a game's read changes,
  and it is immutable.
- **Grades:** `grades.jsonl`, graded once at the recorded number.
- **Postgame cards** (`#/record` and a past game's page) show **EDGEDESK READ AT
  THE TIME OF DECISION**. That is the last frozen read before kickoff, never a
  hindsight value, with its grade.
- **The "Read record" page** (`#/read`) lists every frozen read and its grade.
- The first 30 reads were frozen by this build; none is graded yet, because no
  game on this slate has kicked off.

## 30. Export integration

| Export | Contents |
|---|---|
| `football/cfb_terminal/read.csv` (every hourly build; Excel/API) | game, kickoff, teams, model version, generated_at, fair home line, market home line, side, book, line, price, cover (+ basis), break-even, EV, bettable-to, target, timing, decision, research status, price status, best value, alt verdict, calibration |
| `games.json` | the full read per game, and its inputs (the API artifact) |
| "Copy research card" | appends the EDGEDESK READ block (`EDRead.exportText`) |

The in-app Excel board (`app.html`) projects live in the browser and does not
read the terminal's objects. Adding the Read's columns there means touching the
app's 44-column export contract and its fixture tests, so it is listed as a
follow-up (§38) rather than half-done. The Collective ingests projections, not
price reads, so it is unchanged.

## 31. Validation dashboard

`#/read` and `read_validation.json`, from `EDRead.validation`:

| Read | Measures |
|---|---|
| BET EARLY | n, average CLV, +CLV rate, later-worse rate, average line preserved |
| BET | n, average CLV, +CLV rate |
| WAIT / PRICE TARGET | n, average price improvement after the wait, target-reached rate, wait success (close better than the wait price) |
| RESEARCH | n, CLV |
| PASS, PRICE GONE | counterfactual results, never wagers |
| Alternates | reads with alternates; each alternate graded at its own price |

Rates print only at n ≥ 30. Timing is validated by CLV, entry quality and
price movement on prospective reads, never by W-L (§57, §90).

## 32. Automated tests

`football/cfb_terminal/read.test.js`, **178 checks, all green**, in
`npm run cfb:terminal:test`, `npm test` and the terminal PR workflow:

1. **Odds math:** negative, positive and even money; decimal; implied %
   (53% ≈ −113, 64% ≈ −178, source precision kept); impossible prices refused.
   EV parity with decision.js and the terminal over 240 cases.
2. **Curve, signs and pushes:** side orientation, home/away complement, integer
   push, +7 vs +7.5, mirror symmetry, quarter lines refused, out-of-curve refused.
3. **No second calculation path:** cover, EV and break-even at every terminal
   quote match the terminal to 1e-4 (26 games). The stored curve reproduces the
   terminal's price curve at every half point.
4. **Case A (Minnesota):**
   - break-even 53.1% at −113, cushion +5.2;
   - the +7.5 −178 alternate has higher cover, yet costs +11 pp of break-even,
     so it reads TOO EXPENSIVE / PASS and is never best value;
   - key number 7 is flagged;
   - the calibrated variant also PASSes;
   - a cheap alternate *is* better value;
   - COMPARE returns "Minnesota +6.5 −113 OFFERS BETTER VALUE".
5. **Line shopping and views:** ranked by EV; a selected book, my books, the consensus.
6. **Consensus:** duplicate feeds merged, stale and outlier books excluded, the
   provider consensus is a reference only, a user quote is never included.
7. **Case B (Arkansas):**
   - a stored +16 against a fresh +13.5 raises MARKET QUOTE CHECK;
   - +13.5 is used and EV is recomputed;
   - +16 is never shown as current;
   - two current conflicting numbers read INVESTIGATE;
   - only-stale quotes read NO DECISION (STALE MARKET);
   - a typed quote against a stale capture names the stale side.
8. **Price gone:** initial +7, current +4, bettable-to +5.5 → PRICE GONE.
9. **WAIT:** a contested QB gives WAIT with the QB named; a target within typical
   movement gives PRICE TARGET with the target; the juice-only case gives a price
   target; a far target gives PASS. Every live WAIT names a reason or a target.
10. **INVESTIGATE:** a 12-pt unverified gap can never be BET EARLY, even with a
    governed BET, a validated calibration and betting on. DATA FAULT and MARKET
    FAULT also override. LIMITED DATA caps at RESEARCH. VERIFIED MAJOR is not a
    bet, and can be a PASS.
11. **BET / BET EARLY** (synthetic validated calibration):
    - a certified quote reads BET;
    - the market moving toward EdgeDesk, or +3.5 (key number at risk), reads BET EARLY;
    - a clearing price without the governed BET reads RESEARCH;
    - calibration pending never reads BET;
    - a user quote, a stale quote, a contested QB and the price limit each block BET.
12. **Fail closed:** no model, no curve, malformed odds, a line with no juice, no
    market, a quarter line, a line without a price, an unknown team.
13. **Market wording and structure:** movement reads TOWARD / AWAY / STABLE and
    is never "sharp"; model edge vs book edge; key numbers (3 yes, 4 no); price
    curve and frontier; a raw small gap claims no value; the no-live-price wording.
14. **Interactions:** what-if, the parser (−115, 53%, 1.91, PK, with a book), manual entry.
15. **Record:** snapshots frozen and immutable, deterministic ids, graded at the
    recorded line, WAIT grading, no rates under n = 30.
16. **The assistant:** the ten spec questions route to the Read; the sharp-money
    guard still wins.
17. **The real slate:**
    - every game has a read;
    - one fair line;
    - nothing actionable;
    - all reads are CALIBRATION PENDING;
    - INVESTIGATE is carried through;
    - language is clean;
    - the page recomputation equals the build byte for byte (60/60);
    - board, counts and read.csv are consistent;
    - totals and moneylines are not activated;
    - research-quality ranking holds;
    - the record is append-only.
18. **The page's boundaries:** no model; re-prices only through the Read; script
    order; the Read card first; no gimmick words; the reader's clock; never
    writes a BET.
19. **The alternates capture parser:** pairing, one-sided numbers, refusals,
    true age, dedupe. Alternates reach the Read, never the consensus.
20. **The explanation boundary:** read facts; the deterministic text passes;
    certified or bet claims are refused; an invented number is refused.

Existing suites re-run green:
- terminal 114, user test 20/20, decision 101, integrity gates 23;
- explain guard 52, presentation sync 31 pairs, canonical 124, production 118;
- final hardening 23, security 55, production UI 40, Model Lab 275 (+ its 14 other suites);
- research core 1,254, game research 186, AI 384 (+ the rest of `ai:test`).

The full `npm test` result is in the PR description.

## 33. Current-slate demonstrations

All of these are real production values: the champion slate, the Lab ledger
and the frozen policy, built at 21:35 UTC on Sept 27 (the artifacts at commit
`48ca6a7`; `git show 48ca6a7:football/cfb_terminal/games.json` reproduces them).
The hourly build regenerates the committed artifacts, so today's `games.json`
moves with the market and the game clock. Screenshots are in [`demo/`](demo/), rendered in headless
Chromium with the page clock pinned (`?asof=`).

| Case | Game | The Read |
|---|---|---|
| **1. Clean main-line value** | Arkansas @ Texas A&M | **RESEARCH ONLY.** EdgeDesk Texas A&M −11.1 vs market −14.5. Arkansas +14.5 −115: cover 57.6% raw vs break-even 53.5% (+4.1 pp), EV +7.7% raw. Bettable to Arkansas +12.5 −110 equivalent, or down to −130 at +14.5. Not certified: calibration pending ([png](demo/r_research.png)) |
| **2. Main vs alternate** | Michigan @ Minnesota (the brief's own case, live) | Minnesota +6.5 −110 (EdgeDesk Michigan −1.3, market −6.5, cushion +5.2). Typed alternate +7.5 −178: the extra point adds **+1.7 pp** of cover but raises break-even **+11.6 pp** (68 cents more juice). **PASS — protection costs too much.** KEY NUMBER CROSSED: 7 (1.7% of this game's PMF, 8.5% of FBS games). Screenshot of the same comparison on Arkansas +14.5/+15.5/+16.5: [png](demo/r_compare_alternates.png) |
| **3. BET EARLY** | **None exists on this slate, and none can.** | Every read is CALIBRATION PENDING and betting is disabled, so a certified quote does not exist. The fixture proves the rule: a certified −4.5 −110 with the market moved 1.5 pts toward EdgeDesk reads BET EARLY; at +3.5 the reason is that losing the hook crosses 3 (test §11). |
| **4. WAIT** | Baylor @ Arizona State | **WAIT (information pending).** Arizona State −3.5 −108 clears (+6.0 pp raw), but Baylor's quarterback job is contested (Lagway 55% / Bennett 37% of recent dropbacks) ([png](demo/r_wait.png)) |
| **4b. PRICE TARGET** | Akron @ Central Michigan | **WAIT FOR A NUMBER.** Central Michigan −6 −110 does not clear (−0.6 pp). −5 −110 or better would, 1.0 pt away, inside the 1.6-pt typical move. Not a forecast ([png](demo/r_price_target.png)) |
| **5. PRICE GONE** | Toledo @ Ball State | **PRICE GONE.** Toledo −17.5 −110 cleared (+2.0 pp); the market moved 2.0 pts toward EdgeDesk to −19.5 −112, which does not (−1.9 pp). Also a MARKET QUOTE CHECK: the app's V2 panel still showed +17.5 ([png](demo/r_price_gone.png)) |
| **6. INVESTIGATE** | California @ UNLV | **INVESTIGATE — MARKET FAULT.** A 7.7-pt gap that one book cannot verify. The raw 70.3% cover is shown greyed as "not priced until verified" ([png](demo/r_investigate.png)) |
| **7. Stale market** | Auburn @ Tennessee | **NO DECISION — STALE MARKET.** Every quote on file is older than 180 min: no price, no EV, "clears at Tennessee −6.5 −110 or better" for when a fresh quote arrives ([png](demo/r_stale_market.png)) |
| **8. Market-aligned PASS** | Alabama @ Mississippi State | **PASS.** EdgeDesk and the market are 1.6 pts apart. The raw cover at +6 −108 is not calibrated, so no value is claimed. MARKET MOVED 1.5 POINTS AWAY FROM EDGEDESK ([png](demo/r_pass_aligned.png)) |

Slate counts:

| Read | Games |
|---|---|
| RESEARCH | 26 |
| INVESTIGATE | 8 |
| PASS | 9 |
| WAIT | 1 |
| PRICE TARGET | 1 |
| PRICE GONE | 2 |
| NO DECISION | 13 (4 no market, 9 stale) |
| BET / BET EARLY | 0 |

Also: the queue with the Read filters ([png](demo/r_queue.png)), the Read record
([png](demo/r_read_record.png)), and mobile ([png](demo/r_mobile_first_view.png)).

## 34. Known limitations

1. **Calibration pending for the champion.** Every cover probability is raw. The
   only calibration evidence on file (V2.1's) shows raw cover probabilities are
   overconfident: 65% raw becomes about 54%. RESEARCH reads with a large raw EV
   (+24.6% on Minnesota) should be read with that in mind. The card, the
   maturity badges and every reason say so.
2. **The V1 PMF re-centres by an integer shift.**
   - `v1CoverConditioned` shifts a market-conditioned PMF to EdgeDesk's fair
     margin. When they differ by several points, the key-number spikes shift with
     it: Minnesota's PMF puts 1.7% on exactly 7, while 8.5% of FBS games end there.
   - That is the production distribution, and the Read does not alter it. It
     shows both numbers on every KEY NUMBER CROSSED line.
   - Fixing it belongs to the champion's model owners, not to this product layer.
3. **One priced book.** Consensus, line shopping, "my books" and the book
   selector work for any number of books, but the ledger holds DraftKings only.
   Books arrive when the Odds API pull into the Lab carries them.
4. **No alternates captured.** The fetcher exists but is not scheduled: that
   needs a GitHub secret and spends Odds API credits (§38). Until then,
   alternates come from the reader's own entries (Tools).
5. **What-if keeps the conditioning** on the current market, as the terminal's
   price curve does. A moved line is priced with today's distribution shape.
6. **The page clock:** the committed build is from Sept 27. A reader sees STALE
   MARKET until the hourly job refreshes quotes. That is intended fail-closed
   behaviour, not a bug.
7. **Timing thresholds are declared, not learned:** 0.5-pt move, key numbers,
   1.6-pt typical move. Each is an existing EdgeDesk constant, and each is
   labelled EXPERIMENTAL until the record validates it.

## 35. Maturity of each submodule

| Submodule | Status |
|---|---|
| Fair line | PRODUCTION (the champion, unchanged) |
| Odds normalisation, break-even, EV | PRODUCTION (decision.js; parity-tested) |
| Cover probability | RAW · CALIBRATION PENDING |
| Estimated EV | RESEARCH (raw) |
| Bettable to / target | EXPERIMENTAL |
| Timing (BET EARLY / WAIT) | EXPERIMENTAL (the policy's WAIT rule is disabled; tracked from this build) |
| Alternate value | SHADOW · NO ALTERNATES CAPTURED |
| Key numbers | EMPIRICAL |
| Consensus / quote freshness / quote check | PRODUCTION (integrity rules) |
| CLV tracking | PENDING (read snapshots frozen from this build) |
| Totals, team totals, moneyline | NOT ACTIVATED (pricing_cfb.json tier RESEARCH; moneyline shown as research) |
| Betting | DISABLED (cfb_decision_policy_v1) |

The card shows the four that matter most as badges. Advanced shows all of them.

## 36. UI

**The card** (first on every game page).
- **Top:** EDGEDESK READ, and a *Price from* selector (best available · market
  consensus · each captured book · my books).
- **Read chip and decision:** e.g. PRICE TARGET · Decision WAIT · Research
  WORTH RESEARCHING.
- **Price box:** best value / current price / best price for you, with book and age.
- **Eight cells:** EdgeDesk fair (projected score) · Market (books, stale) ·
  Model cushion · Cover (RAW tag, push and loss) · Break-even (at the exact
  price; source % flagged) · Est. EV (RAW tag, "research, not a decision
  number") · BETTABLE TO / NEEDS / CLEARS AT (the −110 line, and the price at
  the current line) · Price status (target).
- **Lines:** Timing · Market · Edge (model vs book) · Alt · Quote check.
- **Maturity badges.**
- **Sections:**
  - Why (why bet early / why wait / why not bet / why EdgeDesk differs);
  - Risk (what could make EdgeDesk wrong);
  - Market (movement, consensus method, line shopping, quote freshness);
  - Alternates (main / best value / best alt / safest, comparisons with key
    numbers, the frontier chart, the buying-points explainer);
  - Price curve (offered + reference ladder);
  - Tools (enter a price · compare lines · what if);
  - Advanced (model agreement and components, calibration, maturity, other
    markets, provenance, the raw read).

**Visual language:** research words only: BEST VALUE, BET EARLY, WAIT, PRICE
TARGET, PASS, PRICE GONE, INVESTIGATE. No LOCK, HAMMER, MAX BET or 🔥 (tested).

**Frontier chart:**
- x = the side's line; y = probability;
- the model's cover as a blue line and each offered price's break-even as an
  orange dot (palette validated for CVD on the dark surface);
- the −110 break-even dashed;
- FAIR / CURRENT / BETTABLE TO / TARGET markers;
- hover columns list every series. The table view is the price curve.

**The queue:**
- a Read filter row: best value, bet early, wait / price target, price gone,
  alt value, overpriced alternates, high model agreement, verified major,
  investigate, fresh market, cleanest price;
- a READ chip per game;
- a Read line in each row;
- a "Cleanest price first" sort that never ranks by raw gap.

## 37. Production readiness

**Ready to merge as a product layer.** The build is deterministic from committed
inputs and refuses to write when a rule breaks. The page runs no model and
fails closed on its own clock. The Read record is append-only. All suites are
green.

What it is **not**: a validated betting system. The Read is technically
production-ready while timing and EV labels remain experimental, and every
surface says so.

## 38. Remaining bugs and blockers

1. **Calibration for the champion.** A governance decision: promote V2.1, or
   calibrate V1 walk-forward. Until then no read can be certified.
2. **Alternate capture is not scheduled.** To turn it on:
   - add an `ODDS_API_KEY` GitHub secret;
   - add it to the allowlist in `tools/games/builder.test.js`;
   - add this step to `.github/workflows/cfb-lab.yml` before "Research terminal":
     ```yaml
     - name: Alternate spreads for the EdgeDesk Read
       if: ${{ steps.gate.outputs.proceed == 'true' && vars.READ_ALT_CAPTURE == 'on' }}
       env: { ODDS_API_KEY: ${{ secrets.ODDS_API_KEY }} }
       run: node football/cfb_terminal/alternates.js --network || echo "::warning::alternates not captured"
     ```
   - It costs about 1 credit per event per run (≤ 12 events, at most every 3 h).
3. **More books** in the Lab ledger (the Odds API pull) so consensus and line
   shopping have more than DraftKings.
4. **app.html Excel export columns** for the Read (the app board reads the
   terminal's `board.json`, which now carries `read`).
5. **The deployed AI desk** (`index.ts`, PART 2) still does not route CFB game
   questions through `T.ask` / `_cfb_explain`. That is the same gap the terminal
   deliverable listed. The boundary and the facts are ready.
6. **A Postgres mirror** of the read record, if the team wants SQL views over it.
7. **A study with real bettors.** The answerability of the brief's questions is
   tested structurally, not with people.
