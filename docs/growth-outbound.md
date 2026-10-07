# Growth console: outbound engine

This is the owner-only outbound prospecting system that lives inside `/admin/growth/`. It is built in phases. Each phase records what changed, how it was verified, how to deploy it and how to roll it back.

**The rule the whole system is built around:** software may find, research, score, verify, draft and queue. It may never approve or send. Sending requires an explicit owner action, and the server enforces that, not the page.

---

## Phase 1: the console's sign-in (shipped)

### What was wrong

`/admin/growth/` stored the whole `/auth/v1/token` answer in `localStorage` and sent its `access_token` on every later visit. It never refreshed the token. Supabase access tokens live about an hour. On any visit after that:

1. the page sent the expired JWT, and PostgREST answered `401 {"code":"PGRST303","message":"JWT expired"}`;
2. `boot()` caught every failure the same way and printed *"This account cannot open the growth console: an operator must add it to public.affiliate_admins, and supabase/growth.sql must be installed. (401: {…raw JSON…})"*.

That message was an authorization verdict for what was only a stale login. Authorization itself was never broken: `affiliate_admins` has RLS on, no policies, and no client privileges.

`tools/growth/admin_growth_login.e2e.js` reproduces that exact message against the old page.

### What changed

| File | Change |
|---|---|
| `lib/edgedesk_admin_session.js` (new) | The operator consoles' session, ported from `app.html`'s proven `edRefreshSession`/`edToken` logic. It refreshes before expiry; on a 401 it refreshes **once** and retries **once**; it uses a single-flight refresh (refresh tokens rotate and are single-use); it adopts another tab's rotation; a refused refresh drops the session; a 5xx or network failure keeps it. It never falls back to the anon key and never logs. Errors come back as sentences with any token redacted, and it stores only `{access_token, refresh_token, expires_at, user:{id,email}}`. |
| `admin/growth/index.html` | Uses that module. The operator check (`growth_is_admin`) now runs **first and alone**, so the page gives distinct answers: *signed out*, *not an operator*, *not installed*, *unreachable* or *in*. Non-operators never trigger a data RPC. The page also gains a sign-out button, an "use another account" switch, Enter-to-submit, a cleared password field and per-section error reporting (one failing read no longer blanks the page). It no longer decodes the JWT to show the email. |
| `tools/growth/*` | Tests (below). |
| `package.json`, `.github/workflows/personal-tests.yml` | `growth:test`, `growth:sql`, `growth:e2e`. CI runs the first two. |

Nothing server-side changed. No SQL migration ships in Phase 1.

### Verification

| Suite | What it proves | Result |
|---|---|---|
| `npm run growth:test` | 83 checks: proactive refresh; one refresh and one retry on 401; a second 401 ends the session; refused refresh gives clean sign-out; transient failure keeps the session; 5 concurrent loaders share one refresh; cross-tab rotation; anon makes zero requests; 403/42501 → not operator, PGRST202 → not installed; sign-in/out; no token in any message or console output. Mutation-checked: removing single-flight, proactive refresh, drop-on-refusal or the retry bound each fails the suite. | PASS |
| `npm run growth:sql` | 34 checks on real PostgreSQL. Anon, a paying subscriber and an affiliate partner cannot call `growth_is_admin`, cannot read or write `affiliate_admins`, and cannot open any growth admin RPC. The owner can. No policy or client privilege exists on the list, and no client-executable function writes it (a planted backdoor proves the scan works). Removal takes effect on the next call. | PASS |
| `npm run growth:e2e` | 42 checks in Chromium against the shipped page with Supabase mocked: an hour-old session opens straight into the console; a refused refresh gives "sign in again" in words; a wrong password and a fresh sign-in behave correctly; a non-operator is refused; "not installed" is distinct; a mid-session 401 recovers; sign-out clears and revokes; no token reaches the DOM or console; the page fits at 390 px. | PASS |

### Owner bootstrap (run in the Supabase SQL editor, never from a page)

