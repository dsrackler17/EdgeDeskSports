'use strict';
const ROOT = '/home/user/EdgeDeskSports';
const M = require(ROOT + '/lib/tennis_model.js');
const LAB = require(ROOT + '/lib/tennis_lab.js');
const cp = require('child_process');
function q(sql) {
  const out = cp.spawnSync('psql', ['-h','127.0.0.1','-p','55432','-U','postgres','-d','edgd_tennis_audit','-tA','-c',
    "select coalesce(json_agg(t),'[]'::json)::text from (" + sql + ") t"], { encoding: 'utf8', maxBuffer: 1e8 });
  if (out.status) throw new Error(out.stderr);
  return JSON.parse(out.stdout.trim());
}
const model = q(`select model_version, coefficients from tennis.model_registry where status='active'`)[0];
const C = model.coefficients.coefficients, b0 = Number(model.coefficients.intercept || 0);
const preds = q(`select p.match_ref, p.player_a_id, p.player_b_id, p.player_a_name, p.player_b_name, p.prob_a, p.market_prob_a,
   p.inputs, p.fair_odds_a_decimal, p.fair_odds_a_american, p.fair_odds_b_american, lm.round, lm.best_of, t.surface, t.level
   from tennis.model_predictions p join tennis.live_matches lm on lm.match_id=p.match_ref
   left join tennis.tournaments t on t.tournament_id=lm.tournament_id`);
const rat = {};
q(`select r.*, p.full_name, p.latest_age from tennis.player_ratings_current r join tennis.players p using (player_id)
   where r.player_id in (select player_a_id from tennis.model_predictions union select player_b_id from tennis.model_predictions)`)
  .forEach((r) => rat[r.player_id] = r);
const logit = (p) => Math.log(p / (1 - p));
const out = [];
preds.forEach((p) => {
  const f = p.inputs.features;
  const rows = M.FEATURE_NAMES.map((n) => ({ n, x: f[n], c: Number(C[n] || 0), contrib: Number(C[n] || 0) * Number(f[n]) }));
  const z = b0 + rows.reduce((s, r) => s + r.contrib, 0);
  const pz = M.sigmoid(z);
  // counterfactual: wire surface elo (clay) the way the archive/model expects
  const A = rat[p.player_a_id], B = rat[p.player_b_id];
  const sf = p.surface;
  const dSurf = (A && B && A[sf + '_elo'] != null && B[sf + '_elo'] != null) ? (Number(A[sf + '_elo']) - Number(B[sf + '_elo'])) / 100 : null;
  const zFix = dSurf == null ? null : z + Number(C.d_surface_elo) * dSurf;
  // lab path
  const lab = LAB.projectMatchup(Object.assign({}, A, { full_name: A.full_name }), Object.assign({}, B, { full_name: B.full_name }),
     { surface: sf, best_of: p.best_of, level: p.level, model: { coefficients: C, intercept: b0, model_version: model.model_version } });
  out.push({ match: p.match_ref, a: p.player_a_name, b: p.player_b_name, surface: sf, best_of: p.best_of,
    stored_prob: Number(p.prob_a), recomputed: pz, z, market: Number(p.market_prob_a),
    gap_pts: (Number(p.prob_a) - Number(p.market_prob_a)) * 100,
    rows: rows.filter((r) => r.contrib !== 0 || r.n === 'd_surface_elo'),
    a_power: A.power_rating, b_power: B.power_rating, a_elo: A.elo, b_elo: B.elo,
    a_surf_elo: A[sf + '_elo'], b_surf_elo: B[sf + '_elo'], dSurf, zFix, pFix: zFix == null ? null : M.sigmoid(zFix),
    lab_prob: lab.prob_a, lab_missing: lab.missing, lab_drivers: lab.drivers.map((d) => [d.feature, d.difference, d.contribution]),
    fair_dec: Number(p.fair_odds_a_decimal), am_a: p.fair_odds_a_american, am_b: p.fair_odds_b_american });
});
out.sort((x, y) => Math.abs(y.gap_pts) - Math.abs(x.gap_pts));
console.log(JSON.stringify({ model: model.model_version, intercept: b0, coefficients: C, rows: out }, null, 1));
