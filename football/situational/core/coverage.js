/* ============================================================================
   FSIE — coverage inventory, measured independently for each sport.

   The eligible team universe is the season's own schedule: every NFL team on
   it; every team whose schedule division is `fbs` (FCS opponents are listed
   separately, with their games against FBS teams). Every eligible team
   appears, including the ones with nothing usable — those carry tier D and
   the reason, never a silent absence.

   Tiers (config/quality_v1.json):
     A  accepted play-by-play AND observed formation detail on >= half of the
        team's accepted plays (NFL: pbp shotgun/no-huddle + FTN charting;
        college: the stat crew's formation tokens)
     B  accepted play-by-play without that detail
     C  no accepted play-by-play this season, but a final score on the schedule
     D  nothing trustworthy
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const Q = require(path.join(__dirname, '..', 'config', 'quality_v1.json'));

function hours(a, b) { return a && b ? U.round((Date.parse(b) - Date.parse(a)) / 3600000, 1) : null; }

function build(sport, d, opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const grace = (opts.grace_hours == null ? 6 : opts.grace_hours) * 3600000;
  const sched = (d.schedule || []).filter((g) => g.season_type === 'REG' || g.season_type === 'POST' || !g.season_type);
  const isFbs = (div) => div === 'fbs';
  const eligible = new Set(), fcs = new Set(), names = {}, conf = {};
  sched.forEach((g) => {
    [['home', g.home, g.home_division, g.home_name, g.home_conference], ['away', g.away, g.away_division, g.away_name, g.away_conference]].forEach(([, t, div, nm, cf]) => {
      if (!t) return;
      if (sport === 'nfl' || isFbs(div)) eligible.add(t); else fcs.add(t);
      if (nm) names[t] = nm; if (cf) conf[t] = cf;
    });
  });
  const tg = {}; d.team_games.forEach((r) => { tg[r.game_id + '|' + r.team] = r; });
  const games = d.games || {};
  const nowMs = Date.parse(now);
  const expectedGame = (g) => g.completed || (g.kickoff_at && Date.parse(g.kickoff_at) + grace < nowMs);
  const teams = {};
  const ensure = (t) => teams[t] || (teams[t] = { team: t, name: names[t] || t, conference: conf[t] || null, division: sport === 'nfl' ? 'nfl' : (eligible.has(t) ? 'fbs' : 'fcs'),
    games_scheduled: 0, games_expected: 0, games_available: 0, games_accepted: 0, games_situation_ok: 0, games_player_ok: 0, games_rejected: 0,
    rejected: [], plays_accepted: 0, formation_observed_plays: 0, last_game_at: null, missing_fields: [] });
  Array.from(eligible).concat(Array.from(fcs)).forEach(ensure);
  const weeks = {};
  sched.forEach((g) => {
    const exp = expectedGame(g);
    [g.home, g.away].forEach((t) => {
      if (!t) return;
      const T = ensure(t); T.games_scheduled++;
      if (!exp) return;
      T.games_expected++;
      const r = tg[g.game_id + '|' + t];
      if (r) {
        T.games_available++;
        if (r.quality.volume_ok) { T.games_accepted++; T.plays_accepted += r.counts.plays; T.formation_observed_plays += Math.max(r.form.charted || 0, (r.form.ftn && r.form.ftn.n) || 0); if (!T.last_game_at || String(r.kickoff_at) > T.last_game_at) T.last_game_at = r.kickoff_at; }
        else { T.games_rejected++; T.rejected.push({ game_id: g.game_id, reasons: (games[g.game_id] ? games[g.game_id].reasons : []).concat(r.quality.reasons) }); }
        if (r.quality.situation_ok) T.games_situation_ok++;
        if (r.quality.player_ok) T.games_player_ok++;
      } else if (games[g.game_id] == null) T.rejected.push({ game_id: g.game_id, reasons: ['not_in_source'] });
    });
    if (g.season_type === 'REG' || !g.season_type) {
      const w = weeks[g.week] || (weeks[g.week] = { week: g.week, scheduled: 0, expected: 0, available: 0, accepted: 0 });
      w.scheduled++;
      if (exp) { w.expected++; if (games[g.game_id]) w.available++; if (games[g.game_id] && games[g.game_id].status !== 'rejected') w.accepted++; }
    }
  });
  const thr = Q.tier_thresholds;
  Object.values(teams).forEach((T) => {
    const share = T.plays_accepted ? T.formation_observed_plays / T.plays_accepted : 0;
    T.formation_observed_share = U.round(share, 3);
    const hasResult = sched.some((g) => (g.home === T.team || g.away === T.team) && g.completed && g.home_score != null);
    T.tier = T.games_accepted >= thr.min_games_b ? (share >= thr.formation_min_share ? 'A' : 'B') : (hasResult ? 'C' : 'D');
    if (T.games_expected > T.games_available) T.missing_fields.push((T.games_expected - T.games_available) + ' expected game(s) not in the play-by-play source');
    if (sport === 'cfb') {
      T.missing_fields.push('personnel and coverage: no public college feed');
      if (share < thr.formation_min_share) T.missing_fields.push('formation tokens on ' + Math.round(share * 100) + '% of accepted plays');
      /* the feed writes "Shotgun" / "No Huddle" but never "under center" or "huddle", so a
         rate's denominator is the plays it marked: a play it left unmarked cannot count against */
      if (share > 0) T.missing_fields.push('shotgun / no-huddle rates are over the plays the feed marked; it never marks under-center or huddle, so both can read high');
      T.missing_fields.push('scrambles not distinguishable from designed runs (ESPN)');
      T.missing_fields.push('availability / injury report: no public college feed');
    } else {
      if (d.charting && d.charting.participation && !d.charting.participation.available) T.missing_fields.push('personnel / coverage: ' + d.charting.participation.reason);
      if (d.charting && d.charting.ftn && !d.charting.ftn.available) T.missing_fields.push('FTN charting: ' + d.charting.ftn.reason);
    }
    T.rejected = T.rejected.slice(0, 12);
  });
  const elig = Object.values(teams).filter((t) => t.division !== 'fcs');
  const wk = Object.values(weeks).sort((a, b) => a.week - b.week);
  let latestComplete = null;
  wk.forEach((w) => { if (w.expected > 0 && w.expected === w.scheduled && w.available === w.expected) latestComplete = w.week; });
  const src = (d.sources || [])[1] || (d.sources || [])[0] || {};
  const tierCount = { A: 0, B: 0, C: 0, D: 0 }; elig.forEach((t) => { tierCount[t.tier]++; });
  const gStatus = { accepted: 0, partial: 0, rejected: 0 }; Object.values(games).forEach((g) => { gStatus[g.status] = (gStatus[g.status] || 0) + 1; });
  const expectedGames = sched.filter((g) => expectedGame(g) && (sport === 'nfl' || eligible.has(g.home) || eligible.has(g.away)));
  const availableGames = expectedGames.filter((g) => games[g.game_id]);
  return {
    sport, season: d.season, built_at: now, quality_version: Q.version, situations_version: d.situations_version,
    eligible_teams: elig.length, ingested_teams: elig.filter((t) => t.games_accepted > 0).length,
    tiers: tierCount, fcs_teams_listed: Object.values(teams).filter((t) => t.division === 'fcs').length,
    games: { scheduled: sched.length, expected: expectedGames.length, available: availableGames.length, missing: expectedGames.length - availableGames.length,
      accepted: gStatus.accepted || 0, partial: gStatus.partial || 0, rejected: gStatus.rejected || 0 },
    team_games: { total: d.team_games.length, volume_ok: d.team_games.filter((r) => r.quality.volume_ok).length, situation_ok: d.team_games.filter((r) => r.quality.situation_ok).length, player_ok: d.team_games.filter((r) => r.quality.player_ok).length },
    play_failures: d.play_failures, excluded_play_kinds: d.excluded_play_kinds,
    latest_complete_week: latestComplete, weeks: wk,
    freshness: { source: src.name || null, source_last_modified: src.last_modified || null, pulled_at: src.pulled_at || null,
      hours_since_pull: hours(src.pulled_at, now), stale: src.pulled_at ? hours(src.pulled_at, now) > Q.freshness[sport].stale_after_hours_in_season : true },
    charting: d.charting, sources: d.sources,
    missing_games: expectedGames.filter((g) => !games[g.game_id]).map((g) => ({ game_id: g.game_id, week: g.week, home: g.home, away: g.away, kickoff_at: g.kickoff_at })).slice(0, 50),
    teams: Object.values(teams).sort((a, b) => (a.division === b.division ? String(a.name).localeCompare(String(b.name)) : (a.division === 'fcs' ? 1 : -1)))
  };
}

module.exports = { build };
