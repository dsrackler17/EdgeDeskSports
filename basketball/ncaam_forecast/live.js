'use strict';
/* ===========================================================================
   Live (in-game) win probability: the pregame distribution, conditioned on
   the observed score and the time left. Pure functions; no feed is read here.

   BASELINE (`score_time`). The regulation margin is the pregame forecast's
   regulation margin (dist.js: mean mu, sd) accrued over 40 minutes. With a
   fraction f of regulation left and the current margin x:
     remaining margin R ~ Normal(mu * f, sd^2 * f + v_pos)
     final regulation margin = x + R, discretised as in dist.js
   (margin increments over disjoint stretches of a game are close to
   independent; sd^2 * f is that random-walk scaling). v_pos is the explicit
   POSSESSION UNCERTAINTY: no feed here reports who has the ball, so the
   unknown possession's worth (about one point either way, half the time) is
   variance, never a guess. A regulation tie goes to overtime, priced exactly
   as pregame (dist.js overtime). In overtime, the period's remaining fraction
   scales the overtime period distribution the same way.
   The pregame endgame tie factor kappa applies to the final tie mass
   (kappa_window_s = 2400: always, so the tip-off number equals the pregame
   one up to v_pos); a narrower window is a challenger the development
   checkpoints judge.

   At zero time left nothing remains to be played: the score decides, or a
   tie goes to (another) overtime at the pregame overtime price. Neither
   v_pos nor kappa applies to a tie that has already happened.

   STRENGTH UPDATE (`shrunk_update`, a challenger). The in-game scoring rate
   so far updates the expected rate for the rest of the game with weight
   w = e / (e + k_update), e = minutes played. The scale of k_update follows
   from a normal-normal update of the margin rate: k = 40 sd^2 / tau^2, with
   sd^2 ~ 120 the game variance and tau^2 ~ 10 the pregame strength
   uncertainty (2 V, validation/strength_uncertainty.json), i.e. several
   hundred minutes; a small k over-reacts to a cold start. The development
   grid spans k = 20 to 640. It is ONLY used if it beats the baseline on the
   development checkpoints (validation/live_backtest.json decides;
   config/live.json records the decision). Score and time already carry
   everything the baseline uses: nothing observed is counted twice.

   NOT MODELLED (no data): shot quality, foul trouble, player injuries or
   lineup changes in-game. They are not inferred from the score.

   FEED SAFETY. checkFeed() suppresses a live signal when the observation is
   stale (older than max_age_s), contradictory (score decreased, period went
   back, clock rose within a period, a final with time left) or incomplete.
   A suppressed game shows "live forecast unavailable" and the pregame number.

   HYSTERESIS. alertState() turns the "live upset threat" label on at
   on_at and off only below off_at, so the label does not flicker. It never
   changes the probability shown.
   =========================================================================== */
const D = require('./dist');

const REG_SECONDS = 2400; const HALF_SECONDS = 1200; const OT_SECONDS = 300;

/** game state -> { phase, remaining_reg_s, remaining_ot_s } (period 1-2 halves, 3+ overtimes) */
function phaseOf(period, clockS) {
  if (!(period >= 1) || !(clockS >= 0)) return null;
  if (period <= 2) { const rem = (2 - period) * HALF_SECONDS + Math.min(HALF_SECONDS, clockS); return { phase: 'regulation', remaining_reg_s: rem, f: rem / REG_SECONDS }; }
  return { phase: 'overtime', ot_period: period - 2, remaining_ot_s: Math.min(OT_SECONDS, clockS), f: Math.min(OT_SECONDS, clockS) / OT_SECONDS };
}

const DEFAULT_LIVE = Object.freeze({ model: 'score_time', v_pos: 1.0, kappa_window_s: 2400, k_update_min: 480 });

/**
 * pre: { mu, sd } pregame regulation (from dist.forecast(...).regulation), cal: the D1 calibration (kappa, ot)
 * st:  { period, clock_s, home_score, away_score }
 */
