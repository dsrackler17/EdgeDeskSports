#!/usr/bin/env node
/* ============================================================================
   A CFB GAME BRIEF IS RESEARCH. A SPORTSBOOK PRICE IS ONE SECTION OF IT.

   WHAT WENT WRONG. Open a college game no book had posted and the brief said,
   in effect, "no sportsbook has posted a price, so EdgeDesk has no bet to
   call" — and then stopped. The projection existed. Two team ratings existed,
   with twenty-odd ranked components under each of them, position groups,
   returning production, portal churn, continuity, depth and a written reason
   for every number that was missing. None of it reached the page, because the
   page was built as a market object with research bolted underneath.

   THE RULE THIS PINS. The research brief is MARKET-INDEPENDENT. A missing
   price removes exactly one thing — the model-versus-market comparison. It
   does not remove the projection, the ratings, the roster comparison, the
   matchups, the cases or the uncertainty, and it never turns the page into
   boilerplate about a bet that was never the point.

   FOUR CASES, each built the way a browser builds one:
     A  model + market + two fully rated FBS teams
     B  model, NO market
     C  model + an FCS opponent absent from the rating set
     D  model with a spread but NO total

   HOW IT RUNS. Through the same path the UI uses, end to end. The real
   football IIFE out of app.html; the committed Power 4 params and engine; the
   module's OWN fbP4Request() assembling the projection request; the exported
   window.fbBriefGame() building the payload; and the real presentation
   library rendering it to HTML, to a CMS paste and to plain text. Nothing
   here re-implements a step of that chain — a test that built its own request
   or its own renderer would pass on wiring that does not exist, which is the
   exact failure this file was written after.
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

/* ---- boot the real module and the real engine once ---------------------- */
const BOOT = M.boot();
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win;
M.loadEngine(win, ROOT);

/* One game, staged on the board, then built and rendered exactly as the app
   does it: EDBRIEF.researchFor() -> window.fbBriefGame() -> P.snapshot() ->
   P.briefHTML() / briefCmsHTML() / briefText(). */
function brief(stage) {
  M.stageGame(win, stage);
  const research = win.fbBriefGame({ home: stage.home, away: stage.away, t: Date.parse(stage.start_date || '2026-09-19T23:30:00.000Z') });
  const card = P.simpleFromPacket({
    game: { matchup: stage.away + ' @ ' + stage.home, sport: 'CFB', sport_key: 'americanfootball_ncaaf',
      commence: stage.start_date || '2026-09-19T23:30:00.000Z', away: stage.away, home: stage.home, event_id: stage.game_id || 'TEST1' },
    market: null, prices: {}, edge: {}, confirmation: {}, timing: {}, price_sensitivity: {},
    deterministic: { verdict: 'PASS', display_verdict: 'WAIT', is_wait: true,
      wait_reason: 'EdgeDesk has no priced market on file for this game yet.',
      reasons_for: [], reasons_against: [], falsifiers: [] }
  }, { stale_limit_min: 120 });
  const snap = P.snapshot({ cards: [card], report_type: 'GAME', preset: 'CFB', research: research,
    event_label: stage.away + ' at ' + stage.home });
  /* A BRIEF THAT CAME BACK EMPTY IS THE FAILURE THIS FILE EXISTS TO CATCH, so
     it is reported as one sentence rather than left to throw twenty lines
     later on a property of null. */
  if (!research || !snap.public.research) {
    checks++; failures++;
    console.error('  FAIL: ' + stage.away + ' at ' + stage.home
      + ' produced NO research payload' + (stage.market_spread == null ? ' — and no sportsbook line is joined to it, which must not matter' : ''));
    console.log('\nFAILED ' + failures + ' of ' + checks);
    process.exit(1);
  }
  return { research: research, block: snap.public.research, snap: snap,
    html: P.briefHTML(snap), cms: P.briefCmsHTML(snap), text: P.briefText(snap) };
}

/* Every question the acceptance test says a reader must be able to answer off
   ONE screen. Each maps to a section heading the renderer emits. */
