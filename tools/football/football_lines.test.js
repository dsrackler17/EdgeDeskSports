#!/usr/bin/env node
/* ===========================================================================
   FOOTBALL DISPLAY LINES — lib/edgedesk_football_lines.js.
   docs/system-integrity/FOOTBALL_LINES.md

   Half-point fair spreads and totals, PK, whole-number projected scores, the
   raw-number gap with its rounding note, and the key-number context, on the
   cases a live slate may not hold today: quarter-point ties in both signs,
   missing numbers, favourite flips, and lines exactly on 3 and 7.

   Run: node tools/football/football_lines.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'lib', 'edgedesk_football_lines.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}
function section(t) { console.log('\n== ' + t); }
const M = F.MINUS;
const N = (home, away) => ({ home, away });

/* ======================================================================= */
section('1. half points, symmetric in sign');
{
  const cases = [[20.72, 20.5], [-20.72, -20.5], [2.5, 2.5], [-2.5, -2.5], [11.98, 12], [-11.98, -12], [20.25, 20.5], [-20.25, -20.5],
    [20.75, 21], [-20.75, -21], [20.24, 20], [-20.24, -20], [20.76, 21], [6.6, 6.5], [6.74, 6.5], [6.75, 7], [2.74, 2.5], [9.7, 9.5], [13.7, 13.5],
    [0, 0], [0.24, 0], [-0.24, 0], [0.25, 0.5], [-0.25, -0.5], [20.2450001, 20.5], [20.2449, 20]];
  const off = cases.filter(([x, want]) => F.halfPoint(x) !== want).map(([x, want]) => ({ x, want, got: F.halfPoint(x) }));
  chk('nearest half point, quarter-point ties away from zero (' + cases.length + ' cases)', !off.length, off);
  let asym = 0;
  for (let i = -6000; i <= 6000; i++) { const x = i / 100; if (F.halfPoint(-x) !== (F.halfPoint(x) === 0 ? 0 : -F.halfPoint(x))) asym++; }
  chk('a margin and its negation always display as the same line (every hundredth in ±60)', asym === 0, asym);
  chk('no negative zero', Object.is(F.halfPoint(-0.1), 0) && Object.is(F.halfPoint(-0), 0));
  let far = 0;
  for (let i = -6000; i <= 6000; i++) { const x = i / 100; if (Math.abs(F.halfPoint(x) - x) > 0.25 + 1e-9) far++; }
  chk('the display is never more than a quarter point from the projection', far === 0, far);
  chk('nothing is pulled to a key number: 6.6 → 6.5, 2.6 → 2.5, 13.6 → 13.5, 9.6 → 9.5', F.halfPoint(6.6) === 6.5 && F.halfPoint(2.6) === 2.5 && F.halfPoint(13.6) === 13.5 && F.halfPoint(9.6) === 9.5);
}

section('2. fair spreads as football lines');
{
  chk('Texas Tech −20.7 → −20.5', F.spread(20.72, N('Texas Tech', 'Arizona State')).text === 'Texas Tech ' + M + '20.5', F.spread(20.72, N('Texas Tech', 'Arizona State')));
  chk('Indiana −2.5 remains −2.5', F.spread(2.5, N('Indiana', 'Ohio State')).text === 'Indiana ' + M + '2.5');
  chk('Bowling Green −12.0 remains −12.0', F.spread(11.98, N('Bowling Green', 'Ball State')).text === 'Bowling Green ' + M + '12.0');
  const away = F.spread(-20.72, N('Arizona State', 'Texas Tech'));
  chk('an away favourite is named with the same line', away.text === 'Texas Tech ' + M + '20.5' && away.favorite === 'away' && away.home_line === 20.5, away);
  const pk = F.spread(0.2, N('Florida', 'Ole Miss'));
  chk('a zero display is PK, with the raw lean in its note', pk.text === 'PK' && pk.pk === true && pk.favorite === null && pk.home_line === 0 && /leans Florida by 0\.20/.test(pk.note), pk);
  chk('an exact zero is PK with no lean note', F.spread(0, N('A', 'B')).text === 'PK' && F.spread(0, N('A', 'B')).note === null);
  const q = F.spread(-0.25, N('A', 'B'));
  chk('a quarter-point projection off a pick’em is a half-point favourite, not PK', q.text === 'B ' + M + '0.5', q);
  const s = F.spread(20.72, N('Texas Tech', 'Arizona State'));
  chk('raw and display stay separate on the object', s.raw_home_margin === 20.72 && s.display_home_margin === 20.5 && s.raw_text === 'Texas Tech ' + M + '20.7' && s.rounded === true, s);
  chk('lineFor states the display for either side', F.lineFor(s, 'home') === -20.5 && F.lineFor(s, 'away') === 20.5);
  chk('ascii() is available for exports that need a hyphen', F.ascii(s.text) === 'Texas Tech -20.5');
}

