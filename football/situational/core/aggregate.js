/* ============================================================================
   FSIE — normalized plays -> team-game situational observations and
   player-game opportunity rows. Everything downstream (tendencies, models,
   coverage, the cards) reads these rows; nothing downstream reads plays.

   A play whose situation fields failed a quality check still counts toward
   the team's volume (the snap happened) and is left out of every situational
   cell. Formation fields are counted only where observed; the denominator of
   every formation share is the number of plays on which it was observed.
   ========================================================================== */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'situations.js'));
const QC = require(path.join(__dirname, 'quality.js'));

const SIT_KEYS = ['neutral', 'early_down', 'passing_down', 'third_down', 'short_yardage', 'red_zone', 'goal_to_go', 'goal_line',
  'two_minute', 'garbage_time', 'leading', 'trailing', 'late_clock_leading', 'late_clock_trailing', 'first_half', 'second_half'];
const SCRIPTS = ['competitive', 'leading', 'trailing', 'garbage', 'two_minute'];

function cell() { return { n: 0, db: 0, rush: 0 }; }
function emptyRow(sport, g, team, opp) {
  const sit = {}; SIT_KEYS.forEach((k) => { sit[k] = cell(); });
  const script = {}; SCRIPTS.forEach((k) => { script[k] = cell(); });
  return {
    sport, season: g.season, week: g.week, season_type: g.season_type, game_id: g.game_id, kickoff_at: g.kickoff_at || null,
    team, opp, is_home: team === g.home, neutral_site: !!g.neutral_site,
    counts: { plays: 0, pass_att: 0, rush_att: 0, sacks: 0, scrambles: 0, kneels: 0, spikes: 0, dropbacks: 0, designed_rush: 0, drives: 0,
      points: null, opp_points: null, unclassified: 0, invalid_situation: 0 },
    sit, script,
    pace: { neutral_sec: 0, neutral_pairs: 0, all_sec: 0, all_pairs: 0 },
    form: { charted: 0, shotgun: 0, no_huddle: 0,
      ftn: { n: 0, motion: 0, play_action: 0, rpo: 0, screen: 0, box_sum: 0, box_n: 0, box8_rush: 0, rush_n: 0, blitz_sum: 0, blitz_n: 0 },
      part: { n: 0, personnel: {}, formation: {}, box_sum: 0, box_n: 0, coverage: {}, man_zone: {} } },
    market: { spread_margin: null, total_line: null, source: null }
  };
}

/* plays: one season's normalized plays (any order). sched: {game_id: row}.
   extra: { ftn: Map|null, part: Map|null, box: {gid|team:{pass_att,rush_att}} }
   -> { team_games[], player_games[], games{gid:{quality,...}}, play_failures{check:count} } */
