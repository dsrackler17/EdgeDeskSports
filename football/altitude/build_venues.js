#!/usr/bin/env node
/* ============================================================================
   THE VENUE ELEVATION REGISTRY — every stadium a college game is played in,
   keyed by its stable venue id, with where each elevation came from and how
   far to trust it.

   WHY A REGISTRY AND NOT ANOTHER COLUMN ON THE TEAM TABLE. Every elevation
   this repository held before this file was attached to a TEAM: the trained
   parameter table (params.universe.venues) and football/venues/resolved.json
   both answer "where does this team play", from a provider table that is a
   CURRENT SNAPSHOT for every season. cfbfastR's 2001 team_info lists Colorado
   State at Canvas Stadium, which opened in 2017. A team-keyed elevation is
   therefore wrong for every game played before a stadium move, and it says
   nothing at all about a neutral site. Altitude is a property of the place the
   game is played, so this file keys elevation by the schedule's own venue_id
   and lets the schedule say which venue a game was in.

   SOURCES, IN ORDER OF AUTHORITY.
     1. cfbfastR team tables (cfbfastR-cfb-data cfb_teams_<season>, and
        cfbfastR-data team_info), which republish the CollegeFootballData venue
        table: elevation in METRES, coordinates, IANA zone, roof. The same
        mirror every other football build here reads.
     2. The trained parameter table (football/cfb_p4/params.js), read only as a
        cross-check: it was built from source 1 and must agree with it.
     3. football/altitude/sources/research_package_venues.csv: the venue rows
        of the altitude research package (altitude_analysis.zip). Two kinds:
        `cfbd_capture`, the CollegeFootballData value that package captured for
        a historic stadium today's snapshot no longer lists (Hughes Stadium,
        Sam Boyd, Aloha …), and `override_cited`, a value the package's author
        took from a USGS point query and cited. Neither was re-verified by
        this build (the USGS service is not reachable from it), and the
        confidence below says so.

   CONFIDENCE, AND WHAT IT GATES.
     HIGH    a public provider value, and every other source within 100 ft
     MEDIUM  only the research package carries it (one secondary capture, not
             re-verified here), or the sources disagree by 100–300 ft
     LOW     the sources disagree by more than 300 ft. Published, never used
             for an adjustment
   A venue with no sourced elevation is NOT in `venues`. Every consumer
   reports its elevation as unavailable. No elevation is ever interpolated
   from a city, a neighbour or a team.

   THE TRAP THIS FILE EXISTS TO CATCH: INHERITED GEOGRAPHY. The provider's
   coordinates and elevation belong to the TEAM's current location, while the
   venue_id on the same row can be a stadium the team left years ago. The 2026
   table lists Colorado State at venue 3761 (Hughes Stadium, closed 2016) with
   Canvas Stadium's coordinates and elevation; UNLV at 3914 (Sam Boyd) with
   Allegiant's. Read naively, a 2012 game at Hughes would be placed at Canvas
   and a 2015 game at Sam Boyd would inherit Allegiant's 2,185 ft. So when two
   venue ids share one provider coordinate pair, the schedule decides which is
   current (the id that hosted the most recent home game); the others are
   LEGACY ids whose provider geography is inherited, not measured. A legacy id
   keeps an elevation only from an independent capture (the research package),
   at MEDIUM, and otherwise is published at LOW and never adjusts anything.

     node football/altitude/build_venues.js [--data DIR] [--offline] [--check]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'venues.json');
const PKG = path.join(__dirname, 'sources', 'research_package_venues.csv');
const PY_HELPER = path.join(ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
const SCHEMA = 'edgedesk_cfb_venue_elevation_v1';
const M_TO_FT = 3.28084;
const AGREE_FT = 100;
const DISPUTE_FT = 300;

const SOURCES = [
  { id: 'cfbfastr_cfb_teams_2026', url: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data/main/cfb/cfb_teams/parquet/cfb_teams_2026.parquet',
    file: 'cfb_teams_2026.parquet', label: 'cfbfastR-cfb-data cfb_teams 2026 (CollegeFootballData venue table, metres)' },
  { id: 'cfbfastr_team_info_2025', url: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/team_info/parquet/cfb_team_info_2025.parquet',
    file: 'cfb_team_info_2025.parquet', label: 'cfbfastR-data team_info 2025 (CollegeFootballData venue table, metres)' }
];

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function num(v) { if (v == null || v === '' || v === 'NA' || v === 'nan') return null; const x = +v; return isFinite(x) ? x : null; }
function bool(v) {
  if (v == null || v === '' || v === 'NA') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);

/* the repo's quoted-field CSV reader (venue names carry commas) */
function parseCsv(text) {
  const out = [];
  const lines = String(text).split('\n');
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
  const head = cells((lines[0] || '').replace(/\r$/, ''));
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
  if (!r.ok) return { ok: false, why: 'HTTP ' + r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { ok: true, bytes: buf.length };
}

function providerRows(file) {
  const csv = execFileSync('python3', [PY_HELPER, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parseCsv(csv);
}

/* one observation per (venue, source). A row without a venue id or without an
   elevation contributes nothing — it is not evidence of anything. */
function observe(rows, src) {
  const obs = {};
  rows.forEach(r => {
    const id = num(r.venue_id), elev = num(r.elevation);
    if (id == null || elev == null) return;
    const k = String(Math.round(id));
    if (obs[k]) return;
    obs[k] = {
      source: src.id, label: src.label, elev_m: r1(elev), elev_ft: r1(elev * M_TO_FT),
      name: r.venue_name || null,
      city: [r.venue_city || r.city, r.venue_state || r.state].filter(Boolean).join(', ') || null,
      lat: num(r.latitude), lon: num(r.longitude), tz_name: r.timezone || null,
      dome: bool(r.venue_indoor) != null ? bool(r.venue_indoor) : bool(r.dome),
      capacity: num(r.capacity)
    };
  });
  return obs;
}

function trainedObservations() {
  global.window = global.window || global;
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const P = global.EDCfbP4Params;
  const v = (P && P.universe && P.universe.venues) || {};
  const obs = {};
  Object.keys(v).forEach(team => {
    const x = v[team];
    if (!x || x.venue_id == null || x.elev == null) return;
    const k = String(x.venue_id);
    if (obs[k]) return;
    obs[k] = { source: 'cfb_p4_trained_table', label: 'football/cfb_p4/params.js universe.venues (built from cfbfastR team_info, metres)',
      elev_m: r1(x.elev), elev_ft: r1(x.elev * M_TO_FT), name: x.name || null, lat: x.lat, lon: x.lon,
      tz_name: null, dome: x.dome == null ? null : !!x.dome, capacity: x.capacity || null, team: team };
  });
  return obs;
}

function packageObservations() {
  const obs = {};
  parseCsv(fs.readFileSync(PKG, 'utf8')).forEach(r => {
    const id = num(r.venue_id), ft = num(r.elev_ft);
    if (id == null || ft == null) return;
    const same = /CFBD venue (\d+) \(same stadium renamed\)/.exec(r.source || '');
    obs[String(Math.round(id))] = {
      source: 'research_package_' + r.kind, label: 'altitude research package — ' + (r.source || 'uncited'),
      cite: r.source || null, captured_from: r.captured_from || null,
      elev_m: r1(ft / M_TO_FT), elev_ft: r1(ft), name: r.name || null, lat: num(r.lat), lon: num(r.lon),
      tz_name: r.tz_name || null, dome: bool(r.dome), capacity: num(r.capacity),
      same_site_as: same ? +same[1] : null
    };
  });
  return obs;
}

/* WHICH VENUE IDS SHARE ONE PROVIDER COORDINATE PAIR, and which of each group
   the schedule says is current. `lastHome` maps venue_id -> the latest kickoff
   (ms) of a non-neutral game played there. Returns { venue_id: {legacy,
   successor} } for every id in a shared group. */
function geographyCollisions(providerObs, lastHome) {
  const byLL = {};
  providerObs.forEach(obs => Object.keys(obs).forEach(k => {
    const o = obs[k];
    if (o.lat == null || o.lon == null) return;
    const ll = o.lat.toFixed(5) + ',' + o.lon.toFixed(5);
    (byLL[ll] = byLL[ll] || new Set()).add(k);
  }));
  const out = {};
  Object.keys(byLL).forEach(ll => {
    const ids = Array.from(byLL[ll]);
    if (ids.length < 2) return;
    const seen = ids.filter(k => lastHome[k] != null).sort((a, b) => lastHome[b] - lastHome[a]);
    const current = seen.length ? seen[0] : null;
    ids.forEach(k => {
      out[k] = current == null
        ? { legacy: null, successor: null, group: ids.map(Number) }
        : { legacy: k !== current, successor: k !== current ? +current : null, group: ids.map(Number) };
    });
  });
  return out;
}

/* THE DECISION, PER VENUE. The primary value is a public provider's; the
   research package fills only what no provider carries. Every observation is
   kept, so a disagreement is visible rather than averaged away. */
function resolve(id, list, collision) {
  const inherited = !!(collision && collision.legacy === true);
  const ambiguous = !!(collision && collision.legacy == null);
  const primary = inherited ? [] : list.filter(o => /^cfbfastr_/.test(o.source));
  const pkg = list.filter(o => /^research_package_/.test(o.source));
  const chosen = primary[0] || pkg[0] || (inherited ? list.filter(o => /^cfbfastr_/.test(o.source))[0] : null) || null;
  if (!chosen) return null;
  const fts = list.filter(o => !(inherited && /^cfbfastr_|^cfb_p4_/.test(o.source)))
    .map(o => o.elev_ft).filter(x => x != null);
  const spread = fts.length ? Math.max.apply(null, fts) - Math.min.apply(null, fts) : 0;
  let confidence, basis;
  if (inherited && !pkg.length) {
    confidence = 'LOW';
    basis = 'legacy venue id: the provider row carries the geography of its successor (venue '
      + collision.successor + '), not of this stadium, and no independent capture exists';
  } else if (inherited) {
    confidence = 'MEDIUM';
    basis = 'legacy venue id: the provider row carries its successor’s geography (venue ' + collision.successor
      + '), so the research package capture (' + (pkg[0].cite || 'uncited') + ') is used; not re-verified by this build';
  } else if (spread > DISPUTE_FT) {
    confidence = 'LOW';
    basis = 'sources disagree by ' + Math.round(spread) + ' ft: published for reference, never used for an adjustment';
  } else if (!primary.length) {
    confidence = 'MEDIUM';
    basis = 'only the research package carries this venue (' + (chosen.cite || 'no citation') + '); not re-verified by this build';
  } else if (spread > AGREE_FT) {
    confidence = 'MEDIUM';
    basis = 'public provider value; another source differs by ' + Math.round(spread) + ' ft';
  } else if (ambiguous) {
    confidence = 'MEDIUM';
    basis = 'public provider value, but venues ' + collision.group.join(', ')
      + ' share one provider coordinate pair and no schedule establishes which is current';
  } else {
    confidence = 'HIGH';
    basis = list.length > 1
      ? 'public provider value, ' + list.length + ' sources within ' + Math.max(1, Math.round(spread)) + ' ft'
      : 'public provider value (single source)';
  }
  /* a legacy id takes its geography from the independent capture, never from
     the provider row that describes its successor */
  const order = inherited ? pkg.concat(list.filter(o => !/^cfbfastr_|^cfb_p4_/.test(o.source))) : [chosen].concat(primary, pkg, list);
  const pick = (k) => { for (const o of order) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const nameFrom = (k) => { for (const o of [chosen].concat(primary, pkg, list)) if (o && o[k]) return o[k]; return null; };
  return {
    venue_id: +id, name: nameFrom('name'), city: nameFrom('city'),
    lat: pick('lat'), lon: pick('lon'), tz_name: pick('tz_name') || nameFrom('tz_name'), dome: pick('dome'), capacity: pick('capacity'),
    elev_m: chosen.elev_m, elev_ft: chosen.elev_ft, elev_source: chosen.source,
    confidence, basis, spread_ft: Math.round(spread),
    same_site_as: pick('same_site_as'),
    legacy_of: inherited ? collision.successor : null,
    sources: list.map(o => ({ source: o.source, elev_ft: o.elev_ft, cite: o.cite || null,
      inherited: inherited && /^cfbfastr_|^cfb_p4_/.test(o.source) ? true : undefined }))
  };
}

/* the latest non-neutral kickoff at each venue id, from the schedule feed */
function lastHomeFromSchedules(dir) {
  const last = {};
  if (!dir || !fs.existsSync(dir)) return last;
  fs.readdirSync(dir).filter(f => /^(cfb_schedules_|sched_)\d{4}\.csv$/.test(f)).forEach(f => {
    parseCsv(fs.readFileSync(path.join(dir, f), 'utf8')).forEach(r => {
      const id = num(r.venue_id), t = Date.parse(r.start_date);
      if (id == null || !isFinite(t) || String(r.neutral_site).toLowerCase() === 'true') return;
      const k = String(Math.round(id));
      if (last[k] == null || t > last[k]) last[k] = t;
    });
  });
  return last;
}

async function main() {
  const check = !!arg('check', false), offline = !!arg('offline', false);
  const dataDir = path.resolve(String(arg('data', path.join(__dirname, '.cache'))));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (check) {
    if (!prev || prev.schema !== SCHEMA) { console.error('[altitude-venues] venues.json missing or wrong schema'); return 2; }
    const bad = Object.keys(prev.venues).filter(k => {
      const v = prev.venues[k];
      return !(v.elev_ft != null && isFinite(v.elev_ft)) || ['HIGH', 'MEDIUM', 'LOW'].indexOf(v.confidence) < 0
        || !v.sources || !v.sources.length || String(v.venue_id) !== k;
    });
    if (bad.length) { console.error('[altitude-venues] malformed entries: ' + bad.join(', ')); return 2; }
    console.error('[altitude-venues] ' + Object.keys(prev.venues).length + ' venues OK');
    return 0;
  }

  const byVenue = {};
  const add = (obs) => Object.keys(obs).forEach(k => { (byVenue[k] = byVenue[k] || []).push(obs[k]); });
  const read = [], provider = [];
  for (const s of SOURCES) {
    const dest = path.join(dataDir, s.file);
    if (!offline && !fs.existsSync(dest)) {
      const got = await grab(s.url, dest);
      if (!got.ok) { console.error('[altitude-venues] ' + s.url + ' — ' + got.why); continue; }
    }
    if (!fs.existsSync(dest)) { console.error('[altitude-venues] ' + s.id + ' not available offline'); continue; }
    let rows;
    try { rows = providerRows(dest); } catch (e) { console.error('[altitude-venues] ' + s.id + ' unreadable: ' + e.message); continue; }
    const obs = observe(rows, s);
    provider.push(obs); add(obs);
    read.push({ id: s.id, url: s.url, label: s.label, rows: rows.length });
  }
  if (!read.length) {
    console.error('[altitude-venues] no provider table could be read; the committed registry is left untouched');
    return 2;
  }
  add(trainedObservations());
  add(packageObservations());

  /* the schedules that decide which id of a shared coordinate pair is current */
  const schedDir = path.resolve(String(arg('sched', dataDir)));
  const thisYear = new Date().getUTCFullYear();
  if (!offline) {
    for (const y of [thisYear - 1, thisYear]) {
      const dest = path.join(schedDir, 'cfb_schedules_' + y + '.csv');
      if (fs.existsSync(dest)) continue;
      const got = await grab('https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + y + '.csv', dest);
      if (!got.ok) console.error('[altitude-venues] schedule ' + y + ' — ' + got.why);
    }
  }
  const lastHome = lastHomeFromSchedules(schedDir);
  const collisions = geographyCollisions(provider, lastHome);

  const venues = {}, counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  Object.keys(byVenue).sort((a, b) => +a - +b).forEach(k => {
    const v = resolve(k, byVenue[k], collisions[k] || null);
    if (!v) return;
    venues[k] = v; counts[v.confidence]++;
  });
  const doc = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    units: { elev_ft: 'feet above sea level', elev_m: 'metres above sea level (provider unit)', lat: 'degrees', lon: 'degrees' },
    sources_read: read.concat([
      { id: 'cfb_p4_trained_table', label: 'football/cfb_p4/params.js universe.venues — cross-check only' },
      { id: 'research_package', label: 'football/altitude/sources/research_package_venues.csv — the altitude research package venue rows, with their own citations' }]),
    policy: {
      key: 'the schedule feed venue_id: a game is located by the venue it was played in, never by the home team',
      precedence: 'public provider value first; the research package fills only what no provider carries',
      confidence: { HIGH: 'public provider value, all sources within ' + AGREE_FT + ' ft',
        MEDIUM: 'research-package value only (not re-verified here), or sources ' + AGREE_FT + '-' + DISPUTE_FT + ' ft apart',
        LOW: 'sources more than ' + DISPUTE_FT + ' ft apart — never used for an adjustment' },
      missing: 'a venue without a sourced elevation is absent from `venues`; consumers report it as unavailable and never impute one',
      inherited_geography: 'venue ids sharing one provider coordinate pair are resolved by the schedule: the id with the latest home game is current, the others are legacy ids whose provider elevation describes their successor and is never used as theirs'
    },
    schedules_read: Object.keys(lastHome).length + ' venue ids with a dated non-neutral game in ' + path.relative(ROOT, schedDir),
    counts: { venues: Object.keys(venues).length, by_confidence: counts },
    venues
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.error('[altitude-venues] wrote ' + doc.counts.venues + ' venues ' + JSON.stringify(counts) + ' -> ' + path.relative(ROOT, OUT));
  return 0;
}

if (require.main === module) main().then(c => process.exit(c || 0), e => { console.error(e); process.exit(1); });
module.exports = { resolve, geographyCollisions, SCHEMA, AGREE_FT, DISPUTE_FT };
