# edgedesk_ai — audit, priority plan, implementation

BUILD shipped: `edgedesk_ai-2026-08-12-r1-entity-slate`
Source of truth: `supabase/functions/edgedesk_ai/index.ts` (4,420 lines, single file, zero imports)
Tests: `supabase/functions/edgedesk_ai/suite.ts` — 44 assertions, run under Node with a `Deno` shim
and a mocked PostgREST, against the real function.

---

## AUDIT

### What already works — and is better than the notes suggest

This is a serious research engine, not a prompt wrapper. Verified in executable code:

- **Evidence provenance is real.** Every retrieval returns `Evidence[]` with `{source, entity, field,
  value, status, freshness, source_timestamp}`, and a failed read produces an `UNAVAILABLE` item
  naming the table and the error. `ev()` demotes `VERIFIED` to `STALE`/`HISTORICAL` centrally
  (line 647) rather than trusting call sites.
- **The integrity audit is genuine and it gates the model.** Eight deterministic checks run over the
  evidence before synthesis; `FAIL` blocks ranking both in the system prompt and via an injected
  instruction. The duplicate-profile check keys on what the numbers *describe* rather than on the
  evidence entity — a real fix for a real false positive.
- **`budgetEvidence` never severs an item** and names what it withheld. The delivery count is
  measured *after* budgeting and fed back into the integrity check, so coverage cannot certify
  data the model never saw.
- **Data-path diagnosis is already Phase-16 shaped.** `getPitcherFeatures` and `getTeamFeatures`
  probe each link separately and return A/B/C/E diagnoses.
- **Two pitcher layers are already separated** — `pitcher_features` (per-game) vs `pitcher_season`
  (identity-keyed), labelled distinctly, with explicit instructions never to blend them.
- **Deterministic/LLM separation holds.** Nothing in the file computes a probability, fair price,
  edge, EV, CLV or verdict. `attackThesis` only reads owned signal fields.
- **The FINAL-game drop the notes ask for is already present** in `getPitcherFeatures` (line 1676).

Intent classification, ranking axis, layer fallback, integrity faults, RLS diagnosis, sport honesty
and deterministic-value passthrough **all passed on the first baseline run** — 26 of 37 assertions
green before any change.

### The real bottleneck — measured, and misdiagnosed in the notes

Outstanding item #2 said the fix was "drop FINAL games from the pitcher read." That code was already
there, and it does not fix the problem, because **the defect is in `getMlbCard`, not
`getPitcherFeatures`.**

`getMlbCard` queries a three-day ET window (correct — an ET slate straddles a UTC date), orders
`start_time.asc`, and applies **no final filter at all**. Yesterday's completed games therefore come
back *first*. Each game emits ~6 evidence items; the caller sliced that to 90. Fifteen finished games
× 6 items = exactly 90.

Measured on a fixture slate of 15 finished + 15 live games, asking *"Who are the worst pitchers on
today's MLB slate?"*:

```
starters named in the prompt
  yesterday (Final, useless): 30 of 30
  today     (the question!) :  0 of 30
coverage: pitcher_quality 0/30 · opponent_offense 0/30 · workload 0/30
slate_scope.starters_on_live_slate: 0
```

The model received yesterday's finished card, and the coverage layer then certified
`pitcher_quality 0/30` against a denominator of pitchers who had already thrown. In production the
live MLB fallback partially masks this (it fetches today+tomorrow), which is why it presented as
intermittent rather than total — but the card evidence budget was still being spent on a finished
slate, and with the fallback off or `statsapi` unreachable it collapses completely.

**This is the whole of outstanding item #2, and the packet step would not have fixed it.**

### What is fragile

| # | Defect | Effect | Verified by |
|---|---|---|---|
| 1 | No `BUILD` string anywhere; no `?probe=1`; no `?dry=1` | No way to tell which version is serving. A rejected bundle keeps the old version live and looks identical to a successful no-op deploy. Every other fix is unverifiable without this. | `grep BUILD` → one comment; `GET ?probe=1` → 405 |
| 2 | `getMlbCard` has no final filter; slice takes yesterday | Above | fixture, measured |
| 3 | `resolveTeams` owns one roster (MLB) and is used for every sport | "Giants" in an NFL question resolves to **San Francisco Giants**, which is then printed as the entity in focus, used to filter the card, and written into research memory as the session subject | fixture, measured |
| 4 | `entities.players` declared at line 536, initialised `[]` at 879, **never written** | No player resolution exists at all. No ambiguity detection. "Cole" cannot be distinguished between Gerrit Cole and Cole Ragans | `grep players` |
| 5 | `getCLVHistory` uses `limit=2000`; PostgREST caps at 1000 | `n = rows.length` reports 1000 for a 2400-row population, and the prompt instructs the analyst to **always state the N** | fixture: reported 1000 vs true 2400 |
| 6 | Retry path: `messages[0]` + blind `.slice(0, 60000)` | `messages[0]` is the **first history turn** when history is non-empty — the retry re-sent an unrelated earlier message. When it did send the packet, the blind slice severed the evidence array mid-object: the exact failure `budgetEvidence` exists to prevent, reintroduced on the recovery path | fixture, measured |

### What is missing (not yet built — see P1/P2)

- `DIMENSIONS` has entries only for `baseball_mlb` and `_core`. Every other sport falls to a 3-item
  core, so a football question never notices `team_efficiency` is missing.
