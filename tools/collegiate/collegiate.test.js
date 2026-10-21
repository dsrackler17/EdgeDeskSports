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
    ok('rosters: the current season comes first from the plain page; a past season from its own', RO.candidates({ id: 'x' }, 'wmt', 'baseball', 2026, { today: '2026-05-01' }).join() === '/sports/baseball/roster,/sports/baseball/roster/season/2026' && RO.candidates({ id: 'x' }, 'sidearm', 'baseball', 2019, { today: '2026-05-01' }).join() === '/sports/baseball/roster/2019');
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
      ok('schedule: collected per school and season on both platforms; a season the site does not answer and a platform not read are misses', run.ok === 2 && f.finals === 61 && f.games.length === 63 && w.platform === 'wmt' && w.finals === 55 && run.misses_by_reason.HTTP === 2 && run.misses_by_reason.PLATFORM_NOT_READ === 1, run.misses_by_reason);
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

  console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' collegiate — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
