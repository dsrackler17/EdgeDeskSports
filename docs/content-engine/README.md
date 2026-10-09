# The Sports Media Content Engine

**Research, not picks — written for fans, with publishers in mind.** The engine turns what EdgeDesk's models already publish into broad, searchable sports articles. It does five things:

1. Finds the week's best topics.
2. Scores them.
3. Writes an SEO brief and a draft from EdgeDesk's own numbers.
4. Checks every claim against the research.
5. Takes the draft through an owner-only review to a publisher-ready export, or to the publisher's inbox when the owner presses **Send**.

It never invents a number, never makes a pick, and never sends or publishes anything by itself. Since October 2026 it also never puts EdgeDesk's number beside a market line without the football behind both of them: see *Football evidence* below.

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
- **`lib/football_evidence.js`** builds one football evidence packet per matchup, explains every model–market disagreement, and holds the editorial gate every draft must pass (see *Football evidence*). The Edge Function carries a verbatim copy of it too.
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
| Quarterback seasons, game logs and play-by-play unit metrics for the evidence packets | `football/fbs_epa/qb_epa_2026.json`, `football/matchup/metrics.json`, `football/matchup/profiles_2026.json`, `football/enrichment/box/` |
| Official availability reports | `football/availability/reports/` (the conference reports EdgeDesk already ingests) |
| Results, records, head-to-head, kickoff forecasts | `football/cfb_terminal/record.json`, `football/pricing/lines_*.json`, `football/venues/forecasts.json` |
| Outside reporting (dated, attributed, editor-confirmed) | `football/evidence/facts.json`, the facts ledger (new; see below) |

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
5. **The reader funnel** for EdgeDesk's own articles: paste `supabase/first_party_funnel.sql` after `growth_engine.sql` and `content_engine.sql`. It adds the Growth Console's report, and registers the `article_engaged` event if `funnel.sql` has not already (re-pasting `funnel.sql` registers it too). Idempotent; every report row should read `ok`.
6. **EdgeDesk's own articles** (Monday/Wednesday/Friday) run from `.github/workflows/edgedesk-features.yml` with the same `SB_URL` / `SB_SERVICE_ROLE` secrets. They start in **dry run**: nothing is published until you choose **Auto** in **EdgeDesk articles** (see *EdgeDesk's own articles* below).
7. **The football evidence floor.** Paste `supabase/content_engine_evidence.sql` after `content_engine.sql` (and again after any re-application of it). It makes the database refuse to approve an article whose stored checks do not include the football evidence gate, and adds the owner's editorial metrics (`content_engine_editorial_metrics`). It is idempotent and ends in a report. The `matchup_analysis` topic and format are in `content_engine.sql` itself.
8. **Publisher business data** goes into the page, never the repository (see *Privacy* below). Open **Publishers → Stadium Rant** and:
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
6. **Publishing queue.** Open the approved article. The exports are **Word (.docx)**, **Save as PDF** (the article's clean print view; choose *Save as PDF* in the print dialog), Markdown (with front matter), HTML and the SEO sheet. Then send it in one of two ways.

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
| **Matchup analysis** (for a publisher) | one featured game | the football question · what EdgeDesk sees differently · the football evidence (quarterbacks, both offenses, personnel, form, history, conditions) · what could make EdgeDesk wrong · what has to happen on the field · what to watch and what we still don't know. Prose, no software terms, 800–1,600 words; manual approval always |
| **EdgeDesk analysis** (first-party, library format) | the same game, for EdgeDesk's own pages (not offered in the publisher queue: EdgeDesk's own articles live in `content_engine.first_party`) | the same journalist-first order as a research page: a fact sheet, the numbers, the evidence by unit, the case against EdgeDesk, a scorecard of what each number needs, **inside EdgeDesk's number** (every model term, the diagnostics, the research status, what is not on file), what to watch. Shares under 45% of its wording with the publisher piece |
| Matchup deep dive | the week's two headline games, per league | intro · EdgeDesk's projection (with its typical miss) · how to read · what builds the number · where the matchup tilts · quarterbacks and availability (a starter-out re-run is stated as the model's scenario, never as a report) · EdgeDesk vs. the market · conditions · limits · bottom line |
| Conference race | games between a conference's three highest-rated teams | intro · why it matters · how to read · the games that shape the race · where the other contenders stand · what it means for the race (no standings feed: no standings claims) · limits · bottom line |
| Model vs. market report | a league's slate with three or more gaps EdgeDesk can explain | intro · how to read · the biggest gaps (each explained from EdgeDesk's inputs, or its unexplained share stated) · what the gaps have in common (counted, not told) · limits · bottom line |
| Postgame model review | the last finished week, from the graded record (`record/football/`) | intro · how to read a model review · how the numbers did (right winners, closer than the close, average miss, against the closing spread — a grade of the number, not a betting record) · where the model was closest · the biggest misses · the season so far · limits · bottom line |
| Publisher-specific | any of the above | the publisher's own section order, tone, length and attribution |

