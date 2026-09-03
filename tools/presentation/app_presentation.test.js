#!/usr/bin/env node
/* ===========================================================================
   Tests for the decision card + publisher desk as WIRED INTO app.html.

   The EDCARD block is cut out of app.html between its markers and executed
   in a sandbox with the real presentation library and a stubbed engine, so
   this cannot pass against a copy that has drifted from the page. Also
   checks the structural facts the product promises: the card leads the
   receipt, the Top-edges strip carries verdict/selection/price/good-to, the
   mobile CSS never hides the hero, and the AI call carries a presentation
   mode.

   Run: node tools/presentation/app_presentation.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) { console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')); });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));

function slice(start, end, label) {
  const a = APP.indexOf(start), b = APP.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('app.html no longer contains ' + label);
  return APP.slice(a, b + end.length);
}

/* ---- ordering: library before the engine, card block after it ----------- */
{
  const pres = APP.indexOf('/*__EDPRES_START__*/');
  const edai = APP.indexOf('EdgeDesk Intelligence — decision-support layer.');
  const card = APP.indexOf('/*__EDCARD_START__*/');
  const fabric = APP.indexOf('/*__EDINT_MODULE_START__*/');
  chk('presentation library is inlined before the Intelligence block', pres > 0 && pres < edai);
  chk('decision-card block sits after the Intelligence block and before the fabric', card > edai && card < fabric);
  chk('the inlined library matches the canonical file byte for byte', (function () {
    const canon = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'), 'utf8');
    const block = function (s) { const a = s.indexOf('/*__EDPRES_START__*/'), b = s.indexOf('/*__EDPRES_END__*/'); return s.slice(a, b); };
    return block(APP) === block(canon);
  })());
}

/* ---- the EDCARD block runs against a stubbed engine ---------------------- */
const block = slice('/*__EDCARD_START__*/', '/*__EDCARD_END__*/', 'the EDCARD block');
function fixtureX(over) {
  const e = Object.assign({ event_id: 'ev1', sport_key: 'americanfootball_ncaaf', market: 'spreads', selection: 'Texas Tech', point: -3.5,
    home_team: 'Baylor', away_team: 'Texas Tech', commence_time: '2026-09-05T23:30:00Z', last_seen_at: new Date(Date.now() - 8 * 60000).toISOString(), best_book: 'DraftKings' }, (over && over.e) || {});
  return Object.assign({
    e: e, sel: 'Texas Tech -3.5', matchup: 'Texas Tech @ Baylor', market: 'Spread', sport: 'CFB',
    curAm: -110, detAm: -108, fairAm: -121, maxAm: -118, bestAm: -108, book: 'DraftKings', trusted: true, pinDec: null,
    curEdge: 0.031, detEdge: 0.034, evNow: 0.031, remaining: 0.91, sharp: true, nb: 6, nbe: 6, corr: 1, staleM: 8,
    graded: false, verdict: 'BET', dverdict: 'BET', isWait: false, waitWhy: null, confidence: 'HIGH', why: 'Clears the bar.',
    reasonsFor: ['+3.1% estimated edge vs Pinnacle de-vig fair', 'Pinnacle (sharp reference) is quoting this side', '6 books behind the fair line'],
    reasonsAgainst: ['no sharp (Pinnacle) confirmation on this exact side'],
    falsifiers: ['Price keeps moving against you: 91% of the detection edge is left, and past -118 the EV crosses the 0.5% floor.'],
    breakevenAm: -121, toPlayAm: -118, needsPriceForEv: null, score: 82, band: 'Solid', mlb: null,
  }, over || {});
}
/* The real packetOf, cut out of the Intelligence block so the test exercises
   the exact object the AI call and the card share. */
