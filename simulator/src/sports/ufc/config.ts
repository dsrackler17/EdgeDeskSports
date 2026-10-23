/* ===========================================================================
   UFC 2026 — what the fights and title-path simulation runs under.

   Two products in one run (one published competition):
     FIGHTS      every bout the schedule lists from the as-of time through
                 the horizon, 100,000 times: who wins (the served Elo's
                 probability, exactly), finish or decision, and the round of
                 a finish (simulator/src/sports/ufc/finish.ts)
     TITLE PATH  each division over the horizon: the booked bouts first,
                 then undisputed title fights at the division's MEASURED
                 rate, the champion against the challenger the ESTIMATED
                 matchmaking rule names, each from the served Elo

   Facts a result depends on carry their source and status, as for every
   sport (simulator/src/sports/registry.ts). None is a standing rules fact a
   person must verify: every one is either read from a source in every run
   and gated (champions and rankings: ufc.com; the schedule: ESPN; title
   history: Wikipedia), or an Estimated rule labelled as such wherever its
   numbers appear (the matchmaking rule).
   =========================================================================== */
import type { SeasonFact } from '../nfl/config.ts';

export interface UfcAlias { ufc_name: string; espn_id: string; espn_name: string; reason: string }
export interface UfcConfig {
  sport: 'ufc';
  competition: string;
  season: number;
  /** the published season key (sim_runs.season) */
  label: string;
  rules_version: string;
  /** the title path's horizon, in days from the as-of time */
  horizon_days: number;
  /** the title-fight rate is measured over this many years before the as-of date */
  rate_window_years: number;
  /** the gap shape (gamma) is fitted to every division's gaps between undisputed title fights from this date */
  gap_shape_from: string;
  /** the rankings page must have been read within this many days of the run (ufc.com updates weekly) */
  rankings_max_age_days: number;
  feeds: { bouts: string; rankings: string; rankings_html: string; title_history: string; espn_samples: string };
  champions: SeasonFact<string>;
  title_rate: SeasonFact<string>;
  matchmaking: SeasonFact<string> & { estimated: true };
  /** ufc.com names ESPN spells differently (matched by hand, the evidence stated) */
  aliases: UfcAlias[];
  /** not modelled; stated in the limitations and the reader */
  not_modelled: string[];
}

export const UFC_2026: UfcConfig = {
  sport: 'ufc',
  competition: 'UFC Fights and Title Path',
  season: 2026,
  label: '2026',
  rules_version: 'UFC-TP-2026.1',
  horizon_days: 365,
  rate_window_years: 5,
  gap_shape_from: '2014-01-01',
  rankings_max_age_days: 8,
  feeds: {
    bouts: 'simulator/data/feeds/ufc_bouts.json.gz',
    rankings: 'simulator/data/feeds/ufc_rankings.json',
    rankings_html: 'simulator/data/feeds/ufc_rankings.html.gz',
    title_history: 'simulator/data/feeds/ufc_champions_wikipedia.html.gz',
    espn_samples: 'simulator/data/feeds/ufc_espn_samples.json.gz'
  },
  champions: {
    value: 'each division\'s champion and ranked contenders 1-15 are read from ufc.com/rankings in every run (the page\'s sha256 is recorded); a champion is never inferred from results',
    source: 'https://www.ufc.com/rankings, read on a GitHub runner by simulator/src/cli/fetch_sports_data.ts (simulator/data/feeds/ufc_rankings.json, the page itself in ufc_rankings.html.gz); cross-checked against Wikipedia\'s incumbents and ESPN\'s title accolades for the booked title fights',
    retrieved: '2026-10-23', verification: 'UNVERIFIED', verify_by: 'none needed: read from the UFC\'s own page in every run; the run gate rankings.fresh refuses a page older than 8 days',
    affects_results: true, verified_by: null, verified_at: null, measured: true
  },
  title_rate: {
    value: 'undisputed title fights per division per year, counted over the 5 years before the as-of date; the gaps between them follow a gamma distribution with each division\'s mean gap and one shape fitted to every division\'s gaps since 2014',
    source: 'Wikipedia, List of UFC champions (simulator/data/feeds/ufc_champions_wikipedia.html.gz, parsed by simulator/src/sports/ufc/title_history.ts)',
    retrieved: '2026-10-23', verification: 'UNVERIFIED', verify_by: 'none needed: measured from the saved page in every run',
    affects_results: true, verified_by: null, verified_at: null, measured: true
  },
  matchmaking: {
    value: 'ESTIMATED. At each title fight not yet booked, the champion meets the highest-ranked contender who is coming off a win and has rested at least the measured minimum since their last fight. The order starts from ufc.com\'s ranks; a booked bout moves its winner to the loser\'s place when the loser was ranked higher; a fighter booked in another division leaves their ranked division (the schedule shows the move); a champion who loses is no longer champion and, coming off a loss, waits',
    source: 'EdgeDesk\'s rule, stated; the share of challengers coming off a win and their rest are measured from every title fight since 2014 (title history matched to the bouts)',
    retrieved: '2026-10-23', verification: 'NOT_APPLICABLE', verify_by: 'not verifiable: the UFC books title fights at its discretion; every number it moves is labelled Estimated',
    affects_results: true, verified_by: null, verified_at: null, measured: true, estimated: true
  },
  aliases: [
    { ufc_name: 'Muhammad Saidov', espn_id: '5369438', espn_name: 'Muhammad Said', reason: 'the only light heavyweight in ESPN\'s data with that given name and surname stem; ufc.com ranks Saidov at light heavyweight' }
  ],
  not_modelled: [
    'interim titles (an interim champion, and a promotion to undisputed champion without a fight)',
    'a champion vacating, being stripped or retiring, and a title moving between divisions',
    'bouts not yet on the schedule other than title fights (a contender\'s ranking moves only through booked bouts)',
    'draws and no contests (about 1.8% of UFC bouts since 2014): every simulated fight has a winner',
    'injuries and withdrawals: every booked bout takes place as scheduled'
  ]
};
