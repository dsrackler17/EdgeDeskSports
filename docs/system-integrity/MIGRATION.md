# Rolling out, verifying and rolling back

**Nothing in this change has been applied to production.** The production
Supabase project is not reachable from the environment where this was built
(the proxy answers 403). Every step below is the owner's to run, in this order.

## What changes where

| Layer | What | How it ships |
|---|---|---|
| Database | `supabase/content_engine.sql`, section **6c** plus edits to existing functions. Additive: new columns, tables and functions; widened constraints; stricter guards. **No column or table is dropped.** | re-paste the whole file in the Supabase SQL editor (idempotent, like every earlier content-engine change) |
| Edge Function | `supabase/functions/content_engine/index.ts` reserves and settles every Claude call, and carries the integrity layer verbatim | `.github/workflows/deploy-content-engine.yml` (manual, deploys from `main`), **after** the SQL and the merge |
| Site | `lib/edgedesk_{calc,schedule,availability,integrity}.js` (new); `app.html`, `research/cfb/`, `admin/content/` | GitHub Pages on merge |
| Artifacts | the CFB terminal (`board.json`, `games.json`, `brief.json`) and `football/fbs/slate.json` gain additive fields (`DATA_CONTRACT.md` §6) | the existing hourly build regenerates them after merge. Nothing regenerated is committed here. |
| Validation | `football/cfb_validation/versions.jsonl` gets two declared PATCH rows (pricing: the slate's kickoff fields; research: display consistency) | append-only, in this commit |
| CI | `.github/workflows/system-integrity-tests.yml` (new, read-only); `content-engine.yml` path filters | on merge |

## 1. Before (read-only)

Run these in the SQL editor:

```sql
-- articles a stricter guard will hold until they are re-checked
select status, count(*) filter (where checks ? 'integrity_status') as with_verdict,
       count(*) filter (where not (checks ? 'integrity_status')) as without_verdict
  from content_engine.articles where status in ('approved', 'ready_to_send') group by status;
-- the content engine's AI calls today (the daily counter)
select * from content_engine.usage order by day desc limit 7;
```

**Expected effect.** An article approved or marked ready *before* this change
has no stored integrity verdict, so it **cannot move to Ready to Send or Sent**
until the owner:

1. opens it in the editor;
2. presses **Check**, then **Save**;
3. sends it through review again.

This fails closed on purpose: unknown is never PASS. If the first query returns
rows you need to send today, send them before applying.

## 2. Apply (in this order, close together)

1. **SQL.** Paste `supabase/content_engine.sql` into the SQL editor and run it.
   The last result set is the report. Every row must read `ok`, including:
   - `AI budget: a monthly dollar cap, reserved before every call` → `$10.00 a month`;
   - `approval binds the research; integrity verdict required`.
2. **Merge** the pull request. Pages publishes the site, including the new
   `/admin/content/` page and the integrity libraries. The next hourly build
   writes the new artifact fields.
   - Between steps 1 and 2, the old page still validates without the integrity
     engine, so the new approval door refuses its drafts (`integrity_blocked`).
     Nothing breaks, but nothing can be approved until the merge.
3. **Edge Function.** Run *Deploy content engine* (Actions → workflow dispatch).
   It deploys from `main`, so it needs the merge first, and it refuses to
   deploy unless the inlined copy, the core and both SQL suites pass.
   - Until it is deployed, the old function still rewrites drafts. It makes no
     reservation, so those calls are counted only by the daily call limit, not
     against the $10 cap.
   - Deploy it promptly, or leave AI rewrites unused until it is deployed.

## 3. Verify (read-only)

| Check | How |
|---|---|
| The board reconciles | `node tools/integrity/audit.js` on the freshly built artifacts. It should show 0 canonical mismatches in gaps and score lines, and 0 future-week games in the brief. |
| Kickoffs | the board header shows "kickoff TBA" with a count; week-7 placeholders read "time TBA" with a "WK 7" badge |
| The content engine | `/admin/content/` → Discover. The message names the games the integrity engine withheld; a draft shows `integrity: PASS` or `integrity: WARNING` |
| The budget | Settings → AI spend shows the $10.00 cap. The first AI rewrite shows one call settled at its measured cost. |
| Regression | `npm run integrity:test` (the 17 cases + integration), `npm run content:all` |

## 4. Roll back

**Non-destructive (recommended).** Restore the previous code. The new objects
stay in place, unused, and no data is lost.

```bash
# the previous database functions (create or replace: they overwrite the new bodies)
git show 8c46beaf:supabase/content_engine.sql > /tmp/content_engine_prev.sql   # paste it in the SQL editor
# the previous Edge Function
git revert <this merge>        # then run "Deploy content engine"
```

After a rollback:

- `approved_research_hash`, `ai_months`, `ai_spend` and the settings columns
  remain and are ignored by the old functions;
- the widened status, format and kind constraints remain, and accept every
  old value;
- an article left in `rejected` can no longer be moved by the old matrix;
  archive it with a direct, owner-run `update` if needed.

**Destructive cleanup (only with explicit approval; it deletes the AI spend history):**

```sql
-- NOT part of the rollout. Run only if the owner decides the spend history is not needed.
drop function if exists public.content_engine_ai_reserve(text, numeric, text, uuid, text, bigint);
drop function if exists public.content_engine_ai_settle(text, boolean, int, int, numeric, text, int, int);
drop function if exists public.content_engine_cost_report();
drop function if exists public.content_engine_budget_update(jsonb);
drop function if exists public.content_engine_acquisition_report(int);
drop table if exists content_engine.ai_spend;
drop table if exists content_engine.ai_months;
alter table content_engine.settings drop constraint if exists settings_ai_budget_shape;
alter table content_engine.settings drop column if exists monthly_budget_usd, drop column if exists job_budget_usd, drop column if exists ai_max_attempts;
alter table content_engine.articles drop column if exists approved_research_hash;
```

**Artifacts** are additive. A reverted commit is followed by the hourly build,
which writes the old shape again. Readers of the artifacts ignore unknown
fields, so no consumer breaks either way.
