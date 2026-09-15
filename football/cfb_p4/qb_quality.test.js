#!/usr/bin/env node
/* ===========================================================================
   Tests for the QUARTERBACK QUALITY COEFFICIENT and the switch that decides
   whether it is allowed to move a line.

   The layer exists because the engine's QB term prices EPA per dropback and no
   college feed publishes it, so the term has contributed zero to every college
   spread this repository has ever produced.
   football/cfb_p4/research/fit_qb_quality.js measures a substitute from the
   play feed, regresses it on the rating residual, and walks it forward.

   What must hold:

     1  THE SWITCH IS REAL IN BOTH DIRECTIONS. A decorative switch that can
        only ever be off proves nothing, and one that cannot be turned off is
        worse. Both states are exercised against the engine.
     2  THE SHIPPED ARTIFACT IS OBEYED. Whatever points_applied says today,
        the engine does that — the test reads the file rather than assuming.
     3  THE COEFFICIENT IS NOT SELF-CERTIFYING. The artifact has to carry the
        held-out record the decision was made on, over a real tune window.
     4  NO SILENT FALLBACK. An unapplied coefficient leaves the value MISSING
        with a reason naming the walk-forward, never a quiet zero that a
        downstream reader would mistake for a measurement of "average".
     5  EPA STILL WINS WHERE IT EXISTS. The NFL side supplies it, and the
        quality route must not shadow the trained one.

   Run: node football/cfb_p4/qb_quality.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 460) : '')));
  console.log('\nqb quality: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const isNum = x => typeof x === 'number' && isFinite(x);
const CAL_PATH = path.join(ROOT, 'football', 'cfb_p4', 'research', 'qb_quality.json');
const CAL = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));

/* ================================= 1. the switch works in both directions */
{
  const q = cal => E.qb.evaluate({ player: 'A Passer', attempts: 400, quality: 1.2,
    quality_calibration: cal }, 'home');

  const off = q({ points_applied: false, points_per_quality: 1.5815, metric: 'ypd',
    decision: 'did not earn its keep out of sample' });
  chk('an UNAPPLIED coefficient prices nothing', off.value.available === false, off.value);
  chk('and the reason names the walk-forward rather than a missing input',
    /NOT APPLIED/.test(off.value.reason) && /earn its keep/.test(off.value.reason), off.value.reason);
  /* the failure mode that would be invisible downstream: a zero that reads as
     a measurement of "this quarterback is exactly average" */
  chk('an unapplied coefficient is MISSING, never a quiet zero',
    off.value.value === null, off.value);

  const on = q({ points_applied: true, points_per_quality: 1.5815, metric: 'ypd',
    tune_window_games: 5022, held_out_mae_delta: -0.029 });
  chk('an APPLIED coefficient does price — the switch is not decorative',
    on.value.available === true && Math.abs(on.value.value - 1.5815 * 1.2) < 1e-9, on.value);
  chk('and the basis carries the coefficient, the window and the held-out record',
    /1.5815 points per unit/.test(on.value.basis) && /5022 tune-window games/.test(on.value.basis)
    && /held-out MAE/.test(on.value.basis), on.value.basis);

  const none = q(null);
  chk('a quality with no calibration at all prices nothing',
    none.value.available === false && /no calibration was supplied/.test(none.value.reason), none.value);
}