section('3. totals');
{
  chk('52.4 → 52.5', F.total(52.4).text === '52.5');
  chk('49.9 → 50.0', F.total(49.9).text === '50.0');
  chk('48 → 48.0, 52.25 → 52.5, 52.75 → 53.0, 52.74 → 52.5', F.total(48).text === '48.0' && F.total(52.25).text === '52.5' && F.total(52.75).text === '53.0' && F.total(52.74).text === '52.5');
  const t = F.total(52.4);
  chk('the raw total stays beside the display', t.raw === 52.4 && t.display === 52.5 && t.raw_text === '52.4' && t.rounded === true, t);
}

section('4. missing data');
{
  [null, undefined, '', 'abc', NaN, Infinity].forEach((v) => {
    const s = F.spread(v, N('A', 'B')), t = F.total(v);
    chk('spread and total of ' + String(v) + ' are unavailable, never zero', s.available === false && s.text === '—' && s.home_line === null && t.available === false && t.text === '—', { s, t });
  });
  chk('a score with no margin or total is unavailable', F.projectedScore({ home: 'A', away: 'B', home_margin: 3 }).available === false);
  chk('a comparison with no market line is unavailable and claims nothing', F.compareSpread(3, null, N('A', 'B')).available === false && F.compareSpread(3, null, N('A', 'B')).gap === null);
  chk('… and with no projection', F.compareSpread(null, -3, N('A', 'B')).available === false);
  chk('no key context without both numbers', F.keyContext(null, -3, N('A', 'B')) === null && F.keyContext(3, null, N('A', 'B')) === null);
  chk('a total comparison with no market total is unavailable', F.compareTotal(50, null).available === false && F.compareTotal(null, 50).available === false);
}

section('5. projected scores');
{
  const tt = F.projectedScore({ home: 'Texas Tech', away: 'Arizona State', home_margin: 20.72, total: 52.4 });
  chk('whole numbers, labelled "Projected score"', tt.label === 'Projected score' && tt.home === 37 && tt.away === 16 && tt.text === 'Texas Tech 37, Arizona State 16', tt);
  chk('the decimal expected points are kept for the details view', tt.expected.home === 36.56 && tt.expected.away === 15.84 && tt.expected_text === 'Texas Tech 36.56, Arizona State 15.84', tt.expected);
  chk('a score that does not reproduce the half-point lines says so', tt.score_margin === 21 && tt.score_total === 53 && tt.note === F.SCORE_NOTE, tt);
  const ok = F.projectedScore({ home: 'Bowling Green', away: 'Ball State', home_margin: 11.98, total: 48 });
  chk('a score that reproduces them carries no note', ok.text === 'Bowling Green 30, Ball State 18' && ok.note === null, ok);
  const tie = F.projectedScore({ home: 'A', away: 'B', home_margin: 0.6, total: 48 });
  chk('a near pick’em may round to a tie; the note names the raw leader', tie.home === 24 && tie.away === 24 && /A leads by 0\.60/.test(tie.note), tie);
  const eng = F.projectedScore({ home: 'A', away: 'B', home_points: 27.4, away_points: 20.6 });
  chk('the engine’s own expected points are used when given', eng.home === 27 && eng.away === 21 && eng.expected.home === 27.4, eng);
  let rev = 0;
  for (let m = -300; m <= 300; m += 3) for (let t = 300; t <= 800; t += 11) {
    const s = F.projectedScore({ home: 'A', away: 'B', home_margin: m / 10 + 0.013, total: t / 10 - 0.021 });
    if ((s.home - s.away) * (m / 10 + 0.013) < 0) rev++;
  }
  chk('rounding never names the other winner (' + 101 * 46 + ' cases)', rev === 0, rev);
}

