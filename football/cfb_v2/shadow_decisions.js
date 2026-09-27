#!/usr/bin/env node
/* Shadow research statuses from the PRODUCTION engine.
   node football/cfb_v2/shadow_decisions.js [--season 2026]

   For every frozen V2 row, runs engine.pure() and engine.decide() against the
   market captured when the row was frozen (shadow.market_at_freeze). The
   archive and the shadow feed carry no spread prices, so decide() reports
   "EV not computable" and PASS unless the row is a REVIEW (big disagreement or
   a sign-flipped market) — which is exactly what production would show. The
   counts feed monitoring.json (BET must never appear while BET is disabled). */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global.window || global;
require(path.join(__dirname, 'params.js'));
const E = require(path.join(__dirname, 'engine.js'));
const P = global.window.EDCfbV2Params;
const i = process.argv.indexOf('--season');
const SEASON = i > 0 ? process.argv[i + 1] : String(new Date().getUTCFullYear());
const dir = path.join(__dirname, 'snapshots', SEASON);
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'replay_to_date.json') : [];
const counts = { BET: 0, LEAN: 0, REVIEW: 0, PASS: 0 };
const rows = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const x of j.rows) {
    const r = x.row;
    const p = E.pure(r, {});
    const m = r.shadow && r.shadow.market_at_freeze;
    const market = m && typeof m.current_home_line === 'number'
      ? { current: { home_line: m.current_home_line, ts: r.shadow.captured_at },
          open: typeof m.open_home_line === 'number' ? { home_line: m.open_home_line } : undefined }
      : null;
    const d = E.decide(p, market, { now: r.shadow ? r.shadow.captured_at : r.prediction_ts, row: r });
    counts[d.status] = (counts[d.status] || 0) + 1;
    rows.push({ game_id: r.game_id, week: r.week, status: d.status, reasons: d.reasons, gap: d.raw_gap_pts });
  }
}
const out = { season: Number(SEASON), model_version: P.model_version, bet_enabled: !!P.market.bet_enabled,
  generated_at: new Date().toISOString(), counts, rows,
  note: 'engine.decide() on the market captured at each freeze; no captured price means EV is not computable (never assumed -110)' };
fs.mkdirSync(path.join(__dirname, 'shadow', SEASON), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'shadow', SEASON, 'decisions.json'), JSON.stringify(out, null, 1) + '\n');
console.log('[shadow decisions]', counts);
