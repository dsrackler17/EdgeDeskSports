#!/usr/bin/env node
/* ============================================================================
   THE CFB RESEARCH VIEW (lib/cfb_research_view.js), rule by rule.

   Every projection below carries the display fields the REAL engine computes:
   football/cfb_p4/engine.js is loaded and its fairLine.normalize() fills
   display_fair_spread / display_side / is_near_pickem, so a test can never
   pass on a display rule the engine does not ship.

   Run: node tools/football/cfb_research_view.test.js
   ========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
global.EDCfbP4Params = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));

let checks = 0, failures = 0;
function chk(name, cond, detail) {
  checks++;
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); cond = false; } }
  if (cond) return;
  failures++; console.error('  FAIL: ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(name, got, want) { chk(name + ' (got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want) + ')', got === want); }
function near(name, got, want, tol) { chk(name + ' (got ' + got + ', wanted ' + want + ')', got != null && Math.abs(got - want) <= (tol == null ? 1e-9 : tol)); }
function section(t) { console.log('\n' + t); }

const HOME = 'Florida', AWAY = 'Ole Miss';
const GAME = { game_id: 'G1', home: HOME, away: AWAY };

/* an engine-shaped projection at raw margin `raw`, with the engine's own
   display layer applied to it */
function proj(raw, o) {
  o = o || {};
  const fl = E.fairLine.normalize(raw, o.tiebreak || {});
  const p = {
    status: 'PREDICTED',
    game: { home: HOME, away: AWAY },
    model: {
      fair_spread: raw, fair_total: 52, home_win_prob: o.win_prob == null ? E.dist.winProb(raw, 15) : o.win_prob,
      display_fair_spread: fl.display_fair_spread, display_side: fl.display_side,
      is_near_pickem: fl.is_near_pickem, display_basis: fl.basis
    },
    scores: { confidence: o.conf === undefined ? 62 : o.conf },
    market: { spread_line: o.line == null ? null : o.line, spread_gap: o.line == null ? null : raw - o.line },
    contributions: o.contributions || [],
    explanation: { primary_drivers: [], counterarguments: [], data_quality: [] },
    layers: o.layers || {},
    data_quality: { status: 'OK', warnings: [] }
  };
  return p;
}

/* ======================================================================== */
section('STEP 1 · the fair line always names a side, with a one-point floor');
{
  const a = V.build({ game: GAME, projection: proj(-0.10) }).fair;
  eq('raw -0.10 (away by 0.10) displays at the one-point floor', a.display_fair_spread, -1);
  eq('on the away side', a.favorite_team, AWAY);
  eq('as "Ole Miss -1.0"', a.fair_line_text, AWAY + ' -1.0');
  eq('and it is flagged a near pick’em', a.is_near_pickem, true);
  near('while the raw margin is kept exactly', a.raw_projected_margin, -0.10);
  eq('and stated for the displayed side', a.raw_line_text, AWAY + ' -0.10');

  const b = V.build({ game: GAME, projection: proj(0.10) }).fair;
  eq('raw +0.10 (home by 0.10) displays at +1 (home margin)', b.display_fair_spread, 1);
  eq('named for the home side', b.fair_line_text, HOME + ' -1.0');
  eq('near pick’em', b.is_near_pickem, true);

  const z = V.build({ game: GAME, projection: proj(0, { tiebreak: { win_probability: 0, weighted_components: -0.4 } }) }).fair;
  eq('an exact tie takes the engine’s deterministic tiebreak', z.display_side, 'away');
  eq('and still shows a one-point line', z.display_fair_spread, -1);
  eq('with the tie stated, not hidden', /exact tie/.test(z.raw_line_text), true);
  eq('and the basis names the step that decided it', z.basis && z.basis.step, 'weighted_components');
  const z2 = V.build({ game: GAME, projection: proj(0, { tiebreak: { win_probability: 0, weighted_components: -0.4 } }) }).fair;
  eq('the tiebreak is deterministic: the same inputs name the same side', z2.fair_line_text, z.fair_line_text);
  const z3 = V.build({ game: GAME, projection: proj(0) }).fair;
  eq('with nothing measurable the engine’s labelled home convention is used', z3.display_side, 'home');

  const c = V.build({ game: GAME, projection: proj(-6.54) }).fair;
  eq('a clear favourite is the raw number itself', c.display_fair_spread, -6.54);
  eq('shown as the favourite laying it', c.fair_line_text, AWAY + ' -6.5');
  eq('and is not a near pick’em', c.is_near_pickem, false);

  /* no displayed fair line is ever PK, 0, -0.5 or +0.5 */
  const banned = [];
  for (let i = -300; i <= 300; i++) {
    const raw = i / 100, f = V.build({ game: GAME, projection: proj(raw) }).fair;
    if (/(PK| 0\.0| [+-]?0\.5)$/.test(f.fair_line_text) || Math.abs(f.display_fair_spread) < 1) banned.push(raw);
    if (raw !== 0 && ((raw > 0) !== (f.display_side === 'home'))) banned.push('flip ' + raw);
  }
  chk('no displayed fair line from -3.00 to +3.00 is PK, 0, ±0.5, or on the wrong side', !banned.length, banned.slice(0, 5));

  eq('a model that publishes no display line shows its raw number (NFL-style)',
    V.build({ game: GAME, projection: { status: 'PREDICTED', model: { fair_spread: 3.2 } } }).fair.fair_line_text, HOME + ' -3.2');
  eq('a projection that is not PREDICTED has no fair line', V.build({ game: GAME, projection: { status: 'INSUFFICIENT_DATA' } }).fair, null);
  eq('and no projection at all is not projected', V.build({ game: GAME }).projected, false);
}

