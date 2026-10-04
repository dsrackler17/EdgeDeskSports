#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL — WHICH STATS SOURCE ACTUALLY ANSWERS?

   The board and brief currently carry team records folded out of the game log,
   which is real but thin: no batting lines, no ERAs, no player anything. The
   candidates for fixing that are the NCAA's own stats site, the NCAA's JSON
   feed, FanGraphs' college section, and two open-source packages that wrap the
   first one.

   Every one of those hosts is refused by this author's egress policy, so this
   asks a runner. It WRITES NOTHING.

   ONE THING WORTH CHECKING FIRST: an earlier probe asked data.ncaa.com for
   .../baseball/d1/... and got a 404. NCAA's own slug for the sport is
   "baseball-men", and a 404 from a guessed path says nothing about whether the
   feed exists. That mistake is corrected here rather than repeated.
   =========================================================================== */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (compatible; EdgeDeskSports/1.0; +https://edgedesksports.com)';

async function ask(label, url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({ 'user-agent': UA, accept: opts.accept || 'application/json,text/html' }, opts.headers || {}),
    });
    const body = await r.text();
    clearTimeout(t);
    const ms = Date.now() - t0;
    let note = '';
    if (opts.shape) { try { note = opts.shape(body); } catch (e) { note = 'shape threw: ' + e.message; } }
    console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(ms).padStart(5)}ms  ${String(body.length).padStart(8)}B  ${label}`);
    console.log(`        ${url}`);
    if (note) console.log(`        ${note}`);
    console.log('');
    return { ok: r.ok, status: r.status, body, bytes: body.length };
  } catch (e) {
    clearTimeout(t);
    console.log(`FAIL    -    ${String(Date.now() - t0).padStart(5)}ms         -  ${label}`);
    console.log(`        ${url}`);
    console.log(`        error: ${String(e && e.message || e)}`);
    console.log('');
    return { ok: false, status: 0, body: '', bytes: 0 };
  }
}

const jsonShape = (body) => {
  const j = JSON.parse(body);
  const keys = Object.keys(j).slice(0, 8);
  let extra = '';
  if (Array.isArray(j.games)) extra = ` games=${j.games.length}`;
  if (Array.isArray(j.data)) extra = ` data=${j.data.length}`;
  return `JSON keys: ${keys.join(',')}${extra}`;
};
const htmlShape = (body) => {
  const tables = (body.match(/<table/gi) || []).length;
  const title = (body.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
  const rows = (body.match(/<tr[\s>]/gi) || []).length;
  return `HTML title="${title.trim()}" tables=${tables} rows=${rows}`;
};

(async function main() {
  console.log('college baseball STATS SOURCE probe — who answers, and with what?\n');

  console.log('── 1. NCAA\'s own JSON feed, with the slug it actually uses ──────────\n');
  /* the earlier 404 used "baseball"; NCAA's slug is "baseball-men" */
  await ask('data.ncaa.com scoreboard, slug baseball-men',
    'https://data.ncaa.com/casablanca/scoreboard/baseball-men/d1/2026/04/15/scoreboard.json', { shape: jsonShape });
  await sleep(400);
  await ask('data.ncaa.com scoreboard, slug baseball (the earlier guess)',
    'https://data.ncaa.com/casablanca/scoreboard/baseball/d1/2026/04/15/scoreboard.json', { shape: jsonShape });
  await sleep(400);

  console.log('── 2. stats.ncaa.org — the site both Python packages wrap ───────────\n');
  const ncaaTeam = await ask('stats.ncaa.org team season stats (a D1 programme)',
    'https://stats.ncaa.org/teams/585290/season_to_date_stats', { accept: 'text/html', shape: htmlShape });
  await sleep(600);
  await ask('stats.ncaa.org rankings landing',
    'https://stats.ncaa.org/rankings/institution_trends', { accept: 'text/html', shape: htmlShape });
  await sleep(600);
  await ask('stats.ncaa.org team history',
    'https://stats.ncaa.org/teams/history/MBA/30123', { accept: 'text/html', shape: htmlShape });
  await sleep(600);

  console.log('── 3. the open-source packages: do they ship DATA or only code? ─────\n');
  /* raw.githubusercontent is the one host the author CAN reach, so a package
     that ships CSVs would be usable from anywhere and need no scraping */
  for (const [label, url] of [
    ['collegebaseball (Blumenfeld) package data dir',
      'https://api.github.com/repos/nathanblumenfeld/collegebaseball/contents/collegebaseball/data'],
    ['ncaa_bbStats repo root',
      'https://api.github.com/repos/dwillia2/ncaa_bbStats/contents/'],
  ]) {
    await ask(label, url, { shape: (b) => {
      const j = JSON.parse(b);
      if (!Array.isArray(j)) return 'not a listing: ' + String(j.message || '').slice(0, 80);
      const csvs = j.filter((f) => /\.(csv|parquet|json)$/i.test(f.name));
      return `${j.length} entries, ${csvs.length} data files` +
        (csvs.length ? ': ' + csvs.slice(0, 5).map((f) => `${f.name} (${Math.round(f.size / 1024)}kB)`).join(', ') : '');
    } });
    await sleep(400);
  }

  console.log('── 4. FanGraphs college — is there a callable endpoint at all? ──────\n');
  await ask('FanGraphs college leaderboard page',
    'https://www.fangraphs.com/leaders/college', { accept: 'text/html', shape: htmlShape });

  console.log('\nWhat matters: a source that answers 200 AND carries per-team or per-player');
  console.log('season lines. A 200 on a landing page with no table is not a data source.');
  console.log('PASS | cbb stats source probe | reported, nothing written');
})().catch((e) => { console.log('FAIL | cbb stats source probe | ' + (e && e.stack || e)); process.exit(1); });
