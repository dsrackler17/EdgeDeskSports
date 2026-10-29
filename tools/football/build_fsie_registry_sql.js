#!/usr/bin/env node
/* ===========================================================================
   Generate supabase/football_situational_registry.sql: the Football
   Situational Intelligence Engine's four research models, registered
   EXPERIMENTAL from the FROZEN preregistration
   (football/situational/research/preregistration.json):
     fsie_nfl_team_volume   fsie_nfl_player_volume
     fsie_cfb_team_volume   fsie_cfb_player_volume
   each with its objective, windows, minimum sample, preregistered promotion
   criteria, forking-paths disclosure and specification. Once a sport's
   one-look holdout has been evaluated (research/holdout_<sport>.json), one
   research_model_results row per version records `passed` (every criterion
   met) and the holdout metrics — written once, never changed. Status is never
   written past experimental: promotion is a person's act.

   The registry's DDL is not in this repository, so the SQL reads the live
   columns and enum labels with the helpers the NFL studies file carries
   (supabase/nfl_market_structure_studies.sql, verbatim) and refuses by column
   name rather than guess.

     node tools/football/build_fsie_registry_sql.js          write
     node tools/football/build_fsie_registry_sql.js --check  fail if stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const PREREG = 'football/situational/research/preregistration.json';
const OUT = path.join(ROOT, 'supabase', 'football_situational_registry.sql');
const TAG = '$fsiereg$';

function helpers() {
  const f = fs.readFileSync(path.join(ROOT, 'supabase', 'nfl_market_structure_studies.sql'), 'utf8');
  const a = f.indexOf('-- helpers for this session only'), b = f.indexOf('\nbegin;', a);
  if (a < 0 || b < 0) throw new Error('supabase/nfl_market_structure_studies.sql: the registry helpers were not found');
  return f.slice(a, b).replace('map it in tools/football/build_prereg_sql.js', 'map it in tools/football/build_fsie_registry_sql.js').trim();
}

/* season Y's games fall in [Y-08-01, (Y+1)-02-15) */
function window(seasons) { if (!seasons || !seasons.length) return null; const lo = Math.min.apply(null, seasons), hi = Math.max.apply(null, seasons); return [lo + '-08-01', (hi + 1) + '-02-15']; }

function registrations() {
  const raw = fs.readFileSync(path.join(ROOT, PREREG), 'utf8');
  const P = JSON.parse(raw);
  if (P.status !== 'frozen') throw new Error(PREREG + ' is not frozen: a registration is written from the frozen preregistration only');
  return P.models.map((M) => {
    const S = P.sports[M.sport]; const R = S.seasons; const team = /team_volume$/.test(M.model_key);
    const crit = team ? S.promotion_criteria.team : S.promotion_criteria.player;
    return {
      schema: 'edgedesk_research_registration_v1', model_key: M.model_key, name: M.name, version: P.model_version, status: 'EXPERIMENTAL', provenance: 'T3',
      sport: M.sport === 'nfl' ? 'NFL' : 'NCAAF', registered_at: P.registered_at, hypothesis: P.hypothesis,
      objective: (team ? 'Project team offensive plays, official pass attempts and official rush attempts' : 'Project player pass attempts, rush attempts, targets and receptions') + ' with calibrated P10-P90 intervals, out of sample.',
      primary_metric: P.primary_metric, unit: M.unit,
      baseline: Object.keys(P.baselines).join(', '),
      training_window: 'seasons ' + R.train.join(', '), validation_window: 'walk-forward folds ' + R.validation.join(', '), holdout_window: 'season ' + R.holdout + ' (untouched until the freeze)',
      machine: { window_dates: { training: window(R.train), validation: window(R.validation), holdout: window([R.holdout]) }, window_note: '[from, to): calendar dates spanning the seasons', minimum_sample: team ? crit.find((c) => c.id === 'sample').min_team_games : crit.find((c) => c.id === 'player_sample').min_other, version: P.model_version, status: 'EXPERIMENTAL', provenance: 'T3' },
      minimum_sample: team ? { team_games: crit.find((c) => c.id === 'sample').min_team_games } : { qb_starts: crit.find((c) => c.id === 'player_sample').min_qb_starts, other_rows: crit.find((c) => c.id === 'player_sample').min_other },
      promotion_criteria: { decision_rule: 'every criterion below on the holdout; passing permits only a separate preregistered integration study', criteria: crit.map((c) => ({ id: c.id, rule: c.rule })), family_correction: 'none: all criteria must hold jointly' },
      forking_paths: P.forking_paths,
      spec: { targets: M.targets, primary_variant: S.primary_variant, feature_families: P.feature_families, baselines: P.baselines, missing_data_policy: P.missing_data_policy,
        disclosure_rules: P.disclosure_rules, data_already_seen: P.data_already_seen, ridge_lambda: S.ridge_lambda, frozen_choices: S.frozen_choices,
        preregistration: PREREG, preregistration_sha256: P.content_sha256, code_sha256: P.code_fingerprint && P.code_fingerprint.sha256 },
      result: null
    };
  });
}

