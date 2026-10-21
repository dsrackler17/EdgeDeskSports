#!/usr/bin/env node
/* ===========================================================================
   supabase/nfl_model_registry.sql — GENERATED from
   football/research/nfl_v2/registry.json. Never hand-edit the SQL.

   The NFL margin model's versions and results, in the research registry:

     research_models          edgedesk-nfl-margin (the model the board serves)
                              edgedesk-nfl-margin-candidates (every candidate
                              Steps 2-4 and the weekly loop judged)
     research_model_versions  one row per served/superseded version, and one
                              per candidate (version label "<run> <candidate>")
     research_model_results   one row per version that went through a gate:
                              passed = the preregistered promotion gate's
                              verdict, metrics = the walk-forward record
                              beside the incumbent's and the close's

   Every status is EXPERIMENTAL or RETIRED, never VALIDATED: a version passes
   its gate against the model it replaces, but no version beats the closing
   line (beats_closing_line is in every result), and maturity never upgrades on
   that. A version already registered keeps its row; only its status follows
   the registry (served -> superseded -> retired on a promotion or rollback).
   A result already written for a version is never written twice.

   THE SCHEMA IS READ, NOT ASSUMED, exactly as
   supabase/nfl_market_structure_studies.sql reads it (the same pg_temp.edr_*
   helpers, taken from tools/football/build_prereg_sql.js so there is one copy).

     node tools/football/build_nfl_registry_sql.js           # write
     node tools/football/build_nfl_registry_sql.js --check   # exit 1 if stale
   Applied by .github/workflows/nfl-weekly-loop.yml with psql when the
   SB_DB_URL secret is set; otherwise paste it into the SQL editor.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const REG = path.join(ROOT, 'football', 'research', 'nfl_v2', 'registry.json');
const OUT = path.join(ROOT, 'supabase', 'nfl_model_registry.sql');
const PREREG = require('./build_prereg_sql.js');

/* the helper functions, from the one place they are written */
function helpers() {
  const sql = PREREG.build();
  const a = sql.indexOf('-- helpers for this session only'), b = sql.indexOf('\nbegin;', a);
  if (a < 0 || b < 0) throw new Error('could not find the pg_temp.edr_* helpers in build_prereg_sql.js output');
  return sql.slice(a, b).replace('(map it in tools/football/build_prereg_sql.js)', '(map it in tools/football/build_nfl_registry_sql.js)');
}

/* the registry as flat rows: one per version to register, its result if it has one */
function entries(reg) {
  const out = [];
  const statusOf = (s) => (s === 'served' ? ['experimental'] : ['retired', 'experimental']);
  reg.versions.forEach((v) => {
    const gated = reg.events.some((e) => e.kind === 'promote' && e.to === v.model_version);
    out.push({
      model_key: reg.model_key, version: v.model_version, status: statusOf(v.status), registry_status: v.status,
      notes: `${v.status}: ${v.role || ''}`.trim(), spec: { cfg: v.cfg || null, config_sha: v.config_sha || null, parent: v.parent || null, archive: v.archive || null, created_at: v.created_at || null },
      result: gated ? { passed: true, metrics: Object.assign({ gate: reg.gate.promotion }, v.metrics || {}), notes: 'promoted: passed the preregistered promotion gate against ' + (v.parent || 'its incumbent') } : null,
    });
  });
  reg.results.forEach((r) => {
    out.push({
      model_key: reg.candidates_key, version: `${r.run} ${r.candidate}`, status: ['experimental'], registry_status: 'candidate',
      notes: `candidate (${r.family}) judged in ${r.run}: ${r.passed ? 'PASSED' : 'rejected'}${r.from_pattern ? ' — from pattern ' + r.from_pattern : ''}`,
      spec: { family: r.family, cfg_sha: r.cfg_sha || null, run: r.run, evaluated_at: r.evaluated_at || null },
      result: { passed: !!r.passed, metrics: { metrics: r.metrics || null, incumbent: r.incumbent || null, checks: r.checks || null, why: r.why || null }, notes: r.why || null },
    });
  });
  return out;
}

