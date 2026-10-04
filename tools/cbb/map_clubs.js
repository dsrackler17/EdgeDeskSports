#!/usr/bin/env node
/* ===========================================================================
   WRITE THE VERIFIED CLUB MAPPING

   Resolves every NCAA club code in the season archive to an ESPN team id and
   promotes the result into cbb.club_map. The resolution itself lives in
   tools/cbb/team_aliases.js and is verified by tools/cbb/probe_resolve_clubs.js;
   this file is the part that writes.

   IT WILL NOT WRITE A MAPPING IT CANNOT STAND BEHIND. Three refusals before
   anything is staged, and each exists because of something that actually
   happened while this was built:

     - an alias that no longer resolves means team_aliases.js is out of date
       against ESPN's current names. Seven of the first thirty-five were wrong;
       importing anyway would write those seven as facts.
     - two archive codes on one ESPN club would put one programme's season on
       another programme's game. The candidate list really did offer USC Trojans
       as a suggestion for USC Upstate.
     - a match rate that has collapsed since it was measured means something
       changed upstream that nobody has looked at. 88.7% was the measurement;
       falling well below it is a reason to stop, not to write fewer rows.

   A CLUB LEFT OUT IS A HOLE, AND A HOLE IS FINE. Its brief shows no season
   archive and says so. A club written wrongly is the failure that matters, and
   it is the one thing this file is arranged to make impossible.
   =========================================================================== */
'use strict';

const T = require('./team_aliases.js');
const A = require('./ncaa_archive.js');
const { fetchClubs } = require('./espn_clubs.js');

/* The rate the join was measured at. Falling near it is expected — clubs come
   and go — but falling far below it means the source changed shape. */
const MEASURED_RATE = 0.887;
const RATE_FLOOR = 0.80;

const COLS = ['ncaa_code', 'ncaa_name', 'espn_team_id', 'espn_name', 'via'];

/* Read the archive's club list from the pinned file, so the mapping is built
   against the same content the archive itself was imported from. */
async function archiveClubs() {
  const crypto = require('crypto');
  const spec = A.SOURCES.batting;
  const r = await fetch(spec.url, { headers: { accept: 'text/csv' } });
  const csv = await r.text();
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  if (hash !== spec.sha256) {
    throw new Error('SOURCE_CHANGED: the archive file does not match its pin '
      + `(${hash.slice(0, 16)}… against ${spec.sha256.slice(0, 16)}…). A mapping built from `
      + 'content the archive was not imported from would point at clubs that are not in it.');
  }
  const seen = new Map();
  for (const row of A.parseCsv(csv)) {
    if (row.team && !seen.has(row.team)) seen.set(row.team, row['team name'] || row.team);
  }
  return Array.from(seen, ([code, name]) => ({ code, name }));
}

