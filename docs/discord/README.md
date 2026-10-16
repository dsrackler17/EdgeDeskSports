# Automated Discord posts

One edge function, `supabase/functions/discord_cron`, posts to the EdgeDesk
Discord through webhooks, on pg_cron schedules. Every post goes through one
helper, `postToDiscord(webhookSecretName, payload)`.

| post | channel (secret) | when (Central) | action |
|---|---|---|---|
| Weekly CLV scorecard, plus the free samples' record | `DISCORD_WEBHOOK_CLV_RESULTS` | Mondays 10:00 | `scorecard` |
| Yesterday's results (how EdgeDesk's numbers did), then the daily slate with EdgeDesk's own numbers | `DISCORD_WEBHOOK_NFL`, `_CFB`, `_NBA`, `_CBB`, `_NHL` | daily 10:00 (results wait for 10:30 if a final is unverified) | `slate` |
| Free research sample, and its follow-up after the close | `DISCORD_WEBHOOK_CFB`, `DISCORD_WEBHOOK_NFL` | detection + 3 h, never later than kickoff − 60 min | `samples` (every 15 min) |

Files:

- `supabase/functions/discord_cron/index.ts`: the function.
- `supabase/discord.sql`: the send log `discord_posts` and the once-per-date claims.
- `supabase/discord_samples.sql`: the append-only sample ledger.
- `supabase/discord_cron.sql`: the three pg_cron jobs.
- `.github/workflows/deploy-discord.yml`: a manual deploy.
- `.github/workflows/discord-tests.yml`: the CI checks.
- `tools/discord/discord_cron.test.js` and `tools/discord/discord_sql.test.js`: the tests, also run by `npm run discord:test` and `npm run discord:sql`.

## Where every number comes from

Every number comes from data the pipeline already owns. Nothing is computed
twice, and nothing is typed in by hand.

### Scorecard

**CLV, graded signals and beat the close** come from `public_record`, read with
the same filter the public record page uses (`record.html`, `EDGEQ`:
`flagged_at` not null, `flagged_edge` between 0.005 and 0.1).

- CLV is the page's own unit: the entry price against the de-vigged closing
  price, shown as a percent.
- Beat the close is the share of rows with a CLV above zero, as the page
  computes it.
- The week is the previous Monday 00:00 to this Monday 00:00 Central, by
  `graded_at`. The season starts on Aug 1.

**Brier** comes from `perf_grades`, the database mirror of the `/performance/`
ledger. It uses the headline tier that page uses: the latest revision of each
game, eligible, not a push, `VERIFIED` only. A window with no verified game
falls back to `RECORDED`, labelled "recorded pregame, not ledger-verified".

- The mirror is filled only when the repository variable
  `PERFORMANCE_SUPABASE` is `on` (`.github/workflows/performance.yml`).
- Without it, the scorecard prints "no graded forecasts". If the mirror cannot
  be read, it prints "unavailable".

**Small samples.** Fewer than 10 graded signals prints the numbers and
"⚠️ Small sample". Nothing is hidden, and a negative week prints exactly like
a positive one.

### Slate