function results() {
  const out = [];
  ['nfl', 'cfb'].forEach((sp) => {
    const f = path.join(ROOT, 'football', 'situational', 'research', 'holdout_' + sp + '.json');
    if (!fs.existsSync(f)) return;
    const H = JSON.parse(fs.readFileSync(f, 'utf8'));
    const pv = H.primary_variant;
    const team = {}; ['plays', 'pass_att', 'rush_att'].forEach((t) => { team[t] = { mae: H.team.metrics[t][pv].mae, bias: H.team.metrics[t][pv].bias, season_avg_mae: H.team.metrics[t].season_avg.mae, recent_weighted_mae: H.team.metrics[t].recent_weighted.mae, market_only_mae: H.team.metrics[t].market_only.mae, coverage_p10_p90: H.team.coverage[t].p10_p90 }; });
    const pl = {}; ['pass_att', 'rush_att', 'targets', 'receptions'].forEach((m) => { const x = H.players[m]; pl[m] = { n: x.evaluated, mae: x.metrics.model.mae, bias: x.metrics.model.bias, season_avg_mae: x.metrics.season_avg.mae, recent_weighted_mae: x.metrics.recent_weighted.mae, coverage_p10_p90: H.players.coverage[m].p10_p90 }; });
    const tm = { holdout_season: H.holdout_season, n_team_games: H.n_team_games, targets: team, criteria: H.criteria.team, preregistration_sha256: H.preregistration_sha256, code_sha256: H.code_sha256 };
    /* the recorded team coverage was simulated on the harness's default rung, not the primary
       variant; the labelled post-hoc file says so, and the row carries both, never a replacement */
    const ph = path.join(ROOT, 'football', 'situational', 'research', 'posthoc_interval_variant_' + sp + '.json');
    if (fs.existsSync(ph)) {
      const X = JSON.parse(fs.readFileSync(ph, 'utf8'));
      tm.coverage_note = 'coverage_p10_p90 above was simulated on the "formation" rung (a harness default), not the primary variant "' + pv + '"; ' + X.verdict_effect + '. Post-hoc, not a criterion: research/posthoc_interval_variant_' + sp + '.json';
      tm.posthoc_primary_variant_coverage = {}; ['plays', 'pass_att', 'rush_att'].forEach((t) => { tm.posthoc_primary_variant_coverage[t] = X.holdout_season.by_variant[pv].coverage[t].p10_p90; });
    }
    out.push({ study_id: 'fsie_' + sp + '_team_volume', version: 'situational_v1', passed: H.criteria.team_passed, metrics: tm, notes: 'holdout ' + H.holdout_season + ' evaluated once at ' + H.evaluated_at + '; research/holdout_' + sp + '.json' });
    out.push({ study_id: 'fsie_' + sp + '_player_volume', version: 'situational_v1', passed: H.criteria.player_passed, metrics: { holdout_season: H.holdout_season, markets: pl, criteria: H.criteria.player, preregistration_sha256: H.preregistration_sha256, code_sha256: H.code_sha256 }, notes: 'holdout ' + H.holdout_season + ' evaluated once at ' + H.evaluated_at + '; research/holdout_' + sp + '.json' });
  });
  return out;
}

