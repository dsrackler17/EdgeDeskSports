#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk basketball — the walk-forward record of one league.

     node basketball/walkforward.js --league nba [--tune]
     node basketball/walkforward.js --league nba --check

   The protocol is engine/lab/protocol.js, unchanged:
     1. One chronological pass in start order. A game is predicted 30 minutes
        before its start from the games whose results were available by then
        (start + 4 h), and only those; it is absorbed once it is.
     2. Everything that turns a rating into a probability — the logistic
        win-probability curve, the margin and total recalibration, their
        spreads, the back-to-back effect — is fitted for season S on the
        out-of-sample predictions of the three seasons before S.
     3. Hyperparameters (half-life, prior, carry; Elo K / home / reversion)
        are tuned on the SELECTION window only (--tune).
     4. Candidates: `points` (the incumbent), `points_rest` (+ back-to-back).
        Baselines: Elo, home-advantage-only.
     5. Status per market by the protocol's rules; the market is NOT_TESTED.

   Writes basketball/validation/<league>_walkforward.json and
   basketball/params/<league>_live.json (ratings for the slate).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const I = require('./ingest');
const { PointsRatings, Elo, dayNum, DEFAULTS } = require('./model');
const P = require('../engine/lab/protocol');
const V = require('../engine/validation');
const S = require('../engine/stats');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const CAL_SEASONS = 3;

function windowsFor(league) {
  const L = C.LEAGUES[league]; const cur = C.currentSeason(league);
  return { burn_in: L.windows.burn_in, selection: L.windows.selection, confirmation: [L.windows.confirmation[0], cur - 1], live: [cur, cur] };
}

function load(league) {
  const cur = C.currentSeason(league); const seasons = [];
  for (let s = C.LEAGUES[league].first; s <= cur; s++) seasons.push(s);
  const games = I.loadGames(league, seasons).filter((g) => g.status === 'FINAL');
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start_utc < b.start_utc ? -1 : 1));
  return { games, seasons };
}

/** one chronological pass: a row per game with raw margin/total and Elo.
    Causal by construction: games are predicted in start order, and a finished
    game is absorbed only once its assumed availability (start + 4 h) is before
    the next prediction time — a late Hawaii tip is not yet known to the
    6 a.m. tip-off marathon game that follows it. */
function pass(games, params, eloParams, upTo) {
  const pr = new PointsRatings(params); const elo = new Elo(eloParams);
  const lastStart = new Map();
  const rows = []; let maxKnown = null;
  const order = games.slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  const pending = []; let head = 0;
  const flush = (beforeMs) => {
    const batch = [];
    while (head < pending.length && (beforeMs == null || Date.parse(pending[head].assumed_available_at) < beforeMs)) batch.push(pending[head++]);
    if (!batch.length) return;
    const nowDay = (beforeMs == null ? Date.parse(batch[batch.length - 1].assumed_available_at) : beforeMs) / 864e5;
    pr.absorbDay(nowDay, batch);
    for (const g of batch) { elo.absorb(g); const k = Date.parse(g.assumed_available_at); if (maxKnown == null || k > maxKnown) maxKnown = k; }
  };
  for (const g of order) {
    if (upTo != null && g.season > upTo) break;
    const t = Date.parse(g.start_utc); const predAt = t - 30 * 60e3;
    if (pr.season !== g.season) { flush(null); pr.startSeason(g.season); elo.startSeason(g.season); }
    flush(predAt);
    const e = pr.expect(g.home_id, g.away_id, g.neutral);
    const b2b = (id) => { const l = lastStart.get(id); return l != null && t - l <= 30 * 3600e3 ? 1 : 0; };
    rows.push({ id: g.game_id, season: g.season, type: g.type, date: g.date, start: t, neutral: g.neutral, home: g.home_id, away: g.away_id,
      m: e.margin, t: e.total, gh: e.games_h, ga: e.games_a, x_rest: b2b(g.home_id) - b2b(g.away_id), elo: elo.prob(g.home_id, g.away_id, g.neutral),
      y: { hw: g.hs > g.as ? 1 : 0, margin: g.hs - g.as, total: g.hs + g.as }, predicted_at: predAt, inputs_known_at: maxKnown });
    lastStart.set(g.home_id, t); lastStart.set(g.away_id, t);
    pending.push(g);
  }
  flush(null);
  return { rows, ratings: pr, elo };
}

