#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — one run of the collector, as collegiate/plan.json
   says: the school registry when it is missing or old (directory.js), every
   weekly sport's current and previous season (rosters.js), schedules and
   results (schedules.js), any backfill not yet done, a slice of the box
   scores the held schedules link (boxscores.js), then the portal ledger for
   every season with its previous one (portal.js). collegiate-rosters.yml runs it weekly, and on a branch when
   the plan changes.

     node collegiate/run.js [--today YYYY-MM-DD] [--skip-directory] [--only-backfill | --skip-backfill] [--force]

   The weekly workflow runs --skip-backfill (registry, rosters, schedules,
   ledger); the daily one --only-backfill (past seasons and box-score
   slices, then the ledger), so neither nears a runner's time limit.

   --force reads the weekly sports even when they were read in the last six
   days (a plan change on its own does not re-read them).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const DIR = require('./directory');
const RO = require('./rosters');
const SC = require('./schedules');
const BX = require('./boxscores');
const PO = require('./portal');
const { createPolite } = require('./polite');

const DATA_DIR = path.join(__dirname, 'data');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
/* "2013-2026", "2013-current" (to the sport's current season on the run's date), or "2019,2021" */
const range = (spec, sport, today) => {
  const m = String(spec).match(/^(\d{4})-(\d{4}|current)$/);
  if (!m) return String(spec).split(',').map(Number);
  const end = m[2] === 'current' ? RO.currentSeason(sport || 'baseball', today || new Date().toISOString().slice(0, 10)) : +m[2];
  return Array.from({ length: Math.max(0, end - +m[1] + 1) }, (_, i) => +m[1] + i);
};
/* what each collector can read. A backfill marked complete when its collector read less is opened again: only the
   seasons not held are read (a past season does not change; the weekly run reads the current one and the last) */
const READERS = { rosters: RO.READERS, schedules: SC.READERS };

