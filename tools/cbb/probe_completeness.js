#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — CAN WE GET ALL THE GAMES, AND IS THE SOURCE STEADY?

   The coverage probe found three things that have to be settled before an
   ingest is designed, because each of them decides part of its shape.

   1. ONE WEEK OF SCOREBOARD SHOWED 228 OF 437 TEAMS. Either half the field
      did not play, or the day scoreboard is not the whole card. If it is not,
      the fix is to walk each team's own schedule and take the union: a game
      appears on both its teams' schedules, so the union cannot miss one that
      either side knows about.

   2. THE SAME URL RETURNED 81 EVENTS AND THEN 0, SECONDS APART. That is the
      most dangerous finding in the set. A refresh that treats an empty answer
      as "no games today" would delete a full card. Any ingest built here has
      to be able to tell an empty day from an empty answer, so the rate at
      which the source lies has to be measured, not assumed.

   3. THE LEAGUE CALLS ITSELF season 2026, type Preseason, IN SEPTEMBER 2026.
      Which season a date belongs to is not obvious, and fetching the wrong
      one silently returns nothing.

   WRITES NOTHING.

   Run: node tools/cbb/probe_completeness.js
   =========================================================================== */
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      const text = await r.text();
      clearTimeout(t);
      let j = null; try { j = JSON.parse(text); } catch (_) { /* not json */ }
      return { status: r.status, json: j, bytes: text.length };
    } catch (e) { clearTimeout(t); if (i === tries - 1) return { status: 0, json: null, error: String(e && e.message || e) }; }
    await sleep(400 * (i + 1));
  }
  return { status: 0, json: null };
}
const evs = (j) => ((j && j.events) || []);

(async function main() {
  console.log('college baseball COMPLETENESS probe\n');

  /* ══ 1. HOW OFTEN DOES THE SAME QUESTION GET A DIFFERENT ANSWER? ════════
     Twelve identical requests, politely spaced. Anything other than twelve
     identical counts means the ingest must never trust a single answer. */
  console.log('1. steadiness — the same URL, twelve times, 600ms apart:');
  const counts = [];
  for (let i = 0; i < 12; i++) {
    const r = await get(`${ESPN}/scoreboard?dates=20260418&limit=1000`, 1);
    counts.push(r.status === 200 ? evs(r.json).length : `HTTP${r.status}`);
    await sleep(600);
  }
  console.log('   counts: ' + counts.join(', '));
  const nums = counts.filter((c) => typeof c === 'number');
  const best = Math.max(...nums, 0);
  const empties = nums.filter((n) => n === 0).length;
  console.log(`   best=${best}  empty answers=${empties}/${counts.length}`);
  console.log(empties
    ? '   => THE SOURCE LIES INTERMITTENTLY. An empty answer is not an empty day.\n'
    : '   => steady across this sample.\n');

  /* ══ 2. WHICH SEASON DOES A DATE BELONG TO? ════════════════════════════ */
  console.log('2. season labelling:');
  for (const q of ['?dates=20260418&limit=5', '?dates=20250419&limit=5', '?limit=5']) {
    const r = await get(`${ESPN}/scoreboard${q}`);
    const lg = ((r.json || {}).leagues || [])[0] || {};
    const s = lg.season || {};
    console.log(`   ${q.padEnd(30)} -> season ${s.year} (${(s.type || {}).name || '?'}), ${evs(r.json).length} events`);
  }
  console.log('');

  /* ══ 3. DOES A TEAM'S OWN SCHEDULE KNOW MORE THAN THE SCOREBOARD? ══════
     Take one day. Collect the scoreboard's games. Then ask a sample of teams
     for their schedules and count games on that same day that the scoreboard
     never mentioned. One is enough to disqualify the scoreboard as "all". */
  console.log('3. per-team schedules vs the day scoreboard (2026-04-18):');
  const sb = await get(`${ESPN}/scoreboard?dates=20260418&limit=1000`);
  const sbIds = new Set(evs(sb.json).map((e) => String(e.id)));
  console.log(`   scoreboard knows ${sbIds.size} games that day`);

  const teamsRes = await get(`${ESPN}/teams?limit=1000`);
  const allTeams = ((((teamsRes.json || {}).sports || [])[0] || {}).leagues || [])[0];
  const teams = ((allTeams || {}).teams || []).map((t) => t.team).filter(Boolean);
  console.log(`   team list: ${teams.length} teams`);

  /* a deterministic spread across the alphabet rather than the first N */
  const sample = [];
  const step = Math.max(1, Math.floor(teams.length / 40));
  for (let i = 0; i < teams.length && sample.length < 40; i += step) sample.push(teams[i]);

  let extra = 0, sched200 = 0, schedGames = 0;
  const unseen = [];
  for (const t of sample) {
    const r = await get(`${ESPN}/teams/${t.id}/schedule?season=2026`);
    if (r.status !== 200 || !r.json) continue;
    sched200++;
    for (const ev of (r.json.events || [])) {
      schedGames++;
      const d = String(ev.date || '').slice(0, 10);
      if (d !== '2026-04-18') continue;
      if (!sbIds.has(String(ev.id))) {
        extra++;
        if (unseen.length < 5) unseen.push(`${t.displayName}: ${ev.id} ${ev.name || ''}`.slice(0, 90));
      }
    }
    await sleep(150);
  }
  console.log(`   ${sched200}/${sample.length} sampled teams answered a schedule (${schedGames} games total)`);
  console.log(`   games on 2026-04-18 found via team schedules but ABSENT from the scoreboard: ${extra}`);
  unseen.forEach((u) => console.log(`     - ${u}`));
  console.log('');

  /* ══ VERDICT ══════════════════════════════════════════════════════════ */
  if (extra > 0) {
    console.log('VERDICT: the day scoreboard is NOT the whole card. Team schedules see games it');
    console.log('does not, so the ingest must walk teams and union their schedules.');
  } else if (sched200 === 0) {
    console.log('VERDICT: no team schedule answered; the scoreboard is the only way in and its');
    console.log('completeness is still unproven. Do not promise "all the games" yet.');
  } else {
    console.log('VERDICT: team schedules agreed with the scoreboard on this day — the scoreboard');
    console.log('looks like the whole card, and the low team count is teams that did not play.');
  }
  console.log('PASS | college baseball completeness | measured, not assumed');
})().catch((e) => { console.log('FAIL | college baseball completeness | ' + (e && e.stack || e)); process.exit(1); });