A matchup analysis is offered for the two highest-ranked meetings of the week and for any game where EdgeDesk and the market differ by 7+ points (CFB) or 4+ (NFL), up to three a week. The publisher and first-party versions are written separately on purpose: the database already refuses a second live article for the same research, publisher, format and angle, and the two formats differ in structure and wording, so neither is a syndicated copy of the other.

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

## Football evidence

**Why.** In Week 6 a publisher received a piece that set EdgeDesk's Ole Miss–Vanderbilt number (Ole Miss by about 1) beside a market that made Ole Miss a 9.5-point favourite, with no football reason for either. The old writer printed only the model's mechanics and "Model confidence: High"; the validator only checked that each number existed somewhere in the research. EdgeDesk's own game page had already labelled that gap a DATA FAULT. The repair is in the shared pipeline, so every format and every publisher gets it.

### One packet per matchup

`lib/football_evidence.js` builds a packet for each game from files already committed. It makes no network call, no AI call, and gives the same packet for the same inputs. `tools/content/evidence.js build` writes `football/evidence/packets.json`, and the hourly Model Lab job rebuilds it after the research terminal. A packet whose inputs did not change is reused as it was.

Each packet holds **claims**. Every claim has:
- its text, short form and values;
- its source (a committed file, an official report, or a dated outside article) and the time it was observed or published;
- its **verification** status:

| Status | Meaning | Football evidence? |
|---|---|---|
| `VERIFIED_DATA` | measured from EdgeDesk's committed play-by-play, box scores, results or schedules | yes |
| `OFFICIAL_REPORT` | a conference availability report or the NFL injury report | yes |
| `RATING` | EdgeDesk's position-group or opponent ratings | yes, weighed less than measured data |
| `REPORTED` | an outside outlet's dated article, not yet confirmed by an editor | yes, always attributed and linked, and it holds the article for review |
| `VERIFIED_REPORT` | outside reporting an editor has confirmed (`add_fact.js --verify`) | yes, attributed |
| `MODEL_OUTPUT`, `MARKET_DATA` | EdgeDesk's number and its pieces; the captured line | **never**: a model's number is not evidence of a football reason |
| `CONFLICTING` | two of EdgeDesk's own sources disagree | only to disclose the conflict |

and its **scope**: current season, historical (always dated), preseason, report or market.

What a packet covers, item by item (each is AVAILABLE, a labelled PROXY, or MISSING with the reason):
- **Quarterbacks:** completions, attempts, yards, yards per attempt, touchdowns, interceptions, sacks per dropback, the last-two-games trend, the last game, the availability report and who started last, and whether the model's starter matches the report.
- **Each offense against the other defense:** early downs, third down, red zone, explosive runs and passes, run and pass efficiency, pass protection against the pass rush, the line of scrimmage on runs, with the FBS average beside each pair.
- **Personnel:** EdgeDesk's position-group ratings, the official report's questionable, doubtful and out players, coaching change and returning roster share.
- **Situation:** points for and against, records, conference records, the last results, schedule strength (a proxy: the average EdgeDesk rank of opponents), rest, home field (and what the market has historically paid for it), the kickoff forecast, and the last meeting with its year.
- **Not used, on purpose:** turnover rates (the play-by-play feed misses fumbles) and, for CFB, penalties (EdgeDesk has no current-season penalty data). They stay MISSING; nothing is estimated.

Where EdgeDesk's own sources disagree, the packet uses the corroborated figure, marks the other `CONFLICTING`, and says so. For example, a team's sack rate is checked against quarterback logs and box scores.

### The explanation of a disagreement

