# Model Collective — security and product audit (September 2026)

This document records what was audited in the Collective front end
(`collective/index.html`, `collective/join.html`, `collective/admin.html`,
`collective/odds.js`, `collective/embed.js`) and the one server bundle kept in
this repository (`supabase/functions/collective_ingest/index.ts`), what was
changed, and what could not be verified from this repository.

The other edge functions the page calls — `collective_public`,
`collective_join`, `collective_billing`, `collective_admin`, `collective_odds`,
`collective_embed` — and the database policies behind them are deployed from
the Supabase dashboard and are **not in this repository**. Where a guarantee
depends on them, it is listed under *Verify on the server* rather than claimed.

## 1. Access matrix

| Resource | Public | Signed-in (no subscription) | Subscriber | Creator | Admin |
|---|---|---|---|---|---|
| Historical records, graded game logs | read | read | read | read | read |
| Public profiles, rankings, rules | read | read | read | read | read |
| Pre-kickoff model numbers, consensus, splits | locked | read while `billing.enabled=false`; locked once billing is live | read | read | read |
| Model comparison (current slate side by side) | locked | as above | read | read | read |
| Creator dashboard, submissions feed, earnings, keys, origins | — | — | — | own only | own only |
| Profile editing, slate submission | — | — | — | own only | own only |
| Creator API key (raw) | — | — | — | shown once on issue / rotate | — |
| Invite creation, revoke, quarantine, schedule, results, odds ingest | — | — | — | — | write |
| Member removal preview, member removal, member activity roll | — | — | — | — | write |
| Admin audit log (`collective.admin_audit_log`) | — | — | — | — | via SQL only |
| Invite redemption | token holder, signed in | | | | |
| Billing state | — | own | own | own | — |
| Internal configuration (`config` table) | — | — | — | — | via SQL only |

### Enforced server-side (verified in this repository)

* **Paid gate is in the response body.** `buildGames()` in
  `collective_ingest/index.ts` returns `{creator_slug, model_slug, locked:true}`
  and `{locked:true, n}` for the consensus on any game that is not settled and
  not open to the caller. A locked row carries no number, no timestamp and no
  grade, so the browser cannot leak what it never received. `entitled` is
  computed by `isEntitled()` from `subscribers` / `creators` rows and the
  `billing.enabled` config, never from the request.
* **Ingest pins identity to the key.** The envelope's `model` and `sport` are
  overwritten with the key's own creator/model (`pKey`, `envelope`), so a key
  can only ever write its own creator's model whatever the body claims.
* **API keys are hashed.** Only `sha256(raw)` is stored (`newApiKey`), the
  raw key is returned once, lookups are by prefix and compared with a
  constant-time function, and "no such key" and "wrong secret" return the same
  message.
* **Invite tokens** are `mci_` + 24 base62 characters (~143 bits) from
  `crypto.getRandomValues` with rejection sampling; only the hash is stored.
* **Lock rule** lives in the database (`supabase/lock_rule.sql`); the ingest
  only states it.
* **Admin** is decided by `collective_admin` against `admin.user_ids`; the
  page shows the caller's user id only after a 403, and only to display.
* **Member removal is decided in the database, not by the page.**
  `supabase/collective_member_removal.sql` installs three SECURITY DEFINER
  routines. The public wrappers take **no acting-user argument** — the actor is
  `auth.uid()` — so a forged body cannot supply one; `anon` has execute on none
  of them; a contributor who calls them gets `ok:false forbidden`; a full delete
  is refused unless the word `DELETE` reaches the server; an admin cannot remove
  themselves and the last configured admin cannot be removed at all. The whole
  removal is one transaction, so a failure leaves the contributor and every row
  they own exactly as they were. Proved against a real PostgreSQL by
  `tools/collective/member_removal_sql.test.js`, not reasoned about.

### Enforced client-side only (by design, and harmless)

* `me.role`, `me.admin`, `d.entitled` from `/v1/me` and `/v1/games` are used
  for layout. Editing them in the browser changes which panels are drawn, not
  what the API returns.
* localStorage holds the session tokens, the chosen sport, the intro-strip
  dismissal, a remembered column mapping and a "sports I plan to cover" note.
  None of these grant anything.

### Verify on the server (not in this repository)

1. `collective_join /v1/join/:token/redeem` must derive `founding`, the
   permitted sport and the creator identity from the invite row and the
   authenticated user, and must ignore `founding`, `creator_id`, `user_id` or
   any role field in the body. The page sends only `display_name`,
   `model_name`, `sport`, profile fields and `accept_terms`.
2. `collective_public /v1/dashboard/*` must scope every read and write to the
   creator row owned by the authenticated `sub`; the page never sends a
   creator id.
