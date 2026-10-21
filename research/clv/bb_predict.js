#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The basketball lab model (edgedesk_bb_points_v1, the model loop's served
   version for --league) walked forward exactly as basketball/walkforward.js
   does — one causal pass, each game predicted 30 minutes before tip from
   results available by then, the calibration fitted on the three earlier
   seasons — and written per game for the CLV programme. Read-only: it calls
   the exported pass/score functions and writes nothing but <out.csv>
   (basketball/walkforward.js main() would rewrite the committed validation
   and live params).

   One change for the opener: basketball/walkforward.js predicts at tip − 30
   min, after absorbing earlier games of the same day. An opener is posted the
   day before or the morning of the game, so this pass predicts every game at
   09:00 UTC on its date (before any game of that date has finished) — the
   same rule as mlb/history. The pass is otherwise copied from
   basketball/walkforward.js pass() line for line.

     node research/clv/bb_predict.js <league> <out.csv> [tipoff]
   ("tipoff" keeps the original tip − 30 min timing, as a reproduction check)
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const W = require(path.join(ROOT, 'basketball', 'walkforward.js'));
const C = require(path.join(ROOT, 'basketball', 'config.js'));

const league = process.argv[2], OUT = process.argv[3];
const tuning = JSON.parse(fs.readFileSync(C.PATHS.tuning(league), 'utf8'));
const live = JSON.parse(fs.readFileSync(C.PATHS.params(league), 'utf8'));
const params = W.servedParams(league);
const { games } = W.load(league);
const { PointsRatings, Elo } = require(path.join(ROOT, 'basketball', 'model.js'));
const TIPOFF = process.argv[4] === 'tipoff';
function pass(games, params, eloParams) {
  const pr = new PointsRatings(params); const elo = new Elo(eloParams);
  const lastStart = new Map();
  const rows = []; let maxKnown = null;
  const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  const pending = []; let head = 0;
  const flush = (beforeMs) => {
    const batch = [];
    while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]);
    if (!batch.length) return;
    const nowDay = (beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5;
    pr.absorbDay(nowDay, batch);
    for (const g of batch) { elo.absorb(g); const k = Date.parse(g.assumed_available_at); if (maxKnown == null || k > maxKnown) maxKnown = k; }
  };
  for (const g of order) {
    const t = Date.parse(g.start_utc);
    const predAt = TIPOFF ? t - 30 * 60e3 : Math.min(t - 30 * 60e3, Date.parse(g.date + 'T09:00:00Z'));
    if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); elo.startSeason(g.season); }
    flush(predAt);
    const e = pr.expect(g.home_id, g.away_id, g.neutral);
    const b2b = (id) => { const l = lastStart.get(id); return l != null && t - l <= 30 * 3600e3 ? 1 : 0; };
    rows.push({ id: g.game_id, season: g.season, type: g.type, date: g.date, start: t, neutral: g.neutral, home: g.home_id, away: g.away_id,
      m: e.margin, t: e.total, gh: e.games_h, ga: e.games_a, x_rest: b2b(g.home_id) - b2b(g.away_id), elo: elo.prob(g.home_id, g.away_id, g.neutral),
      y: { hw: g.hs > g.as ? 1 : 0, margin: g.hs - g.as, total: g.hs + g.as }, predicted_at: predAt, inputs_known_at: maxKnown });
    lastStart.set(g.home_id, t); lastStart.set(g.away_id, t);
    pending.push(g);
  }
  flush(null);
  return { rows };
}
const { rows } = pass(games, params, tuning.elo);
const leaks = rows.filter((r) => r.inputs_known_at != null && r.inputs_known_at >= r.predicted_at).length;
if (leaks) throw new Error(leaks + ' rows use an input known after their prediction time');
const { scored } = W.score(rows);
const mk = live.model === 'points_rest' ? 'margin_rest' : 'margin';
const lines = ['game_id,season,date,start_utc,neutral,home_id,away_id,model_margin,model_total,p_home,margin,total_pts,predicted_at,inputs_known_at'];
for (const r of scored) {
  lines.push([r.id, r.season, r.date, new Date(r.start).toISOString(), r.neutral, r.home, r.away, r.p[mk].mu.toFixed(4), r.p.total.mu.toFixed(4),
    r.p[live.model].toFixed(5), r.y.margin, r.y.total, new Date(r.predicted_at).toISOString(),
    r.inputs_known_at == null ? '' : new Date(r.inputs_known_at).toISOString()].join(','));
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${league}: ${scored.length} games, model ${live.model} (${mk}), params ${JSON.stringify(params)}`);