/* least squares y ~ a + b x (one regressor) */
function ols(xs, ys) {
  const n = xs.length; if (n < 30) return { a: 0, b: 1 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1); return { a: (sy - b * sx) / n, b };
}

/* least squares y ~ a·home + b·x, no constant: the fitted intercept is a
   HOME-game correction, and a neutral site has no home side to correct */
function olsHome(homes, xs, ys) {
  const n = xs.length; if (n < 30) return { a: 0, b: 1 };
  let shh = 0, shx = 0, sxx = 0, shy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { shh += homes[i] * homes[i]; shx += homes[i] * xs[i]; sxx += xs[i] * xs[i]; shy += homes[i] * ys[i]; sxy += xs[i] * ys[i]; }
  const det = shh * sxx - shx * shx || 1;
  return { a: (sxx * shy - shx * sxy) / det, b: (shh * sxy - shx * shy) / det };
}

/* THE CALIBRATION VERSION, carried into the live params and the slate's model
   id so the record and the performance ledger split on the change.

   v2 (bb_cal_v2_home_intercept): the fitted moneyline and margin intercepts
   apply to home games only. v1 fitted one intercept on home and neutral
   games pooled and applied it at neutral sites too, where the ratings' home
   edge is already 0. That pooled intercept corrects a home edge the ratings
   carry too large (h ~3.9 pts in college basketball while home court has
   fallen), so every neutral-site game was priced ~3-4 points of probability
   short for the side listed at home (NCAAM 5,289 neutral games 2019-26: mean
   p 0.547, won 0.585). Walked forward on the three prior seasons exactly as
   production, v2 improves moneyline log loss in both windows of both
   college leagues with every 95% interval below zero (NCAAM 2012-18
   -0.00032, 2019-26 -0.00053; NCAAW -0.00020, -0.00045), in 14 of 15
   seasons from 2012 in each league, in every favourite-probability bucket,
   and margin MAE with it; WNBA and the NBA fallback, with almost no neutral games, are
   unchanged (docs/sports-calibration/README.md). */
const CAL_VERSION = 'bb_cal_v2_home_intercept';
/* 1 where the fitted intercept applies: every game under v1, home games only from v2 */
function interceptOn(c, neutral) { return c && c.intercept === 'home_games_only' ? (neutral ? 0 : 1) : 1; }

