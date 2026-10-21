#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the portal ledger, for every college sport we hold
   rosters for (collegiate/data/rosters/<sport>/<season>/<school>.json).

     node collegiate/portal.js build [--sports baseball,football] [--seasons 2026]

   The NCAA's transfer-portal database is not public, so the ledger is built
   from what the schools themselves publish: who is on each roster, season to
   season, and the "previous school" a roster lists for a transfer.

     arrival     on school B's roster this season, not last season
     departure   on school A's roster last season, not this season (or
                 taken off this season's roster while we were reading it:
                 a move in progress, dated to the week)
     a transfer  an arrival whose listed previous school is A, and/or a
                 departure from A that matches the arrival by name plus
                 hometown or high school. The evidence is written on every
                 row; a name alone never makes a match.

   Out: collegiate/data/portal/<sport>/<season>.json — the ledger, each
   team's continuity (who came back, who left with eligibility, who came in
   and from where), the coverage (which schools had both seasons read), and
   every previous-school text we could not resolve to a school we track.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const SCHOOLS = path.join(DATA, 'schools.json');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };

/* ------------------------------------------------------------- normalising */
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function normName(first, last) {
  const f = deaccent(first).toLowerCase().replace(/(["'‘’“”]).*?\1/g, ' ').replace(/\(.*?\)/g, ' ').replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '';
  const l = deaccent(last).toLowerCase().replace(/[.,]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/[^a-z]/g, '').trim();
  return { first: f, last: l, full: f + ' ' + l, initial: f.slice(0, 1) };
}
/* US states in AP style, postal codes and full names, all to postal */
const STATES = {};
[['AL', 'Ala.', 'Alabama'], ['AK', 'Alaska', 'Alaska'], ['AZ', 'Ariz.', 'Arizona'], ['AR', 'Ark.', 'Arkansas'], ['CA', 'Calif.', 'California'], ['CO', 'Colo.', 'Colorado'],
  ['CT', 'Conn.', 'Connecticut'], ['DE', 'Del.', 'Delaware'], ['DC', 'D.C.', 'District of Columbia'], ['FL', 'Fla.', 'Florida'], ['GA', 'Ga.', 'Georgia'], ['HI', 'Hawaii', 'Hawaii'],
  ['ID', 'Idaho', 'Idaho'], ['IL', 'Ill.', 'Illinois'], ['IN', 'Ind.', 'Indiana'], ['IA', 'Iowa', 'Iowa'], ['KS', 'Kan.', 'Kansas'], ['KY', 'Ky.', 'Kentucky'], ['LA', 'La.', 'Louisiana'],
  ['ME', 'Maine', 'Maine'], ['MD', 'Md.', 'Maryland'], ['MA', 'Mass.', 'Massachusetts'], ['MI', 'Mich.', 'Michigan'], ['MN', 'Minn.', 'Minnesota'], ['MS', 'Miss.', 'Mississippi'],
  ['MO', 'Mo.', 'Missouri'], ['MT', 'Mont.', 'Montana'], ['NE', 'Neb.', 'Nebraska'], ['NV', 'Nev.', 'Nevada'], ['NH', 'N.H.', 'New Hampshire'], ['NJ', 'N.J.', 'New Jersey'],
  ['NM', 'N.M.', 'New Mexico'], ['NY', 'N.Y.', 'New York'], ['NC', 'N.C.', 'North Carolina'], ['ND', 'N.D.', 'North Dakota'], ['OH', 'Ohio', 'Ohio'], ['OK', 'Okla.', 'Oklahoma'],
  ['OR', 'Ore.', 'Oregon'], ['PA', 'Pa.', 'Pennsylvania'], ['RI', 'R.I.', 'Rhode Island'], ['SC', 'S.C.', 'South Carolina'], ['SD', 'S.D.', 'South Dakota'], ['TN', 'Tenn.', 'Tennessee'],
  ['TX', 'Texas', 'Texas'], ['UT', 'Utah', 'Utah'], ['VT', 'Vt.', 'Vermont'], ['VA', 'Va.', 'Virginia'], ['WA', 'Wash.', 'Washington'], ['WV', 'W.Va.', 'West Virginia'],
  ['WI', 'Wis.', 'Wisconsin'], ['WY', 'Wyo.', 'Wyoming']].forEach(([p, ap, full]) => { for (const k of [p, ap, full]) STATES[k.toLowerCase().replace(/[^a-z]/g, '')] = p; });
function normPlace(s) {
  const t = deaccent(s).split(/\s*[\/;]\s*/)[0];
  const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const city = parts[0].toLowerCase().replace(/\bst\.?\s/g, 'saint ').replace(/\bft\.?\s/g, 'fort ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const rest = parts.slice(1).join(' ').toLowerCase().replace(/[^a-z]/g, '');
  return city + '|' + (STATES[rest] || rest);
}
function normSchoolText(s) {
  return deaccent(s).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ').replace(/\b(st)\b\.?/g, 'state').replace(/\bhigh school\b|\bh\.?s\.?\b|\bhs\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|university|univ|of|at)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
const JUCO = /\b(community college|junior college|juco|j\.?c\.?|cc|state college of florida|college of southern nevada)\b/i;

/* previous-school text -> a school we track; the last school named is the one they came from */
function resolver(schools) {
  const map = new Map();
  for (const s of schools) for (const a of [s.name, s.id].concat(s.aliases || [])) { const k = normSchoolText(a); if (k && !map.has(k)) map.set(k, s.id); }
  return (text) => {
    if (!text) return { from: null, from_text: null, level: null, history: [] };
    const names = String(text).split(/\s*(?:\/|;|,|\band\b|→|->)\s*/).map((x) => x.trim()).filter(Boolean);
    const last = names[names.length - 1] || String(text);
    const id = map.get(normSchoolText(last)) || null;
    return { from: id, from_text: last, level: id ? 'tracked' : JUCO.test(last) ? 'juco' : 'other', history: names.slice(0, -1) };
  };
}

/* ------------------------------------------------------------------ ledger */
function loadSeason(dataDir, sport, season) {
  const dir = path.join(dataDir, 'rosters', sport, String(season));
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { const s = readJson(path.join(dir, f), null); if (s && s.players) out.set(s.school, s); }
  return out;
}
const listedAt = (snap) => new Set(snap.players.filter((p) => !p.removed_at).map((p) => p.pid));
const everAt = (snap) => new Set(snap.players.map((p) => p.pid));
const OUT_OF_ELIGIBILITY = new Set(['SR', 'GR']);

/* how strongly a departure from A and an arrival at B are the same person */
function matchScore(d, a, aFromA) {
  const nd = normName(d.first, d.last); const na = normName(a.first, a.last);
  if (!nd.last || nd.last !== na.last) return { ok: false };
  const ev = [];
  if (aFromA) ev.push('previous_school');
  const full = nd.first && nd.first === na.first; const initial = nd.initial && nd.initial === na.initial;
  if (full) ev.push('name'); else if (initial) ev.push('initial');
  const home = d.hometown && a.hometown && normPlace(d.hometown) === normPlace(a.hometown); if (home) ev.push('hometown');
  const hs = d.high_school && a.high_school && normSchoolText(d.high_school) === normSchoolText(a.high_school); if (hs) ev.push('high_school');
  const ok = (aFromA && (full || initial)) || (full && (home || hs)) || (initial && home && hs);
  return { ok, ev, strength: (aFromA ? 3 : 0) + (full ? 2 : initial ? 1 : 0) + (home ? 2 : 0) + (hs ? 2 : 0) };
}

function build(o) {
  const dataDir = o.dataDir || DATA;
  const schools = o.schoolsList || (readJson(o.schoolsFile || SCHOOLS, { schools: [] }).schools || []);
  const resolve = resolver(schools);
  const confOf = new Map(schools.map((x) => [x.id, x.conference || null]));
  const sport = o.sport; const season = o.season;
  const now = loadSeason(dataDir, sport, season); const before = loadSeason(dataDir, sport, season - 1);
  const both = [...now.keys()].filter((k) => before.has(k));

  /* arrivals at schools read both seasons */
  const arrivals = [];
  for (const b of both) {
    const prevIds = everAt(before.get(b));
    for (const p of now.get(b).players) if (!prevIds.has(p.pid)) arrivals.push(Object.assign({ to: b }, p, { prev: resolve(p.previous_school) }));
  }
  /* departures: off this season's roster at schools read both seasons, plus anyone taken off this season's roster while we read it */
  const departures = [];
  for (const a of both) {
    const nowIds = listedAt(now.get(a));
    for (const p of before.get(a).players) if (!nowIds.has(p.pid) && !now.get(a).players.some((q) => q.pid === p.pid && q.removed_at)) departures.push(Object.assign({ from: a, when: null }, p));
  }
  for (const [a, snap] of now) for (const p of snap.players) if (p.removed_at) departures.push(Object.assign({ from: a, when: p.removed_at, in_season: true }, p));

  /* match each departure to the strongest arrival elsewhere; an arrival is used once */
  const byLast = new Map();
  for (const x of arrivals) { const k = normName(x.first, x.last).last; if (!byLast.has(k)) byLast.set(k, []); byLast.get(k).push(x); }
  const used = new Set(); const ledger = [];
  for (const d of departures) {
    let best = null;
    for (const a of byLast.get(normName(d.first, d.last).last) || []) {
      if (a.to === d.from || used.has(a)) continue;
      const m = matchScore(d, a, a.prev.from === d.from);
      if (m.ok && (!best || m.strength > best.m.strength)) best = { a, m };
    }
    if (best) {
      used.add(best.a);
      ledger.push({ kind: 'transfer', player: best.a.name, from: d.from, to: best.a.to, from_pid: d.pid, to_pid: best.a.pid, class_before: d.class, class_after: best.a.class,
        pos: best.a.pos || d.pos, hometown: best.a.hometown || d.hometown, high_school: best.a.high_school || d.high_school, evidence: best.m.ev,
        left_seen: d.when, arrived_seen: best.a.first_seen });
    } else {
      ledger.push({ kind: 'departure', player: d.name, from: d.from, from_pid: d.pid, class_before: d.class, pos: d.pos,
        outcome: OUT_OF_ELIGIBILITY.has(d.class) ? 'eligibility_likely_done' : 'not_found_on_a_roster_we_read', left_seen: d.when, in_season: !!d.in_season });
    }
  }
  /* arrivals no departure matched: a listed previous school (from outside what we read, or JUCO) or a newcomer */
  for (const a of arrivals) {
    if (used.has(a)) continue;
    if (a.prev.from_text && a.class !== 'FR') ledger.push({ kind: 'transfer', player: a.name, from: a.prev.from, from_text: a.prev.from_text, from_level: a.prev.level, to: a.to, to_pid: a.pid,
      class_after: a.class, pos: a.pos, hometown: a.hometown, high_school: a.high_school, evidence: ['previous_school'], arrived_seen: a.first_seen });
    else ledger.push({ kind: 'newcomer', player: a.name, to: a.to, to_pid: a.pid, class_after: a.class, pos: a.pos, hometown: a.hometown, high_school: a.high_school, arrived_seen: a.first_seen });
  }

  /* each team's continuity, at schools read both seasons */
  const teams = both.map((s) => {
    /* returning: on this season's roster at any read (a player taken off it in April still came back) */
    const prev = before.get(s).players.filter((p) => !p.removed_at); const cur = now.get(s).players.filter((p) => !p.removed_at);
    const curIds = everAt(now.get(s));
    const returning = prev.filter((p) => curIds.has(p.pid)).length;
    const rows = ledger.filter((r) => r.to === s || r.from === s);
    const tin = rows.filter((r) => r.kind === 'transfer' && r.to === s); const tout = rows.filter((r) => r.kind === 'transfer' && r.from === s);
    const dep = rows.filter((r) => r.kind === 'departure' && r.from === s);
    return { school: s, roster_before: prev.length, roster_now: cur.length, returning, returning_share: prev.length ? +(returning / prev.length).toFixed(4) : null,
      transfers_in: tin.length, transfers_in_from_tracked: tin.filter((r) => r.from).length, transfers_in_juco: tin.filter((r) => r.from_level === 'juco').length,
      transfers_out: tout.length, departures_eligibility_done: dep.filter((r) => r.outcome === 'eligibility_likely_done').length,
      departures_other: dep.filter((r) => r.outcome !== 'eligibility_likely_done').length, newcomers: rows.filter((r) => r.kind === 'newcomer' && r.to === s).length };
  });
  /* where moves cross conference lines (the registry's conference, as ncaa.com names it) */
  for (const r of ledger) if (r.kind === 'transfer') { r.from_conference = r.from ? confOf.get(r.from) || null : null; r.to_conference = confOf.get(r.to) || null; }
  for (const t of teams) {
    const c = confOf.get(t.school);
    t.conference = c || null;
    t.transfers_in_same_conference = c ? ledger.filter((r) => r.kind === 'transfer' && r.to === t.school && r.from_conference === c).length : null;
    t.transfers_out_same_conference = c ? ledger.filter((r) => r.kind === 'transfer' && r.from === t.school && r.to_conference === c).length : null;
  }
  const unresolved = {};
  for (const r of ledger) if (r.kind === 'transfer' && !r.from && r.from_text && r.from_level !== 'juco') unresolved[r.from_text] = (unresolved[r.from_text] || 0) + 1;
  const out = { schema: 'edgedesk_collegiate_portal_v1', sport, season, built_at: new Date().toISOString(),
    note: 'Built from the rosters schools publish, season to season. Dates are when we saw a change, not portal entry dates (the NCAA portal database is not public).',
    coverage: { schools_this_season: now.size, schools_last_season: before.size, schools_both: both.length },
    counts: { transfers: ledger.filter((r) => r.kind === 'transfer').length, transfers_matched_both_ends: ledger.filter((r) => r.kind === 'transfer' && r.from_pid).length,
      departures: ledger.filter((r) => r.kind === 'departure').length, newcomers: ledger.filter((r) => r.kind === 'newcomer').length },
    teams, ledger, unresolved_previous_schools: unresolved };
  if (o.write !== false) writeJson(path.join(dataDir, 'portal', sport, season + '.json'), out);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'build') { console.error('usage: node collegiate/portal.js build [--sports a,b] [--seasons 2026]'); process.exit(2); }
  const a = {}; for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  const root = path.join(DATA, 'rosters');
  const sports = a.sports ? a.sports.split(',') : (fs.existsSync(root) ? fs.readdirSync(root) : []);
  for (const sport of sports) {
    const seasons = a.seasons ? a.seasons.split(',').map(Number) : (fs.existsSync(path.join(root, sport)) ? fs.readdirSync(path.join(root, sport)).map(Number).filter((s) => fs.existsSync(path.join(root, sport, String(s - 1)))) : []);
    for (const season of seasons) {
      const r = build({ sport, season });
      console.error('[portal] ' + sport + ' ' + season + ': ' + r.counts.transfers + ' transfers (' + r.counts.transfers_matched_both_ends + ' seen at both schools), ' + r.counts.departures + ' departures, ' + r.counts.newcomers + ' newcomers; ' + r.coverage.schools_both + ' schools read both seasons');
    }
  }
}

if (require.main === module) main();
module.exports = { build, normName, normPlace, normSchoolText, resolver, matchScore };
