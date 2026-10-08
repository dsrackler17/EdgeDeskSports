# EdgeDesk product-led growth — audit and plan

**Goal:** make EdgeDesk a place football fans and bettors visit every week, with
a free research experience worth returning to and an upgrade that is worth
paying for. The offer does not change: free research with no card, and
EdgeDesk Full Access at **$49.99/month with a 7-day free trial**
(`lib/edgedesk_pricing.js` is still the one place it is written). The
positioning does not change: **Research, not picks.**

This document is the audit that came first (2026-10-08), the plan it led to,
and what Phases 1 and 2 changed. Read the audit before building anything in
Phases 3–5: most of what those phases need already exists.

---

## 1. Audit — what exists

### Billing and access (do not rebuild)

| Piece | Where | State |
|---|---|---|
| The access rule | `supabase/billing_hardening.sql` `billing_row_grants_access` | active/trialing inside the period, `owner_comp`, past_due for 21 days |
| The decision for the caller | `my_billing_access()` (authenticated only) | used by both pages through `lib/edgedesk_access.js` |
| Checkout | `supabase/functions/create_checkout_session` (refuses an entitled account), Payment Link fallback | live |
| Stripe → database | `stripe_webhook`, `sync_subscription`, `billing_apply_subscription_state` (service role only) | live |
| The offer | `lib/edgedesk_pricing.js` (`PRICE_CENTS` 4999, `TRIAL_DAYS` 7, `FEATURES`) | one source; `personal_wiring.test.js` holds every page to it |
| Terminal gate | `app.html` `PAYWALL_LIVE=true`, `pgCheck`/`pgBoot` → `EDAccess.read` | every non-subscriber is locked out of the terminal |
| Tests | `billing:test`, `billing:sql`, `billing:e2e`, `intel:test` §32 | green at the start of this work |

### Free surfaces (do not rebuild; re-arrange)

| Surface | URL | Works? | Data | Notes |
|---|---|---|---|---|
| No-vig calculator | `/tools/no-vig-calculator/` | **yes** — four methods, working shown | none (client-side, `lib/edgedesk_odds_tools.js`) | indexable |
| Fair odds calculator | `/tools/fair-odds-calculator/` | **yes** | none | indexable |
| Model vs. market explorer | `/tools/model-vs-market/` | **yes** | `public_home_board()` — ≤8 games, no EV, no props | indexable |
| Research articles | `/articles/` (+ `/nfl/`, `/college-football/`) | **yes** — 46 published, rebuilt every 3 h | static HTML | indexable; no gating inside |
| Sample game research | `/research/sample/` | **yes**, when an admin marks a game public | `public_sample_research()` | `noindex` |
| Landing research preview | `/#research` | **yes** | `public_home_board()` + `football/home/board.json` | shows one prop with EV as a teaser |
| Public record | `/record.html` | **yes** | public views | |
| Weekly research email | `/newsletter/` | signup **yes**; sending is off until `newsletter_settings.sending_enabled` | `newsletter.sql` | double opt-in, topics, one-click unsubscribe, member/free variants |
| EdgeDesk Games | `/games/` | **yes** | | free prediction games, not a schedule |
| CFB research terminal | `/research/cfb/` | **yes** — the whole CFB board | committed static JSON, **no sign-in** | `noindex`; owner's gating decision pending |
| Process Coach, Weekly Film Room, calendar view, account connections | — | **in development** | | labelled "Soon" / "In development" everywhere |

### Growth, engagement and analytics (do not rebuild; extend)

