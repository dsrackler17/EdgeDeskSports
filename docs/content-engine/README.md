# The Sports Media Content Engine

**Research, not picks — written for fans, with publishers in mind.** The engine turns what EdgeDesk's models already publish into broad, searchable sports articles. It does five things:

1. Finds the week's best topics.
2. Scores them.
3. Writes an SEO brief and a draft from EdgeDesk's own numbers.
4. Checks every claim against the research.
5. Takes the draft through an owner-only review to a publisher-ready export, or to the publisher's inbox when the owner presses **Send**.

It never invents a number, never makes a pick, and never sends or publishes anything by itself.

Why it exists: publishers asked for broader, search-driven pieces rather than isolated matchup previews: weekly CFB and NFL predictions, major storylines, injuries and upsets. The engine produces exactly those, with EdgeDesk's research as the thing that sets them apart.

**Open it:** `/admin/content/` (outbound owners only).

---

## How it fits together

```
committed research ─┐                        ┌─► admin/content/ (owner)  ── doors ──┐
 football/cfb_terminal/games.json            │     discover · score · outline ·     │
 football/rankings/current.json   lib/content_engine.js   draft · check · export    │
 football/nfl/slate.json          (one file, three hosts)                            ▼
 football/injuries/nfl_2026.json             ├─► tools/content/run.js (weekly job) ─► supabase/content_engine.sql
 articles/data/market/*.json                 │     service role: draft + queue only      private schema, owner doors,
public RSS headlines ── content_engine fn ───┘─► supabase/functions/content_engine        invariants in triggers
Search Console (existing import) ────────────────    Claude (budgeted, checked)  ── as the owner ──┘
```

- **`lib/content_engine.js`** is the core, with no dependencies. The browser page, the weekly job and the Edge Function all run the same code; the Edge Function carries a verbatim copy, checked by `tools/content/inline.js --check`. It covers:
  - research normalisation;
  - discovery and scoring;
  - the SEO brief;
  - five article formats;
  - the deterministic writer;
  - the validator;
  - Word (.docx), Markdown and HTML export;
  - RSS parsing;
  - the AI request and reply.
- **`supabase/content_engine.sql`** holds:
  - the tables: publishers, benchmarks, opportunities, articles, revisions, deliveries, performance, events, runs and usage;
  - the owner doors;
  - the invariants.
- **`supabase/functions/content_engine`** handles the two things a browser must not do:
  - call Claude, with the key on the server;
  - fetch the RSS feeds, which browsers block cross-origin.
- **`admin/content/`** is the owner's dashboard: Opportunities, Article generator, Editorial review, Publishing queue, Performance, Publishers, and Settings & log.
- **`tools/content/run.js`** is the weekly job (`.github/workflows/content-engine.yml`). It also provides local `discover` and `example` commands.

### What it reuses (nothing duplicated)

| Need | Reused from |
|---|---|
| CFB projections, win chances, projected scores, confidence, reliability, captured quotes, research and decision status, QB status, matchup units | `football/cfb_terminal/games.json` (the CFB terminal build) |
| Power ranks, conference, rank movement | `football/rankings/current.json` |
| NFL projections, records, QB-out scenarios, reference lines | `football/nfl/slate.json` |
| NFL injury report | `football/injuries/nfl_2026.json` (nflverse) |
| NFL captured book quotes | `articles/data/market/<season>-week-NN.json` |
| Links to EdgeDesk's own game pages | `articles/data/published.json` |
| The freshness rule (a quote older than 180 minutes is not a price), the confidence floor | the CFB decision policy and `lib/edgedesk_canon.js` |
| Banned language and the AI tells | `tools/articles/article_model.js`, `tools/articles/community.js`, `tools/editorial/quality.js` (a test holds the lists in parity) |
| The owner list and the owner check | `growth_outbound.owners` and `tools/growth/outbound_auth.js` (copied verbatim) |
| The operator session | `lib/edgedesk_admin_session.js` |
| First-party attribution | `acquisition_visitors`, `user_acquisition`, `user_events` and `growth_customer_facts()` (growth.sql, funnel.sql) |
| Search demand evidence | `search_console_queries` (the existing Search Console import) |
| Disclaimer wording | the article footer: "research, not betting advice … 21+ … 1-800-GAMBLER" |

