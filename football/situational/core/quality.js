/* ============================================================================
   FSIE — data-quality gates. Thresholds come from config/quality_v1.json.

   Three scopes, three consequences:
     source  a missing required column (a schema change) fails the whole
             sport-season load: nothing from it is published as complete.
     game    a failed game check rejects the game (or one team's side of it)
             for the outputs that depend on that check, with the reason kept.
     play    a play with an impossible down, distance, yard line, clock or
             score is kept in the volume count (the snap happened) but is
             excluded from every situational rate that reads the bad field.
   Player attribution is gated separately: a game whose passer/rusher/target
   ids are too sparse is accepted for team volume and rejected for player
   usage, never the other way round.
   ========================================================================== */
'use strict';
const path = require('path');
const Q = require(path.join(__dirname, '..', 'config', 'quality_v1.json'));

function checkSchema(header, kind) {
  const req = Q.schema_fingerprint_required_columns[kind] || [];
  const have = new Set(header || []);
  const missing = req.filter((c) => !have.has(c));
  return { ok: missing.length === 0, missing, required: req.length, version: Q.version };
}

/* play-level: returns the list of failed checks (empty = clean) */
function checkPlay(p, sport) {
  const c = Q.play; const f = [];
  if (!p.off || !p.def) f.push('missing_team');
  if (!p.game_id) f.push('missing_game_id');
  if (!p.src) f.push('missing_source_version');
  if (p.period == null || p.period < c.period.min || p.period > c.period.max) f.push('invalid_period');
  /* periods 1-4 run 15:00; NFL overtime is 10:00 (regular season) or 15:00
     (postseason); college overtime has no clock, so only the sign is checked */
  if (p.sec_left_period == null || p.sec_left_period < c.seconds_left_in_period.min || p.sec_left_period > c.seconds_left_in_period.max) f.push('invalid_clock');
  if (p.down == null || p.down < c.down.min || p.down > c.down.max) f.push('invalid_down');
  if (p.distance == null || p.distance < c.distance.min || p.distance > c.distance.max) f.push('invalid_distance');
  if (p.yards_to_goal == null || p.yards_to_goal < c.yards_to_goal.min || p.yards_to_goal > c.yards_to_goal.max) f.push('impossible_yardline');
  if (p.distance != null && p.yards_to_goal != null && p.distance > p.yards_to_goal) f.push('distance_exceeds_goal');
  if (p.score_off == null || p.score_def == null) f.push('missing_score');
  if (p.kind === 'conflict') f.push('conflicting_classification');
  if (p.kind === 'unclassified') f.push('unclassified_play');
  if (p.kind === 'pass' && !p.passer_id) f.push('missing_passer');
  if ((p.kind === 'rush' || p.kind === 'scramble') && !p.rusher_id) f.push('missing_rusher');
  if (p.kind === 'pass' && !p.spike && !p.target_id) f.push('missing_target');
  return f;
}
const SITUATION_FIELDS = { invalid_down: 1, invalid_distance: 1, impossible_yardline: 1, distance_exceeds_goal: 1, invalid_clock: 1, invalid_period: 1, missing_score: 1, missing_team: 1, score_inconsistent: 1 };

/* SCORE SEQUENCE. Both feeds carry score corrections and, in the college
   feed's derived columns, the odd impossible value (a negative score, a 50-0
   lead in the first quarter of a 21-14 game). Rejecting a whole game for one
   bad row throws away 150 good plays; trusting the row mislabels its script.
   So: the pre-snap score (home perspective) of every play must lie on a
   non-decreasing path that ends at or below the final score. The plays that
   are NOT on the longest such path (computed per side) are the minimal set
   inconsistent with any real scoring sequence; their score — and only their
   score — is invalid. A game where that set is large is unreliable.
   plays must already be in snap order. -> Set of play_id */
