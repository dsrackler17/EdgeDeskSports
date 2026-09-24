#!/usr/bin/env node
/* ===========================================================================
   "5 Games Worth Researching" on the Football overview, cut out of app.html
   and run for real.

   The module between the FIVE GAMES WORTH RESEARCHING marker and the
   model-vs-market component is executed with the page's OWN status readers
   (fbP4StatusFor, fbNflResearchState, fbRecDisagrees), its own formatters,
   the real shared research layer (lib/research_core, research_eval,
   game_research) and the real ordering (lib/research_priority.js). Board rows
   are built in exactly the shape fbGameRows() returns.

   What it holds:
     1  the list reads the board's statuses verbatim and changes no number;
     2  DATA FAULT, THIN DATA, no market, stale quotes (the board's rule AND
        the research layer's window) never appear;
     3  INVESTIGATE appears only when otherwise eligible, and a 7+ pt gap or
        an unknown QB is labelled Higher uncertainty;
     4  five rows when more qualify, fewer when fewer do, an honest empty
        state when none do, and a loading / failed state for the layer;
     5  every row shows rank, matchup, kickoff, league, EdgeDesk and market
        spreads, the difference, one "why", the status and Open research —
        which goes through the board's existing fbOpenGame;
     6  the Today signals are folded under it, not duplicated beside it;
     7  nothing reads as a pick.

   Run: node tools/app/worth_researching_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function same(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, { missing: needle }); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, { present: needle }); }

/* ---- the code under test, cut out of the page --------------------------- */
const START = APP.indexOf('/* ═══ FIVE GAMES WORTH RESEARCHING');
const END = APP.indexOf('/* ---- model vs market: one reusable component', START);
if (START < 0 || END < 0) { console.log('FAIL | app.html no longer carries the worth-researching module between its markers'); process.exit(1); }
const SRC = APP.slice(START, END);
function lineSrc(prefix) {
  const at = APP.indexOf('\n' + prefix);
  if (at < 0) throw new Error('app.html no longer contains: ' + prefix);
  return APP.slice(at + 1, APP.indexOf('\n', at + 1));
}
function fnSrc(name) {
  const at = APP.indexOf('\nfunction ' + name + '(');
  if (at < 0) throw new Error('app.html no longer contains function ' + name);
  return APP.slice(at + 1, APP.indexOf('\n}\n', at) + 3);
}
const PAGE_HELPERS = [lineSrc('function edEsc('), lineSrc('function _escHtml('), lineSrc('function fbEsc('), lineSrc('function edAttrJs('),
  lineSrc('function fbPts('), lineSrc('function fbHomeLine('), lineSrc('function ago('), lineSrc('function whenLabel('),
  lineSrc('var FB_GUARD='), fnSrc('fbRecDisagrees'), fnSrc('fbP4StatusFor'), fnSrc('fbNflResearchState')].join('\n');

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const H = 3600e3;

