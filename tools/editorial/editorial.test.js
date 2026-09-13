#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL SYSTEM, HELD OFFLINE.

   No network, no engine boot, no database. Everything here runs against the
   real modules and the committed store, so it is the same check on a laptop
   and in CI.

   WHAT IT IS PROTECTING, in the order the failures would hurt:

     1  THE PHILOSOPHY. A winning number with a broken thesis must be reported
        as exactly that, and a losing number with a sound one must not be
        thrown away. The four quadrants are asserted as OUTCOMES the grader is
        required to produce, on fixtures built to force each one.
     2  THE SNAPSHOT. Immutable, content-addressed, idempotent under a cron job
        that ran twice, and refused if it postdates kickoff. Everything
        downstream is worthless if the pregame state can move.
     3  NO INVENTION. Every figure on a page traces to the snapshot, the result
        record or this repository’s own arithmetic — asserted by feeding an
        invented number in and requiring the gate to catch it.
     4  THE ARITHMETIC. Favourite/underdog orientation, ATS and total grading
        including pushes, closing-line value and its SIGN.
     5  IDEMPOTENCY. A duplicate run produces one article, one snapshot and one
        set of lessons.
     6  THE GATE. A postgame article cannot be written from a scoreboard, from
        a conflicted result, or with the "what we got wrong" section missing.
     7  THE NARRATION BOUNDARY. Malformed output, an invented figure, a
        contradicted verdict and a named player are each refused, and the
        deterministic prose ships instead.

   Run: node tools/editorial/editorial.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const AMODEL = require('../articles/article_model.js');
const ASTORE = require('../articles/store.js');
const RENDER = require('../articles/article_render.js');
const FEATURED = require('./featured.js');
const SNAP = require('./snapshot.js');
const THESES = require('./theses.js');
const RESULTS = require('./results.js');
const GRADING = require('./grading.js');
const LESSONS = require('./lessons.js');
const QUALITY = require('./quality.js');
const NARRATE = require('./narrate.js');
const GRAPHIC = require('./graphic.js');
const POST = require('./postgame_model.js');
const FETCH = require('./fetch_results.js');
const STORE = require('./store.js');
const FIX = require('./fixtures/scenarios.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') {
    try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); }
  }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) { return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function has(hay, needle, name) { return chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + JSON.stringify(needle)); }
function lacks(hay, needle, name) { return chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + JSON.stringify(needle)); }
function section(t) { console.log('\n' + t); }

const NOW = '2026-09-10T04:00:00.000Z';

/* ------------------------------------------------------------------ helpers */
/* One scenario, driven end to end through the real modules. This is the shape
   the pipeline itself uses; if it drifts, these tests drift with it. */
function runScenario(sc, opts) {
  opts = opts || {};
  const meta = Object.assign({}, FIX.META, opts.meta || {});
  const snap = SNAP.capture(sc.research, meta, { now: '2026-09-09T08:00:00.000Z', article_id: 'nfl-FIXTURE' });
  const theses = THESES.extract(snap);
  const result = RESULTS.build({
    observation: Object.assign({
      provider: 'fixture', home_team: FIX.HOME, away_team: FIX.AWAY, completed: true,
      status_name: 'STATUS_FINAL', line_scores: null, scoring_plays: sc.result.scoring_plays || null,
      drive_summary: null, win_probability: null, leaders: null,
      stat_fields_seen: ['totalYards', 'yardsPerPlay', 'thirdDownEff', 'turnovers', 'firstDowns']
    }, sc.result),
    agreed_by: ['fixture'], ok: true
  }, { now: NOW, sport: 'NFL', game_id: 'FIXTURE', season: 2026, week: 1,
    kickoff: meta.kickoff, home: FIX.HOME, away: FIX.AWAY });
  RESULTS.crossDerive(result.metrics.home, result.metrics.away);
  const audit = THESES.audit(theses, result);
  const tally = THESES.tally(audit);
  const graded = GRADING.grade({ snapshot: snap, result, audit, tally, now: NOW,
    closing_home_margin: sc.closing_home_margin, closing_source: sc.closing_source });
  const lessons = LESSONS.extract({ snapshot: snap, result, graded, audit, tally, now: NOW,
    article_id: 'postgame-nfl-FIXTURE' });
  const rec = POST.build({ snapshot: snap, result, theses, audit, tally, grading: graded,
    lessons, pregame: opts.pregame || null, now: NOW, status: 'draft' });
  return { snap, theses, result, audit, tally, graded, lessons, rec };
}
function byName(n) { return FIX.SCENARIOS.filter(s => s.name === n)[0]; }

