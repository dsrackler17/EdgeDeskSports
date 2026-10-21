"""Emit the SQL that records a model-loop version and its backtest result in
the research registry (research_models / research_model_versions /
research_model_results), the way supabase/nfl_market_structure_studies.sql
does: the registry's DDL is not in this repository, so the SQL READS the live
columns and enum labels and maps onto whatever names exist, refusing, by
column name, when a required column has nothing to fill it.

Every version is written as EXPERIMENTAL. A result row carries `passed` as the
preregistered decision computed it; turning a version VALIDATED (and onto the
card) is a person's decision, never this file's. Versions and results are
immutable: a version already registered, or a version that already has a
result, is left exactly as it is and reported.
"""
import json

HELPERS = r"""
create or replace function pg_temp.edr_has(p_rel regclass, p_names text[]) returns text
language sql stable as $f$
  select u.n from unnest(p_names) with ordinality u(n, i)
   where exists (select 1 from pg_attribute a where a.attrelid = p_rel and a.attname = u.n and a.attnum > 0 and not a.attisdropped)
   order by u.i limit 1
$f$;
create or replace function pg_temp.edr_typ(p_rel regclass, p_col text) returns text
language sql stable as $f$
  select format_type(a.atttypid, a.atttypmod) from pg_attribute a where a.attrelid = p_rel and a.attname = p_col and a.attnum > 0 and not a.attisdropped
$f$;
create or replace function pg_temp.edr_label(p_rel regclass, p_col text, p_wanted text[]) returns text
language plpgsql stable as $f$
declare t oid; l text;
begin
  select a.atttypid into t from pg_attribute a where a.attrelid = p_rel and a.attname = p_col and a.attnum > 0;
  if exists (select 1 from pg_type where oid = t and typtype = 'e') then
    select e.enumlabel into l from pg_enum e where e.enumtypid = t and lower(e.enumlabel) = any (p_wanted)
     order by array_position(p_wanted, lower(e.enumlabel)) limit 1;
    if l is null then
      raise exception 'research registry: %.% is an enum with no label for % (its labels: %): nothing was registered', p_rel, p_col, p_wanted[1],
        (select string_agg(enumlabel, ', ' order by enumsortorder) from pg_enum where enumtypid = t);
    end if;
    return l;
  end if;
  return p_wanted[1];
end $f$;
create or replace function pg_temp.edr_val(p_rel regclass, p_col text, p_text text, p_json jsonb, p_range jsonb) returns jsonb
language plpgsql stable as $f$
declare t text := pg_temp.edr_typ(p_rel, p_col);
begin
  if t is null then return null; end if;
  if t like '%range' then return case when p_range is null or jsonb_typeof(p_range) <> 'array' then 'null'::jsonb
    else to_jsonb('[' || (p_range ->> 0) || ',' || (p_range ->> 1) || ')') end; end if;
  if t = 'date' then return case when p_range is null or jsonb_typeof(p_range) <> 'array' then 'null'::jsonb else p_range -> 0 end; end if;
  if t in ('jsonb', 'json') then return coalesce(p_json, to_jsonb(p_text)); end if;
  if t in ('integer', 'bigint', 'smallint', 'numeric', 'double precision', 'real') then
    return case when jsonb_typeof(p_json) = 'number' then p_json else 'null'::jsonb end; end if;
  if t = 'boolean' then return case when jsonb_typeof(p_json) = 'boolean' then p_json else 'null'::jsonb end; end if;
  return to_jsonb(coalesce(p_text, p_json #>> '{}', p_json::text));
end $f$;
create or replace function pg_temp.edr_insert(p_rel regclass, p_vals jsonb, p_ret text) returns text
language plpgsql as $f$
declare cols text; missing text; out_ text;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(p_vals) k;
  select string_agg(a.attname::text, ', ') into missing from pg_attribute a
   where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped and a.attnotnull and not a.atthasdef
     and a.attidentity = '' and a.attgenerated = '' and not (p_vals ? a.attname::text);
  if missing is not null then
    raise exception 'research registry: % requires % and this file has nothing to put there: nothing was registered (map it in model_loop/core/registry_sql.py)', p_rel, missing;
  end if;
  execute format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) returning %I::text', p_rel, cols, cols, p_rel, p_ret) into out_ using p_vals;
  return out_;
end $f$;
"""