function block(R) {
  const payload = JSON.stringify(Object.assign({}, R, { content_sha256: crypto.createHash('sha256').update(JSON.stringify(R)).digest('hex') }));
  if (payload.indexOf(TAG) >= 0) throw new Error('the payload contains the dollar-quote tag');
  return `do $reg$
declare
  S jsonb := ${TAG}${payload}${TAG}::jsonb;
  m regclass := 'public.research_models';
  v regclass := 'public.research_model_versions';
  mv jsonb; vv jsonb; mach jsonb := S -> 'machine';
  kcol text; ncol text; refcol text; fkcol text; vcol text; c text; ref text; have boolean;
  pairs text[][] := array[
    array['training_window', 'train_window', 'training_period', 'training'],
    array['validation_window', 'valid_window', 'validation_period', 'validation'],
    array['holdout_window', 'holdout_period', 'holdout', 'test_window']];
  wkeys text[] := array['training', 'validation', 'holdout'];
  i int;
begin
  kcol := pg_temp.edr_has(m, array['model_key', 'key', 'model_name', 'model', 'slug', 'code', 'name']);
  if kcol is null then raise exception 'research registry: research_models has no key column — nothing was registered'; end if;
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

  execute format('select %I::text from %s where %I::text = $1 limit 1', refcol, m, kcol) into ref using S ->> 'model_key';
  if ref is null then
    mv := jsonb_build_object(kcol, S ->> 'model_key');
    ncol := pg_temp.edr_has(m, array['name', 'title', 'display_name', 'label']);
    if ncol is not null and ncol <> kcol then mv := mv || jsonb_build_object(ncol, S ->> 'name'); end if;
    c := pg_temp.edr_has(m, array['sport', 'league']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'sport'); end if;
    c := pg_temp.edr_has(m, array['status', 'model_status', 'maturity']); if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['experimental'])); end if;
    c := pg_temp.edr_has(m, array['provenance', 'evidence_provenance', 'tier', 'evidence_tier']);
    if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['t3', 'research_model', 'research', 'model'])); end if;
    c := pg_temp.edr_has(m, array['objective', 'goal']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['hypothesis']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'hypothesis'); end if;
    c := pg_temp.edr_has(m, array['description', 'summary']); if c is not null then mv := mv || jsonb_build_object(c, S ->> 'hypothesis'); end if;
    c := pg_temp.edr_has(m, array['family', 'category', 'module', 'domain']); if c is not null then mv := mv || jsonb_build_object(c, 'football_situational'); end if;
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
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, (mach -> 'minimum_sample')::text,
      case when pg_temp.edr_typ(v, c) in ('jsonb', 'json') then S -> 'minimum_sample' else mach -> 'minimum_sample' end, null)); end if;
    c := pg_temp.edr_has(v, array['success_metric', 'primary_metric', 'metric']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S ->> 'primary_metric', null, null)); end if;
    c := pg_temp.edr_has(v, array['promotion_criteria', 'decision_rule', 'criteria', 'success_criteria']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, S -> 'promotion_criteria' ->> 'decision_rule', S -> 'promotion_criteria', null)); end if;
    c := pg_temp.edr_has(v, array['forking_paths', 'forking_paths_disclosure', 'disclosure', 'garden_of_forking_paths']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, S -> 'forking_paths', null)); end if;
    c := pg_temp.edr_has(v, array['spec', 'metadata', 'meta', 'params', 'config', 'details', 'definition', 'protocol']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, S -> 'spec' || jsonb_build_object('content_sha256', S ->> 'content_sha256'), null)); end if;
    c := pg_temp.edr_has(v, array['notes', 'description']);
    if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c,
      'Preregistered ' || (S ->> 'registered_at') || ' from ${PREREG} (sha256 ' || (S -> 'spec' ->> 'preregistration_sha256') || ').', null, null)); end if;
    perform pg_temp.edr_insert(v, vv, fkcol);
  end if;
end $reg$;`;
}

