'use strict';
const fs = require('fs');
const R = '/home/user/EdgeDeskSports/';
require(R + 'mlb/params.js');
const E = require(R + 'mlb/engine.js');
const P = globalThis.EDBaseballParams; const M = P.mlb;
const { game } = require(R + 'mlb/history/model');
const live = JSON.parse(fs.readFileSync(R + 'mlb/history/params/mlb_live.json', 'utf8'));
const names = JSON.parse(fs.readFileSync(R + 'mlb/history/data/pitchers.json', 'utf8'));
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const FROM = process.argv[3] || '2025-09-19';
const am = (p) => E.odds.probToAm(p);
const r2 = (v, d = 3) => (v == null ? null : +v.toFixed(d));

const late = rows.filter((r) => r.eng && r.date >= FROM).map((r) => Object.assign(r, { gap: (r.eng.model.home_win_prob - r.hist.p) * 100, gapElo: (r.eng.model.home_win_prob - r.elo) * 100 }));
late.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
console.log('games in window', late.length, 'mean |gap| vs history', r2(late.reduce((a, r) => a + Math.abs(r.gap), 0) / late.length, 2), 'max', r2(Math.abs(late[0].gap), 2));
console.log('mean |gap| vs elo', r2(late.reduce((a, r) => a + Math.abs(r.gapElo), 0) / late.length, 2));
const top = late.slice(0, 3);

function wp(lh, la, xi) { const a = E.dist.runPmf(lh, M.run_dispersion, M.run_support_max), b = E.dist.runPmf(la, M.run_dispersion, M.run_support_max); return E.dist.winProb(a, b, xi); }
function pHomeFrom(lh, la) { return Math.min(0.98, Math.max(0.02, wp(lh, la, M.extra_innings_home_win) + M.home_last_bat_win_bonus)); }

