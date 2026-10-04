#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Football — NFL QB roster snapshot (nflverse, public, keyless).

   WHY THIS FILE EXISTS.

   app.html's QB registry fetched roster_<season>.csv straight from
   github.com/nflverse/nflverse-data/releases/download/... . A browser cannot
   do that. A release download answers with a 302 to
   release-assets.githubusercontent.com and carries NO
   Access-Control-Allow-Origin header on that first hop, so the request is
   refused by CORS before any status is seen: fetch() rejects with a bare
   TypeError, which is why the panel read

       last fetch   Failed to fetch

   while the file itself was perfectly healthy (200, 927 KB). The registry
   fell back to its bundled snapshot and stayed there — "QB rosters on the
   bundled snapshot", floor kept, never refreshing. The app's OTHER feeds
   (games.csv, the cfbfastR schedules) use raw.githubusercontent.com, which
   does send `access-control-allow-origin: *`; the release URLs never could.
   nflverse publishes rosters as release assets only, and the one raw mirror
   (nfldata/data/rosters.csv) stops at 2019 and carries none of the columns
   the registry reads, so there is nothing to point at.

   So the roster is fetched HERE, where there is no CORS, and committed to
   this repository. The app then reads it from its own origin.

   THE OUTPUT IS CSV, NOT JSON, ON PURPOSE. It carries exactly the columns
   fbQbFromRow() reads, in nflverse's own spelling, so the browser keeps its
   existing parser, its ACT/reserve split, its sanity bounds, its
   localStorage cache and its bundled-snapshot floor unchanged. The only
   thing that changes on the client is the URL.

   Honesty rules, same as the rest of this repo:
     * Nothing is inferred. Rows are copied through; no status is guessed.
     * Every QB row for the season is kept, in week order, because the
       client resolves a repeated GSIS id by keeping the LATER row — the
       season file lists a player's latest stint last. Reordering here would
       silently change which team a traded QB belongs to.
     * The run FAILS rather than committing a wrong-shaped dataset. The
       bounds are the client's own fbQbSane(): 40-200 active QBs over at
       least 28 teams. A file that parses to less is a broken feed, not a
       roster, and must never reach the floor.
     * The file is rewritten only when the rows changed, so a scheduled run
       commits nothing on a quiet day.

   Run by .github/workflows/starter-context.yml (full network).
     node football/nfl/build_qb_roster.js [--season 2026] [--out dir]
   Exit 0 = snapshot written or unchanged; exit 1 = fetch or shape failed.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const URL = (s) => `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${s}.csv`;

/* The columns app.html's fbQbFromRow() reads, and nothing else. */
const COLUMNS = ['season', 'team', 'position', 'status', 'full_name', 'first_name', 'last_name',
  'jersey_number', 'depth_chart_position', 'gsis_id', 'espn_id', 'years_exp', 'headshot_url', 'week'];

function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }

/* RFC-4180-ish: quoted fields, doubled quotes, CRLF. Same shape as
   football/injuries/fetch_injuries.js — kept local so this script has no
   dependency to break. */
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
const clean = (s) => String(s == null ? '' : s).trim();
function csvQuote(s) { s = String(s == null ? '' : s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

/* nflverse team codes as the app spells them. Mirrors fetch_injuries.js so a
   traded QB lands on the same code the rest of the football module uses. */
const CODE_ALIAS = { LAR: 'LA', SD: 'LAC', OAK: 'LV', STL: 'LA', WSH: 'WAS', JAC: 'JAX' };
function teamCode(t) { t = clean(t).toUpperCase(); return CODE_ALIAS[t] || t; }

/* The client's own fbQbSane(), so a file this script accepts is a file the
   browser will accept. Counted over ACTIVE rows, which is what it registers. */
function sane(activeRows) {
  const teams = new Set(activeRows.map(r => r.team));
  return activeRows.length >= 40 && activeRows.length <= 200 && teams.size >= 28;
}

function build(rows, season) {
  const qbs = rows.filter(r => clean(r.position).toUpperCase() === 'QB' && clean(r.team));
  /* week order, stable: the client keeps the LATER row for a repeated GSIS id,
     which is how a mid-season trade resolves to the current team. */
  qbs.sort((a, b) => (parseInt(a.week, 10) || 0) - (parseInt(b.week, 10) || 0));
  const out = qbs.map(r => {
    const o = {};
    COLUMNS.forEach(c => { o[c] = clean(r[c]); });
    o.team = teamCode(r.team);
    o.season = clean(r.season) || String(season);
    return o;
  });
  /* what the browser will end up registering, deduplicated the way it does */
  const seen = new Map();
  out.filter(r => clean(r.status).toUpperCase() === 'ACT')
    .forEach(r => { seen.set(r.gsis_id || (r.full_name + '|' + r.team), r); });
  return { rows: out, active: [...seen.values()] };
}

function serialise(rows) {
  return COLUMNS.join(',') + '\n' + rows.map(r => COLUMNS.map(c => csvQuote(r[c])).join(',')).join('\n') + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const season = parseInt(argOf('--season', String(defaultSeason())), 10);
  const outDir = argOf('--out', path.join(__dirname));
  const file = path.join(outDir, `qbs_${season}.csv`);

  const url = URL(season);
  let text;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    console.error(`qb roster: could not fetch ${url} — ${e && e.message}`);
    console.error('nothing written; the committed snapshot (if any) stands.');
    process.exit(1);
  }

  const { rows, active } = build(parseCsv(text), season);
  if (!sane(active)) {
    const teams = new Set(active.map(r => r.team)).size;
    console.error(`qb roster: roster_${season}.csv parsed to ${active.length} active QBs on ${teams} teams — `
      + 'outside the 40-200 / 28-team bounds the app itself applies. Refusing to write: '
      + 'a broken feed must never become the floor.');
    process.exit(1);
  }

  const next = serialise(rows);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === next) {
    console.log(`qb roster: unchanged — ${active.length} active QBs on ${new Set(active.map(r => r.team)).size} teams (${rows.length} rows)`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, next);
  console.log(`qb roster: wrote ${path.relative(process.cwd(), file)} — ${active.length} active QBs on `
    + `${new Set(active.map(r => r.team)).size} teams (${rows.length} rows, ${(next.length / 1024).toFixed(0)} KB)`);
}

if (require.main === module) main();
module.exports = { build, parseCsv, serialise, sane, teamCode, COLUMNS };
