'use strict';
/* Production cadence: the card's ratings (basketball/params/ncaam_live.json) are
   rewritten only by the weekly lab-validate job (Wednesday 11:47 UTC); the daily
   lab-build only re-prices from them. Price every 2025-26 game with the ratings of
   the last Wednesday refresh before it vs the point-in-time ratings. */
const fs = require('fs');
const REPO = '/home/user/EdgeDeskSports';
const BW = require(REPO + '/basketball/walkforward.js');
const { PointsRatings } = require(REPO + '/basketball/model.js');
const tuning = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_tuning.json', 'utf8'));
const I = JSON.parse(fs.readFileSync(__dirname + '/out/incumbent_rows.json', 'utf8'));
const cal = I.cal['2026'];
const d1 = new Set(); for (const r of JSON.parse(fs.readFileSync(__dirname + '/out/research_rows.json', 'utf8'))) d1.add(r.id);
const { games } = BW.load('ncaam');
const pr = new PointsRatings(tuning.chosen);
const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
const pending = []; let head = 0;
const flush = (beforeMs) => { const batch = []; while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]); if (!batch.length) return; pr.absorbDay((beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5, batch); };
const lastWed = (ms) => { const d = new Date(ms); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 47); while (new Date(t).getUTCDay() !== 3 || t > ms) t -= 864e5; return t; };
let snap = null, snapAt = null; const out = [];
const price = (S, g) => { const T = (id) => S.teams[id] || { o: 0, d: 0 }; const H = T(g.home_id), A = T(g.away_id); const m = (g.neutral ? 0 : S.h) + H.o + H.d - A.o - A.d; const on = g.neutral ? 0 : 1; return cal.margin.a * on + cal.margin.b * m; };
for (const g of order) {
  const t = Date.parse(g.start_utc);
  if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); snap = null; }
  if (g.season === 2026) {
    const w = lastWed(t);
    if (snapAt !== w) {
      // the weekly job: every game known by Wednesday 11:47 absorbed
      flush(w); const s = { h: pr.h, teams: {} }; for (const [id, v] of pr.team) s.teams[id] = { o: v.o, d: v.d }; snap = s; snapAt = w;
    }
  }
  flush(t - 30 * 60e3);
  if (g.season === 2026 && d1.has(g.game_id)) {
    const now = { h: pr.h, teams: {} }; for (const id of [g.home_id, g.away_id]) { const v = pr.T(id); now.teams[id] = { o: v.o, d: v.d }; }
    out.push({ id: g.game_id, date: g.date, pit: price(now, g), stale: price(snap, g), y: g.hs - g.as, age_days: (t - snapAt) / 864e5 });
  }
  pending.push(g);
  if (g.season > 2026) break;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const by = {};
for (const r of out) (by[r.date.slice(0, 7)] = by[r.date.slice(0, 7)] || []).push(r);
console.log('D1-v-D1 2025-26 games', out.length, '| mean age of ratings at tip', mean(out.map((r) => r.age_days)).toFixed(2), 'days');
console.log('MAE vs result: point-in-time %s | weekly-refreshed (production cadence) %s | mean |difference| %s, max %s', mean(out.map((r) => Math.abs(r.y - r.pit))).toFixed(3), mean(out.map((r) => Math.abs(r.y - r.stale))).toFixed(3), mean(out.map((r) => Math.abs(r.pit - r.stale))).toFixed(2), Math.max(...out.map((r) => Math.abs(r.pit - r.stale))).toFixed(2));
for (const [k, v] of Object.entries(by).sort()) console.log('  %s n %d MAE pit %s weekly %s mean|diff| %s', k, v.length, mean(v.map((r) => Math.abs(r.y - r.pit))).toFixed(2), mean(v.map((r) => Math.abs(r.y - r.stale))).toFixed(2), mean(v.map((r) => Math.abs(r.pit - r.stale))).toFixed(2));
