// deno-lint-ignore-file
/*__EDDESK_START__*/
/* ===========================================================================
   EdgeDesk DESK KERNEL — the analyst's answer, built from typed evidence.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHAT IT IS FOR
     A reader types "What's the best market line value today?", "Is Maryland
     -2.5 worth betting?", "Why?", "What if it drops to +2.5?", "Compare that
     to Maryland ML" or "Anything safer?" and gets a direct answer:

         ANSWER -> PRICE -> WHY -> RISK

     in three to eight sentences, at the depth the question asked for.

   WHO OWNS WHAT
     - The BACKEND calculates: fair lines and blends (EDPRICE), cover
       probabilities (EDPRICE.coverAt, or the model's own cover curve), quote
       freshness (EDINTEL.quoteState), the canonical per-game research object
       (lib/game_research.js: gap, movement, data quality, typed evidence).
     - THIS KERNEL structures and decides: the sport-aware evidence contract,
       the verdict for a price, the price ladder, the board ranking, the
       conversation state and the words. Every rule is below, printed, and
       deterministic: the same evidence gives the same answer.
     - The WRITING MODEL (when the host uses one) may only rephrase the
       answer this kernel wrote; `allowedNumbers()` feeds the host's critic.
       It never ranks, never prices and never supplies a number.

   THE RULES
     - Missing evidence stays missing (null) and lowers certainty. Nothing is
       filled with a neutral value.
     - A side's quality is never a price. "Team X is good" is not "Team X -7
       is a good price": every verdict is taken at an actual line and price.
     - A stale or unknown-age market is never a current opportunity.
     - Validation tiers are the pricing kernel's and are never upgraded here.
       A RESEARCH-tier market (the CFB spread today) can be a research lead;
       its confidence is capped by the tier weight the board already uses.
     - Similar Situations is withheld until SIMILAR_MIN_SETTLED comparable
       settled pregame predictions exist, and its features are pregame only.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDDESK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var EVIDENCE_SCHEMA = 'edgedesk_desk_evidence_v1';
  var ANSWER_SCHEMA = 'edgedesk_desk_answer_v1';
  var STATE_SCHEMA = 'edgedesk_desk_state_v1';
  var HISTORY_SCHEMA = 'edgedesk_prediction_history_v1';
  var CFB = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
  var SPORTS = {
    americanfootball_ncaaf: { key: CFB, short: 'CFB', label: 'college football' },
    americanfootball_nfl: { key: NFL, short: 'NFL', label: 'NFL' }
  };

  /* ------------------------------------------------------ the constants
     Every threshold is borrowed from a kernel that already owns it, with a
     fallback equal to that kernel's shipped value so the rules hold when
     this file is loaded on its own (tests). */
  function RS() { return root.EDRESEARCH || null; }
  function PK() {
    if (root.EDPRICE) return root.EDPRICE;
    if (typeof require === 'function') { try { return require('./_pricing.js'); } catch (_) { /* host inlines it */ } }
    return null;
  }
  function IK() { return root.EDINTEL || null; }
  function BK() { return root.EDBOARD || null; }
  function GR() {
    if (root.EDGameResearch) return root.EDGameResearch;
    if (typeof require === 'function') { try { return require('../../../lib/game_research.js'); } catch (_) { /* host inlines it */ } }
    return null;
  }
  /** Research threshold in points: EDRESEARCH's RESEARCH LEAD rule (|gap| >= 3). */
  function researchGap() { var r = RS(); return (r && r.DEFAULT_THRESHOLDS && num(r.DEFAULT_THRESHOLDS.disagreement_points)) || 3; }
  /** The hard disagreement rule (EDRESEARCH MODEL DISAGREEMENT, EDBOARD R0): a data check, never a pick. */
  function outlierGap() { var b = BK(); return (b && num(b.OUTLIER_GAP_POINTS)) || 7; }
  /* EDBOARD R6 weights, reused rather than re-invented. */
  var FRESH_WEIGHT_DEFAULT = { CURRENT: 1, AGING: 0.85, STALE: 0.1, UNKNOWN: 0.05, LINE_ONLY: 0.05, STARTED: 0, NONE: 0 };
  var TIER_WEIGHT_DEFAULT = { VALIDATED: 1, LEAN: 0.8, PROBABILITY: 0.6, RESEARCH: 0.4 };
  function freshWeight(s) { var b = BK(); var t = (b && b.FRESH_WEIGHT) || FRESH_WEIGHT_DEFAULT; return t[s] != null ? t[s] : 0; }
  function tierWeight(t) { var b = BK(); var w = (b && b.TIER_WEIGHT) || TIER_WEIGHT_DEFAULT; return w[t] != null ? w[t] : w.RESEARCH; }
  /* Each piece of IMPORTANT evidence that is missing multiplies certainty by this. */
  var MISSING_PENALTY = 0.85;
  /* Grades. Evidence quality reads the data; confidence reads data x tier x freshness. */
  var QUALITY_GRADES = [[0.75, 'STRONG'], [0.55, 'MODERATE'], [0.35, 'WEAK']];
  var CONFIDENCE_GRADES = [[0.6, 'HIGH'], [0.4, 'MEDIUM'], [0.0001, 'LOW']];
  /* Similar Situations: never shown below this many comparable SETTLED pregame predictions. */
  var SIMILAR_MIN_SETTLED = 50;
  var SIMILAR_MIN_TOTAL_SETTLED = 150;

  /* ------------------------------------------------------------- helpers */
  function num(v) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r1(v) { var n = num(v); return n == null ? null : Math.round(n * 10) / 10; }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function half(v) { var n = num(v); return n == null ? null : Math.round(n * 2) / 2; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; var t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function normName(s) { return str(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function fmtLine(v) { var n = num(v); if (n == null) return '—'; if (n === 0) return 'pick’em'; return (n > 0 ? '+' : '') + r1(n); }
  function fmtAm(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + Math.round(n); }
  function pct(p) { var n = num(p); return n == null ? '—' : Math.round(n * 100) + '%'; }
  function pts(v) { var n = num(v); if (n == null) return '—'; var a = Math.abs(r1(n)); return a + (a === 1 ? ' point' : ' points'); }
  function amToDec(am) { var a = num(am); if (a == null || a === 0) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); }
  function decToAm(d) { d = num(d); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function probToAm(p) { p = num(p); if (p == null || p <= 0 || p >= 1) return null; return decToAm(1 / p); }
  function breakEven(odds, push) { var P = PK(); if (P) return P.breakEven(odds, push); var d = amToDec(odds); return d ? (1 - (num(push) || 0)) / d : null; }
  function gradeOf(v, table) { if (v == null) return 'INSUFFICIENT'; for (var i = 0; i < table.length; i++) if (v >= table[i][0]) return table[i][1]; return 'INSUFFICIENT'; }
  function cap(s) { s = str(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function uniq(a) { var o = [], seen = {}; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!seen[k]) { seen[k] = 1; o.push(x); } }); return o; }
  function sportShort(s) { return SPORTS[s] ? SPORTS[s].short : str(s); }
  function other(side) { return side === 'home' ? 'away' : side === 'away' ? 'home' : side === 'over' ? 'under' : 'over'; }

  /* ================================================================
     1. THE TYPED EVIDENCE CONTRACT (edgedesk_desk_evidence_v1)

     INPUT (host-normalised; every field optional except sport and game):
       sport, now,
       game:       {game_id, home, away, kickoff, venue, neutral_site, status, season, week}
       projection: {home_line, total, home_win_prob, version, generated_at,
                    completeness, information_confidence, priced_confidence,
                    sigma, cover_curve:[{home_line, win, push, lose}],
                    contributions:[{key, points}]}      (home-margin points)
       market:     {spread:{home_line, book, price_home, price_away, captured_at, freshness, executable, source},
                    total:{line, book, price_over, price_under, captured_at, freshness, executable, source},
                    moneyline:{home, away, book, captured_at, freshness, source},
                    open:{home_line, captured_at, source}}
       contract:   CFB input-contract rows [{field, side, state, as_of, source, detail}]
       cfb:        {home_starter, away_starter, home_qb_epa, away_qb_epa}
       nfl:        {home_starter, away_starter, home_rest, away_rest, roof, surface,
                    div_game, data_quality, injuries:{home:[..], away:[..], as_of, source}, scenarios}
     ================================================================ */
  var CONTRACT_EXTRA = { team_rating: 'team_ratings', qb_efficiency_history: 'qb' };
  var APPLICABLE = {
    americanfootball_ncaaf: ['market', 'team_ratings', 'qb', 'injuries', 'player_quality', 'coaching', 'model_inputs', 'weather'],
    americanfootball_nfl: ['market', 'qb', 'injuries', 'model_inputs', 'weather']
  };
  var NFL_DRIVER_LABEL = { baseline: 'home field', net_pts: 'scoring margin', net_epa: 'overall EPA per play', net_pass: 'passing efficiency',
    net_rush: 'rushing efficiency', qb_adj_diff: 'quarterback adjustment', rest_diff: 'rest', div_game: 'division-game adjustment' };

  /** Market state for one quote: CURRENT / AGING / STALE / UNKNOWN / LINE_ONLY / STARTED / NONE. */
  function quoteStatus(q, marketKey, kickoff, now) {
    if (!q || (num(q.home_line) == null && num(q.line) == null && num(q.home) == null && num(q.away) == null)) return { state: 'NONE', actionable: false, age_hours: null, why: 'no market on file' };
    var k = toMs(kickoff);
    var at = toMs(q.captured_at);
    var age = at == null ? null : r1((now - at) / 3600000);
    if (k != null && k <= now) return { state: 'STARTED', actionable: false, age_hours: age, why: 'the game has started; pregame prices only' };
    if (q.freshness && FRESH_WEIGHT_DEFAULT[q.freshness] != null) return { state: q.freshness, actionable: q.freshness === 'CURRENT' || q.freshness === 'AGING', age_hours: age, why: q.freshness_why || null };
    if (q.executable === false && at == null) return { state: 'LINE_ONLY', actionable: false, age_hours: null, why: 'a reference number with no book and no capture time; not a price you can take' };
    var I = IK();
    if (I && typeof I.quoteState === 'function') {
      var s = I.quoteState({ captured_at: q.captured_at, market: marketKey, kickoff: kickoff, now: now });
      return { state: s.status, actionable: !!s.actionable, age_hours: age, why: s.why || null };
    }
    if (at == null) return { state: 'UNKNOWN', actionable: false, age_hours: null, why: 'no capture time' };
    var limit = 6; /* game_research FRESH_HOURS.market */
    if (age > limit) return { state: 'STALE', actionable: false, age_hours: age, why: 'captured ' + age + 'h ago, past the ' + limit + 'h market window' };
    if (age > limit / 2) return { state: 'AGING', actionable: true, age_hours: age, why: 'captured ' + age + 'h ago' };
    return { state: 'CURRENT', actionable: true, age_hours: age, why: 'captured ' + age + 'h ago' };
  }

  /** The model's OWN cover probability for HOME at a home line, from its published cover curve (NFL), or null. */
  function curveCoverAt(curve, homeLine) {
    if (!Array.isArray(curve) || homeLine == null) return null;
    for (var i = 0; i < curve.length; i++) {
      var c = curve[i];
      if (c && num(c.home_line) != null && Math.abs(num(c.home_line) - homeLine) < 1e-9 && num(c.win) != null)
        return { win: num(c.win), push: num(c.push) || 0, lose: num(c.lose) };
    }
    return null;
  }

  function contractBy(rows) {
    var by = {};
    (rows || []).forEach(function (r) { if (!r || !r.field) return; by[r.field] = by[r.field] || {}; by[r.field][r.side || 'game'] = r; });
    return by;
  }
  function parseNum(re, s) { var m = re.exec(str(s)); return m ? num(m[1]) : null; }
  function sideRow(row) {
    if (!row) return null;
    return { state: row.state || null, detail: row.detail || null, source: row.source || null, as_of: row.as_of || row.observed_at || null, priced: row.priced === true };
  }

  /** CFB-specific evidence, read from the published input contract. Values that do not parse stay null. */
  function cfbEvidence(input) {
    var by = contractBy(input.contract);
    var c = input.cfb || {};
    function pair(field, re) {
      var f = by[field] || {};
      var o = { home: sideRow(f.home), away: sideRow(f.away) };
      if (re) ['home', 'away'].forEach(function (s) { if (o[s]) o[s].value = o[s].state === 'UNAVAILABLE' || o[s].state === 'FETCH_FAILED' ? null : parseNum(re, o[s].detail); });
      return o;
    }
    function qb(side) {
      var st = c[side + '_starter'] || null, epa = c[side + '_qb_epa'] || null;
      var season = epa && epa.season && epa.season.state === 'MEASURED' ? epa.season : null;
      return {
        name: st ? (st.player_name || null) : null,
        status: st ? (st.status || null) : null,
        confirmed: st ? st.confirmed === true : false,
        epa_per_dropback: season ? num(season.epa_per_dropback) : null,
        dropbacks: season ? num(season.dropbacks) : null,
        epa_state: epa ? epa.state || null : null,
        priced: false,
        note: epa ? (epa.pricing_statement || null) : null
      };
    }
    var avail = by.availability || {};
    return {
      team_rating: pair('team_rating', /rated (-?\d+(?:\.\d+)?)/),
      roster_talent: pair('roster_talent', /composite (-?\d+(?:\.\d+)?)/),
      recruiting: pair('recruiting_talent', /composite (-?\d+(?:\.\d+)?)/),
      coaching: pair('coaching_continuity'),
      schedule: pair('schedule_context', /rest (\d+)d/),
      venue: pair('venue_geography'),
      weather: sideRow((by.weather || {}).game),
      availability: { home: sideRow(avail.home), away: sideRow(avail.away) },
      qb: { home: qb('home'), away: qb('away') }
    };
  }

  /** NFL-specific evidence: professional roster, starters, the official injury report, rest, roof, drivers. */
  function nflEvidence(input) {
    var n = input.nfl || {}, pj = input.projection || {};
    function starter(s) { var st = n[s + '_starter']; return st ? { name: st.player_name || null, status: st.status || null, confirmed: /CONFIRM|OFFICIAL/i.test(str(st.status)), source: st.source || null } : { name: null, status: null, confirmed: false, source: null }; }
    var drivers = (pj.contributions || []).filter(function (c) { return c && num(c.points) != null; }).map(function (c) {
      return { key: c.key, label: NFL_DRIVER_LABEL[c.key] || str(c.key).replace(/_/g, ' '), home_margin_points: r2(c.points) };
    });
    var inj = n.injuries || null;
    function injSide(s) {
      if (!inj || !Array.isArray(inj[s])) return null;
      return inj[s].map(function (p) { return { player: p.player || p.name || null, position: p.position || null, status: p.status || p.report_status || null }; })
        .filter(function (p) { return p.player; });
    }
    return {
      qb: { home: starter('home'), away: starter('away') },
      rest: { home: num(n.home_rest), away: num(n.away_rest) },
      roof: n.roof || null, surface: n.surface || null, div_game: n.div_game == null ? null : !!n.div_game,
      drivers: drivers,
      injuries: inj ? { home: injSide('home'), away: injSide('away'), as_of: inj.as_of || null, source: inj.source || null } : null,
      data_quality: n.data_quality || null,
      scenarios: n.scenarios || null
    };
  }

  /**
   * Build the evidence contract for one game.
   * The canonical research object is lib/game_research.js's; this wraps it
   * with the pricing kernel's fair line and tier, the market states, a
   * sport-specific block, the confidence grade and the missing-evidence list.
   */
  function evidence(input, opts) {
    input = input || {}; opts = opts || {};
    var now = toMs(input.now != null ? input.now : opts.now); if (now == null) now = Date.now();
    var sport = input.sport, g = input.game || {}, pj = input.projection || {}, mk = input.market || {};
    var P = PK(), G = GR();
    var projHome = num(pj.home_line), projTotal = num(pj.total), projWp = num(pj.home_win_prob);
    var hasProj = projHome != null;
    var sp = mk.spread || null, tt = mk.total || null, ml = mk.moneyline || null, op = mk.open || null;
    var st = {
      spread: quoteStatus(sp, 'spreads', g.kickoff, now),
      total: quoteStatus(tt ? { line: tt.line, captured_at: tt.captured_at, executable: tt.executable, freshness: tt.freshness } : null, 'totals', g.kickoff, now),
      moneyline: quoteStatus(ml, 'h2h', g.kickoff, now)
    };
    var mktHome = sp ? num(sp.home_line) : null, mktTotal = tt ? num(tt.line) : null;

    /* ---- the pricing kernel's fair lines and tiers (never recomputed here) */
    var FS = P && (hasProj || mktHome != null) ? P.fairSpread({ sport: sport, model_home_line: projHome, market_home_line: mktHome }) : null;
    var FT = P && (projTotal != null || mktTotal != null) ? P.fairTotal({ sport: sport, model_total: projTotal, market_total: mktTotal }) : null;
    var FM = P && (projWp != null || (ml && num(ml.home) != null && num(ml.away) != null)) ? P.fairMoneyline({ sport: sport, model_home_win_prob: projWp, market_home_ml: ml ? ml.home : null, market_away_ml: ml ? ml.away : null }) : null;
    var tierSpread = FS && FS.tier ? FS.tier : (P ? P.validationFor(sport, 'spread').tier : 'RESEARCH');
    var sigSpread = FS && num(FS.sigma) != null ? num(FS.sigma) : (P ? num(P.sigmaFor(sport, 'spread', P.validationFor(sport, 'spread')).sigma) : null);
    var sigTotal = FT && num(FT.sigma) != null ? num(FT.sigma) : (P ? num(P.sigmaFor(sport, 'total', P.validationFor(sport, 'total')).sigma) : null);
    if (num(pj.sigma) != null && sigSpread == null) sigSpread = num(pj.sigma);

    /* ---- the canonical research object */
    var research = null;
    if (G) {
      var qual = G.qualityFromContract ? G.qualityFromContract((input.contract || []).map(function (r) {
        return r && CONTRACT_EXTRA[r.field] ? Object.assign({}, r, { field: CONTRACT_EXTRA[r.field] === 'team_ratings' ? '__team_rating' : r.field }) : r;
      })) : {};
      /* team ratings: a category game_research does not map from the contract */
      var tr = (input.contract || []).filter(function (r) { return r && r.field === 'team_rating'; });
      if (tr.length) {
        var trUn = tr.filter(function (r) { return r.state === 'UNAVAILABLE' || r.state === 'FETCH_FAILED'; }).length;
        qual.team_ratings = { status: trUn === tr.length ? 'UNAVAILABLE' : trUn ? 'PARTIAL' : 'AVAILABLE', source: tr[0].source || null, note: 'team rating (published input contract)' };
      }
      /* A report that was not REQUIRED is not a report that says anyone is healthy. */
      var av = (input.contract || []).filter(function (r) { return r && r.field === 'availability'; });
      if (av.length && av.every(function (r) { return r.state === 'NOT_REQUIRED'; }))
        qual.injuries = { status: 'PARTIAL', note: 'no availability report was required for this game, so health is unknown rather than clean' };
      if (sport === NFL) {
        var nf = input.nfl || {};
        if (nf.injuries) qual.injuries = { available: true, captured_at: nf.injuries.as_of || null, source: nf.injuries.source || 'official NFL injury report' };
        var qbKnown = nf.home_starter && nf.away_starter;
        qual.qb = qbKnown ? { status: 'PARTIAL', note: 'starters from the schedule feed; not confirmed' } : { status: 'UNAVAILABLE', note: 'no starting quarterback on file for one or both sides' };
        if (nf.roof && /dome|closed/i.test(nf.roof)) qual.weather = { status: 'AVAILABLE', note: 'indoor venue' };
      }
      qual.market = sp && num(sp.home_line) != null ? { status: st.spread.state === 'CURRENT' || st.spread.state === 'AGING' ? 'AVAILABLE' : st.spread.state === 'STALE' ? 'STALE' : 'PARTIAL', captured_at: sp.captured_at || null, note: 'spread market ' + st.spread.state } : { status: 'UNAVAILABLE', note: 'no spread market on file' };
      qual.model_inputs = hasProj ? { available: true, captured_at: pj.generated_at || null, max_age_h: 192 } : { status: 'UNAVAILABLE', note: 'no projection on file' };
      var cc = null;
      if (Array.isArray(pj.cover_curve) && pj.cover_curve.length) cc = function (hl) { return curveCoverAt(pj.cover_curve, hl); };
      research = G.build({
        now: iso(now),
        game: { sport: sport, season: g.season, week: g.week, game_id: g.game_id, home: g.home, away: g.away, kickoff_at: g.kickoff, venue: g.venue, status: g.status },
        model: hasProj ? { model_id: pj.version || null, version: pj.version || null, captured_at: pj.generated_at || null, home_line: projHome, total: projTotal, home_win_prob: projWp, sigma: sigSpread, sigma_source: FS ? FS.sigma_basis : null, cover_at: cc || undefined } : null,
        market: {
          open: op ? { line: op.home_line, captured_at: op.captured_at, source: op.source } : undefined,
          current: sp ? { line: sp.home_line, captured_at: sp.captured_at, source: sp.source || sp.book } : undefined,
          total: tt ? { line: tt.line, captured_at: tt.captured_at } : undefined,
          moneyline: ml ? { home: ml.home, away: ml.away, captured_at: ml.captured_at, source: ml.source } : undefined,
          books: sp && sp.book && num(sp.home_line) != null ? [{ book: sp.book, line: sp.home_line, price_home: sp.price_home, price_away: sp.price_away, captured_at: sp.captured_at }] : []
        },
        quality: qual,
        quality_categories: APPLICABLE[sport] || APPLICABLE[NFL]
      });
    }

    /* ---- gap, in the research object's own terms */
    var gapPts = research && research.model_vs_market.raw_gap.value != null ? research.model_vs_market.raw_gap.value : (hasProj && mktHome != null ? Math.abs(projHome - mktHome) : null);
    var gapSide = research ? research.model_vs_market.side : (hasProj && mktHome != null ? (projHome < mktHome ? 'home' : projHome > mktHome ? 'away' : null) : null);

    /* ---- sport-specific block */
    var specific = sport === CFB ? { cfb: cfbEvidence(input) } : sport === NFL ? { nfl: nflEvidence(input) } : {};

    /* ---- what is missing, and which of it matters */
    var missing = [];
    function miss(key, why, important) { missing.push({ key: key, why: why, important: !!important }); }
    if (!hasProj) miss('projection', 'no EdgeDesk projection is on file for this game', true);
    if (mktHome == null) miss('spread_market', 'no spread market is on file', true);
    else if (st.spread.state === 'STALE' || st.spread.state === 'UNKNOWN') miss('current_spread', 'the last spread on file is ' + st.spread.state.toLowerCase() + (st.spread.age_hours != null ? ' (' + st.spread.age_hours + 'h old)' : ''), true);
    if (research) research.quality.categories.forEach(function (q) {
      if (q.category === 'market' || q.category === 'model_inputs') return;
      if (q.status === 'UNAVAILABLE') miss(q.category, q.category.replace(/_/g, ' ') + ' data is unavailable' + (q.note ? ' (' + q.note + ')' : ''), q.category === 'injuries' || q.category === 'qb' || q.category === 'team_ratings');
      else if (q.status === 'STALE') miss(q.category, q.category.replace(/_/g, ' ') + ' data is stale', q.category === 'injuries' || q.category === 'qb');
    });
    if (research && research.quality.categories.some(function (q) { return q.category === 'model_inputs' && q.status === 'STALE'; })) miss('model_inputs', 'the projection was built more than 8 days ago', true);
    if (sport === NFL && specific.nfl && specific.nfl.data_quality && Array.isArray(specific.nfl.data_quality.missing))
      specific.nfl.data_quality.missing.forEach(function (m) { miss('nfl:' + m, 'the NFL build reports ' + m + ' missing', true); });

    /* ---- reliability and confidence (deterministic; see CONFIDENCE RULE) */
    var info = num(pj.information_confidence);
    if (info != null && info > 1) info = info / 100;
    var completeness = research ? research.quality.completeness : num(pj.completeness);
    var dataQ = info != null ? info : completeness;
    var important = missing.filter(function (m) { return m.important; }).length;
    var qScore = dataQ == null ? null : r2(dataQ * Math.pow(MISSING_PENALTY, important));
    var reliability = {
      information_confidence: info, priced_confidence: num(pj.priced_confidence) != null ? (num(pj.priced_confidence) > 1 ? num(pj.priced_confidence) / 100 : num(pj.priced_confidence)) : null,
      completeness: completeness == null ? null : r2(completeness), engine_completeness: num(pj.completeness),
      score: qScore, grade: gradeOf(qScore, QUALITY_GRADES),
      rule: 'evidence quality = (information confidence, else data completeness) x ' + MISSING_PENALTY + ' per important missing input (' + important + ')'
    };

    var flags = research ? research.flags : null;
    return {
      schema: EVIDENCE_SCHEMA, version: VERSION, built_at: iso(now),
      sport: sport, sport_label: SPORTS[sport] ? SPORTS[sport].label : sport, sport_short: sportShort(sport),
      identity: { game_id: g.game_id != null ? String(g.game_id) : null, home: g.home || null, away: g.away || null, kickoff: g.kickoff || null,
        venue: g.venue || null, neutral_site: g.neutral_site === true, status: g.status || 'scheduled', season: g.season == null ? null : g.season, week: g.week == null ? null : g.week },
      projection: { home_line: projHome, total: projTotal, home_win_prob: projWp, version: pj.version || null, generated_at: pj.generated_at || null, has_cover_curve: Array.isArray(pj.cover_curve) && pj.cover_curve.length > 0 },
      fair: {
        spread: FS && FS.ok ? { fair_home_line: num(FS.fair_home_line), status: FS.status, tier: FS.tier, tier_basis: FS.tier_basis || null, required_edge_points: num(FS.required_edge_points), sigma: num(FS.sigma), sigma_basis: FS.sigma_basis || null, basis: FS.basis || null } : null,
        total: FT && FT.ok ? { fair_total: num(FT.fair_total), status: FT.status, tier: FT.tier, tier_basis: FT.tier_basis || null, sigma: num(FT.sigma) } : null,
        moneyline: FM && FM.ok ? { fair_home_win_prob: num(FM.fair_home_win_prob), status: FM.status, tier: FM.tier, tier_basis: FM.tier_basis || null } : null,
        tier: tierSpread, sigma_spread: sigSpread, sigma_total: sigTotal
      },
      market: {
        spread: sp ? { home_line: mktHome, book: sp.book || null, price_home: num(sp.price_home), price_away: num(sp.price_away), captured_at: sp.captured_at || null, source: sp.source || null, executable: sp.executable !== false, state: st.spread.state, actionable: st.spread.actionable, age_hours: st.spread.age_hours, why: st.spread.why } : { state: 'NONE' },
        total: tt ? { line: mktTotal, book: tt.book || null, price_over: num(tt.price_over), price_under: num(tt.price_under), captured_at: tt.captured_at || null, source: tt.source || null, executable: tt.executable !== false, state: st.total.state, actionable: st.total.actionable, age_hours: st.total.age_hours } : { state: 'NONE' },
        moneyline: ml ? { home: num(ml.home), away: num(ml.away), book: ml.book || null, captured_at: ml.captured_at || null, source: ml.source || null, state: st.moneyline.state, actionable: st.moneyline.actionable, age_hours: st.moneyline.age_hours } : { state: 'NONE' },
        open: op && num(op.home_line) != null ? { home_line: num(op.home_line), captured_at: op.captured_at || null, source: op.source || null } : null,
        movement: research ? research.model_vs_market.movement_since_open : null
      },
      gap: { points: gapPts == null ? null : r2(gapPts), side: gapSide, normalized: sigSpread && gapPts != null ? r2(gapPts / sigSpread) : null, outlier: gapPts != null && gapPts >= outlierGap() },
      reliability: reliability,
      specific: specific,
      missing: missing,
      typed: research && G ? G.evidence(research) : [],
      flags: flags ? flags.flags.map(function (f) { return f.key; }) : [],
      research: research,
      _curve: Array.isArray(pj.cover_curve) ? pj.cover_curve : null
    };
  }

  /* ================================================================
     2. PRICE A SELECTION AT AN ACTUAL LINE AND PRICE

     VERDICTS
       VALUE      the price clears EdgeDesk's rule for this market's tier:
                  VALIDATED/LEAN -> EDPRICE status PLAY or LEAN_PLAY;
                  RESEARCH -> the projection's own cover probability beats
                  the break-even AND the line is at least the research gap
                  (3 pts, EDRESEARCH) better than the projection.
       THIN       positive against the break-even, short of that rule.
       NO_VALUE   at or worse than the break-even: the market is efficient.
       OVERPRICED the market asks for more than EdgeDesk's own number (the
                  projection is on the other side of it).
       NO_PRICE / NO_PROJECTION  nothing to price.
     ================================================================ */
  function selFair(E, sel) {
    var pj = E.projection;
    if (sel.market === 'spread') { if (pj.home_line == null) return null; return sel.side === 'home' ? pj.home_line : -pj.home_line; }
    if (sel.market === 'total') return pj.total;
    return null;
  }
  /** Points of value vs the projection, positive = the line is better than EdgeDesk's number for this selection. */
  function valuePoints(E, sel, line) {
    var f = selFair(E, sel); if (f == null || num(line) == null) return null;
    if (sel.market === 'spread') return r2(num(line) - f);
    if (sel.market === 'total') return r2(sel.side === 'over' ? f - num(line) : num(line) - f);
    return null;
  }
  function homeLineOf(sel, line) { return sel.side === 'home' ? num(line) : -num(line); }
  /** Model cover probability of the selection at `line`, with where it came from. */
  function modelCover(E, sel, line) {
    var P = PK(), f = selFair(E, sel);
    if (f == null || num(line) == null || !P) return null;
    if (sel.market === 'spread') {
      var hl = homeLineOf(sel, line);
      var c = curveCoverAt(E._curve, hl);
      if (c) return { cover: sel.side === 'home' ? c.win : c.lose, push: c.push || 0, basis: 'EdgeDesk’s own margin distribution for this game' };
      var r = P.coverAt(f, num(line), E.fair.sigma_spread);
      return r ? { cover: r.cover, push: r.push, basis: 'the projection with the pricing kernel’s residual sigma (' + E.fair.sigma_spread + ')' } : null;
    }
    if (sel.market === 'total') {
      var s = E.fair.sigma_total; if (!s) return null;
      var pt = P.priceTotalSide({ fair: { ok: true, fair_total: f, sigma: s, tier: 'RESEARCH', model_total: f, market_total: num(line) }, side: sel.side, market_total: num(line), odds_american: sel.odds });
      return pt ? { cover: pt.cover_at_market, push: pt.push_at_market || 0, basis: 'the projected total with the pricing kernel’s residual sigma (' + s + ')' } : null;
    }
    return null;
  }
  function mlThresholdPP(E) {
    /* the probability equivalent of the research gap at this sport's sigma */
    var P = PK(), s = E.fair.sigma_spread; if (!P || !s) return 5;
    var z = researchGap() / s;
    var cov = P.coverAt(0, researchGap(), s); /* P(margin < gap) with fair 0 */
    return cov ? r2((cov.cover + cov.push / 2 - 0.5) * 100) : r2(z * 39.9);
  }

  /** Evaluate one selection {market, side, line, odds}. Pure; no state. */
  function evaluate(E, sel) {
    sel = Object.assign({}, sel);
    var P = PK();
    var out = { sel: sel, label: selLabel(E, sel), verdict: null, value_points: null, prob: null, fair: null, why: null, tier: null, current: false, market_state: null, outlier: false };
    var mkState = sel.market === 'spread' ? E.market.spread : sel.market === 'total' ? E.market.total : E.market.moneyline;
    out.market_state = sel.hypothetical ? 'HYPOTHETICAL' : (mkState ? mkState.state : 'NONE');
    out.current = !sel.hypothetical && !!(mkState && mkState.actionable);
    if (sel.odds == null) sel.odds = -110, out.odds_assumed = true;

    if (sel.market === 'moneyline') {
      var tierM = E.fair.moneyline ? E.fair.moneyline.tier : 'RESEARCH';
      var pHome = tierM === 'RESEARCH' || !E.fair.moneyline ? E.projection.home_win_prob : E.fair.moneyline.fair_home_win_prob;
      out.tier = tierM;
      if (pHome == null) { out.verdict = 'NO_PROJECTION'; out.why = 'no EdgeDesk win probability is on file'; return out; }
      if (num(sel.odds) == null) { out.verdict = 'NO_PRICE'; return out; }
      var p = sel.side === 'home' ? pHome : 1 - pHome;
      var be = breakEven(sel.odds, 0);
      var edge = r2((p - be) * 100);
      var thr = mlThresholdPP(E);
      out.prob = { win: r2(p), break_even: r2(be), edge_pp: edge, basis: tierM === 'RESEARCH' ? 'the projection’s win probability, research tier' : 'the validated moneyline blend' };
      out.fair = { price: probToAm(p), basis: out.prob.basis };
      out.threshold_pp = thr;
      out.verdict = edge >= thr ? 'VALUE' : edge > 0 ? 'THIN' : edge > -thr ? 'NO_VALUE' : 'OVERPRICED';
      out.ladder = { kind: 'price', fair_price: probToAm(p), attractive_price: p - thr / 100 > 0 ? probToAm(p - thr / 100) : null, rule: 'fair price = EdgeDesk’s win probability; attractive = ' + thr + ' probability points better (the research gap of ' + researchGap() + ' pts at sigma ' + E.fair.sigma_spread + ')' };
      return out;
    }

    var fairSel = selFair(E, sel);
    if (fairSel == null) { out.verdict = 'NO_PROJECTION'; out.why = 'no EdgeDesk projection is on file'; out.tier = E.fair.tier; return out; }
    if (num(sel.line) == null) { out.verdict = 'NO_PRICE'; out.why = 'no line on file'; out.tier = E.fair.tier; return out; }
    var v = valuePoints(E, sel, sel.line);
    out.value_points = v;
    out.outlier = v != null && Math.abs(v) >= outlierGap();
    var tier = sel.market === 'spread' ? (E.fair.spread ? E.fair.spread.tier : E.fair.tier) : (E.fair.total ? E.fair.total.tier : 'RESEARCH');
    out.tier = tier;
    var validated = tier === 'VALIDATED' || tier === 'LEAN';
    if (validated && P && sel.market === 'spread') {
      var FS = P.fairSpread({ sport: E.sport, model_home_line: E.projection.home_line, market_home_line: homeLineOf(sel, sel.line) });
      var r = P.priceSpreadSide({ fair: FS, side: sel.side, selection: sel.team, odds_american: sel.odds });
      out.fair = { line: r.fair_line, basis: 'the validated blend of projection and market (' + tier + ' tier)', projection_line: fairSel };
      out.prob = { cover: r.cover_at_market, push: r.push_at_market, break_even: r.break_even, edge_pp: r.edge_pp, basis: 'the validated blend (' + tier + ')' };
      out.pricing_status = r.status;
      out.required_points = r.required_edge_points;
      if (r.status === 'PLAY' || r.status === 'LEAN_PLAY') out.verdict = 'VALUE';
      else if (v != null && v < 0) out.verdict = 'OVERPRICED';
      else if (r.edge_pp != null && r.edge_pp > 0) out.verdict = 'THIN';
      else out.verdict = 'NO_VALUE';
      out.why = r.why;
    } else {
      var mc = modelCover(E, sel, sel.line);
      var be2 = breakEven(sel.odds, mc ? mc.push : 0);
      var edge2 = mc ? r2((mc.cover - be2) * 100) : null;
      out.fair = { line: fairSel, basis: 'EdgeDesk’s projection (' + tier + ' tier: the projection has not been validated as a betting price in this market)', projection_line: fairSel };
      out.prob = mc ? { cover: mc.cover, push: mc.push, break_even: r2(be2), edge_pp: edge2, basis: mc.basis + ', conditional on the projection being right' } : null;
      out.required_points = researchGap();
      if (v != null && v < 0) out.verdict = 'OVERPRICED';
      else if (edge2 == null || edge2 <= 0) out.verdict = 'NO_VALUE';
      else if (v >= researchGap()) out.verdict = 'VALUE';
      else out.verdict = 'THIN';
    }
    return out;
  }

  /**
   * THE PRICE LADDER: where this selection stops being worth it, from the
   * same evaluate() at every half point. attractive_at is the worst line that
   * is still VALUE; playable_at the worst that is VALUE or THIN.
   */
  function ladder(E, sel) {
    if (sel.market === 'moneyline') { var m = evaluate(E, sel); return m.ladder || null; }
    var f = selFair(E, sel); if (f == null) return null;
    var betterIsHigher = !(sel.market === 'total' && sel.side === 'over');
    var lines = [];
    for (var d = -8; d <= 16; d += 0.5) lines.push(half(f) + (betterIsHigher ? d : -d));
    var attractive = null, playable = null;
    lines.forEach(function (L) {
      var e = evaluate(E, Object.assign({}, sel, { line: L, hypothetical: true }));
      if (attractive == null && e.verdict === 'VALUE') attractive = L;
      if (playable == null && (e.verdict === 'VALUE' || e.verdict === 'THIN')) playable = L;
    });
    return { kind: sel.market === 'total' ? 'total' : 'line', attractive_at: attractive, playable_at: playable, better_is_higher: betterIsHigher,
      rule: 'each half point re-evaluated by the same verdict rule at ' + fmtAm(sel.odds == null ? -110 : sel.odds) + '; attractive = the worst number still VALUE, playable = the worst still THIN or better' };
  }
  function ladderText(E, sel, L) {
    if (!L) return null;
    if (L.kind === 'price') {
      if (L.fair_price == null) return null;
      return 'EdgeDesk’s fair price is ' + fmtAm(L.fair_price) + (L.attractive_price != null ? '; it gets attractive around ' + fmtAm(L.attractive_price) + ' or better' : '') + '.';
    }
    var fmt = sel.market === 'total' ? function (x) { return (sel.side === 'over' ? 'o' : 'u') + x; } : fmtLine;
    var who = sel.market === 'total' ? cap(sel.side) : sel.team;
    if (L.playable_at == null) return 'No number in a normal range makes ' + who + ' a value, by EdgeDesk’s rule.';
    var worse = L.better_is_higher ? L.playable_at - 0.5 : L.playable_at + 0.5;
    var parts = [];
    if (L.attractive_at != null) parts.push(fmt(L.attractive_at) + ' or better is attractive');
    if (L.playable_at !== L.attractive_at) parts.push(fmt(L.playable_at) + ' is still playable');
    return cap(parts.join('; ')) + '. At ' + fmt(worse) + ' or worse, pass.';
  }

  /* ================================================================
     3. REASONS AND RISKS, oriented onto a selection, from typed evidence
     ================================================================ */
  function poss(t) { t = str(t); return /s$/i.test(t) ? t + '’' : t + '’s'; }
  function teamOf(E, side) { return side === 'home' ? E.identity.home : side === 'away' ? E.identity.away : null; }
  function reasonsFor(E, sel) {
    var out = [], side = sel.side, oth = other(side);
    var me = teamOf(E, side), them = teamOf(E, oth);
    var sp = E.specific || {};
    if (sel.market === 'spread' || sel.market === 'moneyline') {
      if (sp.cfb) {
        var tr = sp.cfb.team_rating, a = tr[side] && tr[side].value, b = tr[oth] && tr[oth].value;
        if (a != null && b != null && Math.abs(a - b) >= 1)
          out.push({ key: 'team_rating', favours: a > b ? side : oth, weight: Math.abs(a - b), text: (a > b ? me : them) + ' grades ' + r1(Math.abs(a - b)) + ' points stronger on EdgeDesk’s team rating (' + r1(Math.max(a, b)) + ' vs ' + r1(Math.min(a, b)) + ')' });
        var rt = sp.cfb.roster_talent, ra = rt[side] && rt[side].value, rb = rt[oth] && rt[oth].value;
        if (ra != null && rb != null && Math.abs(ra - rb) >= 3)
          out.push({ key: 'roster_talent', favours: ra > rb ? side : oth, weight: Math.abs(ra - rb) / 5, text: (ra > rb ? me : them) + ' has the stronger measured roster (production composite ' + r1(Math.max(ra, rb)) + ' vs ' + r1(Math.min(ra, rb)) + ')' });
        var qa = sp.cfb.qb[side], qb = sp.cfb.qb[oth];
        if (qa && qb && qa.epa_per_dropback != null && qb.epa_per_dropback != null && Math.abs(qa.epa_per_dropback - qb.epa_per_dropback) >= 0.08) {
          var better = qa.epa_per_dropback > qb.epa_per_dropback ? qa : qb;
          out.push({ key: 'qb', favours: better === qa ? side : oth, weight: 1, research_only: true, text: better.name + ' has the better passing efficiency this season (' + r2(better.epa_per_dropback) + ' EPA per dropback vs ' + r2((better === qa ? qb : qa).epa_per_dropback) + '; research context, not priced)' });
        }
        var sc = sp.cfb.schedule, sa = sc[side] && sc[side].value, sb = sc[oth] && sc[oth].value;
        if (sa != null && sb != null && Math.abs(sa - sb) >= 3) out.push({ key: 'rest', favours: sa > sb ? side : oth, weight: 0.5, text: (sa > sb ? me : them) + ' has ' + Math.abs(sa - sb) + ' more days of rest' });
      }
      if (sp.nfl) {
        (sp.nfl.drivers || []).filter(function (d) { return d.key !== 'baseline' && Math.abs(d.home_margin_points) >= 0.4; })
          .sort(function (x, y) { return Math.abs(y.home_margin_points) - Math.abs(x.home_margin_points); }).slice(0, 3).forEach(function (d) {
            var fav = d.home_margin_points > 0 ? 'home' : 'away';
            out.push({ key: 'driver:' + d.key, favours: fav, weight: Math.abs(d.home_margin_points), text: teamOf(E, fav) + ' gains ' + pts(d.home_margin_points) + ' on ' + d.label + ' in EdgeDesk’s projection' });
          });
        var rs = sp.nfl.rest;
        if (rs.home != null && rs.away != null && Math.abs(rs.home - rs.away) >= 3) { var rf = rs.home > rs.away ? 'home' : 'away'; out.push({ key: 'rest', favours: rf, weight: 0.5, text: teamOf(E, rf) + ' has ' + Math.abs(rs.home - rs.away) + ' more days of rest' }); }
      }
      var mv = E.market.movement;
      if (mv && mv.toward_model_points != null && Math.abs(mv.toward_model_points) >= 1)
        out.push({ key: 'movement', favours: mv.toward_model_points > 0 ? E.gap.side : other(E.gap.side), weight: 0.8, text: 'the market has moved ' + pts(mv.toward_model_points) + (mv.toward_model_points > 0 ? ' toward' : ' away from') + ' EdgeDesk’s number since the open' });
    }
    if (sel.market === 'total' && E.projection.total != null) {
      out.push({ key: 'total', favours: E.projection.total > (sel.line || 0) ? 'over' : 'under', weight: 1, text: 'EdgeDesk projects ' + r1(E.projection.total) + ' total points' });
      if (sp.nfl && sp.nfl.roof && /dome|closed/i.test(sp.nfl.roof)) out.push({ key: 'roof', favours: null, weight: 0.2, text: 'indoor game, so weather is not a factor' });
    }
    out.sort(function (x, y) { return y.weight - x.weight; });
    return { for: out.filter(function (r) { return r.favours === side; }), against: out.filter(function (r) { return r.favours === oth; }), neutral: out.filter(function (r) { return r.favours == null; }) };
  }
  function risksFor(E, sel, ev) {
    var r = [], side = sel.side, sp = E.specific || {};
    var me = teamOf(E, side);
    if (ev && ev.outlier) r.push({ key: 'outlier', text: 'the gap is ' + pts(ev.value_points) + ', past the ' + outlierGap() + '-point line where EdgeDesk treats a disagreement as a data check (a wrong input is likelier than a mispriced market)' });
    var tier = ev ? ev.tier : E.fair.tier;
    if (tier === 'RESEARCH') {
      var basis = sel.market === 'spread' && E.fair.spread ? E.fair.spread.tier_basis : sel.market === 'total' && E.fair.total ? E.fair.total.tier_basis : E.fair.moneyline ? E.fair.moneyline.tier_basis : null;
      r.push({ key: 'tier', text: E.sport_short + ' ' + (sel.market === 'moneyline' ? 'moneyline' : sel.market) + ' projections are research tier' + (basis ? ': ' + basis : '') });
    }
    if (sel.market !== 'total' && side && sp.cfb) {
      var q = sp.cfb.qb[side];
      if (q && !q.confirmed) r.push({ key: 'qb', text: (q.name ? q.name + ' is not confirmed as ' + poss(me) + ' starter' : poss(me) + ' starter is unresolved') });
      var c = sp.cfb.coaching[side];
      if (c && /FIRST SEASON/i.test(str(c.detail))) r.push({ key: 'coaching', text: me + ' has a first-year head coach, so last season’s data describes a different program' });
    }
    if (sel.market !== 'total' && side && sp.nfl) {
      var nq = sp.nfl.qb[side];
      if (nq && !nq.name) r.push({ key: 'qb', text: 'no starting quarterback is on file for ' + me });
      else if (nq && !nq.confirmed) r.push({ key: 'qb', text: nq.name + ' is ' + poss(me) + ' starter by the schedule feed, not a confirmed report' });
    }
    E.missing.filter(function (m) { return m.important && m.key !== 'projection' && m.key !== 'spread_market'; }).forEach(function (m) { r.push({ key: 'missing:' + m.key, text: m.why }); });
    var rs = reasonsFor(E, sel).against;
    if (rs.length) r.push({ key: 'counter', text: 'the other side has a case: ' + rs[0].text });
    var mk = sel.market === 'spread' ? E.market.spread : sel.market === 'total' ? E.market.total : E.market.moneyline;
    if (mk && mk.state === 'AGING') r.push({ key: 'aging', text: 'the price was captured ' + (mk.age_hours != null ? mk.age_hours + 'h' : 'a while') + ' ago; confirm it is still there' });
    /* the strongest risk first: data problems, then the model's record, then the matchup */
    var order = { outlier: 0, qb: 1, 'missing:injuries': 2, tier: 3, coaching: 4, counter: 5, aging: 6 };
    r.sort(function (a, b) { var x = order[a.key] != null ? order[a.key] : (/^missing/.test(a.key) ? 2 : 7), y = order[b.key] != null ? order[b.key] : (/^missing/.test(b.key) ? 2 : 7); return x - y; });
    return r;
  }

  /* ================================================================
     4. CONFIDENCE RULE
       score = evidence quality x validation-tier weight x quote-freshness
       weight (the EDBOARD R6 weights). HIGH >= 0.6 (VALIDATED tier only), MEDIUM >= 0.4, LOW > 0.
       INSUFFICIENT: no projection, no price, or a market that is not current.
       An outlier gap caps it at LOW.
     ================================================================ */
  function confidence(E, ev) {
    var q = E.reliability.score;
    if (!ev || ev.verdict === 'NO_PROJECTION' || ev.verdict === 'NO_PRICE' || q == null) return { grade: 'INSUFFICIENT', score: null, rule: 'no projection, price or evidence-quality measure' };
    var st = ev.market_state === 'HYPOTHETICAL' ? 'CURRENT' : ev.market_state;
    var s = r2(q * tierWeight(ev.tier) * freshWeight(st));
    var g = !ev.current && ev.market_state !== 'HYPOTHETICAL' ? 'INSUFFICIENT' : gradeOf(s, CONFIDENCE_GRADES);
    if (ev.outlier && (g === 'HIGH' || g === 'MEDIUM')) g = 'LOW';
    /* only a VALIDATED tier can carry HIGH: LEAN is break-even history, not a profit */
    if (g === 'HIGH' && ev.tier !== 'VALIDATED') g = 'MEDIUM';
    return { grade: g, score: s, parts: { evidence_quality: q, tier: ev.tier, tier_weight: tierWeight(ev.tier), market_state: ev.market_state, freshness_weight: freshWeight(st) },
      rule: 'evidence quality ' + q + ' x tier ' + ev.tier + ' (' + tierWeight(ev.tier) + ') x market ' + st + ' (' + freshWeight(st) + ') = ' + s + '; HIGH >= 0.6, MEDIUM >= 0.4' };
  }

  /* ================================================================
     5. SELECTIONS AND THE BOARD RANKING
     ================================================================ */
  function selLabel(E, sel) {
    if (sel.market === 'total') return cap(sel.side) + ' ' + (sel.line == null ? '' : r1(sel.line));
    var t = sel.team || teamOf(E, sel.side);
    if (sel.market === 'moneyline') return t + ' ML';
    return t + ' ' + fmtLine(sel.line);
  }
  /** The market selections that exist on the evidence right now. */
  function currentSelections(E, markets) {
    var out = [], want = markets && markets.length ? markets : ['spread', 'total'];
    var sp = E.market.spread;
    if (want.indexOf('spread') >= 0 && sp && sp.home_line != null) ['home', 'away'].forEach(function (s) {
      out.push({ sport: E.sport, game_id: E.identity.game_id, market: 'spread', side: s, team: teamOf(E, s), line: s === 'home' ? sp.home_line : -sp.home_line,
        odds: s === 'home' ? sp.price_home : sp.price_away, book: sp.book });
    });
    var tt = E.market.total;
    if (want.indexOf('total') >= 0 && tt && tt.line != null) ['over', 'under'].forEach(function (s) {
      out.push({ sport: E.sport, game_id: E.identity.game_id, market: 'total', side: s, team: null, line: tt.line, odds: s === 'over' ? tt.price_over : tt.price_under, book: tt.book });
    });
    var ml = E.market.moneyline;
    if (want.indexOf('moneyline') >= 0 && ml && ml.home != null && ml.away != null) ['home', 'away'].forEach(function (s) {
      out.push({ sport: E.sport, game_id: E.identity.game_id, market: 'moneyline', side: s, team: teamOf(E, s), line: null, odds: s === 'home' ? ml.home : ml.away, book: ml.book });
    });
    return out;
  }
  function isDog(sel) { return sel.market === 'moneyline' ? num(sel.odds) > 0 : sel.market === 'spread' ? num(sel.line) > 0 : false; }
  function isFav(sel) { return sel.market === 'moneyline' ? num(sel.odds) < 0 : sel.market === 'spread' ? num(sel.line) < 0 : false; }
  function selKey(sel) { return [sel.sport, sel.game_id, sel.market, sel.side].join('|'); }

  /**
   * THE OPPORTUNITY SCORE (reproducible, documented; EDBOARD R6 plus the
   * missing-evidence penalty already inside evidence quality):
   *   score = edge_pp x quote-freshness weight x tier weight x evidence quality
   * edge_pp is the cover (or win) probability minus the break-even at the
   * quoted price, from evaluate(). Only VALUE candidates qualify; THIN and
   * better are kept as "closest" when nothing qualifies. A stale, unknown or
   * reference-only price is never a current opportunity. An outlier gap is
   * held as a data check.
   *   safety  = orders VALUE/THIN by confidence score, then by cushion (points
   *             past the playable line), then by score.
   *   disagreement = orders by raw model-market gap, evidence quality beside it.
   */
  function scoreOf(E, ev) {
    if (!ev.prob || ev.prob.edge_pp == null) return null;
    var st = ev.market_state === 'HYPOTHETICAL' ? 'CURRENT' : ev.market_state;
    return r2(ev.prob.edge_pp * freshWeight(st) * tierWeight(ev.tier) * (E.reliability.score == null ? 0 : E.reliability.score));
  }
  function rank(Es, opts) {
    opts = opts || {};
    var sort = opts.sort || 'value';
    var markets = opts.markets || (opts.filter && opts.filter.underdog ? ['spread', 'moneyline'] : ['spread', 'total']);
    var ex = {}; (opts.exclude || []).forEach(function (k) { ex[k] = 1; });
    var exGames = {}; (opts.exclude_games || []).forEach(function (k) { exGames[k] = 1; });
    var cands = [], stale = [], checks = [], reference = [], started = 0;
    (Es || []).forEach(function (E) {
      if (!E || !E.identity) return;
      if (opts.sports && opts.sports.length && opts.sports.indexOf(E.sport) < 0) return;
      if (exGames[E.sport + '|' + E.identity.game_id]) return;
      currentSelections(E, markets).forEach(function (sel) {
        if (ex[selKey(sel)]) return;
        if (opts.filter && opts.filter.underdog && !isDog(sel)) return;
        if (opts.filter && opts.filter.favorite && !isFav(sel)) return;
        var ev = evaluate(E, sel);
        if (ev.verdict !== 'VALUE' && ev.verdict !== 'THIN' && sort !== 'disagreement') return;
        var row = { key: selKey(sel), E: E, sel: ev.sel, ev: ev, score: scoreOf(E, ev), confidence: confidence(E, ev) };
        if (ev.market_state === 'STARTED') { started++; return; }
        if (ev.market_state === 'STALE' || ev.market_state === 'UNKNOWN') { stale.push(row); return; }
        if (ev.market_state === 'LINE_ONLY') { reference.push(row); return; }
        if (ev.outlier) { checks.push(row); return; }
        cands.push(row);
      });
    });
    function cushion(row) {
      var L = ladder(row.E, row.sel); if (!L || L.kind === 'price' || L.playable_at == null) return 0;
      return L.better_is_higher ? row.sel.line - L.playable_at : L.playable_at - row.sel.line;
    }
    var byScore = function (a, b) { return (b.score == null ? -1e9 : b.score) - (a.score == null ? -1e9 : a.score) || a.key.localeCompare(b.key); };
    if (sort === 'safety') cands.forEach(function (r) { r.cushion = cushion(r); });
    cands.sort(sort === 'safety' ? function (a, b) { return ((b.confidence.score || 0) - (a.confidence.score || 0)) || (b.cushion - a.cushion) || byScore(a, b); }
      : sort === 'disagreement' ? function (a, b) { return (Math.abs(b.ev.value_points || 0) - Math.abs(a.ev.value_points || 0)) || byScore(a, b); }
      : function (a, b) { var va = a.ev.verdict === 'VALUE' ? 1 : 0, vb = b.ev.verdict === 'VALUE' ? 1 : 0; return (vb - va) || byScore(a, b); });
    /* one selection per game */
    var seen = {}, list = [];
    cands.forEach(function (r) { var g = r.E.sport + '|' + r.E.identity.game_id; if (seen[g]) return; seen[g] = 1; list.push(r); });
    var qualified = list.filter(function (r) { return r.ev.verdict === 'VALUE' && (sort !== 'disagreement' || true); });
    reference.sort(byScore); stale.sort(byScore);
    return { sort: sort, qualified: sort === 'disagreement' ? list : qualified, closest: list.filter(function (r) { return r.ev.verdict !== 'VALUE'; }),
      all: list, stale: stale, reference: reference, data_checks: checks, started: started, evaluated: (Es || []).length,
      rule: 'score = edge (probability points at the quoted price) x quote freshness x validation tier x evidence quality; VALUE only; one per game; stale, unknown-age and reference-only prices never qualify; a gap of ' + outlierGap() + '+ points is a data check' };
  }

  /* ================================================================
     6. INTENT
     ================================================================ */
  var RX = {
    board: /\b(best|top|strongest|biggest|safest|most|any(thing)?)\b.*\b(value|values|bets?|plays?|edges?|lines?|spreads?|sides?|dogs?|underdogs?|favou?rites?|totals?|markets?|opportunit\w*|disagree\w*|pick)\b|\bwhere\b.*\b(disagree|differ)\w*\b|\bbest\s+(cfb|nfl|college|football|market)\b|\bwhat\s+(should|do)\s+i\s+bet\b/i,
    game: /\b(anything|something|what)\b.*\b(worth|to)\b.*\b(bet(ting)?|play)\b.*\b(game|matchup|this one)\b|\b(in|on) (this|that) game\b/i,
    why: /^\s*(why|how come|explain|what'?s the (reason|case)|why do(es)? (you|edgedesk|we) like)\b/i,
    risk: /\b(risk|risks|worry|worried|concern|downside|could go wrong|what could (make|go)|scares?|against it|case against)\b/i,
    passline: /\b(what|which|at what)\b.*\b(line|number|price)\b.*\b(pass|stop|off|no longer|not worth|walk away)\b|\bwhen (would|do) (you|i) pass\b|\bhow low\b|\bhow high\b|\bstill (a )?(bet|play|good)\b.*\bat\b/i,
    linechange: /\b(what if|if it|if the line|drops? to|moves? to|goes to|falls? to|gets? to|only get|can only get|at [+-]?\d)/i,
    compare: /\b(compare|comparison|versus|vs\.?|or)\b.*|\bwhich (one|would you|is better|do you prefer)\b|\brather have\b/i,
    choose: /\bwhich (one|would you|is better|do you prefer|do you like more)\b|\brather have\b|\bbetter bet\b/i,
    safer: /\b(safer|safest|less risk|lower risk|more conservative|something else|another one|anything else|alternatives?|other options?)\b/i,
    deep: /\b(deep ?dive|go deeper|deeper|more detail|full (analysis|breakdown)|break it down|show (me )?(the )?(evidence|work|numbers)|everything)\b/i,
    similar: /\b(similar|comparable|like this|historically|history|track record|past games)\b/i,
    method: /\b(how does edgedesk|methodology|how do you (rank|price|calculate)|what does .* mean)\b/i
  };
  var SPORT_RX = [[NFL, /\bnfl\b|\bpro football\b/i], [CFB, /\b(cfb|college football|ncaaf|college|fbs|ncaa football)\b/i]];
  function detectSports(q) { var out = []; SPORT_RX.forEach(function (s) { if (s[1].test(q)) out.push(s[0]); }); return out; }
  function detectMarket(q) {
    if (/\b(ml|moneyline|money line|straight up|to win outright|outright)\b/i.test(q)) return 'moneyline';
    if (/\b(total|totals|over|under|o\/u)\b/i.test(q)) return 'total';
    if (/\b(spread|spreads|ats|points)\b/i.test(q)) return 'spread';
    return null;
  }
  /** Numbers in the text: lines (|x| < 60) and American prices (|x| >= 100). */
  function parseNumbers(q) {
    var out = { lines: [], prices: [], pk: /\b(pk|pick ?'?em|pick)\b/i.test(q) };
    var re = /(^|[\s(@,:])([+-]?\d{1,3}(?:\.5|\.0)?)(?=$|[\s),?.!]|\b)/g, m;
    while ((m = re.exec(q))) {
      var raw = m[2], n = num(raw); if (n == null) continue;
      if (Math.abs(n) >= 100) out.prices.push({ value: n, signed: /^[+-]/.test(raw), at: m.index });
      else if (Math.abs(n) < 60) out.lines.push({ value: n, signed: /^[+-]/.test(raw), at: m.index });
    }
    return out;
  }

  /** Find the teams the question names among the games in hand, left to right, longest name first. */
  function resolveTeams(q, Es) {
    var nq = ' ' + normName(q) + ' ';
    var hits = [];
    (Es || []).forEach(function (E) {
      ['home', 'away'].forEach(function (side) {
        var name = teamOf(E, side); if (!name) return;
        var variants = [normName(name)];
        if (E.sport === NFL) { var parts = normName(name).split(' '); if (parts.length > 1) variants.push(parts[parts.length - 1]); }
        variants.forEach(function (v) {
          if (!v || v.length < 3) return;
          var i = nq.indexOf(' ' + v + ' ');
          if (i >= 0) hits.push({ E: E, side: side, team: name, at: i, len: v.length });
        });
      });
    });
    /* drop a hit inside a longer one ("Carolina" inside "Coastal Carolina") */
    hits = hits.filter(function (h) { return !hits.some(function (o) { return o !== h && o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len; }); });
    hits.sort(function (a, b) { return a.at - b.at || b.len - a.len; });
    var seen = {}, out = [];
    hits.forEach(function (h) { var k = h.E.sport + '|' + h.E.identity.game_id + '|' + h.side; if (seen[k]) return; seen[k] = 1; out.push(h); });
    return out;
  }

  function classify(question, state, Es) {
    var q = str(question).trim();
    var st = sanitizeState(state);
    var hasFocus = !!(st && st.focus);
    var teams = resolveTeams(q, Es || []);
    var nums = parseNumbers(q);
    var market = detectMarket(q);
    var sports = detectSports(q);
    var o = { intent: null, question: q, sports: sports, market: market, teams: teams.map(function (t) { return { team: t.team, side: t.side, sport: t.E.sport, game_id: t.E.identity.game_id }; }),
      numbers: nums, filter: { underdog: /\b(dog|dogs|underdog|underdogs)\b/i.test(q), favorite: /\b(favou?rite|favou?rites|chalk)\b/i.test(q) }, sort: 'value', depth: 'short' };
    if (/\b(safest|safer|safe)\b/i.test(q)) o.sort = 'safety';
    if (/\b(disagree\w*|differ\w*|furthest|biggest (gap|difference))\b/i.test(q)) o.sort = 'disagreement';
    if (RX.deep.test(q)) o.depth = 'deep';
    var pronoun = /\b(it|that|this|them|those|these|that one|this one|the line|the number)\b/i.test(q);
    var shortQ = q.split(/\s+/).length <= 6;

    if (teams.length >= 2 && (RX.compare.test(q) || RX.choose.test(q)) && !(teams.length === 2 && teams[0].E === teams[1].E && !market && !/\bcompare|rather|which\b/i.test(q))) o.intent = 'COMPARE';
    else if (teams.length >= 1 && hasFocus && /\bcompare|versus|\bvs\b|rather|which\b/i.test(q)) o.intent = 'COMPARE';
    else if (teams.length >= 1 && RX.game.test(q)) o.intent = 'GAME';
    else if (teams.length >= 1) o.intent = RX.deep.test(q) ? 'DEEP' : RX.risk.test(q) ? 'RISK' : 'MARKET';
    else if (hasFocus && RX.choose.test(q) && st.compare && st.compare.length >= 2) o.intent = 'CHOOSE';
    else if (hasFocus && RX.linechange.test(q) && (nums.lines.length || nums.prices.length || nums.pk)) o.intent = 'LINE_CHANGE';
    else if (hasFocus && RX.passline.test(q)) o.intent = 'PASS_LINE';
    else if (hasFocus && RX.game.test(q)) o.intent = 'GAME';
    else if (hasFocus && RX.deep.test(q)) o.intent = 'DEEP';
    else if (hasFocus && RX.risk.test(q)) o.intent = 'RISK';
    else if (hasFocus && RX.safer.test(q)) o.intent = 'SAFER';
    else if (hasFocus && RX.similar.test(q) && shortQ) o.intent = 'SIMILAR';
    else if (hasFocus && (RX.why.test(q) || (pronoun && /\bwhy|like\b/i.test(q)))) o.intent = 'EXPLAIN';
    else if (RX.board.test(q) || (sports.length && /\b(value|bet|play|dog|underdog|edge)\b/i.test(q))) o.intent = 'BOARD';
    else if (hasFocus && pronoun && shortQ) o.intent = 'EXPLAIN';
    return o;
  }

  /* ================================================================
     7. CONVERSATION STATE (edgedesk_desk_state_v1)
     Identifiers and numbers only. The host re-evaluates every item against
     fresh evidence; nothing is believed on the browser's say-so.
     ================================================================ */
  function cleanSel(s) {
    if (!s || typeof s !== 'object') return null;
    var m = ['spread', 'total', 'moneyline'].indexOf(s.market) >= 0 ? s.market : null;
    var side = ['home', 'away', 'over', 'under'].indexOf(s.side) >= 0 ? s.side : null;
    if (!m || !side || !s.game_id) return null;
    return { sport: SPORTS[s.sport] ? s.sport : null, game_id: str(s.game_id).slice(0, 60), market: m, side: side, team: s.team ? str(s.team).slice(0, 60) : null,
      line: num(s.line), odds: num(s.odds), book: s.book ? str(s.book).slice(0, 40) : null };
  }
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== STATE_SCHEMA) return null;
    return { schema: STATE_SCHEMA, focus: cleanSel(raw.focus), compare: Array.isArray(raw.compare) ? raw.compare.map(cleanSel).filter(Boolean).slice(0, 2) : [],
      board: Array.isArray(raw.board) ? raw.board.map(cleanSel).filter(Boolean).slice(0, 5) : [],
      sports: Array.isArray(raw.sports) ? raw.sports.filter(function (s) { return SPORTS[s]; }).slice(0, 2) : [],
      sort: ['value', 'safety', 'disagreement'].indexOf(raw.sort) >= 0 ? raw.sort : 'value',
      last_intent: str(raw.last_intent).slice(0, 20) || null, turns: Math.min(50, num(raw.turns) || 0) };
  }
  function nextState(prev, turn) {
    var p = sanitizeState(prev) || { schema: STATE_SCHEMA, focus: null, compare: [], board: [], sports: [], sort: 'value', last_intent: null, turns: 0 };
    var s = { schema: STATE_SCHEMA, focus: turn.focus ? cleanSel(turn.focus) : p.focus, compare: turn.compare ? turn.compare.map(cleanSel).filter(Boolean) : p.compare,
      board: turn.board ? turn.board.map(cleanSel).filter(Boolean).slice(0, 5) : p.board, sports: turn.sports || p.sports, sort: turn.sort || p.sort,
      last_intent: turn.intent || null, turns: (p.turns || 0) + 1 };
    return s;
  }

  /* ================================================================
     8. SIMILAR SITUATIONS — the gate and the pregame-only feature vector
     ================================================================ */
  /* The ONLY fields a similarity vector may read. Every one exists before kickoff. */
  var PREGAME_FEATURES = ['sport', 'market', 'side_is_home', 'side_is_underdog', 'selection_line', 'fair_line', 'value_points', 'normalized_gap', 'tier', 'confidence_score', 'evidence_quality', 'market_state'];
  var POSTGAME_KEYS = ['result', 'home_score', 'away_score', 'final_margin', 'close_line', 'close_price', 'clv', 'clv_points', 'settled', 'settled_at', 'outcome', 'won', 'graded', 'ats_result'];
  /** A history record from a frozen pregame evaluation. Refuses one captured at or after kickoff. */
  function historyRecord(E, ev, o) {
    o = o || {};
    var cap = toMs(o.captured_at != null ? o.captured_at : E.built_at), k = toMs(E.identity.kickoff);
    if (cap == null || k == null || cap >= k) return { ok: false, why: 'a history record must be captured before kickoff' };
    var sel = ev.sel, c = confidence(E, ev);
    var features = {
      sport: E.sport, market: sel.market, side_is_home: sel.side === 'home', side_is_underdog: isDog(sel),
      selection_line: num(sel.line), fair_line: ev.fair ? num(ev.fair.line) : null, value_points: num(ev.value_points),
      normalized_gap: E.gap.normalized, tier: ev.tier, confidence_score: c.score, evidence_quality: E.reliability.score, market_state: ev.market_state
    };
    var rec = {
      schema: HISTORY_SCHEMA, sport: E.sport, game_id: E.identity.game_id, home_team: E.identity.home, away_team: E.identity.away, kickoff: iso(k), captured_at: iso(cap),
      market: sel.market, side: sel.side, selection: ev.label, line: num(sel.line), odds: num(sel.odds), book: sel.book || null,
      fair_line: features.fair_line, fair_price: ev.fair && ev.fair.price != null ? ev.fair.price : null,
      market_home_line: E.market.spread.home_line != null ? E.market.spread.home_line : null, projection_home_line: E.projection.home_line,
      value_points: features.value_points, cover_prob: ev.prob ? (ev.prob.cover != null ? ev.prob.cover : ev.prob.win) : null, edge_pp: ev.prob ? ev.prob.edge_pp : null,
      verdict: ev.verdict, tier: ev.tier, confidence_grade: c.grade, confidence_score: c.score, evidence_quality: E.reliability.score,
      model_version: E.projection.version, features: features,
      typed_evidence: E.typed.map(function (t) { return { type: t.type, key: t.key }; })
    };
    rec.record_id = 'dh_' + fnv(JSON.stringify([rec.sport, rec.game_id, rec.market, rec.side, rec.line, rec.odds, rec.captured_at, rec.model_version]));
    return { ok: true, record: rec };
  }
  function fnv(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  /** The similarity vector: pregame fields only, whatever the row carries. */
  function similarityVector(rec) {
    var f = (rec && rec.features) || {};
    var v = {}; PREGAME_FEATURES.forEach(function (k) { v[k] = f[k] === undefined ? null : f[k]; });
    return v;
  }
  function leaks(obj) { var bad = []; Object.keys(obj || {}).forEach(function (k) { if (POSTGAME_KEYS.indexOf(k) >= 0) bad.push(k); }); return bad; }
  /**
   * Similar Situations. `rows` are settled history rows (record + result).
   * Withheld unless there are SIMILAR_MIN_TOTAL_SETTLED settled rows for the
   * sport and market and SIMILAR_MIN_SETTLED of them are comparable. A row
   * captured at or after its kickoff is excluded, never used.
   */
  function similarSituations(target, rows) {
    rows = Array.isArray(rows) ? rows : [];
    var t = target && target.features ? target.features : {};
    var valid = rows.filter(function (r) { return r && r.settled === true && toMs(r.captured_at) != null && toMs(r.kickoff) != null && toMs(r.captured_at) < toMs(r.kickoff) && r.sport === t.sport && r.market === t.market; });
    if (valid.length < SIMILAR_MIN_TOTAL_SETTLED) return { available: false, n_settled: valid.length, required: SIMILAR_MIN_TOTAL_SETTLED,
      text: 'Similar situations: building history. Not enough comparable settled EdgeDesk predictions yet (' + valid.length + ' settled, ' + SIMILAR_MIN_TOTAL_SETTLED + ' needed before any comparison is shown).' };
    var tv = similarityVector(target);
    var comp = valid.filter(function (r) {
      var v = similarityVector(r);
      return v.tier === tv.tier && v.side_is_underdog === tv.side_is_underdog && v.value_points != null && tv.value_points != null && Math.abs(v.value_points - tv.value_points) <= 1.5;
    });
    if (comp.length < SIMILAR_MIN_SETTLED) return { available: false, n_settled: valid.length, n_comparable: comp.length, required: SIMILAR_MIN_SETTLED,
      text: 'Similar situations: building history. ' + comp.length + ' comparable settled predictions so far; ' + SIMILAR_MIN_SETTLED + ' are needed before they may inform an answer.' };
    var w = comp.filter(function (r) { return r.outcome === 'WIN'; }).length, l = comp.filter(function (r) { return r.outcome === 'LOSS'; }).length;
    var clv = comp.map(function (r) { return num(r.clv_points); }).filter(function (x) { return x != null; });
    return { available: true, n_comparable: comp.length, wins: w, losses: l, pushes: comp.length - w - l,
      mean_clv: clv.length ? r2(clv.reduce(function (a, b) { return a + b; }, 0) / clv.length) : null,
      rule: 'same sport, market, tier and underdog status; value within 1.5 points; captured before kickoff; settled',
      text: 'Similar situations: ' + comp.length + ' comparable settled predictions went ' + w + '-' + l + (clv.length ? ', average CLV ' + r1(clv.reduce(function (a, b) { return a + b; }, 0) / clv.length) + ' pts' : '') + '.' };
  }

  /* ================================================================
     9. THE ANSWER
     ================================================================ */
  var VERDICT_OPEN = {
    VALUE: function (lab) { return 'Yes — ' + lab + ' has value at this price.'; },
    THIN: function (lab) { return 'Only slightly. ' + lab + ' is a hair better than EdgeDesk’s number, not enough to clear its threshold.'; },
    NO_VALUE: function (lab) { return 'No. ' + lab + ' is roughly where EdgeDesk has it: the market is efficiently priced here.'; },
    OVERPRICED: function (lab) { return 'No. At ' + lab + ' you’re paying more than EdgeDesk’s number.'; }
  };
  function priceSentence(E, ev) {
    var sel = ev.sel;
    if (sel.market === 'moneyline') {
      if (!ev.prob) return null;
      return 'EdgeDesk has ' + sel.team + ' winning ' + pct(ev.prob.win) + ' of the time (fair price ' + fmtAm(ev.fair.price) + '); ' + fmtAm(sel.odds) + ' needs ' + pct(ev.prob.break_even) + '.';
    }
    var f = ev.fair ? ev.fair.projection_line : null;
    if (f == null) return null;
    var v = ev.value_points;
    if (sel.market === 'total') return 'EdgeDesk projects ' + r1(E.projection.total) + ' points, so ' + ev.label + ' is ' + (v >= 0 ? pts(v) + ' of value' : pts(v) + ' the wrong side of our number') + '.';
    var favSide = E.projection.home_line < 0 ? 'home' : E.projection.home_line > 0 ? 'away' : null;
    var gameLine = favSide ? teamOf(E, favSide) + ' ' + fmtLine(-Math.abs(E.projection.home_line)) : 'a pick’em';
    var s = 'EdgeDesk makes it ' + gameLine + ', so ' + ev.label + ' is ' + (v > 0 ? pts(v) + ' better than our number' : v < 0 ? pts(v) + ' worse than our number' : 'exactly our number') + '.';
    if (ev.fair.basis && /blend/.test(ev.fair.basis) && ev.fair.line != null) s += ' The validated blend prices ' + sel.team + ' at ' + fmtLine(ev.fair.line) + '.';
    return s;
  }
  function confidenceSentence(E, ev) {
    var c = confidence(E, ev);
    var q = E.reliability;
    var why = [];
    if (ev.tier === 'RESEARCH') why.push('the ' + E.sport_short + ' ' + (ev.sel.market === 'moneyline' ? 'moneyline' : ev.sel.market) + ' model is research tier');
    else if (ev.tier === 'LEAN') why.push('LEAN tier: the graded record cleared break-even, not a profit');
    if (q.grade === 'STRONG') why.push('evidence quality is strong');
    else if (q.grade === 'MODERATE') why.push('evidence quality is moderate');
    else if (q.grade === 'WEAK') why.push('the evidence is thin');
    else if (q.grade === 'INSUFFICIENT') why.push('the evidence is insufficient');
    var mi = E.missing.filter(function (m) { return m.important; });
    if (mi.length) why.push(mi.length + ' important input' + (mi.length === 1 ? ' is' : 's are') + ' missing');
    if (ev.outlier) why.push('the gap is big enough to suspect a data problem');
    var g = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INSUFFICIENT: 'Insufficient' }[c.grade];
    return 'Confidence: ' + g + (why.length ? ' — ' + why.join('; ') + '.' : '.');
  }
  function marketNote(E, ev) {
    var sel = ev.sel;
    var mk = sel.market === 'spread' ? E.market.spread : sel.market === 'total' ? E.market.total : E.market.moneyline;
    if (ev.market_state === 'HYPOTHETICAL') return null;
    if (!mk || mk.state === 'NONE') return 'No market is on file for this, so there is no price to judge.';
    if (mk.state === 'STALE' || mk.state === 'UNKNOWN') return 'Careful: the last price on file is ' + (mk.state === 'STALE' ? 'stale' : 'of unknown age') + (mk.age_hours != null ? ' (' + mk.age_hours + 'h old)' : '') + ', so this is not a current price. Re-check the line before acting.';
    if (mk.state === 'LINE_ONLY') return 'That number is a reference line with no book or capture time, not a price you can take. Confirm it at your book.';
    if (mk.state === 'STARTED') return 'This game has started; EdgeDesk only prices pregame.';
    return null;
  }
  function where(sel) { return (sel.odds != null ? ' (' + fmtAm(sel.odds) + (sel.book ? ', ' + sel.book : '') + ')' : sel.book ? ' (' + sel.book + ')' : ''); }

  /** One selection, answered: verdict, price, why, confidence, risk, price boundary. */
  function answerSelection(E, ev, o) {
    o = o || {};
    var L = [], sel = ev.sel;
    if (ev.verdict === 'NO_PROJECTION') return E.identity.away + ' at ' + E.identity.home + ': EdgeDesk has no projection on file for this game, so it can’t judge any price here.';
    if (ev.verdict === 'NO_PRICE') return 'There is no ' + sel.market + ' on file for ' + (sel.team || 'this game') + ', so there is nothing to price. Tell me the number you can get and I’ll evaluate it.';
    var lead = o.lead || VERDICT_OPEN[ev.verdict](ev.label + where(sel));
    L.push(lead);
    var ps = priceSentence(E, ev); if (ps) L.push(ps);
    if (ev.verdict === 'OVERPRICED' && sel.market !== 'total' && sel.market !== 'moneyline') {
      var wp = E.projection.home_win_prob;
      var myWp = wp == null ? null : sel.side === 'home' ? wp : 1 - wp;
      if (myWp != null && myWp > 0.5) L.push('EdgeDesk does expect ' + sel.team + ' to win (' + pct(myWp) + '), but winning isn’t covering ' + fmtLine(sel.line) + '.');
      var oth = evaluate(E, Object.assign({}, sel, { side: other(sel.side), team: teamOf(E, other(sel.side)), line: -sel.line, odds: null, hypothetical: true }));
      if (oth.verdict === 'VALUE' || oth.verdict === 'THIN') L.push('If anything, the value is on ' + oth.label + '.');
    }
    var R = reasonsFor(E, sel);
    if ((ev.verdict === 'VALUE' || ev.verdict === 'THIN') && R.for.length) L.push('Why: ' + R.for.slice(0, 2).map(function (x) { return x.text; }).join('; ') + '.');
    var mn = marketNote(E, ev); if (mn) L.push(mn);
    L.push(confidenceSentence(E, ev));
    if (ev.verdict === 'VALUE' || ev.verdict === 'THIN') {
      var risks = risksFor(E, sel, ev);
      if (risks.length) L.push('Main risk: ' + risks[0].text + '.');
      var lt = ladderText(E, sel, ladder(E, sel)); if (lt) L.push('Price: ' + lt);
    }
    return L.join(' ');
  }

  function fmtRow(r) { return r.ev.label + where(r.sel) + (r.ev.value_points != null ? ', ' + pts(r.ev.value_points) + ' vs our number' : r.ev.prob ? ', ' + r1(r.ev.prob.edge_pp) + ' pts of win probability' : ''); }

  function answerBoard(Es, cls, st) {
    var sports = cls.sports && cls.sports.length ? cls.sports : (st && st.sports && st.sports.length && /\b(it|that|another|else|more)\b/i.test(cls.question) ? st.sports : null);
    var markets = cls.market ? [cls.market] : null;
    var R = rank(Es, { sports: sports, sort: cls.sort, filter: cls.filter, markets: markets, exclude: cls.exclude || [] });
    var scope = (sports && sports.length === 1 ? SPORTS[sports[0]].short + ' ' : '') + (cls.filter.underdog ? 'underdog ' : '') + (cls.market === 'total' ? 'total ' : cls.market === 'moneyline' ? 'moneyline ' : '');
    var L = [], focus = null;
    var nCur = (Es || []).filter(function (E) { return (!sports || sports.indexOf(E.sport) >= 0) && ((E.market.spread && E.market.spread.actionable) || (E.market.total && E.market.total.actionable)); }).length;
    var nGames = (Es || []).filter(function (E) { return !sports || sports.indexOf(E.sport) >= 0; }).length;
    if (cls.sort === 'disagreement') {
      var d = R.qualified.slice(0, 3);
      if (!d.length) L.push('No current ' + scope + 'market shows a positive disagreement with EdgeDesk right now (' + nCur + ' of ' + nGames + ' games have a current price).');
      else {
        focus = d[0];
        L.push('Biggest disagreement right now: ' + d[0].ev.label + where(d[0].sel) + '. ' + priceSentence(d[0].E, d[0].ev));
        L.push(confidenceSentence(d[0].E, d[0].ev));
        if (d.length > 1) L.push('Next: ' + d.slice(1).map(fmtRow).join('; ') + '.');
      }
      if (R.data_checks.length) L.push('Held back as possible data errors (gap ' + outlierGap() + '+ pts): ' + R.data_checks.slice(0, 2).map(fmtRow).join('; ') + '.');
    } else if (R.qualified.length) {
      var top = R.qualified[0]; focus = top;
      var head = (cls.sort === 'safety' ? 'Safest ' + scope + 'value right now' : 'Best ' + scope + 'value right now') + ': ' + top.ev.label + where(top.sel) + '.';
      L.push(answerSelection(top.E, top.ev, { lead: head }));
      var more = R.qualified.slice(1, 4);
      if (more.length) L.push('Other values: ' + more.map(fmtRow).join('; ') + '.');
    } else {
      L.push('Nothing stands out enough at current ' + scope + 'prices. EdgeDesk checked ' + nGames + ' game' + (nGames === 1 ? '' : 's') + (nCur < nGames ? ' (' + nCur + ' with a current price)' : '') + ' and none clears its threshold.');
      if (R.closest.length) {
        var c = R.closest[0]; focus = c;
        var lt = ladderText(c.E, c.sel, ladder(c.E, c.sel));
        L.push('Closest: ' + fmtRow(c) + '.' + (lt ? ' ' + lt : ''));
      }
      if (!nCur && R.reference.length) L.push('On reference lines (not live prices): ' + R.reference.slice(0, 2).map(fmtRow).join('; ') + '. Confirm them at your book.');
      if (R.stale.length) L.push(R.stale.length + ' more looked interesting on stale prices, which EdgeDesk won’t present as current.');
    }
    return { text: L.join('\n\n'), focus: focus, ranking: R };
  }

  function findEvidence(Es, sel) { return (Es || []).filter(function (E) { return E.identity.game_id === String(sel.game_id) && (!sel.sport || E.sport === sel.sport); })[0] || null; }
  /** Build the selection a question names: team + market + line/price, defaulting to the current market. */
  function selectionFromMention(E, side, cls, idx) {
    var market = cls.market || 'spread';
    if (market === 'total') side = /\bunder\b/i.test(cls.question) ? 'under' : 'over';
    var sel = { sport: E.sport, game_id: E.identity.game_id, market: market, side: side, team: market === 'total' ? null : teamOf(E, side) };
    var cur = currentSelections(E, [market]).filter(function (s) { return s.side === side; })[0] || null;
    var lines = cls.numbers.lines, prices = cls.numbers.prices;
    var line = lines.length ? lines[Math.min(idx || 0, lines.length - 1)].value : (cls.numbers.pk ? 0 : null);
    if (market === 'moneyline') { sel.odds = prices.length ? prices[Math.min(idx || 0, prices.length - 1)].value : cur ? cur.odds : null; sel.book = cur && sel.odds === cur.odds ? cur.book : null; sel.user_price = !!prices.length; return sel; }
    if (line != null) {
      if (market === 'total') line = Math.abs(line);
      sel.line = line; sel.odds = prices.length ? prices[0].value : (cur && cur.line === line ? cur.odds : null); sel.book = cur && cur.line === line ? cur.book : null;
      sel.user_price = !cur || cur.line !== line;
    } else if (cur) { sel.line = cur.line; sel.odds = cur.odds; sel.book = cur.book; }
    return sel;
  }
  function withHypothetical(E, sel) {
    /* a number the reader named is priced as a number, not as a current market */
    if (!sel.user_price) return evaluate(E, sel);
    var ev = evaluate(E, Object.assign({}, sel, { hypothetical: true }));
    ev.user_number = true;
    return ev;
  }

  function deepDive(E, ev, historyRows) {
    var L = [], sel = ev.sel;
    L.push(answerSelection(E, ev));
    L.push('');
    L.push('THE NUMBERS');
    L.push('- Projection: ' + E.identity.home + ' ' + fmtLine(E.projection.home_line) + (E.projection.total != null ? ', total ' + r1(E.projection.total) : '') + (E.projection.home_win_prob != null ? ', ' + E.identity.home + ' win ' + pct(E.projection.home_win_prob) : '') + ' (' + (E.projection.version || 'unversioned') + ').');
    if (E.market.spread.home_line != null) L.push('- Market: ' + E.identity.home + ' ' + fmtLine(E.market.spread.home_line) + (E.market.spread.book ? ' at ' + E.market.spread.book : '') + ', ' + E.market.spread.state.toLowerCase() + (E.market.spread.age_hours != null ? ' (' + E.market.spread.age_hours + 'h old)' : '') + '.');
    if (E.market.open) L.push('- Opened ' + E.identity.home + ' ' + fmtLine(E.market.open.home_line) + '.');
    if (E.gap.points != null) L.push('- Gap: ' + pts(E.gap.points) + (E.gap.normalized != null ? ' (' + E.gap.normalized + ' of the model’s expected error)' : '') + '.');
    if (ev.prob) L.push('- ' + (sel.market === 'moneyline' ? 'Win' : 'Cover') + ' probability ' + pct(ev.prob.cover != null ? ev.prob.cover : ev.prob.win) + ' against ' + pct(ev.prob.break_even) + ' needed (' + ev.prob.basis + ').');
    var tb = E.fair[sel.market === 'moneyline' ? 'moneyline' : sel.market];
    L.push('- Validation: ' + (ev.tier || 'RESEARCH') + (tb && tb.tier_basis ? ' — ' + tb.tier_basis : '') + '.');
    var R = reasonsFor(E, sel);
    if (R.for.length || R.against.length || R.neutral.length) {
      L.push(''); L.push('WHAT DRIVES IT');
      R.for.forEach(function (x) { L.push('- For: ' + x.text + '.'); });
      R.against.forEach(function (x) { L.push('- Against: ' + x.text + '.'); });
      R.neutral.forEach(function (x) { L.push('- ' + cap(x.text) + '.'); });
    }
    L.push(''); L.push('EVIDENCE QUALITY');
    L.push('- ' + cap(E.reliability.grade.toLowerCase()) + (E.reliability.information_confidence != null ? ' (information confidence ' + pct(E.reliability.information_confidence) + ')' : E.reliability.completeness != null ? ' (data completeness ' + pct(E.reliability.completeness) + ')' : '') + '.');
    if (E.research) E.research.quality.categories.filter(function (q) { return q.status !== 'AVAILABLE'; }).forEach(function (q) { L.push('- ' + cap(q.category.replace(/_/g, ' ')) + ': ' + q.status.toLowerCase() + (q.note ? ' — ' + q.note : '') + '.'); });
    var risks = risksFor(E, sel, ev);
    if (risks.length) { L.push(''); L.push('RISKS'); risks.slice(0, 5).forEach(function (r) { L.push('- ' + cap(r.text) + '.'); }); }
    L.push(''); L.push(similarSituations(historyTarget(E, ev), historyRows).text);
    return L.join('\n');
  }

  /**
   * Answer one turn. o.question, o.evidence ([evidence()]), o.state (carried),
   * o.history_rows (settled history, optional). Returns the text, the focus,
   * the new state and what was used.
   */
  function answer(o) {
    o = o || {};
    var Es = (o.evidence || []).filter(Boolean);
    var st = sanitizeState(o.state);
    var cls = o.classification || classify(o.question, st, Es);
    var out = { schema: ANSWER_SCHEMA, version: VERSION, intent: cls.intent, text: '', focus: null, compare: null, board: null, evaluations: [], ranking_rule: null, similar: null };
    function focusEv() {
      if (!st || !st.focus) return null;
      var E = findEvidence(Es, st.focus); if (!E) return null;
      return { E: E, ev: evaluate(E, st.focus.line != null || st.focus.market === 'moneyline' ? st.focus : Object.assign({}, st.focus)) };
    }
    var intent = cls.intent;
    if (!intent) { out.text = null; return out; }

    if (intent === 'BOARD' || intent === 'SAFER') {
      if (intent === 'SAFER') { cls.sort = 'safety'; cls.exclude = st && st.focus ? [selKey(st.focus)] : []; if (!cls.sports.length && st && st.sports.length) cls.sports = st.sports; }
      var b = answerBoard(Es, cls, st);
      out.text = b.text; out.ranking_rule = b.ranking.rule;
      out.board = b.ranking.qualified.slice(0, 5).map(function (r) { return r.sel; });
      out.evaluations = b.ranking.all.slice(0, 5).map(function (r) { return summarizeEval(r.E, r.ev); });
      out.counts = { evaluated: b.ranking.evaluated, qualified: b.ranking.qualified.length, stale: b.ranking.stale.length, reference: b.ranking.reference.length, data_checks: b.ranking.data_checks.length };
      if (b.focus) out.focus = b.focus.sel;
      if (intent === 'SAFER' && st && st.focus && b.focus) out.compare = [st.focus, b.focus.sel];
      out.sports = cls.sports.length ? cls.sports : null; out.sort = cls.sort;
      return finish(out, st, cls);
    }

    if ((intent === 'MARKET' || intent === 'RISK' || intent === 'DEEP') && cls.teams.length) {
      var t = cls.teams[0];
      var E0 = findEvidence(Es, { game_id: t.game_id, sport: t.sport });
      var sel0 = selectionFromMention(E0, t.side, cls, 0);
      var ev0 = withHypothetical(E0, sel0);
      out.focus = ev0.sel; out.evaluations = [summarizeEval(E0, ev0)];
      if (intent === 'RISK') out.text = riskText(E0, ev0);
      else if (intent === 'DEEP') out.text = deepDive(E0, ev0, o.history_rows);
      else out.text = answerSelection(E0, ev0) + (ev0.user_number && E0.market.spread.home_line != null && sel0.market === 'spread' ? ' (Current market: ' + teamOf(E0, sel0.side) + ' ' + fmtLine(sel0.side === 'home' ? E0.market.spread.home_line : -E0.market.spread.home_line) + ', ' + E0.market.spread.state.toLowerCase() + '.)' : '');
      return finish(out, st, cls);
    }

    if (intent === 'GAME') {
      var E1 = cls.teams.length ? findEvidence(Es, { game_id: cls.teams[0].game_id, sport: cls.teams[0].sport }) : (st && st.focus ? findEvidence(Es, st.focus) : null);
      if (!E1) { out.text = 'Which game? Name a team and I’ll check every price on it.'; return finish(out, st, cls); }
      var evs = currentSelections(E1, ['spread', 'total', 'moneyline']).map(function (s) { return evaluate(E1, s); });
      var good = evs.filter(function (e) { return (e.verdict === 'VALUE' || e.verdict === 'THIN') && e.current; })
        .sort(function (a, b) { return (b.verdict === 'VALUE') - (a.verdict === 'VALUE') || (scoreOf(E1, b) || 0) - (scoreOf(E1, a) || 0); });
      out.evaluations = evs.map(function (e) { return summarizeEval(E1, e); });
      if (!evs.length) out.text = 'There is no market on file for ' + E1.identity.away + ' at ' + E1.identity.home + ', so there is nothing to price yet.';
      else if (!good.length) {
        var stale = evs.some(function (e) { return !e.current; });
        out.text = 'No. EdgeDesk checked ' + evs.length + ' prices on ' + E1.identity.away + ' at ' + E1.identity.home + ' and ' + (stale ? 'none is both current and better than its number.' : 'every one is within its number: this game looks efficiently priced.');
        var closest = evs.filter(function (e) { return e.value_points != null && e.value_points > 0; }).sort(function (a, b) { return b.value_points - a.value_points; })[0];
        if (closest) { out.focus = closest.sel; var lt = ladderText(E1, closest.sel, ladder(E1, closest.sel)); out.text += ' Closest: ' + closest.label + (lt ? '. ' + lt : '.'); }
        out.text += ' ' + confidenceSentence(E1, evs[0]);
      } else {
        out.focus = good[0].sel;
        out.text = answerSelection(E1, good[0], { lead: (good[0].verdict === 'VALUE' ? 'Yes: ' : 'Only a small one: ') + good[0].label + where(good[0].sel) + ' is the price to look at in this game.' });
      }
      return finish(out, st, cls);
    }

    if (intent === 'COMPARE' || intent === 'CHOOSE') {
      var pair = [];
      if (intent === 'CHOOSE' && st) pair = st.compare.slice(0, 2);
      else {
        if (cls.teams.length >= 2) pair = cls.teams.slice(0, 2).map(function (t2, i) { var E2 = findEvidence(Es, { game_id: t2.game_id, sport: t2.sport }); return E2 ? selectionFromMention(E2, t2.side, cls, i) : null; }).filter(Boolean);
        else if (cls.teams.length === 1 && st && st.focus) {
          var t3 = cls.teams[0], E3 = findEvidence(Es, { game_id: t3.game_id, sport: t3.sport });
          pair = [st.focus, selectionFromMention(E3, t3.side, cls, 0)];
        }
      }
      if (pair.length < 2) { out.text = 'Compare which two? Name both, e.g. “UCLA +3.5 vs Maryland ML”.'; return finish(out, st, cls); }
      out.text = compareText(Es, pair, out);
      out.compare = pair;
      return finish(out, st, cls);
    }

    var fe = focusEv();
    if (!fe) {
      out.text = 'I’m not sure which bet you mean. Name the team (and the number if you have one), or ask for the best value on the board.';
      return finish(out, st, cls);
    }
    out.focus = fe.ev.sel; out.evaluations = [summarizeEval(fe.E, fe.ev)];
    if (intent === 'EXPLAIN') out.text = explainText(fe.E, fe.ev);
    else if (intent === 'RISK') out.text = riskText(fe.E, fe.ev);
    else if (intent === 'PASS_LINE') out.text = passText(fe.E, fe.ev);
    else if (intent === 'DEEP') out.text = deepDive(fe.E, fe.ev, o.history_rows);
    else if (intent === 'SIMILAR') { out.similar = similarSituations(historyTarget(fe.E, fe.ev), o.history_rows); out.text = out.similar.text; }
    else if (intent === 'LINE_CHANGE') {
      var s2 = Object.assign({}, fe.ev.sel);
      var nl = cls.numbers.lines.length ? cls.numbers.lines[0] : null;
      if (s2.market === 'moneyline') { if (cls.numbers.prices.length) s2.odds = cls.numbers.prices[0].value; }
      else {
        if (nl) s2.line = s2.market === 'total' ? Math.abs(nl.value) : nl.signed ? nl.value : (Math.sign(s2.line || 1) || 1) * Math.abs(nl.value);
        else if (cls.numbers.pk) s2.line = 0;
        if (cls.numbers.prices.length) s2.odds = cls.numbers.prices[0].value;
      }
      s2.hypothetical = true; s2.book = null;
      var ev2 = evaluate(fe.E, s2);
      var before = fe.ev.verdict, after = ev2.verdict;
      var lead = before === after ? 'At ' + ev2.label + ' the answer doesn’t change: ' : 'At ' + ev2.label + ' the answer changes: ';
      var what = { VALUE: 'it still clears EdgeDesk’s threshold', THIN: 'it’s only thin value, below EdgeDesk’s threshold', NO_VALUE: 'the value is gone', OVERPRICED: 'it’s now worse than EdgeDesk’s number' }[after] || 'it can’t be priced';
      if (before === after) what = { VALUE: 'still attractive', THIN: 'still only thin value', NO_VALUE: 'still no value', OVERPRICED: 'still worse than our number' }[after] || what;
      var L2 = [lead + what + (ev2.value_points != null ? ' (' + (ev2.value_points >= 0 ? pts(ev2.value_points) + ' of value' : pts(ev2.value_points) + ' short') + ', was ' + (fe.ev.value_points != null ? pts(fe.ev.value_points) : '—') + ').' : ev2.prob ? ' (' + r1(ev2.prob.edge_pp) + ' pts of edge, was ' + (fe.ev.prob ? r1(fe.ev.prob.edge_pp) : '—') + ').' : '.')];
      var lt2 = ladderText(fe.E, s2, ladder(fe.E, s2)); if (lt2) L2.push(lt2);
      L2.push(confidenceSentence(fe.E, ev2));
      out.text = L2.join(' ');
      out.focus = Object.assign({}, s2); delete out.focus.hypothetical;
      out.evaluations = [summarizeEval(fe.E, fe.ev), summarizeEval(fe.E, ev2)];
      out.compare = [fe.ev.sel, out.focus];
    }
    return finish(out, st, cls);
  }
  function historyTarget(E, ev) { var h = historyRecord(E, ev, { captured_at: E.built_at }); return h.ok ? h.record : { features: { sport: E.sport, market: ev.sel.market, tier: ev.tier, value_points: ev.value_points, side_is_underdog: isDog(ev.sel) } }; }
  function finish(out, st, cls) {
    out.state = nextState(st, { focus: out.focus, compare: out.compare, board: out.board, intent: out.intent, sports: out.sports || null, sort: out.sort || null });
    out.allowed = allowedNumbers(out);
    return out;
  }
  function explainText(E, ev) {
    var R = reasonsFor(E, ev.sel), L = [];
    var v = ev.value_points;
    if (ev.verdict === 'VALUE' || ev.verdict === 'THIN') {
      L.push('The case for ' + ev.label + ' is the price first: ' + (priceSentence(E, ev) || '').replace(/^EdgeDesk/, 'EdgeDesk'));
      if (R.for.length) L.push('Behind that number: ' + R.for.slice(0, 3).map(function (x) { return x.text; }).join('; ') + '.');
      else L.push('The projection doesn’t publish a single dominant driver for this game, so the case rests on the number itself.');
      if (R.against.length) L.push('Against it: ' + R.against[0].text + '.');
    } else {
      L.push('EdgeDesk doesn’t like ' + ev.label + ' at this price. ' + (priceSentence(E, ev) || ''));
      if (R.against.length) L.push('The other side’s case: ' + R.against.slice(0, 2).map(function (x) { return x.text; }).join('; ') + '.');
    }
    L.push(confidenceSentence(E, ev));
    return L.join(' ');
  }
  function riskText(E, ev) {
    var r = risksFor(E, ev.sel, ev);
    if (!r.length) return 'Nothing in EdgeDesk’s evidence argues against ' + ev.label + ' specifically, which is not the same as it being safe. ' + confidenceSentence(E, ev);
    return 'Biggest risk on ' + ev.label + ': ' + r[0].text + '.' + (r.length > 1 ? ' Also: ' + r.slice(1, 3).map(function (x) { return x.text; }).join('; ') + '.' : '') + ' ' + confidenceSentence(E, ev);
  }
  function passText(E, ev) {
    var L = ladder(E, ev.sel), t = ladderText(E, ev.sel, L);
    if (!t) return 'EdgeDesk can’t draw a price boundary for ' + ev.label + ': it has no projection to price against.';
    return t + ' Right now it’s ' + ev.label + where(ev.sel) + ', ' + ({ VALUE: 'which clears the threshold', THIN: 'which is thin value', NO_VALUE: 'which has no value', OVERPRICED: 'which is worse than our number' }[ev.verdict] || 'not priced') + '.';
  }
  function compareText(Es, pair, out) {
    var rows = pair.map(function (s) { var E = findEvidence(Es, s); if (!E) return null; var ev = withHypothetical(E, s); return { E: E, ev: ev, c: confidence(E, ev), score: scoreOf(E, ev) }; });
    if (rows.some(function (r) { return !r; })) return 'One of those games is no longer on EdgeDesk’s card, so I can’t compare them.';
    out.evaluations = rows.map(function (r) { return summarizeEval(r.E, r.ev); });
    var L = rows.map(function (r) {
      var e = r.ev;
      var val = e.value_points != null ? pts(e.value_points) + (e.value_points >= 0 ? ' better' : ' worse') + ' than our number' : e.prob ? (e.prob.edge_pp >= 0 ? r1(e.prob.edge_pp) + ' pts of win probability above' : r1(Math.abs(e.prob.edge_pp)) + ' pts of win probability short of') + ' break-even' : 'no price';
      return e.label + where(e.sel) + ': ' + ({ VALUE: 'value', THIN: 'thin value', NO_VALUE: 'no value', OVERPRICED: 'overpriced' }[e.verdict] || 'not priced') + ', ' + val + ', confidence ' + r.c.grade.toLowerCase() + '.';
    });
    var rankV = { VALUE: 3, THIN: 2, NO_VALUE: 1, OVERPRICED: 0 };
    var a = rows[0], b = rows[1];
    var pick = (rankV[a.ev.verdict] || 0) !== (rankV[b.ev.verdict] || 0) ? ((rankV[a.ev.verdict] || 0) > (rankV[b.ev.verdict] || 0) ? a : b) : ((a.score || -1e9) >= (b.score || -1e9) ? a : b);
    var none = (rankV[a.ev.verdict] || 0) < 2 && (rankV[b.ev.verdict] || 0) < 2;
    var head = none ? 'Neither is worth it at these prices.' : 'I’d rather have ' + pick.ev.label + '.';
    var why = none ? '' : ' ' + (pick.ev.verdict !== (pick === a ? b : a).ev.verdict ? 'It’s the one that actually clears EdgeDesk’s number.' : 'Same verdict, but it scores higher once edge, price freshness, validation tier and evidence quality are weighed together.');
    var rk = risksFor(pick.E, pick.ev.sel, pick.ev);
    return head + why + '\n\n' + L.map(function (x) { return '- ' + x; }).join('\n') + (none || !rk.length ? '' : '\n\nMain risk on ' + pick.ev.label + ': ' + rk[0].text + '.');
  }
  function summarizeEval(E, ev) {
    return { sport: E.sport, game_id: E.identity.game_id, matchup: E.identity.away + ' @ ' + E.identity.home, kickoff: E.identity.kickoff,
      selection: ev.label, market: ev.sel.market, side: ev.sel.side, line: num(ev.sel.line), odds: num(ev.sel.odds), book: ev.sel.book || null,
      verdict: ev.verdict, value_points: ev.value_points, prob: ev.prob, fair: ev.fair, tier: ev.tier, market_state: ev.market_state, current: ev.current,
      outlier: ev.outlier, confidence: confidence(E, ev), evidence_quality: E.reliability, score: scoreOf(E, ev), ladder: ladder(E, ev.sel),
      reasons: reasonsFor(E, ev.sel), risks: risksFor(E, ev.sel, ev).slice(0, 4), missing: E.missing };
  }

  /** Every number the answer may contain, for the host's critic. */
  function allowedNumbers(out) {
    var nums = [];
    function add(v) { var n = num(v); if (n == null) return; nums.push(n, r1(n), Math.abs(n), Math.abs(r1(n)), Math.round(n), Math.round(Math.abs(n))); }
    (out.evaluations || []).forEach(function (e) {
      add(e.line); add(e.odds); add(e.value_points);
      if (e.prob) { add((e.prob.cover != null ? e.prob.cover : e.prob.win) * 100); add(e.prob.break_even * 100); add(e.prob.edge_pp); }
      if (e.fair) { add(e.fair.line); add(e.fair.projection_line); add(e.fair.price); }
      if (e.ladder) { add(e.ladder.attractive_at); add(e.ladder.playable_at); add(e.ladder.fair_price); add(e.ladder.attractive_price); }
    });
    var m = str(out.text).match(/[+-]?\d+(?:\.\d+)?/g) || [];
    m.forEach(function (x) { add(x); });
    return uniq(nums);
  }

  /* ================================================================
     10. THE CRITIC for a rephrased answer: numbers and names must come from
     the kernel's answer; no certainty words; short.
     ================================================================ */
  var CERTAINTY = /\b(guarantee\w*|can'?t (lose|miss)|lock|locks|sure thing|free money|will (win|cover|cash)|no[- ]brainer|easy money)\b/i;
  function critic(prose, out, ctx) {
    var issues = [], p = str(prose);
    ctx = ctx || {};
    if (!p.trim()) return { verdict: 'FAIL', findings: [{ code: 'EMPTY' }] };
    if (CERTAINTY.test(p)) issues.push({ code: 'CERTAINTY', severity: 'FAIL', detail: (CERTAINTY.exec(p) || [])[0] });
    var allowed = out.allowed || allowedNumbers(out);
    var found = p.replace(/\b(19|20)\d{2}\b/g, ' ').match(/[+-]?\d+(?:\.\d+)?/g) || [];
    var bad = found.filter(function (x) { var n = Math.abs(num(x)); return n != null && n > 1 && !allowed.some(function (a) { return Math.abs(Math.abs(a) - n) < 0.051; }); });
    if (bad.length) issues.push({ code: 'NUMBER_NOT_IN_EVIDENCE', severity: 'FAIL', detail: uniq(bad).slice(0, 6).join(', ') });
    var sentences = p.split(/(?<=[.!?])\s+/).filter(function (s) { return s.trim(); }).length;
    if (out.intent !== 'DEEP' && sentences > 12) issues.push({ code: 'TOO_LONG', severity: 'FAIL', detail: sentences + ' sentences' });
    if (out.intent !== 'DEEP' && /^\s*#+\s|THE CASE FOR EACH SIDE|WHAT THE MARKET SAYS/im.test(p)) issues.push({ code: 'TEMPLATE', severity: 'FAIL', detail: 'section headings in a short answer' });
    var kv = /\b(yes|no)\b/i.exec(str(out.text).slice(0, 12)), pv = /\b(yes|no)\b/i.exec(p.slice(0, 40));
    if (kv && pv && kv[1].toLowerCase() !== pv[1].toLowerCase()) issues.push({ code: 'VERDICT_FLIPPED', severity: 'FAIL', detail: 'the kernel said ' + kv[1] + ', the prose said ' + pv[1] });
    /* the headline facts survive: every number in EdgeDesk's first sentence appears in the rewrite */
    var first = str(out.text).split(/(?<=[.!?])\s+/)[0] || '';
    var keyNums = (first.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(function (x) { return Math.abs(num(x)); });
    var proseNums = (p.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(function (x) { return Math.abs(num(x)); });
    var dropped = keyNums.filter(function (k) { return !proseNums.some(function (x) { return Math.abs(x - k) < 0.051; }); });
    if (dropped.length) issues.push({ code: 'KEY_FACT_DROPPED', severity: 'FAIL', detail: dropped.join(', ') });
    if (/^Nothing stands out/.test(str(out.text)) && !/\bnothing\b|\bno (bet|value|play)\b|\bpass\b/i.test(p)) issues.push({ code: 'PASS_TURNED_INTO_PICK', severity: 'FAIL' });
    /* a team on the board that EdgeDesk's answer did not name may not appear: the writer cannot change the pick */
    var said = ' ' + normName(out.text) + ' ', wrote = ' ' + normName(p) + ' ';
    var intruders = uniq((ctx.teams || []).filter(function (t) { var n = normName(t); return n.length >= 3 && wrote.indexOf(' ' + n + ' ') >= 0 && said.indexOf(' ' + n + ' ') < 0; }));
    if (intruders.length) issues.push({ code: 'TEAM_NOT_IN_ANSWER', severity: 'FAIL', detail: intruders.slice(0, 4).join(', ') });
    return { verdict: issues.some(function (i) { return i.severity === 'FAIL'; }) ? 'FAIL' : 'PASS', findings: issues };
  }
  /** The instruction for a writing model that may only rephrase. */
  var NARRATION_CONTRACT = [
    'You are EdgeDesk’s betting research analyst. Below is EdgeDesk’s own answer, computed deterministically from its evidence.',
    'Rewrite it so it reads like a sharp, direct human analyst. Keep the SAME verdict, the SAME order (answer, price, why, risk), and EVERY number exactly as given.',
    'Do not add any number, team, player, statistic or claim that is not in the answer. Do not recalculate anything. No headings, no bullet lists unless the answer has them.',
    'Keep it about as long as the answer or shorter (3-8 sentences for a normal question). Never promise an outcome. Return only the rewritten answer.'
  ].join(' ');

  return {
    VERSION: VERSION, EVIDENCE_SCHEMA: EVIDENCE_SCHEMA, ANSWER_SCHEMA: ANSWER_SCHEMA, STATE_SCHEMA: STATE_SCHEMA, HISTORY_SCHEMA: HISTORY_SCHEMA,
    SPORTS: SPORTS, MISSING_PENALTY: MISSING_PENALTY, QUALITY_GRADES: QUALITY_GRADES, CONFIDENCE_GRADES: CONFIDENCE_GRADES,
    SIMILAR_MIN_SETTLED: SIMILAR_MIN_SETTLED, SIMILAR_MIN_TOTAL_SETTLED: SIMILAR_MIN_TOTAL_SETTLED, PREGAME_FEATURES: PREGAME_FEATURES, POSTGAME_KEYS: POSTGAME_KEYS,
    researchGap: researchGap, outlierGap: outlierGap, quoteStatus: quoteStatus,
    evidence: evidence, evaluate: evaluate, ladder: ladder, ladderText: ladderText, confidence: confidence, reasonsFor: reasonsFor, risksFor: risksFor,
    currentSelections: currentSelections, rank: rank, scoreOf: scoreOf, classify: classify, resolveTeams: resolveTeams, parseNumbers: parseNumbers,
    sanitizeState: sanitizeState, nextState: nextState, answer: answer, summarizeEval: summarizeEval, allowedNumbers: allowedNumbers,
    historyRecord: historyRecord, similarityVector: similarityVector, similarSituations: similarSituations, leaks: leaks,
    critic: critic, NARRATION_CONTRACT: NARRATION_CONTRACT
  };
});
/*__EDDESK_END__*/