section('6. the gap uses the unrounded projection');
{
  const c = F.compareSpread(20.72, -17.5, N('Texas Tech', 'Arizona State'));
  chk('Texas Tech fair −20.5 vs market −17.5: the gap is 3.2 from the raw −20.72, not 3.0', c.gap === 3.2 && c.displayed_difference === 3 && c.toward === 'home', c);
  chk('…and it is exactly the gap EDCalc gives the research and decision layers', c.gap === C.spreadComparison({ model_home_margin: 20.72, market_home_margin: 17.5 }).gap);
  chk('… and the reader is told why the printed lines differ by 3.0', c.rounding_note === F.ROUNDING_NOTE);
  const eq = F.compareSpread(2.5, -2.5, N('Indiana', 'Ohio State'));
  chk('a fair line that needs no rounding carries no note', eq.gap === 0 && eq.rounding_note === null && /agree/.test(eq.text), eq);
  let off = 0, notes = 0, n = 0;
  for (let i = -2500; i <= 2500; i += 7) {
    const m = i / 100 + 0.004;
    [-14, -10.5, -7, -6.5, -3.5, -3, -2.5, 0, 1.5, 3, 3.5, 7, 7.5, -6.75, 2.25].forEach((k) => {
      const x = F.compareSpread(m, k, N('A', 'B')); n++;
      const cc = C.spreadComparison({ model_home_margin: m, market_home_margin: k === 0 ? 0 : -k });
      if (x.gap !== cc.gap || x.signed !== cc.signed || x.toward !== cc.toward) off++;
      if (Math.abs(x.gap - Math.abs(m + k)) > 0.1 + 1e-9) off++;
      /* a quarter point of display rounding, half a hundredth from reading
         the raw number at its published precision, and half a tenth each for
         the model and a quarter-point market in the tenths the gap is computed in */
      if (Math.abs(x.gap - x.displayed_difference) > 0.25 + 0.005 + 0.05 + 0.05 + 1e-9) off++;
      if ((x.rounding_note !== null) !== (Math.abs(x.gap - x.displayed_difference) > 1e-9)) off++;
      if (x.rounding_note) notes++;
    });
  }
  chk('every gap is the raw projection against the market, identical to EDCalc’s (' + n + ' cases); the note appears exactly when the printed lines differ from it', off === 0 && notes > 0, { off, notes });
  let toff = 0;
  for (let i = 300; i <= 800; i += 3) [41.5, 44, 47.5, 51, 55.5, 47.25].forEach((k) => { const t = i / 10 + 0.013, x = F.compareTotal(t, k), cc = C.totalComparison({ model_total: t, market_total: k }); if (x.gap !== cc.gap || x.signed !== cc.signed) toff++; });
  chk('every total gap is identical to EDCalc’s', toff === 0, toff);
  const tot = F.compareTotal(52.4, 52.5);
  chk('fair total 52.5 vs market 52.5: the raw total is 0.1 lower, and the note explains the matching lines', tot.gap === 0.1 && tot.direction === 'lower' && tot.rounding_note === F.ROUNDING_NOTE && tot.displayed_difference === 0, tot);
  const tot2 = F.compareTotal(49.9, 47.5);
  chk('49.9 vs 47.5: 2.4 higher; the printed 50.0 vs 47.5 needs the note', tot2.gap === 2.4 && tot2.direction === 'higher' && tot2.rounding_note === F.ROUNDING_NOTE, tot2);
  /* an edge is never made by rounding: the rounded line is further from the
     market than the raw one in some cases, and the gap must not follow it */
  let inflated = 0;
  for (let i = -2000; i <= 2000; i++) {
    const m = i / 100, x = F.compareSpread(m, -7, N('A', 'B'));
    if (x.gap > F.round(Math.abs(m - 7), 1) + 1e-9 || x.gap > Math.abs(m - 7) + 0.05 + 1e-9) inflated++;
  }
  chk('rounding never inflates a gap (every hundredth in ±20 against −7)', inflated === 0, inflated);
}

