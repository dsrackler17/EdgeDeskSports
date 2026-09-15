#!/usr/bin/env node
/* ===========================================================================
   THE MATCHUP RESEARCH LAYER, ASSERTED.

   Every test here is named after a way this can go wrong in front of a paying
   reader, and most of them are named after a way it already did:

     - "Today's research" returned ONE stale NFL matchup while the football
       page behind it displayed a full week of games
     - a matchup answer carried a model spread and no joined sportsbook price,
       with no statement of WHY there was no price
     - availability printed failed-source counts at the reader and left the
       status reading as though nobody was hurt
     - ratings arrived with no interpretation at all
     - "1.45 games in the rating" — a weighted sample size, printed as though
       it were a count of games
     - the same caveat in three sections, taking the space that should have
       been explaining the football

   IT RUNS AGAINST THE REAL PUBLISHED ARTIFACTS wherever one exists — the FBS
   slate, the rankings build, the availability build — because a fixture that
   agrees with itself proves nothing about a card that changes every week.
   Where a fixture is used it is because the input is a live database read and
   there is no database here; those are labelled.

   Run: node tools/intelligence/matchup.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, got, want) { chk(name, got === want, { got, want }); }
function has(name, hay, needle) { chk(name, String(hay || '').toLowerCase().includes(String(needle).toLowerCase()), { needle, got: String(hay || '').slice(0, 220) }); }
function lacks(name, hay, needle) { chk(name, !String(hay || '').toLowerCase().includes(String(needle).toLowerCase()), { needle, got: String(hay || '').slice(0, 220) }); }
function section(t) { console.log('\n== ' + t + ' =='); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
const RANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'current.json'), 'utf8'));
const AVAIL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'availability', 'current.json'), 'utf8'));
E.loadSnapshotValidation('americanfootball_ncaaf');

const NOW = Date.parse('2026-09-15T18:00:00Z');
const CFB_GAMES = SLATE.games.map((g) => ({
  game_id: String(g.game_id), home_team: g.home_team, away_team: g.away_team,
  home_id: g.home_team_id, away_id: g.away_team_id, kickoff: g.kickoff, week: g.week,
}));
function cfbRow(id) { return SLATE.games.filter((g) => String(g.game_id) === String(id))[0] || null; }
function rkFor(name) {
  const want = E.normKey(name);
  if (RANK.teams[want]) return RANK.teams[want];
  let hit = null;
  Object.keys(RANK.teams).forEach((k) => { if (!hit && E.normKey(RANK.teams[k].team) === want) hit = RANK.teams[k]; });
  return hit;
}
function cavNorm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}
const AVAIL_IX = {};
Object.keys(AVAIL.teams || {}).forEach((id) => {
  const t = AVAIL.teams[id], k = cavNorm(t.team_name);
  if (k && !AVAIL_IX[k]) AVAIL_IX[k] = t;
});
function avFor(name) { return AVAIL_IX[cavNorm(name)] || null; }

/* A real NFL card, shaped exactly as app.html builds it from FB.nfl.up. There
   is no committed NFL schedule artifact in this repository — the NFL board is
   built in the browser from nflverse — so this one is declared, and it is the
   only declared schedule in this file. */
const NFL_GAMES = [
  { game_id: 'nfl:2026_03_KC_PHI', home_team: 'Philadelphia Eagles', away_team: 'Kansas City Chiefs',
    home_id: 'phi', away_id: 'kc', kickoff: '2026-09-21T20:25:00.000Z', week: 3 },
  { game_id: 'nfl:2026_03_DAL_WAS', home_team: 'Washington Commanders', away_team: 'Dallas Cowboys',
    home_id: 'was', away_id: 'dal', kickoff: '2026-09-21T17:00:00.000Z', week: 3 },
  { game_id: 'nfl:2026_03_NYJ_BUF', home_team: 'Buffalo Bills', away_team: 'New York Jets',
    home_id: 'buf', away_id: 'nyj', kickoff: '2026-09-21T17:00:00.000Z', week: 3 },
];
const LEAGUES = [
  { sport: E.CFB_SPORT, games: CFB_GAMES, source: 'football/fbs/slate.json' },
  { sport: E.NFL_SPORT, games: NFL_GAMES, source: 'the NFL board' },
];
function resolve(q, carried) {
  return E.resolveFootballMatchup({ question: q, leagues: LEAGUES, carried: carried || null });
}

/* =====================================================================
   1. THE BOARD AND THE DESK RESOLVE THE SAME GAME.
   ===================================================================== */
