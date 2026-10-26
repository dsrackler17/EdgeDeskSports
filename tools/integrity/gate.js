#!/usr/bin/env node
/* ============================================================================
   EdgeDesk — the integrity gate.

   WHY. On 2026-10-26 two merges broke main. #800 was merged 10 seconds after a
   conflict was resolved in GitHub's web editor (2ad15afadd); the resolution
   deleted both sides of a conflict, leaving lib/edgedesk_quote_ev.js
   unparseable and football/cfb_validation/slate_audit.json invalid JSON. No
   check had run on that commit, and the checks that would have caught it are
   path-filtered, so none would ever have been REQUIRED. This gate runs on
   every pull request, every push to main and every bot publish, and checks
   what will actually land.

   MODES
     pr      (pull_request) Merge the PR head into the LATEST main — the tip
             read from the remote when the job runs, not the merge ref GitHub
             computed when the event fired — and check the merged tree. If
             main moves while the job runs, merge and check again (3 rounds).
             Then the pull-request rules:
               * every file the merge changes parses (tools/integrity/checks.js)
               * the merge has no conflicts with main
               * a bot-owned file changes only with the code that produces it
                 (tools/integrity/ownership.js), or under `generated-files-ok`
               * CHANGELOG.md is not edited by hand; changelog.d/ fragments
                 are well formed (tools/changelog/assemble.js)
             The merge commits inside the PR (conflict resolutions) are listed
             in the job summary; their result is what was checked.
     local   The same, for a session before it pushes: HEAD (committed work)
             merged into origin/main as fetched now.
     sweep   (push to main) Every tracked file in the working tree.
     files   --base <sha> --head <sha>: the files a commit range changes, read
             from <head>. tools/ci/push_generated.sh runs this before a bot's
             commit may claim the integrity-gate status.

   Exit 0 clean, 1 problems, 2 the gate itself could not run.
     node tools/integrity/gate.js local
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const C = require('./checks');
const O = require('./ownership');
const CL = require('../changelog/assemble');
const GH = require('./github');

const ROOT = path.join(__dirname, '..', '..');
const LABEL_GENERATED = 'generated-files-ok';
/* the repository the git commands read: this checkout, or (files mode) the
   repository the caller stands in — a bot's clone, a test's temporary repo */
let CWD = ROOT;

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: CWD, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
}
function gitOk(args) { return spawnSync('git', args, { cwd: CWD, stdio: 'ignore' }).status === 0; }

function remoteTip(ref, remote) {
  const out = git(['ls-remote', remote || 'origin', 'refs/heads/' + ref]).trim();
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('could not read ' + ref + ' from ' + (remote || 'origin'));
  return sha;
}

function haveCommit(sha) { return gitOk(['cat-file', '-e', sha + '^{commit}']); }
function ensureCommit(sha, remote) {
  if (haveCommit(sha)) return;
  git(['fetch', '-q', '--no-tags', '--depth=1', remote || 'origin', sha]);
}

/* The merge base of main and head. Local history first; on a shallow CI
   checkout, the compare API names it and only that one commit is fetched
   (a deep fetch of this repository runs to gigabytes). */
async function mergeBase(main, head, remote) {
  try { return git(['merge-base', main, head]).trim(); } catch (e) { /* not in local history */ }
  const repo = GH.repo();
  if (repo && GH.token(ROOT)) {
    const r = await GH.api('GET', '/repos/' + repo + '/compare/' + main + '...' + head, undefined, { cwd: ROOT });
    if (r.ok && r.json && r.json.merge_base_commit) {
      const mb = r.json.merge_base_commit.sha;
      ensureCommit(mb, remote);
      return mb;
    }
  }
  for (const depth of [50, 200, 1000]) {
    git(['fetch', '-q', '--no-tags', '--deepen=' + depth, remote || 'origin']);
    try { return git(['merge-base', main, head]).trim(); } catch (e) { /* deeper */ }
  }
  throw new Error('no merge base between ' + main.slice(0, 10) + ' and ' + head.slice(0, 10));
}

