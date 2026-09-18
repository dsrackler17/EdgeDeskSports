#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — THE INGEST.

   WHY IT UNIONS TWO SOURCES. Both were measured against each other on one day
   of the 2026 season, and neither was complete:

     the day scoreboard had        81 games
     the 437-team schedule walk    95 games, 21 the scoreboard did not have
     but 7 of the scoreboard's games were missing from the walk

   So a board built on either alone would have been short, and would have
   looked complete while being short. The union of the two is the card. A game
   appears on both its teams' schedules, so the walk recovers what the
   scoreboard curates away; the scoreboard in turn covers teams whose schedule
   endpoint answers thinly, which on a season the provider still labels
   Preseason is 119 of 437 of them.

   WHY IT PACES ITSELF. The same URL returns 81 games when asked politely and
   0 when asked in a burst — twelve paced requests returned 81 every time.
   An unpaced ingest would not fail, it would quietly import an empty day.

   WHAT IT NEVER DOES. It does not write a live table. It stages rows and calls
   the promote gate, which refuses an import that shrank, an import that is
   empty, a duplicated game id, a finished game with no score, and a game whose
   season is not its own date's year. Every one of those refusals is a way this
   could have silently damaged a working board.

   The shaping below is pure and has no network in it, so it is tested against
   fixtures on a machine that cannot reach the source — which is every machine
   this was written on.

   Run:  node tools/cbb/ingest.js --from 2026-02-01 --through 2026-06-30 --check
         node tools/cbb/ingest.js --season 2026 --commit
   =========================================================================== */
'use strict';

const ESPN = process.env.CBB_ESPN
  || 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';

/* ── the season is the calendar year: college baseball runs February to June ─ */
function seasonOf(dateISO) { return Number(String(dateISO).slice(0, 4)); }

/* ── shaping: one event, from either source, into one row ──────────────────
   The two payloads differ in shape but describe the same thing, so both land
   here and the difference is handled once. */
