#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY registration — registered before any result exists.

     static  the registration is EXPERIMENTAL / T3 with no result; its windows
             are ordered and disjoint (training < retrospective holdout <
             prospective promotion window), 2020-21 is excluded, the holdouts
             are named and only the prospective one promotes; the promotion
             criteria, minimum samples, selection rule and weekly-learning rule
             are present; the registered configuration is pinned by sha256;
             conviction thresholds are registered and no stake is displayed;
             the word "lock" appears nowhere; the generated SQL is current
     live    on a real PostgreSQL with a stand-in research registry (the
             deployed-only tables, as simulator/tests/sql.test.ts builds them):
             it refuses without the registry, applies, reports ok, applies
             twice without a second row, and writes no result row
   NCAAM_EARLY_SQL_REQUIRED=1 (CI): a missing PostgreSQL FAILS, never skips.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', '..', '..', 'tools', 'personal', '_pg.js'));

const T = PG.kit('NCAAM-EARLY registration');
const ROOT = PG.ROOT;
const DIR = path.join(ROOT, 'basketball', 'ncaam_early');
const REG = JSON.parse(fs.readFileSync(path.join(DIR, 'research', 'registration.json'), 'utf8'));
const CFG_RAW = fs.readFileSync(path.join(DIR, 'config', 'model_v0.json'));
const CFG = JSON.parse(CFG_RAW);
const OUT = path.join(ROOT, 'supabase', 'ncaam_early_registry.sql');

/* ═══ static ═════════════════════════════════════════════════════════════ */
T.chk('EXPERIMENTAL, T3, version 0.1.0, and no result', REG.status === 'EXPERIMENTAL' && REG.provenance === 'T3' && REG.version === '0.1.0' && REG.result === null && REG.machine.status === 'EXPERIMENTAL');
T.chk('the model key and id match the data layer', REG.model_key === 'NCAAM-EARLY' && REG.model_id === 'edgedesk_ncaam_early_v1' && CFG.model_id === REG.model_id);
const W = REG.machine.window_dates;
const d = (x) => Date.parse(x + 'T00:00:00Z');
T.chk('windows: training < retrospective holdout < prospective window, disjoint', d(W.training[1]) <= d(W.validation[0]) && d(W.validation[1]) <= d(W.holdout[0]) && W.training.every((x) => d(x)) && d(W.holdout[0]) === d('2026-11-01'));
T.chk('training excludes 2020-21 and says why, before anything ran', /2020-21 \(END year 2021\) is EXCLUDED before anything is run/.test(REG.training_window));
T.chk('the retrospective holdout is scored once, descriptive, and cannot promote', /Scored ONCE/.test(REG.validation_window) && /cannot promote/.test(REG.validation_window) && /^promote, change thresholds/.test(REG.retrospective_holdout_report.cannot));
T.chk('only the prospective window promotes', /only window that counts for promotion/.test(REG.holdout_window));
const ids = REG.promotion_criteria.criteria.map((c) => c.id);
T.chk('promotion criteria C1 CLV .. C5 are registered, all required', ids.join() === 'C1_CLV,C2_CALIBRATION_VS_MARKET,C3_NOT_WORSE_THAN_INCUMBENT,C4_HONEST_UNCERTAINTY,C5_TIERS_ORDERED' && /intersection test/.test(REG.promotion_criteria.family_correction));
T.chk('C1: mean CLV > 0 with the 95% lower bound > 0 on >= 300 bets', /> 0, and the 95% game-day cluster bootstrap lower bound > 0, on >= 300 bets/.test(REG.promotion_criteria.criteria[0].rule) && REG.minimum_sample.prospective_flagged_bets_with_captured_close === 300 && REG.machine.minimum_sample === 300);
T.chk('an unevaluable criterion is not met; weekly learning never promotes', /cannot be evaluated is not met/.test(REG.promotion_criteria.decision_rule) && /never promotes/.test(REG.promotion_criteria.decision_rule));
T.chk('selection: training windows only, frozen before the holdout, thresholds not selected', REG.selection_rule.data === 'the training windows only' && /BEFORE the retrospective holdout is scored/.test(REG.selection_rule.freeze) && /Conviction thresholds are NOT selected/.test(REG.selection_rule.procedure));
T.chk('weekly learning: changes only through a new registered version; the forbidden list is registered', /NEW registered version/.test(REG.weekly_learning.may_change) && /mid-week/.test(REG.weekly_learning.never) && /promote on short-term live results/.test(REG.weekly_learning.never));
T.chk('forking paths: nothing tried, nothing compared, prior evidence disclosed', REG.forking_paths.candidates_tried.length === 0 && REG.forking_paths.comparisons_made === 0 && /transfer_beta/.test(REG.forking_paths.data_already_seen) && /2025-26 season/.test(REG.forking_paths.data_already_seen));
T.chk('the registered configuration is pinned by sha256', REG.spec.config_sha256 === crypto.createHash('sha256').update(CFG_RAW).digest('hex'));
T.chk('conviction thresholds are registered (3% / 1.5% / 0.5%) with the four tiers', CFG.conviction.thresholds.edge_high === 0.03 && CFG.conviction.thresholds.edge_low === 0.015 && CFG.conviction.thresholds.edge_floor === 0.005 && ['HIGH', 'MEDIUM', 'LOW', 'PASS'].every((k) => CFG.conviction.tiers[k]));
T.chk('units are internal grading only; no stake is displayed', /never displayed/.test(CFG.conviction.internal_grading_units.note) && /no unit or stake/i.test(REG.spec.display) && /No unit or stake/.test(REG.objective));
T.chk('every angle tag is defined', ['continuity_gap', 'transfer_translation', 'coach_change', 'departed_production', 'pace_coach_history', 'size_mismatch', 'price_only'].every((k) => typeof CFG.angle_tags[k] === 'string'));
T.chk('every selectable value lists its candidates (nothing open-ended)', (() => { const bad = []; (function walk(o, p) { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === 'object') { if ('value' in v && 'selectable' in v && v.selectable !== false && !Array.isArray(v.selectable)) bad.push(p + k); walk(v, p + k + '.'); } } })(CFG, ''); return bad.length === 0; })());
T.chk('no third-party rating is an input (T1 none)', /T1 none/.test(REG.spec.evidence_tiers));
const text = JSON.stringify(REG) + CFG_RAW.toString();
T.chk('the word "lock" appears nowhere (nor "guaranteed", "best bet")', !/\block\b|guaranteed|best bet/i.test(text));
let stale = null;
try { cp.execFileSync('node', [path.join(DIR, 'research', 'build_registry_sql.js'), '--check'], { stdio: 'pipe' }); } catch (e) { stale = String(e.stdout || e.message); }
T.chk('the generated registry SQL is current', stale === null, stale);
const SQL = fs.readFileSync(OUT, 'utf8');
T.chk('the generated SQL is pasteable and writes no result row', !/^\s*\\/m.test(SQL) && !/insert into public\.research_model_results/i.test(SQL));

