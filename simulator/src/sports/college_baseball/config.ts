/* ===========================================================================
   COLLEGE BASEBALL 2027 — the configuration the Road to Omaha runs under.

   One competition, "road-to-omaha": the 2027 season from where it stands
   (its preseason until its first game is in the warehouse; the served
   model's current ratings after that) to the 2027 champion (road.ts). The
   NCAA tournament's format is the one unchanged since 1999 (bracket.ts:
   64 teams, 16 four-team double-elimination regionals hosted by the top 16,
   8 best-of-three super regionals, two four-team double-elimination
   brackets in Omaha and a best-of-three final).

   The view stops on Selection Monday: from the field's announcement the
   committee proxy no longer applies, and the tournament itself (the
   bracket the committee names, played forward with sim.ts, as its backtest
   does) is a separate view this configuration does not run.
   =========================================================================== */

export interface CbaseSeasonConfig {
  sport: 'college_baseball';
  season: number;
  label: string;
  competition: string;
  rules_version: string;
  /** the first regional game: the Friday after Memorial Day (2021-2026 all held to it) */
  regionals_start: string;
  /** the last date (UTC) the Road to Omaha is run nightly: the day before Selection Monday */
  nightly_through: string;
  /** in season (from this date to the regionals), the warehouse's last game must be at most this many days old to publish */
  in_season_from: string;
  max_results_age_days: number;
  model: { source: string; tournament_backtest: string; road_backtest: string };
  not_modelled: string[];
}

export const CBASE_2027: CbaseSeasonConfig = {
  sport: 'college_baseball',
  season: 2027,
  label: '2027',
  competition: 'road-to-omaha',
  rules_version: 'CBASE-2027-NCAA64',
  /* Memorial Day 2027 is Monday, May 31 */
  regionals_start: '2027-06-04',
  /* Selection Monday is May 31; the run of the night before it is the last */
  nightly_through: '2027-05-30',
  in_season_from: '2027-02-19',
  max_results_age_days: 4,
  model: {
    source: 'college_baseball/lib/team_quality.js (the served "hier" run model, docs/model-loop/college_baseball/versions.json), replayed by simulator/src/sports/college_baseball/model.ts',
    tournament_backtest: 'simulator/data/college_baseball_backtest.json (simulator/src/research/college_baseball_tournament_backtest.ts)',
    road_backtest: 'simulator/data/college_baseball_road.json (simulator/src/research/college_baseball_road_backtest.ts)'
  },
  not_modelled: [
    'the 2027 schedule (it does not exist yet): the season is simulated as the measured move of each rating to Selection Monday, not game by game',
    'the selection committee itself: a proxy fitted on past fields (its metrics, records and judgment differ from the ratings)',
    'geography, which moves real 2, 3 and 4 seeds between regionals; the regionals here follow the S-curve',
    'roster changes, the transfer portal and the draft since 2026 (the preseason carries last season\'s strength, regressed toward the conference)',
    'conference moves announced for 2027: 2026 memberships are used until the 2027 season is in the warehouse',
    'starting pitchers and the tournament\'s rotation (the board\'s pitcher layer is not part of the served team model)'
  ]
};
