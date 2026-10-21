// Card-consistency checks on the CURRENT production configuration (unified HFA 2.8, regime curve,
// efficiency, conference), projecting the committed slate's games and comparing with the slate.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/EdgeDeskSports';
const SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad';
global.window = global;
require(path.join(ROOT, 'football/cfb_p4/params.js'));
require(path.join(ROOT, 'football/cfb_p4/home_field.js'));
require(path.join(ROOT, 'football/cfb_p4/regime_curve.js'));
require(path.join(ROOT, 'football/cfb_p4/margin_calibration.js'));
require(path.join(ROOT, 'football/cfb_p4/live_calibration.js'));
const E = require(path.join(ROOT, 'football/cfb_p4/engine.js'));
const FBS = require(path.join(ROOT, 'football/fbs/fbs.js'));
const P = global.EDCfbP4Params;
function csv(t) { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } if (cell.length || row.length) { row.push(cell); rows.push(row); } const h = rows.shift(); return rows.filter(r => r.length > 2).map(r => Object.fromEntries(h.map((k, j) => [k, r[j]]))); }
const sched = csv(fs.readFileSync(path.join(SP, 'dl/sched/cfb_schedules_2026.csv'), 'utf8'));
const eff = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/rankings/engine_efficiency.json'), 'utf8'));
const regime = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/coaching/regime.json'), 'utf8')).by_team;
const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football/fbs/slate.json'), 'utf8'));
const cutoff = Date.parse(slate.generated_at);
const known = P.rating.seed_ratings;
const st = E.newState(); E.ingest.seasonBreak(st);
sched.slice().sort((a, b) => a.start_date.localeCompare(b.start_date) || a.game_id.localeCompare(b.game_id)).forEach(r => {
  if (r.completed !== 'TRUE' || r.home_points === 'NA') return;
  if (Date.parse(r.start_date) > cutoff) return;
  let ts = null; const eg = eff.games && eff.games[r.game_id];
  if (eg && eg.teams) { const h = eg.teams[FBS.normKey(r.home_team)] || null, a = eg.teams[FBS.normKey(r.away_team)] || null; if (h || a) ts = { home: h, away: a }; }
  E.ingest.absorbGame(st, { home: r.home_team, away: r.away_team,
    home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: known }), away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: known }),
    neutral_site: r.neutral_site === 'TRUE', home_points: +r.home_points, away_points: +r.away_points, team_stats: ts });
});
const amToProb = a => a < 0 ? -a / (-a + 100) : 100 / (a + 100);
const res = [];
for (const g of slate.games) {
  const r = sched.find(x => x.game_id === g.game_id); if (!r) continue;
  const hk = FBS.normKey(r.home_team), ak = FBS.normKey(r.away_team);
  const req = { state: st, season: 2026, week: +r.week,
    game: { home: r.home_team, away: r.away_team, neutral_site: r.neutral_site === 'TRUE', venue_id: +r.venue_id,
      home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: known }), away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: known }) },
    teams: { home: { conference: r.home_conference, regime: regime[hk] || null }, away: { conference: r.away_conference, regime: regime[ak] || null } } };
  const p = E.projectGame(req);
  if (p.status !== 'PREDICTED') { res.push({ id: g.game_id, status: p.status }); continue; }
  const m = p.model, sum = p.contributions.reduce((s, c) => s + c.points, 0);
  const phi = E.dist.winProb(m.fair_spread, m.sigma_margin);
  const mlH = m.fair_home_ml, mlA = m.fair_away_ml;
  const pFromMl = amToProb(mlH), pFromMlA = amToProb(mlA);
  const cov0 = E.dist.coverProbSpread(m.fair_spread, 0, m.sigma_margin, p.layers.uncertainty.sigma_base);
  const md = E.dist.marginDistribution(m.fair_spread, m.sigma_margin);
  const mean = md.reduce((s, x) => s + x[0] * x[1], 0);
  res.push({ id: g.game_id, game: r.away_team + ' @ ' + r.home_team, slate_margin: g.model_home_margin, engine_margin: +m.fair_spread.toFixed(3),
    repro_diff: +(m.fair_spread - g.model_home_margin).toFixed(3), sum_resid: sum - m.fair_spread,
    p: m.home_win_prob, slate_p: g.model_home_win_prob, phi_diff: m.home_win_prob - phi, sigma: m.sigma_margin,
    ml: [mlH, mlA], p_from_ml_home: pFromMlH = pFromMl, ml_p_diff: pFromMl - m.home_win_prob, ml_overround: pFromMl + pFromMlA - 1,
    p10: m.p10_margin, p50: m.median_margin, p90: m.p90_margin, dist_mean: mean,
    p50_minus_fair: m.median_margin - m.fair_spread, mid1090_minus_fair: (m.p10_margin + m.p90_margin) / 2 - m.fair_spread, distmean_minus_fair: mean - m.fair_spread,
    cover_at_pk: cov0 ? cov0.win + 0.5 * cov0.push : null, cover_minus_p: cov0 ? (cov0.win + 0.5 * cov0.push) - m.home_win_prob : null, cover_basis: cov0 && cov0.basis,
    display: m.display_fair_spread, comps: Object.fromEntries(p.contributions.map(c => [c.key, +c.points.toFixed(3)])), mcal: m.margin_calibration && m.margin_calibration.calibrated_margin, live: m.live_calibration && m.live_calibration.margin,
    pw: [p.layers.strength.preseason_blend.home_prior_weight, p.layers.strength.preseason_blend.away_prior_weight], gp: [p.layers.strength.preseason_blend.home_games_played, p.layers.strength.preseason_blend.away_games_played] });
}
var pFromMlH;
fs.writeFileSync(path.join(SP, 'consistency.json'), JSON.stringify(res, null, 1));
const ok = res.filter(x => x.engine_margin != null);
const mx = k => Math.max(...ok.map(x => Math.abs(x[k])));
const avg = k => ok.reduce((s, x) => s + x[k], 0) / ok.length;
console.log('games', ok.length, 'of', res.length);
for (const k of ['repro_diff', 'sum_resid', 'phi_diff', 'ml_p_diff', 'ml_overround', 'p50_minus_fair', 'mid1090_minus_fair', 'distmean_minus_fair', 'cover_minus_p'])
  console.log(k, 'max|.|', mx(k).toFixed(4), 'mean', avg(k).toFixed(4));
console.log('p_home vs slate p max diff', Math.max(...ok.map(x => Math.abs(x.p - x.slate_p))).toFixed(5));
