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
| `tools/growth/outbound_sql.test.js` | 239 (at Phase 3) | the Phase 2 suite. Its prospects are now built from evidence and evaluated (the old direct writes are refused). The duplicate row is refused at approval, and its send is refused even when an approval is forced past the door. |
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

## Phase 4: the review queue

**Software may draft and queue; only the owner approves, and approving sends nothing.** The Outbound tab now opens on a **Review queue** where every draft waiting for the owner is a card.

### A card

- **The message exactly as it would be sent** (`growth_outbound.compose()`): sender, recipient, subject, the words, and the footer. The footer carries the sender, the business name, the postal address, and a "reply stop / opt out" line; the personal opt-out link itself is made at send time (Phase 5/6). In test mode, and always for a test prospect, the recipient is the test inbox, and the card names the real address it is *not* going to.
- **Who it is for and how sure:** the prospect's status, fit and gates, from an assessment re-evaluated as the queue is opened.
- **What it says about them, and why we believe it:** each claim the draft cites, with the evidence it rests on (field, kind of source, link, the words on the page, its current confidence). A claim citing nothing, superseded evidence or another person's evidence is marked.
- **Why it cannot be approved yet,** in words: unmet gates, a cited claim no longer in the email's words, broken content rules.

### The content rules (`growth_outbound.draft_lint()`, enforced at approval, for every draft, test or not)

| Rule | Refused, for example |
|---|---|
| no promised winnings, locks or guarantees | "a lock", "guaranteed", "can't lose", "risk-free", "winnings" |
| one price | any dollar amount other than $49.99 |
| one trial | any trial other than 7 days (or "one week") |
| EdgeDesk links only | any link not on edgedesksports.com |
| nothing unfilled | `{{…}}`, `[First Name]`, "lorem ipsum" |
| no fake reply | a subject starting "RE:" or "Fwd:" |

The rules err strict on purpose: "we never promise winnings" is refused too. Say what EdgeDesk does instead.

**A cited claim must be in the email, in its words** (any casing or punctuation). An edit that drops it cannot be approved until it says it again.

### Approving

- **One:** the console asks first, saying that approving sends nothing and whether it is a test. It sends the content hash on screen, so a draft changed in the meantime is refused.
- **Several** (`growth_outbound_drafts_approve_batch(items, confirm_count)`): the owner selects drafts and **types how many**. The database approves exactly that count or nothing:
  - the typed count must equal the selection;
  - 1 to 25 drafts, each once;
  - **all or nothing:** if any one cannot be approved (a gate, a content rule, a changed draft), none is, and every reason comes back.
- **One implementation:** both doors call `growth_outbound.approve_one()`, which re-evaluates the prospect and checks every gate. No client can call it, and it refuses any session that is not the signed-in owner, the superuser's included.
- **Withdraw** (`growth_outbound_draft_unapprove`): an approved draft goes back to review before it is sent.

### Writing a draft (`growth_outbound_draft_create`)

