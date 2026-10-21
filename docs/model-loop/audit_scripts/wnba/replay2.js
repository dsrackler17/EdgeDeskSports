'use strict';
const R = '/home/user/EdgeDeskSports';
const fs = require('fs');
const M = require(R + '/basketball/model.js');
const WF = require(R + '/basketball/walkforward.js');
const V = require(R + '/engine/validation.js');
const P = require(R + '/engine/lab/protocol.js');
const tuning = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_tuning.json', 'utf8'));
const { games } = WF.load('wnba');

// Variant of WF.pass: ratings refreshed only at weekly boundaries (Wednesday 11:47 UTC, lab-validate.yml cron '47 11 * * 3')
function lastWed(ms) { const d = new Date(ms); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 47); while (new Date(t).getUTCDay() !== 3 || t > ms) t -= 864e5; return t; }
function passWeekly(games, params, eloParams) {
  const pr = new M.PointsRatings(params); const elo = new M.Elo(eloParams);
  const lastStart = new Map(); const rows = [];
  const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  const pending = []; let head = 0;
  const flush = (beforeMs) => { const batch = []; while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]); if (!batch.length) return; const nowDay = (beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5; pr.absorbDay(nowDay, batch); for (const g of batch) elo.absorb(g); };
  for (const g of order) {
    const t = Date.parse(g.start_utc); const predAt = t - 30 * 60e3;
    if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); elo.startSeason(g.season); }
    flush(g.season === 2026 ? lastWed(predAt) : predAt);
    const e = pr.expect(g.home_id, g.away_id, g.neutral);
    const b2b = (id) => { const l = lastStart.get(id); return l != null && t - l <= 30 * 3600e3 ? 1 : 0; };
    rows.push({ id: g.game_id, season: g.season, type: g.type, date: g.date, start: t, neutral: g.neutral, home: g.home_id, away: g.away_id, m: e.margin, t: e.total, gh: e.games_h, ga: e.games_a, x_rest: b2b(g.home_id) - b2b(g.away_id), elo: elo.prob(g.home_id, g.away_id, g.neutral), y: { hw: g.hs > g.as ? 1 : 0, margin: g.hs - g.as, total: g.hs + g.as } });
    lastStart.set(g.home_id, t); lastStart.set(g.away_id, t); pending.push(g);
  }
  flush(null); return rows;
}
const pit = WF.pass(games, tuning.chosen, tuning.elo).rows;
const calPit = WF.score(pit).cal;   // calibration from the point-in-time rows (production fits it this way)
const wk = passWeekly(games, tuning.chosen, tuning.elo);
const c26 = calPit[2026];
const metr = (rows) => { const s = rows.filter((r) => r.season === 2026); let ll = 0, br = 0, mae = 0, tm = 0; for (const r of s) { const p = WF.applyCal(r, c26); ll += V.logLoss(p.points, r.y.hw); br += Math.pow(p.points - r.y.hw, 2); mae += Math.abs(p.margin.mu - r.y.margin); tm += Math.abs(p.total.mu - r.y.total); } const n = s.length; return { n, ll: +(ll / n).toFixed(5), brier: +(br / n).toFixed(5), margin_mae: +(mae / n).toFixed(3), total_mae: +(tm / n).toFixed(3) }; };
console.log('point-in-time 2026', JSON.stringify(metr(pit)));
console.log('weekly-refresh 2026', JSON.stringify(metr(wk)));
// raw vs calibrated totals 2026
{ const s = pit.filter((r) => r.season === 2026); let a = 0, b = 0, ba = 0, bb = 0, ca = 0, cb = 0, cova=0, covb=0; const sdT = c26.sd_total;
  for (const r of s) { const cal = c26.total.a + c26.total.b * r.t; a += Math.abs(cal - r.y.total); b += Math.abs(r.t - r.y.total); ba += cal - r.y.total; bb += r.t - r.y.total; ca += P.crpsNormal(cal, sdT, r.y.total); cb += P.crpsNormal(r.t, sdT, r.y.total); if (Math.abs(r.y.total-cal)<=1.2816*sdT) cova++; if (Math.abs(r.y.total-r.t)<=1.2816*sdT) covb++; }
  const n = s.length; console.log('2026 totals: calibrated MAE ' + (a / n).toFixed(2) + ' bias ' + (ba / n).toFixed(2) + ' CRPS ' + (ca / n).toFixed(3) + ' cov80 ' + (cova/n).toFixed(3) + ' | raw MAE ' + (b / n).toFixed(2) + ' bias ' + (bb / n).toFixed(2) + ' CRPS ' + (cb / n).toFixed(3)+ ' cov80 ' + (covb/n).toFixed(3) + ' | sd_total ' + sdT.toFixed(2));
  // margin raw vs calibrated
  let ma=0, mb=0; for (const r of s) { const mu = c26.margin.a*(r.neutral?0:1) + c26.margin.b*r.m; ma += Math.abs(mu-r.y.margin); mb += Math.abs(r.m - r.y.margin); }
  console.log('2026 margins: calibrated MAE ' + (ma/n).toFixed(3) + ' raw MAE ' + (mb/n).toFixed(3));
}
// h at each season's end and observed home margin
{ const pr = new M.PointsRatings(tuning.chosen); let cur = null; const byS = {};
  const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : 1));
  for (const g of order) { if (cur !== g.season) { if (cur != null) byS[cur].h_end = pr.h; pr.startSeason(g.season); cur = g.season; byS[cur] = { h_start: pr.h, n: 0, sm: 0 }; }
    pr.absorbDay(Date.parse(g.assumed_available_at) / 864e5, [g]); if (!g.neutral) { byS[cur].n++; byS[cur].sm += g.hs - g.as; } }
  byS[cur].h_end = pr.h;
  for (const [s, v] of Object.entries(byS)) if (s >= 2016) console.log('season ' + s + ' h_start ' + v.h_start.toFixed(2) + ' h_end ' + v.h_end.toFixed(2) + ' observed home margin ' + (v.sm / v.n).toFixed(2) + ' n ' + v.n);
}
// expansion teams: Toronto 131935, Portland 132052 (2026), GSV 129689 (2025)
{ const s = pit.filter((r) => r.season === 2026 || r.season === 2025);
  for (const [id, yr] of [['131935', 2026], ['132052', 2026], ['129689', 2025]]) {
    const g = s.filter((r) => r.season === yr && (r.home === id || r.away === id)); const first = g.slice(0, 10);
    const c = calPit[yr];
    const err = first.map((r) => { const p = WF.applyCal(r, c); const sign = r.home === id ? 1 : -1; return sign * (p.margin.mu - r.y.margin); });
    console.log('expansion ' + id + ' ' + yr + ' first-10 mean (pred - actual, team perspective) ' + (err.reduce((a, b) => a + b, 0) / err.length).toFixed(2) + ' :: ' + err.map((x) => x.toFixed(1)).join(','));
  }
}
// 2026 postseason vs regular season total bias and home margin
{ const s = pit.filter((r) => r.season === 2026); for (const ty of ['R', 'P']) { const u = s.filter((r) => r.type === ty); let tb = 0, mb = 0, hm = 0; for (const r of u) { const p = WF.applyCal(r, c26); tb += p.total.mu - r.y.total; mb += p.margin.mu - r.y.margin; hm += r.y.margin; } console.log(ty + ' n ' + u.length + ' total bias ' + (tb / u.length).toFixed(2) + ' margin bias ' + (mb / u.length).toFixed(2) + ' observed home margin ' + (hm / u.length).toFixed(2)); } }
// historical postseason total bias (2018-2025) 
{ let tb=0,n=0,tr=0,nr=0; for (const r of pit) { if (r.season<2018||r.season>2025||!calPit[r.season]) continue; const p=WF.applyCal(r, calPit[r.season]); if (r.type==='P'){tb+=p.total.mu-r.y.total;n++;} else {tr+=p.total.mu-r.y.total;nr++;} } console.log('2018-2025 postseason total bias '+(tb/n).toFixed(2)+' n '+n+'; regular '+(tr/nr).toFixed(2)+' n '+nr); }
fs.writeFileSync(process.argv[2] + '/weekly_2026.json', JSON.stringify(wk.filter((r) => r.season === 2026)));
