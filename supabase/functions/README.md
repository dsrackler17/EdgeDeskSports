# Edge Functions

68 functions are deployed. **Eight** of them live here now (plus `props_cron`, new, shipped by `.github/workflows/deploy-props-pipeline.yml`, and `research_cron`, new, shipped by `.github/workflows/deploy-research-cron.yml`); the other 60 exist
only as deployed artifacts, which means they cannot be reviewed, diffed, tested
or restored, and nobody can answer "what does this one do?" without opening the
dashboard.

The three that arrived most recently — `collective_join`, `collective_public`
and `collective_admin` — were **pasted in, not exported**, like `close` and
`learn` before them. **Diff each against the deployed function before treating
it as authoritative:** a transcription error would be indistinguishable from a
real difference. Their headers say what changed on the way in and what did not.

They also arrived with a caveat worth stating once. Each names
`supabase/functions/_shared/` and `tools/collective/bundle_functions.py` in its
header, and **neither is in this repository** — so these bundles are not
generated from anything here. Until the sources and the bundler land, the
bundle IS the source and editing it is how the function changes. That is why
the shared blocks are duplicated across the three files rather than imported:
the dashboard bundles one folder, so an import that cannot resolve fails the
deploy silently.

`tools/supabase/download_functions.sh` pulls all of them into this directory.

```bash
npm i -g supabase                                   # or brew install supabase/tap/supabase
supabase login
supabase link --project-ref iattxbkbufslbauoumga
bash tools/supabase/download_functions.sh           # add --force to overwrite
```

The script skips anything already committed, and **scans everything it pulled
for secrets before you commit** — a service-role JWT or a live Stripe key
reaching git history is a rotate-now event, not a cleanup task.

---

## What calls what

Evidence from the shipped front end, not from the naming.

**Called directly by `app.html`**

| function | what for |
|---|---|
| `collective_ingest` | the Model Collective submission API — see its `SECURITY.md` |
| `edgedesk_ai` | the AI presentation layer |
| `odds` | odds reads |
| `props_cron` | the Props page's **Refresh prices** (`{action: 'refresh'}` then `{action: 'status'}`, under the reader's session); also the Player Props primary scheduler, poked by pg_cron (`supabase/player_props_cron.sql`) — it dispatches `player-props.yml`, it never captures a price itself. JWT verification OFF (`--no-verify-jwt`): pg_cron sends no JWT, and Refresh / status check the reader's session themselves. |
| `team_brief` | team briefs |

**Billing** (`docs/billing-hardening.md`) — three single-file functions sharing
one core (`tools/billing/billing_core.js`, copied in by
`tools/billing/inline_core.js`; `tools/billing/billing_core.test.js` fails on drift):

| function | called by | what for |
|---|---|---|
| `stripe_webhook` | Stripe | every delivery verified, recorded, resolved to an account, and answered with Stripe's live state through `billing_apply_subscription_state`. JWT verification OFF (Stripe signs with its own secret). |
| `create_checkout_session` | `index.html` (`lib/edgedesk_access.js`) | the server-created Stripe Checkout: account from the verified token, on the session, the subscription and the customer; refuses an account Stripe already has live, and a price that is not the consented figure. JWT verification OFF; the token is verified inside. |
| `sync_subscription` | `index.html`, `app.html`, `admin/billing/`, pg_cron (`supabase/billing_reconcile_cron.sql`) | reconcile an account with Stripe: the reader's own (rate-limited), after checkout, the operator's repair/link/inspect, and the debounced 10-minute sweep. JWT verification OFF; every reader action verifies the token inside, the sweep takes no identity and answers counts only. |

**Portfolio** (`docs/platform-connections.md`) — one single-file function carrying
the connector core (`lib/edgedesk_portfolio_connect_core.js`, copied in by
`tools/portfolio/inline_connect_core.js`; `tools/portfolio/connect_core.test.js`
fails on drift). Built and deployable; every connector it serves is switched
off in `portfolio_platform_registry` until its live smoke test passes:

