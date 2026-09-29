/* ===========================================================================
   EDGEDESK PLAYER PROPS — the ONE canonical description of a player prop.
   docs/player-props/ARCHITECTURE.md

   Every surface that shows a prop (the Player Props board, the game page's
   PLAYER PROP RESEARCH section, the player page, the AI Research Desk, the
   Lab's prop analytics and the graded record) reads it through this file, so
   one projection produces one fair line, one probability, one EV and one
   decision everywhere. The heavy modelling (opportunity, efficiency,
   redistribution, Monte Carlo) happens server-side in football/props/; this
   file only READS the distribution the pipeline stored.

     GAME ENVIRONMENT → TEAM OPPORTUNITY → PLAYER OPPORTUNITY
       → PLAYER EFFICIENCY → PLAYER OUTCOME DISTRIBUTION   (football/props)
       → price at the exact quote → reliability → decision  (this file)

   WHAT THIS FILE OWNS
     catalog      prop types, tiers, Odds API market keys, positions
     identity     name normalisation, suffixes, nicknames, durable ids, slugs
     market       O/U pairing, implied / no-vig / hold, consensus, best
                  price, movement, open / close
     pricing      P(over) / P(under) / P(push) at any line from the stored
                  distribution, fair line, fair odds, break-even line, EV
     ladder       every (book, line, side) priced; BEST PRICE / BEST EV /
                  SAFER LINE / HIGHER UPSIDE
     reliability  0-100 from measured components — never the size of an edge
     stage        EXPERIMENTAL → TRACKING → RESEARCH GRADE → PRODUCTION
     decision     Layer A (can we evaluate?) / Layer B (should we act?)
     sizing       fractional Kelly on the risk-adjusted probability, capped
     explanation  deterministic WHY / RISKS from the projection's own drivers
     grading      WIN / LOSS / PUSH / VOID, units, CLV
     metrics      Brier, log loss, calibration, CRPS, PIT, coverage, ROI

   WHAT THIS FILE NEVER DOES
     - implement odds arithmetic of its own. American ↔ decimal, implied
       probability, the two-way no-vig and expected return are
       lib/research_core.js's (EDResearchCore), the one tested
       implementation every other EdgeDesk surface uses. Parity with
       lib/edgedesk_quote_ev.js (totalProb / expectedValue / fairAmerican) is
       pinned by tools/props/props_core.test.js.
     - compare a model probability with a RAW implied probability when a
       no-vig probability exists.
     - assume a Normal distribution, −110, or independence between props.
     - invent a value. Missing is null with a reason code; a stale quote is
       priced and labelled STALE, never decided on.
     - let the size of an edge raise reliability, or a large edge raise a
       stake: extreme numbers get more scrutiny (PRICE ANOMALY), not units.
     - rewrite a frozen prediction. freeze() returns a new, hashed record.

   Decision words and thresholds are EDVocab's and EDDecision's
   (lib/edgedesk_vocab.js, lib/edgedesk_decision.js DEFAULT_CONFIG): the
   priced quote is handed to EDDecision.metricsOf / priceClass in the exact
   shape EDQuoteEV.priceQuote produces, so a prop is classified by the same
   rule as a spread.

   Browser: window.EDProps (load lib/research_core.js first; the decision
   layer also needs edgedesk_vocab.js and edgedesk_decision.js).
   Node: require('./edgedesk_props.js'). Deno: inlined by
   tools/presentation/inline.js (EDPROPS). ES5, no other dependencies.
   =========================================================================== */