/* ======================================================================== */
section('1. THE FEATURED-GAME SELECTION ENGINE');
/* ======================================================================== */
(function () {
  /* THE WINDOW. A Monday 20:15 Eastern kickoff is Monday Night Football, and
     the board's own timestamp cannot be trusted to say so — it is parsed with
     no timezone, so on a UTC runner it reads as a Monday afternoon. The feed's
     own Eastern columns are the authority and this asserts they are used. */
  const mnf = FEATURED.priorityFor({
    sport: 'NFL', game_id: 'x', home: 'Kansas City Chiefs', away: 'Denver Broncos',
    kickoff: '2026-09-15T00:15:00.000Z', kickoff_ms: Date.parse('2026-09-15T00:15:00Z'),
    weekday: 'Monday', gametime_et: '20:15', game_type: 'REG', division_game: true
  }, {});
  eq('a Monday 20:15 ET kickoff is Monday night', mnf.window_label, 'Monday night');
  chk('and is a national window', mnf.national_window);
  /* the same game WITHOUT the feed's columns, off a timestamp a UTC runner
     mis-parses: the fallback must not silently claim prime time */
  const noCols = FEATURED.easternFor({ kickoff: '2026-09-15T00:15:00.000Z',
    kickoff_ms: Date.parse('2026-09-15T00:15:00Z') });
  eq('with no Eastern columns the conversion is used and says so',
    noCols.source, 'converted from the kickoff timestamp');
  eq('and it gets the same answer from a real UTC instant', noCols.weekday, 'Mon');

  const sunAfternoon = FEATURED.priorityFor({
    sport: 'NFL', game_id: 'y', home: 'A', away: 'B', kickoff: '2026-09-13T17:00:00.000Z',
    weekday: 'Sunday', gametime_et: '13:00', game_type: 'REG'
  }, {});
  chk('a Sunday one o’clock game is not a national window', !sunAfternoon.national_window);

  /* THE STAGE, off the feed's own field and never off a week number. */
  eq('an NFL conference championship is read from game_type',
    FEATURED.nflStage({ game_type: 'CON' }).key, 'conference_championship');
  eq('a Super Bowl too', FEATURED.nflStage({ game_type: 'SB' }).key, 'super_bowl');
  eq('a regular-season game scores nothing for its stage', FEATURED.nflStage({ game_type: 'REG' }).points, 0);
  eq('a college conference championship is read from the notes column',
    FEATURED.cfbStage({ season_type: 'postseason', notes: 'SEC Championship' }).key, 'conference_championship');
  eq('and a playoff round from the same place',
    FEATURED.cfbStage({ season_type: 'postseason', notes: 'CFP Semifinal at the Fiesta Bowl' }).key, 'playoff');
  eq('a regular-season college game scores nothing for its stage',
    FEATURED.cfbStage({ season_type: 'regular', notes: '' }).points, 0);

  /* RANKS ARE EDGEDESK'S OWN and no credit is given for one it did not publish. */
  const unranked = FEATURED.priorityFor({
    sport: 'CFB', game_id: 'z', home: 'Someone', away: 'Someone Else',
    kickoff: '2026-09-12T23:00:00.000Z', season_type: 'regular'
  }, { ranks: {} });
  const rw = unranked.components.filter(c => c.key === 'ranking_weight')[0];
  eq('an unranked pairing earns no ranking credit', rw.points, 0);
  has(rw.label, 'not available', 'and the row says why');

  /* THE RIVALRY LIST IS OPERATOR-CURATED AND IS LABELLED AS SUCH. */
  const riv = FEATURED.rivalryFor({ home: 'Navy', away: 'Army' }, STORE.loadRivalries());
  chk('a curated rivalry is found in either direction', !!riv);
  has(riv.source, 'operator-curated', 'and it declares that it is curated, not measured');
  chk('a pairing not on the list is not a rivalry',
    !FEATURED.rivalryFor({ home: 'Rice', away: 'Tulane' }, STORE.loadRivalries()));

  /* NO BROADCASTER, EVER. */
  const row = FEATURED.rowFor({ sport: 'NFL', game_id: 'q', home: 'A', away: 'B',
    kickoff: '2026-09-15T00:15:00.000Z', weekday: 'Monday', gametime_et: '20:15', season: 2026, week: 2 }, {});
  eq('a featured row never carries a network', row.network, null);
  has(row.network_note, 'no broadcast-rights feed', 'and says why it never will');

  /* THE OPERATOR OUTRANKS THE SCORER, BOTH WAYS, AND SURVIVES A RESCORE. */
  const scored = Object.assign({}, row, { auto_selected: true, status: 'featured' });
  const unfeatured = FEATURED.applyOverride(scored, Object.assign({}, scored, { manual_override: 'unfeature' }));
  eq('an operator UNFEATURE beats a high score', FEATURED.statusFor(unfeatured), 'excluded');
  const forced = FEATURED.applyOverride(Object.assign({}, row, { auto_selected: false }),
    Object.assign({}, row, { manual_override: 'feature' }));
  eq('an operator FEATURE beats a low score', FEATURED.statusFor(forced), 'featured');
  const disabled = FEATURED.applyOverride(scored, Object.assign({}, scored, { postgame_enabled: false }));
  eq('a disabled postgame switch survives a rescore', disabled.postgame_enabled, false);

  /* THE FLOOR AND THE WEEKLY CAP. */
  const slate = [];
  for (let i = 0; i < 12; i++) {
    slate.push({ sport: 'NFL', game_id: 'g' + i, home: 'H' + i, away: 'A' + i, season: 2026, week: 3,
      kickoff: '2026-09-20T17:00:00.000Z', weekday: 'Sunday',
      gametime_et: i < 6 ? '20:20' : '13:00', game_type: 'REG', division_game: i % 2 === 0 });
  }
  const rows = FEATURED.scoreSlate(slate, {}, { thresholds: { NFL: 20 }, caps: { NFL: 3 }, now: NOW });
  eq('the weekly cap is respected', rows.filter(FEATURED.isFeatured).length, 3);
  chk('and the three are the three highest-scoring',
    rows.filter(FEATURED.isFeatured).every(r => r.editorial_priority >= rows[3].editorial_priority));
  chk('a game over the floor but outside the cap says so',
    rows.filter(r => !r.auto_selected && r.editorial_priority >= 20)
      .every(r => /outside the top/.test(r.selection_note || '')));
  const belowFloor = FEATURED.scoreSlate(slate, {}, { thresholds: { NFL: 999 }, caps: { NFL: 3 } });
  eq('nothing clears an impossible floor', belowFloor.filter(FEATURED.isFeatured).length, 0);

  /* A POSTSEASON GAME IS NEVER CROWDED OUT BY A CAP. */
  const playoffSlate = slate.slice(0, 6).map((g, i) =>
    Object.assign({}, g, { game_type: i === 5 ? 'CON' : 'REG', gametime_et: i === 5 ? '15:00' : '20:20' }));
  const pRows = FEATURED.scoreSlate(playoffSlate, {}, { thresholds: { NFL: 20 }, caps: { NFL: 2 } });
  const conf = pRows.filter(r => r.stage === 'conference_championship')[0];
  chk('a conference championship is featured whatever the cap', FEATURED.isFeatured(conf), conf && conf.selection_note);
})();

/* ======================================================================== */
section('2. THE PREGAME SNAPSHOT — IMMUTABLE AND IDEMPOTENT');
/* ======================================================================== */
(function () {
  const sc = byName('EdgeDesk right, thesis right');
  const a = SNAP.capture(sc.research, FIX.META, { now: '2026-09-09T08:00:00Z' });
  const b = SNAP.capture(sc.research, FIX.META, { now: '2026-09-09T19:00:00Z' });
  eq('capturing identical research twice produces the same id', b.snapshot_id, a.snapshot_id);
  chk('which is what makes a cron job that fired twice idempotent', SNAP.sameContent(a, b));

  const moved = JSON.parse(JSON.stringify(sc.research));
  moved.projection.fair_spread_text = 'Seattle Seahawks -9.9';
  const c = SNAP.capture(moved, FIX.META, { now: '2026-09-09T08:00:00Z' });
  chk('changed research produces a DIFFERENT id, so the old one is superseded rather than edited',
    c.snapshot_id !== a.snapshot_id);

  eq('a snapshot verifies against its own content hash', SNAP.verify(a).ok, true);
  const tampered = JSON.parse(JSON.stringify(a));
  tampered.research.projection.fair_spread_text = 'Seattle Seahawks -1.0';
  chk('and an edited one does not', !SNAP.verify(tampered).ok);
  has(SNAP.verify(tampered).problems.join(' '), 'edited since capture', 'and says exactly that');

  const late = SNAP.capture(sc.research, FIX.META, { now: '2026-09-09T23:00:00Z' });
  chk('a snapshot captured after kickoff is refused', !SNAP.verify(late).ok);
  has(SNAP.verify(late).problems.join(' '), 'captured after kickoff', 'and says why');

  /* THE FACT LEDGER is the closed set an article may assert from. */
  chk('the ledger names every published figure', a.facts.length > 30, a.facts.length + ' facts');
  const tiers = {};
  a.facts.forEach(f => { tiers[f.tier] = (tiers[f.tier] || 0) + 1; });
  chk('and separates verified fact from model output from unknown',
    tiers.VERIFIED_FACT > 0 && tiers.EDGEDESK_MODEL > 0 && tiers.UNKNOWN > 0, JSON.stringify(tiers));
  const network = a.facts.filter(f => f.id === 'game.network')[0];
  eq('the television network is an explicit UNKNOWN, not an omission', network.tier, 'UNKNOWN');
  has(network.source, 'no broadcast-rights feed', 'with the reason attached');
  chk('every fact carries a path back into the payload it came from',
    a.facts.filter(f => f.tier === 'EDGEDESK_MODEL').every(f => !!f.path));

  /* the store refuses a second snapshot under one id with different content */
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eded-'));
  const file = path.join(tmp, 'x.json');
  fs.writeFileSync(file, JSON.stringify(a));
  chk('the store recognises an identical re-save as a no-op', SNAP.sameContent(JSON.parse(fs.readFileSync(file, 'utf8')), b));
  chk('and a different body under the same id as a conflict', !SNAP.sameContent(a, c));
  fs.rmSync(tmp, { recursive: true, force: true });
})();

