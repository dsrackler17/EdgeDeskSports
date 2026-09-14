#!/usr/bin/env node
/* ============================================================================
   THE NEWSLETTER SYSTEM, OFFLINE.

   Everything a scheduled send depends on, exercised without a network, a
   database or a provider. The suite is deliberately built around the failures
   that would actually reach a reader:

     1  the clock          Monday CFB and Tuesday NFL across both daylight
                           saving transitions, in both directions
     2  the slate          the upcoming week, started games excluded, bye
                           weeks, season boundaries, postseason
     3  the arithmetic     the spread perspective and the discrepancy, both
                           directions, recomputed against the copy
     4  the gates          stale research, a delayed Monday night result, an
                           empty slate, nothing qualifying
     5  concurrency        duplicate scheduler calls, two workers, a partial
                           send, an ambiguous provider response
     6  the audience       consent, sport preference, unsubscribe, bounce and
                           complaint suppression (the Node half; the database
                           half is newsletter_sql.test.js)
     7  the copy           no fabricated figure, no recommendation language,
                           an unsubscribe link, a postal address, a plain-text
                           alternative, and nothing that needs an image
     8  authorisation      what a page may and may not reach

   Run: node tools/newsletter/newsletter.test.js
   ========================================================================== */
'use strict';

const assert = require('assert');
const path = require('path');