/* ======================================================================== */
section('STEP 2 · the market gap: magnitude, and which team EdgeDesk differs toward');
{
  function gapOf(raw, line) { return V.build({ game: GAME, projection: proj(raw, { line }) , market: { spread_line: line, book: 'consensus' } }).market_gap; }

  /* the specified example: market Florida (home) -2.5, EdgeDesk Ole Miss -1.0 */
  let g = gapOf(-1.0, 2.5);
  eq('market Florida -2.5 vs EdgeDesk Ole Miss -1.0 is 3.5 points', Math.round(g.points * 10) / 10, 3.5);
  eq('toward Ole Miss', g.toward_team, AWAY);
  eq('and says so', g.text, '3.5 pts toward ' + AWAY);
  eq('the market line is named for its own favourite', g.market_line_text, HOME + ' -2.5');
  eq('the two numbers name different favourites', g.favorite_differs, true);

  /* orientation, all four corners: a sign error would reverse every one */
  g = gapOf(10, 7);    eq('home fav, EdgeDesk likes home MORE (10 vs 7): toward the home favourite', g.toward_team, HOME);
  near('by 3', g.points, 3);
  g = gapOf(3, 7);     eq('home fav, EdgeDesk likes home LESS (3 vs 7): toward the away underdog', g.toward_team, AWAY);
  near('by 4', g.points, 4);
  g = gapOf(-10, -7);  eq('away fav, EdgeDesk likes away MORE: toward the away favourite', g.toward_team, AWAY);
  g = gapOf(-3, -7);   eq('away fav, EdgeDesk likes away LESS: toward the home underdog', g.toward_team, HOME);
  eq('the same favourite on both sides is not a favourite flip', g.favorite_differs, false);

  /* the gap IS the engine's own spread_gap, signed the same way */
  [[-1, 2.5], [10, 7], [3, 7], [-10, -7], [-3, -7], [0.4, -3]].forEach(([raw, line]) => {
    const p = proj(raw, { line });
    const v = V.build({ game: GAME, projection: p, market: { spread_line: line } });
    near('signed gap equals the engine’s spread_gap for raw ' + raw + ' vs line ' + line, v.market_gap.signed, p.market.spread_gap);
  });

  /* the display floor never manufactures a gap */
  g = gapOf(-0.31, 2.5);
  near('a near pick’em is measured from its RAW margin: 2.81, not 3.5', g.points, 2.81);
  chk('and the note says the display line was not used', /raw margin/.test(g.note), g.note);
  g = gapOf(0.2, 0.2);
  eq('a near pick’em equal to the market is NO gap, though the display reads -1.0', g.text, '0.0 pts — EdgeDesk matches the market');
  eq('with no direction', g.toward, null);

  g = gapOf(-3, 0);
  eq('a market pick’em is the market’s own number and is named as one', g.market_line_text, 'Pick’em');
  eq('the gap toward the away favourite', g.toward_team, AWAY);

  const none = V.build({ game: GAME, projection: proj(-3), market: { spread_line: null } }).market_gap;
  eq('no market line means no gap, never a zero', none.available, false);
  chk('and says why', /no market line/.test(none.reason), none.reason);
  const dropped = V.build({ game: GAME, projection: proj(-3), market: { spread_line: null, spread_fault: { gap: 40 } } }).market_gap;
  chk('a dropped line says it was dropped', /dropped/.test(dropped.reason), dropped.reason);
}

