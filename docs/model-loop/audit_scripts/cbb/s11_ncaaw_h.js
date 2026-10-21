'use strict';
const REPO = '/home/user/EdgeDeskSports';
const fs = require('fs');
const BW = require(REPO + '/basketball/walkforward.js');
const { PointsRatings } = require(REPO + '/basketball/model.js');
const lg = process.argv[2] || 'ncaaw';
const tuning = JSON.parse(fs.readFileSync(REPO + '/basketball/params/' + lg + '_tuning.json', 'utf8'));
const { games } = BW.load(lg);
const pr = new PointsRatings(tuning.chosen);
const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1));
const pending = []; let head = 0; const by = {};
const flush = (beforeMs) => { const batch = []; while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]); if (!batch.length) return; pr.absorbDay((beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5, batch); };
for (const g of order) {
  const t = Date.parse(g.start_utc);
  if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); }
  flush(t - 30 * 60e3);
  if (g.season === 2026) { const k = g.date.slice(0, 7); (by[k] = by[k] || []).push(pr.h); }
  pending.push(g);
}
for (const [k, v] of Object.entries(by).sort()) console.log(lg, k, v.length, 'h mean', (v.reduce((a, x) => a + x, 0) / v.length).toFixed(2), 'max', Math.max(...v).toFixed(2));
