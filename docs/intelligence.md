# EdgeDesk Intelligence — the research and decision layer

This document records what was wrong, what changed, what was verified, and what
is still missing. It is written for whoever has to operate or extend this next.

---

## 0. The website never asked the question (2026-09-15)

Everything in sections 1 to 10 below is about the edge function. This section is
about the half of the product that reaches the reader first, and it is where the
reported failure actually lived.

### 0.1 What was reported

> "How does Texas State look this week?" produces `intent=unknown`,
> `baseball_mlb` retrieval, Texas → Texas Rangers aliasing, MLB pitcher and
> bullpen research, an unrelated Padres decision card, and a missing
> recommendation ledger error.

### 0.2 The root cause, in one paragraph

`EDAI.sendText()` in `app.html` had **no team or matchup resolution at all**. It
routed a question three ways — a daily-scan follow-up, a signal the reader had
opened, or "the board" — and a question naming a college team matched none of
them:

```js
var ctx = buildCtx();                       // null unless a signal is LOADED
if (!ctx || isBoardQuestion(t)) { await boardAnswer(t); return; }
```

`isBoardQuestion("How does Texas State look this week?")` is false, and with no
signal open `buildCtx()` is null — so the question fell to `boardAnswer()`.
`boardAnswer()` builds an **MLB-shaped board** (`mlb_starters`, `mlb_matchups`,
a `slate` of scored signals, which in September are baseball) and posts it with
`board_mode: true`. `boardScope()` returns `null` unless `FB.p4.up` is populated,
which only happens once the reader has opened the CFB tab, so the request
carried no football anywhere in it.

Every reported symptom is a consequence of that single routing decision:

| symptom | why |
|---|---|
| `intent=unknown` | nothing in the request said football |
| `baseball_mlb` retrieval | the MLB board was the only evidence sent |
| Texas → Texas Rangers | the only team list in scope was MLB clubs |
| pitcher and bullpen research | `mlb_starters` is what was sent |
| a Padres decision card | `board.slate[0]`; nothing scoped cards to a matchup |
| a ledger error in the answer | the write failed and its PostgREST body was rendered to the reader |

The server-side precedence fix merged as `r8` is correct and still stands, but it
could never have fixed this: it decides what the function does with a football
packet, and the browser was never sending one.

### 0.3 What changed

**One resolver, in the kernel, shared by both hosts.** `EDINTEL.resolveMatchup`
and `EDINTEL.teamPhrases` live in `supabase/functions/edgedesk_ai/_intelligence.js`
and are copied verbatim into both `index.ts` and `app.html` by
`tools/presentation/inline.js`. There is no second alias table: they resolve
through the same `resolveTeam` / `TEAM_ALIASES` the board joins its market with.
`resolveNamedMatchup` in the function is now a thin retrieval wrapper around the
shared call rather than a second implementation.

**The longest name wins.** `teamPhrases` tests every window of the question from
four words down to one and the longest hit takes its words outright, so
`Texas State` is found before `Texas`, and `North Texas vs Texas State` yields
both programs. Only exact, alias and `St.`/`State` expansions count — a loose
prefix match on a bare word is precisely how a college question lands on a
professional club. A single word only counts when the writer capitalised it, or
when nothing in the sentence is capitalised at all.

**Precedence, as the brief sets it out.** In `matchupRoute()`:

1. a matchup named in *this* question (both teams, or one team with exactly one
   game in the published window)
2. the subject the conversation already established
3. the board — and only for an explicit board question; a merely *carried*
   subject does not outrank `"who are today's worst starting pitchers?"`
4. otherwise the ordinary routes, unchanged

A board that happens to be open never wins. Naming somebody the FBS card does
not carry (`"what about the Padres?"`) returns `SUBJECT_CHANGED`, which clears
the football subject and hands the turn back rather than answering about a game
the reader has moved on from.

**The card does not wait for the model.** `matchupTurn()` renders in three
passes: the published artifacts first (slate, ratings, availability — all static
files the site already serves), then the market and completed-games reads under
the reader's own token, then narration. The card carries the opponent, kickoff,
venue, week, the model's projection with both conventions named, the market
state (executable quote with book and capture time, or consensus number, or a
declared absence), each side's rating, previous results, availability, every
missing field with a reason, and the model's own decision ceiling. If narration
fails the card stays exactly as it is, with one line saying the written read did
not come back and a button to ask for it again. **No lean is ever fabricated to
fill the gap.**

**Decision cards are scoped.** `decisionListHTML(research, scope)` filters to
the resolved `game_id`, falling back to a name match on *both* sides. A matchup
question can no longer render a card from another game, let alone another sport.

**"Against it" is two lists.** `"priced 20m ago — verify it is still live"` is a
step you take before betting, not an argument that the bet is wrong, and while
it sat in `reasonsAgainst` it could become the *watch line* — the one sentence a
reader takes away — of a perfectly sound call. Operational blockers now travel
in `checksRequired` / `checks_required` and render under **Confirm before
acting**. Opposing evidence stays where it was.

