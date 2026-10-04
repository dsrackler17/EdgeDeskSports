# collective_odds

The only odds surface the browser is allowed to see. It reads what
`collective_odds_ingest` stored; it never calls a provider and holds no
provider credential.

## Provenance of this file — read before trusting it

**This is a reconstruction, not a dump of the deployed function.** The
deployed copy lives only in the Supabase dashboard, and
`collective/AUDIT.md` records that gap:

> The deployed `collective_odds` function is not in this repository and its
> hosts are unreachable from the environment this was written in.

What is here is assembled from what the repository can actually attest to:

| part | where it came from | confidence |
|---|---|---|
| league-scoped routes `/v1/<league>/...` | `docs/collective-grading-v2/AUDIT.md` §3 names `/v1/<league>/closing/<game_id>` and `/v1/<league>/odds?week=N` as the two live routes | **confirmed live** |
| `windowFrom` reaching backwards, `back` default 8, capped 28 | `docs/collective_odds_windowFrom.patch.ts`, copied verbatim | **confirmed live** |
| `closing['spread:home']` payload shape | `docs/collective-grading-v2/AUDIT.md` §2 | **confirmed live** |
| everything else | written here in August 2026 and deployed then | **may have drifted** |

So: the routing, the window and the closing shape are what production does.
The rest is the last source anyone has, and the deployed copy may have moved
since. Treat a disagreement between this file and production as production
being right until someone checks.

## Closing the gap properly

Copy the live source out of the dashboard
(Edge Functions -> collective_odds -> Edit) over this file and commit it. Then
this README's table can be deleted, because the question it answers stops
being a question.

## Deployment

Paste as `index.ts` for a function named exactly `collective_odds`, and turn
**off** "Enforce JWT verification". Market odds are public information; the
Collective's paid gate is on model projections, not on the market, and the
anon key has no grant on the odds tables.
