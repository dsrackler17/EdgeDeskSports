#!/usr/bin/env node
/* ===========================================================================
   ONE MEANING PER STATE — the failure modes the consistency pass closed.
   docs/bettor-decision/CONSISTENCY.md

   EdgeDesk answers RESEARCH → MODEL → MARKET → PRICING → DECISION → SIZING →
   MONITORING → GRADING, and a new reader must never have to reverse-engineer
   which layer a word belongs to. Each check below is one way the product used
   to contradict itself (or could), pinned on the real engine, the real
   renderers and the functions cut out of the real page:

     A  a live quote never reads NO MARKET        K  only BET is exposure
     B  a stale quote never BETs                  L  raw EV alone never BETs
     C  a MARKET FAULT never BETs                 M  calibrated EV decides
     D  a price anomaly never BETs unverified     N  the quote shown is the quote priced
     E  WATCH always names its reason             O  PLAYABLE TO stays inside the threshold
     F  WATCH names its BET trigger when one exists  P  beginner mode hides diagnostics
     G  NO DECISION only for missing data         Q  advanced mode keeps every detail
     H  PASS is never exposure                    R  extreme alternates never "best"
     I  LEAN is never exposure                    S  research ranking ≠ decision
     J  WATCH is never exposure

   Run: node tools/bettor/consistency.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const VOC = require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const BK = require(path.join(ROOT, 'lib', 'edgedesk_bankroll.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
const RV = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
const P = require(path.join(ROOT, 'lib', 'research_priority.js'));
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String((e && e.stack) || e).slice(0, 500); } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function section(t) { console.log('  · ' + t); }
const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/\s+/g, ' ');
const top = (h) => text(String(h).split('View reasoning')[0]);

/* ------------------------------------------------------------ the fixture
   Wake Forest (home) vs NC State (away), market Wake −6.5. A normal margin
   model: raw fair Wake by `fair`, calibrated fair Wake by `cal`. */
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
const NOW = Date.parse('2026-10-03T12:00:00Z'), FRESH = '2026-10-03T11:52:00Z', OLD = '2026-10-03T06:00:00Z', KICK = '2026-10-03T19:30:00Z';
function model(fair, cal) {
  const cc = cal == null ? null : normalCover(cal, 14);
  return { sport: 'CFB', available: true, model_version: 'test_v1', fair_home_margin: fair, home_cover: normalCover(fair, 14), tail: { validated_within_pts: 3 },
    adjusted: cal == null ? { available: false, reason: 'no validated calibration' } : { available: true, label: 'CALIBRATED', version: 'cal_test', maturity: 'SHADOW', side_prob: (s, l) => Q.sideProb(cc, s, l) } };
}
function q(side, line, am, extra) { return Object.assign({ game_id: 'g1', side, line, american: am, book: 'FanDuel', captured_at: FRESH, fresh: true, n_books: 1 }, extra || {}); }
function mainQuotes(awayLine, awayPrice, homePrice, book) { return [q('away', awayLine, awayPrice, { book: book || 'FanDuel' }), q('home', -awayLine, homePrice == null ? -118 : homePrice, { book: book || 'FanDuel' })]; }
function input(over) {
  const o = { now: NOW, sport: 'CFB', market_type: 'spread',
    game: { game_id: 'g1', home: 'Wake Forest', away: 'NC State', kickoff: KICK, mapping_ok: true, orientation_ok: true },
    model: model(4, 4.4), quotes: mainQuotes(6.5, -102),
    research: { status: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', gap_pts: 2.5, gap_toward_side: 'away', verification: 'NOT_REQUIRED' },
    integrity: { gates: [{ id: 'a', status: 'PASS' }] }, market: { consensus_home_line: -6.5, n_books_fresh: 2, dispersion: 0 },
    reliability: { score: 79, grade: 'STRONG' }, confidence: { score: 70 }, projection: { stability: 'STABLE' },
    qb: { known: true }, availability: { known: true }, support: { by_side: { away: 2, home: 0 } }, anomaly: {}, governance: {} };
  Object.keys(over || {}).forEach((k) => {
    const v = over[k];
    if (k === 'model' || k === 'quotes' || k === 'previous') o[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object') o[k] = Object.assign({}, o[k], v);
    else o[k] = v;
  });
  return o;
}
const dec = (over) => D.decide(input(over));

/* a spread of decisions across every class */
const bet = dec();
const watchQb = dec({ qb: { known: false } });
const watchPrice = dec({ quotes: mainQuotes(6.5, -125, -105) });
const lean = dec({ quotes: [q('away', 6.5, -102)] });
const leanEdge = dec({ model: model(5, 4.8), quotes: mainQuotes(6.5, -110, -110) });
const passCal = dec({ model: model(7.5, 7.3), quotes: mainQuotes(6.5, -110, -110) });
const passAligned = dec({ model: model(6.5, 6.5), quotes: mainQuotes(6.5, -110, -110) });
const stale = dec({ quotes: mainQuotes(6.5, -102).map((x) => Object.assign(x, { fresh: false })) });
const noMarket = dec({ quotes: [] });
const ALL = { bet, watchQb, watchPrice, lean, leanEdge, passCal, passAligned, stale, noMarket };

/* ======================================================================== */
section('the vocabulary: one word per state');
chk('five decisions, one definition each, shared by the engine', VOC.DECISION_KEYS.join() === D.DECISION_KEYS.join()
  && VOC.DECISION_KEYS.every((k) => D.DECISIONS[k].label === VOC.DECISION[k].label && D.DECISIONS[k].means === VOC.DECISION[k].means));
chk('WAIT (a v1 enum) reads WATCH everywhere a reader sees it', VOC.decisionLabel('WAIT') === 'WATCH' && D.DECISIONS.WAIT.label === 'WATCH' && C.DECISION_STATUS.WAIT.label === 'WATCH'
  && /WATCH/.test(U.chipHTML(Object.assign({}, watchQb, { decision: 'WAIT' }))) && !/>WAIT</.test(U.chipHTML(Object.assign({}, watchQb, { decision: 'WAIT' }))));
chk('five market states, from lib/edgedesk_vocab.js', VOC.MARKET_STATE_KEYS.join() === 'LIVE_MARKET,THIN_MARKET,STALE_MARKET,NO_MARKET,MARKET_FAULT' && D.MARKET_STATES.NO_MARKET.label === 'NO MARKET');
chk('the help text is the spec’s: EDGE, CALIBRATED EV, RAW EV, PLAYABLE TO, DECISION CONFIDENCE, RELIABILITY',
  /cover probability and the break-even probability at this price/.test(D.TOOLTIP.edge) && /current calibration layer/.test(D.TOOLTIP.calibrated_ev) && /Diagnostic only/.test(D.TOOLTIP.raw_ev)
  && /still clears the BET threshold/.test(D.TOOLTIP.playable_to) && /not the probability that the bet wins/.test(D.TOOLTIP.decision_confidence) && /not a betting recommendation/.test(D.TOOLTIP.reliability));
chk('research status and decision status each have their own explanation', /investigate this matchup/.test(D.TOOLTIP.research_status) && /current available price justify action/.test(D.TOOLTIP.bet_decision));
chk('no "?" glyph rides a label (the old tooltip artifact)', Object.keys(ALL).every((k) => !/<i aria-hidden="true">\?<\/i>/.test(U.actionCardHTML(ALL[k], { track: null }))));
chk('the status line is intentional text: Decision rules · Conservative defaults · Live validation · In progress · Research status · Separate from the bet decision',
  /Decision rules Conservative defaults/.test(text(U.actionCardHTML(bet, { track: null }))) && /Live validation In progress/.test(text(U.actionCardHTML(bet, { track: null })))
  && /Research status Separate from the bet decision/.test(text(U.actionCardHTML(bet, { track: null }))) && /Calibration Partially calibrated/.test(text(U.actionCardHTML(bet, { track: null }))));
chk('no user-visible "not yet validated on live results?" / "Bet decision? ≠" artifact', Object.keys(ALL).every((k) => !/\w\?\s*≠|results\?|calibrated\?/.test(text(U.actionCardHTML(ALL[k], { track: null })))));

/* ======================================================================== */
section('A. a game with a live quote can never display NO MARKET');
const evaluable = Object.keys(ALL).map((k) => ALL[k]).filter((d) => d.evaluation_status === 'EVALUABLE');
chk('A: every evaluable decision reads a live, thin or faulted market — never NO MARKET or STALE MARKET', evaluable.length >= 6 && evaluable.every((d) => ['LIVE_MARKET', 'THIN_MARKET', 'MARKET_FAULT'].indexOf(d.market_state.key) >= 0), evaluable.map((d) => d.market_state.key));
chk('A: …and its card never prints NO MARKET above the reasoning', evaluable.every((d) => !/NO MARKET/.test(top(U.actionCardHTML(d, { track: null })))));
chk('A: a game blocked for a model reason keeps its live market (MODEL UNAVAILABLE ≠ NO MARKET)', (() => { const d = dec({ model: { available: false, reason: 'x' } }); return d.decision === 'NO_DECISION' && d.blocker_codes[0] === 'MODEL_UNAVAILABLE' && d.market_state.key === 'LIVE_MARKET'; })());
chk('A: NO MARKET means exactly no quote for the market evaluated', noMarket.market_state.key === 'NO_MARKET' && noMarket.blocker_codes[0] === 'NO_MARKET');
chk('A: a stale capture is STALE MARKET, not NO MARKET', stale.market_state.key === 'STALE_MARKET');
chk('A: the research view names a stale capture STALE MARKET', (() => { const L = RV.researchLabel({ fair: { raw_projected_margin: 3 }, market_gap: { available: true, points: 1, stale: true }, confidence: { score: 70 }, reliability: { value: 0.9, scored: true, score: 85 } }); return L.key === 'NO_MARKET' && L.rule === 'stale_market' && L.label === 'STALE MARKET'; })());
chk('A: the canon names a stale capture STALE MARKET and keeps NO MARKET for none', C.researchStatus({ projected: true, market: 'STALE', gap: 3, confidence: 70 }).label === 'STALE MARKET' && C.researchStatus({ projected: true, market: 'NONE' }).label === 'NO MARKET');
/* the page: the functions that decide what the FBS board and card say, cut out of app.html */
function slice(start, end) { const a = APP.indexOf(start); if (a < 0) throw new Error('app.html no longer contains ' + start); const b = APP.indexOf(end, a); if (b < 0) throw new Error('no end marker ' + end); return APP.slice(a, b); }
const PAGE = { window: {}, FB_GUARD: { p4: { game: 21 }, nfl: { game: 14 } }, fbP4GateStatus: () => null, Date, Math, JSON, Object, String, Number, isFinite };
PAGE.window.EDCanon = C; PAGE.window.EDCfbResearchView = RV;
vm.createContext(PAGE);
vm.runInContext('function fbNorm(s){return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");}function fbNum(x){if(x==null||x==="")return null;var v=+x;return isFinite(v)?v:null;}'
  + slice('function fbMarketFromEvent(e,homeName){', '/* ---- shared per-game builders')
  + slice('function fbP4StatusFor(p,mkt,u){', 'function fbP4Line(')
  + slice('var FB_CANON_MAX_AGE_H=', 'function fbCanonEnsure(')
  + slice('var FB_CANON_TO_VIEW=', 'function fbCanonApply(')
  + slice('function fbCanonApply(v,cr){', 'function fbP4ViewFor('), PAGE);
const predicted = { status: 'PREDICTED', model: { fair_spread: 3 }, edge: { spread: { recommendation: 'RESEARCH_LEAN' } } };
chk('A: a spread dropped by the orientation check is DATA FAULT on the board, never NO MARKET', PAGE.fbP4StatusFor(predicted, { spread_line: null, spread_fault: { reason: 'x' } }).t === 'DATA FAULT');
chk('A: a board event that captured only the away spread still has a market line', (() => { const m = PAGE.fbMarketFromEvent({ home: 'Florida', away: 'Ole Miss', rows: [{ market: 'spreads', selection: 'Ole Miss', point: 2.5, best_book: 'DK', last_seen_at: FRESH }] }, 'Florida'); return m.spread_line === 2.5; })());
chk('A: …and the home side still reads first (home -3 is a +3 home margin)', PAGE.fbMarketFromEvent({ rows: [{ market: 'spreads', selection: 'Florida', point: -3, best_book: 'DK' }, { market: 'spreads', selection: 'Ole Miss', point: 3.5, best_book: 'FD' }] }, 'Florida').spread_line === 3);
PAGE.FB = { canon: { board: { generated_at: new Date(Date.now() - 20 * 60000).toISOString() } } };
const liveView = { research_label: { key: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', rule: 'research_gap' } };
/* audit 2026-09-30 (#6): the build's label was measured on the Model Lab
   ledger's market and was swapped over a live gap measured on this page's
   captured quotes ("MARKET ALIGNED · gap 5.3"). The live label — the one rule
   over the one snapshot the gap and the price line use — now always stands;
   the build's status is carried for audit only. */
const reconciled = PAGE.fbCanonApply(liveView, { research_status: 'NO_MARKET', research_reason: 'no current spread quote' });
chk('A: a published NO MARKET never overrides a live priced market on the card', reconciled.research_label.key === 'WORTH_RESEARCHING' && reconciled.canonical.build_research_status === 'NO_MARKET');
const reverse = PAGE.fbCanonApply({ research_label: { key: 'NO_MARKET', label: 'NO MARKET', rule: 'no_market' } }, { research_status: 'WORTH_RESEARCHING' });
chk('A: …nor a published market status a market the page no longer sees', reverse.research_label.key === 'NO_MARKET' && reverse.canonical.build_research_status === 'WORTH_RESEARCHING');
const agree = PAGE.fbCanonApply(liveView, { research_status: 'VERIFIED_MAJOR', research_reason: 'x' });
chk('A: a published status measured on another snapshot never replaces the live label (one snapshot, one rule, one status on every page)', agree.research_label.key === 'WORTH_RESEARCHING' && agree.research_label.rule === 'research_gap' && agree.canonical.build_research_status === 'VERIFIED_MAJOR');
chk('A: the FBS summary reads the decision’s market state and quote, not a second join', /var MS=bd&&bd\.market_state/.test(APP) && /Calibrated EV · decision quote/.test(APP));
chk('A: the NFL card says "no market" only when the decision’s own market state agrees', /\(!dms\|\|dms\.key==='NO_MARKET'\)/.test(APP));

/* ======================================================================== */
section('B. C. D. only a live, verified price can BET');
chk('B: a stale quote is NO DECISION · STALE_QUOTE, never BET', stale.decision === 'NO_DECISION' && stale.blocker_codes[0] === 'STALE_QUOTE');
const oldByClock = dec({ quotes: mainQuotes(6.5, -102).map((x) => Object.assign(x, { fresh: undefined, captured_at: OLD })) });
chk('B: a quote past the freshness limit by its own capture time never BETs', oldByClock.decision !== 'BET' && oldByClock.market_state.key === 'STALE_MARKET', { d: oldByClock.decision, m: oldByClock.market_state.key });
chk('B: a BET that goes stale is withdrawn (NO DECISION), naming the earlier price', (() => { const d = dec({ quotes: mainQuotes(6.5, -102).map((x) => Object.assign(x, { fresh: false })), previous: { decision: 'BET', bet_price: { side: 'away', line: 6.5, odds: -102, book: 'FanDuel' } } }); return d.decision === 'NO_DECISION' && /earlier BET/.test(d.action_reason_text); })());
const faultResearch = dec({ research: { status: 'MARKET_FAULT', label: 'MARKET FAULT', gap_pts: 8, verification: 'FAILED' }, model: model(0, -0.5), quotes: mainQuotes(6.5, -102) });
chk('C: a MARKET FAULT game with an attractive price never BETs', faultResearch.decision !== 'BET' && faultResearch.market_state.key === 'MARKET_FAULT', { d: faultResearch.decision, c: faultResearch.action_reason_code, m: faultResearch.market_state.key });
const faultMarket = dec({ market: { fault: true, fault_reason: 'books disagree' } });
chk('C: a market integrity fault on the facts never BETs', faultMarket.decision !== 'BET' && faultMarket.market_state.key === 'MARKET_FAULT', { d: faultMarket.decision, m: faultMarket.market_state.key });
const corrupted = dec({ quotes: [q('away', 6.5, 50), q('home', -6.5, 50)] });
chk('C: odds that fail their arithmetic are NO DECISION on a MARKET FAULT', corrupted.decision === 'NO_DECISION' && corrupted.market_state.key === 'MARKET_FAULT', { d: corrupted.decision, b: corrupted.blocker_codes, m: corrupted.market_state && corrupted.market_state.key });
const sign = dec({ game: { sign_suspect: { reason: 'the joined line only agreed once negated' } } });
chk('D: a price anomaly (sign suspicion) is WATCH · PRICE ANOMALY, never BET', sign.decision === 'WATCH' && sign.action_reason_code === 'PRICE_ANOMALY' && sign.quote.verification_state === 'FAILED', { d: sign.decision, c: sign.action_reason_code });
const extreme = dec({ model: model(-6, -5.6), quotes: mainQuotes(6.5, -102).concat(mainQuotes(6.5, -104, -116, 'DraftKings')), market: { n_books_fresh: 2 } });
chk('D: an extreme edge that passes every check proceeds, capped — never boosted', extreme.anomaly && extreme.anomaly.triggered && (extreme.decision !== 'BET' || (extreme.anomaly.cleared && extreme.recommended_units <= 0.5)), { d: extreme.decision, a: extreme.anomaly && extreme.anomaly.cleared, u: extreme.recommended_units });
const disp = dec({ model: model(-6, -5.6), quotes: mainQuotes(6.5, -102).concat(mainQuotes(9, -110, -110, 'DraftKings')), market: { dispersion: 2.5 } });
chk('D: the same edge with books 2.5 pts apart fails verification: not a BET', disp.decision !== 'BET' && disp.anomaly && disp.anomaly.triggered, { d: disp.decision, c: disp.action_reason_code });
chk('D: every BET above rides a LIVE MARKET', Object.keys(ALL).map((k) => ALL[k]).concat([extreme, disp, sign]).filter((d) => d.decision === 'BET').every((d) => d.market_state.key === 'LIVE_MARKET' && d.market_state.bettable));

/* ======================================================================== */
section('E. F. WATCH says what it waits for, and at what price');
const watches = [watchQb, watchPrice, sign, dec({ availability: { pending: true } }), dec({ model: model(5.8, 5.6), quotes: mainQuotes(6.5, -110, -110) })].filter((d) => d.decision === 'WATCH');
chk('E: several WATCH shapes in the fixture set', watches.length >= 3, watches.length);
const WATCH_CODES = ['NEAR_THRESHOLD', 'MODEL_MARKET_DISAGREEMENT', 'PRICE_ANOMALY', 'QB_UNRESOLVED', 'QB_UNKNOWN', 'AVAILABILITY_PENDING'];
chk('E: every WATCH has a WATCH reason code, its sentence and a qualifier', watches.every((d) => WATCH_CODES.indexOf(d.action_reason_code) >= 0 && d.action_reason_text && d.decision_qualifier), watches.map((d) => d.action_reason_code));
chk('E: every WATCH card shows DO NOT BET YET, CURRENT PRICE, REASON, WAITING ON and NEXT CHECK', watches.every((d) => { const t = top(U.actionCardHTML(d, { track: null })); return ['DO NOT BET YET', 'CURRENT PRICE', 'REASON', 'WAITING ON', 'NEXT CHECK'].every((w) => t.indexOf(w) >= 0); }));
chk('F: a WATCH whose realistic trigger exists names every option on the card', watches.every((d) => { const t = top(U.actionCardHTML(d, { track: null })), o = (d.bet_trigger && d.bet_trigger.options || []).filter((x) => x.realistic); return o.every((x) => t.indexOf(x.text) >= 0) && (!o.length || /BET TRIGGER/.test(t)); }));
chk('F: a WATCH held by information (price already clears) says so, with no price to wait for', (() => { const t = top(U.actionCardHTML(watchQb, { track: null })); return watchQb.bet_trigger.already_clears === true && /Becomes eligible for BET once quarterback status is loaded/.test(t); })());
chk('F: a price WATCH offers the line OR the price', (() => { const o = watchPrice.bet_trigger.options.filter((x) => x.realistic); const t = top(U.actionCardHTML(watchPrice, { track: null })); return o.length === 2 && /OR/.test(t) && /A better spread or price\./.test(t); })());
chk('F: every realistic trigger clears the BET threshold at that exact quote', watches.concat([leanEdge, passCal]).every((d) => (d.bet_trigger && d.bet_trigger.options || []).filter((x) => x.realistic).every((x) => {
  const o = Q.priceQuote(model(d === leanEdge ? 5 : (d === passCal ? 7.5 : (d === watchPrice ? 4 : 5.8)), d === leanEdge ? 4.8 : (d === passCal ? 7.3 : (d === watchPrice ? 4.4 : 5.6))), { game_id: 'g1', side: d.side_key, line: x.line, american: x.odds, book: 'X', captured_at: FRESH, fresh: true }, { now: NOW, game: { game_id: 'g1' }, main_line_for_side: x.line });
  const m = D.metricsOf(o); return m && m.edge_pp >= 4 - 1e-6 && m.ev >= 0.05 - 1e-9; })));
chk('F: the same disagreement is WATCH while its trigger is realistic…', watchPrice.decision === 'WATCH' && watchPrice.action_reason_code === 'MODEL_MARKET_DISAGREEMENT' && watchPrice.bet_trigger.realistic === true);
const tight = D.decide(input({ quotes: mainQuotes(6.5, -125, -105) }), { trigger: { realistic_points: { CFB: 0.5, NFL: 0.5 }, realistic_cents: 5 } });
chk('F: …and PASS, with NO REALISTIC BET TRIGGER, once no realistic price turns it into a BET (WATCH never waits on nothing)', tight.decision === 'PASS' && tight.bet_trigger.realistic === false
  && /NO REALISTIC BET TRIGGER AT CURRENT MODEL STATE/.test(top(U.actionCardHTML(tight, { track: null }))) && tight.bet_trigger.options.length > 0, { d: tight.decision, c: tight.action_reason_code });
chk('PASS names the realistic trigger, or says there is none — never a fabricated one', [passCal, passAligned].every((d) => { const t = top(U.actionCardHTML(d, { track: null })); const o = (d.bet_trigger && d.bet_trigger.options || []).filter((x) => x.realistic); return /BEST AVAILABLE/.test(t) && /WHY/.test(t) && (o.length ? o.every((x) => t.indexOf(x.text) >= 0) : /NO REALISTIC BET TRIGGER AT CURRENT MODEL STATE/.test(t)); }));
chk('an unrealistic trigger is kept for the audit and never shown as the trigger', (() => { const t = D.betTrigger(input(), { side: 'away', team: 'NC State', line: 6.5, american_odds: -400, market_type: 'spread', is_main_line: true }, D.config()); return t && t.options.length > 0 && t.options.every((o) => o.realistic === (o.kind === 'line' ? o.move_pts <= 3 : o.move_cents <= 50)) && (t.realistic || t.text === VOC.COPY.no_realistic_trigger + '.'); })());
chk('a decision published before trigger options existed still shows its published trigger', (() => { const legacy = Object.assign({}, passCal, { bet_trigger: { short: 'NC State +8 (-110) or better', text: 'x' } }); return /NC State \+8 \(-110\)/.test(top(U.actionCardHTML(legacy, { track: null }))) && !/NO REALISTIC/.test(top(U.actionCardHTML(legacy, { track: null }))); })());
chk('LEAN names its BET AT price when one exists', (() => { const t = top(U.actionCardHTML(leanEdge, { track: null })); return leanEdge.decision === 'LEAN' && /BET AT/.test(t) && leanEdge.bet_trigger.options.filter((x) => x.realistic).every((x) => t.indexOf(x.text) >= 0) && /below EdgeDesk’s betting threshold/.test(t); })());

/* ======================================================================== */
section('G. NO DECISION only when essential information is missing');
const LAYER_A = ['INVALID_GAME', 'MAPPING_FAILED', 'DUPLICATE_GAME', 'GAME_CANCELLED', 'GAME_POSTPONED', 'GAME_SUSPENDED', 'GAME_STARTED', 'UNSUPPORTED_MARKET', 'DATA_FAULT',
  'MODEL_UNAVAILABLE', 'DISTRIBUTION_MISSING', 'MODEL_VERSION_UNKNOWN', 'MALFORMED_PROJECTION', 'SELF_CHECK_FAILED', 'IMPOSSIBLE_PROBABILITY', 'QB_PROJECTION_INVALID',
  'NO_MARKET', 'MARKET_SUSPENDED', 'STALE_QUOTE', 'FRESHNESS_UNKNOWN', 'CORRUPTED_ODDS', 'NO_VALID_QUOTE', 'ORIENTATION_FAULT'];
const optional = [dec({ model: model(4, null) }), dec({ reliability: null }), dec({ confidence: null }), dec({ qb: { known: false } }), dec({ availability: { known: false } }),
  dec({ quotes: [q('away', 6.5, -102)] }), dec({ projection: {} }), dec({ research: { status: 'LIMITED_DATA' } })];
chk('G: missing OPTIONAL data (calibration, reliability, confidence, QB, availability, one-sided market, stability) never produces NO DECISION', optional.every((d) => d.decision !== 'NO_DECISION'), optional.map((d) => d.decision + ':' + d.action_reason_code));
chk('G: every NO DECISION names an essential blocker from Layer A', [stale, noMarket, corrupted, dec({ model: { available: false } }), dec({ game: { state: 'IN_PROGRESS' } })].every((d) => d.decision === 'NO_DECISION' && d.blocker_codes.length && d.blocker_codes.every((c) => LAYER_A.indexOf(c) >= 0)));
chk('G: NO DECISION never says the model is young, calibration is accumulating, or EdgeDesk is cautious', ['NO_DECISION'].every((k) => !/young|accumulat|experimental|cautious/i.test(D.DECISIONS[k].headline + ' ' + VOC.DECISION[k].short)));

/* ======================================================================== */
section('H. I. J. K. only a BET is exposure');
const withUnits = (d, u) => Object.assign({}, d, { recommended_units: u, units: u });
const book = [bet, withUnits(lean, 0.5), withUnits(watchQb, 0.5), withUnits(passCal, 0.5), withUnits(noMarket, 0.5)];
const ex = BK.exposure(book, { bankroll_amount: 2500 });
chk('H: a PASS never counts, even carrying a units field', !BK.countsAsExposure(withUnits(passCal, 0.5)));
chk('I: a LEAN never counts', !BK.countsAsExposure(withUnits(lean, 0.5)));
chk('J: a WATCH (and a v1 WAIT) never counts', !BK.countsAsExposure(withUnits(watchQb, 0.5)) && !BK.countsAsExposure(Object.assign(withUnits(watchQb, 0.5), { decision: 'WAIT' })));
chk('K: only the BET is total exposure', ex.total_units === bet.recommended_units && ex.n_bets === 1 && ex.total_dollars === bet.recommended_units * 25, { t: ex.total_units, n: ex.n_bets });
chk('K: …by sport, by kickoff window and by market too', Object.keys(ex.by_sport).length === 1 && ex.by_sport.CFB.units === bet.recommended_units && Object.keys(ex.by_market).join() === 'spread' && Object.keys(ex.by_window).length === 1);
chk('K: NO DECISION never counts', !BK.countsAsExposure(withUnits(noMarket, 1)));
chk('K: a decision object claiming source "placed" still needs to be a BET', !BK.countsAsExposure(Object.assign(withUnits(lean, 0.5), { source: 'placed' })) && BK.countsAsExposure({ source: 'placed', units: 0.5 }));
/* The Card counts only games that have not kicked off, by the REAL clock
   (EDOpportunity.cardExposure → isOpen). This page used to render the fixture's
   fixed KICK, so the suite went red the moment KICK passed (19:30 UTC on
   2026-10-03): the BET dropped out and exposure read 0.00U. The page gets a
   kickoff ahead of whenever the suite runs. */
const LATER = new Date(Date.now() + 6 * 3600e3).toISOString();
const cardPage = U.cardPageHTML(book.map((d, i) => Object.assign({}, d, { game_id: 'x' + i, kickoff: LATER })), { view: { filter: 'all', sort: 'kickoff' } });
chk('K: the card header’s exposure is the BET’s alone', new RegExp('<b>' + bet.recommended_units.toFixed(2) + 'U</b><span>TOTAL EXPOSURE').test(cardPage), text(cardPage).slice(0, 300));
chk('the card header: BET and exposure first, LEAN and WATCH second, PASS and NO DECISION subdued', cardPage.indexOf('edd-kpi-main') < cardPage.indexOf('edd-kpis-2') && cardPage.indexOf('edd-kpis-2') < cardPage.indexOf('edd-kpis-3') && /<b>1<\/b> pass/.test(cardPage) && /no decision/.test(cardPage));
chk('the exposure block says what it counts: TOTAL · BY SPORT · BY KICKOFF WINDOW · BY MARKET', /EXPOSURE <small>active BET decisions only/.test(cardPage) && /Total/.test(cardPage) && /By sport/.test(cardPage) && /By kickoff window/.test(cardPage) && /By market/.test(cardPage));

/* ======================================================================== */
section('L. M. calibrated EV decides; raw EV is diagnostic');
const rawOnly = dec({ model: model(12, 6.5), quotes: mainQuotes(6.5, -110, -110) });
chk('L: a huge raw EV with no calibrated edge is not a BET', rawOnly.raw_ev_pct > 20 && rawOnly.decision !== 'BET' && rawOnly.decision_ev_pct === rawOnly.calibrated_ev_pct, { raw: rawOnly.raw_ev_pct, cal: rawOnly.calibrated_ev_pct, d: rawOnly.decision });
chk('L: …and the card says why that raw EV is not actionable', /Raw model EV \+[\d.]+% is not actionable/.test(top(U.actionCardHTML(rawOnly, { track: null }))), top(U.actionCardHTML(rawOnly, { track: null })).slice(0, 500));
/* raw WF by 5 against WF -6.5 (NC State +6.5 at +3.6%, under the BET line); calibrated WF by 3.5, the same side, clears */
const calOnly = dec({ model: model(5, 3.5), quotes: mainQuotes(6.5, -110, -110) });
chk('M: a calibrated edge that clears decides BET even when the raw one would not', calOnly.decision === 'BET' && calOnly.calibrated_ev_pct >= 5 && calOnly.raw_ev_pct < 5 && calOnly.decision_ev_pct === calOnly.calibrated_ev_pct, { d: calOnly.decision, cal: calOnly.calibrated_ev_pct, raw: calOnly.raw_ev_pct });
/* audit 2026-09-30 #4: a calibration that carries the number ACROSS the line
   (displayed WF by 5 = NC State's side of WF -6.5; calibrated WF by 9.5 = WF's
   side) prices the other side from a projection nobody is shown — the side
   invariant fails it loudly: NO DECISION, never a BET on WF */
const crossed = (() => { const ce = console.error; console.error = () => {}; try { return dec({ model: model(5, 9.5), quotes: mainQuotes(6.5, -110, -110) }); } finally { console.error = ce; } })();
chk('M: a calibration that crosses the market line against the displayed projection = NO DECISION · EV SIDE CONTRADICTION, never a BET', crossed.decision === 'NO_DECISION' && crossed.blocker_codes[0] === 'EV_SIDE_CONTRADICTION' && /EV SIDE CONTRADICTION/.test(crossed.action_reason_text), { d: crossed.decision, b: crossed.blocker_codes, t: crossed.action_reason_text });
chk('M: with a calibration, the decision EV IS the calibrated EV on every evaluable fixture', evaluable.filter((d) => d.calibrated_ev_pct != null).every((d) => d.decision_ev_pct === d.calibrated_ev_pct));
chk('M: raw EV beside a calibration is labelled RAW MODEL EV · Diagnostic only; the decision EV CALIBRATED EV · Used by the decision engine',
  /RAW MODEL EV \+[\d.]+% Diagnostic only/.test(text(U.actionCardHTML(bet, { track: null }))) && /CALIBRATED EV \+[\d.]+% Used by the decision engine/.test(text(U.actionCardHTML(bet, { track: null }))));
const est = dec({ model: model(4, null) });
chk('M: without a calibration the decision EV is MODEL-ESTIMATED EV (no raw number posing beside it)', est.probability_source === 'model_estimated' && /MODEL-ESTIMATED EV/.test(text(U.actionCardHTML(est, { track: null }))) && !/RAW MODEL EV/.test(text(U.actionCardHTML(est, { track: null }))));
chk('M: raw EV never sizes a stake', bet.sizing && bet.sizing.tiers.every((t) => t.why.every((w) => !/raw/i.test(w))));

/* ======================================================================== */
section('N. the quote shown is the quote priced');
chk('N: the canonical quote carries event, market, selection, line, odds, sportsbook, capture time, freshness, orientation, verification and source',
  ['event_id', 'market_type', 'selection', 'line', 'odds', 'sportsbook', 'captured_at', 'freshness', 'orientation', 'verification_state', 'source'].every((k) => k in bet.quote), Object.keys(bet.quote));
chk('N: the canonical quote is the selected line, odds and book', evaluable.every((d) => d.quote.line === d.selected_line && d.quote.odds === d.selected_odds && d.quote.sportsbook === d.selected_book));
chk('N: its EV is EDQuoteEV’s at that exact quote, raw and calibrated', evaluable.filter((d) => d.market_type === 'spread').every((d) => {
  const src = d === passCal ? model(7.5, 7.3) : (d === passAligned ? model(6.5, 6.5) : (d === leanEdge ? model(5, 4.8) : model(4, 4.4)));
  const o = Q.priceQuote(src, { game_id: 'g1', side: d.side_key, line: d.quote.line, american: d.quote.odds, book: d.quote.sportsbook, captured_at: d.quote.captured_at, fresh: true }, { now: NOW, game: { game_id: 'g1' } });
  return Math.abs(o.expected_value_pct - d.raw_ev_pct) < 0.01 && (d.calibrated_ev_pct == null || Math.abs(100 * o.adjusted.expected_value - d.calibrated_ev_pct) < 0.01); }));
chk('N: the card prints that same selection, price and book at the top', evaluable.every((d) => { const t = top(U.actionCardHTML(d, { track: null })); return t.indexOf(D.priceText(d.quote.odds)) >= 0 && t.indexOf(d.quote.sportsbook) >= 0; }));

/* ======================================================================== */
section('O. PLAYABLE TO stays inside the BET threshold');
const bets = [bet, calOnly, dec({ model: model(9.5, 9.4), quotes: mainQuotes(6.5, -110, -110) })].filter((d) => d.decision === 'BET' && d.playable);
function clears(d, line, odds, src) { const o = Q.priceQuote(src, { game_id: 'g1', side: d.side_key, line, american: odds, book: 'X', captured_at: FRESH, fresh: true }, { now: NOW, game: { game_id: 'g1' }, main_line_for_side: line }); const m = D.metricsOf(o); return !!m && m.edge_pp >= 4 - 1e-7 && m.ev >= 0.05 - 1e-9; }
const srcOf = (d) => d === bet ? model(4, 4.4) : (d === calOnly ? model(5, 3.5) : model(9.5, 9.4));
chk('O: several BETs with a playable boundary', bets.length >= 2, bets.length);
chk('O: the PLAYABLE TO corner (worst line, worst price there) clears the BET threshold', bets.every((d) => clears(d, d.playable.min_line, d.playable.max_odds, srcOf(d))), bets.map((d) => d.playable.text));
chk('O: one cent worse at the corner does not', bets.every((d) => d.playable.max_odds <= -250 || !clears(d, d.playable.min_line, d.playable.max_odds < 0 ? d.playable.max_odds - 1 : (d.playable.max_odds === 100 ? -101 : d.playable.max_odds - 1), srcOf(d))));
chk('O: the card’s PLAYABLE TO is that corner', bets.every((d) => top(U.actionCardHTML(d, { track: null })).indexOf(D.lineText(d.playable.min_line) + ' / ' + D.priceText(d.playable.max_odds)) >= 0 || d.playable.mode === 'CURRENT_PRICE_ONLY'));

/* ======================================================================== */
section('P. Q. beginner and advanced');
const BEG_HIDDEN = [/RAW MODEL EV/, /Raw model EV/, /shadow/i, /\bp10\b/, /sigma|σ/, /PRICE VERIFICATION/, /STAKE TIERS/, /reasons [A-Z_]/, /engine edgedesk_football/, /DECISION CONFIDENCE \d+\/100 </, /coefficient/i, /p-value|binom/i];
const begCards = Object.keys(ALL).map((k) => U.actionCardHTML(ALL[k], { track: null, beginner: true }));
chk('P: beginner mode hides raw EV, shadow, verification checks, stake-tier trails, reason codes and versions', begCards.every((h) => BEG_HIDDEN.every((re) => !re.test(text(h)))), begCards.map((h) => BEG_HIDDEN.filter((re) => re.test(text(h))).map(String)));
chk('P: beginner mode hides the research-status implementation detail and the layer strip', begCards.every((h) => !/data-edd-layers/.test(h) && !/<details class="edd-reason"/.test(h)));
const begBet = text(U.actionCardHTML(bet, { track: null, beginner: true }));
chk('P: a beginner BET still answers decision · selection · price · book · units · playable to · calibrated EV · edge · confidence · why',
  ['BET', 'NC State +6.5', '-102', 'FanDuel', '0.50U', 'PLAYABLE TO', 'CALIBRATED EV', 'EDGE', 'CONFIDENCE', 'WHY'].every((w) => begBet.indexOf(w) >= 0), begBet);
chk('P: a beginner WATCH / PASS keeps the BET trigger', /BET TRIGGER/.test(text(U.actionCardHTML(watchPrice, { beginner: true, track: null }))) && /BET TRIGGER/.test(text(U.actionCardHTML(passCal, { beginner: true, track: null }))));
chk('P: beginner mode offers the advanced view', begCards.every((h) => /data-edd-act="advanced"/.test(h)));
const adv = text(U.actionCardHTML(Object.assign({}, sign), { track: null, beginner: false }));
chk('Q: advanced mode keeps every diagnostic', ['RAW MODEL EV', 'MODEL COVER', 'BREAK-EVEN', 'MODEL FAIR', 'RELIABILITY', 'MARKET QUALITY', 'PROJECTION', 'LINES EVALUATED', 'PRICE VERIFICATION', 'DECISION CONFIDENCE', 'EVALUATED QUOTE', 'engine edgedesk_football_decision_v2'].every((w) => adv.indexOf(w) >= 0), adv.slice(0, 400));
chk('Q: the full research below the card is untouched: every game-card section still renders', ['forensic', 'why', 'proj', 'changed', 'best', 'price', 'alts', 'matchup', 'research', 'decomp', 'pricing', 'venue', 'drivers', 'wrong', 'personnel', 'qb', 'cases', 'scale', 'dq', 'scen', 'explain', 'watch', 'detail', 'edr', 'quality']
  .every((id) => APP.indexOf("fbGxSec(gid,'" + id + "'") >= 0));

/* ======================================================================== */
section('R. an extreme alternate never becomes "best available"');
const wild = [q('away', 6.5, -110), q('home', -6.5, -110), q('away', 6.5, -108, { book: 'DraftKings' }), q('home', -6.5, -112, { book: 'DraftKings' }),
  q('away', 28.5, -10000, { book: 'Outlier' }), q('home', -28.5, 2500, { book: 'Outlier' }), q('away', 20.5, -2000, { market_type: 'alternate_spread', book: 'DraftKings' })];
const G = Q.evaluateGame(model(4, 4.4), wild, { now: NOW, game: { game_id: 'g1', home: 'Wake Forest', away: 'NC State' } });
chk('R: a "spreads" row 22 pts off the consensus is priced as an alternate', G.sides.away.quotes.filter((o) => o.line === 28.5)[0].is_main_line === false && G.sides.away.quotes.filter((o) => o.line === 28.5)[0].off_market_main === true);
chk('R: the side’s BEST LINE / BEST PRICE / BEST EV are the consensus number', G.sides.away.best_line.line === 6.5 && G.sides.away.best_price.line === 6.5 && G.sides.away.best_ev.line === 6.5 && G.best_ev_quote.line !== 28.5);
const wd = D.decide(input({ quotes: wild, market: { n_books_fresh: 2 } }));
chk('R: the decision’s BEST CURRENT PRICE is the best book at the exact line evaluated', wd.best_current_price && wd.best_current_price.line === (wd.bet_price || wd.reference_quote).line && wd.best_current_price.odds >= -300, wd.best_current_price);
chk('R: no alternate beside the recommendation is extreme or far away', ['best_playable_alternate', 'safer_alternate', 'better_value', 'main'].every((k) => { const x = wd.alternatives && wd.alternatives[k]; return !x || (Math.abs(x.odds) <= 300 || x.odds === null) && Math.abs(x.line - (wd.bet_price || wd.reference_quote).line) <= 3; }), wd.alternatives);
chk('R: the recommendation itself is never the -10000 row', (wd.bet_price || wd.reference_quote).odds > -300);
chk('R: a SAFER ALTERNATE is a different, more-cushioned line — never the same number at a worse price', !wd.safer_value || wd.safer_value.line > (wd.bet_price || wd.reference_quote).line);
const altsD = dec({ quotes: mainQuotes(6.5, -102).concat([q('away', 7.5, -125, { market_type: 'alternate_spread' }), q('away', 8, -135, { market_type: 'alternate_spread' }), q('away', 12.5, -400, { market_type: 'alternate_spread' })]) });
chk('R: with nearby alternates on the board, the safer one is nearby and executable; -400 never qualifies', !altsD.safer_value || (altsD.safer_value.line <= 9.5 && altsD.safer_value.odds >= -300), altsD.safer_value);
const BA = RV.bestAvailable([{ side: 'away', line: 6.5, price_dec: 1.909, book: 'FanDuel', actionable: true, n_books: 3 }, { side: 'away', line: 28.5, price_dec: 1.01, book: 'Outlier', actionable: true, n_books: 1 },
  { side: 'home', line: -6.5, price_dec: 1.909, book: 'FanDuel', actionable: true, n_books: 3 }], { display_side: 'away' }, null, { home: 'Chicago Bears', away: 'Detroit Lions' });
chk('R: the research view’s best available line is never +28.5 (-10000)', BA.available && BA.away.line === 6.5 && BA.excluded.off_market === 1, BA);
chk('R: the page’s quote-EV row names an alternate only at an executable price near the number', /function fbQevExecutable\(o,ref\)/.test(APP) && /fbQevExecutable\(L\.max_ev,b\)/.test(APP));

/* ======================================================================== */
section('S. research ranking and the bet decision stay independent');
const byResearch = ['WORTH_RESEARCHING', 'MARKET_ALIGNED', 'NEAR_PICKEM', 'VERIFIED_MAJOR'].map((st) => dec({ research: { status: st, label: st, verification: st === 'VERIFIED_MAJOR' ? 'VERIFIED' : 'NOT_REQUIRED' } }));
chk('S: the same price decides the same way under any non-fault research status', byResearch.every((d) => d.decision === bet.decision && d.recommended_units === bet.recommended_units), byResearch.map((d) => d.decision));
chk('S: WORTH RESEARCHING with no priced edge is a PASS', dec({ research: { status: 'WORTH_RESEARCHING' }, model: model(6.5, 6.5), quotes: mainQuotes(6.5, -110, -110) }).decision === 'PASS');
chk('S: the decision carries the research status apart, never inside its class', bet.research_status === 'WORTH_RESEARCHING' && D.DECISION_KEYS.indexOf(bet.research_status) < 0);
function cand(o) { return Object.assign({ key: 'cfb|1', sport: 'cfb', home: 'Florida', away: 'Ole Miss', kickoff: Date.parse('2026-09-26T16:00:00Z'), status: 'RESEARCH', projected: true, model_margin: -4.1, market_margin: 2, normalized_gap: 0.35,
  market: { kind: 'live', age_h: 1.5, stale: false, source: 'captured · DraftKings' }, fault: false, thin: false, completeness: 0.85, flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'], qualifiers: [],
  model_total: 52.1, market_total: 50.5, total_gap: 1.6, movement: { spread_moved: null, spread_toward_model: null, h2h_pp: null }, qb_unknown: false }, o || {}); }
const cands = [cand({ key: 'a', normalized_gap: 0.5 }), cand({ key: 'b', normalized_gap: 0.3 }), cand({ key: 'c', normalized_gap: 0.4 })];
const r1 = P.rank(cands, 5).items.map((x) => x.candidate.key);
const r2 = P.rank(cands.map((c, i) => Object.assign({}, c, { decision: ['BET', 'PASS', 'LEAN'][i], recommended_units: [1, 0, 0][i] })), 5).items.map((x) => x.candidate.key);
chk('S: the research ranking reads no decision field (adding BET / PASS / LEAN changes nothing)', r1.join() === r2.join() && r1.length === 3, { r1, r2 });
chk('S: the Top 5 is titled a research priority, not bet quality', /TOP RESEARCH PRIORITIES/.test(VOC.COPY.top_research_title) && /This is not a ranking of bets\./.test(VOC.COPY.top_research_sub) && APP.indexOf('VW.COPY.top_research_title') >= 0);
chk('S: a research status is styled apart from a decision (dotted, sentence case) on the card and the game summary', /edd-rs/.test(U.actionCardHTML(bet, { track: null })) && /\.gx-st\.gx-rs\{border-style:dotted/.test(APP) && /class="gx-st gx-rs /.test(APP));
chk('S: the research link on the card shows a research status, never a decision word', /function fbTermLink\(gid,rv\)/.test(APP) && !/fbEsc\(r\.status_label\)/.test(slice('function fbTermLink(gid,rv){', 'function fbP4Card(u){')));

/* ======================================================================== */
section('unit tiers, performance and positioning');
chk('a BET’s stake reads CURRENT conservative rule until its tier has 50 settled bets', /Current conservative sizing rule · 0 of 50 settled bets/.test(text(U.actionCardHTML(bet, { track: null }))) && VOC.unitRuleOf(49, true).validated === false && VOC.unitRuleOf(50, true).validated === true && VOC.unitRuleOf(80, false).validated === false);
const perf0 = { min_n: 50, all: { settled: 0 }, by_tier: ['0.25U', '0.50U', '0.75U', '1.00U'].map((g) => ({ group: g, bets: 0, settled: 0 })) };
chk('performance zero-state: NO SETTLED BETS YET, no table of dashes', /NO SETTLED BETS YET/.test(U.performanceHTML(perf0)) && !/<table/.test(U.performanceHTML(perf0)) && /Unit tiers remain conservative defaults/.test(U.performanceHTML(perf0)));
const perf1 = { min_n: 50, all: { settled: 3 }, by_tier: [{ group: '0.25U', bets: 3, settled: 3, units_risked: 0.75, units_won: 0.2, roi: 0.27, average_clv: 0.5, observed_cover_rate: 0.667, expected_cover_rate: 0.55 }] };
chk('performance with settled bets: the table, every column', ['Tier', 'Bets', 'Units risked', 'Units won', 'ROI', 'Avg CLV', 'Observed cover', 'Expected cover'].every((w) => U.performanceHTML(perf1).indexOf('<th>' + w + '</th>') >= 0) && /3 of 50 settled/.test(U.performanceHTML(perf1)));
chk('positioning: the app’s persistent line names decision support, and research status stays “not a bet signal”', /Research and decision-support tool\./.test(APP) && !/Research tool only — not betting advice/.test(APP) && /not a bet signal/.test(U.actionCardHTML(bet, { track: null })));
chk('positioning: no card uses tout language', Object.keys(ALL).every((k) => U.copyOk(U.actionCardHTML(ALL[k], { track: null })) && U.copyOk(U.actionCardHTML(ALL[k], { track: null, beginner: true }))));

console.log('');
if (fail) { failures.forEach((f) => console.log('FAIL | ' + f)); console.log('FAILED consistency — ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
console.log('ALL GREEN consistency — ' + pass + ' passed, 0 failed');
