#!/usr/bin/env node
/* ===========================================================================
   FRONTEND CONTRACT TESTS (brief §89): the pages that show CFB predictions
   interpret home margin, market spread, probability, BET / WAIT / PASS and
   degraded states correctly, and presentation code never reverses a side.
   Each page's own rendering code is cut out and run offline against known
   inputs; nothing is recomputed here and nothing is recomputed there.

     app.html               the V2 shadow panel (fbV2ShadowHTML) with the real
                            engine: fair line = -margin, the market number is the
                            HOME line (P4 publishes spread_line as a margin),
                            the disagreement and side point the right way, the
                            probabilities sum to 100%, BET never appears while
                            betting is disabled, and a broken sign contract
                            shows nothing
     admin/cfb-lab/index.html  "This week": the position names the side's own
                            team and number (HOME -> home team, AWAY -> away
                            team), a data-quality RED and a stale market are
                            visible, a gated BET shows the engine's word beside
                            the official PASS
     record.html            the public Model Lab record: side -> team from
                            "away @ home", a PASS row is never a position
     decision.js publicCard BET / WAIT / PASS / NO BET words, and a BET says when

   Run: node football/cfb_lab/frontend_contract.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const D = require('../cfb_decision/decision.js');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const text = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

/* ═══ 1. app.html: the V2 shadow panel ═════════════════════════════════ */
{
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const fnSrc = (name) => { const a = APP.indexOf('function ' + name + '('); if (a < 0) throw new Error('app.html lost ' + name); let i = APP.indexOf('{', a), depth = 0;
    for (; i < APP.length; i++) { if (APP[i] === '{') depth++; else if (APP[i] === '}') { depth--; if (!depth) break; } } return APP.slice(a, i + 1); };
  const ctx = { console, Math, Date, JSON, isFinite, Number, Object, Array, String, parseFloat };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'params.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'engine.js'), 'utf8'), ctx);
  vm.runInContext('var FBV2={rows:{}};function _escHtml(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}\n'
    + fnSrc('fbEsc') + '\n' + fnSrc('fbPts') + '\n' + fnSrc('fbV2ShadowHTML'), ctx);
  const row = (id, mu, o) => Object.assign({ game_id: id, season: 2026, week: 6, home: 'Texas', away: 'Oklahoma', kickoff: '2026-10-10T19:30:00Z', ens_pred: mu, sigma: 15.5, fair_total: 52,
    ens_sd: 2, reliability_base: 70, qb: {}, state: 'FROZEN', prediction_ts: '2026-10-06T12:00:00Z' }, o || {});
  const panel = (r, spreadLineMargin) => { ctx.FBV2.rows = { [r.game_id]: r };
    return vm.runInContext('fbV2ShadowHTML(' + JSON.stringify({ g: { game_id: r.game_id, home_team: r.home, away_team: r.away } }) + ',' + JSON.stringify({ market: { spread_line: spreadLineMargin, as_of: '2026-10-10T11:00:00Z' } }) + ')', ctx); };
  /* home favourite by 7; the P4 market says home by 3 (spread_line is a MARGIN: +3 = home -3) */
  const h1 = text(panel(row('1', 7), 3));
  chk('V2 panel: home favourite fair line reads "Texas -7.0"', /Fair spread Texas -7\.0/.test(h1), h1.slice(0, 300));
  chk('V2 panel: projected margin is the HOME margin, signed (+7.0 = Texas by 7)', /Projected margin Texas \+7\.0/.test(h1));
  chk('V2 panel: the market spread is the HOME line (-3.0), converted once from the P4 margin', /Current spread Texas -3\.0/.test(h1));
  chk('V2 panel: model +7 vs market home -3 is a +4.0 disagreement for HOME', /EdgeDesk disagreement \+4\.0 pts/.test(h1) && /% HOME/.test(h1), h1);
  const probs = /Win probability Texas ([\d.]+)% · Oklahoma ([\d.]+)%/.exec(h1);
  chk('V2 panel: the two win probabilities sum to 100%', probs && Math.abs(Number(probs[1]) + Number(probs[2]) - 100) < 0.11 && Number(probs[1]) > 50, probs);
  /* road favourite by 10; market has the away team -7 (spread_line -7) */
  const h2 = text(panel(row('2', -10), -7));
  chk('V2 panel: road favourite fair line names the AWAY team: "Oklahoma -10.0"', /Fair spread Oklahoma -10\.0/.test(h2), h2.slice(0, 200));
  chk('V2 panel: road favourite margin is negative for the home team (Texas -10.0)', /Projected margin Texas -10\.0/.test(h2));
  chk('V2 panel: the market home line is +7.0 (Oklahoma -7)', /Current spread Texas \+7\.0/.test(h2));
  chk('V2 panel: model -10 vs market home +7 leans AWAY by 3', /EdgeDesk disagreement -3\.0 pts/.test(h2) && /% AWAY/.test(h2), h2);
  chk('V2 panel: BET is never shown while betting is disabled', !/Research status BET\b/.test(h1 + h2));
  const h3 = text(panel(row('3', 0), null));
  chk("V2 panel: pick'em shows PICK and no market joined says so (nothing invented)", /Fair spread PICK/.test(h3) && /none joined/.test(h3));
  /* a broken sign contract: an engine that returns a fair line with the wrong sign */
  const realPure = ctx.EDCfbV2.pure;
  ctx.EDCfbV2.pure = function (r, o) { const x = JSON.parse(JSON.stringify(realPure(r, o))); x.fair_spread_home_line = x.projected_margin; return x; };
  const h4 = text(panel(row('4', 7), 3));
  ctx.EDCfbV2.pure = realPure;
  chk('V2 panel: a broken sign contract shows NOTHING rather than a reversed side', /sign contract failed/.test(h4) && !/Fair spread/.test(h4), h4);
  /* engine.js rounds the margin and the fair line to 0.01 independently: at a
     half-cent boundary they differ by 0.01 (6.83 / -6.82). That is rounding,
     not a reversed sign, and the guard must let it through. */
  const half = text(panel(row('5', 6.825), 3));
  chk('V2 panel: a half-cent rounding difference (6.825) is not a contract failure', !/sign contract failed/.test(half) && /Fair spread Texas -7\.0/.test(half) && /Projected margin Texas \+6\.8/.test(half), half.slice(0, 200));
  const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
  const live = (cur.rows || []).filter((r) => ctx.EDCfbV2.pure(r, {}).status === 'PREDICTED');
  const broken = live.filter((r) => /sign contract failed/.test(panel(r, null)));
  chk('V2 panel: every PREDICTED game in the live football/cfb_v2/current.json passes the guard (' + live.length + ')', live.length > 0 && broken.length === 0, broken.map((r) => r.game_id));
}

