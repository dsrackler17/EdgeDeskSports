#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The college baseball learning loop (college_baseball/loop.js) on a synthetic
   record whose truth is known: the rule stages the change that moves the
   prices toward the truth and refuses the one that moves them away, never
   serves without a release, and the walk-forward carries a holdout look only
   to the configuration it measured.

   Run: node tools/college_baseball/loop.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'college_baseball/loop.js'));
const WF = require(path.join(ROOT, 'college_baseball/walkforward.js'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } };

/* a record: true home-win logits; a configuration's prices are the truth shrunk by sigma_team / 0.16 */
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const games = [];
for (let s = 2014; s <= 2024; s++) for (let i = 0; i < 400; i++) {
  const z = (rnd() - 0.5) * 3; const p = 1 / (1 + Math.exp(-z));
  games.push({ game_id: s + '-' + i, season: s, date: s + '-03-' + String(1 + (i % 28)).padStart(2, '0'), window: s >= 2023 ? 'VALIDATION' : 'SELECTION',
    z, y: rnd() < p ? 1 : 0, neutral: i % 10 === 0 ? 1 : 0, conf_game: i % 2, d1_both: i % 7 ? 1 : 0, weekday: i % 7 });
}
const score = (cfg) => games.map((g) => Object.assign({}, g, { p: { hier_cal: 1 / (1 + Math.exp(-g.z * Math.min(1.6, cfg.tq.sigma_team / 0.16))) } }));
const start = { tq: { sigma_team: 0.12, sigma_conf: 0.05, carry_team: 1, phi: 1.25, halflife_days: 180 }, dist: { family: 'nb', r: 3.256 } };

ok('a change moves one parameter; the hierarchy\'s untuned defaults are reachable', L.applyChange(start, 'tq.sigma_div', ['mul', 2]).tq.sigma_div === 0.6 && L.applyChange(start, 'dist.r', ['mul', 0.8]).dist.r === 2.6048 && L.applyChange(start, 'tq.carry_team', ['add', 0.1]) === null);
const rk = L.rankCandidates([{ pattern: 'vs_non_d1', t: 2.7 }, { pattern: 'home', t: 0.4 }], 0, 8);
ok('the strongest pattern\'s candidates go first', rk[0] === 'div_spread_tighter' && rk[1] === 'div_spread_looser' && rk.length === 8 && new Set(rk).size === 8, rk);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbloop-'));
const docs = path.join(tmp, 'docs');
/* the loop starts from the configuration the record serves; here, the synthetic start */
const realCfgs = WF.cfgsFromTuning;
WF.cfgsFromTuning = () => ({ hier: start });
const wk = L.research({ docs, score, only: ['team_spread_looser', 'team_spread_tighter', 'div_spread_looser'], today: '2026-10-21' });
const vd = JSON.parse(fs.readFileSync(path.join(docs, 'versions.json'), 'utf8'));
const by = (c) => wk.candidates.find((x) => x.candidate === c);
ok('the change toward the truth passes; the one away from it fails; one with no effect fails', by('team_spread_looser').decision === 'PASS' && by('team_spread_tighter').decision === 'FAIL' && by('div_spread_looser').decision === 'FAIL', wk.candidates.map((c) => [c.candidate, c.decision, c.reason]));
ok('a pass is STAGED, never served: the served version is unchanged', vd.current === '1.0.0' && vd.staged === '1.1.0' && /^STAGED/.test(vd.versions[1].status) && vd.versions[0].status === 'SERVED');
ok('the staged change is the one that passed', vd.versions[1].config.tq.sigma_team === +(0.12 * 1.33).toFixed(6) && vd.versions[1].config_sha256 === WF.configHash(vd.versions[1].config));
const wk2 = L.research({ docs, score, only: ['team_spread_looser'], today: '2026-10-28' });
ok('the next week builds on the staged version', wk2.baseline.from_version === '1.1.0');
ok('every candidate is logged', fs.readFileSync(path.join(docs, 'candidates.jsonl'), 'utf8').trim().split('\n').length === 4);
ok('the report says what is staged and that the holdout is untouched', /Staged/.test(L.report({ docs })) && /never read here/.test(fs.readFileSync(path.join(docs, 'weekly_model_report.md'), 'utf8')));

/* release: the staged version is served, and the one look is read from the record */
const wfp = path.join(tmp, 'walkforward.json');
const staged = JSON.parse(fs.readFileSync(path.join(docs, 'versions.json'), 'utf8')).staged;
const rel = L.release({ docs, walkforwardPath: wfp, runWalkforward: () => fs.writeFileSync(wfp, JSON.stringify({ holdout_evaluated_at: '2026-10-29T00:00:00Z', config_sha256: 'x', status: { moneyline: { status: 'OUTCOME_VALIDATED', failed: [] } } })) });
const vd2 = JSON.parse(fs.readFileSync(path.join(docs, 'versions.json'), 'utf8'));
ok('release serves the staged version and retires the old one as a rollback target', rel.version === staged && vd2.current === staged && vd2.staged === null && vd2.versions.find((v) => v.version === '1.0.0').status === 'RETIRED (rollback target)' && vd2.versions.find((v) => v.version === staged).holdout.status.moneyline.status === 'OUTCOME_VALIDATED');
WF.cfgsFromTuning = realCfgs;

/* the walk-forward's holdout look belongs to one configuration */
const prev = { config_sha256: 'aaa', status: {}, windows_report: { HOLDOUT: {} } };
ok('a stored look is found by its configuration', WF.lookFor({ config_sha256: 'bbb' }, prev, { looks: { bbb: { tag: 'mine' } } }).tag === 'mine');
ok('a previous report of another configuration is never carried', WF.lookFor({ config_sha256: 'bbb' }, prev, { looks: {} }) === null);
ok('a report made before configurations were hashed is carried only to the configuration team_tuning names', WF.lookFor({ config_sha256: 'bbb', legacy_config: true }, { status: {} }, { looks: {} }) !== null && WF.lookFor({ config_sha256: 'bbb', legacy_config: false }, { status: {} }, { looks: {} }) === null);
ok('today the record serves team_tuning.json (no released loop version yet)', !WF.cfgsFromTuning().hier.loop_version || !!WF.servedLoopVersion());

fs.rmSync(tmp, { recursive: true, force: true });
console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' college baseball loop — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
