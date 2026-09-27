/* ============================================================================
   EdgeDesk CFB — the team and game identity master (node).
   docs/cfb-production/IDENTITY.md

   ONE canonical answer to "which team is this?" and "which game is this?",
   built from what the repository already trusts, never from a guess:

     internal_team_id   the FBS universe key (football/fbs/fbs.js normKey of the
                        school's schedule name: "miami", "miamioh", "texasam")
     provider ids       ESPN team id == CollegeFootballData team id (the same
                        numbering), from football/fbs_epa/teams.json
     names / aliases    the school name, the historical/schedule spellings, and
                        fbs.js TEAM_ALIASES (the alias table the board, the
                        capture join and the desk already share)
     seasons            division and conference per season (2014 on)

   Resolution order: a provider id (exact) -> an internal id (exact) -> a name
   through fbs.js resolveTeam (exact, alias, "St." expansion, then the longest
   UNAMBIGUOUS prefix). A tie resolves to nothing. Nothing is joined by a
   substring: "Miami" is Miami (FL), "Miami (OH)" is miamioh, and a name that
   resolves to neither is UNMAPPED — the game fails safely, it is not guessed.

   validateGame()       home mapped, away mapped, home != away, id and name
                        agree, both teams exist in the season, conferences sane
   gameIdentity()       the canonical game key (season, home, away, UTC day)
                        plus the provider's own orientation, kept for debugging
   findDuplicates()     the same matchup under two provider ids (either
                        orientation) within 36 h
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('../fbs/fbs.js');

const REPO = path.resolve(__dirname, '..', '..');
const VERSION = 'cfb_identity_master_v1';
const DUP_WINDOW_H = 36;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function ms(t) { if (t == null || t === '') return null; const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? v : null; }

/* Build the master. `teamsJson` defaults to football/fbs_epa/teams.json;
   `extra` adds teams the crosswalk does not carry ({key, name, espn_id, aliases}). */
function loadTeamMaster(opts) {
  opts = opts || {};
  const src = opts.teamsJson || readJson(path.join(REPO, 'football', 'fbs_epa', 'teams.json'));
  const teams = {}, byProvider = { espn: {}, cfbd: {} }, order = [];
  const put = (key, name, pid, seasons, aliases) => {
    if (!key) return;
    const t = teams[key] || (teams[key] = { internal_team_id: key, name, provider_ids: { espn: null, cfbd: null }, aliases: [], seasons: {} });
    if (!order.includes(key)) order.push(key);
    if (pid != null) { t.provider_ids.espn = String(pid); t.provider_ids.cfbd = String(pid); byProvider.espn[String(pid)] = key; byProvider.cfbd[String(pid)] = key; }
    Object.assign(t.seasons, seasons || {});
    (aliases || []).concat(F.TEAM_ALIASES[key] || []).forEach((a) => { if (a && a !== t.name && !t.aliases.includes(a)) t.aliases.push(a); });
  };
  Object.keys((src && src.teams) || {}).sort((a, b) => Number(a) - Number(b)).forEach((id) => {
    const x = src.teams[id];
    put(x.key || F.normKey(x.name), x.name, x.espn_team_id || id, x.seasons, []);
  });
  (opts.extra || []).forEach((x) => put(x.key || F.normKey(x.name), x.name, x.espn_id, x.seasons, x.aliases));
  const universe = { teams: {}, order: order.slice() };
  order.forEach((k) => { universe.teams[k] = { key: k, name: teams[k].name, aliases: teams[k].aliases.slice() }; });
  const index = F.teamIndex(universe);
  return { version: VERSION, source: src ? 'football/fbs_epa/teams.json' : null, generated_at: src && src.generated_at, teams, byProvider, index, count: order.length };
}
let DEFAULT = null;
function master() { return DEFAULT || (DEFAULT = loadTeamMaster()); }

/* ref: a name, a provider id (number or numeric string), an internal id, or
   { id, name, provider }. Returns { internal_team_id, how } or
   { internal_team_id: null, reason, ambiguous }. */
function resolveTeam(ref, M) {
  M = M || master();
  if (ref == null || ref === '') return { internal_team_id: null, reason: 'no team' };
  const o = typeof ref === 'object' ? ref : (/^\d+$/.test(String(ref).trim()) ? { id: String(ref).trim() } : { name: ref });
  const byId = (id, prov) => {
    if (id == null || id === '') return null;
    const s = String(id).trim();
    if (/^\d+$/.test(s)) { const k = M.byProvider[prov || 'espn'][s]; return k ? { internal_team_id: k, how: 'provider_id:' + (prov || 'espn') } : { internal_team_id: null, reason: 'unknown provider id ' + s }; }
    if (M.teams[s]) return { internal_team_id: s, how: 'internal_id' };
    return null;
  };
  const a = byId(o.id, o.provider);
  const b = o.name != null ? (() => {
    const hit = F.resolveTeam(o.name, M.index);
    if (!hit) return { internal_team_id: null, reason: 'name ' + o.name + ' does not resolve' };
    if (!hit.key) return { internal_team_id: null, reason: 'name ' + o.name + ' is ambiguous', ambiguous: hit.ambiguous };
    return { internal_team_id: hit.key, how: 'name:' + hit.how };
  })() : null;
  if (a && a.internal_team_id && b && b.internal_team_id && a.internal_team_id !== b.internal_team_id)
    return { internal_team_id: null, reason: 'id ' + o.id + ' is ' + a.internal_team_id + ' but name ' + o.name + ' is ' + b.internal_team_id, conflict: [a.internal_team_id, b.internal_team_id] };
  if (a && a.internal_team_id) return a;
  if (b && b.internal_team_id) return b;
  return a || b || { internal_team_id: null, reason: 'unresolvable' };
}

