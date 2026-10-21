#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the school registry, from the NCAA's own directory.

     node collegiate/directory.js build [--max N] [--only slug,slug]

   ncaa.com lists every member school (/schools-index/0..N, 50 a page), and
   each school's page (/schools/<slug>) names its conference, nickname and
   official athletics website. Its robots.txt allows both (probe round 2,
   collegiate/probe/index.json). We read them through collegiate/polite.js
   (EdgeDeskBot, robots.txt, 2 s apart) and write

     collegiate/data/schools.json   { schools: [{ id, name, full_name,
                                       nickname, conference, host, ... }] }

   A school's division comes from our own college baseball record
   (college_baseball/data/teams/team_seasons.csv, NCAA names) where the
   names agree; a school without baseball takes its conference's division
   when every school of that conference we matched is in one division;
   otherwise it is left empty, never guessed. The platform a
   school's site is built on is learnt by the roster collector, from a page
   it actually parsed (collegiate/data/platforms.json).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { createPolite } = require('./polite');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'data', 'schools.json');
const BASE = 'https://www.ncaa.com';
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* one index page: [{ id, name, full_name }] */
function parseIndex(html) {
  const out = [];
  const re = /<td>\s*<a href="\/schools\/([a-z0-9-]+)">([^<]+)<\/a>\s*<\/td>\s*<td>([^<]*)<\/td>/g;
  for (let m; (m = re.exec(html));) out.push({ id: m[1], name: decode(m[2]), full_name: decode(m[3]) || null });
  return out;
}
/* one school page: conference, nickname, the athletics website */
function parseSchool(html) {
  const h = String(html || '');
  const dd = (label) => { const m = h.match(new RegExp('<dt>\\s*' + label + '\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>', 'i')); return m ? decode(m[1].replace(/<[^>]+>/g, '')) || null : null; };
  let website = null;
  const links = h.indexOf('school-links');
  if (links >= 0) {
    const re = /<a\s+href="(https?:\/\/[^"]+)"[^>]*>\s*<span class="icon-web"/g;
    re.lastIndex = links;
    const m = re.exec(h);
    if (m) website = m[1];
  }
  return { conference: dd('Conference'), nickname: dd('Nickname'), website, host: hostOf(website) };
}

/* the host a website names. A scheme written twice ("https://https://x.com/") still names x.com exactly; anything
   that reads as no real host ("https://https//x.com" reads as host "https") is no host, never a guess */
function hostOf(website) {
  if (!website) return null;
  const tries = [String(website).trim()];
  const twice = tries[0].match(/^https?:\/\/(https?:\/\/.+)$/i);
  if (twice) tries.unshift(twice[1]);
  for (const w of tries) {
    let host = null;
    try { host = new URL(w).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { host = null; }
    if (host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return host;
  }
  return null;
}

/* our own NCAA-named record: name -> { division, baseball_team_id } (the latest season) */
const keyName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\bst\b\.?/g, 'state').replace(/[^a-z0-9]/g, '');
function ncaaRecord(file) {
  const p = file || path.join(ROOT, 'college_baseball', 'data', 'teams', 'team_seasons.csv');
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  const ix = (k) => head.indexOf(k);
  for (const line of lines) {
    const c = line.split(',');
    const season = +c[ix('season')]; const k = keyName(c[ix('name')]);
    const prev = map.get(k);
    if (!prev || season > prev.season) map.set(k, { season, division: +c[ix('division')] || null, baseball_team_id: c[ix('team_id')], ncaa_name: c[ix('name')] });
  }
  return map;
}

async function build(o) {
  const polite = o.polite || createPolite({ hosts: ['ncaa.com'], cacheDir: path.join(ROOT, '.cache', 'collegiate_directory'), refusalsPath: o.refusalsPath,
    perHost: { perRun: 2000, perDay: 2000, minIntervalMs: 2000 }, log: o.log || ((m) => console.error(m)) });
  const outFile = o.out || OUT;
  const prev = readJson(outFile, { schools: [] });
  const keep = new Map((prev.schools || []).map((s) => [s.id, s]));
  const rec = ncaaRecord(o.recordFile);
  /* the index, page by page, until a page lists nobody */
  const listed = [];
  for (let i = 0; i < 60; i++) {
    const r = await polite.get(BASE + (i === 0 ? '/schools-index' : '/schools-index/' + i), { ttlMs: 7 * 24 * 3600 * 1000 });
    if (!r.ok) { if (i === 0) throw new Error('the directory index did not answer: ' + ((r.error && r.error.message) || r.status)); break; }
    const rows = parseIndex(r.text());
    if (!rows.length) break;
    listed.push(...rows);
  }
  const only = o.only ? new Set(o.only) : null;
  const todo = listed.filter((s) => !only || only.has(s.id)).slice(0, o.max || Infinity);
  const misses = [];
  for (const s of todo) {
    const r = await polite.get(BASE + '/schools/' + s.id, { ttlMs: 30 * 24 * 3600 * 1000 });
    if (!r.ok) { misses.push({ id: s.id, why: (r.error && r.error.message) || 'HTTP ' + r.status }); continue; }
    const page = parseSchool(r.text());
    const old = keep.get(s.id) || {};
    const ours = rec.get(keyName(s.name)) || rec.get(keyName(s.full_name)) || null;
    keep.set(s.id, Object.assign({}, old, s, page, {
      division: ours ? ours.division : null, division_source: ours ? 'our_record' : null,
      baseball_team_id: ours ? ours.baseball_team_id : (old.baseball_team_id || null),
      ncaa_name: ours ? ours.ncaa_name : (old.ncaa_name || null),
      source: BASE + '/schools/' + s.id, read_at: o.today || new Date().toISOString().slice(0, 10) }));
    if (o.log !== false && keep.size % 100 === 0) console.error('[directory] ' + keep.size + ' schools');
  }
  /* a school our record does not name (no baseball) takes its division from its conference, when every
     school of that conference we could match is in one division */
  const confDiv = new Map();
  for (const s of keep.values()) if (s.conference && s.division && s.division_source !== 'conference') { if (!confDiv.has(s.conference)) confDiv.set(s.conference, new Set()); confDiv.get(s.conference).add(s.division); }
  for (const s of keep.values()) {
    if (s.division && s.division_source !== 'conference') { s.division_source = 'our_record'; continue; }
    const ds = s.conference && confDiv.get(s.conference);
    if (ds && ds.size === 1) Object.assign(s, { division: [...ds][0], division_source: 'conference' }); else Object.assign(s, { division: null, division_source: null });
  }
  const schools = [...keep.values()].sort((a, b) => a.id.localeCompare(b.id));
  const out = { schema: 'edgedesk_collegiate_schools_v1', source: BASE + '/schools-index', built_at: new Date().toISOString(),
    note: 'Every NCAA member school as ncaa.com lists it, with the athletics website its page names. division and baseball_team_id come from our college baseball record where the NCAA names agree; the platform of each site is learnt by the roster collector (platforms.json).',
    counts: { listed: listed.length, schools: schools.length, with_host: schools.filter((s) => s.host).length, with_division: schools.filter((s) => s.division).length,
      d1: schools.filter((s) => s.division === 1).length, misses: misses.length },
    misses, schools };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'build') { console.error('usage: node collegiate/directory.js build [--max N] [--only slug,slug]'); process.exit(2); }
  const a = {}; for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const out = await build({ max: a.max ? +a.max : null, only: a.only ? a.only.split(',') : null });
  console.error('[directory] ' + JSON.stringify(out.counts));
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { build, parseIndex, parseSchool, hostOf, ncaaRecord, keyName };
