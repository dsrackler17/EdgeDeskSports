#!/usr/bin/env node
/* ============================================================================
   THE BETTOR DECISION LAYER — the rules.

     node tools/bettor/decision.test.js

   lib/edgedesk_decision.js (the engine), lib/edgedesk_decision_track.js
   (transitions, tracks, snapshots, CLV, performance), lib/edgedesk_bankroll.js
   (units → dollars, exposure), lib/edgedesk_decision_inputs.js (the facts
   adapter) and lib/edgedesk_decision_ui.js (the renderers), on synthetic
   games whose every probability comes from EDQuoteEV on a discretised normal
   margin model — and on the REAL committed slate.

   1  the hierarchy: integrity → market quality → price → calibrated advantage → sizing
   2  BET / LEAN / WATCH / PASS / NO DECISION (v2: NO DECISION only for essential data)
   3  sizing: 0.25 / 0.50 / 0.75 / 1.00 U, source caps, raw EV never sizes, no results
   4  playable-to: the corner clears, one step beyond does not (line and juice)
   5  transitions and tracks: price moved, price improved, new information
   6  anomalies, orientation, duplicates, cancellation, postponement
   7  bankroll, exposure, correlation, guardrails
   8  snapshots, CLV, the reader's entry, per-tier performance
   9  the real slate: facts adapter, build parity, the governance labels
   10 the renderers: four states, beginner mode, tooltips, no tout language
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const T = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_bankroll.js'));
const I = require(path.join(ROOT, 'lib', 'edgedesk_decision_inputs.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
void R;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }

/* ------------------------------------------------------------ the fixture */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
const COVER = {};
function normalCover(mu, sd) {
  const key = mu + '|' + sd; if (COVER[key]) return COVER[key];
  const pmf = {}; let tot = 0;
  for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
  Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
  COVER[key] = (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; };
  return COVER[key];
}
const NOW = Date.parse('2026-10-03T12:00:00Z'), FRESH = '2026-10-03T11:52:00Z', KICK = '2026-10-03T19:30:00Z';
/* home = Wake Forest, away = NC State; market Wake −6.5. raw: Wake by `fair`; calibrated: Wake by `cal` */
function model(fair, cal, extra) {
  const cc = normalCover(cal, 14);
  return Object.assign({ sport: 'CFB', available: true, model_version: 'test_v1', fair_home_margin: fair, home_cover: normalCover(fair, 14), tail: { validated_within_pts: 3 },
    adjusted: cal == null ? { available: false, reason: 'no validated calibration' } : { available: true, label: 'CALIBRATED', version: 'cal_test', maturity: 'SHADOW', side_prob: (s, l) => Q.sideProb(cc, s, l) } }, extra || {});
}
function q(side, line, am, extra) { return Object.assign({ game_id: 'g1', side, line, american: am, book: 'FanDuel', captured_at: FRESH, fresh: true, n_books: 1 }, extra || {}); }
function mainQuotes(awayLine, awayPrice, homePrice, book) { return [q('away', awayLine, awayPrice, { book: book || 'FanDuel' }), q('home', -awayLine, homePrice == null ? -118 : homePrice, { book: book || 'FanDuel' })]; }
function input(over) {
  const base = { now: NOW, sport: 'CFB', market_type: 'spread',
    game: { game_id: 'g1', home: 'Wake Forest', away: 'NC State', kickoff: KICK, mapping_ok: true, orientation_ok: true },
    model: model(4, 4.4), quotes: mainQuotes(6.5, -102),
    research: { status: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', gap_pts: 2.5, gap_toward_side: 'away', verification: 'NOT_REQUIRED' },
    integrity: { gates: [{ id: 'a', status: 'PASS' }, { id: 'b', status: 'PASS' }] },
    market: { consensus_home_line: -6.5, n_books_fresh: 2, dispersion: 0, movement_pts: 0.5 },
    reliability: { score: 79, grade: 'STRONG' }, confidence: { score: 70, label: 'HIGH' },
    projection: { stability: 'STABLE', uncertainty_score: 20 },
    qb: { known: true }, availability: { known: true }, support: { by_side: { away: 2, home: 0 } },
    anomaly: { current_season: true }, governance: { policy_status: 'SHADOW', policy_bet_enabled: false } };
  const o = JSON.parse(JSON.stringify(Object.assign({}, base, { model: null })));
  o.model = base.model;
  Object.keys(over || {}).forEach((k) => {
    const v = over[k];
    if (k === 'model' || k === 'quotes' || k === 'previous' || k === 'track' || k === 'evaluation') o[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object') o[k] = Object.assign({}, o[k], v);
    else o[k] = v;
  });
  return o;
}
const dec = (over, cfg) => D.decide(input(over), cfg);

/* ======================================================================== */
section('1-2. the decisions');
const bet = dec();
chk('a clear calibrated edge + strong gates = BET', bet.decision === 'BET' && bet.action_reason_code === 'QUALIFIES' && bet.evaluation_status === 'EVALUABLE', { d: bet.decision, c: bet.action_reason_code, caps: bet.caps });
chk('the BET names side, line, price and book', bet.side === 'NC State' && bet.selected_line === 6.5 && bet.selected_odds === -102 && bet.selected_book === 'FanDuel');
chk('the BET clears both thresholds on the decision probability (edge ≥ 4 pp, EV ≥ 5%) and keeps the raw EV beside it', bet.edge_pp >= 4 && bet.decision_ev_pct >= 5 && bet.calibrated_ev_pct === bet.decision_ev_pct && bet.raw_ev_pct > bet.calibrated_ev_pct, { edge: bet.edge_pp, cal: bet.calibrated_ev_pct, raw: bet.raw_ev_pct });
chk('the BET is sized, has a tier, a playable boundary and invalidation conditions', bet.recommended_units > 0 && !!bet.tier && !!bet.playable && bet.invalidation_conditions.length >= 6);
chk('the numbers are EDQuoteEV’s: the calibrated EV equals priceQuote on the same model',
  (() => { const o = Q.priceQuote(model(4, 4.4), q('away', 6.5, -102), { now: NOW, game: { game_id: 'g1' } }); return Math.abs(100 * o.adjusted.expected_value - bet.calibrated_ev_pct) < 0.01 && Math.abs(o.expected_value_pct - bet.raw_ev_pct) < 0.01; })());
chk('model fair, consensus and the fair text are oriented onto the side (Wake by 4 → NC State +4)', bet.model_fair_line === 4 && bet.consensus_market_line === 6.5 && /NC State \+4/.test(bet.model_fair_text), { f: bet.model_fair_line, c: bet.consensus_market_line, t: bet.model_fair_text });
chk('every decision is versioned and auditable', bet.decision_engine_version === D.VERSION && bet.config_version === D.CONFIG_VERSION && bet.model_version === 'test_v1' && bet.calibration_version === 'cal_test' && /^bd_/.test(bet.decision_id) && bet.pricing_model_version === Q.VERSION);
chk('the validation state is labelled, never implied', bet.validation_state === D.UNVALIDATED && bet.warnings.some((w) => w.code === 'RULES_UNVALIDATED') && bet.warnings.some((w) => w.code === 'CALIBRATION_PARTIAL'));
chk('deterministic: the same input decides the same way, with the same id', JSON.stringify(dec()) === JSON.stringify(bet));

const pass1 = dec({ model: model(4, 6.5) });
chk('positive raw EV + negative calibrated EV = PASS (the edge disappears after calibration)', pass1.decision === 'PASS' && pass1.action_reason_code === 'CALIBRATED_EV_NEGATIVE' && pass1.raw_ev_pct > 0 && pass1.calibrated_ev_pct < 0, { c: pass1.action_reason_code, raw: pass1.raw_ev_pct, cal: pass1.calibrated_ev_pct });
chk('a PASS carries no units, no playable range, and a bet trigger', pass1.recommended_units === 0 && pass1.playable === null && pass1.bet_trigger && /NC State becomes BET at NC State \+\d/.test(pass1.bet_trigger.text), pass1.bet_trigger);
chk('the PASS reference sits on the side the model leans', pass1.side === 'NC State' && pass1.reference_quote && pass1.reference_quote.line === 6.5);
const lean = dec({ model: model(4, 5.2) });
chk('a positive calibrated edge in the model’s direction, below the BET thresholds = LEAN (no stake)', lean.decision === 'LEAN' && lean.action_reason_code === 'LEAN_EDGE' && lean.recommended_units === 0 && lean.edge_pp >= 2 && lean.edge_pp < 4, { d: lean.decision, e: lean.edge_pp });
const noEdge = dec({ model: model(6.5, 6.5) });
chk('the model agrees with the market = PASS (market aligned)', noEdge.decision === 'PASS' && noEdge.action_reason_code === 'MARKET_ALIGNED', noEdge.action_reason_code);

const huge = dec({ model: model(-1, 2), market: { fault: true, fault_reason: 'one book, stale consensus' }, research: { status: 'MARKET_FAULT', gap_pts: 5.5 } });
chk('huge raw EV + market fault ≠ BET', huge.decision !== 'BET' && huge.raw_ev_pct > 30, { d: huge.decision, raw: huge.raw_ev_pct });
/* audit 2026-09-30 #8: past 25% raw EV on a main-line spread the decision is
   WATCH · IMPLAUSIBLE EV ("check data") first; the open price anomaly stays */
chk('…past the 25% implausible-EV bound it is WATCH · IMPLAUSIBLE EV, the price anomaly still open', huge.decision === 'WATCH' && huge.action_reason_code === 'IMPLAUSIBLE_EV' && (huge.caps || []).some((c) => c.code === 'PRICE_ANOMALY'), { d: huge.decision, c: huge.action_reason_code });
const faultPx = dec({ model: model(2.5, 3.5), market: { fault: true, fault_reason: 'one book, stale consensus' }, research: { status: 'MARKET_FAULT', gap_pts: 4 } });
chk('…under the bound, an attractive price on a market fault is WATCH · PRICE ANOMALY until the market re-verifies', faultPx.decision === 'WATCH' && faultPx.action_reason_code === 'PRICE_ANOMALY' && faultPx.waiting_on.length === 1 && faultPx.raw_ev_pct < 25, { d: faultPx.decision, c: faultPx.action_reason_code, w: faultPx.waiting_on, raw: faultPx.raw_ev_pct });
const faultQuiet = dec({ model: model(6.5, 6.5), market: { fault: true }, research: { status: 'MARKET_FAULT', gap_pts: 0.2 } });
chk('a market fault with no priced opportunity is PASS — the wager is still evaluable', faultQuiet.decision === 'PASS' && faultQuiet.evaluation_status === 'EVALUABLE');
const inv = dec({ model: model(2.5, 3.5), research: { status: 'INVESTIGATE', gap_pts: 4, verification: 'INCOMPLETE', verification_items: ['1 book behind the consensus'] } });
chk('an unverified gap on an attractive price = WATCH · PRICE ANOMALY', inv.decision === 'WATCH' && inv.action_reason_code === 'PRICE_ANOMALY' && inv.anomaly.checks.some((c) => c.code === 'GAP_VERIFIED' && c.status === 'FAIL'), { d: inv.decision, c: inv.action_reason_code });
const invBig = dec({ model: model(-6, 1), research: { status: 'INVESTIGATE', gap_pts: 12.5, verification: 'INCOMPLETE', verification_items: ['1 book behind the consensus'] } });
chk('huge gap + unverified market (+61% raw EV) = WATCH · IMPLAUSIBLE EV, the gap check still failed', invBig.decision === 'WATCH' && invBig.action_reason_code === 'IMPLAUSIBLE_EV' && invBig.anomaly.checks.some((c) => c.code === 'GAP_VERIFIED' && c.status === 'FAIL'), { d: invBig.decision, c: invBig.action_reason_code });
chk('WATCH never carries units', inv.recommended_units === 0 && huge.recommended_units === 0 && invBig.recommended_units === 0);
chk('WATCH says what EdgeDesk is waiting on and when it re-checks', inv.waiting_on.length > 0 && /re-evaluates/.test(inv.next_check) && /verification/.test(inv.watch.trigger));

const oneSided = dec({ quotes: [q('away', 6.5, -102)] });
chk('no two-sided market = LEAN · THIN MARKET (evaluated, never bet)', oneSided.decision === 'LEAN' && oneSided.action_reason_code === 'THIN_MARKET' && oneSided.recommended_units === 0, oneSided.action_reason_code);
const stale = dec({ quotes: mainQuotes(6.5, -102).map((x) => Object.assign(x, { fresh: false, captured_at: '2026-10-03T06:00:00Z' })) });
chk('stale quote = NO DECISION (a genuine blocker)', stale.decision === 'NO_DECISION' && stale.action_reason_code === 'STALE_QUOTE' && stale.blocker_codes[0] === 'STALE_QUOTE', stale.action_reason_code);
const staleAfterBet = dec({ quotes: mainQuotes(6.5, -102).map((x) => Object.assign(x, { fresh: false, captured_at: '2026-10-03T06:00:00Z' })), previous: bet });
chk('a BET whose quote goes stale is NO DECISION (never a silent BET), naming the earlier price', staleAfterBet.decision === 'NO_DECISION' && staleAfterBet.action_reason_code === 'STALE_QUOTE' && /earlier BET at \+6\.5 \(-102\)/.test(staleAfterBet.action_reason_text));
const nomkt = dec({ quotes: [] });
chk('no market = NO DECISION', nomkt.decision === 'NO_DECISION' && nomkt.action_reason_code === 'NO_MARKET');
const nocal = dec({ model: model(4, null) });
chk('missing calibration no longer blocks: MODEL-ESTIMATED decision on the raw probability', nocal.decision !== 'NO_DECISION' && nocal.probability_source === 'model_estimated' && nocal.evaluation_status === 'EVALUABLE', { d: nocal.decision, c: nocal.action_reason_code });
chk('…a model-estimated BET is capped at 0.25U and says so', nocal.decision !== 'BET' || (nocal.recommended_units === 0.25 && /MODEL-ESTIMATED/.test(nocal.decision_display)));
const nfl = D.decide(Object.assign(input({ model: model(4, null, { sport: 'NFL' }) }), { sport: 'NFL' }));
chk('the NFL decides through the same engine (no NFL NO DECISION for want of calibration)', nfl.decision !== 'NO_DECISION' && nfl.market_key === 'NFL:spread' && nfl.league === 'NFL', { d: nfl.decision, c: nfl.action_reason_code });
const lowRel = dec({ reliability: { score: 55 } });
chk('low reliability caps the class at LEAN', lowRel.decision === 'LEAN' && lowRel.action_reason_code === 'LOW_RELIABILITY');
const noRel = dec({ reliability: { score: null } });
chk('unmeasured reliability lowers confidence, never NO DECISION', noRel.decision !== 'NO_DECISION' && noRel.decision_confidence < bet.decision_confidence && noRel.warnings.some((w) => w.code === 'RELIABILITY_UNMEASURED'));
const unstable = dec({ projection: { stability: 'UNSTABLE' } });
chk('an unstable projection caps at LEAN', unstable.decision === 'LEAN' && unstable.action_reason_code === 'UNSTABLE_PROJECTION');
const lowConf = dec({ confidence: { score: 20 } });
chk('football confidence under the floor caps at LEAN, never NO DECISION', lowConf.decision === 'LEAN' && lowConf.action_reason_code === 'LOW_MODEL_CONFIDENCE');
const dataFault = dec({ integrity: { data_fault: true, data_fault_reason: 'inverted spread' } });
chk('a DATA FAULT is still a hard blocker (NO DECISION)', dataFault.decision === 'NO_DECISION' && dataFault.action_reason_code === 'DATA_FAULT');
const guardFault = dec({ model: model(-20, -18), integrity: { data_fault: true, data_fault_kind: 'GUARD', data_fault_reason: 'gap past the 21-point guard' }, research: { status: 'DATA_FAULT', gap_pts: 26.5 } });
chk('…but a gap-guard “fault” is a suspicion: WATCH with the price anomaly open (named IMPLAUSIBLE EV at a 26-pt gap), never NO DECISION', guardFault.decision === 'WATCH' && guardFault.action_reason_code === 'IMPLAUSIBLE_EV' && (guardFault.caps || []).some((c) => c.code === 'PRICE_ANOMALY'), { d: guardFault.decision, c: guardFault.action_reason_code });
const verified = dec({ model: model(4, 6.5), research: { status: 'VERIFIED_MAJOR', gap_pts: 7.5, verification: 'PASSED' } });
chk('VERIFIED MAJOR DISAGREEMENT never implies BET', verified.decision !== 'BET', verified.decision);
const worth = dec({ model: model(4, 6.5), research: { status: 'WORTH_RESEARCHING', gap_pts: 5 } });
chk('WORTH RESEARCHING never implies BET', worth.decision === 'PASS');
const totals = D.decide(Object.assign(input(), { market_type: 'total' }));
chk('a total with no totals quote is NO DECISION for the total only', totals.decision === 'NO_DECISION' && totals.market_key === 'CFB:total' && ['NO_MARKET', 'DISTRIBUTION_MISSING'].indexOf(totals.action_reason_code) >= 0);
const gov = dec({}, { markets: { 'CFB:spread': { supported: true, bet_authority: 'GOVERNED_POLICY', max_class: 'BET' } } });
chk('with BET authority held by a governed policy that has not enabled betting, the price clears but it is a LEAN', gov.decision === 'LEAN' && gov.action_reason_code === 'BET_AUTHORITY_DISABLED');
const govOn = D.decide(input({ governance: { policy_bet_enabled: true } }), { markets: { 'CFB:spread': { supported: true, bet_authority: 'GOVERNED_POLICY', max_class: 'BET' } } });
chk('…and BET once that policy enables it', govOn.decision === 'BET');

/* ======================================================================== */
section('3. sizing');
chk('0.50U: a clear edge, a partially calibrated probability (the 0.50U source cap)', bet.recommended_units === 0.5 && bet.probability_source === 'partially_calibrated', { u: bet.recommended_units, t: bet.sizing && bet.sizing.tiers });
const s25b = dec({ market: { n_books_fresh: 1 } });
chk('one fresh book (ACCEPTABLE market) caps the stake at 0.50U', s25b.decision === 'BET' && s25b.recommended_units <= 0.5 && s25b.market_quality === 'ACCEPTABLE', { u: s25b.recommended_units, mq: s25b.market_quality });
const s25c = dec({ anomaly: { rating_divergence_band: 'LARGE' } });
chk('a material warning (large rating divergence) caps at 0.25U', s25c.decision === 'BET' && s25c.recommended_units === 0.25 && s25c.tier === 'SMALL', { u: s25c.recommended_units });
const valIn = { model: model(3.5, 2.5, { adjusted: null }), reliability: { score: 90 }, confidence: { score: 88 }, projection: { stability: 'VERY_STABLE', uncertainty_score: 10 }, support: { by_side: { away: 3 } } };
const s75 = dec(Object.assign({}, valIn, { model: model(3.5, 2.5) }), { });
const validated = (m) => Object.assign({}, m, { adjusted: Object.assign({}, m.adjusted, { maturity: 'VALIDATED' }) });
const s100 = dec(Object.assign({}, valIn, { model: validated(model(3.4, 3.4)), market: { n_books_fresh: 3 } }));
chk('a live-validated calibration can size above 0.50U; the strongest tiers need edge ≥ 7 pp and EV ≥ 10%', s100.decision === 'BET' && s100.probability_source === 'calibrated' && s100.recommended_units >= 0.75 && s100.edge_pp >= 7, { u: s100.recommended_units, e: s100.edge_pp, t: s100.sizing && s100.sizing.tiers.map((x) => x.key + ':' + x.why.join('/')) });
chk('…the same edge on a SHADOW calibrator is capped at 0.50U', s75.decision !== 'BET' || s75.recommended_units <= 0.5);
const big = dec(Object.assign({}, valIn, { model: validated(model(1.5, 1.5)) }), { sizing: { max_units: 3, source_caps: { calibrated: 3 }, grid: [0.25, 0.5, 0.75, 1, 1.5], tiers: D.DEFAULT_CONFIG.sizing.tiers.concat([{ key: 'MAX', units: 1.5, min_edge_pp: 1, min_ev: 0.01, min_confidence: 0 }]) } });
chk('never above 1.00U, whatever a config says', big.recommended_units <= 1, big.recommended_units);
const rawOnly = dec({ model: model(3, 4.4) });
chk('raw EV never determines size: a bigger raw edge on the same calibrated probability sizes the same', rawOnly.raw_ev_pct > bet.raw_ev_pct && rawOnly.recommended_units === bet.recommended_units && rawOnly.calibrated_ev_pct === bet.calibrated_ev_pct, { raw: [rawOnly.raw_ev_pct, bet.raw_ev_pct], u: [rawOnly.recommended_units, bet.recommended_units] });
const rawHuge = dec({ model: model(-4, 4.4) });
chk('…an extreme raw edge only ever sizes smaller (price verification), never larger', rawHuge.raw_ev_pct > 20 && rawHuge.recommended_units <= bet.recommended_units, { raw: rawHuge.raw_ev_pct, u: rawHuge.recommended_units, d: rawHuge.decision });
const afterLoss = dec({ record: { last_result: 'loss', streak: -5 }, results: [{ result: 'loss' }], bankroll: { bankroll_amount: 100 } });
chk('no loss-chasing: results and bankroll in the input change nothing', afterLoss.recommended_units === bet.recommended_units && afterLoss.decision_id === bet.decision_id);
chk('sizing reads no past result (source check)', !/result|streak|drawdown|martingale/i.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('function sizing(')[1].split('function hypoQuote')[0]));
chk('the decision-confidence weights sum to 1', Math.abs(Object.values(D.DEFAULT_CONFIG.confidence.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);

/* ======================================================================== */
section('4. playable-to');
const P = bet.playable;
chk('the BET has a playable corner (worst line, worst price there) and a frontier', P && P.frontier.length >= 1 && P.min_line <= 6.5 && P.max_odds <= -102, P);
const atCorner = dec({ quotes: mainQuotes(P.min_line, P.max_odds) });
chk('the corner itself still qualifies', atCorner.decision === 'BET', { d: atCorner.decision, e: atCorner.edge_pp, ev: atCorner.decision_ev_pct, corner: [P.min_line, P.max_odds] });
const worseLine = dec({ quotes: mainQuotes(P.min_line - 0.5, P.max_odds), previous: bet });
chk('line worsens beyond the boundary = no longer a BET', worseLine.decision !== 'BET', { d: worseLine.decision, c: worseLine.action_reason_code });
const worseJuice = dec({ quotes: mainQuotes(6.5, P.at_current_line_max_odds - 1), previous: bet });
chk('juice worsens beyond the boundary = no longer a BET', worseJuice.decision !== 'BET', { d: worseJuice.decision, e: worseJuice.edge_pp, p: P.at_current_line_max_odds });
const atJuice = dec({ quotes: mainQuotes(6.5, P.at_current_line_max_odds) });
chk('…while the worst juice at the current line still qualifies', atJuice.decision === 'BET', { d: atJuice.decision, p: P.at_current_line_max_odds });
const better = dec({ quotes: mainQuotes(7.5, -102), previous: bet });
chk('line improves = remains BET', better.decision === 'BET' && better.selected_line === 7.5);
chk('spread and juice are evaluated together (the text states both)', /· (up to|maximum) -\d+/.test(P.text) || P.mode === 'CURRENT_PRICE_ONLY', P.text);
const priceMoved = dec({ model: model(4, 6.5), previous: Object.assign({}, bet, { bet_price: { side: 'away', line: 7.5, odds: -102 } }) });
chk('a BET that loses its price is PASS · PRICE MOVED, naming both numbers', priceMoved.decision === 'PASS' && priceMoved.action_reason_code === 'PRICE_MOVED' && /Line moved from \+7\.5 \(-102\) to \+6\.5 \(-102\)/.test(priceMoved.action_reason_text), priceMoved.action_reason_text);

/* ======================================================================== */
section('5. transitions and tracks');
const tImp = T.transition(bet, better);
chk('BET → BET / PRICE IMPROVED', tImp && tImp.kind === 'PRICE_IMPROVED' && tImp.from === 'BET' && tImp.to === 'BET', tImp);
const tMoved = T.transition(bet, priceMoved);
chk('BET → PASS / PRICE MOVED', tMoved && tMoved.kind === 'PRICE_MOVED', tMoved);
const qbWait = dec({ qb: { unresolved_critical: true, detail: 'NC State: competition' } });
chk('QB becomes unresolved = BET → WATCH', qbWait.decision === 'WATCH' && qbWait.action_reason_code === 'QB_UNRESOLVED' && T.transition(bet, qbWait).kind === 'NEW_INFORMATION');
const qbBack = dec({ previous: qbWait });
chk('QB resolves favorably = WATCH → re-evaluated → BET', qbBack.decision === 'BET' && T.transition(qbWait, qbBack).kind === 'INFORMATION_RESOLVED');
const qbUnknown = dec({ qb: { known: false } });
chk('an unknown QB state is never a clean bill: WATCH when the price qualifies', qbUnknown.decision === 'WATCH' && qbUnknown.action_reason_code === 'QB_UNKNOWN');
const qbQuiet = dec({ model: model(4, 6.5), qb: { unresolved_critical: true } });
chk('an unresolved QB on an unattractive price is a PASS', qbQuiet.decision === 'PASS');
const injured = dec({ model: model(4, 6.5), previous: bet });
chk('an injury update that changes the projection re-evaluates: BET → PASS (projection changed, not price moved)', injured.decision === 'PASS' && injured.action_reason_code === 'PROJECTION_CHANGED' && T.transition(bet, injured).kind === 'NEW_INFORMATION', injured.action_reason_code);
const availWait = dec({ availability: { major_uncertainty: true, detail: 'NC State: WR1 questionable' } });
chk('a major availability uncertainty = WATCH', availWait.decision === 'WATCH' && availWait.action_reason_code === 'AVAILABILITY_PENDING');
const mfWait = dec({ market: { fault: true }, research: { status: 'MARKET_FAULT', gap_pts: 5.5 } });
const mfResolved = dec({ previous: mfWait });
chk('market fault resolved = re-evaluated (WATCH → BET)', mfWait.decision === 'WATCH' && mfResolved.decision === 'BET' && T.transition(mfWait, mfResolved).kind === 'INFORMATION_RESOLVED');
const passToBet = T.transition(pass1, bet);
chk('PASS → BET / PRICE IMPROVED', passToBet.kind === 'PRICE_IMPROVED');
chk('NO DECISION → BET / market available', T.transition(nomkt, bet).kind === 'MARKET_AVAILABLE');
chk('an unchanged decision is not a transition', T.transition(bet, dec()) === null);
let tr = null;
[bet, better, dec({ quotes: mainQuotes(6.5, -105) }), priceMoved, bet].forEach((d, i) => { tr = T.track(tr, Object.assign({}, d, { evaluated_at: new Date(NOW + i * 60000).toISOString() })); });
chk('the track keeps the first qualified price fixed', tr.first_qualified.line === 6.5 && tr.first_qualified.odds === -102);
chk('best observed only improves', tr.best_observed.line === 7.5);
chk('transitions only grow, and record current and previous state', tr.transitions.length >= 3 && tr.current_decision === 'BET' && tr.previous_decision === 'PASS', tr.transitions.map((x) => x.label));
const frozenFirst = JSON.stringify(tr.transitions[0]);
tr = T.track(tr, Object.assign({}, pass1, { evaluated_at: new Date(NOW + 10 * 60000).toISOString() }));
chk('a later evaluation never rewrites an earlier transition', JSON.stringify(tr.transitions[0]) === frozenFirst);
const closed = T.close(tr, { line: 4.5, at: KICK, source: 'test' });
chk('the close is recorded once with the first-qualified CLV', closed.closing.line === 4.5 && closed.first_qualified_clv_points === 2 && T.close(closed, { line: 9 }).closing.line === 4.5);

/* ======================================================================== */
section('6. anomalies, orientation, duplicates, schedule');
const extremeIn = { model: model(-4, 1), research: { status: 'VERIFIED_MAJOR', gap_pts: 10.5, verification: 'PASSED' } };
const extreme = dec(extremeIn);
chk('an extreme gap triggers price verification', extreme.anomaly && extreme.anomaly.triggered && extreme.anomaly.triggers.some((t) => t.code === 'LARGE_GAP'), extreme.anomaly && extreme.anomaly.triggers);
/* audit 2026-09-30 #8: a 10.5-pt CFB gap is +50% raw EV on the main line —
   no verification clears that; under the 25% bound a cleared anomaly proceeds */
chk('…a verified 10.5-pt gap past the 25% raw-EV bound is WATCH · IMPLAUSIBLE EV, never a stake', extreme.decision === 'WATCH' && extreme.action_reason_code === 'IMPLAUSIBLE_EV' && extreme.recommended_units === 0, { d: extreme.decision, c: extreme.action_reason_code, u: extreme.recommended_units });
const extremeOk = dec({ model: model(2.5, 3.5) });
chk('…under the bound, every check cleared, it proceeds, capped — a ridiculous edge is never a bigger stake', extremeOk.anomaly && extremeOk.anomaly.triggered && extremeOk.decision === 'BET' && extremeOk.anomaly.cleared && extremeOk.recommended_units <= 0.5 && extremeOk.warnings.some((w) => w.code === 'ANOMALY_CLEARED'), { d: extremeOk.decision, u: extremeOk.recommended_units, checks: extremeOk.anomaly && extremeOk.anomaly.checks.filter((c) => c.status !== 'PASS') });
const flip = dec(Object.assign({}, extremeIn, { anomaly: { favorite_flip: true, circuit_breaker: { triggered: true, level: 'SEVERE', verified: true } } }));
chk('a SEVERE circuit-breaker extreme is capped at the smallest tier', flip.decision !== 'BET' || flip.recommended_units === 0.25, { d: flip.decision, u: flip.recommended_units });
const cbOpen = dec({ model: model(2.5, 3.5), anomaly: { circuit_breaker: { triggered: true, level: 'REVIEW', verified: false } } });
chk('an unverified circuit breaker holds the bet at WATCH · PRICE ANOMALY', cbOpen.decision === 'WATCH' && cbOpen.action_reason_code === 'PRICE_ANOMALY', { d: cbOpen.decision });
const disagree = dec({ quotes: mainQuotes(6.5, -102).concat(mainQuotes(3.5, -110, -110, 'DraftKings')) });
chk('multiple books disagreeing trigger verification and hold the bet (WATCH)', disagree.decision === 'WATCH' && disagree.anomaly.triggers.some((t) => t.code === 'BOOK_DISPERSION') && disagree.anomaly.checks.some((c) => c.code === 'BOOK_AGREEMENT' && c.status === 'FAIL'), { d: disagree.decision, t: disagree.anomaly && disagree.anomaly.triggers });
const arb = dec({ quotes: [q('away', 6.5, 105), q('home', -6.5, 105, { book: 'DraftKings' })] });
chk('an arbitrage-shaped pair of quotes is never a clean BET', arb.decision !== 'BET' || !arb.anomaly.cleared, { d: arb.decision });
const orient = dec({ game: { orientation_ok: false, orientation_reason: 'spread arrived in the opposite convention' } });
chk('a sign heuristic on team-labelled quotes is evaluated and verified (WATCH · PRICE ANOMALY), not NO DECISION', orient.evaluation_status === 'EVALUABLE' && orient.decision === 'WATCH' && orient.action_reason_code === 'PRICE_ANOMALY', { d: orient.decision, c: orient.action_reason_code });
const mirrored = dec({ quotes: [q('away', 6.5, -102), q('home', 6.5, -118)] });
chk('a book whose two sides contradict at one moment, with no other book to resolve it = NO DECISION · ORIENTATION_FAULT', mirrored.decision === 'NO_DECISION' && mirrored.action_reason_code === 'ORIENTATION_FAULT', mirrored.action_reason_code);
const resolved = dec({ quotes: [q('away', 6.5, -102), q('home', 6.5, -118)].concat(mainQuotes(6.5, -105, -115, 'DraftKings')) });
chk('…the same contradiction WITH another book is repaired from the consensus', resolved.decision !== 'NO_DECISION' && resolved.canonical.orientation.repairs.some((r) => r.code === 'FLIPPED_SIGN_DROPPED'), resolved.canonical && resolved.canonical.orientation);
chk('duplicate event protection = NO DECISION', dec({ game: { duplicate: true } }).action_reason_code === 'DUPLICATE_GAME');
chk('an unresolved mapping = NO DECISION', dec({ game: { mapping_ok: false } }).action_reason_code === 'MAPPING_FAILED');
chk('game cancellation = NO DECISION', dec({ game: { state: 'CANCELED' } }).action_reason_code === 'GAME_CANCELLED' && dec({ game: { state: 'CANCELLED' } }).action_reason_code === 'GAME_CANCELLED');
chk('postponement = NO DECISION', dec({ game: { state: 'POSTPONED' } }).action_reason_code === 'GAME_POSTPONED');
chk('a started game = NO DECISION (pregame decisions close)', dec({ now: Date.parse(KICK) + 60000 }).action_reason_code === 'GAME_STARTED');
chk('a malformed projection = NO DECISION', dec({ integrity: { malformed_projection: true } }).action_reason_code === 'MALFORMED_PROJECTION');
chk('a failed self-check = NO DECISION', dec({ integrity: { self_check_ok: false } }).action_reason_code === 'SELF_CHECK_FAILED');

section('push, pick’em, plus money, alternates');
const intLine = dec({ quotes: mainQuotes(6, -110), model: model(3, 3.6) });
chk('push probability: a whole-number line carries push mass and EV counts it', (intLine.bet_price || intLine.reference_quote).push_probability > 0, { d: intLine.decision, p: intLine.push_probability });
chk('…the integer line decides like any other (no push treated as a win or a loss)', ['BET', 'LEAN', 'WATCH', 'PASS'].indexOf(intLine.decision) >= 0);
const pk = D.decide(input({ model: model(-1.5, -0.2), quotes: [q('away', 0, -102), q('home', 0, -118)], market: { consensus_home_line: 0 } }));
chk('pick’em: a PK line prices and reads PK', ['BET', 'LEAN', 'WATCH', 'PASS'].indexOf(pk.decision) >= 0 && /PK/.test(D.selectionText(pk)), { d: pk.decision, t: D.selectionText(pk), c: pk.action_reason_code });
const plus = dec({ model: model(0, 1.5), quotes: [q('away', 3.5, 120), q('home', -3.5, -145)], market: { consensus_home_line: -3.5 } });
chk('plus-money spread: priced at its own payout', plus.selected_odds === 120 || (plus.reference_quote && plus.reference_quote.odds === 120), { d: plus.decision, o: plus.selected_odds });
const alts = dec({ quotes: mainQuotes(6.5, -102).concat([q('away', 7.5, -125, { market_type: 'alternate_spread' }), q('home', -7.5, 102, { market_type: 'alternate_spread' }), q('away', 3.5, 145, { market_type: 'alternate_spread' }), q('home', -3.5, -170, { market_type: 'alternate_spread' }),
  q('away', 12.5, -260, { market_type: 'alternate_spread' }), q('home', -12.5, 210, { market_type: 'alternate_spread' })]) });
chk('alternate line: the recommendation is the best RISK-ADJUSTED qualifying quote, inside the validated tail', alts.decision === 'BET' && alts.bet_price.tail !== 'NOT_VALIDATED', { d: alts.decision, sel: alts.bet_price && alts.bet_price.label });
chk('…BEST CURRENT PRICE, BEST PLAYABLE ALTERNATE and SAFER ALTERNATE are separate answers', alts.alternatives && 'best_current_price' in alts.alternatives && 'best_playable_alternate' in alts.alternatives && 'safer_alternate' in alts.alternatives
  && /BEST CURRENT PRICE/.test(alts.alternatives.note) && /BEST PLAYABLE ALTERNATE/.test(alts.alternatives.note) && /SAFER ALTERNATE/.test(alts.alternatives.note));
chk('…an extreme alternate (6 pts from the selection) is never offered beside it', ['best_playable_alternate', 'safer_alternate', 'better_value'].every((k) => !alts.alternatives[k] || Math.abs(alts.alternatives[k].line - alts.bet_price.line) <= 3));
chk('…an alternate beyond the validated tail is never the recommendation', !alts.bet_price || alts.bet_price.line !== 12.5);
const tailOnly = dec({ model: model(4, 6.5), quotes: mainQuotes(6.5, -102).concat([q('away', 13, -110, { market_type: 'alternate_spread' }), q('home', -13, -110, { market_type: 'alternate_spread' })]) });
chk('only a tail alternate showing value is at most a LEAN (TAIL UNVALIDATED), never a BET', tailOnly.decision !== 'BET' && (tailOnly.decision !== 'LEAN' || tailOnly.action_reason_code === 'TAIL_UNVALIDATED'), tailOnly.action_reason_code);

/* ======================================================================== */
section('7. bankroll, exposure, correlation');
chk('$250 bankroll = $2.50 unit', B.unitValue({ bankroll_amount: 250 }).unit === 2.5);
chk('$500 bankroll = $5 unit', B.unitValue({ bankroll_amount: 500 }).unit === 5);
chk('$1,000 bankroll = $10 unit', B.unitValue({ bankroll_amount: 1000 }).unit === 10);
chk('$2,500 bankroll = $25 unit', B.unitValue({ bankroll_amount: 2500 }).unit === 25);
chk('bankroll dollar conversion: 0.5U on a $25 unit = $12.50', B.dollars(0.5, { bankroll_amount: 2500 }) === 12.5 && B.dollarText(0.5, { bankroll_amount: 2500 }) === '$12.50');
chk('custom unit: a typed $40 unit wins in fixed mode', B.unitValue({ bankroll_amount: 2500, unit_mode: 'fixed', base_unit_amount: 40 }).unit === 40 && B.dollars(0.25, { unit_mode: 'fixed', base_unit_amount: 40 }) === 10);
chk('a custom percent ("2" means 2%)', B.unitValue({ bankroll_amount: 1000, unit_percent: 2 }).unit === 20);
chk('no bankroll: units only, with a prompt', B.unitValue({}).unit === null && /Set a bankroll/.test(B.unitValue({}).text));
chk('bankroll never changes a unit classification (the engine has no bankroll input)', dec({ bankroll_amount: 100000 }).recommended_units === bet.recommended_units);
chk('invalid settings fall back to defaults, never a guess', B.normalize({ unit_percent: 50, max_active_units: -3, bankroll_amount: 'abc' }).unit_percent === 0.01 && B.normalize({ max_active_units: -3 }).max_active_units === 5 && B.normalize({ bankroll_amount: 'abc' }).bankroll_amount === null);
const mk = (gid, u, extra) => Object.assign({ game_id: gid, decision: 'BET', recommended_units: u, sport: 'CFB', side: 'Team ' + gid, side_key: 'away', market_type: 'spread', kickoff: KICK, strength: u >= 0.75 ? 'VERY_STRONG' : (u >= 0.5 ? 'STRONG' : 'QUALIFIED'), calibrated_ev_pct: 3 }, extra || {});
const card = [mk('a', 0.5), mk('b', 0.5), mk('c', 0.25), Object.assign(mk('d', 0), { decision: 'WAIT' }), Object.assign(mk('e', 0), { decision: 'PASS' })];
const ex = B.exposure(card, { bankroll_amount: 2500 });
chk('3 bets · 1.25U total exposure · $31.25 on a $25 unit', ex.n_bets === 3 && ex.total_units === 1.25 && ex.total_dollars === 31.25, ex);
chk('exposure grouped by sport, window, game, team and market', ex.by_sport.CFB.units === 1.25 && Object.keys(ex.by_game).length === 3 && Object.keys(ex.by_window).length >= 1 && ex.by_market.spread.units === 1.25);
const corr = B.exposure([mk('a', 0.5), mk('a', 0.25, { market_type: 'total' })], {});
chk('a correlation note when two positions ride one game outcome', corr.correlation_notes.some((n) => n.code === 'SAME_GAME' && /Do not double-count conviction/.test(n.text)), corr.correlation_notes);
const many = Array.from({ length: 8 }, (_, i) => mk('g' + i, 0.75));
const warnOnly = B.exposure(many, { max_active_units: 5 });
chk('active exposure over the maximum WARNS and suppresses nothing by default', warnOnly.guardrail.exceeded && warnOnly.n_bets === 8 && warnOnly.held.length === 0);
const limited = B.exposure(many, { max_active_units: 5, exposure_limit_enabled: true });
chk('exposure limiting (opt-in) holds the positions beyond the limit', limited.total_units <= 5 && limited.held.length === 2 && limited.held.every((h) => h.reason === 'EXPOSURE_LIMIT'), limited);

/* ======================================================================== */
section('8. snapshots, CLV, the reader’s entry, performance');
const snap = T.snapshot(bet, { qb_state: { known: true }, availability_state: { known: true }, integrity_gates: [{ id: 'a', status: 'PASS' }], distribution: { p10: -14, p50: 4, p90: 22 } });
chk('the snapshot reconstructs the call (quote, probabilities, EVs, versions, gates, sizing, decision)', ['selected_line', 'selected_odds', 'selected_book', 'cover_probability', 'push_probability', 'break_even_probability', 'raw_ev_pct', 'calibrated_ev_pct', 'reliability_score',
  'projection_stability', 'market_quality', 'recommended_units', 'max_playable_line', 'max_acceptable_odds', 'decision', 'action_reason_code', 'model_version', 'calibration_version', 'decision_engine_version', 'config_version'].every((k) => snap[k] !== undefined)
  && snap.integrity_gates && snap.distribution && snap.sizing && snap.playable && Array.isArray(snap.warnings));
chk('the snapshot is frozen, with a content id', Object.isFrozen(snap) && /^bds_/.test(snap.snapshot_id) && snap.snapshot_id === T.snapshot(bet).snapshot_id);
let L = T.appendSnapshot([], snap);
chk('a snapshot is appended once', T.appendSnapshot(L, snap).length === 1);
const late = T.snapshot(Object.assign({}, bet, { evaluated_at: '2026-10-03T20:00:00Z', decision_id: 'x2' }));
chk('a post-kickoff state is refused (history is not rewritten with future information)', T.appendSnapshot(L, late).length === 1);
const early = T.snapshot(Object.assign({}, pass1, { evaluated_at: '2026-10-03T11:00:00Z' }));
chk('an out-of-order (older) state is refused', T.appendSnapshot(L, early).length === 1);
chk('CLV: bet +6.5, closed +4.5 = +2.0 pts', T.clvPoints('away', 6.5, 4.5) === 2);
chk('CLV for a favourite: laid −3, closed −4.5 = +1.5 pts', T.clvPoints('home', -3, -4.5) === 1.5);
chk('CLV is the canonical research_core implementation', T.clvPoints('home', -3, -5) === R.clvPoints('home', -3, -5));
const g = T.grade({ side: 'away', line: 6.5, odds: -102, units: 0.5 }, { line: 4.5 }, { home_margin: 6 });
chk('a graded bet: CLV, result and units at the recorded price', g.clv_points === 2 && g.result === 'win' && Math.abs(g.units_won - 0.4902) < 1e-3, g);
chk('a push returns the stake', T.grade({ side: 'away', line: 6, odds: -110, units: 1 }, null, { home_margin: 6 }).units_won === 0);
const worse = T.compareEntry({ side: 'away', line: 5, odds: -110 }, snap);
chk('your entry worse than the playable range reads OUTSIDE EdgeDesk range', worse.status === 'OUTSIDE_RANGE' && worse.edgedesk_line === 6.5 && worse.playable_line === snap.playable.min_line, worse);
chk('your entry at EdgeDesk’s price', T.compareEntry({ side: 'away', line: 6.5, odds: -102 }, snap).status === 'AT_EDGEDESK_PRICE');
chk('your entry inside the range', T.compareEntry({ side: 'away', line: snap.playable.min_line, odds: snap.playable.max_odds }, snap).status === 'INSIDE_RANGE');
chk('your entry on the other side', T.compareEntry({ side: 'home', line: -6.5, odds: -118 }, snap).status === 'OTHER_SIDE');
chk('the recommendation compared is the one frozen at placement, not a later one', T.compareEntry({ side: 'away', line: 7.5, odds: -102 }, snap).status === 'INSIDE_RANGE');
const perf = T.performance([{ units: 0.5, odds: -102, result: 'win', clv_points: 2, calibrated_cover: 0.53, sport: 'CFB' }, { units: 0.5, odds: -110, result: 'loss', clv_points: -0.5, calibrated_cover: 0.52, sport: 'CFB' }, { units: 0.25, odds: -105, result: 'push', clv_points: 0, calibrated_cover: 0.51, sport: 'NFL' }]);
const t50 = perf.by_tier.filter((r) => r.group === '0.50U')[0];
chk('per-tier performance: bets, units risked and won, ROI, CLV, observed and expected cover', t50.bets === 2 && t50.units_risked === 1 && Math.abs(t50.units_won - (0.5 * 100 / 102 - 0.5)) < 1e-2 && t50.average_clv === 0.75 && t50.observed_cover_rate === 0.5 && t50.expected_cover_rate === 0.525, t50);
chk('short samples are labelled, never evidence', !t50.sufficient && /not evidence/.test(t50.note) && perf.by_tier.length === 4);
chk('grouped by sport, model version, market type and strength', !!perf.by_sport && !!perf.by_model_version && !!perf.by_market_type && !!perf.by_strength);

/* ======================================================================== */
section('9. the real slate');
const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), 'utf8'));
const gids = Object.keys(GAMES.games);
const facts = gids.map((id) => I.factsFromTerminal(GAMES.games[id], GAMES.games[id].read, GAMES.games[id].ev, { policy_status: 'SHADOW' }));
chk('facts for every game on the slate', facts.length === gids.length && facts.every((f) => f.game.game_id && f.research && f.market && f.qb && f.support));
chk('research status is carried, never converted into a decision', facts.every((f) => typeof f.research.status === 'string' && !('decision' in f.research)));
chk('QB state reads the terminal’s own QB rows', facts.some((f) => f.qb.known) && facts.every((f) => typeof f.qb.unresolved_critical === 'boolean'));
chk('independent support counts only independent submodels, never the champion', facts.every((f) => f.support.by_side.home + f.support.by_side.away <= f.support.total_independent));
chk('the build carries decision_facts and the compact decision on every board row', BOARD.rows.every((r) => r.decision_facts && r.bettor && (D.DECISION_KEYS.indexOf(r.bettor.decision) >= 0 || r.bettor.decision === 'WAIT')));
const DEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.json'), 'utf8'));
chk('decisions.json: one decision per board game, counts that reconcile', DEC.decisions.length === BOARD.rows.length && DEC.counts.total === DEC.decisions.length
  && Object.keys(DEC.counts.decisions).reduce((a, k) => a + DEC.counts.decisions[k], 0) === DEC.decisions.length);
