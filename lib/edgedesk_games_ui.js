/* ===========================================================================
   EdgeDesk GAMES UI — the Today's Games strip, the full games page and the
   matchup view. One module, two hosts:

     app.html      the subscriber terminal: the strip at the top of Research,
                   the full page at #games, research links into the shell
     /today/       the public page: the same slate, the free research, the
                   public read; no prices and no EdgeDesk numbers

   DATA, IN ORDER OF AUTHORITY
     1. today/slate.json            the slate (tools/slate/build.js), static,
                                    every visitor reads the same file
     2. public_slate_live()         the live layer (supabase/games_slate.sql):
                                    status, score and clock between builds.
                                    Laid over the slate only where it is the
                                    newer read (EDGames.overlay)
     3. opts.loadMarkets()          the host's own prices (the terminal reads
                                    slate_markets() under the reader's login)
   A failed read never blanks what is on screen: the last good data stays,
   with its age. "No games scheduled" is said only when a read succeeded and
   the day is empty; a failed read with nothing to show says it failed.

   REFRESH. The slate every 10 minutes; the live layer every 60 seconds while
   a game on the reader's day is live or starting within 45 minutes, every
   5 minutes otherwise on today, never for a day that is over; nothing while
   the tab is hidden. The day rolls over at the reader's local midnight.

   Browser only: window.EDGamesUI. Needs window.EDGames (lib/edgedesk_games.js);
   uses window.EDREADY (lib/edgedesk_readiness.js) when the page has it.
   =========================================================================== */
