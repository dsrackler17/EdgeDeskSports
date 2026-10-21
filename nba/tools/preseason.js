#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — preseason minutes, the Roster-Adjusted Projection's prior for
   this season's roles (nba/injury/core.js nbaExpectedMinutes).

     node nba/tools/preseason.js [--season 2027] [--from 2026-09-25 --to 2026-10-20]

   T0. ESPN's public scoreboard for the preseason (seasontype=1) lists the
   games; each finished game's summary carries the box score. hoopR, the
   engine's main source, publishes no preseason games, so this is the only
   preseason feed EdgeDesk reads. Writes nba/data/preseason/<season>.json
   (schema edgedesk_nba_preseason_v1):

     games    every finished preseason game read: id, date, teams
     players  by ESPN athlete id: name, team (his last preseason team),
              games with minutes > 0, mean and total minutes
     unread   every game whose box score did not read, with why

   A game already in the file is not fetched again; a game that does not read
   is listed, never estimated; nothing is written when no game reads at all
   (the build then prices without the prior and says so). The file is written
   only when its games changed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const UA = { 'user-agent': 'EdgeDesk research (+https://edgedesksports.com)' };
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const ymd = (s) => String(s).replace(/-/g, '');

async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + ' answered HTTP ' + r.status);
  return r.json();
}

/** a scoreboard -> finished preseason games */
function parseScoreboard(json) {
  return ((json && json.events) || []).filter((e) => {
    const st = e && e.status && e.status.type;
    const typ = e && e.season && e.season.type;
    return st && st.completed && (typ == null || Number(typ) === 1);
  }).map((e) => {
    const comp = (e.competitions || [])[0] || {}, cs = comp.competitors || [];
    const side = (k) => { const c = cs.find((x) => x.homeAway === k); return c && c.team ? String(c.team.id) : null; };
    return { game_id: String(e.id), date: String(e.date || '').slice(0, 10), home_id: side('home'), away_id: side('away') };
  });
}
/** a game summary -> each player's minutes; null with why when the box score does not read */
function parseSummary(json) {
  const teams = (json && json.boxscore && json.boxscore.players) || [];
  if (!teams.length) return { ok: false, why: 'no box score in the summary' };
  const rows = [];
  for (const t of teams) {
    const teamId = t.team ? String(t.team.id) : null;
    const st = (t.statistics || [])[0];
    if (!st || !Array.isArray(st.athletes)) return { ok: false, why: 'a team has no player statistics' };
    const keys = (st.keys || []).map((k) => String(k).toLowerCase()), labels = (st.labels || st.names || []).map((k) => String(k).toUpperCase());
    let mi = keys.indexOf('minutes'); if (mi < 0) mi = labels.indexOf('MIN');
    if (mi < 0) return { ok: false, why: 'no minutes column (keys ' + keys.join(',') + ')' };
    for (const a of st.athletes) {
      const id = a.athlete && a.athlete.id != null ? String(a.athlete.id) : null;
      if (!id) continue;
      const raw = a.didNotPlay ? null : (a.stats || [])[mi];
      const m = raw == null ? null : /^(\d+)(?::(\d+))?$/.exec(String(raw).trim());
      const min = m ? Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0) : 0;
      rows.push({ id, name: a.athlete.displayName || a.athlete.fullName || id, team_id: teamId, minutes: min });
    }
  }
  return { ok: true, rows };
}
/** every game's rows -> players (a player's team is his last game's) */
function aggregate(gamesRead) {
  const players = {};
  gamesRead.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach((g) => {
    for (const r of g.rows) {
      if (!(r.minutes > 0)) continue;
      const p = players[r.id] || (players[r.id] = { name: r.name, team_id: r.team_id, games: 0, minutes_total: 0, minutes_mean: 0 });
      p.games++; p.minutes_total += r.minutes; p.team_id = r.team_id; p.name = r.name;
    }
  });
  for (const id of Object.keys(players)) { const p = players[id]; p.minutes_total = Math.round(p.minutes_total * 100) / 100; p.minutes_mean = Math.round(p.minutes_total / p.games * 100) / 100; }
  return players;
}

async function run() {
  const season = Number(arg('season', C.currentSeason()));
  const file = path.join(C.PATHS.preseason, season + '.json');
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { prev = null; }
  const from = arg('from', (season - 1) + '-09-25'), to = arg('to', (season - 1) + '-10-24');
  const sb = await getJson(SITE + '/scoreboard?seasontype=1&limit=400&dates=' + ymd(from) + '-' + ymd(to));
  const games = parseScoreboard(sb);
  const have = new Map(((prev && prev.read) || []).map((g) => [g.game_id, g]));
  const read = [], unread = [];
  for (const g of games) {
    if (have.has(g.game_id)) { read.push(have.get(g.game_id)); continue; }
    try {
      const s = parseSummary(await getJson(SITE + '/summary?event=' + g.game_id));
      if (s.ok) read.push(Object.assign({}, g, { rows: s.rows })); else unread.push({ game_id: g.game_id, why: s.why });
    } catch (e) { unread.push({ game_id: g.game_id, why: String(e.message || e).slice(0, 200) }); }
  }
  if (!read.length) { console.log('[nba preseason] ' + season + ': no preseason box score read (' + games.length + ' games listed, ' + unread.length + ' unread); nothing written'); return; }
  const out = { schema: C.SCHEMA.preseason, season, source: 'ESPN public scoreboard (seasontype=1) and game summaries, ' + SITE, generated_at: new Date().toISOString(),
    window: [from, to], games: read.map((g) => ({ game_id: g.game_id, date: g.date, home_id: g.home_id, away_id: g.away_id })), players: aggregate(read), unread, read };
  const same = prev && JSON.stringify(prev.games) === JSON.stringify(out.games) && JSON.stringify(prev.unread) === JSON.stringify(out.unread);
  if (!same) { fs.mkdirSync(C.PATHS.preseason, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out) + '\n'); }
  console.log('[nba preseason] ' + season + ': ' + read.length + ' games read, ' + unread.length + ' unread, ' + Object.keys(out.players).length + ' players' + (same ? ' (unchanged)' : ''));
}

module.exports = { parseScoreboard, parseSummary, aggregate };
if (require.main === module) run().catch((e) => { console.error('[nba preseason] ' + (e && e.message || e)); process.exit(1); });
