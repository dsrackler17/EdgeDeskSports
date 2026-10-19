#!/usr/bin/env node
/* ===========================================================================
   THE NFL MARKET STRUCTURE STUDIES — the preregistration and its registration.

     DOCUMENT  football/market_structure/preregistration.json: four studies,
               each with an objective, training / validation / holdout windows,
               a minimum sample, a success metric, a decision rule and a
               forking-paths disclosure; status EXPERIMENTAL; content_sha256
               pinned (an edit without a new version fails here).
     SQL       supabase/nfl_market_structure_studies.sql is current with the
               document (tools/football/build_prereg_sql.js) and writes no
               result row.
     REGISTRY  the registry's DDL is not in this repository, so the file is run
               against several plausible shapes of it on a real PostgreSQL:
               enums or text, uuid or text keys, date ranges / jsonb / text
               windows — and against two it must REFUSE (a required column it
               cannot fill; an enum with no experimental label), leaving
               nothing behind. A study already registered is left as it is.

     node tools/football/market_structure_prereg.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(__dirname, 'build_prereg_sql.js'));
const PRE = JSON.parse(fs.readFileSync(G.PRE, 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done(extra) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  if (extra) console.log(extra);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ------------------------------------------------------------ DOCUMENT */
chk('content_sha256 covers the studies exactly as registered', crypto.createHash('sha256').update(JSON.stringify(PRE.studies)).digest('hex') === PRE.content_sha256);
chk('the four studies the brief names, in order', JSON.stringify(PRE.studies.map((s) => s.id)) === JSON.stringify(['H-NFL-KEY-01', 'H-NFL-STALE-01', 'H-NFL-OWN-01', 'H-NFL-DIV-01']));
PRE.studies.forEach((s) => {
  const fp = s.forking_paths || {};
  chk(s.id + ': objective, windows, minimum sample, metric, decision rule', !!(s.objective && s.hypothesis && s.training_window && s.validation_window && s.holdout_window
    && s.minimum_sample && s.primary_metric && s.decision_rule));
  chk(s.id + ': forking-paths disclosure (alternatives, choice, data already seen, comparisons, stopping rule)', Array.isArray(fp.alternatives_considered) && fp.alternatives_considered.length > 0
    && fp.choice_and_reason && fp.data_already_seen && fp.comparisons_made === 1 && fp.stopping_rule);
  chk(s.id + ': EXPERIMENTAL, T3, a version, a numeric minimum sample, alpha 0.0125', s.machine && s.machine.status === 'EXPERIMENTAL' && s.machine.provenance === 'T3'
    && s.machine.version === '1.0.0-prereg' && Number.isInteger(s.machine.minimum_sample) && s.machine.minimum_sample > 0 && s.machine.alpha_one_sided === 0.0125);
  chk(s.id + ': passed = true is the only gate, and it is on the holdout', /passed = true only if/.test(s.decision_rule) && /holdout/.test(s.decision_rule));
  const W = s.machine.window_dates;
  chk(s.id + ': validation and holdout windows are in order and never overlap', W.validation && W.holdout && W.validation[0] < W.validation[1] && W.holdout[0] < W.holdout[1]
    && (W.validation[1] <= W.holdout[0] || W.holdout[1] <= W.validation[0]) && (!W.training || W.training[1] <= W.validation[0]));
  chk(s.id + ': the holdout starts after registration (no holdout is touched before it is registered)', W.holdout[0] > PRE.registered_at);
});
chk('H-NFL-STALE-01 rules out the circular flag (the flag at the close is never the treatment)', /never the treatment/.test(PRE.studies[1].decision_time) && /circular/.test(PRE.studies[1].forking_paths.choice_and_reason));
chk('H-NFL-OWN-01 records its ownership thresholds now', PRE.studies[2].thresholds && PRE.studies[2].thresholds.low_ownership_share_of_game_max === 0.3 && PRE.studies[2].thresholds.high_ownership_share_of_game_min === 0.7);
chk('H-NFL-OWN-01 is descriptive until its sample supports a test', /60 graded lopsided games/.test(PRE.studies[2].descriptive_until));
chk('the frozen protocol is stated: nothing feeds the engine until passed = true', /passed = true/.test(PRE.frozen_protocol) && /ONE module/.test(PRE.frozen_protocol));

