#!/usr/bin/env node
/* ===========================================================================
   CAN THE NCAA ARCHIVE BE JOINED TO THE GAMES BOARD?

   The archive keys clubs on NCAA's own codes (AAMU, TENN, VAN) with school
   names attached ("Alabama A&M", "Tennessee"). The games board keys them on
   ESPN's numeric team ids with display names attached ("Alabama A&M Bulldogs",
   "Tennessee Volunteers"). THERE IS NO SHARED IDENTIFIER, so attaching a
   club's season archive to a specific game's brief needs a name match.

   A name match is exactly the kind of thing that looks fine at a glance and is
   quietly wrong for thirty clubs. So this measures it instead of shipping it:
   it prints the match rate and, more usefully, every club that FAILS to match,
   because a join is only worth building if the misses are a short list a person
   can read.

   It writes nothing and builds no mapping. Its output is the evidence for
   deciding whether a mapping is worth building at all.

   Note the two populations are not the same size and should not be: ESPN
   carries 437 teams because a Division I schedule includes non-D1 opponents,
   while the archive is 308 Division I programmes. So the number that matters is
   what fraction of the ARCHIVE finds an ESPN club, not the reverse.
   =========================================================================== */
'use strict';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const A = require('./ncaa_archive.js');

/* ONE NORMALISER, IMPORTED. This file used to carry its own copy, and the copy
   in team_aliases.js then lost six expansions — twelve clubs that matched here
   stopped matching there, which read like a data problem and was a duplication
   problem. There is one list now and it lives with the aliases. */
const { norm } = require('./team_aliases.js');

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    const body = await r.text();
    clearTimeout(t);
    return r.status === 200 ? JSON.parse(body) : null;
  } catch (_) { clearTimeout(t); return null; }
}

(async function main() {
  console.log('can the NCAA season archive be joined to the games board?\n');

  /* ── the archive side, from the pinned file ─────────────────────────────── */
  const crypto = require('crypto');
  const spec = A.SOURCES.batting;
  const r = await fetch(spec.url, { headers: { accept: 'text/csv' } });
  const csv = await r.text();
  const gotHash = crypto.createHash('sha256').update(csv).digest('hex');
  if (gotHash !== spec.sha256) {
    console.log(`FAIL | cbb team join | the archive file does not match its pin `
      + `(${gotHash.slice(0, 16)}… vs ${spec.sha256.slice(0, 16)}…). Measuring a join `
      + `against unverified content would not be a measurement.`);
    process.exit(1);
  }
  const rows = A.parseCsv(csv);
  const archive = new Map();
  for (const row of rows) {
    if (!row.team) continue;
    if (!archive.has(row.team)) archive.set(row.team, row['team name'] || row.team);
  }
  console.log(`archive: ${archive.size} club codes across all seasons\n`);

  /* ── the ESPN side ─────────────────────────────────────────────────────── */
  const tj = await get(`${ESPN}/teams?limit=1000`);
  const raw = ((((tj || {}).sports || [])[0] || {}).leagues || [])[0];
  const espn = (((raw || {}).teams) || []).map((x) => x.team).filter(Boolean);
  if (!espn.length) { console.log('FAIL | cbb team join | ESPN team list came back empty'); process.exit(1); }
  console.log(`ESPN: ${espn.length} clubs\n`);

  /* Index ESPN by every name it offers. `location` is the school on its own
     ("Akron"), which is the field most likely to match NCAA's spelling;
     displayName carries the nickname and shortDisplayName is sometimes the
     school and sometimes an abbreviation. All three are indexed so the match
     rate reflects the best available, not an arbitrary choice of column. */
  const index = new Map();
  const add = (k, t) => { const n = norm(k); if (n && !index.has(n)) index.set(n, t); };
  for (const t of espn) {
    add(t.location, t);
    add(t.name, t);
    add(t.shortDisplayName, t);
    add(t.displayName, t);
    add(t.nickname, t);
  }

  let hit = 0;
  const misses = [];
  for (const [code, name] of archive) {
    const t = index.get(norm(name));
    if (t) hit++; else misses.push(`${code}  ${name}`);
  }
  const rate = archive.size ? hit / archive.size : 0;
  console.log(`matched ${hit} of ${archive.size} archive clubs — ${(rate * 100).toFixed(1)}%\n`);

  if (misses.length) {
    console.log(`── the ${misses.length} that did NOT match ─────────────────────────────\n`);
    for (const m of misses) console.log(`  ${m}`);
    console.log('');
  }

  console.log('READING THIS: a join is worth building if the misses are a short list a');
  console.log('person can finish by hand. If they are not, the archive stays its own');
  console.log('surface — searchable by player and club on its own terms — and a game');
  console.log('brief says the season archive is not attached rather than attaching the');
  console.log('wrong club\'s numbers to a game. Attaching the wrong club is far worse');
  console.log('than attaching nothing.');
  console.log('PASS | cbb team join probe | reported, nothing written');
})().catch((e) => {
  console.log('FAIL | cbb team join | ' + ((e && e.stack) || e));
  process.exit(1);
});
