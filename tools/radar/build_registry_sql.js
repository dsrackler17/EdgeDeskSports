#!/usr/bin/env node
/* ===========================================================================
   Generate supabase/radar_registry.sql from
     research/radar/registration_h_radar_01.json   H-RADAR-01 v0.1.0
     research/radar/H-RADAR-01/report.json         its validation report, once it exists
     research/radar/registration_h_radar_02.json   H-RADAR-02 v0.2.0 (registered 2026-10-30)
   It registers each hypothesis EXPERIMENTAL in the research registry with its
   objective, holdout window, minimum sample, metrics, promotion criteria and
   forking-paths disclosure, BEFORE anything is shown; writes a report's
   verdict as ONE research_model_results row once its holdout has run
   (passed = the report's own verdict, good or bad); and names each version in
   public.radar_config (registry_ref:<hypothesis>). Every Radar reader door
   requires the live rules' hypothesis (radar_hypothesis()) to be named there:
   no registration, nothing shown.

   The registry's DDL is not in this repository, so the SQL reads the live
   columns and enum labels (the session helpers supabase/
   nfl_market_structure_studies.sql carries, verbatim) and refuses by column
   name rather than guess. Promotion is a person's act: a passing result does
   not change the status from EXPERIMENTAL.

     node tools/radar/build_registry_sql.js          write
     node tools/radar/build_registry_sql.js --check  fail if stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = 'research/radar/registration_h_radar_01.json';
const REPORT = 'research/radar/H-RADAR-01/report.json';
const OUT = path.join(ROOT, 'supabase', 'radar_registry.sql');
/* every registration this file writes, oldest first; a report (and its result row) exists only for a holdout that has run */
const REGS = [
  { id: 'H-RADAR-01', source: SOURCE, report: REPORT, resultKey: 'h_radar_01_result' },
  { id: 'H-RADAR-02', source: 'research/radar/registration_h_radar_02.json', report: null, resultKey: null }
];

/* the session helpers, as the NFL studies file carries them */
function helpers() {
  const f = fs.readFileSync(path.join(ROOT, 'supabase', 'nfl_market_structure_studies.sql'), 'utf8');
  const a = f.indexOf('-- helpers for this session only'), b = f.indexOf('\nbegin;', a);
  if (a < 0 || b < 0) throw new Error('supabase/nfl_market_structure_studies.sql: the registry helpers were not found');
  return f.slice(a, b).replace('map it in tools/football/build_prereg_sql.js', 'map it in tools/radar/build_registry_sql.js').trim();
}

function load(src) {
  src = src || REGS[0];
  const raw = fs.readFileSync(path.join(ROOT, src.source), 'utf8');
  const R = JSON.parse(raw);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (R.result !== null) throw new Error(src.source + ' carries a result: a registration is written before any result');
  if (R.status !== 'EXPERIMENTAL') throw new Error(src.source + ': a registration starts EXPERIMENTAL');
  if (R.model_key !== src.id || !R.registered_at || !R.version) throw new Error(src.source + ': not a registration of ' + src.id + ' (model_key, registered_at and version are required)');
  return { R, sha, raw };
}

/* the verdict the registry and the pages carry: the report's own, or "not run"; none for a hypothesis with no report */
function verdict(reg, src) {
  src = src || REGS[0];
  if (!src.report) return { summary: null, result: null };
  const REPORT = src.report;
  const file = path.join(ROOT, REPORT);
  if (!fs.existsSync(file)) {
    return { summary: { status: 'not_run', hypothesis_id: src.id, version: reg.R.version, registration_sha256: reg.sha,
      note: 'The holdout test has not run yet. Nothing is claimed about following until it has.' }, result: null };
  }
  const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (rep.registration_sha256 !== reg.sha) throw new Error(REPORT + ' was run against a different registration (' + rep.registration_sha256 + ', not ' + reg.sha + ')');
  const h = rep.holdout || {};
  const summary = {
    status: rep.status, hypothesis_id: src.id, version: reg.R.version, registration_sha256: reg.sha, report: REPORT, run: rep.run || null,
    passed: rep.status === 'complete' ? !!h.passed : null,
    followed: h.followed ?? null, games: h.games ?? null,
    beat_close_rate: h.beat_close ? h.beat_close.rate : null, beat_close_ci: h.beat_close ? [h.beat_close.lo, h.beat_close.hi] : null,
    follow_roi: h.follow_roi ? h.follow_roi.mean : null, follow_roi_ci: h.follow_roi ? [h.follow_roi.lo, h.follow_roi.hi] : null,
    criteria: h.criteria || null, point_estimates_support_hypothesis: h.point_estimates_support_hypothesis ?? null,
    note: rep.headline || null
  };
  return {
    summary,
    result: rep.status === 'complete' ? { passed: !!h.passed, metrics: Object.assign({ verdict: h.passed ? 'PASSED' : 'FAILED' }, summary, { secondary: h.secondary || null, excluded: h.excluded || null }),
      notes: (h.passed ? 'PASSED' : 'FAILED') + ' on the registered holdout (' + REPORT + '). Status stays EXPERIMENTAL: a person promotes, through a validation report.' } : null
  };
}

