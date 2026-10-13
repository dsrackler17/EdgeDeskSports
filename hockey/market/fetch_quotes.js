#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — ask the odds gateway for NHL prices, ONLY when authorised.

     NHL_PRICES=on node hockey/market/fetch_quotes.js

   Spends nothing unless BOTH switches are on:
     1. the repository variable NHL_PRICES=on (this job), and
     2. the gateway's own sport row: odds_api_sports.icehockey_nhl enabled
        (supabase/migrations/20261013_nhl_sport_row.sql inserts it DISABLED).
   With either off it writes hockey/market/quotes.json with status DISABLED
   and the reason; the slate and the board then say prices are unavailable
   and keep every value claim off. It never reads the provider key and never
   names the provider host: the gateway is the only client
   (tools/odds/no_bypass.test.js).

   One request per run: category `featured` (h2h, spreads, totals for every
   upcoming NHL game in one call, ≈3 credits when the gateway buys it; served
   from the stored snapshot at no cost inside the gateway's cadence window).
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
  const write = (obj) => { fs.writeFileSync(out, JSON.stringify(Object.assign({ schema: C.SCHEMA.market, sport_key: 'icehockey_nhl', generated_at: new Date().toISOString() }, obj), null, 1) + '\n'); return obj; };
  if (String(env.NHL_PRICES || '').toLowerCase() !== 'on') return write({ status: 'DISABLED', reason: 'NHL price capture is not authorised: the repository variable NHL_PRICES is not "on" (and odds_api_sports.icehockey_nhl must be enabled in the gateway)', events: [] });
  const cfg = GW.config(env);
  if (!cfg) return write({ status: 'UNAVAILABLE', reason: 'no gateway credentials in this job (EDGD_SB_URL / EDGD_SB_SERVICE or ODDS_GATEWAY_SECRET)', events: [] });
  const client = GW.client(cfg, o.fetchImpl);
  const env2 = await client.request({ caller: 'nhl_slate', consumer: 'nhl_slate', category: 'featured', sport_key: 'icehockey_nhl', odds_format: 'american', allow_stale: true });
  if (!env2.ok || !Array.isArray(env2.data)) return write({ status: 'UNAVAILABLE', reason: 'the gateway refused or failed: ' + (env2.decision || '') + ' ' + (env2.reason || ''), gateway: { decision: env2.decision, source: env2.source, cost: env2.cost || 0 }, events: [] });
  const schedule = (o.schedule || readSlateSchedule());
  const n = Q.normaliseEvents(env2.data, schedule);
  return write({
    status: env2.source === 'provider' || env2.fresh ? 'LIVE' : 'CACHED',
    gateway: { decision: env2.decision, source: env2.source, fetched_at: env2.fetched_at, request_id: env2.request_id, cost: env2.cost || 0, quota: env2.quota || null },
    settlement: 'h2h = two-way incl. OT/SO; spreads = puck line incl. OT/SO; totals incl. OT, shootout winner +1 goal (assumed provider defaults; docs/engine/DATA.md)',
    events: n.events, unmatched: n.unmatched,
  });
}

function readSlateSchedule() {
  try { const s = JSON.parse(fs.readFileSync(C.PATHS.slate, 'utf8')); return s.games.map((g) => ({ game_id: g.game_id, home: g.home, away: g.away, start_utc: g.start_utc })); } catch (_) { return []; }
}

if (require.main === module) run().then((r) => console.log('[nhl quotes] ' + r.status + (r.reason ? ': ' + r.reason : '') + (r.events ? ' — ' + r.events.length + ' games' : ''))).catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { run };
