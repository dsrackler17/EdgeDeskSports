/* ===========================================================================
   WNBA 2026 — the postseason configuration the simulator runs under.

   The simulation starts from the playoffs as they stand: every completed
   playoff game is Observed (the schedule's finals), every series still
   being played is simulated game by game from the served model, at the
   hosts the schedule names. On 2026-10-23 one series is left: the Finals,
   Golden State Valkyries v Atlanta Dream, Atlanta leading 2-1.

   Facts about the 2026 postseason carry their source and a verification
   status, as for every sport (simulator/src/sports/registry.ts):
   - the series formats are MEASURED from the schedule itself: a series
     still being played lists every remaining game ("if necessary" ones
     included) with its host, so the number of wins needed and who hosts
     each game are read, not assumed; the run's gate refuses a schedule
     whose remaining games do not form one series of an odd length with
     consistent hosts (run.ts, schedule.series);
   - series already decided need no rule at all: their games are Observed.
   A series whose two clubs are not yet known (a round not yet paired) is
   not simulated this season: the gate refuses it rather than inventing the
   bracket (the 2027 season will need the bracket rule, stated in the
   activation path).
   =========================================================================== */
import type { SeasonFact } from '../nfl/config.ts';

export interface WnbaSeasonConfig {
  sport: 'wnba';
  competition: string;
  season: number;
  /** the published season key (sim_runs.season) */
  label: string;
  rules_version: string;
  /** the last date (UTC) the season is run nightly: the Finals' last scheduled game, plus a week */
  nightly_through: string;
  series_format: SeasonFact<string>;
  home_court: SeasonFact<string>;
  /** the served game model: what prices a game, and what the shared offset is carved out of */
  model: { source: string; uncertainty_study: string };
  /** not modelled: the served model has no player or availability input */
  availability: { mode: 'off'; fixed_assumption: string };
}

export const WNBA_2026: WnbaSeasonConfig = {
  sport: 'wnba',
  competition: 'WNBA Playoffs',
  season: 2026,
  label: '2026',
  rules_version: 'WNBA-PO-2026',
  /* Finals game 7 is scheduled for 2026-11-01 00:00 UTC (the schedule); a week's margin, then the WNBA leaves
     the nightly plan until a 2027 configuration exists */
  nightly_through: '2026-11-08',
  series_format: {
    value: 'a series still being played is first to ceil(n/2) wins over the n games the schedule lists for it (2026 Finals: seven games, first to four)',
    source: 'The 2026 schedule as published by ESPN through sportsdataverse wehoop-wnba-data (basketball/data/wnba/2026.csv, refreshed by basketball/ingest.js; the source file\'s sha256 is recorded in each snapshot): the Finals list games 1-7 between Golden State and Atlanta, games 5-7 as scheduled "if necessary" dates. Completed series are Observed from their finals (first round: the winner reached 2 wins; semifinals: 3)',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'compare the schedule with the WNBA\'s published 2026 playoff format (wnba.com, "WNBA Playoffs format")',
    affects_results: true, verified_by: null, verified_at: null, measured: true
  },
  home_court: {
    value: 'every remaining game is played at the host the schedule names (2026 Finals: Golden State hosts games 1, 2, 5 and 7; Atlanta games 3, 4 and 6, the 2-2-1-1-1 order)',
    source: 'The same schedule (basketball/data/wnba/2026.csv): the home_id of every Finals game, played and scheduled',
    retrieved: '2026-10-23',
    verification: 'UNVERIFIED',
    verify_by: 'compare with the WNBA\'s published 2026 Finals schedule',
    affects_results: true, verified_by: null, verified_at: null, measured: true
  },
  model: {
    source: 'basketball/walkforward.js (league wnba): points ratings with the served hyperparameters (docs/model-loop/wnba/versions.json) and the season calibration fitted on the three seasons before it; the price basketball/build_slate.js publishes (basketball/slate.json)',
    uncertainty_study: 'simulator/data/wnba_strength_uncertainty.json (simulator/src/research/wnba_strength_uncertainty.ts)'
  },
  availability: { mode: 'off', fixed_assumption: 'The served model has no player input: an injury or a return after the as-of time is not in any price; the ratings carry each club\'s season as played.' }
};