/* ======================================================================== */
section('STEP 3 · one research label, by rule and in order');
{
  const C = V.CONFIG;
  const FULL = { input_coverage: 0.9, known: 18, applicable: 20 };
  function label(raw, line, o) {
    o = o || {};
    const market = o.market || { spread_line: line, stale: !!o.stale };
    return V.build({ game: GAME, projection: o.projection || proj(raw, { line, conf: o.conf === undefined ? 62 : o.conf }),
      market, coverage: o.coverage === undefined ? FULL : o.coverage }).research_label;
  }
  /* the thresholds are the existing ones, named */
  const P = global.EDCfbP4Params;
  eq('the research threshold is the engine’s min_research_gap', C.research_gap, (P.market && P.market.min_research_gap) || 2);
  eq('the confidence floor is the engine’s min_confidence', C.min_confidence, (P.market && P.market.min_confidence) || 35);
  eq('the guard is the board’s FB_GUARD.p4.game', C.guard_gap, 21);
  eq('major is the board’s INVESTIGATE size', C.major_gap, 7);

  /* each threshold, at its edge (the market sits at home -3, i.e. margin +3) */
  eq('a 1.9-pt gap is MARKET ALIGNED', label(4.9, 3).key, 'MARKET_ALIGNED');
  eq('a 2.0-pt gap is WORTH RESEARCHING', label(5.0, 3).key, 'WORTH_RESEARCHING');
  eq('a 6.9-pt gap is WORTH RESEARCHING', label(9.9, 3).key, 'WORTH_RESEARCHING');
  eq('a 7.0-pt gap is a MAJOR DISAGREEMENT', label(10.0, 3).key, 'MAJOR_DISAGREEMENT');
  eq('a 21.0-pt gap is still a MAJOR DISAGREEMENT', label(24.0, 3).key, 'MAJOR_DISAGREEMENT');
  eq('past the 21-pt guard it is LOW RELIABILITY', label(24.1, 3).key, 'LOW_RELIABILITY');
  eq('confidence 35 is enough to read the gap', label(5, 3, { conf: 35 }).key, 'WORTH_RESEARCHING');
  eq('confidence 34.9 is LIMITED DATA', label(5, 3, { conf: 34.9 }).key, 'LIMITED_DATA');
  eq('an unmeasured confidence is LIMITED DATA, never healthy', label(5, 3, { conf: null }).key, 'LIMITED_DATA');
  eq('reliability 60% is enough', label(5, 3, { coverage: { input_coverage: 0.6 } }).key, 'WORTH_RESEARCHING');
  eq('reliability 59% is LOW RELIABILITY', label(5, 3, { coverage: { input_coverage: 0.59 } }).key, 'LOW_RELIABILITY');
  eq('an unmeasured reliability is LOW RELIABILITY', label(5, 3, { coverage: null }).key, 'LOW_RELIABILITY');
  eq('no market line is LIMITED DATA', label(5, null).key, 'LIMITED_DATA');
  eq('a stale-only market is LIMITED DATA', label(5, 3, { stale: true }).key, 'LIMITED_DATA');
  eq('a near pick’em is NEAR PICK’EM', label(0.4, -0.5).key, 'NEAR_PICKEM');
  eq('no projection is LIMITED DATA', label(0, 3, { projection: { status: 'INSUFFICIENT_DATA' } }).key, 'LIMITED_DATA');

  /* the priority order, where two rules both hold */
  eq('data problems outrank a near pick’em (low confidence)', label(0.4, 3, { conf: 20 }).key, 'LIMITED_DATA');
  eq('data problems outrank a near pick’em (low reliability)', label(0.4, 3, { coverage: { input_coverage: 0.4 } }).key, 'LOW_RELIABILITY');
  eq('no market outranks a near pick’em', label(0.4, null).key, 'LIMITED_DATA');
  eq('a near pick’em outranks a major disagreement', label(-0.4, 9).key, 'NEAR_PICKEM');
  eq('a near pick’em outranks worth researching', label(0.5, 3).key, 'NEAR_PICKEM');
  eq('the guard outranks thin data (a fault is named as a fault)', label(30, 3, { conf: 10 }).key, 'LOW_RELIABILITY');
  eq('low confidence outranks a major disagreement', label(12, 3, { conf: 20 }).key, 'LIMITED_DATA');
  eq('low reliability outranks a major disagreement', label(12, 3, { coverage: { input_coverage: 0.3 } }).key, 'LOW_RELIABILITY');
  eq('the major threshold outranks the research one', label(12, 3).key, 'MAJOR_DISAGREEMENT');

  /* the gap under the label is the raw one: a near pick'em against a
     1.2-pt market is aligned by value but named NEAR PICK'EM, and its sentence
     carries the raw gap, not one computed from the display line */
  const np = label(0.2, 1.2);
  chk('the near pick’em sentence quotes the raw gap', /1\.0 pts toward/.test(np.means), np.means);

  /* every label is one of the six, and none is a pick */
  const all = [label(4.9, 3), label(5, 3), label(10, 3), label(30, 3), label(5, 3, { conf: 10 }), label(5, null), label(0.4, 0)];
  chk('every result is one of the six supported labels', all.every(l => C && V.LABEL_KEYS.indexOf(l.key) >= 0 && V.LABELS[l.key].label === l.label));
  const BET = /\b(lock|best bet|guarantee|guaranteed|hammer|bet this|sure thing|play of the day)\b/i;
  chk('no label or sentence uses betting language', all.every(l => !BET.test(l.label) && !BET.test(l.means)), all.map(l => l.label));
  chk('every label explains itself in a written sentence', all.every(l => l.means && l.means.length > 60));
  chk('WORTH RESEARCHING says it is not a validated edge', /not a validated edge/.test(label(5, 3).means));
  chk('the labels carry no tone that reads as a recommendation', Object.keys(V.LABELS).every(k => !/buy|sell|take|fade/i.test(V.LABELS[k].label)));

  /* confidence and reliability, as numbers the engine and contract produced */
  const cf = V.build({ game: GAME, projection: proj(5, { line: 3, conf: 52.4 }), coverage: FULL });
  eq('confidence keeps the engine’s own score', cf.confidence.score, 52.4);
  eq('and reads Moderate between the floor and 60', cf.confidence.label, 'Moderate');
  eq('reliability is the input coverage', cf.reliability.pct, 90);
  eq('with the count behind it', cf.reliability.sub, '18 of 20 inputs on file');
  eq('High at 60+', V.confidence({ scores: { confidence: 60 } }).tier, 'HIGH');
  eq('Low under 35', V.confidence({ scores: { confidence: 34 } }).tier, 'LOW');
  eq('a thresholds override is honoured (the page passes the engine’s own)', V.build({ game: GAME,
    projection: proj(5, { line: 3 }), market: { spread_line: 3 }, coverage: FULL }, { research_gap: 2.5 }).research_label.key, 'MARKET_ALIGNED');
}

/* ======================================================================== */
section('STEP 4 · edge, confidence and reliability are three separate numbers');
{
  const good = V.build({ game: GAME, projection: proj(12, { line: 3, conf: 84 }), market: { spread_line: 3 },
    coverage: { input_coverage: 0.9, known: 18, applicable: 20 } });
  const weak = V.build({ game: GAME, projection: proj(12, { line: 3, conf: 84 }), market: { spread_line: 3 },
    coverage: { input_coverage: 0.4, known: 8, applicable: 20 } });
  const thin = V.build({ game: GAME, projection: proj(12, { line: 3, conf: 22 }), market: { spread_line: 3 },
    coverage: { input_coverage: 0.9, known: 18, applicable: 20 } });
  near('the same 9-pt gap on good data', good.market_gap.points, 9);
  near('on weak data', weak.market_gap.points, 9);
  near('and on thin data', thin.market_gap.points, 9);
  eq('good data reads MAJOR DISAGREEMENT', good.research_label.key, 'MAJOR_DISAGREEMENT');
  eq('the same gap on 40% reliability reads LOW RELIABILITY', weak.research_label.key, 'LOW_RELIABILITY');
  eq('the same gap on 22% confidence reads LIMITED DATA', thin.research_label.key, 'LIMITED_DATA');
  eq('confidence does not move with reliability', weak.confidence.score, good.confidence.score);
  eq('reliability does not move with confidence', thin.reliability.value, good.reliability.value);
  const smallGap = V.build({ game: GAME, projection: proj(3.5, { line: 3, conf: 84 }), market: { spread_line: 3 },
    coverage: { input_coverage: 0.9 } });
  eq('a small gap does not lower confidence', smallGap.confidence.score, good.confidence.score);
  eq('and a large one does not raise it', good.confidence.tier, 'HIGH');
  /* the normalised display line never touches confidence */
  const np = V.build({ game: GAME, projection: proj(0.2, { line: 3, conf: 50 }), market: { spread_line: 3 } });
  eq('a near pick’em’s confidence is the engine’s score, not boosted by the one-point floor', np.confidence.score, 50);
}