const SCHEDULE = require('./schedule.js');
const SLATE = require('./slate.js');
const SELECT = require('./select.js');
const COMPOSE = require('./compose.js');
const RENDER = require('./render.js');
const VALIDATE = require('./validate.js');
const STORE = require('./store.js');
const PROVIDER = require('./provider.js');
const MARKET = require('./market.js');
const INPUTS = require('./inputs.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function section(t) { if (process.env.NL_VERBOSE) console.log('\n' + t); }

/* ------------------------------------------------------------- fixtures */
/* A research payload with the shape the football module actually publishes.
   Everything the pipeline reads is here and nothing it does not. */
function payload(o) {
  o = o || {};
  const home = o.home || 'Buffalo Bills', away = o.away || 'Detroit Lions';
  const fair = o.fair_spread == null ? 4.4 : o.fair_spread;   /* home margin */
  const fav = fair >= 0 ? home : away;
  const line = -fair;
  return {
    kind: o.kind || 'NFL_GAME',
    game: { home, away, kickoff: o.kickoff, week: o.week, season: o.season },
    projection: {
      priced: o.priced !== false,
      fair_spread: fair,
      fair_spread_text: home + ' ' + (line > 0 ? '+' : '') + line.toFixed(1),
      favourite: fav, underdog: fav === home ? away : home,
      total: o.total == null ? '51.0' : o.total,
      win_prob: { home, away, home_pct: 66, away_pct: 34, favourite: fav, favourite_pct: 66 },
      outcome_range: { basis_team: home, p10: '-13.0', median: '+3.0', p90: '+22.0', sigma: o.sigma == null ? '10.7' : o.sigma },
      sample_games: o.sample_games == null ? 6 : o.sample_games,
      seeded: !!o.seeded,
      engine: 'EdgeDesk NFL game model edgedesk_football_v1.0.0',
      validation: 'UNPROVEN — this model does NOT beat the closing line out of sample.',
      status: o.status || 'RESEARCH',
      status_note: 'a research state, not a bet',
    },
    market: o.market === null ? { available: false, headline: 'No sportsbook spread is currently joined to this game.' }
      : Object.assign({
        available: true,
        model: home + ' ' + (line > 0 ? '+' : '') + line.toFixed(1),
        market: home + ' ' + ((o.market_line == null ? -3.0 : o.market_line) > 0 ? '+' : '')
          + (o.market_line == null ? -3.0 : o.market_line).toFixed(1),
        book: o.book === undefined ? 'FanDuel' : o.book,
        captured: o.captured === undefined ? '2026-09-15T12:00:00.000Z' : o.captured,
        stale: !!o.stale,
        total_market: o.total_market === undefined ? '52.5' : o.total_market,
        classification: 'RESEARCH',
      }, o.market || {}),
    drivers: { rows: [
      { points: '+2.5', points_n: 2.5, text: 'Model baseline — the team-strength model’s constant', favours: home },
      { points: '+1.0', points_n: 1.0, text: 'Net passing EPA', favours: home },
      { points: '+0.6', points_n: 0.6, text: 'Net rushing EPA', favours: home },
    ] },
    compare: { cols: [away, home], groups: [{ title: 'Team strength', rows: [
      { cat: 'net_epa', k: 'Net EPA per play',
        a: { v: '+0.067', n: 0.067, rank: '#10 of 32', rank_n: 10 },
        h: { v: '+0.127', n: 0.127, rank: '#3 of 32', rank_n: 3 },
        edge: { side: 'h', gap: 0.06, rank_gap: 7 } },
    ] }] },
    advantages: {
      away: [{ k: 'Sacks generated per dropback', rank_gap: 18, gap: 0.02, lead: away, trail: home,
        lead_cell: '+0.9 pp · #9 of 32', trail_cell: '−1.2 pp · #27 of 32',
        text: away + ' +0.9 pp (#9 of 32) vs ' + home + ' −1.2 pp (#27 of 32) — 18 places on the league board.' }],
      home: [{ k: 'Run offence · EPA per carry', rank_gap: 25, gap: 0.11, lead: home, trail: away,
        lead_cell: '+0.078 · #2 of 32', trail_cell: '−0.034 · #27 of 32',
        text: home + ' +0.078 (#2 of 32) vs ' + away + ' −0.034 (#27 of 32) — 25 places on the league board.' }],
      measured: [],
    },
    matchups: [{
      title: away + ' pass offence vs ' + home + ' pass defence',
      att: { team: away, label: 'pass offence', v: '+0.121', rank: '#4 of 32' },
      def: { team: home, label: 'pass defence', v: '−0.078', rank: '#10 of 32' },
      complete: true, net: 0.042,
      read: away + '’ pass offence rates +0.121 (#4 of 32) and ' + home
        + '’ pass defence rates −0.078 (#10 of 32). Added the way the model adds them, this pairing sits +0.042 from the league mean, which favours ' + away + '.',
    }],
    uncertainty: {
      items: (o.uncertainty || [
        { sev: 'HIGH', label: 'availability not on file', text: 'NFL injury report — not loaded in this session.' },
        { sev: 'HIGH', label: 'the model does not beat the closing line',
          text: 'Out of sample 2016–2025 this model’s spread MAE is 10.2 against the closing market’s 9.777.' },
      ]),
      unmeasured: [{ item: 'weather', why: 'no forecast reached this game' }],
    },
    missing: o.missing || [],
    state: { label: o.status || 'RESEARCH', note: 'a research state' },
  };
}

function record(o) {
  o = o || {};
  const sport = o.sport || 'NFL';
  const home = o.home || 'Buffalo Bills', away = o.away || 'Detroit Lions';
  const kickoff = o.kickoff || '2026-09-17T20:15:00.000Z';
  return {
    schema: 'edgedesk_article_v1',
    id: sport.toLowerCase() + '-' + (o.game_id || '2026_02_DET_BUF'),
    game_id: o.game_id || '2026_02_DET_BUF',
    sport, sport_slug: sport.toLowerCase(),
    slug: o.slug || 'detroit-lions-vs-buffalo-bills-2026',
    title: away + ' vs. ' + home,
    home_team: home, away_team: away,
    venue: o.venue || 'Highmark Stadium',
    neutral_site: false,
    conference_line: o.conference_line || (sport === 'CFB' ? 'SEC conference game' : 'outdoors · a_turf · division game'),
    week: o.week == null ? 2 : o.week,
    season: o.season == null ? 2026 : o.season,
    game_time: kickoff,
    status: o.status || 'ready',
    article_type: 'pregame',
    canonical_url: 'https://edgedesksports.com/articles/' + (o.slug || 'detroit-lions-vs-buffalo-bills-2026'),
    generated_at: o.generated_at || '2026-09-15T14:00:00.000Z',
    updated_at: o.generated_at || '2026-09-15T14:00:00.000Z',
    checks: { ok: o.checks_ok !== false, failed: o.checks_ok === false ? [{ id: 'thin', why: 'thin' }] : [], at: '2026-09-15T14:00:00.000Z' },
    research: payload(Object.assign({ home, away, kickoff, week: o.week == null ? 2 : o.week, season: o.season == null ? 2026 : o.season }, o)),
  };
}
function candidate(o) { return SLATE.fromRecord(record(o)); }

const NOW = Date.parse('2026-09-15T15:30:00.000Z');   /* Tuesday 10:30 CDT */

/* ==========================================================================
   1 — THE CLOCK
   ========================================================================== */
section('1 — the clock');
{
  const cfb = SCHEDULE.dueFor('CFB', '2026-09-14T15:30:00Z');
  chk('CFB is a Monday edition', cfb.weekday === 'Mon', cfb.weekday);
  chk('CFB is due at 10:00 Chicago', cfb.local_time === '10:00', cfb.local_time);
  chk('CFB 10:00 CDT is 15:00 UTC', cfb.scheduled_at === '2026-09-14T15:00:00.000Z', cfb.scheduled_at);
  chk('CFB is due 30 minutes in', cfb.due === true && cfb.minutes_late === 30, JSON.stringify([cfb.due, cfb.minutes_late]));

  const nfl = SCHEDULE.dueFor('NFL', '2026-09-15T15:00:00Z');
  chk('NFL is a Tuesday edition', nfl.weekday === 'Tue', nfl.weekday);
  chk('NFL 10:00 CDT is 15:00 UTC', nfl.scheduled_at === '2026-09-15T15:00:00.000Z', nfl.scheduled_at);
  chk('NFL is due exactly on the minute', nfl.due === true, String(nfl.due));

  /* THE TWO TRANSITIONS. In 2026 US daylight saving starts 8 March and ends
     1 November, so the Monday and Tuesday either side of each are the cases a
     fixed UTC cron gets wrong. */
  const winterMon = SCHEDULE.dueFor('CFB', '2026-11-02T16:30:00Z');
  chk('a November Monday is 10:00 CST = 16:00 UTC',
    winterMon.scheduled_at === '2026-11-02T16:00:00.000Z', winterMon.scheduled_at);
  chk('a November Monday edition is due at 16:30 UTC', winterMon.due === true, String(winterMon.due));
  chk('a November Monday is NOT due at 15:30 UTC',
    SCHEDULE.dueFor('CFB', '2026-11-02T15:30:00Z').due === false);

  const summerTue = SCHEDULE.dueFor('NFL', '2026-10-27T15:30:00Z');
  chk('an October Tuesday is 10:00 CDT = 15:00 UTC',
    summerTue.scheduled_at === '2026-10-27T15:00:00.000Z', summerTue.scheduled_at);

  /* spring forward: 8 March 2026 is a Sunday, so the Monday after is the 9th */
  const springMon = SCHEDULE.dueFor('CFB', '2026-03-09T15:30:00Z');
  chk('the Monday after spring forward is 15:00 UTC',
    springMon.scheduled_at === '2026-03-09T15:00:00.000Z', springMon.scheduled_at);
  const beforeSpring = SCHEDULE.dueFor('CFB', '2026-03-02T16:30:00Z');
  chk('the Monday before spring forward is 16:00 UTC',
    beforeSpring.scheduled_at === '2026-03-02T16:00:00.000Z', beforeSpring.scheduled_at);
  chk('the two Mondays either side of the transition are one hour apart in UTC',
    Date.parse(beforeSpring.scheduled_at) % 86400000 !== Date.parse(springMon.scheduled_at) % 86400000);

  /* the edition DATE is the local date, not the UTC one */
  chk('the edition date is the local Monday',
    SCHEDULE.dueFor('CFB', '2026-11-02T16:05:00Z').edition_date === '2026-11-02');

  /* before 10:00 on the day itself, the current edition is last week's */
  const early = SCHEDULE.dueFor('CFB', '2026-09-14T13:00:00Z');
  chk('before 10:00 the current edition is last week’s', early.edition_date === '2026-09-07', early.edition_date);
  chk('…and it is stale rather than due', early.stale === true && early.due === false);
  chk('…and the next one is named', early.next_edition_date === '2026-09-14', early.next_edition_date);

  /* the retry window */
  chk('inside the retry window an edition is still due',
    SCHEDULE.dueFor('NFL', '2026-09-15T18:59:00Z').due === true);
  chk('past the retry window it is stale, not due',
    SCHEDULE.dueFor('NFL', '2026-09-15T19:30:00Z').stale === true);
  chk('a shorter retry window closes sooner',
    SCHEDULE.dueFor('NFL', '2026-09-15T16:30:00Z', { retry_window_minutes: 30 }).stale === true);

  /* the two editions never collide */
  const d1 = SCHEDULE.dueFor('CFB', NOW), d2 = SCHEDULE.dueFor('NFL', NOW);
  chk('the two sports have different weekdays', d1.weekday !== d2.weekday);
  chk('the two sports have different edition dates', d1.edition_date !== d2.edition_date);

  chk('kickoff labels name the zone in force',
    /CDT$/.test(SCHEDULE.kickoffLabel('2026-09-17T20:15:00Z')) &&
    /CST$/.test(SCHEDULE.kickoffLabel('2026-12-17T20:15:00Z')),
    SCHEDULE.kickoffLabel('2026-09-17T20:15:00Z') + ' / ' + SCHEDULE.kickoffLabel('2026-12-17T20:15:00Z'));
}

/* ==========================================================================
   2 — THE SLATE
   ========================================================================== */
section('2 — the slate');
{
  const cands = [
    candidate({ game_id: 'A', week: 2, kickoff: '2026-09-17T20:15:00Z', home: 'Bills', away: 'Lions' }),
    candidate({ game_id: 'B', week: 2, kickoff: '2026-09-20T17:00:00Z', home: 'Falcons', away: 'Panthers' }),
    candidate({ game_id: 'C', week: 2, kickoff: '2026-09-21T20:15:00Z', home: 'Rams', away: 'Giants' }),
    /* last week's Monday game, already played */
    candidate({ game_id: 'D', week: 1, kickoff: '2026-09-14T20:15:00Z', home: 'Chiefs', away: 'Broncos' }),
    /* a game further out than the horizon */
    candidate({ game_id: 'E', week: 3, kickoff: '2026-09-24T20:15:00Z', home: 'Jets', away: 'Bears' }),
  ];
  const r = SLATE.resolve({ candidates: cands, sport: 'NFL', now: NOW });
  chk('the upcoming slate is next week, not the leftover Monday', r.week === 2, String(r.week));
  chk('the slate is three games', r.games.length === 3, String(r.games.length));
  chk('a game that has already started is excluded',
    (r.excluded || []).some(x => x.why === 'already_started'));
  chk('a game in another week is excluded with its reason',
    (r.excluded || []).some(x => x.why === 'other_week'));
  chk('the slate key carries season and week', r.slate_key === 'NFL:2026:W2', r.slate_key);
  chk('every game in the slate kicks off in the future',
    r.games.every(g => g.kickoff_ms > NOW));

  /* THE VOTE, not the first kickoff: one leftover game must not become the
     whole slate. */
  const leftoverOnly = SLATE.resolve({
    candidates: [candidate({ game_id: 'D', week: 1, kickoff: '2026-09-15T23:00:00Z' })].concat(
      [1, 2, 3, 4].map(i => candidate({ game_id: 'W' + i, week: 2, kickoff: '2026-09-17T20:15:00Z' }))),
    sport: 'NFL', now: NOW,
  });
  chk('one leftover game does not outvote a full week', leftoverOnly.week === 2, String(leftoverOnly.week));

  /* an empty slate is a real answer */
  const empty = SLATE.resolve({ candidates: [], sport: 'NFL', now: NOW });
  chk('an empty slate is not ok', empty.ok === false);
  chk('an empty slate says why', empty.reason === 'no_upcoming_games', empty.reason);

  const allPlayed = SLATE.resolve({
    candidates: [candidate({ game_id: 'X', week: 1, kickoff: '2026-09-01T20:15:00Z' })],
    sport: 'NFL', now: NOW,
  });
  chk('a slate of finished games is empty', allPlayed.ok === false);

  const farOut = SLATE.resolve({
    candidates: [candidate({ game_id: 'Y', week: 9, kickoff: '2026-12-01T20:15:00Z' })],
    sport: 'NFL', now: NOW,
  });
  chk('a season boundary produces no slate rather than a guess', farOut.ok === false, farOut.reason);

  /* a postseason week identifier is just another week */
  const post = SLATE.resolve({
    candidates: [candidate({ game_id: 'P', week: 19, season: 2026, kickoff: '2026-09-17T20:15:00Z' })],
    sport: 'NFL', now: NOW,
  });
  chk('a postseason week resolves like any other', post.ok === true && post.week === 19, String(post.week));

  /* the sports do not see each other */
  const mixed = SLATE.resolve({
    candidates: cands.concat([candidate({ sport: 'CFB', game_id: 'C1', week: 3, kickoff: '2026-09-19T18:00:00Z' })]),
    sport: 'CFB', now: NOW,
  });
  chk('a CFB slate contains no NFL game', mixed.games.every(g => g.sport === 'CFB'));

  /* the Monday-night game the NFL edition waits for */
  const mon = SLATE.lastMondayGame(cands, NOW, t => SCHEDULE.zonedParts(t, 'America/New_York'));
  chk('the last Monday NFL game is found', mon && mon.game_id === 'D', mon && mon.game_id);
  chk('no Monday game is a valid answer',
    SLATE.lastMondayGame([candidate({ game_id: 'Z', kickoff: '2026-09-13T17:00:00Z' })], NOW,
      t => SCHEDULE.zonedParts(t, 'America/New_York')) === null);
}

/* ==========================================================================
   3 — THE ARITHMETIC
   ========================================================================== */
section('3 — the arithmetic');
{
  /* home favourite, market shorter: the difference sits on the home team */
  const a = SELECT.scoreOne(candidate({ fair_spread: 4.4, market_line: -3.0 }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('a home line is the negative of the home margin', a.spread.model_home_line === -4.4, String(a.spread.model_home_line));
  chk('the market home line is read as quoted', a.spread.market_home_line === -3.0, String(a.spread.market_home_line));
  chk('the gap is the difference of the two margins', a.spread.gap_points === 1.4, String(a.spread.gap_points));
  chk('EdgeDesk higher on the home team leans home',
    a.spread.edge_home === 1.4 && a.spread.lean_team === a.home, JSON.stringify([a.spread.edge_home, a.spread.lean_team]));

  /* the other direction: the market is LONGER on the home team */
  const b = SELECT.scoreOne(candidate({ fair_spread: 4.4, market_line: -9.5 }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('a longer market line leans away', b.spread.lean_team === b.away, b.spread.lean_team);
  chk('…and the gap is positive either way', b.spread.gap_points === 5.1, String(b.spread.gap_points));
  chk('…and edge_home is negative', b.spread.edge_home === -5.1, String(b.spread.edge_home));

  /* a home underdog, quoted as a plus number */
  const c = SELECT.scoreOne(candidate({ fair_spread: -4.6, market_line: 5.5 }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('a home underdog line is positive', c.spread.model_home_line === 4.6, String(c.spread.model_home_line));
  chk('the gap is still the margin difference', c.spread.gap_points === 0.9, String(c.spread.gap_points));

  /* pick'em */
  chk('a pick’em is zero, not null', SELECT.signedNumber('Bills PK') === 0);
  chk('a typographic minus parses like a hyphen', SELECT.signedNumber('Bills −3.5') === -3.5);

  /* AN AWAY-QUOTED LINE IS FLIPPED, NOT ASSUMED */
  chk('a line quoted from the away team is converted',
    SELECT.signedNumber(SELECT.marketLineText('Detroit Lions +3.0', 'Buffalo Bills', 'Detroit Lions')) === -3.0);
  chk('a line naming neither team is refused rather than guessed',
    SELECT.marketLineText('Somebody Else -3.0', 'Buffalo Bills', 'Detroit Lions') === null);

  /* no market */
  const nm = SELECT.scoreOne(candidate({ market: null }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('no market means no gap', nm.spread.gap_points === null);
  chk('no market scores zero for the market component',
    nm.components.filter(x => x.key === 'model_vs_market')[0].points === 0);
  chk('no market is flagged for the reader', nm.flags.some(f => f.id === 'no_market'));
}

/* ==========================================================================
   4 — SELECTION: EVIDENCE OVER RAW GAPS
   ========================================================================== */
section('4 — selection');
{
  const strong = candidate({ game_id: 'S', fair_spread: 4.4, market_line: -9.5, sample_games: 8, generated_at: '2026-09-15T14:00:00.000Z' });
  const thin = candidate({ game_id: 'T', fair_spread: 4.4, market_line: -14.5, sample_games: 1, seeded: true,
    stale: true, captured: '2026-09-01T12:00:00.000Z', generated_at: '2026-09-15T14:00:00.000Z' });
  const both = SELECT.rank({ games: [strong, thin], sport: 'NFL', now: NOW, settings: { thresholds: { NFL: 0 } } });
  const refusedThin = (both.refused || []).some(r => r.key === thin.key
    && r.reasons.some(x => x.id === 'gap_outruns_evidence'));
  chk('a large gap on thin data is refused, not featured', refusedThin, JSON.stringify(both.refused));
  chk('…and the refusal names the floor the gap had to clear',
    (both.refused || []).some(r => (r.reasons || []).some(x => /below the [\d.]+ floor/.test(x.detail || ''))),
    JSON.stringify((both.refused || []).map(r => r.reasons)));
  chk('the better-evidenced game is chosen', both.chosen.some(c => c.key === strong.key));

  /* the biggest raw gap does not automatically win */
  const bigWeak = candidate({ game_id: 'BW', fair_spread: 4.4, market_line: -10.0, sample_games: 2, seeded: true });
  const smallStrong = candidate({ game_id: 'SS', fair_spread: 4.4, market_line: -7.0, sample_games: 10 });
  const order = SELECT.rank({ games: [bigWeak, smallStrong], sport: 'NFL', now: NOW, settings: { thresholds: { NFL: 0 }, gap_confidence_floor: 0 } });
  chk('a smaller gap with better data can outrank a larger one',
    order.chosen[0] && order.chosen[0].key === smallStrong.key,
    order.chosen.map(c => c.key + ':' + c.score).join(', '));

  /* never padded */
  const one = SELECT.rank({ games: [strong], sport: 'NFL', now: NOW, settings: { thresholds: { NFL: 0 } } });
  chk('one qualifying game produces a one-game edition', one.chosen.length === 1);
  chk('…and says it was not padded', /does not pad|rather than being padded/.test(one.note || ''), one.note);

  const none = SELECT.rank({ games: [thin], sport: 'NFL', now: NOW });
  chk('nothing qualifying produces no games', none.chosen.length === 0);

  /* the cap and the expansion bar */
  const many = [];
  for (let i = 0; i < 14; i++) {
    many.push(candidate({ game_id: 'M' + i, fair_spread: 4.4, market_line: -(5 + i * 0.2), sample_games: 10 }));
  }
  const capped = SELECT.rank({ games: many, sport: 'NFL', now: NOW, settings: { thresholds: { NFL: 0 }, expansion_thresholds: { NFL: 0 }, gap_confidence_floor: 0 } });
  chk('the edition never exceeds ten games', capped.chosen.length <= 10, String(capped.chosen.length));
  const highBar = SELECT.rank({ games: many, sport: 'NFL', now: NOW, settings: { thresholds: { NFL: 0 }, expansion_thresholds: { NFL: 999 }, gap_confidence_floor: 0 } });
  chk('an unreachable expansion bar stops the edition at five', highBar.chosen.length === 5, String(highBar.chosen.length));
  chk('…and the games past five say which bar they missed',
    (highBar.passed || []).some(p => p.why === 'below_expansion_threshold'));

  /* ---- A FEATURED GAME HAS TO BE EXPLICABLE ------------------------------
     EdgeDesk withholds a RANK below its own confidence floor: the rating is
     published, the position on the board is not. A game with such a team has
     no comparison sentence to write and no measured advantage to name \u2014 an
     advantage is a distance between two positions \u2014 so the whole read comes
     out as one sentence. A live college edition was HELD for exactly this,
     four of ten featured games below the two-sentence floor. The refusal
     belongs where a different game can still be chosen. */
  const unrankable = record({ game_id: 'UR' });
  unrankable.research.compare.groups[0].rows.forEach(r => {
    r.a.rank = null; r.a.rank_n = null;
    r.a.note = 'confidence 9% is below the 22% floor.';
  });
  unrankable.research.advantages = { away: [], home: [], measured: [] };
  const unrankableCand = SLATE.fromRecord(unrankable);
  const thinScore = SELECT.scoreOne(unrankableCand, 'NFL', SELECT.DEFAULTS, NOW);
  chk('a game the model cannot rank is refused rather than featured',
    thinScore.refusals.some(r => r.id === 'evidence_too_thin'),
    JSON.stringify(thinScore.refusals.map(r => r.id)));
  chk('\u2026and the refusal names what the payload could not supply',
    thinScore.refusals.some(r => r.id === 'evidence_too_thin' && /confidence floor/.test(r.detail || '')),
    JSON.stringify(thinScore.refusals));
  chk('a payload with ranks and advantages is not refused for evidence',
    !SELECT.scoreOne(candidate({ game_id: 'OK' }), 'NFL', SELECT.DEFAULTS, NOW)
      .refusals.some(r => r.id === 'evidence_too_thin'));
  chk('one missing source of three is still enough',
    !SELECT.scoreOne(SLATE.fromRecord((function () {
      const r = record({ game_id: 'TWO' });
      r.research.advantages = { away: [], home: [], measured: [] };
      return r;
    })()), 'NFL', SELECT.DEFAULTS, NOW).refusals.some(x => x.id === 'evidence_too_thin'));
  chk('an unrankable game is kept out of the edition entirely',
    SELECT.rank({ games: [unrankableCand], sport: 'NFL', now: NOW,
      settings: { thresholds: { NFL: 0 }, gap_confidence_floor: 0 } }).chosen.length === 0);

  /* refusals */
  const unpriced = SELECT.scoreOne(candidate({ game_id: 'U', priced: false }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('an unpriced game is refused', unpriced.refusals.some(r => r.id === 'not_priced'));
  const failed = SELECT.scoreOne(candidate({ game_id: 'F', checks_ok: false }), 'NFL', SELECT.DEFAULTS, NOW);
  chk('a record whose own checks failed is refused', failed.refusals.some(r => r.id === 'checks_failed'));

  /* model-level disclosures are not a per-game penalty */
  chk('a model-level uncertainty is recognised',
    SELECT.isModelLevel({ label: 'the model does not beat the closing line', text: 'out of sample' }) === true);
  chk('a game-level uncertainty is not', SELECT.isModelLevel({ label: 'availability not on file', text: 'injury report' }) === false);

  /* the conference tie-break covers FBS rather than the Power Four */
  chk('an NFL "conference line" is not read as a conference',
    SELECT.conferencesOf({ conference_line: 'outdoors · grass · division game' }).length === 0);
  chk('a college conference game yields one conference',
    SELECT.conferencesOf({ conference_line: 'Sun Belt conference game' })[0] === 'Sun Belt');
  chk('a cross-conference game yields two',
    SELECT.conferencesOf({ conference_line: 'Mountain West vs Big 12' }).length === 2);

  const p4 = candidate({ sport: 'CFB', game_id: 'P4', conference_line: 'SEC conference game', market: null, week: 3 });
  const g5 = candidate({ sport: 'CFB', game_id: 'G5', conference_line: 'Sun Belt conference game', market: null, week: 3 });
  const div = SELECT.rank({ games: [p4, g5], sport: 'CFB', now: NOW, settings: { thresholds: { CFB: 0 }, expansion_thresholds: { CFB: 0 } } });
  chk('a smaller conference is not excluded from a college edition',
    (div.coverage.conferences_chosen || []).indexOf('Sun Belt') >= 0,
    (div.coverage.conferences_chosen || []).join(', '));
}

/* ==========================================================================
   5 — THE INPUT GATES
   ========================================================================== */
section('5 — input gates');
{
  const fresh = INPUTS.recordFreshness([{ key: 'A', record: { generated_at: '2026-09-15T14:00:00Z' } }], NOW, 30);
  chk('a freshly regenerated record is not stale', fresh.stale_count === 0, JSON.stringify(fresh));
  const old = INPUTS.recordFreshness([{ key: 'A', record: { generated_at: '2026-09-10T14:00:00Z' } }], NOW, 30);
  chk('a five-day-old record is stale', old.stale_count === 1, JSON.stringify(old));

  /* MONDAY NIGHT FOOTBALL */
  const monday = candidate({ game_id: 'MNF', week: 1, kickoff: '2026-09-14T20:15:00Z', home: 'Chiefs', away: 'Broncos' });
  const waiting = INPUTS.mondayNightReadiness({
    candidates: [monday], now: Date.parse('2026-09-15T15:00:00Z'),
    deadline_at: '2026-09-15T19:00:00Z', settle_minutes: 90,
  });
  chk('a Monday game with no result holds the edition', waiting.action === 'wait', waiting.action);
  chk('…and names the game it is waiting for', /Broncos at Chiefs/.test(waiting.detail || ''), waiting.detail);

  const pastWindow = INPUTS.mondayNightReadiness({
    candidates: [monday], now: Date.parse('2026-09-15T20:00:00Z'),
    deadline_at: '2026-09-15T19:00:00Z', settle_minutes: 90,
  });
  chk('a result that never arrived holds rather than sends', pastWindow.action === 'hold', pastWindow.action);
  chk('…with an operator-visible reason', pastWindow.reason === 'monday_result_never_arrived', pastWindow.reason);

  const noMonday = INPUTS.mondayNightReadiness({
    candidates: [candidate({ game_id: 'SUN', kickoff: '2026-09-13T17:00:00Z' })],
    now: Date.parse('2026-09-15T15:00:00Z'), deadline_at: '2026-09-15T19:00:00Z',
  });
  chk('a week with no Monday game proceeds', noMonday.action === 'proceed' && noMonday.required === false);

  /* the schedule cache reader */
  const fs = require('fs');
  const tmp = path.join(require('os').tmpdir(), 'edgedesk_nl_games_' + process.pid + '.csv');
  fs.writeFileSync(tmp, 'game_id,home_score,away_score\n2026_01_DEN_KC,24,17\n2026_02_X,,\n');
  const got = INPUTS.resultFromScheduleCache('2026_01_DEN_KC', tmp);
  chk('a final score is read from the cached schedule', got && got.home_score === 24, JSON.stringify(got));
  chk('a game with no score yet reads as no result',
    INPUTS.resultFromScheduleCache('2026_02_X', tmp) === null);
  chk('a game not in the file reads as no result',
    INPUTS.resultFromScheduleCache('nope', tmp) === null);
  fs.unlinkSync(tmp);
}

/* ==========================================================================
   6 — THE COPY, RENDERED AND VALIDATED
   ========================================================================== */
section('6 — the copy');
function buildEdition(opts) {
  opts = opts || {};
  const games = opts.candidates || [
    candidate({ game_id: 'G1', fair_spread: 4.4, market_line: -9.5, sample_games: 8 }),
    candidate({ game_id: 'G2', home: 'Chiefs', away: 'Colts', slug: 'colts-vs-chiefs-2026', fair_spread: -0.1, market_line: 6.5, sample_games: 8 }),
  ];
  const sel = SELECT.rank({ games, sport: opts.sport || 'NFL', now: opts.now || NOW,
    settings: Object.assign({ thresholds: { NFL: 0, CFB: 0 }, gap_confidence_floor: 0 }, opts.settings || {}) });
  const ed = COMPOSE.compose({
    sport: opts.sport || 'NFL', season: 2026, week: 2, edition_date: '2026-09-15',
    scheduled_at: '2026-09-15T15:00:00.000Z', selection: sel, slate: { games },
    now: opts.now || NOW, published_ids: opts.published_ids || {},
    data_cutoff: opts.data_cutoff || '2026-09-15T15:00:00.000Z',
  });
  ed.edition_key = 'NFL:2026:W02:2026-09-15';
  /* the validator reads the payload through this, exactly as run.js attaches it */
  ed.games.forEach(g => {
    const c = games.filter(x => x.key === g.key)[0];
    if (c) g.research = c.record.research;
  });
  return { edition: ed, selection: sel };
}

{
  const { edition } = buildEdition();
  const rendered = RENDER.render(edition, {});
  const v = VALIDATE.validate(edition, { now: NOW, rendered, published_ids: {} });
  chk('a well-formed edition validates', v.ok === true,
    JSON.stringify(v.integrity_failed.concat(v.craft_failed)));

  /* THE TWO MODULES CANNOT DISAGREE ABOUT WHAT EXISTS. select.js refuses a
     game it cannot evidence; compose.js writes the sentences. They read the
     same chosen sources, and this is the pin that says so: every game that
     reaches an edition carries at least the two sentences the validator
     demands, so the gate is met by choosing rather than by holding. */
  const unrankableEd = record({ game_id: 'UR2' });
  unrankableEd.research.compare.groups[0].rows.forEach(r => { r.a.rank = null; r.a.rank_n = null; });
  unrankableEd.research.advantages = { away: [], home: [], measured: [] };
  const mixed = buildEdition({ candidates: [
    candidate({ game_id: 'G1', fair_spread: 4.4, market_line: -9.5, sample_games: 8 }),
    SLATE.fromRecord(unrankableEd),
  ] });
  chk('a game select could not evidence never reaches the copy',
    mixed.edition.games.every(g => g.key.indexOf('UR2') < 0),
    mixed.edition.games.map(g => g.key).join(', '));
  chk('every featured game composes at least two evidence sentences',
    mixed.edition.games.every(g => (g.why || []).length >= 2),
    mixed.edition.games.map(g => g.key + ':' + (g.why || []).length).join(', '));
  chk('\u2026and select counted the same sources compose wrote',
    mixed.edition.games.every(g => {
      const c = (mixed.selection.chosen || []).filter(x => x.key === g.key)[0];
      return c && SELECT.evidenceSources(c.evidence, 'NFL').count === (g.why || []).length;
    }));

  chk('the subject is specific to this week', /Week 2/.test(edition.subject), edition.subject);
  chk('the subject fits an inbox', edition.subject.length <= 78, String(edition.subject.length));
  chk('there is preview text', !!edition.preview_text && edition.preview_text.length <= 150);
  chk('the edition states it is research, not picks', /research, not picks/i.test(rendered.text));

  /* the email carries no image at all, so "images disabled" is not a state */
  chk('the HTML contains no image', (rendered.html.match(/<img/gi) || []).length === 0);
  chk('the HTML is table-based, not flex', !/display\s*:\s*flex/i.test(rendered.html));
  chk('every style is inline or in one head block',
    (rendered.html.match(/<style/gi) || []).length === 1);
  chk('the preheader carries the preview text', rendered.html.indexOf(RENDER.esc(edition.preview_text)) > 0);

  /* the per-recipient placeholders, and what happens to them */
  chk('the HTML carries an unsubscribe placeholder', rendered.html.indexOf(RENDER.PLACEHOLDER.unsubscribe) > 0);
  chk('the text carries a preferences placeholder', rendered.text.indexOf(RENDER.PLACEHOLDER.preferences) > 0);
  const personal = RENDER.personalise(rendered.html, { unsubscribe: 'https://x/u?t=1', preferences: 'https://x/p?t=1', webview: 'https://x' });
  chk('personalising replaces every placeholder', personal.indexOf('{{') < 0);
  chk('…with the recipient’s own URL', personal.indexOf('https://x/u?t=1') > 0);

  /* the legal furniture */
  chk('the HTML carries a postal address', /Lubbock, TX 79423/.test(rendered.html));
  chk('the text carries a postal address', /Lubbock, TX 79423/.test(rendered.text));
  chk('the text alternative carries every game',
    edition.games.every(g => rendered.text.indexOf(g.matchup) > 0));

  /* each featured game's required fields */
  edition.games.forEach(g => {
    chk('a game names its kickoff zone: ' + g.key, /C[DS]T/.test(g.kickoff_label || ''), g.kickoff_label);
    chk('a game carries a model line: ' + g.key, !!g.model.home_line_text);
    chk('a game with a market names the book: ' + g.key, !g.market.available || !!g.market.book);
    chk('a market timestamp says what kind it is: ' + g.key,
      !g.market.available || !!g.market.quoted_at_kind, g.market.quoted_at_kind);
    chk('a game carries two or three evidence sentences: ' + g.key,
      g.why.length >= 2 && g.why.length <= 3, String(g.why.length));
    chk('a game carries something to watch: ' + g.key, !!g.watch);
    chk('a game carries a working link: ' + g.key, /^https:\/\//.test(g.link.url));
  });

  /* a total is printed only when it is worth printing */
  const smallTotalGap = buildEdition({ candidates: [candidate({ game_id: 'TT', total: '51.0', total_market: '51.5', fair_spread: 4.4, market_line: -9.5 })] });
  chk('a total inside the threshold is omitted', smallTotalGap.edition.games[0].total === null);
  const bigTotalGap = buildEdition({ candidates: [candidate({ game_id: 'TB', total: '51.0', total_market: '45.0', fair_spread: 4.4, market_line: -9.5 })] });
  chk('a total outside the threshold is printed', !!bigTotalGap.edition.games[0].total);
  const noTotal = buildEdition({ candidates: [candidate({ game_id: 'TN', total: '51.0', total_market: null, fair_spread: 4.4, market_line: -9.5 })] });
  chk('a missing market total omits the line rather than guessing', noTotal.edition.games[0].total === null);
}

/* --- the validator refuses what it should ------------------------------- */
{
  const { edition } = buildEdition();

  function withEdition(mutate) {
    const copy = JSON.parse(JSON.stringify(edition));
    /* JSON round-trip drops nothing the validator needs; the research payload
       rides along on each game */
    mutate(copy);
    const rendered = RENDER.render(copy, {});
    return VALIDATE.validate(copy, { now: NOW, rendered, published_ids: {} });
  }

  const started = withEdition(c => { c.games[0].kickoff = '2026-09-01T20:15:00.000Z'; });
  chk('a game that has already started blocks the edition',
    started.integrity_failed.some(f => f.id === 'game_already_started'), started.hold_reason);

  const wrongGap = withEdition(c => { c.games[0].difference.points = 12.3; c.games[0].difference.text = 'EdgeDesk is 12.3 points toward somebody.'; });
  chk('a difference that does not match the two lines is refused',
    wrongGap.integrity_failed.some(f => f.id === 'difference_mismatch'), wrongGap.hold_reason);

  const wrongSide = withEdition(c => { c.games[0].difference.edge_home = -c.games[0].difference.edge_home; });
  chk('a difference attributed to the wrong side is refused',
    wrongSide.integrity_failed.some(f => f.id === 'difference_direction'));

  const noPerspective = withEdition(c => { c.games[0].difference.text = 'EdgeDesk is 5.1 points away from the market.'; });
  chk('a difference sentence that names no perspective is refused',
    noPerspective.integrity_failed.some(f => f.id === 'difference_perspective_unstated'));

  const noBook = withEdition(c => { c.games[0].market.book = null; });
  chk('a quoted market with no named book is refused',
    noBook.integrity_failed.some(f => f.id === 'market_unattributed'));

  const ghostArticle = withEdition(c => {
    c.games[0].link = { kind: 'article', url: 'https://edgedesksports.com/articles/never-published-2026', label: 'x' };
  });
  chk('a link to an unpublished article page is refused',
    ghostArticle.integrity_failed.some(f => f.id === 'link_to_unpublished_article'));

  const brokenLink = withEdition(c => { c.games[0].link = { kind: 'terminal', url: 'not a url', label: 'x' }; });
  chk('a malformed link is refused', brokenLink.integrity_failed.some(f => f.id === 'link_missing'));

  const invented = withEdition(c => {
    c.games[0].why.push({ source: 'made up', text: 'Buffalo Bills have won 87.3% of their last 41 games in the rain.' });
  });
  chk('an invented statistic is refused',
    invented.integrity_failed.some(f => f.id === 'unsupported_statistic'), invented.hold_reason);

  const advice = withEdition(c => { c.intro.paragraphs.push('Our pick is the Bills, and it is the best bet on the board.'); });
  chk('betting-recommendation language is refused',
    advice.integrity_failed.some(f => f.id === 'recommendation_language'));

  const promise = withEdition(c => { c.intro.paragraphs.push('A risk-free bet that makes money every week.'); });
  chk('a profit promise is refused', promise.integrity_failed.some(f => f.id === 'profit_promise'));

  const provenEdge = withEdition(c => { c.intro.paragraphs.push('This is a proven edge over the market.'); });
  chk('describing the model as a proven advantage is refused',
    provenEdge.integrity_failed.some(f => f.id === 'proven_advantage'));

  const nulls = withEdition(c => { c.intro.paragraphs.push('The line moved to undefined this week.'); });
  chk('a stringified nothing is refused', nulls.integrity_failed.some(f => f.id === 'stringified_nothing'));

  const noGames = withEdition(c => { c.games = []; c.game_count = 0; });
  chk('an empty edition is refused', noGames.integrity_failed.some(f => f.id === 'no_games'));

  const noSubject = withEdition(c => { c.subject = ''; });
  chk('an edition with no subject is refused', noSubject.integrity_failed.some(f => f.id === 'no_subject'));

  /* the unsubscribe furniture cannot be dropped */
  const rendered = RENDER.render(edition, {});
  const stripped = { html: rendered.html.split(RENDER.PLACEHOLDER.unsubscribe).join('#'), text: rendered.text };
  const noUnsub = VALIDATE.validate(edition, { now: NOW, rendered: stripped, published_ids: {} });
  chk('an edition without an unsubscribe link is refused',
    noUnsub.integrity_failed.some(f => f.id === 'no_unsubscribe_link_html'));
}

/* ==========================================================================
   7 — THE PROVIDER
   ========================================================================== */
section('7 — the provider');
{
  const { edition } = buildEdition();
  const r = RENDER.render(edition, {});
  const stored = Object.assign({}, edition, {
    html_free: r.html, text_free: r.text, html_member: r.html, text_member: r.text,
    content_hash: 'ed_deadbeef',
  });
  const people = ['b@example.com', 'a@example.com', 'c@example.com'].map(e => ({
    email: e, variant: 'free',
    urls: { unsubscribe: 'https://x/u?t=' + e, preferences: 'https://x/p?t=' + e, webview: 'https://x' },
  }));

  /* IDEMPOTENCY. The key depends on the content and the exact address set,
     and nothing else — not on order, not on case, not on the clock. */
  const k1 = PROVIDER.idempotencyKeyFor('K', 'h', ['b@x', 'a@x']);
  const k2 = PROVIDER.idempotencyKeyFor('K', 'h', ['A@X', 'b@x']);
  chk('the idempotency key ignores order and case', k1 === k2);
  chk('a different recipient set is a different key',
    PROVIDER.idempotencyKeyFor('K', 'h', ['a@x']) !== k1);
  chk('different content is a different key',
    PROVIDER.idempotencyKeyFor('K', 'h2', ['b@x', 'a@x']) !== k1);

  /* messages: one per recipient, personalised in three places only */
  const msgs = PROVIDER.messagesFor(stored, people, { from_email: 'r@edgedesksports.com', from_name: 'EdgeDesk' });
  chk('one message per recipient', msgs.length === 3);
  chk('each message goes to exactly one address', msgs.every(m => m.to.length === 1));
  chk('every message carries a one-click unsubscribe header',
    msgs.every(m => m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click'));
  chk('the unsubscribe header is this recipient’s own URL',
    msgs[0].headers['List-Unsubscribe'].indexOf(people[0].email) > 0);
  chk('the body is personalised with that recipient’s URL',
    msgs[0].html.indexOf('https://x/u?t=' + people[0].email) > 0);
  chk('no placeholder survives into a sent message', msgs.every(m => m.html.indexOf('{{') < 0));
  chk('every message carries the plain-text alternative', msgs.every(m => !!m.text && m.text.length > 400));

  /* a batch is deterministic, and a retry of the same set reproduces it */
  return (async () => {
    const sent = [];
    const fakeFetch = (url, init) => {
      sent.push({ url, key: init.headers['Idempotency-Key'], body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: JSON.parse(init.body).map((_, i) => ({ id: 'm' + i })) })) });
    };
    const a1 = await PROVIDER.send({ edition: stored, recipients: people, settings: { from_email: 'r@e.com', batch_size: 2 },
      driver: 'resend', fetch: fakeFetch, env: { RESEND_API_KEY: 'k' } });
    chk('three recipients in batches of two make two calls', sent.length === 2, String(sent.length));
    chk('every recipient is accounted for', a1.outcomes.length === 3, String(a1.outcomes.length));
    chk('acceptance is recorded as acceptance, never delivery',
      a1.outcomes.every(o => o.status === 'accepted'));
    chk('the batches are alphabetical, so a retry reproduces them',
      sent[0].body[0].to[0] === 'a@example.com');

    const keys1 = sent.map(s => s.key);
    sent.length = 0;
    await PROVIDER.send({ edition: stored, recipients: people.slice().reverse(), settings: { from_email: 'r@e.com', batch_size: 2 },
      driver: 'resend', fetch: fakeFetch, env: { RESEND_API_KEY: 'k' } });
    chk('a retry of the same recipients presents the same idempotency keys',
      JSON.stringify(keys1) === JSON.stringify(sent.map(s => s.key)));

    /* AN AMBIGUOUS RESPONSE IS NOT A FAILURE */
    const timeout = await PROVIDER.send({ edition: stored, recipients: people,
      settings: { from_email: 'r@e.com' }, driver: 'resend', env: { RESEND_API_KEY: 'k' },
      fetch: () => Promise.reject(new Error('socket hang up')) });
    chk('a dropped connection is ambiguous, not failed',
      timeout.outcomes.every(o => o.ambiguous === true && o.status === 'queued'),
      JSON.stringify(timeout.counts));

    const fivehundred = await PROVIDER.send({ edition: stored, recipients: people,
      settings: { from_email: 'r@e.com' }, driver: 'resend', env: { RESEND_API_KEY: 'k' },
      fetch: () => Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') }) });
    chk('a 5xx is ambiguous', fivehundred.outcomes.every(o => o.ambiguous === true));

    const fourhundred = await PROVIDER.send({ edition: stored, recipients: people,
      settings: { from_email: 'r@e.com' }, driver: 'resend', env: { RESEND_API_KEY: 'k' },
      fetch: () => Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('bad from') }) });
    chk('a 4xx is a definite failure, safe to retry after a fix',
      fourhundred.outcomes.every(o => o.ambiguous === false && o.status === 'failed'));

    /* A PARTIAL BATCH: some accepted, the rest unknown */
    const partial = await PROVIDER.send({ edition: stored, recipients: people,
      settings: { from_email: 'r@e.com', batch_size: 3 }, driver: 'resend', env: { RESEND_API_KEY: 'k' },
      fetch: () => Promise.resolve({ ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'm0' }, { id: 'm1' }] })) }) });
    chk('a short id list accepts what it can', partial.counts.accepted === 2, JSON.stringify(partial.counts));
    chk('…and marks the remainder ambiguous rather than sent or failed',
      partial.counts.ambiguous === 1, JSON.stringify(partial.counts));

    const noKey = await PROVIDER.send({ edition: stored, recipients: people,
      settings: { from_email: 'r@e.com' }, driver: 'resend', env: {} });
    chk('a missing API key is a loud, named failure',
      noKey.outcomes.every(o => o.status === 'failed' && /RESEND_API_KEY/.test(o.error)));

    const dry = await PROVIDER.send({ edition: stored, recipients: people, settings: { from_email: 'r@e.com' }, dry: true });
    chk('a dry run sends nothing and says who it would have sent to',
      dry.driver === 'console' && dry.console_log.length >= 1);

    /* ---- the webhook ------------------------------------------------- */
    const crypto = require('crypto');
    const secret = 'whsec_' + Buffer.from('a-signing-secret').toString('base64');
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'm1', to: ['x@y.com'], bounce: { type: 'Permanent' } } });
    const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
    const mac = crypto.createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
      .update(id + '.' + ts + '.' + body).digest('base64');
    const H = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + mac };
    chk('a correctly signed webhook verifies', PROVIDER.verifyWebhook(body, H, secret).ok === true);
    chk('a tampered body is rejected', PROVIDER.verifyWebhook(body + ' ', H, secret).ok === false);
    chk('a wrong secret is rejected',
      PROVIDER.verifyWebhook(body, H, 'whsec_' + Buffer.from('other').toString('base64')).ok === false);
    chk('a replayed old delivery is rejected',
      PROVIDER.verifyWebhook(body, Object.assign({}, H, { 'svix-timestamp': String(Number(ts) - 4000) }), secret).reason
        === 'timestamp_outside_tolerance');
    chk('no configured secret is a refusal, not a pass',
      PROVIDER.verifyWebhook(body, H, '').ok === false);
    chk('a signature header with two values accepts either',
      PROVIDER.verifyWebhook(body, Object.assign({}, H, { 'svix-signature': 'v1,nonsense v1,' + mac }), secret).ok === true);

    const bounced = PROVIDER.interpretEvent(JSON.parse(body));
    chk('a permanent bounce suppresses', bounced.suppress === 'bounce' && bounced.permanent === true);
    const soft = PROVIDER.interpretEvent({ type: 'email.bounced', data: { to: ['x@y.com'], bounce: { type: 'Transient' } } });
    chk('a soft bounce does not suppress permanently', soft.permanent === false);
    const complaint = PROVIDER.interpretEvent({ type: 'email.complained', data: { to: ['x@y.com'] } });
    chk('a complaint suppresses', complaint.suppress === 'complaint');
    chk('delivery is its own state', PROVIDER.interpretEvent({ type: 'email.delivered', data: {} }).status === 'delivered');
    chk('an unknown event type is stored, not acted on',
      PROVIDER.interpretEvent({ type: 'email.something_new', data: {} }).known === false);

    /* ==================================================================
       8 — THE MARKET JOIN
       ================================================================== */
    section('8 — the market join');
    const slateGames = [{ key: 'NFL:1', sport: 'NFL', game_id: '1', home: 'Buffalo Bills', away: 'Detroit Lions',
      kickoff: '2026-09-17T20:15:00.000Z', kickoff_ms: Date.parse('2026-09-17T20:15:00.000Z') }];
    const joined = MARKET.quotesFromSignals([
      { sig_key: 'ok', market: 'spreads', selection: 'Buffalo Bills', point: -3, best_book: 'FanDuel',
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-17T20:15:00Z', last_seen_at: '2026-09-15T12:00:00Z' },
      { sig_key: 'other-game', market: 'spreads', selection: 'Chicago Bears', point: -3,
        home_team: 'Chicago Bears', away_team: 'Green Bay Packers', commence_time: '2026-09-17T20:15:00Z' },
      { sig_key: 'wrong-day', market: 'spreads', selection: 'Buffalo Bills', point: -3,
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-25T20:15:00Z' },
      { sig_key: 'bad-side', market: 'spreads', selection: 'Somebody', point: -3,
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-17T20:15:00Z' },
    ], slateGames);
    chk('a matching quote joins', joined.quotes.length === 1 && joined.quotes[0].spread.point === -3);
    chk('a quote for another game is refused',
      joined.refused.some(r => r.why === 'no_slate_game_with_both_teams'));
    chk('a quote whose kickoff disagrees is refused',
      joined.refused.some(r => r.why === 'kickoff_disagreement'));
    chk('a spread naming neither team is refused',
      joined.refused.some(r => r.why === 'spread_selection_is_neither_team'));
    chk('accents fold rather than break a join',
      MARKET.teamKey('San José State') === MARKET.teamKey('San Jose State'));
    const noCred = await MARKET.refresh({ games: slateGames, season: 2026, week: 2, env: {} });
    chk('no credential is a stated no-op, not a throw', noCred.reason === 'no_service_credential');
    chk('an NFL slate matches on exact keys', joined.resolver === 'exact_key', joined.resolver);

    /* ---- THE COLLEGE NAME MISMATCH, which a live run found the hard way ---
       The odds capture writes the book's name ("Texas Longhorns") and the
       college schedule writes the school ("Texas"). Comparing normalised
       strings joined NOTHING: 410 signal rows read, zero joined, every one
       refused as no_slate_game_with_both_teams. These are the exact fixtures
       from that run. */
    const cfbSlate = [
      ['Texas', 'UTSA'], ['UCLA', 'Purdue'], ['San Diego State', 'James Madison'],
      ['Louisiana', 'UAB'], ['Arizona', 'Northern Illinois'], ['San Jose State', 'Fresno State'],
      ['Texas Tech', 'Houston'], ['Ole Miss', 'LSU'],
    ].map(([home, away], i) => ({
      key: 'CFB:c' + i, sport: 'CFB', game_id: 'c' + i, season: 2026, week: 3,
      home, away, kickoff: '2026-09-19T23:00:00.000Z',
      kickoff_ms: Date.parse('2026-09-19T23:00:00.000Z'),
    }));
    const bookNames = [
      ['Texas Longhorns', 'UTSA Roadrunners'], ['UCLA Bruins', 'Purdue Boilermakers'],
      ['San Diego State Aztecs', 'James Madison Dukes'], ['Louisiana Ragin Cajuns', 'UAB Blazers'],
      ['Arizona Wildcats', 'Northern Illinois Huskies'], ['San Jose State Spartans', 'Fresno State Bulldogs'],
      ['Texas Tech Red Raiders', 'Houston Cougars'], ['Ole Miss Rebels', 'LSU Tigers'],
    ];
    const cfbRows = bookNames.map(([home, away], i) => ({
      sig_key: 'c' + i, market: 'spreads', selection: home, point: -(3 + i), best_book: 'FanDuel',
      home_team: home, away_team: away, commence_time: '2026-09-19T23:00:00.000Z',
      last_seen_at: '2026-09-19T12:00:00.000Z',
    }));
    const cfbJoined = MARKET.quotesFromSignals(cfbRows, cfbSlate);
    chk('a college slate uses the FBS resolver', cfbJoined.resolver === 'EDFbs', cfbJoined.resolver);
    chk('every book name with a mascot joins its school',
      cfbJoined.quotes.length === cfbSlate.length,
      cfbJoined.quotes.length + ' of ' + cfbSlate.length + ' — ' + JSON.stringify(MARKET.countBy(cfbJoined.refused)));
    chk('the spread is attributed to the resolved school, not the book’s name',
      cfbJoined.quotes.every(q => cfbSlate.some(g => g.home === q.spread.selection || g.away === q.spread.selection)),
      JSON.stringify(cfbJoined.quotes.map(q => q.spread.selection)));
    chk('"Texas Longhorns" does not take Texas Tech’s number',
      cfbJoined.quotes.filter(q => q.home === 'Texas')[0].spread.point === -3,
      JSON.stringify(cfbJoined.quotes.filter(q => q.home === 'Texas')));

    /* THE TRAP THE RESOLVER EXISTS FOR. Both Miamis on one board: a bare
       prefix test prices one against the other, and this must refuse rather
       than guess. */
    const miamiSlate = [
      { key: 'CFB:m1', sport: 'CFB', game_id: 'm1', season: 2026, week: 3, home: 'Miami', away: 'Florida State',
        kickoff: '2026-09-19T23:00:00.000Z', kickoff_ms: Date.parse('2026-09-19T23:00:00.000Z') },
      { key: 'CFB:m2', sport: 'CFB', game_id: 'm2', season: 2026, week: 3, home: 'Miami (OH)', away: 'Ohio',
        kickoff: '2026-09-19T23:00:00.000Z', kickoff_ms: Date.parse('2026-09-19T23:00:00.000Z') },
    ];
    const miamiJoined = MARKET.quotesFromSignals([
      { sig_key: 'm-oh', market: 'spreads', selection: 'Miami (OH) RedHawks', point: -2.5, best_book: 'FanDuel',
        home_team: 'Miami (OH) RedHawks', away_team: 'Ohio Bobcats',
        commence_time: '2026-09-19T23:00:00.000Z', last_seen_at: '2026-09-19T12:00:00.000Z' },
      { sig_key: 'm-fl', market: 'spreads', selection: 'Miami Hurricanes', point: -9.5, best_book: 'FanDuel',
        home_team: 'Miami Hurricanes', away_team: 'Florida State Seminoles',
        commence_time: '2026-09-19T23:00:00.000Z', last_seen_at: '2026-09-19T12:00:00.000Z' },
    ], miamiSlate);
    const mOh = miamiJoined.quotes.filter(q => q.game_id === 'm2')[0];
    const mFl = miamiJoined.quotes.filter(q => q.game_id === 'm1')[0];
    chk('Miami (OH) keeps its own number', mOh && mOh.spread.point === -2.5, JSON.stringify(mOh));
    chk('Miami Florida keeps its own number', mFl && mFl.spread.point === -9.5, JSON.stringify(mFl));

    /* A NAME THE RESOLVER CANNOT PLACE IS A NAMED REFUSAL, not a miss, so an
       operator can tell "we need an alias" from "that game is not this week". */
    const strange = MARKET.quotesFromSignals([
      { sig_key: 'x', market: 'spreads', selection: 'Wossamotta U Moose', point: -3,
        home_team: 'Wossamotta U Moose', away_team: 'Faber College Mongols',
        commence_time: '2026-09-19T23:00:00.000Z' },
    ], cfbSlate);
    chk('an unresolvable college name is refused by name, not by slate',
      strange.refused.some(r => r.why === 'team_name_unresolved'),
      JSON.stringify(strange.refused));

    /* THE DRIFT PIN. This file resolves the pair through an index for speed
       instead of calling EDFbs.matchesEvent per (row, game). The two must
       agree on every pair, or the newsletter and the board part company about
       who is playing. Asked exactly: does MY join produce a quote for this
       one row against this one game, and does matchesEvent say the same? */
    const ixPin = MARKET.indexFor(cfbSlate);
    const pinDisagreements = [];
    cfbRows.forEach(r => {
      cfbSlate.forEach(g => {
        const canonical = MARKET.FBS.matchesEvent(
          { home: r.home_team, away: r.away_team, t: r.commence_time },
          { g: { home_team: g.home, away_team: g.away }, t: g.kickoff_ms },
          ixPin.ix);
        const mine = MARKET.quotesFromSignals([r], [g]).quotes.length === 1;
        if (canonical !== mine) pinDisagreements.push(r.home_team + ' vs ' + g.home + ': matchesEvent ' + canonical + ', join ' + mine);
      });
    });
    chk('the pair index agrees with EDFbs.matchesEvent on every pair',
      pinDisagreements.length === 0,
      pinDisagreements.slice(0, 4).join(' | '));

    chk('the refusal histogram counts by reason',
      MARKET.countBy([{ why: 'a' }, { why: 'a' }, { why: 'b' }]).a === 2);

    /* ---- ONE HANDICAP, TWO SIDES -------------------------------------
       The second half of the same live failure. The names resolved, the
       quotes joined, and the board still showed NO MARKET on 25 of 47
       college games, because the capture writes a row per selection and the
       board's reader looks for the HOME row. Whichever side happened to be
       seen last was the one the snapshot kept. */
    const bothSides = MARKET.quotesFromSignals([
      { sig_key: 'away-side', market: 'spreads', selection: 'Detroit Lions', point: 3, best_book: 'FanDuel',
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-17T20:15:00Z', last_seen_at: '2026-09-15T09:00:00Z' },
      { sig_key: 'home-side', market: 'spreads', selection: 'Buffalo Bills', point: -3, best_book: 'FanDuel',
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-17T20:15:00Z', last_seen_at: '2026-09-15T08:00:00Z' },
    ], slateGames);
    chk('the home side is stored even when the away row was seen later',
      bothSides.quotes[0].spread.selection === 'Buffalo Bills'
      && bothSides.quotes[0].spread.point === -3
      && bothSides.quotes[0].spread.side === 'home',
      JSON.stringify(bothSides.quotes[0].spread));
    const awayOnly = MARKET.quotesFromSignals([
      { sig_key: 'away-only', market: 'spreads', selection: 'Detroit Lions', point: 3, best_book: 'FanDuel',
        home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: '2026-09-17T20:15:00Z', last_seen_at: '2026-09-15T09:00:00Z' },
    ], slateGames);
    chk('an away-only capture is stored as captured, with its side named',
      awayOnly.quotes[0].spread.selection === 'Detroit Lions'
      && awayOnly.quotes[0].spread.point === 3
      && awayOnly.quotes[0].spread.side === 'away',
      JSON.stringify(awayOnly.quotes[0].spread));

    /* And the replay hands the board BOTH ends of that handicap, so the
       away-side capture still joins. -3 on the home team is +3 on the away
       team: the same captured number, no second price. */
    const HOSTMOD = require('../articles/research_host.js');
    const replay = function (spread) {
      const win = { FB: { nfl: { sig: {} }, p4: { sig: {} } } };
      HOSTMOD.installMarketSnapshot(win, [
        { sport: 'NFL', game_id: '1', home: 'Buffalo Bills', away: 'Detroit Lions',
          kickoff: '2026-09-17T20:15:00.000Z', captured_at: '2026-09-15T09:00:00Z', spread: spread },
      ]);
      return (win.FB.nfl.sig['snapshot:1'] || { rows: [] }).rows.filter(r => r.market === 'spreads');
    };
    const mirroredRows = replay({ selection: 'Detroit Lions', side: 'away', point: 3, book: 'FanDuel' });
    chk('the replay presents both ends of one handicap', mirroredRows.length === 2,
      JSON.stringify(mirroredRows));
    chk('the mirrored end is the same number from the other side',
      mirroredRows.some(r => r.selection === 'Buffalo Bills' && r.point === -3)
      && mirroredRows.some(r => r.selection === 'Detroit Lions' && r.point === 3),
      JSON.stringify(mirroredRows));
    chk('the mirrored end keeps the captured book and timestamp, and states no price',
      mirroredRows.every(r => r.best_book === 'FanDuel' && r.last_seen_at === '2026-09-15T09:00:00Z'
        && r.best_dec === undefined && r.price === undefined));
    chk('a pick\u2019em mirrors to zero, not to negative zero',
      replay({ selection: 'Detroit Lions', side: 'away', point: 0, book: 'FanDuel' })
        .every(r => Object.is(r.point, 0)));

    /* ==================================================================
       8b — THE SEND PATH, against a fake database
       ================================================================== */
    section('8b — the send path');
    const RUN = require('./run.js');

    /* Enough of runtime.client() for send() to run: the lease, the edition
       row, the eligibility door and the delivery roster, with the same
       semantics the SQL enforces (one lease holder, one row per address,
       only queued/failed are still owed). */
    function fakeDb(init) {
      init = init || {};
      const state = {
        lease: null, leaseOwner: null,
        edition: Object.assign({ id: 1, edition_key: 'NFL:2026:W02:2026-09-15', status: 'ready' }, init.edition || {}),
        deliveries: [],
        eligible: (init.eligible || []).slice(),
        calls: { claim: 0, release: 0, skip: [], patches: [] },
      };
      const client = {
        enabled: true, hasService: true,
        async claimEdition(key, owner) {
          state.calls.claim++;
          if (state.leaseOwner && state.leaseOwner !== owner) return false;
          state.leaseOwner = owner; return true;
        },
        async releaseEdition(key, owner) {
          state.calls.release++;
          if (state.leaseOwner === owner) { state.leaseOwner = null; return true; }
          return false;
        },
        async findEdition() { return state.edition; },
        async patchEdition(key, patch) { state.calls.patches.push(patch); Object.assign(state.edition, patch); return state.edition; },
        async eligible() { return state.eligible.slice(); },
        async seedDeliveries(rows) {
          rows.forEach(r => {
            if (state.deliveries.some(d => d.email === r.email)) return;   /* the unique index */
            state.deliveries.push(Object.assign({ attempts: 0 }, r));
          });
          return state.deliveries;
        },
        async pendingDeliveries() {
          return state.deliveries.filter(d => d.status === 'queued' || d.status === 'failed');
        },
        async skipDeliveries(id, emails, why) {
          state.calls.skip.push({ emails: emails.slice(), why });
          state.deliveries.forEach(d => {
            if (emails.indexOf(d.email) >= 0 && (d.status === 'queued' || d.status === 'failed')) {
              d.status = 'skipped'; d.last_error = why;
            }
          });
        },
        async deliveryCounts() {
          const o = {}; state.deliveries.forEach(d => { o[d.status] = (o[d.status] || 0) + 1; }); return o;
        },
        async recordOutcome(id, out) {
          const d = state.deliveries.filter(x => x.email === out.email)[0];
          if (d) { d.status = out.status; d.ambiguous = out.ambiguous; d.last_error = out.error; }
        },
        async bumpAttempts() {}, async logRun() {}, async suppress() {},
      };
      return { state, client };
    }
    function resolvedFor(db, over) {
      const settings = Object.assign({
        site_url: 'https://edgedesksports.com',
        mailing_address: 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423',
        from_email: 'research@edgedesksports.com', from_name: 'EdgeDesk Research',
        test_recipients: [],
      }, (over && over.settings) || {});
      return {
        settings, client: db.client,
        sending_enabled: over && over.sending_enabled === false ? false : true,
        sportEnabled: () => true,
      };
    }
    const sendableEdition = Object.assign({}, edition, {
      edition_key: 'NFL:2026:W02:2026-09-15', status: 'ready',
      deadline_at: new Date(NOW + 3600000).toISOString(),
      content_hash: 'ed_deadbeef', html_free: r.html, text_free: r.text,
      html_member: r.html, text_member: r.text,
    });
    const people3 = [
      { subscriber_id: 'a', email: 'a@example.com', manage_token: 'tok-a', is_member: false },
      { subscriber_id: 'b', email: 'b@example.com', manage_token: 'tok-b', is_member: true },
      { subscriber_id: 'c', email: 'c@example.com', manage_token: 'tok-c', is_member: false },
    ];

    async function runSend(db, over, sendOpts) {
      return RUN.send(sendableEdition, Object.assign({
        resolved: resolvedFor(db, over), now: NOW, log: () => {},
        dry: true, env: {},
      }, sendOpts || {}));
    }

    /* the lease */
    const db1 = fakeDb({ eligible: people3 });
    const s1 = await runSend(db1);
    chk('a send takes the edition lease', db1.state.calls.claim === 1);
    chk('…and releases it when it is done', db1.state.calls.release === 1 && db1.state.leaseOwner === null);
    chk('a send reaches the provider', s1.sent === true, JSON.stringify(s1));

    const db2 = fakeDb({ eligible: people3 });
    db2.state.leaseOwner = 'someone-else';
    const s2 = await runSend(db2);
    chk('a second worker is refused while the lease is held',
      s2.sent === false && s2.reason === 'lease_held', JSON.stringify(s2));
    chk('…and it does not touch the delivery roster', db2.state.deliveries.length === 0);
    chk('…and it does not steal the lease', db2.state.leaseOwner === 'someone-else');

    /* a recipient who unsubscribed after the roster was seeded */
    const db3 = fakeDb({ eligible: people3 });
    await runSend(db3);                                    /* seeds all three */
    db3.state.deliveries.forEach(d => { d.status = 'queued'; });   /* pretend none went */
    db3.state.eligible = people3.filter(p => p.email !== 'b@example.com');
    /* NOT a dry run: outcomes are only recorded on a real send, and the point
       of this check is that the roster reaches a terminal state. The console
       driver still puts nothing on the wire. */
    const s3 = await runSend(db3, null, { dry: false, driver: 'console' });
    chk('a recipient who became ineligible is skipped, not sent to',
      db3.state.deliveries.filter(d => d.email === 'b@example.com')[0].status === 'skipped',
      JSON.stringify(db3.state.deliveries.map(d => d.email + ':' + d.status)));
    chk('…with a reason recorded on the row',
      /not eligible at send time/.test(db3.state.deliveries.filter(d => d.email === 'b@example.com')[0].last_error || ''));
    chk('…and the other two still send', s3.sent === true);
    chk('…so the edition can reach sent rather than hanging in sending',
      db3.state.deliveries.every(d => d.status !== 'queued'),
      JSON.stringify(db3.state.deliveries.map(d => d.status)));

    /* an accepted row is never handed to the provider twice */
    const db4 = fakeDb({ eligible: people3 });
    await runSend(db4);
    db4.state.deliveries.forEach(d => { d.status = 'accepted'; });
    const s4 = await runSend(db4);
    chk('an edition everyone has been accepted for does not re-send',
      s4.reason === 'already_delivered_to_everyone', JSON.stringify(s4));
    chk('…and is marked sent', db4.state.edition.status === 'sent');

    /* the kill switch is re-read at send time, not trusted from the build */
    const db5 = fakeDb({ eligible: people3 });
    const s5 = await runSend(db5, { sending_enabled: false });
    chk('the launch gate refuses the send', s5.reason === 'sending_disabled');
    chk('…before any lease is taken', db5.state.calls.claim === 0);
    chk('…and before any address is looked up', db5.state.deliveries.length === 0);

    /* a preview can never be sent */
    const db6 = fakeDb({ eligible: people3 });
    const s6 = await RUN.send(Object.assign({}, sendableEdition, { status: 'preview' }),
      { resolved: resolvedFor(db6), now: NOW, log: () => {}, dry: true, env: {} });
    chk('a preview edition is not sendable', s6.sent === false && s6.reason === 'not_sendable', JSON.stringify(s6));

    /* a test send uses a real token when the address is a subscriber */
    const db7 = fakeDb({ eligible: people3 });
    const s7 = await runSend(db7, { settings: { test_recipients: ['a@example.com', 'stranger@example.com'] } }, { test: true });
    chk('a test send goes only to the configured addresses', s7.sent === true && s7.test === true);
    chk('…and never seeds a delivery row for a subscriber', db7.state.deliveries.length === 0);
    const testBatch = (s7.console_log || []).map(b => b.emails).reduce((a, b) => a.concat(b), []);
    chk('…covering both test addresses', testBatch.length === 2, JSON.stringify(testBatch));

    /* the same, checked at the URL level: the subscriber gets their own token */
    const db8 = fakeDb({ eligible: people3 });
    const s8 = await runSend(db8, { settings: { test_recipients: ['a@example.com', 'stranger@example.com'] } }, { test: true });
    const links = s8.test_links || [];
    const mine = links.filter(l => l.email === 'a@example.com')[0];
    const theirs = links.filter(l => l.email === 'stranger@example.com')[0];
    chk('a test send reports the links it embedded', links.length === 2, JSON.stringify(links));
    chk('a subscribed test address carries its own unsubscribe token',
      mine && /tok-a/.test(mine.unsubscribe) && mine.live_token === true, JSON.stringify(mine));
    chk('…and an address that is not a subscriber gets a synthetic one',
      theirs && /t=test-/.test(theirs.unsubscribe) && theirs.live_token === false, JSON.stringify(theirs));
    chk('…which is not another subscriber’s token',
      theirs && !/tok-[abc]/.test(theirs.unsubscribe), JSON.stringify(theirs));
    chk('the unsubscribe link names the sport so one edition can be dropped alone',
      mine && /sport=NFL/.test(mine.unsubscribe), JSON.stringify(mine));
    chk('a real send never returns per-subscriber links',
      (await runSend(fakeDb({ eligible: people3 }))).test_links === undefined);

    /* ==================================================================
       9 — THE STORE AND THE EDITION IDENTITY
       ================================================================== */
    section('9 — identity');
    chk('the edition key carries sport, season, week and date',
      STORE.editionKey('NFL', 2026, 2, '2026-09-15') === 'NFL:2026:W02:2026-09-15');
    chk('the file key is the same identity', STORE.fileKey('NFL:2026:W02:2026-09-15') === 'NFL-2026-W02-2026-09-15');
    const h1 = STORE.contentHash(edition);
    const h2 = STORE.contentHash(JSON.parse(JSON.stringify(edition)));
    chk('the same edition hashes the same', h1 === h2);
    const moved = JSON.parse(JSON.stringify(edition));
    moved.games[0].model.home_line = -9.9;
    chk('changed content hashes differently', STORE.contentHash(moved) !== h1);
    const clockOnly = JSON.parse(JSON.stringify(edition));
    clockOnly.composed_at = '2030-01-01T00:00:00Z';
    chk('a different clock alone does not change the hash', STORE.contentHash(clockOnly) === h1);

    /* ==================================================================
       10 — WHAT A BROWSER MAY REACH
       ================================================================== */
    section('10 — authorisation');
    const fs = require('fs');
    const ROOT = path.join(__dirname, '..', '..');
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'newsletter.sql'), 'utf8');
    chk('the subscriber table has row level security',
      /alter table public\.newsletter_subscribers\s+enable row level security/.test(sql.replace(/\s+/g, ' ')));
    chk('no policy admits a client role to the subscriber table',
      !/create policy[^;]*on public\.newsletter_subscribers/i.test(sql));
    chk('the signup door is revoked from anon and authenticated',
      /revoke all on function public\.newsletter_signup[^;]*from public, anon, authenticated/.test(sql));
    chk('the eligibility door is revoked from anon and authenticated',
      /revoke all on function public\.newsletter_eligible\(text\) from public, anon, authenticated/.test(sql));
    chk('the edition lease is revoked from anon and authenticated',
      /revoke all on function public\.newsletter_claim_edition[^;]*from public, anon, authenticated/.test(sql));
    chk('an account holder can manage only their own preference',
      /grant execute on function public\.newsletter_set_my_preferences\(boolean, boolean, text\) to authenticated/.test(sql));
    chk('sending is off by default in the schema',
      /sending_enabled boolean not null default false/.test(sql));
    chk('the edition identity is unique',
      /create unique index if not exists newsletter_editions_identity_uk\s+on public\.newsletter_editions \(sport, season, slate_week, edition_date\)/.test(sql));
    chk('a delivery row is unique per edition and address',
      /create unique index if not exists newsletter_deliveries_once_uk\s+on public\.newsletter_deliveries \(edition_id, email\)/.test(sql));
    chk('a provider event is unique',
      /create unique index if not exists newsletter_events_once_uk/.test(sql));
    chk('the schema carries no psql meta-command', !/^\\/m.test(sql));
    chk('the schema ends in a report', /CHECK THIS/.test(sql));

    const fn = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'newsletter', 'index.ts'), 'utf8');
    chk('the public edge function has no imports', !/^\s*import /m.test(fn));
    chk('the webhook route verifies a signature before storing anything',
      fn.indexOf('verifySignature') > 0 && /if \(!check\.ok\) return json\(\{ ok: false, reason: check\.reason \}, 401\)/.test(fn));
    chk('the one-click POST route exists', /req\.method === 'POST'/.test(fn) && /One-Click/.test(fn));
    chk('the operator dispatch route checks the caller first',
      /if \(!\(await callerIsAdmin\(c, req\)\)\) return json\(\{ ok: false, reason: 'not_authorised' \}, 403\)/.test(fn));
    chk('signup refuses without recorded consent', /consent_required/.test(fn));

    const page = fs.readFileSync(path.join(ROOT, 'newsletter', 'index.html'), 'utf8');
    chk('the signup page holds no service key', page.indexOf('service_role') < 0);
    chk('the signup page requires an explicit consent tick', /nlConsent/.test(page) && /consent: true/.test(page));
    chk('the consent box is not pre-ticked', !/id="nlConsent"[^>]*checked/.test(page));

    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'newsletter.yml'), 'utf8');
    chk('the workflow runs this suite before it may send',
      wf.indexOf('node tools/newsletter/newsletter.test.js') > 0);
    chk('the workflow schedules Monday and Tuesday only', /cron: '[\d,]+ 13-19 \* \* 1,2'/.test(wf));

    /* THE ORDER OF THE TWO REFRESH STEPS IS LOAD-BEARING. The research host
       injects the committed book-quote snapshot when it boots, so a market
       refresh that runs after generate.js cannot reach the records this run
       reads — which is exactly how a live run joined quotes and still
       produced a college edition with no book number on any game. */
    const iMarket = wf.indexOf('node tools/newsletter/run.js market');
    const iGenerate = wf.indexOf('node tools/articles/generate.js');
    chk('the workflow refreshes the market snapshot', iMarket > 0);
    chk('…before it regenerates the records', iMarket > 0 && iGenerate > iMarket,
      'market at ' + iMarket + ', generate at ' + iGenerate);
    chk('the market step is given the service role', /SB_SERVICE_ROLE: \$\{\{ secrets\.SB_SERVICE_ROLE \}\}/.test(wf.slice(iMarket - 900, iMarket)));
    /* THE PAGES BEHIND THE REFRESHED RECORDS ARE PART OF THE SAME RUN.
       generate.js rewrites records; the disclosure that a quote was replayed
       from a committed snapshot is asserted against the PUBLISHED PAGE by
       articles.test.js — which is this workflow's own pre-flight gate. A run
       that refreshed records and left the pages behind therefore broke the
       next run's ability to start at all. */
    /* THE READ-ONLY INSPECTION. `doctor` answers the launch questions from
       live state instead of from memory, so it must refresh nothing, commit
       nothing, and above all print no credential. */
    chk('the workflow offers the read-only doctor phase', /'doctor'\]/.test(wf), wf.slice(wf.indexOf('options:'), wf.indexOf('options:') + 120));
    chk('doctor refreshes nothing',
      (wf.match(/github\.event\.inputs\.phase != 'doctor'/g) || []).length >= 4);
    chk('doctor cannot commit',
      /Commit the edition[\s\S]{0,120}phase != 'doctor'/.test(wf));
    const runJs = fs.readFileSync(path.join(ROOT, 'tools', 'newsletter', 'run.js'), 'utf8');
    const doctor = runJs.slice(runJs.indexOf("phase === 'doctor'"), runJs.indexOf("build / send / all / preview"));
    chk('the doctor phase exists', doctor.length > 500, String(doctor.length));
    chk('it reports the service key as set or not set, never its value',
      /ds\['edgedesk\.service_key'\]/.test(doctor));
    /* the credential is READ in exactly one place, an authorization header,
       and reaches no log line. The name of the variable may of course be
       printed; its value may not. */
    const envReads = doctor.split(/process\.env\./).slice(1);
    chk('the service role is read only into an authorization header',
      envReads.every(after => /^(SB_SERVICE_ROLE|SUPABASE_SERVICE_ROLE_KEY)/.test(after) === false
        || /authorization/.test(doctor.slice(Math.max(0, doctor.indexOf('process.env.' + after.slice(0, 16)) - 120),
          doctor.indexOf('process.env.' + after.slice(0, 16)) + 40))),
      envReads.map(x => x.slice(0, 40)).join(' /// '));
    chk('it never prints the provider key',
      /pcfg\.apiKey \? 'present' : 'ABSENT'/.test(doctor)
      && !/\+ pcfg\.apiKey/.test(doctor.replace(/'Bearer ' \+ pcfg\.apiKey/g, '')),
      'the key is used as a bearer token and reported as present/absent');
    chk('it reads the sending domain from the account rather than naming records itself',
      /\/domains/.test(doctor) && /account-specific/.test(doctor));
    chk('it writes nothing', !/STORE\.(append|save)/.test(doctor) && !/upsertEdition|patchEdition/.test(doctor));

    const iBuild = wf.indexOf('node tools/articles/build_articles.js');
    chk('the workflow rebuilds the pages behind the records it refreshed', iBuild > 0);
    chk('\u2026after it has regenerated them', iBuild > iGenerate,
      'generate at ' + iGenerate + ', build at ' + iBuild);
    const iAdd = wf.indexOf('git add');
    const addLine = wf.slice(iAdd, wf.indexOf('\n', iAdd));
    chk('the run commits the refreshed snapshot, the records and the pages',
      /\barticles\b/.test(addLine), addLine);
    chk('\u2026and the sitemaps the rebuild rewrote',
      /sitemap\.xml/.test(addLine) && /sitemap-articles\.xml/.test(addLine), addLine);

    /* THE SQL SUITE HAS TO RUN SOMEWHERE. It skips (and passes) with no
       PostgreSQL so `npm test` stays green on a bare Node install — which
       means a workflow with a real database is the only place its guarantees
       are actually checked, and a suite nothing runs is a suite nobody has. */
    const sqlWf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-sql.yml'), 'utf8');
    chk('the newsletter SQL suite runs against a real PostgreSQL in CI',
      sqlWf.indexOf('node tools/newsletter/newsletter_sql.test.js') > 0);
    chk('…and a change to the schema triggers that job',
      sqlWf.indexOf("- 'supabase/newsletter.sql'") > 0);
    chk('…and a change to the suite itself does too',
      sqlWf.indexOf("- 'tools/newsletter/newsletter_sql.test.js'") > 0);
    /* AND THE JOB REFUSES TO GO GREEN ON A SKIP. The suite passes when no
       PostgreSQL is reachable, so a job that ran it without checking for
       SKIP would report success on a suite that never executed — which is
       the same "nothing is actually checking this" hole one step removed. */
    chk('the silent-skip guard covers the newsletter log',
      /for f in [^\n]*\bnewsletter\.log\b/.test(sqlWf), 'newsletter.log is not in the guard list');

    /* ================================================================== */
    console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk newsletter | ' + pass + ' passed, ' + fail + ' failed');
    if (fail) { failures.forEach(f => console.log('  × ' + f)); process.exit(1); }
    void assert;
  })();
}