/* true = the same team, false = two different known teams, null = cannot tell
   (at least one side does not resolve and the raw names differ). */
function sameTeam(x, y, M) {
  const a = resolveTeam(x, M), b = resolveTeam(y, M);
  if (a.internal_team_id && b.internal_team_id) return a.internal_team_id === b.internal_team_id;
  const nx = typeof x === 'object' && x ? x.name : x, ny = typeof y === 'object' && y ? y.name : y;
  if (nx != null && ny != null && F.normKey(nx) && F.normKey(nx) === F.normKey(ny)) return true;
  return null;
}
function sameTeamFn(M) { return (x, y) => sameTeam(x, y, M); }

/* Before a game is ingested or predicted (brief §17, §20). */
function validateGame(g, opts) {
  opts = opts || {};
  const M = opts.master || master();
  const problems = [], warnings = [];
  const h = resolveTeam({ id: g.home_id, name: g.home_team || g.home, provider: g.provider }, M);
  const a = resolveTeam({ id: g.away_id, name: g.away_team || g.away, provider: g.provider }, M);
  if (!h.internal_team_id) problems.push('HOME_UNMAPPED: ' + h.reason);
  if (!a.internal_team_id) problems.push('AWAY_UNMAPPED: ' + a.reason);
  if (h.internal_team_id && a.internal_team_id && h.internal_team_id === a.internal_team_id) problems.push('SAME_TEAM: home and away are both ' + h.internal_team_id);
  if (g.home_id != null && g.away_id != null && String(g.home_id) === String(g.away_id)) problems.push('SAME_TEAM_ID: home_id equals away_id');
  const season = g.season != null ? String(g.season) : null;
  [['home', h, g.home_conference], ['away', a, g.away_conference]].forEach(([side, r, conf]) => {
    if (!r.internal_team_id || !season) return;
    const t = M.teams[r.internal_team_id], s = t && t.seasons && t.seasons[season];
    const seasonsKnown = t && Object.keys(t.seasons || {}).length;
    if (!s) { if (seasonsKnown && Object.keys(t.seasons).some((x) => Number(x) >= Number(season))) warnings.push(side.toUpperCase() + '_NOT_IN_SEASON: ' + r.internal_team_id + ' has no ' + season + ' entry'); return; }
    if (conf && s.conference) {
      const c1 = F.conference(conf), c2 = F.conference(s.conference);
      if (c1.id && c2.id && c1.id !== c2.id) warnings.push(side.toUpperCase() + '_CONFERENCE: feed says ' + conf + ', the master says ' + s.conference + ' for ' + season);
    }
  });
  if (g.kickoff != null && ms(g.kickoff) === null) problems.push('KICKOFF_UNPARSEABLE');
  return { ok: problems.length === 0, home: h.internal_team_id || null, away: a.internal_team_id || null, problems, warnings, rule: VERSION };
}

/* The canonical game identity: (season, home, away, UTC kickoff day), with the
   provider's own orientation kept beside it for debugging (brief §19-20). */
function gameIdentity(g, opts) {
  opts = opts || {};
  const v = validateGame(g, opts);
  const k = ms(g.kickoff);
  return {
    ok: v.ok, problems: v.problems,
    key: v.ok ? [g.season == null ? '' : g.season, v.home, v.away, k == null ? '' : new Date(k).toISOString().slice(0, 10)].join('|') : null,
    home: v.home, away: v.away,
    provider: { source: g.provider || g.source || null, game_id: g.game_id == null ? null : String(g.game_id),
      home_team: g.home_team || g.home || null, away_team: g.away_team || g.away || null, home_id: g.home_id == null ? null : String(g.home_id), away_id: g.away_id == null ? null : String(g.away_id) },
  };
}

/* The same matchup under different provider ids, in either orientation,
   kicking off within 36 h: a duplicate game (brief §19). */
function findDuplicates(games, opts) {
  opts = opts || {};
  const M = opts.master || master();
  const win = (opts.windowH || DUP_WINDOW_H) * 3600000;
  const rows = (games || []).map((g) => ({ g, v: validateGame(g, { master: M }), t: ms(g.kickoff) })).filter((x) => x.v.ok);
  const out = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const A = rows[i], B = rows[j];
    if (String(A.g.game_id) === String(B.g.game_id)) continue;
    const same = A.v.home === B.v.home && A.v.away === B.v.away, swapped = A.v.home === B.v.away && A.v.away === B.v.home;
    if (!same && !swapped) continue;
    if (A.t != null && B.t != null && Math.abs(A.t - B.t) > win) continue;
    out.push({ game_ids: [String(A.g.game_id), String(B.g.game_id)], teams: [A.v.home, A.v.away], kind: same ? 'SAME_ORIENTATION' : 'SWAPPED_ORIENTATION' });
  }
  return out;
}

module.exports = { VERSION, loadTeamMaster, master, resolveTeam, sameTeam, sameTeamFn, validateGame, gameIdentity, findDuplicates, DUP_WINDOW_H };