The operator list is `public.affiliate_admins`, shared by the partner, growth and billing consoles. `affiliates.sql` seeds the owner account `e7e46801-80c4-4f47-b718-4aff211c8d3a` (`app.html` `PG_OWNER_ID`) if that user exists. Nothing a client can call writes this table.

Before using the steps below, run the "Verification SQL" first. If `owner_listed` is `true`, nothing is needed.

Replace `you@example.com` with your sign-in address, typed plainly with no `< >` around it.

```sql
-- Add the owner explicitly, by the email you sign in with:
insert into public.affiliate_admins (user_id)
select id from auth.users where lower(email) = lower('you@example.com')
on conflict (user_id) do nothing;
```

### Verification SQL

```sql
select
  exists (select 1 from public.affiliate_admins a join auth.users u on u.id = a.user_id
          where lower(u.email) = lower('you@example.com'))                     as owner_listed,
  (select count(*) from public.affiliate_admins)                                    as operators_total,
  to_regprocedure('public.growth_is_admin()') is not null                           as growth_sql_installed,
  (select relrowsecurity from pg_class where oid = 'public.affiliate_admins'::regclass) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'affiliate_admins') as policies_should_be_0,
  has_table_privilege('authenticated', 'public.affiliate_admins', 'insert')        as clients_can_insert_should_be_false,
  has_function_privilege('anon', 'public.growth_is_admin()', 'execute')            as anon_can_ask_should_be_false;
```

`operators_total` is every account that can open the partner, growth and billing consoles. If it is more than you expect, review the list before Phase 2. Phase 2 adds a narrower owner-only gate for prospect data.

### Deploy

The site is static (GitHub Pages). Merging deploys `admin/growth/index.html` and `lib/edgedesk_admin_session.js`; the script tags carry `?v=20261005a`. No Supabase change is needed.

After deploying, open `/admin/growth/`. If a stale session is stored, the console should open without asking you to sign in, or ask cleanly if the refresh token was revoked.

### Rollback

Revert the merge commit. The old page reads the same `localStorage` key and shape (the new module stores a subset of the same fields), so no cleanup is needed in either direction.

### Known, out of scope here

