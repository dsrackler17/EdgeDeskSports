/* ===========================================================================
   EDGEDESK SIGNAL CENTER — the capability registry: which sport can produce
   which signal, from which source, and why not when it cannot.
   docs/signal-center/ARCHITECTURE.md §3 (the inventory this encodes)

   A sport is supported because a source exists, not because it is in a menu.
   Every capability names the committed file or database table it reads, and
   every "no" names its blocker. tools/signal_center/registry.test.js holds
   this file to the repository: a source named here must exist, and the
   Simulator's state is never written here — it is read from the Simulator's
   own generated registry (lib/edgedesk_simulator_sports.js), so a sport the
   Simulator activates becomes eligible for simulation signals without an
   edit here, and a blocked one can never be shown as active.

   STATES
     OPERATIONAL   the source exists, is fresh in season, and the detector is
                   wired and tested
     EXPERIMENTAL  wired, but the model or the comparison carries a stated
                   limitation every signal repeats (e.g. never market-tested)
     BLOCKED       a named blocker stops it (no timestamps, capture disabled…)
     COMING_SOON   out of season, or a source exists but is not wired yet
     UNAVAILABLE   nothing in EdgeDesk can support it

   ROLLOUT (docs/signal-center/DEPLOYMENT.md §2): LIVE_CANDIDATE sports may be
   published once the database is in live mode and the sport is switched on
   in sc_config; every other sport stays in shadow (admins only).

   Browser: window.EDSignalRegistry. Node: require('./edgedesk_signal_registry.js').
   =========================================================================== */