The owner can write a draft from a prospect's panel. Each thing it says about them is a claim that:
- cites **current evidence of that prospect** (never an email address, never superseded, never someone else's);
- appears in the email's words.

A real prospect's draft makes at least one claim. The content rules apply at once. There is one live draft per step. The draft then waits in the queue like any other.

### A test draft for your own inbox (`growth_outbound_test_fixture`)

One button makes (once) a **test prospect at the owner's test inbox**, with owner-verified evidence and a draft that keeps the content rules, so the whole path can be tried without touching a real person. Without a test inbox it says to set one.

### New owner doors

- `growth_outbound_review_queue(status, limit)`: pending or approved, with fresh assessments.
- `growth_outbound_drafts_approve_batch(items, confirm_count)`
- `growth_outbound_draft_unapprove(id, reason)`
- `growth_outbound_draft_create(prospect, p)`
- `growth_outbound_test_fixture()`

`growth_outbound_draft_approve` now calls the shared `approve_one()`, and adds the content rules and the words check to its gates. The Phase 2 catalogue loop refuses all five new doors to every non-owner role automatically.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_review_sql.test.js` (`npm run growth:sql`) | 85 | the cards (claims with evidence, preview, fresh gates); 14 refused and 3 clean content cases; approval refused for broken rules and for a dropped claim; every way to write a bad draft; the batch's count, size, uniqueness and all-or-nothing behaviour, with nothing logged from a refused batch; withdraw; the fixture (idempotent, test-only, approvable); the preview in test and live mode; the private approve implementation. **Mutation-checked:** 16 deliberate breaks, every one caught. |
| `tools/growth/outbound_sql.test.js` | 269 | the Phase 2 suite; its catalogue loop now covers the new doors |
| `tools/growth/outbound_research_sql.test.js` | 162 | unchanged and passing |
| `tools/growth/outbound_console.e2e.js` (`npm run growth:e2e`) | 110 | adds the queue: the card as sent, text from the web shown as text, a blocked draft unselectable even when forced from the page, approve asking first, the typed batch count (a wrong number sends nothing), a refused batch, inline edit, reject, withdraw, the fixture, writing a draft, and the page before the Phase 4 SQL |

### Deploy

1. Merge the Phase 4 PR. Until step 2, the queue says which SQL to run.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. Report rows 1–20 should say `ok`; row 20 counts the queue.
3. In **Settings**, set the test inbox. Press **Test draft for my inbox**, then approve it from the queue. Nothing is sent: sending is Phase 5.

### Rollback

- **The page:** revert the merge commit.
- **The database:** drop the five new doors and re-run the Phase 3 version of the file (`git show 3d6d37fb:supabase/growth_outbound.sql`). That restores the Phase 3 approve door. The new index is harmless.

```sql
drop function if exists public.growth_outbound_review_queue(text, int), public.growth_outbound_drafts_approve_batch(jsonb, int),
  public.growth_outbound_draft_unapprove(uuid, text), public.growth_outbound_draft_create(uuid, jsonb), public.growth_outbound_test_fixture();
notify pgrst, 'reload schema';
```

## Phase 5: sending

**Only an approved draft, only when the owner presses Send.** Nothing sends on a schedule, on approval, or from a page alone.

### The path, for each draft

1. **The owner presses Send** (asked first, naming the inbox; several at once need the count typed). The page calls the **`growth_outbound_send`** Edge Function with the owner's own session.
2. **The function checks the owner itself** (`requireOutboundOwner`, copied verbatim from `tools/growth/outbound_auth.js`; a test fails on drift):
   - GoTrue must accept the token;
   - `growth_outbound_is_owner()`, asked **as the caller**, must answer exactly `true`;
   - otherwise 401/403/503, and nothing else happens.
3. **The database claims the send first** (`growth_outbound_send_claim`, as the caller):
   - it re-evaluates the prospect, so an approval no longer earned goes back to review, unsent;
   - it writes the send row, and the send trigger re-checks every rule: approved and unchanged, current owner, the approved recipient (only the test inbox in test mode or for a test prospect), unsuppressed, once per draft and once per address per step, a follow-up only to a contacted prospect, the daily cap, the compliance configuration;
   - it marks the draft sent;
   - it returns the message exactly as it must go out, with **one Idempotency-Key per draft** (`edgedesk-outbound-<draft id>`).
4. **Resend** gets that key and exactly that message: `Davis <davis@edgedesksports.com>`, one recipient, the approved words, then the footer (sender, business, postal address, this send's own opt-out link) and the RFC 8058 one-click `List-Unsubscribe` headers. The function first checks the message is one EdgeDesk email to one person (sender and reply-to on edgedesksports.com, no header injection, no extra headers).
5. **The answer is recorded** (`growth_outbound_send_result`, as the caller):

| Resend answers | The send becomes | What happens next |
|---|---|---|
| an id | `sent` | a real step-1 prospect becomes **contacted** |
| 400/422 | `failed`, with Resend's words | never retried |
| 5xx, 429, 409, timeout | still `claimed` | "Try again" reuses the same key, so it cannot send twice |
| 401/403 (the API key) | still `claimed` | the batch stops; nothing is marked failed |

**No second send, ever.** A draft claimed before returns the same key. A sent or failed one is never sent again. A claim whose outcome is still unknown after **23 hours** (Resend keeps idempotency keys for 24) is **abandoned**: it is marked failed and not retried. An email is never sent twice to find out whether it was sent once.

**The function holds no service-role key.** It has the project URL, the public anon key (to reach the API as the caller) and `RESEND_API_KEY`. Every database call is made with the owner's own token, so the database checks the owner again at every step. Nothing it returns contains a key or a token.

### Test sends before the opt-out endpoint

- **A test send** (only ever to the owner's own test inbox) needs the postal address and the test inbox.
- **A live send** also needs the opt-out endpoint (Phase 6). Until then the footer of a test send says where the link will be, and the `List-Unsubscribe` header offers reply-to-stop only.
- The console shows both lists: what blocks the next send in the current mode, and, in test mode, what live sending still needs.

### New doors

- `growth_outbound_send_claim(draft)`
- `growth_outbound_send_result(send, resend_id, error, permanent)`
- `growth_outbound_sends(limit)`

`settings` now also returns `test_send_blockers` and `live_send_blockers`. Report rows 21–22 cover live blockers and the sends.

### The console

- Approved cards have **Send test** / **Send now**, both asked first.
- **Send all shown** needs the count typed.
- The **Sends** table lists every send: TEST/LIVE, recipient (and whom a test was for), status, the reason, tries, and **Try again** only for one still waiting for an answer.
- A function not yet deployed, or a missing Resend key, is said in words.

### Deploy

1. Merge the Phase 5 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. Report rows 1–22 should say `ok`.
3. **Deploy the function**, either way:
   - GitHub → Actions → **Deploy outbound send function** → Run. It runs the function's tests first and uses the `SUPABASE_ACCESS_TOKEN` / `SUPABASE_PROJECT_REF` secrets the other deploy workflows already use.
   - Or from a terminal: `supabase functions deploy growth_outbound_send --no-verify-jwt`. JWT verification is off because the function verifies the owner itself, and the browser's CORS preflight carries no token.
4. `RESEND_API_KEY` is already a Supabase secret (the newsletter uses it, and secrets are shared by every function). Resend must have `edgedesksports.com` verified as a sending domain; it does if the newsletter sends.
5. In **Settings**, set the postal address and your test inbox. Then: **Test draft for my inbox** → approve → **Approved, not sent** → **Send test**. Check your inbox; the Sends table shows `sent`.
6. **Live sending stays off** until the opt-out endpoint exists (Phase 6), you set its base URL, and you leave test mode (typed `LIVE`).

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_send.test.js` (`npm run growth:test`) | 48 | the **deployed** function, imported under Node's type stripping with a Deno shim and a mocked GoTrue/PostgREST/Resend. It covers: the verbatim owner check; CORS for EdgeDesk only; nothing claimed without a verified owner, a valid body and the Resend key; claim, then Resend with the claim's key and exactly its message, then record; refused, already-sent and retried claims; every Resend answer; eight malformed messages never sent; every database call as the caller, no service-role key. **Mutation-checked:** 9 deliberate breaks, every one caught. |
| `tools/growth/outbound_send_sql.test.js` (`npm run growth:sql`) | 46 | blockers for test and live; the claim (written first, the message, the footer, the token, the headers); retry with the same key; transient, permanent and stale outcomes; ids validated and never replaced; contacted; send-time re-evaluation; suppression; the follow-up path; the cap; the immutable record; owner only. **Mutation-checked:** 10 deliberate breaks, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 128 | adds the Sends table, Send (asked first), Send all (typed count), the function's refusals, Try again |
| earlier suites | 287 + 162 + 85 + 83 + 37 + 34 + 42 | all passing |

### Rollback

- **The function:** `supabase functions delete growth_outbound_send`. Without it nothing can be sent; the console says it is not deployed.
- **The page:** revert the merge commit.
- **The database:** additive. To stop all sending at once without touching code, keep test mode on, or clear the postal address: every send is then refused at the claim.

## Phase 6: what comes back (Resend's events, opt-outs, replies)

**A hard bounce, a spam complaint, an opt-out or "please stop" ends email to that address for good. Nothing from outside changes a send unless it proves where it came from.**

### Resend's events (`growth_outbound_webhook`)

1. Resend posts each event to the **`growth_outbound_webhook`** Edge Function (an endpoint of its own in Resend, with its own signing secret).
2. **The function holds no secret.** It passes the raw body, byte for byte, and the three Svix headers to `public.growth_outbound_webhook()` with the public anon key. Without the headers it answers 401 and asks the database nothing.
3. **The database checks the signature first**, before anything is read:
   - HMAC-SHA256 over `id.timestamp.body` with the secret in `growth_outbound.secrets`, any one of the `v1,` signatures matching (Svix sends several while a secret rotates);
   - the timestamp within five minutes either way (a captured delivery replayed later must not re-apply a bounce);
   - HMAC is written in SQL on core `sha256()` (no extension). Report row 25 checks it against RFC 4231's published vectors on every run.
4. A delivery that fails is a **401, and nothing is read or kept**. The reason goes to the function's log for you; the caller learns nothing.
5. **A repeat** of an event already seen (the same Svix id) is acknowledged and not applied twice.
6. Then:

| Resend says | The send | The address |
|---|---|---|
| `email.delivered` | delivered | — |
| `email.delivery_delayed` | delayed (never moves a delivered send back) | — |
| `email.bounced`, permanent (or of unknown kind: fail closed) | bounced, with the reason | **suppressed**, the prospect's address marked invalid, every unsent follow-up cancelled |
| `email.bounced`, transient (a full mailbox) | noted as a soft bounce | not suppressed |
| `email.complained` (marked as spam) | complained | **suppressed**, follow-ups cancelled |
| `email.opened` / `email.clicked` | first time noted (a hint only: opens are unreliable) | — |
| `email.failed` | failed | — |
| `email.suppressed` (Resend refused: the address is on its own suppression list) | failed, never sent | **suppressed** here too (fail closed), follow-ups cancelled |
| any event about a **test** send | recorded on the send | **never suppressed** (it went to your own inbox) |
| an event about an email this engine did not send (the newsletter) | — | acknowledged; only the event id is kept (for repeats), no address, no message id |

Nothing a later event says moves a send backwards: a "delivered" arriving after a bounce leaves it bounced.

**The newsletter's own webhook now ignores outbound email.** Resend sends every event on the account to every endpoint. The `newsletter` function acknowledges an event tagged `edgedesk=outbound` (every outbound email is) and keeps nothing about it, so a prospect's address never lands in the newsletter's tables. Its signature is still checked first.

### The signing secret

- Set once, in the Supabase **SQL editor**: `select growth_outbound.set_webhook_secret('whsec_...');`
- Refused through the API, by the function and by a trigger on the table, each alone; a later security-definer function written by mistake would be refused too.
- Never returned by any door. The console sees only whether it is set, how many events arrived in 24 hours, and when the last did.
- **Live sending is blocked until it is set** (`webhook_secret_missing`): a bounce or a complaint must be able to stop the next email.

### Opting out (`growth_outbound_optout`)

Every outbound email carries its own link, `…/functions/v1/growth_outbound_optout?t=<64 hex>`, in the footer and in the `List-Unsubscribe` header. The token belongs to that one send. Its only power is to stop email to that address.

- **POST** (the RFC 8058 one-click that Gmail, Yahoo and Apple Mail send from their own unsubscribe button): the address is suppressed for good and every unsent draft cancelled. No cookie, no session, no JavaScript.
- **GET** (a person following the footer link, or a mail scanner prefetching it) **changes nothing.** Supabase serves an Edge Function's HTML as plain text on GET, so the function 303-redirects to **`https://edgedesksports.com/email/stop/#t=…`**. The token rides in the fragment, which is never sent to a server or in a Referer. That page asks the door without confirming (a masked address, `p•••@domain`, and one button), and stops email only when the button is pressed. Inside another site's frame it shows no button.
- A malformed token and one no send carries get the same answer: "not valid".
- **A test send's link changes nothing**, confirmed or not.
- Twice is once: an address already stopped (by an opt-out, a bounce, a complaint) gets "done" and nothing new is written.

### Replies

Replies reach `davis@` and a person reads them. A contacted prospect's detail now offers:
- **They replied** (asks first, with an optional note): the prospect becomes `replied`, every follow-up still waiting is cancelled, the address is **not** suppressed;
- **They replied: stop emailing them**: the same, and the address is suppressed for good.

A follow-up written after a reply can never be sent (a follow-up goes only to a `contacted` prospect).

### Exactly two public doors

- `growth_outbound_webhook` and `growth_outbound_optout` are the only outbound doors `anon` may call. Signed-in users and the service role cannot call them at all.
- Each opens with its own proof instead of the owner check: Resend's signature; a send's token. Without it, the answer is a refusal and nothing is read, written or revealed.
- Every other door is unchanged: signed in, and an owner, or refused at the first statement.

### New in the database

- `public.growth_outbound_webhook(id, timestamp, signature, body)`: anon only.
- `public.growth_outbound_optout(token, confirm)`: anon only.
- `public.growth_outbound_prospect_replied(id, note, stop)`: owner.
- `public.growth_outbound_provider_events(limit)`: owner (what Resend reported, with whose send it was).
- `growth_outbound.set_webhook_secret(secret)`: the SQL editor only.
- Tables `provider_events` (append-only, one row per event id) and `secrets` (the webhook secret and nothing else).
- `sends.opened_at`, `sends.clicked_at`; the sends list returns them and `complained_at`.
- `settings` returns `webhook: {secret_set, last_event_at, events_24h}`.
- Report rows 23–26: the two public doors, the secret, the HMAC vectors, the events.

### The console

- The header says whether Resend's events can arrive ("signing secret not set", or how many in 24 hours and when the last came).
- In test mode, what live sending still needs now includes the webhook secret, with the line to run.
- The Sends table shows when a send was opened and clicked.
- A contacted prospect has **They replied** and **They replied: stop emailing them**.

### Deploy (in order)

1. Merge the Phase 6 PR. The site gets `/email/stop/` with it.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. Report rows 1–26 should say `ok` (row 24 says the secret is not set yet).
3. **Deploy the two new functions** (the send function is unchanged):
   - GitHub → Actions → **Deploy outbound Edge Functions** → Run. It runs the tests first and deploys all three.
   - Or from a terminal: `supabase functions deploy growth_outbound_webhook --no-verify-jwt` and `supabase functions deploy growth_outbound_optout --no-verify-jwt`.
4. **Redeploy the newsletter function** so it ignores outbound email: `supabase functions deploy newsletter --no-verify-jwt`.
5. In **Resend → Webhooks → Add endpoint**:
   - URL: `https://iattxbkbufslbauoumga.supabase.co/functions/v1/growth_outbound_webhook`
   - events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.failed`, `email.suppressed`.
   - Copy this endpoint's **signing secret** (`whsec_…`).
6. In the SQL editor: `select growth_outbound.set_webhook_secret('whsec_...');` (paste the secret between the quotes, without `< >`). Row 24 now says it is set.
7. In the console's **Settings**, set the opt-out base URL to `https://iattxbkbufslbauoumga.supabase.co/functions/v1/`.
8. **Check it with a test send:** Test draft for my inbox → approve → Send test. Within a minute the Sends table says `delivered` and the header counts an event. Open the email's opt-out link: the page says it was a test email and nothing changed.
9. **Live sending stays off** until you leave test mode (typed `LIVE`). Opens and clicks are reported only if open and click tracking is on for the domain in Resend; nothing depends on them.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_events_sql.test.js` (`npm run growth:sql`) | 124 | HMAC-SHA256 against RFC 4231 and Node's crypto at every key and message edge; the secret set from the SQL editor only (each layer alone), never echoed, malformed ones refused; a wrong secret, a tampered body, a lifted signature, stale and future timestamps, missing headers all refused with nothing kept; rotation; repeats applied once; every event type; hard vs soft vs unknown bounces; complaints; Resend's own suppression; test sends never suppress; nothing moves backwards; the newsletter's events leave no trace; opt-out (malformed, unknown, preview, confirm, twice, already bounced, test); replies (owner only, not contacted, stop); live blocked without the secret; exactly two anon doors; append-only events. **Mutation-checked:** 34 deliberate breaks, every one caught. |
| `tools/growth/outbound_events.test.js` (`npm run growth:test`) | 65 | the **deployed** webhook and opt-out functions and the newsletter's skip: only a POST with the headers reaches the database, the body byte for byte, as anon; 401 says nothing more; 503 when the door is missing or the database is down; 413 over 256 KB; no CORS; a GET only redirects (the token in the fragment); the one-click POST, from the URL or the form; a bad token never reaches the database; the newsletter keeps nothing about an outbound email (both tag shapes) and still handles its own. **Mutation-checked:** 13 deliberate breaks, every one caught. |
| `tools/growth/outbound_stop_page.e2e.js` (`npm run growth:e2e`) | 25 | `/email/stop/` in Chromium: asks without confirming, the token leaves the address bar, the button confirms, every refusal and failure in words, the door's words as text, no button inside a frame, a phone. **Mutation-checked:** 6 deliberate breaks, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 146 | adds the webhook status, the live blocker, opened/clicked, They replied / stop (asked first, declining sends nothing) |
| earlier suites | 317 + 162 + 85 + 47 + 48 + 83 + 37 + 34 + 42 | all passing (updated for the two public doors and the live-send secret) |

### Rollback

- **Stop believing Resend:** in the SQL editor, `delete from growth_outbound.secrets;`. Every event is then refused, and live sending is blocked again.
- **The functions:** `supabase functions delete growth_outbound_webhook` (Resend retries, then reports the endpoint failing; nothing changes in the database), `supabase functions delete growth_outbound_optout` (the links stop working, so also clear the opt-out base URL in Settings, which blocks live sending; "reply STOP" still reaches you).
- **The page and the newsletter change:** revert the merge commit, and redeploy the newsletter function.
- **The database:** additive. Suppressions and provider events are history and are not deleted.

### What Phase 6 does not do

- **Read replies automatically.** A person reads `davis@` and marks the reply. Reading the mailbox would need an inbound-mail provider (Resend inbound, or a mailbox API) and its credentials; it is not faked.
- **Attribute conversions** (a reply that becomes a trial or a subscriber): Phase 10.

## Phase 7: discovery and research

**The engine may find, read, extract and verify. It may not approve, draft or send, and it may not make anything up.** It runs only when the owner presses a button (the scheduled morning run is Phase 9).

### How a person is found

1. **Search** (Discover and research → Search, or Run saved searches). The `growth_outbound_research` Edge Function asks **Brave Search**. Each result becomes a **candidate**, not a prospect:
   - a page seen before is counted, not added again (tracking tags and `www.` don't fool it);
   - a page that names a known prospect (their profile or own site) is marked "already a prospect", linked to them;
   - a page on a domain that asked not to be contacted is marked suppressed and never read.
2. **Research** a candidate (or "Research the next one", or **Research again** on a prospect). The function reads up to four pages:
   - the candidate page;
   - the site's home page;
   - the about and contact pages it links to.
3. **Every page is stored as read** (`growth_outbound.pages`): its visible text, its links and its structured data, with a hash the database computes. Pages are never rewritten.
4. **Facts are quotes.** Claude reads the stored text and proposes facts (name, organization, role, project, audience, fit signals), each with a quote. The JSON-LD structured data on the page is read the same way. Then **every proposal is checked twice**:
   - in the function: the quote must be on the page (whole words, ignoring case and punctuation), and the claim must be inside the quote;
   - again by the database (`evidence_prepare`), which refuses the whole request if any item fails.

   What fails is **dropped and reported**, never "fixed". Only a fit signal may describe in other words what its quote shows; it is never a fact an email can cite.
5. **Own or not is the database's decision** (`engine_source_kind`). The engine cannot claim a page is the prospect's own site or profile.
   - **Their own profile:** the page's handle is one of the prospect's handles.
   - **Their own site:** the page is on the prospect's website, nobody else holds that site, and it is not a publisher.
   - **Anything else** counts as a publication, interview or directory.

   Built-in publishers include ESPN, The Athletic and Action Network; you can add more under `discovery_config.shared_sites`.
6. **Who they are.** Their own site, and only those profile links that appear on their pages (`rel="me"`, the structured data's `sameAs`, or Claude's pick from the page's links).
   - A URL or address that already names another prospect is left out, and said so. Two people are never merged.
   - Rediscovering someone adds to their row.
7. **Their business address:**
   - **Published on their own site:** never a role address such as noreply@, privacy@ or abuse@.
   - **Otherwise from Hunter:** a domain search, taking only an address Hunter lists **for that person's name** at that domain. It is recorded as Hunter's find, with the page where Hunter saw it.
   - Never a guessed pattern.
8. **Verified by a provider.** Hunter's email verifier is recorded as its own source:
   - **"valid"** verifies the address. With the other gates met, the prospect becomes **qualified**: ready for a draft.
   - **"invalid"** or **"disposable"** marks the address unusable.
   - **"accept all"** and **"unknown"** verify nothing.
9. **Fit reasons** come from the catalogue, and each positive one must cite a kept fact. The database scores them.

**The gates do the rest.** A prospect clears identity, research and email only with enough **independent** sources. One page, however many facts it gives, does not. An address on a web page is "unverified" until a verifier or you confirm it.

**What a quote does not prove.** A quote proves the words are on that page. It does not prove Claude read them right. A name quoted from a "thanks to …" line would pass the check. That is why one source never clears the gates, why conflicting sources lower confidence, and why every draft is reviewed by you before anything is sent.

### Politeness and safety

- **robots.txt is obeyed.**
  - A group naming `EdgeDeskBot` wins over `*`.
  - The longest rule wins, with Allow on a tie.
  - An unreachable robots.txt (5xx) keeps the engine out (RFC 9309).
- **The bot identifies itself** as `EdgeDeskBot/1.0 (+https://edgedesksports.com)`.
- **What it will fetch:**
  - https only, on the standard port, with no credentials in the URL;
  - no IP literals, no reserved names (`localhost`, `.local`, `.internal`, …) and no Supabase or cloud-metadata hosts;
  - no host that resolves to a private address, when the runtime can resolve DNS.
  - Every redirect hop is checked again.
  - Pages over 1.5 MB, and anything that is not a web page, are refused.
- **X, LinkedIn, Instagram, Facebook, TikTok and Threads** are not fetched (they refuse robots), but a profile link to them still identifies a person.
- **The daily budget is enforced by the database.** Each provider call is counted before it is made:
  - searches 20;
  - pages 150;
  - Claude reads 30;
  - email lookups 15;
  - verifications 30.

  You set each figure; the ceilings written in the SQL are 200 / 2,000 / 400 / 200 / 400. Once a figure is spent, nothing more is called that day.

### Claude

- Called through the official SDK (`npm:@anthropic-ai/sdk`, bundled at deploy), with model `claude-opus-5-5` (`OUTBOUND_RESEARCH_MODEL` to change it), effort `low`, and a JSON-schema output whose fit codes are exactly the catalogue's.
- **Server-side refusal fallback is on** (`fallbacks: "default"`): a policy decline is retried on the model Anthropic recommends. A final decline means nothing Claude said is used.
- The prompt treats page content as data, not instructions. A page that tries to steer it can only get words onto the record that are already on that page, and only as a quote.
- **Cost:** one call per research, roughly 10–15k input tokens. At Opus 5.5 prices ($4 / $20 per million tokens), a few cents per prospect.

### New in the database

- **Tables:**
  - `research_runs` (never deleted);
  - `pages` (append-only);
  - `candidates` (never deleted);
  - `provider_usage`;
  - `evidence.page_id`.
- **The checks:** `quote_in`, `engine_source_kind`, `is_shared_site`, `research_budget`, `discovery_config_problems`. A malformed discovery setting or a figure over the ceiling is refused in words.
- **Doors** (owner only, called by the function as the owner):
  - `research_overview`, `research_begin`, `research_spend`, `research_finish`;
  - `page_record`, `candidates_record`, `research_ingest`;
  - `candidates`, `candidate`, `candidate_set`.
- **Report rows 27–29:** the checks themselves, today's budget, the candidates.
- **Seeds:** the weak test seeds now record directory finds as the owner's, because evidence from the research engine must cite a stored page.

### The console

**Discover and research:**
- which providers are set up (named by their secret when not) and today's use of each;
- search and saved searches;
- the candidate queue (New, Researched, Not a fit, Failed, Already prospects, Dismissed) with Research, Dismiss (asks) and Put back;
- the saved searches and the daily budget;
- recent runs, with what each found, read, spent, and why one failed.

Each research answer says:
- how many facts were recorded and how many dropped (could not be quoted);
- the address and the verifier's word;
- the prospect's status.

A prospect also has **Research again**. If the function is not deployed, the page says so and still shows the queue.

### Deploy (in order)

1. Merge the Phase 7 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. Report rows 1–29 should say `ok`.
3. Add the provider keys under **Supabase → Edge Functions → Secrets**. Each is optional; without one, the console says that provider is not set up, and nothing is faked.
   - `BRAVE_SEARCH_API_KEY`: [Brave Search API](https://api.search.brave.com/) (a plan includes monthly free credit; the key goes in the `X-Subscription-Token` header).
   - `HUNTER_API_KEY`: [Hunter](https://hunter.io/api) (domain search and email verifier; a free tier exists).
   - `ANTHROPIC_API_KEY`: already set if the AI desk is configured (secrets are shared by every function).
4. **Deploy the function:** Actions → **Deploy outbound Edge Functions** (its tests need PostgreSQL, which the runner has), or `supabase functions deploy growth_outbound_research --no-verify-jwt`.
5. In the console: **Discover and research** → type a search → Search → **Research** a candidate → open the prospect.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_engine_sql.test.js` | 124 | the budget (cap, ceiling, malformed settings, finished runs); runs (three at once, stale ones failed, finished is final); pages (canonical, hashed here, never rewritten); candidates (rediscovery, duplicates, suppressed domains); **quotes** (not on the page, claim outside the quote, a cut word, an address or audience figure not in its quote, no page, the wrong page, owner-verified or a guess from the engine: each refused, all or nothing); **own** (decided by the database: their site, their profile, never a publisher, never a site or profile somebody else holds); identity (rediscovery adds, another's URL or address left out, no identifier, suppressed); a verifier's word; the gates; owner only, anon nothing. **Mutation-checked:** 31 deliberate breaks, every one caught. |
| `tools/growth/outbound_research.test.js` | 83 | the **deployed** function against the **real SQL** (a PostgREST stand-in runs every door in PostgreSQL). Brave, Hunter, Claude (the SDK, stubbed by a loader hook) and the web are mocked. It covers: owner only; provider status without keys; discovery; research with made-up facts dropped before the database; their own address, not noreply@; verification; not a fit; Claude declining; no Claude (structured data only); Hunter only for the named person; research again; a database refusal retried without the item; robots.txt; SSRF and redirect re-checks; size and type caps; the fetch budget; each key only to its provider. **Mutation-checked:** 26 deliberate breaks, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 171 | adds the Discover panel: providers and budget, searches, candidates (web text stays text, https links only), Research, next, Dismiss, Research again, saving searches and the budget, the function not deployed |
| `tools/growth/admin_session.test.js` | 85 | adds: a slow call (the research engine) may wait longer, call by call |
| earlier suites | all passing | (updated: seventeen tables) |

### Rollback

- **Stop all research at once:** set every daily figure to 0 (Discover and research → Save). Every provider call is then refused by the database.
- **The function:** `supabase functions delete growth_outbound_research`. The console says it is not deployed and still shows the queue.
- **The database:** additive. Pages, candidates and runs are history and are kept.

### What Phase 7 does not do

- **Run by itself.** The morning run (find, research, score, draft, queue — never approve or send) is Phase 9.
- **Write emails.** Drafting from verified evidence is Phase 8.
- **Read X, LinkedIn or Instagram.** They refuse robots; a profile link still identifies someone, and the owner can add evidence by hand.

## Phase 8: personalization (the drafting engine)

**The engine may draft. It may not approve or send, and it may not say anything about a person that the database cannot cite.** It runs only when the owner presses a button (the scheduled morning run is Phase 9). Every draft waits in the review queue for you.

### How a draft is written

1. **Who is due** (`growth_outbound.step_due_problem`, the same rule everywhere):
   - **first email:** the prospect is *qualified* (every gate clear, no draft waiting) and was never sent step 1;
   - **follow-up 1:** contacted, has not replied, opted out or bounced; step 1 went out `followup_delay_days` ago; follow-ups are on;
   - **final follow-up:** the same, `final_followup_delay_days` after follow-up 1, while the final follow-up is on;
   - **a test prospect:** a first email only.

   The **Write drafts** list puts follow-ups first, then the best fit. It leaves out a step whose draft you rejected in the last 14 days, and a step the engine gave up on in the last 7 days unless new evidence has arrived since. You can still ask for either by hand.
2. **What it may write from** (`growth_outbound_draft_context`):
   - the first name, **only if the evidence establishes it** (identity at the gate and a plain first-and-last name);
   - the facts it may cite: what they make, write, run or do (project, newsletter, podcast, model, article, topic, sports focus, organization, title). Each fact must be current and **sure enough by itself** to clear the research gate. Never their address, their name, an audience figure or a fit signal;
   - for a follow-up, what was already sent to them;
   - your reasons for rejecting the engine's recent drafts.

   Nothing else about the person is given to Claude.
3. **Claude writes** (official SDK, `claude-opus-5-5`, low effort, structured output, server-side refusal fallback). For each thing it says about them, it copies a phrase from that fact's own words and cites the fact's id.
4. **The database decides** (`growth_outbound_draft_propose`). An engine draft goes into the queue only if:
   - **every claim** cites current evidence about *this* person that may be cited, sure enough by itself (at the research gate), in that evidence's own words (its claim or its quote), and the email says it in those words. There is at least one;
   - **nothing specific comes from nowhere** (`uncited_details`): a figure, an all-capitals word, or a capitalised word inside a sentence (a name, a title, a brand, a place) must come from a cited claim, the first name, or EdgeDesk's own words. "Your 2024 Heisman model" is refused for "2024" and for "Heisman";
   - **a sentence about them carries a claim** (`uncited_sentences`): "your newsletter", uncited, is refused. Generic phrases such as "your work", "your research" and "your bets" are fine;
   - **the greeting** (`greeting_problem`) is "Hi <first name>," only for the established first name, letter for letter, and otherwise "Hi there,", alone on the first line. A name the evidence does not establish is a guess, and is refused;
   - **the content rules** hold (no promised winnings or locks, $49.99/month, a 7-day free trial, EdgeDesk links only);
   - **the step is due** now.

   A refusal lists every problem in words.
5. **One more try, then the template.** Claude gets the database's objections and one more try. If that is refused too, or Claude declines, fails, is not configured, or today's writing budget is spent, a plain **template** is used. It quotes the best fact in its own words, greets by first name or "Hi there,", and is checked by the same door.
6. **If nothing passes,** nothing is drafted. The reasons are returned and recorded (`draft_gave_up`, in Activity).

**What the checks do not prove.** They stop the common ways a model invents a personal detail: a name, a number, a brand, or a sentence about them that cites nothing. They cannot catch every lowercase claim. That is why every draft says **who wrote it**, and why nothing is sent until you approve it and press Send.

### At approval and at sending

- **An engine draft you have not edited** is approved only while its greeting still matches the first name as the evidence stands *now*. If research later shows "Hi Pat," should be "Hi Patricia,", it cannot be approved until you edit it. **Your own edits are your words** and are not held to this.
- **Follow-ups are sent only on the cadence**, whoever wrote them. The send trigger refuses a live follow-up:
  - while that follow-up is turned off;
  - before the step before it went out (and did not bounce, draw a complaint or fail);
  - before its delay has passed.

  The final follow-up's delay counts from follow-up 1.

### The console

**Review queue:**
- whether Claude writes, and today's use of the writing budget;
- who is due (first emails, follow-ups);
- how the engine's drafts fare over 90 days: written, approved as written, approved after your edit, rejected;
- **Write the next N drafts.**

**Each card** says who wrote it: the engine, its template, or you, and "edited by you". A greeting the evidence no longer supports is said, and that card cannot be approved. Rejecting an engine draft tells you the engine reads your reason.

**A prospect** has **Let the engine write it**, for the step you choose. A step that is not due is said in the database's words.

**Fixed along the way:** a follow-up for a contacted prospect could not be selected or approved on the page. The database always allowed it; the page now does too.

### New in the database

- `research_runs.kind` gains `draft`. A drafting run spends only on Claude, and the research doors refuse it.
- `drafts.run_id`: the run that wrote an engine draft.
- **The checks:** `engine_citeable`, `greeting_of`, `greeting_problem`, `detail_words`, `uncited_details`, `uncited_sentences`, `step_sent_at`, `step_due_problem`, `drafting_due`, `citeable_facts`, `engine_lessons`, `drafting_stats`.
- **Doors** (owner only):
  - `draft_context`, `draft_propose`, `draft_gave_up` (called by the function as the owner);
  - `drafting_overview`.
- **Changed:**
  - `approve_one`: the greeting gate for unedited engine drafts;
  - the send trigger: the follow-up cadence;
  - the review card: `greeting_problem`.
- **Report rows 30–31:** the checks themselves, and what is due and how the engine's drafts fare.

### Deploy (in order)

1. Merge the Phase 8 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql` again. Report rows 1–31 should say `ok`.
3. `ANTHROPIC_API_KEY` is already set if research uses Claude (secrets are shared by every function). Without it, every draft is the template. Optional: `OUTBOUND_DRAFT_MODEL`.
4. **Deploy the function:** Actions → **Deploy outbound Edge Functions**, or `supabase functions deploy growth_outbound_draft --no-verify-jwt`.
5. In the console: **Review queue → Write the next drafts**, or open a qualified prospect → **Let the engine write it**. Then review.

**Cost:** at most two short Claude calls per draft (a few thousand tokens each). They count against the same daily Claude figure as research ("Claude calls / day" under Discover and research), so that figure caps both.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_drafting_sql.test.js` | 139 | runs (a drafting run writes only, and research doors refuse it); **due** (first email, follow-up delay, turned off, after a reply, a first email that failed, a test prospect, the order, rejected and given-up steps leaving the list, new evidence bringing one back); the context (established first name or none; facts sure enough by themselves, one line per claim, never an address, name, fit signal or a single publication's fact); **claims** (someone else's evidence, an address, a fit signal, a name, below the gate, other words than the evidence's, not said in the email, superseded, none); **names** (a different name, wrong case, no greeting line, no established first name); **specifics** (a figure, a brand, a name, all-capitals, mid-sentence or not, the subject too, "your newsletter" uncited); the content rules; the insert (pending review, unedited, the engine's, its run, line endings); the **greeting gate at approval** and an owner's edit; the **follow-up cadence at sending**; the overview, lessons and statistics; owner only, anon nothing. **Mutation-checked:** 72 deliberate breaks; every one caught except the two that cannot change behaviour (below). |
| `tools/growth/outbound_draft.test.js` | 66 | the **deployed** function against the **real SQL** (`tools/growth/_rpc_shim.js`, now shared with the research test). Claude is the SDK, stubbed. It covers: owner only; status without the key; the prompt (only citeable facts and the established first name, the rules, pages as data); the SDK call (model, structured output, low effort, the fallback); a made-up detail refused and fixed on the second try with the database's objections; the template after two refusals, a decline, a failure, a malformed answer, no key, no budget, no time; the template for all three steps accepted by the database; nothing drafted when nothing passes (recorded, and the run marked failed); not due; a follow-up with nothing left to cite; next N as time allows; previous emails and lessons in a follow-up's prompt; the key only to the SDK; **the doors it calls: none that approves, edits or sends**. **Mutation-checked:** 30 deliberate breaks, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 191 | adds sections 42–47: the drafting status, Write the next drafts, who wrote each card, the greeting block, a follow-up approvable, the reject hint, Let the engine write it, the function not deployed |
| `tools/growth/outbound_send_sql.test.js` | 49 | adds: a follow-up is not sent before its delay, nor while follow-ups are off |
| earlier suites | all passing | |

**Mutations that cannot be caught, and why.**
- **Superseded facts in the context** (`citeable_facts` without its `superseded_at` filter): the filter is redundant, because superseded evidence has confidence 0 and so never clears the gate.
- **A send with no `sent_at` counted as sent** (`step_sent_at`): unreachable, because a prospect becomes *contacted* only when its step-1 send records a message id and `sent_at` together.

### Rollback

- **Stop drafting at once:** set "Claude calls / day" to 0. The engine then writes only the template. Or delete the function: `supabase functions delete growth_outbound_draft`. The console says it is not deployed and still shows who is due.
- **A bad engine draft:** reject it, with a reason (the engine reads it). Nothing an engine writes is ever sent without your approval and your Send.
- **The database:** additive. The cadence check at sending can be relaxed only by editing the file. That is deliberate.

### What Phase 8 does not do

- **Run by itself:** the morning run is Phase 9.
- **Send anything:** drafts wait for you.
- **Learn beyond your words:** it reads your reasons for rejecting its drafts. Measuring which drafts get replies (attribution) is Phase 10.

## Phase 9: the morning run

**Software may find, research, score, verify, draft and queue on a schedule. It may not approve or send.** The morning run does by itself what the buttons do. Every draft still waits in the review queue for you.

### A morning

Turn on **Automation** (Outbound settings → Mode) and set your window (Morning run: your time zone, the hour it starts, for how many hours; by default 06:00 for 4 hours, America/New_York). Every five minutes the database's own clock (pg_cron) runs `growth_outbound.schedule_tick()`. Inside your window it takes **one step**:

1. **search** your saved searches, once a day;
2. **research** the next new candidate, up to "Prospects to prepare per day";
3. **draft** for whoever is due (follow-ups first), three at a time, up to the daily send cap a day: more drafts than can be sent would only wait.

**Its limits:**
- never two steps at once;
- a step that never finished is marked failed after 30 minutes;
- after three failed steps in a row it stops for the day; 60 steps a day at most;
- a drafting step that wrote nothing waits half an hour before another;
- everything counts against the same daily provider budget as your own clicks.

### How a step runs with nobody signed in

**No credential is stored anywhere for it:** no service-role key, no password, no API token.

1. **The ticket.** For each step the tick starts a run with a single-use ticket (256 random bits) and keeps only its sha256. pg_net posts the ticket, once, to the research or drafting function.
2. **The third public door.** The function presents the ticket to `growth_outbound_scheduled`, whose first statement checks it. The run must be the scheduler's and still running, the ticket under 15 minutes old, and automation still on. **Turning automation off ends every live ticket at once.**
3. **Only the engine's own doors, only for that run.**
   - A search run records candidates.
   - A research run reads the candidate queue, stores pages and records what it can quote.
   - A drafting run reads the context and proposes drafts.

   A ticket never reaches a door that approves, edits, rejects, sends, suppresses, changes settings or starts another run.
4. **Checked twice.** Those engine doors begin with `require_engine()`: the signed-in owner as before, or, inside the ticket door only, the ticket, checked again against its hash, so a forged setting is worthless. Every door that approves, edits, sends, suppresses or changes settings still begins with `require_owner()`, and a ticket is nobody.
5. **What to do comes from the database** (the run's plan), never from the request.
6. **On the record as the system's,** never as yours (Activity).

### The console

**Morning run** (new panel, above the review queue):
- on or off, and the window in your time zone;
- whether the clock is ticking (if not: run `supabase/growth_outbound_cron.sql`), and whether pg_net is installed;
- the next step, or why there is none;
- today's progress: searched, researched of the target, drafted of the cap, new candidates, due;
- the morning run's steps, and why one failed.

**Outbound settings** gains a **Morning run** group (time zone, start hour, hours). Turning Automation on says what it does, and that it never approves or sends, and asks first. The runs table under Discover and research marks the morning run's steps.

### New in the database

- **Settings:** `automation_timezone`, `automation_start_hour`, `automation_hours`, checked by the table: a real time zone, 0–23, 1–12.
- **`research_runs`:** `ticket_sha256` and `ticket_expires_at`. A scheduled run has a ticket hash; an owner's run never does. No listing ever shows a hash.
- **`growth_outbound.scheduler`** (one row): the last tick, what it decided and why. Eighteen tables.
- **Functions:** `schedule_plan`, `schedule_tick` (pg_cron only; refused through the API), `ticket_run`, `require_engine`.
- **Doors:**
  - `growth_outbound_scheduled` (anon only; the third public door);
  - `growth_outbound_automation_overview` (owner).
- **Report rows 32–33.** Row 23 now counts three public doors.

**`supabase/growth_outbound_cron.sql`** (new): the clock. One pg_cron job, every five minutes, calling the tick with this project's functions address and no key. Running it again replaces the job.

### Deploy (in order)

1. Merge the Phase 9 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql`. Report rows 1–33 should say `ok`.
3. **Deploy the functions** (research and drafting changed): Actions → **Deploy outbound Edge Functions**.
4. **Enable pg_cron and pg_net** (Database → Extensions). Then run **`supabase/growth_outbound_cron.sql`** in the SQL editor; its report should say `ok`.
5. In the console: set your time zone and window, and turn on **Automation**. Within five minutes the Morning run panel says "Clock: last tick …".

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_schedule_sql.test.js` (new) | 112 | **the tick** (off, outside the window, your time zone, a window across midnight, your day not UTC's); **the ticket** (posted once with nothing else, only its hash kept, nowhere in plain, 15 minutes); **the door** (refused without a live ticket and nothing written; only its run's kind's doors, never approve, edit, send, suppress, settings or begin; its own run only; a forged setting, the real ticket in a signed-in non-owner's hands, and the check alone; dead when the run finishes, expires, or automation goes off); **the steps** (search once, research up to the target, drafts up to the cap even with more due, half an hour after a drafting step wrote nothing); **failures** (30 minutes, three in a row, 60 a day); **blocked** (no pg_net, not a Supabase address); the overview (never a hash) and owner only; the settings; **the cron file** (one job, every five minutes, no key, replaced when run again). **Mutation-checked:** 42 deliberate breaks, every one caught. |
| `tools/growth/outbound_research.test.js` | 99 | adds the morning run against the real SQL: a ticket the real tick minted, no owner token, every call through the ticket door as anon; the saved search; the next candidate read; the target met; a ticket used twice; a drafting run sent here; a ticket nobody issued; a malformed one never reaching the database; automation turned off; an empty queue; no search key; a token sent along changing nothing. |
| `tools/growth/outbound_draft.test.js` | 76 | adds the morning run: drafts written with no owner token, as many as the database planned (the cap, though more are due); marked with the run; a search run sent here; malformed and unissued tickets. |
| (both functions) | | **Mutation-checked:** 17 deliberate breaks to the scheduled mode, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 208 | adds sections 48–52: the Morning run panel, turning it on (asks), the window settings, no clock or pg_net, before the Phase 9 SQL |
| `tools/growth/outbound_sql.test.js` | 416 | eighteen tables; three public doors; **only the engine's doors accept a ticket** (checked statically, door by door) |
| earlier suites | all passing | |

### Rollback

- **Pause it:** turn Automation off. Every live ticket stops working at once; the clock keeps ticking and does nothing.
- **Stop the clock:** `select cron.unschedule('growth_outbound_tick');`
- **The database:** additive. The morning run's steps are runs like any other, kept on the record.

### What Phase 9 does not do

- **Approve or send.** Ever. Those stay yours, checked by the database.
- **Email you a summary.** The Morning run panel and the review queue are the summary.
- **Measure what works.** Replies, conversions and attribution by source, step and writer are Phase 10.

## Phase 10: results and attribution

**A result is matched, never guessed.** The console now shows what came of the emails: replies, opt-outs, visits, accounts, trials and payments. They are counted for the people written to and broken down by step, by who wrote the email, by prospect type, by the search that found them and by fit. Nothing new is sent, and nothing about an account leaves the database.

### How an email is traced

1. **Its links are tagged.** In a live email, every link to the main site (`https://edgedesksports.com/…`, or `www.`) gets `utm_source=outbound&utm_medium=email&utm_campaign=ob_<the prospect's token>`:
   - the token is random and says nothing about the person;
   - a test send's links carry `ob_test`, so your own clicks count for nobody;
   - trailing punctuation stays outside the link, and a `#fragment` stays last;
   - a link that already has a `utm_` tag, a subdomain, a port or a look-alike domain is left exactly as written;
   - **the review card shows the words exactly as sent, tags included;**
   - **each send records whether its links were tagged**, so a retry sends what was claimed.
2. **The site already records the campaign.** The landing page keeps the campaign of each visit and of the touch that brought each new account (`supabase/growth.sql`: `acquisition_visitors`, `user_acquisition`). Nothing on the site changed.
3. **The matcher** (`growth_outbound.sync_conversions()`) counts a result for a prospect only when:
   - the email it follows reached them: a live send that went out and did not bounce or fail;
   - it happened **after** the first email;
   - and it is traced by either:
     - **link:** the visit, or the touch that brought the account, carried their code; or
     - **address:** the account was made with the very address written to.

   **Never from a name, a domain or timing alone.** Never an owner's account or visit, never a test send, never an account that existed before the email.
4. **Trials and payments** come from Stripe's own record (`growth_customer_facts()`), for the matched accounts only.
5. **Each fact once:** visited, made an account, started a trial, paid (unique per prospect, stage and person). The record is append-only and written by the matcher only.
6. **The account itself is not stored here.** A one-way key (sha256) counts each person once: no user id, no account email.

### What a result changes

- **An account ends the sequence.** A contacted (or replied) prospect becomes **converted**, and every unsent follow-up is cancelled. A follow-up claimed after the signup is refused before anything is sent: the send door matches that prospect first. An opt-out stays an opt-out.
- **A customer is never cold-emailed.** An address that already has an EdgeDesk account is:
  - left out of the drafting engine's list;
  - blocked on its review card;
  - refused at approval, and refused again by the send trigger.

### When it runs

- **Hourly:** by the scheduler's tick (Phase 9's clock), whether or not the morning run is on.
- **Whenever you open Results.**
- **For one prospect, before any follow-up is sent.**

A failure (say, the Stripe record unreachable) is recorded and shown, and never stops the tick. Nothing is half-written, and the next run catches up.

### The console

**Results** (new panel, after Sends), for 7, 30 or 90 days, or a year:
- **header:** whether links are tagged, when results were last matched (or why matching failed), and each provider's calls;
- **the people written to:**
  - replied, opted out (by link or by asking; a bounce is not an opt-out);
  - visited, made an account, started a trial, paid;
  - each as a share of the people written to;
- **the emails:** sent, delivered, bounced, spam complaints. Opens and clicks are shown as hints only.
- **what stands out:** a group is compared once it has **10 people**. It is called out only when its whole **95% range** (Wilson) is above or below everyone's rate, so a lucky few never look like a pattern.
- **by step:** what each step sent, and which step each reply and signup followed;
- **by group** (prospect type, the search that found them, who wrote the first email, fit score): each rate with its 95% range, marked "few" below the sample;
- **the latest results:** who, what, matched how; each opens the prospect;
- **by day:** each day that had activity, in your time zone.

**Each prospect** lists its results. **Each review card** shows its tagged links and says what the tag is; an address with an account blocks the card. **Outbound settings** gains a **Results** group: link tagging (on by default). With it off, only the address written to can be matched.

### New in the database

- **`growth_outbound.conversions`:** append-only; written only by the matcher; default-deny RLS. **Nineteen tables.**
- **Columns:**
  - `settings.attribution_links`;
  - `sends.links_tagged` (fixed at claim; nobody rewrites it);
  - `scheduler.conversions_synced_at` and `conversions_error`.
- **Functions:**
  - `tag_links`, `link_campaign`;
  - `has_account`, `contacted`, `account_stages`, `account_key`;
  - `sync_conversions`;
  - `wilson`, `rate`, `cohort_rows`.
- **Changes:**
  - `compose` and `compose_for_send` tag links;
  - the send trigger, approval and the drafting list refuse an address with an account;
  - the send door matches before a follow-up;
  - the tick matches hourly;
  - the prospect detail lists its results;
  - the drafting stats count replies from the record of replies, so a signup is no longer counted as a reply.
- **Door:** `growth_outbound_analytics(p_days)` (owner only).
- **Report rows 34–35.** Row 1 counts nineteen tables; row 12 counts the conversions trigger.

### Deploy (in order)

1. Merge the Phase 10 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql`. Report rows 1–35 should say `ok`.
3. No function changed, and nothing else needs deploying. If `supabase/growth_outbound_cron.sql` has run (Phase 9), results are matched hourly from now on. Either way, opening Results matches them.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_analytics_sql.test.js` (new) | 100 | **Links:** sixteen tagging cases (punctuation, fragments, existing tags, look-alikes, ports, subdomains); no injected parameter; test sends carry `ob_test`; the preview is what is sent; the send row fixes it; turning tagging off. **Accounts:** never drafted for, approved or sent to an address with an account, however the address is written. **Matching:** by link or address only; after the first email only; never an owner's, a test's, a bounced email's or an earlier account; the link wins over the address; trials and payments from Stripe; each fact once; no id or address stored. **The end of the sequence:** converted, follow-ups cancelled, a late follow-up refused, opt-outs kept, logged by the system with no account. **The tick:** hourly, even with the morning run off; a failure recorded, nothing half-written, the next run catches up. **The door:** owner only; every number checked; Wilson ranges against an independent computation; a difference called out only past the sample and outside the range; the window; no address, id or key in what leaves. **The record:** written by the matcher only, never rewritten or read directly. **Mutation-checked:** 69 deliberate breaks; 66 caught, and the other 3 are equivalent (a second check elsewhere enforces the same rule). |
| `tools/growth/outbound_console.e2e.js` | 236 | adds sections 53–56: the Results panel, the window and grouping, tagged links and the existing-account block on review cards, a prospect's results, the tagging setting, a matching failure, before the Phase 10 SQL |
| `tools/growth/outbound_sql.test.js` | 422 | nineteen tables, each default-deny |
| earlier suites | all passing | |

### Rollback

- **Stop tagging:** turn it off (Outbound settings → Results). Emails then go out with their links exactly as written.
- **The database:** additive. The results are a record; removing the panel removes nothing.

### What Phase 10 does not do

- **Send, approve, or change who is written to by itself.** What stands out is for you to read; the engine's targets stay yours.
- **Read your inbox.** A reply counts when you mark it ("They replied").
- **Guess.** A signup it cannot trace to an email by link or address is not counted as one.

## Phase 11: testing and hardening

**Each phase was tested on its own. Phase 11 tests them together, at the same instant, and against junk, then fixes what that found.** It adds no new way to send anything.

### What the new suites prove

- **The whole life of a prospect** (`outbound_lifecycle.test.js`) runs through all five Edge Functions as deployed (research, draft, send, webhook, opt-out), the pg_cron tick and the site's own acquisition doors, against one real database. Only the outside world is stood in for.
  - The morning run finds a candidate and researches it, with nobody signed in.
  - The engine drafts.
  - The owner reviews the message exactly as it will go, and approves it.
  - A test send reaches only the owner's inbox.
  - Live, the email reaches the prospect, with their campaign code, opt-out link and one-click headers.
  - Resend's signed events record delivery, opens and clicks.
  - The prospect visits, makes an account and starts a trial; the results show it and they are converted.
  - A second prospect bounces and a third opts out with one click; no follow-up is written for any of them.
  - Across all of it: Resend is called once per approved message; no key, secret or token appears in any answer; every approval and send is the owner's.
- **The same instant** (`outbound_concurrency_sql.test.js`): real separate database sessions, released together:
  - eight claims of one draft give one send;
  - ten claims against a cap with room for five give five;
  - two batches over the same drafts in opposite orders;
  - four ticks at once;
  - two discovery runs finding the same new address;
  - one Resend event delivered five times;
  - one opt-out link pressed five times;
  - four matchers at once;
  - a claim racing a withdrawn approval.
- **Junk** (`outbound_fuzz_sql.test.js`, seeded and replayable with `FUZZ_SEED`):
  - **the text helpers:** thousands of random and hostile texts — quotes, dollar quotes, backslashes, comment markers, unicode, half-links. None fails. Link tagging is idempotent and leaves link-free text untouched.
  - **the three public doors:** every junk request is answered and nothing is written. A forged webhook in Resend's exact format is refused.
  - **the owner's and the engine's doors:** random input and near-valid input (the right shape with one part wrong) is refused in words, never with an error. Nothing junk approves or sends, and every table survives.
- **The files themselves** (`outbound_static.test.js`):
  - the repository's secret audit (`tools/cfb/secret_audit.js`, on every PR) now also finds a Resend API key, a webhook signing secret and the outbound providers' keys assigned in code;
  - the console's files hold no key and never call a provider directly;
  - each Edge Function reads exactly its own settings, never a service-role key, and logs no token, key, ticket, header or body.

### What it found, and what changed

| Found | Fixed |
|---|---|
| Two overlapping batch approvals in opposite orders **deadlocked**: Postgres aborted one, and the owner saw an error. | A batch locks all its drafts up front, in one order. The second batch waits, then is refused cleanly ("nothing was approved"). |
| Two ticks at the same moment would **both start a morning-run step**. This was only avoided by accident, while results matching happened to serialize them. | The tick takes a lock: one at a time. |
| Two discovery runs finding the same new address **deadlocked**. | Recording candidates takes a lock: one candidate, seen twice. |
| **A test send used up the real prospect.** In test mode, sending a real prospect's draft to your own inbox (what test mode is for) marked their first email "already sent". After going live, the engine never drafted their real first email, and their status stayed "ready for review" with nothing waiting. | A test send is a dry run: the step is still due. The prospect's status is refreshed when a send is claimed. A follow-up's context lists only what reached the prospect. |
| **A trial could go uncounted.** Stripe stamps whole seconds, so a trial in the same second as the email compared as "before" it. | A trial or payment counts for any account made after the email, and is never dated before the account. |
| Evidence with a numeric date (a time-zone displacement out of range) raised a **raw database error** instead of a refusal. | Every malformed-data error class (SQLSTATE 22) is refused in words: in evidence, settings and pages. |

### The System check

- **`growth_outbound.self_check()`** is the report at the end of the SQL file, now as a function. The file's report and the console run the very same checks.
- **`growth_outbound_health()`** (owner only; it changes nothing) returns those checks plus what needs attention now, most serious first, each with what to do:
  1. **Now:** a failing check; spam complaints above 1 in 1,000; bounces above 4% (over at least 20 emails in 30 days); live emails out for over a day with no event from Resend.
  2. **Soon:** sends never confirmed after an hour; automation on but the clock not ticking; three failed morning steps in a row; a results-matching error.
  3. **When you can:** approvals unsent for over three days; sending blocked.
  4. **Note:** a raised daily cap.
- **The console** shows "System check: all 36 pass" (or what needs attention) at the top of the Outbound tab. A **System check** panel lists every check and every item, with "Run the check again".
- **The sweep:** the tick marks a send never confirmed for 23 hours as failed, as the send door would on a retry. It is never retried, so never sent twice, and it is recorded as the system's.
- **Report row 36:** the three locks are in place and the System check exists.

### Deploy (in order)

1. Merge the Phase 11 PR.
2. In the SQL editor, run `supabase/growth_outbound.sql`. Report rows 1–36 should say `ok`.
3. No Edge Function changed.
4. Open the Outbound tab: the top should say "System check: all 36 pass" once sending is configured. Until then, the panel says what is blocking it.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_lifecycle.test.js` (new) | 39 | the whole life of three prospects through all five functions and one database (above) |
| `tools/growth/outbound_concurrency_sql.test.js` (new) | 22 | nine races, each with real sessions released together; stable over repeated runs |
| `tools/growth/outbound_fuzz_sql.test.js` (new) | 17 | helpers, public doors, owner and engine doors against seeded junk. In CI: seed 20261008, 300 cases per family. Five more seeds at 600 also pass. |
| `tools/growth/outbound_health_sql.test.js` (new) | 31 | the System check is the file's report; owner only; changes nothing; a broken invariant surfaces first; every attention item appears exactly when true, in order; the sweep |
| `tools/growth/outbound_static.test.js` (new) | 36 | the secret audit's new rules; the real tree clean; the browser's files; each function's settings and logging; the deploy workflow |
| `tools/growth/outbound_console.e2e.js` | 246 | adds section 57, the System check |
| `tools/growth/outbound_send_sql.test.js` | 50 | a test send leaves the prospect qualified, with their first email still due |
| earlier suites | all passing | |

**Mutation-checked:** 22 deliberate breaks of the Phase 11 SQL (the three locks, the dry-run rule, the status refresh, the trial rule, the error classes, the sweep, the health door and every attention rule) and 6 of the files (a function logging a token, reading the service-role key; the console calling Resend, another door or the webhook; a key committed). Every one was caught.

### Rollback

- **The database:** additive. The three locks, the dry-run rule and the trial rule are what was meant all along.
- **The console:** the System check panel only reads.

## Phase 12: providers, qualification and volume

**The aim: wake up to 10–15 qualified potential subscribers with drafts, and send only the ones you approve.** Phase 12 adds what the first eleven phases did not have. Nothing it adds can approve or send.

### The audit it started from

| Area | Before Phase 12 |
|---|---|
| Tables, owner-only access, evidence, drafts, sends, suppressions, opt-out, webhook, attribution | Built and tested (Phases 1–11) |
| Discovery and research | Worked, but Brave and Hunter were written into the function, with no way to switch either off |
| Clay, Apollo | Missing |
| Scoring | A flat sum of catalogue points (`fit_score`, gate 80). It had no parts and did not score contact quality or personalization |
| Subscriber vs partner | `campaign_type` existed but nothing set it, and the engine drafted the $49.99 subscriber pitch for partners too |
| Morning run | Targeted 15 candidates *read* a day rather than prospects *qualified*. Its default window was 06:00–10:00, not overnight |
| Content rules | Nothing refused "complimentary" or "special access", discounts, or picks language. Engine follow-ups did not state the price. There was no length limit |
| Sending domain | SPF/DKIM/DMARC was a checklist line only |
| Volume | A fixed daily cap of 20, with no warm-up |

### The qualification score (0–100)

It is computed by the database from evidence, like every other number, in `compute()`.

| Part | Max | What counts |
|---|---|---|
| Product relevance | 35 | Evidenced catalogue reasons in the part `relevance`: covers CFB (8), covers the NFL (8), odds, markets or probability (14), EV or fair pricing (14), player props (6), a workflow EdgeDesk clearly serves (12) |
| Demonstrated analytics interest | 25 | `analytics`: quantitative analysis (18), predictive models (15), data visualization (8), an analytical newsletter, podcast or channel (8), analytics tools (6), an engaged audience (6), consistent publishing (5) |
| Evidence of purchasing interest | 15 | `purchase`: tracks closing-line value (12), tracks their own bets (10), pays for data, tools or research (10), runs paid research (6), independent rather than at a media company (6) |
| Contact quality and legitimacy | 15 | The address: verified 9; published on their own site or profile 5; published elsewhere, or a provider's unverified find, 3; none, guessed or bounced 0. Identity at its gate 4 (at 0.70, 2). A site or profile of their own 2 |
| Personalization opportunities | 10 | Facts an email may cite, each sure enough by itself to clear the research gate: one 5, two 8, three or more 10 |
| Penalties | — | Every reason against, unproven, subtracted: spam −100, sportsbook or operator staff −50, touting −40, anonymous −40, a sports-industry job without analytics work −30, no analytics interest −30, poor fit −30, a large media outlet −25, inactive −25, entertainment only −20, generic content −15 |

**How a reason counts.** Within each of the first three parts the reasons are summed and capped at the part's maximum, so piling up relevance cannot make up for missing analytics. A positive reason counts only while it cites current evidence about that person; nothing a page or a model merely asserts counts.

**The gate.** A prospect becomes `qualified` only at `min_qualification_score` (75 by default, under **Gates**) *and* every earlier gate. The earlier gates are: fit, identity 0.90, an address that is verified at 0.90, and research 0.85. The review queue and the drafting order go best-qualified first, and approval re-checks the score.

**Where to see it.** Each prospect carries `qualification` (each part, the reasons it rests on, why they fit and what counts against them). It appears on every review card and prospect panel. `growth_outbound_qualification_rules()` returns these rules for the console.

**The fit gate is still there.** It is a flat sum, so a prospect can score 78 and still be stopped at fit 76. If you want the 0–100 score to be the only bar, lower **Minimum fit score** in Settings. That is your decision, so this phase leaves it at 80.

### Subscribers and partners

- `campaign_type` is now one of `customer` (a potential subscriber), `media_partner`, `affiliate`, `business_partner` or `partnership`.
- When it first reads a new prospect, Claude says which one they are. Working in the sports industry does not make someone a subscriber: sportsbook staff, a journalist with no analytics work and team staff are not.
- **The engine drafts only for potential subscribers.** A partner lead is never pitched a subscription. The engine is refused for them, and the drafting list leaves them out.
- **No paid lookups for partners.** The research engine spends no email-lookup budget on them.
- **Your decision stands.** You change who someone is from their panel; moving someone away from "potential subscriber" cancels a subscriber email waiting for them. The engine never overrides a segment once set.
- **This morning → Partner leads** lists them, apart from the subscriber queue.

### Providers

Each provider sits behind one small interface in `growth_outbound_research`: search, email lookup, verification or enrichment. A provider is used when its key is set (Supabase → Edge Functions → Secrets) **and** it is switched on under **Discover and research → Providers**. Brave and Hunter are on once their key is set. Apollo and Clay cost money per call, so they stay off until you switch them on.

| Provider | Role | Secret | What it can contribute |
|---|---|---|---|
| Brave | search | `BRAVE_SEARCH_API_KEY` | Candidates (pages to read) |
| Apollo people search | search | `APOLLO_API_KEY` | Candidates: the person's organization's own site, named in the snippet. No address, no credit. Never a LinkedIn or other platform page |
| Hunter | email lookup and verification | `HUNTER_API_KEY` | An address Hunter lists for that person at their domain (`provider_found`), and the verifier's word (`provider_verified` only for "valid") |
| Apollo people match | email lookup | `APOLLO_API_KEY` | An address **only when Apollo marks it verified**, for the same first and last name, and never a locked placeholder, a role address or a guessed ("extrapolated") one |
| Clay | enrichment | `CLAY_WEBHOOK_URL`, `CLAY_WEBHOOK_TOKEN` | See below |

**Never a fabricated or over-claimed address:**

- A guessed address is never put to a verifier; it waits for enrichment instead.
- An address a provider found is `risky` until a verifier or you confirm it.
- **Apollo's own "verified" is one source**, because the same company found it and checked it. It lifts the address to 0.85 sure. The email gate wants 0.90, which takes Hunter's verifier or your own check as well.
- A verifier's answer is recorded whatever it says, so the same address is not asked about again for 30 days.

**Clay** has no public API to read a table, so enrichment goes out and comes back in two halves:

1. **Out:**
   - **Send to Clay** (or the morning run, three a step) posts each prospect waiting for enrichment to your Clay table's webhook. That is one row per POST, with the table's token in `x-clay-webhook-auth`, and only ever to a `clay.com` address.
   - **Export for Clay (CSV)** downloads the same rows instead.
   - A prospect waits for enrichment when they are a potential subscriber, the address is all that keeps them under the bar, and they have not been handed over in 14 days.
   - Clay is told who they are and where: `edgedesk_ref`, name, organization, site and profiles. It is never told their score or evidence.
2. **Back:** export the enriched Clay table as CSV and use **Import Clay results (CSV)**. Clay's usual columns are mapped for you: `edgedesk_ref`, Full Name, Work Email, Company Name, LinkedIn Profile, and so on. What comes back counts as Clay's word:
   - an address is Clay's find, unverified until the verifier confirms it (the morning run asks);
   - a title or an employer is a directory's word from the profile page, at the lowest weight, and an email never cites it;
   - a profile identifies them.

   A row that names nobody EdgeDesk already found is left out, never turned into a prospect.

**Free and low-cost first.** With only Brave's free credit and Hunter's free tier, the pipeline runs, but it runs thin (see the dry run). Apollo and Clay are optional, and each is one switch.

### The morning run

- **It stops at a qualified target.** It now researches until `daily_qualified_target` new potential subscribers qualified today (12 by default), reading at most `daily_prospect_target` candidates.
- **A verify step comes first.** Addresses waiting for a verifier are checked before research, five a step and not more than once every 20 minutes.
- **Drafts follow the warm-up.** Drafting is capped by today's warm-up cap.
- **Overnight.** To have the queue ready when you wake, set the window overnight under **Morning run**: for example a start hour of 1 for 6 hours, in your time zone. It never approves or sends.

### Content rules

These apply to every draft, at approval:

- Nothing beyond the 7-day free trial: no complimentary, comped, free-month or discounted access, no promo or referral code, no special, early, VIP or lifetime access.
- Nothing that reads like a picks service: no best bets, our picks, picks or plays of the day, betting tips, tipsters or touts. "Research, not picks" is fine.

Every engine email, follow-ups included, must also:

- state the 7-day free trial and $49.99/month;
- link to EdgeDesk;
- stay under 150 words.

The follow-up templates now state the price. A draft you write or edit yourself is not blocked by these. Its card says what it is missing as **Worth fixing before you approve**, with its word count.

**`growth_outbound_draft_check(prospect, draft)`** runs the engine's rules on a draft without queuing it and writes nothing. It is how the dry run checks its emails.

### Sending: warm-up and the sending domain

- **Warm-up.** On by default. The live cap starts at `warmup_start_per_day` (10) on the day of the first live email and grows by `warmup_step_per_week` (5) each week, never past `max_sends_per_day`. The send trigger enforces it. Turning it off or speeding it up asks first, like raising the cap.
- **The sending domain.** **System check → Check the sending domain** asks the send function to read the records over DNS-over-HTTPS. It sends nothing. It reads:
  - SPF at `send.edgedesksports.com` (Resend's return path);
  - DKIM at `resend._domainkey.edgedesksports.com`;
  - DMARC at `_dmarc.edgedesksports.com`;
  - and Resend's own status for the domain, when the API key may read it.

  What happens with the result:
  - a record DNS says is missing **blocks live sending** (`domain_auth_failed`) until it is fixed and checked again;
  - DNS that did not answer decides nothing;
  - while live and never checked (or not in 30 days), the System check says so.

### This morning (the console)

A new panel at the top of the Outbound tab shows:

- qualified today against the target;
- drafts waiting for review, and approved ones not yet sent;
- sent today against today's cap (with the warm-up week);
- researched today;
- addresses waiting for a verifier, and prospects waiting for enrichment;
- the sending domain;
- the paid providers that are on;
- the partner leads.

Every review card shows:

- the score in its five parts, and why they fit;
- the address and whether anyone verified it;
- where to read up on them (https links only);
- what the email should still say.

### The dry run

`node tools/growth/outbound_dryrun.js <candidates.json> --out report.md` puts candidates through the same database doors the research engine uses, in a throwaway PostgreSQL:

- the pages it read;
- each fact as a quote the database checks;
- fit reasons and segment;
- the score;
- the owner's draft check on a proposed email.

It then proves nothing was sent: no send row, no draft row, test mode on, no Resend key, no network.

### New in the database

- **Settings:**
  - `min_qualification_score`, `daily_qualified_target`;
  - `warmup_enabled`, `warmup_start_per_day`, `warmup_step_per_week`;
  - `domain_auth`, `domain_auth_checked_at`;
  - `discovery_config.providers` and the `enrichment` budget (15 a day by default; 200 at most).
- **Prospects:** `qualification_score`, `qualification`, `first_qualified_at` (computed; nobody writes them).
- **Fit catalogue:**
  - `category`;
  - eight new reasons: data visualization, tracks own bets, pays for tools, sells paid research, independent researcher, sportsbook or operator, industry job without analytics, large media outlet. The existing reasons are re-filed into the parts.
- **Runs:** kind `enrich`.
- **Functions:** `qualification_max`, `live_send_cap`, `offer_problems`, `engine_draft_problems` (`draft_propose` now uses it), `verify_queue`, `enrichment_queue`, `enrichment_row`.
- **Owner doors:**
  - `draft_check`, `enrichment_export`, `provider_import`, `domain_auth_record`;
  - `prospect_set_segment`, `qualification_rules`, `partner_leads`, `morning`.
- **Engine doors (a ticket may reach them, on research runs only):** `verify_queue`, `enrichment_queue`, `enrichment_mark`. None of them approves, edits or sends.
- **Report row 37.** Still nineteen tables, three public doors.

### Deploy (in order) — for you to run when you have reviewed it

Nothing in this phase has been deployed. Schema changes and automation stay off until you run them.

1. Merge the Phase 12 PR. The console works against the Phase 11 SQL until step 2. "This morning" says which SQL to run, and the page sends no Phase 12 setting before then.
2. In the SQL editor, run `supabase/growth_outbound.sql`. It is additive and idempotent, and re-evaluates every prospect. Report rows 1–37 should say `ok`.
   - **Prospects that were qualified may move back to "needs research"** if they score under 75. That is the new bar working. Their cards say why.
   - **Existing approvals they no longer earn go back to review**, as before.
3. **Deploy the functions** (research and send changed; draft changed its templates): Actions → **Deploy outbound Edge Functions**. Its tests now include the provider suite.
4. **Optional secrets** in Supabase → Edge Functions → Secrets:
   - `APOLLO_API_KEY`;
   - `CLAY_WEBHOOK_URL` (your Clay table's webhook, `https://api.clay.com/…`) and `CLAY_WEBHOOK_TOKEN`.

   Then switch each on under **Providers**.
5. **System check → Check the sending domain.** Fix anything missing in DNS before going live.
6. **Morning run:** set an overnight window, a qualified target, and budgets your provider plans can afford. Turning Automation on is still yours.

**Capacity.** Every qualified prospect needs a verified address: one verifier call each, plus usually one lookup. To qualify 10–15 a day, expect to read 40+ candidates and verify 15–30 addresses a day. That is beyond Hunter's free tier; Hunter's paid tiers, Apollo, or Clay's waterfall is what makes the target reachable. Raise "Candidates to read per day", "Pages / day", "Claude calls / day", "Email lookups / day" and "Verifications / day" to match the plan you buy.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_qualify_sql.test.js` (new) | 163 | **Score:** the catalogue's parts, a strong prospect's 35/25/12/15/8, caps, contact points per address kind, personalization, penalties, the gate and its bar, computed only, first qualified when, approval re-checks it. **Segments:** the engine drafts and lists subscribers only; the owner decides and the engine never overrides; partner leads. **Content:** 24 refused and 7 clean texts; the offer, link and length; the engine held to it, the owner advised. **Draft check** writes nothing. **Warm-up:** the ramp, the trigger, confirmation. **Domain:** honest records, a failure blocks live sending, unchecked said when live. **Providers and budgets.** **Verify and enrich queues.** **Clay import:** Clay's word, never verified, never a new prospect, role addresses and placeholders refused. **Apollo's "verified":** one source, not two. **Morning:** the qualified target, the verify step, the warm-up draft cap, the morning door, tickets. **Mutation-checked:** 24 deliberate breaks, every one caught. |
| `tools/growth/outbound_providers.test.js` (new) | 43 | The deployed research and send functions against the real SQL, covering Brave, Apollo, Hunter, Clay, DNS-over-HTTPS and Resend: provider status and switches; discovery across providers; finders in order; Apollo verified-only, same person, no placeholders, no role addresses; no lookup for partners; verification and its verdicts; the morning run's verify step on a ticket; Clay one row per POST, token to Clay only, the budget, 14 days; the domain check (found, missing, a resolver down, DNS silent, a sending-only key, owner only); each key only to its own provider. **Mutation-checked:** 9 deliberate breaks, every one caught. |
| `tools/growth/outbound_console.e2e.js` | 283 | Adds sections 58–62: this morning, the card's score and advice, the prospect's segment, providers, verify, Clay push, export and import, the domain check, the warm-up, before the Phase 12 SQL |
| Earlier suites | All passing | Updated: the engine-door allowlist (three read-only queues), the research engine's settings, the follow-up fixture now states the price, the warm-up off in two suites that send dozens of live emails a day |

### Rollback

- **Stop Apollo or Clay:** switch them off under Providers, or delete their secrets.
- **The bar:** lower `min_qualification_score` (0 disables it).
- **The warm-up:** turn it off (asks first).
- **A failed domain check blocking live sends:** fix DNS and check again, or `update growth_outbound.settings set domain_auth = null, domain_auth_checked_at = null;` in the SQL editor.
- **The database:** additive. To return to Phase 11, re-run the Phase 11 file (`git show 4f99b38:supabase/growth_outbound.sql`). Its functions replace these, and the new columns are harmless.

## The daily email (2026-10): "N drafts are waiting for your review"

**A short note to you, once a morning, when the morning run leaves drafts for you to review.** It is a notice to the owner, not outreach: it never goes to a prospect, never sends a draft, and never counts against the daily cap. It is off until you turn it on.

### What it says

Counts, and nothing else:

- how many drafts wait for review (first emails and follow-ups), and how many the morning run wrote;
- approved drafts not yet sent;
- in test mode, that approved emails go only to your test inbox; live, how many emails you may still send today (under the warm-up cap);
- what the System check says needs attention, in fixed words;
- the link to `/admin/growth/`.

No name, address, organization, site or draft text appears in it. If your inbox is ever read by someone else, it tells them nothing about anyone.

For example:

> **Subject:** 3 outbound drafts are ready for your review
>
> 3 drafts are waiting for your review: 2 first emails, 1 follow-up.
> The morning run wrote 3 of them on Thursday, October 8.
>
> Test mode is on: an approved email goes only to your test inbox.
>
> Review them: https://edgedesksports.com/admin/growth/
>
> Nothing goes to a prospect until you approve it and press Send.
> This note goes only to you. Turn it off in Outbound settings, under Morning run.

### Whom it goes to

- **Your account's own confirmed address.** You turn it on under **Outbound settings → Morning run**. It goes to the account that turned it on, and the settings show which address that is. There is no address field: nothing typed in, nothing a hijacked session could point elsewhere.
- **It is looked up every time**, so a changed address follows you.
  - An owner who is removed stops receiving it at once.
  - An unconfirmed address receives nothing.
  - If the owner's address is also a prospect's, it is refused rather than guessed about.
- **From:** `EdgeDesk outbound <davis@edgedesksports.com>` (your sender address). It is tagged `edgedesk=outbound`, so the newsletter's webhook leaves its events alone.

### When it goes

- **Once a morning, at most.** It goes as soon as the morning run has nothing left to do: not while a step is running, and not while the run only pauses before trying a step again. If the run never finishes, it goes when your window closes.
- **Up to 12 hours after the window.** Turned on in the afternoon, you get today's note within five minutes.
- **Nothing to review that morning:** no email. The morning is recorded as skipped, and a draft that arrives later that day does not bring one.
- **Automation off:** it still goes, at your window's time, if drafts wait (for example, ones you wrote yourself).

### How it is sent, and why it cannot do more

The tick decides; it never sends anything itself.

1. When the morning run is idle, the tick mints a **single-use ticket** (only its sha256 is kept) and posts it through pg_net to a new Edge Function, **`growth_outbound_digest`**.
2. The function presents the ticket to the ticket door (`growth_outbound_scheduled`). A daily-email ticket opens **two doors and no others**:
   - write the note (once per ticket);
   - say what became of it (Resend's id, or why not).

   It cannot reach a run door, a draft, a prospect, a send, an approval or a setting. A morning-run ticket cannot reach these two either.
3. The function checks the note is still exactly one plain EdgeDesk email to one address (no extra recipients, headers or fields), then sends it through Resend with one idempotency key per try.
4. It holds the project URL, the public anon key and `RESEND_API_KEY` (already set). It holds no service-role key, and it refuses any request from a browser.

### When it fails

- **It surely did not go** (Resend down or rate-limiting, the key refused, the key not set, or the function never ran): tried again 20 minutes later, at most three tries.
- **It may have gone** (no answer from Resend, or the function stopped after writing it): never tried again. A missed note is better than a duplicate.
- **Resend refused the message:** not tried again.
- **The System check** says when this morning's email could not be sent, or when it has nobody to go to. The morning-run panel shows each try.

### New in the database

- **Settings:** `digest_enabled`; `digest_owner` (who turned it on: a reference to the owners list, cleared when they lose outbound). The settings show the address it resolves to, not the id; the id appears only in the settings change log.
- **Table:** `digests`, the twentieth. It holds one row per morning: what was decided, how many waited, the tries, Resend's id, and the ticket's hash only. It holds no address. Deny-all to every client role, and never deleted.
- **Functions:**
  - the plan and the tick's part: `digest_recipient`, `digest_plan`, `digest_tick`, `digest_sweep`, `post_blocker`;
  - the ticket and its doors: `digest_for_ticket`, `digest_door`, `digest_compose`, `digest_result`, `digest_end`.

  None is callable by a client role. The ticket door hands a ticket that is not a run's to `digest_door`, which checks it first.
- **The morning-run panel** (`growth_outbound_automation_overview`) adds `digest`: on or off, to whom, what next, and the last seven mornings. It never shows a ticket hash or an account id.
- **System check:** row 38 (the rules above, and where it goes); rows 1 and 12 count the new table and its never-delete trigger. Attention items `digest_failed` and `digest_no_recipient`.
- **Still three public doors.**

### Deploy (in order)

1. Merge the PR.
2. In the SQL editor, run `supabase/growth_outbound.sql`. Report rows 1–38 should say `ok`.
3. Deploy the functions: Actions → **Deploy outbound Edge Functions**. It now deploys `growth_outbound_digest` too, `--no-verify-jwt` like the research and drafting functions (pg_cron sends no JWT; the database checks the ticket). No new secret: it uses `RESEND_API_KEY`.
4. The clock (`supabase/growth_outbound_cron.sql`) is unchanged. If it already runs, nothing to do.
5. Outbound settings → Morning run → tick **Email me once the morning run is done…** and Save. It shows the address it will use.

### Tests

| Suite | Checks | What it proves |
|---|---|---|
| `tools/growth/outbound_digest_sql.test.js` (new) | 102 | Settings, the plan (window, zone, midnight, grace, busy, pausing, off), the tick, the ticket (two doors only; a run's ticket cannot reach them; dead once answered or expired), the content (counts only; nothing about anyone), retries and the sweep, never a send, draft or prospect, the overview and System check |
| `tools/growth/outbound_digest.test.js` (new) | 45 | The deployed function against the real SQL and a Resend stand-in: only a POST, never a browser, a well-formed ticket; exactly the note the database wrote, to one address, tagged, keyed per try; every Resend failure recorded with the right retry; a tampered note never sent; no key, ticket or address in any answer or log |
| `tools/growth/outbound_lifecycle.test.js` | 48 | Adds step 9: the morning run drafts, the tick hands the daily email a ticket, the real function sends one note to the owner; nothing else moves |
| `tools/growth/outbound_static.test.js` | 40 | Every outbound function is checked (a new one must be added); the digest function reads only its three settings and logs nothing secret |
| `tools/growth/outbound_console.e2e.js` | 295 | Adds sections 58–60: the setting, where it goes, no address field, the panel's chip (sent, failed with its reason, nobody to go to, off), text never markup |
| `tools/growth/outbound_sql.test.js` | 494 | Twenty tables, every one denied to clients |

**Mutation-checked:** 66 deliberate breaks (52 of the SQL, 14 of the function). 63 were caught. Two of those were first missed, which led to two more checks: the plan's own words after a failure that may have sent, and the ticket check itself after an answer.

The other three remove one of two independent safeguards whose other one holds in every state the database allows:
- the owner check inside `digest_recipient` (the foreign keys already clear a removed owner);
- the two guards on the tick's upsert (the plan never asks for a send or a skip they would refuse).

### Rollback

- **Stop it:** untick it in the settings. A ticket already out dies with it, and nothing more is written or sent.
- **The database:** additive. Re-running an earlier file leaves the new table and columns unused.

## Operating it

### Before you go live (a checklist)

1. **Owner:** `select growth_outbound.grant_owner('you@…');` once, in the SQL editor. Only owners see the Outbound tab.
2. **Compliance:** a postal address in Outbound settings; the opt-out endpoint (`growth_outbound_optout`) deployed and its base URL set; Resend's webhook pointed at `growth_outbound_webhook`, with its signing secret set (`select growth_outbound.set_webhook_secret('whsec_…');`). The red banner lists whatever is missing.
3. **Domain:** send from `davis@edgedesksports.com` on a domain verified in Resend (SPF, DKIM, and DMARC at least `p=none`). Check it from the console: System check → Check the sending domain. A missing record blocks live sending.
4. **A dry run in test mode:** use "Test draft for my inbox", approve it and send it. Check that the email arrives with the footer, the opt-out link and the `ob_test` link; that Sends says delivered; and that the opt-out link's page asks before it changes anything.
5. **System check:** all checks pass, and nothing under "Now" or "Soon".
6. **Go live:** turn test mode off (you type LIVE). Keep the daily cap at 20 at first; the warm-up starts at 10 a day and adds 5 a week up to it.
7. **The morning run (optional):** run `supabase/growth_outbound_cron.sql`, set your window, and turn Automation on. It never approves or sends.
8. **The daily email (optional):** tick "Email me once the morning run is done…" in the same group. It tells you when drafts wait, and only you.

### Every morning

1. Open `/admin/growth/` → Outbound. With the daily email on, its link brings you there once drafts are waiting.
2. Read the System check line and **This morning**: qualified today, what waits for review, today's cap, the domain.
3. **Review queue:** approve or reject each draft.
4. **Approved, not sent:** press Send.
5. In **Sends**, check delivery. Mark replies on the prospect ("They replied", or "…stop emailing them").

### When something goes wrong

- **Stop everything now:**
  - turn Automation off (the morning run stops, and every live ticket dies at once);
  - turn test mode on (no email can reach a real person);
  - if you want the clock gone too, run `select cron.unschedule('growth_outbound_tick');`.
- **A draft you approved should not go:** use "Withdraw approval" (Review queue → Approved, not sent). Once sent, an email cannot be recalled.
- **Someone asks not to be contacted:** Suppressions → add the address (or the domain). This is permanent and cancels everything unsent for them.
- **Bounces or spam complaints climb (System check, "Now"):**
  1. stop sending (test mode on);
  2. look at how those addresses were found (Discover and research);
  3. tighten the email-confidence gate in settings.
- **A key may have leaked:** rotate it at the provider, then in Supabase → Edge Functions → Secrets: `RESEND_API_KEY`, `ANTHROPIC_API_KEY`, `BRAVE_SEARCH_API_KEY` or `HUNTER_API_KEY`. Functions read keys on every request, so nothing is redeployed. For the webhook secret, roll it in Resend, then run `select growth_outbound.set_webhook_secret('whsec_…');` (Svix sends both signatures while it rolls).
- **Remove an owner:** in the SQL editor, run `delete from growth_outbound.owners where user_id = (select id from auth.users where lower(email) = lower('them@…'));`. Removing them from the affiliate admins does the same. Every grant and revoke is audited.
- **The daily email did not come:** the morning-run panel says why ("Daily email: …"). Usually nothing waited for review, or the morning run is still working. If it says it could not be sent, the System check says what Resend answered. Check that `growth_outbound_digest` is deployed and `RESEND_API_KEY` is set. It tries again by itself only when it surely did not go.
- **"Sends were never confirmed" (System check, "Soon"):** press "Try again" in Sends. It reuses the same key, so Resend sends at most once. After 23 hours the tick marks such a send failed.

## Next

All twelve phases are built, and the owner's daily email with them. What remains is operating it: the checklist and the morning above, and choosing which paid providers (if any) are worth their cost against the qualified prospects they produce (Results → By group → Search shows which searches pay off).
