#!/usr/bin/env node
/* ===========================================================================
   Tests for lib/research_priority.js — the "5 Games Worth Researching"
   reading order over the football board.

   What they hold:
     1  the eligibility gates: DATA FAULT, no market, a stale quote, THIN
        DATA, no projection, no normalized gap and nothing to explain each
        keep a game out, and a valid RESEARCH game gets in;
     2  an INVESTIGATE game gets in only when it clears every other gate, and
        when it does it is marked higher-uncertainty and pays for it;
     3  the score does not rank by raw point gap alone;
     4  the order is deterministic — no input order changes it — and the tie
        breaks run in the documented order;
     5  fewer than five eligible games returns that many; more returns five;
     6  nothing is filled in, nothing is mutated, and nothing reads as a pick.

   Run: node tools/football/research_priority.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'research_priority.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function same(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

/* A valid CFB RESEARCH game: Ole Miss @ Florida, market Florida -2, EdgeDesk
   Ole Miss by 4.1 (home margins: market +2, model -4.1). */
function cand(o) {
  return Object.assign({
    key: 'cfb|1', sport: 'cfb', home: 'Florida', away: 'Ole Miss',
    kickoff: Date.parse('2026-09-26T16:00:00Z'),
    status: 'RESEARCH', projected: true,
    model_margin: -4.1, market_margin: 2, normalized_gap: 0.35,
    market: { kind: 'live', age_h: 1.5, stale: false, source: 'captured · DraftKings' },
    fault: false, thin: false, completeness: 0.85,
    flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'], qualifiers: [],
    model_total: 52.1, market_total: 50.5, total_gap: 1.6,
    movement: { spread_moved: null, spread_toward_model: null, h2h_pp: null },
    qb_unknown: false
  }, o || {});
}
/* a plain eligible game with a chosen gap and normalized gap */
function game(key, gap, z, o) {
  return cand(Object.assign({ key: key, model_margin: 3 + gap, market_margin: 3, normalized_gap: z,
    flags: gap >= 2 ? ['SPREAD_LEAN'] : [] }, o || {}));
}
function reasons(c) { return P.eligibility(c).reasons; }

/* ======================================================================== */
/* 1. THE GATES                                                             */
/* ======================================================================== */
const ok = P.eligibility(cand());
chk('a valid RESEARCH game is eligible', ok.eligible, ok.reasons);
eq('and is ranked', P.rank([cand()]).items.length, 1);

/* DATA FAULT */
chk('DATA FAULT status is excluded', reasons(cand({ status: 'DATA FAULT' })).indexOf('DATA_FAULT') >= 0);
chk('the board fault condition is excluded even under another label', reasons(cand({ fault: true })).indexOf('DATA_FAULT') >= 0);
eq('a DATA FAULT game never reaches the list', P.rank([cand({ status: 'DATA FAULT' })]).items.length, 0);

/* no market */
chk('no market number is excluded', reasons(cand({ market_margin: null })).indexOf('NO_MARKET') >= 0);
chk('NO MARKET status is excluded', reasons(cand({ status: 'NO MARKET' })).indexOf('NO_MARKET') >= 0);
chk('a market with no known kind is excluded', reasons(cand({ market: null })).indexOf('NO_MARKET') >= 0);
chk('the shared layer NO_MARKET qualifier is excluded', reasons(cand({ qualifiers: ['NO_MARKET'] })).indexOf('NO_MARKET') >= 0);
chk('a market kind this order does not know is excluded', reasons(cand({ market: { kind: 'guess' } })).indexOf('NO_MARKET') >= 0);

/* stale */
chk('STALE QUOTE status is excluded', reasons(cand({ status: 'STALE QUOTE' })).indexOf('STALE_MARKET') >= 0);
chk('a quote the board marks stale is excluded', reasons(cand({ market: { kind: 'live', age_h: 80, stale: true } })).indexOf('STALE_MARKET') >= 0);
chk('a quote the research layer flags STALE_MARKET is excluded', reasons(cand({ qualifiers: ['STALE_MARKET'] })).indexOf('STALE_MARKET') >= 0);

