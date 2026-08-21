# Deploying from the repo instead of the dashboard

Copy-pasting a generated bundle into the dashboard editor has no version check.
Paste a stale copy and every screen reports success while the deployed code is
last week's. That has already cost this project a day: the odds migration was
run from an older download, so `odds.run_ingest()` never existed and nothing
was ever scheduled, while the dashboard showed a green "Success".

The CLI removes that failure mode. It reads what is committed here.

Nothing below replaces the bundles — `supabase/functions/_bundles/` still
works if you ever need the dashboard. It just stops being the normal path.

---

## One-time setup

### 1. Install the CLI

**Windows (PowerShell):**

```powershell
winget install --id Supabase.CLI -e
```

If `winget` is unavailable, use Scoop:

```powershell
scoop install supabase
```

Do **not** use `npm install -g supabase` — that package is deprecated and will
refuse to install.

Confirm it: `supabase --version`

### 2. Get the repo

```powershell
git clone https://github.com/dsrackler17/EdgeDeskSports.git
cd EdgeDeskSports
git checkout claude/collective-public-supabase-brlxo2
```

If you already have it cloned, just `git pull` on that branch. **Do this every
time before deploying.** It is the whole point.

### 3. Log in and link

```powershell
supabase login
supabase link --project-ref iattxbkbufslbauoumga
```

`link` asks for your database password (Settings → Database → Database
password). If you do not have it, reset it there — resetting does not affect
the anon or service role keys, and nothing else in the project uses it.

### 4. Tell the CLI which migrations are already applied

You ran both migrations by hand, so the CLI's tracking table is empty and a
plain `db push` would replay them. Both are written to be safely re-runnable
(verified by applying each one twice in a row against a real Postgres), so
replaying is harmless — but marking them is cleaner and faster:

```powershell
supabase migration repair --status applied 20260821090000
```

Leave `20260821140000` unmarked. You need it to run: it is the one carrying
`odds.run_ingest()` and the schedule.

---

## The one flag that has broken this twice

`supabase functions deploy` sets **verify_jwt = true** unless something tells
it otherwise. Deploying from a directory with no `config.toml` therefore turns
"Enforce JWT verification" back ON for that function, silently, on every
deploy.

When it is on and pg_net calls the function, the gateway answers
`UNAUTHORIZED_NO_AUTH_HEADER` before the function runs, so `odds.ingest_runs`
stays empty with no record of why.

Two defences, both in place:

- Deploy from the repo root, where `supabase/config.toml` sets `verify_jwt`
  per function — or pass the flag explicitly:

  ```powershell
  supabase functions deploy collective_odds_ingest --no-verify-jwt
  supabase functions deploy collective_odds --no-verify-jwt
  ```

- `odds.run_ingest()` sends the anon key as an Authorization header, so the
  schedule works whether the toggle is on or off. That is not a credential —
  it is the same public key the browser already ships, and it authorises
  nothing by itself. The gate that decides anything is `ingest.cron_token`,
  checked inside the function.

## The two commands you will actually use

From the repo root, after `git pull`:

```powershell
supabase db push                                    # apply new migrations
supabase functions deploy collective_odds_ingest    # deploy one function
```

Deploy everything at once:

```powershell
supabase functions deploy
```

`verify_jwt` comes from `supabase/config.toml`, so the "Enforce JWT
verification" toggle is set from the repo and cannot drift. You never touch
that checkbox again.

The CLI resolves `../_shared/*.ts` imports natively, so deploying from source
needs no bundling step.

---

## Right now, to get the board working

```powershell
git pull
supabase link --project-ref iattxbkbufslbauoumga
supabase migration repair --status applied 20260821090000
supabase db push
supabase functions deploy collective_odds_ingest
supabase functions deploy collective_odds
```

Then, in the SQL editor:

```sql
select odds.run_ingest();
-- wait a few seconds
select odds.last_ingest_response();
```

`status_code` 200 means it worked, and `pg_cron` takes it from there every
30 minutes. Anything else: run `supabase/RUN_ODDS.sql` section 1, which names
which of six failure modes you are in.

---

## Reading logs without the dashboard

```powershell
supabase functions logs collective_odds_ingest
```

Credentials never appear there: outbound URLs pass through `redactUrl` and
error text through `redactSecret` before anything is logged.

---

## What stays manual

Edge function **secrets**. `NFL_ODDS_API_KEY` lives in
Settings → Edge Functions → Secrets and is deliberately not in this repo. The
CLI can set them:

```powershell
supabase secrets set NFL_ODDS_API_KEY=<value>
supabase secrets list          # shows names and digests, never values
```

`secrets list` prints a SHA-256 digest per secret, not the secret. A 64-hex
string there is the digest — safe to share, and not your key.
