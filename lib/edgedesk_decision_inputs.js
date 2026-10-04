/* ===========================================================================
   EDGEDESK DECISION INPUTS — the existing objects, mapped once into the
   decision engine's input. docs/bettor-decision/DESIGN.md §3

   Two halves, so the build and the page decide from the same facts:

     FACTS    what EdgeDesk knows about a game apart from the price: research
              status and verification, integrity, reliability, confidence,
              stability, QB and availability, independent support, anomaly
              context and governance. factsFromTerminal() reads a research-
              terminal object (football/cfb_terminal/build.js); the build stores
              the result on every board row as `decision_facts`, and the page
              reads it from there (board.json) — it never re-derives a fact.

     PRICING  the EDQuoteEV model, the quotes and their evaluation. The build
              passes its own (build.js quoteEvOf); the page passes the live
              ones it already priced (app.html fbQevGameCfb / fbQevGameNfl).

   inputFromFacts(facts, pricing, opts) joins them. Nothing here computes a
   probability, an EV or a status: it only renames and routes fields.

   Browser: window.EDDecisionInputs. Node: require('./edgedesk_decision_inputs.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDDecisionInputs = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_decision_inputs_v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function upper(s) { return s == null ? null : String(s).toUpperCase(); }
  function copy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* QB statuses the integrity gate treats as unresolved (lib/cfb_disagreement.js) */
  var QB_UNRESOLVED = ['COMPETITION', 'UNKNOWN', 'UNSETTLED', 'CONTESTED', 'CONFLICTED'];
  var QB_DOUBTFUL = ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'GAME_TIME_DECISION'];

  function qbFacts(qb, readQb) {
    var out = { known: false, unresolved_critical: false, unconfirmed: false, contested: false, detail: null, sides: {} };
    if (!qb && !readQb) return out;
    var unresolved = [], unconfirmed = [];
    ['home', 'away'].forEach(function (s) {
      var q = qb && qb[s];
      if (!q) return;
      out.known = true;
      var st = upper(q.status), av = upper(q.availability);
      out.sides[s] = { player: q.player || null, status: st, confirmed: !!q.confirmed, contested: !!q.contested };
      if (!q.player || QB_UNRESOLVED.indexOf(st) >= 0 || (av && QB_DOUBTFUL.indexOf(av) >= 0)) unresolved.push((q.player || s) + ' (' + (st || 'unknown') + ')');
      else if (!q.confirmed) unconfirmed.push(q.player);
      if (q.contested) out.contested = true;
    });
    if (readQb) {
      (readQb.unresolved || []).forEach(function (t) { if (unresolved.indexOf(t) < 0) unresolved.push(t); });
      if (readQb.resolved === false && !unresolved.length) unresolved.push('starting quarterback unresolved');
    }
    out.unresolved_critical = unresolved.length > 0;
    out.unconfirmed = unconfirmed.length > 0;
    out.detail = unresolved.length ? unresolved.join('; ') : (unconfirmed.length ? unconfirmed.join(', ') + ' expected, not confirmed' : null);
    return out;
  }
  function availabilityFacts(o) {
    var out = { known: false, major_uncertainty: false, pending: false, uncertain: false, detail: null };
    var checks = (o && o.market_check && o.market_check.checks) || [];
    var inj = checks.filter(function (c) { return c.area === 'Injury' || c.area === 'Availability' || c.area === 'Roster'; });
    if (inj.length) out.known = true;
    inj.forEach(function (c) {
      var st = upper(c.status);
      if (st === 'FAIL' || st === 'CONFLICT') { out.major_uncertainty = true; out.detail = c.text; }
      else if (st === 'PENDING') { out.pending = true; out.detail = out.detail || c.text; }
      else if (st === 'OPEN') { out.uncertain = true; out.detail = out.detail || c.text; }
    });
    return out;
  }
  function stabilityOf(o) {
    var rows = (o && o.data_quality && o.data_quality.rows) || [];
    var s = rows.filter(function (r) { return r.key === 'stability'; })[0];
    return s && s.value ? String(s.value) : null;
  }
  /* independent models (the champion excluded) on each side of the market */
  function supportFacts(o) {
    var rows = (o && o.consensus && o.consensus.rows) || [];
    var by = { home: 0, away: 0 }, n = 0;
    rows.forEach(function (r) {
      if (!r || !r.independent || r.role === 'champion') return;
      n++;
      if (r.side_vs_market === 'home' || r.side_vs_market === 'away') by[r.side_vs_market]++;
    });
    return { by_side: by, total_independent: n };
  }
  /* a DATA FAULT's kind: FAULT (corrupted data: a blocker), GUARD (only the
     gap guard fired: a suspicion the engine verifies) or ORIENTATION (a market
     number that only reconciles once negated: the quotes stay team-labelled) */
  function faultKind(rule) { return rule === 'guard' ? 'GUARD' : (rule === 'orientation' ? 'ORIENTATION' : 'FAULT'); }
  /* the kind behind a research label's DATA FAULT. A canonical label (the
     published board, rule 'canonical') names no rule of its own: it carries
     the build's kind (fault_kind) when it has one, else the kind the facts
     already hold, else the live label's rule it replaced; unknown is FAULT. */
  var KINDS = { FAULT: 1, GUARD: 1, ORIENTATION: 1 };
  function labelFaultKind(L, base) {
    if (!L) return 'FAULT';
    if (L.fault_kind && KINDS[L.fault_kind]) return L.fault_kind;
    if (L.rule !== 'canonical') return faultKind(L.rule);
    if (base && base.integrity && base.integrity.data_fault && KINDS[base.integrity.data_fault_kind]) return base.integrity.data_fault_kind;
    return L.live_key === 'DATA_FAULT' && L.live_rule ? faultKind(L.live_rule) : 'FAULT';
  }
  function integrityFacts(o, ev) {
    var gates = [], D = o && o.disagreement && o.disagreement.integrity;
    if (D && D.checks) D.checks.forEach(function (c) { gates.push({ id: (c.group ? c.group + '.' : '') + c.id, status: upper(c.status) === 'PASS' ? 'PASS' : (upper(c.status) === 'FAIL' ? 'FAIL' : 'UNKNOWN') }); });
    ((o && o.market_check && o.market_check.checks) || []).forEach(function (c) {
      if (c.area === 'Mapping' || c.area === 'Market quality') gates.push({ id: 'check.' + c.area.toLowerCase().replace(/\s+/g, '_'), status: upper(c.status) === 'CLEAR' ? 'PASS' : (upper(c.status) === 'FAIL' ? 'FAIL' : 'UNKNOWN') });
    });
    var cb = ev && ev.circuit_breaker;
    var dist = cb && (cb.checks || []).filter(function (c) { return c.id === 'DISTRIBUTION_SANITY'; })[0];
    var incoherent = !!(ev && ev.price_curve && ev.price_curve.coherent === false);
    /* the breaker screens the curve only when the EV is extreme; the EV layer's
       own decision screens it every time (lib/edgedesk_ev.js decide →
       DISTRIBUTION_FAULT). A curve that fails there is malformed here too, or
       one game reads NO DECISION on the terminal and a priced PASS on the card
       (McNeese @ LSU, 2026-10-02 15:07 build) */
    var distFault = !!(ev && ev.decision_reason_code === 'DISTRIBUTION_FAULT');
    var st = o && o.status ? o.status.key : null, rs = o && o.research_status ? o.research_status.key : null;
    return { data_fault: st === 'DATA_FAULT' || rs === 'DATA_FAULT', data_fault_reason: st === 'DATA_FAULT' ? (o.status.reason || null) : (rs === 'DATA_FAULT' ? o.research_status.reason || null : null),
      data_fault_kind: st === 'DATA_FAULT' ? 'FAULT' : (rs === 'DATA_FAULT' ? faultKind(o.research_status.rule) : null),
      malformed_projection: !!(dist && dist.status === 'FAIL') || incoherent || distFault,
      malformed_reason: dist && dist.status === 'FAIL' ? dist.detail : (distFault ? (ev.decision_reason || 'the stored curve is not a coherent distribution') : (incoherent ? 'the stored price curve is incoherent' : null)),
      self_check_ok: o && o.data_quality && o.data_quality.self_check === false ? false : null, gates: gates };
  }
  function mappingOk(o) {
    var c = ((o && o.market_check && o.market_check.checks) || []).filter(function (x) { return x.area === 'Mapping'; })[0];
    if (!c) return null;
    return upper(c.status) === 'CLEAR' ? true : (upper(c.status) === 'FAIL' ? false : null);
  }

  /* ================================================ MEASURED CONTEXT
     What the Research and Lab views explain with, carried on the decision so
     every surface reads one object: the reliability score's own measured
     components, the measured perturbation SDs behind the projection, the
     reconciliation the terminal already computed, and where each important
     input came from, when it was updated and whether it prices. Only what the
     terminal measured is copied; nothing is estimated here. */
  function clip(t, n) { if (t == null) return null; var x = String(t); return x.length > n ? x.slice(0, n - 1) + '…' : x; }
  function mtime(t) { if (t == null || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function contextFromTerminal(o) {
    o = o || {};
    var DQ = o.data_quality || {}, S = o.sensitivity || {}, Rc = o.reconcile || {}, Tr = o.trust || {}, g = o.game || {};
    var drivers = [];
    ((S.available && S.rows) || []).forEach(function (r) {
      if (!r || r.kind !== 'mean' || !isNum(num(r.delta))) return;
      var key = String(r.key || '').replace(/_(down|up)$/, '');
      if (drivers.some(function (d) { return d.key === key; })) return;
      drivers.push({ key: key, label: String(r.label || key).replace(/ 1 SD (weaker|stronger|smaller|larger)$/, ''), sd: Math.abs(num(r.delta)), basis: r.basis === 'same' ? null : clip(r.basis, 110) });
    });
    var joint = ((Rc.rows || []).filter(function (x) { return x.key === 'combination'; })[0] || null);
    var qb = o.qb || {};
    var prov = [];
    function add(key, what, source, at, impact, conf) { if (source || at) prov.push({ key: key, what: what, source: source || null, updated_at: at || null, pricing_impact: impact, confidence: conf || null }); }
    add('model', 'Model projection', o.edgedesk && o.edgedesk.model_version ? o.edgedesk.model_version : Tr.model_version || null, Tr.model_updated_at, 'yes');
    add('market', 'Market quotes', Tr.books_total != null ? Tr.books_total + ' book' + (Tr.books_total === 1 ? '' : 's') + ' on file' : null, Tr.market_updated_at, 'yes');
    var qbSrc = (qb.home && qb.home.source) || (qb.away && qb.away.source) || null;
    add('qb', 'Quarterback', qbSrc, Tr.qb_as_of || (qb.home && qb.home.as_of) || null, 'yes (QB absence term)', qb.home && qb.away ? (qb.home.confirmed && qb.away.confirmed ? 'confirmed' : 'expected') : null);
    add('roster', 'Roster and availability', 'roster bundles and availability reports', Tr.roster_as_of, 'research only');
    ((o.sources || [])).forEach(function (x) { if (x && x.id === 'metrics') add('matchup', 'Opponent-adjusted unit metrics', x.path, x.updated_at, 'research only'); });
    var times = prov.map(function (p) { return mtime(p.updated_at); }).filter(isNum);
    return {
      reliability: { score: num(DQ.reliability), grade: DQ.grade || null, main_deduction: clip(DQ.main_deduction, 160),
        components: (DQ.rows || []).slice(0, 10).map(function (x) { return { key: x.key, label: x.label, value: x.value, unit: x.unit || null, detail: clip(x.detail, 90) }; }),
        next_actions: (DQ.next_actions || []).slice(0, 2).map(function (x) { return { action: clip(x.action, 90), gain: x.potential_gain_text || null }; }) },
      sensitivity_drivers: drivers,
      joint_sd: joint && isNum(num(joint.sd)) ? num(joint.sd) : null, joint_basis: joint ? joint.source || 'all measured dimensions jointly' : null,
      reconcile: (Rc.rows || []).slice(0, 4).map(function (x) { return { key: x.key, text: clip(x.text, 100), points_needed: num(x.points_needed), sd: num(x.sd), sds_needed: num(x.sds_needed) }; }),
      provenance: prov, facts_as_of: times.length ? new Date(Math.max.apply(null, times)).toISOString() : null,
      source: 'research terminal (football/cfb_terminal/games.json)' };
  }

  /* ==================================================== FROM THE TERMINAL
     o    the research-terminal game object (build.js buildGame().object, or a
          games.json entry); read / ev: its Read and EV read when present.
     gov  {policy_id, policy_status, policy_bet_enabled, ev_policy_maturity} */
  function factsFromTerminal(o, read, ev, gov) {
    o = o || {};
    var g = o.game || {}, A = o.edgedesk || {}, M = o.market || {}, Dg = o.disagreement || {}, DQ = o.data_quality || {};
    var toward = Dg.toward === 'home' || Dg.toward === 'away' ? Dg.toward : null;
    var cbOrient = ev && ev.circuit_breaker && (ev.circuit_breaker.checks || []).some(function (c) { return c.id === 'SIGN_ORIENTATION' && c.status === 'FAIL'; });
    var I = Dg.integrity || null;
    return {
      schema: VERSION, sport: 'CFB',
      game: { game_id: o.game_id != null ? String(o.game_id) : null, home: g.home || null, away: g.away || null, kickoff: o.kickoff || null, fcs: !!g.fcs,
        state: o.game_state || null, duplicate: !!(o.flags && o.flags.duplicate), mapping_ok: mappingOk(o),
        /* the ledger's quotes are home-stated by construction: a sign the EV
           circuit breaker doubts is a price anomaly to verify, not an orientation fault */
        orientation_ok: true, sign_suspect: cbOrient ? { reason: 'the market number looks flipped relative to the model (EV circuit breaker)' } : null,
        season: o.season || null, week: o.week || null },
      research: { status: o.research_status ? o.research_status.key : null, label: o.research_status ? o.research_status.label : null, reason: o.research_status ? o.research_status.reason : null,
        gap_pts: Dg.available ? num(Dg.points) : null, gap_toward_side: toward, gap_toward_team: Dg.toward_team || null,
        verification: I ? upper(I.verification) : (Dg.verification === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : upper(Dg.verification) || null),
        verification_items: I ? [].concat(I.failed || [], I.incomplete || []) : [] },
      integrity: integrityFacts(o, ev),
      market: { available: M.available !== false, consensus_home_line: num(M.consensus_home_line), n_books_fresh: num(M.books_fresh), n_books: num(M.books_total), dispersion: num(M.dispersion),
        stale: !!M.stale, movement_pts: M.move_since_open ? num(M.move_since_open.points) : null, open_home_line: num(M.open_home_line),
        fault: !!(read && read.integrity_status && read.integrity_status.quote_check_blocks) || (o.research_status && o.research_status.key === 'MARKET_FAULT'),
        fault_reason: o.research_status && o.research_status.key === 'MARKET_FAULT' ? o.research_status.reason : (read && read.integrity_status && read.integrity_status.quote_check_blocks ? 'two current numbers for one book disagree' : null) },
      reliability: { score: num(DQ.reliability), grade: DQ.grade || null },
      confidence: A.available && A.football_confidence ? { score: num(A.football_confidence.score), label: A.football_confidence.label || A.football_confidence.tier || null } : { score: null, label: null },
      projection: { stability: stabilityOf(o), model_sd: o.consensus && o.consensus.sd != null ? num(o.consensus.sd) : num(o.model_sd), uncertainty_score: o.uncertainty ? num(o.uncertainty.score) : null,
        projected_home: A.projected_score ? num(A.projected_score.home) : null, projected_away: A.projected_score ? num(A.projected_score.away) : null,
        p10: A.quantiles ? num(A.quantiles.p10) : null, p50: A.quantiles ? num(A.quantiles.p50) : null, p90: A.quantiles ? num(A.quantiles.p90) : null, fair_home_margin: num(A.home_margin) },
      qb: qbFacts(o.qb, read && read.qb_status),
      availability: availabilityFacts(o),
      support: supportFacts(o),
      anomaly: { circuit_breaker: ev && ev.circuit_breaker ? { triggered: !!ev.circuit_breaker.triggered, verified: ev.circuit_breaker.verified, level: ev.circuit_breaker.level || null } : null,
        favorite_flip: !!(o.favorite_flip && (o.favorite_flip === true || o.favorite_flip.flip)), rating_divergence_band: o.rating_divergence ? o.rating_divergence.band || null : null,
        fcs: !!g.fcs, current_season: true },
      governance: gov ? copy(gov) : null,
      context: contextFromTerminal(o)
    };
  }

  /* ============================================ FROM THE LIVE PAGE (CFB)
     The page's research view (lib/cfb_research_view.js build → rv) overlays
     the build's facts where the page's reading is newer: the research label,
     the gap, the market's freshness. A missing build row leaves the facts the
     view alone can supply, and marks the rest unknown (never assumed good). */
  function factsFromView(rv, base, extra) {
    extra = extra || {};
    var f = copy(base) || { schema: VERSION, sport: 'CFB', game: {}, research: {}, integrity: { gates: [] }, market: {}, reliability: {}, confidence: {}, projection: {},
      qb: { known: false }, availability: { known: false }, support: { by_side: { home: 0, away: 0 }, total_independent: 0 }, anomaly: {}, governance: null };
    f.game = f.game || {};
    if (extra.game) Object.keys(extra.game).forEach(function (k) { if (extra.game[k] != null) f.game[k] = extra.game[k]; });
    if (rv) {
      var L = rv.research_label, G = rv.market_gap, R = rv.reliability, C = rv.confidence;
      if (L && L.key) {
        var key = L.key === 'VERIFIED_MAJOR_DISAGREEMENT' ? 'VERIFIED_MAJOR' : (L.key === 'LOW_RELIABILITY' ? 'LIMITED_DATA' : L.key);
        f.research = f.research || {}; f.research.status = key; f.research.label = L.label || key; f.research.reason = L.reason || L.means || f.research.reason || null;
        f.integrity = f.integrity || { gates: [] };
        if (key === 'DATA_FAULT') { var kind = labelFaultKind(L, f); f.integrity.data_fault = true; f.integrity.data_fault_kind = kind; f.integrity.data_fault_reason = L.reason || L.means || f.integrity.data_fault_reason || null; }
        else if (f.integrity.data_fault && f.integrity.data_fault_kind !== 'FAULT') { f.integrity.data_fault = false; f.integrity.data_fault_kind = null; }
      }
      if (G && G.available) { f.research.gap_pts = num(G.points); if (G.toward_team) { f.research.gap_toward_team = G.toward_team; f.research.gap_toward_side = G.toward_team === f.game.home ? 'home' : (G.toward_team === f.game.away ? 'away' : f.research.gap_toward_side); } }
      if (G && G.stale != null) { f.market = f.market || {}; f.market.stale = !!G.stale; }
      if (R && (R.scored || R.score != null)) f.reliability = { score: num(R.score != null ? R.score : (R.pct != null ? R.pct * 100 : null)), grade: R.grade || R.tier || (f.reliability && f.reliability.grade) || null };
      if (C && C.score != null) f.confidence = { score: num(C.score), label: C.tier || C.label || null };
      if (rv.disagreement && (rv.disagreement.failed || rv.disagreement.incomplete)) f.research.verification_items = [].concat(rv.disagreement.failed || [], rv.disagreement.incomplete || []);
      if (rv.projection_stability && !f.projection.stability) f.projection.stability = rv.projection_stability;
    }
    if (extra.market) Object.keys(extra.market).forEach(function (k) { if (extra.market[k] != null) f.market[k] = extra.market[k]; });
    return f;
  }

  /* the live market facts, read off the priced evaluation the page already has */
  function marketFromEvaluation(G, base) {
    var m = copy(base) || {};
    if (!G || !G.sides) return m;
    var ml = G.main_line || {};
    if (isNum(ml.home)) m.consensus_home_line = ml.home; else if (isNum(ml.away)) m.consensus_home_line = -ml.away;
    var fresh = 0;
    ['home', 'away'].forEach(function (s) { ((G.sides[s] && G.sides[s].quotes) || []).forEach(function (o) { if (o.is_main_line && o.quote_status === 'FRESH' && isNum(o.n_books_at_line)) fresh = Math.max(fresh, o.n_books_at_line); }); });
    if (fresh) m.n_books_fresh = fresh;
    m.available = true;
    return m;
  }

  /* ================================================================ JOIN */
  function inputFromFacts(facts, pricing, opts) {
    facts = facts || {}; pricing = pricing || {}; opts = opts || {};
    var sup = facts.support || {};
    return {
      now: opts.now != null ? opts.now : Date.now(),
      sport: opts.sport || facts.sport || (pricing.model && pricing.model.sport) || 'CFB',
      league: opts.sport || facts.sport || (pricing.model && pricing.model.sport) || 'CFB',
      market_type: opts.market_type || 'spread',
      game: copy(facts.game) || {},
      model: pricing.model || null,
      quotes: pricing.quotes || null,
      qev_ctx: pricing.qev_ctx || null,
      evaluation: pricing.evaluation || null,
      research: copy(facts.research) || {},
      integrity: copy(facts.integrity) || {},
      market: copy(facts.market) || {},
      reliability: copy(facts.reliability) || {},
      confidence: copy(facts.confidence) || {},
      projection: copy(facts.projection) || {},
      qb: copy(facts.qb) || {},
      availability: copy(facts.availability) || {},
      /* the engine reads independent_count; it is taken for the side the
         research leans (the only side a calibrated edge can appear on) */
      support: { independent_count: sup.by_side && facts.research && facts.research.gap_toward_side ? num(sup.by_side[facts.research.gap_toward_side]) : (num(sup.independent_count) != null ? num(sup.independent_count) : null),
        by_side: copy(sup.by_side) || null, total_independent: num(sup.total_independent) },
      anomaly: copy(facts.anomaly) || {},
      governance: copy(opts.governance || facts.governance) || null,
      context: copy(facts.context) || null,
      facts_as_of: facts.context && facts.context.facts_as_of ? facts.context.facts_as_of : null,
      previous: opts.previous || null,
      track: opts.track || null,
      limits_unknown: true
    };
  }

  /* NFL: the page's own facts. The NFL board has no reliability score, no
     integrity gate and no live-validated calibration: those are OPTIONAL
     facts, so they lower decision confidence and cap the stake — they never
     block a decision. v = the page's quote-EV game (app.html fbQevGameNfl):
     v.ctx (game, research, QB), v.g (the priced evaluation), v.dq (the
     projection's data quality), v.qb ({home, away} starter known). */
  var DQ_SCORE = { OK: 70, PARTIAL: 55, DEGRADED: 45, INSUFFICIENT_DATA: 30, BLOCKED: 0 };
  function nflFacts(v, extra) {
    extra = extra || {};
    var ctx = (v && v.ctx) || {}, g = ctx.game || {};
    var dq = v && v.dq ? v.dq : null, dqs = dq ? DQ_SCORE[upper(dq.status)] : null;
    if (isNum(dqs) && dq.warnings && dq.warnings.length) dqs = Math.max(0, dqs - Math.min(15, 5 * dq.warnings.length));
    var qbk = v && v.qb ? v.qb : null;
    var known = qbk ? !!(qbk.home && qbk.away) : !ctx.qb_unresolved;
    var gapToward = v && v.gap ? v.gap.toward : null;
    var guard = !!ctx.data_fault;
    return { schema: VERSION, sport: 'NFL',
      game: { game_id: g.game_id || (v && v.gid) || null, home: g.home || (v && v.home) || null, away: g.away || (v && v.away) || null, kickoff: g.kickoff || null,
        state: extra.state || null, mapping_ok: true, orientation_ok: true, sign_suspect: null },
      research: { status: ctx.research_status || null, label: ctx.research_status || null, gap_pts: v && v.gap ? num(v.gap.points) : null, gap_toward_team: gapToward,
        gap_toward_side: gapToward ? (gapToward === (v && v.home) ? 'home' : 'away') : null, verification: 'NOT_REQUIRED' },
      /* the NFL board's only DATA FAULT is its gap guard (FB_GUARD): a suspicion, not corruption */
      integrity: { data_fault: guard, data_fault_kind: guard ? 'GUARD' : null, data_fault_reason: guard ? 'the model–market gap is past the NFL live-line guard' : null, gates: [] },
      market: marketFromEvaluation(v && v.g, {}),
      reliability: { score: null, required: false }, confidence: { score: isNum(dqs) ? dqs : null, label: dq ? upper(dq.status) : null, required: false },
      projection: { stability: null, fair_home_margin: v && v.model ? num(v.model.fair_home_margin) : null },
      qb: { known: known, unresolved_critical: false, unconfirmed: false, contested: false, detail: qbk && qbk.detail ? qbk.detail : (known ? null : 'starting quarterbacks not on the slate row') },
      availability: { known: false }, support: { by_side: { home: 0, away: 0 }, total_independent: 0 },
      anomaly: {}, governance: { policy_id: null, policy_status: 'NONE', policy_bet_enabled: false },
      /* the NFL board publishes no reliability components and no measured
         perturbation SDs: the context says so rather than inventing them */
      context: { reliability: dq ? { score: isNum(dqs) ? dqs : null, grade: dq.status || null, main_deduction: dq.warnings && dq.warnings.length ? String(dq.warnings[0]) : null,
          components: (dq.warnings || []).slice(0, 6).map(function (w, i) { return { key: 'warning_' + i, label: 'Data warning', value: String(w), unit: null, detail: null }; }), next_actions: [] } : null,
        sensitivity_drivers: [], joint_sd: null, reconcile: [],
        provenance: [{ key: 'model', what: 'Model projection', source: 'football/engine.js (nflverse)', updated_at: null, pricing_impact: 'yes' },
          { key: 'qb', what: 'Quarterback', source: 'nflverse slate starters', updated_at: null, pricing_impact: 'yes (QB term)', confidence: known ? 'on the slate' : 'not on the slate' }],
        facts_as_of: null, source: 'NFL board (app.html fbQevGameNfl)' } };
  }

  return { VERSION: VERSION, factsFromTerminal: factsFromTerminal, factsFromView: factsFromView, marketFromEvaluation: marketFromEvaluation,
    inputFromFacts: inputFromFacts, nflFacts: nflFacts, qbFacts: qbFacts, availabilityFacts: availabilityFacts, supportFacts: supportFacts,
    faultKind: faultKind, labelFaultKind: labelFaultKind, contextFromTerminal: contextFromTerminal };
}));
