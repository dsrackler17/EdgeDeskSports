/* ===========================================================================
   GOLF 2026 — the configuration the tournament simulator runs under.

   One simulation per tour event in progress (or about to start with its
   field listed): the PGA Tour, the LPGA Tour and the DP World Tour, each
   published as its own competition (<tour>-<ESPN event id>, season 2026:
   the calendar year of the event's start). On 2026-10-23: the Butterfield
   Bermuda Championship (PGA Tour, round 2 in progress), the BMW Ladies
   Championship (LPGA, after round 2) and the Genesis Championship (DP World
   Tour, after round 2, the cut made).

   No format fact is a standing assumption. Everything a run depends on is
   MEASURED per event and gated (run.ts):
   - the cut (rules.ts eventRule): Observed once made; otherwise read from
     the event's previous editions and the tour's history (the PGA Tour's,
     LPGA's and DP World Tour's top 65 and ties are pinned by their 2023-2026
     cuts, not taken from a rulebook); an event whose rule cannot be
     determined is not simulated;
   - the number of rounds (rules.ts scheduledRounds): the editions, or
     ESPN's tournament field when the feed carries it;
   - the playoff for a tie at the top: sudden death, hole by hole (an
     Estimated approximation: the feed holds no hole-by-hole history; some
     events use an aggregate playoff, which this does not model).
   =========================================================================== */
import type { Tour } from './model.ts';

export interface GolfSeasonConfig {
  sport: 'golf';
  season: number;
  /** the published season key (sim_runs.season) */
  label: string;
  rules_version: string;
  tours: Tour[];
  /** the last date (UTC) golf is run nightly under this configuration */
  nightly_through: string;
  /** the model and its evidence */
  model: { source: string; study: string; backtest: string };
  /** a run's leaderboard must be at most this old to publish (the results.current gate) */
  max_feed_age_hours: number;
  /** not modelled: stated in the registry's limitations */
  not_modelled: string[];
}

export const GOLF_2026: GolfSeasonConfig = {
  sport: 'golf',
  season: 2026,
  label: '2026',
  rules_version: 'GOLF-2026-MEASURED',
  tours: ['pga', 'lpga', 'eur'],
  /* the PGA Tour's last 2026 event (Q-School, Dec. 10-13) plus a week; a 2027 configuration replaces this */
  nightly_through: '2026-12-20',
  model: {
    source: 'simulator/src/sports/golf/model.ts (point-in-time skill fit on simulator/data/feeds/golf_events.json.gz)',
    study: 'simulator/data/golf_skill_study.json (simulator/src/research/golf_skill_study.ts)',
    backtest: 'simulator/data/golf_backtest.json (simulator/src/research/golf_backtest.ts)'
  },
  max_feed_age_hours: 6,
  not_modelled: ['course fit and course history', 'weather and the tee-time wave', 'injuries and form news', 'withdrawals after the as-of time', 'aggregate-format playoffs']
};
