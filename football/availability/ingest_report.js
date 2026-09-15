#!/usr/bin/env node
/* ============================================================================
   INGEST ONE OFFICIAL AVAILABILITY REPORT.

   The reusable path: fetch (or read) a conference filing, resolve every named
   player against the CURRENT roster, and write a dated evidence file into
   football/availability/reports/ that football/availability/overlay.js merges
   for every consumer.

     node football/availability/ingest_report.js \
       --conference ACC --team "Miami" --url https://theacc.com/... \
       --published-at 2026-09-17T02:00:00Z --game-id 401858226 \
       --kickoff 2026-09-18T23:30:00Z

     node football/availability/ingest_report.js --file report.pdf --conference "Big 12" \
       --team "Texas Tech" --published-at ... --game-id ...

     node football/availability/ingest_report.js --list          what is on file
     node football/availability/ingest_report.js --due --season 2026
        every fixture on the current slate whose conference report is inside
        its filing window, with the url to fetch — so a scheduled run knows
        what to ask for rather than asking for everything every time.

   A READ THAT FAILS IS WRITTEN AS A FAILED READ. It is never written as a
   report that named nobody, and --dry-run prints what would be written without
   writing it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const R = require(path.join(HERE, 'reports.js'));
const POLICY = require(path.join(HERE, 'policy.js'));

const OUT_DIR = path.join(HERE, 'reports');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function nk(s) { return s == null ? null : (String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

/* the current-season roster for one team, which is what every name is
   anchored against. A team with no roster is refused: a report EdgeDesk
   cannot resolve to real players is a report it must not quote. */
function rosterFor(team, season) {
  const f = path.join(ROOT, 'football', 'rosters', `fbs_${season}_espn.json`);
  const d = readJson(f, null);
  if (!d) return null;
  const want = nk(team);
  for (const t of (d.teams || [])) {
    if ([t.location, t.display_name, t.short_name].some(n => nk(n) === want) || String(t.espn_id) === String(team)) {
      return (t.players || []).map(p => ({ name: p.name, position: p.position, jersey: p.jersey, espn_id: p.espn_id }));
    }
  }
  return null;
}

async function fetchDoc(url) {
  const r = await fetch(url, { redirect: 'follow',
    headers: { 'user-agent': 'EdgeDesk-availability-sync (+https://edgedesksports.com)' },
    signal: AbortSignal.timeout(30000) });
  const ct = r.headers.get('content-type') || '';
  const body = Buffer.from(await r.arrayBuffer());
  /* the LAST-MODIFIED header is the closest thing to a publication time a
     page gives us, and it is only used when the caller supplied none */
  return { ok: r.ok, status: r.status, content_type: ct, body,
    last_modified: r.headers.get('last-modified') || null };
}

/* every fixture whose conference report is inside its filing window */
function due(season, now) {
  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  if (!slate || !slate.games) return { error: 'football/fbs/slate.json is not built' };
  const out = [];
  for (const g of slate.games) {
    for (const side of ['home', 'away']) {
      const p = POLICY.forGame({ home_conference: g.home_conference, away_conference: g.away_conference,
        is_conference_game: g.is_conference_game, kickoff: g.kickoff }, side, now);
      if (p.state !== 'REQUIRED') continue;
      out.push({ game_id: g.game_id, kickoff: g.kickoff, team: side === 'home' ? g.home_team : g.away_team,
        conference: p.conference, url: p.report_url, comprehensive: p.comprehensive,
        hours_to_kickoff: p.hours_to_kickoff });
    }
  }
  return { due: out };
}

async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (arg('list', false)) {
    const files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter(f => /\.json$/.test(f)) : [];
    const rows = files.map(f => {
      const d = readJson(path.join(OUT_DIR, f), {});
      return { file: f, team: d.team, conference: d.conference, ok: d.ok, names: (d.rows || []).length,
        published_at: d.published_at, retrieved_at: d.retrieved_at, why: d.why };
    });
    console.log(JSON.stringify({ on_file: rows.length, reports: rows }, null, 1));
    return 0;
  }
  if (arg('due', false)) {
    const d = due(+(arg('season', defaultSeason())), now);
    console.log(JSON.stringify(d, null, 1));
    return d.error ? 2 : 0;
  }

  const conference = arg('conference', null);
  const team = arg('team', null);
  const url = arg('url', null);
  const file = arg('file', null);
  const season = +(arg('season', defaultSeason()));
  if (!conference || !team || (!url && !file)) {
    console.error('[report] --conference, --team and one of --url/--file are required');
    return 2;
  }
  const roster = rosterFor(team, season);
  if (!roster || !roster.length) {
    console.error('[report] no ' + season + ' roster resolves for "' + team + '" — refusing to read a report '
      + 'EdgeDesk cannot anchor to real players');
    return 2;
  }

  let body = null, contentType = null, lastModified = null, readError = null;
  if (file) {
    try { body = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file)); }
    catch (e) { readError = 'the local file could not be read: ' + ((e && e.message) || e); }
    contentType = /\.pdf$/i.test(String(file)) ? 'application/pdf' : 'text/html';
  } else {
    try {
      const r = await fetchDoc(url);
      if (!r.ok) readError = 'HTTP ' + r.status + ' from ' + url;
      else { body = r.body; contentType = r.content_type; lastModified = r.last_modified; }
    } catch (e) { readError = String((e && e.message) || e).slice(0, 200); }
  }

  const meta = {
    conference, team, source_url: url || ('file://' + file),
    published_at: arg('published-at', null) || lastModified || null,
    retrieved_at: new Date(now).toISOString(),
    game_id: arg('game-id', null) ? String(arg('game-id')) : null,
    kickoff: arg('kickoff', null) || null,
    home_conference: arg('home-conference', null) || conference,
    away_conference: arg('away-conference', null) || conference,
    is_conference_game: arg('non-conference', false) ? false : true,
    now
  };

  let out;
  if (readError) {
    const pol = POLICY.forConference(conference);
    out = Object.assign({ schema: R.SCHEMA, version: 1 }, meta, {
      conference: pol ? pol.name : conference, conference_id: pol ? pol.id : null,
      comprehensive: POLICY.silenceMeansAvailable(pol),
      ok: false, rows: [], unparsed: [],
      /* THE POINT OF WRITING THIS AT ALL: a failed read on file is a fact the
         contract can report. An absent file would read as "nobody looked". */
      why: 'the report could not be read — ' + readError
    });
  } else {
    out = R.ingest(Object.assign({ body, content_type: contentType, roster }, meta));
  }

  const name = [season, slug(conference), slug(team), (meta.game_id || slug(meta.published_at || 'undated'))]
    .join('_') + '.json';
  const dest = path.join(OUT_DIR, name);
  if (arg('dry-run', false)) {
    console.log(JSON.stringify(out, null, 1));
    console.log('[report] --dry-run: nothing written (' + path.relative(ROOT, dest) + ')');
    return out.ok ? 0 : 1;
  }
  fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  console.log('[report] ' + (out.ok ? 'ingested' : 'RECORDED A FAILED READ') + ': ' + path.relative(ROOT, dest)
    + ' — ' + (out.why || ''));
  if (out.unparsed && out.unparsed.length) {
    console.log('[report] ' + out.unparsed.length + ' line(s) named a rostered player and could not be parsed; '
      + 'they are kept in the file so the gap is visible');
  }
  return out.ok ? 0 : 1;
}

module.exports = { due, rosterFor, OUT_DIR };
if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[report] ' + ((e && e.stack) || e)); process.exit(2); });