function liveProb(pre, cal, st, cfg) {
  cfg = Object.assign({}, DEFAULT_LIVE, cfg || {});
  const ph = phaseOf(st.period, st.clock_s);
  if (!ph) return null;
  const x = st.home_score - st.away_score;
  if (ph.f === 0) {
    /* the period is over: decided by the score, or a tie goes to overtime */
    const ot = D.overtime(pre.mu, cal);
    return { p_home: x > 0 ? 1 : x < 0 ? 0 : ot.p_home, p_ot: x === 0 ? 1 : 0, remaining_mean: 0, remaining_sd: 0, phase: ph.phase, f: 0, model: cfg.model };
  }
  if (ph.phase === 'regulation') {
    let muRate = pre.mu;
    if (cfg.model === 'shrunk_update') {
      const played = (REG_SECONDS - ph.remaining_reg_s) / 60;
      if (played > 0) { const w = played / (played + cfg.k_update_min); muRate = (1 - w) * pre.mu + w * (x * REG_SECONDS / (REG_SECONDS - ph.remaining_reg_s)); }
    }
    const m = x + muRate * ph.f;
    const s = Math.sqrt(pre.sd * pre.sd * ph.f + cfg.v_pos);
    const kappa = ph.remaining_reg_s <= cfg.kappa_window_s ? cal.kappa : 1;
    const t = D.tieMass(m, s, kappa);
    /* the overtime price uses the pregame per-period distribution (mu, not the drifted mean) */
    const ot = D.overtime(pre.mu, cal);
    const pAdj = t.scale * (1 - D.Phi((0.5 - m) / s)) + t.p0k * ot.p_home;
    return { p_home: pAdj, p_ot: t.p0k, remaining_mean: m - x, remaining_sd: s, phase: 'regulation', f: ph.f, model: cfg.model };
  }
  /* overtime: this period's remaining share of the per-period distribution; a tie repeats */
  const ot = D.overtime(pre.mu, cal);
  const m = x + ot.mu * ph.f; const s = Math.sqrt(ot.sd * ot.sd * ph.f + cfg.v_pos);
  const win = 1 - D.Phi((0.5 - m) / s); const tie = D.Phi((0.5 - m) / s) - D.Phi((-0.5 - m) / s);
  return { p_home: win + tie * ot.p_home, p_ot: tie, remaining_mean: m - x, remaining_sd: s, phase: 'overtime', f: ph.f, model: cfg.model };
}

/** feed checks: a live signal is shown only when every check passes */
function checkFeed(obs, prev, nowMs, o) {
  o = Object.assign({ max_age_s: 120 }, o || {});
  const reasons = [];
  if (!obs) return { ok: false, reasons: ['no observation'] };
  for (const k of ['period', 'clock_s', 'home_score', 'away_score', 'observed_at']) if (obs[k] == null || (typeof obs[k] === 'number' && !Number.isFinite(obs[k]))) reasons.push('missing ' + k);
  const age = (nowMs - Date.parse(obs.observed_at)) / 1000;
  if (!(age <= o.max_age_s)) reasons.push('stale: ' + (Number.isFinite(age) ? Math.round(age) + ' s old' : 'no timestamp') + ' (limit ' + o.max_age_s + ' s)');
  if (obs.status === 'final' && obs.clock_s > 0) reasons.push('contradictory: final with time left');
  if (prev) {
    if (obs.home_score < prev.home_score || obs.away_score < prev.away_score) reasons.push('contradictory: a score went down');
    if (obs.period < prev.period) reasons.push('contradictory: the period went back');
    if (obs.period === prev.period && obs.clock_s > prev.clock_s + 1) reasons.push('contradictory: the clock went up within a period');
  }
  return { ok: !reasons.length, reasons, age_s: Number.isFinite(age) ? age : null };
}

/** presentation hysteresis for the live upset label (never changes the probability) */
function alertState(prevOn, dogP, o) {
  o = Object.assign({ on_at: 0.40, off_at: 0.33 }, o || {});
  if (!Number.isFinite(dogP)) return false;
  return prevOn ? dogP >= o.off_at : dogP >= o.on_at;
}

/** "slow start": a measurable state, configurable, never a penalty in the probability */
function slowStart(pre, st, o) {
  o = Object.assign({ minutes: 8, points_below: 8 }, o || {});
  const ph = phaseOf(st.period, st.clock_s); if (!ph || ph.phase !== 'regulation') return null;
  const played = (REG_SECONDS - ph.remaining_reg_s) / 60; if (played < o.minutes || played > 20) return null;
  const expected = pre.mu * played / 40; const x = st.home_score - st.away_score;
  return { home_behind_expectation: expected - x >= o.points_below, away_behind_expectation: x - expected >= o.points_below, minutes: played, expected_margin_so_far: expected, observed_margin: x };
}

module.exports = { REG_SECONDS, HALF_SECONDS, OT_SECONDS, DEFAULT_LIVE, phaseOf, liveProb, checkFeed, alertState, slowStart };
