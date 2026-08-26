# EDGE DESK FINAL BACKEND SHIP AUDIT

**Scope of evidence.** This audit traces *actual code*, not names or comments. It is based on
the Edge Function source supplied by the operator — **16 functions**, verbatim:
`stripe_webhook`, `collective_admin`, `collective_billing`, `collective_join`, `team_brief`,
`run_slate`, `project_game`, `model_predict` (multi-sport bundle), `model_conf_grade`, `odds`,
`settle`, `close`, `ingest_mlb`, `ingest_multisport`, `ingest_nfl_features`,
`ingest_pitcher_season` — plus the front end (`app.html`) and the on-disk client Collective files
(`collective/embed.js`, `collective/odds.js`).

**What could NOT be verified, and is therefore called out as a gate rather than guessed:**

- **No database/RLS source was provided.** There are no migrations, no `CREATE POLICY`, no table
  DDL, and no bodies for the `SECURITY DEFINER` RPCs the Collective calls (`mint_invite`,
  `redeem_invite`, `settle_game`, `upsert_games`, `billing_upsert_subscriber`,
  `billing_post_invoice`, `billing_post_refund`, `get_config`, `admin_resolve_quarantine`, …).
  Per the operator's own rule, where the RLS/DB layer cannot be verified the status **cannot be
  SHIP**. These are marked **REQUIRES DATABASE/RLS VERIFICATION**.
- **~13 functions named in the brief were not provided:** `capture`, `capture_boards`,
  `close_backfill`, `cfb_close`, `wta_close`, `model_conf_odds`, `model_props`, `cfb_flag`,
  `collective_embed`, `collective_public`, `collective_ingest`, `collective_odds`,
  `collective_odds_ingest`. Findings that depend on them are marked **REQUIRES SOURCE
  VERIFICATION**. (`capture` is the writer of the entry price and `has_sharp` — its absence is
  material to CLV/sharp conclusions.)
- **Gateway configuration ("Verify JWT" on/off per function) cannot be read from source.** Several
  functions delegate authentication entirely to that setting; those are marked **REQUIRES CONFIG
  VERIFICATION**.

---

## Executive Verdict

Scores are **provisional** and assume the DB/RLS layer, the RPC bodies, and the unpasted functions
are as sound as the code that *was* provided. They cannot be finalized until that layer is read.

| Dimension | Score | Basis |
|---|---|---|
| **Overall** | **76 / 100 (provisional)** | Edge layer is strong and unusually honest; RLS is the ungated ship-blocker. |
| Security | 74 / 100 | Signature verification and authz gating are correct; RLS + config-dependent auth unverified. |
| Authorization | 72 / 100 | Every Collective admin route gated before privileged DB access; RPC-body ownership checks unverified. |
| **RLS** | **UNVERIFIED — gate** | No policy source. This is the ship blocker. |
| Subscription Enforcement | 88 / 100 | Both Stripe webhooks verify signatures before any write; a client value cannot forge `active`. |
| Collective Security | 75 / 100 | Edge authz solid; RPC bodies + `collective_public`/`_embed` entrypoints unverified. |
| Quantitative Integrity | 88 / 100 | Deterministic; `modelKey` market-fold now **fixed** (this pass). |
| CLV Integrity | 78 / 100 | `decideClose` never fabricates; but sharp-only CLV is **opt-in**, not default (P1). |
| Reliability | 88 / 100 | Defensive, idempotent, fail-closed; every no-op is made diagnosable. |
| Payments | 88 / 100 | Correct mapping, replay-safe main webhook; collective webhook lacks event-id dedup. |

**Bottom line:** the backend *code that was provided* is careful, fails closed, and does not
fabricate numbers. The audit **cannot** clear it for ship because the layer that actually enforces
per-user isolation — Postgres RLS and the `SECURITY DEFINER` RPC bodies — was not provided, and two
integrity controls ship in their permissive default (`CLOSE_REQUIRE_SHARP=false`, and the
gateway-JWT dependency on six functions).

---

## P0

**None proven from the provided source.** The one candidate P0 (forging a paid subscription) is
**refuted**: both webhooks verify the Stripe signature before any write (see Stripe Findings).