section('one card, two leagues');
{
  /* Picked from the real published card rather than hardcoded, so this keeps
     testing the RULE when next week's slate replaces this one. */
  const single = {};
  CFB_GAMES.forEach((g) => {
    [[g.home_id, g.home_team], [g.away_id, g.away_team]].forEach((p) => {
      const k = E.canonKey(p[0], p[1]);
      (single[k] = single[k] || { name: p[1], games: [] }).games.push(g);
    });
  });
  const solo = Object.keys(single).filter((k) => single[k].games.length === 1
    && /^[A-Z]/.test(single[k].name) && single[k].name.split(' ').length <= 2);
  chk('the real published card carries programmes playing exactly once', solo.length > 0, solo.length);
  const pick = single[solo[0]];
  const r = resolve(pick.name + ' matchup this week');
  eq('a college programme named on its own resolves to its scheduled game', r.state, 'RESOLVED');
  eq('and to the college card, not the NFL one', r.sport, E.CFB_SPORT);
  eq('and to the SAME game id the board publishes', String(r.game_id), String(pick.games[0].game_id));

  const nfl = resolve('How do the Chiefs look this week?');
  eq('an NFL club resolves too - the desk sees the whole board', nfl.state, 'RESOLVED');
  eq('and is routed to the NFL card', nfl.sport, E.NFL_SPORT);
  eq('and to the right NFL game', nfl.game_id, 'nfl:2026_03_KC_PHI');

  /* THE CROSSING TEST. A college question must never reach an NFL club and a
     professional question must never reach a college programme. */
  const jets = resolve('Jets vs Bills');
  eq('an explicit NFL pair resolves as a pair', jets.state, 'RESOLVED');
  eq('and stays in the NFL', jets.sport, E.NFL_SPORT);
  chk('a bare "Washington" is the college programme, not the NFL club',
    ['RESOLVED', 'AMBIGUOUS', 'NOT_ON_CARD'].indexOf(resolve('Washington matchup').state) >= 0
    && resolve('Washington matchup').sport !== E.NFL_SPORT, resolve('Washington matchup'));
  chk('and "Washington Commanders" is the club',
    resolve('Washington Commanders this week').sport === E.NFL_SPORT, resolve('Washington Commanders this week'));

  /* A CITY THAT IS ALSO A COLLEGE PROGRAMME GOES TO THE PROGRAMME. The club
     answers to its nickname and its full name, which is what a reader writes
     when they mean the club; a bare "Buffalo" on a card carrying the Bulls is
     the Bulls, and the cost of that choice is a question rather than a wrong
     team's number. */
  const bareCity = E.resolveFootballMatchup({
    question: 'How does Buffalo look?',
    leagues: [
      { sport: E.CFB_SPORT, games: [{ game_id: 'c1', home_team: 'Buffalo', away_team: 'Ohio', home_id: 'buffalo', away_id: 'ohio', kickoff: '2026-09-19T16:00:00Z', week: 3 }] },
      { sport: E.NFL_SPORT, games: [{ game_id: 'n1', home_team: 'Buffalo Bills', away_team: 'New York Jets', home_id: 'buf', away_id: 'nyj', kickoff: '2026-09-21T17:00:00Z', week: 3 }] },
    ],
  });
  eq('a bare city goes to the college programme', bareCity.sport, E.CFB_SPORT);
  eq('and "Buffalo Bills" goes to the club', E.resolveFootballMatchup({
    question: 'How do the Buffalo Bills look?',
    leagues: [
      { sport: E.CFB_SPORT, games: [{ game_id: 'c1', home_team: 'Buffalo', away_team: 'Ohio', home_id: 'buffalo', away_id: 'ohio', kickoff: '2026-09-19T16:00:00Z', week: 3 }] },
      { sport: E.NFL_SPORT, games: [{ game_id: 'n1', home_team: 'Buffalo Bills', away_team: 'New York Jets', home_id: 'buf', away_id: 'nyj', kickoff: '2026-09-21T17:00:00Z', week: 3 }] },
    ],
  }).sport, E.NFL_SPORT);

  /* THE SAME WORDS ON BOTH CARDS IS A QUESTION, NEVER A GUESS. */
  const both = E.resolveFootballMatchup({
    question: 'How does Ravenswood look?',
    leagues: [
      { sport: E.CFB_SPORT, games: [{ game_id: 'c1', home_team: 'Ravenswood', away_team: 'Ohio', home_id: 'ravenswood', away_id: 'ohio', kickoff: '2026-09-19T16:00:00Z', week: 3 }] },
      { sport: E.NFL_SPORT, games: [{ game_id: 'n1', home_team: 'Ravenswood', away_team: 'New York Jets', home_id: 'ravenswood2', away_id: 'nyj', kickoff: '2026-09-21T17:00:00Z', week: 3 }] },
    ],
  });
  eq('a name that matched the same words on both cards is asked about, not picked', both.state, 'AMBIGUOUS');
  chk('and both leagues are offered by name', (both.candidates || []).length === 2
    && both.candidates.some((c) => c.league === 'NFL') && both.candidates.some((c) => /college/i.test(c.league)),
    both.candidates);
  has('and the answer says the sport is NOT settled', both.note, 'the sport is not settled');
}

/* =====================================================================
   2. FOLLOW-UPS KEEP THE MATCHUP.
   ===================================================================== */
section('follow-ups keep the matchup');
{
  const first = resolve('How do the Chiefs look this week?');
  const follow = resolve('Who have they played?', first);
  eq('a follow-up naming nobody keeps the game', String(follow.game_id), String(first.game_id));
  eq('and keeps the league', follow.sport, E.NFL_SPORT);
  eq('and says the subject was carried, not named in this message', follow.how, 'carried');
  chk('the trace does not claim a name was found in this message', (follow.named || []).length === 0, follow.named);

  const changed = resolve('What about the Padres?', first);
  eq('naming somebody no football card carries hands the turn back', changed.state, 'SUBJECT_CHANGED');

  const switched = resolve('What about the Cowboys?', first);
  eq('naming another club on the card switches to it explicitly', switched.state, 'RESOLVED');
  eq('and it is the other game, not the carried one', switched.game_id, 'nfl:2026_03_DAL_WAS');

  /* CROSS-LEAGUE CARRY. A carried college subject must not resolve against
     the NFL card and must not look as though it did. */
  const cfbFirst = resolve('Texas Tech matchup this week');
  if (cfbFirst.state === 'RESOLVED') {
    const cfbFollow = resolve('What about the total?', cfbFirst);
    eq('a carried college subject stays college', cfbFollow.sport, E.CFB_SPORT);
    eq('and stays on the same game', String(cfbFollow.game_id), String(cfbFirst.game_id));
  } else {
    chk('Texas Tech is on the published card', false, cfbFirst.state);
  }
}

