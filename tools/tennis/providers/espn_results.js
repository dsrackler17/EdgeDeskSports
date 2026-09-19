#!/usr/bin/env node
/* LiveResultsProvider + RankingsProvider — the public scoreboard.

   This wraps tools/tennis/espn.js, which already exists, is already tested and
   already drives the Live Match Center. Nothing about that pipeline changes:
   this is the NORMALISING face of it, so the research layer can consume
   fixtures without knowing that a competition id or a "Men's Singles" bucket
   exists. The adapter is deliberately thin — the parsing lives where it is
   tested. */
'use strict';
const P = require('./index.js');
const M = require('../../../lib/tennis_model.js');

let ESPN = null;
function espn() {
  if (ESPN) return ESPN;
  try { ESPN = require('../espn.js'); } catch (e) { ESPN = { unavailable: String(e.message) }; }
  return ESPN;
}

module.exports = P.defineProvider({
  kind: 'live_results',
  name: 'espn_scoreboard',
  source_key: 'espn',
  credentials: [],
  capabilities: {
    pre_match_features: false, serve_statistics: true, exact_start_time: true,
    live_score: true, closing_price: false, doubles: true
  },

  /* Fixtures already stored by the existing sync, normalised. Reading the
     DATABASE rather than the network is deliberate: the scoreboard is polled
     by tools/tennis/sync_events.js and tools/tennis/live_poll.js on their own
     schedule, and a second poller asking the same questions would double the
     load on a source that has answered 403 to this project's runners before. */
  async fixtures(db, opts) {
    const o = opts || {};
    const from = o.from || new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const to = o.to || new Date(Date.now() + (o.days || 3) * 24 * 3600 * 1000).toISOString();
    const rows = db.rows(`
      select lm.match_id, lm.tour, lm.tournament_id, t.name as tournament_name,
             t.surface, t.indoor, t.environment, lm.round, lm.best_of, lm.scheduled_at,
             lm.status, lm.is_doubles, lm.home_player_id, lm.away_player_id,
             lm.home_name, lm.away_name, lm.home_provider_id, lm.away_provider_id
        from tennis.live_matches lm
        left join tennis.tournaments t on t.tournament_id = lm.tournament_id
       where lm.scheduled_at between '${from}'::timestamptz and '${to}'::timestamptz
       order by lm.scheduled_at
       limit ${Math.max(1, Math.min(o.limit || 500, 2000))}`);
    return rows.map((r) => ({
      source_key: 'espn',
      match_ref: r.match_id,
      tour: M.normTour(r.tour),
      tournament_ref: r.tournament_id,
      tournament_name: r.tournament_name,
      surface: M.surfaceOrUnknown(r.surface),
      environment: r.indoor === true ? 'indoor' : (r.indoor === false ? 'outdoor' : (r.environment || 'unknown')),
      round: r.round,
      best_of: r.best_of,
      scheduled_at: r.scheduled_at,
      status: r.status,
      is_doubles: !!r.is_doubles,
      player_a_source_id: r.home_provider_id,
      player_b_source_id: r.away_provider_id,
      player_a_name: r.home_name,
      player_b_name: r.away_name,
      /* THE RESOLVED ids, which may be null. A side that did not resolve is
         named as unmapped rather than dropped: the board shows the fixture and
         says EdgeDesk cannot price it, which is the truth. */
      unmapped: [r.home_player_id ? null : 'player_a_id', r.away_player_id ? null : 'player_b_id'].filter(Boolean),
      raw_ref: { home_player_id: r.home_player_id, away_player_id: r.away_player_id }
    }));
  },

  /* Results for settlement. The live pipeline writes them; this reads them in
     the shape the public record needs. */
  async results(db, opts) {
    const o = opts || {};
    const since = o.since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    return db.rows(`
      select lm.match_id, lm.tour, lm.winner_player_id, lm.winner_side,
             lm.home_player_id, lm.away_player_id, lm.result_type, lm.completed_at,
             lm.sets_home, lm.sets_away
        from tennis.live_matches lm
       where lm.status = 'final' and lm.completed_at >= '${since}'::timestamptz
       order by lm.completed_at
       limit ${Math.max(1, Math.min(o.limit || 500, 2000))}`).map((r) => ({
      source_key: 'espn', match_ref: r.match_id, tour: M.normTour(r.tour),
      winner_player_id: r.winner_player_id ||
        (r.winner_side === 'home' ? r.home_player_id : r.winner_side === 'away' ? r.away_player_id : null),
      result_type: r.result_type, settled_at: r.completed_at,
      sets: [r.sets_home, r.sets_away],
      unmapped: r.winner_player_id ? [] : ['winner_player_id']
    }));
  },

  /* Rankings, from the provider directory the existing sync_players.js fills.
     It is the provider's ranking, not the tour's official table, and the row
     says so through its source_key. */
  async rankings(db, opts) {
    const o = opts || {};
    return db.rows(`
      select provider_athlete_id, tour, current_rank, rank_points, rank_as_of, full_name
        from tennis.player_directory
       where current_rank is not null ${o.tour ? `and tour = '${o.tour}'` : ''}
       order by tour, current_rank limit ${Math.max(1, Math.min(o.limit || 1000, 5000))}`).map((r) => ({
      source_key: 'espn', tour: M.normTour(r.tour), source_player_id: String(r.provider_athlete_id),
      rank: r.current_rank, points: r.rank_points, as_of: r.rank_as_of, player_name: r.full_name,
      unmapped: r.rank_as_of ? [] : ['as_of']
    }));
  },

  describe() {
    return { name: 'espn_scoreboard', coverage: 'ATP/WTA draws, live state and results',
             grain: 'one row per competition', licence: 'publisher terms; not a licensed statistical feed',
             not_carried: ['pre-match ratings', 'historical archive', 'market prices'],
             unavailable: espn().unavailable || null };
  }
});
