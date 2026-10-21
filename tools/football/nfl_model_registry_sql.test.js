#!/usr/bin/env node
/* ===========================================================================
   supabase/nfl_model_registry.sql, run for real against a throwaway postgres,
   on two registry shapes the live DDL could take (the repository does not hold
   it): uuid/bigserial keys with enums and date ranges (A), and text keys with
   capitalised enums and a (model, model_version) result pair (B).

   Checks: it is current with registry.json; it applies twice (idempotent); the
   served version and every candidate are registered with one result each;
   passed carries the gate's verdict; nothing is ever VALIDATED; a promotion
   (a later registry) moves the old version to RETIRED and adds the new one
   without duplicating anything.

   Run: node tools/football/nfl_model_registry_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const G = require('./build_nfl_registry_sql.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
function done(note) { if (note) console.log(note); console.log((fail ? 'FAIL' : 'ALL GREEN') + ` | nfl model registry sql | ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

const REG = JSON.parse(fs.readFileSync(G.REG, 'utf8'));
const SQL = fs.readFileSync(G.OUT, 'utf8');

/* the static layer: always runs */
chk('supabase/nfl_model_registry.sql is current with registry.json', SQL === G.build(), 'run node tools/football/build_nfl_registry_sql.js');
const rows = G.entries(REG);
chk('every registry version and every candidate result becomes a row', rows.length === REG.versions.length + REG.results.length, rows.length);
chk('no row asks for a VALIDATED status', rows.every((r) => r.status.every((s) => s !== 'validated')));
chk('the served version is gated (passed) and carries beats_closing_line', rows.some((r) => r.version === REG.current && r.result && r.result.passed === true && 'beats_closing_line' in r.result.metrics));
chk('the file never touches a projection, signals or the frozen CLV protocol', !/\b(insert into|update|delete from)\s+public\.(signals|model_predictions|nfl_line_snapshots)/i.test(SQL));

const { findPgBin, startCluster } = require(path.join(ROOT, 'tools', 'collective', 'pg_harness.js'));
const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary: the registry layer did not run');
const pg = startCluster(BIN, 'nflreg');
if (!pg.ok) done('NOTE | could not start postgres: ' + pg.why);
function stageText(sql) { const f = path.join(os.tmpdir(), 'nr_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.sql'); fs.writeFileSync(f, sql); const s = pg.stage(f); fs.unlinkSync(f); return s; }
function runIn(db, sql) { return pg.psql('-d ' + db + ' -X -q -t -A -v ON_ERROR_STOP=1 -f ' + stageText(sql)); }
function one(db, sql) { const r = runIn(db, sql); if (r.status !== 0) throw new Error(r.out); return r.out.trim(); }
function apply(db, sql) { return pg.psql('-d ' + db + ' -X -A -t -v ON_ERROR_STOP=1 -f ' + stageText(sql || SQL)); }
const reportOk = (out) => out.split('\n').filter((l) => /\|(ok|CHECK THIS.*)$/.test(l));

const SHAPES = {
  a: `create extension if not exists pgcrypto;
      create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
      create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
      create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text,
        provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
      create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null,
        status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange,
        objective text, spec jsonb, notes text, created_at timestamptz not null default now());
      create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb,
        computed_at timestamptz not null default now());`,
  b: `create type public.evidence_provenance as enum ('OBSERVED', 'ESTIMATE', 'TRANSFORM', 'RESEARCH_MODEL');
      create type public.model_status as enum ('EXPERIMENTAL', 'VALIDATED', 'RETIRED');
      create table public.research_models (key text primary key, model_name text, model_status public.model_status not null, evidence_provenance public.evidence_provenance, goal text);
      create table public.research_model_versions (model text not null references public.research_models (key), model_version text not null,
        model_status public.model_status not null, train_window text, valid_window text, metadata jsonb, notes text, primary key (model, model_version));
      create table public.research_model_results (model text, model_version text, passed boolean, results jsonb);`,
};
Object.keys(SHAPES).forEach((k) => { pg.psql('-d postgres -q -c "create database nr_' + k + '"'); one('nr_' + k, SHAPES[k]); });
const nVersions = rows.length, nGated = rows.filter((r) => r.result).length;

