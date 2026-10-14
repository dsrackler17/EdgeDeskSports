#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA props — the walk-forward record of every prop family.

     node nba/props/walkforward.js                  selection window (test sealed)
     node nba/props/walkforward.js --unseal "why"   the sealed test window, logged
     node nba/props/walkforward.js --check

   Same windows and seal as the game model (nba/config.js, one shared holdout
   log). The models for season S are fitted on S−4..S−1 (nba/props/model.js).
   Rows: every player-game a player appeared in, with at least 3 earlier games
   and at least 12 recent minutes (the prop-relevant population; a prop on a
   player who does not play is void). Scored per family and per track:

     distribution   CRPS of the count, PIT histogram, 80% interval coverage
     lines          P(over L) calibration at three synthetic lines per row: the
                    half-point nearest the mean and one standard deviation either
                    side. No historical prop prices are licensed here, so these
                    are calibration probes at realistic lines, not a market test.
     baselines      the season average and the last-10 average (as means), each
                    with its own fitted dispersion — does the decomposition beat
                    what a bettor reads off a box-score page?
     combos         P+R+A, P+R, P+A, R+A from the correlated moments
     double-double / triple-double   from the Gaussian copula (subsample)
     availability   P(he plays) for every player recently with the team, log
                    loss against the played-last-game rate, calibration
   Status per family by the protocol's distribution rules (coverage within
   0.77–0.83, CRPS beating the season-average baseline with a 95% interval).
   Market: NOT_TESTED, always.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const ST = require('./state');
const PM = require('./model');
const WF = require('../model/walkforward');
const V = require('../../engine/validation');
const P = require('../../engine/lab/protocol');
const DIST = require('../model/distribution');
const io = require('../lib/io');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const RECORD = path.join(C.PATHS.validation, 'nba_props_walkforward.json');
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const FAMILIES = ST.STATS.concat(Object.keys(PM.COMBOS));
const TRAIN_SEASONS = 4;

function eligible(r) { return r.f.min_ew >= 12 && r.f.g_ss + 0 >= 0; }
function distOf(mu, r) { const max = Math.max(20, Math.ceil(mu + 12 * Math.sqrt(mu + mu * mu / r))); return { lo: 0, pmf: PM.nbPmf(mu, r, max) }; }

async function buildRows() {
  const name = 'props_rows_v3.jsonl.gz', nameA = 'props_avail_v1.jsonl.gz';
  const tuning = fs.existsSync(WF.TUNING) ? JSON.parse(fs.readFileSync(WF.TUNING, 'utf8')) : { pass: {} };
  const gameRows = await WF.buildRows(tuning);
  const key = gameRows.length + '|' + require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'state.js'))).digest('hex').slice(0, 16);
  const cached = await io.readWorkLines(name), cachedA = await io.readWorkLines(nameA);
  if (cached && cached.head && cached.head.key === key && cachedA && cachedA.head && cachedA.head.key === key) return { rows: cached.rows, avail: cachedA.rows };
  const ctx = new Map(gameRows.map((r) => [r.id, r]));
  const res = ST.run({ seasons: Array.from({ length: C.currentSeason() - C.FIRST_SEASON }, (_, i) => C.FIRST_SEASON + i), gameRows: ctx, log: true, avail: true });
  await io.writeWorkLines(name, { key }, res.rows);
  await io.writeWorkLines(nameA, { key }, res.avail);
  return { rows: res.rows, avail: res.avail };
}

/* the availability baseline: the training seasons' play rate for players who
   did / did not play the team's last game */
function availBaseline(train) {
  const n = [0, 0], y = [0, 0];
  for (const r of train) { n[r.f.in_last] += 1; y[r.f.in_last] += r.y; }
  return (f) => (n[f.in_last] ? y[f.in_last] / n[f.in_last] : 0.5);
}

/* the alternate-line ladder per family: fixed lines (the "10+, 15+, 20+" kind), so the predicted P(over) spreads widely
   across players and its calibration slope means something (a line one sd from each player's own mean gives everyone
   nearly the same probability, and a slope fitted on that is noise) */
