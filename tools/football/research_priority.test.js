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
/* 6. LANGUAGE                                                              */
/* ======================================================================== */
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'research_priority.js'), 'utf8');
chk('the rule says what the order is not', /not a ranking of bets/.test(P.RULE));
chk('and that the score is not a probability', /not a probability/.test(P.RULE));
[/best bets?/i, /top plays?/i, /\blocks?\b/i, /bet this/i, /edge of the day/i, /\bpicks\b/i].forEach(re =>
  chk('no "' + re.source + '" anywhere in the module', !re.test(SRC)));

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nresearch priority: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
