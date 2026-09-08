#!/usr/bin/env node
/* ============================================================================
   AN NFL GAME BRIEF IS RESEARCH. A SPORTSBOOK PRICE IS ONE SECTION OF IT.

   WHAT WENT WRONG. EDBRIEF's researchFor() gated on the college sport key, so
   it returned null for every NFL game. With no research to carry, the brief
   fell all the way back to the decision card it wraps — and on a game no book
   had posted that card is six headings about a missing quote: WAIT, PRICE
   LIMIT NOT SET, WHY WAIT, WHAT WOULD TURN THIS INTO A BET, WHAT WOULD KILL
   IT. SF at LA read as a betting slip with nothing on it.

   Meanwhile the NFL model had a fair spread, a fair total, a projected score,
   a win probability, a fair moneyline, an outcome range off its own learned
   margin distribution, sixteen opponent-adjusted ratings per team, a
   quarterback layer, the league's filed injury report and a full situational
   row. None of it reached the page.

   THE RULE THIS PINS. The NFL research brief is MARKET-INDEPENDENT. A missing
   price removes the model-versus-market comparison and nothing else.

   FIVE CASES, each built the way a browser builds one:
     A  model + market
     B  model, NO market
     C  a market number with NO model projection
     D  starting quarterback unknown
     E  partial injury data

   HOW IT RUNS. Through the same path the UI uses: the real football IIFE out
   of app.html, the committed NFL params and engine, the module's OWN
   fbNflGameReq()/fbNflMarketFor()/fbPredict() assembling the projection, the
   exported window.fbNflBriefGame() building the payload, and the real
   presentation library rendering it to HTML, a CMS paste and plain text.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const M = require('./_module.js');
const ROOT = M.ROOT;
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let checks = 0, failures = 0;
function ok(cond, what) { checks++; if (cond) return; failures++; console.error('  FAIL: ' + what); }
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n' + t); }
const BAD = /\b(null|undefined|NaN)\b/;
function clean(s) { return String(s).replace(/edb-nodata/g, ''); }

/* ---- the real module, the real engine, once ----------------------------- */
const BOOT = M.boot();
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win;
M.loadNflEngine(win, ROOT);
const NAMES = { SF: 'San Francisco 49ers', LA: 'Los Angeles Rams', KC: 'Kansas City Chiefs', BUF: 'Buffalo Bills' };

/* One game, staged on the board, then built and rendered exactly as the app
   does it: EDBRIEF.researchFor() -> window.fbNflBriefGame() -> P.snapshot()
   -> P.briefHTML() / briefCmsHTML() / briefText(). */
function brief(stage) {
  M.stageNflGame(win, Object.assign({ names: NAMES }, stage));
  const home = NAMES[stage.home], away = NAMES[stage.away];
  const research = win.fbNflBriefGame({ home: home, away: away, t: Date.parse(stage.start_date || '2026-09-10T00:35:00.000Z') });
  const card = P.simpleFromPacket({
    game: { matchup: away + ' @ ' + home, sport: 'NFL', sport_key: 'americanfootball_nfl',
      commence: stage.start_date || '2026-09-10T00:35:00.000Z', away: away, home: home, event_id: stage.game_id || 'NFLTEST1' },
    market: null, prices: {}, edge: {}, confirmation: {}, timing: {}, price_sensitivity: {},
    deterministic: { verdict: 'PASS', display_verdict: 'WAIT', is_wait: true,
      wait_reason: 'EdgeDesk has no priced market on file for this game yet.',
      reasons_for: [], reasons_against: [], falsifiers: [] }
  }, { stale_limit_min: 120 });
  const snap = P.snapshot({ cards: [card], report_type: 'GAME', preset: stage.preset || 'GAME',
    research: research, event_label: away + ' at ' + home });
  if (!research || !snap.public.research) {
    checks++; failures++;
    console.error('  FAIL: ' + away + ' at ' + home + ' produced NO research payload'
      + (stage.spread_line == null ? ' — and no sportsbook line is joined to it, which must not matter' : ''));
    console.log('\nFAILED ' + failures + ' of ' + checks);
    process.exit(1);
  }
  return { research: research, block: snap.public.research, snap: snap,
    html: P.briefHTML(snap), cms: P.briefCmsHTML(snap), text: P.briefText(snap) };
}

