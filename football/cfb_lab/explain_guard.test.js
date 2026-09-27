#!/usr/bin/env node
/* ===========================================================================
   The AI explanation fact boundary (supabase/functions/edgedesk_ai/
   _cfb_explain.js; brief §90-91). Known answers:

   - the facts are built from the STORED snapshot (a real Model Lab row
     shape, or the stored canonical projection) and carry nothing else: no
     params hash, no inputs_ref, no raw row;
   - the official status is the governed policy's (cfb_decision_policy_v1)
     only: the Model Lab's stage-8 status is research (audit F-22), and
     "edge / bet quality" wording is refused (audit F-23);
   - the prompt forbids tools and browsing, names the official status, and
     states the uncertainty;
   - the audit refuses: BET claimed on a PASS; a status word that is not the
     official one; "QB confirmed" when the source does not say CONFIRMED; a
     number not in the facts; a reversed side; a metric the facts do not
     carry (EPA, CLV, sharp money, injuries); promise language; a degraded
     prediction presented with no uncertainty;
   - a faithful explanation passes; the deterministic rendering passes its own
     audit for every status / QB / market combination;
   - explain(): refused LLM text is replaced by the deterministic text, and
     the status and side always come from the facts.

   Run: node football/cfb_lab/explain_guard.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const X = require(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));
const CP = require('./checkpoint.js');
const L = require('./lab_core.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }

/* a real snapshot row, built by the lab's own builder */
const K = '2026-10-10T19:30:00.000Z', NOW = '2026-10-09T21:00:00.000Z';
function snapshot(o) {
  o = o || {};
  const margin = o.margin == null ? 7 : o.margin;
  const P = { model_version: 'edgedesk_cfb_v2.1.0', model_label: 'V2.1', engine_id: 'e', projection_computed_at: NOW, feature_ts: NOW, feature_version: 'fv', calibration_version: 'cv', ensemble_version: 'ev', params_hash: 'SECRET_PARAMS_HASH',
    game: { game_id: '401', season: 2026, week: 6, home: 'Texas', away: 'Oklahoma', home_id: '251', away_id: '201', neutral_site: false, kickoff: K },
    pure: { margin, total: 55, p_home: o.p_home == null ? 0.68 : o.p_home, sigma: 15, t_df: 100, intervals: { 50: [margin - 10, margin + 10], 80: [margin - 19, margin + 19], 95: [margin - 29, margin + 29] }, home_pts: 31, away_pts: 24, confidence_raw: 80, ens_sd: 1 },
    components: null, state: {}, explain: {}, inputs: { current_sha256: 'x' },
    slateGame: { home_starter: o.qbHome === undefined ? { player_id: '1', player_name: 'Arch Manning', status: 'PREVIOUS_GAME', confirmed: false } : o.qbHome,
      away_starter: { player_id: '2', player_name: 'John Mateer', status: 'CONFIRMED', confirmed: true }, input_contract: [] } };
  const market = o.noMarket ? L.marketAt([], NOW, K) : L.marketAt([{ quote_id: 'q', source: 'espn', book: 'dk', market_type: 'spread', home_line: o.line == null ? -3.5 : o.line, price_home: -110, price_away: -110, observed_at: '2026-10-09T20:00:00.000Z', is_pregame: true }], NOW, K);
  const decision = { status: o.status || 'PASS', side: o.side === undefined ? 'HOME' : o.side, decision_source: 'engine', reason: o.reason || 'insufficient edge after calibration and vig', cover_probability: 0.54, bet_enabled: !!o.bet };
  return CP.buildRow(P, 'T24', true, market, decision, o.dq || { status: 'GREEN', checks: [] }, { now: NOW, role: 'champion', origin: 'LIVE',
    integrity: o.integrity || { rule: 'r', status: 'DEGRADED', actionable_status: 'MARKET_DEGRADED', reasons: ['1 book'], n_books: 1 } });
}
/* the governed decision (cfb_decision_policy_v1, decision.js): the only official status (audit F-22) */
const OFF = (status, o) => Object.assign({ status, basis: 'cfb_decision_policy_v1 (cfb_decision_engine_v1, SHADOW, betting disabled)', side: 'HOME', line_for_side: -3.5, price: -110,
  decision_cover_probability: 0.54, reason: 'insufficient edge after calibration and vig' }, o || {});
