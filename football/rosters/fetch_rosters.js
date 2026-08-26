#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Football — FBS roster fetch (ESPN public JSON API).

   Pulls the FBS team list (ESPN group 80) and every team's roster for the
   requested season from ESPN's public, keyless site API, and writes:

     football/rosters/fbs_<season>_espn.json   full normalized dataset
     football/rosters/fbs_<season>_espn.csv    one row per player, flat

   Honesty rules, same as the rest of this repo:
     * Fields the source does not carry stay EMPTY. Nothing is inferred,
       nothing is filled from last season, no player is invented.
     * The season the API actually reports for each roster is recorded
       next to the season that was requested — if they differ, that is
       visible in the data, not papered over.
     * One raw athlete object is preserved verbatim in the JSON so a
       consumer can audit exactly what the feed provides.

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
const API = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';

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

const S = v => (v == null ? '' : String(v).trim());

function heightOf(a) {
  if (a.displayHeight) return S(a.displayHeight);
  const h = +a.height;
  if (isFinite(h) && h > 0) return `${Math.floor(h / 12)}-${h % 12}`;
  return '';
}
function classOf(a) {
  const e = a.experience || {};
  return S(e.displayValue || e.abbreviation || a.class ||
    (e.years != null ? `yr ${e.years}` : ''));
}
function hometownOf(a) {
  const b = a.birthPlace || a.hometown || {};
  if (typeof b === 'string') return S(b);
  return [S(b.city), S(b.state || b.country)].filter(Boolean).join(', ');
}
function normalizeAthlete(a) {
  return {
    name: S(a.displayName || a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' ')),
    jersey: S(a.jersey),
    position: S(a.position && (a.position.abbreviation || a.position.displayName)),
    class: classOf(a),
    height: heightOf(a),
    weight: S(a.displayWeight || (a.weight ? a.weight + ' lbs' : '')),
    hometown: hometownOf(a),
    high_school: S(a.highSchool || (a.lastSchool && !a.lastSchool.isCollege ? a.lastSchool.name : '')),
    previous_school: S(a.lastSchool && a.lastSchool.isCollege ? a.lastSchool.name : ''),
    espn_id: S(a.id)
  };
}

async function main() {
  const args = process.argv.slice(2);
  let season = defaultSeason();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--season') season = parseInt(args[++i], 10);
    else { console.error('unknown option: ' + args[i]); process.exit(1); }
  }
  const retrievedAt = new Date().toISOString();

  const teamsJson = await fetchJson(`${API}/teams?groups=80&limit=200`);
  const teams = (((teamsJson.sports || [])[0] || {}).leagues || [])[0];
  const list = ((teams && teams.teams) || []).map(t => t.team).filter(Boolean);
  if (list.length < 100) throw new Error(`FBS team list looks wrong: ${list.length} teams`);
  console.log(`FBS team list: ${list.length} teams`);

  const out = {
    schema: 'edgedesk_fbs_rosters_v1',
    source: 'ESPN site API (public, keyless): /teams?groups=80 + /teams/{id}/roster',
    requested_season: season,
    retrieved_at: retrievedAt,
    team_count: list.length,
    sample_raw_athlete: null,
    teams: []
  };

  let totalPlayers = 0, emptyTeams = 0;
  for (const t of list) {
    let rosterJson = null, err = null;
    try {
      rosterJson = await fetchJson(`${API}/teams/${t.id}/roster?season=${season}`);
    } catch (e) { err = (e && e.message) || 'fetch failed'; }
    const groups = (rosterJson && rosterJson.athletes) || [];
    const players = [];
    for (const g of groups) {
      const items = Array.isArray(g) ? g : (g.items || []);
      for (const a of items) {
        if (!out.sample_raw_athlete) out.sample_raw_athlete = a;
        players.push(normalizeAthlete(a));
      }
    }
    players.sort((x, y) => x.name.localeCompare(y.name));
    const reported = rosterJson && rosterJson.season && rosterJson.season.year;
    out.teams.push({
      espn_id: S(t.id),
      location: S(t.location), display_name: S(t.displayName),
      short_name: S(t.shortDisplayName), abbreviation: S(t.abbreviation),
      nickname: S(t.nickname),
      season_reported: reported != null ? reported : null,
      fetch_error: err,
      player_count: players.length,
      players
    });
    totalPlayers += players.length;
    if (!players.length) emptyTeams++;
    console.log(`${t.displayName}: ${players.length} players`
      + (reported != null && reported !== season ? ` (API reports season ${reported}!)` : '')
      + (err ? ` FETCH ERROR: ${err}` : ''));
    await new Promise(res => setTimeout(res, 250));
  }
  console.log(`total ${totalPlayers} players across ${list.length} teams; ${emptyTeams} teams empty`);
  if (totalPlayers < 5000) throw new Error(`dataset too small to be a real FBS roster pull (${totalPlayers} players)`);

  fs.writeFileSync(path.join(OUT_DIR, `fbs_${season}_espn.json`), JSON.stringify(out, null, 1) + '\n');

  const q = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const rows = ['team,espn_team_id,player,jersey,position,class,height,weight,hometown,high_school,previous_school,espn_player_id,season_requested,season_reported,retrieved_at'];
  for (const tm of out.teams) {
    for (const p of tm.players) {
      rows.push([tm.display_name, tm.espn_id, p.name, p.jersey, p.position, p.class, p.height,
        p.weight, p.hometown, p.high_school, p.previous_school, p.espn_id,
        season, tm.season_reported == null ? '' : tm.season_reported, retrievedAt].map(x => q(S(x))).join(','));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `fbs_${season}_espn.csv`), rows.join('\n') + '\n');
  console.log(`wrote fbs_${season}_espn.json and .csv`);
}

main().catch(e => { console.error('roster fetch failed:', e); process.exit(1); });
