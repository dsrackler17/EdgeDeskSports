# The desk: data-first articles, with my take required

Articles built only on data I own, written in my voice, each with a number a
reader can trace back to the file it came from, and none of them public until
I have written "My take" on it. The audit that led here is
[`AUDIT.md`](AUDIT.md). Sample drafts from this season's data are in
[`samples/`](samples/).

## The five types

| Type | What it says | Reads (committed files) | Due |
|---|---|---|---|
| Weekly CLV Report | My card for a graded week: each number against the market when I recorded it and the close, CLV per game, the week's and season's CLV, ATS and O/U record, and the locked-price P&L, wins and losses | `record/football/summary.json`, `record/football/<sport>_2026.json`, `record/pnl/ledger_2026.json`, `record/pnl/summary.json` | the latest week whose games are all graded, NFL and CFB |
| Where My Number Disagrees | The week's biggest model-vs-market gaps, the components inside each number, what is not in it, the validation tier, and what my CLV record says gaps like these have been worth | `football/nfl/slate.json` (`pricing.rows`), `football/game_research/current.json`, `record/football/summary.json` | the NFL week ahead |
| Line Movement Recap | Every game open to close, net move, changes seen, key numbers through/onto/off, my early side and its CLV | `football/pricing/openers_nfl.json`, `football/validation/key_numbers.json`, `record/football/nfl_2026.json` | the latest fully closed NFL week |
| What I Got Wrong | The month's games where the close beat my number by the most, the month's error against the close's, and what the postgame audits and the CFB Lab miss reviews say | `record/football/*_2026.json`, `articles/data/editorial/audits/`, `memory.json`, `football/cfb_lab/ledger/2026/miss_reviews.jsonl` | the previous month |
| Research Notes | A registered study: hypothesis, sample, every measure, the gates, what it does and does not show, labelled experimental | `football/cfb_lab/governance/experiments.jsonl`, `football/cfb_lab/reports/2026/promotion.json`, `football/cfb_validation/maturity.json` | each running study with a published evaluation |

What is **not** built, and why: CFB disagreements (the CFB slate does not join
a market), CFB line movement (the 2026 CFB opener ledger is incomplete), and
NFL/UFC/tennis research notes (only the CFB Lab keeps a study registry). Each
generator refuses with that reason rather than estimating.

## How a number stays honest

* Every number is printed through `Builder.n()` in `lib/edgedesk_desk.js`, which
  runs a JSON query against a named source file and stores the query, the raw
  value and the exact text printed. Facts (a team, a book) go through `t()`.
* `verifyDraft` re-runs every query, re-formats every value, and reads the
  text back: a number that did not come through `n()` or `t()` fails.
* `data_snapshot` stores, per source, the file, its SHA-256 and the last
  commit that changed it. `node tools/desk/verify.js DRAFT.json` re-reads each
  file **at that commit** and re-derives every value.
* The page prints "Data as of" (the oldest source used), names every file
  with its digest, and links the committed record that holds every query.

## The flow

```
 pg_cron desk_generate (daily) ──► desk_cron ──► desk-drafts.yml
                                                    │  node tools/desk/generate.js --due --push
                                                    ▼
                                 public.article_drafts (append-only)
                                 public.desk_articles  (awaiting_take)
                                                    │
 pg_cron desk_notify (30 min) ──► desk_cron ──► Discord DM / owner channel / badge
                                                    │
                       /admin/desk/: read the draft, trace any number, write My take
                                                    │  desk_publish (refused without the take)
                                                    ▼
          publish-articles.yml: tools/desk/sync.js ──► articles/data/desk/records/
                                build_articles.js  ──► /articles/<slug>/, /articles/desk/
```

"Build the page now" on the desk asks `desk_cron` to start the publish
workflow, so a page goes live in minutes instead of at the next three-hourly run.

## Game articles now need a take too

The editorial pipeline used to publish pregame and postgame articles with no
person in the path. Now its one publisher (`tools/editorial/publisher.js`,
check `my_take`) holds every **new** game article until a take of the minimum
length is on file. Takes are written on the desk's "Game articles" tab. At the
start of every editorial run (`phaseTakes` in `tools/editorial/run.js`) the
takes are read and any article held only for its take is published, with every
other check run again. A pregame article whose game has started stays
unpublished. Pages already published are never touched.

* The switch: "Game articles need my take too" on the desk's Settings tab
  (`desk_settings.require_take_for_game_articles`).
