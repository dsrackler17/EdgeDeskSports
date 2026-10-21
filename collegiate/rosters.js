#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — roster snapshots, read from each school's own site.

     node collegiate/rosters.js collect [--sports baseball,football] [--seasons 2025,2026]
                                        [--schools texas,stanford] [--division 1|all]
                                        [--today YYYY-MM-DD]

   For every school in the registry (collegiate/data/schools.json, built from
   ncaa.com by collegiate/directory.js) with an athletics host, every sport
   and season asked for: read the season's roster page through
   collegiate/polite.js (robots.txt, EdgeDeskBot, 2 s per host, every refusal
   kept), parse it (collegiate/platforms.js) and merge it into

     collegiate/data/rosters/<sport>/<season>/<school>.json

   A snapshot remembers each player across reads: first_seen and last_seen
   are the dates WE saw them listed, and removed_at the first read they were
   gone. Those are observation dates, not transfer-portal dates (the NCAA's
   portal database is not public); read weekly, they date a move to the week.

   The platform a site is built on is learnt from the first page that parses
   (collegiate/data/platforms.json); a site we cannot read yet is recorded
   as such and tried again a month later. A page that is not the season asked
   for (a site that answers an unknown season with its current roster), not
   the sport, or carries no players is a miss, written to the run log with
   its reason; so is a read that lists fewer than half the players the last
   read did (a broken page never empties a roster). Nothing is guessed.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { createPolite } = require('./polite');
const PL = require('./platforms');

/* the platforms read and how (a backfill completed with fewer is opened again: collegiate/run.js) */
const READERS = 'sidearm,sidearm_legacy,wmt+season_labels';
const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');
const DAY = 24 * 3600 * 1000;

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
/* a snapshot: one player per line, so a week's change is a readable diff */
function writeSnapshot(p, snap) {
  const head = Object.assign({}, snap); delete head.players;
  const body = JSON.stringify(head, null, 1).replace(/\n}$/, ',\n "players": [\n' + snap.players.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n ]\n}');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body + '\n');
}

/* the registry, with any dead host replaced by the site the school's opponents name for it (hosts.js); a host the
   registry read from a website with its scheme written twice is read again from the website (directory.hostOf) */
function loadSchools(dataDir) {
  const d = dataDir || DATA;
  const { hostOf } = require('./directory');
  const schools = ((readJson(path.join(d, 'schools.json'), { schools: [] }).schools) || [])
    .map((s) => (s.website && hostOf(s.website) !== (s.host || null) ? Object.assign({}, s, { host: hostOf(s.website) }) : s));
  return require('./hosts').apply(schools, readJson(path.join(d, 'host_corrections.json'), {}));
}

/* the current season of a sport on a date: split-year sports and spring sports roll over in August */
function currentSeason(sport, today) {
  const d = new Date(today + 'T00:00:00Z');
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
  if (PL.SPLIT.has(sport) || sport === 'baseball' || sport === 'softball') return m >= 8 ? y + 1 : y;
  return y;
}

/* merge one read into the snapshot: players keep their first_seen; those gone get removed_at */
const FIELDS = ['name', 'first', 'last', 'jersey', 'pos', 'class', 'redshirt', 'class_raw', 'height_in', 'weight', 'hometown', 'high_school', 'previous_school', 'bats', 'throws'];
function mergeSnapshot(prev, parsed, meta, today) {
  const old = new Map(((prev && prev.players) || []).map((p) => [p.pid, p]));
  const players = [];
  const now = new Set();
  for (const p of parsed.players) {
    if (now.has(p.pid)) continue;
    now.add(p.pid);
    const o = old.get(p.pid);
    const row = { pid: p.pid };
    for (const f of FIELDS) row[f] = p[f];
    row.first_seen = (o && o.first_seen) || today;
    row.last_seen = today;
    players.push(row);
  }
  for (const [pid, o] of old) if (!now.has(pid)) players.push(Object.assign({}, o, { removed_at: o.removed_at || today }));
  players.sort((a, b) => String(a.last || '').localeCompare(String(b.last || '')) || String(a.pid).localeCompare(String(b.pid)));
  return { schema: 'edgedesk_collegiate_roster_v1', school: meta.school, host: meta.host, platform: parsed.platform, sport: meta.sport,
    season: meta.season, season_label: parsed.season_label, url: meta.url, first_read: (prev && prev.first_read) || today, last_read: today,
    reads: ((prev && prev.reads) || 0) + 1, listed: now.size, players };
}

/* the labels to try for a season's own page, in order. SIDEARM names every season it keeps (season_labels.json);
   a WMT site names none, and WMT sites label a season differently ("2026", "2025-26", "2025-2026"): every form is
   tried, the one the school used for its nearest season read first. A page of another season is refused whichever
   label reached it. */
