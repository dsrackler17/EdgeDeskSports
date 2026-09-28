#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the current-slate demonstrations (docs/edgedesk-ev/DELIVERABLE.md §46).

   Every demonstration is either REAL (the committed production slate:
   football/cfb_terminal/games.json, priced at its own build clock, with the
   pinned calibrator and policy — plus, where marked, a typed USER QUOTE on a
   real game) or a FIXTURE (the synthetic cases the test suite pins), and says
   which. A case the current slate cannot produce is never faked with real
   team names.

     node football/cfb_ev/demo.js            -> football/cfb_ev/reports/demo_v1.json (+ a table on stdout)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
const INTEG = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));

const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const NOW = Date.parse(G.generated_at), CFG = { artifact: G.ev.artifact, policy: G.ev.policy, now: NOW };
const pct = (p) => p == null ? '—' : (100 * p).toFixed(1) + '%';
const evs = (x) => x == null ? '—' : (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%';
function game(away, home) { return Object.values(G.games).filter((o) => o.game.away === away && o.game.home === home)[0]; }
function input(o) { return RD.fromTerminal(o, o.read_inputs, { now: NOW, integrity: INTEG }); }
function live(o) { const i = input(o); return EV.evRead(i, RD.read(i), Object.assign({ history: o.ev_history || [] }, CFG)); }
function sel(e) { const s = e.selected; return s ? s.label + (s.book ? ' (' + s.book + ')' : '') : '—'; }
function row(n, what, kind, gameLabel, e, extra) {
  const s = e && e.selected;
  return { n: n, case: what, kind: kind, game: gameLabel, price: e ? sel(e) : null,
    cover: s ? (s.p_cover_calibrated != null ? pct(s.p_cover_calibrated) + ' cal / ' + pct(s.p_cover_raw) + ' raw' : pct(s.p_cover_raw) + ' raw') : null,
    push: s ? pct(s.p_push_raw) : null, break_even: s ? pct(s.break_even_probability) + (s.p_push_raw > 0 ? ' (' + pct(s.break_even_unconditional) + ' of all outcomes)' : '') : null,
    ev: s ? 'cal ' + evs(s.calibrated_ev) + ' · raw ' + evs(s.raw_model_ev) + ' · robust ' + evs(s.conservative_ev) + ' · Pr>0 ' + (s.prob_ev_positive == null ? '—' : Math.round(100 * s.prob_ev_positive) + '%') : null,
    decision: e ? e.decision_status + (e.policy_decision !== e.decision_status ? ' (policy ' + e.policy_decision + ')' : '') : null,
    reason: e ? e.decision_reason : null, research: e ? e.research_status : null, extra: extra || null };
}

/* the synthetic fixtures (the same shapes football/cfb_ev/ev.test.js pins) */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normalCover(mu, sd) { const pmf = {}; let tot = 0; for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; } Object.keys(pmf).forEach((k) => { pmf[k] /= tot; }); return (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; }; }
const FNOW = Date.parse('2026-10-01T15:00:00Z'), FRESH = '2026-10-01T14:30:00Z', OLD = '2026-10-01T05:00:00Z';
function fx(o) {
  const fair = o.fair, mkt = o.center;
  const inp = { now: FNOW, game: { game_id: 'fixture', home: 'Home U', away: 'Away St', kickoff: '2026-10-03T19:30:00Z' }, model: { available: true, model_version: 'fixture', home_margin: fair, home_win_prob: 0.5 },
    curve: RD.buildCurve(normalCover(fair, 14), mkt, 30, {}), calibration: { status: 'PENDING' }, policy: { version: 'fixture', bet_enabled: false },
    market: { quotes: o.quotes, open: o.open || null, stored: [] }, governed: null, config: { typical_move_pts: 1.9 },
    research: o.research || { status_key: 'RESEARCH', disagreement: { class: 'MODERATE', points: Math.abs(fair - mkt) } },
    context: { qb: { home: { player: 'A', confirmed: true }, away: { player: 'B', confirmed: true } }, key_mass: { 3: 0.0926, 7: 0.0851 }, reliability: 85 }, view: { mode: 'best' }, user_quotes: [], integrity: INTEG };
  const id = { schema: EV.CAL_SCHEMA, version: 'fixture_identity', base_model_version: 'fixture', checkpoint_map: G.ev.artifact.checkpoint_map, extremes: G.ev.artifact.extremes, key_numbers: { validated: true },
    calibrators: { 'cfb|spread|close': { status: 'IDENTITY_VALIDATED', method: 'identity', map: { method: 'identity' }, maturity: 'SHADOW', uncertainty: G.ev.artifact.calibrators['cfb|spread|close'].uncertainty } } };
  id.calibrators['cfb|spread|open'] = id.calibrators['cfb|spread|close'];
  return EV.evRead(inp, RD.read(inp), { artifact: o.artifact || id, policy: o.policy || null, now: FNOW, history: o.history || [] });
}
const q = (id, hl, ph, pa, t, x) => Object.assign({ quote_id: id, book: 'book', source: 'fixture', home_line: hl, price_home: ph, price_away: pa, observed_at: t || FRESH }, x || {});