const LADDER = { pts: [9.5, 14.5, 19.5, 24.5, 29.5], reb: [3.5, 5.5, 7.5, 9.5, 11.5], ast: [1.5, 3.5, 5.5, 7.5, 9.5], fg3m: [0.5, 1.5, 2.5, 3.5, 4.5],
  stl: [0.5, 1.5, 2.5], blk: [0.5, 1.5, 2.5], tov: [0.5, 1.5, 2.5, 3.5, 4.5], fga: [5.5, 9.5, 14.5, 19.5], fg3a: [1.5, 3.5, 5.5, 7.5],
  pra: [14.5, 19.5, 24.5, 29.5, 34.5, 39.5], pr: [12.5, 17.5, 22.5, 27.5, 32.5], pa: [12.5, 17.5, 22.5, 27.5, 32.5], ra: [4.5, 7.5, 10.5, 13.5] };
function scoreFamily(model, pred, r, fam) {
  const isCombo = !!PM.COMBOS[fam];
  const m = isCombo ? PM.combo(model, pred, PM.COMBOS[fam]) : pred.stat[fam];
  const y = isCombo ? PM.COMBOS[fam].reduce((a, k) => a + r.y[k], 0) : r.y[fam];
  const d = isCombo ? PM.comboDist(model, pred, PM.COMBOS[fam]) : PM.statDist(pred, fam);
  /* lp: [p, y] at the main line (the half-point nearest the mean: where a book sets it), then at each ladder line */
  const lines = [Math.floor(m.mu) + 0.5].concat(LADDER[fam] || []);
  const lp = []; for (const L of lines) lp.push(DIST.pGreater(d, L), y > L ? 1 : 0);
  /* the randomised PIT's interval for a count: [P(Y < y), P(Y ≤ y)] (a mid-point PIT puts most outcomes of a low count
     with a large atom at zero inside any central interval and overstates coverage) */
  let F0 = 0; for (let i = 0; i < d.pmf.length && d.lo + i < y; i++) F0 += d.pmf[i];
  const F1 = Math.min(1, F0 + (y - d.lo >= 0 && y - d.lo < d.pmf.length ? d.pmf[y - d.lo] : 0));
  return { mu: m.mu, y, crps: DIST.crps(d, y), F0, F1, lp };
}
/* the share of a randomised PIT's interval [a, b] inside [lo, hi] (its expected chance of landing there) */
function inside(a, b, lo, hi) { if (b - a < 1e-12) return a > lo && a < hi ? 1 : 0; return Math.max(0, Math.min(b, hi) - Math.max(a, lo)) / (b - a); }
function baseline(train, key, fam) {
  /* a baseline mean read off the box score, and its own NB dispersion from the training seasons */
  const val = (r) => { if (PM.COMBOS[fam]) return PM.COMBOS[fam].reduce((a, k) => a + (r.f[key + k] == null ? r.f['avg10_' + k] : r.f[key + k]), 0); return r.f[key + fam] == null ? r.f['avg10_' + fam] : r.f[key + fam]; };
  const yv = (r) => (PM.COMBOS[fam] ? PM.COMBOS[fam].reduce((a, k) => a + r.y[k], 0) : r.y[fam]);
  let num = 0, den = 0; for (const r of train) { const mu = Math.max(0.05, val(r)); num += mu * mu; den += Math.pow(yv(r) - mu, 2) - mu; }
  const size = den > 0 ? Math.min(500, Math.max(0.5, num / den)) : 500;
  return { val, yv, size };
}

