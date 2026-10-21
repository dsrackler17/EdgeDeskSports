#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The collegiate collector, offline: every rule about reading a school's site
   (collegiate/polite.js) against a fake web.

   Run: node tools/collegiate/collegiate.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } };

const P = R('collegiate/polite.js');

/* a fake web: { 'https://host/path': { status, body, headers } }, and every request it saw */
function web(pages) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, ua: init && init.headers && init.headers['user-agent'] });
    const p = pages[url];
    if (!p) return new Response('nope', { status: 404 });
    return new Response(p.body == null ? '' : p.body, { status: p.status || 200, headers: p.headers || {} });
  };
  return { fetchImpl, seen };
}
function polite(pages, hosts, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collegiate-'));
  let t = Date.parse('2026-10-21T12:00:00Z'); const slept = [];
  const w = web(pages);
  const c = P.createPolite(Object.assign({ hosts, cacheDir: path.join(dir, 'cache'), refusalsPath: path.join(dir, 'refusals.jsonl'), fetchImpl: w.fetchImpl,
    now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, perHost: { minIntervalMs: 0 } }, extra || {}));
  return { c, w, dir, slept };
}

(async () => {
  /* 1. robots.txt, RFC 9309 */
  const rb = P.parseRobots('User-agent: *\nDisallow: /stats/\nAllow: /stats/public\nCrawl-delay: 3\n');
  ok('robots: the longest match wins (Allow /stats/public inside Disallow /stats/)', !rb.allows('/stats/x') && rb.allows('/stats/public/1') && rb.allows('/sports/baseball/roster'));
  ok('robots: Crawl-delay is read in seconds', rb.crawlDelayMs === 3000);
  const own = P.parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: EdgeDeskBot\nAllow: /sports/\nDisallow: /');
  ok('robots: our own group replaces the * group', own.allows('/sports/baseball/schedule') && !own.allows('/news'));
  ok('robots: an empty file allows everything; a wildcard and $ anchor work', P.parseRobots('').allows('/a') && !P.parseRobots('User-agent: *\nDisallow: /*.pdf$').allows('/x/y.pdf') && P.parseRobots('User-agent: *\nDisallow: /*.pdf$').allows('/x/y.pdf?a'));

  /* 2. reading a page */
  {
    const t = polite({ 'https://school.edu/robots.txt': { body: 'User-agent: *\nDisallow: /admin\n' }, 'https://school.edu/sports/baseball/roster': { body: '<html>roster</html>' } }, ['school.edu']);
    const r = await t.c.get('https://school.edu/sports/baseball/roster');
    ok('get: an allowed page is read, as EdgeDeskBot', r.ok && r.text() === '<html>roster</html>' && t.w.seen.every((s) => s.ua === P.UA), t.w.seen);
    const d = await t.c.get('https://school.edu/admin/x');
    ok('get: a disallowed page is never requested, and the host is recorded as refusing', d.refused && d.error.code === 'ROBOTS_DISALLOW' && !t.w.seen.some((s) => /admin/.test(s.url)) && t.c.refusedHost('school.edu'));
    const again = await t.c.get('https://school.edu/sports/baseball/roster');
    ok('get: after a refusal the host is left alone', again.refused && again.error.code === 'REFUSED_BEFORE');
    const persisted = fs.readFileSync(path.join(t.dir, 'refusals.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    ok('get: the refusal is written down with its reason', persisted.length === 1 && persisted[0].host === 'school.edu' && /disallows/.test(persisted[0].why));
  }
  {
    const t = polite({ 'https://other.com/x': { body: 'x' } }, ['school.edu']);
    const r = await t.c.get('https://other.com/x');
    ok('get: an unregistered host is refused without a request', r.refused && r.error.code === 'UNREGISTERED' && t.w.seen.length === 0);
  }
  {
    const t = polite({ 'https://a.edu/p': { body: 'p' } }, ['a.edu']);   /* robots.txt 404 */
    const r = await t.c.get('https://a.edu/p');
    ok('get: no robots.txt (404) allows the read', r.ok && r.text() === 'p');
  }
  {
    const t = polite({ 'https://b.edu/robots.txt': { status: 503 }, 'https://b.edu/p': { body: 'p' } }, ['b.edu']);
    const r = await t.c.get('https://b.edu/p');
    ok('get: a robots.txt that does not answer (5xx) keeps us out', r.refused && r.error.code === 'ROBOTS_UNREACHABLE' && !t.w.seen.some((s) => s.url === 'https://b.edu/p'));
  }
  {
    const t = polite({ 'https://c.edu/robots.txt': { status: 403 }, 'https://c.edu/p': { body: 'p' } }, ['c.edu']);
    const r = await t.c.get('https://c.edu/p');
    ok('get: a robots.txt refused to robots (403) keeps us out for good', r.refused && r.error.code === 'ROBOTS_FORBIDDEN' && t.c.refusedHost('c.edu'));
  }
  {
    const t = polite({ 'https://d.edu/robots.txt': { body: '' }, 'https://d.edu/p': { status: 403, body: 'no bots' } }, ['d.edu']);
    const r = await t.c.get('https://d.edu/p');
    ok('get: a page answered 403 is a refusal, recorded; nothing retries around it', r.refused && r.error.code === 'HTTP_403' && t.c.refusedHost('d.edu') && t.w.seen.filter((s) => s.url === 'https://d.edu/p').length === 1);
  }
  {
    const t = polite({ 'https://e.edu/robots.txt': { body: 'User-agent: *\nCrawl-delay: 4\n' }, 'https://e.edu/1': { body: '1' }, 'https://e.edu/2': { body: '2' } }, ['e.edu']);
    await t.c.get('https://e.edu/1'); await t.c.get('https://e.edu/2');
    ok('get: Crawl-delay spaces two reads of one host', t.slept.some((ms) => ms >= 4000), t.slept);
  }
  {
    const t = polite({ 'https://www.f.edu/robots.txt': { body: '' }, 'https://www.f.edu/p': { body: 'p' } }, ['f.edu']);
    const r = await t.c.get('https://www.f.edu/p');
    ok('get: a registered host is read with or without www', r.ok);
  }

  /* 3. the probe's helpers */
  const PR = R('collegiate/probe.js');
  ok('probe: a SIDEARM page is recognised by its markers, an unknown one is not guessed', PR.platformOf('<script src="https://x.sidearmsports.com/a.js">') === 'sidearm' && PR.platformOf('<html>plain</html>') === null);
  ok('probe: fixture names are stable and safe', PR.slug('https://a.edu/sports/baseball/roster') === 'sports_baseball_roster' && PR.slug('https://a.edu/') === 'home' && /^x_[0-9a-f]{8}$/.test(PR.slug('https://a.edu/x?y=1')));
  const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'collegiate/probe/targets.json'), 'utf8'));
  ok('probe: every target is an https URL or host, and the school list names no path', T.sources.every((s) => /^https:\/\//.test(s.url)) && T.schools.every((s) => /^[a-z0-9.-]+$/.test(s.host)) && T.paths.every((p) => p.startsWith('/')));

  console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' collegiate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