const pass0 = X.cfbFacts(snapshot(), OFF('PASS'));

/* ═══ 1. the facts ═══════════════════════════════════════════════════════ */
chk('facts: the official status, side and line come from the governed decision', pass0.decision.status === 'PASS' && pass0.decision.side === 'HOME' && pass0.decision.line === -3.5, pass0.decision);
/* F-22: the Model Lab's stage-8 class is research, never the official status */
const leanRow = snapshot({ status: 'LEAN' });
const leanF = X.cfbFacts(leanRow);
chk('F-22: a Model Lab row\'s stage-8 LEAN is never the official status (no governed decision -> NO BET)', leanRow.decision_class === 'LEAN' && leanF.decision.status === 'NO BET' && /no governed decision/.test(leanF.decision.reason), leanF.decision);
chk('F-22: the prompt names NO BET, not the stage-8 LEAN', /official decision is NO BET/.test(X.buildPrompt(leanF).system) && !/official decision is LEAN/.test(X.buildPrompt(leanF).system));
chk('F-22: an explanation repeating the stage-8 LEAN is refused', X.auditExplanation('This is a LEAN on Texas; the QB is not confirmed.', leanF).issues.some((i) => i.code === 'STATUS_MISMATCH'));
chk('F-22: a stage-8 engine.decide() output passed as the decision is not governed (refused)', X.cfbFacts({ pure: { home: 'Texas', away: 'Oklahoma', projected_margin: 7, home_win_prob: 0.68 },
  decision: { layer: 'market_decision_projection', status: 'LEAN', side: 'HOME' } }).decision.status === 'NO BET');
chk('F-22: a decision.js output under policy v1 is governed', X.cfbFacts({ pure: { home: 'Texas', away: 'Oklahoma', projected_margin: 7, home_win_prob: 0.68 },
  decision: { engine: 'edgedesk_cfb_decision', engine_version: 'cfb_decision_engine_v1', policy_version: 'cfb_decision_policy_v1', status: 'LEAN', side: 'HOME', line_for_side: -3.5, reason_codes: ['NO_BET_BETTING_DISABLED'] } }).decision.status === 'LEAN');
/* audit F-30: a governed BET crosses only when the decision says betting is on */
const betOff = X.cfbFacts(snapshot(), OFF('BET'));
chk('F-30: a governed BET while betting is disabled is refused: the facts say NO BET and why',
  betOff.decision.status === 'NO BET' && betOff.decision.refused === 'BET_WHILE_BETTING_DISABLED' && /betting is disabled/.test(betOff.decision.reason)
  && betOff.decision.bet_enabled === false, betOff.decision);
chk('F-30: the refused case still renders text that passes its own audit', X.auditExplanation(X.render(betOff), betOff).ok === true, X.auditExplanation(X.render(betOff), betOff));
chk('F-30: the prompt never hands the model a BET that betting-disabled refused', !/official decision is BET/.test(X.buildPrompt(betOff).system));
chk('F-30: a governed BET that carries bet_enabled crosses as BET', X.cfbFacts(snapshot(), OFF('BET', { bet_enabled: true })).decision.status === 'BET');
/* the research terminal's page status crosses as a RESEARCH status, never as a decision; its BET never crosses ungoverned */
const termSrc = (st) => ({ pure: { home: 'Texas', away: 'Oklahoma', projected_margin: 7, home_win_prob: 0.68 }, decision: { status: st, side: 'HOME', reasons: ['a named reason'], bet_enabled: false } });
const tw = X.cfbFacts(termSrc('WAIT'));
chk('terminal: a WAIT page status crosses as a research status, labelled so in the prompt and the text', tw.decision.status === 'WAIT' && tw.decision.kind === 'RESEARCH_STATUS'
  && /research status the page shows is WAIT \(research, not a wager\)/.test(X.buildPrompt(tw).system) && /Research status: WAIT/.test(X.render(tw)) && X.auditExplanation(X.render(tw), tw).ok, X.auditExplanation(X.render(tw), tw).issues);
