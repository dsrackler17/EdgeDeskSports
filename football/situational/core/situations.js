/* ============================================================================
   FSIE — situation classification. One function, both sports: the thresholds
   come from config/situations_v1.json, the sport chooses the block. Every flag
   is computed from the state BEFORE the snap (down, distance, yards to goal,
   clock, score) — never from anything the play itself produced.
   ========================================================================== */
'use strict';
const path = require('path');
const DEF = require(path.join(__dirname, '..', 'config', 'situations_v1.json'));

function cfgFor(sport, defs) {
  const d = defs || DEF;
  const c = d.sports[sport];
  if (!c) throw new Error('situations: unknown sport ' + sport);
  return c;
}

/* seconds left in the current half, from period and the period clock */
function halfSecondsLeft(period, secLeftInPeriod) {
  if (period === 1 || period === 3) return secLeftInPeriod + 900;
  if (period === 2 || period === 4) return secLeftInPeriod;
  return null;                                     /* overtime: no half */
}
function gameSecondsLeft(period, secLeftInPeriod) {
  if (period >= 1 && period <= 4) return (4 - period) * 900 + secLeftInPeriod;
  return 0;
}

/* p: { down, distance, yards_to_goal, goal_to_go, period, sec_left_period, score_diff } */
function classify(p, sport, defs) {
  const c = cfgFor(sport, defs);
  const out = {
    early_down: false, passing_down: false, short_yardage: false, third_down: false,
    red_zone: false, goal_to_go: false, goal_line: false, two_minute: false,
    garbage_time: false, late_clock: false, late_clock_leading: false, late_clock_trailing: false,
    neutral: false, leading: false, trailing: false, first_half: false, second_half: false, overtime: false
  };
  const dn = p.down, dist = p.distance, ytg = p.yards_to_goal, per = p.period, diff = p.score_diff;
  if (dn === 1 || dn === 2) out.early_down = true;
  if (dn === 3) out.third_down = true;
  if (dist != null && ((dn === 2 && dist >= c.passing_down.second_min) || ((dn === 3 || dn === 4) && dist >= c.passing_down.late_min))) out.passing_down = true;
  if (dist != null && (dn === 3 || dn === 4) && dist <= c.short_yardage.max_distance) out.short_yardage = true;
  if (ytg != null && ytg <= c.red_zone.max_yards_to_goal) out.red_zone = true;
  if (p.goal_to_go === true || (dist != null && ytg != null && dist >= ytg)) out.goal_to_go = true;
  if (out.goal_to_go && ytg != null && ytg <= c.goal_line.max_yards_to_goal) out.goal_line = true;
  if (per === 1 || per === 2) out.first_half = true;
  else if (per === 3 || per === 4) out.second_half = true;
  else if (per > 4) out.overtime = true;
  const hs = per != null && p.sec_left_period != null ? halfSecondsLeft(per, p.sec_left_period) : null;
  if (hs != null && hs <= c.two_minute.seconds) out.two_minute = true;
  if (diff != null && per >= 1 && per <= 4) {
    const t = c.garbage.by_quarter[String(per)];
    if (t != null && Math.abs(diff) >= t) out.garbage_time = true;
  }
  const gs = per != null && p.sec_left_period != null ? gameSecondsLeft(per, p.sec_left_period) : null;
  if (per >= 4 && gs != null && gs <= c.late_clock.seconds && diff != null) {
    out.late_clock = true;
    if (diff > 0) out.late_clock_leading = true; else if (diff < 0) out.late_clock_trailing = true;
  }
  if (diff != null && per != null && per <= c.neutral.max_period && Math.abs(diff) <= c.neutral.max_abs_diff && !out.two_minute && !out.garbage_time) out.neutral = true;
  if (diff != null && !out.garbage_time) {
    if (diff >= c.script.lead_min) out.leading = true;
    else if (diff <= -c.script.lead_min) out.trailing = true;
  }
  return out;
}

/* The script state used by the volume model: exactly one of these per play */
function scriptState(flags) {
  if (flags.garbage_time) return 'garbage';
  if (flags.two_minute) return 'two_minute';
  if (flags.leading) return 'leading';
  if (flags.trailing) return 'trailing';
  return 'competitive';
}

module.exports = { classify, scriptState, halfSecondsLeft, gameSecondsLeft, VERSION: DEF.version, DEFS: DEF };