function build(regIn) {
  const reg = regIn || JSON.parse(fs.readFileSync(REG, 'utf8'));
  const models = [
    { key: reg.model_key, title: 'EdgeDesk NFL margin model', objective: 'Project the NFL home margin and win probability; served on the board, the slate and the game cards. ' + reg.gate.promotion + '.' },
    { key: reg.candidates_key, title: 'EdgeDesk NFL margin model — candidates', objective: 'Every candidate change to the NFL margin model judged by the walk-forward backtest (Steps 2-4 and the weekly loop), with its verdict.' },
  ];
  const rows = entries(reg);
  const body = { models, rows, current: reg.current };
  const sha = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const payload = JSON.stringify(Object.assign({ content_sha256: sha }, body));
  if (payload.indexOf('$nflreg$') >= 0) throw new Error('the payload contains the dollar-quote tag');
  return `-- =============================================================================
-- nfl_model_registry.sql — the NFL margin model's versions and results in the
-- research registry. football/research/nfl_v2/RESULTS.md
--
-- GENERATED by tools/football/build_nfl_registry_sql.js from
-- football/research/nfl_v2/registry.json (content sha256 ${sha}).
-- Do not edit by hand. Served version: ${reg.current}.
--
-- WHAT IT DOES. Registers ${models.map((m) => m.key).join(' and ')}, one
-- research_model_versions row per version (${rows.filter((r) => r.model_key === reg.model_key).length}) and per candidate
-- (${rows.filter((r) => r.model_key === reg.candidates_key).length}), and one research_model_results row per gated version:
-- passed is the preregistered gate's verdict. Statuses are EXPERIMENTAL or
-- RETIRED, never VALIDATED (no version beats the closing line).
--
-- IDEMPOTENT. A version already registered keeps its row and takes the
-- registry's status; a result already written is never written twice. The
-- live columns and enum labels are read (pg_attribute, pg_enum), never
-- assumed; a NOT NULL column with no default that nothing here can fill stops
-- the whole file with that column's name, before anything is written.
--
-- CONVENTION (supabase/README.md): idempotent, additive, no psql
-- meta-commands, ends in a report. Safe to run again. Nothing here touches a
-- projection, spread, probability, EV, ranking, grade or the frozen CLV
-- ranking protocol.
-- =============================================================================

do $req$ begin
  if to_regclass('public.research_models') is null or to_regclass('public.research_model_versions') is null or to_regclass('public.research_model_results') is null then
    raise exception 'the research registry (public.research_models, research_model_versions, research_model_results) is not in this database: nothing was registered';
  end if;
end $req$;

${helpers()}
begin;

do $reg$
declare
  R jsonb := $nflreg$${payload}$nflreg$::jsonb;
  m regclass := 'public.research_models';
  v regclass := 'public.research_model_versions';
  rs regclass := 'public.research_model_results';
  e jsonb; md jsonb; mv jsonb; vv jsonb; rv jsonb;
  kcol text; ncol text; refcol text; fkcol text; vcol text; vref text; scol text; c text; ref text; vid text; have boolean;
  rfk text; rref text; rmcol text; rvcol text; pcol text; mcol text;
  n_models int := 0; n_versions int := 0; n_status int := 0; n_results int := 0; kept int := 0; changed bigint;
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
  if vcol is null then raise exception 'research registry: research_model_versions has no version column — nothing was registered'; end if;
  scol := pg_temp.edr_has(v, array['status', 'model_status', 'maturity']);

  -- how a result points at its version: a foreign key, an id column, or the (model, version) text pair
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
  end if;
  pcol := pg_temp.edr_has(rs, array['passed', 'pass', 'is_passed', 'success']);
  mcol := pg_temp.edr_has(rs, array['metrics', 'results', 'result', 'holdout_result', 'details', 'payload', 'data']);

  -- the two models
  for md in select * from jsonb_array_elements(R -> 'models') loop
    execute format('select exists (select 1 from %s where %I::text = $1)', m, kcol) into have using md ->> 'key';
    continue when have;
    mv := jsonb_build_object(kcol, md ->> 'key');
    ncol := pg_temp.edr_has(m, array['name', 'title', 'display_name', 'label']);
    if ncol is not null and ncol <> kcol then mv := mv || jsonb_build_object(ncol, md ->> 'title'); end if;
    c := pg_temp.edr_has(m, array['sport', 'league']); if c is not null then mv := mv || jsonb_build_object(c, 'NFL'); end if;
    c := pg_temp.edr_has(m, array['sport_key']); if c is not null then mv := mv || jsonb_build_object(c, 'americanfootball_nfl'); end if;
    c := pg_temp.edr_has(m, array['status', 'model_status', 'maturity']); if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['experimental'])); end if;
    c := pg_temp.edr_has(m, array['provenance', 'evidence_provenance', 'tier', 'evidence_tier']);
    if c is not null then mv := mv || jsonb_build_object(c, pg_temp.edr_label(m, c, array['t3', 'research_model', 'research', 'model'])); end if;
    c := pg_temp.edr_has(m, array['objective', 'goal']); if c is not null then mv := mv || jsonb_build_object(c, md ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['description', 'summary']); if c is not null then mv := mv || jsonb_build_object(c, md ->> 'objective'); end if;
    c := pg_temp.edr_has(m, array['family', 'category', 'module', 'domain']); if c is not null then mv := mv || jsonb_build_object(c, 'nfl_margin_model'); end if;
    perform pg_temp.edr_insert(m, mv, refcol);
    n_models := n_models + 1;
  end loop;

  -- every version, and its result
  for e in select * from jsonb_array_elements(R -> 'rows') loop
    execute format('select %I::text from %s where %I::text = $1 limit 1', refcol, m, kcol) into ref using e ->> 'model_key';
    execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', v, fkcol, vcol) into have using ref, e ->> 'version';
    if not have then
      vv := jsonb_build_object(fkcol, ref, vcol, e ->> 'version');
      if scol is not null then vv := vv || jsonb_build_object(scol, pg_temp.edr_label(v, scol, array(select jsonb_array_elements_text(e -> 'status')))); end if;
      c := pg_temp.edr_has(v, array['provenance', 'evidence_provenance', 'tier']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_label(v, c, array['t3', 'research_model', 'research', 'model'])); end if;
      c := pg_temp.edr_has(v, array['spec', 'metadata', 'meta', 'params', 'config', 'details', 'definition', 'protocol']);
      if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, null, e -> 'spec', null)); end if;
      c := pg_temp.edr_has(v, array['notes', 'description']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, e ->> 'notes', null, null)); end if;
      c := pg_temp.edr_has(v, array['training_window', 'train_window']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, '2002 through the season before each predicted season (walk-forward)', null, '["2002-09-01","2026-03-01"]'::jsonb)); end if;
      c := pg_temp.edr_has(v, array['validation_window', 'valid_window']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, '2010-2024 walk-forward', null, '["2010-09-01","2025-03-01"]'::jsonb)); end if;
      c := pg_temp.edr_has(v, array['holdout_window', 'holdout_period']); if c is not null then vv := vv || jsonb_build_object(c, pg_temp.edr_val(v, c, '2025 season', null, '["2025-09-01","2026-03-01"]'::jsonb)); end if;
      perform pg_temp.edr_insert(v, vv, vcol);
      n_versions := n_versions + 1;
    else
      kept := kept + 1;
      if scol is not null then
        execute format('update %s set %I = $1::text::%s where %I::text = $2 and %I::text = $3 and %I::text is distinct from $1', v, scol, pg_temp.edr_typ(v, scol), fkcol, vcol, scol)
          using pg_temp.edr_label(v, scol, array(select jsonb_array_elements_text(e -> 'status'))), ref, e ->> 'version';
        get diagnostics changed = row_count;
        if changed > 0 then n_status := n_status + 1; end if;
      end if;
    end if;

    continue when e -> 'result' is null or jsonb_typeof(e -> 'result') = 'null';
    if rfk is not null then
      execute format('select %I::text from %s where %I::text = $1 and %I::text = $2 limit 1', rref, v, fkcol, vcol) into vid using ref, e ->> 'version';
      execute format('select exists (select 1 from %s where %I::text = $1)', rs, rfk) into have using vid;
      rv := jsonb_build_object(rfk, vid);
    else
      execute format('select exists (select 1 from %s where %I::text = $1 and %I::text = $2)', rs, rmcol, rvcol) into have using e ->> 'model_key', e ->> 'version';
      rv := jsonb_build_object(rmcol, e ->> 'model_key', rvcol, e ->> 'version');
    end if;
    continue when have;
    if pcol is not null then rv := rv || jsonb_build_object(pcol, pg_temp.edr_val(rs, pcol, null, e -> 'result' -> 'passed', null)); end if;
    if mcol is not null then rv := rv || jsonb_build_object(mcol, pg_temp.edr_val(rs, mcol, null, e -> 'result' -> 'metrics', null)); end if;
    c := pg_temp.edr_has(rs, array['notes', 'summary', 'verdict', 'reason']); if c is not null then rv := rv || jsonb_build_object(c, pg_temp.edr_val(rs, c, e -> 'result' ->> 'notes', null, null)); end if;
    perform pg_temp.edr_insert(rs, rv, coalesce(rfk, rmcol));
    n_results := n_results + 1;
  end loop;
  raise notice 'nfl model registry: % model row(s), % version row(s) and % result row(s) written; % version(s) already registered (% status change(s))', n_models, n_versions, n_results, kept, n_status;
end $reg$;

commit;

-- THE REPORT. Every row should say ok.
create or replace function pg_temp.edr_nfl_report() returns table (piece text, state text)
language plpgsql as $f$
declare R jsonb := '${JSON.stringify({ keys: models.map((x) => x.key), current: reg.current, n: rows.length, gated: rows.filter((r) => r.result).length }).replace(/'/g, "''")}'::jsonb;
  kcol text; vcol text; fkcol text; refcol text; n int; k text;
begin
  kcol := pg_temp.edr_has('public.research_models', array['model_key', 'key', 'model_name', 'model', 'slug', 'code', 'name']);
  vcol := pg_temp.edr_has('public.research_model_versions', array['version', 'model_version', 'version_label', 'semver', 'label']);
  for k in select * from jsonb_array_elements_text(R -> 'keys') loop
    execute format('select count(*) from public.research_models where %I::text = $1', kcol) into n using k;
    piece := k || ' is registered'; state := case when n = 1 then 'ok' else 'CHECK THIS: ' || n || ' rows' end; return next;
  end loop;
  execute format('select count(*) from public.research_model_versions where %I::text = $1', vcol) into n using R ->> 'current';
  piece := 'the served version ' || (R ->> 'current') || ' is registered'; state := case when n = 1 then 'ok' else 'CHECK THIS: ' || n || ' rows' end; return next;
  execute 'select count(*) from public.research_model_results' into n;
  piece := 'at least ' || (R ->> 'gated') || ' result rows (one per gated version)'; state := case when n >= (R ->> 'gated')::int then 'ok' else 'CHECK THIS: ' || n end; return next;
end $f$;
select * from pg_temp.edr_nfl_report();
`;
}

if (require.main === module) {
  const sql = build();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (process.argv.includes('--check')) { if (cur !== sql) { console.log('STALE ' + path.relative(ROOT, OUT) + ' (run node tools/football/build_nfl_registry_sql.js)'); process.exit(1); } console.log('current'); process.exit(0); }
  if (cur === sql) console.log('unchanged ' + path.relative(ROOT, OUT));
  else { fs.writeFileSync(OUT, sql); console.log('wrote ' + path.relative(ROOT, OUT)); }
}
module.exports = { build, entries, OUT, REG };
