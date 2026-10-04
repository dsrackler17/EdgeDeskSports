#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_process.js — the grade and the coach, in Node.

   The statistics are checked against values computed independently; the
   evidence ladder is driven with synthetic aggregates built to be (a) noise,
   (b) a real, stable difference, (c) a difference in results only; and every
   sentence the coach can produce is checked for the words it may not use.

   Run: node tools/portfolio/process.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_process.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
const near = (a, b, tol) => Math.abs(a - b) <= (tol || 1e-3);

/* ── the components, by hand ──────────────────────────────────────────── */
chk('CLV: −110 taken (1.909091), −120 at the close (1.833333) is +4.1323% of price', X.clvPct('SPORTSBOOK', '1.909091', '1.833333') === '0.041323');
chk('CLV score: the close itself is 50; +5% is 100; −5% is 0', X.scoreClv('0', null) === '50' && X.scoreClv('0.05', null) === '100' && X.scoreClv('-0.05', null) === '0');
chk('a line that moved is graded in points: +1 point is 75', X.scoreClv('0.2', '1') === '75');
chk('model edge: 55% at 1.952381 is +7.38% EV → 100 (capped)', X.modelEv('SPORTSBOOK', '0.55', '1.952381') === '0.07381' && X.scoreModel('0.07381') === '100');
chk('a probability of 0 or 1 is not a model', X.modelEv('SPORTSBOOK', '1', '2') === null && X.modelEv('SPORTSBOOK', '0', '2') === null);
chk('price quality: matching the researched price scores 100; 2% worse scores 80', X.scorePrice('0', null) === '100' && X.scorePrice('-0.02', null) === '80' && X.scorePrice('0.03', null) === '100');
chk('timing: the best recorded price scores 100, the worst 0, needs two other points and a path that moved',
  X.scoreTiming('SPORTSBOOK', '2.1', '2.0', '1.9', null) === '100' && X.scoreTiming('SPORTSBOOK', '1.9', '2.0', '2.1', null) === '0'
  && X.scoreTiming('SPORTSBOOK', '2', '2', null, null) === null && X.scoreTiming('SPORTSBOOK', '2', '2', '2', null) === null);
chk('timing for a contract: the lowest price paid is best', X.scoreTiming('PREDICTION_MARKET', '0.40', '0.50', '0.45', '0.60') === '100');
chk('sizing: within the cap 100; 1.5× the cap 50; the day\'s exposure counts too', X.scoreSizing('1', '1', '2', '4') === '100'
  && X.scoreSizing('1.5', '1', '2', '4') === '50' && X.scoreSizing('1', '1', '6', '4') === '50' && X.scoreSizing(null, '1', null, '4') === null);
