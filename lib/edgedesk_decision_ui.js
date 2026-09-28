/* ===========================================================================
   EDGEDESK DECISION UI — the bettor-facing surfaces of the decision layer.
   docs/bettor-decision/DESIGN.md §12

   Every surface here renders the canonical decision object from
   lib/edgedesk_decision.js and nothing else. No component decides whether a
   game is actionable: it prints what the engine decided.

     LEVEL 1  WHAT DO I DO?   BET / LEAN / WATCH / PASS / NO DECISION
     LEVEL 2  WHAT EXACTLY?   side, line, price, book, units, dollars, playable to
     LEVEL 3  WHY?            calibrated EV, fair line, reliability, market, stability
     LEVEL 4  FULL RESEARCH   the existing research, below the card, untouched

   Surfaces: the action card (game pages, CFB and NFL), the compact board chip,
   the overview banner, the EDGEDESK CARD page (#card), bankroll & unit
   settings, the four-page onboarding, beginner mode, BET PLACED tracking with
   CLV, and the per-tier decision performance table.

   State (browser only): bankroll settings (lib/edgedesk_bankroll.js; local
   when signed out, public.bankroll_settings when signed in), placed bets
   (local + public.user_bets), and each game's decision track (transitions,
   first qualified, best observed) on this device. Keys use the edgedesk_
   prefix, so sign-out purges them with the rest of the device's data.

   Browser: window.EDDecisionUI. Node: require('./edgedesk_decision_ui.js')
   (the render functions are pure; the tests call them directly).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDDecisionUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_decision_ui_v1';
  function mod(name, file) {
    var m = root && root[name];
    if (!m && typeof require === 'function' && typeof module === 'object' && module.exports) { try { m = require('./' + file); } catch (e) { m = null; } }
    return m || null;
  }
  function DE() { return mod('EDDecision', 'edgedesk_decision.js'); }
  function TR() { return mod('EDDecisionTrack', 'edgedesk_decision_track.js'); }
  function BK() { return mod('EDBankroll', 'edgedesk_bankroll.js'); }

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
  function unitsShort(u) { return isNum(u) ? (Math.round(u * 100) / 100).toString().replace(/^0\./, '0.') + 'U' : '—'; }
  function money(x) { var B = BK(); return isNum(x) ? '$' + (B ? B.fmt(x) : x.toFixed(2)) : '—'; }
  function title(s) { return String(s || '').toUpperCase(); }
  function fmtTime(t, opts) {
    var v = typeof t === 'number' ? t : Date.parse(t);
    if (!isFinite(v)) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, Object.assign({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, opts || {})).format(new Date(v));
    } catch (e) { return new Date(v).toISOString().slice(11, 16) + ' UTC'; }
  }
  function fmtKick(t) {
    var v = Date.parse(t);
    if (!isFinite(v)) return '';
    try { return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(v)); } catch (e) { return new Date(v).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function tip(key, label) {
    var E = DE(), t = E && E.TOOLTIP ? E.TOOLTIP[key] : null;
    if (!t) return esc(label || '');
    return '<span class="edd-tip" tabindex="0" role="note" aria-label="' + esc((label || key) + ': ' + t) + '" data-tip="' + esc(t) + '">' + esc(label || '') + '<i aria-hidden="true">?</i></span>';
  }
  function sel(d) {
    if (!d) return null;
    if (d.decision === 'BET' && d.bet_price) return d.bet_price;
    return d.reference_quote || d.bet_price || null;
  }
  function selText(d, upper) {
    var q = sel(d);
    if (!q) return null;
    var t = (q.team || d.side || q.side || '') + ' ' + lineText(q.line);
    return upper ? title(t) : t;
  }
  var TONE = { BET: 'bet', LEAN: 'lean', WATCH: 'watch', WAIT: 'watch', PASS: 'pass', NO_DECISION: 'none' };
  function kind(d) { return d && d.decision === 'WAIT' ? 'WATCH' : (d ? d.decision : null); }
  var SRC_SHORT = { calibrated: 'Calibrated', partially_calibrated: 'Partially calibrated', model_estimated: 'Model-estimated' };
  var MQ_LABEL = { VERIFIED: 'Verified', STRONG: 'Strong', ACCEPTABLE: 'Acceptable', THIN: 'Thin', INVALID: 'Invalid' };
  var STAB_LABEL = { HIGH: 'Stable', MEDIUM: 'Moderate', LOW: 'Unstable', UNMEASURED: 'Unmeasured' };
  var BANNED = /\b(lock|max lock|free money|can'?t miss|mortgage|guarantee[ds]?|safe bet|this will win|best bet|bet now|smash|hammer)\b/i;
  function copyOk(html) { return !BANNED.test(String(html || '').replace(/<[^>]+>/g, ' ')); }

  /* ================================================================ STATE */
  var KEYS = { placed: 'edgedesk_bets_placed_v1', tracks: 'edgedesk_decision_tracks_v1', onboarded: 'edgedesk_decision_onboarded_v1', card: 'edgedesk_card_view_v1' };
  var S = { settings: null, placed: null, tracks: null, registry: {}, card: null, build: null, buildErr: null, buildP: null, record: {}, recordP: {}, host: null, remoteLoaded: false };
  function probPct(x) { return isNum(x) ? (100 * x).toFixed(1) + '%' : '—'; }
  function ppTxt(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + ' pp' : '—'; }
  function store() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
  function readKey(k, dflt) { try { var st = store(); var v = st ? st.getItem(k) : null; return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function writeKey(k, v) { try { var st = store(); if (st) st.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable: keep in memory */ } }
  function settings() { if (!S.settings) S.settings = BK() ? BK().load() : {}; return S.settings; }
  function signedIn() { try { return !!(root.edUser && root.edUser()); } catch (e) { return false; } }
  function saveSettings(s) {
    var B = BK();
    S.settings = B ? B.save(s) : s;
    if (signedIn() && typeof root.sbUpsert === 'function' && B) {
      try { var p = root.sbUpsert('bankroll_settings?on_conflict=user_id', [B.toRow(S.settings)]); if (p && p.catch) p.catch(function () {}); } catch (e) { /* the local copy still applies */ }
    }
    return S.settings;
  }
  function loadRemoteSettings() {
    if (S.remoteLoaded || !signedIn() || typeof root.sbGet !== 'function' || !BK()) return;
    S.remoteLoaded = true;
    try {
      var p = root.sbGet('bankroll_settings?select=bankroll_amount,base_unit_amount,unit_mode,unit_percent,max_active_exposure_units,exposure_limit_enabled,beginner_mode&limit=1');
      if (p && p.then) p.then(function (rows) { var row = rows && rows[0]; if (row) { S.settings = BK().save(BK().fromRow(row)); repaint(); } }).catch(function () {});
    } catch (e) { /* signed-out behaviour */ }
  }
  function tracks() { if (!S.tracks) S.tracks = readKey(KEYS.tracks, {}); return S.tracks; }
  function placed() { if (!S.placed) S.placed = readKey(KEYS.placed, []); return S.placed; }
  function cardView() { if (!S.card) S.card = readKey(KEYS.card, { filter: 'all', sort: 'kickoff', showPass: false, showNone: false, showLean: true }); return S.card; }
  function beginner() { return !!settings().beginner_mode; }

  /* a live decision the page just computed: its track on this device moves
     forward (append-only), and the card page sees it */
  function observe(d) {
    if (!d || !d.game_id) return null;
    S.registry[d.game_id] = d;
    var T = TR(); if (!T) return null;
    var all = tracks(), prev = all[d.game_id] || null;
    var cur = prev && prev.current ? prev.current : null;
    var same = cur && cur.decision === d.decision && cur.reason_code === d.action_reason_code && (!sel(d) || (cur.line === sel(d).line && cur.odds === sel(d).odds && cur.book === sel(d).book)) && (cur.units || 0) === (d.recommended_units || 0);
    /* an unchanged decision only refreshes "last evaluated" in memory; the
       device store is written when the track actually moves */
    if (same) { prev.last_evaluated = d.evaluated_at; return prev; }
    all[d.game_id] = T.track(prev, d);
    /* the store is bounded: games whose kickoff passed more than a week ago leave it */
    var cut = Date.now() - 7 * 864e5;
    Object.keys(all).forEach(function (k) { var ko = Date.parse(all[k].kickoff); if (isFinite(ko) && ko < cut) delete all[k]; });
    S.tracks = all; writeKey(KEYS.tracks, all);
    return all[d.game_id];
  }
  function trackFor(gid) { return tracks()[String(gid)] || null; }
  /* the previous decision, for the engine's transition logic (PRICE MOVED, QUOTE REFRESH) */
  function previous(gid) {
    var t = trackFor(gid); if (!t || !t.current) return null;
    var c = t.current;
    return { decision: c.decision, action_reason_code: c.reason_code, recommended_units: c.units || 0, evaluated_at: c.at,
      bet_price: c.decision === 'BET' ? { side: c.side, line: c.line, odds: c.odds, book: c.book } : null,
      reference_quote: c.decision !== 'BET' && c.line != null ? { side: c.side, line: c.line, odds: c.odds, book: c.book } : null };
  }

  /* ==================================================== THE ACTION CARD */
  function dollarsLine(d) {
    var B = BK(); if (!B || d.decision !== 'BET') return '';
    var s = settings(), uv = B.unitValue(s), dl = B.dollars(d.recommended_units, s);
    if (dl == null) return '<div class="edd-money edd-money-unset"><button type="button" class="edd-link" data-edd-act="bankroll">Set your bankroll</button> to see this in dollars.</div>';
    return '<div class="edd-money"><b>' + money(dl) + '</b> <small>based on your ' + money(uv.unit) + ' unit</small></div>';
  }
  function playableBlock(d) {
    var P = d.playable; if (!P) return '';
    var body = P.mode === 'CURRENT_PRICE_ONLY' ? '<b>CURRENT PRICE ONLY</b>'
      : '<b>' + esc(lineText(P.min_line)) + '</b> · max <b>' + esc(priceText(P.max_odds)) + '</b>'
        + (Math.abs(P.min_line - d.selected_line) > EPS && isNum(P.at_current_line_max_odds) ? ' <small>(at ' + esc(lineText(d.selected_line)) + ': up to ' + esc(priceText(P.at_current_line_max_odds)) + ')</small>' : '');
    return '<div class="edd-playable"><span class="edd-k">' + tip('playable_to', 'PLAYABLE TO') + '</span> ' + body + '</div>';
  }
  function metric(label, value, key, cls) {
    return '<div class="edd-m' + (cls ? ' ' + cls : '') + '"><div class="edd-mk">' + (key ? tip(key, label) : esc(label)) + '</div><div class="edd-mv">' + value + '</div></div>';
  }
  function metricsGrid(d, compact) {
    var E = DE(), strength = d.strength && E && E.STRENGTH[d.strength] ? E.STRENGTH[d.strength].label : null;
    var cells = [];
    if (d.decision === 'BET') cells.push(metric('STAKE TIER', esc(strength || '—'), 'edge_strength'));
    cells.push(metric('DECISION CONFIDENCE', isNum(d.decision_confidence) ? esc(d.decision_confidence) + ' <small>/ 100 · ' + esc(d.decision_confidence_label || '') + '</small>' : '—', 'decision_confidence'));
    cells.push(metric('PROBABILITY', esc(SRC_SHORT[d.probability_source] || '—'), 'probability_source', d.probability_source === 'model_estimated' ? 'dim' : ''));
    cells.push(metric('MODEL COVER', esc(probPct(d.probability)), 'cover_probability'));
    cells.push(metric('BREAK-EVEN', esc(probPct(d.break_even))));
    cells.push(metric('EDGE', esc(ppTxt(d.edge_pp)), null, isNum(d.edge_pp) && d.edge_pp > 0 ? 'pos' : ''));
    cells.push(metric('RAW EV', esc(pctText(d.raw_ev_pct)), 'raw_ev', 'dim'));
    cells.push(metric('CALIBRATED EV', esc(pctText(d.calibrated_ev_pct)), 'calibrated_ev', isNum(d.calibrated_ev_pct) && d.calibrated_ev_pct >= 0 ? 'pos' : ''));
    cells.push(metric('MODEL FAIR', esc(d.model_fair_text || '—'), 'model_fair'));
    if (!compact) {
      cells.push(metric('RELIABILITY', isNum(d.reliability_score) ? esc(Math.round(d.reliability_score)) + ' <small>/ 100</small>' : '<small>unmeasured</small>', 'reliability'));
      cells.push(metric('MARKET', esc(MQ_LABEL[d.market_quality] || '—'), 'market_quality'));
      cells.push(metric('PROJECTION', esc(STAB_LABEL[d.projection_stability] || '—')));
    }
    return '<div class="edd-grid">' + cells.join('') + '</div>';
  }
  function priceTypes(d) {
    var rows = [];
    var q = sel(d);
    if (d.best_available) rows.push(['BEST AVAILABLE', esc(d.best_available.label) + ' <small>' + esc(d.best_available.book || '') + '</small>', 'best_available']);
    if (d.consensus_text) rows.push(['CONSENSUS', esc(d.consensus_text), 'consensus']);
    if (d.decision === 'BET' && q) rows.push(['EDGEDESK BET PRICE', esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ') <small>' + esc(q.book || '') + '</small>', 'bet_price']);
    if (d.decision === 'BET' && d.playable) rows.push(['PLAYABLE TO', esc(d.playable.text), 'playable_to']);
    if (d.best_price && (!q || d.best_price.book !== q.book || d.best_price.odds !== q.odds)) rows.push(['BEST PRICE', esc(d.best_price.label) + ' <small>' + esc(d.best_price.book || '') + '</small>', 'best_price']);
    if (d.model_fair_text) rows.push(['MODEL FAIR', esc(d.model_fair_text), 'model_fair']);
    if (!rows.length) return '';
    return '<div class="edd-prices">' + rows.map(function (r) { return '<div class="edd-pr"><span>' + tip(r[2], r[0]) + '</span><span>' + r[1] + '</span></div>'; }).join('') + '</div>';
  }
  function alternativesBlock(d) {
    var A = d.alternatives; if (!A) return '';
    var rows = [];
    function row(k, q, why) { if (q) rows.push('<div class="edd-alt"><span class="edd-k">' + k + '</span> ' + esc(q.label) + ' <small>' + esc(q.book || '') + ' · edge ' + esc(ppTxt(q.edge_pp)) + ' · EV ' + esc(pctText(100 * (isNum(q.decision_ev) ? q.decision_ev : (q.raw_ev || 0)))) + ' · cover ' + esc(probPct(isNum(q.decision_cover) ? q.decision_cover : q.cover_probability)) + (why ? ' · ' + why : '') + '</small></div>'); }
    row('BEST VALUE', A.best_value, 'best risk-adjusted EV');
    row('SAFER VALUE', A.safer, 'lower variance, still positive EV');
    row('BEST PRICE', A.best_price, 'best book at this exact line');
    row('MAIN', A.main, 'the consensus number');
    row('MAX EV', A.better_value, 'highest EV — not the recommendation');
    if (!rows.length) return '';
    return '<div class="edd-sub"><div class="edd-subh">LINES EVALUATED <small>' + esc(A.n_evaluated) + ' quotes · ' + esc(A.n_alternates) + ' alternates</small></div>' + rows.join('') + '<div class="edd-note">' + esc(A.note) + '</div></div>';
  }
  function otherMarketsBlock(d) {
    var M = d.markets; if (!M) return '';
    var rows = [];
    ['spread', 'total', 'moneyline'].forEach(function (k) {
      var m = M[k]; if (!m || k === d.market_type) return;
      rows.push('<div class="edd-pr"><span>' + esc(k.toUpperCase()) + '</span><span><b>' + esc(m.display || m.label || m.decision) + '</b>' + (m.selection ? ' ' + esc(m.selection) + (m.book ? ' <small>' + esc(m.book) + '</small>' : '') : '') + ' <small>' + esc(m.reason || '') + '</small></span></div>');
    });
    if (!rows.length) return '';
    return '<div class="edd-sub"><div class="edd-subh">OTHER MARKETS <small>each decided on its own</small></div>' + rows.join('') + '</div>';
  }
  function trackBlock(d, t) {
    if (!t) return '';
    var rows = [];
    function q(x) { return x ? esc(lineText(x.line)) + ' (' + esc(priceText(x.odds)) + ')' + (x.book ? ' <small>' + esc(x.book) + '</small>' : '') : '—'; }
    if (t.first_qualified) rows.push(['First qualified', q(t.first_qualified) + ' <small>' + esc(fmtTime(t.first_qualified.at)) + '</small>']);
    if (t.best_observed) rows.push(['Best observed', q(t.best_observed)]);
    if (t.current && t.current.line != null) rows.push(['Current', q(t.current)]);
    if (d.decision === 'BET' && d.playable) rows.push(['Playable to', esc(lineText(d.playable.min_line)) + ' (' + esc(priceText(d.playable.max_odds)) + ')']);
    rows.push(['Current status', esc(d.decision_label)]);
    rows.push(['Last evaluated', esc(fmtTime(d.evaluated_at))]);
    if (t.closing) rows.push(['Closing price', esc(lineText(t.closing.line)) + (isNum(t.first_qualified_clv_points) ? ' <small>CLV ' + esc((t.first_qualified_clv_points >= 0 ? '+' : '') + t.first_qualified_clv_points.toFixed(1)) + ' pts</small>' : '')]);
    var tr = (t.transitions || []).filter(function (x) { return x.from; }).slice(-4).reverse();
    var trH = tr.length ? '<div class="edd-subh">CHANGES</div>' + tr.map(function (x) {
      return '<div class="edd-tr"><span class="edd-trw">' + esc(fmtTime(x.at)) + '</span> <b>' + esc(x.from + ' → ' + x.to) + '</b> <small>' + esc(x.text || '') + '</small></div>'; }).join('') : '';
    return '<div class="edd-sub"><div class="edd-subh">RECOMMENDATION HISTORY</div>' + rows.map(function (r) { return '<div class="edd-pr"><span>' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>'; }).join('') + trH + '</div>';
  }
  function auditBlock(d) {
    var parts = [];
    if (d.sizing && d.sizing.tiers) parts.push('<div class="edd-subh">STAKE TIERS</div>' + d.sizing.tiers.map(function (t) {
      return '<div class="edd-tier ' + (t.allowed ? 'ok' : '') + '"><b>' + esc(unitsText(t.units)) + '</b> ' + esc(t.key || '') + ' ' + (t.allowed ? 'clears' : esc(t.why.join('; '))) + '</div>'; }).join('')
      + (d.sizing.caps && d.sizing.caps.length ? '<div class="edd-note">Capped: ' + esc(d.sizing.caps.join('; ')) + '</div>' : '')
      + '<div class="edd-note">Raw EV never enters sizing · no result-based adjustment · never above 1.00U.</div>');
    if ((d.caps || []).length) parts.push('<div class="edd-subh">WHAT LIMITS IT</div>' + d.caps.map(function (c) { return '<div class="edd-tier"><b>' + esc(c.max) + '</b> ' + esc(c.text) + '</div>'; }).join(''));
    if (d.decision_confidence_detail && d.decision_confidence_detail.components) {
      var C = d.decision_confidence_detail.components;
      parts.push('<div class="edd-subh">DECISION CONFIDENCE ' + esc(d.decision_confidence) + '/100</div><div class="edd-note">' + Object.keys(C).map(function (k) { return esc(k.replace(/_/g, ' ')) + ' ' + Math.round(100 * C[k]); }).join(' · ')
        + (d.decision_confidence_detail.notes && d.decision_confidence_detail.notes.length ? ' — ' + esc(d.decision_confidence_detail.notes.join('; ')) : '') + '</div>');
    }
    if (d.anomaly && d.anomaly.triggered) parts.push('<div class="edd-subh">PRICE VERIFICATION</div><div class="edd-note">' + esc(d.anomaly.triggers.map(function (x) { return x.text; }).join(' · ')) + '</div>'
      + d.anomaly.checks.map(function (c) { return '<div class="edd-tier ' + (c.status === 'PASS' ? 'ok' : '') + '"><b>' + esc(c.status) + '</b> ' + esc(c.code.replace(/_/g, ' ').toLowerCase()) + ' <small>' + esc(c.text || '') + '</small></div>'; }).join(''));
    var C2 = d.canonical;
    if (C2 && C2.orientation && ((C2.orientation.repairs || []).length || (C2.orientation.dropped || []).length)) parts.push('<div class="edd-subh">ORIENTATION</div>' + (C2.orientation.repairs || []).concat(C2.orientation.dropped || []).slice(0, 6).map(function (x) { return '<div class="edd-note">· ' + esc(x.code.replace(/_/g, ' ').toLowerCase()) + ': ' + esc(x.quote || '') + ' — ' + esc(x.text || '') + '</div>'; }).join(''));
    var v = (d.warnings || []).filter(function (w) { return w.code !== 'RULES_UNVALIDATED'; });
    if (v.length) parts.push('<div class="edd-subh">WARNINGS</div>' + v.map(function (w) { return '<div class="edd-note">· ' + esc(w.text) + '</div>'; }).join(''));
    parts.push('<div class="edd-note edd-ver">reasons ' + esc((d.reasons || []).join(', ') || '—') + (d.blocker_codes && d.blocker_codes.length ? ' · blockers ' + esc(d.blocker_codes.join(', ')) : '') + '</div>');
    parts.push('<div class="edd-note edd-ver">engine ' + esc(d.decision_engine_version) + ' · config ' + esc(d.config_version) + ' · model ' + esc(d.model_version || '—') + ' · calibration ' + esc(d.calibration_version || 'none') + ' · decision ' + esc(d.decision_id || '') + '</div>');
    return '<div class="edd-sub">' + parts.join('') + '</div>';
  }
  function transitionLine(t) {
    var x = t && t.transitions ? t.transitions.filter(function (y) { return y.from; }).slice(-1)[0] : null;
    if (!x) return '';
    return '<div class="edd-changed"><span class="edd-k">CHANGED ' + esc(fmtTime(x.at)) + '</span> <b>' + esc(x.from + ' → ' + x.to) + '</b> <small>' + esc(x.text || '') + '</small></div>';
  }
  function placedBlock(d) {
    var list = placed().filter(function (b) { return String(b.game_id) === String(d.game_id); });
    if (!list.length) return '';
    var T = TR();
    return '<div class="edd-sub edd-placed"><div class="edd-subh">YOUR BETS</div>' + list.map(function (b) {
      var c = T ? T.compareEntry(b, b.recommendation) : null;
      var g = gradePlaced(b);
      return '<div class="edd-pb"><div class="edd-pr"><span>YOUR PRICE</span><span>' + esc((b.team || '') + ' ' + lineText(b.line)) + ' (' + esc(priceText(b.odds)) + ') <small>' + esc(b.book || '') + ' · ' + esc(unitsText(b.units)) + (isNum(b.stake_dollars) ? ' · ' + money(b.stake_dollars) : '') + '</small></span></div>'
        + (c && c.edgedesk_line != null ? '<div class="edd-pr"><span>EDGEDESK PRICE</span><span>' + esc(lineText(c.edgedesk_line)) + ' (' + esc(priceText(c.edgedesk_odds)) + ')</span></div><div class="edd-pr"><span>PLAYABLE TO</span><span>' + esc(lineText(c.playable_line)) + ' (' + esc(priceText(c.playable_odds)) + ')</span></div>' : '')
        + (c ? '<div class="edd-pr"><span>YOUR ENTRY</span><span class="' + (c.status === 'OUTSIDE_RANGE' ? 'edd-warn' : '') + '">' + esc(c.status === 'OUTSIDE_RANGE' ? 'Outside EdgeDesk range' : (c.status === 'INSIDE_RANGE' ? 'Inside EdgeDesk range' : (c.status === 'AT_EDGEDESK_PRICE' ? 'At EdgeDesk’s price' : c.text))) + '</span></div>' : '')
        + (g && g.clv_points != null ? '<div class="edd-pr"><span>CLV</span><span>You bet ' + esc(lineText(b.line)) + ' · closed ' + esc(lineText(g.close_line)) + ' · <b>' + esc((g.clv_points >= 0 ? '+' : '') + g.clv_points.toFixed(1)) + ' pts</b></span></div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }
  /* WATCH's first sentence: what the opportunity is, never that it will win */
  function waitLead(d) {
    var s = selText(d);
    if (!s) return 'A potential opportunity is on EdgeDesk’s watch list.';
    if (d.action_reason_code === 'PRICE_ANOMALY') return s + ': the price looks anomalous and must pass verification first.';
    if (isNum(d.model_market_gap) && d.model_market_gap >= 7) return s + ' currently shows a major model-market disagreement.';
    if (d.action_reason_code === 'NEAR_THRESHOLD' || d.action_reason_code === 'MODEL_MARKET_DISAGREEMENT') return s + ' is interesting but the current price is not yet a bet.';
    return s + ' may qualify once the open information resolves.';
  }
  function exactLines(d) {
    var A = d.action; if (!A || !A.lines || !A.lines.length) return '';
    return '<ul class="edd-exact">' + A.lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
  }
  function triggerBlock(d, label) {
    var t = d.watch && d.watch.trigger ? d.watch.trigger : (d.bet_trigger ? d.bet_trigger.text : null);
    if (!t) return '';
    return '<div class="edd-trigger"><span class="edd-k">' + tip('bet_trigger', label || 'BET TRIGGER') + '</span> ' + esc(t) + '</div>';
  }
  function qualChip(d) { return d.decision_qualifier ? ' <span class="edd-qual">' + esc(d.decision_qualifier) + '</span>' : ''; }
  function actionCardHTML(d, opts) {
    opts = opts || {};
    if (!d) return '';
    var E = DE(), K = kind(d), tone = TONE[K] || 'none';
    var begin = opts.beginner != null ? !!opts.beginner : beginner();
    var compact = !!opts.compact || !!opts.mobile;
    var t = opts.track !== undefined ? opts.track : trackFor(d.game_id);
    var q = sel(d);
    var h = '<section class="edd-act edd-' + tone + (begin ? ' edd-begin' : '') + (compact ? ' edd-compact' : '') + '" data-edd-game="' + esc(d.game_id) + '" aria-label="EdgeDesk action: ' + esc(d.decision_display || d.decision_label) + '">';
    h += '<header class="edd-h"><span class="edd-k">EDGEDESK ACTION' + (d.sport ? ' · ' + esc(d.sport) : '') + '</span><span class="edd-when" title="' + esc(d.evaluated_at || '') + '">Last evaluated ' + esc(fmtTime(d.evaluated_at)) + (d.provisional ? ' · provisional (calibration loading)' : '') + '</span></header>';
    /* LEVEL 1: the exact action */
    if (K === 'BET') {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-bet">BET</span> <span class="edd-units">· ' + esc(unitsShort(d.recommended_units)) + '</span>' + qualChip(d) + '</div>';
      h += '<div class="edd-sel">' + esc(selText(d, true)) + '</div>';
      h += '<div class="edd-price">' + esc(priceText(q.odds)) + ' · ' + esc(q.book || '') + (d.selected_is_alternate ? ' · <small>alternate line</small>' : '') + '</div>';
      h += dollarsLine(d);
      h += exactLines(d);
      h += playableBlock(d);
    } else if (K === 'LEAN') {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-lean">LEAN</span> <span class="edd-sub1">0U · informational</span>' + qualChip(d) + '</div>';
      if (q) h += '<div class="edd-sel edd-sel-quiet">' + esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ')' + (q.book ? ' <small>' + esc(q.book) + '</small>' : '') + '</div>';
      h += exactLines(d);
      h += triggerBlock(d);
    } else if (K === 'WATCH') {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-watch">WATCH</span>' + qualChip(d) + ' <span class="edd-dnb">DO NOT BET YET</span></div>';
      if (q) h += '<div class="edd-sel edd-sel-quiet">' + esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ')' + (q.book ? ' <small>' + esc(q.book) + '</small>' : '') + '</div>';
      h += '<p class="edd-lead">' + esc(waitLead(d)) + '</p>';
      h += triggerBlock(d);
      if ((d.waiting_on || []).length) h += '<div class="edd-waiting"><span class="edd-k">WAITING ON</span><ul>' + d.waiting_on.map(function (w) { return '<li>' + esc(w.text.charAt(0).toUpperCase() + w.text.slice(1)) + '</li>'; }).join('') + '</ul></div>';
    } else if (K === 'PASS') {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-pass">PASS</span> <span class="edd-sub1">Current price does not justify a wager.</span></div>';
      if (q) h += '<div class="edd-sel edd-sel-quiet">' + esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ')' + (q.book ? ' <small>' + esc(q.book) + '</small>' : '') + '</div>';
      h += '<div class="edd-reason1"><span class="edd-k">WHY</span> ' + esc(d.action_reason_text) + '</div>';
    } else {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-none">NO DECISION</span></div>';
      h += '<p class="edd-lead">' + esc(d.action_reason_text) + '</p>';
      if ((d.blocker_codes || []).length) h += '<div class="edd-reason1"><span class="edd-k">BLOCKER</span> ' + esc(d.blocker_codes.join(', ')) + ' <small>essential data is missing or invalid — EdgeDesk cannot evaluate this wager</small></div>';
    }
    if (begin) h += '<div class="edd-why1"><span class="edd-k">WHY</span> ' + esc(E ? E.oneSentence(d) : d.action_reason_text) + '</div>';
    var reason = '';
    if (K === 'NO_DECISION') {
      if (d.model_fair_text) reason += '<div class="edd-pr"><span>Model projection</span><span>' + esc(d.model_fair_text) + '</span></div>';
      if (d.consensus_text) reason += '<div class="edd-pr"><span>Last known market</span><span>' + esc(d.consensus_text) + ' <small>not evaluable now: ' + esc((d.blocker_codes || []).join(', ').replace(/_/g, ' ').toLowerCase()) + '</small></span></div>';
    } else {
      reason += metricsGrid(d, compact);
      reason += '<div class="edd-why"><div class="edd-subh">' + (K === 'BET' ? 'WHY IT QUALIFIES' : (K === 'PASS' ? 'WHY PASS' : 'WHY')) + '</div><p>' + esc(E && E.whyText ? E.whyText(d) : d.action_reason_text) + '</p></div>';
      if (K === 'BET') reason += '<div class="edd-cancel"><div class="edd-subh">WHAT CANCELS IT</div><ul>' + (d.invalidation_conditions || []).map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
      if (K === 'PASS' && d.bet_trigger) reason += '<div class="edd-why"><div class="edd-subh">BET TRIGGER</div><p>' + esc(d.bet_trigger.text) + '</p><div class="edd-note">' + esc(d.bet_trigger.caveat) + '</div></div>';
      if (K === 'WATCH' && d.next_check) reason += '<div class="edd-why"><div class="edd-subh">NEXT CHECK</div><p>' + esc(d.next_check) + '</p></div>';
      if (K !== 'BET') reason += '<div class="edd-note">No unit recommendation.</div>';
    }
    reason += priceTypes(d);
    reason += otherMarketsBlock(d);
    var deeper = alternativesBlock(d) + trackBlock(d, t) + placedBlock(d) + auditBlock(d);
    var openReason = !begin && !compact;
    h += '<details class="edd-reason"' + (openReason ? ' open' : '') + '><summary>' + (begin ? 'Show reasoning' : 'View reasoning') + '</summary>' + reason
      + '<details class="edd-deep"><summary>Prices, history and audit</summary>' + deeper + '</details></details>';
    h += transitionLine(t);
    h += '<div class="edd-acts">'
      + (K === 'BET' ? '<button type="button" class="edd-btn edd-btn-bet" data-edd-act="placed" data-edd-gid="' + esc(d.game_id) + '">BET PLACED</button>' : '')
      + '<button type="button" class="edd-btn" data-edd-act="research" data-edd-gid="' + esc(d.game_id) + '">VIEW FULL RESEARCH ↓</button>'
      + '<button type="button" class="edd-btn edd-btn-quiet" data-edd-act="card">EdgeDesk Card</button></div>';
    h += '<div class="edd-valid">' + tip('validation', 'Decision rules: conservative defaults · not yet validated on live results') + (d.probability_source ? ' · ' + tip('probability_source', 'probability ' + (SRC_SHORT[d.probability_source] || '').toLowerCase()) : '') + ' · ' + tip('bet_decision', 'Bet decision') + ' ≠ ' + tip('research_status', 'research status') + (d.research_label ? ' (' + esc(d.research_label) + ')' : '') + '</div>';
    h += '<div class="edd-form" data-edd-form="' + esc(d.game_id) + '"></div>';
    h += '</section>';
    return h;
  }
  /* the compact chip a board row carries */
  function chipHTML(d) {
    if (!d) return '';
    var K = kind(d), tone = TONE[K] || 'none', q = sel(d);
    var lbl = K === 'BET' ? 'BET · ' + unitsShort(d.recommended_units) : (K === 'WATCH' ? 'WATCH' : d.decision_label);
    var extra = K === 'BET' && q ? ' ' + (q.team || '') + ' ' + lineText(q.line) + ' (' + priceText(q.odds) + ')' + (d.playable ? ' · to ' + d.playable.short : '')
      : (K === 'WATCH' ? ' · do not bet yet' + (d.decision_qualifier ? ' · ' + d.decision_qualifier.toLowerCase() : '') : (K === 'LEAN' && q ? ' ' + (q.team || '') + ' ' + lineText(q.line) + ' · 0U' : ''));
    return '<span class="edd-chip edd-c-' + tone + '" title="' + esc(d.action_reason_text || '') + '"><b>' + esc(lbl) + '</b>' + esc(extra) + '</span>';
  }

  /* ====================================================== THE CARD PAGE */
  function mergedDecisions() {
    var by = {};
    ((S.build && S.build.decisions) || []).forEach(function (d) { by[d.game_id] = d; });
    Object.keys(S.registry).forEach(function (k) {
      var d = S.registry[k], b = by[k];
      if (!b || Date.parse(d.evaluated_at) >= Date.parse(b.evaluated_at)) by[k] = d;
    });
    var now = Date.now();
    return Object.keys(by).map(function (k) { return by[k]; }).filter(function (d) { var ko = Date.parse(d.kickoff); return !isFinite(ko) || ko > now; });
  }
  function summary(list) {
    list = list || mergedDecisions();
    var c = { BET: 0, LEAN: 0, WATCH: 0, PASS: 0, NO_DECISION: 0 }, last = null;
    list.forEach(function (d) { var k = kind(d); c[k] = (c[k] || 0) + 1; var e = Date.parse(d.evaluated_at); if (isFinite(e) && (last == null || e > last)) last = e; });
    var tz = (function () { try { return -new Date().getTimezoneOffset(); } catch (e) { return 0; } })();
    var ex = BK() ? BK().exposure(list, settings(), { tz_offset_minutes: tz }) : { total_units: 0, total_dollars: null };
    return { counts: c, n: list.length, total_units: ex.total_units, total_dollars: ex.total_dollars, last_evaluated: last != null ? new Date(last).toISOString() : null, exposure: ex };
  }
  var FILTERS = [['all', 'All'], ['bets', 'Bets'], ['leans', 'Leans'], ['watching', 'Watching'], ['pass', 'Pass'], ['none', 'No decision'], ['nfl', 'NFL'], ['cfb', 'CFB'], ['u25', '0.25U'], ['u50', '0.50U'], ['u75', '0.75U'], ['u100', '1.00U']];
  var SORTS = [['kickoff', 'Kickoff'], ['strength', 'Strongest qualified edge'], ['confidence', 'Decision confidence'], ['cal_ev', 'Calibrated EV'], ['changed', 'Latest change'], ['movement', 'Line movement']];
  function passes(d, f) {
    if (f === 'bets') return d.decision === 'BET';
    if (f === 'leans') return d.decision === 'LEAN';
    if (f === 'watching') return kind(d) === 'WATCH';
    if (f === 'pass') return d.decision === 'PASS';
    if (f === 'none') return d.decision === 'NO_DECISION';
    if (f === 'nfl') return d.sport === 'NFL';
    if (f === 'cfb') return d.sport === 'CFB';
    var u = { u25: 0.25, u50: 0.5, u75: 0.75, u100: 1 }[f];
    if (u != null) return d.decision === 'BET' && Math.abs(d.recommended_units - u) < EPS;
    return true;
  }
  function sorter(key) {
    var SR = { MAX: 4, STRONG: 3, STANDARD: 2, SMALL: 1, VERY_STRONG: 3, QUALIFIED: 1 };
    return function (a, b) {
      if (key === 'strength') return ((b.recommended_units || 0) - (a.recommended_units || 0)) || ((SR[b.tier || b.strength] || 0) - (SR[a.tier || a.strength] || 0)) || ((num(b.edge_pp) || -99) - (num(a.edge_pp) || -99)) || ((num(b.calibrated_ev_pct) || -99) - (num(a.calibrated_ev_pct) || -99));
      if (key === 'confidence') return (num(b.decision_confidence) || -1) - (num(a.decision_confidence) || -1);
      if (key === 'cal_ev') return (num(b.calibrated_ev_pct) == null ? -1e9 : b.calibrated_ev_pct) - (num(a.calibrated_ev_pct) == null ? -1e9 : a.calibrated_ev_pct);
      if (key === 'changed') { var ta = trackFor(a.game_id), tb = trackFor(b.game_id); return (Date.parse(tb && tb.last_changed) || 0) - (Date.parse(ta && ta.last_changed) || 0); }
      if (key === 'movement') return Math.abs(num(b.market_movement_pts) || 0) - Math.abs(num(a.market_movement_pts) || 0);
      return (Date.parse(a.kickoff) || 0) - (Date.parse(b.kickoff) || 0);
    };
  }
  function matchup(d) { return esc((d.away || '') + ' @ ' + (d.home || '')) + ' <small>' + esc(d.sport || '') + ' · ' + esc(fmtKick(d.kickoff)) + '</small>'; }
  function betRow(d) {
    var q = sel(d), B = BK(), dl = B ? B.dollars(d.recommended_units, settings()) : null;
    return '<div class="edd-row edd-r-bet" data-edd-open="' + esc(d.game_id) + '" data-edd-sport="' + esc(d.sport) + '">'
      + '<div class="edd-r1"><span class="edd-units">' + esc(unitsText(d.recommended_units)) + '</span> <b>' + esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ')</b> <small>' + esc(q.book || '') + '</small>'
      + (dl != null ? ' <span class="edd-dl">' + money(dl) + '</span>' : '') + '</div>'
      + '<div class="edd-r2">Playable to: <b>' + esc(d.playable ? d.playable.short : 'current price only') + '</b> · Edge ' + esc(ppTxt(d.edge_pp)) + ' · EV ' + esc(pctText(d.decision_ev_pct)) + ' · Confidence ' + esc(isNum(d.decision_confidence) ? d.decision_confidence : '—')
      + (d.strength && DE().STRENGTH[d.strength] ? ' · ' + esc(DE().STRENGTH[d.strength].label) : '') + (d.probability_source ? ' · ' + esc(SRC_SHORT[d.probability_source] || '') : '') + '</div>'
      + '<div class="edd-r3">' + matchup(d) + '</div></div>';
  }
  function otherRow(d) {
    var q = sel(d), s = selText(d);
    var K = kind(d);
    var why = K === 'WATCH' ? (d.watch && d.watch.trigger ? d.watch.trigger : (d.waiting_on && d.waiting_on[0] ? 'Waiting on ' + d.waiting_on[0].text : d.action_reason_text)) : (K === 'LEAN' && d.bet_trigger && d.bet_trigger.short ? d.action_reason_text + ' BET at ' + d.bet_trigger.short + '.' : d.action_reason_text);
    return '<div class="edd-row edd-r-' + (TONE[K] || 'none') + '" data-edd-open="' + esc(d.game_id) + '" data-edd-sport="' + esc(d.sport) + '">'
      + '<div class="edd-r1"><b>' + esc(s ? s + (q && isNum(q.odds) ? ' (' + priceText(q.odds) + ')' : '') : (d.away || '') + ' @ ' + (d.home || '')) + '</b>'
      + (K === 'WATCH' ? ' <span class="edd-dnb">DO NOT BET YET</span>' : '') + (d.decision_qualifier && K !== 'BET' ? ' <span class="edd-qual">' + esc(d.decision_qualifier) + '</span>' : '') + '</div>'
      + '<div class="edd-r2">' + esc(why) + '</div><div class="edd-r3">' + matchup(d) + '</div></div>';
  }
  function exposureBlock(sm) {
    var ex = sm.exposure; if (!ex) return '';
    var parts = [];
    function grp(label, o) { var ks = Object.keys(o || {}); if (!ks.length) return; parts.push('<div class="edd-pr"><span>' + esc(label) + '</span><span>' + ks.map(function (k) { return esc(k) + ' ' + esc(unitsText(o[k].units)); }).join(' · ') + '</span></div>'); }
    grp('By sport', ex.by_sport); grp('By kickoff window', ex.by_window); grp('By market', ex.by_market);
    var notes = (ex.correlation_notes || []).map(function (n) { return '<div class="edd-corr"><b>CORRELATION NOTE</b> ' + esc(n.text) + '</div>'; }).join('');
    var g = ex.guardrail && ex.guardrail.text ? '<div class="edd-guard">' + esc(ex.guardrail.text) + '</div>' : '';
    if (!parts.length && !notes && !g) return '';
    return '<div class="edd-sec"><div class="edd-subh">EXPOSURE</div>' + parts.join('') + notes + g + '</div>';
  }
  function performanceHTML(perf) {
    if (!perf || !perf.by_tier) return '';
    var rows = perf.by_tier.map(function (r) {
      return '<tr><td>' + esc(r.group) + '</td><td>' + r.bets + '</td><td>' + (r.units_risked == null ? '—' : r.units_risked) + '</td><td>' + (r.units_won == null ? '—' : r.units_won) + '</td><td>' + (r.roi == null ? '—' : pctText(100 * r.roi)) + '</td><td>'
        + (r.average_clv == null ? '—' : (r.average_clv >= 0 ? '+' : '') + r.average_clv) + '</td><td>' + (r.observed_cover_rate == null ? '—' : (100 * r.observed_cover_rate).toFixed(1) + '%') + '</td><td>' + (r.expected_cover_rate == null ? '—' : (100 * r.expected_cover_rate).toFixed(1) + '%') + '</td></tr>'; }).join('');
    return '<div class="edd-sec"><div class="edd-subh">BET DECISION PERFORMANCE</div><div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Tier</th><th>Bets</th><th>Units risked</th><th>Units won</th><th>ROI</th><th>Avg CLV</th><th>Observed cover</th><th>Expected cover</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<div class="edd-note">' + esc(perf.note || '') + ' Any tier under ' + esc(perf.min_n) + ' settled bets is descriptive, not evidence.</div></div>';
  }
  function cardPageHTML(list, opts) {
    opts = opts || {};
    list = list || mergedDecisions();
    var v = opts.view || cardView(), sm = summary(list), B = BK();
    var shown = list.filter(function (d) { return passes(d, v.filter); }).sort(sorter(v.sort));
    var bets = shown.filter(function (d) { return d.decision === 'BET'; }), wait = shown.filter(function (d) { return kind(d) === 'WATCH'; }),
      lean = shown.filter(function (d) { return d.decision === 'LEAN'; }),
      pass = shown.filter(function (d) { return d.decision === 'PASS'; }), none = shown.filter(function (d) { return d.decision === 'NO_DECISION'; });
    var uv = B ? B.unitValue(settings()) : { unit: null };
    var h = '<div class="edd-page">';
    h += '<header class="edd-ph"><div class="edd-ph1"><h2>EDGEDESK CARD</h2><span class="edd-when">Last evaluated ' + esc(sm.last_evaluated ? fmtTime(sm.last_evaluated) : '—') + '</span></div>'
      + '<div class="edd-kpis">'
      + '<div class="edd-kpi edd-kpi-bet"><b>' + sm.counts.BET + '</b><span>' + (sm.counts.BET === 1 ? 'Bet' : 'Bets') + '</span></div>'
      + '<div class="edd-kpi"><b>' + esc(unitsText(sm.total_units)) + '</b><span>Total exposure' + (sm.total_dollars != null ? ' · ' + money(sm.total_dollars) : '') + '</span></div>'
      + '<div class="edd-kpi edd-kpi-lean"><b>' + sm.counts.LEAN + '</b><span>' + (sm.counts.LEAN === 1 ? 'Lean' : 'Leans') + '</span></div>'
      + '<div class="edd-kpi edd-kpi-wait"><b>' + sm.counts.WATCH + '</b><span>Watching</span></div>'
      + '<div class="edd-kpi edd-kpi-pass"><b>' + sm.counts.PASS + '</b><span>' + (sm.counts.PASS === 1 ? 'Pass' : 'Passes') + '</span></div>'
      + '<div class="edd-kpi edd-kpi-none"><b>' + sm.counts.NO_DECISION + '</b><span>No decision</span></div></div>'
      + (sm.total_dollars != null ? '<div class="edd-note">' + esc(unitsText(sm.total_units)) + ' total exposure · ' + money(sm.total_dollars) + ' based on your ' + money(uv.unit) + ' unit.</div>'
        : '<div class="edd-note"><button type="button" class="edd-link" data-edd-act="bankroll">Set your bankroll or unit</button> to see dollar amounts. 1 unit defaults to 1% of bankroll.</div>')
      + '<div class="edd-tools"><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="bankroll">Bankroll &amp; units</button><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="onboard">How to read this card</button>'
      + '<label class="edd-toggle"><input type="checkbox" data-edd-act="beginner"' + (beginner() ? ' checked' : '') + '> Beginner mode</label></div></header>';
    h += '<div class="edd-filters" role="tablist">' + FILTERS.map(function (f) { return '<button type="button" class="edd-f' + (v.filter === f[0] ? ' on' : '') + '" data-edd-act="filter" data-edd-v="' + f[0] + '">' + esc(f[1]) + '</button>'; }).join('') + '</div>';
    h += '<div class="edd-sortbar"><label>Sort <select data-edd-act="sort">' + SORTS.map(function (s) { return '<option value="' + s[0] + '"' + (v.sort === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') + '</select></label></div>';
    if (opts.loading) h += '<div class="edd-note">Loading the latest decisions…</div>';
    if (opts.error) h += '<div class="edd-note edd-warn">The decision build did not load (' + esc(opts.error) + '). Live decisions from the boards you open still appear here.</div>';
    h += '<div class="edd-sec"><div class="edd-sech edd-sech-bet">BET <small>' + bets.length + '</small></div>'
      + (bets.length ? bets.map(betRow).join('') : '<div class="edd-empty">No current price clears EdgeDesk’s betting thresholds. LEAN, WATCH and PASS are real answers: EdgeDesk evaluated ' + list.length + ' game' + (list.length === 1 ? '' : 's') + ' and none qualifies at the current prices.</div>') + '</div>';
    h += '<details class="edd-sec"' + (v.showLean !== false ? ' open' : '') + ' data-edd-fold="showLean"><summary class="edd-sech edd-sech-lean">LEAN <small>' + lean.length + '</small></summary>' + (lean.length ? lean.map(otherRow).join('') : '<div class="edd-empty">No positive edge below betting quality right now.</div>') + '</details>';
    h += '<div class="edd-sec"><div class="edd-sech edd-sech-wait">WATCHING <small>' + wait.length + '</small></div>' + (wait.length ? wait.map(otherRow).join('') : '<div class="edd-empty">Nothing is near a trigger or waiting on information.</div>') + '</div>';
    h += '<details class="edd-sec"' + (v.showPass ? ' open' : '') + ' data-edd-fold="showPass"><summary class="edd-sech edd-sech-pass">PASS <small>' + pass.length + '</small></summary>' + pass.map(otherRow).join('') + '</details>';
    h += '<details class="edd-sec"' + (v.showNone ? ' open' : '') + ' data-edd-fold="showNone"><summary class="edd-sech edd-sech-none">NO DECISION <small>' + none.length + '</small></summary>' + none.map(otherRow).join('') + '</details>';
    h += exposureBlock(sm);
    h += placedSummaryHTML();
    h += performanceHTML(S.build && S.build.performance);
    h += '<div class="edd-valid">' + tip('validation', 'Decision thresholds and stake tiers are conservative defaults, not yet validated on live results') + '. Stakes are capped by the probability source: model-estimated 0.25U, partially calibrated 0.50U; 1.00U needs a live-validated calibration. NO DECISION means essential data is missing, never that the model is still validating. Research, not picks: EdgeDesk states whether the current price qualifies, never that a wager will win.</div>';
    return h + '</div>';
  }
  function placedSummaryHTML() {
    var list = placed(); if (!list.length) return '';
    var T = TR(), graded = list.map(function (b) { return gradePlaced(b); }).filter(function (g) { return g && g.clv_points != null; });
    var avg = graded.length ? graded.reduce(function (s, g) { return s + g.clv_points; }, 0) / graded.length : null;
    var outside = list.filter(function (b) { var c = T ? T.compareEntry(b, b.recommendation) : null; return c && c.status === 'OUTSIDE_RANGE'; }).length;
    return '<div class="edd-sec"><div class="edd-subh">YOUR RECORDED BETS</div><div class="edd-pr"><span>Recorded</span><span>' + list.length + (outside ? ' · ' + outside + ' outside EdgeDesk range' : '') + '</span></div>'
      + '<div class="edd-pr"><span>Average CLV</span><span>' + (avg == null ? '—' : (avg >= 0 ? '+' : '') + avg.toFixed(2) + ' pts <small>' + graded.length + ' graded' + (graded.length < 30 ? ' — a short sample, not evidence' : '') + '</small>') + '</span></div></div>';
  }

  /* ====================================================== OVERVIEW BANNER */
  function bannerHTML(sm) {
    sm = sm || summary();
    return '<button type="button" class="edd-banner" data-edd-act="card"><span class="edd-k">EDGEDESK CARD</span>'
      + '<span class="edd-bn edd-bn-bet"><b>' + sm.counts.BET + '</b> ' + (sm.counts.BET === 1 ? 'bet' : 'bets') + (sm.counts.BET ? ' · ' + esc(unitsText(sm.total_units)) : '') + '</span>'
      + '<span class="edd-bn edd-bn-lean"><b>' + sm.counts.LEAN + '</b> lean</span><span class="edd-bn edd-bn-wait"><b>' + sm.counts.WATCH + '</b> watching</span><span class="edd-bn edd-bn-pass"><b>' + sm.counts.PASS + '</b> pass</span>'
      + '<span class="edd-go">Open →</span></button>';
  }

  /* ================================================== BANKROLL & UNITS */
  function bankrollFormHTML(s) {
    var B = BK(); s = B ? B.normalize(s || settings()) : (s || {});
    var uv = B ? B.unitValue(s) : { unit: null, text: '' };
    return '<div class="edd-modal-b"><h3>Bankroll &amp; units</h3>'
      + '<p class="edd-note">A unit is a standardized stake. EdgeDesk classifies every recommendation in units; your bankroll only converts units to dollars. It never changes a recommendation.</p>'
      + '<label class="edd-fld">Bankroll <input type="text" inputmode="decimal" data-edd-in="bankroll_amount" value="' + esc(s.bankroll_amount == null ? '' : s.bankroll_amount) + '" placeholder="e.g. 2500"></label>'
      + '<div class="edd-radio"><label><input type="radio" name="edd_um" data-edd-in="unit_mode" value="percent"' + (s.unit_mode !== 'fixed' ? ' checked' : '') + '> 1 unit = <input type="text" inputmode="decimal" class="edd-small" data-edd-in="unit_percent" value="' + esc(+(100 * (s.unit_percent || 0.01)).toFixed(2)) + '">% of bankroll <small>(default 1%)</small></label>'
      + '<label><input type="radio" name="edd_um" data-edd-in="unit_mode" value="fixed"' + (s.unit_mode === 'fixed' ? ' checked' : '') + '> Custom unit $<input type="text" inputmode="decimal" class="edd-small" data-edd-in="base_unit_amount" value="' + esc(s.base_unit_amount == null ? '' : s.base_unit_amount) + '"></label></div>'
      + '<div class="edd-unitnow">Your unit: <b data-edd-out="unit">' + (uv.unit == null ? '—' : money(uv.unit)) + '</b></div>'
      + '<label class="edd-fld">Maximum active exposure (units) <input type="text" inputmode="decimal" data-edd-in="max_active_units" value="' + esc(s.max_active_units) + '"></label>'
      + '<label class="edd-toggle"><input type="checkbox" data-edd-in="exposure_limit_enabled"' + (s.exposure_limit_enabled ? ' checked' : '') + '> Hold recommendations beyond that limit (off: EdgeDesk only warns)</label>'
      + '<label class="edd-toggle"><input type="checkbox" data-edd-in="beginner_mode"' + (s.beginner_mode ? ' checked' : '') + '> Beginner mode (decision first, research on request)</label>'
      + '<p class="edd-note">EdgeDesk never raises a stake to chase losses and never changes a recommendation because of a previous result.</p>'
      + '<div class="edd-acts"><button type="button" class="edd-btn edd-btn-bet" data-edd-act="bankroll-save">Save</button><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="close">Cancel</button></div></div>';
  }
  function readForm(el) {
    var o = {}, B = BK();
    if (!el || !el.querySelectorAll) return o;
    Array.prototype.forEach.call(el.querySelectorAll('[data-edd-in]'), function (i) {
      var k = i.getAttribute('data-edd-in');
      if (i.type === 'checkbox') o[k] = !!i.checked;
      else if (i.type === 'radio') { if (i.checked) o[k] = i.value; }
      else o[k] = i.value;
    });
    if (o.unit_percent != null && o.unit_percent !== '') o.unit_percent = num(o.unit_percent) != null ? num(o.unit_percent) / 100 : null;
    return B ? B.normalize(o) : o;
  }

  /* ========================================================= ONBOARDING */
  var ONBOARD = [
    function () { return '<h3>WELCOME TO EDGEDESK</h3><p>EdgeDesk separates <b>research</b> from <b>betting decisions</b>.</p><p><b>Research</b> finds potentially interesting markets.</p><p>The <b>Decision Layer</b> determines whether the current sportsbook price justifies action.</p>'; },
    function () { return '<h3>SET YOUR UNIT</h3><p>Default: 1 unit = 1% of bankroll.</p>' + bankrollFormHTML(settings()).replace(/<div class="edd-acts">[\s\S]*<\/div><\/div>$/, '</div>'); },
    function () { return '<h3>READ THE ACTION</h3><div class="edd-legend"><div><span class="edd-badge edd-b-bet">BET</span> This exact price clears EdgeDesk’s edge and EV thresholds. Sized in units, capped by how well the probability is calibrated.</div>'
      + '<div><span class="edd-badge edd-b-lean">LEAN</span> A positive edge in the model’s direction, below betting quality. No stake.</div>'
      + '<div><span class="edd-badge edd-b-watch">WATCH</span> Interesting, not actionable yet: near a trigger price, waiting on information, or a price anomaly. Do not bet yet.</div>'
      + '<div><span class="edd-badge edd-b-pass">PASS</span> EdgeDesk evaluated the wager, and the current price is not good enough.</div>'
      + '<div><span class="edd-badge edd-b-none">NO DECISION</span> Essential data is missing or invalid (no fresh quote, corrupted odds, no model). Rare.</div></div>'; },
    function () { return '<h3>PRICE MATTERS</h3><div class="edd-example"><span class="edd-badge edd-b-bet">BET</span> <b>NC State +6.5 (-102)</b><div>Playable to: <b>+5.5 / -115</b></div></div>'
      + '<p>If your sportsbook shows <b>+4.5</b>, do not use the earlier recommendation.</p><p class="edd-note">This example is illustrative, not a current recommendation.</p>'; }
  ];
  function onboardingHTML(step) {
    step = Math.max(0, Math.min(ONBOARD.length - 1, step || 0));
    return '<div class="edd-modal-b edd-onb" data-edd-step="' + step + '">' + ONBOARD[step]()
      + '<div class="edd-dots">' + ONBOARD.map(function (_, i) { return '<i class="' + (i === step ? 'on' : '') + '"></i>'; }).join('') + '</div>'
      + '<div class="edd-acts">' + (step > 0 ? '<button type="button" class="edd-btn edd-btn-quiet" data-edd-act="onb-prev">Back</button>' : '<button type="button" class="edd-btn edd-btn-quiet" data-edd-act="onb-done">Skip</button>')
      + (step < ONBOARD.length - 1 ? '<button type="button" class="edd-btn edd-btn-bet" data-edd-act="onb-next">Next</button>' : '<button type="button" class="edd-btn edd-btn-bet" data-edd-act="onb-done">Open the EdgeDesk Card</button>') + '</div></div>';
  }

  /* ======================================================= BET PLACED */
  function placedFormHTML(d) {
    var q = sel(d), B = BK(), dl = B ? B.dollars(d.recommended_units, settings()) : null;
    return '<div class="edd-pf"><div class="edd-subh">BET PLACED · record what you actually got</div>'
      + '<div class="edd-pfg"><label>Line <input type="text" inputmode="decimal" data-edd-in="line" value="' + esc(q ? q.line : '') + '"></label>'
      + '<label>Odds <input type="text" inputmode="decimal" data-edd-in="odds" value="' + esc(q ? q.odds : '') + '"></label>'
      + '<label>Book <input type="text" data-edd-in="book" value="' + esc(q ? q.book || '' : '') + '"></label>'
      + '<label>Units <input type="text" inputmode="decimal" data-edd-in="units" value="' + esc(d.recommended_units || '') + '"></label>'
      + '<label>Stake $ <input type="text" inputmode="decimal" data-edd-in="stake_dollars" value="' + esc(dl == null ? '' : dl) + '"></label></div>'
      + '<div class="edd-note">Stored separately from EdgeDesk’s recommendation, which is frozen with it and never changes.</div>'
      + '<div class="edd-acts"><button type="button" class="edd-btn edd-btn-bet" data-edd-act="placed-save" data-edd-gid="' + esc(d.game_id) + '">Save</button><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="placed-cancel" data-edd-gid="' + esc(d.game_id) + '">Cancel</button></div></div>';
  }
  function makePlaced(d, form, now) {
    var T = TR(), q = sel(d), B = BK();
    var snap = T ? T.snapshot(d) : null;
    var bet = { bet_key: 'ub_' + (DE() ? DE().hash([d.game_id, d.decision_id, form.line, form.odds, form.book, form.units, now]) : String(now)), source: d.decision === 'BET' ? 'edgedesk' : 'own',
      sport: d.sport, game_id: String(d.game_id), home_team: d.home, away_team: d.away, kickoff: d.kickoff, market_type: d.market_type || 'spread', side: q ? q.side : d.side_key, team: q ? q.team : d.side,
      line: num(form.line), odds: num(form.odds), book: form.book || null, units: num(form.units), stake_dollars: num(form.stake_dollars),
      unit_value: B ? B.unitValue(settings()).unit : null, placed_at: new Date(now || Date.now()).toISOString(), recommendation_id: d.decision_id || null,
      recommendation: snap ? JSON.parse(JSON.stringify(snap)) : null };
    var c = T ? T.compareEntry(bet, bet.recommendation) : null;
    bet.entry_vs_recommendation = c ? c.status : null;
    return bet;
  }
  function savePlaced(bet) {
    var list = placed().slice();
    if (!list.some(function (b) { return b.bet_key === bet.bet_key; })) list.push(bet);
    S.placed = list; writeKey(KEYS.placed, list);
    if (signedIn() && typeof root.sbPost === 'function') {
      var row = {}; ['bet_key', 'source', 'sport', 'game_id', 'home_team', 'away_team', 'kickoff', 'market_type', 'side', 'team', 'line', 'odds', 'book', 'units', 'stake_dollars', 'unit_value', 'placed_at', 'recommendation_id', 'recommendation', 'entry_vs_recommendation'].forEach(function (k) { row[k] = bet[k]; });
      try { var p = root.sbPost('user_bets', [row]); if (p && p.catch) p.catch(function () {}); } catch (e) { /* kept locally */ }
    }
    return list;
  }
  /* CLV for a placed bet, from the committed record's close (record/football/<sport>_<season>.json) */
  function gradePlaced(b) {
    var T = TR(); if (!T || !b) return null;
    var rec = S.record[String(b.sport || '').toLowerCase()];
    var g = rec && rec.games ? rec.games[String(b.game_id)] : null;
    if (!g || !g.close || !isNum(num(g.close.home_line))) return null;
    var closeSide = b.side === 'home' ? g.close.home_line : -g.close.home_line;
    var fin = g.final && isNum(num(g.final.home_score)) && isNum(num(g.final.away_score)) ? { home_margin: g.final.home_score - g.final.away_score } : null;
    var out = T.grade({ side: b.side, line: b.line, odds: b.odds, units: b.units }, { line: closeSide }, fin);
    out.close_line = closeSide;
    return out;
  }
  function ensureRecords() {
    if (typeof fetch !== 'function') return;
    var sports = {}; placed().forEach(function (b) { sports[String(b.sport || '').toLowerCase()] = String(b.kickoff || '').slice(0, 4) || '2026'; });
    Object.keys(sports).forEach(function (sp) {
      if (!sp || S.record[sp] || S.recordP[sp]) return;
      S.recordP[sp] = fetch('record/football/' + sp + '_' + sports[sp] + '.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { S.record[sp] = j || { games: {} }; repaint(); }).catch(function () { S.record[sp] = { games: {} }; });
    });
  }

  /* ========================================================= CONTROLLER */
  function ensureBuild() {
    if (S.build || S.buildP || typeof fetch !== 'function') return S.buildP;
    S.buildP = fetch('football/cfb_terminal/decisions.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('decisions.json ' + r.status); return r.json(); })
      .then(function (j) { S.build = j; S.buildP = null; repaint(); return j; })
      .catch(function (e) { S.buildErr = String(e && e.message || e).slice(0, 120); S.buildP = null; repaint(); });
    return S.buildP;
  }
  function modal(html) {
    if (typeof document === 'undefined') return null;
    var m = document.getElementById('eddModal');
    if (!m) { m = document.createElement('div'); m.id = 'eddModal'; m.className = 'edd-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
    m.innerHTML = '<div class="edd-modal-in">' + html + '</div>';
    m.classList.add('on');
    return m;
  }
  function closeModal() { var m = typeof document !== 'undefined' ? document.getElementById('eddModal') : null; if (m) m.classList.remove('on'); }
  function openBankroll() { var m = modal(bankrollFormHTML(settings())); if (m) liveUnit(m); }
  function liveUnit(m) {
    var B = BK(); if (!B || !m) return;
    var upd = function () { var o = readForm(m), u = B.unitValue(o).unit, out = m.querySelector('[data-edd-out="unit"]'); if (out) out.textContent = u == null ? '—' : money(u); };
    m.addEventListener('input', upd); m.addEventListener('change', upd);
  }
  function openOnboarding(step) { var m = modal(onboardingHTML(step || 0)); if (m && (step || 0) === 1) liveUnit(m); }
  function onboarded() { return !!readKey(KEYS.onboarded, null); }
  function maybeOnboard() { if (!onboarded() && typeof document !== 'undefined') openOnboarding(0); }
  function showCard(host) {
    host = host || (typeof document !== 'undefined' ? document.getElementById('eddCardHost') : null);
    S.host = host;
    loadRemoteSettings(); ensureBuild(); ensureRecords();
    try { if (typeof root.fbDecisionsLive === 'function') root.fbDecisionsLive(); } catch (e) { /* live decisions are an overlay */ }
    paintCard();
    maybeOnboard();
  }
  function paintCard() {
    if (!S.host) return;
    S.host.innerHTML = cardPageHTML(null, { loading: !S.build && !S.buildErr, error: S.buildErr });
  }
  var repaintT = null;
  function repaint() {
    if (repaintT || typeof setTimeout !== 'function') return;
    repaintT = setTimeout(function () {
      repaintT = null;
      if (S.host && typeof document !== 'undefined' && document.body.contains(S.host) && S.host.offsetParent !== null) paintCard();
      try { if (typeof root.fbDecisionRepaint === 'function') root.fbDecisionRepaint(); } catch (e) { /* the board repaints on its own clock */ }
    }, 30);
  }
  function findDecision(gid) { return S.registry[String(gid)] || ((S.build && S.build.decisions) || []).filter(function (d) { return String(d.game_id) === String(gid); })[0] || null; }
  function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-edd-act]') : null;
    var row = !el && ev.target && ev.target.closest ? ev.target.closest('[data-edd-open]') : null;
    if (row) { var gid0 = row.getAttribute('data-edd-open'), sp = row.getAttribute('data-edd-sport'); try { if (typeof root.fbOpenGame === 'function') root.fbOpenGame(String(sp || 'CFB').toUpperCase() === 'NFL' ? 'nfl' : 'p4', gid0); } catch (e) { /* ignore */ } return; }
    if (!el) return;
    var act = el.getAttribute('data-edd-act'), gid = el.getAttribute('data-edd-gid');
    if (act === 'filter') { cardView().filter = el.getAttribute('data-edd-v'); writeKey(KEYS.card, cardView()); paintCard(); }
    else if (act === 'bankroll') openBankroll();
    else if (act === 'bankroll-save') { var m = document.getElementById('eddModal'); saveSettings(readForm(m)); closeModal(); paintCard(); repaint(); }
    else if (act === 'close') closeModal();
    else if (act === 'onboard') openOnboarding(0);
    else if (act === 'onb-next' || act === 'onb-prev') {
      var st = +(el.closest('[data-edd-step]') || { getAttribute: function () { return 0; } }).getAttribute('data-edd-step');
      var m2 = document.getElementById('eddModal');
      if (st === 1 && m2) saveSettings(readForm(m2));
      openOnboarding(st + (act === 'onb-next' ? 1 : -1));
    } else if (act === 'onb-done') { var m3 = document.getElementById('eddModal'); if (m3 && m3.querySelector('[data-edd-in]')) saveSettings(readForm(m3)); writeKey(KEYS.onboarded, new Date().toISOString()); closeModal(); if (typeof root.show === 'function' && (!S.host || S.host.offsetParent === null)) root.show('card'); }
    else if (act === 'card') { if (typeof root.show === 'function') root.show('card'); }
    else if (act === 'research') {
      var r = document.querySelector('[data-edd-research="' + gid + '"]');
      if (r) { r.classList.remove('edd-collapsed'); try { r.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { r.scrollIntoView(); } }
    } else if (act === 'placed') {
      var d = findDecision(gid), f = document.querySelector('[data-edd-form="' + gid + '"]');
      if (d && f) f.innerHTML = placedFormHTML(d);
    } else if (act === 'placed-cancel') { var f2 = document.querySelector('[data-edd-form="' + gid + '"]'); if (f2) f2.innerHTML = ''; }
    else if (act === 'placed-save') {
      var d2 = findDecision(gid), f3 = document.querySelector('[data-edd-form="' + gid + '"]');
      if (d2 && f3) {
        var form = {}; Array.prototype.forEach.call(f3.querySelectorAll('[data-edd-in]'), function (i) { form[i.getAttribute('data-edd-in')] = i.value; });
        var bet = makePlaced(d2, form, Date.now());
        if (bet.odds == null || (bet.odds > -100 && bet.odds < 100) || !(bet.units > 0)) { f3.insertAdjacentHTML('beforeend', '<div class="edd-note edd-warn">Enter valid odds (−100 or lower, +100 or higher) and units above 0.</div>'); return; }
        savePlaced(bet); f3.innerHTML = ''; repaint();
      }
    }
  }
  function onChange(ev) {
    var el = ev.target; if (!el || !el.getAttribute) return;
    var act = el.getAttribute('data-edd-act');
    if (act === 'sort') { cardView().sort = el.value; writeKey(KEYS.card, cardView()); paintCard(); }
    else if (act === 'beginner') { var s = settings(); s.beginner_mode = !!el.checked; saveSettings(s); paintCard(); repaint(); }
  }
  function onToggle(ev) {
    var el = ev.target; if (!el || !el.getAttribute) return;
    var k = el.getAttribute('data-edd-fold'); if (!k) return;
    cardView()[k] = !!el.open; writeKey(KEYS.card, cardView());
  }
  var installed = false;
  function install() {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install(); }

  return {
    VERSION: VERSION, KEYS: KEYS, FILTERS: FILTERS, SORTS: SORTS,
    /* pure renderers */
    actionCardHTML: actionCardHTML, chipHTML: chipHTML, cardPageHTML: cardPageHTML, bannerHTML: bannerHTML, bankrollFormHTML: bankrollFormHTML,
    onboardingHTML: onboardingHTML, placedFormHTML: placedFormHTML, performanceHTML: performanceHTML, copyOk: copyOk, summary: summary,
    makePlaced: makePlaced, gradePlaced: gradePlaced, passes: passes, sorter: sorter,
    /* state */
    observe: observe, previous: previous, trackFor: trackFor, settings: settings, saveSettings: saveSettings, placed: placed, savePlaced: savePlaced,
    mergedDecisions: mergedDecisions, beginner: beginner, _state: S,
    /* controller */
    showCard: showCard, openBankroll: openBankroll, openOnboarding: openOnboarding, repaint: repaint, install: install, ensureBuild: ensureBuild
  };
}));