/* ═══ 2. admin/cfb-lab: "This week" ════════════════════════════════════ */
{
  const PAGE = fs.readFileSync(path.join(ROOT, 'admin', 'cfb-lab', 'index.html'), 'utf8');
  const a = PAGE.indexOf('/*__EDLAB_START__*/'), b = PAGE.indexOf('/*__EDLAB_END__*/');
  const ctx = { window: {}, document: undefined, console }; ctx.window.window = ctx.window;
  vm.createContext(ctx); vm.runInContext('(function(window){' + PAGE.slice(a, b) + '})(window)', ctx);
  const E = ctx.window.EDLAB;
  const lab = { models: [{ model_version: 'm1', label: 'V2.1' }], this_week: [
    { game_id: 'g1', week: 6, kickoff: '2026-10-10T19:30:00Z', home: 'Texas', away: 'Oklahoma', market: { current: -3.5, open: -3, books: 1, stale: false },
      models: { m1: { checkpoint: 'T24', margin: 7, fair: 'Texas -7.0', p_home: 0.68, gap: 3.5, decision: 'LEAN', status: 'LEAN', side: 'HOME', line: -3.5, conf: 80, dq: 'GREEN' } } },
    { game_id: 'g2', week: 6, kickoff: '2026-10-10T23:00:00Z', home: 'Miami (OH)', away: 'Miami', market: { current: 17.5, open: 16.5, books: 1, stale: true, as_of: '2026-10-09T01:00:00Z' },
      models: { m1: { checkpoint: 'T24', margin: -21, fair: 'Miami -21.0', p_home: 0.08, gap: -3.5, decision: 'PASS', status: 'BET', side: 'AWAY', line: -17.5, conf: 40, dq: 'RED' } } }] };
  const h = E.thisWeek(lab);
  const row1 = text(h.slice(h.indexOf('Oklahoma'), h.indexOf('Miami (OH)'))), row2 = text(h.slice(h.lastIndexOf('Miami (OH)') - 200));
  chk('admin: HOME position names the home team with its own number ("Texas -3.5")', /Texas -3\.5/.test(row1), row1);
  chk('admin: AWAY position names the AWAY team with its own number ("Miami -17.5"), never the home team', /\bMiami -17\.5/.test(row2) && !/Miami \(OH\) -17\.5/.test(row2), row2);
  chk('admin: the market column is the home line (+17.5 for a home dog)', /\+17\.5/.test(row2));
  chk('admin: a data-quality RED and a stale market are visible', /RED/.test(h) && /stale/.test(h));
  chk('admin: a BET the gate turned into PASS shows the engine\'s own word beside it (degraded, not hidden)', /PASS/.test(row2) && /engine BET/.test(row2), row2);
}