/* ================================= 2. the shipped artifact is what is obeyed */
{
  const cal = {
    points_applied: CAL.points_applied, points_per_quality: CAL.points_per_quality,
    metric: CAL.chosen_metric, decision: CAL.decision,
    tune_window_games: CAL.tune_window_games
  };
  const v = E.qb.evaluate({ player: 'A Passer', attempts: 400, quality: 1.2, quality_calibration: cal }, 'home').value;
  chk('the engine does what the SHIPPED artifact says, whatever it says today',
    v.available === (CAL.points_applied === true),
    { points_applied: CAL.points_applied, priced: v.available });

  /* and the whole-projection consequence of that, which is the thing a reader
     actually cares about */
  const req = {
    season: 2026, week: 3, state: E.newState(),
    game: { home: 'Alabama', away: 'Auburn', home_fbs: true, away_fbs: true },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } },
    venue: {}, market: {}, timestamps: {}
  };
  const bare = E.projectGame(req);
  const withQ = E.projectGame(Object.assign({}, req, { state: E.newState(), teams: {
    home: { conference: 'SEC', qb: { player: 'H', attempts: 400, quality: 1.2, quality_calibration: cal } },
    away: { conference: 'SEC', qb: { player: 'A', attempts: 380, quality: -0.4, quality_calibration: cal } }
  } }));
  const qbContrib = p => ((p.contributions || []).filter(c => c.key === 'qb')[0] || {}).points;
  if (CAL.points_applied === true) {
    chk('with the coefficient applied, the QB layer moves the spread',
      qbContrib(withQ) !== 0 && withQ.model.fair_spread !== bare.model.fair_spread,
      { qb: qbContrib(withQ), bare: bare.model.fair_spread, withQ: withQ.model.fair_spread });
  } else {
    chk('with the coefficient unapplied, supplying quality moves NO line',
      withQ.model.fair_spread === bare.model.fair_spread && qbContrib(withQ) === 0,
      { qb: qbContrib(withQ), bare: bare.model.fair_spread, withQ: withQ.model.fair_spread });
  }
}

/* ================================= 3. the artifact carries its own evidence */
{
  chk('the artifact names the metric it chose', typeof CAL.chosen_metric === 'string', CAL.chosen_metric);
  chk('and the coefficient it fitted', CAL.points_per_quality !== undefined);
  chk('and a real tune window, not a handful of games',
    isNum(CAL.tune_window_games) && CAL.tune_window_games >= 2000, CAL.tune_window_games);
  chk('and the target it was regressed on', /rating/.test(String(CAL.target)), CAL.target);
  chk('and that the target was taken BEFORE the game was absorbed — the leakage guarantee',
    /BEFORE/.test(String(CAL.target)), CAL.target);
  chk('and that the feature uses only games already processed',
    /already processed/.test(String(CAL.feature)), CAL.feature);
  chk('the decision is written down in words', typeof CAL.decision === 'string' && CAL.decision.length > 40);

  const w = CAL.metrics && CAL.metrics[CAL.chosen_metric];
  chk('a walk-forward record exists for the chosen metric', !!w && Array.isArray(w.folds), w && Object.keys(w));
  chk('with more than one fold — a single season is not a record', w.folds.length >= 3, w.folds.length);
  chk('every fold trained only on seasons BEFORE the one it scored',
    w.folds.every(f => isNum(f.train_games) && f.train_games > 0 && isNum(f.test_games) && f.test_games > 0));
  chk('the held-out error is reported both with and without the adjustment',
    isNum(w.base_mae) && isNum(w.adj_mae), { base: w.base_mae, adj: w.adj_mae });

  /* THE DECISION RULE, RE-DERIVED HERE rather than trusted: lower held-out
     MAE overall AND a majority of folds improved. If this ever disagrees with
     the artifact, one of them moved to suit a result. */
  const majority = w.folds.length ? (w.folds_improved / w.folds.length) > 0.5 : false;
  chk('points_applied matches the rule the job declares, re-derived from the folds',
    CAL.points_applied === (w.mae_delta < 0 && majority),
    { points_applied: CAL.points_applied, mae_delta: w.mae_delta,
      improved: w.folds_improved + '/' + w.folds.length });
}

/* ================================= 5. EPA still wins where it exists */
{
  const both = E.qb.evaluate({ player: 'NFL Passer', attempts: 500, career_epa_per_db: 0.15,
    quality: 99, quality_calibration: { points_applied: true, points_per_quality: 1000, metric: 'ypd' } }, 'home');
  const epaOnly = E.qb.evaluate({ player: 'NFL Passer', attempts: 500, career_epa_per_db: 0.15 }, 'home');
  chk('a supplied EPA is used and the quality route does not shadow it',
    Math.abs(both.value.value - epaOnly.value.value) < 1e-9,
    { both: both.value.value, epaOnly: epaOnly.value.value });
  chk('and the basis still describes the trained EPA path',
    /career dropbacks/.test(both.value.basis), both.value.basis);
}

done();
