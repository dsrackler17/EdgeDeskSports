#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — one session per subsystem.

   WHY. #799 and #800 were written at the same time by two sessions, and both
   fixed the same function (distributionSpread in lib/edgedesk_quote_ev.js).
   Whichever merged second was certain to conflict on exactly those lines, and
   that conflict is the one resolved by deleting both sides. A conflict that
   two parallel sessions are bound to create should be refused when the
   second pull request opens, not discovered at merge time.

   THE RULE. Every open pull request into main CLAIMS what it changes:
     a subsystem   a path matching tools/integrity/subsystems.json claims the
                   whole subsystem (its code and its tests)
     a region      a hotspot (app.html, package.json, …) claims the lines it
                   changes, ± hotspot_margin_lines
     a file        any other path claims that file
   Generated files (tools/integrity/ownership.js) and changelog.d/ fragments
   claim nothing. The OLDER pull request (created first) holds a claim; a newer
   one that overlaps it fails this check, naming the holder, until the holder
   merges or closes (the integrity-revalidate workflow re-runs this check when
   it does). A claim lapses when its pull request has had no activity for
   stale_after_hours. A person can let two run in parallel with the
   `parallel-ok` label on the newer one.

     node tools/integrity/gate.js lock --pr <n>        (CI)
     node tools/integrity/lock.js --keys <path>...     what these paths claim
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const O = require('./ownership');
const GH = require('./github');

const ROOT = path.join(__dirname, '..', '..');
const LABEL_PARALLEL = 'parallel-ok';

function loadConfig(root) {
  const c = JSON.parse(fs.readFileSync(path.join(root || ROOT, 'tools', 'integrity', 'subsystems.json'), 'utf8'));
  c.compiled = c.subsystems.map((s) => ({ name: s.name, res: s.paths.map((p) => O.globToRegExp(p)) }));
  return c;
}

/* Old-side line ranges of a unified diff's hunks. */
function hunkRanges(patch) {
  const out = [];
  if (!patch) return null;
  const re = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  let m;
  while ((m = re.exec(patch))) {
    const a = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    out.push([a, a + Math.max(n, 1) - 1]);
  }
  return out;
}

/* What a set of changed files claims: Map key -> { kind, files, ranges } */
function lockKeys(files, config) {
  const keys = new Map();
  for (const f of files) {
    const p = f.filename;
    if (p.startsWith('changelog.d/')) continue;
    if (O.classify(p).class === 'generated') continue;
    let key, kind;
    if (config.hotspots.includes(p)) { key = 'region:' + p; kind = 'region'; }
    else {
      const s = config.compiled.find((x) => x.res.some((re) => re.test(p)));
      if (s) { key = 'subsystem:' + s.name; kind = 'subsystem'; } else { key = 'file:' + p; kind = 'file'; }
    }
    const e = keys.get(key) || { kind, files: [], ranges: [] };
    e.files.push(p);
    if (kind === 'region') {
      const r = hunkRanges(f.patch);
      if (r === null || f.status === 'added' || f.status === 'removed') e.ranges.push([1, Infinity]);   // no patch: the whole file
      else e.ranges.push(...r);
    }
    keys.set(key, e);
  }
  return keys;
}

function overlaps(a, b, margin) {
  for (const [x1, x2] of a) for (const [y1, y2] of b) if (x1 <= y2 + margin && y1 <= x2 + margin) return [Math.max(x1, y1), Math.min(x2, y2)];
  return null;
}

/* The claims `mine` shares with `theirs`. */
function collisions(mine, theirs, config) {
  const out = [];
  for (const [key, e] of mine) {
    const t = theirs.get(key);
    if (!t) continue;
    if (e.kind === 'region') {
      const o = overlaps(e.ranges, t.ranges, config.hotspot_margin_lines || 0);
      if (o) out.push({ key, what: e.files[0] + (Number.isFinite(o[1]) ? ' around line ' + Math.max(1, o[0]) : '') });
    } else out.push({ key, what: e.kind === 'subsystem' ? 'the ' + key.slice('subsystem:'.length) + ' subsystem (' + e.files.slice(0, 3).join(', ') + (e.files.length > 3 ? ', …' : '') + ' here; ' + t.files.slice(0, 3).join(', ') + (t.files.length > 3 ? ', …' : '') + ' there)' : e.files[0] });
  }
  return out;
}

