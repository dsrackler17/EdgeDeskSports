/* ===========================================================================
   EdgeDesk OVERVIEW — what deserves the reader's attention today.
   docs/research-os/DESIGN.md §3

   Overview answers "what deserves my attention?"; Research answers "why?".
   It is a front door, not a second research page: every row opens the
   feature that owns the answer, carrying the game with it.

   WHAT IT READS (nothing new is collected, nothing is computed into a pick)
     the slate          the same load the Research strip made (EDGamesUI
                        .snapshot(): today/slate.json + live layer + the
                        reader's captured prices)
     Signal Center      sc_status() and sc_pulse(24): counts only, anon-safe
     the Simulator      sim_public_status(): what is published, when, by
                        which model version — no probability
     the watchlist      my_watchlist (the reader's rows; `changed` is the
                        server's own seen-hash comparison)
     My Card            EDDecisionUI.entries() (already on the device)
     recently viewed    EDContext.recent() (this device)
     Market Foresight   through EDShell.service('foresight') when that layer
                        registered itself; its status only
     Smart Money Tonight radar_tonight() (supabase/radar.sql): where the top-
                        graded Polymarket bettors are on tonight's games, the
                        same for every subscriber; it leads the page, drawn by
                        lib/edgedesk_radar_ui.js, with the Radar record under it
                        (radar_record(): how following it has done). Nothing is
                        drawn while Radar is off or not registered, or for a
                        reader it refuses
   A source that cannot be read says so where its numbers would be. Every
   count is a count of rows that exist.

   THE QUEUE'S ORDER (documented, deterministic; it is not a recommendation)
     1. status: live, then scheduled, then final, then postponed / canceled
     2. the reader's interest: on the watchlist or the Card first
     3. research completeness, most first: a research page, a model
        projection, a current captured price (0–3)
     4. start time, earliest first; then the slate id
   The size of a model–market difference is shown and NEVER used to order.
   Signal grades, rankings and eligibility are read, never changed.

   Browser: window.EDOverview. Node: require('./edgedesk_overview.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDOverview = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var O = { VERSION: 'edgedesk_overview/1' };
  var MIN = 60000, H = 3600000, D = 86400000;

  function G() { return root.EDGames || (typeof require === 'function' ? require('./edgedesk_games.js') : null); }
  function CX() { return root.EDContext || (typeof require === 'function' ? require('./edgedesk_context.js') : null); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function ms(t) { if (typeof t === 'number') return isFinite(t) ? t : null; var x = Date.parse(t); return isFinite(x) ? x : null; }
  function sgn1(v) { v = num(v); return v == null ? '—' : (v === 0 ? 'PK' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1)); }
  function ago(t, now) { var g = G(); return g ? (g.ageText(t, now) || 'time unknown') : ''; }
  O.esc = esc;

  /* ============================================================ ROWS (pure) */
  function teamShort(t) { return t ? (t.short || t.abbr || t.name || '') : ''; }
  function teamFull(t) { return t ? (t.name || t.short || t.abbr || '') : ''; }
  /* one game as the queue shows it: facts with their source and time, the
     missing ones named as missing */
  O.row = function (e, market, c) {
    var g = G(), cx = CX(); c = c || {};
    var now = c.now == null ? Date.now() : c.now, zone = c.zone || g.CONFIG.default_zone;
    var sp = g.sport(e.sport) || { id: e.sport, label: String(e.sport || '').toUpperCase(), unit: null };
    var eff = g.effective ? g.effective(e, now) : e;
    var grp = g.statusGroup(eff.status);
    var ctx = cx.fromSlateEvent(e), key = cx.keyOf(ctx);
    var r = e.research || {}, m = r.model || null, f = (m && m.fair) || {};
    var tgt = g.researchTarget(e, 'app');
    var links = cx.links(ctx, { simSports: c.simSports || null });
    var fm = g.formatMarket(e, market, { now: now });
    var mkPoint = market && market.spread && market.spread.home ? num(market.spread.home.point) : null;
    var model = m ? { spread_home: num(f.spread_home != null ? f.spread_home : (sp.unit === 'points' ? m.home_line : null)), total: num(f.total), home_win: num(f.home_win),
      ml_home: num(f.ml_home), tier: m.tier || null, source: m.source || null, note: m.note || null, status: m.status || null } : null;
    /* a model–market difference only between the SAME contract: EdgeDesk's
       full-game home spread and a captured full-game home spread, in points */
    var diff = null;
    if (model && model.spread_home != null && fm.ok && mkPoint != null && sp.unit === 'points') {
      diff = { kind: 'spread', model: model.spread_home, market: mkPoint, abs: Math.round(Math.abs(model.spread_home - mkPoint) * 10) / 10, current: !!fm.current, book: fm.book, captured_at: fm.captured_at };
    }
    var watched = !!(c.watch && key && c.watch[key]);
    var carded = !!(c.card && (c.card[key] || c.card[e.id]));
    var start = e.time_tbd ? null : ms(e.start_utc);
    var researchOk = !!(r.module || (r.article && r.article.url));
    var completeness = (researchOk ? 1 : 0) + (model ? 1 : 0) + (fm.ok && fm.current ? 1 : 0);
    var sig = r.signal && r.signal.actionable === true ? { text: r.signal.label || 'Certified signal', why: r.signal.why || null } : null;
    return {
      id: e.id, key: key, sport: sp.id, sportLabel: sp.label, home: teamFull(e.home), away: teamFull(e.away), homeShort: teamShort(e.home), awayShort: teamShort(e.away),
      start: start, tbd: !!e.time_tbd, status: eff.status, statusLabel: (g.STATUS[eff.status] || {}).label || eff.status, statusDetail: e.status_detail || null, group: grp,
      score: (grp === 'live' || grp === 'final') && e.home && e.away && e.home.score != null && e.away.score != null ? { home: e.home.score, away: e.away.score } : null,
      research: { ok: researchOk, href: tgt.href || links.research, label: tgt.label, kind: tgt.kind },
      links: links, ctx: ctx, model: model, market: fm.ok ? { book: fm.book, captured_at: fm.captured_at, age_min: fm.age_min, current: !!fm.current, home_point: mkPoint,
        total: market && market.total ? num(market.total.point) : null, ml_home: market && market.moneyline ? num(market.moneyline.home) : null } : { none: true, reason: fm.reason || 'no captured price on file for this game' },
      diff: diff, signal: sig, watched: watched, carded: carded, completeness: completeness, changes: (c.changes && c.changes[e.id]) || [],
      local: start == null ? null : g.dateKey(start, zone)
    };
  };
  var GRP = { live: 0, upcoming: 1, final: 2, off: 3 };
  /* the queue's order (header): status, interest, completeness, start, id */
  O.compare = function (a, b) {
    var x = (GRP[a.group] == null ? 4 : GRP[a.group]) - (GRP[b.group] == null ? 4 : GRP[b.group]); if (x) return x;
    var ia = a.watched || a.carded ? 0 : 1, ib = b.watched || b.carded ? 0 : 1; if (ia !== ib) return ia - ib;
    if (a.completeness !== b.completeness) return b.completeness - a.completeness;
    var ta = a.start == null ? Infinity : a.start, tb = b.start == null ? Infinity : b.start; if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  O.order = function (rows) { return (rows || []).slice().sort(O.compare); };

  /* every list the queue offers, from one snapshot */
  O.lists = function (snap, c) {
    var g = G(); c = c || {};
    var now = c.now == null ? Date.now() : c.now, zone = snap.zone || g.CONFIG.default_zone, today = snap.today || g.today(now, zone);
    var sport = c.sport && c.sport !== 'all' ? c.sport : null;
    var events = (snap.events || []).filter(function (e) { return e && g.sport(e.sport) && (!sport || e.sport === sport); });
    var mk = snap.markets || {};
    var b = g.dayBounds(today, zone), horizon = b.to + 7 * D;
    var all = events.map(function (e) { return O.row(e, mk[e.id], Object.assign({}, c, { now: now, zone: zone })); });
    var byId = {}; all.forEach(function (r) { byId[r.id] = r; });
    var todayRows = all.filter(function (r) { return r.start != null && r.start >= b.from && r.start < b.to; });
    var upRows = all.filter(function (r) { return r.start != null && r.start >= b.to && r.start < horizon && r.group === 'upcoming'; });
    var changed = all.filter(function (r) { return r.changes.length && r.group !== 'final' && r.group !== 'off'; });
    var saved = all.filter(function (r) { return (r.watched || r.carded) && (r.start == null || r.start >= b.from - D); });
    var recentKeys = (c.recent || []).map(function (x) { return x.key; });
    var recent = (c.recent || []).map(function (x) {
      var hit = null; all.forEach(function (r) { if (!hit && (r.key === x.key || r.id === x.gameId)) hit = r; });
      return hit || { recentOnly: true, key: x.key, id: x.gameId || x.key, sport: x.sport, sportLabel: (g.sport(x.sport) || {}).label || String(x.sport || '').toUpperCase(), home: x.home, away: x.away,
        start: ms(x.start), links: CX().links(x, { simSports: c.simSports || null }), at: x.at };
    }).filter(function (r) { return !sport || r.sport === sport; });
    var counts = { today: todayRows.length, live: 0, upcoming: 0, final: 0, off: 0, research: 0, model: 0, priced: 0, stale: 0, signals: 0, bySport: {} };
    todayRows.forEach(function (r) {
      counts[r.group] = (counts[r.group] || 0) + 1;
      if (r.research.ok) counts.research++;
      if (r.model) counts.model++;
      if (r.market && !r.market.none) { if (r.market.current) counts.priced++; else counts.stale++; }
      if (r.signal) counts.signals++;
      counts.bySport[r.sport] = (counts.bySport[r.sport] || 0) + 1;
    });
    var sportsPresent = {};
    events.forEach(function (e) { var t = ms(e.start_utc); if (t != null && t >= b.from && t < horizon) sportsPresent[e.sport] = (sportsPresent[e.sport] || 0) + 1; });
    return { today: O.order(todayRows), upcoming: O.order(upRows), changed: O.order(changed), saved: O.order(saved), recent: recent, counts: counts, day: today, zone: zone, bounds: b,
      sports: sportsPresent, byId: byId, recentKeys: recentKeys };
  };

  /* ============================================================ AI (pure)
     Only questions the desk has a route for: the personal desk's own list
     (supabase/functions/edgedesk_ai/_mine.js, matched by EDPersonal.PERSONAL_Q)
     and the research engine's examples (lib/edgedesk_intel_ui.js EXAMPLES).
     tools/research_os/research_os.test.js (§4) holds each one to its route. */
  O.SUGGEST = [
    { q: 'What changed in my watchlist today?', needs: 'account', route: 'personal' },
    { q: 'Where is EdgeDesk most different from the market?', needs: null, route: 'personal' },
    { q: 'Which five games are most worth researching?', needs: null, route: 'personal' },
    { q: 'Which games have high disagreement but low reliability?', needs: null, route: 'personal' },
    { q: 'Analyze every NFL game this weekend.', needs: 'nfl', route: 'intel' }
  ];
  O.suggestions = function (o) {
    o = o || {};
    return O.SUGGEST.filter(function (s) { return !s.needs || (s.needs === 'account' && o.signedIn) || (s.needs === 'nfl' && o.nfl); }).map(function (s) { return s.q; });
  };

  /* ====================================================== RENDER (pure HTML) */
  function zoneLabel(zone, now) { var g = G(); try { return g.zoneText ? g.zoneText(zone, now) : zone; } catch (_) { return zone; } }
  O.headerHTML = function (lists, snap, now) {
    var g = G(), day = lists.day;
    var stamp = snap.generated_at ? 'Schedule built ' + ago(snap.generated_at, now) : (snap.loading || !snap.error ? 'Loading the schedule…' : 'Schedule not loaded');
    return '<div class="ov-hd"><div class="ov-hd-t"><h2 id="ovH">Overview</h2><p class="ov-when"><span>' + esc(g.dateText(day, true)) + '</span><span>' + esc(zoneLabel(lists.zone, now)) + '</span><span>' + esc(stamp) + '</span></p></div>'
      + '</div>';
  };
  O.sportsHTML = function (lists, sel) {
    var g = G(), items = [['all', 'All sports', Object.keys(lists.sports).reduce(function (a, k) { return a + lists.sports[k]; }, 0)]];
    g.SPORTS.forEach(function (s) { if (lists.sports[s.id]) items.push([s.id, s.label, lists.sports[s.id]]); });
    if (sel && sel !== 'all' && !lists.sports[sel]) { var s0 = g.sport(sel); if (s0) items.push([sel, s0.label, 0]); }
    return '<div class="ov-sports" role="group" aria-label="Sport">' + items.map(function (it) {
      var on = (sel || 'all') === it[0];
      return '<button type="button" class="ov-pill' + (on ? ' on' : '') + '" data-ov-sport="' + esc(it[0]) + '" aria-pressed="' + on + '">' + esc(it[1]) + ' <span class="ov-n">' + esc(it[2]) + '</span></button>';
    }).join('') + '</div><p class="ov-note">Games over the next 7 days, from EdgeDesk’s schedule.</p>';
  };
  O.askHTML = function (sugs) {
    return '<section class="ov-ask" aria-labelledby="ovAskH"><h3 id="ovAskH" class="ov-h3"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3z"/></svg>Ask EdgeDesk AI</h3>'
      + '<form class="ov-ask-f" id="ovAskF" novalidate><label class="ov-sr" for="ovAskQ">Ask EdgeDesk AI a research question</label>'
      + '<input id="ovAskQ" type="text" maxlength="400" autocomplete="off" enterkeyhint="send" placeholder="Ask about a game, a price, your watchlist…"><button type="submit" class="ov-btn">Ask</button></form>'
      + '<p class="ov-err" id="ovAskErr" role="alert" hidden></p>'
      + '<div class="ov-sug" role="list" aria-label="Questions the desk can answer">' + sugs.map(function (q) { return '<button type="button" role="listitem" class="ov-chip" data-ov-ask="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>'
      + '<p class="ov-note">Answers come from EdgeDesk’s published research and your own saved rows, with sources; a missing source is said, never filled in.</p></section>';
  };
  function tile(k, v, s, tone, href) {
    var inner = '<div class="ov-tk">' + esc(k) + '</div><div class="ov-tv">' + v + '</div><div class="ov-ts">' + s + '</div>';
    return href ? '<a class="ov-tile' + (tone ? ' ' + tone : '') + '" href="' + esc(href) + '">' + inner + '</a>' : '<div class="ov-tile' + (tone ? ' ' + tone : '') + '">' + inner + '</div>';
  }
  /* svc: { signals, watch } each { state: 'loading'|'ok'|'none'|'not_deployed'|'shadow'|'error'|'signed_out', ... } */
  O.summaryHTML = function (lists, snap, svc, now) {
    var c = lists.counts, h = '';
    var none = !snap.ready;
    h += tile('Games today', none ? '—' : esc(c.today), none ? (snap.loading || !snap.error ? 'Loading the schedule…' : 'The schedule could not be loaded') : esc(c.live + ' live · ' + c.upcoming + ' to come · ' + c.final + ' final'), '', '#games');
    h += tile('With research', none ? '—' : esc(c.research), none ? '' : esc('of ' + c.today + ' today · ' + c.model + ' with a model projection'), '');
    h += tile('Priced now', none ? '—' : esc(c.priced), none ? '' : esc((c.stale ? c.stale + ' with only a past price · ' : '') + 'captured within ' + G().CONFIG.market_limit_min + ' min'), c.stale ? 'warn' : '');
    var s = svc.signals || { state: 'loading' }, sv, ss, st = '';
    if (s.state === 'ok') { sv = esc(s.published); ss = esc('published in 24 h' + (s.major ? ' · ' + s.major + ' major' : '') + (s.includes_unpublished ? ' · includes shadow (operator view)' : '')); }
    else if (s.state === 'shadow') { sv = 'In review'; ss = 'Signals are validated before publication'; st = 'mute'; }
    else if (s.state === 'not_deployed') { sv = 'Not live'; ss = 'Signal Center is not deployed yet'; st = 'mute'; }
    else if (s.state === 'error') { sv = '—'; ss = 'Could not be read just now'; st = 'warn'; }
    else { sv = '…'; ss = 'Checking'; }
    h += tile('Signals', sv, ss, st, '#signals');
    var w = svc.watch || { state: 'loading' }, wv, ws, wt = '';
    if (w.state === 'ok') { wv = esc(w.changed); ws = esc(w.changed === 1 ? 'saved game changed since you last looked' : 'saved games changed since you last looked') + (w.total ? esc(' · ' + w.total + ' watched') : ''); }
    else if (w.state === 'signed_out') { wv = '—'; ws = 'Sign in to keep a watchlist'; wt = 'mute'; }
    else if (w.state === 'not_deployed') { wv = '—'; ws = 'The watchlist is not installed on this deployment'; wt = 'mute'; }
    else if (w.state === 'error') { wv = '—'; ws = 'Could not be read just now'; wt = 'warn'; }
    else { wv = '…'; ws = 'Checking'; }
    h += tile('Saved, needs a look', wv, ws, wt, null);
    return '<section class="ov-sum" aria-label="Today at a glance">' + h + '</section>';
  };
  /* research limitations, in the reader's words (no codes, no stack) */
  O.limitsHTML = function (snap, lists, svc) {
    var out = [], g = G();
    var fr = snap.freshness || {};
    (fr.alerts || []).forEach(function (a) { out.push({ tone: a.tone === 'err' ? 'err' : 'warn', text: a.text }); });
    if (lists.counts.stale) out.push({ tone: 'warn', text: lists.counts.stale + ' of today’s prices are older than ' + g.CONFIG.market_limit_min + ' minutes. They are shown as past prices, never as current ones.' });
    if (svc.sim && svc.sim.state === 'error') out.push({ tone: 'warn', text: 'The Simulator’s status could not be read just now; the Simulator page will say what is published.' });
    if (!out.length) return '';
    return '<section class="ov-lim" aria-label="Research limitations"><h3 class="ov-h3">Research limitations</h3><ul>' + out.map(function (x) { return '<li class="' + x.tone + '">' + esc(x.text) + '</li>'; }).join('') + '</ul></section>';
  };

  O.TABS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['changed', 'Changed'], ['saved', 'Saved'], ['recent', 'Recent']];
  function factHTML(k, v, tone, title) { return '<span class="ovq-k' + (tone ? ' ' + tone : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><i>' + esc(k) + '</i> ' + v + '</span>'; }
  function startText(r, zone, now) {
    var g = G();
    if (r.tbd || r.start == null) return 'Time TBA';
    var dk = g.dateKey(r.start, zone), today = g.today(now, zone);
    return (dk === today ? '' : g.relDay(dk, today) + ' · ') + g.timeText(r.start, zone);
  }
  function favored(r, homeLine) {
    if (homeLine == null) return '—';
    if (homeLine === 0) return 'Pick’em';
    return homeLine < 0 ? (r.homeShort || r.home) + ' ' + sgn1(homeLine) : (r.awayShort || r.away) + ' ' + sgn1(-homeLine);
  }
  O.rowHTML = function (r, o) {
    o = o || {};
    var now = o.now == null ? Date.now() : o.now, zone = o.zone;
    if (r.recentOnly) {
      return '<li class="ovq-r"><div class="ovq-m"><span class="ovq-sp">' + esc(r.sportLabel) + '</span><b class="ovq-n">' + esc((r.away || '') + ' at ' + (r.home || '')) + '</b>'
        + '<span class="ovq-t">' + esc(r.start ? startText(r, zone, now) : 'Not on today’s schedule') + '</span></div>'
        + '<div class="ovq-f">' + factHTML('Viewed', esc(ago(r.at, now))) + '</div>'
        + '<div class="ovq-a">' + (r.links.research ? '<a class="ov-btn sm" href="' + esc(r.links.research) + '">Open research</a>' : '') + '</div></li>';
    }
    var f = [];
    var st = r.group === 'live' ? (r.score ? r.awayShort + ' ' + r.score.away + ' – ' + r.score.home + ' ' + r.homeShort + ' · ' : '') + (r.statusDetail || 'Live')
      : r.group === 'final' ? (r.score ? 'Final · ' + r.awayShort + ' ' + r.score.away + ' – ' + r.score.home + ' ' + r.homeShort : 'Final') : r.group === 'off' ? r.statusLabel : startText(r, zone, now);
    f.push(factHTML('Research', r.research.ok ? 'available' : 'not yet', r.research.ok ? 'ok' : 'mute'));
    if (r.model) {
      var mv = r.model.spread_home != null ? favored(r, r.model.spread_home) : (r.model.home_win != null ? (r.homeShort || r.home) + ' ' + (r.model.home_win * 100).toFixed(1) + '%' : (r.model.ml_home != null ? (r.homeShort || r.home) + ' ' + (r.model.ml_home > 0 ? '+' : '') + r.model.ml_home : 'on file'));
      f.push(factHTML('Model', esc(mv), '', 'EdgeDesk projection' + (r.model.source ? ' · ' + r.model.source : '') + (r.model.tier ? ' · tier ' + r.model.tier : '') + (r.model.note ? ' · ' + r.model.note : '')));
    } else f.push(factHTML('Model', 'no projection', 'mute'));
    if (r.market && !r.market.none) {
      var mtxt = r.market.home_point != null ? favored(r, r.market.home_point) : (r.market.ml_home != null ? (r.homeShort || r.home) + ' ' + (r.market.ml_home > 0 ? '+' : '') + r.market.ml_home : 'priced');
      f.push(factHTML(r.market.book || 'Price', esc(mtxt) + ' <small>' + esc((r.market.current ? 'captured ' : 'past price, ') + ago(r.market.captured_at, now)) + '</small>', r.market.current ? '' : 'warn',
        'Captured from ' + (r.market.book || 'a named book') + ' at ' + r.market.captured_at + '. A captured price is a record of what was offered, not a price you can take now.'));
    } else f.push(factHTML('Price', 'none captured', 'mute', r.market && r.market.reason));
    /* the model's own caveat travels with any comparison to a price (NBA and NHL fair lines say
       their value claims are off until tested against the market) */
    var untested = !!(r.model && r.model.note && /value claims are off|never been compared with the market|tested against the closing market/i.test(r.model.note));
    if (r.diff) f.push(factHTML('Model vs price', esc(r.diff.abs.toFixed(1) + ' pts') + (r.diff.current ? '' : ' <small>vs a past price</small>') + (untested ? ' <small>· model not tested against the market</small>' : ''), '',
      'EdgeDesk’s fair home spread minus ' + (r.diff.book || 'the book') + '’s captured home spread, same contract (full game). A difference is not a recommendation.' + (untested ? ' ' + r.model.note : '')));
    if (r.signal) f.push(factHTML('Signal', esc(r.signal.text), 'ok', r.signal.why || ''));
    if (r.watched) f.push(factHTML('Saved', 'watchlist', 'ok'));
    if (r.carded) f.push(factHTML('Saved', 'on your Card', 'ok'));
    var ch = '';
    if (o.showChanges && r.changes.length) ch = '<ul class="ovq-ch">' + r.changes.map(function (c) { return '<li class="' + (c.comparable ? '' : 'mute') + '">' + esc(c.text) + '</li>'; }).join('') + '</ul>';
    var acts = '<a class="ov-btn sm" href="' + esc(r.research.href || '#games') + '" data-ov-open="' + esc(r.id) + '">' + esc(r.research.ok ? 'Open research' : 'View matchup') + '</a>';
    if (r.links.foresight) acts += '<a class="ov-btn sm ghost" href="' + esc(r.links.foresight) + '" data-ov-open="' + esc(r.id) + '" title="Market Foresight: which forecasts preceded later market movement for this game">Foresight</a>';
    acts += '<button type="button" class="ov-btn sm ghost" data-ov-askgame="' + esc(r.id) + '" aria-label="' + esc('Ask EdgeDesk AI about ' + r.away + ' at ' + r.home) + '">Ask AI</button>';
    return '<li class="ovq-r' + (r.group === 'live' ? ' live' : '') + (r.group === 'final' || r.group === 'off' ? ' done' : '') + '" data-ov-row="' + esc(r.id) + '">'
      + '<div class="ovq-m"><span class="ovq-sp">' + esc(r.sportLabel) + '</span><b class="ovq-n">' + esc(r.away + ' at ' + r.home) + '</b><span class="ovq-t">' + esc(st) + '</span></div>'
      + '<div class="ovq-f">' + f.join('') + '</div>' + ch + '<div class="ovq-a">' + acts + '</div></li>';
  };
  O.queueHTML = function (lists, tab, o) {
    o = o || {};
    var tabs = '<div class="ov-tabs" role="tablist" aria-label="Research queue">' + O.TABS.map(function (t) {
      var n = t[0] === 'today' ? lists.today.length : t[0] === 'upcoming' ? lists.upcoming.length : t[0] === 'changed' ? lists.changed.length + (o.watchChanged || 0) : t[0] === 'saved' ? lists.saved.length : lists.recent.length;
      var on = tab === t[0];
      return '<button type="button" role="tab" id="ovTab-' + t[0] + '" aria-controls="ovQ" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" class="ov-tab' + (on ? ' on' : '') + '" data-ov-tab="' + t[0] + '">' + esc(t[1]) + ' <span class="ov-n">' + n + '</span></button>';
    }).join('') + '</div>';
    var rows = lists[tab] || [], body = '';
    var lim = o.limit || 25;
    var head = '';
    if (tab === 'changed') {
      head += o.watchChangedHTML || '';
      head += o.refAt ? '<p class="ov-note">Since your last visit on this device, ' + esc(o.refText || '') + '. Prices are compared only from the same book and market; anything else is listed as not comparable. <button type="button" class="ov-link" data-ov-seen>Mark all as seen</button></p>'
        : '<p class="ov-note">This device has no earlier visit to compare with yet. From your next visit, changes in EdgeDesk’s published numbers, captured prices and game status since this one are listed here.</p>';
    }
    if (tab === 'recent' && !rows.length) body = '<p class="ov-empty">No games opened on this device yet. Games you open from Research, Signals or search appear here.</p>';
    else if (tab === 'saved' && !rows.length) body = '<p class="ov-empty">' + (o.signedIn ? 'Nothing saved on the schedule ahead. Watch a game (☆ on its research) or add it to your Card, and it appears here.' : 'Sign in to keep a watchlist; games on your Card on this device appear here too.') + '</p>';
    else if (tab === 'changed' && !rows.length) body = o.refAt ? '<p class="ov-empty">Nothing EdgeDesk publishes for these games changed since then.</p>' : '';
    else if (!rows.length) body = '<p class="ov-empty">' + (o.ready === false ? (o.loading ? 'Loading the schedule…' : 'The schedule could not be loaded, so there is nothing to list. This is not an empty slate.') : tab === 'today' ? 'No games on today’s schedule' + (o.sport && o.sport !== 'all' ? ' for this sport' : '') + '. Upcoming lists the next ones.' : 'Nothing scheduled in the next 7 days' + (o.sport && o.sport !== 'all' ? ' for this sport' : '') + '.') + '</p>';
    else {
      var live = rows.filter(function (r) { return r.group !== 'final' && r.group !== 'off'; }), done = rows.filter(function (r) { return r.group === 'final' || r.group === 'off'; });
      var shown = live.slice(0, lim);
      body = '<ol class="ovq" aria-label="' + esc((O.TABS.filter(function (t) { return t[0] === tab; })[0] || [0, ''])[1] + ' games') + '">' + shown.map(function (r) { return O.rowHTML(r, { now: o.now, zone: lists.zone, showChanges: tab === 'changed' }); }).join('') + '</ol>';
      if (live.length > lim) body += '<button type="button" class="ov-link" data-ov-more>Show ' + (live.length - lim) + ' more</button>';
      if (done.length) body += '<details class="ov-done"><summary>' + done.length + ' finished or not played</summary><ol class="ovq">' + done.map(function (r) { return O.rowHTML(r, { now: o.now, zone: lists.zone }); }).join('') + '</ol></details>';
    }
    var how = '<details class="ov-how"><summary>How this list is ordered</summary><p>Live games first, then scheduled, then finished. Within each, games on your watchlist or Card come first, then games with more of their research in place (a research page, a model projection, a current captured price), then by start time. The size of a model–price difference never moves a game up: a large difference is a reason to check the data, not a recommendation.</p></details>';
    return '<section class="ov-queue" aria-labelledby="ovQH"><h3 class="ov-h3" id="ovQH">Research queue</h3>' + tabs + '<div id="ovQ" role="tabpanel" aria-labelledby="ovTab-' + esc(tab) + '">' + head + body + '</div>' + how + '</section>';
  };
  /* comparable quote changes since the last visit: both observations, the book, the window */
  O.marketHTML = function (lists, visit, now) {
    var g = G(), rows = [];
    Object.keys(lists.byId).forEach(function (id) {
      var r = lists.byId[id];
      if (r.group === 'final' || r.group === 'off') return;
      r.changes.forEach(function (c) { if (/^quote_/.test(c.kind)) rows.push({ r: r, c: c }); });
    });
    rows.sort(function (a, b) { return (a.r.start || 0) - (b.r.start || 0); });
    var h = '<section class="ov-card" aria-labelledby="ovMkH"><h3 class="ov-h3" id="ovMkH">Captured price changes</h3>';
    if (!visit || !visit.ref) h += '<p class="ov-note">No earlier observation on this device yet. On your next visit this compares each game’s captured price with the one on file now.</p>';
    else if (!rows.length) h += '<p class="ov-note">No captured price changed since ' + esc(ago(visit.ref.at, now)) + ' for the games ahead.</p>';
    else {
      h += '<ul class="ov-mk">' + rows.slice(0, 6).map(function (x) {
        var c = x.c;
        return '<li><b>' + esc(x.r.away + ' at ' + x.r.home) + '</b><span class="ov-mk-c">' + esc(c.text) + '</span>'
          + (c.comparable ? '<span class="ov-mk-t">Same book and market · earlier ' + esc(g.stampText(c.from_at, lists.zone)) + ' · latest ' + esc(g.stampText(c.to_at, lists.zone)) + ' · moved somewhere between the two captures</span>'
            : '<span class="ov-mk-t mute">Not comparable: ' + esc(c.kind === 'quote_new' ? 'there was no earlier price' : 'a different book') + '</span>')
          + '<span class="ov-mk-a"><a href="' + esc(x.r.research.href || '#games') + '">Research</a>' + (x.r.links.foresight ? ' · <a href="' + esc(x.r.links.foresight) + '">Foresight timeline</a>' : '') + '</span></li>';
      }).join('') + '</ul>';
      if (rows.length > 6) h += '<p class="ov-note">' + (rows.length - 6) + ' more in the queue’s Changed tab.</p>';
    }
    h += '<p class="ov-note">A captured price is a record of what a book offered at its capture time. It is never presented as a price available now.</p></section>';
    return h;
  };
  /* sim: { state, rows:[{sport, competition, season, published_at, input_snapshot_at, n_sims, model_version, last_attempt_status}] } */
  O.simHTML = function (sim, now) {
    var h = '<section class="ov-card" aria-labelledby="ovSimH"><h3 class="ov-h3" id="ovSimH">Simulator</h3>';
    var labels = {}; try { (root.EDSimSports && root.EDSimSports.sports || []).forEach(function (s) { labels[s.key] = s.label; }); } catch (_) { /* labels fall back to the key */ }
    if (!sim || sim.state === 'loading') h += '<p class="ov-note">Checking what is published…</p>';
    else if (sim.state === 'not_deployed') h += '<p class="ov-note">The Simulator’s database is not deployed, so no season simulation is published here yet.</p>';
    else if (sim.state === 'error') h += '<p class="ov-note">What the Simulator has published could not be read just now.</p>';
    else {
      var pub = (sim.rows || []).filter(function (r) { return r.published_run_id || r.published_at; });
      pub.sort(function (a, b) { return (ms(b.published_at) || 0) - (ms(a.published_at) || 0); });
      if (!pub.length) h += '<p class="ov-note">No season simulation has been published yet.</p>';
      else h += '<ul class="ov-sim">' + pub.slice(0, 5).map(function (r) {
        return '<li><a href="#simulator/' + esc(r.sport) + '"><b>' + esc(labels[r.sport] || String(r.sport).toUpperCase()) + (r.competition && r.competition !== 'season' && r.competition !== r.sport ? ' · ' + esc(r.competition) : '') + '</b> <span>' + esc(r.season || '') + '</span></a>'
          + '<span class="ov-sim-m">' + esc((r.n_sims ? Number(r.n_sims).toLocaleString('en-US') + ' simulated seasons · ' : '') + 'model ' + (r.model_version || 'not stated') + ' · published ' + ago(r.published_at, now) + (r.input_snapshot_at ? ' · inputs as of ' + ago(r.input_snapshot_at, now) : '')) + '</span>'
          + (r.last_attempt_status === 'failed' ? '<span class="ov-sim-m warn">The latest attempt failed and published nothing; the run above stands.</span>' : '') + '</li>';
      }).join('') + '</ul><p class="ov-note">Probabilities, their Monte Carlo error and any mapped futures prices are on each sport’s Simulator page (Full Access). A simulation is never run by opening a page.</p>';
    }
    return h + '</section>';
  };
  /* ws: { card, watch, recent, signedIn } */
  O.workspaceHTML = function (ws, lists, now) {
    var h = '<section class="ov-card" aria-labelledby="ovWsH"><h3 class="ov-h3" id="ovWsH">Your workspace</h3><div class="ov-ws">';
    h += '<a class="ov-ws-i" href="#card"><b>' + esc(ws.card == null ? '—' : ws.card) + '</b><span>on your Card</span></a>';
    h += '<button type="button" class="ov-ws-i" data-ov-watch><b>' + esc(ws.watch == null ? '—' : ws.watch) + '</b><span>' + (ws.signedIn ? 'on your watchlist' : 'watchlist (sign in)') + '</span></button>';
    h += '<a class="ov-ws-i" href="#portfolio"><b>↗</b><span>Portfolio: positions you placed</span></a>';
    h += '<a class="ov-ws-i" href="#performance"><b>↗</b><span>Performance: models and you, apart</span></a></div>';
    var rec = (lists.recent || []).slice(0, 3);
    if (rec.length) h += '<p class="ov-k">Recently viewed</p><ul class="ov-rec">' + rec.map(function (r) { return '<li><a href="' + esc((r.research && r.research.href) || (r.links && r.links.research) || '#games') + '">' + esc((r.away || '') + ' at ' + (r.home || '')) + '</a> <span>' + esc(r.sportLabel || '') + '</span></li>'; }).join('') + '</ul>';
    h += '<p class="ov-note">Saving a game or adding it to your Card never records a bet. A position exists only when you record or import one in Portfolio.</p>';
    return h + '</section>';
  };
  /* fs: { state, mode, can_read, last_run_at, sports } from the Foresight service */
  O.foresightHTML = function (fs, now) {
    var h = '<section class="ov-card" aria-labelledby="ovFsH"><h3 class="ov-h3" id="ovFsH">Market Foresight</h3>';
    if (!fs) return '';
    if (fs.state === 'loading') h += '<p class="ov-note">Checking its status…</p>';
    else if (fs.state === 'not_deployed') h += '<p class="ov-note">Built and in review; its database layer is not deployed yet, so there are no measurements to show. The methodology is already frozen.</p>';
    else if (fs.state === 'error') h += '<p class="ov-note">Its status could not be read just now.</p>';
    else if (fs.mode === 'off') h += '<p class="ov-note">Switched off.</p>';
    else h += '<p class="ov-note">' + (fs.mode === 'shadow' ? (fs.can_read ? 'In review: you are seeing the operators’ view.' : 'In review: measurements are visible to operators only while the first runs are checked.') : 'Live.')
      + (fs.last_run_at ? ' Last computed ' + esc(ago(fs.last_run_at, now)) + '.' : ' Nothing computed yet.') + '</p>';
    h += '<p class="ov-note">NFL and college football pregame markets only. It reports which forecasts preceded later observed movement — never that a model moved a market, and never a trade.</p><a class="ov-btn sm ghost" href="#foresight">Open Market Foresight</a>';
    return h + '</section>';
  };

  /* ============================================================ BROWSER */
  var S = { host: null, tab: 'today', sport: 'all', limit: 25, unsub: null, svc: {}, visit: null, dirty: false, bound: false, lastLists: null };
  var PREF = 'edgedesk_overview_v1';
  function lsGet() { try { var v = root.localStorage.getItem(PREF); return v ? JSON.parse(v) : {}; } catch (_) { return {}; } }
  function lsSet(o) { try { root.localStorage.setItem(PREF, JSON.stringify(o)); } catch (_) { /* memory only */ } }
  function SH() { return root.EDShell || null; }
  function visible() { return !!(S.host && S.host.offsetParent !== null) && !(root.document && root.document.hidden); }
  function snapshot() {
    var U = root.EDGamesUI;
    if (!U || !U.snapshot) return { events: [], markets: {}, ready: false, loading: false, zone: null, today: null, freshness: { alerts: [{ tone: 'err', text: 'The schedule module did not load on this page.' }] } };
    return U.snapshot();
  }
  function simSports() { var o = {}; try { (root.EDSimSports && root.EDSimSports.sports || []).forEach(function (s) { o[s.key] = 1; }); } catch (_) { /* none */ } return o; }
  function cardKeys() {
    var o = {}, n = 0;
    try {
      var es = root.EDDecisionUI && root.EDDecisionUI.entries ? root.EDDecisionUI.entries() : [];
      /* a Card entry names its game by the research key (lib/edgedesk_opportunity.js eventKey) */
      (es || []).forEach(function (e) {
        if (!e || e.status === 'removed') return; n++;
        if (e.event_key) o[String(e.event_key)] = 1;
        else if (e.league && e.game_id != null) o[e.league + '|' + e.game_id] = 1;
      });
    } catch (_) { n = null; }
    return { keys: o, n: n };
  }
  function watchState() {
    var M = root.EDMine;
    if (!SH() || !SH().signedIn()) return { state: 'signed_out' };
    if (!M || !M.S || !M.S.ready) return S.mineGaveUp ? { state: 'error' } : { state: 'loading' };
    if (M.S.schema === false) return { state: 'not_deployed' };
    if (!M.S.watchLoaded) return M.S.watchErr ? { state: 'error' } : { state: 'loading' };
    var rows = M.S.watchRows || [];
    return { state: 'ok', total: rows.length, changed: rows.filter(function (w) { return w.changed; }).length, rows: rows };
  }
  /* Smart Money Tonight: the first thing a subscriber sees (docs/prediction-radar.md) */
  function paintRadar() {
    var el = $('ovRadar'), U = root.EDRadarUI;
    if (!el || !U) return;
    U.injectStyle(root.document);
    el.innerHTML = U.tonightHTML(S.svc.radar) + (U.recordHTML ? U.recordHTML(S.svc.radarRecord) : '');
  }
  function loadOptional() {
    var X = SH(); if (!X) return;
    S.svc.radar = S.svc.radar || { status: 'loading' };
    X.memo('ov:radar', 2 * MIN, function () {
      return X.rpc('radar_tonight', {}).then(function (r) { return r && r.status ? r : { status: 'error' }; })
        .catch(function (e) { return X.notDeployed(e) ? { notDeployed: true } : { status: 'error' }; });
    }).then(function (v) { S.svc.radar = v; paintRadar(); });
    /* How following has done: the Radar record (supabase/radar_record.sql radar_record, subscribers only) */
    X.memo('ov:radar_record', 10 * MIN, function () {
      return X.rpc('radar_record', { p_limit: 10 }).then(function (r) { return r && r.status ? r : { status: 'error' }; })
        .catch(function (e) { return X.notDeployed(e) ? { notDeployed: true } : { status: 'error' }; });
    }).then(function (v) { S.svc.radarRecord = v; paintRadar(); });
    S.svc.signals = S.svc.signals || { state: 'loading' };
    X.memo('ov:sc', 5 * MIN, function () {
      return X.rpc('sc_status', {}).then(function (st) {
        if (!st || st.deployed === false) return { state: 'not_deployed' };
        var live = st.mode === 'live';
        if (!live && !st.admin) return { state: 'shadow' };
        return X.rpc('sc_pulse', { p_hours: 24 }).then(function (p) { return { state: 'ok', published: (p && p.published) || 0, major: (p && p.major) || 0, includes_unpublished: !!(p && p.includes_unpublished) }; });
      }).catch(function (e) { return X.notDeployed(e) ? { state: 'not_deployed' } : { state: 'error' }; });
    }).then(function (v) { S.svc.signals = v; paintSummary(); });
    S.svc.sim = S.svc.sim || { state: 'loading' };
    X.memo('ov:sim', 10 * MIN, function () {
      return X.rpc('sim_public_status', {}).then(function (rows) { return { state: 'ok', rows: Array.isArray(rows) ? rows : [] }; })
        .catch(function (e) { return X.notDeployed(e) ? { state: 'not_deployed' } : { state: 'error' }; });
    }).then(function (v) { S.svc.sim = v; paintSide(); paintLimits(); });
    var F = X.service('foresight');
    if (F && F.status) {
      S.svc.fs = S.svc.fs || { state: 'loading' };
      Promise.resolve().then(function () { return F.status(); }).then(function (v) { S.svc.fs = v; paintSide(); }, function () { S.svc.fs = { state: 'error' }; paintSide(); });
    }
    /* the watchlist: lib/edgedesk_personal_ui.js loads near the end of the page and boots a moment
       after it, so the Overview (opened while the page is still parsing) waits for it, bounded */
    if (X.signedIn()) mineReady().then(function (M) {
      if (!M) { paintSummary(); return; }
      if (M.S.schema !== true || !M.loadWatchlist) { paintSummary(); return; }
      X.memo('ov:watch', 2 * MIN, function () { return M.loadWatchlist(); }).then(function () { paint(); }, function () { paintSummary(); });
    });
  }
  var MINE_P = null;
  function mineReady() {
    if (MINE_P) return MINE_P;
    MINE_P = new Promise(function (res) {
      var t0 = Date.now();
      (function check() {
        var M = root.EDMine;
        if (M && M.S && M.S.ready) return res(M);
        if (Date.now() - t0 > 20000) { MINE_P = null; S.mineGaveUp = true; return res(null); }
        setTimeout(check, 400);
      })();
    });
    return MINE_P;
  }
  function lists() {
    var snap = snapshot(), cx = CX();
    if (snap.ready && cx) S.visit = cx.visit(snap.events, snap.markets, Date.now());
    var w = watchState(), wk = {};
    (w.rows || []).forEach(function (r) { wk[r.game_key] = r; });
    var ck = cardKeys();
    S.card = ck.n;
    var L = O.lists(snap, { now: Date.now(), sport: S.sport, watch: wk, card: ck.keys, changes: S.visit ? S.visit.changes : {}, recent: cx ? cx.recent() : [], simSports: simSports() });
    S.lastLists = L; S.lastSnap = snap;
    return { snap: snap, L: L, w: w };
  }
  function $(id) { return root.document.getElementById(id); }
  function paintSummary() {
    if (!S.host || !S.lastLists) return;
    var el = $('ovSum'); if (!el) return;
    S.svc.watch = watchState();
    el.innerHTML = O.summaryHTML(S.lastLists, S.lastSnap, S.svc, Date.now());
  }
  function paintLimits() { var el = $('ovLim'); if (el && S.lastLists) el.innerHTML = O.limitsHTML(S.lastSnap, S.lastLists, S.svc); }
  function paintSide() {
    var el = $('ovSide'); if (!el || !S.lastLists) return;
    var w = watchState(), ws = { card: S.card, watch: w.state === 'ok' ? w.total : null, signedIn: SH() && SH().signedIn() };
    el.innerHTML = O.marketHTML(S.lastLists, S.visit, Date.now()) + O.simHTML(S.svc.sim, Date.now()) + O.workspaceHTML(ws, S.lastLists, Date.now()) + (S.svc.fs ? O.foresightHTML(S.svc.fs, Date.now()) : '');
  }
  function watchChangedHTML(w) {
    if (w.state !== 'ok') return '';
    var ch = (w.rows || []).filter(function (r) { return r.changed; });
    if (!ch.length) return '';
    return '<div class="ov-wch"><p class="ov-k">On your watchlist — EdgeDesk’s research state changed since you last opened it</p><ul>' + ch.slice(0, 8).map(function (r) {
      var k = CX().splitKey(r.game_key), href = k ? '#game/' + k.league + '/' + encodeURIComponent(k.id) : '#research/football';
      return '<li><a href="' + esc(href) + '">' + esc((r.away || '') + ' at ' + (r.home || '')) + '</a>' + (r.key_reason ? ' <span>' + esc(r.key_reason) + '</span>' : '') + (r.computed_at ? ' <small>updated ' + esc(ago(r.computed_at, Date.now())) + '</small>' : '') + '</li>';
    }).join('') + '</ul></div>';
  }
  function paintQueue() {
    var el = $('ovQueue'); if (!el) return;
    var x = lists();
    var ref = S.visit && S.visit.ref;
    el.innerHTML = O.queueHTML(x.L, S.tab, { now: Date.now(), limit: S.limit, ready: x.snap.ready, loading: x.snap.loading || !x.snap.error, sport: S.sport, signedIn: SH() && SH().signedIn(),
      refAt: ref ? ref.at : null, refText: ref ? G().stampText(ref.at, x.L.zone) + ' (' + ago(ref.at, Date.now()) + ')' : '',
      watchChanged: x.w.state === 'ok' ? x.w.changed : 0, watchChangedHTML: watchChangedHTML(x.w) });
    var sp = $('ovSports'); if (sp) sp.innerHTML = O.sportsHTML(x.L, S.sport);
    var hd = $('ovHead'); if (hd) hd.innerHTML = O.headerHTML(x.L, x.snap, Date.now());
    paintSummary(); paintLimits(); paintSide();
  }
  function paint() {
    if (!S.host) return;
    if (!visible()) { S.dirty = true; return; }
    S.dirty = false;
    paintQueue();
  }
  function askSubmit(q) {
    var err = $('ovAskErr');
    var t = String(q || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 3) { if (err) { err.hidden = false; err.textContent = 'Type a question first (at least a few words).'; } return; }
    if (err) err.hidden = true;
    if (typeof root.edAsk !== 'function' || !root.EDAI) { if (err) { err.hidden = false; err.textContent = 'The AI desk is not available on this page right now. Research and every other view still work.'; } return; }
    root.edAsk(t, 'overview');
    var inp = $('ovAskQ'); if (inp) inp.value = '';
  }
  function bind() {
    if (S.bound) return; S.bound = true;
    S.host.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null; if (!t) return;
      var b;
      if ((b = t.closest('[data-ov-sport]'))) { S.sport = b.getAttribute('data-ov-sport'); S.limit = 25; lsSet({ sport: S.sport, tab: S.tab }); paint(); return; }
      if ((b = t.closest('[data-ov-tab]'))) { S.tab = b.getAttribute('data-ov-tab'); S.limit = 25; lsSet({ sport: S.sport, tab: S.tab }); paint(); var nt = $('ovTab-' + S.tab); if (nt) nt.focus(); return; }
      if (t.closest('[data-ov-more]')) { S.limit += 25; paint(); return; }
      if (t.closest('[data-ov-seen]')) { var sn = snapshot(); CX().visitSeen(sn.events, sn.markets, Date.now()); S.visit = null; paint(); return; }
      if (t.closest('[data-ov-watch]')) {
        if (root.EDMine && root.EDMine.open && SH().signedIn()) { try { root.EDMine.open('watchlist'); } catch (_) { /* the panel is optional */ } }
        else { S.tab = 'saved'; paint(); }
        return;
      }
      if ((b = t.closest('[data-radar-wallet]'))) {
        /* a bettor's trader page, read under the reader's own token (open positions for a subscriber) */
        if (root.EDRadarUI && SH()) root.EDRadarUI.openTrader(root.document, b.getAttribute('data-radar-wallet'), function (w) { return SH().rpc('radar_trader', { p_wallet: w }); });
        return;
      }
      if ((b = t.closest('[data-ov-ask]'))) { askSubmit(b.getAttribute('data-ov-ask')); return; }
      if ((b = t.closest('[data-ov-askgame]'))) {
        var r = S.lastLists && S.lastLists.byId[b.getAttribute('data-ov-askgame')];
        if (r) { CX().set(r.ctx, { panel: 'overview' }); askSubmit('Research ' + r.away + ' at ' + r.home + '.'); }
        return;
      }
      if ((b = t.closest('[data-ov-open]'))) {
        var r2 = S.lastLists && S.lastLists.byId[b.getAttribute('data-ov-open')];
        if (r2) CX().set(r2.ctx, { panel: 'overview' });
        try { if (typeof root.edNavTrack === 'function') root.edNavTrack('secondary', 'overview:' + (b.textContent || '').trim().toLowerCase().replace(/\s+/g, '_')); } catch (_) { /* evidence is optional */ }
      }
    });
    S.host.addEventListener('submit', function (e) {
      if (!e.target || e.target.id !== 'ovAskF') return;
      e.preventDefault(); var i = $('ovAskQ'); askSubmit(i && i.value);
    });
    S.host.addEventListener('keydown', function (e) {
      var t = e.target; if (!t || !t.getAttribute || !t.hasAttribute('data-ov-tab')) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      var ids = O.TABS.map(function (x) { return x[0]; }), i = ids.indexOf(t.getAttribute('data-ov-tab'));
      i = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      S.tab = ids[i]; lsSet({ sport: S.sport, tab: S.tab }); paint(); var nt = $('ovTab-' + S.tab); if (nt) nt.focus();
    });
    root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden && S.dirty && visible()) paint(); });
  }
  /* open(host): draw what is held at once, then fill the optional parts as
     they answer; the slate's own refresh repaints it while it is on screen */
  O.open = function (host) {
    if (!host) return;
    if (S.host !== host) {
      S.host = host;
      var p = lsGet();
      if (p.sport) S.sport = p.sport;
      if (p.tab && O.TABS.some(function (t) { return t[0] === p.tab; })) S.tab = p.tab;
      var signed = !!(SH() && SH().signedIn());
      host.innerHTML = '<div class="ovw" aria-labelledby="ovH"><div id="ovRadar"></div><div id="ovHead"></div><div id="ovSports"></div>' + O.askHTML(O.suggestions({ signedIn: signed, nfl: false }))
        + '<div id="ovSum"></div><div id="ovLim"></div><div class="ov-grid"><div id="ovQueue"></div><aside id="ovSide" class="ov-side" aria-label="Markets, simulations and your workspace"></aside></div></div>';
      bind();
    }
    var U = root.EDGamesUI;
    if (U && U.subscribe && !S.unsub) S.unsub = U.subscribe(function () { paint(); });
    paint();
    loadOptional();
    /* the AI suggestions follow what the slate holds (an NFL question only when NFL games are ahead) */
    try {
      var L = S.lastLists, sug = root.document.querySelector('#v-overview .ov-sug');
      if (L && sug) {
        var qs = O.suggestions({ signedIn: !!(SH() && SH().signedIn()), nfl: !!L.sports.nfl });
        sug.innerHTML = qs.map(function (q) { return '<button type="button" role="listitem" class="ov-chip" data-ov-ask="' + esc(q) + '">' + esc(q) + '</button>'; }).join('');
      }
    } catch (_) { /* the chips stay as drawn */ }
  };
  O._state = S;
  return O;
});