module.exports = { MEASURED_RATE, RATE_FLOOR, COLS, archiveClubs };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (n) => argv.indexOf(n) >= 0;
  const log = (...a) => console.log('[cbb-map]', ...a);

  (async function main() {
    if (!has('--check') && !has('--commit')) {
      console.log('Nothing to do. Pass --check (resolve and report, write nothing) or --commit.');
      process.exit(0);
    }

    const clubs = await archiveClubs();
    log(`${clubs.length} club codes in the archive`);

    const got = await fetchClubs({ log: (m) => log(m) });
    if (!got.ok) {
      /* A throttle is not a smaller league. Writing a mapping from an empty or
         partial club list would delete rows for clubs that still exist. */
      console.log(`FAIL | cbb club map | ${got.why}`);
      process.exit(1);
    }
    log(`${got.clubs.length} ESPN clubs (attempt ${got.attempts})`);

    const res = T.resolveClubs(clubs, got.clubs);
    log(`resolved ${res.mapped.length} of ${clubs.length} — ${(res.rate * 100).toFixed(1)}%`);
    log(`  by name ${res.mapped.filter((m) => m.via === 'name').length}, `
      + `by alias ${res.mapped.filter((m) => m.via === 'alias').length}`);

    let refuse = null;
    if (res.aliasFailed.length) {
      refuse = 'ALIAS_STALE: ' + res.aliasFailed.length + ' hand-written alias(es) no longer '
        + 'resolve, so tools/cbb/team_aliases.js is out of date against ESPN:\n  '
        + res.aliasFailed.join('\n  ');
    } else if (res.collisions.length) {
      refuse = 'CLUB_COLLISION: ' + res.collisions.length + ' ESPN club(s) claimed by two NCAA '
        + 'codes, which would put one programme\'s season on another\'s game:\n  '
        + res.collisions.join('\n  ');
    } else if (res.rate < RATE_FLOOR) {
      refuse = `RATE_COLLAPSED: ${(res.rate * 100).toFixed(1)}% resolved against `
        + `${(MEASURED_RATE * 100).toFixed(1)}% when this was measured. Something changed `
        + 'upstream that nobody has looked at; writing fewer rows would hide it.';
    }
    if (refuse) {
      console.log('FAIL | cbb club map | ' + refuse);
      process.exit(1);
    }

    if (res.unresolved.length) {
      log(`${res.unresolved.length} club(s) unresolved, and left out rather than guessed:`);
      for (const u of res.unresolved) log(`  - ${u.code} ${u.name} (${u.why})`);
      log('Their briefs will show no season archive and say so.');
    }

    /* Show the pair, resolved, every single run. It is the one mistake in this
       mapping that would be invisible in a row count. */
    const usc = res.mapped.find((m) => m.code === 'USC');
    const upst = res.mapped.find((m) => m.code === 'UPST');
    log(`USC  → ${usc ? usc.espn_name + ' (' + usc.espn_id + ')' : 'unresolved'}`);
    log(`UPST → ${upst ? upst.espn_name + ' (' + upst.espn_id + ')' : 'unresolved'}`);
    if (usc && upst && usc.espn_id === upst.espn_id) {
      console.log('FAIL | cbb club map | USC and USC Upstate resolved to the same club.');
      process.exit(1);
    }

    if (!has('--commit')) {
      console.log(`PASS | cbb club map | --check only, nothing written `
        + `(${res.mapped.length} mapped, ${res.unresolved.length} left out)`);
      process.exit(0);
    }

    const DB = require('./db.js');
    const db = DB.createDb();
    const importId = `cbb-clubmap-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
    await db.startRun({
      import_id: importId, dataset: 'club_map', status: 'staging',
      first_season: null, last_season: null, seasons: [],
      source: 'NCAA club codes resolved to ESPN team ids',
      source_note: `${res.mapped.length}/${clubs.length} resolved `
        + `(${(res.rate * 100).toFixed(1)}%); `
        + `${res.mapped.filter((m) => m.via === 'alias').length} by hand-written alias; `
        + `${res.unresolved.length} deliberately unmapped`,
    });
    try {
      const rows = res.mapped.map((m) => ({
        ncaa_code: m.code, ncaa_name: m.name,
        espn_team_id: m.espn_id, espn_name: m.espn_name, via: m.via,
      }));
      const n = await db.stageRows('stg_club_map', COLS, rows, importId);
      log(`staged ${n} mappings`);
    } catch (e) {
      await db.abandon(importId, 'staging failed: ' + e.message);
      throw e;
    }
    const verdict = await db.gate('promote_club_map', ['p_import_id'], { p_import_id: importId });
    if (!verdict || verdict.ok !== true) {
      console.log('REFUSED | cbb club map | the gate declined and kept the previous mapping:');
      for (const r of (verdict && verdict.refusals) || []) console.log(`  - ${r.refusal}: ${r.detail}`);
      process.exit(1);
    }
    console.log(`PASS | cbb club map | promoted ${verdict.rows} club mappings`);
  })().catch((e) => {
    console.log('FAIL | cbb club map | ' + ((e && e.stack) || e));
    process.exit(1);
  });
}
