#!/usr/bin/env node
/* ===========================================================================
   The NBA roster and injury layer on a real PostgreSQL
   (supabase/nba_injury_layer.sql, nba_roster_adjusted_registry.sql,
   nba_injury_cron.sql, nba_injury_layer_rollback.sql).

     node tools/nba/nba_injury_sql.test.js     (NBA_SQL_REQUIRED=1 in CI)

   Applies the layer twice (idempotent), registers the model against a
   research registry shaped as the app reads it, then attacks it:
     roles        anon and authenticated read; nobody but service_role writes
     history      every table refuses update, delete and truncate
     registry     a projection that names no registered version, another
                  version, or is computed after tip is refused; an OK
                  projection needs its number and a WITHHELD one its reason
     views        the latest status per player per upcoming game comes from the
                  latest report that COVERS the game (a newer report with no
                  rows for it clears it); roster changes between captures
     card         AVAILABLE, FALLBACK, NOT_ON_REPORT, UNAVAILABLE after a failed
                  check, after a stale check, and before any run; a quiet
                  overnight (skipped runs) is not stale; PREGAME after tip; the
                  adjusted number only from the report shown
     readiness    ok; a failure is an error with a FAILURE alert counted; a
                  silent scheduler is an error; unmatched names and missing
                  teams are warnings
     cron         the poke without its secret records a failed run and a
                  FAILURE alert instead of vanishing; with it, it queues
     rollback     removes the layer
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('NBA injury layer');
const ROOT = PG.ROOT;
const F = (n) => path.join(ROOT, 'supabase', n);
const LAYER = fs.readFileSync(F('nba_injury_layer.sql'), 'utf8');

T.chk('the layer never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('the migration copy is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261021140000_nba_injury_layer.sql'), 'utf8') === LAYER);
T.chk('the registry file is current (node tools/nba/build_roster_adjusted_registry_sql.js)', require(path.join(ROOT, 'tools', 'nba', 'build_roster_adjusted_registry_sql.js')).build() === fs.readFileSync(F('nba_roster_adjusted_registry.sql'), 'utf8'));
T.chk('no psql meta-command in any file', ['nba_injury_layer.sql', 'nba_roster_adjusted_registry.sql', 'nba_injury_cron.sql', 'nba_injury_layer_rollback.sql'].every((n) => !/^\s*\\/m.test(fs.readFileSync(F(n), 'utf8'))));

const db = PG.start('nbainj');
if (db.skip) {
  if (process.env.NBA_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = PG.lit;
const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const J = (s) => JSON.parse(s.split('\n').filter(Boolean).pop());
try {
  let out = db.applyFile(F('nba_injury_layer.sql'));
  T.chk('the layer applies; every report row is ok or the registry is pending', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 5 && /pending: apply supabase\/nba_roster_adjusted_registry\.sql/.test(out), out);
  out = db.applyFile(F('nba_injury_layer.sql'));
  T.chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out), out.slice(0, 300));

  /* ---- data a run writes ---- */
  const START = "now() + interval '6 hours'";
  const run = (status, extra) => db.service(`insert into public.nba_injury_sync_runs (status, started_at, finished_at, game_day, report_id, report_source, official_ok, fallback_used, rows_read, unmatched, teams_missing, message, trigger)
    values (${lit(status)}, now() - interval '1 minute', ${extra && extra.at || 'now()'}, true, ${extra && extra.report != null ? extra.report : 'null'}, ${lit(extra && extra.source || 'nba_official')}, ${extra && extra.official === false ? 'false' : 'true'}, ${extra && extra.fallback ? 'true' : 'false'},
      3, ${extra && extra.unmatched || 0}, ${extra && extra.missing ? "'{" + extra.missing + "}'" : "'{}'"}, ${lit(extra && extra.message || null)}, 'test') returning run_id;`).split('\n').filter(Boolean).pop();
  const cap = (team, abbr, players) => {
    const id = db.service(`insert into public.nba_roster_captures (team_id, team_abbr, source, captured_at, content_hash, player_count) values (${lit(team)}, ${lit(abbr)}, 'espn_roster', now(), md5(random()::text), ${players.length}) returning id;`).split('\n').filter(Boolean).pop();
    for (const [pid, name] of players) db.service(`insert into public.nba_roster_snapshots (capture_id, team_id, team_abbr, player_id, player_name, roster_status, source, captured_at) values (${id}, ${lit(team)}, ${lit(abbr)}, ${lit(pid)}, ${lit(name)}, 'ACTIVE', 'espn_roster', now());`);
    return id;
  };
  const report = (source, games, rows, at) => {
    const m = JSON.stringify(games.map((g) => ({ game_id: g, game_start_utc: null })));
    const id = db.service(`insert into public.nba_injury_reports (source, report_published_at, captured_at, content_hash, parser_version, rows_count, matchups)
      values (${lit(source)}, ${source === 'nba_official' ? 'now()' : 'null'}, ${at || 'now()'}, md5(random()::text), 'test', ${rows.length}, (select jsonb_agg(x || jsonb_build_object('game_start_utc', ${START})) from jsonb_array_elements(${lit(m)}::jsonb) x)) returning id;`).split('\n').filter(Boolean).pop();
    for (const r of rows) db.service(`insert into public.nba_injury_report_snapshots (report_id, game_id, game_start_utc, team_id, team_abbr, player_id, player_name, match_method, status, source_status, captured_at, source)
      values (${id}, ${lit(r[0])}, ${START}, ${lit(r[1])}, ${lit(r[2])}, ${lit(r[3])}, ${lit(r[4])}, ${r[3] ? "'team_exact'" : "'unmatched'"}, ${lit(r[5])}, ${lit(r[5])}, now(), ${lit(source)});`);
    return id;
  };
  const cA = cap('30', 'CHA', [['1', 'Coby White'], ['2', 'Kon Knueppel'], ['3', 'Brandon Miller']]);
  cap('17', 'BKN', [['7', 'Michael Porter Jr.'], ['8', 'Julius Randle']]);
  const cA2 = cap('30', 'CHA', [['1', 'Coby White'], ['3', 'Brandon Miller'], ['4', 'Grayson Allen']]);
  const rep1 = report('nba_official', ['g1', 'g2'], [['g1', '30', 'CHA', '1', 'Coby White', 'OUT'], ['g1', '30', 'CHA', '2', 'Kon Knueppel', 'OUT'], ['g2', '1', 'ATL', null, 'Some Body', 'QUESTIONABLE']]);
  const r1 = run('ok', { report: rep1 });

  /* ---- roles and history ---- */
  T.chk('anon reads the reports, the rows and the views', db.anon('select count(*) from public.nba_injury_report_snapshots;') === '3' && /\d/.test(db.anon('select count(*) from public.nba_player_status_current;')) && db.anon('select count(*) from public.nba_injury_readiness;') === '1');
  T.chk('anon cannot write a report', fails(() => db.anon("insert into public.nba_injury_reports (source, captured_at, content_hash, parser_version, rows_count) values ('espn_injuries', now(), 'x', 'x', 0);")));
  T.chk('an authenticated reader cannot write a roster', fails(() => db.as('00000000-0000-0000-0000-000000000001', `insert into public.nba_roster_snapshots (capture_id, team_id, team_abbr, player_id, player_name, roster_status, source, captured_at) values (${cA}, '30', 'CHA', '9', 'x', 'ACTIVE', 'espn_roster', now());`)));
  for (const t of ['nba_injury_reports', 'nba_injury_report_snapshots', 'nba_roster_snapshots', 'nba_injury_sync_runs']) {
    T.chk('history: ' + t + ' refuses an update (even by service_role)', fails(() => db.service(`update public.${t} set captured_at = now() where true;`.replace('captured_at = now()', t === 'nba_injury_sync_runs' ? 'message = message' : 'captured_at = captured_at'))));
    T.chk('history: ' + t + ' refuses a delete and a truncate', fails(() => db.sql(`delete from public.${t};`)) && fails(() => db.sql(`truncate public.${t} cascade;`)));
  }
  T.chk('an official report must carry its publication time', fails(() => db.service("insert into public.nba_injury_reports (source, captured_at, content_hash, parser_version, rows_count) values ('nba_official', now(), 'x', 'x', 0);")));
  T.chk('a status outside the official five (and UNKNOWN) is refused', fails(() => db.service(`insert into public.nba_injury_report_snapshots (report_id, team_id, team_abbr, player_id, player_name, match_method, status, captured_at, source) values (${rep1}, '30', 'CHA', '1', 'x', 'team_exact', 'GTD', now(), 'x');`)));
  T.chk('an unmatched row cannot claim a player id', fails(() => db.service(`insert into public.nba_injury_report_snapshots (report_id, team_id, team_abbr, player_id, player_name, match_method, status, captured_at, source) values (${rep1}, '30', 'CHA', '1', 'x', 'unmatched', 'OUT', now(), 'x');`)));

  /* ---- the registry ---- */
  const proj = (o) => `insert into public.nba_adjusted_projection_snapshots (game_id, game_start_utc, home_id, away_id, model_key, model_version, model_version_ref, injury_report_id, report_source, home_roster_capture_id, away_roster_capture_id, slate_generated_at, status, reasons, baseline, adjusted, delta, adjustments, inputs_hash, core_version, computed_at)
    values ('g1', ${o.start || START}, '17', '30', 'NBA-ROSTER-ADJ', ${lit(o.version || '0.1')}, ${lit(o.ref)}, ${o.report || rep1}, 'nba_official', 1, ${cA2}, now(), ${lit(o.status || 'OK')}, ${lit(JSON.stringify(o.reasons || []))}, '{"fair_spread_home":9.5}', ${o.adjusted === null ? 'null' : `'{"fair_spread_home":-2.5}'`}, '{"fair_spread_home":-12}', '[{"text":"Coby White OUT: -0.9 pts CHA"}]', 'h', 'test', now());`;
  T.chk('before registration, no projection can be stored', fails(() => db.service(proj({ ref: 'x' }))));
  db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
    create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
    create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
    create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
    create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
    create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
      from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
      left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
  out = db.applyFile(F('nba_roster_adjusted_registry.sql'));
  T.chk('the registry file applies; the model reads EXPERIMENTAL with no result; the link is set', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 2, out);
  out = db.applyFile(F('nba_roster_adjusted_registry.sql'));
  T.chk('registering twice changes nothing', !/CHECK THIS/.test(out) && db.sql("select count(*) from public.research_model_versions") === '1');
  const ver = db.sql("select promotion_criteria ->> 'decision_rule', min_sample, holdout_window::text, spec -> 'play_probability' ->> 'QUESTIONABLE', (forking_paths -> 'candidates_tried')::text from public.research_model_versions");
  T.chk('the version carries the promotion criteria, the minimum sample, the holdout and the mapping', /every criterion below holds/.test(ver) && /\|600\|/.test(ver) && /\[2026-10-22,2027-04-12\)/.test(ver) && /\|0\.5\|/.test(ver), ver);
  T.chk('no result row was written', db.sql('select count(*) from public.research_model_results') === '0');
  const ref = db.sql("select value from public.nba_injury_config where key = 'roster_model_version_ref'");
  T.chk('the version reference is the registry row', ref === db.sql('select id::text from public.research_model_versions'));
  T.chk('a projection naming the registered version is stored', !fails(() => db.service(proj({ ref }))));
  T.chk('a projection naming another version is refused', fails(() => db.service(proj({ ref, version: '0.2' }))) && fails(() => db.service(proj({ ref: '999' }))));
  T.chk('a projection computed after tip is refused', fails(() => db.service(proj({ ref, start: "now() - interval '1 minute'" }))));
  T.chk('OK carries a number; WITHHELD carries a reason and no number', fails(() => db.service(proj({ ref, adjusted: null }))) && fails(() => db.service(proj({ ref, status: 'WITHHELD' }))) && !fails(() => db.service(proj({ ref, status: 'WITHHELD', adjusted: null, reasons: ['CHA has not submitted its injury report'] }))));
  T.chk('history: a projection refuses an update', fails(() => db.service("update public.nba_adjusted_projection_snapshots set status = 'OK';")));

  /* ---- views ---- */
  const cur = db.anon("select string_agg(player_name || ':' || status, ',' order by player_name) from public.nba_player_status_current where game_id = 'g1';");
  T.chk('status current: the latest covering report\'s rows for the game', cur === 'Coby White:OUT,Kon Knueppel:OUT', cur);
  const chg = db.anon("select string_agg(change || ':' || player_name, ',' order by change, player_name) from public.nba_roster_changes where team_id = '30';");
  T.chk('roster changes: who joined and who left between captures', chg === 'ADDED:Grayson Allen,REMOVED:Kon Knueppel', chg);

  const card = (g, start, h, a) => J(db.anon(`select public.nba_injury_card(${lit(g)}, ${lit(h || '17')}, ${lit(a || '30')}, ${start || START});`));
  let c = card('g1');
  T.chk('card: AVAILABLE with the report, its statuses and the projection from that report', c.state === 'AVAILABLE' && c.report.id === Number(rep1) && c.statuses.length === 2 && c.adjusted && c.adjusted.injury_report_id === Number(rep1) && c.adjusted.model_version === '0.1' && c.rosters['30'].players.length === 3, c);
  T.chk('card: the projection shown is the latest from the report shown (the WITHHELD one, here)', c.adjusted.status === 'WITHHELD' && /not submitted/.test(JSON.stringify(c.adjusted.reasons)));
  c = card('g9');
  T.chk('card: a game not on the report is NOT_ON_REPORT, with no statuses and no projection', c.state === 'NOT_ON_REPORT' && c.statuses.length === 0 && c.adjusted === null);

  /* a newer report that covers g1 with no rows clears it */
  const rep2 = report('nba_official', ['g1'], []);
  run('ok', { report: rep2 });
  T.chk('status current: a newer covering report with no rows for the game clears it', db.anon("select count(*) from public.nba_player_status_current where game_id = 'g1';") === '0');
  c = card('g1');
  T.chk('card: the projection from an older report is not shown beside a newer report', c.state === 'AVAILABLE' && c.report.id === Number(rep2) && c.adjusted === null);

  /* the injury source killed: the next check fails */
  run('error', { report: null, message: 'the official report and the ESPN fallback both failed', official: false });
  c = card('g1');
  T.chk('card: after a failed check, UNAVAILABLE with the reason and the check time — never the old report', c.state === 'UNAVAILABLE' && /failed/.test(c.reason) && c.statuses.length === 0 && c.adjusted === null && c.last_check_at && c.last_check_status === 'error', c);
  let rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  db.service(`insert into public.nba_injury_alerts (run_id, severity, code, message) values ((select run_id from public.nba_injury_sync_runs where status = 'error' order by finished_at desc limit 1), 'FAILURE', 'no_injury_source', 'both sources failed');`);
  rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  T.chk('readiness: a failed check is an error, a consecutive failure, and a FAILURE alert in 24 h', rd.state === 'error' && rd.consecutive_failures === 1 && rd.failures_24h === 1 && /failed/.test(rd.state_reason), rd);
  T.chk('pipeline ledger: the last status reads error', db.anon("select value from public.nba_injury_meta where key = 'nba_injury_sync_last_status';") === 'error');

  /* recovered through the fallback */
  const rep3 = report('espn_injuries', ['g1'], [['g1', '30', 'CHA', '1', 'Coby White', 'UNKNOWN']]);
  run('warn', { report: rep3, source: 'espn_injuries', official: false, fallback: true, unmatched: 1, missing: 'BKN' });
  c = card('g1');
  T.chk('card: the ESPN fallback reads FALLBACK, labelled, with its statuses', c.state === 'FALLBACK' && /ESPN/.test(c.reason) && c.statuses[0].status === 'UNKNOWN', c);
  rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  T.chk('readiness: the fallback in use, unmatched names and missing teams are warnings (the failure still counted)', rd.state === 'warn' && rd.fallback_in_use === true && rd.unmatched_players === 1 && rd.teams_missing_count === 1 && rd.consecutive_failures === 0 && rd.failures_24h === 1, rd);

  /* an older check written late does not displace the newest one */
  db.service("insert into public.nba_injury_sync_runs (status, started_at, finished_at, report_id, report_source, official_ok, trigger) values ('ok', now() - interval '3 hours', now() - interval '2 hours', " + rep2 + ", 'nba_official', true, 'test');");
  const fresh = J(db.anon(`select public.nba_injury_card('g1', '17', '30', ${START});`));
  T.chk('card: the newest check decides (a check finishing now is fresh)', fresh.state === 'FALLBACK');
  /* a fresh layer whose only check is two hours old */
  out = db.applyFile(F('nba_injury_layer_rollback.sql'));
  T.chk('rollback removes the layer', /\|ok/.test(out) && db.sql("select to_regclass('public.nba_injury_reports') is null") === 't', out);
  db.applyFile(F('nba_injury_layer.sql'));
  c = card('g1');
  T.chk('card: before any run, UNAVAILABLE ("has not run yet")', c.state === 'UNAVAILABLE' && /not run/.test(c.reason));
  rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  T.chk('readiness: a sync that has never run is an error', rd.state === 'error' && /never run/.test(rd.state_reason));
  const repS = report('nba_official', ['g1'], [['g1', '30', 'CHA', '1', 'Coby White', 'OUT']], "now() - interval '2 hours'");
  db.service(`insert into public.nba_injury_sync_runs (status, started_at, finished_at, game_day, report_id, report_source, official_ok, trigger) values ('ok', now() - interval '2 hours', now() - interval '2 hours', true, ${repS}, 'nba_official', true, 'test');`);
  c = card('g1');
  T.chk('card: a check two hours old with no run since is stale: UNAVAILABLE with the last check time', c.state === 'UNAVAILABLE' && /no check since/.test(c.reason) && c.statuses.length === 0, c);
  rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  T.chk('readiness: no run of any kind in 90 minutes is an error (the scheduler is not calling)', rd.state === 'error' && /scheduler/.test(rd.state_reason), rd);
  db.service("insert into public.nba_injury_sync_runs (status, skipped_reason, started_at, finished_at, game_day, trigger) values ('skipped', 'outside the game-day window', now(), now(), false, 'test');");
  c = card('g1');
  T.chk('card: the same check with skipped runs after it (a quiet night) is not stale', c.state === 'AVAILABLE' && c.statuses.length === 1, c);
  c = card('g1', "now() - interval '10 minutes'");
  T.chk('card: after tip, PREGAME: the last report captured before tip', c.state === 'PREGAME' && c.report.id === Number(repS));
  c = card('g1', "now() - interval '3 hours'");
  T.chk('card: after tip with no report captured before it, UNAVAILABLE', c.state === 'UNAVAILABLE');

  /* ---- the cron poke: a missing secret is a recorded failure ---- */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.calls (url text, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, headers); select 1::bigint $$;`);
  out = db.applyFile(F('nba_injury_cron.sql'));
  T.chk('cron: scheduled; the report flags the missing secret', /1 the half-hourly poke is scheduled\|ok/.test(out) && /CHECK THIS: select vault\.create_secret/.test(out), out);
  T.chk('cron: on the half hour, 13:00-04:59 UTC (the function gates game days)', db.sql("select schedule from cron.job where jobname = 'nba_injury_sync'") === '7,37 0-4,13-23 * * *');
  let pk = J(db.sql('select public.nba_injury_poke();'));
  rd = J(db.anon('select row_to_json(r) from public.nba_injury_readiness r;'));
  T.chk('forced failure: no secret is a failed run and a FAILURE alert, visible in the readiness KPIs', pk.queued === false && rd.last_check_status === 'error' && rd.failures_24h >= 1 && rd.state === 'error'
    && db.sql("select code from public.nba_injury_alerts order by id desc limit 1") === 'no_cron_secret', [pk, rd]);
  T.chk('forced failure: the card then says unavailable, not the old report', card('g1').state === 'UNAVAILABLE');
  db.sql("insert into vault.decrypted_secrets values ('nba_injury_cron_secret', 's3cret');");
  pk = J(db.sql('select public.nba_injury_poke();'));
  T.chk('cron: with the secret, the poke queues with the x-cron-secret header', pk.queued === true && db.sql("select headers ->> 'x-cron-secret' from net.calls order by 1 limit 1") === 's3cret');
  T.chk('cron: no client may call the poke', fails(() => db.anon('select public.nba_injury_poke();')) && fails(() => db.as('00000000-0000-0000-0000-000000000001', 'select public.nba_injury_poke();')));
  out = db.applyFile(F('nba_injury_cron.sql'));
  T.chk('cron: applying it twice keeps one job', db.sql("select count(*) from cron.job where jobname = 'nba_injury_sync'") === '1' && !/CHECK THIS/.test(out));
  out = db.applyFile(F('nba_injury_layer_rollback.sql'));
  T.chk('rollback removes the layer and its job', /\|ok/.test(out) && db.sql("select count(*) from cron.job where jobname = 'nba_injury_sync'") === '0');
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 800)); }
finally { db.stop(); }
process.exit(T.done());