section('7. sportsbook lines are printed as received');
{
  chk('−6.75 stays −6.75; −7 is −7.0; +3.5 is +3.5; 0 is PK', F.exactLineText(-6.75) === M + '6.75' && F.exactLineText(-7) === M + '7.0' && F.exactLineText(3.5) === '+3.5' && F.exactLineText(0) === 'PK');
  const mk = F.marketSpread(-6.75, N('A', 'B'));
  chk('the market side keeps its own number and favourite', mk.home_line === -6.75 && mk.text === 'A ' + M + '6.75' && mk.favorite === 'home', mk);
  chk('a market total keeps its decimals', F.exactTotalText(47.25) === '47.25' && F.exactTotalText(47) === '47.0');
}

section('8. key numbers');
{
  const ex1 = F.keyContext(2.5, 3.5, N('Indiana', 'Ohio State'));
  chk('market Indiana +3.5, model Indiana −2.5', ex1 && ex1.text === 'Model favors Indiana outright; market gives Indiana more than a field goal.' && ex1.kind === 'flip' && ex1.team === 'Indiana', ex1);
  const ex2 = F.keyContext(8.0, -6.5, N('Fav', 'Dog'));
  chk('a favourite at −6.5 with a fair −8.0', ex2 && ex2.text === 'Market is below 7; model is above 7.' && ex2.kind === 'cross' && ex2.crossed.join() === '7', ex2);
  const on = F.keyContext(8.5, -7, N('Fav', 'Dog'));
  chk('the market exactly on 7 is "sits on", not a crossing', on && on.text === 'Market sits on 7; model is above 7.' && on.kind === 'on' && on.on[0].by === 'market', on);
  const onM = F.keyContext(7.1, -6.5, N('Fav', 'Dog'));
  chk('the model’s displayed −7.0 sits on 7', onM && onM.text === 'Market is below 7; model sits on 7.' && onM.kind === 'on', onM);
  chk('both on the same key: no note', F.keyContext(7.1, -7, N('Fav', 'Dog')) === null);
  chk('both on the same side of every key: no note', F.keyContext(6.0, -6.5, N('Fav', 'Dog')) === null && F.keyContext(9.5, -8, N('Fav', 'Dog')) === null && F.keyContext(1.5, -2.5, N('Fav', 'Dog')) === null);
  chk('two keys between them: the outer ones are named', F.keyContext(7.5, -2.5, N('Fav', 'Dog')).text === 'Market is below 3; model is above 7.');
  chk('market above, model below', F.keyContext(2.6, -7.5, N('Fav', 'Dog')).text === 'Market is above 7; model is below 3.');
  chk('both on different keys', F.keyContext(7, -3, N('Fav', 'Dog')).text === 'Market sits on 3; model sits on 7.');
  chk('a pick’em market', F.keyContext(3.5, 0, N('Fav', 'Dog')).text === 'Market is a pick’em; model is above 3.');
  chk('a model PK against a market favourite', F.keyContext(0.1, -3.5, N('Fav', 'Dog')).text === 'Market is above 3; model is a pick’em.');
  /* team perspective and signs: an away favourite */
  const aw = F.keyContext(-8.0, 6.5, N('Home', 'Road'));
  chk('an away favourite is spoken for the away team, with its own signs', aw && aw.team === 'Road' && aw.text === 'Market is below 7; model is above 7.' && aw.detail === 'Road: market ' + M + '6.5, model fair ' + M + '8.0.', aw);
  const fl2 = F.keyContext(-3.5, -1.5, N('Home', 'Road'));
  chk('a flip spoken for the model’s favourite (the away team)', fl2 && fl2.team === 'Road' && fl2.text === 'Model favors Road by more than a field goal; market makes Road an underdog.' && fl2.detail === 'Road: model fair ' + M + '3.5, market +1.5.', fl2);
  chk('a flip with the market dog exactly a field goal', F.keyContext(2.5, 3, N('Indiana', 'Ohio State')).text === 'Model favors Indiana outright; market gives Indiana exactly a field goal.');
  chk('a flip with the model on a touchdown', F.keyContext(7.0, 1.5, N('Indiana', 'Ohio State')).text === 'Model favors Indiana by a touchdown; market makes Indiana an underdog.');
  chk('a flip with no key between them is not a key-number note', F.keyContext(1.5, 2.5, N('A', 'B')) === null);
  chk('a quarter-point market line is read as received (−6.75 is below 7)', F.keyContext(7.5, -6.75, N('A', 'B')).text === 'Market is below 7; model is above 7.');
  chk('the model’s side is read from its displayed line (6.8 shows −7.0: on 7)', F.keyContext(6.8, -6.5, N('A', 'B')).text === 'Market is below 7; model sits on 7.');
  chk('the note never adjusts a probability and says the leagues differ', ex2.adjusts_probability === false && /differs between the NFL and college football/.test(ex2.note));
  /* symmetry: swap home and away, negate both numbers: the same sentence */
  let asym = 0;
  for (let i = -150; i <= 150; i++) for (const k of [-10.5, -7.5, -7, -6.5, -3.5, -3, -2.5, 0, 2.5, 3, 3.5, 6.5, 7, 7.5]) {
    const a = F.keyContext(i / 10, k, N('X', 'Y')), b = F.keyContext(-i / 10, -k, N('Y', 'X'));
    if (JSON.stringify(a && [a.text, a.team, a.detail]) !== JSON.stringify(b && [b.text, b.team, b.detail])) asym++;
  }
  chk('swapping home and away gives the same sentence for the same team', asym === 0, asym);
}