/*__EDPROPS_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDProps = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_props_v1';
  var CONFIG_VERSION = 'props_config_v1.0';

  /* ------------------------------------------------------ dependencies */
  var Rm = null, Dm = null, Vm = null;
  if (typeof require === 'function' && typeof module === 'object' && module && module.exports) {
    try { Rm = require('./research_core.js'); } catch (e) { Rm = null; }
    try { Vm = require('./edgedesk_vocab.js'); } catch (e) { Vm = null; }
    try { Dm = require('./edgedesk_decision.js'); } catch (e) { Dm = null; }
  }
  function R() {
    var c = Rm || (root && root.EDResearchCore) || (root && root.EDRCORE) ||
      (root && root.EDResearch && typeof root.EDResearch.americanToDecimal === 'function' ? root.EDResearch : null);
    if (!c || typeof c.americanToDecimal !== 'function') throw new Error('EDProps needs lib/research_core.js (EDResearchCore) loaded first');
    return c;
  }
  function D() { return Dm || (root && root.EDDecision) || null; }
  function V() { return Vm || (root && root.EDVocab) || null; }

  /* ------------------------------------------------------------ helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); var v = Math.round(x * m) / m; return v === 0 ? 0 : v; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }
  function lower(s) { return s == null ? '' : String(s).toLowerCase(); }
  function median(a) { var s = a.filter(isNum).slice().sort(function (x, y) { return x - y; }); if (!s.length) return null; var m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; }
  function mean(a) { var s = a.filter(isNum); return s.length ? s.reduce(function (t, v) { return t + v; }, 0) / s.length : null; }
  function sdev(a) { var s = a.filter(isNum); if (s.length < 2) return null; var m = mean(s); return Math.sqrt(s.reduce(function (t, v) { return t + (v - m) * (v - m); }, 0) / (s.length - 1)); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  function merge(a, b) {
    var o = copy(a) || {}, k;
    if (!b) return o;
    for (k in b) if (has(b, k)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) o[k] = merge(o[k], b[k]);
      else o[k] = copy(b[k]);
    }
    return o;
  }
  /* FNV-1a, two passes → 64 bits of stable id, browser / node / deno alike */
  function fnv(s, seed) {
    var h = seed >>> 0, i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul ? Math.imul(h, 16777619) >>> 0 : (h * 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function hash(parts, len) {
    var s = typeof parts === 'string' ? parts : JSON.stringify(parts);
    var h = fnv(s, 0x811c9dc5) + fnv(s.split('').reverse().join(''), 0x01000193);
    return h.slice(0, len || 16);
  }
  /* canonical JSON: keys sorted, so a hash never depends on insertion order */
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function probText(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function ppText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + ' pp' : '—'; }
  function lineNum(v) { return isNum(v) ? String(Math.round(v * 10) / 10) : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }

  /* ============================================================== CATALOG
     One entry per prop type. `kind`: count (integer outcomes from a count
     process), yards (integer yards, may be negative), binary (0/1: anytime
     TD, priced Yes/No), longest (the maximum of one game's plays).
     `tier` is the launch tier (README "Suggested first production scope"):
     1 = the stable volume/efficiency markets validated first; 2 = next;
     3 = specialty markets that stay EXPERIMENTAL until their calibration
     is proven (Prop_Targets P015-P023). `tier_by_pos` overrides by position
     (QB rushing yards is tier 2; RB rushing yards is tier 1).
     `family` names the distribution family the pipeline uses (never Normal).
     `modeled:false` = captured and shown with market math only (MARKET ONLY). */
  var PROP_TYPES = {
    pass_att: { key: 'pass_att', label: 'Passing Attempts', short: 'Pass Att', group: 'Passing', positions: ['QB'], unit: 'attempts', kind: 'count', tier: 1,
      family: 'team plays × dropback rate − sacks − scrambles (Monte Carlo)', stat: 'attempts', ref: 'P001',
      odds_api: ['player_pass_attempts'], odds_api_alt: ['player_pass_attempts_alternate'] },
    pass_cmp: { key: 'pass_cmp', label: 'Completions', short: 'Comp', group: 'Passing', positions: ['QB'], unit: 'completions', kind: 'count', tier: 1,
      family: 'attempts → per-target catch probability (beta-binomial, Monte Carlo)', stat: 'completions', ref: 'P002',
      odds_api: ['player_pass_completions'], odds_api_alt: ['player_pass_completions_alternate'] },
    pass_yds: { key: 'pass_yds', label: 'Passing Yards', short: 'Pass Yds', group: 'Passing', positions: ['QB'], unit: 'yards', kind: 'yards', tier: 1,
      family: 'completions × empirical per-catch gain (compound Monte Carlo)', stat: 'passing_yards', ref: 'P003',
      odds_api: ['player_pass_yds'], odds_api_alt: ['player_pass_yds_alternate'] },
    pass_tds: { key: 'pass_tds', label: 'Passing TDs', short: 'Pass TD', group: 'Touchdowns', positions: ['QB'], unit: 'touchdowns', kind: 'count', tier: 2,
      family: 'team touchdowns (Poisson on implied points) × pass share', stat: 'passing_tds', ref: 'P004',
      odds_api: ['player_pass_tds'], odds_api_alt: ['player_pass_tds_alternate'] },
    pass_int: { key: 'pass_int', label: 'Interceptions', short: 'INT', group: 'Passing', positions: ['QB'], unit: 'interceptions', kind: 'count', tier: 2,
      family: 'attempts × shrunk interception rate (per-attempt Bernoulli)', stat: 'passing_interceptions', ref: 'P005',
      odds_api: ['player_pass_interceptions'], odds_api_alt: [] },
    rush_att: { key: 'rush_att', label: 'Rushing Attempts', short: 'Rush Att', group: 'Rushing', positions: ['RB', 'QB'], unit: 'carries', kind: 'count', tier: 1, tier_by_pos: { QB: 2 },
      family: 'team designed runs × carry share (Dirichlet-multinomial) + scrambles', stat: 'carries', ref: 'P008',
      odds_api: ['player_rush_attempts'], odds_api_alt: ['player_rush_attempts_alternate'] },
    rush_yds: { key: 'rush_yds', label: 'Rushing Yards', short: 'Rush Yds', group: 'Rushing', positions: ['RB', 'QB', 'WR'], unit: 'yards', kind: 'yards', tier: 1, tier_by_pos: { QB: 2, WR: 3 },
      family: 'carries × empirical per-carry gain with explosive tail (compound Monte Carlo)', stat: 'rushing_yards', ref: 'P009',
      odds_api: ['player_rush_yds'], odds_api_alt: ['player_rush_yds_alternate'] },
    targets: { key: 'targets', label: 'Targets', short: 'Tgt', group: 'Receiving', positions: ['WR', 'TE', 'RB'], unit: 'targets', kind: 'count', tier: 1,
      family: 'team attempts × target share (Dirichlet-multinomial)', stat: 'targets', ref: 'P012', odds_api: [], odds_api_alt: [] },
    receptions: { key: 'receptions', label: 'Receptions', short: 'Rec', group: 'Receptions', positions: ['WR', 'TE', 'RB'], unit: 'receptions', kind: 'count', tier: 1,
      family: 'targets → catch probability (beta-binomial, Monte Carlo)', stat: 'receptions', ref: 'P013',
      odds_api: ['player_receptions'], odds_api_alt: ['player_receptions_alternate'] },
    rec_yds: { key: 'rec_yds', label: 'Receiving Yards', short: 'Rec Yds', group: 'Receiving', positions: ['WR', 'TE', 'RB'], unit: 'yards', kind: 'yards', tier: 1, tier_by_pos: { RB: 2 },
      family: 'targets → catches × empirical per-catch gain (compound heavy-tailed Monte Carlo)', stat: 'receiving_yards', ref: 'P014',
      odds_api: ['player_reception_yds'], odds_api_alt: ['player_reception_yds_alternate'] },
    rush_rec_yds: { key: 'rush_rec_yds', label: 'Rush + Rec Yards', short: 'Rush+Rec', group: 'Rushing', positions: ['RB', 'WR', 'TE'], unit: 'yards', kind: 'yards', tier: 2,
      family: 'joint simulation of the rushing and receiving chains (never a sum of means)', stat: 'rush_rec_yards', ref: 'P024',
      odds_api: ['player_rush_reception_yds'], odds_api_alt: ['player_rush_reception_yds_alternate'] },
    pass_rush_yds: { key: 'pass_rush_yds', label: 'Pass + Rush Yards', short: 'Pass+Rush', group: 'Passing', positions: ['QB'], unit: 'yards', kind: 'yards', tier: 2,
      family: 'joint simulation of the passing and rushing chains', stat: 'pass_rush_yards', ref: 'P024',
      odds_api: ['player_pass_rush_yds'], odds_api_alt: [] },
    anytime_td: { key: 'anytime_td', label: 'Anytime TD', short: 'ATTD', group: 'Touchdowns', positions: ['RB', 'WR', 'TE', 'QB'], unit: 'touchdowns', kind: 'binary', tier: 3,
      family: 'team touchdowns × red-zone share (Bernoulli / Poisson simulation)', stat: 'scrimmage_tds', ref: 'P015/P016',
      odds_api: ['player_anytime_td'], odds_api_alt: [] },
    longest_rec: { key: 'longest_rec', label: 'Longest Reception', short: 'Long Rec', group: 'Receiving', positions: ['WR', 'TE', 'RB'], unit: 'yards', kind: 'longest', tier: 3,
      family: 'order statistic: the maximum of the simulated per-catch gains', stat: 'longest_reception', ref: 'P017',
      odds_api: ['player_reception_longest'], odds_api_alt: [] },
    longest_rush: { key: 'longest_rush', label: 'Longest Rush', short: 'Long Rush', group: 'Rushing', positions: ['RB', 'QB'], unit: 'yards', kind: 'longest', tier: 3,
      family: 'order statistic: the maximum of the simulated per-carry gains', stat: 'longest_rush', ref: 'P018',
      odds_api: ['player_rush_longest'], odds_api_alt: [] },
    longest_cmp: { key: 'longest_cmp', label: 'Longest Completion', short: 'Long Cmp', group: 'Passing', positions: ['QB'], unit: 'yards', kind: 'longest', tier: 3,
      family: 'order statistic: the maximum of the simulated completed gains', stat: 'longest_completion', ref: 'P019',
      odds_api: ['player_pass_longest_completion'], odds_api_alt: [] },
    /* captured and shown with market math; no EdgeDesk projection yet */
    tackles_ast: { key: 'tackles_ast', label: 'Tackles + Assists', short: 'Tkl+Ast', group: 'Defense', positions: ['LB', 'DB', 'DL'], unit: 'tackles', kind: 'count', tier: 3, modeled: false, ref: 'P021',
      odds_api: ['player_tackles_assists'], odds_api_alt: [] },
    sacks: { key: 'sacks', label: 'Sacks', short: 'Sacks', group: 'Defense', positions: ['DL', 'LB'], unit: 'sacks', kind: 'count', tier: 3, modeled: false, ref: 'P022', odds_api: ['player_sacks'], odds_api_alt: [] },
    def_int: { key: 'def_int', label: 'Defensive INT', short: 'Def INT', group: 'Defense', positions: ['DB', 'LB'], unit: 'interceptions', kind: 'count', tier: 3, modeled: false, ref: 'P023', odds_api: ['player_defensive_interceptions'], odds_api_alt: [] },
    field_goals: { key: 'field_goals', label: 'Field Goals Made', short: 'FG', group: 'Kicking', positions: ['K'], unit: 'field goals', kind: 'count', tier: 3, modeled: false, ref: 'P020', odds_api: ['player_field_goals'], odds_api_alt: [] },
    kicking_pts: { key: 'kicking_pts', label: 'Kicking Points', short: 'K Pts', group: 'Kicking', positions: ['K'], unit: 'points', kind: 'count', tier: 3, modeled: false, ref: 'P020', odds_api: ['player_kicking_points'], odds_api_alt: [] }
  };
  var PROP_ORDER = ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_int', 'pass_rush_yds', 'longest_cmp', 'rush_yds', 'rush_att', 'rush_rec_yds', 'longest_rush',
    'rec_yds', 'receptions', 'targets', 'longest_rec', 'anytime_td', 'tackles_ast', 'sacks', 'def_int', 'field_goals', 'kicking_pts'];
  var MARKET_GROUPS = ['Passing', 'Rushing', 'Receiving', 'Receptions', 'Touchdowns', 'Defense', 'Kicking'];
  var ODDS_MARKET_INDEX = (function () {
    var o = {};
    Object.keys(PROP_TYPES).forEach(function (k) {
      (PROP_TYPES[k].odds_api || []).forEach(function (m) { o[m] = { prop_type: k, alternate: false }; });
      (PROP_TYPES[k].odds_api_alt || []).forEach(function (m) { o[m] = { prop_type: k, alternate: true }; });
    });
    return o;
  })();
  function propType(k) { return PROP_TYPES[k] || null; }
  function propTypeOfMarketKey(mk) { return ODDS_MARKET_INDEX[String(mk || '')] || null; }
  function oddsApiMarkets(opts) {
    opts = opts || {};
    var tiers = opts.tiers || [1, 2, 3], out = [];
    PROP_ORDER.forEach(function (k) {
      var p = PROP_TYPES[k];
      if (tiers.indexOf(p.tier) < 0) return;
      if (opts.modeled_only && p.modeled === false) return;
      out = out.concat(p.odds_api || []);
      if (opts.alternates !== false) out = out.concat(p.odds_api_alt || []);
    });
    return out;
  }
  function tierOf(prop, position) {
    var p = PROP_TYPES[prop];
    if (!p) return null;
    var pos = upper(position);
    return p.tier_by_pos && pos && has(p.tier_by_pos, pos) ? p.tier_by_pos[pos] : p.tier;
  }
  function positionGroup(pos) {
    var p = upper(pos);
    if (!p) return null;
    if (p === 'QB') return 'QB';
    if (p === 'RB' || p === 'HB' || p === 'FB') return 'RB';
    if (p === 'WR') return 'WR';
    if (p === 'TE') return 'TE';
    if (p === 'K' || p === 'PK') return 'K';
    if (/^(CB|S|FS|SS|DB|SAF)$/.test(p)) return 'DB';
    if (/^(LB|ILB|OLB|MLB)$/.test(p)) return 'LB';
    if (/^(DE|DT|NT|DL|EDGE)$/.test(p)) return 'DL';
    return p;
  }

  /* ============================================================= IDENTITY
     A sportsbook writes "A.J. Brown", "Marvin Harrison Jr.", "Kenneth Walker
     III", "Gabe Davis", "Hollywood Brown". A name is never an identity: it is
     a query answered INSIDE the event's two rosters, by these rules in order,
     and anything ambiguous stays unresolved (a named mapping fault, never a
     guess). */
  var SUFFIX = /\b(jr|sr|ii|iii|iv|v|vi)\b\.?/g;
  function foldAccents(s) {
    return String(s == null ? '' : s).replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
      .replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c').replace(/[ýÿ]/g, 'y').replace(/[’'`]/g, '');
  }
  /* "Marvin Harrison Jr." → "marvin harrison"; "A.J. Brown" → "aj brown" */
  function normName(s) {
    var t = foldAccents(lower(s)).replace(/\./g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ');
    t = t.replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
    return t;
  }
  /* common given-name equivalences seen in sportsbook feeds; both directions */
  var NICK = [
    ['gabe', 'gabriel'], ['josh', 'joshua'], ['mike', 'michael'], ['matt', 'matthew'], ['chris', 'christopher'], ['nick', 'nicholas'],
    ['rob', 'robert'], ['bob', 'robert'], ['will', 'william'], ['bill', 'william'], ['jim', 'james'], ['jimmy', 'james'], ['tom', 'thomas'],
    ['tony', 'anthony'], ['dan', 'daniel'], ['danny', 'daniel'], ['joe', 'joseph'], ['jon', 'jonathan'], ['johnny', 'john'], ['ken', 'kenneth'],
    ['kenny', 'kenneth'], ['zach', 'zachary'], ['zack', 'zachary'], ['sam', 'samuel'], ['ben', 'benjamin'], ['alex', 'alexander'], ['jake', 'jacob'],
    ['drew', 'andrew'], ['andy', 'andrew'], ['dave', 'david'], ['greg', 'gregory'], ['jeff', 'jeffrey'], ['pat', 'patrick'], ['steve', 'steven'],
    ['chig', 'chigoziem'], ['hollywood', 'marquise'], ['deebo', 'tyshun'], ['bam', 'brian'], ['scotty', 'scott'], ['cam', 'cameron'],
    ['tim', 'timothy'], ['ed', 'edward'], ['eddie', 'edward'], ['nate', 'nathaniel'], ['nate', 'nathan'], ['trey', 'tremaine'], ['kj', 'kenneth']
  ];
  var NICK_MAP = (function () { var m = {}; NICK.forEach(function (p) { (m[p[0]] = m[p[0]] || []).push(p[1]); (m[p[1]] = m[p[1]] || []).push(p[0]); }); return m; })();
  /* every normalised form a name can reasonably take */
  function nameVariants(s) {
    var n = normName(s), out = {};
    if (!n) return [];
    out[n] = 1;
    var parts = n.split(' ');
    /* initials: "aj brown" ↔ "a j brown" */
    if (parts.length >= 2 && parts[0].length <= 3 && /^[a-z]+$/.test(parts[0])) out[parts[0].split('').join(' ') + ' ' + parts.slice(1).join(' ')] = 1;
    if (parts.length >= 3 && parts[0].length === 1 && parts[1].length === 1) out[parts[0] + parts[1] + ' ' + parts.slice(2).join(' ')] = 1;
    (NICK_MAP[parts[0]] || []).forEach(function (alt) { out[[alt].concat(parts.slice(1)).join(' ')] = 1; });
    /* hyphenated surnames: "amon ra st brown" ↔ "amonra st brown" */
    out[n.replace(/\s+/g, '')] = 1;
    return Object.keys(out);
  }
  function compact(s) { return normName(s).replace(/\s+/g, ''); }
  function lastName(s) { var p = normName(s).split(' '); return p[p.length - 1] || ''; }
  /* candidates: [{player_id, name, aliases[], position, team, status}]
     returns {player_id, method, confidence, candidates, reason} */
  function resolvePlayer(rawName, candidates, opts) {
    opts = opts || {};
    var raw = String(rawName == null ? '' : rawName).trim();
    var out = { raw: raw, player_id: null, method: null, confidence: 0, ambiguous: false, reason: null, matched: [] };
    if (!raw) { out.reason = 'EMPTY_NAME'; return out; }
    var ov = opts.overrides || null;
    if (ov) {
      var ok = [upper(opts.league || ''), lower(opts.team || ''), compact(raw)].join('|'), ok2 = [upper(opts.league || ''), '', compact(raw)].join('|');
      if (has(ov, ok) || has(ov, ok2)) { out.player_id = ov[ok] || ov[ok2]; out.method = 'OVERRIDE'; out.confidence = 1; return out; }
    }
    var cands = (candidates || []).filter(function (c) { return c && c.player_id; });
    if (opts.position) {
      var pg = positionGroup(opts.position);
      var byPos = cands.filter(function (c) { return positionGroup(c.position) === pg; });
      if (byPos.length) cands = byPos;
    }
    var rv = nameVariants(raw), rc = compact(raw);
    function pick(list, method, conf) {
      var ids = {}; list.forEach(function (c) { ids[c.player_id] = c; });
      var keys = Object.keys(ids);
      if (keys.length === 1) { out.player_id = keys[0]; out.method = method; out.confidence = conf; out.matched = [ids[keys[0]].name]; return true; }
      if (keys.length > 1) { out.ambiguous = true; out.reason = 'AMBIGUOUS_' + method; out.matched = keys.map(function (k) { return ids[k].name; }); return true; }
      return false;
    }
    /* 1 exact normalised name (suffix- and punctuation-free) */
    var exact = cands.filter(function (c) { return compact(c.name) === rc || (c.aliases || []).some(function (a) { return compact(a) === rc; }); });
    if (pick(exact, 'EXACT', 0.99)) return out;
    /* 2 a variant (initials, nickname table, joined surnames) */
    var variant = cands.filter(function (c) {
      var cv = nameVariants(c.name).concat((c.aliases || []).reduce(function (t, a) { return t.concat(nameVariants(a)); }, []));
      return cv.some(function (v) { return rv.indexOf(v) >= 0; });
    });
    if (pick(variant, 'VARIANT', 0.95)) return out;
    /* 3 token subset: "Ryan Williams" inside "Ryan Coleman-Williams" (same
       first name, same final surname token), unique inside the team */
    var rtoks = normName(raw).split(' ');
    var subset = cands.filter(function (c) {
      return [c.name].concat(c.aliases || []).some(function (nm) {
        var ct = normName(nm).split(' ');
        if (ct.length < 2 || rtoks.length < 2 || ct[0] !== rtoks[0] || ct[ct.length - 1] !== rtoks[rtoks.length - 1]) return false;
        var small = ct.length <= rtoks.length ? ct : rtoks, big = small === ct ? rtoks : ct;
        return small.every(function (t) { return big.indexOf(t) >= 0; });
      });
    });
    if (pick(subset, 'TOKEN_SUBSET', 0.9)) return out;
    /* 4 surname + first initial, unique inside the team and position */
    var rp = normName(raw).split(' ');
    var init = rp[0] ? rp[0].charAt(0) : '', ln = lastName(raw);
    var initial = cands.filter(function (c) { var cp = normName(c.name).split(' '); return cp.length >= 2 && lastName(c.name) === ln && cp[0].charAt(0) === init; });
    if (pick(initial, 'SURNAME_INITIAL', 0.85)) return out;
    out.reason = out.reason || 'NO_MATCH';
    return out;
  }
  /* a durable EdgeDesk player id, minted ONCE from the anchor provider id
     (NFL: the nflverse GSIS id; CFB: the ESPN athlete id). The registry keeps
     it forever; it is never recomputed from a name. */
  function mintPlayerId(league, anchorSystem, anchorId) {
    if (!league || !anchorSystem || anchorId == null || anchorId === '') return null;
    return 'edp_' + hash(lower(league) + '|' + lower(anchorSystem) + '|' + String(anchorId), 12);
  }
  function slugify(name) { return normName(name).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'player'; }

  /* =============================================================== CONFIG
     Every number is a labelled, conservative default (EDDecision's
     CONSERVATIVE_DEFAULT_UNVALIDATED doctrine) until the prop record
     validates it. CFB carries its own, stricter scale: poorer injury and
     participation reporting, blowouts and small samples. */
  var DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    validation_state: 'CONSERVATIVE_DEFAULT_UNVALIDATED',
    freshness: { fresh_minutes: 30, max_minutes: 90 },
    leagues: {
      NFL: { thresholds: { bet: { min_edge_pp: 4.0, min_ev: 0.05 }, lean: { min_edge_pp: 2.0, min_ev: 0.0 } },
        min_reliability_bet: 60, haircut_floor: 0.20, estimated_hold: 0.045, watch_trigger_pp: 1.0 },
      CFB: { thresholds: { bet: { min_edge_pp: 6.0, min_ev: 0.08 }, lean: { min_edge_pp: 3.0, min_ev: 0.0 } },
        min_reliability_bet: 68, haircut_floor: 0.15, estimated_hold: 0.055, watch_trigger_pp: 1.5 }
    },
    /* how far a stage lets the model move off the no-vig market (the
       uncertainty haircut, Model_Library M049) */
    stage_trust: { EXPERIMENTAL: 0.55, TRACKING: 0.70, RESEARCH_GRADE: 0.85, PRODUCTION: 1.0 },
    /* the class ceiling a stage allows: an EXPERIMENTAL market informs, never stakes */
    stage_max_class: { EXPERIMENTAL: 'LEAN', TRACKING: 'BET', RESEARCH_GRADE: 'BET', PRODUCTION: 'BET' },
    stage_source: { EXPERIMENTAL: 'model_estimated', TRACKING: 'model_estimated', RESEARCH_GRADE: 'partially_calibrated', PRODUCTION: 'calibrated' },
    anomaly: { raw_ev: 0.20, edge_pp: 12, verify_cents: 10 },
    tail: { max_z: 1.6, min_odds: -300, max_odds: 300 },
    sizing: {
      kelly_fraction: 0.25, unit_pct_of_bankroll: 0.01, grid: [0.25, 0.50, 0.75, 1.00], max_units: 1.00,
      source_caps: { calibrated: 1.00, partially_calibrated: 0.50, model_estimated: 0.25 },
      reliability_caps: [[80, 1.00], [70, 0.50], [0, 0.25]],
      thin_market_cap: 0.50, anomaly_cap: 0.25,
      /* exposure (the EDSTAKE policy: 1.25U a game, 1.5U a team, 4U a day),
         plus a player cap and a correlated-group cap for same-game props */
      exposure: { player: 0.50, game: 1.25, team: 1.50, daily: 4.00, correlated_group: 0.75, correlation_threshold: 0.30 }
    },
    reliability: {
      weights: { data_completeness: 0.14, sample_size: 0.14, role_stability: 0.10, injury_certainty: 0.12, model_agreement: 0.10,
        market_liquidity: 0.08, book_agreement: 0.08, projection_variance: 0.08, historical_calibration: 0.10, redistribution: 0.06 },
      labels: [[80, 'High'], [65, 'Moderate'], [45, 'Low'], [0, 'Very low']],
      league_scale: { NFL: 1.0, CFB: 0.88 }
    }
  };
  function config(over) { return deepFreeze(merge(DEFAULT_CONFIG, over || null)); }
  var CFG = config(null);
  function leagueCfg(cfg, league) { return (cfg.leagues && cfg.leagues[upper(league)]) || cfg.leagues.NFL; }

  /* =========================================================== FRESHNESS
     lib/edgedesk_market.js freshness(): the one quote-age rule (FRESH ≤ 30,
     AGING ≤ 90, STALE beyond) — used when EDMarket is loaded, reproduced
     here with the same constants when it is not (the Deno desk). */
  function freshness(t, now, cfg) {
    var M = (typeof require === 'function' && typeof module === 'object' && module && module.exports) ? (function () { try { return require('./edgedesk_market.js'); } catch (e) { return null; } })() : (root && root.EDMarket);
    var F = (cfg || CFG).freshness;
    if (M && typeof M.freshness === 'function') return M.freshness(t, now, { fresh_minutes: F.fresh_minutes, max_minutes: F.max_minutes });
    var at = ms(t), n = ms(now);
    if (at == null || n == null) return { state: 'UNKNOWN', age_seconds: null, age_minutes: null, text: 'capture time unknown' };
    var m = (n - at) / 60000;
    if (m < -5) return { state: 'FUTURE', age_seconds: Math.round(m * 60), age_minutes: r(m, 1), text: 'the capture time is in the future (clock fault)' };
    var st = m <= F.fresh_minutes ? 'FRESH' : (m <= F.max_minutes ? 'AGING' : 'STALE');
    return { state: st, age_seconds: Math.max(0, Math.round(m * 60)), age_minutes: r(Math.max(0, m), 1), text: (m < 60 ? Math.max(0, Math.round(m)) + ' min' : r(m / 60, 1) + ' h') + ' old' };
  }

  /* ========================================================= DISTRIBUTION
     The pipeline stores one integer-outcome distribution per prop:
       { lo: first outcome, n: total mass (the simulation count), pmf: [..] }
     pmf[i] is the count (or mass × n) of outcome lo + i. Tails below
     0.1% are folded into the end cells so the stored mass is exact. */
  function encodeDist(values, opts) {
    opts = opts || {};
    var counts = {}, n = 0, i;
    for (i = 0; i < values.length; i++) { var v = Math.round(values[i]); if (!isFinite(v)) continue; counts[v] = (counts[v] || 0) + 1; n++; }
    if (!n) return null;
    var keys = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    var trim = opts.trim == null ? 0.001 : opts.trim;
    var lo = keys[0], hi = keys[keys.length - 1], acc = 0;
    for (i = 0; i < keys.length; i++) { acc += counts[keys[i]]; if (acc / n > trim) { lo = keys[i]; break; } }
    acc = 0;
    for (i = keys.length - 1; i >= 0; i--) { acc += counts[keys[i]]; if (acc / n > trim) { hi = keys[i]; break; } }
    var pmf = [];
    for (var k = lo; k <= hi; k++) pmf.push(counts[k] || 0);
    keys.forEach(function (k2) { if (k2 < lo) pmf[0] += counts[k2]; else if (k2 > hi) pmf[pmf.length - 1] += counts[k2]; });
    /* stored at a fixed resolution (default 1/2000): the largest-remainder
       rule keeps the mass summing exactly to `scale` */
    var scale = opts.scale == null ? 2000 : opts.scale;
    if (scale && scale < n) {
      var raw = pmf.map(function (c) { return c * scale / n; }), fl = raw.map(Math.floor), tot = fl.reduce(function (t, v) { return t + v; }, 0);
      var rem = raw.map(function (v, i) { return [v - fl[i], i]; }).sort(function (a, b) { return b[0] - a[0]; });
      for (var j = 0; tot < scale && j < rem.length; j++, tot++) fl[rem[j][1]]++;
      while (fl.length > 1 && fl[0] === 0) { fl.shift(); lo++; }
      while (fl.length > 1 && fl[fl.length - 1] === 0) fl.pop();
      return { lo: lo, n: scale, pmf: fl, sims: n };
    }
    return { lo: lo, n: n, pmf: pmf };
  }
  function validDist(d) {
    if (!d || !isNum(d.lo) || !isNum(d.n) || d.n <= 0 || !Array.isArray(d.pmf) || !d.pmf.length) return false;
    var s = 0;
    for (var i = 0; i < d.pmf.length; i++) { if (!isNum(d.pmf[i]) || d.pmf[i] < 0) return false; s += d.pmf[i]; }
    return Math.abs(s - d.n) <= Math.max(1e-6, d.n * 1e-6);
  }
  /* {over: P(X > line), under: P(X < line), push: P(X = line)} */
  function probAt(d, line) {
    var L = num(line);
    if (!validDist(d) || L == null) return null;
    var over = 0, under = 0, push = 0;
    for (var i = 0; i < d.pmf.length; i++) {
      var x = d.lo + i, c = d.pmf[i];
      if (x > L + EPS) over += c; else if (x < L - EPS) under += c; else push += c;
    }
    return { over: over / d.n, under: under / d.n, push: push / d.n, line: L };
  }
  /* the mid-point CDF: integer x treated as uniform on [x − ½, x + ½], so a
     fair line and a quantile are continuous numbers a reader can compare
     with a book's half-point line */
  function cdfContinuous(d, t) {
    if (!validDist(d) || !isNum(t)) return null;
    var acc = 0;
    for (var i = 0; i < d.pmf.length; i++) {
      var x = d.lo + i, lo = x - 0.5, hi = x + 0.5, c = d.pmf[i] / d.n;
      if (t >= hi) acc += c; else if (t > lo) acc += c * (t - lo);
      else break;
    }
    return clamp(acc, 0, 1);
  }
  function quantile(d, q) {
    if (!validDist(d) || !isNum(q)) return null;
    var target = clamp(q, 0, 1), acc = 0;
    for (var i = 0; i < d.pmf.length; i++) {
      var c = d.pmf[i] / d.n;
      if (acc + c >= target - 1e-12) {
        var frac = c > 0 ? (target - acc) / c : 0;
        return d.lo + i - 0.5 + clamp(frac, 0, 1);
      }
      acc += c;
    }
    return d.lo + d.pmf.length - 0.5;
  }
  /* the discrete quantile: the smallest outcome whose CDF reaches q (what a
     reader means by "the 25th percentile is 43 yards") */
  function quantileInt(d, q) {
    if (!validDist(d) || !isNum(q)) return null;
    var acc = 0, t = clamp(q, 0, 1) * d.n - 1e-9;
    for (var i = 0; i < d.pmf.length; i++) { acc += d.pmf[i]; if (acc >= t) return d.lo + i; }
    return d.lo + d.pmf.length - 1;
  }
  function distMoments(d) {
    if (!validDist(d)) return null;
    var m = 0, m2 = 0;
    for (var i = 0; i < d.pmf.length; i++) { var x = d.lo + i, c = d.pmf[i] / d.n; m += x * c; m2 += x * x * c; }
    return { mean: m, sd: Math.sqrt(Math.max(0, m2 - m * m)) };
  }
  /* the fair line: where P(over) = P(under) on the continuous scale — the
     distribution's median, never its mean (a right-skewed yardage median
     sits below the mean, and that is the line that splits the outcomes) */
  function fairLine(d) { return quantile(d, 0.5); }
  function summarize(d) {
    if (!validDist(d)) return null;
    var mo = distMoments(d);
    var out = { mean: r(mo.mean, 2), sd: r(mo.sd, 2), median: r(quantile(d, 0.5), 2), fair_line: r(fairLine(d), 2) };
    [0.05, 0.10, 0.25, 0.75, 0.90, 0.95].forEach(function (q) { out['p' + ('0' + Math.round(q * 100)).slice(-2)] = quantileInt(d, q); });
    out.p50 = quantileInt(d, 0.5);
    out.p_zero = r(probAt(d, 0.5) ? 1 - probAt(d, 0.5).over : null, 4);
    return out;
  }
  /* the smallest half-point book line at which P(over) crosses 50% */
  function nearestHalfLine(x) { return isNum(x) ? Math.floor(x) + 0.5 : null; }

  /* ============================================================== PRICING
     One side of one quote. Probabilities come from the distribution alone;
     the price enters only the break-even and the payout (EDQuoteEV's rule).
       win   P(X > L) for Over, P(X < L) for Under ("Yes" = X ≥ 1)
       push  P(X = L) on a whole-number line (a push returns the stake)
       cover win / (win + loss)  — the no-push basis the break-even lives on */
  function sideProbs(d, side, line) {
    var s = lower(side);
    if (s === 'yes' || s === 'no') {
      var pa = probAt(d, 0.5);
      if (!pa) return null;
      return s === 'yes' ? { win: pa.over, push: 0, loss: pa.under + pa.push } : { win: pa.under + pa.push, push: 0, loss: pa.over };
    }
    var p = probAt(d, line);
    if (!p) return null;
    return s === 'under' ? { win: p.under, push: p.push, loss: p.over } : { win: p.over, push: p.push, loss: p.under };
  }
  function fairAmericanOf(win, push) {
    var pu = isNum(push) ? push : 0;
    if (!isNum(win) || win <= 0 || pu >= 1) return null;
    var cover = win / (1 - pu);
    if (cover >= 1) return null;
    var a = R().probToAmerican(cover);
    if (!isNum(a)) return null;
    var x = Math.round(a);
    return x > -100 && x < 100 ? (x >= 0 ? 100 : -100) : x;
  }
  /* price one side at one quote: every number a card prints */
  function priceSide(d, side, line, american, opts) {
    opts = opts || {};
    var Rc = R();
    var out = { side: lower(side), line: num(line), american: num(american), decimal: null, available: false, reason: null,
      model_win: null, model_push: null, model_loss: null, model_cover: null, fair_american: null, break_even: null,
      edge_pp: null, ev: null, market_prob: null, market_prob_source: null, model_minus_market_pp: null };
    var dec = Rc.americanToDecimal(american);
    if (dec == null) { out.reason = 'INVALID_PRICE'; return out; }
    out.decimal = dec;
    out.break_even = 1 / dec;
    var sp = sideProbs(d, side, line);
    if (!sp) { out.reason = validDist(d) ? 'NO_LINE' : 'DISTRIBUTION_MISSING'; return out; }
    out.model_win = sp.win; out.model_push = sp.push; out.model_loss = sp.loss;
    out.model_cover = sp.win + sp.loss > 0 ? sp.win / (sp.win + sp.loss) : null;
    out.fair_american = fairAmericanOf(sp.win, sp.push);
    var pa = Rc.priceAssessment(american, sp.win, sp.push);
    if (!pa || pa.expected_roi == null) { out.reason = pa && pa.reason ? pa.reason : 'EV_UNAVAILABLE'; return out; }
    out.ev = pa.expected_roi;
    out.edge_pp = 100 * pa.prob_edge;
    out.available = true;
    if (isNum(opts.market_prob)) {
      out.market_prob = opts.market_prob; out.market_prob_source = opts.market_prob_source || 'no-vig';
      out.model_minus_market_pp = 100 * (out.model_cover - opts.market_prob);
    }
    return out;
  }
  /* the continuous line at which this side is exactly break-even at this
     price: "Over is +EV up to 81.3 at −110". Searched on the continuous CDF,
     so it is a number to compare with the book line, not a book line. */
  function breakEvenLine(d, side, american) {
    var dec = R().americanToDecimal(american);
    if (dec == null || !validDist(d)) return null;
    var be = 1 / dec, s = lower(side);
    var lo = d.lo - 1, hi = d.lo + d.pmf.length;
    function coverAt(t) { var F = cdfContinuous(d, t); return s === 'under' ? F : 1 - F; }
    if (s === 'under' ? coverAt(hi) < be : coverAt(lo) < be) return null;
    for (var it = 0; it < 60; it++) {
      var mid = (lo + hi) / 2, c = coverAt(mid);
      if (s === 'under') { if (c >= be) hi = mid; else lo = mid; } else { if (c >= be) lo = mid; else hi = mid; }
    }
    return r((lo + hi) / 2, 2);
  }

  /* =============================================================== MARKET
     Normalised quote (the capture writes these; nothing else invents one):
       { quote_id, league, game_id, player_id, player_name, team, opponent,
         home_away, kickoff, prop_type, book, line, over, under, is_alternate,
         captured_at, book_updated_at, provider, market_key, status }
     `over` / `under` are American prices; `yes` / `no` for binary props. */
  var BOOK_LABEL = {
    draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', williamhill_us: 'Caesars', caesars: 'Caesars', espnbet: 'ESPN BET',
    fanatics: 'Fanatics', betrivers: 'BetRivers', pinnacle: 'Pinnacle', bovada: 'Bovada', betonlineag: 'BetOnline', mybookieag: 'MyBookie',
    hardrockbet: 'Hard Rock', ballybet: 'Bally Bet', betparx: 'betPARX', prizepicks: 'PrizePicks', underdog: 'Underdog', circasports: 'Circa'
  };
  var SHARP_BOOKS = ['pinnacle', 'circasports', 'circa', 'bookmaker', 'betcris'];
  function bookLabel(k) { return BOOK_LABEL[lower(k)] || (k ? String(k) : '—'); }
  /* pair a provider's outcome list into two-sided quotes:
     outcomes [{name:'Over'|'Under'|'Yes'|'No', description: player, price, point}] */
  function pairOutcomes(outcomes) {
    var by = {}, order = [];
    (outcomes || []).forEach(function (o) {
      if (!o) return;
      var nm = lower(o.name), who = String(o.description || o.player || '').trim();
      var side = nm === 'over' || nm === 'under' || nm === 'yes' || nm === 'no' ? nm : null;
      if (!side || !who) return;
      var pt = num(o.point);
      var key = normName(who) + '|' + (side === 'yes' || side === 'no' ? 'bin' : (pt == null ? 'x' : String(pt)));
      if (!by[key]) { by[key] = { player_name: who, line: side === 'yes' || side === 'no' ? 0.5 : pt, binary: side === 'yes' || side === 'no' }; order.push(key); }
      var price = num(o.price);
      if (by[key][side] != null && by[key][side] !== price) by[key].conflict = true;
      by[key][side] = price;
    });
    return order.map(function (k) {
      var q = by[k];
      return { player_name: q.player_name, line: q.line, over: q.binary ? (q.yes != null ? q.yes : null) : (q.over != null ? q.over : null),
        under: q.binary ? (q.no != null ? q.no : null) : (q.under != null ? q.under : null), binary: q.binary, two_sided: q.binary ? (q.yes != null && q.no != null) : (q.over != null && q.under != null), conflict: !!q.conflict };
    });
  }
  /* the market arithmetic of one quote: implied, hold, no-vig (research_core) */
  function quoteMath(q) {
    var Rc = R();
    var io = Rc.impliedProb(q && q.over), iu = Rc.impliedProb(q && q.under);
    var out = { implied_over: io, implied_under: iu, hold: null, novig_over: null, novig_under: null, two_sided: io != null && iu != null };
    if (out.two_sided) {
      var nv = Rc.noVigTwoWay(q.over, q.under);
      if (nv) { out.novig_over = nv.a; out.novig_under = nv.b; out.hold = nv.overround; }
    }
    return out;
  }
  function qKey(q) { return [q.game_id, q.player_id || ('name:' + normName(q.player_name)), q.prop_type].join('|'); }
  /* the latest quote per (book, line, alternate?) at or before `asOf` */
  function latestQuotes(quotes, asOf) {
    var cut = ms(asOf), best = {};
    (quotes || []).forEach(function (q) {
      if (!q) return;
      var t = ms(q.captured_at);
      if (cut != null && t != null && t > cut) return;
      var k = lower(q.book) + '|' + (q.is_alternate ? 'alt' : 'main') + '|' + (q.is_alternate ? String(q.line) : '');
      if (!best[k] || (ms(best[k].captured_at) || 0) <= (t || 0)) best[k] = q;
    });
    return Object.keys(best).map(function (k) { return best[k]; });
  }
  /* the consensus of one prop: main lines only, one per book */
  function consensus(quotes, now, cfg) {
    cfg = cfg || CFG;
    var mains = latestQuotes(quotes, null).filter(function (q) { return !q.is_alternate && isNum(q.line) && lower(q.status || 'open') !== 'suspended'; });
    var out = { books: 0, lines: [], median_line: null, modal_line: null, consensus_line: null, novig_over: null, novig_under: null, novig_books: 0,
      hold_median: null, best_over: null, best_under: null, best_line_over: null, best_line_under: null, dispersion_pp: null, line_range: null,
      freshest_at: null, oldest_at: null, freshness: null, sharp: null, book_list: [] };
    if (!mains.length) return out;
    out.books = mains.length;
    out.book_list = mains.map(function (q) { return lower(q.book); }).sort();
    var lines = mains.map(function (q) { return q.line; });
    out.lines = lines.slice().sort(function (a, b) { return a - b; });
    out.median_line = median(lines);
    var cnt = {}; lines.forEach(function (l) { cnt[l] = (cnt[l] || 0) + 1; });
    var modal = null, mc = 0; Object.keys(cnt).forEach(function (l) { if (cnt[l] > mc || (cnt[l] === mc && Math.abs(+l - out.median_line) < Math.abs(modal - out.median_line))) { modal = +l; mc = cnt[l]; } });
    out.modal_line = modal;
    /* a consensus is a line books actually deal: the majority line, else the
       dealt line nearest the median (a tie goes to the line whose no-vig is
       closest to a coin flip — the book's own statement of its middle) */
    if (mc * 2 > mains.length) out.consensus_line = modal;
    else {
      var dealt = Object.keys(cnt).map(Number);
      dealt.sort(function (a, b) {
        var da = Math.abs(a - out.median_line), db = Math.abs(b - out.median_line);
        if (Math.abs(da - db) > EPS) return da - db;
        var na = mains.filter(function (q) { return Math.abs(q.line - a) < EPS; }).map(function (q) { return quoteMath(q).novig_over; }).filter(isNum);
        var nb = mains.filter(function (q) { return Math.abs(q.line - b) < EPS; }).map(function (q) { return quoteMath(q).novig_over; }).filter(isNum);
        return Math.abs((mean(na) == null ? 0.5 : mean(na)) - 0.5) - Math.abs((mean(nb) == null ? 0.5 : mean(nb)) - 0.5);
      });
      out.consensus_line = dealt.length ? dealt[0] : null;
    }
    out.line_range = out.lines.length ? r(out.lines[out.lines.length - 1] - out.lines[0], 2) : null;
    /* no-vig at the consensus line, averaged across the books that deal it */
    var atLine = mains.filter(function (q) { return Math.abs(q.line - out.consensus_line) < EPS; });
    var nvs = [], holds = [];
    atLine.forEach(function (q) { var m = quoteMath(q); if (m.novig_over != null) { nvs.push(m.novig_over); holds.push(m.hold); } });
    mains.forEach(function (q) { if (atLine.indexOf(q) < 0) { var m = quoteMath(q); if (m.hold != null) holds.push(m.hold); } });
    if (nvs.length) { out.novig_over = mean(nvs); out.novig_under = 1 - out.novig_over; out.novig_books = nvs.length; out.dispersion_pp = nvs.length > 1 ? r(100 * sdev(nvs), 2) : null; }
    out.hold_median = holds.length ? median(holds) : null;
    /* best price at the consensus line; best line at any price */
    var Rc = R();
    function better(a, b) { var da = Rc.americanToDecimal(a), db = Rc.americanToDecimal(b); return da != null && (db == null || da > db + EPS); }
    atLine.forEach(function (q) {
      if (q.over != null && (!out.best_over || better(q.over, out.best_over.price))) out.best_over = { book: lower(q.book), price: q.over, line: q.line, captured_at: q.captured_at };
      if (q.under != null && (!out.best_under || better(q.under, out.best_under.price))) out.best_under = { book: lower(q.book), price: q.under, line: q.line, captured_at: q.captured_at };
    });
    mains.forEach(function (q) {
      if (q.over != null && (!out.best_line_over || q.line < out.best_line_over.line - EPS || (Math.abs(q.line - out.best_line_over.line) < EPS && better(q.over, out.best_line_over.price)))) out.best_line_over = { book: lower(q.book), line: q.line, price: q.over };
      if (q.under != null && (!out.best_line_under || q.line > out.best_line_under.line + EPS || (Math.abs(q.line - out.best_line_under.line) < EPS && better(q.under, out.best_line_under.price)))) out.best_line_under = { book: lower(q.book), line: q.line, price: q.under };
    });
    var ts = mains.map(function (q) { return ms(q.captured_at); }).filter(isNum).sort(function (a, b) { return a - b; });
    if (ts.length) { out.oldest_at = iso(ts[0]); out.freshest_at = iso(ts[ts.length - 1]); out.freshness = freshness(out.freshest_at, now, cfg); }
    var sharp = mains.filter(function (q) { return SHARP_BOOKS.indexOf(lower(q.book)) >= 0; })[0];
    if (sharp) { var sm = quoteMath(sharp); out.sharp = { book: lower(sharp.book), line: sharp.line, novig_over: sm.novig_over }; }
    return out;
  }
  /* movement of the consensus through a capture history:
     history [{at, line, novig_over, over, under}] ordered by time */
  function movement(history, open, close) {
    var h = (history || []).filter(function (x) { return x && isNum(x.line) && ms(x.at) != null; }).sort(function (a, b) { return ms(a.at) - ms(b.at); });
    var o = open && isNum(open.line) ? open : (h[0] || null), c = h[h.length - 1] || null;
    var out = { opening: o ? { line: o.line, over: o.over != null ? o.over : null, under: o.under != null ? o.under : null, at: o.at || null, book: o.book || null } : null,
      current: c ? { line: c.line, over: c.over != null ? c.over : null, under: c.under != null ? c.under : null, at: c.at, novig_over: c.novig_over != null ? c.novig_over : null } : null,
      closing: close && isNum(close.line) ? close : null, high: null, low: null, line_move: null, novig_move_pp: null, captures: h.length, text: null };
    if (h.length) { var ls = h.map(function (x) { return x.line; }); out.high = Math.max.apply(null, ls); out.low = Math.min.apply(null, ls); }
    if (out.opening && out.current) {
      out.line_move = r(out.current.line - out.opening.line, 2);
      var no = null;
      if (o.novig_over != null) no = o.novig_over;
      else if (o.over != null && o.under != null) { var nv = R().noVigTwoWay(o.over, o.under); no = nv ? nv.a : null; }
      if (no != null && out.current.novig_over != null) out.novig_move_pp = r(100 * (out.current.novig_over - no), 2);
      out.text = Math.abs(out.line_move) < EPS ? 'Line unchanged since the first capture (' + lineNum(out.opening.line) + ')'
        : 'Moved ' + (out.line_move > 0 ? 'up ' : 'down ') + lineNum(Math.abs(out.line_move)) + ' from ' + lineNum(out.opening.line) + ' to ' + lineNum(out.current.line);
    }
    return out;
  }

  /* ========================================================== RELIABILITY
     0-100 from measured components only. Reliability is how much the
     number can be TRUSTED — it never reads the size of the edge. An
     unmeasured component is null, listed, and the weights renormalise over
     what was measured (EDMarket.quality's rule); historical calibration
     that has not been measured yet caps the score instead of vanishing. */
  function reliability(inp, cfg) {
    cfg = cfg || CFG;
    inp = inp || {};
    var W = cfg.reliability.weights, C = {}, notes = [], unmeasured = [];
    function set(k, v, note) { if (isNum(v)) C[k] = clamp(v, 0, 1); else { C[k] = null; unmeasured.push(k); } if (note) notes.push(note); }
    set('data_completeness', inp.data_completeness);
    /* effective opportunities vs what a stable estimate needs */
    /* n / (n + needed): half-credit at exactly the sample a stable estimate
       needs, scaled so twice that sample earns full credit */
    set('sample_size', isNum(inp.sample_n) && isNum(inp.sample_needed) && inp.sample_needed > 0 ? clamp(1.5 * inp.sample_n / (inp.sample_n + inp.sample_needed), 0, 1) : null);
    set('role_stability', isNum(inp.role_cv) ? 1 - clamp(inp.role_cv / 0.8, 0, 1) : null);
    var inj = { ACTIVE: 1, PROBABLE: 0.92, QUESTIONABLE: 0.55, UNRESOLVED: 0.45, DOUBTFUL: 0.2, OUT: 0, UNKNOWN: 0.7 };
    var st = upper(inp.player_status || 'ACTIVE');
    var injV = has(inj, st) ? inj[st] : 0.7;
    if (isNum(inp.teammate_uncertainty)) injV = injV * (1 - 0.5 * clamp(inp.teammate_uncertainty, 0, 1));
    if (inp.qb_unconfirmed) injV *= 0.75;
    set('injury_certainty', injV);
    set('model_agreement', isNum(inp.model_disagreement_z) ? 1 - clamp(Math.abs(inp.model_disagreement_z) / 2.5, 0, 1) : null);
    set('market_liquidity', isNum(inp.books) ? clamp(inp.books / 6, 0, 1) : null);
    set('book_agreement', isNum(inp.dispersion_pp) ? 1 - clamp(inp.dispersion_pp / 6, 0, 1) : (isNum(inp.books) && inp.books === 1 ? 0.4 : null));
    set('projection_variance', isNum(inp.cv) && isNum(inp.cv_norm) && inp.cv_norm > 0 ? 1 - clamp((inp.cv / inp.cv_norm - 0.8) / 1.2, 0, 1) : null);
    set('historical_calibration', isNum(inp.calibration_score) ? inp.calibration_score : null);
    set('redistribution', isNum(inp.redistribution_confidence) ? inp.redistribution_confidence : null);
    var s = 0, w = 0;
    Object.keys(W).forEach(function (k) { if (isNum(C[k])) { s += W[k] * C[k]; w += W[k]; } });
    var score = w > 0 ? 100 * s / w : null;
    var caps = [];
    if (isNum(score)) {
      var scale = cfg.reliability.league_scale[upper(inp.league)] || 1;
      if (scale < 1) { score *= scale; caps.push({ code: 'LEAGUE_SCALE', text: upper(inp.league) + ' reporting and participation data are less complete: reliability is scaled by ' + scale }); }
      if (!isNum(C.historical_calibration)) { if (score > 78) caps.push({ code: 'CALIBRATION_UNMEASURED', text: 'No graded calibration history yet for this prop type: reliability is capped at 78' }); score = Math.min(score, 78); }
      if (st === 'QUESTIONABLE' || st === 'DOUBTFUL' || st === 'UNRESOLVED') { score = Math.min(score, 55); caps.push({ code: 'STATUS', text: (st === 'UNRESOLVED' ? 'Availability unresolved' : 'Player listed ' + st.toLowerCase()) + ': reliability capped at 55' }); }
      if (isNum(inp.sample_n) && isNum(inp.sample_needed) && inp.sample_n < inp.sample_needed * 0.25) { score = Math.min(score, 50); caps.push({ code: 'THIN_SAMPLE', text: 'Very small usage sample: reliability capped at 50' }); }
    }
    var label = null;
    if (isNum(score)) for (var i = 0; i < cfg.reliability.labels.length; i++) if (score >= cfg.reliability.labels[i][0]) { label = cfg.reliability.labels[i][1]; break; }
    return { score: isNum(score) ? Math.round(score) : null, label: label, components: C, weights: copy(W), unmeasured: unmeasured, caps: caps, notes: notes, measured_weight: r(w, 3) };
  }
  function confidenceTier(score) { return !isNum(score) ? 'UNRATED' : (score >= 75 ? 'HIGH' : (score >= 60 ? 'MEDIUM' : (score >= 40 ? 'LOW' : 'VERY_LOW'))); }

  /* ================================================================ STAGE
     Validation_Eval as release gates. A market's stage is DERIVED from its
     evidence, never assigned because the market exists:
       EXPERIMENTAL   default; tier-3 markets stay here until calibration
                      of their own probabilities is proven
       TRACKING       walk-forward (V001) with no leakage (V002), beats the
                      empirical baseline (V003) on CRPS (V010), distribution
                      calibrated (V009 PIT, V022 coverage), probability slope
                      in [0.7, 1.3] at a synthetic line (V008) — all on the
                      untouched holdout fold (V021); live predictions are
                      being frozen and graded
       RESEARCH GRADE ≥ 200 settled live predictions, calibration slope in
                      [0.8, 1.2] (V008), Brier no worse than the no-vig
                      market (V004/V005), mean CLV ≥ 0 (V013), edge buckets
                      monotone (V016)
       PRODUCTION     ≥ 500 settled, mean CLV > 0 with a bootstrap interval
                      above zero, ROI interval not deeply negative (V015),
                      post-hoc calibration holds out of sample (V021) */
  var STAGES = ['EXPERIMENTAL', 'TRACKING', 'RESEARCH_GRADE', 'PRODUCTION'];
  var STAGE_LABEL = { EXPERIMENTAL: 'EXPERIMENTAL', TRACKING: 'TRACKING', RESEARCH_GRADE: 'RESEARCH GRADE', PRODUCTION: 'PRODUCTION' };
  var STAGE_RULES = { tracking: { min_backtest_n: 300, pit_max_dev: 0.12, coverage80_band: [0.72, 0.88], crps_vs_baseline_max: 1.0, synthetic_slope_band: [0.7, 1.3] },
    research: { min_live_n: 200, slope_band: [0.8, 1.2], brier_vs_market_max: 0.005, min_clv: 0 },
    production: { min_live_n: 500 } };
  function stageOf(ev, tier) {
    ev = ev || {};
    var gates = [], stage = 'EXPERIMENTAL', why = [];
    function gate(id, name, pass, detail) { gates.push({ id: id, name: name, pass: pass === true, measured: pass !== null && pass !== undefined, detail: detail || null }); return pass === true; }
    var bt = ev.backtest || null, live = ev.live || null, T = STAGE_RULES.tracking;
    var g1 = gate('V001', 'Walk-forward validation', bt ? !!bt.walk_forward : null, bt ? (bt.folds + ' weekly folds, n=' + bt.n) : 'no backtest');
    var g2 = gate('V002', 'As-of leakage audit', bt ? bt.leakage_violations === 0 : null, bt ? bt.leakage_violations + ' violations' : null);
    var g3 = gate('V003/V010', 'CRPS beats the shrunk baseline', bt && isNum(bt.crps) && isNum(bt.crps_baseline) ? bt.crps <= bt.crps_baseline * T.crps_vs_baseline_max : null, bt ? ('CRPS ' + r(bt.crps, 3) + ' vs baseline ' + r(bt.crps_baseline, 3)) : null);
    var g4 = gate('V009', 'PIT near uniform', bt && isNum(bt.pit_max_dev) ? bt.pit_max_dev <= T.pit_max_dev : null, bt && isNum(bt.pit_max_dev) ? 'max decile deviation ' + r(bt.pit_max_dev, 3) : null);
    var g5 = gate('V022', '80% interval coverage', bt && isNum(bt.coverage80) ? bt.coverage80 >= T.coverage80_band[0] && bt.coverage80 <= T.coverage80_band[1] : null, bt && isNum(bt.coverage80) ? probText(bt.coverage80) : null);
    var g6 = gate('BACKTEST_N', 'Backtest sample', bt ? bt.n >= T.min_backtest_n : null, bt ? 'n=' + bt.n + ' (needs ' + T.min_backtest_n + ')' : null);
    var g7 = gate('V008s', 'Calibration slope at a synthetic line (holdout)', bt && isNum(bt.synthetic_slope) ? bt.synthetic_slope >= T.synthetic_slope_band[0] && bt.synthetic_slope <= T.synthetic_slope_band[1] : null, bt && isNum(bt.synthetic_slope) ? 'slope ' + r(bt.synthetic_slope, 2) : null);
    var tracking = g1 && g2 && g3 && g4 && g5 && g6 && g7 && (tier == null || tier <= 2);
    if (tier === 3) why.push('Tier-3 market: stays EXPERIMENTAL until its own live calibration is proven');
    if (tracking) stage = 'TRACKING';
    var RR = STAGE_RULES.research;
    var n = live ? live.n : 0;
    var r1 = gate('LIVE_N', 'Settled live predictions', live ? n >= RR.min_live_n : null, 'n=' + n + ' (needs ' + RR.min_live_n + ')');
    var r2 = gate('V008', 'Calibration slope', live && isNum(live.slope) ? live.slope >= RR.slope_band[0] && live.slope <= RR.slope_band[1] : null, live && isNum(live.slope) ? 'slope ' + r(live.slope, 2) : null);
    var r3 = gate('V004', 'Brier vs no-vig market', live && isNum(live.brier) && isNum(live.market_brier) ? live.brier <= live.market_brier + RR.brier_vs_market_max : null, live && isNum(live.brier) ? 'model ' + r(live.brier, 4) + ' vs market ' + r(live.market_brier, 4) : null);
    var r4 = gate('V013', 'Closing-line value', live && isNum(live.clv_mean) ? live.clv_mean >= RR.min_clv : null, live && isNum(live.clv_mean) ? 'mean CLV ' + pctText(live.clv_mean, 2) : null);
    var r5 = gate('V016', 'Edge-bucket monotonicity', live ? live.edge_monotone === true : null, null);
    if (tracking && r1 && r2 && r3 && r4 && r5) stage = 'RESEARCH_GRADE';
    var p1 = gate('LIVE_N_PROD', 'Production sample', live ? n >= STAGE_RULES.production.min_live_n : null, 'n=' + n + ' (needs ' + STAGE_RULES.production.min_live_n + ')');
    var p2 = gate('V015', 'CLV interval above zero', live && live.clv_ci ? live.clv_ci[0] > 0 : null, live && live.clv_ci ? 'CLV 95% CI ' + pctText(live.clv_ci[0], 2) + ' to ' + pctText(live.clv_ci[1], 2) : null);
    var p3 = gate('V021', 'Held-out calibration', live ? live.calibration_holdout_ok === true : null, null);
    if (stage === 'RESEARCH_GRADE' && p1 && p2 && p3) stage = 'PRODUCTION';
    if (!bt) why.push('No walk-forward backtest on file');
    if (!live || !n) why.push('No settled live predictions yet');
    return { stage: stage, label: STAGE_LABEL[stage], gates: gates, why: why, rules: copy(STAGE_RULES) };
  }

  /* ============================================================ DECISION
     LAYER A · CAN WE EVALUATE?  NO DECISION, always with the blocker named:
       GAME_STARTED, PLAYER_OUT, PLAYER_UNMAPPED, NO_PROJECTION (MARKET ONLY),
       INSUFFICIENT_DATA, NO_MARKET (PROJECTION ONLY), STALE_QUOTE,
       FRESHNESS_UNKNOWN, NO_VALID_QUOTE, DISTRIBUTION_MISSING.
     LAYER B · SHOULD WE ACT?  Every quote on both sides, main and alternate,
       is priced; the class is EDDecision.priceClass on the RISK-ADJUSTED
       probability — the model probability moved toward the no-vig market
       by an amount set by reliability and the market's stage (the
       uncertainty haircut). Caps: stage, reliability, availability, the
       quarterback, one book, one-sided markets, alternate tails, and
       anomalies (WATCH · PRICE ANOMALY until a second book verifies). */
  var PROP_REASONS = {
    QUALIFIES: ['BET', 'The current price clears EdgeDesk’s edge and expected-value thresholds on the risk-adjusted probability.'],
    LEAN_EDGE: ['LEAN', 'A positive edge in the model’s direction at this price, below EdgeDesk’s betting thresholds.'],
    NEAR_THRESHOLD: ['WATCH', 'The current price is close, but it does not clear EdgeDesk’s betting threshold.'],
    MODEL_MARKET_DISAGREEMENT: ['WATCH', 'EdgeDesk’s fair line disagrees with the market, but the current price does not pay for it after the uncertainty haircut.'],
    PRICE_ANOMALY: ['WATCH', 'The price looks anomalous and no second book confirms it: neither a bet nor a data failure until it verifies.'],
    AVAILABILITY_PENDING: ['WATCH', 'An availability designation that changes this player’s usage is unresolved.'],
    QB_UNRESOLVED: ['WATCH', 'The starting quarterback is not confirmed, and the projection depends on him.'],
    STAGE_EXPERIMENTAL: ['LEAN', 'This prop market is EXPERIMENTAL: EdgeDesk has not yet proven its calibration, so it informs but never stakes.'],
    LOW_RELIABILITY: ['LEAN', 'The price clears the thresholds, but the projection’s reliability is below the betting floor.'],
    THIN_MARKET: ['LEAN', 'Only one sportsbook deals this prop: the edge is real arithmetic but the market is too thin to bet.'],
    ONE_SIDED: ['LEAN', 'Only one side of this number is priced, so no no-vig market probability exists to check the edge against.'],
    TAIL_UNVALIDATED: ['LEAN', 'Only an alternate line in the tail of the distribution qualifies: the tails decide that number.'],
    SIZING_ZERO: ['LEAN', 'The price clears the thresholds, but no stake survives the sizing caps at these odds.'],
    JUICE_CONSUMES_EDGE: ['PASS', 'The number has value, but the price consumes it.'],
    MARKET_ALIGNED: ['PASS', 'EdgeDesk’s fair line roughly agrees with the market: there is nothing to act on.'],
    NO_MODEL_EDGE: ['PASS', 'Negative expected value at every available quote on both sides.'],
    EDGE_TOO_SMALL: ['PASS', 'The edge is positive but too small to act on or to watch.'],
    GAME_STARTED: ['NO_DECISION', 'The game has started: pregame decisions are closed.'],
    PLAYER_OUT: ['NO_DECISION', 'The player is ruled out; the prop should void.'],
    PLAYER_UNMAPPED: ['NO_DECISION', 'The sportsbook’s player name did not resolve to one EdgeDesk player (bad sportsbook mapping).'],
    NO_PROJECTION: ['NO_DECISION', 'MARKET ONLY: EdgeDesk has no model for this prop type yet. The market is shown; no edge is claimed.'],
    INSUFFICIENT_DATA: ['NO_DECISION', 'INSUFFICIENT DATA: EdgeDesk does not have enough information to project this prop honestly.'],
    NO_MARKET: ['NO_DECISION', 'No sportsbook quote is on file for this prop: EdgeDesk’s projection is shown without a price.'],
    STALE_QUOTE: ['NO_DECISION', 'No sufficiently fresh sportsbook quote: the EV shown is from a stale price and is not acted on.'],
    FRESHNESS_UNKNOWN: ['NO_DECISION', 'No quote carries a capture time, so its freshness cannot be verified.'],
    NO_VALID_QUOTE: ['NO_DECISION', 'Every quote on file failed its price checks.'],
    DISTRIBUTION_MISSING: ['NO_DECISION', 'The projection has no outcome distribution, so no probability can be calculated.']
  };
  var CLASS_RANK = { PASS: 0, WATCH: 1, LEAN: 2, BET: 3 };
  function minClass(a, b) { return CLASS_RANK[a] <= CLASS_RANK[b] ? a : b; }
  function reasonText(code) { return PROP_REASONS[code] ? PROP_REASONS[code][1] : String(code || ''); }
  function decisionLabel(k) { var v = V(); if (v && v.decisionLabel) return v.decisionLabel(k); return k === 'NO_DECISION' ? 'NO DECISION' : k; }

  /* the probability the decision is made on: the no-vig market plus κ of
     the model's disagreement with it. κ = stage trust × reliability, floored.
     With no two-sided market the book's price is de-vigged at its own
     main-line hold (or the league's estimated hold, flagged). */
  function haircut(modelCover, marketProb, stage, rel, cfg, league) {
    cfg = cfg || CFG;
    var L = leagueCfg(cfg, league);
    var trust = cfg.stage_trust[stage] != null ? cfg.stage_trust[stage] : cfg.stage_trust.EXPERIMENTAL;
    var relF = isNum(rel) ? 0.35 + 0.65 * clamp(rel / 100, 0, 1) : 0.45;
    var k = clamp(trust * relF, L.haircut_floor, 1);
    if (!isNum(modelCover)) return null;
    if (!isNum(marketProb)) return { p: modelCover, k: 1, anchor: null };
    return { p: clamp(marketProb + k * (modelCover - marketProb), 0.001, 0.999), k: k, anchor: marketProb };
  }
  /* an EDQuoteEV-shaped priced quote, so EDDecision.metricsOf / priceClass
     classify a prop by exactly the rule that classifies a spread */
  function edQuoteShape(ps, dp, adjusted) {
    var win = dp.win, push = dp.push, loss = dp.loss;
    return { ev_available: true, model_win_probability: win, model_push_probability: push, model_loss_probability: loss,
      model_cover_probability: win + loss > 0 ? win / (win + loss) : null, expected_value: R().expectedRoi(win, ps.american, push),
      break_even_probability: ps.break_even, decimal_odds: ps.decimal, american_odds: ps.american, key_numbers: [], adjusted: adjusted || null };
  }
  function classify(m, T) {
    var Dd = D();
    if (Dd && typeof Dd.priceClass === 'function') return Dd.priceClass(m, { thresholds: T });
    /* EDDecision absent (a host that only prices): the same rule, verbatim */
    if (!m || !(m.ev > EPS)) return 'PASS';
    if (m.edge_pp >= T.bet.min_edge_pp - 1e-7 && m.ev >= T.bet.min_ev - EPS) return 'BET';
    if (m.edge_pp >= T.lean.min_edge_pp - 1e-7 && m.ev > T.lean.min_ev && m.direction_agrees) return 'LEAN';
    return 'WATCH';
  }
  function metricsOfShape(o) {
    var Dd = D();
    if (Dd && typeof Dd.metricsOf === 'function') return Dd.metricsOf(o);
    var cover = o.model_cover_probability, be = o.break_even_probability;
    return { ev: o.expected_value, edge_pp: 100 * (cover - be), cover: cover, be: be, direction_agrees: cover >= 0.5 - EPS, source: 'model_estimated' };
  }

  /* price every quote of one prop (both sides, main and alternates) */
  function priceAll(proj, quotes, ctx) {
    ctx = ctx || {};
    var cfg = ctx.cfg || CFG, league = upper(proj && proj.league) || 'NFL', L = leagueCfg(cfg, league);
    var d = proj && proj.dist, now = ctx.now;
    var cons = ctx.consensus || consensus(quotes, now, cfg);
    var rel = proj && proj.reliability ? proj.reliability.score : null;
    var stage = (proj && proj.stage) || 'EXPERIMENTAL';
    var summ = proj && proj.summary ? proj.summary : summarize(d);
    var sdv = summ && isNum(summ.sd) && summ.sd > 0 ? summ.sd : null, med = summ ? summ.median : null;
    var out = [];
    latestQuotes(quotes, null).forEach(function (q) {
      var fr = freshness(q.captured_at, now, cfg);
      var math = quoteMath(q);
      var binary = propType(proj.prop_type) && propType(proj.prop_type).kind === 'binary';
      var sides = binary ? [['yes', q.over], ['no', q.under]] : [['over', q.over], ['under', q.under]];
      sides.forEach(function (sp) {
        var side = sp[0], am = num(sp[1]);
        if (am == null) return;
        /* the market probability for THIS side at THIS line: the book's own
           no-vig when two-sided; else its price de-vigged at a hold */
        var mp = null, mps = null;
        if (math.two_sided) { mp = side === 'over' || side === 'yes' ? math.novig_over : math.novig_under; mps = 'no-vig (' + bookLabel(q.book) + ')'; }
        if (!q.is_alternate && isNum(cons.novig_over) && isNum(cons.consensus_line) && Math.abs(q.line - cons.consensus_line) < EPS && cons.novig_books >= 2) {
          mp = side === 'over' || side === 'yes' ? cons.novig_over : cons.novig_under; mps = 'no-vig consensus (' + cons.novig_books + ' books)';
        }
        if (mp == null) {
          var hold = isNum(cons.hold_median) ? cons.hold_median : L.estimated_hold;
          var ip = R().impliedProb(am);
          if (ip != null) { mp = clamp(ip / (1 + hold), 0.001, 0.999); mps = isNum(cons.hold_median) ? 'implied, de-vigged at the market’s median hold' : 'implied, de-vigged at an ESTIMATED ' + probText(L.estimated_hold) + ' hold'; }
        }
        var ps = priceSide(d, side, q.line, am, { market_prob: mp, market_prob_source: mps });
        var row = { quote_id: q.quote_id || null, book: lower(q.book), book_label: bookLabel(q.book), side: side, line: q.line, american: am, is_alternate: !!q.is_alternate,
          captured_at: q.captured_at || null, freshness: fr.state, age_minutes: fr.age_minutes, two_sided: math.two_sided, hold: r(math.hold, 4),
          implied: r(R().impliedProb(am), 4), novig: r(side === 'over' || side === 'yes' ? math.novig_over : math.novig_under, 4),
          market_prob: r(mp, 4), market_prob_source: mps, available: ps.available, reason: ps.reason,
          model_prob: r(ps.model_win, 4), model_push: r(ps.model_push, 4), model_cover: r(ps.model_cover, 4), fair_american: ps.fair_american,
          break_even: r(ps.break_even, 4), edge_pp: r(ps.edge_pp, 2), ev: r(ps.ev, 4), model_minus_market_pp: r(ps.model_minus_market_pp, 2),
          decision_prob: null, decision_ev: null, decision_edge_pp: null, haircut_k: null, cls: 'PASS', caps: [], tail: false };
        if (!ps.available) { out.push(row); return; }
        var hc = haircut(ps.model_cover, mp, stage, rel, cfg, league);
        var dCover = hc ? hc.p : ps.model_cover, pu = ps.model_push || 0;
        var dp = { win: dCover * (1 - pu), push: pu, loss: (1 - dCover) * (1 - pu) };
        var shape = edQuoteShape({ american: am, decimal: ps.decimal, break_even: ps.break_even }, dp, null);
        var m = metricsOfShape(shape);
        row.decision_prob = r(dCover, 4); row.decision_ev = r(m ? m.ev : null, 4); row.decision_edge_pp = r(m ? m.edge_pp : null, 2); row.haircut_k = r(hc ? hc.k : null, 3);
        row.cls = classify(m, L.thresholds);
        /* the tail: alternates far from the distribution's centre */
        if (q.is_alternate && sdv && isNum(med)) {
          var z = Math.abs(q.line - med) / sdv;
          if (z > cfg.tail.max_z || am < cfg.tail.min_odds || am > cfg.tail.max_odds) row.tail = true;
        }
        out.push(row);
      });
    });
    return out;
  }
  /* is a quote's price confirmed by another book at the same line and side? */
  function verified(row, rows, cents) {
    return rows.some(function (o) { return o !== row && o.book !== row.book && o.side === row.side && Math.abs(o.line - row.line) < EPS && isNum(o.american) && Math.abs(centsBetween(o.american, row.american)) <= cents; });
  }
  function centsBetween(a, b) { var f = function (x) { return x < 0 ? x + 100 : x - 100; }; return f(b) - f(a); }

  /* THE PROP DECISION. proj: a projection record; quotes: normalised
     quotes for this (game, player, prop type); ctx: {now, cfg, availability,
     game_started, qb_unconfirmed, mapping}. Returns everything a card,
     the desk and the record read. */
  function evaluate(proj, quotes, ctx) {
    ctx = ctx || {};
    var cfg = ctx.cfg || CFG, now = ctx.now;
    var league = upper(proj && proj.league) || 'NFL', L = leagueCfg(cfg, league);
    var pt = propType(proj && proj.prop_type);
    var cons = consensus(quotes || [], now, cfg);
    var out = { version: VERSION, config_version: cfg.version, evaluated_at: iso(now), league: league, prop_type: proj ? proj.prop_type : null,
      model_version: proj ? proj.model_version || null : null, stage: (proj && proj.stage) || 'EXPERIMENTAL',
      data_state: 'OK', decision: 'NO_DECISION', decision_label: decisionLabel('NO_DECISION'), reason_code: null, reason: null, blockers: [], caps: [],
      side: null, recommended: null, units: 0, sizing: null, consensus: cons, priced: [], ladder: null, fair: null, best: null, watch_trigger: null, flags: [] };
    function block(code) { out.blockers.push(code); if (!out.reason_code) { out.reason_code = code; out.reason = reasonText(code); } }
    var status = upper(proj && proj.status);
    if (!proj) { block('NO_PROJECTION'); out.data_state = cons.books ? 'MARKET_ONLY' : 'NO_DATA'; return out; }
    if (ctx.game_started) block('GAME_STARTED');
    if (proj.availability && upper(proj.availability.status) === 'OUT') block('PLAYER_OUT');
    if (ctx.mapping && ctx.mapping.player_id == null && (quotes || []).length) block('PLAYER_UNMAPPED');
    if (status === 'UNMAPPED') { block('PLAYER_UNMAPPED'); out.data_state = 'BAD_MAPPING'; }
    else if (pt && pt.modeled === false || status === 'UNMODELED') { block('NO_PROJECTION'); out.data_state = 'MARKET_ONLY'; }
    else if (status === 'INSUFFICIENT_DATA') { block('INSUFFICIENT_DATA'); out.data_state = 'INSUFFICIENT_DATA'; out.missing = copy(proj.missing || []); }
    else if (!validDist(proj.dist)) { block('DISTRIBUTION_MISSING'); out.data_state = 'INSUFFICIENT_DATA'; }
    /* the model's own numbers exist without a market */
    if (validDist(proj.dist)) {
      var sm = proj.summary || summarize(proj.dist);
      out.fair = { line: sm.fair_line, mean: sm.mean, median: sm.median, sd: sm.sd };
      if (isNum(cons.consensus_line)) {
        var pa = probAt(proj.dist, cons.consensus_line);
        out.fair.at_market = { line: cons.consensus_line, p_over: r(pa.over, 4), p_under: r(pa.under, 4), p_push: r(pa.push, 4),
          fair_over: fairAmericanOf(pa.over, pa.push), fair_under: fairAmericanOf(pa.under, pa.push), diff: r(sm.fair_line - cons.consensus_line, 2) };
      }
    }
    if (!(quotes || []).length) { if (!out.blockers.length) { block('NO_MARKET'); out.data_state = 'PROJECTION_ONLY'; } return out; }
    if (out.blockers.length) { if (validDist(proj.dist) && out.blockers.indexOf('NO_PROJECTION') < 0) out.priced = priceAll(proj, quotes, { cfg: cfg, now: now, consensus: cons }); return finish(out); }
    var rows = priceAll(proj, quotes, { cfg: cfg, now: now, consensus: cons });
    out.priced = rows;
    var valid = rows.filter(function (x) { return x.available; });
    if (!valid.length) { block('NO_VALID_QUOTE'); return finish(out); }
    var fresh = valid.filter(function (x) { return x.freshness === 'FRESH' || x.freshness === 'AGING'; });
    if (!fresh.length) {
      if (valid.every(function (x) { return x.freshness === 'UNKNOWN'; })) block('FRESHNESS_UNKNOWN'); else block('STALE_QUOTE');
      out.flags.push({ code: 'STALE', text: 'Every quote is older than the ' + cfg.freshness.max_minutes + '-minute decision limit: EV is shown from a stale price and not acted on.' });
      return finish(out);
    }
    /* LAYER B: caps per quote, then the best risk-adjusted candidate */
    var avail = proj.availability || {}, st = upper(avail.status || 'ACTIVE');
    var stageCap = cfg.stage_max_class[out.stage] || 'LEAN';
    fresh.forEach(function (x) {
      var caps = [];
      if (stageCap !== 'BET') caps.push('STAGE_EXPERIMENTAL');
      if (isNum(proj.reliability && proj.reliability.score) && proj.reliability.score < L.min_reliability_bet) caps.push('LOW_RELIABILITY');
      if (!isNum(proj.reliability && proj.reliability.score)) caps.push('LOW_RELIABILITY');
      if (st === 'QUESTIONABLE' || st === 'DOUBTFUL' || st === 'UNRESOLVED' || avail.teammate_pending) caps.push('AVAILABILITY_PENDING');
      if (ctx.qb_unconfirmed || proj.qb_unconfirmed) caps.push('QB_UNRESOLVED');
      if (cons.books <= 1) caps.push('THIN_MARKET');
      if (!x.two_sided) caps.push('ONE_SIDED');
      if (x.tail) caps.push('TAIL_UNVALIDATED');
      var anomalous = (isNum(x.ev) && x.ev > cfg.anomaly.raw_ev) || (isNum(x.edge_pp) && x.edge_pp > cfg.anomaly.edge_pp);
      if (anomalous && !verified(x, fresh, cfg.anomaly.verify_cents)) caps.push('PRICE_ANOMALY');
      x.caps = caps;
      var cls = x.cls;
      caps.forEach(function (c) { cls = minClass(cls, PROP_REASONS[c][0]); });
      x.raw_cls = x.cls; x.cls = cls;
    });
    /* the recommendation: best class, then risk-adjusted EV per unit of
       return spread, then main line over alternate */
    var ranked = fresh.slice().sort(function (a, b) {
      if (CLASS_RANK[b.cls] !== CLASS_RANK[a.cls]) return CLASS_RANK[b.cls] - CLASS_RANK[a.cls];
      var ra = riskAdj(a), rb = riskAdj(b);
      if (isNum(ra) && isNum(rb) && Math.abs(ra - rb) > 1e-6) return rb - ra;
      if (a.is_alternate !== b.is_alternate) return a.is_alternate ? 1 : -1;
      return (b.decision_ev || -9) - (a.decision_ev || -9);
    });
    var top = ranked[0];
    var bestCls = top.cls;
    var positive = fresh.filter(function (x) { return isNum(x.ev) && x.ev > EPS; });
    var code;
    if (bestCls === 'BET') code = 'QUALIFIES';
    else if (bestCls === 'LEAN') code = top.caps.filter(function (c) { return PROP_REASONS[c][0] === 'LEAN'; })[0] || 'LEAN_EDGE';
    else if (bestCls === 'WATCH') code = top.caps.filter(function (c) { return PROP_REASONS[c][0] === 'WATCH'; })[0] || (Math.abs((out.fair && out.fair.at_market && out.fair.at_market.diff) || 0) > (sdOf(proj) || 99) * 0.25 ? 'MODEL_MARKET_DISAGREEMENT' : 'NEAR_THRESHOLD');
    else code = !positive.length ? 'NO_MODEL_EDGE' : (Math.abs((out.fair && out.fair.at_market && out.fair.at_market.diff) || 0) < (sdOf(proj) || 1) * 0.08 ? 'MARKET_ALIGNED' : (top.edge_pp > 0 && top.ev <= 0 ? 'JUICE_CONSUMES_EDGE' : 'EDGE_TOO_SMALL'));
    out.decision = bestCls; out.decision_label = decisionLabel(bestCls); out.reason_code = code; out.reason = reasonText(code);
    out.caps = top.caps.slice();
    out.side = bestCls === 'PASS' ? (positive.length ? positive.sort(function (a, b) { return b.ev - a.ev; })[0].side : modelSide(out)) : top.side;
    out.recommended = bestCls === 'PASS' ? null : rowSummary(top);
    if (bestCls === 'BET') {
      out.sizing = size(top, proj, cfg);
      out.units = out.sizing.units;
      if (!(out.units > 0)) { out.decision = 'LEAN'; out.decision_label = decisionLabel('LEAN'); out.reason_code = 'SIZING_ZERO'; out.reason = reasonText('SIZING_ZERO'); }
    }
    /* WATCH trigger: the price or line at which the best non-BET side would clear */
    if (out.decision !== 'BET' && out.decision !== 'NO_DECISION') out.watch_trigger = watchTrigger(proj, top, cfg, league);
    return finish(out);

    function finish(o) {
      o.ladder = ladder(o.priced, proj, cfg);
      o.best = bestSummary(o, cons);
      if (!o.side) o.side = modelSide(o);
      o.id = hash([o.model_version, proj && proj.projection_id, (quotes || []).map(function (q) { return q.quote_id || [q.book, q.line, q.over, q.under, q.captured_at].join('/'); }).sort()]);
      return o;
    }
  }
  function sdOf(proj) { var s = proj && (proj.summary || summarize(proj.dist)); return s ? s.sd : null; }
  function modelSide(o) {
    var f = o.fair && o.fair.at_market; if (!f) return null;
    var bin = propType(o.prop_type) && propType(o.prop_type).kind === 'binary';
    return f.p_over >= f.p_under ? (bin ? 'yes' : 'over') : (bin ? 'no' : 'under');
  }
  function riskAdj(x) {
    if (!isNum(x.decision_ev) || !isNum(x.decision_prob)) return null;
    var p = x.decision_prob, d = R().americanToDecimal(x.american), mu = x.decision_ev;
    var v = p * (d - 1) * (d - 1) + (1 - p) - mu * mu;
    return v > 0 ? mu / Math.sqrt(v) : null;
  }
  function rowSummary(x) {
    if (!x) return null;
    return { book: x.book, book_label: x.book_label, side: x.side, line: x.line, american: x.american, is_alternate: x.is_alternate, captured_at: x.captured_at,
      model_prob: x.model_prob, model_cover: x.model_cover, fair_american: x.fair_american, break_even: x.break_even, market_prob: x.market_prob, market_prob_source: x.market_prob_source,
      edge_pp: x.edge_pp, ev: x.ev, decision_prob: x.decision_prob, decision_ev: x.decision_ev, decision_edge_pp: x.decision_edge_pp, cls: x.cls, caps: x.caps,
      label: sideLabel(x.side) + ' ' + lineNum(x.line) + ' ' + priceText(x.american) + ' · ' + x.book_label };
  }
  function sideLabel(s) { return s === 'over' ? 'Over' : (s === 'under' ? 'Under' : (s === 'yes' ? 'Yes' : (s === 'no' ? 'No' : '—'))); }
  /* the board's one-line market: consensus, best price for the model side */
  function bestSummary(o, cons) {
    var side = o.side || modelSide(o) || (propType(o.prop_type) && propType(o.prop_type).kind === 'binary' ? 'yes' : 'over');
    var mains = o.priced.filter(function (x) { return !x.is_alternate && x.side === side && x.available; });
    var atCons = mains.filter(function (x) { return isNum(cons.consensus_line) && Math.abs(x.line - cons.consensus_line) < EPS; });
    var pool = atCons.length ? atCons : mains;
    /* a book that prices only the other side (a Yes-only touchdown market
       when the model leans No) still has a price: show it, never nothing */
    if (!pool.length) pool = o.priced.filter(function (x) { return !x.is_alternate && x.available; });
    var best = pool.slice().sort(function (a, b) { return (b.ev || -9) - (a.ev || -9); })[0] || null;
    return best ? rowSummary(best) : null;
  }
  /* the price (same line) or line (same price) at which the side clears BET */
  function watchTrigger(proj, top, cfg, league) {
    if (!top || !top.available || !validDist(proj.dist)) return null;
    var L = leagueCfg(cfg, league), T = L.thresholds.bet;
    var cover = top.decision_prob;
    if (!isNum(cover)) return null;
    /* price: the decimal at which decision EV and edge both clear */
    var needBe = cover - T.min_edge_pp / 100;
    var decEv = (1 + T.min_ev) / cover;
    var decEdge = needBe > 0 ? 1 / needBe : null;
    var dec = Math.max(decEv, decEdge || 0);
    var am = dec > 1 ? R().decimalToAmerican(dec) : null;
    var amR = isNum(am) ? (am > 0 ? Math.ceil(am) : Math.ceil(am)) : null;
    var line = null;
    if (top.side === 'over' || top.side === 'under') {
      /* at the same price: the half-point line at which the model cover clears */
      var target = 1 / R().americanToDecimal(top.american) + T.min_edge_pp / 100;
      var k = top.haircut_k || 1, anchor = top.market_prob;
      /* whole-point steps keep a book's half-point line on the half point */
      for (var step = 1; step <= 25; step++) {
        var L2 = top.side === 'over' ? top.line - step : top.line + step;
        var sp = sideProbs(proj.dist, top.side, L2);
        if (!sp) break;
        var mc = sp.win + sp.loss > 0 ? sp.win / (sp.win + sp.loss) : null;
        var dcov = isNum(anchor) ? anchor + k * (mc - anchor) : mc;
        if (isNum(dcov) && dcov >= target) { line = L2; break; }
      }
    }
    return { side: top.side, price_at_line: amR != null && (amR >= 100 || amR <= -100) ? { line: top.line, american: amR } : null, line_at_price: line != null ? { line: line, american: top.american } : null,
      text: (amR != null ? sideLabel(top.side) + ' ' + lineNum(top.line) + ' becomes a BET at ' + priceText(amR) + ' or better' : '') + (line != null ? (amR != null ? '; ' : '') + sideLabel(top.side) + ' ' + lineNum(line) + ' at ' + priceText(top.american) : '') };
  }

  /* ============================================================== LADDER
     Every priced (book, line, side). Highlights, never "best bet":
       BEST PRICE     the best price at the consensus main line, model side
       BEST EV        the largest raw EV among non-anomalous, non-tail quotes
       SAFER LINE     the highest model probability with positive EV inside
                      the executable odds band (never an ultra-short price)
       HIGHER UPSIDE  the longest price with positive EV inside the band
     A quote no other quote beats on BOTH probability and EV is on the
     frontier; the rest are dominated. */
  function ladder(rows, proj, cfg) {
    cfg = cfg || CFG;
    var ok = (rows || []).filter(function (x) { return x.available && x.freshness !== 'STALE' && x.freshness !== 'UNKNOWN'; });
    if (!ok.length) return { rows: [], tags: {}, frontier: [] };
    var band = function (x) { return x.american >= cfg.tail.min_odds && x.american <= cfg.tail.max_odds; };
    var clean = ok.filter(function (x) { return (x.caps || []).indexOf('PRICE_ANOMALY') < 0; });
    var pos = clean.filter(function (x) { return x.ev > EPS && band(x); });
    var tags = {};
    var side = null;
    var Dc = function (x) { return R().americanToDecimal(x.american); };
    if (proj && validDist(proj.dist)) { var mains = ok.filter(function (x) { return !x.is_alternate; }); side = mains.length ? (mains.slice().sort(function (a, b) { return b.ev - a.ev; })[0].side) : null; }
    var bp = ok.filter(function (x) { return !x.is_alternate && x.side === side; }).sort(function (a, b) { return Dc(b) - Dc(a) || a.line - b.line; })[0];
    if (bp) tags.best_price = idOf(bp);
    var be = clean.filter(function (x) { return !x.tail; }).sort(function (a, b) { return b.ev - a.ev; })[0];
    if (be && be.ev > EPS) tags.best_ev = idOf(be);
    /* SAFER / HIGHER UPSIDE compare RUNGS (distinct side-and-line), each at
       its best price: two books at one number are one rung, not a choice */
    var rung = {};
    pos.forEach(function (x) { var k = x.side + '|' + x.line; if (!rung[k] || Dc(x) > Dc(rung[k])) rung[k] = x; });
    var rungs = Object.keys(rung).map(function (k) { return rung[k]; });
    if (rungs.length >= 2) {
      var safer = rungs.slice().sort(function (a, b) { return b.model_cover - a.model_cover || Dc(b) - Dc(a); })[0];
      tags.safer_line = idOf(safer);
      var up = rungs.filter(function (x) { return x.side !== safer.side || Math.abs(x.line - safer.line) > EPS; }).sort(function (a, b) { return Dc(b) - Dc(a); })[0];
      if (up) tags.higher_upside = idOf(up);
    }
    var frontier = ok.filter(function (x) { return !ok.some(function (y) { return y !== x && y.model_cover >= x.model_cover - EPS && y.ev > x.ev + EPS && y.side === x.side; }); }).map(idOf);
    var list = ok.slice().sort(function (a, b) { return a.side === b.side ? (a.line - b.line || R().americanToDecimal(b.american) - R().americanToDecimal(a.american)) : (a.side < b.side ? -1 : 1); })
      .map(function (x) { var o = rowSummary(x); o.id = idOf(x); o.tail = x.tail; o.dominated = frontier.indexOf(o.id) < 0; o.tags = Object.keys(tags).filter(function (t) { return tags[t] === o.id; }); return o; });
    return { rows: list, tags: tags, frontier: frontier };
  }
  function idOf(x) { return [x.book, x.side, x.line, x.american].join('|'); }
  /* two quotes side by side ("Bijan 71.5 −110 vs 74.5 +105"): the same
     distribution, priced twice; never a claim about which "will hit" */
  function compareQuotes(proj, a, b) {
    function one(q) { var ps = priceSide(proj.dist, q.side, q.line, q.american); return { side: q.side, line: q.line, american: q.american, model_prob: r(ps.model_win, 4), push: r(ps.model_push, 4), cover: r(ps.model_cover, 4), break_even: r(ps.break_even, 4), fair_american: ps.fair_american, edge_pp: r(ps.edge_pp, 2), ev: r(ps.ev, 4), available: ps.available, reason: ps.reason }; }
    var A = one(a), B = one(b);
    var hi = isNum(A.ev) && isNum(B.ev) ? (A.ev >= B.ev ? 'a' : 'b') : null;
    return { a: A, b: B, higher_ev: hi, higher_probability: isNum(A.cover) && isNum(B.cover) ? (A.cover >= B.cover ? 'a' : 'b') : null,
      note: 'Both are priced on the same EdgeDesk distribution. The higher-probability quote is not the higher-EV quote when its price costs more than the extra probability is worth.' };
  }

  /* ============================================================== SIZING
     Fractional Kelly on the risk-adjusted probability, rounded DOWN onto
     the unit grid through every cap: the probability source (the stage),
     reliability, a thin market, an anomaly, and 1.00U. Exposure caps
     (player / game / team / day / correlated group) are applied across the
     whole card by applyExposure(). */
  function size(row, proj, cfg) {
    cfg = cfg || CFG;
    var S = cfg.sizing, stage = (proj && proj.stage) || 'EXPERIMENTAL';
    var source = cfg.stage_source[stage] || 'model_estimated';
    var p = row.decision_prob, dec = R().americanToDecimal(row.american);
    var out = { units: 0, kelly_full: null, kelly_units: null, caps: [], source: source, rule: 'quarter-Kelly on the risk-adjusted probability, rounded down' };
    if (!isNum(p) || !isNum(dec)) return out;
    var b = dec - 1, f = (b * p - (1 - p)) / b;
    out.kelly_full = r(f, 4);
    if (!(f > 0)) return out;
    var ku = S.kelly_fraction * f / S.unit_pct_of_bankroll;
    out.kelly_units = r(ku, 3);
    var cap = S.max_units;
    function capBy(v, code) { if (v < cap) { cap = v; out.caps.push(code); } }
    capBy(S.source_caps[source] != null ? S.source_caps[source] : 0.25, 'SOURCE_' + source.toUpperCase());
    var rel = proj && proj.reliability ? proj.reliability.score : null;
    for (var i = 0; i < S.reliability_caps.length; i++) if (isNum(rel) && rel >= S.reliability_caps[i][0]) { capBy(S.reliability_caps[i][1], 'RELIABILITY'); break; }
    if ((row.caps || []).indexOf('THIN_MARKET') >= 0) capBy(S.thin_market_cap, 'THIN_MARKET');
    var raw = Math.min(ku, cap);
    var u = 0;
    S.grid.forEach(function (g) { if (g <= raw + 1e-9) u = g; });
    out.units = u;
    return out;
  }
  /* cards: [{id, game_id, team, player_id, units, decision_ev, corr_group}] in
     priority order. Returns them with units reduced by exposure caps. */
  function applyExposure(cards, cfg, corr) {
    cfg = cfg || CFG;
    var E = cfg.sizing.exposure, grid = cfg.sizing.grid;
    var used = { player: {}, game: {}, team: {}, daily: 0, group: {} };
    return (cards || []).map(function (c) {
      var o = copy(c); o.exposure_caps = [];
      if (!(o.units > 0)) return o;
      var room = Math.min(E.player - (used.player[o.player_id] || 0), E.game - (used.game[o.game_id] || 0), E.team - (used.team[o.team] || 0), E.daily - used.daily);
      var grp = corr && typeof corr === 'function' ? corr(o) : o.corr_group;
      if (grp) room = Math.min(room, E.correlated_group - (used.group[grp] || 0));
      var u = 0; grid.forEach(function (g) { if (g <= Math.min(o.units, room) + 1e-9) u = g; });
      if (u < o.units) { o.exposure_caps.push('EXPOSURE'); o.units_before_exposure = o.units; o.units = u; }
      used.player[o.player_id] = (used.player[o.player_id] || 0) + u; used.game[o.game_id] = (used.game[o.game_id] || 0) + u;
      used.team[o.team] = (used.team[o.team] || 0) + u; used.daily += u; if (grp) used.group[grp] = (used.group[grp] || 0) + u;
      return o;
    });
  }

  /* ========================================================= CORRELATION
     Same-game props are NOT independent. The pipeline stores Spearman
     correlations between a game's simulated stats; a pair is evaluated
     through a Gaussian copula on those marginals — never as a product. */
  function normInv(p) {
    if (!(p > 0 && p < 1)) return null;
    var a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
      b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
      c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    var q, t;
    if (p < 0.02425) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; t = q * q;
    return (((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * q / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1);
  }
  function normCdf(x) { var t = 1 / (1 + 0.2316419 * Math.abs(x)), dd = 0.3989423 * Math.exp(-x * x / 2); var p = dd * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
  /* P(X < h, Y < k) for a standard bivariate normal with correlation rho
     (Gauss-Legendre on the Plackett identity: dΦ2/dρ = φ2) */
  function bvn(h, k, rho) {
    if (!isNum(h) || !isNum(k) || !isNum(rho)) return null;
    var base = normCdf(h) * normCdf(k);
    if (Math.abs(rho) < 1e-12) return base;
    var xs = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498, 0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363],
      ws = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620, 0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
    var s = 0, R2 = clamp(rho, -0.999999, 0.999999);
    for (var i = 0; i < xs.length; i++) {
      var rr = R2 * (xs[i] + 1) / 2, one = 1 - rr * rr;
      s += ws[i] * Math.exp(-(h * h - 2 * rr * h * k + k * k) / (2 * one)) / (2 * Math.PI * Math.sqrt(one));
    }
    return clamp(base + s * R2 / 2, 0, 1);
  }
  /* P(A and B) for two binary events with marginals pA, pB and latent rho */
  function jointProb(pA, pB, rho) {
    if (!(pA > 0 && pA < 1 && pB > 0 && pB < 1)) return null;
    var h = normInv(1 - pA), k = normInv(1 - pB);
    /* P(Z1 > h, Z2 > k) = P(−Z1 < −h, −Z2 < −k) */
    var j = bvn(-h, -k, isNum(rho) ? rho : 0);
    return j == null ? null : r(j, 6);
  }
  function correlationOf(corrs, a, b) {
    var list = corrs || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ((c.a === a && c.b === b) || (c.a === b && c.b === a)) return c.rho;
    }
    return null;
  }

  /* ========================================================= EXPLANATION
     WHY and RISKS are assembled from the projection's own drivers and the
     priced market — deterministic sentences with the numbers that produced
     them. The AI desk may summarise these; it may not add to them. */
  function explain(proj, ev) {
    var why = [], risks = [];
    if (!proj) return { why: why, risks: risks, side: null };
    var side = ev && ev.side ? ev.side : null;
    var dir = side === 'under' || side === 'no' ? -1 : 1;
    (proj.drivers || []).forEach(function (d) {
      if (!d || !d.text) return;
      if (!isNum(d.effect) || d.effect === 0) { if (d.kind === 'context') why.push(d.text); return; }
      if (d.effect * dir > 0) why.push(d.text); else if (Math.abs(d.effect) >= (d.material || 0)) risks.push(d.text);
    });
    (proj.risks || []).forEach(function (t) { if (t) risks.push(typeof t === 'string' ? t : t.text); });
    var mv = ev && ev.movement;
    if (mv && isNum(mv.line_move) && Math.abs(mv.line_move) >= 0.5) {
      var toward = ev.fair && isNum(ev.fair.line) && isNum(mv.opening && mv.opening.line) ? (Math.abs(ev.fair.line - mv.current.line) < Math.abs(ev.fair.line - mv.opening.line)) : null;
      risks.push('Market has moved from ' + lineNum(mv.opening.line) + ' to ' + lineNum(mv.current.line) + (toward === true ? ' — toward EdgeDesk’s number, so part of the disagreement is already priced' : ''));
    }
    if (ev && ev.consensus && ev.consensus.books === 1) risks.push('Only one sportsbook deals this prop');
    if (ev && ev.recommended && ev.recommended.is_alternate) risks.push('The value sits on an alternate line, which depends on the distribution’s tail');
    var sm = proj.summary;
    if (sm && isNum(sm.mean) && isNum(sm.median) && sm.mean - sm.median > 0.06 * Math.max(1, Math.abs(sm.mean)) && side === 'over') risks.push('Right-skewed outcome: the mean (' + lineNum(sm.mean) + ') sits above the median (' + lineNum(sm.median) + '), so most games land below the average');
    if (proj.reliability && isNum(proj.reliability.score) && proj.reliability.score < 55) risks.push('Low reliability (' + proj.reliability.score + '/100): ' + ((proj.reliability.caps || [])[0] ? proj.reliability.caps[0].text : 'thin or unstable inputs'));
    var seen = {};
    function dedupe(a) { return a.filter(function (t) { var k = String(t); if (seen[k]) return false; seen[k] = 1; return true; }); }
    return { side: side, why: dedupe(why).slice(0, 6), risks: dedupe(risks).slice(0, 6) };
  }

  /* ============================================================ GAME FILE
     A game file stores each projection COMPACTLY: fields shared by the whole
     file (league, game, kickoff, versions, as-of, input hash) once at the
     top, fields shared by one player (identity, availability, opportunity,
     efficiency) once per player. hydrate() rebuilds the full projection
     record — every host calls it, so every host reads the same record. */
  var FILE_KEYS = ['league', 'season', 'week', 'game_id', 'kickoff', 'model_version', 'feature_version', 'as_of', 'inputs_hash'];
  var PLAYER_KEYS = ['player_name', 'position', 'team', 'opponent', 'home_away', 'provider_ids', 'availability', 'opportunity', 'efficiency'];
  function compactGame(file, records) {
    var players = {}, recs = [];
    (records || []).forEach(function (rec) {
      var o = {}, pl = players[rec.player_id] || (players[rec.player_id] = {}), k;
      for (k in rec) if (has(rec, k)) {
        if (FILE_KEYS.indexOf(k) >= 0 || k === 'schema') continue;
        if (PLAYER_KEYS.indexOf(k) >= 0) { if (k === 'opportunity' && pl.opportunity && !rec.opportunity) continue; pl[k] = rec[k]; continue; }
        o[k] = rec[k];
      }
      recs.push(o);
    });
    FILE_KEYS.forEach(function (k) { if (records && records[0] && records[0][k] !== undefined && file[k] === undefined) file[k] = records[0][k]; });
    file.players = players;
    file.projections = recs;
    return file;
  }
  function hydrate(file, rec) {
    if (!rec) return null;
    if (rec.schema === 'edgedesk_prop_projection_v1') return rec;
    var o = { schema: 'edgedesk_prop_projection_v1' }, k;
    FILE_KEYS.forEach(function (fk) { if (file && file[fk] !== undefined) o[fk] = file[fk]; });
    var pl = file && file.players ? file.players[rec.player_id] : null;
    if (pl) for (k in pl) if (has(pl, k)) o[k] = pl[k];
    for (k in rec) if (has(rec, k)) o[k] = rec[k];
    return o;
  }
  function projectionsOf(file) { return ((file && file.projections) || []).map(function (x) { return hydrate(file, x); }); }

  /* =============================================================== PREPARE
     THE ONE ENTRY POINT every surface calls: a projection from the game file,
     the quotes from the market file, and the board's context (stage table,
     per-prop-type variance norm, the record's calibration) → the priced,
     decided, explained evaluation. The Node build ran exactly this for the
     board; the browser and the desk re-run it on the same inputs. */
  function stageFor(stages, prop, pos) {
    var t = stages && stages[prop];
    if (tierOf(prop, pos) === 3) return 'EXPERIMENTAL';
    return t && t.stage ? t.stage : 'EXPERIMENTAL';
  }
  function compactReliability(rel) {
    if (!rel) return null;
    var c = {};
    Object.keys(rel.components || {}).forEach(function (k) { c[k] = r(rel.components[k], 3); });
    return { score: rel.score, label: rel.label, tier: confidenceTier(rel.score), components: c, unmeasured: rel.unmeasured || [], caps: (rel.caps || []).map(function (x) { return x.text || x; }) };
  }
  function prepare(proj, quotes, ctx) {
    ctx = ctx || {};
    var p = {}, k;
    for (k in proj) if (has(proj, k)) p[k] = proj[k];
    p.stage = p.stage && !ctx.stages ? p.stage : stageFor(ctx.stages, p.prop_type, p.position);
    var cons = consensus(quotes || [], ctx.now, ctx.cfg);
    if (upper(p.status) === 'PROJECTED') {
      var ri = {};
      for (k in (p.reliability_inputs || {})) if (has(p.reliability_inputs, k)) ri[k] = p.reliability_inputs[k];
      if (cons.books) { ri.books = cons.books; ri.dispersion_pp = cons.dispersion_pp; }
      ri.cv_norm = ctx.cv_norm && isNum(ctx.cv_norm[p.prop_type]) ? ctx.cv_norm[p.prop_type] : null;
      ri.calibration_score = ctx.calibration && isNum(ctx.calibration[p.prop_type]) ? ctx.calibration[p.prop_type] : null;
      p.reliability = compactReliability(reliability(ri, ctx.cfg));
    } else p.reliability = null;
    var started = ctx.game_started != null ? !!ctx.game_started : (isNum(ms(p.kickoff)) && isNum(ms(ctx.now)) ? ms(ctx.now) >= ms(p.kickoff) : false);
    var ev = evaluate(p, quotes || [], { now: ctx.now, cfg: ctx.cfg, game_started: started, qb_unconfirmed: p.qb_unconfirmed });
    ev.movement = movement(ctx.history || [], ctx.open || null, ctx.close || null);
    var ex = explain(p, ev);
    ev.why = ex.why; ev.risks = ex.risks;
    ev.reliability = p.reliability;
    return { projection: p, evaluation: ev };
  }

  /* ============================================================= GRADING
     A frozen prediction against the result. VOID when the player did not
     play (books void a prop on a DNP), the game was not played, or the
     result is unknown after settlement; PUSH on a whole-number line. Units
     are per 1U risked. CLV is measured against the closing no-vig
     probability at the SAME line (price CLV) and, separately, in line
     points against the closing consensus line. */
  function gradeSide(side, line, actual) {
    var a = num(actual), L = num(line), s = lower(side);
    if (a == null) return null;
    if (s === 'yes') return a >= 1 ? 'WIN' : 'LOSS';
    if (s === 'no') return a >= 1 ? 'LOSS' : 'WIN';
    if (L == null) return null;
    if (Math.abs(a - L) < EPS) return 'PUSH';
    if (s === 'over') return a > L ? 'WIN' : 'LOSS';
    if (s === 'under') return a < L ? 'WIN' : 'LOSS';
    return null;
  }
  function grade(pred, result) {
    pred = pred || {}; result = result || {};
    var out = { prediction_id: pred.prediction_id || null, result: null, actual: num(result.actual), units: null, profit_units: null, void_reason: null, graded_at: result.graded_at || null };
    if (result.game_status && /cancel|postpon|suspend/i.test(result.game_status)) { out.result = 'VOID'; out.void_reason = 'GAME_NOT_PLAYED'; return out; }
    if (result.played === false) { out.result = 'VOID'; out.void_reason = 'DID_NOT_PLAY'; return out; }
    if (out.actual == null) { out.result = 'VOID'; out.void_reason = result.final ? 'RESULT_UNAVAILABLE' : 'PENDING'; if (!result.final) out.result = null; return out; }
    var g = gradeSide(pred.side, pred.line, out.actual);
    out.result = g;
    var stake = isNum(pred.units) && pred.units > 0 ? pred.units : 1;
    var dec = R().americanToDecimal(pred.american);
    out.units = stake;
    out.profit_units = g === 'WIN' ? r(stake * (dec - 1), 4) : (g === 'LOSS' ? -stake : 0);
    out.flat_profit = g === 'WIN' ? r(dec - 1, 4) : (g === 'LOSS' ? -1 : 0);
    return out;
  }
  function clv(pred, close) {
    if (!pred || !close) return { price: null, line: null, basis: null };
    var out = { price: null, line: null, basis: null, close_line: close.line != null ? close.line : null };
    var s = lower(pred.side);
    if (isNum(close.line) && isNum(pred.line) && Math.abs(close.line - pred.line) < EPS && close.over != null && close.under != null) {
      var nv = R().noVigTwoWay(close.over, close.under);
      var fairSide = nv ? (s === 'under' || s === 'no' ? nv.b : nv.a) : null;
      var dec = R().americanToDecimal(pred.american);
      if (fairSide != null && dec != null) { out.price = r(dec * fairSide - 1, 4); out.basis = 'closing no-vig at the same line'; }
    }
    if (isNum(close.line) && isNum(pred.line)) out.line = r(s === 'under' ? pred.line - close.line : close.line - pred.line, 2);
    return out;
  }

  /* ============================================================= METRICS */
  function crps(d, y) {
    if (!validDist(d) || !isNum(y)) return null;
    var s = 0, acc = 0, hi = Math.max(d.lo + d.pmf.length, Math.ceil(y) + 1), lo = Math.min(d.lo - 1, Math.floor(y) - 1);
    for (var x = lo; x <= hi; x++) { var i = x - d.lo; if (i >= 0 && i < d.pmf.length) acc += d.pmf[i] / d.n; var ind = y <= x ? 1 : 0; s += (acc - ind) * (acc - ind); }
    return s;
  }
  /* randomized PIT for an integer outcome (u supplied for determinism) */
  function pit(d, y, u) {
    if (!validDist(d) || !isNum(y)) return null;
    var below = 0, at = 0;
    for (var i = 0; i < d.pmf.length; i++) { var x = d.lo + i; if (x < y) below += d.pmf[i]; else if (x === y) at += d.pmf[i]; }
    if (y < d.lo) return (isNum(u) ? u : 0.5) * 0;
    return (below + (isNum(u) ? u : 0.5) * at) / d.n;
  }
  function calibrationBins(pairs, nb) {
    nb = nb || 10;
    var bins = [];
    for (var i = 0; i < nb; i++) bins.push({ lo: i / nb, hi: (i + 1) / nb, n: 0, sum_p: 0, wins: 0 });
    (pairs || []).forEach(function (x) { if (!isNum(x.p) || (x.y !== 0 && x.y !== 1)) return; var k = Math.min(nb - 1, Math.floor(x.p * nb)); bins[k].n++; bins[k].sum_p += x.p; bins[k].wins += x.y; });
    return bins.filter(function (b) { return b.n > 0; }).map(function (b) {
      var w = R().wilson(b.wins, b.n);
      return { lo: b.lo, hi: b.hi, n: b.n, mean_p: r(b.sum_p / b.n, 4), observed: r(b.wins / b.n, 4), ci_lo: w ? r(w.lo, 4) : null, ci_hi: w ? r(w.hi, 4) : null };
    });
  }
  /* logistic recalibration y ~ a + b·logit(p): slope b, intercept a (V008) */
  function calibrationFit(pairs) {
    var xs = [], ys = [];
    (pairs || []).forEach(function (x) { if (isNum(x.p) && x.p > 0 && x.p < 1 && (x.y === 0 || x.y === 1)) { xs.push(Math.log(x.p / (1 - x.p))); ys.push(x.y); } });
    if (xs.length < 20) return { n: xs.length, slope: null, intercept: null };
    var a = 0, b = 1;
    for (var it = 0; it < 50; it++) {
      var ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
      for (var i = 0; i < xs.length; i++) {
        var z = a + b * xs[i], p = 1 / (1 + Math.exp(-z)), w = p * (1 - p), e = ys[i] - p;
        ga += e; gb += e * xs[i]; haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i];
      }
      var det = haa * hbb - hab * hab;
      if (Math.abs(det) < 1e-12) break;
      var da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
      a += da; b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return { n: xs.length, slope: r(b, 4), intercept: r(a, 4) };
  }
  /* a deterministic PRNG for bootstrap intervals (mulberry32) */
  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /* bootstrap by BLOCK (game or week), never by bet: correlated outcomes in
     one game are resampled together (Validation_Eval V015) */
  function bootstrapMean(values, blocks, B, seed) {
    var groups = {}, keys = [];
    (values || []).forEach(function (v, i) { if (!isNum(v)) return; var k = blocks ? blocks[i] : i; if (!groups[k]) { groups[k] = []; keys.push(k); } groups[k].push(v); });
    if (keys.length < 5) return null;
    var rand = rng(seed || 12345), res = [];
    for (var b = 0; b < (B || 1000); b++) {
      var s = 0, n = 0;
      for (var j = 0; j < keys.length; j++) { var g = groups[keys[Math.floor(rand() * keys.length)]]; for (var t = 0; t < g.length; t++) { s += g[t]; n++; } }
      res.push(n ? s / n : 0);
    }
    res.sort(function (x, y) { return x - y; });
    return [r(res[Math.floor(0.025 * res.length)], 5), r(res[Math.floor(0.975 * res.length)], 5)];
  }
  /* graded predictions → the scorecard every surface prints */
  function scorecard(rows, opts) {
    opts = opts || {};
    var settled = (rows || []).filter(function (x) { return x && (x.result === 'WIN' || x.result === 'LOSS' || x.result === 'PUSH'); });
    var dec = settled.filter(function (x) { return x.result !== 'PUSH'; });
    var wins = dec.filter(function (x) { return x.result === 'WIN'; }).length;
    var units = settled.reduce(function (t, x) { return t + (isNum(x.profit_units) ? x.profit_units : 0); }, 0);
    var risked = settled.reduce(function (t, x) { return t + (isNum(x.units) ? x.units : 0); }, 0);
    var flat = settled.reduce(function (t, x) { return t + (isNum(x.flat_profit) ? x.flat_profit : 0); }, 0);
    var pairs = dec.map(function (x) { return { p: x.model_cover, y: x.result === 'WIN' ? 1 : 0 }; });
    var mpairs = dec.filter(function (x) { return isNum(x.market_prob); }).map(function (x) { return { model: x.model_cover, market: x.market_prob, outcome: x.result === 'WIN' ? 1 : 0 }; });
    var briers = pairs.map(function (p) { return R().brier(p.p, p.y); }).filter(isNum);
    var lls = pairs.map(function (p) { return R().logLoss(p.p, p.y); }).filter(isNum);
    var clvs = settled.map(function (x) { return x.clv_price; }).filter(isNum);
    var expected = dec.reduce(function (t, x) { return t + (isNum(x.ev) ? x.ev : 0); }, 0);
    var w = R().wilson(wins, dec.length);
    var bs = mpairs.length ? R().brierSkill(mpairs) : null;
    return { n: (rows || []).length, settled: settled.length, decided: dec.length, wins: wins, losses: dec.length - wins, pushes: settled.length - dec.length,
      voids: (rows || []).filter(function (x) { return x && x.result === 'VOID'; }).length,
      win_rate: dec.length ? r(wins / dec.length, 4) : null, win_ci: w ? [r(w.lo, 4), r(w.hi, 4)] : null,
      mean_model_prob: pairs.length ? r(mean(pairs.map(function (p) { return p.p; })), 4) : null,
      units: r(units, 3), risked: r(risked, 3), roi: risked > 0 ? r(units / risked, 4) : null, flat_units: r(flat, 3), flat_roi: settled.length ? r(flat / settled.length, 4) : null,
      expected_units_flat: r(expected, 3),
      brier: briers.length ? r(mean(briers), 5) : null, log_loss: lls.length ? r(mean(lls), 5) : null,
      market_brier: bs && isNum(bs.market_brier) ? r(bs.market_brier, 5) : null, brier_skill_vs_market: bs && isNum(bs.skill) ? r(bs.skill, 4) : null,
      clv_n: clvs.length, clv_mean: clvs.length ? r(mean(clvs), 5) : null, clv_beat_rate: clvs.length ? r(clvs.filter(function (c) { return c > 0; }).length / clvs.length, 4) : null,
      clv_ci: clvs.length >= 30 ? bootstrapMean(settled.filter(function (x) { return isNum(x.clv_price); }).map(function (x) { return x.clv_price; }), settled.filter(function (x) { return isNum(x.clv_price); }).map(function (x) { return x.game_id; }), 1000, 7) : null,
      calibration: calibrationBins(pairs, opts.bins || 10), calibration_fit: calibrationFit(pairs),
      sample_state: sampleState(dec.length) };
  }
  /* lib/edgedesk_validation.js's sample language, one rule everywhere */
  function sampleState(n) { return n < 50 ? 'TOO EARLY' : (n < 200 ? 'EARLY SIGNAL' : (n < 500 ? 'DEVELOPING' : 'MEANINGFUL')); }
  function edgeBuckets(rows) {
    var B = [[0, 2], [2, 4], [4, 7], [7, 100]];
    return B.map(function (b) {
      var sub = (rows || []).filter(function (x) { return isNum(x.edge_pp) && x.edge_pp >= b[0] && x.edge_pp < b[1] && (x.result === 'WIN' || x.result === 'LOSS' || x.result === 'PUSH'); });
      var sc = scorecard(sub);
      return { bucket: b[0] + '–' + (b[1] >= 100 ? '+' : b[1]) + ' pp', n: sc.settled, win_rate: sc.win_rate, mean_model_prob: sc.mean_model_prob, flat_roi: sc.flat_roi, clv_mean: sc.clv_mean };
    });
  }

  /* ============================================================== FREEZE
     A qualifying pregame prediction, frozen with every number and the model
     version that produced it. The id is a hash of its own content; the
     record is deep-frozen. It is appended, never updated: a later price is
     a new prediction with its own id. */
  function freeze(proj, ev, now) {
    var rec = ev && (ev.recommended || ev.best);
    if (!proj || !ev || !rec) return null;
    var t = ms(now), ko = ms(proj.kickoff);
    if (t != null && ko != null && t >= ko) return null;
    var relObj = ev.reliability || proj.reliability || null, relScore = relObj && isNum(relObj.score) ? relObj.score : null;
    var body = { schema: 'edgedesk_prop_prediction_v1', league: proj.league, season: proj.season, week: proj.week, game_id: proj.game_id, kickoff: iso(proj.kickoff),
      player_id: proj.player_id, player_name: proj.player_name, team: proj.team, opponent: proj.opponent, position: proj.position, prop_type: proj.prop_type,
      side: rec.side, line: rec.line, american: rec.american, book: rec.book, is_alternate: !!rec.is_alternate, quote_captured_at: rec.captured_at,
      model_prob: rec.model_prob, model_cover: rec.model_cover, market_prob: rec.market_prob, fair_american: rec.fair_american, fair_line: ev.fair ? ev.fair.line : null,
      projection_mean: proj.summary ? proj.summary.mean : null, projection_median: proj.summary ? proj.summary.median : null,
      edge_pp: rec.edge_pp, ev: rec.ev, decision_prob: rec.decision_prob, decision_ev: rec.decision_ev,
      decision: ev.decision, reason_code: ev.reason_code, units: ev.units || 0, reliability: relScore,
      confidence_tier: confidenceTier(relScore), stage: ev.stage,
      model_version: proj.model_version, projection_id: proj.projection_id, frozen_at: iso(now) };
    body.prediction_id = 'ppd_' + hash(canonical(body), 16);
    return deepFreeze(body);
  }

  return {
    VERSION: VERSION, CONFIG_VERSION: CONFIG_VERSION, DEFAULT_CONFIG: deepFreeze(copy(DEFAULT_CONFIG)), config: config,
    PROP_TYPES: deepFreeze(copy(PROP_TYPES)), PROP_ORDER: PROP_ORDER, MARKET_GROUPS: MARKET_GROUPS, STAGES: STAGES, STAGE_LABEL: STAGE_LABEL, STAGE_RULES: deepFreeze(copy(STAGE_RULES)),
    REASONS: deepFreeze(copy(PROP_REASONS)), BOOK_LABEL: BOOK_LABEL, SHARP_BOOKS: SHARP_BOOKS,
    /* catalog */
    propType: propType, propTypeOfMarketKey: propTypeOfMarketKey, oddsApiMarkets: oddsApiMarkets, tierOf: tierOf, positionGroup: positionGroup,
    /* identity */
    normName: normName, nameVariants: nameVariants, resolvePlayer: resolvePlayer, mintPlayerId: mintPlayerId, slugify: slugify,
    /* distribution */
    encodeDist: encodeDist, validDist: validDist, probAt: probAt, quantile: quantile, quantileInt: quantileInt, cdfContinuous: cdfContinuous, moments: distMoments, fairLine: fairLine, summarize: summarize, nearestHalfLine: nearestHalfLine,
    /* pricing */
    sideProbs: sideProbs, priceSide: priceSide, breakEvenLine: breakEvenLine, fairAmerican: fairAmericanOf, haircut: haircut,
    /* market */
    pairOutcomes: pairOutcomes, quoteMath: quoteMath, consensus: consensus, latestQuotes: latestQuotes, movement: movement, freshness: freshness, qKey: qKey, bookLabel: bookLabel,
    /* judgement */
    reliability: reliability, confidenceTier: confidenceTier, stageOf: stageOf, evaluate: evaluate, priceAll: priceAll, ladder: ladder, compareQuotes: compareQuotes,
    size: size, applyExposure: applyExposure, explain: explain, reasonText: reasonText, prepare: prepare, stageFor: stageFor, compactReliability: compactReliability, compactGame: compactGame, hydrate: hydrate, projectionsOf: projectionsOf,
    /* correlation */
    normInv: normInv, normCdf: normCdf, bvn: bvn, jointProb: jointProb, correlationOf: correlationOf,
    /* record */
    gradeSide: gradeSide, grade: grade, clv: clv, freeze: freeze,
    /* metrics */
    crps: crps, pit: pit, calibrationBins: calibrationBins, calibrationFit: calibrationFit, bootstrapMean: bootstrapMean, scorecard: scorecard, edgeBuckets: edgeBuckets, sampleState: sampleState, rng: rng,
    /* text */
    hash: hash, canonical: canonical, priceText: priceText, probText: probText, pctText: pctText, ppText: ppText, lineText: lineNum, unitsText: unitsText, sideLabel: sideLabel
  };
}));
/*__EDPROPS_END__*/
