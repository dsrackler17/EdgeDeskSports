# N. Future Expansion Plan

Purpose: what comes after the MVP and how the current design already makes room for it. Nothing here is built in this branch beyond the seams it relies on; each item names the seam so future work is an extension, not a rework. Ordered roughly by likelihood of being next.

---

## 1. Standalone extraction runbook (sketch)

The Collective was built to be liftable (contract decision 1: dedicated `collective` schema, no cross-schema FKs in either direction, auth user ids stored as plain uuids). The extraction, when the project earns its own infrastructure:

1. **Schema dump.** `pg_dump --schema=collective --no-owner` from the current project. Because there are no cross-schema FKs, the dump restores clean into an empty database. Enums, tables, views, RPCs, and seeds all travel in the one schema.
2. **New Supabase project.** Restore the dump, re-run `supabase/functions` deploys against the new project ref, set the same secrets, add `collective` to the new project's exposed schemas with the same zero-grant posture (J-security.md threat 11). Auth: creators re-authenticate by magic link to the same email; the creator row's `user_id` is remapped by email match in a one-time script (the only identity coupling that exists).
3. **DNS.** Point the new domain (for example `modelcollective.com`) at the static host carrying `collective/` as its root.
4. **Config `BASE_URL` change.** Every absolute URL the system emits (profile URLs, subscribe CTAs, invite links, prompt template placeholders) derives from `BASE_URL` in the frontend constants and from config server-side, so the move is a value change, not a search and replace.
5. **Embed src move with a compatibility redirect.** Installed member sites carry `src="https://edgedesksports.com/collective/embed.js"` in their pages and will not all update. Ship the new canonical script at the new domain, and keep a permanent redirect (or a thin loader shim that injects the new script) at the old path. Origin allowlists carry over unchanged because they name the member's origin, not the Collective's. New snippets from the dashboard emit the new src from day one; the old path stays alive until analytics (`embed_events.origin`) show it drained.

Order matters: 1 and 2 can run and be verified against `curl-examples.sh` with an API override before any DNS changes, so the cutover itself is only steps 3 through 5.

## 2. Weighted consensus, as a research model

Rule 8.9 stands: consensus is a deterministic transform, and v1's unweighted mean, median, stddev, range, and agreement never silently changes. Performance-weighted consensus is treated as a research model, which means:

- **Preregistered criteria first.** Before any weighted variant is computed on live data, the weighting scheme, the evaluation metric (for example, Brier of the weighted probability versus the unweighted mean, or MAE of the weighted spread versus close), the sample size, and the acceptance threshold are written down and committed to the repo.
- **Out-of-sample validation.** The weights are fit on one span of graded games and evaluated on a later, untouched span. In-sample improvement is expected and proves nothing.
- **Ships alongside, never replacing.** If it clears the criteria, weighted consensus appears as a separately labeled series (`consensus_v2_weighted` view, provenance-labeled per rule 8.10) next to the deterministic v1, which remains the published default. The grading and ranking pipeline never consumes it. If it fails validation, the result is written up and nothing ships.

The raw material already exists: `first_submissions` and `grades` are append-only and reproducible, so any candidate weighting can be backtested from the tables alone.

## 3. Multi-sport scaling

The schema is multi-sport from day one; adding a sport is seed data plus config:

- **Seeding.** Insert the sport into `sports`, its season window into `sport_seasons`, its teams into `teams`, and generous alias variants into `team_aliases` (the NFL seed in migration 8 is the template: codes, cities, full names, known variants). One forward-only migration per sport.
- **Per-sport coverage thresholds via `ranking.per_sport`.** The config key holds a JSON object keyed by sport code, overriding `ranking.min_coverage_pct` and `ranking.min_graded_games` where a sport's slate structure demands it (an 82-game NBA season and a 17-game NFL season should not share a 20-graded-games floor without thought). The rankings view already reads through this override.
- Everything else generalizes as built: `spread_convention` on `sports` for sports with different line conventions, `games.week` nullable for sports without weeks, models bound to one `sport_code` each so a creator adds a second sport by adding a second model from the dashboard.

## 4. Additional creator tiers

Tiers are per-creator rate overrides, which the schema already supports: `creators.referral_share_bps` is the money number and `billing_mode` the mode, both on the row. A future tier (say 45 percent for creators above some audience size) is an admin action writing a new bps to those rows, exactly as founding terms work today. No enum, no tier table, no code path branches on tier: the ledger reads the row's bps at earn time. If tiers ever need history, add an append-only `share_rate_history` table; nothing else changes.

## 5. Embed v2 ideas

- **Server-rendered static snapshot for no-JS.** A `GET /v1/embed/snapshot?host={slug}` returning cacheable HTML of the free surface (wall and settled results), so hosts can place a real fallback inside `<div id="model-collective">` for no-JS visitors and crawlers, replacing failure state F5's inert behavior. Same payload builder as bootstrap, same identical-render rule, rendered server side.
- **Per-host locale.** A `data-locale` attribute for date, time, and number formatting only. Copy strings move to a small dictionary in `embed.js`. Content, order, and data remain identical per the K-embed.md rules: locale formats numbers, it never selects them.

## 6. Ops: pg_cron

Two maintenance jobs, both idempotent SQL wrapped in SECURITY DEFINER functions using the existing maintenance GUC path:

- **Status recompute.** Membership status is a derived view, so nothing needs recomputing for correctness; the cron job's role is cache warming and cheap materialization if wall traffic ever makes the live view expensive (materialize `model_wall` on a schedule, refresh every few minutes). Deferred until measured.
- **Log pruning.** `api_request_log` only needs a rolling window slightly larger than the rate limit hour; a daily job deletes rows older than 7 days through the maintenance path. Same treatment later for `embed_events` rollups: aggregate to daily counts after 90 days, keep the attribution-relevant touches forever (they are in `attribution_touches`, which is never pruned).

Both are `pg_cron` schedules recorded in a migration when enabled, so the ops surface stays in the repo like everything else.
