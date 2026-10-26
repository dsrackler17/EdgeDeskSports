#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/ncaaw_forecast.sql on a REAL PostgreSQL (tools/personal/_pg.js:
   a throwaway cluster with the Supabase shim's roles and auth.uid()), with
   supabase/simulator.sql applied first (its fail-closed premium gate).

   The publisher under test is the real one (publish.js) talking through a
   psql-backed adapter, so the RPCs a GitHub Actions job calls over PostgREST
   are the ones exercised here. Failures are injected at the storage boundary.

     node basketball/ncaaw_forecast/tests/sql.test.js     (NCAAW_SQL_REQUIRED=1 in CI)
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const T = require('./_kit').kit('ncaaw forecast SQL layer');
const F = (n) => path.join(ROOT, 'supabase', n);
const SQL = fs.readFileSync(F('ncaaw_forecast.sql'), 'utf8');

T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261024180000_ncaaw_forecast.sql'), 'utf8') === SQL);
T.chk('no psql meta-command in the file', !/^\s*\\/m.test(SQL));
T.chk('the file never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(SQL));
T.chk('no service-role key or secret in the file', !/service_role_key|Bearer\s|eyJhbGci/i.test(SQL));
T.chk('no object is named cbb (college baseball owns that name)', !/(^|[^a-z_])cbb\.|\bcbb_(?!model_notes)/i.test(SQL.replace(/--.*$/gm, '')));
T.chk('the women\'s file never names a men\'s object (ncaam_fc_*)', !/ncaam_fc/.test(SQL.replace(/--.*$/gm, '')));
T.chk('...and is the men\'s layer with the women\'s names, less only the live-observation read (no women\'s slate feed)', (() => {
  const code = (t) => t.replace(/--.*$/gm, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  let men = fs.readFileSync(F('ncaam_forecast.sql'), 'utf8').replace(/ncaam/g, 'ncaaw');
  const a = men.indexOf('create or replace function public.ncaaw_fc_live_observations('); const b = men.indexOf('end $$;', a) + 'end $$;'.length;
  men = men.slice(0, a) + men.slice(b);
  men = men.replace("'public.ncaaw_fc_put_live(jsonb)', 'public.ncaaw_fc_live_observations(integer)', ", "'public.ncaaw_fc_put_live(jsonb)', ");
  return a > 0 && code(men) === code(SQL);
})());

const db = PG.start('ncaawsql');
if (db.skip) {
  if (process.env.NCAAW_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the live SQL layer did not run');
  process.exit(T.done());
}
const lit = PG.lit;
const SUB = '00000000-0000-0000-0000-0000000000aa', NOSUB = '00000000-0000-0000-0000-0000000000bb', LAPSED = '00000000-0000-0000-0000-0000000000cc';
const semi = (q) => (q.trim().endsWith(';') ? q : q + ';');
const svc = (q) => db.service(semi(q));
const asU = (u, q) => db.as(u, semi(q));
const fails = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const JSONB = new Set(['p', 'p_rows', 'p_error']), UUID = new Set(['p_run', 'p_job']);
function pgDb(faults) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push(name);
      if (faults && faults.failName === name) throw new Error('INJECTED FAULT at ' + name);
      const parts = Object.entries(args).map(([k, v]) => (JSONB.has(k) ? lit(JSON.stringify(v)) + '::jsonb' : UUID.has(k) ? lit(String(v)) + '::uuid' : lit(String(v))));
      if (name === 'ncaaw_fc_public_status') return J(svc("select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.ncaaw_fc_public_status() s;"));
      return J(svc('select to_jsonb(public.' + name + '(' + parts.join(', ') + '));'));
    },
  };
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* a temporary registry: the incumbent INIT, then a PROMOTE backed by a report */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaawreg-'));
process.env.NCAAW_REGISTRY_DIR = path.join(TMP, 'registry');
process.env.NCAAW_REPORTS_DIR = path.join(TMP, 'reports');
const RG = require('../registry');
const PUB = require('../publish');

(async () => {
  try {
    const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8');
    const i0 = BH.indexOf('create or replace function public.billing_row_grants_access('), i1 = BH.indexOf('$$;', i0) + 3;
    db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
      ${BH.slice(i0, i1)}
      create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
        select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
      insert into auth.users (id, email) values (${lit(SUB)}, 'sub@x'), (${lit(NOSUB)}, 'free@x'), (${lit(LAPSED)}, 'lapsed@x');
      insert into public.subscriptions values (${lit(SUB)}, 'active', 'price_x', now() + interval '20 days'), (${lit(LAPSED)}, 'past_due', 'price_x', now() - interval '30 days');`);

    T.chk('the file refuses to run without simulator.sql', !!fails(() => db.applyFile(F('ncaaw_forecast.sql'))));
    let out = db.applyFile(F('simulator.sql'));
    T.chk('simulator.sql applies first', !/CHECK THIS/.test(out));
    out = db.applyFile(F('ncaaw_forecast.sql'));
    T.chk('the file applies and every report row says ok', /\bok\b/.test(out) && !/CHECK THIS/.test(out), out.slice(-700));
    out = db.applyFile(F('ncaaw_forecast.sql'));
    T.chk('applying it again changes nothing and still reports ok', !/CHECK THIS/.test(out));

    /* ---- the registry, replayed into the database ---- */

    const challenger = { schema: 'edgedesk_ncaaw_fc_model_v1', model_id: 'ncaaw_adjeff', version: '1.0.0', engine: 'research_team_model', config: { engine: 'research_team_model', params: { lambda: 300 }, calibration: {} },
      training_snapshot: { through: '2026-10-23T00:00:00.000Z', rows: 100, sha256: sha('snap'), seasons: [2026] } };
    challenger.config_sha256 = sha(JSON.stringify(challenger.config)); challenger.code_sha256 = sha('code');
    const rep = { schema: 'edgedesk_ncaaw_fc_weekly_report_v1', date: '2026-10-23', candidate: 'selection_v1', champion: RG.readPointer().current.key,
      challenger: { model_id: 'ncaaw_adjeff', version: '1.0.0', engine: 'research_team_model' }, policy_version: '1.0.0',
      result: { decision: 'PROMOTE', gates: [{ id: 'G1_min_sample', pass: true, detail: 'x' }], challenger: { n: 1 }, champion: { n: 1 }, shared_games: 1, seasons: [2026] } };
    fs.mkdirSync(process.env.NCAAW_REPORTS_DIR, { recursive: true });
    const repFile = path.join(process.env.NCAAW_REPORTS_DIR, '2026-10-23-selection_v1.json'); const repText = JSON.stringify(rep, null, 1) + '\n'; fs.writeFileSync(repFile, repText);
    T.throws('promote() refuses a decision that is not PROMOTE', () => RG.promote(challenger, { decision: 'RETAIN', file: repFile, report_sha256: sha(repText) }), /refused/);
    /* as weekly.js does: the candidate's decision record first (champion = the champion it was scored against), then the pointer move */
    RG.recordDecision({ decision: 'PROMOTE', candidate: 'selection_v1', challenger: 'ncaaw_adjeff@1.0.0', champion: RG.readPointer().current.key, report: repFile, report_sha256: sha(repText), gates_failed: [] });
    RG.promote(challenger, { decision: 'PROMOTE', file: repFile, report_sha256: sha(repText) });
    const d0 = pgDb();
    const s1 = await PUB.syncChampion(d0);
    T.eq('the database champion follows the repository', s1, { synced: true, champion: 'ncaaw_adjeff@1.0.0' });
    T.eq('history: INIT then PROMOTE', svc("select string_agg(decision, ',' order by id) from public.ncaaw_fc_champion_history;").trim(), 'INIT,PROMOTE');
    T.eq('a second sync is a no-op', await PUB.syncChampion(pgDb()), { synced: false, champion: 'ncaaw_adjeff@1.0.0' });

    /* ---- the champion cannot be moved without a matching PROMOTE report ---- */
    svc(`select public.ncaaw_fc_record_model(${lit(JSON.stringify({ model_id: 'ncaaw_adjeff', version: '1.1.0', engine: 'research_team_model', config: { x: 1 }, config_sha256: sha('x') }))}::jsonb);`);
    svc(`select public.ncaaw_fc_record_report(${lit(JSON.stringify({ report_sha256: sha('retain'), candidate: 'c', champion_key: 'ncaaw_adjeff@1.0.0', challenger_key: 'ncaaw_adjeff@1.1.0', decision: 'RETAIN', policy_version: '1.0.0', gates: [] }))}::jsonb);`);
    T.chk('PROMOTE with a RETAIN report is refused', /not PROMOTE/.test(fails(() => svc(`select public.ncaaw_fc_set_champion(${lit(JSON.stringify({ decision: 'PROMOTE', model_key: 'ncaaw_adjeff@1.1.0', report_sha256: sha('retain') }))}::jsonb);`)) || ''));
    T.chk('PROMOTE without any stored report is refused', /no stored report/.test(fails(() => svc(`select public.ncaaw_fc_set_champion(${lit(JSON.stringify({ decision: 'PROMOTE', model_key: 'ncaaw_adjeff@1.1.0', report_sha256: sha('nothing') }))}::jsonb);`)) || ''));
    T.chk('the same model key with another configuration is refused', /another configuration/.test(fails(() => svc(`select public.ncaaw_fc_record_model(${lit(JSON.stringify({ model_id: 'ncaaw_adjeff', version: '1.1.0', engine: 'research_team_model', config: { x: 2 }, config_sha256: sha('y') }))}::jsonb);`)) || ''));
    T.eq('the champion is unchanged after the refusals', svc("select model_key from public.ncaaw_fc_champion;").trim(), 'ncaaw_adjeff@1.0.0');
    T.chk('an authenticated client cannot move the champion', !!fails(() => asU(SUB, `select public.ncaaw_fc_set_champion('{"decision":"INIT","model_key":"ncaaw_adjeff@1.0.0"}'::jsonb)`)));

    /* ---- forecasts: publish, idempotency, failure, supersede ---- */
    const fc = (gid, p) => ({ game_id: gid, start_utc: '2026-11-03T00:00:00Z', home_id: '1', away_id: '2', home_name: 'Home <b>U</b>', away_name: 'Away', neutral: false, event: 'regular', regime: 'D1_D1',
      available: true, p_home: p, p_away: 1 - p, p_ot: 0.06, margin: { mean: 4, sd: 11, q05: -14, q10: -10, q50: 4, q90: 18, q95: 22 }, total: { mean: 140, sd: 15, q05: 116, q10: 121, q50: 140, q90: 159, q95: 165 },
      pts_home: 72, pts_away: 68, games_played: { home: 3, away: 4 }, data_quality: ['EARLY_SEASON_FEW_GAMES'], availability_assumption: 'not modelled', upset: { underdog: 'away', basis: 'model', p_underdog: 1 - p, signals: ['upset_probability'], factors: null } });
    const doc = (asOf, games, gates) => ({ as_of: asOf, model: { key: 'ncaaw_adjeff@1.0.0' }, artifact: { sha256: sha('art' + asOf), training_snapshot: { sha256: sha('snap') } }, definitions: { p_home: 'x' }, upset_policy: { version: 1 },
      gates: gates || [{ id: 'run.finite', pass: true, detail: 'ok' }], forecasts: games });
    const d1 = await PUB.publishForecasts(doc('2026-11-02T12:00:00Z', [fc('401000001', 0.64), fc('401000002', 0.71)]), { db: pgDb() });
    T.chk('a forecast run publishes', d1.published && d1.status === 'completed', d1);
    T.eq('the subscriber reads both forecasts', asU(SUB, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '2');
    T.eq('a free account reads nothing', asU(NOSUB, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '0');
    T.eq('a lapsed account reads nothing', asU(LAPSED, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '0');
    T.chk('anon cannot read forecasts', !!fails(() => db.anon('select count(*) from public.ncaaw_fc_forecasts;')));
    T.chk('the stored text is returned as text (escaping is the reader\'s job)', /<b>U<\/b>/.test(asU(SUB, "select home_name from public.ncaaw_fc_current_forecasts limit 1")));
    const again = await PUB.publishForecasts(doc('2026-11-02T12:00:00Z', [fc('401000001', 0.64), fc('401000002', 0.71)]), { db: pgDb() });
    T.chk('the same forecasts again publish nothing new', again.existing && !again.published, again);
    const pub0 = svc("select run_id from public.ncaaw_fc_published;").trim();
    let err = null; try { await PUB.publishForecasts(doc('2026-11-02T18:00:00Z', [fc('401000003', 0.55)]), { db: pgDb({ failName: 'ncaaw_fc_put_upset' }) }); } catch (e) { err = e; }
    T.chk('a storage failure surfaces', !!err && /INJECTED/.test(err.message));
    T.eq('a failed upload never moves the pointer', svc("select run_id from public.ncaaw_fc_published;").trim(), pub0);
    T.eq('the failed run is recorded failed', svc("select status from public.ncaaw_fc_runs order by created_at desc limit 1;").trim(), 'failed');
    T.eq('its rows are invisible to readers', asU(SUB, "select count(*) from public.ncaaw_fc_forecasts f join public.ncaaw_fc_runs r using (run_id) where r.status = 'failed'").trim(), '0');
    err = null; try { await PUB.publishForecasts(doc('2026-11-02T19:00:00Z', [fc('401000004', 0.5)], [{ id: 'data.fresh', pass: false, detail: 'stale' }]), { db: pgDb() }); } catch (e) { err = e; }
    T.chk('a failing gate blocks publication in the database', !!err && /refused/.test(err.message));
    T.eq('...and the pointer stays', svc("select run_id from public.ncaaw_fc_published;").trim(), pub0);
    const older = await PUB.publishForecasts(doc('2026-11-01T12:00:00Z', [fc('401000005', 0.6)]), { db: pgDb() });
    T.eq('older inputs are kept as superseded, not shown', older.status, 'superseded');
    T.eq('...and the pointer stays', svc("select run_id from public.ncaaw_fc_published;").trim(), pub0);
    /* an exhibition, as basketball/exhibitions.js shapes it: an 18-digit id, a non-Division I opponent with no ESPN id, no Upset Watch row */
    const exh = Object.assign(fc('912345678901234567', 0.97), { away_id: 'x-pittsburg-st', away_name: 'Pittsburg State', event: 'exhibition', regime: 'D1_OTHER', data_quality: ['EXHIBITION', 'PRESEASON_RATINGS'], upset: undefined });
    const newer = await PUB.publishForecasts(doc('2026-11-03T12:00:00Z', [fc('401000006', 0.6), exh]), { db: pgDb() });
    T.chk('newer inputs replace the published run', newer.published && svc("select previous_run_id from public.ncaaw_fc_published;").trim() === pub0);
    T.eq('an exhibition publishes and reads back as one, with no Upset Watch row', asU(SUB, "select event || '|' || away_id || '|' || regime || '|' || coalesce(underdog, '-') || '|' || (data_quality ->> 0) from public.ncaaw_fc_current_forecasts where game_id = '912345678901234567'").trim(), 'exhibition|x-pittsburg-st|D1_OTHER|-|EXHIBITION');
    T.chk('a published forecast is frozen (update refused)', !!fails(() => svc("update public.ncaaw_fc_forecasts set p_home = 0.9;")));
    T.chk('a published forecast is frozen (delete refused)', !!fails(() => svc("delete from public.ncaaw_fc_forecasts;")));
    T.chk('truncate is refused', !!fails(() => svc('truncate public.ncaaw_fc_forecasts cascade;')));
    T.chk('a probability of 1 is refused by the table', !!fails(() => svc(`select public.ncaaw_fc_begin_run('{"idempotency_key":"${sha('bad')}","model_key":"ncaaw_adjeff@1.0.0","artifact_sha256":"${sha('a')}","snapshot_sha256":"${sha('s')}","as_of":"2026-11-04T00:00:00Z","expected_games":1}'::jsonb);
      insert into public.ncaaw_fc_forecasts (run_id, game_id, start_utc, home_id, away_id, home_name, away_name, neutral, regime, available, p_home, p_ot, margin, total, availability_assumption)
      select run_id, '1', now(), '1', '2', 'a', 'b', false, 'D1_D1', true, 1.0, 0.05, '{"mean":1,"q10":0,"q90":2}', '{"mean":1,"q10":0,"q90":2}', 'x' from public.ncaaw_fc_runs where status = 'running';`)));
    T.chk('a model that is not the champion cannot publish', !!(await PUB.publishForecasts(Object.assign(doc('2026-11-05T00:00:00Z', [fc('401000007', 0.6)]), { model: { key: 'ncaaw_adjeff@1.1.0' } }), { db: pgDb() }).catch((e) => e)).message);

    /* ---- live ---- */
    const live = { game_id: '401000006', model_key: 'ncaaw_adjeff@1.0.0', observed_at: '2026-11-03T13:00:00Z', period: 2, clock_s: 300, home_score: 50, away_score: 55, feed_age_s: 20, feed_ok: true, p_home_pregame: 0.6, p_home_live: 0.3, live_model: 'score_time' };
    T.chk('live writes are refused while live is disabled', /disabled/.test(fails(() => svc(`select public.ncaaw_fc_put_live(${lit(JSON.stringify(live))}::jsonb);`)) || ''));
    svc("update public.ncaaw_fc_config set value = 'true' where key = 'live_enabled';");
    svc(`select public.ncaaw_fc_put_live(${lit(JSON.stringify(live))}::jsonb);`);
    T.chk('a suppressed (stale) observation cannot carry a live probability', !!fails(() => svc(`select public.ncaaw_fc_put_live(${lit(JSON.stringify(Object.assign({}, live, { feed_ok: false })))}::jsonb);`)));
    svc(`select public.ncaaw_fc_put_live(${lit(JSON.stringify(Object.assign({}, live, { feed_ok: false, p_home_live: null, suppressed_reasons: ['stale: 400 s old'] })))}::jsonb);`);
    T.eq('the subscriber reads the latest live row', asU(SUB, "select feed_ok from public.ncaaw_fc_current_live where game_id = '401000006'").trim(), 'f');
    T.chk('live rows are append-only', !!fails(() => svc('update public.ncaaw_fc_live_forecasts set p_home_live = 0.5;')));
    svc("update public.ncaaw_fc_config set value = 'false' where key = 'live_enabled';");

    /* ---- the research registry (deployed-only tables, built here as simulator/tests/sql.test.ts block 14 builds them) ---- */
    const REGSQL = F('ncaaw_forecast_registry.sql');
    const regs = ['registration_forecast.json'].map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball', 'ncaaw_forecast', 'research', f), 'utf8')));
    T.chk('the registration is T3 / EXPERIMENTAL with criteria, limitations and no result', regs.every((r) => r.provenance === 'T3' && r.status === 'EXPERIMENTAL' && r.result === null && r.promotion_criteria.criteria.length >= 3 && r.spec.known_limitations.length >= 3));
    T.chk('no women\'s tournament simulation is registered (none is built)', !fs.existsSync(path.join(ROOT, 'basketball', 'ncaaw_forecast', 'research', 'registration_tournament.json')) && !/TOURNAMENT/.test(fs.readFileSync(REGSQL, 'utf8').replace(/--.*$/gm, '').replace(/"[^"]*"/g, '')));
    T.chk('without the research registry the file refuses and registers nothing', /research registry/.test(fails(() => db.applyFile(REGSQL)) || '') && svc("select count(*) from public.ncaaw_fc_config where key like '%research_model%'") === '0');
    db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
      create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
      create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
      create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
      create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
      create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
        from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
        left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
    let regOut = db.applyFile(REGSQL);
    T.chk('the registration applies and reports ok', !/CHECK THIS/.test(regOut) && (regOut.match(/\bok\b/g) || []).length >= 2, regOut.slice(-400));
    regOut = db.applyFile(REGSQL);
    T.chk('registering twice changes nothing', !/CHECK THIS/.test(regOut) && svc('select count(*) from public.research_models') === '1' && svc('select count(*) from public.research_model_versions') === '1');
    const regRows = J(svc("select jsonb_agg(to_jsonb(x) order by x.model_key) from (select m.model_key, m.provenance, v.status, v.version from public.research_models m join public.research_model_versions v on v.model_id = m.id) x"));
    T.eq('NCAAW-FORECAST 1.0.0, T3 / experimental', regRows.map((r) => [r.model_key, r.version, r.provenance, r.status].join(' ')), ['NCAAW-FORECAST 1.0.0 T3 experimental']);
    T.eq('no result row is written (nothing is promoted)', svc('select count(*) from public.research_model_results'), '0');
    T.eq('the config names the registered version', svc("select string_agg(key || '=' || value, ',' order by key) from public.ncaaw_fc_config where key in ('forecast_research_model_version', 'tournament_research_model_version')"), 'forecast_research_model_version=1.0.0');

    /* ---- the men's layer beside it: two systems, two champions, no shared row ---- */
    out = db.applyFile(F('ncaam_forecast.sql'));
    T.chk('the men\'s file applies in the same database', !/CHECK THIS/.test(out));
    T.eq('the men\'s champion table starts empty: the women\'s champion is not the men\'s', svc('select count(*) from public.ncaam_fc_champion'), '0');
    T.chk('a women\'s model cannot become the men\'s champion (unknown to the men\'s registry)', /not recorded/.test(fails(() => svc(`select public.ncaam_fc_set_champion('{"decision":"INIT","model_key":"ncaaw_adjeff@1.0.0"}'::jsonb)`)) || ''));
    T.eq('...and the women\'s champion is unchanged', svc('select model_key from public.ncaaw_fc_champion;').trim(), 'ncaaw_adjeff@1.0.0');

    /* ---- what anyone may know ---- */
    const st = db.anon('select champion_key, live_enabled from public.ncaaw_fc_public_status();');
    T.chk('anon reads the status (versions, never numbers)', /ncaaw_adjeff@1\.0\.0/.test(st) && !/0\.6/.test(st), st);
    T.chk('anon cannot call a job function', !!fails(() => db.anon("select public.ncaaw_fc_publish_run('00000000-0000-0000-0000-000000000000');")));
    T.chk('a subscriber cannot call a job function', !!fails(() => asU(SUB, "select public.ncaaw_fc_put_live('{}'::jsonb)")));
    T.chk('jobs and alerts are invisible to subscribers', !!fails(() => asU(SUB, 'select count(*) from public.ncaaw_fc_alerts')));
    T.eq('the subscriber reads model health', asU(SUB, 'select model_key from public.ncaaw_fc_model_health').trim(), 'ncaaw_adjeff@1.0.0');
    T.eq('a free account reads no model health', asU(NOSUB, 'select count(*) from public.ncaaw_fc_model_health').trim(), '0');

    /* ---- fail closed when the entitlement authority is missing ---- */
    db.sql('alter function public.community_is_entitled(uuid) rename to community_is_entitled_off;');
    T.eq('without community_is_entitled the billing rule still decides (the subscriber reads the published run: a game and an exhibition)', asU(SUB, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '2');
    T.eq('...and the free account still reads nothing', asU(NOSUB, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '0');
    db.sql('alter function public.billing_row_grants_access(text,text,timestamptz,timestamptz) rename to billing_row_grants_access_off;');
    T.eq('with no entitlement authority at all nobody reads (fail closed)', asU(SUB, 'select count(*) from public.ncaaw_fc_current_forecasts').trim(), '0');
    db.sql('alter function public.billing_row_grants_access_off(text,text,timestamptz,timestamptz) rename to billing_row_grants_access; alter function public.community_is_entitled_off(uuid) rename to community_is_entitled;');
  } catch (e) {
    T.chk('the suite ran without an unexpected error', false, String(e.stack || e).slice(0, 1200));
  } finally {
    db.stop();
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(T.done());
  }
})();
