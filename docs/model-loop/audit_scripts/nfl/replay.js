// Leak-free replay of the shipped NFL engine over 2026, mirroring app.html fbLoadNfl.
const fs = require('fs'), path = require('path');
const ROOT = require('path').resolve(__dirname, '../../../..');
global.EDFootballParams = require(ROOT + '/football/params.js');
const E = require(ROOT + '/football/engine.js');
function csv(t) { const L = t.split(/\r?\n/).filter(Boolean); const h = L[0].split(',');
  return L.slice(1).map(l => { const c = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { c.push(cur); cur = ''; } else cur += ch; } c.push(cur);
    const o = {}; h.forEach((k, i) => o[k] = c[i] === '' || c[i] === 'NA' ? null : c[i]); return o; }); }
const num = x => (x == null || x === '' ? null : (isFinite(+x) ? +x : null));
const games = csv(fs.readFileSync(process.argv[2] || process.env.NFL_GAMES_CSV || '.cache/model_loop/nfl/raw/games.csv', 'utf8'));
const stw = csv(fs.readFileSync(ROOT + '/football/nfl/stats_team_week_2026.csv', 'utf8'));
const byGame = {}; stw.forEach(x => (byGame[x.game_id] = byGame[x.game_id] || []).push(x));
const SEASON = 2026;
const st = E.nfl.newState(); for (let y = st.seededThrough; y < SEASON; y++) E.nfl.seasonBreak(st);
const rows = games.filter(r => num(r.season) === SEASON);
rows.sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
const out = {};
function req(g) { return { home: g.home_team, away: g.away_team, week: num(g.week), home_rest: num(g.home_rest), away_rest: num(g.away_rest), roof: g.roof, surface: g.surface,
  div_game: num(g.div_game), temp: num(g.temp), wind: num(g.wind), home_qb_id: g.home_qb_id || null, away_qb_id: g.away_qb_id || null, neutral: g.location === 'Neutral' }; }
for (const g of rows) {
  const pr = E.nfl.predict(st, req(g));
  const fair = pr.model_spread;
  out[g.game_id] = { game_id: g.game_id, week: num(g.week), home: g.home_team, away: g.away_team, fair_margin: fair, home_line: -fair,
    terms: pr.terms, total: pr.sharp_total, p_home: E.dist.winProb('nfl', fair), q: E.dist.marginQuantiles('nfl', fair, [0.1, 0.5, 0.9]),
    close_home_line: num(g.spread_line) == null ? null : -num(g.spread_line), result: num(g.result), home_score: num(g.home_score), away_score: num(g.away_score),
    known: pr.known, qb: [g.home_qb_name, g.away_qb_name], ratings: { h: JSON.parse(JSON.stringify(st.team[g.home_team])), a: JSON.parse(JSON.stringify(st.team[g.away_team])) } };
  if (g.home_score == null) continue;
  const pair = byGame[g.game_id]; if (!pair || pair.length !== 2) continue;
  const hRow = pair.find(x => x.team === g.home_team), aRow = pair.find(x => x.team === g.away_team);
  const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
  hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score); ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
  E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
}
fs.writeFileSync('replay_2026.json', JSON.stringify(out, null, 1));
console.log('games', Object.keys(out).length);
