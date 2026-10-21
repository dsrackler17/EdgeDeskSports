// Reconstruct cfb_p4 projections at a past cutoff using the CURRENT engine code,
// emulating v1.0.0 (league HFA 4.082, ratings learned at 3.2) unless --unified.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/EdgeDeskSports';
const SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad';
global.window = global;
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
if (!opt('unified')) global.EDCfbP4HomeField = { promoted: false };
if (opt('noregimecurve')) global.EDCfbP4RegimeCurve = { curve: null };
require(path.join(ROOT, 'football/cfb_p4/params.js'));
const E = require(path.join(ROOT, 'football/cfb_p4/engine.js'));
const FBS = require(path.join(ROOT, 'football/fbs/fbs.js'));
const P = global.EDCfbP4Params;
if (opt('indep')) P.conference.independents_as_conference = true;
function csv(t) { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } if (cell.length || row.length) { row.push(cell); rows.push(row); } const h = rows.shift(); return rows.filter(r => r.length > 2).map(r => Object.fromEntries(h.map((k, j) => [k, r[j]]))); }
const num = v => (v == null || v === '' || v === 'NA') ? null : +v;
const sched = csv(fs.readFileSync(path.join(SP, 'dl/sched/cfb_schedules_2026.csv'), 'utf8'));
const eff = opt('eff') ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football/rankings/engine_efficiency.json'), 'utf8')) : null;
const cutoff = Date.parse(opt('cutoff'));
const st = E.newState();
E.ingest.seasonBreak(st);
const known = P.rating.seed_ratings;
let absorbed = 0;
sched.slice().sort((a, b) => a.start_date.localeCompare(b.start_date) || a.game_id.localeCompare(b.game_id)).forEach(r => {
  if (r.completed !== 'TRUE' || num(r.home_points) == null) return;
  if (Date.parse(r.start_date) + 4 * 3600e3 > cutoff) return;
  let ts = null;
  if (eff && eff.games && eff.games[r.game_id] && eff.games[r.game_id].teams) {
    const g = eff.games[r.game_id].teams, hk = FBS.normKey(r.home_team), ak = FBS.normKey(r.away_team);
    const h = g[hk] || null, a = g[ak] || null; if (h || a) ts = { home: h, away: a };
  }
  E.ingest.absorbGame(st, { home: r.home_team, away: r.away_team,
    home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: known }),
    away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: known }),
    neutral_site: r.neutral_site === 'TRUE', home_points: num(r.home_points), away_points: num(r.away_points), team_stats: ts });
  absorbed++;
});
const ids = (opt('games') || '').split(',');
const regime = opt('regime') ? JSON.parse(fs.readFileSync(path.join(ROOT, 'football/coaching/regime.json'), 'utf8')).by_team : null;
const out = [];
for (const id of ids) {
  const r = sched.find(x => x.game_id === id); if (!r) { console.log('missing', id); continue; }
  const hk = FBS.normKey(r.home_team), ak = FBS.normKey(r.away_team);
  const conf = opt('conf') ? { home: { conference: r.home_conference === 'FBS Independents' ? 'FBS Independents' : r.home_conference }, away: { conference: r.away_conference } } : { home: {}, away: {} };
  if (regime) { conf.home.regime = regime[hk] || null; conf.away.regime = regime[ak] || null; }
  const req = { state: st, season: 2026, week: num(r.week),
    game: { home: r.home_team, away: r.away_team, neutral_site: r.neutral_site === 'TRUE', venue_id: num(r.venue_id),
      home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: known }), away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: known }) },
    teams: conf };
  const p = E.projectGame(req);
  if (p.status !== 'PREDICTED') { console.log(id, p.status, p.reason); continue; }
  const sb = p.layers.strength.preseason_blend;
  const sum = p.contributions.reduce((s, c) => s + c.points, 0);
  out.push({ id, game: r.away_team + ' @ ' + r.home_team, week: r.week, absorbed, fair: +p.model.fair_spread.toFixed(3), sum: +sum.toFixed(3),
    contributions: Object.fromEntries(p.contributions.map(c => [c.key, +c.points.toFixed(3)])),
    home: { carried: sb.home_carried, fresh: sb.home_this_season, w: sb.home_prior_weight, gp: sb.home_games_played, seed: known[hk] },
    away: { carried: sb.away_carried, fresh: sb.away_this_season, w: sb.away_prior_weight, gp: sb.away_games_played, seed: known[ak] },
    sigma: p.model.sigma_margin, p_home: p.model.home_win_prob, ml: [p.model.fair_home_ml, p.model.fair_away_ml],
    p10: p.model.p10_margin, p50: p.model.median_margin, p90: p.model.p90_margin, mcal: p.model.margin_calibration && p.model.margin_calibration.calibrated_margin,
    disp: p.model.display_fair_spread });
}
console.log(JSON.stringify(out, null, 1));