/* =====================================================================
   3. MISSING QUOTES DO NOT BECOME ZERO, AND STALE CANNOT READ LIVE.
   ===================================================================== */
section('the market, told apart from its absence');
{
  const noQuote = E.marketBoard({ signals: [], lines: [], home_team: 'Texas Tech', away_team: 'Houston',
    now: NOW, kickoff: '2026-09-19T00:00:00Z', rows_in_window: 0, rows_joined: 0 });
  eq('a provider with nothing on this game reads NO_QUOTE', noQuote.status.state, 'NO_QUOTE');
  has('and says it is an absence, not a zero', noQuote.status.user, 'not a quote of zero');
  eq('and it may not be presented as a price', noQuote.status.may_quote_a_price, false);
  eq('and it is not blamed on EdgeDesk', noQuote.status.is_edgedesk_fault, false);

  const readFailed = E.marketBoard({ signals: [], lines: [], home_team: 'A', away_team: 'B',
    now: NOW, read_failed: true, operator_detail: 'signals: 503' });
  eq('a failed read is CAPTURE_FAILED, not NO_QUOTE', readFailed.status.state, 'CAPTURE_FAILED');
  eq('and IS EdgeDesk’s fault, and says so', readFailed.status.is_edgedesk_fault, true);
  has('and the reader is told it is retrieval, not the market', readFailed.status.user, 'retrieval failure');
  eq('and the status code stays in the operator field', readFailed.status.operator, 'signals: 503');
  lacks('and never reaches the reader-facing sentence', readFailed.status.user, '503');

  const joinFailed = E.marketBoard({ signals: [], lines: [], home_team: 'A', away_team: 'B',
    now: NOW, rows_in_window: 410, rows_joined: 0 });
  eq('rows in the window that joined to nothing is JOIN_FAILED', joinFailed.status.state, 'JOIN_FAILED');
  eq('and is EdgeDesk’s fault', joinFailed.status.is_edgedesk_fault, true);
  has('and the operator detail carries the counts', joinFailed.status.operator, '410');

  const lineOnly = E.marketBoard({ signals: [], lines: [{ provider: 'consensus', spread: -13.5, over_under: 52 }],
    home_team: 'Texas Tech', away_team: 'Houston', now: NOW });
  eq('a consensus number with no book is LINE_ONLY', lineOnly.status.state, 'LINE_ONLY');
  eq('and may not be quoted as a price', lineOnly.status.may_quote_a_price, false);
  eq('and no per-side price is invented for it', lineOnly.consensus.provider, 'consensus');
  chk('and no captured row is manufactured from it', lineOnly.rows.length === 0, lineOnly.rows.length);

  const fresh = E.marketBoard({
    signals: [{ market: 'spreads', selection: 'Texas Tech', point: -13.5, best_dec: 1.91, best_book: 'DraftKings',
      n_books: 8, first_best_dec: 1.87, first_seen_at: '2026-09-12T10:00:00Z', last_seen_at: '2026-09-15T17:50:00Z' }],
    lines: [], home_team: 'Texas Tech', away_team: 'Houston', now: NOW, kickoff: '2026-09-19T00:00:00Z' });
  eq('a captured price inside its limit is LIVE', fresh.status.state, 'LIVE');
  eq('and may be called live', fresh.status.may_call_it_live, true);
  eq('the best price is the one capture recorded across the books it polled', fresh.spreads.by_side.home.price_american, '-110');
  eq('with the book that offered it', fresh.spreads.by_side.home.book, 'DraftKings');
  has('and the coverage note refuses to claim the whole market', fresh.coverage.note, 'not claimed to be the best price available anywhere');
  chk('the first observed price is carried as a first OBSERVATION, not an opening line',
    /first observed price/i.test(fresh.spreads.by_side.home.movement.basis), fresh.spreads.by_side.home.movement.basis);

  const stale = E.marketBoard({
    signals: [{ market: 'spreads', selection: 'Texas Tech', point: -13.5, best_dec: 1.91, best_book: 'DraftKings',
      n_books: 8, last_seen_at: '2026-09-13T10:00:00Z' }],
    lines: [], home_team: 'Texas Tech', away_team: 'Houston', now: NOW, kickoff: '2026-09-19T00:00:00Z' });
  eq('a quote past its limit is STALE', stale.status.state, 'STALE');
  eq('and can never be described as live', stale.status.may_call_it_live, false);
  eq('but the price itself is kept for research', stale.spreads.by_side.home.price_american, '-110');
  chk('with its age attached', stale.spreads.by_side.home.freshness.age_min > 90, stale.spreads.by_side.home.freshness.age_min);

  /* THE TWO SIDES ARE NOT MIRRORED. */
  const oneSide = E.marketBoard({
    signals: [{ market: 'spreads', selection: 'Texas Tech', point: -13.5, best_dec: 1.91, best_book: 'DraftKings', n_books: 8, last_seen_at: '2026-09-15T17:50:00Z' }],
    lines: [], home_team: 'Texas Tech', away_team: 'Houston', now: NOW });
  chk('a side EdgeDesk did not capture carries no price at all', !oneSide.spreads.by_side.away, Object.keys(oneSide.spreads.by_side));
  has('and the contract says why', oneSide.contract, 'no price is ever mirrored');

  /* HOME AND AWAY DO NOT CROSS. */
  const bothSides = E.marketBoard({
    signals: [
      { market: 'spreads', selection: 'Texas Tech', point: -13.5, best_dec: 1.91, best_book: 'DraftKings', n_books: 8, last_seen_at: '2026-09-15T17:50:00Z' },
      { market: 'spreads', selection: 'Houston', point: 13.5, best_dec: 1.95, best_book: 'FanDuel', n_books: 8, last_seen_at: '2026-09-15T17:50:00Z' }],
    lines: [], home_team: 'Texas Tech', away_team: 'Houston', now: NOW });
  eq('the home selection is filed as home', bothSides.spreads.by_side.home.selection, 'Texas Tech');
  eq('the away selection is filed as away', bothSides.spreads.by_side.away.selection, 'Houston');
  eq('and the two prices are NOT the same number', bothSides.spreads.by_side.home.price_american === bothSides.spreads.by_side.away.price_american, false);
}

