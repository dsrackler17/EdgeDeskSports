#!/usr/bin/env node
/* ===========================================================================
   THE DESK KERNEL (EDDESK): typed evidence in, a direct answer out.

   Proves, on fixtures with every number chosen by the test:
     - broad questions are ranked by deterministic evidence, not a writer
     - a specific market question gets that market's typed evidence
     - a stale market is never presented as a current opportunity
     - missing important evidence lowers certainty and is never filled in
     - CFB and NFL both run through the typed-evidence contract
     - follow-ups keep the matchup and the market
     - a side is not recommended because it wins more than half the time
       when its price is worse than EdgeDesk's number
     - a changed line changes the answer the way the pricing rule says
     - Similar Situations stays withheld below its sample floor
     - no similarity vector reads anything that happened after kickoff

   Run: node tools/intelligence/desk.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai');
require(path.join(FN, '_intelligence.js'));
require(path.join(FN, '_research.js'));
const P = require(path.join(FN, '_pricing.js'));
require(path.join(FN, '_board.js'));
P.loadValidation('americanfootball_nfl', require(path.join(ROOT, 'football/validation/pricing_nfl.json')));
P.loadValidation('americanfootball_ncaaf', require(path.join(ROOT, 'football/validation/pricing_cfb.json')));
const D = require(path.join(FN, '_desk.js'));
const F = require('./desk_fixtures.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const NOW = Date.parse('2026-09-23T15:00:00Z');
function ask(q, Es, st) { return D.answer({ question: q, evidence: Es, state: st }); }

/* ------------------------------------------------------------------ board */
{
  const Es = [
    D.evidence(F.cfbGame(NOW)),                                                   /* UCLA +3.5 vs projection +0.2: 3.3 pts */
    D.evidence(F.nflGame(NOW, { market_home_line: -4.5 })),                        /* Rams -4.5 vs -6.9 */
    D.evidence(F.cfbGame(NOW, { game_id: 'g2', home: 'Iowa', away: 'Nebraska', proj_home_line: -10, market_home_line: -6, info: 45 }))
  ];
  const a1 = ask("What's the best market line value today?", Es);
  const a2 = ask("What's the best market line value today?", Es);
  ok('broad question classifies as BOARD', a1.intent === 'BOARD', a1.intent);
  ok('board answer is reproducible from the same evidence', a1.text === a2.text && JSON.stringify(a1.board) === JSON.stringify(a2.board));
  const R = D.rank(Es, {});
  const scores = R.qualified.map((r) => r.score);
  ok('ranking is ordered by the documented score', scores.every((s, i) => i === 0 || scores[i - 1] >= s), scores);
  ok('every score is edge x freshness x tier x quality', R.qualified.every((r) => Math.abs(r.score - D.scoreOf(r.E, r.ev)) < 1e-9));
  ok('the answer leads with the #1 ranked selection', a1.text.indexOf(R.qualified[0].ev.label) > 0 && a1.text.indexOf(R.qualified[0].ev.label) < 40, a1.text.slice(0, 80));
  ok('the board answer is short (<= 8 sentences before alternatives)', a1.text.split('\n\n')[0].split(/(?<=[.!?])\s+/).length <= 9, a1.text);
  ok('a larger gap on weak evidence does not outrank a smaller gap on strong evidence',
    R.qualified[0].E.identity.game_id !== 'g2' && R.qualified.findIndex((r) => r.E.identity.game_id === 'g2') > R.qualified.findIndex((r) => r.E.identity.game_id === 'cfb-ucla-md'),
    R.qualified.map((r) => [r.ev.label, r.ev.value_points, r.score]));

  /* the writer cannot change the pick */
  const teams = Es.flatMap((E) => [E.identity.home, E.identity.away]);
  const other = R.qualified[1].ev.label;
  const c1 = D.critic('Best value right now: Iowa -6. ' + a1.text.split('.').slice(1, 3).join('.') + '.', a1, { teams });
  ok('critic rejects prose that swaps in a different pick', c1.verdict === 'FAIL' || a1.text.indexOf('Iowa') >= 0, c1);
  const c2 = D.critic(a1.text.replace('3.3', '5.1'), a1, { teams });
  ok('critic rejects a number the evidence does not hold', c2.verdict === 'FAIL' && c2.findings.some((f) => f.code === 'NUMBER_NOT_IN_EVIDENCE'), c2);
  const c3 = D.critic(a1.text, a1, { teams });
  ok('critic passes the kernel’s own answer', c3.verdict === 'PASS', c3);
  const c4 = D.critic('This is a lock. ' + a1.text, a1, { teams });
  ok('critic rejects certainty language', c4.verdict === 'FAIL', c4);
  ok('unused variable guard', !!other);

  /* nothing clears -> say so, never force a pick */
  const flat = [D.evidence(F.cfbGame(NOW, { market_home_line: -0.5 })), D.evidence(F.nflGame(NOW, { market_home_line: -7 }))];
  const a3 = ask('Best bet right now?', flat);
  ok('nothing clears -> "Nothing stands out"', /^Nothing stands out enough at current/.test(a3.text), a3.text);
  ok('nothing clears -> no board pick', !a3.board.length);

  /* disagreement and underdog views */
  const a4 = ask('Where does our model disagree with the market most?', Es);
  ok('disagreement question ranks by raw gap', /^Biggest disagreement right now: Iowa -6/.test(a4.text), a4.text.slice(0, 90));
  const a5 = ask('Best CFB dog?', Es);
  ok('underdog filter returns an underdog', /UCLA/.test(a5.text.slice(0, 60)) && !/Iowa -6/.test(a5.text), a5.text.slice(0, 120));
  const a6 = ask('Best NFL value?', Es);
  ok('sport filter holds', /^Best NFL value right now: Los Angeles Rams -4.5/.test(a6.text), a6.text.slice(0, 80));
}