/* ---- board rows, in fbGameRows() shape ---------------------------------- */
function nflRow(gid, home, away, fair, line, o) {
  o = o || {};
  const fairTotal = o.fairTotal == null ? 45 : o.fairTotal, total = o.total === undefined ? 44 : o.total;
  const gapS = line == null ? null : fair - line, gapT = total == null ? null : fairTotal - total;
  const cls = (g) => ({ recommendation: g == null ? 'NO_MARKET' : Math.abs(g) >= 2 ? 'RESEARCH_LEAN' : 'PASS', validated: false });
  const ref = o.src === 'nflverse reference';
  const p = { status: 'PREDICTED', sport: 'nfl', model: { fair_spread: fair, fair_total: fairTotal, home_win_prob: 0.5 + fair / 40 },
    market: { spread_line: line, total_line: total, spread_gap: gapS, total_gap: gapT },
    edge: { spread: cls(gapS), total: cls(gapT) }, data_quality: { status: 'OK', warnings: (o.warn || []).slice() },
    prediction_timestamp: iso(NOW - 60e3), fingerprint: 'fp_' + gid, model_version: 'edgedesk_football_v1.0.0' };
  const mkt = { spread_line: line, total_line: total, spread_book: ref ? null : 'DraftKings', total_book: ref ? null : 'DraftKings',
    quotes_h2h: null, at: ref ? null : iso(NOW - (o.ageH == null ? 1 : o.ageH) * H), h2h_move: null, first_seen: null };
  return { sport: 'nfl', gid: String(gid), home, away, hc: home.slice(0, 3).toUpperCase(), ac: away.slice(0, 3).toUpperCase(),
    t: NOW + (o.inH || 30) * H, week: 4, p, mkt, src: ref ? 'nflverse reference' : 'captured', book: mkt.spread_book,
    at: mkt.at ? Date.parse(mkt.at) : null, ref: ref && line != null, ok: true, gapS, gapT,
    lean: cls(gapS).recommendation === 'RESEARCH_LEAN', winp: p.model.home_win_prob, warn: (o.warn || []).slice(),
    fault: gapS != null && Math.abs(gapS) > 14, thin: false, stale: false, move: o.move == null ? null : o.move };
}
const CFB_UP = [];
function cfbRow(gid, home, away, fair, line, o) {
  o = o || {};
  const thin = !!o.thin, stale = !!o.stale;
  const gapS = line == null ? null : fair - line;
  const p = { status: 'PREDICTED', model: { fair_spread: fair, fair_total: 55, home_win_prob: 0.5 + fair / 50, sigma_margin: o.sigma || 15,
    p10_margin: fair - 19, p90_margin: fair + 19 },
    market: { spread_line: line, total_line: 54, spread_gap: gapS, total_gap: 1, opening_spread: o.open == null ? null : o.open },
    edge: { spread: { recommendation: thin ? 'PASS_LOW_CONFIDENCE' : gapS == null ? 'NO_MARKET' : Math.abs(gapS) >= 2 ? 'RESEARCH_LEAN' : 'PASS' },
      total: { recommendation: 'PASS' } },
    scores: { confidence: thin ? 20 : 70 }, prediction_timestamp: iso(NOW - 60e3), explanation: { data_quality: [] } };
  const book = o.book || (stale ? 'captured (stale 80h) · FanDuel' : 'captured · FanDuel');
  const mkt = { spread_line: line, total_line: 54, quotes_h2h: null, book, as_of: o.asOf === undefined ? iso(NOW - H) : o.asOf,
    stale, status: line == null ? 'NO MARKET' : stale ? 'STALE QUOTE' : 'LIVE', match: null };
  const r = { sport: 'p4', gid: String(gid), home, away, hc: home, ac: away, t: NOW + (o.inH || 48) * H, week: 5, p, mkt,
    src: book, book, at: mkt.as_of ? Date.parse(mkt.as_of) : null, ref: false, ok: true, gapS, gapT: 1,
    lean: !thin && gapS != null && Math.abs(gapS) >= 2, winp: p.model.home_win_prob, warn: (o.warn || []).slice(),
    fault: !thin && !stale && gapS != null && Math.abs(gapS) > 21, thin, stale, move: null,
    _quality: o.quality || { team_ratings: { status: 'AVAILABLE' }, qb: { status: 'AVAILABLE' }, injuries: { status: 'AVAILABLE' },
      market: { status: 'AVAILABLE' }, weather: { status: 'PARTIAL' } },
    _builtYoung: !!o.builtYoung };
  CFB_UP.push({ g: { game_id: gid, home_team: home, away_team: away }, t: r.t });
  return r;
}