3. `collective_public /v1/dashboard/profile` should reject non-http(s)
   `website_url` / `logo_url`. The page now refuses to render such values, but
   the API should not store them.
4. `collective_billing /v1/billing/checkout` must map `plan` to a price on the
   server and attach the authenticated user; the browser navigates to it with
   a query string only.
5. Row-level security on tables read directly with the anon key from **other**
   pages in this repository (`index.html` landing: `sbGet`, `billing_consents`,
   `referrals`, `subscriptions`; `app.html` and `record.html`: `signals`,
   `feedback`; root `admin.html`). The Collective pages make three direct
   `rest/v1` calls and no others: the member-removal RPCs on `collective/admin.html`
   (`collective_member_activity`, `collective_member_removal_preview`,
   `collective_member_remove`), which are functions rather than tables, carry the
   signed-in admin's own JWT, derive the actor from `auth.uid()`, and are granted
   to `authenticated` only. Their REST base comes from the same `resolveApiBase()`
   guard as everything else on the page, so the `?api=` protection covers them
   too. No Collective page reads or writes a table directly. To list tables without RLS in the relevant schemas:

   ```sql
   select n.nspname as schema, c.relname as table, c.relrowsecurity as rls
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public','collective')
    order by 1,2;
   ```

   Any table in that list with `rls = false` that the anon key can reach needs
   `alter table <schema>.<table> enable row level security;` plus a policy for
   the intended public read; nothing in this repository shows one is missing,
   so no migration is shipped blind.
6. **A removed contributor must stop being served, not only stop posting.**
   `collective_member_removal.sql` deletes their credentials and installs a
   trigger that refuses a projection for a removed contributor's model, which is
   enforcement no deployed function can be out of date about. But
   `collective_ingest`, `collective_public` and `collective_admin` are not in
   this repository and do not read `collective.creators.removed_at`, so a
   membership-only removal still leaves their public profile and dashboard
   answering. Those three should read `removed_at` when they are next committed;
   `full_collective_delete` is unaffected, because after it there is nothing left
   to serve.

## 2. Findings and changes

| # | Finding | Severity | Change |
|---|---|---|---|
| 1 | `?api=` accepted any URL. A crafted link (`collective/?api=https://attacker`) made a signed-in member's page send its bearer token to that host, and the magic-link redirect preserved the query so a fresh sign-in landed there too. | High | `apiOverrideAllowed()` / `resolveApiBase()` on all three Collective pages: URL overrides are honoured only for `localhost`, `*.supabase.co`, `*.supabase.in`, `*.edgedesksports.com` over https. The localStorage override is unchanged (needs code on this origin). `join.html` only forwards an `api` that passed the guard. |
| 2 | Creator-supplied `website_url` and `logo_url` were HTML-escaped but never scheme-checked, so a stored `javascript:` URL would render as a live link on the public profile. `x_handle` was pathed onto `x.com` unfiltered. | Medium | `safeUrl()` (http/https only) and `safeHandle()` (`[A-Za-z0-9_]`) on every href/src built from creator or server data; `rel="noopener noreferrer"` and `referrerpolicy="no-referrer"` on logos. |
| 3 | No CSP on the Collective pages while `app.html` already shipped one. | Low | `object-src 'none'; base-uri 'self'; form-action 'self'` meta plus `referrer strict-origin-when-cross-origin` on index, join and admin. A `script-src` directive is **not** possible without hashing or noncing every inline block, and GitHub Pages cannot vary a nonce per response; the migration is: move the inline script to `collective/app.js`, add `script-src 'self' https://fonts.googleapis.com`, `connect-src` for the Supabase project, ESPN and fonts, and `img-src https: data:`. `frame-ancestors` and `Permissions-Policy` are header-only and cannot be set from static hosting. |
| 4 | Sign-out only cleared localStorage; the refresh token stayed valid at the auth server. | Low | `clearSession()` POSTs `/auth/v1/logout` best-effort. |
| 5 | The "Add N games to your schedule" loader and the admin-grant SQL were offered to every creator whose pre-flight found missing games; non-admins got a 403 and database instructions. | Low (UX / exposure of operational instructions) | Button drawn only when `/v1/me` says `admin:true`; other creators see a note that the operator loads the schedule. The 403 branch (config drift for a real admin) is unchanged. |
| 6 | Row-problem strings were escaped at construction and again at render, showing `&amp;lt;` on odd inputs. | Cosmetic | Escaped once, at render. |