/* ======================================================================== */
section('STEP 5 · why EdgeDesk leans: the largest measured reasons on its side');
{
  const C = (key, points, confidence, extra) => Object.assign({ key, label: key, points, available: true,
    confidence: confidence == null ? 0.8 : confidence, source: 'engine' }, extra || {});
  function why(raw, contributions, o) {
    o = o || {};
    const p = proj(raw, { line: o.line, contributions });
    p.explanation.primary_drivers = o.drivers || [];
    return V.build({ game: GAME, projection: p, market: { spread_line: o.line == null ? null : o.line },
      coverage: { input_coverage: 0.9 } }).strongest_drivers;
  }
  /* EdgeDesk: Ole Miss (away) by 5.2 — away-side terms are negative */
  let w = why(-5.2, [C('rating', -6.8), C('hfa', 2.6), C('matchup', -0.9), C('qb', -0.3), C('conference', 0.1)]);
  eq('the lean is named for the side the fair line names', w.team, AWAY);
  eq('the largest component on that side comes first', w.reasons[0].key, 'rating');
  eq('stated with its points', w.reasons[0].text, '+6.8 pts team-strength edge (opponent-adjusted results)');
  eq('home field, which favours the OTHER side, is not a reason for this one', w.reasons.some(r => r.key === 'hfa'), false);
  eq('a term under half a point is not a reason', w.reasons.some(r => r.key === 'qb'), false);
  eq('so two reasons are shown, not padded to three', w.reasons.length, 2);

  w = why(8, [C('rating', 4), C('hfa', 3), C('matchup', 2), C('qb', 1.5)]);
  eq('at most three reasons', w.reasons.length, 3);
  eq('in size order', w.reasons.map(r => r.key).join(','), 'rating,hfa,matchup');

  w = why(3, [C('rating', 3.2, 0.1), C('hfa', 2.0)]);
  eq('a component measured with too little confidence is not a reliable reason', w.reasons.map(r => r.key).join(','), 'hfa');
  eq('and if only one reliable reason exists, one is shown', w.reasons.length, 1);

  w = why(3, [C('rating', 3, 0.8, { available: false }), C('hfa', 0.3)]);
  eq('with no meaningful component, it says so', w.text, 'No single component is driving the projection.');
  eq('and lists nothing', w.reasons.length, 0);

  const dup = why(6, [C('rating', 4), C('rating', 3), C('hfa', 2)]);
  eq('no term is repeated', dup.reasons.filter(r => r.key === 'rating').length, 1);

  /* the market gap closes the list as context, only when it agrees */
  w = why(-1.0, [C('rating', -2.5), C('matchup', -0.8)], { line: 2.5 });
  eq('the market gap is added as context when it points the lean’s way', w.reasons[w.reasons.length - 1].kind, 'market');
  chk('and names the market line', /Florida -2\.5/.test(w.reasons[w.reasons.length - 1].text), w.reasons);
  w = why(-5.2, [C('rating', -5.2)], { line: -7 });
  eq('a gap toward the OTHER side is not offered as a reason', w.reasons.some(r => r.kind === 'market'), false);
  w = why(9, [C('rating', 4), C('hfa', 3), C('matchup', 2)], { line: 3 });
  eq('components come before market context when there is room for only three', w.reasons.some(r => r.kind === 'market'), false);

  /* the engine’s own sentence rides along, never a written one */
  w = why(6, [C('matchup', 2.1)], { drivers: [{ key: 'matchup', points: 2.1, text: 'Stylistically the matchup favours Florida by 2.1 points: run game vs run defence' }] });
  eq('the engine’s own sentence is carried as the detail', w.reasons[0].detail, 'Stylistically the matchup favours Florida by 2.1 points: run game vs run defence');
  /* deterministic, and nothing invented */
  const a1 = JSON.stringify(why(8, [C('hfa', 2), C('rating', 2), C('matchup', 2)]));
  const a2 = JSON.stringify(why(8, [C('matchup', 2), C('rating', 2), C('hfa', 2)]));
  eq('equal-sized reasons order by key, whatever order they arrive in', a1, a2);
  chk('every reason names a term the engine priced, or the market', why(8, [C('hfa', 2), C('rating', 5)]).reasons.every(r =>
    r.kind === 'market' || Object.prototype.hasOwnProperty.call(V.DRIVER_TEXT, r.key)));
  const BANNED = /injur(y|ed)|coach(ing)? reputation|revenge|momentum|must[- ]win|lock/i;
  chk('no reason text invents a narrative', Object.keys(V.DRIVER_TEXT).every(k => !BANNED.test(V.DRIVER_TEXT[k])));
  eq('no projection, no reasons', V.build({ game: GAME, projection: null }).strongest_drivers, null);
  /* a near pick'em still names its reasons, and flags the thinness */
  w = why(0.4, [C('hfa', 2.6), C('rating', -2.2)]);
  eq('a near pick’em lists what it has', w.reasons.map(r => r.key).join(','), 'hfa');
  eq('and is flagged as a near pick’em', w.near_pickem, true);
}

