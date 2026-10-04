/* ===========================================================================
   EdgeDesk first run — "Here's what EdgeDesk found today."

   Two jobs, in one file because they share one idea (what a new reader
   actually does in the terminal):

   1  INSTRUMENTATION. The funnel's in-app steps (supabase/funnel.sql) —
      terminal_opened, board_viewed, game_opened, ev_viewed,
      custom_price_checked, research_saved, brief_copied — recorded by
      WRAPPING the terminal's existing handlers (fbOpenGame's trackGame,
      researchGo, show, fbGxToggle, fbGxCopy, EDBRIEF.copy*, EDMine.toggleWatch
      …) rather than editing each of them inside app.html. A wrapper calls
      the original with the same `this`, arguments and return value, and a
      tracking failure can never reach the reader. The player-prop steps are
      sent by lib/edgedesk_props_ui.js itself. Every event goes through
      lib/edgedesk_track.js; the database decides what counts.

   2  THE FIRST-RUN SCREEN. For a reader in their first two weeks, an INLINE
      panel at the top of Research — never a modal, nothing to dismiss before
      the board — with, from EdgeDesk's current research:
        largest model–market disagreements
        research-grade game opportunities
        research-grade player-prop opportunities
        games with incomplete information (and why)
        recently changed markets
      a five-step progress strip that ticks from the reader's OWN recorded
      actions (view the board, open a game, open a player prop, compare a
      sportsbook price, save or watch research), and an optional "Tune your
      terminal" card — sports, game lines / player props / both, sportsbooks,
      favorite teams — that reorders what the panel shows first. Skipping it
      costs nothing.

   It replaces two first-visit interruptions for a NEW account: the
   conceptual welcome modal (edgedesk_welcome_seen is set, because the panel
   is the welcome) and — only once supabase/funnel.sql is live and the
   preferences card is pending — the six-step onboarding modal, whose
   leagues and sportsbooks the card asks inline (lib/edgedesk_personal_ui.js
   onbBusy() asks EDFirstRun.holdsOnboarding()). Persona is still asked on the
   desk, alerts in Settings.

   Nothing here computes a research number. Games, props and statuses come
   from lib/edgedesk_home.js over the reader's own game_research_state rows
   and football/home/board.json — the same view model the landing page uses.

   Browser: window.EDFirstRun. Node: require (tests; the DOM parts no-op).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDFirstRun = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_first_run_v1';
  var KEY = 'edgedesk_first_run_v1', WEL_KEY = 'edgedesk_welcome_seen', NEW_DAYS = 14;
  var STEPS = [
    { k: 'board', t: 'View today’s board' },
    { k: 'game', t: 'Open a game' },
    { k: 'prop', t: 'Open a player prop' },
    { k: 'price', t: 'Compare a sportsbook price' },
    { k: 'save', t: 'Save or watch research' }
  ];
  var STEP_OF = { board_viewed: 'board', first_run_viewed: 'board', game_opened: 'game', prop_opened: 'prop',
    ev_viewed: 'price', custom_price_checked: 'price', research_saved: 'save' };
  var S = { state: null, rpcOk: false, show: false, prefsResolved: true, view: null, prefs: null, local: null,
    host: null, teams: [], booted: false, entitled: false, opened: false };

  /* ------------------------------------------------------------ small */
  var doc = root && root.document;
  function lsGet(k) { try { return JSON.parse(root.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ms(t) { var v = Date.parse(t); return isFinite(v) ? v : NaN; }
  function sessionUser() {
    var s = lsGet('edgedesk_session');
    return s && s.user ? s.user : null;
  }
  function local() { if (!S.local) S.local = lsGet(KEY) || { steps: {} }; if (!S.local.steps) S.local.steps = {}; return S.local; }
  function saveLocal() { lsSet(KEY, local()); }
  function sbBase() { return { url: root.SB_URL || null, key: root.SB_KEY || null }; }
  function token() {
    try { if (typeof root.edToken === 'function') return Promise.resolve(root.edToken()); } catch (e) { /* fall through */ }
    var s = lsGet('edgedesk_session');
    return Promise.resolve(s && s.access_token ? s.access_token : sbBase().key);
  }
  function sb(path, opts) {
    opts = opts || {};
    var B = sbBase();
    if (!B.url || !B.key || typeof root.fetch !== 'function') return Promise.reject(new Error('no database'));
    return token().then(function (t) {
      var h = { apikey: B.key, authorization: 'Bearer ' + (t || B.key), 'content-type': 'application/json' };
      if (opts.prefer) h.prefer = opts.prefer;
      return root.fetch(B.url + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
        .then(function (r) { if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.status === 204 ? null : r.text().then(function (x) { return x ? JSON.parse(x) : null; }); });
    });
  }

  /* ================================================== 1 · INSTRUMENTATION */
  function ev(name, props, opts) { try { if (root.EDTrack && root.EDTrack.event) root.EDTrack.event(name, props || {}, opts || {}); } catch (e) { /* never in the way */ } }
  function wrap(obj, name, before) {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__edfr) return false;
    var orig = obj[name];
    var w = function () { try { before.apply(this, arguments); } catch (e) { /* tracking never fails a click */ } return orig.apply(this, arguments); };
    w.__edfr = true; w.__orig = orig;
    try { obj[name] = w; } catch (e) { return false; }
    return obj[name] === w;
  }
  function lg(sport) { return /nfl/i.test(String(sport || '')) ? 'nfl' : 'cfb'; }
  var wired = {};
  function instrument() {
    var W = root; if (!W) return wired;
    /* every step also ticks the first-run progress, whoever sent it */
    if (W.EDTrack && !W.EDTrack.__edfr) {
      var orig = W.EDTrack.event;
      W.EDTrack.event = function (name) { var r = orig.apply(this, arguments); try { if (STEP_OF[name]) mark(STEP_OF[name]); } catch (e) { /* ignore */ } return r; };
      W.EDTrack.__edfr = true;
    }
    /* a game opened: every open path (fbOpenGame, fbP4Gate, the desk) calls EDMine.trackGame */
    wired.game = wrap(W.EDMine, 'trackGame', function (sport, gid) { if (gid != null && gid !== '') ev('game_opened', { entity: lg(sport) + '|' + gid, league: lg(sport) }); })
      || wrap(W, 'fbOpenGame', function (sport, gid) { if (gid != null && gid !== '') ev('game_opened', { entity: lg(sport) + '|' + gid, league: lg(sport) }); });
    wired.board = wrap(W, 'researchGo', function (sub) { if (sub === 'football' || sub === 'cfb' || sub === 'rdesk') ev('board_viewed', { surface: sub === 'cfb' ? 'football' : sub }); });
    wired.show = wrap(W, 'show', function (v) { if (v === 'edges' || v === 'card') ev('board_viewed', { surface: v }); });
    wired.price = wrap(W, 'fbGxToggle', function (gid, id) { if (id === 'price') ev('ev_viewed', { entity: 'cfb|' + gid, surface: 'game_price' }); });
    wired.check = wrap(W, 'checkBet', function () { ev('custom_price_checked', { surface: 'desk_check_my_bet' }, { once: false }); });
    wired.watch = wrap(W.EDMine, 'toggleWatch', function (key) { if (!(W.EDMine && W.EDMine.isWatched && W.EDMine.isWatched(key))) ev('research_saved', { entity: key, kind: 'watchlist' }); });
    wired.journal = wrap(W.EDMine, 'journalSave', function () { ev('research_saved', { kind: 'journal' }, { once: false }); });
    wired.saved = wrap(W, 'rsSaveToggle', function () { ev('research_saved', { kind: 'saved_research' }, { once: false }); });
    wired.follow = wrap(W, 'fbGxFollow', function (gid) { ev('research_saved', { entity: 'cfb|' + gid, kind: 'follow' }); });
    wired.card = wrap(W.EDDecisionUI, 'addOpportunity', function (o) { if (o && o.type !== 'PLAYER_PROP') ev('research_saved', { entity: (o.event && o.event.event_key) || '', kind: 'card' }); });
    wired.copy = wrap(W, 'fbGxCopy', function (gid) { ev('brief_copied', { entity: 'cfb|' + gid, surface: 'game_brief' }); });
    if (W.EDBRIEF) ['copyCms', 'copyText', 'copyLink'].forEach(function (m) { wired['brief_' + m] = wrap(W.EDBRIEF, m, function () { ev('brief_copied', { surface: 'brief_' + m }, { once: false }); }); });
    wired.share = wrap(W.EDMine, 'shareCopy', function () { ev('brief_copied', { surface: 'share_card' }, { once: false }); });
    wired.receipt = wrap(W, 'rcptCopy', function () { ev('brief_copied', { surface: 'receipt' }, { once: false }); });
    return wired;
  }
  function onToggle(e) {
    /* the NFL card's price check is a native <details>; toggle does not bubble */
    var d = e && e.target;
    if (!d || !d.matches || !d.matches('details.qev-more') || !d.open) return;
    var host = d.closest ? d.closest('[id^="fbg-nfl-"]') : null;
    ev('ev_viewed', { entity: host ? 'nfl|' + host.id.replace('fbg-nfl-', '') : '', surface: 'nfl_price' });
  }

  /* ==================================================== 2 · FIRST RUN */
  function isNewAccount(createdAt) { var c = ms(createdAt); return isFinite(c) && (Date.now() - c) < NEW_DAYS * 864e5; }
  function mark(k) {
    var L = local();
    if (L.steps[k]) return;
    L.steps[k] = new Date().toISOString(); saveLocal();
    if (S.show) paintSteps();
  }
  function steps() {
    var L = local(), srv = S.state && S.state.steps ? S.state.steps : {};
    var out = {}; STEPS.forEach(function (s) { out[s.k] = !!(srv[s.k] || L.steps[s.k]); });
    return out;
  }
  /* the six-step onboarding modal waits while the inline card is pending,
     and only once the database can remember the answer */
  function holdsOnboarding() { return !!(S.show && S.rpcOk && !S.prefsResolved); }

  function favKeyForTeam(g, side) {
    var m = /_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(g.game_key || ''));
    if (g.league === 'nfl' && m) return 'nfl:' + (side === 'home' ? m[2] : m[1]).toLowerCase();
    var name = side === 'home' ? g.home : g.away;
    return (g.league === 'nfl' ? 'nfl:' : 'cfb:') + String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function favOf(g) {
    var f = (S.prefs && S.prefs.favorite_teams) || local().favorite_teams || [];
    return f.indexOf(favKeyForTeam(g, 'home')) >= 0 || f.indexOf(favKeyForTeam(g, 'away')) >= 0;
  }
  function leagues() { var l = (S.prefs && S.prefs.leagues) || local().leagues || []; return l.length ? l : ['nfl', 'cfb']; }
  function order(list, key) {
    var L = leagues();
    return list.slice().sort(function (a, b) {
      var fa = key(a), fb = key(b);
      var pa = (fa.fav ? 0 : 2) + (L.indexOf(fa.league) >= 0 ? 0 : 1), pb = (fb.fav ? 0 : 2) + (L.indexOf(fb.league) >= 0 ? 0 : 1);
      return pa - pb;
    });
  }

  function sections(V) {
    var games = V.games.map(function (g) { g.fav = favOf(g); return g; });
    var gkey = function (g) { return { fav: g.fav, league: g.league }; };
    var pkey = function (p) { var g = games.filter(function (x) { return x.game_key === p.game_key; })[0]; return { fav: g ? g.fav : false, league: p.league }; };
    var live = games.filter(function (g) { return g.status !== 'DATA_INCOMPLETE' && g.gap != null; });
    return {
      disagreements: order(live.slice().sort(function (a, b) { return b.gap - a.gap; }), gkey).slice(0, 3),
      research: order(games.filter(function (g) { return g.status === 'RESEARCH'; }), gkey).slice(0, 4),
      props: order(V.props.filter(function (p) { return p.status === 'RESEARCH'; }).concat(V.props.filter(function (p) { return p.status === 'WATCH'; })), pkey).slice(0, 4),
      incomplete: order(games.filter(function (g) { return g.status === 'DATA_INCOMPLETE' && g.status_note; })
        .sort(function (a, b) { return ms(a.kickoff_at) - ms(b.kickoff_at); }), gkey).slice(0, 3),
      changed: order(games.filter(function (g) { return g.moved != null && Math.abs(g.moved) >= 1; })
        .sort(function (a, b) { return Math.abs(b.moved) - Math.abs(a.moved); }), gkey).slice(0, 3)
    };
  }
  function chip(x) { return '<span class="edfr-chip ' + esc(x.tone) + '">' + esc(x.status_label) + '</span>'; }
  function gameItem(g, sub) {
    return '<button type="button" class="edfr-item" data-fr="game" data-k="' + esc(g.game_key) + '"><span class="t">' + (g.fav ? '<span class="fav" title="A favorite team">★</span>' : '')
      + esc(g.matchup) + '</span>' + chip(g) + '<span class="s">' + sub + '</span></button>';
  }
  function gameLine(g) {
    return esc(g.league_label) + (g.kickoff_text ? ' · ' + esc(g.kickoff_text) : '') + ' · ED <b>' + esc(g.fair_text || '—') + '</b> · Mkt <b>' + esc(g.market_text || '—') + '</b>'
      + (g.gap_text ? ' · gap <b>' + esc(g.gap_text) + '</b>' : '') + (g.market_stale ? ' · <span class="stale">stale market</span>' : (g.market_age_text ? ' · ' + esc(g.market_age_text) : (g.market_note ? ' · market: ' + esc(g.market_note) : '')));
  }
  function propItem(p) {
    var cls = p.supports === true ? 'pos' : (p.supports === false ? 'neg' : '');
    return '<button type="button" class="edfr-item" data-fr="prop" data-k="' + esc(p.id) + '"><span class="t">' + esc(p.player) + ' · ' + esc(p.market) + '</span>' + chip(p)
      + '<span class="s">' + esc(p.selection || '') + ' ' + esc(p.odds_text || '') + (p.book ? ' ' + esc(p.book) : '') + ' · Mkt <b>' + esc(p.line_text || '—') + '</b> · ED <b>' + esc(p.projection_text || '—') + '</b>'
      + (p.difference_text ? ' <span class="' + cls + '">(' + esc(p.difference_text) + ')</span>' : '') + (p.ev_text ? ' · EV <b>' + esc(p.ev_text) + '</b>' + (p.ev_label ? ' ' + esc(p.ev_label) : '') : '')
      + (p.age_text ? ' · <span class="' + (p.price_state === 'STALE' || p.price_state === 'EXPIRED' ? 'stale' : '') + '">' + esc(p.age_text) + '</span>' : '') + '</span></button>';
  }
  function card(title, sub, body, empty) {
    return '<div class="edfr-card"><h4>' + esc(title) + (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</h4>' + (body || '<p class="edfr-empty">' + esc(empty) + '</p>') + '</div>';
  }
  function sinceLine(V) {
    var prev = S.state && S.state.previous_visit_at ? ms(S.state.previous_visit_at) : NaN;
    if (!isFinite(prev)) return '';
    var re = V.games.filter(function (g) { return ms(g.computed_at) > prev; }).length;
    var nw = V.games.filter(function (g) { return ms(g.first_seen_at) > prev; }).length;
    var np = V.props.filter(function (p) { return p.status === 'RESEARCH' && ms(p.captured_at) > prev; }).length;
    if (!re && !nw && !np) return '';
    var ago = root.EDHome ? root.EDHome.ageText((Date.now() - prev) / 60000) : '';
    return '<p class="edfr-since">Since your last visit' + (ago ? ' (' + esc(ago) + ')' : '') + ': '
      + [nw ? nw + ' new game' + (nw === 1 ? '' : 's') : null, re ? re + ' re-priced' : null, np ? np + ' research-grade prop' + (np === 1 ? '' : 's') + ' priced since' : null].filter(Boolean).join(' · ') + '</p>';
  }
  function stepsHTML() {
    var st = steps(), n = 0;
    var li = STEPS.map(function (s, i) { if (st[s.k]) n++; return '<li class="' + (st[s.k] ? 'done' : '') + '"><button type="button" data-fr="step" data-k="' + s.k + '"><span class="ck" aria-hidden="true">' + (st[s.k] ? '✓' : (i + 1)) + '</span><span>' + esc(s.t) + '</span><span class="sr">' + (st[s.k] ? ' (done)' : '') + '</span></button></li>'; }).join('');
    return '<ol class="edfr-steps" aria-label="Getting started">' + li + '</ol><p class="edfr-prog">' + n + ' of ' + STEPS.length + ' done' + (n === STEPS.length ? ' · you’ve used the whole workflow' : '') + '</p>';
  }
  function paintSteps() {
    if (!S.host) return;
    var box = S.host.querySelector('[data-fr-steps]'); if (box) box.innerHTML = stepsHTML();
  }
  function prefsHTML() {
    var P = S.prefs || {}, L = local();
    var lgs = P.leagues && P.leagues.length ? P.leagues : (L.leagues || []), focus = P.research_focus || L.research_focus || '', books = P.books || L.books || [];
    S.teams = (P.favorite_teams || L.favorite_teams || []).slice();
    var BOOKS = root.EDPersonal && root.EDPersonal.BOOKS ? root.EDPersonal.BOOKS : [];
    var opt = function (type, name, val, label, on) { return '<label><input type="' + type + '" name="' + name + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '> ' + esc(label) + '</label>'; };
    var dl = [];
    (S.view ? S.view.games : []).forEach(function (g) {
      ['home', 'away'].forEach(function (side) { var k = favKeyForTeam(g, side), n = side === 'home' ? g.home : g.away; if (dl.indexOf(k + '|' + n) < 0) dl.push(k + '|' + n); });
    });
    return '<details class="edfr-prefs"' + (S.prefsResolved ? '' : ' open') + '><summary>Tune your terminal <small>optional &middot; skip anytime</small></summary>'
      + '<div class="edfr-f"><b>Sports</b><div class="edfr-opts">' + opt('checkbox', 'lg', 'nfl', 'NFL', lgs.indexOf('nfl') >= 0) + opt('checkbox', 'lg', 'cfb', 'College football', lgs.indexOf('cfb') >= 0) + '</div></div>'
      + '<div class="edfr-f"><b>What you research</b><div class="edfr-opts">' + opt('radio', 'focus', 'game_lines', 'Game lines', focus === 'game_lines') + opt('radio', 'focus', 'player_props', 'Player props', focus === 'player_props') + opt('radio', 'focus', 'both', 'Both', focus === 'both') + '</div></div>'
      + (BOOKS.length ? '<div class="edfr-f"><b>Sportsbooks you use</b><div class="edfr-opts">' + BOOKS.map(function (b) { return opt('checkbox', 'book', b.key, b.label, books.indexOf(b.key) >= 0); }).join('') + '</div></div>' : '')
      + '<div class="edfr-f"><b>Favorite teams</b><div class="edfr-team"><input id="edfrTeam" list="edfrTeams" placeholder="Type a team on this week’s slate" autocomplete="off" aria-label="Favorite team"><button type="button" data-fr="team-add">Add</button></div>'
      + '<datalist id="edfrTeams">' + dl.map(function (x) { var p = x.split('|'); return '<option value="' + esc(p[1]) + '" data-k="' + esc(p[0]) + '"></option>'; }).join('') + '</datalist>'
      + '<div class="edfr-tags" data-fr-tags>' + tagsHTML() + '</div></div>'
      + '<div class="edfr-act"><button type="button" class="pri" data-fr="save">Save preferences</button><button type="button" data-fr="skip">Skip</button><small>Used only to order what you see first. Change it anytime in Settings.</small></div>'
      + '<div class="edfr-msg" data-fr-msg hidden></div></details>';
  }
  function tagsHTML() {
    return S.teams.map(function (k, i) { return '<span>' + esc(teamLabel(k)) + '<button type="button" data-fr="team-del" data-i="' + i + '" aria-label="Remove ' + esc(teamLabel(k)) + '">×</button></span>'; }).join('');
  }
  function teamLabel(k) {
    var hit = null;
    (S.view ? S.view.games : []).some(function (g) { return ['home', 'away'].some(function (side) { if (favKeyForTeam(g, side) === k) { hit = side === 'home' ? g.home : g.away; return true; } return false; }); });
    return hit || String(k).split(':')[1];
  }

  function render() {
    if (!S.host || !S.view) return;
    var V = S.view, c = V.counts, X = sections(V), focus = (S.prefs && S.prefs.research_focus) || local().research_focus;
    var subBits = [c.games_analyzed != null ? c.games_analyzed + ' games analyzed' : null,
      (c.game_research != null || c.prop_research != null) ? (c.game_research || 0) + ' game-market and ' + (c.prop_research || 0) + ' player-prop research opportunities' : null,
      V.times.model_text ? 'model updated ' + V.times.model_text : null].filter(Boolean);
    var cards = {
      games: card('Research-grade game opportunities', c.game_research != null ? c.game_research + ' on the slate' : '', X.research.map(function (g) { return gameItem(g, gameLine(g)); }).join(''), 'No game clears the research gates right now. PASS is a normal answer.'),
      dis: card('Largest model–market disagreements', '', X.disagreements.map(function (g) { return gameItem(g, gameLine(g)); }).join(''), 'No game has a current market to compare yet.'),
      props: card('Research-grade player props', c.prop_research != null ? c.prop_research + ' now' : '', X.props.map(propItem).join(''), 'No player prop clears the research threshold right now.'),
      inc: card('Games with incomplete information', c.data_incomplete != null ? c.data_incomplete + ' games' : '', X.incomplete.map(function (g) { return gameItem(g, esc(g.league_label) + ' · ' + esc(g.status_note)); }).join(''), 'Every game on the slate has what EdgeDesk needs.'),
      chg: card('Recently changed markets', '', X.changed.map(function (g) {
        return gameItem(g, gameLine(g) + ' · moved <b>' + esc(Math.abs(g.moved).toFixed(1)) + '</b> pts ' + (g.moved_toward_model === true ? 'toward EdgeDesk’s number' : (g.moved_toward_model === false ? 'away from EdgeDesk’s number' : '')));
      }).join(''), 'No market has moved a point or more since EdgeDesk first priced it.')
    };
    var orderCards = focus === 'player_props' ? ['props', 'games', 'dis', 'chg', 'inc'] : ['dis', 'games', 'props', 'chg', 'inc'];
    S.host.innerHTML = '<section class="edfr" aria-labelledby="edfrH">'
      + '<div class="edfr-hd"><div><span class="edfr-ey">Your first week &middot; research, not picks</span><h3 id="edfrH">Here’s what EdgeDesk found today.</h3>'
      + (subBits.length ? '<p class="edfr-sub">' + esc(subBits.join(' · ')) + '</p>' : '') + sinceLine(V) + '</div>'
      + '<button type="button" class="edfr-x" data-fr="hide">Hide</button></div>'
      + '<div data-fr-steps>' + stepsHTML() + '</div>'
      + '<div class="edfr-grid">' + orderCards.map(function (k) { return cards[k]; }).join('') + '</div>'
      + prefsHTML()
      + '<p class="edfr-foot">Every item is read from EdgeDesk’s current research with the time its price was captured. A label says whether something is worth researching — it is never a pick. 21+ · 1-800-GAMBLER.</p>'
      + '</section>';
  }

  /* ---------------------------------------------------------- actions */
  function gameByKey(k) { return S.view ? S.view.games.filter(function (g) { return g.game_key === k; })[0] : null; }
  function propById(k) { return S.view ? S.view.props.filter(function (p) { return p.id === k; })[0] : null; }
  function openGame(g) {
    if (!g || !g.app_hash) return;
    try { root.location.hash = g.app_hash.slice(1); } catch (e) { /* no navigation */ }
  }
  function openProp(p) {
    if (!p) return;
    if (root.EDPropsUI && root.EDPropsUI.go && p.prop_id) { root.EDPropsUI.go({ league: p.league, prop: p.prop_id }); return; }
    if (p.app_hash) try { root.location.hash = p.app_hash.slice(1); } catch (e) { /* no navigation */ }
  }
  function firstGame() { var X = sections(S.view); return X.research[0] || X.disagreements[0] || (S.view.games[0] || null); }
  function firstProp() { var X = sections(S.view); return X.props[0] || S.view.props[0] || null; }
  function step(k) {
    if (k === 'board') { if (typeof root.researchGo === 'function') root.researchGo('football'); else mark('board'); return; }
    if (k === 'game' || k === 'save') { openGame(firstGame()); if (k === 'save') say('Tap ☆ Watch on the game card to save it to your watchlist.'); return; }
    if (k === 'prop' || k === 'price') { var p = firstProp(); if (p) openProp(p); else if (typeof root.show === 'function') root.show('pprops'); return; }
  }
  function say(t, err) {
    var m = S.host && S.host.querySelector('[data-fr-msg]');
    if (m) { m.hidden = false; m.className = 'edfr-msg' + (err ? ' err' : ''); m.textContent = t; }
  }
  function readForm() {
    var q = function (sel) { return [].slice.call(S.host.querySelectorAll(sel)); };
    var lgs = q('input[name="lg"]:checked').map(function (i) { return i.value; });
    var f = q('input[name="focus"]:checked').map(function (i) { return i.value; })[0] || null;
    var books = q('input[name="book"]:checked').map(function (i) { return i.value; });
    return { leagues: lgs, research_focus: f, books: books, favorite_teams: S.teams.slice(0, 12) };
  }
  function upsertPrefs(row) {
    var u = sessionUser(); if (!u || !u.id) return Promise.reject(new Error('not signed in'));
    var body = [Object.assign({ user_id: u.id }, row)];
    var go = function (b) { return sb('user_preferences?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: b }); };
    /* before supabase/funnel.sql is applied the new columns do not exist:
       save what the table has, keep the rest on this device */
    return go(body).catch(function (e) {
      if (e && e.status === 400) { var slim = Object.assign({}, body[0]); ['research_focus', 'favorite_teams', 'first_run_seen_at', 'first_run_done_at', 'trial_emails'].forEach(function (k) { delete slim[k]; }); return go([slim]); }
      throw e;
    });
  }
  function onboardingStatus(next) {
    var cur = S.prefs && S.prefs.onboarding_status;
    return cur && cur !== 'pending' ? cur : next;
  }
  function save() {
    var f = readForm(), L = local();
    L.leagues = f.leagues; L.research_focus = f.research_focus; L.books = f.books; L.favorite_teams = f.favorite_teams; L.prefs_resolved = true; saveLocal();
    S.prefs = Object.assign({}, S.prefs || {}, f);
    upsertPrefs(Object.assign({}, f, { onboarding_status: onboardingStatus('completed') })).then(function () {
      S.prefsResolved = true; S.prefs.onboarding_status = onboardingStatus('completed');
      try { if (root.EDMine && root.EDMine.S) root.EDMine.S.prefs = Object.assign({}, root.EDMine.S.prefs || {}, f, { onboarding_status: S.prefs.onboarding_status }); } catch (e) { /* ignore */ }
      ev('preferences_saved', { leagues: f.leagues.join(','), focus: f.research_focus || '', books: f.books.length, teams: f.favorite_teams.length }, { once: false });
      render(); say('Saved. The panel now leads with what you research.');
    }).catch(function () { S.prefsResolved = true; render(); say('Saved on this device. We could not reach your account just now; it will not ask again here.', true); });
  }
  function skip() {
    var L = local(); L.prefs_resolved = true; saveLocal();
    S.prefsResolved = true;
    ev('onboarding_skipped', {});
    var stSkip = onboardingStatus('skipped');
    S.prefs = Object.assign({}, S.prefs || {}, { onboarding_status: stSkip });
    try { if (root.EDMine && root.EDMine.S) root.EDMine.S.prefs = Object.assign({}, root.EDMine.S.prefs || {}, { onboarding_status: stSkip }); } catch (e) { /* ignore */ }
    upsertPrefs({ onboarding_status: stSkip }).catch(function () { /* the device remembers */ });
    var d = S.host && S.host.querySelector('.edfr-prefs'); if (d) d.open = false;
  }
  function hide() {
    var L = local(); L.done_at = new Date().toISOString(); saveLocal();
    S.show = false;
    if (S.host) { S.host.innerHTML = ''; S.host.hidden = true; }
    if (S.rpcOk) upsertPrefs({ first_run_done_at: L.done_at }).catch(function () { /* the device remembers */ });
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-fr]') : null;
    if (!t || !S.host || !S.host.contains(t)) return;
    var a = t.getAttribute('data-fr'), k = t.getAttribute('data-k');
    if (a === 'game') openGame(gameByKey(k));
    else if (a === 'prop') openProp(propById(k));
    else if (a === 'step') step(k);
    else if (a === 'hide') hide();
    else if (a === 'save') save();
    else if (a === 'skip') skip();
    else if (a === 'team-add') addTeam();
    else if (a === 'team-del') { S.teams.splice(+t.getAttribute('data-i'), 1); var tg = S.host.querySelector('[data-fr-tags]'); if (tg) tg.innerHTML = tagsHTML(); }
  }
  function addTeam() {
    var inp = S.host && S.host.querySelector('#edfrTeam'); if (!inp) return;
    var v = String(inp.value || '').trim(); if (!v) return;
    var opt = [].slice.call(S.host.querySelectorAll('#edfrTeams option')).filter(function (o) { return o.value.toLowerCase() === v.toLowerCase(); })[0];
    var k = opt ? opt.getAttribute('data-k') : null;
    if (!k) { say('Pick a team from this week’s slate.', true); return; }
    if (S.teams.indexOf(k) < 0 && S.teams.length < 12) S.teams.push(k);
    inp.value = ''; var tg = S.host.querySelector('[data-fr-tags]'); if (tg) tg.innerHTML = tagsHTML();
  }

  /* ------------------------------------------------------------ loading */
  function loadView() {
    var now = Date.now(), iso = function (t) { return new Date(t).toISOString(); };
    var cols = 'game_key,sport,game_id,home,away,kickoff_at,status,projected,fair_home_line,fair_total,market_home_line,market_kind,market_book,'
      + 'market_captured_at,market_stale,gap_pts,win_prob_home,reliability_score,research_label,research_grade,qb_confirmed,key_reason,priority_rank,'
      + 'computed_at,first_seen_at,fair:state->fair,market:state->market,gap:state->gap,priority:state->priority,movement:state->movement,props:state->props';
    var rows = sb('game_research_state?select=' + cols + '&kickoff_at=gt.' + encodeURIComponent(iso(now)) + '&kickoff_at=lt.' + encodeURIComponent(iso(now + 8 * 864e5))
      + '&order=priority_rank.asc.nullslast,kickoff_at.asc&limit=300').catch(function () { return null; });
    var stat = typeof root.fetch === 'function' ? root.fetch('/football/home/board.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
    return Promise.all([rows, stat]).then(function (x) {
      if (!root.EDHome) return null;
      var rpc = Array.isArray(x[0]) ? root.EDHome.fromStateRows(x[0], now) : null;
      if (!rpc && !x[1]) return null;
      return root.EDHome.build(rpc, x[1], now);
    });
  }
  function mount() {
    if (S.host || !doc) return S.host;
    var v = doc.getElementById('v-research'); if (!v) return null;
    var h = doc.createElement('div'); h.id = 'edFirstRun';
    var before = doc.getElementById('rsSearchWrap');
    if (before && before.parentNode === v) v.insertBefore(h, before); else v.insertBefore(h, v.firstChild);
    h.addEventListener('click', onClick);
    h.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target && e.target.id === 'edfrTeam') { e.preventDefault(); addTeam(); } });
    S.host = h;
    return h;
  }

  function start() {
    if (S.opened) return; S.opened = true;
    ev('terminal_opened', { surface: 'boot' }, { now: true });
    var u = sessionUser();
    var st = sb('rpc/ed_first_run_state', { method: 'POST', body: { p_session: root.EDTrack && root.EDTrack.session ? root.EDTrack.session() : null } })
      .then(function (r) { return r && r.ok ? r : null; }).catch(function () { return null; });
    return st.then(function (r) {
      S.state = r; S.rpcOk = !!r;
      S.prefs = r && r.prefs ? r.prefs : null;
      var created = r && r.account_created_at ? r.account_created_at : (u && u.created_at);
      var L = local();
      var st5 = steps(), allDone = STEPS.every(function (s) { return st5[s.k]; });
      var dismissed = !!(L.done_at || (S.prefs && S.prefs.first_run_done_at));
      var finishedLongAgo = allDone && L.all_done_at && (Date.now() - ms(L.all_done_at)) > 864e5;
      if (allDone && !L.all_done_at) { L.all_done_at = new Date().toISOString(); saveLocal(); }
      S.show = isNewAccount(created) && !dismissed && !finishedLongAgo;
      if (!S.show) return;
      S.prefsResolved = !!(L.prefs_resolved || (S.prefs && S.prefs.onboarding_status && S.prefs.onboarding_status !== 'pending'));
      if (!mount()) { S.show = false; return; }
      S.host.innerHTML = '<section class="edfr"><div class="edfr-hd"><div><span class="edfr-ey">Your first week</span><h3>Here’s what EdgeDesk found today.</h3><p class="edfr-sub">Reading the current slate…</p></div></div></section>';
      return loadView().then(function (V) {
        if (!V || !V.games.length && !V.props.length) { if (S.host) { S.host.innerHTML = ''; S.host.hidden = true; } S.show = false; return; }
        S.view = V; render();
        ev('first_run_viewed', { games: V.games.length, props: V.props.length });
        if (S.rpcOk && !(S.prefs && S.prefs.first_run_seen_at)) upsertPrefs({ first_run_seen_at: new Date().toISOString() }).catch(function () { /* optional */ });
      });
    });
  }

  function boot() {
    if (S.booted || !doc) return; S.booted = true;
    /* a brand-new account's first visit: the panel is the welcome, so the
       conceptual welcome modal does not stack on top of it */
    var u = sessionUser();
    if (u && isNewAccount(u.created_at) && !local().done_at) { try { if (!root.localStorage.getItem(WEL_KEY)) root.localStorage.setItem(WEL_KEY, String(Date.now())); } catch (e) { /* no storage */ } }
    instrument();
    setTimeout(instrument, 1500);                     /* anything defined late */
    doc.addEventListener('toggle', onToggle, true);
    var go = function () { if (!S.entitled) { S.entitled = true; start(); } };
    if (root.ED_ENTITLED === 'ok' || root.ED_ENTITLED === 'unknown') go();
    doc.addEventListener('ed:entitled', function (e) { var d = e && e.detail; if (d === 'ok' || d === 'unknown') go(); });
  }
  if (doc) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot(); }

  return {
    VERSION: VERSION, STEPS: STEPS, STEP_OF: STEP_OF,
    holdsOnboarding: holdsOnboarding,
    /* the reader saved or skipped the card's preferences on this visit */
    answered: function () { return !!(S.show || S.opened) && !!S.prefsResolved && !!local().prefs_resolved; },
    open: function () { var L = local(); delete L.done_at; saveLocal(); S.opened = false; start(); },
    /* tests */
    _state: S, _instrument: instrument, _wrap: wrap, _sections: sections, _favKey: favKeyForTeam, _isNew: isNewAccount, _steps: steps, _mark: mark
  };
}));