const BOARD = [
  cfbRow(101, 'Florida', 'Ole Miss', -4.1, 2),                                 /* RESEARCH, flips the favourite       */
  cfbRow(102, 'Auburn', 'Baylor', 18, 9),                                      /* INVESTIGATE: 9-pt gap                 */
  cfbRow(103, 'Iowa', 'Purdue', 30, 5),                                        /* DATA FAULT: past the 21-pt guard      */
  cfbRow(104, 'Duke', 'Tulane', 12, 3, { thin: true }),                        /* THIN DATA                             */
  cfbRow(105, 'Utah', 'Arizona', 11, 4, { stale: true, asOf: iso(NOW - 80 * H) }),  /* STALE QUOTE (board rule)       */
  cfbRow(106, 'Oregon', 'Boise State', 14, null),                              /* NO MARKET                             */
  cfbRow(107, 'Texas', 'Oklahoma', 10, 6.5, { book: 'cfb.lines · consensus', asOf: null }),  /* consensus line          */
  cfbRow(108, 'Clemson', 'Miami', 9, 4, { asOf: iso(NOW - 9 * H), builtYoung: true }),       /* 9h quote, cached young   */
  nflRow('201', 'Buffalo Bills', 'Detroit Lions', 6.5, 3),                     /* NFL INVESTIGATE 3.5: research band    */
  nflRow('202', 'Chicago Bears', 'New York Jets', 8, 3, { warn: ['home QB starter unknown'] }),  /* QB unknown          */
  nflRow('203', 'Kansas City Chiefs', 'Miami Dolphins', 9, 3, { ageH: 10 }),   /* captured 10h ago: stale by the layer  */
  nflRow('204', 'Seattle Seahawks', 'Los Angeles Chargers', 7, 3.5, { src: 'nflverse reference' }),  /* reference line  */
  nflRow('205', 'Atlanta Falcons', 'New Orleans Saints', 3, 2),               /* AGREEMENT 1 pt: nothing to explain    */
  nflRow('206', 'Denver Broncos', 'Los Angeles Rams', 20, 3)                   /* DATA FAULT: past the 14-pt guard      */
];
const BY_GID = {}; BOARD.forEach((r) => { BY_GID[r.gid] = r; });

/* ---- the world the module runs in --------------------------------------- */
function makeCtx(opts) {
  opts = opts || {};
  const fired = [], opened = [], scripts = [], gx = [];
  const c = { console, Date, Math, JSON, String, Number, Object, Array, isFinite, RegExp, Error, Promise, parseFloat, parseInt };
  c.window = c; c.self = c; c.globalThis = c;
  vm.createContext(c);
  if (opts.layer !== false) ['research_core.js', 'research_eval.js', 'game_research.js'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), c));
  if (opts.priority !== false) vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'research_priority.js'), 'utf8'), c);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'params.js'), 'utf8'), c);
  vm.runInContext(PAGE_HELPERS, c);
  Object.assign(c, {
    FB: { ui: opts.ui || {}, p4: { up: CFB_UP } }, FB_LOOKAHEAD_D: 12, RS_TK_OPEN: {},
    $: () => null, document: { getElementById: () => null },
    fbScopeLabel: () => 'NFL + FBS', fbGameRows: () => opts.rows || BOARD,
    fbScript: (src) => { scripts.push(src); return Promise.resolve(); },
    fbOpenGame: (sport, gid) => opened.push([sport, gid]),
    edEvent: (name, params) => fired.push([name, params]),
    /* the cockpit's object, built by the real shared layer from the row's
       engine output and joined market — the same inputs fbGxResearchObj uses */
    fbGxResearchObj: (u, p) => {
      const r = BY_GID[String(u.g.game_id)], mk = r.mkt, R = c.EDResearch; gx.push(r.gid);
      const market = {};
      if (mk.spread_line != null) market.current = { line: R.spreadFromMargin(mk.spread_line), captured_at: mk.as_of || null, source: mk.book };
      if (p.market.opening_spread != null) market.open = { line: R.spreadFromMargin(p.market.opening_spread), captured_at: null, source: 'opening line' };
      return c.EDGameResearch.build({ now: r._builtYoung ? mk.as_of : new Date().toISOString(),
        game: { sport: 'CFB', game_id: r.gid, home: r.home, away: r.away }, model: { engine: p }, market,
        quality: r._quality, quality_categories: Object.keys(r._quality) });
    },
    __fired: fired, __opened: opened, __scripts: scripts, __gx: gx
  });
  vm.runInContext(SRC, c, { filename: 'app.html:worth-researching' });
  return c;
}
function rowsOf(html) { return html.split('<div class="fb-wr-r">').slice(1); }

/* ======================================================================== */
/* 1. THE FULL BOARD                                                        */
/* ======================================================================== */
const C = makeCtx();
const before = JSON.stringify(BOARD);
const HTML = C.fbWrInner(BOARD);
const ROWS = rowsOf(HTML);
eq('the board is read without changing a row, a projection or a market', JSON.stringify(BOARD), before);
has(HTML, '5 Games Worth Researching', 'the section is titled');
eq('more than five eligible: exactly five rows', ROWS.length, 5);
has(HTML, '6 of 14 clear the gates', 'and the header says how many cleared of how many');
same('ranked 1 to 5', ROWS.map((r) => (r.match(/<span class="n">(\d)<\/span>/) || [])[1]), ['1', '2', '3', '4', '5']);

