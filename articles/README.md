# EdgeDesk research articles

The public, indexable half of the research terminal. One page per matchup:
EdgeDesk's own fair spread, the projected score where the model published a
total, what moved the number and what deliberately did not, where each team has
a measured edge, the matchups that decide it, and an itemised account of what
the model could not see.

**Research, not picks.** Nothing under `/articles/` is a wager, a
recommendation or advice, and the publication checks refuse an article that
reads like one.

---

## The shape of it

```
   the football model, unchanged
              │
   window.fbBriefGame() / fbNflBriefGame()      ← the research payload
              │
   tools/articles/generate.js                   ← an article RECORD
              │
   articles/data/records/<id>.json              ← the store (a commit)
              │
   tools/articles/build_articles.js             ← static HTML
              │
   /articles/<slug>/                            ← Google, social, readers
              │
   /app.html#research/football                  ← the full terminal
```

**Nothing in this folder computes a number.** Every projection, probability,
confidence figure, driver contribution and status label on a published page
arrived in the research payload that the terminal itself produces. The article
system selects, orders and labels; it does not model. If a figure is not in the
payload it does not appear on the page — there is no fallback value, no
estimate and no "approximately".

## The files

| file | what it is |
| --- | --- |
| `tools/articles/research_host.js` | boots the REAL football module out of `app.html` in a VM and drives the same load path a browser drives. Supplies the two things Node lacks: `fetch` (repo files, then a feed cache, then — with `--network` — the network) and `<script src>`. |
| `tools/articles/article_model.js` | research payload → article record. Slugs, titles, metadata, the nine sections, the bottom line, the publication checks, and the lifecycle (publish / unpublish / archive / refresh / freeze). Loads in Node **and** in a browser. |
| `tools/articles/article_render.js` | article record → crawlable HTML: the article page, the alias page and the hubs, with the head, the OpenGraph tags and the JSON-LD. Same file in Node and in the browser, so the operator's preview cannot differ from the build. |
| `tools/articles/store.js` | the record store, the manifest and the captured-quote snapshots. |
| `tools/articles/generate.js` | the CLI that creates and refreshes records. |
| `tools/articles/build_articles.js` | the CLI that writes `/articles/**`, the hubs and `sitemap-articles.xml`. |
| `articles/articles.css` | the one stylesheet every public article page loads. |
| `admin/articles/index.html` | the operator's manager: preview, publish, unpublish, regenerate, archive, auto-publish. |
| `supabase/site_articles.sql` | the publication-state table and its RLS. Optional: the pipeline works keylessly from the committed store. |

## Running it

```bash
npm run articles:generate     # refresh every record from the committed cache
npm run articles:refresh      # …allowing the two public schedule feeds to download
npm run articles:build        # render every PUBLISHED record to static HTML
npm run articles:preview      # …and unpublished ones to /articles/_preview/ (noindex)
npm run articles:check        # report on the store, build nothing
npm run articles:test         # the offline suite and the live-parity suite
npm run articles:publish      # refresh + auto-publish what qualifies + build
```

Single game:

```bash
node tools/articles/generate.js --game missouri-vs-kansas-2026 --publish
node tools/articles/generate.js --sport NFL --limit 8 --dry
```

The scheduled job is `.github/workflows/publish-articles.yml`. It runs the
suite, refreshes every record, holds them against the research they came from,
builds the pages and commits. No secret: the two schedule feeds are the same
public, keyless ones the board reads.

## What the system refuses to do

These are enforced by `article_model.publishable()` and asserted by
`tools/articles/articles.test.js`. A record that fails one is held as a draft
and the failing check is named on the record and in the manager.

1. **Never invent a projection.** A record with no research payload is not
   publishable.
2. **Never compute a second fair spread.** There is no arithmetic on a price
   anywhere in this folder.
3. **Never call a sportsbook line the EdgeDesk line.** The market section is
   headed as somebody else's number and says so in its own sentence.
4. **No projected score without a published total.** The card says *not
   published* and gives the model's own reason. Norfolk State at Virginia is
   the case in the store.
5. **Measured is not better.** Where one side is unrated, no edge is claimed
   for the other: the rated team's components are published as *measurements*,
   under that heading, with the reason the size of the gap is unproven.
6. **Research context never becomes a pricing input.** `PRICED BY MODEL` and
   `RESEARCH CONTEXT — DOES NOT MOVE THE PRICED NUMBER` are on every page.
7. **No confidence figure for a model that publishes none.** The NFL model
   publishes no single confidence score, so the NFL article says that instead
   of printing a number.
8. **Confidence, status and missing-data warnings survive to the reader**, in
   the model's own words — `RESEARCH`, `INVESTIGATE`, `THIN DATA`, `UNPROVEN`.
9. **No recommendation language, ever.** A banned phrase anywhere in the
   assembled document fails the check, including one that arrived from the
   engine.
10. **No stringified `null` reaches a page.**

## Publication states

`draft → ready → published → (updated) → archived`

* **draft** — generated, but something is missing. The failing check is on the
  record.
* **ready** — every publication check passes. Eligible for auto-publish inside
  the lead-time window (90 minutes to 14 days before kickoff, by default).
* **published** — the page exists at `/articles/<slug>/`, is `index,follow`,
  and is in `sitemap-articles.xml`.
* **archived** — kept in the store, no page.

`published_at` is stamped once. `updated_at` moves whenever the research
actually changes, and **only** then: a refresh that finds nothing new advances
`generated_at` and nothing else, so a quiet week produces no commit claiming an
article changed.

### The freeze

Once a game kicks off, its record freezes. A refresh after that returns the
record unchanged and says why. An article is a record of what EdgeDesk said
**before** the game; a projection edited afterwards is a record of nothing.
This is the same rule `supabase/publisher_briefs.sql` applies to a published
brief.

## Captured sportsbook quotes

`articles/data/market/*.json` holds book quotes EdgeDesk captured, replayed
into a build that cannot reach the live capture (which is behind an account a
build server does not have). They are injected in exactly the shape the
module's own `fbMarketFromEvent()` reads a live capture in, so the module's own
market join, its own status classifier and its own orientation check all run
normally. Every article built with one discloses it, names the book and the
capture date, and says the number is the book's rather than EdgeDesk's.

## SEO

Every published page carries a unique `<title>` (written for a result list,
distinct from the visible H1), a meta description built only from figures the
payload carried, a canonical URL, OpenGraph and Twitter cards, and three
JSON-LD blocks: `Article`, `SportsEvent` and `BreadcrumbList`. The primary
`sitemap.xml` is an index pointing at `sitemap-pages.xml` (standing pages, by
hand) and `sitemap-articles.xml` (published articles, rewritten by the build).
Drafts, previews and short alias URLs are in no sitemap.

An article page is complete before any JavaScript runs. The only script on it
is the copy-link button, and the X and Facebook share links are plain anchors
that work without it.
