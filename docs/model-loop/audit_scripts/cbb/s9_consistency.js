'use strict';
const REPO = '/home/user/EdgeDeskSports';
const fs = require('fs');
const BS = require(REPO + '/basketball/build_slate.js');
const P = require(REPO + '/engine/lab/protocol');
const I = JSON.parse(fs.readFileSync(__dirname + '/out/incumbent_rows.json', 'utf8'));
const rows = I.rows.filter((r) => r.season === 2026);
let maxPdiff = 0, maxPdiffRow = null, sumAbs = 0, maxCenter = 0, maxRound = 0, maxImpliedGap = 0, gapRow = null;
const buckets = {};
for (const r of rows) {
  const c = r.cal; const on = r.on;
  const mu = c.a * on + c.b * r.m; const p = r.p;
  // normal margin P(home wins): P(X >= 1) + half the P(X = 0) tie that goes to OT
  const o0 = BS.overUnder(mu, c.sd, 0); const pN = o0.over + o0.push / 2;
  const d = p - pN; sumAbs += Math.abs(d);
  if (Math.abs(d) > Math.abs(maxPdiff)) { maxPdiff = d; maxPdiffRow = { id: r.id, mu: +mu.toFixed(2), p: +p.toFixed(4), pN: +pN.toFixed(4) }; }
  const b = Math.min(30, Math.floor(Math.abs(mu) / 5) * 5); (buckets[b] = buckets[b] || []).push(d * Math.sign(mu || 1));
  const fs_ = -Math.round(mu * 2) / 2; const oc = BS.overUnder(mu, c.sd, -fs_);
  maxCenter = Math.max(maxCenter, Math.abs(oc.over - oc.under));
  maxRound = Math.max(maxRound, Math.abs(-fs_ - mu));
  // spread implied by the logistic win prob through the card's own normal: mu* with Phi(mu*/sd) = p
  let lo = -80, hi = 80; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (P.Phi(m / c.sd) < p) lo = m; else hi = m; }
  const g = lo - mu; if (p > 0.1 && p < 0.9 && Math.abs(g) > Math.abs(maxImpliedGap)) { maxImpliedGap = g; gapRow = { id: r.id, mu: +mu.toFixed(2), p: +p.toFixed(4), implied_mu: +lo.toFixed(2) }; }
}
console.log('2026 games', rows.length);
console.log('ML prob (logistic) minus P(home wins) from the card\'s own normal margin: mean |d| %s, max %s', (sumAbs / rows.length).toFixed(4), maxPdiff.toFixed(4), JSON.stringify(maxPdiffRow));
for (const [k, v] of Object.entries(buckets).sort((a, b) => a[0] - b[0])) console.log('   |mu| in [%s,%s): n %d mean signed (favourite-side) diff %s', k, +k + 5, v.length, (v.reduce((a, x) => a + x, 0) / v.length).toFixed(4));
console.log('margin implied by the ML prob vs projected margin: max gap %s pts', maxImpliedGap.toFixed(2), JSON.stringify(gapRow));
console.log('spread ladder centring: max |P(home covers fair line) - P(away covers)| = %s', maxCenter.toFixed(4));
console.log('fair line rounding vs projected margin: max %s pts', maxRound.toFixed(3));