function main() {
  const out = [];
  /* REAL slate scan */
  const all = Object.values(G.games).map((o) => ({ o: o, e: o.ev }));
  const calPos = all.filter((x) => x.e && x.e.selected && x.e.selected.calibrated_ev > 0);
  const rawPos = all.filter((x) => x.e && x.e.selected && x.e.selected.raw_model_ev > 0 && x.e.decision_status === 'PASS').sort((a, b) => b.e.selected.raw_model_ev - a.e.selected.raw_model_ev);
  /* 1. positive main-line EV */
  if (calPos.length) out.push(row(1, 'positive main-line EV', 'REAL', calPos[0].o.game.away + ' @ ' + calPos[0].o.game.home, calPos[0].e));
  const mm = game('Michigan', 'Minnesota');
  const man = EV.manual(input(mm), 'Minnesota +7.5 -105 fanduel', CFG);
  out.push({ n: 1, case: 'positive main-line EV', kind: calPos.length ? 'REAL' : 'REAL GAME + USER QUOTE (no calibrated positive EV exists on this slate)', game: 'Michigan @ Minnesota',
    price: man.option.label + ' (typed, a book off the market)', cover: pct(man.option.p_cover_calibrated) + ' cal / ' + pct(man.option.p_cover_raw) + ' raw', push: pct(man.option.p_push_raw), break_even: pct(man.option.break_even_probability),
    ev: 'cal ' + evs(man.option.calibrated_ev) + ' · raw ' + evs(man.option.raw_model_ev) + ' · robust ' + evs(man.option.conservative_ev) + ' · Pr>0 ' + Math.round(100 * man.option.prob_ev_positive) + '%',
    decision: 'USER QUOTE — never certified', reason: man.read, research: mm.ev.research_status,
    extra: 'At the consensus (' + sel(mm.ev) + ') the calibrated EV is ' + evs(mm.ev.selected.calibrated_ev) + ': the positive EV exists only at a book two points off the market (a BOOK-SPECIFIC price), and it crosses 7, whose key-number mass is not validated.' });
  if (rawPos[0]) out.push(row(1, 'positive RAW EV that does not survive calibration', 'REAL', rawPos[0].o.game.away + ' @ ' + rawPos[0].o.game.home, rawPos[0].e));
  /* 2. negative main-line EV */
  out.push(row(2, 'negative main-line EV', 'REAL', 'Michigan @ Minnesota', mm.ev));
  /* 3 / 4. main vs alternates, real game, typed alternates */
  const i3 = input(mm), side = mm.ev.side, base = mm.ev.selected;
  const j3 = EV.compareLines(i3, { side: side, line: base.line, price: base.odds.american_display, book: base.book }, { side: side, line: base.line + 2, price: -178, book: 'typed alternate' }, CFG);
  out.push({ n: 3, case: 'main beats the safer alternate', kind: 'REAL GAME + TYPED ALTERNATE', game: 'Michigan @ Minnesota', price: j3.from + ' vs ' + j3.to, decision: j3.verdict, reason: j3.why, extra: j3.explanation.join(' · ') });
  const j4 = EV.compareLines(i3, { side: side, line: base.line, price: base.odds.american_display, book: base.book }, { side: side, line: base.line + 1, price: -112, book: 'typed alternate' }, CFG);
  out.push({ n: 4, case: 'an alternate that has better EV', kind: 'REAL GAME + TYPED ALTERNATE', game: 'Michigan @ Minnesota', price: j4.from + ' vs ' + j4.to, decision: j4.verdict, reason: j4.why, extra: j4.explanation.join(' · ') + ' (neither clears the policy: the better of two negative EVs)' });
  /* 5. integer line with push */
  const ints = all.filter((x) => x.e && x.e.selected && Math.abs(x.e.selected.line - Math.round(x.e.selected.line)) < 1e-9 && x.e.selected.p_push_raw > 0);
  if (ints[0]) out.push(row(5, 'integer line with push', 'REAL', ints[0].o.game.away + ' @ ' + ints[0].o.game.home, ints[0].e, 'settlement ' + ints[0].e.selected.settlement.states.join(' / ')));
  /* 6. stale quote suppressed */
  const st = all.filter((x) => x.e && x.e.decision_reason_code === 'STALE_QUOTE')[0];
  if (st) out.push(row(6, 'stale quote suppressed', 'REAL', st.o.game.away + ' @ ' + st.o.game.home, st.e));
  /* 7. INVESTIGATE / MARKET FAULT with attractive raw EV */
  const inv = all.filter((x) => x.e && x.e.decision_status === 'NO_DECISION' && x.e.selected && x.e.selected.raw_model_ev > 0.1 && /INVESTIGATE|MARKET_FAULT/.test(x.e.decision_reason_code)).sort((a, b) => b.e.selected.raw_model_ev - a.e.selected.raw_model_ev)[0];
  if (inv) out.push(row(7, 'INVESTIGATE / MARKET FAULT with attractive raw EV → NO DECISION', 'REAL', inv.o.game.away + ' @ ' + inv.o.game.home, inv.e));
  /* 8. VERIFIED MAJOR that PASSes */
  const vmReal = all.filter((x) => x.e && x.e.research_status === 'VERIFIED_MAJOR_DISAGREEMENT')[0];
  if (vmReal) out.push(row(8, 'VERIFIED MAJOR that still returns PASS', 'REAL', vmReal.o.game.away + ' @ ' + vmReal.o.game.home, vmReal.e));
  else out.push(Object.assign(row(8, 'VERIFIED MAJOR that still returns PASS', 'FIXTURE (the slate has no verified major disagreement)', 'fixture', fx({ fair: -14, center: -7, quotes: [q('m', 7, -110, -110)], artifact: G.ev.artifact.calibrators ? Object.assign({}, G.ev.artifact, { base_model_version: 'fixture' }) : null, research: { status_key: 'RESEARCH', disagreement: { class: 'MAJOR', points: 7, verified: true } } }))));
  /* 9. BET EARLY */
  out.push(row(9, 'BET EARLY (production policy)', 'FIXTURE (the EV policy is in SHADOW; no real read can be actionable)', 'fixture', fx({ fair: -2, center: -5.5, quotes: [q('m', 5.5, -105, -115)], open: { home_line: 7, observed_at: OLD }, policy: { maturity: 'PRODUCTION', betting_enabled: true } })));
  out.push(row(9, '…the same read in SHADOW', 'FIXTURE', 'fixture', fx({ fair: -2, center: -5.5, quotes: [q('m', 5.5, -105, -115)], open: { home_line: 7, observed_at: OLD } })));
  /* 10. WAIT with a target */
  const wt = fx({ fair: -3.5, center: -5.5, quotes: [q('m', 5.5, -130, 110)] });
  out.push(row(10, 'WAIT with a target price', 'FIXTURE (under the promoted calibrator a market move carries the probability with it, so the real slate has no WAIT)', 'fixture', wt, wt.target_price ? wt.target_price.text : null));
  /* 11. PRICE GONE */
  out.push(row(11, 'PRICE GONE', 'FIXTURE (no earlier eligible EV snapshot exists yet)', 'fixture', fx({ fair: -4, center: -6.5, quotes: [q('m', 6.5, -140, 120)], history: [{ snapshot_id: 'e1', side: 'home', selection_market: 'spread', policy_clears: true, probability_edge: 0.05, calibrated_ev: 0.08, label: 'Home U +8.5 -110', decision_ts: '2026-09-30T12:00:00Z' }] })));
  /* what-if on a real game */
  const wi = EV.whatIf(i3, { side: side, line: base.line - 1, price: -110 }, CFG);
  out.push({ n: 'what-if', case: 'What if Minnesota moves to ' + RD.lineText(base.line - 1) + ' −110?', kind: 'REAL GAME', game: 'Michigan @ Minnesota', price: wi.option.label, decision: wi.status, reason: 'One book at this price: ' + wi.text + ' ' + (wi.if_market_moves ? wi.if_market_moves.text : '') });
  const counts = {}; all.forEach((x) => { const k = x.e ? x.e.decision_status + ' · ' + x.e.decision_reason_code : 'none'; counts[k] = (counts[k] || 0) + 1; });
  const rep = { schema: 'edgedesk_ev_demo_v1', slate_built_at: G.generated_at, calibrator: G.ev.artifact.version, policy: G.ev.policy.version, demonstrations: out, slate_counts: counts,
    calibrated_positive_ev_on_slate: calPos.length };
  fs.writeFileSync(path.join(__dirname, 'reports', 'demo_v1.json'), JSON.stringify(rep, null, 1) + '\n');
  out.forEach((x) => console.log([x.n, x.case, x.kind, x.game, x.price, x.cover || '', x.ev || '', x.decision, (x.reason || '').slice(0, 160)].join(' | ')));
  console.log(JSON.stringify(counts));
}
if (require.main === module) main();
