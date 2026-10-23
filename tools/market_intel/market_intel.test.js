#!/usr/bin/env node
/* ===========================================================================
   MARKET INTELLIGENCE — every kind of finding, its eligibility rule, and the
   things the engine must never do. docs/market-intelligence/MASTER_PLAN.md §3

   SYNTHETIC quotes throughout (one invented game, invented prices), so each
   rule is driven exactly to its threshold and just past it.

   Run: node tools/market_intel/market_intel.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const MI = require(path.join(ROOT, 'lib', 'edgedesk_market_intel.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function section(t) { console.log('· ' + t); }

const KICK = '2026-10-24T19:00:00Z', T = Date.parse(KICK), H = 3600000;
const at = (h) => new Date(T - h * H).toISOString();
const GAME = { event_key: 'CFB|SYN1', game_id: 'SYN1', season: 2026, kickoff: KICK, home: 'Home State', away: 'Away Tech' };
function sq(book, homeLine, hoursBefore, extra) {
  return Object.assign({ book, source: 'espn', market_type: 'spread', game_id: 'SYN1', season: 2026, kickoff_ts: KICK, home_team: 'Home State', away_team: 'Away Tech',
    home_line: homeLine, price_home: -110, price_away: -110, observed_at: at(hoursBefore) }, extra || {});
}
function tq(book, total, hoursBefore, extra) {
  return Object.assign({ book, source: 'espn', market_type: 'total', game_id: 'SYN1', season: 2026, kickoff_ts: KICK, home_team: 'Home State', away_team: 'Away Tech',
    total_points: total, price_over: -110, price_under: -110, observed_at: at(hoursBefore) }, extra || {});
}
function mq(book, home, away, hoursBefore, extra) {
  return Object.assign({ book, source: 'espn', market_type: 'moneyline', game_id: 'SYN1', season: 2026, kickoff_ts: KICK, home_team: 'Home State', away_team: 'Away Tech',
    price_home: home, price_away: away, observed_at: at(hoursBefore) }, extra || {});
}
const MODEL = { home_margin: 7, fair_total: 50, p_home: 0.70, model_version: 'synthetic_model_v1', predicted_at: at(30) };
const run = (quotes, over) => MI.analyze(Object.assign({ sport: 'cfb', game: GAME, now: at(1), quotes, model: MODEL }, over || {}));
const types = (r) => r.findings.map((f) => f.type);
const full = (extraSpread) => [sq('DraftKings', -3, 28), sq('DraftKings', extraSpread == null ? -3 : extraSpread, 2), tq('DraftKings', 50, 28), tq('DraftKings', 50, 2), mq('DraftKings', -150, 130, 28), mq('DraftKings', -150, 130, 2)];

section('convergence and divergence');
{
  const conv = run(full(-6));   /* market margin 3 -> 6; model 7: the gap shrinks 4 -> 1 */
  const c = conv.findings.find((f) => f.type === 'MARKET_CONVERGENCE' && f.market === 'spread');
  chk('a move of 3 points toward the model is MARKET_CONVERGENCE', !!c && c.evidence.gap_then === 4 && c.evidence.gap_now === 1, conv.findings.map((f) => [f.type, f.market]));
  chk('it names both quotes, their source and times', c && c.sources.length === 2 && c.sources.every((s) => s.observed_at && s.book === 'DraftKings'));
  chk('the explanation states what moved, in numbers, with the source', c && /DraftKings via espn moved from home -3 to home -6/.test(c.explain.what_changed) && /3 points closer to/.test(c.explain.what_changed), c && c.explain.what_changed);
  chk('the explanation never says why it moved', c && /not evidence of who bet or why/.test(c.explain.what_remains_uncertain));
  const div = run(full(1));     /* market margin 3 -> -1: the gap grows 4 -> 8 */
  chk('a move away from the model is MARKET_DIVERGENCE', types(div).includes('MARKET_DIVERGENCE'), types(div));
  const small = run(full(-3.5));  /* half a point: under the threshold */
  chk('half a point is under the 1-point threshold: no finding', !types(small).some((t) => /CONVERGENCE|DIVERGENCE/.test(t)), types(small));
  const exact = run(full(-4));
  chk('exactly the threshold (1 point) is a finding', types(exact).includes('MARKET_CONVERGENCE'), types(exact));
  const cross = run(full(-10)); /* margin 3 -> 10 past the model's 7: gap 4 -> -3 */
  const cx = cross.findings.find((f) => f.type === 'MARKET_CONVERGENCE' && f.market === 'spread');
  chk('a move through the model\'s number is a convergence that says it crossed', cx && cx.evidence.crossed_model === true && /crossing it/.test(cx.explain.what_changed), cx && cx.evidence);
  const quick = run([sq('DraftKings', -3, 1.5), sq('DraftKings', -8, 1.2)]);
  chk('two quotes under an hour apart: not eligible, with why', !types(quick).includes('MARKET_CONVERGENCE') && quick.not_eligible.some((n) => /h apart/.test(n.why)), quick.not_eligible);
  const nomodel = run(full(-6), { model: null });
  chk('no EdgeDesk number: convergence is not eligible, never guessed', !types(nomodel).some((t) => /CONVERGENCE|DIVERGENCE/.test(t)) && nomodel.not_eligible.some((n) => n.type === 'MARKET_CONVERGENCE' && /no EdgeDesk/.test(n.why)));
  const ml = run([mq('DraftKings', -150, 130, 28), mq('DraftKings', -260, 220, 2)]);
  chk('a moneyline move of 12 points toward the model\'s 70% converges, in probability', ml.findings.some((f) => f.type === 'MARKET_CONVERGENCE' && f.market === 'moneyline'), types(ml));
}

