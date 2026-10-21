#!/usr/bin/env node
/* ===========================================================================
   NFL v2, ROUND 3 — the candidates preregistered in preregistration.json
   (round_3) against the served model:

     Q3_qb_out_gap   qb_out_gap_diff: an OUT side's regular starter's QB value
                     minus his replacement's (the out term scaled by who is missing)
     Q1x_qb_prior    the QB prior x shrinkage grid past round 2's edge
     S1x_lambda      the standardised strength ridge past round 2's edge
     T2r_recency     in-season recency on the round-2 model

   Rules (stricter than rounds 1-2; the 2025 holdout has gated 14 earlier
   decisions): within a family the lowest 2010-2024 MAE (ties by log loss) is
   its pick. A FINALIST beats the incumbent on 2010-2024 MAE AND log loss AND
   has the lower MAE in at least 9 of the 15 validation seasons; only then are
   the other windows looked at. Every subset (size >= 2) of finalists is tried
   the same way. PROMOTED: beats the incumbent on MAE AND log loss on all three
   windows of the weekly loop gate (weekly_loop.js gate: the full backtest,
   the 2025 holdout, 2010-2025). Among several, the lowest 2010-2024 MAE, then
   log loss: the holdout gates, it never ranks.

   Writes results/round3.json and appends every variant to results/variants.jsonl
   (gate looks flagged holdout_looked). --promote records every result in
   registry.json and serves the pick, if any, as edgedesk_nfl_v2.2.0
   (train.js, versions/), as round 2 did.

   Usage: node football/research/nfl_v2/run_round3.js [--promote]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./backtest.js');
const S = require('./run_steps.js');
const L = require('./weekly_loop.js');

const STEP = 'round3';
const PREREG = JSON.parse(fs.readFileSync(path.join(__dirname, 'preregistration.json'), 'utf8')).round_3;
const MIN_SEASON_WINS = 9;
const OUT = path.join(B.RES, 'round3.json');

/* the preregistered candidates, family by family, as overrides of the incumbent */
function families(base) {
  const C = PREREG.candidates, F = {};
  F.Q3_qb_out_gap = [{ label: 'QB out gap (qb_out_gap_diff)', over: { features: { qb_out_gap: true } } }];
  F.Q1x_qb_prior = [];
  for (const qp of C.Q1x_qb_prior.qb_prior) for (const k of C.Q1x_qb_prior.qb_shrink) {
    if (qp === base.qb.qb_prior && k === base.qb.qb_shrink) continue;
    F.Q1x_qb_prior.push({ label: `QB prior ${qp} shrink ${k}`, over: { qb: { qb_prior: qp, qb_shrink: k } } });
  }
  F.S1x_lambda = C.S1x_lambda.ridge_strength_lambda.map((lam) => ({ label: `standardised strength ridge lambda ${lam}`, over: { ridge: { standardize: true, strength: lam } } }));
  F.T2r_recency = C.T2r_recency.recency.map((r) => ({ label: `in-season recency lambda ${r}`, over: { recency: r } }));
  return F;
}

const sha = (c) => crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);
const beats = (c, inc) => !!(c && inc && c.mae < inc.mae && c.logloss < inc.logloss);
const better = (a, b) => !b || a.valid.mae < b.valid.mae || (a.valid.mae === b.valid.mae && a.valid.logloss < b.valid.logloss);
/* seasons of 2010-2024 where a candidate's MAE is below the incumbent's */
function seasonWins(r, incR) {
  const inc = Object.fromEntries(incR.by_season.map((x) => [x.season, x]));
  const v = r.by_season.filter((x) => x.season >= B.VALID[0] && x.season <= B.VALID[1] && inc[x.season]);
  return { seasons: v.length, mae_better: v.filter((x) => x.mae < inc[x.season].mae).length, logloss_better: v.filter((x) => x.logloss < inc[x.season].logloss).length };
}
/* a candidate's validation record (nothing past 2024 is read) */
function validate(family, label, cfg, incR) {
  const r = B.evaluate(cfg, { keepPreds: true });
  const rec = { step: STEP, family, label, cfg, valid: B.slim(r.valid), valid_close: { mae: +r.valid.close.mae.toFixed(4), logloss: +r.valid.close.logloss.toFixed(5) }, holdout_looked: false };
  B.logVariant(rec);
  return { label, cfg, valid: rec.valid, wins: seasonWins(r, incR), r };
}
/* the gate look: the weekly loop's three windows, on the record */
function gateLook(family, label, cfg, r, incW) {
  const live = B.score(r.preds, B.range(B.VALID[0], B.LIVE)), ex = B.score(r.preds, B.range(B.VALID[0], B.HOLDOUT));
  const w = { valid: B.slim(r.valid), holdout: B.slim(r.holdout), full: B.slim(live), through_holdout: B.slim(ex), live: B.slim(r.live) };
  const g = L.gate(w, incW);
  B.logVariant({ step: STEP, family, label, cfg, valid: w.valid, holdout: w.holdout, full: w.full, through_holdout: w.through_holdout, holdout_looked: true, passed: g.passed });
  return { windows: w, gate: g };
}

