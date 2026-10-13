/* ===========================================================================
   EdgeDesk SPORT BRAINS — one registry for every sport the engine prices,
   with an honest readiness state for each, computed from evidence files.

   Browser + Node (UMD: window.EDBRAINS). The static part (methods, data,
   blockers) lives here; engine/build_registry.js reads the validation files
   named in `evidence`, calls computeReadiness(), and writes
   engine/registry.json, which the Engine panel and the cross-sport board read.

   READINESS (per market, then the sport takes its best market):
     MARKET_VALIDATED   the model beat the no-vig CLOSE out of sample (an
                        interval wholly in its favour, n ≥ 500). The only state
                        that may claim betting value.
     OUTCOME_VALIDATED  out-of-sample calibration against outcomes passed its
                        pre-registered rules and it beats simple baselines; it
                        has not beaten the market (untested, or tested and not
                        ahead). Fair lines are publishable; value is not.
     EXPERIMENTAL       a model exists but its validation is partial or failed
                        a rule (PROVISIONAL). Research only.
     RESEARCH_ONLY      data and research tools, no independent pricing model.
     UNAVAILABLE        no data or model is wired.
     RETIRED            the product was retired; history is archived.
   A generic model is never registered as a sport integration: a sport with no
   sport-specific brain is UNAVAILABLE, whatever another sport's model could do.

   Sources are cited by id (SOURCES below) — published, primary or official
   material only. No proprietary bookmaker or bettor model is claimed.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDBRAINS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_sport_brains_v1';
  var STATES = ['MARKET_VALIDATED', 'OUTCOME_VALIDATED', 'EXPERIMENTAL', 'RESEARCH_ONLY', 'UNAVAILABLE', 'RETIRED'];
  var STATE_LABEL = {
    MARKET_VALIDATED: 'Validated vs market', OUTCOME_VALIDATED: 'Validated vs outcomes', EXPERIMENTAL: 'Experimental',
    RESEARCH_ONLY: 'Research only', UNAVAILABLE: 'Unavailable', RETIRED: 'Retired'
  };

  var SOURCES = {
    macdonald2012: 'Macdonald, Lennon & Sturdivant (2012), "Evaluating NHL goalies, skaters, and teams using weighted shots", arXiv:1205.1746 — https://arxiv.org/abs/1205.1746',
    tulsky2012: 'Tulsky (2012), score-adjusted possession (Broad Street Hockey); McCurdy (2014), "Adjusted possession measures", Hockey-Graphs — https://hockey-graphs.com/2014/11/13/adjusted-possession-measures/',
    beaudoin2010: 'Beaudoin & Swartz (2010), "Strategies for pulling the goalie in hockey", The American Statistician 64(3):197-204 — https://www.sfu.ca/~tswartz/papers/goalie.pdf',
    karlis2003: 'Karlis & Ntzoufras (2003), "Analysis of sports data by using bivariate Poisson models", The Statistician 52(3):381-393, doi:10.2307/4128211',
    maher1982: 'Maher (1982), "Modelling association football scores", Statistica Neerlandica 36(3):109-118',
    dixoncoles1997: 'Dixon & Coles (1997), "Modelling association football scores and inefficiencies in the football betting market", JRSS C 46(2):265-280',
    fte_nhl: 'FiveThirtyEight, "How Our NHL Predictions Work" (Elo with a margin-of-victory multiplier, 50-point home ice) — https://fivethirtyeight.com/methodology/how-our-nhl-predictions-work/',
    evolving_xg: 'Evolving-Hockey xG write-up (Younggren & Younggren, 2018) — https://evolving-hockey.com/?p=394',
    stern1994: 'Stern (1994), "A Brownian motion model for the progress of sports scores", JASA 89(427):1128-1134',
    kubatko2007: 'Kubatko, Oliver, Pelton & Rosenbaum (2007), "A starting point for analyzing basketball statistics", JQAS 3(3)',
    sill2010: 'Sill (2010), "Improved NBA adjusted +/- using regularization and out-of-sample testing", MIT Sloan Sports Analytics Conference',
    yurko2019: 'Yurko, Ventura & Horowitz (2019), "nflWAR: a reproducible method for offensive player evaluation in football", JQAS — expected points by multinomial logistic regression (nflscrapR / nflfastR)',
    glickman1998: 'Glickman & Stern (1998), "A state-space model for National Football League scores", JASA 93(441):25-35',
    tango2007: 'Tango, Lichtman & Dolphin (2007), "The Book: Playing the Percentages in Baseball" (wOBA, run values, platoon splits, regression to the mean)',
    hvattum2010: 'Hvattum & Arntzen (2010), "Using ELO ratings for match result prediction in association football", IJF 26(3):460-470',
    klaassen2003: 'Klaassen & Magnus (2003), "Forecasting the winner of a tennis match", EJOR 148(2):257-267, doi:10.1016/S0377-2217(02)00682-3',
    barnett2005: 'Barnett & Clarke (2005), "Combining player statistics to predict outcomes of tennis matches", IMA J. Management Mathematics 16(2):113-120',
    kovalchik2016: 'Kovalchik (2016), "Searching for the GOAT of tennis win prediction", JQAS 12(3):127-138, doi:10.1515/jqas-2015-0059',
    massey1997: 'Massey (1997), "Statistical models applied to the rating of sports teams", honours thesis, Bluefield College — least-squares ratings with offence/defence components',
    fte_nba: 'FiveThirtyEight, "How Our NBA Predictions Work" (Elo with a margin-of-victory multiplier and home court) — https://fivethirtyeight.com/methodology/how-our-nba-predictions-work/',
    fte_mlb: 'FiveThirtyEight, "How Our MLB Predictions Work" (Elo with starting-pitcher and park adjustments) — https://fivethirtyeight.com/methodology/how-our-mlb-predictions-work/',
    constantinou2012: 'Constantinou & Fenton (2012), "Solving the problem of inadequate scoring rules for assessing probabilistic football forecast models", JQAS 8(1), doi:10.1515/1559-0410.1418',
    holmes2023: 'Holmes, McHale & Zychaluk (2023), "A Markov chain model for forecasting results of mixed martial arts contests", IJF 39(2):623-640, doi:10.1016/j.ijforecast.2022.01.007',
    glickman1999: 'Glickman (1999), "Parameter estimation in large dynamic paired comparison experiments" (Glicko), Applied Statistics 48(3):377-394',
    strumbelj2014: 'Štrumbelj (2014), "On determining probability forecasts from betting odds", IJF 30(4):934-943 (Shin vs basic normalisation)',
    shin1993: 'Shin (1993), "Measuring the incidence of insider trading in a market for state-contingent claims", Economic Journal 103(420):1141-1153',
    smithwinkler2006: 'Smith & Winkler (2006), "The optimizer\'s curse: skepticism and postdecision surprise in decision analysis", Management Science 52(3):311-322',
    walsh2024: 'Walsh & Joshi (2024), "Machine learning for sports betting: should model selection be based on accuracy or calibration?", Machine Learning with Applications 16:100539',
    gneiting2007: 'Gneiting & Raftery (2007), "Strictly proper scoring rules, prediction, and estimation", JASA 102(477):359-378'
  };

  /* -------------------------------------------------------------------------
     THE SPORTS. `brain.status`: BUILT (a sport-specific model runs and is
     validated here), PARTIAL (a model exists, validation incomplete),
     NOT_BUILT (designed and documented, not implemented). `evidence` names
     the reader engine/build_registry.js uses. Facts about existing data and
     models were read from this repository on 2026-10-13 (docs/engine/README.md).
     ------------------------------------------------------------------------- */
  var SPORTS = [
    {
      id: 'nhl', label: 'NHL', odds_keys: ['icehockey_nhl'], family: 'hockey', season: [10, 6], product: 'ACTIVE', primary: 'moneyline',
      brain: {
        status: 'BUILT', id: 'edgedesk_nhl_v1',
        approach: 'Score- and opponent-adjusted 5v5 expected-goals ratings, special-teams xG and penalty rates, goalie goals-saved-above-expected, rest and back-to-backs → a Poisson regression for each team\'s regulation goals → an exact score distribution with empirical score effects and goalie-pull dynamics, 3-on-3 overtime and the shootout → every market\'s fair price.',
        why: 'Hockey is low-scoring and noisy: goals are a weak signal, shot quality (xG) is a stronger and more stable one (macdonald2012). Leaders sit back and trailing teams pull the goalie, so margins and totals are not plain Poisson (tulsky2012, beaudoin2010). A full distribution, not a single number, is what the moneyline, the puck line and the total all need.',
        candidates: [
          { name: 'Elo with margin of victory', role: 'baseline', sources: ['fte_nhl'] },
          { name: 'Goals-based attack/defence Poisson', role: 'baseline', sources: ['maher1982', 'dixoncoles1997'] },
          { name: 'xG ratings + Poisson GLM + score-effect simulation', role: 'chosen', sources: ['macdonald2012', 'evolving_xg', 'tulsky2012', 'beaudoin2010'] },
          { name: 'Bivariate Poisson common shock', role: 'tested, rejected (maximum likelihood share 0 in every season)', sources: ['karlis2003'] }
        ],
        inputs: ['5v5 xG for/against (score-adjusted, opponent-adjusted)', 'goals for/against', 'power-play xG, penalty-kill xG against, penalty minutes drawn/taken', 'goalie GSAx (projected starter; confirmed when recorded)', 'rest days, back-to-backs', 'league scoring level'],
        not_modelled: ['skater injuries and late scratches', 'travel distance and time zones (not tested yet)', 'line combinations', 'referees (screened on 2024-25: no repeatable effect on penalties, power-play time or goals; no assignment timestamps)', 'neutral-site games (priced with home ice: my feed has no neutral flag; 4 such games in 2024-25)']
      },
      data: [
        { source: 'sportsdataverse fastRhockey-nhl-data (play-by-play, goalie box, game info)', what: 'every event since 2010-11 with coordinates and strength', cadence: 'daily in season', license: 'MIT repository; underlying data from the NHL public feeds (NHL terms restrict commercial use — owner review needed)', cost: 'free, keyless' },
        { source: 'EdgeDesk NHL Data Pack (datapack/nhl_v1): ESPN public responses, 2024-25', what: 'second source for one full season — 1,398 games, 448k events, 167k shot attempts, every player and goalie box, officials; reconciled event by event against my feed (it exposed and confirmed the blocked-shot attribution fix)', cadence: 'one-off import, fixed scope', license: 'ESPN public responses; redistribution rights not certified — research copy, never resold', cost: 'free (delivered)' },
        { source: 'sportsdataverse fastRhockey-nhl-raw (season schedule)', what: 'schedule, start times, states incl. future games', cadence: 'daily', license: 'as above', cost: 'free' },
        { source: 'NHL public web API api-web.nhle.com', what: 'today\'s schedule and game states', cadence: 'on each build (cached 10 min)', license: 'undocumented public endpoint; polite rate', cost: 'free' },
        { source: 'The Odds API via supabase/functions/odds_gateway', what: 'NHL book prices (featured: h2h, spreads, totals)', cadence: 'only when authorised', license: 'commercial API', cost: '≈3 credits per call; DISABLED by default' }
      ],
      evidence: 'nhl',
      blockers: ['No licensed archive of timestamped NHL closing prices: the model cannot be tested against the market, so no NHL price may be called an edge.', 'NHL prices are not captured (odds gateway sport row disabled; NHL_PRICES unset).', 'No confirmed-starter feed: goalies are projected unless recorded by hand with a source.'],
      enable: ['Authorise NHL price capture: `select public.odds_api_set_sport(\'icehockey_nhl\', true);` and set the repository variable NHL_PRICES=on (≈3 credits per gateway call; the gateway cadence caps frequency).', 'Load a licensed closing-price archive into hockey/market/closing/<season>.csv (schema in docs/engine/DATA.md) and rerun `npm run nhl:validate` to test against the close.']
    },
    {
      id: 'nfl', label: 'NFL', odds_keys: ['americanfootball_nfl'], family: 'football', season: [8, 2], product: 'ACTIVE', primary: 'spread',
      brain: {
        status: 'BUILT', id: 'edgedesk_football NFL engine (football/engine.js)',
        approach: 'Opponent-adjusted EPA per play and success rate, a quarterback layer, rest/roof/surface/weather context → projected margin and total → linemaker distributions (football/linemaker) and the validated market blend (football/validation/pricing_nfl.json).',
        why: 'EPA (yurko2019) measures play value against down, distance and field position; scores are near-normal around the projection with key-number structure (glickman1998).',
        candidates: [{ name: 'existing EdgeDesk football engine', role: 'chosen (existing)', sources: ['yurko2019', 'glickman1998'] }],
        inputs: ['nflverse team-week EPA per play, pass and rush (aggregated from play-by-play)', 'a QB passing-EPA layer (the scored replays pass no QB starts, so the layer is not yet tested; football/validation/nfl_pack_research.json measures a starting-QB change at about −3 points)', 'official injury report (a ruled-out starting QB swaps to the next starter)', 'roof, temperature and wind (context model)'],
        not_modelled: ['offensive line continuity as a priced input (researched, rejected by the feature intake)', 'CPOE, snap counts, PFR pressure and NGS measures (in the NFL data pack, not in the game model)', 'depth charts and injury reports with publication times (the pack has neither timestamp)']
      },
      data: [{ source: 'nflverse (GitHub)', what: 'schedule, consensus close, team-week stats, injuries', cadence: 'weekly / 6-hourly', license: 'CC-BY-4.0 (upstream terms vary)', cost: 'free' },
        { source: 'EdgeDesk NFL Data Pack (datapack/nfl_v1): nflverse 2025-2026 play-by-play and supplements', what: '62,613 plays (2026 PARTIAL, through week 5), snaps, rosters, depth charts, injuries, PFR advanced, NGS; every derived table recomputed; reconciled with games.csv and my live team-week table', cadence: 'one-off import', license: 'nflverse CC-BY-4.0; NGS/PFR/ESPN upstream terms not certified', cost: 'free (delivered)' },
        { source: 'The Odds API via odds_gateway', what: 'book prices', cadence: 'gateway cadence', license: 'commercial', cost: 'within the existing monthly budget' }],
      evidence: 'nfl',
      blockers: ['Against the close the spread is LEAN (break-even history at 1.5+ points of disagreement), the total and moneyline RESEARCH: no market beats the close.'],
      enable: ['No integration step is missing; value claims need a market test the model passes (football/validation/pricing_nfl.json).']
    },
    {
      id: 'cfb', label: 'College football', odds_keys: ['americanfootball_ncaaf'], family: 'football', season: [8, 1], product: 'ACTIVE', primary: 'spread',
      brain: {
        status: 'BUILT', id: 'edgedesk_cfb_p4 / FBS board engine',
        approach: 'Opponent-adjusted EPA (football/fbs_epa), the EdgeDesk ETSR rating, talent, returning production and coaching continuity → margin and total → linemaker distributions.',
        why: 'Huge talent gaps and thin schedules make opponent adjustment the core problem; EPA again measures play value (yurko2019).',
        candidates: [{ name: 'existing EdgeDesk CFB engine', role: 'chosen (existing)', sources: ['yurko2019'] }],
        inputs: ['cfbfastR play-by-play', 'talent and returning production', 'operator-entered availability'], not_modelled: ['an official availability feed (none exists)']
      },
      data: [{ source: 'cfbfastR-data / sportsdataverse', what: 'schedules, plays, line archive', cadence: 'weekly / nightly', license: 'public', cost: 'free' }, { source: 'CollegeFootballData', what: 'advanced stats', cadence: 'deployed ingest', license: 'API key', cost: 'free tier' }],
      evidence: 'cfb',
      blockers: ['Every market is RESEARCH against the close (football/validation/pricing_cfb.json).'],
      enable: ['No integration step is missing; value needs a passed market test.']
    },
    {
      id: 'mlb', label: 'MLB', odds_keys: ['baseball_mlb'], family: 'baseball', season: [3, 11], product: 'ACTIVE', primary: 'moneyline',
      brain: {
        status: 'BUILT', id: 'edgedesk_mlb_history_v1 (mlb/history) + the browser run model (mlb/engine.js)',
        approach: 'A point-in-time run model: team offence and run prevention, a decayed park factor and a shrunk starting-pitcher effect in a log-linear Poisson fit refreshed every game date, with negative-binomial overdispersion and an extra-inning home rate fitted on earlier seasons; candidates added in order (team, + park, + starter) by the selection rule.',
        why: 'The starter is the largest single pre-game input but is noisy over a few starts, so it is heavily shrunk (tango2007); runs are overdispersed, so a negative binomial beats Poisson; park run environments differ by more than home advantage.',
        candidates: [{ name: 'team / + park / + starting pitcher run model', role: 'built, walk-forward', sources: ['tango2007', 'maher1982'] }, { name: 'Elo with a margin multiplier', role: 'baseline', sources: ['fte_mlb'] }, { name: 'bullpen, lineup and platoon model', role: 'designed, not built', sources: ['tango2007'] }],
        inputs: ['Retrosheet game logs 2010-2023 and 2025 (starters, parks)', '2024 from the data pack (no starters)'], not_modelled: ['bullpen fatigue', 'lineups and platoons', 'weather', 'late starter changes']
      },
      data: [{ source: 'Retrosheet game logs (chadwickbureau/retrosheet)', what: 'every regular-season game with starters and park, 2010-2023, 2025', cadence: 'yearly', license: 'free with the Retrosheet notice', cost: 'free' }, { source: 'Data pack MLB StatsAPI 2024', what: '2024 results (no starters)', cadence: 'one-off', license: 'MLB terms', cost: 'free' }, { source: 'The Odds API via odds_gateway', what: 'book prices', cadence: 'gateway cadence', license: 'commercial', cost: 'in budget' }],
      evidence: 'mlb',
      blockers: ['No licensed closing-price archive: the market is NOT_TESTED.', 'Retrosheet has not published 2026; 2024 starters are missing.', 'No starter-scratch or confirmed-lineup feed.'],
      enable: ['Add a licensed MLB closing archive and run the market test; add 2024 and 2026 game logs when Retrosheet publishes them (node mlb/history/ingest.js && node mlb/history/walkforward.js).']
    },
    {
      id: 'college_baseball', label: 'College baseball', odds_keys: ['baseball_ncaa'], family: 'baseball', season: [2, 6], product: 'ACTIVE', primary: 'moneyline',
      brain: { status: 'NOT_BUILT', id: null, approach: 'Designed: opponent-adjusted run ratings (a ridge-regularised attack/defence run model, as for soccer goals) with weekend-rotation starters and park effects.', why: 'Hundreds of teams with few common opponents: shrinkage and opponent adjustment matter more than pitch-level detail, which is not available.', candidates: [{ name: 'attack/defence run ratings', role: 'designed', sources: ['maher1982'] }], inputs: ['ESPN results union (tools/cbb)', 'data pack: 313-game explicit-date sample'], not_modelled: ['starters', 'weather'] },
      data: [{ source: 'ESPN public endpoints (tools/cbb, college-baseball.yml)', what: 'schedules and results', cadence: 'daily', license: 'public endpoints', cost: 'free' }, { source: 'Data pack', what: '313 games sampled on explicit dates (monthly queries returned nothing)', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'none_research',
      blockers: ['No multi-season results archive: the pack sample (313 games) cannot validate a model.', 'No captured prices.'],
      enable: ['Wire a complete multi-season college results archive, then build and validate the run-ratings brain.']
    },
    {
      id: 'nba', label: 'NBA', odds_keys: ['basketball_nba'], family: 'basketball', season: [10, 6], product: 'ENGINE', primary: 'moneyline',
      brain: { status: 'BUILT', id: 'edgedesk_bb_points_v1 (basketball/, league nba)', approach: 'Opponent-adjusted offence and defence points ratings (decayed least squares, a ridge pull toward last season carried at a tuned rate) → margin and total; the win curve, margin and total recalibration, their spreads and a back-to-back effect are fitted on earlier seasons\' out-of-sample predictions.', why: 'Points-based ratings are the Massey / adjusted-efficiency family (massey1997, kubatko2007); margins are close to normal (stern1994), so cover and total probabilities follow from the projected mean and an out-of-sample spread.', candidates: [{ name: 'points ratings', role: 'built, walk-forward', sources: ['massey1997', 'kubatko2007', 'stern1994'] }, { name: 'points ratings + back-to-back', role: 'built, walk-forward', sources: ['stern1994'] }, { name: 'Elo', role: 'baseline', sources: ['fte_nba'] }, { name: 'RAPM availability', role: 'designed, not built', sources: ['sill2010'] }], inputs: ['ESPN results 2008-2026 (sportsdataverse hoopR)'], not_modelled: ['player availability and injuries', 'travel', 'pace (totals come from points ratings, not possessions)'] },
      data: [{ source: 'sportsdataverse hoopR-nba-data (ESPN)', what: 'schedules and results 2008-', cadence: 'daily in season', license: 'MIT repo; ESPN data terms', cost: 'free' }, { source: 'Data pack', what: '2024-25 ESPN games (reconciled; 3 added)', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'nba',
      blockers: ['No licensed closing archive: market NOT_TESTED.', 'No injury/availability feed.', 'Prices are not captured for basketball (the gateway allowlist does not include it).'],
      enable: ['Add a licensed closing archive and run the market test; authorise basketball price capture in odds_api_sports if wanted.']
    },
    {
      id: 'wnba', label: 'WNBA', odds_keys: ['basketball_wnba'], family: 'basketball', season: [5, 10], product: 'ENGINE', primary: 'moneyline',
      brain: { status: 'BUILT', id: 'edgedesk_bb_points_v1 (basketball/, league wnba)', approach: 'The points-ratings method fitted on WNBA history alone, with its own hyperparameters (longer memory) and calibration.', why: 'Same game structure, smaller samples: the selection window chose a one-year half-life.', candidates: [{ name: 'points ratings', role: 'built, walk-forward', sources: ['massey1997', 'stern1994'] }, { name: 'Elo', role: 'baseline', sources: ['fte_nba'] }], inputs: ['ESPN results 2008-2026 (sportsdataverse wehoop)'], not_modelled: ['availability', 'travel'] },
      data: [{ source: 'sportsdataverse wehoop-wnba-data (ESPN)', what: 'schedules and results 2008-', cadence: 'daily in season', license: 'MIT repo; ESPN data terms', cost: 'free' }, { source: 'Data pack', what: '2024 ESPN games (reconciled; 1 added)', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'wnba', blockers: ['Moneyline does not beat Elo with a 95% interval (PROVISIONAL).', 'No closing archive; prices not captured.'], enable: ['More seasons or an availability input; a licensed closing archive for the market test.']
    },
    {
      id: 'ncaab_m', label: 'Men\'s college basketball', odds_keys: ['basketball_ncaab'], family: 'basketball', season: [11, 4], product: 'ENGINE', primary: 'moneyline',
      brain: { status: 'BUILT', id: 'edgedesk_bb_points_v1 (basketball/, league ncaam)', approach: 'Points ratings over every Division I game (and its non-D-I opponents), neutral sites honoured, fitted on men\'s history alone.', why: '360+ teams with sparse common opponents: opponent adjustment by regularised least squares is the published standard (kubatko2007, massey1997).', candidates: [{ name: 'points ratings', role: 'built, walk-forward', sources: ['massey1997', 'kubatko2007'] }, { name: 'Elo', role: 'baseline', sources: ['fte_nba'] }], inputs: ['ESPN results 2010-2026 (sportsdataverse hoopR)'], not_modelled: ['availability', 'travel', 'tempo'] },
      data: [{ source: 'sportsdataverse hoopR-mbb-data (ESPN)', what: 'schedules and results 2010-', cadence: 'daily in season', license: 'MIT repo; ESPN data terms', cost: 'free' }, { source: 'Data pack', what: '2024-25 ESPN games (all reconciled)', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'ncaab_m', blockers: ['No closing archive: market NOT_TESTED.', 'No availability feed; prices not captured.'], enable: ['A licensed closing archive for the market test; authorise capture if wanted.']
    },
    {
      id: 'ncaab_w', label: 'Women\'s college basketball', odds_keys: ['basketball_wncaab'], family: 'basketball', season: [11, 4], product: 'ENGINE', primary: 'moneyline',
      brain: { status: 'BUILT', id: 'edgedesk_bb_points_v1 (basketball/, league ncaaw)', approach: 'Points ratings fitted on women\'s history alone, with its own hyperparameters and calibration.', why: 'Same structure as the men\'s game; larger talent gaps make the margin model especially informative.', candidates: [{ name: 'points ratings', role: 'built, walk-forward', sources: ['massey1997', 'kubatko2007'] }, { name: 'Elo', role: 'baseline', sources: ['fte_nba'] }], inputs: ['ESPN results 2010-2026 (sportsdataverse wehoop) + 209 data-pack games the source lacked (2024-25)'], not_modelled: ['availability', 'travel'] },
      data: [{ source: 'sportsdataverse wehoop-wbb-data (ESPN)', what: 'schedules and results 2010-', cadence: 'daily in season', license: 'MIT repo; ESPN data terms', cost: 'free' }, { source: 'Data pack', what: '2024-25 ESPN games: 209 missing from the source added', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'ncaab_w', blockers: ['No closing archive: market NOT_TESTED.', 'No availability feed; no price source.'], enable: ['A licensed closing archive for the market test.']
    },
    {
      id: 'soccer', label: 'Soccer', odds_keys: ['soccer_'], family: 'soccer', season: [1, 12], product: 'ENGINE', primary: '*.moneyline',
      brain: { status: 'BUILT', id: 'edgedesk_soccer_dc_v1 (soccer/: Premier League, Bundesliga, La Liga, Serie A, Ligue 1, each fitted alone)', approach: 'Time-decayed Poisson attack/defence ratings per league with the Dixon-Coles low-score correction and an optional pair recalibration, chosen per league by the selection rule; promoted clubs start at the mean of the clubs they replaced; 1X2, totals, both-to-score and Asian handicaps (quarter lines as two half stakes) from the score matrix.', why: 'The Dixon-Coles model is the published standard for football scores (dixoncoles1997, maher1982); a goal-difference Elo is a strong simple baseline (hvattum2010), and the 1X2 is scored by the ranked probability score (constantinou2012).', candidates: [{ name: 'Poisson / Dixon-Coles, with or without recalibration', role: 'built, walk-forward', sources: ['dixoncoles1997', 'maher1982'] }, { name: 'Elo (draw curve fitted)', role: 'baseline', sources: ['hvattum2010'] }, { name: 'xG and lineup inputs', role: 'designed, not built', sources: ['dixoncoles1997'] }], inputs: ['openfootball results 2010-11 (La Liga 2012-13, Serie A 2013-14, Ligue 1 2014-15) to date'], not_modelled: ['xG', 'lineups', 'cup and European fixtures', 'schedule congestion'] },
      data: [{ source: 'openfootball/football.json', what: 'fixtures and results, five leagues', cadence: 'daily in season', license: 'public domain (CC0)', cost: 'free' }, { source: 'Data pack', what: 'Premier League 2024-25 (ESPN), reconciled 380/380', cadence: 'one-off', license: 'research copy', cost: 'free' }],
      evidence: 'soccer', blockers: ['1X2 does not beat Elo with a 95% interval in any league; totals are overconfident (calibration slope ≈ 0.65).', 'The source lags: results missing for recent match days are listed, not guessed.', 'No closing archive; prices not captured.'], enable: ['An xG or lineup input to beat Elo; a licensed closing archive for the market test.']
    },
    {
      id: 'tennis', label: 'Tennis (ATP/WTA)', odds_keys: ['tennis_'], family: 'racket', season: [1, 12], product: 'RETIRED', primary: 'moneyline',
      brain: { status: 'BUILT', id: 'tennis-baseline-2026.09.19.874 (lib/tennis_model.js)', approach: 'Existing: a regularised logistic model on overall and surface Elo, ranking and form. Designed extension: serve/return point probabilities combined into match probabilities (barnett2005, klaassen2003).', why: 'Elo-type ratings are the strongest published pre-match predictors (kovalchik2016); serve/return models add surface and format structure.', candidates: [{ name: 'Elo + surface Elo logistic', role: 'existing', sources: ['kovalchik2016'] }, { name: 'serve/return point model', role: 'designed', sources: ['barnett2005', 'klaassen2003'] }], inputs: ['match archive (CC BY-NC-SA, non-commercial)'], not_modelled: ['injuries, retirements'] },
      data: [{ source: 'tennis match archive (tools/tennis)', what: 'results and match stats', cadence: 'manual since retirement', license: 'CC BY-NC-SA — non-commercial', cost: 'free' }],
      evidence: 'tennis', blockers: ['Retired as a product on 2026-09-27 (lib/edgedesk_sports.js).', 'Archive licence is non-commercial.', 'Never tested against a market.'], enable: ['Re-enabling tennis is a product decision: remove it from EDSPORTS.RETIRED, resolve the licence, and add a market test.']
    },
    {
      id: 'mma', label: 'UFC / MMA', odds_keys: ['mma_mixed_martial_arts'], family: 'combat', season: [1, 12], product: 'ACTIVE', primary: 'moneyline',
      brain: { status: 'NOT_BUILT', id: null, approach: 'Designed: opponent-adjusted per-minute rates (significant strikes landed/absorbed, takedowns, control time, submission attempts) driving a Markov chain of fight states → win, method (KO/TKO, submission, decision) and round probabilities, with a Glicko rating as the baseline. Measured: an Elo over the data pack\'s 2024 bouts (engine/lab/ufc_elo.json) — 138 scorable bouts, not distinguishable from a coin flip.', why: 'Holmes, McHale & Zychaluk (2023) show a Markov chain on in-fight statistics matches bookmaker accuracy; rating systems (glickman1999) are the simple baseline.', candidates: [{ name: 'fight-state Markov chain', role: 'designed', sources: ['holmes2023'] }, { name: 'Glicko / Elo', role: 'baseline, measured on 2024 only: insufficient', sources: ['glickman1999'] }], inputs: ['fighter records (lib/ufc_research.js)', 'data pack: 566 bouts of 2024'], not_modelled: ['everything priced: the only probability today is the market\'s de-vigged one'] },
      data: [{ source: 'ESPN public endpoints (tools/ufc)', what: 'events, fighters, fight center', cadence: 'every 6 h', license: 'public endpoints', cost: 'free' }, { source: 'Data pack', what: '2024 bout results (566), no round statistics', cadence: 'one-off', license: 'research copy', cost: 'free' }, { source: 'The Odds API via odds_gateway', what: 'fighter moneylines', cadence: 'gateway cadence', license: 'commercial', cost: 'in budget' }],
      evidence: 'mma', blockers: ['No independent model: one year of results cannot meet the protocol (n ≥ 1000, ≥ 2 seasons).', 'No per-minute fight statistics: UFCStats refuses automated access and is not bypassed.'], enable: ['An authorised fight-statistics feed or a multi-year results archive; then build the Markov brain and validate walk-forward.']
    }
  ];

  function byId(id) { for (var i = 0; i < SPORTS.length; i++) if (SPORTS[i].id === id) return SPORTS[i]; return null; }
  function byOddsKey(k) {
    k = String(k || '').toLowerCase();
    for (var i = 0; i < SPORTS.length; i++) for (var j = 0; j < SPORTS[i].odds_keys.length; j++) { var p = SPORTS[i].odds_keys[j]; if (k === p || (p.charAt(p.length - 1) === '_' && k.indexOf(p) === 0)) return SPORTS[i]; }
    return null;
  }

  /**
   * evidence: { markets: { <market>: { outcome: 'VALIDATED'|'PROVISIONAL'|'NONE',
   *   market: 'NOT_TESTED'|'TESTED_BEHIND'|'TESTED_EVEN'|'TESTED_AHEAD', n, headline, file } } }
   * → { state, label, markets: { m: { state, value_claims, reason } }, value_claims_any }
   */
  function computeReadiness(sport, ev) {
    if (!sport) return { state: 'UNAVAILABLE', label: STATE_LABEL.UNAVAILABLE, markets: {}, value_claims_any: false };
    if (sport.product === 'RETIRED') return { state: 'RETIRED', label: STATE_LABEL.RETIRED, markets: marketsOf(ev, true), value_claims_any: false, note: 'model archived; product retired' };
    var mk = marketsOf(ev, false);
    var best = null;
    for (var k in mk) if (!best || STATES.indexOf(mk[k].state) < STATES.indexOf(best)) best = mk[k].state;
    var state = best || (sport.brain && sport.brain.status === 'NOT_BUILT' ? (sport.data && sport.data.length ? 'RESEARCH_ONLY' : 'UNAVAILABLE') : sport.brain && sport.brain.status === 'PARTIAL' ? 'EXPERIMENTAL' : 'UNAVAILABLE');
    var any = false; for (var k2 in mk) if (mk[k2].value_claims) any = true;
    /* the scope of the headline state: which markets carry it (a sport is never "validated" for a market that is not) */
    var scope = []; for (var k3 in mk) if (mk[k3].state === state) scope.push(k3);
    /* the sport's primary market (the moneyline, or the spread in football): a state carried only by secondary markets is PARTIAL */
    var prim = sport.primary || null, primState = null;
    if (prim) for (var k4 in mk) { var hit = prim.charAt(0) === '*' ? k4.slice(k4.indexOf('.')) === prim.slice(1) : k4 === prim; if (hit && (!primState || STATES.indexOf(mk[k4].state) < STATES.indexOf(primState))) primState = mk[k4].state; }
    var validated = state === 'OUTCOME_VALIDATED' || state === 'MARKET_VALIDATED';
    var partial = validated && prim != null && primState !== state;
    var primName = prim ? prim.replace('*.', '').replace(/_/g, ' ') : null;
    return { state: state, label: STATE_LABEL[state] + (validated ? ' — ' + scope.join(', ') + (partial ? ' only; ' + primName + ' ' + String(primState || 'not modelled').replace(/_/g, ' ').toLowerCase() : '') : ''), scope: scope, primary: prim, primary_state: primState, partial: partial, markets: mk, value_claims_any: any };
  }
  function marketsOf(ev, retired) {
    var out = {};
    var ms = (ev && ev.markets) || {};
    for (var k in ms) {
      var m = ms[k]; var st;
      if (m.outcome === 'VALIDATED' && m.market === 'TESTED_AHEAD' && (m.n || 0) >= 500) st = 'MARKET_VALIDATED';
      else if (m.outcome === 'VALIDATED') st = 'OUTCOME_VALIDATED';
      else if (m.outcome === 'PROVISIONAL' || m.outcome === 'UNVALIDATED') st = 'EXPERIMENTAL';
      else st = 'RESEARCH_ONLY';
      var reason = st === 'MARKET_VALIDATED' ? 'beat the no-vig close out of sample'
        : m.outcome === 'UNVALIDATED' ? 'a model exists but has never been validated out of sample'
        : m.market === 'NOT_TESTED' ? 'never tested against the closing market'
          : m.market === 'TESTED_EVEN' ? 'tested against the close: break-even, not ahead'
            : m.market === 'TESTED_BEHIND' ? 'tested against the close: behind it' : 'not validated';
      out[k] = { state: retired ? 'RETIRED' : st, value_claims: !retired && st === 'MARKET_VALIDATED', reason: reason, outcome: m.outcome, market: m.market, n: m.n || null, headline: m.headline || null, file: m.file || null };
    }
    return out;
  }

  /** may the board call a price in this sport/market an edge? */
  function valueAllowed(registry, sportId, market) {
    var s = registry && registry.sports ? registry.sports.filter(function (x) { return x.id === sportId; })[0] : null;
    if (!s || !s.readiness) return { allowed: false, reason: 'no readiness record for ' + sportId };
    var m = s.readiness.markets[market];
    if (!m) return { allowed: false, reason: 'no validated model for the ' + market + ' market in ' + s.label };
    return { allowed: !!m.value_claims, reason: m.value_claims ? 'validated against the market' : s.label + ' ' + market + ': ' + m.reason };
  }

  return { VERSION: VERSION, STATES: STATES, STATE_LABEL: STATE_LABEL, SOURCES: SOURCES, SPORTS: SPORTS, byId: byId, byOddsKey: byOddsKey, computeReadiness: computeReadiness, valueAllowed: valueAllowed };
});
