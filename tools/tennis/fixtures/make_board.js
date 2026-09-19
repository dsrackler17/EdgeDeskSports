#!/usr/bin/env node
/* ===========================================================================
   A synthetic upcoming tennis slate, built from the REAL record already in the
   database.

   WHY IT EXISTS. Everything downstream of the archive — the board, the fair
   price, the research gate, the public record, the AI context — can only be
   exercised against matches that have not been played yet. The live pipeline
   produces those from a scoreboard, which means a network, a tournament
   actually being on, and a runner. None of those are available to a test.

   So this takes the highest-rated players the record actually knows about,
   pairs them, dates the fixtures in the near future, and writes them into
   tennis.live_matches with a synthetic provider id. It also writes a
   market price for each, so the whole priced path can run.

   IT IS NEVER PRODUCTION DATA AND IT SAYS SO. Every row it writes carries
   provider 'fixture' and ids prefixed 'fixture:', so nothing can mistake one
   for a real draw, and --clean removes exactly what it wrote and nothing else.

   Usage:
     node tools/tennis/fixtures/make_board.js --commit [--matches 12]
     node tools/tennis/fixtures/make_board.js --clean
   =========================================================================== */
'use strict';
const PG = require('../lib/pg.js');
const M = require('../../../lib/tennis_model.js');

const PROVIDER = 'fixture';

function args(argv) {
  const o = { matches: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--commit') o.commit = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--matches') o.matches = Math.max(2, Number(next()) || 12);
    else if (a === '--database') o.database = next();
  }
  return o;
}
const say = (...a) => console.log(...a);

function main() {
  const o = args(process.argv.slice(2));
  const conn = PG.resolveConnection();
  if (!conn) { console.error('::error::no database connection'); return 1; }
  const db = PG.client(conn, { database: o.database });

  if (o.clean) {
    db.transaction([
      `delete from tennis.odds_snapshots where match_ref like 'fixture:%';`,
      `delete from tennis.research_opportunities where match_ref like 'fixture:%';`,
      `delete from tennis.market_captures where match_id like 'fixture:%';`,
      `delete from tennis.live_matches where provider = '${PROVIDER}';`,
      `delete from tennis.tournaments where provider = '${PROVIDER}';`
    ]);
    say('removed every synthetic fixture row');
    return 0;
  }

  const players = db.rows(`
    select r.player_id, r.tour, p.full_name, r.power_rating, r.rating_sample
      from tennis.player_ratings_current r
      join tennis.players p on p.player_id = r.player_id
     where r.active and r.power_rating is not null and r.rating_sample >= 10
     order by r.tour, r.power_rating desc
     limit ${o.matches * 2 + 8}`);
  if (players.length < 4) { console.error('::error::not enough rated players — import the archive and build ratings first'); return 1; }

  const byTour = {};
  players.forEach((p) => (byTour[p.tour] = byTour[p.tour] || []).push(p));

  const now = Date.now();
  const tournaments = [], matches = [], captures = [];
  let n = 0;
  Object.keys(byTour).forEach((tour) => {
    const pool = byTour[tour];
    const surf = tour === 'ATP' ? 'clay' : 'hard';
    const tid = `${PROVIDER}:${tour}:demo-week`;
    tournaments.push({ tid, tour, surf,
      name: `${tour} Demo Championships`, indoor: false });
    for (let i = 0; i + 1 < pool.length && n < o.matches; i += 2, n++) {
      const a = pool[i], b = pool[i + 1];
      matches.push({
        match_id: `${PROVIDER}:${tour}:${n}`, tid, tour,
        a, b,
        scheduled_at: new Date(now + (n + 1) * 3600 * 1000).toISOString(),
        round: n < 2 ? 'QF' : 'R16', best_of: tour === 'ATP' ? 3 : 3
      });
    }
  });

  /* A market, built to DISAGREE with the model in a controlled way, so the gap
     column is exercised rather than always zero. The book's margin is real
     (about 4.5%), so the de-vig path is exercised too. */
  matches.forEach((m, i) => {
    const pa = Number(m.a.power_rating), pb = Number(m.b.power_rating);
    let marketA = 1 / (1 + Math.pow(10, (pb - pa) / 22));
    marketA = Math.min(0.92, Math.max(0.08, marketA + (i % 3 === 0 ? 0.07 : i % 3 === 1 ? -0.05 : 0.0)));
    const margin = 1.045;
    const decA = M.round(1 / (marketA * margin), 4), decB = M.round(1 / ((1 - marketA) * margin), 4);
    captures.push({ match_id: m.match_id, tid: m.tid, side: 'home', dec: decA, fair: M.round(1 / marketA, 4) });
    captures.push({ match_id: m.match_id, tid: m.tid, side: 'away', dec: decB, fair: M.round(1 / (1 - marketA), 4) });
  });

  say(`${matches.length} synthetic fixtures across ${tournaments.length} tour(s), ${captures.length} price captures`);
  matches.slice(0, 6).forEach((m) => say(`  ${m.tour}  ${m.a.full_name} (${m.a.power_rating}) vs ${m.b.full_name} (${m.b.power_rating})`));
  if (!o.commit) { say('\nDRY RUN — nothing written. Re-run with --commit.'); return 0; }

  const stmts = [];
  tournaments.forEach((t) => stmts.push(`insert into tennis.tournaments
    (tournament_id, provider, provider_tournament_id, tour, name, level, surface, indoor,
     environment, state, start_date, end_date, source, source_key)
    values (${PG.lit(t.tid)}, ${PG.lit(PROVIDER)}, ${PG.lit(t.tid)}, ${PG.lit(t.tour)},
            ${PG.lit(t.name)}, 'A', ${PG.lit(t.surf)}, false, 'outdoor', 'scheduled',
            current_date, current_date + 7, ${PG.lit(PROVIDER)}, 'espn')
    on conflict (tournament_id) do update set state='scheduled', updated_at=now();`));
  matches.forEach((m) => stmts.push(`insert into tennis.live_matches
    (match_id, tournament_id, provider, provider_match_id, tour, round, best_of, scheduled_at,
     home_name, away_name, home_player_id, away_player_id, is_doubles, status)
    values (${PG.lit(m.match_id)}, ${PG.lit(m.tid)}, ${PG.lit(PROVIDER)}, ${PG.lit(m.match_id)},
            ${PG.lit(m.tour)}, ${PG.lit(m.round)}, ${m.best_of}, ${PG.lit(m.scheduled_at)},
            ${PG.lit(m.a.full_name)}, ${PG.lit(m.b.full_name)},
            ${PG.lit(m.a.player_id)}, ${PG.lit(m.b.player_id)}, false, 'scheduled')
    on conflict (match_id) do update set scheduled_at=excluded.scheduled_at, status='scheduled', updated_at=now();`));
  captures.forEach((c, i) => stmts.push(`insert into tennis.market_captures
    (match_id, tournament_id, sig_key, side, book, capture_at, market_state, best_dec, sharp_fair, n_books, has_sharp, source)
    values (${PG.lit(c.match_id)}, ${PG.lit(c.tid)}, ${PG.lit(c.match_id + ':' + c.side)},
            ${PG.lit(c.side)}, 'draftkings', now(), 'PRE', ${c.dec}, ${c.fair}, 6, true, 'fixture')
    on conflict (sig_key, capture_at) do nothing;`));
  db.transaction(stmts);
  say('\nwritten. Now: node tools/tennis/price_board.js --commit');
  return 0;
}
if (require.main === module) process.exit(main());
