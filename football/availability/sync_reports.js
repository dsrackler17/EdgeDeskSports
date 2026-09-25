#!/usr/bin/env node
/* ============================================================================
   FETCH EVERY AVAILABILITY REPORT THAT IS DUE, AND NOTHING THAT IS NOT.

   The scheduled half of the ingestion path. It asks football/availability/
   policy.js which fixtures on the current slate have a conference report
   REQUIRED and inside its filing window, fetches each one once, and writes the
   result — including a failed read — into football/availability/reports/.

   WHY IT ASKS FIRST. Sixty per cent of an FBS slate in September is
   non-conference, and no conference policy covers a non-conference game. A job
   that fetched every conference page for every fixture would spend most of its
   requests learning nothing and would then have to decide what an empty
   response meant. Asking the policy first means every request is for a
   document that is supposed to exist, and a request that comes back empty is
   therefore a real failure rather than an ambiguity.

   WHAT IT WILL NOT DO. It will not treat a page it could not read as a report
   naming nobody, it will not retry a fixture whose report is not due, and it
   will not write a report without a publication time — the conference's own,
   or the Last-Modified header, and nothing else.

     node football/availability/sync_reports.js [--season 2026] [--limit N]
          [--dry-run] [--now ISO]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const POLICY = require(path.join(HERE, 'policy.js'));
const R = require(path.join(HERE, 'reports.js'));
const OVERLAY = require(path.join(HERE, 'overlay.js'));
const ING = require(path.join(HERE, 'ingest_report.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

async function main() {
  const season = +(arg('season', defaultSeason()));
  const limit = arg('limit', null) ? +arg('limit') : Infinity;
  const dry = !!arg('dry-run', false);
  const nowArg = arg('now', null);
  const now = nowArg && nowArg !== true ? Date.parse(nowArg) : Date.now();

  const slate = readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'), null);
  if (!slate || !slate.games) { console.error('[reports] football/fbs/slate.json is not built'); return 2; }

  const wanted = [];
  for (const g of slate.games) {
    for (const side of ['home', 'away']) {
      const p = POLICY.forGame({ home_conference: g.home_conference, away_conference: g.away_conference,
        is_conference_game: g.is_conference_game, kickoff: g.kickoff }, side, now);
      if (p.state !== 'REQUIRED' || !p.report_url) continue;
      wanted.push({ game_id: String(g.game_id), kickoff: g.kickoff,
        team: side === 'home' ? g.home_team : g.away_team,
        conference: p.conference, url: p.report_url,
        home_conference: g.home_conference, away_conference: g.away_conference });
    }
  }
  console.error('[reports] ' + wanted.length + ' fixture-side(s) have a required report inside its filing window');
  if (!wanted.length) return 0;

  /* ONE FETCH PER URL. A conference publishes one page for the week; asking
     for it twenty times to read twenty teams off it is twenty requests for one
     document, and every one of them is a chance to be rate-limited into a
     failure that looks like an absence. */
  const byUrl = new Map();
  wanted.forEach(w => { if (!byUrl.has(w.url)) byUrl.set(w.url, []); byUrl.get(w.url).push(w); });

  const outDir = path.join(HERE, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  let ok = 0, failed = 0, skipped = 0;
  for (const [url, group] of byUrl) {
    if (ok + failed >= limit) { skipped += group.length; continue; }
    let doc = null, err = null, lastModified = null, contentType = null;
    try {
      const r = await fetch(url, { redirect: 'follow',
        headers: { 'user-agent': 'EdgeDesk-availability-sync (+https://edgedesksports.com)' },
        signal: AbortSignal.timeout(30000) });
      if (!r.ok) err = 'HTTP ' + r.status;
      else {
        doc = Buffer.from(await r.arrayBuffer());
        contentType = r.headers.get('content-type') || '';
        lastModified = r.headers.get('last-modified') || null;
      }
    } catch (e) { err = String((e && e.message) || e).slice(0, 200); }

    /* both sides of every fixture on this document are read first and
       written together: whether a side's silence is a report of no absences
       depends on what the same document said about the other side
       (overlay.js corroborate) */
    const pending = [];
    for (const w of group) {
      const roster = ING.rosterFor(w.team, season);
      if (!roster || !roster.length) {
        console.error('[reports] no ' + season + ' roster for ' + w.team + ' — skipped rather than quoted');
        skipped++; continue;
      }
      let out;
      if (err || !doc) {
        const pol = POLICY.forConference(w.conference);
        out = { schema: R.SCHEMA, version: 1, conference: pol ? pol.name : w.conference,
          conference_id: pol ? pol.id : null, team: w.team, game_id: w.game_id, kickoff: w.kickoff,
          source_url: url, published_at: null, retrieved_at: new Date(now).toISOString(),
          comprehensive: POLICY.silenceMeansAvailable(pol),
          ok: false, rows: [], unparsed: [],
          why: 'the report could not be read — ' + (err || 'no document') };
      } else {
        out = R.ingest({ body: doc, content_type: contentType, conference: w.conference, team: w.team,
          roster, source_url: url, published_at: R.publishedFromHeaders(lastModified, contentType, doc),
          game_id: w.game_id, kickoff: w.kickoff,
          home_conference: w.home_conference, away_conference: w.away_conference,
          is_conference_game: true, now });
      }
      pending.push({ w, out });
    }
    const judged = OVERLAY.corroborate(pending.map(p => p.out));
    pending.forEach((p, i) => {
      const out = judged[i];
      if (out.ok) ok++; else failed++;
      const name = [season, slug(p.w.conference), slug(p.w.team), p.w.game_id].join('_') + '.json';
      if (dry) console.error('[reports] --dry-run ' + name + ': ' + (out.ok ? 'ok' : 'FAILED') + ' — ' + out.why);
      else fs.writeFileSync(path.join(outDir, name), JSON.stringify(out, null, 1) + '\n');
    });
  }
  console.error('[reports] ' + ok + ' ingested, ' + failed + ' recorded as failed reads, ' + skipped + ' skipped');
  /* the one-file copy the board reads (reports.js writeBundle) */
  if (!dry && R.writeBundle(outDir)) console.error('[reports] rewrote football/availability/reports.bundle.json');
  /* A FAILED READ IS NOT A FAILED RUN. The artifact records it and the
     contract reports FETCH_FAILED; exiting non-zero here would turn a source
     refusing into a broken pipeline. */
  return 0;
}

if (require.main === module) main().then(c => process.exit(c || 0)).catch(e => { console.error('[reports] ' + ((e && e.stack) || e)); process.exit(2); });
module.exports = { main };
