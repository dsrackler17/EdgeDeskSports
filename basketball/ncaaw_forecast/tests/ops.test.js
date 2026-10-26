#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Failure injection on the REAL weekly run (weekly.js over the committed
   dataset), each in its own throwaway registry and report directory:

     NCAAW_FAIL_AT=ingest|train|evaluate|store|promote
       -> the run exits non-zero, the champion pointer is byte-for-byte
          unchanged, the history ends with FAILED at that stage, no temporary
          file is left, and the registry still verifies
     a registry that disagrees with itself (a pointer moved without its
     history line, as a crash between the two writes would leave it)
       -> weekly.js and refresh.js both refuse before doing any work

     node basketball/ncaaw_forecast/tests/ops.test.js      (about 3-5 minutes: real data)
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./_kit').kit('ncaaw operations (failure injection)');
const C = require('../config');
const MD = require('../model');
const RG = require('../registry');
const W = require('../weekly');

const HERE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaawops-'));
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) { const s = path.join(from, f), d = path.join(to, f); if (fs.statSync(s).isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d); } };
const env = (reg, rep, failAt) => Object.assign({}, process.env, { NCAAW_REGISTRY_DIR: reg, NCAAW_REPORTS_DIR: rep, NCAAW_FAIL_AT: failAt || '' });
const history = (reg) => fs.readFileSync(path.join(reg, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pointer = (reg) => fs.readFileSync(path.join(reg, 'champion.json'), 'utf8');
const tmpLeft = (dir) => { const out = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tmp-/.test(f)) out.push(p); } }; walk(dir); return out; };
const verify = (reg) => spawnSync(process.execPath, [path.join(HERE, 'registry.js'), 'verify'], { env: env(reg, path.join(TMP, 'unused')), encoding: 'utf8' });
/* a fresh registry whose INIT champion is `cfg`, written the way registry.js init() writes the incumbent */
function initWith(reg, cfg) {
  const was = process.env.NCAAW_REGISTRY_DIR; process.env.NCAAW_REGISTRY_DIR = reg;
  try {
    const m = { schema: 'edgedesk_ncaaw_fc_model_v1', model_id: cfg.model_id, version: cfg.version, engine: cfg.engine, config: cfg, config_sha256: MD.configHash(cfg),
      status: 'CHAMPION', recorded_at: new Date().toISOString(), evidence: 'tests/ops.test.js: a deliberately weak starting champion, in a throwaway registry' };
    RG.recordModel(m);
    RG.atomicWrite(RG.P.pointer(), JSON.stringify({ schema: 'edgedesk_ncaaw_fc_champion_v1', current: { key: RG.modelKey(m), model_id: m.model_id, version: m.version, engine: m.engine, config_sha256: m.config_sha256,
      since: new Date().toISOString(), decision: 'INIT' }, previous: [] }, null, 1) + '\n');
    RG.appendHistory({ decision: 'INIT', champion: RG.modelKey(m), note: 'test setup: a deliberately weak starting champion' });
    return RG.modelKey(m);
  } finally { if (was === undefined) delete process.env.NCAAW_REGISTRY_DIR; else process.env.NCAAW_REGISTRY_DIR = was; }
}
const run = (script, args, e) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(HERE, script)].concat(args), { env: e }); let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

(async () => {
  /* the champion registry as committed (ncaaw_adjeff@1.0.0) for ingest, train
     and evaluate, with carry_lower (the women's champion's carry is already
     1.0, so carry_higher is not a change and is never a candidate);
     a fresh registry (the incumbent as champion) for store: the bootstrap run,
     the served incumbent against the frozen selection, stopped after its
     evaluation whatever it decides;
     for promote, a fresh registry whose champion is the frozen selection with
     a prior 64 times too strong, so that lambda_weaker_prior must PROMOTE.
     It used to be the incumbent, against which the frozen selection was known
     to pass every gate, until the weekly model loop promoted the served model
     (1.1.0 -> 1.2.0 at cf8d09fb9) and the run returned RETAIN, so the promote
     boundary was never reached. The weak champion needs no served model: on
     2026-10-26 the candidate gained 0.029 log loss (95% CI 0.027 to 0.031)
     against the 0.0002 the gate requires, and every gated cohort improved,
     the D1-v-non-D1 regime included */
  const sel = W.selectionConfig();
  const weak = Object.assign({}, sel, { version: '0.1.0', params: Object.assign({}, sel.params, { lambda: sel.params.lambda * 64 }) });
  const cases = [
    { stage: 'ingest', fresh: false, only: 'carry_lower', wantStage: 'data' },
    { stage: 'train', fresh: false, only: 'carry_lower', wantStage: 'train' },
    { stage: 'evaluate', fresh: false, only: 'carry_lower', wantStage: 'evaluate' },
    { stage: 'store', fresh: 'incumbent', only: null, wantStage: 'store' },
    { stage: 'promote', fresh: weak, only: 'lambda_weaker_prior', wantStage: 'promote' },
  ];
  for (const c of cases) {
    c.reg = path.join(TMP, c.stage, 'registry'); c.rep = path.join(TMP, c.stage, 'reports');
    if (c.fresh === 'incumbent') { fs.mkdirSync(c.reg, { recursive: true }); spawnSync(process.execPath, [path.join(HERE, 'registry.js'), 'init'], { env: env(c.reg, c.rep) }); }
    else if (c.fresh) { fs.mkdirSync(c.reg, { recursive: true }); c.champion = initWith(c.reg, c.fresh); }
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
  T.chk('promote: the starting champion is still the champion', JSON.parse(pointer(pr.reg)).current.key === pr.champion, JSON.parse(pointer(pr.reg)).current.key);
  T.chk('store: the bootstrap run evaluated the frozen selection against the incumbent', /"key": "ncaaw_points@/.test(st.before) && history(st.reg).some((x) => x.decision === 'FAILED' && x.stage === 'store' && x.candidate === 'selection_v1'));

  /* a registry that disagrees with itself */
  const bad = path.join(TMP, 'inconsistent', 'registry'); copyDir(C.PATHS.registry, bad);
  const p = JSON.parse(pointer(bad)); const prev = p.previous[0];
  fs.writeFileSync(path.join(bad, 'champion.json'), JSON.stringify(Object.assign({}, p, { current: Object.assign({}, prev, { decision: 'ROLLBACK' }), previous: [p.current] }), null, 1) + '\n');
  T.chk('a pointer moved without its history line fails verification', verify(bad).status !== 0 && /history says the champion is/.test(verify(bad).stdout));
  const before = history(bad).length;
  const [w, r] = await Promise.all([run('weekly.js', ['--only', 'carry_lower'], env(bad, path.join(TMP, 'inconsistent', 'reports'))), run('refresh.js', ['--hours', '1'], env(bad, path.join(TMP, 'inconsistent', 'reports')))]);
  T.chk('weekly.js refuses before any evaluation', w.code !== 0 && /disagrees with itself/.test(w.out) && !fs.existsSync(path.join(TMP, 'inconsistent', 'reports')), w.out.slice(-300));
  T.eq('...and records why', [history(bad).length, history(bad).pop().stage], [before + 1, 'registry']);
  T.chk('refresh.js refuses to build or publish', r.code !== 0 && /disagrees with itself/.test(r.out), r.out.slice(-300));

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(T.done());
})().catch((e) => { T.chk('the suite ran without an unexpected error', false, String(e.stack || e)); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(T.done()); });
