-- portfolio -- part 6 of 9.
-- Run the parts IN ORDER in the Supabase SQL editor. Each part holds a whole
-- number of statements; nothing is cut in the middle. Re-running a part is safe.

-- Classifies every row not yet imported, in a handful of set-based statements
-- (a 5,000-row file in well under a second): the server's own checks, the
-- fingerprint and market of each row, duplicates of what the reader already
-- has — by platform id first, then by fingerprint — and duplicates earlier in
-- the same file. A row with a platform id is never called a duplicate of a
-- record that carries a DIFFERENT platform id: two identical bets with two
-- ticket numbers are two bets.
create or replace function public.portfolio_import_classify(p_import uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare imp public.portfolio_imports;
begin
  select * into imp from public.portfolio_imports where id = p_import for update;
  if not found then raise exception 'portfolio: no such import' using errcode = 'P0002'; end if;
  if imp.status not in ('STAGED', 'CLASSIFIED') then
    raise exception 'portfolio: this import is already %', lower(imp.status) using errcode = '55000';
  end if;
  if (select count(*) from public.portfolio_import_rows where import_id = p_import) > 5000 then
    raise exception 'portfolio: one import holds at most 5000 rows' using errcode = '54000';
  end if;

  /* 1. the server's checks, the fingerprint and the market (stale server issues dropped) */
  update public.portfolio_import_rows r
     set issues = x.client || x.server, fingerprint = x.fp, group_key = x.gk, duplicate_of = null
    from (select ir.id,
                 (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(ir.issues) e where coalesce(e->>'server', '') <> 'true') as client,
                 (select coalesce(jsonb_agg(e || '{"server": "true"}'::jsonb), '[]'::jsonb) from jsonb_array_elements(public.portfolio_import_validate(ir.normalized)) e) as server,
                 case ir.normalized->>'kind'
                   when 'wager' then public.portfolio_sha256(public.portfolio_fp_wager_material(ir.normalized->>'platform', ir.normalized->>'event_name',
                        ir.normalized->>'market_name', ir.normalized->>'selection', public.portfolio_try_numeric(ir.normalized->>'line'),
                        public.portfolio_try_numeric(ir.normalized->>'odds_american')::int,
                        case when nullif(ir.normalized->>'odds_american', '') is null then public.portfolio_try_numeric(ir.normalized->>'odds_decimal') end,
                        public.portfolio_try_numeric(ir.normalized->>'stake'), public.portfolio_try_timestamptz(ir.normalized->>'placed_at')))
                   when 'fill' then public.portfolio_sha256(public.portfolio_fp_fill_material(ir.normalized->>'platform', ir.normalized->>'event_name',
                        ir.normalized->>'market_name', ir.normalized->>'side', upper(ir.normalized->>'action'),
                        public.portfolio_try_numeric(ir.normalized->>'quantity'), public.portfolio_try_numeric(ir.normalized->>'price'),
                        public.portfolio_try_timestamptz(ir.normalized->>'executed_at')))
                 end as fp,
                 case when ir.normalized->>'kind' = 'fill'
                   then public.portfolio_contract_key(ir.normalized->>'platform', ir.normalized->>'event_name', ir.normalized->>'market_name', ir.normalized->>'side') end as gk
            from public.portfolio_import_rows ir where ir.import_id = p_import and ir.outcome is null) x
   where r.id = x.id;

  /* 2. what the reader already has — never what an earlier batch of THIS
     import inserted: those are the file's own rows, and step 3 ranks them, so
     a file classifies the same in one commit call or in twenty.
     Platform id first (and a platform id already used by a record with
     different details is called out: some exports number their rows afresh
     each time) … */
  update public.portfolio_import_rows r set duplicate_of = p.id,
         issues = r.issues || case when p.fingerprint is distinct from r.fingerprint then jsonb_build_array(jsonb_build_object(
           'level', 'warning', 'code', 'EXTERNAL_ID_IN_USE', 'server', 'true',
           'message', 'This id is already in your portfolio on a different bet (' || left(p.event_name, 80) || '). If the file''s ids restart with every export, import it without the id column.'))
           else '[]'::jsonb end
    from public.portfolio_positions p
   where r.import_id = p_import and r.outcome is null and r.normalized->>'kind' = 'wager'
     and p.user_id = imp.user_id and p.platform = r.normalized->>'platform' and p.import_id is distinct from p_import
     and p.external_position_id = nullif(btrim(r.normalized->>'external_position_id'), '');
  update public.portfolio_import_rows r set duplicate_of = t.id,
         issues = r.issues || case when t.fingerprint is distinct from r.fingerprint then jsonb_build_array(jsonb_build_object(
           'level', 'warning', 'code', 'EXTERNAL_ID_IN_USE', 'server', 'true',
           'message', 'This id is already in your portfolio on a different trade. If the file''s ids restart with every export, import it without the id column.'))
           else '[]'::jsonb end
    from public.portfolio_transactions t
   where r.import_id = p_import and r.outcome is null and r.normalized->>'kind' = 'fill'
     and t.user_id = imp.user_id and t.platform = r.normalized->>'platform' and t.import_id is distinct from p_import
     and t.external_transaction_id = nullif(btrim(r.normalized->>'external_transaction_id'), '');
  /* … then the fingerprint */
  update public.portfolio_import_rows r
     set duplicate_of = (select p.id from public.portfolio_positions p
                          where p.user_id = imp.user_id and p.fingerprint = r.fingerprint and p.import_id is distinct from p_import
                            and (nullif(btrim(r.normalized->>'external_position_id'), '') is null or p.external_position_id is null)
                          order by p.dedupe_occurrence limit 1)
   where r.import_id = p_import and r.outcome is null and r.normalized->>'kind' = 'wager' and r.duplicate_of is null and r.fingerprint is not null;
  update public.portfolio_import_rows r
     set duplicate_of = (select t.id from public.portfolio_transactions t
                          where t.user_id = imp.user_id and t.fingerprint = r.fingerprint and t.import_id is distinct from p_import
                            and (nullif(btrim(r.normalized->>'external_transaction_id'), '') is null or t.external_transaction_id is null)
                          order by t.dedupe_occurrence limit 1)
   where r.import_id = p_import and r.outcome is null and r.normalized->>'kind' = 'fill' and r.duplicate_of is null and r.fingerprint is not null;

  /* 3. the classification, with duplicates earlier in the same file found by
     window — over the WHOLE file, rows an earlier batch already imported or
     failed included, so a row's place among its twins never changes between
     commit calls (a failed first copy does not promote its unticked twin) */
  with valid as (
    select ir.id, ir.row_number, ir.fingerprint, ir.normalized->>'platform' as plat,
           nullif(btrim(coalesce(ir.normalized->>'external_position_id', ir.normalized->>'external_transaction_id', '')), '') as ext
      from public.portfolio_import_rows ir
     where ir.import_id = p_import and coalesce(ir.outcome, '') <> 'SKIPPED'
       and not exists (select 1 from jsonb_array_elements(ir.issues) e where e->>'level' = 'error')),
  ranked as (
    select id, ext, row_number() over (partition by plat, ext order by row_number) as n_ext,
           row_number() over (partition by fingerprint order by row_number) as n_fp
      from valid),
  infile as (select id from ranked where (ext is not null and n_ext > 1) or (ext is null and n_fp > 1))
  update public.portfolio_import_rows r set classification = case
      when exists (select 1 from jsonb_array_elements(r.issues) e where e->>'level' = 'error') then 'INVALID'
      -- the same imported bet (same platform id, same details) whose result
      -- the newer file changes: an UPDATE, not a duplicate
      when r.duplicate_of is not null and r.normalized->>'kind' = 'wager' and exists (
             select 1 from public.portfolio_positions p
              where p.id = r.duplicate_of and p.source = 'CSV' and p.fingerprint is not distinct from r.fingerprint
                and nullif(btrim(r.normalized->>'external_position_id'), '') is not null
                and (p.status, coalesce(p.reported_payout, -1), coalesce(p.fees, 0))
                    is distinct from (coalesce(upper(nullif(r.normalized->>'status', '')), 'OPEN'),
                                      coalesce(public.portfolio_try_numeric(r.normalized->>'reported_payout'), case when p.reported_payout is null then -1 else p.reported_payout end),
                                      coalesce(public.portfolio_try_numeric(r.normalized->>'fees'), p.fees, 0))) then 'UPDATE'
      when r.duplicate_of is not null then 'DUPLICATE'
      when r.id in (select id from infile) then 'DUPLICATE_IN_FILE'
      when exists (select 1 from jsonb_array_elements(r.issues) e where e->>'level' = 'warning') then 'NEEDS_REVIEW'
      else 'NEW' end
   where r.import_id = p_import and r.outcome is null;

  update public.portfolio_imports i set status = 'CLASSIFIED', classified_at = coalesce(i.classified_at, now()),
         rows_total = c.total, rows_new = c.n_new, rows_duplicate = c.n_dup, rows_review = c.n_review, rows_invalid = c.n_invalid,
         rows_updated = c.n_upd
    from (select count(*) as total,
                 count(*) filter (where classification = 'NEW') as n_new,
                 count(*) filter (where classification = 'UPDATE') as n_upd,
                 count(*) filter (where classification in ('DUPLICATE', 'DUPLICATE_IN_FILE')) as n_dup,
                 count(*) filter (where classification = 'NEEDS_REVIEW') as n_review,
                 count(*) filter (where classification = 'INVALID') as n_invalid
            from public.portfolio_import_rows where import_id = p_import) c
   where i.id = p_import;
  return (select jsonb_build_object('status', status, 'total', rows_total, 'new', rows_new, 'update', rows_updated, 'duplicate', rows_duplicate,
                 'review', rows_review, 'invalid', rows_invalid) from public.portfolio_imports where id = p_import);
end $$;