---

## One-time setup

1. **Apply the SQL.** In the Supabase SQL editor, paste `supabase/content_engine.sql`. It must come after `affiliates.sql`, `growth.sql` and `growth_outbound.sql`, which are already live; the guard enforces the order. It is idempotent and ends in a report: every row should read `ok`. It seeds the **Stadium Rant** profile with *editorial preferences only*.
2. **Owners.** The Content Engine's owners are the outbound owners. If you are not one yet, run `select growth_outbound.grant_owner('you@example.com');` in the SQL editor.
3. **Deploy the function.** Run the **Deploy content engine function** workflow (manual), or deploy from a terminal: `supabase functions deploy content_engine --no-verify-jwt`.
   - Optional: set `ANTHROPIC_API_KEY` on the project (Edge Functions → Secrets).
   - **Send** uses `RESEND_API_KEY`, which the project already holds for the newsletter. Settings shows whether it is configured.
   - Redeploy the `newsletter` function too, so its webhook ignores the events from these emails (`edgedesk=content`).
   - Until the function is deployed, the page still discovers, drafts, reviews and exports. AI rewrites, trending headlines and Send say they are unavailable.
4. **The weekly job.** It runs from `.github/workflows/content-engine.yml` on Tue/Wed at 13:23 UTC, or by hand. It uses secrets the repository already holds: `SB_URL`, `SB_SERVICE_ROLE`, and optionally `ANTHROPIC_API_KEY`. Without the Supabase secrets it posts a named warning and does nothing.
5. **Publisher business data** goes into the page, never the repository (see *Privacy* below). Open **Publishers → Stadium Rant** and:
   - add the contacts (name and email: **Send** only goes to these addresses) and the partnership terms;
   - add the **historical benchmarks** as *user-reported* values: the average views of the publisher's recent articles, and the range for EdgeDesk's earlier matchup pieces.

---

## Using it

1. **Opportunities → Discover now.** The page:
   - reads the committed research from the site;
   - asks the Edge Function for public RSS headlines;
   - looks up EdgeDesk's own Search Console impressions for each keyword;
   - scores everything for the chosen publisher;
   - records each opportunity, idempotently, by key.

   The weekly job does the same unattended. Each opportunity shows:
   - its seven scores, each with its basis;
   - the demand label (**estimate** or **measured**);
   - its sources with URLs and timestamps.
2. **Write article.** Pick the publisher, a compatible format and an angle. **Generate outline** shows the SEO brief:
   - keywords and search intent;
   - the headline and alternatives;
   - the meta description and slug;
   - teams and players;
   - the article structure;
   - internal and external links;
   - the demand basis.

   **Generate full draft** writes the deterministic draft and saves it.
3. **Edit.** Every field and section is editable. **Rewrite with AI** works on the whole draft or on one section; Claude's version is kept only if it passes every check (see *Quality gates*). **Run checks** re-checks the draft on screen, and **Save** keeps a revision.
4. **Submit for review.** Only a draft whose checks pass can enter review.
5. **Editorial review.** The checks are re-run at that moment, so freshness and kickoff are evaluated against now. The panel shows:
   - the sources;
   - the model numbers to verify;
   - the SEO sheet;
   - the export preview.

   Confirm the five points (source verification, data freshness, model accuracy, SEO, compliance), then **Approve this exact version**. The approval is bound to the content hash on screen.
