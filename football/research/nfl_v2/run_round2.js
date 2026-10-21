#!/usr/bin/env node
/* ===========================================================================
   NFL v2, ROUND 2 — the candidates preregistered in preregistration.json
   (round_2) against the served model, scored by backtest.js, selected on
   2010-2024, gated on 2025. Same rules as Steps 2-4 (run_steps.js):

     Q1_qb_prior     the QB layer's prior x shrinkage grid (incumbent pair excluded)
     Q2_qb_out       qb_out_diff: a side's starter is not its regular starter
     S1_standardize  the strength ridge on unit-SD features, lambda grid

   Within a family the lowest 2010-2024 MAE (ties by log loss) is its pick; a
   FINALIST beats the incumbent on 2010-2024 MAE AND log loss and only then is
   the 2025 holdout looked at. Every subset (size >= 2) of finalists is tried
   the same way. PROMOTED: beats the incumbent on the 2025 holdout on MAE AND
   log loss. Among several promoting options the lowest 2010-2024 MAE (then log
   loss): preregistration.json holdout_method, "2025 is never used to choose a
   hyperparameter, a feature or a toggle" — the holdout gates, it never ranks.
   (Step 4's code ranked passing options by 2025 MAE; RESULTS.md discloses it.)

   Writes results/round2.json and appends every variant to results/variants.jsonl
   (holdout looks flagged).

   --promote then serves the promoted configuration, as the weekly loop would:
   it must also pass the loop's gate (weekly_loop.js gate: MAE and log loss on
   the full backtest, the 2025 holdout and 2010-2025); train.js writes
   football/nfl_params_v2.js trained through 2025, the params are archived
   under versions/, and registry.json records the version, every round-2
   result and the promotion (rollback: weekly_loop.js --rollback edgedesk_nfl_v2.0.0).

   Usage: node football/research/nfl_v2/run_round2.js [--promote]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./backtest.js');
const S = require('./run_steps.js');
const L = require('./weekly_loop.js');

const STEP = 'round2';
const PREREG = JSON.parse(fs.readFileSync(path.join(__dirname, 'preregistration.json'), 'utf8')).round_2;

/* seasons of 2010-2024 where a candidate's MAE is below the incumbent's */
function seasonWins(r, incR) {
  const inc = Object.fromEntries(incR.by_season.map((x) => [x.season, x]));
  const v = r.by_season.filter((x) => x.season >= B.VALID[0] && x.season <= B.VALID[1] && inc[x.season]);
  return { seasons: v.length, mae_better: v.filter((x) => x.mae < inc[x.season].mae).length, logloss_better: v.filter((x) => x.logloss < inc[x.season].logloss).length };
}
function validate(family, label, cfg) {
  const r = B.evaluate(cfg);
  const rec = { step: STEP, family, label, cfg, valid: B.slim(r.valid), valid_close: { mae: +r.valid.close.mae.toFixed(4), logloss: +r.valid.close.logloss.toFixed(5) }, holdout_looked: false };
  B.logVariant(rec);
  return { label, cfg, valid: rec.valid, r };
}
function holdout(family, label, cfg, r) {
  const rec = { step: STEP, family, label, cfg, valid: B.slim(r.valid), holdout: B.slim(r.holdout), holdout_close: { mae: +r.holdout.close.mae.toFixed(4), logloss: +r.holdout.close.logloss.toFixed(5), brier: +r.holdout.close.brier.toFixed(5) }, holdout_looked: true };
  B.logVariant(rec);
  return rec.holdout;
}
const better = (a, b) => !b || a.valid.mae < b.valid.mae || (a.valid.mae === b.valid.mae && a.valid.logloss < b.valid.logloss);
const beats = (c, inc) => c.mae < inc.mae && c.logloss < inc.logloss;