**The tracking failure is one sentence.** The reader sees
`Research available; tracking temporarily unavailable.` The status code, the
response body and the diagnosis stay in `?probe=1`'s `ledger_health` and the
function's own logs. And `ledgerDiagnosis()` classifies by **status**, not by
grepping the body for `"schema cache"` — a 404 is reported as *ambiguous between
a table that was never created and one outside PostgREST's exposed schemas*,
because reporting it as an unapplied migration sent somebody to re-run a
migration that was already applied.

### 0.4 The endpoint is a gate, not a door

The provider key has never been in the browser: it is an environment variable on
the edge function, and every database read runs under the caller's own token so
row-level security decides what they can see. **A Supabase JWT proves identity,
not entitlement**, and until now that was the only thing checked — any signed-up
account could spend provider tokens indefinitely.

- `subscriptionGate()` reads the caller's own `subscriptions` row under their own
  token and applies the same rule `app.html`'s paywall applies (`entitled()` ≡
  `pgEntitled`). A row that is present and not entitling is refused **402**. A
  table that cannot be read is an infrastructure fault, not a finding that
  somebody has not paid, so it does not lock anybody out.
- `rateVerdict()` is a per-isolate, per-caller counter — 30 a minute, 300 an
  hour, both configurable. It is honest about being per-isolate: it cannot stop a
  determined abuser spread across isolates, and it is not presented as if it
  could. What it stops is the ordinary runaway, which is what actually burns a
  budget.
- The browser's `resolved_matchup` is a **claim, not evidence**. The function
  looks the claimed `game_id` up in its own copy of the published card, checks
  the teams against that row, and drops the claim if they disagree. A browser may
  say *which game*; it may not say what is true about it. Every number the
  function reports or records is its own read.

**No new server runtime was added, and none is needed.** The Supabase Edge
Function already is the small authenticated server endpoint this calls for: it
holds the provider credential, authenticates the caller, and runs every
privileged read under that caller's token. What was missing was enforcement, not
infrastructure. A static page cannot hold an AI provider key — anything shipped
to the browser is public — so the function stays, and the work went into giving
it less to do: the deterministic research assembly now lives in the shared
kernel, where the browser runs it too.

### 0.5 How it is verified

`tools/intelligence/chat.e2e.js` loads `app.html` in Chromium, opens the chat
panel, **loads an MLB signal first** (the state the failure was reported in), and
types the question into the real textarea. Every assertion reads the DOM a
subscriber would be looking at; nothing calls an internal function to get its
answer. The reasoning function is answered three ways across the run — a normal
narration, a 500, and a decision card belonging to another game.

The subject is **not hardcoded**. The suite picks, from the real published card,
a program whose full name starts with another program's on the same card and
which plays exactly one game in the window. On today's card that is Texas State;
if the card changes it picks whatever team now has that shape and keeps testing
the rule rather than the team.

```
npm run intel:e2e          # 48 assertions, in a browser
```

It is non-vacuous: with `matchupRoute()` removed from `sendText()` and nothing
else changed, 30 of the 48 fail.

### 0.6 What could not be verified here, and why

The session this was built in has **no outbound network access**: the agent
proxy answers `403` to `CONNECT` for both `edgedesksports.com:443` and the
Supabase project host. So:

| check | state |
|---|---|
| `app.html` chat path, the exact question, in a real browser | **verified** — `npm run intel:e2e`, 48 assertions, against the real published artifacts |
| the shared kernel, the endpoint gates, the ledger diagnosis | **verified** — `npm run ai:test`, and the whole repo suite is green |
| the live site answering the question | **not verified** — no egress |
| the deployed function's build | **not verified** — `intel:doctor` reports `UNKNOWN`, `HTTP 403 from the probe`, which is the proxy refusing, not the function being absent |
| the production `recommendation_ledger` schema and migration state | **not verified** — the same block, plus no `SB_ANON` / `SB_SERVICE_ROLE` in this environment |

**The tracking repair is therefore half done and should be read that way.** The
reader-facing half is complete and tested: one sentence, no exception text, and
a diagnosis that refuses to call a 404 an unapplied migration. Applying the
migration and proving an authenticated write and read against production needs
a machine with direct network access and the project credentials:

```
SB_ANON=...  node tools/intelligence/deploy_doctor.js      # what is actually there
psql "$DATABASE_URL" -f supabase/recommendation_ledger.sql # idempotent
supabase functions deploy edgedesk_ai                      # r9
```

`app.html` and the artifacts ship on merge through GitHub Pages, so the browser
half of this change is live once the pull request merges. **The edge function is
not**, and nothing here should be read as saying the production endpoint is
running `r9` until `intel:doctor` says so from somewhere that can reach it.

---

## 1. Root causes

Six symptoms were reported. Four of them turned out to be the same structural
problem wearing different clothes, and two were labelling faults with a single
cause each.