/* ======================================================================== */
section('STEP 6 · best available line: current, named, priced — or said to be unavailable');
{
  const Q = (side, book, line, dec, o) => Object.assign({ side, book, line, price_dec: dec, n_books: null,
    captured_at: '2026-09-25T12:00:00Z', state: 'CURRENT', actionable: true }, o || {});
  function best(quotes, raw, line) {
    return V.build({ game: GAME, projection: proj(raw == null ? -1 : raw, { line: line == null ? 2.5 : line }),
      market: { spread_line: line == null ? 2.5 : line, book: 'cfb.lines · consensus' }, quotes,
      coverage: { input_coverage: 0.9 } }).best_available_line;
  }
  /* market Florida (home) -2.5; EdgeDesk Ole Miss -1: the gap points to Ole Miss */
  let b = best([Q('away', 'DraftKings', 2.5, 1.91), Q('away', 'FanDuel', 3.0, 1.87), Q('away', 'BetMGM', 3.0, 1.83),
    Q('home', 'DraftKings', -2.5, 1.91), Q('home', 'Caesars', -2.0, 1.83)]);
  eq('multiple valid books: available', b.available, true);
  eq('the focus side is the one EdgeDesk likes more than the market', b.focus_side, 'away');
  eq('the most points for Ole Miss wins', b.focus.line, 3.0);
  eq('a tie on the line goes to the better price', b.focus.book, 'FanDuel');
  eq('stated with the book and the price', b.focus.text, AWAY + ' +3.0 (-115) at FanDuel');
  eq('the other side is shopped too', b.home.text, HOME + ' -2.0 (-120) at Caesars');
  eq('it counts the books', b.n_books, 4);
  eq('it is not a single-book result', b.single_book, false);
  eq('against the board’s own number for that side', b.board_line, 2.5);
  eq('it is half a point better', b.improvement, 0.5);
  eq('and the board number keeps its own source, never called consensus by this layer', b.board_source, 'cfb.lines · consensus');

  b = best([Q('away', 'DraftKings', 3.0, 1.91), Q('home', 'DraftKings', -3.0, 1.91)]);
  eq('one valid book: the quote is shown', b.available, true);
  eq('but flagged as a single book', b.single_book, true);
  chk('and says there is no line shopping to compare', /no line shopping/.test(b.note), b.note);
  b = best([Q('away', 'DraftKings', 3.0, 1.91, { n_books: 6 })]);
  eq('a quote the capture compared across six books is a multi-book best', b.single_book, false);

  b = best([Q('away', 'FanDuel', 4.0, 1.91, { state: 'STALE', actionable: false }), Q('away', 'DraftKings', 3.0, 1.91)]);
  eq('a stale book is excluded, however good its number', b.focus.book, 'DraftKings');
  eq('and counted', b.excluded.stale, 1);
  b = best([Q('away', 'FanDuel', 4.0, 1.91, { state: 'STALE', actionable: false })]);
  eq('only stale quotes: nothing is available', b.available, false);
  chk('and it says why', /freshness limit/.test(b.reason), b.reason);
  b = best([Q('away', 'FanDuel', 4.0, 1.91, { state: 'UNKNOWN', actionable: false, captured_at: null })]);
  eq('a quote with no verifiable capture time is not available', b.available, false);
  chk('and says so', /capture time/.test(b.reason), b.reason);
  b = best([Q('away', 'FanDuel', 3.5, null), Q('away', 'DraftKings', 3.0, 1.91)]);
  eq('a missing price does not disqualify the better number', b.focus.book, 'FanDuel');
  eq('it is printed as missing, never assumed', b.focus.text, AWAY + ' +3.5 (price not captured) at FanDuel');
  eq('with no American price', b.focus.price_american, null);
  b = best([Q('away', 'FanDuel', null, 1.91), Q('away', 'DraftKings', 3.0, 1.91)]);
  eq('a quote with no line is excluded', b.focus.book, 'DraftKings');
  eq('and counted', b.excluded.no_line, 1);
  b = best([Q('away', null, 3.0, 1.91)]);
  eq('a quote with no book named is never shown as available', b.available, false);
  b = best(null);
  eq('no captured quotes at all: unavailable', b.available, false);
  chk('and says nothing was captured', /no sportsbook quote/.test(b.reason), b.reason);
  const o1 = JSON.stringify(best([Q('away', 'B', 3, 1.9), Q('away', 'A', 3, 1.9)]).focus);
  const o2 = JSON.stringify(best([Q('away', 'A', 3, 1.9), Q('away', 'B', 3, 1.9)]).focus);
  eq('an exact tie is broken by book name, whatever order the quotes arrive in', o1, o2);
  eq('decimal 1.91 is -110', V.american(1.91), -110);
  eq('decimal 2.5 is +150', V.american(2.5), 150);
}