For every game with a comparable line, the packet says:
- what EdgeDesk projects, the comparable market (current, last captured with its time, or a reference line), the gap and which way it points;
- the model's own terms, with their points and direction;
- how much of the gap EdgeDesk's existing disagreement explainer accounts for;
- the measured football on each side (**supporting** and **contradicting** claims) and their balance;
- an **input audit**: a stale line, a quarterback the model expects who is not the one the report lists (`QB_INPUT_CONFLICT`), a generic quarterback-absence adjustment, data conflicts, an outlier against EdgeDesk's other models, the game page's own DATA FAULT label, a league-wide home-field constant, a coaching or roster regime change, a thin sample;
- a thesis, the critical matchup (a football question), the game script each number needs, the uncertainty, and an assessment.

Then it gives one status:

| Status | When |
|---|---|
| `EXPLAINED` | identifiable pieces account for most of the gap, or the measured football supports it |
| `PARTIALLY_EXPLAINED` | some of it has support, not all |
| `UNEXPLAINED` | EdgeDesk cannot account for most of the gap. The article must say so, and must say it is not an edge |
| `NO_MATERIAL_DISAGREEMENT`, `NO_COMPARABLE_MARKET`, `NO_PROJECTION` | as named |

`actionable` is always false. A gap is research, never a recommendation, and an input the audit suspects is flagged and investigated, not explained away.

**Week 6, as the packets read it:** Ole Miss–Vanderbilt is UNEXPLAINED with suspect inputs. The model is built on Blaze Berlowitz starting, while the SEC report lists Jared Curtis as probable; the explainer accounts for about 2.0 of the 9.3 points; and the measured football leans to Ole Miss. Georgia–Alabama and Missouri–Texas A&M are EXPLAINED. Texas–Oklahoma is partly explained. UCLA–Oregon is partly explained with suspect inputs (Dante Moore is listed out, and the model prices his absence generically).

### The facts ledger: outside reporting

`football/evidence/facts.json` holds what EdgeDesk's own data cannot: an injury's nature, a coach's comment, a halftime score. Each fact carries:
- the outlet;
- the URL;
- the published date;
- who recorded it;
- an expiry, so a stale report stops being used.

It enters as `REPORTED`, and the article names and links the outlet. Any article citing it is **held for review** until an editor confirms it.

```
node tools/content/add_fact.js --file new_fact.json      # add (validated: dated, sourced, numbers in the text)
node tools/content/add_fact.js --list [--game ID]
node tools/content/add_fact.js --verify ID --by "Name"   # an editor confirms it against the primary source
node tools/content/add_fact.js --expire | --check
node tools/content/evidence.js plan --featured           # what each featured game is missing, before anyone researches
```

The research plan lists only what is missing or expired for **featured** games. Facts already on file and current are reused, never looked up again.

### The gate

`FE.gate()` runs inside `validate()`: in the page, in the weekly job, and in the Edge Function on every AI rewrite. If the module is not loaded, the article fails closed. Each featured game is checked:

| Check | Fails when |
|---|---|
| Evidence packet | a featured game has no packet, or its packet was built from different numbers than the research (stale) |
| Football evidence | fewer than 5 football claims are cited in a single-game piece, or 2 per game in a slate. Model output, the line, and who is available do not count |
| Quarterbacks discussed | a single-game piece does not cite measured quarterback play for both teams |
| Injuries addressed | a material injury, or a conflict between the model and the report, goes unmentioned. A conflict must be stated, not just named |
| Contrary evidence | where EdgeDesk differs from the line, nothing argues the other side. A single-game piece needs two contradicting claims in its counterargument or game script |
| Unexplained disclosed | an UNEXPLAINED or suspect gap is not called unexplained **and** not an edge |
| Causal claims supported | the article says the model likes a team *because of* a football stat, or gives a cause for an unexplained gap |
| Injury status correct | "X will start", "X is out" or "X is cleared" contradicts the report |
| History dated | a past meeting is stated without its year in any sentence that states it |
| Gap arithmetic | the model-versus-line gap is misstated |
| No edge language | "value side", "mispriced", "the market is wrong", "sharp money", "betting edge" |
| No repetition | a sentence of eight or more words appears three times (a warning at two) |
| No software jargon | publisher formats only: model versions, "ensemble", "pipeline", "explainer", code identifiers |
| Sources known | a link to a source outside the research |
| Reported attributed | outside reporting without its outlet |

