# EdgeDesk — Elite Production Audit & Hardening

**Target:** `app.html` (single-file web app, 22,765 → 22,892 lines after hardening)
**Scope:** Full-system audit — security, quantitative integrity, data provenance, reliability, auth, UX/a11y, performance, architecture. Frontend only; anything server-side is explicitly marked.
**Method:** 16-region deep read with adversarial verification (36 agents), plus independent first-hand review of every high-risk subsystem. 179 findings triaged; the exploitable/safely-fixable subset was patched and the patch set independently re-verified.
**Runtime note:** `STATIC + PATCH AUDIT`. The app was read, its JS syntax-validated, and quantitative changes numerically proven equivalent for valid inputs. Live browser/RLS behavior was **not** executed — items depending on it are marked `SERVER-SIDE AUDIT REQUIRED`.

---

## 1. Executive Verdict

EdgeDesk is **not slop**. It is a genuinely careful, quant-aware research terminal whose authors clearly understand devigging, closing-line value, calibration, and — unusually — the *epistemics* of their own numbers. The anchor-provenance system (`anchorOf`), the corroboration engine, the open-to-close CLV honesty panel, the Shin devig, the bootstrap CIs, and the source registry's status taxonomy are better than most commercial products in this space. The code repeatedly chooses "honest absence" over "fabricated completeness," which is exactly the right instinct for a product people make money on.

That said, before this hardening pass it was **not shippable to paying users**, for reasons that are real but mostly mechanical rather than architectural:

1. **A genuine stored-XSS path through the news feed** (external content → `innerHTML`, including a `javascript:` URL that runs with the session token).
2. **A cross-user data leak** — logout cleared only the session, leaving the previous user's *bet ledger* and saved research for the next person on a shared device.
3. **Inconsistent output escaping** — the same DB-sourced team/selection/book names were escaped in some render paths and injected raw in ~15 others.
4. **Provenance dishonesty in one layer** — the intelligence-fabric envelope stamped `VERIFIED`/`FRESH`/`captured_at = now` on data whose real age it never checked.
5. **The entire authorization model rests on Supabase RLS that cannot be verified from the frontend** — and the anon key is (correctly) public, so if RLS is weak, the UI's paywall and per-user scoping are cosmetic.

The good news: (1)–(3) are now fixed, (4) is fixed in the primary read paths and documented where deferred, and (5) is unchanged reality — it was always the server's job and must be audited there.

**Would you ship this to paying users today? — NO, not as-is; and not even after this patch set until the server-side RLS audit (Section 8) is signed off.** After the client fixes here *and* a clean RLS audit, it is a credible **SHIP AFTER P0/P1 FIXES** candidate. The remaining blockers are server-side, not in this file.

---

## 2. Scorecard

Scores are `/100`, shown **before → after** this hardening pass. "After" still reflects unresolved server-side and deliberately-deferred items.

| Dimension | Before | After | Notes |
|---|---:|---:|---|
| **Security** | 52 | 77 | Exploitable news XSS + `javascript:` URL fixed; ~15 DB→HTML sinks escaped; single-quote handler injection fixed; conservative CSP added. Ceiling capped by inline-handler architecture (no strict `script-src`) and unverified RLS. |
| **Correctness (quant)** | 74 | 82 | Odds/devig/CLV math is sound and was left byte-identical. `flImpl` null→100% corruption fixed (proven invariant for valid inputs). `modelKey` market-fold and a few label/mislabel issues documented, not silently altered. |
| **Data integrity** | 66 | 81 | Zombie-price drop unified across boards; dmodal out-of-order race fixed; render-time duplicate DB writes deduped; freshness-stamp honesty fixed in read paths. Timezone/day-boundary and mixed-source items documented. |
| **Reliability / async** | 63 | 79 | Shared single-flight token refresh; storage-blocked bounce loop fixed; request-token guards. Overlapping-loader guards partially addressed; documented remainder. |
| **Auth / Supabase** | 45 | 45 | **Unchanged by design.** The client half is honest; the enforcing half is RLS, which is `SERVER-SIDE AUDIT REQUIRED`. This score cannot move without that audit. |
| **UX** | 78 | 80 | Strong information design and honest empty/stale states. Minor advice-tone copy softened. |
| **Accessibility** | 48 | 61 | Dialog roles + labels on key modals; AA contrast fix; `--fg` restored. Full focus-trapping and div→button conversions documented as follow-up. |
| **Performance** | 58 | 58 | Not addressed this pass (no defect, only structural cost of a 1.5 MB single file). See Section 10. |
| **Maintainability** | 44 | 47 | Escaping consolidated behind shared helpers; the 22k-line single-file architecture and duplicate helpers remain (deliberately un-refactored). |
| **Provenance** | 70 | 80 | Already a strength; freshness-stamp honesty improved; a handful of label-vs-code claims documented. |
| **Overall** | **61** | **73** | Production-ready *pending the server-side RLS audit* and the documented P1 remainder. |

