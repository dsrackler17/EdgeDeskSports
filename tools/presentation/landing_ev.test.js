#!/usr/bin/env node
/* ===========================================================================
   THE METHODOLOGY PAGE'S EDGEDESK EV — one implementation, and it is the
   terminal's.

   The EdgeDesk EV walk-through lives on /methodology/ (the landing page
   shows LIVE numbers now, and links here for the explanation). It prices an
   illustrative game: the game's price check, the price slider and the
   alternate-line ladder. Every one of those numbers must be what
   lib/edgedesk_quote_ev.js (over
   lib/research_core.js) returns for the illustrative inputs in #lpEvData —
   never a figure typed into marketing copy, and never a second copy of the
   odds math. This suite:

     1  reads #lpEvData and checks it is a coherent illustrative distribution;
     2  checks its price rules ARE the pre-registered EV policy;
     3  runs the page's own quote() and stateOf() against the real engine;
     4  recomputes every static figure in the markup and compares;
     5  checks the demo makes the point it exists to make — same line,
        three prices, three answers — and that the ladder labels are the
        terminal's;
     6  checks the illustrative game is one the product's own canon would
        classify the way the page says.

   Run: node tools/presentation/landing_ev.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const IDX = fs.readFileSync(path.join(ROOT, 'methodology', 'index.html'), 'utf8');
const LANDING = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const Canon = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
const POLICY = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_ev', 'policy', 'cfb_ev_policy_v1.json'), 'utf8'));

/* the page writes a typographic minus; the engine an ASCII hyphen */
const M = s => String(s).replace(/-/g, '&minus;');
const ENT = s => String(s).replace(/−/g, '&minus;');
function mod(name) {
  const i = IDX.indexOf('(function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i, started = false;
  for (; j < IDX.length; j++) { const c = IDX[j]; if (c === '{') { d++; started = true; } else if (c === '}') { d--; if (started && d === 0) break; } }
  return IDX.slice(i, j + 1);
}
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i, started = false;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') { d++; started = true; } else if (c === '}') { d--; if (started && d === 0) break; } }
  return src.slice(i, j + 1);
}
function section(id) {
  const a = IDX.indexOf('id="' + id + '"');
  return a < 0 ? '' : IDX.slice(IDX.lastIndexOf('<', a), IDX.indexOf('</section>', a));
}