/* thin data, no projection */
chk('THIN DATA status is excluded', reasons(cand({ status: 'THIN DATA' })).indexOf('THIN_DATA') >= 0);
chk('the low-confidence condition is excluded', reasons(cand({ thin: true })).indexOf('THIN_DATA') >= 0);
chk('no PREDICTED projection is excluded', reasons(cand({ projected: false })).indexOf('NOT_PROJECTED') >= 0);
chk('AWAITING DATA is excluded', reasons(cand({ status: 'AWAITING DATA' })).indexOf('NOT_PROJECTED') >= 0);
chk('NFL NOT PRICED is excluded', reasons(cand({ sport: 'nfl', status: 'NOT PRICED' })).indexOf('NOT_PROJECTED') >= 0);
chk('a projection without a number is excluded', reasons(cand({ model_margin: null })).indexOf('NOT_PROJECTED') >= 0);

/* missing is excluded, never estimated */
same('no normalized gap is excluded rather than estimated from the raw gap',
  reasons(cand({ normalized_gap: null })), ['NO_NORMALIZED_GAP']);
same('an unknown status is excluded', reasons(cand({ status: 'SOMETHING ELSE' })), ['STATUS']);
same('a game with nothing to explain is excluded',
  reasons(cand({ model_margin: 3, market_margin: 2, normalized_gap: 0.09, flags: [] })), ['NOTHING_TO_EXPLAIN']);
chk('but a measured market move is a reason on its own',
  P.eligibility(cand({ model_margin: 3, market_margin: 2, normalized_gap: 0.09, flags: [], movement: { h2h_pp: 1.4 } })).eligible);
same('qualifier flags are never a reason on their own',
  reasons(cand({ model_margin: 3, market_margin: 2, normalized_gap: 0.09, flags: ['HIGH_UNCERTAINTY'] })), ['NOTHING_TO_EXPLAIN']);
same('NFL AGREEMENT inside 2 pts with no flag has nothing to explain',
  reasons(cand({ sport: 'nfl', status: 'AGREEMENT', model_margin: 3.5, market_margin: 2.5, normalized_gap: 0.09, flags: [], completeness: null })),
  ['NOTHING_TO_EXPLAIN']);
chk('every exclusion reason has a written meaning',
  Object.keys(P.REASONS).every(k => typeof P.REASONS[k] === 'string' && P.REASONS[k].length > 5));

/* ======================================================================== */
/* 2. INVESTIGATE: only when otherwise eligible, and marked for it          */
/* ======================================================================== */
const inv = cand({ key: 'cfb|inv', status: 'INVESTIGATE', model_margin: -7.5, market_margin: 2, normalized_gap: 0.62 });
chk('an otherwise-eligible INVESTIGATE game is allowed', P.eligibility(inv).eligible, reasons(inv));
chk('and is marked elevated uncertainty', P.uncertainty(inv).elevated);
same('because of the size of its gap', P.uncertainty(inv).reasons, ['large_gap']);
eq('which costs it the elevated-gap penalty', P.score(inv).penalties.uncertainty, P.PENALTY.elevated_gap);
chk('INVESTIGATE with a stale quote is not allowed', !P.eligibility(Object.assign({}, inv, { qualifiers: ['STALE_MARKET'] })).eligible);
chk('INVESTIGATE with no market is not allowed', !P.eligibility(Object.assign({}, inv, { market_margin: null })).eligible);
chk('INVESTIGATE marked thin is not allowed', !P.eligibility(Object.assign({}, inv, { thin: true })).eligible);
chk('INVESTIGATE past the guard is not allowed', !P.eligibility(Object.assign({}, inv, { fault: true })).eligible);
/* a comparable RESEARCH game, smaller gap, same data, reads first */
const res = cand({ key: 'cfb|res', model_margin: -2.5, market_margin: 2, normalized_gap: 0.3 });
same('a comparable RESEARCH game is read before the INVESTIGATE one',
  P.rank([inv, res]).items.map(x => x.key), ['cfb|res', 'cfb|inv']);