### 1.1 "The FBS board displays 75 games, but Intelligence answers: there are no CFB matchups to evaluate on this slate."

**Two different game repositories, neither aware of the other.**

The FBS board is built entirely in the browser. `fbP4Load()` in `app.html`
fetches the cfbfastR schedule CSV, builds the universe and the slate through
`football/fbs/fbs.js`, projects every game with `football/cfb_p4/engine.js`,
and then joins market context onto it. The same build is published as
`football/fbs/slate.json` — 75 games, schema `edgedesk_fbs_slate_v1`, every one
of them `"market_status": "NOT JOINED IN THIS BUILD"` — which does NOT mean the
card has no market. It means the artifact is a schedule and the market is joined
at render time, as the artifact's own `market_note` says. Mistaking the second
for the first is the subject of the next four paragraphs.

Intelligence never saw any of it. `runResearch()` asked one question —
`getSlate()`, which reads the `signals` table — and `signals` holds **priced,
flagged opportunities**. It holds nothing at all for a sport nobody has flagged
this week. The empty result produced `unavailable("signals", "slate", "no
signals in the current window")`, and the answer turned that into "no games".

**And then a second, worse thing, which the first version of this document got
wrong.** It concluded from `"market_status": "NOT JOINED IN THIS BUILD"` that
the CFB card carries no captured quotes. It does. The artifact's own
`market_note` says the join happens live in the browser, and `fbP4Market()`
resolves a market from **two** sources: a captured `signals` row and the
ingested CollegeFootballData consensus in `cfb.lines`. A real Week 3 board
showed **75 scheduled, 46 with market quotes, 45 research-grade, 29 without**.

Intelligence read `signals` for college football and joined **zero** of them,
because it keyed both sides on a normalised display string. The odds capture
writes the BOOK's name — "North Texas Mean Green", "Miami (OH) RedHawks" — and
the college schedule writes the school alone — "North Texas", "Miami". Those
strings never match. `tools/newsletter/market.js` hit the identical failure and
recorded it in its own header: *"a live run read 410 college signal rows and
joined zero, and every refusal said `no_slate_game_with_both_teams`."*

Its fix was to resolve through the board's own `EDFbs` resolver, and that is the
fix here — through the same code rather than a second copy of it. `fbs.js` now
carries two marker blocks that `tools/presentation/inline.js` copies into
`_intelligence.js` and onward into `index.ts` and `app.html`, so one alias table
and one prefix rule serve the board, the newsletter and the desk.
`presentation_sync.test.js` fails on drift.

It was made worse by the slate scope, which was supposed to be the honest
denominator:

```ts
const slate_scope = cardScope ?? buildSlateScope(
  sportKey,
  games.map((g) => ({ game_date: etDay(0), status: "Scheduled", game: g })),
  games.map((g) => ({ game_date: etDay(0), status: "Scheduled", game: g })));
```

That builds the expected universe out of the rows that already came back — the
"counting retrieved rows against retrieved rows" failure the function's own
comments warn about, reintroduced one layer up. With nothing retrieved it
reported `expected_games: 0`, whose note is *"No games are carded for this date
— the schedule sync has not written this slate."* That sentence is the one that
reached the reader.

### 1.2 "Estimated edge vs Pinnacle de-vig fair" beside "No sharp reference quoted this selection"

**The label was chosen by which column was non-null.** `app.html`:

```js
var fairP = n(e.sharp_fair); var fairSrc = 'Pinnacle de-vig fair';
if (fairP == null) { fairP = n(e.consensus_fair); fairSrc = 'consensus fair'; }
```

`capture` writes `sharp_fair` from the **consensus** whenever no reference book
quotes — its own header says so, and it is why capture v9 added
`reference_type` and `sharp_book_fair` (null whenever there was no reference
book). So a row with `has_sharp = false` and a populated `sharp_fair` was
labelled "Pinnacle de-vig fair", while `reasonsAgainst` — reading `has_sharp`
correctly, twenty lines below — said "no sharp (Pinnacle) confirmation on this
exact side". One row, two contradictory claims, both from owned data.

The evidence to tell the difference had been in the table for a release. Nothing
read it.

### 1.3 "Top opportunities" containing quotes aged 446, 806 and 2,126 minutes

**No freshness condition anywhere in the ranking.** `scanSlate()` sorted by
research priority and took `games.slice(0, 3)`. The header even said "ranked by
research priority, not raw edge" — which is true, and is the bug: research
priority is not opportunity. The decision engine *did* know about staleness
(`STALE_MIN = 90`), but only to downgrade a single signal's verdict; nothing
stopped a stale row heading a section whose name promises something actionable.

### 1.4 "361 items, 130 withheld for size", inconsistent completeness, and a categorical absence claim

