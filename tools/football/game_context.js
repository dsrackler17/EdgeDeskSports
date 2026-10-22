/* ===========================================================================
   GAME CONTEXT — reads the committed officiating and venue files and hands
   each NFL and FBS game its referee block and its travel legs
   (lib/edgedesk_game_context.js does the arithmetic). Used by
   tools/football/build_game_research.js; no network.

   Reads
     data/refs/ref_assignments.csv           NFL game_id -> referee (+ source)
     data/refs/manual_assignments.json       announced crews nflverse has not filled
     data/refs/ref_game_penalties.csv        NFL flags per game, 2024 on
     data/refs/cfb/cfb_conference_baselines.csv   FBS crews by home conference
     football/venues/nfl_stadiums.json       each club's home stadium (lat, lon, tz)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const GC = require(path.join(ROOT, 'lib', 'edgedesk_game_context.js'));

/* NFL games played abroad or at a neutral stadium the clubs table does not hold */
const INTERNATIONAL = {
  'stade de france': { city: 'Paris', name: 'Stade de France', lat: 48.9245, lon: 2.3602, tz_name: 'Europe/Paris', roof: 'outdoors' },
  'tottenham hotspur stadium': { city: 'London', name: 'Tottenham Hotspur Stadium', lat: 51.6043, lon: -0.0664, tz_name: 'Europe/London', roof: 'outdoors' },
  'wembley stadium': { city: 'London', name: 'Wembley Stadium', lat: 51.556, lon: -0.2796, tz_name: 'Europe/London', roof: 'outdoors' },
  'allianz arena': { city: 'Munich', name: 'Allianz Arena', lat: 48.2188, lon: 11.6247, tz_name: 'Europe/Berlin', roof: 'outdoors' },
  'olympiastadion': { city: 'Berlin', name: 'Olympiastadion', lat: 52.5147, lon: 13.2395, tz_name: 'Europe/Berlin', roof: 'outdoors' },
  'deutsche bank park': { city: 'Frankfurt', name: 'Deutsche Bank Park', lat: 50.0686, lon: 8.6455, tz_name: 'Europe/Berlin', roof: 'outdoors' },
  'santiago bernabeu': { city: 'Madrid', name: 'Santiago Bernabéu', lat: 40.4531, lon: -3.6883, tz_name: 'Europe/Madrid', roof: 'retractable' },
  'croke park': { city: 'Dublin', name: 'Croke Park', lat: 53.3607, lon: -6.2512, tz_name: 'Europe/Dublin', roof: 'outdoors' },
  'estadio azteca': { city: 'Mexico City', name: 'Estadio Azteca', lat: 19.3029, lon: -99.1505, tz_name: 'America/Mexico_City', roof: 'outdoors' },
  'arena corinthians': { city: 'São Paulo', name: 'Arena Corinthians', lat: -23.5453, lon: -46.4742, tz_name: 'America/Sao_Paulo', roof: 'outdoors' },
  'maracana': { city: 'Rio de Janeiro', name: 'Maracanã', lat: -22.9121, lon: -43.2302, tz_name: 'America/Sao_Paulo', roof: 'outdoors' },
  'melbourne cricket ground': { city: 'Melbourne', name: 'Melbourne Cricket Ground', lat: -37.82, lon: 144.9834, tz_name: 'Australia/Melbourne', roof: 'outdoors' }
};
function key(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim(); }

function readCsv(rel) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return []; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(',');
  return lines.map((l) => {
    const cells = l.split(','), o = {};
    head.forEach((h, i) => { o[h] = cells[i] === undefined ? '' : cells[i]; });
    return o;
  });
}
function readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch (_) { return null; } }

function load(opts) {
  opts = opts || {};
  const season = Number(opts.season) || new Date().getUTCFullYear();
  const assign = {};
  readCsv('data/refs/ref_assignments.csv').forEach((r) => { if (r.game_id && r.referee) assign[r.game_id] = { referee: r.referee, source: r.source || null }; });
  /* announced crews kept by hand win only where nflverse has none */
  const manual = readJson('data/refs/manual_assignments.json');
  ((manual && (manual.blocks || manual.weeks || (Array.isArray(manual) ? manual : []))) || []).forEach((b) => {
    Object.keys((b && b.games) || {}).forEach((gid) => { if (!assign[gid]) assign[gid] = { referee: b.games[gid], source: b.source || 'manual' }; });
  });
  const penalties = readCsv('data/refs/ref_game_penalties.csv');
  const table = GC.refTable(penalties, { season, window: penalties.length ? penalties[0].season + '–' + season : null });
  const stadiums = {};
  (((readJson('football/venues/nfl_stadiums.json') || {}).stadiums) || []).forEach((s) => { if (s.club) stadiums[s.club] = s; });
  const cfbBaselines = readCsv('data/refs/cfb/cfb_conference_baselines.csv');
  return { season, assign, table, stadiums, cfbBaselines };
}

/* where an NFL game is really played: the slate's venue name first (a
   neutral or international site), then the venue the slate geocoded */
function nflVenue(g, L) {
  const intl = INTERNATIONAL[Object.keys(INTERNATIONAL).find((k) => key(g.venue).indexOf(k) >= 0) || ''];
  if (intl) return Object.assign({ international: true }, intl);
  const vg = g.venue_geography;
  if (vg && num(vg.lat) != null && (!g.venue || key(vg.name) === key(g.venue) || key(g.venue).indexOf(key(vg.name).split(' ').pop()) >= 0)) return vg;
  const home = L.stadiums[g.home_code];
  if (home && key(home.name) === key(g.venue)) return home;
  return null;
}
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function nflContext(g, L) {
  const out = {};
  const a = L.assign[g.game_id];
  if (a) out.officials = GC.officials(a.referee, L.table, { source: a.source });
  const venue = nflVenue(g, L);
  const base = (code) => { const s = L.stadiums[code]; return s ? { lat: s.lat, lon: s.lon, tz_name: s.tz_name, name: s.name } : null; };
  if (venue) {
    out.travel = GC.travel({ kickoff: g.kickoff, neutral_site: !!venue.international, international: venue.international ? (venue.city ? venue.city + ' (' + venue.name + ')' : venue.name) : null, venue,
      home: { abbr: g.home_code, name: g.home_team, base: base(g.home_code), rest: g.home_rest },
      away: { abbr: g.away_code, name: g.away_team, base: base(g.away_code), rest: g.away_rest } });
  }
  return out;
}

/* college: the legs football/altitude already measured, and the home conference's crews */
function cfbContext(g, L, abbr) {
  const out = {}, at = g.altitude_travel;
  if (at && at.schema === 'edgedesk_cfb_altitude_section_v1') {
    const leg = (s, t, name) => t ? { abbr: abbr && abbr[s] || null, name, miles: num(t.distance_mi), tz_change_h: num(t.tz_change_h),
      direction: !num(t.tz_change_h) ? 'none' : (num(t.tz_change_h) > 0 ? 'east' : 'west'), body_clock: null, body_hour: null, rest_days: num(t.rest_days) } : null;
    out.travel = GC.travelSummary({ venue: at.venue && at.venue.name || g.venue || null, neutral_site: !!g.neutral_site,
      home: leg('home', at.home, g.home_team), away: leg('away', at.away, g.away_team) });
  }
  const conf = g.is_conference_game ? g.home_conference : (g.home_conference || null);
  out.officials = GC.cfbCrew({ conference: conf, baselines: L.cfbBaselines, season: g.season });
  return out;
}

module.exports = { load, nflContext, cfbContext, nflVenue, INTERNATIONAL };
