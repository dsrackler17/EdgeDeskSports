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
    let p = pages[url];
    if (p && p.seq) p = p.seq.length > 1 ? p.seq.shift() : p.seq[0];     /* answers in turn, the last one repeated */
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

  /* 4. a Nuxt page's own data (devalue) */
  const N = R('collegiate/nuxt.js');
  const flat = [{ a: 1, b: 2, c: 5, d: -1 }, ['Reactive', 3], ['Set', 4, 4], { x: 6 }, 'v', ['Map', 6, 4], 7];
  const un = N.unflatten(flat);
  ok('nuxt: indices, wrappers, sets, maps and constants are read back', un.a.x === 7 && un.b[0] === 'v' && un.c['7'] === 'v' && un.d === undefined && un.b.length === 2);
  ok('nuxt: a page with no data is null, never a guess', N.nuxtData('<html></html>') === null && N.nuxtData('<script id="__NUXT_DATA__">{oops</script>') === null);

  /* 5. the two platforms, on pages the probe read (collegiate/probe/fixtures) */
  const zlib = require('zlib');
  const FX = (f) => zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'collegiate/probe/fixtures', f + '.gz'))).toString('utf8');
  const PL = R('collegiate/platforms.js');
  const sa = PL.parseRoster(FX('texassports.com/sports_baseball_roster_2026'));
  ok('sidearm: a season\'s roster, its sport and season, and the seasons the site keeps', sa.platform === 'sidearm' && sa.sport === 'baseball' && sa.season === 2026 && sa.players.length === 41 && sa.seasons.length > 30 && sa.seasons.some((s) => s.season === 2014));
  const sa25 = PL.parseRoster(FX('texassports.com/sports_baseball_roster_2025'));
  const dup = sa.players.find((p) => sa25.players.some((q) => q.pid === p.pid));
  ok('sidearm: a player keeps one id across seasons, and moves up a class', !!dup && dup.class !== sa25.players.find((q) => q.pid === dup.pid).class, dup);
  ok('sidearm: every row has a name, a class, and bats/throws for baseball', sa.players.every((p) => p.name && p.pid) && sa.players.filter((p) => p.class).length >= 38 && sa.players.filter((p) => p.bats && p.throws).length >= 38);
  const fl = PL.parseRoster(FX('floridagators.com/sports_baseball_roster_2026'));
  ok('sidearm: a transfer\'s previous school is read as the school lists it', fl.players.some((p) => p.previous_school === 'Jacksonville'));
  const wm = PL.parseRoster(FX('gostanford.com/sports_baseball_roster_season_2026'));
  ok('wmt: a season\'s roster with hometown, high school and bats/throws', wm.platform === 'wmt' && wm.sport === 'baseball' && wm.season === 2026 && wm.players.length === 39 && wm.players.filter((p) => p.hometown && p.high_school).length >= 35 && wm.players.filter((p) => p.bats).length >= 35);
  const wbb = PL.parseRoster(FX('gostanford.com/sports_womens_basketball_roster_season_2025_26'));
  ok('wmt: a split-year season is keyed by its end year', wbb.sport === 'womens-basketball' && wbb.season_label === '2025-26' && wbb.season === 2026);
  ok('wmt: a roster published before its players are listed reads as empty, not as a guess', PL.parseRoster(FX('12thman.com/sports_baseball_roster')).players.length === 0);
  ok('platforms: nothing beyond the roster facts is kept', Object.keys(sa.players[0]).sort().join(',') === 'bats,class,class_raw,first,height_in,high_school,hometown,jersey,last,name,pid,pos,previous_school,redshirt,throws,weight');
  ok('seasons: labels and keys', PL.seasonKey('2025-26') === 2026 && PL.seasonKey('1999-2000') === 2000 && PL.seasonKey('2026') === 2026 && PL.seasonLabel('mens-basketball', 2027) === '2026-27' && PL.seasonLabel('baseball', 2026) === '2026');
  ok('classes: redshirts, graduates and abbreviations', PL.normClass('R-So.', null, null).class === 'SO' && PL.normClass('R-So.', null, null).redshirt && PL.normClass(null, '5th', null).class === 'GR' && PL.normClass('Gr.', 'Graduate Student', null).class === 'GR' && PL.normClass('', '', 3).class === 'JR');
  ok('bats/throws: read only from a field labelled so', PL.batsThrows({ 'B/T': 'L/R' }).bats === 'L' && PL.batsThrows({ 'B/T': 'B/R' }).bats === 'S' && PL.batsThrows({ Hometown: 'L/R' }).bats === null);

  /* 6. the registry from ncaa.com */
  const D = R('collegiate/directory.js');
  const idx = D.parseIndex(FX('ncaa.com/schools_index'));
  ok('directory: an index page lists 50 schools with their full names', idx.length === 50 && idx[0].id === 'abilene-christian' && idx[0].full_name === 'Abilene Christian University');
  const tx = D.parseSchool(FX('ncaa.com/schools_texas'));
  ok('directory: a school page names its conference and athletics site', tx.conference === 'Southeastern' && tx.nickname === 'Longhorns' && tx.host === 'texassports.com', tx);
  {
    const t = polite({ 'https://www.ncaa.com/robots.txt': { body: FX('ncaa.com/robots_txt') }, 'https://www.ncaa.com/schools-index': { body: FX('ncaa.com/schools_index') },
      'https://www.ncaa.com/schools-index/1': { body: '<table></table>' }, 'https://www.ncaa.com/schools/abilene-christian': { body: FX('ncaa.com/schools_texas').replace(/texassports\.com/g, 'acusports.com') },
      'https://www.ncaa.com/schools/academy-of-art': { body: FX('ncaa.com/schools_texas').replace(/texassports\.com/g, 'artu.edu') } }, ['ncaa.com']);
    const rec = path.join(t.dir, 'ts.csv');
    fs.writeFileSync(rec, 'season,team_id,season_team_id,name,conference_id,conference,division\n2025,2,9,Abilene Christian,1,WAC,1\n');
    const out = await D.build({ polite: t.c, out: path.join(t.dir, 'schools.json'), recordFile: rec, only: ['abilene-christian', 'academy-of-art'], log: false, today: '2026-10-21' });
    const s = out.schools.find((x) => x.id === 'abilene-christian'); const art = out.schools.find((x) => x.id === 'academy-of-art');
    ok('directory: build reads the index, then each school, and takes the division from our own record', out.counts.listed === 50 && out.schools.length === 2 && s.host === 'acusports.com' && s.division === 1 && s.division_source === 'our_record' && s.baseball_team_id === '2', out.counts);
    ok('directory: a school our record does not name takes its conference\'s division', art.division === 1 && art.division_source === 'conference' && art.baseball_team_id === null);
  }

  /* 7. roster snapshots from a fake web serving the probe's pages */
  const RO = R('collegiate/rosters.js');
  {
    const pages = {
      'https://texassports.com/robots.txt': { body: FX('texassports.com/robots_txt') },
      'https://texassports.com/sports/baseball/roster': { body: FX('texassports.com/sports_baseball_roster_2026') },
      'https://texassports.com/sports/baseball/roster/2025': { body: FX('texassports.com/sports_baseball_roster_2025') },
      'https://gostanford.com/robots.txt': { body: FX('gostanford.com/robots_txt') },
      'https://gostanford.com/sports/baseball/roster': { body: FX('gostanford.com/sports_baseball_roster_season_2026') },
      'https://gostanford.com/sports/baseball/roster/season/2025': { body: FX('gostanford.com/sports_baseball_roster_season_2025') },
      'https://plainsite.edu/robots.txt': { body: '' },
      'https://plainsite.edu/sports/baseball/roster': { body: '<html>a roster as plain HTML</html>' }
    };
    const schoolsList = [{ id: 'texas', host: 'texassports.com', division: 1 }, { id: 'stanford', host: 'gostanford.com', division: 1 }, { id: 'plain', host: 'plainsite.edu', division: 1 }, { id: 'd2', host: 'x.edu', division: 2 }];
    const t = polite(pages, ['texassports.com', 'gostanford.com', 'plainsite.edu']);
    const dataDir = path.join(t.dir, 'data');
    const run = await RO.collect({ polite: t.c, schoolsList, sports: ['baseball'], seasons: [2025, 2026], today: '2026-05-01', dataDir, log: false });
    const snap = (sch, s) => JSON.parse(fs.readFileSync(path.join(dataDir, 'rosters/baseball', String(s), sch + '.json'), 'utf8'));
    ok('rosters: each school\'s seasons are read and the platform learnt from the page', run.ok === 4 && run.schools === 3 && JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms.json'), 'utf8')).texas.platform === 'sidearm', run.misses);
    ok('rosters: a site we cannot read is recorded, not guessed', run.misses.length === 1 && run.misses[0].code === 'PLATFORM_NOT_READ' && run.misses[0].school === 'plain');
    ok('rosters: SIDEARM\'s 30 s crawl delay is honoured', t.slept.some((ms) => ms >= 29000));
    ok('rosters: a snapshot keeps the season and every player, first seen today', snap('texas', 2025).players.length === 41 && snap('stanford', 2026).players.every((p) => p.first_seen === '2026-05-01'));
    /* a week later one player is gone from the page */
    const html = FX('gostanford.com/sports_baseball_roster_season_2026');
    const gone = snap('stanford', 2026).players[0];
    const t2 = polite(pages, ['gostanford.com']);
    const parsed = PL.parseRoster(html);
    const lessOne = Object.assign({}, parsed, { players: parsed.players.filter((p) => p.pid !== gone.pid) });
    const merged = RO.mergeSnapshot(snap('stanford', 2026), lessOne, { school: 'stanford', host: 'gostanford.com', sport: 'baseball', season: 2026, url: 'u' }, '2026-05-08');
    const g = merged.players.find((p) => p.pid === gone.pid);
    ok('rosters: a player no longer listed is kept, with the date we saw them gone', g && g.removed_at === '2026-05-08' && g.first_seen === '2026-05-01' && merged.listed === parsed.players.length - 1 && merged.reads === 2);
    fs.mkdirSync(path.join(t2.dir, 'd/rosters/baseball/2026'), { recursive: true });
    fs.copyFileSync(path.join(dataDir, 'rosters/baseball/2026/stanford.json'), path.join(t2.dir, 'd/rosters/baseball/2026/stanford.json'));
    const before = fs.readFileSync(path.join(t2.dir, 'd/rosters/baseball/2026/stanford.json'), 'utf8');
    /* a broken page: the parser sees five players where the last read listed 39 */
    const PLs = PL.parseRoster; PL.parseRoster = (h) => { const x = PLs(h); return x && x.platform === 'wmt' ? Object.assign({}, x, { players: x.players.slice(0, 5) }) : x; };
    const r2 = await RO.collect({ polite: t2.c, schoolsList: [schoolsList[1]], sports: ['baseball'], seasons: [2026], today: '2026-05-08', dataDir: path.join(t2.dir, 'd'), log: false });
    PL.parseRoster = PLs;
    ok('rosters: a read listing under half the last one is refused, and the snapshot is untouched', r2.misses.length === 1 && r2.misses[0].code === 'SHRUNK' && fs.readFileSync(path.join(t2.dir, 'd/rosters/baseball/2026/stanford.json'), 'utf8') === before, r2.misses);
    ok('rosters: the current season comes first from the plain page; a past season from its own (on WMT, under each way WMT sites label it)', RO.candidates({ id: 'x' }, 'wmt', 'baseball', 2026, { today: '2026-05-01' }).join() === '/sports/baseball/roster,/sports/baseball/roster/season/2026,/sports/baseball/roster/season/2025-26,/sports/baseball/roster/season/2025-2026' && RO.candidates({ id: 'x' }, 'sidearm', 'baseball', 2019, { today: '2026-05-01' }).join() === '/sports/baseball/roster/2019');
    ok('rosters: seasons roll over in August for spring and split-year sports', RO.currentSeason('baseball', '2026-10-21') === 2027 && RO.currentSeason('football', '2026-10-21') === 2026 && RO.currentSeason('mens-basketball', '2026-10-21') === 2027 && RO.currentSeason('baseball', '2026-05-01') === 2026);
  }

  /* 7b. a page with no roster still says what built it; an old "unread" verdict is retried; robots.txt gets a second try */
  {
    ok('platforms: SIDEARM and WMT are told apart by the shape of any page; a site on neither is not guessed',
      PL.detectPlatform(R('collegiate/nuxt.js').nuxtData(FX('texassports.com/sports_baseball_schedule_2026'))) === 'sidearm' && PL.detectPlatform(R('collegiate/nuxt.js').nuxtData(FX('12thman.com/home'))) === 'wmt'
      && PL.detectPlatform(R('collegiate/nuxt.js').nuxtData(FX('arkansasrazorbacks.com/home'))) === null);
    const t = polite({ 'https://nobase.edu/robots.txt': { body: '' }, 'https://nobase.edu/sports/baseball/roster': { body: FX('texassports.com/sports_baseball_schedule_2026') },
      'https://old.edu/robots.txt': { body: '' }, 'https://old.edu/sports/baseball/roster': { body: FX('texassports.com/sports_baseball_roster_2026') },
      'https://slow.edu/robots.txt': { seq: [{ status: 503 }, { body: '' }] }, 'https://slow.edu/sports/baseball/roster': { body: FX('texassports.com/sports_baseball_roster_2026') } }, ['nobase.edu', 'old.edu', 'slow.edu']);
    const dataDir = path.join(t.dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ old: { platform: 'unread', checked: '2026-04-28' } }));
    const run = await RO.collect({ polite: t.c, schoolsList: [{ id: 'nobase', host: 'nobase.edu', division: 1 }, { id: 'old', host: 'old.edu', division: 1 }, { id: 'slow', host: 'slow.edu', division: 1 }], sports: ['baseball'], seasons: [2026], today: '2026-05-01', dataDir, log: false });
    const plats = JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms.json'), 'utf8'));
    ok('rosters: a page with no roster teaches the platform, and the season is a plain miss, not a month away', plats.nobase.platform === 'sidearm' && run.misses.some((m) => m.school === 'nobase' && /^(NO_ROSTER|HTTP)$/.test(m.code)) && !run.misses.some((m) => m.code === 'PLATFORM_NOT_READ'), run.misses);
    ok('rosters: an "unread" verdict made before the platform was read from the page\'s shape is retried', plats.old.platform === 'sidearm' && run.ok >= 1);
    ok('polite: a robots.txt that does not answer gets a second try before the host is skipped', plats.slow && plats.slow.platform === 'sidearm' && run.ok === 2, run);
  }

  /* 7b2. SIDEARM's older sites (no Nuxt data; one li.sidearm-roster-player per player) */
  {
    const leg = FX('daytonflyers.com/sports_baseball_roster');
    const x = PL.parseRoster(leg, 'baseball');
    const jw = x.players.find((p) => p.pid === 'slug:jon-whiteside');
    ok('sidearm (older): a season\'s roster from the page\'s markup, the season from its title', x.platform === 'sidearm_legacy' && x.season_label === '2027' && x.season === 2027 && x.players.length === 39);
    ok('sidearm (older): every field the newer platform gives, bats/throws included', jw && jw.jersey === '3' && jw.pos === 'RHP' && jw.class === 'JR' && jw.height_in === 76 && jw.weight === 200 && jw.hometown === 'Troy, Mich.' && jw.high_school === 'Troy' && jw.previous_school === 'Lansing CC' && jw.bats === 'R' && jw.throws === 'R', jw);
    ok('sidearm (older): a player is the site\'s name slug, not the per-season id', x.players.every((p) => /^slug:[a-z0-9-]+$/.test(p.pid)) && new Set(x.players.map((p) => p.pid)).size === x.players.length);
    ok('platforms: SIDEARM\'s older sites are told by their markup; a WordPress site is still not guessed', PL.detectPlatformHtml(leg) === 'sidearm_legacy' && PL.detectPlatformHtml(FX('ukathletics.com/sports_baseball_roster')) === null && PL.detectPlatformHtml(FX('12thman.com/home')) === 'wmt');
    const t = polite({ 'https://old.edu/robots.txt': { body: '' }, 'https://old.edu/sports/baseball/roster': { body: leg } }, ['old.edu']);
    const dataDir = path.join(t.dir, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ dayton: { platform: 'unread', by: 'structure', checked: '2026-10-21' } }));
    const run = await RO.collect({ polite: t.c, schoolsList: [{ id: 'dayton', host: 'old.edu', division: 1 }], sports: ['baseball'], seasons: [2027], today: '2026-10-22', dataDir, log: false });
    ok('rosters: a site judged unread before older SIDEARM was read is retried, and read', run.ok === 1 && JSON.parse(fs.readFileSync(path.join(dataDir, 'platforms.json'), 'utf8')).dayton.platform === 'sidearm_legacy', run.misses);
  }

  /* 7c. a registry host gone dead is replaced by the site the school's opponents name for it */
  {
    const H = R('collegiate/hosts.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-'));
    const put = (rel, o) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
    const schools = [{ id: 'alpha', name: 'Alpha', host: 'alpha-old.com' }, { id: 'beta', name: 'Beta', host: 'beta.com' }, { id: 'gamma', name: 'Gamma', host: 'gamma.com' },
      { id: 'delta', name: 'Delta', host: 'delta.com' }, { id: 'eps', name: 'Eps', host: 'eps-old.com' }, { id: 'zeta', name: 'Zeta', host: 'zeta-old.com' }];
    const g = (opp, host) => ({ opponent: opp, opponent_host: host, status: 'final' });
    put('schedules/baseball/2026/beta.json', { school: 'beta', games: [g('Alpha', 'alpha.com'), g('Eps', 'eps-new.com'), g('Zeta', 'zeta-new.com')] });
    put('schedules/baseball/2026/gamma.json', { school: 'gamma', games: [g('Alpha', 'alpha.com'), g('Eps', 'eps-new.com'), g('Zeta', 'zeta-new.com')] });
    put('schedules/baseball/2026/delta.json', { school: 'delta', games: [g('Alpha', 'alpha.com'), g('Eps', 'eps-old.com'), g('Zeta', 'zeta-new.com')] });
    const dead = (s) => ({ school: s, code: 'REFUSED', why: 'robots.txt did not answer twice (NETWORK; staying out this run)' });
    put('runs/2026-10-21.json', { misses: [dead('alpha'), dead('alpha'), dead('eps')], read_schools: ['beta', 'gamma', 'delta', 'zeta'] });
    const c = H.corrections(dir, schools);
    ok('hosts: a host that gave nothing, named otherwise by three schools and by none as the registry has it, is replaced', c.alpha && c.alpha.host === 'alpha.com' && c.alpha.registry_host === 'alpha-old.com' && c.alpha.named_by === 3, c);
    ok('hosts: one school still naming the registry\'s host keeps it; a host that works is never replaced', !c.eps && !c.zeta);
    H.update(dir, schools);
    fs.writeFileSync(path.join(dir, 'schools.json'), JSON.stringify({ schools }));
    const loaded = RO.loadSchools(dir).find((s) => s.id === 'alpha');
    ok('hosts: the collectors read the corrected host, and the registry\'s is kept beside it', loaded.host === 'alpha.com' && loaded.registry_host === 'alpha-old.com' && loaded.host_source === 'opponents_schedules');
    ok('directory: a website that reads as no real host ("https://https//x.com") is no host', D.parseSchool('<div class="school-links"><a href="https://https//x.com"><span class="icon-web"></span></a></div>').host === null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 8. the portal ledger */
  const PO = R('collegiate/portal.js');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
    const p = (pid, first, last, cls, extra) => Object.assign({ pid, name: first + ' ' + last, first, last, class: cls, pos: 'P', hometown: null, high_school: null, previous_school: null, first_seen: '2025-10-01', last_seen: '2026-02-01' }, extra || {});
    const put = (sch, season, players) => { const f = path.join(dir, 'rosters/baseball', String(season), sch + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ school: sch, sport: 'baseball', season, players })); };
    put('alpha', 2025, [p('a1', 'Jake', 'Miller', 'SO', { hometown: 'Austin, Texas', high_school: 'Westlake' }), p('a2', 'Sam', 'Ortiz', 'SR'), p('a3', 'Ty', 'Brown', 'JR'), p('a4', 'Lee', 'Park', 'FR'), p('a5', 'Max', 'Cole', 'JR', { hometown: 'Mobile, Ala.' })]);
    put('alpha', 2026, [p('a4', 'Lee', 'Park', 'SO'), p('a9', 'New', 'Kid', 'FR', { high_school: 'Central' }), p('a5', 'Max', 'Cole', 'SR', { hometown: 'Mobile, Ala.', removed_at: '2026-04-20' })]);
    put('beta', 2025, [p('b1', 'Ron', 'Hale', 'JR')]);
    put('beta', 2026, [p('b1', 'Ron', 'Hale', 'SR'), p('b7', 'Jacob', 'Miller', 'JR', { hometown: 'Austin, TX', high_school: 'Westlake HS' }),
      p('b8', 'Ty', 'Brown', 'SR', { previous_school: 'Alpha State' }), p('b9', 'Cal', 'Reed', 'JR', { previous_school: 'McLennan CC' }), p('b11', 'Abe', 'Ross', 'SO', { previous_school: 'San Jacinto College' }),
      p('b10', 'Jake', 'Brown', 'JR', { hometown: 'Elsewhere, Ohio' })]);
    const out = PO.build({ dataDir: dir, sport: 'baseball', season: 2026, schoolsList: [{ id: 'alpha', name: 'Alpha', aliases: ['Alpha State'], conference: 'East' }, { id: 'beta', name: 'Beta', conference: 'East' }], write: false });
    const L = (fn) => out.ledger.filter(fn);
    const ty = L((r) => r.kind === 'transfer' && r.player === 'Ty Brown')[0];
    ok('portal: a listed previous school and a roster match make a transfer seen at both ends', ty && ty.from === 'alpha' && ty.to === 'beta' && ty.from_pid === 'a3' && ty.evidence.includes('previous_school'), ty);
    const jm = L((r) => r.kind === 'transfer' && r.to_pid === 'b7')[0];
    ok('portal: a nickname, the same hometown in another style and the same high school match without a listed school', jm && jm.from === 'alpha' && jm.evidence.includes('initial') && jm.evidence.includes('hometown') && jm.evidence.includes('high_school'), jm);
    ok('portal: a shared last name alone is never a match', !L((r) => r.to_pid === 'b10' && r.kind === 'transfer').length && L((r) => r.to_pid === 'b10')[0].kind === 'newcomer');
    const juco = L((r) => r.to_pid === 'b9')[0];
    const other = L((r) => r.to_pid === 'b11')[0];
    ok('portal: a junior-college transfer is kept with its school as written; a level the name does not say is not guessed', juco.kind === 'transfer' && juco.from === null && juco.from_level === 'juco' && juco.from_text === 'McLennan CC' && other.from_level === 'other' && out.unresolved_previous_schools['San Jacinto College'] === 1);
    ok('portal: a senior who left is "eligibility likely done", not a transfer', L((r) => r.kind === 'departure' && r.from_pid === 'a2')[0].outcome === 'eligibility_likely_done');
    const mid = L((r) => r.kind === 'departure' && r.from_pid === 'a5')[0];
    ok('portal: a player taken off this season\'s roster is a departure dated to the read', mid && mid.in_season && mid.left_seen === '2026-04-20');
    const ta = out.teams.find((t) => t.school === 'alpha');
    ok('portal: a team\'s continuity counts who came back and who left with eligibility', ta.roster_before === 5 && ta.roster_now === 2 && ta.returning === 2 && ta.returning_share === 0.4 && ta.transfers_out === 2 && ta.departures_eligibility_done === 2 && ta.newcomers === 1, ta);
    ok('portal: a move inside a conference is marked on the ledger and the team', ty.from_conference === 'East' && ty.to_conference === 'East' && out.teams.find((t) => t.school === 'beta').transfers_in_same_conference === 2);
    {
      /* by default the ledger reads the registry the directory writes (collegiate/data/schools.json) */
      const src = fs.readFileSync(path.join(ROOT, 'collegiate/portal.js'), 'utf8');
      ok('portal: the registry is read from where the directory writes it', /const SCHOOLS = path\.join\(DATA, 'schools\.json'\)/.test(src) && /const OUT = path\.join\(__dirname, 'data', 'schools\.json'\)/.test(fs.readFileSync(path.join(ROOT, 'collegiate/directory.js'), 'utf8')));
    }
    ok('portal: states in AP style and postal codes compare equal', PO.normPlace('Austin, Texas') === PO.normPlace('Austin, TX') && PO.normPlace('Phoenix, Ariz.') === PO.normPlace('Phoenix, AZ') && PO.normPlace('Phoenix, Ariz.') !== PO.normPlace('Phoenix, Md.'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 9. a season's schedule and results (SIDEARM) */
  const SC = R('collegiate/schedules.js');
  {
    const x = SC.parseSchedule(FX('texassports.com/sports_baseball_schedule_2026'));
    const byStatus = x.games.reduce((a, g) => (a[g.status] = (a[g.status] || 0) + 1, a), {});
    ok('schedule: every game of the season, finals with scores, cancellations kept without one', x.sport === 'baseball' && x.games.length === 63 && byStatus.final === 61 && byStatus.cancelled === 2 && x.games.filter((g) => g.status === 'cancelled').every((g) => g.us === null && g.note));
    const g0 = x.games[0];
    ok('schedule: a game names its site, its opponent\'s own website and its box score', g0.site === 'H' && g0.opponent === 'UC Davis' && g0.opponent_host === 'ucdavisaggies.com' && /boxscore\/\d+$/.test(g0.boxscore) && g0.us === 12 && g0.them === 2 && g0.innings === 7);
    ok('schedule: a ranking in the opponent\'s name is dropped; neutral sites and the postseason are marked', x.games.some((g) => g.opponent === 'Coastal Carolina' && g.site === 'N') && x.games.some((g) => g.postseason) && x.games.every((g) => !/^#/.test(g.opponent)));
    {
      const t = polite({ 'https://texassports.com/robots.txt': { body: FX('texassports.com/robots_txt') }, 'https://texassports.com/sports/baseball/schedule/2026': { body: FX('texassports.com/sports_baseball_schedule_2026') },
        'https://gostanford.com/robots.txt': { body: FX('gostanford.com/robots_txt') }, 'https://gostanford.com/sports/baseball/schedule/season/2026': { body: FX('gostanford.com/sports_baseball_schedule_season_2026') } }, ['texassports.com', 'gostanford.com', 'plain.edu']);
      const dataDir = path.join(t.dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ texas: { platform: 'sidearm' }, stanford: { platform: 'wmt' }, plain: { platform: 'unread' } }));
      const run = await SC.collect({ polite: t.c, schoolsList: [{ id: 'texas', host: 'texassports.com', division: 1 }, { id: 'stanford', host: 'gostanford.com', division: 1 }, { id: 'plain', host: 'plain.edu', division: 1 }], sports: ['baseball'], seasons: [2026, 2025], today: '2026-10-21', dataDir, log: false });
      const f = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules/baseball/2026/texas.json'), 'utf8'));
      const w = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules/baseball/2026/stanford.json'), 'utf8'));
      ok('schedule: collected per school and season on both platforms; a season the site does not answer and a platform not read are misses', run.ok === 2 && f.finals === 61 && f.games.length === 63 && w.platform === 'wmt' && w.finals === 53 && w.games.filter((g) => g.exhibition).length === 2 && run.misses_by_reason.HTTP === 2 && run.misses_by_reason.PLATFORM_NOT_READ === 1, run.misses_by_reason);
    }
    const wm = SC.parseSchedule(FX('gostanford.com/sports_baseball_schedule_season_2026'));
    const fsu = wm.games.find((g) => g.boxscore === '/boxscore/26576');
    ok('schedule (WMT): games read from the page, the school\'s runs first, extra innings from the note', wm.platform === 'wmt' && wm.season_label === '2026' && wm.games.length === 56 && fsu.us === 8 && fsu.them === 7 && fsu.innings === 11 && fsu.site === 'H' && fsu.boxscore === '/boxscore/26576' && wm.games.filter((g) => g.site === 'N').length === 6);
    ok('schedule: helpers', SC.innings('7 Inn.') === 7 && SC.innings('', '10 innings') === 10 && SC.innings('') === null && SC.hostOf('http://www.msuspartans.com/') === 'msuspartans.com' && SC.cleanOpp('No. 3 LSU') === 'LSU');
  }

  /* 10. a box score (SIDEARM): starters with their hand, lineups with bats, the line, weather */
  const BX = R('collegiate/boxscores.js');
  {
    const x = BX.parseBoxscore(FX('texassports.com/sports_baseball_stats_2026_michigan_state_boxscore_17827'));
    ok('box score: both teams by their NCAA codes (our team ids), with runs, hits and the line', x.date === '2026-02-21' && x.home.code === '703' && x.away.code === '416' && x.home.runs === 3 && x.away.runs === 1 && x.home.hits === 8 && x.home.line.length === 9 && x.home.line[8] === null);
    ok('box score: each starter, with throwing hand and outs (matches our record: Harrison 13 outs, Monke 19)', x.home.starter.name === 'Luke Harrison' && x.home.starter.throws === 'L' && x.home.starter.outs === 13 && x.away.starter.name === 'Carter Monke' && x.away.starter.outs === 19 && x.home.pitchers.length === 4);
    ok('box score: the starting nine with spots and bats', x.home.lineup.length === 9 && x.away.lineup.map((l) => l.bats).join('') === 'RLRRRRRRL' && x.home.lineup[1].bats === 'S');
    ok('box score: weather as written, split only where it reads plainly', x.weather.temp_f === 69 && x.weather.sky === 'Mostly Cloudy' && x.weather.wind_dir === 'N' && x.weather.wind_mph === 24 && BX.weather('0').raw === null && BX.weather('Dome').temp_f === null && x.attendance === 7397 && x.scheduled_innings === 9);
    ok('box score: innings pitched are thirds, and an impossible value is not a number', BX.outsOf('4.1') === 13 && BX.outsOf('0.2') === 2 && BX.outsOf('5.3') === null && BX.outsOf('') === null);

    /* collecting: each game once, from the home school; what is held is not read again */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-'));
    const sched = SC.parseSchedule(FX('texassports.com/sports_baseball_schedule_2026'));
    const putS = (school, games) => { const f = path.join(dir, 'schedules/baseball/2026', school + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ school, games })); };
    putS('texas', sched.games);
    putS('msu', [{ date: '2026-02-21', site: 'A', opponent: 'Texas', opponent_host: 'texassports.com', status: 'final', us: 1, them: 3, boxscore: '/sports/baseball/stats/2026/texas/boxscore/999', game_key: '999' },
      { date: '2026-03-01', site: 'H', opponent: 'Oakland', opponent_host: 'goldengrizzlies.com', status: 'final', us: 5, them: 1, boxscore: '/sports/baseball/stats/2026/oakland/boxscore/1000', game_key: '1000' }]);
    fs.writeFileSync(path.join(dir, 'platforms.json'), JSON.stringify({ texas: { platform: 'sidearm' }, msu: { platform: 'sidearm' } }));
    const schoolsList = [{ id: 'texas', host: 'texassports.com', division: 1 }, { id: 'msu', host: 'msuspartans.com', division: 1 }];
    const pl = BX.plan(dir, 'baseball', [2026], schoolsList, { texas: { platform: 'sidearm' }, msu: { platform: 'sidearm' } });
    ok('box scores: a game between two schools we hold is read once, from the home school', pl.filter((x) => x.school === 'msu').map((x) => x.game_key).join() === '1000' && pl.filter((x) => x.school === 'texas').length === 61);
    const t = polite({ 'https://texassports.com/robots.txt': { body: FX('texassports.com/robots_txt') }, 'https://texassports.com/sports/baseball/stats/2026/michigan-state/boxscore/17827': { body: FX('texassports.com/sports_baseball_stats_2026_michigan_state_boxscore_17827') } }, ['texassports.com', 'msuspartans.com']);
    const r1 = await BX.collect({ polite: t.c, dataDir: dir, schoolsList, seasons: [2026], today: '2026-10-21', perHost: 100 });
    const held = BX.readLines(path.join(dir, 'boxscores/baseball/2026/texas.jsonl.gz'));
    ok('box scores: a read is kept compact, with each starter and the line', r1.ok === 1 && held.length === 1 && held[0].game_key === '17827' && held[0].home.starter[0] === 'Luke Harrison' && held[0].home.starter[1] === 'L' && held[0].away.code === '416' && held[0].weather.temp_f === 69, r1);
    const r2 = await BX.collect({ polite: t.c, dataDir: dir, schoolsList, seasons: [2026], today: '2026-10-22', perHost: 5 });
    ok('box scores: what is held is not read again, and a run stops at its per-host cap', r2.pending === r1.pending - 1 && r2.ok + (r2.misses_by_reason.HTTP || 0) <= 5 + 1, r2);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 11. WMT's season labels (probe round 7): a spring season labelled by academic year, a fall sport's "2026-27",
     a four-digit split label, a site's own code for the sport */
  {
    ok('seasons: an academic-year label is a fall sport\'s first year, a spring or split-year sport\'s second', PL.seasonKey('2026-27', 'football') === 2026 && PL.seasonKey('2026-27', 'baseball') === 2027 && PL.seasonKey('2025-26', 'mens-basketball') === 2026 && PL.seasonKey('2025-2026', 'womens-soccer') === 2025 && PL.seasonKey('2026', 'football') === 2026 && PL.seasonKey('2025-26') === 2026);
    ok('seasons: every way a site labels a season, the usual first', PL.seasonLabels('baseball', 2026).join() === '2026,2025-26,2025-2026' && PL.seasonLabels('football', 2025).join() === '2025,2025-26,2025-2026' && PL.seasonLabels('mens-basketball', 2026).join() === '2025-26,2025-2026');
    const va = PL.parseRoster(FX('virginiasports.com/sports_baseball_roster_season_2025_26'), 'baseball');
    const ia = PL.parseRoster(FX('hawkeyesports.com/sports_football_roster'), 'football');
    const byu = PL.parseRoster(FX('byucougars.com/sports_mens_basketball_roster_season_2025_2026'), 'mens-basketball');
    const psu = PL.parseRoster(FX('gopsusports.com/sports_baseball_roster_season_2025_26'), 'baseball');
    ok('wmt: Virginia\'s 2026 baseball roster lives at /season/2025-26 (its /season/2026 is a 404)', va.season === 2026 && va.season_label === '2025-26' && va.players.length === 41);
    ok('wmt: a fall sport labelled "2026-27" is its 2026 season (Iowa football, 111 players)', ia.season_label === '2026-27' && PL.seasonKey(ia.season_label, 'football') === 2026 && ia.players.length === 111);
    ok('wmt: four-digit split labels ("2025-2026") and Penn State\'s full 2026 roster at /season/2025-26 (39; /season/2026 lists 12)', byu.season === 2026 && byu.players.length === 17 && psu.season === 2026 && psu.players.length === 39);
    const lsu = PL.parseRoster(FX('lsusports.net/sports_baseball_roster'), 'baseball');
    ok('wmt: a site\'s own code for a sport is that sport (LSU calls baseball "bsb"); another sport\'s name is not', lsu.sport === 'bsb' && lsu.season === 2027 && lsu.players.length === 39 && PL.sportMatches('baseball', lsu.sport, lsu.sport_name) && !PL.sportMatches('baseball', 'softball', 'Softball') && PL.sportMatches('womens-volleyball', null, 'Volleyball') && PL.sportMatches('mens-basketball', null, 'Men’s Basketball'));
    /* collecting: the season's label learnt from the page that answered, and LSU read at all */
    const t = polite({ 'https://virginiasports.com/robots.txt': { body: '' }, 'https://virginiasports.com/sports/baseball/roster/season/2025-26': { body: FX('virginiasports.com/sports_baseball_roster_season_2025_26') },
      'https://lsusports.net/robots.txt': { body: FX('lsusports.net/robots_txt') }, 'https://lsusports.net/sports/baseball/roster': { body: FX('lsusports.net/sports_baseball_roster') } }, ['virginiasports.com', 'lsusports.net']);
    const dataDir = path.join(t.dir, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ virginia: { platform: 'wmt' }, lsu: { platform: 'wmt' } }));
    fs.writeFileSync(path.join(dataDir, 'season_labels.json'), JSON.stringify({ 'virginia|baseball|2027': '2026-27' }));
    const run = await RO.collect({ polite: t.c, schoolsList: [{ id: 'virginia', host: 'virginiasports.com', division: 1 }, { id: 'lsu', host: 'lsusports.net', division: 1 }], sports: ['baseball'], seasons: [2026, 2027], today: '2026-10-21', dataDir, log: false });
    const labels = JSON.parse(fs.readFileSync(path.join(dataDir, 'season_labels.json'), 'utf8'));
    const vaSeen = t.w.seen.filter((x) => /virginiasports\.com\/sports\/baseball\/roster\/season/.test(x.url)).map((x) => x.url.split('/').pop());
    ok('rosters (WMT): a season is found under the school\'s own label form, tried first, and the label kept', fs.existsSync(path.join(dataDir, 'rosters/baseball/2026/virginia.json')) && vaSeen.includes('2025-26') && !vaSeen.includes('2026') && labels['virginia|baseball|2026'] === '2025-26', { vaSeen, misses: run.misses });
    ok('rosters (WMT): LSU\'s current roster is read (its "bsb" page is baseball)', fs.existsSync(path.join(dataDir, 'rosters/baseball/2027/lsu.json')), run.misses);
  }

  /* 12. schedules on every WMT theme and on SIDEARM's older sites (probe rounds 6 and 7) */
  {
    const S = (f, host) => SC.parseSchedule(FX(f), 'baseball', host);
    const fin = (x) => x.games.filter((g) => g.status === 'final' && !g.exhibition);
    const au = S('auburntigers.com/sports_baseball_schedule_season_2026');
    ok('schedule (WMT, Auburn\'s theme): 64 finals, 42-22 as the page\'s own record says, every box score; "(10)" is ten innings', fin(au).length === 64 && fin(au).filter((g) => g.outcome === 'W').length === 42 && au.games.filter((g) => g.boxscore).length === 64 && au.games.find((g) => g.game_key === '30628').innings === 10 && au.games.every((g) => g.site));
    const va = S('virginiasports.com/sports_baseball_schedule_season_2025_26');
    ok('schedule (WMT, a theme with no datetime): the date from month, day and weekday in the season; venue from its line', va.season_label === '2025-26' && PL.seasonKey(va.season_label, 'baseball') === 2026 && fin(va).length === 60 && va.undated === 0 && va.games[0].date === '2026-02-13' && va.games[0].site === 'H' && va.games[0].opponent === 'Wagner');
    const uc = S('uclabruins.com/sports_baseball_schedule_season_2026');
    ok('schedule (WMT, UCLA\'s theme): each game once (not again from the table view), exhibitions flagged', uc.games.length === 61 && fin(uc).length === 59 && uc.games.filter((g) => g.exhibition).length === 2 && uc.games.find((g) => g.opponent === 'Alumni Game').exhibition === true);
    const ls = S('lsusports.net/sports_baseball_schedule');
    ok('schedule (WMT): the page names every season the site keeps, by the label its pages use', ls.seasons.length > 20 && ls.seasons[0].label === '2027' && va.seasons.some((x) => x.label === '2015-16'));
    ok('schedule (WMT, LSU\'s theme): "at" is a road game; "vs." is home or neutral, so left unknown; an autumn game is the year before', ls.games.filter((g) => g.site === 'A').length === 17 && ls.games.filter((g) => g.site === null).length === 46 && ls.games[0].date === '2026-10-31');
    const dy = S('daytonflyers.com/sports_baseball_schedule_2026', 'daytonflyers.com');
    const dh = dy.games.filter((g) => g.doubleheader);
    ok('schedule (SIDEARM, older sites): every game, the school\'s runs first, the opponent\'s website, the box score', dy.platform === 'sidearm_legacy' && dy.season_label === '2026' && dy.games.length === 57 && fin(dy).length === 54 && fin(dy).filter((g) => g.outcome === 'W').length === 31
      && dy.games[0].date === '2026-02-13' && dy.games[0].site === 'A' && dy.games[0].opponent === 'Lipscomb' && dy.games[0].opponent_host === 'lipscombsports.com' && dy.games[0].us === 6 && dy.games[0].them === 11 && dy.games[0].boxscore === '/sports/baseball/stats/2026/lipscomb/boxscore/17441');
    ok('schedule (SIDEARM, older sites): doubleheaders, shortened and extra innings, cancellations, conference games', dh.length === 8 && dh[0].opponent === 'Eastern Kentucky' && dh[0].innings === 8 && dy.games.filter((g) => g.status === 'cancelled').length === 3 && dy.games.filter((g) => g.conference).length === 30 && dy.seasons.length > 20);
    const ws = S('goshockers.com/sports_baseball_schedule_2016', 'goshockers.com');
    const ap = S('appstatesports.com/sports_baseball_schedule_2026', 'appstatesports.com');
    ok('schedule (SIDEARM, older sites): 2016 reads as 2026 does', ws.season_label === '2016' && fin(ws).length === 58 && ws.games.every((g) => g.date && g.date.startsWith('2016-')) && ap.games.find((g) => g.game_key === '9710').innings === 12);
    ok('schedule: a listed weekday that disagrees with the date leaves the game undated, never moved', SC.monthDay('Feb 13', 'Fri', 2026, 'baseball') === '2026-02-13' && SC.monthDay('Feb 13', 'Sat', 2026, 'baseball') === null && SC.monthDay('Oct 31', 'Sat', 2027, 'baseball') === '2026-10-31' && SC.monthDay('Jan 1', null, 2025, 'football') === '2026-01-01');
    /* collecting: an older SIDEARM site, and a WMT season found under the label the site's own page names */
    const t = polite({ 'https://daytonflyers.com/robots.txt': { body: '' }, 'https://daytonflyers.com/sports/baseball/schedule/2023': { body: FX('daytonflyers.com/sports_baseball_schedule_2023') },
      'https://virginiasports.com/robots.txt': { body: '' }, 'https://virginiasports.com/sports/baseball/schedule/season/2026': { body: FX('virginiasports.com/sports_baseball_schedule_season_2025_26').replace(/sport-baseball-schedule-by-slug-2025-26/, 'x') },
      'https://virginiasports.com/sports/baseball/schedule/season/2025-26': { body: FX('virginiasports.com/sports_baseball_schedule_season_2025_26') } }, ['daytonflyers.com', 'virginiasports.com']);
    const dataDir = path.join(t.dir, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ dayton: { platform: 'sidearm_legacy' }, virginia: { platform: 'wmt' } }));
    const r1 = await SC.collect({ polite: t.c, schoolsList: [{ id: 'dayton', host: 'daytonflyers.com', division: 1 }], sports: ['baseball'], seasons: [2023], today: '2026-10-21', dataDir, log: false });
    const r2 = await SC.collect({ polite: t.c, schoolsList: [{ id: 'virginia', host: 'virginiasports.com', division: 1 }], sports: ['baseball'], seasons: [2026], today: '2026-10-21', dataDir, log: false });
    const labels = JSON.parse(fs.readFileSync(path.join(dataDir, 'season_labels.json'), 'utf8'));
    const d23 = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules/baseball/2023/dayton.json'), 'utf8'));
    ok('schedules: an older SIDEARM site is collected, and the seasons its page names are learnt', r1.ok === 1 && d23.platform === 'sidearm_legacy' && d23.finals === 60 && labels['dayton|baseball|2016'] === '2016', r1.misses);
    ok('schedules (WMT): a page of another season names the site\'s labels, and the season is then read under its own', r2.ok === 1 && labels['virginia|baseball|2026'] === '2025-26' && JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules/baseball/2026/virginia.json'), 'utf8')).finals === 60, r2.misses);
  }

  /* 12b. what the first backfill could not read (probe round 8) */
  {
    const S = (f, host) => SC.parseSchedule(FX(f), 'baseball', host);
    const fin = (x) => x.games.filter((g) => g.status === 'final' && !g.exhibition);
    const ma = S('gomason.com/sports_baseball_schedule_2025', 'gomason.com'); const br = S('bradleybraves.com/sports_baseball_schedule_2025', 'bradleybraves.com');
    ok('schedule (SIDEARM, Vue generation): the schedule the page hands its component, read as the Nuxt store is', ma.season_label === '2025' && fin(ma).length === 61 && fin(ma).filter((g) => g.outcome === 'W').length === 40 && ma.games.every((g) => g.opponent_host) && br.games.length === 51 && br.games[0].opponent_host === 'rolltide.com' && br.games[0].us === 6 && br.games[0].them === 10 && br.games[0].boxscore === '/sports/baseball/stats/2025/university-of-alabama/boxscore/22404');
    const va = S('valpoathletics.com/sports_baseball_schedule_2019', 'valpoathletics.com'); const fu = S('fullertontitans.com/sports_baseball_schedule_2019', 'fullertontitans.com');
    ok('schedule (SIDEARM, older sites): a season named only in the page title is read (2019, Valparaiso and Cal State Fullerton)', va.season_label === '2019' && fin(va).length === 50 && fu.season_label === '2019' && fin(fu).length === 54 && fu.games.every((g) => g.date.startsWith('2019-')));
    const ne = S('huskers.com/sports_baseball_schedule_season_2026'); const vu = S('vucommodores.com/sports_baseball_schedule_season_2025_26');
    ok('schedule (WMT, Nebraska\'s theme): the date from its label and a bare weekday, the venue from its type', fin(ne).length === 60 && ne.undated === 0 && ne.games[0].date === '2026-02-13' && ne.games[0].site === 'N' && ne.games[0].opponent === 'UConn' && ne.games[0].innings === 7);
    ok('schedule (WMT): the theme with the most games is read (Vanderbilt\'s 58, not its one tournament game); a heading names the opponent', fin(vu).length === 58 && vu.games[0].opponent === 'TCU' && vu.games[0].us === 4 && vu.games[0].them === 5);
    const cl = S('clemsontigers.com/sports_baseball_schedule'); const ls = S('lsusports.net/sports_bsb_schedule_season_2026');
    ok('schedule (WMT): a season is keyed by its name and reached by its slug (Clemson\'s 2026-27 is /season/2026)', cl.season_label === '2026-27' && cl.season_slug === '2026' && PL.seasonKey(cl.season_label, 'baseball') === 2027 && cl.seasons.some((x) => x.label === '2025' && x.name === '2025-26'));
    ok('schedule (WMT): LSU\'s pages under its own sport code read as baseball', ls.sport === 'bsb' && fin(ls).length === 58 && PL.sportMatches('baseball', ls.sport, ls.sport_name));
    ok('sport: a name ending in the sport is it ("Demon Baseball"); another sport\'s name never is', PL.sportMatches('baseball', null, 'Demon Baseball') && PL.sportMatches('baseball', null, 'Merrimack College Baseball') && !PL.sportMatches('baseball', null, 'Softball') && !PL.sportMatches('baseball', null, 'Baseball Softball'));
    ok('schedule (SIDEARM): a page that renders its schedule in the browser carries none, and says so', S('kcroos.com/sports_baseball_schedule_2025') === null);
    /* collecting: LSU's own sport code learnt from its roster and used for its schedule; Clemson's slug learnt by the season's name;
       a 404 of a label never hides what an earlier page said */
    const t = polite({ 'https://lsusports.net/robots.txt': { body: FX('lsusports.net/robots_txt') }, 'https://lsusports.net/sports/baseball/roster': { body: FX('lsusports.net/sports_baseball_roster') },
      'https://lsusports.net/sports/bsb/schedule/season/2026': { body: FX('lsusports.net/sports_bsb_schedule_season_2026') },
      'https://clemsontigers.com/robots.txt': { body: '' }, 'https://clemsontigers.com/sports/baseball/schedule/season/2026': { body: FX('clemsontigers.com/sports_baseball_schedule') },
      'https://uni.edu/robots.txt': { body: '' }, 'https://uni.edu/sports/baseball/schedule/2025': { body: FX('kcroos.com/sports_baseball_schedule_2025') } }, ['lsusports.net', 'clemsontigers.com', 'uni.edu']);
    const dataDir = path.join(t.dir, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ lsu: { platform: 'wmt' }, clemson: { platform: 'wmt' }, roos: { platform: 'sidearm' } }));
    const rr = await RO.collect({ polite: t.c, schoolsList: [{ id: 'lsu', host: 'lsusports.net', division: 1 }], sports: ['baseball'], seasons: [2027], today: '2026-10-22', dataDir, log: false });
    const sl = await SC.collect({ polite: t.c, schoolsList: [{ id: 'lsu', host: 'lsusports.net', division: 1 }], sports: ['baseball'], seasons: [2026], today: '2026-10-22', dataDir, log: false });
    ok('WMT: the sport code a site\'s own pages use is learnt from its roster and used for its season pages', rr.ok === 1 && sl.ok === 1 && JSON.parse(fs.readFileSync(path.join(dataDir, 'season_labels.json'), 'utf8'))['lsu|baseball|path'] === 'bsb', [rr.misses, sl.misses]);
    const cs = await SC.collect({ polite: t.c, schoolsList: [{ id: 'clemson', host: 'clemsontigers.com', division: 1 }], sports: ['baseball'], seasons: [2026], today: '2026-10-22', dataDir, log: false });
    const lab = JSON.parse(fs.readFileSync(path.join(dataDir, 'season_labels.json'), 'utf8'));
    ok('WMT: a page of another season names this one\'s slug by its name, and the miss reported is what a page said, not a later 404', lab['clemson|baseball|2026'] === '2025' && lab['clemson|baseball|2027'] === '2026' && cs.misses.length === 1 && cs.misses[0].code === 'SEASON_MISMATCH', cs.misses);
  }

  /* 13. box scores on SIDEARM's older sites: the scorer's tables, the teams by the schedule's exact join */
  {
    const B = (f) => BX.parseBoxscore(FX(f));
    const x = B('daytonflyers.com/sports_baseball_stats_2026_lipscomb_boxscore_17441');
    ok('box score (older SIDEARM): the line, visitor first, and which side is the school (its players link to its roster)', x.platform === 'sidearm_legacy' && x.date === '2026-02-13' && x.own_side === 'away' && x.away.name === 'Dayton' && x.away.runs === 6 && x.home.runs === 11 && x.home.hits === 12 && x.home.line.length === 9 && x.home.line[8] === null && x.away.errors === 4);
    ok('box score (older SIDEARM): each starter with outs, batters faced, strikeouts, walks and pitches; the school\'s keep their roster slug', x.away.starter.name === 'Sawyer Jensen' && x.away.starter.outs === 13 && x.away.starter.bf === 22 && x.away.starter.k === 1 && x.away.starter.pitches === 70 && x.away.starter.slug === 'sawyer-jensen' && x.home.starter.name === 'Alexander Llinas' && x.home.starter.outs === 11 && x.away.pitchers.length === 6);
    ok('box score (older SIDEARM): the starting nine in order, a substitute never one of them; names without the repeated position', x.away.lineup.length === 9 && x.away.lineup[0].name === 'Jason Bello' && x.away.lineup[0].pos === '3B' && x.home.lineup.length === 9 && x.home.lineup[0].name === 'Hutson Miles' && !x.away.lineup.some((l) => l.name === 'Martin Howell'));
    ok('box score (older SIDEARM): the game\'s details; weather read in its other forms', x.attendance === 547 && x.weather.temp_f === 61 && x.weather.sky === 'Sunny' && x.weather.wind_dir === 'ENE' && x.weather.wind_mph === 3 && BX.weather('70; sunny; NW at 11 mph').wind_mph === 11 && BX.weather('Overcast, 53 deg.').temp_f === 53 && BX.weather('Nice day for baseball').sky === null);
    const x12 = B('appstatesports.com/sports_baseball_stats_2026_gardner_webb_boxscore_9710'); const x7 = B('appstatesports.com/sports_baseball_stats_2026_canisius_boxscore_9703'); const x16 = B('goshockers.com/sports_baseball_stats_2016_northern_colorado_boxscore_3511');
    ok('box score (older SIDEARM): twelve innings, seven, and 2016 read the same', x12.home.line.length === 12 && x12.own_side === 'away' && x7.home.line.length === 7 && x7.own_side === 'home' && x16.date === '2016-02-19' && x16.home.starter.name === 'Sam Tewes' && x16.home.starter.outs === 18);
    /* the codes from the schedule's join; a box whose opponent joins to no registry school is a miss */
    const j = BX.legacyCodes(B('daytonflyers.com/sports_baseball_stats_2026_lipscomb_boxscore_17441'), { school: 'dayton', opponent: 'lipscomb', own_team_id: '175', opp_team_id: '362', site: 'A', conference: false, dh_n: 0 });
    ok('box score (older SIDEARM): the teams take the ids the plan resolved; the opponent keeps no slug', j.away.code === '175' && j.home.code === '362' && j.neutral === false && j.home.pitchers.every((p) => !p.slug) && BX.legacyCodes(B('daytonflyers.com/sports_baseball_stats_2026_lipscomb_boxscore_17441'), { school: 'dayton', own_team_id: '175', opp_team_id: null }) === null);
    const c = BX.compact(j);
    ok('box score (older SIDEARM): kept compact as the newer platform\'s, with the roster slug, runs and hit batters (no home runs listed)', c.platform === 'sidearm_legacy' && c.away.starter[0] === 'Sawyer Jensen' && c.away.starter[2] === 13 && c.away.starter[9] === 'sawyer-jensen' && c.away.starter[10] === 5 && c.away.starter[11] === null && c.away.starter[12] === 2 && c.away.lineup[0][4] === 'jason-bello' && c.home.starter[9] === null);
    const nc = BX.compact(BX.parseBoxscore(FX('texassports.com/sports_baseball_stats_2026_michigan_state_boxscore_17827')));
    ok('box score (SIDEARM): the school\'s own players keep their roster slug; runs, home runs and hit batters ride along', nc.home.starter[9] === 'luke-harrison' && nc.away.starter[9] === null && nc.home.starter.length === 13 && Number.isInteger(nc.home.starter[10]) && Number.isInteger(nc.home.starter[11]) && Number.isInteger(nc.home.starter[12]) && nc.home.lineup.every((l) => l[4]));
    /* collecting: planned from the older site's schedule, a doubleheader numbered, read once */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'box-legacy-'));
    const sched = SC.parseSchedule(FX('daytonflyers.com/sports_baseball_schedule_2026'), 'baseball', 'daytonflyers.com');
    const f = path.join(dir, 'schedules/baseball/2026/dayton.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ school: 'dayton', games: sched.games }));
    fs.writeFileSync(path.join(dir, 'platforms.json'), JSON.stringify({ dayton: { platform: 'sidearm_legacy' } }));
    /* Lipscomb is in the registry; Eastern Kentucky (a Division II-style gap: no registry row here) only through the ids the
       schedules establish (team_ids.json); every other opponent of Dayton's is unknown */
    const schoolsList = [{ id: 'dayton', host: 'daytonflyers.com', division: 1, baseball_team_id: '175' }, { id: 'lipscomb', host: 'lipscombsports.com', division: 1, baseball_team_id: '362' }];
    fs.writeFileSync(path.join(dir, 'team_ids.json'), JSON.stringify({ schools: {}, hosts: { 'ekusports.com': { team_id: '204', votes: 40, of: 40 } } }));
    const pl = BX.plan(dir, 'baseball', [2026], schoolsList, { dayton: { platform: 'sidearm_legacy' } });
    const ek = pl.filter((p) => p.date === '2026-02-20');
    ok('box scores: an older SIDEARM site\'s games are planned with both teams\' ids, a doubleheader\'s numbered in order', pl.length === 6 && pl.unjoinable === 48 && ek.length === 2 && ek[0].dh_n === 1 && ek[1].dh_n === 2 && ek[0].opp_team_id === '204'
      && pl.find((p) => p.game_key === '17441').dh_n === 0 && pl.find((p) => p.game_key === '17441').opp_team_id === '362' && pl.every((p) => p.own_team_id === '175'), { n: pl.length, u: pl.unjoinable });
    const t = polite({ 'https://daytonflyers.com/robots.txt': { body: '' }, 'https://daytonflyers.com/sports/baseball/stats/2026/lipscomb/boxscore/17441': { body: FX('daytonflyers.com/sports_baseball_stats_2026_lipscomb_boxscore_17441') },
      'https://daytonflyers.com/sports/baseball/stats/2026/eastern-kentucky/boxscore/17444': { body: FX('daytonflyers.com/sports_baseball_stats_2026_eastern_kentucky_boxscore_17444') } }, ['daytonflyers.com', 'lipscombsports.com']);
    const r = await BX.collect({ polite: t.c, dataDir: dir, schoolsList, seasons: [2026], today: '2026-10-21', perHost: 100 });
    const held = BX.readLines(path.join(dir, 'boxscores/baseball/2026/dayton.jsonl.gz'));
    const lip = held.find((x) => x.game_key === '17441'); const eku = held.find((x) => x.game_key === '17444');
    ok('box scores: an older SIDEARM box is kept with our team ids, a learnt website\'s included', r.ok === 2 && lip && lip.away.code === '175' && lip.home.code === '362' && eku && eku.home.code === '175' && eku.away.code === '204' && eku.doubleheader_game === 1, r);
    ok('box scores: a game whose opponent joins to none of our teams is never requested', r.unjoinable === 48 && !t.w.seen.some((x) => /boxscore\/17447$/.test(x.url)) && !r.misses_by_reason.NO_TEAM_CODE, r);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 13b. our team ids where the registry has none, from the schools' schedules and our own record */
  {
    const TI = R('collegiate/teamids.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamids-')); const dataDir = path.join(dir, 'data'); const gamesDir = path.join(dir, 'games');
    fs.mkdirSync(gamesDir, { recursive: true });
    const H = 'game_id,date,home_id,away_id,status,home_runs,away_runs';
    const rows = []; const put = (school, games) => { const f = path.join(dataDir, 'schedules/baseball/2025', school + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ school, games })); };
    const g = (date, host, us, them) => ({ date, opponent: 'x', opponent_host: host, status: 'final', us, them });
    /* "app" (no id in the registry) plays known "alpha" (team 1) six times; our record has those six games with team 27 */
    const appGames = []; const alphaGames = [];
    for (let i = 0; i < 6; i++) { const d = '2025-03-0' + (i + 1); rows.push(['c' + i, d, '27', '1', 'FINAL', 5 + i, 2].join(',')); appGames.push(g(d, 'alpha.edu', 5 + i, 2)); }
    /* known "alpha" lists four games against an old website of team 9 (too few), and six against beta-old.com, five of them matching our team 9 and one team 10 */
    for (let i = 0; i < 4; i++) { const d = '2025-04-0' + (i + 1); rows.push(['d' + i, d, '1', '9', 'FINAL', 3, i].join(',')); alphaGames.push(g(d, 'few.com', 3, i)); }
    for (let i = 0; i < 6; i++) { const d = '2025-05-0' + (i + 1); const t = i < 5 ? '9' : '10'; rows.push(['e' + i, d, '1', t, 'FINAL', 7, i].join(',')); alphaGames.push(g(d, 'beta-old.com', 7, i)); }
    /* known "alpha" lists ten games against gamma-old.com, all our team 12 */
    for (let i = 0; i < 10; i++) { const d = '2025-06-' + String(i + 10); rows.push(['f' + i, d, '1', '12', 'FINAL', 4, i].join(',')); alphaGames.push(g(d, 'gamma-old.com', 4, i)); }
    fs.writeFileSync(path.join(gamesDir, '2025.csv'), [H].concat(rows).join('\n') + '\n');
    put('app', appGames); put('alpha', alphaGames);
    const schools = [{ id: 'app', host: 'appstate.edu' }, { id: 'alpha', host: 'alpha.edu', baseball_team_id: 1 }, { id: 'gamma', host: 'gamma-old.com' }, { id: 'taken', host: 't.edu', baseball_team_id: 27 }];
    const out = TI.learn({ dataDir, gamesDir, schools });
    const out2 = TI.learn({ dataDir, gamesDir, schools: schools.filter((s) => s.id !== 'taken') });
    ok('teamids: a school whose finals against a known opponent are our contests (same date, same score) is that team; never one another school already is', out2.schools.app && out2.schools.app.team_id === '27' && out2.schools.app.votes === 6 && !out.schools.app, [out.schools, out2.schools]);
    ok('teamids: a website is learnt from a known school\'s finals; too few, or evidence split below 90%, is not learnt', out2.hosts['gamma-old.com'] && out2.hosts['gamma-old.com'].team_id === '12' && !out2.hosts['few.com'] && !out2.hosts['beta-old.com'], out2.hosts);
    ok('teamids: a school whose own website the schedules establish is that team', out2.schools.gamma && out2.schools.gamma.team_id === '12' && /website/.test(out2.schools.gamma.via));
    TI.update(dataDir, schools.filter((s) => s.id !== 'taken'), { gamesDir });
    fs.writeFileSync(path.join(dataDir, 'schools.json'), JSON.stringify({ schools: schools.filter((s) => s.id !== 'taken') }));
    const loaded = RO.loadSchools(dataDir);
    ok('teamids: the collectors read a learnt id as the school\'s baseball id, and resolve a learnt website', loaded.find((s) => s.id === 'app').baseball_team_id === '27' && loaded.find((s) => s.id === 'app').team_id_source === 'schedules_join' && RO.teamOfHost(dataDir, loaded)('gamma-old.com') === '12' && RO.teamOfHost(dataDir, loaded)('alpha.edu') === '1');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* 14. the run: a backfill reopened when its collector reads more, reading only what is not held */
  {
    const RUN = R('collegiate/run.js');
    ok('run: a season range may run to the current season', RUN.range('2013-current', 'baseball', '2026-10-21').length === 15 && RUN.range('2013-2026').length === 14 && RUN.range('2019,2021').join() === '2019,2021');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
    const dataDir = path.join(dir, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'schools.json'), JSON.stringify({ built_at: '2026-10-20T00:00:00Z', schools: [{ id: 'dayton', host: 'daytonflyers.com', division: 1, baseball_team_id: '175' }] }));
    fs.writeFileSync(path.join(dataDir, 'platforms.json'), JSON.stringify({ dayton: { platform: 'sidearm_legacy' } }));
    /* 2016 already held; the backfill was marked complete before older SIDEARM schedules were read */
    const held16 = path.join(dataDir, 'schedules/baseball/2016/dayton.json'); fs.mkdirSync(path.dirname(held16), { recursive: true }); fs.writeFileSync(held16, JSON.stringify({ school: 'dayton', games: [], finals: 0 }));
    fs.writeFileSync(path.join(dataDir, 'backfill.json'), JSON.stringify({ sched: { complete: true, ok: 0 } }));
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ division: 1, weekly: { sports: [] }, backfill: [{ id: 'sched', kind: 'schedules', sport: 'baseball', seasons: '2016,2023' }], boxscores: [] }));
    const t = polite({ 'https://daytonflyers.com/robots.txt': { body: '' }, 'https://daytonflyers.com/sports/baseball/schedule/2023': { body: FX('daytonflyers.com/sports_baseball_schedule_2023') } }, ['daytonflyers.com']);
    const s1 = await RUN.run({ today: '2026-10-21', planFile, dataDir, polite: t.c, skipDirectory: true, log: false });
    const done = JSON.parse(fs.readFileSync(path.join(dataDir, 'backfill.json'), 'utf8'));
    ok('run: a backfill completed with fewer readers is opened again, and a season held is not read again', s1.steps.some((x) => x.step === 'backfill' && x.ok === 1) && done.sched.readers === SC.READERS && done.sched.complete === true && !t.w.seen.some((x) => /schedule\/2016/.test(x.url)) && fs.existsSync(path.join(dataDir, 'schedules/baseball/2023/dayton.json')), { steps: s1.steps, seen: t.w.seen.map((x) => x.url) });
    const n = t.w.seen.length;
    await RUN.run({ today: '2026-10-22', planFile, dataDir, polite: t.c, skipDirectory: true, log: false });
    ok('run: a backfill complete under the current readers is not read again', t.w.seen.length === n);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' collegiate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
