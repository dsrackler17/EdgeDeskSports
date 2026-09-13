/* ============================================================================
   THE SCENARIOS THE PRODUCT IS BUILT AROUND.

   ALL SYNTHETIC. Each case is a real research payload SHAPE with numbers
   chosen to force one specific outcome out of the grader, paired with a final
   score and a box score that force the other half. None of it is a real game,
   a real EdgeDesk projection or a real box score, and nothing here is ever
   read by the pipeline.

   The four that matter most are the four quadrants of the whole product:

     EdgeDesk right, thesis right      the case the system is trying to produce
     EdgeDesk right, thesis WRONG      the dangerous one — it pays and teaches
                                       nothing, and must be reported as such
     EdgeDesk wrong, thesis right      the one that should change the least
     EdgeDesk wrong, thesis wrong      the one that should change something

   Plus: a push, a game decided by turnovers, a dramatic market move, and a
   game whose spread result flips on the final score — which is the case a
   results-oriented reading gets most wrong.

   Every case declares what the grader MUST say about it. The suite asserts
   that, not the internals, so the scenarios keep working when the scoring
   changes and stop working when the PHILOSOPHY does.
   ========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const BASE = require(path.join(ROOT, 'articles', 'data', 'records', 'nfl-2026_01_NE_SEA.json')).research;

const HOME = 'Seattle Seahawks', AWAY = 'New England Patriots';

/* A research payload built off the committed one, with the two numbers that
   decide everything replaced. Using a REAL payload shape is the point: a
   fixture written by hand would not have the fields the extractor reads. */
function research(o) {
  const r = JSON.parse(JSON.stringify(BASE));
  r.projection.fair_spread_text = o.model_line;
  r.projection.fair_spread = o.model_margin;
  r.projection.favourite = o.model_favourite;
  r.projection.underdog = o.model_favourite === HOME ? AWAY : HOME;
  r.projection.total = String(o.model_total);
  if (r.projection.score) {
    r.projection.score.away = { team: AWAY, points: String(o.projected_away) };
    r.projection.score.home = { team: HOME, points: String(o.projected_home) };
  }
  if (o.market_line === null) {
    r.market = { available: false, headline: 'No sportsbook quote was captured for this game.',
      model: o.model_line, note: 'EdgeDesk publishes its own number whether or not a book has one.' };
  } else {
    r.market = { available: true, model: o.model_line, market: o.market_line,
      difference: o.market_difference + ' points', total_model: String(o.model_total),
      total_market: o.market_total == null ? null : String(o.market_total),
      book: 'A Fixture Book', capture_age: '3 hours old', stale: false,
      classification: 'INVESTIGATE',
      classification_note: 'EdgeDesk differs from the market by ' + o.market_difference + ' points.',
      note: 'EdgeDesk compares its own number with a captured price.' };
  }
  /* The drivers are what the thesis audit grades, so each scenario states
     which side the model's largest published contributions favour. */
  r.drivers.rows = [
    { points: '+2.5', points_n: 2.5, text: 'Model baseline — the team-strength model’s constant', favours: o.driver_side },
    { points: '+1.8', points_n: 1.8, text: 'Net passing EPA — ' + o.driver_side + ' by 1.8 points', favours: o.driver_side },
    { points: '+1.1', points_n: 1.1, text: 'Net EPA per play — ' + o.driver_side + ' by 1.1 points', favours: o.driver_side },
    { points: '+0.7', points_n: 0.7, text: 'Sacks generated per dropback — ' + o.driver_side + ' by 0.7 points', favours: o.driver_side }
  ];
  /* THE MEASURED ADVANTAGES POINT THE SAME WAY AS THE DRIVERS. Without this
     the base payload's own advantage lists survive into every scenario, so a
     case labelled "thesis right" carried one claim about the other side that
     the fixture's box score was built to contradict — and the process grade
     came back MIXED on a scenario whose whole point is that it should not.
     A fixture has to mean what its name says. */
  const other = o.driver_side === HOME ? AWAY : HOME;
  const lead = o.driver_side === HOME ? 'home' : 'away';
  r.advantages = {
    away: [], home: [], measured: [], unproven: [],
    note: r.advantages && r.advantages.note || null
  };
  r.advantages[lead] = [
    { k: 'Pass offence · EPA per dropback', rank_gap: 15, gap: 0.11,
      lead: o.driver_side, trail: other,
      lead_cell: '+0.110 · #4 of 32', trail_cell: '−0.010 · #19 of 32',
      text: o.driver_side + ' +0.110 (#4 of 32) vs ' + other + ' −0.010 (#19 of 32) — 15 places on the league board.' }
  ];

  /* One complete matchup, pointed the same way, so the audit has something
     beyond the drivers to grade. */
  r.matchups = [{
    title: o.driver_side + ' pass offence vs ' + (o.driver_side === HOME ? AWAY : HOME) + ' pass defence',
    complete: true, net: -0.09,
    read: o.driver_side + '’s pass offence rates +0.110 (#4 of 32) and '
      + (o.driver_side === HOME ? AWAY : HOME) + '’s pass defence rates −0.010 (#19 of 32). '
      + 'Added the way the model adds them, this pairing sits −0.090 from the league mean, which favours ' + o.driver_side + '.'
  }];
  return r;
}

