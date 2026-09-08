# Server side

Everything in this folder is **pasted, not installed**. There is no migration
runner and no ordering table: each `.sql` file is written to be run by hand in
the Supabase SQL editor, and every one of them follows the same three rules.

**The convention, stated once.**

1. **Idempotent.** Safe to run again, and again. `add column if not exists`,
   `create table if not exists`, `create or replace function`, guarded
   `create index`. Running a file twice must be indistinguishable from running
   it once.
2. **Additive.** Nothing is dropped and no existing value is rewritten. Where a
   file does need to write to existing rows it says so, touches only rows whose
   target column is still NULL, and changes no measurement — labelling history
   is allowed, editing it is not.
3. **It ends in a report.** The last statement is a `select` whose rows each say
   `ok` or `CHECK THIS`. A migration you cannot verify from its own output is a
   migration you have to trust, and the point of these files is not having to.

The edge functions in `functions/` are pasted the same way: one file per
function, **zero imports**, because the dashboard bundles only the folder you
are editing and an import that cannot resolve fails the bundle, gets the deploy
rejected, and leaves the previous version serving — indistinguishable from a
deploy that worked and changed nothing.

---

## The files

### `capture_v9_qualification.sql` — the qualification state
Adds the columns `capture-v9` writes: the tier, the reason, the reference type,
the evidence behind each decision, and the corroboration and raw two-way price
columns that several UI panels have read since they were written and that
nothing ever wrote. Labels flags made before v9 as `pre-v9-legacy` so the record
can report the current policy separately instead of averaging two different
systems and calling the result one number. Rebuilds `preserve_anchor_entry()` so
the entry-price freeze derives its column list from the row rather than a
hardcoded list that had already fallen out of date. Creates `book_families` and
`book_quality` **empty**, with the reason they are empty in the table comment.

Run it **before** deploying capture v9. Capture degrades safely without it —
it drops the columns the database lacks and names them in `schema_gaps` — but
until it runs, persistence streaks cannot be stored, so a Tier B candidate can
never reach its second confirmation and the actionable board stays empty.

See `functions/capture/README.md` for the environment variables and the deploy
sequence.

### `lock_rule.sql` — the Collective's 30-minute lock
Every game locks 30 minutes before kickoff. Each model's latest live submission
received before the lock is the one the board, the consensus and the grader use.
Earlier ones stay stored. Anything received at or after the lock is stored late
and never counts. Rows 1–9 of its report should each say `ok`.

Pairs with `functions/collective_ingest/index.ts`, the deployed ingest bundle
with the rule's wording corrected — paste as `index.ts` for the function
`collective_ingest`, "Enforce JWT verification" off. The client
(`collective/index.html`, `app.html`) already states and enforces the rule and
collapses the games feed to the counting row.

### `collective_model_autocreate.sql` — a contributor covers their own sports
A slate is attached to a **model** and the Collective resolves that slate's
games in that model's sport. The API exposed no model creation at all, so a
contributor with a CFB model who wanted to post NFL had nothing to attach it to
— and the dashboard said so out loud: *"self-serve model creation is not
deployed on this backend yet"*, followed by a sentence to send to the operator.
Worse, if they posted anyway, `collective_ingest` picked their only model and
the NFL rows were looked up in the **college** schedule, so every game came back
unmatched with nothing saying why.

This installs the capability in the database, for the same reason
`collective_member_removal.sql` did: `collective_join`, `collective_public` and
`collective_admin` are deployed from the dashboard and are not in this
repository, so a fix inside one of them could not be reviewed, tested, or relied
on by the other two.

* `collective.get_or_create_model(creator, sport, name)` — **the** single source
  of truth. Normalises the sport, takes a transaction-scoped advisory lock on
  (creator, sport), inserts `on conflict do nothing` and reads the row back.
  Service role only; `anon` and `authenticated` are revoked.
* `public.collective_model_ensure(sport, name)` — the door a signed-in
  contributor's browser knocks on. The creator is `auth.uid()`'s own and **there
  is no argument for it**, so nothing the page sends can claim to be somebody
  else. `authenticated` has execute; `anon` is revoked.
* `public.collective_my_models()` — read your own models back. Yours only, same
  rule, no argument.