The number check is stricter too. A figure from a claim is valid only in a sentence that cites that claim, so a real number moved onto the wrong statement fails.

**Readiness.** Every check report now ends in one of three states:
- **BLOCKED**: a hard check failed.
- **HOLD_FOR_REVIEW**: it passes, but it cites unconfirmed outside reporting or EdgeDesk's inputs are suspect. The review panel lists each hold, and the owner's source-verification point is the confirmation.
- **READY**: nothing is held.

Fluent prose, SEO metadata or an AI quality score cannot move an article out of BLOCKED or HOLD. The review panel shows an **Evidence record**: every central claim with its source, time and verification status.

**With the editorial gate (14 checks).** The evidence checks feed it:
- a failed evidence check is **BLOCKED** under *Unsupported factual claims*;
- each hold is a **WARNING** under *Overall factual reliability*.

The quarterback and injury claim checks accept a sentence that states an official availability report, attributed outside reporting, or the model-versus-report conflict from the game's packet. The Content Engine's research does not carry the CFB conference availability reports; the packet does.

**Every format that features a game argues it with football.**
- The weekly previews and the conference race use the evidence capsule.
- The matchup deep dive is held to the single-game standard: its unit matchups, quarterbacks and availability come from the packet.
- The model-vs-market report and the first-party features add the football to each gap they explain:
  - the case each way;
  - both quarterbacks;
  - what EdgeDesk cannot explain, said to be not an edge.

### EdgeDesk's own game pages

`tools/articles/generate.js` and the editorial pipeline attach the packet's summary to each pregame record. The page gains a section, **The football behind the number**: the quarterbacks, the case each way, the research status and the sources.

Automatic publishing is **held** (`manual_review`, with the reason) when:
- the game has no packet;
- the inputs are suspect;
- the page cites unconfirmed reporting.

An explicit `--publish --game` remains the owner's override. The integrity check counts the packet's figures as supported.

### Cost

- **Packets** are deterministic and built once per matchup per research change, from committed files. The slate and the single-game piece read the same packet (trimmed for a slate).
- **Outside research** is for featured games only, and only what the plan lists as missing.
- **Claude** gets the packet in its request, and at most **two attempts** per draft. A retry rewrites only the section that failed when one section holds every failure. Every call goes through the shared monthly AI budget and its ledger (*AI cost protection*, below): reserved before it is made, settled with the API's usage, cached for 30 days.
- **No new paid API** is used.

### Metrics

`content_engine_editorial_metrics(days)` (owner only) reports, from what the database already records:
- **editorial acceptance**:
  - articles that passed their initial checks, held for review, or blocked;
  - average revisions before approval;
  - unsupported claims the gate caught (by check), and AI drafts discarded;
  - approved, sent and published articles, and the publisher acceptance rate;
- **traffic and conversion**: tagged visits, sessions, sign-ups, trials and paid conversions, plus publisher-reported page views;
- **cost**: Claude calls, tokens and estimated cost, per published article and per paid conversion.

The three are kept apart. A figure the database does not measure is null and says so; nothing is estimated.

---

## Quality gates

These checks run in the page, in the job and in the function, and the database adds its own floor.

The football evidence gate (above) runs first, as part of the same report.

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
- the stored checks include the football evidence gate, and it did not block the article (`content_engine_evidence.sql`);
- the five-point review is complete, for the current content hash;
- the approval is for the hash on screen;
- its own banned-phrase lint is clean.

An edit after approval returns the article to review, and sent content is frozen.

**Reliability checks added in the hardening:**

| Check | What it enforces |
|---|---|
| Numbers reconcile | a projected score's difference is the margin and its sum the total, to the tenth; a win chance is EdgeDesk's. Conflicting source figures are never repaired: the game is flagged. |
| Data quality is not confidence | the evidence-quality score is printed as "data quality", never "confidence" in a result |
| Quarterback claims supported | doubt about a quarterback only where the starter data shows a competition or an availability report (`qbState`: CONFIRMED, ESTABLISHED, COMPETITION, AVAILABILITY, UNKNOWN). A split is written only when the model's starter-out scenario moves the number a point or flips the favorite. |
| Injury and news claims supported | an injury or news claim names a report on file, or is cut |
| Results reconcile (postgame) | every final score, winner and pregame margin matches the graded record |

