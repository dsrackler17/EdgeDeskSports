// deno-lint-ignore-file
/*__EDADAPT_START__*/
/* ===========================================================================
   EdgeDesk SPORT ADAPTERS — what each sport can and cannot be priced with.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHY IT EXISTS
     A football model cannot price a hockey game, and a sport with no captured
     prices cannot be "scanned". Before this registry the board reported an
     uncaptured sport as a genuine empty slate and gave every sport the same
     settlement assumptions. Each entry says, for one sport:
       - whether EdgeDesk captures its prices by default (capture/index.ts
         DEFAULT_SPORTS and the odds_api_sports allowlist), so a sport with no
         prices is NOT_CAPTURED, not NO_GAMES;
       - whether an independent model exists, where it runs, and its
         validation tier per market (football/validation/pricing_*.json at
         build time; the host overrides with EDPRICE.validationFor at run time);
       - the settlement rule per market, so two contracts on "the same game"
         are compared only when they settle the same way;
       - the roles whose availability can invalidate a price (a QB, a starting
         pitcher, a goalie, a fighter).
     Nothing here is a probability. A sport without a validated model gets
     schedule, statistics and market comparison, and its independent fair
     probability is reported UNAVAILABLE — never filled in.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDADAPT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_sport_adapters_v1';
  var TIERS_AS_OF = '2026-09-16'; /* football/validation/pricing_{nfl,cfb}.json generated_at */

  /* Settlement terms per market. `overtime`: does the result include extra
     time; `void`: what voids it; `ties`: how a tie grades; `notes`: anything a
     comparison must check. */
  var ADAPTERS = {
    americanfootball_nfl: {
      key: 'americanfootball_nfl', label: 'NFL', family: 'football', season: [8, 2], captured_by_default: true,
      schedule: 'football/nfl/slate.json (nflverse schedule)',
      stats: ['EPA per play and success rate (nflverse play-by-play)', 'opponent-adjusted unit records (football/matchup/metrics.json)', 'QB EPA per dropback and CPOE', 'rest, roof, surface, kickoff forecast'],
      model: { name: 'edgedesk_football NFL engine', runs: 'server (football/nfl/slate.json, priced by EDPRICE)', validation: 'football/validation/pricing_nfl.json', tiers: { spreads: 'LEAN', totals: 'RESEARCH', h2h: 'RESEARCH' } },
      markets: ['h2h', 'spreads', 'totals'],
      settlement: {
        h2h: { overtime: true, ties: 'a tie is graded by house rule (a push on most two-way moneylines)', void: 'postponed past the book\'s window' },
        spreads: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' },
        totals: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' }
      },
      key_roles: [{ role: 'QB', why: 'the starting quarterback moves an NFL number more than any other player' }],
      availability_source: 'the official NFL injury report (nflverse), in football/matchup/metrics.json'
    },
    americanfootball_ncaaf: {
      key: 'americanfootball_ncaaf', label: 'college football', family: 'football', season: [8, 1], captured_by_default: true,
      schedule: 'football/fbs/slate.json and cfb.games',
      stats: ['opponent-adjusted EPA (football/fbs_epa)', 'SP+ and the EdgeDesk ETSR rating', 'returning production, talent, coaching continuity', 'kickoff forecast'],
      model: { name: 'edgedesk_cfb_p4 / FBS board engine', runs: 'server (football/fbs/slate.json, priced by EDPRICE)', validation: 'football/validation/pricing_cfb.json', tiers: { spreads: 'RESEARCH', totals: 'RESEARCH', h2h: 'RESEARCH' } },
      markets: ['h2h', 'spreads', 'totals'],
      settlement: {
        h2h: { overtime: true, ties: 'college football cannot end tied', void: 'postponed past the book\'s window' },
        spreads: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' },
        totals: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' }
      },
      key_roles: [{ role: 'QB', why: 'a college starter change moves the number and is rarely confirmed before kickoff' }],
      availability_source: 'operator-entered availability (football/availability/manual) — no official CFB feed is reachable'
    },
    baseball_mlb: {
      key: 'baseball_mlb', label: 'MLB', family: 'baseball', season: [3, 11], captured_by_default: true,
      schedule: 'games (the MLB schedule table) and mlb_game_cards',
      stats: ['probable starters with handedness (mlb_game_cards)', 'pitcher features: xERA, FIP, K-BB% (pitcher_features)', '2016-2025 pitching and hitting archives', 'park and weather factors'],
      model: { name: 'edgedesk_baseball_v1.0.0 run model', runs: 'browser only (mlb/engine.js); the desk does not run it', validation: 'none — no MLB closing-line archive (docs/model-card-baseball.md)', tiers: { spreads: 'RESEARCH', totals: 'RESEARCH', h2h: 'RESEARCH' } },
      markets: ['h2h', 'spreads', 'totals'],
      settlement: {
        h2h: { overtime: true, ties: 'baseball cannot end tied (a suspended game follows league rules)', void: 'books grade a moneyline as ACTION or LISTED PITCHERS: a listed-pitcher wager is void if a listed starter does not start', listed_pitchers: true },
        spreads: { overtime: true, ties: 'run line is a half run: no push', void: 'listed-pitcher rules may apply', listed_pitchers: true },
        totals: { overtime: true, ties: 'a landed number is a push', void: 'listed-pitcher rules may apply; a shortened game is void below the official-game threshold', listed_pitchers: true }
      },
      key_roles: [{ role: 'SP', why: 'the starting pitcher is the largest single input to an MLB price; a scratch reprices the game' }],
      availability_source: 'mlb_game_cards probable starters (probable, never confirmed)'
    },
    basketball_nba: {
      key: 'basketball_nba', label: 'NBA', family: 'basketball', season: [10, 6], captured_by_default: false,
      schedule: 'none of its own: the captured signals stand in for the schedule',
      stats: [],
      model: null,
      markets: ['h2h', 'spreads', 'totals'],
      settlement: {
        h2h: { overtime: true, ties: 'cannot end tied', void: 'postponed past the book\'s window' },
        spreads: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' },
        totals: { overtime: true, ties: 'a landed number is a push', void: 'postponed past the book\'s window' }
      },
      key_roles: [{ role: 'STAR', why: 'a rest day or late scratch of a top player moves an NBA number by points' }],
      availability_source: 'none wired'
    },
    basketball_wnba: {
      key: 'basketball_wnba', label: 'WNBA', family: 'basketball', season: [5, 10], captured_by_default: false,
      schedule: 'none of its own', stats: [], model: null, markets: ['h2h', 'spreads', 'totals'],
      settlement: { h2h: { overtime: true, ties: 'cannot end tied' }, spreads: { overtime: true }, totals: { overtime: true } },
      key_roles: [{ role: 'STAR', why: 'late scratches move the number' }], availability_source: 'none wired'
    },
    basketball_ncaab: {
      key: 'basketball_ncaab', label: 'college basketball', family: 'basketball', season: [11, 4], captured_by_default: false,
      schedule: 'none of its own', stats: ['college basketball research tables (cbb_* intents)'], model: null, markets: ['h2h', 'spreads', 'totals'],
      settlement: { h2h: { overtime: true, ties: 'cannot end tied' }, spreads: { overtime: true }, totals: { overtime: true } },
      key_roles: [], availability_source: 'none wired'
    },
    icehockey_nhl: {
      key: 'icehockey_nhl', label: 'NHL', family: 'hockey', season: [10, 6], captured_by_default: false,
      schedule: 'none of its own', stats: [], model: null, markets: ['h2h', 'spreads', 'totals'],
      settlement: {
        h2h: { overtime: true, ties: 'a two-way moneyline includes overtime and the shootout; a three-way (60-minute) moneyline is a different contract', void: 'postponed past the book\'s window', regulation_variant: true },
        spreads: { overtime: true, ties: 'puck line includes overtime and shootout' },
        totals: { overtime: true, ties: 'includes overtime; a shootout adds at most one goal at most books' }
      },
      key_roles: [{ role: 'G', why: 'the starting goalie is the largest single input to an NHL price and is often confirmed late' }],
      availability_source: 'none wired'
    },
    mma_mixed_martial_arts: {
      key: 'mma_mixed_martial_arts', label: 'UFC', family: 'combat', season: [1, 12], captured_by_default: true,
      schedule: 'the captured signals (the ufc.* schema is not exposed to the desk)',
      stats: ['fighter records and fight-center data (lib/ufc_research.js)'],
      model: { name: 'none', runs: 'the one probability shown is the market\'s, de-vigged (lib/ufc_research.js)', validation: 'not applicable', tiers: {} },
      markets: ['h2h'],
      settlement: { h2h: { overtime: false, ties: 'a draw or no contest usually voids a two-way fighter moneyline', void: 'a late replacement voids the original bout at most books' } },
      key_roles: [{ role: 'FIGHTER', why: 'a late replacement is a different fight' }],
      availability_source: 'the captured signals; no late-replacement feed is wired'
    }
  };

  /* What EdgeDesk does not cover, stated rather than silently skipped. */
  var NOT_COVERED = [
    { id: 'soccer', label: 'Soccer', key_prefix: 'soccer_', why: 'no schedule source, no captured prices and no model are wired', settlement: { h2h: { overtime: false, ties: 'a three-way market settles on 90 minutes plus stoppage time; a draw is its own outcome' } } },
    { id: 'tennis', label: 'Tennis', key_prefix: 'tennis_', why: 'retired as a product on 2026-09-27 (lib/edgedesk_sports.js)' },
    { id: 'golf', label: 'Golf', key_prefix: 'golf_', why: 'no data source or model' }
  ];

  function str(v) { return v == null ? '' : String(v); }
  function adapterFor(sportKey) {
    var k = str(sportKey).toLowerCase();
    if (ADAPTERS[k]) return ADAPTERS[k];
    return null;
  }
  function notCoveredFor(sportKey) {
    var k = str(sportKey).toLowerCase();
    for (var i = 0; i < NOT_COVERED.length; i++) if (k === NOT_COVERED[i].id || k.indexOf(NOT_COVERED[i].key_prefix) === 0) return NOT_COVERED[i];
    return null;
  }
  /** The sports whose prices are captured: an explicit list (EDGEDESK_CAPTURED_SPORTS) wins, else the capture defaults. */
  function capturedSports(list) {
    if (Array.isArray(list) && list.length) return list.map(function (x) { return str(x).trim(); }).filter(Boolean);
    if (typeof list === 'string' && list.trim()) return list.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    return Object.keys(ADAPTERS).filter(function (k) { return ADAPTERS[k].captured_by_default; });
  }
  function isCaptured(sportKey, list) { return capturedSports(list).indexOf(str(sportKey)) >= 0; }

  /**
   * What a scan of one sport actually covered. Data wins over configuration:
   * a sport the registry calls uncaptured that HAS prices was captured.
   * o: { signals: n, games: n, captured_list, read_error }
   */
  function coverageStatus(sportKey, o) {
    o = o || {};
    var a = adapterFor(sportKey);
    if (!a) { var nc = notCoveredFor(sportKey); return { status: 'NOT_SUPPORTED', why: nc ? nc.why : 'no adapter for this sport' }; }
    if (o.read_error) return { status: 'RETRIEVAL_FAILED', why: str(o.read_error) };
    var sig = Number(o.signals) || 0, games = Number(o.games) || 0;
    if (sig > 0) return { status: 'EVALUATED', why: sig + ' captured price row' + (sig === 1 ? '' : 's') + ' across ' + games + ' game' + (games === 1 ? '' : 's') };
    if (!isCaptured(sportKey, o.captured_list)) return { status: 'NOT_CAPTURED', why: 'EdgeDesk does not capture ' + a.label + ' prices (not in the capture allowlist), so no ' + a.label + ' market was scanned — this is not an empty slate' };
    if (games > 0) return { status: 'NO_PRICES', why: games + ' scheduled game' + (games === 1 ? '' : 's') + ' and no captured price inside the window' };
    return { status: 'NO_GAMES', why: 'no scheduled ' + a.label + ' games in the window' };
  }

  /**
   * Can this sport's own model price this market? Reads the run-time tier when
   * the host passes one (EDPRICE.validationFor), else the registry's.
   * → { independent_model, may_price, tier, name, runs, reason }
   */
  function modelCapability(sportKey, market, runtimeTier) {
    var a = adapterFor(sportKey);
    var m = str(market).toLowerCase();
    m = m === 'spread' ? 'spreads' : m === 'total' ? 'totals' : m === 'moneyline' || m === 'ml' ? 'h2h' : m;
    if (!a) return { independent_model: false, may_price: false, tier: null, name: null, runs: null, reason: 'no adapter for ' + sportKey };
    if (!a.model || !a.model.tiers || a.model.name === 'none') return { independent_model: false, may_price: false, tier: null, name: null, runs: a.model ? a.model.runs : null, reason: 'no independent ' + a.label + ' model: the independent fair probability is unavailable; only the market\'s own de-vigged price can be compared' };
    var tier = runtimeTier || a.model.tiers[m] || null;
    var serverRuns = /^server/.test(a.model.runs || '');
    var may = serverRuns && (tier === 'VALIDATED' || tier === 'LEAN' || tier === 'PROBABILITY');
    return {
      independent_model: true, may_price: may, tier: tier, name: a.model.name, runs: a.model.runs, validation: a.model.validation, tiers_as_of: runtimeTier ? 'run time' : TIERS_AS_OF,
      reason: !serverRuns ? 'the ' + a.label + ' model runs in the browser only and is not available to the desk'
        : may ? 'the ' + a.label + ' ' + marketWord(m) + ' model is ' + tier + ': its probability may be used' + (tier === 'LEAN' ? ' as break-even history, not a profit record' : '')
          : 'the ' + a.label + ' ' + marketWord(m) + ' model is ' + (tier || 'unvalidated') + ': research only, never an edge'
    };
  }
  function marketWord(m) { return m === 'spreads' ? 'spread' : m === 'totals' ? 'total' : m === 'h2h' ? 'moneyline' : m; }

  /**
   * Do two contracts on one game settle the same way? `a` is the reference
   * (usually the sportsbook market the fair came from), `b` the one being
   * priced. Each: { overtime: bool, listed_pitchers: bool, three_way: bool,
   * terms_verified: bool }. A difference that can change who wins is
   * MATERIAL; one that only changes when a bet is void is MINOR.
   */
  function compareSettlement(sportKey, market, a, b) {
    var ad = adapterFor(sportKey);
    var m = str(market).toLowerCase();
    var base = ad && ad.settlement ? ad.settlement[m] || null : null;
    a = Object.assign({}, base || {}, a || {});
    b = b || {};
    var diffs = [];
    if (b.terms_verified === false || b.overtime == null) diffs.push({ severity: 'UNVERIFIED', what: 'the contract\'s settlement terms are not on file; read its rules (overtime, postponement, source of truth) before comparing prices' });
    if (b.overtime != null && a.overtime != null && b.overtime !== a.overtime) diffs.push({ severity: 'MATERIAL', what: (b.overtime ? 'this contract includes overtime' : 'this contract settles on regulation only') + ' while the reference market ' + (a.overtime ? 'includes overtime' : 'is regulation only') + ' — a tie at regulation decides them differently' });
    if (b.three_way && !a.three_way) diffs.push({ severity: 'MATERIAL', what: 'a three-way contract (draw is its own outcome) against a two-way reference' });
    if (a.listed_pitchers && b.listed_pitchers === false) diffs.push({ severity: 'MINOR', what: 'the reference may be graded LISTED PITCHERS (void on a starter change) while this contract has ACTION on the result' });
    var material = diffs.filter(function (d) { return d.severity === 'MATERIAL'; });
    var unverified = diffs.filter(function (d) { return d.severity === 'UNVERIFIED'; });
    return {
      verified: !diffs.length || (!material.length && !unverified.length),
      mismatch: diffs.length ? diffs.map(function (d) { return d.what; }).join('; ') : null,
      mismatch_severity: material.length ? 'MATERIAL' : unverified.length ? 'UNVERIFIED' : diffs.length ? 'MINOR' : null,
      differences: diffs, reference: a
    };
  }

  function keyRoles(sportKey) { var a = adapterFor(sportKey); return a ? a.key_roles.map(function (r) { return r.role; }) : []; }
  function supported() { return Object.keys(ADAPTERS); }
  function inSeason(sportKey, month) { var a = adapterFor(sportKey); if (!a) return false; var x = a.season[0], y = a.season[1]; return x <= y ? (month >= x && month <= y) : (month >= x || month <= y); }

  /** One line per sport for "what can you scan?": capture, model, tier. */
  function capabilityTable(o) {
    o = o || {};
    var rows = Object.keys(ADAPTERS).map(function (k) {
      var a = ADAPTERS[k];
      var tiers = a.model && a.model.tiers ? a.model.tiers : {};
      return { sport: k, label: a.label, captured: isCaptured(k, o.captured_list), in_season: o.month ? inSeason(k, o.month) : null,
        independent_model: !!(a.model && a.model.name !== 'none'), model: a.model ? a.model.name : null, model_runs: a.model ? a.model.runs : null,
        tiers: tiers, key_roles: a.key_roles.map(function (r) { return r.role; }) };
    });
    NOT_COVERED.forEach(function (n) { rows.push({ sport: n.id, label: n.label, captured: false, in_season: null, independent_model: false, model: null, model_runs: null, tiers: {}, key_roles: [], not_covered: n.why }); });
    return rows;
  }

  return {
    VERSION: VERSION, TIERS_AS_OF: TIERS_AS_OF, ADAPTERS: ADAPTERS, NOT_COVERED: NOT_COVERED,
    adapterFor: adapterFor, notCoveredFor: notCoveredFor, capturedSports: capturedSports, isCaptured: isCaptured,
    coverageStatus: coverageStatus, modelCapability: modelCapability, compareSettlement: compareSettlement,
    keyRoles: keyRoles, supported: supported, inSeason: inSeason, capabilityTable: capabilityTable
  };
});
/*__EDADAPT_END__*/
