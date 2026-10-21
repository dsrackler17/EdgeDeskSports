#!/usr/bin/env node
/* ============================================================================
   AUTOMATIC PROMOTION (football/cfb_production/auto_promote.js, rule
   cfb_auto_promotion_v1), on a temporary governance store:

     1 the switch        off: nothing is done; its reading is a RULE_CHANGED
                         row, written once per change
     2 the evidence      nothing ELIGIBLE: nothing changes
     3 promote           an ELIGIBLE loop version with live capture is promoted
                         through the guard, on the audit log, by automation
     4 the guard decides no live capture, failing tests, or an evaluation
                         against an older champion: refused, nothing changes
     5 the best first    several eligible: the largest MAE improvement first,
                         and only one promotion per run
     6 return to V1      the loop ships a new version: V1 is restored, the new
                         version registered (with its experiment), and nothing
                         is promoted on the old champion's evaluation
     7 back by evidence  V1 ELIGIBLE against a worse champion returns (--rollback)
     8 dry run           reports, writes nothing

   Run: node football/cfb_production/auto_promote.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const AP = require('./auto_promote.js');
const G = require(path.join(REPO, 'football', 'cfb_lab', 'ledger.js'));
const GOV = require(path.join(REPO, 'football', 'cfb_lab', 'governance.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 400) : '')); } }

const NOW = '2026-11-14T10:00:00.000Z', H = 3600000, at = (h) => new Date(Date.parse(NOW) + h * H).toISOString();
const V1 = 'edgedesk_cfb_p4_v1.0.0', V21 = 'edgedesk_cfb_v2.1.0', LOOP = 'edgedesk_cfb_loop_v2.0.0', LOOP2 = 'edgedesk_cfb_loop_v2.1.0';
const ON = { enabled: true, actor: 'edgedesk-bot (test)', register_loop_versions: true, return_to_v1: true };
const OK = { ok: true, detail: 'test' };
const dist = { sigma: 16.5, mult: [0.001, 0.98, 0.79, 2.79, 1.01, 0.77, 0.96, 2.53, 0.8, 0.37, 1.43], kmax: 100 };
const card = (id, kick, margin, p) => ({ game_id: id, week: 12, home: 'H' + id, away: 'A' + id, home_id: 1, away_id: 2, neutral_site: false, kickoff_utc: kick,
  fair_home_margin: margin, fair_total: 50, home_win_prob: p, components: [{ key: 'home_field', label: 'Home field', points: margin }] });
const loop = (ver) => ({ schema: 'edgedesk_model_loop_cfb_current_v1', model_version: ver, generated_at: at(-2), season: 2026, config_sha256: 'cfg0123456789abcdef', distribution: dist,
  games: [card('g1', at(30), 7.4, 0.66), card('g2', at(54), -3.1, 0.43)] });
const calib = (ver) => 'model_loop:' + ver + ':cfg012345678';
const ev = (challenger, champion, decision, mae, n) => ({ challenger, champion, rule: 'cfb_lab_promotion_v1', decision, ready: (n || 160) >= 150, n: n || 160, min_n: 150,
  mae_diff: mae, mae_diff_ci: [mae - 0.3, mae + 0.2], weekly_win_share: 0.75 });
const lab = (champion, evals) => ({ comparison: { promotion: { champion, evaluations: evals } } });

function store(captures) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbauto-'));
  const s = new G.Store(2026, { root: path.join(d, 'ledger'), govRoot: path.join(d, 'gov') });
  GOV.seed(s);
  GOV.register(s, LOOP, 'Loop v2.0.0', 'challenger', 'loop', 'test', 'test', { at: '2026-10-21T09:29:53.000Z' });
  if (captures && captures.length) {
    fs.mkdirSync(path.join(d, 'ledger', '2026', 'predictions'), { recursive: true });
    fs.writeFileSync(path.join(d, 'ledger', '2026', 'predictions', 'week_12.jsonl'),
      captures.map((c, i) => JSON.stringify({ prediction_id: 'p' + i, model_version: c[0], origin: 'LIVE', calibration_version: c[1] })).join('\n') + '\n');
  }
  return s;
}
const champ = (s) => GOV.champion(s.gov('model_roles'));
const run = (s, o) => AP.run(Object.assign({ store: s, now: NOW, season: 2026, policy: ON, tests: OK, loopCurrent: loop('2.0.0'), lab: lab(V1, []) }, o || {}));

/* 1 */
{
  const s = store();
  const r = run(s, { policy: Object.assign({}, ON, { enabled: false }), lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('switched off: nothing is done, even with an ELIGIBLE challenger', !r.changed && r.actions.length === 0 && champ(s) === V1 && /switched off/.test(r.note), r);
  const rc = () => s.gov('audit_log').filter((e) => e.event_type === 'RULE_CHANGED' && e.subject === 'config.auto_promotion');
  chk('… and reading the switch is a RULE_CHANGED row', rc().length === 1 && rc()[0].after.enabled === false && rc()[0].before === null);
  run(s, { policy: Object.assign({}, ON, { enabled: false }) });
  chk('… written once, not every hour', rc().length === 1);
  run(s);
  chk('… and again when it changes (before and after on the row)', rc().length === 2 && rc()[1].before.enabled === false && rc()[1].after.enabled === true);
}

/* 2 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  const r = run(s, { lab: lab(V1, [ev(LOOP, V1, 'INSUFFICIENT_SAMPLE', -0.9, 90), ev(V21, V1, 'NOT_ELIGIBLE', 0.09, 176)]) });
  chk('nothing ELIGIBLE: nothing changes, and each evaluation is reported', !r.changed && champ(s) === V1 && r.considered.length === 2
    && r.considered.every((c) => /^not eligible/.test(c.outcome)) && /no challenger is ELIGIBLE/.test(r.note) && AP.summary(r) === null, r);
}

/* 3 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  const r = run(s, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  const roles = GOV.currentRoles(s.gov('model_roles'));
  const au = s.gov('audit_log').filter((e) => e.event_type === 'MODEL_PROMOTED' && e.subject === LOOP)[0];
  chk('an ELIGIBLE loop version with live capture is promoted; V1 becomes challenger', r.changed && champ(s) === LOOP && roles[V1].role === 'challenger'
    && r.champion_before === V1 && r.champion_after === LOOP && r.actions.length === 1 && r.actions[0].action === 'PROMOTE', r);
  chk('… on the audit log by automation, with the guard\'s verdict and the evidence', au && au.actor === ON.actor && au.after.guard.ok === true
    && au.after.guard.checks.length === 7 && /ELIGIBLE against edgedesk_cfb_p4_v1\.0\.0 on 160 common official games/.test(au.reason)
    && /promotion\.json$/.test(roles[LOOP] && s.gov('model_roles').filter((e) => e.model_version === LOOP && e.role === 'champion')[0].evidence_ref), au);
  const sm = AP.summary(r);
  chk('… and the issue says what happened and how to undo it', sm && /edgedesk_cfb_loop_v2\.0\.0 was promoted to champion automatically/.test(sm.title) && /--rollback/.test(sm.body) && /auto_promotion\.enabled/.test(sm.body), sm);
  const again = run(s, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('the next hour, the same (now stale) evaluation changes nothing', !again.changed && champ(s) === LOOP && /not the current champion/.test(again.considered[0].outcome), again.considered);
}

/* 4 */
{
  const s = store();
  const r = run(s, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('the guard decides: no live capture of the version, no promotion', !r.changed && champ(s) === V1 && /refused by the promotion guard: 5\./.test(r.considered[0].outcome), r.considered);
  const s2 = store([[LOOP, calib('2.0.0')], [LOOP, 'model_loop:2.0.0:another0cfg']]);
  chk('… nor when the Lab measured another config', !run(s2, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) }).changed && champ(s2) === V1);
  const s3 = store([[LOOP, calib('2.0.0')]]);
  const r3 = run(s3, { tests: { ok: false, detail: 'FAILED football/cfb_lab/tests.js' }, lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('… nor when the tests fail', !r3.changed && champ(s3) === V1 && /6\. tests pass/.test(r3.considered[0].outcome), r3.considered);
  const r4 = run(s3, { lab: lab(V21, [ev(LOOP, V21, 'ELIGIBLE', -0.6)]) });
  chk('… nor on an evaluation against another champion than the current one', !r4.changed && champ(s3) === V1 && /not the current champion/.test(r4.considered[0].outcome), r4.considered);
  const r5 = run(s3, { loopCurrent: { schema: 'unreadable' }, lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('… nor when the loop serves nothing readable', !r5.changed && champ(s3) === V1 && /no longer serves it/.test(r5.considered[0].outcome), r5.considered);
}

/* 5 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  const r = run(s, { lab: lab(V1, [ev(V21, V1, 'ELIGIBLE', -0.3), ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('several ELIGIBLE: the largest MAE improvement is promoted, and only one per run',
    champ(s) === LOOP && r.considered[0].challenger === LOOP && r.considered[0].outcome === 'PROMOTED' && /not this run/.test(r.considered[1].outcome)
      && r.actions.filter((a) => a.action === 'PROMOTE').length === 1, r.considered);
  const s2 = store();
  const r2 = run(s2, { lab: lab(V1, [ev(V21, V1, 'ELIGIBLE', -0.3), ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('… and when the best is refused, the next eligible one goes through the guard',
    /refused by the promotion guard/.test(r2.considered[0].outcome) && r2.considered[1].challenger === V21 && (r2.considered[1].outcome === 'PROMOTED' || /refused by the promotion guard/.test(r2.considered[1].outcome)), r2.considered);
}

/* 6 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  run(s, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  const r = run(s, { loopCurrent: loop('2.1.0'), lab: lab(LOOP, [ev(V1, LOOP, 'NOT_ELIGIBLE', 0.6), ev(V21, LOOP, 'ELIGIBLE', -0.1)]) });
  const roles = GOV.currentRoles(s.gov('model_roles'));
  const exps = GOV.experiments(s.gov('experiments'));
  const x = Object.values(exps).find((e) => e.challenger_model === LOOP2);
  chk('the loop ships a new version: V1 is restored as champion (--rollback), on the record', champ(s) === V1 && r.actions[0].action === 'RETURN_TO_V1' && r.actions[0].done
    && r.actions[0].guard.rollback === true && /no longer served/.test(r.actions[0].reason) && roles[LOOP].role === 'challenger', r.actions);
  chk('… the new version is registered as challenger, with its experiment', roles[LOOP2] && roles[LOOP2].role === 'challenger' && r.actions[1].action === 'REGISTER'
    && x && x.experiment_id === 'EXP-005' && x.baseline_model === V1 && x.status === 'RUNNING', { roles, x });
  chk('… and nothing is promoted on the old champion\'s evaluation in that run', r.actions.length === 2 && r.considered.find((c) => c.challenger === V21).outcome.indexOf('not this run') === 0, r.considered);
  const sm = AP.summary(r);
  chk('… the issue says the board is back on V1', sm && /back on V1 automatically/.test(sm.title), sm);
  const again = run(s, { loopCurrent: loop('2.1.0'), lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('the old version, still ELIGIBLE on its old rows, is not re-promoted while the loop serves another', !again.changed && champ(s) === V1 && /no longer serves it/.test(again.considered[0].outcome), again.considered);
}

/* 7 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  run(s, { lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  const r = run(s, { lab: lab(LOOP, [ev(V1, LOOP, 'ELIGIBLE', -0.4)]) });
  chk('V1 ELIGIBLE against a worse champion comes back by evidence (--rollback)', champ(s) === V1 && r.actions[0].action === 'PROMOTE' && r.actions[0].guard.rollback === true, r.actions);
}

/* 8 */
{
  const s = store([[LOOP, calib('2.0.0')]]);
  const before = JSON.stringify([s.gov('model_roles'), s.gov('audit_log'), s.gov('experiments')]);
  const r = run(s, { dryRun: true, loopCurrent: loop('2.1.0'), lab: lab(V1, [ev(LOOP, V1, 'ELIGIBLE', -0.6)]) });
  chk('dry run: reports what it would do and writes nothing', JSON.stringify([s.gov('model_roles'), s.gov('audit_log'), s.gov('experiments')]) === before
    && !r.changed && r.actions.some((a) => a.action === 'REGISTER' && !a.done), r);
}

chk('the switch is on in config.json (the owner asked for it, 2026-10-21)', AP.policyOf(JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'cfb_lab', 'config.json'), 'utf8'))).enabled === true);
chk('a missing switch means off', AP.policyOf({}).enabled === false);

console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