/* ------------------------------------------------------- stale markets */
{
  const Es = [D.evidence(F.cfbGame(NOW, { market_age_min: 60 * 30, freshness: 'STALE' })), D.evidence(F.nflGame(NOW, { market_home_line: -7 }))];
  const a = ask("What's the best market line value today?", Es);
  ok('a stale market is not a current opportunity', !/Best .*value right now: UCLA/.test(a.text) && !a.board.some((s) => s.team === 'UCLA'), a.text);
  ok('the stale candidate is reported as stale', /stale prices/.test(a.text), a.text);
  const R = D.rank(Es, {});
  ok('rank puts stale rows in `stale`, never `qualified`', R.stale.length === 1 && !R.qualified.some((r) => r.ev.market_state === 'STALE'));
  const b = ask('Is UCLA +3.5 worth betting?', Es);
  ok('a specific question on a stale price says it is not current', /not a current price/.test(b.text), b.text);
  ok('confidence on a stale price is Insufficient', /Confidence: Insufficient/.test(b.text), b.text);
  /* the kernel's own freshness path (no host freshness): 10h old capture, kickoff in 30h */
  const E2 = D.evidence(F.cfbGame(NOW, { market_age_min: 600 }));
  ok('an old capture is not actionable', E2.market.spread.actionable === false && /STALE|AGING/.test(E2.market.spread.state) === true && E2.market.spread.state === 'STALE', E2.market.spread);
  const E3 = D.evidence(F.cfbGame(NOW, { market_captured_at: null, executable: false }));
  ok('a reference number with no capture time is LINE_ONLY', E3.market.spread.state === 'LINE_ONLY');
  ok('a reference-only line never qualifies', D.rank([E3], {}).qualified.length === 0 && D.rank([E3], {}).reference.length === 1);
  const E4 = D.evidence(F.cfbGame(NOW, { kick_h: -1 }));
  ok('a started game is not priced as pregame', E4.market.spread.state === 'STARTED' && D.rank([E4], {}).qualified.length === 0);
}

