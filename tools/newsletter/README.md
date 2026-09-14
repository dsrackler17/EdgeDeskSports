# The EdgeDesk research newsletter

**Two weekly emails, sent by nobody.**

| | when | what |
| --- | --- | --- |
| **College Football Week Ahead** | Monday 10:00 `America/Chicago` | the upcoming FBS week, all conferences |
| **NFL Week Ahead** | Tuesday 10:00 `America/Chicago` | the upcoming NFL week, after Monday Night Football |

Each edition carries **the five most worthwhile upcoming games to research**,
expanding to at most ten when more of them clear a higher bar, and fewer —
including none — when they do not. It is research, not picks: EdgeDesk's own
number beside a book's, the evidence behind the difference, and the thing the
model could not see printed next to both.

---

## The shape of it

```
   the article records, refreshed from the research terminal
              │                (tools/articles/generate.js — unchanged)
   market.js  │  live book quotes out of public.signals, replayed
              │
   slate.js       which games are the upcoming week, by the feed's own
              │   season and week columns. Started games excluded.
   select.js      which of them are worth researching — evidence first,
              │   raw gaps last. Itemised, arguable, never padded.
   compose.js     the edition draft. Every sentence assembled from fields
              │   the payload already published.
   render.js      email HTML with inline styles, and a real plain-text half
   validate.js    the gate: recomputes what the copy asserts and refuses it
              │   when the two disagree
   store.js       the committed record + the rendered bodies
   runtime.js     the database: settings, editions, deliveries, the lease
   provider.js    Resend — batched, idempotent, one-click unsubscribe
              │
   run.js         schedule → refresh → select → draft → validate → store →
                  send → record
```

## The files

| file | what it is |
| --- | --- |
| `schedule.js` | the edition clock. Converts a Chicago wall clock to an instant with the zone database, so daylight saving is a property of that database rather than of anybody's memory. Pure. |
| `slate.js` | the upcoming slate, identified by the schedule feed's own season and week. A game that has started is never in it; an empty slate is a real answer. Pure. |
| `select.js` | the selection engine. Scores every candidate out of ~100 across six itemised components and applies four hard refusals, one of which is *a large discrepancy standing on thin data*. Pure. |
| `compose.js` | the edition draft: subject, preview text, introduction, and one block per game. Pure. |
| `render.js` | the email. Nested tables, inline styles, no image anywhere, and a plain-text alternative that carries every fact the HTML does. Pure. |
| `validate.js` | the publication gate. Integrity failures hold the edition; craft failures score it. Recomputes the model-versus-market difference and refuses a mismatch. |
| `store.js` | the committed store under `articles/data/newsletter/`. |
| `runtime.js` | the Supabase client: settings, editions, eligibility, deliveries, the lease. |
| `provider.js` | the Resend integration, the deterministic idempotency key, and the webhook signature check. |
| `market.js` | joins live book quotes from `public.signals` into the committed market snapshot the research host replays. |
| `inputs.js` | freshness, and the Monday Night Football gate. |
| `run.js` | the orchestrator and the CLI. |
| `supabase/newsletter.sql` | the server side: consent, suppression, editions, deliveries, provider events, and the switches. |
| `supabase/newsletter_cron.sql` | the primary scheduler (pg_cron → edge function → workflow). |
| `supabase/functions/newsletter/` | the public door: subscribe, confirm, unsubscribe, preferences, webhook, and the operator's dispatch route. |
| `supabase/functions/newsletter_cron/` | the poke. |
| `newsletter/index.html` | the public signup page. |
| `admin/newsletter/index.html` | the operator console. |

## Running it

```bash
npm run newsletter:due          # what is owed right now, per sport
npm run newsletter:preview      # build both editions, write nothing to the database
npm run newsletter:build        # build and store what is due
npm run newsletter:send         # send a stored, ready edition (honours the launch gate)
npm run newsletter:rank         # the whole slate's scores, for calibration
npm run newsletter:report       # the run log, as markdown
npm run newsletter:test         # the offline suite
npm run newsletter:sql          # the migration, applied and attacked
```