/* one registration's DO block: the model, the version, the result (when its report exists) and the link the doors need */
function block(x) {
  return `do $reg$
declare
  S jsonb := $rdreg$${x.payload}$rdreg$::jsonb;
  SUM jsonb := ${x.summary ? '$rdreg$' + x.summary + '$rdreg$::jsonb' : 'null'};
  RES jsonb := ${x.result ? '$rdreg$' + x.result + '$rdreg$::jsonb' : 'null'};
  m regclass := 'public.research_models';
  v regclass := 'public.research_model_versions';
  rs regclass := to_regclass('public.research_model_results');
  mv jsonb; vv jsonb; rv jsonb; mach jsonb := S -> 'machine';
  kcol text; ncol text; refcol text; fkcol text; vcol text; vid text; c text; ref text; vref text; have boolean;
  rfk text; rref text; rmcol text; rvcol text; pcol text; mcol text; rvid text;
  pairs text[][] := array[
    array['training_window', 'train_window', 'training_period', 'training'],
    array['validation_window', 'valid_window', 'validation_period', 'validation'],
    array['holdout_window', 'holdout_period', 'holdout', 'test_window']];
  wkeys text[] := array['training', 'validation', 'holdout'];
  i int;
begin
  kcol := pg_temp.edr_has(m, array['model_key', 'key', 'model_name', 'model', 'slug', 'code', 'name']);
  if kcol is null then raise exception 'research registry: research_models has no key column (model_key, key, model_name, model, slug, code or name) — nothing was registered'; end if;
  select a.attname::text, ra.attname::text into fkcol, refcol
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
   where k.contype = 'f' and k.conrelid = v and k.confrelid = m limit 1;
  if fkcol is null then
    fkcol := pg_temp.edr_has(v, array['model_key', 'model_id', 'research_model_id', 'model']);
    refcol := case when fkcol in ('model_id', 'research_model_id') then pg_temp.edr_has(m, array['id', 'model_id']) else kcol end;
  end if;
  if fkcol is null or refcol is null then raise exception 'research registry: cannot tell how research_model_versions points at research_models — nothing was registered'; end if;
  vcol := pg_temp.edr_has(v, array['version', 'model_version', 'version_label', 'semver', 'label']);
  vid := pg_temp.edr_has(v, array['id', 'version_id', 'model_version_id']);

  execute format('select %I::text from %s where %I::text = $1 limit 1', refcol, m, kcol) into ref using S ->> 'model_key';
  if ref is null then
    mv := jsonb_build_object(kcol, S ->> 'model_key');
    ncol := pg_temp.edr_has(m, array['name', 'title', 'display_name', 'label']);
    if ncol is not null and ncol <> kcol then mv := mv || jsonb_build_object(ncol, S ->> 'name'); end if;
    foreach c in array array['title', 'display_name'] loop
      if c <> kcol and pg_temp.edr_has(m, array[c]) is not null and not (mv ? c) then mv := mv || jsonb_build_object(c, S ->> 'name'); end if;
    end loop;
    c := pg_temp.edr_has(m, array['sport', 'league']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'sport'); end if;
    c := pg_temp.edr_has(m, array['status', 'model_status', 'maturity']); if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['experimental'])); end if;
    c := pg_temp.edr_has(m, array['provenance', 'evidence_provenance', 'tier', 'evidence_tier']);
    if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['t3', 'research_model', 'research', 'model'])); end if;
    c := pg_temp.edr_has(m, array['objective', 'goal']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['hypothesis']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'hypothesis'); end if;
    c := pg_temp.edr_has(m, array['description', 'summary']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'hypothesis'); end if;
    c := pg_temp.edr_has(m, array['family', 'category', 'module', 'domain']); if c is not null then mv := mv || jsonb_build_object(c, 'prediction_radar'); end if;
    c := pg_temp.edr_has(m, array['owner', 'created_by', 'registered_by']); if c is not null then mv := mv || jsonb_build_object(c, (S ->> 'registered_at') || ' preregistration (EdgeDesk research)'); end if;
    c := pg_temp.edr_has(m, array['metadata', 'meta', 'spec', 'details', 'config']);
    if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_val(m, c, null, S, null)); end if;
    ref := pg_temp.edr_insert(m, mv, refcol);
    raise notice 'research registry: % registered', S ->> 'model_key';
  else
    raise notice 'research registry: % was already registered and is left as it is', S ->> 'model_key';
  end if;

  if vcol is not null then
    execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', v, fkcol, vcol) into have using ref, S ->> 'version';
  else
    execute format('select exists (select 1 from %s where %I::text = $1)', v, fkcol) into have using ref;
  end if;
  if not have then
    vv := jsonb_build_object(fkcol, ref);
    if vcol is not null then vv := vv || jsonb_build_object(vcol, S ->> 'version'); end if;
    c := pg_temp.edr_has(v, array['status', 'model_status', 'maturity']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_label(v, c, array['experimental'])); end if;
    c := pg_temp.edr_has(v, array['provenance', 'evidence_provenance', 'tier']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_label(v, c, array['t3', 'research_model', 'research', 'model'])); end if;
    for i in 1 .. 3 loop
      c := pg_temp.edr_has(v, pairs[i:i][1:4]::text[]);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> (wkeys[i] || '_window'),
        jsonb_build_object('from', mach -> 'window_dates' -> wkeys[i] -> 0, 'to', mach -> 'window_dates' -> wkeys[i] -> 1, 'description', S ->> (wkeys[i] || '_window')),
        mach -> 'window_dates' -> wkeys[i])); end if;
    end loop;
    c := pg_temp.edr_has(v, array['objective', 'goal']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'objective', null, null)); end if;
    c := pg_temp.edr_has(v, array['hypothesis']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'hypothesis', null, null)); end if;
    c := pg_temp.edr_has(v, array['min_sample', 'minimum_sample', 'min_n', 'sample_target']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, (S -> 'minimum_sample')::text,
      case when pg_temp.edr_typ(v, c) in ('jsonb', 'json') then S -> 'minimum_sample' else mach -> 'minimum_sample' end, null)); end if;
    c := pg_temp.edr_has(v, array['success_metric', 'primary_metric', 'metric']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'primary_metric', null, null)); end if;
    c := pg_temp.edr_has(v, array['promotion_criteria', 'decision_rule', 'criteria', 'success_criteria']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S -> 'promotion_criteria' ->> 'decision_rule', S -> 'promotion_criteria', null)); end if;
    c := pg_temp.edr_has(v, array['forking_paths', 'forking_paths_disclosure', 'disclosure', 'garden_of_forking_paths']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, S -> 'forking_paths', null)); end if;
    c := pg_temp.edr_has(v, array['spec', 'metadata', 'meta', 'params', 'config', 'details', 'definition', 'protocol']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, S -> 'spec' || jsonb_build_object('content_sha256', S ->> 'content_sha256', 'registration', '${x.src.source}'), null)); end if;
    c := pg_temp.edr_has(v, array['notes', 'description']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c,
      'Preregistered ' || (S ->> 'registered_at') || ': ${x.src.source} sha256 ' || (S ->> 'content_sha256') || '. The result is the validation report''s, never edited.', null, null)); end if;
    perform pg_temp.edr_insert(v, vv, fkcol);
  end if;

  if vid is not null and vcol is not null then
    execute format('select %I::text from %s where %I::text = $1 and %I::text = $2 limit 1', vid, v, fkcol, vcol) into vref using ref, S ->> 'version';
  end if;
  vref := coalesce(vref, ref || ':' || (S ->> 'version'));

  -- THE RESULT: the report's verdict, once
  if RES is not null and rs is not null then
    select a.attname::text, ra.attname::text into rfk, rref
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
     where k.contype = 'f' and k.conrelid = rs and k.confrelid = v limit 1;
    if rfk is null then
      rfk := pg_temp.edr_has(rs, array['version_id', 'model_version_id', 'research_model_version_id']);
      if rfk is not null then rref := pg_temp.edr_has(v, array['id', 'version_id']); end if;
    end if;
    if rfk is null then
      rmcol := pg_temp.edr_has(rs, array['model_key', 'model', 'key', 'model_name']);
      rvcol := pg_temp.edr_has(rs, array['model_version', 'version', 'version_label']);
      if rmcol is null or rvcol is null then raise exception 'research registry: cannot tell how research_model_results points at a version — nothing was registered'; end if;
      execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', rs, rmcol, rvcol) into have using ref, S ->> 'version';
      rv := jsonb_build_object(rmcol, ref, rvcol, S ->> 'version');
    else
      execute format('select %I::text from %s where %I::text = $1 and %I::text = $2 limit 1', rref, v, fkcol, vcol) into rvid using ref, S ->> 'version';
      if rvid is null then raise exception 'research registry: no version % of % to attach the result to', S ->> 'version', S ->> 'model_key'; end if;
      execute format('select exists (select 1 from %s where %I::text = $1)', rs, rfk) into have using rvid;
      rv := jsonb_build_object(rfk, rvid);
    end if;
    if not have then
      pcol := pg_temp.edr_has(rs, array['passed', 'pass', 'is_passed', 'success']);
      mcol := pg_temp.edr_has(rs, array['metrics', 'results', 'result', 'holdout_result', 'details', 'payload', 'data']);
      if pcol is not null then rv := rv || jsonb_build_object(pcol, pg_temp.edr_val(rs, pcol, null, RES -> 'passed', null)); end if;
      if mcol is not null then rv := rv || jsonb_build_object(mcol, pg_temp.edr_val(rs, mcol, null, RES -> 'metrics', null)); end if;
      c := pg_temp.edr_has(rs, array['notes', 'summary', 'verdict', 'reason']); if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(rs, c, RES ->> 'notes', null, null)); end if;
      -- the sample the verdict stands on, from the report: production requires games_tested
      c := pg_temp.edr_has(rs, array['games_tested', 'n_games', 'holdout_games', 'games']); if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(rs, c, null, RES -> 'metrics' -> 'games', null)); end if;
      c := pg_temp.edr_has(rs, array['bets_tested', 'n_bets', 'n_followed', 'sample_size']); if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(rs, c, null, RES -> 'metrics' -> 'followed', null)); end if;
      perform pg_temp.edr_insert(rs, rv, coalesce(rfk, rmcol));
      raise notice 'research registry: the ${x.src.id} result was written (passed = %)', RES ->> 'passed';
    end if;
  end if;

  insert into public.radar_config (key, value, note) values
    ('registry_ref:' || (S ->> 'model_key'), vref, 'research_model_versions row (as text) the Radar reader doors require; written only by supabase/radar_registry.sql'),
    ('registry_sha256:' || (S ->> 'model_key'), S ->> 'content_sha256', '${x.src.source}')${x.src.resultKey ? `,
    ('${x.src.resultKey}', SUM::text, 'what the registered holdout test found, verbatim from ${x.src.report} (or not_run); written only by supabase/radar_registry.sql')` : ''}
  on conflict (key) do update set value = excluded.value, note = excluded.note, updated_at = now()
    where public.radar_config.value is distinct from excluded.value;
end $reg$;
`;
}