chk('terminal: an ungoverned BET page status is NO BET at the boundary', X.cfbFacts(termSrc('BET')).decision.status === 'NO BET');
chk('terminal: DATA_FAULT and NO_MARKET cross as their page words', X.cfbFacts(termSrc('DATA_FAULT')).decision.status === 'DATA FAULT' && X.cfbFacts(termSrc('NO_MARKET')).decision.status === 'NO MARKET');
chk('terminal: a stage-8 output (it carries layer) is never taken as a research status', X.cfbFacts({ pure: {}, decision: { layer: 'market_decision_projection', status: 'RESEARCH' } }).decision.status === 'NO BET');
/* the stored canonical projection (projections.json entry) is a fact source too */
const CANON = require('../cfb_production/canonical.js');
const crow = { game_id: 9, season: 2026, week: 6, home: 'Texas', away: 'Oklahoma', home_id: 251, away_id: 201, kickoff: K, prediction_ts: NOW, feature_ts: NOW, ens_pred: 7, sigma: 15.5,
  fair_total: 52, ens_sd: 2, rating_sd_sum: 1.1, min_games: 5, early_season: false, qb: { home: null, away: {} }, qb_missing_any: 1, qb_unsettled_any: 0, priced: true, fcs_game: false,
  neutral_site: false, components: { C_ridge: 7, D_gbm: 7 } };
const entry = { canonical: CANON.snapshot(crow, { as_of_ts: NOW, context: { market_integrity: null } }), market: { home_line: -3.5, books: 1, actionable_status: 'MARKET_DEGRADED' },
  official_decision: { status: 'NO_DECISION', basis: 'cfb_decision_policy_v1', reason: 'no governed decision for this game yet' } };
const cf = X.cfbFacts(entry);
chk('facts from the stored canonical projection: its numbers, its degraded modes in words, NO BET when no governed decision', cf.model.home_margin === 7 && cf.model.fair_line_display === 'Texas -7.0'
  && cf.decision.status === 'NO BET' && cf.degraded.indexOf('a starting quarterback is not confirmed') >= 0 && X.auditExplanation(X.render(cf), cf).ok, [cf.decision, cf.degraded]);
/* F-23: the P(positive CLV) tiers rank closing-line movement, not bet quality */
chk('F-23: "edge quality" / "bet quality" wording is refused as an unsupported metric', ['The edge quality is HIGH.', 'A high-quality bet.', 'Bet quality: MEDIUM.'].every((t) => X.auditExplanation(t + ' NO BET; uncertain.', cf).issues.some((i) => i.code === 'UNSUPPORTED_METRIC')));
chk('facts: home margin, fair line, probability and the 80% interval', pass0.model.home_margin === 7 && pass0.model.fair_line_display === 'Texas -7.0' && pass0.model.home_win_probability === 0.68 && pass0.model.interval_80.join() === '-12,26');
chk('facts: QB status is CONFIRMED only when the source says so (Texas: last game\'s starter -> PROBABLE; Oklahoma: CONFIRMED)', pass0.qb.home.status === 'PROBABLE' && pass0.qb.away.status === 'CONFIRMED');
chk('facts: the market carries its integrity status; the degraded modes are listed', pass0.market.actionable_status === 'MARKET_DEGRADED' && pass0.degraded.some((x) => /quarterback/.test(x)) && pass0.degraded.some((x) => /MARKET_DEGRADED/.test(x)));
const blob = JSON.stringify(X.buildPrompt(pass0));
chk('facts: nothing else crosses (no params hash, no inputs_ref, no row id)', !/SECRET_PARAMS_HASH|inputs_ref|prediction_id|row_hash|current_sha256/.test(blob), blob.slice(0, 200));

/* ═══ 2. the prompt ═════════════════════════════════════════════════════ */
const pr = X.buildPrompt(pass0);
chk('prompt: no tools, no browsing, only the FACTS block', pr.tools.length === 0 && /Do not browse, search, call tools/.test(pr.system) && /Use ONLY the facts/.test(pr.system));
chk('prompt: names the official decision and forbids calling a non-BET a bet', /official decision is PASS/.test(pr.system) && /Never call a non-BET a bet/.test(pr.system));
chk('prompt: states the uncertainty it must disclose', /State the uncertainty plainly: .*quarterback/.test(pr.system));
chk('prompt: states the sign convention', /positive means the home team is expected to win/.test(pr.system));