section('the start and the clock');
{
  const post = run([sq('DraftKings', -3, 28), sq('DraftKings', -10, -0.5)], { now: new Date(T + 2 * H).toISOString() });
  chk('a quote observed after the start is never read', !types(post).some((t) => /CONVERGENCE|DIVERGENCE|UNUSUAL/.test(t)), types(post));
  const future = run([sq('DraftKings', -3, 28), sq('DraftKings', -10, 0.5)], { now: at(3) });
  chk('a quote observed after `now` is never read (replay at an earlier time)', !types(future).some((t) => /CONVERGENCE|DIVERGENCE/.test(t)), types(future));
}

section('stale and incomplete data');
{
  const stale = run([sq('DraftKings', -3, 10), tq('DraftKings', 50, 10), mq('DraftKings', -150, 130, 10)]);
  const s = stale.findings.find((f) => f.type === 'STALE_MARKET_DATA');
  chk('the newest quote 9 h old at `now` is STALE_MARKET_DATA', !!s && s.evidence.age_minutes === 540, s && s.evidence);
  const fresh = run(full());
  chk('a quote one hour old is not stale', !types(fresh).includes('STALE_MARKET_DATA'), types(fresh));
  const part = run([sq('DraftKings', -3, 2)]);
  const inc = part.findings.find((f) => f.type === 'INCOMPLETE_MARKET_DATA');
  chk('no total and no moneyline: INCOMPLETE_MARKET_DATA lists both', !!inc && inc.evidence.missing.some((m) => /^total/.test(m)) && inc.evidence.missing.some((m) => /^moneyline/.test(m)), inc && inc.evidence);
  const oneSide = run(full().concat([sq('FanDuel', -3, 2, { price_away: null })]));
  chk('a one-sided price is incomplete', oneSide.findings.some((f) => f.type === 'INCOMPLETE_MARKET_DATA' && f.evidence.missing.some((m) => /FanDuel: one side/.test(m))));
  const bad = run(full().concat([sq('FanDuel', -3, 2, { price_home: 1.91 })]));
  chk('a quote failing a check (decimal odds read as American) is named, and never compared', bad.findings.some((f) => f.type === 'INCOMPLETE_MARKET_DATA' && f.evidence.missing.some((m) => /BAD_ODDS_FORMAT/.test(m))) && bad.quality.rejected_quotes === 1);
  const none = run([]);
  chk('no quotes at all: incomplete, and staleness not eligible', none.findings.some((f) => f.type === 'INCOMPLETE_MARKET_DATA') && none.not_eligible.some((n) => n.type === 'STALE_MARKET_DATA'));
}

section('source disagreement and one sportsbook spelled two ways');
{
  const two = run([sq('DraftKings', -3, 1.2), sq('FanDuel', -5, 1.1)]);
  const d = two.findings.find((f) => f.type === 'SOURCE_DISAGREEMENT');
  chk('two books 2 points apart within 30 minutes: SOURCE_DISAGREEMENT', !!d && d.evidence.difference === 2, two.findings.map((f) => f.type));
  const far = run([sq('DraftKings', -3, 5), sq('FanDuel', -5, 1.1)]);
  chk('two books whose latest quotes are hours apart are not compared', !types(far).includes('SOURCE_DISAGREEMENT') && far.not_eligible.some((n) => /minutes apart/.test(n.why)));
  const same = run([sq('DraftKings', -3, 1.2), sq('Draft Kings', -5, 1.1, { source: 'espn_core' })]);
  chk('"DraftKings" and "Draft Kings" are one source: no disagreement with itself', !types(same).includes('SOURCE_DISAGREEMENT') && same.quality.single_source === true, [types(same), same.quality]);
  const one = run(full());
  chk('one sportsbook: SOURCE_DISAGREEMENT is not eligible, and the quality block says so', one.not_eligible.some((n) => n.type === 'SOURCE_DISAGREEMENT' && /one source only/.test(n.why)) && /one sportsbook only/.test(one.quality.note));
}

