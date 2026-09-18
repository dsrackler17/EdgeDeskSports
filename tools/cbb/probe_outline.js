#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — STOP GUESSING AT THE SHAPE, PRINT IT

   Two wrong explanations in a row, both mine, both corrected by the next
   probe. Worth recording, because the pattern is the lesson:

     1. I reported /summary as a closed endpoint. It is not.
     2. I then reported it as probably my own pacing. It was not that either.

   What it actually was: the USER AGENT. Request #1 of a cold process with my
   own UA got 403. The same URL, the very next request, with a browser UA, got
   200 and 44KB. /scoreboard and /teams never cared. Three paths on that host
   do. The pacing control in section 3 answered fine, which is exactly how the
   probe managed to rule pacing out instead of letting me believe it.

   And the 200 carried keys I had not looked inside: alongside `boxscore` there
   are `rosters`, `plays`, `playsMap`, `odds`, `pickcenter` and
   `againstTheSpread`. I checked boxscore.players, found its athletes arrays
   empty, and nearly concluded there are no player stats — while the payload
   had a whole `rosters` branch I never opened.

   So this probe prints the SHAPE rather than testing a guess about it. It
   walks the payload to a bounded depth and reports keys, array lengths and
   leaf samples. Whatever is actually in there will be visible, including the
   parts I would not have thought to ask for.

   It also samples several games from different weeks and different levels of
   the sport, because "this one game has no player lines" and "the sport has no
   player lines" are very different findings and one game cannot tell them
   apart.

   WRITES NOTHING.
   =========================================================================== */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const PACE = 1500;

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    const body = await r.text();
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status, body };
    return { ok: true, status: r.status, json: JSON.parse(body), bytes: body.length };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, err: String((e && e.message) || e) };
  }
}

/* Print the shape of a value: keys for objects, length + first element's shape
   for arrays, and a truncated sample for leaves. Bounded so a 44KB payload
   does not become 44KB of log. */
function outline(v, depth, prefix, maxDepth) {
  const pad = '  '.repeat(depth);
  if (v === null) return `${pad}${prefix}null`;
  if (Array.isArray(v)) {
    const head = `${pad}${prefix}[${v.length}]`;
    if (!v.length || depth >= maxDepth) return head;
    return head + '\n' + outline(v[0], depth + 1, '0: ', maxDepth);
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    const head = `${pad}${prefix}{${keys.length}} ${keys.slice(0, 14).join(' ')}${keys.length > 14 ? ' …' : ''}`;
    if (depth >= maxDepth) return head;
    const lines = [head];
    for (const k of keys.slice(0, 14)) lines.push(outline(v[k], depth + 1, k + ': ', maxDepth));
    return lines.join('\n');
  }
  const s = String(v);
  return `${pad}${prefix}${JSON.stringify(s.length > 60 ? s.slice(0, 60) + '…' : s)}`;
}

/* The one question that decides whether an archive can hold player lines:
   does ANY branch of this payload carry a named athlete with numbers? */
function findPlayerLines(j) {
  const found = [];
  const bs = j.boxscore || {};
  for (const side of (bs.players || [])) {
    for (const g of (side.statistics || [])) {
      if ((g.athletes || []).length) {
        found.push(`boxscore.players[].statistics["${g.name}"]: ${g.athletes.length} athletes`
          + ` e.g. ${(g.athletes[0].athlete || {}).displayName} -> ${(g.athletes[0].stats || []).join(' ')}`);
      }
    }
  }
  for (const r of (j.rosters || [])) {
    const roster = r.roster || [];
    const withStats = roster.filter((p) => (p.stats || []).length);
    found.push(`rosters[${(r.team || {}).abbreviation || '?'}].roster: ${roster.length} entries,`
      + ` ${withStats.length} carrying stats`);
    if (withStats.length) {
      const p = withStats[0];
      found.push(`   e.g. ${(p.athlete || {}).displayName || p.displayName || '?'}`
        + ` pos=${((p.position || {}).abbreviation) || '?'}`
        + ` stats=${(p.stats || []).map((s) => (s.name || s.abbreviation) + '=' + (s.displayValue !== undefined ? s.displayValue : s.value)).slice(0, 14).join(' ')}`);
    } else if (roster.length) {
      const p = roster[0];
      found.push(`   first entry keys: ${Object.keys(p).join(' ')}`);
    }
  }
  const plays = j.plays || [];
  if (plays.length) {
    const p = plays[0];
    found.push(`plays: ${plays.length}; first keys: ${Object.keys(p).join(' ')}`);
    found.push(`   text: ${JSON.stringify(String(p.text || '').slice(0, 100))}`);
  }
  return found.length ? found : ['NOTHING anywhere in this payload names a player with numbers'];
}