function round2() {
  const PV = L.loadParams();
  if (PV.model_version !== PREREG.incumbent.id || PV.config_sha !== PREREG.incumbent.config_sha) throw new Error(`the served params are ${PV.model_version} (${PV.config_sha}), not the preregistered incumbent ${PREREG.incumbent.id}`);
  const base = PV.cfg;
  const incR = B.evaluate(base);
  const incV = B.slim(incR.valid), incH = B.slim(incR.holdout);
  console.log(`incumbent ${PV.model_version}: valid ${incV.mae} / ${incV.logloss} | 2025 ${incH.mae} / ${incH.logloss}`);

  /* each family's pick on validation */
  const fam = {};
  const Q1 = PREREG.candidates.Q1_qb_prior;
  for (const qp of Q1.qb_prior) for (const k of Q1.qb_shrink) {
    if (qp === base.qb.qb_prior && k === base.qb.qb_shrink) continue;
    const over = { qb: { qb_prior: qp, qb_shrink: k } };
    const x = validate('Q1_qb_prior', `QB prior ${qp} shrink ${k}`, S.merge(base, over));
    x.over = over; x.tried = (fam.Q1_qb_prior && fam.Q1_qb_prior.tried || 0) + 1;
    console.log(`  Q1 ${x.label}: ${x.valid.mae} / ${x.valid.logloss}`);
    if (better(x, fam.Q1_qb_prior)) fam.Q1_qb_prior = x; else fam.Q1_qb_prior.tried = x.tried;
  }
  {
    const over = { features: { qb_out: true } };
    const x = validate('Q2_qb_out', 'regular starter out (qb_out_diff)', S.merge(base, over));
    x.over = over; x.tried = 1;
    console.log(`  Q2 ${x.label}: ${x.valid.mae} / ${x.valid.logloss}`);
    fam.Q2_qb_out = x;
  }
  for (const lam of PREREG.candidates.S1_standardize.ridge_strength_lambda) {
    const over = { ridge: { standardize: true, strength: lam } };
    const x = validate('S1_standardize', `standardised strength ridge lambda ${lam}`, S.merge(base, over));
    x.over = over; x.tried = (fam.S1_standardize && fam.S1_standardize.tried || 0) + 1;
    console.log(`  S1 ${x.label}: ${x.valid.mae} / ${x.valid.logloss}`);
    if (better(x, fam.S1_standardize)) fam.S1_standardize = x; else fam.S1_standardize.tried = x.tried;
  }

  /* finalists and their holdout looks */
  const decisions = Object.keys(fam).map((k) => {
    const x = fam[k], fin = beats(x.valid, incV);
    const h = fin ? holdout(k, x.label, x.cfg, x.r) : null;
    const promotes = fin && beats(h, incH);
    return { family: k, label: x.label, variants_tried: x.tried, over: x.over, cfg: x.cfg, valid: x.valid, holdout: h, finalist: fin, promotes, season_wins_2010_2024: seasonWins(x.r, incR),
      why: !fin ? 'did not beat the incumbent on 2010-2024 validation (MAE and log loss)' : (promotes ? 'beats the incumbent on validation and on the 2025 holdout (MAE and log loss)' : 'beat validation but not the 2025 holdout') };
  });
  /* combinations of finalists */
  const fl = decisions.filter((d) => d.finalist), combos = [];
  for (let mask = 1; mask < (1 << fl.length); mask++) {
    const parts = fl.filter((_, j) => mask & (1 << j));
    if (parts.length < 2) continue;
    let cfg = base; parts.forEach((p) => { cfg = S.merge(cfg, p.over); });
    const label = 'combination: ' + parts.map((p) => p.label).join(' + ');
    const x = validate('combination', label, cfg), fin = beats(x.valid, incV);
    const h = fin ? holdout('combination', label, cfg, x.r) : null;
    combos.push({ label, parts: parts.map((p) => p.family), cfg, valid: x.valid, holdout: h, finalist: fin, promotes: fin && beats(h, incH), season_wins_2010_2024: seasonWins(x.r, incR) });
  }
  const options = decisions.filter((d) => d.promotes).map((d) => ({ label: d.label, cfg: d.cfg, valid: d.valid, holdout: d.holdout }))
    .concat(combos.filter((c) => c.promotes).map((c) => ({ label: c.label, cfg: c.cfg, valid: c.valid, holdout: c.holdout })));
  options.sort((a, b) => a.valid.mae - b.valid.mae || a.valid.logloss - b.valid.logloss);
  const pick = options[0] || null;
  const out = { step: STEP, generated_at: new Date().toISOString(), preregistered_at: PREREG.registered_at,
    incumbent: { model_version: PV.model_version, config_sha: PV.config_sha, valid: incV, holdout: incH },
    close: { valid: { mae: +incR.valid.close.mae.toFixed(4), logloss: +incR.valid.close.logloss.toFixed(5) }, holdout: { mae: +incR.holdout.close.mae.toFixed(4), logloss: +incR.holdout.close.logloss.toFixed(5) } },
    decisions: decisions.map((d) => Object.assign({}, d, { cfg: undefined })), combinations: combos.map((c) => Object.assign({}, c, { cfg: undefined })),
    choice_rule: 'among promoting options the lowest 2010-2024 MAE, then log loss (the holdout gates, it never ranks)',
    promoted: pick ? pick.label : null, promoted_version: pick ? 'edgedesk_nfl_v2.1.0' : null,
    not_chosen: options.slice(1).map((o) => ({ label: o.label, valid: o.valid, holdout: o.holdout })),
    promoted_cfg: pick ? pick.cfg : base, promoted_valid: pick ? pick.valid : incV, promoted_holdout: pick ? pick.holdout : incH };
  fs.writeFileSync(path.join(B.RES, 'round2.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(S.HEAD);
  console.log(S.row(PV.model_version + ' (incumbent)', incV, incH));
  decisions.forEach((d) => console.log(S.row(`${d.family}: ${d.label}`, d.valid, d.holdout)));
  combos.forEach((c) => console.log(S.row(c.label, c.valid, c.holdout)));
  decisions.forEach((d) => console.log(`  ${d.family}: ${d.why}; better MAE in ${d.season_wins_2010_2024.mae_better}/${d.season_wins_2010_2024.seasons} seasons, log loss ${d.season_wins_2010_2024.logloss_better}`));
  combos.forEach((c) => console.log(`  ${c.label}: better MAE in ${c.season_wins_2010_2024.mae_better}/${c.season_wins_2010_2024.seasons} seasons, log loss ${c.season_wins_2010_2024.logloss_better}`));
  combos.forEach((c) => console.log(`  ${c.label}: ${c.promotes ? 'PROMOTES' : (c.finalist ? 'beat validation but not the 2025 holdout' : 'did not beat validation')}`));
  console.log('promoted:', out.promoted || 'nothing — the incumbent stays');
  return out;
}
/* serve round 2's promoted configuration (reads results/round2.json) */
function promote() {
  const T = require('./train.js');
  const crypto = require('crypto');
  const R = JSON.parse(fs.readFileSync(path.join(B.RES, 'round2.json'), 'utf8'));
  if (!R.promoted) { console.log('round 2 promoted nothing; the served model stays'); return null; }
  const PV = L.loadParams();
  if (PV.model_version !== R.incumbent.model_version) throw new Error(`served ${PV.model_version}, round 2 ran against ${R.incumbent.model_version}`);
  const version = L.nextVersion(PV.model_version);
  if (version !== R.promoted_version) throw new Error(`next version ${version}, preregistered ${R.promoted_version}`);
  const inc = L.evaluateCfg(B, PV.cfg), cand = L.evaluateCfg(B, R.promoted_cfg), g = L.gate(cand, inc);
  if (!g.passed) { console.log('the weekly loop gate refuses it: ' + g.why); return null; }
  const { doc } = T.writeParams({ cfg: R.promoted_cfg, through: B.HOLDOUT, version, active: true, parent: PV.model_version,
    source: 'football/research/nfl_v2/results/round2.json: ' + R.promoted, out: L.PATHS.params });
  const reg = JSON.parse(fs.readFileSync(L.PATHS.reg, 'utf8'));
  const sha = (c) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);
  const overOf = Object.fromEntries(R.decisions.map((d) => [d.family, d.over]));
  R.decisions.concat(R.combinations).forEach((d) => {
    const cfg = (d.parts || [d.family]).reduce((c, f) => S.merge(c, overOf[f]), PV.cfg);
    reg.results.push({ run: 'round2', candidate: (d.family || 'combination') + ':' + d.label, family: d.family || 'combination', model_key: L.CANDIDATES_KEY,
      evaluated_at: R.generated_at, cfg_sha: cfg ? sha(cfg) : null, passed: !!d.promotes,
      metrics: { valid: d.valid, holdout: d.holdout || null }, incumbent: { model_version: PV.model_version, valid: R.incumbent.valid, holdout: R.incumbent.holdout },
      why: d.why || (d.promotes ? 'beats the incumbent on validation and on the 2025 holdout (MAE and log loss)' : (d.finalist ? 'beat validation but not the 2025 holdout' : 'did not beat the incumbent on 2010-2024 validation (MAE and log loss)')) });
  });
  const at = new Date().toISOString();
  reg.versions.forEach((x) => { if (x.model_version === PV.model_version) x.status = 'superseded'; });
  fs.mkdirSync(L.PATHS.versions, { recursive: true });
  const arch = path.join(L.PATHS.versions, version + '.js');
  fs.copyFileSync(L.PATHS.params, arch);
  reg.versions.push({ model_version: version, status: 'served', role: 'round 2 promotion: ' + R.promoted, cfg: R.promoted_cfg, config_sha: doc.config_sha,
    parent: PV.model_version, created_at: doc.built_at, archive: path.relative(path.join(__dirname, '..', '..', '..'), arch),
    metrics: { valid: doc.validation.valid_2010_2024, holdout: doc.validation.holdout_2025, full: cand.full, without_current_season: cand.through_holdout,
      close: { valid: doc.validation.close_valid, holdout: doc.validation.close_holdout }, beats_closing_line: doc.validation.beats_closing_line, weekly_gate: g.checks } });
  reg.current = version;
  reg.events.push({ at, kind: 'promote', from: PV.model_version, to: version, run: 'round2' });
  reg.updated_at = at;
  fs.writeFileSync(L.PATHS.reg, JSON.stringify(reg, null, 1) + '\n');
  console.log(`promoted ${version} (${doc.config_sha}) from ${PV.model_version}: 2025 MAE ${doc.validation.holdout_2025.mae} / log loss ${doc.validation.holdout_2025.logloss} (close ${doc.validation.close_holdout.mae} / ${doc.validation.close_holdout.logloss})`);
  return { version, doc, gate: g };
}

if (require.main === module) { if (process.argv.includes('--promote')) promote(); else round2(); }
module.exports = { round2, promote };
