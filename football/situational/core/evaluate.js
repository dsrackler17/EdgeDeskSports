/* ============================================================================
   FSIE — evaluation: point metrics, interval coverage, paired comparisons.

   Paired comparisons are on the SAME team-games. Uncertainty is a bootstrap
   over GAMES (both teams of a game resampled together — the two rows of one
   game are not independent), and a sign-flip permutation test on the
   per-game mean of absolute-error differences. Both use seeded PRNGs, so a
   report rebuilt from the same predictions is byte-identical.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));

function pointMetrics(pairs) {
  /* pairs: [{y, yhat}] */
  const e = pairs.filter((p) => U.isNum(p.y) && U.isNum(p.yhat)).map((p) => p.yhat - p.y);
  if (!e.length) return { n: 0, mae: null, rmse: null, bias: null };
  return { n: e.length, mae: U.round(U.mean(e.map(Math.abs)), 3), rmse: U.round(Math.sqrt(U.mean(e.map((x) => x * x))), 3), bias: U.round(U.mean(e), 3) };
}
function coverage(rows) {
  /* rows: [{y, p10, p90}] */
  const r = rows.filter((x) => U.isNum(x.y) && U.isNum(x.p10) && U.isNum(x.p90));
  if (!r.length) return { n: 0 };
  const inside = r.filter((x) => x.y >= x.p10 && x.y <= x.p90).length;
  const below = r.filter((x) => x.y < x.p10).length, above = r.filter((x) => x.y > x.p90).length;
  return { n: r.length, p10_p90: U.round(inside / r.length, 4), below_p10: U.round(below / r.length, 4), above_p90: U.round(above / r.length, 4), target: 0.8,
    mean_width: U.round(U.mean(r.map((x) => x.p90 - x.p10)), 2) };
}

/* paired comparison of model A vs model B on the same rows.
   rows: [{game_id, y, a, b}]  -> mae difference (A - B; negative = A better) */
function paired(rows, opts) {
  opts = opts || {};
  const ok = rows.filter((r) => U.isNum(r.y) && U.isNum(r.a) && U.isNum(r.b));
  if (ok.length < 10) return { n: ok.length, mae_diff: null };
  const byGame = new Map();
  ok.forEach((r) => { const d = Math.abs(r.a - r.y) - Math.abs(r.b - r.y); const g = byGame.get(r.game_id) || { s: 0, n: 0 }; g.s += d; g.n++; byGame.set(r.game_id, g); });
  const games = Array.from(byGame.values());
  const diff = games.reduce((s, g) => s + g.s, 0) / ok.length;
  const u = U.rng(opts.seed || 'fsie-eval');
  const B = opts.boot || 1000; const boots = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let i = 0; i < games.length; i++) { const g = games[Math.floor(u() * games.length)]; s += g.s; n += g.n; } boots.push(s / n); }
  boots.sort((x, y) => x - y);
  /* sign-flip permutation on per-game mean differences */
  const means = games.map((g) => g.s / g.n); const obs = Math.abs(U.mean(means)); let ext = 0; const P = opts.perm || 2000;
  for (let p = 0; p < P; p++) { let s = 0; for (const m of means) s += u() < 0.5 ? m : -m; if (Math.abs(s / means.length) >= obs - 1e-12) ext++; }
  const maeA = U.mean(ok.map((r) => Math.abs(r.a - r.y))), maeB = U.mean(ok.map((r) => Math.abs(r.b - r.y)));
  return { n: ok.length, games: games.length, mae_a: U.round(maeA, 3), mae_b: U.round(maeB, 3), mae_diff: U.round(diff, 4),
    pct_change: U.round(100 * diff / maeB, 2), ci95: [U.round(U.quantile(boots, 0.025), 4), U.round(U.quantile(boots, 0.975), 4)],
    p_value: U.round((ext + 1) / (P + 1), 4) };
}

function groupBy(rows, keyFn) { const m = {}; rows.forEach((r) => { const k = keyFn(r); if (k == null) return; (m[k] = m[k] || []).push(r); }); return m; }
function favBucket(m) { if (!U.isNum(m)) return 'no_line'; if (m >= 2.5) return 'favorite'; if (m <= -2.5) return 'underdog'; return 'pick'; }
function scriptBucket(m) { if (!U.isNum(m)) return 'no_line'; const a = Math.abs(m); return a < 3 ? 'close_<3' : a < 7 ? 'mid_3_7' : a < 14 ? 'wide_7_14' : 'lopsided_14+'; }

module.exports = { pointMetrics, coverage, paired, groupBy, favBucket, scriptBucket };