function resultsBlock(rows) {
  if (!rows.length) return '-- no holdout has been evaluated yet: no research_model_results row.';
  const payload = JSON.stringify({ results: rows });
  if (payload.indexOf(TAG) >= 0) throw new Error('the results payload contains the dollar-quote tag');
  return `do $res$
declare
  S jsonb := ${TAG}${payload}${TAG}::jsonb;
  m regclass := 'public.research_models';
  v regclass := 'public.research_model_versions';
  rs regclass := to_regclass('public.research_model_results');
  kcol text; refcol text; fkcol text; vcol text; rfk text; rref text; rmcol text; rvcol text; pcol text; mcol text; c text;
  vid text; ref2 text; rv jsonb; e jsonb; have2 boolean; n_results int := 0;
begin
  if rs is null then raise notice 'research registry: no research_model_results table; no result row written'; return; end if;
  kcol := pg_temp.edr_has(m, array['model_key', 'key', 'model_name', 'model', 'slug', 'code', 'name']);
  select a.attname::text, ra.attname::text into fkcol, refcol
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = k.confkey[1]
   where k.contype = 'f' and k.conrelid = v and k.confrelid = m limit 1;
  if fkcol is null then
    fkcol := pg_temp.edr_has(v, array['model_key', 'model_id', 'research_model_id', 'model']);
    refcol := case when fkcol in ('model_id', 'research_model_id') then pg_temp.edr_has(m, array['id', 'model_id']) else kcol end;
  end if;
  vcol := pg_temp.edr_has(v, array['version', 'model_version', 'version_label', 'semver', 'label']);
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
    if rmcol is null or rvcol is null then raise exception 'research registry: cannot tell how research_model_results points at a version — no result written'; end if;
  end if;
  pcol := pg_temp.edr_has(rs, array['passed', 'pass', 'is_passed', 'success']);
  mcol := pg_temp.edr_has(rs, array['metrics', 'results', 'result', 'holdout_result', 'details', 'payload', 'data']);
  for e in select * from jsonb_array_elements(S -> 'results') loop
    execute format('select %I::text from %s where %I::text = $1 limit 1', refcol, m, kcol) into ref2 using e ->> 'study_id';
    if ref2 is null then raise exception 'research registry: % is not registered; run the registration first', e ->> 'study_id'; end if;
    if rfk is not null then
      execute format('select %I::text from %s where %I::text = $1 and %I::text = $2 limit 1', rref, v, fkcol, vcol) into vid using ref2, e ->> 'version';
      if vid is null then raise exception 'research registry: no version % for % to attach a result to', e ->> 'version', e ->> 'study_id'; end if;
      execute format('select exists (select 1 from %s where %I::text = $1)', rs, rfk) into have2 using vid;
      rv := jsonb_build_object(rfk, vid);
    else
      execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', rs, rmcol, rvcol) into have2 using ref2, e ->> 'version';
      rv := jsonb_build_object(rmcol, ref2, rvcol, e ->> 'version');
    end if;
    continue when have2;
    if pcol is not null then rv := rv || jsonb_build_object(pcol, pg_temp.edr_val(rs, pcol, null, e -> 'passed', null)); end if;
    if mcol is not null then rv := rv || jsonb_build_object(mcol, pg_temp.edr_val(rs, mcol, null, e -> 'metrics', null)); end if;
    c := pg_temp.edr_has(rs, array['notes', 'summary', 'verdict', 'reason']); if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(rs, c, e ->> 'notes', null, null)); end if;
    perform pg_temp.edr_insert(rs, rv, coalesce(rfk, rmcol));
    n_results := n_results + 1;
  end loop;
  raise notice 'research registry: % result row(s) written', n_results;
end $res$;`;
}

