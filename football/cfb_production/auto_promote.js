#!/usr/bin/env node
/* ============================================================================
   CFB production — AUTOMATIC PROMOTION (rule cfb_auto_promotion_v1).

   The owner's instruction (2026-10-21): when a model has earned the board,
   it goes on the board without waiting for a person to remember. The
   evidence does not change: the hourly lab job calls governance.js promote
   exactly as a person would, behind the same promotion guard
   (football/cfb_production/promotion.js, tests included), and every act is
   on the audit log with the guard's verdict. In order, each run:

     1 return to V1   the champion is a model loop (or V2) version its source
                      no longer serves (the loop shipped a newer one). The
                      board already prices V1 for every game then (the
                      champion table is empty), so governance says so too:
                      V1 is restored (--rollback, the documented return) and
                      the new version is measured against it
     2 register       the model loop serves a version the Lab has never
                      registered: it enters as challenger (never champion),
                      with its experiment, so its live evidence counts from
                      its first capture
     3 promote        the Model Lab's promotion evaluation (lab.json, rule
                      cfb_lab_promotion_v1: 150 common official games, MAE CI
                      below zero, Brier, ECE, 80% coverage, tail, weekly
                      stability) is ELIGIBLE for a challenger against the
                      CURRENT champion. The largest MAE improvement goes
                      first; if the guard refuses it, the next is tried. Not
                      in a run that returned to V1 (that evaluation was
                      against the old champion). V1 itself, eligible against
                      a worse champion, returns with --rollback

   The champion table (champion.js) is built after this in the same run, so
   the board prices the new champion from that hour. Off switch:
   football/cfb_lab/config.json auto_promotion.enabled (a governed rule:
   changing it is a RULE_CHANGED audit row). A person can still promote or
   roll back by hand at any time; automation acts on the next hour's evidence.

   Writes football/cfb_production/reports/auto_promotion.json (what it did,
   what it considered and why), and, in GitHub Actions, the step outputs
   changed / title and a summary the workflow opens an issue from.

   Usage: node football/cfb_production/auto_promote.js [--write] [--dry-run] [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..');
const G = require(path.join(REPO, 'football', 'cfb_lab', 'ledger.js'));
const GOV = require(path.join(REPO, 'football', 'cfb_lab', 'governance.js'));
const M = require(path.join(REPO, 'football', 'cfb_lab', 'models.js'));
const CHB = require('./champion.js');
const PG = require('./promotion.js');

const RULE = 'cfb_auto_promotion_v1';
const SCHEMA = 'edgedesk_cfb_auto_promotion_v1';
const OUT = path.join(__dirname, 'reports', 'auto_promotion.json');
const CONFIG = path.join(REPO, 'football', 'cfb_lab', 'config.json');
const DEFAULT_ACTOR = 'edgedesk-bot (automatic promotion, ' + RULE + ')';

function seasonFor(d) { d = d || new Date(); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
function policyOf(cfg) {
  const p = (cfg && cfg.auto_promotion) || {};
  return { enabled: p.enabled === true, actor: p.actor || DEFAULT_ACTOR, register_loop_versions: p.register_loop_versions !== false, return_to_v1: p.return_to_v1 !== false };
}
const brief = (g) => ({ ok: g.ok, rollback: g.rollback, checks: g.checks.map((c) => ({ n: c.n, check: c.check, ok: c.ok, detail: c.detail })) });
const failed = (g) => g.checks.filter((c) => !c.ok).map((c) => c.n + '. ' + c.check + ' (' + (c.detail || '') + ')').join('; ');

/* opts: { store, now, policy, lab, loopCurrent, v2Current, tests ('run' | {ok, detail}), dryRun, season } */
function run(opts) {
  opts = opts || {};
  const now = opts.now || new Date().toISOString();
  const store = opts.store;
  const policy = opts.policy || policyOf(M.readJson(CONFIG));
  const season = opts.season || seasonFor(new Date(now));
  const lab = opts.lab !== undefined ? opts.lab : M.readJson(path.join(G.LAB, 'reports', String(season), 'lab.json'));
  const loopCurrent = opts.loopCurrent !== undefined ? opts.loopCurrent : M.readJson(path.join(REPO, 'football', 'cfb', 'model_loop', 'current.json'));
  const tests = opts.tests || 'run';
  const champBefore = GOV.champion(store.gov('model_roles'));
  const out = { schema: SCHEMA, rule: RULE, generated_at: now, enabled: policy.enabled, dry_run: !!opts.dryRun, champion_before: typeof champBefore === 'string' ? champBefore : null,
    champion_after: null, changed: false, rule_change: null, actions: [], considered: [], note: null };
  /* the switch is a governed rule (config.json): its first reading and every
     later change of it is a RULE_CHANGED row, whoever edited the file */
  const pol = { enabled: policy.enabled, register_loop_versions: policy.register_loop_versions, return_to_v1: policy.return_to_v1 };
  const lastPol = store.gov('audit_log').filter((e) => e.event_type === 'RULE_CHANGED' && e.subject === 'config.auto_promotion').map((e) => e.after).pop() || null;
  if (!opts.dryRun && JSON.stringify(lastPol) !== JSON.stringify(pol)) {
    store.append('audit_log', [GOV.auditEvent('RULE_CHANGED', 'config.auto_promotion', lastPol, pol,
      'football/cfb_lab/config.json auto_promotion ' + (lastPol ? 'changed' : 'first read') + ' (detected by the hourly lab run, ' + RULE + ')', 'automation', now)], 'event_id');
    out.rule_change = pol;
  }
  if (!policy.enabled) return Object.assign(out, { champion_after: out.champion_before, note: 'automatic promotion is switched off (football/cfb_lab/config.json auto_promotion.enabled): a person promotes' });
  if (typeof champBefore !== 'string') return Object.assign(out, { note: 'governance has no single champion: nothing is done automatically until a person resolves it' });

  /* the guard, with the live captures read from THIS store; the tests run only
     once every other check has passed (they take about half a minute) */
  const guardFor = (model, rollback) => {
    const roles = GOV.currentRoles(store.gov('model_roles'));
    const captured = [...new Set(store.predictions().filter((p) => p.model_version === model && p.origin === 'LIVE').map((p) => p.calibration_version))];
    const base = { roles, rollback, lab, loopCurrent, now, season, capturedCalibrations: captured };
    const pre = PG.guard(model, Object.assign({}, base, { tests: { ok: true, detail: 'not run yet' } }));
    if (!pre.ok) return pre;
    return PG.guard(model, Object.assign({}, base, { tests }));
  };
  const act = (a) => { out.actions.push(a); if (a.done) out.changed = true; };
  const reasonOf = (ev) => 'automatic (' + RULE + '): the Model Lab promotion evaluation (' + (ev.rule || 'cfb_lab_promotion_v1') + ') is ELIGIBLE against ' + ev.champion
    + ' on ' + ev.n + ' common official games, MAE difference ' + ev.mae_diff + ' [' + (ev.mae_diff_ci || []).join(', ') + '], weekly win share ' + ev.weekly_win_share;
  const evidence = path.relative(REPO, path.join(G.LAB, 'reports', String(season), 'promotion.json'));
  let champ = champBefore;

  /* 1 return to V1 when the champion's source serves another version */
  const roles0 = GOV.currentRoles(store.gov('model_roles'));
  const table = CHB.build({ roles: store.gov('model_roles'), now, loopCurrent, v2Current: opts.v2Current, slate: { games: [] } });
  if (policy.return_to_v1 && (table.kind === 'LOOP' || table.kind === 'V2') && table.served_version && table.served_version !== champ) {
    const v1 = Object.keys(roles0).filter((k) => CHB.kindOf(k) === 'V1' && roles0[k].role !== 'retired').sort((a, b) => Date.parse(roles0[b].effective_at) - Date.parse(roles0[a].effective_at))[0];
    const reason = 'automatic return to V1 (' + RULE + '): the champion ' + champ + ' is no longer served (' + table.source + ' serves ' + table.served_version + '), so V1 has priced every game since; the served version is measured against V1';
    if (!v1) act({ action: 'RETURN_TO_V1', model: null, from: champ, done: false, reason, refused: 'no registered V1 to return to' });
    else {
      const g = guardFor(v1, true);
      if (!g.ok) act({ action: 'RETURN_TO_V1', model: v1, from: champ, done: false, reason, refused: failed(g), guard: brief(g) });
      else {
        if (!opts.dryRun) GOV.promote(store, v1, reason, policy.actor, { guard: g, at: now });
        act({ action: 'RETURN_TO_V1', model: v1, from: champ, done: !opts.dryRun, reason, guard: brief(g) });
        champ = v1;
      }
    }
  }

  /* 2 register the version the model loop serves, if the Lab has never seen it */
  const served = M.loopAdapter({ loopCurrent, slate: { games: [] } });
  if (policy.register_loop_versions && served.model_version && !GOV.currentRoles(store.gov('model_roles'))[served.model_version]) {
    const mv = served.model_version, reason = 'automatic (' + RULE + '): the model loop now serves ' + mv + '; tracked live from its first capture, promoted only on the Model Lab evaluation';
    if (!opts.dryRun) {
      GOV.register(store, mv, served.label, 'challenger', 'loop', reason, policy.actor, { at: now });
      const ids = Object.keys(GOV.experiments(store.gov('experiments'))).map((k) => Number((/^EXP-(\d+)$/.exec(k) || [])[1])).filter((n) => n > 0);
      const id = 'EXP-' + String((ids.length ? Math.max.apply(null, ids) : 0) + 1).padStart(3, '0');
      GOV.experimentCreate(store, { id, name: served.label + ' vs ' + champ + ' champion', baseline: champ, challenger: mv,
        hypothesis: 'Model loop release ' + mv + ' predicts live margins more accurately than the champion ' + champ + '.',
        change: 'model loop release ' + mv + ' (whole model)', scope: 'ARCHITECTURE', window: 'LIVE ' + season + ' from ' + now.slice(0, 10) + ', promotion evaluation at 150 common official games', status: 'RUNNING', start: now.slice(0, 10) }, policy.actor, now);
    }
    act({ action: 'REGISTER', model: mv, role: 'challenger', done: !opts.dryRun, reason });
  }

  /* 3 promote the best ELIGIBLE challenger against the current champion */
  const evs = (lab && lab.comparison && lab.comparison.promotion && lab.comparison.promotion.evaluations) || [];
  const roles = GOV.currentRoles(store.gov('model_roles'));
  const servedLoop = served.model_version;
  const key = (e) => (e.decision === 'ELIGIBLE' && e.ready ? 0 : 1);
  const ranked = evs.slice().sort((a, b) => (key(a) - key(b)) || ((typeof a.mae_diff === 'number' ? a.mae_diff : 99) - (typeof b.mae_diff === 'number' ? b.mae_diff : 99)) || (b.n - a.n));
  let promoted = false;
  ranked.forEach((ev) => {
    const c = { challenger: ev.challenger, decision: ev.decision, n: ev.n, min_n: ev.min_n, mae_diff: ev.mae_diff, mae_diff_ci: ev.mae_diff_ci, outcome: null };
    out.considered.push(c);
    if (ev.decision !== 'ELIGIBLE' || !ev.ready) { c.outcome = 'not eligible (' + ev.decision + ')'; return; }
    if (champ !== champBefore) { c.outcome = 'not this run: the champion just returned to V1, and this evaluation was against ' + ev.champion; return; }
    if (ev.champion !== champ) { c.outcome = 'evaluated against ' + ev.champion + ', not the current champion ' + champ + ': waits for the next evaluation'; return; }
    if (promoted) { c.outcome = 'not this run: ' + out.champion_after + ' was promoted; next it is evaluated against the new champion'; return; }
    const r = roles[ev.challenger];
    if (!r || (r.role !== 'challenger' && r.role !== 'candidate')) { c.outcome = 'role ' + (r ? r.role : 'none'); return; }
    if (CHB.kindOf(ev.challenger) === 'LOOP' && ev.challenger !== servedLoop) { c.outcome = 'the model loop no longer serves it (serves ' + (servedLoop || 'nothing readable') + ')'; return; }
    const g = guardFor(ev.challenger, CHB.kindOf(ev.challenger) === 'V1');
    if (!g.ok) { c.outcome = 'refused by the promotion guard: ' + failed(g); c.guard = brief(g); return; }
    const reason = reasonOf(ev);
    if (!opts.dryRun) GOV.promote(store, ev.challenger, reason, policy.actor, { guard: g, evidence, at: now });
    act({ action: 'PROMOTE', model: ev.challenger, from: champ, done: !opts.dryRun, reason, evidence, guard: brief(g) });
    c.outcome = opts.dryRun ? 'would be promoted (dry run)' : 'PROMOTED';
    out.champion_after = ev.challenger;
    promoted = true;
  });
  if (!promoted) out.champion_after = champ;
  const done = out.actions.filter((a) => a.done);
  out.note = done.length ? done.map((a) => a.action + ' ' + a.model).join('; ')
    : (out.actions.length ? out.actions.map((a) => a.action + ' ' + (a.model || '') + (a.refused ? ' refused: ' + a.refused : ' (dry run)')).join('; ')
      : 'no change: ' + (ranked.some((e) => e.decision === 'ELIGIBLE') ? 'an eligible challenger was not promoted (see considered)' : 'no challenger is ELIGIBLE against ' + champ));
  return out;
}

