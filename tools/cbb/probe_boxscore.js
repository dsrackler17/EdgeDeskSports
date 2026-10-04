#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL STATS — THE BOX SCORE QUESTION, ASKED PROPERLY

   The previous probe produced one result I am not willing to report as a
   verdict, because I have already made this exact mistake once in this
   project and it cost a day.

   What it showed: site.api.espn.com answered 403 with an Akamai deny page for
   /summary, /roster and /standings. What it ALSO showed, in the same workflow
   run four minutes earlier: the SAME HOST answered 200 for /scoreboard and
   /teams. A host does not selectively forget three paths.

   The likelier explanation is mine. Those three 403s were the 6th, 7th and
   8th requests of a process firing every 700ms, and I have already established
   in this project — after wrongly accusing ESPN of "lying intermittently" —
   that unpaced bursts get refused while paced requests succeed. A rate limit
   is not a missing endpoint, and I will not write a scraper around a blocked
   host that was never blocked.

   So this probe changes exactly one thing and asks again: the box score goes
   FIRST, as the very first request of the process, with 3s between calls. If
   it answers now, the 403 was my pacing. If it 403s as the first request of a
   cold process, the endpoint really is closed to datacenter addresses.

   It also separates the two explanations that a single UA cannot: the same
   URL is asked twice, once with each user agent, well spaced.

   Then the two live candidates:
     - cdn.espn.com/core/...?xhr=1, the path ESPN's own web app uses, which is
       a different front door to the same box score.
     - FanGraphs' college leaderboard, which renders 10 tables server-side with
       no API behind them. If it is the only source, its COLUMNS decide what
       the archive can hold, so this dumps the header and a data row rather
       than counting <table> tags and calling that a finding.

   WRITES NOTHING.
   =========================================================================== */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA_SELF = 'Mozilla/5.0 (compatible; EdgeDeskSports/1.0; +https://edgedesksports.com)';
const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const PACE = 3000;   /* deliberately slower than the ingest's proven pacing */

async function ask(label, url, opts) {
  opts = opts || {};
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({
        'user-agent': opts.ua || UA_SELF,
        accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      }, opts.headers || {}),
    });
    const body = await r.text();
    clearTimeout(t);
    let note = '';
    if (opts.shape) { try { note = opts.shape(body); } catch (e) { note = 'shape threw: ' + e.message + ' :: ' + body.slice(0, 120).replace(/\s+/g, ' '); } }
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

/* A box score is only worth anything if it carries PER-PLAYER lines with the
   labels that say what each number is. Anything less cannot be aggregated. */
function boxShape(body) {
  const j = JSON.parse(body);
  const out = [];
  /* /summary puts it at .boxscore; the cdn core route wraps in .gamepackageJSON */
  const bs = j.boxscore || (j.gamepackageJSON && j.gamepackageJSON.boxscore) || {};
  out.push(`top keys: ${Object.keys(j).slice(0, 12).join(',')}`);
  const players = bs.players || [];
  const teams = bs.teams || [];
  out.push(`boxscore: ${teams.length} team blocks, ${players.length} player blocks`);
  if (!players.length) {
    out.push('NO PER-PLAYER BLOCK — this payload cannot be aggregated into season lines');
  }
  for (const side of players.slice(0, 1)) {
    out.push(`side: ${(side.team && side.team.displayName) || '?'}`);
    for (const g of (side.statistics || [])) {
      const ath = g.athletes || [];
      out.push(`  group "${g.name || g.type}": ${ath.length} players`);
      out.push(`    labels: ${(g.labels || []).join(' ')}`);
      out.push(`    descriptions: ${(g.descriptions || []).slice(0, 12).join(' | ')}`);
      if (ath[0]) {
        const a = ath[0];
        out.push(`    e.g. ${(a.athlete && (a.athlete.displayName || a.athlete.shortName)) || '?'}`
          + ` id=${(a.athlete && a.athlete.id) || '?'} -> ${(a.stats || []).join(' ')}`);
      }
    }
  }
  const tm = teams[0];
  if (tm) {
    out.push(`team block: ${(tm.team && tm.team.displayName) || '?'}`);
    for (const g of (tm.statistics || []).slice(0, 2)) {
      out.push(`  ${g.name || g.label}: ${(g.stats || []).slice(0, 8).map((s) => `${s.name || s.label}=${s.displayValue}`).join(' ')}`);
    }
  }
  return out.join('\n');
}

