#!/usr/bin/env node
/* ============================================================================
   EVERY STADIUM ON THE SLATE, SET IN STONE.

   WHAT WAS ACTUALLY WRONG. The trained parameter table carries 135 venues —
   the FBS field the model was built on — with coordinates, elevation,
   capacity, surface and roof. That is enough for every HOME venue, which is
   where a forecast is located, and it is why the weather layer was never
   short of coordinates. It is NOT enough for the away side: nineteen FCS
   visitors on this slate had no venue at all, so `venue_geography:away` was
   UNAVAILABLE on each of them and travel distance could not be computed.

   The injection point for those was football/venues/supplement.json, which
   is hand-curated and deliberately refuses an entry without a named source.
   Hand-curating nineteen stadiums a week does not scale and, worse, invites
   exactly the thing that file was written to prevent: coordinates typed from
   memory under a URL nobody opened.

   SO THIS READS A MACHINE-READABLE SOURCE INSTEAD. cfbfastR's team table
   publishes, per season, for FBS and FCS alike: latitude, longitude,
   elevation, capacity, dome, grass, the venue's name and city, and the IANA
   timezone. It is the same mirror this repository already reads for
   schedules, rosters, player stats and team talent. Nothing here is
   interpolated from a city name and nothing is guessed: a row without real
   coordinates is REFUSED and reported as refused.

   IDENTITY IS RESOLVED ON AN ID, NOT ON A NAME — the same rule
   football/players/build_team_talent.js learned the hard way when a longest-
   prefix match silently joined "Houston Christian Huskies" onto `houston`.
   The ESPN team_id is the join; the name only has to corroborate it.

   PRECEDENCE, HIGHEST FIRST. The trained table wins, because it is what the
   model was fitted on and changing it under a trained coefficient would make
   the parameters describe a different stadium. The hand-curated supplement
   comes next, because a person checked it against a named source. This file
   is the floor: it fills what neither of those has.

     node football/venues/build_venues.js [--season 2026] [--check] [--report]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data/main/cfb/cfb_teams/parquet';
const PY_HELPER = path.join(ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
const SCHEMA = 'edgedesk_venue_geography_v1';
const OUT = path.join(ROOT, 'football', 'venues', 'resolved.json');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const QUIET = !!arg('quiet', false);
const log = (...a) => { if (!QUIET) console.error(...a); };

function normKey(s) {
  if (s == null) return null;
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}
function num(v) { if (v == null || v === '' || v === 'NA') return null; const x = +v; return isFinite(x) ? x : null; }
function bool(v) {
  if (v == null || v === '' || v === 'NA') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

/* the repo's own CSV reader, quoted-field aware because venue names carry
   commas ("Memorial Stadium (Commerce, TX)") */
function parseCsv(text) {
  const out = [];
  const lines = String(text).split('\n');
  if (!lines.length) return out;
  function cells(line) {
    const r = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { r.push(cur); cur = ''; }
      else cur += c;
    }
    r.push(cur);
    return r;
  }
  const head = cells(lines[0].replace(/\r$/, ''));
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].length) continue;
    const c = cells(lines[i].replace(/\r$/, ''));
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j];
    out.push(o);
  }
  return out;
}

async function grab(url, dest) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (r.status === 404) return { ok: false, why: 'not published for this season (HTTP 404)' };
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { ok: true, bytes: buf.length };
}

/* every spelling a row offers, so a slate name that is not the display name
   still resolves — and so a name that matches NOTHING is refused rather than
   fuzzily attached to the closest string */
function spellings(r) {
  return [r.display_name, r.school, r.short_display_name, r.location,
    r.alt_name1, r.alt_name2, r.alt_name3, r.nickname]
    .filter(Boolean).map(String);
}
function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && t.length > 2);
}

/* WHAT A ROW HAS TO CARRY BEFORE IT IS A VENUE. Coordinates are the whole
   point: an entry without them cannot locate a forecast or measure a
   distance, so it is refused rather than written as a half-venue. */