/* git merge-tree: the merged tree, or the conflicted paths. */
function mergeTree(mb, main, head) {
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--merge-base=' + mb, main, head], { cwd: CWD, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && r.status !== 1) throw new Error('git merge-tree failed: ' + (r.stderr || '').trim());
  const lines = r.stdout.split('\n');
  const tree = lines[0].trim();
  const conflicts = r.status === 1 ? [...new Set(lines.slice(1).map((l) => l.trim()).filter(Boolean))] : [];
  return { tree, conflicts };
}

function diffTree(a, b) {
  const out = git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', a, b]);
  const parts = out.split('\0').filter((x) => x !== '');
  const res = [];
  for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i][0], path: parts[i + 1] });
  return res;
}

/* Blob contents for many paths of one tree, through one `git cat-file --batch`. */
function readBlobs(treeish, paths) {
  const map = new Map();
  if (!paths.length) return map;
  const input = paths.map((p) => treeish + ':' + p).join('\n') + '\n';
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: CWD, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('git cat-file --batch failed: ' + String(r.stderr));
  const buf = r.stdout;
  let off = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, off);
    const header = buf.slice(off, nl).toString('utf8');
    off = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) { map.set(p, null); continue; }        // "<name> missing"
    const size = Number(m[3]);
    map.set(p, m[2] === 'blob' ? buf.slice(off, off + size) : null);
    off += size + 1;
  }
  return map;
}

/* ---- the pull-request rules ------------------------------------------------------ */

function changelogRule(changes, blobs) {
  const problems = [];
  for (const ch of changes) {
    if (ch.status === 'D' || !ch.path.startsWith('changelog.d/')) continue;
    const name = ch.path.slice('changelog.d/'.length);
    if (name === 'README.md') continue;
    if (name.includes('/')) { problems.push({ file: ch.path, line: 1, rule: 'changelog', message: 'changelog fragments sit directly in changelog.d/, not in a subdirectory' }); continue; }
    if (!name.endsWith('.md')) { problems.push({ file: ch.path, line: 1, rule: 'changelog', message: 'changelog.d holds .md fragments only' }); continue; }
    const f = CL.parseFragment(name, (blobs.get(ch.path) || Buffer.from('')).toString('utf8'));
    f.problems.forEach((msg) => problems.push({ file: ch.path, line: 1, rule: 'changelog', message: msg }));
  }
  return problems;
}

function generatedRule(changes, labels) {
  const problems = [], allowed = [];
  const changed = changes.map((c) => c.path);
  for (const ch of changes) {
    const c = O.classify(ch.path);
    if (c.class !== 'generated') continue;
    const ex = O.explained(ch.path, changed);
    if (ex.ok) { allowed.push({ file: ch.path, why: ex.why }); continue; }
    if (labels.includes(LABEL_GENERATED)) { allowed.push({ file: ch.path, why: 'label ' + LABEL_GENERATED }); continue; }
    const jobs = c.owners.map((w) => path.basename(w)).join(', ');
    const message = ch.path === 'CHANGELOG.md'
      ? 'CHANGELOG.md is assembled from changelog.d/ by ' + jobs + '. Add your entry as a new file instead: node tools/changelog/assemble.js --new "Headline"'
      : ch.path + ' is written by ' + jobs + ' and this pull request does not change the code that produces it. It was most likely rewritten by a local run (a test or a build) and committed by accident: restore it with `git checkout origin/main -- ' + ch.path + '`. If the change is deliberate, a person adds the `' + LABEL_GENERATED + '` label.';
    problems.push({ file: ch.path, line: 1, rule: 'generated-file', message });
  }
  return { problems, allowed };
}

async function prLabels(pr) {
  if (process.env.INTEGRITY_LABELS != null) return process.env.INTEGRITY_LABELS.split(',').map((s) => s.trim()).filter(Boolean);
  const repo = GH.repo();
  if (!pr || !repo) return [];
  const r = await GH.api('GET', '/repos/' + repo + '/issues/' + pr + '/labels?per_page=100', undefined, { cwd: ROOT });
  return r.ok && Array.isArray(r.json) ? r.json.map((l) => l.name) : [];
}

