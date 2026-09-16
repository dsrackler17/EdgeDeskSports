#!/usr/bin/env node
/* ===========================================================================
   THE STRUCTURED ANSWER, AS THE PANEL RENDERS IT.

   The chat panel's structured-answer renderers are sliced out of the real
   app.html and run in a VM with the same helpers the page gives them. Every
   assertion is about the HTML a subscriber would see: the label chip, the
   model-versus-market cells with both timestamps and freshness badges, the
   price discipline line, the confidence split, the sources table, the
   critic's findings, the feedback controls — and that a five-section answer
   from the function is promoted the same way a four-section one was.

   Run: node tools/intelligence/structured_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function has(name, hay, needle) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(name, hay, needle) { chk(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + JSON.stringify(f.detail).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- slice the real code out of the page ---------------------------------- */
const a = APP.indexOf('  var DESK_SECTIONS = [');
const b = APP.indexOf('  /* WHICH READ THE PANEL LEADS WITH.');
chk('the structured renderers are in app.html', a > 0 && b > a, { a, b });
const src = APP.slice(a, b);
has('the fifth Desk heading is registered', src, "key:'sides'");
has('a label chip renderer exists', src, 'function structuredLabelHTML');
has('a panels renderer exists', src, 'function structuredPanelsHTML');
has('freshness badges exist', src, 'function freshBadge');
has('the feedback recorder exists', src, 'function recordFeedback');
has('the label chip is rendered in the matchup turn', APP, 'var lede=structuredLabelHTML(d)+');
has('the panels are rendered under the research card', APP, '+structuredPanelsHTML(d)\n');
has('feedback is exposed on EDAI', APP, 'feedback: recordFeedback');
has('the CSS for the structured answer exists', APP, '.dk-structured{');
has('the grid stacks at phone width', APP, '@media (max-width:640px){.dk-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}');

const ctx = {
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  mdToHtml: (s) => '<p>' + String(s) + '</p>',
  document: { querySelector: () => null },
  localStorage: { setItem: () => {} },
  console,
};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.DESK_SECTIONS=DESK_SECTIONS;this.structuredLabelHTML=structuredLabelHTML;this.structuredPanelsHTML=structuredPanelsHTML;this.deskProseHTML=deskProseHTML;this.freshBadge=freshBadge;', ctx);

const S = {
  schema: 'edgedesk_structured_answer_v1', prose_status: 'MODEL', packet_id: '401858900:ca8396f3',
  bottom_line: { label: 'PRICE DEPENDENT', decision: 'BET CANDIDATE', sentence: 'PRICE DEPENDENT — the case rests on the price, and ends when the price does.', read: { text: 'x', author: 'model' } },
  model_vs_market: {
    model_line: { home_line: 2.4, total: 58.1, favourite: 'North Texas', version: 'edgedesk_cfb_p4', generated_at: '2026-09-15T22:38:53Z', age: '3 h ago', freshness: 'LIVE', tier: 'RESEARCH' },
    market_line: { market: 'spreads', selection: 'North Texas', handicap: -2.5, price: '-105', book: 'DraftKings', captured_at: '2026-09-16T01:27:20Z', age: '14 min ago', freshness: 'LIVE', actionable: true, fair: 'Pinnacle de-vig fair' },
    consensus: null, gap_points: -0.1, orientation: { favourite_model: 'North Texas', favourite_market: 'North Texas', faults: [] },
    best_price: { american: '-105', book: 'DraftKings', freshness: 'LIVE' },
    movement: { opener_american: '-110', current_american: '-105', price_move_cents: 5, point_move: null, cause: 'UNKNOWN', cause_note: 'EdgeDesk records prices, not handle.' },
  },
  price_discipline: { current_price: '-105 at DraftKings', playable_to: '-112', price_needed: null, break_even_probability: 0.5128, ev_per_unit: 0.0374, ev_basis: 'Expected value measured against the market fair price, NOT produced by EdgeDesk’s model.' },
  confidence: { data: { band: 'LOW', score: 0.36, missing: ['availability for both sides', 'matchup drivers'] }, conclusion: { band: 'MEDIUM', score: 0.6, missing: ['validated probability in this market'] } },
  what_could_break_it: { unknowns: ['Availability for the home side is UNKNOWN.', 'Weather is not on file for this game.'] },
  sources: [
    { source: 'football/fbs/slate.json', kind: 'edgedesk_artifact', observed_at: null, freshness: 'LIVE' },
    { source: 'signals (DraftKings, spreads)', kind: 'market_capture', observed_at: '2026-09-16T01:27:20Z', freshness: 'LIVE' },
    { source: 'cfb.lines (consensus, no book, no timestamp)', kind: 'reference_number', observed_at: null, freshness: 'UNKNOWN' },
  ],
};
const critic = { verdict: 'WARN', findings: [{ code: 'NUMBER_NOT_IN_EVIDENCE', severity: 'WARN', detail: 'numbers with no source in the packet: 37' }] };

