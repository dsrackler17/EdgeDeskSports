'use strict';
const REPO = '/home/user/EdgeDeskSports';
const fs = require('fs');
const BS = require(REPO + '/basketball/build_slate.js');
const live = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_live.json', 'utf8'));
const u = JSON.parse(fs.readFileSync(REPO + '/basketball/ncaam_research/published/upcoming.json', 'utf8'));
const d = [];
for (const g of u.games) {
  if (g.regime !== 'D1_D1') continue;
  const p = BS.priceGame({ home_id: String(g.home), away_id: String(g.away), neutral: g.neutral ? 1 : 0, start_utc: g.start_utc }, live, () => null);
  d.push({ g, inc: p.margin, res: g.projection.margin_home, diff: p.margin - g.projection.margin_home, hca: g.neutral ? 0 : live.calibration.margin.a + live.calibration.margin.b * live.ratings.h });
}
const ad = d.map((x) => Math.abs(x.diff)).sort((a, b) => a - b);
console.log('D1 openers', d.length, 'mean diff (inc - research) %s, MAE %s, p90 %s, max %s', (d.reduce((a, x) => a + x.diff, 0) / d.length).toFixed(2), (ad.reduce((a, x) => a + x, 0) / d.length).toFixed(2), ad[Math.floor(0.9 * ad.length)].toFixed(2), ad[ad.length - 1].toFixed(2));
console.log('live HCA component at season open = a + b*h = %s + %s*%s = %s', live.calibration.margin.a.toFixed(3), live.calibration.margin.b.toFixed(4), live.ratings.h, (live.calibration.margin.a + live.calibration.margin.b * live.ratings.h).toFixed(2));
d.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
for (const x of d.slice(0, 5)) console.log('  ', x.g.start_utc.slice(0, 10), x.g.home_name, 'v', x.g.away_name, 'neu', x.g.neutral, 'live card %s research %s', x.inc.toFixed(1), x.res.toFixed(1));
