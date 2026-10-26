#!/usr/bin/env node
/* ===========================================================================
   supabase/sharp_lag.sql on a real PostgreSQL (the repo's Supabase shim: roles
   anon / authenticated / service_role, auth.uid()).
     apply      twice, every report row ok; static file rules
     append     every table refuses update, delete and truncate (service role
                and owner too); a price snapshot read twice is stored once
     flags      the database holds the rules: the registered threshold, no
                past Pinnacle price, a Kalshi flag without a verified fee is
                marked fee_unverified, the absent player's own under is never
                flagged, nothing after the start, one flag per episode
     grades     REGISTERED BEFORE GRADED: no grade without the registry link;
                none before the start; once per flag; never edited
     access     no client reads a table directly
                sharp_lag_flags(): a subscriber sees every flag live; anyone
                else only started games, and only once public_display is on;
                sharp_lag_progress() is public and holds no price
     cron       the free job every 10 minutes and never a spend path; no secret,
                no call
                the paid dispatcher hourly, woken only when live AND the
                gateway's breaker is on
     config     every switch change is logged, append-only; the rules frozen
   Run: node tools/sharp_lag/sharp_lag_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('sharp lag SQL');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'sharp_lag.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const MIG = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /_sharp_lag\.sql$/.test(f));

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = SQL.replace(/--[^\n]*/g, ' ');
T.chk('static: no psql meta-command', !/^\s*\\/m.test(code));
T.chk('static: every CREATE TABLE / INDEX / ADD COLUMN is guarded', !/create table(?!\s+if not exists)/i.test(code) && !/create (unique )?index(?!\s+if not exists)/i.test(code) && !/add column(?!\s+if not exists)/i.test(code));
T.chk('static: nothing is dropped but triggers being re-created', !/\bdrop\s+(table|column|schema|view|function)\b/i.test(code));
T.chk('static: it ends in a report', /'CHECK THIS'/.test(SQL.slice(-3000)));
T.chk('static: it never names the odds provider or a key', !/the-odds-api\.com|apiKey=|ODDS_API_KEY/i.test(SQL));
T.chk('static: the migration mirror is the same file', MIG.length === 1 && fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', MIG[0]), 'utf8') === SQL, MIG);

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('sharplagsql');
if (db.skip) {
  if (process.env.SHARP_LAG_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const SUB = '00000000-0000-0000-0000-00000000000a', NOSUB = '00000000-0000-0000-0000-00000000000b';
const J = (s) => { const o = s; try { return JSON.parse(o); } catch (_) { return o; } };
const refused = (fn, re) => { const m = db.mustFail(fn); return m !== null && (!re || re.test(m)); };
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();

try {
  db.sql(`create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() = '${SUB}'::uuid $$;
    grant execute on function public.has_active_sub() to authenticated;`);
  let out = db.applyFile(FILE);
  const rows = (o) => (o.match(/\|(ok|CHECK THIS[^\n]*)$/gm) || []);
  const REPORT_ROWS = 5;
  T.chk('apply: every report row ok', rows(out).length === REPORT_ROWS && rows(out).every((r) => /\|ok$/.test(r)), out.slice(-800));
  out = db.applyFile(FILE);
  T.chk('apply: and a second time, with the switches left as they were', rows(out).length === REPORT_ROWS && rows(out).every((r) => /\|ok$/.test(r))
    && db.sql("select value from public.sharp_lag_config where key = 'dispatch'") === 'shadow' && db.sql("select value from public.sharp_lag_config where key = 'public_display'") === 'off');

  /* ── append-only ─────────────────────────────────────────────────────── */
  const price = (req, side, dec) => `insert into public.sharp_price_snapshots (captured_at, source_request_id, source_category, sport_key, event_id, home_team, away_team, commence_time, book, market, side, point, price_dec)
    values (now() - interval '5 minutes', ${req}, 'featured', 'americanfootball_nfl', 'ev1', 'Philadelphia Eagles', 'Dallas Cowboys', now() + interval '4 hours', 'pinnacle', 'h2h', '${side}', null, ${dec})
    on conflict (source_request_id, event_id, book, market, side, participant_key, point_key) do nothing;`;
  db.service(price(1, 'Philadelphia Eagles', 1.6) + price(1, 'Dallas Cowboys', 2.5) + price(1, 'Dallas Cowboys', 2.5));
  T.chk('append: a snapshot read twice is stored once (the unique key, null point included)', db.sql('select count(*) from public.sharp_price_snapshots') === '2');
  const SEALED = ['sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log', 'sharp_triggers', 'sharp_check_requests', 'sharp_flags', 'sharp_flag_grades'];
  for (const t of ['sharp_price_snapshots', 'sharp_lag_config_log']) {
    const col = t === 'sharp_price_snapshots' ? 'book' : 'key';
    T.chk('append: ' + t + ' refuses UPDATE: the service role has no UPDATE grant, and the trigger refuses even the owner', refused(() => db.service('update public.' + t + ' set ' + col + ' = ' + col + ';'))
      && refused(() => db.sql('update public.' + t + ' set ' + col + ' = ' + col + ';'), /append-only/));
    T.chk('append: ' + t + ' refuses DELETE (the owner too)', refused(() => db.service('delete from public.' + t + ';')) && refused(() => db.sql('delete from public.' + t + ';'), /append-only/));
    T.chk('append: ' + t + ' refuses TRUNCATE', refused(() => db.sql('truncate public.' + t + ';'), /append-only/));
  }
  T.chk('append: a price must be a real decimal price', refused(() => db.service(price(2, 'X', 1.0))));

  T.chk('append: every sealed table carries both guards', SEALED.every((t) => db.sql("select count(*) from pg_trigger where tgname in ('" + t + "_frozen', '" + t + "_no_truncate')") === '2'));
  /* ── flags ───────────────────────────────────────────────────────────── */
  const flag = (o) => {
    const f = Object.assign({ flagged_at: iso(0), model_key: 'SHARP-LAG', model_version: '0.1', trigger_type: 'scheduled', sport_key: 'americanfootball_nfl', event_id: 'ev1',
      home_team: 'Philadelphia Eagles', away_team: 'Dallas Cowboys', commence_time: iso(240), market: 'h2h', side: 'Philadelphia Eagles', target_venue: 'draftkings', target_ref: 'draftkings',
      target_price: 1.75, target_cost_prob: 0.5714, fee_basis: 'none', fee_unverified: false, target_observed_at: iso(-5), reference_kind: 'pinnacle_shin', reference_prob: 0.605,
      devig_method: 'shin', pinnacle_price_dec: 1.6, pinnacle_opp_dec: 2.5, reference_observed_at: iso(-10), gap_pp: 3.36, threshold_pp: 2.5, seconds_since_reference: 600,
      snapshot_resolution_s: 3600, episode_key: 'ev1#draftkings#h2h|Philadelphia Eagles||@' + Math.random() }, o || {});
    const cols = Object.keys(f);
    return db.service('insert into public.sharp_flags (' + cols.join(', ') + ') values (' + cols.map((k) => PG.lit(typeof f[k] === 'object' && f[k] !== null ? JSON.stringify(f[k]) : f[k])).join(', ') + ') returning flag_id;').split('\n').pop();
  };
  const f1 = flag();
  T.chk('flags: a DraftKings flag inside every rule is written', /^\d+$/.test(f1), f1);
  T.chk('flags: a gap under the threshold is refused', refused(() => flag({ gap_pp: 2.4 })));
  T.chk('flags: a threshold under the registered 2.5 is refused', refused(() => flag({ gap_pp: 2.0, threshold_pp: 2.0 }), /registered threshold/));
  T.chk('flags: a Pinnacle observation over 90 minutes old is refused (a past price is never flagged)', refused(() => flag({ seconds_since_reference: 5401 }), /past price/));
  T.chk('flags: a Kalshi flag on the highest plausible fee must be marked fee_unverified', refused(() => flag({ target_venue: 'kalshi', target_ref: 'K', fee_basis: 'highest_plausible', fee_unverified: false }))
    && /^\d+$/.test(flag({ target_venue: 'kalshi', target_ref: 'K', fee_basis: 'highest_plausible', fee_unverified: true, fee_per_contract: 0.02 })));
  T.chk('flags: nothing is flagged at or after the start', refused(() => flag({ commence_time: iso(-1) })));
  const ek = 'ev1#draftkings#same@x';
  flag({ episode_key: ek });
  T.chk('flags: one flag per episode (the unique key)', refused(() => flag({ episode_key: ek })));
  const role = { model_key: 'NBA-ROLE-SHIFT', trigger_type: 'role_shift', sport_key: 'basketball_nba', market: 'player_rebounds', reference_kind: 'role_shift_model', pinnacle_price_dec: null, pinnacle_opp_dec: null,
    absent_player_id: '4432816', absent_player_name: 'LaMelo Ball', minutes_delta: 6.4, sample_games: 14, sample_stints: 230, fair_line: 7.5, posted_line: 6.5, participant: 'Miles Bridges', side: 'Over', point: 6.5 };
  T.chk('flags: a role-shift flag on a teammate is written', /^\d+$/.test(flag(role)));
  T.chk('flags: the absent player\'s own under is never flagged (it voids if he sits)', refused(() => flag(Object.assign({}, role, { participant: 'LaMelo Ball', side: 'Under' })), /absent player/));
  T.chk('flags: a role-shift flag must name the absent player and the minutes delta', refused(() => flag(Object.assign({}, role, { absent_player_id: null }))));
  T.chk('flags: a flag is never edited or deleted (not even by the owner)', refused(() => db.service('update public.sharp_flags set gap_pp = 9 where flag_id = ' + f1 + ';'))
    && refused(() => db.sql('update public.sharp_flags set gap_pp = 9 where flag_id = ' + f1 + ';'), /append-only/) && refused(() => db.sql('delete from public.sharp_flags;'), /append-only/));

  /* ── grades ──────────────────────────────────────────────────────────── */
  const fStarted = flag({ flagged_at: iso(-300), commence_time: iso(-60), target_observed_at: iso(-305), reference_observed_at: iso(-310), episode_key: 'started@1' });
  const grade = (id, o) => {
    const g = Object.assign({ flag_id: id, model_key: 'SHARP-LAG', registry_ref: 'v-sharp-lag-0.1', close_status: 'graded', closing_reference_prob: 0.62, closing_reference_at: iso(-80), close_lead_min: 20,
      clv_pp: 4.86, hit: true, converged: true, converged_at: iso(-200), lag_to_converge_s: 6000, lag_censored: false, lag_resolution_s: 3600 }, o || {});
    const cols = Object.keys(g);
    return db.service('insert into public.sharp_flag_grades (' + cols.join(', ') + ') values (' + cols.map((k) => PG.lit(g[k])).join(', ') + ');');
  };
  T.chk('grades: before the model is registered, no grade is accepted', refused(() => grade(fStarted), /not registered in the research registry/));
  db.sql("insert into public.sharp_lag_config (key, value, note) values ('registry_ref:SHARP-LAG', 'v-sharp-lag-0.1', 'test registry link')");
  T.chk('grades: once registered, the grade is written', db.mustFail(() => grade(fStarted)) === null);
  T.chk('grades: once per flag', refused(() => grade(fStarted)));
  T.chk('grades: never before the start', refused(() => grade(f1), /has not started/));
  T.chk('grades: never under another model or another registry version', refused(() => grade(flag({ flagged_at: iso(-300), commence_time: iso(-60), episode_key: 's2' }), { registry_ref: 'other' }), /registry_ref/));
  const fNc = flag({ flagged_at: iso(-300), commence_time: iso(-60), episode_key: 's3' });
  T.chk('grades: a no-close grade needs its reason and carries no CLV', refused(() => grade(fNc, { close_status: 'no_close', clv_pp: null, hit: null }))
    && db.mustFail(() => grade(fNc, { close_status: 'no_close', clv_pp: null, hit: null, no_close_reason: 'last Pinnacle observation 100 minutes before the start' })) === null);
  T.chk('grades: hit must agree with CLV', refused(() => grade(flag({ flagged_at: iso(-300), commence_time: iso(-60), episode_key: 's4' }), { clv_pp: -1, hit: true })));
  T.chk('grades: a grade is never edited (not even by the owner)', refused(() => db.service('update public.sharp_flag_grades set clv_pp = 9;')) && refused(() => db.sql('update public.sharp_flag_grades set clv_pp = 9;'), /append-only/));

  /* ── access ──────────────────────────────────────────────────────────── */
  const tables = SEALED.concat(['sharp_lag_config']);
  T.chk('access: anon reads no table directly', tables.every((t) => refused(() => db.anon('select count(*) from public.' + t + ';'), /permission denied/)));
  T.chk('access: a subscriber reads no table directly either (only through the function)', tables.every((t) => refused(() => db.as(SUB, 'select count(*) from public.' + t + ';'), /permission denied/)));
  T.chk('access: anon cannot write a flag', refused(() => db.anon("insert into public.sharp_flags (flagged_at) values (now());"), /permission denied/));
  const flagsAs = (who) => {
    const q = 'select count(*) || \':\' || count(*) filter (where (j->>\'commence_time\')::timestamptz > now()) from public.sharp_lag_flags() j;';
    return who === 'anon' ? db.anon(q) : db.as(who, q);
  };
  const total = Number(db.sql('select count(*) from public.sharp_flags')), upcoming = Number(db.sql('select count(*) from public.sharp_flags where commence_time > now()'));
  T.chk('access: a subscriber sees every flag, live ones included', flagsAs(SUB) === total + ':' + upcoming, [flagsAs(SUB), total, upcoming]);
  T.chk('access: with public_display off, anyone else sees nothing', flagsAs('anon') === '0:0' && flagsAs(NOSUB) === '0:0');
  db.sql("update public.sharp_lag_config set value = 'on', note = 'test: terms read' where key = 'public_display'");
  T.chk('access: with public_display on, anyone else sees started games only, with their grades', flagsAs('anon') === (total - upcoming) + ':0'
    && db.anon("select count(*) from public.sharp_lag_flags() j where j->>'close_status' = 'graded';") === '1');
  T.chk('access: each row says which access it was served under', db.anon("select distinct j->>'access' from public.sharp_lag_flags() j;") === 'public' && db.as(SUB, "select distinct j->>'access' from public.sharp_lag_flags() j;") === 'subscriber');
  const prog = J(db.anon('select public.sharp_lag_progress();'));
  const sl = (prog.models || []).find((m) => m.model_key === 'SHARP-LAG');
  T.chk('access: progress is public: counts, the threshold, registered or not, and no price', prog.threshold === 200 && sl && sl.graded === 2 - 1 && sl.no_close === 1 && sl.registered === true
    && !/price|prob|clv/.test(JSON.stringify(prog)), prog);
  T.chk('access: the role-shift model reads not registered until its registry SQL runs', (prog.models || []).find((m) => m.model_key === 'NBA-ROLE-SHIFT').registered === false);

  /* ── the research registry ───────────────────────────────────────────── */
  const REG = path.join(ROOT, 'supabase', 'sharp_lag_registry.sql');
  T.chk('registry: without the research registry the file refuses and registers nothing', refused(() => db.applyFile(REG), /research registry/));
  db.sql(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
    create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
    create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
    create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental', training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
    create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, computed_at timestamptz not null default now());
    create view public.research_model_current as select m.model_key, m.name, m.provenance, v.version, v.status, v.training_window, v.validation_window, v.objective, r.passed, r.metrics as holdout_result, v.created_at as updated_at
      from public.research_models m join lateral (select * from public.research_model_versions x where x.model_id = m.id order by x.created_at desc limit 1) v on true
      left join lateral (select * from public.research_model_results y where y.version_id = v.id order by y.computed_at desc limit 1) r on true;`);
  out = db.applyFile(REG);
  const regRows = (out.match(/\|(ok|CHECK THIS[^\n]*)$/gm) || []);
  T.chk('registry: both models register and every report row is ok', regRows.length === 4 && regRows.every((r) => /\|ok$/.test(r)), out.slice(-600));
  out = db.applyFile(REG);
  T.chk('registry: registering twice changes nothing', db.sql('select count(*) from public.research_models') === '2' && db.sql('select count(*) from public.research_model_versions') === '2');
  const vrow = (k) => JSON.parse(db.sql("select to_jsonb(x) from (select m.provenance, v.status, v.version, v.min_sample, v.id, v.promotion_criteria -> 'criteria' -> 0 ->> 'id' as c1, v.promotion_criteria -> 'criteria' -> 1 ->> 'id' as c2 from public.research_models m join public.research_model_versions v on v.model_id = m.id where m.model_key = '" + k + "') x"));
  const vs = vrow('SHARP-LAG'), vr = vrow('NBA-ROLE-SHIFT');
  T.chk('registry: SHARP-LAG v0.1 is T3 / experimental, 200 graded flags, both criteria', vs.provenance === 'T3' && vs.status === 'experimental' && vs.version === '0.1' && vs.min_sample === 200 && vs.c1 === 'C1_SAMPLE' && vs.c2 === 'C2_CLV_LOWER_BOUND', vs);
  T.chk('registry: NBA-ROLE-SHIFT v0.1 is registered the same way, on its own', vr.provenance === 'T3' && vr.status === 'experimental' && vr.min_sample === 200 && vr.c2 === 'C2_CLV_LOWER_BOUND', vr);
  T.chk('registry: each version row is the link the grader requires', db.sql("select value from public.sharp_lag_config where key = 'registry_ref:SHARP-LAG'") === String(vs.id)
    && db.sql("select value from public.sharp_lag_config where key = 'registry_ref:NBA-ROLE-SHIFT'") === String(vr.id));
  T.chk('registry: no result row is written (nothing is promoted)', db.sql('select count(*) from public.research_model_results') === '0');
  T.chk('registry: the registrations are the generated file\'s (node tools/sharp_lag/build_registry_sql.js --check)', require(path.join(ROOT, 'tools', 'sharp_lag', 'build_registry_sql.js')).build() === fs.readFileSync(REG, 'utf8'));
  const regJ = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'sharp_lag', f), 'utf8'));
  T.chk('registry: each registration is EXPERIMENTAL, T3, no result, and states the clustered bootstrap and the 2.5 pp threshold', ['registration_sharp_lag.json', 'registration_role_shift.json'].every((f) => {
    const R = regJ(f); return R.status === 'EXPERIMENTAL' && R.provenance === 'T3' && R.result === null && /clusters?/i.test(JSON.stringify(R.promotion_criteria)) && /2\.5 pp|2\.5 percentage points/.test(R.hypothesis + R.spec.flag + JSON.stringify(R.spec.rules || ''));
  }));
  /* ── cron ────────────────────────────────────────────────────────────── */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = job_id returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.posted (url text);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
      returns bigint language sql as $$ insert into net.posted values (url); select 1::bigint $$;`);
  const CRON = path.join(ROOT, 'supabase', 'sharp_lag_cron.sql');
  out = db.applyFile(CRON); db.applyFile(CRON);
  T.chk('cron: the free job is scheduled every 10 minutes, once however often the file runs', db.sql("select count(*) || ':' || max(schedule) from cron.job where jobname = 'sharp_lag'") === '1:*/10 * * * *');
  T.chk('cron: no secret, no call: the run is recorded as an error and nothing is sent', JSON.parse(db.sql('select public.sharp_lag_poke()')).queued === false
    && db.sql('select count(*) from net.posted') === '0' && db.sql("select count(*) from public.sharp_lag_runs where status = 'error' and details->>'code' = 'no_cron_secret'") === '1');
  db.sql("insert into vault.decrypted_secrets values ('sharp_lag_cron_secret', 's1'), ('sharp_check_cron_secret', 's2')");
  T.chk('cron: with the secret the free job is called', JSON.parse(db.sql('select public.sharp_lag_poke()')).queued === true && db.sql("select count(*) from net.posted where url like '%/functions/v1/sharp_lag'") === '1');
  const STOP = fs.readFileSync(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'), 'utf8');
  const spend = (STOP.match(/function public\.odds_api_spend_patterns\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/) || [])[1] || '';
  const patterns = (spend.match(/'((?:[^']|'')*)'/g) || []).map((q) => q.slice(1, -1).replace(/''/g, "'"));
  const like = (cmd, pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(cmd);
  T.chk('cron: the free job\'s command matches no spend pattern (it may run every 10 minutes)', patterns.length > 10 && !patterns.some((pt) => like(db.sql("select command from cron.job where jobname = 'sharp_lag'"), pt)));
  T.chk('cron: the paid dispatcher is scheduled hourly at :47', db.sql("select count(*) || ':' || max(schedule) from cron.job where jobname = 'sharp_check'") === '1:47 * * * *');
  db.sql('truncate net.posted');
  T.chk('cron: in shadow the dispatcher is never woken', JSON.parse(db.sql('select public.sharp_check_poke()')).queued === false && db.sql('select count(*) from net.posted') === '0');
  db.sql("update public.sharp_lag_config set value = 'live' where key = 'dispatch'");
  T.chk('cron: live, but no odds gateway: never woken', /not installed/.test(JSON.parse(db.sql('select public.sharp_check_poke()')).reason) && db.sql('select count(*) from net.posted') === '0');
  db.sql("create table if not exists public.breaker (on_ boolean); insert into public.breaker values (false); create or replace function public.odds_api_enabled() returns boolean language sql stable as $$ select on_ from public.breaker $$;");
  T.chk('cron: live, breaker off: never woken', /odds_api_enabled is false/.test(JSON.parse(db.sql('select public.sharp_check_poke()')).reason) && db.sql('select count(*) from net.posted') === '0');
  db.sql('update public.breaker set on_ = true');
  T.chk('cron: live and the breaker on: the dispatcher is woken', JSON.parse(db.sql('select public.sharp_check_poke()')).queued === true && db.sql("select count(*) from net.posted where url like '%/functions/v1/sharp_check'") === '1');
  db.sql("update public.sharp_lag_config set value = 'shadow' where key = 'dispatch'");
  T.chk('cron: no client may poke', refused(() => db.anon('select public.sharp_lag_poke();'), /permission denied/));

  /* ── config ──────────────────────────────────────────────────────────── */
  db.sql("update public.sharp_lag_config set value = 'live', note = 'test' where key = 'dispatch'; update public.sharp_lag_config set value = 'shadow' where key = 'dispatch';");
  T.chk('config: every switch change is logged with old and new values', db.sql("select string_agg(coalesce(old_value, '-') || '>' || new_value, ',' order by id) from public.sharp_lag_config_log where key = 'dispatch'") === '->shadow,shadow>live,live>shadow,shadow>live,live>shadow');
  T.chk('config: the log is append-only', refused(() => db.sql('delete from public.sharp_lag_config_log;'), /append-only/));
  T.chk('config: the rules are frozen in a function', db.sql("select public.sharp_lag_rule('gap_pp')::text || ',' || public.sharp_lag_rule('close_max_lead_min')::text || ',' || public.sharp_lag_rule('validation_min_graded')::text") === '2.5,90,200');
} catch (e) {
  T.chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