for (const r of top) {
  const req = r.req; const p = E.projectGame(req); const m = p.model; const L = p.components.league_runs_per_game;
  console.log('\n=== ' + r.date + ' ' + r.away + ' @ ' + r.home + ' (final ' + r.as + '-' + r.hs + ')');
  console.log('SP away', r.sp_away, names[r.sp_away], JSON.stringify(req.away.starter));
  console.log('SP home', r.sp_home, names[r.sp_home], JSON.stringify(req.home.starter));
  console.log('home off', JSON.stringify(req.home.offense), 'def', JSON.stringify(req.home.defense));
  console.log('away off', JSON.stringify(req.away.offense), 'def', JSON.stringify(req.away.defense));
  console.log('league', L, 'park', JSON.stringify(req.park));
  for (const s of ['home', 'away']) console.log(' contrib ' + s, JSON.stringify(p.contributions[s].map((t) => [t.k, t.v])));
  console.log(' staff ra9 home', p.components.home_staff_ra9, 'share', p.components.home_starter_share, '| away', p.components.away_staff_ra9, 'share', p.components.away_starter_share);
  console.log(' lamH', m.home_runs, 'lamA', m.away_runs, 'total', m.fair_total, 'pRuns', r2(m.home_win_prob_runs_only, 4), 'pHome', r2(m.home_win_prob, 4), 'ML', m.fair_home_ml, m.fair_away_ml, 'RL', m.run_line, r2(m.run_line_cover_prob, 4), m.fair_run_line_ml, 'p10/50/90', m.total_p10, m.total_p50, m.total_p90);
  /* intermediate arithmetic for the starter */
  for (const s of ['home', 'away']) {
    const st = req[s].starter; if (!st) { console.log(' ' + s + ' starter: none'); continue; }
    const B = M.starter_blend; const parts = []; let acc = 0, w = 0;
    if (st.xera != null) { acc += st.xera * B.xera; w += B.xera; } if (st.fip != null) { acc += st.fip * B.fip; w += B.fip; } if (st.era != null) { acc += st.era * B.era; w += B.era; }
    const earned = acc / w, ra9 = earned * M.era_to_ra9, wt = st.ip / (st.ip + M.starter_regress_ip), reg = L + (ra9 - L) * wt;
    const ip = Math.min(M.starter_innings_max, Math.max(M.starter_innings_min, st.ip_per_start)); const share = ip / 9;
    const def = req[s].defense; const clubReg = L + (def.runs_allowed_per_game - L) * (def.games / (def.games + M.defense_regress_games));
    console.log(' ' + s + ' starter: blend(ERA ' + r2(st.era, 2) + ', FIP ' + r2(st.fip, 2) + ') = ' + r2(earned, 3) + ' x1.08 = ' + r2(ra9, 3) + '; IP ' + r2(st.ip, 1) + ' -> w ' + r2(wt, 3) + ' -> reg ' + r2(reg, 3)
      + '; IP/GS ' + r2(st.ip_per_start, 2) + ' share ' + r2(share, 3) + '; club RA/G ' + r2(def.runs_allowed_per_game, 3) + ' over ' + def.games + ' -> reg ' + r2(clubReg, 3)
      + '; staff = ' + r2(share, 3) + '*' + r2(reg, 3) + ' + ' + r2(1 - share, 3) + '*' + r2(clubReg, 3) + ' = ' + r2(share * reg + (1 - share) * clubReg, 3) + ' -> factor ' + r2((share * reg + (1 - share) * clubReg) / L, 4));
    const off = req[s].offense; const oreg = L + (off.runs_per_game - L) * (off.games / (off.games + M.offense_regress_games));
    console.log(' ' + s + ' offense: R/G ' + r2(off.runs_per_game, 3) + ' over ' + off.games + ' -> w ' + r2(off.games / (off.games + 30), 3) + ' -> reg ' + r2(oreg, 3) + ' -> factor ' + r2(oreg / L, 4));
  }
  /* win-prob attribution, one component at a time from the home-structure baseline */
  const base = pHomeFrom(L * M.home_offense_mult, L * M.away_offense_mult);
  const neutral = wp(L, L, 0.5);
  const homeMultOnly = wp(L * M.home_offense_mult, L * M.away_offense_mult, 0.5);
  const xiOnly = wp(L * M.home_offense_mult, L * M.away_offense_mult, M.extra_innings_home_win);
  const ch = Object.fromEntries(p.contributions.home.map((t) => [t.k, t.v])), ca = Object.fromEntries(p.contributions.away.map((t) => [t.k, t.v]));
  const comps = {
    'home offense': [ch.offense, 1], 'away offense': [1, ca.offense],
    'away staff (faced by home)': [ch.opposing_staff, 1], 'home staff (faced by away)': [1, ca.opposing_staff],
    park: [ch.park || 1, ca.park || 1],
  };
  let sum = 0; const attr = [];
  for (const [k, [fh, fa]] of Object.entries(comps)) { const v = pHomeFrom(L * M.home_offense_mult * fh, L * M.away_offense_mult * fa) - base; sum += v; attr.push([k, r2(v * 100, 2), 'runs H x' + r2(fh, 4) + ' A x' + r2(fa, 4)]); }
  const full = m.home_win_prob; const resid = full - base - sum;
  console.log(' neutral 50.00; + run split (1.020/0.988) -> ' + r2(homeMultOnly * 100, 2) + '; + extras 0.52 -> ' + r2(xiOnly * 100, 2) + '; + last-bat +1.6 -> ' + r2(base * 100, 2));
  console.log(' attribution (pts):', JSON.stringify(attr), 'sum', r2(sum * 100, 2), 'interaction residual', r2(resid * 100, 2), 'full', r2(full * 100, 2));
  /* history model components, end-of-2025 ratings (fit through 2025-09-28) */
  const f = live.fit; const T = f.teams; const s = f.pitchers;
  const sH = s[r.sp_home] || 0, sA = s[r.sp_away] || 0;
  const lh = Math.exp(f.mu + f.home + T[r.home].o - T[r.away].d - sA + T[r.home].park), la = Math.exp(f.mu + T[r.away].o - T[r.home].d - sH + T[r.home].park);
  const G = game(r.hist.lh, r.hist.la, live.calibration.r, live.calibration.xi);
  console.log(' HISTORY(point-in-time pass) lh ' + r2(r.hist.lh, 3) + ' la ' + r2(r.hist.la, 3) + ' raw p ' + r2(G.p_home, 4) + ' recal p ' + r2(r.hist.p, 4) + ' ML ' + am(r.hist.p));
  console.log(' HISTORY(end-2025 ratings) mu ' + f.mu + ' home ' + f.home + ' o_h ' + T[r.home].o + ' d_a ' + T[r.away].d + ' sA ' + sA + ' park ' + T[r.home].park + ' | o_a ' + T[r.away].o + ' d_h ' + T[r.home].d + ' sH ' + sH + ' -> lh ' + r2(lh, 3) + ' la ' + r2(la, 3));
  console.log(' ELO p ' + r2(r.elo, 4) + ' | gap engine-history ' + r2(r.gap, 2) + ' pts, engine-elo ' + r2(r.gapElo, 2) + ' pts');
}
