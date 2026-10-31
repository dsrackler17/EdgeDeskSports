#!/usr/bin/env node
/* ===========================================================================
   supabase/radar.sql, polymarket_sync_cron.sql and radar_registry.sql,
   AGAINST A REAL POSTGRESQL, AS REAL READERS: anon, reader A (signed in, no
   subscription), a subscriber (has_active_sub()) and the service role.

     1 it installs (twice), names what it needs, and its report says ok
     2 the rules are ONE constant, and the H-RADAR-01 registration's frozen
       copy equals it
     3 the switch: POLYMARKET_DATA_ENABLED starts off; off, every door is
       shut and the gateway grants nothing; each change is logged
     4 the gateway's budget: the per-run cap, the daily ceiling, unused
       requests returned, one settlement, the breaker
     5 append-only: every record refuses update, delete and truncate, for the
       service role and the owner too
     6 access: no client reads a trade, a holder, a price, the pool or the
       budget, or writes anything; the grades only once Radar is on AND
       H-RADAR-01 is registered
     7 the guards: a mapping is written once, a resolution is final, a bet is
       graded only at its own market's settlement and the rules' own follow
       and close, a grade's sample is the rules' own
     8 grading math: the core's grades stored and read back unchanged; ranks
       1..n by score; at most 25 top-graded; a market maker never top-graded
     9 the doors: the leaderboard and a trader for anyone (names only when
       public, positions only for a subscriber); Smart Money Tonight for a
       subscriber only, computed as specified; the public teaser without the
       side
    10 the schedule: four jobs; a missing secret is a recorded failure
    11 the registry: H-RADAR-01 registered EXPERIMENTAL before anything is
       shown, and what the test found recorded
    12 the Radar record (radar_record.sql): every card published once, with
       the price a follower could take; graded once against the close and
       the result; void when the market never resolves; append-only; for
       subscribers only, EXPERIMENTAL and a small sample until earned

   Run: node tools/radar/radar_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const R = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_radar.js'));

const T = PG.kit('radar SQL');
const chk = T.chk;
const lit = PG.lit;
const ROOT = PG.ROOT;
const F = (f) => path.join(ROOT, 'supabase', f);
const SQL = fs.readFileSync(F('radar.sql'), 'utf8');
const CRON = fs.readFileSync(F('polymarket_sync_cron.sql'), 'utf8');
const REGSQL = fs.readFileSync(F('radar_registry.sql'), 'utf8');
const RECSQL = fs.readFileSync(F('radar_record.sql'), 'utf8');
const MIRROR = F('migrations/20261029120000_radar.sql');
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'radar', 'registration_h_radar_02.json'), 'utf8'));   /* the live rules' hypothesis, registered 2026-10-30 */
const REG1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'research', 'radar', 'registration_h_radar_01.json'), 'utf8'));   /* H-RADAR-01: registered, its result stands */

/* ── STATIC: the folder's conventions ──────────────────────────────────── */
for (const [name, text] of [['radar.sql', SQL], ['polymarket_sync_cron.sql', CRON], ['radar_registry.sql', REGSQL], ['radar_record.sql', RECSQL]]) {
  chk(name + ': no psql meta-commands (it is pasted into the SQL editor)', !/^\s*\\/m.test(text));
  chk(name + ': it ends in a report', /CHECK THIS/.test(text) && /\n(select piece, state from|select \* from pg_temp\.rdr_report\(\);)/.test(text));
}
chk('the migration mirror is byte-identical', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR, 'utf8') === SQL);
chk('the record\'s migration mirror is byte-identical', fs.existsSync(F('migrations/20261029130000_radar_record.sql')) && fs.readFileSync(F('migrations/20261029130000_radar_record.sql'), 'utf8') === RECSQL);
chk('the record grades with the house formulas: ROI = settle / (follow + its taker fee) - 1, CLV% = close / follow - 1', /s \/ \(r\.follow_price \+ coalesce\(r\.fee_per_share, 0\)\) - 1/.test(RECSQL) && /cp \/ r\.follow_price - 1/.test(RECSQL));
chk('PostgREST is told to reload', /notify pgrst, 'reload schema'/.test(SQL));
chk('nothing existing is dropped (only its own triggers are re-created)', !/\bdrop\s+(table|column|view|function|index|policy)/i.test(SQL.replace(/--.*$/gm, '')));
chk('the cron file never writes the service-role key into a job', !/service_role_key|Bearer\s/i.test(CRON));
const live = SQL.replace(/--.*$/gm, '');
chk('the minimum sample is written once, in radar_rules()', (live.match(/'min_graded',\s*50\b/g) || []).length === 1 && !/>=\s*50\b|<\s*50\b/.test(live));
chk('the follow lag is written once, in radar_rules()', (live.match(/'follow_lag_min',\s*5\b/g) || []).length === 1 && !/interval '5 minutes'/.test(live));
chk('the registry SQL is generated and current (node tools/radar/build_registry_sql.js)', require(path.join(__dirname, 'build_registry_sql.js')).build() === REGSQL);

const db = PG.start('radar');
/* RADAR_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a pass */
if (db.skip) { if (process.env.RADAR_SQL_REQUIRED === '1') chk('environment: ' + db.skip, false); console.log('SKIPPED | ' + db.skip + ' — the LIVE layer did not run (not verified)'); process.exit(T.done()); }

const J = (q, who) => JSON.parse((who || db.sql)('select coalesce(json_agg(t), \'[]\'::json) from (' + q + ') t;') || '[]');
const one = (q, who) => J(q, who)[0];
const V = (q) => db.sql(q);
const fails = (fn) => db.mustFail(fn) !== null;
const uid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const A = uid(1), SUB = uid(2);
const W = (c) => '0x' + c.repeat(40);
const C = (c) => '0x' + c.repeat(64);
const TX = () => '0x' + crypto.randomBytes(32).toString('hex');
const at = (min) => "(now() + interval '" + Math.round(min * 60) + " seconds')";
const asA = (q) => db.as(A, q), asSub = (q) => db.as(SUB, q);
const fn = (q, who) => JSON.parse((who || db.sql)('select ' + q + ';'));
const RULES = REG.spec.rules;