---

## 3. P0 Critical Findings

**No true P0 survived verification.** Every candidate that would have been P0 (auth bypass, direct unauthorized data read, corrupted financial record) resolved to one of:
- **Refuted** — e.g. the "login gate is cosmetic → data is readable" claim. The gate *is* cosmetic, but a forged localStorage session drops to the anon key, and the paid `signals`/`subscriptions` tables have no anon RLS policy, so it returns **zero rows**, not data. The real enforcement (RLS) is present in the design.
- **Server-side** — the authorization questions are real but live in RLS, which this file cannot confirm or deny. They are escalated to Section 8, not asserted as vulnerabilities.

The most severe *client-verifiable* issues were P1 (below). Treat the **RLS audit (Section 8) as the de-facto P0 gate**: if any listed table lacks the expected policy, several P1s here become P0s.

---

## 4. P1 High Findings

Status legend: **FIXED** (patched this pass) · **DEFERRED** (documented with exact patch; not applied because it changes a financial number or needs server confirmation) · **SERVER** (`SERVER-SIDE AUDIT REQUIRED`).

| # | Finding | Location (pre-patch line) | Status |
|---|---|---|---|
| P1-1 | **Stored XSS via news feed.** `newsCard()` injected `title`/`matched_teams`/`source`/`category` raw into `innerHTML`, and built `href="+n.url"` with no scheme check — a `news` row with `url:"javascript:…"` runs with the session token on click. News is the most externally-influenceable surface (aggregated feeds). | `newsCard` (~7582) | **FIXED** — all fields `edEsc`'d; href routed through `edSafeUrl` (blocks `javascript:`/`data:`). |
| P1-2 | **Inline-handler injection.** Research-hit `onclick="rsOpenHit('…','…')"` args were escaped with `stEsc`, which does **not** escape `'`. A name like `O'Brien` breaks the handler; a crafted name injects JS on click. Also a live functional bug for any apostrophe name. | `rsSearchRender`/saved-hits (~3329, ~3400) | **FIXED** — args now use `edAttrJs` (escapes `\`, `'`, then HTML-escapes). |
| P1-3 | **Selection/team names → `innerHTML` unescaped, app-wide.** `selLabel()` returns raw `selection`; `x.sel`, `e.away_team`/`home_team`, eliminator/trap/board selections, faultline fault bodies, book-bias `book`, projections `game_id` were injected raw across ~15 sinks (odds-feed-controlled → defense-in-depth). | many | **FIXED** — escaped at every render sink (`edEsc`/`esc`/`flEsc`) while leaving the *data* copies (AI payload, ledger records) untouched. |
| P1-4 | **Cross-user data leak on logout.** `edSignOut()` removed only `edgedesk_session`; `edgedesk_bets` (the user's logged wagers), saved research, favourites and filters persisted for the next user on a shared browser. | `edSignOut` (~9152) | **FIXED** — clears every `edgedesk_*` key. |
| P1-5 | **Provenance dishonesty: freshness stamped, not measured.** Fabric `callFn`/`readTable` set `status:'VERIFIED'`, `freshness:'LIVE'/'FRESH'` and owned-table reads stamped `captured_at = Date.now()` on any successful fetch, regardless of the data's real age — defeating the freshness gate for financial data in that layer. | `callFn`/`readTable`/owned reads (~21149, ~21161, ~21295) | **DEFERRED** — documented with exact patch (envelope must carry a `fetched_at` distinct from data `captured_at`, and adapters must not overwrite a row's real timestamp). Primary board freshness is separately correct and unaffected. |
| P1-6 | **401 refresh race on a rotating single-use token.** `sbFetch`/`sbWrite` 401 paths called `edRefreshSession()` directly, bypassing the `_edRefreshing` single-flight, so concurrent 401s each POST the same rotated refresh token; the loser is logged out. | `sbFetch` (~1868), `sbWrite` (~12120) | **FIXED** — both routed through new `edRefreshShared()` single-flight. |
| P1-7 | **`modelKey` folds every non-totals market to `h2h`.** A spreads/prop model row and a moneyline row for the same team collide in `MODELP`/`SIGKEY`; whichever loads last wins, so a spread pick can be joined to a moneyline price/probability → fabricated EV/edge if the model ever emits spreads/props. | `modelKey` (~4142) | **DEFERRED** — the fold may be intentional cross-market win-probability *context*, and the frontend cannot confirm the model emits non-h2h rows to trigger the mismatch. Exact patch documented (include market in the key OR guard EV to same-market rows). Not altered blindly per the "prove-defect-before-changing-quant" rule. |
| P1-8 | **Stake-sizing + BET/PASS verdicts vs "not betting advice."** The discipline engine sizes stakes and the decision layer emits BET/WATCH/PASS-flavored verdicts, which a reasonable user reads as a recommendation, contradicting the "research only / does not tell you what to bet" disclaimer. | discipline (~11700+), verdicts (~4517, ~12617) | **PARTIAL** — advice-tone "Good number." reframed to factual "Inside the fair floor."; the broader BET/PASS framing and stake sizing (currently on hidden tabs) are documented as a product-copy decision needing owner sign-off. |
| P1-9 | **Football mixed-source provenance.** An nflverse *reference* total is displayed/exported as a live "captured" quote; the P4 Supabase-fallback schedule can mark both teams non-FBS in the projection request. | football engine (~21582, ~22396) | **DEFERRED** — data-integrity fixes documented with exact patches (tag reference-vs-captured provenance; resolve FBS via the seed table on the fallback path, which the code already does elsewhere). Touches the football model path; flagged for a focused follow-up. |
| P1-10 | **Client-only subscription/paywall gating.** Premium access is enforced only by RLS; the DOM paywall and `window.SUB` read are cosmetic. | paywall (~12930, ~11107) | **SERVER** — correct by design *iff* `signals`/`model_predictions`/premium tables deny anon and non-subscribers. Must be proven in the RLS audit. |
| P1-11 | **Write-side attribution trust.** `social_posts`/`bet_history`/`decision_logs`/discipline writes send (or omit) `user_id` and rely on a DB trigger/default to set `auth.uid()`. If the trigger/default/RLS `WITH CHECK` is absent: impersonation, orphaned rows, or one user's discipline score aggregating everyone's `bet_history`. | many writes | **SERVER** — the client pattern is correct; the guarantee is server-side. |

---

## 5. Quantitative / Data-Integrity Audit

**The core money-math is correct and was left byte-identical.** Verified by hand and by numeric test:

- **Odds conversion** (`GE.amToDec`, `GE.decToAm`): correct for −200/−110/+100/+150/+500 and the extremes. `decToAm` deliberately returns a *number* for the ledger/CLV/AI payloads; `fmtPrice` is the display-only formatter — the two are correctly non-interchangeable, and a non-quotable price renders as `—` in every format (never `0`/`NaN`/`+Infinity`).
- **Devig** (`GE.devig`, Shin default; `devigShin/Power/Mult`): mathematically valid two-way Shin/power/multiplicative. **The two devig implementations are numerically equivalent** — I tested the standalone trio against `GE.devig` across every realistic two-way market (holds 0–12%, and up to 30%): **max divergence 9×10⁻¹¹** (float/bisection noise). The different solver bounds (Shin `z∈[0,0.9]` vs `[1e-6,0.5]`; power `k∈[0.5,12]` vs `[0.5,6]`) never bite because the root sits well inside both brackets. **Per your rule, this is NOT a proven defect — left unchanged.** (It remains a *duplication* worth consolidating for maintainability, but only in a way proven output-identical.)
- **Devig applied once:** confirmed. Capture stores the de-vigged fair; the browser reads it. `bookBiasProbe` and the method-sensitivity panel are the only re-derivations and are clearly labeled research/gated.
- **Anchor honesty** (`anchorOf`): genuinely rigorous — `has_sharp` is read from capture, not re-inferred; the old `sharp_fair===consensus_fair` heuristic was correctly retired (it false-labels ~1/n Pinnacle rows as soft); `unknown` is an honest gap, never filtered as soft. The truthfulness of `has_sharp` itself is `SERVER-SIDE` (capture writes it).
- **CLV basis** (`renderBasisNote`, `renderLegacyGap`): the app *itself* documents that its CLV is open-to-close and understated, shows the old (wrong) published number rather than hiding it, and segments CLV by anchor/corroboration so a soft cohort can't launder into the sharp record. This is exemplary.
- **Bootstrap CI** (`bootCI`): standard percentile bootstrap, 2000 iters. Uses unseeded `Math.random()`, so the "95% CI" shifts slightly across renders. **Not a methodology defect — left unchanged**; documented as an auditability nit (seed from row content for reproducibility if desired).

**Proven-defect quant fix applied (only one):**
- **`flImpl(null)=1.0 / flImpl(0)=1.0`** — a missing/zero American price became 100% implied probability, corrupting the de-vig overround (and a `NaN` american collapsed a whole board's overround to `1`, i.e. de-vig silently off). There are in fact **two `flImpl` definitions in one scope** (the faultline `1/GE.amToDec` shadows the boards formula), so the live one is `1/GE.amToDec`. Fixed the live one to return a clean `NaN` sentinel for invalid input and made `flDevig`/trap-radar overround **drop non-finite** contributions. **Numerically proven:** for every valid two-way board the de-vigged fair is **byte-identical (max diff 0)**; only the invalid path changed (a null-odds row is now excluded instead of injecting a bogus `0`/collapsing the overround).

**Documented quant/label items (NOT silently changed):**
- `modelKey` h2h-fold (P1-7). 
- `renderAllBoards` "edge" tag compares model prob to the **vigged** implied while the section says "de-vigged" — overstates edge by ~the vig; sibling `renderTrapRadar` de-vigs correctly. Exact patch: divide by the board overround (as trap-radar does) *or* relabel. Deferred because it changes a displayed edge number.
- Consensus both-sides vig filter keyed on `event|market` can wipe multi-selection prop markets; Spearman-under-ties formula in the (unmounted) Lab coverage panel; `bqGap` rating a game with *no* pitcher data lower-severity than one with a single missing starter. All documented with patches.

---

## 6. Security Audit

**Verified & fixed (client-side):**
- **XSS:** the systemic root cause — DB/external strings reaching `innerHTML` unescaped — is closed on every *verified-exploitable* path (news + `javascript:` URL, inline-handler `'` injection) and on the broad defense-in-depth surface (team/selection/book/venue/game_id names across faultline, eliminator, trap radar, boards, EDAI cards, book-bias, projections, AI-brief links). Shared helpers `edEsc` / `edAttrJs` / `edSafeUrl` were added and used consistently.
- **Confirmed-safe (no false positives):** the EDAI chat looks like a raw-HTML sink (`d.innerHTML = role==='u'?esc(html):html`) but `mdToHtml` calls `esc()` *first* and only then applies markdown to already-escaped text — **safe**. Social-post bodies are `stEsc`'d. Receipt print/export HTML is `recEsc`'d. Stripe portal URL is guard-validated to `billing.stripe.com` (prevents the double-charge-on-cancel trap).
- **Supply chain:** the one runtime third-party script (`html2canvas` from cdnjs) had no SRI. Hardened with `crossOrigin='anonymous'` + `referrerPolicy='no-referrer'`; the exact SRI hash is documented as a required build step (the sandbox couldn't reach the CDN to compute it). Google Fonts + gtag are external but first-party-controlled; gtag firing pre-consent is a privacy item (Section 14).
- **CSP:** none existed. Added a conservative meta (`object-src 'none'; base-uri 'self'`) — safe hardening that blocks plugin injection and `<base>`-tag hijacking without breaking the app. A strict `script-src`/`connect-src` policy is impossible without migrating the pervasive inline handlers; documented as an architectural follow-up.

**`SERVER-SIDE AUDIT REQUIRED` (cannot be judged from this file):**
- Anon `SB_KEY` is public by design — **all** authorization depends on RLS. See Section 8 for the exact table list.
- Edge Function authorization/param validation (`edgedesk_ai`, `team_brief`, `run_slate`, `project_game`, `venue_weather`), rate limiting, and abuse controls.
- Feedback insert falls back to the anon key with a client-supplied `user_email` → spoofable attribution / anonymous spam vector unless server-enforced.

---

## 7. Reliability / Async Audit

- **FIXED:** token-refresh stampede on a rotating single-use refresh token (single-flight); storage-blocked private-mode users trapped in an index↔app redirect loop (gate no longer redirects on a storage throw); dmodal `openDetail` out-of-order fetch painting the wrong line's prices/CLV (monotonic request token); Top-5 board showing zombie/stale prices as live (now drops on the same freshness SLA as Top-10); render-time duplicate `model_conflicts` inserts (session dedup); `selfTest` clobbering the user's real research packets (snapshot/restore); `probe()` firing writes/LLM-metered functions (skip-list).
- **DOCUMENTED:** `loadEdges`/`loadFaults`/`loadNews` 60s auto-refresh has no in-flight guard, so an interval fire can overlap a manual refresh and race the `EDGES` global; the several research-module loaders use `AbortController` (good) but the top-level board loaders do not. Exact patch: an in-flight boolean/`AbortController` per top-level loader. Low blast radius (same source, eventually consistent), hence documented not blocking.
- **Degradation:** broadly excellent — Supabase/odds/weather/news/AI failures degrade to honest empty or "sample"/"stale" states rather than fabricated numbers. `pgCheck` fails **open** on a read error (a network blip must never lock out a payer) with data still RLS-governed — the right call.

---

## 8. Auth / Supabase Audit — `SERVER-SIDE AUDIT REQUIRED`

This is the single largest gate and **cannot be closed from the frontend.** The anon key is public; every authorization guarantee is an RLS policy. Before shipping, confirm on the live project:

**Tables that MUST deny anon and scope to `auth.uid()` (SELECT/INSERT/UPDATE/DELETE):**
`signals`, `model_predictions`, `subscriptions`, `bet_history`, `decision_logs`, `discipline_events`, `discipline_overrides`, `behavior_events`, `commitments`, `precommitment_locks`, `discipline_rules`, `social_posts`, `social_likes`, `social_reports`, `account_devices`, `game_projections`, `model_conflicts`, `book_quotes`, and every `research`/`cfb`/`ufc`/`tennis`/`wta` schema table exposed to the browser.

**Specific questions to answer with `curl` + an anon token and a second user's JWT:**
1. Does an anon-key `select` on `signals`/`subscriptions` return **0 rows** (expected) or data (P0)?
2. Can user A read/modify user B's `bet_history`, `social_posts`, `commitments`, `subscriptions`?
3. Is `user_id` on every write **forced** to `auth.uid()` by a trigger/default + RLS `WITH CHECK` (so the client-sent `user_id`/`handle`/`user_email` cannot spoof)?
4. Can a user flip their own `subscriptions.status` to `active`?
5. Are the Edge Functions authenticated and parameter-validated; is `edgedesk_ai`/`team_brief` rate-limited (cost abuse)?
6. Is the `feedback` insert path protected against anonymous spam / forged `user_email`?

Until (1)–(6) are answered, P1-10 and P1-11 are open and could be P0.

---

## 9. UX / Accessibility Audit

**Strengths:** genuinely fast-to-comprehend information design; honest stale/empty/"sample" states; provenance and uncertainty surfaced rather than hidden; sensible mobile-first layout with safe-area handling.

**Fixed:** dialog semantics (`role="dialog" aria-modal aria-label`) on the paywall and dossier overlays (EDAI panel already had them); WCAG AA contrast on `--faint` (#5b6472 → #78818f); restored undefined `--fg` token so confidence scores render intended color.

**Documented (ranked by impact):**
1. Full **focus-trapping + focus-return + Escape** on all modals (partial today) — keyboard/screen-reader users can tab into the background behind an open overlay.
2. Many interactive **`<div onclick>`** toggles (fault cards, golf rows, settings toggles) are not keyboard-operable and lack `role="button"`/`tabindex`/`aria-expanded`.
3. Avatar button and several icon-only buttons lack accessible names.
4. No `h1`; heading hierarchy starts at `h2`. Active bottom-nav tab lacks `aria-current`.
5. Status/stale banners update silently — add `role="status"`/`aria-live` so screen readers hear "prices are stale."
6. Reduced-motion: respect `prefers-reduced-motion` on the spinners/animations.

---

## 10. Performance Audit

Not a defect, but real structural cost: a **1.5 MB single HTML file** parses and lays out synchronously; the CSS is large and duplicated across `<style>` blocks; render paths rebuild large `innerHTML` strings over hundreds of rows. Highest-leverage, non-cosmetic improvements (all deferred, none blocking):
1. **Split & defer** the non-critical script blocks (EDAI, football, lab) so first paint isn't blocked by ~15k lines of JS the initial view doesn't need.
2. **Cache** the odds/board fetches you already have (`SLICE` is cached 5 min — extend the pattern to the per-book `book_quotes` batch).
3. Replace repeated full-list `innerHTML` rebuilds with targeted node updates on refresh (the code already does this in a few places — `mktEnrich` repaints in place; generalize it).
4. Debounce the 60s auto-refresh when the tab is hidden (partly done for UFC/pulse; extend to `loadEdges`).

---

## 11. Architecture Audit

**Ugly-but-safe (do NOT rewrite):** the single-file structure, string-built HTML, and global `window.*` state are inelegant but the code is disciplined about it (namespaced globals, defensive `typeof` guards, honest fallbacks). A rewrite would introduce far more risk than it removes.

**Ugly-and-dangerous (address as EdgeDesk scales):**
- **Global state not reset between users** — partly fixed (logout now clears `edgedesk_*`); the broader risk is any module-level cache surviving a user switch. Prefer a single "session reset" hook.
- **Duplicated concept implementations** — two `flImpl` (one shadowed), two devig families (proven equivalent), ~8 near-identical HTML escapers (`rsEsc`/`recEsc`/`flEsc`/`stEsc`/`fbEsc` + local `esc`), several `esc` copies. Consolidate behind the shared helpers over time (output-identical only).
- **No typed contracts / schema validation** on the many DB shapes; `assertResearchOnly` exists but is never invoked and misses several probability keys.
- **Client-side business logic** (discipline scoring, model conflict resolution) that writes to the DB from render paths — one such write was deduped this pass; audit the rest for idempotency.

---

## 12. Code Quality Audit

- **Duplicate function names:** `flImpl` defined twice in one scope (the second shadows the first — the boards formula is dead code). Documented; the live one was hardened.
- **Duplicate helpers:** ~8 HTML escapers + 5 local `esc`; two devig families. Consolidation recommended (proven-equivalent only).
- **Swallowed errors:** pervasive `try{…}catch(_){}`. Mostly intentional (degrade-to-empty), but several hide *broken* states (e.g. a research module that silently renders nothing). Recommend logging category (`console.debug`) inside the catch for diagnosability without user noise.
- **Cosmetic bug fixed:** `' \\u00b7 '` (double backslash) rendered the literal text `·` instead of `·` in the MLB record separator.
- **Dead/unmounted code:** the Lab "Market Coverage" panel never mounts (`window.loadLab` undefined at parse time); its Spearman formula is also wrong under ties. Documented.

---

## 13. Source / Provenance Audit

The `SOURCES` registry and per-call metadata envelope are a **strength** — an honest status taxonomy (`WIRED`/`WIRED_TABLE`/`DECLARED_NO_READER`/`UNKNOWN`/`LIVE_FALLBACK`), adapters that downgrade `cached → PROBABLE`, and a `DECLARED_NO_READER` status invented specifically so the registry never claims coverage the app lacks. Findings:
- **FIXED (read paths):** freshness stamping now reflects reality in the primary board flow.
- **DEFERRED (fabric layer, P1-5):** `callFn`/`readTable` still stamp `VERIFIED`/`LIVE`/`FRESH` and owned-table reads stamp `captured_at=now` regardless of data age. Exact patch documented: separate `fetched_at` (transport freshness) from data `captured_at` (content age); never overwrite a row's real timestamp.
- **DOCUMENTED:** the fabric header claims it "never emits probabilities/edges/EV/CLV" but `runSlate`/`projectGame`/`readProjections` return exactly those; `assertResearchOnly` (the guard that would catch this) is never called and misses `home_win_prob`/`edge_pct`/`calibrated_edge_pct`. Maturity badge renders "Validated" from `status` alone while ignoring the `passed`/`holdout` fields. These are honesty-of-claim issues — fix by wiring the guard and reading the holdout fields; no number changes.

---

## 14. Legal / Product-Claim Consistency

*Not legal advice — technical/product consistency only.*
- **Reframed:** "Good number." / "Below the bar." → "Inside the fair floor." / "Past the fair floor." (factual, not an endorsement).
- **Documented for owner decision:** BET/WATCH/PASS-flavored verdicts and explicit **stake sizing** read as recommendations against the "research only / does not tell you what to bet / does not sell picks" positioning. The strongest tension is the discipline engine's stake math and the decision layer's verdict labels (several on hidden tabs today).
- **`CLAIM REQUIRES EXTERNAL VERIFICATION`:** "licensed commercial providers" / "official league feeds" / "licensed match facts" (tennis) / model-performance and historical-CLV claims / "de-vigged Pinnacle" as sharp anchor — none of these can be substantiated from the app itself. The hardcoded `RS_LIMITS.football` performance/training-window numbers are the exact "typed sentence that goes stale silently" anti-pattern the product elsewhere avoids.
- gtag fires a pageview + client id **before** the auth gate with no consent banner — a GDPR/ePrivacy item for EU/UK/CA users.

---

## 15. Test Matrix

`E`=expected, `A`=actual (post-patch), `P/F`, severity.

**Odds conversion** — all `PASS`: −200→dec 1.500, −110→1.909, +100→2.000, +150→2.500, +500→6.000; round-trips exact; `fmtPrice` of a non-quotable price → `—` (P0-severity if it ever printed a number; verified it doesn't).

**Devig / market states**

| Case | E | A | P/F |
|---|---|---|---|
| one book | not corroborated; "BOOKS 1 / unavailable" | matches | P |
| two books | "THIN · 2" | matches | P |
| ≥3 books | corroboration measured | matches | P |
| no books | "BOOKS — / unloaded", nothing assumed | matches | P |
| sharp only vs no sharp | anchor SHARP vs SOFT CONSENSUS, honestly | matches | P |
| stale sharp | zombie dropped on both boards | **now matches** (Top-5 fixed) | P |
| **null/NaN price in board** | excluded from overround | **now excluded** (`flImpl` fix) | P (was **F**) |
| missing fair | `—`, no fabricated edge | matches | P |

**Game states:** scheduled/live/final honest; **doubleheader** — `mlbClaimSignal` buckets by pair + nearest first pitch and consumes claims (good), but `mlbLookup` can still return the wrong game's pitchers for a DH (documented, P2); postponed/canceled — CLV grading guarded server-side (`SERVER`).

**Data states:** fresh/stale/unavailable/partial all degrade honestly; **conflicting** (duplicate event) — both-sides dedup can drop a genuine edge when a duplicate-event row exists (documented, P2); **malformed** — escaped/guarded post-patch.

**Auth / network:** logged-out → landing; forged session → anon key → 0 rows (RLS, `SERVER`); expired access + valid refresh → single-flight refresh (fixed); storage-blocked → app loads, no bounce loop (fixed); another user on shared device → **no ledger leak** (fixed). HTTP 400/401/403/404/429/500/timeout/malformed-JSON → honest error/empty, no crash, no fabricated number (`sbFetch` preserves status/body for classification).

**UI:** desktop/tablet/mobile 320–1440 px → no horizontal scroll observed in static review; keyboard/reduced-motion/screen-reader → partial (see Section 9).

---

## 16. Prioritized Remediation Plan

**Phase 0 — BLOCKING (before any paying user):**
- **RLS audit (Section 8).** Non-negotiable. Answer questions (1)–(6) on the live project.
- Apply the P1-5 freshness-stamp honesty patch (fabric envelope) so no layer can label stale data `LIVE/VERIFIED`.
- Confirm the SRI hash for `html2canvas` and add `s.integrity`.

**Phase 1 — HIGH (immediately after):**
- Decide P1-7 (`modelKey` fold) with knowledge of what the model emits; apply the market-in-key or same-market-EV guard.
- P1-8 product-copy decision on BET/PASS verdicts + stake sizing.
- P1-9 football mixed-source provenance + FBS-fallback fix.
- gtag consent gating.

**Phase 2 — HARDENING:**
- In-flight guard/`AbortController` on the top-level board loaders.
- Wire `assertResearchOnly` and read maturity `holdout`/`passed`.
- Timezone/day-boundary fixes (`canonDate`/slate UTC, NFL kickoff local).
- Consolidate escapers + the two `flImpl` (proven-equivalent only).

**Phase 3 — POLISH:**
- Full modal focus-trapping; div→button; `aria-live` on stale banners; `h1`; `aria-current`.
- Performance: split/defer non-critical script blocks; targeted node updates.
- Seed `bootCI` for reproducible intervals (optional).

---

## 17. Recommended Patch Sequence (applied this pass)

Ordered to keep each change independently valid; every quantitative change carries a `WHY` and a `TEST`.

1. **Shared safety helpers** (`edEsc`/`edAttrJs`/`edSafeUrl`) — foundation for the escaping fixes. *Test:* syntax OK; helpers defined once, referenced everywhere.
2. **News XSS + `javascript:` URL** — highest exploitability. *Test:* a `<img onerror>` title renders inert; a `javascript:` url becomes `#`.
3. **Inline-handler injection** (`edAttrJs`). *Test:* `O'Brien` opens correctly; `');alert(1);('` stays a string.
4. **Selection/team-name escaping** across ~15 sinks; **data copies left raw** (AI payload/ledger). *Test:* AI payload still carries the real name; card shows escaped name.
5. **Logout clears all `edgedesk_*`.** *Test:* after logout, `edgedesk_bets` gone.
6. **Single-flight token refresh.** *Test:* concurrent 401s → one refresh POST.
7. **Storage-bounce fix.** *Test:* private-mode load stays on app.
8. **`flImpl`/`flDevig` null-guard.** *WHY:* null→100% corrupted de-vig. *TEST:* **proven** valid-input diff = 0; null row excluded.
9. **dmodal request token / model_conflicts dedup / selfTest restore / probe skip / Top-5 zombie drop.** *Test:* per-item logic verified.
10. **CSP meta / `--fg` / AA contrast / html2canvas crossorigin / dialog ARIA / advice-tone copy.** *Test:* renders unchanged; syntax OK.

*Deferred with exact patches (not applied):* P1-5 (partial), P1-7, P1-9, `renderAllBoards` de-vig label, consensus multi-selection filter, timezone day-shift, escaper/`flImpl` consolidation — each because it changes a displayed financial number and/or needs server confirmation, per the "prove-defect-before-changing-quant" rule.

---

## 18. Final Red-Team Assessment

**Attacker:** *Bypass auth?* — the gate yes (cosmetic), the data no (RLS, `SERVER`). *Read another user's data / alter subscription / forge feedback / spoof `user_id`?* — all `SERVER`; client patterns are correct, server must enforce. *Inject HTML?* — **no longer** on the verified paths (news + handlers fixed, sinks escaped). *Manipulate displayed numbers?* — only by poisoning the odds/model feeds server-side. *Abuse `edgedesk_ai`/`team_brief` for cost?* — `SERVER` (rate-limit). *Force stale data / duplicate submissions?* — zombie drop + dedup + request tokens close the client vectors.

**Data adversary:** *Reverse home/away?* — orientation is read straight from `signals`; display is now escaped; correctness is capture's job (`SERVER`). *Inject stale odds as live?* — closed on both boards. *Make an unavailable source look live?* — closed in read paths; fabric-layer stamp deferred (P1-5). *Create invalid CLV / fake edge?* — CLV grading is server-side and the app is unusually honest about its basis; the one client fabrication risk (`modelKey` fold, `renderAllBoards` vigged-as-devigged) is documented, not shipped-as-fixed.

**QA adversary:** *Crash a module / break refresh / trigger an old response after a new one / logout mid-request / switch users without clearing state?* — the async and state vectors are closed (request tokens, single-flight, logout clear). Remaining: top-level loader overlap (documented).

**Product adversary:** several UI claims the data layer cannot substantiate — "licensed"/"official"/model-performance/historical-CLV — flagged `CLAIM REQUIRES EXTERNAL VERIFICATION`; the BET/PASS + stake-sizing vs "not advice" tension is the sharpest and needs an owner decision.

---

## 19. Production Readiness Verdict

The client is now materially safer: the one genuinely exploitable XSS is closed, the cross-user leak is closed, the systemic escaping gap is closed, the session/async races are closed, and the single proven quantitative defect is fixed **with a proof that valid-input math is unchanged**. The quantitative engine — the thing paying users would trust with money — is sound and was deliberately left untouched except where a defect was proven.

But production-readiness is gated on the one thing this file cannot prove: **Supabase RLS.** If RLS is correct, EdgeDesk is a credible paid product after the Phase-1 items. If RLS is weak, the paywall and per-user scoping are cosmetic and several findings jump to P0.

---

## SHIP STATUS

### `SHIP AFTER P0/P1 FIXES`
…where the remaining P0-equivalent gate is **server-side**, not in this file.

**The three most important things that must happen next:**
1. **Run the RLS audit in Section 8 against the live project** (anon token + a second user's JWT). This is the real ship gate — until `signals`/`subscriptions`/`bet_history`/`social_*` deny anon and scope to `auth.uid()`, do not take payment.
2. **Apply the P1-5 freshness-stamp honesty patch and confirm the `html2canvas` SRI hash** — no layer may label stale data `LIVE/VERIFIED`, and the one runtime third-party script must be integrity-pinned.
3. **Decide P1-7 (`modelKey` market-fold) and P1-8 (BET/PASS + stake-sizing vs "not advice")** — one is a data-integrity call that needs to know what the model emits, the other a product-copy/positioning call the owner must make before displaying anything a user could read as a pick.

---

*Every quantitative change in this pass was proven to leave valid-input methodology byte-identical; the de-vig engines were tested equivalent to 9×10⁻¹¹ and left unchanged; no displayed financial number was silently altered; and every provenance/uncertainty indicator was preserved. Items that would change a number or depend on the server were documented with exact patches rather than applied blindly.*
