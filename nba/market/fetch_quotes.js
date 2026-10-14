#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — ask the odds gateway for NBA prices, ONLY when authorised.

     NBA_PRICES=on node nba/market/fetch_quotes.js

   Spends nothing unless BOTH switches are on:
     1. the repository variable NBA_PRICES=on (this job), and
     2. the gateway's own sport row: odds_api_sports.basketball_nba enabled
        (supabase/nba_odds_sport.sql inserts it DISABLED).
   With either off it writes nba/market/quotes.json with status DISABLED and
   the reason. It never reads the provider key and never names the provider
   host: the gateway is the only client (tools/odds/no_bypass.test.js).
   One `featured` request per run (h2h, spreads, totals ≈ 3 credits when the
   gateway buys it; served from the stored snapshot inside its cadence window).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const Q = require('./quotes');
const GW = require('../../tools/lib/odds_gateway.js');

async function run(o) {
  o = o || {};
  const env = o.env || process.env;
  const out = path.join(C.PATHS.market, 'quotes.json');
  fs.mkdirSync(C.PATHS.market, { recursive: true });
  const write = (obj) => { if (!o.dryRun) fs.writeFileSync(out, JSON.stringify(Object.assign({ schema: C.SCHEMA.market, sport_key: 'basketball_nba', generated_at: new Date().toISOString() }, obj), null, 1) + '\n'); return obj; };
  if (String(env.NBA_PRICES || '').toLowerCase() !== 'on') return write({ status: 'DISABLED', reason: 'NBA price capture is not authorised: the repository variable NBA_PRICES is not "on" (and odds_api_sports.basketball_nba must be enabled in the gateway)', events: [] });
  const cfg = GW.config(env);
  if (!cfg) return write({ status: 'UNAVAILABLE', reason: 'no gateway credentials in this job (EDGD_SB_URL / EDGD_SB_SERVICE or ODDS_GATEWAY_SECRET)', events: [] });
  const client = GW.client(cfg, o.fetchImpl);
  const res = await client.request({ caller: 'nba_slate', consumer: 'nba_slate', category: 'featured', sport_key: 'basketball_nba', odds_format: 'american', allow_stale: true });
  if (!res.ok || !Array.isArray(res.data)) return write({ status: 'UNAVAILABLE', reason: 'the gateway refused or failed: ' + (res.decision || '') + ' ' + (res.reason || ''), gateway: { decision: res.decision, source: res.source, cost: res.cost || 0 }, events: [] });
  const schedule = o.schedule || readSchedule();
  const n = Q.normaliseEvents(res.data, schedule);
  return write({ status: res.source === 'provider' || res.fresh ? 'LIVE' : 'CACHED',
    gateway: { decision: res.decision, source: res.source, fetched_at: res.fetched_at, request_id: res.request_id, cost: res.cost || 0, quota: res.quota || null },
    settlement: 'h2h = two-way incl. overtime; spreads and totals incl. overtime (assumed provider defaults)', events: n.events, unmatched: n.unmatched });
}
function readSchedule() {
  try { const s = JSON.parse(fs.readFileSync(C.PATHS.slate, 'utf8')); return s.games.map((g) => ({ game_id: g.game_id, home: g.home.id, away: g.away.id, start_utc: g.start_utc })); } catch (_) { return []; }
}
if (require.main === module) run().then((r) => console.log('[nba quotes] ' + r.status + (r.reason ? ': ' + r.reason : '') + (r.events ? ' — ' + r.events.length + ' games' : ''))).catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { run };