(function (root, factory) {
  var sims = null;
  if (typeof module === 'object' && module.exports) { try { sims = require('./edgedesk_simulator_sports.js'); } catch (e) { sims = null; } }
  var api = factory(root, sims);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDSignalRegistry = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root, simsNode) {
  'use strict';
  var R = { VERSION: 'edgedesk_signal_registry/1' };

  var SRC = {
    game_research: 'football/game_research/history/<season>.jsonl',
    perf_forecasts: 'performance/ledger/forecasts/<sport>-<year>.jsonl',
    perf_quotes: 'performance/ledger/quotes/<sport>-<year>.jsonl',
    perf_summary: 'performance/data/summary.json',
    registry: 'engine/registry.json',
    sim: 'public.sim_published + public.sim_runs + public.sim_team_results',
    kalshi: 'public.kalshi_price_snapshots + public.kalshi_game_links',
    cfb_avail: 'football/availability/reports/*.json',
    nba_injury: 'public.nba_injury_report_snapshots',
    ncaam_fc: 'public.ncaam_fc_runs + public.ncaam_fc_forecasts',
    slate: 'today/slate.json'
  };
  R.SOURCES = SRC;

  function cap(state, detail, source) { return { state: state, detail: detail, source: source || null }; }
  var OP = 'OPERATIONAL', EXP = 'EXPERIMENTAL', BLK = 'BLOCKED', SOON = 'COMING_SOON', NA = 'UNAVAILABLE';

  /* the parts that do not depend on the Simulator */
  var BASE = [
    { key: 'nfl', label: 'NFL', rollout: 'LIVE_CANDIDATE', season_note: 'In season.',
      capabilities: {
        forecasting: cap(OP, 'edgedesk_nfl_v2.1.0 prices every game on the board (football/nfl/slate.json).', 'football/nfl/slate.json'),
        forecast_history: cap(OP, 'Append-only pregame snapshot ledger, one row per change, with the model version.', SRC.game_research),
        market_capture: cap(OP, 'ESPN-scoreboard DraftKings moneylines with capture times (performance ledger); Kalshi game markets in the database.', SRC.perf_quotes),
        injury_roster: cap(BLK, 'football/injuries/nfl_2026.json is overwritten weekly and carries no per-row publication time: a designation cannot be dated, so no injury signal is made from it.', 'football/injuries/nfl_2026.json'),
        model_audit: cap(OP, 'Walk-forward calibration (engine/registry.json) and the live graded record (performance/data/summary.json).', SRC.perf_summary),
        graphics: cap(OP, 'The matchup graphic renderer (lib/edgedesk_game_graphic.js) draws the signal templates.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive same-version snapshots of the game win probability.', SRC.game_research),
        MARKET_DIVERGENCE: cap(OP, 'Model win probability vs a live DraftKings moneyline, de-vigged. The NFL moneyline was behind the close in its backtest: every signal says so.', SRC.perf_quotes),
        MARKET_CONVERGENCE: cap(OP, 'A stored divergence that has since closed (same book, same model version).', SRC.perf_quotes),
        LINE_MOVEMENT: cap(OP, 'Consecutive captures of the same book’s moneyline.', SRC.perf_quotes),
        INJURY_IMPACT: cap(BLK, 'No dated NFL injury source (see injury_roster).', null),
        MODEL_RELIABILITY_WARNING: cap(OP, 'Live calibration bands, the market comparison and the serving version’s live record.', SRC.perf_summary),
        DATA_QUALITY_WARNING: cap(OP, 'Age of the research snapshots and the performance ledger.', 'football/game_research/current.json')
      } },
    { key: 'cfb', label: 'College football', rollout: 'LIVE_CANDIDATE', season_note: 'In season.',
      capabilities: {
        forecasting: cap(OP, 'edgedesk_cfb_p4_v1.0.1 prices every FBS game (football/fbs/slate.json).', 'football/fbs/slate.json'),
        forecast_history: cap(OP, 'Append-only pregame snapshot ledger with the model version.', SRC.game_research),
        market_capture: cap(OP, 'ESPN-scoreboard DraftKings moneylines with capture times; Kalshi game markets in the database.', SRC.perf_quotes),
        injury_roster: cap(OP, 'Official conference availability reports with publication times (reports without one are refused at ingest).', SRC.cfb_avail),
        model_audit: cap(OP, 'Walk-forward calibration and the live graded record. The CFB moneyline backtest is PROVISIONAL.', SRC.perf_summary),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive same-version snapshots of the game win probability.', SRC.game_research),
        MARKET_DIVERGENCE: cap(EXP, 'The CFB moneyline is PROVISIONAL in its backtest (a calibration band off by more than 0.05) and behind the close: every signal carries that limitation.', SRC.perf_quotes),
        MARKET_CONVERGENCE: cap(EXP, 'As divergence.', SRC.perf_quotes),
        LINE_MOVEMENT: cap(OP, 'Consecutive captures of the same book’s moneyline.', SRC.perf_quotes),
        INJURY_IMPACT: cap(OP, 'Quarterback designations from dated official availability reports. No per-player model effect is calculated, and none is shown.', SRC.cfb_avail),
        MODEL_RELIABILITY_WARNING: cap(OP, 'Live calibration bands and the market comparison.', SRC.perf_summary),
        DATA_QUALITY_WARNING: cap(OP, 'Age of the research snapshots and the performance ledger.', 'football/game_research/current.json')
      } },
    { key: 'nba', label: 'NBA', rollout: 'SHADOW', season_note: 'Season opened 2026-10-20.',
      capabilities: {
        forecasting: cap(OP, 'The NBA board (nba/slate.json), ledgered by the performance ledger.', 'nba/slate.json'),
        forecast_history: cap(OP, 'Performance-ledger forecast revisions, hash-chained.', SRC.perf_forecasts),
        market_capture: cap(EXP, 'Odds capture is disabled for the NBA; only ESPN-scoreboard DraftKings quotes are on file.', SRC.perf_quotes),
        injury_roster: cap(EXP, 'Official NBA injury reports with publication times, in the database (needs the service role).', SRC.nba_injury),
        model_audit: cap(EXP, 'Backtest VALIDATED, never tested against the closing market; live record too early.', SRC.perf_summary),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive same-model forecast revisions.', SRC.perf_forecasts),
        MARKET_DIVERGENCE: cap(EXP, 'The NBA model has never been compared with a timestamped closing market: value claims are off and every signal says so.', SRC.perf_quotes),
        MARKET_CONVERGENCE: cap(EXP, 'As divergence.', SRC.perf_quotes),
        LINE_MOVEMENT: cap(EXP, 'One book, one ESPN read per pass.', SRC.perf_quotes),
        INJURY_IMPACT: cap(EXP, 'Status changes between official reports. A model effect is shown only where the Roster-Adjusted Projection (T3, EXPERIMENTAL) computed one.', SRC.nba_injury),
        MODEL_RELIABILITY_WARNING: cap(OP, 'Live record (too early today).', SRC.perf_summary),
        DATA_QUALITY_WARNING: cap(OP, 'Performance ledger age.', SRC.perf_forecasts)
      } },
    { key: 'nhl', label: 'NHL', rollout: 'SHADOW', season_note: 'In season.',
      capabilities: {
        forecasting: cap(OP, 'edgedesk_nhl_v1:xg_core (hockey/slate.json).', 'hockey/slate.json'),
        forecast_history: cap(OP, 'Performance-ledger forecast revisions.', SRC.perf_forecasts),
        market_capture: cap(EXP, 'Odds capture is disabled for the NHL; ESPN-scoreboard DraftKings quotes only.', SRC.perf_quotes),
        injury_roster: cap(BLK, 'No injury report feed: only a goalie-certainty field, which is not a source-dated designation.', 'hockey/ingest/lineups.js'),
        model_audit: cap(OP, 'Backtest VALIDATED (moneyline), never market-tested; live record graded.', SRC.perf_summary),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive same-model forecast revisions.', SRC.perf_forecasts),
        MARKET_DIVERGENCE: cap(EXP, 'Never tested against the closing market: every signal says so.', SRC.perf_quotes),
        MARKET_CONVERGENCE: cap(EXP, 'As divergence.', SRC.perf_quotes),
        LINE_MOVEMENT: cap(EXP, 'One book, one ESPN read per pass.', SRC.perf_quotes),
        INJURY_IMPACT: cap(BLK, 'No dated injury source.', null),
        MODEL_RELIABILITY_WARNING: cap(OP, 'Live record.', SRC.perf_summary),
        DATA_QUALITY_WARNING: cap(OP, 'Performance ledger age.', SRC.perf_forecasts)
      } },
    { key: 'mlb', label: 'MLB', rollout: 'SHADOW', season_note: 'Postseason.',
      capabilities: {
        forecasting: cap(EXP, 'The live card is hand-set and never logged (mlb/params.js); the history model prices no live game.', 'mlb/engine.js'),
        forecast_history: cap(NA, 'No point-in-time per-game forecast ledger is committed for MLB.', null),
        market_capture: cap(OP, 'Odds capture is enabled for MLB (database signals).', 'public.signals'),
        injury_roster: cap(NA, 'No injury feed.', null),
        model_audit: cap(EXP, 'Walk-forward only (moneyline PROVISIONAL).', SRC.registry),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(NA, 'No forecast history to compare.', null),
        MARKET_DIVERGENCE: cap(NA, 'No ledgered model forecast to compare with the market.', null),
        INJURY_IMPACT: cap(NA, 'No injury feed.', null),
        DATA_QUALITY_WARNING: cap(OP, 'Simulator and slate freshness.', SRC.slate)
      } },
    { key: 'wnba', label: 'WNBA', rollout: 'SHADOW', season_note: 'Finals; the season is ending.',
      capabilities: {
        forecasting: cap(OP, 'edgedesk_bb_points_v1 (basketball/).', 'basketball/slate.json'),
        forecast_history: cap(OP, 'Performance-ledger forecast revisions.', SRC.perf_forecasts),
        market_capture: cap(NA, 'No WNBA quotes are captured.', null),
        injury_roster: cap(NA, 'No injury feed.', null),
        model_audit: cap(EXP, 'Moneyline PROVISIONAL in the backtest; live record too early.', SRC.perf_summary),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive same-model forecast revisions.', SRC.perf_forecasts),
        MARKET_DIVERGENCE: cap(NA, 'No market captured.', null),
        INJURY_IMPACT: cap(NA, 'No injury feed.', null),
        MODEL_RELIABILITY_WARNING: cap(OP, 'Live record (too early today).', SRC.perf_summary)
      } },
    { key: 'ncaam', label: 'Men’s college basketball', rollout: 'SHADOW', season_note: 'Season opens 2026-11-02.',
      capabilities: {
        forecasting: cap(OP, 'The daily pregame refresh prices D-I games in the next 48 hours with the champion model (public.ncaam_fc_forecasts, published when NCAAM_FC_PUBLISH is on); premium-gated for readers.', 'public.ncaam_fc_forecasts'),
        forecast_history: cap(OP, 'Every published daily run is kept with its model key and data cut (a run that never took the published pointer is not read).', SRC.ncaam_fc),
        market_capture: cap(NA, 'No college basketball market is captured.', null),
        injury_roster: cap(NA, 'Only an availability-assumption text field.', null),
        model_audit: cap(OP, 'Walk-forward VALIDATED, never market-tested.', SRC.registry),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {
        FORECAST_SHIFT: cap(OP, 'Consecutive published daily runs of the same model for a D-I game not yet started. Early-season forecasts carry their data-quality flags; availability is not modelled, and every signal says so.', SRC.ncaam_fc),
        MARKET_DIVERGENCE: cap(NA, 'No captured men’s college basketball market price is wired to Signal Center.', null)
      } },
    { key: 'mma', label: 'UFC', rollout: 'SHADOW', season_note: 'Event-based.',
      capabilities: {
        forecasting: cap(EXP, 'The UFC Elo model is EXPERIMENTAL; the card’s fair prices are market de-vigs.', 'model_loop/ledger/ufc/cards_2026.jsonl'),
        forecast_history: cap(SOON, 'One publish on file (v1.0.0 while v1.1.0 is current).', 'model_loop/ledger/ufc/cards_2026.jsonl'),
        market_capture: cap(BLK, 'Database market captures paused since 2026-10-10.', 'ufc.market_captures'),
        injury_roster: cap(NA, 'Bout status only.', null),
        model_audit: cap(EXP, 'Backtest PROVISIONAL.', SRC.registry),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: { FORECAST_SHIFT: cap(SOON, 'Not enough publishes to compare.', null) } },
    { key: 'college_baseball', label: 'College baseball', rollout: 'SHADOW', season_note: 'Off-season.',
      capabilities: {
        forecasting: cap(SOON, 'Off-season; promotion of cbase_v1.0.0 was refused 2026-10-14.', 'college_baseball/'),
        forecast_history: cap(NA, 'Only retrospective replay boards, never live captures.', 'college_baseball/board/2026/'),
        market_capture: cap(BLK, 'The odds gateway row for college baseball is disabled.', 'supabase/cbase_odds_sport.sql'),
        injury_roster: cap(NA, 'Rosters only.', null),
        model_audit: cap(OP, 'Holdout VALIDATED (moneyline), never market-tested.', SRC.registry),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: { FORECAST_SHIFT: cap(SOON, 'Off-season.', null) } },
    { key: 'ncaaw', label: 'Women’s college basketball', rollout: 'SHADOW', season_note: 'Season opens in November.',
      capabilities: {
        forecasting: cap(SOON, 'edgedesk_bb_points_v1 (league ncaaw); not ledgered for Signal Center.', 'basketball/'),
        forecast_history: cap(NA, 'No committed per-game forecast ledger.', null),
        market_capture: cap(NA, 'No line data at all.', null),
        injury_roster: cap(NA, 'No feed.', null),
        model_audit: cap(OP, 'Walk-forward VALIDATED.', SRC.registry),
        graphics: cap(OP, 'Signal templates on the existing renderer.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {} },
    { key: 'tennis', label: 'Tennis', rollout: 'SHADOW', season_note: 'Match model retired 2026-09-27; the Simulator runs tournament draws.',
      capabilities: {
        forecasting: cap(NA, 'The match model was retired; no per-match forecast is published.', null),
        graphics: cap(OP, 'Signal templates on the existing renderer: initials in neutral colours, no photo or logo.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {} },
    { key: 'golf', label: 'Golf', rollout: 'SHADOW', season_note: 'No game model; the Simulator runs tournaments.',
      capabilities: {
        forecasting: cap(NA, 'No EdgeDesk golf model outside the Simulator.', null),
        graphics: cap(OP, 'Signal templates on the existing renderer: initials in neutral colours, no photo or logo.', 'lib/edgedesk_game_graphic.js')
      },
      signals: {} }
  ];
  /* categories no sport supports today, and why */
  R.UNSUPPORTED = {
    ROSTER_MOVEMENT: 'Transfers, signings and roster moves are not ingested as dated events for any sport wired here. NBA roster captures exist in the database; a roster signal will be added only with a source-dated transaction feed (a portal entry is never a completed transfer).',
    MODEL_DISAGREEMENT: 'Independent EdgeDesk models for the same game are not published side by side outside the CFB Lab; the Consensus Breaker shows the compatible references a signal already carries instead of building a synthetic model.',
    HISTORICAL_ANOMALY: 'Needs a multi-season point-in-time distribution of the same quantity; the ledgers start in 2026. The rarity component of the score is the honest substitute until then.'
  };

  function simRegistry() {
    if (simsNode && simsNode.sports) return simsNode;
    if (root && root.EDSimSports && root.EDSimSports.sports) return root.EDSimSports;
    return null;
  }
  /* the sports whose Simulator outcomes Signal Center can compare: the keys of
     lib/edgedesk_signal_engine.js E.SIM_OUTCOMES (held equal by
     tools/signal_center/registry.test.js; the engine is not loaded with the
     terminal seat, so the list is written here too) */
  R.SIM_OUTCOME_SPORTS = ['nfl', 'cfb', 'nhl', 'nba', 'mlb', 'wnba', 'golf', 'tennis', 'mma'];
  /* the Simulator's name for a sport where it differs from this registry's */
  var SIM_KEY = { mma: 'ufc' };
  /* what a simulator shift compares where it is not a season standing */
  var SIM_SCOPE = {
    golf: 'One tournament: win, top 5/10/20 and the cut (the cut is compared only until it is made).',
    tennis: 'One draw: title, final, semifinal and quarterfinal. "Win the next match" is not compared: the next match changes once one is played.',
    mma: 'The title path within the Simulator’s horizon (Estimated: matchmaking is modelled). The next-bout outcomes are not compared.'
  };
  /* the Simulator's own word on a sport, translated, never overridden */
  R.simulator = function (sport) {
    var reg = simRegistry();
    if (!reg) return cap(NA, 'The Simulator registry is not loaded.', 'lib/edgedesk_simulator_sports.js');
    var s = null, key = SIM_KEY[sport] || sport;
    reg.sports.forEach(function (x) { if (x.key === key) s = x; });
    if (!s) return cap(NA, 'The Simulator has no module for this sport.', 'lib/edgedesk_simulator_sports.js');
    if (s.status === 'ACTIVE') return cap(EXP, 'ACTIVE in the Simulator; every simulator result is a T3 research model (EXPERIMENTAL).' + (sport === 'cfb' ? ' CFP selection and seeding are Estimated (committee proxy), never known.' : ''), SRC.sim);
    if (s.status === 'BLOCKED') return cap(BLK, 'Blocked in the Simulator: ' + ((s.blockers || []).join('; ') || 'see the Simulator'), 'lib/edgedesk_simulator_sports.js');
    return cap(SOON, 'Coming soon in the Simulator.', 'lib/edgedesk_simulator_sports.js');
  };

  R.sports = function () {
    return BASE.map(function (b) {
      var sim = R.simulator(b.key);
      var caps = Object.assign({}, b.capabilities, { simulator: sim });
      var sig = Object.assign({}, b.signals);
      sig.SIMULATION_SHIFT = sim.state !== EXP ? cap(sim.state, sim.detail, sim.source)
        : (R.SIM_OUTCOME_SPORTS.indexOf(b.key) >= 0 ? cap(EXP, 'Changes between published Simulator runs (Monte Carlo error is sampling error only).' + (SIM_SCOPE[b.key] ? ' ' + SIM_SCOPE[b.key] : ''), SRC.sim)
          : cap(NA, 'The Simulator runs this sport, but Signal Center has no outcome definitions for its results yet.', null));
      return { key: b.key, label: b.label, rollout: b.rollout, season_note: b.season_note, capabilities: caps, signals: sig };
    });
  };
  R.sport = function (key) { var out = null; R.sports().forEach(function (s) { if (s.key === key) out = s; }); return out; };
  /* may this sport produce this category? OPERATIONAL and EXPERIMENTAL may;
     anything else is refused with its reason */
  R.eligible = function (sport, category) {
    var s = R.sport(sport);
    if (!s) return { ok: false, state: NA, reason: 'sport not in the Signal Center registry' };
    if (R.UNSUPPORTED[category]) return { ok: false, state: NA, reason: R.UNSUPPORTED[category] };
    var c = s.signals[category];
    if (!c) return { ok: false, state: NA, reason: 'no source supports ' + category + ' for ' + s.label };
    return { ok: c.state === OP || c.state === EXP, state: c.state, reason: c.detail, source: c.source };
  };
  R.STATES = { OPERATIONAL: OP, EXPERIMENTAL: EXP, BLOCKED: BLK, COMING_SOON: SOON, UNAVAILABLE: NA };
  R.LIVE_CANDIDATES = BASE.filter(function (b) { return b.rollout === 'LIVE_CANDIDATE'; }).map(function (b) { return b.key; });
  return R;
});