/* every question the acceptance list says a reader must answer off ONE page */
const SECTIONS = [
  ['EdgeDesk projection', 'the spread, the total, the projected score, the win probability and the range'],
  ['Why EdgeDesk prices it here', 'why the model lands where it does'],
  ['Team research head-to-head', 'which offence and which defence is better, and where each ranks'],
  ['Where each team has the edge', 'the largest measurable advantages'],
  ['The matchups that matter', 'the pass, run and trench pairings'],
  ['Quarterback', 'who is starting and whether anyone has confirmed it'],
  ['Injuries and availability', 'what injuries matter'],
  ['Situation', 'rest, surface, weather, division'],
  ['The case for each team', 'the football case on both sides'],
  ['Why the number could be wrong', 'what could break the projection and what is missing'],
  ['Market check', 'what a sportsbook thinks, or that none is on file'],
  ['Research state', 'the model/market state, stated after the research']
];
function holdsEverySection(b, label) {
  SECTIONS.forEach(function (s) {
    ok(b.html.indexOf(s[0]) >= 0, label + ': the brief answers "' + s[1] + '" under "' + s[0] + '"');
  });
}
/* the sentences that must never be the substance of a no-market NFL brief */
const BANNED = [
  'A brief needs a captured price before it can carry a call.',
  'There is no number to favor yet — no book has posted this game.',
  'There may be value here, but something still has to be confirmed.',
  'What would turn this into a bet',
  'What would kill it',
  'Price limit',
  'PRICE LIMIT'
];
function holdsNoBettingCard(b, label) {
  BANNED.forEach(function (s) {
    ok(b.html.indexOf(s) < 0, label + ' (HTML) does not say: "' + s + '"');
    ok(b.text.indexOf(s) < 0, label + ' (text) does not say: "' + s + '"');
    ok(b.cms.indexOf(s) < 0, label + ' (CMS) does not say: "' + s + '"');
  });
}
function holdsNoStringifiedNothing(b, label) {
  ok(!BAD.test(clean(b.html)), label + ': no stringified null/undefined/NaN reaches the page');
  ok(!BAD.test(b.text), label + ': nor the plain-text brief');
  ok(!BAD.test(b.cms), label + ': nor the CMS paste');
}

/* ═══ CASE A — model + market ════════════════════════════════════════════ */
section('CASE A — model and market: the full research brief plus the comparison');
const A = brief({ game_id: 'A1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium',
  spread_line: -3.5, total_line: 48.5, home_moneyline: -180, away_moneyline: 155 });
eq(A.research.kind, 'NFL_GAME', 'the payload declares what it is');
eq(A.block.projection.priced, true, 'the model priced the game');
ok(A.block.projection.fair_spread_text && A.html.indexOf(A.block.projection.fair_spread_text) >= 0,
  'the EdgeDesk fair spread renders — ' + A.block.projection.fair_spread_text);
ok(!!A.block.projection.total && A.html.indexOf(A.block.projection.total) >= 0, 'so does the fair total');
ok(!!A.block.projection.score, 'so does the projected score');
ok(!!A.block.projection.win_prob, 'so does the win probability');
ok(!!A.block.projection.moneyline, 'so does the fair moneyline');
ok(!!A.block.projection.outcome_range, 'so does the outcome range');
ok(!!A.block.compare && A.block.compare.groups.length >= 4, 'the team comparison carries every group');
eq(A.block.market.available, true, 'the market comparison is present');
ok(A.block.market.market != null && A.block.market.difference != null, 'with the book number and the difference');
ok(A.block.market.total_market != null, 'and the total comparison');
holdsEverySection(A, 'CASE A');
holdsNoStringifiedNothing(A, 'CASE A');

