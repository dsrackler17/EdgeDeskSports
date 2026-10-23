#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Failure injection on the REAL weekly run (weekly.js over the committed
   dataset), each in its own throwaway registry and report directory:

     NCAAM_FAIL_AT=ingest|train|evaluate|store|promote
       -> the run exits non-zero, the champion pointer is byte-for-byte
          unchanged, the history ends with FAILED at that stage, no temporary
          file is left, and the registry still verifies
     a registry that disagrees with itself (a pointer moved without its
     history line, as a crash between the two writes would leave it)
       -> weekly.js and refresh.js both refuse before doing any work

     node basketball/ncaam_forecast/tests/ops.test.js      (about 3-5 minutes: real data)
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./_kit').kit('ncaam operations (failure injection)');
const C = require('../config');

const HERE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaamops-'));
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) { const s = path.join(from, f), d = path.join(to, f); if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d); } };
const env = (reg, rep, failAt) => Object.assign({}, process.env, { NCAAM_REGISTRY_DIR: reg, NCAAM_REPORTS_DIR: rep, NCAAM_FAIL_AT: failAt || '' });
const history = (reg) => fs.readFileSync(path.join(reg, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pointer = (reg) => fs.readFileSync(path.join(reg, 'champion.json'), 'utf8');
const tmpLeft = (dir) => { const out = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tmp-/.test(f)) out.push(p); } }; walk(dir); return out; };
const verify = (reg) => spawnSync(process.execPath, [path.join(HERE, 'registry.js'), 'verify'], { env: env(reg, path.join(TMP, 'unused')), encoding: 'utf8' });
const run = (script, args, e) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(HERE, script)].concat(args), { env: e }); let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

(async () => {
  /* the champion registry as committed (ncaam_adjeff@1.0.0) for the first four;
     a fresh registry (the incumbent as champion) for promote, whose first
     candidate (the frozen selection) is known to pass every gate */
  const cases = [
    { stage: 'ingest', fresh: false, only: 'carry_higher', wantStage: 'data' },
    { stage: 'train', fresh: false, only: 'carry_higher', wantStage: 'train' },
    { stage: 'evaluate', fresh: false, only: 'carry_higher', wantStage: 'evaluate' },
    { stage: 'store', fresh: false, only: 'carry_higher', wantStage: 'store' },
    { stage: 'promote', fresh: true, only: null, wantStage: 'promote' },
  ];
  for (const c of cases) {
    c.reg = path.join(TMP, c.stage, 'registry'); c.rep = path.join(TMP, c.stage, 'reports');
    if (c.fresh) { fs.mkdirSync(c.reg, { recursive: true }); spawnSync(process.execPath, [path.join(HERE, 'registry.js'), 'init'], { env: env(c.reg, c.rep) }); }
    else copyDir(C.PATHS.registry, c.reg);
    c.before = pointer(c.reg); c.lines = history(c.reg).length;
  }
  const t0 = Date.now();
  const res = await Promise.all(cases.map((c) => run('weekly.js', c.only ? ['--only', c.only] : ['--max', '1'], env(c.reg, c.rep, c.stage))));
  console.log('NOTE | five injected runs in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  cases.forEach((c, i) => {
    const r = res[i]; const h = history(c.reg); const last = h[h.length - 1];
    T.chk(c.stage + ': the run exits non-zero and says the champion is unchanged', r.code !== 0 && /champion is unchanged/.test(r.out), r.out.slice(-300));
    T.chk(c.stage + ': the champion pointer is byte-for-byte unchanged', pointer(c.reg) === c.before);
    T.eq(c.stage + ': the history ends with FAILED at ' + c.wantStage, [last.decision, last.stage], ['FAILED', c.wantStage]);
    T.chk(c.stage + ': the history only grew (append-only)', h.length > c.lines);
    T.eq(c.stage + ': no temporary file is left behind', tmpLeft(path.join(TMP, c.stage)), []);
    T.chk(c.stage + ': the registry still verifies', verify(c.reg).status === 0, verify(c.reg).stdout);
  });
  const st = cases.find((c) => c.stage === 'store');
  T.chk('store: no report file was written', !fs.existsSync(st.rep) || fs.readdirSync(st.rep).length === 0);
  const pr = cases.find((c) => c.stage === 'promote'); const ph = history(pr.reg);
  T.chk('promote: the PROMOTE evaluation is kept as evidence (report and decision line) though nothing was promoted',
    fs.readdirSync(pr.rep).length === 1 && ph.some((x) => x.decision === 'PROMOTE' && x.candidate && !x.replaced) && !ph.some((x) => x.decision === 'PROMOTE' && x.replaced));
  T.chk('promote: the incumbent is still the champion', /"key": "ncaam_points@/.test(pointer(pr.reg)));

  /* a registry that disagrees with itself */
  const bad = path.join(TMP, 'inconsistent', 'registry'); copyDir(C.PATHS.registry, bad);
  const p = JSON.parse(pointer(bad)); const prev = p.previous[0];
  fs.writeFileSync(path.join(bad, 'champion.json'), JSON.stringify(Object.assign({}, p, { current: Object.assign({}, prev, { decision: 'ROLLBACK' }), previous: [p.current] }), null, 1) + '\n');
  T.chk('a pointer moved without its history line fails verification', verify(bad).status !== 0 && /history says the champion is/.test(verify(bad).stdout));
  const before = history(bad).length;
  const [w, r] = await Promise.all([run('weekly.js', ['--only', 'carry_higher'], env(bad, path.join(TMP, 'inconsistent', 'reports'))), run('refresh.js', ['--hours', '1'], env(bad, path.join(TMP, 'inconsistent', 'reports')))]);
  T.chk('weekly.js refuses before any evaluation', w.code !== 0 && /disagrees with itself/.test(w.out) && !fs.existsSync(path.join(TMP, 'inconsistent', 'reports')), w.out.slice(-300));
  T.eq('...and records why', [history(bad).length, history(bad).pop().stage], [before + 1, 'registry']);
  T.chk('refresh.js refuses to build or publish', r.code !== 0 && /disagrees with itself/.test(r.out), r.out.slice(-300));

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(T.done());
})().catch((e) => { T.chk('the suite ran without an unexpected error', false, String(e.stack || e)); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(T.done()); });