function round3() {
  const PV = L.loadParams();
  if (PV.model_version !== PREREG.incumbent.id || PV.config_sha !== PREREG.incumbent.config_sha) throw new Error(`the served params are ${PV.model_version} (${PV.config_sha}), not the preregistered incumbent ${PREREG.incumbent.id}`);
  const base = PV.cfg;
  const incR = B.evaluate(base, { keepPreds: true });
  const incW = L.evaluateCfg(B, base);
  const incV = B.slim(incR.valid);
  console.log(`incumbent ${PV.model_version}: valid ${incV.mae} / ${incV.logloss}`);

  const F = families(base), picks = {};
  for (const fam of Object.keys(F)) {
    for (const c of F[fam]) {
      const x = validate(fam, c.label, S.merge(base, c.over), incR);
      x.over = c.over;
      console.log(`  ${fam} ${x.label}: ${x.valid.mae} / ${x.valid.logloss} (MAE better in ${x.wins.mae_better}/${x.wins.seasons})`);
      if (better(x, picks[fam])) picks[fam] = x;
    }
    picks[fam].tried = F[fam].length;
  }
  const isFinalist = (x) => beats(x.valid, incV) && x.wins.mae_better >= MIN_SEASON_WINS;
  const whyNot = (x) => (!beats(x.valid, incV) ? 'did not beat the incumbent on 2010-2024 validation (MAE and log loss)'
    : `beat 2010-2024 validation but had the lower MAE in only ${x.wins.mae_better} of ${x.wins.seasons} seasons (needs ${MIN_SEASON_WINS})`);
  const decisions = Object.keys(picks).map((fam) => {
    const x = picks[fam], fin = isFinalist(x);
    const look = fin ? gateLook(fam, x.label, x.cfg, x.r, incW) : null;
    return { family: fam, label: x.label, variants_tried: x.tried, over: x.over, cfg_sha: sha(x.cfg), valid: x.valid, season_wins_2010_2024: x.wins, finalist: fin,
      windows: look ? look.windows : null, gate: look ? look.gate.checks : null, promotes: !!(look && look.gate.passed),
      why: !fin ? whyNot(x) : look.gate.why, cfg: x.cfg };
  });
  const fl = decisions.filter((d) => d.finalist), combos = [];
  for (let mask = 1; mask < (1 << fl.length); mask++) {
    const parts = fl.filter((_, j) => mask & (1 << j));
    if (parts.length < 2) continue;
    let cfg = base; parts.forEach((p) => { cfg = S.merge(cfg, p.over); });
    const label = 'combination: ' + parts.map((p) => p.label).join(' + ');
    const x = validate('combination', label, cfg, incR), fin = isFinalist(x);
    const look = fin ? gateLook('combination', label, cfg, x.r, incW) : null;
    combos.push({ label, parts: parts.map((p) => p.family), cfg_sha: sha(cfg), valid: x.valid, season_wins_2010_2024: x.wins, finalist: fin,
      windows: look ? look.windows : null, gate: look ? look.gate.checks : null, promotes: !!(look && look.gate.passed), why: !fin ? whyNot(x) : look.gate.why, cfg });
  }
  const options = decisions.concat(combos).filter((d) => d.promotes).sort((a, b) => a.valid.mae - b.valid.mae || a.valid.logloss - b.valid.logloss);
  const pick = options[0] || null;
  const strip = (d) => Object.assign({}, d, { cfg: undefined });
  const out = { step: STEP, generated_at: new Date().toISOString(), preregistered_at: PREREG.registered_at,
    rules: { finalist: PREREG.finalist_rule, promotion: PREREG.promotion_rule, min_season_wins: MIN_SEASON_WINS },
    incumbent: { model_version: PV.model_version, config_sha: PV.config_sha, valid: incV, windows: { holdout: incW.holdout, full: incW.full, through_holdout: incW.through_holdout } },
    close: incW.close,
    decisions: decisions.map(strip), combinations: combos.map(strip),
    promoted: pick ? pick.label : null, promoted_version: pick ? 'edgedesk_nfl_v2.2.0' : null, promoted_cfg: pick ? pick.cfg : null,
    not_chosen: options.slice(1).map((o) => ({ label: o.label, valid: o.valid, windows: o.windows })) };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const f = (x) => (x ? `${x.mae} / ${x.logloss}` : '—');
  console.log('| candidate | 2010–24 MAE / LL | seasons better (MAE) | 2025 | 2010–2026 | 2010–2025 | verdict |\n|---|---|---|---|---|---|---|');
  console.log(`| ${PV.model_version} (incumbent) | ${f(incV)} | — | ${f(incW.holdout)} | ${f(incW.full)} | ${f(incW.through_holdout)} | |`);
  decisions.concat(combos).forEach((d) => console.log(`| ${d.family ? d.family + ': ' : ''}${d.label} | ${f(d.valid)} | ${d.season_wins_2010_2024.mae_better}/${d.season_wins_2010_2024.seasons} | ${f(d.windows && d.windows.holdout)} | ${f(d.windows && d.windows.full)} | ${f(d.windows && d.windows.through_holdout)} | ${d.promotes ? 'passes' : d.why} |`));
  console.log('promoted:', out.promoted || 'nothing — the incumbent stays');
  return out;
}

