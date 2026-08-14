# edgedesk_ai r2 — the research packet

BUILD: `edgedesk_ai-2026-08-12-r2-research-packet`
Single file, 0 imports, no `../_shared`. 5,351 lines / 293KB.
Tests: **102 passing, 0 failing** — 44 r1 regression (`suite.ts`) + 58 new (`suite_r2.ts`).

The governing idea of this build: **the analyst never works out for itself whether the packet is
complete. The code states it, in a form that can be obeyed rather than interpreted.**

---

## What changed

### 1. Question requirement map (§2)
`REQUIREMENTS[intent]` declares what each question actually needs, tiered REQUIRED / IMPORTANT /
OPTIONAL, each with a denominator (`per: entity | slate | focus | global`) and an optional
`satisfied_by` fallback layer. Maps for `best_pitchers`, `worst_pitchers`, `best_matchups`,
`team_efficiency`, `best_bets`, `what_changed`, `historical`, `player_specific`, `why`, `price`.

### 2. Semantic coverage (§3)
Coverage now answers "how much of what THIS question needs is on hand", not "how many rows came
back". Entity-aware — 29/30 reports as 29/30, never as 100%. When a requirement is met by a
fallback layer the cell carries `via: "season_pitching"` and the prompt says which layer the number
came from. Overall is weighted 0.70/0.25/0.05 across the tiers so optional gaps cannot drag a good
packet down — and the gate reads `critical_gaps` directly, so a high overall cannot hide a missing
required field.

### 3. Completeness gate (§4)
`COMPLETE / PARTIAL / INSUFFICIENT / INVALID`, plus `safe_to_rank`, `safe_to_compare`,
`safe_to_make_betting_interpretation`. Integrity contamination outranks coverage: clean-but-thin
data can be reasoned over honestly, badly-joined data cannot be reasoned over at all. The gate is
printed **before** the evidence it governs, with the permission spelled out.

### 4. Slate scope (§5)
`buildSlateScope` establishes the expected universe from the schedule — expected / scheduled /
final / postponed / missing / dropped_final / complete. The denominator never comes from the rows
that came back, because counting retrieved rows against retrieved rows always reports 100%.

### 5. Adaptive second pass (§6)
After the coverage audit, `targeted()` re-retrieves **only what is missing** — season layer,
weather, bullpen, sharp reference, CLV history — and records `{reason, missing_requirement,
retrieval, result, rows_added, coverage_before, coverage_after, improved}`. A follow-up that adds
nothing is recorded as *"the gap is real, not a lookup miss"*, which is a different and more useful
statement than silence. A complete packet triggers no second pass at all.

### 6. Canonical identity + normalization (§7, §10)
`normalizeEvidence` assigns every item an `id`, a `layer`, and lifts `event_id` / `player_id` /
`team_id` / `date` from its value — in one auditable place rather than at twenty emission sites,
because the point is that it cannot be forgotten at one of them. `pitcher_id` now travels inside
the pitcher evidence value, so joins and integrity checks key on identity rather than on a display
name.

### 7. Cross-entity integrity (§8)
Three new deterministic checks on top of the existing eight:
- `cross_entity_identity` — generalises the pitcher→team→game chain to every team-keyed item, and
  catches home/away inversion
- `subject_team_consistency` — one person attached to two clubs in one packet is a join artefact
- `duplicate_event` — the same matchup under two event ids inflates every denominator built on it

### 8. Evidence hierarchy (§11)
`layer` on every item: `matchup > season > market > historical > context`, stated in the prompt as
analytical priority. A season rate can never be silently read as a matchup read.

### 9. Thesis attack inputs (§12)
`support` and `contradictions` are **selected from the evidence by id**, not written. When nothing
in the packet contradicts the thesis the list is empty and the prompt says so explicitly:
*"do NOT manufacture an objection to look balanced."*

### 10. Deterministic context (§13)
The engine's own numbers for the focused signal are attached as a READ-ONLY block. Fixed alongside:
`best_bets` at SLATE depth had **no focus at all**, so the analyst was asked to name the best bet
with none of the engine's numbers for any candidate. Intents that need a deterministic candidate
now get one from the top of the edge-ordered board.

