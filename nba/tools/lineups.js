#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — five-man units per team-season, from the reconstructed stints.

     node nba/tools/lineups.js [--season 2026,2027] [--top 15]

   For every lineup (the five player ids, sorted) and team-season: seconds on
   the floor, offensive and defensive possessions (FGA − OREB + TOV + 0.44·FTA
   on the stint's own counts), points for and against, offensive / defensive /
   net rating per 100, and a SHRUNK net rating: net × poss / (poss + 300). A
   unit with 50 possessions keeps 14% of its raw net; one with 1,000 keeps 77%.
   Raw lineup net ratings are mostly noise below a few hundred possessions; the
   reliability column says how much of the number to believe.

   Descriptive, not a model input (the player model fits the same stints with
   ridge). Writes nba/data/lineups/<season>.json with each team's most-used
   units (for the research panel); nba/tools/sync_supabase.js loads all of them.
   Only stints whose two fives were reconstructed (ok = 1) count.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const D = require('../lib/data');

const K_SHRINK = 300;
function aggregate(season) {
  const st = D.stints(season); if (!st) return null;
  const games = new Map(D.games([season]).map((g) => [g.game_id, g]));
  const by = new Map();
  const add = (team, five, sec, pf, pa, po, pd) => {
    const key = team + '|' + five; let x = by.get(key);
    if (!x) { x = { season, team_id: team, lineup_key: five, players: five.split(' '), seconds: 0, poss_off: 0, poss_def: 0, pts_for: 0, pts_against: 0 }; by.set(key, x); }
    x.seconds += sec; x.poss_off += po; x.poss_def += pd; x.pts_for += pf; x.pts_against += pa;
  };
  for (const g of st.games) {
    const gm = games.get(g.g); if (!gm) continue;
    for (const s of g.s) {
      if (!s[14]) continue;
      const sec = Math.max(0, s[1] - s[0]);
      const hp = Math.max(0, s[6] - s[10] + s[12] + 0.44 * s[8]), ap = Math.max(0, s[7] - s[11] + s[13] + 0.44 * s[9]);
      add(gm.home_id, s[2], sec, s[4], s[5], hp, ap);
      add(gm.away_id, s[3], sec, s[5], s[4], ap, hp);
    }
  }
  const out = [];
  for (const x of by.values()) {
    const ort = x.poss_off > 0 ? 100 * x.pts_for / x.poss_off : null, drt = x.poss_def > 0 ? 100 * x.pts_against / x.poss_def : null;
    const poss = (x.poss_off + x.poss_def) / 2; const rel = poss / (poss + K_SHRINK);
    const net = ort != null && drt != null ? ort - drt : null;
    out.push(Object.assign(x, { seconds: Math.round(x.seconds), poss_off: Math.round(x.poss_off * 10) / 10, poss_def: Math.round(x.poss_def * 10) / 10,
      off_rating: ort == null ? null : Math.round(ort * 10) / 10, def_rating: drt == null ? null : Math.round(drt * 10) / 10, net_rating: net == null ? null : Math.round(net * 10) / 10,
      net_shrunk: net == null ? null : Math.round(net * rel * 10) / 10, reliability: Math.round(rel * 1000) / 1000 }));
  }
  return out;
}

function topByTeam(rows, top) {
  const by = new Map(); for (const r of rows) { if (!by.has(r.team_id)) by.set(r.team_id, []); by.get(r.team_id).push(r); }
  const out = {}; for (const [t, l] of by) out[t] = l.sort((a, b) => b.seconds - a.seconds).slice(0, top);
  return out;
}

module.exports = { aggregate, topByTeam, K_SHRINK };

if (require.main === module) {
  const i = process.argv.indexOf('--season'); const top = Number((process.argv[process.argv.indexOf('--top') + 1]) || 15) || 15;
  const cur = C.currentSeason();
  const seasons = i >= 0 ? process.argv[i + 1].split(',').map(Number) : [cur - 1, cur];
  const dir = path.join(C.NBA, 'data', 'lineups'); fs.mkdirSync(dir, { recursive: true });
  for (const s of seasons) {
    const rows = aggregate(s);
    if (!rows) { console.log('[nba lineups] ' + s + ': no stints yet'); continue; }
    const players = D.playersMap();
    const t = topByTeam(rows, top);
    for (const l of Object.values(t)) for (const r of l) r.names = r.players.map((p) => (players[p] || {}).name || p);
    fs.writeFileSync(path.join(dir, s + '.json'), JSON.stringify({ schema: 'edgedesk_nba_lineups_v1', season: s, shrink_possessions: K_SHRINK, rule: 'each team\'s ' + top + ' most-used five-man units; net_shrunk = net × poss/(poss + ' + K_SHRINK + ')', teams: t }) + '\n');
    console.log('[nba lineups] ' + s + ': ' + rows.length + ' units, wrote the top ' + top + ' per team');
  }
}