/* ======================================================================== */
section('3. THE PROVIDER BOX SCORE AND THE READINESS GATE');
/* ======================================================================== */
(function () {
  const full = require('./fixtures/espn_summary.json');
  const thin = require('./fixtures/espn_summary_thin.json');
  const o = RESULTS.normalizeSummary(full);

  eq('the provider’s away team is the away team', o.away_team, 'New England Patriots');
  eq('and the score is read from the header, not the box score', o.home_score, 13);
  eq('"5-13" becomes a third-down rate', o.metrics.away.third_down_pct, 38.5);
  eq('"21-33" becomes a completion percentage', o.metrics.away.completion_pct, 63.6);
  eq('"31:12"-style possession becomes seconds', o.metrics.home.possession_seconds, 1830);
  eq('"4-27" becomes sacks and the yards behind them', o.metrics.away.sacks_allowed, 4);
  eq('one side’s sacks allowed are the other’s sacks generated', o.metrics.home.sacks_generated, 4);
  eq('the turnover margin is derived, not asserted', o.metrics.home.turnover_margin, 1);
  eq('points per drive is derived in code', o.metrics.home.points_per_drive, 1.18);
  eq('the provider’s own drive aggregate survives', (o.drive_summary || []).length, 2);
  eq('and its own largest win-probability swing', o.win_probability.largest_swing.delta, 0.43);

  /* A METRIC THE PROVIDER DID NOT PUBLISH IS ABSENT, NEVER ZERO. */
  const noPenalties = JSON.parse(JSON.stringify(full));
  noPenalties.boxscore.teams.forEach(t => {
    t.statistics = t.statistics.filter(s => s.name !== 'totalPenaltiesYards');
  });
  const o2 = RESULTS.normalizeSummary(noPenalties);
  eq('an unpublished statistic is absent', o2.metrics.home.penalties, undefined);
  const obs = RESULTS.observed({ metrics: o2.metrics }, 'penalties');
  eq('and reading it reports that it was not published', obs.available, false);
  has(obs.why, 'published no', 'with the reason');

  /* THE GATE. A scoreboard is not a game. */
  const ready = RESULTS.readiness({ ok: true, observation: o, agreed_by: ['espn'],
    snapshot: { kickoff: '2026-09-09T20:20:00Z', snapshot_id: 's' } },
    { now: NOW, settle_minutes: 0 });
  eq('a full box score with a snapshot is ready', ready.ready, true);

  const thinObs = RESULTS.normalizeSummary(thin);
  const notReady = RESULTS.readiness({ ok: true, observation: thinObs, agreed_by: ['espn'],
    snapshot: { kickoff: '2026-09-09T20:20:00Z', snapshot_id: 's' } },
    { now: NOW, settle_minutes: 0 });
  eq('a scoreboard alone is NOT ready', notReady.ready, false);
  has(notReady.reasons.join(' '), 'core team statistics', 'and says it is the statistics that are missing');

  const noSnap = RESULTS.readiness({ ok: true, observation: o, agreed_by: ['espn'] }, { now: NOW, settle_minutes: 0 });
  eq('a result with no pregame snapshot is not ready', noSnap.ready, false);
  has(noSnap.reasons.join(' '), 'nothing to audit', 'because there would be nothing to audit it against');

  const nilNil = RESULTS.readiness({ ok: true,
    observation: RESULTS.fromScore({ home_score: 0, away_score: 0, completed: true }),
    snapshot: { kickoff: '2026-09-09T20:20:00Z', snapshot_id: 's' } }, { now: NOW, settle_minutes: 0 });
  eq('0-0 is never a football final', nilNil.ready, false);
  has(nilNil.reasons.join(' '), '0-0', 'and it is named');

  const early = RESULTS.readiness({ ok: true, observation: o, final_seen_at: NOW,
    snapshot: { kickoff: '2026-09-09T20:20:00Z', snapshot_id: 's' } },
    { now: NOW, settle_minutes: 30 });
  eq('the settle delay holds an article back', early.ready, false);
  has(early.reasons.join(' '), 'to go', 'and says how long is left');

  /* A POSTPONED GAME SITS IN "post" WITH completed:false, and must not settle. */
  const postponed = RESULTS.normalizeSummary(Object.assign(JSON.parse(JSON.stringify(full)), {
    header: Object.assign({}, full.header, { competitions: [Object.assign({}, full.header.competitions[0], {
      status: { type: { name: 'STATUS_POSTPONED', completed: false } } })] })
  }));
  eq('a postponed game is not completed', postponed.completed, false);
  const pReady = RESULTS.readiness({ ok: true, observation: postponed,
    snapshot: { kickoff: '2026-09-09T20:20:00Z', snapshot_id: 's' } }, { now: NOW, settle_minutes: 0 });
  eq('and is not ready', pReady.ready, false);

  /* TWO SOURCES THAT DISAGREE IS THE ONE CASE WHERE PUBLISHING IS WORSE THAN
     WAITING. */
  const conflict = RESULTS.reconcile([
    RESULTS.fromScore({ provider: 'espn', home_score: 13, away_score: 10, completed: true }),
    RESULTS.fromScore({ provider: 'nflverse', home_score: 14, away_score: 10, completed: true })
  ]);
  eq('a provider disagreement does not settle', conflict.ok, false);
  chk('and is recorded as a conflict', conflict.conflict === true);
  has(conflict.why, 'disagree', 'naming both candidates');
  const agreeing = RESULTS.reconcile([
    RESULTS.fromScore({ provider: 'nflverse', home_score: 13, away_score: 10, completed: true }),
    o
  ]);
  eq('two agreeing sources settle', agreeing.ok, true);
  eq('and the RICHEST observation is the one kept', agreeing.observation.provider, 'espn_summary');
  chk('with every agreeing source recorded', agreeing.agreed_by.length === 2);
})();