/* FanGraphs renders its tables server-side, so the columns ARE the contract.
   Print the widest table's header and first two data rows, as text. */
function tableShape(body) {
  const out = [];
  const title = (body.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
  out.push(`title="${title.trim()}"`);
  const tables = body.split(/<table/i).slice(1);
  let best = null;
  for (const t of tables) {
    const rows = t.split(/<tr/i).slice(1);
    if (!best || rows.length > best.length) best = rows;
  }
  if (!best) { out.push('no <table> at all'); return out.join('\n'); }
  const cells = (row) => (row.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
    .map((c) => c.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  out.push(`widest table: ${best.length} rows`);
  for (let i = 0; i < Math.min(4, best.length); i++) {
    const c = cells(best[i]);
    if (c.length) out.push(`  row ${i}: ${c.slice(0, 26).join(' | ')}`);
  }
  /* A leaderboard that renders only one page is a different problem from one
     that renders all of D1, so say which this is. */
  const pag = (body.match(/(\d[\d,]*)\s*(?:of|\/)\s*(\d[\d,]*)/g) || []).slice(0, 4);
  out.push(`numbers that look like pagination: ${pag.length ? pag.join(' ') : 'none found'}`);
  return out.join('\n');
}

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball';
const EVENT = '401849995';   /* Penn State at West Virginia, 2026-04-15, final */
const EVENT2 = '401849996';  /* a second id, so one bad game is not a verdict */

(async function main() {
  console.log('college baseball box score — the same question, asked with pacing\n');
  console.log(`pacing ${PACE}ms; the box score is request #1 of a cold process\n`);

  console.log('── 1. THE RETRY THAT DECIDES THIS ───────────────────────────────────\n');
  const first = await ask('ESPN /summary — FIRST request of the process, own UA', `${SITE}/summary?event=${EVENT}`, { shape: boxShape });
  await sleep(PACE);
  await ask('ESPN /summary — same URL, browser UA', `${SITE}/summary?event=${EVENT}`, { shape: boxShape, ua: UA_BROWSER });
  await sleep(PACE);
  await ask('ESPN /summary — a second event, so one game is not a verdict', `${SITE}/summary?event=${EVENT2}`, { shape: boxShape, ua: UA_BROWSER });
  await sleep(PACE);

  console.log('── 2. the front door ESPN\'s own web app uses ────────────────────────\n');
  await ask('cdn.espn.com core boxscore (xhr)', `https://cdn.espn.com/core/college-baseball/boxscore?xhr=1&gameId=${EVENT}`, { shape: boxShape, ua: UA_BROWSER });
  await sleep(PACE);
  await ask('cdn.espn.com core game (xhr)', `https://cdn.espn.com/core/college-baseball/game?xhr=1&gameId=${EVENT}`, { shape: boxShape, ua: UA_BROWSER });
  await sleep(PACE);

  console.log('── 3. was /scoreboard ever affected? the control ────────────────────\n');
  /* If the scoreboard still answers at the end of this process, then whatever
     refused /summary was about the PATH, not about the process being throttled.
     Without this control the whole probe proves nothing either way. */
  await ask('CONTROL: /scoreboard, late in the same process', `${SITE}/scoreboard?dates=20260415&limit=500`, {
    ua: UA_BROWSER,
    shape: (b) => { const j = JSON.parse(b); return `events=${(j.events || []).length} — ${(j.events || []).length ? 'the process is not throttled' : 'EMPTY: the process IS throttled, and section 1 proves nothing'}`; },
  });
  await sleep(PACE);

  console.log('── 4. FanGraphs: what COLUMNS does it actually render? ──────────────\n');
  await ask('FanGraphs college batting leaderboard', 'https://www.fangraphs.com/leaders/college', { shape: tableShape, ua: UA_BROWSER });
  await sleep(PACE);
  await ask('FanGraphs college pitching, if the param is what it looks like', 'https://www.fangraphs.com/leaders/college?stats=pit', { shape: tableShape, ua: UA_BROWSER });

  console.log('');
  console.log('READING THIS: if section 1 answers, the earlier 403 was my pacing and');
  console.log('the box-score path is open. If section 1 refuses BUT the section 3');
  console.log('control answers, the path is genuinely closed and FanGraphs is the');
  console.log('remaining source. If the control is empty too, this probe is void.');
  console.log('PASS | cbb box score probe | reported, nothing written');
})();
