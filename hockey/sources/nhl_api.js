'use strict';
/* ===========================================================================
   EdgeDesk NHL — the NHL's own public web API (api-web.nhle.com), for the
   one thing the season files cannot give: today's schedule and game states
   to the minute.

     GET /v1/schedule/{YYYY-MM-DD}  → { gameWeek: [{ date, games: [...] }] }

   Game objects carry id, gameType (1 preseason · 2 regular · 3 playoffs),
   gameDate, startTimeUTC, gameState (FUT, PRE, LIVE, CRIT, FINAL, OFF),
   venue.default, homeTeam/awayTeam { abbrev, score }. This is the same
   object the sportsdataverse scraper parses (fastRhockey-nhl-raw
   python/nhl_raw/schedule.py), so the two sources normalise to one shape.

   The API is undocumented and keyless. Calls go through the guarded client
   (engine/http.js: provider `nhl_api`, ≤ 300 requests a run, 250 ms apart,
   cached 10 minutes, breaker after repeated failures). When it cannot be
   reached the slate falls back to the season schedule file and says so.
   =========================================================================== */
const io = require('../lib/io');
const C = require('../config');

const TYPE = { 1: 'PR', 2: 'R', 3: 'P', 4: 'A' };

function parseSchedule(json) {
  const out = [];
  const weeks = json && Array.isArray(json.gameWeek) ? json.gameWeek : [];
  for (const w of weeks) for (const g of (w && w.games) || []) {
    const t = TYPE[g.gameType] || null;
    if (!g || g.id == null || !g.homeTeam || !g.awayTeam) continue;
    out.push({
      game_id: Number(g.id), game_type: t, date: g.gameDate || w.date || null, start_utc: g.startTimeUTC || null,
      home: g.homeTeam.abbrev || null, away: g.awayTeam.abbrev || null, state: g.gameState || null,
      venue: g.venue && g.venue.default ? g.venue.default : null,
      home_score: g.homeTeam.score == null ? null : Number(g.homeTeam.score), away_score: g.awayTeam.score == null ? null : Number(g.awayTeam.score),
      source: 'nhl_api',
    });
  }
  return out;
}

async function fetchWeek(date) {
  const url = C.SOURCES.nhl_schedule_day(date);
  const res = await io.http().get(url, { ttlMs: 10 * 60e3 });
  if (!res.ok) return { ok: false, url, error: res.error, games: [] };
  let json = null;
  try { json = res.json(); } catch (e) { return { ok: false, url, error: { code: 'BAD_JSON', message: String(e.message).slice(0, 120) }, games: [] }; }
  return { ok: true, url, fetched_at: res.fetchedAt, stale: !!res.stale, games: parseSchedule(json) };
}

module.exports = { parseSchedule, fetchWeek };