/* ═══ 3. record.html: the public Model Lab record ══════════════════════ */
{
  const PAGE = fs.readFileSync(path.join(ROOT, 'record.html'), 'utf8');
  const a = PAGE.indexOf('/*__EDLAB_PUB_START__*/'), b = PAGE.indexOf('/*__EDLAB_PUB_END__*/');
  const ctx = { window: {}, document: undefined, console, Intl, Date }; ctx.window.window = ctx.window;
  vm.createContext(ctx); vm.runInContext('(function(window){' + PAGE.slice(a, b).replace(/if\(typeof document!==.undefined.&&[\s\S]*?load\(\);/, '') + '})(window)', ctx);
  const P = ctx.window.EDLABPUB;
  const g = (o) => text(P.gameRow(Object.assign({ kickoff: '2026-10-03T19:30:00Z', matchup: 'Oklahoma @ Texas', official_line: 'Texas -7.0', home_win_probability: 0.68, final: '24–31', abs_error: 0, decision: 'LEAN', side: 'HOME', line: -3.5, result: 'WIN', clv: 1.5, week: 6 }, o)));
  chk('record: side HOME is the home team from "away @ home" (Texas)', /LEAN Texas -3\.5 WIN/.test(g({})), g({}));
  chk('record: side AWAY is the away team (Oklahoma) with its own number', /LEAN Oklahoma \+3\.5 LOSS/.test(g({ side: 'AWAY', line: 3.5, result: 'LOSS' })), g({ side: 'AWAY', line: 3.5, result: 'LOSS' }));
  chk('record: a PASS row is never a position ("no position")', /no position/.test(g({ decision: 'PASS', result: 'WIN' })));
  chk('record: probability prints as a percent of the HOME team', /68\.0%/.test(g({})));
  chk('record: a BET is labelled BET only when the decision is BET', !/\bBET\b/.test(g({})) && /\bBET\b/.test(g({ decision: 'BET' })));
}

/* ═══ 4. decision.js publicCard: BET / WAIT / PASS / NO BET ════════════ */
{
  const pure = { status: 'PREDICTED', game_id: '1', home: 'Texas', away: 'Oklahoma', fair_spread_display: 'Texas -9.5' };
  const card = (status, timing) => D.publicCard(pure, { status, best_quote: status === 'BET' ? { book: 'a', bettable_to_line: -4.5 } : null,
    decisions: [{ status, book: 'a', side: 'HOME', line_for_side: -3.5, price: -110, decision_cover_probability: 0.56, break_even_probability: 0.5238, probability_edge: 0.036, timing: timing || 'NONE', reason_codes: status === 'BET' ? ['BET_VALIDATED'] : ['PASS_PRICE'] }] });
  chk('card: a BET NOW says BET and BET NOW, with the bettable-to number', card('BET', 'BET_NOW').decision === 'BET' && card('BET', 'BET_NOW').timing === 'BET NOW' && card('BET', 'BET_NOW').bettable_to === '-4.5');
  chk('card: a BET the policy says to wait on says WAIT (never "bet now")', card('BET', 'WAIT').timing === 'WAIT');
  chk('card: PASS has no timing and no bettable-to', card('PASS').decision === 'PASS' && card('PASS').timing === null && card('PASS').bettable_to === null);
  chk('card: NO_BET reads "NO BET"', D.publicCard(pure, { status: 'NO_BET', decisions: [] }).decision === 'NO BET');
  chk('card: the best market names the side\'s team and its own number', card('BET', 'BET_NOW').best_market === 'Texas -3.5 -110');
  chk('card: every card says an edge is not a promise', /Probabilities, not promises/.test(card('BET').note));
}

fails.forEach((f) => console.log('FAIL | ' + f));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
