#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — train, evaluate and register a model version.

   THE FOUR RULES THIS JOB EXISTS TO ENFORCE:

   1. CHRONOLOGICAL SPLITS, NEVER RANDOM. A random split over match history
      lets the model see 2024 while being tested on 2019, which is not a test
      of anything. Train, validation and test are three consecutive windows in
      time, in that order, with no overlap. The windows are stored on the
      registry row so a published metric can always be traced to the period it
      was measured over.

   2. NO POST-MATCH INPUT. The training matrix is built from
      tennis.player_match_features and nothing else. That table contains only
      pre-match columns by construction, and this job asserts it again before
      it fits: if any model input name appears in the archive's post-match
      column list, it refuses to run.

   3. SYMMETRIC BY CONSTRUCTION. Every match enters training TWICE, once as
      (winner, loser) with y=1 and once as (loser, winner) with y=0. The
      features are differences, so this forces the model to be anti-symmetric:
      it cannot learn "the first player usually wins", because in this data the
      first player wins exactly half the time. Evaluation uses ONE orientation
      per match, chosen deterministically from the match id, so the metrics
      describe a real 50/50 decision rather than a doubled one.

   4. A NEW VERSION MUST EARN PRODUCTION. A candidate becomes active only if it
      beats the current active model AND the obvious baselines (official
      ranking, overall Elo, surface Elo) on log loss over the test window,
      without a calibration failure. Otherwise it is registered as a candidate
      with its results and production does not move. --force records the
      override and who made it.

   Usage:
     node tools/tennis/build_model.js                       # fit and report
     node tools/tennis/build_model.js --commit              # ...and register
     node tools/tennis/build_model.js --commit --activate   # ...and promote if it wins
     node tools/tennis/build_model.js --version tennis-baseline-1.1.0
     node tools/tennis/build_model.js --rollback tennis-baseline-1.0.0
   =========================================================================== */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');

const JOB = 'model_build';
const FAMILY = 'tennis_match_winner';

