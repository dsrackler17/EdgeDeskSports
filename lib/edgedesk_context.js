/* ===========================================================================
   EdgeDesk RESEARCH CONTEXT — one game, carried from feature to feature.
   docs/research-os/DESIGN.md §2

   WHY IT EXISTS
     Research, Signals, Market Foresight, the Simulator and the AI desk each
     know a game by an identifier they already share. Before this file a
     reader who moved between them had to find the same matchup again. This is
     the one place that turns a game the reader is looking at into the links
     every other feature accepts, and that remembers what they looked at.

   THE CONTRACT (identifiers, never inferred from names)
     { sport, gameId, researchKey, module, entity, season, home, away, start,
       marketType, marketSide, selectedModel, researchTimestamp }
       gameId       the slate's canonical id: <sport>:<provider>:<provider id>
       researchKey  the research key the slate carries for the game
                    (nfl|2026_07_DAL_PHI, cfb|401871071), the same key the game
                    research snapshot, the watchlist and the performance ledger
                    use. Null when the slate names none.
       module/entity  where the Research shell holds the game (EDGames)
       home/away    display labels only: nothing is ever joined on them
     A context holds no account data, no price and no model number, so it can
     ride a URL hash and a device's storage without exposing anything.

   THE LAST-VISIT REFERENCE
     "Changed since your last visit" compares two snapshots this device
     actually stored: the published numbers (model fair line, the captured
     book quote and its capture time, the game status) as they were when the
     reader last looked, and as they are now. The reference is taken from the
     PREVIOUS browser session, so a refresh does not erase what changed, and
     the reader can mark everything seen. A quote comparison is valid only
     from the same book, the same market and two different capture times;
     anything else is reported as not comparable, never as movement.

   Browser: window.EDContext. Node: require('./edgedesk_context.js').
   ES5, no clock read inside the pure functions (they take `now`).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDContext = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var C = { VERSION: 'edgedesk_context/1' };
  var MIN = 60000, H = 3600000, D = 86400000;

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function num(v) { if (!present(v)) return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function ms(t) { if (typeof t === 'number') return isFinite(t) ? t : null; var x = Date.parse(t); return isFinite(x) ? x : null; }
  function r1(v) { v = num(v); return v == null ? null : Math.round(v * 10) / 10; }
  function r3(v) { v = num(v); return v == null ? null : Math.round(v * 1000) / 1000; }

  /* ===================================================== COVERAGE, BY FEATURE
     What each feature actually supports, from its own documentation. A link is
     offered only where the target can answer for that sport.
       game research page   NFL and FBS (lib/edgedesk_game_view.js)
       Market Foresight     NFL and FBS pregame markets (docs/market-foresight)
       Simulator            the sports its registry lists (lib/edgedesk_simulator_sports.js);
                            the Simulator itself says which are Active, Blocked or Coming Soon
       Signal Center        its sports list (lib/edgedesk_signal_center.js) */
  C.GAME_PAGE_SPORTS = { nfl: 1, cfb: 1 };
  C.FORESIGHT_SPORTS = { nfl: 1, cfb: 1 };
  C.SIGNAL_SPORTS = { nfl: 1, cfb: 1, nba: 1, nhl: 1, mlb: 1, wnba: 1, ncaam: 1, mma: 1, golf: 1, tennis: 1 };
  /* the slate's sport ids that are a different key in the Simulator's registry */
  C.SIM_KEY = { mma: 'ufc', ncaabase: 'college_baseball' };
  /* the AI desk names a sport by its odds key (the card, the board and the
     resolver all do): the same keys as lib/edgedesk_games.js SPORTS[].odds */
  C.DESK_SPORT = { nfl: 'americanfootball_nfl', cfb: 'americanfootball_ncaaf', nba: 'basketball_nba', ncaam: 'basketball_ncaab',
    nhl: 'icehockey_nhl', mlb: 'baseball_mlb', ncaabase: 'baseball_ncaa', mma: 'mma_mixed_martial_arts' };
  /* what the desk's screen carries for a game: the odds key and the id the
     sport's own card uses (football: the research key's id; elsewhere the
     research entity the panel opens) */
  C.screenOf = function (ctx) {
    if (!ctx) return null;
    var k = C.splitKey(ctx.researchKey);
    return { sport: C.DESK_SPORT[ctx.sport] || ctx.sport || null, game_id: k ? k.id : (ctx.entity || null), home: ctx.home || null, away: ctx.away || null, market: ctx.marketType || null };
  };

  /* ============================================================== IDENTITY */
  /* the research key's two halves: 'nfl|2026_07_DAL_PHI' -> { league:'nfl', id:'2026_07_DAL_PHI' } */
  C.splitKey = function (key) {
    var m = /^([a-z0-9]+)\|(.+)$/.exec(str(key));
    return m ? { league: m[1], id: m[2] } : null;
  };
  function teamName(t) { return t ? str(t.name || t.short || t.abbr) || null : null; }
  C.fromSlateEvent = function (e) {
    if (!e || !e.id) return null;
    var r = e.research || {};
    var key = present(r.game_key) ? String(r.game_key) : null;
    return {
      sport: str(e.sport) || null, gameId: String(e.id), researchKey: key,
      module: r.module || null, entity: present(r.entity) ? String(r.entity) : null,
      season: num(e.season), home: teamName(e.home), away: teamName(e.away),
      start: e.time_tbd ? null : (e.start_utc || null),
      marketType: null, marketSide: null, selectedModel: null, researchTimestamp: null
    };
  };
  /* a game opened by its research key (the game research page, a watchlist
     row): what is known is the key, and the labels the caller saw */
  C.fromResearchKey = function (key, meta) {
    var k = C.splitKey(key); if (!k) return null;
    meta = meta || {};
    return {
      sport: k.league === 'p4' ? 'cfb' : k.league, gameId: meta.gameId || null, researchKey: (k.league === 'p4' ? 'cfb' : k.league) + '|' + k.id,
      module: 'football', entity: (k.league === 'p4' ? 'cfb' : k.league) + '|' + k.id,
      season: num(meta.season), home: meta.home || null, away: meta.away || null, start: meta.start || null,
      marketType: meta.marketType || null, marketSide: meta.marketSide || null, selectedModel: null, researchTimestamp: meta.researchTimestamp || null
    };
  };
  /* one key for "the same game", whichever door it came through */
  C.keyOf = function (ctx) { return ctx ? (ctx.researchKey || ctx.gameId || null) : null; };
  C.label = function (ctx) { return ctx && ctx.away && ctx.home ? ctx.away + ' at ' + ctx.home : (ctx && (ctx.home || ctx.away)) || 'this game'; };

  /* ================================================================= LINKS
     Every feature's own route for the game. A link is null when the feature
     does not cover the sport or the game carries no id that feature uses. */
  C.links = function (ctx, opts) {
    opts = opts || {};
    var out = { research: null, game: null, signals: null, foresight: null, simulator: null };
    if (!ctx) return out;
    var sp = ctx.sport, k = C.splitKey(ctx.researchKey);
    if (k && C.GAME_PAGE_SPORTS[k.league]) out.game = '#game/' + k.league + '/' + encodeURIComponent(k.id);
    if (ctx.module) out.research = '#research/' + ctx.module + (ctx.entity != null ? '/' + encodeURIComponent(ctx.entity) : '');
    if (!out.research && out.game) out.research = out.game;
    if (sp && C.SIGNAL_SPORTS[sp]) out.signals = '#signals/' + sp;
    if (k && C.FORESIGHT_SPORTS[k.league]) out.foresight = '#foresight/game/' + encodeURIComponent(k.league + ':' + k.id);
    var simKey = C.SIM_KEY[sp] || sp, sims = opts.simSports || null;
    if (simKey && (!sims || sims[simKey])) out.simulator = '#simulator/' + simKey;
    return out;
  };

  /* ===================================================== RECENTLY VIEWED
     The games this device opened, newest first. Identifiers and labels only. */
  C.RECENT_MAX = 12;
  C.recentAdd = function (list, ctx, now) {
    var key = C.keyOf(ctx); if (!key) return (list || []).slice(0, C.RECENT_MAX);
    var row = { key: key, sport: ctx.sport || null, gameId: ctx.gameId || null, researchKey: ctx.researchKey || null, module: ctx.module || null,
      entity: ctx.entity || null, home: ctx.home || null, away: ctx.away || null, start: ctx.start || null, at: new Date(now == null ? 0 : now).toISOString() };
    var out = [row];
    (list || []).forEach(function (x) { if (x && x.key !== key && out.length < C.RECENT_MAX) out.push(x); });
    return out;
  };
  /* drop what is long over: a game more than `days` past its start */
  C.recentPrune = function (list, now, days) {
    var lim = (days == null ? 4 : days) * D;
    return (list || []).filter(function (x) { var t = ms(x && x.start); return x && x.key && (t == null || now - t < lim); });
  };

  /* ============================================== THE LAST-VISIT SNAPSHOT
     What this device saw: per game, the status, EdgeDesk's published fair
     numbers and the captured quote with its book and capture time. Numbers are
     held as displayed (0.1 point, 0.1 probability point) so a change is a
     change a reader could have seen. */
  C.snapshotOf = function (events, markets, now) {
    var g = {};
    (events || []).forEach(function (e) {
      if (!e || !e.id) return;
      var r = e.research || {}, m = r.model || null, f = (m && m.fair) || {}, mk = (markets || {})[e.id] || null;
      var spd = mk && mk.spread && mk.spread.home ? mk.spread.home : {}, tot = mk && mk.total ? mk.total : {}, ml = mk && mk.moneyline ? mk.moneyline : {};
      g[e.id] = {
        st: e.status || null, start: e.start_utc || null,
        fs: r1(f.spread_home), ft: r1(f.total), fw: r3(f.home_win),
        mk: mk && ms(mk.captured_at) != null ? { book: mk.book || null, at: mk.captured_at, sh: r1(spd.point), t: r1(tot.point), mlh: num(ml.home) } : null
      };
    });
    return { v: 1, at: new Date(now == null ? 0 : now).toISOString(), games: g };
  };
  /* keep the reference small: games more than two days past their start go */
  C.snapshotPrune = function (snap, now) {
    if (!snap || !snap.games) return snap;
    var out = {}, lim = 2 * D;
    Object.keys(snap.games).forEach(function (id) { var x = snap.games[id], t = ms(x && x.start); if (t == null || now - t < lim) out[id] = x; });
    return { v: snap.v, at: snap.at, games: out };
  };
  function sgn(v) { return v == null ? '—' : (v === 0 ? 'PK' : (v > 0 ? '+' : '') + v.toFixed(1)); }
  /* the changes between a stored reference and now, per game:
       { kind, from, to, text, comparable, from_at?, to_at?, book? }
     kinds: status · model_spread · model_total · model_win · quote_spread ·
            quote_total · quote_moneyline · quote_new · quote_book_changed */
  C.diff = function (prev, cur) {
    var out = {};
    if (!prev || !prev.games || !cur || !cur.games) return out;
    Object.keys(cur.games).forEach(function (id) {
      var a = prev.games[id], b = cur.games[id], ch = [];
      if (!a) return;   /* a game the reference never held has no "before" */
      if (a.st && b.st && a.st !== b.st) ch.push({ kind: 'status', from: a.st, to: b.st, comparable: true, text: 'Status ' + a.st.toLowerCase() + ' → ' + b.st.toLowerCase() });
      if (a.fs != null && b.fs != null && a.fs !== b.fs) ch.push({ kind: 'model_spread', from: a.fs, to: b.fs, comparable: true, text: 'EdgeDesk fair spread (home) ' + sgn(a.fs) + ' → ' + sgn(b.fs) });
      if (a.ft != null && b.ft != null && a.ft !== b.ft) ch.push({ kind: 'model_total', from: a.ft, to: b.ft, comparable: true, text: 'EdgeDesk fair total ' + a.ft.toFixed(1) + ' → ' + b.ft.toFixed(1) });
      if (a.fw != null && b.fw != null && Math.abs(a.fw - b.fw) >= 0.001) ch.push({ kind: 'model_win', from: a.fw, to: b.fw, comparable: true, text: 'EdgeDesk home win probability ' + (a.fw * 100).toFixed(1) + '% → ' + (b.fw * 100).toFixed(1) + '%' });
      var qa = a.mk, qb = b.mk;
      if (!qa && qb) ch.push({ kind: 'quote_new', from: null, to: qb.at, comparable: false, book: qb.book, to_at: qb.at, text: 'A price was captured' + (qb.book ? ' from ' + qb.book : '') + ' (none was on file at your last visit)' });
      else if (qa && qb && qa.at !== qb.at) {
        if (str(qa.book) !== str(qb.book)) ch.push({ kind: 'quote_book_changed', from: qa.book, to: qb.book, comparable: false, from_at: qa.at, to_at: qb.at, text: 'The captured price is now from ' + (qb.book || 'another book') + ' (was ' + (qa.book || 'another book') + '): not compared' });
        else {
          var base = { comparable: true, book: qb.book, from_at: qa.at, to_at: qb.at };
          if (qa.sh != null && qb.sh != null && qa.sh !== qb.sh) ch.push(Object.assign({ kind: 'quote_spread', from: qa.sh, to: qb.sh, text: (qb.book || 'Book') + ' home spread ' + sgn(qa.sh) + ' → ' + sgn(qb.sh) }, base));
          if (qa.t != null && qb.t != null && qa.t !== qb.t) ch.push(Object.assign({ kind: 'quote_total', from: qa.t, to: qb.t, text: (qb.book || 'Book') + ' total ' + qa.t.toFixed(1) + ' → ' + qb.t.toFixed(1) }, base));
          if (qa.mlh != null && qb.mlh != null && qa.mlh !== qb.mlh) ch.push(Object.assign({ kind: 'quote_moneyline', from: qa.mlh, to: qb.mlh, text: (qb.book || 'Book') + ' home moneyline ' + (qa.mlh > 0 ? '+' : '') + qa.mlh + ' → ' + (qb.mlh > 0 ? '+' : '') + qb.mlh }, base));
        }
      }
      if (ch.length) out[id] = ch;
    });
    return out;
  };
  /* The reference for this browser session. `stored` is what the device kept
     ({ ref, next }); `sessionStarted` says whether this browser session has
     already rolled it. A new session takes the last snapshot of the previous
     one as its reference; within a session the reference stays put while
     `next` follows what is on screen. */
  C.visitRoll = function (stored, cur, sessionStarted) {
    stored = stored && typeof stored === 'object' ? stored : {};
    var ref = stored.ref || null;
    if (!sessionStarted && stored.next) ref = stored.next;
    return { ref: ref, next: cur };
  };

  /* ============================================== KEEP RESEARCHING (pure)
     The game page's workspace: every other feature that holds something about
     THIS game, by its ids, each saying what it covers and what it does not.
     o: { simSports, simLabel, signedIn, onCard, started } */
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var SPORT_NAME = { nfl: 'NFL', cfb: 'college football', nba: 'NBA', nhl: 'NHL', mlb: 'MLB', ncaam: 'college basketball', mma: 'UFC' };
  C.railHTML = function (ctx, o) {
    o = o || {};
    var L = C.links(ctx, { simSports: o.simSports || null }), sp = SPORT_NAME[ctx && ctx.sport] || 'this sport', lab = C.label(ctx);
    var card = function (id, title, body) { return '<div class="gw-c" id="' + id + '"><h3 class="gw-h">' + e(title) + '</h3>' + body + '</div>'; };
    var h = '<section class="gv-sec gw-rail" id="gvWs" aria-labelledby="gvWsH"><h2 class="gv-h2" id="gvWsH">Keep researching this game</h2>'
      + '<p class="gw-lede">Everything else EdgeDesk holds on ' + e(lab) + ', opened on this game — no searching for it again.</p><div class="gw-grid">';
    h += card('gvWsSig', 'Signals', '<p class="gw-note">Material changes Signal Center detected in ' + e(sp) + ' research — forecast shifts, availability, market disagreement — each with its evidence and whether it is still valid.</p>'
      + (L.signals ? '<a class="gw-btn ghost" href="' + e(L.signals) + '">Open ' + e(SPORT_NAME[ctx.sport] || '') + ' signals</a>' : '<p class="gw-note">Signal Center does not cover this sport.</p>'));
    h += card('gvWsFs', 'Market Foresight', L.foresight ? '<p class="gw-note">Checking the record…</p>' : '<p class="gw-note">Market Foresight covers NFL and college football pregame markets only.</p>');
    h += card('gvWsSim', 'Simulator', L.simulator
      ? '<p class="gw-note">Where this game sits in the season: division, playoff and title probabilities from EdgeDesk’s published season simulation' + (o.simLabel ? ' (' + e(o.simLabel) + ')' : '') + '. A season simulation is not a price for this single game.</p><a class="gw-btn ghost" href="' + e(L.simulator) + '">Open the Simulator</a>'
      : '<p class="gw-note">No season simulation is listed for this sport.</p>');
    h += card('gvWsAi', 'Ask EdgeDesk AI', '<p class="gw-note">The desk is handed this game’s identifiers (never your account data) and answers from EdgeDesk’s research, citing its sources; anything it cannot verify, it says so.</p>'
      + '<button type="button" class="gw-btn" data-gw-ask>Ask about this game</button>');
    h += card('gvWsMine', 'Your workspace', '<p class="gw-note">' + (o.onCard ? 'This game is on your Card.' : 'Save it to your Card to come back to it, or record a position you placed.') + ' Saving never records a bet: a position exists only when you record or import one.</p>'
      + '<div class="gw-acts">' + (o.onCard ? '<a class="gw-btn ghost" href="#card">Open your Card</a>' : (o.started ? '' : '<button type="button" class="gw-btn ghost" data-gw-card>Add to my Card</button>'))
      + '<button type="button" class="gw-btn ghost" data-gw-record>Record a position</button></div><p class="gw-msg" id="gvWsMsg" role="status" aria-live="polite"></p>');
    return h + '</div></section>';
  };

  /* ============================================================ BROWSER */
  var LS_RECENT = 'edgedesk_recent_games_v1', LS_SEEN = 'edgedesk_overview_seen_v1', SS_ROLLED = 'edgedesk_overview_rolled_v1';
  function store() { try { return root && root.localStorage ? root.localStorage : null; } catch (_) { return null; } }
  function sess() { try { return root && root.sessionStorage ? root.sessionStorage : null; } catch (_) { return null; } }
  function read(st, k, dflt) { try { var v = st && st.getItem(k); return v ? JSON.parse(v) : dflt; } catch (_) { return dflt; } }
  function write(st, k, v) { try { if (st) st.setItem(k, JSON.stringify(v)); } catch (_) { /* storage full or off: memory only */ } }
  /* a device may be shared: the reference is kept per account */
  function who() { try { var u = typeof root.edUser === 'function' ? root.edUser() : null; return u && u.id ? String(u.id).slice(0, 64) : 'anon'; } catch (_) { return 'anon'; } }

  var CUR = null, SUBS = [];
  C.get = function () { return CUR ? Object.assign({}, CUR) : null; };
  /* the game on screen: kept here, handed to the AI desk's screen (ids only),
     and remembered as recently viewed */
  C.set = function (ctx, o) {
    o = o || {};
    if (!ctx || !C.keyOf(ctx)) return null;
    CUR = Object.assign({}, ctx);
    try {
      var sc = C.screenOf(ctx);
      if (typeof root.edScreenSet === 'function' && o.screen !== false && sc.game_id)
        root.edScreenSet({ panel: o.panel || 'game', sport: sc.sport, game_id: sc.game_id, home: sc.home, away: sc.away, market: sc.market });
    } catch (_) { /* the desk reads what it can */ }
    if (o.remember !== false) {
      var now = Date.now(), st = store();
      write(st, LS_RECENT, C.recentPrune(C.recentAdd(read(st, LS_RECENT, []), ctx, now), now));
    }
    SUBS.forEach(function (f) { try { f(C.get()); } catch (_) { /* a listener never breaks another */ } });
    return C.get();
  };
  C.subscribe = function (f) { if (typeof f === 'function') SUBS.push(f); return function () { SUBS = SUBS.filter(function (x) { return x !== f; }); }; };
  C.recent = function () { var now = Date.now(); return C.recentPrune(read(store(), LS_RECENT, []), now); };
  C.recentClear = function () { write(store(), LS_RECENT, []); };
  /* the Overview's reference: returns { ref, cur, changes } and keeps the
     session's latest snapshot for the next visit */
  C.visit = function (events, markets, now) {
    now = now == null ? Date.now() : now;
    var st = store(), ss = sess(), key = LS_SEEN + ':' + who();
    var cur = C.snapshotOf(events, markets, now);
    var rolled = !!(ss && (function () { try { return ss.getItem(SS_ROLLED + ':' + who()); } catch (_) { return null; } })());
    var r = C.visitRoll(read(st, key, null), cur, rolled);
    try { if (ss) ss.setItem(SS_ROLLED + ':' + who(), '1'); } catch (_) { /* no session storage: every load is a new visit */ }
    var keep = { ref: r.ref ? C.snapshotPrune(r.ref, now) : null, next: C.snapshotPrune(r.next, now) };
    write(st, key, keep);
    return { ref: keep.ref, cur: cur, changes: C.diff(keep.ref, cur) };
  };
  /* "Mark all as seen": the reference becomes what is on screen now */
  C.visitSeen = function (events, markets, now) {
    now = now == null ? Date.now() : now;
    var cur = C.snapshotPrune(C.snapshotOf(events, markets, now), now);
    write(store(), LS_SEEN + ':' + who(), { ref: cur, next: cur });
    return cur;
  };
  /* the rail's live parts: the Foresight preview (through the shell's
     service, when that layer registered itself) and the actions, each
     through the feature that owns it */
  C.railFill = function (el, ctx) {
    if (!el || !ctx) return;
    var box = el.querySelector('#gvWs'); if (!box) return;
    var L = C.links(ctx), X = root.EDShell, F = X && X.service ? X.service('foresight') : null, fs = box.querySelector('#gvWsFs');
    if (fs && L.foresight) {
      if (!F || !F.game) fs.innerHTML = '<h3 class="gw-h">Market Foresight</h3><p class="gw-note">Market Foresight is not loaded on this page.</p><a class="gw-btn ghost" href="' + e(L.foresight) + '">Open its record</a>';
      else {
        var k = C.splitKey(ctx.researchKey);
        Promise.resolve().then(function () { return F.game(k.league, k.id); }).then(function (p) {
          var cur = el.querySelector('#gvWsFs'); if (cur) cur.innerHTML = '<h3 class="gw-h">Market Foresight</h3>' + F.previewHTML(p, L.foresight);
        }, function () { var cur = el.querySelector('#gvWsFs'); if (cur) cur.innerHTML = '<h3 class="gw-h">Market Foresight</h3>' + F.previewHTML({ state: 'error' }, L.foresight); });
      }
    }
    if (box.getAttribute('data-bound')) return;
    box.setAttribute('data-bound', '1');
    box.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
      var msg = function (s) { var m = box.querySelector('#gvWsMsg'); if (m) m.textContent = s; };
      if (t.closest('[data-gw-ask]')) { C.set(ctx, { panel: 'game' }); if (typeof root.edAsk === 'function') root.edAsk('Research ' + C.label(ctx) + ': the model, the captured price, what is missing and the audit.', 'game'); return; }
      if (t.closest('[data-gw-card]')) {
        var U = root.EDDecisionUI, k = C.splitKey(ctx.researchKey), r = null;
        try { r = U && U.addGame && k ? U.addGame(k.id) : null; } catch (_) { r = null; }
        if (r && r.added) msg('Added to your Card. It is research you are considering — not a bet.');
        else if (r && r.reason) msg(r.reason + '.');
        else msg('EdgeDesk has no current decision for this game to save yet. Watch it (☆ above) and it stays in your saved games.');
        return;
      }
      if (t.closest('[data-gw-record]')) {
        var U2 = root.EDDecisionUI, ent = null;
        try { ent = (U2 && U2.entries ? U2.entries() : []).filter(function (x) { return x && x.event_key === ctx.researchKey && x.status !== 'removed'; })[0] || null; } catch (_) { ent = null; }
        if (typeof root.edRecordPosition === 'function') root.edRecordPosition(ent ? { entry: ent, surface: 'game' } : { surface: 'game' });
      }
    });
  };
  C._keys = { recent: LS_RECENT, seen: LS_SEEN, rolled: SS_ROLLED };
  C._ms = ms; C._MIN = MIN; C._H = H;
  return C;
});
