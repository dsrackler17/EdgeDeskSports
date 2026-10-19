/* ============================================================================
   WHERE A GAME IS PLAYED, AS AN ADDRESS — for the SportsEvent structured data.

   WHY IT EXISTS. An article record carries the stadium's NAME and nothing
   else, and Google's Event markup asks for location.address. The town a
   stadium is in is already in the repository: football/venues/resolved.json
   (the college venue register, keyed by team), football/altitude/venues.json
   (every schedule venue, keyed by venue id) and football/venues/
   nfl_stadiums.json (the hand-entered NFL table, read through
   tools/football/nfl_venues.js). This reads those; it never geocodes and
   never takes a town from a team's name.

   WHY A NAME IS NOT ENOUGH. "Memorial Stadium" is Missouri's, Kansas's,
   Clemson's, Indiana's, Nebraska's... A name that resolves to one town is
   used; a name that resolves to several is settled by the home team's own
   stadium, and only when the home team's register entry is the SAME stadium
   (an entry that names a different stadium is stale or mis-keyed, and is not
   trusted). Anything else returns null and the page simply carries no
   address — a missing field, never a wrong one.

   Node only (it reads files). The renderer stays a pure function of the
   record: tools/articles/build_articles.js attaches the result as
   rec.venue_address before rendering.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const NFL = require('../football/nfl_venues.js');

const ROOT = path.join(__dirname, '..', '..');
const REGISTER = path.join(ROOT, 'football', 'venues', 'resolved.json');
const SCHEDULE_VENUES = path.join(ROOT, 'football', 'altitude', 'venues.json');

/* Stadiums the schedule feed names that no register above carries under that
   name (a new building, a rename, a one-off neutral site). Hand-entered from
   public stadium records; a name here takes part in the same uniqueness test
   as every other row, so it can never override a register. */
const KNOWN = {
  'Arizona Stadium': 'Tucson, AZ',
  'Bobcat Stadium (TX)': 'San Marcos, TX',
  'Cajun Field': 'Lafayette, LA',
  'Cotton Bowl': 'Dallas, TX',
  'FAU Stadium': 'Boca Raton, FL',
  'FBC Mortgage Stadium': 'Orlando, FL',
  'Gesa Field': 'Pullman, WA',
  'Gies Memorial Stadium': 'Champaign, IL',
  'Jones AT&T Stadium': 'Lubbock, TX',
  'Plaster Sports Complex': 'Springfield, MO',
  'SHI Stadium': 'Piscataway, NJ',
  'Stade de France': 'Saint-Denis, France',
  'TQL Stadium': 'Cincinnati, OH',
  'UB Stadium': 'Amherst, NY'
};
/* The NFL table writes an international city as "City, Country". */
const COUNTRY = {
  England: 'GB', Scotland: 'GB', Wales: 'GB', Ireland: 'IE', Germany: 'DE', Spain: 'ES',
  France: 'FR', Italy: 'IT', Mexico: 'MX', Brazil: 'BR', Australia: 'AU', Canada: 'CA'
};

function full(name) { return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9.]+/g, ' ').trim(); }
/* "Memorial Stadium (Clemson, SC)" and "Ryan Field (1926)" without the qualifier */
function qualifier(name) { const m = /\(([^)]*)\)\s*$/.exec(String(name || '')); return m ? m[1] : null; }
function bare(name) { return full(String(name || '').replace(/\s*\([^)]*\)\s*$/, '')); }
function teamKey(name) { return String(name || '').toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, ''); }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

let cache = null;
function load(opts) {
  if (cache && !(opts && opts.reload)) return cache;
  opts = opts || {};
  const reg = readJson(opts.register || REGISTER);
  const sched = readJson(opts.schedule_venues || SCHEDULE_VENUES);
  const rows = [];
  const byTeam = Object.create(null);
  const add = (name, city, key) => {
    if (!name || !city) return;
    const row = { name: name, city: city };
    rows.push(row);
    if (key) (byTeam[key] = byTeam[key] || []).push(row);
  };
  ['describe', 'venues'].forEach((part) => {
    Object.entries((reg && reg[part]) || {}).forEach(([key, v]) => { if (v) add(v.name, v.city, key); });
  });
  Object.values((sched && sched.venues) || {}).forEach((v) => { if (v) add(v.name, v.city, null); });
  Object.entries(KNOWN).forEach(([name, city]) => add(name, city, null));
  cache = { rows, byTeam };
  return cache;
}

function citiesOf(rows) {
  return Array.from(new Set(rows.map(r => r.city)));
}

/* "Salt Lake City, UT" -> { locality, region, country }. A city that is not
   "Town, ST" or "Town, Country" is not an address this can vouch for. */
function parseCity(city) {
  const m = /^\s*(.+?),\s*([^,]+?)\s*$/.exec(String(city || ''));
  if (!m) return null;
  if (/^[A-Z]{2}$/.test(m[2])) return { locality: m[1], region: m[2], country: 'US' };
  if (COUNTRY[m[2]]) return { locality: m[1], region: null, country: COUNTRY[m[2]] };
  return null;
}

/* rec: { venue, home_team, neutral_site, sport } -> { locality, region, country } | null */
function addressFor(rec, opts) {
  if (!rec || !rec.venue) return null;
  const venue = String(rec.venue);
  const nflRow = () => { const v = NFL.venueFor({ stadium: venue }); return v && v.city ? parseCity(v.city) : null; };
  if (String(rec.sport || '').toUpperCase() === 'NFL') {
    const a = nflRow();
    if (a) return a;
  }
  const L = load(opts);
  const want = full(venue);
  const b = bare(venue);
  /* 1. the home team's own stadium, when it is this stadium. First, because
     a bare "Memorial Stadium" is Kansas's when Kansas is at home, however
     the register happens to spell Missouri's. */
  if (!rec.neutral_site) {
    const own = citiesOf((L.byTeam[teamKey(rec.home_team)] || []).filter((r) => {
      const n = bare(r.name);
      return n === b || (b.length >= 8 && (n.endsWith(' ' + b) || b.endsWith(' ' + n)));
    }));
    if (own.length === 1) return parseCity(own[0]);
  }
  /* 2. a qualified name — "Memorial Stadium (Clemson, SC)" — names its town */
  if (want !== b) {
    const exact = citiesOf(L.rows.filter(r => full(r.name) === want));
    if (exact.length === 1) return parseCity(exact[0]);
    const q = parseCity(qualifier(venue));
    if (q && q.region) return q;
  }
  /* 3. the name, every spelling of it, names one town */
  const any = citiesOf(L.rows.filter(r => bare(r.name) === b));
  if (any.length === 1) return parseCity(any[0]);
  /* 4. a college game in an NFL stadium (a neutral site, a shared home) */
  return nflRow();
}

module.exports = { addressFor, parseCity, load, KNOWN };
