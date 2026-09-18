#!/usr/bin/env node
/* ===========================================================================
   ESPN'S CLUB LIST, FETCHED THE WAY THIS PROJECT HAS LEARNED TO FETCH IT

   Two facts established the hard way earlier in this work, both of which cost a
   wrong conclusion before they were understood:

   1. A BROWSER USER AGENT IS NOT OPTIONAL on several ESPN paths. /scoreboard and
      /teams tolerate any agent; /summary, /roster and /standings return an
      Akamai deny page without one. The UA is sent always, so no caller has to
      remember which paths care.

   2. AN EMPTY PAYLOAD WITH A 200 IS A THROTTLE, NOT AN ANSWER. The team list
      returns 437 clubs when asked at a civil rate and an empty list when
      hurried. A probe that reads that empty list as "ESPN has no clubs" reports
      a pacing problem as a data problem — which happened, and which killed a job
      before the check that actually mattered could run.

   So this retries with backoff and distinguishes the two outcomes: an empty list
   after every attempt is reported as a throttle rather than as an absence.
   =========================================================================== */
'use strict';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchClubs(opts) {
  opts = opts || {};
  const tries = opts.tries || 4;
  const log = opts.log || (() => {});
  let lastStatus = null;
  for (let i = 0; i < tries; i++) {
    if (i) {
      /* 2s, 6s, 14s. Generous on purpose: the whole point is to stop reading a
         throttle as an answer, and being impatient here is what caused that. */
      const wait = 2000 * Math.pow(2, i) - 2000;
      log(`empty or failed; waiting ${wait}ms before attempt ${i + 1} of ${tries}`);
      await sleep(wait);
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(`${ESPN}/teams?limit=1000`, {
        signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA },
      });
      lastStatus = r.status;
      const body = await r.text();
      clearTimeout(t);
      if (r.status === 200) {
        const j = JSON.parse(body);
        const raw = ((((j || {}).sports || [])[0] || {}).leagues || [])[0];
        const clubs = (((raw || {}).teams) || []).map((x) => x.team).filter(Boolean);
        if (clubs.length) return { ok: true, clubs: clubs, attempts: i + 1 };
      }
    } catch (e) { clearTimeout(t); }
  }
  return { ok: false, clubs: [], attempts: tries, status: lastStatus,
    why: 'the team list came back empty on every attempt. This host returns 200 with an '
      + 'empty list when hurried, so this is a throttle rather than a claim that ESPN '
      + 'has no clubs — do not record it as a data finding.' };
}

module.exports = { ESPN, UA, fetchClubs };