One sport, one moment, one explanation:

```bash
node tools/newsletter/run.js rank --sport CFB --explain
node tools/newsletter/run.js preview --sport NFL --now 2026-11-03T16:30:00Z
node tools/newsletter/run.js test --sport NFL --to you@example.com
node tools/newsletter/run.js retry --sport NFL
```

The scheduled job is `.github/workflows/newsletter.yml`.

---

## 1 — The clock, and why the cron is not the schedule

10:00 in Chicago is 15:00 UTC for most of the year and 16:00 UTC from November
to March. A cron expression is a fixed UTC instant, so **any single cron line is
wrong for half the season**, and a line per half is a thing somebody has to
remember to change twice a year. The two failure modes are not symmetric: an
hour early sends the NFL edition before Monday Night Football has been
reconciled.

So the cron is a **heartbeat**. It fires repeatedly across 13:00–19:00 UTC on
Monday and Tuesday, and `schedule.js` decides whether an edition is actually
owed — converting the Chicago wall clock to an instant with the runtime's own
zone database, using the standard two-pass offset solve so a transition Sunday
is correct rather than approximately correct. A tick with nothing owed reads
files already on disk and exits.

An edition is due at 10:00 and stays sendable for a **retry window**
(`retry_window_minutes`, default 240). Past it the edition is *stale* and is
held with a reason rather than sent: a newsletter that arrives at 9pm is worse
than one that did not.

## 2 — Which games, and why not the biggest gaps

> *"Do not simply select the largest raw gaps."*

A ranking that sorts on `|model − market|` descending is a list of the games
EdgeDesk understands **least**. The biggest gaps in any week are produced by
thin data: a Week 2 rating still carrying its trained seed, a quote captured
three days ago at one book, a team the model has priced twice.

So the market component is **scaled by data confidence**, and there is a
separate veto. `gap_support` reads only the two things that bear on whether a
discrepancy means anything — how fresh the quoted price is and how much of the
season the rating has absorbed — and a gap over the sport's threshold whose
support is below the floor is **refused, with the reason kept and shown**. A
week where the biggest number was refused says so in the email's own
introduction.

| component | points | reads |
| --- | --- | --- |
| model versus market | 0–30 | the gap, scaled by data confidence |
| evidence depth | 0–20 | complete matchups, measured advantages, pricing drivers |
| data freshness | 0–16 | quote age, record age, the record's own publication checks |
| model reliability | 0–16 | absorbed sample, seeding, outcome-range width |
| reader interest | 0–10 | window, EdgeDesk's own ranks, rivalry — **secondary, capped** |
| uncertainty | −18–0 | unmeasured inputs, missing feeds, early season |

Hard refusals: `not_priced`, `checks_failed`, `already_started`,
`gap_outruns_evidence`.

**Thresholds are per sport and that is not arbitrary.** The market component is
the largest one, and in this deployment a college game usually has no joined
book quote at all — the NFL schedule feed publishes reference lines for every
game and the college side depends on a capture that covers a handful. A college
game's attainable score is therefore structurally about thirty points lower.
One shared floor would mean either a college edition that can never be produced
or an NFL edition that features everything.

**All of FBS, not the Power Four.** The candidate pool is every FBS game with a
research record, the reader-interest component reads *EdgeDesk's own* rating
rather than a poll, and where two games score within `diversity_band` of each
other the tie is broken toward a conference the edition does not yet carry. It
is a tie-break, never a re-ranking.

## 3 — The Tuesday gate

The NFL edition is published *after* Monday Night Football, and a final score is
not the same thing as an updated model input. `inputs.js` reports the two
separately:

* **`final_available`** — a completed result, from the editorial result store
  or from the nflverse schedule's own score columns;
* **`inputs_fresh`** — the ratings artifact was rebuilt after the game ended.

