'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the athletics site a school uses now, when the
   registry's (ncaa.com's) has gone dead.

   ncaa.com still names some retired domains (aggieathletics.com for Texas
   A&M, wakeforestsports.com, uoflsports.com, thesundevils.fansonly.com):
   they no longer resolve, so the collector reads nothing there. The schools
   themselves keep this current: a SIDEARM schedule page names each opponent
   beside its website. A registry host is replaced only when
     - it failed in the latest run (the school gave not one page), and
     - at least MIN_SCHOOLS other schools name the opponent with one same
       site, and none names the registry's.
   Anything else stays as the registry has it. The replacements are written
   to collegiate/data/host_corrections.json with their evidence.
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const MIN_SCHOOLS = 3;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const keyName = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\bst\b\.?/g, 'state').replace(/[^a-z0-9]/g, '');

/* which site each school's opponents name for it: id -> Map(host -> Set(listing schools)) */
function evidence(dataDir, schools) {
  const byKey = new Map();
  for (const s of schools) for (const n of [s.name, s.full_name]) { const k = keyName(n); if (!k) continue; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(s.id); }
  const ev = new Map();
  const root = path.join(dataDir, 'schedules');
  if (!fs.existsSync(root)) return ev;
  for (const sp of fs.readdirSync(root)) for (const se of fs.readdirSync(path.join(root, sp))) {
    for (const f of fs.readdirSync(path.join(root, sp, se)).filter((x) => x.endsWith('.json'))) {
      const d = readJson(path.join(root, sp, se, f), null);
      for (const g of (d && d.games) || []) {
        if (!g.opponent_host) continue;
        const ids = byKey.get(keyName(g.opponent));
        if (!ids || ids.size !== 1) continue;                 /* a name two schools share says nothing */
        const id = [...ids][0];
        if (id === d.school) continue;
        if (!ev.has(id)) ev.set(id, new Map());
        const m = ev.get(id);
        if (!m.has(g.opponent_host)) m.set(g.opponent_host, new Set());
        m.get(g.opponent_host).add(d.school);
      }
    }
  }
  return ev;
}

/* schools that gave not one page in the latest run */
function deadInLatestRun(dataDir) {
  const dir = path.join(dataDir, 'runs');
  if (!fs.existsSync(dir)) return new Set();
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort().pop();
  const run = f ? readJson(path.join(dir, f), null) : null;
  if (!run) return new Set();
  /* a host whose robots.txt never answered gave nothing; so did one that answered every page with an error,
     when the run lists the schools that did give a page (read_schools) */
  const read = new Set(run.read_schools || []);
  const bySchool = new Map();
  for (const m of run.misses || []) { if (!bySchool.has(m.school)) bySchool.set(m.school, []); bySchool.get(m.school).push(m); }
  const dead = new Set();
  for (const [s, ms] of bySchool) {
    if (read.has(s)) continue;
    const unreachable = ms.every((m) => m.code === 'REFUSED' && /did not answer/.test(m.why || ''));
    const allErrors = run.read_schools && ms.every((m) => m.code === 'HTTP' || (m.code === 'REFUSED' && /did not answer/.test(m.why || '')));
    if (unreachable || allErrors) dead.add(s);
  }
  return dead;
}

function corrections(dataDir, schools) {
  const ev = evidence(dataDir, schools);
  const dead = deadInLatestRun(dataDir);
  const out = {};
  for (const s of schools) {
    if (!dead.has(s.id) || !ev.has(s.id)) continue;
    const m = ev.get(s.id);
    if (m.has(s.host)) continue;                                                 /* some school still names the registry's */
    const ranked = [...m].sort((a, b) => b[1].size - a[1].size);
    const [host, by] = ranked[0];
    if (by.size < MIN_SCHOOLS || (ranked[1] && ranked[1][1].size * 2 > by.size)) continue;
    out[s.id] = { host, registry_host: s.host || null, named_by: by.size, examples: [...by].slice(0, 5) };
  }
  return out;
}

/* the registry with the corrections applied (each corrected school keeps its registry host as registry_host) */
function apply(schools, corr) {
  return schools.map((s) => (corr[s.id] ? Object.assign({}, s, { host: corr[s.id].host, registry_host: s.host || null, host_source: 'opponents_schedules' }) : s));
}

function update(dataDir, schools) {
  const file = path.join(dataDir, 'host_corrections.json');
  const prev = readJson(file, {});
  const found = corrections(dataDir, schools);
  const all = Object.assign({}, prev, found);
  if (Object.keys(found).length) fs.writeFileSync(file, JSON.stringify(all, null, 1) + '\n');
  return all;
}

module.exports = { evidence, corrections, apply, update, deadInLatestRun, MIN_SCHOOLS };