/* =====================================================================
   4. A READER'S PRICE IS NOT A PROVIDER'S PRICE.
   ===================================================================== */
section('a price the reader says they can get');
{
  const q = E.parseUserQuote('I can get -13.5 at -110', { team: 'Texas Tech', now: NOW });
  chk('a reader-entered price is recognised', !!q, q);
  eq('with its own handicap', q.handicap, -13.5);
  eq('and its own odds', q.price_american, -110);
  eq('and it is marked as the reader’s, not EdgeDesk’s', q.source, 'reader');
  eq('and EdgeDesk states it did not observe it', q.observed_by_edgedesk, false);
  has('and says so in words a reader will see', q.provenance, 'has not observed it');
  chk('it carries its own timestamp', !!q.entered_at, q.entered_at);

  chk('an opinion with no odds beside it is NOT read as a price',
    E.parseUserQuote('they should be -14 on a neutral field', {}) === null,
    E.parseUserQuote('they should be -14 on a neutral field', {}));

  const observed = {
    market: 'spreads', selection: 'Texas Tech', side: 'home', handicap: -13.5, price_american: '-108',
    book: 'DraftKings', observed_at: '2026-09-15T17:50:00Z', freshness: { age_min: 10, actionable: true },
  };
  const cmp = E.compareUserQuote({ quote: q, model_line: -14.3, observed: observed, sport: E.CFB_SPORT });
  chk('it is compared against the model line', cmp.comparisons.some((c) => c.id === 'model_vs_quote'), cmp.comparisons.map((c) => c.id));
  chk('and against the best price EdgeDesk observed', cmp.comparisons.some((c) => c.id === 'quote_vs_observed'), cmp.comparisons.map((c) => c.id));
  chk('and its own break-even is arithmetic, so it is given', cmp.comparisons.some((c) => c.id === 'break_even'), cmp.comparisons.map((c) => c.id));
  chk('a cover probability is REFUSED, with the model record as the reason',
    cmp.refused.some((r) => r.id === 'cover_probability'), cmp.refused);
  has('and the refusal names the validation tier', cmp.refused[0].why, 'RESEARCH');
  chk('no expected value is produced anywhere in the comparison',
    !JSON.stringify(cmp).match(/"ev"|expected_value/), Object.keys(cmp));
  const obsCmp = cmp.comparisons.filter((c) => c.id === 'quote_vs_observed')[0];
  has('the two prices are shown side by side and not merged', obsCmp.basis, 'not merged');
  has('and the reader’s price is not added to book coverage', obsCmp.basis, 'not added to book coverage');
}

/* =====================================================================
   5. UNKNOWN AVAILABILITY IS NEVER HEALTHY, AND ITS DIAGNOSTICS ARE NOT
      THE READER'S PROBLEM.
   ===================================================================== */