/* the issue the workflow opens when the champion changed */
function summary(res) {
  const p = res.actions.find((a) => a.done && (a.action === 'PROMOTE' || a.action === 'RETURN_TO_V1'));
  const reg = res.actions.filter((a) => a.done && a.action === 'REGISTER');
  const title = p ? (p.action === 'PROMOTE' ? 'CFB board: ' + p.model + ' was promoted to champion automatically' : 'CFB board: back on V1 automatically (' + p.from + ' is no longer served)')
    : (reg.length ? 'CFB Model Lab: now tracking ' + reg.map((a) => a.model).join(', ') : null);
  if (!title) return null;
  const lines = ['**' + title + '**', '', 'Champion before: `' + res.champion_before + '`, after: `' + res.champion_after + '`.', ''];
  res.actions.filter((a) => a.done).forEach((a) => {
    lines.push('- **' + a.action + '** `' + a.model + '`: ' + a.reason);
    if (a.guard) lines.push('  - promotion guard: ' + a.guard.checks.map((c) => c.n + (c.ok ? ' PASS' : ' FAIL')).join(', '));
  });
  lines.push('', 'The next steps of this lab run build the champion table, and the board and the slate price from it.',
    'To undo: `node football/cfb_lab/governance.js promote --model <previous champion> --rollback --reason "<why>" --actor <name>` (V1), or `promote` the previous version.',
    'To stop automatic promotion: set `auto_promotion.enabled` to false in `football/cfb_lab/config.json`.', '', 'Written by `football/cfb_production/auto_promote.js` (' + res.rule + '); full record in `football/cfb_production/reports/auto_promotion.json` and `football/cfb_lab/governance/audit_log.jsonl`.');
  return { title, body: lines.join('\n') };
}