> A P0 **may still exist in the unverified layer.** If RLS is not enabled or correct on
> `subscriptions`, `signals`, `bets`/ledger, `research_packets`, or the Collective tables, a
> user holding the public anon key could read or write another user's rows directly through
> PostgREST — that would be P0. It cannot be confirmed or denied without the policy source.
> **REQUIRES DATABASE/RLS VERIFICATION.**

## P1

1. **CLV computed from a consensus fallback when no sharp exists (default config).**
   `close`/`priceEvent` sets `sharp_fair = s.sharp ?? cons` (edge_source `priceEvent`, line 9505):
   when Pinnacle did not price a selection, `sharp_fair` becomes the **consensus median** and
   `has_sharp` is set truthfully to `false`. `decideClose` then computes `clv = entryDec *
   closeFair − 1` from that `sharp_fair`, and the sharp-required guard `CLOSE_REQUIRE_SHARP`
   **defaults to `false`** (line 9544). So the stored `clv` — the number the Record page's CLV
   aggregate is built from — includes consensus-derived closes for selections that never had a
   sharp anchor. The central invariant *"no valid sharp close → no valid CLV"* is **opt-in, not
   enforced.** *Mitigation:* `has_sharp` and `closing_has_sharp` are stored per row (line 10085),
   so the data to segment exists. **Fix:** set `CLOSE_REQUIRE_SHARP=true`, **or** have the Record
   page compute the headline CLV only over `closing_has_sharp = true` rows and report
   consensus-close CLV separately.

2. **`modelKey` market-fold — spreads collide with moneyline (FIXED THIS PASS).**
   `model_predict` writes NFL and WNBA `spreads` rows into `public.model_predictions`
   (`supportedMarkets:["h2h","spreads","totals"]`, lines 7125/7486; emit at 7300–7301 / 7667–7668),
   with `selection=<team>` and `point=<signed handicap>`. The app's `modelKey` folded every
   non-totals market into `…|h2h|<team>`, so a moneyline board price could join a *spread-cover*
   probability and display a fabricated model read/EV. See **Quantitative Findings** for the trace
   and the applied fix. Severity is **P1, not P0**: the corrupted value feeds the **display overlay
   only** (`modelBlock`, app 4241; `modelEdge`, app 16776) and the code confirms it "feeds no edge
   math… `curEdge` remains the pipeline's authoritative number." MLB (h2h+totals only) was never
   affected; the collision activates for NFL/WNBA once feature-ingest lands model rows.

## P2

1. **Six functions authenticate only via the gateway "Verify JWT" setting — no in-code check.**
   `team_brief`, `run_slate`, `project_game`, `odds` (`isAuthedUser` only *base64-decodes* the JWT,
   it does **not** verify the signature — line 8855), `ingest_mlb`, and `ingest_multisport` perform
   no cryptographic auth themselves. If "Verify JWT" is OFF for any of them, they are open: the odds
   provider key can be spent, model/AI compute can be triggered, and multi-day ingest backfills can
   be forced anonymously. **REQUIRES CONFIG VERIFICATION** that Verify JWT is ON for all six.

2. **`team_brief` has no per-user rate limit and a cache-bypass.** An authenticated user can pass
   `?fresh=1` (line 2388) to skip the 24 h cache and force a fresh ~$0.04 Anthropic + web-search
   call, repeatedly. Bounded only by the Anthropic account budget. **Fix:** per-user/day cap on
   `fresh=1`, or ignore `fresh` for non-admins.

3. **`ingest_mlb` / `ingest_multisport` lack the CRON_SECRET check their siblings have.**
   `ingest_nfl_features` and `ingest_pitcher_season` gate on `CRON_SECRET` (lines 12181, 12592);
   `ingest_mlb` (serve 10803) and `ingest_multisport` (serve 11822) do not — 0 occurrences of
   `CRON_SECRET`/`x-cron-secret` in either body. They rely solely on the gateway. Make them
   consistent (add the same `CRON_SECRET` gate).

4. **`collective_billing` has no event-id de-duplication.** Unlike the main `stripe_webhook`
   (which records `stripe_events` and checks `alreadyHandled`, lines 61/139/242), the Collective
   webhook verifies the signature (with a ±300 s window, line 1450) but does **not** persist
   processed event ids. Replay-safety inside that 300 s window therefore depends entirely on the
   `billing_post_invoice` / `billing_upsert_subscriber` RPC upsert keys, which are not in the
   provided source. **REQUIRES DATABASE VERIFICATION** that those RPCs upsert on `stripe_ref` /
   subscription id (idempotent) rather than insert.

