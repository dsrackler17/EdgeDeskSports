-- ===========================================================================
-- BRIEF RECORD — the closing line and result behind every published brief.
--
-- Paste into the Supabase SQL editor and run. Safe to run again.
--
-- WHY A VIEW
--   signals is the live board and is RLS-protected: the anon key reads []
--   from it, by design. A published brief is graded after kickoff against
--   the selection's own closing fair line and the result the close pipeline
--   wrote, and that grading runs keyless (tools/record/grade_briefs.js, in a
--   scheduled GitHub Action, with the same anon key every page ships).
--
--   This view is the narrow door for that: it runs as its owner, bypasses
--   the signals RLS on purpose, and admits ONLY rows whose game has already
--   kicked off. A live price never leaves through it. That is the same
--   boundary public_record already draws for the public CLV page, drawn one
--   more time for the same reason: the paywall is the live board, not the
--   history.
--
-- WHAT IT CARRIES
--   The identity of the selection (event, market, side, line), the closing
--   fair line (closing_sharp_fair, from the close pipeline), the last best
--   board price capture wrote before kickoff (best_dec / best_book), and the
--   graded result. Nothing derived, nothing edited.
-- ===========================================================================

begin;

create or replace view public.public_brief_closes as
  select
    s.sig_key,
    s.event_id,
    s.sport_key,
    s.sport_title,
    s.market,
    s.selection,
    s.point,
    s.home_team,
    s.away_team,
    s.commence_time,
    s.best_dec,
    s.best_book,
    s.closing_sharp_fair,
    s.closed_at,
    s.result,
    s.beat_close,
    s.clv,
    s.graded_at
  from public.signals s
  where s.commence_time is not null
    and s.commence_time <= now();

-- Owner-run on purpose (see above). Postgres 15+ views default to
-- security_definer semantics unless security_invoker is set; say so
-- explicitly so a future default change cannot silently close the door.
alter view public.public_brief_closes set (security_invoker = false);

grant select on public.public_brief_closes to anon, authenticated;

commit;

-- Report: both rows should say ok.
select '1 view' as step,
  case when to_regclass('public.public_brief_closes') is not null then 'ok' else 'MISSING' end as outcome
union all
select '2 anon can read',
  case when has_table_privilege('anon', 'public.public_brief_closes', 'select') then 'ok' else 'NO GRANT' end;
