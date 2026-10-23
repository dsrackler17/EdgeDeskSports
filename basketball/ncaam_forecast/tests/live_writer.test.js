#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The live writer (live_writer.js): refuses while disabled, refuses in
   GitHub Actions, writes one row per new observation, suppresses stale or
   contradictory ones with their reasons, never writes for a game outside the
   backtest's scope. The database is a recording fake; rows are SYNTHETIC.

     node basketball/ncaam_forecast/tests/live_writer.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./_kit').kit('ncaam live writer');
const W = require('../live_writer');
const L = require('../live');
const C = require('../config');

/* refusals */
const shipped = JSON.parse(fs.readFileSync(C.PATHS.liveConfig, 'utf8'));
T.chk('the shipped configuration refuses to start, naming its blockers', W.refusals(shipped, {}).length === 1 && /disabled/.test(W.refusals(shipped, {})[0]) && /always-on/.test(W.refusals(shipped, {})[0]));
T.chk('an enabled configuration still refuses inside GitHub Actions', /not a real-time service/.test(W.refusals({ enabled: true }, { GITHUB_ACTIONS: 'true' }).join()));
T.eq('an enabled configuration on an operator host may start', W.refusals({ enabled: true }, {}), []);
(async () => {
  const errs = []; const origErr = console.error; console.error = (m) => errs.push(String(m));
  const code = await W.main(['node', 'live_writer.js', '--once'], { SB_URL: 'https://x.supabase.co', SB_SERVICE_ROLE: 'k'.repeat(40) });
  console.error = origErr;
  T.eq('the CLI exits 2 without touching the database while disabled', code, 2);
  T.chk('...and says why', /not started/.test(errs.join()));

  /* clock parsing */
  T.eq('display clocks', [W.parseClock('12:34'), W.parseClock('0:45.3'), W.parseClock('9.8'), W.parseClock(''), W.parseClock(null)], [754, 45, 9, null, null]);

  /* the pregame document */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaamlive-'));
  const fc = (id, o) => Object.assign({ game_id: id, home_id: '10', away_id: '20', regime: 'D1_D1', available: true, p_home: 0.7, live_inputs: { mu: 5, sd: 11, kappa: 2.2, ot_sd: 4.8 } }, o);
  const doc = (key, pub, fcs, stamp) => { fs.writeFileSync(path.join(dir, stamp + '.json'), JSON.stringify({ schema: 'edgedesk_ncaam_fc_forecasts_v1', publishable: pub, model: { key }, forecasts: fcs })); };
  doc('ncaam_adjeff@1.0.0', true, [fc('1'), fc('2', { regime: 'D1_OTHER' }), fc('3', { home_id: '30', away_id: '40' })], '20261201T1500');
  doc('ncaam_adjeff@1.0.0', false, [], '20261201T1600');
  doc('ncaam_points@1.1.0', true, [], '20261201T1700');
  const pg = W.latestPregame(dir, 'ncaam_adjeff@1.0.0');
  T.chk('the pregame is the newest PUBLISHABLE document of the CURRENT champion', pg && pg.forecasts.length === 3);
  T.eq('no document of the champion: nothing to condition on', W.latestPregame(dir, 'ncaam_adjeff@9.9.9'), null);

  /* cycles against a recording database */
  const now = Date.parse('2026-12-01T20:00:00Z');
  let feed = [];
  const calls = [];
  const db = { async rpc(name, args) { calls.push([name, args]); if (name === 'ncaam_fc_live_observations') return feed; return 1; } };
  const row = (o) => Object.assign({ game_id: '1', status: 'LIVE', period: 2, clock: '5:00', home_id: '10', away_id: '20', home_score: 50, away_score: 48, updated_at: '2026-12-01T19:59:40Z' }, o);
  const cfg = Object.assign({}, shipped, { enabled: true });
  const state = { last: new Map(), alert: new Map() };
  feed = [row({}), row({ game_id: '2' }), row({ game_id: '3', home_id: '30', away_id: '99' }), row({ game_id: '404' })];
  let r = await W.cycle({ db, pregame: pg, cfg, state, nowMs: now });
  const puts = () => calls.filter((c) => c[0] === 'ncaam_fc_put_live').map((c) => c[1].p);
  T.eq('one live row for the D1-v-D1 game with a pregame forecast', puts().map((p) => p.game_id), ['1']);
  T.eq('the others are skipped with reasons', r.skipped, { not_d1_v_d1: 1, team_mismatch: 1, no_pregame_forecast: 1 });
  const p1 = puts()[0];
  const expect = L.liveProb({ mu: 5, sd: 11 }, { kappa: 2.2, ot: { sd: 4.8 } }, { period: 2, clock_s: 300, home_score: 50, away_score: 48 }, shipped.model_params).p_home;
  T.near('the live probability is live.js with the configured parameters', p1.p_home_live, expect, 1e-12);
  T.chk('the row carries the pregame number, the model key and the feed age', p1.p_home_pregame === 0.7 && p1.model_key === 'ncaam_adjeff@1.0.0' && p1.feed_ok === true && p1.feed_age_s === 20);
  r = await W.cycle({ db, pregame: pg, cfg, state, nowMs: now + 5000 });
  T.eq('an unchanged observation writes nothing', [puts().length, r.skipped.unchanged], [1, 1]);
  feed = [row({ home_score: 45, updated_at: '2026-12-01T19:59:50Z' })];
  await W.cycle({ db, pregame: pg, cfg, state, nowMs: now + 10000 });
  const sup = puts()[1];
  T.chk('a score that went down is written SUPPRESSED, with no live probability and its reason', sup.feed_ok === false && sup.p_home_live === null && /score went down/.test(sup.suppressed_reasons.join()));
  feed = [row({ home_score: 52, clock: '4:00', updated_at: '2026-12-01T19:50:00Z' })];
  await W.cycle({ db, pregame: pg, cfg, state, nowMs: now + 15000 });
  T.chk('a stale observation is written SUPPRESSED', puts()[2].feed_ok === false && /stale/.test(puts()[2].suppressed_reasons.join()));
  feed = [row({ home_id: '20', away_id: '10', home_score: 40, away_score: 60, clock: '3:00', updated_at: '2026-12-01T20:00:20Z' })];
  await W.cycle({ db, pregame: pg, cfg, state, nowMs: now + 30000 });
  T.chk('a feed that lists the sides the other way round is read in the forecast\'s orientation', puts()[3].home_score === 60 && puts()[3].away_score === 40);
  feed = [row({ clock: null, home_score: 61, away_score: 40, updated_at: '2026-12-01T20:00:40Z' })];
  r = await W.cycle({ db, pregame: pg, cfg, state, nowMs: now + 45000 });
  T.chk('an observation without a clock is not written (the table requires one) and is counted', puts().length === 4 && r.skipped.incomplete_observation === 1);
  const dry = { last: new Map(), alert: new Map() }; const before = puts().length;
  feed = [row({ updated_at: '2026-12-01T20:01:00Z' })];
  r = await W.cycle({ db, pregame: pg, cfg, state: dry, nowMs: now + 60000, dryRun: true });
  T.chk('--dry-run computes and writes nothing', r.written.length === 1 && puts().length === before);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(T.done());
})().catch((e) => { T.chk('the suite ran without an unexpected error', false, String(e.stack || e)); process.exit(T.done()); });