* It fails closed: if the editorial job cannot read the takes, new articles
  are held, never published without one.
* A first publication from a browser (the article manager, the terminal's
  "Publish as article") is held to the same rule by a trigger on
  `site_articles`.

## Author and trust layer

Every article (desk and game) now carries my name, a short bio, "Data as of",
a link to my live CLV record and an author box; its JSON-LD names a `Person`
author. Desk pages with tables add a `Dataset` block whose distributions are
the source files. `/articles/author/davis-rackler/` is the author page.

**Add the photo:** save a square JPEG as `assets/author/davis-rackler.jpg`.
Until it exists every byline draws initials and the structured data carries
no image. The next build picks it up.

## Distribution kit

For each published article the desk builds an X post, a LinkedIn post, a
Discord post and a Reddit version. Each leads with the article's lead number,
is UTM-tagged (`utm_source` = channel, `utm_campaign` = `desk_<slug>`,
`utm_content` = type), and is checked: it must quote the lead's number and
link the published article; the Reddit body carries no link and the link goes
in a comment. Nothing is posted.

## Article Performance

`desk_article_performance(days, articles)` ranks every published article by
paid conversions, then trials, then views, and compares types. Credit is shown
three ways and never summed: **touched** (the reader read it before
converting, through `user_event_links`), **first page** and **last page**
(`user_acquisition`). Channels come from each view's own `utm_source` and
referrer, so Discord and Reddit are their own channels here. Owners never count.

## Deploying, in order

1. **SQL editor:** run `supabase/desk_articles.sql` (after `site_articles.sql`).
   Every report row should read `ok`.
2. **Function:** `supabase functions deploy desk_cron --no-verify-jwt`, then set
   its secrets: `DESK_CRON_SECRET` (a long random string). It reuses
   `EDITORIAL_GH_TOKEN` and `DISCORD_BOT_TOKEN` if they are set.
3. **Notifications (optional):** for a DM, set `DESK_OWNER_DISCORD_ID` to your
   Discord user id (the bot must share a server with you); or set
   `DISCORD_WEBHOOK_OWNER` to an owner-only channel's webhook. With neither,
   the badge in the terminal and the desk page are the notification.
4. **Vault + cron:** `select vault.create_secret('<same string>', 'desk_cron_secret');`
   then run `supabase/desk_articles_cron.sql`.
5. **GitHub:** nothing new. `desk-drafts.yml` and the editorial job use the
   existing `SB_URL` and `SB_SERVICE_ROLE` secrets.
6. **Photo:** `assets/author/davis-rackler.jpg` (above).

Until step 1 is done the editorial pipeline cannot read any take, so it holds
every new game article (fail closed). Apply the SQL first, or switch the rule
off by setting the repository variable `EDGD_REQUIRE_MY_TAKE` to `false`
(GitHub, Settings, Secrets and variables, Actions, Variables) until you do.

## Known data issues (reported, not changed)

The research protocol is frozen, so these are left for a decision:

1. **The P&L ledger's CLV for model numbers.** On 109 of 629 graded model rows
   (17%) `record/pnl/ledger_2026.json` pairs the kickoff side with the line from
   the moment the first number was recorded, so `clv_points` carries the
   opposite sign from `record/football/*_2026.json`. Example: CAR @ PHI, Week 6,
   ledger -5.5, model record +5.5 (the price actually locked, PHI +3 at -108,
   closed PHI +3). `/record.html`'s P&L section reads the ledger, so its "Avg
   CLV" for NFL games (-1.11) disagrees with the model record's +0.51. The desk
   uses the model record's CLV and the ledger's units, which do agree.
2. **No Observed / Estimated / Research labels per component.** The disagreement
   article shows what is in the number, what is not (CFB only), and the
   validation tier, and says the per-component labels are not published.
3. **Discord and Reddit are "other" in the older acquisition dashboards**
   (`acq_classify`). Article Performance classifies them correctly.
4. **The live Discord posts link `/record.html`, `/performance/`, `/today/` and
   `/#pricing`, not articles.** They are data posts, not article snippets.

## Tests

```bash
npm run desk:test     # offline: generators on real data, verifier, voice, pages, editorial gate, kit, desk_cron
npm run desk:sql      # the migration on a throwaway PostgreSQL: the gate, append-only, RLS, notifications, performance
npm run desk:due      # what is due today, held to its own checks, nothing stored
```
