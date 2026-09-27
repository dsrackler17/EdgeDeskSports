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

  const got = await require('./espn_clubs.js').fetchClubs({ log: (m) => console.log('  ' + m) });
  const espn = got.clubs;
  if (!got.ok) {
    /* THIS ONE IS A GATE, so an inconclusive read must not read as a pass — but
       it must not read as a broken alias table either. Those are different
       things and conflating them is how a throttle gets recorded as a mapping
       fault. Non-zero, with the reason named. */
    console.log(`FAIL | cbb resolve clubs | ${got.why}`);
    process.exit(1);
  }

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
    /* TWO CHARACTERS, NOT THREE. "SE Louisiana" is a plausible ESPN spelling of
       Southeastern Louisiana and its distinguishing token is "se", which a
       three-character floor throws away — leaving the search to match on
       "louisiana" alone and rank four unrelated Louisiana clubs above it. */
    const tokens = (x) => new Set(T.norm(x).split(' ').filter((w) => w.length >= 2));
    for (const u of res.unresolved) {
      const want = tokens(u.name);
      const scored = espn.map((t) => {
        const have = tokens(t.displayName);
        let shared = 0;
        for (const w of want) if (have.has(w)) shared++;
        return { t, shared };
      /* EVERY club that shares a word, not the top four. Truncating to four
         ranked by a crude token count is how the right answer gets cut off:
         SELA's real club sat below four unrelated Louisiana programmes and was
         never shown, so I concluded from its absence that it had resolved by
         name. It had not. A dozen lines a person can read beats four lines
         chosen by a scorer nobody trusts. */
      }).filter((x) => x.shared > 0).sort((a, b) => b.shared - a.shared).slice(0, 14);
      console.log(`  ${u.code}  "${u.name}"  (${u.why})`);
      if (!scored.length) console.log('      no ESPN club shares a word with it');
      for (const x of scored) {
        console.log(`      id=${x.t.id}  location="${x.t.location}"  display="${x.t.displayName}"`
          + `  short="${x.t.shortDisplayName}"`);
      }
      console.log('');
    }
  }

  /* ── AND IF ANYTHING IS STILL UNRESOLVED, THE WHOLE LIST ────────────────
     The token-overlap suggestions above find a club only when its ESPN name
     shares a word with its NCAA name. For SELA ("Southeastern La.") and ULM
     they found nothing useful, which means no amount of scoring will — so the
     list itself is printed. 437 lines is a lot of log and still cheaper than
     one more alias written from memory. */
  if (res.unresolved.length) {
    console.log('── every ESPN club, so the remaining aliases are read and not recalled ──\n');
    const sorted = espn.slice().sort((a, b) =>
      String(a.location || a.displayName).localeCompare(String(b.location || b.displayName)));
    for (const t of sorted) {
      console.log(`  ${String(t.id).padStart(7)}  ${String(t.location || '').padEnd(30)}`
        + `${String(t.displayName || '')}`);
    }
    console.log('');
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