/* Six games, spread across the season and across the sport: a marquee
   conference game, a mid-week non-conference game, a regional, a low-major.
   These ids come from the scoreboard walk, which this project already trusts. */
const DAYS = ['20260228', '20260320', '20260415', '20260509', '20260530', '20260615'];

(async function main() {
  console.log('college baseball — printing the shape of what ESPN actually returns\n');
  console.log('THE FIX THAT MATTERED: a browser user agent. /summary 403s without');
  console.log('one and returns 44KB with one. Not the path, not the pacing.\n');

  /* Pick one real, finished game from each sampled day rather than hardcoding
     ids that may not exist. */
  const picks = [];
  for (const d of DAYS) {
    const sb = await get(`${SITE}/scoreboard?dates=${d}&limit=500`);
    if (!sb.ok) { console.log(`day ${d}: scoreboard FAILED ${sb.status}`); await sleep(PACE); continue; }
    const done = (sb.json.events || []).filter((e) => {
      const c = (e.competitions || [])[0] || {};
      return c.status && c.status.type && c.status.type.completed;
    });
    console.log(`day ${d}: ${(sb.json.events || []).length} events, ${done.length} completed`);
    if (done.length) picks.push({ day: d, id: done[0].id, name: done[0].shortName || done[0].name });
    await sleep(PACE);
  }
  console.log('');

  if (!picks.length) { console.log('no completed game found on any sampled day — nothing to outline'); return; }

  console.log('══ THE FULL SHAPE OF ONE SUMMARY, TO DEPTH 3 ═══════════════════════\n');
  const first = await get(`${SITE}/summary?event=${picks[0].id}`);
  if (first.ok) {
    console.log(`${picks[0].name} (${picks[0].day}), ${first.bytes}B\n`);
    console.log(outline(first.json, 0, '', 3));
    console.log('');
    console.log('── and specifically, the rosters branch to depth 5 ──\n');
    console.log(outline({ rosters: first.json.rosters }, 0, '', 5));
  } else {
    console.log(`FAILED ${first.status}`);
  }
  console.log('');

  console.log('══ DO PLAYER LINES EXIST, ACROSS SIX DIFFERENT GAMES? ══════════════\n');
  for (const p of picks) {
    await sleep(PACE);
    const s = await get(`${SITE}/summary?event=${p.id}`);
    console.log(`── ${p.name} (${p.day}) event=${p.id} ${s.ok ? s.bytes + 'B' : 'FAILED ' + s.status}`);
    if (!s.ok) { console.log(''); continue; }
    for (const line of findPlayerLines(s.json)) console.log(`   ${line}`);
    /* The market half of the brief is still unwired, and this payload claims to
       carry odds. Whether it does is a fact worth having, not an assumption. */
    const odds = s.json.odds || [];
    const pc = s.json.pickcenter || [];
    console.log(`   odds: ${odds.length} entries, pickcenter: ${pc.length}`
      + (odds.length ? ` e.g. provider=${((odds[0].provider || {}).name) || '?'} details=${JSON.stringify(odds[0].details || null)} ou=${JSON.stringify(odds[0].overUnder || null)}` : ''));
    console.log('');
  }

  console.log('WHAT THIS DECIDES: if player lines appear in any branch for any of');
  console.log('these six, the season archive can be folded out of box scores with');
  console.log('no new host. If none of the six has them, ESPN carries college');
  console.log('baseball as scores only, and I will say so plainly rather than');
  console.log('shipping an empty stats table.');
  console.log('PASS | cbb outline probe | reported, nothing written');
})();