Reviewed and left as is: magic-link capture and `history.replaceState`
scrub; refresh-before-expiry; 401 → clear session; JWT decode used only to
display the caller's id; `esc()` on every user/API string in `innerHTML`
sinks (creator/model names, descriptions, filenames, error messages, invite
prefill, team labels); `odds.js` escapes every field it renders; the
`onerror` fallback in `avatar()` interpolates a sanitised alphanumeric
monogram only; billing stays off while `billing.enabled` is false.

## 3. Product changes (no grading, consensus or market maths touched)

* **Wall command centre** above the terminal wall: summary strip (active
  models, projections on the slate, games covered, models updated in 7 days,
  major disagreements), *What the room is saying* (at most four universal
  game cards, each chosen for one reason), *Model splits* table, and a
  dismissible three-column story strip. All counts come from the rows on the
  page; locked slates are reported as a member view, never estimated.
* **Universal game card** vocabulary (`gameSummary`, `gameCardHTML`,
  `favSpread`, `disagreementLevel`) shared by the wall cards, the splits table
  and the Board's per-game summary line.
* **Rules** leads with *One rule. Every model.*, the
  Submit → Timestamp → Lock → Game → Collective close → Grade → Permanent record
  flow, and eight plain-language guarantees; it renders even when `/v1/rules`
  fails.
* **About** restructured into the ten sections a first-time reader and a
  prospective creator need, including the free/paid boundary and the
  EdgeDesk relationship.
* **Model page**: who the model is, how it has performed, the log,
  calibration, *How it behaves* (distance from close, off-market share,
  home lean, pick-side lean, revision rate — computed only from numbers on
  the wire, with sample sizes), *What it says now*, methodology, coverage.
* **Creator profile** as a résumé: labelled header, verified record,
  current projections (locked rows counted, never shown), methodology,
  activity, creator links.
* **Rankings**: sport/season/metric/sample/coverage context strip; graded
  counts under ten are marked *thin* and the value dimmed.
* **Creator dashboard** reordered to *your model → post your slate → what
  needs attention → recent activity → record → tools*; next lock in the stat
  grid; the upload panel walks a seven-stage strip
  (Upload → Detect → Map → Verify → Dry run → Post → Receipt); every post ends
  in a structured receipt with the server's counts, the server timestamp when
  the response carries one (labelled *posted from this device* otherwise),
  and a copyable JSON receipt.
* Sport-specific empty states; operating principles and the faith line in the
  footer.

## 4. Removing a contributor (September 2026)

An admin-only path to take somebody out of the Collective, added because there
was none: it was an editor session against production, and the only record of it
was whatever the person doing it remembered.

* **Two removals, never one.** *Remove from the Collective only* revokes
  membership and every credential and keeps the history exactly as it stands.
  *Remove and delete their Collective data* additionally deletes every row under
  them. The destructive one is a second colour, a second confirmation, and the
  typed word `DELETE` — checked on the **server**, so the box on the page is a
  courtesy rather than the guard.
* **Nothing is deleted by opening the panel.** It is a read: the database counts
  what a removal would take, per table, and what it would preserve — the games,
  the other contributors and their rows, the earnings ledger, and the person's
  EdgeDesk account, which is never touched in either mode.
* **The creator row is kept in both modes**, stamped with when, by whom and how.
  A removal you cannot read back off the row is not a removal, and a deleted
  identity leaves the audit log pointing at nothing.
* **The source of truth stays the submissions.** `consensus`, `model_records`
  and `model_coverage_totals` are views, so a deleted contributor stops counting
  the instant the rows go — not because anything was adjusted, but because there
  is nothing left to count. Materialized views and rebuild routines are found
  and run, and the response says which.
* **Immutable historical snapshots.** This repository shows no such table, so
  none is assumed. If a deployment has one, it is reached by the same foreign-key
  walk and **deleted** by default, on the rule in §12 of the brief: leaving a
  removed contributor inside a number the site still displays as current is the
  one thing worse than losing the snapshot. An operator who has looked at their
  own snapshot table and disagrees names it in the config key
  `collective.member_removal.extra_protected`, and the removal then refuses
  rather than orphaning it — a preserved child that still points at a deleted
  parent raises its own foreign key and the whole transaction rolls back.

## 5. Known gaps (not invented around)

* **Model movement timeline.** The games feed carries `movement_n` and the
  latest row only; there is no per-game revision history endpoint. The page
  shows `+n` revisions and the latest timestamp. A `GET
  /v1/models/:c/:m/games/:id/history` returning every stored submission with
  `received_at` is the missing piece for the *Model movement* surface.
* **Server receipt time.** `/v1/dashboard/submit` does not return a
  `received_at`; the receipt says so and prints the device clock, labelled.
* **Confidence intervals** on rankings are not provided by the API and are
  not fabricated; sample size is shown instead.