function args(argv) {
  const o = { commit: false, activate: false, trainFrac: 0.7, validFrac: 0.15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--activate') o.activate = true;
    else if (a === '--force') o.force = true;
    else if (a === '--version') o.version = next();
    else if (a === '--rollback') o.rollback = next();
    else if (a === '--since') o.since = next();
    else if (a === '--epochs') o.epochs = Number(next()) || null;
    else if (a === '--l2') o.l2 = Number(next());
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}
const say = (...a) => console.log(...a);
const fail = (...a) => console.error('::error::' + a.join(' '));
const pct = (x) => x == null ? '—' : (x * 100).toFixed(1) + '%';
const n4 = (x) => x == null ? '—' : Number(x).toFixed(4);

/* Deterministic coin flip per match, so the evaluation orientation is stable
   across runs and reproducible by anyone reading the registry row. */
function flip(matchId) {
  return crypto.createHash('sha1').update(String(matchId)).digest()[0] % 2 === 1;
}

function loadSql(since) {
  return `
select m.match_id, m.tour, m.match_date, m.surface, m.level, m.best_of, m.season,
       w.player_id as winner_id, l.player_id as loser_id,
       w.elo_pre as w_elo, w.surface_elo_pre as w_selo, w.win_pct_30d_pre as w_f30,
       w.win_pct_90d_pre as w_f90, w.win_pct_365d_pre as w_f365,
       w.matches_7d_pre as w_m7, w.matches_14d_pre as w_m14, w.rest_days_pre as w_rest,
       w.career_surface_win_pct_pre as w_csw, w.career_surface_matches_pre as w_csm,
       w.rank_pre as w_rank, w.rank_points_pre as w_rp, w.age_pre as w_age,
       w.serve_strength_pre as w_serve, w.return_strength_pre as w_return, w.sos_elo_pre as w_sos,
       w.completeness as w_complete,
       l.elo_pre as l_elo, l.surface_elo_pre as l_selo, l.win_pct_30d_pre as l_f30,
       l.win_pct_90d_pre as l_f90, l.win_pct_365d_pre as l_f365,
       l.matches_7d_pre as l_m7, l.matches_14d_pre as l_m14, l.rest_days_pre as l_rest,
       l.career_surface_win_pct_pre as l_csw, l.career_surface_matches_pre as l_csm,
       l.rank_pre as l_rank, l.rank_points_pre as l_rp, l.age_pre as l_age,
       l.serve_strength_pre as l_serve, l.return_strength_pre as l_return, l.sos_elo_pre as l_sos,
       l.completeness as l_complete
  from tennis.matches m
  join tennis.player_match_features w
    on w.match_id = m.match_id and w.player_id = m.winner_id
   and w.feature_version = ${PG.lit(M.FEATURE_VERSION)}
  join tennis.player_match_features l
    on l.match_id = m.match_id and l.player_id = m.loser_id
   and l.feature_version = ${PG.lit(M.FEATURE_VERSION)}
 where m.match_date is not null
   -- A WALKOVER IS NOT A MATCH. Nobody struck a ball, so it carries no
   -- evidence about who is better and it is excluded from training and from
   -- evaluation alike. A retirement IS a match and stays in.
   and m.walkover = false
   ${since ? `and m.match_date >= ${PG.lit(since)}` : ''}
 order by m.match_date, m.match_id`;
}

/* Turn a joined row into the two feature side-objects the engine reads. */
function sides(r) {
  const mk = (p) => ({
    elo_pre: r[p + '_elo'], surface_elo_pre: r[p + '_selo'],
    win_pct_30d_pre: r[p + '_f30'], win_pct_90d_pre: r[p + '_f90'], win_pct_365d_pre: r[p + '_f365'],
    matches_7d_pre: r[p + '_m7'], matches_14d_pre: r[p + '_m14'], rest_days_pre: r[p + '_rest'],
    career_surface_win_pct_pre: r[p + '_csw'], career_surface_matches_pre: r[p + '_csm'],
    rank_pre: r[p + '_rank'], rank_points_pre: r[p + '_rp'], age_pre: r[p + '_age'],
    serve_strength_pre: r[p + '_serve'], return_strength_pre: r[p + '_return'],
    sos_elo_pre: r[p + '_sos'], best_of: r.best_of, tourney_level: r.level
  });
  return { winner: mk('w'), loser: mk('l') };
}

function metricsFor(preds, ys) {
  const curve = M.calibrationCurve(preds, ys, 10);
  const ce = M.calibrationError(curve);
  return {
    n: preds.length,
    log_loss: M.logLoss(preds, ys),
    brier: M.brier(preds, ys),
    accuracy: M.accuracy(preds, ys),
    ece: ce.ece,
    calibration_detail: ce,
    calibration: curve
  };
}

/* Break the same predictions down the ways a reader will ask about them. Every
   slice carries its own n, because a slice of eleven matches is not a finding. */
function breakdown(rows, preds, ys, keyFn) {
  const by = new Map();
  rows.forEach((r, i) => {
    const k = keyFn(r, i);
    if (k == null) return;
    if (!by.has(k)) by.set(k, { preds: [], ys: [] });
    by.get(k).preds.push(preds[i]); by.get(k).ys.push(ys[i]);
  });
  const out = {};
  for (const [k, v] of by) {
    out[k] = { n: v.preds.length, log_loss: M.logLoss(v.preds, v.ys),
               brier: M.brier(v.preds, v.ys), accuracy: M.accuracy(v.preds, v.ys),
               small_sample: v.preds.length < 200 };
  }
  return out;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }
  const conn = PG.resolveConnection();
  if (!conn) { fail('no database connection (SUPABASE_DB_URL / DATABASE_URL / EDGD_PG)'); return 1; }
  const db = PG.client(conn, { database: o.database });
  if (!db.ping()) { fail('the database did not answer'); return 1; }

  if (o.rollback) return rollback(db, o);

  /* RULE 2, asserted rather than assumed. */
  const leaked = M.FEATURE_NAMES.filter((f) => M.POST_MATCH_COLUMNS.some((c) => f.indexOf(c) >= 0));
  if (leaked.length) { fail('a model input names a post-match column: ' + leaked.join(', ')); return 1; }

  say('loading the training record…');
  const rows = db.rows(loadSql(o.since));
  if (rows.length < 200) {
    fail(`only ${rows.length} usable matches. Import the archive and run build_features.js first.`);
    return 1;
  }
  say(`matches with complete feature rows   ${rows.length}`);
  say(`window                               ${rows[0].match_date} .. ${rows[rows.length - 1].match_date}`);

  /* RULE 1: three consecutive windows in time. */
  const iTrain = Math.floor(rows.length * o.trainFrac);
  const iValid = Math.floor(rows.length * (o.trainFrac + o.validFrac));
  const train = rows.slice(0, iTrain), valid = rows.slice(iTrain, iValid), test = rows.slice(iValid);
  const cutoff = train.length ? train[train.length - 1].match_date : null;
  say(`train  ${String(train.length).padStart(7)}   ${train[0].match_date} .. ${cutoff}`);
  say(`valid  ${String(valid.length).padStart(7)}   ${valid.length ? valid[0].match_date + ' .. ' + valid[valid.length - 1].match_date : '—'}`);
  say(`test   ${String(test.length).padStart(7)}   ${test.length ? test[0].match_date + ' .. ' + test[test.length - 1].match_date : '—'}`);
  if (!test.length) { fail('the test window is empty — there is not enough history to evaluate against'); return 1; }

  /* RULE 3: symmetric augmentation for training. */
  const X = [], y = [];
  train.forEach((r) => {
    const s = sides(r);
    const ctx = { best_of: r.best_of, level: r.level };
    X.push(M.featureVector(s.winner, s.loser, ctx).values); y.push(1);
    X.push(M.featureVector(s.loser, s.winner, ctx).values); y.push(0);
  });
  say(`\nfitting ${M.FEATURE_NAMES.length} coefficients on ${X.length} symmetric training rows…`);
  const fit = M.fitLogistic(X, y, { epochs: o.epochs || 600, l2: o.l2 == null ? 1e-3 : o.l2, lr: 0.2 });
  const model = M.modelFromFit(fit, M.FEATURE_NAMES, {});
  say(`  ${fit.converged ? 'converged' : 'stopped'} after ${fit.epochs} epochs, training log loss ${n4(fit.train_loss)}`);

  /* Evaluation: ONE orientation per match, deterministic. */
  function evaluate(set) {
    const preds = [], ys = [], baseElo = [], baseSurf = [], baseRank = [], keep = [];
    set.forEach((r) => {
      const s = sides(r);
      const a = flip(r.match_id) ? s.loser : s.winner;
      const b = flip(r.match_id) ? s.winner : s.loser;
      const outcome = flip(r.match_id) ? 0 : 1;
      const fv = M.featureVector(a, b, { best_of: r.best_of, level: r.level });
      preds.push(M.predict(model, fv));
      ys.push(outcome);
      baseElo.push(M.eloProb(a.elo_pre, b.elo_pre));
      baseSurf.push(M.eloProb(a.surface_elo_pre, b.surface_elo_pre) ?? M.eloProb(a.elo_pre, b.elo_pre));
      baseRank.push(M.rankProb(a.rank_pre, b.rank_pre));
      keep.push(r);
    });
    return { rows: keep, preds, ys, baseElo, baseSurf, baseRank };
  }
  function baselineMetrics(preds, ys) {
    const p = [], q = [];
    preds.forEach((x, i) => { if (x != null) { p.push(x); q.push(ys[i]); } });
    return p.length ? { n: p.length, log_loss: M.logLoss(p, q), brier: M.brier(p, q), accuracy: M.accuracy(p, q) }
                    : { n: 0, log_loss: null, brier: null, accuracy: null };
  }

  const ev = evaluate(test);
  const vv = evaluate(valid.length ? valid : test);
  const testM = metricsFor(ev.preds, ev.ys);
  const validM = metricsFor(vv.preds, vv.ys);
  const bElo = baselineMetrics(ev.baseElo, ev.ys);
  const bSurf = baselineMetrics(ev.baseSurf, ev.ys);
  const bRank = baselineMetrics(ev.baseRank, ev.ys);

  /* The market baseline, where EdgeDesk has captured a price for one of these
     matches. Usually empty on a historical backfill, which is stated rather
     than passed over: "no market comparison" is a real finding. */
  const marketRows = db.rows(`select count(*)::int as n from tennis.odds_snapshots where match_scope = 'archive'`)[0];
  const marketBaseline = marketRows && marketRows.n
    ? { n: marketRows.n, note: 'archive-scope prices exist; see tennis.odds_snapshots' }
    : { n: 0, note: 'no historical market prices are captured, so no market comparison is possible. ' +
                    'The model has not been shown to beat a price, only the ranking and Elo baselines.' };

  say('\n  ── test window ────────────────────────────────────────────');
  say(`  ${'model'.padEnd(18)} n=${String(testM.n).padStart(6)}  log loss ${n4(testM.log_loss)}  Brier ${n4(testM.brier)}  acc ${pct(testM.accuracy)}  ECE ${n4(testM.ece)}`);
  say(`  ${'baseline: Elo'.padEnd(18)} n=${String(bElo.n).padStart(6)}  log loss ${n4(bElo.log_loss)}  Brier ${n4(bElo.brier)}  acc ${pct(bElo.accuracy)}`);
  say(`  ${'baseline: surf Elo'.padEnd(18)} n=${String(bSurf.n).padStart(6)}  log loss ${n4(bSurf.log_loss)}  Brier ${n4(bSurf.brier)}  acc ${pct(bSurf.accuracy)}`);
  say(`  ${'baseline: rank'.padEnd(18)} n=${String(bRank.n).padStart(6)}  log loss ${n4(bRank.log_loss)}  Brier ${n4(bRank.brier)}  acc ${pct(bRank.accuracy)}`);
  say(`  ${'baseline: market'.padEnd(18)} ${marketBaseline.note}`);

  say('\n  calibration (test):');
  testM.calibration.filter((c) => c.n > 0).forEach((c) =>
    say(`    ${String(Math.round(c.lo * 100)).padStart(3)}-${String(Math.round(c.hi * 100)).padStart(3)}%  n=${String(c.n).padStart(5)}  predicted ${pct(c.mean_predicted)}  observed ${pct(c.observed_rate)}  gap ${c.gap == null ? '—' : (c.gap >= 0 ? '+' : '') + (c.gap * 100).toFixed(1) + 'pt'}`));

  const slices = {
    by_tour: breakdown(ev.rows, ev.preds, ev.ys, (r) => r.tour),
    by_surface: breakdown(ev.rows, ev.preds, ev.ys, (r) => r.surface || 'unknown'),
    by_level: breakdown(ev.rows, ev.preds, ev.ys, (r) => M.levelLabel(r.level)),
    by_best_of: breakdown(ev.rows, ev.preds, ev.ys, (r) => 'best_of_' + (r.best_of || 'unknown')),
    by_side: breakdown(ev.rows, ev.preds, ev.ys, (r, i) => ev.preds[i] >= 0.5 ? 'favourite' : 'underdog'),
    by_confidence: breakdown(ev.rows, ev.preds, ev.ys, (r, i) => M.confidenceBucket(
      M.confidence({ completeness: Math.min(Number(r.w_complete || 0), Number(r.l_complete || 0)),
                     rating_sample_a: r.w_csm, rating_sample_b: r.l_csm, surface: r.surface }))),
    by_period: breakdown(ev.rows, ev.preds, ev.ys, (r) => String(r.season || '').slice(0, 4) || 'unknown')
  };
  say('\n  by tour / surface (test):');
  Object.keys(slices.by_tour).forEach((k) => say(`    ${k.padEnd(10)} n=${String(slices.by_tour[k].n).padStart(6)}  log loss ${n4(slices.by_tour[k].log_loss)}  acc ${pct(slices.by_tour[k].accuracy)}${slices.by_tour[k].small_sample ? '   (small sample)' : ''}`));
  Object.keys(slices.by_surface).forEach((k) => say(`    ${k.padEnd(10)} n=${String(slices.by_surface[k].n).padStart(6)}  log loss ${n4(slices.by_surface[k].log_loss)}  acc ${pct(slices.by_surface[k].accuracy)}${slices.by_surface[k].small_sample ? '   (small sample)' : ''}`));

  /* RULE 4: the promotion gate. */
  const beats = {
    elo: testM.log_loss != null && bElo.log_loss != null && testM.log_loss < bElo.log_loss,
    surface_elo: testM.log_loss != null && bSurf.log_loss != null && testM.log_loss < bSurf.log_loss,
    rank: testM.log_loss != null && bRank.log_loss != null && testM.log_loss < bRank.log_loss
  };
  /* The gate reads the ECE over bins with enough matches to measure. The
     count it was computed over is printed beside it, so "calibration passed"
     can never mean "calibration was measured over four matches". */
  const cd = testM.calibration_detail || {};
  const calibrationOk = testM.ece != null && testM.ece <= 0.05 && cd.measured >= 200;
  const current = db.rows(`select model_version, eval_results from tennis.model_registry
                            where family = ${PG.lit(FAMILY)} and status = 'active' limit 1`)[0] || null;
  const currentLogLoss = current && current.eval_results && current.eval_results.test
    ? Number(current.eval_results.test.log_loss) : null;
  const beatsCurrent = currentLogLoss == null || (testM.log_loss != null && testM.log_loss < currentLogLoss);

  say('\n  ── promotion gate ─────────────────────────────────────────');
  say(`  beats overall Elo        ${beats.elo ? 'yes' : 'NO'}`);
  say(`  beats surface Elo        ${beats.surface_elo ? 'yes' : 'NO'}`);
  say(`  beats the ranking        ${beats.rank ? 'yes' : 'NO'}`);
  say(`  calibration ECE <= 0.05  ${calibrationOk ? 'yes' : 'NO'} (${n4(testM.ece)} over ${cd.measured || 0} matches in ${cd.bins || 0} bins of >= ${cd.min_bin_n} ; ${cd.unmeasured || 0} matches sat in bins too small to measure)`);
  if ((cd.measured || 0) < 200) say('                           the measured set is under 200 matches — calibration is not established either way');
  say(`  beats the active model   ${current ? (beatsCurrent ? 'yes' : 'NO (' + current.model_version + ' scores ' + n4(currentLogLoss) + ')') : 'no active model yet'}`);
  const qualifies = beats.elo && beats.surface_elo && beats.rank && calibrationOk && beatsCurrent;
  say(`  QUALIFIES FOR PRODUCTION ${qualifies ? 'YES' : 'no — it will be registered as a candidate and production will not move'}`);

  if (!o.commit) { say('\nDRY RUN — nothing registered. Re-run with --commit.'); return 0; }

  const version = o.version || ('tennis-baseline-' + new Date().toISOString().slice(0, 10).replace(/-/g, '.') + '.' +
                                String(Date.now() % 1000).padStart(3, '0'));
  const evalResults = {
    test: { n: testM.n, log_loss: testM.log_loss, brier: testM.brier, accuracy: testM.accuracy, ece: testM.ece },
    validation: { n: validM.n, log_loss: validM.log_loss, brier: validM.brier, accuracy: validM.accuracy, ece: validM.ece },
    train: { n: X.length, log_loss: fit.train_loss, converged: fit.converged, epochs: fit.epochs },
    slices: slices,
    orientation: 'one deterministic orientation per match (sha1(match_id) parity); training used both'
  };
  const comparison = {
    elo: bElo, surface_elo: bSurf, official_rank: bRank, market: marketBaseline,
    beats: beats, calibration_ok: calibrationOk, beats_current: beatsCurrent,
    current_active: current ? current.model_version : null
  };
  const status = (o.activate && (qualifies || o.force)) ? 'active' : 'candidate';

  const stmts = [];
  if (status === 'active' && current) {
    stmts.push(`update tennis.model_registry set status='retired', retired_at=now()
                 where model_version = ${PG.lit(current.model_version)};`);
  }
  stmts.push(`insert into tennis.model_registry
      (model_version, family, feature_version, algorithm, description, training_cutoff,
       train_from, train_to, valid_from, valid_to, eval_from, eval_to,
       train_rows, valid_rows, eval_rows, coefficients, eval_results, calibration,
       baseline_comparison, status, rollback_target, activated_at, deployed_at, created_by, build_version)
    values (${PG.lit(version)}, ${PG.lit(FAMILY)}, ${PG.lit(M.FEATURE_VERSION)},
      ${PG.lit(model.algorithm)},
      ${PG.lit('Logistic model over pre-match feature differences. Chronological split; symmetric training.')},
      ${PG.lit(cutoff)}, ${PG.lit(train[0].match_date)}, ${PG.lit(cutoff)},
      ${PG.lit(valid.length ? valid[0].match_date : null)}, ${PG.lit(valid.length ? valid[valid.length - 1].match_date : null)},
      ${PG.lit(test[0].match_date)}, ${PG.lit(test[test.length - 1].match_date)},
      ${X.length}, ${validM.n}, ${testM.n},
      ${PG.lit(JSON.stringify({ intercept: model.intercept, coefficients: model.coefficients }))}::jsonb,
      ${PG.lit(JSON.stringify(evalResults))}::jsonb,
      ${PG.lit(JSON.stringify(testM.calibration))}::jsonb,
      ${PG.lit(JSON.stringify(comparison))}::jsonb,
      ${PG.lit(status)},
      ${current ? PG.lit(current.model_version) : 'null'},
      ${status === 'active' ? 'now()' : 'null'}, now(),
      ${PG.lit(process.env.USER || process.env.GITHUB_ACTOR || 'operator')}, ${PG.lit(M.VERSION)})
    on conflict (model_version) do nothing;`);
  db.transaction(stmts);

  const wrote = db.scalar(`select status from tennis.model_registry where model_version = ${PG.lit(version)}`);
  say('');
  say(`  registered  ${version}  status=${wrote}`);
  if (wrote === 'active') say(`  production moved. Rollback target: ${current ? current.model_version : '(none — this is the first)'}`);
  else if (o.activate) say('  production did NOT move: the candidate did not clear the gate. Use --force to override, deliberately.');
  else say('  registered as a candidate. Re-run with --activate to promote it if it clears the gate.');
  say('');
  say('  Next: node tools/tennis/price_board.js --commit   (fair prices and research opportunities)');
  return 0;
}

function rollback(db, o) {
  const target = db.rows(`select model_version, status from tennis.model_registry
                           where model_version = ${PG.lit(o.rollback)}`)[0];
  if (!target) { fail('no such model version: ' + o.rollback); return 1; }
  const current = db.rows(`select model_version from tennis.model_registry
                            where family = ${PG.lit(FAMILY)} and status = 'active'`)[0];
  if (!o.commit) {
    say(`DRY RUN — would retire ${current ? current.model_version : '(none)'} and activate ${target.model_version}.`);
    say('Predictions already written are NOT rewritten: they are evidence and they stay as they are.');
    return 0;
  }
  const stmts = [];
  if (current) stmts.push(`update tennis.model_registry set status='retired', retired_at=now() where model_version=${PG.lit(current.model_version)};`);
  stmts.push(`update tennis.model_registry set status='active', activated_at=now(), retired_at=null where model_version=${PG.lit(target.model_version)};`);
  db.transaction(stmts);
  say(`rolled back: ${target.model_version} is active` + (current ? ` (was ${current.model_version})` : ''));
  say('Existing predictions are untouched. The next price_board run writes under the restored version.');
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
module.exports = { flip, loadSql, sides, metricsFor, breakdown, FAMILY };