function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const cfg = M.readJson(CONFIG) || {};
  const season = Number(v('--season', cfg.season || seasonFor()));
  const res = run({ store: new G.Store(season), season, dryRun: a.includes('--dry-run'), policy: policyOf(cfg) });
  if (a.includes('--write') && !res.dry_run) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1) + '\n');
  }
  res.actions.forEach((x) => console.log((x.done ? 'DONE    ' : (res.dry_run ? 'WOULD   ' : 'REFUSED ')) + x.action + ' ' + (x.model || '') + (x.refused ? ' — ' + x.refused : '')));
  res.considered.forEach((c) => console.log('  ' + c.challenger + ': ' + c.decision + ' (n ' + c.n + ' of ' + c.min_n + ', MAE diff ' + c.mae_diff + ') — ' + c.outcome));
  console.log('automatic promotion: ' + res.note);
  const s = res.changed ? summary(res) : null;
  if (s) console.log('::notice::' + s.title);
  if (process.env.GITHUB_OUTPUT) {
    const champChanged = res.champion_after !== res.champion_before;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + (s ? 'true' : 'false') + '\nchampion_changed=' + (champChanged ? 'true' : 'false') + '\n' + (s ? 'title=' + s.title.replace(/\n/g, ' ') + '\n' : ''));
    if (s && process.env.RUNNER_TEMP) fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'auto_promotion.md'), s.body + '\n');
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Automatic promotion\n' + (s ? s.body : res.note) + '\n');
}
if (require.main === module) main();
module.exports = { run, summary, policyOf, RULE, SCHEMA, OUT };
