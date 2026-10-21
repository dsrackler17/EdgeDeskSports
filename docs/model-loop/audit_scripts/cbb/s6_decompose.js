'use strict';
/* Full decomposition of chosen games under the live NCAAM engine, plus the card
   (basketball/build_slate.js priceGame) re-run on the reconstructed state.
   Writes only to the scratchpad. */
const fs = require('fs');
const path = require('path');
const REPO = '/home/user/EdgeDeskSports';
const OUT = path.join(__dirname, 'out');
const BW = require(REPO + '/basketball/walkforward.js');
const BS = require(REPO + '/basketball/build_slate.js');
const { PointsRatings } = require(REPO + '/basketball/model.js');
const tuning = JSON.parse(fs.readFileSync(REPO + '/basketball/params/ncaam_tuning.json', 'utf8'));
const teams = JSON.parse(fs.readFileSync(REPO + '/basketball/data/ncaam/teams.json', 'utf8'));
const inc = JSON.parse(fs.readFileSync(path.join(OUT, 'incumbent_rows.json'), 'utf8'));
const TARGETS = new Set(process.argv.slice(2));
const { games } = BW.load('ncaam');
const seasonCount = new Map();
for (const g of games) if (g.season === 2026) for (const id of [g.home_id, g.away_id]) seasonCount.set(id, (seasonCount.get(id) || 0) + 1);
const pr = new PointsRatings(tuning.chosen);
const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
const pending = []; let head = 0; let lastDay = null; const starts = new Map();
const flush = (beforeMs) => {
  const batch = [];
  while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]);
  if (!batch.length) return;
  const nowDay = (beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5;
  pr.absorbDay(nowDay, batch); lastDay = nowDay;
};
const out = {};
function teamDetail(id) {
  const t = pr.team.get(id); const P = pr.p; const lam = Math.LN2 / P.half_life_days;
  let sw = 0; const gl = [];
  for (const i of t.idx) {
    const g = pr.games[i]; const w = Math.exp(-lam * (lastDay - g.day)); sw += w;
    const isH = g.h === id; const opp = isH ? g.a : g.h; const O = pr.team.get(opp); const hh = g.n ? 0 : pr.h / 2;
    const ro = isH ? g.yh - pr.mu - hh + O.d : g.ya - pr.mu + hh + O.d;
    const rd = isH ? pr.mu - hh + O.o - g.ya : pr.mu + hh + O.o - g.yh;
    gl.push({ opp, opp_name: teams[opp] || opp, opp_games_in_season: seasonCount.get(opp) || 0, venue: g.n ? 'N' : isH ? 'H' : 'A', score: isH ? g.yh + '-' + g.ya : g.ya + '-' + g.yh,
      margin: isH ? g.yh - g.ya : g.ya - g.yh, opp_net: O.o + O.d, w, net_resid: ro + rd });
  }
  const k = P.prior_games; const share = k / (sw + k);
  for (const x of gl) x.contrib_net = x.w * x.net_resid / (sw + k);
  const sumContrib = gl.reduce((a, x) => a + x.contrib_net, 0);
  return { id, name: teams[id] || id, o: t.o, d: t.d, net: t.o + t.d, po: t.po, pd: t.pd, prior_net: t.po + t.pd, last_season_net: (t.po + t.pd) / P.carry, share, sw,
    prior_part: share * (t.po + t.pd), data_part: t.o + t.d - share * (t.po + t.pd), data_part_recomputed_from_games: sumContrib, games: gl };
}
for (const g of order) {
  const t = Date.parse(g.start_utc); const predAt = t - 30 * 60e3;
  if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); lastDay = null; }
  flush(predAt);
  if (TARGETS.has(g.game_id)) {
    const H = teamDetail(g.home_id), A = teamDetail(g.away_id);
    const cal = inc.cal[g.season];
    /* the card exactly as build_slate.js priceGame computes it, from this state */
    const liveLike = { model: 'points', ratings: { mu: pr.mu, h: pr.h, teams: { [g.home_id]: { o: H.o, d: H.d, games: H.games.length }, [g.away_id]: { o: A.o, d: A.d, games: A.games.length } } }, calibration: cal };
    const lastStart = (id, tt) => { const v = starts.get(id); return v != null && v < tt ? v : null; };
    const card = BS.priceGame(g, liveLike, lastStart);
    out[g.game_id] = { game: g, mu: pr.mu, h: pr.h, cal: { a: cal.margin.a, b: cal.margin.b, w0: cal.win[0], w1: cal.win[1], ta: cal.total.a, tb: cal.total.b, sd: cal.sd_margin, sdt: cal.sd_total, rest_points: cal.rest_points }, home: H, away: A, card };
  }
  starts.set(g.home_id, t); starts.set(g.away_id, t);
  pending.push(g);
  if (g.season > 2026) break;
}
fs.writeFileSync(path.join(OUT, 'decomp.json'), JSON.stringify(out, null, 1));
console.log('decomposed', Object.keys(out).length);
