/* ===========================================================================
   EdgeDesk INTEGRITY — the one validation engine every boundary runs.
   docs/system-integrity/DATA_CONTRACT.md · docs/system-integrity/RULES.md

   ONE RECORD, ONE ENGINE, EVERY BOUNDARY
     A research record (EDIntegrity.record / fromTerminalGame) is the data
     contract: the game, its kickoff truth, the model snapshot, the market
     snapshot, the canonical comparison (lib/edgedesk_calc.js), the research
     status, the decision, the EV pair, availability and provenance.

     evaluate(record, boundary) runs every deterministic rule and returns, per
     rule: PASS, WARNING or BLOCKED, with the rule id, severity, the record,
     the evidence, a plain-English explanation and the remediation. The
     boundary decides what blocks: a placeholder kickoff is a WARNING on the
     research dashboard (shown as "time TBA") and BLOCKED in a publisher
     export. Nothing BLOCKED at READY_TO_SEND may be sent.

       RESEARCH_DASHBOARD   the boards and research pages (warn, rarely block)
       BETTING_DECISION     what may become BET / LEAN / WATCH
       PUBLIC_BRIEF         a public game brief or article page
       AI_CONTEXT           what an AI writer may be handed as fact
       EDITORIAL_APPROVAL   the owner's approval
       READY_TO_SEND        the last gate before anything leaves EdgeDesk
       PUBLISHER_EXPORT     Markdown / HTML / DOCX / publisher files

   WHAT THIS FILE NEVER DOES
     - ask an AI anything. Arithmetic and structure are checked by code;
     - change a number, a label or a decision. It reports; callers refuse;
     - pass a check by default: a rule with no input it needs is WARNING
       (unknown is never PASS) unless the rule says absence is fine.

   Browser: window.EDIntegrity (load edgedesk_calc.js, edgedesk_schedule.js,
   edgedesk_availability.js first). Node: require('./edgedesk_integrity.js').
   =========================================================================== */