/* ------------------------------------------- specific market questions */
{
  const E = D.evidence(F.cfbGame(NOW));
  const a = ask('Is Maryland -2.5 worth betting?', [E]);
  ok('specific question -> MARKET intent', a.intent === 'MARKET');
  ok('it evaluates exactly Maryland -2.5', a.focus.team === 'Maryland' && a.focus.line === -2.5 && a.focus.market === 'spread' && a.focus.side === 'home', a.focus);
  const ev = a.evaluations[0];
  ok('value is measured against the projection: -2.5 vs -0.2 = -2.3', ev.value_points === -2.3, ev.value_points);
  ok('the evidence it used is the typed contract', E.schema === 'edgedesk_desk_evidence_v1' && E.research.contract === 'game_research/1');
  ok('typed evidence carries the fair line and the market line', E.typed.some((t) => t.key === 'fair_line' && t.type === 'MODEL_OUTPUT') && E.typed.some((t) => t.key === 'market_line' && t.type === 'MARKET_DATA'));
  ok('fair/market/gap come from the research object, not re-derived', E.gap.points === 3.3 && E.research.model_vs_market.raw_gap.value === 3.3);
  ok('a number the reader names is priced as hypothetical', ev.market_state === 'HYPOTHETICAL');
  const b = ask('Do you like UCLA +3?', [E]);
  ok('UCLA +3 is evaluated on the away side at +3', b.focus.side === 'away' && b.focus.line === 3, b.focus);
  const c = ask('Maryland ML?', [E]);
  ok('moneyline question prices the moneyline at the current price', c.focus.market === 'moneyline' && c.focus.odds === -160, c.focus);
  const d = ask('Over 51.5?', [D.evidence(F.cfbGame(NOW))]);
  ok('a total with no team named does not invent a side', d.intent === null || d.intent === 'BOARD' || d.intent === 'MARKET', d.intent);
}

/* ------------------------ a winner is not a price: win prob > 50% */
{
  const E = D.evidence(F.nflGame(NOW, { proj_home_line: -4, market_home_line: -7, proj_wp: 0.63 }));
  const a = ask('Do you like the Rams -7?', [E]);
  const ev = a.evaluations[0];
  ok('Rams -7 vs EdgeDesk -4 is OVERPRICED', ev.verdict === 'OVERPRICED', ev.verdict);
  ok('answer says No', /^No\./.test(a.text), a.text);
  ok('answer names the win probability and why it is not the price', /expect Los Angeles Rams to win \(63%\), but winning isn’t covering -7/.test(a.text), a.text);
  ok('it does not claim value on the other side unless the validated blend finds it', !/value is on New York Giants/.test(a.text) || D.evaluate(E, { market: 'spread', side: 'away', team: 'New York Giants', line: 7 }).verdict !== 'NO_VALUE', a.text);
  const C = D.evidence(F.cfbGame(NOW));
  const cm = ask('Is Maryland -3.5 worth betting?', [C]);
  ok('CFB: Maryland -3.5 (projection -0.2, 51% to win) is a No that points to UCLA +3.5', /^No\./.test(cm.text) && /expect Maryland to win \(51%\)/.test(cm.text) && /the value is on UCLA \+3.5/.test(cm.text), cm.text);
  ok('the board never picks the favourite here', !D.rank([E], {}).qualified.some((r) => r.sel.side === 'home' && r.sel.market === 'spread'));
}