function scoreFlags(plays, finalHome, finalAway) {
  const flagged = new Set();
  const hs = [], as = [], idx = [];
  plays.forEach((p, i) => {
    if (p.score_off == null || p.score_def == null || p.off_is_home == null) return;
    const h = p.off_is_home ? p.score_off : p.score_def, a = p.off_is_home ? p.score_def : p.score_off;
    if (h < 0 || a < 0 || (finalHome != null && h > finalHome) || (finalAway != null && a > finalAway)) { flagged.add(p.play_id); return; }
    hs.push(h); as.push(a); idx.push(i);
  });
  [hs, as].forEach((v) => {
    const n = v.length; if (!n) return;
    /* longest non-decreasing subsequence, O(n log n), with back-pointers */
    const tailVal = [], tailIdx = [], prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      let lo = 0, hi = tailVal.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (tailVal[m] <= v[i]) lo = m + 1; else hi = m; }
      if (lo > 0) prev[i] = tailIdx[lo - 1];
      tailVal[lo] = v[i]; tailIdx[lo] = i;
    }
    const keep = new Set(); let k = tailIdx[tailVal.length - 1];
    while (k >= 0) { keep.add(k); k = prev[k]; }
    for (let i = 0; i < n; i++) if (!keep.has(i)) flagged.add(plays[idx[i]].play_id);
  });
  return flagged;
}
function situationValid(fails) { for (const x of fails) if (SITUATION_FIELDS[x]) return false; return true; }

/* game-level gate over the game's normalized plays plus the schedule row.
   -> { game_id, status, reasons[], teams{tid:{volume_ok, player_ok, reasons[]}}, metrics{} } */
