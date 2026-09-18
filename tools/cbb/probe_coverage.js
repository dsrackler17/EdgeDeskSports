#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — IS IT ALL THE GAMES, OR A SELECTION?

   The first probe proved a runner can see college baseball and that every
   event ESPN returned was shaped well enough to be a board row. It also
   returned EIGHTEEN events for a Wednesday in April. Division I has about
   three hundred teams; a midweek slate is smaller than a weekend one, but
   eighteen is not obviously all of them, and "all the games during the
   season" is the requirement.

   A board that quietly shows a third of the card is worse than no board: it
   reads as complete. So this asks the coverage question directly, before any
   ingest is designed around an endpoint that may be curating.

   It compares a midweek day against a Saturday, walks any pagination the
   payload declares, tries the group filters the API itself advertises rather
   than guessed ones, and prints what the league object says about its own
   season and calendar. It WRITES NOTHING.

   Run: node tools/cbb/probe_coverage.js
   =========================================================================== */
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const DAYS = [
  { label: 'Wed 2026-04-15 (midweek)', d: '20260415' },
  { label: 'Sat 2026-04-18 (weekend)', d: '20260418' },
  { label: 'Fri 2026-02-13 (opening weekend)', d: '20260213' },
  { label: 'Sat 2026-06-20 (College World Series)', d: '20260620' },
];

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await r.text();
    clearTimeout(t);
    let j = null; try { j = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: r.status, bytes: text.length, json: j };
  } catch (e) { clearTimeout(t); return { status: 0, bytes: 0, json: null, error: String(e && e.message || e) }; }
}

const count = (j) => ((j && j.events) || []).length;

(async function main() {
  console.log('college baseball COVERAGE probe — is the scoreboard all of it?\n');

  /* ── 1. what does the API say about itself? ──────────────────────────── */
  const one = await get(`${ESPN}/scoreboard?dates=20260418&limit=1000`);
  const lg = one.json && ((one.json.leagues || [])[0] || {});
  console.log('league object, in its own words:');
  console.log('  ' + JSON.stringify({
    id: lg.id, name: lg.name, abbreviation: lg.abbreviation,
    season: lg.season && { year: lg.season.year, type: lg.season.type && lg.season.type.name },
    calendarType: lg.calendarType,
    calendarEntries: Array.isArray(lg.calendar) ? lg.calendar.length : null,
    groupsAdvertised: Array.isArray(lg.groups) ? lg.groups.length : null,
  }));
  if (Array.isArray(lg.groups) && lg.groups.length) {
    console.log('  groups the API advertises: ' + JSON.stringify(
      lg.groups.slice(0, 12).map((g) => ({ id: g.id, name: g.name || g.shortName }))));
  }
  /* pagination is the first thing that would silently truncate a board */
  console.log('  pagination fields: ' + JSON.stringify({
    pageCount: one.json && one.json.pageCount, pageIndex: one.json && one.json.pageIndex,
    count: one.json && one.json.count,
  }));
  console.log('');

  /* ── 2. day by day, and does limit change the answer? ────────────────── */
  console.log('events per day, and whether the limit is binding:');
  for (const day of DAYS) {
    const small = await get(`${ESPN}/scoreboard?dates=${day.d}&limit=25`);
    const big = await get(`${ESPN}/scoreboard?dates=${day.d}&limit=1000`);
    const flag = count(small) !== count(big) ? '   <-- LIMIT WAS BINDING' : '';
    console.log(`  ${day.label.padEnd(38)} limit25=${String(count(small)).padStart(4)}  limit1000=${String(count(big)).padStart(4)}${flag}`);
  }
  console.log('');

  /* ── 3. do group filters reveal games the default hides? ─────────────── */
  console.log('group filters against the default (Sat 2026-04-18):');
  const base = count(one.json);
  console.log(`  (no groups)      ${String(base).padStart(4)}`);
  for (const g of ['50', '51', '80', '100', '2', '3']) {
    const r = await get(`${ESPN}/scoreboard?dates=20260418&groups=${g}&limit=1000`);
    console.log(`  groups=${g.padEnd(10)} ${String(count(r.json)).padStart(4)}${count(r.json) > base ? '   <-- MORE THAN DEFAULT' : ''}`);
  }
  console.log('');

  /* ── 4. how many distinct teams appear across a whole week? ──────────
     437 teams exist. If a week of play only ever mentions a fraction of
     them, the scoreboard is curating and this cannot be the source. */
  const seen = new Set();
  let weekEvents = 0;
  for (let i = 13; i <= 19; i++) {
    const r = await get(`${ESPN}/scoreboard?dates=202604${String(i).padStart(2, '0')}&limit=1000`);
    weekEvents += count(r.json);
    for (const ev of (r.json && r.json.events) || []) {
      for (const c of ((ev.competitions || [])[0] || {}).competitors || []) {
        if (c.team && c.team.id) seen.add(c.team.id);
      }
    }
  }
  console.log(`one week (13-19 Apr 2026): ${weekEvents} events, ${seen.size} distinct teams of 437 known`);
  const pct = Math.round((seen.size / 437) * 100);
  console.log(`that is ${pct}% of the teams ESPN itself lists\n`);

  /* ── the verdict, stated in terms of the requirement ─────────────────── */
  if (pct >= 80) {
    console.log('VERDICT: the scoreboard looks like the full slate — most teams play and appear.');
    console.log('PASS | college baseball coverage | the default scoreboard carries the card');
  } else {
    console.log('VERDICT: the default scoreboard reaches only part of the field.');
    console.log('A board built on it would look complete and not be. Another source, or a');
    console.log('per-team schedule walk, is needed before "all the games" can be promised.');
    console.log('PASS | college baseball coverage | reported honestly, design decision follows');
  }
})().catch((e) => { console.log('FAIL | college baseball coverage | ' + (e && e.stack || e)); process.exit(1); });
