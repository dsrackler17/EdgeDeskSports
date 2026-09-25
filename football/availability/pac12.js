#!/usr/bin/env node
/* ============================================================================
   THE PAC-12's AVAILABILITY REPORTS, READ FROM THE FILE ITS PAGE RENDERS.

   The Pac-12 does not use the platform the other conferences embed
   (football/availability/hdi.js). Its reports page,

     https://pac-12.com/news/2026/9/11/2026-football-reports.aspx

   renders one JSON file with its own script, and polls it every thirty
   seconds for changes:

     https://sbcautostorage.blob.core.windows.net/availability-reports/
       pac12-football/prod/report.json

   EdgeDesk reads that file and nothing else, as the page does.

   THE SHAPE is the one the page's own renderer reads (probe_sources.js
   printed it on 2026-09-25, when the file carried no game yet because
   conference play begins on 3 October):

     { config: {...},
       games: [ { gameId, dateISO, kickoff, timeZone, timeZoneLabel,
                  notes,          the filing's label ("Initial Report", ...)
                  updatedAtUTC,   when it was filed, in UTC
                  away: { name, players: [ { name, position, status } ] },
                  home: { name, players: [...] } } ] }

   A game can appear more than once; the page keeps the latest updatedAtUTC
   per gameId, and so does this.

   WHAT A LISTING MEANS. The page lists REPORTED players only and prints "No
   reported players." for a side with none. A side the file lists nobody for
   is therefore a read that names nobody (reports.js fromListing
   reported_only), never a clean bill of health.

   The file can carry a raw line break inside a quoted string. The page
   repairs that before parsing, and so does this.

   This file reads no roster and writes no report; sync_reports.js does both.
   ========================================================================== */
'use strict';
const path = require('path');
const HDI = require(path.join(__dirname, 'hdi.js'));

const PAGE_URL = 'https://pac-12.com/news/2026/9/11/2026-football-reports.aspx';
const DATA_URL = 'https://sbcautostorage.blob.core.windows.net/availability-reports/pac12-football/prod/report.json';
const UA = 'EdgeDesk-availability-sync (+https://edgedesksports.com)';

/* the page's stripNewlinesInsideStrings, then JSON.parse */
function parseTolerant(txt) {
  try { return JSON.parse(txt); } catch (_) { /* repaired below */ }
  let out = '', inString = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (ch === '"' && txt[i - 1] !== '\\') { inString = !inString; out += ch; }
    else if (inString && (ch === '\n' || ch === '\r')) out += ' ';
    else out += ch;
  }
  return JSON.parse(out);
}

async function fetchFeed(fetchImpl, now) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(DATA_URL + '?ts=' + (now || Date.now()), { redirect: 'follow', signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': UA, accept: 'application/json', 'cache-control': 'no-cache' } });
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status + ' from the Pac-12 report file' };
    let data;
    try { data = parseTolerant(await r.text()); }
    catch (e) { return { ok: false, why: 'the Pac-12 report file is not JSON the page itself could read' }; }
    if (!data || typeof data !== 'object' || !Array.isArray(data.games)) {
      return { ok: false, why: 'the Pac-12 report file carries no list of games' };
    }
    return { ok: true, data, last_modified: (r.headers && r.headers.get && r.headers.get('last-modified')) || null };
  } catch (e) {
    return { ok: false, why: 'the Pac-12 report file could not be read — ' + String((e && e.message) || e).slice(0, 200) };
  }
}

function isoOf(v) {
  const t = Date.parse(String(v || ''));
  return isFinite(t) ? new Date(t).toISOString() : null;
}

/* one side, as the listing shape reports.js fromListing reads */
function teamListing(team) {
  if (!team || !team.name) return null;
  const players = Array.isArray(team.players) ? team.players.filter(p => p && p.name) : [];
  return {
    team_name: String(team.name), team_display: String(team.name),
    listed: players.map(p => {
      const raw = p.status == null ? null : String(p.status).trim();
      const st = HDI.statusOf(raw);
      return { position: p.position ? String(p.position).trim() : null, jersey: null,
        player_name: String(p.name).trim(), nickname: null, status_raw: raw, status: st.status, known: st.known,
        exempt: st.status === 'EXEMPT', raw_text: [p.name, p.position, raw].filter(Boolean).join(' · ') };
    })
  };
}

/* one game, flattened to the entry shape hdi.matchFixture and hdi.sideOf read */
function readGame(g) {
  return {
    report_id: g && g.gameId != null ? String(g.gameId) : null,
    report_type: g && g.notes ? String(g.notes).trim() : null,
    /* the filing time the conference stamps, in UTC; nothing else dates it */
    published_at: isoOf(g && g.updatedAtUTC),
    game_date: g && g.dateISO ? String(g.dateISO).slice(0, 10) : null,
    vocabulary: [],
    teams: [teamListing(g && g.away), teamListing(g && g.home)].filter(Boolean)
  };
}

/* every game in the file, the latest filing per game (as the page shows it) */
function readFeed(data) {
  const latest = {};
  ((data && data.games) || []).forEach(g => {
    if (!g) return;
    const id = g.gameId != null ? String(g.gameId)
      : ((g.away && g.away.name) || '') + ' @ ' + ((g.home && g.home.name) || '') + ' ' + String(g.dateISO || '').slice(0, 10);
    if (!latest[id] || String(g.updatedAtUTC || '') > String(latest[id].updatedAtUTC || '')) latest[id] = g;
  });
  return Object.keys(latest).map(k => readGame(latest[k]));
}

module.exports = { PAGE_URL, DATA_URL, parseTolerant, fetchFeed, readGame, readFeed, teamListing };
