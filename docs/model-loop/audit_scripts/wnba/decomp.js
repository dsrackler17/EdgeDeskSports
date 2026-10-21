'use strict';
const R = '/home/user/EdgeDeskSports';
const fs = require('fs');
const M = require(R + '/basketball/model.js');
const WF = require(R + '/basketball/walkforward.js');
const BS = require(R + '/basketball/build_slate.js');
const S = require(R + '/engine/stats.js');
const tuning = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_tuning.json', 'utf8'));
const live = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_live.json', 'utf8'));
const teams = JSON.parse(fs.readFileSync(R + '/basketball/data/wnba/teams.json', 'utf8'));
const OUT = process.argv[2];
const { games } = WF.load('wnba');

// patch: remember refit day, and capture full state at expect()
const origRefit = M.PointsRatings.prototype.refit;
M.PointsRatings.prototype.refit = function (day) { this._day = day; return origRefit.call(this, day); };
function swOf(pr, t) { const lam = Math.LN2 / pr.p.half_life_days; let s = 0; for (const i of t.idx) s += Math.exp(-lam * (pr._day - pr.games[i].day)); return s; }
function state(pr, h, a) { const H = pr.T(h), A = pr.T(a); return { mu: pr.mu, h: pr.h, P: pr.p.prior_games, H: { o: H.o, d: H.d, po: H.po, pd: H.pd, n: H.idx.length, sw: swOf(pr, H) }, A: { o: A.o, d: A.d, po: A.po, pd: A.pd, n: A.idx.length, sw: swOf(pr, A) } }; }
const caps = new Map();
const origExpect = M.PointsRatings.prototype.expect;
let curGame = null;
M.PointsRatings.prototype.expect = function (h, a, n) { const e = origExpect.call(this, h, a, n); if (curGame) caps.set(curGame, state(this, h, a)); return e; };

// full point-in-time pass capturing state per game (expect is called in order of `order`)
const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
let k = 0; const ids = order.map((g) => g.game_id);
M.PointsRatings.prototype.expect = function (h, a, n) { const e = origExpect.call(this, h, a, n); caps.set(ids[k++], state(this, h, a)); return e; };
const full = WF.pass(games, tuning.chosen, tuning.elo);
const { cal } = WF.score(full.rows);
const pitById = new Map(full.rows.map((r) => [r.id, r]));

// card reconstruction at a data cutoff (games with date <= cutoff), as walkforward main() does
function v1Calibrate(prior) { // pre-v2: one intercept pooled over home+neutral and applied everywhere
  const lg = S.logistic(prior.map((r) => [1, r.m]), prior.map((r) => r.y.hw), { l2: 1e-6 });
  const n = prior.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const r of prior) { sx += r.m; sy += r.y.margin; sxx += r.m * r.m; sxy += r.m * r.y.margin; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); const mm = { a: (sy - b * sx) / n, b };
  const c2 = WF.calibrate(prior); let sm = 0; for (const r of prior) sm += Math.pow(r.y.margin - (mm.a + mm.b * r.m), 2);
  return Object.assign({}, c2, { version: 'v1', intercept: 'all', win: lg.beta, margin: mm, sd_margin: Math.sqrt(sm / n) });
}
function cardAt(cutoff, v1) {
  k = 0; const sub = games.filter((g) => g.date <= cutoff); const o2 = sub.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  const ids2 = o2.map((g) => g.game_id);
  M.PointsRatings.prototype.expect = function (h, a, n) { const e = origExpect.call(this, h, a, n); k++; return e; };
  const r = WF.pass(sub, tuning.chosen, tuning.elo);
  const prior = r.rows.filter((x) => x.season >= 2023 && x.season < 2026);
  const c = v1 ? v1Calibrate(prior) : WF.calibrate(prior);
  return { pr: r.ratings, elo: r.elo, cal: c };
}
function liveFromPr(pr, c) { const d = pr.dump(); return { model: 'points', ratings: d, calibration: c, params: tuning.chosen }; }

