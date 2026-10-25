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
const T = PG.kit('Market Foresight worker');

/* the fixture directory is never a source */
T.chk('the worker refuses to read the test fixtures', (() => { try { SRC.readJsonl(path.join(__dirname, 'fixtures', 'synthetic.js')); return false; } catch (e) { return /never reads test fixtures/.test(e.message); } })());

const SC = require(path.join(__dirname, '_scenario.js'));
const NOW = SC.NOW, ADMIN = SC.ADMIN;
const picked = SC.pickGame([]);
const pick = picked.pick, local = picked.local;
T.chk('a real committed game qualifies for the scenario', !!pick, 'none found');
if (!pick) process.exit(T.done());

const db = PG.start('mfworker');
if (db.skip) {
  if (process.env.MF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the worker did not run'); process.exit(T.done());
}
const lit = PG.lit;
const J = (s) => JSON.parse(String(s).split('\n').filter(Boolean).pop());
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-kalshi-'));
const quiet = { log: () => {}, error: () => {} };
const M1 = SC.M.M1;

try {
  SC.install(db);
  const seeded = SC.seed(db, pick, local);
  const RULES = seeded.RULES;
  T.chk('the scenario has a Kalshi series under one page', seeded.snaps > 100 && seeded.snaps < 1000, seeded.snaps);
  const stand = REST.make(db, { serviceKey: 'svc-key-xyz' });
  const fetchImpl = SC.collectiveFetch(stand);
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