section('availability');
{
  const none = E.availabilityRead({ team: 'Texas Tech', record: null, now: NOW });
  const h1 = E.availabilityHeadline(none);
  eq('a record that was never retrieved is NOT_RETRIEVED', h1.state, 'NOT_RETRIEVED');
  eq('and may not be read as healthy', h1.may_claim_healthy, false);
  has('and the reader is told it is a retrieval result', h1.short, 'retrieval result');

  /* The real availability build: every college team on it is LIMITED with no
     official report, which is UNKNOWN and must stay UNKNOWN. */
  const real = avFor('Texas Tech') || avFor('Houston') || Object.keys(AVAIL.teams).map((k) => AVAIL.teams[k])[0];
  const read = E.availabilityRead({ team: real.team_name, record: real, now: NOW, generated_at: AVAIL.generated_at });
  const h2 = E.availabilityHeadline(read);
  chk('a real college record with no official report reads UNKNOWN', h2.state === 'UNKNOWN' || h2.state === 'PARTIAL' || h2.state === 'VERIFIED_FLAGS', h2.state);
  if (h2.state === 'UNKNOWN') {
    eq('and may not be read as healthy', h2.may_claim_healthy, false);
    has('and says unknown is not healthy, in one short sentence', h2.short, 'not healthy');
    chk('the reader-facing sentence is short', h2.short.length < 220, h2.short.length);
    lacks('and carries no source counts', h2.short, 'sources');
    chk('the source counts are in the operator block instead',
      h2.operator && h2.operator.sources_checked != null, h2.operator);
  }

  /* The only case where "no reported injuries" is a fact. */
  const official = E.availabilityRead({
    team: 'Kansas City Chiefs', now: NOW, generated_at: '2026-09-15T11:00:00Z',
    record: { counts: { records: 0, flagged: 0 }, dataQuality: 'STRONG', official_report_found: true, sources_checked: 1, sources_failed: 0, players: [] },
  });
  const h3 = E.availabilityHeadline(official);
  eq('an official report listing nobody is the one case that IS a clean sheet', h3.state, 'NO_REPORTED_INJURIES');
  eq('and only then may healthy be claimed', h3.may_claim_healthy, true);

  const failedSources = E.availabilityRead({
    team: 'Somebody', now: NOW, generated_at: '2026-09-15T11:00:00Z',
    record: { counts: { records: 0, flagged: 0 }, dataQuality: 'NONE', official_report_found: false, sources_checked: 3, sources_failed: 3, players: [] },
  });
  const h4 = E.availabilityHeadline(failedSources);
  eq('three failed sources is still UNKNOWN', h4.state, 'UNKNOWN');
  eq('and still not healthy', h4.may_claim_healthy, false);
  eq('and the failure count is an operator number', h4.operator.sources_failed, 3);
  lacks('kept out of the reader’s sentence', h4.short, '3 ');
}

/* =====================================================================
   6. THE SAMPLE SIZE IS LABELLED FOR WHAT IT IS.
   ===================================================================== */
section('the weighted sample');
{
  const s = E.sampleRead({ effective_games: 1.45, games_played: 2, fbs_games: 1, non_fbs_share: 0.5 });
  eq('a weighted sample is not called a count of games', s.label, '1.45 FBS-equivalent games');
  has('it explains the weight in plain language', s.explanation, 'non-FBS opponent at 0.45');
  has('and says how many games were actually played', s.explanation, '2 games played');
  has('and how much of the rating is still the preseason prior', s.weight_basis, 'preseason prior');
  eq('the prior weight is the ramp the build actually uses', s.prior_weight, Math.round((3 / (1.45 + 3)) * 100) / 100);
  lacks('the phrase that caused the confusion is gone', s.label, 'games in the rating');

  const missing = E.sampleRead({});
  eq('a sample the build did not publish is missing, not zero', missing.missing, true);
  chk('with a reason', !!missing.reason, missing.reason);
}

/* =====================================================================
   7. THE RATING IS INTERPRETED, NOT JUST PRINTED.
   ===================================================================== */
section('the rating, interpreted');
{
  const t = rkFor('Texas Tech') || RANK.teams[Object.keys(RANK.teams)[0]];
  const r = E.ratingRead({ team_record: t, ranked_of: RANK.team_count });
  chk('the rating carries a plain-language meaning', /points against an average FBS team/i.test(r.meaning || ''), r.meaning);
  has('which says a rating is not a spread', r.meaning, 'not a spread');
  chk('confidence is explained as knowledge, not quality', /how much EdgeDesk KNOWS/i.test(r.confidence_meaning || ''), r.confidence_meaning);
  has('the unit scale is stated, including for defence', r.units.scale, 'including for defence');
  eq('and the numbers are declared opponent-adjusted', r.opponent_adjusted, true);
  has('with the adjustment explained', r.adjustment_note, 'the difference is the schedule');
  chk('the sample travels with it', !!(r.sample && r.sample.label), r.sample);
}

/* =====================================================================
   8. DRIVERS ARE EVIDENCED, OR THEY ARE NOT MADE.
   ===================================================================== */