function build() {
  const regs = registrations(); const res = results();
  return `-- =============================================================================
-- football_situational_registry.sql — the Football Situational Intelligence
-- Engine's four research models, registered EXPERIMENTAL.
-- football/situational/README.md, docs/football-situational/ARCHITECTURE.md.
--
-- GENERATED by tools/football/build_fsie_registry_sql.js from ${PREREG}
--   (frozen; content sha256 ${regs[0].spec.preregistration_sha256})
${regs.map((r) => '--   ' + r.model_key + ' ' + r.version + ' (' + r.sport + ')').join('\n')}
-- and, once evaluated, research/holdout_<sport>.json (${res.length} result row(s) below).
-- Do not edit by hand.
--
-- WHAT IT DOES. One research_models row (EXPERIMENTAL, provenance T3) and one
-- research_model_versions row per model, with the objective, the windows, the
-- minimum sample, the preregistered promotion criteria, the forking-paths
-- disclosure and the specification, written in whatever form the live columns
-- take. Then, for each evaluated holdout, one research_model_results row per
-- version: passed = every preregistered criterion met, with the holdout metrics.
--
-- WHAT IT DOES NOT DO. No change to a registered row or an existing result.
-- No status past experimental: a passed holdout only makes a model eligible for
-- a separate integration study, and promotion is a person's act.
--
-- REQUIRES the research registry. CONVENTION (supabase/README.md): idempotent,
-- additive, pasted into the SQL editor, no psql meta-commands, ends in a
-- report. Safe to run again.
-- =============================================================================

do $req$ begin
  if to_regclass('public.research_models') is null or to_regclass('public.research_model_versions') is null then
    raise exception 'the research registry (public.research_models, public.research_model_versions) is not in this database: nothing was registered';
  end if;
end $req$;

${helpers()}

begin;

${regs.map(block).join('\n\n')}

${resultsBlock(res)}

commit;

-- THE REPORT: each model as research_model_current reads it. Every row should say ok.
create or replace function pg_temp.fsr_report() returns table (piece text, state text)
language plpgsql as $f$
declare j jsonb; s text; k text; n int := 0;
begin
  foreach k in array array[${regs.map((r) => "'" + r.model_key + "'").join(', ')}] loop
    n := n + 1; j := null;
    if to_regclass('public.research_model_current') is not null then
      execute 'select to_jsonb(r) from public.research_model_current r where lower(coalesce(to_jsonb(r) ->> ''model_key'', to_jsonb(r) ->> ''key'', to_jsonb(r) ->> ''model_name'', to_jsonb(r) ->> ''model'', to_jsonb(r) ->> ''name'')) = lower($1) limit 1'
        into j using k;
    end if;
    s := lower(coalesce(j ->> 'status', j ->> 'model_status', j ->> 'maturity', ''));
    piece := n || ' ' || k || ' is EXPERIMENTAL';
    state := case when to_regclass('public.research_model_current') is null then 'CHECK THIS: research_model_current is not in this database'
                  when j is null then 'CHECK THIS: not in research_model_current'
                  when s <> 'experimental' then 'CHECK THIS: status reads ' || s
                  else 'ok' end;
    return next;
  end loop;
end $f$;
select * from pg_temp.fsr_report();
`;
}

if (require.main === module) {
  const sql = build();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (process.argv.includes('--check')) { if (cur !== sql) { console.log('STALE   supabase/football_situational_registry.sql (run node tools/football/build_fsie_registry_sql.js)'); process.exit(1); } console.log('ok      supabase/football_situational_registry.sql'); process.exit(0); }
  if (cur === sql) { console.log('ok      supabase/football_situational_registry.sql'); process.exit(0); }
  fs.writeFileSync(OUT, sql); console.log('wrote   supabase/football_situational_registry.sql');
}
module.exports = { build, registrations, results, OUT, PREREG };