/** season-S calibration from the OOS rows of the seasons before S */
function calibrate(prior) {
  if (prior.length < 200) return null;
  const home = (r) => (r.neutral ? 0 : 1);
  const lg = S.logistic(prior.map((r) => [home(r), r.m]), prior.map((r) => r.y.hw), { l2: 1e-6 });
  const lgR = S.logistic(prior.map((r) => [home(r), r.m, r.x_rest]), prior.map((r) => r.y.hw), { l2: 1e-6 });
  const mm = olsHome(prior.map(home), prior.map((r) => r.m), prior.map((r) => r.y.margin));
  const tt = ols(prior.map((r) => r.t), prior.map((r) => r.y.total));
  let sm = 0, st = 0;
  for (const r of prior) { sm += Math.pow(r.y.margin - (mm.a * home(r) + mm.b * r.m), 2); st += Math.pow(r.y.total - (tt.a + tt.b * r.t), 2); }
  /* back-to-back effect on the margin, from residuals */
  const res = prior.filter((r) => r.x_rest !== 0);
  let rest = 0; if (res.length >= 50) rest = res.reduce((a, r) => a + (r.y.margin - (mm.a * home(r) + mm.b * r.m)) * r.x_rest, 0) / res.length;
  const nn = prior.filter((r) => !r.neutral);
  const homeRate = nn.length ? nn.reduce((a, r) => a + r.y.hw, 0) / nn.length : 0.5;
  const meanMargin = nn.length ? nn.reduce((a, r) => a + r.y.margin, 0) / nn.length : 0;
  const meanTotal = prior.reduce((a, r) => a + r.y.total, 0) / prior.length;
  const sdMargin0 = Math.sqrt(prior.reduce((a, r) => a + Math.pow(r.y.margin - (r.neutral ? 0 : meanMargin), 2), 0) / prior.length);
  const sdTotal0 = Math.sqrt(prior.reduce((a, r) => a + Math.pow(r.y.total - meanTotal, 2), 0) / prior.length);
  return { version: CAL_VERSION, intercept: 'home_games_only', win: lg.beta, win_rest: lgR.beta, margin: mm, total: tt, sd_margin: Math.sqrt(sm / prior.length), sd_total: Math.sqrt(st / prior.length), rest_points: rest,
    baseline: { home_rate: homeRate, home_margin: meanMargin, sd_margin: sdMargin0, mean_total: meanTotal, sd_total: sdTotal0 }, n: prior.length };
}

function applyCal(r, c) {
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const on = interceptOn(c, r.neutral);
  const mu = c.margin.a * on + c.margin.b * r.m;
  return {
    points: sig(c.win[0] * on + c.win[1] * r.m),
    points_rest: sig(c.win_rest[0] * on + c.win_rest[1] * r.m + c.win_rest[2] * r.x_rest),
    elo: r.elo,
    const_home: r.neutral ? 0.5 : c.baseline.home_rate,
    margin: { mu, sd: c.sd_margin }, margin_rest: { mu: mu + c.rest_points * r.x_rest, sd: c.sd_margin },
    total: { mu: c.total.a + c.total.b * r.t, sd: c.sd_total },
    margin_base: { mu: r.neutral ? 0 : c.baseline.home_margin, sd: c.baseline.sd_margin }, total_base: { mu: c.baseline.mean_total, sd: c.baseline.sd_total },
  };
}

function score(rows) {
  const cal = {}; const out = [];
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
  for (const s of seasons) {
    const prior = rows.filter((r) => r.season >= s - CAL_SEASONS && r.season < s);
    cal[s] = calibrate(prior);
    if (!cal[s]) continue;
    for (const r of rows) if (r.season === s) out.push(Object.assign(r, { p: applyCal(r, cal[s]) }));
  }
  return { scored: out, cal };
}

function selectionLL(rows, win, cand) {
  let ll = 0, n = 0;
  for (const r of rows) if (r.p && P.inWin(r.season, win)) { ll += V.logLoss(r.p[cand], r.y.hw); n++; }
  return n ? ll / n : Infinity;
}