**Model–market discrepancies.** A gap of 3+ points is explained from EdgeDesk's own decomposition and the historical explainer; the share its inputs cannot explain is stated, never filled with a story. 3+ unexplained points → review; a 7+ point gap with 5+ unexplained → **blocked** until the owner records a written review of that game.

**Weather** comes from the committed forecast (`football/venues/forecasts.json`): wind ≥ 20 mph, gusts ≥ 35, precipitation ≥ 0.25 in, storms, snow, ≤ 25°F or ≥ 95°F are hazards; a forecast older than 12 h is stale; a game with no forecast is "not verified".

### The editorial gate (14 checks)

Before an article can be **approved**, marked **Ready to send**, or **sent**, the gate runs on that exact version against the research as it reads *now*: schedule, teams, projections, the model snapshot, market freshness, availability, claims, repetition, headline, SEO, the publisher's format, the referral link, responsible gambling, and overall reliability. Each finding is PASS, WARNING or BLOCKED, with its evidence, its fix and the sections to fix.

- The **database** stores the report with the content hash and refuses approve / Ready / Send (in the doors *and* the table's trigger) unless the report is for this version, under 24 hours old, and not BLOCKED.
- A block that needs judgment — an unexplained market gap — clears only with the owner's **written review** on record (**Record my review…**). Recording or withdrawing a review makes the gate run again.
- **Fix flagged sections** rebuilds only those sections from the current research (no AI, no cost); every other section is kept byte for byte.

### AI cost protection

- **One shared monthly budget** (default **$10**, Settings → AI budget). Each call reserves its worst case (the full output allowance at list price) **before** it is made, under one database lock, so parallel calls cannot overrun it; it is settled with the token counts the API returns. Warnings at 50, 75 and 90%; no call that could pass 100%. The engine never raises the budget.
- **Estimated ≠ billed.** Spend is estimated from token counts at list prices (stored in settings, labelled estimates). Enter the invoice under Performance → *Record a cost*; the scorecard then uses the billed amount.
- **No wasted calls.** A deterministic precheck runs first (research over 36 h old, a game kicked off, figures in conflict → no call). The same request within 30 days is served from the ledger's cache. Section rewrites ask for one section with a smaller output cap. One retry, after a pause, only on 429/5xx. The daily call cap still applies.
- **AI.** Claude is called with structured JSON output, the frozen research packet, the current draft and the publisher's profile, and told the hard rules. It also gets each game's football evidence packet and the rules that go with it: cite claims, attribute reporting, never give a cause the packet does not support, call an unexplained gap unexplained. A retry rewrites only the section that failed when one section holds every failure. A version that fails a check gets the objections and one more try; failing again, nothing is saved and the deterministic draft stands. The default model is `claude-opus-5-5`.

### Measurement, targets and the bottleneck

**Performance → Business scorecard** (`content_engine_scorecard`) shows the 90-day targets against what was measured: articles a week and a month, first-pass rate, factual errors, AI spend, active partners, placements, referral visits, registrations, paid, new MRR, cost per customer and revenue to cost — each *met*, *on track* (ramped targets are pro-rated over 90 days), *behind* or *not measured* (never shown as zero). The funnel runs generated → first-pass → approved → sent → published → visits → registrations → trials → paid → retained.
- **Attribution**: direct = the account's last touch is the article's campaign (within 30 days); assisted = first touch only (within 90), shown apart and never added. Confirmed accounts only; owners excluded.
- **Revenue** is Stripe's: invoices less refunds, de-duplicated by invoice and charge. MRR is each active subscription's latest invoice.
- **The bottleneck** is the first stage below the rate the targets imply, with enough of a sample to say so.
- **The weekly summary** (Performance) says what earned publication, which checks keep failing and which AI work was wasted, and recommends changes; nothing is compared below 3 articles and 50 visits a side, and an AI acceptance rate needs 4 calls.

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

## EdgeDesk's own articles (first-party)

EdgeDesk publishes up to **three articles a week on edgedesksports.com**, in Central Time:

| Day | Article | Built from |
|---|---|---|
| Monday | **Weekend Model Review** — the weekend's results against the numbers published before kickoff, the closest calls, the biggest misses, the season | the graded record (`record/football/`) |
| Wednesday | **Weekend Storylines** — three to five storylines, each built on a number (a headliner, a conference race, an upset chance, an explained market gap, weather, a quarterback question) | this week's research |
| Friday | **The Weekend in Five Numbers** — the closest call, the biggest favorite, the best underdog chance, a normal miss, an explained gap or the NFL headliner | this week's research |

A slot is **skipped, with its reason**, when the research does not support it. Headlines lead with a storyline that is a fact in the research. A game whose market gap EdgeDesk cannot explain is left out of an unattended article, and the article says so.

**The workflow:** RESEARCH → GENERATION → VALIDATION → SCHEDULED → PUBLISHED, or HELD FOR REVIEW. An article is published without a person only when **all twelve gates** pass:
1. today's Central Time slot is this article's;
2. at most three a week, one per slot;
3. the research is fresh (≤ 36 h);
4. no featured game has started or starts within the hour (Monday: every game reviewed is final and graded);
5. the 14-check editorial gate: nothing blocked, no unexplained market gap;
6. every hard validation check;
7. every number traces to the research and reconciles;
8. responsible gambling: no pick or staking language, "not a bet" explained, the 21+ disclaimer;
9. a URL of its own and no near-copy (≥ 50%) of anything EdgeDesk has published;
10. a distinct angle (< 35% overlap) from the week's publisher articles;
11. SEO: headline, description, URL and keyword complete;
12. cost: any AI went through the shared budget ledger.

**The mode** (*EdgeDesk articles* tab; enforced by the database): **Off**, **Dry run** (the default: built, gated and kept here; nothing published), **Auto** (published when all twelve pass; otherwise held). A held article can be read in full, with each gate's reason, and **approved (this exact text)** or **rejected**; the next run publishes what you approved if its research is still fresh and no game in it has started. The job can never approve, never mark anything published that did not clear the gates or your approval, and never exceed three a week.

**Publishing** is one file, `features/records/<id>.json` (outside `articles/`, which other jobs restore wholesale when their pushes race), pushed alone. The next site build (the editorial job builds every quarter hour) renders the page, the features hub (`/articles/features/`: categories and a monthly archive), the strip on `/articles/`, the sitemap and the published index. A published record removed by a race is written back on the next run.

**The page** is server-rendered static HTML: canonical to itself (never to another site), NewsArticle + BreadcrumbList structured data, Open Graph and Twitter tags, byline, Central Time dates, breadcrumbs, related research, sources, the disclaimer, and **one call to action: "Explore the full matchup research on EdgeDesk."** No trial strip, no header button, and no campaign tags on internal links.

**Stadium Rant and other publishers.** First-party articles take a different angle from the publisher pieces (gate 10 measures it), claim no other site's URL, and are never sent to a publisher. Publisher articles keep their own workflow: owner approval, owner send.

**The reader funnel** (Growth Console → *EdgeDesk's own articles*): impressions and organic visits (Google Search Console), visits, engaged readers (30 s visible and half the page read; **never measured for a browser with Global Privacy Control or Do Not Track**), clicks to the matchup research, registrations (direct, and assisted shown apart), trials, paid and revenue — against the 90-day targets of 500 organic visits, 100 article-to-research visits, 25 registrations and 3 paid a month.

**Rehearse before turning on Auto:** `npm run features:rehearsal` copies the whole site and a throwaway database, runs a dry-run Monday then an Auto week, builds the real site, runs the SEO audit and checks every page in Chromium. It last passed 41 of 41 steps.

---

## Rollback

1. Run the previous release of `supabase/content_engine.sql` (`git show 007ac82a:supabase/content_engine.sql`), then `supabase/content_engine_hardening_rollback.sql` (it refuses to run until step 1 is done). This removes the gate, the AI ledger, measurement and first-party state; the activity log is kept.
2. `supabase/first_party_funnel_rollback.sql` removes the Growth Console report. The `article_engaged` event kind stays: it belongs to `supabase/funnel.sql`'s registry.
3. Redeploy the previous Edge Function and admin page; disable `edgedesk-features.yml`; to unpublish a feature, delete its record in `features/records/` (its page leaves at the next build).

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
npm run content:test      # the core against the committed research + static guards (317 checks), the football evidence pipeline (188), the facts ledger, the inline copy
npm run content:evidence:test  # the evidence pipeline, the facts ledger and the evidence migration on their own
npm run content:evidence  # rebuild football/evidence/packets.json from the committed research
npm run content:sql       # the database on a real PostgreSQL (183) and the evidence migration (23)
npm run content:fn        # the Edge Function as deployed, against that database (69)
npm run content:job:test  # the weekly job as the service role, through the AI ledger (28)
npm run content:e2e       # the owner's whole flow in Chromium: the gate, a written review, approval, both ways of sending, the scorecard, the AI budget, EdgeDesk articles (70)
npm run features:test     # first-party: calendar, builders, the twelve gates, the page, the job, the database rules (90)
npm run features:funnel   # engagement (consent respected) and the Growth Console report on a real database (25)
npm run features:rehearsal # the production-like rehearsal: a copy of the site, a dry-run then auto week, the build, the SEO audit, Chromium (41 steps)
npm run content:example   # write an example article (Word, Markdown, HTML, SEO sheet) from the current research to content-example/
```

`tools/content/evidence.test.js` holds the pipeline to the Week 6 complaint on a frozen copy of that week (`tools/content/fixtures/evidence_2026_w6.json`):
- the Ole Miss–Vanderbilt analysis must avoid the eight failures the publisher named;
- the old writer's slate must fail the new gate, and the new one pass;
- each adversarial edit must fail the right check (29 cases: an invented statistic, a real number moved onto the wrong claim, edge language, a wrong injury status, undated history, a dropped disclosure or counterargument, a code identifier, and more);
- Georgia–Alabama, Texas–Oklahoma, Missouri–Texas A&M, UCLA–Oregon and an NFL game must pass in both analysis formats (publisher and first-party);
- the two formats must stay different articles;
- today's research must also pass, generated end to end.

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

**Hardening and first-party publishing: built.** The editorial gate, AI cost protection, measurement and the scorecard, the weekly summary, five more templates, and EdgeDesk's own Monday/Wednesday/Friday articles with their reader funnel (above).

**Phase 4 — football evidence: built (October 2026).**
- one evidence packet per matchup;
- the model–market explanation and input audit;
- the editorial gate and readiness;
- the matchup analysis format (publisher) and the first-party analysis format (library);
- the facts ledger;
- the game-page section and the auto-publish hold;
- the evidence floor and editorial metrics (migration to apply by hand).

**Limitations**
- **First-party AI.** EdgeDesk's own articles are written by the deterministic writer; there is no AI pass for them yet (gate 12 is ready for one: any AI must go through the shared ledger).
- **Organic visits** are Google Search Console clicks; other search engines are not measured.
- **Consent.** The site has no consent banner. Global Privacy Control and Do Not Track switch off Google Analytics and engagement measurement; the first-party page-view and visit counts (no personal data) still run, as they did before.
- **Outside reporting is unconfirmed until an editor checks it.** The Week 6 facts were recorded from search results; the development sandbox could not open the primary pages. They are REPORTED, and any article citing them is held for review until `add_fact.js --verify`.
- **EdgeDesk's own inputs.** The packets flag them; fixing them is model work outside the Content Engine. Two examples: the CFB model's quarterback input lags the availability reports (Ole Miss–Vanderbilt), and sack attribution in the play-by-play disagrees with box scores across the slate.
- **Not in EdgeDesk's data:** CFB penalties, reliable turnover rates, and a strength-of-schedule measure (a labelled proxy is used).
- **CFB prices are mostly stale.** Most CFB games carry no fresh price (5 of 55 in Week 6), and NFL quotes are the last captured lines. The articles say so; market-discrepancy topics score lower until prices are fresh.
- **NFL confidence.** The NFL model publishes no confidence score, and NFL BET/LEAN/PASS decisions are computed only in the browser, so the engine does not cite them.
- **CFB records and standings.** CFB win–loss records and conference standings are not in the committed research. Conference pieces read races through ratings and projections, and say so.
- **News feeds.** The RSS feeds could not be reached from the development sandbox. Parsing and matching are tested against fixtures, and the feeds run from the Edge Function and GitHub Actions.
- **Search demand.** Demand stays an estimate until Search Console has matching queries. There is no keyword-volume provider.
- **Publisher analytics.** There is no integration with publishers' analytics: publisher page views are entered by hand.
- **Delivery.** Delivery is by email, and only when the owner presses Send (or by hand, recorded). There is no CMS or shared-document integration; one should still require the owner's approval per article.
- **Email delivery status.** Resend's delivered, bounced and complained events for these emails are not yet read back. The page shows what Resend accepted, not what reached the inbox.