- **Event stream:** `supabase/funnel.sql` — `user_event_kinds` registry, `user_events`, `ed_track()` (capped), server events for `account_created`, `trial_started`, `subscription_started/cancelled`; `funnel_admin_report()` with signup → trial → paid rates and d1/d3/d7 retention for trials.
- **Attribution:** `supabase/growth.sql` — first/last touch, `acq_classify` channels, `growth_admin_funnel` by source; `lib/edgedesk_public.js` on every public page except the landing page (which has its own).
- **Acquisition dashboard:** `supabase/growth_engine.sql` → `/admin/acquisition/` — channels, landing pages, campaigns, **free tool use**, CTAs, newsletter, MRR.
- **Saved research:** `supabase/personal_research.sql` — `watchlist_games` (200), `research_journal`, owner-only RLS. The UI is inside the paywalled terminal, so free accounts cannot save anything today.
- **Email:** weekly CFB (Mon) and NFL (Tue) newsletter; four trial lifecycle emails; all with unsubscribe tokens; Resend.
- **Cost controls:** odds capture has credit and quota budgets (`capture/index.ts`); the AI desk has per-isolate rate limits and per-mode token caps, no persistent budget.
- **Flags:** no general system — per-feature settings rows (`newsletter_settings`, `lifecycle_settings`, …), `cfb_feature_flags`, `PAYWALL_LIVE`, edge env toggles.
- **Migrations:** hand-pasted, idempotent, guarded SQL files that end in a report (`supabase/README.md`); many `*_sql.test.js` suites run them against a real PostgreSQL.

---

## 2. Audit — what must be fixed before a free tier (P0)

These are authorization findings. A free tier makes more people sign in, so
each one matters more after Phase 4 than it does today.

1. **The AI desk let the public anon key through — fixed in this change.**
   `edgedesk_ai`'s gate treated a 401 from the subscriptions read as "could
   not be checked" and admitted the caller; anon cannot read that table, so
   the key in every page's source got paid inference. It now refuses an
   `anon` token and any 401/403, keeps 404/5xx fail-open (an outage does not
   lock out paying readers), and uses the database's 21-day past_due grace
   instead of 3. **Takes effect only after the Deploy intelligence workflow
   runs** (build `edgedesk_ai-2026-10-08-r21-anon-gate`).

2. **Premium research is public as committed files. Not fixed here — needs
   its own project (Phase 2b).** The repository is public and GitHub Pages
   serves the whole tree, so these are readable by anyone, signed in or not:
   `football/cfb_terminal/*.json` (fair lines, EV, decisions for every FBS
   game), `football/props/**` (the player-prop boards), `football/nfl/slate.json`,
   `football/fbs/slate.json`, `football/cfb_ev/*`, `football/markets/*`,
   `football/validation/*`, and the `/research/cfb/` page renders the CFB
   board with no sign-in. The terminal's paywall is a UI overlay for this data.
   What *is* enforced on the server: `game_research_state` (`edp_entitled`),
   tennis, community publishing, the AI desk, and — per the docs — `signals`
   / `model_predictions` RLS in a `paywall.sql` that is **not in this repo**.

   **Phase 2b plan:** (a) pipelines publish premium artifacts to a private
   Supabase Storage bucket instead of committing them; (b) a small edge
   function returns a short-lived signed URL only when
   `billing_row_grants_access` says yes; (c) `app.html` reads through it, with
   a flag-guarded fallback to the static file for one release; (d) the files
   leave the Pages tree (a Pages deploy from an Actions artifact with an
   exclude list is the least disruptive way); (e) decide whether the repo
   should be private — until it is, history keeps every artifact already
   committed. Until then, *free access cannot bypass authorization that does
   not exist for these files*, and this plan says so rather than implying
   otherwise.

3. **`collective_public` uses a looser rule** (`active|trialing|past_due`, no
   period end) and admits any signed-in user while `OPEN_BOARD_UNTIL_BILLING`
   is true. Deliberate today; repoint it at `billing_row_grants_access`
   before the Collective is billed.

4. **`edp_entitled` admits everyone when `community_is_entitled` is not
   installed** (a deploy-window fallback). Confirm production has it with
   `tools/billing/prod_probe.js`.

5. **Commit `paywall.sql`.** The RLS on `signals` and `model_predictions` lives
   only in production. It cannot be reviewed or regression-tested from here.

6. **`public_home_board()` returns up to 3 prop EVs for each of 8 games**
   to anonymous callers; the landing page prints one. Trim the RPC to what the
   page prints when its SQL is next touched (cost: one SQL paste; the landing
   e2e fixture regenerates from `home_sql.test.js`).

---

## 3. The plan, by phase

### Phase 1 — homepage and navigation (this change)

- **One primary navigation everywhere:** Free Research (`/articles/`),
  Today's Games (`/today/`), Tools (`/tools/`), Research Terminal
  (`/app.html`), Pricing (`/#pricing`). Written once in `lib/edgedesk_nav.js`;
  static markup on every page so crawlers see the links;
  `tools/site/nav.test.js` fails when a page drifts. The article generator
  renders it from the same module.
