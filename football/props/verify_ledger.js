#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — the ledgers only ever grow (docs/player-props/DESIGN.md §9).

     node football/props/verify_ledger.js [--league nfl|cfb|all] [--base REF]

   Every file under football/props/<league>/<season>/ is append-only:
   evaluations.jsonl (the pregame record), results.jsonl (its grades) and
   closes.jsonl (the line series closed at kickoff). This proves the published
   history was never edited, only extended, before the hourly job commits:

     prefix        the committed version (git show REF:<file>) is a byte
                   prefix of the working file — nothing removed, reordered or
                   rewritten
     json          every line parses
     evaluations   each evaluation_id recomputes from its own fields
                   ('ppe_' + hash of kind, selection, price, book and the
                   evaluation time), ids are unique, and every row was
                   evaluated before its kickoff (a "final" row is frozen at
                   kickoff but evaluated before it)
     results       each grades an evaluation that is on file, once, and no
                   grade is stamped before that evaluation's kickoff; a
                   later row for the same evaluation is allowed only as a
                   CORRECTION (correction: true, naming the grade it corrects
                   and stamped after it) — football/props/grade.js correct()

   The checks are pure functions of text (checkPrefix, checkEvaluations,
   checkResults) so tools/props/ledger_verify.test.js runs them offline.
   Exit 1 on any problem: the workflow then publishes nothing.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config.js');
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));

const FILES = ['evaluations.jsonl', 'results.jsonl', 'closes.jsonl'];

function lines(text) { return String(text || '').split('\n').filter((l) => l.trim()); }
function parse(text, rel, problems) {
  const out = [];
  lines(text).forEach((l, i) => { try { out.push(JSON.parse(l)); } catch (e) { problems.push(rel + ':' + (i + 1) + ' is not JSON'); out.push(null); } });
  return out;
}
/* the committed file must be a prefix of the working one */
function checkPrefix(prev, cur, rel) {
  if (!prev) return [];
  return String(cur || '').startsWith(prev) ? [] : [rel + ': the committed ledger is not a prefix of the working file (a published row was edited, removed or reordered)'];
}
function evaluationId(x) { return 'ppe_' + EDP.hash([x.kind, x.selection_key, x.american, x.book, x.evaluated_at]); }
function checkEvaluations(prev, cur, rel) {
  const problems = checkPrefix(prev, cur, rel), seen = new Set();
  parse(cur, rel, problems).forEach((x, i) => {
    if (!x) return;
    const at = rel + ':' + (i + 1);
    if (x.evaluation_id !== evaluationId(x)) problems.push(at + ' evaluation_id does not match its own fields');
    if (seen.has(x.evaluation_id)) problems.push(at + ' duplicate evaluation_id ' + x.evaluation_id);
    seen.add(x.evaluation_id);
    const t = Date.parse(x.evaluated_at), k = Date.parse(x.kickoff);
    if (!isFinite(t) || !isFinite(k) || !(t < k)) problems.push(at + ' evaluated at or after kickoff');
  });
  return problems;
}
/* evals: the evaluation rows on file (for the ids and kickoffs they graded) */
function checkResults(prev, cur, evals, rel) {
  const problems = checkPrefix(prev, cur, rel), byId = {}, last = {};
  (evals || []).forEach((x) => { if (x && x.evaluation_id) byId[x.evaluation_id] = x; });
  parse(cur, rel, problems).forEach((x, i) => {
    if (!x) return;
    const at = rel + ':' + (i + 1), e = byId[x.evaluation_id];
    if (!e) { problems.push(at + ' grades an evaluation that is not on file (' + x.evaluation_id + ')'); return; }
    const prevGrade = last[x.evaluation_id];
    if (prevGrade && !x.correction) problems.push(at + ' grades ' + x.evaluation_id + ' a second time');
    if (x.correction && !prevGrade) problems.push(at + ' corrects ' + x.evaluation_id + ', which has no grade to correct');
    if (x.correction && prevGrade && (x.corrects !== prevGrade.graded_at || !(Date.parse(x.graded_at) > Date.parse(prevGrade.graded_at)))) problems.push(at + ' a correction must name the grade it corrects and come after it');
    last[x.evaluation_id] = x;
    if (x.graded_at && Date.parse(x.graded_at) < Date.parse(e.kickoff)) problems.push(at + ' graded before its kickoff');
  });
  return problems;
}

function gitShow(base, rel) {
  try { return execFileSync('git', ['show', base + ':' + rel], { cwd: C.ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).toString(); } catch (e) { return ''; }
}
function verify(league, base) {
  const dir = path.join(C.DIR, league), problems = [];
  let files = 0;
  if (!fs.existsSync(dir)) return { league, files, problems };
  fs.readdirSync(dir).filter((d) => /^\d{4}$/.test(d)).sort().forEach((season) => {
    const sd = path.join(dir, season), text = {};
    FILES.forEach((f) => { const p = path.join(sd, f); text[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; });
    const rel = (f) => path.relative(C.ROOT, path.join(sd, f));
    if (text['evaluations.jsonl'] != null) { files++; checkEvaluations(gitShow(base, rel('evaluations.jsonl')), text['evaluations.jsonl'], rel('evaluations.jsonl')).forEach((p) => problems.push(p)); }
    if (text['results.jsonl'] != null) {
      files++;
      const evals = lines(text['evaluations.jsonl']).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
      checkResults(gitShow(base, rel('results.jsonl')), text['results.jsonl'], evals, rel('results.jsonl')).forEach((p) => problems.push(p));
    }
    if (text['closes.jsonl'] != null) { files++; const pr = []; checkPrefix(gitShow(base, rel('closes.jsonl')), text['closes.jsonl'], rel('closes.jsonl')).forEach((p) => pr.push(p)); parse(text['closes.jsonl'], rel('closes.jsonl'), pr); pr.forEach((p) => problems.push(p)); }
  });
  return { league, files, problems };
}

function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const lg = arg('league', 'all'), base = arg('base', 'HEAD');
  const leagues = lg === 'all' ? Object.keys(C.LEAGUES) : [lg];
  let bad = 0;
  leagues.forEach((L) => {
    const r = verify(L, base);
    console.log('[props ledger] ' + L + ': ' + r.files + ' ledger file(s) checked against ' + base + (r.problems.length ? ' — ' + r.problems.length + ' problem(s)' : ' — only grew'));
    r.problems.slice(0, 50).forEach((p) => console.log('  ✗ ' + p));
    bad += r.problems.length;
  });
  return bad ? 1 : 0;
}

module.exports = { verify, checkPrefix, checkEvaluations, checkResults, evaluationId, FILES };
if (require.main === module) process.exit(main());
