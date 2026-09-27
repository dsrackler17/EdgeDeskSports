#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — DOES A SOURCE ANSWER, AND WHAT SHAPE IS IT IN?

   This repository has a rule the tennis adapter taught it: correct-looking
   code against a provider that answers 403 from a GitHub runner is not a
   pipeline, it is a guess. mlb-pitchers.yml proves its source before it
   builds anything, and nothing should be built here on a source that has not
   answered from the machine that will have to call it every morning.

   It matters more than usual this time. The session that writes this code
   cannot reach ANY live sports host — site.api.espn.com, data.ncaa.com,
   stats.ncaa.org and statsapi.mlb.com are all refused by the egress policy
   with a 403 on CONNECT. So the author cannot see a single row. A runner can.

   This WRITES NOTHING. It asks each candidate for one in-season day of the
   completed 2026 season, reports what came back, and says plainly which
   endpoints could carry a games board and which could not.

   Run: node tools/cbb/probe_sources.js [--date 2026-04-15]
   =========================================================================== */
'use strict';

const argv = process.argv.slice(2);
const argAt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const DATE = argAt('--date') || '2026-04-15';        // a Wednesday in the 2026 season
const [Y, M, D] = DATE.split('-');
const COMPACT = `${Y}${M}${D}`;
const TIMEOUT = Number(argAt('--timeout') || 25000);

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const NCAA = 'https://data.ncaa.com/casablanca';

const CANDIDATES = [
  { key: 'espn_scoreboard', what: 'ESPN scoreboard for one day',
    url: `${ESPN}/scoreboard?dates=${COMPACT}&limit=500` },
  { key: 'espn_scoreboard_d1', what: 'ESPN scoreboard, D1 group filter',
    url: `${ESPN}/scoreboard?dates=${COMPACT}&groups=100&limit=500` },
  { key: 'espn_teams', what: 'ESPN team list',
    url: `${ESPN}/teams?limit=1000` },
  { key: 'ncaa_scoreboard', what: 'NCAA scoreboard for one day',
    url: `${NCAA}/scoreboard/baseball/d1/${Y}/${M}/${D}/scoreboard.json` },
];

async function ask(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'EdgeDeskSports/source-probe' },
    });
    const body = await r.text();
    clearTimeout(timer);
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, bytes: body.length, body };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, ms: Date.now() - t0, bytes: 0, error: String(e && e.message || e) };
  }
}

/* What a games board actually needs out of a payload: a stable game id, both
   sides named, a start time, and a state. Anything less is not a board. */
function shapeEspn(body) {
  let j; try { j = JSON.parse(body); } catch (e) { return { parsed: false, why: 'not JSON' }; }
  const events = j.events || [];
  const out = { parsed: true, events: events.length, usable: 0, sample: null, states: {} };
  for (const ev of events) {
    const c = (ev.competitions || [])[0] || {};
    const cs = c.competitors || [];
    const home = cs.find((x) => x.homeAway === 'home');
    const away = cs.find((x) => x.homeAway === 'away');
    const state = ((ev.status || {}).type || {}).state || '?';
    out.states[state] = (out.states[state] || 0) + 1;
    const usable = !!(ev.id && ev.date && home && away
      && (home.team || {}).displayName && (away.team || {}).displayName);
    if (usable) out.usable++;
    if (usable && !out.sample) {
      out.sample = {
        id: ev.id, start: ev.date, state,
        away: (away.team || {}).displayName, home: (home.team || {}).displayName,
        away_rank: away.curatedRank ? away.curatedRank.current : null,
        home_rank: home.curatedRank ? home.curatedRank.current : null,
        venue: ((c.venue || {}).fullName) || null,
        has_odds: Array.isArray(c.odds) && c.odds.length > 0,
        conference_competition: c.conferenceCompetition === true,
        notes: (ev.competitions || [])[0] && ((c.notes || [])[0] || {}).headline || null,
      };
    }
  }
  return out;
}
function shapeEspnTeams(body) {
  let j; try { j = JSON.parse(body); } catch (e) { return { parsed: false, why: 'not JSON' }; }
  const groups = ((j.sports || [])[0] || {}).leagues || [];
  const teams = (groups[0] || {}).teams || [];
  return {
    parsed: true, teams: teams.length,
    sample: teams.slice(0, 3).map((t) => ({
      id: (t.team || {}).id, name: (t.team || {}).displayName, abbr: (t.team || {}).abbreviation })),
  };
}
function shapeNcaa(body) {
  let j; try { j = JSON.parse(body); } catch (e) { return { parsed: false, why: 'not JSON' }; }
  const games = j.games || [];
  const first = (games[0] || {}).game || null;
  return {
    parsed: true, games: games.length,
    sample: first ? { id: first.gameID, start: first.startTimeEpoch || first.startTime,
      away: ((first.away || {}).names || {}).short, home: ((first.home || {}).names || {}).short,
      state: first.gameState } : null,
  };
}

(async function main() {
  console.log(`college baseball source probe — ${DATE} (a day inside the completed 2026 season)`);
  console.log('this writes nothing; it only asks whether a runner can see the games\n');
  const results = {};
  for (const c of CANDIDATES) {
    const r = await ask(c.url);
    let shape = null;
    if (r.ok && r.body) {
      shape = c.key === 'espn_teams' ? shapeEspnTeams(r.body)
        : c.key === 'ncaa_scoreboard' ? shapeNcaa(r.body)
        : shapeEspn(r.body);
    }
    results[c.key] = { status: r.status, ms: r.ms, bytes: r.bytes, error: r.error || null, shape };
    const head = `${r.ok ? ' ok ' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${String(r.bytes).padStart(8)}B`;
    console.log(`${head}  ${c.what}`);
    console.log(`        ${c.url}`);
    if (r.error) console.log(`        error: ${r.error}`);
    if (shape) console.log('        ' + JSON.stringify(shape));
    console.log('');
  }

  /* THE ONLY QUESTION THAT MATTERS: can something here carry a board? */
  const board = Object.entries(results).find(([k, v]) =>
    /scoreboard/.test(k) && v.shape && v.shape.parsed && (v.shape.usable > 0 || v.shape.games > 0));
  if (board) {
    console.log(`VERDICT: ${board[0]} can carry a games board for ${DATE}.`);
    console.log('PASS | college baseball source probe | a runner can see the games');
    process.exit(0);
  }
  console.log('VERDICT: no candidate returned a usable slate. A board cannot be built on these.');
  console.log('Nothing above is a reason to guess: report the blocked or empty source and stop.');
  console.log('FAIL | college baseball source probe | no source answered with a usable slate');
  process.exit(1);
})().catch((e) => { console.log('FAIL | college baseball source probe | ' + (e && e.stack || e)); process.exit(1); });