/* ======================================================================== */
section('4. THE ARITHMETIC — ORIENTATION, GRADING, PUSHES, CLV');
/* ======================================================================== */
(function () {
  /* FAVOURITE AND UNDERDOG THE RIGHT WAY ROUND. The classic silent error. */
  const favHome = GRADING.impliedSide({
    game: { home: 'Home', away: 'Away' },
    model: { priced: true, fair_spread_text: 'Home -7.5' },
    market: { available: true, market: 'Home -3.0', model: 'Home -7.5', book: 'B' }
  });
  eq('a model on the home favourite leans home', favHome.side, 'home');
  eq('and takes the home price', favHome.point, -3);
  eq('the market is stored as a home margin, negative for a home favourite', favHome.market_home_margin, -3);
  eq('and the gap is the distance between the two', favHome.gap, 4.5);

  const favAway = GRADING.impliedSide({
    game: { home: 'Home', away: 'Away' },
    model: { priced: true, fair_spread_text: 'Away -2.0' },
    market: { available: true, market: 'Home -3.0', model: 'Away -2.0', book: 'B' }
  });
  eq('a model on the away side leans away', favAway.side, 'away');
  eq('and takes the away side of the SAME quote, with the sign flipped', favAway.point, 3);

  const noMarket = GRADING.impliedSide({
    game: { home: 'Home', away: 'Away' },
    model: { priced: true, fair_spread_text: 'Home -7.5' }, market: { available: false }
  });
  eq('no captured quote means no implied side', noMarket.available, false);
  has(noMarket.why, 'no market number', 'and the article says so rather than inventing one');

  const agreed = GRADING.impliedSide({
    game: { home: 'Home', away: 'Away' },
    model: { priced: true, fair_spread_text: 'Home -3.0' },
    market: { available: true, market: 'Home -3.0', model: 'Home -3.0' }
  });
  eq('agreeing with the market implies nothing either way', agreed.available, false);

  /* ATS, TOTALS AND PUSHES. */
  eq('a favourite covering is a win',
    GRADING.gradeSpread({ home_score: 27, away_score: 17, side: 'home', point: -7.5 }).outcome, 'win');
  eq('a favourite winning by less than the number is a loss',
    GRADING.gradeSpread({ home_score: 24, away_score: 20, side: 'home', point: -7.5 }).outcome, 'loss');
  eq('landing exactly on the number is a push, never rounded',
    GRADING.gradeSpread({ home_score: 24, away_score: 21, side: 'home', point: -3 }).outcome, 'push');
  eq('an underdog losing by less than the number covers',
    GRADING.gradeSpread({ home_score: 27, away_score: 24, side: 'away', point: 7 }).outcome, 'win');
  eq('a total landing on the number pushes',
    GRADING.gradeTotal({ home_score: 24, away_score: 21, side: 'over', line: 45 }).outcome, 'push');
  eq('the over needs more than the number',
    GRADING.gradeTotal({ home_score: 24, away_score: 24, side: 'over', line: 45 }).outcome, 'win');
  eq('and the under fewer',
    GRADING.gradeTotal({ home_score: 10, away_score: 7, side: 'under', line: 45 }).outcome, 'win');
  eq('the distance from the line is always positive, with the direction said separately',
    GRADING.gradeTotal({ home_score: 10, away_score: 7, side: 'over', line: 45 }).by, 28);
  eq('and the direction names where it landed',
    GRADING.gradeTotal({ home_score: 10, away_score: 7, side: 'over', line: 45 }).direction, 'under');

  /* CLOSING-LINE VALUE, AND ITS SIGN, WHICH IS THE PART THAT IS EASY TO
     INVERT AND IMPOSSIBLE TO NOTICE. */
  const clvGood = GRADING.closingLineValue({
    implied: { available: true, side: 'home', market_home_margin: -1 },
    closing_home_margin: -3, closing_source: 'a feed'
  });
  eq('a line moving from -1 to -3 toward the home side EdgeDesk leaned is +2', clvGood.clv_points, 2);
  chk('and is reported as the market arriving where EdgeDesk was', clvGood.moved_toward_edgedesk);
  const clvBad = GRADING.closingLineValue({
    implied: { available: true, side: 'home', market_home_margin: -3 },
    closing_home_margin: -1, closing_source: 'a feed'
  });
  eq('the same movement against EdgeDesk is negative', clvBad.clv_points, -2);
  chk('and is reported as the market going the other way', !clvBad.moved_toward_edgedesk);
  has(clvBad.note, 'AWAY from', 'in words, not only in a sign');
  const clvNone = GRADING.closingLineValue({ implied: { available: true, side: 'home', market_home_margin: -3 } });
  eq('with no closing line there is no closing-line value', clvNone.available, false);
  has(clvNone.why, 'not estimated from the result', 'and it is explicitly not estimated');

  /* THE TWO FEEDS SPELL THE CLOSING LINE DIFFERENTLY, AND THE CONVERSION IS
     PINNED. Getting this backwards would invert CLV on every game. */
  const fromCollective = FETCH.closingFrom({}, { _closing_spread: -3, _closing_total: 44.5, _close_source: 'collective_odds' });
  eq('the Collective writes the home team’s own line, so -3 stays -3', fromCollective.home_margin, -3);
  const fromNflverse = FETCH.closingFrom({ nflverse_spread_line: 3, nflverse_total_line: 44.5 }, null);
  eq('nflverse writes +3 for the same home favourite, so it is negated', fromNflverse.home_margin, -3);
  const noClose = FETCH.closingFrom({}, null);
  eq('and with neither there is no closing line', noClose.home_margin, null);
  has(noClose.absent_reason, 'rather than estimated from the result',
    'and the fetcher’s record says it is not estimated from the result');
  has(clvNone.why, 'not estimated from the result',
    'and so does the grading record');
})();

/* ======================================================================== */
section('5. THE FOUR QUADRANTS — RESULT VERSUS PROCESS');
/* ======================================================================== */
FIX.SCENARIOS.forEach(sc => {
  const out = runScenario(sc);
  const e = sc.expect || {};
  const spread = out.graded.bet_result.spread;

  if (e.spread === null) {
    eq(sc.name + ': there is no bet to grade', spread, null);
    eq(sc.name + ': and no implied side', out.graded.implied_side.available, false);
  } else if (e.spread) {
    eq(sc.name + ': the spread grades ' + e.spread, spread && spread.outcome, e.spread);
  }
  if (e.total) {
    chk(sc.name + ': a total was gradeable at all', !!out.graded.bet_result.total,
      JSON.stringify(out.graded.implied_total));
    if (out.graded.bet_result.total) {
      eq(sc.name + ': the total grades ' + e.total, out.graded.bet_result.total.outcome, e.total);
    }
  }
  if (e.process) eq(sc.name + ': the process grade is ' + e.process, out.graded.process_headline, e.process);
  if (e.verdict) eq(sc.name + ': the verdict is ' + e.verdict, out.graded.verdict.key, e.verdict);
  if (e.market_gap_verdict) {
    const mg = out.audit.filter(a => a.thesis_id === 'market_gap')[0];
    eq(sc.name + ': the disagreement is graded ' + e.market_gap_verdict, mg && mg.evaluation, e.market_gap_verdict);
  }
  if (e.variance) {
    const keys = out.graded.variance_markers.map(v => v.key);
    e.variance.forEach(k => chk(sc.name + ': "' + k + '" is named as variance', keys.indexOf(k) >= 0, keys.join(',')));
  }
  if (e.lesson_id) {
    chk(sc.name + ': it produces the "' + e.lesson_id + '" lesson',
      out.lessons.some(l => String(l.id).endsWith(e.lesson_id)), out.lessons.map(l => l.id).join(', '));
  }
  if (e.review_required) {
    chk(sc.name + ': it opens at least one model-review candidate',
      out.lessons.some(l => l.model_review_required));
  }
  if (e.clv_positive) {
    chk(sc.name + ': closing-line value is positive', out.graded.closing_line.clv_points > 0,
      JSON.stringify(out.graded.closing_line));
    if (e.clv_points != null) eq(sc.name + ': and is ' + e.clv_points, out.graded.closing_line.clv_points, e.clv_points);
  }
  /* THE SECTION THAT IS NEVER DROPPED. */
  const card = out.rec.article.sections.filter(s => s.kind === 'scorecard')[0];
  chk(sc.name + ': "what EdgeDesk got wrong" is published', !!card && card.wrong.length > 0);
  chk(sc.name + ': and so is "what the market got right"', !!card && card.market.length > 0);
  /* AND THE TWO GRADES ARE ALWAYS ALLOWED TO DISAGREE. */
  has(out.graded.separation_note, 'allowed to disagree', sc.name + ': the separation is stated on the record');
});