section('9. configurable margins');
{
  chk('3 and 7 are the primary margins for both leagues', F.keyMargins('nfl').join() === '3,7' && F.keyMargins('cfb').join() === '3,7');
  chk('a call can add margins', F.keyMargins('nfl', { additional: [10, 14] }).join() === '3,7,10,14');
  chk('10 is not a key until configured', F.keyContext(11, -9.5, N('A', 'B')) === null && F.keyContext(11, -9.5, N('A', 'B'), { additional: [10] }).text === 'Market is below 10; model is above 10.');
  const keep = F.KEY_MARGINS.additional.nfl;
  F.KEY_MARGINS.additional.nfl = [10, 14];
  chk('a league can be configured on its own', F.keyMargins('nfl').join() === '3,7,10,14' && F.keyMargins('cfb').join() === '3,7');
  chk('… and its key names fall back to points', F.keyContext(11, 9.5, N('A', 'B'), { league: 'nfl' }).text === 'Model favors A by more than 10 points; market gives A more than 7 points'.replace('7 points', 'a touchdown') + '.');
  F.KEY_MARGINS.additional.nfl = keep;
}

section('10. one bundle, deterministic');
{
  const x = { home: 'Texas Tech', away: 'Arizona State', home_margin: 20.72, total: 52.4, market_home_line: -17.5, market_total: 51.5, league: 'cfb' };
  const a = F.display(x), b = F.display(JSON.parse(JSON.stringify(x)));
  chk('the same projection gives the same display', JSON.stringify(a) === JSON.stringify(b));
  chk('the bundle carries raw beside display, and the market comparison', a.spread.text === 'Texas Tech ' + M + '20.5' && a.total.text === '52.5' && a.score.text === 'Texas Tech 37, Arizona State 16'
    && a.market_spread.gap === 3.2 && a.market_total.gap === 0.9 && a.policy === 'football_half_point_v1' && /unrounded, the projection is Texas Tech by 20\.72 with a total of 52\.40\./.test(a.rounding_note), a);
  chk('the input is not modified', x.home_margin === 20.72 && x.total === 52.4 && Object.keys(x).length === 7);
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | football display lines | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
