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
  function V() { return mod('EDVocab', 'edgedesk_vocab.js'); }
  function XP() { return mod('EDExplain', 'edgedesk_explain.js'); }
  /* the one word a reader sees for a decision key (WAIT reads WATCH) */
  function label(k) { var Vo = V(); return Vo ? Vo.decisionLabel(k) : String(k || '').replace(/_/g, ' '); }

  /* ------------------------------------------------------------- helpers */
  var EPS = 1e-9;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lineText(v) { if (!isNum(v)) return '—'; if (Math.abs(v) < EPS) return 'PK'; var s = String(Math.round(v * 10) / 10).replace(/\.0$/, ''); return (v > 0 ? '+' : '') + s; }
  function priceText(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function pctText(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function unitsText(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
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
    return '<span class="edd-tip" tabindex="0" role="note" aria-label="' + esc((label || key) + ': ' + t) + '" data-tip="' + esc(t) + '">' + esc(label || '') + '</span>';
  }
  function sel(d) {
    if (!d) return null;
    if (d.decision === 'BET' && d.bet_price) return d.bet_price;
    return d.reference_quote || d.bet_price || null;
  }
  function selText(d, upper) {
    var q = sel(d);
    if (!q) return null;
    var mt = q.market_type || d.market_type, sd = String(q.side || '');
    var t = mt === 'total' ? sd.charAt(0).toUpperCase() + sd.slice(1) + ' ' + (isNum(q.line) ? String(Math.round(q.line * 10) / 10) : '—')
      : (q.team || d.side || q.side || '') + (mt === 'moneyline' ? ' ML' : ' ' + lineText(q.line));
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
  var KEYS = { placed: 'edgedesk_bets_placed_v1', tracks: 'edgedesk_decision_tracks_v1', onboarded: 'edgedesk_decision_onboarded_v1', card: 'edgedesk_card_view_v1', level: 'edgedesk_info_level_v1',
    opps: 'edgedesk_card_opportunities_v1' };
  var S = { settings: null, placed: null, tracks: null, registry: {}, card: null, build: null, buildErr: null, buildP: null, record: {}, recordP: {}, host: null, remoteLoaded: false,
    health: null, healthErr: null, healthP: null,
    /* the reader's saved opportunities (lib/edgedesk_opportunity.js cardEntry)
       and what the market says about each one now */
    entries: null, entriesRemote: false, propCur: {}, propLoad: {}, propResults: {}, propResultsP: {} };
  function OPP() { return mod('EDOpportunity', 'edgedesk_opportunity.js'); }
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
      if (p && p.then) p.then(function (rows) { var row = rows && rows[0]; if (row) { S.settings = BK().save(BK().fromRow(row, settings())); repaint(); } }).catch(function () {});
    } catch (e) { /* signed-out behaviour */ }
  }
  function tracks() { if (!S.tracks) S.tracks = readKey(KEYS.tracks, {}); return S.tracks; }
  function placed() { if (!S.placed) S.placed = readKey(KEYS.placed, []); return S.placed; }
  function cardView() { if (!S.card) S.card = readKey(KEYS.card, { filter: 'all', sort: 'kickoff', showPass: false, showNone: false, showLean: true }); return S.card; }
  /* ================================================ SAVED OPPORTUNITIES
     ADD TO CARD from any research surface stores the opportunity as it is
     at that moment (EDOpportunity.cardEntry: id, type, decision, sport,
     event, market, line, side, price, book, probability, EV, edge,
     confidence, units, time; for a prop the player and prop type too). The
     entry is never edited: a later market move is read beside it. Kept on
     the device, and in public.card_opportunities when signed in
     (supabase/card_opportunities.sql: write-once, owner-only). */
  function entries() {
    if (!S.entries) S.entries = (readKey(KEYS.opps, []) || []).filter(function (e) { return e && e.entry_id && e.key && e.status !== 'removed'; });
    return S.entries;
  }
  function onCard(key) { return entries().some(function (e) { return e.key === key; }); }
  var ENTRY_COLS = ['entry_id', 'opportunity_id', 'key', 'type', 'sport', 'league', 'event_key', 'game_id', 'kickoff', 'home', 'away', 'market', 'category', 'player_id', 'player_name', 'team', 'position', 'prop_type',
    'side', 'line', 'selection', 'american', 'book', 'captured_at', 'probability', 'ev', 'edge_pp', 'confidence', 'decision', 'units', 'code', 'probability_source', 'stage', 'saved_at', 'evaluated_at', 'snapshot'];
  function entryRow(e) { var o = {}; ENTRY_COLS.forEach(function (k) { o[k] = e[k] === undefined ? null : e[k]; }); return o; }
  function addOpportunity(o) {
    var X = OPP(); if (!X || !o || !o.key) return null;
    var ko = Date.parse(o.event && o.event.kickoff);
    if (isFinite(ko) && ko <= Date.now()) return { added: false, reason: 'The game has started' };
    var have = entries().filter(function (e) { return e.key === o.key; })[0];
    if (have) return { added: false, reason: 'Already on your Card', entry: have };
    var e = JSON.parse(JSON.stringify(X.cardEntry(o, { now: Date.now() })));
    var list = entries().slice(); list.push(e); S.entries = list; writeKey(KEYS.opps, list);
    if (signedIn() && typeof root.sbPost === 'function') { try { var pr = root.sbPost('card_opportunities', [entryRow(e)]); if (pr && pr.catch) pr.catch(function () {}); } catch (x) { /* kept on this device */ } }
    try { if (typeof root.edEvent === 'function') root.edEvent('card_opportunity_added', { type: e.type, sport: e.sport, decision: e.decision }); } catch (x) { /* analytics is optional */ }
    ensurePropCurrent(); repaint();
    return { added: true, entry: e };
  }
  /* EdgeDesk's current decision on a game, saved as a GAME opportunity */
  function addGame(gid) { var X = OPP(), d = findDecision(gid); if (!X || !d) return null; return addOpportunity(X.fromGameDecision(d)); }
  function removeEntry(id) {
    var list = entries().filter(function (e) { return e.entry_id !== id; });
    S.entries = list; writeKey(KEYS.opps, list);
    if (signedIn() && typeof root.sbWrite === 'function') { try { var pr = root.sbWrite('card_opportunities?entry_id=eq.' + encodeURIComponent(id), { status: 'removed' }, 'PATCH'); if (pr && pr.catch) pr.catch(function () {}); } catch (x) { /* local removal stands */ } }
    repaint();
  }
  function loadRemoteEntries() {
    if (S.entriesRemote || !signedIn() || typeof root.sbGet !== 'function') return;
    S.entriesRemote = true;
    try {
      var pr = root.sbGet('card_opportunities?select=*&status=eq.open&order=saved_at.asc&limit=500');
      if (pr && pr.then) pr.then(function (rows) {
        var have = {}; entries().forEach(function (e) { have[e.entry_id] = 1; });
        var add = (rows || []).filter(function (r) { return r && r.entry_id && !have[r.entry_id]; });
        if (add.length) { S.entries = entries().concat(add); writeKey(KEYS.opps, S.entries); ensurePropCurrent(); repaint(); }
        /* entries saved on a page without this UI (research/cfb/, lib/edgedesk_props_ui.js deviceAdd) reach the server here */
        var there = {}; (rows || []).forEach(function (r) { if (r && r.entry_id) there[r.entry_id] = 1; });
        var sent = function (id) {
          S.entries = entries().map(function (e) { if (e.entry_id !== id) return e; var c = JSON.parse(JSON.stringify(e)); delete c.pending_upload; return c; });
          writeKey(KEYS.opps, S.entries);
        };
        entries().filter(function (e) { return e.pending_upload; }).forEach(function (e) {
          /* already there, or pregame-only and the game has started: nothing to send */
          if (there[e.entry_id] || !(Date.parse(e.kickoff) > Date.now())) { sent(e.entry_id); return; }
          if (typeof root.sbPost !== 'function') return;
          try { var p = root.sbPost('card_opportunities', [entryRow(e)]); if (p && p.then) p.then(function () { sent(e.entry_id); }).catch(function () {}); } catch (x) { /* retried on the next load */ }
        });
      }).catch(function () {});
    } catch (x) { /* device copy stands */ }
  }
  /* the market NOW for each saved prop: the prop board (shared with the
     Props page) re-priced by the same kernel, for PRICE MOVED; the summary
     for the same-game correlation model */
  function ensurePropCurrent() {
    var U = root.EDPropsUI, E = root.EDProps, leagues = {};
    entries().forEach(function (e) { if (e.type === 'PLAYER_PROP' && openSaved(e)) leagues[e.league] = 1; });
    Object.keys(leagues).forEach(function (lg) {
      if (U && U.loadSummary && !(U.state.summaries && U.state.summaries[lg])) { try { U.loadSummary(lg).then(repaint, function () {}); } catch (x) { /* optional */ } }
      if (S.propLoad[lg] || !U || !U._fetchBoard || !E) return;
      S.propLoad[lg] = U._fetchBoard(lg).then(function (b) {
        var t = Date.now();
        entries().forEach(function (e) {
          if (e.type !== 'PLAYER_PROP' || e.league !== lg) return;
          var row = (b.props || []).filter(function (r) { return String(r.g) === String(e.game_id) && r.p === e.player_id && r.m === e.market; })[0];
          if (!row || !row.q || !row.q.length) return;
          try { S.propCur[e.entry_id] = E.boardEval(b, row, t); } catch (x) { /* no current price */ }
        });
        setTimeout(function () { S.propLoad[lg] = null; }, 5 * 60000);
        repaint();
      }, function () { S.propLoad[lg] = null; });
    });
    ensurePropResults();
  }
  /* graded props for the record: football/props/<lg>/<season>/results.jsonl */
  function ensurePropResults() {
    if (typeof fetch !== 'function') return;
    var want = {};
    entries().forEach(function (e) { if (e.type === 'PLAYER_PROP' && !openSaved(e)) want[e.league + '|' + String(e.kickoff || '').slice(0, 4)] = 1; });
    Object.keys(want).forEach(function (k) {
      if (S.propResultsP[k]) return;
      var lg = k.split('|')[0], yr = k.split('|')[1];
      S.propResultsP[k] = fetch('football/props/' + lg + '/' + yr + '/results.jsonl', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.text() : ''; })
        .then(function (t) { var rows = String(t || '').split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (x) { return null; } }).filter(Boolean); S.propResults[lg] = (S.propResults[lg] || []).concat(rows); repaint(); })
        .catch(function () { /* no results yet: pending */ });
    });
  }
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

  /* ==================================================== THE ACTION CARD
     One layout per decision, top to bottom in the order a bettor asks:
       BET    what · where · price · how much · playable to · edge + EV ·
              confidence · why · what could invalidate it
       WATCH  DO NOT BET YET · current price · reason · BET trigger ·
              waiting on · next check
       LEAN   current price · why it is not a bet · BET AT
       PASS   best available · why · BET trigger (or none realistic)
       NO DECISION  the blocker, and the last market seen
     Above it, the two layers the decision is NOT: the market state (what
     prices exist) and the research status (is the matchup worth opening),
     each styled apart from the decision. */
  function dollarsLine(d) {
    var B = BK(); if (!B || d.decision !== 'BET') return '';
    var s = settings(), uv = B.unitValue(s), dl = B.dollars(d.recommended_units, s);
    if (dl == null) return '<button type="button" class="edd-link" data-edd-act="bankroll">Set your bankroll</button> <small>to see dollars</small>';
    return '<b>' + money(dl) + '</b> <small>based on your ' + money(uv.unit) + ' unit</small>';
  }
  function playableText(d) {
    var P = d.playable; if (!P) return null;
    if (P.mode === 'CURRENT_PRICE_ONLY') return 'Current price only';
    return lineText(P.min_line) + ' / ' + priceText(P.max_odds);
  }
  function metric(label, value, key, cls, note) {
    return '<div class="edd-m' + (cls ? ' ' + cls : '') + '"><div class="edd-mk">' + (key ? tip(key, label) : esc(label)) + '</div><div class="edd-mv">' + value + '</div>' + (note ? '<div class="edd-mn">' + esc(note) + '</div>' : '') + '</div>';
  }
  /* the EV the decision used, then (only beside a calibration) the raw EV,
     labelled diagnostic so a huge raw number never reads as the action */
  function evCells(d, withRaw) {
    var E = DE(), L = E && E.evLabels ? E.evLabels(d) : null, cells = [];
    if (!L) return cells;
    var cal = !!L.raw;
    cells.push(metric(L.decision.label, esc(pctText(L.decision_ev_pct)), cal ? 'calibrated_ev' : 'model_estimated_ev', isNum(L.decision_ev_pct) && L.decision_ev_pct > 0 ? 'pos' : '', L.decision.note));
    if (withRaw && cal) cells.push(metric(L.raw.label, esc(pctText(L.raw_ev_pct)), 'raw_ev', 'dim edd-diag', L.raw.note));
    return cells;
  }
  function metricsGrid(d, compact) {
    var cells = [];
    if (d.decision === 'BET') cells.push(metric('STAKE TIER', esc(unitsText(d.recommended_units)) + ' <small>' + esc(tierWord(d) || '') + '</small>', 'edge_strength', '', unitRule(d.recommended_units).text));
    cells.push(metric('DECISION CONFIDENCE', isNum(d.decision_confidence) ? esc(d.decision_confidence) + ' <small>/ 100 · ' + esc(d.decision_confidence_label || '') + '</small>' : '—', 'decision_confidence'));
    cells.push(metric('PROBABILITY', esc(SRC_SHORT[d.probability_source] || '—'), 'probability_source', d.probability_source === 'model_estimated' ? 'dim' : ''));
    cells.push(metric('MODEL COVER', esc(probPct(d.probability)), 'cover_probability'));
    cells.push(metric('BREAK-EVEN', esc(probPct(d.break_even))));
    cells.push(metric('EDGE', esc(ppTxt(d.edge_pp)), 'edge', isNum(d.edge_pp) && d.edge_pp > 0 ? 'pos' : ''));
    cells = cells.concat(evCells(d, true));
    cells.push(metric('MODEL FAIR', esc(d.model_fair_text || '—'), 'model_fair'));
    if (!compact) {
      cells.push(metric('RELIABILITY', isNum(d.reliability_score) ? esc(Math.round(d.reliability_score)) + ' <small>/ 100</small>' : '<small>unmeasured</small>', 'reliability'));
      cells.push(metric('MARKET QUALITY', esc(MQ_LABEL[d.market_quality] || '—'), 'market_quality'));
      cells.push(metric('PROJECTION', esc(STAB_LABEL[d.projection_stability] || '—')));
    }
    return '<div class="edd-grid">' + cells.join('') + '</div>';
  }
  function qLine(q) { return q ? esc(q.label) + ' <small>' + esc(q.book || '') + '</small>' : '—'; }
  function priceTypes(d) {
    var rows = [];
    var q = sel(d);
    if (d.best_current_price) rows.push(['BEST CURRENT PRICE', qLine(d.best_current_price), 'best_current_price']);
    if (d.consensus_text) rows.push(['CONSENSUS', esc(d.consensus_text), 'consensus']);
    if (d.decision === 'BET' && q) rows.push(['EDGEDESK BET PRICE', esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ') <small>' + esc(q.book || '') + '</small>', 'bet_price']);
    if (d.decision === 'BET' && d.playable) rows.push(['PLAYABLE TO', esc(d.playable.text), 'playable_to']);
    if (d.best_playable_alternate) rows.push(['BEST PLAYABLE ALTERNATE', qLine(d.best_playable_alternate), 'best_playable_alternate']);
    if (d.safer_value) rows.push(['SAFER ALTERNATE', qLine(d.safer_value), 'safer_alternate']);
    if (d.model_fair_text) rows.push(['MODEL FAIR', esc(d.model_fair_text), 'model_fair']);
    if (!rows.length) return '';
    return '<div class="edd-prices">' + rows.map(function (r) { return '<div class="edd-pr"><span>' + tip(r[2], r[0]) + '</span><span>' + r[1] + '</span></div>'; }).join('') + '</div>';
  }
  function alternativesBlock(d) {
    var A = d.alternatives; if (!A) return '';
    var rows = [];
    function row(k, q, why) { if (q) rows.push('<div class="edd-alt"><span class="edd-k">' + k + '</span> ' + esc(q.label) + ' <small>' + esc(q.book || '') + ' · edge ' + esc(ppTxt(q.edge_pp)) + ' · EV ' + esc(pctText(100 * (isNum(q.decision_ev) ? q.decision_ev : (q.raw_ev || 0)))) + ' · cover ' + esc(probPct(isNum(q.decision_cover) ? q.decision_cover : q.cover_probability)) + (why ? ' · ' + why : '') + '</small></div>'); }
    row('SELECTED', A.best_value, 'best risk-adjusted EV');
    row('BEST CURRENT PRICE', A.best_current_price || A.best_price, 'best book at this exact line');
    row('BEST PLAYABLE ALTERNATE', A.best_playable_alternate, 'nearby, also clears the BET threshold');
    row('SAFER ALTERNATE', A.safer_alternate || A.safer, 'nearby, lower variance, still positive EV');
    row('MAIN', A.main, 'the consensus number');
    row('MAX EV', A.better_value, 'highest EV among executable nearby lines — not the recommendation');
    if (!rows.length) return '';
    return '<div class="edd-sub"><div class="edd-subh">LINES EVALUATED <small>' + esc(A.n_evaluated) + ' quotes · ' + esc(A.n_alternates) + ' alternates</small></div>' + rows.join('') + '<div class="edd-note">' + esc(A.note) + '</div></div>';
  }
  function otherMarketsBlock(d) {
    var M = d.markets; if (!M) return '';
    var rows = [];
    ['spread', 'total', 'moneyline'].forEach(function (k) {
      var m = M[k]; if (!m || k === d.market_type) return;
      var ms = m.market_state && V() && V().MARKET_STATE[m.market_state] ? ' <small>' + esc(V().MARKET_STATE[m.market_state].label) + '</small>' : '';
      rows.push('<div class="edd-pr"><span>' + esc(k.toUpperCase()) + '</span><span><b>' + esc(m.display || m.label || m.decision) + '</b>' + (m.selection ? ' ' + esc(m.selection) + (m.book ? ' <small>' + esc(m.book) + '</small>' : '') : '') + ms + ' <small>' + esc(m.reason || '') + '</small></span></div>');
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
      return '<div class="edd-tr"><span class="edd-trw">' + esc(fmtTime(x.at)) + '</span> <b>' + esc(label(x.from) + ' → ' + label(x.to)) + '</b> <small>' + esc(x.text || '') + '</small></div>'; }).join('') : '';
    return '<div class="edd-sub"><div class="edd-subh">RECOMMENDATION HISTORY</div>' + rows.map(function (r) { return '<div class="edd-pr"><span>' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>'; }).join('') + trH + '</div>';
  }
  function auditBlock(d) {
    var parts = [];
    if (d.sizing && d.sizing.tiers) parts.push('<div class="edd-subh">STAKE TIERS <small>' + esc(unitRule(d.recommended_units).label.toLowerCase()) + '</small></div>' + d.sizing.tiers.map(function (t) {
      return '<div class="edd-tier ' + (t.allowed ? 'ok' : '') + '"><b>' + esc(unitsText(t.units)) + '</b> ' + esc(t.key || '') + ' ' + (t.allowed ? 'clears' : esc(t.why.join('; '))) + '</div>'; }).join('')
      + (d.sizing.caps && d.sizing.caps.length ? '<div class="edd-note">Capped: ' + esc(d.sizing.caps.join('; ')) + '</div>' : '')
      + '<div class="edd-note">Raw EV never enters sizing · no result-based adjustment · never above 1.00U.</div>');
    if ((d.caps || []).length) parts.push('<div class="edd-subh">WHAT LIMITS IT</div>' + d.caps.map(function (c) { return '<div class="edd-tier"><b>' + esc(label(c.max)) + '</b> ' + esc(c.text) + '</div>'; }).join(''));
    if (d.bet_trigger && (d.bet_trigger.options || []).length) parts.push('<div class="edd-subh">BET TRIGGER SEARCH</div>' + d.bet_trigger.options.map(function (o) { return '<div class="edd-tier ' + (o.realistic ? 'ok' : '') + '"><b>' + (o.realistic ? 'REAL' : 'FAR') + '</b> ' + esc(o.text) + ' <small>' + esc(o.kind === 'line' ? o.move_pts + ' pts away' : o.move_cents + '¢ away') + '</small></div>'; }).join('')
      + (d.bet_trigger.detail ? '<div class="edd-note">' + esc(d.bet_trigger.detail) + '</div>' : ''));
    if (d.decision_confidence_detail && d.decision_confidence_detail.components) {
      var C = d.decision_confidence_detail.components;
      parts.push('<div class="edd-subh">DECISION CONFIDENCE ' + esc(d.decision_confidence) + '/100</div><div class="edd-note">' + Object.keys(C).map(function (k) { return esc(k.replace(/_/g, ' ')) + ' ' + Math.round(100 * C[k]); }).join(' · ')
        + (d.decision_confidence_detail.notes && d.decision_confidence_detail.notes.length ? ' — ' + esc(d.decision_confidence_detail.notes.join('; ')) : '') + '</div>');
    }
    if (d.anomaly && d.anomaly.triggered) parts.push('<div class="edd-subh">PRICE VERIFICATION</div><div class="edd-note">' + esc(d.anomaly.triggers.map(function (x) { return x.text; }).join(' · ')) + '</div>'
      + d.anomaly.checks.map(function (c) { return '<div class="edd-tier ' + (c.status === 'PASS' ? 'ok' : '') + '"><b>' + esc(c.status) + '</b> ' + esc(c.code.replace(/_/g, ' ').toLowerCase()) + ' <small>' + esc(c.text || '') + '</small></div>'; }).join(''));
    var C2 = d.canonical;
    if (C2 && C2.orientation && ((C2.orientation.repairs || []).length || (C2.orientation.dropped || []).length)) parts.push('<div class="edd-subh">ORIENTATION</div>' + (C2.orientation.repairs || []).concat(C2.orientation.dropped || []).slice(0, 6).map(function (x) { return '<div class="edd-note">· ' + esc(x.code.replace(/_/g, ' ').toLowerCase()) + ': ' + esc(x.quote || '') + ' — ' + esc(x.text || '') + '</div>'; }).join(''));
    if (d.quote) parts.push('<div class="edd-subh">EVALUATED QUOTE</div><div class="edd-note">' + esc([d.quote.selection, priceText(d.quote.odds), d.quote.sportsbook, d.quote.captured_at ? 'captured ' + d.quote.captured_at : null, 'freshness ' + (d.quote.freshness || '—'), 'orientation ' + (d.quote.orientation || '—'), 'verification ' + d.quote.verification_state, d.quote.source].filter(Boolean).join(' · ')) + '</div>');
    var v = (d.warnings || []).filter(function (w) { return w.code !== 'RULES_UNVALIDATED'; });
    if (v.length) parts.push('<div class="edd-subh">WARNINGS</div>' + v.map(function (w) { return '<div class="edd-note">· ' + esc(w.text) + '</div>'; }).join(''));
    if ((d.invalidation_conditions || []).length) parts.push('<div class="edd-subh">EVERY INVALIDATION CONDITION</div><div class="edd-note">' + esc(d.invalidation_conditions.map(function (c) { return c.text; }).join(' · ')) + '</div>');
    parts.push('<div class="edd-note edd-ver">reasons ' + esc((d.reasons || []).join(', ') || '—') + (d.blocker_codes && d.blocker_codes.length ? ' · blockers ' + esc(d.blocker_codes.join(', ')) : '') + '</div>');
    parts.push('<div class="edd-note edd-ver">engine ' + esc(d.decision_engine_version) + ' · config ' + esc(d.config_version) + ' · model ' + esc(d.model_version || '—') + ' · calibration ' + esc(d.calibration_version || 'none') + ' · decision ' + esc(d.decision_id || '') + '</div>');
    return '<div class="edd-sub">' + parts.join('') + '</div>';
  }
  function transitionLine(t) {
    var x = t && t.transitions ? t.transitions.filter(function (y) { return y.from; }).slice(-1)[0] : null;
    if (!x) return '';
    return '<div class="edd-changed"><span class="edd-k">CHANGED ' + esc(fmtTime(x.at)) + '</span> <b>' + esc(label(x.from) + ' → ' + label(x.to)) + '</b> <small>' + esc(x.text || '') + '</small></div>';
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
  /* ======================================================= INFORMATION LEVELS
     BEGINNER  what should I do?      the decision block (the action, the price, the
                                      stake, edge / EV / confidence), the one-line
                                      answer and the main risk — nothing else
     RESEARCH  why?                   model vs market, the canonical market, best
                                      execution and the price ladder, why not a bet,
                                      reliability, break-the-number, what changes it
     LAB       how was it calculated? the probability, the gates, the price curve,
                                      the historical buckets, versions, provenance
     One card, one decision object, three depths — never three answers. */
  var LEVELS = [['beginner', 'Beginner'], ['research', 'Research'], ['lab', 'Lab']];
  function levelOf(opts) {
    opts = opts || {};
    if (opts.level === 'beginner' || opts.level === 'research' || opts.level === 'lab') return opts.level;
    var stored = readKey(KEYS.level, null);
    if (opts.beginner != null) return opts.beginner ? 'beginner' : (stored === 'lab' ? 'lab' : 'research');
    if (stored === 'beginner' || stored === 'research' || stored === 'lab') return stored;
    return beginner() ? 'beginner' : 'research';
  }
  function levelBar(lv, gid) {
    return '<div class="edd-levels" role="tablist" aria-label="Information level">' + LEVELS.map(function (l) {
      return '<button type="button" role="tab" aria-selected="' + (l[0] === lv) + '" class="edd-lv' + (l[0] === lv ? ' on' : '') + '" data-edd-act="level" data-edd-v="' + l[0] + '" data-edd-gid="' + esc(gid) + '">' + esc(l[1]) + '</button>'; }).join('') + '</div>';
  }
  function answerLine(d) { var X = XP(); var t = X ? X.oneLine(d) : d.action_reason_text; return t ? '<div class="edd-answer" data-edd-answer>' + esc(t) + '</div>' : ''; }
  function mainRiskLine(d) {
    var X = XP(); if (!X || d.decision === 'NO_DECISION') return '';
    var m = X.mainRisk(d); if (!m || !m.text) return '';
    return '<div class="edd-risk"><span class="edd-k">MAIN RISK</span> ' + esc(m.text) + '</div>';
  }
  function rowsHTML(rows) { return rows.filter(Boolean).map(function (r) { return '<div class="edd-pr"><span>' + esc(r[0]) + '</span><span>' + r[1] + '</span></div>'; }).join(''); }
  /* --------------------------------------------------------- RESEARCH */
  function whyNotBlock(d) {
    var X = XP(); if (!X) return '';
    var w = X.whyNot(d); if (!w) return '';
    var head = d.decision === 'BET' ? (w.reasons.length ? 'WHY THIS STAKE' : '') : 'WHY ISN’T THIS A BET?';
    if (!head) return '';
    return '<div class="edd-sub edd-whynot"><div class="edd-subh">' + esc(head) + '</div><p><b>' + esc(w.headline) + '</b></p>'
      + (w.reasons.length ? '<ul>' + w.reasons.slice(0, 6).map(function (r) { return '<li>' + esc(r.text) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
  }
  function marketBlock(d) {
    var M = d.market; if (!M || M.error) return '';
    var side = function (v) { return isNum(v) ? (M.market_type === 'total' ? String(v) : (M.market_type === 'moneyline' ? (100 * v).toFixed(1) + '% no-vig' : lineText(v))) : '—'; };
    var who = M.selection && M.selection.team ? M.selection.team + ' ' : '';
    var Q = M.quality || {};
    var mv = M.movement && M.movement.available ? M.movement : null;
    return '<div class="edd-sub edd-market"><div class="edd-subh">MARKET <small>' + esc(M.verification_status || '') + '</small></div>' + rowsHTML([
      ['Consensus', esc(who + side(M.consensus_line)) + ' <small>' + esc(M.consensus_basis || '') + '</small>'],
      M.sharp_reference_line != null ? ['Sharp reference', esc(who + side(M.sharp_reference_line)) + ' <small>' + esc((M.sharp_reference_books || []).join(', ')) + ' · reported beside, never as, the consensus</small>'] : null,
      ['Books', esc((M.market_depth ? M.market_depth.fresh_books : M.book_count) + ' fresh') + (M.dispersion && M.dispersion.level ? ' · dispersion ' + esc(M.dispersion.level.toLowerCase()) : '') + (isNum(M.agreement) ? ' · ' + esc(Math.round(100 * M.agreement)) + '% agree' : '')],
      ['Verification', esc(M.verification_text || '—')],
      (M.outliers || []).length ? ['Off-market', esc(M.outliers.map(function (o) { return (o.book || 'a book') + ' ' + (o.off_by > 0 ? '+' : '') + o.off_by + ' ' + (o.unit || ''); }).join(' · '))] : null,
      ['Market quality', (isNum(Q.score) ? '<b>' + esc(Q.score) + '</b> ' + esc(Q.label || '') : esc(Q.label || '—')) + ' <small>an index, not a probability</small>'],
      mv ? ['Movement', esc(side(mv.opening.value) + ' → ' + side(mv.current.value)) + ' <small>' + esc((mv.indicators || []).map(function (i) { return i.text; }).join(' ')) + '</small>'] : null
    ]) + '</div>';
  }
  /* one axis per row: the line axis names the number, the price axis names the price */
  function ladderRows(rows, axis, mt) {
    return (rows || []).map(function (x) {
      var at = axis === 'price' ? priceText(x.odds) : (mt === 'total' ? String(x.line) : lineText(x.line));
      return '<span class="edd-lad' + (x.current ? ' now' : '') + '">' + esc(at) + ' <b>' + esc(x.state) + '</b>' + (x.key ? ' <small>key ' + esc(x.key.margin) + '</small>' : '') + (x.current ? ' <small>now</small>' : '') + '</span>';
    }).join('');
  }
  function executionBlock(d) {
    var B = d.best_execution, L = d.ladder, parts = [];
    if (B && B.best) parts.push(rowsHTML([['Best execution', '<b>' + esc(B.best.label) + '</b> · ' + esc(B.best.book || '')],
      B.alternative ? ['Alternative', esc(B.alternative.label) + ' · ' + esc(B.alternative.book || '')] : null,
      B.reason ? ['Reason', esc(B.reason)] : null]));
    if (L && !L.error) {
      if ((L.by_line || []).length > 1) parts.push('<div class="edd-ladder"><span class="edd-k">AT ' + esc(L.at_price) + '</span>' + ladderRows(L.by_line, 'line', L.market_type) + '</div>');
      if ((L.by_price || []).length > 1) parts.push('<div class="edd-ladder"><span class="edd-k">AT ' + esc(L.at_line || 'THIS NUMBER') + '</span>' + ladderRows(L.by_price, 'price', L.market_type) + '</div>');
      if (L.flat) parts.push('<div class="edd-note">' + esc(L.summary) + '</div>');
      parts.push('<div class="edd-note">' + esc(L.caveat) + '</div>');
    }
    return parts.length ? '<div class="edd-sub edd-alts"><div class="edd-subh">PRICE ALTERNATIVES</div>' + parts.join('') + '</div>' : '';
  }
  function reliabilityBlock(d) {
    var X = XP(); if (!X) return '';
    var R = X.reliabilityBreakdown(d);
    if (!R.available) return '<div class="edd-sub"><div class="edd-subh">RELIABILITY</div><div class="edd-note">' + esc(R.text) + '</div></div>';
    return '<div class="edd-sub"><div class="edd-subh">' + esc(R.headline) + '</div>' + rowsHTML(R.components.map(function (c) { return [c.label, esc(c.value == null ? '—' : String(c.value) + (c.unit === '%' ? '%' : '')) + (c.detail ? ' <small>' + esc(c.detail) + '</small>' : '')]; }))
      + (R.main_deduction ? '<div class="edd-note">Main deduction: ' + esc(R.main_deduction) + '</div>' : '') + '<div class="edd-note">' + esc(R.note) + '</div></div>';
  }
  function sensitivityBlock(d) {
    var X = XP(); if (!X) return '';
    var S = X.sensitivity(d); if (!S || !S.available) return '';
    var Sc = X.scenarios(d);
    return '<div class="edd-sub edd-sens"><div class="edd-subh">BREAK THE NUMBER</div><p>' + esc(S.text) + '</p>'
      + (S.drivers.length ? rowsHTML(S.drivers.slice(0, 4).map(function (x) { return [x.label, '±' + esc(x.sd) + ' pts' + (isNum(x.sds_to_break) ? ' <small>' + esc(x.sds_to_break) + ' SD to break</small>' : '')]; })) : '')
      + (Sc && Sc.available ? '<div class="edd-scen">' + Sc.rows.map(function (r) { return '<div><span class="edd-k">' + esc(r.label) + '</span> ' + esc(r.fair_text) + ' <small>' + esc(r.state_at_current_price) + ' at the current price</small></div>'; }).join('')
        + (Sc.market_text ? '<div><span class="edd-k">MARKET</span> ' + esc(Sc.market_text) + '</div>' : '') + '<div class="edd-note">' + esc(Sc.note) + '</div></div>' : '')
      + '<div class="edd-note">' + esc(S.assumption) + '</div></div>';
  }
  function changesBlock(d, withSens) {
    var X = XP(); if (!X) return '';
    var W = X.whatChanges(d); if (!W) return '';
    /* the model row is the break-the-number sentence; when that block is shown below, point to it instead of repeating it */
    var S = withSens ? X.sensitivity(d) : null, model = S && S.available && W.model.text === S.text ? 'See Break the number below.' : W.model.text;
    return '<div class="edd-sub edd-changes"><div class="edd-subh">WHAT CHANGES MY MIND?</div>' + rowsHTML([['Price', esc(W.price.text)], ['QB', esc(W.qb.text)], ['Availability', esc(W.availability.text)], ['Model', esc(model)], ['Market', esc(W.market.text)]]) + '</div>';
  }
  function researchBlocks(d) {
    if (d.decision === 'NO_DECISION') return marketBlock(d) + changesBlock(d);
    return whyNotBlock(d) + marketBlock(d) + executionBlock(d) + changesBlock(d, true) + reliabilityBlock(d) + sensitivityBlock(d);
  }
  /* -------------------------------------------------------------- LAB */
  function labModel(d) {
    var P = d.projection;
    return '<div class="edd-sub"><div class="edd-subh">PROBABILITY MODEL</div>' + rowsHTML([
      ['Source', esc(d.probability_source_label || '—') + ' <small>' + esc((DE() && d.probability_source && DE().SOURCES[d.probability_source]) ? DE().SOURCES[d.probability_source].text : '') + '</small>'],
      ['Raw model cover', esc(probPct(d.cover_probability))], ['Decision cover', esc(probPct(d.probability))], ['Break-even', esc(probPct(d.break_even))],
      ['Raw EV', esc(pctText(d.raw_ev_pct))], ['Calibrated EV', esc(pctText(d.calibrated_ev_pct))], ['Decision EV', esc(pctText(d.decision_ev_pct))],
      ['Calibration', esc(d.calibration_version || 'none — model-estimated')],
      P ? ['Distribution', 'p10 ' + esc(P.p10) + ' · p50 ' + esc(P.p50) + ' · p90 ' + esc(P.p90) + ' <small>home margin</small>'] : null
    ]) + '</div>';
  }
  function labGates(d) {
    var X = XP(); if (!X) return '';
    return '<div class="edd-sub"><div class="edd-subh">GATES</div><div class="edd-tablewrap"><table class="edd-table edd-gates"><thead><tr><th>Gate</th><th>Status</th><th>Effect</th><th>Detail</th></tr></thead><tbody>'
      + X.gates(d).map(function (g) { return '<tr class="' + (g.binding ? 'bind' : '') + '"><td>' + esc(g.label) + '</td><td><b>' + esc(g.status) + '</b></td><td>' + esc(g.effect || '') + '</td><td>' + esc(g.text || '') + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="edd-note">Gates, not an average: a failed gate blocks or caps whatever the other inputs say. The bold row bound this decision.</div></div>';
  }
  function labCurve(d) {
    var C = d.price_curve; if (!C || !(C.points || []).length) return '';
    var rows = C.points.filter(function (p) { return p.odds === C.odds; }).sort(function (a, b) { return (a.line || 0) - (b.line || 0); });
    if (!rows.length) return '';
    return '<div class="edd-sub"><div class="edd-subh">PRICE CURVE <small>at ' + esc(priceText(C.odds)) + '</small></div><div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Line</th><th>Cover</th><th>Break-even</th><th>Edge</th><th>EV</th><th>Decision</th></tr></thead><tbody>'
      + rows.map(function (p) { return '<tr class="' + (p.current ? 'bind' : '') + '"><td>' + esc(C.market_type === 'total' ? p.line : lineText(p.line)) + '</td><td>' + esc(probPct(p.cover)) + '</td><td>' + esc(probPct(p.break_even)) + '</td><td>' + esc(ppTxt(p.edge_pp)) + '</td><td>' + esc(pctText(isNum(p.ev) ? 100 * p.ev : null)) + '</td><td>' + esc(p.cls === 'BET' ? 'BET ' + unitsText(p.units) : p.cls) + '</td></tr>'; }).join('')
      + '</tbody></table></div>' + (C.self_check ? '<div class="edd-note">Self-check: the curve classifies the current quote as ' + esc(C.self_check.classified) + '; the engine decided ' + esc(C.self_check.decided) + (C.self_check.agrees ? ' — they agree.' : ' — they differ, and the engine’s answer is the one printed.') + '</div>' : '') + '<div class="edd-note">' + esc(C.basis || '') + '</div></div>';
  }
  function healthBinsFor(d) {
    var H = S.health; if (!H) return null;
    var sp = String(d.sport || '').toUpperCase();
    var live = H.live_decisions && H.live_decisions.report && H.live_decisions.report.modes && H.live_decisions.report.modes.LIVE;
    /* the live bins pool every graded row, so they stand for a card only when
       every one of them is the card's sport (the ledger is the CFB terminal's:
       an NFL card never shows college rows as its history) */
    var liveSports = (live && live.segments && live.segments.sport && live.segments.sport.buckets) || [];
    var liveIsThisSport = liveSports.length > 0 && liveSports.every(function (b) { return String(b.bucket).toUpperCase() === sp; });
    if (live && liveIsThisSport && live.calibration && live.calibration.n) return { title: 'LIVE decisions', bins: live.calibration.bins, n: live.calibration.n, sample: live.calibration.sample };
    var wf = H.walk_forward && H.walk_forward[sp] && H.walk_forward[sp].markets && H.walk_forward[sp].markets.spread;
    var b = wf ? (d.probability_source === 'model_estimated' ? wf.raw_model_held_out : wf.blend_held_out) : null;
    if (b && b.bins && b.bins.length) return { title: 'Walk-forward ' + sp + ' spread (' + (d.probability_source === 'model_estimated' ? 'raw model' : 'pricing blend') + ', held out)', bins: b.bins.map(function (x) { return { label: x.bucket, n: x.n, expected: x.expected, observed: x.observed, error_pp: x.error_pp, sample: { key: x.sample } }; }), n: b.n, brier: b.brier, base: b.brier_base_rate };
    var lab = H.cfb_lab && H.cfb_lab.report && H.cfb_lab.report.modes && H.cfb_lab.report.modes.LIVE_RECONSTRUCTED;
    if (sp === 'CFB' && lab && lab.calibration && lab.calibration.n) return { title: 'CFB Lab (live, reconstructed)', bins: lab.calibration.bins, n: lab.calibration.n, sample: lab.calibration.sample };
    return null;
  }
  function labHistory(d) {
    if (!S.health) { ensureHealth(); return '<div class="edd-sub"><div class="edd-subh">HISTORICAL BUCKETS</div><div class="edd-note">' + (S.healthErr ? 'Model health did not load (' + esc(S.healthErr) + ').' : 'Loading model health…') + '</div></div>'; }
    var B = healthBinsFor(d);
    if (!B) return '<div class="edd-sub"><div class="edd-subh">HISTORICAL BUCKETS</div><div class="edd-note">No graded probabilities of this kind are on file yet.</div></div>';
    return '<div class="edd-sub"><div class="edd-subh">HISTORICAL BUCKETS <small>' + esc(B.title) + ' · n=' + esc(B.n) + '</small></div><div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Predicted</th><th>n</th><th>Expected</th><th>Observed</th><th>Error</th></tr></thead><tbody>'
      + B.bins.map(function (b) { return '<tr><td>' + esc(b.label) + '</td><td>' + esc(b.n) + '</td><td>' + esc(probPct(b.expected)) + '</td><td>' + esc(probPct(b.observed)) + '</td><td>' + esc(isNum(b.error_pp) ? (b.error_pp >= 0 ? '+' : '−') + Math.abs(b.error_pp).toFixed(1) + ' pp' : '—') + '</td></tr>'; }).join('')
      + '</tbody></table></div>' + (isNum(B.brier) ? '<div class="edd-note">Brier ' + esc(B.brier) + ' vs base rate ' + esc(B.base) + ' (n=' + esc(B.n) + ').</div>' : '') + '<div class="edd-note">Measurement only: nothing is recalibrated from this table, and a bucket under 50 is descriptive.</div></div>';
  }
  function labVersions(d) {
    var Vv = d.versions || {}, X = XP();
    var prov = X ? X.provenance(d) : [];
    return '<div class="edd-sub"><div class="edd-subh">VERSIONS &amp; PROVENANCE</div>' + rowsHTML([
      ['Model', esc(Vv.model || d.model_version || '—')], ['Calibration', esc(Vv.calibration || d.calibration_version || 'none')], ['Pricing engine', esc(Vv.pricing_engine || d.pricing_model_version || '—')],
      ['Decision engine', esc((Vv.decision_engine || d.decision_engine_version || '—') + ' · rules ' + (Vv.decision_rules || d.config_version || '—'))],
      Vv.market_engine ? ['Market · execution', esc(Vv.market_engine + ' · ' + (Vv.execution_engine || '—'))] : null,
      ['Data as of', esc(Vv.data_snapshot_at ? fmtTime(Vv.data_snapshot_at) : '—') + (Vv.leakage_ok === false ? ' <b class="edd-warn">an input is newer than the evaluation</b>' : '')]
    ]) + (prov.length ? '<div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Input</th><th>Source</th><th>Updated</th><th>Pricing impact</th></tr></thead><tbody>'
      + prov.map(function (p) { return '<tr><td>' + esc(p.what) + '</td><td>' + esc(p.source || '—') + (p.confidence ? ' <small>' + esc(p.confidence) + '</small>' : '') + '</td><td>' + esc(p.updated || '—') + '</td><td>' + esc(p.pricing_impact || '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '')
      + '<div class="edd-note">The additive terms behind EdgeDesk’s number are in the full research below; this decision records the versions that produced it and is never re-priced by a later model.</div></div>';
  }
  function labBlocks(d) {
    if (d.decision === 'NO_DECISION') return labGates(d) + labVersions(d);
    return labModel(d) + labGates(d) + labCurve(d) + labHistory(d) + labVersions(d);
  }
  /* ------------------------------------------------------ THE EXPORT
     One row per decision, read off the canonical object and nothing else:
     the decision, the exact quote, the one-line answer, the canonical market,
     the best execution, the main risk, every version and the data time. */
  var CSV_HEAD = ['game_id', 'sport', 'kickoff', 'matchup', 'decision', 'qualifier', 'units', 'selection', 'line', 'odds', 'book', 'one_line', 'reason_code',
    'playable_to', 'bet_trigger', 'edge_pp', 'raw_ev_pct', 'calibrated_ev_pct', 'decision_ev_pct', 'probability_source', 'decision_confidence', 'reliability',
    'market_consensus_line', 'market_sharp_reference_line', 'market_fresh_books', 'market_verification', 'market_quality_index', 'best_execution', 'best_execution_reason',
    'main_risk', 'model_version', 'calibration_version', 'pricing_engine', 'decision_engine', 'decision_rules', 'version_key', 'data_snapshot_at', 'evaluated_at', 'decision_id'];
  function csvCell(v) { if (v == null) return ''; var t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
  function decisionRow(d) {
    var X = XP(), q = sel(d), M = d.market && !d.market.error ? d.market : {}, Vv = d.versions || {}, B = d.best_execution && d.best_execution.best;
    return [d.game_id, d.sport, d.kickoff, (d.away || '') + ' @ ' + (d.home || ''), d.decision, d.decision_qualifier, d.decision === 'BET' ? d.recommended_units : 0,
      selText(d), q ? q.line : null, q ? q.odds : null, q ? q.book : null, X ? X.oneLine(d) : d.action_reason_text, d.action_reason_code,
      d.playable ? d.playable.short : null, d.decision !== 'BET' && d.bet_trigger ? d.bet_trigger.short : null, d.edge_pp, d.raw_ev_pct, d.calibrated_ev_pct, d.decision_ev_pct,
      d.probability_source, d.decision_confidence, d.reliability_score, M.consensus_line, M.sharp_reference_line, M.market_depth ? M.market_depth.fresh_books : null,
      M.verification_status, M.quality ? M.quality.score : null, B ? B.label + ' · ' + B.book : null, d.best_execution ? d.best_execution.reason : null,
      X && X.mainRisk(d) ? X.mainRisk(d).text : null, d.model_version, d.calibration_version, Vv.pricing_engine || d.pricing_model_version, d.decision_engine_version,
      d.config_version, Vv.version_key, d.data_snapshot_at || Vv.data_snapshot_at, d.evaluated_at, d.decision_id];
  }
  function decisionsCSV(list) {
    return [CSV_HEAD.join(',')].concat((list || []).map(function (d) { return decisionRow(d).map(csvCell).join(','); })).join('\n') + '\n';
  }
  function downloadCSV(list) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
    var url = URL.createObjectURL(new Blob([decisionsCSV(list)], { type: 'text/csv' }));
    var a = document.createElement('a'); a.href = url; a.download = 'edgedesk_decisions_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  /* ------------------------------------------------------ MODEL HEALTH */
  function ensureHealth() {
    if (S.health || S.healthP || typeof fetch !== 'function') return S.healthP;
    S.healthP = fetch('football/validation/model_health.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('model_health.json ' + r.status); return r.json(); })
      .then(function (j) { S.health = j; S.healthP = null; healthArrived(); return j; })
      .catch(function (e) { S.healthErr = String(e && e.message || e).slice(0, 120); S.healthP = null; });
    return S.healthP;
  }
  /* model health changes only the Card page and the Lab sections: refresh
     those in place, never the boards (a board repaint would close the game
     card the reader has open) */
  function healthArrived() {
    if (typeof document === 'undefined') return;
    if (S.host && document.body.contains(S.host) && S.host.offsetParent !== null) paintCard();
    Array.prototype.forEach.call(document.querySelectorAll('.edd-act[data-edd-level="lab"]'), function (sec) {
      var dd = findDecision(sec.getAttribute('data-edd-game'));
      if (!dd || !sec.parentNode) return;
      var tmp = document.createElement('div'); tmp.innerHTML = actionCardHTML(dd, { level: 'lab', mobile: sec.classList.contains('edd-compact') });
      if (tmp.firstChild) sec.parentNode.replaceChild(tmp.firstChild, sec);
    });
  }
  function nPct(x, n) { return isNum(x) ? (100 * x).toFixed(1) + '% <small>n=' + esc(n) + '</small>' : '— <small>n=' + esc(n || 0) + '</small>'; }
  function healthModeRow(label, A) {
    if (!A) return '';
    return '<tr><td>' + esc(label) + '</td><td>' + esc(A.n) + '</td><td>' + nPct(A.observed_cover, A.decided) + '</td><td>' + nPct(A.expected_cover, A.expected_n) + '</td><td>'
      + (isNum(A.clv.mean) ? esc((A.clv.mean >= 0 ? '+' : '') + A.clv.mean) + ' pts' : '—') + ' <small>n=' + esc(A.clv.n) + (A.clv.n ? ' · ' + A.clv.beat + '/' + A.clv.tie + '/' + A.clv.lose : '') + '</small></td><td>'
      + (isNum(A.roi) ? esc(pctText(100 * A.roi)) : '—') + ' <small>n=' + esc(A.roi_n) + '</small></td><td><small>' + esc(A.sample.label) + '</small></td></tr>';
  }
  function modelHealthHTML(H, opts) {
    opts = opts || {};
    if (!H) return '<details class="edd-sec" data-edd-fold="showHealth"' + (opts.open ? ' open' : '') + '><summary class="edd-sech">MODEL HEALTH</summary><div class="edd-note">' + (S.healthErr ? 'Model health did not load (' + esc(S.healthErr) + ').' : 'Loading model health…') + '</div></details>';
    var h = '<details class="edd-sec edd-health" data-edd-fold="showHealth"' + (opts.open ? ' open' : '') + '><summary class="edd-sech">MODEL HEALTH <small>as of ' + esc(H.as_of ? fmtTime(H.as_of, { month: 'short', day: 'numeric' }) : '—') + '</small></summary>';
    h += '<div class="edd-maturity">' + (H.maturity || []).map(function (m) { return '<div class="' + (m.available ? 'on' : '') + '"><b>' + esc(m.label) + '</b><span>n=' + esc(m.n) + '</span><small>' + esc(m.sample ? m.sample.label : '') + '</small></div>'; }).join('<i>→</i>') + '</div>';
    var L = H.live_decisions || {};
    var issued = L.issued_by_decision || {};
    h += '<div class="edd-subh">LIVE DECISIONS</div><div class="edd-note">' + esc(L.issued_snapshots || 0) + ' decision snapshots issued before kickoff (' + Object.keys(issued).map(function (k) { return esc(k.replace('_', ' ')) + ' ' + esc(issued[k]); }).join(' · ') + ') · ' + esc(L.graded_rows || 0) + ' graded · ' + esc(L.unit_of_analysis || '') + '</div>';
    var head = '<div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Group</th><th>Rows</th><th>Observed cover</th><th>Expected cover</th><th>CLV (beat/tie/lose)</th><th>ROI</th><th>Sample</th></tr></thead><tbody>';
    var liveModes = (L.report && L.report.modes) || {};
    var liveRows = Object.keys(liveModes).map(function (m) { var M = liveModes[m]; return healthModeRow(M.label + ' · all', M.all) + (M.segments && M.segments.decision ? M.segments.decision.buckets.map(function (b) { return healthModeRow(M.label + ' · ' + b.bucket, b); }).join('') : ''); }).join('');
    h += liveRows ? head + liveRows + '</tbody></table></div>' : '<div class="edd-empty">No graded live decision yet: grades arrive after the close and the final.</div>';
    var lab = (H.cfb_lab && H.cfb_lab.report && H.cfb_lab.report.modes) || {};
    var labRows = Object.keys(lab).map(function (m) { var M = lab[m]; return healthModeRow('CFB Lab · ' + M.label, M.all) + (M.segments && M.segments.decision ? M.segments.decision.buckets.map(function (b) { return healthModeRow('CFB Lab · ' + M.label + ' · ' + b.bucket, b); }).join('') : ''); }).join('');
    if (labRows) h += '<div class="edd-subh">CFB LAB <small>model-level · each mode apart</small></div>' + head + labRows + '</tbody></table></div>';
    var wf = H.walk_forward || {};
    var wfRows = Object.keys(wf).map(function (k) { var s0 = wf[k].markets && wf[k].markets.spread; if (!s0) return ''; var b = s0.blend_held_out; return '<div class="edd-pr"><span>Walk-forward ' + esc(k) + ' spread</span><span>tier ' + esc(s0.tier || '—') + ' · n=' + esc(s0.n) + (b ? ' · blend Brier ' + esc(b.brier) + ' vs base ' + esc(b.brier_base_rate) + ' (n=' + esc(b.n) + ')' : '') + '</span></div>'; }).join('');
    if (wfRows) h += '<div class="edd-subh">WALK-FORWARD <small>held out, as published</small></div>' + wfRows;
    var rec = (H.live_model_record && H.live_model_record.sports) || {};
    var recRows = Object.keys(rec).map(function (k) { var x = rec[k]; return '<div class="edd-pr"><span>Live model record ' + esc(k.toUpperCase()) + '</span><span>ATS ' + esc(x.ats.w + '-' + x.ats.l + '-' + x.ats.p) + (isNum(x.ats.pct) ? ' (' + esc(x.ats.pct) + '%, n=' + esc(x.ats.n) + ')' : ' (n=' + esc(x.ats.n) + ')') + ' · CLV ' + esc(x.clv_spread_entry.avg == null ? '—' : x.clv_spread_entry.avg + ' pts') + ' (n=' + esc(x.clv_spread_entry.n) + ') <small>' + esc(x.ats.sample.label) + '</small></span></div>'; }).join('');
    if (recRows) h += '<div class="edd-subh">LIVE MODEL RECORD <small>the published fair line, not bettor decisions</small></div>' + recRows;
    var al = (H.alerts || []);
    if (al.length) h += '<div class="edd-subh">RESEARCH ALERTS <small>' + al.length + ' · for a person to review, never an automatic change</small></div>' + al.slice(0, 8).map(function (a) { return '<div class="edd-alert ' + (a.severity === 'INFO' ? 'info' : '') + '">' + esc(a.text) + '</div>'; }).join('');
    h += '<div class="edd-note">' + esc(H.rule || '') + '</div></details>';
    return h;
  }

  /* the unit tier's rule: a conservative default until its own sample validates it */
  /* a stake tier by its size, never by a decision word ("BET" is the decision) */
  var TIER_WORD = { SMALL: 'small tier', STANDARD: 'standard tier', STRONG: 'strong tier', MAX: 'max tier', QUALIFIED: 'small tier', VERY_STRONG: 'strong tier' };
  function tierWord(d) { var k = d && (d.tier || d.strength); return k && TIER_WORD[k] ? TIER_WORD[k] : null; }
  function unitRule(units) {
    var Vo = V(), perf = S.build && S.build.performance, n = 0, validated = false;
    var key = isNum(units) ? (Math.round(units * 100) / 100).toFixed(2) + 'U' : null;
    ((perf && perf.by_tier) || []).forEach(function (r) { if (r.group === key) n = r.settled || 0; });
    var vt = S.build && S.build.validation && S.build.validation.validated_tiers;
    if (vt && key && (Array.isArray(vt) ? vt.indexOf(key) >= 0 : vt[key])) validated = true;
    return Vo ? Vo.unitRuleOf(n, validated) : { validated: false, label: 'Current conservative sizing rule', text: 'Current conservative sizing rule' };
  }
  function field(k, v, key, cls) { return '<div class="edd-f1' + (cls ? ' ' + cls : '') + '"><div class="edd-fk">' + (key ? tip(key, k) : esc(k)) + '</div><div class="edd-fv">' + v + '</div></div>'; }
  /* the realistic BET-trigger options; a decision published before options
     existed carries only its short text, which was already the trigger */
  function realOptions(t) {
    if (!t) return [];
    if (Array.isArray(t.options)) return t.options.filter(function (o) { return o.realistic; });
    return t.short ? [{ kind: 'legacy', text: String(t.short).replace(/ or better$/, ''), realistic: true }] : [];
  }
  /* the BET trigger as options a reader can act on: "X or Y or better" */
  function triggerOptions(d) {
    var t = d.bet_trigger;
    if (!t) return null;
    if (t.already_clears) return { already: true, html: '<span class="edd-tr-opt">' + esc(d.watch && d.watch.trigger ? d.watch.trigger : t.text) + '</span>' };
    var real = realOptions(t);
    if (!real.length) return { none: true, html: '<span class="edd-none-trig">' + esc(V() ? V().COPY.no_realistic_trigger : 'NO REALISTIC BET TRIGGER AT CURRENT MODEL STATE') + '</span>' };
    return { options: real, html: real.map(function (o) { return '<span class="edd-tr-opt"><b>' + esc(o.text) + '</b></span>'; }).join('<span class="edd-or">OR</span>') + ' <small>or better</small>' };
  }
  function waitingOnText(d) {
    var t = d.bet_trigger, w = (d.waiting_on || [])[0];
    if (w && w.code !== 'PRICE') return w.text.charAt(0).toUpperCase() + w.text.slice(1) + '.';
    var real = realOptions(t);
    var line = real.some(function (o) { return o.kind === 'line'; }), price = real.some(function (o) { return o.kind === 'price'; });
    return line && price ? 'A better spread or price.' : (line ? 'A better spread.' : (price ? 'A better price.' : (real.length ? 'A better spread or price.' : 'A better price.')));
  }
  function marketChip(d) {
    var M = d.market_state; if (!M) return '';
    var q = d.quote, age = q && isNum(q.age_minutes) ? (q.age_minutes < 60 ? Math.max(1, Math.round(q.age_minutes)) + 'm old' : Math.round(q.age_minutes / 60) + 'h old') : null;
    var extra = M.key === 'LIVE_MARKET' || M.key === 'THIN_MARKET' ? [q && q.sportsbook, age].filter(Boolean).join(' · ') : (M.reason || '');
    return '<span class="edd-layer edd-ms edd-ms-' + esc(String(M.tone || '').toLowerCase()) + '" title="' + esc(M.means + (M.reason ? ' (' + M.reason + ')' : '')) + '"><span class="edd-lk">' + tip('market_state', 'MARKET') + '</span> <b>' + esc(M.label) + '</b>' + (extra ? ' <small>' + esc(extra) + '</small>' : '') + '</span>';
  }
  function researchChip(d) {
    if (!d.research_label && !d.research_status) return '';
    return '<span class="edd-layer edd-rs" title="' + esc((V() ? V().HELP.research_status : '')) + '"><span class="edd-lk">' + tip('research_status', 'RESEARCH') + '</span> <i>' + esc(d.research_label || String(d.research_status).replace(/_/g, ' ')) + '</i> <small>not a bet signal</small></span>';
  }
  function layerStrip(d, begin) {
    if (begin) return '';
    var h = marketChip(d) + researchChip(d);
    return h ? '<div class="edd-layers" data-edd-layers>' + h + '</div>' : '';
  }
  /* the warnings a bettor must see: a non-live market, an extreme raw EV, material flags */
  function warningLines(d, max) {
    var E = DE(), out = [];
    var M = d.market_state;
    if (M && M.key !== 'LIVE_MARKET' && d.decision !== 'NO_DECISION') out.push(M.label + ': ' + (M.reason || M.means));
    (E && E.importantWarnings ? E.importantWarnings(d) : []).forEach(function (w) { if (!(w.code === 'SINGLE_BOOK' && M && M.key === 'THIN_MARKET')) out.push(w.text); });
    return out.slice(0, max || 3);
  }
  function warnBlock(d, max) {
    var w = warningLines(d, max);
    return w.length ? '<div class="edd-warnbox"><span class="edd-k">IMPORTANT</span><ul>' + w.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
  }
  function qualChip(d) { return d.decision_qualifier ? ' <span class="edd-qual">' + esc(d.decision_qualifier) + '</span>' : ''; }
  function quoteText(d, q) { return q ? esc(selText(d)) + ' (' + esc(priceText(q.odds)) + ')' + (q.book ? ' <small>' + esc(q.book) + '</small>' : '') : '<small>no quote</small>'; }
  function confidenceText(d) {
    return (isNum(d.decision_confidence) ? esc(d.decision_confidence) + '/100 <small>' + esc(d.decision_confidence_label || '') + '</small>' : '—')
      + (d.probability_source ? ' <small>· ' + esc(SRC_SHORT[d.probability_source] || '') + ' probability</small>' : '');
  }
  function evText(d) {
    var E = DE(), L = E && E.evLabels ? E.evLabels(d) : null;
    return L ? '<b>' + esc(pctText(L.decision_ev_pct)) + '</b>' : '—';
  }
  function actionCardHTML(d, opts) {
    opts = opts || {};
    if (!d) return '';
    var E = DE(), K = kind(d), tone = TONE[K] || 'none', Vo = V();
    var lv = levelOf(opts);
    var begin = lv === 'beginner';
    var compact = !!opts.compact || !!opts.mobile;
    var t = opts.track !== undefined ? opts.track : trackFor(d.game_id);
    var q = sel(d);
    var why1 = E ? E.oneSentence(d) : d.action_reason_text;
    var h = '<section class="edd-act edd-' + tone + (begin ? ' edd-begin' : '') + ' edd-lv-' + lv + (compact ? ' edd-compact' : '') + '" data-edd-game="' + esc(d.game_id) + '" data-edd-level="' + lv + '" aria-label="EdgeDesk decision: ' + esc(d.decision_display || d.decision_label) + '">';
    h += '<header class="edd-h"><span class="edd-k">EDGEDESK DECISION' + (d.sport ? ' · ' + esc(d.sport) : '') + (d.market_type ? ' · ' + esc(String(d.market_type).toUpperCase()) : '') + '</span><span class="edd-when" title="' + esc(d.evaluated_at || '') + '">Last evaluated ' + esc(fmtTime(d.evaluated_at)) + (d.provisional ? ' · provisional (calibration loading)' : '') + '</span></header>';
    h += levelBar(lv, d.game_id);
    /* LEVEL 1: the decision, then the exact action or the exact reason */
    if (K === 'BET') {
      var dlv = BK() ? BK().dollars(d.recommended_units, settings()) : null;
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-bet">BET</span> <span class="edd-units">· ' + esc(unitsText(d.recommended_units)) + (dlv != null ? ' · ' + money(dlv) : '') + '</span>' + (begin ? '' : qualChip(d)) + '</div>';
      h += '<div class="edd-sel">' + esc(selText(d, true)) + '</div>';
      h += '<div class="edd-price">' + esc(priceText(q.odds)) + ' · ' + esc(q.book || '') + (d.selected_is_alternate ? ' · <small>alternate line</small>' : '') + '</div>';
      h += '<div class="edd-exec">'
        + field('WHAT', '<b>' + esc(selText(d)) + '</b>')
        + field('WHERE', esc(q.book || '—'))
        + field('PRICE', '<b>' + esc(priceText(q.odds)) + '</b>')
        + field('HOW MUCH', '<b>' + esc(unitsText(d.recommended_units)) + '</b> ' + dollarsLine(d) + '<div class="edd-fn">' + esc(unitRule(d.recommended_units).text) + '</div>', 'unit')
        + field('PLAYABLE TO', '<b>' + esc(playableText(d) || 'Current price only') + '</b>', 'playable_to')
        + field('EDGE', '<b>' + esc(ppTxt(d.edge_pp)) + '</b>', 'edge', 'pos')
        + field(isNum(d.calibrated_ev_pct) ? 'CALIBRATED EV' : 'MODEL-ESTIMATED EV', evText(d), isNum(d.calibrated_ev_pct) ? 'calibrated_ev' : 'model_estimated_ev', 'pos')
        + field('CONFIDENCE', confidenceText(d), 'decision_confidence')
        + '</div>';
      h += '<div class="edd-why1"><span class="edd-k">WHY</span> ' + esc(why1) + '</div>';
      var inv = [];
      if (d.playable && d.playable.mode === 'RANGE') inv.push('The line moves past ' + lineText(d.playable.min_line) + ' or the price past ' + priceText(d.playable.max_odds) + '.');
      else if (q) inv.push('Any worse line or price than ' + lineText(q.line) + ' (' + priceText(q.odds) + ').');
      warningLines(d, 3).forEach(function (w) { inv.push(w); });
      h += '<div class="edd-cancel1"><span class="edd-k">WHAT COULD INVALIDATE IT</span><ul>' + inv.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    } else if (K === 'WATCH') {
      var TO = triggerOptions(d);
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-watch">WATCH</span>' + qualChip(d) + ' <span class="edd-dnb">' + esc(Vo ? Vo.COPY.do_not_bet_yet : 'DO NOT BET YET') + '</span></div>';
      h += '<div class="edd-f2"><span class="edd-k">CURRENT PRICE</span> <span class="edd-sel-quiet">' + quoteText(d, q) + '</span></div>';
      h += '<div class="edd-f2"><span class="edd-k">REASON</span> ' + esc(d.action_reason_text) + '</div>';
      if (TO) h += '<div class="edd-trigger"><span class="edd-k">' + tip('bet_trigger', 'BET TRIGGER') + '</span> ' + TO.html + '</div>';
      h += '<div class="edd-waiting"><span class="edd-k">WAITING ON</span> ' + esc(waitingOnText(d)) + '</div>';
      h += '<div class="edd-next"><span class="edd-k">NEXT CHECK</span> ' + esc(d.next_check || (Vo ? Vo.COPY.reevaluates : '')) + '</div>';
    } else if (K === 'LEAN') {
      var TL = triggerOptions(d);
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-lean">LEAN</span> <span class="edd-sub1">0U · no stake</span>' + qualChip(d) + '</div>';
      h += '<div class="edd-f2"><span class="edd-k">CURRENT PRICE</span> <span class="edd-sel-quiet">' + quoteText(d, q) + '</span></div>';
      h += '<div class="edd-f2"><span class="edd-k">WHY NOT A BET</span> ' + esc(why1) + '</div>';
      if (TL) h += '<div class="edd-trigger"><span class="edd-k">' + tip('bet_trigger', 'BET AT') + '</span> ' + TL.html + '</div>';
    } else if (K === 'PASS') {
      var TP = triggerOptions(d);
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-pass">PASS</span> <span class="edd-sub1">Current price does not justify a wager.</span></div>';
      h += '<div class="edd-f2"><span class="edd-k">' + tip('best_available', 'BEST AVAILABLE') + '</span> <span class="edd-sel-quiet">' + quoteText(d, q) + '</span></div>';
      h += '<div class="edd-reason1"><span class="edd-k">WHY</span> ' + esc(d.action_reason_text) + '</div>';
      h += '<div class="edd-trigger"><span class="edd-k">' + tip('bet_trigger', 'BET TRIGGER') + '</span> ' + (TP ? TP.html : '<span class="edd-none-trig">' + esc(Vo ? Vo.COPY.no_realistic_trigger : '') + '</span>') + '</div>';
    } else {
      h += '<div class="edd-verdict"><span class="edd-badge edd-b-none">NO DECISION</span></div>';
      h += '<p class="edd-lead">' + esc(d.action_reason_text) + '</p>';
      if ((d.blocker_codes || []).length && !begin) h += '<div class="edd-reason1"><span class="edd-k">BLOCKER</span> ' + esc(d.blocker_codes.join(', ')) + ' <small>required information is missing or unusable — EdgeDesk cannot evaluate this wager</small></div>';
      if (d.model_fair_text) h += '<div class="edd-f2"><span class="edd-k">MODEL</span> ' + esc(d.model_fair_text) + '</div>';
      var lk = d.reference_quote && d.reference_quote.last_known ? d.reference_quote : null;
      if (lk) h += '<div class="edd-f2"><span class="edd-k">LAST KNOWN PRICE</span> ' + esc(lk.label + (lk.book ? ' · ' + lk.book : '')) + ' <small>not a current price</small></div>';
      else if (d.consensus_text) h += '<div class="edd-f2"><span class="edd-k">CONSENSUS LINE</span> ' + esc(d.consensus_text) + ' <small>a line without a current priced quote</small></div>';
    }
    /* the one-line answer (EDExplain.oneLine) and the one risk that matters most */
    h += answerLine(d) + mainRiskLine(d);
    /* the layers the decision is not: the market state and the research status */
    h += layerStrip(d, begin);
    /* the numbers every non-BET still answers in one glance */
    if (K !== 'BET' && K !== 'NO_DECISION') {
      h += '<div class="edd-mini">' + '<span>' + tip('edge', 'EDGE') + ' <b>' + esc(ppTxt(d.edge_pp)) + '</b></span>'
        + '<span>' + tip(isNum(d.calibrated_ev_pct) ? 'calibrated_ev' : 'model_estimated_ev', isNum(d.calibrated_ev_pct) ? 'CALIBRATED EV' : 'MODEL-ESTIMATED EV') + ' ' + evText(d) + '</span>'
        + '<span>' + tip('decision_confidence', 'CONFIDENCE') + ' ' + confidenceText(d) + '</span></div>';
      h += warnBlock(d, 2);
    }
    if (begin) {
      /* BEGINNER: the decision above is the whole card; the diagnostics live in Advanced */
      h += '<div class="edd-acts">'
        + (K === 'BET' ? '<button type="button" class="edd-btn edd-btn-bet" data-edd-act="placed" data-edd-gid="' + esc(d.game_id) + '">BET PLACED</button>' : '')
        + '<button type="button" class="edd-btn" data-edd-act="advanced">Advanced view</button>'
        + '<button type="button" class="edd-btn edd-btn-quiet" data-edd-act="research" data-edd-gid="' + esc(d.game_id) + '">View full research ↓</button></div>';
      h += '<div class="edd-valid">' + validLine(d, true) + '</div>';
      h += '<div class="edd-form" data-edd-form="' + esc(d.game_id) + '"></div></section>';
      return h;
    }
    var reason = '';
    if (K !== 'NO_DECISION') {
      reason += metricsGrid(d, compact);
      reason += '<div class="edd-why"><div class="edd-subh">' + (K === 'BET' ? 'WHY IT QUALIFIES' : (K === 'PASS' ? 'WHY PASS' : 'WHY')) + '</div><p>' + esc(E && E.whyText ? E.whyText(d) : d.action_reason_text) + '</p></div>';
      if (K === 'BET') reason += '<div class="edd-cancel"><div class="edd-subh">WHAT CANCELS IT</div><ul>' + (d.invalidation_conditions || []).map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
      if (K !== 'BET' && d.bet_trigger && d.bet_trigger.caveat) reason += '<div class="edd-note">' + esc(d.bet_trigger.caveat) + '</div>';
      if (K !== 'BET') reason += '<div class="edd-note">No unit recommendation.</div>';
    }
    reason += priceTypes(d);
    reason += otherMarketsBlock(d);
    /* RESEARCH: why — the canonical market, price alternatives, what changes it */
    reason += researchBlocks(d);
    var deeper = alternativesBlock(d) + trackBlock(d, t) + placedBlock(d) + auditBlock(d);
    var openReason = !compact;
    h += '<details class="edd-reason"' + (openReason ? ' open' : '') + '><summary>View reasoning</summary>' + reason
      + '<details class="edd-deep"><summary>Prices, history and audit</summary>' + deeper + '</details></details>';
    /* LAB: how it was calculated — never on the beginner card */
    h += '<details class="edd-lab"' + (lv === 'lab' ? ' open' : '') + '><summary>Lab · how it was calculated</summary>' + labBlocks(d) + '</details>';
    h += transitionLine(t);
    h += '<div class="edd-acts">'
      + (K === 'BET' ? '<button type="button" class="edd-btn edd-btn-bet" data-edd-act="placed" data-edd-gid="' + esc(d.game_id) + '">BET PLACED</button>' : '')
      + '<button type="button" class="edd-btn" data-edd-act="research" data-edd-gid="' + esc(d.game_id) + '">VIEW FULL RESEARCH ↓</button>'
      + '<button type="button" class="edd-btn edd-btn-quiet" data-edd-act="card">EdgeDesk Card</button></div>';
    h += '<div class="edd-valid">' + validLine(d, false) + '</div>';
    h += '<div class="edd-form" data-edd-form="' + esc(d.game_id) + '"></div>';
    h += '</section>';
    return h;
  }
  /* intentional status text, never a floating "?": what the rules are, how
     far validation has come, and that research is not the decision */
  function validLine(d, begin) {
    var Vo = V(), SL = Vo ? Vo.STATUS_LINE : null;
    if (!SL) return '';
    var parts = [
      '<span class="edd-sl">' + tip('validation', SL.decision_rules.label) + ' <b>' + esc(SL.decision_rules.value) + '</b></span>',
      '<span class="edd-sl">' + esc(SL.live_validation.label) + ' <b>' + esc(SL.live_validation.value) + '</b></span>'
    ];
    if (d.probability_source) parts.push('<span class="edd-sl">' + tip('probability_source', 'Calibration') + ' <b>' + esc(SL.calibration[d.probability_source] || '') + '</b></span>');
    if (!begin) parts.push('<span class="edd-sl">' + tip('research_status', SL.research_status.label) + ' <b>' + esc(SL.research_status.value) + '</b></span>');
    return parts.join('<span class="edd-dot">·</span>');
  }
  /* the compact chip a board row carries: the decision, styled as a decision */
  function chipHTML(d) {
    if (!d) return '';
    var K = kind(d), tone = TONE[K] || 'none', q = sel(d);
    var lbl = K === 'BET' ? 'BET · ' + unitsText(d.recommended_units) : label(K);
    var extra = K === 'BET' && q ? ' ' + (q.team || '') + ' ' + lineText(q.line) + ' (' + priceText(q.odds) + ')' + (d.playable ? ' · to ' + d.playable.short : '')
      : (K === 'WATCH' ? ' · do not bet yet' + (d.decision_qualifier ? ' · ' + d.decision_qualifier.toLowerCase() : '') : (K === 'LEAN' && q ? ' ' + (q.team || '') + ' ' + lineText(q.line) + ' · 0U' : ''));
    var ms = d.market_state && d.market_state.key !== 'LIVE_MARKET' ? ' · ' + d.market_state.label.toLowerCase() : '';
    return '<span class="edd-chip edd-c-' + tone + '" title="Decision: ' + esc((XP() ? XP().oneLine(d) : null) || d.action_reason_text || '') + '"><span class="edd-chip-k">DECISION</span> <b>' + esc(lbl) + '</b>' + esc(extra + ms) + '</span>';
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
  /* THE CARD'S POSITIONS: EdgeDesk's pregame game decisions and the reader's
     saved opportunities (game markets and player props), one bankroll
     (EDOpportunity.cardPositions). A saved entry is frozen; what the market
     says now is read beside it. */
  function positionsOf(list, opts) {
    var X = OPP(), ents = opts && opts.entries ? opts.entries : entries();
    if (!X) return (list || []).map(function (d) { return { pos_key: 'game|' + d.game_id, source: 'engine', type: 'GAME', sport: d.sport, game_id: String(d.game_id), kickoff: d.kickoff, decision: kind(d), recommended_units: d.recommended_units, side: d.side, market_type: d.market_type || 'spread', tier: d.tier || d.strength, calibrated_ev_pct: d.calibrated_ev_pct, decision_obj: d, entry: null }; });
    var pos = X.cardPositions(list || [], ents, Date.now());
    pos.forEach(function (p) { if (p.entry && p.type === 'PLAYER_PROP') p.current = S.propCur[p.entry.entry_id] || null; });
    return pos;
  }
  function openSaved(p, now) { var k = Date.parse(p.kickoff), n = typeof now === 'number' ? now : Date.parse(now); return !isFinite(k) || k > (isFinite(n) ? n : Date.now()); }
  function propModels() {
    var U = root.EDPropsUI, m = {};
    ['nfl', 'cfb'].forEach(function (lg) { var sm = U && U.state && U.state.summaries ? U.state.summaries[lg] : null; if (sm && sm.correlation) m[lg] = sm.correlation; });
    return m;
  }
  function homeOf(eventKey) {
    var U = root.EDPropsUI, X = OPP(), k = X ? X.splitKey(eventKey) : null;
    var sm = k && U && U.state && U.state.summaries ? U.state.summaries[k.league] : null, ev = sm && sm.events ? sm.events[k.game_id] : null;
    return ev ? ev.home : null;
  }
  function summary(list, opts) {
    list = list || mergedDecisions();
    var pos = positionsOf(list, opts).filter(function (p) { return p.source !== 'saved' || openSaved(p, opts && opts.now); });
    var c = { BET: 0, LEAN: 0, WATCH: 0, PASS: 0, NO_DECISION: 0 }, last = null;
    pos.forEach(function (p) { var k = p.decision === 'WAIT' ? 'WATCH' : p.decision; c[k] = (c[k] || 0) + 1; var at = p.entry ? p.entry.evaluated_at : (p.decision_obj ? p.decision_obj.evaluated_at : null), e = Date.parse(at); if (isFinite(e) && (last == null || e > last)) last = e; });
    var tz = (function () { try { return -new Date().getTimezoneOffset(); } catch (e) { return 0; } })();
    var X = OPP();
    /* opts.now: the clock a position is open against (a test's fixed clock); the page leaves it unset and reads the real one */
    var ex = X ? X.cardExposure(pos, settings(), { tz_offset_minutes: tz, models: propModels(), homeOf: homeOf, now: opts && opts.now })
      : (BK() ? BK().exposure(list, settings(), { tz_offset_minutes: tz }) : { total_units: 0, total_dollars: null });
    return { counts: c, n: pos.length, total_units: ex.total_units, total_dollars: ex.total_dollars, last_evaluated: last != null ? new Date(last).toISOString() : null, exposure: ex, positions: pos };
  }
  var FILTERS = [['all', 'All'], ['games', 'Games'], ['props', 'Props'], ['bets', 'Bets'], ['leans', 'Leans'], ['watching', 'Watching'], ['pass', 'Pass'], ['none', 'No decision'], ['nfl', 'NFL'], ['cfb', 'CFB'], ['u25', '0.25U'], ['u50', '0.50U'], ['u75', '0.75U'], ['u100', '1.00U']];
  /* the second row: a market inside Games, a category inside Props */
  var SUBFILTERS = { games: [['', 'All games'], ['spread', 'Spread'], ['ml', 'ML'], ['total', 'Total']], props: [['', 'All props'], ['passing', 'Passing'], ['rushing', 'Rushing'], ['receiving', 'Receiving'], ['td', 'TD']] };
  var SORTS = [['kickoff', 'Kickoff'], ['strength', 'Strongest qualified edge'], ['confidence', 'Decision confidence'], ['cal_ev', 'Calibrated EV'], ['changed', 'Latest change'], ['movement', 'Line movement']];
  function passes(d, f) {
    if (f === 'games') return true;          /* an engine decision is a game market */
    if (f === 'props') return false;
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
      + '<div class="edd-r2">Playable to: <b>' + esc(d.playable ? d.playable.short : 'current price only') + '</b> · Edge ' + esc(ppTxt(d.edge_pp)) + ' · ' + (isNum(d.calibrated_ev_pct) ? 'Calibrated EV ' : 'Model-estimated EV ') + esc(pctText(d.decision_ev_pct)) + ' · Confidence ' + esc(isNum(d.decision_confidence) ? d.decision_confidence : '—')
      + (tierWord(d) ? ' · ' + esc(tierWord(d)) : '') + (d.probability_source ? ' · ' + esc(SRC_SHORT[d.probability_source] || '') : '') + ' · <small>' + esc(unitRule(d.recommended_units).label.toLowerCase()) + '</small></div>'
      + '<div class="edd-r3">' + matchup(d) + '</div></div>';
  }
  function otherRow(d) {
    var q = sel(d), s = selText(d);
    var K = kind(d), Vo = V();
    var realT = realOptions(d.bet_trigger);
    var trig = d.bet_trigger && d.bet_trigger.already_clears ? (d.watch && d.watch.trigger) : (realT.length ? 'BET at ' + realT.map(function (o) { return o.text; }).join(' or ') + ' or better.' : null);
    var why;
    if (K === 'WATCH') why = d.action_reason_text + (trig ? ' ' + trig : '');
    else if (K === 'LEAN') why = (DE() ? DE().oneSentence(d) : d.action_reason_text) + (trig ? ' ' + trig : '');
    else if (K === 'PASS') why = d.action_reason_text + ' ' + (trig || (Vo ? Vo.COPY.no_realistic_trigger + '.' : ''));
    else why = d.action_reason_text;
    var ms = d.market_state && d.market_state.key !== 'LIVE_MARKET' ? ' <span class="edd-qual edd-ms-q">' + esc(d.market_state.label) + '</span>' : '';
    return '<div class="edd-row edd-r-' + (TONE[K] || 'none') + '" data-edd-open="' + esc(d.game_id) + '" data-edd-sport="' + esc(d.sport) + '">'
      + '<div class="edd-r1"><b>' + esc(s ? s + (q && isNum(q.odds) ? ' (' + priceText(q.odds) + ')' : '') : (d.away || '') + ' @ ' + (d.home || '')) + '</b>' + (q && q.book ? ' <small>' + esc(q.book) + '</small>' : '')
      + (K === 'WATCH' ? ' <span class="edd-dnb">DO NOT BET YET</span>' : '') + (d.decision_qualifier && K !== 'BET' ? ' <span class="edd-qual">' + esc(d.decision_qualifier) + '</span>' : '') + ms + '</div>'
      + '<div class="edd-r2">' + esc(why) + '</div><div class="edd-r3">' + matchup(d) + '</div></div>';
  }
  function exposureBlock(sm) {
    var ex = sm.exposure; if (!ex) return '';
    var parts = [];
    function grp(label, o) { var ks = Object.keys(o || {}); if (!ks.length) return; parts.push('<div class="edd-pr"><span>' + esc(label) + '</span><span>' + ks.map(function (k) { return esc(k) + ' ' + esc(unitsText(o[k].units)) + (o[k].dollars != null ? ' <small>' + money(o[k].dollars) + '</small>' : ''); }).join(' · ') + '</span></div>'); }
    parts.push('<div class="edd-pr"><span>Total</span><span><b>' + esc(unitsText(ex.total_units)) + '</b>' + (ex.total_dollars != null ? ' <small>' + money(ex.total_dollars) + '</small>' : '') + ' <small>' + esc(ex.n_bets) + ' active BET' + (ex.n_bets === 1 ? '' : 's') + '</small></span></div>');
    grp('By sport', ex.by_sport); grp('By kickoff window', ex.by_window); grp('By market', ex.by_market);
    if (ex.by_type && ex.by_type.PLAYER_PROP && ex.by_type.PLAYER_PROP.units > 0) parts.push('<div class="edd-pr"><span>By type</span><span>Games ' + esc(unitsText(ex.by_type.GAME.units)) + ' · Player props ' + esc(unitsText(ex.by_type.PLAYER_PROP.units)) + '</span></div>');
    var byKey = {}; (sm.positions || []).forEach(function (p) { byKey[p.pos_key] = p; });
    var notes = (ex.correlation_notes || []).map(function (n) { return '<div class="edd-corr"><b>CORRELATION NOTE</b> ' + esc(n.text) + '</div>'; }).join('')
      + (ex.correlated || []).map(function (c) { return correlatedHTML(c, byKey); }).join('');
    var g = ex.guardrail && ex.guardrail.text ? '<div class="edd-guard">' + esc(ex.guardrail.text) + '</div>' : '';
    /* the per-bucket safeguards: shown once a BET is open, warned before a limit is reached */
    if (ex.n_bets > 0 && (ex.limits || []).length) parts.push('<div class="edd-pr"><span>Limits</span><span>' + ex.limits.map(function (l) { return esc(l.text) + (l.status !== 'OK' ? ' <b class="edd-warn">' + esc(l.status.replace('_', ' ')) + '</b>' : ''); }).join(' · ') + '</span></div>');
    g += (ex.warnings || []).map(function (w) { return '<div class="edd-guard">' + esc(w.text) + '</div>'; }).join('');
    return '<div class="edd-sec"><div class="edd-subh">EXPOSURE <small>active BET decisions only · LEAN, WATCH, PASS and NO DECISION never count</small></div>' + parts.join('') + notes + g + '</div>';
  }
  function performanceHTML(perf) {
    if (!perf || !perf.by_tier) return '';
    var Vo = V(), settled = perf.all ? perf.all.settled || 0 : perf.by_tier.reduce(function (s, r) { return s + (r.settled || 0); }, 0);
    var min = perf.min_n || (Vo ? Vo.UNIT_RULE.min_settled_bets : 50);
    var tiers = '<div class="edd-tiers">' + perf.by_tier.map(function (r) {
      var ur = Vo ? Vo.unitRuleOf(r.settled || 0, false) : null;
      return '<div class="edd-tierrule"><b>' + esc(r.group) + '</b> <span>' + esc(ur ? ur.label : '') + '</span> <small>' + esc(Math.min(r.settled || 0, min) + ' of ' + min + ' settled') + '</small></div>'; }).join('') + '</div>';
    if (!settled) {
      return '<div class="edd-sec"><div class="edd-subh">BET DECISION PERFORMANCE</div><div class="edd-zero"><b>' + esc(Vo ? Vo.COPY.no_settled_bets_title : 'NO SETTLED BETS YET') + '</b><p>' + esc(Vo ? Vo.COPY.no_settled_bets : '') + '</p></div>' + tiers + '</div>';
    }
    var rows = perf.by_tier.map(function (r) {
      return '<tr><td>' + esc(r.group) + '</td><td>' + r.bets + '</td><td>' + (r.units_risked == null ? '—' : r.units_risked) + '</td><td>' + (r.units_won == null ? '—' : r.units_won) + '</td><td>' + (r.roi == null ? '—' : pctText(100 * r.roi)) + '</td><td>'
        + (r.average_clv == null ? '—' : (r.average_clv >= 0 ? '+' : '') + r.average_clv) + '</td><td>' + (r.observed_cover_rate == null ? '—' : (100 * r.observed_cover_rate).toFixed(1) + '%') + '</td><td>' + (r.expected_cover_rate == null ? '—' : (100 * r.expected_cover_rate).toFixed(1) + '%') + '</td></tr>'; }).join('');
    return '<div class="edd-sec"><div class="edd-subh">BET DECISION PERFORMANCE</div><div class="edd-tablewrap"><table class="edd-table"><thead><tr><th>Tier</th><th>Bets</th><th>Units risked</th><th>Units won</th><th>ROI</th><th>Avg CLV</th><th>Observed cover</th><th>Expected cover</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + tiers + '<div class="edd-note">' + esc(perf.note || '') + ' Any tier under ' + esc(min) + ' settled bets is descriptive, not evidence.</div></div>';
  }
  /* ---- saved positions: a game market or a player prop the reader added,
     frozen at the moment it was added (EDOpportunity.cardEntry) */
  var TYPE_WORD = { GAME: 'GAME', PLAYER_PROP: 'PROP' };
  function entryTitle(e) { return e.type === 'PLAYER_PROP' ? (e.player_name || '—') + ' ' + (e.selection || e.market_label || '') : (e.selection || e.market_label || '—'); }
  function moveOf(p) {
    var X = OPP(), e = p.entry; if (!X || !e) return null;
    if (e.type === 'PLAYER_PROP') return p.current ? X.priceMove(e, p.current) : null;
    return p.current ? X.priceMove(e, p.current) : null;
  }
  function savedRowHTML(p) {
    var e = p.entry, K = p.decision, B = BK(), X = OPP(), T = X ? X.text : null;
    var dl = K === 'BET' && B ? B.dollars(p.recommended_units, settings()) : null, mv = moveOf(p), started = !openSaved(p);
    var cur = mv && mv.current_decision && mv.current_decision !== e.decision ? ' · <b>EdgeDesk now: ' + esc(label(mv.current_decision)) + '</b>' : '';
    var moveLine = started ? '<span class="edd-mv">Game started · awaiting the result</span>'
      : mv ? (mv.material ? '<span class="edd-mv on">' + esc(mv.text) + '</span>' : '<span class="edd-mv">' + esc(mv.text || '') + '</span>')
        : (e.type === 'PLAYER_PROP' ? '<span class="edd-mv">Checking the current price…</span>' : '<span class="edd-mv">No current EdgeDesk decision loaded for this game.</span>');
    var open = e.type === 'PLAYER_PROP' ? ' data-edd-prop="' + esc(JSON.stringify({ league: e.league, prop: e.snapshot && e.snapshot.prop_id, game: e.game_id })) + '"' : ' data-edd-open="' + esc(e.game_id) + '" data-edd-sport="' + esc(e.sport) + '"';
    return '<div class="edd-row edd-r-' + (TONE[K] || 'none') + ' edd-r-saved"' + open + '>'
      + '<div class="edd-r1"><span class="edd-type">' + TYPE_WORD[e.type] + '</span> ' + (K === 'BET' ? '<span class="edd-units">' + esc(unitsText(p.recommended_units)) + '</span> ' : '<span class="edd-badge edd-b-' + (TONE[K] || 'none') + '">' + esc(label(K)) + '</span> ')
      + '<b>' + esc(entryTitle(e)) + (isNum(e.american) ? ' (' + esc(priceText(e.american)) + ')' : '') + '</b>' + (e.book ? ' <small>' + esc(e.book) + '</small>' : '') + (dl != null ? ' <span class="edd-dl">' + money(dl) + '</span>' : '') + '</div>'
      + '<div class="edd-r2">Saved ' + esc(fmtTime(e.saved_at)) + ' · EV at decision ' + esc(T ? T.pct(e.ev) : '—') + (isNum(e.edge_pp) ? ' · Edge ' + esc(ppTxt(e.edge_pp)) : '') + (isNum(e.confidence) ? ' · Confidence ' + esc(e.confidence) : '')
      + (e.type === 'PLAYER_PROP' ? ' · <small>' + esc(e.stage ? e.stage.toLowerCase().replace('_', ' ') + ' market · ' : '') + 'model-estimated probability</small>' : (e.probability_source ? ' · <small>' + esc(SRC_SHORT[e.probability_source] || '') + '</small>' : '')) + cur + '</div>'
      + '<div class="edd-r2">' + moveLine + '</div>'
      + '<div class="edd-r3">' + esc((p.away || '') + ' @ ' + (p.home || '')) + ' <small>' + esc(p.sport || '') + ' · ' + esc(fmtKick(p.kickoff)) + '</small> <button type="button" class="edd-link edd-rm" data-edd-act="card-remove" data-edd-v="' + esc(e.entry_id) + '">Remove</button></div></div>';
  }
  function posRowHTML(p) { return p.entry ? savedRowHTML(p) : (p.decision === 'BET' ? betRow(p.decision_obj) : otherRow(p.decision_obj)); }
  /* the decision-shaped object the existing sorter reads */
  function dOf(p) {
    if (p.decision_obj && !p.entry) return p.decision_obj;
    var e = p.entry || {};
    return { game_id: p.game_id, kickoff: p.kickoff, recommended_units: p.recommended_units, tier: p.tier, edge_pp: e.edge_pp, calibrated_ev_pct: isNum(e.ev) ? 100 * e.ev : null, decision_confidence: e.confidence, market_movement_pts: null };
  }
  function posPasses(p, f, sub) { var X = OPP(); if (!X) return p.decision_obj ? passes(p.decision_obj, f) : true; return X.passesFilter(p, f) && (!sub || X.passesFilter(p, sub)); }
  function posLabel(p) { return p.entry ? TYPE_WORD[p.entry.type] + ' ' + entryTitle(p.entry) : 'GAME ' + (selText(p.decision_obj) || ((p.away || '') + ' @ ' + (p.home || ''))); }
  function correlatedHTML(c, byKey) {
    var pairs = (c.pairs || []).map(function (x) { var a = byKey[x.a], b = byKey[x.b]; return '<li>' + esc((a ? posLabel(a) : x.a) + ' · ' + (b ? posLabel(b) : x.b)) + ': ' + esc(x.relation.text) + '</li>'; }).join('');
    return '<div class="edd-corr edd-corrx"><b>CORRELATED EXPOSURE</b> ' + esc(c.text) + (pairs ? '<details><summary>How these positions relate</summary><ul>' + pairs + '</ul></details>' : '') + '</div>';
  }
  /* GROUP BY GAME: every game with an active position — its game market,
     its props, and the exposure that rides on that one game */
  function groupsHTML(shown, sm) {
    var X = OPP(); if (!X) return '';
    var active = shown.filter(function (p) { return p.source === 'saved' || p.decision === 'BET' || p.decision === 'LEAN' || p.decision === 'WATCH'; });
    var quiet = shown.length - active.length, byKey = {}; shown.forEach(function (p) { byKey[p.pos_key] = p; });
    var corr = {}; ((sm.exposure && sm.exposure.correlated) || []).forEach(function (c) { corr[c.event_key] = c; });
    var gs = X.groupByGame(active, Date.now()), B = BK();
    var h = gs.map(function (g) {
      var d = B && g.units ? B.dollars(g.units, settings()) : null;
      return '<div class="edd-sec edd-grp"><div class="edd-sech">' + esc(g.matchup) + ' <small>' + esc(g.sport || '') + ' · ' + esc(fmtKick(g.kickoff)) + '</small></div>'
        + (g.game.length ? '<div class="edd-subh">GAME</div>' + g.game.map(posRowHTML).join('') : '')
        + (g.props.length ? '<div class="edd-subh">PROPS</div>' + g.props.map(posRowHTML).join('') : '')
        + '<div class="edd-pr edd-gtot"><span>TOTAL GAME EXPOSURE</span><span><b>' + esc(unitsText(g.units)) + '</b>' + (d != null ? ' <small>' + money(d) + '</small>' : '') + '</span></div>'
        + (corr[g.event_key] ? correlatedHTML(corr[g.event_key], byKey) : '') + '</div>';
    }).join('');
    if (!gs.length) h = '<div class="edd-empty">No game carries a BET, LEAN, WATCH or a saved position under this filter.</div>';
    return h + (quiet ? '<div class="edd-note">' + quiet + ' other game' + (quiet === 1 ? '' : 's') + ' carr' + (quiet === 1 ? 'ies' : 'y') + ' only PASS or NO DECISION.</div>' : '');
  }
  /* THE RECORD, split by type: game markets and player props are different
     models and never one number (EDOpportunity.recordSplit) */
  function recordHTML() {
    var X = OPP(), ents = entries(); if (!X || !ents.length) return '';
    var done = ents.filter(function (e) { return !openSaved(e); });
    if (!done.length) return '';
    var graded = done.map(function (e) {
      var g = null;
      if (e.type === 'PLAYER_PROP') g = X.gradePropEntry(e, S.propResults[e.league] || []);
      else if ((e.market || 'spread') === 'spread') { var gp = gradePlaced({ sport: e.sport, game_id: e.game_id, side: e.side, line: e.line, odds: e.american, units: e.units }); if (gp && gp.result) g = { result: gp.result, units_won: gp.units_won, clv: gp.clv_points }; }
      return Object.assign({}, e, { grade: g });
    });
    var R = X.recordSplit(graded), pend = graded.filter(function (x) { return !x.grade; }).length;
    var row = function (lbl, r) { return '<tr><td>' + esc(lbl) + '</td><td>' + r.n + '</td><td>' + r.wins + '-' + r.losses + '-' + r.pushes + '</td><td>' + (r.units_won == null ? '—' : (r.units_won >= 0 ? '+' : '') + r.units_won + 'U') + '</td><td>' + (r.roi == null ? '—' : pctText(100 * r.roi)) + '</td><td>' + (r.avg_ev_at_decision == null ? '—' : pctText(100 * r.avg_ev_at_decision)) + '</td><td>' + (r.avg_clv == null ? '—' : (r.avg_clv >= 0 ? '+' : '') + r.avg_clv) + '</td></tr>'; };
    return '<div class="edd-sec"><div class="edd-subh">YOUR CARD RECORD <small>saved positions, graded · games and props kept apart</small></div><div class="edd-tablewrap"><table class="edd-table"><thead><tr><th></th><th>Settled</th><th>W-L-P</th><th>Units</th><th>ROI</th><th>Avg EV at decision</th><th>Avg CLV</th></tr></thead><tbody>'
      + row('Game markets', R.GAME) + row('Player props', R.PLAYER_PROP) + row('All', R.ALL) + '</tbody></table></div>'
      + '<div class="edd-note">' + esc(R.note) + (pend ? ' ' + pend + ' saved position' + (pend === 1 ? ' is' : 's are') + ' awaiting a result.' : '') + ' Under 50 settled is descriptive, not evidence.</div></div>';
  }
  function cardPageHTML(list, opts) {
    opts = opts || {};
    list = list || mergedDecisions();
    var v = opts.view || cardView(), sm = summary(list, opts), B = BK(), X = OPP();
    var all = sm.positions || [];
    var sub = v.sub && SUBFILTERS[v.filter] && SUBFILTERS[v.filter].some(function (x) { return x[0] === v.sub; }) ? v.sub : '';
    var srt = sorter(v.sort);
    var shown = all.filter(function (p) { return posPasses(p, v.filter, sub); }).sort(function (a, b) { return srt(dOf(a), dOf(b)); });
    var bets = shown.filter(function (p) { return p.decision === 'BET'; }), wait = shown.filter(function (p) { return p.decision === 'WATCH'; }),
      lean = shown.filter(function (p) { return p.decision === 'LEAN'; }),
      pass = shown.filter(function (p) { return p.decision === 'PASS'; }), none = shown.filter(function (p) { return p.decision === 'NO_DECISION'; });
    var mixed = all.some(function (p) { return p.source === 'saved' || p.type === 'PLAYER_PROP'; });
    var uv = B ? B.unitValue(settings()) : { unit: null };
    var bt = sm.exposure && sm.exposure.by_type;
    var h = '<div class="edd-page">';
    /* the hierarchy: where action exists first (BETs and their exposure),
       then what is close (LEAN, WATCH), then the quiet answers (PASS, NO
       DECISION), smallest */
    h += '<header class="edd-ph"><div class="edd-ph1"><h2>EDGEDESK CARD</h2><span class="edd-when">Last evaluated ' + esc(sm.last_evaluated ? fmtTime(sm.last_evaluated) : '—') + '</span></div>'
      + '<div class="edd-kpi-main">'
      + '<div class="edd-kpi edd-kpi-bet edd-kpi-xl"><b>' + sm.counts.BET + '</b><span>' + (sm.counts.BET === 1 ? 'BET' : 'BETS') + '</span></div>'
      + '<div class="edd-kpi edd-kpi-exp edd-kpi-xl"><b>' + esc(unitsText(sm.total_units)) + '</b><span>TOTAL EXPOSURE' + (sm.total_dollars != null ? ' · <b class="edd-kpi-usd">' + money(sm.total_dollars) + '</b>' : '') + '</span></div></div>'
      + (mixed && bt ? '<div class="edd-kpi-type"><span><i>GAMES</i> ' + esc(unitsText(bt.GAME.units)) + '</span><span><i>PLAYER PROPS</i> ' + esc(unitsText(bt.PLAYER_PROP.units)) + '</span></div>' : '')
      + '<div class="edd-kpis edd-kpis-2">'
      + '<div class="edd-kpi edd-kpi-lean"><b>' + sm.counts.LEAN + '</b><span>' + (sm.counts.LEAN === 1 ? 'Lean' : 'Leans') + '</span></div>'
      + '<div class="edd-kpi edd-kpi-wait"><b>' + sm.counts.WATCH + '</b><span>Watching</span></div></div>'
      + '<div class="edd-kpis-3"><span><b>' + sm.counts.PASS + '</b> ' + (sm.counts.PASS === 1 ? 'pass' : 'passes') + '</span><span class="edd-dot">·</span><span><b>' + sm.counts.NO_DECISION + '</b> no decision</span></div>'
      + (sm.total_dollars != null ? '<div class="edd-note">' + esc(unitsText(sm.total_units)) + ' total exposure · ' + money(sm.total_dollars) + ' based on your ' + money(uv.unit) + ' unit.</div>'
        : '<div class="edd-note"><button type="button" class="edd-link" data-edd-act="bankroll">Set your bankroll or unit</button> to see dollar amounts. 1 unit defaults to 1% of bankroll.</div>')
      + '<div class="edd-tools"><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="bankroll">Bankroll &amp; units</button><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="onboard">How to read this card</button><button type="button" class="edd-btn edd-btn-quiet" data-edd-act="export">Export decisions (CSV)</button>'
      + '<label class="edd-toggle"><input type="checkbox" data-edd-act="beginner"' + (beginner() ? ' checked' : '') + '> Beginner mode</label></div></header>';
    h += '<div class="edd-filters" role="tablist">' + FILTERS.map(function (f) { return '<button type="button" class="edd-f' + (v.filter === f[0] ? ' on' : '') + '" data-edd-act="filter" data-edd-v="' + f[0] + '">' + esc(f[1]) + '</button>'; }).join('') + '</div>';
    if (SUBFILTERS[v.filter]) h += '<div class="edd-filters edd-sub" role="tablist">' + SUBFILTERS[v.filter].map(function (f) { return '<button type="button" class="edd-f' + (sub === f[0] ? ' on' : '') + '" data-edd-act="subfilter" data-edd-v="' + f[0] + '">' + esc(f[1]) + '</button>'; }).join('') + '</div>';
    h += '<div class="edd-sortbar"><label>Sort <select data-edd-act="sort">' + SORTS.map(function (s) { return '<option value="' + s[0] + '"' + (v.sort === s[0] ? ' selected' : '') + '>' + esc(s[1]) + '</option>'; }).join('') + '</select></label>'
      + '<label class="edd-toggle"><input type="checkbox" data-edd-act="group"' + (v.group ? ' checked' : '') + '> Group by game</label></div>';
    if (opts.loading) h += '<div class="edd-note">Loading the latest decisions…</div>';
    if (opts.error) h += '<div class="edd-note edd-warn">The decision build did not load (' + esc(opts.error) + '). Live decisions from the boards you open still appear here.</div>';
    if (v.group) h += groupsHTML(shown, sm);
    else {
      var betsHTML;
      if (!bets.length) betsHTML = '<div class="edd-empty">No current price clears EdgeDesk’s betting threshold. LEAN, WATCH and PASS are real answers: EdgeDesk evaluated ' + list.length + ' game' + (list.length === 1 ? '' : 's') + ' and none qualifies at the current prices.</div>';
      else if (mixed) {
        var gb = bets.filter(function (p) { return p.type === 'GAME'; }), pb = bets.filter(function (p) { return p.type === 'PLAYER_PROP'; });
        betsHTML = (gb.length ? '<div class="edd-subh">GAME BETS</div>' + gb.map(posRowHTML).join('') : '') + (pb.length ? '<div class="edd-subh">PLAYER PROPS</div>' + pb.map(posRowHTML).join('') : '');
      } else betsHTML = bets.map(posRowHTML).join('');
      h += '<div class="edd-sec"><div class="edd-sech edd-sech-bet">BET <small>' + bets.length + '</small></div>' + betsHTML + '</div>';
      h += '<div class="edd-sec"><div class="edd-sech edd-sech-wait">WATCHING <small>' + wait.length + '</small></div>' + (wait.length ? wait.map(posRowHTML).join('') : '<div class="edd-empty">Nothing is near a BET trigger or waiting on information.</div>') + '</div>';
      h += '<details class="edd-sec"' + (v.showLean !== false ? ' open' : '') + ' data-edd-fold="showLean"><summary class="edd-sech edd-sech-lean">LEAN <small>' + lean.length + '</small></summary>' + (lean.length ? lean.map(posRowHTML).join('') : '<div class="edd-empty">No positive edge below the betting threshold right now.</div>') + '</details>';
      h += '<details class="edd-sec"' + (v.showPass ? ' open' : '') + ' data-edd-fold="showPass"><summary class="edd-sech edd-sech-pass">PASS <small>' + pass.length + '</small></summary>' + pass.map(posRowHTML).join('') + '</details>';
      h += '<details class="edd-sec"' + (v.showNone ? ' open' : '') + ' data-edd-fold="showNone"><summary class="edd-sech edd-sech-none">NO DECISION <small>' + none.length + '</small></summary>' + none.map(posRowHTML).join('') + '</details>';
    }
    h += exposureBlock(sm);
    h += placedSummaryHTML();
    h += recordHTML();
    h += performanceHTML(S.build && S.build.performance);
    if (!opts.no_health) { if (!S.health && !S.healthErr) ensureHealth(); h += modelHealthHTML(S.health, { open: !!(opts.view || cardView()).showHealth }); }
    var Vo = V();
    h += '<div class="edd-valid"><p>' + validLine({ probability_source: null }, false) + '</p>'
      + '<p>Stakes are capped by the probability source: model-estimated 0.25U, partially calibrated 0.50U; 1.00U needs a live-validated calibration. NO DECISION means required information is missing or unusable, never that the model is still validating.</p>'
      + (mixed ? '<p>Player props are MODEL-ESTIMATED (UNVALIDATED CALIBRATION) and sized under their market’s validation stage, never above a game market. A saved position keeps the line, price and EV it had when you added it; the current market is shown beside it, never over it.</p>' : '')
      + '<p>' + esc(Vo ? Vo.COPY.product : '') + ' EdgeDesk states whether the current price qualifies, never that a wager will win. ' + esc(Vo ? Vo.COPY.responsible : '') + '</p></div>';
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
      + '<span class="edd-bn edd-bn-lean"><b>' + sm.counts.LEAN + '</b> lean</span><span class="edd-bn edd-bn-wait"><b>' + sm.counts.WATCH + '</b> watching</span><span class="edd-bn edd-bn-pass"><b>' + sm.counts.PASS + '</b> pass · <b>' + sm.counts.NO_DECISION + '</b> no decision</span>'
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
    function () { var Vo = V(), D5 = Vo ? Vo.DECISION : {};
      return '<h3>READ THE ACTION</h3><div class="edd-legend">'
      + ['BET', 'LEAN', 'WATCH', 'PASS', 'NO_DECISION'].map(function (k) { var x = D5[k] || { label: k, short: '' }; return '<div><span class="edd-badge edd-b-' + (TONE[k] || 'none') + '">' + esc(x.label) + '</span> ' + esc(x.short) + (k === 'BET' ? ' Sized in units, capped by how well the probability is calibrated.' : (k === 'WATCH' ? ' Do not bet yet.' : (k === 'LEAN' ? ' No stake.' : ''))) + '</div>'; }).join('')
      + '</div><p class="edd-note">' + esc(Vo ? Vo.COPY.research_vs_decision : '') + '</p>'; },
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
    var sports = {}; placed().concat(entries().filter(function (e) { return e.type === 'GAME'; })).forEach(function (b) { sports[String(b.sport || '').toLowerCase()] = String(b.kickoff || '').slice(0, 4) || '2026'; });
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
    loadRemoteSettings(); ensureBuild(); ensureRecords(); loadRemoteEntries(); ensurePropCurrent();
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
    var prow = !el && ev.target && ev.target.closest ? ev.target.closest('[data-edd-prop]') : null;
    if (prow) { try { var o = JSON.parse(prow.getAttribute('data-edd-prop')); if (root.EDPropsUI && root.EDPropsUI.go) root.EDPropsUI.go(o.prop ? { league: o.league, prop: o.prop } : { league: o.league, game: o.game }); } catch (e) { /* ignore */ } return; }
    if (row) { var gid0 = row.getAttribute('data-edd-open'), sp = row.getAttribute('data-edd-sport'); try { if (typeof root.fbOpenGame === 'function') root.fbOpenGame(String(sp || 'CFB').toUpperCase() === 'NFL' ? 'nfl' : 'p4', gid0); } catch (e) { /* ignore */ } return; }
    if (!el) return;
    var act = el.getAttribute('data-edd-act'), gid = el.getAttribute('data-edd-gid');
    if (act === 'filter') { cardView().filter = el.getAttribute('data-edd-v'); cardView().sub = ''; writeKey(KEYS.card, cardView()); paintCard(); }
    else if (act === 'subfilter') { cardView().sub = el.getAttribute('data-edd-v') || ''; writeKey(KEYS.card, cardView()); paintCard(); }
    else if (act === 'card-remove') { removeEntry(el.getAttribute('data-edd-v')); paintCard(); }
    else if (act === 'level') {
      var lvv = el.getAttribute('data-edd-v');
      if (lvv === 'beginner' || lvv === 'research' || lvv === 'lab') {
        writeKey(KEYS.level, lvv);
        /* repaint THIS card in place at once (the board catches up on its own clock) */
        var sec = el.closest ? el.closest('.edd-act') : null, dd = findDecision(gid);
        if (sec && dd && sec.parentNode) { var tmp = document.createElement('div'); tmp.innerHTML = actionCardHTML(dd, { level: lvv, mobile: sec.classList.contains('edd-compact') }); if (tmp.firstChild) sec.parentNode.replaceChild(tmp.firstChild, sec); }
        repaint();
      }
    }
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
    else if (act === 'advanced') { var s0 = settings(); s0.beginner_mode = false; saveSettings(s0); writeKey(KEYS.level, 'research'); paintCard(); repaint(); }
    else if (act === 'export') downloadCSV(mergedDecisions());
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
    else if (act === 'group') { cardView().group = !!el.checked; writeKey(KEYS.card, cardView()); paintCard(); }
    else if (act === 'beginner') { var s = settings(); s.beginner_mode = !!el.checked; saveSettings(s); writeKey(KEYS.level, el.checked ? 'beginner' : 'research'); paintCard(); repaint(); }
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
    modelHealthHTML: modelHealthHTML, researchBlocks: researchBlocks, labBlocks: labBlocks, levelOf: levelOf, LEVELS: LEVELS, ensureHealth: ensureHealth,
    decisionsCSV: decisionsCSV, decisionRow: decisionRow, CSV_HEAD: CSV_HEAD,
    makePlaced: makePlaced, gradePlaced: gradePlaced, passes: passes, sorter: sorter, SUBFILTERS: SUBFILTERS, positionsOf: positionsOf, savedRowHTML: savedRowHTML, groupsHTML: groupsHTML, recordHTML: recordHTML,
    /* the reader's saved opportunities (games and props) */
    entries: entries, onCard: onCard, addOpportunity: addOpportunity, addGame: addGame, removeEntry: removeEntry, ensurePropCurrent: ensurePropCurrent,
    /* state */
    observe: observe, previous: previous, trackFor: trackFor, settings: settings, saveSettings: saveSettings, placed: placed, savePlaced: savePlaced,
    mergedDecisions: mergedDecisions, beginner: beginner, _state: S,
    /* controller */
    showCard: showCard, openBankroll: openBankroll, openOnboarding: openOnboarding, repaint: repaint, install: install, ensureBuild: ensureBuild
  };
}));