function aggregateSeason(sport, plays, sched, extra) {
  extra = extra || {};
  const byGame = new Map();
  for (const p of plays) { if (!p.game_id) continue; let a = byGame.get(p.game_id); if (!a) { a = []; byGame.set(p.game_id, a); } a.push(p); }
  const teamGames = []; const playerGames = []; const games = {}; const playFailures = {};
  for (const [gid, gp] of byGame) {
    gp.sort((a, b) => (a.seq || 0) - (b.seq || 0) || String(a.play_id).localeCompare(String(b.play_id)));
    const s = sched[gid] || null;
    const g = { game_id: gid, season: gp[0].season, week: gp[0].week, season_type: gp[0].season_type, home: s ? s.home : gp[0].home, away: s ? s.away : gp[0].away,
      kickoff_at: s ? s.kickoff_at : null, neutral_site: s ? s.neutral_site : false };
    const fin0 = gp.find((p) => p.final_home != null) || {};
    const fh = s && s.home_score != null ? s.home_score : (fin0.final_home != null ? fin0.final_home : null);
    const fa = s && s.away_score != null ? s.away_score : (fin0.final_away != null ? fin0.final_away : null);
    const scoreBad = QC.scoreFlags(gp.filter((p) => p.off === g.home || p.off === g.away), fh, fa);
    for (const p of gp) {
      p._fails = QC.checkPlay(p, sport);
      if (scoreBad.has(p.play_id)) p._fails.push('score_inconsistent');
      p._fails.forEach((f) => { playFailures[f] = (playFailures[f] || 0) + 1; });
    }
    const rows = {}; rows[g.home] = emptyRow(sport, g, g.home, g.away); rows[g.away] = emptyRow(sport, g, g.away, g.home);
    const players = {};
    const drives = { [g.home]: new Set(), [g.away]: new Set() };
    let prev = null; const firstDb = {};
    for (const p of gp) {
      const r = rows[p.off]; if (!r || p.def !== r.opp) { prev = null; continue; }
      const c = r.counts;
      const isPlay = p.kind === 'pass' || p.kind === 'spike' || p.kind === 'sack' || p.kind === 'scramble' || p.kind === 'rush' || p.kind === 'kneel';
      if (p.kind === 'unclassified' || p.kind === 'conflict') { c.unclassified++; prev = null; continue; }
      if (!isPlay) { prev = null; continue; }
      c.plays++;
      if (p.pass_attempt) c.pass_att++;
      if (p.rush_attempt) c.rush_att++;
      if (p.sack) c.sacks++;
      if (p.scramble) c.scrambles++;
      if (p.kneel) c.kneels++;
      if (p.spike) c.spikes++;
      if (p.dropback) c.dropbacks++;
      if (p.kind === 'rush') c.designed_rush++;
      if (p.drive_id) drives[p.off].add(p.drive_id);
      const valid = QC.situationValid(p._fails);
      if (!valid) c.invalid_situation++;
      /* pass rate in a situation = dropbacks / plays, excluding kneels and spikes
         (clock plays say nothing about play-calling) */
      const callable = !p.kneel && !p.spike;
      if (valid && callable) {
        const fl = S.classify(p, sport);
        for (const k of SIT_KEYS) if (fl[k]) { const x = r.sit[k]; x.n++; if (p.dropback) x.db++; else x.rush++; }
        const st = S.scriptState(fl); const x = r.script[st]; x.n++; if (p.dropback) x.db++; else x.rush++;
        /* pace: game seconds between consecutive snaps of the same drive */
        if (prev && prev.drive_id && prev.drive_id === p.drive_id && prev.period === p.period && prev.sec_left_game != null && p.sec_left_game != null) {
          const gap = prev.sec_left_game - p.sec_left_game;
          if (gap >= 3 && gap <= 60) { r.pace.all_sec += gap; r.pace.all_pairs++; if (prev._neutral && fl.neutral) { r.pace.neutral_sec += gap; r.pace.neutral_pairs++; } }
        }
        p._neutral = fl.neutral;
      }
      prev = p;
      /* formation, observed only */
      if (p.shotgun != null) { r.form.charted++; if (p.shotgun) r.form.shotgun++; if (p.no_huddle) r.form.no_huddle++; }
      const key = gid + '|' + p.play_id;
      const ft = extra.ftn ? extra.ftn.get(key) : null;
      if (ft && callable) {
        const F = r.form.ftn; F.n++;
        if (ft.motion) F.motion++; if (ft.play_action) F.play_action++; if (ft.rpo) F.rpo++; if (ft.screen) F.screen++;
        if (ft.n_box != null) { F.box_sum += ft.n_box; F.box_n++; if (!p.dropback) { F.rush_n++; if (ft.n_box >= 8) F.box8_rush++; } }
        if (ft.n_blitzers != null && p.dropback) { F.blitz_sum += ft.n_blitzers; F.blitz_n++; }
      }
      const pt = extra.part ? extra.part.get(key) : null;
      if (pt && callable) {
        const P = r.form.part; P.n++;
        if (pt.off_personnel) P.personnel[pt.off_personnel] = (P.personnel[pt.off_personnel] || 0) + 1;
        if (pt.formation) P.formation[pt.formation] = (P.formation[pt.formation] || 0) + 1;
        if (pt.box != null) { P.box_sum += pt.box; P.box_n++; }
        if (pt.coverage && p.dropback) P.coverage[pt.coverage] = (P.coverage[pt.coverage] || 0) + 1;
        if (pt.man_zone && p.dropback) P.man_zone[pt.man_zone] = (P.man_zone[pt.man_zone] || 0) + 1;
      }
      /* player usage */
      const pg = (id, name) => { if (!id) return null; const k2 = p.off + '|' + id; let u = players[k2]; if (!u) { u = players[k2] = { team: p.off, player_id: id, name: name || null, pass_att: 0, sacks_taken: 0, dropbacks: 0, scrambles: 0, rush_att: 0, designed_rush: 0, kneels: 0, targets: 0, receptions: 0, started: false }; } if (!u.name && name) u.name = name; return u; };
      if (p.dropback || p.spike) {
        const qb = pg(p.passer_id || (p.scramble ? p.rusher_id : null), p.passer_name || (p.scramble ? p.rusher_name : null));
        if (qb) {
          if (p.pass_attempt) qb.pass_att++;
          if (p.sack) qb.sacks_taken++;
          if (p.dropback) { qb.dropbacks++; if (!firstDb[p.off]) { firstDb[p.off] = qb.player_id; qb.started = true; } }
        }
      }
      if (p.rush_attempt) {
        const ru = pg(p.rusher_id || (p.kneel ? p.passer_id : null), p.rusher_name);
        if (ru) { ru.rush_att++; if (p.kind === 'rush') ru.designed_rush++; if (p.scramble) ru.scrambles++; if (p.kneel) ru.kneels++; }
      }
      if (p.kind === 'pass' && !p.spike && p.target_id) { const tg = pg(p.target_id, p.target_name); if (tg) { tg.targets++; if (p.complete) tg.receptions++; } }
    }
    const fin = gp.find((p) => p.final_home != null) || {};
    const homePts = s && s.home_score != null ? s.home_score : (fin.final_home != null ? fin.final_home : null);
    const awayPts = s && s.away_score != null ? s.away_score : (fin.final_away != null ? fin.final_away : null);
    const counts = {}; Object.keys(rows).forEach((t) => { counts[t] = rows[t].counts; });
    const qg = QC.checkGame(sport, gid, gp, s, { box: extra.box, counts });
    games[gid] = { game_id: gid, week: g.week, season_type: g.season_type, home: g.home, away: g.away, kickoff_at: g.kickoff_at, status: qg.status, reasons: qg.reasons, warnings: qg.warnings, teams: qg.teams, plays: qg.metrics.plays };
    const homeMargin = sched[gid] && sched[gid].home_spread_margin != null ? sched[gid].home_spread_margin : (gp[0].home_spread_margin != null ? gp[0].home_spread_margin : (gp[0].spread_line != null ? gp[0].spread_line : null));
    const total = sched[gid] && sched[gid].total_line != null ? sched[gid].total_line : (gp[0].total_line != null ? gp[0].total_line : null);
    [g.home, g.away].forEach((t) => {
      const r = rows[t]; if (!r) return;
      r.counts.drives = drives[t] ? drives[t].size : 0;
      r.counts.points = t === g.home ? homePts : awayPts;
      r.counts.opp_points = t === g.home ? awayPts : homePts;
      if (homeMargin != null) { r.market.spread_margin = t === g.home ? homeMargin : -homeMargin; r.market.total_line = total; r.market.source = sport === 'nfl' ? 'nflverse spread_line/total_line (closing consensus)' : 'ESPN pregame line carried in the play-by-play (timing not disclosed)'; }
      r.quality = qg.teams[t] || { volume_ok: false, player_ok: false, reasons: ['team_not_in_game'] };
      r.src = gp[0].src;
      teamGames.push(r);
    });
    Object.values(players).forEach((u) => {
      const tq = qg.teams[u.team];
      playerGames.push(Object.assign({ sport, season: g.season, week: g.week, season_type: g.season_type, game_id: gid, kickoff_at: g.kickoff_at, opp: u.team === g.home ? g.away : g.home, player_ok: !!(tq && tq.player_ok) }, u));
    });
    for (const p of gp) { delete p._fails; delete p._neutral; }
  }
  const low = QC.lowVolumeFlags(teamGames);
  low.forEach((f) => { const r = teamGames.find((x) => x.game_id === f.game_id && x.team === f.team); if (r) (r.quality.warnings = r.quality.warnings || []).push('unexpectedly_low_play_count:z=' + f.z); });
  teamGames.sort((a, b) => String(a.kickoff_at || a.week).localeCompare(String(b.kickoff_at || b.week)) || a.game_id.localeCompare(b.game_id) || a.team.localeCompare(b.team));
  playerGames.sort((a, b) => a.game_id.localeCompare(b.game_id) || a.team.localeCompare(b.team) || a.player_id.localeCompare(b.player_id));
  return { team_games: teamGames, player_games: playerGames, games, play_failures: playFailures, low_volume_flags: low };
}

module.exports = { aggregateSeason, SIT_KEYS, SCRIPTS };
