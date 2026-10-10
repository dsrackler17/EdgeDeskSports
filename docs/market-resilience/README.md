# Market resilience and the independent research engine

EdgeDesk is a research terminal. Its football work (the projection, the
matchup, the explanation, the uncertainty) is built from EdgeDesk's own models
and never needs a sportsbook. This change makes that true on every surface it
touches:

- **Research never depends on a market.** The research page stays complete
  when the odds provider is down, the quota is exhausted, a quote is stale, or
  a quote fails an integrity check.
- **Market data is labelled honestly.** It is never fabricated, never shown as
  live when it is old, and never promoted into a betting edge when it is
  unverified.

The rule, in one line: **market data makes EdgeDesk more informative when it
exists; its absence removes the comparison and nothing else.**

Date: 2026-10-10. Branch: `claude/gracious-faraday-w30xnc`.

---

## 1. Diagnosis: why missing market data restricted research

Measured on the committed build of 2026-10-10 14:07 UTC (108 upcoming games):

| | Before | After |
|---|---|---|
| Market: fresh / stale / none | 16 / **48** / 44 | LIVE 62 / CACHED 2 / UNAVAILABLE 44 (all 44 look-ahead weeks with no quote yet) |
| Canonical research status | **NO_MARKET 92** (48 shown as STALE MARKET), INVESTIGATE 7, ALIGNED 6, RESEARCH 3 | NO_MARKET 46 (2 stale), INVESTIGATE 27, ALIGNED 17, RESEARCH 16, MARKET_FAULT 1, NEAR PK 1 |
| Research visibility (new axis) | (no such answer) | **AVAILABLE 108 of 108** |
| Large gaps (7+ pts) | 7 of 8 read **STALE MARKET**, research interest **10**, `rankable: false` | 8 of 8 **INVESTIGATE**, model-only research priority 52–82 |

The failure points, in order of impact:

1. **False staleness. This was the biggest cause.**
   - The Model Lab writes an unchanged line again as a *heartbeat* (every 6 h,
     every 50 min near kickoff) to say "the book still deals this".
   - `football/cfb_terminal/build.js` `loadLedger` dropped every heartbeat. A
     quote's age was therefore the time since its last *change*.
   - Example: UCF @ Oklahoma State's DraftKings −10.5 was re-confirmed at 14:07:27
     and read as **4,199 minutes old** in the 14:07:37 build.
   - 48 of 108 games went STALE. Each one became NO_MARKET, unrankable, research
     interest ≤10, and NO DECISION.
   - The 2026-09-30 board audit (`docs/cfb-board-integrity/AUDIT.md` §3) found
     this and proposed "heartbeats count", but it was never implemented.
2. **One label answered three questions.** `lib/edgedesk_canon.js`
   `researchStatus` mixed up "is this worth researching", "can the quote be
   trusted" and "may the price be bet":
   - it returned NO_MARKET **before** it checked the 7+ gap or confidence;
   - it set `rankable: false` for stale, orientation and market-fault cases;
   - `lib/cfb_terminal.js` `fields` capped research interest at 10 for NO_MARKET,
     and the queue sorts by research interest.

   So a stale 10.7-point gap sank to the bottom of the queue as "STALE MARKET".
3. **The 7+ integrity gate was skipped on a stale market.** `build.js` ran
   `DIS.evaluate` only with a fresh consensus, so large gaps stayed `NOT_RUN`.
4. **No market erased the explanation.** `T.summary` printed "No market to
   compare with." where the model's own drivers belonged. That text reached the
   board, the brief and the exports. *Fixed*: it now leads with the model's
   largest term.
5. **The fast board carried no projection.** `board.json` rows had no total,
   projected score or win probability, so a market-less row looked empty.
   *Fixed*.
6. **No vocabulary for degraded markets.** There was no CACHED / HISTORICAL /
   MANUAL state, no model-only research queue, and no research-only mode.
7. **Publication (not changed here; owner decision).** `lib/edgedesk_integrity.js`
   MKT.FAULT blocks a whole game, valid projection included, at every
   publication boundary. The content engine then withholds it from every
   article (`lib/content_engine.js` upcoming-games filter and `storyScore`). See
   §8.

---

## 2. The UCF @ Oklahoma State "market total 34.5", traced