- **Homepage, free research first:** the hero leads with free research and a
  working no-vig calculator, the trial is the second action with its terms
  beside it, a new `#free` section (today's games, latest research, the free
  tools, the weekly email) comes before any subscription pitch, and the live
  model-vs-market preview moves up behind it. The story sections, pricing,
  trust, FAQ and close follow. Pricing gains a Free column beside Full Access.
- **Today's Games (`/today/`):** every upcoming NFL and FBS game in the next
  eight days, grouped by day in the reader's time zone, each with its free
  published research where it exists and EdgeDesk's public status where the
  public board has it, and a specific line about what Full Access adds for
  that game. Reads `football/home/schedule.json` (teams, kickoff, venue — no
  model numbers; built by `tools/home/build_home.js` on the existing props
  schedule), `public_home_board()` and `/articles/data/published.json`. No new
  server endpoint, no new API calls.
- **Mobile:** every header wraps to a full-width row ≤640 px, the landing
  menu stays a disclosure, nothing wider than a 320 px screen (landing and
  public-page e2e at phone widths).
- **Search:** `/today/` is indexable and in `sitemap-pages.xml`; the SEO
  audit covers it; no public page gains a `noindex` or loses a canonical.

### Phase 2 — freemium access (this change)

- **`lib/edgedesk_plans.js`** — the one written map of what is free, what is
  Full Access and what is planned: each item's status (`live` / `planned`),
  where it lives, and which door serves it (a public page, an anonymous
  public-subset RPC, or a server check). The landing page's Free column is
  held to it by test; a `planned` item can never be printed as available.
- **`lib/edgedesk_flags.js`** — UI feature flags with defaults. Flags only
  switch UI; `tools/site/free_access.test.js` fails if the access client or
  the terminal's paywall reads one.
- **Free stays free, paid stays paid** (`tools/site/free_access.test.js`):
  public pages call only the allow-listed anonymous doors; no public page
  fetches a premium artifact; every allow-listed RPC is granted to anon in
  SQL and every premium one is not; no served file carries a secret (every
  JWT in a served file decodes to `role: anon`); `PAYWALL_LIVE` stays on.
- **What is free today:** published research articles, Today's Games with
  public statuses, the model-vs-market sample, the sample game, the no-vig
  and fair odds calculators, the public record, the weekly email, Games.
- **Reserved for Full Access:** the full research boards, player props and
  the prop board, EdgeDesk EV at the exact price, the decision engine and its
  card, bet journal, P&L and CLV, decision-quality analytics, Intelligence.
  These stay behind `PAYWALL_LIVE` and the server checks above — with the
  Phase 2b caveat for the committed artifacts.

### Phase 3 — conversion (next)