BODY = r"""
begin;

do $reg$
declare
  S jsonb := $mlreg${payload}$mlreg$::jsonb;
  m regclass := 'public.research_models';
  v regclass := 'public.research_model_versions';
  r regclass := to_regclass('public.research_model_results');
  mv jsonb; vv jsonb; rv jsonb; ver jsonb;
  kcol text; ncol text; refcol text; fkcol text; vcol text; vid text; c text; ref text; vref text; have boolean;
  rfk text; rref text; rto regclass; rvcol text;
  n_versions int := 0; n_results int := 0; kept int := 0;
begin
  kcol := pg_temp.edr_has(m, array['model_key', 'key', 'model_name', 'model', 'slug', 'code', 'name']);
  if kcol is null then raise exception 'research registry: research_models has no key column: nothing was registered'; end if;
  select a.attname::text, ra.attname::text into fkcol, refcol
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
   where k.contype = 'f' and k.conrelid = v and k.confrelid = m limit 1;
  if fkcol is null then
    fkcol := pg_temp.edr_has(v, array['model_key', 'model_id', 'research_model_id', 'model']);
    refcol := case when fkcol in ('model_id', 'research_model_id') then pg_temp.edr_has(m, array['id', 'model_id']) else kcol end;
  end if;
  if fkcol is null or refcol is null then raise exception 'research registry: cannot tell how research_model_versions points at research_models: nothing was registered'; end if;
  vcol := pg_temp.edr_has(v, array['version', 'model_version', 'version_label', 'semver', 'label']);
  vid := pg_temp.edr_has(v, array['id', 'version_id', 'model_version_id']);

  -- the model row
  execute format('select %I::text from %s where %I::text = $1 limit 1', refcol, m, kcol) into ref using S ->> 'model_key';
  if ref is null then
    mv := jsonb_build_object(kcol, S ->> 'model_key');
    ncol := pg_temp.edr_has(m, array['name', 'title', 'display_name', 'label']);
    if ncol is not null and ncol <> kcol then mv := mv || jsonb_build_object(ncol, S ->> 'title'); end if;
    c := pg_temp.edr_has(m, array['sport', 'league']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'sport'); end if;
    c := pg_temp.edr_has(m, array['status', 'model_status', 'maturity']); if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['experimental'])); end if;
    c := pg_temp.edr_has(m, array['provenance', 'evidence_provenance', 'tier', 'evidence_tier']);
    if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['t3', 'research_model', 'research', 'model'])); end if;
    c := pg_temp.edr_has(m, array['objective', 'goal']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['description', 'summary']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['family', 'category', 'module', 'domain']); if c is not null then mv := mv || jsonb_build_object(c, 'model_loop'); end if;
    ref := pg_temp.edr_insert(m, mv, refcol);
  end if;

  for ver in select * from jsonb_array_elements(S -> 'versions') loop
    -- the version row (immutable: an existing version is left as it is)
    if vcol is not null then
      execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', v, fkcol, vcol) into have using ref, ver ->> 'version';
    else
      have := false;
    end if;
    if have then
      kept := kept + 1;
    else
      vv := jsonb_build_object(fkcol, ref);
      if vcol is not null then vv := vv || jsonb_build_object(vcol, ver ->> 'version'); end if;
      c := pg_temp.edr_has(v, array['status', 'model_status', 'maturity']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_label(v, c, array['experimental'])); end if;
      c := pg_temp.edr_has(v, array['provenance', 'evidence_provenance', 'tier']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_label(v, c, array['t3', 'research_model', 'research', 'model'])); end if;
      c := pg_temp.edr_has(v, array['training_window', 'train_window', 'training_period', 'training']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, ver ->> 'training_text', ver -> 'training', ver -> 'training_dates')); end if;
      c := pg_temp.edr_has(v, array['validation_window', 'valid_window', 'validation_period', 'validation']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, ver ->> 'validation_text', ver -> 'validation', ver -> 'validation_dates')); end if;
      c := pg_temp.edr_has(v, array['holdout_window', 'holdout_period', 'holdout', 'test_window']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, ver ->> 'holdout_text', ver -> 'holdout', ver -> 'holdout_dates')); end if;
      c := pg_temp.edr_has(v, array['objective', 'goal']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'objective', null, null)); end if;
      c := pg_temp.edr_has(v, array['success_metric', 'primary_metric', 'metric']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'primary_metric', null, null)); end if;
      c := pg_temp.edr_has(v, array['promotion_criteria', 'decision_rule', 'criteria', 'success_criteria']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'decision_rule', jsonb_build_object('decision_rule', S -> 'decision_rule'), null)); end if;
      c := pg_temp.edr_has(v, array['forking_paths', 'forking_paths_disclosure', 'disclosure', 'garden_of_forking_paths']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, S -> 'forking_paths', null)); end if;
      c := pg_temp.edr_has(v, array['spec', 'metadata', 'meta', 'params', 'config', 'details', 'definition', 'protocol']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, ver -> 'spec', null)); end if;
      c := pg_temp.edr_has(v, array['notes', 'description']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, ver ->> 'notes', null, null)); end if;
      perform pg_temp.edr_insert(v, vv, fkcol);
      n_versions := n_versions + 1;
    end if;

    -- the result row, if this version has one and the results table exists
    continue when r is null or ver -> 'result' is null;
    select a.attname::text, ra.attname::text, k.confrelid::regclass into rfk, rref, rto
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
     where k.contype = 'f' and k.conrelid = r and k.confrelid in (v, m)
     order by (k.confrelid = v) desc limit 1;
    if rfk is null then raise exception 'research registry: cannot tell how research_model_results points at a version or a model: no result written'; end if;
    if rto = v then
      execute format('select %I::text from %s where %I::text = $1 and %s limit 1', rref, v, fkcol,
                     case when vcol is not null then format('%I::text = $2', vcol) else 'true' end) into vref using ref, ver ->> 'version';
    else
      vref := ref;
    end if;
    rvcol := case when rto = m then pg_temp.edr_has(r, array['version', 'model_version', 'version_label']) else null end;
    if rvcol is not null then
      execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', r, rfk, rvcol) into have using vref, ver ->> 'version';
    else
      execute format('select exists (select 1 from %s where %I::text = $1)', r, rfk) into have using vref;
    end if;
    continue when have;
    rv := jsonb_build_object(rfk, vref);
    if rvcol is not null then rv := rv || jsonb_build_object(rvcol, ver ->> 'version'); end if;
    c := pg_temp.edr_has(r, array['passed', 'pass', 'is_passed']); if c is not null then rv := rv || jsonb_build_object(c, ver -> 'result' -> 'passed'); end if;
    c := pg_temp.edr_has(r, array['metrics', 'results', 'result', 'summary', 'report', 'details', 'payload']);
    if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(r, c, null, ver -> 'result', null)); end if;
    c := pg_temp.edr_has(r, array['metric_value', 'score', 'value', 'holdout_metric']);
    if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(r, c, null, ver -> 'result' -> 'holdout' -> 'margin_mae', null)); end if;
    c := pg_temp.edr_has(r, array['n', 'sample_size', 'n_obs', 'n_games']);
    if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(r, c, null, ver -> 'result' -> 'holdout' -> 'n', null)); end if;
    c := pg_temp.edr_has(r, array['evaluated_at', 'computed_at', 'run_at']);
    if c is not null then rv := rv || jsonb_build_object(c, to_jsonb(S ->> 'generated_at')); end if;
    c := pg_temp.edr_has(r, array['window', 'holdout_window', 'evaluation_window', 'eval_window']);
    if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(r, c, ver ->> 'holdout_text', ver -> 'holdout', ver -> 'holdout_dates')); end if;
    c := pg_temp.edr_has(r, array['notes', 'description', 'comment']);
    if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(r, c, ver -> 'result' ->> 'note', null, null)); end if;
    perform pg_temp.edr_insert(r, rv, rfk);
    n_results := n_results + 1;
  end loop;
  raise notice 'research registry (%): % version row(s) and % result row(s) written; % version(s) already registered and left as they are',
    S ->> 'model_key', n_versions, n_results, kept;
end $reg$;

commit;

select '{model_key} registered' as piece,
       case when to_regclass('public.research_model_current') is null then 'CHECK THIS: research_model_current is not in this database'
            else 'ok (every version EXPERIMENTAL; a person promotes)' end as state;
"""


def emit(payload, title_comment):
    blob = json.dumps(payload, sort_keys=True)
    if "$mlreg$" in blob:
        raise ValueError("payload contains the dollar-quote tag")
    head = ("-- =============================================================================\n"
            + "".join("-- " + l + "\n" for l in title_comment.strip().splitlines())
            + "--\n-- GENERATED by model_loop/core/registry_sql.py. Do not edit by hand.\n"
            + "-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL\n"
            + "-- editor, no psql meta-commands, ends in a report. Safe to run again.\n"
            + "-- =============================================================================\n\n"
            + "do $req$ begin\n  if to_regclass('public.research_models') is null or to_regclass('public.research_model_versions') is null then\n"
            + "    raise exception 'the research registry is not in this database: nothing was registered';\n  end if;\nend $req$;\n")
    return head + HELPERS + BODY.replace("{payload}", blob).replace("{model_key}", payload["model_key"])
