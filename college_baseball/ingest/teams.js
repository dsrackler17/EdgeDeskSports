'use strict';
/* ===========================================================================
   EdgeDesk college baseball — canonical program identity.

   THE ORG ID IS THE PROGRAM. stats.ncaa.org gives every school a stable
   organisation id (team_id in ncaa_team_lookup) and a new "season team id"
   every year (season_team_id, the /teams/<id> URL). The 2012-2023 schedule
   files speak org ids; the 2024-2026 files speak season-team ids; the box
   scores speak a third, per-contest team id. Everything in the warehouse is
   keyed by org id, and the season-team id is only ever a lookup into it.

   A program's name, conference and division are facts OF A SEASON. Name
   changes (e.g. a school's renaming), conference realignment and division
   moves are therefore not edits to a team row: they are different rows of
   team_seasons, and history keeps the affiliation that held at the time.

   Outputs (committed):
     data/teams/team_seasons.csv  season, team_id, season_team_id, name, conference_id, conference, division
     data/teams/teams.csv         team_id, name (latest), aliases, first/last season, D-I seasons, conference history
   =========================================================================== */
const C = require('../config');
const K = require('./common');
const SRC = require('./sources');

const SEASON_HEADER = ['season', 'team_id', 'season_team_id', 'name', 'conference_id', 'conference', 'division'];
const TEAM_HEADER = ['team_id', 'name', 'aliases', 'first_season', 'last_season', 'd1_seasons', 'conference_history', 'division_history'];

/** pure: lookup rows -> {seasons:[...], teams:[...], problems:[...]} */
function build(lookupRows) {
  const problems = [];
  const seen = new Map();
  const seasons = [];
  for (const r of lookupRows) {
    const season = K.int(r.year); const id = K.str(r.team_id);
    if (!season || !id) { problems.push({ kind: 'LOOKUP_ROW_UNUSABLE', detail: JSON.stringify(r).slice(0, 160) }); continue; }
    const key = season + ':' + id;
    const row = { season, team_id: id, season_team_id: K.str(r.season_team_id), name: K.str(r.team_name), conference_id: K.str(r.conference_id), conference: K.str(r.conference), division: K.int(r.division) };
    if (seen.has(key)) {
      const a = seen.get(key);
      if (a.season_team_id !== row.season_team_id || a.division !== row.division || a.conference !== row.conference) problems.push({ kind: 'LOOKUP_DUPLICATE_CONFLICT', season, team_id: id, detail: `${a.conference}/${a.division} vs ${row.conference}/${row.division}` });
      continue;
    }
    seen.set(key, row); seasons.push(row);
  }
  seasons.sort((a, b) => a.season - b.season || (a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0));
  /* one season-team id must map to one program */
  const sti = new Map();
  for (const r of seasons) {
    if (!r.season_team_id) continue;
    if (sti.has(r.season_team_id) && sti.get(r.season_team_id) !== r.team_id) problems.push({ kind: 'SEASON_TEAM_ID_SHARED', season: r.season, team_id: r.team_id, detail: r.season_team_id });
    sti.set(r.season_team_id, r.team_id);
  }
  const byTeam = new Map();
  for (const r of seasons) { if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []); byTeam.get(r.team_id).push(r); }
  const teams = [...byTeam.entries()].map(([id, rs]) => {
    const names = [...new Set(rs.map((r) => r.name).filter(Boolean))];
    const conf = []; const div = [];
    for (const r of rs) {
      if (!conf.length || conf[conf.length - 1].c !== r.conference) conf.push({ c: r.conference, from: r.season });
      if (!div.length || div[div.length - 1].d !== r.division) div.push({ d: r.division, from: r.season });
    }
    return {
      team_id: id, name: rs[rs.length - 1].name, aliases: names.join('|'),
      first_season: rs[0].season, last_season: rs[rs.length - 1].season,
      d1_seasons: rs.filter((r) => r.division === 1).map((r) => r.season).join(' '),
      conference_history: conf.map((x) => `${x.from}:${x.c}`).join('|'),
      division_history: div.map((x) => `${x.from}:${x.d}`).join('|'),
    };
  }).sort((a, b) => (a.team_id < b.team_id ? -1 : 1));
  return { seasons, teams, problems };
}

/** index for the other connectors */
function index(seasonRows) {
  const bySeasonTeam = new Map();   // season_team_id -> row
  const byOrg = new Map();          // season:org -> row
  const byName = new Map();         // season:normName -> org (ambiguity recorded)
  const ambiguous = new Set();
  for (const r of seasonRows) {
    if (r.season_team_id) bySeasonTeam.set(r.season_team_id, r);
    byOrg.set(r.season + ':' + r.team_id, r);
    const nk = r.season + ':' + K.normName(r.name);
    if (byName.has(nk) && byName.get(nk) !== r.team_id) ambiguous.add(nk); else byName.set(nk, r.team_id);
  }
  for (const k of ambiguous) byName.delete(k);
  return {
    seasonTeam: (id) => bySeasonTeam.get(K.str(id)) || null,
    org: (season, id) => byOrg.get(season + ':' + K.str(id)) || null,
    byName: (season, name) => byName.get(season + ':' + K.normName(name)) || null,
    d1: (season) => seasonRows.filter((r) => r.season === season && r.division === 1),
  };
}

async function run(o) {
  o = o || {};
  const res = await SRC.csv(C.SOURCE.urls.lookup, { offline: o.offline });
  if (!res.ok) throw new Error('team lookup unavailable: ' + JSON.stringify(res.prov && res.prov.error));
  const out = build(res.rows);
  if (!o.check) {
    K.writeCsv(C.PATHS.teamSeasons, SEASON_HEADER, out.seasons);
    K.writeCsv(C.PATHS.teams, TEAM_HEADER, out.teams);
  }
  return Object.assign(out, { prov: res.prov });
}

module.exports = { build, index, run, SEASON_HEADER, TEAM_HEADER };