5. **PostgREST value interpolation in Collective read builders.** `buildGames` / `currentWeek`
   interpolate `sport`/`season`/`week` into filters as `sport=eq.${sport}` without
   `encodeURIComponent` (lines 693, 765–768). Whether this is exploitable (PostgREST filter
   injection, read-only, `collective` schema) depends on the `collective_public` / `collective_embed`
   entrypoints that pass query params in — **not provided**. **REQUIRES SOURCE VERIFICATION**;
   safe fix is to `encodeURIComponent` these and `Number`-coerce season/week.

## P3

1. **`?secret=<CRON_SECRET>` accepted in the URL for browser diagnostics.** `settle`, `close`,
   `model_conf_grade`, `ingest_nfl_features`, `ingest_pitcher_season` accept the cron secret as a
   query parameter. `close`'s own comment acknowledges this puts the secret in request logs and
   advises the schedule use the header. Acceptable for manual use; rotate the secret if a URL with
   it has been shared, and keep scheduled calls on `x-cron-secret`.
2. **Fetch-exception strings could carry a provider URL (with key) into an authorized-only
   diagnostic.** `close`/`settle` record `String(e).slice(0,200)` into `providers[...]` and
   `console.log`. Deno network errors rarely include the full URL, but redacting the key from any
   stringified provider error would close the gap. Authorized callers only.