/* ======================================================================== */
/* 1. THE ILLUSTRATIVE INPUTS                                               */
/* ======================================================================== */
const RAW = (IDX.match(/<script type="application\/json" id="lpEvData">([\s\S]*?)<\/script>/) || [])[1];
let D = null;
chk('the illustrative inputs are on the page as data', () => { D = JSON.parse(RAW); return !!D; });
if (!D) { failures.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
chk('and they say they are illustrative, beside the data', /Nothing here is live/.test(IDX.slice(IDX.indexOf('id="lpEvData"') - 600, IDX.indexOf('id="lpEvData"'))));
const LINES = Object.keys(D.curve).map(Number).sort((a, b) => b - a);   /* -7, -7.5 ... -10 */
chk('every line carries a win and a push probability that form a distribution',
  LINES.every(l => { const o = D.curve[String(l)]; return o.length === 2 && o[0] > 0 && o[1] >= 0 && o[0] + o[1] < 1; }));
chk('a half-point line has no push; a whole number has one',
  LINES.every(l => { const p = D.curve[String(l)][1]; return Number.isInteger(l) ? p > 0 : p === 0; }));
chk('laying more points never makes covering likelier (the curve is coherent)',
  LINES.every((l, i) => i === 0 || D.curve[String(l)][0] <= D.curve[String(LINES[i - 1])][0] + 1e-12));
chk('every number the page prices has a line in the curve', () => {
  const need = [D.hero.line, D.slider.line].concat(D.lineCheck.lines, D.ladder.quotes.map(q => q[0]));
  return need.every(l => D.curve[String(l)]);
});

/* ======================================================================== */
/* 2. THE PRICE RULES ARE THE PRE-REGISTERED POLICY                         */
/* ======================================================================== */
chk('the minimum probability edge is the policy\'s', D.policy.min_probability_edge === POLICY.min_probability_edge, [D.policy.min_probability_edge, POLICY.min_probability_edge]);
chk('the minimum EV is the policy\'s', D.policy.min_calibrated_ev === POLICY.min_calibrated_ev);
chk('the price limit is the policy\'s', D.policy.max_price === POLICY.max_price, [D.policy.max_price, POLICY.max_price]);
chk('the policy the page describes as shadow is in shadow', POLICY.maturity === 'SHADOW' && POLICY.betting_enabled === false);
has(IDX, 'no worse than &minus;' + Math.abs(POLICY.max_price), 'the page states the policy\'s own price limit');

/* ======================================================================== */
/* 3. THE PAGE'S OWN CODE, AGAINST THE REAL ENGINE                          */
/* ======================================================================== */
const EVMOD = mod('evDemo');
let quote = null, stateOf = null;
chk('the page\'s quote() and stateOf() run against EDQuoteEV', () => {
  const f = new Function('D', 'P', 'Q', fnSrc(EVMOD, 'quote') + '\n' + fnSrc(EVMOD, 'stateOf') + '\nreturn {quote:quote,stateOf:stateOf};');
  const api = f(D, D.policy, Q); quote = api.quote; stateOf = api.stateOf;
  return typeof quote === 'function' && typeof stateOf === 'function';
});
if (!quote) { failures.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
/* an independent restatement of the arithmetic, only to prove the page
   passed the engine the right arguments (EDQuoteEV is the implementation) */
function reference(line, price) {
  const o = D.curve[String(line)], w = o[0], p = o[1], l = 1 - w - p;
  const d = price < 0 ? 1 + 100 / -price : 1 + price / 100;
  return { ev: w * (d - 1) - l, be: 1 / d, cover: w / (w + l) };
}
chk('the page prices every quote exactly as the engine does', () => {
  for (let price = D.slider.from; price >= D.slider.to; price--) {
    const r = quote(D.slider.line, price), x = reference(D.slider.line, price);
    if (Math.abs(r.ev - x.ev) > 1e-12 || Math.abs(r.be - x.be) > 1e-12 || Math.abs(r.cover - x.cover) > 1e-12) return false;
  }
  return true;
});
chk('the fair price is where EV crosses zero', () => {
  const o = D.curve[String(D.slider.line)], fair = Q.fairAmerican(o[0], o[1]);
  return quote(D.slider.line, fair + 1).ev > 0 && quote(D.slider.line, fair - 1).ev < 0;
});
chk('a positive EV at a price inside the limit, with a point of edge, is the only QUALIFIES',
  [-100, -110, -120].every(p => stateOf(quote(-8, p)) === 'QUALIFIES') && stateOf(quote(-8, -122)) === 'THIN' && stateOf(quote(-8, -130)) === 'PASS');
chk('a price past the limit never qualifies, whatever its EV', stateOf({ ev: 0.05, edge: 0.05, price: POLICY.max_price - 5 }) === 'OVER PRICE LIMIT');
chk('zero EV is a PASS, not a qualifier', stateOf({ ev: 0, edge: 0.02, price: -110 }) === 'PASS');

/* ======================================================================== */
/* 4. EVERY STATIC FIGURE IS THE ENGINE'S                                   */
/* ======================================================================== */
const H = quote(D.hero.line, D.hero.price);
const pct = x => Q.pct(x, 1), sev = x => ENT(Q.signedPct(x, 1)), price = a => M(Q.priceText(a));
/* the landing page no longer carries an illustrative EV: its numbers are live */
chk('the landing page carries no illustrative EV figure of its own', LANDING.indexOf('id="lpEvData"') < 0 && LANDING.indexOf('id="evSlider"') < 0);
chk('and links to this walk-through', /href="\/methodology\/#ev"/.test(LANDING));
/* the price slider's first state */
const start = quote(D.slider.line, D.slider.start), st0 = stateOf(start);
chk('the slider starts on the hero\'s price', D.slider.start === D.hero.price);
chk('the slider range in the markup is the data\'s', new RegExp('id="evSlider" min="0" max="' + (D.slider.from - D.slider.to) + '" step="1" value="' + (D.slider.from - D.slider.start) + '"').test(IDX));
has(IDX, 'id="evPrice" for="evSlider">' + price(D.slider.start) + '<', 'slider: the starting price');
has(IDX, 'id="evProb">' + pct(start.cover) + '<', 'slider: EdgeDesk probability');
has(IDX, 'id="evBe">' + pct(start.be) + '<', 'slider: break-even');
has(IDX, 'id="evEdge">' + ENT(Q.ppText(start.edge, 1)) + '<', 'slider: probability edge');
has(IDX, 'id="evEv">' + sev(start.ev) + '<', 'slider: EdgeDesk EV');
has(IDX, 'id="evFair">' + price(start.fair) + '<', 'slider: fair odds');
has(IDX, 'id="evStateV">' + st0 + '<', 'slider: the starting verdict is ' + st0);
has(IDX, 'clears the break-even by ' + Math.abs(start.edge * 100).toFixed(1) + ' points', 'and its sentence carries the same edge');
has(IDX, 'style="left:' + (100 * (D.slider.from - start.fair) / (D.slider.from - D.slider.to)) + '%"><span>FAIR ' + price(start.fair) + '<', 'the fair marker sits at the fair price');
/* the game's price check */
D.lineCheck.lines.forEach(l => {
  const r = quote(l, D.lineCheck.price), s = stateOf(r);
  chk('price check at ' + l + ' reads ' + Q.signedPct(r.ev, 1) + ' ' + s,
    new RegExp('data-line="' + l + '"[^>]*><span class="line">' + M(l) + '</span><span class="v [a-z]+">' + sev(r.ev).replace(/\+/g, '\\+') + '</span><span class="st [a-z]+">' + s + '</span>').test(IDX));
});
has(IDX, 'at a reference price of ' + price(D.lineCheck.price), 'the price check names its reference price');
/* the ladder */
const rows = D.ladder.quotes.map(q => quote(q[0], q[1]));
const max = rows.reduce((a, r) => (!a || r.ev > a.ev ? r : a), null);
const safe = rows.filter(r => r.ev > 0 && r.price >= POLICY.max_price).reduce((a, r) => (!a || r.cover > a.cover ? r : a), null);
const BODY = (IDX.match(/<table class="ladder" id="evLadder">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
const TR = BODY.match(/<tr[\s\S]*?<\/tr>/g) || [];
chk('the ladder shows every quote in the data', TR.length === rows.length, TR.length);
rows.forEach((r, i) => {
  const t = TR[i] || '';
  chk('ladder ' + r.line + ' ' + r.price + ': ' + pct(r.cover) + ' / ' + Q.signedPct(r.ev, 1),
    t.indexOf('<td>' + M(r.line) + '</td><td>' + price(r.price) + '</td>') >= 0 && t.indexOf('<td class="xs">' + pct(r.cover) + '</td>') >= 0
    && t.indexOf('<td class="ev ' + (r.ev >= 0 ? 'pos' : 'neg') + '">' + sev(r.ev) + '</td>') >= 0, t);
  chk('ladder ' + r.line + ' carries exactly the labels the rule gives it',
    (/SAFEST \+EV/.test(t) === (r === safe)) && (/MAX EV/.test(t) === (r === max)) && (/MAIN LINE/.test(t) === (r.line === D.ladder.main)), t);
});

/* ======================================================================== */
/* 5. THE DEMO MAKES ITS POINT, IN THE TERMINAL'S WORDS                     */
/* ======================================================================== */
const picks = D.slider.picks.map(p => stateOf(quote(D.slider.line, p)));
chk('same line, three prices, three different answers', new Set(picks).size === 3, picks.join(','));
chk('and the three buttons are those prices', D.slider.picks.every(p => new RegExp('data-price="' + p + '" aria-pressed="false">' + M(p) + '<').test(IDX)));
chk('the slider crosses the fair price, so it reaches a PASS', stateOf(quote(D.slider.line, D.slider.to)) === 'PASS');
chk('the price check crosses from QUALIFIES to PASS as the line moves', () => {
  const s = D.lineCheck.lines.map(l => stateOf(quote(l, D.lineCheck.price)));
  return s[0] === 'QUALIFIES' && s[s.length - 1] === 'PASS';
});
chk('the best EV on the ladder is not the main line — the point of showing it', max.line !== D.ladder.main);
chk('the ladder labels are the terminal\'s own (EDQuoteEV.TOOLTIP)', !!Q.TOOLTIP.max_ev && !!Q.TOOLTIP.safest && !!Q.TOOLTIP.main_line);
chk('MAX EV is described the way the terminal describes it: not a recommendation',
  /Not a recommendation/.test(Q.TOOLTIP.max_ev) && /MAX EV is not a recommendation/.test(IDX));
chk('the FAQ\'s juice example agrees with the engine: -105 has value, -130 does not',
  quote(-8, -105).ev > 0 && quote(-8, -130).ev < 0 && /Auburn &minus;8 at &minus;105 and Auburn &minus;8 at &minus;130/.test(IDX));
chk('the positive EVs stay modest — the demo does not oversell', rows.concat([H]).every(r => r.ev < 0.12), rows.map(r => r.ev.toFixed(3)).join(','));

/* ======================================================================== */
/* 6. THE ILLUSTRATIVE GAME OBEYS THE PRODUCT'S OWN RULES                   */
/* ======================================================================== */
const GAME = section('game');
const HERO_MODEL = +((GAME.match(/EdgeDesk<\/span><span class="v mdl">Auburn &minus;([\d.]+)/) || [])[1]);
const HERO_MKT = +((GAME.match(/Market<\/span><span class="v">Auburn &minus;([\d.]+)/) || [])[1]);
chk('the market line in the game is the line EdgeDesk EV prices', HERO_MKT === -D.hero.line);
/* the illustrative card shows ONE data-quality figure (72%); the one research
   classifier needs both football confidence and a MEASURED reliability (audit
   2026-09-30 #6: unmeasured reliability is not a pass), so the card's figure
   stands for both here */
chk('a gap of this size is WORTH RESEARCHING in lib/edgedesk_canon.js',
  Canon.researchStatus({ projected: true, market: 'FRESH', gap: HERO_MODEL - HERO_MKT, confidence: 72, reliability: 72, fair_margin: HERO_MODEL }).key === 'WORTH_RESEARCHING');
chk('…and with its reliability unmeasured the same card would read LIMITED DATA, never WORTH RESEARCHING (the gate is not loosened for a demo)',
  Canon.researchStatus({ projected: true, market: 'FRESH', gap: HERO_MODEL - HERO_MKT, confidence: 72, fair_margin: HERO_MODEL }).key === 'LIMITED_DATA');
chk('and the gap clears the canonical research threshold', HERO_MODEL - HERO_MKT >= Canon.THRESHOLDS.research_gap);
chk('the model is further onto Auburn than the market, so EdgeDesk\'s cover at the market line is above a coin flip',
  HERO_MODEL > HERO_MKT && H.cover > 0.5);
has(GAME, 'Auburn &minus;' + HERO_MODEL, 'the game section states the model line');
has(GAME, (HERO_MODEL - HERO_MKT).toFixed(1) + ' pts', 'and its gap');
has(GAME, '= Auburn by ' + HERO_MODEL, 'and the drivers add up to it');
chk('the drivers sum to the fair line', () => {
  const pts = [...GAME.matchAll(/<span class="p">\+([\d.]+)<\/span>/g)].map(m => +m[1]);
  return pts.length === 3 && Math.abs(pts.reduce((a, b) => a + b, 0) - HERO_MODEL) < 1e-9;
});

console.log('');
failures.forEach(f => console.log('  FAIL  ' + f));
console.log('\nlanding EdgeDesk EV: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