/* ═══ live ═══════════════════════════════════════════════════════════════ */
const db = PG.start('ncaamearlyreg');
if (db.skip) {
  if (process.env.NCAAM_EARLY_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did NOT run (not verified)');
  process.exit(T.done());
}
try {
  T.chk('live · without the research registry the file refuses and registers nothing', !!db.mustFail(() => db.applyFile(OUT)));
  db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
    create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
    create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
    create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
    create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
    create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
      from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
      left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
  let out = db.applyFile(OUT);
  T.chk('live · it applies and the report says ok', /ok/.test(out) && !/CHECK THIS/.test(out), out.slice(-600));
  out = db.applyFile(OUT);
  T.chk('live · a second application adds nothing', !/CHECK THIS/.test(out) && db.sql('select count(*) from public.research_models') === '1' && db.sql('select count(*) from public.research_model_versions') === '1');
  const row = JSON.parse(db.sql("select to_jsonb(x) from (select m.model_key, m.sport, m.provenance, v.version, v.status, v.min_sample, v.success_metric, v.promotion_criteria -> 'criteria' -> 0 ->> 'id' as c1, v.training_window::text as tw, v.validation_window::text as vw, v.holdout_window::text as hw, v.spec ->> 'config_sha256' as csha, v.forking_paths ->> 'comparisons_made' as cmp from public.research_models m join public.research_model_versions v on v.model_id = m.id) x"));
  T.chk('live · the version row: T3 / experimental / 0.1.0, C1 CLV, 300, the three windows, the config sha, 0 comparisons',
    row.model_key === 'NCAAM-EARLY' && row.sport === 'NCAAM' && row.provenance === 'T3' && row.status === 'experimental' && row.version === '0.1.0' && row.c1 === 'C1_CLV' && row.min_sample === 300
    && /2019-11-01,2024-12-16/.test(row.tw) && /2025-11-01,2025-12-16/.test(row.vw) && /2026-11-01,2026-12-16/.test(row.hw) && row.csha === REG.spec.config_sha256 && row.cmp === '0', row);
  T.chk('live · no result row (nothing is promoted)', db.sql('select count(*) from public.research_model_results') === '0');
  T.chk('live · research_model_current reads it as experimental with no result', db.sql("select status::text || '|' || coalesce(passed::text, 'null') from public.research_model_current where model_key = 'NCAAM-EARLY'") === 'experimental|null');
} catch (e) {
  T.chk('the LIVE layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