/* ----------------------------------------------------------------- SQL */
const SQL = fs.readFileSync(G.OUT, 'utf8');
chk('the SQL is current with the document', SQL === G.build());
chk('no psql meta-command', !/^\s*\\/m.test(SQL));
chk('it writes no result row (no statement names the results table; only the document\'s own text mentions it)',
  !/insert into[^;]*research_model_results/i.test(SQL) && !/public\.research_model_results/.test(SQL.replace(/\$prereg\$[\s\S]*?\$prereg\$/, '')));
chk('it never updates or deletes a registry row', !/\b(update|delete from|truncate)\b[^;]*research_model/i.test(SQL));

const { findPgBin, startCluster } = require(path.join(ROOT, 'tools', 'collective', 'pg_harness.js'));
const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary: the registry layer did not run');
const pg = startCluster(BIN, 'prereg');
if (!pg.ok) done('NOTE | could not start postgres: ' + pg.why);
const staged = pg.stage(G.OUT);
function runIn(db, sql) { const f = path.join(os.tmpdir(), 'pr_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.sql'); fs.writeFileSync(f, sql); const s = pg.stage(f); fs.unlinkSync(f); return pg.psql('-d ' + db + ' -X -q -t -A -v ON_ERROR_STOP=1 -f ' + s); }
function one(db, sql) { const r = runIn(db, sql); if (r.status !== 0) throw new Error(r.out); return r.out.trim(); }
function apply(db) { return pg.psql('-d ' + db + ' -X -A -t -v ON_ERROR_STOP=1 -f ' + staged); }
const okRows = (out) => out.split('\n').filter((l) => /^H-NFL-/.test(l));

const VIEW_A = `create view public.research_model_current as
  select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
    from public.research_models m
    join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
    left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`;
const SHAPES = {
  /* enums, uuid keys, date-range windows, jsonb spec */
  a: `create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
      create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
      create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text,
        provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
      create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null,
        status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange,
        objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
      create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb,
        computed_at timestamptz not null default now());` + VIEW_A,
  /* text keys as the foreign key, capitalised enum labels, text windows, no spec column */
  b: `create type public.evidence_provenance as enum ('OBSERVED', 'ESTIMATE', 'TRANSFORM', 'RESEARCH_MODEL');
      create type public.model_status as enum ('EXPERIMENTAL', 'VALIDATED', 'RETIRED');
      create table public.research_models (key text primary key, model_name text, model_status public.model_status not null, evidence_provenance public.evidence_provenance,
        goal text, registered_at timestamptz default now());
      create table public.research_model_versions (model text not null references public.research_models (key), model_version text not null,
        model_status public.model_status not null, train_window text, valid_window text, metadata jsonb, notes text, primary key (model, model_version));
      create table public.research_model_results (model text, model_version text, passed boolean, results jsonb);
      create view public.research_model_current as select m.key, m.model_name, v.model_version, v.model_status, v.train_window, v.valid_window, r.passed
        from public.research_models m join public.research_model_versions v on v.model = m.key left join public.research_model_results r on r.model = m.key;`,
  /* a NOT NULL column with no default that nothing here can fill: must refuse, leave nothing */
  c: `create type public.model_status as enum ('experimental', 'validated');
      create table public.research_models (id bigserial primary key, model_key text unique not null, status public.model_status not null, owner_team text not null);
      create table public.research_model_versions (id bigserial primary key, model_id bigint not null references public.research_models (id), version text not null);
      create table public.research_model_results (id bigserial);
      create view public.research_model_current as select m.model_key, m.status from public.research_models m;`,
  /* an enum with no experimental label: must refuse, naming the labels */
  d: `create type public.model_status as enum ('draft', 'live');
      create table public.research_models (id bigserial primary key, model_key text unique not null, status public.model_status not null);
      create table public.research_model_versions (id bigserial primary key, model_id bigint not null references public.research_models (id), version text not null);
      create table public.research_model_results (id bigserial);
      create view public.research_model_current as select m.model_key, m.status from public.research_models m;`
};
Object.keys(SHAPES).forEach((k) => { pg.psql('-d postgres -q -c "create database reg_' + k + '"'); one('reg_' + k, SHAPES[k]); });

