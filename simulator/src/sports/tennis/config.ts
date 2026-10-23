/* ===========================================================================
   TENNIS 2026 — the configuration the draw simulator runs under.

   One simulation per ATP or WTA singles main draw in progress (or with its
   draw made), published as its own competition (<tour>-<ESPN tournament
   id>, e.g. atp-440-2026), and one for every scheduled singles match whose
   two players are known (competition "matches": main draws and qualifying,
   each match on its own).

   Nothing about a draw is a standing assumption. Per draw, and gated
   (run.ts):
   - the draw's order: Wikipedia's draw article (wiki_draw.ts), used only
     when its lines are ESPN's players and every decided match fits them;
     else, at the semifinals or later, the matches ESPN lists (the rest of
     the draw is then the semifinals and the final); else not simulated,
     with the reason;
   - best of five in a men's Grand Slam main draw, best of three otherwise
     (elo.ts bestOf);
   - every result: ESPN's (a retirement or a walkover is a result: the
     winner advanced).
   The ATP and WTA Finals (round robin, then semifinals) are not simulated
   until their group stage is over.
   =========================================================================== */

export interface TennisSeasonConfig {
  sport: 'tennis';
  season: number;
  label: string;
  rules_version: string;
  /** the last date (UTC) tennis is run nightly under this configuration */
  nightly_through: string;
  model: { source: string; study: string; backtest: string };
  /** a run's scoreboard must be at most this old to publish (the results.current gate) */
  max_feed_age_hours: number;
  /** a player with fewer matches than this in the history is flagged; more than a third of a draw so flagged blocks publication */
  min_matches: number;
  not_modelled: string[];
}

export const TENNIS_2026: TennisSeasonConfig = {
  sport: 'tennis',
  season: 2026,
  label: '2026',
  rules_version: 'TENNIS-2026-MEASURED',
  /* the tours' last 2026 events (the Davis Cup Finals, Nov. 24-29) plus a few days; a 2027 configuration replaces this */
  nightly_through: '2026-12-02',
  model: {
    source: 'simulator/src/sports/tennis/elo.ts (point-in-time Elo per tour on simulator/data/feeds/tennis_matches.json.gz)',
    study: 'simulator/data/tennis_elo_study.json (simulator/src/research/tennis_elo_study.ts)',
    backtest: 'simulator/data/tennis_backtest.json (simulator/src/research/tennis_tournament_backtest.ts)'
  },
  max_feed_age_hours: 6,
  min_matches: 10,
  not_modelled: ['the court surface (ESPN does not carry it)', 'injuries, fitness and withdrawals after the as-of time', 'a match in progress (priced from before its first ball, not its score)',
    'the score of a match (sets and games)', 'round-robin events (the ATP and WTA Finals group stage)']
};