/* The headline case, asserted in prose rather than only in a key: a winning
   number with a broken thesis must SAY so, in the article, in words. */
(function () {
  const out = runScenario(byName('EdgeDesk right, thesis WRONG'));
  const text = QUALITY.documentText(out.rec);
  has(text, 'THE NUMBER LANDED AND THE REASONING DID NOT',
    'a winning number with a broken thesis says so on the page');
  has(text, 'most dangerous result on this page', 'and says why that matters');
  const lost = runScenario(byName('EdgeDesk wrong, thesis right'));
  has(QUALITY.documentText(lost.rec), 'least upset about',
    'a losing number with sound reasoning is not treated as a failure');
})();

/* ======================================================================== */
section('6. THE THESIS AUDIT');
/* ======================================================================== */
(function () {
  const sc = byName('EdgeDesk right, thesis right');
  const out = runScenario(sc);

  chk('every published claim becomes a thesis', out.theses.length >= 6, out.theses.length + ' theses');
  chk('each carries a falsifier', out.theses.filter(t => t.kind !== 'uncertainty').every(t => !!t.falsifier));
  chk('each carries the path in the payload it came from', out.theses.every(t => !!t.source_path));
  chk('and every thesis is graded', out.audit.length === out.theses.length);
  chk('with one of exactly four verdicts',
    out.audit.every(a => THESES.VERDICTS.indexOf(a.evaluation) >= 0));

  /* A MODEL CONSTANT IS NOT A CLAIM ABOUT THIS GAME. */
  const constant = out.audit.filter(a => /baseline|constant/i.test(a.claim))[0];
  eq('a model constant is never graded as a claim', constant.evaluation, 'INCONCLUSIVE');
  has(constant.why, 'not a claim about this game', 'and says why');

  /* A METRIC NOBODY PUBLISHED IS INCONCLUSIVE, NOT A SUBSTITUTE. */
  const thinResult = JSON.parse(JSON.stringify(out.result));
  thinResult.metrics = { home: { points: 31 }, away: { points: 17 } };
  const thinAudit = THESES.audit(out.theses, thinResult);
  const driverVerdicts = thinAudit.filter(a => a.kind === 'driver').map(a => a.evaluation);
  chk('with no box score every driver claim is INCONCLUSIVE',
    driverVerdicts.every(v => v === 'INCONCLUSIVE'), driverVerdicts.join(','));
  const one = thinAudit.filter(a => a.kind === 'driver' && a.expected_signal)[0];
  has(one.why, 'published', 'and says the statistics were not published');

  /* ONE GAME CANNOT ESTABLISH A RATE, AND THE RECORD SAYS SO. */
  const graded = out.audit.filter(a => a.kind === 'driver' && a.sample_note)[0];
  has(graded.sample_note, 'cannot establish a rate', 'a graded rate claim says one game is not a rate');

  /* THE TALLY IS A COUNT, NOT A SCORE. A percentage would be optimised. */
  chk('the tally reports counts rather than a percentage',
    !/\d+%/.test(out.tally.headline), out.tally.headline);
})();

/* ======================================================================== */
section('7. THE POSTGAME ARTICLE');
/* ======================================================================== */
(function () {
  const pre = ASTORE.loadAll().filter(r => r.slug === 'new-england-patriots-vs-seattle-seahawks-2026')[0];
  const out = runScenario(byName('EdgeDesk right, thesis right'), { pregame: pre });
  const rec = out.rec;

  eq('a postgame article declares its type', rec.article_type, 'postgame');
  eq('and lives in the same store under the same model', AMODEL.typeOf(rec), 'postgame');
  chk('its slug says what it is', /-postgame-analysis$/.test(rec.slug), rec.slug);
  eq('and is the pregame slug plus a suffix', rec.slug, pre.slug + '-postgame-analysis');
  eq('it is born frozen: the game already happened', rec.frozen, true);
  eq('and a refresh refuses to touch it',
    AMODEL.refresh(rec, pre.research, FIX.META, {}).changed, false);
  has(AMODEL.refresh(rec, pre.research, FIX.META, {}).reason, 'already happened', 'and says why');

  /* THE CROSS-LINK, BOTH WAYS. */
  eq('it points back at the pregame research', rec.related.pregame_url, pre.canonical_url);
  const html = RENDER.articlePage(rec);
  has(html, 'Read our original pregame research', 'and the page carries the link in words');
  has(html, pre.canonical_url, 'pointing at the real URL');
  const linked = Object.assign({}, pre, { related: { postgame_url: rec.canonical_url, postgame_slug: rec.slug } });
  linked.article = AMODEL.articleFor(linked);
  has(RENDER.articlePage(linked), 'See what actually happened',
    'and the pregame page points forward once the postgame exists');

  /* THE REQUIRED SECTIONS. */
  const kinds = rec.article.sections.map(s => s.kind);
  ['snapshot', 'breakdown', 'thesis_audit', 'process', 'scorecard', 'lessons'].forEach(k => {
    chk('the article carries a ' + k + ' section', kinds.indexOf(k) >= 0, kinds.join(','));
  });
  chk('the publication checks pass', AMODEL.publishable(rec).ok,
    AMODEL.publishable(rec).failed.map(f => f.id + ': ' + f.why).join('; '));

  /* WHAT EDGEDESK EXPECTED IS READ FROM THE SNAPSHOT, UNEDITED. */
  const expected = rec.article.sections.filter(s => s.kind === 'snapshot')[1];
  eq('the pregame number on the page is the number in the snapshot',
    expected.cards[0].v, out.snap.model.fair_spread_text);
  has(expected.notes.join(' '), 'has not been edited in the light of the result',
    'and the page says it has not been edited');

  /* THE METHODOLOGY NOTICE. */
  chk('the methodology notice is on the page', rec.article.footer.methodology.length >= 4);
  has(html, 'Methodology and transparency', 'with a heading a reader can find');
  has(html, out.snap.snapshot_id, 'naming the snapshot the pregame half was read from');

  /* STRUCTURED DATA DESCRIBES A PLAYED GAME. */
  const ld = RENDER.structuredData(rec);
  const ev = ld.filter(x => x['@type'] === 'SportsEvent')[0];
  has(JSON.stringify(ev), '(final)', 'the SportsEvent block carries the final score');
  const art = ld.filter(x => x['@type'] === 'Article')[0];
  eq('and the Article block canonicalises to the postgame URL', art.url, rec.canonical_url);

  /* SEO. */
  chk('the SEO title carries the score', /\d+-\d+/.test(rec.seo_title), rec.seo_title);
  chk('the meta description is a usable length',
    rec.seo_description.length >= 70 && rec.seo_description.length <= 200, rec.seo_description.length + '');
  has(rec.seo_description, 'Research, not picks', 'and ends where every EdgeDesk description ends');

  /* THE HEADER GRAPHIC carries no team mark. */
  const card = GRAPHIC.forRecord(rec);
  has(card.svg, 'POSTGAME ANALYSIS', 'the card says which half it is');
  has(card.svg, 'EdgeDesk', 'and carries the EdgeDesk mark');
  lacks(card.svg, '<image', 'and embeds no external image, so no team logo can arrive through it');
  chk('it is a social-card shape', card.width === 1200 && card.height === 630);
})();