function seasonLabelsFor(school, platform, sport, season, o) {
  const known = o.labels && o.labels[school.id + '|' + sport + '|' + season];
  if (platform !== 'wmt') return [known || PL.seasonLabel(sport, season)];
  const pre = school.id + '|' + sport + '|';
  let near = null;
  for (const [k, v] of Object.entries(o.labels || {})) {
    if (!k.startsWith(pre) || !PL.labelStyle(v)) continue;
    const d = Math.abs(+k.slice(pre.length) - season);
    if (!near || d < near.d) near = { d, style: PL.labelStyle(v) };
  }
  const all = PL.seasonLabels(sport, season);
  const ordered = near ? all.filter((l) => PL.labelStyle(l) === near.style).concat(all.filter((l) => PL.labelStyle(l) !== near.style)) : all;
  return [...new Set([known].concat(ordered).filter(Boolean))];
}

/* the pages to try for a season, in order: the current season's plain roster page answers on every platform */
function candidates(school, platform, sport, season, o) {
  const plain = '/sports/' + sport + '/roster';
  const out = [];
  if (!platform) return [plain];                                     /* learn the platform from the plain page first */
  if (season >= currentSeason(sport, o.today) - 1) out.push(plain);
  for (const label of seasonLabelsFor(school, platform, sport, season, o)) out.push(PL.rosterPath(platform, sport, label));
  return [...new Set(out)];
}

async function collectOne(polite, school, sport, season, o) {
  const plat = o.platforms[school.id] || {};
  const miss = (code, why, url) => ({ ok: false, school: school.id, sport, season, url: url || null, code, why });
  /* a site judged unread by the page's markup (Nuxt data and SIDEARM's older pages both looked for) is left a month;
     an older verdict, made before SIDEARM's older sites were read, is retried */
  if (plat.platform === 'unread' && plat.by === 'markup' && plat.checked && Date.parse(o.today) - Date.parse(plat.checked) < 30 * DAY) return miss('PLATFORM_NOT_READ', 'the site is not built on a platform we read (checked ' + plat.checked + ')');
  const known = ['sidearm', 'sidearm_legacy', 'wmt'].includes(plat.platform) ? plat.platform : null;
  const past = season < currentSeason(sport, o.today);
  let last = null;
  for (const p of candidates(school, known, sport, season, o)) {
    const url = 'https://' + school.host + p;
    /* pages are parsed and dropped (noStore): a run reads thousands of 1-4 MB pages and keeps only the snapshots */
    const r = await polite.get(url, { ttlMs: past && p !== '/sports/' + sport + '/roster' ? 30 * DAY : 12 * 3600 * 1000, noStore: true });
    if (!r.ok) { last = miss(r.refused ? 'REFUSED' : 'HTTP', (r.error && r.error.message) || 'no answer', url); if (r.refused) return last; continue; }
    const html = r.text();
    const parsed = PL.parseRoster(html, sport);
    if (!parsed) {
      if (!known) {
        /* no roster on the page, but the page still says what built it: learn the platform and try the season's own page */
        const plat = PL.detectPlatformHtml(html);
        if (!plat) { o.platforms[school.id] = { platform: 'unread', by: 'markup', checked: o.today, url }; return miss('PLATFORM_NOT_READ', 'the page is not built on a platform we read', url); }
        o.platforms[school.id] = { platform: plat, by: 'markup', checked: o.today, url };
        return collectOne(polite, school, sport, season, o);
      }
      last = miss('NO_ROSTER', 'the page carries no roster (the sport is not played here, or the season is not posted)', url); continue;
    }
    if (!known) o.platforms[school.id] = { platform: parsed.platform, by: 'markup', checked: o.today, url };
    for (const s of parsed.seasons || []) if (s.season) o.labels[school.id + '|' + sport + '|' + s.season] = s.label;
    /* the season the page is, keyed with the sport asked for (a fall sport's "2026-27" is its 2026 season) */
    parsed.season = PL.seasonKey(parsed.season_label, sport);
    if (parsed.season !== season) {
      last = miss('SEASON_MISMATCH', 'the page is the ' + parsed.season_label + ' roster', url);
      if (!known) return collectOne(polite, school, sport, season, o);   /* now that we know the platform, try the season's own page */
      continue;
    }
    if ((parsed.sport || parsed.sport_name) && !PL.sportMatches(sport, parsed.sport, parsed.sport_name)) { last = miss('SPORT_MISMATCH', 'the page is ' + (parsed.sport_name || parsed.sport), url); continue; }
    if (!parsed.players.length) { last = miss('EMPTY_ROSTER', 'the ' + parsed.season_label + ' roster lists nobody yet', url); continue; }
    const file = path.join(o.dataDir, 'rosters', sport, String(season), school.id + '.json');
    const prev = readJson(file, null);
    if (prev && prev.listed >= 8 && parsed.players.length < prev.listed / 2) return miss('SHRUNK', 'this read lists ' + parsed.players.length + ' players, the last ' + prev.listed + ': not merged', url);
    const snap = mergeSnapshot(prev, parsed, { school: school.id, host: school.host, sport, season, url }, o.today);
    writeSnapshot(file, snap);
    /* the label that reached the season (a WMT site names no list of its seasons) */
    const used = p.match(/\/season\/([^/]+)$/);
    if (parsed.platform === 'wmt') o.labels[school.id + '|' + sport + '|' + season] = used ? decodeURIComponent(used[1]) : parsed.season_label;
    return { ok: true, school: school.id, sport, season, url, platform: parsed.platform, listed: snap.listed, removed: snap.players.filter((x) => x.removed_at).length };
  }
  return last || miss('NO_PAGE', 'no page to try');
}