- `lib/edgedesk_upgrade.js`: one inline, benefit-specific prompt per request
  for depth ("Full Access shows EdgeDesk's fair line at every book for this
  game and the EV at the exact price"), rendered in place — never a modal,
  never on first use of a free tool, never a countdown. Copy from
  `EDPricing` only.
- Two event kinds, added to `user_event_kinds` (additive):
  `upgrade_prompt_viewed`, `upgrade_prompt_clicked`, each with the feature.
- The terminal's paywall (`pgLockedHTML`) names the feature the reader asked
  for instead of one generic lock.

### Phase 4 — engagement (next)

- **Free accounts.** Today `PAYWALL_LIVE` locks every non-subscriber out of
  `app.html`, so a free account can do nothing a signed-out visitor cannot.
  Add a free mode behind a flag: a signed-in reader without access gets a
  **Week dashboard** — upcoming NFL and FBS games (the `/today/` sources), the
  free research, their saved items and the weekly email preference — and the
  rest of the terminal stays locked exactly as it is.
- **Saved research, limited.** Reuse `watchlist_games` and
  `research_journal`; add a quota trigger (e.g. 10 saved games for an account
  without access, the existing 200 with it) that reads
  `billing_row_grants_access` — enforced in the database, not the page. One
  additive, idempotent SQL file with its own `*_sql.test.js`.
- **Weekly email.** Already built. Surface `newsletter_my_preferences` on the
  free dashboard; no new sender. Unsubscribe and preference tokens stay as
  they are.
- **Cost.** The dashboard reads committed or cached public data only (the
  60-second board cache, static JSON). No AI for free accounts. No odds API
  call is triggered by a page view.

### Phase 5 — analytics (next)

Most of the eight metrics are already measured (see the table below). The
gaps, each an additive view or RPC beside `funnel_admin_report`:

| Metric | Today | To add |
|---|---|---|
| Visitors to free research tools | `tool_used`, `public_page_view` → `/admin/acquisition/` | `/today/` as a tool (`tool_used` entity `todays_games`) — done in Phase 1 |
| Free account registrations | `account_created` | split "free" (no trial within 7 days) from "trial at signup" |
| Research interactions | terminal events, entitled only | free-dashboard events (`free_game_saved`, `free_research_opened`) |
| 7- and 30-day returning users | `return_day_1/3/7` for trials; anonymous CFB terminal return rate | one RPC over `user_events` by visitor hash and account: active on 2+ distinct days in 7 / 30 |
| Free → trial | `funnel_admin_report.rates.trial_start` | by free-account cohort |
| Trial → paid | yes | — |
| Paid retention | "2+ paid invoices", MRR | monthly cohort curve from `growth_invoice_payments` |
| Acquisition source | yes (first/last touch, UTM, channels) | — |

---

## 4. What not to rebuild

Billing (`EDAccess`, `my_billing_access`, checkout, webhook, sync), the offer
file, attribution (`growth.sql`, `edgedesk_public.js`), the event registry and
`ed_track`, the newsletter and lifecycle email systems, the free calculators
and their arithmetic, the article pipeline, `public_home_board()` and its
cache, the sample research, the admin dashboards, and the odds capture
budget. Each is tested and in production; the phases above compose them.

---

## 5. What Phases 1–2 shipped (this change)

| Commit | What |
|---|---|
| `security: AI desk refuses the public anon key…` | P0 #1 above; 13 new checks in `intel:test` §32, all failing on the old gate |
| `today: a free Today's Games page…` | `/today/`, `football/home/schedule.json` (built by `tools/home/build_home.js`), `lib/edgedesk_flags.js` |
| `nav: one primary navigation…` | `lib/edgedesk_nav.js` + `.css`, every public header, articles rebuilt, `tools/site/nav.test.js` |
| `access: one map of free, paid and planned…` | `lib/edgedesk_plans.js`, `tools/site/free_access.test.js` |
| `home: free research first` | hero (free research first, a working no-vig calculator), `#free`, the Free card, FAQ; `lib/edgedesk_home_free.js` |
| `billing: the checkout browser suite runs again` | `tools/billing/checkout_flow.e2e.js` repaired (it failed on main) |

**Measurement added without new SQL:** `tool_used` with entity `todays_games`
(paired with page `tool:todays-games` in `/admin/acquisition/`) and
`no_vig_home` (the hero calculator); `cta_clicked` names for every new
action (`hero_free`, `nav_*`, `free_*`, `today_*`, `pricing_free`,
`final_free`, `strip_how`); GA `hero_free_click` and `hero_calc_used`.

**Run before merging:** `npm run site:test`, `npm run funnel:test`,
`npm run growth:engine:test`, `npm run personal:test`, `npm run billing:test`,
`npm run articles:test`, `npm run intel:test`, the three
`tools/presentation/landing_*.test.js`, and with Playwright
`tools/home/landing.e2e.js`, `tools/growth/public_pages.e2e.js`,
`tools/billing/checkout_flow.e2e.js`.

**Watch:** the landing page is at 204,496 of its 204,800-character budget
(`landing_interaction.test.js`); the next addition to it should move
something into a library first.

## 6. Rollout and rollback for Phases 1–2

- Static pages only, plus one AI function fix. No SQL changes.
- **Deploy:** merge (GitHub Pages publishes); run *Deploy intelligence* with
  `deploy_function = true` for the desk fix.
- **Rollback:** revert the merge. `football/home/schedule.json` is additive
  and unused by anything else; deleting it makes `/today/` fall back to the
  public board's games.
- **Flags:** `EDFlags` `home_free_section` and `today_live_data` switch the
  new data-driven parts off without a revert.
