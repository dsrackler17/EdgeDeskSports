/* ===========================================================================
   EDGEDESK PLAYER PROPS — the prop research kernel (browser + Node, ES5).
   docs/player-props/DESIGN.md

   One file answers, for every player prop a book has posted:
     what the market is offering    every book, every line, both sides, the
                                    consensus, the no-vig probability
     what EdgeDesk thinks it is     an outcome DISTRIBUTION per market (not a
     worth                          mean): P(over), P(under), P(push) at the
                                    exact line, the fair price
     where the best price is        the best EV over every (book, line, price)
                                    combination — a worse line at a much better
                                    price wins when its EV is higher
     whether it qualifies           BET / LEAN / WATCH / PASS / NO DECISION on
                                    the football engine's thresholds, capped by
                                    uncertainty; units rounded DOWN
     why, and what could break it   deterministic sentences from structured facts
     how it settled                 WIN / LOSS / PUSH / VOID, line and price CLV

   WHAT THIS FILE NEVER DOES
     - assume −110, or any price it was not given;
     - turn a historical hit rate into a probability (hitRates() is context,
       labelled as such, and never enters evaluate());
     - let the market silently set the projection: the market-informed mean is
       a DECLARED blend (CONFIG.market_weight) printed on every prop, and the
       raw model probability is always reported beside it;
     - size a stake from a raw EV, or above the probability source's cap.

   REUSE (never duplicated)
     odds arithmetic      lib/research_core.js (EDResearch): americanToDecimal,
                          impliedProb, noVigTwoWay, expectedRoi
     thresholds / units   lib/edgedesk_decision.js EDDecision.config()
                          (thresholds.bet/lean/strong, sizing.grid/tiers/
                          source_caps/kelly_fraction, gates, anomaly,
                          freshness, confidence labels)
     freshness            lib/edgedesk_market.js EDMarket.freshness
     words                lib/edgedesk_vocab.js EDVocab.DECISION
     dollars              lib/edgedesk_bankroll.js EDBankroll.dollars
     alternate de-vig     lib/edgedesk_ev.js EDEV.devig (power / shin)
   Each is looked up on the global (browser) or required (Node); the fallbacks
   below are byte-for-byte the same rules and a parity test pins them.

   Browser: window.EDProps.   Node: require('./edgedesk_props.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDProps = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_props_engine_v1';
  var SCHEMA = 'edgedesk_prop_evaluation_v1';
  var EPS = 1e-9;

  /* ------------------------------------------------------------ deps */
  function dep(name, file) {
    if (root && root[name]) return root[name];
    if (typeof require === 'function') { try { return require(file); } catch (e) { return null; } }
    return null;
  }
  /* research_core registers as EDResearch AND EDResearchCore; app.html later
     reuses window.EDResearch for the AI desk's tool planner, so the core is
     read under its unambiguous name and checked for the odds API */
  function RC() {
    var c = root && root.EDResearchCore;
    if (c && typeof c.americanToDecimal === 'function') return c;
    c = root && root.EDResearch;
    if (c && typeof c.americanToDecimal === 'function') return c;
    if (typeof require === 'function') { try { return require('./research_core.js'); } catch (e) { return null; } }
    return null;
  }
  function DEC() { return dep('EDDecision', './edgedesk_decision.js'); }
  function MKT() { return dep('EDMarket', './edgedesk_market.js'); }
  function VOC() { return dep('EDVocab', './edgedesk_vocab.js'); }
  function BANK() { return dep('EDBankroll', './edgedesk_bankroll.js'); }
  function EVL() { return root && root.EDEV ? root.EDEV : null; }

  /* ------------------------------------------------------------ utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r(x, d) { if (!isNum(x)) return null; var p = Math.pow(10, d == null ? 3 : d); return Math.round(x * p) / p; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function ms(t) { if (t == null) return null; if (typeof t === 'number') return t; var v = Date.parse(t); return isFinite(v) ? v : null; }
  function median(xs) { var a = xs.filter(isNum).slice().sort(function (x, y) { return x - y; }); if (!a.length) return null; var m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function hash(parts) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts), h = 0x811c9dc5, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function normName(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[’'`.]/g, '').replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ================================================================ CONFIG
     Numbers that belong to the football decision engine are READ from it
     (decisionConfig()); these are the prop-specific ones. Every value is a
     conservative default, labelled unvalidated until the graded ledger says
     otherwise. */
  var CONFIG = {
    version: 'player_props_config_v1',
    validation_state: 'CONSERVATIVE_DEFAULT_UNVALIDATED',
    market_weight: 0.30,            /* informed mean = 0.70 raw + 0.30 market-implied */
    fresh_minutes: 30, max_quote_age_minutes: 90,
    price_bounds: { min_abs: 100, max_abs: 20000 },
    /* a hold outside this band on one book's two sides is a broken feed */
    two_way_hold: { min: 0.99, max: 1.30 },
    watch: { yards_points: 2.5, count_points: 0.5, cents: 15 },
    anomaly: { ev: 0.15, edge_pp: 12, corroborate_cents: 12 },
    caps: { min_games: 3, min_confidence: 40, role_stability: 0.5, single_book_units: 0.50, material_units: 0.25 },
    strong_disagreement_pp: 5,      /* STRONG/MAX units need model − no-vig ≥ this toward the side */
    decision_price_window: { min: -300, max: 300 },   /* a decision candidate's price band (alternates beyond it are shown, not recommended) */
    confidence_weights: { sample: 0.14, role: 0.14, data: 0.10, market: 0.14, freshness: 0.10, injury: 0.12, agreement: 0.10, history: 0.06, calibration: 0.10 },
    calibration_states: {
      UNVALIDATED: { source: 'model_estimated', label: 'MODEL-ESTIMATED (UNVALIDATED CALIBRATION)', score: 0.30 },
      EARLY: { source: 'model_estimated', label: 'MODEL-ESTIMATED (EARLY CALIBRATION EVIDENCE)', score: 0.50 },
      PARTIAL: { source: 'partially_calibrated', label: 'PARTIALLY CALIBRATED', score: 0.75 },
      CALIBRATED: { source: 'calibrated', label: 'CALIBRATED', score: 1.00 }
    },
    ev_buckets: [[-Infinity, 0, '< 0%'], [0, 0.02, '0–2%'], [0.02, 0.05, '2–5%'], [0.05, 0.08, '5–8%'], [0.08, Infinity, '8%+']],
    conf_buckets: [[0, 40, '< 40'], [40, 60, '40–59'], [60, 70, '60–69'], [70, 80, '70–79'], [80, 101, '80+']],
    prob_buckets: [[0.50, 0.55, '50–55%'], [0.55, 0.60, '55–60%'], [0.60, 0.65, '60–65%'], [0.65, 0.70, '65–70%'], [0.70, 1.0001, '70%+']]
  };
  /* the football engine's defaults — used only when lib/edgedesk_decision.js
     is not loaded; tools/props test pins them equal to EDDecision.config() */
  var DECISION_FALLBACK = {
    thresholds: { bet: { min_edge_pp: 4.0, min_ev: 0.05 }, strong: { min_edge_pp: 7.0, min_ev: 0.10 }, lean: { min_edge_pp: 2.0, min_ev: 0.0 } },
    sizing: { max_units: 1.00, grid: [0.25, 0.50, 0.75, 1.00], unit_pct_of_bankroll: 0.01, kelly_fraction: 0.25,
      source_caps: { calibrated: 1.00, partially_calibrated: 0.50, model_estimated: 0.25 },
      tiers: [
        { key: 'SMALL', units: 0.25, min_edge_pp: 4, min_ev: 0.05, min_confidence: 40 },
        { key: 'STANDARD', units: 0.50, min_edge_pp: 4, min_ev: 0.05, min_confidence: 60 },
        { key: 'STRONG', units: 0.75, min_edge_pp: 7, min_ev: 0.10, min_confidence: 70, require_gap: true },
        { key: 'MAX', units: 1.00, min_edge_pp: 7, min_ev: 0.10, min_confidence: 85, require_gap: true, require_source: 'calibrated', require_clean: true }
      ] },
    confidence: { labels: [[80, 'High'], [60, 'Moderate'], [40, 'Low'], [0, 'Very low']] }
  };
  var _dcfg = null;
  function decisionConfig() {
    if (_dcfg) return _dcfg;
    var D = DEC(), c = null;
    try { c = D && typeof D.config === 'function' ? D.config() : null; } catch (e) { c = null; }
    _dcfg = c && c.thresholds && c.sizing ? { thresholds: c.thresholds, sizing: c.sizing, confidence: c.confidence, source: 'EDDecision.config ' + c.version }
      : { thresholds: DECISION_FALLBACK.thresholds, sizing: DECISION_FALLBACK.sizing, confidence: DECISION_FALLBACK.confidence, source: 'fallback (EDDecision not loaded)' };
    return _dcfg;
  }

  /* ============================================================ REGISTRY
     One entry per market. `stat` names the settlement statistic; `dist` the
     distribution family the model builds for it; `positions` who it applies
     to; `usage` the drawer columns that matter to it; `yardage` decides the
     watch step. Provider keys map The Odds API's market keys (main and
     _alternate) onto EdgeDesk's. */
  var CATEGORIES = [
    { key: 'passing', label: 'Passing' }, { key: 'rushing', label: 'Rushing' }, { key: 'receiving', label: 'Receiving' },
    { key: 'combined', label: 'Combined' }, { key: 'touchdowns', label: 'Touchdowns' }, { key: 'other', label: 'Kicking & defence' }
  ];
  var U_QB = ['att', 'cmp', 'pass_yds', 'dropbacks', 'ypa', 'sack_rate', 'pressure_rate', 'rush_att', 'designed_runs', 'scramble_rate'];
  var U_RB = ['snaps', 'snap_pct', 'carries', 'rush_share', 'ypc', 'rz_carries', 'gl_carries', 'targets', 'target_share', 'routes'];
  var U_WR = ['snaps', 'snap_pct', 'routes', 'route_pct', 'targets', 'target_share', 'receptions', 'air_yards', 'adot', 'yprr', 'rz_targets'];
  var MARKETS = {
    pass_yds: { label: 'Passing Yards', short: 'Pass Yds', cat: 'passing', stat: 'pass_yds', dist: 'normal', positions: ['QB'], usage: U_QB, yardage: true, provider: ['player_pass_yds'] },
    pass_att: { label: 'Pass Attempts', short: 'Pass Att', cat: 'passing', stat: 'pass_att', dist: 'negbin', positions: ['QB'], usage: U_QB, provider: ['player_pass_attempts'] },
    pass_cmp: { label: 'Completions', short: 'Cmp', cat: 'passing', stat: 'pass_cmp', dist: 'negbin', positions: ['QB'], usage: U_QB, provider: ['player_pass_completions'] },
    pass_tds: { label: 'Passing TDs', short: 'Pass TD', cat: 'passing', stat: 'pass_tds', dist: 'poisson', positions: ['QB'], usage: U_QB, provider: ['player_pass_tds'] },
    pass_ints: { label: 'Interceptions', short: 'INT', cat: 'passing', stat: 'pass_ints', dist: 'poisson', positions: ['QB'], usage: U_QB, provider: ['player_pass_interceptions'] },
    pass_long: { label: 'Longest Completion', short: 'Long Cmp', cat: 'passing', stat: 'pass_long', dist: 'maxcomp', positions: ['QB'], usage: U_QB, yardage: true, provider: ['player_pass_longest_completion'] },
    rush_yds: { label: 'Rushing Yards', short: 'Rush Yds', cat: 'rushing', stat: 'rush_yds', dist: 'gcomp', positions: ['RB', 'QB', 'WR'], usage: U_RB, yardage: true, provider: ['player_rush_yds'] },
    rush_att: { label: 'Rush Attempts', short: 'Rush Att', cat: 'rushing', stat: 'rush_att', dist: 'negbin', positions: ['RB', 'QB'], usage: U_RB, provider: ['player_rush_attempts'] },
    rush_tds: { label: 'Rushing TDs', short: 'Rush TD', cat: 'rushing', stat: 'rush_tds', dist: 'poisson', positions: ['RB', 'QB'], usage: U_RB, provider: ['player_rush_tds'] },
    rush_long: { label: 'Longest Rush', short: 'Long Rush', cat: 'rushing', stat: 'rush_long', dist: 'maxcomp', positions: ['RB', 'QB'], usage: U_RB, yardage: true, provider: ['player_rush_longest'] },
    rec_yds: { label: 'Receiving Yards', short: 'Rec Yds', cat: 'receiving', stat: 'rec_yds', dist: 'gcomp', positions: ['WR', 'TE', 'RB'], usage: U_WR, yardage: true, provider: ['player_reception_yds'] },
    receptions: { label: 'Receptions', short: 'Rec', cat: 'receiving', stat: 'receptions', dist: 'negbin', positions: ['WR', 'TE', 'RB'], usage: U_WR, provider: ['player_receptions'] },
    targets: { label: 'Targets', short: 'Tgt', cat: 'receiving', stat: 'targets', dist: 'negbin', positions: ['WR', 'TE', 'RB'], usage: U_WR, provider: [] },
    rec_tds: { label: 'Receiving TDs', short: 'Rec TD', cat: 'receiving', stat: 'rec_tds', dist: 'poisson', positions: ['WR', 'TE', 'RB'], usage: U_WR, provider: ['player_reception_tds'] },
    rec_long: { label: 'Longest Reception', short: 'Long Rec', cat: 'receiving', stat: 'rec_long', dist: 'maxcomp', positions: ['WR', 'TE', 'RB'], usage: U_WR, yardage: true, provider: ['player_reception_longest'] },
    rush_rec_yds: { label: 'Rush + Rec Yards', short: 'Rush+Rec', cat: 'combined', stat: 'rush_rec_yds', dist: 'conv', positions: ['RB', 'WR', 'TE'], usage: U_RB, yardage: true, provider: ['player_rush_reception_yds'] },
    pass_rush_yds: { label: 'Pass + Rush Yards', short: 'Pass+Rush', cat: 'combined', stat: 'pass_rush_yds', dist: 'normal', positions: ['QB'], usage: U_QB, yardage: true, provider: ['player_pass_rush_yds'] },
    fantasy_pts: { label: 'Fantasy Points', short: 'Fantasy', cat: 'combined', stat: 'fantasy_pts', dist: 'lognormal', positions: ['QB', 'RB', 'WR', 'TE'], usage: U_RB, provider: [] },
    anytime_td: { label: 'Anytime TD', short: 'ATD', cat: 'touchdowns', stat: 'tds', dist: 'poisson', positions: ['RB', 'WR', 'TE', 'QB'], usage: U_RB, yesno: true, provider: ['player_anytime_td'] },
    first_td: { label: 'First TD', short: '1st TD', cat: 'touchdowns', stat: 'first_td', dist: 'bernoulli', positions: ['RB', 'WR', 'TE', 'QB'], usage: U_RB, yesno: true, provider: ['player_1st_td'] },
    tds_over: { label: 'Touchdowns O/U', short: 'TDs', cat: 'touchdowns', stat: 'tds', dist: 'poisson', positions: ['RB', 'WR', 'TE', 'QB'], usage: U_RB, provider: ['player_tds_over'] },
    fg_made: { label: 'Field Goals Made', short: 'FG', cat: 'other', stat: 'fg_made', dist: 'poisson', positions: ['K'], usage: [], provider: ['player_field_goals'] },
    kicking_pts: { label: 'Kicking Points', short: 'Kick Pts', cat: 'other', stat: 'kicking_pts', dist: 'normal', positions: ['K'], usage: [], provider: ['player_kicking_points'] },
    tackles_ast: { label: 'Tackles + Assists', short: 'Tkl+Ast', cat: 'other', stat: 'tackles_ast', dist: 'negbin', positions: ['LB', 'DB', 'DL'], usage: [], provider: ['player_tackles_assists'] },
    solo_tackles: { label: 'Solo Tackles', short: 'Solo', cat: 'other', stat: 'solo_tackles', dist: 'negbin', positions: ['LB', 'DB', 'DL'], usage: [], provider: ['player_solo_tackles'] },
    sacks: { label: 'Sacks', short: 'Sacks', cat: 'other', stat: 'sacks', dist: 'poisson', positions: ['DL', 'LB'], usage: [], provider: ['player_sacks'] },
    def_ints: { label: 'Interceptions (Def)', short: 'Def INT', cat: 'other', stat: 'def_ints', dist: 'poisson', positions: ['DB', 'LB'], usage: [], provider: ['player_defensive_interceptions'] }
  };
  /* sport registry: which markets a league carries and the provider sport key.
     A new sport is an entry here plus a stats source and a model adapter. */
  var SPORTS = {
    nfl: { key: 'nfl', label: 'NFL', provider_sport: 'americanfootball_nfl', family: 'football', markets: Object.keys(MARKETS) },
    cfb: { key: 'cfb', label: 'CFB', provider_sport: 'americanfootball_ncaaf', family: 'football',
      markets: ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_ints', 'pass_long', 'rush_yds', 'rush_att', 'rush_tds', 'rush_long', 'rec_yds', 'receptions', 'rec_tds', 'rec_long', 'rush_rec_yds', 'pass_rush_yds', 'anytime_td', 'first_td', 'tds_over', 'fg_made', 'kicking_pts'] }
  };
  var PROVIDER_INDEX = (function () {
    var ix = {};
    Object.keys(MARKETS).forEach(function (k) {
      (MARKETS[k].provider || []).forEach(function (p) { ix[p] = { market: k, alt: false }; ix[p + '_alternate'] = { market: k, alt: true }; });
    });
    /* rush+rec TD markets settle like anytime TD over 0.5 */
    ix.player_rush_reception_tds = { market: 'tds_over', alt: false };
    ix.player_rush_reception_tds_alternate = { market: 'tds_over', alt: true };
    return ix;
  }());
  function providerMarket(key) { return PROVIDER_INDEX[key] || null; }
  function providerKeys(markets, withAlt) {
    var out = [];
    (markets || Object.keys(MARKETS)).forEach(function (k) { var m = MARKETS[k]; if (!m) return; (m.provider || []).forEach(function (p) { out.push(p); if (withAlt && k !== 'anytime_td' && k !== 'first_td') out.push(p + '_alternate'); }); });
    return out;
  }
  function marketOf(k) { return MARKETS[k] || null; }
  function categoryOf(k) { var m = MARKETS[k]; return m ? m.cat : null; }

  /* ========================================================= NUMERICS */
  var LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1; var a = LG[0], t = x + 7.5, i;
    for (i = 1; i < 9; i++) a += LG[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  /* regularised lower incomplete gamma P(a, x) */
  function gammaP(a, x) {
    if (!(x > 0)) return 0;
    if (!isFinite(x)) return 1;
    var gln = lgamma(a), n, sum, del, ap;
    if (x < a + 1) {
      ap = a; sum = del = 1 / a;
      for (n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
      return clamp(sum * Math.exp(-x + a * Math.log(x) - gln), 0, 1);
    }
    var b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d, an, i;
    for (i = 1; i < 500; i++) {
      an = -i * (i - a); b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return clamp(1 - Math.exp(-x + a * Math.log(x) - gln) * h, 0, 1);
  }
  function gammaCdf(x, shape, scale) { return x <= 0 ? 0 : gammaP(shape, x / scale); }
  function erfc(x) {
    var z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    var v = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? v : 2 - v;
  }
  function normCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }

  /* count distributions (the N of a compound, or a market on its own) */
  function countPmf(c, k) {
    if (k < 0 || k !== Math.floor(k)) return 0;
    if (c.family === 'poisson') { var l = c.lambda; if (!(l > 0)) return k === 0 ? 1 : 0; return Math.exp(-l + k * Math.log(l) - lgamma(k + 1)); }
    var m = c.mean, s = c.size;
    if (!(m > 0)) return k === 0 ? 1 : 0;
    if (!(s > 0) || s > 1e6) return countPmf({ family: 'poisson', lambda: m }, k);
    return Math.exp(lgamma(k + s) - lgamma(s) - lgamma(k + 1) + s * Math.log(s / (s + m)) + k * Math.log(m / (s + m)));
  }
  function countMean(c) { return c.family === 'poisson' ? c.lambda : c.mean; }
  function countVar(c) { if (c.family === 'poisson') return c.lambda; var s = c.size; return c.mean + (s > 0 && s < 1e6 ? c.mean * c.mean / s : 0); }
  function countPgf(c, z) {
    if (c.family === 'poisson') return Math.exp(c.lambda * (z - 1));
    var s = c.size, m = c.mean;
    if (!(s > 0) || s > 1e6) return Math.exp(m * (z - 1));
    return Math.pow(s / (s + m * (1 - z)), s);
  }
  function countMax(c) { var m = countMean(c), sd = Math.sqrt(countVar(c)); return Math.min(600, Math.ceil(m + 12 * sd + 10)); }

  /* ========================================================= DISTRIBUTIONS
     Every family answers cdfInt(d, k) = P(outcome <= k) on the INTEGER outcome
     grid (football statistics are whole numbers); continuous families use a
     continuity correction (P(Y <= k + 0.5)). A cache keyed by the parameters
     keeps the browser fast without mutating the (serialisable) dist object. */
  var FAMILIES = ['normal', 'lognormal', 'poisson', 'negbin', 'gcomp', 'maxcomp', 'maxemp', 'conv', 'bernoulli', 'empirical'];
  var CACHE = {}, CACHE_N = 0;
  /* named per-event yard shapes (an empirical CDF of league plays) that a
     'maxemp' distribution references by name, so a board carries each table
     once: { x: [yards…], p: [P(yards <= x)…], mean, n, source } */
  var SHAPES = {};
  function registerShape(name, t) {
    if (!name || !t || !Array.isArray(t.x) || !Array.isArray(t.p) || t.x.length !== t.p.length || t.x.length < 5) return false;
    SHAPES[name] = { x: t.x.slice(), p: t.p.slice(), mean: num(t.mean), n: num(t.n), source: t.source || null };
    return true;
  }
  function shapeCdf(sh, z) {
    var x = sh.x, p = sh.p, n = x.length, lo = 0, hi = n - 1;
    if (z < x[0]) return 0;
    if (z >= x[n - 1]) {
      /* beyond the table: an exponential tail fitted to the last decile */
      var i9 = Math.max(0, n - 1 - Math.ceil(n / 10)), dx = x[n - 1] - x[i9], tailP = 1 - p[n - 1];
      var rate = dx > 0 && p[n - 1] < 1 ? Math.log((1 - p[i9]) / Math.max(1e-12, tailP)) / dx : 0.1;
      return 1 - tailP * Math.exp(-Math.max(rate, 1e-3) * (z - x[n - 1]));
    }
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (x[mid] <= z) lo = mid; else hi = mid; }
    var t = x[hi] > x[lo] ? (z - x[lo]) / (x[hi] - x[lo]) : 0;
    return p[lo] + t * (p[hi] - p[lo]);
  }
  function cached(key, fn) {
    if (has(CACHE, key)) return CACHE[key];
    if (CACHE_N > 20000) { CACHE = {}; CACHE_N = 0; }
    CACHE_N++; return (CACHE[key] = fn());
  }
  function distKey(d) { return JSON.stringify(d); }

  function validDist(d) {
    if (!d || FAMILIES.indexOf(d.family) < 0) return false;
    switch (d.family) {
      case 'normal': return isNum(d.mu) && isNum(d.sigma) && d.sigma > 0;
      case 'lognormal': return isNum(d.mu) && isNum(d.sigma) && d.sigma > 0 && isNum(d.shift || 0);
      case 'poisson': return isNum(d.lambda) && d.lambda >= 0;
      case 'negbin': return isNum(d.mean) && d.mean >= 0 && isNum(d.size) && d.size > 0;
      case 'gcomp': case 'maxcomp': return !!d.n && validDist(d.n) && isNum(d.a) && d.a > 0 && isNum(d.theta) && d.theta > 0 && isNum(d.shift || 0);
      case 'maxemp': return !!d.n && validDist(d.n) && !!SHAPES[d.shape] && isNum(d.scale) && d.scale > 0 && isNum(d.shift || 0);
      case 'conv': return Array.isArray(d.parts) && d.parts.length >= 2 && d.parts.every(validDist);
      case 'bernoulli': return isNum(d.p) && d.p >= 0 && d.p <= 1;
      case 'empirical': return Array.isArray(d.values) && d.values.length > 0 && d.values.every(isNum);
    }
    return false;
  }

  function gcompCdf(d, y) {
    var n, P = 0, pn, cum = 0, s = d.shift || 0, top = countMax(d.n);
    for (n = 0; n <= top; n++) {
      pn = countPmf(d.n, n); cum += pn;
      if (n === 0) P += y >= 0 ? pn : 0;
      else P += pn * gammaCdf(y + n * s, n * d.a, d.theta);
      if (cum > 1 - 1e-12 && n > countMean(d.n)) break;
    }
    return clamp(P, 0, 1);
  }
  function maxcompCdf(d, y) {
    if (y < 0) return 0;
    return clamp(countPgf(d.n, gammaCdf(y + (d.shift || 0), d.a, d.theta)), 0, 1);
  }
  /* the longest play when each play is a draw from the league's own yard
     distribution, rescaled to this player's average: (Y + s) = k·(Z + s) */
  function maxempCdf(d, y) {
    if (y < 0) return 0;
    var s = d.shift || 0, z = (y + s) / d.scale - s;
    return clamp(countPgf(d.n, shapeCdf(SHAPES[d.shape], z)), 0, 1);
  }
  function convGrid(d) {
    return cached('conv' + distKey(d), function () {
      var grids = d.parts.map(function (p) {
        var lo = Math.floor(quantileRaw(p, 1e-6)) - 1, hi = Math.ceil(quantileRaw(p, 1 - 1e-7)) + 1, pm = [], k, prev = cdfInt(p, lo - 1);
        for (k = lo; k <= hi; k++) { var c = cdfInt(p, k); pm.push(Math.max(0, c - prev)); prev = c; }
        return { lo: lo, pm: pm };
      });
      var acc = grids[0], g, i, j;
      for (g = 1; g < grids.length; g++) {
        var b = grids[g], out = new Array(acc.pm.length + b.pm.length - 1);
        for (i = 0; i < out.length; i++) out[i] = 0;
        for (i = 0; i < acc.pm.length; i++) { if (acc.pm[i] < 1e-15) continue; for (j = 0; j < b.pm.length; j++) out[i + j] += acc.pm[i] * b.pm[j]; }
        acc = { lo: acc.lo + b.lo, pm: out };
      }
      var cdf = [], s = 0;
      for (i = 0; i < acc.pm.length; i++) { s += acc.pm[i]; cdf.push(s); }
      var tot = s || 1;
      return { lo: acc.lo, cdf: cdf.map(function (v) { return v / tot; }) };
    });
  }
  function countCdfInt(c, k) {
    if (k < 0) return 0;
    return cached('cc' + JSON.stringify(c) + '|' + k, function () {
      var s = 0, i; for (i = 0; i <= k; i++) s += countPmf(c, i); return clamp(s, 0, 1);
    });
  }
  function cdfInt(d, k) {
    k = Math.floor(k);
    switch (d.family) {
      case 'normal': return normCdf((k + 0.5 - d.mu) / d.sigma);
      case 'lognormal': { var y = k + 0.5 + (d.shift || 0); return y <= 0 ? 0 : normCdf((Math.log(y) - d.mu) / d.sigma); }
      case 'poisson': return countCdfInt({ family: 'poisson', lambda: d.lambda }, k);
      case 'negbin': return countCdfInt({ family: 'negbin', mean: d.mean, size: d.size }, k);
      case 'gcomp': return cached('g' + distKey(d) + '|' + k, function () { return gcompCdf(d, k + 0.5); });
      case 'maxcomp': return cached('m' + distKey(d) + '|' + k, function () { return maxcompCdf(d, k + 0.5); });
      case 'maxemp': return cached('e' + distKey(d) + '|' + k, function () { return maxempCdf(d, k + 0.5); });
      case 'conv': { var G = convGrid(d), i = k - G.lo; return i < 0 ? 0 : (i >= G.cdf.length ? 1 : G.cdf[i]); }
      case 'bernoulli': return k < 0 ? 0 : (k >= 1 ? 1 : 1 - d.p);
      case 'empirical': {
        var w = d.weights || d.values.map(function () { return 1; }), bw = d.bw || 1, s = 0, t = 0, j;
        for (j = 0; j < d.values.length; j++) { s += w[j] * normCdf((k + 0.5 - d.values[j]) / bw); t += w[j]; }
        return t > 0 ? s / t : null;
      }
    }
    return null;
  }
  function pmfInt(d, k) { return Math.max(0, cdfInt(d, k) - cdfInt(d, k - 1)); }
  function meanOf(d) {
    switch (d.family) {
      case 'normal': return d.mu;
      case 'lognormal': return Math.exp(d.mu + d.sigma * d.sigma / 2) - (d.shift || 0);
      case 'poisson': return d.lambda;
      case 'negbin': return d.mean;
      case 'gcomp': return countMean(d.n) * (d.a * d.theta - (d.shift || 0));
      case 'bernoulli': return d.p;
      case 'conv': return d.parts.reduce(function (s, p) { return s + meanOf(p); }, 0);
      case 'empirical': { var w = d.weights || d.values.map(function () { return 1; }), s = 0, t = 0; d.values.forEach(function (v, i) { s += v * w[i]; t += w[i]; }); return t ? s / t : null; }
      case 'maxcomp': case 'maxemp': return cached('mm' + distKey(d), function () { var s = 0, k; for (k = 0; k < 400; k++) { var q = 1 - cdfInt(d, k); s += q; if (q < 1e-9) break; } return s; });
    }
    return null;
  }
  function varOf(d) {
    switch (d.family) {
      case 'normal': return d.sigma * d.sigma;
      case 'lognormal': { var s2 = d.sigma * d.sigma; return (Math.exp(s2) - 1) * Math.exp(2 * d.mu + s2); }
      case 'poisson': return d.lambda;
      case 'negbin': return d.mean + d.mean * d.mean / d.size;
      case 'gcomp': { var mx = d.a * d.theta - (d.shift || 0), vx = d.a * d.theta * d.theta; return countMean(d.n) * vx + countVar(d.n) * mx * mx; }
      case 'bernoulli': return d.p * (1 - d.p);
      case 'conv': return d.parts.reduce(function (s, p) { return s + varOf(p); }, 0);
      default: { var m = meanOf(d), v = 0, k, lo = -60, pm; for (k = lo; k < 600; k++) { pm = pmfInt(d, k); v += pm * (k - m) * (k - m); if (k > m && cdfInt(d, k) > 1 - 1e-9) break; } return v; }
    }
  }
  function quantileRaw(d, q) {
    var m = meanOf(d), sd = Math.sqrt(Math.max(varOf(d), 1e-6));
    var lo = Math.floor(m - 14 * sd) - 2, hi = Math.ceil(m + 14 * sd) + 2;
    if (d.family !== 'normal' && d.family !== 'gcomp' && d.family !== 'conv' && d.family !== 'empirical') lo = Math.max(lo, -1);
    if (d.family === 'gcomp') lo = Math.max(lo, -Math.ceil(3 * (d.shift || 0)) - 5);
    while (lo < hi) { var mid = Math.floor((lo + hi) / 2); if (cdfInt(d, mid) >= q) hi = mid; else lo = mid + 1; }
    return lo;
  }
  function quantile(d, q) { return quantileRaw(d, q); }
  function summary(d) {
    if (!validDist(d)) return null;
    return { family: d.family, mean: r(meanOf(d), 2), sd: r(Math.sqrt(Math.max(0, varOf(d))), 2), median: quantile(d, 0.5), p25: quantile(d, 0.25), p75: quantile(d, 0.75), p10: quantile(d, 0.10), p90: quantile(d, 0.90) };
  }
  /* P(over), P(under), P(push) at a line — a whole-number line pushes */
  function probLine(d, line) {
    if (!validDist(d) || !isNum(line)) return null;
    var whole = Math.abs(line - Math.round(line)) < EPS, push = 0, under, over;
    if (whole) { var L = Math.round(line); push = pmfInt(d, L); under = cdfInt(d, L - 1); over = 1 - cdfInt(d, L); }
    else { var f = Math.floor(line); under = cdfInt(d, f); over = 1 - under; }
    return { over: clamp(over, 0, 1), under: clamp(under, 0, 1), push: clamp(push, 0, 1) };
  }
  /* a distribution moved to a new mean: volume families scale their rate,
     yardage compounds scale the per-event size, normal shifts its centre */
  function scaleDist(d, f) {
    if (!isNum(f) || f <= 0) return d;
    var o = copy(d);
    switch (d.family) {
      case 'normal': o.mu = d.mu * f; break;
      case 'lognormal': { var m = meanOf(d), target = m * f + (d.shift || 0), cur = m + (d.shift || 0); if (cur > 0 && target > 0) o.mu = d.mu + Math.log(target / cur); break; }
      case 'poisson': o.lambda = d.lambda * f; break;
      case 'negbin': o.mean = d.mean * f; break;
      case 'gcomp': case 'maxcomp': { var s = d.shift || 0, per = d.a * d.theta - s; o.theta = Math.max(0.05, (per * f + s) / d.a); break; }
      case 'maxemp': { var sh = SHAPES[d.shape], s0 = d.shift || 0, m0 = sh && isNum(sh.mean) ? sh.mean : 5, cur = d.scale * (m0 + s0) - s0; o.scale = Math.max(0.05, (cur * f + s0) / (m0 + s0)); break; }
      case 'conv': o.parts = d.parts.map(function (p) { return scaleDist(p, f); }); break;
      case 'bernoulli': { var lam = -Math.log(Math.max(1e-9, 1 - d.p)); o.p = 1 - Math.exp(-lam * f); break; }
      case 'empirical': o.values = d.values.map(function (v) { return v * f; }); break;
    }
    return o;
  }
  /* a distribution with its VARIANCE multiplied by f and its mean kept — the
     one knob the walk-forward backtest fits per market (calibration.json).
     Counts cannot go below Poisson dispersion; a compound gives up count
     variance first, then per-event variance. */
  function widenDist(d, f) {
    if (!isNum(f) || Math.abs(f - 1) < 1e-9 || !validDist(d)) return d;
    var o = copy(d), m, v, s, per, vx;
    switch (d.family) {
      case 'normal': o.sigma = d.sigma * Math.sqrt(f); return o;
      case 'lognormal': { m = meanOf(d) + (d.shift || 0); v = varOf(d) * f; var s2 = Math.log(1 + v / (m * m)); o.sigma = Math.sqrt(s2); o.mu = Math.log(m) - s2 / 2; return o; }
      case 'poisson': if (f <= 1) return o; return { family: 'negbin', mean: d.lambda, size: d.lambda / (f - 1) > 0 ? Math.max(0.05, d.lambda / (f - 1)) : 1e7 };
      case 'negbin': { m = d.mean; v = varOf(d) * f; o.size = v > m + 1e-9 ? Math.max(0.05, m * m / (v - m)) : 1e7; return o; }
      case 'gcomp': {
        var cm = countMean(d.n), cv = countVar(d.n), ex = d.a * d.theta - (d.shift || 0);
        vx = d.a * d.theta * d.theta; v = cm * vx + cv * ex * ex;
        var target = v * f, needN = (target - cm * vx) / Math.max(1e-9, ex * ex);
        if (needN >= cm) { o.n = needN > cm + 1e-9 ? { family: 'negbin', mean: cm, size: Math.max(0.05, cm * cm / (needN - cm)) } : { family: 'poisson', lambda: cm }; return o; }
        o.n = { family: 'poisson', lambda: cm };
        var vxNew = Math.max(1e-6, (target - cm * ex * ex) / Math.max(1e-9, cm));
        per = ex + (d.shift || 0); o.a = per * per / vxNew; o.theta = vxNew / per; return o;
      }
      case 'maxcomp': { per = d.a * d.theta; o.a = d.a / f; o.theta = per / o.a; return o; }
      /* a longest-play distribution widens through its count (more or fewer
         chances at a big play), keeping the per-play shape measured */
      case 'maxemp': { var cmn = countMean(d.n), cvr = countVar(d.n) * f; o.n = cvr > cmn + 1e-9 ? { family: 'negbin', mean: cmn, size: Math.max(0.05, cmn * cmn / (cvr - cmn)) } : { family: 'poisson', lambda: cmn }; return o; }
      case 'conv': o.parts = d.parts.map(function (p) { return widenDist(p, f); }); return o;
      default: return o;
    }
  }
  /* the scale at which the model's own distribution reproduces a probability
     over a line: the market-implied centre, in the model's shape */
  function solveScale(d, line, pOver) {
    if (!validDist(d) || !isNum(line) || !isNum(pOver) || pOver <= 0.001 || pOver >= 0.999) return null;
    var lo = 0.15, hi = 6, i, f, p;
    var at = function (x) { var pr = probLine(scaleDist(d, x), line); return pr ? pr.over / Math.max(1e-9, pr.over + pr.under) : null; };
    var plo = at(lo), phi = at(hi);
    if (plo == null || phi == null || pOver < plo || pOver > phi) return null;
    for (i = 0; i < 48; i++) { f = (lo + hi) / 2; p = at(f); if (p < pOver) lo = f; else hi = f; }
    return (lo + hi) / 2;
  }

  /* ============================================================ ODDS
     research_core.js is the home; these delegate and fall back to the same
     formulas when it is not loaded. */
  function toDecimal(a) { var R = RC(); if (R) return R.americanToDecimal(a); a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / (-a); }
  function implied(a) { var d = toDecimal(a); return d == null ? null : 1 / d; }
  function probToAmerican(p) { var R = RC(); if (R) return R.probToAmerican(p); p = num(p); if (p == null || p <= 0 || p >= 1) return null; return p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p; }
  function roundAmerican(a) { if (!isNum(a)) return null; var v = Math.round(a); if (v > -100 && v < 100) v = v < 0 ? -100 : 100; return v; }
  /* push-aware fair price: EV = 0 ⇔ win·(d − 1) = loss ⇔ d = (win + loss) / win */
  function fairAmerican(pWin, pPush) {
    pWin = num(pWin); var q = num(pPush) || 0;
    if (pWin == null || pWin <= 0 || pWin + q >= 1) return null;
    var dec = (1 - q) / pWin;
    var R = RC(), a = R ? R.decimalToAmerican(dec) : (dec >= 2 ? 100 * (dec - 1) : -100 / (dec - 1));
    return roundAmerican(a);
  }
  function expectedValue(pWin, american, pPush) {
    var R = RC(); if (R) return R.expectedRoi(pWin, american, pPush || 0);
    var d = toDecimal(american); if (d == null || !isNum(pWin)) return null; var q = pPush || 0; return pWin * (d - 1) - Math.max(0, 1 - pWin - q);
  }
  function noVig(overAm, underAm, method) {
    method = method || 'proportional';
    if (method !== 'proportional') {
      var E = EVL(), a = toDecimal(overAm), b = toDecimal(underAm);
      if (E && typeof E.devig === 'function' && a && b) { var dv = E.devig([a, b], method); if (dv && dv.ok) return { over: dv.p[0], under: dv.p[1], overround: dv.overround, method: method }; }
      return null;
    }
    var R = RC();
    if (R) { var nv = R.noVigTwoWay(overAm, underAm); return nv ? { over: nv.a, under: nv.b, overround: nv.overround, method: 'proportional' } : null; }
    var pa = implied(overAm), pb = implied(underAm); if (pa == null || pb == null) return null;
    return { over: pa / (pa + pb), under: pb / (pa + pb), overround: pa + pb - 1, method: 'proportional' };
  }
  function validPrice(a) { return isNum(a) && Math.round(a) === a && Math.abs(a) >= CONFIG.price_bounds.min_abs && Math.abs(a) <= CONFIG.price_bounds.max_abs; }
  function priceBetter(a, b) { var da = toDecimal(a), db = toDecimal(b); return da != null && db != null && da > db + 1e-12; }
  /* a price moved by cents on the American ladder: −101, even (±100), +101 are
     one cent apart, so the ladder is linear in c = a − 100 (a ≥ 100) or a + 100 */
  function stepPrice(a, cents) {
    if (toDecimal(a) == null || !isNum(cents)) return null;
    var c = (a >= 100 ? a - 100 : a + 100) + cents;
    return c >= 0 ? 100 + c : c - 100;
  }

  /* ============================================================ SIDES */
  function sideOf(s) {
    var v = String(s || '').toLowerCase();
    if (v === 'over' || v === 'o' || v === 'yes' || v === 'y') return 'over';
    if (v === 'under' || v === 'u' || v === 'no' || v === 'n') return 'under';
    return null;
  }
  function sideLabel(market, side) { var m = MARKETS[market]; if (m && m.yesno) return side === 'over' ? 'Yes' : 'No'; return side === 'over' ? 'Over' : 'Under'; }
  function selectionText(market, side, line) {
    var m = MARKETS[market]; if (!m) return '—';
    if (m.yesno) return (side === 'over' ? '' : 'No ') + m.label;
    if (market === 'tds_over' && side === 'over' && isNum(line)) return Math.ceil(line) + '+ TDs';
    return (side === 'over' ? 'O' : 'U') + (isNum(line) ? String(line) : '—') + ' ' + m.short;
  }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function probText(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2).replace(/0$/, '') + 'U' : '—'; }

  /* ======================================================= QUOTES
     A quote is { book, market, line, side, american, quoted_at, captured_at,
     alt }. Normalisation refuses — never repairs — an impossible price, drops
     an exact duplicate, keeps the latest capture per (book, line, side), and
     judges freshness on the capture time (the provider's own update time is
     reported beside it). */
  function freshnessOf(q, now) {
    var t = q.captured_at || q.quoted_at, M = MKT();
    if (M && typeof M.freshness === 'function') return M.freshness(t, now, { fresh_minutes: CONFIG.fresh_minutes, max_minutes: CONFIG.max_quote_age_minutes });
    var at = ms(t), n = ms(now);
    if (at == null || n == null) return { state: 'UNKNOWN', age_minutes: null, text: 'capture time unknown' };
    var m = (n - at) / 60000;
    if (m < -5) return { state: 'FUTURE', age_minutes: r(m, 1), text: 'the capture time is in the future (clock fault)' };
    var st = m <= CONFIG.fresh_minutes ? 'FRESH' : (m <= CONFIG.max_quote_age_minutes ? 'AGING' : 'STALE');
    return { state: st, age_minutes: r(Math.max(0, m), 1), text: (m < 60 ? Math.round(Math.max(0, m)) + ' min' : r(m / 60, 1) + ' h') + ' old' };
  }
  function normalizeQuotes(quotes, market, now) {
    var out = [], refused = {}, seen = {};
    var refuse = function (why) { refused[why] = (refused[why] || 0) + 1; };
    var mdef = MARKETS[market];
    (quotes || []).forEach(function (q0) {
      if (!q0) { refuse('empty quote'); return; }
      var side = sideOf(q0.side), a = num(q0.american), line = num(q0.line);
      if (mdef && mdef.yesno && line == null) line = 0.5;
      if (!side) { refuse('side not over/under/yes/no'); return; }
      if (!validPrice(a)) { refuse('not a valid American price'); return; }
      if (line == null || line < 0 || line > 2000 || Math.abs(line * 2 - Math.round(line * 2)) > EPS) { refuse('line not a non-negative half point'); return; }
      if (!q0.book) { refuse('no sportsbook'); return; }
      var q = { book: String(q0.book).toLowerCase(), book_title: q0.book_title || null, line: line, side: side, american: a, decimal: toDecimal(a),
        quoted_at: q0.quoted_at || null, captured_at: q0.captured_at || q0.quoted_at || null, alt: !!q0.alt };
      var k = q.book + '|' + q.line + '|' + q.side;
      var prev = seen[k];
      if (prev) {
        if ((ms(q.captured_at) || 0) < (ms(prev.captured_at) || 0)) return;
        if ((ms(q.captured_at) || 0) === (ms(prev.captured_at) || 0) && q.american !== prev.american) { refuse('conflicting duplicate at one capture time'); return; }
      }
      seen[k] = q;
    });
    Object.keys(seen).forEach(function (k) { var q = seen[k]; q.fresh = freshnessOf(q, now); out.push(q); });
    /* a book whose two sides of one number pay above fair is a broken feed */
    var bad = {};
    out.forEach(function (q) {
      if (q.side !== 'over') return;
      var u = seen[q.book + '|' + q.line + '|under'];
      if (!u) return;
      var s = implied(q.american) + implied(u.american);
      if (s < CONFIG.two_way_hold.min || s > CONFIG.two_way_hold.max) { bad[q.book + '|' + q.line] = true; }
    });
    out = out.filter(function (q) { if (bad[q.book + '|' + q.line]) { refuse('two-way hold out of bounds'); return false; } return true; });
    out.sort(function (x, y) { return x.line - y.line || (x.side < y.side ? -1 : x.side > y.side ? 1 : 0) || (x.book < y.book ? -1 : 1); });
    return { quotes: out, refused: refused };
  }
  /* the main number of each book (a non-alternate two-sided line; else its
     non-alternate one-sided line) and the market consensus from them */
  function consensusOf(quotes, now, includeStale) {
    var byBook = {};
    quotes.forEach(function (q) { if (q.alt || (!includeStale && q.fresh && (q.fresh.state === 'STALE' || q.fresh.state === 'FUTURE'))) return; (byBook[q.book] = byBook[q.book] || []).push(q); });
    var books = Object.keys(byBook).sort(), mains = [];
    books.forEach(function (b) {
      var qs = byBook[b], lines = {};
      qs.forEach(function (q) { (lines[q.line] = lines[q.line] || {})[q.side] = q; });
      var two = Object.keys(lines).filter(function (l) { return lines[l].over && lines[l].under; }).map(Number);
      var pick = null;
      if (two.length) {
        /* a book with two two-sided main numbers keeps the one closest to even money */
        two.sort(function (x, y) { var a = Math.abs(implied(lines[x].over.american) - implied(lines[x].under.american)), c = Math.abs(implied(lines[y].over.american) - implied(lines[y].under.american)); return a - c || x - y; });
        pick = lines[two[0]];
      } else { var ls = Object.keys(lines).map(Number).sort(function (x, y) { return x - y; }); pick = lines[ls[0]]; }
      var line = (pick.over || pick.under).line;
      mains.push({ book: b, line: line, over: pick.over ? pick.over.american : null, under: pick.under ? pick.under.american : null,
        two_sided: !!(pick.over && pick.under), captured_at: (pick.over || pick.under).captured_at, quoted_at: (pick.over || pick.under).quoted_at,
        novig: pick.over && pick.under ? noVig(pick.over.american, pick.under.american) : null });
    });
    if (!mains.length) return { n_books: 0, n_two_sided: 0, line: null, mains: [] };
    var counts = {};
    mains.forEach(function (m) { counts[m.line] = (counts[m.line] || 0) + 1; });
    var modal = Object.keys(counts).map(Number).sort(function (x, y) { return counts[y] - counts[x] || x - y; })[0];
    var lineMedian = median(mains.map(function (m) { return m.line; }));
    /* a line books actually deal: the modal number when it holds a plurality,
       else the median snapped to the half point (lib/market_consensus rule) */
    var line = counts[modal] >= 2 || mains.length === 1 ? modal : Math.round(lineMedian * 2) / 2;
    var atLine = mains.filter(function (m) { return m.line === line; });
    var nv = atLine.filter(function (m) { return m.novig; });
    var disp = mains.length > 1 ? Math.max.apply(null, mains.map(function (m) { return m.line; })) - Math.min.apply(null, mains.map(function (m) { return m.line; })) : 0;
    return {
      n_books: mains.length, n_two_sided: mains.filter(function (m) { return m.two_sided; }).length, n_at_line: atLine.length,
      line: line, line_median: lineMedian, dispersion: disp,
      over: roundAmerican(median(atLine.map(function (m) { return m.over; }))), under: roundAmerican(median(atLine.map(function (m) { return m.under; }))),
      novig_over: nv.length ? median(nv.map(function (m) { return m.novig.over; })) : null,
      novig_under: nv.length ? median(nv.map(function (m) { return m.novig.under; })) : null,
      novig_books: nv.length, overround: nv.length ? median(nv.map(function (m) { return m.novig.overround; })) : null,
      mains: mains
    };
  }

  /* ======================================================= PRICING */
  function priceOne(q, dist, distRaw, pushable) {
    var pr = probLine(dist, q.line), prr = distRaw ? probLine(distRaw, q.line) : pr;
    if (!pr) return null;
    var win = q.side === 'over' ? pr.over : pr.under, push = pushable ? pr.push : 0, loss = Math.max(0, 1 - win - push);
    var rwin = q.side === 'over' ? prr.over : prr.under;
    var be = 1 / q.decimal, cover = push < 1 ? win / (1 - push) : null;
    return {
      book: q.book, book_title: q.book_title, line: q.line, side: q.side, american: q.american, decimal: q.decimal, alt: q.alt,
      captured_at: q.captured_at, quoted_at: q.quoted_at, fresh: q.fresh,
      p_win: win, p_push: push, p_loss: loss, p_cover: cover, p_raw: rwin,
      implied: be, break_even: be, fair_american: fairAmerican(win, push),
      ev: expectedValue(win, q.american, push), ev_raw: expectedValue(rwin, q.american, pushable ? prr.push : 0),
      edge_pp: cover != null ? 100 * (cover - be) : null,
      risk_adj: null
    };
  }
  /* EV per unit of return volatility: profit is (d − 1) on a win, −1 on a loss, 0 on a push */
  function riskAdj(p) {
    if (!p || !isNum(p.ev)) return null;
    var b = p.decimal - 1, m2 = p.p_win * b * b + p.p_loss, v = m2 - p.ev * p.ev;
    return v > 1e-12 ? p.ev / Math.sqrt(v) : null;
  }
  function better(a, b) {           /* the better selection for the bettor: EV, then the line, then the most recent */
    if (!b) return true; if (!a) return false;
    if (Math.abs(a.ev - b.ev) > 1e-9) return a.ev > b.ev;
    if (a.line !== b.line) return a.side === 'over' ? a.line < b.line : a.line > b.line;
    return (ms(a.captured_at) || 0) > (ms(b.captured_at) || 0);
  }
  /* every (line, side) rung with the best price across books, the books that
     deal it, and its EV — the alternates ladder */
  function ladderOf(priced) {
    var rungs = {};
    priced.forEach(function (p) {
      var k = p.side + '|' + p.line, cur = rungs[k];
      if (!cur) rungs[k] = cur = { side: p.side, line: p.line, books: 0, best: null, alt: true };
      cur.books++;
      if (!p.alt) cur.alt = false;
      if (!cur.best || priceBetter(p.american, cur.best.american) || (p.american === cur.best.american && (ms(p.captured_at) || 0) > (ms(cur.best.captured_at) || 0))) cur.best = p;
    });
    return Object.keys(rungs).map(function (k) { var g = rungs[k]; return { side: g.side, line: g.line, books: g.books, main: !g.alt, best: g.best }; })
      .sort(function (x, y) { return (x.side < y.side ? -1 : x.side > y.side ? 1 : 0) || x.line - y.line; });
  }

  /* ======================================================= CONFIDENCE */
  function confidenceLabel(s) { var L = (decisionConfig().confidence || DECISION_FALLBACK.confidence).labels, i; for (i = 0; i < L.length; i++) if (s >= L[i][0]) return L[i][1]; return 'Very low'; }
  function calibrationOf(c) {
    var st = c && CONFIG.calibration_states[c.state] ? c.state : 'UNVALIDATED';
    var d = CONFIG.calibration_states[st];
    return { state: st, source: d.source, label: d.label, score: d.score, n: c && isNum(c.n) ? c.n : 0, ece: c && isNum(c.ece) ? c.ece : null };
  }
  function confidence(ctx) {
    var W = CONFIG.confidence_weights, c = {}, notes = [];
    var games = ctx.sample_games || 0;
    c.sample = clamp(games / 8, 0, 1) * (ctx.prior_games ? 0.85 : 1) + (ctx.prior_games ? 0.15 * clamp(ctx.prior_games / 8, 0, 1) : 0);
    if (games < 3) notes.push('only ' + games + ' game' + (games === 1 ? '' : 's') + ' this season');
    c.role = isNum(ctx.role_stability) ? clamp(ctx.role_stability, 0, 1) : 0.5;
    if (!isNum(ctx.role_stability)) notes.push('role stability not measurable');
    c.data = isNum(ctx.completeness) ? clamp(ctx.completeness, 0, 1) : 0.5;
    var nb = ctx.n_two_sided || 0;
    c.market = nb >= 5 ? 1 : nb >= 3 ? 0.8 : nb === 2 ? 0.65 : nb === 1 ? 0.4 : (ctx.n_books ? 0.25 : 0);
    var age = ctx.age_minutes;
    c.freshness = isNum(age) ? clamp(1 - 0.6 * age / CONFIG.max_quote_age_minutes, 0.3, 1) : 0.4;
    var st = String(ctx.player_status || '').toUpperCase();
    c.injury = st === 'QUESTIONABLE' ? 0.55 : st === 'DOUBTFUL' ? 0.25 : st === 'OUT' ? 0 : (ctx.report_on_file === false ? 0.7 : 1);
    if (ctx.teammate_uncertain) c.injury = Math.max(0, c.injury - 0.1);
    if (ctx.report_on_file === false) notes.push('no official injury report on file');
    var dis = isNum(ctx.disagreement_pp) ? Math.abs(ctx.disagreement_pp) : null;
    c.agreement = dis == null ? 0.6 : 1 - clamp((dis - 6) / 15, 0, 0.6);
    var hd = isNum(ctx.history_gap_pp) ? Math.abs(ctx.history_gap_pp) : null;
    c.history = hd == null ? 0.5 : 1 - clamp((hd - 10) / 30, 0, 0.6);
    c.calibration = calibrationOf(ctx.calibration).score;
    var s = 0, tw = 0;
    Object.keys(W).forEach(function (k) { s += W[k] * c[k]; tw += W[k]; });
    var score = Math.round(100 * s / tw);
    Object.keys(c).forEach(function (k) { c[k] = r(c[k], 3); });
    return { score: score, label: confidenceLabel(score), components: c, weights: W, notes: notes };
  }

  /* ======================================================= SIZING */
  function sizing(cand, conf, cal, ctx) {
    var S = decisionConfig().sizing, grid = S.grid || [0.25, 0.5, 0.75, 1], caps = [], tier = null, units = 0;
    var disagreeToward = isNum(ctx.disagreement_toward_pp) ? ctx.disagreement_toward_pp : 0;
    (S.tiers || []).forEach(function (t) {
      if (cand.edge_pp < t.min_edge_pp || cand.ev < t.min_ev || conf.score < t.min_confidence) return;
      if (t.require_gap && disagreeToward < CONFIG.strong_disagreement_pp) return;
      if (t.require_source && cal.source !== t.require_source) return;
      if (t.require_clean && ctx.material) return;
      tier = t; units = t.units;
    });
    if (!tier) return { units: 0, tier: null, caps: caps, kelly_units: null };
    var srcCap = (S.source_caps || {})[cal.source]; if (isNum(srcCap) && srcCap < units) { units = srcCap; caps.push({ code: 'PROBABILITY_SOURCE', units: srcCap, text: cal.label + ' caps the stake at ' + unitsText(srcCap) }); }
    if (ctx.single_book && CONFIG.caps.single_book_units < units) { units = CONFIG.caps.single_book_units; caps.push({ code: 'SINGLE_BOOK', units: units, text: 'one book deals this number: ' + unitsText(units) + ' cap' }); }
    if (ctx.material && CONFIG.caps.material_units < units) { units = CONFIG.caps.material_units; caps.push({ code: 'MATERIAL_UNCERTAINTY', units: units, text: 'open uncertainty (' + ctx.material + '): ' + unitsText(units) + ' cap' }); }
    var b = cand.decimal - 1, kf = S.kelly_fraction || 0.25, unitPct = S.unit_pct_of_bankroll || 0.01;
    var kelly = b > 0 ? kf * (cand.ev / b) / unitPct : 0;
    if (kelly < units) { caps.push({ code: 'KELLY', units: r(kelly, 2), text: 'quarter-Kelly at ' + priceText(cand.american) + ' allows ' + r(kelly, 2) + 'U' }); units = kelly; }
    var snapped = 0; grid.forEach(function (g) { if (g <= units + 1e-9) snapped = g; });
    return { units: Math.min(snapped, S.max_units || 1), tier: tier.key, caps: caps, kelly_units: r(kelly, 3) };
  }

  /* ======================================================= EVALUATE
     prop = { id, sport, game_id, player_id, player_name, team, opp, pos,
       market, kickoff, game_status, mapped, player_status {status, practice},
       report_on_file, projection { dist, sample_games, prior_games, role_stability,
       completeness, flags[], qb_change, teammate_uncertain }, quotes[], history
       { values[] } (the empirical check), context {…} (explanations) }
     opts = { now, calibration {state, n, ece}, market_weight } */
  var BLOCK_TEXT = {
    GAME_STARTED: 'The game has started: pregame props are closed.',
    GAME_CANCELLED: 'The game was cancelled or postponed.',
    PLAYER_UNMAPPED: 'The sportsbook name could not be matched to one player on either roster.',
    PLAYER_OUT: 'The player is ruled OUT: books void or pull this market.',
    NO_PROJECTION: 'EdgeDesk has no projection for this player and market (no usable history).',
    INVALID_DISTRIBUTION: 'The projection distribution failed its self-check.',
    UNSUPPORTED_MARKET: 'EdgeDesk has no distribution for this market.',
    NO_MARKET: 'No sportsbook price is on file for this prop.',
    STALE_QUOTE: 'Every captured price is past the 90-minute decision limit.'
  };
  function evaluate(prop, opts) {
    opts = opts || {};
    var now = opts.now != null ? ms(opts.now) : Date.now();
    var cal = calibrationOf(opts.calibration);
    var w = isNum(opts.market_weight) ? opts.market_weight : CONFIG.market_weight;
    var mdef = MARKETS[prop.market];
    var P = prop.projection || {};
    var out = {
      schema: SCHEMA, engine: VERSION, config: CONFIG.version, decision_config: decisionConfig().source,
      id: prop.id || null, market: prop.market, market_label: mdef ? mdef.label : prop.market,
      evaluated_at: new Date(now).toISOString(), blockers: [], warnings: [], caps: [], reasons: [],
      probability_source: cal.source, probability_label: cal.label, calibration: cal, market_weight: w
    };
    var norm = normalizeQuotes(prop.quotes || [], prop.market, now);
    out.refused = norm.refused;
    var quotes = norm.quotes;
    var fresh = quotes.filter(function (q) { return q.fresh.state !== 'STALE' && q.fresh.state !== 'FUTURE'; });
    var cons = consensusOf(quotes, now);
    if (!cons.n_books && quotes.length) {
      /* nothing fresh: the last numbers seen, for display only — never priced */
      var last = consensusOf(quotes, now, true);
      out.last_seen = { line: last.line, over: last.over, under: last.under, n_books: last.n_books, stale: true };
    }
    out.consensus = { line: cons.line, over: cons.over, under: cons.under, novig_over: r(cons.novig_over, 4), novig_under: r(cons.novig_under, 4),
      n_books: cons.n_books, n_two_sided: cons.n_two_sided, novig_books: cons.novig_books, overround: r(cons.overround, 4), dispersion: cons.dispersion };
    out.books = consensusOf(quotes, now, true).mains.map(function (m) { return { book: m.book, line: m.line, over: m.over, under: m.under, captured_at: m.captured_at, quoted_at: m.quoted_at, two_sided: m.two_sided, novig_over: m.novig ? r(m.novig.over, 4) : null }; });
    out.n_quotes = quotes.length; out.n_fresh = fresh.length;

    /* ---- Layer A: can EdgeDesk evaluate this prop at all? */
    var gs = String(prop.game_status || 'scheduled').toLowerCase();
    var kick = ms(prop.kickoff);
    if (gs === 'cancelled' || gs === 'postponed') out.blockers.push('GAME_CANCELLED');
    else if (gs === 'in_progress' || gs === 'final' || (kick != null && now >= kick)) out.blockers.push('GAME_STARTED');
    if (!mdef) out.blockers.push('UNSUPPORTED_MARKET');
    if (prop.mapped === false) out.blockers.push('PLAYER_UNMAPPED');
    if (String((prop.player_status || {}).status || '').toUpperCase() === 'OUT') out.blockers.push('PLAYER_OUT');
    var distRaw = P.dist && validDist(P.dist) ? P.dist : null;
    if (!P.dist) out.blockers.push('NO_PROJECTION'); else if (!distRaw) out.blockers.push('INVALID_DISTRIBUTION');
    if (!quotes.length) out.blockers.push('NO_MARKET');
    else if (!fresh.length) out.blockers.push('STALE_QUOTE');

    /* ---- the distributions: raw, market-implied, informed */
    var pushable = true;
    if (distRaw) {
      out.raw = summary(distRaw);
      /* the build solved this anchor already: reuse its scale when the
         consensus it solved for is unchanged (the browser stays fast) */
      /* each two-sided book at ITS OWN number implies a centre in the model's
         shape; the market's centre is their median (books that disagree on
         the line still agree on where the distribution sits) */
      var sig = cons.mains.filter(function (b) { return b.novig; }).map(function (b) { return b.book + ':' + b.line + ':' + r(b.novig.over, 5); }).join(',');
      var hint = P.anchor, implScale = null;
      if (hint && isNum(hint.scale) && hint.sig === sig) implScale = hint.scale;
      else if (sig && !out.blockers.length) {
        var scales = cons.mains.filter(function (b) { return b.novig; }).map(function (b) { return solveScale(distRaw, b.line, b.novig.over); }).filter(isNum);
        implScale = scales.length ? median(scales) : null;
      }
      out.anchor = implScale ? { sig: sig, scale: r(implScale, 6), books: cons.novig_books } : null;
      var rawMean = meanOf(distRaw);
      out.market_implied_mean = implScale ? r(rawMean * implScale, 2) : null;
      var f = implScale ? (1 - w) + w * implScale : 1;
      var distInf = implScale ? scaleDist(distRaw, f) : distRaw;
      out.informed = summary(distInf);
      out.informed_scale = r(f, 4);
      out.anchored = !!implScale;
      if (!implScale) out.warnings.push(quotes.length ? 'NO_MARKET_ANCHOR' : 'NO_MARKET');
      out.dist = distInf; out.dist_raw = distRaw;
      /* no book deals the consensus number: the market's no-vig there is read
         off the market-implied distribution, and labelled interpolated */
      if (isNum(cons.line) && cons.novig_over == null && implScale) {
        var pm = probLine(scaleDist(distRaw, implScale), cons.line);
        if (pm) { cons.novig_over = pm.over / Math.max(1e-9, pm.over + pm.under); cons.novig_under = 1 - cons.novig_over; out.consensus.novig_over = r(cons.novig_over, 4); out.consensus.novig_under = r(cons.novig_under, 4); out.consensus.novig_interpolated = true; }
      }
      if (isNum(cons.line)) {
        var pc = probLine(distInf, cons.line), pr0 = probLine(distRaw, cons.line);
        out.at_consensus = { line: cons.line, over: r(pc.over, 4), under: r(pc.under, 4), push: r(pc.push, 4), raw_over: r(pr0.over, 4), raw_under: r(pr0.under, 4),
          fair_over: fairAmerican(pc.over, pc.push), fair_under: fairAmerican(pc.under, pc.push),
          fair_line: out.informed ? out.informed.median : null };
        if (isNum(cons.novig_over)) out.disagreement_pp = r(100 * (pc.over / Math.max(1e-9, pc.over + pc.under) - cons.novig_over), 2);
      }
      if (prop.history && Array.isArray(prop.history.values) && prop.history.values.length >= 3 && isNum(cons.line)) {
        var emp = { family: 'empirical', values: prop.history.values, weights: prop.history.weights || null, bw: Math.max(1, (out.raw.sd || 1) * 0.35) };
        var pe = probLine(emp, cons.line);
        if (pe) { out.empirical_check = { over: r(pe.over, 4), under: r(pe.under, 4), n: prop.history.values.length, label: 'history check — context, not the model' }; out.history_gap_pp = r(100 * (pe.over - out.at_consensus.over), 2); }
      }
    }

    /* ---- every quote priced */
    var pricedFresh = [];
    if (distRaw && !out.blockers.length) {
      pricedFresh = fresh.map(function (q) { var p = priceOne(q, out.dist, distRaw, pushable); if (p) p.risk_adj = riskAdj(p); return p; }).filter(Boolean);
    }
    out.ladder = ladderOf(pricedFresh).map(function (g) {
      var b = g.best;
      return { side: g.side, line: g.line, main: g.main, books: g.books, book: b.book, american: b.american, implied: r(b.implied, 4),
        p_win: r(b.p_win, 4), p_push: r(b.p_push, 4), fair_american: b.fair_american, ev: r(b.ev, 4), ev_raw: r(b.ev_raw, 4), edge_pp: r(b.edge_pp, 2), captured_at: b.captured_at };
    });
    /* best EV per side, over every book and line; best raw price at the consensus line */
    var bestSide = { over: null, under: null }, bestPrice = { over: null, under: null };
    pricedFresh.forEach(function (p) {
      if (better(p, bestSide[p.side])) bestSide[p.side] = p;
      if (p.line === cons.line && (!bestPrice[p.side] || priceBetter(p.american, bestPrice[p.side].american))) bestPrice[p.side] = p;
    });
    var slim = function (p) { return p ? { book: p.book, line: p.line, side: p.side, american: p.american, alt: p.alt, p_win: r(p.p_win, 4), p_push: r(p.p_push, 4), p_raw: r(p.p_raw, 4), implied: r(p.implied, 4), fair_american: p.fair_american, ev: r(p.ev, 4), ev_raw: r(p.ev_raw, 4), edge_pp: r(p.edge_pp, 2), captured_at: p.captured_at, quoted_at: p.quoted_at, age_minutes: p.fresh.age_minutes, fresh: p.fresh.state } : null; };
    out.best_ev = { over: slim(bestSide.over), under: slim(bestSide.under) };
    out.best_price = { over: slim(bestPrice.over), under: slim(bestPrice.under) };
    var bestAll = better(bestSide.over, bestSide.under) ? bestSide.over : bestSide.under;
    out.best_value = slim(bestAll);

    /* ---- the decision candidate: inside the executable band, the highest
       class, then the best risk-adjusted EV (a far alternate at +600 is shown,
       never recommended over a comparable main line) */
    var W = CONFIG.decision_price_window, T = decisionConfig().thresholds;
    var klass = function (p) {
      if (!p || !isNum(p.ev) || p.ev <= 0) return 'PASS';
      if (p.edge_pp >= T.bet.min_edge_pp && p.ev >= T.bet.min_ev) return 'BET';
      if (p.edge_pp >= T.lean.min_edge_pp && p.ev > T.lean.min_ev) return 'LEAN';
      return 'WATCH';
    };
    var RANK = { PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
    var inBand = pricedFresh.filter(function (p) { return p.american >= W.min && p.american <= W.max; });
    var cand = null;
    inBand.forEach(function (p) {
      p._class = klass(p);
      /* LEAN needs the model and the price to point the same way: the
         informed median on this side of the consensus line (a plus-money
         alternate on the model's side agrees even with cover < 50%) */
      if (p._class === 'LEAN' && p.p_cover != null && p.p_cover < 0.5) {
        var med = out.informed ? out.informed.median : null, cl = isNum(cons.line) ? cons.line : p.line;
        var agrees = med != null && (p.side === 'over' ? med > cl : med < cl);
        if (!(p.american > 0 && agrees)) p._class = 'WATCH';
      }
      if (!cand || RANK[p._class] > RANK[cand._class] || (RANK[p._class] === RANK[cand._class] && (p.risk_adj || -9) > (cand.risk_adj || -9))) cand = p;
    });
    out.candidate = slim(cand);
    out.candidate_class = cand ? cand._class : null;

    /* ---- facts the caps, confidence and explanations read */
    var sampleGames = num(P.sample_games) || 0;
    var single = cand ? pricedFresh.filter(function (p) { return p.side === cand.side && p.line === cand.line; }).length < 2 : false;
    var disToward = null;
    if (cand && out.at_consensus && isNum(cons.novig_over)) {
      var pSide = cand.side === 'over' ? out.at_consensus.over : out.at_consensus.under, nvSide = cand.side === 'over' ? cons.novig_over : cons.novig_under;
      disToward = r(100 * (pSide / Math.max(1e-9, out.at_consensus.over + out.at_consensus.under) - nvSide), 2);
    }
    out.disagreement_toward_pp = disToward;
    var st = String((prop.player_status || {}).status || '').toUpperCase();
    var material = [];
    if (st === 'QUESTIONABLE' || st === 'DOUBTFUL') material.push('player ' + st.toLowerCase());
    if (P.qb_change) material.push('starting QB change');
    if (P.teammate_uncertain) material.push('teammate status unresolved');
    var conf = confidence({ sample_games: sampleGames, prior_games: num(P.prior_games) || 0, role_stability: P.role_stability, completeness: P.completeness,
      n_two_sided: cons.n_two_sided, n_books: cons.n_books, age_minutes: cand ? cand.fresh.age_minutes : null, player_status: st,
      report_on_file: prop.report_on_file, teammate_uncertain: !!P.teammate_uncertain, disagreement_pp: out.disagreement_pp,
      history_gap_pp: out.history_gap_pp, calibration: opts.calibration });
    out.confidence = conf;

    /* ---- Layer B */
    var decision, code;
    if (out.blockers.length) { decision = 'NO_DECISION'; code = out.blockers[0]; }
    else if (!cand) { decision = 'PASS'; code = 'NO_EXECUTABLE_PRICE'; }
    else {
      decision = cand._class; code = decision === 'BET' ? 'QUALIFIES' : decision === 'LEAN' ? 'EDGE_BELOW_BET' : decision === 'WATCH' ? 'EDGE_TOO_SMALL' : (cand.ev <= 0 && cand.ev_raw > 0 ? 'MARKET_INFORMED_EV_NEGATIVE' : 'NO_POSITIVE_EV');
      var capTo = function (cls, c, text) {
        if (RANK[decision] > RANK[cls]) { out.caps.push({ code: c, to: cls, text: text }); decision = cls; code = c; }
        else out.warnings.push(c);
      };
      /* the order is the severity: availability, anomaly, then quality */
      if (decision === 'BET' || decision === 'LEAN') {
        if (st === 'QUESTIONABLE' || st === 'DOUBTFUL') capTo('WATCH', 'AVAILABILITY_PENDING', 'The player is ' + st.toLowerCase() + ': wait for the final status.');
        if (P.qb_change && P.qb_unconfirmed && mdef && (mdef.cat === 'passing' || mdef.cat === 'receiving')) capTo('WATCH', 'QB_UNRESOLVED', 'The starting quarterback is unconfirmed after a change: wait for confirmation.');
        var extreme = cand.ev >= CONFIG.anomaly.ev || cand.edge_pp >= CONFIG.anomaly.edge_pp;
        if (extreme) {
          /* a second book at this number within a few cents (decimal payout) */
          var corro = pricedFresh.filter(function (p) { return p.side === cand.side && p.book !== cand.book && p.line === cand.line && (cand.decimal - p.decimal) * 100 <= CONFIG.anomaly.corroborate_cents; }).length;
          if (!corro) capTo('WATCH', 'PRICE_ANOMALY', 'An extreme EV that no second book corroborates: verify the price before acting.');
        }
        if (conf.score < CONFIG.caps.min_confidence) capTo('LEAN', 'LOW_CONFIDENCE', 'Decision confidence ' + conf.score + ' is below ' + CONFIG.caps.min_confidence + '.');
        if (sampleGames < CONFIG.caps.min_games) capTo('LEAN', 'THIN_SAMPLE', 'Fewer than ' + CONFIG.caps.min_games + ' games this season.');
        if (isNum(P.role_stability) && P.role_stability < CONFIG.caps.role_stability) capTo('LEAN', 'ROLE_UNSTABLE', 'The player\'s role has moved sharply over recent games.');
        if (cand.p_cover != null && cand.p_cover < 0.5) capTo('LEAN', 'TAIL_ALTERNATE', 'An alternate beyond EdgeDesk\'s median: distribution tails are the least validated part of the model.');
        if (cons.n_two_sided < 1) capTo('LEAN', 'ONE_SIDED_MARKET', 'No book deals both sides: there is no no-vig anchor.');
        if (!out.anchored) capTo('LEAN', 'NO_MARKET_ANCHOR', 'No two-sided consensus to anchor the market-informed projection.');
        if (single && cons.n_books < 2) capTo('LEAN', 'SINGLE_BOOK', 'Only one sportsbook is quoting this player.');
      }
      if (decision === 'WATCH' && !out.caps.length) {
        /* a WATCH on price must have a realistic trigger; else it is a PASS */
        var trig = triggerFor(cand, out.dist, pushable, prop.market);
        out.trigger = trig;
        if (!trig || !trig.realistic) { decision = 'PASS'; code = 'EDGE_TOO_SMALL'; }
      } else if (decision !== 'BET' && cand && cand._class !== 'BET') {
        out.trigger = triggerFor(cand, out.dist, pushable, prop.market);
      }
    }
    out.decision = decision; out.code = code;
    var V = VOC(), dv = V && V.DECISION ? V.DECISION[decision === 'NO_DECISION' ? 'NO_DECISION' : decision] : null;
    out.decision_label = dv ? dv.label : decision.replace('_', ' ');
    out.tone = dv ? dv.tone : ({ BET: 'bet', LEAN: 'lean', WATCH: 'watch', PASS: 'pass' })[decision] || 'none';
    out.blocker_text = out.blockers.length ? BLOCK_TEXT[out.blockers[0]] : null;

    /* ---- units (BET only), dollars from the reader's unit */
    out.units = 0; out.tier = null;
    if (decision === 'BET' && cand) {
      var sz = sizing(cand, conf, cal, { disagreement_toward_pp: disToward, single_book: single, material: material.length ? material.join(', ') : null });
      out.units = sz.units; out.tier = sz.tier; out.kelly_units = sz.kelly_units;
      sz.caps.forEach(function (c) { out.caps.push(c); });
      if (!sz.units) { out.decision = 'PASS'; out.code = 'SIZING_ZERO'; out.tone = 'pass'; out.decision_label = 'PASS'; }
    }
    out.value_score = valueScore(out, P);
    out.selection = cand ? selectionText(prop.market, cand.side, cand.line) : null;
    out.id_hash = 'ppe_' + hash([prop.id, out.decision, cand && cand.book, cand && cand.line, cand && cand.side, cand && cand.american, r(out.informed && out.informed.mean, 2), out.evaluated_at.slice(0, 13)]);
    delete out.dist; delete out.dist_raw;
    out._dist = distRaw ? { raw: distRaw, informed: scaleDist(distRaw, out.informed_scale || 1) } : null;
    return out;
  }
  /* the price at this line, or the line at this price, at which the
     candidate clears BET — named only when realistic */
  function triggerFor(cand, dist, pushable, market) {
    if (!cand || !dist) return null;
    var T = decisionConfig().thresholds, m = CONFIG.watch;
    var clears = function (line, american) { var p = priceOne({ book: cand.book, line: line, side: cand.side, american: american, decimal: toDecimal(american), fresh: cand.fresh }, dist, null, pushable); return p && p.edge_pp >= T.bet.min_edge_pp && p.ev >= T.bet.min_ev; };
    var price = null, a = cand.american, i;
    for (i = 1; i <= 100; i++) { a = stepPrice(a, 1); if (a == null) break; if (clears(cand.line, a)) { price = a; break; } }
    var step = 0.5, line = null, L = cand.line;
    for (i = 1; i <= 40; i++) { L = cand.side === 'over' ? L - step : L + step; if (L < 0) break; if (clears(L, cand.american)) { line = L; break; } }
    var cents = price != null ? Math.abs(toDecimal(price) - cand.decimal) * 100 : null;
    var md = MARKETS[market], ydsLike = md ? !!md.yardage || market === 'kicking_pts' || market === 'fantasy_pts' : cand.line > 12;
    var ptsWin = ydsLike ? m.yards_points : m.count_points;
    var realistic = (price != null && cents <= m.cents) || (line != null && Math.abs(line - cand.line) <= ptsWin);
    return { price: price, line: line, realistic: realistic,
      text: (price != null || line != null) ? 'becomes BET at ' + [price != null ? selSide(cand) + ' ' + cand.line + ' ' + priceText(price) : null, line != null ? selSide(cand) + ' ' + line + ' ' + priceText(cand.american) : null].filter(Boolean).join(' or ') + (realistic ? '' : ' (not a realistic move)') : 'no BET trigger within reach' };
  }
  function selSide(c) { return c.side === 'over' ? 'O' : 'U'; }

  /* the evaluation as a board row carries it — what the list needs to paint,
     filter and sort before (or without) re-pricing. The build writes it; the
     page produces the same shape from a fresh evaluate(). */
  function compact(ev) {
    var sum = function (s) { return s ? [s.mean, s.median, s.p25, s.p75, s.sd] : null; };
    var c = ev.candidate, bv = ev.best_value;
    var o = { d: ev.decision, c: ev.code, u: ev.units || 0, cf: ev.confidence ? ev.confidence.score : null, v: ev.value_score,
      raw: sum(ev.raw), inf: sum(ev.informed), mm: ev.market_implied_mean != null ? ev.market_implied_mean : null };
    if (ev.tier) o.t = ev.tier;
    if (c) o.cand = [c.side, c.line, c.american, c.book, r(c.p_win, 4), r(c.p_push, 4), r(c.ev, 4), r(c.ev_raw, 4), c.edge_pp, c.fair_american, c.alt ? 1 : 0, c.captured_at || null];
    if (bv && (!c || bv.book !== c.book || bv.line !== c.line || bv.side !== c.side || bv.american !== c.american)) o.bv = [bv.side, bv.line, bv.american, bv.book, r(bv.ev, 4)];
    if (ev.consensus && ev.consensus.n_books) o.cons = [ev.consensus.line, ev.consensus.over, ev.consensus.under, ev.consensus.novig_over, ev.consensus.n_books, ev.consensus.n_two_sided, ev.consensus.novig_interpolated ? 1 : 0];
    if (ev.at_consensus) o.ac = [ev.at_consensus.over, ev.at_consensus.under, ev.at_consensus.push, ev.at_consensus.fair_over, ev.at_consensus.fair_under, ev.at_consensus.raw_over];
    if (ev.disagreement_pp != null) o.dp = ev.disagreement_pp;
    if (ev.caps && ev.caps.length) o.caps = ev.caps.map(function (x) { return x.code; });
    if (ev.warnings && ev.warnings.length) o.w = ev.warnings;
    if (ev.blockers && ev.blockers.length) o.b = ev.blockers;
    if (ev.last_seen) o.ls = [ev.last_seen.line, ev.last_seen.over, ev.last_seen.under];
    return o;
  }

  /* ======================================================= VALUE SCORE
     BEST VALUE ranks research quality, not EV: the class first, then EV and
     confidence, discounted for what could make the number wrong. */
  function valueScore(ev, P) {
    var cand = ev.candidate;
    if (!cand || ev.decision === 'NO_DECISION') return 0;
    var cls = { BET: 3, LEAN: 2, WATCH: 1, PASS: 0 }[ev.decision] || 0;
    var e = clamp(cand.ev || 0, -0.2, 0.25), c = (ev.confidence && ev.confidence.score || 0) / 100;
    var liq = clamp((ev.consensus.n_two_sided || 0) / 4, 0.25, 1);
    var fresh = cand.fresh === 'FRESH' ? 1 : cand.fresh === 'AGING' ? 0.8 : 0.4;
    var sample = clamp((num(P && P.sample_games) || 0) / 6, 0.3, 1);
    var role = isNum(P && P.role_stability) ? clamp(0.5 + P.role_stability / 2, 0.5, 1) : 0.75;
    var inj = /QUESTIONABLE|DOUBTFUL/.test(String(ev.warnings.concat(ev.caps.map(function (x) { return x.code; })).join(' '))) ? 0.7 : 1;
    var s = cls * 100 + 1000 * Math.max(e, 0) * c * liq * fresh * sample * role * inj + 10 * c;
    return r(s, 3);
  }

  /* ======================================================= STAKE */
  function stake(units, settings, american) {
    var B = BANK(), usd = null, unit = null;
    if (B && settings) {
      try { var s = B.normalize ? B.normalize(settings) : settings; var uv = B.unitValue(s); unit = uv && isNum(uv.unit) ? uv.unit : null; usd = isNum(units) && units > 0 ? B.dollars(units, s) : null; } catch (e) { usd = null; }
    }
    var d = toDecimal(american);
    return { units: units, unit_value: unit, stake: usd, to_win: usd != null && d != null ? Math.round(usd * (d - 1) * 100) / 100 : null };
  }
  function evDollars(ev, units, unitValue) { return isNum(ev) && isNum(units) && isNum(unitValue) ? Math.round(ev * units * unitValue * 100) / 100 : null; }

  /* ======================================================= HISTORY (context)
     logs: [{ season, week, date, opp, home (bool), value, played }] newest
     LAST. similar: opponents whose defence ranks within ±6 of this opponent's
     in the relevant metric. Never a probability. */
  function hitRates(logs, line, side, opts) {
    opts = opts || {};
    var played = (logs || []).filter(function (g) { return g && g.played !== false && isNum(g.value); });
    var tally = function (rows) {
      var h = 0, p = 0, n = rows.length, s = 0;
      rows.forEach(function (g) { var v = g.value; s += v; if (Math.abs(v - line) < EPS) p++; else if (side === 'under' ? v < line : v > line) h++; });
      var dec = n - p;
      return { hits: h, pushes: p, n: n, pct: dec > 0 ? r(h / dec, 3) : null, avg: n ? r(s / n, 1) : null };
    };
    var cur = opts.season != null ? played.filter(function (g) { return g.season === opts.season; }) : played;
    var sim = opts.similar ? played.filter(function (g) { return opts.similar.indexOf(g.opp) >= 0; }) : null;
    return {
      label: 'Historical hit rate — context only, not EdgeDesk\'s probability',
      line: line, side: side,
      L5: tally(played.slice(-5)), L10: tally(played.slice(-10)), season: tally(cur),
      home: tally(cur.filter(function (g) { return g.home === true; })), away: tally(cur.filter(function (g) { return g.home === false; })),
      vs_opp: opts.opp ? tally(played.filter(function (g) { return g.opp === opts.opp; })) : null,
      similar: sim ? tally(sim) : null
    };
  }

  /* ======================================================= EXPLANATIONS
     Deterministic sentences from structured facts. `f` (from the model):
       proj, line, stat_label, share {now, before, label}, snaps {now, before},
       opp {name, metric, value, rank, n_teams, favorable}, implied_pts,
       league_implied, spread, script, best {american, book}, consensus_price,
       teammates_out [{name, pos, delta, label}], teammate_returned {name},
       wind, qb_change {from, to}, status, sd, sample_games, history {hits, n} */
  function explain(ev, f, side) {
    f = f || {}; side = side || (ev.candidate ? ev.candidate.side : 'over');
    var why = [], risks = [], up = side === 'over';
    var mk = MARKETS[ev.market] || { label: ev.market };
    var inf = ev.informed, raw = ev.raw;
    if (raw && isNum(f.line)) {
      var gap = raw.mean - f.line;
      if ((gap > 0) === up && Math.abs(gap) >= 0.01) why.push('EdgeDesk projects ' + fmtStat(raw.mean, ev.market) + ' ' + mk.label.toLowerCase() + ' vs the ' + f.line + ' line' + (inf && Math.abs(inf.mean - raw.mean) >= 0.05 ? ' (market-informed ' + fmtStat(inf.mean, ev.market) + ')' : '') + '.');
      else if (Math.abs(gap) >= 0.01) risks.push('EdgeDesk\'s raw projection (' + fmtStat(raw.mean, ev.market) + ') sits on the other side of ' + f.line + '.');
    }
    if (f.share && isNum(f.share.now) && isNum(f.share.before) && Math.abs(f.share.now - f.share.before) >= 0.05) {
      var rose = f.share.now > f.share.before, s = f.share.label + ' has ' + (rose ? 'risen' : 'fallen') + ' from ' + pc0(f.share.before) + ' to ' + pc0(f.share.now) + ' over the last three games.';
      (rose === up ? why : risks).push(s);
    }
    if (f.snaps && isNum(f.snaps.now) && isNum(f.snaps.before) && Math.abs(f.snaps.now - f.snaps.before) >= 0.08) {
      var sr = f.snaps.now > f.snaps.before;
      (sr === up ? why : risks).push('Snap share ' + (sr ? 'up' : 'down') + ' from ' + pc0(f.snaps.before) + ' to ' + pc0(f.snaps.now) + ' (last three games).');
    }
    if (f.opp && f.opp.rank && f.opp.n_teams) {
      var third = f.opp.n_teams / 3, good = f.opp.favorable;
      var txt = f.opp.name + ' ranks ' + ord(f.opp.rank) + ' of ' + f.opp.n_teams + ' in ' + f.opp.metric + (f.opp.value_text ? ' (' + f.opp.value_text + ')' : '') + '.';
      if (good === true && f.opp.rank > f.opp.n_teams - third) (up ? why : risks).push(txt);
      else if (good === false && f.opp.rank <= third) (up ? risks : why).push(txt);
    }
    if (isNum(f.implied_pts) && isNum(f.league_implied) && /td|yds|rec|att|cmp/.test(ev.market)) {
      var hi = f.implied_pts >= f.league_implied + 2.5, lo = f.implied_pts <= f.league_implied - 2.5;
      if (hi || lo) (hi === up ? why : risks).push('Team implied total ' + f.implied_pts.toFixed(1) + ' (' + (hi ? 'above' : 'below') + ' the league\'s ' + f.league_implied.toFixed(1) + ').');
    }
    if (isNum(f.spread) && Math.abs(f.spread) >= 6.5) {
      var fav = f.spread < 0, runMkt = /rush/.test(ev.market), passMkt = /pass|rec|target/.test(ev.market);
      if (runMkt) (fav === up ? why : risks).push(fav ? 'Favoured by ' + Math.abs(f.spread) + ': a positive rushing script is likely.' : 'The team could trail early: ' + Math.abs(f.spread) + '-point underdog.');
      else if (passMkt) (fav === up ? risks : why).push(fav ? 'A ' + Math.abs(f.spread) + '-point favourite may lean on the run late.' : 'A ' + Math.abs(f.spread) + '-point underdog tends to throw more when behind.');
    }
    if (ev.candidate && isNum(f.consensus_price) && ev.candidate.side === side && priceBetter(ev.candidate.american, f.consensus_price) && ev.candidate.line === ev.consensus.line) {
      why.push('Best available price is ' + priceText(ev.candidate.american) + ' (' + bookName(ev.candidate.book) + ') vs ' + priceText(f.consensus_price) + ' consensus.');
    }
    (f.teammates_out || []).forEach(function (t) {
      if (!isNum(t.delta) || Math.abs(t.delta) < 0.01) return;
      (t.delta > 0 === up ? why : risks).push(t.name + ' (' + t.pos + ') is ' + (t.status || 'OUT') + ': projected ' + t.label + ' ' + (t.delta > 0 ? '+' : '−') + Math.abs(100 * t.delta).toFixed(1) + ' pp (a projected adjustment).');
    });
    if (f.teammate_returned) (up ? risks : why).push(f.teammate_returned.name + ' (' + f.teammate_returned.pos + ') is back after missing recent games: the workload may be shared again.');
    if (isNum(f.wind) && f.wind >= 15 && /pass|rec|long|kick|fg/.test(ev.market)) (up ? risks : why).push('Wind forecast ' + Math.round(f.wind) + ' mph: passing and kicking efficiency drop.');
    if (f.qb_change) risks.push('Starting quarterback change (' + (f.qb_change.from || 'previous starter') + ' → ' + (f.qb_change.to || 'new starter') + '): passing volume and efficiency are less certain.');
    var stt = String(f.status || '').toUpperCase();
    if (stt === 'QUESTIONABLE' || stt === 'DOUBTFUL') risks.push('Listed ' + stt + (f.practice ? ' (' + f.practice + ')' : '') + '.');
    if (isNum(ev.disagreement_pp) && Math.abs(ev.disagreement_pp) >= 10) risks.push('EdgeDesk is ' + Math.abs(ev.disagreement_pp).toFixed(1) + ' pp from the no-vig market: the books may be pricing information the model does not see.');
    if (isNum(f.sample_games) && f.sample_games < 3) risks.push('Only ' + f.sample_games + ' game' + (f.sample_games === 1 ? '' : 's') + ' of this season\'s data: projection uncertainty is elevated.');
    else if (raw && isNum(raw.sd) && raw.mean > 0 && raw.sd / raw.mean > 0.75) risks.push('Wide outcome range (P25 ' + raw.p25 + ' – P75 ' + raw.p75 + '): projection uncertainty remains elevated.');
    if (ev.candidate && ev.candidate.fresh === 'AGING') risks.push('The best price is ' + Math.round(ev.candidate.age_minutes) + ' minutes old.');
    if (ev.consensus && ev.consensus.n_books === 1) risks.push('Only one sportsbook is quoting this prop.');
    if (f.history && isNum(f.history.n) && f.history.n >= 5) {
      var hs = 'History (context only): ' + (up ? 'over' : 'under') + ' ' + f.line + ' in ' + f.history.hits + ' of the last ' + f.history.n + '.';
      (f.history.hits / Math.max(1, f.history.n) >= 0.5 ? why : risks).push(hs);
    }
    return { side: side, why: why.slice(0, 8), risks: risks.slice(0, 8) };
  }
  function pc0(x) { return Math.round(100 * x) + '%'; }
  function ord(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function fmtStat(v, market) { if (!isNum(v)) return '—'; var m = MARKETS[market]; return (m && m.yardage) || v >= 20 ? v.toFixed(1) : v.toFixed(2); }
  var BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars', espnbet: 'ESPN BET', betrivers: 'BetRivers', hardrockbet: 'Hard Rock', fanatics: 'Fanatics', pinnacle: 'Pinnacle', bovada: 'Bovada', betonlineag: 'BetOnline', mybookieag: 'MyBookie', lowvig: 'LowVig', ballybet: 'Bally Bet', betparx: 'betPARX', pointsbetus: 'PointsBet', unibet_us: 'Unibet', superbook: 'SuperBook', wynnbet: 'WynnBET', prizepicks: 'PrizePicks', underdog: 'Underdog' };
  function bookName(k) { return BOOKS[k] || (k ? String(k).replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '—'); }
  var BOOK_ABBR = { draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM', williamhill_us: 'CZR', caesars: 'CZR', espnbet: 'ESPN', betrivers: 'BR', hardrockbet: 'HR', fanatics: 'FAN', pinnacle: 'PIN', bovada: 'BOV', betonlineag: 'BOL' };
  function bookAbbr(k) { return BOOK_ABBR[k] || String(k || '').slice(0, 4).toUpperCase(); }

  /* ======================================================= STATISTICS
     The settlement statistic of a market from one player-game row (the
     pipeline's log columns: att cmp pyd ptd int plng car ryd rtd rlng tgt rec
     yd td lng st_td fgm xpm tkl ast dsk dint fp). Books settle anytime-TD on
     every touchdown the player scores (rushing, receiving, returns), never a
     touchdown pass. A longest-play market with no play is 0. */
  function statOf(market, l) {
    if (!l) return null;
    var n = function (v) { return isNum(v) ? v : 0; };
    switch (market) {
      case 'pass_yds': return n(l.pyd); case 'pass_att': return n(l.att); case 'pass_cmp': return n(l.cmp); case 'pass_tds': return n(l.ptd); case 'pass_ints': return n(l.int);
      case 'pass_long': return l.plng != null ? l.plng : (n(l.cmp) === 0 ? 0 : null);
      case 'rush_yds': return n(l.ryd); case 'rush_att': return n(l.car); case 'rush_tds': return n(l.rtd);
      case 'rush_long': return l.rlng != null ? l.rlng : (n(l.car) === 0 ? 0 : null);
      case 'rec_yds': return n(l.yd); case 'receptions': return n(l.rec); case 'targets': return l.tgt != null ? l.tgt : null; case 'rec_tds': return n(l.td);
      case 'rec_long': return l.lng != null ? l.lng : (n(l.rec) === 0 ? 0 : null);
      case 'rush_rec_yds': return n(l.ryd) + n(l.yd); case 'pass_rush_yds': return n(l.pyd) + n(l.ryd);
      case 'anytime_td': case 'tds_over': return n(l.rtd) + n(l.td) + n(l.st_td);
      case 'fg_made': return n(l.fgm); case 'kicking_pts': return 3 * n(l.fgm) + n(l.xpm);
      case 'tackles_ast': return n(l.tkl) + n(l.ast); case 'solo_tackles': return n(l.tkl); case 'sacks': return n(l.dsk); case 'def_ints': return n(l.dint);
      case 'fantasy_pts': return isNum(l.fp) ? l.fp : null;
      case 'first_td': return l.first_td != null ? l.first_td : null;
    }
    return null;
  }
  /* the structured facts explain() reads, from a board's shared tables:
     player { shares, status, sample_games, teammates_out, teammate_returned,
     qb_change }, env { margin, implied, wind }, lead { name, metric, rank, of,
     favorable }, hist { hits, n } */
  function factsFor(o) {
    var m = o.market, c = MARKETS[m] ? MARKETS[m].cat : null, pl = o.player || {}, sh = pl.shares || {}, env = o.env || {};
    var share = null;
    if ((c === 'rushing' || m === 'rush_rec_yds') && sh.car && isNum(sh.car.now)) share = { now: sh.car.now, before: sh.car.season, label: 'Carry share' };
    else if (c === 'receiving' && sh.tgt && isNum(sh.tgt.now)) share = { now: sh.tgt.now, before: sh.tgt.season, label: o.no_targets ? 'Reception share' : 'Target share' };
    return {
      line: o.line, stat_label: MARKETS[m] ? MARKETS[m].label : m, share: share,
      snaps: sh.snaps && isNum(sh.snaps.now) ? { now: sh.snaps.now, before: sh.snaps.season } : null,
      opp: o.lead || null, implied_pts: isNum(env.implied) ? env.implied : null, league_implied: isNum(o.league_implied) ? o.league_implied : null,
      spread: isNum(env.margin) ? -env.margin : null, consensus_price: o.consensus_price != null ? o.consensus_price : null,
      teammates_out: pl.teammates_out || [], teammate_returned: pl.teammate_returned || null, wind: isNum(env.wind) ? env.wind : null,
      qb_change: pl.qb_change || null, status: pl.status ? pl.status.status : null, practice: pl.status ? pl.status.practice : null,
      sample_games: isNum(pl.sample_games) ? pl.sample_games : null, history: o.hist || null
    };
  }

  /* ======================================================= SETTLEMENT
     result = { played (bool), value (number), void_reason } → WIN / LOSS / PUSH / VOID */
  function settle(market, line, side, result) {
    var m = MARKETS[market];
    if (!m) return { result: 'VOID', reason: 'unsupported market' };
    if (!result || result.void_reason) return { result: 'VOID', reason: result && result.void_reason ? result.void_reason : 'no result' };
    if (result.played === false) return { result: 'VOID', reason: 'player did not play' };
    var v = num(result.value); side = sideOf(side);
    if (v == null) return { result: 'VOID', reason: 'statistic not on file' };
    if (Math.abs(v - line) < EPS) return { result: 'PUSH', value: v };
    var over = v > line;
    return { result: (side === 'over') === over ? 'WIN' : 'LOSS', value: v };
  }
  function unitsWon(res, american, units) {
    var d = toDecimal(american); if (d == null || !isNum(units)) return null;
    if (res === 'WIN') return r(units * (d - 1), 4);
    if (res === 'LOSS') return -units;
    return 0;
  }
  /* entry { side, line, american } vs close { line, over, under } (the
     consensus close) — line CLV for any close; price and no-vig CLV only at
     the same number. Nothing is invented when the close is missing. */
  function clv(entry, close) {
    if (!entry || !close || !isNum(close.line)) return { available: false, reason: 'no closing line on file' };
    var up = entry.side === 'over';
    var out = { available: true, close_line: close.line, line_clv: r(up ? close.line - entry.line : entry.line - close.line, 2) };
    var cp = up ? close.over : close.under;
    if (close.line === entry.line && isNum(cp)) {
      out.close_price = cp;
      out.price_clv_cents = r((toDecimal(entry.american) - toDecimal(cp)) * 100, 1);
      var nv = isNum(close.over) && isNum(close.under) ? noVig(close.over, close.under) : null;
      if (nv) { var pClose = up ? nv.over : nv.under; out.close_novig = r(pClose, 4); out.prob_clv_pp = r(100 * (pClose - implied(entry.american)), 2); }
    }
    out.beat_close = out.prob_clv_pp != null ? out.prob_clv_pp > 0 : (out.line_clv !== 0 ? out.line_clv > 0 : null);
    return out;
  }

  /* ======================================================= PERFORMANCE */
  function bucketOf(x, B) { var i; if (!isNum(x)) return null; for (i = 0; i < B.length; i++) if (x >= B[i][0] && x < B[i][1]) return B[i][2]; return null; }
  function sampleState(n) {
    var V = root && root.EDValidation; if (V && typeof V.sampleState === 'function') { try { return V.sampleState(n); } catch (e) { /* fall through */ } }
    return n < 50 ? { key: 'DESCRIPTIVE', label: 'too early (n < 50)' } : n < 200 ? { key: 'EARLY', label: 'early signal' } : n < 500 ? { key: 'MODERATE', label: 'developing' } : { key: 'STRONGER', label: 'meaningful' };
  }
  /* rows: graded evaluations { decision, units, american, result, units_won,
     ev, confidence, market, position, sport, p_side, clv {…} } */
  function summarize(rows) {
    var g = rows.filter(function (x) { return x.result === 'WIN' || x.result === 'LOSS' || x.result === 'PUSH'; });
    var w = 0, l = 0, p = 0, risked = 0, won = 0, ev = 0, nev = 0, clvN = 0, clvS = 0, beat = 0, beatN = 0, lineN = 0, lineS = 0;
    g.forEach(function (x) {
      if (x.result === 'WIN') w++; else if (x.result === 'LOSS') l++; else p++;
      var u = isNum(x.units) && x.units > 0 ? x.units : 1;
      risked += x.result === 'PUSH' ? 0 : u;
      won += isNum(x.units_won) ? x.units_won : (unitsWon(x.result, x.american, u) || 0);
      if (isNum(x.ev)) { ev += x.ev; nev++; }
      if (x.clv && isNum(x.clv.prob_clv_pp)) { clvS += x.clv.prob_clv_pp; clvN++; }
      if (x.clv && isNum(x.clv.line_clv)) { lineS += x.clv.line_clv; lineN++; }
      if (x.clv && x.clv.beat_close != null) { beatN++; if (x.clv.beat_close) beat++; }
    });
    return { n: g.length, wins: w, losses: l, pushes: p, units: r(won, 2), risked: r(risked, 2), roi: risked > 0 ? r(won / risked, 4) : null,
      win_rate: w + l > 0 ? r(w / (w + l), 4) : null, avg_ev: nev ? r(ev / nev, 4) : null,
      avg_prob_clv_pp: clvN ? r(clvS / clvN, 2) : null, avg_line_clv: lineN ? r(lineS / lineN, 2) : null,
      beat_close_rate: beatN ? r(beat / beatN, 4) : null, clv_n: Math.max(clvN, lineN), sample: sampleState(g.length) };
  }
  function breakdown(rows, keyFn) {
    var groups = {};
    rows.forEach(function (x) { var k = keyFn(x); if (k == null) return; (groups[k] = groups[k] || []).push(x); });
    return Object.keys(groups).sort().map(function (k) { var s = summarize(groups[k]); s.key = k; return s; });
  }
  /* predicted probability of the side evaluated vs the observed hit rate,
     pushes and voids excluded; folded so every row reads ≥ 50% */
  function calibration(rows) {
    var B = CONFIG.prob_buckets, acc = {};
    var pts = [];
    rows.forEach(function (x) {
      if (x.result !== 'WIN' && x.result !== 'LOSS') return;
      var p = num(x.p_side); if (p == null) return;
      var hit = x.result === 'WIN' ? 1 : 0;
      if (p < 0.5) { p = 1 - p; hit = 1 - hit; }
      pts.push([p, hit]);
      var b = bucketOf(p, B); if (!b) return;
      var a = acc[b] || (acc[b] = { bucket: b, n: 0, sp: 0, hits: 0 }); a.n++; a.sp += p; a.hits += hit;
    });
    var table = B.map(function (b) { var a = acc[b[2]] || { bucket: b[2], n: 0, sp: 0, hits: 0 }; return { bucket: b[2], n: a.n, expected: a.n ? r(a.sp / a.n, 4) : null, observed: a.n ? r(a.hits / a.n, 4) : null, gap_pp: a.n ? r(100 * (a.hits - a.sp) / a.n, 2) : null }; });
    var brier = pts.length ? pts.reduce(function (s, q) { return s + (q[0] - q[1]) * (q[0] - q[1]); }, 0) / pts.length : null;
    var ece = pts.length ? table.reduce(function (s, t) { return s + (t.n ? t.n * Math.abs(t.observed - t.expected) : 0); }, 0) / pts.length : null;
    return { n: pts.length, brier: r(brier, 5), ece: r(ece, 5), table: table, sample: sampleState(pts.length) };
  }
  /* promotion is automatic and one-way per build: the ledger, never a person */
  function calibrationState(cal, clvSummary) {
    var n = cal ? cal.n : 0, e = cal ? cal.ece : null;
    if (n >= 1000 && e != null && e <= 0.02 && clvSummary && isNum(clvSummary.avg_prob_clv_pp) && clvSummary.avg_prob_clv_pp > 0) return 'CALIBRATED';
    if (n >= 500 && e != null && e <= 0.03) return 'PARTIAL';
    if (n >= 200) return 'EARLY';
    return 'UNVALIDATED';
  }

  /* ======================================================= MOVEMENT
     series: [[t, line, over, under], …] oldest first → opening, current, the
     move in the line and the price. Described, never attributed. */
  function movement(series, side) {
    var s = (series || []).filter(function (x) { return x && isNum(x[1]); });
    if (!s.length) return null;
    var o = s[0], c = s[s.length - 1], up = side !== 'under';
    var op = up ? o[2] : o[3], cp = up ? c[2] : c[3];
    var lines = s.map(function (x) { return x[1]; });
    return { open: { at: o[0], line: o[1], over: o[2], under: o[3] }, current: { at: c[0], line: c[1], over: c[2], under: c[3] },
      line_move: r(c[1] - o[1], 2), high: Math.max.apply(null, lines), low: Math.min.apply(null, lines), changes: s.length - 1,
      price_move_cents: isNum(op) && isNum(cp) && c[1] === o[1] ? r((toDecimal(cp) - toDecimal(op)) * 100, 1) : null,
      text: c[1] !== o[1] ? 'Line ' + (c[1] > o[1] ? 'up' : 'down') + ' ' + Math.abs(r(c[1] - o[1], 1)) + ' since open (' + o[1] + ' → ' + c[1] + ')' : (isNum(op) && isNum(cp) && op !== cp ? 'Same line; price ' + priceText(op) + ' → ' + priceText(cp) : 'No movement since open') };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CONFIG: CONFIG, DECISION_FALLBACK: DECISION_FALLBACK, decisionConfig: decisionConfig,
    MARKETS: MARKETS, CATEGORIES: CATEGORIES, SPORTS: SPORTS, FAMILIES: FAMILIES,
    marketOf: marketOf, categoryOf: categoryOf, providerMarket: providerMarket, providerKeys: providerKeys,
    /* numerics + distributions */
    lgamma: lgamma, gammaP: gammaP, gammaCdf: gammaCdf, normCdf: normCdf, countPmf: countPmf, countPgf: countPgf,
    validDist: validDist, cdfInt: cdfInt, registerShape: registerShape, shapes: function () { return SHAPES; }, pmfInt: pmfInt, mean: meanOf, variance: varOf, quantile: quantile, summary: summary,
    probLine: probLine, scaleDist: scaleDist, solveScale: solveScale, widenDist: widenDist,
    /* odds */
    toDecimal: toDecimal, implied: implied, probToAmerican: probToAmerican, fairAmerican: fairAmerican, expectedValue: expectedValue,
    noVig: noVig, validPrice: validPrice, priceBetter: priceBetter, stepPrice: stepPrice,
    /* quotes, pricing, decision */
    sideOf: sideOf, sideLabel: sideLabel, selectionText: selectionText, normalizeQuotes: normalizeQuotes, consensusOf: consensusOf,
    freshnessOf: freshnessOf, evaluate: evaluate, compact: compact, confidence: confidence, calibrationOf: calibrationOf, sizing: sizing, valueScore: valueScore,
    triggerFor: triggerFor, stake: stake, evDollars: evDollars,
    /* research */
    hitRates: hitRates, explain: explain, movement: movement, statOf: statOf, factsFor: factsFor, BLOCK_TEXT: BLOCK_TEXT,
    /* grading */
    settle: settle, unitsWon: unitsWon, clv: clv, summarize: summarize, breakdown: breakdown, calibration: calibration,
    calibrationState: calibrationState, bucketOf: bucketOf, sampleState: sampleState,
    /* text */
    priceText: priceText, pctText: pctText, probText: probText, ppText: ppText, unitsText: unitsText, bookName: bookName, bookAbbr: bookAbbr,
    normName: normName, hash: hash
  };
}));