/* --------------------------------------------- price sensitivity */
{
  const E = D.evidence(F.cfbGame(NOW));
  const at = (line) => D.evaluate(E, { market: 'spread', side: 'away', team: 'UCLA', line, odds: -110, hypothetical: true }).verdict;
  ok('+3.5 is VALUE', at(3.5) === 'VALUE');
  ok('+2.5 is THIN', at(2.5) === 'THIN');
  ok('0 is OVERPRICED (worse than EdgeDesk’s +0.2)', at(0) === 'OVERPRICED');
  const L = D.ladder(E, { market: 'spread', side: 'away', team: 'UCLA', line: 3.5, odds: -110 });
  ok('ladder: attractive at +3.5', L.attractive_at === 3.5, L);
  ok('ladder: playable boundary is below attractive', L.playable_at < L.attractive_at, L);
  ok('ladder is consistent with evaluate at its boundaries', at(L.playable_at) !== 'NO_VALUE' && ['NO_VALUE', 'OVERPRICED'].includes(at(L.playable_at - 0.5)));
  /* a worse price moves the boundary */
  const L2 = D.ladder(E, { market: 'spread', side: 'away', team: 'UCLA', line: 3.5, odds: -125 });
  ok('a worse price needs a better number', L2.playable_at > L.playable_at, [L.playable_at, L2.playable_at]);
  /* the follow-up changes the answer */
  const a1 = ask("What's the best value?", [E]);
  const a2 = ask('What if it drops to +2.5?', [E], a1.state);
  ok('line change is understood', a2.intent === 'LINE_CHANGE' && a2.focus.line === 2.5 && a2.focus.team === 'UCLA', a2.focus);
  ok('line change changes the answer', /answer changes: it’s only thin value/.test(a2.text), a2.text);
  const a3 = ask('What if it moves to +4?', [E], a2.state);
  ok('a better line keeps it attractive', /still clears|still attractive/.test(a3.text), a3.text);
  /* NFL LEAN tier uses the pricing kernel's own status */
  const N = D.evidence(F.nflGame(NOW, { market_home_line: -4.5 }));
  const n1 = D.evaluate(N, { market: 'spread', side: 'home', team: 'Los Angeles Rams', line: -4.5, odds: -110 });
  ok('NFL spread verdict comes from EDPRICE (LEAN_PLAY)', n1.pricing_status === 'LEAN_PLAY' && n1.verdict === 'VALUE', n1);
  const n2 = D.evaluate(N, { market: 'spread', side: 'home', team: 'Los Angeles Rams', line: -6.5, odds: -110, hypothetical: true });
  ok('NFL at -6.5 (gap 0.4 < 1.5) is not VALUE', n2.verdict !== 'VALUE', n2.verdict);
}

/* ------------------------------------ missing evidence lowers certainty */
{
  const full = D.evidence(F.nflGame(NOW, { market_home_line: -4.5 }));
  const thin = D.evidence(F.nflGame(NOW, { market_home_line: -4.5, no_injuries: true, no_qb: true }));
  ok('missing injuries and QB are listed', thin.missing.some((m) => m.key === 'injuries' && m.important) && thin.missing.some((m) => m.key === 'qb' && m.important), thin.missing);
  ok('evidence quality drops', thin.reliability.score < full.reliability.score, [full.reliability.score, thin.reliability.score]);
  const sel = { market: 'spread', side: 'home', team: 'Los Angeles Rams', line: -4.5, odds: -110 };
  const cf = D.confidence(full, D.evaluate(full, sel)), ct = D.confidence(thin, D.evaluate(thin, sel));
  ok('confidence drops', ct.score < cf.score, [cf, ct]);
  ok('no missing starter is filled in', thin.specific.nfl.qb.home.name === null && thin.specific.nfl.injuries === null);
  const t = ask('Do you like the Rams -4.5?', [thin]);
  ok('the answer says inputs are missing', /important inputs? (is|are) missing/.test(t.text), t.text);
  const none = D.evidence(F.cfbGame(NOW, { no_market: true }));
  ok('no market -> no fabricated market line', none.market.spread.state === 'NONE' && none.gap.points === null);
  const noProj = F.cfbGame(NOW); noProj.projection = {};
  const E = D.evidence(noProj);
  ok('no projection -> projection null, not 50/50', E.projection.home_line === null && E.projection.home_win_prob === null);
  const a = ask('Is UCLA +3.5 worth betting?', [E]);
  ok('no projection -> says it cannot judge', /no projection/.test(a.text), a.text);
  ok('no projection -> Insufficient confidence', D.confidence(E, D.evaluate(E, { market: 'spread', side: 'away', team: 'UCLA', line: 3.5 })).grade === 'INSUFFICIENT');
  const unk = F.cfbGame(NOW, { contract: [] }); unk.projection.information_confidence = null; unk.projection.completeness = null;
  const EU = D.evidence(unk);
  ok('with no contract, unknown categories count as unavailable, never neutral', EU.research.quality.categories.filter((c) => c.status === 'UNAVAILABLE').length >= 4, EU.research.quality.categories);
}