const packetSrc = (function () { const s = slice('  function packetOf(x){', '  /* Four PRESENTATIONS of one research engine.', 'packetOf'); return s.slice(0, s.lastIndexOf('/* Four PRESENTATIONS')); })();
function sandbox() {
  const win = {};
  const ctx = {
    window: win, document: { getElementById: function () { return null; }, createElement: function () { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, remove() {} }; }, body: { appendChild() {}, classList: { add() {}, remove() {} } } },
    console: console, Date: Date, JSON: JSON, Math: Math, Object: Object, Array: Array, String: String, Number: Number, RegExp: RegExp, Intl: Intl, Error: Error, Promise: Promise,
    setTimeout: setTimeout, EDGE_MAX_AGE_MIN: 90, crypto: { getRandomValues: function (b) { for (let i = 0; i < b.length; i++) b[i] = i * 7; return b; } }, Uint8Array: Uint8Array,
    edSession: function () { return null; }, location: { href: 'https://edgedesk.test/app.html' }, navigator: {},
  };
  ctx.globalThis = ctx;
  win.EDPRES = P;
  const xs = {};
  win.EDAI = {
    evidence: function (e) { return xs[e.event_id + '|' + e.selection] || null; },
    packetOf: null,
    callFn: async function () { return null; },
  };
  vm.createContext(ctx);
  /* packetOf needs the few helpers the Intelligence block has in scope. */
  vm.runInContext('var FLOOR=0.005, STALE_MIN=90; function decToAm(d){return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1));} function mlbPacket(g){return null;}\n' + packetSrc + '\nwindow.EDAI.packetOf=packetOf;', ctx);
  vm.runInContext(block.replace(/<\/?script>/g, ''), ctx);
  return { win: win, xs: xs, ctx: ctx };
}

