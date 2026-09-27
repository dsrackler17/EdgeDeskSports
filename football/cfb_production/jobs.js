#!/usr/bin/env node
/* ============================================================================
   CFB production — the job / cron audit as code (docs/cfb-production/JOBS.md).

     registry()           football/cfb_production/jobs.json
     workflowCrons(file)  the `cron:` lines a workflow really has
     pgCrons(file)        the (name, schedule) pairs a pg_cron SQL file schedules
     drift()              registry vs the files: a cron edited in a workflow
                          without the registry (or the reverse) is a finding
     seedSql()            the cfb_job_registry seed block for
                          supabase/cfb_production.sql (tests prove they agree)
     collisions(opts)     every pair of jobs whose possible execution windows
                          overlap in a representative in-season week (UTC),
                          classified by what they share:
                            SERIALIZED      same concurrency group: queued, never concurrent
                            WRITE_COLLISION both publish the same git path: the
                                            later push re-applies ITS copy on top
                                            (tools/ci/push_generated.sh), so the
                                            last writer wins that file
                            READ_RACE       one reads what the other is publishing:
                                            it sees the previous version
                            DB_CONCURRENT   both insert into the same tables:
                                            append-only, row-level, idempotent
                          A GitHub schedule can start late (measured up to ~50
                          min, 2026-09-27), so its window is [t, t + delay + expected].

     node football/cfb_production/jobs.js [--week 2026-10-04] [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const REG = path.join(__dirname, 'jobs.json');

function registry(p) { return JSON.parse(fs.readFileSync(p || REG, 'utf8')); }

/* ------------------------------------------------------------ cron */
function field(spec, lo, hi) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    let [range, step] = part.split('/');
    step = step ? Number(step) : 1;
    let a = lo, b = hi;
    if (range !== '*') {
      if (range.includes('-')) { [a, b] = range.split('-').map(Number); }
      else { a = Number(range); b = step > 1 ? hi : a; }
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(step) || step < 1 || a < lo || b > hi || a > b) throw new Error('bad cron field ' + spec);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields: ' + expr);
  const dow = field(f[4], 0, 7);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { minute: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), month: field(f[3], 1, 12), dow,
    domStar: f[2] === '*', dowStar: f[4] === '*' };
}
function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate()), dowOk = c.dow.has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;                       // cron: either restricted day field
}
function occurrences(expr, fromMs, toMs) {
  const c = parseCron(expr);
  const out = [];
  for (let t = Math.ceil(fromMs / 60000) * 60000; t < toMs; t += 60000) if (matches(c, new Date(t))) out.push(t);
  return out;
}