* `collective.sport_aliases` + `sport_family()` / `sport_canonical()` — the same
  alias map `collective/index.html`'s `SPORTS` registry carries, so NFL / "pro
  football" and CFB / NCAAF / "college football" / CFB-P4 cannot become two
  models each. The **server** still owns the vocabulary: a family is written
  back in whichever code this deployment's `sports` table uses.
* a unique index on `(creator, sport_family(sport))`, which is what makes two
  simultaneous submissions produce one model rather than two. Where the sport
  column is an **enum** the index is `(creator, sport)` instead and the report
  says so — casting an enum to text is `STABLE`, not `IMMUTABLE`, so PostgreSQL
  will not index the expression; the guarantee narrows to the labels the server
  itself declared, which is all such a column can hold.

**RLS is not touched.** No policy is dropped or disabled and no client role is
granted anything on a table; both public doors are `SECURITY DEFINER` with a
pinned `search_path`. **Nothing existing is rewritten**: every model keeps its
id, slug, name and sport, so every projection, grade and record still points at
the same row.

Column names are **discovered** — `collective/admin.html` reads `sport` where
`collective_ingest` reads `sport_code`, and both shapes exist in the wild — and
the report says which it bound to. Report rows 0–5 should each say `ok`. Run it
once in the SQL editor, like every other file here.

Tested against a real PostgreSQL by `tools/collective/model_autocreate_sql.test.js`
(`npm run collective:sql`), which applies the file three times, uses it, and
attacks it: as `anon`, as one contributor reaching for another's account, with a
removed creator, with every spelling of one sport, and with **eight connections
released at the same wall-clock instant** all asking for the same missing model.
The other half — the sport deciding which model a slate goes under, and a slate
resolving against that sport's schedule — is
`tools/collective/ingest_model_resolution.test.js`, which drives the deployed
`collective_ingest` bundle. Pair it with the ingest bundle in
`functions/collective_ingest/index.ts`: that function calls
`get_or_create_model` and, on a database where this file has not been run yet,
writes the row directly so a contributor is still never blocked.

### `collective_member_removal.sql` — removing a contributor, safely
Until this file there was no way to remove somebody from the Collective except
by hand in the SQL editor: no preview, no deletion order, no rollback, no audit
and no recalculation. It installs the whole path in the **database**, so the
guarantee does not depend on a browser being honest or on which edge function
happens to be deployed:

* `collective.admin_member_preview(actor, slug)` — read-only. Exactly what a
  removal would delete and what it would preserve, counted from real rows.
* `collective.admin_member_remove(actor, slug, mode, confirm)` — the removal, in
  **one transaction**, in two modes. `membership_only` revokes access (every
  key, origin and invite goes) and keeps every submission, grade and record.
  `full_collective_delete` additionally deletes every row under that creator in
  the collective schema, and is refused unless `confirm` is the word `DELETE`.
* `collective.admin_member_activity(actor)` — submissions, graded count, last
  slate and removal state per creator, for the admin list.
* `public.collective_member_*` — the three doors a signed-in admin's browser may
  knock on over PostgREST. The acting user is `auth.uid()` and there is **no
  argument for it**, so nothing the page sends can claim to be somebody else.
  `authenticated` has execute; `anon` is revoked.

Admin is decided by `collective.mcr_is_admin()` against the config key
`admin.user_ids` — the allowlist `collective_admin` already uses, not a second
admin system.

**Nothing is hardcoded except what must be.** The Collective's schema is not in
this repository, so the creators / models / projections tables and every
dependent table are discovered from `to_regclass` and from `pg_constraint` at
call time; deletion follows the real foreign keys, deepest first, with no
`CASCADE` anywhere. What is hardcoded is what may never be deleted: games,
teams, aliases, odds, books, closing lines, sports, seasons, config; anything
financial (earnings, ledgers, payouts, invoices, billing, subscriptions,
referrals); the audit log; every other contributor's rows; and anything outside
the collective schema — `auth.users` above all. **The creator row itself is kept
in both modes** and stamped `removed_at` / `removed_by` / `removal_mode`, so a
removal is auditable and a slug cannot be silently reused. Two config keys
adjust the protected set without editing the file:
`collective.member_removal.extra_protected` and `.extra_deletable`.

A protected table that still points at rows being deleted raises its own foreign
key and the **whole removal rolls back** — half a contributor is not an outcome
this offers. The attempt is in `collective.admin_audit_log` either way; that
table has RLS on and no client grants, and records deleted credentials as a
count, never as a prefix or a hash.

