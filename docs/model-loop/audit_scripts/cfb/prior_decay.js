// Measure the weight the shipped engine puts on a team's preseason rating after g games:
// perturb one team's post-carry preseason rating by +1 and replay 2026 completed games.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = '/home/user/EdgeDeskSports';
const SP = '/tmp/claude-0/-home-user-EdgeDeskSports/19f6ade0-8410-590a-a5fe-95c5c7ccde7e/scratchpad';
global.window = global;
require(path.join(ROOT, 'football/cfb_p4/params.js'));
require(path.join(ROOT, 'football/cfb_p4/home_field.js'));
const E = require(path.join(ROOT, 'football/cfb_p4/engine.js'));
const FBS = require(path.join(ROOT, 'football/fbs/fbs.js'));
const P = global.EDCfbP4Params;
function csv(t) { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c; } if (cell.length || row.length) { row.push(cell); rows.push(row); } const h = rows.shift(); return rows.filter(r => r.length > 2).map(r => Object.fromEntries(h.map((k, j) => [k, r[j]]))); }
const sched = csv(fs.readFileSync(path.join(SP, 'dl/sched/cfb_schedules_2026.csv'), 'utf8'))
  .filter(r => r.completed === 'TRUE' && r.home_points !== 'NA')
  .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.game_id.localeCompare(b.game_id));
const known = P.rating.seed_ratings;
function replay(bumpKey) {
  const st = E.newState(); E.ingest.seasonBreak(st);
  if (bumpKey) { st.r[bumpKey] += 1; }
  const traj = {}; // team -> [blended standard-weight value after g games]
  const rec = (k) => { const b = E.strength.blendedRating(st, k, true, null, null); (traj[k] = traj[k] || []).push({ g: b.games_played, v: b.value, carried: b.carried, w: b.prior_weight }); };
  for (const k of Object.keys(st.r)) rec(k);
  for (const r of sched) {
    const hf = FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: known }), af = FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: known });
    E.ingest.absorbGame(st, { home: r.home_team, away: r.away_team, home_fbs: hf, away_fbs: af, neutral_site: r.neutral_site === 'TRUE', home_points: +r.home_points, away_points: +r.away_points });
    if (hf) rec(FBS.normKey(r.home_team)); if (af) rec(FBS.normKey(r.away_team));
  }
  return traj;
}
if (!E.strength) { console.log('no strength export', Object.keys(E)); process.exit(1); }
const base = replay(null);
const teams = Object.keys(known);
const byG = {}, byGc = {};
for (const t of teams) {
  const bumped = replay(t);
  const a = base[t] || [], b = bumped[t] || [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const g = a[i].g; (byG[g] = byG[g] || []).push(b[i].v - a[i].v); (byGc[g] = byGc[g] || []).push(b[i].carried - a[i].carried);
  }
}
const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
const out = {};
for (const g of Object.keys(byG).sort((x, y) => x - y)) out[g] = { n: byG[g].length, blended_weight: +mean(byG[g]).toFixed(4), carried_track_weight: +mean(byGc[g]).toFixed(4), shipped_w: P.blend.prior_weight_by_week[String(Math.min(15, g))], theory_w_x_086g: +(P.blend.prior_weight_by_week[String(Math.min(15, g))] * Math.pow(0.86, g)).toFixed(4) };
console.log(JSON.stringify(out, null, 1));
