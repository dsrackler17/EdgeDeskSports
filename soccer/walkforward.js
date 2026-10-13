#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk soccer — the walk-forward record of one league.

     node soccer/walkforward.js --league epl|...|all [--tune] [--check]

   The protocol is engine/lab/protocol.js:
     1. One chronological pass by match day: matches on day D are predicted
        from a fit on matches of earlier days only, then D is absorbed.
     2. Hyperparameters (decay half-life, prior strength) are tuned on the
        SELECTION window only; the Elo baseline's home advantage likewise.
     3. Candidates, in order: `poisson` (independent, the incumbent),
        `dixon_coles` (with the low-score correction), and each of them after
        a pair recalibration of the two goal rates (`_cal`: total shrink,
        split stretch; hockey/model/glm.js) fitted on the three earlier
        seasons' out-of-sample predictions. Baselines: Elo mapped to 1X2 (its
        draw curve fitted on earlier seasons) and the league's base rates.
     4. 1X2 is scored by the ranked probability score (Constantinides & Forrest)
        and log loss; it is OUTCOME_VALIDATED when the home-win probabilities
        pass the binary rules, the draw is calibrated within 0.02, and the RPS
        beats the best baseline with a 95% interval below zero. Totals (2.5),
        both-to-score and the Asian handicap (home -1.5) by the binary rules.
   Windows per league: burn-in = its first two seasons on file, SELECTION to
   2017-18, CONFIRMATION 2018-19 to the last completed season, LIVE the
   season in progress.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const I = require('./ingest');
const { DixonColes, EloSoccer, markets, DEFAULTS } = require('./model');
const GLM = require('../hockey/model/glm');
const P = require('../engine/lab/protocol');
const V = require('../engine/validation');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const dayNum = (d) => Math.floor(Date.parse(d + 'T12:00:00Z') / 864e5);

function load(league) {
  const cur = C.currentSeason(); const seasons = []; for (let s = C.FIRST; s <= cur; s++) seasons.push(s);
  const all = I.loadMatches(league, seasons);
  const have = [...new Set(all.map((m) => m.season))].sort((a, b) => a - b);
  return { all, final: all.filter((m) => m.status === 'FINAL'), seasons: have, cur };
}
function windowsFor(have, cur) {
  const first = have[0];
  return { burn_in: [first, first + 1], selection: [first + 2, 2018], confirmation: [2019, cur - 1], live: [cur, cur] };
}

function clubsOf(all, s) { return [...new Set(all.filter((m) => m.season === s).flatMap((m) => [m.home, m.away]))].sort(); }

/** one chronological pass */
function pass(all, final, params, eloParams, upTo) {
  const dc = new DixonColes(params); const elo = new EloSoccer(eloParams);
  const rows = []; let maxKnown = null;
  const byDay = new Map(); for (const m of final) { if (!byDay.has(m.date)) byDay.set(m.date, []); byDay.get(m.date).push(m); }
  const days = [...byDay.keys()].sort();
  for (const date of days) {
    const day = byDay.get(date); const S = day[0].season;
    if (upTo != null && S > upTo) break;
    if (dc.season !== S) { dc.startSeason(S, clubsOf(all, S)); elo.startSeason(S); }
    dc.fit(dayNum(date));
    for (const m of day) {
      const L = dc.lambdas(m.home, m.away);
      rows.push({ id: m.match_id, season: S, date, home: m.home, away: m.away, elo_e: elo.expect(m.home, m.away),
        lam: [L.lh, L.la], rho: dc.rho,
        y: { res: m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2, hg: m.hg, ag: m.ag, o25: m.hg + m.ag > 2.5 ? 1 : 0, btts: m.hg > 0 && m.ag > 0 ? 1 : 0, h2: m.hg - m.ag >= 2 ? 1 : 0 },
        predicted_at: Date.parse(date + 'T00:00:00Z'), event_start: Date.parse(date + 'T00:00:00Z') + 1, inputs_known_at: maxKnown });
    }
    dc.absorb(dayNum(date), day);
    for (const m of day) { elo.absorb(m); const k = Date.parse(m.assumed_available_at); if (maxKnown == null || k > maxKnown) maxKnown = k; }
  }
  return { rows, dc, elo };
}