`budgetEvidence()` already refused to cut an item in half and already named what
it dropped — that part was sound. Two things were missing. The withheld note
named **items**, not **subjects**, so nothing established which games the model
had been shown *nothing* about. And three different numbers were all called
completeness: `integrity.headline` ("% of evidence delivered"),
`semantic.overall` (required-field coverage) and `completeness.pct` (sport
dimension availability). They are supposed to differ. Presented as one word,
they read as a contradiction.

### 1.5 "team_efficiency 0/176" and "Not available: games.team_efficiency"

Two lines, one cause: a field the sport does not have was being counted as a
field the sport was missing.

`SPORT_CAPABILITIES.americanfootball_ncaaf.team_efficiency` is `false` — there
is no free per-play CFB feed without a CollegeFootballData key, and the
capability matrix says so. But the per-entity coverage line ran unconditionally:

```ts
if (teamsInPlay.length) cov.push(coverage(ev0, "team_efficiency", teamsInPlay));
```

and `getTeamFeatures("americanfootball_ncaaf")` was called for CFB at all,
reading `public.games` — which `ingest_multisport` does not populate for college
football — and emitting `unavailable("games", "team_efficiency", …)`.

### 1.6 "Paraphrases signal metadata instead of analysing football matchups"

Because signal metadata was very nearly all there was. For a CFB game the packet
carried the signal row, SP+, a record and a poll rank. There were no previous
games, no opponent-strength context, no rest, no personnel, and no structure
telling the model how to read a matchup rather than recite one.

Underneath that sits the finding that governs the whole decision layer, and it
was already in the repository:

```
football/cfb_p4/params.js → validation_summary.market
  beats_closing_line: false
  max_tier: "RESEARCH_LEAN"
  ats_vs_close: 1pt 49.94% (n=2599, p=0.53) … 6pt 46.40% (n=722, p=0.976)
```

Against the closing line the model is **not better**, and it gets *worse* as its
disagreement with the market grows. `calibration.js` is blunter still: *"the
optimal margin blend puts zero weight on the raw model at every week and
disagreement bucket."* Nothing in the product enforced that. A large model-market
gap was free to read as a large edge.

---

## 2. What changed

### 2.1 A shared deterministic kernel — `supabase/functions/edgedesk_ai/_intelligence.js`

One file, inlined byte-for-byte into the edge function **and** `app.html` by
`tools/presentation/inline.js`, exactly as `_presentation.js` already was.
`presentation_sync.test.js` fails the moment a copy drifts.

`EDPRES` translates a decision that already exists. `EDINTEL` **owns** it:

| Area | What it owns |
|---|---|
| Odds | `ev()` with `EV = P(win)×(d−1) − P(loss)`, pushes returning the stake and contributing zero; `breakEvenProb`, `priceForEv`, `minPlayableDec`, `devigTwoWay` with its own stated limitation |
| Pushes | `pushProbability()` — zero on a half-point line, a real number from a registered empirical distribution, and **null with a reason** on a whole-number line with no distribution. Never a silent zero |
| Provenance | `fairMethod()` — the only place in the product that can produce the phrase "Pinnacle de-vig fair", and only from `reference_type` + `sharp_book_fair` |
| Confirmation | `confirmationRead()` — states in words that book count is not sharp confirmation |
| Freshness | `quoteState()` / `applyRefresh()` — a stale quote stays research, loses actionability, and a failed refresh withdraws actionability without deleting the price |
| Slate | `slateState()` — five distinct empties, each with the sentence the answer must use and the claim it may not make |
| Coverage | `coverageReport()` — required-field completeness, retrieval success and evidence delivered, as three named metrics with explicit denominators |
| Validation | `MODEL_VALIDATION` + `loadFootballValidation()` — transcribes the model's own record and decides whether it may produce a probability, an EV, or nothing |
| Decision | `decide()` — BET CANDIDATE / WATCH / PASS / INSUFFICIENT DATA through nine named gates |
| Ledger | `ledgerEntry()`, `ledgerUpdate()`, `measure()`, `validateNoLookahead()` |

**Every threshold is explicit and overridable** through `EDINTEL.configure()`:
`ev_floor` 0.005 (tracking the browser engine's `REAL_FLOOR` so the two halves
cannot disagree), `candidate_ev` 0.02, per-market `quote_ttl_min`,
`min_independent_families` 3, `disagreement_points` 3 / `_hard` 7,
`min_validation_n` 500, `max_validation_p` 0.05, `min_edge_remaining` 0.4.
None of them is asserted as a universal betting truth.

### 2.2 The model's own record now governs what it is allowed to become

`loadSnapshotValidation()` registers, per market:

| Market | Tier | Probability? | Model EV? | Cap |
|---|---|---|---|---|
| `h2h` | PROBABILITY (Brier 0.19016, n=3113, out-of-sample by the model's own firewall) | yes | yes, **experimental** | WATCH while `beats_closing_line` is false |
| `spreads` | RESEARCH (49.9% → 46.4% ATS as the gap grows; no band significant) | **no** | **no** | WATCH |
| `totals` | DIRECTIONAL (51.3% → 54.8%, p=0.0155 at 6+ points) | no | no | WATCH |

So a CFB spread disagreement can raise research priority and can trigger the
diagnostic checklist. It cannot produce an expected value and it cannot reach
BET CANDIDATE. A market-anchored price edge still can, because its evidence is
the market rather than the model.

The edge function cannot read the 573 KB `params.js`, so the record is
**transcribed** into the kernel and stamped with the model version it came from.
`intelligence.test.js` re-reads the real artifact and fails when the numbers stop
matching, so retraining the model fails CI until the snapshot is refreshed —
which is the correct order of events.

### 2.3 Staged retrieval and one authoritative game repository

**Stage A — `Dal.getSlateIndex()`.** Games are discovered from a **schedule**
before any question about prices is asked. For CFB the primary source is the
board's own published `football/fbs/slate.json` — same builder, same identities,
same game ids as the reader is looking at — cross-checked against `cfb.games`,
with a disagreement between the two reported as a data fault rather than
silently resolved. Quotes and signals are then joined *onto* that universe and
counted separately.

**Stage B — `rankSlate()`.** Deterministic eligibility and research priority over
the compact index, with model and market lines oriented onto the **same side**
first (`orientToSelection()`).

**Stage C — `getCfbGameEvidence()`.** Batched detail for the shortlist only, sized
against the remaining budget. Retrieval budgets were raised to match
(STANDARD 8 → 16, DEEP 14 → 22, SLATE 20 → 28) after a college question ran out
mid-stage-C and reported present data as missing.

**The decision pass — `decideSlate()`.** Deterministic, one row per quoted
selection, computed before the model is called.

### 2.4 Versioned evidence packets

One `edgedesk_game_evidence_v1` packet per researched matchup. Every factual
field is `{value, source, observed_at, known_at, …}` or `{missing: true,
reason}`. Previous games carry **the opponent's SP+ rating**, so a 45-14 win
reads differently against a −18.9 opponent than a 31-20 win against a −4.2 one.
Rest days are derived from the schedule. Turnovers, explosive plays, success
rate, pressure, red zone, pace, depth charts and injuries are declared missing
with the reason — the last of those explicitly noting that their absence is not
a clean injury sheet.

### 2.5 The recommendation ledger

`supabase/recommendation_ledger.sql`. The original row is written once and locked
by a trigger; a later change is a separate `kind='UPDATE'` row pointing back
through `supersedes`; grading is write-once; deletion is blocked; a `FORWARD` row
cannot postdate kickoff. `recommendation_record` counts forward and backtest as
separate rows and refuses to sum them, excludes pushes from the win rate while
including pushed stakes in the amount staked, and carries `sufficient_sample`.

### 2.6 In the app

`fairSrc` now comes from `EDINTEL.fairMethod`; `sharp` means *evidenced* rather
than *claimed*; `BOARD_ACTIVE_COLS` selects `reference_book` and
`sharp_book_fair` because those are the proof. "Top opportunities" is partitioned
on `quoteState().actionable`, with a "Stale price — research only" group
carrying each age. The board's active sport, season, week and filters travel with
every Intelligence call. The answer renders a scope line, a decision list grouped
by editorial attention tier, and expandable Previous games / Matchup / Personnel
/ Market history / Model drivers / Counterargument / Sources sections.

---

## 3. Tests and verification results

```
npm run ai:test
  presentation_sync         ALL GREEN   6 library/host pairs in sync
  presentation              ALL GREEN 155 passed, 0 failed
  public_language           ALL GREEN 400 passed, 0 failed
  edgedesk_ai               ALL GREEN  36 passed, 0 failed
  app_presentation          ALL GREEN  57 passed, 0 failed
  app_picture               ALL GREEN  94 passed, 0 failed
  intelligence              ALL GREEN 158 passed, 0 failed
  ledger_sql                ALL GREEN  33 passed, 0 failed
```

`tools/intelligence/intelligence.test.js` — every test is named after a failure
that was actually observed, and runs against the **real** published FBS slate and
the **real** model validation artifact:

| # | Covers |
|---|---|
| 1 | CFB schedule exists, signals query empty → `GAMES_NO_QUOTES`, real game count, the "no games" claim forbidden in the prompt |
| 2 | A schedule source that cannot be read → `RETRIEVAL_FAILED`, not zero |
| 3 | Home/away spread orientation, in the helper and through the pipeline; an unoriented comparison would have produced a LARGE phantom gap |
| 4 | Consensus anchor never labelled Pinnacle; a sharp anchor names its contributing quotes; a claimed-but-unevidenced anchor is flagged |
| 5 | 446 / 806 / 2,126-minute quotes stale and non-actionable; stale → WATCH, never BET CANDIDATE; a failed refresh keeps the price and withdraws actionability |
| 6 | Truncation preserves scope, names unseen subjects, forbids whole-slate claims, gates categorical absence on full delivery |
| 7 | `team_efficiency` not counted as a CFB gap; declared as an absent capability; packet marks it missing with a reason |
| 8 | EV with and without pushes; a push is not a loss; push probability unknown rather than zero on an integer line |
| 9 | CFB spread model produces no probability and no EV; moneyline is PROBABILITY but experimental; an unregistered sport gets nothing |
| 10 | Ledger preserves the original decision; an update is a separate row; pushes/voids handled correctly; backtests separated |
| 11 | Look-ahead guard in four shapes, plus the evidence-level cutoff |
| 12 | A follow-up re-reads the market; a moved price invalidates a cached analysis |
| 13 | The transcribed validation snapshot matches the live artifact field for field |
| 14–17 | End-to-end decision, packet substance, staged retrieval, board scope |

`tools/intelligence/ledger_sql.test.js` boots a throwaway PostgreSQL, applies the
migration twice, and then tries to do the things the table exists to prevent:
editing a decision, editing a price, editing a publication time, deleting a row,
re-grading a result, and inserting a forward row dated after kickoff. All six are
refused by the server.

**Full repository suite:** `npm test` passes except for one **pre-existing**
failure in `tools/newsletter/newsletter.test.js` (*"re-attaching the research
makes every figure traceable again — NFL-2026-W02"*). It fails identically on the
unmodified checkout; it is unrelated to Intelligence and was not touched.

### Live checks that remain unverified

This repository has no live Supabase, no Anthropic key and no network in CI, so
these were exercised against fixtures and **not** against production:

1. **The published slate over HTTP.** `getFbsSlateArtifact()` reads
   `https://edgedesksports.com/football/fbs/slate.json`. The parsing is verified
   against the real committed bytes; the fetch is not.
2. **The `cfb` schema.** Reads assume it is exposed under Supabase → API
   settings, like `ufc` and `wta`. `?probe=1` reports this; a failure produces a
   named unavailable item rather than a wrong answer.
3. **The ledger insert under RLS.** The trigger and the view are proved on a real
   server; the `auth.uid()` default and the anon/authenticated grants are not.
   `?probe=1 → ledger_health.last_ledger_write` reports the first real write.
4. **The model's prose.** Every deterministic object is verified. The wording the
   model produces from them is not — no API key. `tools/intelligence/answer.js`
   renders the answer from the deterministic objects alone, which is both the
   offline fallback and the example set in §5.
5. **`cfb.rankings` content.** Wired and fixture-tested; the real poll rows are
   whatever `cfb_ingest` last wrote.

---

## 4. Remaining data gaps

Declared in the capability matrix and in every evidence packet, not silently
absent:

| Gap | Consequence | What would close it |
|---|---|---|
| CFB per-play efficiency (EPA/play, success rate, explosive rate) | No true efficiency read; SP+ is the opponent-adjusted axis instead | `CFBD_API_KEY` + per-game ingest, or a play-by-play mirror |
| CFB injuries / depth charts | The largest unmodelled input in the sport | `football/availability/` exists in the repo and is **not** read by the edge function — the clearest next win |
| CFB turnovers, garbage time, red zone, pace | Recent results cannot be tested for distortion | Same ingest as above |
| NFL injury report | Only the quarterback carries a status | No source ingested |
| CBB availability | One absent starter moves a college number more than any efficiency gap | No source ingested |
| `cfb.returning_production`, `cfb.portal` | Strongest year-over-year college predictors | Extend `cfb_ingest`, or set `CFBD_API_KEY` |
| Book limits | Corroboration is book *count* only | Not in the Odds API |
| Measured betting volume | Attention tiers are editorial and say so | No source |
| Weather, server-side | The browser board fetches it; the function does not | Wire open-meteo into stage C |

**A correction.** An earlier version of this section said the CFB card carries
"no captured market quotes at all", reading that off
`"market_status": "NOT JOINED IN THIS BUILD"` in `slate.json`. That was wrong,
and the way it was wrong is the subject of §1.1: the artifact publishes a
schedule and says in its own `market_note` that the join happens live in the
browser, from **two** sources — captured `signals` rows and the
CollegeFootballData consensus in `cfb.lines`. Reading a zero out of a broken
join and reporting it as an absent market is the original bug wearing a
different hat.

**The honest headline gap, stated properly:** on a college card most games carry
a market NUMBER and very few carry an executable PRICE. A `cfb.lines` row is a
handicap and a total with no book, no per-side odds and no capture time — a
number to compare a model against, and nothing to bet into. Three counts
therefore travel together everywhere in this system, and conflating any two of
them is how a 46-market board was described as having one:

| count | what it means | what it permits |
|---|---|---|
| scheduled | games on the card, from a SCHEDULE source | ranking, discussion, research |
| carrying a market number | either source supplied a handicap or total | comparison against the model |
| carrying an executable price | a real book price, with a capture time | a priced recommendation, and only here |

No odds are ever mirrored from the other side of a handicap. A consensus
moneyline IS de-vigged — both sides are real numbers — and the result is still
not actionable, because the row carries no book and no timestamp.

---

## 5. Example answers

Produced by `node tools/intelligence/answer.js` — the implemented system, from
the implemented data, with no model call. Abridged.

**"Any CFB matchups look good?"**

```
SCOPE
7 CFB games scheduled in week 3; 1 carries a quote; 1 carries a flagged signal.
Any statement about the slate covers 7 games; any statement about PRICES covers 1.
  source: the FBS board's own published slate (cfbfastR-data schedules 2026)

LOWER PROFILE  (editorial attention category — EdgeDesk measures no betting handle,
so this says nothing about how softly the game is priced)

  BET CANDIDATE (clear) — North Texas @ Texas State
    North Texas -2.5 at -105 · DraftKings · quote current
    why: Expected return 3.74% per unit, clearing the 0.50% floor. A sharp reference
    (Pinnacle) is quoting this exact selection. 6 independent book families stand
    behind the fair price. Corroborated at 2 levels against the sharp reference.
    model estimate: -2.4 (validation tier RESEARCH) — contributes no expected value;
    the model has no validated outcome probability in this market
    probability edge 1.92 percentage points · expected return 3.74% per unit staked
    price limit: -112
    against it: A price worse than -112 takes the expected return below the floor.
```

**"Separate smaller-profile and big-attention games."**

```
THE CARD BY ATTENTION — every game, not only the priced ones.
  Regional interest (4)
    Syracuse @ Pittsburgh  — no book EdgeDesk captures is quoting this game
    Georgia @ Arkansas     — no book EdgeDesk captures is quoting this game
    …
  Lower profile (3)
    North Texas @ Texas State  — eligible
    Portland State @ Oregon    — no book EdgeDesk captures is quoting this game
    …
  These are EDITORIAL attention categories built from rankings, conference,
  television window and book coverage. EdgeDesk measures no betting handle and no
  book limits, so a lower-profile game is NOT claimed to be more softly priced.
```

**"Analyze North Texas versus Texas State."**

```
  North Texas @ Texas State   [packet 401858900:v1]
    North Texas — record 2-0 · SP+ 6.4 (off 31.2, def 24.8 — lower is better)
                · SOS -2.1 · rest 14d
        2026-09-06 away vs Western Michigan  31-20 W   (opponent SP+ -4.2)
        2026-08-30 home vs Nicholls          45-14 W   (opponent SP+ -18.9)
    Texas State — record 1-1 · SP+ 4.1 (off 29.8, def 25.7 — lower is better)
                · SOS 1.4 · rest 14d
        2026-09-06 away vs Washington State  21-24 L   (opponent SP+ 8.8)
        2026-08-29 home vs Eastern Michigan  38-17 W   (opponent SP+ -7.7)
    SP+ gap (home minus away): -2.3 — a difference of two EXTERNAL model ratings,
    not a spread and not an edge.
    NOT AVAILABLE for this sport, and their absence is not evidence they do not
    matter: per_play_efficiency, explosive_play_rate, success_rate,
    pressure_and_sacks, turnover_margin, red_zone, injuries, depth_chart
```

**"What price makes it a pass?"**

```
  BET CANDIDATE (clear) — North Texas @ Texas State
    North Texas -2.5 at -105 · DraftKings · quote current
    price limit: -112
    against it: A price worse than -112 takes the expected return below the floor
    and ends this.
    not examined: matchup_evidence — this game was not researched in depth on this
    turn. The thesis rests on the market price, which is complete without it — but
    the matchup was not examined and the answer should say so.
```

**"Why should I trust this recommendation?"** returns the same decision with its
full gate record: the fair price is a de-vig of Pinnacle's own two-way quote
(−114 / +102, both listed), six independent book families stand behind it, the
quote is 14 minutes old against a 90-minute limit, the model contributes nothing
because its own walk-forward record does not beat the close in this market, and
the whole thing ends at −112. The honest answer to "why trust it" is that the
trust is in the market anchor, not in EdgeDesk's model.

---

## 6. Migrations, configuration and rollback

### Migration

One, and it is additive:

```sql
-- Supabase SQL editor. Safe to run again.
\i supabase/recommendation_ledger.sql
```

Creates `public.recommendation_ledger`, two triggers, RLS policies and the
`public.recommendation_record` view. Nothing existing is altered. Without it the
POST fails, the failure is swallowed like every other memory write, and answers
are unaffected — only the measurement layer is absent.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EDGEDESK_SITE_BASE` | `https://edgedesksports.com` | Where the published FBS slate is read from. Point a preview deployment at its own origin |
| `EDGEDESK_REAL_FLOOR` | `0.005` | EV floor; must track the browser engine's `REAL_FLOOR` |
| `EDGEDESK_EDGE_MAX_AGE_MIN` | `90` | Quote freshness limit |
| `EDGEDESK_EVIDENCE_MAX` | `240000` | Evidence characters per message; now read per call rather than once at module load |
| `CFBD_API_KEY` | unset | Enables the returning-production and portal adapters |

The `cfb` schema must be exposed under **Supabase → API settings** (alongside
`ufc` and `wta`). `GET ?probe=1` reports every one of these, plus
`ledger_health` and `sport_modules`.

### Deploy

1. Run the migration.
2. Deploy `supabase/functions/edgedesk_ai/index.ts` (single-file build; the
   kernel is already inlined).
3. Publish `app.html`.
4. `GET …/edgedesk_ai?probe=1` → expect `build` ending `r5-presentation`,
   `presentation.library_loaded: true`, and `sport_modules` listing CFB.
5. `POST …/edgedesk_ai?dry=1` with a CFB question → expect
   `slate_state.state` ≠ `RETRIEVAL_FAILED` and a non-zero `scheduled_games`.

### Rollback

Every layer is independently reversible and none of it is load-bearing for the
existing contract.

| To undo | Do this |
|---|---|
| Everything | `git revert` the commit. `_intelligence.js`, `tools/intelligence/` and the migration are new files; the edits to `index.ts` and `app.html` are additive |
| The function only | Redeploy the previous `index.ts`. The client tolerates a response with no `decisions` / `evidence_packets` — those fields render nothing when absent |
| The client only | Republish the previous `app.html`. The function's additive fields are simply ignored |
| The ledger | `drop view public.recommendation_record; drop table public.recommendation_ledger cascade;` Answers are unaffected; only measurement stops |
| The kernel, in place | `EDGEDESK_DECISIONS_ENABLED=0` on the deployment (or `EDINTEL.configure({ decisions_enabled: false })`) stops the desk producing recommendations while retrieval, research and the evidence packets carry on unchanged. `decide()` returns `decision: null` with `decision_state: 'DECISIONS DISABLED'`, the ledger refuses the row, and the answer says the layer is off. The earlier advice here was `configure({ ev_floor: 1 })`; that is a threshold pressed into service as a control and it is withdrawn — it reaches a verdict through one branch conditioned on an expected value existing, it produces PASS (a judgement about a bet nobody weighed), and it writes a floor of 1 into the ledger's `config_used` |

**Not reversible from the app:** `recommendation_ledger` rows. That is the
point — deletion is blocked by a trigger, and dropping the table is a deliberate
database action.

---

## 10. Merged is not deployed

Nothing in this repository deploys an edge function or applies a migration.
Every function carries a manual `supabase functions deploy <name>` in its header
and every `.sql` file is applied by hand, so a green CI run and a merged pull
request say exactly nothing about what is answering at the other end. Only
`app.html` and the committed artifacts ship automatically, through GitHub Pages
on `main`.

| piece | how it ships | how to check |
|---|---|---|
| `app.html`, `football/fbs/slate.json`, `football/availability/current.json` | GitHub Pages, on merge to `main` | the `pages build and deployment` run for the merge commit |
| `supabase/functions/edgedesk_ai` | **manual** — `supabase functions deploy edgedesk_ai` | `GET /functions/v1/edgedesk_ai?probe=1` → `build` |
| `supabase/recommendation_ledger.sql` | **manual** — `psql "$DATABASE_URL" -f supabase/recommendation_ledger.sql` (idempotent) | `GET /rest/v1/recommendation_ledger?select=entry_key&limit=1` |

`npm run intel:doctor` asks all of that and reports each answer as a fact:

```
node tools/intelligence/deploy_doctor.js
```

It needs no new credential — `SB_URL` and `SB_SERVICE_ROLE` are the secrets the
newsletter workflow already holds, and the anon key alone answers everything
except the ledger question. Nothing is written, nothing is deployed, and no
secret value is printed: credential presence is reported as a boolean, exactly
as the function's own probe does.

`.github/workflows/intelligence-doctor.yml` runs it daily and fails the job when
something needs deploying, so "is the thing I merged the thing that is running"
has a standing answer rather than an assumption.

The distinctions it is careful about are the ones that look identical from
outside and send an operator to do the wrong thing:

- **deployed but stale** is not **not deployed** — both builds are named
- a **missing table** is not **a table row-level security refused** — a 401 is
  the table being there
- an **absent artifact** is not **a proxy answering 403 on its behalf** — only
  404 is missing; everything else is UNKNOWN and says so
- an **unreachable project** never reports anything as not deployed

### Switching the decision layer off

`EDGEDESK_DECISIONS_ENABLED=0` on the deployment stops EdgeDesk producing
recommendations while retrieval, research and the evidence packets carry on
unchanged. `decide()` returns `decision: null` with
`decision_state: "DECISIONS DISABLED"`, the ledger refuses the row, and the
answer says the layer is off rather than returning PASS — which would be a
verdict about a bet nobody weighed.