**No committed artifact for this game has ever carried 34.5.** The search
covered about 65 files that mention game `401856824`, and git history was
searched with the pickaxe. Every committed market total is between 52.5 and
54.5:
- the Model Lab ledger (DraftKings via ESPN);
- the CFBD consensus;
- the article record;
- the public record.

The brief was built in the app from live `public.signals` rows. That data is
not in git, and this environment cannot reach the database, so **the exact row
is not confirmed**. The code path that produces exactly this symptom *is*
verified:

1. **Alternate ladders are stored as the main market.** Capture v10 buys
   `alternate_totals` inside 30 h of kickoff (the default) and files them under
   `totals` (`supabase/functions/capture/index.ts` `canonicalMarket`). Only
   `point_is_modal` tells the main line apart.
2. **The intelligence layer picked the longest shot.** Every row in a capture
   run shares one timestamp. `marketBoard.pickMarket` took "freshest, then
   **better price**", which on a ladder is the most extreme rung, e.g. an
   *Under 34.5 at +1000* beside a 53.5 main total. `resolveMarket.capturedFor`
   broke the same tie by array order.
3. **The app's board read truncated ladders from the bottom.** The signals
   fetch was ordered by `point asc` under a 5,000-row cap. Where the cap fell
   inside an event, the spread (−10.5, correct) and only the *lowest* total
   rungs survived. Totals rows also skipped the near-even-money filter that
   spreads get.
4. **The brief printed whatever total arrived** (`fbBriefGame`
   `total_market: fbRound1(mk.total_line)`), with no plausibility check.

Other explanations were ruled out with evidence:
- first-half and team totals are not captured or mapped;
- a cross-game join needs both teams and kickoff ±36 h;
- the lowest total in the week's ledger is 39.25 (Texas–Oklahoma);
- there is no spread/total swap;
- the model totals are 50.5–51.8.

**Fixed:**
- `pickMarket` and `capturedFor` prefer the modal row, then the price nearest
  even money (`supabase/functions/edgedesk_ai/_intelligence.js`, synced into
  `app.html` and `edgedesk_ai/index.ts` by `tools/presentation/inline.js`);
- the app fetch orders modal rows first;
- totals rows carry their price, so the near-even filter applies;
- the brief holds any total outside 25–100, or more than 15 points from
  EdgeDesk's total, as "Unavailable — held for verification", with the reason
  (`fbTotalCheck`, rendered by `_presentation.js`);
- the new market-state layer refuses team, period, alternate and prop markets
  by name, excludes a cross-book outlier, holds a lone total far from the
  model, and withholds two totals that contradict each other.

**To confirm against production** (read-only):

```sql
select selection, point, n_books, point_is_modal, modal_point, best_book, best_dec, last_seen_at
  from signals where sport_key = 'americanfootball_ncaaf'
   and home_team ilike 'Oklahoma State%' and away_team ilike 'UCF%' and market = 'totals'
 order by selection, point;
```

Expect Over/Under 34.5 rows beside a modal main line around 53.5. Also read
that game's `publisher_briefs` row (`research.market.total_market`).

The spread in the same brief (EdgeDesk −4.6 vs −10.5) is a **real**
disagreement, not a data fault. It is now labelled INVESTIGATE (§4).

---

## 3. Architecture: two engines

```
 committed artifacts ──► INDEPENDENT RESEARCH ENGINE ──► sections 1–4 (never read a market)
                          lib/edgedesk_research_engine.js
 captured quotes ──────► MARKET STATE + INTEGRITY ─────► section 5 (only what the state supports)
 (ledger, manual)         lib/edgedesk_market_state.js
                                     └──────────────────► three axes + section 6 (research verdict)
```

### Market-data states (`lib/edgedesk_market_state.js`)

| State | Meaning | What it may feed |
|---|---|---|
| **LIVE** | Checked quote, confirmed inside 180 min (heartbeats count) | Spread/total difference, no-vig, break-even; EV only where the decision engine validates it; betting validation |
| **CACHED** | Last capture for the current market, ≤72 h old, with source and time | Spread/total difference **as research context, labelled cached**. No prices, no EV, no betting |
| **HISTORICAL** | Older captures, or the game has kicked off | Line-movement context only; no comparison |
| **MANUAL** | Typed in by the owner (`tools/football/manual_market.js`), with who and when | Comparison as research context, labelled manual; never verified, never betting |
| **UNAVAILABLE** | Nothing trustworthy | Nothing; every value reads "Unavailable — reason" |
| **FAULT** | Captured data failed a check | Nothing; the failure is listed in the audit, never compared |

