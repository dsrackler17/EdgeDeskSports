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
| `admin/articles/index.html` | the operator's manager: preview, publish, unpublish, regenerate, archive, auto-publish — and the member-post moderation queue. |
| `supabase/site_articles.sql` | the publication-state table and its RLS. Optional: the pipeline works keylessly from the committed store. |
| `tools/articles/community.js` | member posts: the slug rule, the phrase list, the safe body renderer, the validator. Loads in Node **and** in a browser. |
| `articles/community/index.html` | the member-post feed and reader. Client-rendered, noindex. |
| `articles/write/index.html` | the composer. |
| `supabase/community_posts.sql` | the member-post table, its RLS, and the trigger that decides who may publish. |

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


---

# Member posts

A second, separate thing living under the same `/articles/` roof, and the
separation is the point.

|  | EdgeDesk research | Member posts |
| --- | --- | --- |
| Written by | the model | a person with an EdgeDesk account |
| Lives at | `/articles/<slug>` | `/articles/community/<slug>` |
| Is | a committed static file | a row, rendered in the browser |
| Search | `index,follow`, in the sitemap | `noindex`, in no sitemap |
| Table | `site_articles` | `community_posts` |
| Checked for | every integrity rule above | a phrase list, and a human |

They are different tables on purpose. The research builder reads
`site_articles` and cannot see a member post, so no member post can reach the
research feed, the research sitemap or an indexed page by mistake — that is a
structural fact rather than a filter somebody has to remember.

## Who may post, and what happens when they do

**Anyone with an EdgeDesk account may write.** What differs is what pressing
Publish does:

* an **entitled subscriber** — active, trialing, comped, or past-due inside
  Stripe's retry window — publishes straight through;
* **everyone else** lands as `pending` and an EdgeDesk editor reads it first;
* **any** post carrying a phrase from the list is queued regardless of account.

That rule is a **trigger** (`community_posts_guard()`), not a policy and not a
browser check. An RLS policy can say which rows you may update; it cannot say
which *value* you may put in a column, and "a free account may set status to
anything except published" is a statement about a value. So the trigger
rewrites the status it was handed, and the composer's copy of the rule exists
only to tell a writer what will happen before they spend twenty minutes on a
post.

The composer asks `community_can_publish()` on load and says, in one sentence
at the top of the form, which of the two it will be.

## The phrase list

`BANNED_TERMS` in `tools/articles/community.js` and
`public.community_banned_terms` in the migration are **one list in two
places**, and `tools/articles/community.test.js` fails if they drift — the
composer must not promise something the database will not honour. Each host
adds its own word boundary (`\b` in JavaScript, `\y` in PostgreSQL, where
`\b` is a backspace), which is why the list itself carries none.

**It is a guardrail, not a filter.** Anyone determined to post a pick can
write around a list of phrases and this one does not claim to stop them. What
holds the line is structural: an unentitled account cannot publish at all
without an editor, every post carries its author, five published posts a day
is the ceiling, and anything published can be removed. The list catches the
careless case and, in the composer, explains itself.

## A body is text

A post body is escaped first and is never markup. Blank lines become
paragraphs; bare `http(s)` links become anchors with
`rel="nofollow ugc noopener"`; everything else stays the text it is. There is
no markdown, no HTML passthrough and no embed, because one member running
script in another member's session is the failure mode a community page has
and the only reliable defence is not to offer the feature.

## Moderating

`/admin/articles` → **Member posts**. The queue defaults to what needs a
decision and shows the phrase that queued each post. Approving publishes it
immediately — member posts render live, so unlike a research article there is
no pipeline run to wait for.

Nobody can delete a post, including its author and including you. `removed`
takes it off the site; the record of what was said survives.

## Running the tests

```bash
node tools/articles/community.test.js        # offline: the two lists, escaping, validation
node tools/articles/community_sql.test.js    # the trigger, attacked on a real PostgreSQL
npm run articles:sql                         # the same
```

The SQL suite skips (and passes) with no PostgreSQL reachable, so `npm test`
stays green on a bare Node install. `.github/workflows/games-sql.yml` is where
it must not skip.