6. **Publishing queue.** Open the approved article. The exports are **Word (.docx)**, Markdown (with front matter), HTML and the SEO sheet. Then send it in one of two ways.

   **Send it yourself (the editor touches it up):**
   1. Press **Download Word file**. It opens in Word or Google Docs, ready to edit:
      - the headline and section headings are real Word headings, the game lists real bullets;
      - the tagged EdgeDesk link is live, and the research credit and the disclaimer are in place;
      - a last page, *For the editor (not for publication)*, carries the SEO sheet (headline options, slug, meta description, keywords). It asks the editor to keep the link, the credit and the 21+ line, and to check any change to a projection or number with you.
   2. Email it to the editor from your own inbox.
   3. Back on the page, choose how you sent it (default *I emailed it myself*) and press **Mark as sent**. It asks once, then records the send with a delivery row. There is no "ready" step on this path.

   **Or email it from EdgeDesk:**
   1. Add the editor's name and email under **Publishers → Edit → Contacts**, once per publisher.
   2. Optionally, press **Send a test to me**. It goes to your own sign-in address and does not count as sent.
   3. Press **Mark ready to send**.
   4. Choose the contact, check the subject and the note, and press **Send to …**. The page names the address and asks first.

   The email contains:
   - your note;
   - the approved article, with its tagged link and the disclaimer;
   - the Word file (first, for editing), the Markdown, the HTML and the SEO sheet, attached.

   It is recorded as **sent**, with a delivery row.

   Then **Mark published** when it goes live, with its URL.
7. **Performance.** First-party visits, sessions, sign-ups, trials and paid conversions through the article's tagged link appear here. Add the publisher-reported figures (page views, referral clicks) by hand.

### Formats

| Format | For | Sections |
|---|---|---|
| Weekly CFB preview | weekly preview, upset watch, conference race | intro · why it matters · how to read · the games · upset watch · conference races · what the numbers can't see · bottom line |
| Weekly NFL preview | weekly preview, upset watch, slate-wide model-vs-line | intro · why it matters · how to read · the games · upset watch · where the numbers differ · injury report · limits · bottom line |
| Trending sports story | a matched headline, an NFL injury implication | intro · what was reported (attributed, linked) · why it matters · what EdgeDesk's research shows · what we don't know · bottom line |
| Market discrepancy analysis | one game with a current price and a 2+ point gap | intro · the gap (with capture time) · why the numbers differ · how to read · the case for the market · limits · bottom line |
| Publisher-specific | any of the above | the publisher's own section order, tone, length and attribution |

One research event can produce several **angles** (for example *full slate* or *upsets first*). Each angle is its own article. The database allows one live article per research event × publisher × format × angle, and the validator fails a draft that overlaps a sibling article from the same research by 70% or more.

---

## Discovery and scoring

The engine finds these kinds of opportunity:
- **Weekly previews** (CFB and NFL).
- **Upset watch:**
  - CFB: underdogs with a 30–46% chance against a top-25 favorite;
  - NFL: underdogs with a 30–46% chance against a 3+ point favorite;
  - either league: any game where the model and the market disagree on the favorite.
- **Conference races:** games between two of a conference's three highest-rated teams in EdgeDesk's ratings.
- **Market discrepancies:** CFB single games with a current price and a gap of 2 points or more; an NFL slate-wide piece when three or more games differ by 2+ points.
- **NFL injury implications:** a listed starting QB on the official report, quantified with the model's QB-out scenario.
- **Trending stories:** an RSS headline that names a team on this week's slate.

Each opportunity gets seven parts, each scored 0–100 with its basis:

| Part | Weight | Basis |
|---|---|---|
| Search relevance | 0.18 | measured Search Console exposure, else an **estimate** from the query pattern |
| Timeliness | 0.14 | hours to the first relevant kickoff (best 6–48 h), or a headline's age |
| Audience interest | 0.16 | top-25/top-10 teams, close projections, power-conference or division games, prime time, records, model-vs-market disagreement |
| Research availability | 0.16 | share of games with a current projection; a current price where the angle needs one |
| Editorial relevance | 0.10 | how well the angle fits "research, not picks" |
| Publisher fit | 0.14 | the profile's sports, categories and preference for broad topics |
| Research confidence | 0.12 | model confidence (CFB), data quality (NFL); minus no current prices or an operations warning |