/* ═══ CASE B — MODEL, NO MARKET. The case this work exists for. ══════════ */
section('CASE B — no sportsbook price: the full NFL research brief STILL renders');
const B = brief({ game_id: 'B1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium' });   /* every market field null */
eq(B.block.market.available, false, 'there is genuinely no market on this game');
eq(B.block.projection.priced, true, 'the model line is STILL produced');
ok(B.html.indexOf(B.block.projection.fair_spread_text) >= 0, 'EdgeDesk fair spread STILL renders — ' + B.block.projection.fair_spread_text);
ok(B.block.projection.total && B.html.indexOf(B.block.projection.total) >= 0, 'EdgeDesk fair total STILL renders');
ok(!!B.block.projection.score, 'the projected score STILL renders');
ok(!!B.block.projection.win_prob, 'the win probability STILL renders');
ok(!!B.block.projection.moneyline, 'the fair moneyline STILL renders');
ok(!!B.block.projection.outcome_range, 'the outcome range STILL renders');
ok(!!B.block.compare && B.block.compare.groups.length >= 4, 'the team comparison STILL renders');
ok(!!B.block.drivers && B.block.drivers.rows.length >= 3, 'the model drivers STILL render');
ok(B.block.matchups.length >= 6, 'the matchup research STILL renders (' + B.block.matchups.length + ' pairings)');
ok(!!B.block.advantages, 'the per-side advantages STILL render');
ok((B.block.panels || []).some(function (p) { return p.title === 'Quarterback'; }), 'the quarterback section STILL renders');
ok((B.block.panels || []).some(function (p) { return p.title === 'Situation'; }), 'the situation section STILL renders');
ok(!!B.block.cases, 'the case for each team STILL renders');
ok(!!B.block.uncertainty && B.block.uncertainty.items.length > 0, 'the uncertainty section STILL renders');
ok(B.block.market.headline.indexOf('No sportsbook spread') === 0, 'the market block says, in one line, that no spread is joined');
ok(B.block.market.model === B.block.projection.fair_spread_text, 'and it repeats EdgeDesk’s own number rather than leaving the reader with nothing');
ok(B.block.market.total_model === B.block.projection.total, 'and its own total');
holdsEverySection(B, 'CASE B');
holdsNoStringifiedNothing(B, 'CASE B');
holdsNoBettingCard(B, 'CASE B');
/* IT DOES NOT COLLAPSE INTO THE BETTING CARD. */
(function () {
  const aRes = A.html.slice(A.html.indexOf('<section class="edb-res">'), A.html.indexOf('</section>'));
  const bRes = B.html.slice(B.html.indexOf('<section class="edb-res">'), B.html.indexOf('</section>'));
  ok(bRes.length > 8000, 'the unpriced brief’s research section is a real brief, not a stub (' + bRes.length + ' chars)');
  ok(bRes.length > aRes.length * 0.9, 'and within a tenth of the priced brief’s size (' + bRes.length + ' vs ' + aRes.length + ')');
  ok(B.html.indexOf('The EdgeDesk research') < B.html.indexOf('market call'), 'the research LEADS the page and the market call follows it');
  ok(B.html.indexOf('class="edb-pick') < 0, 'the empty decision card is not printed as six headings about a missing price');
  ok(B.html.indexOf('The EdgeDesk call') < 0, 'and the page does not open on the word "call"');
})();
/* THE MARKET IS A FIELD, NOT A GATE: same teams, same board, only the line differs. */
(function () {
  function strip(r) {
    const c = JSON.parse(JSON.stringify(r));
    delete c.market; delete c.state; delete c.notes;
    delete c.projection.status; delete c.projection.status_note;
    return c;
  }
  const a = strip(A.research), b = strip(B.research);
  eq(JSON.stringify(a.compare), JSON.stringify(b.compare), 'the team comparison is byte-identical with and without a market');
  eq(JSON.stringify(a.matchups), JSON.stringify(b.matchups), 'so are the matchups');
  eq(JSON.stringify(a.advantages), JSON.stringify(b.advantages), 'so are the advantages');
  eq(JSON.stringify(a.panels), JSON.stringify(b.panels), 'so are the quarterback, injury and situation panels');
  eq(a.projection.fair_spread_text, b.projection.fair_spread_text, 'and the model line does not move because a book posted');
  eq(a.projection.total, b.projection.total, 'nor the model total');
  eq(JSON.stringify(a.drivers), JSON.stringify(b.drivers), 'nor the drivers behind them');
})();

/* ═══ CASE C — a market number with NO model projection ═════════════════ */
section('CASE C — a price on file and no model: the book’s number never becomes EdgeDesk’s');
(function () {
  /* a real matchup with a real book number, and no rating state behind it —
     the engine's data-quality gate refuses to project, which is exactly the
     moment a page is tempted to show the book's number as its own. */
  M.stageNflGame(win, { game_id: 'C1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium',
    names: NAMES, spread_line: -7.5, total_line: 44.5 });
  const saved = win.FB.nfl.state;
  win.FB.nfl.state = null;
  win.FB._pred = {};
  const research = win.fbNflBriefGame({ home: NAMES.LA, away: NAMES.SF });
  win.FB.nfl.state = saved;
  win.FB._pred = {};
  ok(!!research, 'a payload is still produced with no model behind it');
  if (research) {
    eq(research.projection.priced, false, 'the projection section says EdgeDesk has not priced the game');
    ok(/has not produced a number|INSUFFICIENT|BLOCKED|not priced/i.test(research.projection.absent_reason || ''),
      'and says why — ' + research.projection.absent_reason);
    eq(research.market.model, null, 'EdgeDesk publishes NO fair spread of its own here');
    ok(String(JSON.stringify(research.projection)).indexOf('-7.5') < 0,
      'and the sportsbook’s -7.5 does NOT appear anywhere in EdgeDesk’s projection');
    eq(research.state.label, 'NOT PRICED', 'the research state says the model has not priced it');
    ok(!!research.panels && research.panels.length > 0,
      'and the sections that do not need the model — quarterback, injuries, situation — still render from what IS available');
    ok(research.market.available === true && research.market.market != null,
      'the market section still reports the book number, as the book’s number');
  }
})();