Deletes on `collective.projections` go through the `collective.maintenance`
switch the append-only trigger honours, set transaction-locally so it lifts on
rollback as well as on commit. Afterwards every materialized view in the schema
is refreshed and every zero-argument `rebuild_*` / `recalc_*` / `refresh_*`
routine is run, and the response says which. Views — `consensus`,
`model_records`, `model_coverage_totals` — need nothing: they are derived, so
they are correct the instant the rows are gone.

Run it once, in the SQL editor, like every other file here. Rows 0–10 of its
report should each say `ok`. Tested against a real PostgreSQL by
`tools/collective/member_removal_sql.test.js` (`npm run collective:sql`), which
applies this file unmodified to a reconstruction of the Collective schema and
then attacks it as anon, as a contributor, twice over, and with a foreign key
deliberately in the way. The admin screen that drives it is
`collective/admin.html`, held offline by
`tools/collective/member_removal.test.js`.

**One thing this file cannot do.** `collective_ingest`, `collective_public` and
`collective_admin` are deployed from the dashboard and are not in this
repository, so they do not know the word `removed_at`. Enforcement here is
therefore structural rather than polite: the removal deletes the credentials, and
a trigger on `projections` refuses an insert for a removed contributor's model
(failing **open** on anything unexpected, so a removal that cannot be confirmed
never costs another creator their slate). When those functions are next
committed, they should read `removed_at` too.

### `publisher_briefs.sql` — shareable snapshots of a decision
Two tables, because the boundary between what is publishable and what is
privileged should be a structural fact rather than a policy that has to stay
correct. `publisher_briefs` holds the publishable payload and is readable by
anyone once `is_public` is true; `publisher_brief_internal` holds the engine
internals and is owner-only, always. Refreshing a brief inserts a NEW row with
`version_no + 1` and a `parent_id`; old rows and old share slugs stay exactly as
published.

### `brief_record.sql` — the closing line behind every published brief
`public_brief_closes`, an owner-run view that admits only rows whose game has
already kicked off, so the keyless grader
(`tools/record/grade_briefs.js`, run from a scheduled GitHub Action with the
same anon key every page ships) can read a close without the live board being
readable. A live price never leaves through it. The paywall is the live board,
not the history.

### `close_v7_parity.sql` — label how each close was measured
Adds `closing_reference_type`, `closing_ref_book`, `closing_n_families`,
`closing_ref_age_s` and `closing_policy`, and — separately — the six columns
`close` has always written and that **no file here ever created**
(`closing_dec`, `closing_book`, `closing_has_sharp`, `closing_n_books`,
`closing_source`, `closing_at_observed`); they existed only because someone
added them by hand in the dashboard, so a database rebuilt from this checkout
had a close job whose every update failed.

Labels every already-closed row `pre-v7-legacy` and touches no measurement, so
the pre-parity and post-parity populations can be segmented and never averaged.
Rows still open are left alone. Report rows 1-8 should each say `ok`.

### `book_quote_ticks.sql` — a stamped history of every book's price
`book_quotes` is upserted per `(sig_key, book_key)`, so it holds the latest pass
only and every earlier price at every book was overwritten. This adds a trigger
that appends every insert and every changed update to `book_quote_ticks` with a
timestamp, and `public_brief_book_closes`, the owner-run door giving the grader
the last tick per book at or before kickoff. A tick after kickoff is a live
price and is never a close.

Capture v9 is the first build that actually writes `book_quotes` — for
actionable signals only, since the whole board at every book would be tens of
thousands of rows per run and the actionable set is exactly the population a
book-behaviour study is about.

### `billing.sql` — the three tables the signup path needs
`billing_consents`, `referrals` and `subscriptions` have been referenced by
`index.html` and `app.html` since they were written, and **no file here ever
created any of them**. The landing page said so to the *customer*, on the
checkout screen: "Run subscriptions.sql if this table is missing." That file
does not exist in this repository either. This is it, under the names the code
actually uses.

The consent write is load-bearing. `confirmArl()` records the exact renewal
terms shown on screen *before* sending anyone to Stripe and refuses to continue
if it cannot — automatic-renewal law requires the record, so a consent that
cannot be stored must never become a charge. That refusal is correct. What it
meant with the table missing is that every signup reached the trial screen and
stopped dead, with the account **already created**, and the customer reading it
as a failed signup.

