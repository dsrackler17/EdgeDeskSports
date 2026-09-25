/* ===========================================================================
   EdgeDesk personal research terminal — the browser half.  window.EDMine

   The watchlist star, "My research" (watchlist · alerts · journal · decision
   quality), the notification bell, the research-desk sections (live proof
   metrics, Top 5 games to research, my watchlist, recent changes, my decision
   quality), the journal's decision form, first-run onboarding, the settings
   sections (research preferences, research alerts, partner program) and the
   affiliate attribution claim.

   It computes nothing a reader is shown as EdgeDesk's view of a game: every
   number comes from a research state (lib/edgedesk_personal.js), built by the
   football module in this page (window.fbResearchStates) or read from the
   shared table the server fills with the same function. Personal data lives
   on the reader's account under row level security
   (supabase/personal_research.sql); nothing here takes a user id — the
   server reads it from the token.

   Research, not picks. Every string here passes EDPersonal.copyOk.
   =========================================================================== */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.EDMine) return;
  var P = window.EDPersonal;
  var M = window.EDMine = { version: 'edgedesk_personal_ui/1' };

  /* ------------------------------------------------------------ helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function attr(s) { return esc(s).replace(/\\/g, '\\\\'); }
  /* a JavaScript string literal that is safe INSIDE a double-quoted HTML
     attribute: quotes, ampersands and angle brackets become \x escapes, so a
     team name from a feed can never close the attribute or open a tag */
  function js(s) {
    return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\x27").replace(/"/g, '\\x22')
      .replace(/&/g, '\\x26').replace(/</g, '\\x3c').replace(/>/g, '\\x3e').replace(/[\r\n\u2028\u2029]/g, ' ') + "'";
  }
  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function $(id) { return document.getElementById(id); }
  function signed(v) { v = num(v); return v == null ? '—' : (v === 0 ? 'PK' : (v > 0 ? '+' : '') + v.toFixed(1)); }
  function pct(v, dp) { v = num(v); return v == null ? '—' : (100 * v).toFixed(dp == null ? 0 : dp) + '%'; }
  function ago(t) {
    var ms = typeof t === 'number' ? t : Date.parse(t);
    if (!isFinite(ms)) return '';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function when(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function user() { try { return typeof window.edUser === 'function' ? window.edUser() : null; } catch (_) { return null; } }
  function signedIn() { var u = user(); return !!(u && u.id); }
  function event(name, props) { try { if (typeof window.edEvent === 'function') window.edEvent(name, props || {}); } catch (_) { } }
  function toast(msg, bad) {
    var el = $('edmToast');
    if (!el) { el = document.createElement('div'); el.id = 'edmToast'; el.className = 'edm-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg; el.className = 'edm-toast on' + (bad ? ' bad' : '');
    clearTimeout(M._toastT); M._toastT = setTimeout(function () { el.className = 'edm-toast'; }, 3200);
  }
  M.esc = esc;

  /* ------------------------------------------------------------ the API */
  async function token() {
    try { if (typeof window.edToken === 'function') return await window.edToken(); } catch (_) { }
    return window.SB_KEY;
  }
  async function api(path, opts) {
    opts = opts || {};
    if (!window.SB_URL) throw new Error('no database configured');
    var t = await token();
    var h = { apikey: window.SB_KEY, authorization: 'Bearer ' + t };
    if (opts.body !== undefined) h['content-type'] = 'application/json';
    if (opts.prefer) h.prefer = opts.prefer;
    var r = await fetch(window.SB_URL + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    if (!r.ok) {
      var e = new Error('db ' + r.status); e.status = r.status;
      try { e.body = await r.text(); } catch (_) { }
      throw e;
    }
    var txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }
  function rpc(fn, args) { return api('rpc/' + fn, { method: 'POST', body: args || {} }); }
  M.api = api; M.rpc = rpc;
  function inList(keys) { return 'in.(' + keys.map(function (k) { return '"' + String(k).replace(/"/g, '') + '"'; }).join(',') + ')'; }

  /* ------------------------------------------------------------ state */
  var S = M.S = {
    ready: false, schema: null,          /* schema: null unknown, true installed, false missing */
    prefs: null, alertPrefs: null,
    watch: {}, watchRows: [], watchLoaded: false,
    alerts: [], unread: 0,
    journal: null, serverTop: null, serverTopAt: 0, metrics: null, record: null,
    liveAt: 0, live: {},
    affiliate: null
  };
  function schemaMissing(e) { return e && (e.status === 404 || /PGRST205|does not exist|schema cache/i.test(String(e.body || ''))); }

  /* the live research states from this page's own football module */
  M.liveStates = function () {
    try {
      if (typeof window.fbResearchStates !== 'function' || !window.FB || !window.FB.at) return null;
      if (Date.now() - S.liveAt < 20000 && S.liveList) return S.liveList;
      var r = window.fbResearchStates();
      if (!r || !r.layer_ready) return null;
      S.live = {}; r.states.forEach(function (s) { S.live[s.game_key] = s; });
      S.liveAt = Date.now(); S.liveList = r.states; S.liveInfo = r;
      return r.states;
    } catch (_) { return null; }
  };
  /* the best state we hold for a game: the page's live one, else the server's */
  M.stateFor = function (key) {
    M.liveStates();
    if (S.live[key]) return S.live[key];
    var w = S.watchRows.filter(function (x) { return x.game_key === key; })[0];
    if (w && w.state) return w.state;
    var t = (S.serverTop || []).filter(function (x) { return x.game_key === key; })[0];
    return t || null;
  };
  async function stateFromServer(key) {
    try { var r = await api('game_research_state?select=state&game_key=eq.' + encodeURIComponent(key) + '&limit=1'); return r && r[0] ? r[0].state : null; }
    catch (_) { return null; }
  }

  /* ------------------------------------------------------------ loading */
  M.boot = async function () {
    if (M._booted || !signedIn() || !P) return;
    M._booted = true;
    injectChrome();
    try {
      var rows = await Promise.all([
        api('user_preferences?select=*&limit=1'),
        api('alert_preferences?select=*&limit=1'),
        api('watchlist_games?select=game_key,home,away,kickoff_at,created_at,last_seen_at,seen_hash&order=created_at.desc&limit=200'),
        api('user_alerts?select=id,game_key,kind,title,body,severity,payload,created_at,read_at&dismissed_at=is.null&order=created_at.desc&limit=60')
      ]);
      S.schema = true;
      S.prefs = rows[0] && rows[0][0] || null;
      S.alertPrefs = rows[1] && rows[1][0] || null;
      S.watch = {}; (rows[2] || []).forEach(function (w) { S.watch[w.game_key] = w; });
      S.alerts = rows[3] || [];
      S.unread = S.alerts.filter(function (a) { return !a.read_at; }).length;
      S.ready = true;
    } catch (e) {
      S.schema = schemaMissing(e) ? false : null;
      S.ready = true;
    }
    paintBell(); paintStars();
    if (S.schema) { importLocalFollows(); maybeOnboard(); }
    claimAttribution();
    try { if (window.RESEARCH_SUB === 'rdesk') M.paintDesk(); } catch (_) { }
    clearInterval(M._poll);
    M._poll = setInterval(pollAlerts, 5 * 60 * 1000);
  };
  async function pollAlerts() {
    if (!S.schema || document.hidden) return;
    try {
      S.alerts = await api('user_alerts?select=id,game_key,kind,title,body,severity,payload,created_at,read_at&dismissed_at=is.null&order=created_at.desc&limit=60') || [];
      S.unread = S.alerts.filter(function (a) { return !a.read_at; }).length;
      paintBell();
      if (M._panelTab === 'alerts') renderPanel();
    } catch (_) { }
  }

  /* ------------------------------------------------------------ the star */
  M.isWatched = function (key) { return !!S.watch[key]; };
  M.starHTML = function (sport, gid, meta) {
    if (!P) return '';
    var key = P.gameKey(sport, gid), on = !!S.watch[key];
    meta = meta || {};
    return '<button type="button" class="edm-star' + (on ? ' on' : '') + '" data-edm-key="' + attr(key) + '" aria-pressed="' + (on ? 'true' : 'false') + '"'
      + ' title="' + (on ? 'Remove from my watchlist' : 'Watch game') + '" aria-label="' + (on ? 'Remove from my watchlist' : 'Watch game') + '"'
      + ' onclick="event.stopPropagation();EDMine.toggleWatch(' + js(key) + ',' + js(meta.home || '') + ',' + js(meta.away || '') + ',' + js(meta.kickoff || '') + ')">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>'
      + '<span>' + (on ? 'Watching' : 'Watch game') + '</span></button>';
  };
  function paintStars() {
    var els = document.querySelectorAll('[data-edm-key]');
    for (var i = 0; i < els.length; i++) {
      var on = !!S.watch[els[i].getAttribute('data-edm-key')];
      els[i].classList.toggle('on', on);
      els[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      els[i].title = on ? 'Remove from my watchlist' : 'Watch game';
      var sp = els[i].querySelector('span'); if (sp) sp.textContent = on ? 'Watching' : 'Watch game';
    }
  }
  M.paintStars = paintStars;
  M.toggleWatch = async function (key, home, away, kickoff) {
    if (!signedIn()) { toast('Sign in to keep a watchlist.', true); return; }
    if (S.schema === false) { toast('The watchlist is not installed on this deployment yet.', true); return; }
    var was = S.watch[key];
    if (was) {
      delete S.watch[key]; S.watchRows = S.watchRows.filter(function (w) { return w.game_key !== key; }); paintStars();
      try { await api('watchlist_games?game_key=eq.' + encodeURIComponent(key), { method: 'DELETE', prefer: 'return=minimal' }); event('watchlist_remove', { game_key: key }); toast('Removed from your watchlist.'); }
      catch (e) { S.watch[key] = was; paintStars(); toast('Could not remove it. Try again.', true); }
    } else {
      var st = M.stateFor(key) || null;
      var row = { game_key: key, home: home || (st && st.home) || null, away: away || (st && st.away) || null,
        kickoff_at: kickoff ? new Date(isFinite(+kickoff) ? +kickoff : Date.parse(kickoff)).toISOString() : (st && st.kickoff_at) || null,
        seen_state: st, seen_hash: st ? st.state_hash : null, last_seen_at: new Date().toISOString() };
      S.watch[key] = row;
      S.watchRows = [Object.assign({}, row, { state: st, state_hash: st ? st.state_hash : null, changed: false })]
        .concat(S.watchRows.filter(function (w) { return w.game_key !== key; }));
      paintStars();
      try {
        await api('watchlist_games?on_conflict=user_id,game_key', { method: 'POST', body: [row], prefer: 'return=minimal,resolution=ignore-duplicates' });
        event('watchlist_add', { game_key: key }); toast('Watching ' + ((row.away && row.home) ? row.away + ' @ ' + row.home : 'this game') + '.');
      } catch (e) { delete S.watch[key]; S.watchRows = S.watchRows.filter(function (w) { return w.game_key !== key; }); paintStars(); toast(e && e.status === 400 && /200 games/.test(e.body || '') ? 'A watchlist holds at most 200 games.' : 'Could not add it. Try again.', true); }
    }
    if (window.RESEARCH_SUB === 'rdesk') M.paintDesk();
    if (M._panelTab === 'watchlist') M.loadWatchlist().then(renderPanel);
  };

  /* games this device followed before the watchlist lived on the account are
     carried over once, never duplicated (the database refuses a second row) */
  async function importLocalFollows() {
    try {
      if (localStorage.getItem('edgedesk_watch_imported_v1')) return;
      var keys = [];
      var f = JSON.parse(localStorage.getItem('ed_research_follow_v1') || '{}');
      if (f && typeof f === 'object' && !Array.isArray(f)) Object.keys(f).forEach(function (gid) { if (/^[A-Za-z0-9_.:-]{1,64}$/.test(gid)) keys.push({ game_key: 'cfb|' + gid, home: null, away: (f[gid] && f[gid].label) || null }); });
      var d = JSON.parse(localStorage.getItem('ed_research_watch_v1') || '[]');
      if (Array.isArray(d)) d.forEach(function (w) {
        if (!w || !w.game_id) return;
        var sp = /nfl/i.test(String(w.sport || '')) ? 'nfl' : 'cfb';
        if (/^[A-Za-z0-9_.:-]{1,64}$/.test(String(w.game_id))) keys.push({ game_key: sp + '|' + w.game_id, kickoff_at: w.kickoff || null });
      });
      localStorage.setItem('edgedesk_watch_imported_v1', String(Date.now()));
      keys = keys.filter(function (k) { return !S.watch[k.game_key]; });
      if (!keys.length) return;
      var rows = keys.slice(0, 60).map(function (k) { return { game_key: k.game_key, home: null, away: null, kickoff_at: k.kickoff_at || null, source: 'import' }; });
      await api('watchlist_games?on_conflict=user_id,game_key', { method: 'POST', body: rows, prefer: 'return=minimal,resolution=ignore-duplicates' });
      rows.forEach(function (r) { S.watch[r.game_key] = r; });
      paintStars();
      toast('Added ' + rows.length + ' game' + (rows.length === 1 ? '' : 's') + ' you followed on this device to your watchlist.');
    } catch (_) { }
  }

  /* ------------------------------------------------------------ watchlist */
  M.loadWatchlist = async function () {
    if (!S.schema) return [];
    try {
      var rows = await api('my_watchlist?select=*&order=kickoff_at.asc.nullslast&limit=200');
      S.watchRows = rows || []; S.watchLoaded = true;
      S.watch = {}; S.watchRows.forEach(function (w) { S.watch[w.game_key] = w; });
      paintStars();
    } catch (e) { S.watchErr = e; }
    return S.watchRows;
  };
  function relChip(s) {
    var r = s && s.reliability || {};
    if (num(r.score) == null) return '<span class="edm-rel na" title="' + attr(r.note || 'Reliability is not scored for this game') + '">Reliability n/a</span>';
    var cls = r.score >= 80 ? 'hi' : (r.score >= 60 ? 'md' : 'lo');
    return '<span class="edm-rel ' + cls + '" title="Reliability 0-100: how much EdgeDesk trusts the completeness, freshness and stability of the inputs under this projection. Not a probability.">'
      + '<b>' + Math.round(r.score) + '</b> ' + esc(String(r.grade || r.tier || '').toLowerCase()) + '</span>';
  }
  M.relChip = relChip;
  function linesHTML(s) {
    var f = s.fair || {}, m = s.market || {}, g = s.gap || {};
    var fairT = f.text || (num(f.home_line) != null ? P.favText(s, f.home_line) : null);
    var mktT = m.text || (num(m.home_line) != null ? P.favText(s, m.home_line) : null);
    return '<div class="edm-lines">'
      + '<span class="mdl" title="EdgeDesk fair line: the spread EdgeDesk’s model projects."><i>EdgeDesk</i>' + esc(fairT || '—') + '</span>'
      + '<span title="Market line: the sportsbook number EdgeDesk compared against' + (m.kind === 'consensus' ? ' (a consensus reference, not a captured quote)' : '') + '."><i>Market</i>' + esc(mktT || 'no market') + (m.stale ? ' <em class="edm-warn">stale</em>' : '') + '</span>'
      + '<span title="Model-market disagreement in points, measured from EdgeDesk’s raw number."><i>Gap</i>' + (num(g.points) != null ? g.points.toFixed(1) + ' pts' : '—') + '</span>'
      + '<span><i>Reliability</i>' + relChip(s) + '</span></div>';
  }
  function qbText(s) {
    var q = s.qb || {};
    function side(k) {
      var x = q[k]; if (!x) return esc(s[k]) + ': unknown';
      return esc(s[k]) + ': ' + (x.name ? esc(x.name) : 'not named') + ' <em class="' + (x.confirmed ? 'edm-ok' : 'edm-warn') + '">' + (x.confirmed ? 'confirmed' : 'not confirmed') + '</em>';
    }
    return side('away') + ' · ' + side('home');
  }
  function injText(s) {
    var inj = s.injuries || {};
    return ['away', 'home'].map(function (k) { return esc(P.injurySummary(s[k], inj[k])); }).join(' · ');
  }
  function watchRowHTML(w, full) {
    var s = M.stateFor(w.game_key) || w.state || null;
    var key = w.game_key, parts = key.split('|'), sport = parts[0], gid = parts[1];
    var title = s ? P.matchup(s) : ((w.away && w.home) ? w.away + ' @ ' + w.home : key);
    var started = s && s.kickoff_at && Date.parse(s.kickoff_at) <= Date.now();
    var head = '<div class="edm-wr-h"><b>' + esc(title) + '</b><span class="edm-sub">' + esc(sport.toUpperCase()) + (s && s.kickoff_at ? ' · ' + esc(when(s.kickoff_at)) : '') + (started ? ' · started' : '') + '</span>'
      + (w.changed ? '<span class="edm-chg" title="Something in EdgeDesk’s research state changed since you last opened your watchlist.">changed</span>' : '')
      + '<span class="edm-sp"></span>' + M.starHTML(sport, gid) + '</div>';
    if (!s) return '<div class="edm-wr">' + head + '<div class="edm-sub">EdgeDesk has no research state for this game yet — it appears once the game is on a board the server has read.</div></div>';
    var body = linesHTML(s);
    if (full) {
      var mv = s.movement || {}, seen = w.seen_state;
      var changes = seen && w.changed ? P.changes(seen, s, { fair_move_pts: 0.5, market_move_pts: 0.5, reliability_change_pts: 3, diverge_pts: 1 }) : [];
      body += '<div class="edm-grid">'
        + '<div><i>Win probability</i>' + (num(s.win_prob_home) != null ? esc(s.home) + ' ' + pct(s.win_prob_home) : '—') + '</div>'
        + '<div><i>Quarterbacks</i>' + qbText(s) + '</div>'
        + '<div><i>Availability</i>' + injText(s) + '</div>'
        + '<div><i>Market movement</i>' + (num(mv.spread_moved) != null ? mv.spread_moved.toFixed(1) + ' pts since the open' + (num(mv.toward_model) != null ? (mv.toward_model >= 0 ? ', toward EdgeDesk' : ', away from EdgeDesk') : '') : (num(mv.h2h_pp) != null ? Math.abs(mv.h2h_pp).toFixed(1) + ' pp on the moneyline since first capture' : 'no opening line on file')) + '</div>'
        + '<div><i>Fair-line movement</i>' + (seen && num(seen.fair && seen.fair.home_line) != null && num(s.fair && s.fair.home_line) != null
          ? (Math.abs(s.fair.home_line - seen.fair.home_line) < 0.05 ? 'unchanged since your last visit' : esc(P.favText(s, seen.fair.home_line)) + ' → ' + esc(P.favText(s, s.fair.home_line)) + ' since your last visit')
          : 'no earlier number stored') + '</div>'
        + '<div><i>Last updated</i>' + esc(ago(s.computed_at) || '—') + (s.market && s.market.captured_at ? ' · market ' + esc(ago(s.market.captured_at)) : '') + '</div>'
        + '</div>'
        + (s.key_reason ? '<div class="edm-why"><b>Why EdgeDesk disagrees</b> ' + esc(s.key_reason) + '</div>' : '')
        + (changes.length ? '<div class="edm-changes"><b>Changed since your last visit</b><ul>' + changes.map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul></div>'
          : (w.changed ? '<div class="edm-changes"><b>Changed since your last visit</b> the research state changed below the thresholds this list reports.</div>' : ''));
    }
    var acts = '<div class="edm-acts"><button class="edm-btn" onclick="EDMine.openGame(' + js(key) + ')">Research matchup</button>'
      + (started ? '' : '<button class="edm-btn ghost" onclick="EDMine.journalOpen(' + js(key) + ')">Log decision</button>') + '</div>';
    return '<div class="edm-wr">' + head + body + acts + '</div>';
  }
  async function markSeen() {
    var rows = S.watchRows.filter(function (w) { return w.state_hash && w.state_hash !== w.seen_hash; });
    if (!rows.length) return;
    try {
      await Promise.all(rows.slice(0, 40).map(function (w) {
        return api('watchlist_games?game_key=eq.' + encodeURIComponent(w.game_key), { method: 'PATCH', prefer: 'return=minimal',
          body: { last_seen_at: new Date().toISOString(), seen_hash: w.state_hash, seen_state: w.state } });
      }));
    } catch (_) { }
  }

  M.openGame = function (key) {
    var p = String(key).split('|');
    event('research_game_open', { surface: 'personal', game_key: key });
    try { M.close(); } catch (_) { }
    try { window.researchGo('football'); } catch (_) { }
    setTimeout(function () { try { window.fbOpenGame(p[0] === 'cfb' ? 'p4' : 'nfl', p[1]); } catch (_) { } }, 80);
  };

  /* ------------------------------------------------------------ Top 5 */
  async function loadServerTop() {
    if (!S.schema || Date.now() - S.serverTopAt < 5 * 60000) return S.serverTop;
    try {
      var rows = await api('game_research_state?select=state,computed_at&priority_rank=lte.5&kickoff_at=gt.' + encodeURIComponent(new Date().toISOString()) + '&order=priority_rank.asc&limit=20');
      S.serverTop = (rows || []).map(function (r) { return r.state; }).filter(Boolean); S.serverTopAt = Date.now();
    } catch (e) { S.serverTop = S.serverTop || []; }
    return S.serverTop;
  }
  function topFor(league) {
    var live = M.liveStates(), info = S.liveInfo || {};
    var loaded = league === 'nfl' ? info.nfl_loaded : info.cfb_loaded;
    if (live && loaded) return { list: P.topFive(live, league), source: 'live board · ' + ago(S.liveAt) };
    var srv = (S.serverTop || []).filter(function (s) { return s.sport === league; });
    var at = srv.length ? srv[0].computed_at : null;
    return { list: P.topFive(srv, league), source: srv.length ? 'server ranking · ' + ago(at) : null };
  }
  function topRowHTML(s, i) {
    var ex = P.explain(s), parts = s.game_key.split('|');
    return '<div class="edm-top">'
      + '<div class="edm-top-h"><span class="edm-n">#' + (i + 1) + '</span><b>' + esc(P.matchup(s)) + '</b>'
      + '<span class="edm-sub">' + esc(parts[0].toUpperCase()) + ' · ' + esc(when(s.kickoff_at)) + '</span><span class="edm-sp"></span>'
      + M.starHTML(parts[0], parts[1], { home: s.home, away: s.away, kickoff: s.kickoff_at }) + '</div>'
      + linesHTML(s)
      + (ex.why.length ? '<div class="edm-ex"><b>Why it’s worth researching</b><ul>' + ex.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '')
      + (ex.concerns.length ? '<div class="edm-ex concern"><b>Possible concern' + (ex.concerns.length > 1 ? 's' : '') + '</b><ul>' + ex.concerns.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '')
      + '<div class="edm-acts"><button class="edm-btn" onclick="EDMine.openGame(' + js(s.game_key) + ')">Research matchup</button>'
      + '<button class="edm-btn ghost" onclick="EDMine.journalOpen(' + js(s.game_key) + ')">Log decision</button></div></div>';
  }
  M.topLeague = function (lg) { S.topLeague = lg; try { localStorage.setItem('edgedesk_top_league', lg); } catch (_) { } M.paintDesk(); };
  function leagues() {
    var l = (S.prefs && S.prefs.leagues && S.prefs.leagues.length) ? S.prefs.leagues : ['cfb', 'nfl'];
    return l.filter(function (x) { return x === 'cfb' || x === 'nfl'; });
  }
  function topHTML() {
    var lgs = leagues(), cur = S.topLeague;
    if (!cur) { try { cur = localStorage.getItem('edgedesk_top_league'); } catch (_) { } }
    if (lgs.indexOf(cur) < 0) cur = lgs[0];
    var t = topFor(cur);
    var tabs = lgs.length > 1 ? '<div class="edm-seg" role="tablist">' + lgs.map(function (l) {
      return '<button role="tab" aria-selected="' + (l === cur) + '" class="' + (l === cur ? 'on' : '') + '" onclick="EDMine.topLeague(' + js(l) + ')">' + (l === 'cfb' ? 'College Football' : 'NFL') + '</button>';
    }).join('') + '</div>' : '';
    var body;
    if (t.list.length) body = t.list.map(topRowHTML).join('')
      + (t.list.length < 5 ? '<div class="edm-note">Only ' + t.list.length + ' game' + (t.list.length === 1 ? ' clears' : 's clear') + ' the research gates right now. Nothing is added to fill the list.</div>' : '');
    else if (!t.source && cur === 'cfb' && !(window.FB && FB.p4 && FB.p4.loadedAt))
      body = '<div class="edm-empty">The college slate has not been ranked yet on this device. <button class="edm-btn ghost" onclick="try{fbWrLoadCfb()}catch(_){};setTimeout(EDMine.paintDesk,4000)">Load the college slate</button></div>';
    else body = '<div class="edm-empty">No ' + (cur === 'cfb' ? 'college' : 'NFL') + ' game clears the research gates right now: every game either agrees with the market, has no current quote, or rests on data EdgeDesk does not trust. Nothing is forced onto this list.</div>';
    return '<section class="edm-sec" id="edmTop5"><div class="edm-sec-h"><h3>Top 5 Games to Research</h3>'
      + '<span class="edm-sub">' + esc(t.source || 'not ranked yet') + '</span><span class="edm-sp"></span>'
      + '<button class="edm-info" onclick="EDMine.how(\'top5\')" aria-label="How this list is ranked">How it’s ranked</button></div>' + tabs + body
      + '<div class="edm-foot">A research priority, not a ranking of bets. Ordered by research-worthiness — disagreement measured against the model’s own error, independent research flags, market quality, data completeness and movement, scaled by reliability — never by the raw gap.</div></section>';
  }

  /* ------------------------------------------------------------ the desk */
  M.deskHTML = function (where) {
    if (!P) return '';
    if (where === 'top') return '<div id="edmProof" class="edm-proof"></div><div id="edmDeskTop"></div>';
    return '<div id="edmDeskBottom"></div>';
  };
  /* Paint what we hold now, then load what is missing ONCE and paint again.
     The containers are looked up afresh every time: the desk re-renders its
     host whenever the board's data lands, and painting into the nodes this
     call started with would put the fresh data into a detached tree. */
  function renderDesk() {
    var top = $('edmDeskTop'), bottom = $('edmDeskBottom');
    if (top) top.innerHTML = topHTML() + watchDeskHTML();
    if (bottom) bottom.innerHTML = changesDeskHTML() + perfDeskHTML();
    paintStars();
  }
  M.paintDesk = async function () {
    var top = $('edmDeskTop'), bottom = $('edmDeskBottom');
    if (!top && !bottom) return;
    if (!signedIn()) { if (top) top.innerHTML = ''; return; }
    if (S.schema === false) {
      if (top) top.innerHTML = '<div class="edm-empty">Personal research (watchlist, alerts, journal) is not installed on this deployment yet: run supabase/personal_research.sql.</div>';
      return;
    }
    paintProof();
    renderDesk();
    if (!S.ready) return;
    if (M._deskLoad) { await M._deskLoad; renderDesk(); return; }
    var need = [];
    if (!S.serverTop || Date.now() - S.serverTopAt > 5 * 60000) need.push(loadServerTop());
    if (!S.watchLoaded) need.push(M.loadWatchlist());
    if (!S.journal) need.push(M.loadJournal());
    if (!need.length) return;
    M._deskLoad = Promise.all(need).catch(function () { });
    try { await M._deskLoad; } finally { M._deskLoad = null; }
    renderDesk();
  };
  function watchDeskHTML() {
    var rows = S.watchLoaded ? S.watchRows : Object.keys(S.watch).map(function (k) { return S.watch[k]; });
    var upcoming = rows.filter(function (w) { var s = M.stateFor(w.game_key); var k = Date.parse((s && s.kickoff_at) || w.kickoff_at); return !isFinite(k) || k > Date.now() - 4 * 36e5; });
    var changed = upcoming.filter(function (w) { return w.changed; }).length;
    var body = upcoming.length
      ? upcoming.slice(0, 6).map(function (w) { return watchRowHTML(w, false); }).join('')
        + (upcoming.length > 6 ? '<div class="edm-note">' + (upcoming.length - 6) + ' more in your watchlist.</div>' : '')
      : '<div class="edm-empty">Nothing watched yet. Tap <b>Watch game</b> on any game above or on the Football board, and EdgeDesk keeps its research state here — and tells you when something meaningful changes.</div>';
    return '<section class="edm-sec"><div class="edm-sec-h"><h3>My Watchlist</h3><span class="edm-sub">' + upcoming.length + ' game' + (upcoming.length === 1 ? '' : 's')
      + (changed ? ' · <b class="edm-chg-t">' + changed + ' changed</b>' : '') + '</span><span class="edm-sp"></span>'
      + '<button class="edm-info" onclick="EDMine.open(\'watchlist\')">Open watchlist</button></div>' + body + '</section>';
  }
  function changesDeskHTML() {
    var list = S.alerts.slice(0, 5);
    return '<section class="edm-sec"><div class="edm-sec-h"><h3>Recent meaningful changes</h3><span class="edm-sub">' + (S.unread ? S.unread + ' unread' : 'research alerts') + '</span><span class="edm-sp"></span>'
      + '<button class="edm-info" onclick="EDMine.open(\'alerts\')">All alerts</button></div>'
      + (list.length ? list.map(alertRowHTML).join('')
        : '<div class="edm-empty">No alerts yet. When a watched game’s fair line, market, reliability, quarterback or availability changes past your thresholds, it lands here. <button class="edm-btn ghost" onclick="EDMine.settings(\'alerts\')">Set thresholds</button></div>')
      + '</section>';
  }
  function perfDeskHTML() {
    var j = S.journal;
    if (!j) return '<section class="edm-sec"><div class="edm-sec-h"><h3>My decision quality</h3></div><div class="edm-empty">Loading your journal…</div></section>';
    var a = P.analytics(j), pr = a.process;
    return '<section class="edm-sec"><div class="edm-sec-h"><h3>My decision quality</h3><span class="edm-sub">process, not results</span><span class="edm-sp"></span>'
      + '<button class="edm-info" onclick="EDMine.open(\'quality\')">Open analytics</button></div>'
      + (a.counts.total ? '<div class="edm-kpis">'
        + kpi('Tracked decisions', a.counts.total, 'Every decision you logged: researching, passed, leaned and wagered.')
        + kpi('Wagered', a.counts.wagered, null)
        + kpi('Beat closing line', pr.clv_n ? pct(pr.beat_close_rate) : '—', 'Share of graded wagers where the number you took was better than the last market EdgeDesk held before kickoff.')
        + kpi('Average CLV', pr.avg_clv_points != null ? signed(pr.avg_clv_points) + ' pts' : '—', 'Closing-line value: points between your number and the close, on your side. Positive means you beat the close.')
        + '</div>' + (a.sample_note ? '<div class="edm-note">' + esc(a.sample_note) + '</div>' : '')
        : '<div class="edm-empty">No decisions logged yet. <b>Log decision</b> on any game saves your read with EdgeDesk’s numbers as they stood at that moment — then EdgeDesk grades your number against the close.</div>')
      + '</section>';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function kpi(label, v, tip) { return '<div class="edm-kpi"' + (tip ? ' title="' + attr(tip) + '"' : '') + '><i>' + esc(label) + '</i><b>' + esc(String(v)) + '</b></div>'; }

  /* live proof metrics: counts of what the system is doing, nothing else */
  async function paintProof() {
    var el = $('edmProof'); if (!el) return;
    if (!S.metrics || Date.now() - S.metrics._at > 5 * 60000) {
      try { S.metrics = await rpc('edgedesk_proof_metrics', {}); if (S.metrics) S.metrics._at = Date.now(); } catch (_) { S.metrics = S.metrics || null; }
      if (!S.record) { try { var r = await fetch('/record/football/summary.json', { cache: 'no-cache' }); S.record = r.ok ? await r.json() : false; } catch (_) { S.record = false; } }
    }
    el.innerHTML = M.proofHTML(S.metrics, S.record);
  }
  M.proofHTML = function (m, rec) {
    if (!m) return '';
    var items = [];
    function add(v, label, tip, secondary) { if (v == null || (typeof v === 'number' && !isFinite(v))) return; items.push('<span class="edm-pm' + (secondary ? ' x' : '') + '" title="' + attr(tip) + '"><b>' + esc(String(v)) + '</b> ' + esc(label) + '</span>'); }
    add(num(m.games_analyzed), 'games analyzed', 'Upcoming games with a valid EdgeDesk projection on the current slate (next 8 days).');
    add(num(m.research_grade), 'research-grade', 'Games that clear every research gate: a projection, a current market quote, no data fault, no thin data, something to explain — and, in college, reliability EdgeDesk trusts.');
    add(num(m.active_market_quotes), 'active market quotes', 'Captured football quotes seen in the last 6 hours for games that have not started.');
    add(num(m.books_represented), 'sportsbooks represented', 'Distinct sportsbooks behind those quotes.');
    add(num(m.qb_confirmed), 'games with confirmed QBs', 'Games where both starting quarterbacks are confirmed by the source EdgeDesk reads.', true);
    if (num(m.avg_reliability) != null && num(m.reliability_scored)) add(m.avg_reliability, 'avg reliability (' + m.reliability_scored + ' college games)', 'Average reliability score across college games on the slate. The NFL model publishes no reliability score.', true);
    var g = rec && rec.sports ? ((rec.sports.cfb && rec.sports.cfb.counts && rec.sports.cfb.counts.graded) || 0) + ((rec.sports.nfl && rec.sports.nfl.counts && rec.sports.nfl.counts.graded) || 0) : null;
    if (g) add(g, 'predictions graded publicly', 'Pregame EdgeDesk numbers graded against the close on the public football record (record/football).', true);
    if (m.model_updated_at) add(ago(m.model_updated_at), '· model updated', 'When the server last recomputed the slate’s research state.');
    if (m.market_updated_at) add(ago(m.market_updated_at), '· market updated', 'The newest market capture behind the slate.', true);
    if (!items.length) return '';
    return '<div class="edm-pm-row" aria-label="Live system activity">' + items.join('') + '</div>';
  };

  /* ------------------------------------------------------------ alerts */
  function alertRowHTML(a) {
    return '<div class="edm-al' + (a.read_at ? '' : ' unread') + ' ' + esc(a.severity || 'info') + '">'
      + '<div class="edm-al-h"><b>' + esc(a.title) + '</b><span class="edm-sub">' + esc(ago(a.created_at)) + '</span></div>'
      + (a.body ? '<div class="edm-al-b">' + esc(a.body) + '</div>' : '')
      + '<div class="edm-acts">' + (a.game_key ? '<button class="edm-btn ghost sm" onclick="EDMine.alertOpen(' + a.id + ',' + js(a.game_key) + ')">Research matchup</button>' : '')
      + '<button class="edm-btn ghost sm" onclick="EDMine.alertDismiss(' + a.id + ')">Dismiss</button></div></div>';
  }
  function paintBell() {
    var b = $('edmBell'); if (!b) return;
    var n = b.querySelector('.edm-badge');
    if (n) { n.textContent = S.unread > 9 ? '9+' : String(S.unread || ''); n.style.display = S.unread ? '' : 'none'; }
    b.setAttribute('aria-label', 'Research alerts' + (S.unread ? ', ' + S.unread + ' unread' : ''));
    paintAcct();
  }
  M.alertOpen = async function (id, key) {
    try { await api('user_alerts?id=eq.' + id, { method: 'PATCH', body: { read_at: new Date().toISOString() }, prefer: 'return=minimal' }); } catch (_) { }
    S.alerts.forEach(function (a) { if (a.id === id && !a.read_at) { a.read_at = new Date().toISOString(); S.unread = Math.max(0, S.unread - 1); } });
    paintBell(); M.openGame(key);
  };
  M.alertDismiss = async function (id) {
    S.alerts = S.alerts.filter(function (a) { return a.id !== id; });
    S.unread = S.alerts.filter(function (a) { return !a.read_at; }).length;
    paintBell(); if (M._panelTab) renderPanel(); M.paintDesk();
    try { await api('user_alerts?id=eq.' + id, { method: 'PATCH', body: { dismissed_at: new Date().toISOString(), read_at: new Date().toISOString() }, prefer: 'return=minimal' }); } catch (_) { }
  };
  M.alertsReadAll = async function () {
    var ids = S.alerts.filter(function (a) { return !a.read_at; }).map(function (a) { return a.id; });
    if (!ids.length) return;
    S.alerts.forEach(function (a) { a.read_at = a.read_at || new Date().toISOString(); }); S.unread = 0;
    paintBell(); renderPanel();
    try { await api('user_alerts?id=in.(' + ids.join(',') + ')', { method: 'PATCH', body: { read_at: new Date().toISOString() }, prefer: 'return=minimal' }); } catch (_) { }
  };

  /* ------------------------------------------------------------ journal */
  M.loadJournal = async function () {
    if (!S.schema) return [];
    try { S.journal = await api('research_journal?select=*&order=created_at.desc&limit=1000') || []; }
    catch (e) { S.journal = S.journal || []; }
    return S.journal;
  };
  M.journalOpen = async function (key) {
    if (!signedIn()) { toast('Sign in to keep a research journal.', true); return; }
    var s = M.stateFor(key) || await stateFromServer(key);
    var host = modalHost('edmJModal');
    var sn = s ? P.journalSnapshot(s) : null;
    var parts = key.split('|');
    var home = s ? s.home : 'Home', away = s ? s.away : 'Away';
    var books = (S.prefs && S.prefs.books) || [];
    var bookOpts = '<option value="">—</option>' + P.BOOKS.map(function (b) { return '<option value="' + attr(b.label) + '"' + (books[0] === b.key ? ' selected' : '') + '>' + esc(b.label) + '</option>'; }).join('') + '<option value="Other">Other</option>';
    M._jState = { key: key, state: s, snap: sn };
    host.innerHTML = '<div class="edm-modal" role="dialog" aria-modal="true" aria-labelledby="edmJT"><div class="edm-mh"><h3 id="edmJT">Log a research decision</h3><button class="edm-x" onclick="EDMine.modalClose(\'edmJModal\')" aria-label="Close">×</button></div>'
      + '<div class="edm-sub">' + esc(s ? P.matchup(s) + ' · ' + when(s.kickoff_at) : key) + '</div>'
      + '<div class="edm-f"><label>Decision</label><div class="edm-chips" id="edmJDec">'
      + P.DECISIONS.map(function (d, i) { return '<button type="button" class="edm-chip' + (i === 0 ? ' on' : '') + '" data-v="' + d + '" onclick="EDMine.jDec(this)">' + esc(P.DECISION_LABEL[d]) + '</button>'; }).join('') + '</div></div>'
      + '<div class="edm-f2" id="edmJBet">'
      + '<div class="edm-f"><label for="edmJMkt">Market</label><select id="edmJMkt" onchange="EDMine.jMkt()"><option value="">—</option><option value="spread">Spread</option><option value="total">Total</option><option value="moneyline">Moneyline</option></select></div>'
      + '<div class="edm-f"><label for="edmJSel">Side</label><select id="edmJSel"><option value="">—</option></select></div>'
      + '<div class="edm-f"><label for="edmJBook">Sportsbook</label><select id="edmJBook">' + bookOpts + '</select></div>'
      + '<div class="edm-f"><label for="edmJLine">Line <span class="edm-sub" id="edmJLineHint"></span></label><input id="edmJLine" inputmode="decimal" placeholder="e.g. +3.5"></div>'
      + '<div class="edm-f"><label for="edmJOdds">Odds (American)</label><input id="edmJOdds" inputmode="text" placeholder="-110"></div>'
      + '<div class="edm-f"><label for="edmJStake">Stake <span class="edm-sub">optional</span></label><input id="edmJStake" inputmode="decimal" placeholder=""></div>'
      + '</div>'
      + '<div class="edm-f"><label for="edmJNotes">Notes <span class="edm-sub">optional, only you can read them</span></label><textarea id="edmJNotes" rows="3" maxlength="4000" placeholder="What you saw, what would change your mind"></textarea></div>'
      + '<div class="edm-snap"><b>EdgeDesk at this moment</b> — saved with the entry and never recalculated'
      + (s ? '<div class="edm-grid">'
        + '<div><i>Fair line</i>' + esc((s.fair && s.fair.text) || P.favText(s, s.fair && s.fair.home_line) || '—') + '</div>'
        + '<div><i>Market</i>' + esc((s.market && s.market.text) || P.favText(s, s.market && s.market.home_line) || '—') + (s.market && s.market.book ? ' · ' + esc(s.market.book) : '') + '</div>'
        + '<div><i>Gap</i>' + (num(s.gap && s.gap.points) != null ? s.gap.points.toFixed(1) + ' pts' : '—') + '</div>'
        + '<div><i>Win probability</i>' + (num(s.win_prob_home) != null ? esc(s.home) + ' ' + pct(s.win_prob_home) : '—') + '</div>'
        + '<div><i>Reliability</i>' + relChip(s) + '</div>'
        + '<div><i>Model</i>' + esc((s.fair && s.fair.model_version) || '—') + '</div>'
        + '<div class="wide"><i>Quarterbacks</i>' + qbText(s) + '</div></div>'
        : '<div class="edm-warn">EdgeDesk holds no research state for this game right now, so the entry will be saved without EdgeDesk’s numbers.</div>')
      + '</div>'
      + '<div class="edm-err" id="edmJErr" role="alert"></div>'
      + '<div class="edm-acts"><button class="edm-btn" id="edmJSave" onclick="EDMine.journalSave()">Save decision</button><button class="edm-btn ghost" onclick="EDMine.modalClose(\'edmJModal\')">Cancel</button></div>'
      + '<div class="edm-foot">A journal of your own research. EdgeDesk grades your number against the closing line and keeps the result separately: a losing bet can be a good decision, and a winning one a poor number.</div></div>';
    M._jTeams = { home: home, away: away };
    host.classList.add('on');
    M.jMkt(); M.jDecApply('researching');
    event('journal_open', { game_key: key });
  };
  M.jDec = function (btn) {
    var box = $('edmJDec'); var bs = box.querySelectorAll('.edm-chip');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i] === btn);
    M.jDecApply(btn.getAttribute('data-v'));
  };
  M.jDecApply = function (d) {
    M._jDec = d;
    var bet = $('edmJBet'); if (bet) bet.classList.toggle('opt', d !== 'wagered' && d !== 'leaned');
  };
  M.jMkt = function () {
    var m = ($('edmJMkt') || {}).value, sel = $('edmJSel'), t = M._jTeams || {};
    if (!sel) return;
    var opts = m === 'total' ? [['over', 'Over'], ['under', 'Under']] : [['away', t.away], ['home', t.home]];
    sel.innerHTML = '<option value="">—</option>' + opts.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('');
    var hint = $('edmJLineHint'); if (hint) hint.textContent = m === 'spread' ? 'your side’s number, e.g. +3.5' : (m === 'total' ? 'the total, e.g. 47.5' : (m === 'moneyline' ? 'not needed' : ''));
    var line = $('edmJLine'); if (line) line.disabled = m === 'moneyline';
  };
  function numIn(id) { var v = ($(id) || {}).value; if (v == null || String(v).trim() === '') return null; var n = parseFloat(String(v).replace(/[^0-9+.\-]/g, '')); return isFinite(n) ? n : NaN; }
  M.journalSave = async function () {
    var st = M._jState || {}, err = $('edmJErr');
    var entry = { game_key: st.key, decision: M._jDec || 'researching',
      market_type: ($('edmJMkt') || {}).value || null, selection: ($('edmJSel') || {}).value || null,
      sportsbook: ($('edmJBook') || {}).value || null, line: numIn('edmJLine'), price_american: numIn('edmJOdds'), stake: numIn('edmJStake'),
      notes: (($('edmJNotes') || {}).value || '').trim() || null };
    if (entry.market_type === 'moneyline') entry.line = null;
    if (entry.price_american != null && isFinite(entry.price_american)) entry.price_american = Math.round(entry.price_american);
    ['line', 'price_american', 'stake'].forEach(function (k) { if (entry[k] != null && !isFinite(entry[k])) entry[k] = NaN; });
    var v = P.validateJournal(entry);
    if (!v.ok) { err.textContent = v.errors.join('. ') + '.'; return; }
    var s = st.state;
    Object.assign(entry, st.snap || { snapshot: { schema: P.SCHEMA, note: 'no EdgeDesk research state was available when this was saved' }, snapshot_hash: 'js1-none' });
    entry.home = s ? s.home : null; entry.away = s ? s.away : null; entry.kickoff_at = s ? s.kickoff_at : null;
    var btn = $('edmJSave'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await api('research_journal', { method: 'POST', body: [entry], prefer: 'return=minimal' });
      M.modalClose('edmJModal'); toast('Saved to your research journal.');
      event('journal_save', { decision: entry.decision, market: entry.market_type });
      await M.loadJournal(); if (M._panelTab) renderPanel(); M.paintDesk();
    } catch (e) {
      err.textContent = e && e.status === 400 ? 'The server refused that entry: ' + String(e.body || '').slice(0, 160) : 'It did not save. Check your connection and try again.';
      if (btn) { btn.disabled = false; btn.textContent = 'Save decision'; }
    }
  };
  M.journalNotes = async function (entryId) {
    var el = $('edmN-' + entryId); if (!el) return;
    try { await api('research_journal?entry_id=eq.' + encodeURIComponent(entryId), { method: 'PATCH', body: { notes: el.value.slice(0, 4000) || null }, prefer: 'return=minimal' }); toast('Notes saved.'); }
    catch (_) { toast('Notes did not save.', true); }
  };
  M.journalDelete = async function (entryId) {
    if (!window.confirm('Delete this journal entry? This cannot be undone.')) return;
    try { await api('research_journal?entry_id=eq.' + encodeURIComponent(entryId), { method: 'DELETE', prefer: 'return=minimal' }); S.journal = (S.journal || []).filter(function (e) { return e.entry_id !== entryId; }); renderPanel(); M.paintDesk(); }
    catch (_) { toast('It was not deleted.', true); }
  };
  M.journalCsv = function () {
    var cols = ['created_at', 'game_key', 'away', 'home', 'kickoff_at', 'decision', 'market_type', 'selection', 'sportsbook', 'line', 'price_american', 'stake',
      'snap_fair_home_line', 'snap_market_home_line', 'snap_gap_pts', 'snap_win_prob_home', 'snap_reliability_score', 'snap_model_version',
      'close_home_line', 'close_total', 'close_source', 'clv_points', 'clv_price', 'beat_close', 'result', 'notes'];
    var lines = [cols.join(',')].concat((S.journal || []).map(function (e) {
      return cols.map(function (c) { var v = e[c]; v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'edgedesk-research-journal.csv'; document.body.appendChild(a); a.click(); a.remove();
  };
  function sideName(e) {
    if (e.selection === 'home') return e.home || 'Home';
    if (e.selection === 'away') return e.away || 'Away';
    return e.selection ? e.selection.charAt(0).toUpperCase() + e.selection.slice(1) : '';
  }
  function betText(e) {
    if (!e.market_type) return '';
    var t = sideName(e);
    if (e.market_type === 'spread') t += ' ' + signed(e.line);
    else if (e.market_type === 'total') t += ' ' + (num(e.line) != null ? e.line : '');
    else t += ' ML';
    if (num(e.price_american) != null) t += ' (' + (e.price_american > 0 ? '+' : '') + e.price_american + ')';
    if (e.sportsbook) t += ' · ' + e.sportsbook;
    if (num(e.stake) != null) t += ' · stake ' + e.stake;
    return t;
  }
  function journalRowHTML(e) {
    var s = { home: e.home || 'Home', away: e.away || 'Away' };
    var graded = e.close_source != null;
    var clv = num(e.clv_points) != null ? signed(e.clv_points) + ' pts' : (num(e.clv_price) != null ? signed(e.clv_price * 100) + ' pp' : null);
    return '<div class="edm-jr"><div class="edm-wr-h"><b>' + esc(s.away + ' @ ' + s.home) + '</b><span class="edm-dec ' + esc(e.decision) + '">' + esc(P.DECISION_LABEL[e.decision] || e.decision) + '</span>'
      + '<span class="edm-sub">' + esc(when(e.created_at)) + (e.after_kickoff ? ' · after kickoff' : '') + '</span></div>'
      + (e.market_type ? '<div class="edm-bet">' + esc(betText(e)) + '</div>' : '')
      + '<div class="edm-grid">'
      + '<div><i>EdgeDesk then</i>' + esc(num(e.snap_fair_home_line) != null ? P.favText(s, e.snap_fair_home_line) : '—') + '</div>'
      + '<div><i>Market then</i>' + esc(num(e.snap_market_home_line) != null ? P.favText(s, e.snap_market_home_line) : '—') + '</div>'
      + '<div><i>Gap then</i>' + (num(e.snap_gap_pts) != null ? e.snap_gap_pts.toFixed(1) + ' pts' : '—') + '</div>'
      + '<div><i>Reliability then</i>' + (num(e.snap_reliability_score) != null ? Math.round(e.snap_reliability_score) + (e.snap_reliability_grade ? ' ' + esc(String(e.snap_reliability_grade).toLowerCase()) : '') : 'n/a') + '</div>'
      + '</div>'
      + (e.decision === 'wagered' ? '<div class="edm-grade">'
        + '<div><i>Process · closing line</i>' + (graded ? (e.close_home_line != null ? 'close ' + esc(P.favText(s, e.close_home_line)) : 'close on file')
          + (clv ? ' · CLV <b class="' + (e.beat_close ? 'edm-ok' : 'edm-warn') + '">' + esc(clv) + '</b>' : '') + (e.beat_close != null ? (e.beat_close ? ' · beat the closing line' : ' · did not beat the close') : '')
          + (e.market_moved_toward_edgedesk != null ? ' · market ' + (e.market_moved_toward_edgedesk ? 'moved toward' : 'moved away from') + ' EdgeDesk' : '')
          : (e.kickoff_at && Date.parse(e.kickoff_at) > Date.now() ? 'waiting for the close' : 'close not captured yet')) + '</div>'
        + '<div><i>Result</i>' + (e.result ? esc(e.result) : 'pending') + '</div></div>' : '')
      + '<div class="edm-f"><textarea id="edmN-' + attr(e.entry_id) + '" rows="2" maxlength="4000" placeholder="Notes">' + esc(e.notes || '') + '</textarea></div>'
      + '<div class="edm-acts"><button class="edm-btn ghost sm" onclick="EDMine.journalNotes(' + js(e.entry_id) + ')">Save notes</button>'
      + '<button class="edm-btn ghost sm" onclick="EDMine.openGame(' + js(e.game_key) + ')">Research matchup</button>'
      + '<button class="edm-btn ghost sm danger" onclick="EDMine.journalDelete(' + js(e.entry_id) + ')">Delete</button></div></div>';
  }

  /* ------------------------------------------------------------ analytics */
  function tableHTML(title, rows, tip) {
    if (!rows.length) return '';
    return '<div class="edm-tbl"><div class="edm-tbl-h" title="' + attr(tip || '') + '">' + esc(title) + '</div><table><thead><tr><th></th><th>Wagers</th><th>Graded</th><th>Beat close</th><th>Avg CLV</th><th>Results W-L-P</th></tr></thead><tbody>'
      + rows.map(function (r) {
        return '<tr><td>' + esc(r.key) + '</td><td>' + r.n + '</td><td>' + r.clv_n + '</td><td>' + (r.clv_n ? pct(r.beat_close_rate) : '—') + '</td><td>'
          + (r.avg_clv_points != null ? signed(r.avg_clv_points) + ' pts' : (r.avg_clv_price_pp != null ? signed(r.avg_clv_price_pp) + ' pp' : '—')) + '</td><td>'
          + r.results.win + '-' + r.results.loss + '-' + r.results.push + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function qualityHTML() {
    var a = P.analytics(S.journal || []), pr = a.process;
    if (!a.counts.total) return '<div class="edm-empty">Your analytics start with your first logged decision.</div>';
    var ci = pr.beat_close_ci ? ' (95% interval ' + pct(pr.beat_close_ci.lo) + '–' + pct(pr.beat_close_ci.hi) + ')' : '';
    var vs = a.versus_edgedesk;
    return '<div class="edm-kpis">'
      + kpi('Tracked decisions', a.counts.total) + kpi('Wagered', a.counts.wagered) + kpi('Passed', a.counts.passed) + kpi('Leaned', a.counts.leaned)
      + kpi('Beat closing line', pr.clv_n ? pct(pr.beat_close_rate) : '—', 'Of ' + pr.clv_n + ' graded wagers' + ci)
      + kpi('Average CLV', pr.avg_clv_points != null ? signed(pr.avg_clv_points) + ' pts' : '—', 'Points between your number and the close, on your side, over ' + pr.clv_points_n + ' spread/total wagers.')
      + kpi('Avg EdgeDesk gap at entry', a.avg_gap_at_entry != null ? a.avg_gap_at_entry.toFixed(1) + ' pts' : '—', 'The model-market disagreement on screen when you logged each decision.')
      + '</div>'
      + (a.sample_note ? '<div class="edm-note">' + esc(a.sample_note) + '</div>' : '')
      + '<div class="edm-note"><b>Process and result are kept apart.</b> Beating the closing line is evidence of a good number; a single result is mostly noise. Results are counted for completeness and never turned into a money figure.</div>'
      + '<div class="edm-kpis">' + kpi('Recent 20 · beat close', a.trend.recent_n ? pct(a.trend.recent_beat_rate) : '—') + kpi('Recent 20 · avg CLV', a.trend.recent_avg_clv_points != null ? signed(a.trend.recent_avg_clv_points) + ' pts' : '—')
      + kpi('Prior 20 · avg CLV', a.trend.prior_avg_clv_points != null ? signed(a.trend.prior_avg_clv_points) + ' pts' : '—') + '</div>'
      + tableHTML('By reliability at entry', a.by_reliability, 'EdgeDesk’s reliability score for the game when you logged the wager.')
      + tableHTML('By league', a.by_league) + tableHTML('By market', a.by_market)
      + tableHTML('By week', a.weekly.map(function (w) { return Object.assign({}, w, { key: w.week }); }))
      + '<div class="edm-tbl"><div class="edm-tbl-h">You and EdgeDesk</div><div class="edm-grid">'
      + '<div><i>With EdgeDesk’s side</i>' + plural(vs.with_edgedesk.n, 'decision') + ' · beat close ' + (vs.with_edgedesk.clv_n ? pct(vs.with_edgedesk.beat_close_rate) : '—') + '</div>'
      + '<div><i>Against EdgeDesk’s side</i>' + plural(vs.against_edgedesk.n, 'decision') + ' · beat close ' + (vs.against_edgedesk.clv_n ? pct(vs.against_edgedesk.beat_close_rate) : '—') + '</div></div>'
      + (vs.against_games.length ? '<ul class="edm-ul">' + vs.against_games.map(function (g) { return '<li>' + esc(g.matchup) + ' — you took ' + esc(g.selection_team) + ', EdgeDesk’s number leaned ' + esc(g.edgedesk_team) + ' (' + esc(when(g.created_at)) + ')</li>'; }).join('') + '</ul>' : '')
      + '<div class="edm-note">EdgeDesk’s side is the side its fair line took against the market on screen when you logged the decision.</div>'
      + '</div>';
  }

  /* ------------------------------------------------------------ the panel */
  var TABS = [['watchlist', 'Watchlist'], ['alerts', 'Alerts'], ['journal', 'Journal'], ['quality', 'Decision quality']];
  M.open = async function (tab) {
    if (!signedIn()) { toast('Sign in to use your research tools.', true); return; }
    M._panelTab = tab || M._panelTab || 'watchlist';
    var host = modalHost('edmPanel');
    host.classList.add('on', 'edm-drawer');
    renderPanel();
    event('personal_panel_open', { tab: M._panelTab });
    if (M._panelTab === 'watchlist') { await M.loadWatchlist(); renderPanel(); markSeen(); }
    if ((M._panelTab === 'journal' || M._panelTab === 'quality') && !S.journal) { await M.loadJournal(); renderPanel(); }
  };
  M.tab = function (t) { M.open(t); };
  M.close = function () { M._panelTab = null; M.modalClose('edmPanel'); };
  function renderPanel() {
    var host = $('edmPanel'); if (!host || !M._panelTab) return;
    var t = M._panelTab, body;
    if (S.schema === false) body = '<div class="edm-empty">Personal research is not installed on this deployment yet (supabase/personal_research.sql).</div>';
    else if (t === 'watchlist') {
      var rows = S.watchRows;
      body = !S.watchLoaded ? '<div class="edm-empty">Loading your watchlist…</div>'
        : (rows.length ? rows.map(function (w) { return watchRowHTML(w, true); }).join('')
          : '<div class="edm-empty">Your watchlist is empty. Tap <b>Watch game</b> on the Top 5, the Football board or any game card.</div>');
    } else if (t === 'alerts') {
      body = '<div class="edm-acts"><button class="edm-btn ghost sm" onclick="EDMine.alertsReadAll()">Mark all read</button><button class="edm-btn ghost sm" onclick="EDMine.settings(\'alerts\')">Alert settings</button></div>'
        + (S.alerts.length ? S.alerts.map(alertRowHTML).join('') : '<div class="edm-empty">No research alerts. EdgeDesk alerts on research conditions — a fair line moving, a quarterback confirmed, the market converging — never on "bets".</div>');
    } else if (t === 'journal') {
      body = '<div class="edm-acts"><button class="edm-btn ghost sm" onclick="EDMine.journalCsv()">Download CSV</button></div>'
        + (!S.journal ? '<div class="edm-empty">Loading your journal…</div>' : (S.journal.length ? S.journal.map(journalRowHTML).join('')
          : '<div class="edm-empty">No decisions yet. Use <b>Log decision</b> on any game to record your read — researching, passed, leaned or wagered — with EdgeDesk’s numbers frozen as they stood.</div>'));
    } else body = !S.journal ? '<div class="edm-empty">Loading…</div>' : qualityHTML();
    host.innerHTML = '<div class="edm-modal edm-wide" role="dialog" aria-modal="true" aria-label="My research"><div class="edm-mh"><h3>My research</h3><button class="edm-x" onclick="EDMine.close()" aria-label="Close">×</button></div>'
      + '<div class="edm-seg" role="tablist">' + TABS.map(function (x) {
        return '<button role="tab" aria-selected="' + (x[0] === t) + '" class="' + (x[0] === t ? 'on' : '') + '" onclick="EDMine.tab(\'' + x[0] + '\')">' + x[1] + (x[0] === 'alerts' && S.unread ? ' (' + S.unread + ')' : '') + '</button>';
      }).join('') + '</div><div class="edm-pbody">' + body + '</div>'
      + '<div class="edm-foot">Research, not picks. Only you can read your watchlist, alerts and journal.</div></div>';
    paintStars();
  }
  function modalHost(id) {
    var h = $(id);
    if (!h) { h = document.createElement('div'); h.id = id; h.className = 'edm-ov'; h.addEventListener('click', function (e) { if (e.target === h) (id === 'edmPanel' ? M.close() : M.modalClose(id)); }); document.body.appendChild(h); }
    return h;
  }
  M.modalClose = function (id) { var h = $(id); if (h) { h.classList.remove('on', 'edm-drawer'); h.innerHTML = ''; } };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['edmJModal', 'edmHow'].forEach(function (id) { var h = $(id); if (h && h.classList.contains('on')) M.modalClose(id); });
    if (M._panelTab) M.close();
  });

  M.how = function (what) {
    var host = modalHost('edmHow'), P2 = window.EDResearchPriority;
    host.innerHTML = '<div class="edm-modal" role="dialog" aria-modal="true"><div class="edm-mh"><h3>How the Top 5 is ranked</h3><button class="edm-x" onclick="EDMine.modalClose(\'edmHow\')" aria-label="Close">×</button></div>'
      + '<p>It is a <b>research priority</b>, not a betting-edge score, and it never sorts on the raw model-market gap: the largest gaps come most often from the thinnest data.</p>'
      + '<p><b>Gates.</b> A game is listed only with a valid EdgeDesk projection and a current market quote, and never when it is marked data fault, thin data or a stale quote, or has nothing to explain.</p>'
      + '<p><b>Order.</b> ' + esc(P2 ? P2.RULE : 'the research-priority layer did not load') + '</p>'
      + '<p><b>Each league is ranked against itself.</b> An NFL gap and a college gap sit on different scales of expected error and different data.</p>'
      + '<p><b>Nothing about the model changes to fill this list.</b> The fair line, win probability and reliability are the board’s own numbers.</p></div>';
    host.classList.add('on');
  };

  /* ------------------------------------------------------------ app chrome */
  function injectChrome() {
    if ($('edmBell')) return;
    var bar = document.querySelector('.appbar-in'), av = document.querySelector('.appbar-in .edav-wrap');
    if (bar && av) {
      var acct = document.createElement('span'); acct.id = 'edmAcct'; acct.className = 'edm-acct'; acct.style.display = 'none';
      var b = document.createElement('button');
      b.id = 'edmBell'; b.className = 'edm-bell'; b.type = 'button'; b.title = 'Research alerts';
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg><span class="edm-badge" style="display:none"></span>';
      b.onclick = function () { M.open('alerts'); };
      bar.insertBefore(acct, av); bar.insertBefore(b, av);
    }
    var menu = $('avMenu');
    if (menu && !$('edmMenuItem')) {
      var it = document.createElement('button'); it.id = 'edmMenuItem'; it.textContent = 'My research';
      it.onclick = function () { menu.classList.remove('open'); M.open('watchlist'); };
      menu.insertBefore(it, menu.querySelector('button'));
    }
  }
  /* account status: a trial says how long it has left and what it becomes */
  function paintAcct() {
    var el = $('edmAcct'), s = window.SUB; if (!el) return;
    if (!s || !s.status) { el.style.display = 'none'; return; }
    var pr = window.EDPricing;
    if (s.status === 'trialing') {
      var end = Date.parse(s.current_period_end), d = isFinite(end) ? Math.max(0, Math.ceil((end - Date.now()) / 864e5)) : null;
      el.textContent = 'Trial' + (d != null ? ' · ' + d + ' day' + (d === 1 ? '' : 's') + ' left' : '');
      el.title = (pr ? pr.AFTER_TRIAL_LINE : 'After the trial, $79.99/month.') + ' Cancel anytime in Settings › Subscription.';
      el.style.display = '';
    } else el.style.display = 'none';
  }

  /* ------------------------------------------------------------ onboarding */
  /* First-run setup never opens over something the reader is doing: the
     welcome modal, the AI desk, another EdgeDesk dialog, a field they are
     typing in, or a tab they are not looking at. It waits for two quiet
     seconds in a row, and gives up for this visit after ten minutes — the
     status stays pending, so it asks again on the next one. */
  function onbBusy() {
    var wel = $('welHost'); if (wel && wel.classList.contains('on')) return true;
    var ai = $('edaiPanel'); if (ai && ai.classList.contains('open')) return true;
    if (document.querySelector('.edm-ov.on')) return true;
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    return !!document.hidden;
  }
  function maybeOnboard() {
    if (M._onbShown) return;
    if (S.prefs && S.prefs.onboarding_status && S.prefs.onboarding_status !== 'pending') return;
    var tries = 0, quiet = 0;
    (function wait() {
      if (M._onbShown || tries++ > 600) return;
      quiet = onbBusy() ? 0 : quiet + 1;
      if (quiet < 2) { setTimeout(wait, 1000); return; }
      M.onboard(1);
    })();
  }
  var ONB = { leagues: [], books: [], interests: [], alerts: null };
  M.onboard = function (step) {
    M._onbShown = true;
    if (step === 1 && S.prefs) { ONB.leagues = (S.prefs.leagues || []).slice(); ONB.books = (S.prefs.books || []).slice(); ONB.interests = (S.prefs.interests || []).slice(); }
    if (!ONB.alerts) ONB.alerts = P.alertPrefs(S.alertPrefs);
    var host = modalHost('edmOnb');
    var dots = '<div class="edm-dots">' + [1, 2, 3, 4, 5].map(function (i) { return '<i class="' + (i === step ? 'on' : (i < step ? 'done' : '')) + '"></i>'; }).join('') + '</div>';
    function chips(list, sel, group) {
      return '<div class="edm-chips">' + list.map(function (x) {
        var on = sel.indexOf(x.key) >= 0;
        return '<button type="button" class="edm-chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" onclick="EDMine.onbPick(\'' + group + '\',\'' + x.key + '\',this)">' + esc(x.label) + '</button>';
      }).join('') + '</div>';
    }
    var body;
    if (step === 1) body = '<h3>What do you research?</h3><p class="edm-sub">Your board, Top 5 and alerts start here. You can change this any time in Settings.</p>'
      + chips(P.LEAGUES.concat([{ key: 'both', label: 'Both' }]), ONB.leagues.length === P.LEAGUES.length ? ['both'].concat(ONB.leagues) : ONB.leagues, 'leagues');
    else if (step === 2) body = '<h3>Which sportsbooks do you use?</h3><p class="edm-sub">Used to fill in your research journal. EdgeDesk never places a wager anywhere.</p>' + chips(P.BOOKS, ONB.books, 'books');
    else if (step === 3) body = '<h3>What matters most to you?</h3><p class="edm-sub">Pick any. It decides what the desk shows you first.</p>' + chips(P.INTERESTS, ONB.interests, 'interests');
    else if (step === 4) {
      var a = ONB.alerts;
      body = '<h3>Research alerts <span class="edm-sub">optional</span></h3><p class="edm-sub">EdgeDesk alerts on research conditions for games you watch — never on "bets". Defaults are sensible; change them later.</p>'
        + '<div class="edm-f2">'
        + '<div class="edm-f"><label for="onbRel">Reliability reaches at least</label><input id="onbRel" type="number" min="0" max="100" step="1" value="' + a.reliability_min + '"></div>'
        + '<div class="edm-f"><label for="onbGap">Model-market gap exceeds (pts)</label><input id="onbGap" type="number" min="0.5" max="21" step="0.5" value="' + a.gap_min_pts + '"></div>'
        + '<div class="edm-f"><label for="onbFair">EdgeDesk fair line moves (pts)</label><input id="onbFair" type="number" min="0.25" max="14" step="0.25" value="' + a.fair_move_pts + '"></div>'
        + '<div class="edm-f"><label for="onbMkt">Market line moves (pts)</label><input id="onbMkt" type="number" min="0.5" max="14" step="0.5" value="' + a.market_move_pts + '"></div>'
        + '</div><div class="edm-cbs" role="group" aria-labelledby="onbCbsH"><div class="edm-cbs-h" id="onbCbsH">Also alert me when</div>'
        + '<label class="edm-cb"><input type="checkbox" id="onbQb"' + (a.on_qb_confirmed ? ' checked' : '') + '><span>A watched game’s quarterback is confirmed</span></label>'
        + '<label class="edm-cb"><input type="checkbox" id="onbInj"' + (a.on_injury_change ? ' checked' : '') + '><span>A watched game has a major availability change</span></label>'
        + '<label class="edm-cb"><input type="checkbox" id="onbScope"' + (a.scope === 'leagues' ? ' checked' : '') + '><span>Any game in my leagues becomes research-grade <small>— not only the games I watch</small></span></label>'
        + '</div>';
    } else body = '<h3>Your research desk is ready</h3><ul class="edm-ul">'
      + '<li><b>Top 5 Games to Research</b> for ' + esc((ONB.leagues.length ? ONB.leagues : ['cfb', 'nfl']).map(function (l) { return l === 'cfb' ? 'college football' : 'the NFL'; }).join(' and ')) + ' — ranked by research-worthiness, not by gap.</li>'
      + '<li><b>Watch game</b> on anything you want EdgeDesk to keep an eye on; changes land under the bell.</li>'
      + '<li><b>Log decision</b> saves your read with EdgeDesk’s numbers frozen, then grades your number against the close.</li></ul>'
      + '<p class="edm-sub">Research, not picks: EdgeDesk shows where it disagrees with the market, how reliable that is and why — the decision stays yours.</p>';
    host.innerHTML = '<div class="edm-modal" role="dialog" aria-modal="true" aria-label="Set up your research desk">' + dots + body
      + '<div class="edm-err" id="onbErr" role="alert"></div><div class="edm-acts">'
      + (step > 1 && step < 5 ? '<button class="edm-btn ghost" onclick="EDMine.onboard(' + (step - 1) + ')">Back</button>' : '')
      + (step < 5 ? '<button class="edm-btn" onclick="EDMine.onbNext(' + step + ')">Continue</button>' : '<button class="edm-btn" onclick="EDMine.onbFinish(\'completed\')">Go to my research desk</button>')
      + '<span class="edm-sp"></span><button class="edm-btn ghost" onclick="EDMine.onbFinish(\'skipped\')">Skip for now</button></div>'
      + '<div class="edm-foot">Step ' + step + ' of 5 · about a minute</div></div>';
    host.classList.add('on');
    if (step === 1) event('onboarding_start', {});
  };
  M.onbPick = function (group, key, btn) {
    var list = ONB[group];
    if (group === 'leagues' && key === 'both') { ONB.leagues = ONB.leagues.length === P.LEAGUES.length ? [] : P.LEAGUES.map(function (l) { return l.key; }); M.onboard(1); return; }
    if (group === 'interests' && key === 'all') { ONB.interests = ONB.interests.indexOf('all') >= 0 ? [] : P.INTERESTS.map(function (i) { return i.key; }); M.onboard(3); return; }
    var i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1); else list.push(key);
    if (group === 'leagues') { M.onboard(1); return; }
    btn.classList.toggle('on', i < 0); btn.setAttribute('aria-pressed', String(i < 0));
  };
  M.onbNext = function (step) {
    if (step === 4) {
      var a = ONB.alerts;
      a.reliability_min = parseFloat($('onbRel').value); a.gap_min_pts = parseFloat($('onbGap').value);
      a.fair_move_pts = parseFloat($('onbFair').value); a.market_move_pts = parseFloat($('onbMkt').value);
      a.on_qb_confirmed = $('onbQb').checked; a.on_injury_change = $('onbInj').checked; a.scope = $('onbScope').checked ? 'leagues' : 'watchlist';
      var v = P.validateAlertPrefs(a);
      if (!v.ok) { $('onbErr').textContent = v.errors.join('. ') + '.'; return; }
    }
    M.onboard(step + 1);
  };
  M.onbFinish = async function (status) {
    var row = { leagues: ONB.leagues, books: ONB.books, interests: ONB.interests, onboarding_status: status, timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { return null; } })() };
    try {
      await api('user_preferences?on_conflict=user_id', { method: 'POST', body: [row], prefer: 'return=representation,resolution=merge-duplicates' }).then(function (r) { S.prefs = r && r[0] || row; });
      if (status === 'completed' && ONB.alerts) {
        var ap = {}; Object.keys(P.ALERT_DEFAULTS).forEach(function (k) { ap[k] = ONB.alerts[k]; });
        await api('alert_preferences?on_conflict=user_id', { method: 'POST', body: [ap], prefer: 'return=representation,resolution=merge-duplicates' }).then(function (r) { S.alertPrefs = r && r[0] || ap; });
      }
    } catch (e) { var er = $('onbErr'); if (er) er.textContent = 'Your choices did not save. You can set them later in Settings.'; }
    event(status === 'completed' ? 'onboarding_complete' : 'onboarding_skip', { leagues: ONB.leagues.join(',') });
    M.modalClose('edmOnb');
    if (status === 'completed') {
      if (ONB.leagues.length) S.topLeague = ONB.leagues[0];
      try { window.researchGo('rdesk'); } catch (_) { }
      if (ONB.leagues.indexOf('cfb') >= 0) { try { window.fbWrLoadCfb(); } catch (_) { } }
      setTimeout(M.paintDesk, 300);
    }
  };

  /* ------------------------------------------------------------ settings */
  M.settings = function (id) { try { M.close(); } catch (_) { } try { window.show('settings'); window.setGo(id === 'alerts' ? 'researchalerts' : id); } catch (_) { } };
  function card(title, sub, body) { return (typeof window.setCard === 'function') ? window.setCard(title, sub, body) : '<div class="set-card"><b>' + esc(title) + '</b>' + (sub ? '<p>' + sub + '</p>' : '') + body + '</div>'; }
  function row(l, c, h) { return (typeof window.setRow === 'function') ? window.setRow(l, c, h) : '<div>' + esc(l) + ' ' + c + '</div>'; }
  function rerender() { try { if (typeof window.renderSettings === 'function') window.renderSettings(); } catch (_) { } }
  M.settingsResearch = function () {
    if (!signedIn()) return card('Research preferences', 'Sign in to set your preferences.', '');
    if (S.schema === false) return card('Research preferences', 'Not installed on this deployment yet (supabase/personal_research.sql).', '');
    if (!S.ready) { setTimeout(function () { M.boot().then(rerender); }, 0); return card('Research preferences', null, row('Loading', '<span class="set-val">…</span>')); }
    var p = S.prefs || { leagues: [], books: [], interests: [], onboarding_status: 'pending' };
    function names(list, dict) { return list.length ? list.map(function (k) { var x = dict.filter(function (d) { return d.key === k; })[0]; return x ? x.label : k; }).join(', ') : 'not set'; }
    return card('Research preferences', 'What your desk, Top 5 and alerts are built around. Stored on your account.',
      row('Leagues', '<span class="set-val">' + esc(names(p.leagues || [], P.LEAGUES)) + '</span>')
      + row('Sportsbooks', '<span class="set-val">' + esc(names(p.books || [], P.BOOKS)) + '</span>', 'Pre-fills your research journal. EdgeDesk never places wagers.')
      + row('What matters most', '<span class="set-val">' + esc(names(p.interests || [], P.INTERESTS)) + '</span>')
      + '<div class="set-act"><button class="btn sm" onclick="EDMine.onboard(1)">Edit preferences</button></div>')
      + card('Your research data', null,
        row('Watchlist', '<span class="set-val">' + Object.keys(S.watch).length + ' games</span>', 'Stored on your account; only you can read it')
        + row('Research journal', '<button class="btn ghost sm" onclick="EDMine.open(\'journal\')">Open journal</button>', 'Download it as CSV from the journal'));
  };
  M.settingsAlerts = function () {
    if (!signedIn()) return card('Research alerts', 'Sign in to set alerts.', '');
    if (S.schema === false) return card('Research alerts', 'Not installed on this deployment yet (supabase/personal_research.sql).', '');
    if (!S.ready) { setTimeout(function () { M.boot().then(rerender); }, 0); return card('Research alerts', null, row('Loading', '<span class="set-val">…</span>')); }
    var a = P.alertPrefs(S.alertPrefs);
    function tog(k) { return '<button class="set-tog' + (a[k] ? ' on' : '') + '" aria-pressed="' + !!a[k] + '" onclick="EDMine.alertSet(\'' + k + '\',' + (!a[k]) + ')"><i></i></button>'; }
    function inp(k, step) { var r = P.ALERT_RANGES[k]; return '<input class="edm-inp" type="number" min="' + r[0] + '" max="' + r[1] + '" step="' + step + '" value="' + a[k] + '" onchange="EDMine.alertSet(\'' + k + '\',parseFloat(this.value))" aria-label="' + attr(k) + '">'; }
    return card('Research alerts', 'In-app alerts on RESEARCH CONDITIONS for games you watch — never "bet" alerts. A condition that stays true alerts once; the same kind of alert for the same game waits at least ' + P.COOLDOWN_HOURS + ' hours.',
      row('Alerts', tog('enabled'), 'Turn every research alert off or on')
      + row('Scope', '<select class="edm-inp" onchange="EDMine.alertSet(\'scope\',this.value)"><option value="watchlist"' + (a.scope === 'watchlist' ? ' selected' : '') + '>My watchlist only</option><option value="leagues"' + (a.scope === 'leagues' ? ' selected' : '') + '>Watchlist + research-grade games in my leagues</option></select>', 'League-wide alerts cover only research-grade, disagreement and reliability thresholds')
      + row('Reliability reaches at least', tog('on_reliability_min') + inp('reliability_min', 1), 'College games; the NFL model publishes no reliability score')
      + row('Model-market gap exceeds (pts)', tog('on_gap_min') + inp('gap_min_pts', 0.5))
      + row('EdgeDesk fair line moves (pts)', tog('on_fair_move') + inp('fair_move_pts', 0.25))
      + row('Market line moves (pts)', tog('on_market_move') + inp('market_move_pts', 0.5))
      + row('Market crosses a key number (3, 7)', tog('on_key_number'))
      + row('Market and EdgeDesk converge (within pts)', tog('on_converge') + inp('converge_pts', 0.5))
      + row('Disagreement widens by (pts)', tog('on_diverge') + inp('diverge_pts', 0.5))
      + row('Reliability changes by (points)', tog('on_reliability_change') + inp('reliability_change_pts', 1))
      + row('A watched game becomes research-grade', tog('on_research_grade'))
      + row('Quarterback confirmed or changed', tog('on_qb_confirmed'))
      + row('Major availability change', tog('on_injury_change')))
      + card('Delivery', null, row('In the app', '<span class="set-val pos">Live</span>', 'The bell in the header; the job runs hourly')
        + row('Email', '<span class="set-val">Not connected</span>', 'Research alerts are in-app only today. Nothing is emailed.')
        + row('Push', '<span class="set-val">Not available</span>'));
  };
  M.alertSet = async function (k, v) {
    var a = P.alertPrefs(S.alertPrefs); a[k] = v;
    var chk = P.validateAlertPrefs(a);
    if (!chk.ok) { toast(chk.errors[0], true); rerender(); return; }
    var prev = S.alertPrefs; S.alertPrefs = a; rerender();
    var body = {}; Object.keys(P.ALERT_DEFAULTS).forEach(function (x) { body[x] = a[x]; });
    try { await api('alert_preferences?on_conflict=user_id', { method: 'POST', body: [body], prefer: 'return=minimal,resolution=merge-duplicates' }); }
    catch (_) { S.alertPrefs = prev; rerender(); toast('That setting did not save.', true); }
  };
  M.settingsPartner = function () {
    if (!signedIn()) return card('Partner program', 'Sign in to see your partner dashboard.', '');
    if (S.affiliate === null) {
      S.affiliate = undefined;
      rpc('affiliate_my_dashboard', {}).then(function (d) { S.affiliate = d || { ok: false }; rerender(); })
        .catch(function (e) { S.affiliate = { ok: false, reason: schemaMissing(e) ? 'not_installed' : 'unreachable' }; rerender(); });
    }
    var d = S.affiliate;
    if (!d) return card('Partner program', null, row('Loading', '<span class="set-val">…</span>'));
    if (d.ok === false) return card('Partner program', d.reason === 'not_installed' ? 'The partner program is not installed on this deployment yet (supabase/affiliates.sql).' : 'The partner dashboard could not be reached.', '');
    if (!d.account) {
      return card('Partner program', 'Creators who send readers to EdgeDesk earn ' + Math.round((d.default_commission_rate || 0) * 100) + '% of what those readers pay'
        + (d.commission_duration_months ? ' for their first ' + d.commission_duration_months + ' months' : '') + ', after a ' + d.hold_days + '-day refund window. Every click, trial and payment is tracked from Stripe’s own records; payouts are made manually.',
        d.program_open ? '<div class="edm-f"><label for="affCode">Choose your code</label><input id="affCode" class="edm-inp" maxlength="32" placeholder="COACHBIGGS"></div>'
          + '<div class="edm-f"><label for="affName">Display name</label><input id="affName" class="edm-inp" maxlength="80"></div>'
          + '<div class="set-act"><button class="btn sm" onclick="EDMine.affApply()">Apply</button></div><div class="edm-err" id="affErr"></div>'
          : '<div class="set-note">The program is by invitation. Email <a href="mailto:support@edgedesksports.com?subject=Partner%20program">support@edgedesksports.com</a> to join.</div>');
    }
    var a = d.account, st = d.stats || {}, set = d.settings || {};
    var link = 'https://edgedesksports.com/?ref=' + encodeURIComponent(a.code);
    var conv = st.clicks ? pct(st.trials / st.clicks, 1) : '—', paidConv = st.trials ? pct(st.paid_customers / st.trials, 0) : '—';
    return card('Your partner link', 'Status: ' + esc(a.status) + ' · commission ' + Math.round(a.commission_rate * 100) + '%' + (set.commission_duration_months ? ' for ' + set.commission_duration_months + ' months' : '') + ' · ' + set.hold_days + '-day hold',
      row('Code', '<span class="set-val mono">' + esc(a.code) + '</span>')
      + row('Link', '<span class="set-val mono" style="word-break:break-all">' + esc(link) + '</span> <button class="btn ghost sm" onclick="EDMine.copy(' + js(link) + ')">Copy</button>')
      + (a.stripe_promo_code ? row('Checkout code', '<span class="set-val mono">' + esc(a.stripe_promo_code) + '</span>', 'Sales made with this Stripe promotion code are credited to you too') : ''))
      + card('Results', 'Counted from recorded clicks, attributions and Stripe events. Nothing here is estimated except the pending commission, which can still be voided by a refund.',
        row('Clicks', '<span class="set-val">' + (st.clicks || 0) + '</span>', (st.clicks_30d || 0) + ' in the last 30 days; one per visitor per day')
        + row('Signups attributed', '<span class="set-val">' + (st.signups || 0) + '</span>')
        + row('Trials started', '<span class="set-val">' + (st.trials || 0) + '</span>', 'Click-to-trial conversion ' + conv)
        + row('Paying customers', '<span class="set-val">' + (st.paid_customers || 0) + '</span>', 'Trial-to-paid ' + paidConv + ' · active now ' + (st.active_paid || 0) + ' · cancelled ' + (st.canceled || 0))
        + row('Estimated (pending)', '<span class="set-val">' + P.money(st.pending_cents) + '</span>', 'Inside the refund window; ' + P.money(st.eligible_now_cents) + ' of it is past the hold')
        + row('Approved', '<span class="set-val">' + P.money(st.approved_cents) + '</span>', 'Ready for the next manual payout')
        + row('Paid', '<span class="set-val pos">' + P.money(st.paid_cents) + '</span>'));
  };
  M.affApply = async function () {
    var code = P.normCode(($('affCode') || {}).value), err = $('affErr');
    if (!code) { err.textContent = 'A code is 3-32 letters, numbers, dashes or underscores.'; return; }
    try { var r = await rpc('affiliate_apply', { p_code: code, p_display_name: ($('affName') || {}).value || null, p_payout_email: null });
      if (r && r.ok) { S.affiliate = null; rerender(); toast('Application received. An admin approves partner accounts.'); }
      else err.textContent = r && r.reason === 'code_taken' ? 'That code is taken.' : 'That did not work: ' + esc((r && r.reason) || 'unknown');
    } catch (_) { err.textContent = 'That did not work. Try again.'; }
  };
  M.copy = function (t) { try { navigator.clipboard.writeText(t).then(function () { toast('Copied.'); }); } catch (_) { toast(t); } };

  /* ------------------------------------------------------------ attribution
     The landing page captured the partner code (?ref=) in first-party
     storage. Once signed in, the account claims it — the server decides
     whether the claim is valid (first attribution wins, no self-referral, no
     claiming an existing customer). Asked once per code per device. */
  async function claimAttribution() {
    try {
      var first = JSON.parse(localStorage.getItem('edgedesk_attribution') || 'null');
      var code = P.normCode(first && first.ref);
      if (!code) { var m = document.cookie.match(/(?:^|;\s*)ed_ref=([^;]*)/); code = P.normCode(m ? decodeURIComponent(m[1]) : null); }
      if (!code || localStorage.getItem('edgedesk_aff_claimed_v1') === code) return;
      var visitor = localStorage.getItem('edgedesk_visitor');
      var r = await rpc('affiliate_claim', { p_code: code, p_visitor: P.validVisitor(visitor) ? visitor : null });
      if (r && r.reason !== 'not_signed_in') localStorage.setItem('edgedesk_aff_claimed_v1', code);
    } catch (e) { if (schemaMissing(e)) { try { localStorage.setItem('edgedesk_aff_claimed_v1', 'n/a'); } catch (_) { } } }
  }
  M.claimAttribution = claimAttribution;

  /* ------------------------------------------------------------ boot */
  function start() {
    if (!P) return;
    if (signedIn()) M.boot();
    else setTimeout(function () { if (signedIn()) M.boot(); }, 2500);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(start, 1200);
  else document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 1200); });
})();