**Search demand is never presented as search volume.**
- Without Search Console data, every brief says: *ESTIMATE, not measured search volume*.
- With it, the brief quotes EdgeDesk's *own* impressions and clicks for the query, and says that this is EdgeDesk's exposure, not total search volume.
- Google Trends has no official API and is not used.

---

## Quality gates

These checks run in the page, in the job and in the function, and the database adds its own floor.

**Fail (a draft with any of these cannot go to review):**

| Check | What it enforces |
|---|---|
| Structure | the required sections are present, and none is empty |
| Numbers in evidence | every figure is in the research packet, with the rounding EdgeDesk uses |
| Teams in evidence | no team outside the article's research (a person who shares a team's name is not a team) |
| No recommendation | no pick, lock, guarantee, "will win", staking or "best value" language |
| Projection is not value | the explanation that a projection is not a bet is present |
| Stale prices labelled | an old or reference line is never called current, and always carries its capture time |
| Reporting attributed | external reporting carries its outlet and link, and no unsourced "reportedly" |
| No stringified nothing | no "null", "undefined" or "NaN" in the copy |
| Not a near-duplicate | under 70% overlap with sibling articles from the same research |

**Warn:**
- AI filler;
- people not found in the research;
- research older than 36 hours;
- featured games that have already kicked off;
- length outside the target;
- SEO (keyword placement, meta description length, slug, keyword stuffing).

**The database** refuses approval unless all of the following hold:
- every check passed;
- the five-point review is complete, for the current content hash;
- the approval is for the hash on screen;
- its own banned-phrase lint is clean.

An edit after approval returns the article to review, and sent content is frozen.

**AI.** Claude is called with structured JSON output, the frozen research packet, the current draft and the publisher's profile. It is told the hard rules.
- If its version fails a check, it gets the objections and one more try.
- If it fails again, nothing is saved and the deterministic draft stands.
- Every call is counted against the database's daily budget **before** it is made (default 20 calls a day, set in Settings).
- The default model is `claude-opus-5-5`, with server-side refusal fallbacks.

---

## Conversion tracking and privacy

- **Tagged links.** Every EdgeDesk link in an export carries three tags:
  - `utm_source=<publisher>` (for example `stadiumrant`);
  - `utm_medium=publisher`;
  - `utm_campaign=ce_<publisher>_<article>`.

  The campaign code survives `growth.sql`'s `utm_campaign` cleaning unchanged, which a test proves. `lib/edgedesk_public.js` already records it on every public page.
- **First-party** figures are computed in the database from `acquisition_visitors`, `user_events`, `user_acquisition` and `growth_customer_facts()`, joined on the campaign code.
  - They are **counts only**; the owners' own accounts are excluded.
  - No user id, email or visitor hash leaves the database.
  - "Copy a publisher-safe summary" gives aggregate counts with anything under 5 shown as "fewer than 5".
- **Publisher-reported** page views and clicks are entered by hand and shown apart from first-party figures. **Benchmarks** are labelled user-reported reference values, never live analytics, and are not treated as a target.
- **Business data stays out of the public repository.** This repository and its site are public, so the following live only in the owner-only database, entered in the page:
  - publisher contacts;
  - partnership terms;
  - benchmark view counts;
  - unpublished drafts.

  A test fails if any of these appears in a committed file. `content-example/` (the local example output) is git-ignored.
- **Nothing is sent automatically.** The only email path is the owner's **Send** button.
  - The weekly job and its workflow have no email code; a test fails if they gain any.
  - The database's `content_engine_send_claim` (owner only; the service role cannot call it) checks four things:
    - the article is approved, and the content is the approved hash on screen;
    - for a real send, the article is marked ready to send;
    - the recipient is a contact on that publisher's profile, or, for a test, the owner's own sign-in address;
    - the publisher is not paused.
  - The claim is written **before** Resend is called, with one idempotency key.
    - Pressing Send again after an unanswered try resends the same message with the same key, so it cannot arrive twice.
    - Once an address has the article, it cannot be sent to that address again.
  - "Sent" is then recorded with a delivery row at the sent content hash. Sends, like deliveries, cannot be edited or deleted.