function tune(league) {
  const W = windowsFor(league); const { games } = load(league);
  const sel = games.filter((g) => g.season <= W.selection[1]);
  const grid = []; let best = null;
  for (const hl of [30, 60, 120, 365]) for (const pg of [2, 4, 8]) for (const carry of [0.4, 0.6, 0.8]) {
    const rp = { half_life_days: hl, prior_games: pg, carry };
    const { rows } = pass(sel, rp, null);
    const { scored } = score(rows);
    const ll = selectionLL(scored, W.selection, 'points');
    grid.push(Object.assign({ selection_ml_log_loss: +ll.toFixed(5) }, rp));
    if (!best || ll < best.ll) best = { ll, rp };
  }
  let bestElo = null;
  for (const k of [12, 20, 28]) for (const hfa of [60, 100, 140]) for (const revert of [0.5, 0.75]) {
    const elo = new Elo({ k, hfa, revert });
    let ll = 0, n = 0;
    for (const g of sel) { elo.startSeason(g.season); if (P.inWin(g.season, W.selection)) { ll += V.logLoss(elo.prob(g.home_id, g.away_id, g.neutral), g.hs > g.as ? 1 : 0); n++; } elo.absorb(g); }
    if (!bestElo || ll / n < bestElo.ll) bestElo = { k, hfa, revert, ll: ll / n };
  }
  const out = { schema: 'edgedesk_bb_tuning_v1', league, generated_at: new Date().toISOString(), rule: 'chosen by SELECTION-window (' + W.selection.join('-') + ') moneyline log loss of `points`; no later season is read', chosen: Object.assign({}, DEFAULTS, best.rp), selection_ml_log_loss: +best.ll.toFixed(5), elo: { k: bestElo.k, hfa: bestElo.hfa, revert: bestElo.revert, selection_ml_log_loss: +bestElo.ll.toFixed(5) }, grid };
  fs.mkdirSync(path.dirname(C.PATHS.tuning(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.tuning(league), JSON.stringify(out, null, 1) + '\n');
  console.log('[bb tune] ' + league + ' chosen ' + JSON.stringify(best.rp) + ' LL ' + best.ll.toFixed(5) + '; Elo ' + JSON.stringify(out.elo));
  return out;
}

function main(league) {
  const W = windowsFor(league); const L = C.LEAGUES[league];
  if (!fs.existsSync(C.PATHS.tuning(league))) tune(league);
  const tuning = JSON.parse(fs.readFileSync(C.PATHS.tuning(league), 'utf8'));
  const { games, seasons } = load(league);
  const { rows, ratings, elo } = pass(games, tuning.chosen, tuning.elo);
  const { scored, cal } = score(rows);
  const evalRows = scored.filter((r) => r.season >= W.selection[0]);
  const leak = V.leakageAudit(evalRows.map((r) => ({ id: r.id, predicted_at: r.predicted_at, event_start: r.start, inputs_known_at: r.inputs_known_at })));
  const CANDS = ['points', 'points_rest'], ALL = CANDS.concat(['elo', 'const_home']);

  const metrics = (sub) => {
    const o = { n: sub.length, by_candidate: {} };
    for (const c of ALL) { const m = V.binary(sub.map((r) => ({ p: r.p[c], y: r.y.hw }))); delete m.bins; o.by_candidate[c] = { moneyline: m }; }
    o.margin = { points: P.distribution(sub.map((r) => Object.assign({ y: r.y.margin }, r.p.margin))), points_rest: P.distribution(sub.map((r) => Object.assign({ y: r.y.margin }, r.p.margin_rest))), baseline: P.distribution(sub.map((r) => Object.assign({ y: r.y.margin }, r.p.margin_base))) };
    o.total = { points: P.distribution(sub.map((r) => Object.assign({ y: r.y.total }, r.p.total))), baseline: P.distribution(sub.map((r) => Object.assign({ y: r.y.total }, r.p.total_base))) };
    o.seasons = [...new Set(sub.map((r) => r.season))].length;
    return o;
  };
  const windows = {};
  for (const [name, w] of Object.entries({ selection: W.selection, confirmation: W.confirmation, live: W.live })) windows[name] = Object.assign({ seasons_range: w }, metrics(evalRows.filter((r) => P.inWin(r.season, w))));
  const selLL = Object.fromEntries(ALL.map((c) => [c, windows.selection.by_candidate[c].moneyline.log_loss]));
  const chosen = P.choose(selLL, CANDS);
  const marginKey = chosen === 'points_rest' ? 'margin_rest' : 'margin';

  const conf = evalRows.filter((r) => P.inWin(r.season, W.confirmation));
  const crps = (k) => (r) => P.crpsNormal(r.p[k].mu, r.p[k].sd, k.indexOf('total') === 0 ? r.y.total : r.y.margin);
  const comparisons = {
    [chosen + '_vs_elo']: P.compare(conf, (r) => V.logLoss(r.p[chosen], r.y.hw), (r) => V.logLoss(r.p.elo, r.y.hw)),
    [chosen + '_vs_const_home']: P.compare(conf, (r) => V.logLoss(r.p[chosen], r.y.hw), (r) => V.logLoss(r.p.const_home, r.y.hw)),
    points_rest_vs_points: P.compare(conf, (r) => V.logLoss(r.p.points_rest, r.y.hw), (r) => V.logLoss(r.p.points, r.y.hw)),
    margin_crps_vs_baseline: P.compare(conf, crps(marginKey), crps('margin_base')),
    total_crps_vs_baseline: P.compare(conf, crps('total'), crps('total_base')),
  };
  const cw = windows.confirmation;
  const bestBase = cw.by_candidate.elo.moneyline.log_loss <= cw.by_candidate.const_home.moneyline.log_loss ? 'elo' : 'const_home';
  const st = P.binaryStatus(cw.by_candidate[chosen].moneyline, cw.seasons, comparisons[chosen + '_vs_' + bestBase].a_better);
  const mDist = cw.margin[chosen === 'points_rest' ? 'points_rest' : 'points'];
  const sm = P.distributionStatus(mDist, cw.seasons, comparisons.margin_crps_vs_baseline.a_better);
  const stt = P.distributionStatus(cw.total.points, cw.seasons, comparisons.total_crps_vs_baseline.a_better);
  const mk = (market, s, m) => Object.assign({ market, status: s.status, failed: s.failed }, m, P.MARKET_NOT_TESTED);
  const markets = {
    moneyline: mk('moneyline (incl. overtime)', st, { n: cw.by_candidate[chosen].moneyline.n, log_loss: cw.by_candidate[chosen].moneyline.log_loss, brier: cw.by_candidate[chosen].moneyline.brier, calibration_in_the_large: cw.by_candidate[chosen].moneyline.calibration_in_the_large, calibration_slope: cw.by_candidate[chosen].moneyline.calibration_slope }),
    spread: mk('point spread (margin distribution, incl. overtime)', sm, mDist),
    total: mk('total points (incl. overtime)', stt, cw.total.points),
  };

  /* live parameters: the ratings now, carried into the season in progress if it has not started */
  const cur = C.currentSeason(league);
  if (ratings.season !== cur) { ratings.startSeason(cur); elo.startSeason(cur); }
  const lastCal = cal[cur] || calibrate(rows.filter((r) => r.season >= cur - CAL_SEASONS && r.season < cur));
  const live = { schema: 'edgedesk_bb_live_v1', league, generated_at: new Date().toISOString(), for_season: cur, model: chosen, params: tuning.chosen, ratings: ratings.dump(), calibration: lastCal, elo: Object.fromEntries([...elo.r.entries()].map(([k, v]) => [k, Math.round(v)])), last_game_date: games.length ? games[games.length - 1].date : null };
  fs.mkdirSync(path.dirname(C.PATHS.params(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.params(league), JSON.stringify(live) + '\n');

  const report = {
    schema: 'edgedesk_lab_walkforward_v1', sport: league, label: L.label, generated_at: live.generated_at,
    protocol: { windows: W, calibration_seasons: CAL_SEASONS, rules: P.RULES, prediction_time: 'scheduled start - 30 min; inputs: games whose assumed availability (start + 4 h) is before it', candidates: CANDS, baselines: { elo: 'FiveThirtyEight NBA Elo form, tuned on the selection window: ' + JSON.stringify(tuning.elo), const_home: 'home win rate of the three seasons before (0.5 at a neutral site)' } },
    data: { source: 'basketball/data/' + league + ' (sportsdataverse, from ESPN)', license: C.LICENSE, seasons: [seasons[0], seasons[seasons.length - 1]], games: games.length, games_scored: evalRows.length,
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank (first publication unknown; never backdated)', assumed_available_at: 'start + 4 h' } },
    leakage: Object.assign({ basis: 'inputs dated by assumed_available_at (start + 4 h)' }, leak),
    tuning: { chosen: tuning.chosen, elo: tuning.elo, rule: tuning.rule },
    selection: { rule: 'lowest selection-window moneyline log loss; a challenger must beat the incumbent by >= ' + P.RULES.challenger_margin, ll: selLL, chosen },
    comparisons, best_baseline: bestBase, markets, windows,
    by_season: Object.fromEntries([...new Set(evalRows.map((r) => r.season))].map((s) => { const sub = evalRows.filter((r) => r.season === s); return [s, { n: sub.length, ml_log_loss: { [chosen]: V.r(sub.reduce((a, r) => a + V.logLoss(r.p[chosen], r.y.hw), 0) / sub.length, 5), elo: V.r(sub.reduce((a, r) => a + V.logLoss(r.p.elo, r.y.hw), 0) / sub.length, 5) } }]; })),
    caveats: [
      'Retrospective, not point-in-time certified: results were retrieved after the fact; a game is assumed known 4 hours after its start.',
      'No lineup, injury or rest-of-roster input: a star\'s absence is not in the number (the data pack lists availability as a P0 gap).',
      'Outcome validation only: no licensed archive of timestamped closing prices exists here, so nothing is compared with the market.',
    ],
  };
  fs.mkdirSync(path.dirname(C.PATHS.validation(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.validation(league), JSON.stringify(report, null, 1) + '\n');
  const c = windows.confirmation;
  console.log('[bb walkforward] ' + league + ': ' + evalRows.length + ' games scored, leakage ' + leak.violations + ', chosen ' + chosen + ' | conf n ' + c.n + ' seasons ' + c.seasons);
  for (const k of ALL) console.log('   ' + k.padEnd(12) + ' sel LL ' + selLL[k] + ' | conf LL ' + c.by_candidate[k].moneyline.log_loss + ' slope ' + c.by_candidate[k].moneyline.calibration_slope + ' citl ' + c.by_candidate[k].moneyline.calibration_in_the_large);
  console.log('   margin ' + JSON.stringify(c.margin.points) + ' base ' + JSON.stringify(c.margin.baseline));
  console.log('   total  ' + JSON.stringify(c.total.points) + ' base ' + JSON.stringify(c.total.baseline));
  console.log('   markets ' + Object.entries(markets).map(([k, v]) => k + '=' + v.status + (v.failed.length ? ' (' + v.failed.join('; ') + ')' : '')).join(' | '));
  return report;
}

function check(league) {
  const r = JSON.parse(fs.readFileSync(C.PATHS.validation(league), 'utf8'));
  const fails = [];
  if (r.schema !== 'edgedesk_lab_walkforward_v1') fails.push('schema');
  if (!r.leakage || r.leakage.violations !== 0) fails.push('leakage violations ' + (r.leakage && r.leakage.violations));
  if (!r.data.temporal || r.data.temporal.point_in_time !== 'RETROSPECTIVE') fails.push('must say retrospective');
  for (const [k, m] of Object.entries(r.markets)) if (m.market_status !== 'NOT_TESTED') fails.push(k + ' claims a market test');
  if (!fs.existsSync(C.PATHS.params(league))) fails.push('no live params');
  if (fails.length) { console.error('[bb walkforward --check] ' + league + ' FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[bb walkforward --check] ' + league + ' ok: ' + r.data.games_scored + ' games, moneyline ' + r.markets.moneyline.status);
}

module.exports = { pass, calibrate, applyCal, score, windowsFor, load, interceptOn, CAL_VERSION };

if (require.main === module) {
  const lg = arg('league', 'all'); const leagues = lg === 'all' ? Object.keys(C.LEAGUES) : lg.split(',');
  for (const l of leagues) { if (flag('check')) check(l); else if (flag('tune')) { tune(l); main(l); } else main(l); }
}
