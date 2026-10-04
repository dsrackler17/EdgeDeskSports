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

## The linker it calls

The run ends with `rpc("odds_link_games", { p_league })`, wrapped in
`.catch(() => 0)` — so a missing function and zero matches both report
`games_linked: 0`.

The live linker is **`odds.link_collective_games`**, created by
`supabase/migrations/20260922220100_fix_ncaaf_collective_game_linking.sql`,
which also maps `ncaaf` to the Collective's `CFB` and backfills season and
week. If the deployed function still calls `odds_link_games`, that name needs
to point at it — otherwise the silent zero is the only symptom.

## Deployment

Paste as `index.ts` for a function named exactly `collective_odds_ingest`,
and turn **off** "Enforce JWT verification". It authenticates callers itself:
the service-role key, an `x-odds-cron-token` matching `ingest.cron_token`, or
an admin session.