/* ======================================================================== */
section('8. THE QUALITY GATE');
/* ======================================================================== */
(function () {
  const out = runScenario(byName('EdgeDesk right, thesis right'));
  const clean = QUALITY.inspect(out.rec, { now: NOW });
  chk('a well-formed postgame article passes', clean.publishable,
    JSON.stringify(clean.integrity_failed) + ' / ' + JSON.stringify(clean.craft_failed.map(c => c.id)));
  eq('and scores full marks', clean.score, 100);

  /* THE UNSUPPORTED-STATISTIC CHECK IS THE WHOLE DEFENCE AGAINST INVENTION. */
  const invented = JSON.parse(JSON.stringify(out.rec));
  invented.article = POST.articleFor(invented);
  invented.article.bottom_line.paragraphs.push(
    'Seattle converted 87.3% of its third downs, which is the highest figure of the season.');
  const caught = QUALITY.inspect(invented, { now: NOW });
  eq('an invented statistic blocks publication', caught.publishable, false);
  has(caught.hold_reason, 'FACTUAL INTEGRITY', 'as an integrity failure, not a style note');
  chk('and the offending figure is named',
    caught.unsupported_statistics.some(u => String(u.value).indexOf('87.3') >= 0),
    JSON.stringify(caught.unsupported_statistics.slice(0, 3)));

  /* A SCORE THAT DISAGREES WITH THE RESULT RECORD. */
  const wrongScore = JSON.parse(JSON.stringify(out.rec));
  wrongScore.article = POST.articleFor(wrongScore);
  wrongScore.article.hero.final.home.points = 99;
  const scoreBad = QUALITY.inspect(wrongScore, { now: NOW });
  eq('a score on the page that is not the score in the record blocks publication', scoreBad.publishable, false);
  chk('and is named as such',
    scoreBad.integrity_failed.some(f => f.id === 'score_matches_record'),
    JSON.stringify(scoreBad.integrity_failed.map(f => f.id)));

  /* A SOFTENED PREGAME CLAIM. */
  const softened = JSON.parse(JSON.stringify(out.rec));
  softened.audit[1].claim = 'EdgeDesk thought this might possibly go either way.';
  softened.article = POST.articleFor(softened);
  const softBad = QUALITY.inspect(softened, { now: NOW });
  eq('restating a pregame claim in kinder words blocks publication', softBad.publishable, false);
  chk('and is named', softBad.integrity_failed.some(f => f.id === 'pregame_claims_unedited'));

  /* A TAMPERED SNAPSHOT. */
  const tampered = JSON.parse(JSON.stringify(out.rec));
  tampered.snapshot.research.projection.fair_spread_text = 'Seattle Seahawks -0.5';
  tampered.article = POST.articleFor(tampered);
  const tamperBad = QUALITY.inspect(tampered, { now: NOW });
  eq('a snapshot that no longer matches its own hash blocks publication', tamperBad.publishable, false);
  chk('and is named', tamperBad.integrity_failed.some(f => f.id === 'snapshot_intact'));

  /* INCORRECT SPREAD GRADING. */
  const misgraded = JSON.parse(JSON.stringify(out.rec));
  misgraded.grading.bet_result.spread.outcome = 'loss';
  misgraded.article = POST.articleFor(misgraded);
  const mgBad = QUALITY.inspect(misgraded, { now: NOW });
  eq('a spread result that is not the arithmetic blocks publication', mgBad.publishable, false);
  chk('and is named', mgBad.integrity_failed.some(f => f.id === 'spread_grading'));

  /* FUTURE TENSE IN A POSTGAME ARTICLE. */
  const future = JSON.parse(JSON.stringify(out.rec));
  future.article = POST.articleFor(future);
  future.article.sections.filter(s => s.kind === 'thesis_audit')[0].lede =
    'Seattle will cover this number comfortably.';
  const fBad = QUALITY.inspect(future, { now: NOW });
  eq('a pregame sentence surviving into a postgame article blocks publication', fBad.publishable, false);
  chk('and is named', fBad.integrity_failed.some(f => f.id === 'no_future_tense'));

  /* BUT THE MODEL'S OWN VALIDATION SENTENCE IS NOT A RESULT CLAIM. This fired
     on every NFL article the first time it was written, because "this model
     does NOT beat the closing line" contains "beat the". */
  const pre = ASTORE.loadAll().filter(r => r.slug === 'new-england-patriots-vs-seattle-seahawks-2026')[0];
  const preQ = QUALITY.inspect(pre, { now: NOW });
  chk('a pregame article carrying the model’s own "does not beat the closing line" line still passes',
    preQ.publishable, JSON.stringify(preQ.integrity_failed));

  /* CRAFT FAILURES REDUCE THE SCORE AND, TOGETHER, HOLD THE ARTICLE. */
  const filler = JSON.parse(JSON.stringify(out.rec));
  filler.article = POST.articleFor(filler);
  filler.article.bottom_line.paragraphs[0] =
    'It is important to note that in the ever-changing landscape of professional football, this was a game-changer.';
  const fillerQ = QUALITY.inspect(filler, { now: NOW });
  chk('machine-written phrases cost quality points', fillerQ.score < 100, fillerQ.score + '');
  chk('and are named', fillerQ.craft_failed.some(c => c.id === 'ai_phrase'));

  /* EVERY PUBLISHED ARTICLE IN THE COMMITTED STORE STILL PASSES. */
  ASTORE.loadAll().filter(r => r.status === 'published').forEach(r => {
    const q = QUALITY.inspect(r, { now: NOW });
    chk(r.slug + ': the committed page passes the gate', q.publishable,
      (q.hold_reason || '') + ' ' + JSON.stringify(q.integrity_failed.map(f => f.id)));
  });
})();