/* NFL's research band is INVESTIGATE 2-14 pts; only 7+ is elevated */
const nflBand = cand({ key: 'nfl|band', sport: 'nfl', status: 'INVESTIGATE', model_margin: 5.5, market_margin: 2.5, normalized_gap: 0.28, completeness: null });
chk('an NFL INVESTIGATE gap inside 7 pts is not marked elevated', !P.uncertainty(nflBand).elevated);
const nflWide = cand({ key: 'nfl|wide', sport: 'nfl', status: 'INVESTIGATE', model_margin: 10.5, market_margin: 2.5, normalized_gap: 0.75, completeness: null });
chk('an NFL INVESTIGATE gap of 7+ pts is', P.uncertainty(nflWide).elevated);
/* data uncertainty is elevated whatever the status */
same('the shared layer HIGH_UNCERTAINTY qualifier elevates a RESEARCH game',
  P.uncertainty(cand({ qualifiers: ['HIGH_UNCERTAINTY'] })).reasons, ['high_uncertainty']);
same('so does an unknown QB starter', P.uncertainty(cand({ qb_unknown: true })).reasons, ['qb_unknown']);

/* ======================================================================== */
/* 3. THE SCORE                                                             */
/* ======================================================================== */
/* not a raw-gap sort: a 12-pt INVESTIGATE gap with thin coverage reads after
   a 4-pt RESEARCH gap with strong coverage */
const huge = cand({ key: 'cfb|huge', status: 'INVESTIGATE', model_margin: -10, market_margin: 2, normalized_gap: 0.8,
  completeness: 0.55, qualifiers: ['HIGH_UNCERTAINTY'] });
const solid = cand({ key: 'cfb|solid', model_margin: -2, market_margin: 2, normalized_gap: 0.27, completeness: 0.92 });
chk('the huge gap is the larger raw gap', P.gap(huge) > P.gap(solid));
same('but the well-covered game is read first', P.rank([huge, solid]).items.map(x => x.key), ['cfb|solid', 'cfb|huge']);
/* the disagreement term stops growing past Z_FULL */
eq('the disagreement term saturates', P.score(cand({ normalized_gap: 2.4 })).parts.disagreement, 1);
chk('below it, a bigger normalized gap scores higher',
  P.score(cand({ normalized_gap: 0.4 })).score > P.score(cand({ normalized_gap: 0.3 })).score);