/* ======================================================================== */
section('STEP 7 · projection status and stability, from stored EdgeDesk numbers only');
{
  const NOW = Date.parse('2026-09-24T18:00:00Z');
  const REC = (first, latest, o) => Object.assign({
    first: first == null ? null : { at: '2026-09-22T14:00:00Z', margin: first },
    latest: latest == null ? null : { at: '2026-09-24T09:00:00Z', margin: latest },
    revisions: first === latest ? 0 : 1 }, o || {});
  function hist(raw, rec, o) {
    o = o || {};
    const p = proj(raw, { line: 2.5, conf: o.conf === undefined ? 70 : o.conf, layers: o.layers });
    return V.build({ game: GAME, projection: p, market: { spread_line: 2.5 }, coverage: { input_coverage: 0.9 },
      record: rec, now: NOW, h2h_pp: o.h2h }).history;
  }
  let h = hist(-1.6, null);
  eq('no stored history: NO HISTORY', h.status.key, 'NO_HISTORY');
  eq('and no stability, never a guess', h.stability.tier, null);
  eq('no previous projection is invented', h.previous, null);
  chk('it says nothing is stored', /No earlier EdgeDesk number/.test(h.status.text), h.status.text);

  h = hist(-1.6, REC(-1.4, -1.4));
  eq('within 0.75 of the stored number: STABLE', h.status.key, 'STABLE');
  eq('and says it is inside the band, with the small move', h.status.text,
    'EdgeDesk’s number is within 0.75 pts of the latest published number (0.2 toward Ole Miss).');
  eq('an unmoved number says unchanged', hist(-1.4, REC(-1.4, -1.4)).status.text, 'EdgeDesk’s number is unchanged since the latest published number.');
  eq('stability carries its label once, apart from its text', hist(-1.6, REC(-1.4, -1.4)).stability.label, 'High');
  chk('and the text does not repeat it', !/^High/.test(hist(-1.6, REC(-1.4, -1.4)).stability.text));
  near('the change is measured from the latest stored number', h.change.signed, -0.2, 1e-9);
  eq('high stability', h.projection_stability === undefined ? h.stability.tier : h.stability.tier, 'HIGH');

  h = hist(-1.6, REC(1.2, -0.3));
  eq('1.3 pts off the latest stored number: MOVING', h.status.key, 'MOVING');
  eq('toward the away side', h.change.toward_team, AWAY);
  chk('it says how far and toward whom', /1\.3 pts toward Ole Miss since the latest published number/.test(h.status.text), h.status.text);
  near('and since the first published number', h.since_first.signed, -2.8, 1e-9);
  eq('stability spans the whole stored range: 2.8 pts is LOW', h.stability.tier, 'LOW');
  eq('the timeline is first, latest, current', h.points.map(x => x.source).join(','), 'first published,latest published,current');
  eq('each written as a side line off the RAW margin', h.points.map(x => x.text).join(' | '), HOME + ' -1.2 | ' + AWAY + ' -0.30 | ' + AWAY + ' -1.6');

  h = hist(-3.0, REC(0, 0.5));
  eq('3.5 pts off the latest stored number: SIGNIFICANT CHANGE', h.status.key, 'SIGNIFICANT_CHANGE');
  h = hist(-1.6, REC(1.4, -1.6));
  eq('a projection that swung earlier and has held since is STABLE…', h.status.key, 'STABLE');
  eq('…with LOW stability — both true, and both shown', h.stability.tier, 'LOW');
  h = hist(-1.6, REC(-1.9, -1.9));
  eq('0.3 pts of range is HIGH stability', h.stability.tier, 'HIGH');
  h = hist(-1.6, REC(-0.4, -0.4));
  eq('1.2 pts of range is MEDIUM stability', h.stability.tier, 'MEDIUM');

  /* thresholds sit where CONFIG says */
  eq('exactly 0.75 is MOVING', hist(-1.0, REC(-0.25, -0.25)).status.key, 'MOVING');
  eq('0.74 is STABLE', hist(-0.99, REC(-0.25, -0.25)).status.key, 'STABLE');
  eq('exactly 2.0 is still MOVING', hist(-2.0, REC(0, 0)).status.key, 'MOVING');
  eq('2.01 is SIGNIFICANT CHANGE', hist(-2.01, REC(0, 0)).status.key, 'SIGNIFICANT_CHANGE');

  /* nothing from the future, nothing invented in between */
  h = hist(-1.6, { first: { at: '2026-09-30T00:00:00Z', margin: 3 }, latest: null, revisions: 0 });
  eq('a stored number stamped after now is ignored', h.status.key, 'NO_HISTORY');
  h = hist(-1.6, REC(1.2, -0.3, { revisions: 4 }));
  eq('four revisions are reported as a count, not as invented points', h.points.length, 3);
  eq('and the count is kept', h.revisions, 4);
  const stale = hist(-1.6, REC(-1.4, -1.4));
  eq('stability never moves the raw projection', V.build({ game: GAME, projection: proj(-1.6, { line: 2.5 }) }).raw_projected_margin, -1.6);
  chk('(and the history object carries no margin of its own to substitute)', !('raw_projected_margin' in stale));

  /* limited data outranks movement */
  eq('under the confidence floor the status is LIMITED DATA', hist(-3, REC(0, 0), { conf: 20 }).status.key, 'LIMITED_DATA');

  /* injury uncertainty: only from a SUPPLIED report */
  const absent = { injuries: { home: { uncertainty: { available: true, value: 1, source: 'declared missing' }, detail: [] },
    away: { uncertainty: { available: true, value: 1, source: 'declared missing' }, detail: [] } } };
  eq('an absent report is not INJURY UNCERTAINTY, even at the maximum value', hist(-1.6, REC(-1.4, -1.4), { layers: absent }).status.key, 'STABLE');
  const gtd = { injuries: { home: { uncertainty: { available: true, value: 0.28, source: 'injury status ambiguity' },
    detail: [{ player: 'J. Doe', position: 'QB', status: 'questionable' }] }, away: absent.injuries.away } };
  h = hist(-1.6, REC(-1.4, -1.4), { layers: gtd });
  eq('a supplied report with a game-time decision on a starter is INJURY UNCERTAINTY', h.status.key, 'INJURY_UNCERTAINTY');
  eq('it names who, from the report', h.injury.players[0].player, 'J. Doe');
  const mild = { injuries: { home: { uncertainty: { available: true, value: 0.08, source: 'injury status ambiguity' }, detail: [] }, away: absent.injuries.away } };
  eq('a supplied report with little ambiguity is not', hist(-1.6, REC(-1.4, -1.4), { layers: mild }).status.key, 'STABLE');

  /* the market moving, from the same record and the same source */
  const mm = REC(-1.4, -1.4, { market_entry: { at: '2026-09-22T14:00:00Z', margin: 1.0, source: 'ESPN · DraftKings' },
    market_latest: { at: '2026-09-24T09:00:00Z', margin: 2.5, source: 'ESPN · DraftKings' } });
  h = hist(-1.6, mm);
  eq('a steady EdgeDesk number with a market that moved 1.5 is LINE MOVING', h.status.key, 'LINE_MOVING');
  chk('and says toward whom', /1\.5 pts toward Florida/.test(h.status.text), h.status.text);
  const mixed = REC(-1.4, -1.4, { market_entry: { at: '2026-09-22T14:00:00Z', margin: 1.0, source: 'ESPN · DraftKings' },
    market_latest: { at: '2026-09-24T09:00:00Z', margin: 2.5, source: 'ESPN · FanDuel' } });
  eq('two different sources are never differenced into a move', hist(-1.6, mixed).status.key, 'STABLE');
  eq('a 3.5 pp moneyline move is LINE MOVING', hist(-1.6, REC(-1.4, -1.4), { h2h: 3.5 }).status.key, 'LINE_MOVING');
  eq('EdgeDesk moving (1.6 pts) outranks the market moving', hist(-3, mm).status.key, 'MOVING');
  chk('every status is one of the supported ones', ['NO_HISTORY', 'STABLE', 'MOVING', 'SIGNIFICANT_CHANGE', 'LIMITED_DATA',
    'INJURY_UNCERTAINTY', 'LINE_MOVING'].every(k => V.STATUS[k]));
}

