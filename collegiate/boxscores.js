'use strict';
/* ===========================================================================
   EdgeDesk collegiate — a baseball box score, read from a school's own site.

   A SIDEARM box score page carries the whole game in its Nuxt data
   (pinia.boxscore): both teams with their NCAA team codes (the ids our
   college baseball record uses), the line score, every pitcher in order of
   appearance with innings, batters faced, strikeouts, walks and pitches,
   every starting batter with lineup spot, position and bats, each player's
   throwing hand, and the game's venue, attendance, scheduled innings,
   doubleheader flag and weather as the official scorer wrote it.

   Kept: what a model can use. The starter of each side is the pitcher with
   order of appearance 1. Weather is kept as written and split only where
   it reads plainly ("69, Mostly Cloudy, N 24 MPH" -> 69 F, Mostly Cloudy,
   wind N 24); anything else stays as written, never guessed.
   =========================================================================== */
const { nuxtData } = require('./nuxt');

const num = (v) => { if (v === '' || v == null) return null; const n = +v; return Number.isFinite(n) ? n : null; };
/* innings pitched "4.1" = 4 innings and 1 out = 13 outs; a ".3" or worse is not an innings value */
function outsOf(ip) {
  const m = String(ip == null ? '' : ip).match(/^(\d+)(?:\.([012]))?$/);
  return m ? +m[1] * 3 + (+m[2] || 0) : null;
}
/* "Last, First" (and "Last,First") read as "First Last" */
const nameOf = (p) => { const n = p.playerFirstLastName || p.checkName || p.name || null; return n && /,/.test(n) ? n.split(',').map((s) => s.trim()).filter(Boolean).reverse().join(' ') : n; };
const hand = (h) => (/^[LRS]$/.test(String(h || '').toUpperCase()) ? String(h).toUpperCase() : /^B$/i.test(String(h || '')) ? 'S' : null);

function weather(w) {
  const raw = w && String(w).trim() && String(w).trim() !== '0' ? String(w).trim() : null;
  if (!raw) return { raw: null, temp_f: null, sky: null, wind_dir: null, wind_mph: null };
  const parts = raw.split(',').map((s) => s.trim());
  const t = parts[0] && /^-?\d{1,3}$/.test(parts[0]) ? +parts[0] : null;
  const wind = raw.match(/\b(N|NE|E|SE|S|SW|W|NW|NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|L-R|R-L|IN|OUT|CALM)\b[^,\d]*(\d{1,2})\s*MPH/i);
  const sky = t != null && parts[1] && !/mph/i.test(parts[1]) ? parts[1] : null;
  return { raw, temp_f: t, sky, wind_dir: wind ? wind[1].toUpperCase() : null, wind_mph: wind ? +wind[2] : null };
}

function team(t) {
  const players = t.players || [];
  const pitchers = players.filter((p) => p.pitching).map((p) => ({ order: num(p.pitching.orderOfAppearance), name: nameOf(p), roster_player_id: p.rosterPlayerId || null,
    throws: hand(p.throws), outs: outsOf(p.pitching.inningsPitched), bf: num(p.pitching.battersFaced), k: num(p.pitching.strikeouts), bb: num(p.pitching.walksAllowed),
    h: num(p.pitching.hitsAllowed), r: num(p.pitching.runsAllowed), er: num(p.pitching.earnedRunsAllowed), hr: num(p.pitching.homerunsAllowed), pitches: num(p.pitching.pitches),
    started: p.pitching.gamesStarted === '1' }))
    .sort((a, b) => (a.order == null ? 99 : a.order) - (b.order == null ? 99 : b.order));
  const lineup = players.filter((p) => p.gameStarted === '1' && num(p.spot) >= 1 && num(p.spot) <= 9).map((p) => ({ spot: num(p.spot), name: nameOf(p), roster_player_id: p.rosterPlayerId || null, pos: p.position || null, bats: hand(p.bats) }))
    .sort((a, b) => a.spot - b.spot);
  const ss = t.scoringSummary || {};
  const line = String(ss.scoreByInnings || '').split(',').filter((x) => x !== '').map((x) => (x === 'X' || x === 'x' ? null : num(x)));
  return { code: t.code ? String(t.code) : null, name: t.name || null, runs: num(t.score != null ? t.score : ss.runs), hits: num(ss.hits), errors: num(ss.errors), line,
    starter: pitchers.find((p) => p.order === 1) || pitchers.find((p) => p.started) || null, pitchers, lineup };
}

/* SIDEARM: one game, or null when the page carries no box score */
function sidearmBoxscore(data) {
  const store = data && data.pinia && data.pinia.boxscore && data.pinia.boxscore.boxscore;
  if (!store || typeof store !== 'object') return null;
  const b = Object.values(store).find((x) => x && x.homeTeam && x.visitingTeam);
  if (!b) return null;
  const v = b.venue || {};
  const m = String(v.date || b.gameDate || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return {
    platform: 'sidearm', date: m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : null,
    neutral: !!(v.isNeutral || b.isNeutral), conference: !!(v.isALeagueGame || b.isALeagueGame), scheduled_innings: num(v.scheduledInnings),
    doubleheader_game: num(v.doubleHeaderGame) || 0, attendance: num(String(v.attendance || '').replace(/,/g, '')), stadium: v.stadium || null, location: v.location || null,
    weather: weather(v.weather), home: team(b.homeTeam), away: team(b.visitingTeam),
  };
}

function parseBoxscore(html) {
  const data = nuxtData(html);
  if (!data) return null;
  return sidearmBoxscore(data);
}

module.exports = { parseBoxscore, sidearmBoxscore, outsOf, weather };