- Per-entity `coverage()` is computed only for four hardcoded MLB fields.
- No REQUIRED-vs-OPTIONAL research requirement map, so `missing_required_fields` cannot be computed.
- No `COMPLETE / PARTIAL / INSUFFICIENT / INVALID` delivery state (integrity `FAIL` does the gating
  work today, but only on integrity grounds, not coverage grounds).
- No second, targeted retrieval pass — `runResearch` is a single linear sweep.
- `deriveState`'s `prev` parameter is always passed `null` (line 3851), so conversational carry-over
  ("that game", "the over") cannot work.
- `identity_chain` and duplicate detection cover `pitcher_quality`/`opponent_offense` only, not
  `team_efficiency` or `quarterback`.

### What is redundant

Nothing worth removing. `MLB_INTENTS` and `INTENT_SPORT` overlap but serve different call sites.

---

## PRIORITY PLAN

**P0 — shipped in this build.** Correctness risk, high blast radius, low complexity.
1. `BUILD` + `?probe=1` + `?dry=1` — precondition for verifying anything else
2. Live-slate filter in `getMlbCard` — the actual cause of the refusals
3. Cross-league entity scoping — prevents wrong-sport identity contamination
4. Player resolution with explicit ambiguity — Phase 3's core requirement
5. Exact CLV population count — stops a truncated page being quoted as a sample size
6. Retry path rebuild instead of blind slice

**P1 — next build.** Real value, needs design not just repair.
1. Research requirement map (REQUIRED/OPTIONAL per intent) → semantic coverage → the
   `COMPLETE/PARTIAL/INSUFFICIENT/INVALID` gate (Phases 5, 9, 10 — they are one piece of work)
2. Per-sport `DIMENSIONS` + coverage for football/basketball fields
3. Generalise `identity_chain` and duplicate detection to `team_efficiency` / `quarterback`
4. Wire `deriveState(prev)` so conversation state carries across turns

**P2 — later.**
1. Adaptive second retrieval pass keyed to the coverage gap (Phase 4)
2. Season-layer clone for ATP/WTA and NFL (the ceiling work in the notes)
3. `research_outcomes` write assumes a `user_id` DB default that is not in the payload — verify

**Explicitly NOT done** (Phase 21): no new scoring system, no "AI confidence", no model-computed
EV/CLV, no rewrite of working retrievals.

---

## VERIFICATION

Baseline before changes: **26 passed, 11 failed** (one of the 11 was a bad assertion of mine —
it checked the user content for a rule that lives in the system prompt; corrected, not worked around).

After: **44 passed, 0 failed.**

| Component | Behaviour changed | Test | Result |
|---|---|---|---|
| `BUILD` / `json()` | Every response, including errors, carries `build` + `x-edgedesk-build` | probe/dry/response assertions | PASS |
| `handle()` | `GET ?probe=1` → build + config, no auth/model/db. `POST ?dry=1` → full packet + assembled prompt, no model call | 3 assertions | PASS |
| `getMlbCard()` | Finals dropped at source; live games ordered first; `path.live_scope` records the drop | today 30/30, yesterday 0/30, live universe ≥25 | PASS |
| `runResearch` card slice | Cap raised to 200/40 and truncation **recorded** in `data_path` | — | PASS |
| `resolveTeamsDetailed` / `scopeTeamsToSport` | Cross-league aliases marked; dropped once sport is known non-MLB; rejection recorded | NFL question adopts no MLB club; rejection stated | PASS |
| `playerHints` / `resolvePlayers` | Person hints extracted, resolved against the **retrieved roster**; ambiguity returned, never broken | "Gerrit Cole" → RESOLVED; "Cole" → AMBIGUOUS with 2 candidates | PASS |
| `Dal.count()` | New; exact population via `Content-Range`, not subject to the row cap | 2400 reported for a 2400-row population | PASS |
| `getCLVHistory` | `n` = population, `n_measured_on` = page, `sampled` flag, honest note | as above | PASS |
| `buildUserContent` | Takes an evidence budget; emits `ENTITY RESOLUTION` before the evidence | entity block ordering | PASS |
| Retry path | Rebuilds at ¼ evidence budget instead of slicing `messages[0]` | retry carries the packet, not history; both payloads parse as whole JSON | PASS |
| System prompt | Added `IDENTITY BEFORE NUMBERS` (one paragraph) + the block to the turn manifest | ambiguity instruction present | PASS |

Deterministic-value passthrough re-verified after every change: engine `edge` and `sharp_fair` reach
the model verbatim, and the no-compute rule is intact.

---

## DEPLOYMENT

Single file, **0 imports**, **0 `../_shared` references**, 4,420 lines / 245KB. Paste
`supabase/functions/edgedesk_ai/index.ts` into the dashboard and deploy.

**Verify the deploy actually landed — do not assume it did:**

```bash
curl -s 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/edgedesk_ai?probe=1' | jq .build
```

Expected: `"edgedesk_ai-2026-08-12-r1-entity-slate"`

Any other value — including the endpoint 405ing, which is what the *current* deployment does — means
the bundle was rejected and the old version is still serving.

Then confirm the slate fix against live data, without spending a model call:

```bash
curl -s -X POST 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/edgedesk_ai?dry=1' \
  -H "authorization: Bearer $USER_JWT" -H 'content-type: application/json' \
  -d '{"question":"Who are the worst pitchers on today'\''s MLB slate?"}' \
  | jq '{build, live: .data_path.mlb_card.live_scope, scope: .data_path.slate_scope, coverage}'
```

`live_scope.dropped_final` should be non-zero in the morning, and
`slate_scope.starters_on_live_slate` should match today's starter count — not zero.