/* ======================================================================== */
section('STEP 8 · what changed: the size, the terms when stored, never a cause');
{
  const NOW = Date.parse('2026-09-24T18:00:00Z');
  const T = (key, points) => ({ key, label: key, points, available: true, confidence: 0.8 });
  function changed(raw, contributions, o) {
    o = o || {};
    const p = proj(raw, { line: o.line == null ? 2.5 : o.line, contributions, conf: 70 });
    p.model_version = o.version || 'edgedesk_cfb_p4_v1.0.0';
    return V.build({ game: GAME, projection: p, market: { spread_line: o.line == null ? 2.5 : o.line, book: o.book || 'cfb.lines · consensus' },
      coverage: { input_coverage: 0.9 }, record: o.record || null, visit: o.visit || null, now: NOW }).what_changed;
  }
  let w = changed(-1.6, [T('rating', -1.6)]);
  eq('no stored snapshot: nothing to show', w.available, false);
  chk('and it says so', /No earlier EdgeDesk snapshot/.test(w.summary), w.summary);

  /* the record: first Tue (Florida by 1.2), latest Thu (Ole Miss by 0.8), now Ole Miss by 1.6 */
  const rec = { first: { at: '2026-09-22T14:00:00Z', margin: 1.2 }, latest: { at: '2026-09-24T09:00:00Z', margin: -0.8 }, revisions: 1 };
  w = changed(-1.6, [T('rating', -1.6)], { record: rec });
  eq('from the record: available', w.available, true);
  eq('measured from the first published number', w.basis, 'record');
  near('2.8 points', w.change.points, 2.8, 1e-9);
  eq('toward Ole Miss', w.change.toward_team, AWAY);
  eq('the timeline is first, latest, now', w.timeline.map(x => x.text).join(' → '), HOME + ' -1.2 → ' + AWAY + ' -0.80 → ' + AWAY + ' -1.6');
  eq('the record keeps no terms, so none are listed', w.components, null);
  chk('and it says attribution is unavailable', /Component-level attribution is unavailable/.test(w.attribution_text), w.attribution_text);
  chk('in the specified words', /Projection changed 2\.8 points since the first published number\./.test(w.attribution_text), w.attribution_text);

  /* this device's last visit, which carried the terms */
  const visit = { t: Date.parse('2026-09-23T20:00:00Z'), m: -0.4, c: { rating: -1.5, hfa: 2.6, matchup: -1.5 }, k: 1.0,
    s: 'cfb.lines · consensus', l: 'WORTH_RESEARCHING', g: 1.4, v: 'edgedesk_cfb_p4_v1.0.0' };
  w = changed(-1.6, [T('rating', -2.7), T('hfa', 2.6), T('matchup', -1.5)], { visit, record: rec });
  eq('a stored visit is the richer baseline', w.basis, 'visit');
  near('1.2 points since the visit', w.change.points, 1.2, 1e-9);
  eq('attributed term by term', w.attribution, 'exact');
  eq('the term that moved is listed', w.components.map(c => c.key).join(','), 'rating');
  chk('with its size and direction', /Opponent-adjusted team rating moved 1\.2 pts toward Ole Miss/.test(w.components[0].text), w.components[0].text);
  eq('an unchanged term is not listed', w.components.some(c => c.key === 'hfa'), false);
  chk('the attribution says it is arithmetic, not a cause', /not why/.test(w.attribution_text), w.attribution_text);
  chk('the terms account for the whole change', Math.abs(w.components.reduce((a, c) => a + c.delta, 0) - w.change.signed) < 0.01);
  chk('the market moved 1.5 pts toward Florida, from the same source', /Market moved 1\.5 pts toward Florida \(cfb\.lines · consensus\)/.test(w.market && w.market.text), w.market);
  w = changed(-1.6, [T('rating', -2.7), T('hfa', 2.6), T('matchup', -1.5)], { visit, book: 'captured · DraftKings' });
  eq('a market quote from a different source is never differenced', w.market, null);
  w = changed(-1.6, [T('rating', -2.7), T('hfa', 2.6), T('matchup', -1.5)], { visit, version: 'edgedesk_cfb_p4_v1.1.0' });
  chk('a model-version change is reported as a fact', /model version changed/.test(w.model_version && w.model_version.text), w.model_version);
  w = changed(-0.4, [T('rating', -1.5), T('hfa', 2.6), T('matchup', -1.5)], { visit });
  chk('no change says so', /has not moved since your last visit/.test(w.summary), w.summary);
  eq('and lists nothing', w.components.length, 0);
  const small = changed(-0.7, [T('rating', -1.6), T('hfa', 2.5), T('matchup', -1.6)], { visit });
  eq('moves under a quarter point are not listed', small.components.length, 0);
  chk('and the spread-out change is said to be spread out', /spread across several small ones/.test(small.attribution_text), small.attribution_text);
  const future = changed(-1.6, [T('rating', -2.7)], { visit: Object.assign({}, visit, { t: NOW + 60000 }) });
  eq('a visit stamped after now is not a baseline', future.available, false);
  const CAUSE = /\bbecause\b|\bdue to\b|\bcaused\b|\binjur/i;
  chk('no sentence asserts a cause', [changed(-1.6, [T('rating', -2.7), T('hfa', 2.6), T('matchup', -1.5)], { visit })]
    .every(x => !CAUSE.test(x.summary) && !CAUSE.test(x.attribution_text || '') && (x.components || []).every(c => !CAUSE.test(c.text))));

  /* the snapshot a device stores is exactly what was shown */
  const v = V.build({ game: GAME, projection: proj(-1.6, { line: 2.5, contributions: [T('rating', -2.7), T('hfa', 2.6), T('qb', 0)] }),
    market: { spread_line: 2.5, book: 'cfb.lines · consensus' }, coverage: { input_coverage: 0.9 } });
  const snap = V.snapshotOf(v, { contributions: [T('rating', -2.7), T('hfa', 2.6), T('qb', 0)], model_version: 'x' }, NOW);
  eq('the snapshot keeps the raw margin', snap.m, -1.6);
  eq('and the non-zero terms', JSON.stringify(snap.c), JSON.stringify({ rating: -2.7, hfa: 2.6 }));
  eq('the market line and its source', snap.k + ' · ' + snap.s, '2.5 · cfb.lines · consensus');
  eq('the label', snap.l, v.research_label.key);
  eq('no projection, no snapshot', V.snapshotOf(V.build({ game: GAME }), null, NOW), null);
}