/* Elo -> 1X2: P(draw) = a - b (E - 0.5)^2, fitted on earlier seasons */
function eloDrawCurve(prior) {
  if (prior.length < 200) return { a: 0.26, b: 0.8, n: prior.length, basis: 'default (too few earlier matches)' };
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = prior.length;
  for (const r of prior) { const x = Math.pow(r.elo_e - 0.5, 2); const y = r.y.res === 1 ? 1 : 0; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const b = -(n * sxy - sx * sy) / (n * sxx - sx * sx || 1); const a = (sy + b * sx) / n;
  return { a, b, n };
}
function eloProbs(e, c) {
  let d = Math.max(0.05, c.a - c.b * Math.pow(e - 0.5, 2));
  let h = Math.max(0.01, e - d / 2), a = Math.max(0.01, 1 - e - d / 2);
  const s = h + d + a; return [h / s, d / s, a / s];
}
function baseRates(prior) {
  if (!prior.length) return [0.45, 0.27, 0.28];
  const c = [0, 0, 0]; for (const r of prior) c[r.y.res]++;
  return c.map((v) => v / prior.length);
}

/* the score matrix of a row after the season's pair recalibration (rho 0 = independent Poisson) */
function matrix(r, pc, rho, max) {
  const { lh, la } = GLM.applyPairCalibration(r.lam[0], r.lam[1], pc);
  const M = new DixonColes({ max_goals: max || 10 });
  M.lambdas = () => ({ lh, la });
  return M.score(null, null, rho);
}

function score(rows) {
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
  const cal = {};
  for (const s of seasons) {
    const prior = rows.filter((r) => r.season >= s - 3 && r.season < s);
    /* total shrink and split stretch of the goal rates, fitted on earlier seasons' out-of-sample rows (as for the NHL) */
    const pc = GLM.fitPairCalibration(prior.map((r) => ({ lh: r.lam[0], la: r.lam[1], gh: r.y.hg, ga: r.y.ag })));
    cal[s] = { elo_draw: eloDrawCurve(prior), base: baseRates(prior), pair_calibration: pc, n: prior.length };
    const ID = { a: 1, b: 1 };
    for (const r of rows) if (r.season === s) {
      r.mk = { poisson: markets(matrix(r, ID, 0)), dixon_coles: markets(matrix(r, ID, r.rho)), poisson_cal: markets(matrix(r, pc, 0)), dixon_coles_cal: markets(matrix(r, pc, r.rho)) };
      r.p = { elo: eloProbs(r.elo_e, cal[s].elo_draw), base_rates: cal[s].base };
      for (const c of CANDS) r.p[c] = [r.mk[c].home, r.mk[c].draw, r.mk[c].away];
    }
  }
  return cal;
}

const CANDS = ['poisson', 'dixon_coles', 'poisson_cal', 'dixon_coles_cal'], ALL = CANDS.concat(['elo', 'base_rates']);
function mll(rows, c) { let s = 0; for (const r of rows) s += V.mlogLoss(r.p[c], r.y.res); return rows.length ? s / rows.length : Infinity; }
function mrps(rows, c) { let s = 0; for (const r of rows) s += V.rps(r.p[c], r.y.res); return rows.length ? s / rows.length : Infinity; }

function tune(league) {
  const { all, final, seasons, cur } = load(league); const W = windowsFor(seasons, cur);
  const grid = []; let best = null;
  for (const hl of [120, 240, 480]) for (const k of [2, 4, 8]) {
    const rp = { half_life_days: hl, prior_matches: k };
    const { rows } = pass(all, final, rp, null, W.selection[1]); score(rows);
    const sel = rows.filter((r) => P.inWin(r.season, W.selection));
    const ll = mll(sel, 'dixon_coles');
    grid.push(Object.assign({ selection_1x2_log_loss: +ll.toFixed(5), selection_rps: +mrps(sel, 'dixon_coles').toFixed(5) }, rp));
    if (!best || ll < best.ll) best = { ll, rp };
  }
  let bestElo = null;
  for (const hfa of [40, 70, 100]) for (const kk of [15, 25]) {
    const elo = new EloSoccer({ k: kk, hfa }); let ll = 0, n = 0;
    const ff = final.filter((m) => m.season <= W.selection[1]).sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const m of ff) { elo.startSeason(m.season); if (P.inWin(m.season, W.selection)) { const e = elo.expect(m.home, m.away); const y = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0; ll += -(y * Math.log(e) + (1 - y) * Math.log(1 - e)); n++; } elo.absorb(m); }
    if (!bestElo || ll / n < bestElo.ll) bestElo = { k: kk, hfa, revert: 0.8, ll: ll / n };
  }
  const out = { schema: 'edgedesk_soccer_tuning_v1', league, generated_at: new Date().toISOString(), rule: 'chosen by SELECTION-window (' + W.selection.join('-') + ') 1X2 log loss of dixon_coles; Elo by its expected-score loss on the same window', chosen: Object.assign({}, DEFAULTS, best.rp), selection_1x2_log_loss: +best.ll.toFixed(5), elo: bestElo, grid };
  fs.mkdirSync(path.dirname(C.PATHS.tuning(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.tuning(league), JSON.stringify(out, null, 1) + '\n');
  console.log('[soccer tune] ' + league + ' ' + JSON.stringify(best.rp) + ' LL ' + best.ll.toFixed(5) + ' Elo ' + JSON.stringify(bestElo));
}

function main(league) {
  if (!fs.existsSync(C.PATHS.tuning(league))) tune(league);
  const tuning = JSON.parse(fs.readFileSync(C.PATHS.tuning(league), 'utf8'));
  const { all, final, seasons, cur } = load(league); const W = windowsFor(seasons, cur);
  const { rows, dc, elo } = pass(all, final, tuning.chosen, tuning.elo);
  const cal = score(rows);
  const evalRows = rows.filter((r) => r.season >= W.selection[0]);
  const leak = V.leakageAudit(evalRows.map((r) => ({ id: r.id, predicted_at: r.predicted_at, event_start: r.event_start, inputs_known_at: r.inputs_known_at })));
  const bin = (sub, f) => { const m = V.binary(sub.map(f)); delete m.bins; return m; };
  const metrics = (sub) => {
    const o = { n: sub.length, seasons: [...new Set(sub.map((r) => r.season))].length, by_candidate: {} };
    for (const c of ALL) o.by_candidate[c] = { log_loss_1x2: V.r(mll(sub, c), 5), rps: V.r(mrps(sub, c), 5), home_win: bin(sub, (r) => ({ p: r.p[c][0], y: r.y.res === 0 ? 1 : 0 })), draw: bin(sub, (r) => ({ p: r.p[c][1], y: r.y.res === 1 ? 1 : 0 })) };
    for (const c of CANDS) Object.assign(o.by_candidate[c], { over_2_5: bin(sub, (r) => ({ p: r.mk[c].over_2_5, y: r.y.o25 })), btts: bin(sub, (r) => ({ p: r.mk[c].btts, y: r.y.btts })), home_by_2: bin(sub, (r) => ({ p: r.mk[c].home_by_2, y: r.y.h2 })) });
    return o;
  };
  const windows = {};
  for (const [name, w] of Object.entries({ selection: W.selection, confirmation: W.confirmation, live: W.live })) windows[name] = Object.assign({ seasons_range: w }, metrics(evalRows.filter((r) => P.inWin(r.season, w))));
  const selLL = Object.fromEntries(ALL.map((c) => [c, windows.selection.by_candidate[c].log_loss_1x2]));
  const chosen = P.choose(selLL, CANDS);
  const conf = evalRows.filter((r) => P.inWin(r.season, W.confirmation));
  const cw = windows.confirmation;
  const bestBase = cw.by_candidate.elo.rps <= cw.by_candidate.base_rates.rps ? 'elo' : 'base_rates';
  const comparisons = {
    [chosen + '_rps_vs_elo']: P.compare(conf, (r) => V.rps(r.p[chosen], r.y.res), (r) => V.rps(r.p.elo, r.y.res)),
    [chosen + '_rps_vs_base_rates']: P.compare(conf, (r) => V.rps(r.p[chosen], r.y.res), (r) => V.rps(r.p.base_rates, r.y.res)),
    dixon_coles_vs_poisson_log_loss: P.compare(conf, (r) => V.mlogLoss(r.p.dixon_coles, r.y.res), (r) => V.mlogLoss(r.p.poisson, r.y.res)),
  };
  const cm = cw.by_candidate[chosen];
  const s1 = P.binaryStatus(cm.home_win, cw.seasons, comparisons[chosen + '_rps_vs_' + bestBase].a_better);
  if (Math.abs(cm.draw.calibration_in_the_large) > P.RULES.max_citl) { s1.failed.push('draw mean p off by ' + cm.draw.calibration_in_the_large); s1.status = 'PROVISIONAL'; }
  const mk = (market, s, m) => Object.assign({ market, status: s.status, failed: s.failed, n: m.n, log_loss: m.log_loss, brier: m.brier, calibration_in_the_large: m.calibration_in_the_large, calibration_slope: m.calibration_slope }, P.MARKET_NOT_TESTED);
  const markets = {
    three_way: Object.assign(mk('1X2 (90 minutes + stoppage time)', s1, cm.home_win), { rps: cm.rps, log_loss_1x2: cm.log_loss_1x2, draw_calibration_in_the_large: cm.draw.calibration_in_the_large }),
    total_over_2_5: mk('total goals 2.5', P.binaryStatus(cm.over_2_5, cw.seasons, null), cm.over_2_5),
    btts: mk('both teams to score', P.binaryStatus(cm.btts, cw.seasons, null), cm.btts),
    asian_handicap: mk('Asian handicap home -1.5 (home by 2+)', P.binaryStatus(cm.home_by_2, cw.seasons, null), cm.home_by_2),
  };

  /* live: the fit as of today, carried into the season in progress */
  const curClubs = clubsOf(all, cur);
  if (dc.season !== cur && curClubs.length) { dc.startSeason(cur, curClubs); elo.startSeason(cur); }
  dc.fit(dayNum(new Date().toISOString().slice(0, 10)));
  const pcLive = GLM.fitPairCalibration(rows.filter((r) => r.season >= cur - 3 && r.season < cur).map((r) => ({ lh: r.lam[0], la: r.lam[1], gh: r.y.hg, ga: r.y.ag })));
  const live = { schema: 'edgedesk_soccer_live_v1', league, generated_at: new Date().toISOString(), for_season: cur, model: chosen, params: tuning.chosen, fit: dc.dump(), pair_calibration: pcLive, last_result_date: final.length ? final[final.length - 1].date : null, results_missing_this_season: all.filter((m) => m.season === cur && m.status === 'RESULT_MISSING').length };
  fs.mkdirSync(path.dirname(C.PATHS.params(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.params(league), JSON.stringify(live) + '\n');

  const report = {
    schema: 'edgedesk_lab_walkforward_v1', sport: 'soccer', league, label: C.LEAGUES[league].label, generated_at: live.generated_at,
    protocol: { windows: W, rules: P.RULES, prediction_time: 'the start of the match day; inputs: matches of earlier days', candidates: CANDS, baselines: { elo: 'goal-difference Elo tuned on the selection window ' + JSON.stringify(tuning.elo) + ', draw curve fitted on the three seasons before', base_rates: 'home/draw/away frequencies of the three seasons before' } },
    data: { source: 'soccer/data/' + league + ' (openfootball, public domain)', license: C.LICENSE, seasons: [seasons[0], seasons[seasons.length - 1]], matches: final.length, matches_scored: evalRows.length,
      results_missing: all.filter((m) => m.status === 'RESULT_MISSING').length,
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank (never backdated)', assumed_available_at: 'the match day 23:59 UTC' } },
    leakage: Object.assign({ basis: 'inputs dated by assumed_available_at (match day 23:59 UTC); predictions at the start of the match day' }, leak),
    tuning: { chosen: tuning.chosen, elo: tuning.elo, rule: tuning.rule },
    selection: { rule: 'lowest selection-window 1X2 log loss; a challenger must beat the incumbent by >= ' + P.RULES.challenger_margin, ll: selLL, chosen },
    comparisons, best_baseline: bestBase, markets, windows,
    pair_calibration_by_season: Object.fromEntries(Object.entries(cal).map(([k, v]) => [k, v.pair_calibration])),
    caveats: [
      'Retrospective, not point-in-time certified: results were retrieved after the fact.',
      'Results the source lacks are listed as RESULT_MISSING and never guessed; a season with missing results rates its clubs on fewer matches.',
      'No lineup, injury, xG or schedule-congestion input; cup and European fixtures are not in the data.',
      'Outcome validation only: no licensed archive of timestamped closing prices, so nothing is compared with the market.',
    ],
  };
  fs.mkdirSync(path.dirname(C.PATHS.validation(league)), { recursive: true });
  fs.writeFileSync(C.PATHS.validation(league), JSON.stringify(report, null, 1) + '\n');
  console.log('[soccer walkforward] ' + league + ': ' + evalRows.length + ' scored, leakage ' + leak.violations + ', chosen ' + chosen + ' | conf n ' + cw.n + ' seasons ' + cw.seasons);
  for (const c of ALL) console.log('   ' + c.padEnd(12) + ' sel LL ' + selLL[c] + ' | conf LL ' + cw.by_candidate[c].log_loss_1x2 + ' RPS ' + cw.by_candidate[c].rps + ' home slope ' + cw.by_candidate[c].home_win.calibration_slope + ' citl ' + cw.by_candidate[c].home_win.calibration_in_the_large + ' draw citl ' + cw.by_candidate[c].draw.calibration_in_the_large);
  console.log('   vs ' + bestBase + ' ' + JSON.stringify(comparisons[chosen + '_rps_vs_' + bestBase]));
  console.log('   markets ' + Object.entries(markets).map(([k, v]) => k + '=' + v.status + (v.failed.length ? ' (' + v.failed.join('; ') + ')' : '')).join(' | '));
  return report;
}

function check(league) {
  const r = JSON.parse(fs.readFileSync(C.PATHS.validation(league), 'utf8'));
  const fails = [];
  if (!r.leakage || r.leakage.violations !== 0) fails.push('leakage');
  if (!r.data.temporal || r.data.temporal.point_in_time !== 'RETROSPECTIVE') fails.push('must say retrospective');
  for (const [k, m] of Object.entries(r.markets)) if (m.market_status !== 'NOT_TESTED') fails.push(k + ' claims a market test');
  if (!fs.existsSync(C.PATHS.params(league))) fails.push('no live params');
  if (fails.length) { console.error('[soccer --check] ' + league + ' FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[soccer --check] ' + league + ' ok: ' + r.data.matches_scored + ' matches, 1X2 ' + r.markets.three_way.status);
}

module.exports = { pass, score, windowsFor, load, eloProbs };
if (require.main === module) {
  const lg = arg('league', 'all'); const leagues = lg === 'all' ? Object.keys(C.LEAGUES) : lg.split(',');
  for (const l of leagues) { if (flag('check')) check(l); else if (flag('tune')) { tune(l); main(l); } else main(l); }
}