/* ═══ 3. the audit: refusals ═══════════════════════════════════════════ */
const codes = (t, f) => X.auditExplanation(t, f || pass0).issues.map((i) => i.code);
const good = 'EdgeDesk projects Texas by 7 as the home margin, a 68% home win probability; the market home line is -3.5. The official decision is PASS, and the Texas quarterback is not confirmed, so there is real uncertainty.';
chk('a faithful explanation passes', X.auditExplanation(good, pass0).ok, X.auditExplanation(good, pass0).issues);
chk('refused: "BET Texas -3.5" when the official decision is PASS', codes('Strong bet: take Texas -3.5 now. The QB is not confirmed.').includes('BET_CLAIM_NOT_OFFICIAL'));
chk('refused: the status word BET on a PASS', codes('BET on Texas. Uncertain QB.').includes('BET_CLAIM_NOT_OFFICIAL'));
chk('refused: "we recommend Texas" on a PASS', codes('We recommend Texas at -3.5 despite the unconfirmed quarterback.').includes('BET_CLAIM_NOT_OFFICIAL'));
chk('refused: a status word that is not the official one (LEAN on a PASS)', codes('This is a LEAN on Texas; the QB is unknown.').includes('STATUS_MISMATCH'));
chk('refused: "QB confirmed" when the Texas status is only PROBABLE', codes('Arch Manning is confirmed as the Texas starter, and the official decision is PASS with uncertainty.').includes('QB_CONFIRMED_CLAIM'));
chk('refused: "Texas quarterback will start" is also a confirmation claim', codes('The Texas quarterback will start. PASS; uncertainty remains.').includes('QB_CONFIRMED_CLAIM'));
chk('allowed: the CONFIRMED Oklahoma starter may be called confirmed', !codes('John Mateer is confirmed for Oklahoma, but the Texas quarterback is not confirmed; PASS.').includes('QB_CONFIRMED_CLAIM'));
chk('refused: a number that is not in the facts (a 62% cover probability)', codes('Texas covers 62% of the time; PASS; uncertain.').includes('NUMBER_NOT_IN_FACTS'));
chk('refused: an invented line (Texas -10.5)', codes('The model makes it Texas -10.5; PASS; the QB is unconfirmed.').includes('NUMBER_NOT_IN_FACTS'));
chk('refused: a reversed side ("Oklahoma -7" when the model favours Texas by 7)', codes('The model makes Oklahoma -7; PASS; uncertain quarterback.').includes('SIDE_REVERSED'));
chk('refused: calling the underdog the favourite', codes('Oklahoma is the favourite here; PASS; uncertainty about the quarterback.').includes('SIDE_REVERSED'));
chk('refused: a metric the facts do not carry (EPA)', codes('Texas has a big EPA per play edge; PASS; uncertain QB.').includes('UNSUPPORTED_METRIC'));
chk('refused: sharp money, CLV, injuries, weather', ['Sharp money is on Texas.', 'Expect positive CLV.', 'Injuries hurt Oklahoma.', 'Wind will matter.'].every((t) => codes(t + ' PASS; uncertain.').includes('UNSUPPORTED_METRIC')));
chk('refused: promise language', codes('Texas is a lock; PASS; uncertain.').includes('PROMISE_LANGUAGE') && codes('A guaranteed cover; PASS; uncertain.').includes('PROMISE_LANGUAGE'));
chk('refused: a degraded prediction with no uncertainty stated', codes('EdgeDesk projects Texas by 7 with a 68% home win probability. PASS.').includes('UNCERTAINTY_NOT_STATED'));
chk('football words are not status words ("pass defense")', !codes('Texas has the better pass defense; PASS; uncertain quarterback.').includes('STATUS_MISMATCH'));

/* ═══ 4. a real BET ═════════════════════════════════════════════════════ */
const betRow = snapshot({ status: 'BET', bet: true, qbHome: { player_id: '1', player_name: 'Arch Manning', status: 'CONFIRMED', confirmed: true },
  integrity: { rule: 'r', status: 'OK', actionable_status: 'ACTIONABLE', reasons: [], n_books: 3 } });
