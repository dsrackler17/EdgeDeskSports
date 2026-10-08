# Growth engine — Phase 1 audit (2026-10-08)

What existed before the growth-engine change, what was working, what was broken
or missing, and what was reused. Every finding below was read from the
repository. The live site could not be fetched from the build environment, so
anything about live behaviour is marked as **inferred** from how GitHub Pages
and Supabase normally behave.

## 1. What already existed (and was reused, not rebuilt)

| Area | What exists | Status |
|---|---|---|
| Public research pages | `/articles/<slug>/` — one static, crawlable page per featured matchup, built from the terminal's own research payload (`tools/articles/`), with publication checks, an editorial quality gate (`tools/editorial/quality.js`, floor 70) and pregame → postgame pairs graded against the box score. 543 records: 45 published, 458 `ready`, 22 draft, 18 `ready_too_late`. | **Working — this IS Phase 2.** Extended, not duplicated. |
| Sitemaps | `sitemap.xml` is an index of `sitemap-pages.xml` (hand-kept) and `sitemap-articles.xml` (rewritten per build). Drafts never listed. | Working, with defects (below) |
| robots.txt | Present, well commented; disallows `/admin/`, `/tools/`, previews. | Working, needed rules for the new tools |
| Structured data | Articles: `Article`, `SportsEvent`, `BreadcrumbList`. Hubs: `CollectionPage` + `ItemList`. Landing: `Organization`, `WebSite`, `SoftwareApplication` with the $49.99 offer. | Working, with defects |
| Analytics | GA4 `G-1PXVBV53FZ` on the landing page, terminal, methodology, sample, legal and Games pages. First-party funnel `user_events` (`supabase/funnel.sql`, `lib/edgedesk_track.js`). Bing verification meta. | Partial (below) |
| Attribution | `supabase/growth.sql`: `acquisition_visitors`, `user_acquisition`, `acq_track_visit`, `acq_claim`, first touch write-once, source classifier; admin funnel by source. | Working on two pages only |
| Trials & paid | Funnel triggers on `subscriptions` / `stripe_events` (`trial_started`, `subscription_started`, `subscription_cancelled`); `growth_customer_facts()`. | Working |
| Newsletter | `supabase/newsletter.sql` + `newsletter` edge function + `tools/newsletter/` pipeline: double opt-in, CFB and NFL weekly editions, Resend, RFC 8058 one-click unsubscribe, signed webhooks, bounce/complaint suppression. | Working, with security gaps (below) |
| Suppression | `newsletter_suppress` is SECURITY INVOKER, revoked from anon/authenticated, granted to the service role only; every client door needs the subscriber's 64-hex token. | **Already fixed** before this change, with a 52-check suite |
| Referrals | `supabase/affiliates.sql`: codes, clicks, first-valid attribution, self-referral and existing-customer guards, commission ledger with holds; **nothing pays automatically** (an admin records a payout reference). | Working; no fraud review report |
| Outbound | `supabase/growth_outbound.sql` + five edge functions: evidence-based prospect research, drafts, **hash-locked human approval**, test mode, caps, suppression, UTM tagging at send, conversion matching. | Working; every email linked to one page |
| Admin dashboards | `/admin/growth/` (activation, acquisition funnel, outbound), `/admin/funnel/`, `/admin/affiliates/`, `/admin/newsletter/`, `/admin/articles/`. | Working; no channel/MRR/search view |
| Trial checkout | `lib/edgedesk_pricing.js`: $49.99/month, 7-day trial, live Payment Link. | Working |

## 2. Broken or missing — and what was done

### Critical (P0)

1. **Search and article traffic was invisible / misattributed.** Only the
   landing page and `/research/sample/` recorded a visit. A reader who came from
   Google to an article and then pressed "Start trial" arrived at the landing
   page with `edgedesksports.com` as the referrer and was classified **direct**.
   No article, hub, newsletter, record or methodology page recorded a visit, and
   no article page loaded GA4. → **Fixed:** `lib/edgedesk_public.js` on every
   public page (same first-touch rule and storage as the landing page).
2. **Newsletter and outbound traffic were not channels.** `utm_source=newsletter`
   and outbound's `utm_source=outbound` both fell through to `other`; newsletter
   emails carried no UTM at all. → **Fixed:** `newsletter` and `outbound_email`
   sources (constraints widened in place); newsletter links tagged at render.
3. **Shell injection in `.github/workflows/newsletter.yml`.** The `to`, `sport`
   and `phase` dispatch inputs were interpolated into `run:` scripts that hold
   `SB_SERVICE_ROLE` and `RESEND_API_KEY`; `to` can be set from the operator
   console through the edge function with no validation. → **Fixed:** inputs
   pass as environment variables, each checked against a closed list or an
   address pattern; the edge function validates the address too.
4. **Live unsubscribe tokens printed to public Actions logs** on a test send.
   → **Fixed:** addresses masked, tokens cut to four characters.
5. **`newsletter_cron` was callable by anyone** (deployed `--no-verify-jwt`, no
   check of its own); the debounce limited how often, not who. → **Fixed:** the
   caller must hold the service role (what pg_cron sends) or be a signed-in
   newsletter operator.