| state | what happens |
| --- | --- |
| both true | proceed |
| inside the settle window, either missing | **wait** — held with a reason, retried on the next tick |
| past the retry window, result in, ratings lagging | **send with an explicit data cutoff**, stated in the email |
| past the retry window, no result at all | **hold**, with an operator-visible reason |

## 4 — What cannot happen

| | how |
| --- | --- |
| two editions for one week | `unique (sport, season, slate_week, edition_date)` |
| two workers on one edition | `newsletter_claim_edition()`, a TTL lease in one statement |
| a second email to one person | `unique (edition_id, email)`, and only `queued`/`failed` rows are ever handed to the provider |
| a duplicate provider event applied twice | `unique (provider, event_id)` |
| a send after a bounce | eligibility is recomputed at send time, joining suppressions live |
| a browser reading the subscriber list | RLS on, **no select policy for anyone**, every read is a security-definer function returning counts or a masked address |
| a browser sending a campaign | the send path needs the service role; the console's buttons ask the pipeline, and the operator's own token is checked against `newsletter_is_admin()` first |
| an invented statistic | every number in the rendered text must be in the research payload, checked with the article system's own supported-value set |
| a wrong sign on a spread | the difference is recomputed from the two published lines and compared against what the copy says |

**Provider acceptance is not delivery.** `accepted`, `delivered`, `bounced`,
`complained` and `unsubscribed` are five separate states. An ambiguous provider
response — a timeout, a 5xx with no body — is recorded as `ambiguous` and never
as a failure, because a failure is retried and a retry after a silent success is
a duplicate email. The only safe retry is one carrying the same idempotency key,
which is what the deterministic key makes possible.

## 5 — Consent

* Public signup is **double opt-in**: a pending row, a confirmation token that
  is stored only as a digest, and nothing sent until the link is opened.
* An account is **not** consent. No subscriber row exists for an account holder
  until they turn a switch on in *Settings › Notifications*, and the source and
  timestamp are recorded on the row.
* An account address that Supabase has not confirmed goes through the same
  double opt-in a stranger does.
* Unsubscribe works **without a login**, from a token in the email, and every
  message carries RFC 8058 one-click headers so a mail client can do it
  without opening anything.
* A complaint outranks a bounce outranks an unsubscribe. Nothing a click can do
  clears the first two.

---

## Required configuration

### Secrets

| name | where | required for |
| --- | --- | --- |
| `SB_SERVICE_ROLE` | GitHub Actions secret | reading settings, resolving recipients, recording deliveries |
| `SB_URL` | GitHub Actions secret (optional) | a project other than the default |
| `RESEND_API_KEY` | GitHub Actions secret **and** `supabase secrets set` | handing an edition to the provider; the confirmation email |
| `NEWSLETTER_WEBHOOK_SECRET` | `supabase secrets set` | verifying provider webhooks (`whsec_…`) |
| `NEWSLETTER_GH_TOKEN` | `supabase secrets set` | the pg_cron scheduler and the console's dispatch buttons. A fine-grained token scoped to this repository with **Actions: read and write** |
| `NEWSLETTER_SITE_URL` | `supabase secrets set` (optional) | defaults to `https://edgedesksports.com` |

No key reaches a browser. `newsletter/index.html` and `admin/newsletter/` carry
only the project's public anon key, the same one every page ships.

### The sending domain

Resend, one account, one verified domain. In the Resend dashboard add
`edgedesksports.com` (or a subdomain — `mail.edgedesksports.com` is the usual
choice, so newsletter reputation is separate from transactional) and publish the
DNS records it gives you:

| record | purpose |
| --- | --- |
| `TXT` DKIM (`resend._domainkey…`) | message signing — required |
| `MX` + `TXT` SPF on the sending subdomain | envelope authentication — required |
| `TXT` `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@edgedesksports.com` to start, tightened to `p=quarantine` once reports are clean |

Then set the sender in `public.newsletter_settings` (or from the console):