async function main() {
  const unsealWhy = arg('unseal', null);
  const W = C.windows(); const last = unsealWhy ? W.test[1] : W.selection[1];
  const B = await buildRows();
  const all = B.rows.filter(eligible);
  console.error('[nba props wf] rows ' + all.length + ', availability rows ' + B.avail.length);
  const availScored = [];
  const out = { P: {}, C: {} }; const per = { P: {}, C: {} };
  for (const track of ['P', 'C']) for (const fam of FAMILIES) per[track][fam] = [];
  const ddRows = { P: [], C: [] };
  const fits = {};
  for (let s = W.selection[0]; s <= last; s++) {
    const train = all.filter((r) => r.season >= s - TRAIN_SEASONS && r.season < s);
    const test = all.filter((r) => r.season === s);
    if (train.length < 5000 || !test.length) continue;
    {
      const aTrain = B.avail.filter((r) => r.season >= s - TRAIN_SEASONS && r.season < s), aTest = B.avail.filter((r) => r.season === s);
      const am = PM.fitAvail(aTrain), base = availBaseline(aTrain);
      if (am) { fits['avail' + s] = { n: am.n, base_rate: r4(am.base), beta: am.beta.map(r4) }; for (const r of aTest) availScored.push({ p: PM.predictAvail(am, r.f), b: base(r.f), y: r.y, date: r.date, in_last: r.f.in_last }); }
    }
    for (const track of ['P', 'C']) {
      const model = PM.fit(train, track); fits[track + s] = { n: model.n, minutes_sd: model.minutes.sd.map(r4), sizes: Object.fromEntries(Object.entries(model.stats).map(([k, v]) => [k, r4(v.size)])), sizes_given_minutes: Object.fromEntries(Object.entries(model.stats).map(([k, v]) => [k, r4(v.size_given_minutes)])), corr_pts_ast: r4(model.corr.pts.ast), corr_pts_reb: r4(model.corr.pts.reb), corr_reb_ast: r4(model.corr.reb.ast) };
      const bss = {}, b10 = {}; for (const fam of FAMILIES) { bss[fam] = baseline(train, 'avgss_', fam); b10[fam] = baseline(train, 'avg10_', fam); }
      let k = 0;
      for (const r of test) {
        const pred = PM.predict(model, r.f);
        for (const fam of FAMILIES) {
          const sc = scoreFamily(model, pred, r, fam);
          const bs = bss[fam], bt = b10[fam];
          const muS = Math.max(0.05, bs.val(r)), muT = Math.max(0.05, bt.val(r));
          sc.base_ss = DIST.crps(distOf(muS, bs.size), sc.y); sc.base_10 = DIST.crps(distOf(muT, bt.size), sc.y);
          sc.ae = Math.abs(sc.mu - sc.y); sc.ae_ss = Math.abs(muS - sc.y); sc.ae_10 = Math.abs(muT - sc.y);
          sc.date = r.date; sc.mu_min = pred.min.mu; sc.y_min = r.y.min;
          per[track][fam].push(sc);
        }
        if (k++ % 15 === 0 && pred.stat.pts.mu >= 8) {
          const md = PM.multiDouble(model, pred, 300, 7 + k);
          const tens = ['pts', 'reb', 'ast', 'stl', 'blk'].filter((x) => r.y[x] >= 10).length;
          ddRows[track].push({ dd: md.dd, td: md.td, ydd: tens >= 2 ? 1 : 0, ytd: tens >= 3 ? 1 : 0, date: r.date });
        }
      }
      console.error('[nba props wf] ' + track + ' ' + s + ': ' + test.length + ' player-games');
    }
  }
  const summarize = (list, fam) => {
    const n = list.length; if (!n) return { n: 0 };
    const mean = (f) => list.reduce((a, x) => a + f(x), 0) / n;
    const pit = new Array(10).fill(0); for (const x of list) for (let b = 0; b < 10; b++) pit[b] += inside(x.F0, x.F1, b / 10, (b + 1) / 10);
    const nl = list.length ? list[0].lp.length / 2 : 0;
    const bin = (pairs) => { const b = V.binary(pairs); delete b.bins; return { n: b.n, log_loss: b.log_loss, brier: b.brier, mean_p: b.mean_p, observed: b.mean_y, calibration_in_the_large: b.calibration_in_the_large, calibration_slope: b.calibration_slope }; };
    const main = Object.assign({ line: 'main: the half-point nearest the mean' }, bin(list.map((x) => ({ p: x.lp[0], y: x.lp[1] }))));
    const ladderPairs = []; const perLine = [];
    for (let i = 1; i < nl; i++) { const pr = list.map((x) => ({ p: x.lp[2 * i], y: x.lp[2 * i + 1] })); ladderPairs.push(...pr); perLine.push(Object.assign({ line: (LADDER[fam] || [])[i - 1] }, bin(pr))); }
    const ladder = nl > 1 ? Object.assign({ line: 'the alternate-line ladder, pooled', lines: perLine }, bin(ladderPairs)) : null;
    const lines = [main].concat(ladder ? [ladder] : []);
    const cmpSS = V.pairedBootstrap(list.map((x) => ({ date: x.date, a: x.crps, b: x.base_ss })), { B: 500 });
    const cmp10 = V.pairedBootstrap(list.map((x) => ({ date: x.date, a: x.crps, b: x.base_10 })), { B: 500 });
    return { n, mean_outcome: r4(mean((x) => x.y)), mean_bias: r4(mean((x) => x.mu - x.y)), mae: r4(mean((x) => x.ae)), crps: r4(mean((x) => x.crps)),
      coverage_80: r4(list.reduce((a, x) => a + inside(x.F0, x.F1, 0.1, 0.9), 0) / n), coverage_method: 'expected coverage of the randomised PIT', pit: pit.map((c) => r4(c / n)), lines,
      baselines: { season_average: { mae: r4(mean((x) => x.ae_ss)), crps: r4(mean((x) => x.base_ss)), crps_diff_vs_model: cmpSS }, last_10: { mae: r4(mean((x) => x.ae_10)), crps: r4(mean((x) => x.base_10)), crps_diff_vs_model: cmp10 } } };
  };
  const report = { schema: C.SCHEMA.props, generated_at: new Date().toISOString(),
    protocol: { windows: C.windows(), train_seasons: TRAIN_SEASONS, population: 'player-games a player appeared in, ≥ 3 earlier games, ≥ 12 recent minutes (props on a player who does not play are void)',
      tracks: { P: 'projected: teammates missing judged from the previous game; the player\'s own role from his history', C: 'confirmed: tonight\'s starters and who is active, known ~30 min before tip' },
      lines: 'synthetic lines (no licensed historical prop prices): the half-point nearest the mean, and a fixed alternate-line ladder per family (LADDER)', ladder: LADDER, test_window: unsealWhy ? 'UNSEALED (nba/validation/holdout_log.json)' : 'SEALED' },
    market: P.MARKET_NOT_TESTED, fits, windows: {}, families: FAMILIES };
  for (const [wn, win] of Object.entries({ selection: W.selection, test: W.test })) {
    if (wn === 'test' && !unsealWhy) { report.windows.test = { status: 'SEALED' }; continue; }
    report.windows[wn] = {};
    for (const track of ['P', 'C']) {
      const fam = {};
      for (const f of FAMILIES) {
        const list = per[track][f].filter((x) => { const s = Number(String(x.date).slice(0, 4)) + (Number(String(x.date).slice(5, 7)) >= 8 ? 1 : 0); return P.inWin(s, win); });
        const sm = summarize(list, f);
        const beats = sm.baselines && sm.baselines.season_average.crps_diff_vs_model ? sm.baselines.season_average.crps_diff_vs_model.a_better : false;
        const fails = [];
        if (sm.n < 1000) fails.push('n ' + sm.n + ' < 1000');
        if (sm.coverage_80 < 0.77 || sm.coverage_80 > 0.83) fails.push('80% interval covers ' + sm.coverage_80);
        if (!beats) fails.push('CRPS does not beat the season-average baseline with a 95% interval below zero');
        for (const l of sm.lines || []) {
          if (l.calibration_slope == null || l.calibration_slope < 0.85 || l.calibration_slope > 1.15) fails.push(l.line + ': calibration slope ' + l.calibration_slope);
          if (l.calibration_in_the_large == null || Math.abs(l.calibration_in_the_large) > 0.02) fails.push(l.line + ': calibration in the large ' + l.calibration_in_the_large);
        }
        sm.status = wn === 'selection' ? 'PROVISIONAL' : (fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED');
        sm.failed = wn === 'selection' ? ['test window sealed'].concat(fails) : fails;
        fam[f] = sm;
      }
      const dd = ddRows[track].filter((x) => { const s = Number(String(x.date).slice(0, 4)) + (Number(String(x.date).slice(5, 7)) >= 8 ? 1 : 0); return P.inWin(s, win); });
      const bdd = V.binary(dd.map((x) => ({ p: x.dd, y: x.ydd }))), btd = V.binary(dd.map((x) => ({ p: x.td, y: x.ytd })));
      fam.double_double = { n: bdd.n, log_loss: bdd.log_loss, brier: bdd.brier, calibration_in_the_large: bdd.calibration_in_the_large, calibration_slope: bdd.calibration_slope, mean_p: bdd.mean_p, observed: bdd.mean_y, note: 'a 1-in-15 subsample of players projected ≥ 8 points; 300 copula draws each' };
      fam.triple_double = { n: btd.n, log_loss: btd.log_loss, calibration_in_the_large: btd.calibration_in_the_large, calibration_slope: btd.calibration_slope, mean_p: btd.mean_p, observed: btd.mean_y };
      report.windows[wn][track] = fam;
    }
    const av = availScored.filter((x) => { const s = Number(String(x.date).slice(0, 4)) + (Number(String(x.date).slice(5, 7)) >= 8 ? 1 : 0); return P.inWin(s, win); });
    if (av.length) {
      const bm = V.binary(av.map((x) => ({ p: x.p, y: x.y }))), bb = V.binary(av.map((x) => ({ p: x.b, y: x.y })));
      const cmp = V.pairedBootstrap(av.map((x) => ({ date: x.date, a: V.logLoss(x.p, x.y), b: V.logLoss(x.b, x.y) })), { B: 500 });
      const sub = (k) => { const l = av.filter((x) => x.in_last === k); const b = V.binary(l.map((x) => ({ p: x.p, y: x.y }))); return { n: b.n, observed: b.mean_y, mean_p: b.mean_p, log_loss: b.log_loss, calibration_slope: b.calibration_slope }; };
      const fails = [];
      if (!cmp.a_better) fails.push('log loss does not beat the played-last-game baseline with a 95% interval below zero');
      if (bm.calibration_slope == null || bm.calibration_slope < 0.85 || bm.calibration_slope > 1.15) fails.push('calibration slope ' + bm.calibration_slope);
      report.windows[wn].availability = { what: 'P(he plays tonight) for every player who appeared for the team in its last 10 games, from what was knowable the night before (projected track only: the confirmed track knows who plays)',
        n: bm.n, observed: bm.mean_y, model: { log_loss: bm.log_loss, brier: bm.brier, calibration_in_the_large: bm.calibration_in_the_large, calibration_slope: bm.calibration_slope, bins: bm.bins },
        baseline_played_last_game: { log_loss: bb.log_loss, brier: bb.brier }, log_loss_diff_vs_baseline: cmp,
        played_last_game: sub(1), missed_last_game: sub(0),
        status: wn === 'selection' ? 'PROVISIONAL' : (fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED'), failed: wn === 'selection' ? ['test window sealed'].concat(fails) : fails };
    }
  }
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  if (unsealWhy) {
    let log = { unsealings: [] }; try { log = JSON.parse(fs.readFileSync(WF.HOLDOUT_LOG, 'utf8')); } catch (_) {}
    log.unsealings.push({ at: report.generated_at, scope: 'props', reason: unsealWhy, spec_hash: require('crypto').createHash('sha256').update(['state.js', 'model.js', 'walkforward.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n')).digest('hex') });
    fs.writeFileSync(WF.HOLDOUT_LOG, JSON.stringify(Object.assign({ schema: 'edgedesk_nba_holdout_log_v1' }, log), null, 1) + '\n');
  }
  fs.writeFileSync(RECORD, JSON.stringify(report, null, 1) + '\n');
  for (const wn of Object.keys(report.windows)) {
    if (report.windows[wn].status === 'SEALED') { console.log('== ' + wn + ' SEALED'); continue; }
    for (const track of ['P', 'C']) {
      console.log('== ' + wn + ' ' + track + '   family   n      mean   bias    MAE(model/ss/l10)      CRPS(model/ss/l10)    cov80  line slopes');
      for (const f of FAMILIES) { const x = report.windows[wn][track][f]; console.log('   ' + f.padEnd(6) + String(x.n).padStart(7) + ' ' + String(x.mean_outcome).padStart(7) + ' ' + String(x.mean_bias).padStart(7) + '  ' + [x.mae, x.baselines.season_average.mae, x.baselines.last_10.mae].join('/').padEnd(22) + ' ' + [x.crps, x.baselines.season_average.crps, x.baselines.last_10.crps].join('/').padEnd(22) + ' ' + x.coverage_80 + '  ' + x.lines.map((l) => l.calibration_slope + '/' + l.calibration_in_the_large).join('  ')); }
      const dd = report.windows[wn][track].double_double; console.log('   DD n ' + dd.n + ' LL ' + dd.log_loss + ' slope ' + dd.calibration_slope + ' p ' + dd.mean_p + ' obs ' + dd.observed);
    }
    const av = report.windows[wn].availability;
    if (av) console.log('== ' + wn + ' availability n ' + av.n + ' observed ' + av.observed + ' LL ' + av.model.log_loss + ' vs played-last-game ' + av.baseline_played_last_game.log_loss + ' (diff ' + av.log_loss_diff_vs_baseline.mean_diff + ' [' + av.log_loss_diff_vs_baseline.ci95 + ']) slope ' + av.model.calibration_slope);
  }
}

function check() {
  const r = JSON.parse(fs.readFileSync(RECORD, 'utf8')); const fails = [];
  if (r.schema !== C.SCHEMA.props) fails.push('schema');
  if (!r.market || r.market.market_status !== 'NOT_TESTED') fails.push('props claim a market test');
  if (fails.length) { console.error('[nba props --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nba props --check] ok');
}

module.exports = { buildRows, eligible, FAMILIES, RECORD, LADDER };
if (require.main === module) { if (flag('check')) check(); else main().catch((e) => { console.error(e); process.exit(1); }); }
