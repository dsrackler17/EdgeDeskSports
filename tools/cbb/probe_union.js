#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — THE UNION WALK, PRICED AND PROVEN.

   The completeness probe settled the design question: sampling forty of the
   437 teams turned up a game on 2026-04-18 that the day scoreboard, with its
   eighty-one games, did not have — Louisville at California. A board built on
   the scoreboard alone would have been missing games while looking complete,
   which is the one failure mode that matters for "all the games".

   So the ingest has to walk every team's own schedule and union them. A game
   appears on both its teams' schedules, so the union cannot miss a game that
   either side knows about.

   Three things still have to be measured before that is written as a job:

     HOW MANY GAMES DOES IT ACTUALLY RECOVER? The scoreboard's count against
     the union's, on the same day, with the difference named.
     WHAT DOES IT COST? 437 requests is a real budget. If a daily refresh
     takes twenty minutes it needs a different shape than if it takes one.
     AND IS THE MARKET REALLY THERE? The brief is meant to carry captured
     odds. Nothing in this repository references a college baseball sport key,
     so before a market section is built, the signals table is asked directly
     — read-only, with the same publishable key the browser itself uses.

   WRITES NOTHING.
   =========================================================================== */
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const DAY = process.env.CBB_DAY || '2026-04-18';
const COMPACT = DAY.replace(/-/g, '');
const SEASON = DAY.slice(0, 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
      const text = await r.text(); clearTimeout(t);
      let j = null; try { j = JSON.parse(text); } catch (_) {}
      if (r.status === 200) return { status: 200, json: j };
      if (i === tries - 1) return { status: r.status, json: j };
    } catch (e) { clearTimeout(t); if (i === tries - 1) return { status: 0, json: null, error: String(e && e.message || e) }; }
    await sleep(500 * (i + 1));
  }
  return { status: 0, json: null };
}

(async function main() {
  console.log(`college baseball UNION WALK — ${DAY}\n`);

  /* ── the scoreboard's answer, for comparison ─────────────────────────── */
  const sb = await get(`${ESPN}/scoreboard?dates=${COMPACT}&limit=1000`);
  const sbIds = new Set(((sb.json || {}).events || []).map((e) => String(e.id)));
  console.log(`scoreboard: ${sbIds.size} games`);

  /* ── every team, its own schedule ────────────────────────────────────── */
  const tr = await get(`${ESPN}/teams?limit=1000`);
  const teams = (((((tr.json || {}).sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
  const ids = teams.map((t) => t.team && t.team.id).filter(Boolean);
  console.log(`walking ${ids.length} team schedules for season ${SEASON} ...`);

  const t0 = Date.now();
  const union = new Map();            // event id -> minimal row
  let answered = 0, failed = 0, totalRows = 0, emptySchedules = 0;
  const perTeamGames = [];

  for (const id of ids) {
    const r = await get(`${ESPN}/teams/${id}/schedule?season=${SEASON}`, 2);
    if (r.status !== 200 || !r.json) { failed++; continue; }
    answered++;
    const events = r.json.events || [];
    if (!events.length) emptySchedules++;
    perTeamGames.push(events.length);
    for (const ev of events) {
      totalRows++;
      if (String(ev.date || '').slice(0, 10) !== DAY) continue;
      if (!union.has(String(ev.id))) {
        const c = (ev.competitions || [])[0] || {};
        const cs = c.competitors || [];
        const home = cs.find((x) => x.homeAway === 'home') || {};
        const away = cs.find((x) => x.homeAway === 'away') || {};
        union.set(String(ev.id), {
          id: ev.id, date: ev.date,
          away: (away.team || {}).displayName, home: (home.team || {}).displayName,
          venue: (c.venue || {}).fullName || null,
          state: ((ev.status || c.status || {}).type || {}).state || null,
          neutral: c.neutralSite === true, conf: c.conferenceCompetition === true,
        });
      }
    }
    await sleep(120);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  perTeamGames.sort((a, b) => a - b);
  const med = perTeamGames.length ? perTeamGames[Math.floor(perTeamGames.length / 2)] : 0;
  console.log(`  answered ${answered}, failed ${failed}, empty schedules ${emptySchedules}`);
  console.log(`  ${totalRows} schedule rows seen, median ${med} games per team`);
  console.log(`  walk took ${secs}s\n`);

  const extra = [...union.keys()].filter((k) => !sbIds.has(k));
  const missingFromUnion = [...sbIds].filter((k) => !union.has(k));
  console.log(`UNION for ${DAY}: ${union.size} games`);
  console.log(`  found by the walk but NOT on the scoreboard: ${extra.length}`);
  extra.slice(0, 8).forEach((k) => {
    const g = union.get(k); console.log(`    - ${g.away} at ${g.home}${g.neutral ? ' (neutral)' : ''}`);
  });
  console.log(`  on the scoreboard but NOT in the walk: ${missingFromUnion.length}`);
  if (sbIds.size) {
    const gain = Math.round(((union.size - sbIds.size) / sbIds.size) * 1000) / 10;
    console.log(`  the walk carries ${gain >= 0 ? '+' : ''}${gain}% more games than the scoreboard\n`);
  }

  /* ── is college baseball actually in the odds feed? ───────────────────
     Read-only, publishable key, the same read the browser makes. */
  console.log('market: is a college baseball sport key captured at all?');
  const SB_URL = process.env.CBB_SB_URL || '';
  const SB_KEY = process.env.CBB_SB_KEY || '';
  if (!SB_URL || !SB_KEY) {
    console.log('  (no url/key supplied to this step — skipped, not answered)');
  } else {
    for (const key of ['baseball_ncaa', 'baseball_mlb', 'americanfootball_ncaaf']) {
      const r = await fetch(`${SB_URL}/rest/v1/signals?select=sport_key&sport_key=eq.${key}&limit=1`,
        { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } })
        .then(async (x) => ({ s: x.status, b: await x.text() })).catch((e) => ({ s: 0, b: String(e.message) }));
      let n = '?'; try { n = JSON.parse(r.b).length; } catch (_) {}
      console.log(`  ${key.padEnd(24)} HTTP ${r.s}  rows returned: ${n}`);
    }
    console.log('  a zero here means the brief must NOT promise a market for this sport.');
  }
  console.log('\nPASS | college baseball union walk | measured');
})().catch((e) => { console.log('FAIL | college baseball union walk | ' + (e && e.stack || e)); process.exit(1); });