function older(a, b) {
  /* is pull request a older than b? created first; the lower number on a tie */
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.number < b.number);
}

async function prFiles(repo, n) {
  return GH.paginate('/repos/' + repo + '/pulls/' + n + '/files', null, { cwd: ROOT });
}

async function main(args) {
  const pr = Number((args[args.indexOf('--pr') + 1]) || process.env.PR_NUMBER);
  const repo = GH.repo();
  if (!pr || !repo || !GH.token(ROOT)) { console.error('lock: needs --pr, GITHUB_REPOSITORY and a token'); return 2; }
  const config = loadConfig();
  const open = await GH.paginate('/repos/' + repo + '/pulls?state=open', null, { cwd: ROOT });
  const me = open.find((p) => p.number === pr);
  if (!me) { console.log('pull request #' + pr + ' is not open; nothing to hold'); return 0; }
  const base = me.base && me.base.ref;
  const labels = (me.labels || []).map((l) => l.name);
  const staleMs = (config.stale_after_hours || 72) * 3600e3;
  const now = Date.now();
  const mine = lockKeys(await prFiles(repo, pr), config);
  const rows = [], stale = [];
  for (const other of open) {
    if (other.number === pr || (other.base && other.base.ref) !== base || !older(other, me)) continue;
    if (now - Date.parse(other.updated_at) > staleMs) { stale.push(other); continue; }
    const hits = collisions(mine, lockKeys(await prFiles(repo, other.number), config), config);
    if (hits.length) rows.push({ other, hits });
  }
  const lines = ['### Subsystem lock: ' + (rows.length ? (labels.includes(LABEL_PARALLEL) ? '⚠️ overlaps allowed by `' + LABEL_PARALLEL + '`' : '❌ held by an older pull request') : '✅ nothing this pull request changes is held by another'), ''];
  lines.push('This pull request claims: ' + ([...mine.keys()].map((k) => '`' + k + '`').join(', ') || 'nothing (generated files and changelog fragments only)'));
  for (const r of rows) {
    lines.push('', '- **#' + r.other.number + '** “' + r.other.title + '” (' + (r.other.draft ? 'draft, ' : '') + 'opened ' + r.other.created_at.slice(0, 16).replace('T', ' ') + ' UTC) already changes:');
    r.hits.forEach((h) => lines.push('  - ' + h.what));
  }
  if (rows.length && !labels.includes(LABEL_PARALLEL)) lines.push('', 'Wait for the pull request(s) above to merge or close — this check re-runs by itself when they do — then merge main into this branch. If both must proceed in parallel, a person adds the `' + LABEL_PARALLEL + '` label here.');
  if (stale.length) lines.push('', 'Lapsed claims (no activity for ' + (config.stale_after_hours || 72) + ' h), ignored: ' + stale.map((p) => '#' + p.number).join(', '));
  const md = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  if (rows.length && !labels.includes(LABEL_PARALLEL)) {
    rows.forEach((r) => console.log('::error title=subsystem lock::#' + r.other.number + ' already changes ' + r.hits.map((h) => h.what).join('; ')));
    return 1;
  }
  return 0;
}

module.exports = { main, loadConfig, lockKeys, collisions, hunkRanges, older, LABEL_PARALLEL };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--keys') {
    const config = loadConfig();
    const keys = lockKeys(args.slice(1).map((f) => ({ filename: f, status: 'modified', patch: null })), config);
    for (const [k, e] of keys) console.log(k + '  ←  ' + e.files.join(', '));
    process.exit(0);
  }
  main(args).then((c) => process.exit(c), (e) => { console.error('lock could not run: ' + (e && e.stack || e)); process.exit(2); });
}
