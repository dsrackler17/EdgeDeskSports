#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — the worker end to end (tools/foresight/run.js) over the
   COMMITTED ledgers, through a PostgREST stand-in on a real PostgreSQL
   (tools/billing/_pgrest.js) with supabase/market_foresight.sql applied.

     node tools/foresight/worker.test.js     (MF_SQL_REQUIRED=1 in CI)

   The DraftKings quotes and EdgeDesk forecasts are the real committed
   records, evaluated as of a fixed instant. Kalshi and the Collective live
   only in the database, so this test seeds them for ONE real game, in the
   throwaway database only: Kalshi quotes that follow DraftKings' de-vigged
   path, and three listed Collective models.

     first run   everything stored; Kalshi is read and never compared
                 (settlement unverified); the Collective is linked by
                 football_identity and measured; the consensus needs three
     again       nothing new is written (idempotent); Kalshi comes from the
                 cache, not the database
     verified    an operator verifies the rules text: the next run measures
                 the forecast against Kalshi and the venue lead-lag; the
                 changed units are re-versioned, history kept
     partial     Kalshi unreadable: the run is partial, the game it cannot
                 compute is left as stored, the summaries are kept
     budget      a request budget stops a runaway run
     secrets     the service key never appears in an error
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const RUN = require(path.join(__dirname, 'run.js'));
const DB = require(path.join(__dirname, 'db.js'));
const SRC = require(path.join(__dirname, 'sources.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_foresight.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const T = PG.kit('Market Foresight worker');
const NOW = '2026-10-25T06:00:00.000Z';
const ADMIN = '00000000-0000-0000-0000-0000000000cc';

/* the fixture directory is never a source */
T.chk('the worker refuses to read the test fixtures', (() => { try { SRC.readJsonl(path.join(__dirname, 'fixtures', 'synthetic.js')); return false; } catch (e) { return /never reads test fixtures/.test(e.message); } })());

/* pick ONE real CFB game: an EdgeDesk forecast captured live within 80 h of
   kickoff, a DraftKings moneyline series, kicked off before NOW */
const log = [];
const local = SRC.readLocal(ROOT, log);
const cfb = local.sports.cfb;
const nowMs = Date.parse(NOW);
const pick = Object.keys(cfb.events).sort().map((id) => cfb.events[id]).filter((ev) => {
  const K = Date.parse(ev.kickoff);
  if (K > nowMs - 6 * 3600000 || ev.state !== 'FINAL') return false;
  const ml = (cfb.dk.byGame[ev.event_id] || []).filter((q) => q.market_type === 'moneyline');
  const f = cfb.edgedesk.forecasts.filter((x) => x.event_id === ev.event_id && x.evidence === 'ledger_captured' && x.values.moneyline !== null);
  return ml.length >= 6 && f.length && K - Date.parse(f[0].published_at) < 70 * 3600000 && K - Date.parse(f[0].published_at) > 4 * 3600000
    && ml.some((q) => Date.parse(q.observed_at) <= Date.parse(f[0].published_at) && Date.parse(f[0].published_at) - Date.parse(q.observed_at) < 300 * 60000);
})[0];
T.chk('a real committed game qualifies for the scenario', !!pick, 'none found');
if (!pick) process.exit(T.done());
const K = Date.parse(pick.kickoff);

const db = PG.start('mfworker');
if (db.skip) {
  if (process.env.MF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the worker did not run'); process.exit(T.done());
}
const lit = PG.lit;
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-kalshi-'));
const quiet = { log: () => {}, error: () => {} };

try {
  db.sql(`create or replace function public.community_is_entitled(u uuid) returns boolean language sql stable as $$ select false $$;
    create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select auth.uid() = ${lit(ADMIN)}::uuid $$;`);
  db.applyFile(path.join(ROOT, 'supabase', 'market_foresight.sql'));

  /* ---- Kalshi, as kalshi_market_data.sql has it (the columns the worker reads) ---- */
  const RULES = 'If ' + pick.home + ' wins the game, including any overtime, the market resolves to Yes.';
  db.sql(`create table public.kalshi_markets (ticker text primary key, series_ticker text, rules_primary text);
    create table public.kalshi_game_links (market_ticker text primary key, event_ticker text, series_ticker text, sport text, yes_team text, opponent text,
      home_team text, away_team text, kickoff_at timestamptz, game_id text);
    create table public.kalshi_price_snapshots (id bigint generated always as identity primary key, ticker text, captured_at timestamptz, yes_bid numeric, yes_ask numeric,
      no_bid numeric, no_ask numeric, last_price numeric, yes_bid_size numeric, yes_ask_size numeric, volume numeric, open_interest numeric);
    create table public.kalshi_readiness (x int);
    insert into public.kalshi_markets values ('KXNCAAFGAME-T-HOME', 'KXNCAAFGAME', ${lit(RULES)}), ('KXNCAAFGAME-T-AWAY', 'KXNCAAFGAME', ${lit(RULES.replace(pick.home, pick.away))});
    insert into public.kalshi_game_links values
      ('KXNCAAFGAME-T-HOME', 'KXNCAAFGAME-T', 'KXNCAAFGAME', 'cfb', ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.kickoff)}, ${lit(pick.event_id)}),
      ('KXNCAAFGAME-T-AWAY', 'KXNCAAFGAME-T', 'KXNCAAFGAME', 'cfb', ${lit(pick.away)}, ${lit(pick.home)}, ${lit(pick.home)}, ${lit(pick.away)}, ${lit(pick.kickoff)}, ${lit(pick.event_id)});`);
  /* the home market follows DraftKings' de-vigged path, two cents wide, every 5 minutes for the last 79 h */
  const ml = cfb.dk.byGame[pick.event_id].filter((q) => q.market_type === 'moneyline').sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const fairAt = (t) => { let p = null; ml.forEach((q) => { if (Date.parse(q.observed_at) <= t) { const d = C.noVigTwoWay(q.price_home, q.price_away); if (d) p = d.a; } }); return p; };
  const snaps = [];
  for (let t = K - 79 * 3600000, v = 1000; t < K; t += 5 * 60000, v += 3) {
    const p = fairAt(t); if (p === null) continue;
    const mid = Math.min(0.97, Math.max(0.03, Math.round(p * 100) / 100));
    snaps.push('(' + ["'KXNCAAFGAME-T-HOME'", lit(new Date(t).toISOString()), (mid - 0.01).toFixed(2), (mid + 0.01).toFixed(2), 'null', 'null', mid.toFixed(2), 50, 60, v, 500].join(',') + ')');
  }
  db.sql('insert into public.kalshi_price_snapshots (ticker, captured_at, yes_bid, yes_ask, no_bid, no_ask, last_price, yes_bid_size, yes_ask_size, volume, open_interest) values ' + snaps.join(',') + ';');
  T.chk('the scenario has a Kalshi series under one page', snaps.length > 100 && snaps.length < 1000, snaps.length);

  /* ---- the Collective (production's columns; served through public views here because the stand-in reads public) ---- */
  const C1 = 'c0000000-0000-0000-0000-000000000001', C2 = 'c0000000-0000-0000-0000-000000000002', C3 = 'c0000000-0000-0000-0000-000000000003';
  const M1 = 'd0000000-0000-0000-0000-000000000001', M2 = 'd0000000-0000-0000-0000-000000000002', M3 = 'd0000000-0000-0000-0000-000000000003';
  const at = (h) => lit(new Date(K + h * 3600000).toISOString());
  db.sql(`create schema collective;
    create table collective.teams (id text primary key, name text, code text);
    create table collective.games (id uuid primary key, sport_code text, season int, week int, kickoff_at timestamptz, home_team_id text, away_team_id text, status text, external_ref text);
    create table collective.creators (id uuid primary key, slug text, display_name text, is_listed boolean, status text, removed_at timestamptz);
    create table collective.models (id uuid primary key, creator_id uuid, slug text, name text, sport_code text, is_listed boolean, source_kind text, source_ref text);
    create table collective.projections (id uuid primary key default gen_random_uuid(), model_id uuid, game_id uuid, received_at timestamptz, projected_spread numeric,
      projected_total numeric, home_win_prob numeric, data_origin text, resolution_status text);
    insert into collective.teams values ('T_HOME', ${lit(pick.home)}, null), ('T_AWAY', ${lit(pick.away)}, null);
    insert into collective.games values ('e0000000-0000-0000-0000-000000000001', 'NCAAF', 2026, 8, ${lit(pick.kickoff)}, 'T_HOME', 'T_AWAY', 'final', ${lit('espn:' + pick.event_id)});
    insert into collective.creators values (${lit(C1)}, 'one', 'One', true, 'active', null), (${lit(C2)}, 'two', 'Two', true, 'active', null), (${lit(C3)}, 'three', 'Three', true, 'active', null);
    insert into collective.models values (${lit(M1)}, ${lit(C1)}, 'one-cfb', 'Alpha', 'NCAAF', true, null, null), (${lit(M2)}, ${lit(C2)}, 'two-cfb', 'Beta', 'NCAAF', true, null, null),
      (${lit(M3)}, ${lit(C3)}, 'three-cfb', 'Gamma', 'NCAAF', true, null, null);
    insert into collective.projections (model_id, game_id, received_at, projected_spread, projected_total, home_win_prob, data_origin, resolution_status) values
      (${lit(M1)}, 'e0000000-0000-0000-0000-000000000001', ${at(-30)}, -3.5, 50.5, 0.62, 'live', 'resolved'),
      (${lit(M2)}, 'e0000000-0000-0000-0000-000000000001', ${at(-27)}, -6.0, 52.0, 0.70, 'live', 'resolved'),
      (${lit(M3)}, 'e0000000-0000-0000-0000-000000000001', ${at(-26)}, 2.0, 47.0, 0.45, 'live', 'resolved'),
      (${lit(M1)}, 'e0000000-0000-0000-0000-000000000001', ${at(-0.2)}, -9.0, 50.5, 0.80, 'live', 'resolved');
    create view public.collective__games as select * from collective.games;
    create view public.collective__teams as select * from collective.teams;
    create view public.collective__models as select * from collective.models;
    create view public.collective__creators as select * from collective.creators;
    create view public.collective__projections as select * from collective.projections;
    grant select on public.collective__games, public.collective__teams, public.collective__models, public.collective__creators, public.collective__projections,
      public.kalshi_markets, public.kalshi_game_links, public.kalshi_price_snapshots, public.kalshi_readiness to service_role;`);

  const stand = REST.make(db, { serviceKey: 'svc-key-xyz' });
  const fetchImpl = (url, init) => {
    const h = (init && init.headers) || {};
    return stand.fetch(h['Accept-Profile'] === 'collective' ? url.replace('/rest/v1/', '/rest/v1/collective__') : url, init);
  };
  const env = { SB_URL: 'http://standin', SB_SERVICE_ROLE: 'svc-key-xyz' };
  const go = (extra) => RUN.execute(Object.assign({ write: true, dry: false, now: NOW, since: '2026-08-01T00:00:00.000Z', cache, trigger: 'test' }, extra || {}), env, Object.assign({ fetchImpl, sleep: async () => {} }, quiet));
  const one = (q) => J(db.sql('select coalesce(to_jsonb(x), \'null\'::jsonb) from (' + q + ') x;'));
  const lastRun = () => one('select * from public.mf_runs order by started_at desc limit 1');
  const units = (q) => J(db.sql("select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from public.mf_units u where " + q + ';'));

  (async () => {
    /* ---------------------------------------------------------------- first run */
    let code = await go();
    let r = lastRun();
    T.chk('first run: ok', code === 0 && r.status === 'ok', { code, status: r.status, error: r.error, sources: r.sources });
    T.chk('first run: Kalshi and the Collective are connected', r.sources.kalshi.status === 'connected' && r.sources.collective.status === 'connected', r.sources);
    T.chk('first run: every finished committed game is stored', +db.sql('select count(*) from public.mf_games;') === r.counts.games && r.counts.games > 400, r.counts);
    T.chk('first run: every unit is stored', +db.sql('select count(*) from public.mf_units;') === r.counts.units);
    const kal = units("event_id = " + lit(pick.event_id) + " and venue = 'kalshi'");
    T.chk('Kalshi is read, linked to the home team, and never compared while unverified (forecast-side reasons come first)',
      kal.length > 0 && kal.every((u) => u.status === 'excluded') && kal.some((u) => u.exclusion_reason === 'settlement_unverified') && kal.every((u) => u.exclusion_reason !== 'no_market_contract'), kal.map((u) => u.exclusion_reason));
    const g = one('select payload from public.mf_games where event_id = ' + lit(pick.event_id)).payload;
    T.chk('the game carries the Kalshi series (bid, ask and the mid separately)', !!g.series['kalshi:moneyline'] && g.series['kalshi:moneyline'].segments[0].raw.yes_bid !== undefined && g.kalshi_market.ticker === 'KXNCAAFGAME-T-HOME');
    T.chk('the lead-lag is blocked, with its reason', g.lead_lag.status === 'BLOCKED' && g.lead_lag.reason === 'settlement_unverified');
    const col = units("event_id = " + lit(pick.event_id) + " and source = 'collective'");
    T.chk('the Collective game is linked by football_identity and its models measured', col.length > 0 && new Set(col.map((u) => u.model_key)).size === 3 && col.some((u) => u.status === 'measured'), col.map((u) => [u.model_key, u.market, u.venue, u.exclusion_reason]));
    T.chk('a Collective revision inside the lock is never the unit', col.filter((u) => u.model_key === 'collective:' + M1 && u.market === 'spread' && u.venue === 'draftkings')[0].payload.forecast_value === -3.5);
    const cons = units("event_id = " + lit(pick.event_id) + " and source = 'collective_consensus'");
    T.chk('the consensus appears only once three models had published (24 h and later, not 48 h)', cons.length > 0 && cons.every((u) => !/2880m/.test(u.model_key)) && cons.some((u) => /1440m/.test(u.model_key)));
    const c24 = cons.filter((u) => /1440m/.test(u.model_key) && u.model_version === 'equal_weight_mean' && u.market === 'spread')[0];
    T.chk('the 24 h consensus spread is the mean of -3.5, -6 and +2 (-2.5)', c24 && c24.payload.forecast_value === -2.5, c24 && c24.payload.forecast_value);
    const versions1 = +db.sql('select count(*) from public.mf_unit_versions;');
    const sums1 = +db.sql('select count(*) from public.mf_summaries;');
    T.chk('summaries for the whole record and the last 30 and 7 days', sums1 > 0 && +db.sql("select count(distinct window_key) from public.mf_summaries;") === 3);

    /* ---------------------------------------------------------------- again */
    code = await go();
    r = lastRun();
    T.chk('again: ok and nothing new written (idempotent)', code === 0 && r.counts.wrote.units.inserted === 0 && r.counts.wrote.units.updated === 0 && r.counts.wrote.games.inserted === 0 && r.counts.wrote.games.updated === 0, r.counts.wrote);
    T.chk('again: no version appended', +db.sql('select count(*) from public.mf_unit_versions;') === versions1);
    T.chk('again: Kalshi came from the cache, not the database', r.sources.kalshi.cached === 2 && r.sources.kalshi.fetched === 0, r.sources.kalshi);
    T.chk('again: the same summaries', +db.sql('select count(*) from public.mf_summaries;') === sums1);

    /* ---------------------------------------------------------------- verified */
    const digest = crypto.createHash('sha256').update(RULES, 'utf8').digest('hex');
    db.as(ADMIN, 'select public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNCAAFGAME', sport: 'cfb', rules_sha256: digest, overtime: 'included', tie: 'impossible', note: 'test' })) + '::jsonb);');
    code = await go();
    r = lastRun();
    const kal2 = units("event_id = " + lit(pick.event_id) + " and venue = 'kalshi'");
    T.chk('verified: the forecasts are measured against Kalshi (or excluded for a market reason, never settlement)', code === 0 && kal2.every((u) => u.exclusion_reason !== 'settlement_unverified') && kal2.some((u) => u.status === 'measured'), kal2.map((u) => [u.model_key, u.status, u.exclusion_reason]));
    const g2 = one('select payload from public.mf_games where event_id = ' + lit(pick.event_id)).payload;
    T.chk('verified: the venue lead-lag is measured for the game', g2.lead_lag.status === 'MEASURED' && Array.isArray(g2.lead_lag.pairs), g2.lead_lag.status);
    T.chk('verified: only what changed was rewritten, its history kept', r.counts.wrote.units.updated > 0 && r.counts.wrote.units.updated < 40 && +db.sql('select count(*) from public.mf_unit_versions;') === versions1 + r.counts.wrote.units.updated, r.counts.wrote);
    const gameVersions = +db.sql('select count(*) from public.mf_game_versions where event_id = ' + lit(pick.event_id) + ';');
    T.chk('verified: the game\'s earlier version is kept beside the new one', gameVersions === 2);
    const llsum = r.lead_lag.filter((x) => x.sport === 'cfb' && x.bucket === 'all')[0];
    T.chk('verified: the lead-lag summary counts the game, with no leadership label on one game', llsum && llsum.games === 1 && llsum.label === null);

    /* ---------------------------------------------------------------- partial */
    fs.rmSync(cache, { recursive: true, force: true });
    const sumRun = db.sql('select distinct run_id from public.mf_summaries;');
    stand.fail('kalshi_game_links', 8);
    code = await go();
    r = lastRun();
    T.chk('partial: Kalshi unreadable makes the run partial (exit 1), with the reason', code === 1 && r.status === 'partial' && r.sources.kalshi.status === 'error', { code, status: r.status });
    T.chk('partial: the summaries are kept, not replaced by an incomplete set', db.sql('select distinct run_id from public.mf_summaries;') === sumRun);
    T.chk('partial: the game Kalshi could not be read for is left as stored', one('select payload from public.mf_games where event_id = ' + lit(pick.event_id)).payload.lead_lag.status === 'MEASURED');

    /* ---------------------------------------------------------------- budget and secrets */
    code = await RUN.execute({ write: true, dry: false, now: NOW, since: '2026-08-01T00:00:00.000Z', cache: null, trigger: 'test' }, env, Object.assign({ fetchImpl, sleep: async () => {}, maxRequests: 6 }, quiet));
    r = lastRun();
    T.chk('budget: a run that runs out of requests stops and says so', code === 1 && (r.status === 'partial' || r.status === 'failed') && JSON.stringify(r.log).includes('request budget exhausted'), r.status);
    const leaky = DB.client({ SB_URL: 'http://standin', SB_SERVICE_ROLE: 'super-secret-key-123' }, { fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'bad request near super-secret-key-123' }), sleep: async () => {} });
    let msg = null; try { await leaky.rpc('mf_job_known', { p_version: 'mf-v1' }); } catch (e) { msg = e.message; }
    T.chk('secrets: the service key is scrubbed from every error', msg && msg.indexOf('super-secret-key-123') < 0 && /\[redacted\]/.test(msg), msg);
    T.chk('the client calls Market Foresight job doors only', (() => { try { leaky.rpc('sc_ingest', {}); return false; } catch (e) { return /job doors only/.test(e.message); } })());
    T.chk('the client reads only its allowlist', (() => { try { leaky.get('signals?select=*'); return false; } catch (e) { return /only the layers/.test(e.message); } })());
    T.chk('no credentials: a dry run reads the committed sources and records the rest as not configured', await RUN.execute({ dry: true, now: NOW, cache: null }, {}, quiet) === 0);

    /* ---------------------------------------------------------------- the reader sees the run */
    const st = J(db.anon('select public.mf_status();'));
    T.chk('the status shows the latest completed run and the coverage, in shadow', st.mode === 'shadow' && st.last_run && ['ok', 'partial'].indexOf(st.last_run.status) >= 0 && st.coverage.length > 0, st.last_run);
    T.chk('no run is left holding the lease', +db.sql("select count(*) from public.mf_runs where status = 'running';") === 0);
  })().catch((e) => T.chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500)))
    .finally(() => { db.stop(); try { fs.rmSync(cache, { recursive: true, force: true }); } catch (_) { /* gone */ } process.exit(T.done()); });
} catch (e) {
  T.chk('the suite set up', false, String(e.message).slice(0, 1500));
  db.stop();
  process.exit(T.done());
}