(function (root, factory) {
  var deps = {};
  if (typeof module === 'object' && module.exports) {
    deps.calc = require('./edgedesk_calc.js');
    deps.schedule = require('./edgedesk_schedule.js');
    deps.availability = require('./edgedesk_availability.js');
    module.exports = factory(deps);
  } else {
    deps.calc = root.EDCalc; deps.schedule = root.EDSchedule; deps.availability = root.EDAvailability;
    root.EDIntegrity = factory(deps);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (deps) {
  'use strict';
  var CALC = deps.calc, SCHED = deps.schedule, AV = deps.availability;
  if (!CALC || !SCHED || !AV) throw new Error('EDIntegrity needs EDCalc, EDSchedule and EDAvailability loaded first');
  var I = { VERSION: 'edgedesk_integrity/1', RECORD_SCHEMA: 'edgedesk_research_record_v1' };

  var BOUNDARIES = ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'];
  var PUBLICATION = ['PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'];
  I.BOUNDARIES = BOUNDARIES; I.PUBLICATION = PUBLICATION;
  I.THRESHOLDS = { stale_minutes: 180, min_reliability: 60, future_tolerance_minutes: 5, score_tolerance: 0.1, prob_sum_tolerance: 0.005 };

  function num(x) { return CALC.num(x); }
  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function pick(o, path) { var c = o, p = path.split('.'); for (var i = 0; i < p.length; i++) { if (c == null) return null; c = c[p[i]]; } return c === undefined ? null : c; }
  function fixed(x, d) { return num(x) == null ? '—' : num(x).toFixed(d == null ? 1 : d); }

  /* ======================================================== THE RECORD
     The data contract (DATA_CONTRACT.md §1). Every field is optional in the
     input; a missing field is carried as null and the rules say so. */
  I.record = function (x) {
    x = x || {};
    var g = x.game || {}, m = x.model || {}, k = x.market || {};
    var names = { home: g.home || null, away: g.away || null };
    var kick = SCHED.kickoffOf({ kickoff: g.kickoff, start_time_tbd: has(g, 'start_time_tbd') ? g.start_time_tbd : (has(g, 'kickoff_tbd') ? g.kickoff_tbd : undefined), kickoff_state: g.kickoff_state, kickoff_basis: g.kickoff_basis });
    var cmp = CALC.spreadComparison({ home: names.home, away: names.away, model_home_margin: m.available === false ? null : m.home_margin,
      market_home_margin: k.available === false ? null : k.home_margin, model_snapshot_id: m.snapshot_id, market_snapshot_id: k.snapshot_id });
    var scores = num(m.total) != null && num(m.home_margin) != null ? CALC.projectedScores({ home: names.home, away: names.away, home_margin: m.home_margin, total: m.total }) : { available: false };
    var r = {
      schema: I.RECORD_SCHEMA, integrity_version: I.VERSION, calc_version: CALC.VERSION,
      game: { game_id: g.game_id != null ? String(g.game_id) : null, sport: g.sport || 'CFB', season: num(g.season), season_type: g.season_type || null, week: num(g.week),
        home: names.home, away: names.away, home_id: g.home_id != null ? String(g.home_id) : null, away_id: g.away_id != null ? String(g.away_id) : null,
        home_conference: g.home_conference || null, away_conference: g.away_conference || null, neutral_site: has(g, 'neutral_site') ? !!g.neutral_site : null,
        venue: g.venue || null, status: g.status || null, completed: g.completed || null },
      kickoff: kick,
      model: { available: m.available !== false && num(m.home_margin) != null, version: m.version || null, snapshot_id: m.snapshot_id || null, projected_at: iso(m.projected_at),
        home_margin: num(m.home_margin), total: num(m.total), home_win_prob: num(m.home_win_prob), away_win_prob: num(m.away_win_prob),
        projected_score: m.projected_score || null, confidence: num(m.confidence), reliability: num(m.reliability), completeness: num(m.completeness), near_pickem: num(m.home_margin) != null && Math.abs(m.home_margin) < 1,
        /* false when the league's model publishes no reliability score at all
           (the NFL model): the record says so instead of inventing a number */
        reliability_published: has(m, 'reliability_published') ? m.reliability_published !== false : true },
      market: { available: k.available !== false && num(k.home_margin) != null, snapshot_id: k.snapshot_id || null, captured_at: iso(k.captured_at), market_type: k.market_type || 'spread',
        is_main_line: has(k, 'is_main_line') ? k.is_main_line : null, home_margin: num(k.home_margin), book: k.book || null, source: k.source || null, method: k.method || null,
        books_fresh: num(k.books_fresh), books_total: num(k.books_total), stale: has(k, 'stale') ? !!k.stale : null, fault: k.fault || null, mapping_ok: has(k, 'mapping_ok') ? k.mapping_ok : null,
        orientation_ok: has(k, 'orientation_ok') ? k.orientation_ok : null, quarantined_in_consensus: k.quarantined_in_consensus || [], claim: k.claim || null,
        /* a REFERENCE line: a published line with a source but no book price
           or capture time. It is labelled as a reference and never presented
           as a price, so a missing capture time is not a clock fault for it. */
        reference: has(k, 'reference') ? !!k.reference : false },
      comparison: cmp,
      projected_scores: scores,
      research: x.research || null,
      decision: x.decision || null,
      ev: x.ev || null,
      availability: x.availability || null,
      displayed: x.displayed || null,
      provenance: x.provenance || [],
      built_at: iso(x.built_at) || null
    };
    r.record_id = 'rr_' + CALC.fingerprint([r.game.game_id, r.model.version, r.model.snapshot_id, r.model.home_margin, r.market.snapshot_id, r.market.home_margin, r.market.captured_at, r.calc_version]);
    return r;
  };

  /* ===================== ADAPTER: a CFB terminal research object (games.json)
     opts: { slate_row (football/fbs/slate.json game, for start_time_tbd and
     team ids), board_row (board.json), built_at } */
  I.fromTerminalGame = function (o, opts) {
    opts = opts || {};
    if (!o) return null;
    var G = o.game || {}, A = o.edgedesk || {}, B = o.market || {}, S = opts.slate_row || {}, R = opts.board_row || {};
    var cons = num(B.consensus_home_line);
    var bestQ = (B.quotes || []).filter(function (q) { return q && q.fresh; })[0] || null;
    var dq = o.data_quality || {};
    var ev = o.ev || null, qev = R.quote_ev || compactQuoteEv(o.quote_ev);
    var evSel = ev && ev.selected ? ev.selected : null;
    var qb = o.qb || {};
    var av = { home: [AV.classify(AV.fromTerminal(G.home, qb.home), { kickoff: o.kickoff })], away: [AV.classify(AV.fromTerminal(G.away, qb.away), { kickoff: o.kickoff })] };
    return I.record({
      game: { game_id: o.game_id, season: o.season, week: o.week, season_type: S.season_type || null, home: G.home, away: G.away,
        home_id: S.home_team_id || null, away_id: S.away_team_id || null, home_conference: G.home_conference, away_conference: G.away_conference,
        neutral_site: G.neutral_site, venue: G.venue, kickoff: o.kickoff,
        start_time_tbd: has(S, 'start_time_tbd') ? S.start_time_tbd : (has(o, 'kickoff_tbd') ? o.kickoff_tbd : undefined),
        kickoff_state: S.kickoff_state || o.kickoff_state || null, kickoff_basis: S.kickoff_basis || o.kickoff_basis || null },
      model: { available: !!A.available, version: A.model_version, snapshot_id: opts.model_snapshot_id || (A.prediction_ts ? 'v1@' + A.prediction_ts : null), projected_at: A.prediction_ts,
        home_margin: A.home_margin, total: A.fair_total, home_win_prob: A.home_win_prob, away_win_prob: A.away_win_prob, projected_score: A.projected_score || null,
        confidence: A.football_confidence ? A.football_confidence.score : null, reliability: dq.reliability, completeness: S.data_completeness != null ? S.data_completeness : null },
      market: { available: !!B.available && cons != null, snapshot_id: B.as_of ? 'mkt@' + B.as_of : null, captured_at: B.as_of, market_type: 'spread', is_main_line: true,
        home_margin: cons == null ? null : -cons, book: bestQ ? bestQ.book : (B.quotes && B.quotes[0] ? B.quotes[0].book : null), source: bestQ ? bestQ.source : null,
        method: B.books_fresh > 1 ? 'MEDIAN' : 'SINGLE_BOOK', books_fresh: B.books_fresh, books_total: B.books_total, stale: !!B.stale,
        fault: B.consensus_fault ? B.consensus_fault.reason : (o.research_status && o.research_status.key === 'MARKET_FAULT' ? o.research_status.reason : null),
        mapping_ok: pick(R, 'decision_facts.game.mapping_ok'), orientation_ok: pick(R, 'decision_facts.game.orientation_ok'), quarantined_in_consensus: B.quarantined_in_consensus || [] },
      research: o.research_status ? { key: o.research_status.key, label: o.research_status.label, rule: o.research_status.rule, reason: o.research_status.reason, flags: o.research_status.flags || [] } : null,
      decision: o.decision_status ? { key: o.decision_status.key, label: o.decision_status.label, reason: o.decision_status.reason, engine_status: o.decision_status.engine_status,
        bettor: R.bettor || null } : null,
      ev: ev ? {
        raw: evSel && num(evSel.raw_model_ev) != null ? { ev: evSel.raw_model_ev, p: evSel.p_cover_raw, selection: selOf(evSel) } : null,
        calibrated: evSel && num(evSel.calibrated_ev) != null ? { ev: evSel.calibrated_ev, p: evSel.p_cover_calibrated, selection: selOf(evSel) } : null,
        quote_raw: qev && qev.best_side && num(qev.expected_value_pct) != null ? { ev: qev.expected_value_pct / 100, p: qev.model_cover_probability,
          selection: { market_type: 'spread', side: qev.best_side, line: qev.best_spread, american: qev.best_price, book: qev.best_book, captured_at: qev.best_quote_timestamp } } : null,
        quote_calibrated: qev && qev.best_side && num(qev.calibrated_expected_value_pct) != null ? { ev: qev.calibrated_expected_value_pct / 100,
          selection: { market_type: 'spread', side: qev.best_side, line: qev.best_spread, american: qev.best_price, book: qev.best_book, captured_at: qev.best_quote_timestamp } } : null,
        calibration: ev.calibration || null, anchor: ev.calibration_anchor || null, policy_maturity: ev.policy_maturity || null
      } : null,
      availability: av,
      displayed: opts.displayed || { fair_text: A.fair_text || null, market_text: B.consensus_text || null, gap: o.disagreement && o.disagreement.available ? o.disagreement.points : null,
        gap_text: o.disagreement ? o.disagreement.text || null : null, score_text: A.projected_score ? A.projected_score.text : null, market_claim: B.stale ? 'stale' : (B.available ? 'current' : null) },
      provenance: (o.sources || []).map(function (s) { return { id: s.id, path: s.path, updated_at: s.updated_at || null }; }),
      built_at: o.built_at || opts.built_at || null
    });
  };
  /* the best-raw-EV main-line quote of a full quote-EV object (games.json),
     in the board row's compact shape */
  function compactQuoteEv(full) {
    if (!full || (!full.home && !full.away)) return null;
    var best = null;
    ['home', 'away'].forEach(function (s) {
      ((full[s] && full[s].quotes) || []).forEach(function (q) {
        if (!q || !q.ev_available || num(q.expected_value_pct) == null || q.is_main_line === false) return;
        if (!best || q.expected_value_pct > best.expected_value_pct) best = q;
      });
    });
    if (!best) return null;
    return { best_side: best.side, best_spread: best.line, best_price: best.american_odds, best_book: best.sportsbook, best_quote_timestamp: best.captured_at,
      model_cover_probability: best.model_cover_probability, expected_value_pct: best.expected_value_pct,
      calibrated_expected_value_pct: best.adjusted && best.adjusted.available ? best.adjusted.expected_value_pct : null };
  }
  function selOf(s) { return { market_type: s.market_type || 'spread', side: s.side, line: s.line, american: s.odds ? s.odds.american : s.american, book: s.book, captured_at: s.quote_ts || s.captured_at }; }

  /* =========================================================== CALIBRATION
     A calibrator that maps every probability to (about) 50% has learned
     that the raw probabilities carry no information. It is not a broken
     calibrator — it is a finding — but it must never be presented as a
     validated probability. */
  I.calibrationQuality = function (cal) {
    if (!cal) return { state: 'MISSING', usable: false, text: 'No calibration is attached: the probability is the raw model’s.' };
    var oof = cal.oof || {};
    var ll = num(oof.log_loss), br = num(oof.brier), ill = num(oof.identity_log_loss), ibr = num(oof.identity_brier), isl = num(oof.identity_slope);
    var T = cal.map && num(cal.map.T);
    /* a temperature this large divides every logit to ~0: every probability is 50% */
    var degenerate = ((ll != null && Math.abs(ll - Math.LN2) < 0.0015) && (br != null && Math.abs(br - 0.25) < 0.0015)) || (T != null && T >= 1000);
    var rawWorse = ill != null && ill > Math.LN2 + 0.002;
    var state = degenerate ? 'DEGENERATE' : (/shadow|experimental/i.test(String(cal.maturity || '')) ? 'SHADOW' : (cal.usable ? 'VALIDATED' : 'UNUSABLE'));
    var text;
    if (degenerate) text = 'The calibrator maps every cover probability to about 50%' + (T != null && T >= 1000 ? ' (a temperature of ' + Math.round(T).toLocaleString('en-US') + ')' : '') + ' (out-of-sample log loss ' + fixed(ll, 3) + ', Brier ' + fixed(br, 3)
      + ' — a coin flip). Out of sample' + (cal.training_window ? ' (' + cal.training_window + ', ' + (oof.n || '?') + ' games)' : '') + ', the raw model’s cover probabilities scored '
      + (rawWorse ? 'worse than a coin flip (log loss ' + fixed(ill, 3) + (isl != null ? ', slope ' + fixed(isl, 2) : '') + ')' : 'no better than a coin flip')
      + '. A calibrated EV from it is the price’s vig, not a measurement of an edge. Status in the artifact: ' + (cal.status || '?') + ' / ' + (cal.maturity || '?') + '.';
    else if (state === 'SHADOW') text = 'Calibration is ' + cal.maturity + ': fitted out of sample but not yet validated on live games. Shadow-only.';
    else if (state === 'VALIDATED') text = 'Calibration validated out of sample.';
    else text = 'Calibration is not usable: ' + (cal.reason || 'no reason recorded') + '.';
    return { state: state, usable: state === 'VALIDATED', degenerate: degenerate, raw_worse_than_coin: rawWorse, text: text,
      oof: { n: oof.n || null, log_loss: ll, brier: br, identity_log_loss: ill, identity_brier: ibr, identity_slope: isl } };
  };

  /* ================================================================ RULES
     at: per boundary, 'BLOCK' | 'WARN' | 'OFF'; default for an unlisted
     boundary is dflt. check() returns null when the rule holds. */
  function at(block, warn, off, dflt) {
    var o = {}; (block || []).forEach(function (b) { o[b] = 'BLOCK'; }); (warn || []).forEach(function (b) { o[b] = 'WARN'; }); (off || []).forEach(function (b) { o[b] = 'OFF'; });
    o._default = dflt || 'BLOCK'; return o;
  }
  var ALL_BLOCK = at([], [], [], 'BLOCK');
  var DASH_WARN = at([], ['RESEARCH_DASHBOARD'], [], 'BLOCK');
  var DASH_DEC_WARN = at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION'], [], 'BLOCK');
  var WARN_ALL = at([], [], [], 'WARN');

  var RULES = [
    /* ------------------------------------------------------------ SCHEDULE */
    { id: 'SCHED.REAL_EVENT', group: 'schedule', title: 'A real, identified event', at: ALL_BLOCK,
      check: function (r) {
        var g = r.game;
        if (!g.game_id || !g.home || !g.away) return { evidence: { game_id: g.game_id, home: g.home, away: g.away }, explanation: 'The record has no stable game id or is missing a team.', remediation: 'Rebuild the record from the schedule source; never publish a game without a canonical id.' };
        if (String(g.home).toLowerCase() === String(g.away).toLowerCase()) return { evidence: { home: g.home, away: g.away }, explanation: 'The home and away teams are the same.', remediation: 'Fix the schedule join.' };
        return null;
      } },
    { id: 'SCHED.TEAM_IDS', group: 'schedule', title: 'Stable team identifiers', at: WARN_ALL,
      check: function (r) { return r.game.home_id && r.game.away_id ? null : { evidence: { home_id: r.game.home_id, away_id: r.game.away_id }, explanation: 'Team ids are not on the record; teams are matched by name only.', remediation: 'Carry the schedule’s home_team_id / away_team_id into the record.' }; } },
    { id: 'SCHED.SEASON_WEEK', group: 'schedule', title: 'Season and week on the record', at: DASH_WARN,
      check: function (r) { return r.game.season != null && r.game.week != null ? null : { evidence: { season: r.game.season, week: r.game.week }, explanation: 'The record does not say which season and week it belongs to.', remediation: 'Carry the schedule’s season and week.' }; } },
    { id: 'SCHED.KICKOFF_VERIFIED', group: 'schedule', title: 'Kickoff time confirmed by the source', at: DASH_DEC_WARN,
      check: function (r) {
        var k = r.kickoff;
        return k.verified ? null : { evidence: { state: k.state, utc: k.utc, basis: k.basis, game_date: k.game_date },
          explanation: k.state === 'MISSING' ? 'No usable kickoff is on file.' : 'The kickoff time is not confirmed: ' + k.basis + '. The timestamp is a placeholder, not a time.',
          remediation: 'Show "time TBA" on the game date; keep the game out of publications until the source confirms a time.' };
      } },
    { id: 'SCHED.PREGAME', group: 'schedule', title: 'The game has not started and is not postponed or canceled', at: at([], ['RESEARCH_DASHBOARD'], [], 'BLOCK'),
      check: function (r, ctx) {
        var st = SCHED.statusOf({ kickoff: r.kickoff.utc, start_time_tbd: r.kickoff.verified ? false : true, status: r.game.status, completed: r.game.completed }, ctx.now);
        return st.pregame ? null : { evidence: { status: st.status, inferred: st.inferred }, explanation: 'The game is ' + st.label.toLowerCase() + (st.inferred ? ' (kickoff has passed)' : '') + '.', remediation: 'Remove it from pregame research, decisions and articles.' };
      } },
    { id: 'SCHED.WEEK_SCOPE', group: 'schedule', title: 'The game belongs to the week being published', at: DASH_DEC_WARN,
      check: function (r, ctx) {
        var tgt = ctx.target_week || ctx.current_week;
        if (!tgt) return { evidence: {}, explanation: 'No target week was supplied, so week scope could not be checked.', remediation: 'Pass the current week (EDSchedule.currentWeek) or the article’s target week.' };
        var sc = SCHED.scope(r.game, tgt);
        return sc === 'CURRENT_WEEK' ? null : { evidence: { scope: sc, week: r.game.week, target_week: tgt.week },
          explanation: sc === 'FUTURE_WEEK' ? 'Week ' + r.game.week + ' is a future week; this is look-ahead research, not this week’s.' : 'The game is outside the target week (' + sc + ').',
          remediation: 'Label it FUTURE WEEK on research surfaces; keep it out of this week’s articles.' };
      } },
    { id: 'SCHED.VENUE', group: 'schedule', title: 'Venue and neutral-site designation on file', at: WARN_ALL,
      check: function (r) { return r.game.venue && r.game.neutral_site !== null ? null : { evidence: { venue: r.game.venue, neutral_site: r.game.neutral_site }, explanation: 'The venue or the neutral-site flag is missing; home field cannot be checked.', remediation: 'Carry the schedule’s venue and neutral_site.' }; } },

    /* ---------------------------------------------------------- PROJECTION */
    { id: 'PROJ.AVAILABLE', group: 'projection', title: 'A model projection with its version', at: DASH_WARN,
      check: function (r) { return r.model.available && r.model.version ? null : { evidence: { available: r.model.available, version: r.model.version }, explanation: 'There is no projection, or it carries no model version.', remediation: 'Show the game without a model number; never fill one in.' }; } },
    { id: 'PROJ.SNAPSHOT', group: 'projection', title: 'Projection snapshot id and timestamp', at: DASH_DEC_WARN,
      check: function (r) { if (!r.model.available) return null; return r.model.snapshot_id && r.model.projected_at ? null : { evidence: { snapshot_id: r.model.snapshot_id, projected_at: r.model.projected_at }, explanation: 'The projection cannot be traced to a snapshot.', remediation: 'Carry the projection’s snapshot id and prediction timestamp.' }; } },
    { id: 'PROJ.MODEL_VERSION', group: 'projection', title: 'The champion model produced the number', at: DASH_WARN,
      check: function (r, ctx) { if (!r.model.available || !ctx.champion) return null; return r.model.version === ctx.champion ? null : { evidence: { version: r.model.version, champion: ctx.champion }, explanation: 'The projection came from ' + r.model.version + ', not the champion ' + ctx.champion + '.', remediation: 'Rebuild from the champion, or label the number as a challenger’s.' }; } },
    { id: 'PROJ.PROBABILITIES', group: 'projection', title: 'Valid win probabilities', at: ALL_BLOCK,
      check: function (r) {
        var h = r.model.home_win_prob, a = r.model.away_win_prob;
        if (!r.model.available || (h == null && a == null)) return null;
        if (h == null || a == null || h < 0 || h > 1 || a < 0 || a > 1 || Math.abs(h + a - 1) > I.THRESHOLDS.prob_sum_tolerance)
          return { evidence: { home_win_prob: h, away_win_prob: a }, explanation: 'The win probabilities are outside [0, 1] or do not sum to 1.', remediation: 'Rebuild the projection; never show it.' };
        return null;
      } },
    { id: 'PROJ.DIRECTION', group: 'projection', title: 'Spread direction agrees with the win probability', at: ALL_BLOCK,
      check: function (r) {
        var m = r.model.home_margin, h = r.model.home_win_prob;
        if (!r.model.available || m == null || h == null || Math.abs(m) < 0.5) return null;
        return (m > 0) === (h > 0.5) ? null : { evidence: { home_margin: m, home_win_prob: h }, explanation: 'The projected margin favours one team and the win probability the other: a sign error.', remediation: 'Check the orientation of the projection; block until fixed.' };
      } },
    { id: 'PROJ.SCORES', group: 'projection', title: 'Projected scores agree with the margin and the total', at: DASH_WARN,
      check: function (r) {
        var ps = r.model.projected_score;
        if (!r.model.available || !ps || num(ps.home) == null || num(ps.away) == null || r.model.total == null) return null;
        var dm = Math.abs((ps.home - ps.away) - r.model.home_margin), dt = Math.abs((ps.home + ps.away) - r.model.total), tol = I.THRESHOLDS.score_tolerance + 1e-9;
        var side = Math.abs(r.model.home_margin) < 0.05 || ((ps.home - ps.away) >= 0) === (r.model.home_margin > 0);
        if (dm <= tol && dt <= tol && side) return null;
        return { evidence: { projected_score: { home: ps.home, away: ps.away }, home_margin: r.model.home_margin, total: r.model.total, margin_off: CALC.round(dm, 2), total_off: CALC.round(dt, 2) },
          explanation: 'The projected scores do not reproduce the projected margin and total.', remediation: 'Print scores from EDCalc.projectedScores (derived from the margin and the total).' };
      } },
    { id: 'PROJ.INPUTS', group: 'projection', title: 'Thin or unmeasured inputs are labelled as such', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION'], [], 'BLOCK'),
      check: function (r) {
        if (!r.model.available) return null;
        var rel = r.model.reliability, key = r.research && r.research.key;
        if (rel == null && r.model.reliability_published === false) return { soft: true, evidence: { reliability: null, published: false },
          explanation: 'This league’s model publishes no reliability score, so none is shown and none may be claimed.', remediation: 'Say nothing about reliability; never describe the read as "reliable".' };
        var thin = rel == null || rel < I.THRESHOLDS.min_reliability;
        var labelled = key === 'LIMITED_DATA' || key === 'NO_MARKET' || key === 'DATA_FAULT';
        return !thin || labelled ? null : { evidence: { reliability: rel, research_status: key },
          explanation: 'Reliability is ' + (rel == null ? 'unmeasured' : rel) + ' (under ' + I.THRESHOLDS.min_reliability + '), but the game is presented as ' + (key || 'research') + ', not as limited data.',
          remediation: 'Investigate internally; never publish a thin-data game as a reliable read.' };
      } },

    /* -------------------------------------------------------------- MARKET */
    { id: 'MKT.PRESENT', group: 'market', title: 'A market quote exists', at: at(['BETTING_DECISION'], [], ['RESEARCH_DASHBOARD', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'], 'OFF'),
      check: function (r) { return r.market.available ? null : { evidence: {}, explanation: 'No market line is joined to this game.', remediation: 'Nothing to decide on; the projection stands alone.' }; } },
    { id: 'MKT.TIMESTAMP', group: 'market', title: 'The quote has a valid capture time', at: ALL_BLOCK,
      check: function (r, ctx) {
        if (!r.market.available) return null;
        var t = ms(r.market.captured_at);
        if (t == null && r.market.reference) return null;   /* labelled a reference: MKT.FRESH says it is not a price */
        if (t == null) return { evidence: { captured_at: r.market.captured_at }, explanation: 'The market line has no capture time, so its age cannot be known.', remediation: 'Treat it as a reference line, never as a price.' };
        if (t > ctx.now + I.THRESHOLDS.future_tolerance_minutes * 60e3) return { evidence: { captured_at: r.market.captured_at }, explanation: 'The capture time is in the future: a clock fault.', remediation: 'Quarantine the quote.' };
        return null;
      } },
    { id: 'MKT.FRESH', group: 'market', title: 'The quote is current (inside the freshness window)', at: at(['BETTING_DECISION'], ['RESEARCH_DASHBOARD', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'], [], 'WARN'),
      check: function (r, ctx) {
        if (!r.market.available) return null;
        var t = ms(r.market.captured_at), age = t == null ? null : (ctx.now - t) / 60e3;
        var stale = r.market.stale === true || age == null || age > I.THRESHOLDS.stale_minutes;
        if (r.market.reference) return { evidence: { reference: true, source: r.market.source, captured_at: r.market.captured_at },
          explanation: 'The market line is a reference line' + (r.market.source ? ' (' + r.market.source + ')' : '') + ' with no book price' + (t == null ? ' or capture time' : '') + ': it can be quoted as a reference, never as a current price.',
          remediation: 'Label it as a reference line with its source; never call it current or price a decision on it.' };
        return stale ? { evidence: { captured_at: r.market.captured_at, age_minutes: age == null ? null : Math.round(age), stale_minutes: I.THRESHOLDS.stale_minutes },
          explanation: 'The market line is ' + (age == null ? 'of unknown age' : CALC.fmt.age(age)) + ', past the ' + I.THRESHOLDS.stale_minutes + '-minute freshness rule: it is the last line EdgeDesk saw, not a current price.',
          remediation: 'Label it "last captured line (stale)" with its capture time; never call it current.' } : null;
      } },
    { id: 'MKT.CURRENT_CLAIM', group: 'market', title: 'No unsupported "current price" claim', at: ALL_BLOCK,
      check: function (r, ctx) {
        var d = r.displayed || {};
        if (d.market_claim !== 'current' || !r.market.available) return null;
        var t = ms(r.market.captured_at), age = t == null ? null : (ctx.now - t) / 60e3;
        return age != null && age <= I.THRESHOLDS.stale_minutes && r.market.stale !== true ? null : { evidence: { claim: 'current', age_minutes: age == null ? null : Math.round(age) },
          explanation: 'A surface calls the market line current, but it is ' + (age == null ? 'of unknown age' : CALC.fmt.age(age)) + '.', remediation: 'Re-judge freshness at render time from the capture time.' };
      } },
    { id: 'MKT.EVENT_MATCH', group: 'market', title: 'The quote belongs to this game, in this orientation', at: ALL_BLOCK,
      check: function (r) {
        if (!r.market.available) return null;
        if (r.market.mapping_ok === false || r.market.orientation_ok === false) return { evidence: { mapping_ok: r.market.mapping_ok, orientation_ok: r.market.orientation_ok }, explanation: 'The market line could not be matched to this game, or its home/away orientation disagrees with the schedule.', remediation: 'Re-join the event by game id and team ids; re-sign the line to the schedule’s home team.' };
        return null;
      } },
    { id: 'MKT.MAIN_LINE', group: 'market', title: 'Main line compared with main line', at: ALL_BLOCK,
      check: function (r) {
        if (!r.market.available) return null;
        if (r.market.is_main_line === false) return { evidence: { is_main_line: false, market_type: r.market.market_type }, explanation: 'The comparison line is an alternate line; it cannot be compared with the model’s fair line or a main-line consensus.', remediation: 'Compare equivalent markets only: main spread vs fair spread.' };
        if (r.market.market_type && r.comparison && r.comparison.market_type && r.market.market_type !== r.comparison.market_type) return { evidence: { market_type: r.market.market_type, comparison: r.comparison.market_type }, explanation: 'Different market types are being compared.', remediation: 'Compare equivalent markets only.' };
        return null;
      } },
    { id: 'MKT.FAULT', group: 'market', title: 'No market fault', at: DASH_WARN,
      check: function (r) {
        var f = r.market.fault || (r.research && r.research.key === 'MARKET_FAULT' ? (r.research.reason || 'MARKET FAULT') : null);
        return f ? { evidence: { fault: f }, explanation: 'The market data is faulted: ' + f + ' It is not verified market consensus.', remediation: 'Quarantine for validation; keep it out of decisions and anything publisher-facing until cleared.' } : null;
      } },
    { id: 'MKT.QUARANTINE', group: 'market', title: 'No quarantined quote inside the consensus', at: DASH_WARN,
      check: function (r) {
        var q = r.market.quarantined_in_consensus || [];
        return q.length ? { evidence: { quarantined: q.slice(0, 5) }, explanation: q.length + ' quarantined quote' + (q.length === 1 ? ' is' : 's are') + ' inside the consensus.', remediation: 'Rebuild the consensus from clean quotes only.' } : null;
      } },
    { id: 'MKT.BOOK', group: 'market', title: 'A quoted price names its sportsbook', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'AI_CONTEXT'], [], 'BLOCK'),
      check: function (r) { if (!r.market.available) return null; return r.market.book || r.market.method === 'MEDIAN' || (r.market.reference && r.market.source) ? null : { evidence: { book: r.market.book, source: r.market.source }, explanation: 'The market line names no sportsbook or consensus method.', remediation: 'Attribute every quoted line to its book (or to "consensus of N books").' }; } },

    /* --------------------------------------------------------- CALCULATION */
    { id: 'CALC.GAP_RECONCILES', group: 'calculation', title: 'The displayed gap reconciles with the displayed lines', at: ALL_BLOCK,
      check: function (r) {
        var d = r.displayed || {}, c = r.comparison;
        if (!c || !c.available) return null;
        var bad = [];
        if (num(d.gap) != null && CALC.round(d.gap, 1) !== c.gap) bad.push('a gap of ' + fixed(CALC.round(d.gap, 1)) + ' is shown, but the displayed lines give ' + c.reconcile.formula);
        if (d.fair_text && d.fair_text !== c.model.text) bad.push('fair line "' + d.fair_text + '" vs "' + c.model.text + '"');
        if (d.market_text && String(d.market_text).replace(/ \(stale\)$/, '') !== c.market.text) bad.push('market "' + d.market_text + '" vs "' + c.market.text + '"');
        return bad.length ? { evidence: { displayed: { fair: d.fair_text, market: d.market_text, gap: d.gap }, canonical: { fair: c.model.text, market: c.market.text, gap: c.gap, formula: c.reconcile.formula } },
          explanation: 'What the surface shows does not reconcile: ' + bad.join('; ') + '.', remediation: 'Render the fair line, the market line and the gap from EDCalc.spreadComparison.' } : null;
      } },
    { id: 'CALC.SNAPSHOT_IDS', group: 'calculation', title: 'Model and market snapshot ids travel with the comparison', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'AI_CONTEXT'], [], 'BLOCK'),
      check: function (r) { if (!r.comparison || !r.comparison.available) return null; return r.comparison.model_snapshot_id && r.comparison.market_snapshot_id ? null : { evidence: { model: r.comparison.model_snapshot_id, market: r.comparison.market_snapshot_id }, explanation: 'The comparison cannot be traced to the two snapshots it was computed from.', remediation: 'Carry both snapshot ids.' }; } },

    /* ------------------------------------------------------------ DECISION */
    { id: 'DEC.EV_PAIR', group: 'decision', title: 'Raw and calibrated EV of one layer describe the same bet', at: DASH_WARN,
      check: function (r) {
        var e = r.ev; if (!e) return null;
        var bad = [];
        [['raw', 'calibrated'], ['quote_raw', 'quote_calibrated']].forEach(function (p) {
          if (e[p[0]] && e[p[1]]) { var pr = CALC.evPair(e[p[0]], e[p[1]]); if (!pr.comparable) bad.push(pr.reason); }
        });
        return bad.length ? { evidence: { pairs: bad }, explanation: 'Raw and calibrated EV were computed for different selections: ' + bad[0] + '.',
          remediation: 'Recompute both EVs on one selection (EDCalc.evPair).' } : null;
      } },
    /* the two EV layers (the EV engine's calibrated selection, quote EV's best
       raw quote) may legitimately choose different sides; printing them as ONE
       pair is what is wrong. WARNING everywhere; BLOCKED when a surface says it
       prints them together (displayed.ev_pair). */
    { id: 'DEC.EV_LAYERS', group: 'decision', title: 'EV figures from different layers are never printed as one bet', at: WARN_ALL,
      check: function (r) {
        var e = r.ev; if (!e || !e.quote_raw || !e.calibrated) return null;
        var x = CALC.evPair(e.quote_raw, e.calibrated);
        if (x.comparable) return null;
        var printed = !!(r.displayed && r.displayed.ev_pair);
        return { escalate: printed, evidence: { best_raw: selText(e.quote_raw.selection), raw_ev: e.quote_raw.ev, calibrated_selection: selText(e.calibrated.selection), calibrated_ev: e.calibrated.ev, printed_together: printed },
          explanation: 'The best raw quote (' + selText(e.quote_raw.selection) + ', raw ' + CALC.fmt.ev(e.quote_raw.ev) + ') and the calibrated selection (' + selText(e.calibrated.selection) + ', calibrated ' + CALC.fmt.ev(e.calibrated.ev) + ') are different bets' + (printed ? ', and a surface prints them as one.' : '; each must be shown beside its own selection.'),
          remediation: 'Print each EV beside its own selection; never "raw X% / calibrated Y%" across two selections.' };
      } },
    { id: 'DEC.CALIBRATION', group: 'decision', title: 'An actionable decision rests on a validated probability', at: at(['BETTING_DECISION'], ['RESEARCH_DASHBOARD'], [], 'WARN'),
      check: function (r) {
        var e = r.ev, d = r.decision, q = I.calibrationQuality(e && e.calibration);
        var actionable = d && /^(BET|LEAN)$/.test(String((d.bettor && d.bettor.decision) || d.key || ''));
        if (q.state === 'VALIDATED') return null;
        if (!actionable && q.state !== 'DEGENERATE') return null;
        return { evidence: { calibration_state: q.state, oof: q.oof, decision: d ? (d.bettor && d.bettor.decision) || d.key : null }, explanation: q.text + (actionable ? ' A ' + ((d.bettor && d.bettor.decision) || d.key) + ' cannot rest on it.' : ''),
          remediation: 'Present EV as research only; no BET or LEAN on an unvalidated probability.' };
      } },
    { id: 'DEC.RAW_EV_NOT_EDGE', group: 'decision', title: 'Raw model EV is never labelled an actionable edge', at: ALL_BLOCK,
      check: function (r) {
        var d = r.displayed || {}, e = r.ev;
        if (!d.edge_claim || !e) return null;
        var q = I.calibrationQuality(e.calibration), cal = e.calibrated ? e.calibrated.ev : (e.quote_calibrated ? e.quote_calibrated.ev : null);
        return q.state !== 'VALIDATED' || cal == null || cal <= 0 ? { evidence: { claim: d.edge_claim, calibrated_ev: cal, calibration: q.state }, explanation: 'A surface calls a raw model EV an edge, but ' + (cal != null && cal <= 0 ? 'the calibrated EV is ' + CALC.fmt.ev(cal) : 'the calibration is ' + q.state) + '.', remediation: 'Remove the edge claim; show raw EV only as an unvalidated research number.' } : null;
      } },
    { id: 'DEC.RESEARCH_IS_NOT_DECISION', group: 'decision', title: 'A BET comes only from the decision engine', at: ALL_BLOCK,
      check: function (r) {
        var d = r.decision; if (!d) return null;
        var cls = (d.bettor && d.bettor.decision) || d.key;
        if (cls === 'BET' && !(d.bettor || d.engine_status)) return { evidence: { decision: cls }, explanation: 'A BET without a decision-engine verdict behind it.', remediation: 'Only lib/edgedesk_decision.js may produce BET.' };
        return null;
      } }
  ];
  function selText(s) { if (!s) return '?'; return (s.side || '?') + ' ' + (num(s.line) == null ? '' : (s.line > 0 ? '+' : '') + s.line) + ' ' + (num(s.american) == null ? '' : CALC.fmt.american(s.american)) + (s.book ? ' @ ' + s.book : ''); }
  I.RULES = RULES.map(function (x) { return { id: x.id, group: x.group, title: x.title, at: x.at }; });

  var SEVERITY = { BLOCK: 'HIGH', WARN: 'MEDIUM', PASS: 'INFO' };
  var CRITICAL = { 'SCHED.REAL_EVENT': 1, 'PROJ.PROBABILITIES': 1, 'PROJ.DIRECTION': 1, 'MKT.EVENT_MATCH': 1, 'CALC.GAP_RECONCILES': 1, 'DEC.RAW_EV_NOT_EDGE': 1 };

  /* ============================================================ EVALUATE */
  I.evaluate = function (rec, boundary, ctx) {
    ctx = ctx || {};
    boundary = boundary || 'RESEARCH_DASHBOARD';
    if (BOUNDARIES.indexOf(boundary) < 0) throw new Error('unknown boundary ' + boundary);
    var c2 = { now: ctx.now == null ? Date.now() : ctx.now, current_week: ctx.current_week || null, target_week: ctx.target_week || null, champion: ctx.champion || null };
    var checks = [];
    RULES.forEach(function (rule) {
      var mode = has(rule.at, boundary) ? rule.at[boundary] : rule.at._default;
      if (mode === 'OFF') return;
      var res = null;
      try { res = rule.check(rec, c2); } catch (e) { res = { evidence: { error: String(e && e.message || e) }, explanation: 'The check could not run: ' + String(e && e.message || e) + '. Unknown is not PASS.', remediation: 'Fix the record shape.' }; }
      /* res.soft: a condition stated, never a block (an unpublished score); res.escalate: a warning that becomes a block */
      var status = res ? (res.soft ? 'WARNING' : (mode === 'BLOCK' || res.escalate ? 'BLOCKED' : 'WARNING')) : 'PASS';
      checks.push({ rule_id: rule.id, group: rule.group, title: rule.title, boundary: boundary, status: status,
        severity: status === 'PASS' ? 'INFO' : (status === 'BLOCKED' && CRITICAL[rule.id] ? 'CRITICAL' : SEVERITY[mode]),
        record: { record_id: rec.record_id, game_id: rec.game.game_id, matchup: (rec.game.away || '?') + ' @ ' + (rec.game.home || '?') },
        evidence: res ? res.evidence : null, explanation: res ? res.explanation : null, remediation: res ? res.remediation : null });
    });
    /* DECISION INTEGRITY: a fault that affects actionability caps the decision */
    if (boundary === 'BETTING_DECISION') {
      var d = rec.decision, cls = d ? ((d.bettor && d.bettor.decision) || d.key) : null;
      var faults = checks.filter(function (c) { return c.status === 'BLOCKED' && c.group !== 'decision'; });
      if (cls && /^(BET|LEAN|WATCH|WAIT)$/.test(cls) && faults.length)
        checks.push({ rule_id: 'DEC.INTEGRITY_FAULT', group: 'decision', title: 'No integrity fault under an actionable decision', boundary: boundary, status: 'BLOCKED', severity: 'CRITICAL',
          record: { record_id: rec.record_id, game_id: rec.game.game_id, matchup: (rec.game.away || '?') + ' @ ' + (rec.game.home || '?') },
          evidence: { decision: cls, faults: faults.map(function (f) { return f.rule_id; }) },
          explanation: 'The decision reads ' + cls + ' while ' + faults.map(function (f) { return f.rule_id; }).join(', ') + ' block it.', remediation: 'Show NO DECISION with the blocking rule until the fault clears.' });
    }
    var blocked = checks.filter(function (c) { return c.status === 'BLOCKED'; }), warn = checks.filter(function (c) { return c.status === 'WARNING'; });
    return { version: I.VERSION, boundary: boundary, record_id: rec.record_id, game_id: rec.game.game_id, evaluated_at: new Date(c2.now).toISOString(),
      status: blocked.length ? 'BLOCKED' : (warn.length ? 'WARNING' : 'PASS'), ok: !blocked.length,
      checks: checks, blocking: blocked, warnings: warn,
      blocking_reasons: blocked.map(function (c) { return c.rule_id + ': ' + c.explanation; }) };
  };
  /* a set of records: per-record results plus set-level rules (duplicates) */
  I.evaluateSet = function (recs, boundary, ctx) {
    var res = (recs || []).map(function (r) { return I.evaluate(r, boundary, ctx); });
    var seen = {};
    (recs || []).forEach(function (r, i) {
      var key = [String(r.game.home || '').toLowerCase(), String(r.game.away || '').toLowerCase(), r.kickoff.game_date || ''].join('|');
      var key2 = [String(r.game.away || '').toLowerCase(), String(r.game.home || '').toLowerCase(), r.kickoff.game_date || ''].join('|');
      var prev = has(seen, key) ? seen[key] : (has(seen, key2) ? seen[key2] : null);
      if (prev != null && recs[prev].game.game_id !== r.game.game_id) {
        var chk = { rule_id: 'SCHED.DUPLICATE_GAME', group: 'schedule', title: 'No accidental duplicate game', boundary: boundary, status: 'BLOCKED', severity: 'HIGH',
          record: { record_id: r.record_id, game_id: r.game.game_id, matchup: r.game.away + ' @ ' + r.game.home },
          evidence: { other_game_id: recs[prev].game.game_id, game_date: r.kickoff.game_date },
          explanation: 'The same matchup on the same date appears under two game ids (' + recs[prev].game.game_id + ', ' + r.game.game_id + ').', remediation: 'Keep the schedule’s canonical id; drop the duplicate.' };
        res[i].checks.push(chk); res[i].blocking.push(chk); res[i].status = 'BLOCKED'; res[i].ok = false; res[i].blocking_reasons.push(chk.rule_id + ': ' + chk.explanation);
      } else seen[key] = i;
    });
    var tally = { PASS: 0, WARNING: 0, BLOCKED: 0 };
    res.forEach(function (x) { tally[x.status]++; });
    return { version: I.VERSION, boundary: boundary, results: res, counts: tally };
  };

  /* the one sentence on why research status and decision differ */
  I.whyDiffer = function (researchKey, decisionClass, decisionReason) {
    var rk = researchKey || 'NONE', cls = decisionClass || 'NO_DECISION';
    if (rk === 'WORTH_RESEARCHING' && cls === 'PASS') return 'The gap is big enough to research, but the price fails the decision rules: research interest is not a profitable bet.';
    if (rk === 'WORTH_RESEARCHING' && cls === 'NO_DECISION') return 'Research compares EdgeDesk with the consensus line; the decision needs a fresh two-sided priced quote and found none, so it could not evaluate a bet.';
    if (rk === 'INVESTIGATE' && (cls === 'WATCH' || cls === 'WAIT')) return 'The gap is large but unverified; the decision layer caps anything unverified at WATCH until the data is checked.';
    if (rk === 'INVESTIGATE' && cls === 'PASS') return 'The gap is large enough to investigate but has not been verified, and the price fails the decision rules; an unverified gap is a question about the data, not a bet.';
    if ((rk === 'MARKET_ALIGNED' || rk === 'NEAR_PICKEM') && cls === 'PASS') return 'EdgeDesk agrees with the market, so there is no disagreement to price and the decision rules find nothing to approve.';
    if ((rk === 'MARKET_ALIGNED' || rk === 'NEAR_PICKEM') && (cls === 'WATCH' || cls === 'WAIT')) return 'EdgeDesk agrees with the market line; the WATCH is about one book’s price, not about a disagreement.';
    if (rk === 'NO_MARKET' && cls === 'NO_DECISION') return 'There is no current price, so there is nothing to research against and nothing to decide on.';
    if (cls === 'BET') return 'The decision engine approved this exact price; the research status describes the matchup, not the bet.';
    if (cls === 'NO_DECISION') return 'No decision was possible: ' + (decisionReason || 'essential data is missing') + '.';
    return 'Research status describes how interesting the matchup is; the decision describes whether this price passes the betting rules. They answer different questions.';
  };

  /* ================================================ TWO CLASSIFICATIONS
     Research status ("is this worth investigating?") and decision status
     ("do the decision rules approve this exact price?"), each with the rules
     that passed and failed, and one sentence on why they differ. */
  I.explainStatuses = function (rec, ctx) {
    ctx = ctx || {};
    var R = rec.research || {}, D = rec.decision || {}, c = rec.comparison || {};
    var cls = (D.bettor && D.bettor.decision) || D.key || 'NO_DECISION';
    var gap = c.available ? c.gap : null;
    var rel = rec.model.reliability, conf = rec.model.confidence;
    var rows = [];
    function row(rule, pass, detail) { rows.push({ rule: rule, pass: pass, detail: detail }); }
    row('EdgeDesk has a projection', !!rec.model.available, rec.model.available ? rec.model.version : 'none');
    row('a market line is on file', !!rec.market.available, rec.market.available ? c.market.text : 'none');
    if (rec.market.available) {
      var age = ms(rec.market.captured_at) == null ? null : ((ctx.now == null ? Date.now() : ctx.now) - ms(rec.market.captured_at)) / 60e3;
      row('the market line is current (≤ ' + I.THRESHOLDS.stale_minutes + ' min)', rec.market.stale === false && age != null && age <= I.THRESHOLDS.stale_minutes, CALC.fmt.age(age));
    }
    if (gap != null) {
      row('the gap reaches the 2-pt research threshold', gap >= 2, CALC.fmt.gap(gap) + ' (' + c.reconcile.formula + ')');
      if (gap >= 7) row('a 7+ gap passed the integrity gate', R.key === 'VERIFIED_MAJOR', R.key === 'VERIFIED_MAJOR' ? 'verified' : (R.reason || 'not verified'));
    }
    row('football confidence ≥ 35', conf != null && conf >= 35, conf == null ? 'unmeasured' : Math.round(conf) + '/100');
    row('reliability ≥ 60', rel != null && rel >= 60, rel == null ? 'unmeasured' : Math.round(rel) + '/100');
    (R.flags || []).forEach(function (f) { if (f.key === 'REGIME_CHANGE') row('no regime change blocks research', false, (f.teams || []).map(function (t) { return t.team + ' ' + t.games_played + '/' + t.min_games + ' games'; }).join('; ')); });

    var drows = [];
    function drow(rule, pass, detail) { drows.push({ rule: rule, pass: pass, detail: detail }); }
    var bettor = D.bettor || null;
    drow('a fresh two-sided priced quote', !/no fresh|stale|no market|not priced/i.test(String(D.reason || '')) && rec.market.stale === false, D.reason || null);
    var e = rec.ev, q = I.calibrationQuality(e && e.calibration);
    if (e && e.calibrated) drow('calibrated EV > 0 at this exact price', e.calibrated.ev > 0, CALC.fmt.ev(e.calibrated.ev) + ' on ' + selText(e.calibrated.selection));
    drow('the probability is validated', q.state === 'VALIDATED', q.state);
    drow('betting is enabled by policy', ctx.bet_enabled === true, ctx.bet_enabled === true ? 'enabled' : 'disabled (frozen policy)');
    var rk = R.key || 'NONE';
    var why = I.whyDiffer(rk, cls, D.reason);
    return { research: { status: rk, label: R.label || rk, rule: R.rule || null, reason: R.reason || null, rules: rows,
        means: 'How useful further investigation would be. It is never a bet signal.' },
      decision: { status: cls, label: bettor && bettor.label ? bettor.label : (D.label || cls), reason: D.reason || null, rules: drows,
        means: 'Whether the existing decision rules approve this exact market and price.' },
      why_differ: why };
  };

  /* ================================================ WHY A RAW EDGE IS REJECTED */
  I.explainEv = function (rec) {
    var e = rec && rec.ev;
    if (!e) return { text: 'No EV was computed for this game.', rejected: null };
    var raw = e.quote_raw || e.raw, cal = raw === e.quote_raw ? e.quote_calibrated : e.calibrated;
    var q = I.calibrationQuality(e.calibration);
    if (!raw) return { text: 'No raw EV: no priced quote.', rejected: null, calibration: q };
    var parts = ['Raw EV ' + CALC.fmt.ev(raw.ev) + ' on ' + selText(raw.selection) + ' comes from EdgeDesk’s own cover probability (' + CALC.fmt.prob(raw.p) + ').'];
    if (cal) parts.push('Calibrated, the same bet is ' + CALC.fmt.ev(cal.ev) + '.');
    parts.push(q.text);
    var rejected = raw.ev > 0 && (!cal || cal.ev <= 0 || q.state !== 'VALIDATED');
    if (rejected) parts.push('A raw edge the model has not shown it can earn is not an edge, so it is not actionable.');
    var pair = cal ? CALC.evPair(raw, cal) : null;
    if (pair && !pair.comparable) parts.push('(The calibrated figure on file belongs to a different selection and is not shown beside it.)');
    return { text: parts.join(' '), rejected: rejected, calibration: q, raw: raw, calibrated: cal };
  };

  /* ======================================================= BOARD COUNTS
     Every count says what it counts, and the counts reconcile. rows:
     { research_key, research_rule, market_state: 'FRESH'|'STALE'|'FAULT'|'NONE', scope } */
  I.COUNT_DEFINITIONS = {
    displayed: 'every pregame game the board lists',
    current_week: 'games in the current week (the schedule’s own week)',
    future_week: 'look-ahead games from a later week',
    market_usable: 'a current, unfaulted market line is joined',
    market_stale: 'only a line older than the freshness rule is on file',
    market_faulted: 'the joined line is faulted (MARKET FAULT / DATA FAULT): not verified consensus',
    no_market: 'no line is joined',
    research_grade: 'cleared every research gate: WORTH RESEARCHING or VERIFIED MAJOR',
    investigate: 'a 7+ point gap that has not cleared the integrity gate',
    aligned: 'MARKET ALIGNED or NEAR PICK’EM',
    limited: 'LIMITED DATA (no projection, thin confidence or reliability)'
  };
  I.countBoard = function (rows) {
    var c = { displayed: 0, current_week: 0, future_week: 0, other_week: 0, market_usable: 0, market_stale: 0, market_faulted: 0, no_market: 0,
      research_grade: 0, investigate: 0, aligned: 0, limited: 0, data_fault: 0, market_fault: 0, no_market_status: 0, kickoff_unverified: 0 };
    (rows || []).forEach(function (r) {
      c.displayed++;
      if (r.scope === 'CURRENT_WEEK') c.current_week++; else if (r.scope === 'FUTURE_WEEK') c.future_week++; else c.other_week++;
      if (r.market_state === 'FRESH') c.market_usable++; else if (r.market_state === 'STALE') c.market_stale++; else if (r.market_state === 'FAULT') c.market_faulted++; else c.no_market++;
      var k = r.research_key;
      if (k === 'WORTH_RESEARCHING' || k === 'VERIFIED_MAJOR') c.research_grade++;
      else if (k === 'INVESTIGATE') c.investigate++;
      else if (k === 'MARKET_ALIGNED' || k === 'NEAR_PICKEM') c.aligned++;
      else if (k === 'LIMITED_DATA') c.limited++;
      else if (k === 'DATA_FAULT') c.data_fault++;
      else if (k === 'MARKET_FAULT') c.market_fault++;
      else c.no_market_status++;
      if (r.kickoff_verified === false) c.kickoff_unverified++;
    });
    c.reconciles = {
      by_market: c.market_usable + c.market_stale + c.market_faulted + c.no_market === c.displayed,
      by_week: c.current_week + c.future_week + c.other_week === c.displayed,
      by_research: c.research_grade + c.investigate + c.aligned + c.limited + c.data_fault + c.market_fault + c.no_market_status === c.displayed
    };
    c.definitions = I.COUNT_DEFINITIONS;
    return c;
  };

  return I;
});
