#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Football — FBS roster fetch (ESPN public JSON APIs).

   Writes, for the requested season:
     football/rosters/fbs_<season>_espn.json   full normalized dataset
     football/rosters/fbs_<season>_espn.csv    one row per player, flat

   WHY TWO ESPN APIS. The first version of this script trusted the site
   API alone and shipped two silent lies: /teams?groups=80 IGNORED the
   FBS filter (returning an alphabetically capped mix of every division),
   and /teams/{id}/roster capped at exactly 100 players while the 2026
   roster limit is 105. So:

     * the team list comes from the CORE API's season-scoped FBS group
       (…/seasons/<season>/types/2/groups/80/teams), which is the actual
       membership list for that season;
     * each roster starts from the rich site endpoint, then the core
       athlete index for the team is compared against it, and any athlete
       the site endpoint withheld is fetched individually and merged by
       athlete id. Counts from both sources are recorded per team.

   Honesty rules, same as the rest of this repo:
     * Fields the source does not carry stay EMPTY. Nothing is inferred,
       nothing is filled from last season, no player is invented.
     * The season the API actually reports is recorded next to the season
       requested — a mismatch is visible in the data, not papered over.
     * One raw athlete object from each source ships in the JSON so a
       consumer can audit exactly what the feeds provide.
     * The run FAILS rather than committing a dataset whose shape is
       wrong: team count outside 120–150, under 12,000 total players, or
       more than 5 empty FBS rosters.

   Run by .github/workflows/roster-sync.yml (full network); the app sandbox
   itself cannot reach ESPN. Usage:

     node football/rosters/fetch_rosters.js [--season 2026]

   Default season follows the app's convention: Jan/Feb belong to the
   prior season. Exit 0 = dataset written; exit 1 = fetch failed hard.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = __dirname;
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football';

function defaultSeason() {
  const d = new Date();
  return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear();
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000),
        headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
const sleep = ms => new Promise(res => setTimeout(res, ms));
const S = v => (v == null ? '' : String(v).trim());