/* A */
{
  const r1 = apply('reg_a'), r2 = apply('reg_a');
  chk('A: applies, and again (idempotent)', r1.status === 0 && r2.status === 0, (r1.out + r2.out).slice(-900));
  chk('A: every study reads EXPERIMENTAL with no passing result in research_model_current', okRows(r2.out).length === 4 && okRows(r2.out).every((l) => /\|ok$/.test(l)), okRows(r2.out));
  chk('A: four models, four versions — the second run wrote nothing', one('reg_a', 'select count(*) from public.research_models') === '4' && one('reg_a', 'select count(*) from public.research_model_versions') === '4');
  chk('A: the enum labels came from the live enums (T3, experimental)', one('reg_a', "select string_agg(distinct provenance::text, ',') || '/' || (select string_agg(distinct status::text, ',') from public.research_model_versions) from public.research_models") === 'T3/experimental');
  chk('A: windows landed as date ranges, holdout included', one('reg_a', "select holdout_window::text from public.research_model_versions v join public.research_models m on m.id = v.model_id where m.model_key = 'H-NFL-DIV-01'") === '[2026-10-27,2028-01-12)');
  chk('A: H-NFL-OWN-01 has no training window (none fitted), not a made-up one', one('reg_a', "select coalesce(training_window::text, 'null') from public.research_model_versions v join public.research_models m on m.id = v.model_id where m.model_key = 'H-NFL-OWN-01'") === 'null');
  chk('A: minimum sample, metric, forking paths and the full spec with its sha', one('reg_a', `select string_agg(min_sample || ':' || (forking_paths ? 'alternatives_considered')::text || ':' || (spec ->> 'content_sha256'), ',' order by min_sample)
    from public.research_model_versions`) === ['60', '60', '80', '120'].sort((x, y) => x - y).map((n) => n + ':true:' + PRE.content_sha256).join(','));
  chk('A: no result row exists', one('reg_a', 'select count(*) from public.research_model_results') === '0');
}
/* B */
{
  const r = apply('reg_b');
  chk('B: applies to a text-keyed registry with capitalised labels', r.status === 0, r.out.slice(-900));
  chk('B: every study reads EXPERIMENTAL', okRows(r.out).length === 4 && okRows(r.out).every((l) => /\|ok$/.test(l)), okRows(r.out));
  chk('B: labels EXPERIMENTAL and RESEARCH_MODEL were picked from the live enums', one('reg_b', "select string_agg(distinct model_status::text || '/' || evidence_provenance::text, ',') from public.research_models") === 'EXPERIMENTAL/RESEARCH_MODEL');
  chk('B: text windows carry the written description', /2026 Week 8/.test(one('reg_b', "select valid_window from public.research_model_versions where model = 'H-NFL-KEY-01'")));
}
/* C */
{
  const r = apply('reg_c');
  chk('C: a required column it cannot fill stops the file, naming it', r.status !== 0 && /owner_team/.test(r.out), r.out.slice(-500));
  chk('C: and nothing was written', one('reg_c', 'select count(*) from public.research_models') === '0');
}
/* D */
{
  const r = apply('reg_d');
  chk('D: an enum with no experimental label stops the file, naming its labels', r.status !== 0 && /draft, live/.test(r.out), r.out.slice(-500));
  chk('D: and nothing was written', one('reg_d', 'select count(*) from public.research_models') === '0');
}
/* E: a study someone already registered (and moved on) is left exactly as it is */
{
  pg.psql('-d postgres -q -c "create database reg_e"');
  one('reg_e', SHAPES.a);
  one('reg_e', `insert into public.research_models (model_key, name, provenance) values ('H-NFL-DIV-01', 'kept', 'T3');
    insert into public.research_model_versions (model_id, version, status) select id, '1.0.0-prereg', 'validated' from public.research_models;`);
  const r = apply('reg_e');
  chk('E: applies', r.status === 0, r.out.slice(-600));
  chk('E: the existing study is untouched (name and status as they were)', one('reg_e', "select m.name || '/' || v.status from public.research_models m join public.research_model_versions v on v.model_id = m.id where m.model_key = 'H-NFL-DIV-01'") === 'kept/validated');
  chk('E: and the report says so instead of reading ok', okRows(r.out).filter((l) => /^H-NFL-DIV-01/.test(l))[0].indexOf('CHECK THIS: status reads validated') > 0, okRows(r.out));
}
/* F: no registry at all */
{
  pg.psql('-d postgres -q -c "create database reg_f"');
  const r = apply('reg_f');
  chk('F: no registry: the file refuses and says the registry is missing', r.status !== 0 && /research registry .* is not in this database/.test(r.out), r.out.slice(-300));
}
done();