* `billing_consents` — append-only. Owner-insert, owner-read, and no update or
  delete policy for any client role: a consent record is evidence, and even its
  author cannot rewrite it. Retain three years.
* `referrals` — first-touch attribution, one row per account, keyed on
  `user_id` because the page upserts with `on_conflict=user_id`.
* `subscriptions` — **read-only to every client role.** That row *is* the
  product; a browser that could write it could grant itself the terminal. The
  Stripe webhook writes it under the service role, which bypasses RLS.

**Safe over a dashboard-built project.** Every column is added with its own
`add column if not exists` rather than relying on `create table if not exists`,
which no-ops against a table somebody made by hand and would leave a partial
shape intact — the migration would report success and the insert would go on
failing. The repo has been bitten by exactly that before (see
`close_v7_parity.sql`). Rows and existing values are untouched.

Rows 1–14 of its report should each say `ok`. Tested against a real PostgreSQL
by `tools/app/billing_sql.test.js` (`npm run billing:sql`), which applies the
file twice, applies it again over a partial hand-made table holding rows, and
then attacks the result — filing a consent under another account, rewriting or
deleting one, reading another account's rows, and a browser trying to grant
itself a subscription.

### `issue_reports.sql` — how a user tells you something is broken
The terminal has had a feedback form since it was written. It posted to
`public.feedback`, and **no file here ever created that table** — the
definition lived, if anywhere, in somebody's SQL editor history. The form's own
error message said as much to the *customer*: "run feedback.sql if the table is
missing". It could not have worked anyway: its textarea carried `id="fbBody"`,
which is also the id of the football research board three thousand lines up in
`app.html`, so the handler read the board, `.value` was undefined and `.trim()`
threw before its own try/catch. The Submit button did nothing at all — no
message, no request, nothing in the console. The one channel a first-time user
had for saying the product was broken was itself broken, invisibly.

This is the table that replaces it, and the client is `lib/edgedesk_report.js`,
loaded by the landing page, the terminal, EdgeDesk Games and the 404 page.

**Anyone may file one.** `anon` has insert. The most valuable report in this
product is "I could not sign up", and it is filed by definition without a
session; a reporting channel that requires an account cannot receive it. What
`anon` may not do is claim to be somebody — the insert policy requires
`user_id` to be null unless it equals `auth.uid()`.

**Nobody reads anybody else's.** Select is the reporter's own rows plus
`public.issue_report_admins`, an allowlist with RLS on and no client grants at
all, asked through the security-definer `issue_report_is_admin()`. `anon` has
no read policy, so an anonymous report is write-only from the browser that
filed it — which is the price of letting anyone file one, and the right price.
There is **no delete policy for anybody**, and updates are the operator's:
status, severity, a note. A report is evidence, and even its author cannot
rewrite it after filing.

**No credential can be stored.** The client scrubs the URL and never reads a
token into the payload, but the client is a browser. A check constraint refuses
a body containing a three-segment base64url string, and a `page_url` still
carrying `access_token=`, `refresh_token=` or `token_hash=`.

If a legacy `public.feedback` exists, its rows are imported once, keyed on
`legacy_feedback_id`, and the original table is left exactly where it is.

Run it once in the SQL editor. Rows 1–12 of its report should each say `ok`;
row 11 will say **CHECK THIS** if the allowlist is empty, which on a fresh
project means adding yourself:
`insert into public.issue_report_admins(user_id) values ('<your auth.users id>');`
Triage lives in `admin.html` → **Problem reports**. Tested against a real
PostgreSQL by `tools/app/issue_reports_sql.test.js` (`npm run issues:sql`),
which applies this file unmodified, runs it twice to prove idempotency, and
then attacks it as anon, as one reporter reaching for another's rows, as
somebody promoting themselves to operator, and with a JWT pasted into the body.

### `games_social.sql` — Head-to-Head and Groups
The social layer of EdgeDesk Games: challenges whose predictions are sealed
until both players lock, private groups, Elo ratings and the settlement path
that only the service role can reach. Tested against a real PostgreSQL by
`tools/games/sql_security.test.js`. See `games/README.md`.