const META = {
  sport: 'NFL', game_id: 'FIXTURE', home: HOME, away: AWAY,
  home_short: 'Seahawks', away_short: 'Patriots',
  kickoff: '2026-09-09T20:20:00.000Z', venue: 'A Fixture Stadium',
  neutral_site: false, week: 1, season: 2026
};

/* A box score shaped for one purpose: to make the audit's expected signals
   land on a named side by a named amount. The metric names are the vocabulary
   in results.js, so a scenario cannot ask for a statistic nothing publishes. */
function metrics(o) {
  function side(m) {
    return {
      points: m.points, total_yards: m.yards, total_plays: m.plays, yards_per_play: m.ypp,
      net_pass_yards: m.passYards, yards_per_pass: m.ypa, completion_pct: m.compPct,
      rush_yards: m.rushYards, yards_per_rush: m.ypc, first_downs: m.firstDowns,
      third_down_pct: m.thirdDown, turnovers: m.turnovers, sacks_allowed: m.sacksAllowed,
      penalties: m.penalties, penalty_yards: m.penaltyYards,
      possession_seconds: m.possession, drives: 11, defensive_tds: m.defTds || 0
    };
  }
  return { home: side(o.home), away: side(o.away) };
}

/* A side that dominated every observable phase. */
function dominant(points, defTds) {
  return { points, yards: 430, plays: 66, ypp: 6.5, passYards: 295, ypa: 8.4, compPct: 71.0,
    rushYards: 135, ypc: 5.2, firstDowns: 26, thirdDown: 55.0, turnovers: 0,
    sacksAllowed: 1, penalties: 4, penaltyYards: 30, possession: 1980, defTds: defTds || 0 };
}
/* And a side that did not. */
function dominated(points, turnovers, defTds) {
  return { points, yards: 232, plays: 54, ypp: 4.3, passYards: 148, ypa: 4.6, compPct: 54.0,
    rushYards: 84, ypc: 3.1, firstDowns: 13, thirdDown: 25.0, turnovers: turnovers == null ? 2 : turnovers,
    sacksAllowed: 5, penalties: 8, penaltyYards: 70, possession: 1620, defTds: defTds || 0 };
}
/* Two sides that could not be told apart. */
function level(points, turnovers) {
  return { points, yards: 318, plays: 61, ypp: 5.2, passYards: 205, ypa: 6.1, compPct: 63.0,
    rushYards: 113, ypc: 4.1, firstDowns: 19, thirdDown: 40.0, turnovers: turnovers == null ? 1 : turnovers,
    sacksAllowed: 2, penalties: 6, penaltyYards: 48, possession: 1800, defTds: 0 };
}

