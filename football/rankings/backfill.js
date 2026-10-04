#!/usr/bin/env node
/* ============================================================================
   THE SEASON BACKFILL — rebuild every week of a season, in order, so the
   weekly history exists rather than starting from whenever somebody first ran
   the build.

   WHY IT IS NEEDED. The weekly job writes ONE snapshot: the week the board
   currently stands at. A season that has been played for three weeks before
   anybody ran the job therefore has one week of history and no Δ against
   anything. This walks the season's completed week ordinals from the preseason
   forward, runs the ordinary build at each of them with `--through-week`, and
   leaves the board standing at the latest week — which is exactly the state a
   weekly job would have produced had it run every week.

   IT IS THE SAME BUILD. There is no second rating engine here and no separate
   code path: this file shells out to `build_rankings.js` once per week. What
   it adds is the ORDER and the pruning flag.

   WHAT A BACKFILLED WEEK IS AND IS NOT. It is a reconstruction of what this
   board WOULD have said about that week, and every snapshot it writes says so
   (`reconstructed: true`). It is not a record of what the board DID say: the
   talent half is read from the player artifact as it stands today, and a
   player artifact cannot be un-run. Weeks the live job wrote at the time are
   left exactly as they are unless --rewrite-history is passed.

     node football/rankings/backfill.js [--season 2026] [--seasons 4]
          [--cache DIR] [--from 0] [--to 25] [--rewrite-history] [--quiet]

   Exit 0 = every week built. Exit 1 = a week failed, and which one.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const B = require('../players/build_players.js');
const BR = require('./build_rankings.js');

const DIR = __dirname;
const BUILD = path.join(DIR, 'build_rankings.js');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
function log(...a) { if (!QUIET) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));
const SEASONS_BACK = arg('seasons', null);
const CACHE = arg('cache', process.env.EDP_CACHE || '') || null;
const FROM = +(arg('from', 0));
const TO = arg('to', null) == null ? null : +arg('to', null);
const REWRITE = !!arg('rewrite-history', false);

async function main() {
  const sched = await B.loadSchedule(SEASON);

  /* the week ordinals this season has actually finished, plus the preseason,
     which is a real row: it is what the system believed before the season
     answered it */
  /* the same finality rule the build uses: a game the ESPN box carries for
     both teams is a game that was played, whatever the schedule feed says */
  const box = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, '..', 'data', 'box', SEASON + '.json'), 'utf8')); }
    catch (_) { return null; }
  })();
  const rec = BR.reconcileFinality(sched, box);
  if (rec.confirmed_by_box.length) {
    log(`  ${rec.confirmed_by_box.length} game(s) confirmed final by the box feed alone`);
  }
  const played = new Set([0]);
  for (const g of sched.games) {
    if (!BR.isFinal(g)) continue;
    played.add(BR.weekOrdinal(g.season_type, g.week));
  }
  let ords = Array.from(played).sort((a, b) => a - b).filter(o => o >= FROM && (TO == null || o <= TO));
  if (!ords.length) {
    console.error(`season ${SEASON} has no completed week in the requested range — nothing to backfill`);
    return 1;
  }
  log(`EdgeDesk rankings backfill — season ${SEASON}, week ordinals ${ords.join(', ')}`);

  const before = new Set(fs.existsSync(BR.SNAP_DIR) ? fs.readdirSync(BR.SNAP_DIR) : []);
  const results = [];
  for (let i = 0; i < ords.length; i++) {
    const ord = ords[i];
    const last = i === ords.length - 1;
    const args = [BUILD, '--season', String(SEASON)];
    if (SEASONS_BACK != null && SEASONS_BACK !== true) args.push('--seasons', String(SEASONS_BACK));
    if (CACHE) args.push('--cache', CACHE);
    if (REWRITE) args.push('--rewrite-history');
    /* the LAST pass is an ordinary full build, so the published board and the
       artifact the site reads are the live ones and carry no reconstruction
       marker of their own */
    if (!last) args.push('--through-week', String(ord));
    if (QUIET) args.push('--quiet');
    log(`\n=== week ordinal ${ord}${last ? ' (final pass — the live board)' : ' (reconstructed)'} ===`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--max-old-space-size=6144'].concat(args),
      { stdio: QUIET ? 'pipe' : 'inherit', env: process.env });
    const ms = Date.now() - t0;
    if (r.status !== 0) {
      console.error(`BACKFILL FAILED at week ordinal ${ord} (exit ${r.status})`);
      if (QUIET && r.stderr) console.error(String(r.stderr).slice(-4000));
      return 1;
    }
    results.push({ week_ordinal: ord, reconstructed: !last, ms });
  }

  const after = fs.existsSync(BR.SNAP_DIR) ? fs.readdirSync(BR.SNAP_DIR).filter(f => /\.json$/.test(f)) : [];
  const added = after.filter(f => !before.has(f));
  log(`\nbackfill complete — ${results.length} week(s) built, ${added.length} new snapshot(s): ${added.join(', ') || 'none (all already on file)'}`);
  const hist = (() => { try { return JSON.parse(fs.readFileSync(BR.HISTORY_FILE, 'utf8')); } catch (_) { return null; } })();
  if (hist) log(`history now holds ${hist.snapshots.length} week(s): ${hist.snapshots.map(s => s.week_label).join(' -> ')}`);
  return 0;
}

module.exports = { main };
if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('BACKFILL FAILED:', e && e.stack || e); process.exit(1); });
}
