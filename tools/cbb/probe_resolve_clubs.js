#!/usr/bin/env node
/* ===========================================================================
   VERIFY THE ALIAS TABLE AGAINST THE LIVE ESPN CLUB LIST

   tools/cbb/team_aliases.js was written by hand from 35 measured misses. Written
   by hand means possibly wrong, and possibly right today and wrong next season
   when ESPN renames a club. So this checks every entry against the live list and
   reports what resolved, what did not, and — the one that would do real damage —
   whether two archive codes ended up pointing at the same ESPN club.

   Writes nothing. Its only job is to say whether the mapping is fit to use.
   =========================================================================== */
'use strict';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const A = require('./ncaa_archive.js');
const T = require('./team_aliases.js');

(async function main() {
  console.log('verifying the club alias table against the live ESPN list\n');

  const crypto = require('crypto');
  const spec = A.SOURCES.batting;
  const r0 = await fetch(spec.url, { headers: { accept: 'text/csv' } });
  const csv = await r0.text();
  if (crypto.createHash('sha256').update(csv).digest('hex') !== spec.sha256) {
    console.log('FAIL | cbb resolve clubs | the archive file does not match its pin; '
      + 'a mapping verified against unverified content is not verified.');
    process.exit(1);
  }
  const clubs = new Map();
  for (const row of A.parseCsv(csv)) {
    if (row.team && !clubs.has(row.team)) clubs.set(row.team, row['team name'] || row.team);
  }
  const archiveClubs = Array.from(clubs, ([code, name]) => ({ code, name }));

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  const r = await fetch(`${ESPN}/teams?limit=1000`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
  clearTimeout(t);
  const j = JSON.parse(await r.text());
  const raw = ((((j || {}).sports || [])[0] || {}).leagues || [])[0];
  const espn = (((raw || {}).teams) || []).map((x) => x.team).filter(Boolean);
  if (!espn.length) { console.log('FAIL | cbb resolve clubs | ESPN team list came back empty'); process.exit(1); }

  const res = T.resolveClubs(archiveClubs, espn);
  console.log(`archive clubs: ${archiveClubs.length}`);
  console.log(`ESPN clubs:    ${espn.length}`);
  console.log(`resolved:      ${res.mapped.length} — ${(res.rate * 100).toFixed(1)}%`);
  console.log(`  by name:  ${res.mapped.filter((m) => m.via === 'name').length}`);
  console.log(`  by alias: ${res.mapped.filter((m) => m.via === 'alias').length} of ${Object.keys(T.ALIASES).length} written\n`);

  if (res.aliasFailed.length) {
    console.log(`── ${res.aliasFailed.length} ALIAS(ES) NO LONGER RESOLVE — this file is out of date ──\n`);
    for (const a of res.aliasFailed) console.log(`  ${a}`);
    console.log('');
  }
  /* THE ONE THAT WOULD DO REAL DAMAGE. Two archive codes on one ESPN club means
     one club's brief carries another club's players. USC and USC Upstate are the
     pair this is watching for. */
  if (res.collisions.length) {
    console.log(`── ${res.collisions.length} COLLISION(S) — two archive clubs on one ESPN club ──\n`);
    for (const c of res.collisions) console.log(`  ${c}`);
    console.log('');
  } else {
    console.log('no collisions: no two archive clubs resolve to the same ESPN club.\n');
  }
  if (res.unresolved.length) {
    console.log(`── ${res.unresolved.length} still unresolved ─────────────────────────────\n`);
    for (const u of res.unresolved) console.log(`  ${u.code}  ${u.name}  (${u.why})`);
    console.log('');
  }

  /* Print the pair that must never collapse, resolved, so a reader can see it. */
  const usc = res.mapped.find((m) => m.code === 'USC');
  const upst = res.mapped.find((m) => m.code === 'UPST');
  console.log('the pair that must never collapse:');
  console.log(`  USC  → ${usc ? usc.espn_name + ' (' + usc.espn_id + ')' : 'UNRESOLVED'}`);
  console.log(`  UPST → ${upst ? upst.espn_name + ' (' + upst.espn_id + ')' : 'UNRESOLVED'}`);
  if (usc && upst && usc.espn_id === upst.espn_id) {
    console.log('  THEY COLLAPSED. The mapping is not fit to use.');
    process.exit(1);
  }
  console.log('');

  /* ── WHAT ESPN ACTUALLY CALLS THEM ─────────────────────────────────────
     The first version of the alias table was written from memory, and six of
     the thirty-five entries named clubs ESPN does not call that. Guessing at a
     spelling is the whole mistake the alias table exists to avoid, so the probe
     now hands over the candidates instead of leaving me to guess again.

     These are SUGGESTIONS FOR A PERSON TO READ. Nothing is applied: the ranking
     is a crude shared-token count, which is exactly the sort of similarity
     score that would map USC onto USC Upstate if it were trusted. It is printed
     so a human can pick, and for no other purpose. */
  if (res.unresolved.length) {
    console.log('── candidate ESPN clubs for each unresolved archive club ─────\n');
    console.log('   (suggestions only — nothing here is applied automatically)\n');
    const tokens = (x) => new Set(T.norm(x).split(' ').filter((w) => w.length > 2));
    for (const u of res.unresolved) {
      const want = tokens(u.name);
      const scored = espn.map((t) => {
        const have = tokens(t.displayName);
        let shared = 0;
        for (const w of want) if (have.has(w)) shared++;
        return { t, shared };
      }).filter((x) => x.shared > 0).sort((a, b) => b.shared - a.shared).slice(0, 4);
      console.log(`  ${u.code}  "${u.name}"  (${u.why})`);
      if (!scored.length) console.log('      no ESPN club shares a word with it');
      for (const x of scored) {
        console.log(`      id=${x.t.id}  location="${x.t.location}"  display="${x.t.displayName}"`
          + `  short="${x.t.shortDisplayName}"`);
      }
      console.log('');
    }
  }

  if (res.aliasFailed.length) {
    console.log('FAIL | cbb resolve clubs | an alias written by hand no longer resolves. '
      + 'Update tools/cbb/team_aliases.js before the mapping is used. The candidates '
      + 'above are what ESPN actually publishes.');
    process.exit(1);
  }
  if (res.collisions.length) {
    console.log('FAIL | cbb resolve clubs | two archive clubs resolve to one ESPN club. '
      + 'That would put one club\'s players on another club\'s game.');
    process.exit(1);
  }
  console.log('PASS | cbb resolve clubs | reported, nothing written');
})().catch((e) => {
  console.log('FAIL | cbb resolve clubs | ' + ((e && e.stack) || e));
  process.exit(1);
});