/* ======================================================================== */
section('9. THE NARRATION BOUNDARY');
/* ======================================================================== */
(function () {
  const out = runScenario(byName('EdgeDesk right, thesis right'));
  const rec = out.rec;
  const good = {
    standfirst: 'Seattle was the better side in every phase the model said would decide it, and the number landed with the reasoning intact.',
    opening: 'Seattle controlled this game the way the pregame research said it would, and the scoreboard followed the mechanism rather than running ahead of it.\n\nThat is the version of a winning number worth having: the parts of the read that could be checked were checked, and they held.',
    why_it_turned: 'The separation showed up where the model expected it. Seattle moved the ball more efficiently on a per-play basis and the passing game was the reason, which is where the largest published driver sat.\n\nNothing in the result arrived from outside the matchup, so the scoreline is unusually good evidence about both sides.',
    closing: 'The useful thing here is not the result but the correspondence between the read and the game. That is the case that should raise confidence in the mechanism, and it is rarer than a winning number.'
  };
  const v = NARRATE.validate(good, rec);
  chk('clean copy passes validation', v.ok, (v.problems || []).join('; '));

  /* AN INVENTED FIGURE. */
  const invented = Object.assign({}, good, {
    why_it_turned: good.why_it_turned + ' Seattle pressured the quarterback on 41.7% of dropbacks.'
  });
  const iv = NARRATE.validate(invented, rec);
  eq('an invented figure is refused', iv.ok, false);
  has(iv.problems.join(' '), 'not in the payload', 'and is named as not being in the payload');

  /* A CONTRADICTED VERDICT. */
  const wrongSc = runScenario(byName('EdgeDesk wrong, thesis wrong'));
  const contradicted = Object.assign({}, good, {
    opening: 'The passing read held up completely and was confirmed by the game.'
  });
  const cv = NARRATE.validate(contradicted, wrongSc.rec);
  eq('claiming a contradicted thesis was confirmed is refused', cv.ok, false);
  has(cv.problems.join(' '), 'NOT CONFIRMED', 'against the audit’s own verdict');

  /* AN INVENTED PERSON. */
  const named = Object.assign({}, good, {
    opening: good.opening + ' Jordan Whitfield was the difference in the second half.'
  });
  const nv = NARRATE.validate(named, rec);
  eq('a player the payload does not contain is refused', nv.ok, false);
  has(nv.problems.join(' '), 'Jordan Whitfield', 'by name');

  /* AN INVENTED QUOTATION. */
  const quoted = Object.assign({}, good, {
    closing: good.closing + ' As the coach put it, "we knew what they were going to do".'
  });
  eq('a quotation is refused: EdgeDesk holds none', NARRATE.validate(quoted, rec).ok, false);

  /* RECOMMENDATION LANGUAGE. */
  const rec2 = Object.assign({}, good, { closing: 'This was the best bet on the board all week.' });
  eq('recommendation language is refused', NARRATE.validate(rec2, rec).ok, false);

  /* MACHINE-WRITTEN FILLER. */
  const filler = Object.assign({}, good, {
    opening: 'In the ever-changing landscape of the NFL, this was a game-changer that will be talked about for years and years to come.'
  });
  eq('filler is refused', NARRATE.validate(filler, rec).ok, false);

  /* MALFORMED OUTPUT. */
  eq('a response with no fenced block is refused', NARRATE.parse('here you go!').ok, false);
  eq('a truncated block is refused', NARRATE.parse('```edgedesk\n{"standfirst": "a", "openin').ok, false);
  eq('a block missing a field is refused', NARRATE.parse('```edgedesk\n{"standfirst":"aaa"}\n```').ok, false);

  /* AND A FAILURE OF ANY KIND SHIPS THE DETERMINISTIC PROSE. */
  return Promise.all([
    NARRATE.narrate(rec, { call: () => { throw new Error('502 from the model'); } }),
    NARRATE.narrate(rec, { call: () => ({ text: 'no block' }) }),
    NARRATE.narrate(rec, { call: () => ({ text: '```edgedesk\n' + JSON.stringify(invented) + '\n```' }) }),
    NARRATE.narrate(rec, { call: () => ({ text: '```edgedesk\n' + JSON.stringify(good) + '\n```', model: 'test-model' }) })
  ]).then(([boom, malformed, bad, ok]) => {
    eq('a failed call never throws', boom.ok, false);
    has(boom.why, 'narration call failed', 'and says what happened');
    eq('malformed output is refused', malformed.ok, false);
    eq('an invented figure is refused at the call boundary too', bad.ok, false);
    eq('and clean copy is accepted', ok.ok, true);

    const without = POST.articleFor(NARRATE.attach(rec, boom));
    const with_ = POST.articleFor(NARRATE.attach(rec, ok));
    chk('an article with no narration still has every section it needs',
      without.sections.filter(s => s.kind === 'thesis_audit').length === 1);
    chk('and narration adds blocks rather than replacing any of them',
      with_.sections.length > without.sections.length);
    chk('every narration block is labelled on the page',
      with_.sections.filter(s => s.kind === 'narrative').every(s => /language model/.test(s.label)));
    const narrated = NARRATE.attach(rec, ok);
    narrated.article = with_;
    has(POST.methodologyFor(narrated).join(' '), 'validated against them',
      'and the methodology notice says a model was used and what it was held to');
    has(POST.methodologyFor(NARRATE.attach(rec, boom)).join(' '), 'No language model contributed',
      'while an article without one says that instead');
    /* THE TEST OF WHETHER THE BOUNDARY IS REAL: turning the model off must not
       change a single figure on the page. */
    const figures = r => (QUALITY.documentText(Object.assign({}, r, { article: POST.articleFor(r) }))
      .match(/-?\d+(?:\.\d+)?/g) || []).join(',');
    eq('and turning narration on changes no figure the page already carried',
      figures(NARRATE.attach(rec, boom)).split(',').every(f => figures(NARRATE.attach(rec, ok)).indexOf(f) >= 0), true);
  });
})().then(() => {

/* ======================================================================== */
section('10. THE RESEARCH MEMORY');
/* ======================================================================== */
(function () {
  const runs = FIX.SCENARIOS.filter(s => (s.expect || {}).verdict).map(runScenario);
  const lessons = runs.reduce((a, r) => a.concat(r.lessons), []);
  const grades = runs.map(r => r.graded);

  chk('every game produces at least one lesson', runs.every(r => r.lessons.length >= 1));
  chk('and every lesson names a category from the closed list',
    lessons.every(l => LESSONS.CATEGORIES.indexOf(l.category) >= 0));
  chk('a lesson id is deterministic, so re-running a game replaces its rows rather than duplicating them',
    runScenario(byName('EdgeDesk wrong, thesis wrong')).lessons.map(l => l.id).join(',')
    === runScenario(byName('EdgeDesk wrong, thesis wrong')).lessons.map(l => l.id).join(','));

  const mem = LESSONS.memory({ lessons, grades, now: NOW });
  eq('the four quadrants are counted', mem.quadrants.right_right >= 1, true);
  chk('including the dangerous one', mem.quadrants.right_wrong >= 1, JSON.stringify(mem.quadrants));
  chk('and the one that should change the least', mem.quadrants.wrong_right >= 1);
  chk('a question with too small a sample says so rather than producing a percentage',
    /Not enough/.test(mem.answers['What share of winning wagers had incorrect reasoning?']),
    mem.answers['What share of winning wagers had incorrect reasoning?']);
  has(mem.caveat, 'not a betting record', 'and the whole memory says what it is not');

  /* MODEL-REVIEW CANDIDATES ARE RAISED BY EVIDENCE AND CLOSED BY A PERSON. */
  const cands = LESSONS.reviewCandidates(lessons, [], { now: NOW });
  chk('a contradicted weighted claim opens a review candidate', cands.length >= 1);
  chk('each carries the evidence that raised it', cands.every(c => c.evidence.length >= 1));
  has(cands[0].rule, 'only a person may close one', 'and says so on the record');
  const again = LESSONS.reviewCandidates(lessons, cands, { now: NOW });
  eq('re-running does not duplicate the evidence', again[0].evidence.length, cands[0].evidence.length);
  const closed = cands.map(c => Object.assign({}, c, { status: 'closed', disposition: 'wont_fix' }));
  const afterClose = LESSONS.reviewCandidates(lessons, closed, { now: NOW });
  eq('and a candidate a person closed as wont_fix stays closed', afterClose[0].status, 'closed');
})();

/* ======================================================================== */
section('11. IDEMPOTENCY AND THE RUN LOG');
/* ======================================================================== */
(function () {
  const sc = byName('EdgeDesk right, thesis right');
  const a = runScenario(sc), b = runScenario(sc);
  eq('two runs produce the same snapshot', b.snap.snapshot_id, a.snap.snapshot_id);
  eq('the same article id', b.rec.id, a.rec.id);
  eq('the same slug, so there is never a second URL', b.rec.slug, a.rec.slug);
  eq('the same lessons', b.lessons.map(l => l.id).join(','), a.lessons.map(l => l.id).join(','));
  eq('and the same verdict', b.graded.verdict.key, a.graded.verdict.key);

  /* THE RUN LOG IS THE LOCK. */
  const runs = [
    { key: 'NFL:X', step: 'pregame_published', ok: true, at: '2026-09-09T10:00:00Z' },
    { key: 'NFL:Y', step: 'pregame_published', ok: false, at: '2026-09-09T10:00:00Z' }
  ];
  chk('a step that already succeeded is not run again', STORE.alreadyDone(runs, 'NFL:X', 'pregame_published'));
  chk('a step that FAILED is retried', !STORE.alreadyDone(runs, 'NFL:Y', 'pregame_published'));
  chk('and a step never attempted is run', !STORE.alreadyDone(runs, 'NFL:Z', 'pregame_published'));

  /* THE COMMITTED STORE HOLDS WHAT THE PIPELINE ACTUALLY WROTE. */
  const featured = STORE.loadFeatured();
  chk('the featured store carries its settings', !!featured.settings.thresholds.NFL);
  chk('and a weekly cap', !!featured.settings.weekly_caps.NFL);
  chk('every stored featured row carries its own itemised score',
    featured.games.every(g => Array.isArray(g.priority_components)));
  chk('and no stored row carries a broadcaster', featured.games.every(g => g.network === null));
  if (featured.games.length) {
    chk('a stored row names why it was or was not selected',
      featured.games.every(g => !!g.selection_note || g.manual_override));
  }
})();

/* ======================================================================== */
section('12. THE BUILD STILL WORKS WITH BOTH KINDS OF ARTICLE IN THE STORE');
/* ======================================================================== */
(function () {
  /* A postgame record must survive the round trip the store makes every
     record take: compact to disk, hydrate on read, rebuild its sections. */
  const out = runScenario(byName('EdgeDesk right, thesis right'));
  const onDisk = AMODEL.compact(out.rec);
  chk('the derived half is not written twice', onDisk.article === undefined);
  chk('but the payload halves are all stored',
    !!onDisk.snapshot && !!onDisk.result && !!onDisk.grading && !!onDisk.audit && !!onDisk.lessons);
  const back = AMODEL.hydrate(JSON.parse(JSON.stringify(onDisk)));
  chk('and it comes back with its postgame sections, not pregame ones',
    back.article.sections.some(s => s.kind === 'thesis_audit'));
  eq('through the type registry', AMODEL.typeOf(back), 'postgame');

  /* AND AN UNREGISTERED TYPE CANNOT PUBLISH. */
  const unknown = Object.assign({}, onDisk, { article_type: 'something_else' });
  eq('a record of an unregistered type fails its checks', AMODEL.publishable(unknown).ok, false);
  has(AMODEL.publishable(unknown).failed[0].why, 'no registered publication checks',
    'so nothing can vouch for it');

  /* THE MANIFEST DISTINGUISHES THE TWO. */
  const idx = ASTORE.buildIndex(ASTORE.loadAll().concat([out.rec]), { now: NOW });
  chk('the manifest counts both kinds', idx.counts.pregame > 0 && idx.counts.postgame > 0,
    JSON.stringify(idx.counts));
  const row = idx.articles.filter(r => r.id === out.rec.id)[0];
  eq('and a postgame row says so', row.article_type, 'postgame');
  eq('carrying the two figures a card wants without the payload', row.bet_result, 'WIN');
  eq('and the process grade beside it', row.process_grade, 'SOUND');
})();

/* ======================================================================== */
section('13. THE OPERATOR SURFACE');
/* ======================================================================== */
(function () {
  const f = path.join(ROOT, 'admin', 'articles', 'index.html');
  const A = fs.readFileSync(f, 'utf8');
  has(A, 'data-tab="editorial"', 'the manager has an editorial tab');
  ['Feature', 'Unfeature', 'Disable pregame', 'Disable postgame',
    'Copy regenerate command', 'The last editorial run',
    'Model-review candidates', 'The research memory'].forEach(w => {
    has(A, w, 'the editorial screen offers ' + w);
  });
  has(A, 'editorial_featured_games', 'an operator decision is written to the decision table');
  has(A, '--force', 'and the regenerate command uses the idempotency override');
  /* IT DISPLAYS, IT DOES NOT COMPUTE. */
  chk('the operator screen never scores a game itself',
    !/editorial_priority\s*=\s*[^=]|priorityFor\(|scoreSlate\(/.test(A));
  chk('and never grades one',
    !/processGrade\(|gradeSpread\(|outcomeFromScore\(/.test(A));
  /* IT SAYS SO WHEN IT CANNOT SAVE, rather than pretending. */
  has(A, 'is not reachable from this account', 'an unreachable decision table is reported, not swallowed');
  /* AND IT CARRIES NOTHING PRIVILEGED. */
  chk('the editorial screen ships no service-role key',
    !/service_role|SERVICE_ROLE|sb_secret/.test(A));
  /* the inline script still parses after the addition */
  const blocks = [...A.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((b, i) => {
    chk('the manager’s inline script block ' + i + ' parses',
      (() => { try { new Function(b); return true; } catch (e) { return String(e.message); } })() === true);
  });

  /* THE WORKFLOW. */
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'editorial.yml'), 'utf8');
  has(wf, 'node tools/editorial/editorial.test.js', 'the workflow runs the suite before it is allowed to write');
  has(wf, 'concurrency', 'and serialises itself so two runs cannot race into one commit');
  chk('narration is opt-in twice over: a flag and a key',
    /inputs.narrate.*=.*'true'.*\n.*ANTHROPIC_API_KEY/s.test(wf) || /narrate.*ANTHROPIC_API_KEY/s.test(wf));
  chk('the workflow needs no secret to run', /none are required/.test(wf));

  /* THE MIGRATION, read as text: the rules that must be in it. */
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'editorial_system.sql'), 'utf8');
  chk('the migration carries no psql meta-command', !/^\s*\\/m.test(sql));
  chk('it is one transaction', /^begin;/m.test(sql) && /^commit;/m.test(sql));
  chk('and ends in a report', /select\s+1\s+as\s+step/.test(sql) && sql.indexOf("'ok'") > 0);
  has(sql, 'editorial_snapshots_immutable', 'a snapshot is made immutable by a trigger, not by a policy');
  has(sql, 'editorial_reviews_guard', 'and only a person may close a review candidate');
  chk('no policy lets anon write anything',
    !/create policy[^;]*on public\.editorial_[^;]*for (insert|update|delete)[^;]*to [^;]*anon/i.test(sql));
  chk('there is no update policy on the snapshots for anybody',
    !/create policy[^;]*on public\.editorial_snapshots[^;]*for update/i.test(sql));
  has(sql, 'NO BROADCASTER COLUMN', 'and the schema says why it holds no network');
})();

/* ======================================================================== */
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | edgedesk editorial | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
  process.exit(fail ? 1 : 0);
}).catch(e => {
  console.log('\nFAIL | edgedesk editorial | harness threw: ' + (e && e.stack || e));
  process.exit(1);
});
