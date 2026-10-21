const { readCsv } = require('/home/user/EdgeDeskSports/engine/csv');
const rows = readCsv('/home/user/EdgeDeskSports/datapack/quant_v1/data/ufc/bouts_2024.csv').rows
  .sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a.bout_id < b.bout_id ? -1 : 1));
const K = 32, r = new Map(), seen = new Map(), hist = new Map(), scored = [];
const H = (id) => hist.get(id) || [];
for (const b of rows) {
  if (b.status !== 'STATUS_FINAL') continue;
  const aw = b.a_winner === 'True', bw = b.b_winner === 'True';
  if (aw === bw) continue;
  const ra = r.get(b.fighter_a_id) || 1500, rb = r.get(b.fighter_b_id) || 1500;
  const e = 1 / (1 + Math.pow(10, -(ra - rb) / 400));
  if (seen.get(b.fighter_a_id) && seen.get(b.fighter_b_id))
    scored.push({ b, ra, rb, p: e, y: aw ? 1 : 0, ha: H(b.fighter_a_id).slice(), hb: H(b.fighter_b_id).slice() });
  const da = K * ((aw ? 1 : 0) - e);
  hist.set(b.fighter_a_id, H(b.fighter_a_id).concat([{ d: b.start_time.slice(0,10), opp: b.fighter_b, res: aw ? 'W' : 'L', e: +e.toFixed(4), delta: +da.toFixed(2) }]));
  hist.set(b.fighter_b_id, H(b.fighter_b_id).concat([{ d: b.start_time.slice(0,10), opp: b.fighter_a, res: aw ? 'L' : 'W', e: +(1-e).toFixed(4), delta: +(-da).toFixed(2) }]));
  r.set(b.fighter_a_id, ra + da); r.set(b.fighter_b_id, rb - da);
  seen.set(b.fighter_a_id, true); seen.set(b.fighter_b_id, true);
}
scored.sort((x, y) => Math.abs(y.p - 0.5) - Math.abs(x.p - 0.5));
for (const s of scored.slice(0, 3)) {
  const ll = -(s.y ? Math.log(s.p) : Math.log(1 - s.p));
  console.log(JSON.stringify({ date: s.b.start_time, event: s.b.event_name, a: s.b.fighter_a, b: s.b.fighter_b, a_winner: s.b.a_winner, ra: +s.ra.toFixed(2), rb: +s.rb.toFixed(2), diff: +(s.ra - s.rb).toFixed(2), p_a: +s.p.toFixed(4), y: s.y, residual: +(s.y - s.p).toFixed(4), logloss: +ll.toFixed(4), hist_a: s.ha, hist_b: s.hb }, null, 0));
}
// distribution of |p-0.5|
const bins = [0.02, 0.04, 0.06, 0.08];
console.log('abs(p-.5) quantiles', [0.5, 0.9, 1].map(q => { const v = scored.map(s => Math.abs(s.p - 0.5)).sort((a, b) => a - b); return +v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))].toFixed(4); }));