* `from_name` — `EdgeDesk Research`
* `from_email` — `research@edgedesksports.com` *(must be on the verified domain)*
* `reply_to_email` — `support@edgedesksports.com` *(a mailbox a person reads)*
* `mailing_address` — the physical postal address printed in every footer.
  CAN-SPAM requires one. It defaults to
  `Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423`, which is the
  address already printed on the landing page — **confirm it before launch**.

### Webhooks

In Resend, add an endpoint at
`https://<project>.supabase.co/functions/v1/newsletter/webhook` subscribed to
`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced` and
`email.complained`. Copy its signing secret into `NEWSLETTER_WEBHOOK_SECRET`.
Unsigned or mis-signed deliveries are answered `401` and nothing is stored.

---

## Migration order

Run these in the Supabase SQL editor, in this order. Each is idempotent and
ends in a report whose every row should say `ok`.

| # | file | why |
| --- | --- | --- |
| 1 | `supabase/issue_reports.sql` | *(existing)* creates the operator allowlist the article system carries over |
| 2 | `supabase/billing.sql` | *(existing)* `public.subscriptions`, read to tell a member from a free reader. Optional — without it every recipient is a free reader |
| 3 | `supabase/site_articles.sql` | *(existing)* **required** — owns `site_article_is_admin()`, which this schema reuses rather than building a second operator list |
| 4 | **`supabase/newsletter.sql`** | the newsletter schema |
| 5 | **`supabase/newsletter_cron.sql`** | the primary scheduler. Needs `pg_cron` and `pg_net` enabled and the two `edgedesk.*` database settings |

Then deploy the two functions:

```bash
supabase functions deploy newsletter      --no-verify-jwt
supabase functions deploy newsletter_cron --no-verify-jwt
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set NEWSLETTER_WEBHOOK_SECRET=whsec_xxx
supabase secrets set NEWSLETTER_GH_TOKEN=ghp_xxx
```

---

## Sending a test, then opening the gate

`sending_enabled` defaults to **false**. Until it is true the pipeline builds,
validates, previews, stores and commits every edition and sends nothing. This is
a one-time gate; once open, a valid edition sends automatically.

1. **Look at a real edition.** `npm run newsletter:preview`, then open
   `articles/data/newsletter/previews/<edition>.html` — or the operator console
   at `/admin/newsletter/`, which renders the stored bodies and shows why each
   game was chosen and what was refused.
2. **Add a test address.** In the console, or:
   `select public.newsletter_admin_set('{"test_recipients":["you@example.com"]}'::jsonb);`
3. **Send the test.** The console's *Send a test* button, or
   `node tools/newsletter/run.js test --sport NFL --to you@example.com`.
   A test send goes **only** to those addresses and works while the gate is
   closed. Read it on a phone, with images off, and click the unsubscribe link.
4. **Check authentication.** In Gmail, *Show original* should read
   `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
5. **Open the gate.** The console's *Global sending* switch (it asks first), or
   `select public.newsletter_admin_set('{"sending_enabled":true}'::jsonb);`

From then on: Monday 10:00 Central, college football. Tuesday 10:00 Central, the
NFL. No approval, no button. Pause any of it from the same switches — globally,
per sport, or the dispatcher alone.

## When an edition does not go out

Every refusal is a stated reason on the stored edition and a row in the run log.

| reason | meaning |
| --- | --- |
| `not_due` / `edition_stale` | outside the window; the next one is named |
| `sport_disabled` / `sending_disabled` | an operator paused it, or the gate is closed |
| `awaiting_monday_result` | the Tuesday gate is waiting; it will retry |
| `monday_result_never_arrived` | it waited out the window and held |
| `stale_inputs` | the featured research has not been refreshed |
| `no_upcoming_games` | a bye week, a season boundary, an empty slate |
| `no_games_qualified` | nothing cleared the bar. **Not an error** — the edition is skipped rather than padded |
| `validation_failed` | the gate refused the copy; `validation.free.integrity_failed` names which check |
| `already_sent` / `partial_send` | nothing re-sends; a retry finishes what is owed |