- **The sender** defaults to the outbound engine's `edgedesksports.com` sender and its reply-to. Change it in **Settings** (the database only accepts an `@edgedesksports.com` sender).
  - Resend events from these emails carry the tag `edgedesk=content`, and the newsletter's webhook ignores them.
  - No subscriber or reader data is ever in the email: only the article, its public tagged link and your note.

---

## Secrets and external services

| Name | Where | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Supabase function secrets; GitHub Actions secret | optional | Claude's editorial pass. Without it, the deterministic writer drafts everything. |
| `CONTENT_ENGINE_MODEL` | Supabase function secrets; GitHub Actions variable | optional | defaults to `claude-opus-5-5` |
| `CONTENT_ENGINE_ALLOWED_ORIGINS` | Supabase function secrets | optional | CORS; defaults to edgedesksports.com |
| `RESEND_API_KEY` | Supabase function secrets (already set for the newsletter and outbound) | for **Send** | the owner's send to a publisher. Without it, Send says it is not configured and export still works. |
| `SB_URL`, `SB_SERVICE_ROLE` | GitHub Actions secrets (already present) | for the weekly job | the job's door into the database (job doors only) |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` | GitHub Actions secrets (already present) | to deploy from CI | the deploy workflow |

- **Public RSS feeds** (no key): ESPN, CBS Sports and Yahoo Sports NFL and college-football headline feeds, listed in `lib/content_engine.js` `FEEDS`.
  - Only the headline, link, time and the feed's own description are kept, never an article body.
  - Each fetch is counted against a daily budget (default 60).
  - The fetches identify themselves as `EdgeDeskContentEngine/1.0`.
- **No new paid service** is required. Send reuses the Resend account the newsletter already uses.

---

## Tests

```
npm run content:test      # the core against the committed research + static guards (192 checks)
npm run content:sql       # the database on a real PostgreSQL (125)
npm run content:fn        # the Edge Function as deployed, against that database (61)
npm run content:job:test  # the weekly job as the service role (23)
npm run content:e2e       # the owner's whole flow in Chromium, both ways of sending included (52)
npm run content:example   # write an example article (Word, Markdown, HTML, SEO sheet) from the current research to content-example/
```

---

## What is built, and what is not

**Phase 1 — core: built.**
- the repository audit;
- the topic queue;
- integration with the existing research;
- the Stadium Rant profile;
- SEO briefs and drafts;
- the owner-only dashboard;
- Word (.docx), Markdown and HTML export, and the owner's Send to a publisher contact.

**Phase 2 — automation: built.**
- the scheduled weekly discovery;
- automated drafts, a small number by default;
- the quality gates;
- the review checklist;
- revision history;
- the run lease.

**Phase 3 — growth intelligence: built where the data exists.**
- UTM referral tracking;
- first-party conversion counts;
- publisher-reported figures and benchmarks;
- multiple publishers.

**Limitations**
- **CFB prices are mostly stale.** Most CFB games carry no fresh price (5 of 55 in Week 6), and NFL quotes are the last captured lines. The articles say so; market-discrepancy topics score lower until prices are fresh.
- **NFL confidence.** The NFL model publishes no confidence score, and NFL BET/LEAN/PASS decisions are computed only in the browser, so the engine does not cite them.
- **CFB records and standings.** CFB win–loss records and conference standings are not in the committed research. Conference pieces read races through ratings and projections, and say so.
- **News feeds.** The RSS feeds could not be reached from the development sandbox. Parsing and matching are tested against fixtures, and the feeds run from the Edge Function and GitHub Actions.
- **Search demand.** Demand stays an estimate until Search Console has matching queries. There is no keyword-volume provider.
- **Publisher analytics.** There is no integration with publishers' analytics: publisher page views are entered by hand.
- **Delivery.** Delivery is by email, and only when the owner presses Send (or by hand, recorded). There is no CMS or shared-document integration; one should still require the owner's approval per article.
- **Email delivery status.** Resend's delivered, bounced and complained events for these emails are not yet read back. The page shows what Resend accepted, not what reached the inbox.