**Integrity checks, per quote:**
- the market key (only full-game main lines; alternates, halves, quarters,
  team totals and props are refused by name);
- game id, season, kickoff (±36 h), and home/away (a swap is a fault, never
  re-signed);
- spread and total ranges, and total/spread confusion;
- American odds format (decimal odds read as American are refused) and
  two-way price arithmetic;
- future timestamps and post-kickoff captures.

**Across books:**
- outliers against the median of all books;
- opposite favourites;
- a two-source contradiction (the market is withheld);
- dispersion (UNVERIFIED);
- a lone total more than 15 points from EdgeDesk's total (held);
- duplicate snapshots (merged).

### The three axes (`lib/edgedesk_research_engine.js`)

- **Research visibility.** AVAILABLE / LIMITED / UNAVAILABLE. Decided by the
  projection and football data only. Tests prove it never reads the market.
- **Market integrity.** VERIFIED (LIVE, at least 2 independent fresh books,
  every check passed) / UNVERIFIED / FAULT / UNAVAILABLE.
- **Betting validation.** ELIGIBLE / BLOCKED, with every blocker named. ELIGIBLE
  means only that the decision engine may evaluate the exact price; it never
  says bet. With betting disabled by the frozen policy, today it is BLOCKED
  everywhere.

### Disagreements and the research verdict

The disagreement is measured against the comparison market (LIVE, CACHED or
MANUAL), using the gap the reader sees (`lib/edgedesk_calc.js`).

| Condition | Label |
|---|---|
| 7+ points, unless LIVE + verified + the integrity gate passed + no regime change | **INVESTIGATE** |
| 2–7 points with a regime change | **INVESTIGATE** |
| 2–7 points otherwise | RESEARCH |
| Under 2 points | ALIGNED |

Nothing is hidden and nothing is promoted. Verdict headlines:
- `RESEARCH AVAILABLE — MARKET OFFLINE` (provider down) or
  `RESEARCH AVAILABLE — MARKET UNAVAILABLE` (no coverage);
- `RESEARCH AVAILABLE — MARKET FAULT`;
- `RESEARCH AVAILABLE — NO CURRENT MARKET`;
- `INVESTIGATE — 5.9-POINT DISAGREEMENT`;
- `RESEARCH — …`;
- `…MODEL AND MARKET ALIGNED`;
- `RESEARCH ONLY`.

UCF @ Oklahoma State, from the real build:

> **INVESTIGATE — 5.9-POINT DISAGREEMENT.** EdgeDesk projects Oklahoma State -4.6
> against a market of -10.5. Major roster turnover (Oklahoma State: new head
> coach; returning roster share at the 2nd percentile; returning production at
> the 1st percentile; transfers out at the 100th percentile) limits confidence
> in the discrepancy. The disagreement persists under all 15 supported
> alternatives and independent models (smallest remaining gap 4.9 pts). No
> validated betting edge has been established.

### Sensitivity panel (any disagreement of 4+ points)

Each row is labelled:
- **SUPPORTED**: a validated model component, applied as the model applies it;
- **HYPOTHETICAL**: outside what has been validated;
- **MODEL**: one of EdgeDesk's other models.

No row changes the official fair line.

- **Current-season emphasis.**
  - The engine's own blend is `w·carried + (1−w)·this_season`
    (`football/cfb_p4/engine.js blendedRating`). It is re-weighted from the
    slate's published `rating_detail` inside the learned prior-weight curve
    (floor 60%): SUPPORTED, and checked to reconstruct the engine's rating term.
  - "This season only" (w = 0): HYPOTHETICAL.
  - UCF: 80% of the rating is carried from prior seasons (carried −0.6 vs this
    season −5.7). Leaning fully on this season narrows the gap to 2.4
    (hypothetical); the validated floor narrows it to 5.0.
- **Roster adjustment.** The regime curve's effect, shown by removing it
  (SUPPORTED). The explainer's turnover share at the close's historical
  discount (HYPOTHETICAL).
- **Availability.** The measured QB starter-change effect (SUPPORTED). Variance-
  only rows (wind, OL) are listed separately.
- **Uncertainty range.** The 80% range, σ, typical miss, and where the market's
  number sits in EdgeDesk's distribution.