const label = ctx.structuredLabelHTML({ structured: S });
has('the label chip names the label', label, 'PRICE DEPENDENT');
has('and its sentence', label, 'ends when the price does');
lacks('an accepted answer is not marked rejected', label, 'rejected');
const rej = ctx.structuredLabelHTML({ structured: Object.assign({}, S, { prose_status: 'REJECTED' }) });
has('a rejected answer says so', rej, 'rejected by EdgeDesk');

const panels = ctx.structuredPanelsHTML({ structured: S, critic });
has('the model cell carries the home line', panels, 'home +2.4');
has('and the total', panels, 'total 58.1');
has('and the model version and age', panels, 'edgedesk_cfb_p4 &middot; 3 h ago'.replace('&middot;', '·'));
has('the market cell carries the price and book', panels, 'North Texas -2.5 at -105');
has('and the capture age', panels, 'captured 14 min ago');
has('with a LIVE badge', panels, 'dk-fresh live">LIVE');
has('the gap cell states both favourites', panels, 'model North Texas · market North Texas');
has('the best captured price is labelled as captured, not best anywhere', panels, 'among the books EdgeDesk captured');
has('price discipline carries playable-to', panels, 'Playable to <b>-112</b>');
has('and break-even', panels, 'Break-even 51.3%');
has('and expected return', panels, 'Expected return 3.74% per unit');
has('and says whose probability it is', panels, 'NOT produced by EdgeDesk');
has('movement is shown with its cause UNKNOWN', panels, 'Cause: <b>UNKNOWN</b>');
has('data confidence is shown', panels, 'Data confidence');
has('conclusion confidence is shown separately', panels, 'Conclusion confidence');
has('and names what is missing', panels, 'missing: availability for both sides');
has('unknowns are listed', panels, 'What EdgeDesk cannot see (2)');
has('sources are listed with observed times', panels, '2026-09-16 01:27Z');
has('an unknown-freshness source gets an UNKNOWN badge', panels, 'dk-fresh unknown">UNKNOWN');
has('the critic findings are disclosed', panels, 'checks on the written read: WARN (1)');
has('with the finding code', panels, 'NUMBER_NOT_IN_EVIDENCE');
has('feedback: helpful', panels, "EDAI.feedback('helpful'");
has('feedback: wrong data', panels, "EDAI.feedback('wrong_data'");
has('the packet id travels with feedback', panels, '401858900:ca8396f3');
chk('no panel is rendered without a structured answer', ctx.structuredPanelsHTML({}) === '' && ctx.structuredLabelHTML({}) === '');

const noMarket = ctx.structuredPanelsHTML({ structured: Object.assign({}, S, { model_vs_market: Object.assign({}, S.model_vs_market, { market_line: null, best_price: null, consensus: { spread_home: 2.5, total: 57.5 } }) }) });
has('with no book price the consensus number is shown as a consensus', noMarket, 'consensus home +2.5');
has('and labelled as having no book and no capture time', noMarket, 'no book, no capture time');

const five = ['**The Desk’s read**', 'a', '**Why**', '- b', '**The case for each side**', '- c', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
const prose = ctx.deskProseHTML(five);
has('a five-section answer promotes the fifth heading', prose, 'The case for each side');
has('as its own section', prose, 'dk-sec sides');
const four = ['**The Desk’s read**', 'a', '**Why**', '- b', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
chk('a four-section answer from an older build still parses', ctx.deskProseHTML(four).indexOf('dk-read') >= 0);
chk('sections come out in answer order', (() => { const h = prose; return h.indexOf('dk-sec why') < h.indexOf('dk-sec sides') && h.indexOf('dk-sec sides') < h.indexOf('dk-sec wrong'); })());
done();