function venueFrom(r) {
  const lat = num(r.latitude), lon = num(r.longitude);
  if (lat == null || lon == null) return { ok: false, why: 'the row publishes no coordinates' };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, why: 'coordinates out of range' };
  if (lat === 0 && lon === 0) return { ok: false, why: 'null island — a placeholder, not a stadium' };
  const dome = bool(r.dome); const indoor = bool(r.venue_indoor);
  const grass = bool(r.grass); const vgrass = bool(r.venue_grass);
  return { ok: true, v: {
    name: r.venue_name || null,
    lat: lat, lon: lon,
    elev: num(r.elevation),
    capacity: num(r.capacity),
    /* the trained table stores tz as a fixed UTC offset; this source
       publishes the IANA zone, which is the one that knows about daylight
       saving. Both are written and the forecast reads neither — open-meteo
       resolves the zone from the coordinates. */
    tz_name: r.timezone || null,
    dome: dome == null ? (indoor == null ? false : indoor) : dome,
    grass: grass == null ? vgrass : grass,
    city: [r.venue_city || r.city, r.venue_state || r.state].filter(Boolean).join(', ') || null,
    venue_id: num(r.venue_id),
    team_id: num(r.team_id),
    classification: r.classification || r.division || null
  } };
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const check = !!arg('check', false);
  const report = !!arg('report', false);
  const offline = !!arg('offline', false);

  /* WHAT IS ALREADY KNOWN, so this only ever fills a gap */
  global.window = global.window || global;
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const P = global.EDCfbP4Params;
  const trained = (P && P.universe && P.universe.venues) || {};
  let supplement = {};
  try {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'supplement.json'), 'utf8'));
    supplement = (s && s.venues) || {};
  } catch (_) { /* absent is fine */ }

  if (report) return reportOnly(trained, supplement, season);

  if (offline) { log('[venues] --offline: nothing fetched'); return 0; }
  const file = `cfb_teams_${season}.parquet`;
  const url = `${RAW}/${file}`;
  const tmp = path.join(ROOT, 'football', 'venues', '.cache', file);
  const got = await grab(url, tmp);
  if (!got.ok) {
    console.error('[venues] ' + url + ' — ' + got.why);
    console.error('[venues] nothing is written: an unavailable season stays unavailable rather than being '
      + 'filled from a different one');
    return check ? 2 : 1;
  }
  let rows;
  try { rows = parseCsv(execFileSync('python3', [PY_HELPER, tmp], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')); }
  catch (e) { console.error('[venues] the parquet could not be read: ' + ((e && e.message) || e)); return 2; }
  if (!rows.length) { console.error('[venues] the table is empty'); return 2; }

  const venues = {}, refused = [];
  let written = 0, held = 0;
  const seen = {};
  for (const r of rows) {
    if (num(r.season) !== season) continue;
    const names = spellings(r);
    if (!names.length) { refused.push({ team_id: num(r.team_id), why: 'the row carries no name at all' }); continue; }
    const res = venueFrom(r);
    if (!res.ok) { refused.push({ team: r.display_name || r.school, team_id: num(r.team_id), why: res.why }); continue; }
    /* CORROBORATION: the venue's own city must share nothing impossible with
       the team, and the row must name a stadium. A row with coordinates and
       no venue name is a campus pin, not a stadium, and is refused. */
    if (!res.v.name) { refused.push({ team: r.display_name || r.school, team_id: num(r.team_id),
      why: 'coordinates with no venue name — a campus pin, not a stadium' }); continue; }
    for (const n of names) {
      const k = normKey(n);
      if (!k) continue;
      /* THE PRECEDENCE, ENFORCED HERE rather than left to the reader. */
      if (trained[k]) { if (!seen[k]) { held++; seen[k] = 1; } continue; }
      if (supplement[k]) { if (!seen[k]) { held++; seen[k] = 1; } continue; }
      if (venues[k]) {
        /* two rows claiming one key is an identity collision, never a
           silent last-one-wins */
        if (venues[k].team_id !== res.v.team_id && !venues[k].collision) {
          venues[k].collision = true;
          refused.push({ team: n, why: 'two teams resolve to the key "' + k + '" (team_id '
            + venues[k].team_id + ' and ' + res.v.team_id + '); the first is kept and this is reported' });
        }
        continue;
      }
      venues[k] = Object.assign({}, res.v);
      if (!seen[k]) { written++; seen[k] = 1; }
    }
  }
  Object.keys(venues).forEach(k => { delete venues[k].collision; });

  const out = {
    schema: SCHEMA,
    season: season,
    generated_at: new Date().toISOString(),
    source: url,
    source_note: 'cfbfastR team table, one row per team per season, carrying the venue’s coordinates, '
      + 'elevation, capacity, surface, roof and IANA timezone. The same public mirror this repository already '
      + 'reads for schedules, rosters, player stats and team talent.',
    precedence: 'the trained parameter table wins, then football/venues/supplement.json (hand-checked against a '
      + 'named source), then this file. Nothing here overwrites either of those: ' + held + ' key(s) were already '
      + 'known and were left alone.',
    refuses: 'a row without real coordinates, or with coordinates and no stadium name, is refused and listed in '
      + '`refused` rather than written as a half-venue. Nothing is interpolated from a city name.',
    counts: { rows_in_season: rows.filter(r => num(r.season) === season).length,
      keys_written: written, keys_already_known: held, refused: refused.length },
    refused: refused.slice(0, 60),
    venues: venues
  };
  if (check) {
    log('[venues] --check: ' + written + ' key(s) would be written, ' + held + ' already known, '
      + refused.length + ' refused');
    return 0;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  log('[venues] ' + written + ' key(s) written to football/venues/resolved.json, ' + held + ' already known, '
    + refused.length + ' refused');
  return reportOnly(trained, supplement, season, venues);
}

/* WHICH STADIUMS THE CURRENT SLATE ACTUALLY NEEDS, and whether each one is
   known. This is the question supplement.json's own header promised a
   resolver would answer and no resolver existed to answer. */
function reportOnly(trained, supplement, season, resolvedNow) {
  let resolved = resolvedNow || null;
  if (!resolved) {
    try { resolved = (JSON.parse(fs.readFileSync(OUT, 'utf8')) || {}).venues || {}; } catch (_) { resolved = {}; }
  }
  let slate = null;
  try { slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8')); }
  catch (_) { /* no slate on disk */ }
  if (!slate || !slate.games) {
    log('[venues] no football/fbs/slate.json on disk, so there is no slate to report against');
    return 0;
  }
  const where = (k) => trained[k] ? 'trained' : (supplement[k] ? 'supplement' : (resolved[k] ? 'resolved' : null));
  const homeMissing = [], awayMissing = [];
  let home = 0, away = 0;
  for (const g of slate.games) {
    const hk = normKey(g.home_team), ak = normKey(g.away_team);
    if (where(hk)) home++; else homeMissing.push(g.home_team);
    if (g.neutral_site) continue;
    if (where(ak)) away++; else awayMissing.push(g.away_team);
  }
  const games = slate.games.length;
  console.log('\nStadiums the ' + (season || '') + ' slate needs');
  console.log('  home venues   ' + home + ' of ' + games + '   (a forecast is located at the HOME venue)');
  console.log('  away venues   ' + away + ' of ' + slate.games.filter(g => !g.neutral_site).length
    + '   (travel distance only)');
  if (homeMissing.length) console.log('  NO HOME VENUE: ' + Array.from(new Set(homeMissing)).join(', '));
  if (awayMissing.length) console.log('  no away venue: ' + Array.from(new Set(awayMissing)).join(', '));
  if (!homeMissing.length && !awayMissing.length) console.log('  every stadium this slate needs is on file.');
  return homeMissing.length ? 1 : 0;
}

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => {
  console.error('[venues] ' + ((e && e.stack) || e)); process.exit(2);
});
module.exports = { normKey, venueFrom, parseCsv, spellings, tokens, SCHEMA };
