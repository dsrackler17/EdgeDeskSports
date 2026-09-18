#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL STATS — ASK THE HOST THAT ALREADY ANSWERS

   The first stats probe ruled out nearly everything, and its most useful
   result was an embarrassment: I went looking for exotic sources while never
   asking the one host that already serves this project 5,500 games a season.

   What the first probe established, so it is not re-litigated here:
     - data.ncaa.com 404s for BOTH sport slugs, "baseball" and "baseball-men".
       My correction of the slug was itself wrong; that feed is not there.
     - stats.ncaa.org returns 403 "Access Denied" to a datacenter address. The
       collegebaseball package SAYS SO IN ITS OWN SOURCE ("403 Error: NCAA
       blocked request"), so both Python packages that wrap it are dead ends
       from CI no matter how well written they are.
     - the collegebaseball package ships lookups and games through 2021, not
       current-season stats.
     - FanGraphs' college page answers with tables, but it is a rendered page,
       not a feed.

   So: ESPN. It serves this project's games board already, which means its
   pacing, its shapes and its team ids are known quantities. Two questions:

     1. Does it publish SEASON stats, per team and per player?
     2. If not, does it publish BOX SCORES? Because 5,500 game ids that each
        carry a box score can be aggregated into season lines, and that path
        needs no new host at all.

   Question 2 is the one that decides whether this is buildable, so it is
   asked even if question 1 succeeds. WRITES NOTHING.
   =========================================================================== */
'use strict';

const UA = 'Mozilla/5.0 (compatible; EdgeDeskSports/1.0; +https://edgedesksports.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(label, url, shape) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json,text/html' } });
    const body = await r.text();
    clearTimeout(t);
    let note = '';
    if (shape) { try { note = shape(body); } catch (e) { note = 'shape threw: ' + e.message; } }
    console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(Date.now() - t0).padStart(5)}ms  ${String(body.length).padStart(8)}B  ${label}`);
    console.log(`        ${url}`);
    if (note) for (const line of String(note).split('\n')) console.log(`        ${line}`);
    console.log('');
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    clearTimeout(t);
    console.log(`FAIL    -    ${String(Date.now() - t0).padStart(5)}ms         -  ${label}`);
    console.log(`        ${url}`);
    console.log(`        error: ${String((e && e.message) || e)}`);
    console.log('');
    return { ok: false, status: 0, body: '' };
  }
}

/* ---- shapes: say what a payload CARRIES, not that it parsed ---- */

/* ESPN's statistics payloads nest categories that each hold either a stats
   array or an athletes/teams array. Walk it generically rather than assuming
   one of the several shapes ESPN uses across sports. */
function statShape(body) {
  const j = JSON.parse(body);
  const out = [];
  const cats = (j.categories) || (j.stats && j.stats.categories) || (j.athletes) || null;
  out.push(`top keys: ${Object.keys(j).slice(0, 10).join(',')}`);
  if (Array.isArray(j.categories)) {
    for (const c of j.categories.slice(0, 4)) {
      const n = (c.leaders || c.athletes || c.teams || c.stats || []).length;
      out.push(`category ${c.name || c.displayName}: ${n} entries, labels=${(c.labels || c.names || []).slice(0, 8).join('/')}`);
    }
  }
  const ath = j.athletes || (j.stats && j.stats.athletes);
  if (Array.isArray(ath) && ath.length) {
    const a = ath[0];
    out.push(`athletes: ${ath.length}; first=${(a.athlete && (a.athlete.displayName || a.athlete.fullName)) || a.displayName || '?'}`);
    const cat = (a.categories && a.categories[0]) || null;
    if (cat) out.push(`  first category ${cat.name}: ${(cat.values || cat.totals || []).slice(0, 10).join(', ')}`);
  }
  const teams = j.teams || (j.stats && j.stats.teams);
  if (Array.isArray(teams) && teams.length) out.push(`teams: ${teams.length}; first=${(teams[0].team && teams[0].team.displayName) || '?'}`);
  if (Array.isArray(j.items)) out.push(`items: ${j.items.length} (a core-API reference list)`);
  if (typeof j.count === 'number') out.push(`count=${j.count} pageCount=${j.pageCount}`);
  if (!cats && !Array.isArray(j.items) && !teams) out.push('no categories, items or teams — 200 but empty of stats');
  return out.join('\n');
}

/* A box score is only useful if it carries PER-PLAYER lines with labels. */
function boxShape(body) {
  const j = JSON.parse(body);
  const out = [`top keys: ${Object.keys(j).slice(0, 12).join(',')}`];
  const bs = j.boxscore || {};
  out.push(`boxscore.teams=${(bs.teams || []).length} boxscore.players=${(bs.players || []).length}`);
  const p0 = (bs.players || [])[0];
  if (p0) {
    out.push(`first side: ${(p0.team && p0.team.displayName) || '?'}; statistic groups=${(p0.statistics || []).length}`);
    for (const g of (p0.statistics || []).slice(0, 3)) {
      const ath = g.athletes || [];
      out.push(`  group "${g.name || g.type}": ${ath.length} players, labels=${(g.labels || []).join('/')}`);
      if (ath[0]) out.push(`    e.g. ${(ath[0].athlete && ath[0].athlete.displayName) || '?'} -> ${(ath[0].stats || []).join(', ')}`);
    }
  } else {
    out.push('NO PER-PLAYER BLOCK — a summary without a box score cannot be aggregated');
  }
  const tm = (bs.teams || [])[0];
  if (tm) out.push(`team block: ${(tm.team && tm.team.displayName) || '?'} statistics=${(tm.statistics || []).length}`);
  return out.join('\n');
}

const htmlShape = (body) => {
  const title = (body.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
  const apis = Array.from(new Set((body.match(/\/api\/[a-z0-9/_-]{3,60}/gi) || []))).slice(0, 12);
  return `HTML title="${title.trim()}" tables=${(body.match(/<table/gi) || []).length}\n`
    + `api paths in page: ${apis.length ? apis.join(' ') : 'none'}`;
};

const S = '2026';   /* the most recent COMPLETED college season */
const CORE = 'https://sports.core.api.espn.com/v2/sports/baseball/leagues/college-baseball';
const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/baseball/college-baseball';
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const TEAM = '258';          /* Louisville — a programme that played a full season */
const EVENT = '401849995';   /* Penn State at West Virginia, 2026-04-15, final */

(async function main() {
  console.log('college baseball stats — asking the host that already serves the games\n');
  console.log(`season ${S}, team ${TEAM}, event ${EVENT}\n`);

  console.log('── 1. season stats, league-wide ─────────────────────────────────────\n');
  await ask('ESPN byteam season stats', `${WEB}/statistics/byteam?region=us&lang=en&contentorigin=espn&season=${S}&seasontype=2&limit=500`, statShape);
  await sleep(700);
  await ask('ESPN byathlete season stats', `${WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&season=${S}&seasontype=2&limit=100`, statShape);
  await sleep(700);
  await ask('ESPN league statistics (core)', `${CORE}/seasons/${S}/types/2/statistics?limit=500`, statShape);
  await sleep(700);

  console.log('── 2. season stats, one team ────────────────────────────────────────\n');
  await ask('ESPN team season statistics (web v3)', `${WEB}/teams/${TEAM}/statistics?season=${S}`, statShape);
  await sleep(700);
  await ask('ESPN team season statistics (core)', `${CORE}/seasons/${S}/types/2/teams/${TEAM}/statistics`, statShape);
  await sleep(700);
  await ask('ESPN team roster with stats', `${SITE}/teams/${TEAM}/roster?season=${S}`, statShape);
  await sleep(700);

  console.log('── 3. standings — records and conference position ───────────────────\n');
  await ask('ESPN standings', `${SITE}/standings?season=${S}`, statShape);
  await sleep(700);
  await ask('ESPN standings (core, by group)', `${CORE}/seasons/${S}/types/2/groups/100/standings?limit=200`, statShape);
  await sleep(700);

  console.log('── 4. THE FALLBACK THAT NEEDS NO NEW HOST: box scores ───────────────\n');
  await ask('ESPN game summary / box score', `${SITE}/summary?event=${EVENT}`, boxShape);
  await sleep(700);

  console.log('── 5. FanGraphs: is there a feed behind the page? ───────────────────\n');
  await ask('FanGraphs college leaderboard (look for api paths)', 'https://www.fangraphs.com/leaders/college', htmlShape);
  await sleep(700);
  await ask('FanGraphs college data api (a guess, labelled as one)', 'https://www.fangraphs.com/api/leaders/college/data?pos=all&stats=bat&season=2026&team=0&players=0', (b) => {
    const j = JSON.parse(b);
    return Array.isArray(j) ? `ARRAY of ${j.length}; first keys: ${Object.keys(j[0] || {}).slice(0, 12).join(',')}` : `JSON keys: ${Object.keys(j).slice(0, 12).join(',')}`;
  });
  await sleep(700);

  console.log('── 6. what the collegebaseball package actually ships ───────────────\n');
  await ask('collegebaseball data dir, in full', 'https://api.github.com/repos/nathanblumenfeld/collegebaseball/contents/collegebaseball/data', (b) => {
    const j = JSON.parse(b);
    if (!Array.isArray(j)) return 'not a listing: ' + (j.message || '?');
    return j.map((e) => `${e.name} (${Math.round((e.size || 0) / 1024)}kB)`).join('\n');
  });

  console.log('');
  console.log('WHAT COUNTS AS AN ANSWER: per-player or per-team season lines with');
  console.log('labels, or a box score carrying per-player lines. A 200 with no');
  console.log('entries is a refusal wearing a success code.');
  console.log('PASS | cbb espn stats probe | reported, nothing written');
})();