chk('decisions.json and the board rows agree game by game', DEC.decisions.every((d) => { const r = BOARD.rows.filter((x) => x.game_id === d.game_id)[0]; return r && r.bettor.decision === d.decision && r.bettor.reason_code === d.action_reason_code; }));
chk('the validation labels ship with the artifact', DEC.validation_state === D.UNVALIDATED && /not empirically validated/i.test(DEC.validation.note) && (DEC.engine === D.VERSION ? DEC.validation.max_units === 1 && !!DEC.validation.source_caps : DEC.validation.max_active_units === 0.75));
chk('every BET on the slate clears its engine’s own thresholds', DEC.counts.decisions.BET === 0 || DEC.decisions.filter((d) => d.decision === 'BET').every((d) => DEC.engine === D.VERSION ? d.edge_pp >= 4 && d.decision_ev_pct >= 5 : d.calibrated_ev_pct >= 1.5));
if (DEC.engine === D.VERSION) chk('decisions.json (v2): NO DECISION always names an essential blocker', DEC.decisions.every((d) => d.decision !== 'NO_DECISION' || (d.blocker_codes || []).length > 0));
chk('no stale-quote game is ever a BET', DEC.decisions.every((d) => d.action_reason_code !== 'STALE_QUOTE' || d.decision === 'NO_DECISION'));
chk('every PASS on the slate names why and what would change it', DEC.decisions.filter((d) => d.decision === 'PASS').every((d) => d.action_reason_text && (d.bet_trigger || d.action_reason_code === 'LOW_RELIABILITY' || d.action_reason_code === 'UNSTABLE_PROJECTION' || d.action_reason_code === 'MARKET_ALIGNED')));
chk('an INVESTIGATE / MARKET FAULT game is never a BET', DEC.decisions.every((d) => ['INVESTIGATE', 'MARKET_FAULT', 'DATA_FAULT'].indexOf(d.research_status) < 0 || d.decision !== 'BET'));
/* the page path: the build's facts, re-joined with pricing, decide the same */
const Bmod = require(path.join(ROOT, 'football', 'cfb_terminal', 'build.js'));
void Bmod;
const viewFacts = I.factsFromView({ research_label: { key: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', reason: 'x' }, market_gap: { available: true, points: 4, toward_team: 'NC State', stale: false }, reliability: { scored: true, score: 81 }, confidence: { score: 66, tier: 'HIGH' } },
  null, { game: { game_id: 'g1', home: 'Wake Forest', away: 'NC State', kickoff: KICK } });
chk('the page’s view alone never claims a QB state it does not have', viewFacts.qb.known === false && viewFacts.research.gap_toward_side === 'away' && viewFacts.reliability.score === 81);
const pageDec = D.decide(I.inputFromFacts(viewFacts, { model: model(4, 4.4), quotes: mainQuotes(6.5, -102) }, { now: NOW }));
chk('…so an attractive price from the page’s facts alone is WATCH (QB unknown), never BET', pageDec.decision === 'WATCH' && pageDec.action_reason_code === 'QB_UNKNOWN', pageDec.action_reason_code);
const liveM = I.marketFromEvaluation(Q.evaluateGame(model(4, 4.4), mainQuotes(6.5, -102), { now: NOW, game: { game_id: 'g1' } }), {});
chk('the live market facts read the evaluation’s own main line', liveM.consensus_home_line === -6.5 && liveM.available === true, liveM);

/* ======================================================================== */
section('10. the renderers');
const html = { BET: U.actionCardHTML(bet, { track: null, beginner: false }), WAIT: U.actionCardHTML(inv, { track: null }), LEAN: U.actionCardHTML(oneSided, { track: null }), PASS: U.actionCardHTML(pass1, { track: null }), NO: U.actionCardHTML(stale, { track: null }) };
const top = (h) => text(h.split('View reasoning')[0]);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/\s+/g, ' ');
chk('BET card: BET · 0.50U, the selection, price · book, PLAYABLE TO, why and what cancels it', /BET · 0\.50U/.test(text(html.BET)) && /NC STATE \+6\.5/.test(text(html.BET)) && /-102 · FanDuel/.test(text(html.BET)) && /PLAYABLE TO/.test(text(html.BET)) && /WHY IT QUALIFIES/.test(text(html.BET)) && /WHAT CANCELS IT/.test(text(html.BET)), text(html.BET).slice(0, 300));
chk('BET card: STAKE TIER, DECISION CONFIDENCE, PROBABILITY, MODEL COVER, BREAK-EVEN, EDGE, RAW MODEL EV, CALIBRATED EV, MODEL FAIR, RELIABILITY, MARKET, PROJECTION', ['STAKE TIER', 'DECISION CONFIDENCE', 'PROBABILITY', 'MODEL COVER', 'BREAK-EVEN', 'EDGE', 'RAW MODEL EV', 'CALIBRATED EV', 'MODEL FAIR', 'RELIABILITY', 'MARKET', 'PROJECTION'].every((w) => text(html.BET).indexOf(w) >= 0));
chk('BET card: the execution summary answers what · where · price · how much · playable to · edge · calibrated EV · confidence · why · what could invalidate it',
  ['WHAT', 'WHERE', 'PRICE', 'HOW MUCH', 'PLAYABLE TO', 'EDGE', 'CALIBRATED EV', 'CONFIDENCE', 'WHY', 'WHAT COULD INVALIDATE IT'].every((w) => top(html.BET).indexOf(w) >= 0), top(html.BET).slice(0, 400));
chk('the exact action lines name the decision EV and label the raw one diagnostic', bet.action.lines.some((l) => /^Model cover: \d/.test(l)) && bet.action.lines.some((l) => /^Break-even: \d/.test(l)) && bet.action.lines.some((l) => /^Edge: \+/.test(l))
  && bet.action.lines.some((l) => /^Calibrated EV: \+[\d.]+% \(used by the decision engine\)/.test(l)) && bet.action.lines.some((l) => /^Raw model EV: \+[\d.]+% \(diagnostic only\)/.test(l)) && bet.action.lines.some((l) => /^Decision confidence: \d+\/100/.test(l)), bet.action.lines);
chk('BET card: BEST CURRENT PRICE / CONSENSUS / EDGEDESK BET PRICE / PLAYABLE TO / MODEL FAIR are named apart', ['BEST CURRENT PRICE', 'CONSENSUS', 'EDGEDESK BET PRICE', 'PLAYABLE TO', 'MODEL FAIR'].every((w) => text(html.BET).indexOf(w) >= 0));
chk('BET card: BET PLACED and VIEW FULL RESEARCH', /BET PLACED/.test(html.BET) && /VIEW FULL RESEARCH/.test(html.BET));
chk('WATCH card: WATCH · qualifier, DO NOT BET YET, the trigger, what it waits on, next check, no unit recommendation', /WATCH/.test(html.WAIT) && /PRICE ANOMALY/.test(html.WAIT) && /DO NOT BET YET/.test(html.WAIT) && /BET TRIGGER/.test(html.WAIT) && /WAITING ON/.test(html.WAIT) && /NEXT CHECK/.test(html.WAIT) && /No unit recommendation/.test(html.WAIT) && !/BET PLACED/.test(html.WAIT));
chk('WATCH card: CURRENT PRICE, then the REASON — what must happen, never a forecast', /CURRENT PRICE/.test(text(html.WAIT)) && /REASON The price looks anomalous and has not passed verification/.test(text(html.WAIT)));
chk('LEAN card: LEAN, 0U, no stake, why it is not a bet', /LEAN/.test(html.LEAN) && /0U · no stake/.test(text(html.LEAN)) && /WHY NOT A BET/.test(text(html.LEAN)) && /THIN MARKET/.test(html.LEAN) && !/BET PLACED/.test(html.LEAN));
chk('PASS card: the price, model fair, raw and calibrated EV, WHY PASS, BET TRIGGER', /Current price does not justify a wager/.test(html.PASS) && /WHY PASS/.test(html.PASS) && /BET TRIGGER/.test(html.PASS) && /RAW MODEL EV/.test(html.PASS) && /CALIBRATED EV/.test(html.PASS) && /BEST AVAILABLE/.test(html.PASS) && /The raw model edge disappears after calibration/.test(html.PASS));
chk('NO DECISION card: the exact blocker and the last known market, never generic copy', /NO DECISION/.test(html.NO) && /BLOCKER/.test(html.NO) && /STALE_QUOTE/.test(html.NO) && /No sufficiently fresh sportsbook quote is available/.test(text(html.NO)) && !/does not currently have enough verified information/.test(html.NO));
chk('tone classes: BET bet, WATCH watch, LEAN lean, PASS pass, NO DECISION none', /edd-act edd-bet/.test(html.BET) && /edd-act edd-watch/.test(html.WAIT) && /edd-act edd-lean/.test(html.LEAN) && /edd-act edd-pass/.test(html.PASS) && /edd-act edd-none/.test(html.NO));
chk('no tout language on any card (LOCK, FREE MONEY, GUARANTEED, SAFE BET…)', Object.keys(html).every((k) => U.copyOk(html[k])));
chk('a WATCH / LEAN / PASS / NO DECISION action never recommends units or dollars', ['WAIT', 'LEAN', 'PASS', 'NO'].every((k) => !/based on your \$/.test(html[k]) && !/\d\.\d+U\b/.test(top(html[k]))));
const beg = U.actionCardHTML(bet, { beginner: true, track: null });
chk('beginner mode: one-sentence WHY, no diagnostics, an Advanced view', /edd-begin/.test(beg) && /WHY/.test(beg) && /the calibrated edge is \+[\d.]+ pp/.test(text(beg)) && !/edd-reason/.test(beg) && !/RAW MODEL EV|Raw model EV/.test(beg) && /Advanced view/.test(beg));
chk('advanced mode keeps the reasoning open on desktop', /<details class="edd-reason" open/.test(html.BET));
chk('the phone variant folds the reasoning behind "View reasoning"', !/<details class="edd-reason" open/.test(U.actionCardHTML(bet, { mobile: true, track: null })) && /View reasoning/.test(U.actionCardHTML(bet, { mobile: true, track: null })));
['calibrated_ev', 'raw_ev', 'reliability', 'unit', 'playable_to', 'research_status', 'bet_decision'].forEach((k) => chk('tooltip defined: ' + k, typeof D.TOOLTIP[k] === 'string' && D.TOOLTIP[k].length > 30));
chk('tooltip text matches the spec: calibrated EV', /Expected return after EdgeDesk adjusts the raw model probability using its current calibration layer/.test(D.TOOLTIP.calibrated_ev));
chk('tooltip text matches the spec: raw EV is diagnostic only', /Expected return from the unadjusted model probability\. Diagnostic only/.test(D.TOOLTIP.raw_ev));
chk('tooltip text matches the spec: reliability is not a betting recommendation', /How complete and stable the model inputs are for this game/.test(D.TOOLTIP.reliability) && /not a betting recommendation/.test(D.TOOLTIP.reliability));
chk('tooltip text matches the spec: decision confidence is not the probability the bet wins', /It is not the probability that the bet wins/.test(D.TOOLTIP.decision_confidence));
chk('tooltip text matches the spec: unit', /EdgeDesk defaults 1 unit to 1% of bankroll/.test(D.TOOLTIP.unit));
chk('the chip: BET · units and the playable short, or the decision word', /BET · 0\.50U/.test(U.chipHTML(bet)) && /to /.test(U.chipHTML(bet)) && /WATCH/.test(U.chipHTML(inv)) && /do not bet yet/.test(U.chipHTML(inv)) && /PASS/.test(U.chipHTML(pass1)) && /LEAN/.test(U.chipHTML(oneSided)));
const page = U.cardPageHTML([bet, inv, pass1, stale, s25c, oneSided], { view: { filter: 'all', sort: 'strength' } });
chk('the card page: header counts, sections, filters, sort, exposure', /EDGEDESK CARD/.test(page) && /BET <small>2/.test(page) && /LEAN <small>1/.test(page) && /WATCHING <small>1/.test(page) && /PASS <small>1/.test(page) && /NO DECISION <small>1/.test(page) && /0\.75U/.test(page) && /Strongest qualified edge/.test(page), text(page).slice(0, 300));
chk('…every filter the spec names', ['All', 'Bets', 'Leans', 'Watching', 'Pass', 'NFL', 'CFB', '0.25U', '0.50U', '0.75U', '1.00U'].every((f) => page.indexOf('>' + f + '<') >= 0));
chk('…and every sort', ['Kickoff', 'Strongest qualified edge', 'Calibrated EV', 'Latest change', 'Line movement'].every((s) => page.indexOf('>' + s + '<') >= 0));
chk('…strongest first: the 0.50U BET before the 0.25U BET', page.indexOf('0.50U') < page.indexOf('0.25U</span>'));
chk('…PASS and NO DECISION are collapsed by default', /<details class="edd-sec" data-edd-fold="showPass">/.test(page) && /<details class="edd-sec" data-edd-fold="showNone">/.test(page));
chk('the filters select the right decisions', U.passes(bet, 'bets') && !U.passes(inv, 'bets') && U.passes(inv, 'watching') && U.passes(oneSided, 'leans') && U.passes(s25c, 'u25') && !U.passes(bet, 'u25') && U.passes(bet, 'u50') && U.passes(bet, 'cfb') && !U.passes(bet, 'nfl'));
chk('a legacy WAIT snapshot still reads as WATCH on the card', U.passes({ decision: 'WAIT' }, 'watching') && /WATCH/.test(U.chipHTML(Object.assign({}, inv, { decision: 'WAIT', decision_label: 'WAIT' }))));
const onb = [0, 1, 2, 3].map((i) => text(U.onboardingHTML(i)));
chk('onboarding: four short pages in the spec’s order', /WELCOME TO EDGEDESK/.test(onb[0]) && /SET YOUR UNIT/.test(onb[1]) && /READ THE ACTION/.test(onb[2]) && /PRICE MATTERS/.test(onb[3]));
chk('onboarding page 4 is labelled illustrative, not a recommendation', /illustrative, not a current recommendation/.test(onb[3]));
const bf = U.bankrollFormHTML({ bankroll_amount: 2500 });
chk('the bankroll form: bankroll, 1% default, a custom unit, the guardrail, beginner mode, and no loss-chasing', /Bankroll/.test(bf) && /% of bankroll/.test(bf) && /Custom unit/.test(bf) && /Maximum active exposure/.test(bf) && /Beginner mode/.test(bf) && /never raises a stake to chase losses/.test(bf) && /\$25\.00/.test(bf));
const placedBet = U.makePlaced(bet, { line: '5', odds: '-110', book: 'DK', units: '0.5', stake_dollars: '12.5' }, NOW);
chk('BET PLACED stores side, line, odds, book, units, dollars and time, apart from the recommendation', placedBet.side === 'away' && placedBet.line === 5 && placedBet.odds === -110 && placedBet.units === 0.5 && placedBet.stake_dollars === 12.5 && placedBet.placed_at && placedBet.recommendation.selected_line === 6.5 && placedBet.entry_vs_recommendation === 'OUTSIDE_RANGE');
chk('the CSS has a phone layout and never a fixed wide width', /@media\(max-width:560px\)/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision.css'), 'utf8')) && !/[{;]\s*(min-)?width:\s*[4-9]\d\dpx/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision.css'), 'utf8')));

