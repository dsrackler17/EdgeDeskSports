# The growth engine

*Research, not picks.* Organic discovery, free tools, the newsletter, outbound
and referrals, measured end to end:

**visitor → research page or tool → trial → paid → retained, by channel.**

Nothing here rebuilt an existing system. The research pages are the existing
`/articles/` pipeline; attribution is `supabase/growth.sql`; events are
`supabase/funnel.sql`; the newsletter, the outbound engine and the partner
program are the existing ones, extended. What was found first is in
[`AUDIT.md`](AUDIT.md).

## 1. What is new

| Piece | Where | What it does |
|---|---|---|
| Public-page tracker | `lib/edgedesk_public.js` | On every public page (articles, hubs, tools, newsletter, methodology, record, partners): the landing page's first-touch rule in the same storage, an acquisition visit when it can matter, a partner click on `?ref=`, a `public_page_view`, CTA presses (`data-ed-cta`), GA4 unless Global Privacy Control / Do Not Track. Never an address, a query string or a full referrer. |
| Channels | `supabase/growth.sql` | `newsletter` and `outbound_email` are sources now (constraints widened in place). |
| Page events | `supabase/funnel.sql`, `lib/edgedesk_track.js` | `public_page_view`, `tool_used`, `public_cta_clicked`, `newsletter_signup`. |
| Free tools | `/tools/`, `/tools/no-vig-calculator/`, `/tools/fair-odds-calculator/`, `/tools/model-vs-market/`, `lib/edgedesk_odds_tools.js`, `tools/tools.css` | Static, crawlable pages with the working printed. The de-vig arithmetic is held equal to the terminal's (`lib/edgedesk_ev.js`). The explorer is `public_home_board()` — the landing page's public subset (≤8 games, the four public words, no EV, no props) — judged at view time by `lib/edgedesk_home.js`. |
| Research pages | `tools/articles/article_render.js`, `build_articles.js` | Trial CTA (top and end), free-vs-paid line, "More EdgeDesk research", links to tools/methodology/newsletter, no link to an unpublished page, played-game notice, served (trailing-slash) URLs everywhere, a real share image, publisher logo, hub breadcrumbs, lighter hubs, `articles/data/published.json`. |
| Partners page | `/partners/` | Where outbound sends newsletter operators and creators. Promises nothing that is not agreed in writing. |
| Newsletter | `supabase/newsletter.sql`, `supabase/functions/newsletter/`, `/newsletter/`, `/newsletter/confirm/`, `/newsletter/manage/` | Findings and product-update topics (product has its own consent), honeypot, global and daily caps, no silent change to a confirmed subscriber, confirm/manage as button presses on static pages, UTM on every link back to the site. |
| Security fixes | `.github/workflows/newsletter.yml`, `tools/newsletter/run.js`, `supabase/functions/newsletter_cron/`, `email/unsubscribe/` | See AUDIT.md §2. |
| Acquisition dashboard | `supabase/growth_engine.sql`, `/admin/acquisition/` | Channels, landing pages, campaigns, public pages, tools, CTAs, newsletter, trials, paid, cash by channel, **MRR (measured)** and two labelled estimates, outbound by landing page, Search Console, partner attributions and review flags, weekly frozen reports. Operators only. |
| Weekly report | `supabase/growth_engine_cron.sql` | pg_cron, Monday 06:17 UTC: last week frozen into `growth_weekly_reports`. Nothing leaves the database. |
| Search Console | `tools/growth/gsc_import.js`, `.github/workflows/search-console.yml` | Daily import of clicks/impressions/CTR/position by page and query. Prints counts only. |
| Outbound landing | `supabase/growth_outbound.sql` `landing_for`, `supabase/functions/growth_outbound_draft/` | Each draft links to the page that fits the prospect's record (table below); the reason is in the context; the URL is inside the content the owner approves. |
| SEO report | `tools/seo/audit.js`, `/admin/seo/` | Every sitemap/standing page: served, crawlable (Google's robots rules), indexable, canonical, title, description, share image, structured data, broken links. Rewritten on every article build; `--check` fails CI on errors. |
| Social image | `assets/og/edgedesk-research.png` | 1200×630. |

### Outbound landing pages

| The prospect's record says | The email links to |
|---|---|
| partnership campaign, or newsletter / media / podcast / community / video operator | `/partners/` |
| quant researcher, modelling or analytics creator, betting educator, handicapper-modeller | `/tools/fair-odds-calculator/` |
| player-props analyst | `/tools/no-vig-calculator/` |
| college football only (type or sports focus) | `/articles/college-football/` |
| NFL or fantasy only | `/articles/nfl/` |
| football, both | `/articles/` |
| nothing specific, or **landing by interest** switched off | the owner's `cta_url` (as before) |

The words around the link say what the page is ("a free fair odds calculator is
at …"), never "the free trial is at" a calculator. `tag_links()` adds the
campaign code at send time; the site classifies the visit as `outbound_email`;
`/admin/acquisition/` shows sends and results by landing page. **Nothing is sent
without the owner's approval** — that gate (`drafts_guard`, `sends_guard`, the
claim door) is untouched.

## 2. What is measured, and what is estimated

Everything on `/admin/acquisition/` is a count or a sum of stored rows except
two figures named `*_estimate`: MRR net of recurring coupons, and the MRR the
trialing subscriptions would add at list price. A channel is the **first
attributable touch**; revenue by channel is **cash Stripe collected**, credited
to the payer's first touch — attribution, not causation. Search Console figures
are Google's. Whether Google has **indexed** a page is only known to Search
Console; the SEO report says whether a page is *eligible*.

## 3. Deploying

Nothing in this change touches billing, Stripe, subscriptions or entitlements.
Every SQL file is idempotent, additive (constraints are widened, never
narrowed; nothing is dropped except two functions replaced by the same name
with more defaulted arguments) and ends in a report whose rows must all say `ok`.

1. **Merge.** GitHub Pages serves the static changes: the tools, the partners
   and newsletter pages, the rebuilt articles, robots.txt and the sitemaps, the
   admin pages. The pages work before the SQL below runs: events to unknown
   names are dropped by the database, the explorer reads an RPC that exists.
2. **SQL editor, in this order** (each is safe on the live site):
   1. `supabase/growth.sql` — the classifier and the widened source constraints
   2. `supabase/funnel.sql` — the four public-page events
   3. `supabase/newsletter.sql` — topics, caps, the hardened signup and preferences
   4. `supabase/growth_outbound.sql` — `landing_for`, the `landing_by_interest` switch
   5. `supabase/growth_engine.sql` — the dashboard, MRR, Search Console tables, weekly reports
   6. `supabase/growth_engine_cron.sql` — the Monday snapshot (needs pg_cron, already used by other jobs)
3. **Edge functions** (by hand, as before):
   ```
   supabase functions deploy newsletter --no-verify-jwt
   supabase functions deploy newsletter_cron --no-verify-jwt
   ```
   and `growth_outbound_draft` through the **Deploy growth outbound** workflow
   (or `supabase functions deploy growth_outbound_draft --no-verify-jwt`).
   `newsletter_cron` now requires the service role (or a signed-in newsletter
   operator): confirm the pg_cron job
   (`supabase/newsletter_cron.sql`) sends `edgedesk.service_key`, then run the
   job once from the SQL editor and check the response is not 401.
   Until `newsletter` is redeployed, confirmation links keep working the old way.
4. **Google Search Console** (owner, ~10 minutes):
   1. Add a **Domain** property for `edgedesksports.com` and verify it with the
      DNS TXT record Google shows (at the domain's DNS host). This covers every
      URL and needs no file in the repository.
   2. Sitemaps → submit `https://edgedesksports.com/sitemap.xml`.
   3. For the dashboard import: in Google Cloud, create a service account,
      enable the *Google Search Console API*, create a JSON key; in Search
      Console → Settings → Users, add the service account's email (Restricted).
   4. Repository secrets: `GSC_SERVICE_ACCOUNT_JSON` (the key file's contents)
      and `GSC_SITE` (`sc-domain:edgedesksports.com`). The **Search Console
      import** workflow runs daily and is green (and does nothing) until then.
5. **Check:** `/admin/seo/` shows 0 errors; `/admin/acquisition/` loads for
   the owner; open `/tools/no-vig-calculator/` from a Google result (or with
   `?utm_source=test`) and see the visit under its channel the next time the
   dashboard loads.

### Rolling back

Static pages revert with the merge. The SQL changes are additive; the only
behaviour changes a revert of the SQL would need are `acq_classify` (re-run the
previous `growth.sql`) and the newsletter functions (re-run the previous
`newsletter.sql`; the new columns stay, unused). `landing_by_interest` can be
switched off from the outbound settings without any deploy.

## 4. Tests

| Suite | What it proves |
|---|---|
| `tools/growth/growth_engine.test.js` (236) | tools arithmetic = `lib/edgedesk_ev.js` on 32 markets; the tracker's first-touch rules in a fake browser; public pages' metadata, canonicals, offer wording, honesty; robots (tools allowed one by one, build scripts and drafts not); sitemaps; articles' CTA and links; newsletter UTMs; the Search Console importer (a real RSA key verifies its JWT; counts-only logs); the security fixes stay fixed |
| `tools/growth/growth_engine_sql.test.js` (53) | on PostgreSQL: who may read the report; search → article → signup → trial → paid → cash is SEARCH end to end; newsletter and outbound channels; MRR excludes comps and test mode and counts an unpriced subscription; pages, tools, CTAs, newsletter; Search Console totals; referral flags change nothing; the weekly snapshot is server-only and frozen once |
| `tools/newsletter/newsletter_growth_sql.test.js` (31) | topics and product consent; a confirmed address is not changed from the form; the global and daily caps; preferences; the list count is operator-only; the source label |
| `tools/growth/outbound_landing_sql.test.js` (26) | each kind of prospect → its page, with a reason; the owner's switch; the template's words pass the database's own lint; UTMs on every landing |
| `tools/growth/public_pages.e2e.js` (90) | Chromium at 390 and 1280 px: the calculators, the explorer, an article, the newsletter signup/confirm/manage flows, the tools hub and partners page — no overflow, no script error, tracking once |
| `tools/seo/audit.js --check` | every public page: 0 errors |

Run with `npm run growth:engine:test`, `growth:engine:sql`, `growth:engine:e2e`,
`seo:audit`; `.github/workflows/growth-engine-tests.yml` runs them on a pull
request. Existing suites updated for intended changes: `articles.test.js`
(served URLs, dead-link check, scripts), `community.test.js` (nav URL),
`growth_sql.test.js` (two new sources), `outbound_draft.test.js` (a CFB
analyst's link), `newsletter.test.sql` (the preferences signature),
`tools/games/builder.test.js` (the two Search Console secrets join its list of
credentials, under its rule that a missing one is a loud, named warning).