try {
  /* ===================================================================== */
  /* 1. IT INSTALLS, AND SAYS WHAT IT NEEDS                                */
  /* ===================================================================== */
  const noBoard = db.mustFail(() => db.applyFileAtomic(F('radar.sql')));
  chk('without signals it stops and says so', /public\.signals/.test(noBoard || ''), noBoard && noBoard.slice(0, 200));
  V('create table public.signals (sig_key text primary key, event_id text, sport_key text);');
  const thin = db.mustFail(() => db.applyFileAtomic(F('radar.sql')));
  chk('a board without the columns it reads: it stops and names them', /no column\(s\) commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at/.test(thin || ''), thin && thin.slice(0, 300));
  chk('…and installs nothing', V("select to_regclass('public.poly_trades') is null") === 't');
  V(`drop table public.signals;
    create table public.signals (sig_key text primary key, event_id text, sport_key text, commence_time timestamptz, home_team text, away_team text,
      market text, selection text, point numeric, sharp_fair numeric, last_seen_at timestamptz, closing_sharp_fair numeric);
    create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() = ${lit(SUB)}::uuid $$;
    alter table public.signals enable row level security;
    create policy signals_sub on public.signals for select to authenticated using (public.has_active_sub());
    grant select on public.signals to anon, authenticated;
    insert into auth.users (id, email) values (${lit(A)}, 'a@x.co'), (${lit(SUB)}, 'sub@x.co');`);
  let out = db.applyFileAtomic(F('radar.sql'));
  const rep = out.split('\n').filter((l) => /^\d /.test(l));
  chk('it installs: seven report rows; ok, and pending for the switch and the registry', rep.length === 7 && rep.filter((l) => /\|ok$/.test(l)).length === 5
    && /6 POLYMARKET_DATA_ENABLED[^|]*\|pending: off/.test(out) && /7 H-RADAR-02[^|]*\|pending/.test(out), out);
  out = db.applyFileAtomic(F('radar.sql'));
  chk('applying it twice is harmless (idempotent)', !/CHECK THIS/.test(out) && V("select count(*) from public.radar_config where key = 'POLYMARKET_DATA_ENABLED'") === '1', out.slice(0, 300));

  /* ===================================================================== */
  /* 2. THE RULES: ONE CONSTANT                                            */
  /* ===================================================================== */
  const rules = fn('public.radar_rules()');
  const differ = Object.keys(RULES).filter((k) => JSON.stringify(rules[k]) !== JSON.stringify(RULES[k]));
  chk('the H-RADAR-02 registration\'s frozen rules equal radar_rules(), key by key (rules version 2)', differ.length === 0, differ.map((k) => k + ': ' + JSON.stringify(rules[k]) + ' vs ' + JSON.stringify(RULES[k])));
  chk('radar_rules() carries every rule the core reads', R.RULE_KEYS.every((k) => rules[k] !== undefined));
  chk('radar_rule() reads one', V("select public.radar_rule('min_graded')") === '50' && V("select public.radar_rule('top_wallets')") === '10');
  chk('the live hypothesis is H-RADAR-02, graded as radar-grade-2', V('select public.radar_hypothesis()') === 'H-RADAR-02' && V('select public.radar_grading_version()') === 'radar-grade-2');

  /* ===================================================================== */
  /* 3. THE SWITCH                                                         */
  /* ===================================================================== */
  chk('Radar starts OFF', V('select public.radar_enabled()') === 'f');
  const stAnon = fn('public.radar_status()', db.anon);
  chk('the status is readable by anyone: off, not registered, EXPERIMENTAL', stAnon.enabled === false && stAnon.registered === false && stAnon.status === 'EXPERIMENTAL' && stAnon.min_graded === 50);
  for (const [who, run] of [['anon', db.anon], ['reader A', asA], ['a subscriber', asSub]]) {
    chk('off: the leaderboard is shut for ' + who, fn('public.radar_leaderboard(10)', run).status === 'disabled');
    chk('off: a trader page is shut for ' + who, fn("public.radar_trader('" + W('1') + "')", run).status === 'disabled');
    chk('off: Smart Money Tonight is shut for ' + who, fn('public.radar_tonight()', run).status === 'disabled');
  }
  const deny = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":10}'::jsonb)", db.service);
  chk('off: the gateway grants nothing (denied_disabled), and records the refusal', deny.decision === 'denied_disabled' && deny.granted === 0
    && V("select decision from public.poly_api_grants order by grant_id desc limit 1") === 'denied_disabled');
  chk('no client can read or change the switch', fails(() => db.anon('select * from public.radar_config;')) && fails(() => asSub("update public.radar_config set value = 'on';")));
  db.service("update public.radar_config set value = 'on', note = 'test: terms read by the owner' where key = 'POLYMARKET_DATA_ENABLED';");
  chk('turning it on is one statement, and it is logged (append-only)', V('select public.radar_enabled()') === 't'
    && V("select new_value || '|' || old_value from public.radar_config_log where key = 'POLYMARKET_DATA_ENABLED' order by id desc limit 1") === 'on|off'
    && fails(() => V('delete from public.radar_config_log;')));
  chk('on but not registered: every door says not_registered and shows nothing', fn('public.radar_leaderboard(10)', db.anon).status === 'not_registered'
    && fn('public.radar_tonight()', asSub).status === 'not_registered' && fn("public.radar_trader('" + W('1') + "')", db.anon).status === 'not_registered');

  /* ===================================================================== */
  /* 4. THE GATEWAY'S BUDGET                                               */
  /* ===================================================================== */
  const g1 = fn("public.poly_api_acquire('{\"caller\":\"polymarket_sync:wallets\",\"requested\":5000}'::jsonb)", db.service);
  chk('a run gets at most the per-run cap (3,000 of 5,000 asked)', g1.decision === 'granted' && g1.granted === 3000 && g1.run_cap === 3000);
  const s1 = fn("public.poly_api_settle('{\"grant_id\":" + g1.grant_id + ",\"used\":1200,\"rate_limited\":2}'::jsonb)", db.service);
  chk('settling returns the unused 1,800 to the day', s1.settled === true && s1.returned === 1800
    && V("select granted || '|' || used || '|' || rate_limited from public.poly_api_days") === '1200|1200|2');
  chk('a grant is settled once', fn("public.poly_api_settle('{\"grant_id\":" + g1.grant_id + ",\"used\":1}'::jsonb)", db.service).settled === false);
  const g2 = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":10}'::jsonb)", db.service);
  chk('using more than the grant is refused', fails(() => db.service("select public.poly_api_settle('{\"grant_id\":" + g2.grant_id + ",\"used\":11}'::jsonb);")));
  db.service("select public.poly_api_settle('{\"grant_id\":" + g2.grant_id + ",\"used\":10}'::jsonb);");
  V("update public.poly_api_days set granted = 39995");
  const g3 = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":100}'::jsonb)", db.service);
  chk('the daily ceiling (40,000): only what is left is granted', g3.granted === 5);
  const g4 = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":100}'::jsonb)", db.service);
  chk('…then nothing (denied_budget): a refusal, never a wait', g4.decision === 'denied_budget' && g4.granted === 0);
  V("update public.poly_api_days set granted = 0, used = 0");
  db.service("select public.poly_api_settle('{\"grant_id\":" + g3.grant_id + ",\"used\":5,\"breaker\":true}'::jsonb);");
  const g5 = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":100}'::jsonb)", db.service);
  chk('a run that opened the breaker shuts the gateway for 15 minutes', g5.decision === 'denied_breaker' && g5.granted === 0, g5);
  V("update public.poly_api_days set breaker_until = now() - interval '1 second', granted = 0, used = 0");
  chk('no client may ask the gateway for requests', fails(() => db.anon("select public.poly_api_acquire('{}'::jsonb);")) && fails(() => asSub("select public.poly_api_acquire('{}'::jsonb);"))
    && fails(() => asA("select public.poly_api_settle('{}'::jsonb);")));

  /* DEAD RUNS (owner's decision, 2026-10-30): a run that dies never settles, and its whole grant stayed reserved for the
     rest of the day (2026-10-30: 40,000 granted, 17,785 used). Fifteen minutes after it was given, the next acquire
     settles it at what its run last reported plus 100, never more than it was granted. The ceiling is unchanged. */
  /* A grant's reservation belongs to the UTC day it was given: each dead grant is reserved on its own day's row, so the
     test reads the same whatever the hour (20 minutes ago is yesterday until 00:20 UTC: the deploy gate failed at 00:08) */
  const deadGrant = (req, at) => +V(`insert into public.poly_api_grants (caller, requested, granted, decision, granted_at) values ('polymarket_sync:tonight', ${req}, ${req}, 'granted', ${at}) returning grant_id;`);
  const reserve = (req, at) => V(`insert into public.poly_api_days (day, granted) values (((${at}) at time zone 'utc')::date, ${req})
    on conflict (day) do update set granted = public.poly_api_days.granted + excluded.granted;`);
  const AGO20 = "now() - interval '20 minutes'", AGO5 = "now() - interval '5 minutes'";
  /* and one given at 23:40 UTC the day before, every time: its run died before midnight */
  const LASTNIGHT = "date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '20 minutes'";
  V("update public.poly_api_days set granted = 0, used = 0");
  const dA = deadGrant(400, AGO20), dB = deadGrant(900, AGO20), dC = deadGrant(400, AGO5), dY = deadGrant(400, LASTNIGHT);
  reserve(400, AGO20); reserve(900, AGO20); reserve(400, AGO5); reserve(400, LASTNIGHT);
  const days = () => V("select sum(granted) || '|' || sum(used) from public.poly_api_days");
  const deadGrant = (req, ago) => +V(`insert into public.poly_api_grants (caller, requested, granted, decision, granted_at) values ('polymarket_sync:tonight', ${req}, ${req}, 'granted', now() - interval '${ago}') returning grant_id;`);
  const dA = deadGrant(400, '20 minutes'), dB = deadGrant(900, '20 minutes'), dC = deadGrant(400, '5 minutes');
  // each grant is charged to its own UTC day: from 00:00 to 00:20 UTC, 20 minutes ago is yesterday (run 41148425430,
  // 00:08 UTC), so each day's row holds its own grants and the checks below add the days up
  const daysTotal = () => V("select sum(granted) || '|' || sum(used) from public.poly_api_days");
  V("update public.poly_api_days set granted = 0, used = 0");
  V(`insert into public.poly_api_days (day, granted) select (granted_at at time zone 'utc')::date, sum(granted) from public.poly_api_grants where grant_id in (${dA}, ${dB}, ${dC}) group by 1 on conflict (day) do update set granted = excluded.granted, used = 0;`);
  fn(`public.poly_api_progress('{"grant_id":${dB},"used":300}'::jsonb)`, db.service);
  fn(`public.poly_api_progress('{"grant_id":${dB},"used":120}'::jsonb)`, db.service);
  chk('dead runs: progress never goes backwards (a late, older report does not lower it)', V(`select used from public.poly_api_progress where grant_id = ${dB}`) === '300');
  fn(`public.poly_api_progress('{"grant_id":${dC},"used":999}'::jsonb)`, db.service);
  chk('dead runs: progress is capped at the grant', V(`select used from public.poly_api_progress where grant_id = ${dC}`) === '400');
  const gNext = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":10}'::jsonb)", db.service);
  chk('dead runs: a grant unsettled after 15 minutes that never reported is settled at 100 of its 400, recorded as expired',
    V(`select used || '|' || (statuses ->> 'expired') from public.poly_api_settlements where grant_id = ${dA}`) === '100|true');
  chk('dead runs: one that reported 300 of 900 is settled at 400 (its last report plus 100)', V(`select used from public.poly_api_settlements where grant_id = ${dB}`) === '400');
  chk('dead runs: a grant 5 minutes old is left alone: its run may still be working', V(`select count(*) from public.poly_api_settlements where grant_id = ${dC}`) === '0');
  chk('dead runs: the days get back what they did not use (2,100 - 300 - 500 - 300 = 1,000, then the new 10), and count what they may have used (600)',
    gNext.decision === 'granted' && days() === '1010|600', days());
  /* every day's row counts exactly what the expired grants given on that day may have used (the rows were zeroed above) */
  const ownDays = () => V(`select bool_and(d.used = coalesce(x.u, 0)) from public.poly_api_days d left join (
      select (g.granted_at at time zone 'utc')::date as day, sum(st.used) as u from public.poly_api_grants g
        join public.poly_api_settlements st on st.grant_id = g.grant_id where st.statuses ? 'expired' group by 1) x on x.day = d.day`);
  chk('dead runs: a grant given before midnight UTC is settled on its own day (100 of 400), never on today\'s; so is every other',
    V(`select used from public.poly_api_settlements where grant_id = ${dY}`) === '100' && ownDays() === 't',
    V("select string_agg(day || ':' || granted || '|' || used, ' ' order by day) from public.poly_api_days"));
  chk('dead runs: a late settlement of an expired grant changes nothing', fn(`public.poly_api_settle('{"grant_id":${dA},"used":50}'::jsonb)`, db.service).settled === false
    && days() === '1010|600');
  chk('dead runs: the day gets back what they did not use (1,700 - 300 - 500 = 900, then the new 10), and counts what they may have used (500)',
    gNext.decision === 'granted' && daysTotal() === '910|500', daysTotal());
  chk('dead runs: a late settlement of an expired grant changes nothing', fn(`public.poly_api_settle('{"grant_id":${dA},"used":50}'::jsonb)`, db.service).settled === false
    && daysTotal() === '910|500');
  chk('dead runs: no client may report progress', fails(() => db.anon(`select public.poly_api_progress('{"grant_id":${dC},"used":1}'::jsonb);`))
    && fails(() => asSub(`select public.poly_api_progress('{"grant_id":${dC},"used":1}'::jsonb);`)) && fails(() => asSub('select count(*) from public.poly_api_progress;')));
  db.service(`select public.poly_api_settle('{"grant_id":${dC},"used":0}'::jsonb);`);
  db.service(`select public.poly_api_settle('{"grant_id":${gNext.grant_id},"used":0}'::jsonb);`);
  V("delete from public.poly_api_days where day <> (now() at time zone 'utc')::date");
  V("update public.poly_api_days set granted = 0, used = 0");
  // whatever the clock: a dead grant given at 23:40 UTC yesterday gives back to yesterday, not to today
  const today = "(now() at time zone 'utc')::date";
  const dY = +V(`insert into public.poly_api_grants (caller, requested, granted, decision, granted_at) values ('polymarket_sync:tonight', 300, 300, 'granted', (date_trunc('day', now() at time zone 'utc') - interval '20 minutes') at time zone 'utc') returning grant_id;`);
  V(`insert into public.poly_api_days (day, granted) values (${today} - 1, 300);`);
  const gY = fn("public.poly_api_acquire('{\"caller\":\"t\",\"requested\":10}'::jsonb)", db.service);
  chk('dead runs: a grant from yesterday is settled on yesterday (300 granted, 100 used), and today has only the new 10',
    V(`select used from public.poly_api_settlements where grant_id = ${dY}`) === '100'
    && V(`select granted || '|' || used from public.poly_api_days where day = ${today} - 1`) === '100|100'
    && V(`select granted || '|' || used from public.poly_api_days where day = ${today}`) === '10|0',
    V(`select string_agg(day || ':' || granted || '|' || used, ' ' order by day) from public.poly_api_days`));
  db.service(`select public.poly_api_settle('{"grant_id":${gY.grant_id},"used":0}'::jsonb);`);
  V("delete from public.poly_api_days where day <> (now() at time zone 'utc')::date");
  V("update public.poly_api_days set granted = 0, used = 0");

  /* ===================================================================== */
  /* 5-7. THE WORLD, AND EVERY GUARD ON THE WAY IN                          */
  /* ===================================================================== */
  /* the board: E1 KC @ LV in 3 h (fresh fairs), E2 MIA @ BUF in 5 h (a fair 3 h old), E3 in 4 h, E4 in 2 h */
  const sig = (k, ev, home, away, startMin, market, sel, point, fair, seenMin) => V(`insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point, sharp_fair, last_seen_at)
    values (${lit(k)}, ${lit(ev)}, 'americanfootball_nfl', ${at(startMin)}, ${lit(home)}, ${lit(away)}, ${lit(market)}, ${lit(sel)}, ${point == null ? 'null' : point}, ${fair}, ${at(-seenMin)});`);
  sig('E1|h2h|KC', 'E1', 'Las Vegas Raiders', 'Kansas City Chiefs', 180, 'h2h', 'Kansas City Chiefs', null, 0.62, 10);
  sig('E1|h2h|LV', 'E1', 'Las Vegas Raiders', 'Kansas City Chiefs', 180, 'h2h', 'Las Vegas Raiders', null, 0.38, 10);
  sig('E2|h2h|MIA', 'E2', 'Buffalo Bills', 'Miami Dolphins', 300, 'h2h', 'Miami Dolphins', null, 0.45, 180);
  sig('E2|h2h|BUF', 'E2', 'Buffalo Bills', 'Miami Dolphins', 300, 'h2h', 'Buffalo Bills', null, 0.55, 180);
  sig('E3|h2h|NYJ', 'E3', 'New England Patriots', 'New York Jets', 240, 'h2h', 'New York Jets', null, 0.4, 10);
  sig('E4|h2h|DEN', 'E4', 'Denver Broncos', 'Seattle Seahawks', 120, 'h2h', 'Seattle Seahawks', null, 0.5, 10);
  const market = (c, ev, startMin, outcomes, sides, o) => {
    o = o || {};
    db.service(`insert into public.poly_markets (condition_id, question, league, market_type, outcomes, token_ids, game_start_at, closed, event_ref)
      values (${lit(c)}, ${lit(outcomes.join(' vs. '))}, 'nfl', ${lit(o.type || 'moneyline')}, ${lit(JSON.stringify(outcomes))}::jsonb, ${lit(JSON.stringify([c + ':0', c + ':1']))}::jsonb, ${at(startMin)}, false, ${lit(ev + '-pm')});`);
    if (ev) db.service(`update public.poly_markets set event_id = ${lit(ev)}, sport_key = 'americanfootball_nfl', match_status = 'mapped', matched_at = now(), linker_version = 'radar-link-1',
      sides = ${lit(JSON.stringify(sides.map((s, i) => ({ outcome_index: i, token_id: c + ':' + i, selection: s[0], point: s[1], sig_key: s[2] }))))}::jsonb where condition_id = ${lit(c)};`);
  };
  market(C('1'), 'E1', 180, ['Chiefs', 'Raiders'], [['Kansas City Chiefs', null, 'E1|h2h|KC'], ['Las Vegas Raiders', null, 'E1|h2h|LV']]);
  market(C('2'), 'E2', 300, ['Dolphins', 'Bills'], [['Miami Dolphins', null, 'E2|h2h|MIA'], ['Buffalo Bills', null, 'E2|h2h|BUF']]);
  market(C('3'), 'E3', 240, ['Jets', 'Patriots'], [['New York Jets', null, 'E3|h2h|NYJ'], ['New England Patriots', null, null]]);
  market(C('4'), 'E4', 120, ['Seahawks', 'Broncos'], [['Seattle Seahawks', null, 'E4|h2h|DEN'], ['Denver Broncos', null, null]]);
  market(C('5'), 'E1', 180, ['Raiders', 'Chiefs'], [['Las Vegas Raiders', 3.5, null], ['Kansas City Chiefs', -3.5, null]], { type: 'spreads' });
  /* a mapping is written once */
  chk('a matched market cannot be moved to another game', fails(() => db.service(`update public.poly_markets set event_id = 'E2' where condition_id = ${lit(C('1'))};`)));
  chk('…nor its sides rewritten', fails(() => db.service(`update public.poly_markets set sides = '[{},{}]'::jsonb where condition_id = ${lit(C('1'))};`)));
  chk('a market is never deleted', fails(() => db.service(`delete from public.poly_markets where condition_id = ${lit(C('1'))};`)));
  chk('a mapped market must carry two sides', fails(() => db.service(`insert into public.poly_markets (condition_id, event_id, match_status, sides) values (${lit(C('9'))}, 'E9', 'mapped', '[{}]'::jsonb);`)));
  chk('a condition id must be one', fails(() => db.service(`insert into public.poly_markets (condition_id) values ('not-a-condition');`)));

  /* the pool: four top directional wallets, a market maker, a small sample, a wallet outside the grade */
  const T1 = W('1'), T2 = W('2'), T3 = W('3'), T4 = W('4'), MM = W('5'), SS = W('6'), OUT = W('7');
  db.service(`insert into public.poly_wallets (wallet, in_pool, pool_rank, display_name, display_public) values
    (${lit(T1)}, true, 1, 'SharpAlice', true), (${lit(T2)}, true, 2, 'HiddenBob', false), (${lit(T3)}, true, 3, null, false), (${lit(T4)}, true, 4, null, false),
    (${lit(MM)}, true, 5, 'Maker', true), (${lit(SS)}, true, 6, null, false), (${lit(OUT)}, true, 7, null, false);`);

  /* trades: a hash, always */
  const trade = (w, c, oi, side, size, price, min) => `insert into public.poly_trades (wallet, kind, side, condition_id, token_id, outcome_index, size, price, usdc, traded_at, tx_hash)
    values (${lit(w)}, 'TRADE', ${lit(side)}, ${lit(c)}, ${lit(c + ':' + oi)}, ${oi}, ${size}, ${price}, ${size * price}, ${at(min)}, ${lit(TX())});`;
  db.service(trade(T1, C('1'), 0, 'BUY', 100, 0.4, -600));
  chk('a trade without a transaction hash is refused', fails(() => db.service(`insert into public.poly_trades (wallet, kind, side, condition_id, token_id, size, price, traded_at, tx_hash) values (${lit(T1)}, 'TRADE', 'BUY', ${lit(C('1'))}, 't', 1, 0.5, now(), 'nohash');`)));
  chk('a TRADE needs its side, token, size and price', fails(() => db.service(`insert into public.poly_trades (wallet, kind, condition_id, traded_at, tx_hash) values (${lit(T1)}, 'TRADE', ${lit(C('1'))}, now(), ${lit(TX())});`)));
  const dupTx = TX();
  db.service(`insert into public.poly_trades (wallet, kind, side, condition_id, token_id, outcome_index, size, price, traded_at, tx_hash) values (${lit(T2)}, 'TRADE', 'BUY', ${lit(C('1'))}, ${lit(C('1') + ':0')}, 0, 10, 0.5, now(), ${lit(dupTx)})
    on conflict (tx_hash, wallet, kind, token_key, side_key, size_key, price_key) do nothing;`.replace(/\n\s+/g, ' '));
  db.service(`insert into public.poly_trades (wallet, kind, side, condition_id, token_id, outcome_index, size, price, traded_at, tx_hash) values (${lit(T2)}, 'TRADE', 'BUY', ${lit(C('1'))}, ${lit(C('1') + ':0')}, 0, 10, 0.5, now(), ${lit(dupTx)})
    on conflict (tx_hash, wallet, kind, token_key, side_key, size_key, price_key) do nothing;`.replace(/\n\s+/g, ' '));
  chk('the same trade read twice is stored once', V(`select count(*) from public.poly_trades where tx_hash = ${lit(dupTx)}`) === '1');

  /* ===================================================================== */
  /* 5. APPEND-ONLY                                                        */
  /* ===================================================================== */
  for (const t of ['poly_trades', 'poly_api_grants', 'radar_config_log']) {
    chk(t + ': the service role cannot update', fails(() => db.service(`update public.${t} set ${t === 'poly_trades' ? 'size = 1' : t === 'poly_api_grants' ? 'granted = 1' : "note = 'x'"};`)));
    chk(t + ': the service role cannot delete', fails(() => db.service(`delete from public.${t};`)));
    chk(t + ': not even the owner can truncate', fails(() => V(`truncate public.${t};`)));
  }

  /* ===================================================================== */
  /* 7. BETS: ONLY AT THE MARKET'S OWN SETTLEMENT                           */
  /* ===================================================================== */
  /* a finished game: C6 resolved Chiefs (outcome 0) */
  db.service(`insert into public.poly_markets (condition_id, question, league, market_type, outcomes, token_ids, game_start_at, closed, event_ref)
    values (${lit(C('6'))}, 'Chiefs vs. Broncos', 'nfl', 'moneyline', '["Chiefs","Broncos"]'::jsonb, ${lit(JSON.stringify([C('6') + ':0', C('6') + ':1']))}::jsonb, date_trunc('second', now()) - interval '2 days', false, 'g6');`);
  const START6 = Date.parse(V("select to_char(game_start_at at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from public.poly_markets where condition_id = " + lit(C('6'))));
  const tx6 = TX();
  /* the core builds and grades the bet, as polymarket_sync does */
  /* its fee status as covered markets send it (probe run 40975470572): fees enabled at a schedule rate of 0, so no fee */
  const mk6 = { condition_id: C('6'), league: 'nfl', market_type: 'moneyline', outcomes: ['Chiefs', 'Broncos'], token_ids: [C('6') + ':0', C('6') + ':1'], game_start_at: START6, closed: true, settle: [1, 0], event_ref: 'g6', question: 'Chiefs vs. Broncos', fees_enabled: true, fee_schedule: { rate: 0, exponent: 1 } };
  db.service(`update public.poly_markets set fees_enabled = true, fee_schedule = '{"rate": 0, "exponent": 1, "taker_only": true}'::jsonb where condition_id = ${lit(C('6'))};`);
  const bets6 = R.buildBets([{ wallet: T1, kind: 'TRADE', tx_hash: tx6, ts: START6 - 120 * 60000, condition_id: C('6'), token_id: C('6') + ':0', outcome_index: 0, side: 'BUY', size: 250, price: 0.4 }], { [C('6')]: mk6 }, RULES).bets;
  const hist6 = [{ t: START6 - 125 * 60000, p: 0.4 }, { t: START6 - 116 * 60000, p: 0.42 }, { t: START6 - 106 * 60000, p: 0.43 }, { t: START6 - 20 * 60000, p: 0.47 }];
  const b6 = R.gradeBet(bets6[0], hist6, RULES);
  const iso = (ms) => ms == null ? null : new Date(ms).toISOString();
  const betRow = (b, over) => Object.assign({ wallet: b.wallet, token_id: b.token_id, condition_id: b.condition_id, outcome_index: b.outcome_index, outcome: b.outcome, league: b.league,
    market_type: b.market_type, line: b.line, event_ref: b.event_ref, question: b.question, game_start_at: iso(b.game_start_at), entry_at: iso(b.entry_at), entry_tx: b.entry_tx, txs: b.txs,
    entry_price: b.entry_price, stake: b.stake, shares_pregame: b.shares_pregame, buy_cost: b.buy_cost, sell_proceeds: b.sell_proceeds, shares_held: b.shares_held, trades: b.trades,
    settle: b.settle, result: b.result, profit: b.profit, close_price: b.close_price, close_at: iso(b.close_at), clv_pp: b.clv_pp, clv_pct: b.clv_pct,
    follow5_price: b.follow5_price, follow5_at: iso(b.follow5_at), follow5_reason: b.follow5_reason, follow5_roi: b.follow5_roi,
    follow15_price: b.follow15_price, follow15_at: iso(b.follow15_at), follow15_reason: b.follow15_reason, follow15_roi: b.follow15_roi, beat_close5: b.beat_close5,
    follow5_mid: b.follow5_mid == null ? null : b.follow5_mid, follow15_mid: b.follow15_mid == null ? null : b.follow15_mid,
    follow5_fee: b.follow5_fee == null ? null : b.follow5_fee, follow15_fee: b.follow15_fee == null ? null : b.follow15_fee, grading_version: b.grading_version || R.GRADING_VERSION }, over || {});
  /* the columns it names (so every other keeps its default), as PostgREST inserts */
  const putBet = (row) => { const cols = Object.keys(row).join(', '); return db.service(`insert into public.poly_bets (${cols}) select ${cols} from jsonb_populate_record(null::public.poly_bets, ${lit(JSON.stringify(row))}::jsonb);`); };
  chk('a bet on a market that has not resolved is refused', fails(() => putBet(betRow(b6))));
  db.service(`update public.poly_markets set settle = '[1,0]'::jsonb, closed = true, resolved_at = now() where condition_id = ${lit(C('6'))};`);
  chk('a resolution is final', fails(() => db.service(`update public.poly_markets set settle = '[0,1]'::jsonb where condition_id = ${lit(C('6'))};`)));
  chk('a bet at another settlement than its market\'s is refused', fails(() => putBet(betRow(b6, { settle: 0, result: 'loss', profit: -100, follow5_roi: -1, follow15_roi: -1 }))));
  chk('a bet whose profit does not add up is refused', fails(() => putBet(betRow(b6, { profit: 999 }))));
  chk('a bet whose follow ROI is not settle / follow price - 1 is refused', fails(() => putBet(betRow(b6, { follow5_roi: 0.5 }))));
  chk('a follow price from after entry + 5 minutes is refused (the rules\' own lag)', fails(() => putBet(betRow(b6, { follow5_at: iso(b6.entry_at + 7 * 60000) }))));
  chk('a close from more than 60 minutes before the start is refused', fails(() => putBet(betRow(b6, { close_at: iso(START6 - 90 * 60000) }))));
  chk('an entry after the start is refused', fails(() => putBet(betRow(b6, { entry_at: iso(START6 + 60000) }))));
  chk('the entry transaction must be one of the bet\'s', fails(() => putBet(betRow(b6, { entry_tx: TX() }))));
  chk('version 2: a follow price that is not the midpoint plus follow_cost is refused', fails(() => putBet(betRow(b6, { follow5_price: 0.42, follow5_roi: 1 / 0.42 - 1, beat_close5: true }))));
  chk('version 2: a follow fee that is not the market\'s taker fee at that price is refused (this market charges none)', fails(() => putBet(betRow(b6, { follow5_fee: 0.01, follow5_roi: 1 / 0.44 - 1 }))));
  /* the taker fee, as Polymarket publishes it (docs.polymarket.com, trading/fees): 100 shares at 50¢ in Sports (0.05) pay $1.25, at 30¢ $1.05; Crypto (0.07) at 50¢ $1.75 */
  chk('the taker fee is Polymarket\'s formula: rate x (p x (1 - p))^exponent, as its fee tables', V(`select (100 * public.radar_taker_fee(0.5, '{"rate":0.05,"exponent":1}', true))::numeric(8,2) || ',' || (100 * public.radar_taker_fee(0.3, '{"rate":0.05,"exponent":1}', true))::numeric(8,2) || ',' || (100 * public.radar_taker_fee(0.5, '{"rate":0.07,"exponent":1}', true))::numeric(8,2)`) === '1.25,1.05,1.75');
  chk('…no fee when the market has fees off; unknown (null) when never read or the schedule is unreadable', V(`select public.radar_taker_fee(0.5, null, false)::text || ',' || coalesce(public.radar_taker_fee(0.5, null, null)::text, 'null') || ',' || coalesce(public.radar_taker_fee(0.5, '{"rate":"x"}', true)::text, 'null')`) === '0,null,null');
  chk('…and the SQL and the core give the same fee', [0.07, 0.31, 0.5, 0.56, 0.93].every((p) => Math.abs(Number(V(`select public.radar_taker_fee(${p}, '{"rate":0.05,"exponent":1}', true)`)) - R.takerFee(p, { rate: 0.05, exponent: 1 })) < 1e-9));
  putBet(betRow(b6));
  const stored6 = one(`select entry_price, stake, close_price, clv_pp, follow5_mid, follow5_price, follow5_roi, beat_close5, result, grading_version from public.poly_bets where wallet = ${lit(T1)}`);
  /* 250 @ 0.40: entry 0.40; the follow is the midpoint at entry + 5 min (0.42, observed at -116 min) plus 1 cent; the close 0.47 */
  chk('the core\'s bet is stored as graded at version 2: entry 0.40, follow 0.42 + 1 cent = 0.43, close 0.47, CLV +7 pp, beat the close', Number(stored6.entry_price) === 0.4
    && Number(stored6.follow5_mid) === 0.42 && Number(stored6.follow5_price) === 0.43 && Number(stored6.close_price) === 0.47 && Number(stored6.clv_pp) === 7 && stored6.beat_close5 === true
    && stored6.result === 'win' && stored6.grading_version === 'radar-grade-2', stored6);
  chk('…follow ROI = 1 / 0.43 - 1', Math.abs(Number(stored6.follow5_roi) - (1 / 0.43 - 1)) < 1e-5);
  chk('a bet is graded once a version', fails(() => putBet(betRow(b6))));
  /* the same bet's H-RADAR-01 grade (version 1, the midpoint itself) sits beside it, never edited */
  const b6v1 = R.gradeBet(bets6[0], hist6, REG1.spec.rules);
  putBet(betRow(b6v1));
  chk('…its version-1 grade sits beside it: one row a version', V(`select string_agg(grading_version || ':' || follow5_price, ',' order by grading_version) from public.poly_bets where wallet = ${lit(T1)}`) === 'radar-grade-1:0.42,radar-grade-2:0.43');
  chk('poly_bets: the service role cannot update or delete', fails(() => db.service('update public.poly_bets set profit = 0;')) && fails(() => db.service('delete from public.poly_bets;')));

  /* ===================================================================== */
  /* 8. GRADING MATH, STORED                                               */
  /* ===================================================================== */
  const mkBets = (n, w, fWin) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const win = i % 2 === 0;
      out.push({ wallet: w, token_id: 't' + i, entry_at: 1e12 + i * 3600e3, settle: win ? 1 : 0, result: win ? 'win' : 'loss', stake: 100, buy_cost: 100, profit: win ? 110 : -100,
        clv_pp: 2, clv_pct: 0.04, follow5_roi: win ? fWin : -1, follow15_roi: win ? 1 : -1, beat_close5: true });
    }
    return out;
  };
  const gradeOf = (w, n, fWin, style) => Object.assign(R.gradeWallet(mkBets(n, w, fWin), { style: style || 'Directional', markets: 10 }, RULES), { wallet: w, history_truncated: false });
  const grades = [gradeOf(T1, 60, 1.5), gradeOf(T2, 60, 1.4), gradeOf(T3, 60, 1.3), gradeOf(T4, 60, 1.2), gradeOf(MM, 60, 1.6, 'Market Maker'), gradeOf(SS, 20, 2)];
  R.rankWallets(grades, RULES);
  const gRows = grades.map((g) => Object.assign({}, g, { first_bet_at: iso(g.first_bet_at), last_bet_at: iso(g.last_bet_at), rank: g.rank == null ? null : g.rank }));
  /* THE SYNC STATE (presentation only): before any grading run under the live rules, the page says the sync is pending */
  const syncSvc = () => JSON.parse(db.service('select public.radar_sync_state();'));
  chk('sync: no grading run under the live rules yet reads pending (first_grade), never "nobody holds a position"', syncSvc().state === 'pending' && syncSvc().reason === 'first_grade', syncSvc());
  const RUN1 = crypto.randomUUID();
  const put = (runId, rowsJ, rulesJ) => db.service(`select public.radar_put_grades(${lit(JSON.stringify({ run_id: runId, started_at: new Date().toISOString(), grading_version: R.gradingVersion(rules), rules: rulesJ || rules }))}::jsonb, ${lit(JSON.stringify(rowsJ))}::jsonb);`);
  chk('a run graded with other rules is refused', fails(() => put(crypto.randomUUID(), gRows, Object.assign({}, rules, { min_graded: 30 }))));
  const swapped = gRows.map((g) => Object.assign({}, g, { rank: g.rank === 1 ? 2 : g.rank === 2 ? 1 : g.rank }));
  chk('ranks that do not run 1..n by Radar Score are refused', fails(() => put(crypto.randomUUID(), swapped)));
  const tooMany = []; for (let i = 0; i < 26; i++) { const g = gradeOf('0x' + String(i).padStart(40, 'c'), 60, 1 + i / 10); tooMany.push(g); }
  R.rankWallets(tooMany, RULES);
  chk('more than 10 featured wallets are refused (H-RADAR-02\'s top_wallets)', fails(() => put(crypto.randomUUID(), tooMany.map((g) => Object.assign({}, g, { top_directional: true, first_bet_at: iso(g.first_bet_at), last_bet_at: iso(g.last_bet_at) })))));
  const mmTop = gRows.map((g) => g.wallet === MM ? Object.assign({}, g, { top_directional: true }) : g);
  chk('a market maker marked top-graded is refused', fails(() => put(crypto.randomUUID(), mmTop)));
  const smallRanked = gRows.map((g) => g.wallet === SS ? Object.assign({}, g, { sample: 'ranked', radar_score: 1, score_parts: {}, rank: 6 }) : g);
  chk('a 20-bet grade marked ranked is refused (the rules\' own 50)', fails(() => put(crypto.randomUUID(), smallRanked)));
  chk('a ROI that is not profit / staked is refused', fails(() => put(crypto.randomUUID(), gRows.map((g) => g.wallet === T1 ? Object.assign({}, g, { roi: 0.9 }) : g))));
  /* H-RADAR-02: featured needs a Radar Score above 0 and is never a high-frequency wallet (the database's own rule) */
  const loser = Object.assign(gradeOf('0x' + 'd'.repeat(40), 60, 0.1), {});
  const withLoser = grades.concat([loser]);
  R.rankWallets(withLoser, RULES);
  const loserRows = withLoser.map((g) => Object.assign({}, g, { first_bet_at: iso(g.first_bet_at), last_bet_at: iso(g.last_bet_at), rank: g.rank == null ? null : g.rank }));
  chk('v2: the core does not feature a wallet whose Radar Score is not above 0', loser.radar_score < 0 && loser.top_directional === false, { score: loser.radar_score });
  chk('v2: a wallet featured with a Radar Score not above 0 is refused', fails(() => put(crypto.randomUUID(), loserRows.map((g) => g.wallet === loser.wallet ? Object.assign({}, g, { top_directional: true }) : g))));
  chk('v2: a high-frequency wallet featured is refused', fails(() => put(crypto.randomUUID(), gRows.map((g) => g.wallet === T1 ? Object.assign({}, g, { high_frequency: true }) : g))));
  const putRes = JSON.parse(put(RUN1, gRows));
  chk('the core\'s grades are written as one run: 6 wallets, 5 ranked, 4 top-graded', putRes.wallets === 6 && putRes.ranked === 5 && putRes.top_directional === 4, putRes);
  const back = J(`select wallet, rank, sample, round(radar_score, 2) as s, round(roi, 6) as roi, round(follow5_roi, 6) as f5, top_directional from public.poly_wallet_grades where run_id = ${lit(RUN1)} order by rank nulls last`);
  const coreT1 = grades.find((g) => g.wallet === T1);
  chk('…read back unchanged: the market maker ranks first and is not top-graded; T1..T4 are', back[0].wallet === MM && back[0].top_directional === false
    && back.slice(1, 5).every((r) => r.top_directional) && back[5].wallet === SS && back[5].rank === null && back[5].sample === 'small_sample', back);
  chk('…the stored ROI, follow ROI and score are the core\'s', Number(back[1].roi) === Math.round(coreT1.roi * 1e6) / 1e6 && Number(back[1].f5) === Math.round(coreT1.follow5_roi * 1e6) / 1e6
    && Number(back[1].s) === Math.round(coreT1.radar_score * 100) / 100, { back: back[1], core: coreT1 });
  chk('a grading run is append-only', fails(() => db.service('update public.poly_wallet_grades set rank = 1;')) && fails(() => db.service('delete from public.poly_grade_runs;')));

  /* ===================================================================== */
  /* 6. ACCESS                                                             */
  /* ===================================================================== */
  for (const [who, run] of [['anon', db.anon], ['reader A', asA], ['a subscriber', asSub]]) {
    for (const t of ['poly_trades', 'poly_bets', 'poly_holder_snapshots', 'poly_price_snapshots', 'poly_wallets', 'poly_markets', 'poly_api_days', 'poly_api_grants', 'poly_sync_runs', 'poly_alerts', 'radar_config']) {
      chk(who + ' cannot read ' + t, fails(() => run(`select count(*) from public.${t};`)));
    }
    chk(who + ' cannot write a grade', fails(() => run(`insert into public.poly_wallet_grades (run_id, wallet, graded_bets, wins, losses, pushes, staked, profit, clv_n, follow5_n, follow15_n, style, sample) values (${lit(RUN1)}, ${lit(OUT)}, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'Directional', 'small_sample');`)));
    chk(who + ' cannot call the internal functions', fails(() => run('select public.radar_tonight_cards();')) && fails(() => run(`select public.radar_put_grades('{}'::jsonb, '[]'::jsonb);`)));
    chk(who + ': the grades are hidden by RLS until the live hypothesis is registered', run('select count(*) from public.poly_wallet_grades;') === '0');
  }

  /* ===================================================================== */
  /* 11. THE REGISTRY (before anything is shown)                           */
  /* ===================================================================== */
  const noReg = db.mustFail(() => db.applyFileAtomic(F('radar_registry.sql')));
  chk('the registry SQL stops when the registry is absent: nothing registered', /research registry/.test(noReg || '') && V("select count(*) from public.radar_config where key like 'registry_ref:%'") === '0', noReg && noReg.slice(0, 200));
  V(`create type public.evidence_provenance as enum ('T0', 'T1', 'T2', 'T3');
    create type public.model_status as enum ('experimental', 'validating', 'validated', 'retired');
    create table public.research_models (id uuid primary key default gen_random_uuid(), model_key text unique not null, name text not null, sport text, provenance public.evidence_provenance not null, objective text, created_at timestamptz not null default now());
    create table public.research_model_versions (id bigserial primary key, model_id uuid not null references public.research_models (id), version text not null, status public.model_status not null default 'experimental',
      training_window daterange, validation_window daterange, holdout_window daterange, objective text, min_sample integer, success_metric text, forking_paths jsonb, promotion_criteria jsonb, spec jsonb, created_at timestamptz not null default now());
    -- production's research_model_results requires games_tested (no default): applying radar_registry.sql there refused it on 2026-10-29
    create table public.research_model_results (id bigserial primary key, version_id bigint references public.research_model_versions (id), passed boolean, metrics jsonb, games_tested integer not null, computed_at timestamptz not null default now());
    create view public.research_model_current as select m.model_key, v.version, v.status, r.passed from public.research_models m join public.research_model_versions v on v.model_id = m.id left join public.research_model_results r on r.version_id = v.id;`);
  out = db.applyFileAtomic(F('radar_registry.sql'));
  chk('registered: the report says ok on every row, for both hypotheses', (out.match(/\|ok/g) || []).length === 5 && !/CHECK THIS/.test(out), out.slice(-800));
  const regRow = one("select m.model_key, v.version, v.status::text as status, v.holdout_window::text as holdout, v.forking_paths ->> 'comparisons_made' as cm, v.min_sample from public.research_models m join public.research_model_versions v on v.model_id = m.id where m.model_key = 'H-RADAR-01'");
  chk('H-RADAR-01 v0.1.0 is EXPERIMENTAL with its holdout window and its forking-paths disclosure', regRow.model_key === 'H-RADAR-01' && regRow.version === '0.1.0' && regRow.status === 'experimental'
    && regRow.holdout === '[2026-09-01,2026-10-26)' && regRow.cm === '1' && regRow.min_sample === 200, regRow);
  const reg2 = one("select m.model_key, v.version, v.status::text as status, v.holdout_window::text as holdout, v.training_window::text as training, v.forking_paths ->> 'comparisons_made' as cm, v.min_sample from public.research_models m join public.research_model_versions v on v.model_id = m.id where m.model_key = 'H-RADAR-02'");
  chk('H-RADAR-02 v0.2.0 is EXPERIMENTAL with its 12-week prospective window [2026-10-31, 2027-01-23), its rolling training left blank, and its disclosure',
    reg2.version === '0.2.0' && reg2.status === 'experimental' && reg2.holdout === '[2026-10-31,2027-01-23)' && reg2.training === null && reg2.cm === String(REG.forking_paths.comparisons_made) && reg2.min_sample === 200, reg2);
  chk('…registered before its window opens', Date.parse(REG.registered_at) < Date.parse(REG.machine.window_dates.holdout[0] + 'T00:00:00Z'), REG.registered_at);
  const reportFile = path.join(ROOT, 'research', 'radar', 'H-RADAR-01', 'report.json');
  const hasReport = fs.existsSync(reportFile);
  chk(hasReport ? 'the validation report\'s verdict is ONE result row (H-RADAR-01\'s; H-RADAR-02 has none until its window has run)' : 'no validation report yet: no result row (nothing is claimed)',
    V('select count(*) from public.research_model_results') === (hasReport ? '1' : '0'));
  if (hasReport) chk('the result row carries the games its verdict stands on (games_tested, required in production)',
    V('select games_tested from public.research_model_results') === String(JSON.parse(fs.readFileSync(reportFile, 'utf8')).holdout.games));
  const found = JSON.parse(V("select value from public.radar_config where key = 'h_radar_01_result'"));
  chk('what the holdout test found is recorded for the pages, verbatim', found.hypothesis_id === 'H-RADAR-01' && (hasReport ? found.status === JSON.parse(fs.readFileSync(reportFile, 'utf8')).status : found.status === 'not_run'), found);
  const again = db.applyFileAtomic(F('radar_registry.sql'));
  chk('applying it again writes nothing new', !/CHECK THIS/.test(again) && V('select count(*) from public.research_model_versions') === '2');
  chk('a client cannot register', fails(() => asSub("insert into public.radar_config (key, value) values ('registry_ref:H-RADAR-01', 'x');")));
  /* REGISTERED BEFORE SHOWN, under H-RADAR-02's rules: H-RADAR-01's registration (and its result) stays, but it does not
     open the doors for rules it did not register */
  V("delete from public.radar_config where key = 'registry_ref:H-RADAR-02';");
  chk('H-RADAR-01 registered alone does not open the doors under H-RADAR-02\'s rules', V('select public.radar_registered()') === 'f'
    && db.anon('select count(*) from public.poly_wallet_grades;') === '0' && fn('public.radar_leaderboard(50)', db.anon).status === 'not_registered');
  const restored = db.applyFileAtomic(F('radar_registry.sql'));
  chk('…its own registration does (applying the registry again restores the link, and nothing else)', V('select public.radar_registered()') === 't'
    && !/CHECK THIS/.test(restored) && V('select count(*) from public.research_model_versions') === '2');
  /* an H-RADAR-01 grading run (rules version 1) is never the current run under H-RADAR-02's rules: its top 25 are not featured */
  const RUNV1 = crypto.randomUUID();
  V(`set session_replication_role = replica;
     insert into public.poly_grade_runs (run_id, started_at, finished_at, grading_version, rules, wallets, ranked, top_directional, note)
     values (${lit(RUNV1)}, now(), now() + interval '1 hour', 'radar-grade-1', ${lit(JSON.stringify(REG1.spec.rules))}::jsonb, 0, 0, 0, 'an H-RADAR-01 run, newer than any');
     set session_replication_role = default;`);
  chk('the current run is the latest made under the live rules\' version, never a newer H-RADAR-01 run', V('select public.radar_current_run()') === RUN1, { current: V('select public.radar_current_run()'), v2: RUN1 });

  /* ===================================================================== */
  /* 9. THE DOORS                                                          */
  /* ===================================================================== */
  chk('registered and on: anyone reads the grades (RLS)', db.anon('select count(*) from public.poly_wallet_grades;') === '6' && asA('select count(*) from public.poly_wallet_grades;') === '6');
  const lb = fn('public.radar_leaderboard(50)', db.anon);
  chk('the leaderboard: ranked wallets first, by rank, then the small samples', lb.status === 'ok' && lb.rows.length === 6 && lb.rows.slice(0, 5).map((r) => r.rank).join() === '1,2,3,4,5'
    && lb.rows[5].rank === null && lb.rows[5].sample === 'small_sample', lb.rows && lb.rows.map((r) => r.rank));
  chk('…the Radar Score is EXPERIMENTAL and always comes with its components', lb.radar_score_status === 'EXPERIMENTAL' && lb.rows.slice(0, 5).every((r) => r.score_parts && r.score_parts.follow_roi != null && r.follow5_roi != null && r.clv_pp != null && r.roi != null));
  const byW = {}; lb.rows.forEach((r) => { byW[r.wallet] = r; });
  chk('a public name is shown only when the wallet made it public', byW[T1].display === 'SharpAlice' && byW[MM].display === 'Maker');
  chk('a private name is never shown: the address, shortened', byW[T2].display === T2.slice(0, 6) + '…' + T2.slice(-4) && !JSON.stringify(lb).includes('HiddenBob'));
  chk('no bio, image or profile field is in any answer', !/\b(bio|profile_image|profileImage|x_username)\b/.test(JSON.stringify(lb)));
  const trA = fn(`public.radar_trader('${T1.toUpperCase().replace('0X', '0x')}')`, db.anon);
  chk('a trader page for anyone: the grade and every graded bet with its transactions', trA.status === 'ok' && trA.grade.wallet === T1 && trA.history.length === 1
    && trA.history[0].txs.length === 1 && /^0x[0-9a-f]{64}$/.test(trA.history[0].entry_tx));
  chk('…its open positions are the terminal\'s: none for anon (locked)', trA.positions === null && trA.positions_locked === true);
  chk('a wallet that is not one is refused', fn("public.radar_trader('nope')", db.anon).status === 'bad_wallet');
  chk('a wallet with no grade says so', fn(`public.radar_trader('${OUT}')`, db.anon).status === 'not_graded');

  /* Smart Money Tonight: holders 5 minutes ago (fresh), and 45 minutes ago (stale) */
  const holder = (c, oi, w, shares, avg, ageMin, run) => db.service(`insert into public.poly_holder_snapshots (run_id, captured_at, condition_id, token_id, outcome_index, wallet, shares, avg_price, cost)
    values (${lit(run)}, ${at(-ageMin)}, ${lit(c)}, ${lit(c + ':' + oi)}, ${oi}, ${lit(w)}, ${shares}, ${avg}, ${shares * avg});`);
  const price = (c, oi, p, ageMin, run) => db.service(`insert into public.poly_price_snapshots (run_id, captured_at, condition_id, token_id, outcome_index, price, source)
    values (${lit(run)}, ${at(-ageMin)}, ${lit(c)}, ${lit(c + ':' + oi)}, ${oi}, ${p}, 'gamma_outcome_prices');`);
  const RA = crypto.randomUUID(), RB = crypto.randomUUID();
  /* E1 moneyline: Chiefs 1000 @ 0.40 (T1: 400, 4x its median 100 -> high conviction), 500 @ 0.44 (T2: 220), 300 @ 0.42 (T3: 126);
     Raiders 100 @ 0.60 (T4: 60); the market maker 5000 @ 0.50 on the Chiefs and a small-sample wallet: not counted */
  holder(C('1'), 0, T1, 1000, 0.40, 5, RA); holder(C('1'), 0, T2, 500, 0.44, 5, RA); holder(C('1'), 0, T3, 300, 0.42, 5, RA);
  holder(C('1'), 1, T4, 100, 0.60, 5, RA); holder(C('1'), 0, MM, 5000, 0.5, 5, RA); holder(C('1'), 0, SS, 900, 0.5, 5, RA);
  price(C('1'), 0, 0.60, 5, RA); price(C('1'), 1, 0.41, 5, RA);
  /* E1 spread: one top wallet on the Raiders +3.5: E1's card stays the moneyline's 3 */
  holder(C('5'), 0, T4, 400, 0.5, 5, RA);
  /* E2: T1 on the Dolphins 200 @ 0.47; the board's fair is 3 h old */
  holder(C('2'), 0, T1, 200, 0.47, 5, RA); price(C('2'), 0, 0.50, 5, RA);
  /* E3: only the market maker and the small sample: no card */
  holder(C('3'), 0, MM, 1000, 0.4, 5, RA); holder(C('3'), 1, SS, 1000, 0.6, 5, RA);
  /* E4: a top wallet, but the snapshot is 45 minutes old: no card */
  holder(C('4'), 0, T2, 1000, 0.5, 45, RB);
  chk('Smart Money Tonight is subscribers only: anon gets no card', (() => { const t = fn('public.radar_tonight()', db.anon); return t.status === 'subscribers_only' && t.cards.length === 0; })());
  chk('…nor reader A (signed in, no subscription)', (() => { const t = fn('public.radar_tonight()', asA); return t.status === 'subscribers_only' && t.cards.length === 0; })());
  const tn = fn('public.radar_tonight()', asSub);
  chk('a subscriber gets the cards: two games (E1, E2), most wallets first', tn.status === 'ok' && tn.cards.length === 2 && tn.cards[0].event_id === 'E1' && tn.cards[1].event_id === 'E2', tn.cards && tn.cards.map((c) => c.event_id));
  const c1 = tn.cards[0] || {}, c2 = tn.cards[1] || {};
  chk('E1: the side the top wallets are on (Chiefs), 3 of them, $746', c1.selection === 'Kansas City Chiefs' && c1.n_wallets === 3 && Number(c1.dollars) === 746 && c1.market_type === 'moneyline', c1);
  chk('E1: their average entry is dollar-weighted: 746 / 1800 = 0.4144', Number(c1.avg_entry) === 0.4144, c1.avg_entry);
  chk('E1: the current price 0.60, moved +0.1856 since they entered', Number(c1.current_price) === 0.6 && Number(c1.moved) === 0.1856 && c1.has_moved === true);
  chk('E1: EdgeDesk\'s fair 0.62 is current and at or above the price: smart money agrees', Number(c1.fair) === 0.62 && c1.fair_current === true && c1.agrees === true);
  chk('E1: one top wallet on the other side ($60)', c1.other_side_wallets === 1 && Number(c1.other_side_dollars) === 60);
  chk('E1: the high-conviction flag (T1 at 4x its median stake)', c1.high_conviction === 1 && c1.wallets[0].wallet === T1 && c1.wallets[0].high_conviction === true && Number(c1.wallets[0].conviction) === 4);
  chk('E1: a wallet shows its public name or its shortened address, and its rank', c1.wallets[0].display === 'SharpAlice' && c1.wallets.some((w) => w.display === T2.slice(0, 6) + '…' + T2.slice(-4)) && c1.wallets[0].rank === 2);
  chk('E1: the market maker\'s and the small sample\'s money are not counted', !c1.wallets.some((w) => w.wallet === MM || w.wallet === SS));
  chk('E1: the teams and the start come from the board', c1.home_team === 'Las Vegas Raiders' && c1.away_team === 'Kansas City Chiefs');
  chk('E2: a fair 3 hours old is not current: no agree / disagree line', c2.n_wallets === 1 && c2.fair_current === false && c2.agrees === null);
  chk('no game without a top-graded wallet gets a card (E3), and no stale snapshot shows (E4)', !tn.cards.some((c) => c.event_id === 'E3' || c.event_id === 'E4'));
  /* H-RADAR-02: how many are featured, and OBSERVED ACTIVITY apart from the cards */
  chk('v2: the door says how many wallets are featured (4 of at most 10), under H-RADAR-02', tn.featured === 4 && tn.top_wallets === 10 && tn.hypothesis === 'H-RADAR-02', { featured: tn.featured, top: tn.top_wallets, h: tn.hypothesis });
  const obs = tn.observed || [];
  const oE1 = obs.find((o) => o.event_id === 'E1') || {}, oE3 = obs.find((o) => o.event_id === 'E3') || {};
  chk('v2: observed activity is apart from the cards, labelled observed: E1 and E3', obs.length === 2 && obs.every((o) => o.kind === 'observed') && oE1.n_wallets === 1 && oE3.n_wallets === 1, obs);
  chk('v2: …it counts the evaluated wallets that are not featured (the small sample\'s $450 on the Chiefs), never a featured one', oE1.sides && oE1.sides.length === 1
    && oE1.sides[0].outcome === 'Chiefs' && Number(oE1.sides[0].dollars) === 450 && oE1.sides[0].n_wallets === 1, oE1);
  chk('v2: …never a market maker (its $400 on the Jets is not there: E3 shows only the small sample\'s $600 on the Patriots) and never a stale snapshot (E4)',
    oE3.sides && oE3.sides.length === 1 && oE3.sides[0].outcome === 'Patriots' && Number(oE3.sides[0].dollars) === 600 && !obs.some((o) => o.event_id === 'E4'), oE3);
  chk('v2: …and names no wallet', !JSON.stringify(obs).includes('0x') || !obs.some((o) => 'wallets' in o || (o.sides || []).some((x) => 'wallet' in x || 'wallets' in x)));
  chk('v2: observed activity is subscribers only, like the cards', !('observed' in fn('public.radar_tonight()', db.anon)) && !('observed' in fn('public.radar_tonight()', asA)));
  /* THE SYNC STATE: "sync failed" and "no current position" read differently. The holders sync runs every 10 minutes;
     30 minutes without a good run, or an error as its latest, is a failure; the nightly grade, 36 hours */
  const syncOf = () => fn('public.radar_tonight()', asSub).sync || {};
  const syncRun = (mode, status, ago, message) => db.service(`insert into public.poly_sync_runs (run_id, mode, trigger, status, started_at, finished_at, message)
    values (${lit(crypto.randomUUID())}, '${mode}', 'cron', '${status}', now() - interval '${ago}', now() - interval '${ago}', ${message ? lit(message) : 'null'});`);
  chk('sync: graded, but no holders run on record: failed (holders_stale), never "nobody holds a position"', syncOf().state === 'failed' && syncOf().reason === 'holders_stale', syncOf());
  syncRun('tonight', 'ok', '45 minutes');
  chk('sync: the last good holders run 45 minutes ago is stale: failed, and says when it was', syncOf().state === 'failed' && syncOf().reason === 'holders_stale' && !!syncOf().holders_at, syncOf());
  syncRun('tonight', 'warn', '5 minutes');
  chk('sync: a holders run 5 minutes ago (warn counts as done) and a current grade: ok', syncOf().state === 'ok' && syncOf().reason === null && !!syncOf().graded_at, syncOf());
  syncRun('tonight', 'error', '1 minute', 'tonight error: Polymarket answered 503');
  chk('sync: the latest holders run ended in error: failed, with its message', syncOf().state === 'failed' && syncOf().reason === 'holders_error' && /503/.test(syncOf().last_error || ''), syncOf());
  syncRun('tonight', 'ok', '0 seconds');
  chk('sync: the next good holders run clears it', syncOf().state === 'ok', syncOf());
  chk('sync: the state is in the subscribers\' door only', !('sync' in fn('public.radar_tonight()', db.anon)) && !('sync' in fn('public.radar_tonight()', asA)));
  chk('sync: no client may call radar_sync_state()', fails(() => db.anon('select public.radar_sync_state();')) && fails(() => asA('select public.radar_sync_state();')) && fails(() => asSub('select public.radar_sync_state();')));
  syncRun('grade', 'error', '0 seconds', 'grade error: out of compute');
  chk('sync: a grade that failed after the current one: failed (grade_error), with its message', syncOf().state === 'failed' && syncOf().reason === 'grade_error' && /compute/.test(syncOf().last_error || ''), syncOf());
  /* the price moves above the fair: smart money disagrees */
  price(C('1'), 0, 0.66, 1, crypto.randomUUID());
  chk('the price above EdgeDesk\'s fair: smart money disagrees', fn('public.radar_tonight()', asSub).cards[0].agrees === false);
  const trSub = fn(`public.radar_trader('${T1}')`, asSub);
  chk('a subscriber sees a trader\'s open positions on upcoming games', trSub.positions_locked === false && Array.isArray(trSub.positions) && trSub.positions.length === 2, trSub.positions);
  chk('everything Radar shows is the same for every subscriber (no reader input but the wallet)', !/auth\.uid\(\)/.test(live.replace(/has_active_sub\(\)[^;]*/g, '')));

  /* the public teaser: the first card's game, count and dollars, never the side, a price or a wallet */
  const tz = fn('public.radar_teaser()', db.anon);
  chk('the teaser for anyone: the first card\'s game, count and dollars (rounded to $100)', tz.status === 'ok' && tz.games === 2 && tz.card && tz.card.n_wallets === 3
    && Number(tz.card.dollars) === 700 && tz.card.home_team === 'Las Vegas Raiders', tz);
  chk('…and never the side, a price, EdgeDesk\'s fair or a wallet', tz.card && ['selection', 'outcome', 'point', 'current_price', 'avg_entry', 'fair', 'agrees', 'wallets', 'condition_id', 'token_id'].every((k) => !(k in tz.card)));

  /* off again: everything shut at once */
  db.service("update public.radar_config set value = 'off', note = 'test' where key = 'POLYMARKET_DATA_ENABLED';");
  chk('off again: every door shuts at once and the grades disappear', fn('public.radar_tonight()', asSub).status === 'disabled' && fn('public.radar_leaderboard(5)', db.anon).status === 'disabled'
    && fn('public.radar_teaser()', db.anon).status === 'disabled'
    && db.anon('select count(*) from public.poly_wallet_grades;') === '0');
  db.service("update public.radar_config set value = 'on', note = 'test' where key = 'POLYMARKET_DATA_ENABLED';");

  /* the market-maker inputs, from the stored trades */
  db.service(trade(MM, C('1'), 0, 'BUY', 10, 0.5, -60) + trade(MM, C('1'), 1, 'BUY', 9, 0.5, -59));
  const st = JSON.parse(db.service(`select coalesce(json_agg(s), '[]') from public.radar_style_stats(${lit(MM)}, now() - interval '1 day') s;`))[0];
  chk('radar_style_stats: one row per covered market, both sides bought', st && st.trades === 2 && Number(st.bought['0']) === 10 && Number(st.bought['1']) === 9 && st.split === false, st);
  chk('…the service role\'s only', fails(() => db.anon(`select public.radar_style_stats(${lit(MM)}, now());`)));

  /* ===================================================================== */
  /* 12. THE RADAR RECORD                                                  */
  /* ===================================================================== */
  chk('(no record before radar_record.sql)', V("select to_regclass('public.radar_cards') is null") === 't');
  out = db.applyFileAtomic(F('radar_record.sql'));
  chk('the record installs; its report says ok', (out.match(/\|ok/g) || []).length === 3 && !/CHECK THIS/.test(out), out);
  chk('applying it twice is harmless', !/CHECK THIS/.test(db.applyFileAtomic(F('radar_record.sql'))));
  chk('no client may publish or grade', fails(() => asSub('select public.radar_publish_cards();')) && fails(() => asSub(`select public.radar_publish_cards('[]'::jsonb);`)) && fails(() => db.anon('select public.radar_grade_cards();')));
  /* H-RADAR-02: a card is published at the order book's best ask (polymarket_sync reads it and hands it in), and only on
     a market whose fee is known to be none: E1's market says fees enabled at a rate of 0 (as the probe saw); E2's fee
     status has not been read yet */
  /* E1's market charges the Sports taker rate (0.05, docs.polymarket.com trading/fees), so its card pays the fee on top of the ask */
  db.service(`update public.poly_markets set fees_enabled = true, fee_schedule = '{"rate": 0.05, "exponent": 1, "taker_only": true}'::jsonb where condition_id = ${lit(C('1'))};`);
  const quote = (c, ask, bid, size, ageMin) => ({ token_id: c + ':0', best_ask: ask, best_bid: bid, ask_size: size, quoted_at: new Date(Date.now() - ageMin * 60000).toISOString() });
  const Q = (qs) => `select public.radar_publish_cards(${lit(JSON.stringify(qs))}::jsonb);`;
  chk('v2: without a quote from the order book nothing is published', db.service('select public.radar_publish_cards();') === '0' && V('select count(*) from public.radar_cards') === '0');
  chk('v2: a quote older than 30 minutes is not a price anyone can take: nothing is published', db.service(Q([quote(C('1'), 0.67, 0.65, 5000, 45)])) === '0');
  const pub1 = Number(db.service(Q([quote(C('1'), 0.67, 0.65, 5000, 1), quote(C('2'), 0.51, 0.49, 800, 1)])));
  chk('v2: E1 is published at its best ask; E2 is not, its market\'s fee unknown (never guessed)', pub1 === 1 && V("select string_agg(event_id, ',') from public.radar_cards") === 'E1');
  db.service(`update public.poly_markets set fees_enabled = false where condition_id = ${lit(C('2'))};`);
  const pub = pub1 + Number(db.service(Q([quote(C('1'), 0.67, 0.65, 5000, 1), quote(C('2'), 0.51, 0.49, 800, 1)])));
  chk('every card on Smart Money Tonight is published once: E1 and E2 (E2 once its market says it charges no fee)', pub === 2 && V("select string_agg(event_id, ',' order by event_id) from public.radar_cards") === 'E1,E2');
  const rc1 = one("select follow_price, ask_price, bid_price, mid_price, ask_size, rules_version, fee_schedule ->> 'rate' as rate, fee_per_share, n_wallets, selection, agrees, jsonb_array_length(wallets) as w from public.radar_cards where event_id = 'E1'");
  chk('…with the side and the price a subscriber could really take then: the best ask 0.67 (bid 0.65, midpoint 0.66), 5,000 shares at it, and the taker fee at it (0.05 x 0.67 x 0.33 = 0.011055 a share)',
    Number(rc1.follow_price) === 0.67 && Number(rc1.ask_price) === 0.67 && Number(rc1.mid_price) === 0.66 && Number(rc1.ask_size) === 5000 && rc1.rules_version === 2 && rc1.rate === '0.05'
    && Number(rc1.fee_per_share) === 0.011055
    && rc1.selection === 'Kansas City Chiefs' && rc1.n_wallets === 3 && rc1.agrees === false && rc1.w === 3, rc1);
  chk('…and no fee on a market that charges none (E2: fees not enabled)', Number(V("select fee_per_share from public.radar_cards where event_id = 'E2'")) === 0);
  chk('v2: a card whose price is not its ask is refused', fails(() => db.service(`insert into public.radar_cards (event_id, condition_id, token_id, market_type, commence_time, n_wallets, follow_price, follow_price_at, rules_version, ask_price, quoted_at)
    values ('EX', ${lit(C('1'))}, 'x', 'moneyline', now() + interval '1 day', 1, 0.66, now(), 2, 0.67, now());`)));
  chk('publishing again adds nothing (one entry per game and side)', db.service(Q([quote(C('1'), 0.60, 0.58, 5000, 1)])) === '0' && V('select count(*) from public.radar_cards') === '2');
  chk('nothing is graded before the start', JSON.parse(db.service('select public.radar_grade_cards();')).graded === 0);
  chk('the record is append-only: a card cannot be edited or removed', fails(() => db.service('update public.radar_cards set follow_price = 0.5;')) && fails(() => db.service('delete from public.radar_cards;'))
    && fails(() => V('truncate public.radar_cards;')));
  chk('a grade before the start is refused', fails(() => db.service(`insert into public.radar_card_results (card_id, result, settle, roi, close_status) select card_id, 'win', 1, 1 / follow_price - 1, 'no_close' from public.radar_cards where event_id = 'E1';`)));
  /* the clock moves on (the test's only device: a card's start is write-once): E1 started an hour ago and the Chiefs won,
     its last price 10 minutes before the start 0.70; E2 started 8 days ago and its market never resolved */
  V(`set session_replication_role = replica;
     update public.radar_cards set commence_time = now() - interval '1 hour', published_at = now() - interval '3 hours', follow_price_at = now() - interval '3 hours', quoted_at = now() - interval '3 hours' where event_id = 'E1';
     update public.radar_cards set commence_time = now() - interval '8 days', published_at = now() - interval '9 days', follow_price_at = now() - interval '9 days', quoted_at = now() - interval '9 days' where event_id = 'E2';
     set session_replication_role = default;`);
  db.service(`update public.poly_markets set settle = '[1,0]'::jsonb, closed = true where condition_id = ${lit(C('1'))};`);
  price(C('1'), 0, 0.70, 70, crypto.randomUUID());
  price(C('1'), 0, 0.99, 30, crypto.randomUUID());   /* in play: never the close */
  chk('a grade that is not settle / follow price - 1 is refused', fails(() => db.service(`insert into public.radar_card_results (card_id, result, settle, roi, close_status) select card_id, 'win', 1, 0.9, 'no_close' from public.radar_cards where event_id = 'E1';`)));
  const gr1 = JSON.parse(db.service('select public.radar_grade_cards();'));
  chk('graded once: E1 against its close and result, E2 void (no resolution in a week)', gr1.graded === 1 && gr1.void === 1, gr1);
  const res1 = one("select r.result, r.settle, r.roi, r.close_status, r.close_price, r.beat_close, r.clv_pct from public.radar_card_results r join public.radar_cards c using (card_id) where c.event_id = 'E1'");
  chk('E1: a win; ROI = 1 / (0.67 + 0.011055) - 1 (at the ask, net of the fee); the close is the last price before the start (0.70), not the in-play one', res1.result === 'win' && Math.abs(Number(res1.roi) - (1 / 0.681055 - 1)) < 1e-6
    && Number(res1.close_price) === 0.7 && res1.beat_close === true && Math.abs(Number(res1.clv_pct) - (0.7 / 0.67 - 1)) < 1e-6, res1);
  chk('E2: void, with no ROI and no close', one("select r.result || ':' || coalesce(r.roi::text, '-') || ':' || r.close_status as x from public.radar_card_results r join public.radar_cards c using (card_id) where c.event_id = 'E2'").x === 'void:-:void');
  chk('grading again changes nothing', JSON.parse(db.service('select public.radar_grade_cards();')).graded === 0 && V('select count(*) from public.radar_card_results') === '2');
  chk('a grade cannot be edited or removed', fails(() => db.service("update public.radar_card_results set result = 'loss';")) && fails(() => db.service('delete from public.radar_card_results;')));
  chk('the record is subscribers only', fn('public.radar_record(10)', db.anon).status === 'subscribers_only' && fn('public.radar_record(10)', asA).status === 'subscribers_only');
  chk('no client reads the record\'s tables directly', fails(() => asSub('select * from public.radar_cards;')) && fails(() => db.anon('select * from public.radar_card_results;')));
  const rec = fn('public.radar_record(10)', asSub);
  chk('the record: 1 graded (1-0), ROI +46.8% (at the ask, net of the fee), beat the close 100%, 1 void', rec.status === 'ok' && rec.totals.graded === 1 && rec.totals.wins === 1 && rec.totals.void === 1
    && Math.abs(Number(rec.totals.roi) - 0.4683) < 1e-4 && Number(rec.totals.beat_close_rate) === 1, rec.totals);
  chk('labelled EXPERIMENTAL and a small sample (under 200 graded); H-RADAR-02\'s record, priced at the best ask', rec.label === 'EXPERIMENTAL' && rec.small_sample === true && rec.min_sample === 200
    && rec.hypothesis === 'H-RADAR-02' && rec.priced_at === 'best_ask' && rec.earlier_cards === 0, rec);
  chk('it carries what H-RADAR-01 found, verbatim from the registry', rec.h_radar_01 && rec.h_radar_01.hypothesis_id === 'H-RADAR-01' && rec.h_radar_01.status === found.status);
  chk('the cards themselves, newest first', rec.recent.length === 2 && rec.recent[0].home_team === 'Las Vegas Raiders' && rec.recent[0].result === 'win');

  /* THE STAGE REPORT (tools/radar/sql/radar_pipeline_report.sql, run by Deploy Prediction Radar): read-only, every stage counted */
  const writes = () => V("select (select count(*) from public.poly_sync_runs) || '/' || (select count(*) from public.radar_cards) || '/' || (select count(*) from public.poly_wallets) || '/' || (select count(*) from public.poly_wallet_grades)");
  const w0 = writes();
  const stageRep = db.applyFileAtomic(path.join(ROOT, 'tools', 'radar', 'sql', 'radar_pipeline_report.sql'));
  const stages = (stageRep.match(/^\d+\|[^|\n]*[a-z][^|\n]*\|\d+\|.*$/gm) || []).map((l) => { const x = l.split('|'); return { n: +x[0], stage: x[1], cnt: +x[2], note: x[3] }; });
  const firstZero = stages.filter((x) => x.n <= 9 && x.cnt === 0).map((x) => x.n)[0];
  const door = fn('public.radar_tonight()', asSub);
  chk('the stage report counts all 11 stages: the cards and the observed cards the subscribers\' door shows, and the record, under H-RADAR-02', stages.length === 11
    && stages.find((x) => x.n === 9).cnt === door.cards.length && stages.find((x) => x.n === 10).cnt === door.observed.length
    && stages.find((x) => x.n === 11).cnt === +V("select count(*) from public.radar_cards where published_at > now() - interval '24 hours'") && /hypothesis\|H-RADAR-02/.test(stageRep),
    { stages, cards: door.cards.length, observed: door.observed.length });
  chk('…marks the first stage of the featured path at zero, and only that one', stages.filter((x) => /first reaches zero/.test(x.note)).map((x) => x.n).join() === (firstZero == null ? '' : String(firstZero)), stages);
  chk('…and writes nothing', writes() === w0, { before: w0, after: writes() });

  /* ===================================================================== */
  /* 10. THE SCHEDULE                                                      */
  /* ===================================================================== */
  V(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.calls (url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, body, headers); select 1::bigint $$;`);
  out = db.applyFile(F('polymarket_sync_cron.sql'));
  chk('cron: four jobs; the report flags the missing secret', /1 tonight runs every 10 minutes\|ok/.test(out) && /4 the grade runs daily at 10:17 UTC\|ok/.test(out) && /CHECK THIS: select vault\.create_secret/.test(out), out);
  chk('cron: tonight every 10 minutes, the pool at 06:07, wallets every 5 minutes through the night, the grade at 10:17',
    V("select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job") === 'polymarket_sync_grade=17 10 * * *,polymarket_sync_pool=7 6 * * *,polymarket_sync_tonight=*/10 * * * *,polymarket_sync_wallets=10-55/5 6-9 * * *');
  let pk = JSON.parse(V("select public.radar_poke('tonight');"));
  chk('cron: without the secret the poke sends nothing and records a failed run and a FAILURE alert', pk.queued === false && V('select count(*) from net.calls') === '0'
    && V("select status from public.poly_sync_runs order by finished_at desc limit 1") === 'error' && V('select code from public.poly_alerts order by id desc limit 1') === 'no_cron_secret', pk);
  V("insert into vault.decrypted_secrets values ('polymarket_sync_cron_secret', 's3cret');");
  pk = JSON.parse(V("select public.radar_poke('wallets');"));
  chk('cron: with the secret, the poke queues the mode with the x-cron-secret header', pk.queued === true
    && V("select headers ->> 'x-cron-secret' || ':' || (body ->> 'mode') || ':' || (body ->> 'source') from net.calls limit 1") === 's3cret:wallets:supabase_cron' && /\/functions\/v1\/polymarket_sync$/.test(V('select url from net.calls limit 1')));
  chk('cron: an unknown mode is refused', fails(() => V("select public.radar_poke('everything');")));
  chk('cron: no client may call the poke', fails(() => db.anon("select public.radar_poke('tonight');")) && fails(() => asSub("select public.radar_poke('tonight');")) && fails(() => db.service("select public.radar_poke('tonight');")));
  out = db.applyFile(F('polymarket_sync_cron.sql'));
  chk('cron: applying it twice keeps one job each, and every row is ok', V("select count(*) from cron.job where jobname like 'polymarket_sync_%'") === '4' && !/CHECK THIS/.test(out), out);
} catch (e) {
  chk('the suite ran to the end', false, String(e && e.message || e).slice(0, 1200));
} finally {
  db.stop();
}
process.exit(T.done());