/* independence: three names for the spread disagreement count once */
const fl = P.flagsFor(cand({ flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'] }));
chk('the flip is detected', fl.keys.indexOf('FAVORITE_FLIP') >= 0);
eq('LARGE_DISAGREEMENT, spread lean and a flip are one independent flag', fl.independent, 1);
eq('a total lean is a second', P.flagsFor(cand({ flags: ['LARGE_DISAGREEMENT', 'TOTAL_LEAN'] })).independent, 2);
eq('market movement a third',
  P.flagsFor(cand({ flags: ['LARGE_DISAGREEMENT', 'TOTAL_LEAN', 'MARKET_TOWARD_MODEL'], movement: { h2h_pp: 2 } })).independent, 3);
eq('qualifiers are not research flags', P.flagsFor(cand({ flags: ['HIGH_UNCERTAINTY', 'STALE_MARKET', 'NO_MARKET'], model_margin: 3, market_margin: 2 })).independent, 0);
eq('an unknown flag key is not counted', P.flagsFor(cand({ flags: ['MADE_UP'], model_margin: 3, market_margin: 2 })).independent, 0);
/* the flip needs a real disagreement and two real favourites */
chk('a half-point either side of pick\'em is not a flip', !P.favoriteFlip(cand({ model_margin: -0.5, market_margin: 0.5 })));
chk('a pick\'em market has no favourite to flip', !P.favoriteFlip(cand({ model_margin: -4, market_margin: 0 })));
chk('the same favourite is not a flip', !P.favoriteFlip(cand({ model_margin: 9, market_margin: 3 })));
/* market quality and data completeness move the score */
chk('a captured quote scores above a consensus line',
  P.score(cand()).score > P.score(cand({ market: { kind: 'consensus', age_h: null, stale: false } })).score);
chk('better completeness scores higher', P.score(cand({ completeness: 0.95 })).score > P.score(cand({ completeness: 0.6 })).score);
/* a component the league does not publish is left out, not filled in */
const nfl = P.score(cand({ sport: 'nfl', completeness: null }));
same('NFL completeness is left out of the average', nfl.omitted, ['data']);
eq('and never appears as a number', nfl.parts.data, null);
chk('the score stays on the 0-100 scale', nfl.score >= -100 && nfl.score <= 100 && nfl.base <= 100);
/* movement is interest, never a penalty */
eq('no measured movement contributes nothing', P.score(cand()).parts.movement, 0);
chk('measured movement adds interest', P.score(cand({ movement: { spread_moved: 1.5 } })).score > P.score(cand()).score);
/* missing inputs cost points */
same('a missing market total is counted', P.score(cand({ market_total: null })).missing, ['market_total']);
eq('and charged', P.score(cand({ market_total: null, model_total: null })).penalties.missing_data, 2 * P.PENALTY.missing_input);
/* pure */
const frozen = cand({ qualifiers: ['HIGH_UNCERTAINTY'] }), before = JSON.stringify(frozen);
P.rank([frozen]); P.score(frozen); P.eligibility(frozen);
eq('no candidate is mutated', JSON.stringify(frozen), before);

/* ======================================================================== */
/* 4. DETERMINISTIC ORDER                                                   */
/* ======================================================================== */
const pool = [
  game('cfb|a', 3.1, 0.21), game('cfb|b', 4.4, 0.3), game('nfl|c', 2.2, 0.2, { sport: 'nfl', status: 'INVESTIGATE', completeness: null }),
  game('cfb|d', 6.0, 0.41, { flags: ['LARGE_DISAGREEMENT', 'TOTAL_LEAN'] }), game('cfb|e', 5.2, 0.36, { market: { kind: 'consensus', age_h: null, stale: false } }),
  game('nfl|f', 8.0, 0.75, { sport: 'nfl', status: 'INVESTIGATE', completeness: null }), game('cfb|g', 2.5, 0.17, { movement: { spread_moved: 2 } }),
  game('cfb|h', 3.0, 0.2), game('cfb|i', 3.0, 0.2) /* identical to h: the key decides */
];
const base = P.rank(pool, 9).items.map(x => x.key);
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
let stable = true;
for (let t = 0; t < 60; t++) {
  const sh = pool.slice();
  for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = sh[i]; sh[i] = sh[j]; sh[j] = x; }
  if (JSON.stringify(P.rank(sh, 9).items.map(x => x.key)) !== JSON.stringify(base)) { stable = false; break; }
}
chk('60 shuffles of the same board give the same order', stable, base);
chk('identical games are ordered by their key', base.indexOf('cfb|h') < base.indexOf('cfb|i'), base);
chk('scores are non-increasing down the list', P.rank(pool, 9).items.every((x, i, a) => i === 0 || a[i - 1].score >= x.score));

/* the tie-break chain, one level at a time, on equal scores */
function row(key, o) {
  o = o || {};
  return { key, score: o.score == null ? 50 : o.score, detail: { flags: { independent: o.flags == null ? 1 : o.flags } },
    candidate: { key, normalized_gap: o.z == null ? 0.3 : o.z, completeness: o.comp === undefined ? 0.8 : o.comp,
      market: { age_h: o.age === undefined ? 2 : o.age }, kickoff: o.t == null ? 1000 : o.t } };
}
function order(rows) { return rows.slice().sort(P.compare).map(r => r.key); }
same('higher score first', order([row('x', { score: 40 }), row('y', { score: 60 })]), ['y', 'x']);
same('tie 1: more independent flags', order([row('x', { flags: 1 }), row('y', { flags: 2 })]), ['y', 'x']);
same('tie 2: larger normalized gap', order([row('x', { z: 0.3 }), row('y', { z: 0.4 })]), ['y', 'x']);
same('tie 3: better data completeness', order([row('x', { comp: 0.7 }), row('y', { comp: 0.9 })]), ['y', 'x']);
same('tie 3: unknown completeness reads after known', order([row('x', { comp: null }), row('y', { comp: 0.5 })]), ['y', 'x']);
same('tie 4: fresher market quote', order([row('x', { age: 5 }), row('y', { age: 1 })]), ['y', 'x']);
same('tie 4: an unknown quote age reads after a known one', order([row('x', { age: null }), row('y', { age: 5 })]), ['y', 'x']);
same('tie 5: earlier kickoff', order([row('x', { t: 2000 }), row('y', { t: 1000 })]), ['y', 'x']);
same('last: the key', order([row('y'), row('x')]), ['x', 'y']);
same('flags outrank normalized gap', order([row('x', { flags: 1, z: 0.9 }), row('y', { flags: 2, z: 0.2 })]), ['y', 'x']);

/* ======================================================================== */
/* 5. HOW MANY                                                              */
/* ======================================================================== */
const three = [game('k1', 3, 0.2), game('k2', 4, 0.3), game('k3', 5, 0.35),
  game('x1', 3, 0.2, { status: 'DATA FAULT' }), game('x2', 3, 0.2, { market_margin: null }),
  game('x3', 3, 0.2, { qualifiers: ['STALE_MARKET'] }), game('x4', 3, 0.2, { thin: true })];
const r3 = P.rank(three);
eq('fewer than five eligible: that many are returned', r3.items.length, 3);
eq('and the eligible count says so', r3.eligible, 3);
eq('every exclusion is accounted for', r3.excluded.length, 4);
same('each with its reason', r3.excluded.map(e => e.key + ':' + e.reasons.join('+')),
  ['x1:DATA_FAULT', 'x2:NO_MARKET', 'x3:STALE_MARKET', 'x4:THIN_DATA']);
const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(i => game('m' + i, 2 + i * 0.5, 0.15 + i * 0.03));
const r8 = P.rank(eight);
eq('more than five eligible: exactly five are returned', r8.items.length, 5);
eq('out of eight eligible', r8.eligible, 8);
same('ranked 1 to 5', r8.items.map(x => x.rank), [1, 2, 3, 4, 5]);
eq('exactly five eligible: five', P.rank(eight.slice(0, 5)).items.length, 5);
eq('an empty board: none', P.rank([]).items.length, 0);
eq('no board at all: none', P.rank(null).items.length, 0);
eq('a duplicate game is read once', P.rank([game('d1', 3, 0.2), game('d1', 3, 0.2)]).items.length, 1);
eq('the caller may ask for fewer', P.rank(eight, 2).items.length, 2);

/* ======================================================================== */
/* 6. WHY RESEARCH IT                                                       */
/* ======================================================================== */
function why(o, ctx) { return P.why(cand(o), ctx); }
const SAME_FAV = { model_margin: 9.5, market_margin: 7 };   /* Florida by 9.5 vs 7: no flip */

/* 1  favourite flip */
let w = why();
eq('a flip is explained as a flip', w.code, 'favorite_flip');
eq('with both favourites and both numbers',
  w.text, 'Model flips the market favorite: EdgeDesk has Ole Miss by 4.1, the market has Florida by 2.');
eq('the flip outranks market movement',
  why({ movement: { spread_toward_model: 2, spread_moved: 2 } }).code, 'favorite_flip');
eq('and outranks multiple flags', why({ flags: ['LARGE_DISAGREEMENT', 'TOTAL_LEAN'], total_gap: 4 }).code, 'favorite_flip');
eq('an elevated flip is still a flip (the card carries the uncertainty tag)',
  why({ status: 'INVESTIGATE', model_margin: -6, market_margin: 3, qb_unknown: true }).code, 'favorite_flip');
chk('a sub-threshold flip is not called one', why({ model_margin: -0.5, market_margin: 0.5, normalized_gap: 0.07 }).code !== 'favorite_flip');

/* 2  market movement, only where it was measured */
w = why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, flags: ['SPREAD_LEAN', 'MARKET_TOWARD_MODEL'],
  movement: { spread_moved: 1.5, spread_toward_model: 1.5 } }));
