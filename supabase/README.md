# Supabase sources

Backend sources for the Model Collective, kept in the repository so a schema
change and the code that depends on it land in one commit.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, split into modules
functions/_shared/    modules shared across functions
functions/_bundles/   generated single-file output for the dashboard editor
```

## What is here, and what is not

The odds layer is complete here: its migration, its two functions, and the
shared modules they need.

The other Collective functions (`collective_public`, `collective_ingest`,
`collective_admin`, `collective_join`, `collective_billing`,
`collective_embed`, `collective_click`, `collective_session`,
`collective_url`) are currently maintained in the Supabase dashboard and their
sources are not in this repository. The shared modules here — `env.ts`,
`http.ts`, `db.ts`, `auth.ts` — mirror what those deployed functions already
inline, so adding a function's source later means dropping in its `index.ts`
and running the bundler.

`odds_provider.ts`, `oddsblaze.ts`, `odds_normalize.ts` and `odds_api.ts` are
new and used only by the odds functions.

## Bundling for the dashboard

The dashboard editor takes one `index.ts` per function, so the split sources
are flattened before deployment:

```
python3 tools/collective/bundle_functions.py                  # all
python3 tools/collective/bundle_functions.py collective_odds  # one
python3 tools/collective/bundle_functions.py --check          # is the
                                                              # committed
                                                              # bundle current?
```

Paste `functions/_bundles/<name>.bundle.ts` into the dashboard as `index.ts`.
Never edit a bundle by hand: edit the source and regenerate.

Each bundle's header states whether that function needs **Enforce JWT
verification** on or off. Getting that wrong is the difference between a
public read surface and an open writer:

| Function | Enforce JWT |
| --- | --- |
| `collective_odds` | OFF |
| `collective_odds_ingest` | ON |

## Type checking

Bundling drops module scope, so a top-level name that is fine in a module can
collide with a global once inlined. Both forms are checked:

```
sh tools/collective/typecheck.sh
```

## Secrets

Set in Supabase → Edge Functions → Secrets. Never in this repository.

| Name | Used by | Required |
| --- | --- | --- |
| `NFL_ODDS_API_KEY` | `collective_odds_ingest` (via `_shared/oddsblaze.ts`) | yes, for odds ingestion |
| `NFL_ODDS_BASE_URL` | same | no, defaults to the documented endpoint |
| `COLLECTIVE_BASE_URL` | all | no, defaults to production |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are
injected by the runtime.

See [`docs/collective/odds.md`](../docs/collective/odds.md) for the odds
architecture, refresh schedule, normalization rules and troubleshooting.