6. **Confirm on GET.** A link scanner could complete somebody's double opt-in;
   and Supabase serves an Edge Function's HTML as plain text, so readers saw raw
   markup (inferred from the repository's own notes). → **Fixed:** GET routes
   redirect to static site pages; confirming and changing preferences are button
   presses.
7. **A stranger could add topics to a confirmed subscriber** from the public
   form (the signup ORed new sports in). → **Fixed:** a confirmed address is not
   changed; it is mailed its own preferences link, once per cooldown.
8. **No global signup cap, no honeypot, per-source cap skipped when the client
   address was missing**, ~96 confirmations a day possible to one victim.
   → **Fixed:** hourly global cap, per-address daily cap, honeypot, keyed
   client-address hash with an "unknown" bucket, 254-character limit, error
   text no longer returned to anonymous callers.

### SEO (P1)

9. **14 published pages linked to articles that do not exist** (postgame →
   unpublished pregame, pregame → draft postgame). → **Fixed:** links are drawn
   only to published pages; a test fails on any dead article link.
10. **Every `og:image` was an inline SVG data URI**, which no social platform
    fetches; the landing page and hubs had none. → **Fixed:** a real 1200×630 PNG
    (`/assets/og/edgedesk-research.png`) on every public page.
11. **Canonicals pointed at redirects.** Article and hub canonicals, `og:url`,
    JSON-LD and sitemap entries had no trailing slash, while GitHub Pages
    answers `/articles/x` with a 301 to `/articles/x/` (inferred, standard
    behaviour). → **Fixed** for articles, hubs and the new pages. **Not changed:**
    the `/games` pages have the same pattern (they belong to the Games system and
    its own suites); the SEO report lists them as warnings.
12. **No trial CTA on any article** (the only CTA opened the terminal, which
    asks a signed-out visitor to sign in). → **Fixed:** a trial strip near the
    top and at the end, with the terms worded by `lib/edgedesk_pricing.js`.
13. **No related-matchup links** (only hubs and the terminal). → **Fixed:** "More
    EdgeDesk research" (six nearest published games) and links to the tools,
    methodology and newsletter.
14. **Played pregame pages said "hourly" forever** and nothing marked them as
    played. → **Fixed:** a "this game has been played" notice linking to the
    postgame when published; `yearly` in the sitemap.
15. **The sitemap index stamped the build time on every run.** → **Fixed:** each
    child's newest `lastmod`.
16. **Missing from the sitemap / no canonical:** methodology, record, legal
    pages' canonicals and descriptions. → **Fixed.**
17. **Hub weight:** every card's inline SVG was rendered in five orderings
    (734 KB). → **Fixed:** drawn once.
18. **Meta description bug** ("prices Missouri at Kansas at Kansas +4.6").
    → **Fixed** in the generator (applies as records refresh).
19. **No Google Search Console verification in the repository** (Bing's is
    there). It may be verified by DNS, which a repository cannot show. → Not a
    code fix: see the deployment checklist.
20. **Unpublished drafts are publicly served as JSON** at
    `/articles/data/records/*.json` (498 unpublished records with full research
    payloads), and the full model outputs are public at `/football/**.json` —
    the terminal itself reads them. → `robots.txt` now keeps crawlers out of
    `/articles/data/` and `/supabase/`. **Not changed:** moving data out of the
    served tree is an architectural decision for the owner.

### Missing (P2/P3)

21. No public `/tools` (the path held build scripts). → Built three tools under
    it; robots allows exactly those pages.
22. Newsletter had two topics only. → Added "major model-vs-market findings"
    and "occasional product updates" (separate consent). **Note:** no sender for
    findings or product emails exists yet; the preference is captured.
23. No MRR anywhere; no revenue by channel; no Search Console data; no
    outbound-by-landing view; no referral review. → `supabase/growth_engine.sql`
    and `/admin/acquisition/`.
24. Outbound sent every prospect to the home page. → Landing page chosen from
    the prospect's record, with its reason, inside the approved content.
25. No weekly growth report. → Frozen every Monday by pg_cron into the database
    (never to a public log).

## 3. Lower-severity findings, reported and not changed

- `editorial_cron` and `research_cron` are, like `newsletter_cron` was,
  `--no-verify-jwt` workflow pokes with no caller check. Same fix applies; left
  alone because pg_cron is their primary scheduler and a stale
  `edgedesk.service_key` would silence them. Recommend applying the same check
  after confirming the key.
- Other workflows interpolate `inputs.sport` into shell (`settle-finals`,
  `sync-schedule`, `football-regrade`, `tennis-live`); only repository writers
  can dispatch those.
- Lifecycle tip emails carry `List-Unsubscribe` without `List-Unsubscribe-Post`
  (the target is a static page, which cannot take the one-click POST).
- `lifecycle_due()` honours only bounce/complaint suppressions, not a newsletter
  unsubscribe (they are different consents; worth a deliberate decision).
- Growth consoles are "any `affiliate_admins` member" (seeded with the owner
  only); outbound is stricter (its own owners table).
- Partner program: no same-card/device checks existed — the new report flags
  shared browser, shared Stripe customer, shared card fingerprint (when charge
  events are stored), bursts and refunds. Nothing acts on a flag.
- Articles: titles and descriptions run past what results show (60/160
  characters); reported as warnings by the SEO audit.
- `tools/articles/community.test.js` "a subscriber is told their post goes
  live" fails on the base branch as well (date-dependent); unrelated.

## 4. Decisions left to the owner

1. **Auto-publishing.** 458 research records pass their publication checks and
   sit at `ready` because `auto_publish` is off; the editorial path publishes
   NFL 4 / CFB 6 featured games a week above a quality floor of 70. More pages
   means more search surface, but the brief also says no thin pages. The
   switch is in `/admin/articles/`.
2. **The draft store being public** (finding 20).
3. **Findings and product-update emails** — the consent is captured; sending
   needs an edition type in the newsletter pipeline.
4. **A written partner program policy** before any commission is approved.