async function collect(o) {
  const today = o.today || new Date().toISOString().slice(0, 10);
  const dataDir = o.dataDir || DATA;
  const all = o.schoolsList || loadSchools(dataDir);
  const division = o.division == null ? 1 : o.division;
  const schools = all.filter((s) => s.host && (o.schools ? o.schools.includes(s.id) : (division === 'all' || s.division === division)));
  const polite = o.polite || createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(ROOT, '.cache', 'collegiate'),
    refusalsPath: o.refusalsPath, log: o.log || ((m) => console.error(m)) });
  const labelsFile = path.join(dataDir, 'season_labels.json');
  const platformsFile = path.join(dataDir, 'platforms.json');
  const ctx = { today, dataDir, labels: readJson(labelsFile, {}), platforms: readJson(platformsFile, {}) };
  /* the seasons to read: a list for every sport, or per sport; by default its current season and the one before (what the ledger compares) */
  const seasonsOf = (sp) => (typeof o.seasons === 'function' ? o.seasons(sp) : o.seasons) || [currentSeason(sp, today) - 1, currentSeason(sp, today)];
  const results = [];
  /* schools in parallel, several hosts at a time; one school's pages in order, newest season first (it names the older ones) */
  const queue = schools.slice();
  const lanes = Math.max(1, Math.min(o.lanes || 32, queue.length));      /* SIDEARM asks 30 s between reads of one host: many hosts at once, each one slowly */
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      for (const sport of o.sports) for (const season of seasonsOf(sport).slice().sort((a, b) => b - a)) {
        if (o.skip && o.skip(s.id, sport, season)) continue;
        const res = await collectOne(polite, s, sport, season, ctx);
        results.push(res);
        if (o.log !== false) console.error((res.ok ? 'ok   ' : 'miss ') + s.id + ' ' + sport + ' ' + season + (res.ok ? '  ' + res.listed + ' listed' : '  ' + res.code + ': ' + res.why));
        if (!res.ok && (res.code === 'REFUSED' || res.code === 'PLATFORM_NOT_READ')) break;
      }
    }
  }));
  writeJson(labelsFile, ctx.labels);
  writeJson(platformsFile, ctx.platforms);
  const byCode = {};
  for (const r of results) if (!r.ok) byCode[r.code] = (byCode[r.code] || 0) + 1;
  const run = { schema: 'edgedesk_collegiate_run_v1', at: new Date().toISOString(), today, division, plan: o.sports.map((sp) => ({ sport: sp, seasons: seasonsOf(sp) })),
    schools: schools.length, ok: results.filter((r) => r.ok).length, read_schools: [...new Set(results.filter((r) => r.ok).map((r) => r.school))].sort(), misses_by_reason: byCode,
    platforms: Object.values(ctx.platforms).reduce((a, p) => (a[p.platform] = (a[p.platform] || 0) + 1, a), {}),
    misses: results.filter((r) => !r.ok), refusals: polite.refusals() };
  writeJson(path.join(dataDir, 'runs', today + '.json'), run);
  return run;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd !== 'collect') { console.error('usage: node collegiate/rosters.js collect [--sports a,b] [--seasons 2025,2026 | 2014-2026] [--schools x,y] [--division 1|all] [--today YYYY-MM-DD]'); process.exit(2); }
  const today = a.today || new Date().toISOString().slice(0, 10);
  const sports = String(a.sports || 'baseball,softball,football,mens-basketball,womens-basketball').split(',');
  let seasons = null;
  if (a.seasons) {
    const m = String(a.seasons).match(/^(\d{4})-(\d{4})$/);
    seasons = m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i) : String(a.seasons).split(',').map(Number);
  }
  const run = await collect({ sports, seasons, today, lanes: a.lanes ? +a.lanes : undefined, schools: a.schools ? String(a.schools).split(',') : null, division: a.division === 'all' ? 'all' : a.division ? +a.division : 1 });
  console.error('[rosters] ' + run.schools + ' schools: ' + run.ok + ' read, misses ' + JSON.stringify(run.misses_by_reason) + ', platforms ' + JSON.stringify(run.platforms) + ', ' + run.refusals.length + ' host(s) refusing');
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { collect, collectOne, mergeSnapshot, currentSeason, loadSchools, candidates, seasonLabelsFor, writeSnapshot, READERS };
