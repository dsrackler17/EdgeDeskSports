#!/usr/bin/env node
/* ============================================================================
   THE BRIEF CARRIES THE RESEARCH — and never carries a "null".

   WHAT WENT WRONG. Opening a game brief on a college game no sportsbook had
   posted produced a page of market boilerplate whose first sentence read
   "EdgeDesk is not ready to call this bet at null". Six headings under it
   each said, in different words, that there was no price. Not one of the
   ratings the board had already computed for those two teams appeared
   anywhere on it. And there was no way at all to print the week's rankings.

   WHAT THIS PINS.
     1. No lede, in any verdict branch, can print a price that is not on file.
     2. A projected score is never published with a negative side.
     3. The research block refuses stringified null/undefined/NaN.
     4. The game brief's ratings ARE the board's ratings — read through the
        same FBRK_FIELD map, so the two cannot disagree.
     5. A category with no rating prints "not measured", never 0 and never a
        league-average stand-in.
     6. The rankings brief's Top N is the artifact's own rank order, its
        movers are bounded to the printed set, and its coverage list only
        names categories the board actually ranks.
     7. The buttons that reach both briefs exist and are wired.

   It runs against the COMMITTED artifact, so a build that stopped publishing
   offence, defence or special teams fails here too.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));

let checks = 0, failures = 0;
function ok(cond, what) {
  checks++;
  if (cond) return;
  failures++;
  console.error('  FAIL: ' + what);
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }

/* ---- RUN THE APP'S OWN MODULE, not a copy of its functions ---------------
   This suite used to pull each function out of app.html by name and run the
   text in a flat sandbox. That sandbox passed every check here on builders
   that were unreachable in a browser, because nothing had exported them —
   see tools/football/brief_wiring.test.js for the whole story. It now boots
   the REAL IIFE through the shared harness and reaches the builders through
   `window`, exactly as the brief layer does. The handful of names below the
   export surface (the field map, the row list, the score split) come back on
   __FBTEST, a probe the harness appends INSIDE the module for tests only. */