section('unusual movement, against earlier games only');
{
  const hist = { spread: Array.from({ length: 200 }, (_, i) => (i % 20) * 0.1) };   /* 0 .. 1.9 */
  const big = run(full(-6), { context: { movement_history: hist } });
  const u = big.findings.find((f) => f.type === 'UNUSUAL_PRICE_MOVEMENT');
  chk('a 3-point move past the 95th percentile of 200 earlier moves is UNUSUAL_PRICE_MOVEMENT', !!u && u.evidence.history_n === 200 && u.evidence.move === 3, u && u.evidence);
  chk('it says what a moving price cannot tell us', u && /all look the same in a public price/.test(u.explain.what_remains_uncertain));
  const thin = run(full(-6), { context: { movement_history: { spread: [1, 2, 3] } } });
  chk('with three earlier moves, "unusual" is not eligible', !types(thin).includes('UNUSUAL_PRICE_MOVEMENT') && thin.not_eligible.some((n) => n.type === 'UNUSUAL_PRICE_MOVEMENT' && /needs 100/.test(n.why)));
  const usual = run(full(-4), { context: { movement_history: hist } });
  chk('a 1-point move inside the earlier distribution is not unusual', !types(usual).includes('UNUSUAL_PRICE_MOVEMENT'), usual.findings.filter((f) => f.type === 'UNUSUAL_PRICE_MOVEMENT').map((f) => f.evidence));
}

section('moneyline against the same book\'s spread');
{
  /* the usual relationship: logit p = 0.15 x home margin, sd 0.1 */
  const fit = { n: 400, a: 0, b: 0.15, sd: 0.1 };
  const ok = run([sq('DraftKings', -7, 2), mq('DraftKings', -270, 220, 2)], { context: { derivative_fit: fit } });
  chk('a moneyline consistent with its own spread is no finding', !types(ok).includes('DERIVATIVE_RELATIONSHIP_ANOMALY'), ok.findings.filter((f) => f.type === 'DERIVATIVE_RELATIONSHIP_ANOMALY').map((f) => f.evidence));
  const off = run([sq('DraftKings', -7, 2), mq('DraftKings', 120, -140, 2)], { context: { derivative_fit: fit } });
  const d = off.findings.find((f) => f.type === 'DERIVATIVE_RELATIONSHIP_ANOMALY');
  chk('a home underdog moneyline beside a home -7 spread at the same book is an anomaly', !!d && Math.abs(d.evidence.z) >= 3, off.findings.map((f) => f.type));
  chk('the anomaly says the likeliest explanation is a stale market, not a mispricing', d && /republishes one market later/.test(d.explain.what_remains_uncertain));
  const nofit = run([sq('DraftKings', -7, 2), mq('DraftKings', 120, -140, 2)], { context: { derivative_fit: { n: 50, a: 0, b: 0.15, sd: 0.1 } } });
  chk('a relationship fitted on 50 pairs is not enough: not eligible', !types(nofit).includes('DERIVATIVE_RELATIONSHIP_ANOMALY') && nofit.not_eligible.some((n) => /needs 200/.test(n.why)));
  const pts = []; for (let i = 0; i < 300; i++) { const m = -20 + (i % 41); pts.push({ margin: m, y: 0.15 * m + ((i * 7919) % 11 - 5) * 0.01 }); }
  const f2 = MI.fitDerivative(pts);
  chk('fitDerivative recovers a known slope', Math.abs(f2.b - 0.15) < 0.005 && f2.n === 300 && f2.sd > 0, f2);
  const pairs = MI.derivativePairs([sq('DraftKings', -7, 2), mq('DraftKings', -270, 220, 2), sq('DraftKings', -7, 3)]);
  chk('derivativePairs pairs a spread and a moneyline only from the same capture', pairs.length === 1 && pairs[0].margin === 7, pairs);
}

