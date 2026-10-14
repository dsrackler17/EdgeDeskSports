#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — grade the published pregame sheets against what happened.

     node nba/grade_ledger.js [--season 2027]     writes nba/ledger/grades.json

   Reads the append-only ledger (nba/ledger/<season>.jsonl, written by
   nba/build_slate.js before each game), takes the LAST sheet recorded before
   each game's tip (the price as it stood), joins the final from the committed
   games table, and scores the moneyline (log loss, Brier, calibration), the
   fair spread (cover rate at the fair line, which should sit near 50%, and the
   margin error) and the fair total (over rate at the fair line, total error).
   Every figure prints its n and sample state. Nothing here was a bet, so there
   is no profit and no ROI; closing-line value needs captured prices and is
   reported only when the ledger froze them (not yet).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const D = require('./lib/data');
const V = require('../engine/validation');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

function grade(o) {
  o = o || {};
  const season = Number(o.season || C.currentSeason());
  const file = path.join(C.PATHS.ledger, season + '.jsonl');
  const recs = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const last = new Map();
  for (const r of recs) { if (!(Date.parse(r.recorded_at) < Date.parse(r.start_utc))) continue; const p = last.get(r.game_id); if (!p || r.recorded_at >= p.recorded_at) last.set(r.game_id, r); }
  const finals = new Map((o.games || D.games([season])).filter((g) => g.status === 'FINAL').map((g) => [String(g.game_id), g]));
  const ml = [], cover = [], over = [], mErr = [], tErr = [];
  for (const [gid, r] of last) {
    const g = finals.get(String(gid)); if (!g) continue;
    const margin = g.hs - g.as, total = g.hs + g.as;
    ml.push({ p: r.p_home, y: margin > 0 ? 1 : 0, date: g.date });
    if (margin + r.fair_spread_home !== 0) cover.push(margin + r.fair_spread_home > 0 ? 1 : 0);
    if (total !== r.fair_total) over.push(total > r.fair_total ? 1 : 0);
    mErr.push(Math.abs(margin - r.exp_margin)); tErr.push(Math.abs(total - r.exp_total));
  }
  const b = V.binary(ml); delete b.bins;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const out = { schema: 'edgedesk_nba_grades_v1', season, generated_at: new Date().toISOString(), sheets: recs.length, games_graded: ml.length, sample_state: V.sampleState(ml.length),
    moneyline: b, fair_spread: { n: cover.length, home_cover_rate: r4(mean(cover)), note: 'should sit near 50% when the fair line is unbiased' }, fair_total: { n: over.length, over_rate: r4(mean(over)) },
    margin_mae: r4(mean(mErr)), total_mae: r4(mean(tErr)), clv: { status: 'NOT_AVAILABLE', reason: 'no captured closing prices' }, profit: 'none — nothing was bet' };
  fs.mkdirSync(C.PATHS.ledger, { recursive: true });
  if (!o.dryRun) fs.writeFileSync(path.join(C.PATHS.ledger, 'grades.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

module.exports = { grade };
if (require.main === module) { const g = grade({ season: arg('season', null) }); console.log('[nba grade] ' + g.games_graded + ' games graded (' + g.sample_state + '), ' + g.sheets + ' sheets in the ledger'); }