const M = require('./_module.js');
const BOOT = M.boot({ probe: ['FBRK_TABS', 'FBRK_FIELD', 'FB_BRIEF_ROWS', 'FB_BRIEF_RK_CELLS', 'FB_BR_GROUPS',
  'fbBrNorm', 'fbBrTeam', 'fbBrCell', 'fbBrGaps', 'fbBrPct', 'fbBrDelta', 'fbBrStateNote', 'fbBrWhyPhrase',
  'fbRkVal', 'fbRkCatMove', 'fbRkN', 'fbRkPts', 'fbRkPct', 'fbGxScore', 'fbP4StatusFor', 'fbP4Line', 'fbPts'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const box = Object.assign({}, BOOT.win.__FBTEST);
box.fbBriefResearch = BOOT.win.fbBriefResearch;
box.fbBriefGame = BOOT.win.fbBriefGame;
box.fbBriefRankings = BOOT.win.fbBriefRankings;
box.FB = BOOT.win.FB;
box.FB.rk.data = CUR;

/* ═══ 1. a price that is not on file is never printed ═════════════════════ */
section('1. the lede can never print a price that is not on file');
function unpriced(home, away) {
  return P.simpleFromPacket({
    game: { matchup: away + ' @ ' + home, sport: 'CFB', sport_key: 'americanfootball_ncaaf', commence: '2026-09-12T19:30:00Z', away: away, home: home, event_id: 'test' },
    market: null, prices: {}, edge: {}, confirmation: {}, timing: {}, price_sensitivity: {},
    deterministic: { verdict: 'PASS', display_verdict: 'WAIT', is_wait: true, wait_reason: 'no priced market on file', reasons_for: [], reasons_against: [], falsifiers: [] }
  }, { stale_limit_min: 120 });
}
const BAD = /\b(null|undefined|NaN)\b/;
['BET', 'LEAN', 'WAIT', 'PASS'].forEach(function (v) {
  const card = unpriced('Texas Tech', 'Utah');
  card.verdict = v; card.available = true; card.odds = null;
  const brief = P.snapshot({ cards: [card], report_type: 'GAME', preset: 'CFB' }).public.cards[0].brief;
  ok(!BAD.test(brief.lede), v + ' with no odds does not print a stringified null in the lede — got: ' + brief.lede);
  ok(brief.lede.indexOf(' at null') < 0, v + ' does not read "at null"');
});
(function () {
  const card = unpriced('Texas Tech', 'Utah');
  card.verdict = 'BET'; card.available = true; card.odds = '-110';
  const brief = P.snapshot({ cards: [card], report_type: 'GAME', preset: 'CFB' }).public.cards[0].brief;
  ok(brief.lede.indexOf('-110') >= 0, 'a price that IS on file still appears in the lede');
})();

/* ═══ 2. a projected score never has a negative side ═════════════════════ */
section('2. a projected score is never published with a negative side');
eq(box.fbGxScore({ fair_total: 45, fair_spread: 7 }).home, 26, 'a normal projection splits into two whole numbers');
eq(box.fbGxScore({ fair_total: 45, fair_spread: 7 }).away, 19, 'and the two sides sum back to the total');
eq(box.fbGxScore({ fair_total: 24, fair_spread: 50 }), null, 'a margin wider than the total yields NO score rather than a negative side');
eq(box.fbGxScore({ fair_total: null, fair_spread: 7 }), null, 'no total means no score line');
eq(box.fbGxScore({ fair_total: 45, fair_spread: null }), null, 'no margin means no score line');

/* ═══ 3. the research block refuses stringified nothing ══════════════════ */
section('3. the research block refuses stringified null/undefined/NaN');
(function () {
  const r = P.researchBlock({
    headline: 'null', state: { label: 'undefined', note: 'NaN' },
    score: { home: { team: 'A', points: null }, away: { team: 'B', points: '10' } },
    table: { cols: ['B', 'A'], rows: [{ k: 'ETSR', a: 'null', h: '+5.8' }, { k: null, a: '1', h: '2' }] },
    notes: ['null', 'a real note'], missing: ['undefined']
  });
  eq(r.headline, null, 'the string "null" is not a headline');
  eq(r.state, null, 'a state whose label is "undefined" is dropped whole');
  eq(r.score, null, 'a score missing one side is not published as half a score');
  eq(r.table.rows.length, 1, 'a row with no label is dropped');
  eq(r.table.rows[0].a, null, 'the string "null" in a cell becomes an absent cell');
  eq(r.notes.length, 1, 'only the real note survives');
  eq(r.missing.length, 0, 'and "undefined" is not a reason');
  const html = P.researchHTML(r);
  ok(html.indexOf('not measured') >= 0, 'an absent cell renders as "not measured"');
  ok(!BAD.test(html.replace(/edb-nodata/g, '')), 'nothing stringified reaches the page');
})();
eq(P.researchBlock(null), null, 'no research means no section at all');
eq(P.rankingsBlock({ rows: [] }), null, 'an empty rankings payload renders nothing rather than an empty table');

/* ═══ 4. the brief's ratings ARE the board's ratings ═════════════════════ */
section('4. the game brief reads the board, and cannot disagree with it');
const RES = box.fbBriefResearch({ home: 'Texas Tech', away: 'Utah' });
ok(!!RES, 'a research block is produced for two rated FBS teams');
ok(RES.table.rows.length >= box.FB_BRIEF_ROWS.length, 'every ranked category the board carries appears as a row');
(function () {
  const tt = CUR.teams.texastech, ut = CUR.teams.utah;
  ok(!!tt && !!ut, 'both teams resolve out of the committed artifact');
  box.FB_BRIEF_ROWS.forEach(function (c) {
    const row = RES.table.rows.filter(function (r) { return r.k === c[1]; })[0];
    if (!row) { ok(false, 'row missing for ' + c[1]); return; }
    [[tt, 'h'], [ut, 'a']].forEach(function (pair) {
      const t = pair[0], side = pair[1];
      const v = box.fbRkVal(t, c[0]);
      if (v == null) { eq(row[side], null, c[1] + ': an unrated category is absent, not zero, not the league mean'); return; }
      const want = (c[0] === 'overall' ? box.fbRkPts(v) : box.fbRkN(v));
      ok(String(row[side]).indexOf(want) === 0, c[1] + ' prints the board\'s own value (' + want + ')');
      const rk = t.ranks && t.ranks[c[0]];
      if (rk && rk.rank != null) ok(String(row[side]).indexOf('#' + rk.rank) >= 0, c[1] + ' carries the board\'s own national rank');
    });
  });
})();
ok(RES.table.rows.some(function (r) { return r.k === 'Special teams'; }), 'special teams is a row like any other');
ok(RES.table.rows.some(function (r) { return r.k === 'Confidence'; }), 'confidence travels with the ratings');
ok(RES.source.indexOf('football/rankings/current.json') >= 0, 'the brief names the artifact every number came from');
ok(!BAD.test(P.researchHTML(P.researchBlock(RES)).replace(/edb-nodata/g, '')),
  'no stringified nothing reaches the rendered research section');

/* ═══ 5. an unrated side is named, never invented ════════════════════════ */
section('5. a team EdgeDesk does not rate is named, not filled in');
(function () {
  const r = box.fbBriefResearch({ home: 'Miami', away: 'Florida A&M' });
  ok(!!r, 'a half-rated matchup still produces a brief');
  const etsr = r.table.rows.filter(function (x) { return x.k === 'ETSR (overall)'; })[0];
  eq(etsr.a, null, 'the unrated side has no ETSR cell');
  ok(etsr.h != null, 'the rated side keeps its ETSR');
  ok(r.missing.some(function (m) { return m.indexOf('Florida A&M') === 0 && m.indexOf('not one of the') > 0; }),
    'the missing list names the team and says why it has no rating');
  ok(!BAD.test(P.researchHTML(P.researchBlock(r))), 'and the rendered page carries no stringified nothing');
})();
(function () {
  const smu = CUR.teams.smu;
  if (!smu) { ok(false, 'SMU is on the board'); return; }
  const r = box.fbBriefResearch({ home: 'SMU', away: 'Miami' });
  const off = r.table.rows.filter(function (x) { return x.k === 'Offense'; })[0];
  if (box.fbRkVal(smu, 'offense') == null) {
    eq(off.h, null, 'SMU\'s unpublished offense is absent rather than a stand-in number');
    ok(r.missing.some(function (m) { return m.indexOf('SMU') === 0 && m.indexOf('offense') > 0; }),
      'and the build\'s own reason for it is carried to the writer');
  } else ok(true, 'SMU has an offense rating this build; nothing to assert');
})();

/* ═══ 6. the rankings brief ══════════════════════════════════════════════ */
section('6. the rankings brief is the artifact, laid out');
const RK = box.fbBriefRankings({ top: 25 });
ok(!!RK, 'a rankings payload is produced');
eq(RK.rows.length, 25, 'a Top 25 has 25 rows');
(function () {
  const order = CUR;
  let prev = 0, monotone = true;
  RK.rows.forEach(function (r) { const n = +String(r.rank).replace('#', ''); if (n <= prev) monotone = false; prev = n; });
  ok(monotone, 'the rows are in the artifact\'s own rank order, ascending');
  const first = RK.rows[0];
  const topTeam = Object.keys(order.teams).map(function (k) { return order.teams[k]; })
    .filter(function (t) { return t.rank === 1; })[0];
  eq(first.team, topTeam.team, '#1 on the brief is #1 in the artifact');
  eq(first.cells[0].v, box.fbRkPts(topTeam.etsr), 'and carries the artifact\'s own ETSR');
})();
eq(RK.columns.length, RK.rows[0].cells.length + 3, 'every column has a cell under it (plus #, TEAM and the weekly delta)');
ok(RK.columns.indexOf('SPECIAL TEAMS') >= 0, 'special teams is a column on the printed board');
(function () {
  const printed = {}; RK.rows.forEach(function (r) { printed[r.team] = 1; });
  RK.movers.forEach(function (m) {
    if (!m.h) return;
    const names = String(m.p).split(' · ').map(function (x) { return x.replace(/ [+-]?\d+ to #\d+.*$/, '').trim(); });
    names.forEach(function (n) { ok(printed[n] === 1, 'mover "' + n + '" is inside the printed Top 25'); });
  });
  ok(RK.movers.some(function (m) { return !m.h && String(m.p).indexOf('Top 25') >= 0; }),
    'and the page states the bound it measured movement inside');
})();
(function () {
  const ranked = {}; box.FBRK_TABS.forEach(function (t) { ranked[t[1].toLowerCase()] = 1; ranked[t[0]] = 1; });
  RK.missing.forEach(function (m) {
    ok(m.indexOf('Availability:') !== 0 && m.indexOf('EDGE:') !== 0,
      'the coverage list does not report on categories the board never ranks — got: ' + m.slice(0, 40));
  });
  ok(RK.missing.some(function (m) { return m.indexOf('Special teams:') === 0; }), 'special-teams coverage is reported by name');
})();
ok(RK.method.length >= 3, 'the method section is present');
ok(RK.method.every(function (m) { return (CUR.notes || []).indexOf(m.p) >= 0; }),
  'and every line of it is the artifact\'s own statement of method, verbatim');
ok(RK.footer.some(function (f) { return /independent of the AP and Coaches polls/.test(f); }),
  'the page says on its face that no poll is an input');
ok(RK.spotlights.length >= 1, 'at least one team is explained');
ok(RK.spotlights[RK.spotlights.length - 1].h.indexOf('chosen') > 0, 'and the selection rule is printed with them');
ok(!BAD.test(P.rankingsHTML(P.rankingsBlock(RK)).replace(/edb-nodata/g, '')),
  'no stringified nothing reaches the rendered rankings table');

/* ═══ 7. it renders, and it renders clean ════════════════════════════════ */
section('7. both briefs render without a hole in them');
(function () {
  const snapR = P.snapshot({ cards: [], report_type: 'RANKINGS', preset: 'RANKINGS', rankings: RK });
  eq(snapR.report_type, 'RANKINGS', 'a rankings snapshot keeps its own report type');
  ok(!!snapR.public.rankings, 'and carries the payload into the public half');
  const html = P.briefHTML(snapR);
  ok(html.indexOf('EdgeDesk data check') < 0, 'a rankings brief does not claim to have checked a price');
  ok(html.indexOf('How EdgeDesk ranks teams') >= 0, 'the method section reaches the page');
  ok(!BAD.test(html.replace(/edb-nodata/g, '')), 'no stringified nothing in the rendered rankings brief');
  const text = P.briefText(snapR);
  ok(text.indexOf('POWERED BY') < 0 && text.indexOf('Powered by EdgeDesk Sports') >= 0, 'the plain-text version ends properly');
  ok(!BAD.test(text), 'no stringified nothing in the plain-text rankings brief');
  ok(P.briefCmsHTML(snapR).indexOf('<table>') >= 0, 'the CMS paste carries a real table');
})();
(function () {
  const card = unpriced('Texas Tech', 'Utah');
  const snapG = P.snapshot({ cards: [card], report_type: 'GAME', preset: 'CFB', research: RES });
  const html = P.briefHTML(snapG);
  ok(html.indexOf('The EdgeDesk research') >= 0, 'the research section reaches the game page');
  ok(html.indexOf('class="edb-pick') < 0,
    'and the empty market card is collapsed rather than printed as six headings saying "no price"');
  ok(html.indexOf('edb-nomkt') >= 0, 'the collapsed form is one labelled paragraph, not a silent omission');
  ok(html.indexOf('no price to compare') >= 0, 'one sentence says what the market situation is');
  ok(!BAD.test(html.replace(/edb-nodata/g, '')), 'no stringified nothing in the rendered game brief');
  ok(P.briefText(snapG).indexOf('THE EDGEDESK RESEARCH') >= 0, 'the plain-text version carries it too');
})();

/* ═══ 8. the buttons exist and are wired ═════════════════════════════════ */
section('8. there is a button, and it reaches the brief');
ok(/function fbRkBriefBar\(/.test(APP), 'the rankings screen has a publish bar');
ok(APP.indexOf("EDBRIEF.openRankings(25)") > 0, 'and its main button opens the week\'s rankings brief');
ok(APP.indexOf('openRankings:openRankings') > 0, 'openRankings is exported on EDBRIEF');
ok(/h\+=fbRkBriefBar\(D\);/.test(APP), 'the bar is actually painted into the rankings view');
ok(APP.indexOf('EDBRIEF.openRankings(25)">CFB rankings brief') > 0, 'and it is on the publisher desk too');
ok(APP.indexOf('research:researchFor(q, first)') > 0, 'every game snapshot is offered the research');
ok(/onclick="EDBRIEF\.print\(\)"/.test(APP), 'the print button is still there for both');
(function () {
  const a = APP.slice(APP.indexOf('/*__EDB_CSS_START__*/'), APP.indexOf('/*__EDB_CSS_END__*/'));
  const b = fs.readFileSync(path.join(ROOT, 'brief.html'), 'utf8');
  const bb = b.slice(b.indexOf('/*__EDB_CSS_START__*/'), b.indexOf('/*__EDB_CSS_END__*/'));
  eq(a === bb, true, 'the brief CSS is identical in app.html and brief.html');
  ok(a.indexOf('.edb-tblwrap{display:contents}') > 0, 'and a printed table is not a scroll container');
})();

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);