/* the candidates carry the board's own statuses, verbatim */
const ix = {}; CFB_UP.forEach((u) => { ix[String(u.g.game_id)] = u; });
BOARD.forEach((r) => {
  const cand = C.fbWrCandidate(r, ix);
  const want = r.sport === 'p4' ? C.fbP4StatusFor(r.p, r.mkt).t : C.fbNflResearchState(r.p, r.mkt).label;
  eq('status for ' + r.away + ' @ ' + r.home + ' is the board\'s own (' + want + ')', cand.status, want);
  eq('and its EdgeDesk number is the engine\'s', cand.model_margin, r.p.model.fair_spread);
  eq('and its market number is the joined one', cand.market_margin, r.mkt.spread_line);
});
eq('CFB research reads go through the cockpit object', C.__gx.indexOf('101') >= 0, true);

/* the excluded games never appear */
[['Purdue @ Iowa', 'DATA FAULT (CFB guard)'], ['Tulane @ Duke', 'THIN DATA'], ['Arizona @ Utah', 'STALE QUOTE'],
 ['Boise State @ Oregon', 'NO MARKET'], ['Miami @ Clemson', 'a 9h quote the research layer calls stale, even from a cache built when it was young'],
 ['Miami Dolphins @ Kansas City Chiefs', 'a captured NFL quote older than the research freshness window'],
 ['New Orleans Saints @ Atlanta Falcons', 'AGREEMENT with nothing to explain'], ['Los Angeles Rams @ Denver Broncos', 'DATA FAULT (NFL guard)']]
  .forEach((x) => lacks(HTML, x[0], 'excluded: ' + x[1]));
const R0 = C.EDResearchPriority.rank(BOARD.map((r) => C.fbWrCandidate(r, ix)), 14);
const reasons = {}; R0.excluded.forEach((e) => { reasons[e.key] = e.reasons.join('+'); });
eq('Iowa is out as a data fault', reasons['p4|103'], 'DATA_FAULT');
eq('Duke is out as thin data', reasons['p4|104'], 'THIN_DATA');
eq('Utah is out on its stale quote', reasons['p4|105'], 'STALE_MARKET');
eq('Oregon is out with no market', reasons['p4|106'], 'NO_MARKET');
eq('Clemson is out: the quote aged past the window after its research object was cached', reasons['p4|108'], 'STALE_MARKET');
eq('the 10h NFL quote is out as stale', reasons['nfl|203'], 'STALE_MARKET');
eq('the 1-pt NFL agreement has nothing to explain', reasons['nfl|205'], 'NOTHING_TO_EXPLAIN');
eq('Denver is out as a data fault', reasons['nfl|206'], 'DATA_FAULT');
eq('six are eligible', R0.eligible, 6);
same('the list is the ordering layer\'s top five, in its order',
  ROWS.map((r) => (r.match(/<span class="m">([^<]+)<\/span>/) || [])[1]),
  R0.items.slice(0, 5).map((x) => x.candidate.away + ' @ ' + x.candidate.home));

/* every row carries what the spec asks for, and nothing more */
ROWS.forEach((r, i) => {
  const n = '(row ' + (i + 1) + ') ';
  has(r, '<i>Market</i>', n + 'shows the market spread');
  has(r, '<i>EdgeDesk</i>', n + 'shows the EdgeDesk spread');
  has(r, '<i>Difference</i>', n + 'shows the difference');
  chk(n + 'with a status chip', /<span class="fb-wr-st[^"]*">(RESEARCH|INVESTIGATE|AGREEMENT)<\/span>/.test(r));
  chk(n + 'a league', /<span class="ts">(CFB|NFL) · /.test(r));
  has(r, '<b>Why research it</b>', n + 'one why');
  eq(n + 'exactly one Open research action', (r.match(/Open research/g) || []).length, 1);
  lacks(r, 'fb-sig-grid', n + 'and not the full signal card');
});
const flip = ROWS.find((r) => r.indexOf('Ole Miss @ Florida') >= 0);
chk('the flip game is listed', !!flip);
has(flip, '<i>Market</i>Florida -2.0', 'its market line reads as the home line');
has(flip, '<i>EdgeDesk</i>Florida +4.1', 'its EdgeDesk line likewise');
has(flip, '<i>Difference</i>6.1 pts', 'and the difference');
has(flip, 'Model flips the market favorite: EdgeDesk has Ole Miss by 4.1, the market has Florida by 2.', 'with the flip explained');
has(flip, '>RESEARCH<', 'under its board status');
lacks(flip, 'Higher uncertainty', 'and no uncertainty label it has not earned');