function shapeEvent(ev, seenBy) {
  if (!ev || !ev.id) return null;
  const comp = (ev.competitions || [])[0] || {};
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home') || null;
  const away = cs.find((c) => c.homeAway === 'away') || null;
  if (!home || !away) return null;

  const nameOf = (c) => (c && c.team && (c.team.displayName || c.team.name || c.team.location)) || null;
  const idOf = (c) => (c && c.team && c.team.id != null) ? String(c.team.id) : null;
  const abbrOf = (c) => (c && c.team && c.team.abbreviation) || null;
  const scoreOf = (c) => {
    const raw = c && (typeof c.score === 'object' ? (c.score || {}).value : c.score);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const rankOf = (c) => {
    const r = c && c.curatedRank && c.curatedRank.current;
    /* the source spells "unranked" as 99; a 99 on a board would read as a rank */
    return (r == null || r === 99) ? null : Number(r);
  };

  const status = (ev.status || comp.status || {});
  const stype = status.type || {};
  const state = stype.state || null;
  const detail = stype.description || stype.detail || stype.shortDetail || null;
  const awayName = nameOf(away), homeName = nameOf(home);
  if (!awayName || !homeName) return null;

  const date = String(ev.date || comp.date || '');
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const aS = scoreOf(away), hS = scoreOf(home);
  const completed = stype.completed === true || state === 'post';

  const venue = comp.venue || {};
  const addr = venue.address || {};

  return {
    game_id: String(ev.id),
    season: seasonOf(day),
    game_date: day,
    /* a start time the source has not settled is carried as a flag rather than
       as a wrong time — a board that prints 00:00 has invented one */
    start_time: /T\d\d:\d\d/.test(date) && !/T00:00Z?$/.test(date) ? date : null,
    start_time_tbd: !(/T\d\d:\d\d/.test(date)) || /T00:00Z?$/.test(date),
    away_team_id: idOf(away), home_team_id: idOf(home),
    away_name: awayName, home_name: homeName,
    away_abbr: abbrOf(away), home_abbr: abbrOf(home),
    venue: venue.fullName || null,
    venue_city: addr.city || null,
    venue_state: addr.state || null,
    neutral_site: comp.neutralSite === true,
    conference_game: comp.conferenceCompetition === true,
    status_state: state, status_detail: detail,
    completed,
    away_score: aS, home_score: hS,
    innings: (status.period != null && Number(status.period) > 0) ? Number(status.period) : null,
    away_rank: rankOf(away), home_rank: rankOf(home),
    notes: ((comp.notes || [])[0] || {}).headline || ((ev.notes || [])[0] || {}).headline || null,
    seen_by: [seenBy],
  };
}

/* ── the union ────────────────────────────────────────────────────────────
   Keyed on the source's own game id. When both sources have a game, the
   richer row wins field by field rather than wholesale: the scoreboard tends
   to carry the live score and the schedule tends to carry the venue, and
   taking one row entire would throw away whichever half the other had. */
const RICHER = ['start_time', 'venue', 'venue_city', 'venue_state', 'status_state', 'status_detail',
  'away_score', 'home_score', 'innings', 'away_rank', 'home_rank', 'notes',
  'away_team_id', 'home_team_id', 'away_abbr', 'home_abbr'];

function mergeGame(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = Object.assign({}, a);
  for (const f of RICHER) if (out[f] == null && b[f] != null) out[f] = b[f];
  /* a completed game stays completed even if the other source is stale */
  out.completed = a.completed || b.completed;
  if (b.completed && b.away_score != null && a.away_score == null) {
    out.away_score = b.away_score; out.home_score = b.home_score;
  }
  out.neutral_site = a.neutral_site || b.neutral_site;
  out.conference_game = a.conference_game || b.conference_game;
  out.start_time_tbd = out.start_time == null;
  out.seen_by = Array.from(new Set([].concat(a.seen_by || [], b.seen_by || []))).sort();
  return out;
}

function unionGames(lists) {
  const by = new Map();
  for (const list of lists) {
    for (const row of (list || [])) {
      if (!row || !row.game_id) continue;
      by.set(row.game_id, mergeGame(by.get(row.game_id), row));
    }
  }
  return Array.from(by.values()).sort((x, y) =>
    (x.game_date === y.game_date
      ? String(x.start_time || '').localeCompare(String(y.start_time || ''))
      : x.game_date.localeCompare(y.game_date)));
}

function shapeTeam(t, season) {
  if (!t || t.id == null) return null;
  return {
    team_id: String(t.id),
    name: t.displayName || t.name || t.location || String(t.id),
    short_name: t.shortDisplayName || t.name || null,
    abbreviation: t.abbreviation || null,
    slug: t.slug || null,
    conference_id: null, conference_name: null,
    logo: (t.logos && t.logos[0] && t.logos[0].href) || t.logo || null,
    color: t.color || null,
    first_seen_season: season, last_seen_season: season,
  };
}

module.exports = { seasonOf, shapeEvent, mergeGame, unionGames, shapeTeam, ESPN, RICHER };

/* ── the network half, which only ever runs where the source is reachable ── */
if (require.main === module) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const has = (n) => argv.indexOf(n) >= 0;
  const PACE = Number(arg('--pace', 120));

  async function get(url, tries = 3) {
    for (let i = 0; i < tries; i++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
        const body = await r.text(); clearTimeout(t);
        if (r.status === 200) { try { return JSON.parse(body); } catch (_) { return null; } }
      } catch (_) { clearTimeout(t); }
      await sleep(600 * (i + 1));
    }
    return null;
  }

  (async function main() {
    const season = Number(arg('--season', new Date().getFullYear()));
    const from = arg('--from', `${season}-02-01`);
    const through = arg('--through', `${season}-06-30`);
    const log = (...a) => console.log('[cbb]', ...a);

    if (!has('--check') && !has('--commit')) {
      console.log('Nothing to do. Pass --check (fetch and validate, write nothing) or --commit.');
      process.exit(0);
    }

    /* teams first: the walk needs their ids, and the board needs their names */
    const tj = await get(`${ESPN}/teams?limit=1000`);
    const rawTeams = ((((tj || {}).sports || [])[0] || {}).leagues || [])[0];
    const teams = (((rawTeams || {}).teams) || []).map((x) => x.team).filter(Boolean);
    log(`${teams.length} teams`);
    if (!teams.length) { console.log('FAIL | cbb ingest | the team list came back empty'); process.exit(1); }

    /* source A — every day in the window */
    const dayRows = [];
    const d0 = new Date(from + 'T00:00:00Z'), d1 = new Date(through + 'T00:00:00Z');
    let days = 0;
    for (let d = new Date(d0); d <= d1; d.setUTCDate(d.getUTCDate() + 1)) {
      const compact = d.toISOString().slice(0, 10).replace(/-/g, '');
      const j = await get(`${ESPN}/scoreboard?dates=${compact}&limit=1000`);
      for (const ev of ((j || {}).events || [])) {
        const row = shapeEvent(ev, 'scoreboard');
        if (row) dayRows.push(row);
      }
      days++;
      await sleep(PACE);
    }
    log(`scoreboard: ${dayRows.length} games across ${days} days`);

    /* source B — every team's own schedule */
    const schedRows = [];
    let answered = 0;
    for (const t of teams) {
      const j = await get(`${ESPN}/teams/${t.id}/schedule?season=${season}`, 2);
      if (!j) continue;
      answered++;
      for (const ev of (j.events || [])) {
        const row = shapeEvent(ev, 'team_schedule');
        if (row && row.game_date >= from && row.game_date <= through) schedRows.push(row);
      }
      await sleep(PACE);
    }
    log(`team walk: ${answered}/${teams.length} answered, ${schedRows.length} game rows`);

    const games = unionGames([dayRows, schedRows]);
    const onlySb = games.filter((g) => g.seen_by.length === 1 && g.seen_by[0] === 'scoreboard').length;
    const onlyTw = games.filter((g) => g.seen_by.length === 1 && g.seen_by[0] === 'team_schedule').length;
    log(`union: ${games.length} games (${onlySb} only the scoreboard saw, ${onlyTw} only the walk saw)`);
    if (!games.length) { console.log('FAIL | cbb ingest | the union is empty; refusing to go further'); process.exit(1); }

    if (!has('--commit')) {
      console.log(`PASS | cbb ingest | --check only, nothing written (${games.length} games, ${teams.length} teams)`);
      process.exit(0);
    }

    const P = require('../mlb/pg_client.js');
    const db = P.client();
    const importId = `cbb-${season}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
    await require('./stage.js').stageAndPromote(db, importId, { season, from, through, games,
      teams: teams.map((t) => shapeTeam(t, season)).filter(Boolean), log,
      /* only ever true because a human said so on the run: the gate's
         shrinkage refusal is the one thing standing between a throttled
         answer and a deleted card */
      allowShrink: has('--allow-shrink') });
  })().catch((e) => { console.log('FAIL | cbb ingest | ' + (e && e.stack || e)); process.exit(1); });
}