chk('the weights add to 100', Object.values(X.WEIGHTS).reduce((a, b) => a + b, 0) === 100);
chk('renormalized over what exists: CLV 70 and model 60 → (30×70 + 20×60) / 50 = 66.0', X.processScore({ clv: '70', model: '60' }) === '66');
chk('no price-based component, no grade — however good the sizing', X.processScore({ sizing: '100', market: '80', rules: '100' }) === null);
chk('under 30 points of weight, no grade', X.processScore({ timing: '90', market: '80', rules: '100' }) === null && X.processScore({ timing: '90', sizing: '80', market: '80' }) !== null);
chk('letters', ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'].join() === [95, 85, 80, 75, 70, 62, 57, 50, 42, 35, 10].map(X.gradeLetter).join());
chk('confidence by sample', ['BUILDING', 'LOW', 'MEDIUM', 'HIGH'].join() === [9, 10, 30, 100].map(X.confidence).join());
chk('a win at a bad price grades below a loss at a good price — the result is not an input',
  X.processScore({ clv: X.scoreClv(X.clvPct('SPORTSBOOK', '2', '2.3'), null), market: '80' }) < X.processScore({ clv: X.scoreClv(X.clvPct('SPORTSBOOK', '2.3', '2'), null), market: '80' }));
const g = X.gradePosition({ platform_type: 'SPORTSBOOK', odds_decimal: '2', position_type: 'MONEYLINE', cost_basis: '50', selection: 'Team',
  event_start_at: '2099-01-01T00:00:00Z', journal: { closing_odds_decimal: '1.8', model_probability: '0.55', model_recorded_at: '2026-01-01T00:00:00Z',
    unit_size_at_entry: '25', max_single_units_at_entry: '1', max_daily_units_at_entry: '4' } });
chk('a whole position graded in the browser the way the server grades it', g.clv_pct === '0.111111' && g.components.clv === '100' && g.model_ev === '0.1'
  && g.components.model === '100' && g.units === '2' && g.components.sizing === '0' && g.score != null, g);
chk('rule verdicts: a 2-unit position breaks a 1-unit cap; an unrecorded start time is UNKNOWN, never a pass',
  X.ruleVerdict('MAX_STAKE_UNITS', { units: 1 }, { units: '2' }) === 'BROKEN' && X.ruleVerdict('NO_LIVE', {}, { leadSeconds: null }) === 'UNKNOWN'
  && X.ruleVerdict('ONLY_SPORTS', { sports: ['nfl'] }, { sport: 'NFL' }) === 'FOLLOWED');

/* ── the statistics, against independent values ─────────────────────── */
chk('Student t: p(|t| ≥ 2.0, df 10) = 0.0734', near(X.tPValue(2.0, 10), 0.0734, 2e-4), X.tPValue(2.0, 10));
chk('Student t: p(|t| ≥ 1.96, df 10000) ≈ 0.05', near(X.tPValue(1.96, 10000), 0.05, 1e-3));
chk('t critical value: 95% with df 5 is 2.571, with df 1000 is 1.962', near(X.tCrit(0.95, 5), 2.5706, 1e-3) && near(X.tCrit(0.95, 1000), 1.9623, 1e-3));
const a = X.moments(5, 15, 55), b = X.moments(5, 35, 255);   /* {1..5} and {5..9} */
const w = X.welch(a, b);
chk('Welch on {1..5} vs {5..9}: diff −4, t −4, df 8, p 0.0039', near(w.diff, -4) && near(w.t, -4) && near(w.df, 8) && near(w.p, 0.00395, 1e-4), w);
const q = X.bh([0.01, 0.04, 0.03, 0.20]);
chk('Benjamini–Hochberg q-values (step-up): p .01 → .04, p .04 → .0533, p .03 → .0533, p .20 → .20', near(q[0], 0.04) && near(q[1], 0.05333) && near(q[2], 0.05333) && near(q[3], 0.2), q);

/* ── the evidence ladder on synthetic aggregates ─────────────────────── */
/* a cell built from per-position values: n, sum and sum of squares, and the
   halves and holdout the stability tests read */
function cell(dim, key, values, opts) {
  opts = opts || {};
  const m = (vs) => [vs.length, vs.reduce((s, v) => s + v, 0), vs.reduce((s, v) => s + v * v, 0)];
  const ps = values.map((v) => v.ps), clv = values.map((v) => v.clv), ret = values.map((v) => v.ret);
  const seg = (lo, hi) => { const part = values.slice(Math.floor(values.length * lo), Math.floor(values.length * hi)); return [].concat(m(part.map((v) => v.ret)), m(part.map((v) => v.clv)), m(part.map((v) => v.ps))); };
  const [psn, pss, psq] = m(ps), [cn, cs, cq] = m(clv), [rn, rs, rq] = m(ret);
  return { dim, key, n: values.length, settled: rn, staked: values.length * 100, pnl: rs * 100, ret_n: rn, ret_sum: rs, ret_sq: rq,
    clv_n: cn, clv_sum: cs, clv_sq: cq, ps_n: psn, ps_sum: pss, ps_sq: psq, segs: { h1: seg(0, 0.5), h2: seg(0.5, 1), ho: seg(0.7, 1) }, ...opts };
}
let s = 7;
const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
const gauss = () => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function population(n, mean) { return Array.from({ length: n }, () => ({ ps: mean.ps + 12 * gauss(), clv: mean.clv + 0.03 * gauss(), ret: mean.ret + 0.9 * gauss() })); }
/* (a) noise: the same distribution everywhere */
const noiseA = population(120, { ps: 60, clv: 0.01, ret: -0.03 }), noiseB = population(160, { ps: 60, clv: 0.01, ret: -0.03 });
let cells = [cell('all', 'all', noiseA.concat(noiseB)), cell('sport', 'NFL', noiseA), cell('sport', 'NBA', noiseB)];
let res = X.analyze(cells, { period: 'test' });
chk('pure noise: nothing reaches SUPPORTED, and the Overview says NO RELIABLE LEAK DETECTED',
  !res.findings.some((f) => X.LEVELS.indexOf(f.level) >= 2) && X.headlines(res, { minLevel: 'SUPPORTED' }).not_working.length === 0, res.findings.map((f) => [f.label, f.level]));
/* (b) a real, stable process difference: CFB spreads entered with worse CLV and process */
const weak = population(140, { ps: 48, clv: -0.02, ret: -0.08 }), rest = population(260, { ps: 63, clv: 0.012, ret: -0.02 });
cells = [cell('all', 'all', weak.concat(rest)), cell('sport_type', 'CFB · SPREAD', weak), cell('sport_type', 'NFL · SPREAD', rest)];
res = X.analyze(cells, { period: 'Aug 1 – Oct 4' });
const leak = res.findings.find((f) => f.key === 'CFB · SPREAD' && f.kind === 'LEAK');
chk('a large, stable process gap on 140 positions is a LEAK at SUPPORTED or STRONG EVIDENCE, confirmed by a process metric',
  leak && X.LEVELS.indexOf(leak.level) >= 2 && leak.process === true && leak.stable, leak && [leak.level, leak.metric, leak.stable, leak.q]);
chk('…its WHY names the data, the sample, the period, the comparison, the calculation, the confidence and the limitation',
  leak && ['data_used', 'sample', 'period', 'comparison', 'calculation', 'confidence', 'limitations', 'positions'].every((k) => leak.why[k] != null)
  && /140 positions/.test(leak.why.sample) && /not a cause/.test(leak.why.limitations), leak && leak.why);
chk('…and the strongest finding names the group and its numbers in plain words', leak && /CFB · Spread/.test(leak.text) && /140 positions/.test(leak.text) && /95% interval/.test(leak.text), leak && leak.text);
/* (c) a difference in results only — profit and loss with no process gap */
const lucky = population(120, { ps: 60, clv: 0.01, ret: 0.35 }), others = population(200, { ps: 60, clv: 0.01, ret: -0.05 });
cells = [cell('all', 'all', lucky.concat(others)), cell('platform', 'fanduel', lucky), cell('platform', 'draftkings', others)];
res = X.analyze(cells, {});
const lucky1 = res.findings.filter((f) => f.key === 'fanduel');
chk('a difference in results with no process difference never reaches SUPPORTED, and says it could be variance',
  lucky1.length > 0 && lucky1.every((f) => X.LEVELS.indexOf(f.level) < 2 || f.process) && lucky1.filter((f) => f.metric === 'ret').every((f) => /could be variance/.test(f.text)),
  lucky1.map((f) => [f.metric, f.level]));
/* (d) a small sample: 8 positions is not tested at all */
const tiny = population(8, { ps: 20, clv: -0.1, ret: -1 }), big = population(200, { ps: 60, clv: 0.01, ret: 0 });
res = X.analyze([cell('all', 'all', tiny.concat(big)), cell('tag', 'LIVE_READ', tiny), cell('tag', 'MODEL', big)], {});
chk('8 positions — however extreme — produce no finding at all', !res.findings.some((f) => f.key === 'LIVE_READ'));

/* ── nothing the coach says breaks its own rules ─────────────────────── */
const texts = [];
[res].concat([X.analyze(cells, {})]).forEach((rr) => rr.findings.forEach((f) => { texts.push(f.text, f.headline, JSON.stringify(f.why)); }));
texts.push(X.headlines(res).none_detail, X.variance({ n: 50, wins: 20, expected_wins: 26.5, var: 12 }).text, X.variance({ n: 50, wins: 31, expected_wins: 25, var: 12 }).text);
chk('no generated sentence uses a banned word (tilt, FOMO, chasing, "stay disciplined", "bet more", deposit, lock, guaranteed …)',
  texts.every(X.clean), texts.filter((t) => !X.clean(t)).slice(0, 3));
chk('the banned-word check itself catches them', !X.clean('Looks like tilt after losses') && !X.clean('Stay disciplined') && !X.clean('This is a LOCK') && X.clean('Closing line value fell'));
chk('variance: 20 wins where 26.5 were implied is a z of −1.88 — a modest run, within chance', /z = −?-?1\.88/.test(X.variance({ n: 50, wins: 20, expected_wins: 26.5, var: 12 }).text.replace('−', '-'))
  || /-1\.88/.test(X.variance({ n: 50, wins: 20, expected_wins: 26.5, var: 12 }).text));

/* ── experiments and counterfactuals ─────────────────────────────────── */
const before = cell('all', 'all', population(60, { ps: 55, clv: -0.005, ret: 0 }));
const during = cell('all', 'all', population(60, { ps: 66, clv: 0.02, ret: 0 }));
const exp = { metric: 'CLV', status: 'ACTIVE', ends_at: '2099-01-01', min_sample: 20, condition: {} };
chk('an experiment whose CLV rose clearly is SUPPORTED', X.evaluateExperiment(exp, [during], [before]).status === 'SUPPORTED');
chk('…one with too few positions is INCONCLUSIVE and says how many more', (() => { const o = X.evaluateExperiment({ ...exp, min_sample: 100 }, [during], [before]); return o.status === 'INCONCLUSIVE' && o.needed === 40; })());
chk('…and one that ended with CLV no better is NOT SUPPORTED', X.evaluateExperiment({ ...exp, status: 'ENDED' }, [before], [during]).status === 'NOT_SUPPORTED');
const cf = X.counterfactualWithout([{ dim: 'all', key: 'all', pnl: 500, settled: 100 }, { dim: 'timing', key: 'LIVE', pnl: -300, settled: 20 }], 'timing', 'LIVE');
chk('a counterfactual is always labelled HISTORICAL COUNTERFACTUAL — NOT A FORECAST', cf.label === 'HISTORICAL COUNTERFACTUAL — NOT A FORECAST' && cf.without === 800 && /Live/.test(cf.text));
const flat = X.counterfactualFlat([{ dim: 'all', key: 'all', pnl: 120, ret_n: 40, ret_sum: 2.5 }], '25');
chk('flat staking: Σ(return per $1) × the unit', flat.flat === 62.5 && flat.label === X.COUNTERFACTUAL_LABEL);
const pkt = X.evidencePacket(leak);
chk('the explanation layer is handed numbers and rules, never asked to compute', pkt.cell.n === 140 && pkt.rules.some((x) => /Use only these numbers/.test(x)) && pkt.rules.some((x) => /cause/.test(x)));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio process — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
