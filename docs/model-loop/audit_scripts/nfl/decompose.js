const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '../../../..');
global.EDFootballParams = require(ROOT + '/football/params.js');
const E = require(ROOT + '/football/engine.js');
const P = global.EDFootballParams.nfl;
function csv(t) { const L = t.split(/\r?\n/).filter(Boolean); const h = L[0].split(',');
  return L.slice(1).map(l => { const c = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch; } c.push(cur);
    const o = {}; h.forEach((k, i) => o[k] = c[i] === '' || c[i] === 'NA' ? null : c[i]); return o; }); }
const num = x => (x == null || x === '' ? null : (isFinite(+x) ? +x : null));
const games = csv(fs.readFileSync(process.env.NFL_GAMES_CSV || '.cache/model_loop/nfl/raw/games.csv', 'utf8'));
const stw = csv(fs.readFileSync(ROOT + '/football/nfl/stats_team_week_2026.csv', 'utf8'));
const byGame = {}; stw.forEach(x => (byGame[x.game_id] = byGame[x.game_id] || []).push(x));
function run(zeroSeeds, qbOverride) {
  const st = E.nfl.newState(); E.nfl.seasonBreak(st);
  if (zeroSeeds) for (const t in st.team) for (const f in st.team[t]) st.team[t][f] = 0;
  const rows = games.filter(r => num(r.season) === 2026).sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
  const snaps = {};
  for (const g of rows) {
    const q = qbOverride && qbOverride[g.game_id] || {};
    const rq = { home: g.home_team, away: g.away_team, week: num(g.week), home_rest: num(g.home_rest), away_rest: num(g.away_rest), roof: g.roof, surface: g.surface,
      div_game: num(g.div_game), temp: num(g.temp), wind: num(g.wind), home_qb_id: q.h || g.home_qb_id, away_qb_id: q.a || g.away_qb_id, neutral: g.location === 'Neutral' };
    snaps[g.game_id] = { g, pr: E.nfl.predict(st, rq), rh: { ...st.team[g.home_team] }, ra: { ...st.team[g.away_team] }, nh: st.ngames[g.home_team], na: st.ngames[g.away_team] };
    if (g.home_score == null) continue;
    const pair = byGame[g.game_id]; if (!pair || pair.length !== 2) continue;
    const hRow = pair.find(x => x.team === g.home_team), aRow = pair.find(x => x.team === g.away_team);
    const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
    hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score); ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
    E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
  }
  return snaps;
}
const qbo = { '2026_07_KC_SEA': { h: '00-0034869' } }; // the slate's reconciled starter (Darnold)
const full = run(false, qbo), zero = run(true, qbo);
const W = {}; P.spread_feats.forEach((f, i) => W[f] = P.w_spread[i]);
function unitSplit(rh, ra) {
  // every rating-driven spread term split by unit (net_pts, net_epa, net_pass, net_rush are linear in these)
  return {
    'home pass O': W.net_pass * rh.pass_epa_db, 'home pass D': -W.net_pass * rh.def_pass_epa_db,
    'away pass O': -W.net_pass * ra.pass_epa_db, 'away pass D': W.net_pass * ra.def_pass_epa_db,
    'home rush O': W.net_rush * rh.rush_epa_att, 'home rush D': -W.net_rush * rh.def_rush_epa_att,
    'away rush O': -W.net_rush * ra.rush_epa_att, 'away rush D': W.net_rush * ra.def_rush_epa_att,
    'home EPA/play O': W.net_epa * rh.off_epa_play, 'home EPA/play D': -W.net_epa * rh.def_epa_play,
    'away EPA/play O': -W.net_epa * ra.off_epa_play, 'away EPA/play D': W.net_epa * ra.def_epa_play,
    'home pts': W.net_pts * (rh.pts_for + rh.pts_against), 'away pts': -W.net_pts * (ra.pts_for + ra.pts_against)
  };
}
const ids = process.argv.slice(2);
const res = {};
for (const id of ids) {
  const F = full[id], Z = zero[id];
  const sp = F.pr.terms.spread, cx = F.pr.terms.ctx;
  const fair = F.pr.model_spread;
  const sumSp = sp.reduce((s, t) => s + t.points, 0), sumCx = cx.reduce((s, t) => s + t.points, 0);
  const ratingTerms = ['net_pts', 'net_epa', 'net_pass', 'net_rush'];
  const ratingFull = sp.filter(t => ratingTerms.includes(t.key)).reduce((s, t) => s + t.points, 0);
  const ratingZero = Z.pr.terms.spread.filter(t => ratingTerms.includes(t.key)).reduce((s, t) => s + t.points, 0);
  const uFull = unitSplit(F.rh, F.ra), uZero = unitSplit(Z.rh, Z.ra);
  res[id] = { home: F.g.home_team, away: F.g.away_team, week: num(F.g.week), fair_margin: fair, home_line: -fair, close_home_line: num(F.g.spread_line) == null ? null : -num(F.g.spread_line),
    result: num(F.g.result), games_played: [F.nh, F.na], qb: [F.g.home_qb_name, F.g.away_qb_name],
    spread_terms: sp.map(t => ({ key: t.key, value: t.value, weight: t.weight, points: t.points })),
    ctx_terms: cx.map(t => ({ key: t.key, value: t.value, weight: t.weight, points: t.points })),
    sum_spread: sumSp, sum_ctx: sumCx, residual_vs_card: fair - sumSp,
    rating_points: ratingFull, rating_points_from_2026_data: ratingZero, rating_points_from_2025_prior: ratingFull - ratingZero,
    units_full: uFull, units_2026_only: uZero,
    p_home: E.dist.winProb('nfl', fair), q: E.dist.marginQuantiles('nfl', fair, [0.1, 0.5, 0.9]).q };
}
console.log(JSON.stringify(res, null, 1));
