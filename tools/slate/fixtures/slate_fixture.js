'use strict';
/* ===========================================================================
   A deterministic slate for the tests: the REAL builder (tools/slate/build.js)
   run over constructed ESPN payloads (espn_shapes.js) and constructed research
   artifacts, at a pinned clock. Every case the slate must handle is in it:

     NOW = 2026-10-13T22:30:00Z = Tue 5:30 PM CDT (America/Chicago)
     NHL   live NJ @ DET (2–1, 2nd 12:34) · CBJ v FLA 6 PM CDT, priced (puck line)
           · BUF @ MTL final (Montréal, for the accent-blind search)
           · SEA @ VGK 11:50 PM CDT (today) · LA @ SJ 12:10 AM CDT (tomorrow),
             both on ESPN's Oct 13 Eastern scoreboard
     MLB   NYY @ BOS doubleheader: game 1 final, game 2 tonight (run line,
           the provider's "Game 2" note) · HOU @ SEA postponed
     CFB   DEL @ MTSU tonight: research + a free article, a consensus-only
           quote (refused → "Odds unavailable")
     NFL   SEA @ DEN Thursday (priced) · HOU v JAX at Wembley, neutral (Upcoming)
     Soccer ARS v CHE final yesterday · BAR v RMA live 60' · LIV v MCI
           tomorrow with a draw price (1X2)
     NBA   nothing this week; BOS @ NYK on Oct 20 (Upcoming)
     UFC   the scoreboard answers 503 for every day (unable to load)
     NCAA baseball and basketball: answered, empty (no games scheduled)
   =========================================================================== */
const path = require('path');
const E = require('./espn_shapes.js');
const BUILD = require('../build.js');
const RES = require('../research.js');
const ROOT = path.join(__dirname, '..', '..', '..');

const NOW = Date.parse('2026-10-13T22:30:00Z');
const T = {
  NJ: E.team('NJ', 'New Jersey Devils', 'Devils', 1), DET: E.team('DET', 'Detroit Red Wings', 'Red Wings', 5),
  FLA: E.team('FLA', 'Florida Panthers', 'Panthers', 26), CBJ: E.team('CBJ', 'Columbus Blue Jackets', 'Blue Jackets', 29),
  BUF: E.team('BUF', 'Buffalo Sabres', 'Sabres', 2), MTL: E.team('MTL', 'Montréal Canadiens', 'Canadiens', 10),
  SEAk: E.team('SEA', 'Seattle Kraken', 'Kraken', 124292), VGK: E.team('VGK', 'Vegas Golden Knights', 'Golden Knights', 37),
  LA: E.team('LA', 'Los Angeles Kings', 'Kings', 8), SJ: E.team('SJ', 'San Jose Sharks', 'Sharks', 18),
  NYY: E.team('NYY', 'New York Yankees', 'Yankees', 10), BOS: E.team('BOS', 'Boston Red Sox', 'Red Sox', 2),
  HOU: E.team('HOU', 'Houston Astros', 'Astros', 18), SEA: E.team('SEA', 'Seattle Mariners', 'Mariners', 12),
  DEL: E.team('DEL', 'Delaware Blue Hens', 'Blue Hens', 48), MTSU: E.team('MTSU', 'Middle Tennessee Blue Raiders', 'Blue Raiders', 2393),
  SEAf: E.team('SEA', 'Seattle Seahawks', 'Seahawks', 26), DEN: E.team('DEN', 'Denver Broncos', 'Broncos', 7),
  HOUf: E.team('HOU', 'Houston Texans', 'Texans', 34), JAX: E.team('JAX', 'Jacksonville Jaguars', 'Jaguars', 30),
  ARS: E.team('ARS', 'Arsenal', 'Arsenal', 359), CHE: E.team('CHE', 'Chelsea', 'Chelsea', 363),
  LIV: E.team('LIV', 'Liverpool', 'Liverpool', 364), MCI: E.team('MCI', 'Manchester City', 'Man City', 382),
  BAR: E.team('BAR', 'Barcelona', 'Barcelona', 83), RMA: E.team('RMA', 'Real Madrid', 'Real Madrid', 86),
  BOSn: E.team('BOS', 'Boston Celtics', 'Celtics', 2), NYK: E.team('NY', 'New York Knicks', 'Knicks', 18)
};

