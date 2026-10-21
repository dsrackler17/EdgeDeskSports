'use strict';
// READ-ONLY replay of the WNBA engine on committed inputs. Writes only to scratchpad.
const R = '/home/user/EdgeDeskSports';
const fs = require('fs');
const M = require(R + '/basketball/model.js');
const WF = require(R + '/basketball/walkforward.js');
const BS = require(R + '/basketball/build_slate.js');
const P = require(R + '/engine/lab/protocol.js');
const OUT = process.argv[2];

const tuning = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_tuning.json', 'utf8'));
const live = JSON.parse(fs.readFileSync(R + '/basketball/params/wnba_live.json', 'utf8'));

// capture components at each expect() call
const comps = [];
const origExpect = M.PointsRatings.prototype.expect;
M.PointsRatings.prototype.expect = function (h, a, neutral) {
  const e = origExpect.call(this, h, a, neutral);
  const H = this.T(h), A = this.T(a);
  comps.push({ mu: this.mu, h: this.h, Ho: H.o, Hd: H.d, Ao: A.o, Ad: A.d, Hpo: H.po, Hpd: H.pd, Apo: A.po, Apd: A.pd, gh: H.idx.length, ga: A.idx.length });
  return e;
};

const { games } = WF.load('wnba');
// 1) reproduce the committed live params: games through 2026-10-17 only
const upto = games.filter((g) => g.date <= '2026-10-17');
comps.length = 0;
const r1 = WF.pass(upto, tuning.chosen, tuning.elo);
const dump = r1.ratings.dump();
let maxd = 0;
for (const [id, t] of Object.entries(live.ratings.teams)) { const u = dump.teams[id]; if (!u) continue; maxd = Math.max(maxd, Math.abs(u.o - t.o), Math.abs(u.d - t.d)); }
const cal2026 = WF.score(r1.rows).cal[2026];
const repro = { mu: [dump.mu, live.ratings.mu], h: [dump.h, live.ratings.h], max_team_rating_diff: maxd,
  cal_margin: [cal2026.margin, live.calibration.margin], cal_total: [cal2026.total, live.calibration.total], cal_win: [cal2026.win, live.calibration.win] };

// 2) full point-in-time pass on all committed finals
comps.length = 0;
const full = WF.pass(games, tuning.chosen, tuning.elo);
const C = comps.slice();
const { scored, cal } = WF.score(full.rows);
const rows = [];
full.rows.forEach((r, i) => { r._c = C[i]; });
for (const r of scored) {
  if (r.season !== 2026) continue;
  const c = cal[2026];
  rows.push({ id: r.id, date: r.date, type: r.type, home: r.home, away: r.away, neutral: r.neutral, m_raw: r.m, t_raw: r.t, comp: r._c,
    p_points: r.p.points, p_elo: r.p.elo, margin_mu: r.p.margin.mu, total_mu: r.p.total.mu, y: r.y, x_rest: r.x_rest });
}
fs.writeFileSync(OUT + '/pit_2026.json', JSON.stringify({ repro, cal2026: cal[2026], live_cal: live.calibration, rows }, null, 1));
console.log(JSON.stringify(repro, null, 1));
console.log('rows 2026', rows.length);