const SCENARIOS = [
  {
    name: 'EdgeDesk right, thesis right',
    why: 'The side EdgeDesk preferred covered AND won every phase the model said it would. This is the only one of the four where the result is evidence the process works.',
    research: research({ model_line: HOME + ' -7.5', model_margin: 7.5, model_favourite: HOME,
      model_total: 44.0, projected_away: 18, projected_home: 26,
      market_line: HOME + ' -3.0', market_difference: '4.5', market_total: 44.5, driver_side: HOME }),
    result: { home_score: 31, away_score: 17, metrics: metrics({ home: dominant(31), away: dominated(17) }) },
    expect: { spread: 'win', process: 'SOUND', verdict: 'right_for_the_right_reason',
      market_gap_verdict: 'CONFIRMED' }
  },
  {
    name: 'EdgeDesk right, thesis WRONG',
    why: 'The number cashed on two defensive touchdowns while the offence EdgeDesk rated higher was beaten in every phase. The article must say the reasoning did not hold, in a game that paid.',
    research: research({ model_line: HOME + ' -7.5', model_margin: 7.5, model_favourite: HOME,
      model_total: 44.0, projected_away: 18, projected_home: 26,
      market_line: HOME + ' -3.0', market_difference: '4.5', market_total: 44.5, driver_side: HOME }),
    /* Seattle wins 31-10 having been outplayed everywhere that is measured:
       two defensive scores and a four-turnover swing put the points up. */
    result: { home_score: 31, away_score: 10,
      metrics: metrics({ home: Object.assign(dominated(31, 0, 2), { turnovers: 0 }),
        away: Object.assign(dominant(10), { turnovers: 4 }) }) },
    expect: { spread: 'win', process: 'UNSOUND', verdict: 'right_for_the_wrong_reason',
      lesson_id: 'won_wrong', variance: ['turnover_swing', 'defensive_td'] }
  },
  {
    name: 'EdgeDesk wrong, thesis right',
    why: 'The side EdgeDesk preferred was better in every measured phase and lost by three on a late field goal. This is the result a bettor should be least upset about and the one that should change the least.',
    research: research({ model_line: HOME + ' -7.5', model_margin: 7.5, model_favourite: HOME,
      model_total: 44.0, projected_away: 18, projected_home: 26,
      market_line: HOME + ' -3.0', market_difference: '4.5', market_total: 44.5, driver_side: HOME }),
    result: { home_score: 20, away_score: 23, metrics: metrics({ home: dominant(20), away: dominated(23, 0) }) },
    expect: { spread: 'loss', process: 'SOUND', verdict: 'wrong_for_the_right_reason',
      lesson_id: 'lost_right' }
  },
  {
    name: 'EdgeDesk wrong, thesis wrong',
    why: 'The mechanism EdgeDesk named ran the other way and the number lost with it. This is the case that should change something, and the lessons must say what.',
    research: research({ model_line: HOME + ' -7.5', model_margin: 7.5, model_favourite: HOME,
      model_total: 44.0, projected_away: 18, projected_home: 26,
      market_line: HOME + ' -3.0', market_difference: '4.5', market_total: 44.5, driver_side: HOME }),
    result: { home_score: 13, away_score: 34, metrics: metrics({ home: dominated(13, 1), away: dominant(34) }) },
    expect: { spread: 'loss', process: 'UNSOUND', verdict: 'wrong_for_the_wrong_reason',
      review_required: true }
  },
  {
    name: 'the spread pushes',
    why: 'A margin that lands exactly on the captured number, and a combined score that lands exactly on the captured total. Neither is ever rounded into a win or a loss.',
    research: research({ model_line: HOME + ' -7.5', model_margin: 7.5, model_favourite: HOME,
      model_total: 44.0, projected_away: 18, projected_home: 26,
      market_line: HOME + ' -3.0', market_difference: '4.5', market_total: 45.0, driver_side: HOME }),
    result: { home_score: 24, away_score: 21, metrics: metrics({ home: dominant(24), away: dominated(21, 1) }) },
    expect: { spread: 'push', total: 'push' }
  },
  {
    name: 'a game decided by turnovers',
    why: 'A four-turnover swing is the least repeatable thing in football. Whatever the scoreboard says, the process grade must not treat the result as evidence.',
    research: research({ model_line: HOME + ' -2.0', model_margin: 2.0, model_favourite: HOME,
      model_total: 44.0, projected_away: 21, projected_home: 23,
      market_line: HOME + ' -2.0', market_difference: '0.0', market_total: 44.0, driver_side: HOME }),
    result: { home_score: 27, away_score: 24,
      metrics: metrics({ home: Object.assign(level(27), { turnovers: 0, defTds: 1 }),
        away: Object.assign(level(24), { turnovers: 4 }) }) },
    expect: { variance: ['turnover_swing', 'defensive_td'], process: 'UNTESTED' }
  },
  {
    name: 'no sportsbook quote was captured',
    why: 'With no market number there is no implied side and no bet to grade. The process is still graded, which is the half that compounds — and the article says so instead of inventing a line.',
    research: research({ model_line: HOME + ' -6.0', model_margin: 6.0, model_favourite: HOME,
      model_total: 43.0, projected_away: 19, projected_home: 25,
      market_line: null, driver_side: HOME }),
    result: { home_score: 28, away_score: 17, metrics: metrics({ home: dominant(28), away: dominated(17) }) },
    expect: { spread: null, implied_available: false }
  },
  {
    name: 'the market moved dramatically after publication',
    why: 'EdgeDesk published at one number and the market closed four points away, toward EdgeDesk’s side. Closing-line movement is the only evidence available before a large sample of results, and it is reported whichever way it went.',
    research: research({ model_line: HOME + ' -7.0', model_margin: 7.0, model_favourite: HOME,
      model_total: 44.0, projected_away: 19, projected_home: 26,
      market_line: HOME + ' -2.5', market_difference: '4.5', market_total: 44.0, driver_side: HOME }),
    result: { home_score: 30, away_score: 20, metrics: metrics({ home: dominant(30), away: dominated(20) }) },
    closing_home_margin: -6.5,
    closing_source: 'a fixture closing line',
    expect: { spread: 'win', clv_positive: true, clv_points: 4 }
  },
  {
    name: 'garbage time changes the spread result',
    why: 'A late score in a decided game moves the number without telling anybody anything about the matchup. The grader must record the flip and the process grade must not reward it.',
    research: research({ model_line: HOME + ' -9.0', model_margin: 9.0, model_favourite: HOME,
      model_total: 45.0, projected_away: 18, projected_home: 27,
      market_line: HOME + ' -7.0', market_difference: '2.0', market_total: 45.0, driver_side: HOME }),
    result: { home_score: 31, away_score: 23,
      metrics: metrics({ home: dominant(31), away: dominated(23, 1) }),
      /* the running score shows the away side scoring a meaningless late
         touchdown that takes the margin from 15 to 8 */
      scoring_plays: [
        { period: 3, clock: '2:10', team: HOME, type: 'TD', text: '4 Yd Rush', home_score: 31, away_score: 16 },
        { period: 4, clock: '0:32', team: AWAY, type: 'TD', text: '22 Yd Pass', home_score: 31, away_score: 23 }
      ] },
    expect: { spread: 'win', flip_before: 'win', flipped: false }
  }
];

module.exports = { SCENARIOS, research, metrics, META, HOME, AWAY, dominant, dominated, level };
