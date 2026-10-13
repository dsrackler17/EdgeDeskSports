'use strict';
/* ===========================================================================
   EdgeDesk NHL — the expected-goals (xG) model.

   A shot-level logistic regression, in the line of the published public
   models (Macdonald, Lennon & Sturdivant 2012, "Evaluating NHL goalies,
   skaters, and teams using weighted shots"; Evolving-Hockey's and MoneyPuck's
   documented feature sets): the probability an unblocked shot attempt
   (on goal, missed, or goal) becomes a goal, from where and how it was taken.

   Features (all observable at the moment of the shot):
     distance        piecewise-linear basis, knots 10/20/30/45/60 ft
     angle           degrees from the centre line; behind-the-goal-line flag
     shot type       wrist (base), snap, slap, backhand, tip/deflection, wrap, other
     rebound         same team's attempt ≤ 3 s earlier
     rush            the previous event ≤ 4 s earlier was outside the attacking zone
     turnover        the opponent gave the puck away / the shooter's team took it ≤ 5 s earlier
     movement        rebound angle change, a cross-slot (royal-road) move ≤ 3 s earlier,
                     puck speed from the previous event, log seconds since it
     previous event  offensive faceoff or hit ≤ 5 s earlier; a second-chance attempt ≤ 6 s
     strength        5v5 (base), other even, power play, short-handed, extra attacker
     interactions    rebound × angle, power play × distance, power play × rebound, tip × distance
   Empty-net attempts get their own two-parameter model (distance only):
   pooling them with defended shots would teach the main model that long
   shots score.

   No player, team or goalie identity enters the model: xG measures the
   chance, so that goalie and finishing skill can be measured against it.

   A model is fitted on a window of seasons strictly BEFORE the season it is
   applied to (hockey/xg/train.js), so no game's xG is informed by its own
   goals or by any later game. The first season of the archive has no prior
   window and is BURN-IN: it is scored in-sample and never validated on.
   =========================================================================== */
const S = require('../../engine/stats');

const VERSION = 'edgedesk_nhl_xg_v1';
const KNOTS = [10, 20, 30, 45, 60];
const TYPES = ['snap', 'slap', 'backhand', 'tip', 'wrap', 'other'];
const NAMES = ['intercept', 'dist', ...KNOTS.map((k) => 'dist_gt' + k), 'angle', 'angle_sq', 'behind',
  ...TYPES.map((t) => 'type_' + t), 'rebound', 'rush', 'turnover', 'st_evo', 'st_pp', 'st_sh', 'st_ena', 'rebound_x_angle', 'pp_x_dist',
  'rebound_angle_change', 'royal_road', 'speed', 'log_since_prev', 'prev_faceoff', 'prev_hit', 'second_chance', 'pp_x_rebound', 'tip_x_dist'];
const EN_NAMES = ['intercept', 'dist'];

function features(s) {
  const d = Math.min(s.dist, 200);
  const a = Math.min(s.angle, 180) / 90;
  const x = [1, d / 10];
  for (const k of KNOTS) x.push(Math.max(0, d - k) / 10);
  x.push(a, a * a, s.angle > 90 ? 1 : 0);
  for (const t of TYPES) x.push(s.type === t ? 1 : 0);
  const sp = s.since_prev;
  const recent = sp != null && sp <= 5;
  /* a turnover in the shooter's favour: the opponent gave it away, or the shooter's team took it */
  const turnover = recent && ((s.prev_type === 'GIVEAWAY' && s.prev_same === 0) || (s.prev_type === 'TAKEAWAY' && s.prev_same === 1)) ? 1 : 0;
  x.push(s.rebound ? 1 : 0, s.rush ? 1 : 0, turnover);
  x.push(s.state === 'evo' ? 1 : 0, s.state === 'pp' ? 1 : 0, s.state === 'sh' ? 1 : 0, s.state === 'ena' ? 1 : 0);
  x.push(s.rebound ? a : 0, s.state === 'pp' ? d / 10 : 0);
  const hasPrev = recent && s.prev_X != null && s.prev_Y != null && s.X != null && s.Y != null;
  /* how far the goalie had to move: the change in shooting angle on a rebound */
  let angChange = 0;
  if (s.rebound && hasPrev) {
    const a1 = Math.atan2(s.Y, 89 - s.X), a0 = Math.atan2(s.prev_Y, 89 - s.prev_X);
    angChange = Math.min(Math.PI, Math.abs(a1 - a0)) / (Math.PI / 2);
  }
  /* the puck crossed the slot's centre line just before the shot (a lateral pass proxy) */
  const royal = hasPrev && sp <= 3 && s.prev_X > 25 && s.prev_Y * s.Y < 0 && Math.abs(s.prev_Y - s.Y) > 10 ? 1 : 0;
  const moved = hasPrev ? Math.sqrt((s.X - s.prev_X) * (s.X - s.prev_X) + (s.Y - s.prev_Y) * (s.Y - s.prev_Y)) : 0;
  const speed = hasPrev ? Math.min(50, moved / Math.max(1, sp)) / 10 : 0;
  x.push(angChange, royal, speed, Math.log1p(Math.min(sp == null ? 60 : sp, 60)));
  x.push(recent && s.prev_type === 'FACEOFF' ? 1 : 0, recent && s.prev_type === 'HIT' ? 1 : 0);
  const second = !s.rebound && sp != null && sp <= 6 && s.prev_same === 1 && (s.prev_type === 'SHOT' || s.prev_type === 'MISSED_SHOT' || s.prev_type === 'BLOCKED_SHOT') ? 1 : 0;
  x.push(second, s.state === 'pp' && s.rebound ? 1 : 0, s.type === 'tip' ? d / 10 : 0);
  return x;
}
function enFeatures(s) { return [1, Math.min(s.dist, 200) / 10]; }
function usable(s) { return s.dist != null && s.angle != null && isFinite(s.dist) && isFinite(s.angle); }

/** fit on shots[] → model object */
function fit(shots, o) {
  o = o || {};
  const main = shots.filter((s) => usable(s) && !s.empty_net && s.state !== 'enf');
  const en = shots.filter((s) => usable(s) && (s.empty_net || s.state === 'enf'));
  const fm = S.logistic(main.map(features), main.map((s) => s.goal), { l2: o.l2 == null ? 1 : o.l2 });
  const fe = en.length >= 200 ? S.logistic(en.map(enFeatures), en.map((s) => s.goal), { l2: 1 }) : null;
  const rate = (arr) => arr.length ? arr.reduce((a, s) => a + s.goal, 0) / arr.length : null;
  return {
    schema: VERSION, names: NAMES, beta: fm.beta.map((b) => +b.toFixed(6)), se: fm.se ? fm.se.map((b) => +b.toFixed(6)) : null,
    en_names: EN_NAMES, en_beta: fe ? fe.beta.map((b) => +b.toFixed(6)) : null,
    fallback: { defended_rate: rate(main), empty_net_rate: rate(en) },
    n_train: main.length, n_train_empty_net: en.length, iterations: fm.iterations,
  };
}

/** a predictor bound to a model object */
function predictor(m, id) {
  return {
    id: id || m.id || VERSION,
    predict(s) {
      const en = s.empty_net || s.state === 'enf';
      if (!usable(s)) return en ? m.fallback.empty_net_rate : m.fallback.defended_rate;
      if (en) return m.en_beta ? S.predictLogistic(m.en_beta, enFeatures(s)) : m.fallback.empty_net_rate;
      return S.predictLogistic(m.beta, features(s));
    },
  };
}

module.exports = { VERSION, NAMES, features, fit, predictor, usable };