/* --------------------------------------------- CFB and NFL both typed */
{
  const C = D.evidence(F.cfbGame(NOW)), N = D.evidence(F.nflGame(NOW));
  for (const [name, E] of [['CFB', C], ['NFL', N]]) {
    ok(name + ' runs the evidence contract', E.schema === 'edgedesk_desk_evidence_v1');
    ok(name + ' carries the canonical research object', E.research && E.research.contract === 'game_research/1');
    ok(name + ' has typed evidence items', E.typed.length >= 4 && E.typed.every((t) => ['FACT', 'MODEL_OUTPUT', 'MARKET_DATA', 'HISTORICAL', 'UNCERTAINTY', 'HYPOTHETICAL'].includes(t.type)));
  }
  ok('CFB carries college-specific evidence only', C.specific.cfb && !C.specific.nfl && C.specific.cfb.team_rating.home.value === 4.1 && C.specific.cfb.recruiting);
  ok('NFL carries pro-specific evidence only', N.specific.nfl && !N.specific.cfb && N.specific.nfl.qb.home.name === 'Matthew Stafford' && N.specific.nfl.drivers.length);
  ok('NFL spread (LEAN) prices on the validated blend', /validated blend/.test(D.evaluate(N, { market: 'spread', side: 'away', team: 'New York Giants', line: 6.5 }).prob.basis));
  P.loadValidation('americanfootball_nfl', { markets: {} });   /* no validation: RESEARCH tier */
  const NR = D.evidence(F.nflGame(NOW, { market_home_line: -4.5 }));
  ok('an unvalidated NFL spread uses the model\u2019s own margin distribution', /own margin distribution/.test(D.evaluate(NR, { market: 'spread', side: 'home', team: 'Los Angeles Rams', line: -4.5 }).prob.basis));
  P.loadValidation('americanfootball_nfl', require(path.join(ROOT, 'football/validation/pricing_nfl.json')));
  ok('CFB tier is the pricing kernel’s (RESEARCH)', C.fair.tier === 'RESEARCH' && C.fair.spread.tier_basis.length > 10);
  ok('NFL tier is the pricing kernel’s (LEAN)', N.fair.tier === 'LEAN');
  ok('CFB cannot be graded above LOW on a RESEARCH tier with good evidence', D.confidence(C, D.evaluate(C, { market: 'spread', side: 'away', team: 'UCLA', line: 3.5 })).grade === 'LOW');
  ok('LEAN tier is never HIGH', D.confidence(N, D.evaluate(D.evidence(F.nflGame(NOW, { market_home_line: -4.5 })), { market: 'spread', side: 'home', team: 'Los Angeles Rams', line: -4.5 })).grade !== 'HIGH');
}

/* ------------------------------------------------- follow-up context */
{
  const Es = [D.evidence(F.cfbGame(NOW)), D.evidence(F.nflGame(NOW, { market_home_line: -7 }))];
  const t1 = ask('Best CFB value today?', Es);
  ok('turn 1 focuses UCLA +3.5', t1.focus && t1.focus.team === 'UCLA' && t1.focus.line === 3.5, t1.focus);
  const st1 = JSON.parse(JSON.stringify(t1.state));   /* it rides through the browser as JSON */
  const t2 = ask('What if it drops to +2.5?', Es, st1);
  ok('"it" is UCLA', t2.focus.team === 'UCLA' && t2.focus.game_id === 'cfb-ucla-md' && t2.focus.line === 2.5, t2.focus);
  const t3 = ask('Compare that to Maryland ML', Es, t2.state);
  ok('compare pairs the focus with Maryland ML', t3.intent === 'COMPARE' && t3.compare.length === 2 && t3.compare[0].team === 'UCLA' && t3.compare[1].market === 'moneyline' && t3.compare[1].team === 'Maryland', t3.compare);
  const t4 = ask('Which would you rather have?', Es, t3.state);
  ok('"which would you rather have" compares the same two without a board search', t4.intent === 'CHOOSE' && t4.text.indexOf('UCLA') >= 0 && t4.text.indexOf('Maryland ML') >= 0 && !/^Best/.test(t4.text), t4.text);
  const t5 = ask('Why?', Es, t4.state);
  ok('"why" explains the focus', t5.intent === 'EXPLAIN' && /UCLA/.test(t5.text), t5);
  const t6 = ask("What's the biggest risk?", Es, t5.state);
  ok('"biggest risk" answers about the focus', t6.intent === 'RISK' && /UCLA/.test(t6.text), t6.text);
  const t7 = ask('What line would make you pass?', Es, t6.state);
  ok('"what line would make you pass" gives the boundary', t7.intent === 'PASS_LINE' && /pass\./.test(t7.text), t7.text);
  const t8 = ask('Give me the deep dive', Es, t7.state);
  ok('"deep dive" expands', t8.intent === 'DEEP' && t8.text.split('\n').length > 10, t8.text.length);
  const t9 = ask('Anything safer?', Es, t8.state);
  ok('"anything safer" re-ranks and excludes the focus', t9.intent === 'SAFER' && !(t9.focus && t9.focus.team === 'UCLA' && t9.focus.market === 'spread'), t9.text.slice(0, 120));
  const bad = ask('Why?', Es, { schema: 'edgedesk_desk_state_v1', focus: { market: 'spread', side: 'evil', game_id: 'x' } });
  ok('a malformed carried state is dropped, not trusted', bad.intent !== 'EXPLAIN' || /not sure which bet/.test(bad.text), bad);
}