3. **`collective_join` POST origin check contains a malformed `www` comparison** (line 2183:
   `host === `[www.${base}](https://www.${base})``). This looks like a Markdown-mangling artifact
   of the paste; if it is literally in production it merely rejects legitimate `www.` origins
   (availability, not security). Verify against the real source.

---

## RLS Findings

**REQUIRES DATABASE/RLS VERIFICATION — no policy source was provided.** The following must be
confirmed directly against the database before ship. The front end uses the **public anon key** with
the user's JWT and talks to PostgREST directly, so for every table the app reads/writes, **RLS is
the only thing standing between user A and user B's rows.**

Tables to verify (RLS enabled + per-operation policies keyed to `auth.uid()`):

| Table | Ownership column | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `subscriptions` | `user_id` | own only | service-role only | service-role only | service-role only |
| `signals` | (none / global) | read model — is it meant to be readable by all authed users? | **service-role only** (capture/close/settle) | **service-role only** | deny |
| bets / ledger / `research_packets` | `user_id` | own only | own only | own only | own only |
| `team_briefs` | (cache) | authed read | service-role only | service-role only | deny |
| `game_projections`, `model_predictions`, `model_conf_signals` | (global) | authed read | service-role only | service-role only | deny |
| Collective `collective.*` (creators, models, api_keys, subscribers, invite_tokens, submissions, earnings) | `user_id`/`creator_id` | via SECURITY DEFINER RPC only | RPC only | RPC only | RPC only |

Conceptual IDOR tests to run against RLS (each must fail for a non-owner):
User A → User B row · User A → User B model · User A → User B subscription · User A → User B
collective · User A → User B API credential · normal user → admin-only op. **Cannot be answered
from source.**

## Service-Role Findings

- **Service-role is used correctly as a server-only credential in every provided function.** It is
  read from `SUPABASE_SERVICE_ROLE_KEY` / `SB_SERVICE_ROLE`, used only in outbound headers, and
  **never** returned to a client or logged (see Secret Management).
- **The Collective model is: gateway JWT OFF + service-role for all DB access + authorization done
  in the Edge Function (and again in the RPC).** This is a valid pattern **iff every route checks
  authz before the privileged op.** Verified for `collective_admin`: `requireAdmin(req)` runs at the
  **top** of the serve (line 837) before any routing, and each write RPC additionally passes
  `p_admin: admin.id` for a defense-in-depth check inside the `SECURITY DEFINER` body. Verified for
  `collective_join`: redemption requires `getUser` **and** a secret invite token (line 2209).
  Verified for `collective_billing`: state-changing route is the signature-verified webhook.
- **Residual gate:** the `SECURITY DEFINER` RPC bodies enforce the *row-level* ownership (which
  creator a user becomes, single-use of an invite, that `p_admin` is really an admin). Those bodies
  were not provided. **REQUIRES DATABASE VERIFICATION.**
- **Authorization happens before privileged DB access in every provided path** — proven for the
  request → JWT (`getUser` → `/auth/v1/user`, never decoded locally, fails closed) → authz
  (`requireAdmin` / token) → service-role RPC chain.

## Stripe Findings

**Main app (`stripe_webhook`):**
- Signature **verified before any parse/write**: `constructEventAsync(raw, sig, WH_SECRET, …)` on
  the raw bytes (line 132), 400 on failure (Stripe stops retrying a bad secret).
- **Replay/idempotency:** `alreadyHandled(event.id)` short-circuits (line 139); the `stripe_events`
  row is written **only after** the work succeeds, with `resolution=ignore-duplicates` for the
  concurrent-delivery race (line 242). A 500 (unrecorded) triggers a clean Stripe retry.
- **User mapping is not forgeable from email:** resolved from `client_reference_id` (the Supabase
  UUID the server put on the payment link), then subscription metadata, then existing
  `stripe_customer_id` — "never guess from email" (line 82).
- **Status mapping is explicit;** `deleted → canceled`, failure → `past_due` without touching
  `current_period_end` (preserving the grace window).

**Collective (`collective_billing`):**
- Signature verified via manual HMAC-SHA256 with a **±300 s timestamp window** (replay bound, line
  1450) and constant-time-ish compare; 403 on failure **before** any write (line 1498).
- Explicit status map — `unpaid`/`paused`/`incomplete` all read as `canceled`, not defaulted to
  `active` (line 1534).
- **Gap:** no event-id dedup table (P2-4 above).

**Can any client-controlled value set `subscriptions.status = active` without a valid Stripe event?
→ NO** (both webhooks verify the signature first). `client_reference_id` is client-set but only maps
a *real, paid* checkout to a user; it cannot fabricate the event itself.

## Collective Findings

| Question | Answer (from provided Edge source) |
|---|---|
| Who can create a collective / mint invites | Admins only — `requireAdmin` → `mint_invite(p_admin,…)` (lines 844–885). |
| Who can join | Holder of a secret `mci_…` invite token **who is signed in** — `redeem_invite(p_token_hash, p_user_id,…)` (line 2254). |
| Who can publish/ingest projections | Creators via their `mck_live_…` submission key → **`collective_ingest` (NOT PROVIDED)**. **REQUIRES SOURCE VERIFICATION.** |
| Who can rotate credentials / leave / edit model | Not present in provided source ("rotate from your dashboard", line 2281) → a creator self-service function **NOT PROVIDED**. **REQUIRES SOURCE VERIFICATION.** |
| Who can administer billing / settle results / resolve quarantine | Admins only — all under `requireAdmin` (`/v1/admin/results`, `/v1/admin/quarantine/.../resolve`, `/v1/admin/earnings`). |
| Private models / another user's credentials | Only `key_prefix` (never the secret) is ever returned; raw keys shown once at creation. Cross-user access is enforced inside the RPCs → **REQUIRES DATABASE VERIFICATION.** |

Attempts (normal user → admin action; A → B collective; A → private model; A → B credentials): the
Edge layer **rejects** the first (403 from `requireAdmin`); the rest are enforced in the RPC bodies
that were not provided.

## Quantitative Findings

**SHIP-GATE #4 — full WRITE → TABLE → READ → JOIN → EV trace, resolved.**

- **WRITE.** `model_predict` writes `public.model_predictions`, conflict key
  `model_version,event_id,market,selection`, `resolution=ignore-duplicates` (protects the frozen
  CLV baseline) — edge_source lines 3480–3486. Row columns: `event_id, market, selection, point,
  model_prob, model_fair_american, model_edge, model_ev` (3334–3349).
- **MARKETS.** MLB `["h2h","totals"]` (5130) — safe. **NFL `["h2h","spreads","totals"]` (7125)** and
  **WNBA `["h2h","spreads","totals"]` (7486)** emit spreads:
  `add("spreads", ev.home_team, spreadLine, …)` and `add("spreads", ev.away_team, -spreadLine, …)`
  (7300–7301, 7667–7668). So `model_predictions` holds, for one NFL game/team, **both** an `h2h`
  row (`selection=team, point=null`) and a `spreads` row (`selection=team, point=±handicap`).
  The DB stores them as distinct rows (distinct `market` in the conflict key) — **the backend is
  correct.**
- **READ / JOIN (the defect).** The app built `window.MODELP` (app `app.html:3864`) keyed by
  `modelKey(event_id, market, selection, point)`, and `modelKey` (app `4235`) folded every
  non-totals market into `…|h2h|<team>`. So the spreads row and the h2h row for the same team
  **collided on one MODELP key**; last-writer-wins.
- **DISPLAYED EV.** `modelFor(e)` (app `4239`) → `modelBlock` (app `4241`) rendered the resulting
  row's `model_prob` / `model_fair_american` as the model read for a **moneyline** price, and
  `modelEdge` (app `16776`) displayed its `model_edge`. A P(cover −3.5) shown as a moneyline model
  probability = **fabricated EV/edge on the overlay.**
- **Severity = P1, not P0.** The corrupted value is display-only; the code confirms `modelEdge`
  "feeds no edge math… `curEdge` remains the pipeline's authoritative number" (app 16767–16769).
  The authoritative edge, sort, verdict, and CLV are untouched. The app's *signals* overlay was
  already protected — `indexSignalRows` deliberately excludes spreads (app 10059) — but the
  **MODELP** path had no such filter.
- **FIX APPLIED THIS PASS** (`app.html:modelKey`): add an explicit `spreads` branch that keys by its
  own market **and** signed point, leaving `h2h` and `totals` byte-identical:

  ```js
  if(market==='spreads')return ev+'|spreads|'+mMatch(sel)+'|'+(point==null?'':point);
  ```

  Proven by test: `h2h`/`totals` keys byte-identical old vs new; moneyline (`E|h2h|team`) and spread
  (`E|spreads|team|-3.5`) keys now distinct; a −3.5 model row no longer matches a moneyline price
  and no longer matches a −7 board spread (point separation). This restores the intended
  methodology (a price joins the model prediction *for its own market*); it changes **no formula**.

Other quantitative notes (unchanged, verified consistent): the `close`-side de-vig (`shin`/`power`/
`multiplicative`, line 9464) matches the front end's `GE.devig`; `sigKey` (line 9519) is the exact
primary key `capture` wrote (trailing pipe is load-bearing); grading (`grade()`, 9027) is exact and
refuses ambiguous markets.

## CLV Findings

Trace: entry price → sharp quote → fair prob → closing snapshot → closing sharp fair → CLV → grading.

1. **Can entry prices be rewritten?** `entryPrice` reads frozen `flagged_best_dec` →
   `first_best_dec` → `best_dec` (line 9571). `close` never rewrites them. Whether a *client* can
   rewrite them on `signals` depends on RLS (they should be service-role-only). **REQUIRES RLS
   VERIFICATION** (`capture` writer also not provided).
2. **Can closing prices be rewritten?** `close` writes the snapshot once and stamps `closed_at`; all
   selection queries filter `closed_at IS NULL`. (Idempotency caveat below.)
3. **Can a close be generated after game start?** Yes, within `CLOSE_GRACE_MIN` (180 min, line 9531)
   — deliberate, to recover missed cron ticks; recovery uses the **last tick before first pitch**,
   labeled `closing_source='last_tick'` and counted separately. Not a fabrication.
4. **Can a live price become a close?** Only a pregame re-price or a pre-pitch tick; not an in-play
   feed. Source is labeled.
5. **Can consensus become a sharp close?** **YES, by default** — this is P1-1: `sharp_fair` falls
   back to the consensus median and CLV is computed from it unless `CLOSE_REQUIRE_SHARP=true`.
6. **Can a missing close produce CLV?** **NO** — `line_pulled_no_close` / `invalid_close_fair` /
   `no_entry_price` → `clv=null` (`decideClose`, 9586–9625). A transient provider failure defers the
   row instead of burning it (FIX 2 in-source).
7. **Can a failed close be backfilled incorrectly?** Write-off (`missed_close_window`) is **off by
   default** (`CLOSE_WRITEOFF=false`, 9549) precisely because it is irreversible; the sweep tries
   the tick series first and only *reports* what it would write off.
8. **Can settlement run twice?** **NO** — `settle`'s grading UPDATE carries `.is("graded_at", null)`
   ("never regrade a row something else already settled", line 9288).
9. **Can a settled record be modified?** The grade write is guarded (as above); already-graded rows
   are excluded from the next batch.
10. **Can a postponed/canceled game get an invalid grade?** **NO** — `finalScore` requires
    `completed === true` + exact team-name match + finite parsed scores (9087); tennis game-lines and
    lay markets are refused (`gradeable`, 9068); "nothing is ever written as a loss because it could
    not be checked."

**Central invariant "no valid sharp close → no valid CLV": NOT enforced by default** (P1-1). Fix by
flipping `CLOSE_REQUIRE_SHARP` or segmenting the Record by `closing_has_sharp`.

**Idempotency caveat (P3-ish):** `close`'s pending write is `.eq("sig_key", …)` without a
`closed_at IS NULL` guard (line 10091), unlike `settle`. Two overlapping `close` crons could
double-write, but the per-row payload is deterministic within one snapshot, so the effect is benign.
Adding the guard would match `settle` and remove the theoretical race.

## Authentication Findings

- **JWT is validated correctly where it is validated in code:** `getUser` calls `/auth/v1/user` with
  the bearer token and the anon apikey, never decodes locally, and fails closed on revoked/expired
  (Collective, lines 470–493).
- **`odds`'s `isAuthedUser` only base64-decodes the payload** (`role==='authenticated' && sub`,
  8855) — this is a *user-vs-anon* discriminator, **not** signature verification; its security
  depends on the gateway (P2-1).
- **Cron functions fail closed** when `CRON_SECRET` is unset (`settle`, `close`,
  `model_conf_grade`, `ingest_nfl_features`, `ingest_pitcher_season`) — the 401 body distinguishes
  "not set" from "did not match."
- **Six functions have no in-code auth** and rely on gateway "Verify JWT" (P2-1) — **REQUIRES CONFIG
  VERIFICATION.**

## Authorization / IDOR Findings

- **Edge-layer authorization is present and correct** for every provided route (Service-Role
  Findings). No route reaches a privileged DB op before its authz check.
- **Row-level IDOR resistance lives in RLS + the RPC bodies**, neither provided → **REQUIRES
  DATABASE/RLS VERIFICATION.** This is the single largest open question and the reason the status is
  not SHIP.
- `project_game` / `run_slate` accept an arbitrary `game_id` (no format validation) but only via the
  parameterized supabase-js client (no SQL injection) and gated by the gateway; the blast radius is
  compute + an upsert of a projection for an id that must exist in the feature tables.

## Idempotency Findings

| Function | Mechanism | Safe on double-run? |
|---|---|---|
| `stripe_webhook` | `alreadyHandled` + `stripe_events` ignore-duplicates | **Yes** |
| `collective_billing` | signature only, **no event-id store** | Depends on `billing_*` RPC upsert keys — **DB-verify** (P2-4) |
| `settle` | UPDATE `.is("graded_at", null)` | **Yes** |
| `close` | reads filter `closed_at IS NULL`; write `.eq(sig_key)` (no null-guard) | Effectively yes; deterministic payload (add guard) |
| `project_game` | `upsert` (default PK conflict) | Yes if PK = `(game_id[,model_version])` — **DB-verify** |
| `model_predict` | `on_conflict=model_version,event_id,market,selection` ignore-duplicates | **Yes** (first row frozen for CLV) |
| `ingest_mlb` | upserts on `park_id`/`game_id`/… | **Yes** |
| `ingest_multisport` | upserts on `game_id`/team keys | **Yes** |
| `ingest_nfl_features` | `on_conflict=team_norm` merge-duplicates | **Yes** |
| `ingest_pitcher_season` | `onConflict:"season,player_id"` | **Yes** |
| `capture`, `collective_ingest`, `collective_odds_ingest` | not provided | **REQUIRES SOURCE VERIFICATION** |

## Rate-Limit Findings

- **`team_brief`:** no per-user limit; `?fresh=1` bypasses the 24 h cache → authenticated cost abuse
  (P2-2). Anthropic budget is the only ceiling.
- **`odds`:** 20 s in-memory cache per distinct query; no per-user limit. Authenticated only.
  Provider quota is exposed (`x-requests-remaining`) but that is informational.
- **`run_slate` / ingest backfills:** fan-out / multi-day amplifiers; safe only while gateway auth
  holds (P2-1). Backfill inputs are clamped (`0–14`, `1–7`).
- **No global rate limiting is visible in any provided function.** If any of the six gateway-only
  functions is exposed, there is no in-app throttle behind it.

## Secret Management

- **No secret value is ever returned in a response body or logged.** The only secret *names* in
  responses are "missing env" diagnostics (e.g. `"missing env (STRIPE_SECRET_KEY / …)"`, line 123;
  `"ODDS_API_KEY not set"`, 8885) — names, not values.
- Provider keys (`ODDS_API_KEY`, `CFBD_KEY`, `ANTHROPIC_API_KEY`, Stripe keys) appear **only** in
  outbound requests to the provider (server-side). The `odds` proxy strips the key from its cache
  key (`built.replace(ODDS_API_KEY, "KEY")`, line 8892) and never returns the built URL.
- **P3 residuals:** `?secret=` cron secret in URLs (logs); fetch-exception strings could, rarely,
  carry a provider URL into an authorized-only diagnostic (redact to be safe).
- Service-role key: server-only, never client-exposed in any provided function. **The public anon
  key in `app.html` is expected to be public** — its safety is entirely a function of RLS
  (unverified).

## Input Validation

- **Collective:** thorough — name length 2–60, email regex, sport whitelisted against the DB,
  URL protocol-checked, `source_kind` enum-whitelisted, invite token regex `mci_[A-Za-z0-9]{8,64}`,
  admin ids validated as `[0-9a-f-]{36}`. Table/RPC names are **hardcoded literals** in the Edge
  code — no arbitrary table name reaches PostgREST.
- **Compute/ingest:** `backfill`/`days` clamped; `sport` whitelisted; `game_id`/`date` passed only
  through the parameterized client.
- **Gaps:** PostgREST value interpolation in `buildGames`/`currentWeek` without `encodeURIComponent`
  (P2-5, depends on unprovided entrypoints); `project_game` does not validate `game_id` shape
  (low impact, parameterized).
- **NaN/Infinity/absurd numbers:** `model_predict`'s row builder rejects `model_prob` that is
  non-finite or out of `[0,1]` before writing (`invalid_probability`, lines 4255–4260); `decideClose`
  rejects non-probability fairs and out-of-band prices. Good posture where it matters most.

## Remaining Frontend Findings

Only the item the backend audit proves still matters:

- **`modelKey` market-fold — now fixed in `app.html` this pass** (Quantitative Findings). Backend
  evidence (NFL/WNBA emit `spreads` into `model_predictions`) is what upgraded this from
  "deferred/theoretical" to a proven, imminently-live defect and justified the fix. No formula
  changed; `h2h`/`totals` keys are byte-identical.

All other frontend items from the prior remediation stand as previously reported; the backend audit
did not surface new frontend defects.

---

## Evidence

Each finding above is stated with its exact function, code path (line numbers in the supplied
`edge_source` bundle unless prefixed `app.html:`), table, scenario, impact, severity, and fix. The
load-bearing ones:

- **Subscription forgery (refuted):** `stripe_webhook` line 132 (verify) → 139/242 (dedup) →
  `subscriptions` on_conflict=user_id. Scenario: attacker POSTs a fake `checkout.session.completed`.
  Impact: none — 400 at signature check. Severity: N/A (control works).
- **CLV sharp fallback (P1):** `priceEvent` 9505 (`s.sharp ?? cons`) → `decideClose` 9586 →
  `signals.clv`. Scenario: selection with no Pinnacle quote at close. Impact: consensus-derived CLV
  counted as sharp CLV in the Record aggregate. Fix: `CLOSE_REQUIRE_SHARP=true` or segment by
  `closing_has_sharp`.
- **modelKey collision (P1, fixed):** `model_predict` 7300 (write spreads) → `model_predictions` →
  app `3864` (MODELP) / `4239`/`4241`/`16776` (read) → overlay EV. Scenario: NFL moneyline price +
  NFL spread model row for the same team. Impact: fabricated model overlay/EV (display only). Fix:
  applied `spreads` branch in `modelKey`.
- **Gateway-only auth (P2):** `odds` 8855, `team_brief`/`run_slate`/`project_game` (no auth code),
  `ingest_mlb` 10803 / `ingest_multisport` 11822 (no CRON_SECRET). Scenario: Verify-JWT OFF. Impact:
  anonymous provider-key spend / compute / ingest. Fix: confirm gateway config; add in-code cron
  gate to the two ingesters.

---

## RESOLVED SHIP-GATE QUESTIONS

1. **Is RLS correctly enforcing user isolation?** — **UNKNOWN (no source). REQUIRES
   DATABASE/RLS VERIFICATION.** This is the ship blocker.
2. **Can service-role functions be abused?** — **NO in the provided code** (authz precedes every
   privileged op); **conditional on gateway config** for the six gateway-only functions and on the
   unverified RPC bodies.
3. **Can users forge subscriptions?** — **NO.** Both webhooks verify the Stripe signature before any
   write.
4. **Can users bypass Collective authorization?** — **NO at the Edge layer** (admin routes gated,
   redemption token+auth gated). Row-level enforcement in the RPC bodies is **unverified**.
5. **Can `modelKey` produce market collisions?** — **YES — it did** (NFL/WNBA spreads vs moneyline).
   **FIXED this pass**; display-only impact, no CLV/edge-math corruption.
6. **Can invalid CLV be created?** — **YES, by default:** consensus-fallback closes are counted as
   CLV unless `CLOSE_REQUIRE_SHARP=true` (P1-1). Fabricated CLV from a *missing* close: **NO**
   (guarded).
7. **Can non-Pinnacle data masquerade as sharp?** — `has_sharp` is **honest** (never masquerades),
   but `sharp_fair` silently becomes the consensus median when Pinnacle is absent and feeds CLV by
   default (same as #6). Fix as P1-1.
8. **Can historical results be modified?** — **NO** for grading (`.is("graded_at", null)` guard);
   direct table modification depends on RLS (**unverified**).
9. **Can expensive functions be abused?** — **YES, conditionally:** `team_brief` (`fresh=1`, no rate
   limit) by any authenticated user; `run_slate`/ingest if gateway auth is off (P2-1/2/3).
10. **Are ingestion functions idempotent?** — **YES** for all four provided ingesters (explicit
    upsert conflict keys); `capture`/`collective_ingest` **unverified**.
11. **Are Stripe webhooks authenticated and replay-safe?** — Main: **YES** (verified + event-id
    dedup). Collective: **authenticated YES**, **replay-safe only within the RPC** (no event-id
    store) — verify (P2-4).
12. **Are secrets protected?** — **YES** (no value leaks); P3 hygiene items on `?secret=` URLs and
    provider-error strings.

---

## FINAL STATUS

# SHIP AFTER FIXES

The Edge Function code that was provided is production-grade: it verifies Stripe signatures before
writing, gates every privileged Collective route before touching the database, never fabricates a
grade or a CLV from a missing close, and is idempotent across ingestion and settlement. Nothing in
it lets a client forge a subscription or bypass Edge-layer authorization.

It is **not SHIP** for two reasons, in priority order:

1. **The layer that actually enforces per-user isolation was not provided.** Postgres RLS policies
   and the `SECURITY DEFINER` RPC bodies are where user-A-cannot-touch-user-B is (or isn't)
   enforced, and where the front end's public anon key is (or isn't) contained. Per the operator's
   own rule, **the status cannot be SHIP while that layer is unverified.** Ship gate #1 is
   unanswered.

2. **Two integrity controls ship in their permissive default and must be set/confirmed:**
   - `CLOSE_REQUIRE_SHARP=true` (or segment the Record's CLV by `closing_has_sharp`) so the headline
     CLV is a *sharp* CLV — P1-1.
   - "Verify JWT" ON for `team_brief`, `run_slate`, `project_game`, `odds`, `ingest_mlb`,
     `ingest_multisport`; add the `CRON_SECRET` gate to the two ingesters for consistency — P2-1/3.

**Required before ship:**
(a) Provide/verify RLS + RPC bodies and run the IDOR matrix in *RLS Findings*.
(b) Provide the unpasted functions (`capture`, `collective_public`/`_embed`/`_ingest`/`_odds*`,
`close_backfill`, `cfb_close`, `wta_close`, `model_conf_odds`, `model_props`, `cfb_flag`) so the
CLV-source, entry-price-write, and Collective-publish paths are traced end to end.
(c) Land the two config changes above.
(d) The `modelKey` fix is done (this pass); ship it with the rest.

Once (a)–(c) are verified, re-run this audit against the RLS layer; if that layer is as sound as the
Edge code, the status moves to **SHIP**.

*This audit does not claim the system is "100% secure." It reports evidence-backed production
readiness and names exactly what remains unverified.*
