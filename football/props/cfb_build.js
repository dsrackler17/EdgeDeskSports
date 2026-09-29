/* ===========================================================================
   PLAYER PROPS — the CFB build. docs/player-props/CFB.md

   The same engine, model, board and decision rules as the NFL, with the
   college realities made explicit rather than ignored:
     - the game environment is EdgeDesk's FBS model (football/fbs/slate.json:
       fair margin, fair total), with the college outcome scale measured
       from college games (blowouts and garbage time live in that scale)
     - roles come from usage order (no provider depth chart), shares are of
       targets and carries (no snaps or routes are published)
     - availability is the official conference report when one exists,
       a measured absence rule when a regular missed the last game, and
       UNKNOWN otherwise — reliability is scaled down for the league
       (EDProps DEFAULT_CONFIG.reliability.league_scale.CFB) and the CFB
       decision thresholds are stricter (leagues.CFB)
     - the ESPN athlete id links a college player to his NFL identity
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./cfb_data.js');
const N = require('./nfl_data.js');
const M = require('./model.js');
const PR = require('./priors.js');
const PJ = require('./project.js');
const REG = require('./registry.js');

const ROOT = path.join(__dirname, '..', '..');
const WINDOW_DAYS = 8;
function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }

function cfbEnv(sg, g, data, asOf, lg) {
  if (sg && sg.model_status === 'PREDICTED' && typeof sg.model_home_margin === 'number' && typeof sg.model_fair_total === 'number') {
    const T = sg.model_fair_total, Mg = sg.model_home_margin;
    return { source: 'edgedesk_model', model_version: sg.shadow_model_version || 'edgedesk_cfb_p4_v1.0.0', detail: 'EdgeDesk FBS game model (football/fbs/slate.json)',
      margin: Mg, total: T, home_points: (T + Mg) / 2, away_points: (T - Mg) / 2, margin_sd: lg.env.margin_sd, total_sd: lg.env.total_sd };
  }
  const e = M.leakFreeEnv(data, g, asOf, g.season, lg.hfa);
  return { source: 'points_history', detail: 'EdgeDesk points history (no game-model number for this game)', margin: e.margin, total: e.total, home_points: e.home_points, away_points: e.away_points, margin_sd: lg.env.margin_sd, total_sd: lg.env.total_sd };
}

async function buildCfb(now, opts) {
  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  const season = slate && slate.season ? slate.season : new Date(now).getUTCFullYear();
  const data = await D.load({ seasons: [season - 1, season], offline: opts.offline });
  const lg = PR.priorsAsOf(data, now, season, N.poolsAsOf);
  const reg = REG.load('CFB');
  const nowIso = new Date(now).toISOString();
  const lastTeam = new Map();
  /* the registry holds players with a real college footprint: this
     season's players, and last season's with 3+ games (an id, once minted,
     is never removed) */
  const games3 = new Map();
  data.playerGames.forEach((x) => { games3.set(x.gsis, (games3.get(x.gsis) || 0) + 1); });
  data.playerGames.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)).forEach((x) => { if (x.season === season || games3.get(x.gsis) >= 3 || reg.by_anchor[x.gsis]) lastTeam.set(x.gsis, { team: x.team, at: x.kickoff, pos: x.pos, name: x.name }); });
  for (const [id, v] of lastTeam) {
    const pl = data.players.get(id) || {};
    REG.upsert(reg, 'CFB', id, { name: pl.name || v.name, position: pl.pos_group || v.pos, team: v.team, ids: { espn: id } }, v.at ? v.at.slice(0, 10) : null);
  }
  /* the cross-league link: ESPN uses one athlete id for college and pro */
  const nfl = REG.load('NFL');
  const byEspn = new Map();
  Object.keys(nfl.players).forEach((k) => { const e = nfl.players[k].ids && nfl.players[k].ids.espn; if (e) byEspn.set(String(e), k); });
  Object.keys(reg.players).forEach((k) => { const p = reg.players[k]; const n = byEspn.get(String(p.ids.espn)); if (n) { p.links = p.links || {}; p.links.nfl = n; } });
  const idOf = (anchor) => reg.by_anchor[anchor] || REG.upsert(reg, 'CFB', anchor, { name: (data.players.get(anchor) || {}).name }, nowIso);
  const calibration = readJson(path.join(__dirname, 'cfb', 'calibration.json'), null);
  const games = [];
  ((slate && slate.games) || []).forEach((sg) => {
    const ko = Date.parse(sg.kickoff);
    if (!(ko > now) || ko > now + WINDOW_DAYS * 864e5) return;
    /* FBS vs FBS only: an FCS opponent has too little data to project honestly */
    if (sg.home_division && sg.away_division && (sg.home_division !== 'fbs' || sg.away_division !== 'fbs')) return;
    const g = data.games.get(String(sg.game_id));
    if (g) games.push({ sg, g });
  });
  const projected = [];
  for (const { sg, g } of games) {
    const env = require('./build.js').quantise(cfbEnv(sg, g, data, now, lg));
    const st = { home: sg.home_starter && sg.home_starter.player_id ? String(sg.home_starter.player_id) : null, away: sg.away_starter && sg.away_starter.player_id ? String(sg.away_starter.player_id) : null };
    const qbUnres = {};
    ['home', 'away'].forEach((side) => {
      const s0 = sg[side + '_starter'];
      const av = s0 && s0.availability ? String(s0.availability.state || '').toUpperCase() : '';
      qbUnres[side] = !s0 || !s0.player_id || s0.status === 'COMPETITION' || s0.status === 'UNKNOWN' || av === 'OUT' || av === 'DOUBTFUL' || (s0.conflicts && s0.conflicts.length > 0);
    });
    let out;
    try { out = PJ.projectGame(data, { league: 'CFB', game: g, asOfMs: now, season: g.season, lg, env, weather: { known: false, outdoor: true }, starters: st, qb_unresolved: qbUnres, sims: opts.sims, idOf, calibration }); }
    catch (e) { console.error('  ' + g.game_id + ': ' + e.message); continue; }
    out.kickoff = g.kickoff;
    out.teams.home.name = g.home_name; out.teams.away.name = g.away_name;
    require('./build.js').relevant(out, opts.market_keys);
    projected.push(out);
    console.log('  ' + g.game_id + ' ' + g.away + ' @ ' + g.home + ': ' + out.records.length + ' projections (' + out.sim_ms + ' ms)');
  }
  return { league: 'CFB', season, week: games.length ? games[0].g.week : null, data, lg, reg, projected, sources: data.sources, gaps: data.gaps, player_logs: require('./build.js').playerLogs(data, projected, reg, season) };
}
module.exports = { buildCfb, cfbEnv };