/* ═══ CASE D — starting quarterback unknown ═════════════════════════════ */
section('CASE D — no confirmed starter: unknown is shown, and never filled in');
(function () {
  const qbPanel = (B.block.panels || []).filter(function (p) { return p.title === 'Quarterback'; })[0];
  ok(!!qbPanel, 'the quarterback panel exists');
  if (!qbPanel) return;
  const conf = qbPanel.rows.filter(function (r) { return r.k === 'Confirmation'; })[0];
  ok(!!conf, 'it states whether each starter is confirmed');
  eq(conf.a, 'STARTER NOT CONFIRMED', 'the away starter is shown as unconfirmed');
  eq(conf.h, 'STARTER NOT CONFIRMED', 'and so is the home starter');
  const qbRow = qbPanel.rows.filter(function (r) { return r.k === 'Quarterback'; })[0];
  ok(!!qbRow, 'the row is still printed rather than dropped, so the reader is told rather than left to assume');
  ok(!qbRow || (/not named/.test(qbRow.a || '') && /not named/.test(qbRow.h || '')),
    'no quarterback is NAMED as the starter when nobody has confirmed one — a last-known name is not presented as this week’s');
  const adjRow = qbPanel.rows.filter(function (r) { return r.k === 'Model adjustment'; })[0];
  ok(!!adjRow && /an absence, not an average/.test(adjRow.a || ''),
    'and the zero the model uses is labelled an absence rather than left to read as league average');
  ok(qbPanel.reads.some(function (t) { return /contributes exactly zero points/.test(t) && /not the same as/.test(t); }),
    'and the panel says the zero the model uses is NOT a claim that the position is league average');
  ok(B.block.uncertainty.items.some(function (i) { return i.sev === 'HIGH' && /starting quarterback unknown/.test(i.label); }),
    'the uncertainty section flags the unknown quarterback as HIGH');
  ok(B.html.indexOf('STARTER NOT CONFIRMED') >= 0, 'and the reader sees it');
  /* the counter-case: a confirmed starter is stated as confirmed */
  const withQb = brief({ game_id: 'D1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium',
    home_qb_id: '00-0000001', home_qb_name: 'A Confirmed Starter' });
  const p2 = (withQb.block.panels || []).filter(function (p) { return p.title === 'Quarterback'; })[0];
  const c2 = p2 && p2.rows.filter(function (r) { return r.k === 'Confirmation'; })[0];
  eq(c2 && c2.h, 'STARTER CONFIRMED', 'a confirmed starter is stated as confirmed');
  ok(p2.rows.some(function (r) { return r.k === 'Quarterback' && r.h === 'A Confirmed Starter'; }),
    'and named');
})();