eq('spread movement toward the model is explained', w.code, 'market_movement');
eq('with its size and direction', w.text, 'The market has moved 1.5 pts toward EdgeDesk’s number since the open.');
w = why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, movement: { spread_moved: 1, spread_toward_model: -1 } }));
eq('movement away from the model says so', w.text, 'The market has moved 1 pt away from EdgeDesk’s number since the open.');
w = why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, movement: { h2h_pp: -3.4 } }));
eq('a 3+ pp moneyline move is meaningful', w.code, 'market_movement');
eq('and names the side the market moved toward',
  w.text, 'The market has moved 3.4 pp toward Ole Miss on the moneyline since first capture; the model does not see news.');
eq('a key-number crossing is movement', why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, flags: ['SPREAD_LEAN', 'KEY_NUMBER'] })).code, 'market_movement');
chk('a 1.5 pp move is not "meaningful"', why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, movement: { h2h_pp: 1.5 } })).code !== 'market_movement');
chk('a half-point spread drift is not "meaningful"',
  why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, movement: { spread_moved: 0.5, spread_toward_model: 0.5 } })).code !== 'market_movement');
/* no movement data: movement is never mentioned */
const noMove = [cand(SAME_FAV), cand(Object.assign({}, SAME_FAV, { movement: null })), cand(Object.assign({}, SAME_FAV, { movement: {} })),
  cand(Object.assign({}, SAME_FAV, { sport: 'nfl', status: 'INVESTIGATE', completeness: null, movement: { spread_moved: null, spread_toward_model: null, h2h_pp: null } }))];