/* INVESTIGATE: only when otherwise eligible, and labelled */
const inv = ROWS.find((r) => r.indexOf('Baylor @ Auburn') >= 0);
chk('a CFB INVESTIGATE game that clears every gate is listed', !!inv);
has(inv, '>INVESTIGATE<', 'under its INVESTIGATE status');
has(inv, 'Higher uncertainty · gap of 7+ pts', 'and labelled higher uncertainty');
const band = ROWS.find((r) => r.indexOf('Detroit Lions @ Buffalo Bills') >= 0);
chk('an NFL INVESTIGATE game inside 7 pts is listed', !!band);
lacks(band || '', 'Higher uncertainty', 'without the label: that is the NFL research band');
const qb = ROWS.find((r) => r.indexOf('New York Jets @ Chicago Bears') >= 0);
chk('an NFL game with an unknown QB is listed', !!qb);
has(qb || '', 'Higher uncertainty · QB starter unknown', 'and says why its uncertainty is higher');
/* the consensus line is honest about what it is */
const cons = [HTML].concat(ROWS).join('');
chk('a game on a consensus line says so', /Oklahoma @ Texas[\s\S]*?consensus line|Los Angeles Chargers @ Seattle Seahawks[\s\S]*?consensus line/.test(cons));
chk('a captured quote carries its age', /market \d+(s|m|h) ago/.test(HTML));

/* the reading-order note and the rule */
has(HTML, 'Reading order, not a ranking of bets. Research signals can be wrong.', 'the note sits under the list');
has(HTML, 'How this order is built', 'the rule is one tap away');
has(HTML, C.fbEsc(C.EDResearchPriority.RULE), 'and it is the ordering layer\'s own rule text');

/* deterministic: the same board in any order renders the same list */
chk('the same board shuffled renders the same list', C.fbWrInner(BOARD.slice().reverse()) === HTML);

