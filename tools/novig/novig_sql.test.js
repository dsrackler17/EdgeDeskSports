#!/usr/bin/env node
/* ===========================================================================
   supabase/novig_market_data.sql, novig_market_data_cron.sql and
   novig_market_data_rollback.sql, applied to a throwaway PostgreSQL with
   Supabase's roles (tools/personal/_pg.js), production's public.signals and
   the Sharp-lag DraftKings tape (public.sharp_price_snapshots, service-role
   only, as sharp_lag.sql makes it).

     static      the migration copies are the same files; no psql
                 meta-command; no client write grant; the cron file holds no
                 key; no private key material anywhere in the layer
     guard       without the DraftKings tape the layer names sharp_lag.sql
     apply       the report is all ok, twice (idempotent); the first config
                 values are logged once
     access      anon reads nothing; a subscriber reads nothing while
                 public_display is off; the operator reads; with it on, a
                 subscriber reads and a non-subscriber still does not; a paper
                 row is never served; the DraftKings tape stays service-only
     compare     one row per linked outcome: Novig's snapshot, top, fills and
                 depth; DraftKings' price for the same side and line; each
                 venue's state (Recent / Stale / Awaiting / Suspended / No
                 liquidity) from novig_rule(); the pair gap
     integrity   snapshots, runs, alerts and the config log refuse update and
                 delete (the service role and the owner too); a link takes one
                 invalidation and nothing else; depth is deleted only by
                 novig_prune(), which keeps each market's close; the same book
                 seq is stored once
     queue       the unmapped recorder counts again, resolves what linked and
                 what no longer applies
     research    the history carries both venues at their own times; the gap
                 summary pairs only simultaneous pregame observations,
                 counts the rest as exclusions, ties under 0.10 pp
     readiness   one row; never run is an error that says why; a halt shows
     config      every change logged with who; bad values and deletes refused
     cron        four jobs; the poke without its secret records a failure; with
                 it, the mode is posted with x-cron-secret; no client may call it
     deploy      tools/novig/deploy_check.js as deploy-novig.yml runs it on
                 production, where the log is public: tables, RLS, policies,
                 grants, every declared index, display off, production served,
                 the jobs, Vault, a halt reported; a reader who is not an
                 admin sees nothing, the admin is the operator; no price in
                 its output; it fails when display is on or anon is granted a
                 table; it writes nothing. The admin's view is sealed (RSA-OAEP
                 + AES-GCM) and opens only with the private key
     rollback    removes the layer and its jobs; the tape is untouched

   Run: node tools/novig/novig_sql.test.js     (NOVIG_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('Novig market data');
const ROOT = PG.ROOT;
const F = (n) => path.join(ROOT, 'supabase', n);
const LAYER = fs.readFileSync(F('novig_market_data.sql'), 'utf8');
const CRON = fs.readFileSync(F('novig_market_data_cron.sql'), 'utf8');
const FILES = ['novig_market_data.sql', 'novig_market_data_cron.sql', 'novig_market_data_rollback.sql'];

T.chk('static: the layer never grants a client write', !/grant\s+(insert|update|delete|all)[^;]*to\s+(anon|authenticated)/i.test(LAYER));
T.chk('static: the migration copies are the same files', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261030120000_novig_market_data.sql'), 'utf8') === LAYER
  && fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261030120100_novig_market_data_cron.sql'), 'utf8') === CRON);
T.chk('static: no psql meta-command in any file', FILES.every((n) => !/^\s*\\/m.test(fs.readFileSync(F(n), 'utf8'))));
T.chk('static: the cron file never writes the service-role key into a job', !/service_role_key|Bearer\s/i.test(CRON));
T.chk('static: no key material, signature or Novig secret name is stored by the layer', FILES.every((n) => !/BEGIN [A-Z ]*KEY|NOVIG_MANAGEMENT|NOVIG_READ_PRIVATE|private_key/i.test(fs.readFileSync(F(n), 'utf8'))));

const db = PG.start('novig');
if (db.skip) {
  if (process.env.NOVIG_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const lit = PG.lit;
const fails = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const OP = '00000000-0000-0000-0000-0000000000a1', SUB = '00000000-0000-0000-0000-0000000000aa', NOSUB = '00000000-0000-0000-0000-0000000000bb';
const rows = (q, who) => J((who || db.sql)(`select coalesce(jsonb_agg(x), '[]'::jsonb) from (${q}) x;`));
const cmp = (who, args) => J((who || db.sql)(`select coalesce(jsonb_agg(c), '[]'::jsonb) from public.novig_compare(${args || ''}) c;`));
try {
  /* ---- production's capture table, roles and the tape ---- */
  db.sql(`create table public.signals (id bigserial primary key, sig_key text unique not null, event_id text, sport_key text, commence_time timestamptz,
      home_team text, away_team text, market text, selection text, point numeric);
    create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() in (${lit(SUB)}::uuid, ${lit(OP)}::uuid) $$;
    create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select auth.uid() = ${lit(OP)}::uuid $$;`);
  let err = null; try { db.applyFile(F('novig_market_data.sql')); } catch (e) { err = String(e.message); }
  T.chk('guard: without the DraftKings tape the layer names sharp_lag.sql and installs nothing', /sharp_lag\.sql/.test(err || '') && db.sql("select to_regclass('public.novig_markets') is null") === 't', err);
  db.sql(`create table public.sharp_price_snapshots (id bigint generated always as identity primary key, captured_at timestamptz not null, source text not null default 'odds_api',
      source_request_id bigint not null default 1, source_category text not null default 'featured', odds_format text, sport_key text not null, event_id text not null, home_team text, away_team text,
      commence_time timestamptz, book text not null, book_last_update timestamptz, market text not null, side text not null, participant text, point numeric, price_dec numeric not null check (price_dec > 1),
      ingested_at timestamptz not null default now());
    alter table public.sharp_price_snapshots enable row level security; revoke all on public.sharp_price_snapshots from anon, authenticated;
    grant select, insert on public.sharp_price_snapshots to service_role;`);

  let out = db.applyFile(F('novig_market_data.sql'));
  T.chk('apply: every report row is ok', !/CHECK THIS/.test(out) && (out.match(/\|ok/g) || []).length === 7, out);
  out = db.applyFile(F('novig_market_data.sql'));
  T.chk('apply: twice is harmless; the first config values were logged once each', !/CHECK THIS/.test(out) && db.sql('select count(*) from public.novig_config_log') === '2', out.slice(0, 300));

  /* ---- the world ----
       E1 BAL @ BUF kicks off in 3 hours, linked: moneyline and BUF −3.5 (production)
       E2 KC @ DEN kicked off 10 days ago (its close is history, older than the depth retention)
       E3 a paper event, linked: never served */
  db.service(`insert into public.novig_events (event_id, environment, league, sport, description, status, starts_at, home_competitor_id, away_competitor_id, home_name, away_name) values
      ('nv-e1', 'production', 'NFL', 'FOOTBALL', 'Baltimore Ravens @ Buffalo Bills', 'OPEN_PREGAME', now() + interval '3 hours', 'c-buf', 'c-bal', 'Buffalo Bills', 'Baltimore Ravens'),
      ('nv-e2', 'production', 'NFL', 'FOOTBALL', 'Kansas City Chiefs @ Denver Broncos', 'FINAL', now() - interval '10 days', 'c-den', 'c-kc', 'Denver Broncos', 'Kansas City Chiefs'),
      ('nv-e3', 'paper', 'NFL', 'FOOTBALL', 'Paper @ Game', 'OPEN_PREGAME', now() + interval '3 hours', 'a', 'b', 'Buffalo Bills', 'Baltimore Ravens');
    insert into public.novig_markets (market_id, environment, event_id, market_type, strike, status, voids, fee_coefficient, fee_maker_credit, fee_charged, outcomes) values
      ('nv-m1', 'production', 'nv-e1', 'MONEY', '0', 'OPEN', 'FMV', '0.06', '0.25', 'WHEN_LIVE', '[{"outcomeId":"o-buf","name":"BUF"},{"outcomeId":"o-bal","name":"BAL"}]'),
      ('nv-m2', 'production', 'nv-e1', 'SPREAD', '-3.5', 'OPEN', 'FMV', '0.06', '0.25', 'WHEN_LIVE', '[{"outcomeId":"s-buf","name":"BUF -3.5"},{"outcomeId":"s-bal","name":"BAL +3.5"}]'),
      ('nv-m3', 'production', 'nv-e2', 'MONEY', '0', 'CLOSED', 'FMV', '0.06', '0.25', 'WHEN_LIVE', '[{"outcomeId":"k-den","name":"DEN"},{"outcomeId":"k-kc","name":"KC"}]'),
      ('nv-m4', 'paper', 'nv-e3', 'MONEY', '0', 'OPEN', 'FMV', '0.06', '0.25', 'WHEN_LIVE', '[{"outcomeId":"p-buf","name":"BUF"},{"outcomeId":"p-bal","name":"BAL"}]');`);
  const link = (m, env, ev, odds, bm, ln, outs, kick, conf) => db.service(`insert into public.novig_market_links (market_id, environment, novig_event_id, novig_market_type, league, sport, odds_event_id, odds_sport_key,
      book_market, period, line, outcomes, home_team, away_team, kickoff_at, match_confidence, match_method, linker_version)
    values (${lit(m)}, ${lit(env)}, ${lit(ev)}, 'X', 'NFL', 'nfl', ${lit(odds)}, 'americanfootball_nfl', ${lit(bm)}, 'game', ${ln == null ? 'null' : ln}, ${lit(JSON.stringify(outs))}::jsonb,
      ${lit(ev === 'nv-e2' ? 'Denver Broncos' : 'Buffalo Bills')}, ${lit(ev === 'nv-e2' ? 'Kansas City Chiefs' : 'Baltimore Ravens')}, ${kick}, ${lit(conf || 'high')}, 'test', 'test');`);
  link('nv-m1', 'production', 'nv-e1', 'odds-1', 'h2h', null, [{ outcome_id: 'o-buf', side: 'Buffalo Bills', point: null }, { outcome_id: 'o-bal', side: 'Baltimore Ravens', point: null }], "now() + interval '3 hours'", 'medium');
  link('nv-m2', 'production', 'nv-e1', 'odds-1', 'spreads', -3.5, [{ outcome_id: 's-buf', side: 'Buffalo Bills', point: '-3.5' }, { outcome_id: 's-bal', side: 'Baltimore Ravens', point: '3.5' }], "now() + interval '3 hours'");
  link('nv-m3', 'production', 'nv-e2', 'odds-2', 'h2h', null, [{ outcome_id: 'k-den', side: 'Denver Broncos', point: null }, { outcome_id: 'k-kc', side: 'Kansas City Chiefs', point: null }], "now() - interval '10 days'");
  link('nv-m4', 'paper', 'nv-e3', 'odds-1', 'h2h', null, [{ outcome_id: 'p-buf', side: 'Buffalo Bills', point: null }, { outcome_id: 'p-bal', side: 'Baltimore Ravens', point: null }], "now() + interval '3 hours'");
  const exec100 = (st, n, tot, pay, un) => ({ 100: [st, n, tot, pay, un, '0.625000'] });
  const snap = (m, env, at, seq, top, ex, depth) => {
    const id = db.service(`insert into public.novig_book_snapshots (environment, market_id, captured_at, source, book_seq, event_status, market_status, fee_charged_now, top, exec, levels)
      values (${lit(env)}, ${lit(m)}, ${at}, 'rest_book', ${seq}, 'OPEN_PREGAME', 'OPEN', false, ${lit(JSON.stringify(top))}::jsonb, ${lit(JSON.stringify(ex || {}))}::jsonb, 10) returning id;`).split('\n').pop();
    if (depth) db.service(`insert into public.novig_book_depth (snapshot_id, market_id, captured_at, depth) values (${id}, ${lit(m)}, ${at}, ${lit(JSON.stringify(depth))}::jsonb);`);
    return id;
  };
  /* moneyline: three books over the last hour; the latest 2 minutes old */
  snap('nv-m1', 'production', "now() - interval '62 minutes'", 4100, { 'o-buf': { bid: '0.615', bid_qty: 100, ask: '0.630', ask_qty: 900000 }, 'o-bal': { bid: '0.370', bid_qty: 900000, ask: '0.385', ask_qty: 100 } }, { 'o-buf': exec100('FILLED', 15873, '99.99990', '158.73000', '0.00010') });
  snap('nv-m1', 'production', "now() - interval '31 minutes'", 4180, { 'o-buf': { bid: '0.620', bid_qty: 3282, ask: '0.625', ask_qty: 995607 }, 'o-bal': { bid: '0.375', bid_qty: 995607, ask: '0.380', ask_qty: 3282 } }, { 'o-buf': exec100('FILLED', 16000, '100.00000', '160.00000', '0.00000') });
  const latest = snap('nv-m1', 'production', "now() - interval '2 minutes'", 4233, { 'o-buf': { bid: '0.620', bid_qty: 3282, ask: '0.625', ask_qty: 995607 }, 'o-bal': { bid: '0.375', bid_qty: 480391, ask: '0.380', ask_qty: 3282 } },
    { 'o-buf': exec100('FILLED', 16000, '100.00000', '160.00000', '0.00000'), 'o-bal': exec100('FILLED', 26016, '99.99750', '260.16000', '0.00250') }, { 'o-buf': [['0.62', 3282, [3282]]], 'o-bal': [['0.375', 480391, [480391]]] });
  /* the spread: one stale snapshot (40 minutes), BUF side one-sided */
  snap('nv-m2', 'production', "now() - interval '40 minutes'", 3265, { 's-buf': { bid: '0.460', bid_qty: 661109, ask: null, ask_qty: null }, 's-bal': { bid: '0.530', bid_qty: 110207, ask: '0.540', ask_qty: 1097555 } });
  /* KC @ DEN: its close 10 minutes before kickoff, and two older books */
  snap('nv-m3', 'production', "now() - interval '10 days 10 minutes'", 900, { 'k-den': { bid: '0.540', bid_qty: 5000, ask: '0.550', ask_qty: 5000 }, 'k-kc': { bid: '0.450', bid_qty: 5000, ask: '0.460', ask_qty: 5000 } }, {}, { 'k-den': [['0.54', 5000, [5000]]] });
  snap('nv-m3', 'production', "now() - interval '12 days'", 800, { 'k-den': { bid: '0.500', bid_qty: 10, ask: '0.520', ask_qty: 10 } }, {}, { 'k-den': [['0.50', 10, [10]]] });
  snap('nv-m3', 'production', "now() - interval '11 days'", 850, { 'k-den': { bid: '0.510', bid_qty: 10, ask: '0.530', ask_qty: 10 } }, {}, { 'k-den': [['0.51', 10, [10]]] });
  snap('nv-m4', 'paper', "now() - interval '1 minute'", 1, { 'p-buf': { bid: '0.010', bid_qty: 1, ask: '0.990', ask_qty: 1 } });
  /* the DraftKings tape (and a Pinnacle row the layer must not read) */
  db.sql(`insert into public.sharp_price_snapshots (captured_at, sport_key, event_id, book, book_last_update, market, side, point, price_dec) values
      (now() - interval '65 minutes', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '66 minutes', 'h2h', 'Buffalo Bills', null, 1.625),
      (now() - interval '6 minutes', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '7 minutes', 'h2h', 'Buffalo Bills', null, 1.606),
      (now() - interval '6 minutes', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '7 minutes', 'h2h', 'Baltimore Ravens', null, 2.45),
      (now() - interval '6 minutes', 'americanfootball_nfl', 'odds-1', 'pinnacle', now() - interval '7 minutes', 'h2h', 'Buffalo Bills', null, 1.65),
      (now() - interval '3 hours', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '3 hours', 'spreads', 'Buffalo Bills', -3.5, 1.909),
      (now() - interval '3 hours', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '3 hours', 'spreads', 'Buffalo Bills', -4.5, 2.10),
      (now() - interval '10 days 12 minutes', 'americanfootball_nfl', 'odds-2', 'draftkings', now() - interval '10 days 12 minutes', 'h2h', 'Denver Broncos', null, 1.80);`);

  /* ---- access ---- */
  T.chk('access: anon reads no Novig table and cannot call the comparison', fails(() => db.anon('select count(*) from public.novig_book_snapshots;')) && fails(() => db.anon('select * from public.novig_compare();')));
  T.chk('access: the DraftKings tape stays service-only (a subscriber reads none of it directly)', fails(() => db.as(SUB, 'select count(*) from public.sharp_price_snapshots;')) || db.as(SUB, 'select count(*) from public.sharp_price_snapshots;') === '0');
  T.chk('access: while public_display is off, a SUBSCRIBER reads nothing (tables and comparison)', db.as(SUB, 'select count(*) from public.novig_book_snapshots;') === '0' && cmp((q) => db.as(SUB, q)).length === 0
    && J(db.as(SUB, 'select public.novig_access();')).access === 'none' && J(db.as(SUB, 'select public.novig_price_gap_summary();')).access === 'none');
  const opRows = cmp((q) => db.as(OP, q));
  T.chk('access: the operator reads the comparison (4 linked production outcomes in the window, never the paper one)', opRows.length === 4 && opRows.every((r) => r.novig.environment === 'production') && J(db.as(OP, 'select public.novig_access();')).access === 'operator', opRows.length);
  T.chk('access: helpers the functions use are not callable by a client', fails(() => db.as(OP, "select * from public.novig_dk_price('odds-1','h2h','Buffalo Bills',null,now());")) && fails(() => db.as(SUB, 'select public.novig_prune();')));

  /* ---- the comparison ---- */
  const r = (side, bm) => opRows.find((x) => x.side === side && x.book_market === (bm || 'h2h') && x.odds_event_id === 'odds-1');
  const buf = r('Buffalo Bills');
  T.chk('compare: Novig\'s latest snapshot (seq 4233, 2 min old) is Recently updated, with its top, fills and depth', buf.novig.book_seq === 4233 && buf.novig.state === 'RECENT' && buf.novig.top.ask === '0.625'
    && buf.novig.exec['100'][0] === 'FILLED' && buf.novig.depth['o-buf'][0][0] === '0.62' && buf.novig.outcome_ids.length === 2 && buf.novig.fee.charged === 'WHEN_LIVE', buf.novig);
  T.chk('compare: DraftKings\' latest price for the SAME side (1.606, 6 min old, not Pinnacle\'s 1.65) is Live, with its own book time', Number(buf.draftkings.price_dec) === 1.606 && buf.draftkings.state === 'LIVE' && buf.draftkings.book_last_update && Number(buf.pair_gap_minutes) >= 3.9 && Number(buf.pair_gap_minutes) <= 4.1, buf.draftkings);
  T.chk('compare: the link\'s confidence and settlement notes travel with every row', buf.match_confidence === 'medium' && Array.isArray(buf.settlement_notes));
  const sbuf = r('Buffalo Bills', 'spreads'), sbal = r('Baltimore Ravens', 'spreads');
  T.chk('compare: a 40-minute-old Novig snapshot is Stale; DraftKings at −3.5 (3 h old) is Stale, its −4.5 is never used', sbuf.novig.state === 'STALE' && sbuf.draftkings.state === 'STALE' && Number(sbuf.draftkings.price_dec) === 1.909, sbuf);
  T.chk('compare: Baltimore +3.5 has no DraftKings row at +3.5: Awaiting, nothing filled in', sbal.draftkings.state === 'AWAITING' && sbal.draftkings.price_dec === null);
  T.chk('compare: the default window leaves out games over a day old', !opRows.some((x) => x.odds_event_id === 'odds-2'));
  const old = cmp((q) => db.as(OP, q), "null, now() - interval '11 days', now()");
  T.chk('compare: a closed market (KC @ DEN) is Suspended', old.filter((x) => x.odds_event_id === 'odds-2').every((x) => x.novig.state === 'SUSPENDED'));
  db.service(`insert into public.novig_book_snapshots (environment, market_id, captured_at, source, book_seq, top, exec) values ('production', 'nv-m2', now() - interval '1 minute', 'rest_book', 3300,
     '{"s-buf": {"bid": "0.46", "bid_qty": 10, "ask": null, "ask_qty": null}, "s-bal": {"bid": null, "bid_qty": null, "ask": "0.54", "ask_qty": 10}}', '{}');`);
  T.chk('compare: a fresh snapshot with nothing on the other side is No liquidity for that side only', (() => { const x = cmp((q) => db.as(OP, q)); return x.find((y) => y.side === 'Buffalo Bills' && y.book_market === 'spreads').novig.state === 'NO_LIQUIDITY'
    && x.find((y) => y.side === 'Baltimore Ravens' && y.book_market === 'spreads').novig.state === 'RECENT'; })());

  db.service(`update public.novig_markets set last_book_seq = 3300, book_confirmed_at = now() where market_id = 'nv-m2';`);
  T.chk('compare: a book read again unchanged (same seq) is confirmed current: observed now, snapshot time kept', (() => { const x = cmp((q) => db.as(OP, q)).find((y) => y.side === 'Baltimore Ravens' && y.book_market === 'spreads');
    return x.novig.state === 'RECENT' && Date.parse(x.novig.observed_at) > Date.parse(x.novig.snapshot_at); })());
  db.service(`update public.novig_markets set last_book_seq = 9999, book_confirmed_at = now() + interval '1 minute' where market_id = 'nv-m1';`);
  T.chk('compare: a confirmation of a DIFFERENT seq never refreshes an older snapshot', (() => { const x = cmp((q) => db.as(OP, q)).find((y) => y.side === 'Buffalo Bills' && y.book_market === 'h2h');
    return x.novig.observed_at === x.novig.snapshot_at; })());

  /* ---- public display ---- */
  db.sql(`update public.novig_config set value = 'on', note = 'test: permission reference XYZ' where key = 'public_display';`);
  T.chk('display on: a subscriber now reads the comparison; a non-subscriber and anon still do not', cmp((q) => db.as(SUB, q)).length === 4 && cmp((q) => db.as(NOSUB, q)).length === 0
    && fails(() => db.anon('select * from public.novig_compare();')) && J(db.as(SUB, 'select public.novig_access();')).access === 'subscriber');
  db.service("insert into public.novig_sync_runs (mode, status, started_at, trigger) values ('discover', 'ok', now() - interval '1 hour', 'test');");
  T.chk('display on: the subscriber never sees the operator\'s runs, alerts, queue or config; the operator does', db.as(SUB, 'select count(*) from public.novig_sync_runs;') === '0'
    && db.as(SUB, 'select count(*) from public.novig_config;') === '0' && db.as(OP, 'select count(*) from public.novig_sync_runs;') === '1');
  T.chk('config: the switch is logged with old, new, note and who', (() => { const l = rows("select key, old_value, new_value, note, changed_by from public.novig_config_log where key = 'public_display' order by id desc limit 1")[0]; return l.old_value === 'off' && l.new_value === 'on' && /XYZ/.test(l.note) && l.changed_by === 'postgres'; })());
  T.chk('config: a bad value and a delete are refused', fails(() => db.sql("update public.novig_config set value = 'yes' where key = 'public_display';")) && fails(() => db.sql("delete from public.novig_config where key = 'public_display';")));
  db.sql(`update public.novig_config set value = 'off', note = 'test: back off' where key = 'public_display';`);
  T.chk('display off again: the subscriber reads nothing', cmp((q) => db.as(SUB, q)).length === 0);

  /* ---- integrity ---- */
  T.chk('append-only: a snapshot refuses update and delete, even for the owner', fails(() => db.sql(`update public.novig_book_snapshots set book_seq = 1 where id = ${latest};`)) && fails(() => db.sql(`delete from public.novig_book_snapshots where id = ${latest};`))
    && fails(() => db.service(`delete from public.novig_book_snapshots where id = ${latest};`)) && fails(() => db.sql('truncate public.novig_book_snapshots cascade;')));
  T.chk('dedupe: the same book (market, source, seq) is stored once', fails(() => db.service(`insert into public.novig_book_snapshots (environment, market_id, captured_at, source, book_seq) values ('production', 'nv-m1', now(), 'rest_book', 4233);`))
    && db.service(`insert into public.novig_book_snapshots (environment, market_id, captured_at, source, book_seq) values ('production', 'nv-m1', now(), 'rest_book', 4233) on conflict do nothing returning id;`) === '');
  T.chk('links: one invalidation is allowed, with its reason, once; nothing else changes', !fails(() => db.service("update public.novig_market_links set invalidated_at = now(), invalidated_reason = 'teams changed' where market_id = 'nv-m4';"))
    && fails(() => db.service("update public.novig_market_links set invalidated_reason = 'again' where market_id = 'nv-m4';"))
    && fails(() => db.service("update public.novig_market_links set line = -4.5 where market_id = 'nv-m2';")) && fails(() => db.service("delete from public.novig_market_links where market_id = 'nv-m2';"))
    && fails(() => db.service("update public.novig_market_links set invalidated_at = now() where market_id = 'nv-m2';")));
  T.chk('depth: a direct delete is refused', fails(() => db.service('delete from public.novig_book_depth;')) && fails(() => db.sql('update public.novig_book_depth set depth = \'{}\';')));
  const pr = J(db.sql('select public.novig_prune();'));
  T.chk('prune: depth older than 7 days goes (the 11- and 12-day books), the 10-day-old close (last book before kickoff) stays, recent depth stays', pr.depth_rows_pruned === 2
    && db.sql("select count(*) from public.novig_book_depth where market_id = 'nv-m3'") === '1' && db.sql("select captured_at < now() - interval '10 days' from public.novig_book_depth where market_id = 'nv-m3'") === 't'
    && db.sql("select count(*) from public.novig_book_depth where market_id = 'nv-m1'") === '1'
    && db.sql("select count(*) from public.novig_book_snapshots where market_id = 'nv-m3'") === '3', pr);
  T.chk('runs, alerts and the config log are append-only', (() => {
    db.service("insert into public.novig_sync_runs (mode, status, started_at, trigger) values ('probe', 'ok', now(), 'test');");
    return fails(() => db.service("update public.novig_sync_runs set status = 'error';")) && fails(() => db.sql('delete from public.novig_config_log;'));
  })());

  /* ---- the unmapped queue ---- */
  const q1 = J(db.service(`select public.novig_record_unmapped('production', '[{"novig_event_id":"nv-e9","market_id":"m9","reason":"no_book_event","starts_at":"2030-01-01T00:00:00Z"},{"novig_event_id":"nv-e9","market_id":"m10","reason":"spread_orientation_mismatch"}]', '{}', '{nv-e9}');`));
  const q2 = J(db.service(`select public.novig_record_unmapped('production', '[{"novig_event_id":"nv-e9","market_id":"m9","reason":"no_book_event"}]', '{}', '{nv-e9}');`));
  T.chk('queue: a second sighting counts again; a reason that no longer applies to a scanned event is resolved', q1.recorded === 2 && q2.resolved === 1
    && db.sql("select seen_count from public.novig_unmapped where market_id = 'm9'") === '2' && db.sql("select resolved_at is not null from public.novig_unmapped where market_id = 'm10'") === 't');
  J(db.service(`select public.novig_record_unmapped('production', '[]', '{m9}', '{}');`));
  T.chk('queue: a market that has since linked is resolved', db.sql("select resolved_at is not null from public.novig_unmapped where market_id = 'm9'") === 't');

  /* ---- research ---- */
  const hist = J(db.as(OP, "select jsonb_agg(h) from public.novig_history('odds-1') h;"));
  T.chk('history: Novig snapshots and DraftKings rows for the linked markets, each at its own time; Pinnacle never', hist.filter((h) => h.venue === 'novig').length >= 8 && hist.filter((h) => h.venue === 'draftkings').length === 4
    && !hist.some((h) => Number(h.price_dec) === 1.65) && !hist.some((h) => h.venue === 'draftkings' && Number(h.point) === -4.5) && hist.every((h) => h.at));
  T.chk('history: none for a non-subscriber', db.as(NOSUB, "select count(*) from public.novig_history('odds-1');") === '0');
  const gs = J(db.as(OP, 'select public.novig_price_gap_summary();'));
  const nfl = gs.groups.find((g) => g.sport === 'nfl' && g.book_market === 'h2h');
  T.chk('research: only simultaneous pregame pairs count (4: BUF at −62 and −2 min, BAL at −2, DEN\'s close); the other 12 outcome-snapshots are exclusions', nfl && nfl.pairs === 4
    && gs.coverage.pairs_simultaneous === 4 && gs.coverage.excluded_no_simultaneous_dk === 12, gs);
  T.chk('research: DraftKings better twice (BUF 0.630 vs 1.625: −1.46 pp; 0.625 vs 1.606: −0.23 pp), Novig better twice (BAL 0.380 vs 2.45: +2.82 pp; DEN 0.550 vs 1.80: +0.56 pp)',
    nfl && nfl.dk_better === 2 && nfl.novig_better === 2 && nfl.ties === 0 && Math.abs(nfl.median_gap_pp - ((1 / 1.606 - 0.625) * 100 + (1 / 1.80 - 0.55) * 100) / 2) < 1e-9, nfl);
  T.chk('research: the $100 payout difference is Novig\'s fill (payout + unspent) − 100 × DraftKings\' decimal; median of −3.7699, −0.60, +15.1625 is −0.60', nfl && Math.abs(Number(nfl.median_payout_diff_100) + 0.6) < 1e-9 && nfl.partial_100 === 0, nfl);
  T.chk('research: the definition is stated and says a better price is not a positive-EV bet', /not a positive-EV bet/.test(gs.definition) && gs.rules.tie_pp === 0.10);

  /* ---- readiness ---- */
  const rd = rows('select * from public.novig_readiness', (q) => db.as(OP, q))[0];
  T.chk('readiness: one row; no snapshot run yet is an error that says so; public display shown', rd && rd.state === 'error' && /no snapshot run yet|never run/.test(rd.state_reason) && rd.public_display === 'off', rd);
  db.service("insert into public.novig_sync_runs (mode, status, started_at, trigger, halt_until, halt_reason) values ('snapshot', 'error', now(), 'test', now() + interval '1 hour', '451 GEOLOCATION_OUT_OF_BOUNDARY');");
  const rd2 = rows('select * from public.novig_readiness', (q) => db.as(OP, q))[0];
  T.chk('readiness: a halt (a 451) shows until when and why', rd2.state === 'error' && /halted until/.test(rd2.state_reason) && /451/.test(rd2.halt_reason));
  T.chk('readiness: the snapshot and depth sizes are measured (growth control)', Number(rd2.snapshots_bytes) > 0 && Number(rd2.depth_bytes) > 0);

  /* ---- cron ---- */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.calls (url text, body jsonb, headers jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ insert into net.calls values (url, body, headers); select 1::bigint $$;`);
  out = db.applyFile(F('novig_market_data_cron.sql'));
  T.chk('cron: four jobs scheduled; the report flags the missing secret', /2 the hourly discover is scheduled\|ok/.test(out) && /3 the 5-minute snapshot is scheduled\|ok/.test(out) && /CHECK THIS: select vault\.create_secret/.test(out), out);
  T.chk('cron: probe daily, discover hourly, snapshot every 5 minutes, prune daily', db.sql("select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job") === 'novig_prune=41 4 * * *,novig_sync_discover=7 * * * *,novig_sync_probe=23 10 * * *,novig_sync_snapshot=*/5 * * * *');
  let pk = J(db.sql("select public.novig_poke('snapshot');"));
  T.chk('cron: without its secret the poke sends nothing and records a FAILURE run', pk.queued === false && db.sql("select code from public.novig_alerts order by id desc limit 1") === 'no_cron_secret' && db.sql('select count(*) from net.calls') === '0');
  db.sql("insert into vault.decrypted_secrets values ('novig_cron_secret', 's3cret');");
  pk = J(db.sql("select public.novig_poke('discover');"));
  T.chk('cron: with the secret, the mode is posted with x-cron-secret to novig_sync', pk.queued === true && db.sql("select headers ->> 'x-cron-secret' || ':' || (body ->> 'mode') from net.calls limit 1") === 's3cret:discover' && /\/functions\/v1\/novig_sync$/.test(db.sql('select url from net.calls limit 1')));
  T.chk('cron: an unknown mode is refused; no client may call the poke', fails(() => db.sql("select public.novig_poke('trade');")) && fails(() => db.anon("select public.novig_poke('snapshot');")) && fails(() => db.as(OP, "select public.novig_poke('snapshot');")) && fails(() => db.service("select public.novig_poke('snapshot');")));
  out = db.applyFile(F('novig_market_data_cron.sql'));
  T.chk('cron: applying it twice keeps one job each', db.sql("select count(*) from cron.job where jobname like 'novig_%'") === '4' && !/CHECK THIS/.test(out), out);

  /* ---- the deploy check (tools/novig/deploy_check.js), as deploy-novig.yml runs it on production: a PUBLIC log ---- */
  const DC = require(path.join(__dirname, 'deploy_check.js'));
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-novig.yml'), 'utf8');
  const step = WF.slice(WF.indexOf('- name: Verify the layer in production'));
  T.chk('deploy-novig.yml: the admin\'s view goes from psql straight into seal, and nothing else in the step prints it; a CHECK THIS row fails the job',
    /deploy_check\.js view --admin "\$ADMIN" \| psql [^\n]*\| node tools\/novig\/deploy_check\.js seal "\$REPORT_KEY"\n/.test(step) && (step.match(/deploy_check\.js view/g) || []).length === 1
      && /set -euo pipefail/.test(step) && /grep -q '\|CHECK THIS'; then [^\n]*exit 1; fi/.test(step), step.slice(0, 400));
  const report = (sql) => Object.fromEntries(db.sql(sql).split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => { const p = l.split('|'); return [p[0], p.slice(2).join('|')]; }));
  const snapsBefore = db.sql('select count(*) from public.novig_book_snapshots');
  let R = report(DC.checkSql(OP));
  const okRows = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '20', '22', '23'];
  T.chk('deploy check: tables, RLS, policies, grants, readers, every declared index, display off, production served, the four jobs, Vault — and the reader who is not an admin sees nothing while the admin is the operator — all ok',
    okRows.every((n) => /^ok\b/.test(R[n] || '')) && DC.INDEXES.length === 14, okRows.filter((n) => !/^ok\b/.test(R[n] || '')).map((n) => n + ': ' + R[n]));
  T.chk('deploy check: rows by environment, and the admin\'s compare rows counted from production only (BAL @ BUF\'s two markets, both sides; KC @ DEN is outside the window; the paper link was invalidated above) — counts, never a price',
    R['23'] === 'ok (4 rows, 1 events)' && R['12'] === 'production 2 · 3 · 3 · 8 | paper 1 · 1 · 0 · 1' && !/(^|[^\d:.])0\.\d{3}|"(bid|ask)"/.test(Object.values(R).join('\n')), [R['12'], R['23']]);
  T.chk('deploy check: a halt in force is reported, not hidden', /^CHECK THIS: halted until .*451/.test(R['17']), R['17']);
  T.chk('deploy check: it writes nothing (one transaction, rolled back)', db.sql('select count(*) from public.novig_book_snapshots') === snapsBefore && db.sql("select current_setting('request.jwt.claim.sub', true)") === '');
  db.sql(`update public.novig_config set value = 'on', note = 'test: the deploy check sees it' where key = 'public_display'; grant select on public.novig_book_snapshots to anon;`);
  R = report(DC.checkSql(OP));
  T.chk('deploy check: it fails when it should — display switched on, or anon granted a table, each reads CHECK THIS', /^CHECK THIS: on\b/.test(R['8']) && /^CHECK THIS: novig_book_snapshots:select/.test(R['4']), [R['8'], R['4']]);
  db.sql(`update public.novig_config set value = 'off', note = 'test: back off' where key = 'public_display'; revoke select on public.novig_book_snapshots from anon;`);
  R = report(DC.checkSql('00000000-0000-0000-0000-0000000000bb'));
  T.chk('deploy check: an account that is not an admin, named as the admin, fails row 22', /^CHECK THIS/.test(R['22']), R['22']);
  T.chk('deploy check: --admin must be a uuid (nothing is interpolated unchecked)', fails(() => DC.checkSql("x'; drop table public.novig_config; --")) && fails(() => DC.viewSql('')));
  const V = JSON.parse(db.sql(DC.viewSql(OP)).split('\n').filter((l) => /^\{/.test(l)).pop());
  T.chk('deploy view: the admin\'s card data — the compare rows (production only), their history and the readiness row',
    V.access.access === 'operator' && V.rows.length > 0 && V.rows.every((r) => r.novig.environment === 'production') && Array.isArray(V.history['odds-1']) && V.history['odds-1'].length > 0 && !!V.readiness, [V.access, V.rows.length, Object.keys(V.history)]);
  const RSA = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const PUB = RSA.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const SEALED = DC.seal('BEGIN\nnoise\n' + JSON.stringify(V) + '\n', PUB);
  T.chk('seal: what a public log carries is ciphertext only — no price, team or market id', SEALED.length > 0 && SEALED.every((l) => /^NOVIG-SEALED [A-Za-z0-9+/=]+$/.test(l) && l.length <= 3013)
    && !/0\.\d{3}|Buffalo|nv-m1/.test(SEALED.join('\n')));
  const OPENED = DC.open(SEALED.map((l) => '2026-10-30T18:00:00.0000000Z ' + l).join('\n'), RSA.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  T.chk('seal: the holder of the private key opens it, from the timestamped log lines, exactly', JSON.stringify(OPENED) === JSON.stringify(V));
  const RSA2 = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  T.chk('seal: a key under 3072 bits is refused; a tampered blob does not open', fails(() => DC.seal(JSON.stringify(V), RSA2.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')))
    && fails(() => DC.open(SEALED.map((l, i) => (i === 0 ? l.slice(0, -8) + 'AAAAAAAA' : l)).join('\n'), RSA.privateKey.export({ type: 'pkcs8', format: 'pem' }))));

  /* ---- rollback ---- */
  const tapeBefore = db.sql('select count(*) from public.sharp_price_snapshots');
  out = db.applyFile(F('novig_market_data_rollback.sql'));
  T.chk('rollback: the layer and its jobs are gone; the DraftKings tape is untouched', /\|ok/.test(out) && db.sql("select count(*) from cron.job where jobname like 'novig_%'") === '0' && db.sql('select count(*) from public.sharp_price_snapshots') === tapeBefore
    && db.sql("select to_regclass('public.novig_config') is null") === 't', out);
  out = db.applyFile(F('novig_market_data.sql'));
  T.chk('rollback: the layer re-applies cleanly afterwards', !/CHECK THIS/.test(out));
} catch (e) {
  T.chk('the suite ran without an unexpected error', false, String(e.message).slice(0, 1500));
} finally { db.stop(); }

/* ---- production's DraftKings source before sharp_lag.sql: capture's per-book history ----
   Production has public.signals and public.book_quote_ticks and no public.sharp_price_snapshots: the layer must
   read DraftKings from capture's history (actionable signals only), through its own view, and switch to the full
   tape once sharp_lag.sql is applied and the layer applied again. */
const db2 = PG.start('novig_ticks');
if (!db2.skip) try {
  const J2 = (q, who) => J((who || db2.sql)(`select coalesce(jsonb_agg(x), '[]'::jsonb) from (${q}) x;`));
  db2.sql(`create table public.signals (id bigserial primary key, sig_key text unique not null, event_id text, sport_key text, commence_time timestamptz,
      home_team text, away_team text, market text, selection text, point numeric);
    create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() in (${lit(SUB)}::uuid, ${lit(OP)}::uuid) $$;
    create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select auth.uid() = ${lit(OP)}::uuid $$;`);
  let err = null; try { db2.applyFile(F('novig_market_data.sql')); } catch (e) { err = String(e.message); }
  T.chk('ticks: with neither DraftKings source the layer names both files and installs nothing', /sharp_lag\.sql/.test(err || '') && /book_quote_ticks\.sql/.test(err || '')
    && db2.sql("select to_regclass('public.novig_markets') is null") === 't', err);
  /* supabase/book_quote_ticks.sql's table, service-only as there */
  db2.sql(`create table public.book_quote_ticks (id bigserial primary key, sig_key text not null, book_key text, book_title text, dec numeric, fair numeric,
      is_sharp boolean, event_id text, seen_at timestamptz not null default now(), payload jsonb);
    alter table public.book_quote_ticks enable row level security; revoke all on public.book_quote_ticks from anon, authenticated;
    grant select, insert on public.book_quote_ticks to service_role;`);
  let out2 = db2.applyFile(F('novig_market_data.sql'));
  T.chk('ticks: the layer applies; every report row is ok, and row 7 names capture\'s per-book history as the DraftKings source', !/CHECK THIS/.test(out2)
    && /7 the DraftKings prices are readable by the layer \(public\.novig_dk_tape\)\|ok \(capture's per-book history: DraftKings for actionable signals only\)/.test(out2)
    && db2.sql('select public.novig_dk_source()') === 'book_quote_ticks', out2);
  /* the world: BAL @ BUF in 3 hours; capture flagged both moneyline sides, so it kept their per-book quotes */
  db2.sql(`insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point) values
      ('odds-1|h2h|Buffalo Bills|', 'odds-1', 'americanfootball_nfl', now() + interval '3 hours', 'Buffalo Bills', 'Baltimore Ravens', 'h2h', 'Buffalo Bills', null),
      ('odds-1|h2h|Baltimore Ravens|', 'odds-1', 'americanfootball_nfl', now() + interval '3 hours', 'Buffalo Bills', 'Baltimore Ravens', 'h2h', 'Baltimore Ravens', null);`);
  db2.service(`insert into public.book_quote_ticks (sig_key, book_key, book_title, dec, seen_at, payload) values
      ('odds-1|h2h|Buffalo Bills|', 'draftkings', 'DraftKings', 1.606, now() - interval '5 minutes', '{"quote_age_s": 30}'),
      ('odds-1|h2h|Buffalo Bills|', 'draftkings', 'DraftKings', 1.588, now() - interval '50 minutes', '{"quote_age_s": 12}'),
      ('odds-1|h2h|Buffalo Bills|', 'fanduel', 'FanDuel', 1.629, now() - interval '2 minutes', '{"quote_age_s": 5}'),
      ('odds-1|h2h|Baltimore Ravens|', 'draftkings', 'DraftKings', 2.45, now() - interval '200 minutes', '{}');
    insert into public.novig_events (event_id, environment, league, sport, description, status, starts_at, home_competitor_id, away_competitor_id, home_name, away_name) values
      ('nv-e1', 'production', 'NFL', 'FOOTBALL', 'Baltimore Ravens @ Buffalo Bills', 'OPEN_PREGAME', now() + interval '3 hours', 'c-buf', 'c-bal', 'Buffalo Bills', 'Baltimore Ravens');
    insert into public.novig_markets (market_id, environment, event_id, market_type, strike, status, voids, fee_coefficient, fee_maker_credit, fee_charged, outcomes) values
      ('nv-m1', 'production', 'nv-e1', 'MONEY', '0', 'OPEN', 'FMV', '0.06', '0.25', 'WHEN_LIVE', '[{"outcomeId":"o-buf","name":"BUF"},{"outcomeId":"o-bal","name":"BAL"}]');
    insert into public.novig_market_links (market_id, environment, novig_event_id, novig_market_type, league, sport, odds_event_id, odds_sport_key, book_market, period, line, outcomes,
      home_team, away_team, kickoff_at, match_confidence, match_method, linker_version) values
      ('nv-m1', 'production', 'nv-e1', 'MONEY', 'NFL', 'nfl', 'odds-1', 'americanfootball_nfl', 'h2h', 'game', null,
       '[{"outcome_id":"o-buf","side":"Buffalo Bills","point":null},{"outcome_id":"o-bal","side":"Baltimore Ravens","point":null}]', 'Buffalo Bills', 'Baltimore Ravens',
       now() + interval '3 hours', 'medium', 'test', 'test');
    insert into public.novig_book_snapshots (environment, market_id, captured_at, source, book_seq, event_status, market_status, fee_charged_now, top, exec, levels) values
      ('production', 'nv-m1', now() - interval '2 minutes', 'rest_book', 4233, 'OPEN_PREGAME', 'OPEN', false,
       '{"o-buf":{"bid":"0.620","bid_qty":3282,"ask":"0.625","ask_qty":995607},"o-bal":{"bid":"0.375","bid_qty":480391,"ask":"0.380","ask_qty":3282}}', '{}', 10);`);
  const C2 = J2('select c from public.novig_compare() c', (q) => db2.as(OP, q)).map((r) => r.c);
  const buf = C2.find((r) => r.side === 'Buffalo Bills'), bal = C2.find((r) => r.side === 'Baltimore Ravens');
  T.chk('ticks: the admin\'s comparison carries DraftKings\' latest tick for each side (never FanDuel\'s), dated by its capture, its book update the capture less the quote\'s age',
    C2.length === 2 && Number(buf.draftkings.price_dec) === 1.606 && buf.draftkings.state === 'LIVE' && Number(bal.draftkings.price_dec) === 2.45
    && Date.parse(buf.draftkings.observed_at) - Date.parse(buf.draftkings.book_last_update) === 30000 && !JSON.stringify(C2).includes('1.629'), C2.map((r) => [r.side, r.draftkings]));
  T.chk('ticks: a DraftKings tick older than the book rules is STALE (historical, never compared as current), and the source line says actionable signals only',
    bal.draftkings.state === 'STALE' && /book_quote_ticks: actionable signals only/.test(buf.draftkings.source), [bal.draftkings, buf.draftkings.source]);
  T.chk('ticks: the history has both DraftKings ticks of the BUF side, at their own times', J2("select h from public.novig_history('odds-1') h", (q) => db2.as(OP, q))
    .map((r) => r.h).filter((h) => h.venue === 'draftkings' && h.side === 'Buffalo Bills').length === 2);
  T.chk('ticks: the view is service-only — anon, a subscriber and a signed-in reader read none of it; nobody but the admin gets a comparison row',
    fails(() => db2.anon('select count(*) from public.novig_dk_tape;')) && fails(() => db2.as(SUB, 'select count(*) from public.novig_dk_tape;'))
    && fails(() => db2.as(NOSUB, 'select count(*) from public.novig_dk_tape;')) && db2.service('select count(*) from public.novig_dk_tape;').split('\n').pop() === '3'
    && J2('select c from public.novig_compare() c', (q) => db2.as(SUB, q)).length === 0);
  /* production has pg_cron and Vault; the deploy check reads both */
  db2.sql(`create schema if not exists cron; create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);`);
  const R2 = Object.fromEntries(db2.sql(require(path.join(__dirname, 'deploy_check.js')).checkSql(OP)).split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => { const p = l.split('|'); return [p[0], p.slice(2).join('|')]; }));
  T.chk('ticks: the deploy check reads the same view: its source, its rows (DraftKings only) and the newest, and nothing else', /^book_quote_ticks · 3 rows · newest /.test(R2['18'] || ''), R2['18']);
  /* sharp_lag.sql arrives: the layer, applied again, reads the full tape */
  db2.sql(`create table public.sharp_price_snapshots (id bigint generated always as identity primary key, captured_at timestamptz not null, sport_key text not null, event_id text not null,
      book text not null, book_last_update timestamptz, market text not null, side text not null, participant text, point numeric, price_dec numeric not null);
    insert into public.sharp_price_snapshots (captured_at, sport_key, event_id, book, book_last_update, market, side, point, price_dec) values
      (now() - interval '1 minute', 'americanfootball_nfl', 'odds-1', 'draftkings', now() - interval '2 minutes', 'h2h', 'Buffalo Bills', null, 1.612);`);
  out2 = db2.applyFile(F('novig_market_data.sql'));
  const after = J2('select c from public.novig_compare() c', (q) => db2.as(OP, q)).map((r) => r.c).find((r) => r.side === 'Buffalo Bills');
  T.chk('ticks: applied again after sharp_lag.sql, the layer reads the Sharp-lag tape (row 7 says so; BUF\'s DraftKings price is the tape\'s)',
    /\|ok \(the Sharp-lag tape\)/.test(out2) && db2.sql('select public.novig_dk_source()') === 'sharp_price_snapshots' && Number(after.draftkings.price_dec) === 1.612, [after && after.draftkings]);
  out2 = db2.applyFile(F('novig_market_data_rollback.sql'));
  T.chk('ticks: the rollback drops the view and leaves signals, book_quote_ticks and the tape exactly as they were',
    db2.sql("select to_regclass('public.novig_dk_tape') is null") === 't' && db2.service('select count(*) from public.book_quote_ticks;').split('\n').pop() === '4'
    && db2.sql('select count(*) from public.signals') === '2' && db2.sql('select count(*) from public.sharp_price_snapshots') === '1', out2);
} catch (e) {
  T.chk('the ticks suite ran without an unexpected error', false, String(e.message).slice(0, 1500));
} finally { db2.stop(); }
process.exit(T.done());