function checkGame(sport, gameId, plays, sched, opts) {
  opts = opts || {};
  const g = Q.game[sport];
  const reasons = [];
  const teams = {};
  const home = sched ? sched.home : (plays[0] && plays[0].home);
  const away = sched ? sched.away : (plays[0] && plays[0].away);
  if (!sched) reasons.push('not_in_schedule');
  const seen = new Set(); let dup = 0;
  const per = {}; [home, away].forEach((t) => { if (t) per[t] = { plays: 0, invalid: 0, unclassified: 0, pass: 0, nopasser: 0, rush: 0, norusher: 0, target_needed: 0, notarget: 0 }; });
  let mapping = 0, maxPeriod = 0, scoreBad = 0;
  const ordered = plays.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const p of ordered) {
    const k = p.play_id; if (seen.has(k)) dup++; seen.add(k);
    if (p.off !== home && p.off !== away) { mapping++; continue; }
    if (p.def !== home && p.def !== away) { mapping++; continue; }
    const t = per[p.off];
    const fails = p._fails || checkPlay(p, sport);
    t.plays++;
    if (!situationValid(fails)) t.invalid++;
    if (p.kind === 'unclassified' || p.kind === 'conflict') t.unclassified++;
    if (p.kind === 'pass') { t.pass++; if (!p.passer_id) t.nopasser++; if (!p.spike) { t.target_needed++; if (!p.target_id) t.notarget++; } }
    if (p.kind === 'rush' || p.kind === 'scramble') { t.rush++; if (!p.rusher_id) t.norusher++; }
    if (p.period > maxPeriod) maxPeriod = p.period;
    if (fails.indexOf('score_inconsistent') >= 0) scoreBad++;
  }
  if (dup) reasons.push('duplicate_plays:' + dup);
  if (mapping) reasons.push('invalid_team_mapping:' + mapping);
  if (maxPeriod < 4) reasons.push('incomplete_game:max_period_' + maxPeriod);
  const warnings = [];
  if (scoreBad) warnings.push('score_sequence_corrected:' + scoreBad);
  if (ordered.length && scoreBad / ordered.length > g.max_score_inconsistent_share) reasons.push('score_sequence_unreliable:' + scoreBad);
  const f = plays.find((p) => p.final_home != null);
  if (g.score_must_match_final && sched && sched.home_score != null && f && (f.final_home !== sched.home_score || f.final_away !== sched.away_score)) reasons.push('final_score_mismatch');
  const sourceFinal = sport === 'cfb' ? (plays.length && plays[0].completed === true) : null;
  if (sport === 'cfb' && plays.length && plays[0].completed === false) reasons.push('source_not_final');
  /* the schedule can lag the play feed by a day; a game the source itself
     marks final is kept and the lag is a warning */
  if (sched && sched.completed === false) { if (sourceFinal) warnings.push('schedule_lags_source_final'); else reasons.push('schedule_not_completed'); }
  if (!plays.length || plays.some((p) => !p.src)) reasons.push('missing_source_version');
  const total = Object.values(per).reduce((s, t) => s + t.plays, 0);
  if (total < g.scrimmage_plays_per_game.min || total > g.scrimmage_plays_per_game.max) reasons.push('game_play_count_out_of_range:' + total);
  const gameFatal = reasons.some((r) => /^(duplicate_plays|invalid_team_mapping|incomplete_game|score_sequence_unreliable|final_score_mismatch|schedule_not_completed|source_not_final|missing_source_version|game_play_count|not_in_schedule)/.test(r));
  Object.keys(per).forEach((tid) => {
    const t = per[tid]; const tr = [];
    if (t.plays < g.scrimmage_plays_per_team.min || t.plays > g.scrimmage_plays_per_team.max) tr.push('team_play_count_out_of_range:' + t.plays);
    if (t.plays && t.unclassified / t.plays > g.max_unclassified_share) tr.push('unclassified_share:' + (t.unclassified / t.plays).toFixed(3));
    /* bad down/distance/clock/score fields void the situational cells, not the snap count */
    const sr = [];
    if (t.plays && t.invalid / t.plays > g.max_invalid_play_share) sr.push('invalid_situation_share:' + (t.invalid / t.plays).toFixed(3));
    const box = opts.box && opts.box[gameId + '|' + tid];
    if (box && opts.counts && opts.counts[tid]) {
      const c = opts.counts[tid];
      if (Math.abs(c.pass_att - box.pass_att) > g.box_check_tolerance.pass_attempts) tr.push('box_mismatch_pass_attempts:' + c.pass_att + '_vs_' + box.pass_att);
      if (Math.abs(c.rush_att - box.rush_att) > g.box_check_tolerance.rush_attempts) tr.push('box_mismatch_rush_attempts:' + c.rush_att + '_vs_' + box.rush_att);
    }
    const pr = [];
    if (t.pass && t.nopasser / t.pass > g.max_missing_passer_share) pr.push('missing_passer_share:' + (t.nopasser / t.pass).toFixed(3));
    if (t.rush && t.norusher / t.rush > g.max_missing_rusher_share) pr.push('missing_rusher_share:' + (t.norusher / t.rush).toFixed(3));
    if (t.target_needed && t.notarget / t.target_needed > g.max_missing_target_share) pr.push('missing_target_share:' + (t.notarget / t.target_needed).toFixed(3));
    const volumeOk = !gameFatal && tr.length === 0;
    teams[tid] = { volume_ok: volumeOk, situation_ok: volumeOk && sr.length === 0, player_ok: volumeOk && pr.length === 0, reasons: tr.concat(sr, pr), plays: t.plays };
  });
  const anyOk = Object.values(teams).some((t) => t.volume_ok);
  const allOk = Object.values(teams).length === 2 && Object.values(teams).every((t) => t.volume_ok);
  return { game_id: gameId, status: allOk ? 'accepted' : (anyOk ? 'partial' : 'rejected'), reasons, warnings, teams, metrics: { plays: total, max_period: maxPeriod, score_inconsistent: scoreBad } };
}

/* After a season's games are aggregated: a team-game whose play count is far
   below that team's own distribution is flagged (warning, kept), because the
   same expected count for every team is exactly what the config forbids. */
function lowVolumeFlags(teamGames) {
  const by = {};
  teamGames.forEach((r) => { if (r.quality && r.quality.volume_ok) (by[r.team] = by[r.team] || []).push(r); });
  const flags = [];
  Object.keys(by).forEach((t) => {
    const xs = by[t].map((r) => r.counts.plays);
    if (xs.length < 4) return;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
    const sd = Math.sqrt(v) || 1;
    by[t].forEach((r) => { const z = (r.counts.plays - m) / sd; if (z < Q.team_low_volume_z) flags.push({ game_id: r.game_id, team: t, plays: r.counts.plays, z: Math.round(z * 100) / 100 }); });
  });
  return flags;
}

module.exports = { checkSchema, checkPlay, checkGame, situationValid, scoreFlags, lowVolumeFlags, CONFIG: Q, VERSION: Q.version };
