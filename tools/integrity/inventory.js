#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — inventory of the bot-owned paths, for deciding which generated
   files belong on main and which belong somewhere else.

   For every path a publishing job owns (tools/integrity/ownership.js):
     files / MB     what is tracked under it now
     commits        how many commits on main touched it in the history this
                    checkout holds (--since to bound it), a measure of churn
     served         whether a page the site serves names the path: the static
                    site (GitHub Pages from main) fetches its data by path, so
                    a served artifact has to stay on main
   and a recommendation:
     keep          served, or small and rarely written: stays tracked on main,
                   owned by its job (the gate keeps pull requests off it)
     move          not served, and an append-only ledger / snapshot history /
                   CSV export, or rewritten on most runs: a candidate for a
                   data branch, release assets or the database the job
                   already syncs to. A recommendation for a person to confirm,
                   never applied automatically (a reader may load it by a
                   path built at run time, which a text search cannot see)

     node tools/integrity/inventory.js [--since "7 days ago"] [--markdown]
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const O = require('./ownership');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '7 days ago';
const md = args.includes('--markdown');

function git(a) { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 }); }

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
/* the pages and scripts the site serves: every tracked .html, and the .js
   outside tools/, tests and model-training directories */
const served = tracked.filter((f) => /\.html$/.test(f) || (/\.(js|mjs)$/.test(f) && !/^(tools|supabase|\.github)\//.test(f) && !/(\.test|\.e2e|_test)\.js$/.test(f)));
let servedText = '';
for (const f of served) { try { servedText += fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n'; } catch (e) { /* skip */ } }

const m = O.model();
const groups = new Map();
for (const e of m.entries) {
  const key = e.text;
  if (!groups.has(key)) groups.set(key, { path: key, kind: e.kind, workflows: new Set() });
  groups.get(key).workflows.add(path.basename(e.workflow, '.yml'));
}

const churn = {};
let log = '';
try { log = git(['log', '--first-parent', '--since=' + since, '--name-only', '--format=@@%H', 'HEAD']); } catch (e) { log = ''; }
let cur = null;
for (const line of log.split('\n')) {
  if (line.startsWith('@@')) { cur = line; continue; }
  if (!line) continue;
  for (const g of groups.values()) {
    if (line === g.path || line.startsWith(g.path + '/') || (g.kind === 'glob' && O.globToRegExp(g.path).test(line))) {
      churn[g.path] = churn[g.path] || new Set();
      churn[g.path].add(cur);
    }
  }
}

const rows = [];
for (const g of groups.values()) {
  const re = g.kind === 'glob' ? O.globToRegExp(g.path) : null;
  const files = tracked.filter((f) => (re ? re.test(f) : f === g.path || f.startsWith(g.path + '/')) && O.classify(f).class === 'generated');
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(ROOT, f)).size; } catch (e) { /* gone */ } }
  const needle = g.kind === 'glob' ? g.path.split('*')[0] : g.path;
  /* a file at the root (sitemap.xml, app-version.json) is fetched by URL */
  const isServed = !g.path.includes('/') || (needle.length > 3 && servedText.includes(needle));
  const commits = churn[g.path] ? churn[g.path].size : 0;
  const appendOnly = /(ledger|history|snapshots?|archive|backfill|\.jsonl|\.csv)/.test(g.path) || files.some((f) => /\.(jsonl|csv)$/.test(f));
  const rec = isServed ? 'keep' : (appendOnly || commits >= 2 ? 'move' : 'keep');
  rows.push({ path: g.path + (g.kind === 'dir' ? '/' : ''), files: files.length, mb: bytes / 1e6, commits, served: isServed, rec, jobs: [...g.workflows].sort().join(', ') });
}
rows.sort((a, b) => (a.rec === b.rec ? b.commits - a.commits || b.mb - a.mb : a.rec === 'move' ? -1 : 1));

if (md) {
  console.log('| Path | Files | MB | Commits (' + since + ') | Served | Recommendation | Owning jobs |');
  console.log('|---|---:|---:|---:|---|---|---|');
  rows.forEach((r) => console.log('| `' + r.path + '` | ' + r.files + ' | ' + r.mb.toFixed(1) + ' | ' + r.commits + ' | ' + (r.served ? 'yes' : 'no') + ' | ' + r.rec + ' | ' + r.jobs + ' |'));
} else {
  rows.forEach((r) => console.log([r.rec.padEnd(4), String(r.commits).padStart(4), r.mb.toFixed(1).padStart(7) + 'MB', String(r.files).padStart(6), r.served ? 'served' : '      ', r.path, '←', r.jobs].join('  ')));
}