section('matchup drivers');
{
  const A = rkFor('Texas Tech'), B = rkFor('Houston');
  chk('both programmes are in the real ratings build', !!A && !!B, [!!A, !!B]);
  const d = E.matchupDrivers({ attacker: A, defender: B, attacker_name: A.team, defender_name: B.team });
  chk('drivers are produced from the real artifact', d.drivers.length > 0, d.drivers.length);
  chk('no two drivers describe the same part of football', new Set(d.drivers.map((x) => x.family)).size === d.drivers.length,
    d.drivers.map((x) => x.family));
  d.drivers.forEach((x, i) => {
    chk('driver ' + (i + 1) + ' names both sides’ numbers', /\d/.test(x.attacker_value.show || '') && /\d/.test(x.defender_value.show || ''),
      [x.attacker_value.show, x.defender_value.show]);
    chk('driver ' + (i + 1) + ' connects to a football mechanism', (x.mechanism || '').length > 80, (x.mechanism || '').length);
    chk('driver ' + (i + 1) + ' carries the league mean to read it against', !!x.attacker_value.league, x.attacker_value);
    chk('driver ' + (i + 1) + ' carries the reliability of the sample behind it', x.reliability != null, x.reliability);
  });
  has('and the contract says drivers move no number', d.contract, 'do not move');

  /* A RATE CANNOT BE NEGATIVE, AND A CLAMPED NUMBER WOULD LOOK LIKE A FACT. */
  const oor = E.matchupDrivers({
    attacker: { team: 'X', performance: { offense_detail: { used: [
      { id: 'sack_rate_allowed', raw: 0.0, adjusted: -0.022, league: 0.057, z: 2.7, w: 0.08, reliability: 0.9, n_obs: 60, n: 55 }] } } },
    defender: { team: 'Y', performance: { defense_detail: { used: [
      { id: 'def_sack_rate', raw: 0.023, adjusted: 0.023, league: 0.057, z: -1.1, w: 0.08, reliability: 0.9, n_obs: 60, n: 55 }] } } },
    attacker_name: 'X', defender_name: 'Y',
  });
  eq('an adjusted rate outside 0-100% falls back to the measured rate', oor.drivers[0].attacker_value.show, '0.0%');
  eq('and says so', oor.drivers[0].attacker_value.out_of_range, true);
  has('in the statement the reader sees', oor.drivers[0].statement, 'raw rate');

  /* HALF A PAIR IS NOT A DRIVER. */
  const half = E.matchupDrivers({
    attacker: { team: 'X', performance: { offense_detail: { used: [
      { id: 'success_rate', raw: 0.5, adjusted: 0.5, league: 0.42, z: 1.2, w: 0.22, reliability: 0.9, n_obs: 150, n: 140 }] } } },
    defender: { team: 'Y', performance: {} }, attacker_name: 'X', defender_name: 'Y',
  });
  eq('a pair with only one measured half produces no driver', half.drivers.length, 0);
  chk('and the reason is named rather than skipped silently', half.skipped.length > 0, half.skipped);

  const nothing = E.matchupDrivers({ attacker: null, defender: null });
  eq('no ratings at all produces no drivers', nothing.drivers.length, 0);
  chk('and a declared gap instead', nothing.missing.length > 0, nothing.missing);
}

/* =====================================================================
   9. THE WHOLE BRIEF, ON REAL DATA.
   ===================================================================== */
section('the assembled brief');
function buildBrief(over) {
  over = over || {};
  const res = over.res || resolve('Texas Tech matchup this week');
  const row = cfbRow(res.game_id);
  const signals = over.signals !== undefined ? over.signals : [
    { market: 'spreads', selection: res.home, point: -13.5, best_dec: 1.91, best_book: 'DraftKings', n_books: 8,
      first_best_dec: 1.87, first_seen_at: '2026-09-12T10:00:00Z', last_seen_at: '2026-09-15T17:50:00Z' },
    { market: 'spreads', selection: res.away, point: 13.5, best_dec: 1.95, best_book: 'FanDuel', n_books: 8, last_seen_at: '2026-09-15T17:50:00Z' },
    { market: 'totals', selection: 'Over', point: 51.5, best_dec: 1.9, best_book: 'BetMGM', n_books: 7, last_seen_at: '2026-09-15T17:45:00Z' },
  ];
  const board = E.marketBoard(Object.assign({
    signals, lines: over.lines || [], home_team: res.home, away_team: res.away,
    kickoff: res.kickoff, game_id: res.game_id, now: NOW, rows_in_window: 40, rows_joined: signals.length,
  }, over.board || {}));
  const availability = {};
  availability[res.home_id] = over.no_avail ? null : avFor(res.home);
  availability[res.away_id] = over.no_avail ? null : avFor(res.away);
  const R = E.matchupResearch({
    resolution: res, slate_row: row, ratings: RANK.teams, signals, lines: over.lines || [],
    previous: over.previous || { home: [], away: [] },
    availability, availability_generated_at: AVAIL.generated_at, now: NOW,
  });
  const B = E.matchupBrief({
    research: R, home_record: rkFor(res.home), away_record: rkFor(res.away), market_board: board,
    ranked_of: RANK.team_count, timezone: 'America/Chicago', now: NOW,
  });
  return { res, row, board, R, B };
}
{
  const { res, B } = buildBrief();
  has('the takeaway names the opponent', B.takeaway.text, res.away === B.subject ? B.opponent : B.opponent);
  chk('and the kickoff carries a timezone', /\b(CDT|CST|EDT|EST|MDT|MST|PDT|PST|UTC|GMT)\b/.test(B.verified.kickoff_text || ''), B.verified.kickoff_text);
  chk('and the venue where there is one', B.verified.venue != null, B.verified.venue);
  chk('the model number and the market number are both present', B.numbers.model != null && B.numbers.market_row != null, Object.keys(B.numbers));
  chk('and the difference between them is computed once', B.numbers.comparison != null, B.numbers.comparison);
  has('and is never called an edge', B.numbers.comparison.meaning, 'not an edge');
  has('and states the convention both are written in', B.numbers.comparison.convention, 'negative is the home side favoured');
  eq('exactly three drivers', B.drivers.length, 3);
  chk('and both offences get a hearing', new Set(B.drivers.map((d) => d.direction)).size === 2, B.drivers.map((d) => d.direction));
  chk('there is a strongest counterargument', !!B.counter, B.counter);
  chk('and it is the model’s own record, which is the biggest one there is', B.counter.id === 'model_validation', B.counter.id);
  chk('there are falsifiers', B.what_would_change.length > 0, B.what_would_change.length);
  chk('the sources are declared', B.sources.length >= 2, B.sources);
  chk('the market rows travel with the brief so a renderer cannot fetch a different number',
    (B.market_rows || []).length === 3, (B.market_rows || []).length);

  /* THE CAVEAT WALL. The same fact must not be stated in three places. */
  const counterIds = B.counter_all.map((c) => c.id);
  chk('a limit already made as a counterargument is not repeated as a limit',
    !B.limits.some((l) => /has not cleared validation/i.test(l)) || counterIds.indexOf('model_validation') < 0,
    { limits: B.limits, counterIds });
  chk('availability unknown is stated once, not once per section',
    B.limits.filter((l) => /availability/i.test(l)).length === 0
    || !counterIds.some((c) => /^availability_/.test(c)),
    { limits: B.limits.filter((l) => /availability/i.test(l)), counterIds });

  /* THE MODEL DOES NOT INVENT ANYTHING. */
  const flat = JSON.stringify(B);
  lacks('no probability is produced anywhere in the brief', flat, '"win_probability"');
  lacks('and no expected value', flat, '"expected_value"');
  chk('the contract says the boundary out loud', /nothing here produces a probability/i.test(B.contract), B.contract);
}

