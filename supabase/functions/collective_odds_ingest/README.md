# collective_odds_ingest

Polls the odds provider, normalises what comes back, and stores it. The only
function here that holds a provider credential.

## Provenance of this file — read before trusting it

**This is a reconstruction, not a dump of the deployed function.** As with
`collective_odds`, the deployed copy lives only in the Supabase dashboard.

Unlike `collective_odds`, the repository holds no later evidence about this
one: no patch file, no audit note naming a route. So this is the August 2026
source as written and deployed, carrying every fix made to it at that time,
and nothing after. If the deployed copy was edited since, this file does not
know about it.

It does carry six defects found by an adversarial audit of the multi-league
work and fixed before delivery — per-key settings expiry, an empty slate no
longer recorded as a provider outage, the credit balance written before the
bail-out rather than after, a retry floor that was dead code, a database
fault no longer reported as a bad credential, and `authorize()` moved inside
the handler's try so its failures keep their CORS headers.

## The linker it calls — resolved

The run ends with `rpc("odds_link_games", { p_league })` and
`Content-Profile: collective`, so PostgREST resolves
`collective.odds_link_games(p_league text)`.

**Nothing in this repository created that name.** The linker that exists is
`odds.link_collective_games`, from
`supabase/migrations/20260922220100_fix_ncaaf_collective_game_linking.sql` —
different name, different schema. Three call sites ask for the missing one:
two in this file's `/v1/link` and `/v1/close` handlers, uncaught, and one at
the end of `/v1/ingest` wrapped in `.catch(() => 0)`. That last one is why it
went unnoticed for a season: a name that does not resolve and a week with no
new matches both report `games_linked: 0` beside `status: "ok"`, with nothing
logged.

`supabase/migrations/20261004160000_collective_odds_link_games_rpc.sql` adds
the name as a thin wrapper that delegates to the real linker, rather than
editing this file — one SQL statement instead of a dashboard redeploy of a
reconstructed bundle, and the deployed function keeps working unchanged.

Verified against a throwaway PostgreSQL 16 with Supabase-shaped roles, not
just read: the wrapper returns 0 with a notice when the inner linker is
absent; with it present and a production-shaped fixture it linked 2 of 3
events for `ncaaf` (including a `cfb-p4` sport row) and left the `nfl` event
alone; `'nfl'` linked the NFL event, so the argument passes through; the
second call returned 0, so linking is idempotent; four applies of the
migration were clean; and as `service_role` — which holds no rights on
`odds.events` — the security-definer wrapper still linked, while `anon` and
`authenticated` were refused.

`/v1/link` is the quickest check against the live project. It makes this call
uncaught, so it answers with a PGRST202 "could not find the function" body
before the migration and `{"ok":true,...,"games_linked":N}` after it.

## Deployment

Paste as `index.ts` for a function named exactly `collective_odds_ingest`,
and turn **off** "Enforce JWT verification". It authenticates callers itself:
the service-role key, an `x-odds-cron-token` matching `ingest.cron_token`, or
an admin session.