- **Persistence.** PERSISTS or SENSITIVE under every SUPPORTED and MODEL
  alternative, with the hypothetical rows reported separately.
- **What would need to change** to reconcile the two numbers (the terminal's
  reconcile rows).

### Model-only research priority

The score is 0–100, built from:
- projection uncertainty (the market-free version);
- position-group mismatch;
- unusual power-rating divergence;
- roster turnover;
- injury and availability uncertainty;
- model stability;
- game script;
- research relevance.

It reads no sportsbook number, and its note says it is not a ranking of bets.
`board.json → resilience.research_queue` holds the ordered list.

### RESEARCH ONLY mode

- **Page.** The header toggle, or `?mode=research`. The six sections and the
  football depth sections stay. The Read, the EV card, line shopping and
  player-prop prices are not drawn. Market values read "Unavailable —
  research-only mode". The queue ranks by research priority. The research
  brief export (Markdown) and the assistant keep working.
- **Build.** `node football/cfb_terminal/build.js --mode research-only`, or
  `EDGEDESK_MODE=RESEARCH_ONLY`.
- **Live requests.** `update public.odds_quota_config set mode = 'RESEARCH_ONLY';`
  denies every live odds request centrally (`research_only`). Capture returns
  `ok:true, skipped`.

### The page (`research/cfb/`)

Every game page now opens with the verdict and the six sections:

1. EdgeDesk Projection, with outcome bars;
2. Football Matchup Research: units, QBs and availability, continuity and
   coaching, schedule, game scripts, history;
3. Model Explanation: terms that sum to the margin, prior-season share,
   independent models;
4. Uncertainty and Limitations;
5. Market Comparison, with state, integrity and sensitivity;
6. Research Verdict, with the three axes and their blockers.

The existing sections A–H follow unchanged. New views: **Research priority**
(`#/priority`), **Export research brief**. The assistant answers market-state,
disagreement, sensitivity, total and verdict questions from stored data
(`EDResearchEngine.ask`), whether or not the provider is up.

---

## 4. Quota protection

### What the call map found

- A subscriber's AI question could trigger a **full, unscoped capture run**:
  - `edgedesk_ai refreshQuotes` called capture with no tier;
  - capture ignored `sport=`;
  - the throttle was in memory, per isolate.
- Capture game lines and alternate ladders had **no quota floor, no credit cap,
  no 429/401 stop and no breaker**. A 429 did not stop the next sport.
- Overlapping schedules re-bought the same boards minutes apart:
  - pg_cron near ×6/h and day ×2/h;
  - GitHub day ×1/h;
  - board on both systems.

  There was no run lock and no last-run check.
- `capture.yml` posted with `curl --retry 2`. A gateway timeout after capture
  had already spent could bill up to three full runs per tick.
- `close` had **no timeout**, discarded the quota header and re-bought boards.
- `alternates.js` and the props factory had no timeouts. The factory swallowed
  non-401/429 errors silently, at the historical 10× price.
- `props/capture.js` retried a billed call on timeout. A timed-out request may
  already have been charged.

### What changed

| Layer | Change |
|---|---|
| **Central ledger** `supabase/odds_quota.sql` | One atomic `odds_quota_acquire()` before a run: mode, breaker (429 → exponential back-off + HALF_OPEN probe; 401 → 6 h; 3 failures → 30 min), exhaustion hold until the monthly reset, **in-flight coalescing**, **cache-first minimum interval per key**, **daily and monthly limits with a reserve for critical work**, and a provider-balance floor. `odds_quota_settle()` records the provider's own `x-requests-*` numbers. The ledger is append-only, every denial is logged with its reason, and `odds_quota_daily` reports the credits not spent. |
| **capture** | Asks the ledger once per run: key `capture:<tier>`; near = critical, day = normal, board = low; reader refresh = low on the near key. A denial returns `ok:true, skipped` (no retry). In-run guard: credit cap `CAPTURE_MAX_CREDITS_PER_RUN` (1200), balance floor `CAPTURE_MIN_QUOTA_REMAINING` (1000), stop on the first 429/401/exhausted quota or 3 consecutive timeouts (`CAPTURE_BREAKER_FAILURES`), before any further sport, ladder or prop request. `?diag=1` buys no ladders. Settles with the real spend. Fails open (in-run guard only) when the SQL is not applied. |
| **close** | 20 s timeout. Keeps the quota headers. Stops on the first 429/401/exhausted quota: the remaining sports take the existing provider-down path (a started game closes from its last tick, an upcoming one defers; nothing is written off). Asks the ledger at critical priority with a 4-minute interval. |
| **edgedesk_ai** | A reader-triggered refresh asks for the scoped near tier and shares its ledger key. A refresh right after a scheduled run is answered `cache_fresh`, one already running is `coalesced`, and it never spends the reserve. |
| **capture.yml** | `--retry` removed from the billed POST. |
| **Node jobs** | Timeouts on `alternates.js` and the props factory. The factory counts and names its errors and stops after 3 in a row. `props/capture.js` keeps its single bounded retry on timeout: it is a pinned design (`tools/props/props_freshness.test.js` case 8), so it is left as an open decision (§8). |
| **Research page** | Never fetches odds, and no timer polls (tested). |