/* A */
{
  const r1 = apply('nr_a'), r2 = apply('nr_a');
  chk('A: applies, and again (idempotent)', r1.status === 0 && r2.status === 0, (r1.out + r2.out).slice(-900));
  chk('A: the report reads ok on every line', reportOk(r2.out).length === 4 && reportOk(r2.out).every((l) => /\|ok$/.test(l)), reportOk(r2.out));
  chk('A: two models, every version once, one result per gated version — the second run wrote nothing',
    one('nr_a', 'select count(*) from public.research_models') === '2' && one('nr_a', 'select count(*) from public.research_model_versions') === String(nVersions)
    && one('nr_a', 'select count(*) from public.research_model_results') === String(nGated));
  chk('A: the served version is experimental with a passing result', one('nr_a', `select v.status || '/' || r.passed from public.research_model_versions v join public.research_model_results r on r.version_id = v.id where v.version = '${REG.current}'`) === 'experimental/true');
  chk('A: nothing is validated', one('nr_a', "select count(*) from public.research_model_versions where status = 'validated'") === '0');
  chk('A: every candidate result carries its gate verdict and why', one('nr_a', `select count(*) from public.research_model_results r join public.research_model_versions v on v.id = r.version_id
    join public.research_models m on m.id = v.model_id where m.model_key = '${REG.candidates_key}' and r.metrics ? 'why' and r.passed is not null`) === String(REG.results.length));
  chk('A: windows landed as date ranges', one('nr_a', `select holdout_window::text from public.research_model_versions where version = '${REG.current}'`) === '[2025-09-01,2026-03-01)');

  /* a promotion: the next registry supersedes the served version and adds one */
  const next = JSON.parse(JSON.stringify(REG));
  const nv = REG.current.replace(/(\d+)\.(\d+)\.(\d+)$/, (_, a, b) => `${a}.${+b + 1}.0`);
  next.versions.forEach((x) => { if (x.model_version === REG.current) x.status = 'superseded'; });
  next.versions.push({ model_version: nv, status: 'served', role: 'test promotion', cfg: null, config_sha: 'test', parent: REG.current, created_at: '2026-10-27T12:00:00Z', archive: null, metrics: { beats_closing_line: false } });
  next.results.push({ run: 'weekly 2026_w07', candidate: 'H1_season_hfa:test', family: 'H1_season_hfa', passed: true, metrics: {}, why: 'test' });
  next.events.push({ at: '2026-10-27T12:00:00Z', kind: 'promote', from: REG.current, to: nv, run: 'weekly 2026_w07' });
  next.current = nv;
  const r3 = apply('nr_a', G.build(next));
  chk('A: a promotion applies on top of the earlier registry', r3.status === 0 && reportOk(r3.out).every((l) => /\|ok$/.test(l)), r3.out.slice(-900));
  chk('A: …the old served version is now retired, the new one experimental with a passing result',
    one('nr_a', `select string_agg(version || '=' || status, ',' order by version) from public.research_model_versions where version in ('${REG.current}', '${nv}')`) === `${REG.current}=retired,${nv}=experimental`
    && one('nr_a', `select r.passed::text from public.research_model_results r join public.research_model_versions v on v.id = r.version_id where v.version = '${nv}'`) === 'true');
  chk('A: …and nothing was duplicated', one('nr_a', 'select count(*) from public.research_model_versions') === String(nVersions + 2) && one('nr_a', 'select count(*) from public.research_model_results') === String(nGated + 2));
}
/* B */
{
  const r1 = apply('nr_b'), r2 = apply('nr_b');
  chk('B: applies on text keys and capitalised enums, and again', r1.status === 0 && r2.status === 0, (r1.out + r2.out).slice(-900));
  chk('B: the enum labels came from the live enum', one('nr_b', 'select string_agg(distinct model_status::text, \',\') from public.research_model_versions') === 'EXPERIMENTAL,RETIRED'
    || one('nr_b', 'select string_agg(distinct model_status::text, \',\') from public.research_model_versions') === 'EXPERIMENTAL', one('nr_b', 'select string_agg(distinct model_status::text, \',\') from public.research_model_versions'));
  chk('B: results joined by (model, model_version), one per gated version', one('nr_b', 'select count(*) from public.research_model_results') === String(nGated)
    && one('nr_b', `select passed::text from public.research_model_results where model_version = '${REG.current}'`) === 'true');
}
done();