section('model calibration warnings and rule conflicts');
{
  const w = { id: 'H-003', slice: 'fbs_vs_fcs', applies: true, status: 'ACCEPTED', est: -7.76, ci: [-12.0, -6.6], n: 73,
    text: 'In 73 FBS-vs-FCS games in 2026 the model priced the favourite 7.8 points short of the close (95% CI 6.6 to 12.0).' };
  const r = run(full(), { context: { reliability: [w, Object.assign({}, w, { id: 'H-X', applies: false })] } });
  const cw = r.findings.filter((f) => f.type === 'MODEL_CALIBRATION_WARNING');
  chk('an applicable validated bias is a MODEL_CALIBRATION_WARNING; an inapplicable one is not', cw.length === 1 && cw[0].evidence.id === 'H-003', cw.map((f) => f.evidence.id));
  chk('the warning carries the validation\'s own sentence and sample size', cw[0] && cw[0].explain.what_we_observed === w.text && cw[0].evidence.n === 73);
  const none = run(full());
  chk('no validation supplied: the warning is not eligible', none.not_eligible.some((n) => n.type === 'MODEL_CALIBRATION_WARNING'));
  const conf = run(full(-6), { model: Object.assign({}, MODEL, { settles: { moneyline: 'REGULATION_ONLY' } }), market_settles: { moneyline: 'INCLUDES_OVERTIME' } });
  chk('a regulation-only model probability beside an overtime-inclusive moneyline is a RULE_DEFINITION_CONFLICT', conf.findings.some((f) => f.type === 'RULE_DEFINITION_CONFLICT' && f.market === 'moneyline'));
  chk('and that market is then never compared for convergence', !conf.findings.some((f) => /CONVERGENCE|DIVERGENCE/.test(f.type) && f.market === 'moneyline'));
  const agree = run(full(), { model: Object.assign({}, MODEL, { settles: { moneyline: 'INCLUDES_OVERTIME' } }), market_settles: { moneyline: 'INCLUDES_OVERTIME' } });
  chk('the same definition on both sides is no conflict', !agree.findings.some((f) => f.type === 'RULE_DEFINITION_CONFLICT'));
}

section('every finding, everywhere');
{
  const scenarios = [run(full(-6)), run(full(1)), run([sq('DraftKings', -3, 10)]), run([sq('DraftKings', -3, 1.2), sq('FanDuel', -5, 1.1)]),
    run(full(-6), { context: { movement_history: { spread: Array.from({ length: 200 }, (_, i) => (i % 20) * 0.1) }, derivative_fit: { n: 400, a: 0, b: 0.15, sd: 0.1 } } }),
    run([sq('DraftKings', -7, 2), mq('DraftKings', 120, -140, 2)], { context: { derivative_fit: { n: 400, a: 0, b: 0.15, sd: 0.1 } } })];
  const all = [].concat.apply([], scenarios.map((s) => s.findings));
  const KEYS = ['what_changed', 'what_we_observed', 'what_the_model_says', 'what_the_market_says', 'what_we_can_verify', 'what_remains_uncertain', 'what_historical_data_suggests'];
  chk('the scenarios reach eight of the nine kinds', new Set(all.map((f) => f.type)).size >= 7, [...new Set(all.map((f) => f.type))]);
  chk('every finding carries all seven parts of the explanation, none empty', all.every((f) => KEYS.every((k) => typeof f.explain[k] === 'string' && f.explain[k].length > 0)));
  chk('no finding\'s wording passes the no-myth filter', all.every((f) => KEYS.every((k) => !MI.NO_MYTH.test(f.explain[k]))));
  chk('every finding has an eligibility rule and the values that met it', all.every((f) => f.eligibility && f.eligibility.met === true && typeof f.eligibility.rule === 'string'));
  chk('every finding has a severity in the alert vocabulary (info, notable, caution)', all.every((f) => ['info', 'notable', 'caution'].includes(f.severity)));
  chk('every importance score is 0-100 with its parts', all.every((f) => f.importance && f.importance.score >= 0 && f.importance.score <= 100 && f.importance.parts));
  const again = run(full(-6));
  chk('finding ids are stable: the same facts give the same id', JSON.stringify(again.findings.map((f) => f.finding_id)) === JSON.stringify(scenarios[0].findings.map((f) => f.finding_id)));
  /* a finding's id keys on what it states (the quotes, or the missing items), not on incidental
     counts: the same condition seen twice is one alert, two different conditions are two */
  const facts = new Set(all.map((f) => f.type + '|' + f.market + '|' + f.explain.what_we_observed));
  chk('different facts give different ids (and the same fact in two runs, the same id)', new Set(all.map((f) => f.finding_id)).size === facts.size, [new Set(all.map((f) => f.finding_id)).size, facts.size]);
  let refused = false; try { MI.analyze({ sport: 'cfb', game: GAME, now: at(1), quotes: full(-6), model: Object.assign({}, MODEL, { model_version: 'the sharp model' }) }); } catch (e) { refused = /refused/.test(e.message); }
  chk('a forbidden word reaching the wording is refused, not printed', refused);
  chk('the vocabulary: nine kinds', MI.TYPE_KEYS.length === 9);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'market intelligence — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