section('the hourly job grades placed bets from the committed record');
const RS = require(path.join(ROOT, 'tools', 'personal', 'research_state.js'));
const gb = RS.gradeBet({ market_type: 'spread', side: 'away', line: 6.5, odds: -102, units: 0.5, kickoff: '2026-09-20T19:00:00Z', close_line: null }, { close: { home_line: -4.5 }, final: { home_score: 24, away_score: 20 } }, Date.parse('2026-09-28T00:00:00Z'));
chk('a placed bet: close, CLV +2.0, result and units at the recorded price', gb.patch && gb.patch.close_line === 4.5 && gb.patch.clv_points === 2 && gb.patch.result === 'win' && Math.abs(gb.patch.units_won - 0.4902) < 1e-3, gb);
const gbOpen = RS.gradeBet({ market_type: 'spread', side: 'home', line: -3, odds: -110, units: 1, kickoff: '2026-09-27T19:00:00Z', close_line: null }, { close: { home_line: -4.5 } }, Date.parse('2026-09-28T00:00:00Z'));
chk('a close without a final: CLV now, the result later (not graded yet)', gbOpen.patch && gbOpen.patch.clv_points === 1.5 && !gbOpen.patch.graded_at, gbOpen);
chk('only spreads are graded', RS.gradeBet({ market_type: 'moneyline', side: 'home' }, null, Date.now()).patch === null);

/* ------------------------------------------------------------------ out */
failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bettor decision — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