/* ------------------------------------------------------------ files */
function workflowCrons(file) {
  const txt = fs.readFileSync(path.join(REPO, file), 'utf8');
  return (txt.match(/^\s*-\s*cron:\s*'([^']+)'/gm) || []).map((l) => /'([^']+)'/.exec(l)[1]);
}
function pgCrons(file) {
  const txt = fs.readFileSync(path.join(REPO, file), 'utf8');
  const out = [];
  /* literal cron.schedule('name', 'sched', ...) and the value lists / using-clauses the CFB files use */
  let m;
  const re1 = /cron\.schedule\(\s*'([a-z_]+)'\s*,\s*'([^']+)'/g;
  while ((m = re1.exec(txt))) out.push({ name: m[1], schedule: m[2] });
  const re2 = /\('(cfb_[a-z_]+)',\s*'([0-9*/,\- ]+)',\s*'select public\./g;
  while ((m = re2.exec(txt))) out.push({ name: m[1], schedule: m[2] });
  const re3 = /using\s+'(cfb_[a-z_]+)',\s*'([0-9*/,\- ]+)'/g;
  while ((m = re3.exec(txt))) out.push({ name: m[1], schedule: m[2] });
  return out;
}

function drift(reg) {
  reg = reg || registry();
  const out = [];
  for (const j of reg.jobs) {
    if (j.workflow.endsWith('.yml')) {
      const have = workflowCrons(j.workflow).slice().sort(), want = j.github_crons.slice().sort();
      if (JSON.stringify(have) !== JSON.stringify(want)) out.push({ job: j.job, file: j.workflow, registry: want, file_has: have });
    }
    for (const p of j.pg_cron) {
      const found = pgCrons(p.file).find((x) => x.name === p.name);
      if (!found || found.schedule !== p.schedule) out.push({ job: j.job, file: p.file, registry: p, file_has: found || null });
    }
  }
  return out;
}

function scheduleText(j) {
  return j.pg_cron.map((p) => p.name + ' ' + p.schedule + ' (pg_cron)').concat(j.github_crons.map((c) => c + ' (github)')).join(' | ');
}

/* the SQL block between the markers in supabase/cfb_production.sql */
function seedSql(reg) {
  reg = reg || registry();
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const rows = reg.jobs.map((j) => '  (' + [q(j.job), q(j.workflow), q(j.trigger_kind), q(scheduleText(j)), q('{' + j.season_months.join(',') + '}'),
    j.max_silence_minutes, j.expected_minutes, j.timeout_minutes, q(j.lock_scope), q(j.severity_on_miss), q(j.purpose)].join(', ') + ')');
  return 'insert into public.cfb_job_registry (job, workflow, trigger_kind, schedule, season_months, max_silence_minutes, expected_minutes,\n'
    + '  timeout_minutes, lock_scope, severity_on_miss, purpose) values\n' + rows.join(',\n') + '\n';
}
const SEED_BEGIN = '-- BEGIN jobs.json seed (generated: node football/cfb_production/jobs.js --seed-sql)\n';
const SEED_END = '-- END jobs.json seed\n';
function seedInSql(sqlText) {
  const a = sqlText.indexOf(SEED_BEGIN), b = sqlText.indexOf(SEED_END);
  return a < 0 || b < 0 ? null : sqlText.slice(a + SEED_BEGIN.length, b);
}

/* ------------------------------------------------------------ collisions */
function prefixOverlap(a, b) {
  for (const x of a) for (const y of b) {
    const X = x.replace(/\*$/, ''), Y = y.replace(/\*$/, '');
    if (X === Y || X.startsWith(Y.endsWith('/') ? Y : Y + '/') || Y.startsWith(X.endsWith('/') ? X : X + '/')
        || (x.endsWith('*') && Y.startsWith(X)) || (y.endsWith('*') && X.startsWith(Y))) return x === y ? x : x + ' ~ ' + y;
  }
  return null;
}
function windows(j, from, to, delay) {
  const out = [];
  const exp = j.expected_minutes * 60000;
  j.pg_cron.forEach((p) => occurrences(p.schedule, from, to).forEach((t) => out.push([t, t + exp, 'pg_cron'])));
  j.github_crons.forEach((c) => occurrences(c, from, to).forEach((t) => out.push([t, t + delay * 60000 + exp, 'github'])));
  return out.sort((x, y) => x[0] - y[0]);
}
function collisions(opts) {
  opts = opts || {};
  const reg = opts.registry || registry();
  const from = Date.parse((opts.week || '2026-10-04') + 'T00:00:00Z'), to = from + 7 * 86400000;
  const delay = opts.delay != null ? opts.delay : reg.github_schedule_delay_minutes;
  const W = Object.fromEntries(reg.jobs.map((j) => [j.job, windows(j, from, to, delay)]));
  const out = [];
  for (let i = 0; i < reg.jobs.length; i++) for (let k = i + 1; k < reg.jobs.length; k++) {
    const a = reg.jobs[i], b = reg.jobs[k];
    let n = 0;
    const wa = W[a.job], wb = W[b.job];
    for (const x of wa) for (const y of wb) if (x[0] < y[1] && y[0] < x[1]) n++;
    const git = prefixOverlap(a.writes_git, b.writes_git);
    const rw = prefixOverlap(a.writes_git, b.reads_git) || prefixOverlap(b.writes_git, a.reads_git);
    const dbw = prefixOverlap(a.writes_db, b.writes_db);
    const sameGroup = a.concurrency_group === b.concurrency_group && !/^none/.test(a.concurrency_group);
    let klass = 'NONE';
    if (sameGroup && (git || rw || dbw)) klass = 'SERIALIZED';
    else if (n && git) klass = 'WRITE_COLLISION';
    else if (n && rw) klass = 'READ_RACE';
    else if (n && dbw) klass = 'DB_CONCURRENT';
    if (klass !== 'NONE' || git || rw || dbw) out.push({ a: a.job, b: b.job, class: klass, overlapping_windows: n, shared_git_write: git, write_read: rw, shared_db: dbw, same_group: sameGroup });
  }
  /* a job against itself: a primary and a backup clock firing the same run */
  reg.jobs.forEach((j) => {
    const w = W[j.job];
    let n = 0;
    for (let i = 0; i < w.length; i++) for (let k = i + 1; k < w.length && w[k][0] < w[i][1]; k++) n++;
    if (n) out.push({ a: j.job, b: j.job, class: 'SERIALIZED', overlapping_windows: n, note: 'two clocks (pg_cron primary + GitHub backup) or a slow run: queued on concurrency group ' + j.concurrency_group });
  });
  return { week: new Date(from).toISOString().slice(0, 10), github_delay_minutes: delay, pairs: out };
}

module.exports = { registry, parseCron, occurrences, matches, workflowCrons, pgCrons, drift, seedSql, seedInSql, SEED_BEGIN, SEED_END, collisions, scheduleText, REG };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (a.includes('--seed-sql')) { process.stdout.write(seedSql()); process.exit(0); }
  const c = collisions({ week: arg('--week', '2026-10-04') });
  const d = drift();
  if (a.includes('--json')) { console.log(JSON.stringify({ drift: d, collisions: c }, null, 1)); process.exit(d.length ? 1 : 0); }
  console.log('registry drift: ' + (d.length ? JSON.stringify(d) : 'none'));
  console.log('collisions in the week of ' + c.week + ' (GitHub start delay allowance ' + c.github_delay_minutes + ' min):');
  c.pairs.filter((p) => p.class !== 'NONE').forEach((p) => console.log('  ' + p.class.padEnd(16) + p.a + (p.a === p.b ? '' : ' x ' + p.b) + '  windows ' + p.overlapping_windows
    + (p.shared_git_write ? '  git ' + p.shared_git_write : '') + (p.write_read ? '  read ' + p.write_read : '') + (p.shared_db ? '  db ' + p.shared_db : '') + (p.note ? '  (' + p.note + ')' : '')));
  process.exit(d.length ? 1 : 0);
}