function decompose(st, c, neutral, label) {
  const on = c.intercept === 'home_games_only' ? (neutral ? 0 : 1) : 1;
  const hh = neutral ? 0 : st.h;
  const homeNet = st.H.o + st.H.d, awayNet = st.A.o + st.A.d;
  const m = hh + homeNet - awayNet;
  const t = 2 * st.mu + st.H.o - st.A.d + st.A.o - st.H.d;
  const ph = st.mu + hh / 2 + st.H.o - st.A.d, pa = st.mu - hh / 2 + st.A.o - st.H.d;
  const a = c.margin.a, b = c.margin.b;
  const mu = a * on + b * m;
  const tmu = c.total.a + c.total.b * t;
  const pw = 1 / (1 + Math.exp(-(c.win[0] * on + c.win[1] * m)));
  // prior parts: o = (so + P po)/(sw + P) => prior part = P*po/(sw+P)
  const pp = (T) => ({ share: st.P / (T.sw + st.P), o_prior: st.P * T.po / (T.sw + st.P), d_prior: st.P * T.pd / (T.sw + st.P) });
  const Hp = pp(st.H), Ap = pp(st.A);
  const priorNetMargin = (Hp.o_prior + Hp.d_prior) - (Ap.o_prior + Ap.d_prior);
  return { label, raw: { mu: st.mu, h: hh, ph, pa, m, t, H: st.H, A: st.A, homeNet, awayNet }, cal: { a: a * on, b, mu, fair_line: -Math.round(mu * 2) / 2, tmu, ta: c.total.a, tb: c.total.b, fair_total: Math.round(tmu * 2) / 2, pw, sd: c.sd_margin, sdT: c.sd_total, win: c.win },
    comp_margin: { intercept: a * on, hca: b * hh, home_team: b * homeNet, away_team: -b * awayNet, sum: a * on + b * hh + b * homeNet - b * awayNet },
    prior: { H: Hp, A: Ap, prior_net_margin_raw: priorNetMargin, prior_net_margin_card: b * priorNetMargin } };
}
const out = { cards: [], wf: [] };
// Published cards
const cardDefs = [
  { id: '401918305', cutoff: '2026-10-09', v1: true, ledger: { p: 0.5577, line: -2, total: 160.5, exp: 160.7, margin: 2.1 } },
  { id: '401918306', cutoff: '2026-10-17', v1: false, ledger: { p: 0.5611, line: -2, total: 160, exp: 159.9, margin: 2.2 } },
  { id: '401918307', cutoff: '2026-10-17', v1: false, ledger: { p: 0.5715, line: -2.5, total: 160, exp: 159.9, margin: 2.5 } },
];
const all = require(R + '/basketball/ingest.js').loadGames('wnba', [2026]);
for (const cd of cardDefs) {
  const g = all.find((x) => x.game_id === cd.id);
  const A = cardAt(cd.cutoff, cd.v1);
  const st = state(A.pr, g.home_id, g.away_id);
  const dec = decompose(st, A.cal, !!g.neutral, cd.id);
  const lv = liveFromPr(A.pr, A.cal);
  const slate = BS.priceGame(g, lv, () => null);
  const eloP = A.elo.prob(g.home_id, g.away_id, g.neutral);
  out.cards.push({ id: cd.id, date: g.date, home: teams[g.home_id], away: teams[g.away_id], final: g.status === 'FINAL' ? [g.hs, g.as] : null, ledger: cd.ledger, repro: { p: slate.p_home, line: slate.fairSpread, margin: slate.margin, total: slate.total, fairTotal: slate.fairTotal }, dec, elo_p: eloP, cal_version: cd.v1 ? 'v1(pooled)' : 'v2' });
}
// "fresh" G3: ratings including G2 (all finals through 10-19)
{ const g = all.find((x) => x.game_id === '401918307'); const A = cardAt('2026-10-19', false); const st = state(A.pr, g.home_id, g.away_id); out.g3_fresh = decompose(st, A.cal, false, 'G3 with G2 absorbed'); out.g3_fresh_elo = A.elo.prob(g.home_id, g.away_id, false); }
// walk-forward top disagreements vs Elo
for (const id of ['401857200', '401857216', '401857202']) {
  const r = pitById.get(id); const st = caps.get(id); const c = cal[r.season];
  const dec = decompose(st, c, !!r.neutral, id);
  out.wf.push({ id, date: r.date, home: teams[r.home], away: teams[r.away], y: r.y, elo_p: r.elo, check_m: [r.m, dec.raw.m], dec });
}
fs.writeFileSync(OUT + '/decomp.json', JSON.stringify(out, null, 1));
for (const c of out.cards) console.log(c.id, c.home, 'v', c.away, 'ledger', JSON.stringify(c.ledger), 'repro', JSON.stringify(c.repro), 'elo', c.elo_p.toFixed(4));
for (const w of out.wf) console.log(w.id, 'check m', w.check_m);
console.log('G3 fresh', JSON.stringify(out.g3_fresh.cal), 'elo', out.g3_fresh_elo);
