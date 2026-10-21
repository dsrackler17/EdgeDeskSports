// deno-lint-ignore-file
/*__EDPROJ_START__*/
/* ===========================================================================
   EdgeDesk INDEPENDENT PROJECTIONS — the universal sports research registry
   and the model output contract.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.
   Node requires it directly (engine/build_projections.js, the tests).

   THE ARCHITECTURE THIS FILE ENFORCES
     sports data → sport-specific model (each sport's own engine, run by its
     own scheduled build) → THIS FILE: every published model artifact read
     into ONE contract, frozen and hashed → only then the market (EDMKT).

   NO MARKET INPUT, BY CONSTRUCTION
     An adapter reads only a model's own fields. The market blocks the
     artifacts also carry are listed per adapter (MARKET_FIELDS) and are never
     read: the NFL slate's `pricing` rows (a blend of the model and the
     consensus line), its `reference_market`, the NBA slate's `market` and
     `decision`, the NHL slate's `market_check` and `quotes_by_game`.
     tools/intelligence/multisport.test.js scrubs those fields and changes
     them at random and proves every projection is byte-identical. A
     projection carries `model.market_inputs: []`; a projection with anything
     there is not independent and the market comparison refuses it.

   WHAT A SPORT GETS
     A sport with an operational engine gets a projection per event: winner
     probability, fair moneyline / spread / total from that engine's own
     distribution, projected score, uncertainty, validation (engine/
     registry.json, the sport's own walk-forward), availability assumptions,
     matchup factors, provenance and freshness. A sport without one gets an
     explicit MODEL_UNAVAILABLE with the reason — never a number.

   Nothing here fetches. The host (or the build script) hands in the parsed
   artifacts; a missing artifact is a coverage blocker, not an empty slate.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPROJ = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_projections_v1';
  var CONTRACT = 'edgedesk_independent_projection_v1';
  var SNAPSHOT = 'edgedesk_projection_snapshot_v1';

  /* Uncertainty components. The lineup and default model/calibration values
     are the cross-sport board's own (lib/edgedesk_xboard.js DEFAULTS and the
     components engine/build_board.js gives football), so the research ranking
     and the board cannot disagree about what "uncertain" costs. A sport's own
     per-game figure always replaces the default. */
  var SIGMA = {
    lineup: { CONFIRMED: 0, PROJECTED_LIKELY: 0.005, PROJECTED_UNCERTAIN: 0.012, UNKNOWN: 0.02 },
    model_default: 0.03,
    calibration_by_state: { MARKET_VALIDATED: 0.01, OUTCOME_VALIDATED: 0.015, EXPERIMENTAL: 0.03, RESEARCH_ONLY: 0.05 },
    starter_conflict: 0.04
  };
  var STATE_RANK = { MARKET_VALIDATED: 0, OUTCOME_VALIDATED: 1, EXPERIMENTAL: 2, RESEARCH_ONLY: 3, UNAVAILABLE: 4, RETIRED: 5 };
  var PRICING_STATES = { MARKET_VALIDATED: true, OUTCOME_VALIDATED: true };
  var RESEARCH_OUTCOMES = ['RESEARCH_READY', 'RESEARCH_CONDITIONAL', 'DATA_INSUFFICIENT', 'MODEL_UNAVAILABLE'];

  /* Who a source is. Only a league's own feed is OFFICIAL; a dataset that mirrors an official
     report (nflverse's copy of the NFL injury report) is a THIRD_PARTY_MIRROR of it, and a
     community dataset is THIRD_PARTY. Nothing is promoted by its content. */
  var AUTHORITY = [
    [/api-web\.nhle\.com|nhl_api|statsapi\.mlb\.com/i, 'OFFICIAL'],
    [/nflverse.*injur|injur.*nflverse/i, 'THIRD_PARTY_MIRROR'],
    [/nflverse|sportsdataverse|hoopr|fastr|retrosheet|openfootball|cfbfastr|collegefootballdata|espn/i, 'THIRD_PARTY'],
    [/^(hockey|nba|basketball|soccer|football|engine|mlb)\//i, 'EDGEDESK_MODEL']
  ];
  function authorityOf(src) { var s = str(src); for (var i = 0; i < AUTHORITY.length; i++) if (AUTHORITY[i][0].test(s)) return AUTHORITY[i][1]; return 'UNVERIFIED_SOURCE'; }

  /* ================================================================ */
  /* 1. THE UNIVERSAL SPORTS RESEARCH REGISTRY                         */
  /* ================================================================ */
  /* One row per sport. `adapter` names the function below that reads the sport's published engine;
     a sport with adapter null has no operational independent model, and `unsupported` says why. */
  var SPORTS = {
    nhl: {
      id: 'nhl', label: 'NHL', league: 'NHL', level: 'professional', family: 'hockey', odds_key: 'icehockey_nhl', registry_id: 'nhl', schedule_codes: ['nhl'], season_months: [10, 6],
      adapter: 'nhl', artifacts: ['hockey/slate.json'], max_age_hours: 8,
      discovery: 'NHL schedule (NHL API + sportsdataverse) in hockey/slate.json, cross-checked with the ESPN scoreboard in today/slate.json',
      providers: ['NHL API (official)', 'sportsdataverse fastRhockey (third-party)', 'ESPN scoreboard (third-party)'],
      stats: ['score- and opponent-adjusted 5v5 expected goals for/against', 'goals and finishing beyond xG', 'goalie GSAx and start probabilities', 'power play / penalty kill (measured, not in the price)', 'rest, back-to-backs, travel and time zones (measured)'],
      availability: 'projected goalies with start probabilities (confirmations from hockey/data/confirmed_starters.json when posted); regulars absent from the last game; no injury feed',
      simulation: { method: 'exact score distribution: Poisson GLM on xG ratings, score effects by period, goalie pull, 3-on-3 overtime and shootout', monte_carlo: false },
      markets: ['moneyline', 'spread', 'total'], key_role: 'G', unsupported: []
    },
    nba: {
      id: 'nba', label: 'NBA', league: 'NBA', level: 'professional', family: 'basketball', odds_key: 'basketball_nba', registry_id: 'nba', schedule_codes: ['nba'], season_months: [10, 6],
      adapter: 'nba', artifacts: ['nba/slate.json', 'nba/validation/summary.json'], max_age_hours: 8,
      discovery: 'regular-season schedule (hoopR) in nba/slate.json, cross-checked with the ESPN scoreboard',
      providers: ['hoopR / ESPN play-by-play (third-party)', 'ESPN scoreboard (third-party)'],
      stats: ['opponent-adjusted offensive and defensive efficiency per 100 possessions', 'pace', 'Four Factors (eFG%, TOV%, ORB%, FTr) and shot profile', 'shooting luck vs shot locations', 'projected rotation and absent regulars (last game)', 'rest, back-to-backs, games in 7 days, travel, altitude'],
      availability: 'rotation projected from the last game played; player sits/returns scenarios; no injury report or confirmed lineup feed',
      simulation: { method: 'margin and total distribution (edgedesk_nba_dist_v1) from a stacked ensemble of 12 candidate models', monte_carlo: false },
      markets: ['moneyline', 'spread', 'total'], key_role: 'STAR',
      unsupported: [{ what: 'preseason games', why: 'the NBA ingest drops preseason (nba/ingest/season.js) and no preseason model is validated' }]
    },
    wnba: {
      id: 'wnba', label: 'WNBA', league: 'WNBA', level: 'professional', family: 'basketball', odds_key: 'basketball_wnba', registry_id: 'wnba', schedule_codes: ['wnba'], season_months: [5, 10],
      adapter: 'lab_basketball', lab_league: 'wnba', artifacts: ['basketball/slate.json'], max_age_hours: 30,
      discovery: 'basketball/slate.json (lab engine, league wnba)', providers: ['wehoop / ESPN (third-party)'],
      stats: ['opponent-adjusted points ratings', 'rest and back-to-backs'], availability: 'not modelled (no availability feed)',
      simulation: { method: 'normal margin and total distribution (edgedesk_bb_points_v1)', monte_carlo: false }, markets: ['moneyline', 'spread', 'total'], key_role: 'STAR', unsupported: []
    },
    ncaab_m: {
      id: 'ncaab_m', label: 'Men\'s college basketball', league: 'NCAAM', level: 'college', family: 'basketball', odds_key: 'basketball_ncaab', registry_id: 'ncaab_m', schedule_codes: ['ncaam'], season_months: [11, 4],
      adapter: 'lab_basketball', lab_league: 'ncaam', artifacts: ['basketball/slate.json'], max_age_hours: 30,
      discovery: 'basketball/slate.json (lab engine, league ncaam)', providers: ['hoopR / ESPN (third-party)'],
      stats: ['opponent-adjusted points ratings (adjusted efficiency proxy)', 'home court', 'rest'], availability: 'not modelled (no availability feed)',
      simulation: { method: 'normal margin and total distribution (edgedesk_bb_points_v1)', monte_carlo: false }, markets: ['moneyline', 'spread', 'total'], key_role: 'STAR', unsupported: []
    },
    ncaab_w: {
      id: 'ncaab_w', label: 'Women\'s college basketball', league: 'NCAAW', level: 'college', family: 'basketball', odds_key: 'basketball_wncaab', registry_id: 'ncaab_w', schedule_codes: ['ncaaw'], season_months: [11, 4],
      adapter: 'lab_basketball', lab_league: 'ncaaw', artifacts: ['basketball/slate.json'], max_age_hours: 30,
      discovery: 'basketball/slate.json (lab engine, league ncaaw)', providers: ['wehoop / ESPN (third-party)'],
      stats: ['opponent-adjusted points ratings', 'home court', 'rest'], availability: 'not modelled (no availability feed)',
      simulation: { method: 'normal margin and total distribution (edgedesk_bb_points_v1)', monte_carlo: false }, markets: ['moneyline', 'spread', 'total'], key_role: 'STAR', unsupported: []
    },
    nfl: {
      id: 'nfl', label: 'NFL', league: 'NFL', level: 'professional', family: 'football', odds_key: 'americanfootball_nfl', registry_id: 'nfl', schedule_codes: ['nfl'], season_months: [8, 2],
      adapter: 'nfl', artifacts: ['football/nfl/slate.json', 'football/starters/nfl_2026.json'], max_age_hours: 30,
      discovery: 'nflverse schedule in football/nfl/slate.json, cross-checked with the ESPN scoreboard',
      providers: ['nflverse games, play-by-play, depth charts and injury-report mirror (third-party)', 'ESPN scoreboard (third-party)'],
      stats: ['opponent-adjusted EPA per play, pass and rush', 'quarterback adjustment', 'rest, roof, surface, forecast', 'coaching residuals (research only, not in the price)'],
      availability: 'starting quarterback (schedule feed reconciled against the depth chart and the last game\'s first dropback); the NFL injury report via nflverse',
      simulation: { method: 'margin distribution (spread-conditioned pmf, sigma 10.7) around the engine\'s fair margin', monte_carlo: false },
      markets: ['moneyline', 'spread'], key_role: 'QB',
      unsupported: [{ what: 'totals pricing', why: 'the slate publishes a fair total but no total distribution, so no total probability is derived' }]
    },
    cfb: {
      id: 'cfb', label: 'College football (FBS)', league: 'FBS', level: 'college', family: 'football', odds_key: 'americanfootball_ncaaf', registry_id: 'cfb', schedule_codes: ['cfb'], season_months: [8, 1],
      adapter: 'cfb', artifacts: ['football/fbs/slate.json'], max_age_hours: 30,
      discovery: 'cfbfastR schedule in football/fbs/slate.json (FBS games, including FBS vs FCS), cross-checked with the ESPN scoreboard',
      providers: ['cfbfastR / CollegeFootballData (third-party)', 'ESPN scoreboard (third-party)'],
      stats: ['opponent-adjusted EPA', 'quarterback EPA', 'returning production, talent', 'reliability grade per game'],
      availability: 'previous-game quarterback; operator-entered availability (no official CFB feed)',
      simulation: { method: 'projected margin and win probability (edgedesk_cfb_p4); no published line distribution', monte_carlo: false },
      markets: ['moneyline'], key_role: 'QB',
      unsupported: [{ what: 'spread and total pricing', why: 'the FBS slate publishes fair lines but no cover distribution, so no spread or total probability is derived' }, { what: 'FCS-only games', why: 'no FCS model; FBS-vs-FCS games are on the FBS slate' }]
    },
    soccer: {
      id: 'soccer', label: 'Soccer', league: 'Soccer', level: 'professional', family: 'soccer', odds_key: 'soccer_', registry_id: null, schedule_codes: ['soccer'], season_months: [1, 12],
      adapter: null, artifacts: [], max_age_hours: null, discovery: 'none (removed)', providers: [], stats: [], availability: 'none', simulation: null, markets: [], key_role: null,
      unsupported: [{ what: 'everything', why: 'removed from the platform on 2026-10-15: the soccer model, its data and its slate were deleted (EdgeDesk covers American sports and UFC)' }]
    },
    mlb: {
      id: 'mlb', label: 'MLB', league: 'MLB', level: 'professional', family: 'baseball', odds_key: 'baseball_mlb', registry_id: 'mlb', schedule_codes: ['mlb'], season_months: [3, 11],
      adapter: null, artifacts: [], max_age_hours: null,
      discovery: 'the ESPN scoreboard in today/slate.json (MLB StatsAPI probables in the desk\'s MLB route)', providers: ['ESPN scoreboard', 'MLB StatsAPI (official, probables)'],
      stats: ['probable starters, pitcher features (desk MLB route)'], availability: 'probable starters only (never confirmed)',
      simulation: null, markets: [], key_role: 'SP',
      unsupported: [{ what: 'independent game projection', why: 'no per-game MLB projection is published: the history engine (mlb/history) is walk-forward through 2025 with end-of-2025 ratings and no 2026 or postseason inputs, and the run model (mlb/engine.js) runs in the browser only and is unvalidated' }]
    },
    college_baseball: {
      id: 'college_baseball', label: 'College baseball', league: 'NCAA baseball', level: 'college', family: 'baseball', odds_key: 'baseball_ncaa', registry_id: 'college_baseball', schedule_codes: ['ncaabase'], season_months: [2, 6],
      adapter: null, artifacts: [], max_age_hours: null, discovery: 'college_baseball/board (replay mode until the 2027 schedule is out)', providers: ['NCAA statistics (licensing gate open)'],
      stats: ['cbase_v1 ratings'], availability: 'none', simulation: null, markets: [], key_role: 'SP',
      unsupported: [{ what: 'live projections', why: 'out of season; the model\'s release gates are not passed (college_baseball/validation/release_gates.json: release_allowed false)' }]
    },
    mma: {
      id: 'mma', label: 'UFC / MMA', league: 'UFC', level: 'professional', family: 'combat', odds_key: 'mma_mixed_martial_arts', registry_id: 'mma', schedule_codes: ['mma'], season_months: [1, 12],
      adapter: null, artifacts: [], max_age_hours: null, discovery: 'the ESPN scoreboard (cards) and the ufc.* research tables', providers: ['ESPN', 'UFC fight data (lib/ufc_research.js)'],
      stats: ['fighter records and fight-centre statistics (research tables)'], availability: 'card listings; no late-replacement feed',
      simulation: null, markets: [], key_role: 'FIGHTER',
      unsupported: [{ what: 'independent fight projection', why: 'no fighter model is built: the 2024 Elo test does not beat a coin flip (engine/lab/ufc_elo.json: 138 scored bouts, log loss 0.689 vs 0.693, interval includes zero)' }]
    },
    tennis: {
      id: 'tennis', label: 'Tennis', league: 'ATP/WTA', level: 'professional', family: 'tennis', odds_key: 'tennis_', registry_id: 'tennis', schedule_codes: ['tennis'], season_months: [1, 12],
      adapter: null, artifacts: [], max_age_hours: null, discovery: 'none (retired)', providers: [], stats: [], availability: 'none', simulation: null, markets: [], key_role: null,
      unsupported: [{ what: 'everything', why: 'retired as a product on 2026-09-27 (lib/edgedesk_sports.js)' }]
    },
    golf: {
      id: 'golf', label: 'Golf', league: 'PGA', level: 'professional', family: 'golf', odds_key: 'golf_', registry_id: null, schedule_codes: ['golf'], season_months: [1, 12],
      adapter: null, artifacts: [], max_age_hours: null, discovery: 'none', providers: [], stats: [], availability: 'none', simulation: null, markets: [], key_role: null,
      unsupported: [{ what: 'everything', why: 'no golf data source or model exists in EdgeDesk (golf.html is a partner referral page)' }]
    }
  };
  /* today/slate.json sport codes → registry ids (ESPN feeds) */
  var SCHEDULE_CODE = { nfl: 'nfl', cfb: 'cfb', nba: 'nba', wnba: 'wnba', ncaam: 'ncaab_m', ncaaw: 'ncaab_w', nhl: 'nhl', mlb: 'mlb', ncaabase: 'college_baseball', soccer: 'soccer', mma: 'mma', tennis: 'tennis', golf: 'golf' };

  var NHL_NAMES = { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CAR: 'Carolina Hurricanes', CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils', NSH: 'Nashville Predators', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks', STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WPG: 'Winnipeg Jets', WSH: 'Washington Capitals' };

  /* the market blocks each artifact carries that an adapter must never read (the contamination test scrubs exactly these) */
  var MARKET_FIELDS = {
    'hockey/slate.json': { top: ['quotes_by_game', 'market_statuses'], game: ['market_check'] },
    'nba/slate.json': { top: [], game: ['market', 'decision'] },
    'football/nfl/slate.json': { top: ['pricing', 'market_note'], game: ['reference_market', 'market_status', 'market_note'] },
    'football/fbs/slate.json': { top: ['market_note'], game: ['market_status', 'quote_timestamp', 'spread_recommendation'] },
    'basketball/slate.json': { top: [], game: [] }
  };

  /* ------------------------------------------------------------ helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function r4(v) { v = num(v); return v == null ? null : Math.round(v * 10000) / 10000; }
  function r2(v) { v = num(v); return v == null ? null : Math.round(v * 100) / 100; }
  function clamp01(p) { return Math.max(0, Math.min(1, p)); }
  function fairAm(pw, pp) { pw = num(pw); pp = num(pp) || 0; if (pw == null || !(pw > 0) || pw + pp >= 1) return null; var d = 1 + (1 - pw - pp) / pw; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function slug(s) { return str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }
  function team(name, abbr, id) { return { name: str(name) || str(abbr), abbr: abbr ? str(abbr) : null, id: id != null ? str(id) : null }; }
  function ageHours(at, now) { var t = toMs(at); return t == null ? null : Math.round((now - t) / 360000) / 10; }

  /* ---------------------------------------------- SHA-256 (sync, UTF-8) */
  var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256(text) {
    var bytes = [], s = unescape(encodeURIComponent(str(text)));
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    var bitLen = bytes.length * 8;
    bytes.push(0x80); while (bytes.length % 64 !== 56) bytes.push(0);
    for (var k = 7; k >= 0; k--) bytes.push(k > 3 ? 0 : (bitLen >>> (k * 8)) & 0xff);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) W[t] = (bytes[off + 4 * t] << 24) | (bytes[off + 4 * t + 1] << 16) | (bytes[off + 4 * t + 2] << 8) | bytes[off + 4 * t + 3];
      for (t = 16; t < 64; t++) { var x = W[t - 15], y = W[t - 2]; var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3); var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10); W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0; }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K256[t] + W[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (v) { return ('00000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
  }
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------- validation (engine/registry.json) */
  function registryMarket(registry, regId, market, competition) {
    if (!registry || !Array.isArray(registry.sports)) return null;
    var s = registry.sports.filter(function (x) { return x.id === regId; })[0];
    if (!s || !s.readiness || !s.readiness.markets) return null;
    var key = market === 'three_way' ? 'moneyline' : market;
    var m = (competition ? s.readiness.markets[competition + '.' + key] : null) || s.readiness.markets[key] || null;
    if (!m) return null;
    var head = str(m.headline);
    var ll = /log loss ([0-9.]+)/.exec(head), off = /off the observed rate by ([0-9.]+)|off by more than ([0-9.]+)/.exec(head);
    return { state: m.state, outcome: m.outcome || null, market_test: m.market || null, value_claims: m.value_claims === true, n: num(m.n), held_out_log_loss: ll ? num(ll[1]) : null,
      calibration_offset: off ? num(off[1] || off[2]) : null, headline: head || null, reason: m.reason || null, file: m.file || null, source: 'engine/registry.json' };
  }
  function validationBlock(registry, regId, markets, competition, extra) {
    var out = { source: 'engine/registry.json', generated_at: registry ? registry.generated_at || null : null, markets: {} };
    markets.forEach(function (m) { out.markets[m] = registryMarket(registry, regId, m, competition) || { state: 'UNAVAILABLE', value_claims: false, reason: registry ? 'no readiness record for this market' : 'engine/registry.json was not read' }; });
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /* ================================================================ */
  /* 2. THE CONTRACT                                                   */
  /* ================================================================ */
  function base(sp, o) {
    return {
      schema: CONTRACT, projection_id: null, projection_hash: null, frozen_at: null,
      sport: sp.id, sport_label: sp.label, league: o.league || sp.league, competition: o.competition || null, odds_key: o.odds_key || sp.odds_key,
      event_id: str(o.event_id), event_key: o.event_key || (sp.id + '|' + str(o.event_id)), start_utc: iso(o.start_utc), start_basis: o.start_basis || 'the artifact\'s UTC start',
      home: o.home, away: o.away, venue: o.venue || null, neutral: !!o.neutral,
      model: Object.assign({ kind: 'INDEPENDENT', market_inputs: [] }, o.model),
      outcome: o.outcome, fair: o.fair, projected_score: o.projected_score || null,
      distribution: o.distribution || { spread_lines: [], total_lines: [] }, simulation: o.simulation || null,
      uncertainty: o.uncertainty, validation: o.validation, availability: o.availability, matchup: o.matchup || { factors: [] }, context: o.context || null,
      provenance: o.provenance || [], freshness: o.freshness, invalidators: o.invalidators || [], limitations: o.limitations || [], integrity: o.integrity || { invalidated: false, conflicts: [] },
      /* the engine's own re-runs with one input changed (a goalie, a player sitting, a quarterback out): how far the number moves */
      sensitivity: o._sensitivity || [],
      markets_supported: o.markets_supported || sp.markets.slice()
    };
  }
  function freshnessOf(sp, generatedAt, now, extra) {
    var age = ageHours(generatedAt, now);
    var st = age == null ? 'UNKNOWN' : sp.max_age_hours != null && age > sp.max_age_hours ? 'EXPIRED' : 'FRESH';
    return Object.assign({ artifact_generated_at: iso(generatedAt), age_hours: age, max_age_hours: sp.max_age_hours, state: st,
      why: st === 'EXPIRED' ? 'the model build is ' + age + ' h old against a ' + sp.max_age_hours + ' h limit' : st === 'UNKNOWN' ? 'the artifact carries no build time' : 'built ' + age + ' h ago (limit ' + sp.max_age_hours + ' h)' }, extra || {});
  }
  function sigmaCal(v) {
    if (!v) return SIGMA.calibration_by_state.RESEARCH_ONLY;
    var d = SIGMA.calibration_by_state[v.state] != null ? SIGMA.calibration_by_state[v.state] : SIGMA.calibration_by_state.RESEARCH_ONLY;
    return v.calibration_offset != null ? Math.max(d, v.calibration_offset) : d;
  }

  /* a local date and time in an IANA zone → UTC ISO (DST-aware: the offset is re-read at the converted instant) */
  function zonedToUtc(date, time, tz) {
    if (!date) return null;
    var hm = /^(\d{1,2}):(\d{2})/.exec(str(time || '12:00')) || ['', '12', '00'];
    var guess = Date.parse(date + 'T' + ('0' + hm[1]).slice(-2) + ':' + hm[2] + ':00Z');
    if (!isFinite(guess)) return null;
    function offMin(ms) { try { var p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(ms)); var z = (p.filter(function (x) { return x.type === 'timeZoneName'; })[0] || {}).value || 'GMT'; var m = /GMT([+-]\d+)(?::(\d+))?/.exec(z); return m ? Number(m[1]) * 60 + (m[1][0] === '-' ? -1 : 1) * Number(m[2] || 0) : 0; } catch (_) { return 0; } }
    var o1 = offMin(guess), t = guess - o1 * 60000, o2 = offMin(t);
    return new Date(guess - o2 * 60000).toISOString();
  }

  /* ================================================================ */
  /* 3. THE ADAPTERS — one per published engine                        */
  /* ================================================================ */
  var ADAPTERS = {};

  /* NHL — hockey/slate.json (edgedesk_nhl_slate_v1) */
  ADAPTERS.nhl = function (A, ctx) {
    var sp = SPORTS.nhl, s = A['hockey/slate.json'], out = [], now = ctx.now;
    if (!s || s.schema !== 'edgedesk_nhl_slate_v1' || !Array.isArray(s.games)) return { projections: [], error: 'hockey/slate.json missing or not edgedesk_nhl_slate_v1' };
    var rd = s.readiness || {};
    s.games.forEach(function (g) {
      var pr = g.prices || {}, ml = pr.moneyline || {};
      if (num(ml.home) == null) return;
      var spreadLines = [], totalLines = [];
      var pl = pr.puck_line || {};
      if (num(pl.home_minus_1_5) != null) spreadLines.push({ home_line: -1.5, home: num(pl.home_minus_1_5), away: num(pl.away_plus_1_5), push: 0 });
      if (num(pl.home_plus_1_5) != null) spreadLines.push({ home_line: 1.5, home: num(pl.home_plus_1_5), away: num(pl.away_minus_1_5), push: 0 });
      /* the engine's per-line markets add lines AND their own validation word; a line already read from
         prices keeps that validation too (a PROVISIONAL line never prices on the market's tier) */
      ((g.markets && g.markets.puck_line) || []).forEach(function (x) {
        var hl = num(x.home_line); if (hl == null) return;
        var ex = spreadLines.filter(function (y) { return y.home_line === hl; })[0];
        if (ex) { if (x.validation && !ex.validation) ex.validation = x.validation; return; }
        spreadLines.push({ home_line: hl, home: num(x.p), away: num(x.p_other), push: num(x.push) || 0, validation: x.validation || null });
      });
      var tl = (pr.total && pr.total.lines) || {};
      Object.keys(tl).forEach(function (L) { totalLines.push({ line: num(L), over: num(tl[L].over), under: num(tl[L].under), push: num(tl[L].push) || 0 }); });
      ((g.markets && g.markets.total) || []).forEach(function (x) {
        var ln = num(x.line); if (ln == null) return;
        var ex = totalLines.filter(function (y) { return y.line === ln; })[0];
        if (ex) { if (x.validation && !ex.validation) ex.validation = x.validation; return; }
        totalLines.push({ line: ln, over: num(x.p), under: num(x.p_other), push: num(x.push) || 0, validation: x.validation || null });
      });
      var unc = g.uncertainty || {}, bin = unc.calibration_bin || null;
      var val = validationBlock(ctx.registry, 'nhl', ['moneyline', 'spread', 'total'], null, { record: s.record && s.record.moneyline ? { moneyline: { n: s.record.moneyline.n, brier: s.record.moneyline.brier, log_loss: s.record.moneyline.log_loss, calibration_slope: s.record.moneyline.calibration_slope, file: 'hockey/validation/nhl_walkforward.json' } } : null });
      if (rd.model) Object.keys(rd.model).forEach(function (k) { var key = k === 'puck_line' ? 'spread' : k; if (val.markets[key] && val.markets[key].state === 'UNAVAILABLE') val.markets[key] = { state: rd.model[k].status === 'OUTCOME_VALIDATED' ? 'OUTCOME_VALIDATED' : 'EXPERIMENTAL', value_claims: false, reason: 'hockey/slate.json readiness', source: 'hockey/slate.json' }; });
      /* calibration from the game's own probability bin: the Wilson half-width as a standard error, and the bin's bias */
      var binSe = bin && bin.wilson95 ? (num(bin.wilson95[1]) - num(bin.wilson95[0])) / (2 * 1.96) : null;
      var binBias = bin ? Math.abs((num(bin.observed) || 0) - (num(bin.model_mean) || 0)) : null;
      var calSd = binSe != null ? Math.sqrt(binSe * binSe + binBias * binBias) : sigmaCal(val.markets.moneyline);
      var gc = (g.goalies && g.goalies.certainty) || 'UNKNOWN';
      var scen = (g.goalies && g.goalies.scenarios) || [];
      var gRange = scen.length ? [Math.min.apply(null, scen.map(function (x) { return num(x.p_home); })), Math.max.apply(null, scen.map(function (x) { return num(x.p_home); }))] : null;
      var ev = g.evidence || {}, cx = g.context || {};
      var factors = ((g.explanation && g.explanation.factors) || []).map(function (f) { return { label: f.label, team: f.team || null, side: f.side || null, pp_toward_home: r4(f.pp), unit: 'percentage points of home win probability (exact Shapley decomposition)', evidence: f.evidence || null }; });
      var homeName = NHL_NAMES[g.home] || g.home, awayName = NHL_NAMES[g.away] || g.away;
      out.push(base(sp, {
        event_id: g.game_id, event_key: g.event_key, start_utc: g.start_utc, venue: g.venue,
        home: team(homeName, g.home), away: team(awayName, g.away),
        model: { id: (s.model && s.model.id) || 'edgedesk_nhl_v1', version: (s.model && s.model.chosen) || null, artifact: 'hockey/slate.json', artifact_generated_at: iso(s.generated_at), predicted_at: iso(s.generated_at), params_generated_at: s.model ? iso(s.model.params_generated_at) : null, inputs_known_at: rd.data && rd.data.latest_completed_game ? rd.data.latest_completed_game : null },
        outcome: { p_home: num(ml.home), p_away: num(ml.away), p_draw: null, settles: ml.settles || 'includes overtime and shootout', p_overtime: num(pr.p_overtime), p_shootout: num(pr.p_shootout),
          regulation_3way: pr.regulation ? { home: num(pr.regulation.home), draw: num(pr.regulation.draw), away: num(pr.regulation.away), state: 'PROVISIONAL' } : null },
        /* the NHL engine prices the fixed ±1.5 puck line; it publishes no fair spread line, so none is stated */
        fair: { moneyline: { home: num(ml.fair_home), away: num(ml.fair_away) }, spread: { home_line: null, priced_line: { home_line: -1.5, home_american: num(pl.fair_home_minus_1_5), away_american: num(pl.fair_away_plus_1_5) } }, total: { line: num(pr.total && pr.total.fair_line), expected: num(pr.total && pr.total.expected) } },
        projected_score: { home: num(g.lambda && g.lambda.home), away: num(g.lambda && g.lambda.away), total: num(pr.total && pr.total.expected), basis: 'expected regulation goals per team (λ) and the expected total including overtime' },
        distribution: { kind: 'exact_score_distribution', spread_lines: spreadLines, total_lines: totalLines },
        simulation: { method: sp.simulation.method, monte_carlo: false, simulations: null, convergence: 'exact enumeration: no Monte Carlo error' },
        uncertainty: { model_sd: num(unc.moneyline_sd_pp) != null ? num(unc.moneyline_sd_pp) / 100 : SIGMA.model_default, calibration_sd: r4(calSd), lineup_sd: SIGMA.lineup[gc] != null ? SIGMA.lineup[gc] : SIGMA.lineup.UNKNOWN,
          margin_sd: null, intervals: null, goalie_range_p_home: gRange ? [r4(gRange[0]), r4(gRange[1])] : null, calibration_bin: bin,
          basis: 'model_sd: spread of the home probability across the validated variants (hockey/slate.json uncertainty); calibration_sd: the game\'s probability bin out of sample (Wilson half-width and bias); lineup_sd: goalie certainty ' + gc },
        validation: val,
        availability: { key_role: 'G', certainty: gc, confirmed_source: g.goalies ? g.goalies.confirmed_source || null : null,
          home: { goalies: ((g.goalies && g.goalies.home) || []).map(function (x) { return { name: x.name, p_start: num(x.p_start), confirmed: !!x.confirmed, gsax_rate: num(x.gsax_rate) }; }), absent_regulars: ((g.lineups && g.lineups.home && g.lineups.home.regulars_absent) || []).map(function (x) { return x.name; }) },
          away: { goalies: ((g.goalies && g.goalies.away) || []).map(function (x) { return { name: x.name, p_start: num(x.p_start), confirmed: !!x.confirmed, gsax_rate: num(x.gsax_rate) }; }), absent_regulars: ((g.lineups && g.lineups.away && g.lineups.away.regulars_absent) || []).map(function (x) { return x.name; }) },
          lineup_state: g.lineups ? g.lineups.state : null, injuries: 'no injury feed: absences are read from the last game\'s lineup', conflicts: [] },
        matchup: { factors: factors, metrics: { home: ev.home || null, away: ev.away || null, league: ev.league || null } },
        context: { home: { rest_days: ev.home ? num(ev.home.rest_days) : null, back_to_back: ev.home ? !!ev.home.back_to_back : null, travel_km: cx.home ? num(cx.home.travel_km) : null, tz_shift: cx.home ? num(cx.home.tz_shift) : null }, away: { rest_days: ev.away ? num(ev.away.rest_days) : null, back_to_back: ev.away ? !!ev.away.back_to_back : null, travel_km: cx.away ? num(cx.away.travel_km) : null, tz_shift: cx.away ? num(cx.away.tz_shift) : null }, note: cx.note || null },
        provenance: [
          { what: 'schedule', source: g.schedule_source === 'nhl_api' ? 'NHL API (api-web.nhle.com)' : 'sportsdataverse NHL schedule', authority: g.schedule_source === 'nhl_api' ? 'OFFICIAL' : 'THIRD_PARTY', url: rd.data && rd.data.schedule ? rd.data.schedule.url : null, retrieved_at: rd.data && rd.data.schedule ? iso(rd.data.schedule.fetched_at) : null },
          { what: 'projection', source: 'hockey/slate.json (edgedesk_nhl_v1)', authority: 'EDGEDESK_MODEL', retrieved_at: iso(s.generated_at) }
        ],
        freshness: freshnessOf(sp, s.generated_at, now, { data_state: rd.data ? rd.data.state : null, latest_result: rd.data ? rd.data.latest_completed_game : null }),
        invalidators: (g.invalidators || []).slice(0, 6),
        limitations: [].concat((g.data_quality && g.data_quality.missing) || [], g.data_quality && g.data_quality.early_season ? ['early season: ratings lean on last season'] : [], ['totals are PROVISIONAL (calibration slope 0.78): no total is priced as an edge']),
        markets_supported: ['moneyline', 'spread', 'total'],
        _sensitivity: gRange ? [{ what: 'starting goalie', range_p_home: [r4(gRange[0]), r4(gRange[1])], basis: 'hockey/slate.json goalie scenarios' }] : []
      }));
    });
    return { projections: out, error: null, model: { id: s.model && s.model.id, generated_at: s.generated_at } };
  };

  /* NBA — nba/slate.json (edgedesk_nba_slate_v1), validation nba/validation/summary.json */
  ADAPTERS.nba = function (A, ctx) {
    var sp = SPORTS.nba, s = A['nba/slate.json'], sum = A['nba/validation/summary.json'], out = [], now = ctx.now;
    if (!s || s.schema !== 'edgedesk_nba_slate_v1' || !Array.isArray(s.games)) return { projections: [], error: 'nba/slate.json missing or not edgedesk_nba_slate_v1' };
    var chosen = s.model && s.model.chosen || null;
    var test = sum && sum.windows && sum.windows.test ? sum.windows.test[chosen] || null : null;
    var homeOnly = sum && sum.windows && sum.windows.test ? sum.windows.test.home_only || null : null;
    s.games.forEach(function (g) {
      var p = g.price || {}, ml = p.moneyline || {};
      if (num(ml.home) == null) return;
      var spreadLines = [], totalLines = [];
      ((p.spread && p.spread.ladder) || []).concat(p.spread && p.spread.main ? [p.spread.main] : []).forEach(function (x) { if (num(x.line_home) != null && !spreadLines.some(function (y) { return y.home_line === num(x.line_home); })) spreadLines.push({ home_line: num(x.line_home), home: num(x.win), away: num(x.lose), push: num(x.push) || 0 }); });
      ((p.total && p.total.ladder) || []).concat(p.total && p.total.main ? [p.total.main] : []).forEach(function (x) { if (num(x.line) != null && x.over && !totalLines.some(function (y) { return y.line === num(x.line); })) totalLines.push({ line: num(x.line), over: num(x.over.win), under: num(x.under ? x.under.win : x.over.lose), push: num(x.over.push) || 0 }); });
      var val = validationBlock(ctx.registry, 'nba', ['moneyline', 'spread', 'total'], null, {
        engine_record: test ? { window: 'test (held out, unsealed once)', model: chosen, n: test.n, log_loss: test.ml_log_loss, brier: test.brier, calibration_slope: test.slope, margin_crps: test.margin_crps, baseline_home_only_log_loss: homeOnly ? homeOnly.ml_log_loss : null, file: 'nba/validation/summary.json' } : (s.model && s.model.record ? { window: 'selection', model: chosen, n: s.model.record.selection && s.model.record.selection.n, log_loss: s.model.record.selection && s.model.record.selection.ml_log_loss, brier: s.model.record.selection && s.model.record.selection.brier, file: s.model.record_file } : null)
      });
      /* the nba/ engine's own market statuses override the lab's registry row for these three markets */
      if (sum && sum.markets && sum.markets.P) ['moneyline', 'spread', 'total'].forEach(function (k) { var m = sum.markets.P[k]; if (m) val.markets[k] = Object.assign({}, val.markets[k] || {}, { state: m.status === 'OUTCOME_VALIDATED' ? 'OUTCOME_VALIDATED' : 'EXPERIMENTAL', market_test: m.market_status, value_claims: false, reason: m.market_reason || (val.markets[k] && val.markets[k].reason), source: 'nba/validation/summary.json' }); });
      var unc = g.uncertainty || {}, av = g.availability || {}, mu = g.matchup || {};
      var factors = (g.explanation || []).map(function (f) { return { label: f.label, team: null, side: (num(f.points_toward_home) || 0) >= 0 ? 'home' : 'away', points_toward_home: r2(f.points_toward_home), unit: 'points of home margin (ridge contribution)' }; });
      var sens = (g.scenarios || []).map(function (x) { return { what: x.player + ' ' + x.kind + ' (' + x.team + ')', delta_p_home: r4(x.delta_p_home) }; });
      out.push(base(sp, {
        event_id: g.game_id, event_key: 'NBA|' + g.game_id, start_utc: g.start_utc, neutral: !!g.neutral,
        home: team(g.home && g.home.name, g.home && g.home.abbr, g.home && g.home.id), away: team(g.away && g.away.name, g.away && g.away.abbr, g.away && g.away.id),
        model: { id: 'edgedesk_nba_v1:' + str(g.model || chosen), version: p.version || null, artifact: 'nba/slate.json', artifact_generated_at: iso(s.generated_at), predicted_at: iso(g.predicted_at || s.generated_at), params_generated_at: s.model ? iso(s.model.live_params_generated_at) : null, inputs_known_at: iso(g.inputs_known_at), spec_hash: s.model ? s.model.spec_hash || null : null },
        outcome: { p_home: num(ml.home), p_away: num(ml.away), p_draw: null, settles: ml.settles || 'includes overtime', p_overtime: num(p.p_overtime) },
        fair: { moneyline: { home: num(ml.home_american), away: num(ml.away_american) }, spread: { home_line: num(p.spread && p.spread.fair_line_home) }, total: { line: num(p.total && p.total.fair_line), expected: num(p.expected && p.expected.total) } },
        projected_score: p.expected ? { home: num(p.expected.home), away: num(p.expected.away), margin: num(p.expected.margin), total: num(p.expected.total), basis: 'expected points (edgedesk_nba_dist_v1)' } : null,
        distribution: { kind: 'margin_and_total_distribution', spread_lines: spreadLines, total_lines: totalLines },
        simulation: { method: sp.simulation.method, monte_carlo: false, simulations: null, convergence: 'closed-form distribution: no Monte Carlo error' },
        uncertainty: { model_sd: num(unc.model_disagreement_sd) != null ? num(unc.model_disagreement_sd) : (g.disagreement ? num(g.disagreement.sd_p_home) : SIGMA.model_default), calibration_sd: sigmaCal(val.markets.moneyline), lineup_sd: SIGMA.lineup.UNKNOWN,
          margin_sd: num(unc.margin_sd), intervals: { margin_80: unc.margin_interval_80 || null, total_80: unc.total_interval_80 || null }, early_season: !!unc.early_season, rotation_stale: !!unc.rotation_stale,
          basis: 'model_sd: spread of the home probability across the 12 candidate models; calibration_sd: the registry state of the moneyline; lineup_sd: UNKNOWN (no injury report or confirmed lineup is in the price)' },
        validation: val,
        availability: { key_role: 'STAR', certainty: 'UNKNOWN',
          home: { likely_starters: (av.home && av.home.likely_starters) || [], absent_regulars: ((av.home && av.home.absent_regulars) || []).map(function (x) { return x.name; }), rotation_source: av.home ? av.home.rotation_source : null },
          away: { likely_starters: (av.away && av.away.likely_starters) || [], absent_regulars: ((av.away && av.away.absent_regulars) || []).map(function (x) { return x.name; }), rotation_source: av.away ? av.away.rotation_source : null },
          injuries: 'no injury report is in the price; the rotation is the last game played', conflicts: [] },
        matchup: { factors: factors, metrics: { pace: num(mu.pace), league_pace: num(mu.league_pace), home_offence_vs_away_defence: num(mu.home_offence_vs_away_defence), away_offence_vs_home_defence: num(mu.away_offence_vs_home_defence), league_efficiency: num(mu.league_efficiency), four_factors: mu.four_factors || null, shooting_luck: mu.shooting_luck || null } },
        context: mu.schedule ? { home: mu.schedule.home || null, away: mu.schedule.away || null } : null,
        provenance: [{ what: 'schedule and box scores', source: 'hoopR / ESPN (nba/data)', authority: 'THIRD_PARTY', url: s.rosters ? s.rosters.url || null : null, retrieved_at: s.rosters ? iso(s.rosters.fetched_at) : null }, { what: 'projection', source: 'nba/slate.json (edgedesk_nba_v1)', authority: 'EDGEDESK_MODEL', retrieved_at: iso(s.generated_at) }],
        freshness: freshnessOf(sp, s.generated_at, now, { inputs_known_at: iso(g.inputs_known_at) }),
        invalidators: (g.reasons_to_pass || []).slice(0, 4),
        limitations: [].concat(unc.notes || []),
        markets_supported: ['moneyline', 'spread', 'total'],
        _sensitivity: sens.slice(0, 4)
      }));
    });
    return { projections: out, error: null, model: { id: 'edgedesk_nba_v1:' + chosen, generated_at: s.generated_at } };
  };

  /* WNBA / NCAAM / NCAAW (and NBA as a fallback) — basketball/slate.json (edgedesk_lab_slate_v1) */
  ADAPTERS.lab_basketball = function (A, ctx, sp) {
    var s = A['basketball/slate.json'], out = [], now = ctx.now;
    if (!s || s.schema !== 'edgedesk_lab_slate_v1' || !s.leagues) return { projections: [], error: 'basketball/slate.json missing or not edgedesk_lab_slate_v1' };
    var L = s.leagues[sp.lab_league];
    if (!L) return { projections: [], error: 'basketball/slate.json has no ' + sp.lab_league + ' league' };
    (L.games || []).forEach(function (g) {
      var pr = g.prices || {}, ml = pr.moneyline || {};
      if (num(ml.home) == null) return;
      var spreadLines = Object.keys((pr.spread && pr.spread.lines) || {}).map(function (k) { var x = pr.spread.lines[k]; return { home_line: num(k), home: num(x.home_cover), away: num(x.away_cover), push: num(x.push) || 0 }; });
      var totalLines = Object.keys((pr.total && pr.total.lines) || {}).map(function (k) { var x = pr.total.lines[k]; return { line: num(k), over: num(x.over), under: num(x.under), push: num(x.push) || 0 }; });
      var val = validationBlock(ctx.registry, sp.registry_id, ['moneyline', 'spread', 'total']);
      var pm = num(pr.spread && pr.spread.projected_margin), pt = num(pr.total && pr.total.projected);
      out.push(base(sp, {
        event_id: g.game_id, event_key: g.event_key, start_utc: g.start_utc, neutral: !!g.neutral,
        home: team(g.home, null, g.home_id), away: team(g.away, null, g.away_id),
        model: { id: 'edgedesk_bb_points_v1:' + str(L.model), version: L.model || null, artifact: 'basketball/slate.json', artifact_generated_at: iso(s.generated_at), predicted_at: iso(s.generated_at), params_generated_at: iso(L.params_generated_at), inputs_known_at: L.ratings_through || L.latest_result || null },
        outcome: { p_home: num(ml.home), p_away: num(ml.away), p_draw: null, settles: ml.settles || 'including overtime' },
        fair: { moneyline: { home: num(ml.fair_home), away: num(ml.fair_away) }, spread: { home_line: num(pr.spread && pr.spread.fair_home_line) }, total: { line: num(pr.total && pr.total.fair_line), expected: pt } },
        projected_score: pm != null && pt != null ? { home: r2((pt + pm) / 2), away: r2((pt - pm) / 2), margin: pm, total: pt, basis: 'projected margin and total (edgedesk_bb_points_v1)' } : null,
        distribution: { kind: 'normal_margin_and_total', spread_lines: spreadLines, total_lines: totalLines },
        simulation: { method: sp.simulation.method, monte_carlo: false, simulations: null, convergence: 'closed-form distribution: no Monte Carlo error' },
        uncertainty: { model_sd: SIGMA.model_default, calibration_sd: sigmaCal(val.markets.moneyline), lineup_sd: SIGMA.lineup.UNKNOWN, basis: 'model_sd: the board default (the lab slate publishes no per-game spread); calibration_sd: registry state; lineup_sd: UNKNOWN (no availability feed)' },
        validation: val,
        availability: { key_role: 'STAR', certainty: 'UNKNOWN', home: {}, away: {}, injuries: 'availability is not modelled', conflicts: [] },
        matchup: { factors: [], metrics: { back_to_back: g.inputs ? g.inputs.back_to_back : null, games_this_season: g.inputs ? g.inputs.games_this_season : null } },
        provenance: [{ what: 'projection', source: 'basketball/slate.json (' + sp.lab_league + ')', authority: 'EDGEDESK_MODEL', retrieved_at: iso(s.generated_at) }],
        freshness: freshnessOf(sp, s.generated_at, now),
        invalidators: g.invalidators || [], limitations: g.data_quality && g.data_quality.early_season ? ['early season: ratings lean on last season'] : [],
        markets_supported: ['moneyline', 'spread', 'total']
      }));
    });
    return { projections: out, error: null, model: { id: 'edgedesk_bb_points_v1:' + str(L.model), generated_at: s.generated_at }, note: (L.games || []).length ? null : L.note || null, next_game: L.next_game || null };
  };


  /* NFL — football/nfl/slate.json; the starter the projection priced is checked against football/starters/nfl_<season>.json */
  /**
   * The quarterback the projection assumed against the depth chart and the last game's first dropback.
   * A disagreement is never resolved silently: it is a CONFLICT on the projection, with both sources and
   * their times, and the projection may not be priced until the engine is re-run on the current starter.
   */
  function nflStarterCheck(g, side, starters) {
    var priced = g[side + '_starter'] || null;
    var code = str(g[side + '_team_id'] || g[side + '_code']).toLowerCase();
    var cur = starters && starters.teams ? starters.teams[code] : starters ? starters[code] : null;
    if (!priced) return { status: 'NO_STARTER_ASSUMED', side: side };
    if (!cur || !cur.player_name) return { status: 'NOT_CHECKED', side: side, assumed: { name: priced.player_name, source: priced.source, status: priced.status }, why: 'no depth-chart record for ' + str(g[side + '_code']) };
    var same = (priced.player_id && cur.player_id && str(priced.player_id) === str(cur.player_id)) || slug(priced.player_name) === slug(cur.player_name);
    var hist = (cur.history || []).filter(function (h) { return h && h.settled && h.starter; });
    var last = hist.length ? hist[hist.length - 1] : null;
    var lastStarter = last ? { name: last.starter.player_name, week: last.week, game_id: last.game_id, why: last.why || null } : null;
    var view = { status: same ? 'AGREES' : 'CONFLICT', side: side, team: str(g[side + '_code']),
      assumed: { name: priced.player_name, player_id: priced.player_id || null, source: priced.source || null, status: priced.status || null, authority: authorityOf(priced.source) },
      current: { name: cur.player_name, player_id: cur.player_id || null, source: cur.source || null, status: cur.status || null, published_at: cur.published_at || null, retrieved_at: cur.retrieved_at || null, authority: authorityOf(cur.source), announced: !!cur.announced, confirmed: !!cur.confirmed },
      last_game_starter: lastStarter };
    if (!same) {
      var corroborated = lastStarter && (slug(lastStarter.name).indexOf(slug(str(cur.player_name).split(' ').slice(-1)[0])) >= 0);
      view.corroborated_by_last_game = !!corroborated;
      view.detail = str(g[side + '_team']) + ': the projection assumed ' + priced.player_name + ' (' + (priced.source || 'unknown source') + ', ' + (priced.status || 'no status') + ') but ' + (cur.source || 'the depth chart') + ' lists ' + cur.player_name + ' as QB1' + (cur.published_at ? ' (published ' + cur.published_at + ')' : '') + (corroborated ? ' and ' + cur.player_name + ' took the first dropback of week ' + lastStarter.week : '');
    }
    return view;
  }
  ADAPTERS.nfl = function (A, ctx) {
    var sp = SPORTS.nfl, s = A['football/nfl/slate.json'], starters = A['football/starters/nfl_2026.json'] || A['football/starters/nfl.json'] || null, out = [], now = ctx.now;
    if (!s || !Array.isArray(s.games)) return { projections: [], error: 'football/nfl/slate.json missing' };
    var eng = s.engine || {};
    s.games.forEach(function (g) {
      if (g.model_status !== 'PREDICTED' || num(g.model_home_win_prob) == null) return;
      var spreadLines = (g.cover_curve || []).map(function (c) { return { home_line: num(c.home_line), home: num(c.win), away: num(c.lose), push: num(c.push) || 0 }; });
      var val = validationBlock(ctx.registry, 'nfl', ['moneyline', 'spread'], null, { engine_self_report: eng.validation ? { tier: eng.validation.tier || null, may_produce_probability: eng.validation.may_produce_probability, note: 'football/params.js validation_summary (stricter than the registry): it is shown so the disagreement between the two files is visible' } : null });
      var checks = [nflStarterCheck(g, 'home', starters), nflStarterCheck(g, 'away', starters)];
      var conflicts = checks.filter(function (c) { return c.status === 'CONFLICT'; });
      var qbScen = g.scenarios || {};
      var sens = [];
      if (qbScen.home_qb_out) sens.push({ what: str(g.home_code) + ' quarterback replaced by the club\'s carried level', delta_home_line: num(qbScen.home_qb_out.delta_home_line), p_home: num(qbScen.home_qb_out.home_win_prob) });
      if (qbScen.away_qb_out) sens.push({ what: str(g.away_code) + ' quarterback replaced by the club\'s carried level', delta_home_line: num(qbScen.away_qb_out.delta_home_line), p_home: num(qbScen.away_qb_out.home_win_prob) });
      var contrib = ((g.contributions && g.contributions.spread) || []).filter(function (c) { return c.key !== 'baseline'; }).map(function (c) { return { label: c.key.replace(/_/g, ' '), value: num(c.value), points_toward_home: num(c.points), unit: 'points of home margin' }; });
      var qbCert = conflicts.length ? 'CONFLICTING' : checks.every(function (c) { return c.current && c.current.confirmed; }) ? 'CONFIRMED' : 'PROJECTED_LIKELY';
      out.push(base(sp, {
        event_id: g.game_id, event_key: 'NFL|' + g.game_id, start_utc: g.kickoff, venue: g.venue,
        home: team(g.home_team, g.home_code, g.home_team_id), away: team(g.away_team, g.away_code, g.away_team_id),
        model: { id: eng.model_version || 'edgedesk_football_v1', version: eng.feature_version || null, artifact: 'football/nfl/slate.json', artifact_generated_at: iso(s.generated_at), predicted_at: iso(s.generated_at), params_generated_at: iso(eng.built_at), trained_through: eng.trained_through || null },
        outcome: { p_home: num(g.model_home_win_prob), p_away: r4(1 - num(g.model_home_win_prob)), p_draw: null, settles: 'includes overtime (a tie grades by house rule)' },
        fair: { moneyline: { home: num(g.model_fair_home_ml), away: num(g.model_fair_away_ml) }, spread: { home_line: num(g.model_home_line) }, total: { line: num(g.model_fair_total), expected: num(g.model_fair_total) } },
        projected_score: { home: num(g.model_fair_total) != null && num(g.model_home_margin) != null ? r2((num(g.model_fair_total) + num(g.model_home_margin)) / 2) : null, away: num(g.model_fair_total) != null && num(g.model_home_margin) != null ? r2((num(g.model_fair_total) - num(g.model_home_margin)) / 2) : null, margin: num(g.model_home_margin), total: num(g.model_fair_total), basis: 'the engine\'s fair margin and fair total' },
        distribution: { kind: 'margin_pmf', spread_lines: spreadLines, total_lines: [], margin: g.outcome_range || null, shape_note: 'the margin distribution\'s shape was fitted on historical closing spreads and re-centred on the model\'s own margin; no current price enters it' },
        simulation: { method: sp.simulation.method, monte_carlo: false, simulations: null, convergence: 'closed-form pmf: no Monte Carlo error' },
        uncertainty: { model_sd: SIGMA.model_default, calibration_sd: sigmaCal(val.markets.moneyline), lineup_sd: conflicts.length ? SIGMA.starter_conflict : SIGMA.lineup[qbCert] != null ? SIGMA.lineup[qbCert] : SIGMA.lineup.UNKNOWN,
          margin_sd: g.outcome_range ? num(g.outcome_range.sigma) : null, intervals: g.outcome_range ? { margin_p10_p90: [num(g.outcome_range.p10), num(g.outcome_range.p90)] } : null,
          basis: 'model_sd: the board default for football; calibration_sd: the moneyline\'s measured calibration offset (engine/registry.json); lineup_sd: ' + (conflicts.length ? 'a starting-quarterback conflict' : 'quarterback ' + qbCert.toLowerCase().replace(/_/g, ' ')) },
        validation: val,
        availability: { key_role: 'QB', certainty: qbCert, home: { starter: checks[0] }, away: { starter: checks[1] }, injuries: 'the NFL injury report as mirrored by nflverse (third-party mirror of an official report): ' + ((g.data_quality && g.data_quality.warnings) || []).length + ' warning(s) on this game', conflicts: conflicts.map(function (c) { return c.detail; }) },
        matchup: { factors: contrib, metrics: g.features ? { spread: g.features.spread || null } : null },
        context: { home: { rest_days: num(g.home_rest) }, away: { rest_days: num(g.away_rest) }, roof: g.roof || null, surface: g.surface || null, div_game: !!g.div_game },
        provenance: [
          { what: 'schedule and the schedule feed\'s quarterback columns', source: 'nflverse games.csv', authority: 'THIRD_PARTY', url: 'https://github.com/nflverse/nfldata/blob/master/data/games.csv' },
          { what: 'depth chart and first-dropback history', source: starters ? 'football/starters (nflverse depth charts + play-by-play)' : 'not read', authority: 'THIRD_PARTY', retrieved_at: starters ? iso(starters.generated_at) : null },
          { what: 'projection', source: 'football/nfl/slate.json (' + (eng.model_version || 'edgedesk_football') + ')', authority: 'EDGEDESK_MODEL', retrieved_at: iso(s.generated_at) }
        ],
        freshness: freshnessOf(sp, s.generated_at, now),
        invalidators: ['A quarterback change.'].concat(((g.data_quality && g.data_quality.warnings) || []).slice(0, 3).map(function (w) { return typeof w === 'string' ? w : w.detail || w.message || JSON.stringify(w); })),
        limitations: ['moneyline and total are EXPERIMENTAL (behind the close in testing); the spread is OUTCOME_VALIDATED (break-even against the close, not ahead)', 'the published win probability is normCdf(fair margin / 10.7)'],
        integrity: { invalidated: conflicts.length > 0, conflicts: conflicts.map(function (c) { return { kind: 'STARTER_CONFLICT', detail: c.detail, assumed: c.assumed, current: c.current, last_game_starter: c.last_game_starter, corroborated_by_last_game: c.corroborated_by_last_game, action: 'invalidated for pricing until the engine is re-run on the current starter' }; }) },
        markets_supported: ['moneyline', 'spread'],
        _sensitivity: sens
      }));
    });
    return { projections: out, error: null, model: { id: eng.model_version, generated_at: s.generated_at }, starters_read: !!starters };
  };

  /* CFB — football/fbs/slate.json (edgedesk_fbs_slate_v1) */
  ADAPTERS.cfb = function (A, ctx) {
    var sp = SPORTS.cfb, s = A['football/fbs/slate.json'], out = [], now = ctx.now;
    if (!s || !Array.isArray(s.games)) return { projections: [], error: 'football/fbs/slate.json missing' };
    s.games.forEach(function (g) {
      if (g.model_status !== 'PREDICTED' || num(g.model_home_win_prob) == null) return;
      var val = validationBlock(ctx.registry, 'cfb', ['moneyline']);
      var hs = g.home_starter || null, as = g.away_starter || null;
      var stat = function (x) { return x ? str(x.status || x.state || '') : ''; };
      var qbCert = (hs && /CONFIRMED|ANNOUNCED/.test(stat(hs))) && (as && /CONFIRMED|ANNOUNCED/.test(stat(as))) ? 'CONFIRMED' : (hs || as) ? 'PROJECTED_UNCERTAIN' : 'UNKNOWN';
      out.push(base(sp, {
        event_id: g.game_id, event_key: 'CFB|' + g.game_id, start_utc: g.kickoff, venue: g.venue, neutral: !!g.neutral_site,
        home: team(g.home_team, null, g.home_team_id), away: team(g.away_team, null, g.away_team_id),
        model: { id: g.shadow_model_version ? str(g.shadow_model_version).split('+')[0] : 'edgedesk_cfb_p4', version: s.version || null, artifact: 'football/fbs/slate.json', artifact_generated_at: iso(s.generated_at), predicted_at: iso(s.generated_at) },
        outcome: { p_home: r4(num(g.model_home_win_prob)), p_away: r4(1 - num(g.model_home_win_prob)), p_draw: null, settles: 'includes overtime (college football cannot end tied)' },
        fair: { moneyline: { home: fairAm(num(g.model_home_win_prob), 0), away: fairAm(1 - num(g.model_home_win_prob), 0) }, spread: { home_line: num(g.model_home_line) }, total: { line: num(g.model_fair_total), expected: num(g.model_fair_total) } },
        projected_score: num(g.model_fair_total) != null && num(g.model_home_margin) != null ? { home: r2((num(g.model_fair_total) + num(g.model_home_margin)) / 2), away: r2((num(g.model_fair_total) - num(g.model_home_margin)) / 2), margin: num(g.model_home_margin), total: num(g.model_fair_total), basis: 'the engine\'s fair margin and fair total' } : null,
        distribution: { kind: 'win_probability_only', spread_lines: [], total_lines: [] },
        simulation: { method: sp.simulation.method, monte_carlo: false, simulations: null, convergence: 'not simulated' },
        uncertainty: { model_sd: SIGMA.model_default, calibration_sd: sigmaCal(val.markets.moneyline), lineup_sd: SIGMA.lineup[qbCert], basis: 'board defaults; calibration from the moneyline\'s measured offset (engine/registry.json); quarterback ' + qbCert.toLowerCase().replace(/_/g, ' ') },
        validation: val,
        availability: { key_role: 'QB', certainty: qbCert, home: { starter: hs ? { name: hs.player_name || hs.name || null, status: stat(hs) || null } : null }, away: { starter: as ? { name: as.player_name || as.name || null, status: stat(as) || null } : null }, injuries: 'operator-entered availability only (no official CFB feed)', conflicts: [] },
        matchup: { factors: [], metrics: { home_qb_epa: g.home_qb_epa != null ? g.home_qb_epa : null, away_qb_epa: g.away_qb_epa != null ? g.away_qb_epa : null, reliability_grade: g.reliability_grade || null, reliability_score: num(g.reliability_score), data_completeness: num(g.data_completeness) } },
        provenance: [{ what: 'schedule', source: s.source || 'cfbfastR schedules', authority: 'THIRD_PARTY' }, { what: 'projection', source: 'football/fbs/slate.json', authority: 'EDGEDESK_MODEL', retrieved_at: iso(s.generated_at) }],
        freshness: freshnessOf(sp, s.generated_at, now, { data_completeness: num(g.data_completeness) }),
        invalidators: ['A quarterback change (college starters are rarely confirmed before kickoff).'],
        limitations: ['every CFB market is EXPERIMENTAL or RESEARCH against the close; no spread or total distribution is published'],
        markets_supported: ['moneyline']
      }));
    });
    return { projections: out, error: null, model: { id: 'edgedesk_cfb_p4', generated_at: s.generated_at } };
  };

  /* ================================================================ */
  /* 4. BUILD, ASSESS, FREEZE                                          */
  /* ================================================================ */
  /** Every operational adapter over the artifacts handed in. A missing artifact is a blocker, said per sport. */
  function buildAll(A, ctx) {
    A = A || {}; ctx = Object.assign({ now: Date.now(), registry: A['engine/registry.json'] || null }, ctx || {});
    ctx.now = toMs(ctx.now) != null ? toMs(ctx.now) : Date.now();
    var projections = [], sports = {};
    Object.keys(SPORTS).forEach(function (id) {
      var sp = SPORTS[id];
      if (!sp.adapter) { sports[id] = { id: id, label: sp.label, operational: false, model_executed: false, projections: 0, blocker: sp.unsupported.map(function (u) { return u.why; }).join('; ') }; return; }
      var r;
      try { r = ADAPTERS[sp.adapter](A, ctx, sp); } catch (e) { r = { projections: [], error: 'the adapter threw: ' + str(e && e.message || e).slice(0, 160) }; }
      r.projections.forEach(function (p) { p.projection_id = 'pj_' + sha256([p.sport, p.event_id, p.model.id, p.model.predicted_at].join('|')).slice(0, 24); p.research = assess(p, ctx.now); projections.push(p); });
      sports[id] = { id: id, label: sp.label, operational: !r.error, model_executed: !r.error, model: r.model || null, projections: r.projections.length, blocker: r.error || null, note: r.note || null, notes: r.notes || null, next_game: r.next_game || null };
    });
    /* NBA: the dedicated engine wins; the lab's NBA rows are a fallback for games it does not carry */
    return { schema: VERSION + ':build', built_at: new Date(ctx.now).toISOString(), projections: projections, sports: sports, registry_generated_at: ctx.registry ? ctx.registry.generated_at || null : null };
  }

  /** RESEARCH_READY / RESEARCH_CONDITIONAL / DATA_INSUFFICIENT / MODEL_UNAVAILABLE, with every reason. */
  function assess(p, now) {
    if (!p) return { outcome: 'MODEL_UNAVAILABLE', reasons: ['no independent projection'] };
    var reasons = [], conditional = [];
    var fr = p.freshness || {};
    if (fr.state === 'EXPIRED') reasons.push('model build expired: ' + fr.why);
    if (fr.state === 'UNKNOWN') reasons.push('the model build time is unknown');
    if (fr.data_state && fr.data_state !== 'FRESH') reasons.push('input data ' + fr.data_state.toLowerCase() + (fr.latest_result ? ' (latest result ' + fr.latest_result + (fr.results_missing_last_14_days ? ', ' + fr.results_missing_last_14_days + ' results missing in the last 14 days' : '') + ')' : ''));
    if (fr.data_completeness != null && fr.data_completeness < 0.5) reasons.push('data completeness ' + fr.data_completeness + ' (below 0.5)');
    if (!isIndependent(p)) reasons.push('the projection is not independent of the market');
    if (reasons.length) return { outcome: 'DATA_INSUFFICIENT', reasons: reasons };
    if (p.integrity && p.integrity.invalidated) p.integrity.conflicts.forEach(function (c) { conditional.push('STARTER CONFLICT — ' + c.detail + '; ' + c.action); });
    var av = p.availability || {};
    if (av.key_role && av.certainty !== 'CONFIRMED' && av.certainty !== 'CONFLICTING') conditional.push((av.key_role === 'G' ? 'starting goalies' : av.key_role === 'QB' ? 'starting quarterbacks' : av.key_role === 'STAR' ? 'availability (no injury report or confirmed lineup)' : 'key roles') + ' not confirmed (' + str(av.certainty).toLowerCase().replace(/_/g, ' ') + ')');
    var prim = primaryMarket(p), v = p.validation && p.validation.markets ? p.validation.markets[prim] : null;
    if (!v || !PRICING_STATES[v.state]) conditional.push('the ' + marketWord(prim) + ' model is ' + (v ? str(v.state).toLowerCase().replace(/_/g, ' ') : 'unvalidated') + (v && v.headline ? ' (' + v.headline + ')' : ''));
    if (p.uncertainty && p.uncertainty.early_season) conditional.push('early season: ratings lean on last season');
    return conditional.length ? { outcome: 'RESEARCH_CONDITIONAL', reasons: conditional } : { outcome: 'RESEARCH_READY', reasons: ['fresh build, validated primary market, key roles confirmed'] };
  }
  function primaryMarket(p) { return p.sport === 'soccer' ? 'three_way' : 'moneyline'; }
  function marketWord(m) { return m === 'three_way' ? '1X2 (three-way)' : m === 'spread' ? 'spread' : m === 'total' ? 'total' : 'moneyline'; }
  function isIndependent(p) { return !!(p && p.model && p.model.kind === 'INDEPENDENT' && Array.isArray(p.model.market_inputs) && p.model.market_inputs.length === 0); }

  /* The hash covers the MODEL OUTPUT: what the engine said, its inputs' provenance and integrity. The
     time-dependent assessment (the artifact's age, the research outcome read at freeze time) is stamped
     beside it, not inside it, so an unchanged projection keeps its hash from one build to the next. */
  function hashOf(p) {
    var c = Object.assign({}, p); delete c.projection_hash; delete c.frozen_at; delete c.research;
    if (c.freshness) { c.freshness = Object.assign({}, c.freshness); delete c.freshness.age_hours; delete c.freshness.state; delete c.freshness.why; }
    return sha256(canonical(c));
  }
  /**
   * Freeze the projections BEFORE any market is read: each one is copied, stamped, hashed and
   * deep-frozen. The snapshot hash covers every projection hash in order.
   */
  function freeze(projections, now) {
    var t = toMs(now) != null ? toMs(now) : Date.now();
    var at = new Date(t).toISOString();
    var list = (projections || []).map(function (p0) { var p = clone(p0); p.frozen_at = at; p.projection_hash = hashOf(p); return deepFreeze(p); });
    var snap = { schema: SNAPSHOT, frozen_at: at, count: list.length, projections: list };
    snap.snapshot_hash = sha256(list.map(function (p) { return p.projection_hash; }).join('|'));
    /* the stored row's id: the same projections frozen at another time are another freeze, with their own row
       (an id from the hash alone would be silently deduplicated and the second turn's comparisons refused) */
    snap.snapshot_id = 'pjs_' + sha256(snap.snapshot_hash + '|' + at).slice(0, 32);
    return deepFreeze(snap);
  }
  function snapshotHash(snap) { return snap && snap.projections ? sha256(snap.projections.map(function (p) { return hashOf(p); }).join('|')) : null; }
  function verifySnapshot(snap) {
    var bad = (snap && snap.projections || []).filter(function (p) { return hashOf(p) !== p.projection_hash; }).map(function (p) { return p.projection_id; });
    return { ok: !!snap && !bad.length && snapshotHash(snap) === snap.snapshot_hash, changed: bad };
  }

  /* ================================================================ */
  /* 5. WHAT THE MARKET ENGINE MAY ASK OF A PROJECTION                 */
  /* ================================================================ */
  /** p_win / p_push for one side of one market at one line, from the projection's own distribution only. */
  function probabilityAt(p, kind, side, line) {
    if (!p || !p.outcome) return null;
    var v = p.validation && p.validation.markets ? p.validation.markets[kind === 'moneyline' && p.sport === 'soccer' ? 'three_way' : kind] : null;
    var tier = v ? v.state : 'UNAVAILABLE';
    function res(pw, pp) { pw = num(pw); pp = num(pp) || 0; if (pw == null) return null; return { p_win: r4(pw), p_push: r4(pp), fair_american: fairAm(pw, pp), tier: tier }; }
    if (kind === 'moneyline' && p.sport !== 'soccer') return side === 'home' ? res(p.outcome.p_home, 0) : side === 'away' ? res(p.outcome.p_away, 0) : null;
    if (kind === 'three_way' || (kind === 'moneyline' && p.sport === 'soccer')) return side === 'home' ? res(p.outcome.p_home) : side === 'away' ? res(p.outcome.p_away) : side === 'draw' ? res(p.outcome.p_draw) : null;
    var d = p.distribution || {};
    /* a spread or total without a line names no market: nothing is priced (never pick'em by default) */
    if ((kind === 'spread' || kind === 'total') && num(line) == null) return null;
    if (kind === 'spread') {
      /* a quote's line is the SELECTION's: home -1.5 is home_line -1.5; away +1.5 is home_line -1.5 too */
      var hl = side === 'home' ? num(line) : side === 'away' ? -num(line) : null;
      var row = (d.spread_lines || []).filter(function (x) { return x.home_line === hl; })[0];
      if (!row) return null;
      /* an alternate line carries its own validation in the engine's output; it never borrows the main line's */
      if (row.validation) tier = lineState(row.validation, tier);
      return side === 'home' ? res(row.home, row.push) : res(row.away, row.push);
    }
    if (kind === 'total') {
      var t = (d.total_lines || []).filter(function (x) { return x.line === num(line); })[0];
      if (!t) return null;
      if (t.validation) tier = lineState(t.validation, tier);
      return side === 'over' ? res(t.over, t.push) : side === 'under' ? res(t.under, t.push) : null;
    }
    return null;
  }
  /** A line's own validation word (the engines write OUTCOME_VALIDATED / PROVISIONAL / EXPERIMENTAL) as a registry state, never above the market's. */
  function lineState(word, marketState) {
    var w = str(word).toUpperCase();
    var st = w === 'OUTCOME_VALIDATED' || w === 'VALIDATED' ? 'OUTCOME_VALIDATED' : w === 'MARKET_VALIDATED' ? 'MARKET_VALIDATED' : w === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : 'EXPERIMENTAL';
    return (STATE_RANK[st] != null ? STATE_RANK[st] : 9) >= (STATE_RANK[marketState] != null ? STATE_RANK[marketState] : 9) ? st : marketState;
  }
  /** May this projection support an EV figure for this market at all? (value claims are a separate gate) */
  function pricingEligibility(p, kind) {
    if (!isIndependent(p)) return { ok: false, why: 'the projection is not independent of the market' };
    if (p.integrity && p.integrity.invalidated) return { ok: false, why: 'the projection is invalidated: ' + p.integrity.conflicts.map(function (c) { return c.detail; }).join('; ') };
    if (p.freshness && (p.freshness.state === 'EXPIRED' || p.freshness.state === 'UNKNOWN')) return { ok: false, why: 'model build ' + str(p.freshness.state).toLowerCase() + ': ' + p.freshness.why };
    if (p.markets_supported.indexOf(kind === 'moneyline' && p.sport === 'soccer' ? 'three_way' : kind) < 0) return { ok: false, why: 'the ' + p.sport_label + ' engine does not publish a ' + marketWord(kind) + ' distribution' };
    var v = p.validation && p.validation.markets ? p.validation.markets[kind === 'moneyline' && p.sport === 'soccer' ? 'three_way' : kind] : null;
    if (!v || !PRICING_STATES[v.state]) return { ok: false, why: 'the ' + p.sport_label + ' ' + marketWord(kind) + ' model is ' + (v ? str(v.state).toLowerCase().replace(/_/g, ' ') : 'not validated') + ' — research only, no EV is quoted' + (v && v.headline ? ' (' + v.headline + ')' : '') };
    if (p.research && p.research.outcome === 'DATA_INSUFFICIENT') return { ok: false, why: 'data insufficient: ' + p.research.reasons.join('; ') };
    return { ok: true, why: marketWord(kind) + ' ' + str(v.state).toLowerCase().replace(/_/g, ' ') };
  }
  function valueClaims(p, kind) {
    var v = p.validation && p.validation.markets ? p.validation.markets[kind === 'moneyline' && p.sport === 'soccer' ? 'three_way' : kind] : null;
    return v && v.value_claims ? { ok: true, why: 'beat the closing market out of sample' } : { ok: false, why: 'the ' + p.sport_label + ' ' + marketWord(kind) + ' model has not been shown to beat the closing market (' + (v && v.reason ? v.reason : 'value claims disabled') + ')' };
  }
  function lineupGate(p) { var av = p.availability || {}; if (!av.key_role) return { ok: true, why: 'no single role dominates the price' }; return av.certainty === 'CONFIRMED' ? { ok: true, why: av.key_role + ' confirmed' } : { ok: false, why: (av.key_role === 'G' ? 'goalies' : av.key_role === 'QB' ? 'quarterbacks' : 'availability') + ' ' + str(av.certainty).toLowerCase().replace(/_/g, ' ') }; }
  /** The uncertainty a market's probability carries: model, calibration and lineup, combined in quadrature. */
  function marketSigma(p, kind) {
    var u = p.uncertainty || {};
    var v = p.validation && p.validation.markets ? p.validation.markets[kind === 'moneyline' && p.sport === 'soccer' ? 'three_way' : kind] : null;
    var cal = kind === 'moneyline' || kind === 'three_way' ? num(u.calibration_sd) : sigmaCal(v);
    var m = num(u.model_sd) != null ? num(u.model_sd) : SIGMA.model_default, l = num(u.lineup_sd) != null ? num(u.lineup_sd) : SIGMA.lineup.UNKNOWN;
    cal = cal != null ? cal : sigmaCal(v);
    return { model: r4(m), calibration: r4(cal), lineup: r4(l), total: r4(Math.sqrt(m * m + cal * cal + l * l)) };
  }
  /** The markets to compare: both moneyline sides always, and every spread/total line a quote names. */
  function comparableMarkets(p, quotes) {
    var out = [], seen = {};
    function add(k, s, l) { var key = k + '|' + s + '|' + (l == null ? '' : l); if (seen[key]) return; seen[key] = 1; out.push({ kind: k, side: s, line: l == null ? null : l }); }
    if (p.sport === 'soccer') { add('three_way', 'home'); add('three_way', 'away'); add('three_way', 'draw'); }
    else { add('moneyline', 'home'); add('moneyline', 'away'); }
    (quotes || []).forEach(function (q) { var k = q.market && q.market.kind; if ((k === 'spread' || k === 'total') && num(q.market.line) != null) add(k, q.market.side, q.market.line); });
    return out;
  }

  /* ================================================================ */
  /* 6. THE CAPABILITY MATRIX — every sport, what actually ran         */
  /* ================================================================ */
  function capabilityMatrix(build, o) {
    o = o || {};
    var month = o.now ? new Date(toMs(o.now)).getUTCMonth() + 1 : null;
    return Object.keys(SPORTS).map(function (id) {
      var sp = SPORTS[id], b = build && build.sports ? build.sports[id] : null;
      var inSeason = month == null ? null : (sp.season_months[0] <= sp.season_months[1] ? month >= sp.season_months[0] && month <= sp.season_months[1] : month >= sp.season_months[0] || month <= sp.season_months[1]);
      var pj = (build && build.projections || []).filter(function (p) { return p.sport === id; })[0] || null;
      return {
        sport: id, label: sp.label, league: sp.league, level: sp.level, odds_key: sp.odds_key, in_season: inSeason,
        discovery: sp.discovery, schedule_codes: sp.schedule_codes, providers: sp.providers, stats: sp.stats,
        independent_projection: !!sp.adapter, engine_artifacts: sp.artifacts, model_id: b && b.model ? b.model.id || null : null, model_built_at: b && b.model ? iso(b.model.generated_at) : null,
        model_executed: !!(b && b.model_executed), projections: b ? b.projections : 0,
        availability: sp.availability, simulation: sp.simulation, key_role: sp.key_role, supported_markets: sp.markets,
        validation: pj ? Object.keys(pj.validation.markets).map(function (k) { return { market: k, state: pj.validation.markets[k].state, n: pj.validation.markets[k].n || null, value_claims: !!pj.validation.markets[k].value_claims }; }) : null,
        data_freshness_requirement_hours: sp.max_age_hours, market_pricing: o.captured_sports ? (o.captured_sports.indexOf(sp.odds_key) >= 0 ? 'captured by default (paid Odds API through the gateway)' : 'not captured by default') : null,
        research_readiness: !sp.adapter ? 'MODEL_UNAVAILABLE' : b && b.blocker ? 'BLOCKED' : b && b.projections ? 'OPERATIONAL' : 'OPERATIONAL_NO_EVENTS',
        blocker: b ? b.blocker || null : null, unsupported: sp.unsupported
      };
    });
  }

  return {
    VERSION: VERSION, CONTRACT: CONTRACT, SNAPSHOT: SNAPSHOT, SPORTS: SPORTS, SCHEDULE_CODE: SCHEDULE_CODE, SIGMA: SIGMA, STATE_RANK: STATE_RANK, PRICING_STATES: PRICING_STATES,
    RESEARCH_OUTCOMES: RESEARCH_OUTCOMES, MARKET_FIELDS: MARKET_FIELDS, NHL_NAMES: NHL_NAMES, ADAPTERS: ADAPTERS,
    authorityOf: authorityOf, sha256: sha256, canonical: canonical, zonedToUtc: zonedToUtc, nflStarterCheck: nflStarterCheck,
    buildAll: buildAll, assess: assess, isIndependent: isIndependent, freeze: freeze, snapshotHash: snapshotHash, verifySnapshot: verifySnapshot, hashOf: hashOf,
    probabilityAt: probabilityAt, pricingEligibility: pricingEligibility, valueClaims: valueClaims, lineupGate: lineupGate, marketSigma: marketSigma,
    comparableMarkets: comparableMarkets, capabilityMatrix: capabilityMatrix, lineState: lineState, primaryMarket: primaryMarket, registryMarket: registryMarket, artifactsNeeded: artifactsNeeded
  };
  /** The artifact paths the adapters read (the host fetches exactly these). */
  function artifactsNeeded() { var s = { 'engine/registry.json': 1 }; Object.keys(SPORTS).forEach(function (id) { SPORTS[id].artifacts.forEach(function (a) { s[a] = 1; }); }); return Object.keys(s); }
});
/*__EDPROJ_END__*/