chk('with no movement on file, no explanation mentions movement',
  noMove.every(c => !/moved|movement|since the open|first capture/.test(P.why(c).text)), noMove.map(c => P.why(c).text));

/* 3  multiple independent flags */
w = why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, flags: ['SPREAD_LEAN', 'TOTAL_LEAN'], total_gap: -4.5 }));
eq('two independent families are explained together', w.code, 'multiple_flags');
eq('in reading order', w.text, 'Multiple independent research flags are active: spread disagreement and total disagreement.');
w = why(Object.assign({}, SAME_FAV, { normalized_gap: 0.17, flags: ['SPREAD_LEAN', 'TOTAL_LEAN'], movement: { h2h_pp: 1.5 } }));
eq('three read as a list', w.text, 'Multiple independent research flags are active: spread disagreement, total disagreement and market movement.');
eq('three names for one spread disagreement are not "multiple"',
  why(Object.assign({}, SAME_FAV, { model_margin: 12, normalized_gap: 0.35, flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'] })).code !== 'multiple_flags', true);

/* 4  large disagreement with good data */
w = why(Object.assign({}, SAME_FAV, { model_margin: 13.7, normalized_gap: 0.45, flags: ['LARGE_DISAGREEMENT', 'SPREAD_LEAN'], completeness: 0.9 }));
eq('a large normalized gap with good data', w.code, 'large_disagreement');
eq('states the gap and the coverage behind it', w.text, 'Model and market disagree by 6.7 points with strong data coverage (90%).');
eq('moderate coverage is stated as a number, not as "strong"',
  why(Object.assign({}, SAME_FAV, { model_margin: 13.7, normalized_gap: 0.45, completeness: 0.74 })).text,
  'Model and market disagree by 6.7 points with 74% data coverage.');
eq('NFL publishes no coverage figure, so none is claimed',
  why(Object.assign({}, SAME_FAV, { sport: 'nfl', status: 'INVESTIGATE', model_margin: 13.7, normalized_gap: 0.45, completeness: null })).text,
  'Model and market disagree by 6.7 points with no data warnings open.');
/* "one of the largest" is only said where it is true */
const field = [6.7, 5.5, 4.0, 3.0, 2.5].map((d, i) => cand({ key: 'f' + i, model_margin: 7 + d, market_margin: 7, normalized_gap: d / 15,
  flags: ['SPREAD_LEAN'] }));
eq('a top-3 gap in a field of 5 is "one of the largest"', P.why(field[1], field).code, 'largest_disagreement');
eq('and says so with its size', P.why(field[0], field).text, 'One of the largest research-grade spread disagreements on the board: 6.7 points.');
chk('a gap outside the top 3 is not', P.why(field[3], field).code !== 'largest_disagreement');
chk('nor is anything in a field of 4', P.why(field[0], field.slice(0, 4)).code !== 'largest_disagreement');
chk('elevated games are not counted in that field',
  P.why(field[0], field.slice(0, 4).concat([cand({ key: 'e', status: 'INVESTIGATE', model_margin: 16, market_margin: 7, normalized_gap: 0.6 })])).code !== 'largest_disagreement');

/* 5  large disagreement with elevated uncertainty */
w = why({ key: 'u', status: 'INVESTIGATE', model_margin: 15, market_margin: 7, normalized_gap: 0.55, flags: ['LARGE_DISAGREEMENT'] });
eq('a large INVESTIGATE gap is explained as uncertain', w.code, 'large_uncertain');
eq('in those words', w.text, 'Large disagreement, but uncertainty is elevated — inspect the inputs.');
eq('an unknown QB is named', why(Object.assign({}, SAME_FAV, { model_margin: 13, normalized_gap: 0.4, qb_unknown: true })).text,
  'Large disagreement, but a starting quarterback is unknown — inspect the inputs.');
eq('high uncertainty is named', why(Object.assign({}, SAME_FAV, { model_margin: 13, normalized_gap: 0.4, qualifiers: ['HIGH_UNCERTAINTY'] })).text,
  'Large disagreement, but its input data is incomplete or out of date — inspect the inputs.');
chk('an elevated game is never described as having good data',
  !/coverage|no data warnings/.test(why(Object.assign({}, SAME_FAV, { model_margin: 13, normalized_gap: 0.4, qb_unknown: true })).text));

/* 6  the flag it carries */
eq('a closer model is described as closer', why({ model_margin: 14, market_margin: 17.5, normalized_gap: 0.2, flags: ['SPREAD_LEAN'] }).text,
  'Model sees this matchup much closer than the market does: EdgeDesk has Florida by 14, the market by 17.5.');
eq('a more lopsided model as more lopsided', why({ model_margin: 10, market_margin: 7.5, normalized_gap: 0.15, flags: ['SPREAD_LEAN'] }).text,
  'Model sees Florida winning by more than the market does: 10 points, not 7.5.');
eq('a model pick\'em is "even"', why({ model_margin: 0, market_margin: 3, normalized_gap: 0.2, flags: ['SPREAD_LEAN'] }).text,
  'Model sees this matchup much closer than the market does: EdgeDesk has it even, the market has Florida by 3.');
eq('a total lean alone names the total', why({ model_margin: 3, market_margin: 2.5, normalized_gap: 0.03, flags: ['TOTAL_LEAN'], total_gap: 3.2 }).text,
  'Model sees the total 3.2 points higher than the market.');
eq('a smaller price move is still stated as measured', why({ model_margin: 3, market_margin: 2.5, normalized_gap: 0.03, flags: [], movement: { h2h_pp: 1.6 } }).text,
  'The market has moved 1.6 pp toward Florida on the moneyline since first capture; the model does not see news.');
eq('a Collective consensus is named', why({ model_margin: 3, market_margin: 2.5, normalized_gap: 0.03, flags: ['MODEL_CONSENSUS'] }).text,
  'Most Collective models lean the same way as EdgeDesk here.');

/* every ranked game carries one, and the same board always says the same thing */
const ranked = P.rank(pool, 9).items;
chk('every ranked game carries a why', ranked.every(x => x.why && x.why.code && x.why.text));
same('explanations are deterministic', P.rank(pool.slice().reverse(), 9).items.map(x => x.why.text), ranked.map(x => x.why.text));
const WHY_CANDS = [cand(), inv, res, huge, solid, nflBand, nflWide].concat(pool, field, noMove);
const ALL_WHY = WHY_CANDS.map(c => P.why(c, WHY_CANDS).text);
chk('every explanation is one sentence', ALL_WHY.every(t => /^[A-Z][^.]*(\.\d[^.]*)*\.$/.test(t) && t.length <= 140), ALL_WHY.filter(t => t.length > 140));
chk('no explanation carries a number the candidate did not', ALL_WHY.every(t => !/NaN|undefined|null|Infinity/.test(t)));

/* ======================================================================== */
/* 7. LANGUAGE                                                              */
/* ======================================================================== */
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'research_priority.js'), 'utf8');
chk('the rule says what the order is not', /not a ranking of bets/.test(P.RULE));
chk('and that the score is not a probability', /not a probability/.test(P.RULE));
const BANNED = [/best bets?/i, /top plays?/i, /\blocks?\b/i, /bet this/i, /edge of the day/i, /\bpicks?\b/i, /\bwager/i, /\bhammer\b/i];
BANNED.forEach(re => chk('no "' + re.source + '" anywhere in the module', !re.test(SRC.replace(/pick’em|pick'em/g, ''))));
BANNED.concat([/\bbet\b/i, /\bedge\b/i, /value/i]).forEach(re =>
  chk('no "' + re.source + '" in any explanation', ALL_WHY.every(t => !re.test(t)), ALL_WHY.filter(t => re.test(t))));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nresearch priority: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