### `games_franchise.sql` — the franchise layer
Run **after** `games_social.sql`. One fictional football franchise per
account: `franchises`, `franchise_seasons`, `game_players` (generated on the
server from a seed the server derives), `franchise_activity` (one row per real
thing that happened), `franchise_ledger` (append-only, keyed once per thing,
the source of every resource total), Pick 5 cards and selections, achievement
definitions and awards, and `game_board` — a published COPY of
`games/data/challenges.json` written only by the service role, so Price It is
scored and Pick 5 settled against the server's numbers and never a browser's.
RLS is on everywhere with owner-only reads and no client writes; every
mutation is a security-definer function that derives identity from
`auth.uid()` or the hash of the device secret presented. A trigger on
`game_challenges` turns a settled Head-to-Head into Coach Points without
changing `games_social.sql`.

Phase 2 adds the weekly game to the same file: `franchise_opponents` (a
seeded pool of twenty-four fictional clubs), `franchise_games` (one row per
scheduled game, the opponent frozen on it, the box written when it is
played), `franchises.rival_key`, four activity kinds, six achievement rows,
and the functions `franchise_start_season`, `franchise_play_week`,
`franchise_schedule` and `franchise_game`. The simulator (`franchise_sim`),
the scheduler and the writer are internal and granted to no client role.
Phase 3 adds franchise vs franchise: `franchise_challenges`,
`franchise_rivalries`, the ladder columns on `franchises`, and the
functions `franchise_challenge_create`, `franchise_challenge_peek`,
`franchise_challenge_accept`, `franchise_challenge_cancel`,
`franchise_challenges_mine`, `franchise_ladder` and
`franchise_h2h_context`. Phase 4 adds the offseason and the facilities:
`franchises.facilities`, `franchise_seasons.offseason`,
`game_players.retired_season`, three achievement rows, and the functions
`franchise_upgrade` and `franchise_trophies` (the offseason, the rookie
generator and the name pools are internal and granted to no client
role). Phase 5 adds the draft and the market: three player states
(`prospect`, `free_agent`, `passed`), `game_players.class_season`,
`scouted` and `asking`, `franchises.draft_picks` and `market_season`,
four achievement rows, five activity kinds, a tighter read policy on
`game_players` (no prospect or free agent is readable directly), and the
functions `franchise_market`, `franchise_market_board`,
`franchise_scout`, `franchise_draft`, `franchise_sign` and
`franchise_release` (the generator and the window opener are internal).
Safe to re-run over any earlier installation. Report rows 1–19 should
each say `ok`. Tested against a real PostgreSQL by
`tools/games/franchise_sql.test.js`. See `games/README.md`.

Two trusted functions, `game_board_upsert` and `franchise_settle_pick5`, are
granted to no client role; `games/publish_board.js` calls them from the
existing games workflows with `SB_SERVICE_ROLE` / `SB_URL`. No new secret is
needed.

---

## Not in this repository

`public_record.sql` is referenced by the app and by capture's comments but has
never been committed here, so the definitions of `result` and `beat_close` are
still written by code no checkout can review. Worth fixing the same way `close`
and `learn` now are.

---

### `functions/close/index.ts` — the closing line and CLV
Transcribed from the Supabase dashboard, where it had lived unreviewed since it
was written. **Diff this against the deployed function before treating it as
authoritative** — it was pasted in, not exported, and a transcription error here
would be indistinguishable from a real difference.

It carries its own copy of `devig`, `priceEvent` and `sigKey`, because the
dashboard bundles only one folder and a `../_shared` import fails the bundle
silently. Those copies had drifted from capture v9 in four ways, all fixed in
`close-v7-parity` and all pinned by `tools/capture/pricer_parity.test.js`; the
audit is in `tools/capture/pricer_parity.md`.

Run `close_v7_parity.sql` **before** deploying it. close degrades safely without
it — the new columns are probed and omitted — but until it runs there is no way
to tell a Pinnacle-anchored close from a consensus one, or a v7 row from a
pre-parity row.

### `functions/learn/index.ts` — patterns and calibration
Pre-registered hypotheses, chronological holdout, Benjamini-Hochberg across the
family, an effect floor, and expiry for patterns that stop holding. It learns on
CLV rather than win/loss, which means everything it concludes inherits whatever
`close` wrote. Same transcription caveat.