function heightFrom(display, inches) {
  if (display) return S(display);
  const h = +inches;
  if (isFinite(h) && h > 0) return `${Math.floor(h / 12)}-${h % 12}`;
  return '';
}
function classFrom(exp, cls) {
  const e = exp || {};
  return S(e.displayValue || e.abbreviation || cls ||
    (e.years != null ? `yr ${e.years}` : ''));
}
function hometownFrom(b) {
  if (!b) return '';
  if (typeof b === 'string') return S(b);
  return [S(b.city), S(b.state || b.country)].filter(Boolean).join(', ');
}
function normalizeSiteAthlete(a) {
  return {
    name: S(a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ')),
    jersey: S(a.jersey),
    position: S(a.position && (a.position.abbreviation || a.position.displayName)),
    class: classFrom(a.experience, a.class),
    height: heightFrom(a.displayHeight, a.height),
    weight: S(a.displayWeight || (a.weight ? a.weight + ' lbs' : '')),
    hometown: hometownFrom(a.birthPlace || a.hometown),
    high_school: S(a.highSchool || (a.lastSchool && !a.lastSchool.isCollege ? a.lastSchool.name : '')),
    previous_school: S(a.lastSchool && a.lastSchool.isCollege ? a.lastSchool.name : ''),
    espn_id: S(a.id),
    source_detail: 'site_roster'
  };
}

/* position objects in the core API are $refs; ~25 distinct ids, cached */
const positionCache = {};
async function positionAbbrev(ref) {
  if (!ref) return '';
  const m = /positions\/(\d+)/.exec(ref);
  const key = m ? m[1] : ref;
  if (positionCache[key] !== undefined) return positionCache[key];
  try {
    const p = await fetchJson(ref);
    positionCache[key] = S(p.abbreviation || p.displayName);
  } catch (_) { positionCache[key] = ''; }
  return positionCache[key];
}
async function normalizeCoreAthlete(a) {
  return {
    name: S(a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ')),
    jersey: S(a.jersey),
    position: await positionAbbrev(a.position && a.position.$ref),
    class: classFrom(a.experience, null),
    height: heightFrom(a.displayHeight, a.height),
    weight: S(a.displayWeight || (a.weight ? a.weight + ' lbs' : '')),
    hometown: hometownFrom(a.birthPlace),
    high_school: '',
    previous_school: '',
    espn_id: S(a.id),
    source_detail: 'core_athlete'
  };
}

/* season-scoped FBS membership (group 80) from the core API */
async function fbsTeamIds(season) {
  const ids = [];
  for (let page = 1; page <= 6; page++) {
    const j = await fetchJson(`${CORE}/seasons/${season}/types/2/groups/80/teams?limit=100&page=${page}`);
    for (const it of (j.items || [])) {
      const m = /\/teams\/(\d+)/.exec(S(it.$ref));
      if (m) ids.push(m[1]);
    }
    if (!j.pageCount || page >= j.pageCount) break;
  }
  return [...new Set(ids)];
}

/* every athlete id the core index lists for this team-season */
async function coreAthleteIds(teamId, season) {
  const ids = [];
  for (let page = 1; page <= 5; page++) {
    const j = await fetchJson(`${CORE}/seasons/${season}/teams/${teamId}/athletes?limit=100&page=${page}`);
    for (const it of (j.items || [])) {
      const m = /\/athletes\/(\d+)/.exec(S(it.$ref));
      if (m) ids.push(m[1]);
    }
    if (!j.pageCount || page >= j.pageCount) break;
  }
  return [...new Set(ids)];
}

async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--season') season = parseInt(args[++i], 10);
    else { console.error('unknown option: ' + args[i]); process.exit(1); }
  }
  const retrievedAt = new Date().toISOString();

  const teamIds = await fbsTeamIds(season);
  console.log(`FBS ${season} membership (core group 80): ${teamIds.length} teams`);
  if (teamIds.length < 120 || teamIds.length > 150) {
    throw new Error(`FBS team list looks wrong: ${teamIds.length} teams (expected 120–150)`);
  }

  const out = {
    schema: 'edgedesk_fbs_rosters_v2',
    source: 'ESPN public APIs: core seasons/<season>/types/2/groups/80/teams (membership), '
      + 'site teams/{id}/roster (detail), core seasons/<season>/teams/{id}/athletes (completeness top-up)',
    requested_season: season,
    retrieved_at: retrievedAt,
    team_count: teamIds.length,
    sample_raw_site_athlete: null,
    sample_raw_core_athlete: null,
    teams: []
  };

  let totalPlayers = 0, emptyTeams = 0, toppedUp = 0;
  for (const id of teamIds) {
    let meta = {}, err = null, players = [], reported = null;
    let siteCount = 0, coreCount = 0;
    try {
      const tj = await fetchJson(`${SITE}/teams/${id}`);
      const t = (tj && tj.team) || {};
      meta = { location: S(t.location), display_name: S(t.displayName),
        short_name: S(t.shortDisplayName), abbreviation: S(t.abbreviation), nickname: S(t.nickname) };

      const rosterJson = await fetchJson(`${SITE}/teams/${id}/roster?season=${season}&limit=200`);
      reported = rosterJson && rosterJson.season && rosterJson.season.year;
      const seen = {};
      for (const g of (rosterJson.athletes || [])) {
        const items = Array.isArray(g) ? g : (g.items || []);
        for (const a of items) {
          if (!out.sample_raw_site_athlete) out.sample_raw_site_athlete = a;
          const p = normalizeSiteAthlete(a);
          if (p.espn_id && seen[p.espn_id]) continue;
          if (p.espn_id) seen[p.espn_id] = true;
          players.push(p);
        }
      }
      siteCount = players.length;

      /* completeness: the site endpoint has been seen capping at 100 */
      const coreIds = await coreAthleteIds(id, season);
      coreCount = coreIds.length;
      const missing = coreIds.filter(aid => !seen[aid]);
      for (const aid of missing) {
        try {
          const a = await fetchJson(`${CORE}/seasons/${season}/athletes/${aid}`);
          if (!out.sample_raw_core_athlete) out.sample_raw_core_athlete = a;
          const p = await normalizeCoreAthlete(a);
          if (p.name) { players.push(p); seen[aid] = true; toppedUp++; }
        } catch (_) { /* one missing athlete is not worth failing the team */ }
        await sleep(60);
      }
    } catch (e) { err = (e && e.message) || 'fetch failed'; }

    players.sort((x, y) => x.name.localeCompare(y.name));
    out.teams.push({
      espn_id: S(id), ...meta,
      season_reported: reported != null ? reported : null,
      fetch_error: err,
      site_player_count: siteCount,
      core_athlete_count: coreCount,
      player_count: players.length,
      players
    });
    totalPlayers += players.length;
    if (!players.length) emptyTeams++;
    console.log(`${meta.display_name || id}: site ${siteCount} · core ${coreCount} · merged ${players.length}`
      + (reported != null && reported !== season ? ` (API reports season ${reported}!)` : '')
      + (err ? ` FETCH ERROR: ${err}` : ''));
    await sleep(150);
  }
  console.log(`total ${totalPlayers} players · ${toppedUp} recovered past the site cap · ${emptyTeams} empty teams`);
  if (totalPlayers < 12000) throw new Error(`dataset too small for FBS (${totalPlayers} players — expected ~14k)`);
  if (emptyTeams > 5) throw new Error(`${emptyTeams} FBS teams came back empty — refusing to commit a hollow dataset`);

  fs.writeFileSync(path.join(OUT_DIR, `fbs_${season}_espn.json`), JSON.stringify(out, null, 1) + '\n');

  const q = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const rows = ['team,espn_team_id,player,jersey,position,class,height,weight,hometown,high_school,previous_school,espn_player_id,source_detail,season_requested,season_reported,retrieved_at'];
  for (const tm of out.teams) {
    for (const p of tm.players) {
      rows.push([tm.display_name, tm.espn_id, p.name, p.jersey, p.position, p.class, p.height,
        p.weight, p.hometown, p.high_school, p.previous_school, p.espn_id, p.source_detail,
        season, tm.season_reported == null ? '' : tm.season_reported, retrievedAt].map(x => q(S(x))).join(','));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `fbs_${season}_espn.csv`), rows.join('\n') + '\n');
  console.log(`wrote fbs_${season}_espn.json and .csv`);
}

main().catch(e => { console.error('roster fetch failed:', e); process.exit(1); });
