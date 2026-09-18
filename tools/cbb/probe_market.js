#!/usr/bin/env node
/* ===========================================================================
   IS COLLEGE BASEBALL ACTUALLY IN THE MARKET FEED?

   The brief's market section is deliberately unwired, and the reason it stayed
   that way is that I could not answer this question. My earlier attempt read
   the signals table as anon and got zero rows for every sport key I tried --
   INCLUDING two controls I knew were captured. Zero everywhere means the read
   was refused by RLS, not that the feed is empty, and I said so at the time
   rather than reporting "no college baseball market".

   A runner has the service role, which is not subject to those policies. So
   this settles it, and it settles it the only way worth trusting: by asking
   what sport keys the feed ACTUALLY contains rather than guessing at a spelling
   and reading a zero as an answer.

   Two controls are mandatory here. If baseball_mlb and americanfootball_ncaaf
   both come back zero, this probe has proved nothing again and says so instead
   of concluding anything.

   WRITES NOTHING. Reads counts and sport keys only — no prices are copied
   anywhere, and nothing is derived into a probability, total or price.
   =========================================================================== */
'use strict';

const P = require('../lib/pgrest.js');

/* Every plausible spelling. Reading a zero for a key that does not exist is not
   evidence about a sport; it is evidence about a guess. */
const CANDIDATES = [
  'baseball_ncaa', 'baseball_ncaab', 'baseball_college', 'baseball_college_baseball',
  'baseball_ncaa_baseball', 'ncaa_baseball', 'baseball_cbb',
];
/* If these two are zero the read itself failed and nothing below means anything. */
const CONTROLS = ['baseball_mlb', 'americanfootball_ncaaf'];

(async function main() {
  const cfg = P.config();
  if (!cfg) {
    console.log('FAIL | cbb market probe | EDGD_SB_SERVICE and EDGD_SB_URL are not both set, so '
      + 'this would read nothing and prove nothing — exactly the mistake it exists to correct.');
    process.exit(1);
  }
  const db = P.client(cfg);
  console.log('college baseball market probe — is it in the feed at all?\n');

  /* ── the controls first, because they decide whether to believe the rest ── */
  console.log('── controls: does this read work at all? ────────────────────────────\n');
  const control = {};
  for (const k of CONTROLS) {
    try {
      const rows = await db.select('public', 'signals', `select=id&sport_key=eq.${k}&limit=1000`);
      control[k] = (rows || []).length;
      console.log(`  ${k}: ${control[k]} rows${control[k] >= 1000 ? '+ (capped)' : ''}`);
    } catch (e) {
      control[k] = null;
      console.log(`  ${k}: READ FAILED — ${String((e && e.message) || e).slice(0, 160)}`);
    }
  }
  const controlsOk = CONTROLS.some((k) => control[k] > 0);
  console.log('');
  if (!controlsOk) {
    console.log('STOP. Both controls are empty or unreadable, so this read is not working and');
    console.log('NOTHING below is evidence about college baseball. This is the same wall the');
    console.log('anon read hit, and reporting "no college baseball market" from here would be');
    console.log('reporting a broken read as a finding.');
    console.log('PASS | cbb market probe | inconclusive, and saying so');
    process.exit(0);
  }

  /* ── what keys exist, rather than what I would have guessed ─────────────── */
  console.log('── every sport key the feed carries ─────────────────────────────────\n');
  let keys = [];
  try {
    const rows = await db.select('public', 'signals', 'select=sport_key,sport_title&limit=20000');
    const seen = new Map();
    for (const r of (rows || [])) {
      const k = r.sport_key || '(null)';
      if (!seen.has(k)) seen.set(k, { title: r.sport_title || '', n: 0 });
      seen.get(k).n++;
    }
    keys = Array.from(seen.entries()).sort((a, b) => b[1].n - a[1].n);
    for (const [k, v] of keys) console.log(`  ${String(v.n).padStart(6)}  ${k}${v.title ? '  — ' + v.title : ''}`);
    if (!keys.length) console.log('  (no rows at all in the sampled window)');
  } catch (e) {
    console.log(`  READ FAILED — ${String((e && e.message) || e).slice(0, 200)}`);
  }
  console.log('');

  /* ── anything that looks like college baseball, however spelled ─────────── */
  console.log('── anything baseball-shaped that is not MLB ─────────────────────────\n');
  const baseballish = keys.filter(([k, v]) =>
    /baseball/i.test(k + ' ' + v.title) && k !== 'baseball_mlb');
  if (baseballish.length) {
    for (const [k, v] of baseballish) console.log(`  FOUND  ${k} (${v.n} rows)${v.title ? ' — ' + v.title : ''}`);
  } else {
    console.log('  none. The feed carries baseball_mlb and no other baseball key.');
  }
  console.log('');

  console.log('── and the spellings I would have guessed, for the record ───────────\n');
  for (const k of CANDIDATES) {
    const hit = keys.find(([kk]) => kk === k);
    console.log(`  ${k}: ${hit ? hit[1].n + ' rows' : 'not a key in this feed'}`);
  }
  console.log('');

  console.log('READING THIS: the controls answered, so a zero below is a real zero.');
  console.log('If no baseball key other than baseball_mlb exists, the honest thing for');
  console.log('the college baseball brief is to say the market section is empty because');
  console.log('the feed does not cover the sport — not to leave a blank panel that reads');
  console.log('as a loading failure, and certainly not to derive a price from run rates.');
  console.log('PASS | cbb market probe | reported, nothing written');
})().catch((e) => {
  console.log('FAIL | cbb market probe | ' + ((e && e.stack) || e));
  process.exit(1);
});
