// Walk-forward 2026 replay: project each completed game from the state BEFORE it (games kicked off
// >= 4h earlier absorbed), then absorb. Joins the committed record's close/final. --v100 emulates
// the pre-2026-10-19 home field (learn 3.2, project 4.082, params.js seeds).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/EdgeDeskSports';
const SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad';
global.window = global;
const V100 = process.argv.includes('--v100');
if (V100) global.EDCfbP4HomeField = { promoted: false }; else require(path.join(ROOT, 'football/cfb_p4/home_field.js'));
require(path.join(ROOT, 'football/cfb_p4/params.js'));
require(path.join(ROOT, 'football/cfb_p4/regime_curve.js'));
const E = require(path.join(ROOT, 'football/cfb_p4/engine.js'));
const FBS = require(path.join(ROOT, 'football/fbs/fbs.js'));
const P = global.EDCfbP4Params;
function csv(t) { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } if (cell.length || row.length) { row.push(cell); rows.push(row); } const h = rows.shift(); return rows.filter(r => r.length > 2).map(r => Object.fromEntries(h.map((k, j) => [k, r[j]]))); }
const sched = csv(fs.readFileSync(path.join(SP, 'dl/sched/cfb_schedules_2026.csv'), 'utf8')).filter(r => r.completed === 'TRUE' && r.home_points !== 'NA')
  .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.game_id.localeCompare(b.game_id));
const eff = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/rankings/engine_efficiency.json'), 'utf8'));
const regime = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/coaching/regime.json'), 'utf8')).by_team;
const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'record/football/cfb_2026.json'), 'utf8')).games;
const known = P.rating.seed_ratings;
const st = E.newState(); E.ingest.seasonBreak(st);
const out = []; let ai = 0;
const fb = (d, t) => FBS.isFbsDivision(d, t, { knownFbs: known });
for (const r of sched) {
  const k = Date.parse(r.start_date);
  while (ai < sched.length && Date.parse(sched[ai].start_date) + 4 * 3600e3 <= k) {
    const a = sched[ai++]; let ts = null; const eg = eff.games && eff.games[a.game_id];
    if (eg && eg.teams) { const h = eg.teams[FBS.normKey(a.home_team)] || null, w = eg.teams[FBS.normKey(a.away_team)] || null; if (h || w) ts = { home: h, away: w }; }
    E.ingest.absorbGame(st, { home: a.home_team, away: a.away_team, home_fbs: fb(a.home_division, a.home_team), away_fbs: fb(a.away_division, a.away_team),
      neutral_site: a.neutral_site === 'TRUE', home_points: +a.home_points, away_points: +a.away_points, team_stats: ts });
  }
  const g = rec[r.game_id]; if (!g || !g.close || g.close.home_line == null) continue;
  const hk = FBS.normKey(r.home_team), ak = FBS.normKey(r.away_team);
  const p = E.projectGame({ state: st, season: 2026, week: +r.week,
    game: { home: r.home_team, away: r.away_team, neutral_site: r.neutral_site === 'TRUE', venue_id: +r.venue_id, home_fbs: fb(r.home_division, r.home_team), away_fbs: fb(r.away_division, r.away_team) },
    teams: { home: { conference: r.home_conference, regime: regime[hk] || null }, away: { conference: r.away_conference, regime: regime[ak] || null } } });
  if (p.status !== 'PREDICTED') continue;
  const sb = p.layers.strength.preseason_blend;
  out.push({ id: r.game_id, week: +r.week, type: g.matchup_type, neutral: r.neutral_site === 'TRUE', fair: p.model.fair_spread, pub: -g.pick.home_line,
    close: -g.close.home_line, final: +r.home_points - +r.away_points, comps: Object.fromEntries(p.contributions.map(c => [c.key, c.points])),
    hc: sb.home_carried, hf: sb.home_this_season, ac: sb.away_carried, af: sb.away_this_season, hw: sb.home_prior_weight, aw: sb.away_prior_weight, hg: sb.home_games_played, ag: sb.away_games_played,
    hreg: !!(regime[hk] && regime[hk].regime_change), areg: !!(regime[ak] && regime[ak].regime_change) });
}
fs.writeFileSync(path.join(SP, V100 ? 'replay2026_v100.json' : 'replay2026_cur.json'), JSON.stringify(out));
console.log('rows', out.length);