/* ======================================================================== */
section('STEP 10 · the research desk: label counts and what changed since');
{
  const NOW = Date.parse('2026-09-24T18:00:00Z');
  const FULL = { input_coverage: 0.9 };
  function view(id, raw, line, o) {
    o = o || {};
    return V.build({ game: { game_id: id, home: HOME, away: AWAY }, projection: proj(raw, { line, conf: o.conf == null ? 70 : o.conf }),
      market: { spread_line: line, book: 'cfb.lines · consensus' }, coverage: o.coverage || FULL, record: o.record || null, now: NOW });
  }
  const views = [view('a', 5, 3), view('b', 6, 3), view('c', 3.4, 3), view('d', 12, 3), view('e', 0.4, -0.5),
    view('f', 5, null), view('g', 5, 3, { coverage: { input_coverage: 0.3 } })];
  const d = V.deskSummary(views);
  eq('every game is counted once', d.total, 7);
  eq('two worth researching', d.counts.WORTH_RESEARCHING, 2);
  eq('one market aligned', d.counts.MARKET_ALIGNED, 1);
  eq('one major disagreement', d.counts.MAJOR_DISAGREEMENT, 1);
  eq('one near pick’em', d.counts.NEAR_PICKEM, 1);
  eq('one limited data (no market)', d.counts.LIMITED_DATA, 1);
  eq('one low reliability', d.counts.LOW_RELIABILITY, 1);
  eq('the desk lists every label, worth researching first', d.items.map(i => i.key)[0], 'WORTH_RESEARCHING');
  eq('six labels, no more', d.items.length, 6);
  chk('and the counts sum to the board', d.items.reduce((a, i) => a + i.n, 0) === d.total);

  /* since this device's last visit */
  const visits = {
    a: { m: 3.5, g: 1.5, l: 'MARKET_ALIGNED' },    /* moved 1.5, gap widened 0.5 → not widened; moved INTO worth */
    b: { m: 6.0, g: 3.0, l: 'WORTH_RESEARCHING' }, /* unchanged */
    d: { m: 9.0, g: 6.0, l: 'WORTH_RESEARCHING' }  /* moved 3.0, gap widened 3.0 */
  };
  const ch = V.changes(views, { visits, visit_at: NOW - 86400e3, now: NOW });
  eq('with a visit stored, the baseline is the visit', ch.basis, 'visit');
  eq('two projections moved 0.75+', ch.projections_changed, 2);
  eq('one market gap widened 0.75+', ch.gaps_widened, 1);
  eq('one game moved into worth researching', ch.into_worth, 1);
  eq('and those are the games', ch.games.into_worth.join(','), 'a');
  eq('games not seen last time (c, e, f, g) are counted as new, not as changes', ch.new_games, 4);

  /* no visit: the last published update */
  const rec = (latestMargin, revs, at) => ({ first: { at: '2026-09-20T12:00:00Z', margin: 0 }, latest: { at, margin: latestMargin }, revisions: revs });
  const vu = [view('p', 5, 3, { record: rec(3.9, 2, '2026-09-24T09:00:00Z') }),  /* 1.1 off the latest, revised 9h ago */
    view('q', 5, 3, { record: rec(5.0, 1, '2026-09-21T09:00:00Z') }),             /* matches, revised days ago */
    view('r', 5, 3)];                                                            /* no history */
  const cu = V.changes(vu, { now: NOW });
  eq('without a visit, the baseline is the last published update', cu.basis, 'update');
  eq('one projection differs from its latest published number', cu.projections_changed, 1);
  eq('one was revised in the last 24 hours', cu.revised_24h, 1);
  eq('gap and label changes cannot be counted from the record, so they are unavailable, not zero', cu.gaps_widened, null);
  eq('nor moves into worth researching', cu.into_worth, null);
  eq('with no history at all there is no baseline', V.changes([view('z', 5, 3)], { now: NOW }).basis, null);
  eq('a visit stamped in the future is not a baseline', V.changes(views, { visits, visit_at: NOW + 1000, now: NOW }).basis, null);
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);