| function | called by | what for |
|---|---|---|
| `portfolio_connect` | `app.html` (Portfolio → Accounts), pg_cron (`supabase/portfolio_sync_cron.sql`, every 10 minutes), `tools/portfolio/connector_smoke.js` | connect a read-only Kalshi key or a public Polymarket wallet (validated against the platform, the key sealed with AES-256-GCM, never returned), a reader's rate-limited sync, disconnect (deletes the key, says how to revoke it at the platform), and the scheduler's `sweep` of due accounts. Read-only: it never places, changes or cancels anything. A sportsbook is refused. JWT verification OFF (`--no-verify-jwt`); every reader action verifies the token inside, the sweep takes no identity and answers counts only. Secrets: `PORTFOLIO_CREDENTIAL_KEYS`, `PORTFOLIO_CREDENTIAL_KEY_VERSION`. |

**Outbound** (`docs/growth-outbound.md`) — four single-file functions, none
holding a service-role key. The send and research functions carry the owner check
(`tools/growth/outbound_auth.js`, copied in by
`tools/growth/inline_outbound_auth.js`; `tools/growth/outbound_send.test.js`
imports the deployed file and fails on drift); the webhook and opt-out
functions hold nothing but the public anon key
(`tools/growth/outbound_events.test.js` imports both). All four are deployed
by `.github/workflows/deploy-growth-outbound.yml` (manual):

| function | called by | what for |
|---|---|---|
| `growth_outbound_send` | `admin/growth/` (Outbound → Review queue → Send) | sends an APPROVED outbound draft, only when the owner presses Send: the owner verified (GoTrue, then `growth_outbound_is_owner()` as the caller), the send claimed in the database first, Resend called with one Idempotency-Key per draft, the answer recorded. Also `{action: 'domain_check'}` (Phase 12; sends nothing): the sending domain's SPF, DKIM and DMARC read over DNS-over-HTTPS, recorded; a missing record blocks live sending. Holds no service-role key: every database call is the caller's. JWT verification OFF (`--no-verify-jwt`); the owner is verified inside. Secret: `RESEND_API_KEY`. |
| `growth_outbound_webhook` | Resend (a webhook endpoint of its own) | relays Resend's events about outbound email: the raw body and the three Svix headers go to `growth_outbound_webhook()` as anon, and the DATABASE checks the signature with the secret it holds (set in the SQL editor), refuses repeats, then applies delivered / bounced / complained / opened / clicked. Unsigned → 401; the database unreachable → 503 (Resend retries). No secret in the function. JWT verification OFF. |
| `growth_outbound_research` | `admin/growth/` (Outbound → Discover and research; Research again) | the research engine, owner only: Brave Search results become candidates; research reads a candidate's own pages (robots.txt obeyed, SSRF-guarded), stores each page, and records facts only as quotes Claude proposes and the function and the database both verify; a business address from their own site or Hunter's find for that named person, then Hunter's verifier. Every provider call is counted against the database's daily budget first. Also the morning run's search and research steps (`{action: 'scheduled', ticket}` from pg_cron through pg_net: no owner token, every call through `growth_outbound_scheduled`, which checks the ticket). Never approves, drafts or sends. Uses `npm:@anthropic-ai/sdk` (bundled at deploy). JWT verification OFF; the owner is verified inside. Phase 12: providers sit behind interfaces and are switched on in the console (Brave and Apollo search; Hunter and Apollo email lookup; Hunter verification; Clay enrichment by its table's webhook); `{action: 'verify'}` puts waiting addresses to the verifier, `{action: 'enrich'}` posts the enrichment queue to Clay. Secrets (each optional): `BRAVE_SEARCH_API_KEY`, `HUNTER_API_KEY`, `ANTHROPIC_API_KEY`, `APOLLO_API_KEY`, `CLAY_WEBHOOK_URL`, `CLAY_WEBHOOK_TOKEN`; `OUTBOUND_RESEARCH_MODEL` optional. |
| `growth_outbound_draft` | `admin/growth/` (Outbound → Review queue → Write the next drafts; a prospect → Let the engine write it) | the drafting engine, owner only: for each prospect due a first email or a follow-up, Claude writes from the facts the database says may be cited (each sure enough on its own) and the established first name, and the DATABASE decides (`growth_outbound_draft_propose`): every claim is that person's evidence in its own words, nothing specific comes from nowhere, the greeting names an established first name or none, the content rules hold. Refused, Claude gets the objections and one more try; then a plain template from the best fact, checked the same way. Accepted drafts wait in the review queue. Also the morning run's drafting step (`{action: 'scheduled', ticket}`, as for research). Never approves, edits or sends. Uses `npm:@anthropic-ai/sdk` (bundled at deploy). JWT verification OFF; the owner is verified inside. Secrets: `ANTHROPIC_API_KEY` (optional: without it, the template writes); `OUTBOUND_DRAFT_MODEL` optional. |
| `growth_outbound_optout` | every outbound email (footer link and `List-Unsubscribe`) | the RFC 8058 one-click POST stops all email to that send's address (`growth_outbound_optout()` with the send's 64-hex token). A GET changes nothing: it 303-redirects to `/email/stop/#t=…`, which shows the masked address and asks. Optional env `OUTBOUND_OPTOUT_PAGE`. JWT verification OFF. |

