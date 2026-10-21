'use strict';
/* Re-run the live NCAAM points-ratings engine (basketball/model.js + walkforward.js)
   on committed inputs, capturing every component of every prediction.
   Writes ONLY to the scratchpad. */
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/EdgeDeskSports';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const BW = require(REPO + '/basketball/walkforward.js');
const { PointsRatings, Elo } = require(REPO + '/basketball/model.js');
const tuning = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_tuning.json', 'utf8'));
const live = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_live.json', 'utf8'));
const teams = JSON.parse(fs.readFileSync(REPO + '/basketball/data/ncaam/teams.json', 'utf8'));

const { games } = BW.load('ncaam');
const params = tuning.chosen;
const pr = new PointsRatings(params); const elo = new Elo(tuning.elo);
const lastStart = new Map();
const rows = [];
const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
const pending = []; let head = 0; let lastRefitDay = null;
const flush = (beforeMs) => {
  const batch = [];
  while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]);
  if (!batch.length) return;
  const nowDay = (beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5;
  pr.absorbDay(nowDay, batch); lastRefitDay = nowDay;
  for (const g of batch) elo.absorb(g);
};
/* prior share of a team's rating at the last refit: k/(sw+k), sw = decayed weights aged to the refit day */
function priorShare(id) {
  const t = pr.team.get(id); if (!t || !t.idx.length) return { share: 1, sw: 0 };
  const lam = Math.LN2 / pr.p.half_life_days; let sw = 0;
  for (const i of t.idx) sw += Math.exp(-lam * (lastRefitDay - pr.games[i].day));
  return { share: pr.p.prior_games / (sw + pr.p.prior_games), sw };
}
let seasonStartRatings = null;
for (const g of order) {
  const t = Date.parse(g.start_utc); const predAt = t - 30 * 60e3;
  if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); elo.startSeason(g.season); lastRefitDay = null; }
  flush(predAt);
  const e = pr.expect(g.home_id, g.away_id, g.neutral);
  const b2b = (id) => { const l = lastStart.get(id); return l != null && t - l <= 30 * 3600e3 ? 1 : 0; };
  if (g.season >= 2023) {
    const H = pr.T(g.home_id), A = pr.T(g.away_id);
    const sh = priorShare(g.home_id), sa = priorShare(g.away_id);
    rows.push({ id: g.game_id, season: g.season, type: g.type, date: g.date, start: g.start_utc, neutral: g.neutral, home: g.home_id, away: g.away_id,
      hn: teams[g.home_id] || g.home_id, an: teams[g.away_id] || g.away_id,
      mu: pr.mu, h: pr.h, Ho: H.o, Hd: H.d, Ao: A.o, Ad: A.d, Hpo: H.po, Hpd: H.pd, Apo: A.po, Apd: A.pd,
      Hshare: sh.share, Ashare: sa.share, gh: e.games_h, ga: e.games_a,
      m: e.margin, t: e.total, x_rest: b2b(g.home_id) - b2b(g.away_id), b2bh: b2b(g.home_id), b2ba: b2b(g.away_id), elo: elo.prob(g.home_id, g.away_id, g.neutral),
      y: { hw: g.hs > g.as ? 1 : 0, margin: g.hs - g.as, total: g.hs + g.as }, hs: g.hs, as: g.as });
  }
  lastStart.set(g.home_id, t); lastStart.set(g.away_id, t);
  pending.push(g);
}
flush(null);
/* reproduce the live params: carry into 2027 */
pr.startSeason(2027);
const dump = pr.dump();
let maxd = 0, n = 0;
for (const [id, v] of Object.entries(live.ratings.teams)) { const d = dump.teams[id]; if (!d) continue; n++; maxd = Math.max(maxd, Math.abs(d.o - v.o), Math.abs(d.d - v.d)); }
console.log('reproduce live params: mu', dump.mu, 'vs', live.ratings.mu, '| h', dump.h, 'vs', live.ratings.h, '| teams compared', n, 'max |diff|', maxd.toFixed(4));

/* calibration per season exactly as walkforward.score(): fitted on the 3 prior seasons' OOS rows.
   score() needs rows from 2020 onward for 2023+; re-run the stock pass for calibration inputs. */
const stock = BW.pass(games, tuning.chosen, tuning.elo).rows;
const cal = {};
for (const s of [2023, 2024, 2025, 2026]) cal[s] = BW.calibrate(stock.filter((r) => r.season >= s - 3 && r.season < s));
const sig = (z) => 1 / (1 + Math.exp(-z));
for (const r of rows) {
  const c = cal[r.season]; const on = BW.interceptOn(c, r.neutral);
  r.cal = { a: c.margin.a, b: c.margin.b, w0: c.win[0], w1: c.win[1], ta: c.total.a, tb: c.total.b, sd: c.sd_margin, sdt: c.sd_total };
  r.on = on;
  r.mu_c = c.margin.a * on + c.margin.b * r.m;
  r.p = sig(c.win[0] * on + c.win[1] * r.m);
  r.t_c = c.total.a + c.total.b * r.t;
}
fs.writeFileSync(path.join(OUT, 'incumbent_rows.json'), JSON.stringify({ cal, rows }));
console.log('rows', rows.length, 'cal 2026', JSON.stringify(cal[2026]));