(function () {
  'use strict';
  var G = window.EDGames;
  if (!G) return;
  var MIN = 60000;

  var DEF = {
    slateUrl: '/today/slate.json',
    sbUrl: 'https://iattxbkbufslbauoumga.supabase.co',
    sbKey: null,
    host: 'app',
    markets: true,
    model: true,
    stripMax: 12,
    zoneKey: 'edgedesk_games_zone',
    cacheKey: 'edgedesk_slate_cache_v1'
  };
  var S = {
    opts: {}, snap: null, snapAt: 0, snapErr: null, snapFromDevice: false, snapLoading: null,
    live: null, liveAt: 0, liveErr: null, liveOff: false, liveRange: null,
    mk: null, mkAt: 0, mkErr: null, mkRange: null,
    publicRead: {}, views: [], timers: {}, today: null, zone: null, zoneSource: null
  };
  function O(k) { return S.opts[k] !== undefined ? S.opts[k] : DEF[k]; }
  function now() { return typeof S.opts.now === 'function' ? S.opts.now() : Date.now(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (_) { /* storage off */ } }
  function timeout(p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timed out')); }, ms); })]); }
  function track(name, props) { try { if (window.EDTrack && window.EDTrack.event) window.EDTrack.event(name, props || {}, { once: false }); } catch (_) { /* optional */ } }

  /* ================================================================ ZONE */
  function resolveZone() {
    var z = G.resolveZone(lsGet(O('zoneKey')));
    S.zone = z.zone; S.zoneSource = z.source;
    S.today = G.today(now(), S.zone);
    return z;
  }

  /* ================================================================ DATA */
  function fetchSnap(force) {
    if (S.snapLoading && !force) return S.snapLoading;
    var url = O('slateUrl');
    S.snapLoading = timeout(fetch(url, { cache: 'no-cache' }), 10000).then(function (r) {
      if (!r.ok) throw new Error('the slate answered ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.schema !== G.SCHEMA || !Array.isArray(j.events)) throw new Error('the slate file is not in the expected format');
      S.snap = j; S.snapAt = now(); S.snapErr = null; S.snapFromDevice = false; S.fallbackEvents = null;
      /* the last good slate is kept on this device, so a failed read later
         can still show something, labelled with its age */
      lsSet(O('cacheKey'), JSON.stringify({ saved_at: new Date(now()).toISOString(), snap: j }));
    }).catch(function (e) {
      S.snapErr = String((e && e.message) || e);
      if (!S.snap) {
        var c = null;
        try { c = JSON.parse(lsGet(O('cacheKey')) || 'null'); } catch (_) { c = null; }
        if (c && c.snap && c.snap.schema === G.SCHEMA) { S.snap = c.snap; S.snapFromDevice = c.saved_at || true; }
      }
      /* nothing saved either: the host's own fallback (the public page hands
         in the public board's games), labelled as the partial list it is */
      if (!S.snap && typeof S.opts.fallback === 'function') {
        return Promise.resolve().then(function () { return S.opts.fallback(); }).then(function (evs) {
          S.fallbackEvents = Array.isArray(evs) && evs.length ? evs : null;
        }).catch(function () { S.fallbackEvents = null; });
      }
    }).then(function () { S.snapLoading = null; notify(); });
    return S.snapLoading;
  }
  function rangeFor(date) {
    var b = G.dayBounds(date, S.zone);
    return { from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString() };
  }
  function fetchLive(date, force) {
    if (S.liveOff || !O('sbKey')) return Promise.resolve();
    var r = rangeFor(date);
    if (!force && S.liveRange === r.from && now() - S.liveAt < 20000) return Promise.resolve();
    return timeout(fetch(O('sbUrl') + '/rest/v1/rpc/public_slate_live', {
      method: 'POST',
      headers: { apikey: O('sbKey'), authorization: 'Bearer ' + O('sbKey'), 'content-type': 'application/json' },
      body: JSON.stringify({ p_from: r.from, p_to: r.to })
    }), 8000).then(function (res) {
      /* not installed yet: the slate alone is the page, and it says so */
      if (res.status === 404) { S.liveOff = true; throw new Error('the live layer is not installed'); }
      if (!res.ok) throw new Error('the live layer answered ' + res.status);
      return res.json();
    }).then(function (j) {
      if (!j || j.error || !Array.isArray(j.events)) throw new Error((j && j.error) || 'the live layer answered without events');
      S.live = j; S.liveAt = now(); S.liveErr = null; S.liveRange = r.from;
    }).catch(function (e) { S.liveErr = String((e && e.message) || e); }).then(notify);
  }
  function fetchMarkets(date, force) {
    var fn = S.opts.loadMarkets;
    if (!fn || !O('markets')) return Promise.resolve();
    var r = rangeFor(date);
    if (!force && S.mkRange === r.from && now() - S.mkAt < 9 * MIN) return Promise.resolve();
    return Promise.resolve().then(function () { return fn(r.from, r.to); }).then(function (j) {
      S.mk = j || null; S.mkAt = now(); S.mkErr = null; S.mkRange = r.from;
    }).catch(function (e) { S.mkErr = String((e && e.message) || e); }).then(notify);
  }

  /* the merged slate: snapshot, live overlay where newer, all markets */
  function merged() {
    var snap = S.snap || { events: S.fallbackEvents || [], upcoming: [], markets: {}, buckets: {} };
    var base = (snap.events || []).concat(snap.upcoming || []);
    var liveEv = [], covered = [];
    if (S.live && S.live.events) {
      var bk = snap.buckets || {};
      (S.live.covered || []).forEach(function (c) {
        var b = bk[c.feed + '|' + c.day];
        var snapT = b && b.fetched_at ? Date.parse(b.fetched_at) : 0;
        if (Date.parse(c.fetched_at) > snapT) covered.push(c);
      });
      var cov = {};
      covered.forEach(function (c) { cov[c.feed + '|' + c.day] = true; });
      liveEv = S.live.events.filter(function (e) { return cov[e.feed + '|' + e.sb_day]; });
    }
    var all = covered.length ? G.overlay(base, liveEv.map(function (e) { var x = {}; for (var k in e) if (k !== 'market') x[k] = e[k]; return x; }), covered) : G.dedupe(base);
    /* research references ride the snapshot; a live row carries its own, and
       falls back to the snapshot's for the same id */
    var rById = {};
    base.forEach(function (e) { if (e.research) rById[e.id] = e.research; });
    all.forEach(function (e) { if (!e.research && rById[e.id]) e.research = rById[e.id]; });
    var markets = {};
    function offer(id, m) {
      if (!m || !m.captured_at) return;
      var cur = markets[id];
      if (!cur || Date.parse(m.captured_at) > Date.parse(cur.captured_at)) markets[id] = m;
    }
    if (O('markets')) {
      Object.keys(snap.markets || {}).forEach(function (id) { offer(id, snap.markets[id]); });
      liveEv.forEach(function (e) { if (e.market) offer(e.id, e.market); });
      if (S.mk && S.mk.events) { var m2 = G.fromOddsApi(S.mk.events, all); Object.keys(m2).forEach(function (id) { offer(id, m2[id]); }); }
    }
    return { events: all, markets: markets };
  }

  /* what the reader is told about where the data came from */
  function freshness(sel) {
    var n = now(), out = { lines: [], alerts: [], failed: false };
    var snap = S.snap;
    if (!snap) {
      if (S.fallbackEvents) out.alerts.push({ tone: 'warn', text: 'The full slate could not be loaded (' + S.snapErr + '). Showing only the games on EdgeDesk’s public board.' });
      return out;
    }
    var gen = Date.parse(snap.generated_at);
    var sf = G.freshness(gen, n, G.CONFIG.stale_schedule_min);
    out.lines.push('Schedule updated ' + (sf.text || 'at an unknown time') + (sf.stale ? ' (stale)' : ''));
    if (S.snapFromDevice) out.alerts.push({ tone: 'warn', text: 'Showing the slate saved on this device' + (typeof S.snapFromDevice === 'string' ? ' (' + G.ageText(S.snapFromDevice, n) + ')' : '') + ': EdgeDesk could not be reached just now (' + S.snapErr + ').' });
    else if (S.snapErr) out.alerts.push({ tone: 'warn', text: 'The latest slate could not be loaded (' + S.snapErr + '); showing the one loaded ' + G.ageText(S.snapAt, n) + '.' });
    if (S.liveAt && !S.liveErr) out.lines.push('live scores checked ' + G.ageText(S.liveAt, n));
    else if (S.liveErr && !S.liveOff && sel && sel.date === S.today) out.lines.push('live scores unavailable just now');
    /* per sport, for the selected day only: a day whose read failed is never
       presented as an empty day */
    var ds = sel && sel.date ? dayStates(sel.date) : {};
    var failedNone = [], failedSome = [], carried = [], fallback = [];
    Object.keys(ds).forEach(function (k) {
      if (sel.sport && sel.sport !== 'all' && sel.sport !== k) return;
      var d = ds[k], sp = G.sport(k);
      if (!sp) return;
      if (d.failed && !d.events) failedNone.push(sp.name);
      else if (d.failed) failedSome.push(sp.name);
      else if (d.carried) carried.push(sp.name + ' (' + G.ageText(d.carried, n) + ')');
      else if (d.artifact) fallback.push(sp.name);
    });
    out.failedSports = Object.keys(ds).filter(function (k) { return ds[k].failed && !ds[k].events; });
    if (failedNone.length) out.alerts.push({ tone: 'err', text: 'Unable to load ' + failedNone.join(', ') + ' for this date: the schedule source could not be read, so no games are shown for ' + (failedNone.length > 1 ? 'them' : 'it') + '. That is not a confirmed empty slate.' });
    if (failedSome.length) out.alerts.push({ tone: 'warn', text: failedSome.join(', ') + ': part of this date could not be read; some games may be missing.' });
    if (carried.length) out.alerts.push({ tone: 'warn', text: 'The latest read failed; showing the previous read for ' + carried.join(', ') + '.' });
    if (fallback.length && S.opts.host !== 'public') out.alerts.push({ tone: 'info', text: 'From EdgeDesk’s own schedule files, without live status or scores: ' + fallback.join(', ') + '.' });
    return out;
  }
  /* every sport's read state for one local date, from the slate's buckets:
     { sport: { failed, carried (last good read time), artifact, events } } */
  function dayStates(date) {
    var out = {}, snap = S.snap;
    if (!snap || !snap.buckets) return out;
    var b = G.dayBounds(date, S.zone);
    var d0 = G.etDay(b.from), d1 = G.etDay(b.to - 1);
    Object.keys(snap.buckets).forEach(function (k) {
      var p = k.split('|'), sid = p[0].split(':')[0], day = p[1], bk = snap.buckets[k];
      if (day < d0 || day > d1 || bk.kind === 'upcoming') return;
      var o = out[sid] || (out[sid] = { failed: false, carried: null, artifact: false, events: 0 });
      if (!bk.ok) o.failed = true;
      else if (bk.carried) o.carried = bk.fetched_at;
      else if (bk.source === 'artifact') o.artifact = true;
    });
    (snap.events || []).forEach(function (e) {
      var t = G.toMs(e.start_utc);
      if (out[e.sport] && t >= b.from && t < b.to) out[e.sport].events++;
    });
    return out;
  }
  /* did the schedule for this sport and day fail to load (so an empty day is
     "unable to load", not "no games")? */
  function dayFailed(sport, date) {
    if (!S.snap || !S.snap.buckets) return true;
    var ds = dayStates(date), keys = Object.keys(ds);
    if (!keys.length) return true;
    if (sport && sport !== 'all') return !ds[sport] || (ds[sport].failed && !ds[sport].events);
    return keys.every(function (k) { return ds[k].failed && !ds[k].events; });
  }
  /* the local dates the slate fully covers */
  function coverage() {
    var w = S.snap && S.snap.window;
    if (!w) return null;
    var s = G.dayBounds(w.from_day, 'America/New_York').from, e = G.dayBounds(w.to_day, 'America/New_York').to;
    var min = G.dateKey(s, S.zone);
    if (G.dayBounds(min, S.zone).from < s) min = G.addDays(min, 1);
    var max = G.dateKey(e - 1, S.zone);
    if (G.dayBounds(max, S.zone).to > e) max = G.addDays(max, -1);
    return { min: min, max: max };
  }

  /* ============================================================ RENDERING */
  var ICON = {
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>',
    research: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7"/><circle cx="18.5" cy="6.5" r="2.5"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z"/></svg>'
  };
  function initials(name) {
    var w = String(name || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : String(w[0] || '?').slice(0, 2)).toUpperCase();
  }
  function logoHTML(t, compact) {
    /* the strip card already prints the abbreviation beside the badge, so its
       monogram is the name's initials */
    var mono = '<span class="gm-mono" aria-hidden="true">' + esc(t.abbr && !compact ? String(t.abbr).slice(0, 4) : initials(t.name)) + '</span>';
    if (!t.logo || S.opts.logos === false) return mono;
    return '<span class="gm-logo" aria-hidden="true"><img src="' + esc(t.logo) + '" alt="" width="22" height="22" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add(\'gm-nologo\');this.remove()">' + mono + '</span>';
  }
  function showScore(e) { return (e.status === 'LIVE' || e.status === 'FINAL' || e.status === 'SUSPENDED') && e.home.score != null && e.away.score != null; }
  function teamRow(e, t, which) {
    var sc = showScore(e);
    var win = e.status === 'FINAL' && sc && ((which === 'home' && e.home.score > e.away.score) || (which === 'away' && e.away.score > e.home.score));
    var label = t.short || t.name || '';
    return '<div class="gm-team' + (win ? ' win' : '') + '">' + logoHTML(t)
      + '<span class="gm-tn">' + (t.rank ? '<small class="gm-rk">' + esc(t.rank) + '</small>' : '') + '<b>' + esc(label) + '</b>'
      + (t.record ? '<small class="gm-rec">' + esc(t.record) + '</small>' : '') + '</span>'
      + (sc ? '<span class="gm-sc" aria-label="' + esc(label) + ' score ' + esc(t.score) + '">' + esc(t.score) + '</span>' : '') + '</div>';
  }
  function statusHTML(e) {
    var st = e.status, d = e.status_detail;
    if (st === 'LIVE') return '<span class="gm-st live' + (e.status_stale ? ' stale' : '') + '"><i aria-hidden="true"></i>Live' + (d && !/^in progress$/i.test(d) ? ' · ' + esc(d) : '') + '</span>';
    if (st === 'STARTED') return '<span class="gm-st started">Started · no live update</span>';
    if (st === 'FINAL') return '<span class="gm-st final">' + esc(d && /final/i.test(d) ? d : 'Final') + '</span>';
    if (st === 'POSTPONED' || st === 'CANCELED' || st === 'SUSPENDED') return '<span class="gm-st off">' + esc(G.STATUS[st].label) + '</span>';
    if (st === 'DELAYED') return '<span class="gm-st off">Delayed</span>';
    return '<span class="gm-st sched">' + (e.time_tbd ? 'Time TBD' : esc(G.timeText(G.toMs(e.start_utc), S.zone))) + '</span>';
  }
  function marketHTML(e, mk, compact) {
    if (S.opts.host === 'public' || !O('markets')) return '';
    var f = G.formatMarket(e, mk, { now: now() });
    if (!f.ok) {
      var pre = e.status === 'SCHEDULED' || e.status === 'DELAYED';
      return '<div class="gm-mk none">' + (pre ? 'Odds unavailable' : 'No pregame price on file') + '</div>';
    }
    var h = '<div class="gm-mk' + (f.stale ? ' stale' : '') + '" role="table" aria-label="' + esc('Market, ' + (f.book || 'captured price')) + '">'
      + '<div class="gm-mr gm-mh" role="row"><span role="columnheader"><span class="gm-sr">Side</span></span>' + f.cols.map(function (c) { return '<span role="columnheader">' + esc(c) + '</span>'; }).join('') + '</div>';
    f.rows.forEach(function (r) {
      h += '<div class="gm-mr" role="row"><span role="rowheader">' + esc(r.label) + '</span>' + r.cells.map(function (c) { return '<span role="cell">' + esc(c || '—') + '</span>'; }).join('') + '</div>';
    });
    h += '</div><div class="gm-src">' + esc(f.book || 'Captured price') + ' · ' + esc(G.ageText(f.captured_at, now())) + (f.stale ? ' · <b>stale</b>' : '') + '</div>';
    return h;
  }
  function readinessOf(e, mk) { return G.readiness(e, mk, now(), window.EDREADY); }
  function readyHTML(e, rd, compact) {
    if (S.opts.host === 'public') {
      var r = e.research || {};
      /* the button already names where research is; the chip only adds a fact it does not say */
      if (r.article) return '<div class="gm-rd"><span class="gm-chip ok">Free research</span></div>';
      if (!r.module) return '<div class="gm-rd"><span class="gm-chip no">Research not available yet</span></div>';
      return '';
    }
    var chips = [
      '<span class="gm-chip ' + (rd.research.ok ? 'ok' : 'no') + '">' + esc(rd.research.ok ? 'Research' : 'Research not available yet') + '</span>'
    ];
    if (!compact || rd.model.ok) chips.push('<span class="gm-chip ' + (rd.model.ok ? 'ok' : 'no') + '">' + esc(rd.model.ok ? 'Model' : 'No model') + '</span>');
    if (rd.signal.ok) chips.push('<span class="gm-chip sig" title="' + esc(rd.signal.why || '') + '">' + esc(rd.signal.text) + '</span>');
    var rr = e.research && e.research.read;
    if (!compact && rr && rr.label) chips.push('<span class="gm-chip read" title="' + esc(rr.means || '') + '">Read: ' + esc(rr.label) + '</span>');
    return '<div class="gm-rd">' + chips.join('') + '</div>';
  }
  function actionHTML(e) {
    var t = G.researchTarget(e, S.opts.host === 'public' ? 'public' : 'app');
    var lab = esc(t.label) + '<span class="gm-sr"> — ' + esc(e.away.name + (e.neutral ? ' vs ' : ' at ') + e.home.name) + '</span>';
    var more = '<button type="button" class="gm-more" data-gm-detail="' + esc(e.id) + '" aria-label="Matchup details: ' + esc(e.away.name + ' and ' + e.home.name) + '">Details</button>';
    /* the public page: the free research first, then — always last — the
       way to Full Access (the old /today/ rows' order, which the growth
       suite holds: tools/growth/public_pages.e2e.js) */
    var pub = S.opts.host === 'public';
    var cta = pub ? (t.kind === 'article' ? ' data-ed-cta="today_article"' : t.kind === 'terminal' ? ' data-ed-cta="today_terminal"' : '') : '';
    var up = pub ? '<a class="gm-upg" href="/#pricing" data-ed-cta="today_row_upgrade">EdgeDesk’s fair line and the market comparison for games it prices: Full Access →</a>' : '';
    if (t.kind === 'detail') return '<div class="gm-act"><button type="button" class="gm-go" data-gm-detail="' + esc(e.id) + '">' + lab + '</button></div>' + up;
    var ext = t.kind === 'article' && /^https?:/.test(t.href) && t.href.indexOf(location.host) < 0;
    return '<div class="gm-act"><a class="gm-go" href="' + esc(t.href) + '" data-gm-research="' + esc(e.id) + '" data-kind="' + esc(t.kind) + '"' + cta + (ext ? ' rel="noopener"' : '') + '>' + lab + '</a>' + more + '</div>' + up;
  }
  function publicReadHTML(e) {
    var r = e.research || {};
    var v = r.game_key ? S.publicRead[r.game_key] : null;
    if (!v) return '';
    return '<p class="gm-pread"><span class="gm-chip read ' + esc(v.tone || '') + '">' + esc(v.status_label || '') + '</span>' + (v.status_note ? ' ' + esc(v.status_note) : '') + '</p>';
  }
  /* ======================================================= THE STRIP CARD
     The strip's card is a scoreboard tile: two teams with one number each,
     the start and the total underneath, then one pill to the research. A
     spread sport prints the favourite's spread and the underdog's moneyline;
     a puck-line, run-line or 1X2 sport prints both moneylines. The book,
     the capture time and a soccer draw are in the card's own words for a
     screen reader and on the numbers' tooltip; a price past the limit is
     dimmed and marked "past". Live and final games trade the numbers for the
     score. The pill's second line is EdgeDesk's read on the game when the
     board has one. The full card, with every market, is the games page's
     and the matchup view's. */
  function compactOdds(e, mk) {
    if (S.opts.host === 'public' || !O('markets')) return null;
    if (e.status !== 'SCHEDULED' && e.status !== 'DELAYED') return null;
    var f = G.formatMarket(e, mk, { now: now() });
    if (!f.ok) return { ok: false };
    var sp = G.sport(e.sport) || {};
    var hasMl = f.cols.indexOf(sp.draw ? '1X2' : 'Moneyline') >= 0;
    var hasSp = !!sp.spread && f.cols.indexOf(sp.spread) >= 0;
    var hasTot = !!sp.total && f.cols.indexOf(sp.total) >= 0;
    var ml = mk.moneyline || {}, spd = mk.spread || {}, tot = mk.total || {};
    var out = { ok: true, stale: f.stale, say: [] };
    ['away', 'home'].forEach(function (k) {
      var t = e[k] || {}, s = spd[k] || {}, nm = t.abbr || t.short || t.name || k;
      if (hasSp && (!hasMl || (sp.spread === 'Spread' && Number(s.point) < 0))) {
        out[k] = G.point(s.point);
        out.say.push(nm + ' ' + String(sp.spread).toLowerCase() + ' ' + G.point(s.point) + ' (' + G.american(s.price) + ')');
      } else if (hasMl) {
        out[k] = G.american(ml[k]);
        out.say.push(nm + ' ' + (sp.draw ? 'to win' : 'moneyline') + ' ' + out[k]);
      }
    });
    if (sp.draw && hasMl) out.say.push('draw ' + G.american(ml.draw));
    if (hasTot) { out.total = 'o' + Number(tot.point); out.say.push('total ' + Number(tot.point) + ' (over ' + G.american(tot.over) + ', under ' + G.american(tot.under) + ')'); }
    out.src = (f.book || 'Captured price') + ' · ' + G.ageText(f.captured_at, now()) + (f.stale ? ' · a past price' : '');
    if (sp.draw && hasMl) out.src = 'Draw ' + G.american(ml.draw) + ' · ' + out.src;
    return out;
  }
  function ccTeam(e, t, which, od) {
    var sc = showScore(e);
    var win = e.status === 'FINAL' && sc && ((which === 'home' && e.home.score > e.away.score) || (which === 'away' && e.away.score > e.home.score));
    var label = t.abbr || t.short || t.name || '';
    var v = sc ? '<span class="gm-sc" aria-label="' + esc(label) + ' score ' + esc(t.score) + '">' + esc(t.score) + '</span>'
      : od && od.ok && od[which] ? '<span class="gm-cv" aria-hidden="true" title="' + esc(od.src) + '">' + esc(od[which]) + '</span>' : '';
    return '<div class="gm-team' + (win ? ' win' : '') + '">' + logoHTML(t, true)
      + '<span class="gm-tn">' + (t.rank ? '<small class="gm-rk">' + esc(t.rank) + '</small>' : '') + '<b title="' + esc(t.name || label) + '">' + esc(label) + '</b></span>' + v + '</div>';
  }
  function ccStatusHTML(e, o) {
    var st = e.status, ms = G.toMs(e.start_utc);
    var dh = e.doubleheader ? '<span class="gm-ctag" aria-hidden="true">G' + esc(e.doubleheader.game) + '</span>' : '';
    if (o.upcoming) return '<span class="gm-st sched">' + esc(G.dateText(G.dateKey(ms, S.zone))) + (e.time_tbd ? '' : ' · ' + esc(G.clock(ms, S.zone))) + '</span>' + dh;
    if (st === 'SCHEDULED') return '<span class="gm-st sched">' + (e.time_tbd ? 'Time TBD' : esc(G.clock(ms, S.zone))) + '</span>' + dh;
    if (st === 'STARTED') return '<span class="gm-st started" title="Started · no live update">Started</span>' + dh;
    return statusHTML(e) + dh;
  }
  function ccSub(e, rd, t) {
    var r = e.research || {};
    if (S.opts.host === 'public') return { text: r.article ? 'Free research' : t.kind === 'terminal' ? 'In the terminal' : 'No research yet' };
    if (rd.signal.ok) return { text: rd.signal.text, cls: 'sig' };
    /* EdgeDesk's read on the game, as the tag the board prints, else what
       the game has */
    if (r.read && r.read.label) {
      var rl = String(r.read.label).toLowerCase();
      return { read: rl.charAt(0).toUpperCase() + rl.slice(1), cls: 'rd', title: 'EdgeDesk read: ' + r.read.label + (r.read.means ? ' — ' + r.read.means : '') };
    }
    return { text: rd.model.ok ? 'Model ready' : rd.research.ok ? 'Research available' : 'No research yet' };
  }
  function ccActionHTML(e, rd) {
    var pub = S.opts.host === 'public';
    var t = G.researchTarget(e, pub ? 'public' : 'app');
    var sub = ccSub(e, rd, t);
    /* the pill's words are short: two cards and a bit share a phone's width */
    var label = t.kind === 'detail' ? 'Matchup' : t.label === 'Read the postgame' ? 'Postgame' : 'Research';
    var who = esc(e.away.name + (e.neutral ? ' vs ' : ' at ') + e.home.name);
    var inner = '<span class="gm-cta-ic" aria-hidden="true">' + (sub.cls === 'sig' ? ICON.star : ICON.research) + '</span>'
      + '<span class="gm-cta-tx"><b>' + esc(label) + '<span class="gm-sr"> — ' + who + '</span></b><small' + (sub.cls ? ' class="' + sub.cls + '"' : '') + (sub.title ? ' title="' + esc(sub.title) + '"' : '') + '>'
      + (sub.read ? 'Read: <em>' + esc(sub.read) + '</em>' : esc(sub.text)) + '</small></span>';
    if (t.kind === 'detail') return '<div class="gm-cta"><button type="button" class="gm-go" data-gm-detail="' + esc(e.id) + '">' + inner + '<span class="gm-cta-end" aria-hidden="true">' + ICON.right + '</span></button></div>';
    var cta = pub ? (t.kind === 'article' ? ' data-ed-cta="today_article"' : t.kind === 'terminal' ? ' data-ed-cta="today_terminal"' : '') : '';
    var ext = t.kind === 'article' && /^https?:/.test(t.href) && t.href.indexOf(location.host) < 0;
    return '<div class="gm-cta"><a class="gm-go" href="' + esc(t.href) + '" data-gm-research="' + esc(e.id) + '" data-kind="' + esc(t.kind) + '"' + cta + (ext ? ' rel="noopener"' : '') + '>' + inner + '</a>'
      + '<button type="button" class="gm-more" data-gm-detail="' + esc(e.id) + '" aria-label="Matchup details: ' + esc(e.away.name + ' and ' + e.home.name) + '" title="Matchup details">' + ICON.info + '</button></div>';
  }
  function compactCardHTML(e, mk, o) {
    var sp = G.sport(e.sport) || { label: e.sport };
    var rd = readinessOf(e, mk);
    var od = compactOdds(e, mk);
    var hid = 'gm-h-' + o.scope + '-' + e.id.replace(/[^A-Za-z0-9]/g, '-');
    var lg = e.sport === 'soccer' || e.sport === 'mma' ? e.league || sp.label : sp.label;
    var title = e.title ? e.title : (e.away.name + (e.neutral ? ' vs ' : ' at ') + e.home.name);
    var tags = [];
    if (e.doubleheader) tags.push('Game ' + e.doubleheader.game + ' of ' + e.doubleheader.of);
    if (e.neutral) tags.push('Neutral site');
    if (e.bouts) tags.push(e.bouts + ' bouts');
    var right = '';
    if (od && od.ok && od.total) right = '<span class="gm-cv' + (od.stale ? ' past' : '') + '" aria-hidden="true" title="' + esc(od.src) + '">' + (od.stale ? '<small class="gm-past">past</small>' : '') + esc(od.total) + '</span>';
    else if (od && od.ok && od.stale) right = '<span class="gm-cv past" aria-hidden="true" title="' + esc(od.src) + '"><small class="gm-past">past price</small></span>';
    else if (od && !od.ok) right = '<span class="gm-cnone" title="Odds unavailable: no current captured price for this game">No odds<span class="gm-sr"> (odds unavailable)</span></span>';
    var gk = e.research && e.research.game_key;
    return '<article class="gm-card gm-cc' + (od && od.stale ? ' gm-past-mk' : '') + '" data-status="' + esc(e.status) + '" data-id="' + esc(e.id) + '"' + (gk ? ' data-key="' + esc(gk) + '"' : '') + ' aria-labelledby="' + hid + '">'
      + '<h3 class="gm-sr" id="' + hid + '">' + esc(lg + ': ' + title + ', ' + (G.STATUS[e.status] ? G.STATUS[e.status].label : e.status) + (tags.length ? ', ' + tags.join(', ') : '')) + '</h3>'
      + (o.league ? '<div class="gm-clg" aria-hidden="true">' + esc(lg) + '</div>' : '')
      + (e.title ? '<div class="gm-title">' + esc(e.title) + '</div>' : '')
      + ccTeam(e, e.away, 'away', od) + ccTeam(e, e.home, 'home', od)
      + '<div class="gm-cfoot">' + ccStatusHTML(e, o) + right + '</div>'
      + (e.status === 'LIVE' && e.status_stale ? '<div class="gm-when gm-stale">Last live update ' + esc(G.ageText(e.updated_at, now())) + '</div>' : '')
      + (od && od.ok ? '<p class="gm-sr">Odds: ' + esc(od.say.join(', ')) + '. ' + esc(od.src) + '.</p>' : '')
      + ccActionHTML(e, rd)
      + '</article>';
  }
  function cardHTML(e, mk, o) {
    o = o || {};
    if (o.compact) return compactCardHTML(e, mk, o);
    var sp = G.sport(e.sport) || { label: e.sport };
    var rd = readinessOf(e, mk);
    var hid = 'gm-h-' + o.scope + '-' + e.id.replace(/[^A-Za-z0-9]/g, '-');
    var sep = e.neutral ? 'vs' : 'at';
    var title = e.title ? e.title : (e.away.name + ' ' + sep + ' ' + e.home.name);
    var tags = [];
    if (e.doubleheader) tags.push('Game ' + e.doubleheader.game + ' of ' + e.doubleheader.of);
    if (e.neutral) tags.push('Neutral site');
    if (e.bouts) tags.push(e.bouts + ' bouts');
    var gk = e.research && e.research.game_key;
    return '<article class="gm-card" data-status="' + esc(e.status) + '" data-id="' + esc(e.id) + '"' + (gk ? ' data-key="' + esc(gk) + '"' : '') + ' aria-labelledby="' + hid + '">'
      + '<div class="gm-ctop"><span class="gm-lg">' + esc(e.sport === 'soccer' || e.sport === 'mma' ? e.league || sp.label : sp.label) + '</span>' + statusHTML(e) + '</div>'
      + '<h3 class="gm-sr" id="' + hid + '">' + esc(title) + ', ' + esc(G.STATUS[e.status] ? G.STATUS[e.status].label : e.status) + '</h3>'
      + (e.title ? '<div class="gm-title">' + esc(e.title) + '</div>' : '')
      + teamRow(e, e.away, 'away') + teamRow(e, e.home, 'home')
      /* a live read that has gone quiet says how long ago it last spoke */
      + (e.status === 'LIVE' && e.status_stale ? '<div class="gm-when gm-stale">Last live update ' + esc(G.ageText(e.updated_at, now())) + '</div>' : '')
      + (tags.length ? '<div class="gm-tags">' + tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>' : '')
      + (e.status !== 'SCHEDULED' && e.status !== 'DELAYED' && !o.compact ? '<div class="gm-when">' + esc(G.dateText(G.dateKey(G.toMs(e.start_utc), S.zone))) + ' · ' + esc(G.timeText(G.toMs(e.start_utc), S.zone)) + '</div>' : '')
      + (o.upcoming ? '<div class="gm-when">' + esc(G.dateText(G.dateKey(G.toMs(e.start_utc), S.zone))) + (e.time_tbd ? ' · time TBD' : '') + '</div>' : '')
      + marketHTML(e, mk, o.compact)
      + (S.opts.host === 'public' ? publicReadHTML(e) : '')
      + readyHTML(e, rd, o.compact)
      + actionHTML(e)
      + '</article>';
  }
  function pillsHTML(counts, sel, scope, failed) {
    failed = failed || [];
    var h = '<div class="gm-pills" role="group" aria-label="Sport" data-gm-pills="' + scope + '">';
    h += '<button type="button" class="gm-pill" data-gm-sport="all" aria-pressed="' + (sel === 'all') + '">All sports <span class="n">' + (counts.all || 0) + '</span></button>';
    G.SPORTS.forEach(function (s) {
      var n = counts[s.id] || 0, f = failed.indexOf(s.id) >= 0;
      h += '<button type="button" class="gm-pill' + (n ? '' : ' zero') + '" data-gm-sport="' + s.id + '" aria-pressed="' + (sel === s.id) + '"'
        + ' aria-label="' + esc(s.name + ', ' + (f ? 'games could not be loaded' : n + ' game' + (n === 1 ? '' : 's'))) + '">' + esc(s.label) + ' <span class="n" aria-hidden="true">' + (f ? '–' : n) + '</span></button>';
    });
    return h + '</div>';
  }
  function emptyHTML(sel, view, scope) {
    var sp = sel.sport !== 'all' ? G.sport(sel.sport) : null;
    var dayText = sel.date === S.today ? 'today' : 'on ' + G.dateText(sel.date);
    var failed = dayFailed(sel.sport, sel.date);
    var h = '';
    if (!S.snap && S.snapErr) {
      return '<div class="gm-empty err" role="alert"><b>Unable to load games' + (S.fallbackEvents ? ' for this date' : '') + '.</b> ' + esc(S.snapErr) + '. <button type="button" class="gm-btn" data-gm-retry>Try again</button></div>';
    }
    if (failed) h += '<div class="gm-empty err" role="status"><b>Unable to load ' + esc(sp ? sp.name + ' ' : '') + 'games ' + esc(dayText) + '.</b> The schedule source could not be read, so this is not a confirmed empty slate. <button type="button" class="gm-btn" data-gm-retry>Try again</button></div>';
    else if (sel.q) h += '<div class="gm-empty" role="status">No game ' + esc(dayText) + ' matches “' + esc(sel.q) + '”.</div>';
    else if (sel.status !== 'all') h += '<div class="gm-empty" role="status">No ' + esc((G.STATUS_FILTERS.filter(function (f) { return f.id === sel.status; })[0] || {}).label || '').toLowerCase() + ' games ' + esc(dayText) + '.</div>';
    else h += '<div class="gm-empty" role="status"><b>No ' + esc(sp ? sp.name + ' ' : '') + 'games scheduled ' + esc(dayText) + '.</b></div>';
    return h;
  }
  function upcomingHTML(view, sel, scope, compact) {
    if (!view.upcoming.length) {
      if (sel.sport !== 'all' && !view.games.length && !dayFailed(sel.sport, sel.date) && sel.date >= S.today && !sel.q) {
        var sp = G.sport(sel.sport);
        return '<p class="gm-note">No ' + esc(sp ? sp.name : '') + ' games are on EdgeDesk’s slate in the next ' + G.CONFIG.upcoming_days + ' days.</p>';
      }
      return '';
    }
    var h = '<section class="gm-up" aria-labelledby="gm-up-' + scope + '"><h3 id="gm-up-' + scope + '" class="gm-sech">Upcoming <small>next scheduled · not ' + esc(sel.date === S.today ? 'today' : 'on ' + G.dateText(sel.date)) + '</small></h3>';
    view.upcoming.forEach(function (u) {
      var sp = G.sport(u.sport);
      if (sel.sport === 'all' && compact) return;
      h += '<p class="gm-note">' + esc(sp.name) + ': next scheduled ' + esc(G.relDay(G.dateKey(G.toMs(u.games[0].start_utc), S.zone), S.today).toLowerCase() === 'tomorrow' ? 'tomorrow' : 'on ' + G.dateText(G.dateKey(G.toMs(u.games[0].start_utc), S.zone))) + '.</p>';
      h += '<div class="gm-grid">' + u.games.slice(0, compact ? 3 : 6).map(function (e) { return cardHTML(e, null, { scope: scope + '-up', upcoming: true, compact: compact }); }).join('') + '</div>';
    });
    return h + '</section>';
  }

  /* ============================================================== THE STRIP */
  function Strip(el) { this.el = el; this.sport = lsGet('edgedesk_games_strip_sport') || 'all'; if (this.sport !== 'all' && !G.sport(this.sport)) this.sport = 'all'; }
  Strip.prototype.render = function () {
    var el = this.el, n = now();
    var sel = { date: S.today, sport: this.sport, status: 'all', q: '' };
    var m = merged();
    var view = G.select(m.events, { date: S.today, zone: S.zone, now: n, sport: this.sport });
    var fr = freshness(sel);
    var allHref = typeof S.opts.allHref === 'function' ? S.opts.allHref({ sport: this.sport, date: S.today }) : G.stateHash({ sport: this.sport, date: S.today });
    var h = '<div class="gm-hd">' + ICON.cal + '<h2 id="gmStripH">Today’s Games</h2>'
      + '<span class="gm-date">' + esc(G.dateText(S.today)) + '</span>'
      + '<a class="gm-all" href="' + esc(allHref) + '" data-gm-all>View all games' + ICON.arrow + '</a></div>';
    if (!S.snap && !S.snapErr) { swap(el, this, h + '<div class="gm-skel" aria-hidden="true"><i></i><i></i><i></i></div><p class="gm-sr" role="status">Loading today’s games…</p>'); return; }
    h += pillsHTML(view.counts, this.sport, 'strip', fr.failedSports);
    var max = O('stripMax');
    if (view.games.length) {
      var all = this.sport === 'all', cut = view.games.length > 8;
      h += '<div class="gm-row' + (cut ? ' gm-cut' : '') + '" role="list" aria-label="Games today">' + view.games.slice(0, max).map(function (e) { return '<div role="listitem" class="gm-li">' + cardHTML(e, m.markets[e.id], { scope: 'strip', compact: true, league: all }) + '</div>'; }).join('')
        /* the desktop grid shows two rows of four (lib/edgedesk_games.css):
           eight games fill it, and past eight it is seven cards and a last
           tile that is always the way to the rest */
        + (cut ? '<div role="listitem" class="gm-li"><a class="gm-card gm-more-tile" href="' + esc(allHref) + '" data-gm-all>All ' + view.games.length + ' games' + ICON.arrow + '</a></div>' : '') + '</div>';
    } else {
      h += emptyHTML(sel, view, 'strip') + upcomingHTML(view, sel, 'strip', true);
    }
    /* the strip stays short (it sits above Ask EdgeDesk AI on a phone): a
       sport whose source failed shows "–" on its pill and says "Unable to
       load" when chosen; the full page carries every alert in words */
    var failedN = (fr.failedSports || []).length;
    /* the data's own state is never dropped: a slate from this device, or a
       newer slate that failed to load, says so first */
    if (S.snapFromDevice) h += '<p class="gm-alert warn">Showing the slate saved on this device' + (typeof S.snapFromDevice === 'string' ? ' ' + esc(G.ageText(S.snapFromDevice, n)) : '') + ': EdgeDesk could not be reached just now.</p>';
    else if (S.snapErr) h += '<p class="gm-alert warn">The latest slate could not be loaded; showing the one loaded ' + esc(G.ageText(S.snapAt, n)) + '.</p>';
    h += '<p class="gm-foot"><span class="gm-fdate">' + esc(G.dateText(S.today)) + ' · </span>' + esc(fr.lines.join(' · ')) + (fr.lines.length ? ' · ' : '') + 'Times in ' + esc(G.zoneText(S.zone, n)) + (S.zoneSource === 'fallback' ? ' (your time zone could not be read)' : '') + '.'
      + (failedN ? ' <a class="gm-warnlink" href="' + esc(allHref) + '" data-gm-all>' + failedN + ' sport' + (failedN === 1 ? '' : 's') + ' could not be loaded</a>' : '') + '</p>';
    swap(el, this, h);
  };
  Strip.prototype.bind = function () {
    var self = this;
    this.el.addEventListener('click', function (ev) {
      var p = ev.target.closest('[data-gm-sport]');
      if (p) { self.sport = p.getAttribute('data-gm-sport'); lsSet('edgedesk_games_strip_sport', self.sport); self.render(); focusPill(self.el, self.sport); track('games_strip_sport', { entity: self.sport }); return; }
      if (ev.target.closest('[data-gm-retry]')) { refreshAll(true); return; }
      handleCommon(ev, 'strip');
    });
    this.el.addEventListener('keydown', pillKeys);
  };

  /* ============================================================= THE PAGE */
  function Page(el) { this.el = el; this.st = { sport: 'all', date: null, status: 'all', q: '' }; this.follow = true; }
  Page.prototype.setState = function (st, push) {
    var prevDate = this.st.date;
    this.st = { sport: st.sport || 'all', date: st.date || S.today, status: st.status || 'all', q: st.q || '' };
    this.follow = this.st.date === S.today;
    if (S.opts.hashMode !== false) {
      var h = G.stateHash(this.st);
      if (location.hash !== h) { try { if (push) location.hash = h; else history.replaceState(null, '', location.pathname + location.search + h); } catch (_) { /* sandboxed */ } }
    }
    if (prevDate !== this.st.date) { fetchLive(this.st.date, true); fetchMarkets(this.st.date, true); schedule(); }
    this.render();
  };
  Page.prototype.render = function () {
    var el = this.el, n = now(), st = this.st;
    if (!st.date) st.date = S.today;
    var m = merged();
    var view = G.select(m.events, { date: st.date, zone: S.zone, now: n, sport: st.sport, status: st.status, q: st.q });
    var all = G.select(m.events, { date: st.date, zone: S.zone, now: n, sport: st.sport });
    var fr = freshness(st);
    var cov = coverage();
    var h = '<div class="gm-phd"><h2 id="gmPageH">Games</h2><p class="gm-sub">Every game on EdgeDesk’s slate, with the research each one has. ' + (S.opts.host === 'public' ? '' : 'An available game is not a recommendation. ') + 'Research, not picks.</p></div>';
    /* date bar */
    var y = G.addDays(S.today, -1), t1 = G.addDays(S.today, 1);
    function dbtn(d, label) { return '<button type="button" class="gm-db" data-gm-date="' + d + '" aria-pressed="' + (st.date === d) + '"' + (cov && (d < cov.min || d > cov.max) ? ' disabled' : '') + '>' + label + '<small>' + esc(G.dateText(d)) + '</small></button>'; }
    h += '<div class="gm-dates" role="group" aria-label="Date">'
      + '<button type="button" class="gm-db gm-step" data-gm-step="-1" aria-label="Previous day"' + (cov && st.date <= cov.min ? ' disabled' : '') + '>' + ICON.left + '</button>'
      + dbtn(y, 'Yesterday') + dbtn(S.today, 'Today') + dbtn(t1, 'Tomorrow')
      + '<label class="gm-pick"><span class="gm-sr">Pick a date</span><input type="date" id="gmDateInput" value="' + esc(st.date) + '"' + (cov ? ' min="' + cov.min + '" max="' + cov.max + '"' : '') + '></label>'
      + '<button type="button" class="gm-db gm-step" data-gm-step="1" aria-label="Next day"' + (cov && st.date >= cov.max ? ' disabled' : '') + '>' + ICON.right + '</button></div>';
    h += pillsHTML(all.counts, st.sport, 'page', fr.failedSports);
    /* status filter + search */
    h += '<div class="gm-tools"><div class="gm-seg" role="group" aria-label="Status">' + G.STATUS_FILTERS.map(function (f) {
      var c = f.id === 'all' ? all.total_day : all.by_status[f.id] || 0;
      return '<button type="button" data-gm-status="' + f.id + '" aria-pressed="' + (st.status === f.id) + '">' + esc(f.id === 'off' ? 'Postponed' : f.id === 'upcoming' ? 'Scheduled' : f.label) + ' <span class="n">' + c + '</span></button>';
    }).join('') + '</div>'
      + '<label class="gm-search"><span class="gm-sr">Search teams or competitors</span><input type="search" id="gmSearch" placeholder="Search teams or competitors" value="' + esc(st.q) + '" autocomplete="off" maxlength="60"></label></div>';
    var dayLabel = G.relDay(st.date, S.today);
    h += '<p class="gm-fresh" role="status" aria-live="polite"><b>' + esc(dayLabel === G.dateText(st.date) ? dayLabel : dayLabel + ', ' + G.dateText(st.date)) + '</b> · '
      + view.games.length + (view.games.length === all.total_day ? '' : ' of ' + all.total_day) + ' game' + (all.total_day === 1 ? '' : 's') + ' · '
      + esc(fr.lines.join(' · ')) + ' · times in ' + esc(G.zoneText(S.zone, n)) + ' <button type="button" class="gm-link" data-gm-zone aria-expanded="false">Change</button></p>'
      + '<div class="gm-zonebox" hidden></div>';
    fr.alerts.forEach(function (a) { h += '<p class="gm-alert ' + a.tone + '">' + esc(a.text) + '</p>'; });
    if (cov && (st.date < cov.min || st.date > cov.max)) {
      h += '<div class="gm-empty" role="status"><b>' + esc(G.dateText(st.date)) + ' is outside EdgeDesk’s slate.</b> The slate holds ' + esc(G.dateText(cov.min)) + ' through ' + esc(G.dateText(cov.max)) + '. <button type="button" class="gm-btn" data-gm-date="' + S.today + '">Back to today</button></div>';
      swap(el, this, h); return;
    }
    if (!S.snap && !S.snapErr) { swap(el, this, h + '<div class="gm-skel" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'); return; }
    if (!view.games.length) h += emptyHTML(st, view, 'page');
    /* "Scheduled" for the day's games not yet started; "Upcoming" is kept for
       the next games of a sport with none on the day, a separate list */
    var groups = [['live', 'Live'], ['upcoming', 'Scheduled'], ['final', 'Final'], ['off', 'Postponed and canceled']];
    groups.forEach(function (g) {
      var list = view.games.filter(function (e) { return G.statusGroup(e.status) === g[0]; });
      if (!list.length) return;
      h += '<section class="gm-sec" aria-labelledby="gm-sec-' + g[0] + '"><h3 class="gm-sech" id="gm-sec-' + g[0] + '">' + esc(g[1]) + ' <small>' + list.length + '</small></h3><div class="gm-grid">'
        + list.map(function (e) { return cardHTML(e, m.markets[e.id], { scope: 'page' }); }).join('') + '</div></section>';
    });
    h += upcomingHTML(view, st, 'page', false);
    h += '<p class="gm-foot">' + (S.opts.host === 'public'
      ? 'Free research where EdgeDesk has published some; EdgeDesk’s numbers, prices and the full research are in the Research Terminal.'
      : 'Prices are shown only as captured: a named book, both sides and the capture time. A game with no current capture says “Odds unavailable”. A signal appears only when EdgeDesk’s existing validation certified it.') + '</p>';
    swap(el, this, h);
  };
  Page.prototype.bind = function () {
    var self = this;
    this.el.addEventListener('click', function (ev) {
      var t;
      if ((t = ev.target.closest('[data-gm-sport]'))) { var sp = t.getAttribute('data-gm-sport'); self.setState(Object.assign({}, self.st, { sport: sp })); focusPill(self.el, sp); track('games_page_sport', { entity: sp }); return; }
      if ((t = ev.target.closest('[data-gm-date]'))) { self.setState(Object.assign({}, self.st, { date: t.getAttribute('data-gm-date') }), true); focusSel(self.el, '[data-gm-date="' + self.st.date + '"]'); return; }
      if ((t = ev.target.closest('[data-gm-step]'))) { var d = G.addDays(self.st.date, Number(t.getAttribute('data-gm-step'))); self.setState(Object.assign({}, self.st, { date: d }), true); focusSel(self.el, '[data-gm-step="' + t.getAttribute('data-gm-step') + '"]'); return; }
      if ((t = ev.target.closest('[data-gm-status]'))) { self.setState(Object.assign({}, self.st, { status: t.getAttribute('data-gm-status') })); focusSel(self.el, '[data-gm-status="' + self.st.status + '"]'); return; }
      if (ev.target.closest('[data-gm-retry]')) { refreshAll(true); return; }
      if ((t = ev.target.closest('[data-gm-zone]'))) { zonePicker(self, t); return; }
      handleCommon(ev, 'page');
    });
    this.el.addEventListener('change', function (ev) {
      if (ev.target.id === 'gmDateInput' && G.isDateKey(ev.target.value)) { self.setState(Object.assign({}, self.st, { date: ev.target.value }), true); focusSel(self.el, '#gmDateInput'); }
      if (ev.target.id === 'gmZone') { lsSet(O('zoneKey'), ev.target.value || null); resolveZone(); self.setState(Object.assign({}, self.st, { date: self.follow ? S.today : self.st.date })); renderAll(); }
    });
    var qt = null;
    this.el.addEventListener('input', function (ev) {
      if (ev.target.id !== 'gmSearch') return;
      var v = ev.target.value;
      clearTimeout(qt);
      qt = setTimeout(function () { self.setState(Object.assign({}, self.st, { q: v.slice(0, 60) })); var i = self.el.querySelector('#gmSearch'); if (i) { i.focus(); try { i.setSelectionRange(v.length, v.length); } catch (_) { /* type=search */ } } }, 250);
    });
    this.el.addEventListener('keydown', pillKeys);
  };
  function zonePicker(page, btn) {
    var box = page.el.querySelector('.gm-zonebox');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
    var zones = [['', 'Use this device’s time zone']].concat([
      ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'],
      ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['Europe/London', 'UK'], ['UTC', 'UTC']]);
    var cur = lsGet(O('zoneKey')) || '';
    box.innerHTML = '<label class="fl" for="gmZone">Show times in</label> <select id="gmZone">' + zones.map(function (z) { return '<option value="' + z[0] + '"' + (z[0] === cur ? ' selected' : '') + '>' + esc(z[1]) + (z[0] ? ' (' + esc(z[0]) + ')' : '') + '</option>'; }).join('') + '</select>';
    box.hidden = false; btn.setAttribute('aria-expanded', 'true');
    var s = box.querySelector('select'); if (s) s.focus();
  }

  /* ========================================================= SHARED BITS */
  function handleCommon(ev, scope) {
    var t = ev.target.closest('[data-gm-detail]');
    if (t) { ev.preventDefault(); openDetail(t.getAttribute('data-gm-detail'), t); return; }
    t = ev.target.closest('[data-gm-research]');
    if (t) track('games_research_open', { entity: (t.getAttribute('data-kind') || '') + ':' + String(t.getAttribute('data-gm-research')).split(':')[0], from: scope });
    t = ev.target.closest('[data-gm-all]');
    if (t) { track('games_view_all', { from: scope }); if (typeof S.opts.onViewAll === 'function') { var r = S.opts.onViewAll(ev, t); if (r === false) ev.preventDefault(); } }
  }
  function pillKeys(ev) {
    var grp = ev.target.closest('[role="group"]');
    if (!grp || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End')) return;
    var btns = Array.prototype.slice.call(grp.querySelectorAll('button:not([disabled])'));
    var i = btns.indexOf(ev.target);
    if (i < 0) return;
    ev.preventDefault();
    var j = ev.key === 'Home' ? 0 : ev.key === 'End' ? btns.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    btns[j].focus();
  }
  /* A background refresh (the live layer, a new slate) re-renders the view.
     It must not move the reader: the focused control keeps focus, the rails
     keep their scroll, and an unchanged view is not touched at all. */
  var KEY_ATTRS = ['data-gm-sport', 'data-gm-date', 'data-gm-step', 'data-gm-status', 'data-gm-detail', 'data-gm-research', 'data-gm-all', 'data-gm-zone', 'data-gm-retry'];
  function swap(root, view, html) {
    if (view._html === html) return false;
    view._html = html;
    var a = document.activeElement, key = null, inside = a && root.contains(a), typed = null;
    /* a field being typed in keeps what was typed and where the caret was:
       the search's state lags the keystrokes by its debounce */
    if (inside && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { typed = { v: a.value }; try { typed.s = a.selectionStart; typed.e = a.selectionEnd; } catch (_) { /* date, select */ } }
    if (inside) {
      if (a.id) key = '#' + a.id;
      else for (var i = 0; i < KEY_ATTRS.length; i++) if (a.hasAttribute(KEY_ATTRS[i])) {
        var v = a.getAttribute(KEY_ATTRS[i]), card = a.closest('[data-id]');
        key = (card ? '[data-id="' + card.getAttribute('data-id') + '"] ' : '') + '[' + KEY_ATTRS[i] + (v ? '="' + v + '"' : '') + ']';
        break;
      }
    }
    var rails = {};
    ['.gm-row', '.gm-pills', '.gm-dates', '.gm-seg'].forEach(function (sel) { var r = root.querySelector(sel); if (r) rails[sel] = r.scrollLeft; });
    root.innerHTML = html;
    Object.keys(rails).forEach(function (sel) { var r = root.querySelector(sel); if (r) r.scrollLeft = rails[sel]; });
    if (key) {
      var x = null; try { x = root.querySelector(key); } catch (_) { x = null; }
      if (x) {
        if (typed) { x.value = typed.v; }
        try { x.focus({ preventScroll: true }); } catch (_) { x.focus(); }
        if (typed && typed.s != null) try { x.setSelectionRange(typed.s, typed.e); } catch (_) { /* not a text field */ }
      }
    }
    return true;
  }
  function focusPill(root, sp) { focusSel(root, '[data-gm-sport="' + sp + '"]'); }
  function focusSel(root, sel) { var b = root.querySelector(sel); if (b) try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); } }

  /* ====================================================== MATCHUP DETAIL */
  var lastTrigger = null;
  function findEvent(id) { var m = merged(); for (var i = 0; i < m.events.length; i++) if (m.events[i].id === id) return { e: G.effective(m.events[i], now()), mk: m.markets[id] }; return null; }
  /* NHL: EdgeDesk's own line against the price in the Market section, in
     words (lib/edgedesk_nhl_compare.js reads the compact view the slate
     carries; tools/slate/research.js). Nothing when the page lacks the code. */
  function nhlVsHTML(e, mk) {
    var md = e.research && e.research.model, C = window.EDNHLCompare;
    if (e.sport !== 'nhl' || !md || !md.view || !C || !window.EDNHLMarket || O('markets') === false) return '';
    var r = C.compare(md.view, mk, { now: now(), stale_minutes: G.CONFIG.market_limit_min });
    if (!r.ok) return '<p class="gm-note"><b>EdgeDesk vs the market:</b> ' + esc(r.reason) + '</p>';
    return '<p class="gm-vs"><b>EdgeDesk vs the market.</b> ' + esc(r.summary.sentence) + (r.source.stale ? ' ' + esc('The book’s price is past the ' + r.source.stale_minutes + '-minute limit: a past price, not a current one.') : '') + '</p>';
  }
  function modelHTML(e, mk) {
    var r = e.research || {}, md = r.model;
    if (!md || S.opts.host === 'public' || O('model') === false) return '';
    var f = md.fair || {}, rows = [];
    function am(v) { return G.american(v) || '—'; }
    if (f.ml_home != null || f.ml_away != null) rows.push(['Fair moneyline', e.away.short + ' ' + am(f.ml_away) + (f.ml_draw != null ? ' · Draw ' + am(f.ml_draw) : '') + ' · ' + e.home.short + ' ' + am(f.ml_home)]);
    if (f.spread_home != null) rows.push(['Fair line', e.home.short + ' ' + (G.point(f.spread_home) || '—')]);
    if (f.puck_home_minus_1_5 != null) rows.push(['Fair puck line', e.home.short + ' −1.5 ' + am(f.puck_home_minus_1_5) + ' · ' + e.away.short + ' +1.5 ' + am(f.puck_away_plus_1_5)]);
    if (f.total != null) rows.push(['Fair total', String(f.total)]);
    if (f.expected_total != null) rows.push(['Expected goals', String(f.expected_total)]);
    if (!rows.length) return '';
    return '<section class="gm-dsec"><h4>EdgeDesk model</h4><dl class="gm-dl">' + rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('') + '</dl>'
      + nhlVsHTML(e, mk)
      + '<p class="gm-note">' + esc((md.tier ? 'Validation: ' + String(md.tier).replace(/_/g, ' ').toLowerCase() + '. ' : '') + (md.note ? md.note.charAt(0).toUpperCase() + md.note.slice(1) + '. ' : '') + 'A fair price is EdgeDesk’s estimate, not a recommendation. Source: ' + md.source + '.') + '</p></section>';
  }
  function readinessListHTML(e, mk) {
    if (S.opts.host === 'public') return '';
    var rd = readinessOf(e, mk);
    if (!rd.assess) return '';
    var R = window.EDREADY;
    var items = R.STATES.map(function (k) { var s = rd.assess.states[k]; return '<li class="' + (s.ok ? 'ok' : 'no') + '"><b>' + esc(R.LABEL[k]) + '</b> ' + esc(s.why) + '</li>'; }).join('');
    return '<section class="gm-dsec"><h4>Readiness</h4><ul class="gm-rlist">' + items + '</ul><p class="gm-note">Five separate answers from EdgeDesk’s readiness rules. Ready to research is not ready to bet.</p></section>';
  }
  function researchMsg(e) {
    var r = e.research || {}, sp = G.sport(e.sport);
    var t = G.researchTarget(e, S.opts.host === 'public' ? 'public' : 'app');
    var msg;
    if (t.kind === 'module') msg = r.note || (t.exact ? 'EdgeDesk has research for this game.' : 'EdgeDesk researches ' + sp.name + ' in its own panel.');
    else if (t.kind === 'article') msg = 'EdgeDesk published free research on this game.';
    else if (t.kind === 'terminal') msg = 'EdgeDesk’s research on this game is in the Research Terminal (Full Access).';
    else if (r.model) msg = 'Research not available yet: EdgeDesk has no research page for ' + sp.name + ' games. Its model projects this one (below); that is a number to research, not a page of research.';
    else msg = 'Research not available yet for this game. It is on the slate so you can see it; EdgeDesk has not built research for it.';
    var link = t.href ? '<a class="gm-go" href="' + esc(t.href) + '" data-gm-research="' + esc(e.id) + '" data-kind="' + esc(t.kind) + '">' + esc(t.label) + '</a>' : '';
    var free = r.article && t.kind !== 'article' ? ' <a class="gm-link" href="' + esc(r.article.url) + '">Free ' + (r.article.type === 'postgame' ? 'postgame analysis' : 'research article') + '</a>' : '';
    return '<section class="gm-dsec"><h4>Research</h4><p>' + esc(msg) + '</p><div class="gm-act">' + link + free + '</div></section>';
  }
  function openDetail(id, trigger) {
    var f = findEvent(id);
    if (!f) return;
    var e = f.e, mk = f.mk, sp = G.sport(e.sport);
    lastTrigger = trigger || document.activeElement;
    var dlg = document.getElementById('gmDetail');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'gmDetail'; dlg.className = 'gm-dlg'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'gmDetailH'); dlg.hidden = true;
      document.body.appendChild(dlg);
      dlg.addEventListener('click', function (ev) { if (ev.target === dlg || ev.target.closest('[data-gm-close]')) closeDetail(); else if (ev.target.closest('[data-gm-research]')) closeDetail(true); });
      dlg.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); closeDetail(); return; }
        if (ev.key !== 'Tab') return;
        var f2 = dlg.querySelectorAll('a[href],button:not([disabled]),input,select,[tabindex]:not([tabindex="-1"])');
        if (!f2.length) return;
        var first = f2[0], last = f2[f2.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      });
    }
    var ms = G.toMs(e.start_utc);
    var where = [e.venue, e.city].filter(Boolean).join(', ');
    var f2 = G.formatMarket(e, mk, { now: now() });
    var h = '<div class="gm-dcard"><button type="button" class="gm-x" data-gm-close aria-label="Close">' + ICON.x + '</button>'
      + '<div class="gm-ctop"><span class="gm-lg">' + esc(e.league || sp.label) + '</span>' + statusHTML(e) + '</div>'
      + '<h3 id="gmDetailH">' + esc(e.title || (e.away.name + (e.neutral ? ' vs ' : ' at ') + e.home.name)) + '</h3>'
      + '<p class="gm-sub">' + esc(G.dateText(G.dateKey(ms, S.zone), true)) + ' · ' + (e.time_tbd ? 'time TBD' : esc(G.timeText(ms, S.zone))) + (where ? ' · ' + esc(where) : '') + (e.neutral ? ' · neutral site' : '') + (e.doubleheader ? ' · game ' + e.doubleheader.game + ' of a doubleheader' : '') + '</p>'
      + '<div class="gm-dteams">' + teamRow(e, e.away, 'away') + teamRow(e, e.home, 'home') + '</div>'
      + (e.status === 'STARTED' ? '<p class="gm-note">This game has started. No live update has reached EdgeDesk since, so no score is shown.</p>' : '');
    if (S.opts.host !== 'public' && O('markets')) {
      h += '<section class="gm-dsec"><h4>Market</h4>' + (f2.ok ? marketHTML(e, mk, false) + (f2.note ? '<p class="gm-note">' + esc(f2.note) + '</p>' : '') + (mk && mk.partial ? '<p class="gm-note">Not shown: ' + esc(mk.partial.join('; ')) + '.</p>' : '')
        : '<p>' + esc(f2.text) + ': ' + esc(f2.reason) + '.</p>') + '</section>';
    }
    h += researchMsg(e) + modelHTML(e, mk) + readinessListHTML(e, mk);
    var rr = e.research && e.research.read;
    if (rr && S.opts.host !== 'public') h += '<section class="gm-dsec"><h4>EdgeDesk read</h4><p><b>' + esc(rr.label) + '</b>' + (rr.means ? ' — ' + esc(rr.means) : '') + '</p>' + (rr.reason ? '<p class="gm-note">' + esc(rr.reason) + '</p>' : '') + '</section>';
    if (S.opts.host === 'public') h += publicReadHTML(e);
    /* the schedule's own feed is not named to the reader; a file is */
    var srcName = e.provider === 'espn' ? '' : e.source_file || e.provider || '';
    var sched = [srcName ? 'Schedule: ' + srcName : 'Schedule', e.updated_at ? 'read ' + G.ageText(e.updated_at, now()) : ''].filter(Boolean);
    h += '<p class="gm-foot">' + (sched.length > 1 || srcName ? esc(sched.join(srcName ? ', ' : ' ')) + '. ' : '') + 'Research, not picks.</p></div>';
    dlg.innerHTML = h;
    dlg.hidden = false;
    document.documentElement.classList.add('gm-lock');
    var x = dlg.querySelector('[data-gm-close]'); if (x) x.focus();
    track('games_matchup_open', { entity: e.sport });
  }
  function closeDetail(leaving) {
    var dlg = document.getElementById('gmDetail');
    if (!dlg || dlg.hidden) return;
    dlg.hidden = true;
    document.documentElement.classList.remove('gm-lock');
    if (!leaving && lastTrigger && document.body.contains(lastTrigger)) try { lastTrigger.focus(); } catch (_) { /* gone */ }
  }

  /* ================================================== REFRESH AND CLOCK */
  function notify() { renderAll(); schedule(); }
  function renderAll() { S.views.forEach(function (v) { try { v.render(); } catch (e) { if (window.console) console.error('games view', e); } }); }
  function selectedDates() {
    var d = [S.today];
    S.views.forEach(function (v) { if (v.st && v.st.date && d.indexOf(v.st.date) < 0) d.push(v.st.date); });
    return d;
  }
  function liveInterval() {
    var n = now(), m = merged(), soon = false, any = false;
    var dates = selectedDates();
    m.events.forEach(function (e) {
      var t = G.toMs(e.start_utc);
      if (t == null || dates.indexOf(G.dateKey(t, S.zone)) < 0) return;
      any = true;
      var ef = G.effective(e, n);
      if (ef.status === 'LIVE' || ef.status === 'STARTED' || ef.status === 'DELAYED' || (ef.status === 'SCHEDULED' && t - n < 45 * MIN && t > n - 6 * 3600000)) soon = true;
    });
    if (soon) return MIN;
    return dates.some(function (d) { return d >= S.today; }) && any ? 5 * MIN : null;
  }
  function schedule() {
    clearTimeout(S.timers.live);
    var iv = liveInterval();
    if (iv && !S.liveOff && O('sbKey')) S.timers.live = setTimeout(function () {
      if (document.hidden) { schedule(); return; }
      var dates = selectedDates();
      Promise.all(dates.slice(0, 2).map(function (d) { return fetchLive(d, true); }));
    }, iv);
  }
  function refreshAll(force) {
    return fetchSnap(force).then(function () {
      var ds = selectedDates();
      return Promise.all([fetchLive(ds[ds.length - 1], force), fetchMarkets(ds[ds.length - 1], force)]);
    });
  }
  /* the reader's local day changes at their midnight: Today moves with it */
  function dayCheck() {
    var before = S.today;
    resolveZone();
    if (S.today === before) return;
    S.views.forEach(function (v) { if (v.st && v.follow) { v.st.date = S.today; if (S.opts.hashMode !== false && v instanceof Page) { try { history.replaceState(null, '', location.pathname + location.search + G.stateHash(v.st)); } catch (_) { /* sandboxed */ } } } });
    track('games_day_rollover', {});
    refreshAll(true);
    renderAll();
    armMidnight();
  }
  function armMidnight() {
    clearTimeout(S.timers.midnight);
    S.timers.midnight = setTimeout(dayCheck, G.msUntilNextDay(now(), S.zone) + 1000);
  }
  var started = false;
  function start(opts) {
    if (opts) Object.keys(opts).forEach(function (k) { S.opts[k] = opts[k]; });
    if (started) return;
    started = true;
    resolveZone();
    armMidnight();
    /* timers sleep with the tab; on return, check the day and the data */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      dayCheck();
      if (now() - S.snapAt > 5 * MIN) refreshAll(false); else schedule();
    });
    S.timers.snap = setInterval(function () { if (!document.hidden) fetchSnap(true); }, 10 * MIN);
    S.timers.day = setInterval(dayCheck, MIN);
    refreshAll(false);
  }

  var api = {
    mountStrip: function (el, opts) {
      if (!el) return null;
      el.classList.add('gm-strip');
      el.setAttribute('aria-labelledby', 'gmStripH');
      var v = new Strip(el); v.bind(); S.views.push(v);
      start(opts); v.render();
      return v;
    },
    mountPage: function (el, opts) {
      if (!el) return null;
      el.classList.add('gm-page');
      el.setAttribute('aria-labelledby', 'gmPageH');
      start(opts);
      var v = new Page(el); v.bind(); S.views.push(v);
      var st = G.parseState(location.hash) || {};
      v.setState({ sport: st.sport, date: st.date || S.today, status: st.status, q: st.q });
      api.page = v;
      /* the page follows its own hash: Back and Forward between dates and
         filters, and any #games link, on any host (the terminal's router
         also hands it #games; applying the same state twice is a no-op) */
      if (S.opts.hashMode !== false) window.addEventListener('hashchange', function () { api.applyHash(location.hash); });
      return v;
    },
    /* the host's router hands a #games… hash here */
    applyHash: function (h) {
      var st = G.parseState(h);
      if (!st || !api.page) return false;
      var cur = api.page.st;
      if (cur.sport !== st.sport || cur.date !== (st.date || S.today) || cur.status !== st.status || cur.q !== st.q) api.page.setState({ sport: st.sport, date: st.date || S.today, status: st.status, q: st.q });
      return true;
    },
    setPublicRead: function (map) { S.publicRead = map || {}; renderAll(); },
    /* the freshest captured price for the game a research module holds, by
       the module and entity the slate's research reference names (the NHL
       panel compares it with EdgeDesk's own line). Null when none, and when
       the sources list the game's sides the other way round. */
    marketFor: function (module, entity) {
      if (!O('markets')) return null;
      var m = merged();
      for (var i = 0; i < m.events.length; i++) {
        var r = m.events[i].research;
        if (r && r.module === module && r.entity != null && String(r.entity) === String(entity)) return r.sides_swapped ? null : m.markets[m.events[i].id] || null;
      }
      return null;
    },
    refresh: function () { return refreshAll(true); },
    render: renderAll,
    closeDetail: closeDetail,
    /* the EdgeDesk Card opens a game's detail by its slate id; false when the
       slate on this page does not hold it (the Card then goes to #games) */
    openDetail: function (id) { if (!findEvent(id)) return false; openDetail(id, document.activeElement); return true; },
    _state: S
  };
  window.EDGamesUI = api;
})();