const betF = X.cfbFacts(betRow, OFF('BET', { bet_enabled: true }));
chk('a governed BET (market actionable) is a BET fact', betF.decision.status === 'BET' && betRow.decision_class === 'BET', [betF.decision.status, betRow.decision_class, betRow.pass_reason]);
chk('on a BET, saying BET is allowed', X.auditExplanation('BET: Texas -3.5 at -110; the model has Texas by 7. Any single game can lose.', betF).ok, X.auditExplanation('BET: Texas -3.5 at -110; the model has Texas by 7. Any single game can lose.', betF).issues);
chk('on a BET, saying NO BET is a status mismatch', codes('NO BET here.', betF).includes('STATUS_MISMATCH'));

/* ═══ 5. the deterministic rendering always passes ════════════════════ */
const variants = [snapshot(), snapshot({ status: 'LEAN' }), snapshot({ status: 'RESEARCH' }), snapshot({ margin: -10, line: 7, side: 'AWAY', p_home: 0.24 }), snapshot({ noMarket: true, side: null }),
  snapshot({ qbHome: null }), snapshot({ dq: { status: 'RED', checks: [{ check: 'team_mapping', status: 'RED', detail: 'swapped' }] } }), betRow, snapshot({ margin: 0, line: 0, p_home: 0.5, side: null })];
const offOf = (v) => (v.decision_class === 'PASS' ? OFF('PASS', { side: v.side }) : OFF(v.decision_class === 'BET' ? 'BET' : v.decision_class, { side: v.side, line_for_side: v.recommended_line }));
const fails5 = variants.map((v) => { const f = X.cfbFacts(v, offOf(v)); const t = X.render(f); const a = X.auditExplanation(t, f); return a.ok ? null : { t, issues: a.issues }; }).filter(Boolean)
  .concat(variants.map((v) => { const f = X.cfbFacts(v); const t = X.render(f); const a = X.auditExplanation(t, f); return a.ok ? null : { t, issues: a.issues, ungoverned: true }; }).filter(Boolean));
chk('render(): the deterministic text passes its own audit for every status, side, QB and market case (' + variants.length + ')', fails5.length === 0, fails5[0]);
const road = X.render(X.cfbFacts(snapshot({ margin: -10, line: 7, side: 'AWAY', p_home: 0.24 }), OFF('PASS', { side: 'AWAY', line_for_side: -7 })));
chk('render(): a road favourite names the favourite, the negative home margin and the away fair line', /projects Oklahoma by 10/.test(road) && /home margin of -10 for Texas/.test(road) && /Oklahoma -10\.0/.test(road), road);

/* ═══ 6. explain(): the LLM cannot change the decision ═════════════════ */
(async () => {
  const liar = async (p) => 'BET Texas -3.5! Arch Manning is confirmed. Sharp money agrees.';
  const r1 = await X.explain(pass0, liar);
  chk('explain(): a lying LLM is refused and replaced by the deterministic text', r1.source === 'deterministic' && r1.refused.some((i) => i.code === 'BET_CLAIM_NOT_OFFICIAL') && /Official decision: PASS/.test(r1.text), r1);
  chk('explain(): the status and side of the answer come from the facts', r1.status === 'PASS' && r1.side === 'HOME');
  let seen = null;
  const honest = async (p) => { seen = p; return good; };
  const r2 = await X.explain(pass0, honest);
  chk('explain(): a faithful LLM answer is kept', r2.source === 'llm' && r2.text === good);
  chk('explain(): the LLM is given no tools', seen && Array.isArray(seen.tools) && seen.tools.length === 0);
  const r3 = await X.explain(pass0, async () => { throw new Error('upstream 529'); });
  chk('explain(): an LLM failure falls back to the deterministic text', r3.source === 'deterministic' && r3.refused[0].code === 'LLM_ERROR');
  const r4 = await X.explain(pass0, null);
  chk('explain(): with no LLM at all the reader still gets the deterministic explanation', r4.source === 'deterministic' && /Texas/.test(r4.text));

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