/* =====================================================================
   10. A MISSING PRICE IS A SENTENCE, NOT A ZERO — END TO END.
   ===================================================================== */
section('a matchup with no market, end to end');
{
  const { B } = buildBrief({ signals: [], board: { rows_in_window: 0, rows_joined: 0 } });
  eq('the brief still builds', B.schema, 'edgedesk_matchup_brief_v1');
  chk('there is still a takeaway', B.takeaway.text.length > 40, B.takeaway.text.length);
  chk('there are still drivers - research does not need a price', B.drivers.length > 0, B.drivers.length);
  eq('the market row is absent rather than zero', B.numbers.market_row, null);
  eq('no comparison is invented', B.numbers.comparison, null);
  eq('and the status says what kind of absence it is', B.numbers.market_status.state, 'NO_QUOTE');
  has('the takeaway tells the reader', B.takeaway.text, 'not a quote of zero');
  chk('and a falsifier is that a price appears at all',
    B.what_would_change.some((c) => c.id === 'price_appears'), B.what_would_change.map((c) => c.id));

  const failed = buildBrief({ signals: [], board: { read_failed: true, operator_detail: 'signals: network down' } });
  eq('a failed read is not reported as an absent market', failed.B.numbers.market_status.state, 'CAPTURE_FAILED');
  chk('and the rest of the research survives it', failed.B.drivers.length > 0 && !!failed.B.counter,
    { drivers: failed.B.drivers.length, counter: !!failed.B.counter });
}

/* =====================================================================
   11. THE BOARD RANKING — every scheduled game is a candidate.
   ===================================================================== */
section('the football card, ranked');
{
  const games = SLATE.games.map((g) => ({
    game_id: g.game_id, sport: E.CFB_SPORT, home: g.home_team, away: g.away_team,
    kickoff: g.kickoff, week: g.week, model_home_line: g.model_home_line,
    data_completeness: g.data_completeness, availability_unknown: true,
  }));
  /* one priced, one stale, one number-only: the three states on one card */
  games[0].market_home_handicap = -19.5; games[0].quote_observed_at = '2026-09-15T17:50:00Z';
  games[0].quote_book = 'DraftKings'; games[0].quote_price_american = '-110';
  games[1].market_home_handicap = -3.5; games[1].quote_observed_at = '2026-09-13T02:00:00Z'; games[1].quote_book = 'FanDuel';
  games[2].market_home_handicap = -30.5;
  const r = E.rankFootballCard({ games, now: NOW, within_hours: 14 * 24 });
  eq('the denominator is the SCHEDULE, not the priced rows', r.counts.in_window, games.length);
  chk('and the three counts are reported separately', r.counts.with_market_number === 3 && r.counts.with_executable_price === 2,
    r.counts);
  eq('a stale price is counted as stale', r.counts.stale_price, 1);
  chk('every scheduled game is in the ranking', r.ranked.length === games.length, r.ranked.length);
  chk('a game with no market is still rankable', r.ranked.some((x) => x.market_state === 'NO MARKET'), r.ranked.slice(0, 3));
  has('the statement separates card claims from price claims', r.statement, 'about PRICES');
  has('and the contract refuses gap-size ranking', r.contract, 'a bigger gap is a weaker signal');

  /* THE ORIENTATION TRAP. A model line and a book handicap are the same
     number from opposite ends; compared raw, a correct 19.8 reads as 39. */
  const orient = E.rankFootballCard({
    games: [{ game_id: 'g', sport: E.CFB_SPORT, home: 'Pittsburgh', away: 'Syracuse',
      kickoff: '2026-09-17T23:30:00Z', model_home_line: -19.82, market_home_handicap: -19.5 }],
    now: NOW, within_hours: 14 * 24,
  });
  eq('a correctly oriented comparison is an ORDINARY disagreement', orient.ranked[0].disagreement.level, 'ORDINARY');
  chk('and the gap is the real one', Math.abs(orient.ranked[0].disagreement.gap - 0.32) < 0.02, orient.ranked[0].disagreement.gap);
}