function table() {
  const t = {};
  t['hockey/nhl|20261013'] = E.board([
    E.event({ id: 401802001, date: '2026-10-13T22:00Z', home: T.DET, away: T.NJ, hs: 2, as: 1, hrec: '2-1-0', arec: '1-2-0', venue: 'Little Caesars Arena', city: 'Detroit', state: 'MI',
      status: E.status('live', { detail: '2nd 12:34', period: 2, clock: '12:34' }),
      odds: E.odds({ book: 'DraftKings', homeAbbr: 'DET', awayAbbr: 'NJ', home: { ml: -140, line: -1.5, price: 190 }, away: { ml: 120, price: -230 }, total: 6.5, over: -110, under: -110 }) }),
    E.event({ id: 401802002, date: '2026-10-13T23:00Z', home: T.CBJ, away: T.FLA, venue: 'Nationwide Arena', city: 'Columbus', state: 'OH', status: E.status('pre'),
      odds: E.odds({ book: 'DraftKings', homeAbbr: 'CBJ', awayAbbr: 'FLA', home: { ml: 130, line: 1.5, price: -205 }, away: { ml: -150, price: 170 }, total: 6.5, over: -110, under: -110 }) }),
    E.event({ id: 401802003, date: '2026-10-13T17:00Z', home: T.MTL, away: T.BUF, hs: 4, as: 3, status: E.status('final', { detail: 'Final/OT', name: 'STATUS_FINAL' }) }),
    E.event({ id: 401802004, date: '2026-10-14T04:50Z', home: T.VGK, away: T.SEAk, status: E.status('pre') }),
    E.event({ id: 401802005, date: '2026-10-14T05:10Z', home: T.SJ, away: T.LA, status: E.status('pre') })
  ]);
  t['baseball/mlb|20261013'] = E.board([
    E.event({ id: 401803001, date: '2026-10-13T17:05Z', home: T.BOS, away: T.NYY, hs: 5, as: 3, status: E.status('final') }),
    E.event({ id: 401803002, date: '2026-10-13T23:10Z', home: T.BOS, away: T.NYY, notes: ['Game 2'], status: E.status('pre'),
      odds: E.odds({ book: 'FanDuel', homeAbbr: 'BOS', awayAbbr: 'NYY', home: { ml: -120, line: -1.5, price: 140 }, away: { ml: 100, price: -160 }, total: 8.5, over: -105, under: -115 }) }),
    E.event({ id: 401803003, date: '2026-10-14T01:40Z', home: T.SEA, away: T.HOU, status: E.status('postponed') })
  ]);
  t['football/college-football|20261013'] = E.board([
    E.event({ id: 401871067, date: '2026-10-13T23:00Z', home: T.MTSU, away: T.DEL, venue: 'Floyd Stadium', city: 'Murfreesboro', state: 'TN', week: 7, status: E.status('pre'),
      odds: E.odds({ book: 'consensus', homeAbbr: 'MTSU', awayAbbr: 'DEL', home: { ml: -180, line: -4.5, price: -110 }, away: { ml: 150, price: -110 }, total: 49.5, over: -110, under: -110 }) })
  ]);
  t['football/nfl|20261015'] = E.board([
    E.event({ id: 401880001, date: '2026-10-16T00:15Z', home: T.DEN, away: T.SEAf, venue: 'Empower Field at Mile High', city: 'Denver', state: 'CO', week: 6, status: E.status('pre'),
      odds: E.odds({ book: 'DraftKings', homeAbbr: 'DEN', awayAbbr: 'SEA', home: { ml: 125, line: 2.5, price: -110 }, away: { ml: -145, price: -110 }, total: 39.5, over: -110, under: -110 }) })
  ]);
  t['football/nfl|20261018'] = E.board([
    E.event({ id: 401880002, date: '2026-10-18T13:30Z', home: T.JAX, away: T.HOUf, neutral: true, venue: 'Wembley Stadium', city: 'London', state: 'England', week: 6, status: E.status('pre') })
  ]);
  t['soccer/eng.1|20261012'] = E.board([
    E.event({ id: 701001, date: '2026-10-12T19:00Z', home: T.ARS, away: T.CHE, hs: 2, as: 2, status: E.status('final', { name: 'STATUS_FULL_TIME', detail: 'FT' }) })
  ]);
  t['soccer/eng.1|20261014'] = E.board([
    E.event({ id: 701002, date: '2026-10-14T19:00Z', home: T.LIV, away: T.MCI, venue: 'Anfield', city: 'Liverpool', state: 'England', status: E.status('pre'),
      odds: E.odds({ book: 'DraftKings', homeAbbr: 'LIV', awayAbbr: 'MCI', home: { ml: 120 }, away: { ml: 210 }, draw: 250, total: 2.5, over: -130, under: 110 }) })
  ]);
  t['soccer/esp.1|20261013'] = E.board([
    E.event({ id: 701003, date: '2026-10-13T21:30Z', home: T.BAR, away: T.RMA, hs: 1, as: 1, status: E.status('live', { name: 'STATUS_SECOND_HALF', detail: "60'", period: 2, clock: "60'" }) })
  ]);
  t['basketball/nba|20261020'] = E.board([
    E.event({ id: 401900001, date: '2026-10-20T23:30Z', home: T.NYK, away: T.BOSn, status: E.status('pre') })
  ]);
  for (let d = 0; d < 20; d++) {
    const day = new Date(Date.UTC(2026, 9, 11 + d)).toISOString().slice(0, 10).replace(/-/g, '');
    t['mma/ufc|' + day] = { status: 503 };
  }
  return t;
}

