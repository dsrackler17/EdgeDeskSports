'use strict';
/* ===========================================================================
   EdgeDesk slate — the schedules this repository already builds, as slate
   events. The fallback adapter.

   ESPN is the slate's primary schedule source because it is one feed with live
   status, scores and logos for every sport. It is not the only schedule
   EdgeDesk holds: the football, hockey, soccer and basketball jobs commit
   their own, from their own sources, on their own cadence:

     football/home/schedule.json   NFL (nflverse) + FBS (cfbfastR, ESPN ids)
     hockey/slate.json             NHL (sportsdataverse / NHL API), 72 h
     soccer/slate.json             five leagues (openfootball, CC0), 4 days
     basketball/slate.json         NBA / NCAAM (hoopR, ESPN ids), 72 h

   When ESPN cannot be read for a sport and the slate holds no earlier ESPN
   read of that day, these are the slate. They carry no live state: a game
   from here is SCHEDULED until its start, and the page says "Started" with
   no score after it, never "Live".

   Ids follow the source. A CFB or basketball game is an ESPN id already, so
   it is the same event as ESPN's read of it. An NFL game keeps its nflverse
   id, an NHL game its NHL id and a soccer match its openfootball key; the
   slate's cross-provider match (EDGames.sameEvent) makes either read of the
   same game one game.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_games.js'));
const ROOT = path.join(__dirname, '..', '..');

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; }
}
function side(name, abbr, id) {
  return { id: id != null ? String(id) : null, name: name || null, short: name || null, abbr: abbr || null, logo: null, score: null, record: null, winner: null, rank: null };
}
function ev(o) {
  return Object.assign({
    status: 'SCHEDULED', status_detail: null, period: null, clock: null, time_tbd: false,
    neutral: null, venue: null, city: null, notes: null, game_number: null, title: null, bouts: null,
    season: null, week: null, live_feed: false
  }, o);
}

/* the local wall-clock time of a league's home zone → UTC (openfootball
   gives "15:00" on a date, with no zone; the league's own zone is the only
   honest reading, and the event says that is how it was read) */
const LEAGUE_ZONE = { epl: 'Europe/London', bundesliga: 'Europe/Berlin', laliga: 'Europe/Madrid', seriea: 'Europe/Rome', ligue1: 'Europe/Paris' };
const LEAGUE_LABEL = { epl: 'Premier League', bundesliga: 'Bundesliga', laliga: 'La Liga', seriea: 'Serie A', ligue1: 'Ligue 1' };
function zonedToUtc(date, hhmm, zone) {
  if (!G.isDateKey(date) || !/^\d{1,2}:\d{2}$/.test(String(hhmm || ''))) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  const b = G.dayBounds(date, zone);
  /* walk from the start of the local day; correct across a DST change by
     re-reading the wall clock (at most two corrections) */
  let t = b.from + (h * 60 + m) * 60000;
  for (let i = 0; i < 3; i++) {
    const w = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
    const o = {}; w.forEach((p) => { o[p.type] = p.value; });
    const diff = (h * 60 + m) - ((+o.hour % 24) * 60 + (+o.minute));
    if (!diff) break;
    t += diff * 60000;
  }
  return new Date(t).toISOString();
}

function football(asOf) {
  const s = readJson('football/home/schedule.json');
  if (!s || !Array.isArray(s.games)) return { events: [], source: null };
  const events = [];
  s.games.forEach((g) => {
    const id = String(g.key || '').split('|')[1];
    const lg = g.league === 'nfl' ? 'nfl' : g.league === 'cfb' ? 'cfb' : null;
    if (!id || !lg || G.toMs(g.kickoff) == null) return;
    events.push(ev({
      id: lg === 'nfl' ? 'nfl:nflverse:' + id : 'cfb:espn:' + id,
      sport: lg, league: lg === 'nfl' ? 'NFL' : 'FBS', provider: lg === 'nfl' ? 'nflverse' : 'espn', provider_id: id,
      start_utc: new Date(G.toMs(g.kickoff)).toISOString(),
      home: side(g.home, g.home_code || null), away: side(g.away, g.away_code || null),
      venue: g.venue || null, week: g.week != null ? g.week : null,
      conf: g.away_conf || g.home_conf ? { away: g.away_conf || null, home: g.home_conf || null } : null,
      updated_at: s.generated_at || asOf, source_file: 'football/home/schedule.json'
    }));
  });
  return { events, source: { file: 'football/home/schedule.json', generated_at: s.generated_at || null, sports: ['nfl', 'cfb'] } };
}

