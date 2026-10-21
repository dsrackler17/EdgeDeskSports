const { run } = require('/home/user/EdgeDeskSports/engine/lab/ufc_elo.js');
const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));
for (const k of [16, 24, 32, 48, 64]) {
  const { stats, scored } = run(k);
  const n = scored.length, ybar = scored.reduce((s, x) => s + x.y, 0) / n;
  const m = scored.reduce((s, x) => s + ll(x.p, x.y), 0) / n;
  const coin = Math.log(2);
  const base = scored.reduce((s, x) => s + ll(ybar, x.y), 0) / n;
  const brier = scored.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const pmin = Math.min(...scored.map(x => x.p)), pmax = Math.max(...scored.map(x => x.p));
  const acc = scored.filter(x => (x.p > 0.5) === (x.y === 1)).length / n;
  console.log(JSON.stringify({ k, n, a_win_rate_scored: +ybar.toFixed(3), elo_ll: +m.toFixed(5), coin_ll: +coin.toFixed(5), baserate_ll_insample: +base.toFixed(5), brier: +brier.toFixed(5), acc: +acc.toFixed(3), p_range: [+pmin.toFixed(3), +pmax.toFixed(3)] }));
}