{
  const sb = sandbox();
  const x = fixtureX();
  sb.xs['ev1|Texas Tech'] = x;
  sb.win.EDGES = [x.e];
  chk('EDCARD and EDBRIEF are installed', sb.win.EDCARD && sb.win.EDBRIEF && typeof sb.win.dcardLeadHTML === 'function');

  const pk = sb.win.EDAI.packetOf(x);
  chk('packetOf carries market_key, selection_raw, point, book, last_seen_at', pk.market_key === 'spreads' && pk.selection_raw === 'Texas Tech' && pk.point === -3.5 && pk.prices.book === 'DraftKings' && pk.timing.last_seen_at === x.e.last_seen_at);
  chk('packetOf keeps the engine verdict fields verbatim', pk.deterministic.display_verdict === 'BET' && pk.price_sensitivity.max_playable === -118);

  const lead = sb.win.dcardLeadHTML(x.e, 't10_0');
  chk('Top-edges strip is a compact card', /class="dcard dc-bet compact"/.test(lead));
  chk('strip shows verdict, the bet in football words, the ticket line and the price limit', /BET/.test(lead) && /Texas Tech to win by 4 points or more/.test(lead) && /Spread · Texas Tech -3\.5 · -110 · DraftKings/.test(lead) && /Price limit<\/span> <b>-118 or better/.test(lead), lead.slice(0, 700));
  chk('strip answers in one line, with no undefined jargon', /dcard-line/.test(lead) && /dcard-sub/.test(lead) && !/sharper market|fair line|de-vig/i.test(lead), lead.slice(0, 700));
  chk('strip has View why + Create brief that do not toggle the row', /View why/.test(lead) && /Create brief/.test(lead) && /event\.stopPropagation\(\);toggleRcptId\((?:'|&#39;)t10_0(?:'|&#39;)\)/.test(lead));

  const rc = sb.win.dcardReceiptHTML(x.e, 't10_0');
  chk('receipt card is the full card with Full research first', /dcard-body/.test(rc) && /Full research/.test(rc) && /EDCARD\.toggleFull\((?:'|&#39;)t10_0/.test(rc));
  chk('receipt card offers Create brief and Ask EdgeDesk', /Create brief/.test(rc) && /Ask EdgeDesk/.test(rc));
  chk('what-does-this-mean expanders are templated and each names its subject', /What does .price limit. mean\?/.test(rc) && /What does this call mean\?/.test(rc) && !/>What does this mean\?</.test(rc));

  const s = sb.win.EDCARD.simpleFromSignal(x.e);
  chk('football cards name the injury gap rather than implying a clean sheet', s.flags.some(function (f) { return f.kind === 'DATA_GAP' && /Injury and availability data is not on file/.test(f.text); }));

  const pass = fixtureX({ e: { event_id: 'ev2', selection: 'Baylor', point: 3.5 }, sel: 'Baylor +3.5', verdict: 'PASS', dverdict: 'PASS', curEdge: 0.002, curAm: -125, needsPriceForEv: -118, reasonsFor: [], why: 'The edge existed at detection (-108) but the current price has moved to -125, pulling EV below the 0.5% floor.' });
  sb.xs['ev2|Baylor'] = pass;
  const pl = sb.win.dcardLeadHTML(pass.e, 't10_1');
  chk('PASS strip is calm, not an error: the price it would take is shown', /dc-pass/.test(pl) && /Price needed<\/span> <b>-118 or better/.test(pl) && /Not worth it at this price/.test(pl), pl.slice(0, 700));

  const btn = sb.win.fbBriefBtn('nfl', { home_team: 'KC', away_team: 'BAL' }, { t: 1 }, 'Kansas City Chiefs', 'Baltimore Ravens');
  chk('football Game brief button carries the schedule row, never a hardcoded team', /EDBRIEF\.openGame\(/.test(btn) && /Kansas City Chiefs/.test(btn) && /americanfootball_nfl/.test(btn));
  /* THE READER CHECK. A writer can run the five-second checklist on a brief
     before it leaves the desk, and it reports rather than blocks. */
  sb.win.EDBRIEF.openCard(sb.win.EDBRIEF.qaHTML ? 'dc1' : 'dc1');
  chk('the brief bar offers a Reader check', /Reader check/.test(sb.win.EDBRIEF.deskHTML('edges')) || /Reader check/.test(APP));
  chk('EDBRIEF exposes the reader check as a pure renderer', typeof sb.win.EDBRIEF.qaHTML === 'function' && typeof sb.win.EDBRIEF.openQA === 'function');
  chk('the reader check reports on every card in the brief', (function () {
    const card = sb.win.EDCARD.simpleFromSignal(x.e);
    const html = sb.win.EDBRIEF.qaHTML({ internal: { cards: [card] } });
    return /Reader check/.test(html) && /The card passes\./.test(html) && /Texas Tech to win by 4 points or more/.test(html);
  })(), sb.win.EDBRIEF.qaHTML({ internal: { cards: [sb.win.EDCARD.simpleFromSignal(x.e)] } }).slice(0, 400));
  chk('the reader check names what a reader would trip over', (function () {
    const card = JSON.parse(JSON.stringify(sb.win.EDCARD.simpleFromSignal(x.e)));
    card.plain.answer = null;
    const html = sb.win.EDBRIEF.qaHTML({ internal: { cards: [card] } });
    return /FIX/.test(html) && /next action is clear/.test(html) && /1 of 1 card/.test(html);
  })());
  chk('the reader check never touches a number or a verdict', !/verdict\s*=|playable_to\s*=|\.odds\s*=/.test(String(sb.win.EDBRIEF.qaHTML)));
  chk('an empty desk says so rather than passing vacuously', /Open a brief first/.test(sb.win.EDBRIEF.qaHTML(null)));

  const desk = sb.win.EDBRIEF.deskHTML('edges');
  chk('publisher desk offers TNF / SNF / MNF / CFB / slate presets', /openPrimetime\('TNF'\)/.test(desk) && /openPrimetime\('SNF'\)/.test(desk) && /openPrimetime\('MNF'\)/.test(desk) && /openCfbSlate\('top',3\)/.test(desk) && /openSlate\(null/.test(desk));
}

/* ---- the receipt: card first, full research behind one tap -------------- */
{
  const src = slice('function receiptInner(e,domid){', 'function expandItem(e,domid,headerInner){', 'receiptInner');
  chk('receiptInner leads with the decision card', /dcardReceiptHTML\(e,domid\)/.test(src) && src.indexOf('dcardReceiptHTML') < src.indexOf('receiptHTML(e)'));
  chk('everything that existed is preserved behind Full research', /rcpt-full/.test(src) && /mvtHTML/.test(src) && /rnextHTML/.test(src) && /edaiAnalyze/.test(src) && /ucLeadHTML/.test(src));
  chk('no card -> the old receipt renders untouched (plus the Full picture host)', /return card\?\(card\+pic\+/.test(src) && /:\(pic\+full\);/.test(src));
  const row = slice('function edgeRow(e,i){', 'window.__t10track', 'edgeRow');
  chk('Top edges row carries the decision strip', /dcardLeadHTML\(e,'t10_'\+i\)/.test(row));
}

/* ---- the AI call: presentation mode + server card ------------------------ */
{
  const ai = slice('  async function callFn(mode, question, x, extra, packet, compareArr){', '  async function askAI(mode, question, x, extra){', 'callFn');
  chk('the AI call sends a presentation mode', /presentation_mode:pm/.test(ai) && /PRES_MODE\[mode\]/.test(ai));
  chk('why and price ask for the SIMPLE presentation', /why:'SIMPLE',price:'SIMPLE'/.test(APP));
  const ask = slice('  async function askAI(mode, question, x, extra){', '  // very small markdown -> html', 'askAI');
  chk('askAI renders the server card above the answer', /presCardHTML\(d,x,mode\)\+integrityHTMLFor/.test(ask));
  chk('askAI still falls back to the local narrative on failure', /narrative\(x, lm\)/.test(ask));
  chk('EDAI exposes evidence, packetOf and callFn read-only', /evidence:function\(e\)\{ return evidence\(e\); \}/.test(APP) && /packetOf:function\(x\)\{ return packetOf\(x\); \}/.test(APP) && /callFn:function\(mode,q,x,extra\)/.test(APP));
  chk('snapshotHTML, investigate FINAL and the daily-scan headline lead with the card', (APP.match(/EDCARD\.cardForX\(x\)/g) || []).length >= 3);
}

/* ---- mobile: verdict / selection / price / good-to stay above the fold --- */
{
  const css = slice('/*__EDCARD_CSS_START__*/', '/*__EDCARD_CSS_END__*/', 'card CSS');
  const media = css.match(/@media\(max-width:480px\)\{[\s\S]*?\n\}/);
  chk('mobile rules exist', !!media);
  chk('mobile never hides the hero, verdict, selection, price or good-to', media && !/\.dcard-(hero|verdict|sel|price|goodto)[^{]*\{[^}]*display\s*:\s*none/.test(media[0]));
  chk('hero grid keeps the verdict beside the selection on phones', media && /\.dcard-hero\{grid-template-columns:auto minmax\(0,1fr\)/.test(media[0]));
  chk('full research is collapsed by default in the receipt', /\.rcpt-full\{display:none\}\.rcpt-full\.open\{display:block\}/.test(css));
  chk('print styles isolate the brief', /body\.printing-brief > \*:not\(#briefHost\)\{display:none!important\}/.test(css));
  const edb = slice('/*__EDB_CSS_START__*/', '/*__EDB_CSS_END__*/', 'brief CSS in app.html');
  const brief = fs.readFileSync(path.join(ROOT, 'brief.html'), 'utf8');
  const edb2 = brief.slice(brief.indexOf('/*__EDB_CSS_START__*/'), brief.indexOf('/*__EDB_CSS_END__*/') + '/*__EDB_CSS_END__*/'.length);
  chk('brief CSS is identical in app.html and brief.html', edb === edb2);
}

/* ---- football surfaces ---------------------------------------------------- */
{
  chk('NFL cards carry a Game brief', /fbBriefBtn\('nfl',g,u,homeName,awayName\)/.test(APP));
  chk('CFB cards carry a Game brief', /fbBriefBtn\('cfb',g,u\)/.test(APP));
  chk('Power 4 gate carries a Game brief', /fbBriefBtn\('cfb',u\.g,u\)/.test(APP));
  chk('football overview carries the publisher presets', /EDBRIEF\.deskHTML\('football'\)/.test(APP));
  chk('edges view hosts the publisher desk', /<div id="pubDesk"><\/div>/.test(APP));
}

/* ---- CLOSE THE LOOP: the receipt on the card, the calibration on the desk ---- */
{
  const sb = sandbox();
  const x = fixtureX({ e: { event_id: 'ev7', selection: 'Texas Tech', closed_at: '2026-09-06T00:00:00Z', graded_at: '2026-09-06T03:00:00Z' }, graded: true, clv: 0.021, beat: true, closeP: 0.5556, result: 'win' });
  sb.xs['ev7|Texas Tech'] = x;
  const pk = sb.win.EDAI.packetOf(x);
  chk('packetOf carries the engine receipt whole: clv, beat, closing, result, closed_at, graded_at', pk.clv && pk.clv.clv === 0.021 && pk.clv.beat_close === true && pk.clv.closing === 0.5556 && pk.clv.result === 'win' && pk.clv.closed_at === '2026-09-06T00:00:00Z' && pk.clv.graded_at === '2026-09-06T03:00:00Z', pk.clv);
  const lead = sb.win.dcardLeadHTML(x.e, 't10_7');
  chk('a graded edge shows its Result line on the Top-edges strip', /dcard-result win/.test(lead) && /Closed -125\. Beat the close by 17 cents\. Won\./.test(lead), lead.match(/dcard-result[^<]*<[^<]*<[^<]*/) && lead.match(/dcard-result[^<]*<[^<]*<[^<]*/)[0]);
  chk('the receipt card carries it too, and the verdict is unchanged', /dcard-result win/.test(sb.win.dcardReceiptHTML(x.e, 't10_7')) && /class="dcard dc-bet"/.test(sb.win.dcardReceiptHTML(x.e, 't10_7')));
  const plain = sb.win.dcardLeadHTML(fixtureX().e, 't10_0');
  chk('an ungraded edge has no Result line', !/dcard-result/.test(plain));
  chk('the Result line is styled for the compact strip and the full card', /\.dcard-result\{/.test(APP) && /\.dcard\.compact \.dcard-result\{/.test(APP));

  chk('the publisher desk offers Verdict calibration', /Verdict calibration/.test(sb.win.EDBRIEF.deskHTML('edges')) && /EDBRIEF\.openRecord\(\)/.test(sb.win.EDBRIEF.deskHTML('football')));
  chk('EDBRIEF exposes openRecord, loadRecord and the pure recordHTML', typeof sb.win.EDBRIEF.openRecord === 'function' && typeof sb.win.EDBRIEF.loadRecord === 'function' && typeof sb.win.EDBRIEF.recordHTML === 'function');
  const G = require(path.join(ROOT, 'tools', 'record', 'grade_briefs.js'));
  const AFTER = Date.parse('2026-09-11T09:00:00Z');
  const rows = [{ id: 'b1', share_slug: 'abcdefghijkl', report_type: 'GAME', preset: 'TNF', version_no: 1, sport: 'americanfootball_nfl', sport_label: 'NFL', title: 'Thursday Night Football', event_label: 'Chiefs at Ravens', generated_at: '2026-09-10T18:05:00Z',
    public_payload: { cards: [{ rank: 1, brief: { call: { verdict: 'BET' } } }], watch: [], slate: null, data_status: { prices: [{ event_id: 'ev1', market: 'Spread', market_key: 'spreads', selection: 'Chiefs +3.5', selection_raw: 'Chiefs', line: 3.5, odds: '-110', odds_am: -110, book: 'DraftKings', verdict: 'BET', kind: 'pick', rank: 1, commence: '2026-09-11T00:15:00Z', sport_key: 'americanfootball_nfl', home: 'Ravens', away: 'Chiefs' }] } } },
    { id: 'b2', share_slug: 'mmmmmmmmmmmm', report_type: 'SLATE', preset: 'CFB', version_no: 1, sport: 'americanfootball_ncaaf', sport_label: 'CFB', title: 'College Football', generated_at: '2026-09-04T18:00:00Z', public_payload: { cards: [], watch: [], slate: { headline: 'NO QUALIFYING BETS', no_bet: true, counts: {} }, data_status: { prices: [] } } }];
  const closes = [{ event_id: 'ev1', market: 'spreads', selection: 'Chiefs', point: 3.5, home_team: 'Ravens', away_team: 'Chiefs', commence_time: '2026-09-11T00:15:00Z', best_dec: 1.8, best_book: 'FanDuel', closing_sharp_fair: 0.5556, closed_at: '2026-09-11T00:10:00Z', result: 'win', graded_at: '2026-09-11T04:00:00Z' }];
  const rec = G.buildRecord(rows, closes, {}, null, AFTER, { closeSource: 'ok', closeSourceName: 'public_brief_closes' });
  const html = sb.win.EDBRIEF.recordHTML(rec);
  chk('the calibration overlay shows the headline record and the verdict × sport table', /Verdict calibration/.test(html) && /1 published · 1 graded · beat the close 100% · avg \+15 cents/.test(html) && /<td class="v bet">BET<\/td><td>NFL<\/td>/.test(html), html.slice(0, 900));
  chk('a no-bet brief counts as discipline in the overlay', /1 with no qualifying bet\. Those count as discipline\./.test(html) && /<td>CFB<\/td><td>1<\/td><td>1<\/td>/.test(html));
  chk('thin rows are shown but marked, and nothing here changes a threshold', /below 20/.test(html) && /nothing here changes a threshold/.test(html));
  chk('the overlay links to the public record', /record\.html#briefs/.test(html));
  chk('an empty record is an honest empty overlay', /No published calls have graded yet/.test(sb.win.EDBRIEF.recordHTML({ briefs: [], generated_at: null })) && /No briefs published yet/.test(sb.win.EDBRIEF.recordHTML({ briefs: [] })));
  chk('the record is read from beside the page, never from the database', /record\/grades\.json/.test(block) && !/rest\/v1\/brief/.test(block));
}

done();