function build() {
  const regs = REGS.map((src) => {
    const reg = load(src);
    const v = verdict(reg, src);
    const x = { src, reg, v, payload: JSON.stringify(Object.assign({}, reg.R, { content_sha256: reg.sha })),
      summary: v.summary ? JSON.stringify(v.summary) : null, result: v.result ? JSON.stringify(v.result) : null };
    [x.payload, x.summary || '', x.result || ''].forEach((p) => { if (p.indexOf('$rdreg$') >= 0) throw new Error('the payload contains the dollar-quote tag'); });
    return x;
  });
  const [h1, h2] = regs, v = h1.v;
  return `-- =============================================================================
-- radar_registry.sql — register H-RADAR-01 and H-RADAR-02 (Prediction Radar) as
-- EXPERIMENTAL in the research registry, BEFORE anything is shown.
-- docs/prediction-radar.md.
--
-- GENERATED by tools/radar/build_registry_sql.js from
--   ${h1.src.source}
--     H-RADAR-01 v${h1.reg.R.version}, content sha256 ${h1.reg.sha}
--   ${h1.src.report} (${v.result ? 'the validation report: ' + (v.result.passed ? 'PASSED' : 'FAILED') : v.summary.status === 'not_run' ? 'absent: the holdout has not run' : 'status ' + v.summary.status})
--   ${h2.src.source}
--     H-RADAR-02 v${h2.reg.R.version}, registered ${h2.reg.R.registered_at}, content sha256 ${h2.reg.sha}
--     (its prospective window: ${h2.reg.R.machine.window_dates.holdout.join(' to ')}, [from, to) UTC; no report yet)
-- Do not edit by hand.
--
-- WHAT IT DOES. For each hypothesis, one research_models row (EXPERIMENTAL,
-- provenance T3) and one research_model_versions row carrying the objective,
-- the holdout window, the minimum sample, the primary metrics, the promotion
-- criteria, the forking-paths disclosure and the full specification, in
-- whatever form the live columns take.${v.result ? `
-- Then ONE research_model_results row for H-RADAR-01: its report's verdict
-- (passed = ${v.result.passed}), written once and never changed.` : ''}
-- Then each version row is named in public.radar_config (registry_ref:
-- H-RADAR-01, registry_ref:H-RADAR-02), with what H-RADAR-01's test found
-- (h_radar_01_result). Every Radar reader door refuses to show anything
-- without the link for the live rules' hypothesis (radar_hypothesis()), and the
-- record shows H-RADAR-01's finding verbatim.
--
-- WHAT IT DOES NOT DO. No change to a registered row. No promotion: the status
-- stays EXPERIMENTAL whatever the result says. A person promotes, through a
-- validation report.
--
-- REQUIRES supabase/radar.sql and the research registry.
-- CONVENTION (supabase/README.md): idempotent, additive, pasted into the SQL
-- editor, no psql meta-commands, ends in a report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.research_models') is null or to_regclass('public.research_model_versions') is null then
    raise exception 'the research registry (public.research_models, public.research_model_versions) is not in this database: nothing was registered';
  end if;
  if to_regclass('public.radar_config') is null then raise exception 'apply supabase/radar.sql first'; end if;
end $req$;

${helpers()}

begin;

${regs.map(block).join('\n')}
commit;

-- THE REPORT: each hypothesis as research_model_current reads it, and the links the doors need. Every row should say ok.
create or replace function pg_temp.rdr_current(p_key text) returns jsonb
language plpgsql as $f$
declare j jsonb;
begin
  if to_regclass('public.research_model_current') is null then return null; end if;
  execute 'select to_jsonb(r) from public.research_model_current r where lower(coalesce(to_jsonb(r) ->> ''model_key'', to_jsonb(r) ->> ''key'', to_jsonb(r) ->> ''model_name'', to_jsonb(r) ->> ''model'', to_jsonb(r) ->> ''name'')) = lower($1) limit 1'
    into j using p_key;
  return j;
end $f$;
create or replace function pg_temp.rdr_report() returns table (piece text, state text)
language plpgsql as $f$
declare j jsonb; s text; k text; n int := 0;
begin
  foreach k in array array['H-RADAR-01', 'H-RADAR-02'] loop
    j := pg_temp.rdr_current(k);
    s := lower(coalesce(j ->> 'status', j ->> 'model_status', j ->> 'maturity', ''));
    n := n + 1;
    piece := n || ' ' || k || ' is registered and EXPERIMENTAL';
    state := case when to_regclass('public.research_model_current') is null then 'CHECK THIS: research_model_current is not in this database'
                  when j is null then 'CHECK THIS: not in research_model_current'
                  when s <> 'experimental' then 'CHECK THIS: status reads ' || s
                  else 'ok' end;
    return next;
    n := n + 1;
    piece := n || ' the Radar doors may show it (registry_ref:' || k || ' is in radar_config)';
    state := case when exists (select 1 from public.radar_config where key = 'registry_ref:' || k) then 'ok' else 'CHECK THIS' end;
    return next;
    if k = 'H-RADAR-01' then
      n := n + 1;
      piece := n || ' what the H-RADAR-01 holdout test found is recorded (h_radar_01_result)';
      state := case when exists (select 1 from public.radar_config where key = 'h_radar_01_result' and value::jsonb ->> 'status' = '${v.summary.status}') then 'ok' else 'CHECK THIS' end;
      return next;
    end if;
  end loop;
end $f$;
select * from pg_temp.rdr_report();
`;
}

if (require.main === module) {
  const sql = build();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (process.argv.includes('--check')) { if (cur !== sql) { console.log('STALE   supabase/radar_registry.sql (run node tools/radar/build_registry_sql.js)'); process.exit(1); } console.log('ok      supabase/radar_registry.sql'); process.exit(0); }
  if (cur === sql) { console.log('ok      supabase/radar_registry.sql'); process.exit(0); }
  fs.writeFileSync(OUT, sql); console.log('wrote   supabase/radar_registry.sql');
}
module.exports = { build, SOURCE, REPORT, verdict, load };