- `/admin/billing/`, `/admin/affiliates/` and the other operator pages have the same no-refresh pattern. Adopting `lib/edgedesk_admin_session.js` there is a mechanical follow-up.
- `supabase/newsletter.sql` `newsletter_suppress(...)` was executable by `anon`, so anyone with the public anon key could permanently suppress any address. It was fixed in [dsrackler17/EdgeDeskSports#514](https://github.com/dsrackler17/EdgeDeskSports/pull/514) and [dsrackler17/EdgeDeskSports#515](https://github.com/dsrackler17/EdgeDeskSports/pull/515), and [dsrackler17/EdgeDeskSports#516](https://github.com/dsrackler17/EdgeDeskSports/pull/516) restores the service-role grants their merge dropped. Tested by `tools/newsletter/newsletter_sql.test.js` and `tools/newsletter/newsletter_suppress_sql.test.js`. The fix takes effect once `supabase/newsletter.sql` is re-run in the Supabase SQL editor.

---

## Phase 2: the owner-only authorization layer and the outbound data model

### The hierarchy

**normal user < affiliate_admin < outbound owner**

- **The list.** `growth_outbound.owners` is its own explicit list. Every owner must also be in `public.affiliate_admins`: a foreign key enforces it, and removing someone there cascades their owner row away. Being an affiliate admin grants **nothing** outbound.
- **Re-adding restores nothing.** Re-adding someone to `affiliate_admins` does not give back outbound access. It has to be granted again.
- **The existing consoles are untouched.** `affiliate_admins`, `affiliate_is_admin()` and `growth_is_admin()` are not modified, and the partner, growth and billing consoles behave exactly as before.
- **In the console**, an affiliate admin who is not an owner sees the existing Growth tab only. The page asks `growth_outbound_is_owner()` once and makes no other outbound call for them.

### Five layers, each enough on its own (`supabase/growth_outbound.sql`)

| # | Layer | What it stops |
|---|---|---|
| 1 | Every table is in the schema `growth_outbound`, which is **not** in PostgREST's `db-schemas` list | any REST path to a row, even with a stray grant |
| 2 | `anon`, `authenticated`, `service_role` and PUBLIC have no USAGE on the schema and no privilege on any table, sequence or helper | direct SQL access by any client role |
| 3 | RLS on every table, plus a **restrictive** deny-all policy for `anon`/`authenticated` | a mistaken grant combined with a mistaken permissive policy (tested: still zero rows) |
| 4 | The only way in is a `public.growth_outbound_*` door: security definer, pinned `search_path`, and **first statement `growth_outbound.require_owner()`** | subscribers, partners, affiliate admins and the service role (no `auth.uid()`), refused before anything else runs |
| 5 | Triggers on the tables themselves | see the next table |

The layer-5 invariants hold however a row is written, superuser included:

| Invariant | |
|---|---|
| No self-enrollment | An owner row cannot be written by anything that arrived through the API (JWT claims, an API role, or `session_user = authenticator`), even through a security-definer function added later |
| Approval is the owner's alone | A draft becomes `approved` only inside the approve door, by the signed-in owner, for its current content hash and recipient. It is never inserted approved. |
| An approval cannot be stale | An approved draft cannot change. Editing it puts it back in review and clears the approval. |
| A send needs an approval | A row in `sends` must be for an approved, unchanged draft; approved by **and** claimed by a current owner; to the approved recipient; not suppressed; and only while the compliance configuration is complete. |
| Test mode | While test mode is on, or for a test prospect, a send may go **only** to the owner's test inbox, marked test. |
| Never twice | Once per draft; once per address per step, across duplicate prospect rows; under the daily cap (an advisory lock serializes concurrent claims). |
| History | Suppressions, the activity log and the owner audit are append-only. Prospects, evidence, drafts and sends are never deleted. Evidence is never rewritten; it is only marked superseded, once. |

### The data model (Phase 2 creates it; later phases fill it)

| Table | Holds |
|---|---|
| `owners`, `owner_audit` | who may see any of this; every grant and revoke, with the database login that made it |
| `settings` | one row, no secrets. **Defaults:** test mode **on**, automation **off**, daily cap **20** (hard ceiling 200), test-send cap 25, gates fit ≥ 80 / identity ≥ 0.90 / research ≥ 0.85 / email ≥ 0.90, follow-up 1 after 5 days, final follow-up **off**, sender `Davis <davis@edgedesksports.com>`. **Constraints:** the sender and reply-to must be `@edgedesksports.com`, and the call to action must be an edgedesksports.com URL. |
| `prospects` | identity, profiles, email with its source and status, type, focus, fit score and its factors, five confidences, summary, angle, warnings, status, an opaque attribution token, `is_test` |
| `evidence` | one observation per row: field, claim, source URL/title/excerpt, published and observed times, confidence; superseded, never rewritten |
| `drafts` | subject, text, HTML, greeting name, claims linked to evidence, content hash, status, owner edits, the approval (who, when, hash, recipient), the rejection |
| `sends` | what was sent, to whom, from what; idempotency key; Resend message id; delivery state |
| `suppressions` | an address or a whole domain, with kind and source; permanent |
| `activity` | every owner and system action, with its actor |

**Sending is blocked** until the postal address, the opt-out endpoint (Phase 6) and, in test mode, the test inbox are configured. `growth_outbound.send_blockers()` lists what is missing, and the console shows it in words.

### The owner doors (Phase 2)

- **Reads:** `growth_outbound_is_owner()`, `_overview()`, `_settings()`, `_prospects(status, search, limit, offset)`, `_prospect(id)`, `_suppressions(limit)`, `_activity(limit, prospect)`.
- **Writes:**
  - `_settings_update(p)`: known keys only; raising the cap needs `confirm_cap_increase` and leaving test mode needs `confirm_live`; every change is audited with its before and after.
  - `_prospect_set_status(id, needs_research | rejected, reason)`: also cancels live drafts.
  - `_suppress(target, kind, reason, scope)`
  - `_draft_approve(id, content_hash)`: re-checks every gate server-side, and **sends nothing**.
  - `_draft_reject(id, reason)`
  - `_draft_edit(id, subject, body, expected_hash)`

**There is no send path yet** (Phase 5).

### Edge Functions re-check the owner server-side

`tools/growth/outbound_auth.js` (`requireOutboundOwner`) is the check every privileged outbound Edge Function will run first. Phase 5 copies it in byte-for-byte. It works in three steps:

1. **Verify the token.** GoTrue `/auth/v1/user` must accept it. A missing or malformed token, or the anon key, gets a 401. If GoTrue is unreachable, it returns 503.
2. **Ask as the caller.** It then asks `growth_outbound_is_owner()` **as the caller**, and the answer must be exactly `true`; anything else is a 403.
3. **Every later door is also called as the caller**, so the database checks the owner again on each action.

It needs only the anon key. No service-role secret takes part in deciding who the caller is.

### Owner bootstrap (after the migration has run)

In the Supabase SQL editor, with your sign-in address typed plainly (**no `< >`**):

```sql
select growth_outbound.grant_owner('you@example.com');
```

It answers `ok — … is now an outbound owner`. Otherwise it says exactly why not:

- the address still has its `< >`;
- no account uses it;
- the email isn't confirmed;
- the account isn't an affiliate admin.

No client role can execute it, and the owners trigger refuses it through the API anyway.

To check the prerequisite first (read-only):

```sql
select u.id, u.email, u.email_confirmed_at is not null as email_confirmed,
       exists (select 1 from public.affiliate_admins a where a.user_id = u.id) as is_affiliate_admin
from auth.users u where lower(u.email) = lower('you@example.com');
```

### Verification SQL

```sql
select
  (select string_agg(coalesce(u.email, o.user_id::text), ', ') from growth_outbound.owners o
     left join auth.users u on u.id = o.user_id)                                        as outbound_owners,
  has_schema_privilege('authenticated', 'growth_outbound', 'usage')                     as clients_can_use_schema_should_be_false,
  has_function_privilege('anon', 'public.growth_outbound_overview()', 'execute')        as anon_can_call_doors_should_be_false,
  (select test_mode from growth_outbound.settings)                                      as test_mode,
  (select max_sends_per_day from growth_outbound.settings)                              as daily_cap,
  growth_outbound.send_blockers()                                                       as send_blockers;
```

The migration's own report (rows 1–14) covers the rest; every row should say `ok`.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_sql.test.js` (`npm run growth:sql`) | 194 | Run on real PostgreSQL with Supabase's default grants. **Catalogue-driven:** every table and every door, for anon, a subscriber, a partner, a non-owner affiliate admin, a stranger and the service role; doors added later are covered automatically. Also: each layer alone; no self-enrollment (planted backdoor refused, with a positive control); the bootstrap's refusals; the hierarchy (cascade, audit, no silent restore, existing growth console intact); owner reads with emails; validated, audited settings and the confirmation flags; the approval invariants (even against the superuser); suppression; every send invariant; append-only history. **Mutation-checked:** removing a door's owner check, making the deny policy permissive, removing the API-origin refusal, skipping the approve-door check or dropping the daily cap each fails the suite. |
| `tools/growth/outbound_auth.test.js` (`npm run growth:test`) | 37 | the Edge Function owner check: every 401/403/503 path, a strict `true`, the user id taken from GoTrue rather than the body, asked as the caller, and 35 failure combinations of which only one passes |
| `tools/growth/outbound_console.e2e.js` (`npm run growth:e2e`) | 33 | Chromium. **Owner:** the tab, TEST MODE in the header and on the tab, blockers in words, "sent automatically 0", emails shown, the cap increase (declined sends nothing; accepted sends the flag), going live must be typed, suppression asks first. **Non-owner admin:** no tab, and the owner question is the only outbound call. Also: demoted mid-session, sign-out, 390 px. |
| Phase 1 suites | 83 + 34 + 42 | unchanged and passing; the e2e now also asserts a non-owner admin is shown no outbound UI |

### Deploy order

1. Re-run `supabase/newsletter.sql` in the SQL editor if you haven't since [dsrackler17/EdgeDeskSports#516](https://github.com/dsrackler17/EdgeDeskSports/pull/516) merged. The newsletter fixes (#514, #515, #516) are all on `main`; report rows 10.5, 17.5 and 17.6 should say `ok`.
2. Merge the Phase 2 PR. The static page deploys with it. Until step 3 the Outbound tab simply doesn't appear, because `growth_outbound_is_owner` doesn't exist yet and the page treats that as "not an owner".
3. In the SQL editor, run `supabase/growth_outbound.sql`. It needs `affiliates.sql` and `growth.sql`, which are already installed. Every report row should say `ok`; row 10 reads "none yet".
4. In the SQL editor, run `select growth_outbound.grant_owner('you@example.com');`.
5. Open `/admin/growth/` → **Outbound**. Set your **test inbox** and **postal address** in Settings. Sending stays blocked on the opt-out endpoint until Phase 6, by design.

### Rollback

- **The page:** revert the merge commit. The Growth tab is unchanged.
- **The database:** everything is additive and self-contained. To remove it entirely (this deletes all outbound data, which is none in Phase 2):

```sql
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like 'growth\_outbound\_%' loop
    execute 'drop function ' || f;
  end loop;
end $$;
drop schema growth_outbound cascade;
notify pgrst, 'reload schema';
```

`affiliate_admins` and every existing console are unaffected either way.

## Phase 3: who a prospect is, what is known, and how sure

**The rule:** a fact about a person is stored only as **evidence**, meaning a claim, the page it came from, what kind of source that page is, and the words on it. **Every number the gates read is computed from that evidence by the database.** This covers identity, role, email, research and fit, plus the displayed name, organization, title, email status and research status. Nothing typed, scraped or generated is taken as certain. Uncertain information cannot become confident because someone, or some model, repeated it.

### One person, one row (`growth_outbound.identifiers`)

| Key | Strength | Example | Effect |
|---|---|---|---|
| email | strong | `pat@cfbnumbers.test` | names **one** prospect, ever (a unique index) |
| handle | strong | `x:patanalyst`, `youtube:@patanalyst`, `substack:pat`, `linkedin:in:pat`, `github:pat`, `apple_podcast:123…`, `spotify_show:…` | names one prospect |
| site | weak | `cfbnumbers.test` (registrable domain; the full host on multi-tenant hosts such as `pat.wordpress.com`) | colleagues share it: a *possible duplicate*, flagged |
| url | weak | a non-profile page | flagged |
| name_org | weak | `pat analyst\|cfb numbers` | flagged, **and** blocks a second live send of the same step |

**Canonical URLs.** Before any comparison, `canonical_url()`:
- forces https and lower-cases the host;
- drops userinfo, default ports, `www.`/`m.`/`mobile.`, fragments, trailing and doubled slashes, and every tracking parameter (`utm_*`, `fbclid`, `gclid`, `si`, `s`, `t`, `ref`, …);
- maps `twitter.com` → `x.com` and `youtu.be/<id>` → `youtube.com/watch?v=<id>`;
- sorts what remains.

Reserved platform paths (`x.com/home`, `instagram.com/p/…`, `github.com/features`) name nobody. Anything that is not an http(s) page is refused.

**Rediscovery** under any casing, or a tagged or mobile link, adds to the same row. Keys that point at two different prospects return `identity_conflict` and write nothing. A suppressed address, domain or prospect is **never re-added or re-researched**. A key attached to the wrong person is **released** (kept on the record, cleared from the row) so it can belong to someone else.

### Evidence comes in checkable (trigger `evidence_prepare`)

- **The fact:** the field must be one of the catalogue (name, organization, title, email, project, article, podcast, newsletter, model, topic, sport covered, audience size, fit signal).
- **The source** is a web page with a kind: their own site, their own profile, a publication, an interview, a directory, or the owner's own check.
- **Email-only kinds:**
  - a pattern guess can only support an email address;
  - a provider verification or lookup can only be recorded by a provider;
  - an owner verification only by the owner.
- **A page claim needs the words on the page** that say it, and nothing can be published in the future.
- **Never an employer from an email domain:** an organization claim that is a domain is refused. A name that is a handle or an address is refused.
- **The weight is the server's.** Whatever confidence a collector hands in is discarded, tracking parameters are stripped from the stored URL, and an evidence row is never rewritten. It is *superseded* once, with a reason, and stays on the record.

### How sure (`claim_stats`, `field_assessment`, `compute`)

| Source | Weight for a fact | Weight for an email |
|---|---|---|
| the owner's own check | 0.80 | 0.90 |
| their own site / their own profile | 0.70 / 0.70 | 0.90 / 0.85 |
| a publication | 0.55 | 0.70 |
| an interview | 0.40 | 0.50 |
| a directory | 0.25 | 0.40 |
| a verification provider / provider lookup / pattern guess | — | 0.85 / 0.50 / 0.10 |

- **Independent sources combine:** confidence = 1 − ∏(1 − weight), taking the best weight per **publisher**. The same site saying it on three pages is one source. Two independent first-party sources give 0.91, just over the identity bar of 0.90.
- **Rivals halve it.** A name, title, organization or audience figure with another current claim is halved, and the rival is shown.
- **Old facts weigh less:**
  - a role over a year old ×0.75, over two years ×0.5;
  - content over 18 months old ×0.7, marked old (never to be called "recent");
  - an audience figure over a year old ×0.6.
- **First name:** used only when identity clears its bar **and** the name plainly has one. No first name is guessed from a single word, an initial or a title.
- **Email status:**
  - `verified` only after the owner's own check or a verification provider;
  - `unverified` if published;
  - `risky` if only guessed;
  - `invalid` after a bounce (Phase 6).
- **Research confidence:** with a draft waiting, it is that draft's *weakest* cited claim. A claim citing nothing, superseded evidence or another prospect's evidence counts as 0. Before any draft, it is the best-supported fact there is to write from.
- **Fit** comes from a fixed catalogue (`fit_factor_catalog`, edited in the file, not from a page):
  - a positive reason counts only while it cites current, non-email evidence of the same prospect;
  - penalties count unproven;
  - the score is clamped to 0–100.

### Computed means computed (trigger `prospects_guard`)

- **No statement writes a computed column.** Not a door, not the research engine, not the superuser in the SQL editor.
- **Under the evaluate door** the row is recomputed from evidence inside the trigger, so a faked door yields only the true values.
- **Only `evaluate()`** declares a prospect qualified or ready for review.
- **Status follows the gates:**
  - `discovered` when nothing is known;
  - `needs_research` with every unmet gate named;
  - `qualified` when every gate clears;
  - `ready_for_review` once a step-1 draft is waiting.
- **The owner's decisions stand:** rejected, contacted, replied, converted, suppressed. "Needs more research" holds until something newer is found.
- **An approval the prospect no longer earns is withdrawn** (back to review, logged).
- **The approve door re-evaluates first**, so it always reads a fresh assessment. The send trigger also refuses a duplicate row, the same person under another address, and a prospect that is no longer ready.

### New owner doors

- `growth_outbound_prospect_upsert(p)`: add or find a prospect, with evidence and fit reasons, all or nothing.
- `growth_outbound_evidence_add(prospect, p)`
- `growth_outbound_evidence_supersede(evidence_id, reason)`
- `growth_outbound_identifier_release(identifier_id, reason)`
- `growth_outbound_prospect_evaluate(id)`
- `growth_outbound_identity_lookup(text)`: "have we seen this email or URL?"
- `growth_outbound_fit_catalog()`

`growth_outbound_prospect(id)` now also returns the assessment, every observation (current and superseded, with its present confidence), the identifiers and related prospects. Every door starts with the owner check. The Phase 2 suite's catalogue loop refuses all seven new doors to anon, the service role, a subscriber, a partner, a non-owner affiliate admin and a stranger, with no new test needed.

### The console

The Outbound tab can now **open a prospect** to show:
- each number beside its bar;
- the gates still unmet;
- every fact with its sources, why it is not more certain, and its rivals;
- warnings in words;
- the evidence history ("previously … superseded: why");
- the fit reasons and what they rest on;
- the identifiers, and the drafts.

**The owner can:**
- add evidence;
- supersede an observation;
- add or remove a fit reason;
- release an identifier ("not theirs");
- re-evaluate;
- send the prospect back for research, or reject it.

**Have we seen them?** looks up an email or URL before anyone researches it, and **Add a prospect** takes an email, profile URLs and a first fact.

Everything shown came from the open web, so all of it is escaped and only an `https:` source becomes a link (`noopener noreferrer nofollow`). The page computes nothing.

### What Phase 3 does not do (and what each later piece needs)

- **No automatic discovery or research yet.** Phase 7 adds a provider interface; it needs a search API (for example Brave Search, Bing Web Search or SerpAPI) and an LLM key for extraction, kept as Edge Function secrets. Nothing is faked in the meantime: the table holds only what the owner enters.
- **No email verification provider yet.** Until one is connected (for example ZeroBounce, NeverBounce or Kickbox), an email is `verified` only by the owner's own check, recorded as `owner_verified` evidence.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_research_sql.test.js` (`npm run growth:sql`) | 162 | **Canonical URLs:** 20 cases. **Identity keys:** 17 URLs. **Dedupe:** rediscovery, `identity_conflict` writing nothing, suppressed people staying out, weak keys flagged and never merged, release. **Evidence rules:** 17 refusals, including the employer-from-email-domain rule, forged attestations and a collector's confidence; all or nothing. **The confidence arithmetic:** repetition, independence, rivals, stale roles, old content. **Computed columns** refused even to the superuser, and a faked door. **Names, fit, the status machine, approval withdrawal, the fresh approve, one person one step, lookup.** **Mutation-checked:** 18 deliberate breaks, every one caught. |
| `tools/growth/outbound_sql.test.js` | 239 | the Phase 2 suite. Its prospects are now built from evidence and evaluated (the old direct writes are refused). The duplicate row is refused at approval, and its send is refused even when an approval is forced past the door. |
| `tools/growth/outbound_console.e2e.js` (`npm run growth:e2e`) | 73 | adds the prospect panel, injected markup shown as text, no `javascript:` link, supersede, add evidence, fit reasons, release, status, lookup and add prospect. A non-owner forcing `EDOutbound.open()` still gets nothing. An unassessed prospect is never shown as clearing the gates, and the page still opens a prospect before the Phase 3 SQL is applied; 390 px with a prospect open. |

### Deploy

1. Merge the Phase 3 PR. The page works against the Phase 2 schema until step 2: opening a prospect shows what Phase 2 stored, and adding one says the door is missing.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. It is idempotent and additive, and it re-evaluates every existing prospect under the new rules. Report rows 1–18 should say `ok`; row 18 lists prospects by status.

### Rollback

- **The page:** revert the merge commit.
- **The database:** drop the two Phase 3 triggers and the seven new doors, then re-run the Phase 2 version of the file (`git show 3cd88938:supabase/growth_outbound.sql`). That restores the Phase 2 versions of the replaced functions. The new tables and columns stay; they are harmless and hold no client privilege.

```sql
drop trigger if exists prospects_guard_t on growth_outbound.prospects;
drop trigger if exists evidence_prepare_t on growth_outbound.evidence;
drop function if exists public.growth_outbound_prospect_upsert(jsonb), public.growth_outbound_evidence_add(uuid, jsonb),
  public.growth_outbound_evidence_supersede(bigint, text), public.growth_outbound_identifier_release(bigint, text),
  public.growth_outbound_prospect_evaluate(uuid), public.growth_outbound_identity_lookup(text), public.growth_outbound_fit_catalog();
notify pgrst, 'reload schema';
```

## Next

- **Phase 4:** the review queue (cards, batch approve with an explicit count confirmation, a test-prospect fixture).
- **Phase 5:** the claim door and the `growth-send-approved` Edge Function, built on `requireOutboundOwner`.
- **Phase 6:** the Resend webhook, the opt-out endpoint, bounces and complaints into suppressions.
- **Phase 7:** discovery and research providers (interface first; nothing faked).