### 11. Change classification (§15)
`diffSnapshots` now classifies each change as `NEW / REMOVED / IMPROVED / WORSENED / MOVED /
STATUS_CHANGED / PRICE_CHANGED / DATA_CHANGED`, derived only from the two stored snapshots.

### 12. Sport capability contract (§19)
`SPORT_CAPABILITIES` declares what each sport actually has. A field the sport does not have is
reported `not_applicable`, never as a gap — counting CFB's absent EPA as a gap on every question
buries the gaps that are real.

### 13. Learning-loop observability (§20)
The `research_outcomes` upsert keys on `(user_id, event_id, market, selection)` but has never sent
`user_id` — it depends on a column default of `auth.uid()`. **I could not verify that default
without database access, so I did not assume it.** The write's status is now captured and reported
by `?probe=1` as `last_memory_write`, so a silent rejection becomes observable instead of being
inferred from an empty table months later.

**Verify it directly:**
```sql
select column_name, column_default, is_nullable
from information_schema.columns
where table_name = 'research_outcomes' and column_name = 'user_id';
```
If `column_default` is null, the loop is dropping every open outcome. Fix with:
```sql
alter table public.research_outcomes alter column user_id set default auth.uid();
```

### 14. Expanded `?dry=1` (§24)
Returns the complete packet in the order the analyst reads it: `request, intent, sport, entities,
slate_scope, requirements, coverage, coverage_per_entity, completeness, integrity, fallbacks,
conflicts, unavailable, deterministic_context, historical_context, thesis_attack, data_gaps,
data_path, provenance, evidence, prompt`. No secrets — asserted by test.

---

## A regression I introduced and caught

Adding `pitcher_id` to the pitcher evidence value **broke duplicate-profile detection**: the id is
numeric, so it became part of the "statistical fingerprint" and made two genuinely identical stat
lines look distinct purely because they belonged to different people — disabling the exact check
that exists to catch that case. Identity fields are now excluded from `statFingerprint`. Caught by
the r2 suite, which is the argument for having written it before the change rather than after.

---

## Verification

```
suite.ts     44 passed, 0 failed   (r1 regression — everything that passed before still passes)
suite_r2.ts  58 passed, 0 failed   (slate scope, gate, layer fallback, second pass,
                                    cross-entity integrity, packet contract, deterministic
                                    passthrough, historical separation, thesis inputs,
                                    what-changed, sport contract, yesterday-cannot-satisfy-today)
```

End-to-end on a 15-game live card with 15 finished games in the lookback window,
*"Who are the worst pitchers on today's MLB slate?"*:

```
slate scope      : 15/15 live, 15 finals dropped, complete=true
coverage overall : 100%
  required       : game 15/15 · probable_starter 30/30 · pitcher_quality 30/30
  important      : opponent_offense 30/30 · park 15/15 · workload 30/30 · bullpen_flag 1/1
integrity        : WARNING
COMPLETENESS     : COMPLETE | safe_to_rank=true
follow-ups       : none needed
evidence         : 218 items, all with id, all with layer
yesterday leak   : 0 items
```

## Deploy

```bash
curl -s '.../functions/v1/edgedesk_ai?probe=1' | jq '{build, last_memory_write}'
# build must read: "edgedesk_ai-2026-08-12-r2-research-packet"
```

Then inspect a real packet without spending a model call:
```bash
curl -s -X POST '.../functions/v1/edgedesk_ai?dry=1' \
  -H "authorization: Bearer $USER_JWT" -H 'content-type: application/json' \
  -d '{"question":"Who are the worst pitchers on today'\''s MLB slate?"}' \
  | jq '{slate_scope, coverage: .coverage.required, completeness, fallbacks, data_gaps}'
```

## Still open (P2)

- Second-pass targets cover MLB + market gaps; football/basketball gap-filling reuses the same
  `targeted()` machinery but has no sport-specific follow-ups wired yet.
- `deriveState(prev)` still receives `null` from the handler — conversational carry-over
  ("that game", "the over") remains unwired.
- Season-layer clone for ATP/WTA and NFL (the ceiling work) is untouched.