function research() {
  const real = RES.loadSources();
  return {
    nfl: { games: [{ game_id: '2026_06_SEA_DEN', kickoff: '2026-10-16T00:15:00.000Z', home_team: 'Denver Broncos', away_team: 'Seattle Seahawks', home_code: 'DEN', away_code: 'SEA',
      model_status: 'PREDICTED', model_home_line: 0.5, model_fair_total: 41.2, model_fair_home_ml: 102, model_fair_away_ml: -102, data_quality: { status: 'OK' }, features: {} }],
      pricing: { tier: 'LEAN', rows: [{ game_id: '2026_06_SEA_DEN', status: 'PASS', tier: 'LEAN', why: 'EdgeDesk and the market agree within the LEAN band.' }] } },
    cfb: { rows: [{ game_id: '401871067', status: 'RESEARCH', status_reason: 'A 6-point disagreement at a live price.', fair_home_margin: 10.5, fair_total: 51, decision_status: 'PASS', decision_reason: 'below the certified threshold' }],
      statuses: { RESEARCH: { label: 'RESEARCH', means: 'Worth opening — not a certified bet.' } } },
    home: { games: [{ key: 'cfb|401871067' }] },
    nhl: { games: [
      { game_id: 2026020090, start_utc: '2026-10-13T22:00:00Z', home: 'DET', away: 'NJD', prices: { moneyline: { fair_home: -135, fair_away: 135 }, total: { fair_line: 6 }, puck_line: { fair_home_minus_1_5: 181, fair_away_plus_1_5: -181 } } },
      { game_id: 2026020091, start_utc: '2026-10-13T23:00:00Z', home: 'CBJ', away: 'FLA', prices: { moneyline: { fair_home: 112, fair_away: -112 }, total: { fair_line: 6.5 }, puck_line: { fair_home_minus_1_5: 260, fair_away_plus_1_5: -260 } } }],
      readiness: { model: { moneyline: { status: 'OUTCOME_VALIDATED' } } } },
    nhlTeams: real.nhlTeams,
    basketball: { leagues: { nba: { games: [] } } },
    soccer: { leagues: {} },
    engine: { verdict: 'PASS' },
    published: { articles: [{ game_id: '401871067', type: 'pregame', url: '/articles/delaware-vs-middle-tennessee-2026/', title: 'Delaware at Middle Tennessee' }] }
  };
}

async function buildFixture(o) {
  o = o || {};
  const r = await BUILD.build({
    now: o.now != null ? o.now : NOW, fetch: E.fakeFetch(o.table || table(), o.log), prev: o.prev !== undefined ? o.prev : null,
    artifacts: o.artifacts || { bySport: {}, sources: [] }, research: o.research || research(), concurrency: 6, force: o.force, spacingMs: 0
  });
  return r;
}

module.exports = { NOW, T, table, research, buildFixture, ROOT };

if (require.main === module) {
  buildFixture().then((r) => { process.stdout.write(JSON.stringify(r.snap, null, 1)); });
}