async function prMergeCommits(pr) {
  const repo = GH.repo();
  if (!pr || !repo || !GH.token(ROOT)) return null;
  try {
    const commits = await GH.paginate('/repos/' + repo + '/pulls/' + pr + '/commits', null, { cwd: ROOT });
    return commits.filter((c) => (c.parents || []).length > 1).map((c) => ({ sha: c.sha, message: (c.commit && c.commit.message || '').split('\n')[0], committer: c.commit && c.commit.committer && c.commit.committer.name }));
  } catch (e) { return null; }
}

/* One round: merge `head` into `mainSha` and check the result. */
async function verifyMerge(mainSha, head, labels, remote) {
  ensureCommit(mainSha, remote);
  const mb = await mergeBase(mainSha, head, remote);
  const m = mergeTree(mb, mainSha, head);
  const report = { main: mainSha, head, mergeBase: mb, tree: m.tree, conflicts: m.conflicts, changes: [], problems: [], allowedGenerated: [], checked: 0, exempted: 0 };
  if (m.conflicts.length) {
    report.problems = m.conflicts.map((f) => ({ file: f, line: 1, rule: 'merge-conflict', message: 'conflicts with main @ ' + mainSha.slice(0, 10) + '. Merge main into the branch locally, regenerate generated files with their own scripts (never by hand), run `node tools/integrity/gate.js local`, then push. Never resolve in the GitHub web editor.' }));
    return report;
  }
  const changes = diffTree(mainSha, m.tree);
  report.changes = changes;
  const live = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  const blobs = readBlobs(m.tree, live);
  const res = C.checkFiles(live, (p) => blobs.get(p) || null, { baseline: C.loadBaseline(ROOT) });
  report.checked = res.checked;
  report.exempted = res.exempted;
  const gen = generatedRule(changes, labels);
  report.allowedGenerated = gen.allowed;
  report.problems = res.problems.concat(gen.problems, changelogRule(changes, blobs));
  return report;
}

/* ---- output -------------------------------------------------------------------------- */
function esc(s) { return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }

function emit(report, title) {
  const gha = process.env.GITHUB_ACTIONS === 'true';
  for (const p of report.problems) {
    if (gha) console.log('::error file=' + esc(p.file) + ',line=' + (p.line || 1) + ',title=' + esc('integrity: ' + p.rule) + '::' + esc(p.message));
    else console.log('FAIL | ' + p.rule + ' | ' + p.file + ':' + (p.line || 1) + ' — ' + p.message);
  }
  const lines = [];
  lines.push('### ' + title + ': ' + (report.problems.length ? '❌ ' + report.problems.length + ' problem(s)' : '✅ clean'));
  if (report.main) lines.push('', '- validated against **main @ `' + report.main.slice(0, 10) + '`**' + (report.rounds > 1 ? ' (main moved during the run; merged and checked ' + report.rounds + ' times)' : '') + (report.mergeBase ? ', merge base `' + report.mergeBase.slice(0, 10) + '`' : ''));
  if (report.changes) lines.push('- files the merge changes: ' + report.changes.length + '; checked: ' + report.checked + (report.exempted ? '; baseline exceptions: ' + report.exempted : ''));
  if (report.checked != null && !report.changes) lines.push('- files checked: ' + report.checked + (report.exempted ? '; baseline exceptions: ' + report.exempted : ''));
  if (report.mergeCommits && report.mergeCommits.length) {
    lines.push('- conflict-resolution / update merges in this PR (their result is what was checked):');
    report.mergeCommits.forEach((c) => lines.push('  - `' + c.sha.slice(0, 10) + '` ' + c.message + (c.committer === 'GitHub' ? ' — **made in the GitHub web UI**' : '')));
  }
  if (report.allowedGenerated && report.allowedGenerated.length) {
    lines.push('- generated files changed, and why that is allowed:');
    report.allowedGenerated.slice(0, 50).forEach((a) => lines.push('  - `' + a.file + '`: ' + a.why));
  }
  if (report.problems.length) {
    lines.push('', '| Rule | File | Problem |', '|---|---|---|');
    report.problems.slice(0, 200).forEach((p) => lines.push('| ' + p.rule + ' | `' + p.file + ':' + (p.line || 1) + '` | ' + String(p.message).replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' |'));
  }
  const md = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (!gha) console.log(md);
  if (process.env.INTEGRITY_REPORT) fs.writeFileSync(process.env.INTEGRITY_REPORT, JSON.stringify(report, null, 1));
}

