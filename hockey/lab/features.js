'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — the game-level feature vector for the machine-learning
   challengers (Model E: regularised logistic regression, gradient-boosted
   trees). One row per game, from the home side's point of view, built ONLY
   from the two point-in-time snapshots (hockey/model/ratings.js snapshot()
   plus hockey/lab/context.js): nothing about the game itself, nothing later.

   The same function serves the walk-forward and the live slate, so a
   challenger's live probability is computed exactly as it was scored.
   No sportsbook price is ever an input.
   =========================================================================== */
function ln(v) { return Math.log(Math.max(0.2, Math.min(5, v == null || !isFinite(v) ? 1 : v))); }
function n0(v) { return v == null || !isFinite(v) ? 0 : v; }

/* [name, (fh, fa) => value]; fh = home snapshot (home attacking), fa = away snapshot */
const SPEC = [
  ['h_ev_off', (h) => ln(h.ev_off)], ['a_ev_def', (h) => ln(h.ev_def_opp)],
  ['a_ev_off', (h, a) => ln(a.ev_off)], ['h_ev_def', (h, a) => ln(a.ev_def_opp)],
  ['h_g_off', (h) => ln(h.g_off)], ['a_g_def', (h) => ln(h.g_def_opp)],
  ['a_g_off', (h, a) => ln(a.g_off)], ['h_g_def', (h, a) => ln(a.g_def_opp)],
  ['h_pp', (h) => ln(h.pp_off)], ['a_pk', (h) => ln(h.pk_def_opp)], ['a_pp', (h, a) => ln(a.pp_off)], ['h_pk', (h, a) => ln(a.pk_def_opp)],
  ['h_draw', (h) => ln(h.pp_draw)], ['a_take', (h) => ln(h.pk_take_opp)], ['a_draw', (h, a) => ln(a.pp_draw)], ['h_take', (h, a) => ln(a.pk_take_opp)],
  ['h_fin', (h) => ln(h.fin)], ['a_fin', (h, a) => ln(a.fin)],
  ['h_goalie', (h, a) => n0(a.opp_goalie_proj)], ['a_goalie', (h) => n0(h.opp_goalie_proj)],
  ['h_b2b', (h) => n0(h.b2b)], ['a_b2b', (h) => n0(h.b2b_opp)],
  ['h_rest', (h) => n0(h.rest)], ['a_rest', (h) => n0(h.rest_opp)],
  ['h_lineup', (h) => n0(h.lu_own_proj)], ['a_lineup', (h) => n0(h.lu_opp_proj)],
  ['h_travel', (h) => Math.log1p(n0(h.travel_km) / 1000)], ['a_travel', (h) => Math.log1p(n0(h.travel_km_opp) / 1000)],
  ['h_tz', (h) => n0(h.tz_shift)], ['a_tz', (h) => n0(h.tz_shift_opp)],
  ['h_congest', (h) => n0(h.games_3d)], ['a_congest', (h) => n0(h.games_3d_opp)],
  ['a_road_len', (h) => n0(h.road_len_opp)],
  ['h_form_off', (h) => n0(h.form_off)], ['h_form_def', (h) => n0(h.form_def)], ['a_form_off', (h) => n0(h.form_off_opp)], ['a_form_def', (h) => n0(h.form_def_opp)],
  ['h_luck_fin', (h) => n0(h.luck_fin)], ['h_luck_sv', (h) => n0(h.luck_sv)], ['a_luck_fin', (h) => n0(h.luck_fin_opp)], ['a_luck_sv', (h) => n0(h.luck_sv_opp)],
  ['h_games', (h) => Math.min(82, n0(h.season_games)) / 82], ['a_games', (h) => Math.min(82, n0(h.season_games_opp)) / 82],
  ['playoff', (h) => n0(h.playoff)],
];
const NAMES = SPEC.map((s) => s[0]);
function row(fh, fa) { return SPEC.map((s) => s[1](fh, fa)); }

module.exports = { NAMES, SPEC, row };