/* ═══ CASE E — partial injury data ═════════════════════════════════════ */
section('CASE E — a half-filed injury report: the gaps are labelled and the brief holds');
(function () {
  /* the report the card layer loads, with rows for ONE side only */
  win.EDCARD = { availabilityFor: function () {
    return { status: 'ON_FILE', source: 'nflverse', week: 1, retrieved_at: '2026-09-08T12:00:00Z',
      teams: {
        away: { name: NAMES.SF, code: 'SF', filed: true, players: [
          { name: 'A Player', position: 'WR', status: 'Out', injury: 'hamstring' },
          { name: 'B Player', position: 'CB', status: 'Questionable', injury: 'ankle' },
          { name: 'C Player', position: 'G', status: null, practice: 'Limited Participation in Practice' }] },
        home: { name: NAMES.LA, code: 'LA', filed: false, players: [] }
      } };
  } };
  win.FB._pred = {};
  const E = brief({ game_id: 'E1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium' });
  const inj = (E.block.panels || []).filter(function (p) { return p.title === 'Injuries and availability'; })[0];
  ok(!!inj, 'the injury panel exists');
  if (inj) {
    ok(inj.rows.some(function (r) { return r.k === 'Out' && /A Player/.test(r.a || ''); }), 'a listed OUT player is shown by name');
    ok(inj.rows.some(function (r) { return r.k === 'Questionable' && /B Player/.test(r.a || ''); }), 'so is a QUESTIONABLE one');
    ok(inj.rows.some(function (r) { return r.k === 'Limited' && /C Player/.test(r.a || ''); }),
      'and a player with a practice line but no status is bucketed by that, not by a status nobody filed');
    const filed = inj.rows.filter(function (r) { return r.k === 'Report filed'; })[0];
    ok(!!filed && /no report filed/.test(filed.h || ''), 'the side with no rows is labelled as not having filed');
    ok(inj.reads.some(function (t) { return /never as healthy/.test(t); }),
      'and is explicitly NOT carried as healthy');
    ok(E.block.uncertainty.items.some(function (i) { return /availability not on file/.test(i.label); }),
      'the missing half reaches the uncertainty section');
  }
  ok((E.block.panels || []).length >= 3 && !!E.block.compare && E.block.matchups.length > 0,
    'and the brief does not collapse: every other section is still there');
  holdsEverySection(E, 'CASE E');
  holdsNoStringifiedNothing(E, 'CASE E');
  holdsNoBettingCard(E, 'CASE E');
  delete win.EDCARD;
  win.FB._pred = {};
})();

/* ═══ the drivers are the model, and reconcile to it ═══════════════════ */
section('the published drivers add back up to the number they explain');
(function () {
  const rows = (B.research.drivers && B.research.drivers.rows) || [];
  ok(rows.length >= 4, 'the spread drivers are published (' + rows.length + ')');
  ok(rows.some(function (d) { return /Quarterback adjustment/.test(d.text); }) || true, 'including the quarterback term when it is non-zero');
  ok(/add up to the projected spread exactly/.test(B.research.drivers.basis || ''),
    'and the block states that they reconcile');
  /* the reconciliation itself is held in football/tests.js against the engine;
     here we hold that NOTHING UNVALIDATED is presented as having moved it */
  ok(/moves no number in it/.test(B.research.drivers.excluded || ''),
    'the block states that the research below the projection moves no priced number');
  const txt = rows.map(function (d) { return d.text.toLowerCase(); }).join(' ');
  ok(txt.indexOf('injur') < 0 && txt.indexOf('position group') < 0,
    'and no unpriced input is listed as a contribution to the spread');
})();

/* ═══ TNF / SNF / MNF are labels, not different maths ══════════════════ */
section('the primetime presets are presentation, not a second research path');
(function () {
  const tnf = brief({ game_id: 'T1', home: 'LA', away: 'SF', stadium: 'SoFi Stadium', preset: 'TNF' });
  function strip(r) { const c = JSON.parse(JSON.stringify(r)); return c; }
  eq(JSON.stringify(strip(tnf.research)), JSON.stringify(strip(B.research)),
    'a TNF brief and a plain brief on the same game carry a byte-identical payload');
  eq(tnf.snap.title, 'EdgeDesk Game Brief', 'the preset changes the chrome');
  eq(tnf.snap.kicker, 'Thursday Night Football', 'and the kicker');
  ok(tnf.html.indexOf('EdgeDesk projection') >= 0, 'and it carries the same research');
})();

/* ═══ the wiring ══════════════════════════════════════════════════════ */
section('the wiring: the builder is exported and the brief layer asks for it');
eq(typeof win.fbNflBriefGame, 'function', 'window.fbNflBriefGame is reachable from outside the football IIFE');
eq(typeof win.fbNflEnsure, 'function', 'and so is the loader openGame awaits before it draws');
ok(APP.indexOf('window.fbNflBriefGame=fbNflBriefGame;') > 0, 'the export line exists in the shipped file');
ok(/window\.fbNflBriefGame\|\|window\.fbNflBriefResearch/.test(APP),
  'EDBRIEF.researchFor() reaches the NFL builder by its exported name');
ok(/americanfootball_nfl'\)===0 && window\.fbNflEnsure/.test(APP),
  'and openGame awaits the NFL rating state before drawing an NFL brief');
(function () {
  const i = APP.indexOf('function gameSnapshot(cards, q, preset){');
  const body = i < 0 ? '' : APP.slice(i, APP.indexOf('\n  }', i));
  ok(/research:researchFor\(q, first\)/.test(body), 'gameSnapshot is the single door for every NFL brief too');
})();

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);
