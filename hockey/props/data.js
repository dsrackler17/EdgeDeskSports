'use strict';
/* ===========================================================================
   EdgeDesk NHL PROPS — player-games, in time order, from the official box
   score (hockey/ingest/boxscores.js) and the play-by-play (individual xG from
   EdgeDesk's own walk-forward xG model, hockey/xg/models/xg_for_<season>.json).

   loadSeason(season) → {
     skaters: [{ game_id, date, season, type, team, opp, home, player, pos,
                 toi, g, a, pts, sog, ppg, ixg, iff }],     one per dressed skater
     goalies: [{ game_id, date, season, type, team, opp, home, goalie, starter,
                 toi, sa, sv, ga }],                        one per goalie who played
     teams:   { game_id: { home: {team, sog, goals}, away: {...} } }
   }
   Rows are the box score's values as published. ixg/iff come from the
   play-by-play shots credited to the player (unblocked attempts, shootout
   excluded), scored by the xG model fitted on seasons BEFORE this one.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { loadBox } = require('../ingest/boxscores');
const X = require('../xg/model');

function xgModelFor(season) {
  for (let s = season; s >= C.FIRST_SEASON; s--) {
    const p = path.join(C.PATHS.xgModels, 'xg_for_' + s + '.json');
    if (fs.existsSync(p)) { const m = JSON.parse(fs.readFileSync(p, 'utf8')); return X.predictor(m, m.id || 'xg_for_' + s); }
  }
  return null;
}

/** player-game individual xG and unblocked attempts from the processed play-by-play */
function individualXg(season) {
  const out = new Map(); const meta = new Map();
  let readSeason; try { readSeason = require('../ingest/season').readSeason; } catch (_) { return { ixg: out, meta }; }
  const xg = xgModelFor(season); if (!xg) return { ixg: out, meta };
  try {
    for (const rec of readSeason(season)) {
      meta.set(rec.game.game_id, { type: rec.game.season_type, home: rec.game.home, away: rec.game.away, start_utc: rec.game.start_utc });
      for (const s of rec.shots) {
        if (s.shooter == null || s.empty_net) continue;
        const k = rec.game.game_id + ':' + s.shooter; const v = out.get(k) || { ixg: 0, iff: 0 };
        v.ixg += xg.predict(s); v.iff++; out.set(k, v);
      }
    }
  } catch (_) { /* no cache for the season: ixg stays absent (null), never 0 */ }
  return { ixg: out, meta };
}

function loadSeason(season) {
  const box = loadBox(season); if (!box) return null;
  const { ixg, meta } = individualXg(season);
  const skaters = [], goalies = [], teams = {};
  for (const [gid, g] of Object.entries(box.games)) {
    const id = Number(gid); const m = meta.get(id) || {};
    const th = g.teams.home || {}, ta = g.teams.away || {};
    const team = { home: th.team || m.home || null, away: ta.team || m.away || null };
    if (!team.home || !team.away) continue;
    teams[id] = { home: { team: team.home, sog: th.sog, goals: th.goals }, away: { team: team.away, sog: ta.sog, goals: ta.goals } };
    for (const side of ['home', 'away']) {
      const opp = side === 'home' ? 'away' : 'home';
      for (const r of g.skaters[side]) {
        const [pid, toi, gl, as, sog, ppg, pos] = r;
        const x = ixg.get(id + ':' + pid);
        skaters.push({ game_id: id, date: g.date, season, type: m.type || null, team: team[side], opp: team[opp], home: side === 'home' ? 1 : 0, player: pid, pos: pos === 'D' ? 'D' : 'F', toi, g: gl, a: as, pts: (gl || 0) + (as || 0), sog, ppg, ixg: x ? x.ixg : (meta.size ? 0 : null), iff: x ? x.iff : (meta.size ? 0 : null) });
      }
      for (const r of g.goalies[side]) {
        const [pid, starter, toi, sa, sv, ga] = r;
        if (!toi) continue;
        goalies.push({ game_id: id, date: g.date, season, type: m.type || null, team: team[side], opp: team[opp], home: side === 'home' ? 1 : 0, goalie: pid, starter: !!starter, toi, sa, sv, ga });
      }
    }
  }
  const order = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id - b.game_id);
  skaters.sort(order); goalies.sort(order);
  return { season, skaters, goalies, teams, names: box.names, source: box.sources };
}

module.exports = { loadSeason, individualXg, xgModelFor };