function hockey(asOf) {
  const s = readJson('hockey/slate.json');
  const t = (readJson('hockey/data/teams.json') || {}).teams || {};
  if (!s || !Array.isArray(s.games)) return { events: [], source: null };
  const events = s.games.filter((g) => G.toMs(g.start_utc) != null).map((g) => ev({
    id: 'nhl:nhl:' + g.game_id, sport: 'nhl', league: 'NHL', provider: 'nhl', provider_id: String(g.game_id),
    start_utc: new Date(G.toMs(g.start_utc)).toISOString(),
    home: side((t[g.home] && t[g.home].name) || g.home, g.home), away: side((t[g.away] && t[g.away].name) || g.away, g.away),
    venue: g.venue || null, updated_at: s.generated_at || asOf, source_file: 'hockey/slate.json'
  }));
  return { events, source: { file: 'hockey/slate.json', generated_at: s.generated_at || null, sports: ['nhl'], horizon_hours: s.horizon_hours || null } };
}

function soccer(asOf) {
  const s = readJson('soccer/slate.json');
  if (!s || !s.leagues) return { events: [], source: null };
  const events = [];
  Object.keys(s.leagues).forEach((lk) => {
    const L = s.leagues[lk], zone = LEAGUE_ZONE[lk];
    if (!zone) return;
    (L.games || []).forEach((g) => {
      const start = zonedToUtc(g.date, g.time_local, zone);
      if (!start) return;
      events.push(ev({
        id: 'soccer:openfootball:' + g.match_id, sport: 'soccer', league: L.label || LEAGUE_LABEL[lk], provider: 'openfootball', provider_id: String(g.match_id),
        start_utc: start, start_basis: 'local kick-off ' + g.time_local + ' read in ' + zone,
        home: side(g.home, null), away: side(g.away, null), model_league: lk,
        updated_at: s.generated_at || asOf, source_file: 'soccer/slate.json'
      }));
    });
  });
  return { events, source: { file: 'soccer/slate.json', generated_at: s.generated_at || null, sports: ['soccer'] } };
}

function basketball(asOf) {
  const s = readJson('basketball/slate.json');
  if (!s || !s.leagues) return { events: [], source: null };
  const map = { nba: 'nba', ncaam: 'ncaam' };
  const events = [];
  Object.keys(map).forEach((lk) => {
    const L = s.leagues[lk];
    if (!L) return;
    const names = readJson('basketball/data/' + lk + '/teams.json') || {};
    (L.games || []).forEach((g) => {
      if (G.toMs(g.start_utc) == null || g.game_id == null) return;
      events.push(ev({
        id: map[lk] + ':espn:' + g.game_id, sport: map[lk], league: L.label || lk.toUpperCase(), provider: 'espn', provider_id: String(g.game_id),
        start_utc: new Date(G.toMs(g.start_utc)).toISOString(), neutral: g.neutral === true ? true : (g.neutral === false ? false : null),
        home: side(names[g.home_id] || g.home, null, g.home_id), away: side(names[g.away_id] || g.away, null, g.away_id),
        updated_at: s.generated_at || asOf, source_file: 'basketball/slate.json'
      }));
    });
  });
  return { events, source: { file: 'basketball/slate.json', generated_at: s.generated_at || null, sports: ['nba', 'ncaam'] } };
}

/* every artifact's events, keyed by sport */
function load(asOf) {
  const parts = [football(asOf), hockey(asOf), soccer(asOf), basketball(asOf)];
  const bySport = {}, sources = [];
  parts.forEach((p) => {
    if (p.source) sources.push(p.source);
    p.events.forEach((e) => { (bySport[e.sport] = bySport[e.sport] || []).push(e); });
  });
  return { bySport, sources };
}

module.exports = { load, football, hockey, soccer, basketball, zonedToUtc, LEAGUE_ZONE };