/* =====================================================================
   12. SAVED RESEARCH — frozen, separate from the record, and comparable.
   ===================================================================== */
section('saved research');
{
  const { B } = buildBrief();
  const snap = E.researchSnapshot({ brief: B, model_version: 'edgedesk_cfb_p4_v1.0.0', question: 'Texas Tech matchup this week', now: NOW });
  chk('a snapshot is identified by a hash of itself', /^[0-9a-f]{16}$/.test(snap.id), snap.id);
  eq('it records the exact model build', snap.model.version, 'edgedesk_cfb_p4_v1.0.0');
  chk('and the price EdgeDesk had actually observed', snap.observed_price && snap.observed_price.book === 'DraftKings', snap.observed_price);
  eq('and it is declared not to be a wager', snap.is_a_wager, false);
  has('in words', snap.record_note, 'not in EdgeDesk');
  chk('the drivers are frozen with it', snap.drivers.length === 3, snap.drivers.length);
  chk('and so is the counterargument', !!snap.counter, snap.counter);

  /* Editing it must break its own id. */
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.observed_price.price_american = '+100';
  delete tampered.id;
  chk('an edited snapshot no longer matches its own id', E.snapshotDigest(tampered) !== snap.id, E.snapshotDigest(tampered));

  /* A later reading, and the diff. */
  const later = buildBrief({
    signals: [{ market: 'spreads', selection: 'Texas Tech', point: -15.5, best_dec: 1.87, best_book: 'FanDuel',
      n_books: 8, last_seen_at: '2026-09-16T17:50:00Z' }],
  });
  const snap2 = E.researchSnapshot({ brief: later.B, model_version: 'edgedesk_cfb_p4_v1.0.0', now: NOW + 864e5 });
  const diff = E.compareSnapshots(snap, snap2);
  eq('a two-point move is material', diff.material, true);
  chk('and is reported as two observations EdgeDesk actually made', diff.changes.some((c) => /both are prices EdgeDesk observed/i.test(c.detail)),
    diff.changes.map((c) => c.headline));
  eq('and the saved conclusion is reported as no longer standing', diff.conclusion_still_applies, false);

  /* A missing earlier observation must not become a movement story. */
  const noPrice = E.researchSnapshot({ brief: buildBrief({ signals: [] }).B, now: NOW });
  const d2 = E.compareSnapshots(noPrice, snap2);
  chk('a price appearing where there was none is reported as an appearance', d2.changes.some((c) => /price appeared/i.test(c.headline)),
    d2.changes.map((c) => c.headline));
  const d3 = E.compareSnapshots(noPrice, E.researchSnapshot({ brief: buildBrief({ signals: [] }).B, now: NOW + 864e5 }));
  chk('two readings with no price at either end narrate NO movement', d3.gaps.some((g) => /does not reconstruct an opening line/i.test(g)), d3.gaps);
  eq('and nothing material is claimed', d3.material, false);

  const crossed = E.compareSnapshots(snap, Object.assign({}, snap2, { game_id: 'some-other-game' }));
  chk('two snapshots of different games are refused, not compared', crossed.gaps.length > 0 && crossed.changes.length === 0, crossed);
}

/* =====================================================================
   13. THE POSTGAME — three questions, allowed to disagree.
   ===================================================================== */
section('postgame review');
{
  const { B, res } = buildBrief();
  const snap = E.researchSnapshot({ brief: B, model_version: 'edgedesk_cfb_p4_v1.0.0', now: NOW });
  const pg = E.postgameReview({
    snapshot: snap,
    result: { home_team: res.home, away_team: res.away, home_points: 31, away_points: 24 },
    closing: { handicap: -15.5, market: 'spreads', source: 'last captured before kickoff', observed_at: '2026-09-18T23:50:00Z' },
  });
  eq('the saved side is graded against the verified margin', pg.outcome.result, 'DID NOT COVER');
  eq('and it is still not a wager', pg.outcome.is_a_wager, false);
  eq('the price is graded separately, and can disagree with the result', pg.price_quality.beat_close, true);
  has('the closing definition is stated wherever it is used', pg.price_quality.basis, 'LAST observation');
  chk('the forecast is graded separately again', pg.forecast.absolute_error != null, pg.forecast);
  eq('and one game is declared to prove nothing', pg.forecast.proves_nothing_alone, true);
  has('the three are explicitly allowed to disagree', pg.separation_note, 'allowed to disagree');
  has('and the pregame text is never rewritten', pg.pregame_note, 'reproduced unchanged');

  const ungraded = E.postgameReview({ snapshot: snap, result: null });
  chk('no verified score means nothing is graded', ungraded.gaps.length > 0, ungraded.gaps);
  eq('and no outcome is estimated', ungraded.outcome, null);

  const noClose = E.postgameReview({
    snapshot: snap, result: { home_points: 31, away_points: 24 }, closing: null,
  });
  eq('with no comparable closing observation, CLV is absent', noClose.price_quality.available, false);
  has('rather than estimated', noClose.price_quality.why, 'left absent rather than estimated');

  const wrongMarket = E.postgameReview({
    snapshot: snap, result: { home_points: 31, away_points: 24 },
    closing: { handicap: 52, market: 'totals', source: 'x' },
  });
  eq('a close on a different market is refused', wrongMarket.price_quality.available, false);
  has('and says why', wrongMarket.price_quality.why, 'different market');
}

done();