**Called directly by `newsletter/index.html` and `admin/newsletter/index.html`**

| function | what for |
|---|---|
| `newsletter` | the whole public door: `/subscribe` (topics, a separate product-update consent, a honeypot, keyed client-address hashing; a CONFIRMED address is mailed its own preferences link instead of being changed), `/confirm` and `/preferences` and `/unsubscribe` on GET **redirect** to the site's static pages (`/newsletter/confirm/`, `/newsletter/manage/`, token in the `#fragment`) so a link scanner changes nothing and nobody sees Supabase's plain-text rendering of HTML; the RFC 8058 one-click POST to `/unsubscribe` is unchanged; `/webhook` (signature-verified provider events; an outbound email's events, tagged `edgedesk=outbound`, are acknowledged and not kept) and `/dispatch` (operator only, the caller's own token checked against `newsletter_is_admin()` before the GitHub token is touched; a test address must be one plain address). Deployed `--no-verify-jwt`: a mail client posting a one-click unsubscribe carries no session, and neither does a provider webhook. |
| `newsletter_cron` | the newsletter's primary scheduler. Pokes `newsletter.yml` by `workflow_dispatch`; it does not send anything itself, for the reason `editorial_cron` does not publish anything itself. Deployed `--no-verify-jwt`, so it checks the caller itself (2026-10): the bearer must be the service role, which pg_cron sends (`supabase/newsletter_cron.sql`), or a signed-in newsletter operator's token. |

**Called by pg_cron only**

| function | what for |
|---|---|
| `research_cron` | the Personal research state job's primary scheduler (`supabase/research_state_cron.sql`, every five minutes). It dispatches `research-state.yml`, which writes `game_research_state` for the landing page and the terminal, when the newest state is older than 55 min (25 min inside 24 h of a kickoff), never twice inside one cadence. It never writes a state itself. JWT verification OFF (`--no-verify-jwt`): pg_cron sends no JWT. Its GET is a public health probe carrying `BUILD`. It reads `RESEARCH_GH_TOKEN`, then `PROPS_GH_TOKEN`, then `EDITORIAL_GH_TOKEN`. |

The newsletter pipeline itself is `tools/newsletter/`, run by
`.github/workflows/newsletter.yml`; it reaches the database over PostgREST with
the service role and no function is in that path.

