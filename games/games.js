/* ===========================================================================
   EDGEDESK GAMES — the shared runtime.

   Loaded by every /games page. It owns the things all three pages do the same
   way: reading the committed challenge artifact, the analytics funnel, UTM
   attribution, sharing, deep links into the research terminal, and the chrome.

   It computes NO price. Every number it renders came out of
   games/data/challenges.json, which the build produced by running the
   canonical Power 4 exporter.
   =========================================================================== */
(function (root) {
  'use strict';

  var ART = '/games/data/challenges.json';
  var CFG = '/games/data/config.json';
  var TERMINAL = '/app.html';

  /* How far the spread selector travels, each way, in points.
     
     Wide enough that a genuine mismatch is inside the range rather than pinned
     at the end: a Power 4 team hosting an FCS opponent is routinely priced past
     five touchdowns, and a slider that stops at 28 forces those reads to lie.
     
     ONE constant, because it appears in four places on two pages — the two end
     labels, the input's min/max, and the nudge clamps — and a range that
     disagrees with its own labels is worse than either value. */
  var SPREAD_RANGE = 42;
  var SPREAD_STEP = 0.5;
  var W = root.EDGamesWeek, ST = root.EDGamesStore,
      CH = root.EDGamesChallenge, SC = root.EDGamesScoring,
      RS = root.EDGamesResearchState, AT = root.EDGamesAttribution,
      DY = root.EDGamesDynasty;   /* optional: a page without the Dynasty
                                     module still boots, it just has no XP */

  /* ── analytics ────────────────────────────────────────────────────────────
     The site already runs Google Analytics 4 (gtag, G-1PXVBV53FZ), declared in
     the page head exactly as index.html declares it. NO SECOND VENDOR is added.

     Every event carries the funnel properties the business questions need:
     which game, which sport, which research state, and whether the player was
     anonymous — plus the first-touch UTM campaign, so "how many people who
     arrived from this post eventually subscribed" is answerable from one
     report rather than three. */
  var FUNNEL = ['games_page_view', 'price_it_start', 'price_it_complete',
    'pick5_start', 'pick5_complete', 'result_reveal', 'share_result',
    'next_game_click', 'research_cta_click', 'save_score_cta',
    'signup_start_from_games', 'signup_complete_from_games',
    'pricing_view_from_games', 'checkout_start_from_games',
    'subscription_complete_from_games',
    /* the social layer's viral funnel: one invite created, opened, answered,
       settled and rematched is the loop the whole product is built around, so
       every step of it is countable */
    'h2h_create', 'h2h_invite_generated', 'h2h_invite_open', 'h2h_opponent_submit',
    'h2h_both_locked', 'h2h_settled', 'h2h_rematch',
    'group_create', 'group_invite_generated', 'group_invite_open', 'group_join',
    'group_first_game', 'group_weekly_return',
    'research_open_from_h2h', 'research_open_from_group',
    'signup_from_h2h', 'signup_from_group', 'subscription_from_games',
    /* EdgeDesk Dynasty — the persistent layer. A War Room is created by the
       first real game, levels come from a published XP curve, and every one
       of these is countable so "does the War Room bring people back" is a
       report and not a hope. return_* fire from the visit ledger, not from
       page views: a return is a gap in days, measured. */
    'dynasty_start', 'war_room_created', 'first_game_complete', 'account_save_from_dynasty',
    'level_up', 'weekly_mission_complete', 'weekly_mission_set_complete', 'achievement_unlock',
    'research_open_from_dynasty', 'premium_view_from_dynasty', 'subscription_from_dynasty',
    'return_1d', 'return_7d', 'return_next_football_week',
    /* the Two-Minute Drill */
    'drill_start', 'drill_round', 'drill_complete', 'drill_share', 'research_open_from_drill'];

  var _level = null;
  function track(event, props) {
    var p = props || {}, k;
    p.sport = p.sport || 'americanfootball_ncaaf';
    p.surface = 'games';
    p.identity = 'anonymous';        /* games are anonymous-first; an account
                                        layer flips this when one exists */
    /* the player's level rides on every event, so retention, invites and
       research use can be read BY level — the question the whole persistent
       layer exists to answer */
    if (_level != null) p.dynasty_level = _level;
    /* the campaign fields come from the SHARED ledger the landing page keeps,
       so a Games event and a subscription record name the same campaign */
    var a = AT ? AT.eventProps() : {};
    for (k in a) if (a.hasOwnProperty(k)) p[k] = a[k];
    try { if (typeof root.gtag === 'function') root.gtag('event', event, p); } catch (_) {}
    /* a local mirror so the funnel is debuggable without opening GA */
    try { (root.__edgamesEvents = root.__edgamesEvents || []).push([event, p, Date.now()]); } catch (_) {}
  }

  /* ── attribution ──────────────────────────────────────────────────────────
     Captured once, on first touch, and carried forward on every internal link
     into the rest of the product so the terminal, the pricing page and the
     signup all inherit the campaign that produced the visit. */
  function initAttribution() {
    if (!ST) return;
    try { ST.captureAttribution(root.location.search, root.document.referrer); } catch (_) {}
  }

  /* Append the surviving campaign to an internal URL, so the terminal, the
     pricing page and the checkout see what Games saw.

     `ref=games` is appended only when the visitor arrived with NO referral code
     of their own. Overwriting a real partner code with our own surface name
     would take a paying customer away from whoever actually sent them, and the
     landing page's credit rule freezes the first code precisely to stop that. */
  function withAttribution(url, extra) {
    var parts = AT ? AT.linkParams() : [], k;
    var f = AT ? AT.first() : null;
    if (!f || !f.ref) parts = parts.concat(['ref=games']);
    if (extra) for (k in extra) if (extra.hasOwnProperty(k))
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
  }

  /* ── the artifact ─────────────────────────────────────────────────────────
     One fetch, cached on the module. A failure is reported honestly rather
     than replaced with invented games. */
  var _artifact = null, _pending = null;
  function artifact() {
    if (_artifact) return Promise.resolve(_artifact);
    if (_pending) return _pending;
    _pending = fetch(ART, { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('challenges ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.schema !== 'edgedesk_games_challenges_v1' || !Array.isArray(j.challenges))
          throw new Error('unexpected challenge artifact');
        _artifact = j;
        return j;
      })
      .catch(function (e) { _pending = null; throw e; });
    return _pending;
  }

  /* ── research deep links ──────────────────────────────────────────────────
     The research terminal is a hash-routed single page. A challenge opens the
     football research module with the matchup named, so the reader lands on
     the game they just priced rather than on a board they have to search.
     The campaign rides along. */
  function researchUrl(ch) {
    var frag = '#research/football';
    var q = { game: ch && ch.game_id ? ch.game_id : '', slug: ch && ch.slug ? ch.slug : '' };
    /* the terminal's router is #research/<module>/<entity>: naming the game
       in the hash opens THAT matchup's card rather than the whole board, so a
       reader who tapped "research this matchup" lands on the matchup */
    if (ch && ch.game_id != null) frag += '/' + encodeURIComponent(String(ch.game_id));
    return withAttribution(TERMINAL, q) + frag;
  }

  /* Opening the research is the funnel's whole point, so it is recorded on
     the player's record (once per game — a reload is not a review) before
     the page leaves. The XP for it is celebrated when they come back. */
  function openResearch(ch, where, opts) {
    opts = opts || {};
    var first = false;
    if (ST && ST.recordResearchOpen && ch) {
      try { first = !!ST.recordResearchOpen(ch).first; } catch (_) {}
    }
    track(opts.event || 'research_cta_click', {
      game_id: ch && ch.game_id, game_slug: ch && ch.slug, game_type: opts.game_type || 'price_it',
      research_state: ch && ch.research_state, placement: where || 'reveal', first_open: first
    });
    root.location.href = researchUrl(ch);
  }

  /* ── formatting ───────────────────────────────────────────────────────────
     Spreads are stored as the HOME team's line. `-7.3` means the home team is
     favoured by 7.3. These turn that into the way a human says it. */
  function pts(v) {
    if (v == null || !isFinite(v)) return '—';
    var r = Math.round(v * 10) / 10;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1);
  }

  /* "Auburn −9.7" — the favourite named with its number. A pick'em says so. */
  function line(ch, homeSpread) {
    if (homeSpread == null || !isFinite(homeSpread)) return null;
    var r = Math.round(homeSpread * 10) / 10;
    if (r === 0) return 'Pick ’em';
    return (r < 0 ? ch.home_team : ch.away_team) + ' −' + Math.abs(r).toFixed(1);
  }

  function kickoffLabel(iso) {
    if (!iso) return '';
    var t = Date.parse(String(iso).replace(' ', 'T'));
    if (!isFinite(t)) return String(iso);
    var d = new Date(t);
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM', hh = h % 12 || 12;
    return days[d.getDay()] + ' · ' + hh + (m ? ':' + (m < 10 ? '0' : '') + m : ':00') + ' ' + ampm;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── sharing ──────────────────────────────────────────────────────────────
     Native share where the browser has it, clipboard where it does not, and a
     visible link as the last resort. The text is plain, factual and carries no
     claim that the player has found a bet. */
  function shareText(ch, res) {
    var L = [];
    L.push('I PRICED IT');
    L.push('');
    L.push(ch.away_team + ' vs ' + ch.home_team);
    L.push('');
    L.push('My line: ' + (line(ch, res.user_spread) || '—'));
    if (res.market_spread != null) L.push('Market: ' + line(ch, res.market_spread));
    if (res.edgedesk_spread != null) L.push('EdgeDesk: ' + line(ch, res.edgedesk_spread));
    L.push('');
    L.push('Score: ' + res.score);
    L.push('');
    L.push('Can you price it better?');
    L.push('EdgeDesk Games');
    return L.join('\n');
  }

  function shareUrl(ch) {
    return root.location.origin + '/games/price-it/' + encodeURIComponent(ch.slug);
  }

  function share(ch, res) {
    var text = shareText(ch, res), url = shareUrl(ch);
    track('share_result', { game_id: ch.game_id, game_slug: ch.slug, game_type: 'price_it',
      research_state: ch.research_state, score: res.score });
    if (root.navigator && root.navigator.share) {
      return root.navigator.share({ title: 'EdgeDesk Games', text: text, url: url })
        .catch(function () { /* the player dismissed the sheet — not an error */ });
    }
    var payload = text + '\n' + url;
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(payload)
        .then(function () { toast('Result copied — paste it anywhere'); })
        .catch(function () { toast('Could not copy automatically'); });
    }
    toast('Copy this: ' + url);
    return Promise.resolve();
  }

  /* ── toast ────────────────────────────────────────────────────────────── */
  var _toastEl = null, _toastT = null;
  function toast(msg) {
    var d = root.document;
    if (!_toastEl) {
      _toastEl = d.createElement('div');
      _toastEl.className = 'toast';
      _toastEl.setAttribute('role', 'status');
      _toastEl.setAttribute('aria-live', 'polite');
      d.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.add('on');
    if (_toastT) clearTimeout(_toastT);
    _toastT = setTimeout(function () { _toastEl.classList.remove('on'); }, 2600);
  }

  /* ── chrome ───────────────────────────────────────────────────────────── */
  function header(current) {
    /* `gh-word` and `gh-only-wide` are dropped by CSS on the narrowest phones.
       At 320px the full logo plus three links overflows the viewport, and a
       header that scrolls sideways is the first thing a visitor sees go wrong.
       The EdgeDesk link is the one that goes: it is repeated in the footer of
       every page, so nothing becomes unreachable. */
    return '<header class="gh"><div class="wrap gh-in">'
      + '<a class="gh-logo" href="/games/"><span class="mk"></span>'
      + '<span class="gh-word">EDGEDESK </span><span class="gh-tag">GAMES</span></a>'
      + '<span class="gh-sp"></span>'
      + '<nav class="gh-nav" aria-label="Games">'
      /* the War Room is the player's home, so it leads; the level badge is
         the one piece of status that follows them onto every page */
      + '<a href="/games/dynasty/"' + (current === 'dynasty' ? ' aria-current="page"' : '') + '>War Room'
      + '<span class="gh-lvl" id="ghLvl" aria-label="your level" hidden></span></a>'
      + '<a href="/games/two-minute-drill/"' + (current === 'drill' ? ' aria-current="page"' : '') + '>Drill</a>'
      + '<a href="/games/price-it/"' + (current === 'price-it' ? ' aria-current="page"' : '') + '>Price It</a>'
      + '<a class="gh-only-wide" href="/games/h2h/"' + (current === 'h2h' ? ' aria-current="page"' : '') + '>H2H</a>'
      + '<a class="gh-only-wide" href="/games/pick-5/"' + (current === 'pick-5' ? ' aria-current="page"' : '') + '>Pick 5</a>'
      + '<a class="gh-only-wide" href="/games/groups/"' + (current === 'groups' ? ' aria-current="page"' : '') + '>Groups</a>'
      + '</nav></div></header>';
  }

  /* The responsible-play block. It is not decoration and it is not optional:
     it states plainly that nothing here is wagering, and it repeats the
     research posture the rest of the product is built on. */
  function footer() {
    return '<footer class="gf"><div class="wrap">'
      + '<div class="rule">Free to play. No purchase necessary. No real-money wagering.</div>'
      + '<div>EdgeDesk Games is entertainment. No deposits, no wallet, no balance, no entry fee '
      + 'and no prizes. Scores are points in a free game and nothing else.</div>'
      + '<div style="margin-top:8px">EdgeDesk is research, not picks. A disagreement between '
      + 'EdgeDesk and the market is a reason to read more, not evidence of a betting edge — '
      + 'the model does not beat the closing line. 21+. If gambling is a problem for you, '
      + 'call 1-800-GAMBLER.</div>'
      + '<div class="gf-links">'
      + '<a href="/games/">Games home</a><a href="/games/dynasty/">War Room</a>'
      + '<a href="/games/two-minute-drill/">Two-Minute Drill</a>'
      + '<a href="/games/price-it/">Price It</a><a href="/games/h2h/">Head-to-Head</a>'
      + '<a href="/games/pick-5/">Pick 5</a><a href="/games/groups/">Groups</a>'
      + '<a href="' + esc(withAttribution(TERMINAL)) + '">The terminal</a>'
      + '<a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a>'
      + '<a href="/disclaimer.html">Disclaimer</a>'
      /* the operator read-out: what is connected right now. Linked from every
         page because a missing feed is otherwise invisible from the outside. */
      + '<a href="/games/status/">Status</a>'
      + '</div></div></footer>';
  }

  function mount(current) {
    var d = root.document;
    var h = d.getElementById('gh'), f = d.getElementById('gf');
    if (h) h.outerHTML = header(current);
    if (f) f.outerHTML = footer();
  }

  /* ── the social endpoint ──────────────────────────────────────────────────
     A tiny committed file the build writes from app.html, so the games pages
     and the terminal can never point at different Supabase projects. Its
     absence is not an error: Price It and Pick 5 do not need it, and the social
     pages say plainly that they are not deployed. */
  var _cfg = null, _cfgPending = null;
  function config() {
    if (_cfg) return Promise.resolve(_cfg);
    if (_cfgPending) return _cfgPending;
    _cfgPending = fetch(CFG, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        _cfg = (j && j.supabase_url && j.supabase_anon_key) ? j : null;
        if (_cfg && root.EDGamesSocial) {
          root.EDGamesSocial.configure(_cfg.supabase_url, _cfg.supabase_anon_key);
        }
        if (_cfg && root.EDGamesLeaderboard) {
          root.EDGamesLeaderboard.configure(_cfg.supabase_url, _cfg.supabase_anon_key);
        }
        return _cfg;
      })
      .catch(function () { _cfgPending = null; _cfg = null; return null; });
    return _cfgPending;
  }

  /* ── page boot ────────────────────────────────────────────────────────── */
  /* ── the Dynasty pulse ────────────────────────────────────────────────────
     Every page calls pulse() after something real happened (and once on boot,
     for things that happened elsewhere — a research open, a Pick 5 result
     that settled). It compares the live summary against the one the player
     was last SHOWN, celebrates exactly what is new, and stores the new
     marker. So a level-up is announced once, on whichever page first sees it,
     and a reload announces nothing. */
  var _pulseHost = null;
  function pulseHost() {
    var d = root.document;
    if (_pulseHost) return _pulseHost;
    _pulseHost = d.createElement('div');
    _pulseHost.className = 'pulse';
    _pulseHost.setAttribute('role', 'status');
    _pulseHost.setAttribute('aria-live', 'polite');
    d.body.appendChild(_pulseHost);
    return _pulseHost;
  }
  function chip(html, cls, ms) {
    var d = root.document, el = d.createElement('div');
    el.className = 'pulse-chip' + (cls ? ' ' + cls : '');
    el.innerHTML = html;
    pulseHost().appendChild(el);
    setTimeout(function () { el.classList.add('on'); }, 20);
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, ms || 3600);
  }
  /* the one moment that interrupts: a new level (and a new room), or the
     War Room being created by the first game. Dismissable, keyboard-closable,
     and it never blocks the page underneath from being scrolled away from. */
  function moment(o) {
    var d = root.document, el = d.createElement('div');
    el.className = 'moment';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', o.title);
    el.innerHTML = '<div class="moment-card">'
      + '<div class="eyebrow">' + esc(o.eyebrow || '') + '</div>'
      + '<div class="moment-title">' + esc(o.title) + '</div>'
      + (o.sub ? '<div class="moment-sub">' + esc(o.sub) + '</div>' : '')
      + (o.body ? '<div class="moment-body">' + esc(o.body) + '</div>' : '')
      + '<div class="btn-row two">'
      + '<a class="btn btn-go" href="/games/dynasty/">' + esc(o.cta || 'See my War Room') + '</a>'
      + '<button class="btn" type="button" data-close>' + esc(o.dismiss || 'Keep playing') + '</button>'
      + '</div></div>';
    d.body.appendChild(el);
    function close() { el.classList.remove('on'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300); }
    el.querySelector('[data-close]').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    d.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { close(); d.removeEventListener('keydown', onKey); } });
    setTimeout(function () { el.classList.add('on'); try { el.querySelector('.btn-go').focus(); } catch (_) {} }, 20);
  }

  function summaryNow() {
    if (!ST || !DY) return null;
    try { return DY.summary(ST.read()); } catch (_) { return null; }
  }

  function paintLevel(now) {
    var d = root.document, b = d.getElementById('ghLvl');
    if (!b || !now) return;
    if (now.created) { b.textContent = 'L' + now.level; b.hidden = false; }
  }

  function pulse(opts) {
    opts = opts || {};
    var now = summaryNow();
    if (!now) return null;
    _level = now.level;
    paintLevel(now);
    var seen = null;
    try { seen = ST.dynastySeen(); } catch (_) {}
    var d = DY.diff(seen, now);
    try { ST.markDynastySeen(DY.marker(now)); } catch (_) {}
    if (opts.silent) return { now: now, diff: d };

    var i;
    /* the first look at an envelope that already has history: one moment,
       no chip storm — the War Room page shows the rest. ON the War Room
       page there is no moment at all: the room is the moment. */
    if (d.baseline) {
      if (now.games >= DY.CREATE_AT && !opts.here) {
        track('war_room_created', { level: now.level, from: 'history' });
        moment({ eyebrow: 'EdgeDesk Dynasty', title: 'Your War Room is ready',
          sub: 'Level ' + now.level + ' · ' + now.title,
          body: 'Built from the games you have already played here. Every game from now on builds it: levels, missions, achievements.',
          cta: 'See my War Room', dismiss: 'Keep playing' });
      }
      return { now: now, diff: d };
    }
    if (d.first_result) {
      track('first_game_complete', { game_type: opts.game_type || 'unknown' });
      chip('<b>Nice.</b> <span>Your first EdgeDesk result · +' + d.xp_gained + ' XP</span>', 'xp', 4200);
      return { now: now, diff: d };
    }
    if (d.created) {
      track('war_room_created', { level: now.level, from: 'play' });
      if (!opts.here) moment({ eyebrow: 'EdgeDesk Dynasty', title: 'War Room created',
        sub: 'Level ' + now.level + ' · ' + now.title,
        body: 'Two games in, you have a record. From here every game builds it: levels, missions, achievements — and a room that changes as you go.',
        cta: 'See my War Room', dismiss: 'Keep playing' });
    } else if (d.leveled_up) {
      track('level_up', { from: d.from_level, to: now.level, stage: now.stage.key });
      if (opts.here) chip('<b>Level ' + now.level + '</b> <span>' + esc(now.title) + (d.stage_changed ? ' · ' + esc(now.stage.name) : '') + '</span>', 'xp', 5000);
      else moment({ eyebrow: 'Level up', title: 'Level ' + now.level + ' · ' + now.title,
        sub: d.stage_changed ? 'Your War Room is now ' + now.stage.name : null,
        body: d.stage_changed ? now.stage.blurb : (now.next ? now.next.remaining + ' XP to level ' + now.next.level : null),
        cta: 'See my War Room', dismiss: 'Keep playing' });
    }
    if (d.xp_gained > 0 && !d.created)
      chip('<b>+' + d.xp_gained + ' XP</b>' + (now.next ? ' <span>' + now.next.remaining + ' to level ' + now.next.level + '</span>' : ''), 'xp');
    /* at most two achievements as chips; the rest fold into one line, and
       the trophy wall has them all */
    for (i = 0; i < d.new_achievements.length; i++) {
      track('achievement_unlock', { achievement: d.new_achievements[i].id });
      if (i < 2) chip('<b>Achievement</b> <span>' + esc(d.new_achievements[i].name) + '</span>', 'ach', 4200);
    }
    if (d.new_achievements.length > 2)
      chip('<b>+' + (d.new_achievements.length - 2) + ' more</b> <span>on your trophy wall</span>', 'ach', 4200);
    if (d.missions_newly_done > 0 && !d.set_completed) {
      track('weekly_mission_complete', { done: now.missions.done, total: now.missions.total });
      chip('<b>Mission complete</b> <span>' + now.missions.done + ' of ' + now.missions.total + ' this week</span>', 'mis', 4200);
    }
    if (d.set_completed) {
      track('weekly_mission_set_complete', { week: now.missions.week });
      chip('<b>Weekly badge</b> <span>every mission this week · +' + DY.XP.mission_set + ' XP</span>', 'mis', 5000);
    }
    return { now: now, diff: d };
  }

  /* ── page boot ────────────────────────────────────────────────────────── */
  function boot(page) {
    initAttribution();
    mount(page);
    /* the visit ledger first, so the page view can say what kind of return
       this is — a fact from the record, not a guess from a cookie */
    var v = null;
    if (ST && ST.touchVisit) { try { v = ST.touchVisit(); } catch (_) {} }
    var now = summaryNow();
    if (now) { _level = now.level; paintLevel(now); }
    track('games_page_view', { page: page, visit: v ? (v.first ? 'first' : v.new_day ? 'new_day' : 'same_day') : 'unknown' });
    if (v) {
      if (v.return_1d) track('return_1d', { gap_days: v.gap_days });
      if (v.return_7d) track('return_7d', { gap_days: v.gap_days });
      if (v.return_week) track('return_next_football_week', { week: W ? W.weekKey() : null });
    }
    /* things that happened elsewhere (a research open, a card that settled)
       are celebrated on the next page that loads — after it has painted */
    if (now && !page.match(/^(dynasty)$/)) setTimeout(function () { try { pulse({ boot: true }); } catch (_) {} }, 700);
    return config();
  }

  var API = {
    ART: ART, TERMINAL: TERMINAL, FUNNEL: FUNNEL,
    SPREAD_RANGE: SPREAD_RANGE, SPREAD_STEP: SPREAD_STEP,
    track: track, withAttribution: withAttribution, initAttribution: initAttribution,
    artifact: artifact, config: config, researchUrl: researchUrl, openResearch: openResearch,
    pts: pts, line: line, kickoffLabel: kickoffLabel, esc: esc,
    shareText: shareText, shareUrl: shareUrl, share: share,
    toast: toast, header: header, footer: footer, mount: mount, boot: boot,
    pulse: pulse, summaryNow: summaryNow, chip: chip, moment: moment
  };
  root.EDGames = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