Defaults in `odds_quota_config`: daily 2,500, monthly 60,000, reserve 500,
floor 1,000 (critical 100). **Set these to your plan** (see §6).

### Not covered yet

- `collective_odds_ingest` (OddsBlaze is its default provider, and OddsBlaze
  sends no quota headers).
- The GitHub jobs `props/capture.js` and `alternates.js`. Each keeps its own
  floor and cadence, and neither calls the ledger yet.
- Deployed-only functions whose source is not in the repo (`odds`,
  `capture_boards`, `cfb_close`, `wta_odds` and others).
- The `close` and `collective_odds_ingest` pg_cron schedules, which are not in
  the repo.

---

## 5. Audit and history

- `football/cfb_terminal/history/<season>/research_snapshots.jsonl`
  (**append-only**, one row per change). Each row holds:
  - the projection, model version, published time and input version;
  - the market state, sources, capture time, spread/total, verification,
    integrity failures and held quotes;
  - the three axes, the disagreement, the verdict and the research priority.

  The id is a hash of the content.
- `supabase/research_snapshots.sql` mirrors it, with these rules:
  - append-only for every role;
  - pregame only;
  - a betting-eligible row needs LIVE + verified;
  - a FAULT carries no market number.

  It is synced hourly by `football/cfb_terminal/research_sync.js` in the Model
  Lab job.
- What EdgeDesk said at the time is never rewritten. A rebuild appends a row.
  Grading reads the rows as written.
- Manual entries: `football/markets/manual/cfb_<season>.jsonl`, append-only. A
  withdrawal is appended, never edited.

---

## 6. Deployment (nothing here has been applied to production)

The steps are independent and can be applied in any order. Each is reversible.

1. **Merge the branch.**
   - GitHub Pages serves the research page and `lib/` right away.
   - The next hourly Model Lab run rebuilds the terminal artifacts with the
     heartbeat rule and the resilience layer, and starts the snapshot ledger.
   - Effect: more games read LIVE.
   - The bettor decision layer evaluates more games: on today's slate it moves
     from WATCH 1 / PASS 15 / NO DECISION 92 to WATCH 10 / PASS 52 / NO DECISION
     46. **BET 0 either way**, and betting stays disabled by the frozen policy.
   - Revert just the heartbeat rule: set `TERMINAL_HEARTBEATS_CONFIRM=0` in the
     `cfb-lab.yml` terminal step.
2. **Apply `supabase/odds_quota.sql`** (SQL editor; the report rows must all
   read `ok`). Then set your plan:

   ```sql
   update public.odds_quota_config set daily_limit = 2500, monthly_limit = 60000,
     reserve_credits = 500, min_remaining = 1000, updated_by = 'owner';
   select public.odds_quota_status();
   ```

   - Effect: callers start asking the ledger. Until step 3 nothing calls it.
   - Rollback: `supabase/odds_quota_rollback.sql`. Callers fall back to their
     in-run guards.
3. **Redeploy the Edge Functions** `capture`, `close` and `edgedesk_ai`, e.g.
   `supabase functions deploy capture close edgedesk_ai`.
   - Effect: runs start being metered. Overlapping schedules collapse to
     `cache_fresh`/`coalesced`, and a 429 or exhausted quota stops the run.
   - Optional env: `CAPTURE_MAX_CREDITS_PER_RUN`, `CAPTURE_MIN_QUOTA_REMAINING`,
     `CAPTURE_BREAKER_FAILURES`, and `CAPTURE_QUOTA_LEDGER=false` to skip the
     ledger.
   - Rollback: redeploy the previous versions.
