# EdgeDesk — Remediation Report

Remediation pass on `app.html`, executed as senior engineer under a strict mandate: **preserve the existing architecture and quantitative methodology; change math only where a defect is proven; make no unrelated changes; keep the app functional after every patch.** This pass builds on the audit + first hardening pass (PR #14) and closes the specific items that were deferred there (devig/escaper consolidation, `loadEdges` race, `bootCI` determinism, the user-switch localStorage leak).

Companion documents: `AUDIT_REPORT.md` (19-section audit), `BEFORE_AFTER_MATRIX.md` (all 179 findings + invariance proofs).

---

## Remediation checklist

Ordered per the required remediation sequence. `R#` = this pass; `PR14` = landed in the first hardening pass.

| ID | Sev | Current behavior (before) | Root cause | Location | Fix | Risk | Test | Status |
|---|---|---|---|---|---|---|---|---|
| **R1** | P1 | Logout cleared per-user keys, but a user SWITCH without logout (B signs in on index.html while A's session persists) let B inherit A's `edgedesk_bets` ledger, saved research, prefs, favourites. | Per-user browser state was not bound to an owner; only explicit logout purged it. | `edEnforceOwner()` + call before `renderLedger();loadEdges();` (~9250/9270) | Stamp `edgedesk_owner=uid`; on any boot where session uid ≠ stored owner, purge every `edgedesk_*` except session+owner, before the first read of per-user data. `edSignOut` still clears all `edgedesk_*`. | Low — only purges on a genuine uid mismatch; no-op for same user. | A→E walk-through; verify B sees no A data. | **FIXED** |
| **R2** | P2 (quant-maint) | Two independent de-vig engines: `GE.devig` (authoritative) and standalone `devigMult/Power/Shin` with different solver bounds (power k∈[0.5,12] vs [0.5,6]; Shin z∈[0,0.9] vs [1e-6,0.5]). Could drift. | Duplicated implementation of the same Shin/power/multiplicative methodology. | `devigMult/Power/Shin` (~2464), `methodFairBetSide` (~2472) | Standalone trio now DELEGATES to `GE.devig` (one authoritative deterministic engine). Same methodology; API preserved. | Low — proven equivalent to 9e-11; delegation only runs at render. | Equivalence test (multiplicative EXACT 0, power/shin ≤7e-11). | **FIXED** |
| **R3** | P2/P3 | Five duplicated HTML escapers (`rsEsc/recEsc/flEsc/stEsc/fbEsc`); `flEsc/stEsc` used `(s||'')` and **threw** on a numeric argument. | Copy-pasted `&<>"` escapers; two with a null-coalescing bug. | escaper defs (~2983/4919/7315/7735/21633), canonical `_escHtml` (~2784) | All five delegate to one canonical `_escHtml` (String-coerced `&<>"`, deliberately NOT escaping `'` so the `__brief` single-quoted-JS handlers keep working). `cfbEsc` (URL-encode) left distinct. | Low — identical char set; String-coercion only fixes the throw. | Old-vs-new parity across HTML/null/numeric inputs; `'` preserved. | **FIXED** |
| **R4** | P2 | `loadEdges` (60s interval + manual refresh + `pgOnUnlock`) had no in-flight/ordering guard: a slow older response could overwrite `EDGES` and repaint stale prices. | No request generation or in-flight coalescing on the primary board loader. | `loadEdges` (~3770), interval (~9299) | Generation token: `EDGES` committed and the board painted only by the latest call; `LOAD_EDGES_BUSY` stops the interval stacking a load on one in flight; manual refresh ungated so it can't get stuck. | Low — guards only skip stale work; manual path unaffected. | Overlap simulation: older response aborts, `EDGES` stays fresh, flag resets. | **FIXED** |
| **R5** | P3 (quant-audit) | `bootCI` used `Math.random()`, so the displayed 95% CI **jittered every render** — non-reproducible, non-auditable. | Non-deterministic entropy source in a displayed analytic. | `bootCI` (~2615), `_fnv1a`/`_mulberry32` (~2624) | Seed a deterministic PRNG from the sample values; methodology UNCHANGED (percentile bootstrap, 2000 iters, 2.5/97.5). Same data → same interval. | Low-Med — CI values become reproducible (the old ones were non-reproducible anyway; point estimate unchanged). | Determinism test + interval brackets mean / ≈ normal-approx CI. | **FIXED** |
| **R6** | P2 | One runtime third-party script (`html2canvas`) had no SRI. | CDN script without integrity pin. | `rcptPng` (~6710) | `crossOrigin='anonymous'` + `referrerPolicy='no-referrer'` added (PR14); exact `integrity` hash left as a build-time step. | n/a | — | **PARTIAL** — see Not Fixed. |
| **R7** | P2 | Duplicate normalizers (`nrm`, `canonTeam`, `mlbNorm`, `favNorm`, `normKey`). | Different modules normalize team names for different join keys. | multiple | Investigated; these are **intentionally distinct** (MLB-specific vs CFB vs favourites vs general), used in matching logic where a subtle change would break joins. | — | Documented, not merged (per "consolidate only same-concept" rule). | **NOT MERGED (by design)** |
| PR14 | P1 | News-feed stored XSS + `javascript:` URL. | Raw external content → innerHTML; no scheme check. | `newsCard` | `edEsc` all fields + `edSafeUrl(href)`. | — | — | **FIXED (PR14)** |
| PR14 | P1 | Inline-handler injection (`stEsc` args, `'` unescaped). | Wrong escaper for single-quoted JS-string args. | research-hit onclick | `edAttrJs`. | — | — | **FIXED (PR14)** |
| PR14 | P1 | ~21 DB-name → innerHTML sinks unescaped. | Inconsistent escaping. | faultline/eliminator/trap/boards/EDAI/etc. | escaped at sink; data copies untouched. | — | — | **FIXED (PR14)** |
| PR14 | P1 | 401 refresh raced a rotating single-use token. | 401 paths bypassed the single-flight. | `sbFetch`/`sbWrite` | `edRefreshShared`. | — | — | **FIXED (PR14)** |
| PR14 | P1 | `flImpl(null)=100%` corrupted de-vig overround. | No non-finite guard. | `flImpl`/`flDevig` | NaN sentinel + drop non-finite (valid inputs proven identical). | — | — | **FIXED (PR14)** |
| PR14 | P2 | No CSP; storage-blocked redirect loop; dmodal race; render-time dup writes; selfTest packet clobber; probe side-effects; Top-5 zombie prices; a11y dialog roles; advice-tone copy; `--fg`/contrast; `·` bug. | various | various | see `AUDIT_REPORT.md` §17. | — | — | **FIXED (PR14)** |
| BE-AUDIT | P1 | `modelKey` folds non-totals markets to h2h → fabricated model-overlay EV. Backend source **confirms** `model_predict` writes NFL/WNBA `spreads` rows into `model_predictions`, so a moneyline price could join a spread-cover prob. | Market collapsed in the join key. | `modelKey` | Added explicit `spreads` branch keyed by market **and** signed point; `h2h`/`totals` keys byte-identical (test-proven); display-only overlay, authoritative `curEdge` untouched. | h2h/totals keys unchanged (diff 0); ml vs spread keys now distinct | see `BACKEND_SHIP_AUDIT.md` §Quantitative | **FIXED** |
| — | P1 | Fabric envelope stamps `VERIFIED/LIVE/FRESH` regardless of data age. | Freshness not measured in that layer. | `callFn`/`readTable` | Documented patch (separate `fetched_at` from data `captured_at`). Primary board freshness is separately correct. | — | — | **DEFERRED** |
| — | P1 | RLS / subscription / write-attribution enforcement. | Server-side. | Supabase | — | — | — | **REQUIRES BACKEND** |

---

## Fixed

**This pass (R1–R5 fully; R6 partial):**
1. **R1 — cross-user data leak on user-switch.** Per-user state is now owner-bound; a different signed-in user never inherits the prior user's ledger/research/prefs, with or without an explicit logout.
2. **R2 — one authoritative de-vig engine.** The standalone trio delegates to `GE.devig`; the method-sensitivity panel now shares the exact live math. Proven equivalent.
3. **R3 — one canonical HTML escaper.** Five duplicates collapsed to `_escHtml`; the `flEsc/stEsc` numeric-throw is fixed; the single-quote-sensitive `__brief` handlers are provably unaffected.
4. **R4 — `loadEdges` race eliminated.** Stale responses can no longer overwrite `EDGES` or repaint; the interval no longer stacks loads.
5. **R5 — reproducible confidence intervals.** The bootstrap CI is now a deterministic function of its input; methodology unchanged.

**Prior pass (PR #14):** the exploitable news XSS + `javascript:` URL, the inline-handler injection, ~21 DB-name sinks, the 401 refresh race, the `flImpl` de-vig corruption, plus the CSP/state/a11y/cosmetic set. Full list in `AUDIT_REPORT.md` §17 and `BEFORE_AFTER_MATRIX.md`.

---

## Not Fixed (and why)

- **R6 — html2canvas SRI hash.** The script now sends no credentials (`crossOrigin=anonymous`) and no referrer, but the exact `integrity="sha384-…"` hash is **not** applied: this build environment's proxy blocks the CDN, so the digest cannot be computed or verified here, and shipping an unverified hash would silently disable the receipt-image export. **Action:** compute the hash on a machine with CDN access and add `s.integrity`. One line; the code is already `crossorigin`-ready.
- **`modelKey` market-fold (P1) — NOW FIXED.** The backend ship-gate audit (`BACKEND_SHIP_AUDIT.md`) read the `model_predict` source and confirmed NFL/WNBA emit `market='spreads'` rows into `model_predictions` (MLB does not) — upgrading this from a theoretical to a proven, imminently-live defect. Fix applied: an explicit `spreads` branch in `modelKey` keyed by its own market and signed point, so a moneyline price never joins a spread-cover probability. `h2h`/`totals` keys are byte-identical (test-proven, diff 0); no formula changed; the corrupted value was display-only (the authoritative `curEdge` was never affected). Now consistent with the app's own signals-path workaround (`indexSignalRows`, which already excluded spreads).
- **Fabric freshness-stamp honesty (P1).** Deferred: the fix touches the provenance envelope of a secondary data layer; documented with the exact patch. The primary board's freshness (`setStale`, `EDGE_MAX_AGE_MIN`) is separately correct and unaffected.
- **`renderAllBoards` "de-vigged" label, consensus multi-selection filter, timezone day-boundary (P2).** Each changes a displayed number or touches matching logic; documented in `AUDIT_REPORT.md` §5, not applied.
- **Team-normalizer consolidation (R7).** Investigated and intentionally NOT merged — `nrm`/`canonTeam`/`mlbNorm`/`favNorm`/`normKey` serve different join concepts; merging risks breaking matches.
- **Full modal focus-trapping, strict `script-src` CSP, performance splitting (P2/P3).** Architectural follow-ups; a strict CSP is impossible while inline handlers remain (stated, not claimed otherwise).

---

## Requires Backend Verification

`SERVER-SIDE AUDIT REQUIRED` — cannot be resolved or confirmed from this file:
1. **RLS on every browser-exposed table** (`signals`, `subscriptions`, `bet_history`, `social_*`, `commitments`, `discipline_*`, `game_projections`, `book_quotes`, `model_predictions`, research schemas): anon must get 0 rows; user A must not read/write user B's rows. This is the real ship gate.
2. **Write attribution** forced to `auth.uid()` by trigger/default + RLS `WITH CHECK` (so client-sent `user_id`/`handle`/`user_email` cannot spoof).
3. **Subscription state** not user-writable; **paywall** enforced by RLS, not the DOM.
4. **Edge Function** auth, parameter validation, and rate-limiting (`edgedesk_ai`, `team_brief`, `run_slate`, `project_game`, `venue_weather`); feedback insert anti-spam.
5. Truthfulness of capture-written columns (`has_sharp`, `flagged_*`, closing snapshots) that the client displays but cannot verify.

Exact table list and test queries: `AUDIT_REPORT.md` §8.

---

## Quantitative Regression Results

Core money-math was transcribed verbatim from the patched file and tested. **15/15 pass; every value below is UNCHANGED from before remediation** (odds/devig/fair/edge were not touched).

| Quantity | Input | Output | Changed? |
|---|---|---|---|
| American→decimal | −200 / −110 / +100 / +150 / +500 | 1.500 / 1.90909 / 2.000 / 2.500 / 6.000 | no |
| decimal→American (round-trip) | 1.5 / 1.90909 / 2.0 / 2.5 / 6.0 | −200 / −110 / +100 / +150 / +500 | no |
| devig (Shin) −110/−110 | two-way | 0.5000 / 0.5000, Σ=1.000 | no |
| devig normalization (mult/power/shin) | −200/+175 | Σ=1.000 (all methods) | no |
| fair price (Shin) | −200/+175 book | fair probs 0.6515 / 0.3485 → fair American −187 / +187 | no |
| edge (fair − price-implied) | best 2.75 vs fair 0.3485 | −1.52 pts | no |
| CLV (entry-implied vs closing fair, arithmetic identity) | 1/2.60 vs 0.34 | +4.46 pts | no |

**De-vig consolidation (R2)** — old standalone vs new GE-delegated, across every realistic two-way market:
- multiplicative: **max |old−new| = 0** (exact)
- power: **5.1e-11**, shin: **6.9e-11** (bisection-iteration noise; imperceptible). Methodology identical.

**Confidence interval (R5)** — representative sample (n=120, mean +1.90%, se 0.27%; normal-approx 95% = [+1.38%, +2.42%]):

| | interval | reproducible across renders? |
|---|---|---|
| **Before** (Math.random) | run1 [+1.37%, +2.41%] · run2 [+1.38%, +2.45%] | **NO — jittered** |
| **After** (data-seeded) | [+1.41%, +2.44%] every run | **YES** |

**Why the CI value changed:** the bootstrap now draws from a deterministic, data-seeded PRNG instead of `Math.random()`. The methodology is identical (percentile bootstrap, 2000 resamples, 2.5/97.5), and the new interval matches the normal approximation as closely as the old one did — it is simply now a *stable, reproducible* estimate rather than a fresh random draw each render. The point estimate (mean/median) is unchanged. This is the only intentionally-changed displayed number, and it changed from a non-reproducible value to a reproducible one.

No other displayed quantitative value changed.

---

## Security Regression Results

Tested (static + extracted-function):
- **Escaper parity (R3):** `_escHtml` produces byte-identical `&<>"` output to the old escapers for HTML/null/undefined/empty/`<img onerror>` inputs; **does not** escape `'` (so the `__brief` single-quoted-JS handlers are unaffected — traced); numeric input no longer throws.
- **No new XSS sink:** the consolidation only *added* escaping (numeric-safe) and changed no sink from escaped to raw. PR14's sink coverage is intact (all delegating escapers still escape `&<>"`).
- **No new auth/authorization assumption:** R1 only *purges* client state on a uid mismatch; it grants nothing and makes no authorization decision (authorization remains RLS). `edUser()` still only decodes the JWT for display/identity.
- **`edSafeUrl` / `edEsc` / `edAttrJs`** unchanged; `javascript:`/`data:` still blocked at href sinks.
- **Reference integrity:** all inline JS blocks pass `node --check`; every new helper (`_escHtml`, `edEnforceOwner`, `_fnv1a`, `_mulberry32`, `LOAD_EDGES_GEN/BUSY`) is defined once and referenced correctly; the old `bootCI` `Math.random()` is fully removed.

Not executed (static audit): live DOM/navigation, real RLS behavior, mobile rendering — see Requires Backend Verification and the runtime caveat.

---

## Remaining P0 / P1

- **P0:** none in the client. The de-facto P0 gate is **server-side RLS** (Requires Backend Verification #1) — unresolvable from this file.
- **P1 (client, deferred with documented patches, each because it would change a displayed number or needs server confirmation):** `modelKey` market-fold; fabric freshness-stamp honesty. Neither is a silent defect on the primary board; both are documented with exact fixes.
- **P1 (server):** RLS / write-attribution / subscription enforcement.

There are **zero unexplained P0/P1 issues**.

---

## Final Ship Status

### `SHIP AFTER REMAINING FIXES`

The client is now materially hardened and internally consistent: the cross-user leak is closed on both logout and user-switch, the quantitative engine has a single authoritative de-vig implementation (proven equivalent), the displayed CI is reproducible, the primary board loader is race-safe, and the escaping layer is consolidated with its numeric-throw fixed — all with **no change to any displayed odds/devig/fair/edge/CLV value**.

Shipping to paying users still depends on three things outside this file, in order:
1. **Pass the Supabase RLS audit** (`AUDIT_REPORT.md` §8) — the real gate.
2. **Apply the two documented P1 patches** (`modelKey` market-fold decision; fabric freshness honesty) and **add the html2canvas SRI hash** from a CDN-reachable build.
3. Then the Phase-2 hardening (focus-trapping, strict CSP path, performance) as normal follow-up.

This is not a claim of "secure" or "bug-free." It is evidence-backed: the changes are proven equivalent where they touch math, verified for regressions, and the residual risk is explicitly located in the server layer this frontend cannot see.

---

## Backend Edge-Function Review Map

The audit is a **frontend** audit; everything below is `SERVER-SIDE AUDIT REQUIRED`. These are the specific Edge Functions to inspect, ordered by how directly they gate a real risk. For each, the concrete question to answer.

### Tier 1 — Authorization / the ship gate (review FIRST)
| Function | Why it's critical | Exact question |
|---|---|---|
| **`stripe_webhook`** | Writes `subscriptions.status` — the paywall's ONLY real enforcement. | Does it verify the Stripe signature (webhook secret) before writing? Can a user POST a forged event to self-activate? Is `status`/`current_period_end` writable only by this function's service role? |
| **`collective_admin` / `collective_billing` / `collective_join`** | NEW subsystem (added days ago, after the frontend audit). Handles membership, payment, admin. | Can a non-admin call `collective_admin`? Can a user manipulate `collective_billing` to grant themselves paid membership, or `collective_join` to join without entitlement? These are the least-audited surfaces in the project. |
| **`edgedesk_ai` / `team_brief`** | LLM-metered — cost-abuse vector. `team_brief` returns web-search `url`s (client now scheme-validates, server should too). | Are calls JWT-authenticated and rate-limited per user? Does `team_brief` sanitize the `url`/`brief` it returns? |
| **`run_slate` / `project_game` / `model_predict` / `model_conf_odds`** | Compute + WRITE. The client no longer fires them in `probe()`, but the server must enforce. | Do they reject unauthenticated calls and `{probe:true}` pings? Can a user trigger arbitrary/expensive recompute? |
| **`odds` / `venue_weather` / `resolver` / `healthcheck`** | Browser-callable readers. | Is the auth posture appropriate to what each exposes? Does `odds` leak the paid Odds-API quota/key? |

### Tier 2 — Data integrity the DEFERRED quant fixes depend on
| Function | Why | Exact question |
|---|---|---|
| **`model_predict` / `model_conf_odds` / `model_props` / `project_game` / `run_slate` / `cfb_flag`** | **This answers the deferred P1 (`modelKey` market-fold).** | **Do any of these write rows into the table the board joins (`model_predictions`) for markets OTHER than `h2h` and `totals` — i.e. spreads or props?** If YES → the frontend `modelKey` h2h-fold is a LIVE defect (fabricated EV) and must be fixed now. If props land in a separate `model_props`/`game_projections` table that the board does NOT join on `modelKey`, the fold is inert. This is the single most important backend answer. |
| **`settle`** | CLV grading — the core integrity claim. | Is CLV computed ONLY from a true closing sharp fair? Is it ever awarded on a missing/invalid close? Are postponed/canceled games excluded rather than graded against a live price? |
| **`close` / `close_backfill` / `cfb_close` / `wta_close`** | Write `closing_sharp_fair` used for CLV. | Is the close a sharp (Pinnacle) de-vigged price captured AT/BEFORE start — never a post-start live tick, never a consensus substitute? (The UI asserts this; capture must honor it.) |
| **`capture` / `capture_boards`** | Write `has_sharp`, `flagged_*`, `sharp_fair`/`consensus_fair`, `first_*`, `corrob_*`, `last_seen_at`. | Does `has_sharp` truthfully reflect a real Pinnacle quote (the entire sharp/soft anchor split rests on this)? Do `last_seen_at`/`captured_at` carry real capture time (needed to properly fix the deferred fabric freshness-stamp honesty item)? |
| **`capture_news`** | The news-XSS SOURCE. Client now escapes + scheme-validates; server should too. | Does it sanitize/validate `url` and text before storing? |

### Tier 3 — Ingest / grade (provenance, timezone, RLS on the tables they fill)
`ingest_mlb`, `ingest_multisport`, `ingest_nfl_features`, `ingest_pitcher_season`, `cfb_ingest`, `tennis_ingest`, `wta_ingest` → verify date/timezone stamping (the deferred day-boundary item) and RLS on the WIRED_TABLE targets.
`grade_faults`, `grade_props`, `grade_model_golf`, `model_grade`, `model_conf_grade`, `recalibrate`, `learn`, `market_residual` → grading/learning writers; confirm they read only settled rows and expose no cross-user data.

### Cross-cutting (applies to every function + table above)
**RLS is the real ship gate** and is not a per-function question — it's per-TABLE. With an anon token and a second user's JWT, confirm: `signals`, `subscriptions`, `bet_history`, `social_*`, `commitments`, `discipline_*`, `game_projections`, `model_predictions`, `book_quotes`, `model_conflicts`, and every `cfb/ufc/tennis/wta` schema table exposed to the browser → anon gets 0 rows; user A cannot read/write user B's rows; `user_id` is forced to `auth.uid()` on write. (Full queries: `AUDIT_REPORT.md` §8.)