/* ---- modes ----------------------------------------------------------------------------- */
function arg(args, name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }

async function modeMerge(args, local) {
  const base = arg(args, '--base-ref', process.env.BASE_REF || 'main');
  const remote = arg(args, '--remote', 'origin');
  const head = arg(args, '--head', process.env.HEAD_SHA || git(['rev-parse', 'HEAD']).trim());
  const pr = arg(args, '--pr', process.env.PR_NUMBER || '');
  if (local && gitOk(['diff', '--quiet', 'HEAD']) === false) console.log('note: uncommitted changes are not checked — the gate checks HEAD, which is what you would push');
  ensureCommit(head, remote);
  const labels = local ? (process.env.INTEGRITY_LABELS || '').split(',').filter(Boolean) : await prLabels(pr);
  let mainSha = remoteTip(base, remote);
  let report;
  for (let round = 1; round <= 3; round++) {
    report = await verifyMerge(mainSha, head, labels, remote);
    report.rounds = round;
    const now = remoteTip(base, remote);
    if (now === mainSha) break;
    console.log('main moved from ' + mainSha.slice(0, 10) + ' to ' + now.slice(0, 10) + ' during the check; merging again');
    mainSha = now;
  }
  report.mergeCommits = local ? null : await prMergeCommits(pr);
  report.labels = labels;
  emit(report, local ? 'Integrity gate (local)' : 'Integrity gate');
  return report.problems.length ? 1 : 0;
}

function modeSweep() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const res = C.checkFiles(files, (p) => { try { return fs.readFileSync(path.join(ROOT, p)); } catch (e) { return null; } }, { baseline: C.loadBaseline(ROOT) });
  const frag = CL.readFragments(ROOT).flatMap((f) => f.problems.map((m) => ({ file: 'changelog.d/' + f.name, line: 1, rule: 'changelog', message: m })));
  const report = { checked: res.checked, exempted: res.exempted, problems: res.problems.concat(frag) };
  emit(report, 'Integrity sweep (every tracked file)');
  return report.problems.length ? 1 : 0;
}

function modeFiles(args) {
  const base = arg(args, '--base');
  const head = arg(args, '--head', 'HEAD');
  if (!base) { console.error('usage: gate.js files --base <sha> [--head <sha>]'); return 2; }
  CWD = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const changes = diffTree(base, head).filter((c) => c.status !== 'D');
  const paths = changes.map((c) => c.path);
  const blobs = readBlobs(head, paths);
  const res = C.checkFiles(paths, (p) => blobs.get(p) || null, { baseline: C.loadBaseline(ROOT) });
  const report = { checked: res.checked, exempted: res.exempted, problems: res.problems };
  emit(report, 'Integrity check of ' + git(['rev-parse', '--short', head]).trim());
  return report.problems.length ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (mode === 'pr') return modeMerge(args, false);
  if (mode === 'local') {
    if (!args.includes('--no-fetch')) git(['fetch', '-q', '--no-tags', 'origin', arg(args, '--base-ref', 'main')]);
    return modeMerge(args, true);
  }
  if (mode === 'sweep') return modeSweep();
  if (mode === 'files') return modeFiles(args);
  if (mode === 'lock') return require('./lock').main(args.slice(1));
  if (mode === 'wait-ci') return require('./wait_ci').main(args.slice(1));
  console.error('usage: gate.js pr|local|sweep|files|lock|wait-ci');
  return 2;
}

/* tests drive the merge rules against a temporary repository */
function setRepo(dir) { CWD = dir; }

module.exports = { verifyMerge, mergeTree, diffTree, readBlobs, generatedRule, changelogRule, remoteTip, setRepo, LABEL_GENERATED };

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error('integrity gate could not run: ' + (e && e.stack || e)); process.exit(2); });
}