4. **Apply `supabase/research_snapshots.sql`.** The hourly sync then fills it.
   - Rollback: `supabase/research_snapshots_rollback.sql`. The committed ledger
     restores every row.
5. **Optional.**
   - Research-only operation: `update public.odds_quota_config set mode = 'RESEARCH_ONLY';`
   - Record a number by hand:
     `node tools/football/manual_market.js add --game <id> --spread <home line> [--total N]`,
     then rebuild.

---

## 7. Tests (all executed; results below)

| Suite | Result |
|---|---|
| `tools/resilience/resilience.test.js`: the 13 scenarios on real research objects, plus cross-scenario invariants (sections 1–4 byte-identical in every market state) | **112 passed** |
| `tools/resilience/quota_guard.test.js`: the deployed capture handler under a Deno shim (denials spend nothing; 429, floor, timeouts and exhaustion stop the run; refresh is cache-first; recovery; capture and close agree) | **47 passed** |
| `tools/resilience/odds_quota_sql.test.js`: real PostgreSQL 16 | **48 passed** |
| `tools/resilience/research_snapshots_sql.test.js`: real PostgreSQL, every game of the slate | **22 passed** |
| Existing: terminal 129, bettor 196/179/103, read 189, EV 241, quote EV 241, alternates 47, user test 20/20, capture 324 + 418 in six more suites, props 142/16, presentation 155/38/79/94/400 + sync 34, market join 64, board audit 15, regime 73, orientation 15, label parity 67, integrity 119, validation 88/81/83, Model Lab 1,310 across 15 suites, FBS, editorial 371+, the full `intel:test` (31 files) | all passing |

`tools/content/content.test.js` (28 failures), `tools/content/evidence.test.js`
(1) and `tools/editorial/features.test.js` **fail identically on the
unmodified base commit**. They concern NFL injury-report claims in the content
drafts and pre-date this change.

Run them: `npm run resilience:test`. CI: `.github/workflows/market-resilience-tests.yml`.

---

## 8. What remains unvalidated, and the owner's open decisions

- **The 34.5 root cause is unconfirmed in data.** The mechanism is verified in
  code and fixed on every reader I found; the production row is not. Run the
  query in §2.
- **Sensitivity scenarios are explanations, not prices.**
  - The current-season-emphasis row re-weights published components with the
    engine's formula; it does not re-run the engine. The regime shift and
    centring terms are held fixed.
  - The explainer's "turnover discount" is a descriptive fit (holdout R² 0.03)
    and is labelled HYPOTHETICAL.
- **The research-priority weights are a judgement**, not a fitted model. They
  rank what is worth opening; they have never been tested against anything.
- **Outcome bands and game-script probabilities** use a normal approximation
  with the game's σ, not the champion's empirical PMF.
- **Quota defaults** (2,500/day, 60,000/month, reserve 500, floor 1,000) are
  placeholders. Set them from your plan.
- **The heartbeat rule changes decision inputs.** It is correct by the audit's
  own reference rule, and the bettor layer now produces WATCH where it used to
  say NO DECISION (stale quote). Betting remains disabled; review before
  enabling.
- **Not changed (your call):**
  - MKT.FAULT still blocks a game's whole publication. A narrower rule would
    publish the research and withhold only the market comparison.
  - The app's Top Research Priorities (`lib/research_priority.js`) still
    excludes NO_MARKET/STALE games. The research terminal's model-only queue is
    the replacement there.
  - The canonical `research_status` vocabulary is unchanged, because ~15 suites
    and several surfaces read it. The new verdict sits beside it.
- **The props capture's retry on timeout.** `football/props/capture.js` retries
  a per-event request once on a timeout or an unreadable body. A timed-out
  request may already have been charged, so that retry can bill twice. The
  single bounded retry is a deliberate, tested design
  (`tools/props/props_freshness.test.js` case 8), so it is unchanged here.
  Retrying only connection failures and 5xx would remove the double-billing
  risk.
- **Freshness window.** Still 180 minutes. Heartbeats arrive every 6 h, so a
  steady line can still age into CACHED between heartbeats, and is labelled as
  such. The audit's open question about recording "the last sync that
  re-confirmed it" is unchanged.