| sport | schedule | current line | opening line, move | weather |
|---|---|---|---|---|
| NFL | `today/slate.json` | `collective.odds_board` consensus (median across books) | its opening (median of each book's first stored price) | `football/nfl/slate.json` forecast, outdoor roofs only |
| CFB | `today/slate.json` | `cfb_lab_consensus_now` (median across books) | `cfb_lab_predictions.opening_spread` (rule `cfb_lab_open_v1`) | `football/venues/forecasts.json`, non-dome only |
| NBA, CBB, NHL | `today/slate.json` | one book's quote via ESPN, named as one book; hockey shows the moneyline when no puck line is priced | none: EdgeDesk keeps no opener, so no move is drawn | none (indoor) |

**When the consensus feed is down** (the NFL odds feed is paused until
2026-11-01), the NFL and CFB slates fall back to the one ESPN book, and the post
says so. They are skipped only if that book is missing or stale too.

**EdgeDesk's own numbers.** Each game also shows EdgeDesk's own numbers from
`engine/projections.json`, which every engine freezes before any price is read
and rebuilds every 3 hours:

- the side EdgeDesk favours and its %;
- the fair moneyline and fair line;
- the projected score and the total.

A **Gap** line follows it. It gives EdgeDesk's line against the book's in
points (or, for hockey, its % against the book's no-vig %), the total against
the book's, and the market's validation state from `engine/registry.json`. A
gap is described, never called a pick. A game with no projection says so. A
slate the model has nothing for, such as the NBA preseason, says so once.
Projections older than 8 h are left out, with the reason.

**A skip, logged, never a partial post.** The slate is skipped in any of these
cases:

- there are no games;
- `today/slate.json` is older than 3 h;
- the sport's schedule sync is not `ok` / `fallback`;
- the line source cannot be read, or its newest line is older than
  `DISCORD_LINE_MAX_AGE_MIN` (3 h), with no fresh ESPN book to fall back on.

### Morning results

Before each slate, the sport's channel gets yesterday's results: how
EdgeDesk's pregame numbers did, every game. They come from the `/performance/`
record (`performance/data`, rebuilt hourly from the hash-chained ledger), so
the grades are the public page's own.

Each game shows:

- the final;
- EdgeDesk's side and %, and whether it was the right winner;
- the Brier score;
- for football, the margin and total misses against the book's;
- how far the close moved toward or away from EdgeDesk's number.

A day's summary leads the post. Misses print exactly like hits. Forecasts
recorded before the ledger locked them are labelled.

If a final from yesterday is still unverified at 10:00, the results wait for
the 10:30 tick, then post with that game marked pending. A sport with no
games yesterday gets no results post.

The skip is written to `discord_posts` with status `skipped` and the reason.
The 10:30 tick tries once more.

### Free research samples (CFB and NFL)

**CFB** uses `cfb.analyst_flags`, the app's "Analyst pass". It provides:

- INVESTIGATE / MONITOR;
- the drivers (SP+, Elo, second-order wins, yards, third down, corroborators);
- the three observability tiers;
- the available and missing inputs;
- the data limitations.

**NFL** uses `game_research_state`, the NFL board's research status.

- It has **INVESTIGATE but no MONITOR**, so an NFL slate with no INVESTIGATE
  game gets no sample.
- It has **no observability tiers**, and the post says so.

**Selection.** Selection runs once per sport and slate date, from 08:00 CT
(`DISCORD_SAMPLE_SELECT_HOUR`).

- **Eligible:** a detection record, a fresh consensus line, and a kickoff late
  enough to post at least 60 minutes before it.
- **Chosen:** up to two eligible INVESTIGATE games. If there are none, the top
  eligible MONITOR game.
- **Order:** the fixed order `discord_sample_order_v1`.
  - CFB: more corroborating indicators first, then no conflict, then larger
    |SP+ disagreement|, then kickoff, then game id.
  - NFL: the board's own `priority_rank`, then |gap|, then kickoff, then game id.

Every candidate is written to `discord_sample_selections`, with its order keys,
its eligibility and the reason for each choice, before any game on the slate
is played.

**Detection.** Neither module stores a detection time. The `samples` tick
records the first time it sees each game classified INVESTIGATE or MONITOR
(`discord_sample_sightings`), together with the consensus line at that moment.

- The database clock stamps the record, so it cannot be backdated.
- A flag is seen at most 15 minutes after it appears.
- A flag that already existed when the job was deployed is stamped at
  deployment.

**Timing.** The post time is the earlier of these two:

- detection + `DISCORD_SAMPLE_DELAY_HOURS` (3);
- kickoff − 75 minutes, which leaves the 15-minute tick room to post before
  the 60-minute line.

The database refuses a `posted_at` later than kickoff − 60 minutes. A sample
that cannot be posted in time is recorded as `missed`, with the reason, and
it stays in the public record.

**Follow-up.** The follow-up is posted once the close exists: 4 h after kickoff
or later, giving up after 48 h. It gives the closing line, and the CLV in
points at detection and at post time.

- The CLV is measured on the side the research flagged: `undervalued_side` for
  CFB, the gap's direction for the NFL. That side is frozen at selection and
  is never shown before the close.
- The CFB close comes from `cfb_lab_market_lines` (`CLOSE`, `CONSENSUS`).
- The NFL close comes from the odds board's closing line.
- A negative CLV is posted in the same format as a positive one.
- With `DISCORD_BOT_TOKEN` set, the follow-up is a reply in a thread on the
  sample. A webhook cannot start a thread in a text channel. Without the
  token, it is posted in the channel with a link to the sample.

### What to know today (2026-10-16)

- **NFL lines.** They come from the odds feed, and paid odds retrieval is
  paused until 2026-11-01 (`docs/odds-api-incident-2026-10/INCIDENT.md`). Until
  the feed is fresh, the NFL slate is skipped with "line sync failed", and NFL
  sample candidates are logged as "no fresh consensus line". This is the rule
  working as intended.
- **CFB lines.** They come from the CFB Lab's ESPN capture, which is
  unaffected.
- **CBB.** There are no men's college basketball games on the slate yet. Its
  channel gets logged "no games" skips until there are.
- **Assumed join.** `cfb.analyst_flags.game_id` is assumed to equal the ESPN id
  that `cfb_lab_*` uses (CFBD game ids are ESPN's). If they ever differ, CFB
  candidates show up in the selection log as "no fresh consensus line".

## Set up (once)

Run these from the repository root with the Supabase CLI logged in
(`supabase login`).

**1. The SQL.** Paste these three files into the SQL editor, in this order:

1. `supabase/discord.sql`
2. `supabase/discord_samples.sql`
3. `supabase/discord_cron.sql`, after step 3 below.

Each file ends in a report whose rows should all say `ok`. Alternatively, run
**Deploy Discord posts** with `apply_sql`, which needs the `SB_DB_URL` Actions
secret.

**2. The function's secrets.** Keep the values out of the repository and out of
shell history by putting them in a file outside the repo. In Discord, create
each webhook under Channel → Edit → Integrations → Webhooks → New Webhook →
Copy Webhook URL.

```bash
umask 077
cat > ~/edgedesk-discord.env <<'EOF'
DISCORD_WEBHOOK_CLV_RESULTS=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_NFL=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_CFB=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_NBA=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_CBB=https://discord.com/api/webhooks/...
DISCORD_WEBHOOK_NHL=https://discord.com/api/webhooks/...
DISCORD_DRY_RUN=1
EOF
# open the file in an editor and paste the six real URLs, then:
echo "DISCORD_CRON_SECRET=$(openssl rand -hex 32)" >> ~/edgedesk-discord.env
supabase secrets set --project-ref iattxbkbufslbauoumga --env-file ~/edgedesk-discord.env
```

Optionally, set `DISCORD_BOT_TOKEN` so follow-ups can reply in threads. Add it
to the same file and set it again. It needs a bot in the server with **View
Channel**, **Send Messages in Threads** and **Create Public Threads** on the
CFB and NFL channels.

**3. The same cron secret, in Vault.** pg_cron sends it as `x-cron-secret`.
Use the dashboard (Project Settings → Vault → Add new secret, name
`discord_cron_secret`) or the SQL editor:

```sql
select vault.create_secret('<the DISCORD_CRON_SECRET value>', 'discord_cron_secret');
```

Then run `supabase/discord_cron.sql`.

**4. Deploy.** Run the **Deploy Discord posts** workflow, or:

```bash
supabase functions deploy discord_cron --project-ref iattxbkbufslbauoumga --no-verify-jwt
```

`--no-verify-jwt` is required: pg_cron sends no JWT. The function refuses
every POST without the matching `x-cron-secret`.

**5. Check the wiring.** The probe reports which secrets are set (true or
false), never their values:

```bash
curl -sS https://iattxbkbufslbauoumga.supabase.co/functions/v1/discord_cron
```

## Preview (dry run), then go live

With `DISCORD_DRY_RUN=1`, every run prints `DISCORD_DRY_RUN {...}` in the
function's logs and posts nothing. It also claims nothing and writes no sample
ledger rows. The scheduled runs do this on their own. To preview at any hour:

```bash
SECRET=$(grep '^DISCORD_CRON_SECRET=' ~/edgedesk-discord.env | cut -d= -f2)
for a in slate scorecard samples; do
  curl -sS -X POST https://iattxbkbufslbauoumga.supabase.co/functions/v1/discord_cron \
    -H 'content-type: application/json' -H "x-cron-secret: $SECRET" \
    -d "{\"action\":\"$a\",\"dry_run\":true,\"ignore_schedule\":true}"
done
```

`"dry_run": true` in a call can only turn dry run on, never off. The response
carries each would-be message under `printed`. Without dry run,
`ignore_schedule` posts for real: still at most once per channel and date.
That makes it the way to send a missed slate by hand, and a mistake to run by
accident.

To go live:

```bash
supabase secrets unset --project-ref iattxbkbufslbauoumga DISCORD_DRY_RUN
```

## Watch it

```sql
-- every failure, partial or unknown send
select sent_at, channel, type, post_key, status, http_status, error
  from public.discord_posts where status in ('failed', 'partial', 'unknown') order by sent_at desc;

-- why a channel got nothing today (skips carry the reason)
select sent_at, channel, type, status, error from public.discord_posts
 where sent_at > now() - interval '1 day' order by sent_at desc;

-- the sample ledger: what was chosen, why, and how it went
select sport, slate_date, note, chosen, candidates from public.discord_sample_selections order by slate_date desc;
select sport, slate_date, home, away, classification, status, scheduled_post_at, posted_at, miss_reason,
       line_at_detection, line_at_post, close_line, clv_at_detection, clv_at_post
  from public.discord_samples order by slate_date desc, sport, rank;

-- did the pokes arrive?
select id, status_code, left(content::text, 300) from net._http_response order by id desc limit 10;
```

**Never twice.** Each post is claimed per type, channel and date before it is
sent (`discord_post_claims`).

- A Discord 4xx is `failed`, and a rerun may try again, three times in all.
- A network error, a 5xx, or a multi-message post that stopped half way is
  `unknown` or `partial`, and is never retried automatically, because Discord
  may have shown it.
- If you check the channel and it did not appear:

  ```sql
  select public.discord_release_post('slate:DISCORD_WEBHOOK_NFL:2026-10-18', 'checked the channel: it never appeared');
  ```

## Settings

| secret | default | meaning |
|---|---|---|
| `DISCORD_DRY_RUN` | off | `1` prints instead of posting |
| `DISCORD_SAMPLE_DELAY_HOURS` | 3 | hours after detection a sample is posted |
| `DISCORD_SAMPLE_SELECT_HOUR` | 8 | Central hour each slate's samples are chosen |
| `DISCORD_SLATE_HOUR`, `DISCORD_SCORECARD_HOUR` | 10 | Central hour (the cron fires at 15:00 and 16:00 UTC so both CDT and CST reach 10:00) |
| `DISCORD_LINE_MAX_AGE_MIN` | 180 | an older line source is a failed sync |
| `DISCORD_SCHEDULE_MAX_AGE_MIN` | 180 | an older `today/slate.json` is a failed sync |
| `DISCORD_FOLLOWUP_AFTER_HOURS` | 4 | hours after kickoff to look for the close |
| `DISCORD_SIGNUP_URL` | `https://edgedesksports.com/#pricing` | the samples' link (no affiliate code) |
| `DISCORD_RECORD_URL`, `DISCORD_PERFORMANCE_URL` | the public pages | the scorecard's links |

The cron window in `supabase/discord_cron.sql` (15:00 and 16:00 UTC) reaches
10:00 CT under both CDT and CST. Any other hour for `DISCORD_SLATE_HOUR` or
`DISCORD_SCORECARD_HOUR` also needs that window moved.

## Stop it

```sql
select cron.unschedule('discord_slate');
select cron.unschedule('discord_scorecard');
select cron.unschedule('discord_samples');
```

Re-running `supabase/discord_cron.sql` brings the jobs back. The log and the
sample ledger are kept either way.