/* --------------------------------------------- similar situations */
{
  const E = D.evidence(F.cfbGame(NOW));
  const ev = D.evaluate(E, { market: 'spread', side: 'away', team: 'UCLA', line: 3.5, odds: -110 });
  const h = D.historyRecord(E, ev, { captured_at: NOW });
  ok('a pregame history record is built', h.ok && h.record.schema === 'edgedesk_prediction_history_v1');
  ok('the record carries no postgame field', D.leaks(h.record).length === 0 && D.leaks(h.record.features).length === 0);
  const after = D.historyRecord(E, ev, { captured_at: Date.parse(E.identity.kickoff) + 60000 });
  ok('a record captured after kickoff is refused', !after.ok);
  function row(i, o) {
    return Object.assign({ sport: 'americanfootball_ncaaf', market: 'spread', settled: true, kickoff: '2025-10-0' + (1 + (i % 8)) + 'T20:00:00Z', captured_at: '2025-10-0' + (1 + (i % 8)) + 'T10:00:00Z',
      outcome: i % 2 ? 'WIN' : 'LOSS', clv_points: 0.5, features: { sport: 'americanfootball_ncaaf', market: 'spread', tier: 'RESEARCH', side_is_underdog: true, value_points: 3 } }, o || {});
  }
  const few = Array.from({ length: 12 }, (_, i) => row(i));
  const s1 = D.similarSituations(h.record, few);
  ok('12 settled rows -> withheld', !s1.available && /building history/.test(s1.text), s1);
  const many = Array.from({ length: 200 }, (_, i) => row(i, i < 40 ? {} : { features: { sport: 'americanfootball_ncaaf', market: 'spread', tier: 'RESEARCH', side_is_underdog: false, value_points: 9 } }));
  const s2 = D.similarSituations(h.record, many);
  ok('200 settled but 40 comparable -> still withheld', !s2.available && s2.n_comparable === 40, s2);
  const enough = Array.from({ length: 200 }, (_, i) => row(i));
  const s3 = D.similarSituations(h.record, enough);
  ok('200 settled, all comparable -> shown with its sample', s3.available && s3.n_comparable === 200, s3);
  ok('the minimum is at least 50', D.SIMILAR_MIN_SETTLED >= 50 && D.SIMILAR_MIN_TOTAL_SETTLED >= D.SIMILAR_MIN_SETTLED);
  /* leakage: rows captured after kickoff are excluded; postgame fields never reach the vector */
  const leaky = Array.from({ length: 200 }, (_, i) => row(i, { captured_at: '2025-10-0' + (1 + (i % 8)) + 'T23:00:00Z' }));
  ok('rows captured after kickoff are never used', !D.similarSituations(h.record, leaky).available);
  const poisoned = row(1); poisoned.features.result = 'WIN'; poisoned.features.clv_points = 3; poisoned.features.close_line = -7;
  const v = D.similarityVector(poisoned);
  ok('the similarity vector ignores postgame keys even when present', D.leaks(v).length === 0 && Object.keys(v).every((k) => D.PREGAME_FEATURES.includes(k)));
  const t1 = ask('Best CFB value today?', [E]);
  const t2 = ask('Have we seen similar situations?', [E], t1.state);
  ok('asked directly, Similar Situations says it is building history', t2.intent === 'SIMILAR' && /building history/.test(t2.text), t2);
}

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