**Called directly by `collective/index.html`** (the Collective's own site)

| function | what for |
|---|---|
| `collective_public` | the wall, the board, the rules, and every dashboard route — including `/v1/dashboard/submit`, which is what the uploader posts a slate to |
| `collective_join` | the invite flow, and `POST /v1/models` to cover another sport |
| `collective_admin` | the founder console (`collective/admin.html`) |
| `collective_odds` | the market panel |

`collective/index.html` also calls two SECURITY DEFINER routines over PostgREST
directly rather than through any function: `public.collective_model_ensure` and
`public.collective_my_models`, installed by
`../collective_model_autocreate.sql`. That is deliberate — a capability every
one of these functions needs is defined once, in the database, instead of three
times in three bundles that cannot import from each other.

**Everything else is a scheduled job or a webhook.** A cron job is load-bearing
if the app reads a table it writes — and a function whose header calls it a
cron job is not evidence that a cron exists. `capture` said so for its whole
life and **nothing was calling it**, which is how a customer came to be shown a
thirty-nine-hour-old price. Its schedule is now
`../capture_cron.sql` (pg_cron, primary) with
`.github/workflows/capture.yml` as the independent backup, and
`tools/intelligence/deploy_doctor.js` fails when the board stops being filled.
Before trusting any other row of this table, check `cron.job` rather than the
file header:

| the app reads | fed by |
|---|---|
| `signals`, `signal_ticks`, `book_quotes` | `capture`, `odds`, `close`, `close_backfill`, `settle` |
| `model_predictions`, `model_weights`, `model_calibration`, `model_brier` | `model_predict`, `recalibrate`, `model_grade`, `model_conf_grade` |
| `mlb_bullpen_team`, `mlb_bullpen_taxed`, `pitcher_features` | `bullpen_sync`, `ingest_mlb`, `mlb_sync`, `ingest_pitcher_season` |
| `golf_stats`, `model_golf` | `capture_golf`, `model_golf`, `grade_model_golf` |
| `stats_players`, `player_stats` | `capture_players`, `capture_players_espn`, `capture_stats` |
| `venue_weather` | `venue_weather`, `weather_sync` |
| `offense_features` | `ingest_nfl_features` |
| `news` | `capture_news` |
| `rankings_current` | `cfbd_rankings`, `rankings_standings` |
| `model_props` | `model_props`, `grade_props` |
| `subscriptions` | `stripe_webhook`, `sync_subscription`, `create_checkout_session` — billing, all through `billing_apply_subscription_state` |

**`park_bearings_sync` is referenced nowhere in `app.html`** — the only one of
the 68 with no footprint in the shipped front end. That is a lead, not a
verdict: it may feed another job. Check before retiring it.

## Before retiring anything

A function is safe to retire only when all four are true, and the fourth is
the one people skip:

1. no front-end call site;
2. no cron schedule (`select jobname, schedule, command from cron.job;`);
3. nothing reads the tables it writes;
4. **its last invocation is old** — check the dashboard, not your memory.

## The shape of the estate

`capture` covers `americanfootball_ncaaf` and `americanfootball_nfl` only. The
app still renders MLB and golf surfaces from tables other jobs feed, so the
football pivot reached capture but not the estate around it. That gap is the
thing worth deciding about deliberately. (Tennis and WTA were retired from
the app; their tables and jobs remain, dormant, in the backend.)

**UFC no longer depends on any Edge Function.** The Live Fight Center reads the
contract in `../ufc_live_center.sql`, which GitHub Actions fill directly over
PostgREST with the service role (`.github/workflows/ufc-sync.yml`,
`.github/workflows/ufc-live.yml`, scripts in `tools/ufc/`). The deployed
`ufc_live` and `ufc_live_stats` functions — never committed here — are no
longer read by anything in `app.html` and can be retired once their cron
schedules are removed; the fighter dataset itself is still built by the
deployed `ufc_fighters_sync` / `ufcstats_sync` jobs, which this change does not
touch.