/* record round 3 in the registry (every candidate judged) and serve its pick,
   if any (reads results/round3.json) */
function promote() {
  const T = require('./train.js');
  const R = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const PV = L.loadParams();
  if (PV.model_version !== R.incumbent.model_version) throw new Error(`served ${PV.model_version}, round 3 ran against ${R.incumbent.model_version}`);
  const reg = JSON.parse(fs.readFileSync(L.PATHS.reg, 'utf8'));
  if (reg.results.some((x) => x.run === 'round3')) throw new Error('registry.json already records round 3');
  R.decisions.concat(R.combinations).forEach((d) => reg.results.push({ run: 'round3', candidate: (d.family || 'combination') + ':' + d.label, family: d.family || 'combination',
    model_key: L.CANDIDATES_KEY, evaluated_at: R.generated_at, cfg_sha: d.cfg_sha, passed: !!d.promotes,
    metrics: { valid: d.valid, holdout: d.windows ? d.windows.holdout : null, full: d.windows ? d.windows.full : null, without_current_season: d.windows ? d.windows.through_holdout : null },
    incumbent: { model_version: PV.model_version, valid: R.incumbent.valid, holdout: R.incumbent.windows.holdout }, why: d.why }));
  if (!R.promoted) {
    reg.updated_at = new Date().toISOString();
    fs.writeFileSync(L.PATHS.reg, JSON.stringify(reg, null, 1) + '\n');
    console.log('round 3 promoted nothing; its results are recorded and the served model stays');
    return null;
  }
  const version = L.nextVersion(PV.model_version);
  if (version !== R.promoted_version) throw new Error(`next version ${version}, preregistered ${R.promoted_version}`);
  const { doc } = T.writeParams({ cfg: R.promoted_cfg, through: B.HOLDOUT, version, active: true, parent: PV.model_version,
    source: 'football/research/nfl_v2/results/round3.json: ' + R.promoted, out: L.PATHS.params });
  const pick = R.decisions.concat(R.combinations).find((d) => d.label === R.promoted);
  reg.versions.forEach((x) => { if (x.model_version === PV.model_version) x.status = 'superseded'; });
  fs.mkdirSync(L.PATHS.versions, { recursive: true });
  const arch = path.join(L.PATHS.versions, version + '.js');
  fs.copyFileSync(L.PATHS.params, arch);
  reg.versions.push({ model_version: version, status: 'served', role: 'round 3 promotion: ' + R.promoted, cfg: R.promoted_cfg, config_sha: doc.config_sha,
    parent: PV.model_version, created_at: doc.built_at, archive: path.relative(path.join(__dirname, '..', '..', '..'), arch),
    metrics: { valid: doc.validation.valid_2010_2024, holdout: doc.validation.holdout_2025, full: pick.windows.full, without_current_season: pick.windows.through_holdout,
      close: { valid: doc.validation.close_valid, holdout: doc.validation.close_holdout }, beats_closing_line: doc.validation.beats_closing_line, weekly_gate: pick.gate } });
  reg.current = version;
  reg.events.push({ at: doc.built_at, kind: 'promote', from: PV.model_version, to: version, run: 'round3' });
  reg.updated_at = doc.built_at;
  fs.writeFileSync(L.PATHS.reg, JSON.stringify(reg, null, 1) + '\n');
  console.log(`promoted ${version} (${doc.config_sha}) from ${PV.model_version}: 2025 MAE ${doc.validation.holdout_2025.mae} / log loss ${doc.validation.holdout_2025.logloss}`);
  return { version, doc };
}

if (require.main === module) { if (process.argv.includes('--promote')) promote(); else round3(); }
module.exports = { round3, promote, families, seasonWins };