async function run(o) {
  const today = o.today || new Date().toISOString().slice(0, 10);
  const DATA = o.dataDir || DATA_DIR;
  const plan = readJson(o.planFile || path.join(__dirname, 'plan.json'), null);
  if (!plan) throw new Error('collegiate/plan.json is missing');
  const summary = { today, steps: [] };

  /* 1. the registry */
  const reg = readJson(path.join(DATA, 'schools.json'), null);
  const age = reg ? (Date.parse(today) - Date.parse(reg.built_at)) / 86400000 : Infinity;
  if (!o.skipDirectory && (!reg || age > (plan.directory_max_age_days || 30))) {
    const d = await DIR.build({ today });
    summary.steps.push({ step: 'directory', counts: d.counts });
    console.error('[run] directory ' + JSON.stringify(d.counts));
  }

  /* 1b. a registry host that gave nothing last run is replaced by the site the school's opponents name for it */
  const fixed = require('./hosts').update(DATA, readJson(path.join(DATA, 'schools.json'), { schools: [] }).schools || []);
  if (Object.keys(fixed).length) { summary.steps.push({ step: 'hosts', corrected: fixed }); console.error('[run] hosts corrected: ' + Object.entries(fixed).map(([k, v]) => k + ' ' + v.registry_host + ' -> ' + v.host).join(', ')); }

  /* 2. the weekly read; one reader for the whole run, so a host's crawl delay holds across every step */
  const lanes = plan.lanes || 32;
  const schools = RO.loadSchools(DATA).filter((s) => s.host && (plan.division === 'all' || s.division === plan.division));
  const polite = o.polite || createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  /* a sport read in the last 6 days is not read again because the plan changed (the weekly run reads it) */
  const lastRun = readJson(path.join(DATA, 'last_run.json'), {});
  const readAt = Object.assign({}, lastRun.weekly_read_at || {});
  const fresh = (key) => !o.force && readAt[key] && (Date.parse(today) - Date.parse(readAt[key])) / 86400000 < 6;
  const weeklySports = ((plan.weekly && plan.weekly.sports) || []).filter((sp) => !fresh('rosters:' + sp));
  if (!o.onlyBackfill && weeklySports.length) {
    const r = await RO.collect({ polite, sports: weeklySports, today, division: plan.division, lanes, log: o.log, dataDir: DATA });
    for (const sp of weeklySports) readAt['rosters:' + sp] = today;
    summary.steps.push({ step: 'weekly', sports: weeklySports, schools: r.schools, ok: r.ok, misses_by_reason: r.misses_by_reason, platforms: r.platforms });
    console.error('[run] weekly ' + r.ok + ' read, misses ' + JSON.stringify(r.misses_by_reason));
  }

  /* 2b. schedules and results: each plan sport's current season */
  if (!o.onlyBackfill && plan.schedules && (plan.schedules.sports || []).length) {
    for (const sp of plan.schedules.sports.filter((x) => !fresh('schedules:' + x))) {
      readAt['schedules:' + sp] = today;
      const r = await SC.collect({ polite, sports: [sp], seasons: [RO.currentSeason(sp, today) - 1, RO.currentSeason(sp, today)], today, division: plan.division, lanes, log: o.log, dataDir: DATA });
      summary.steps.push({ step: 'schedules', sport: sp, ok: r.ok, misses_by_reason: r.misses_by_reason });
      console.error('[run] schedules ' + sp + ' ' + r.ok + ' read, misses ' + JSON.stringify(r.misses_by_reason));
    }
  }

  /* 3. backfills not yet done (rosters, or schedules with kind: "schedules") */
  const doneFile = path.join(DATA, 'backfill.json');
  const done = readJson(doneFile, {});
  for (const b of o.skipBackfill ? [] : plan.backfill || []) {
    const kind = b.kind === 'schedules' ? 'schedules' : 'rosters';
    const prev = done[b.id];
    if (prev && prev.complete && prev.readers === READERS[kind]) continue;
    const seasons = range(b.seasons, b.sport, today);
    const held = (school, sport, season) => season < RO.currentSeason(sport, today) && fs.existsSync(path.join(DATA, kind, sport, String(season), school + '.json'));
    const r = await (kind === 'schedules' ? SC : RO).collect({ polite, sports: [b.sport], seasons, today, division: plan.division, lanes, log: o.log, skip: held, dataDir: DATA });
    const hard = (r.misses_by_reason.HTTP || 0) + (r.misses_by_reason.SHRUNK || 0);
    done[b.id] = { sport: b.sport, seasons: b.seasons, kind, readers: READERS[kind], at: today, read_this_run: r.ok, misses_by_reason: r.misses_by_reason,
      /* complete once nothing errored, or once two runs in a row read nothing new (what errors then keeps erroring: a
         school that does not play the sport, a season its site does not keep) */
      complete: hard === 0 || (r.ok === 0 && !!prev && prev.readers === READERS[kind] && prev.read_this_run === 0) };
    writeJson(doneFile, done);
    summary.steps.push({ step: 'backfill', id: b.id, ok: r.ok, misses_by_reason: r.misses_by_reason });
    console.error('[run] backfill ' + b.id + ' ' + r.ok + ' read, misses ' + JSON.stringify(r.misses_by_reason));
  }

  /* 3a. our team ids for the schools and websites the registry ties to none, from the schedules held and our record
     (teamids.js): the box scores below join through them */
  const ids = require('./teamids').update(DATA, RO.loadSchools(DATA, { learnt: false }), { gamesDir: o.gamesDir });
  summary.steps.push({ step: 'team_ids', schools: Object.keys(ids.schools).length, hosts: Object.keys(ids.hosts).length });
  console.error('[run] team ids learnt from the schedules: ' + Object.keys(ids.schools).length + ' schools, ' + Object.keys(ids.hosts).length + ' websites');

  /* 3b. box scores for the schedules held: a per-host slice a run. The plan is made again each run from the schedules
     held (new seasons, newly read schools, the current season's games), so nothing is ever marked done for good */
  for (const b of o.skipBackfill ? [] : plan.boxscores || []) {
    const r = await BX.collect({ polite, sport: b.sport, seasons: range(b.seasons, b.sport, today), today, division: plan.division, lanes, perHost: b.per_host || 100, dataDir: DATA });
    done[b.id] = { sport: b.sport, seasons: b.seasons, kind: 'boxscores', readers: [...BX.READ].sort().join(','), at: today, planned: r.planned, unjoinable: r.unjoinable, read_this_run: r.ok, left: r.left,
      misses_by_reason: r.misses_by_reason, complete: r.planned > 0 && r.left === 0 };
    writeJson(doneFile, done);
    summary.steps.push({ step: 'boxscores', id: b.id, planned: r.planned, unjoinable: r.unjoinable, ok: r.ok, left: r.left, misses_by_reason: r.misses_by_reason });
    console.error('[run] box scores ' + b.id + ': ' + r.ok + ' read, ' + r.left + ' left of ' + r.planned + ', misses ' + JSON.stringify(r.misses_by_reason));
  }

  /* 4. the ledger, for every season we hold with its previous one */
  const root = path.join(DATA, 'rosters');
  const built = [];
  for (const sport of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const season of fs.readdirSync(path.join(root, sport)).map(Number).filter((s) => fs.existsSync(path.join(root, sport, String(s - 1)))).sort()) {
      const p = PO.build({ sport, season, dataDir: DATA });
      built.push({ sport, season, schools_both: p.coverage.schools_both, transfers: p.counts.transfers, matched_both_ends: p.counts.transfers_matched_both_ends });
    }
  }
  summary.steps.push({ step: 'portal', built });
  console.error('[run] portal ' + built.length + ' sport-seasons');
  summary.weekly_read_at = readAt;
  writeJson(path.join(DATA, 'last_run.json'), summary);
  return summary;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  run({ today: val('--today'), skipDirectory: argv.includes('--skip-directory'), onlyBackfill: argv.includes('--only-backfill'), skipBackfill: argv.includes('--skip-backfill'), force: argv.includes('--force') })
    .catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { run, range, READERS };