/* ======================================================================== */
/* 2. OPEN RESEARCH GOES THROUGH THE EXISTING ROUTE                          */
/* ======================================================================== */
const call = (ROWS[0].match(/onclick="(fbWrOpen\([^"]*\))"/) || [])[1];
chk('the action calls fbWrOpen', !!call, ROWS[0].slice(-300));
vm.runInContext(String(call).replace(/&#39;/g, "'"), C);
eq('which opens the game through fbOpenGame', C.__opened.length, 1);
chk('with the board sport and game id', C.__opened[0] && ['p4', 'nfl'].indexOf(C.__opened[0][0]) >= 0 && BY_GID[C.__opened[0][1]]);
chk('and counts the open on the existing analytics event',
  C.__fired.some((f) => f[0] === 'research_game_open' && f[1].surface === 'worth_researching' && f[1].rank === 1));
has(APP, 'window.fbOpenGame=function(sport,gid){', 'fbOpenGame is the board\'s existing opener');

/* ======================================================================== */
/* 3. FEWER, NONE, AND A LAYER THAT IS NOT THERE                            */
/* ======================================================================== */
let h = makeCtx().fbWrInner([BY_GID['101'], BY_GID['201'], BY_GID['103']]);
eq('fewer than five eligible: that many rows', rowsOf(h).length, 2);
has(h, 'Only 2 games clear the gates right now. Nothing is added to fill the list.', 'and it says nothing was added');
h = makeCtx().fbWrInner([BY_GID['103'], BY_GID['104'], BY_GID['105']]);
eq('none eligible: no rows', rowsOf(h).length, 0);
has(h, 'No game on the board clears the research gates right now.', 'the empty state says so');
has(h, '3 games checked: 1 data fault · 1 thin data · 1 stale quote', 'and why, by gate');
has(h, 'Nothing is forced onto this list.', 'without forcing anything onto it');
h = makeCtx().fbWrInner([]);
has(h, 'No games inside the next 12 days in the schedule feed.', 'an empty board says the feed is empty');
lacks(h, 'fb-wr-r', 'and lists nothing');

const L = makeCtx({ layer: false });
h = L.fbWrInner(BOARD);
has(h, 'Loading the shared research layer', 'without the shared layer the module says it is loading');
eq('and ranks nothing meanwhile', rowsOf(h).length, 0);
L.fbWrEnsureLayer(); L.fbWrEnsureLayer();
const layerLoad = L.FB.ui.wrLayer.p;
chk('a load is in flight', !!layerLoad && typeof layerLoad.then === 'function');
['lib/research_core.js', 'lib/research_eval.js', 'lib/game_research.js'].forEach((s) =>
  has(APP, "fbScript('" + s + "')", 'through the same fbScript key the FBS board uses (' + s + ')'));
const failed = makeCtx({ layer: false, ui: { wrLayer: { err: 'lib/game_research.js did not load' } } }).fbWrInner(BOARD);
has(failed, 'The shared research layer did not load', 'a failed load says so');
has(failed, 'Nothing is ranked rather than something invented', 'and ranks nothing');
has(makeCtx({ priority: false }).fbWrInner(BOARD), 'research-priority layer (lib/research_priority.js) did not load', 'a missing ordering layer says so too');

/* ======================================================================== */
/* 4. THE PAGE                                                              */
/* ======================================================================== */
has(APP, '<script src="/lib/research_priority.js?v=', 'the page loads the ordering layer');
chk('which exists', fs.existsSync(path.join(ROOT, 'lib', 'research_priority.js')));
const OV = fnSrc('fbOverviewHTML');
chk('the module sits under the snapshot and above the Today signals',
  OV.indexOf("rsTkSnap(") >= 0 && OV.indexOf("rsTkSnap(") < OV.indexOf("'<div id=\"fbWr\">'+fbWrInner(rows)+'</div>'")
  && OV.indexOf("'<div id=\"fbWr\">'+fbWrInner(rows)+'</div>'") < OV.indexOf('Today in football'));
has(OV, "fbWrTodayFold(items,rsTkToday(items,'fbToday'", 'the Today signals fold under it rather than repeating beside it');
has(fnSrc('fbRenderOverview'), 'if(FB.at)fbWrEnsureLayer();', 'the overview asks for the research layer once the engine is up');
const T = makeCtx();
const items = [{ pri: 'major' }, { pri: 'neg' }, { pri: 'warn' }, { pri: 'info' }];
const fold = T.fbWrTodayFold(items, '<div class="fb-today">CARDS</div>');
has(fold, 'CARDS', 'the fold carries the same Today cards');
has(fold, 'Show 4 board signals · 2 data warnings', 'and names the data warnings on its toggle');
has(fold, 'id="fbTodayAllCol"', 'it collapses with the shared toggle');
eq('a quiet day is shown as it was', T.fbWrTodayFold([], 'QUIET'), 'QUIET');
/* the Today signals themselves are untouched (research_landing pins them) */
has(APP, 'function fbTodayItems(rows){', 'fbTodayItems still exists');
has(APP, 'var rows=fbGameRows(), items=fbTodayItems(rows), byK={};', 'and the research desk still reads it');

/* ======================================================================== */
/* 5. NO PICK LANGUAGE                                                      */
/* ======================================================================== */
const TEXT = HTML + fold + SRC;
[/best bets?/i, /top plays?/i, /\blocks?\b/i, /bet this/i, /edge of the day/i, /\bpicks?\b/i, /\bwager/i].forEach((re) =>
  chk('no "' + re.source + '" on the module or in its source', !re.test(TEXT)));

/* the layer load, once it settles */
layerLoad.then(() => {
  same('it asks for the layer once, in the FBS board\'s order', L.__scripts, ['lib/research_core.js', 'lib/research_eval.js', 'lib/game_research.js']);
  eq('a load that leaves no research builder is recorded as failed', L.FB.ui.wrLayer.err, 'lib/game_research.js did not load');
  has(L.fbWrInner(BOARD), 'The shared research layer did not load', 'and the module then says so instead of loading forever');
}).catch((e) => chk('the layer load settles', false, String(e))).then(() => {
  console.log('');
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\nworth researching UI: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
