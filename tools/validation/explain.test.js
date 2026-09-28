#!/usr/bin/env node
/* ============================================================================
   EXPLAIN — the decision, said plainly, from the decision itself.

     node tools/validation/explain.test.js

   one-line answers for every reason code (and the spec's own examples) ·
   WHY NOT? · WHAT CHANGES MY MIND? · explicit gates · the main risk ·
   reliability components (never invented) · break-the-number against
   MEASURED uncertainty · scenarios · provenance · the watchlist row ·
   alerts on meaningful changes only · every committed decision explains
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_explain.js'));
const I = require(path.join(ROOT, 'lib', 'edgedesk_decision_inputs.js'));
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }
const BAD = /undefined|NaN|\bnull\b|\[object/;

const NOW = Date.parse('2026-10-04T12:00:00Z'), FRESH = '2026-10-04T11:50:00Z', KICK = '2026-10-04T17:00:00Z';
const qq = (side, line, am, book, extra) => Object.assign({ game_id: 'g', side, line, american: am, book: book || 'DraftKings', captured_at: FRESH, fresh: true, n_books: 1 }, extra || {});
function nflModel(fair) { return { sport: 'NFL', available: true, model_version: 'edgedesk_football_v1.0.0', fair_home_margin: fair, home_cover: (t) => E.dist.coverProbSpread('nfl', fair, t), tail: { validated_within_pts: 0 }, adjusted: { available: false } }; }
const board = (hl) => [qq('home', hl, -110), qq('away', -hl, -110), qq('home', hl, -112, 'FanDuel'), qq('away', -hl, -108, 'FanDuel')];
function decide(fair, quotes, extra) {
  return D.decide(Object.assign({ sport: 'NFL', game: { game_id: 'g', home: 'Miami Dolphins', away: 'Buffalo Bills', kickoff: KICK }, model: nflModel(fair), quotes, now: NOW,
    qb: { known: true }, availability: { known: true }, reliability: { score: 85 }, confidence: { score: 80 }, projection: { stability: 'STABLE' } }, extra || {}));
}
const CONTEXT = { reliability: { score: 88, grade: 'STRONG', main_deduction: 'the projected spread moves ±2.51 pts (1 SD) across 64 perturbation scenarios', components: [{ key: 'team_data', label: 'Team data', value: 95, unit: '%' }, { key: 'qb', label: 'QB', value: 'EXPECTED' }, { key: 'availability', label: 'Availability', value: 60, unit: '%' }], next_actions: [{ action: 'Confirm the starting QB', gain: 'up to +1' }] },
  sensitivity_drivers: [{ key: 'rating_home', label: 'Miami Dolphins rating', sd: 1.7 }, { key: 'rating_away', label: 'Buffalo Bills rating', sd: 1.1 }, { key: 'hfa', label: 'Home field', sd: 0.3 }], joint_sd: 2.05, joint_basis: 'all measured dimensions jointly',
  provenance: [{ key: 'qb', what: 'Quarterback', source: 'nflverse', updated_at: '2026-10-04T11:50:00Z', pricing_impact: 'yes' }, { key: 'roster', what: 'Availability', source: 'official report', updated_at: '2026-10-04T10:00:00Z', pricing_impact: 'research only' }, { key: 'x', what: 'Player quality', source: 'EdgeDesk model', updated_at: null, pricing_impact: 'no' }] };

section('one line: the spec’s own examples, word for word');
{
  const bet = { decision: 'BET', action_reason_code: 'QUALIFIES', bet_price: { side: 'home', team: 'Miami', line: 10.5, odds: -105, book: 'DraftKings' }, probability_source: 'partially_calibrated', calibrated_ev_pct: 9.5, decision_ev_pct: 9.5, edge_pp: 4.9, market_type: 'spread' };
  chk('BET', X.oneLine(bet) === 'Miami +10.5 at -105 clears EdgeDesk’s current threshold with +9.5% calibrated EV.', X.oneLine(bet));
  const watch = { decision: 'WATCH', action_reason_code: 'NEAR_THRESHOLD', reference_quote: { side: 'away', team: 'Iowa', line: 13.5, odds: -110 }, bet_trigger: { line_needed: 14, line_move_pts: 0.5, short: 'Iowa +14 (-110) or better' }, market_type: 'spread' };
  chk('WATCH', X.oneLine(watch) === 'Iowa +13.5 is close, but EdgeDesk wants +14 or a better price.', X.oneLine(watch));
  const pass0 = { decision: 'PASS', action_reason_code: 'CALIBRATED_EV_NEGATIVE', reference_quote: { side: 'home', team: 'Cleveland', line: 3, odds: -110 }, market_type: 'spread' };
  chk('PASS', X.oneLine(pass0) === 'The model likes Cleveland more than the market, but calibration removes the apparent edge.', X.oneLine(pass0));
  chk('NO DECISION', X.oneLine({ decision: 'NO_DECISION', action_reason_code: 'STALE_QUOTE' }) === 'No current market quote is reliable enough to price.');
  const me = Object.assign({}, bet, { probability_source: 'model_estimated', calibrated_ev_pct: null, decision_ev_pct: 7.2 });
  chk('a model-estimated BET never calls its EV calibrated', /\+7\.2% EV \(model-estimated\)\.$/.test(X.oneLine(me)) && !/calibrated EV/.test(X.oneLine(me)), X.oneLine(me));
}
section('one line: every reason code the engine can emit says something true');
{
  let n = 0, bad = [];
  Object.keys(D.REASONS).forEach((code) => {
    const cls = D.REASONS[code][0];
    const q = { side: 'away', team: 'Iowa', line: 13.5, odds: -110, book: 'FanDuel', label: 'Iowa +13.5 (-110)' };
    const d = { decision: cls, action_reason_code: code, action_reason_text: D.reasonText(code), market_type: 'spread', edge_pp: 2.4, decision_ev_pct: 3.1, calibrated_ev_pct: 3.1, probability_source: 'partially_calibrated',
      bet_price: cls === 'BET' ? q : null, reference_quote: cls === 'BET' ? null : q, canonical: { gap_pts: 3.5 }, caps: [{ code: code, max: cls, text: D.reasonText(code) }], bet_trigger: { line_needed: 14, line_move_pts: 0.5 },
      model_fair_text: 'Iowa +11', consensus_text: 'Iowa +13.5', blockers: cls === 'NO_DECISION' ? [{ code: code, text: D.reasonText(code) }] : [], evaluation_status: cls === 'NO_DECISION' ? 'NOT_EVALUABLE' : 'EVALUABLE' };
    const s = X.oneLine(d);
    n++;
    if (!s || BAD.test(s) || !/[.!]$/.test(s)) bad.push([code, s]);
    if ((cls === 'BET' || cls === 'LEAN') && !/Iowa \+13\.5/.test(s)) bad.push([code, 'no selection', s]);
    const w = X.whyNot(d);
    if (!w || !w.headline || BAD.test(w.headline)) bad.push([code, 'why-not', w && w.headline]);
  });
  chk('all ' + n + ' reason codes: a clean sentence and a why-not headline', bad.length === 0, bad.slice(0, 5));
}
section('WHY NOT? — deterministic, from the gates');
{
  const c = (x) => X.whyNot(x).headline;
  chk('PASS because calibrated EV too low', /^PASS because calibration removes the raw edge \(calibrated EV too low\)$/.test(c({ decision: 'PASS', action_reason_code: 'CALIBRATED_EV_NEGATIVE', caps: [] })));
  chk('WATCH because the price is 0.5 pts short', c({ decision: 'WATCH', action_reason_code: 'NEAR_THRESHOLD', bet_trigger: { line_move_pts: 0.5 }, caps: [] }) === 'WATCH because the price is 0.5 pts short');
  chk('NO DECISION because no fresh market', c({ decision: 'NO_DECISION', action_reason_code: 'STALE_QUOTE', blockers: [] }) === 'NO DECISION because no fresh market');
  chk('LEAN because the edge is positive but under the threshold', c({ decision: 'LEAN', action_reason_code: 'LEAN_EDGE', caps: [] }) === 'LEAN because the edge is positive but under the betting threshold');
  /* a real engine decision: one off-market book */
  const ag = [qq('home', -10, -110), qq('away', 10, -110), qq('home', -10, -110, 'FanDuel'), qq('away', 10, -110, 'FanDuel'), qq('home', -10, -110, 'BetMGM'), qq('away', 10, -110, 'BetMGM'), qq('home', -6.5, -110, 'Caesars'), qq('away', 6.5, -110, 'Caesars')];
  const mf = decide(12, ag);
  const w = X.whyNot(mf);
  chk('MARKET FAULT because the quote is inconsistent with consensus (real engine decision)', w.headline === 'MARKET FAULT because the quote is inconsistent with the consensus' && w.reasons.some((r) => r.code === 'QUOTE_OUTLIER'), w);
  const bet = decide(-8, board(10));
  const wb = X.whyNot(bet);
  chk('a BET answers what caps its stake', bet.decision === 'BET' && /^BET/.test(wb.headline) && wb.reasons.some((r) => r.code === 'SIZE_CAPPED' && /MODEL-ESTIMATED probability cap/.test(r.text)), wb);
}
section('gates: explicit, and the binding one is marked');
{
  const bet = decide(-8, board(10));
  const G = X.gates(bet), by = (k) => G.filter((g) => g.key === k)[0];
  chk('evaluable, market verified, fresh, price passes', by('EVALUABLE').status === 'PASS' && by('MARKET_VERIFIED').status === 'PASS' && by('QUOTE_FRESH').status === 'PASS' && by('PRICE').status === 'PASS', G);
  chk('a model-estimated probability caps the stake at 0.25U', by('PROBABILITY_SOURCE').status === 'CAP' && by('PROBABILITY_SOURCE').effect === 'stake ≤ 0.25U');
  chk('confidence and reliability say they are not win probabilities', /not a win probability/.test(by('RELIABILITY').text) && /not a win probability/.test(by('DECISION_CONFIDENCE').text));
  const qb = decide(-8, board(10), { qb: { known: true, unresolved_critical: true, detail: 'contested' } });
  const Gq = X.gates(qb);
  chk('a QB cap binds as the QB gate', qb.decision === 'WATCH' && Gq.filter((g) => g.binding).map((g) => g.key).join() === 'QB', Gq.filter((g) => g.binding));
  const nd = X.gates({ decision: 'NO_DECISION', evaluation_status: 'NOT_EVALUABLE', action_reason_text: 'x' });
  chk('a NO DECISION stops at the first gate', nd.length === 1 && nd[0].status === 'BLOCK' && nd[0].binding);
}
section('WHAT CHANGES MY MIND?');
{
  const bet = decide(-8, board(10));
  const W = X.whatChanges(bet);
  chk('five answers: price, QB, availability, model, market', ['price', 'qb', 'availability', 'model', 'market'].every((k) => W[k] && typeof W[k].text === 'string' && !BAD.test(W[k].text)), W);
  chk('a BET says where it stops', /^Stops being a BET/.test(W.price.text), W.price);
  const watch = decide(-14, board(10));
  const Ww = X.whatChanges(watch);
  chk('a non-BET says where it starts (from the ladder)', watch.decision !== 'BET' ? /^Becomes BET at|No nearby price|already clears/.test(Ww.price.text) : true, [watch.decision_display, Ww.price]);
  const qb = decide(-8, board(10), { qb: { known: true, unresolved_critical: true } });
  chk('a QB cap: confirming the starter would change it', X.whatChanges(qb).qb.would_change === true && /lifts the WATCH cap, and the price already qualifies/.test(X.whatChanges(qb).qb.text), X.whatChanges(qb).qb);
}
section('the main risk: one, in priority order');
{
  chk('an open anomaly outranks everything', X.mainRisk({ decision: 'WATCH', anomaly: { open: true }, market: { anomaly: { text: 'PRICE ANOMALY — X' } }, caps: [{ code: 'QB_UNRESOLVED', text: 'qb' }] }).code === 'PRICE_UNVERIFIED');
  chk('then the quarterback', X.mainRisk({ decision: 'WATCH', caps: [{ code: 'QB_UNRESOLVED', text: 'The starting quarterback is unresolved.' }], warnings: [] }).code === 'QB');
  chk('a model-estimated BET names the missing calibration', X.mainRisk(decide(-8, board(10))).code === 'MODEL_ESTIMATED');
  chk('with nothing else, the unvalidated rules', X.mainRisk({ decision: 'BET', probability_source: 'calibrated', market: { freshness: 'FRESH', verification_status: 'VERIFIED' }, market_quality: 'VERIFIED', reliability_score: 90, warnings: [], caps: [] }).code === 'RULES_UNVALIDATED');
}
section('reliability breakdown: measured components only');
{
  const d = decide(-8, board(10), { context: CONTEXT });
  const R = X.reliabilityBreakdown(d);
  chk('the headline and the measured components', R.available && R.headline === 'RELIABILITY 88 · STRONG' && R.components.map((c) => c.text).join(' | ') === 'Team data 95% | QB EXPECTED | Availability 60%', R);
  chk('… with the main deduction and the note', /perturbation/.test(R.main_deduction) && /not a win probability/.test(R.note));
  const none = X.reliabilityBreakdown(decide(-8, board(10)));
  chk('no components published: it says so, invents none', none.available === false && /not published/.test(none.text) && !none.components, none);
}
section('break the number: against measured uncertainty');
{
  const d = decide(-8, board(10), { context: CONTEXT });
  const S = X.sensitivity(d);
  chk('a cushion in points, with the drivers ranked by SD', S.available && S.edge_cushion_pts > 0 && S.drivers[0].label === 'Miami Dolphins rating' && S.drivers[0].sds_to_break > 0, S);
  chk('the joint SD is the terminal’s own', S.joint_sd === 2.05 && S.joint_basis === 'all measured dimensions jointly');
  chk('the verdict follows the cushion against 1.28 SD', S.verdict === (S.edge_cushion_pts >= 1.28 * 2.05 ? 'SURVIVES_CONSERVATIVE' : (S.edge_cushion_pts < 2.05 ? 'FRAGILE' : 'MODERATE')), [S.edge_cushion_pts, S.verdict]);
  chk('the assumption is printed', /distribution translates/.test(S.assumption));
  /* the break-the-number arithmetic on a hand-built curve: EV crosses zero between +9 and +9.5 */
  const curve = (evs) => ({ decision: 'BET', recommended_units: 0.25, bet_price: { side: 'home', team: 'Miami', line: 10, odds: -110 }, model_fair_line: 8.5, consensus_market_line: 10,
    price_curve: { market_type: 'spread', odds: -110, points: evs.map(([line, ev, cls]) => ({ line, odds: -110, ev, cls, units: cls === 'BET' ? 0.25 : 0, current: line === 10 })) }, context: CONTEXT });
  const thin = X.sensitivity(curve([[8, -0.05, 'PASS'], [8.5, -0.03, 'PASS'], [9, -0.01, 'PASS'], [9.5, 0.02, 'WATCH'], [10, 0.06, 'BET'], [10.5, 0.09, 'BET']]));
  chk('zero crossing interpolated: cushion 0.83 pts', Math.abs(thin.edge_cushion_pts - 0.83) < 0.01, thin.edge_cushion_pts);
  chk('a cushion under 1 SD of the measured inputs is FRAGILE, said plainly', thin.verdict === 'FRAGILE' && /disappears under plausible assumptions/.test(thin.text), thin.text);
  chk('the BET is lost after one half point here', thin.bet_cushion_pts === 0.5 && thin.bet_holds_to === 10, thin);
  chk('the largest driver needs under 1 SD to break it', thin.drivers[0].sds_to_break < 1, thin.drivers[0]);
  const wideC = X.sensitivity(curve([[6, -0.01, 'PASS'], [6.5, 0.01, 'WATCH'], [7, 0.03, 'LEAN'], [7.5, 0.05, 'BET'], [8, 0.06, 'BET'], [9, 0.07, 'BET'], [10, 0.09, 'BET']]));
  chk('a cushion past 1.28 SD survives conservative perturbations', wideC.verdict === 'SURVIVES_CONSERVATIVE' && /Even under conservative perturbations/.test(wideC.text) && wideC.edge_cushion_pts > 2.62, wideC);
  const un = X.sensitivity(decide(-8, board(10)));
  chk('no measured drivers: the cushion, and an honest “not measured”', un.available && un.verdict === 'UNMEASURED_INPUTS' && /No measured input uncertainty/.test(un.text), un);
  chk('NO DECISION has nothing to perturb', X.sensitivity({ decision: 'NO_DECISION' }).available === false);
  const near = X.sensitivity(decide(-10.5, board(10), { context: CONTEXT }));
  chk('less model disagreement, less cushion', near.edge_cushion_pts < S.edge_cushion_pts || (near.edge_cushion_floor && S.edge_cushion_floor), [near.edge_cushion_pts, S.edge_cushion_pts]);
  chk('a cushion at the edge of the curve says “at least”', !S.edge_cushion_floor || /at least/.test(S.text), S.text);
}
section('scenarios: base, conservative, aggressive');
{
  const d = decide(-8, board(10), { context: CONTEXT });
  const Sc = X.scenarios(d);
  const rk = (s) => ({ PASS: 0, WATCH: 1, LEAN: 2 }[s] != null ? { PASS: 0, WATCH: 1, LEAN: 2 }[s] : (/^BET/.test(s) ? 3 : -1));
  chk('three rows, each fair line one SD apart', Sc.available && Sc.rows.map((r) => r.key).join() === 'base,conservative,aggressive' && Math.abs(Sc.rows[1].fair_line - Sc.rows[0].fair_line - 2.05) < 0.051 && Math.abs(Sc.rows[0].fair_line - Sc.rows[2].fair_line - 2.05) < 0.051, Sc.rows);
  chk('conservative never reads stronger than base, aggressive never weaker', rk(Sc.rows[1].state_at_current_price) <= rk(Sc.rows[0].state_at_current_price) && rk(Sc.rows[2].state_at_current_price) >= rk(Sc.rows[0].state_at_current_price), Sc.rows);
  chk('the base scenario at the current price is the decision', /^BET/.test(Sc.rows[0].state_at_current_price) === (d.decision === 'BET'), [Sc.rows[0], d.decision]);
  chk('it says it is not a forecast', /not a forecast/.test(Sc.note));
  chk('no measured uncertainty: no scenarios', X.scenarios(decide(-8, board(10))).available === false);
}
section('provenance: source, updated, pricing impact');
{
  const d = decide(-8, board(10), { context: CONTEXT });
  const P = X.provenance(d, '2026-10-04T12:00:00Z');
  const qb = P.filter((p) => p.key === 'qb')[0], pq = P.filter((p) => p.key === 'x')[0], quote = P.filter((p) => p.key === 'quote')[0];
  chk('QB · nflverse · updated 10m ago · pricing impact yes', qb.source === 'nflverse' && qb.updated === '10m ago' && qb.pricing_impact === 'yes', qb);
  chk('no time published says so', pq.updated === 'time not published' && pq.pricing_impact === 'no');
  chk('the evaluated quote is on the list with its book and verification', quote && /DraftKings/.test(quote.source) && quote.confidence === 'VERIFIED', quote);
}
section('the watchlist row and meaningful alerts');
{
  const w = decide(-14, board(10)), b = decide(-8, board(10));
  const row = X.watchRow(b, { transitions: [{ from: 'WATCH', to: 'BET', label: 'WATCH → BET / PRICE IMPROVED', at: 'x', text: 't' }] });
  chk('a watch row: decision, last change, best price, trigger, kickoff, unresolved concern', row.display && row.last_change.label === 'WATCH → BET / PRICE IMPROVED' && /DraftKings/.test(row.best_price) && row.kickoff && row.unresolved && row.one_line, row);
  chk('the fixtures: WATCH at −14, BET at −8', w.decision === 'WATCH' && b.decision === 'BET', [w.decision_display, b.decision_display]);
  const a = X.alerts(w, b);
  chk('reaching the BET trigger alerts once, with the one-line answer', a.length >= 1 && a[0].kind === 'BET_TRIGGERED' && /clears EdgeDesk’s current threshold/.test(a[0].text), a);
  chk('the reverse alerts that the BET is invalid', X.alerts(b, w).some((x) => x.kind === 'BET_INVALID'));
  chk('the same state at a wiggling price is silence', X.alerts(b, decide(-8.1, board(10))).length === 0, X.alerts(b, decide(-8.1, board(10))));
  const km = X.alerts(decide(-8, board(2.5)), decide(-8, board(3.5)));
  chk('the market moving through 3 alerts', km.some((x) => x.kind === 'KEY_NUMBER'), km);
  chk('EdgeDesk’s number moving 1+ NFL pts alerts', X.alerts(decide(-8, board(10)), decide(-9.1, board(10))).some((x) => x.kind === 'FAIR_MOVED'));
  chk('a QB resolving alerts', X.alerts(decide(-8, board(10), { qb: { known: true, unresolved_critical: true } }), b).some((x) => x.kind === 'QB_CONFIRMED'));
  chk('reliability moving 10+ alerts; 5 does not', X.alerts(Object.assign({}, b, { reliability_score: 70 }), Object.assign({}, b, { reliability_score: 82 })).some((x) => x.kind === 'RELIABILITY') && !X.alerts(Object.assign({}, b, { reliability_score: 77 }), Object.assign({}, b, { reliability_score: 82 })).some((x) => x.kind === 'RELIABILITY'));
  const keys = X.alerts(w, b).map((x) => x.key);
  chk('every alert carries a dedupe key', keys.every((k) => typeof k === 'string' && k.length > 5) && new Set(keys).size === keys.length);
}
section('the measured context rides from the terminal into the decision');
{
  const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
  const o = Object.values(G.games).find((x) => x.sensitivity && x.sensitivity.available);
  const f = I.factsFromTerminal(o, null, null, null);
  chk('reliability components, drivers, the joint SD and provenance come from the terminal', f.context && f.context.reliability.components.length > 0 && f.context.sensitivity_drivers.length > 0 && f.context.joint_sd > 0 && f.context.provenance.length > 0, f.context);
  chk('drivers are the measured SDs, not the labels’ ± text', f.context.sensitivity_drivers.every((x) => x.sd > 0 && !/1 SD/.test(x.label)), f.context.sensitivity_drivers);
  const inp = I.inputFromFacts(f, {}, { now: NOW });
  chk('the facts carry it into the engine input, with the newest fact time', inp.context === f.context || JSON.stringify(inp.context) === JSON.stringify(f.context));
  chk('the NFL board says it publishes no drivers rather than inventing them', I.nflFacts({ ctx: { game: { game_id: 'x' } }, gid: 'x' }).context.sensitivity_drivers.length === 0);
}
section('every committed decision explains without a hole');
{
  const DJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.json'), 'utf8'));
  let bad = [];
  (DJ.decisions || []).forEach((d) => {
    try {
      const s = X.oneLine(d), w = X.whyNot(d), m = X.mainRisk(d), W = X.whatChanges(d), wr = X.watchRow(d, null);
      if (!s || BAD.test(s)) bad.push([d.game_id, 'one line', s]);
      if (!w.headline || BAD.test(w.headline)) bad.push([d.game_id, 'why not', w.headline]);
      if (!m || !m.text) bad.push([d.game_id, 'main risk']);
      if (!W.price || !W.price.text) bad.push([d.game_id, 'what changes']);
      if (!wr.display) bad.push([d.game_id, 'watch row']);
    } catch (e) { bad.push([d.game_id, String(e.message)]); }
  });
  chk('all ' + (DJ.decisions || []).length + ' committed decisions (v1 and v2 shapes) explain cleanly', bad.length === 0, bad.slice(0, 5));
}

console.log(fail ? 'FAILURES:\n  ' + failures.join('\n  ') : '');
console.log((fail ? 'FAIL' : 'ALL GREEN') + ' explain — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
