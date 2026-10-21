#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — one run of the collector, as collegiate/plan.json
   says: the school registry when it is missing or old (directory.js), every
   weekly sport's current and previous season (rosters.js), any backfill not
   yet done, then the portal ledger for every season with its previous one
   (portal.js). collegiate-rosters.yml runs it weekly, and on a branch when
   the plan changes.

     node collegiate/run.js [--today YYYY-MM-DD] [--skip-directory] [--only-backfill]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const DIR = require('./directory');
const RO = require('./rosters');
const PO = require('./portal');
const { createPolite } = require('./polite');

const DATA = path.join(__dirname, 'data');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1) + '\n'); };
const range = (spec) => { const m = String(spec).match(/^(\d{4})-(\d{4})$/); return m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i) : String(spec).split(',').map(Number); };

async function run(o) {
  const today = o.today || new Date().toISOString().slice(0, 10);
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

  /* 2. the weekly read; one reader for the whole run, so a host's crawl delay holds across every step */
  const lanes = plan.lanes || 32;
  const schools = RO.loadSchools(DATA).filter((s) => s.host && (plan.division === 'all' || s.division === plan.division));
  const polite = o.polite || createPolite({ hosts: [...new Set(schools.map((s) => s.host))], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate'), log: (m) => console.error(m) });
  if (!o.onlyBackfill && plan.weekly && plan.weekly.sports && plan.weekly.sports.length) {
    const r = await RO.collect({ polite, sports: plan.weekly.sports, today, division: plan.division, lanes, log: o.log });
    summary.steps.push({ step: 'weekly', schools: r.schools, ok: r.ok, misses_by_reason: r.misses_by_reason, platforms: r.platforms });
    console.error('[run] weekly ' + r.ok + ' read, misses ' + JSON.stringify(r.misses_by_reason));
  }

  /* 3. backfills not yet done */
  const doneFile = path.join(DATA, 'backfill.json');
  const done = readJson(doneFile, {});
  for (const b of plan.backfill || []) {
    if (done[b.id] && done[b.id].complete) continue;
    const r = await RO.collect({ polite, sports: [b.sport], seasons: range(b.seasons), today, division: plan.division, lanes, log: o.log });
    const hard = (r.misses_by_reason.HTTP || 0) + (r.misses_by_reason.SHRUNK || 0);
    done[b.id] = { sport: b.sport, seasons: b.seasons, at: today, ok: r.ok, misses_by_reason: r.misses_by_reason,
      /* complete once a run has nothing left it could still read: a page that errored is tried again next week */
      complete: hard === 0 || (done[b.id] && done[b.id].ok === r.ok) };
    writeJson(doneFile, done);
    summary.steps.push({ step: 'backfill', id: b.id, ok: r.ok, misses_by_reason: r.misses_by_reason });
    console.error('[run] backfill ' + b.id + ' ' + r.ok + ' read, misses ' + JSON.stringify(r.misses_by_reason));
  }

  /* 4. the ledger, for every season we hold with its previous one */
  const root = path.join(DATA, 'rosters');
  const built = [];
  for (const sport of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    for (const season of fs.readdirSync(path.join(root, sport)).map(Number).filter((s) => fs.existsSync(path.join(root, sport, String(s - 1)))).sort()) {
      const p = PO.build({ sport, season });
      built.push({ sport, season, schools_both: p.coverage.schools_both, transfers: p.counts.transfers, matched_both_ends: p.counts.transfers_matched_both_ends });
    }
  }
  summary.steps.push({ step: 'portal', built });
  console.error('[run] portal ' + built.length + ' sport-seasons');
  writeJson(path.join(DATA, 'last_run.json'), summary);
  return summary;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  run({ today: val('--today'), skipDirectory: argv.includes('--skip-directory'), onlyBackfill: argv.includes('--only-backfill') })
    .catch((e) => { console.error(e.stack || e); process.exit(1); });
}
module.exports = { run, range };