const SECTIONS = [
  ['EdgeDesk projection', 'what does EdgeDesk make the spread, how confident is it, what is the outcome range'],
  ['Team research head-to-head', 'how good is each team and where does each rank nationally'],
  ['Where each team has the edge', 'which offence, defence, QB, OL, front and secondary is better'],
  ['The matchups that matter', 'the unit-versus-unit reads'],
  ['Roster construction and continuity', 'which roster is deeper and which has more continuity'],
  ['The case for each team', 'the football case on both sides'],
  ['Why the number could be wrong', 'what could make the number wrong and what data is missing'],
  ['Market check', 'how EdgeDesk compares with a sportsbook, or that no sportsbook number exists'],
  ['Research state', 'the model/market research state, stated after the research']
];
function holdsEverySection(b, label) {
  SECTIONS.forEach(function (s) {
    ok(b.html.indexOf(s[0]) >= 0, label + ': the brief answers "' + s[1] + '" under "' + s[0] + '"');
  });
}
/* the two sentences that must never come back as the substance of a brief */
const BANNED = [
  'No sportsbook has posted a price on this game yet, so EdgeDesk has no bet to call.',
  'No live price on file yet, so there is nothing to judge.'
];
function holdsNoBannedString(b, label) {
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

/* ═══ CASE A — model + market + two fully rated FBS teams ════════════════ */
section('CASE A — a normal Power 4 game: model, market and full FBS data');
const A = brief({ game_id: 'A1', home: 'Texas Tech', away: 'Utah',
  home_conference: 'Big 12', away_conference: 'Big 12', market_spread: -6.5, market_total: 52.5 });
ok(!!A.research, 'a payload is produced');
eq(A.research.kind, 'CFB_GAME', 'and it declares what it is');
eq(A.block.projection.priced, true, 'the model priced the game');
ok(A.block.projection.fair_spread_text && /-?\d/.test(A.block.projection.fair_spread_text),
  'the EdgeDesk fair spread is a number on a team — got ' + A.block.projection.fair_spread_text);
ok(A.html.indexOf(A.block.projection.fair_spread_text) >= 0, 'and it is printed on the page');
ok(!!A.block.projection.score, 'a projected score is published when the model has a total');
ok(!!A.block.projection.win_prob && A.block.projection.win_prob.home_pct != null, 'a win probability is published');
ok(!!A.block.projection.outcome_range, 'an outcome range is published');
ok(A.block.projection.confidence_pct != null, 'a data confidence is published');
ok(!!A.block.compare && A.block.compare.groups.length >= 3, 'the team comparison carries every group');
ok(A.block.compare.groups.some(function (g) { return g.rows.some(function (r) { return r.a.v != null && r.h.v != null; }); }),
  'and both columns are filled for two rated teams');
eq(A.block.market.available, true, 'the market comparison is present');
ok(A.html.indexOf('EdgeDesk') >= 0 && A.block.market.market != null, 'with the book number beside EdgeDesk’s own');
ok(A.block.market.difference != null, 'and the difference between them');
holdsEverySection(A, 'CASE A');
holdsNoStringifiedNothing(A, 'CASE A');
holdsNoBannedString(A, 'CASE A');

/* ═══ CASE B — MODEL, NO MARKET. The case this work exists for. ══════════ */
section('CASE B — no sportsbook price: the full research brief STILL renders');
const B = brief({ game_id: 'B1', home: 'Texas Tech', away: 'Utah',
  home_conference: 'Big 12', away_conference: 'Big 12' });   /* no market_spread */
eq(B.block.market.available, false, 'there is genuinely no market on this game');
eq(B.block.projection.priced, true, 'the model line is STILL produced');
ok(B.html.indexOf(B.block.projection.fair_spread_text) >= 0,
  'and the model line is STILL printed — ' + B.block.projection.fair_spread_text);
ok(!!B.block.projection.score, 'the projected score STILL renders');
ok(!!B.block.projection.outcome_range, 'the outcome range STILL renders');
ok(B.block.projection.confidence_pct != null, 'the data confidence STILL renders');
ok(!!B.block.compare && B.block.compare.groups.length >= 3, 'the team/roster comparison STILL renders');
ok(B.block.matchups.length >= 6, 'the matchup research STILL renders (' + B.block.matchups.length + ' pairings)');
ok(!!B.block.roster && B.block.roster.rows.length >= 6, 'the roster construction STILL renders');
ok(!!B.block.cases, 'the case for each team STILL renders');
ok(!!B.block.uncertainty && B.block.uncertainty.items.length > 0, 'the uncertainty section STILL renders');
ok(!!B.block.advantages, 'the per-side advantages STILL render');
ok(B.block.market.headline.indexOf('No sportsbook spread') === 0,
  'the market block says, in one line, that no sportsbook spread is joined');
ok(B.block.market.model === B.block.projection.fair_spread_text,
  'and it repeats EdgeDesk’s own number rather than leaving the reader with nothing');
ok(/research above is still|removes the comparison and nothing else/.test(B.block.market.note),
  'and states that the absence disables the comparison only');
holdsEverySection(B, 'CASE B');
holdsNoStringifiedNothing(B, 'CASE B');
holdsNoBannedString(B, 'CASE B');
/* IT DOES NOT COLLAPSE INTO WAIT BOILERPLATE. Compare it with the priced
   brief: the research half must be the same size, not a stub. */
(function () {
  const aRes = A.html.slice(A.html.indexOf('<section class="edb-res">'), A.html.indexOf('</section>'));
  const bRes = B.html.slice(B.html.indexOf('<section class="edb-res">'), B.html.indexOf('</section>'));
  ok(bRes.length > 6000, 'the unpriced brief’s research section is a real brief, not a stub (' + bRes.length + ' chars)');
  ok(bRes.length > aRes.length * 0.9,
    'and it is within a tenth of the priced brief’s size (' + bRes.length + ' vs ' + aRes.length + ')');
  ok(B.html.indexOf('The EdgeDesk research') < B.html.indexOf('market call'),
    'the research LEADS the page and the market call follows it');
  ok(B.html.indexOf('class="edb-pick') < 0, 'the empty market card is not printed as six headings saying "no price"');
  ok(B.html.indexOf('edb-nomkt') >= 0, 'the collapsed market half is one labelled paragraph');
  ok(B.html.indexOf('no price to compare') >= 0, 'which says what the market situation actually is');
})();

/* ═══ CASE C — an FCS opponent that is not in the rating set ═════════════ */
section('CASE C — a partly rated matchup: the missing side is labelled, never invented');
const C = brief({ game_id: 'C1', home: 'Miami', away: 'Florida A&M',
  home_conference: 'ACC', away_conference: 'SWAC', away_division: 'fcs' });
eq(C.block.projection.priced, true, 'the model line still renders');
eq(C.block.compare.one_sided_team, 'Florida A&M', 'the payload names the side it cannot grade');
ok(/roster grading is unavailable in the current FBS player dataset/.test(C.block.compare.one_sided_note),
  'and says so in the words the writer prints');
ok(C.html.indexOf('roster grading is unavailable') >= 0, 'which reaches the page');
(function () {
  let rated = 0, absent = 0;
  C.block.compare.groups.forEach(function (g) {
    g.rows.forEach(function (r) {
      if (r.h.v != null) rated++;
      if (r.a.v == null) absent++;
      ok(r.a.v == null, 'Florida A&M’s ' + r.k + ' is absent rather than fabricated');
    });
  });
  ok(rated >= 15, 'every Miami metric EdgeDesk holds is still shown (' + rated + ' of them)');
  ok(absent === rated || absent > 0, 'and the unavailable ones are labelled, not hidden');
})();
ok(C.html.indexOf('not measured') >= 0 || C.html.indexOf('unavailable') >= 0,
  'an unrated cell renders as an explicit label, never as a zero or a stand-in');
ok(C.block.matchups.length > 0, 'the matchup section survives a missing opponent');
ok(C.block.matchups.some(function (m) { return !m.complete && /cannot make an apples-to-apples|cannot be scored/.test(m.read); }),
  'and a half-populated pairing produces a caveat rather than a verdict');
ok(C.block.uncertainty.unmeasured.some(function (u) { return /Florida A&M/.test(u.item); }),
  'the missing opponent is carried as an unknown, not as a zero');
eq(C.block.advantages.away.length, 0, 'no advantage is claimed for a team EdgeDesk does not rate');
eq(C.block.advantages.home.length, 0, 'and none is claimed against it either — an unrated opponent is unknown, not weak');
holdsEverySection(C, 'CASE C');
holdsNoStringifiedNothing(C, 'CASE C');
holdsNoBannedString(C, 'CASE C');

/* ═══ CASE D — a spread but no total ═════════════════════════════════════ */
section('CASE D — a spread with no total: no score line, and everything else stands');
/* Find a real game the engine prices a SIDE for and publishes no total on.
   An FCS opponent does it on this build; the search means the case keeps
   testing something if a future build changes which matchup does. */
const D = (function () {
  const tries = [
    { game_id: 'D1', home: 'Miami', away: 'Florida A&M', home_conference: 'ACC', away_conference: 'SWAC', away_division: 'fcs' },
    { game_id: 'D2', home: 'Alabama', away: 'Mercer', home_conference: 'SEC', away_conference: 'SoCon', away_division: 'fcs' },
    { game_id: 'D3', home: 'Ohio State', away: 'Youngstown State', home_conference: 'Big Ten', away_conference: 'MVFC', away_division: 'fcs' }
  ];
  for (let i = 0; i < tries.length; i++) {
    const b = brief(tries[i]);
    if (b.block.projection.priced && b.block.projection.total == null) return b;
  }
  return null;
})();
ok(!!D, 'this build produces a game the model prices a side for and no total on');
if (!D) { console.log('\n' + 'FAILED ' + failures + ' of ' + checks); process.exit(1); }
ok(D.block.projection.total == null, 'this projection genuinely has no total');
eq(D.block.projection.score, null, 'so no projected score is published');
ok(/No total published/.test(D.block.projection.score_absent_reason || ''),
  'and the reason says the side can be priced but the score cannot be split');
ok(D.html.indexOf('No total published') >= 0, 'which the reader sees');
ok(D.block.projection.fair_spread_text != null && D.html.indexOf(D.block.projection.fair_spread_text) >= 0,
  'the fair spread renders anyway');
ok(!!D.block.compare && !!D.block.roster && D.block.matchups.length > 0 && !!D.block.uncertainty,
  'and ALL other research remains visible');
/* the same guard at the source, and again at the renderer, so neither half of
   the branch can rot on a build where every real game carries a total */
eq(win.fbGxScore({ fair_total: null, fair_spread: 7 }), null, 'no total means no score split, at the source');
eq(win.fbGxScore({ fair_total: 24, fair_spread: 50 }), null, 'and a margin wider than the total publishes neither half');
(function () {
  const withTotal = JSON.parse(JSON.stringify(A.research));
  const noTotal = JSON.parse(JSON.stringify(A.research));
  noTotal.projection.total = null;
  noTotal.projection.score = null;
  noTotal.projection.score_absent_reason = 'No total published — EdgeDesk can price the side but cannot responsibly split it into a projected score.';
  const withHTML = P.researchHTML(P.researchBlock(withTotal));
  const noHTML = P.researchHTML(P.researchBlock(noTotal));
  ok(withHTML.indexOf('Projected score') >= 0 && /<b>\d+<\/b>/.test(withHTML), 'a projection WITH a total renders a score line');
  ok(noHTML.indexOf('No total published') >= 0, 'a projection WITHOUT one states why there is no score line');
  ok(noHTML.indexOf('not published') >= 0, 'and marks the score tile as not published rather than leaving it blank');
  SECTIONS.forEach(function (s) {
    if (s[0] === 'Market check' || s[0] === 'Research state') return;
    ok(noHTML.indexOf(s[0]) >= 0, 'a missing total leaves "' + s[0] + '" untouched');
  });
})();

/* ═══ the market is a FIELD, not a gate ═════════════════════════════════ */
section('the market is one field on the payload, and nothing above it reads it');
(function () {
  /* Same two teams, same board, same week: the ONLY difference between A and
     B is whether a line is joined. Every research field must be identical. */
  function stripMarkety(r) {
    const c = JSON.parse(JSON.stringify(r));
    delete c.market; delete c.state; delete c.notes;
    delete c.projection.status; delete c.projection.status_note;
    /* the market gap is one of the engine's own counterarguments, so it is
       expected to appear on the priced side only */
    c.uncertainty.items = c.uncertainty.items.filter(function (i) { return !/market/i.test(i.label + i.text); });
    c.cases.underdog.bullets = c.cases.underdog.bullets.filter(function (b) { return !/market/i.test(b); });
    return c;
  }
  const a = stripMarkety(A.research), b = stripMarkety(B.research);
  eq(JSON.stringify(a.compare), JSON.stringify(b.compare), 'the team comparison is byte-identical with and without a market');
  eq(JSON.stringify(a.roster), JSON.stringify(b.roster), 'so is the roster comparison');
  eq(JSON.stringify(a.matchups), JSON.stringify(b.matchups), 'so are the matchups');
  eq(JSON.stringify(a.advantages), JSON.stringify(b.advantages), 'so are the advantages');
  eq(a.projection.fair_spread_text, b.projection.fair_spread_text, 'and the model line does not move because a book posted');
  eq(JSON.stringify(a.drivers), JSON.stringify(b.drivers), 'nor do the drivers behind it');
})();

/* ═══ priced and context are kept apart ═════════════════════════════════ */
section('what is PRICED BY MODEL and what is RESEARCH CONTEXT are labelled apart');
ok(/PRICED BY MODEL/.test(A.research.priced_label || ''), 'the projection carries a PRICED BY MODEL label');
ok(/RESEARCH CONTEXT/.test(A.research.context_label || ''), 'the ratings carry a RESEARCH CONTEXT label');
ok(A.html.indexOf('PRICED BY MODEL') >= 0 && A.html.indexOf('RESEARCH CONTEXT') >= 0, 'and both reach the page');
ok(/NOT in this number/.test(A.block.drivers.excluded || '')
  && /cleared walk-forward validation/.test(A.block.drivers.excluded || ''),
  'and the drivers block states that player quality and scheme move no priced number');
(function () {
  /* the guard itself: no unvalidated layer may appear as a driver */
  const keys = (A.block.drivers.rows || []).map(function (d) { return String(d.text).toLowerCase(); }).join(' ');
  ok(keys.indexOf('position-group') < 0 && keys.indexOf('player quality') < 0,
    'no unvalidated roster input is presented as a contribution to the spread');
})();

/* ═══ the decision state describes the research, not the game's worth ════ */
section('the decision state sits AFTER the research and describes the model/market');
eq(B.block.state.label, 'NO MARKET', 'an unpriced game is labelled NO MARKET');
ok(/nothing to compare|stands on its own/.test(B.block.state.note || ''),
  'and the note is about the comparison, not about whether there is a bet');
ok(/not a statement about whether the matchup is worth researching/.test(B.block.state.scope || ''),
  'the scope line says explicitly what the state does NOT mean');
ok(B.html.indexOf('Research state') > B.html.indexOf('Team research head-to-head'),
  'and the state is printed after the research, not in place of it');

/* ═══ the wiring itself ═════════════════════════════════════════════════ */
section('the wiring: the builder is exported and the brief layer asks for it');
eq(typeof win.fbBriefGame, 'function', 'window.fbBriefGame is reachable from outside the football IIFE');
eq(typeof win.fbBriefResearch, 'function', 'and the name the brief layer has always used still resolves');
ok(APP.indexOf('window.fbBriefGame=fbBriefGame;') > 0, 'the export line exists in the shipped file');
ok(/var build=window\.fbBriefGame\|\|window\.fbBriefResearch;/.test(APP),
  'EDBRIEF.researchFor() reaches the canonical builder by its exported name');
ok(/research:researchFor\(q, first\)/.test(APP), 'and every CFB game snapshot is offered that research');
(function () {
  /* EVERY CFB game brief, however it is opened, goes through one function.
     openCard(), openGame() and the board's own "Game brief" button all end
     at gameSnapshot(), so the research cannot reach some entry points and
     not others. */
  const i = APP.indexOf('function gameSnapshot(cards, q, preset){');
  const body = i < 0 ? '' : APP.slice(i, APP.indexOf('\n  }', i));
  ok(/research:researchFor\(q, first\)/.test(body),
    'gameSnapshot is the single door, so openGame, openCard and the board button all carry it');
  ['function openCard(id){', 'function openGame(q){'].forEach(function (fn) {
    const j = APP.indexOf(fn);
    const b = j < 0 ? '' : APP.slice(j, APP.indexOf('\n  }', j));
    ok(/gameSnapshot\(/.test(b), fn.replace(/function |\(.*/g, '') + ' goes through that door');
  });
})();

console.log('\n' + (failures ? 'FAILED ' + failures + ' of ' + checks : 'PASS — ' + checks + ' checks'));
process.exit(failures ? 1 : 0);
