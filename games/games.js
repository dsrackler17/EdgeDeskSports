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
      DY = root.EDGamesDynasty,   /* optional: a page without the Dynasty
                                     module still boots, it just has no XP */
      FR = root.EDFranchise,       /* optional: the franchise layer; a page
                                     without it is the anonymous game */
      AU = root.EDGamesAuth;       /* optional: sign-in from inside Games */

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
    'drill_start', 'drill_round', 'drill_complete', 'drill_share', 'research_open_from_drill',
    /* game-quality metrics: how fast a stranger gets to a first real action,
       whether a result leads to a rematch, and whether a premium look
       follows research use rather than preceding it */
    'first_game_start', 'time_to_first_action', 'rematch', 'challenge_created', 'challenge_accepted',
    'premium_view_after_research', 'keep_playing_free',
    /* THE FRANCHISE. One fictional football franchise per account, built by
       playing the real games. franchise_created is the conversion the whole
       layer exists for; the rest say whether the franchise brings people
       back and what they do when they are here. Declared once, here, so a
       report can count an event the moment a surface emits it. */
    'franchise_created', 'franchise_home_view', 'franchise_signin', 'franchise_signup', 'franchise_import',
    'player_view', 'roster_change', 'daily_objective_complete', 'scouting_spent', 'player_scouted',
    'weekly_game_started', 'weekly_game_completed', 'h2h_franchise_complete', 'achievement_unlocked',
    'season_complete', 'draft_pick', 'trophy_room_view', 'front_office_view', 'roster_view',
    'franchise_reward', 'franchise_claimed', 'franchise_signout',
    /* the weekly game (Phase 2): a season opened, the Game Day page seen,
       a result shared. weekly_game_started/completed and season_complete
       are declared above. */
    'season_started', 'gameday_view', 'game_share'];

  var _level = null;
  function track(event, props) {
    var p = props || {}, k;
    p.sport = p.sport || 'americanfootball_ncaaf';
    p.surface = 'games';
    /* games are anonymous-first; the account layer flips this when a
       session exists, and the franchise layer says whether one is owned */
    var signed = false, owns = false;
    try { signed = !!(root.EDGamesSocial && root.EDGamesSocial.signedIn()); } catch (_) {}
    try { owns = !!(FR && FR.hasFranchise()); } catch (_) {}
    p.identity = signed ? 'authenticated' : 'anonymous';
    p.has_franchise = owns;
    if (owns) { try { p.franchise_owner = FR.owner(); } catch (_) {} }
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
    /* the franchise credits a research open too — QUEUED, not sent: the
       page is about to leave, and a request cut off mid-flight would be
       neither confirmed nor retried. The next boot replays it; the server
       keys it once per game. */
    if (first && FR && ST && ch && ch.game_id != null) {
      try { if (FR.state() === 'franchise') ST.queueFranchise({ key: 'research:' + ch.game_id,
        fn: 'franchise_record_research', args: { p_game_id: String(ch.game_id) } }); } catch (_) {}
    }
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
    L.push('I priced ' + (line(ch, res.user_spread) || (ch.away_team + ' vs ' + ch.home_team + ' as a pick ’em')) + '.');
    if (res.market_spread != null) L.push('Market: ' + line(ch, res.market_spread));
    if (res.edgedesk_spread != null) L.push('EdgeDesk: ' + line(ch, res.edgedesk_spread));
    L.push('');
    L.push('How would you price it?');
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
  /* THE FACILITY. /games is a football organization with rooms, and the
     header names the rooms rather than the games: HQ, the War Room, Scouting
     (Price It), Training (the Drill), Game Day (Head-to-Head, and the weekly
     franchise game when it arrives), the Roster, the League (Groups) and the
     Front Office. Each room is a real page that already exists or is added
     with the franchise; nothing is renamed away — Price It is still Price
     It on its own page.

     `gh-word` and `gh-only-wide` are dropped by CSS on the narrowest phones
     (under 480px) and `gh-only-wider` below 768px; every dropped room is on
     the tab bar or in the footer of every page, so nothing becomes
     unreachable. */
  var ROOMS = [
    /* on a phone (under 480px) the wordmark links home, the tab bar carries
       HQ, Scouting and Training, and every footer carries the rest — so the
       header keeps only the War Room (with the level badge) and, on a page
       without a tab bar, Scouting. Measured: the chip, the badge and four
       rooms overflowed a 390px phone by 60px. */
    { key: 'home',     href: '/games/',                  label: 'HQ',           tab: 'HQ',    cls: 'gh-home' },
    { key: 'dynasty',  href: '/games/dynasty/',          label: 'War Room' },
    { key: 'price-it', href: '/games/price-it/',         label: 'Scouting',     tab: 'Scout', cls: 'gh-scout' },
    { key: 'drill',    href: '/games/two-minute-drill/', label: 'Training',     tab: 'Train', cls: 'gh-train' },
    /* Game Day is the weekly franchise game; Head-to-Head lives on it too */
    { key: 'gameday',  href: '/games/gameday/',          label: 'Game Day',     tab: 'Game Day', cls: 'gh-only-wide' },
    { key: 'roster',   href: '/games/roster/',           label: 'Roster',       tab: 'Roster',   cls: 'gh-only-wide' },
    { key: 'groups',   href: '/games/groups/',           label: 'League',       cls: 'gh-only-wider' },
    { key: 'franchise', href: '/games/franchise/',       label: 'Front Office', cls: 'gh-only-wider' }
  ];
  function header(current) {
    var nav = ROOMS.map(function (r) {
      return '<a' + (r.cls ? ' class="' + r.cls + '"' : '') + ' href="' + r.href + '"'
        + (current === r.key ? ' aria-current="page"' : '') + '>' + r.label
        /* the level badge is the one piece of status that follows the
           player onto every page; it rides on the War Room */
        + (r.key === 'dynasty' ? '<span class="gh-lvl" id="ghLvl" aria-label="your level" hidden></span>' : '')
        + '</a>';
    }).join('');
    return '<header class="gh"><div class="wrap gh-in">'
      + '<a class="gh-logo" href="/games/"><span class="mk"></span>'
      + '<span class="gh-word">EDGEDESK </span><span class="gh-tag">GAMES</span></a>'
      /* the franchise chip: the mark and the abbreviation, once one exists */
      + '<a class="gh-fr" id="ghFr" href="/games/" hidden aria-label="your franchise"></a>'
      + '<span class="gh-sp"></span>'
      + '<nav class="gh-nav" aria-label="The facility">' + nav + '</nav></div></header>';
  }

  /* THE TAB BAR. On a phone the facility is navigated with a thumb: five
     rooms, fixed to the bottom, on the pages that carry a `#gt` mount (the
     Pick 5 card and the Drill run keep their own bottom controls). */
  var TAB_ICONS = {
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1z"/>',
    'price-it': '<path d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 4a5 5 0 110 10 5 5 0 010-10zm0 3.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/>',
    drill: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.6l3.5 2-1 1.7L11 13.4V7z"/>',
    gameday: '<path d="M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9-9-4-9-9zm3.2-1.2l3.6 2.4-1.8 2.8 5.2-.4L15 10l-3.4 2.2-2.9-1.9z"/>',
    roster: '<path d="M8 4a3 3 0 110 6 3 3 0 010-6zm8 1a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM3 19c0-3 2.5-5 5-5s5 2 5 5v1H3zm11 1v-1c0-1.6-.5-3-1.3-4 .6-.3 1.4-.5 2.3-.5 2.3 0 4.5 1.6 4.5 4v1.5z"/>'
  };
  function tabs(current) {
    return '<nav class="gtab" aria-label="Facility">' + ROOMS.filter(function (r) { return r.tab; }).map(function (r) {
      return '<a href="' + r.href + '"' + (current === r.key ? ' aria-current="page"' : '') + '>'
        + '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (TAB_ICONS[r.key] || '') + '</svg>'
        + '<span>' + r.tab + '</span></a>';
    }).join('') + '</nav>';
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
      + '<a href="/games/">HQ</a><a href="/games/dynasty/">War Room</a>'
      + '<a href="/games/two-minute-drill/">Two-Minute Drill</a>'
      + '<a href="/games/price-it/">Price It</a><a href="/games/h2h/">Head-to-Head</a>'
      + '<a href="/games/pick-5/">Pick 5</a><a href="/games/groups/">Groups</a>'
      + '<a href="/games/gameday/">Game Day</a>'
      + '<a href="/games/roster/">Roster</a><a href="/games/franchise/">Front Office</a>'
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
    var h = d.getElementById('gh'), f = d.getElementById('gf'), t = d.getElementById('gt');
    if (h) h.outerHTML = header(current);
    if (f) f.outerHTML = footer();
    if (t) { t.outerHTML = tabs(current); try { d.body.classList.add('has-tabs'); } catch (_) {} }
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
        if (_cfg && AU) AU.configure(_cfg.supabase_url, _cfg.supabase_anon_key);
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

  /* ── the premium moment ───────────────────────────────────────────────────
     EdgeDesk Pro is the research, and it is mentioned exactly once per
     football week, only after the player has opened the research on at
     least PRO_AFTER_OPENS matchups this week — a look at the price after
     demonstrated interest, never a pitch before value. "Keep playing free"
     is a real button, and dismissing it is remembered for the week.
     Returns '' when the moment is not due. */
  var PRO_AFTER_OPENS = 3;
  var PRICING = '/#pricing';
  function proDue() {
    if (!ST || !W) return false;
    var wk = W.weekKey(), n = 0;
    try {
      ST.researchOpens().forEach(function (o) { if (o.week === wk) n++; });
      if (ST.seen('pro_moment:' + wk)) return false;
    } catch (_) { return false; }
    return n >= PRO_AFTER_OPENS ? n : false;
  }
  function proMoment(placement) {
    var n = proDue();
    if (!n) return '';
    return '<div class="card pro" data-pro="' + esc(placement || '') + '">'
      + '<div class="eyebrow">EdgeDesk research</div>'
      + '<div class="pro-t">You have opened the research on ' + n + ' matchups this week.</div>'
      + '<p>Full EdgeDesk research goes further on every one of them: simulations, complete roster and '
      + 'player context, market research, the model’s own explanations, and the history.</p>'
      + '<div class="btn-row two">'
      + '<a class="btn btn-go" href="' + esc(withAttribution(PRICING, { intent: 'pro_after_research', placement: placement || '' })) + '" data-pro-view>View EdgeDesk Pro</a>'
      + '<button class="btn" type="button" data-pro-free>Keep playing free</button>'
      + '</div>'
      + '<div class="ftp" style="margin-top:10px">The games never need it. Pro is the research, not a better score.</div>'
      + '</div>';
  }
  /* attach after the HTML above is in the page */
  function wireProMoment() {
    var d = root.document, host = d.querySelector('[data-pro]');
    if (!host) return;
    var wk = W ? W.weekKey() : 'all', placement = host.getAttribute('data-pro') || '';
    track('premium_view_after_research', { placement: placement, shown: true });
    var view = host.querySelector('[data-pro-view]'), free = host.querySelector('[data-pro-free]');
    if (view) view.addEventListener('click', function () {
      try { ST.markSeen('pro_moment:' + wk); } catch (_) {}
      track('pricing_view_from_games', { placement: placement, after_research: true });
      track('premium_view_from_dynasty', { placement: placement });
    });
    if (free) free.addEventListener('click', function () {
      try { ST.markSeen('pro_moment:' + wk); } catch (_) {}
      track('keep_playing_free', { placement: placement });
      host.classList.add('hide');
    });
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
    /* the franchise: paint the cached chip at once, then refresh from the
       server and replay anything it has not confirmed. Pages that need the
       result wait on EDGames.franchiseReady rather than on config(). */
    paintFranchise();
    var ready = config();
    _franchiseReady = ready.then(function () {
      if (!FR) return { state: 'anonymous' };
      return FR.boot().then(function (r) { paintFranchise(); notifyFranchise(r); return r; })
        .catch(function () { return { state: FR.state() }; });
    });
    return ready;
  }

  /* ── the franchise on every page ─────────────────────────────────────── */
  var _franchiseReady = null;
  function franchiseReady() { return _franchiseReady || Promise.resolve({ state: 'anonymous' }); }
  function paintFranchise() {
    var d = root.document, el = d.getElementById('ghFr'), snap = null;
    if (!el || !FR) return;
    try { snap = FR.snapshot(); } catch (_) {}
    if (!snap || !snap.franchise) { el.hidden = true; return; }
    var f = snap.franchise;
    el.innerHTML = FR.logoSvg(f.logo, 22, f.theme) + '<span class="gh-fr-ab">' + esc(f.abbr) + '</span>';
    el.setAttribute('style', FR.themeVars(f.theme));
    el.setAttribute('aria-label', esc((f.city + ' ' + f.name).trim()));
    el.hidden = false;
  }
  function notifyFranchise(r) {
    try {
      var d = root.document, ev;
      if (typeof root.CustomEvent === 'function') ev = new root.CustomEvent('edgames:franchise', { detail: r });
      else { ev = d.createEvent('CustomEvent'); ev.initCustomEvent('edgames:franchise', false, false, r); }
      d.dispatchEvent(ev);
    } catch (_) {}
  }

  /* THE REWARD PANEL. What the server credited for one real thing, rendered
     the same way on every reveal: the currencies that moved, and where they
     went. `r` is the RPC result (or a queued/skipped one); `preview` is the
     published table's estimate for an anonymous player. */
  function rewardChips(rw) {
    var out = '', keys = [['xp', 'XP'], ['sp', 'SP'], ['tc', 'TC'], ['cp', 'CP']], i;
    for (i = 0; i < keys.length; i++) {
      var k = keys[i][0], v = rw && rw[k];
      if (v) out += '<span class="rw-chip rw-' + k + '"><b>+' + esc(v) + '</b> ' + keys[i][1] + '</span>';
    }
    return out;
  }
  function rewardPanel(r, opts) {
    opts = opts || {};
    var snap = null; try { snap = FR ? FR.snapshot() : null; } catch (_) {}
    var name = snap && snap.franchise ? (snap.franchise.city + ' ' + snap.franchise.name) : null;
    if (r && r.ok && r.data) {
      var d = r.data, chips = rewardChips(d.rewards);
      var ach = (d.achievements && d.achievements.length) ? '<div class="rw-ach">Achievement: <b>'
        + d.achievements.map(function (id) { return esc(FR && FR.achievementName ? FR.achievementName(id) : id); }).join('</b>, <b>') + '</b></div>' : '';
      if (d.already) return '<div class="rw"><div class="eyebrow">' + esc(name || 'Your franchise') + '</div>'
        + '<div class="rw-line">Already on the books — nothing credits twice.</div></div>';
      return '<div class="rw on"><div class="eyebrow">' + esc(name || 'Your franchise') + '</div>'
        + '<div class="rw-chips">' + (chips || '<span class="rw-none">No new credit</span>') + '</div>' + ach
        + (d.totals ? '<div class="rw-line">Level ' + esc(d.totals.level) + ' · ' + esc(fmt(d.totals.xp)) + ' XP · '
          + esc(fmt(d.totals.scouting_points)) + ' SP · ' + esc(fmt(d.totals.team_credits)) + ' TC</div>' : '')
        + '</div>';
    }
    if (r && r.queued) return '<div class="rw"><div class="eyebrow">' + esc(name || 'Your franchise') + '</div>'
      + '<div class="rw-line">Saved here. EdgeDesk could not be reached, so this credits the next time you are online.</div></div>';
    if (r && r.ok === false && r.error === 'not_deployed') return '';
    if (r && r.ok === false && !r.skipped) return '<div class="rw"><div class="eyebrow">' + esc(name || 'Your franchise') + '</div>'
      + '<div class="rw-line">' + esc(r.message || 'This could not be credited.') + '</div></div>';
    return '';
  }
  function fmt(n) { n = Math.round(+n || 0); return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* THE CONVERSION MOMENT. Only for a player who is not yet a franchise, and
     only after real engagement (store.engaged): one sentence with the real
     numbers, one button. The numbers come from the published table over the
     envelope; the server decides what it can verify at import. */
  function conversionCard(placement) {
    if (!FR || !ST) return '';
    var st = FR.state(), href = '/games/franchise/?intent=' + encodeURIComponent(placement || 'games');
    if (st === 'not_deployed') return '';
    /* a franchise that lives on this device alone: the ask is to keep it */
    if (st === 'franchise') {
      if (FR.owner() !== 'device') return '';
      var snap = FR.snapshot(), f = snap && snap.franchise;
      return '<div class="card conv" data-conv="' + esc(placement || '') + '">'
        + '<div class="eyebrow">Save your franchise</div>'
        + '<div class="conv-t">The <b>' + esc(f ? f.city + ' ' + f.name : 'franchise') + '</b> live on this device only. An email and a password keeps them on every phone.</div>'
        + saveCard(placement)
        + '</div>';
    }
    /* no franchise yet: found one — no account needed */
    var pv = FR.preview(ST.read()), w = pv.week, a = pv.all;
    var use = w.games > 0 ? w : a, scope = w.games > 0 ? 'this week' : 'so far';
    var line = use.games > 0
      ? 'You have earned <b>' + fmt(use.xp) + ' XP</b>' + (use.sp ? ' and <b>' + fmt(use.sp) + ' Scouting Points</b>' : '') + ' ' + scope + '. Found your franchise to keep them.'
      : 'Every Price It, card and drill you play builds a franchise.';
    return '<div class="card conv" data-conv="' + esc(placement || '') + '">'
      + '<div class="eyebrow">Your franchise</div>'
      + '<div class="conv-t">' + line + '</div>'
      + '<p>One fictional football franchise, yours for good: a roster generated for you, a record, a history. No account needed to start; the games you already play are how it improves.</p>'
      + '<div class="btn-row"><a class="btn btn-go" href="' + esc(href) + '" data-conv-go>Found my franchise</a></div>'
      + '<div class="ftp" style="margin-top:10px">Free to play · No purchase necessary · Nothing in the franchise can be bought.</div>'
      + '</div>';
  }
  function wireConversion(onSaved) {
    var d = root.document, host = d.querySelector('[data-conv]');
    wireSaveCard(onSaved);
    if (!host) return;
    var go = host.querySelector('[data-conv-go]');
    if (go) go.addEventListener('click', function () {
      track('signup_start_from_games', { placement: host.getAttribute('data-conv') || '', game_type: 'franchise' });
    });
  }

  /* SAVE IT, IN ONE STEP. One form: email, password, the 21+/Terms line,
     one button. It creates the EdgeDesk account or signs into the one that
     already has that email — the SAME account the research terminal and a
     subscription use, so a player who later wants the research is already
     signed in and only has to pay — and the device's franchise is claimed
     into it (EDFranchise.boot). Rendered wherever a device-owned franchise
     is on screen; wired by wireSaveCard. */
  function saveCard(placement, opts) {
    opts = opts || {};
    if (!AU || !FR) return '';
    return '<form class="save-form" data-save="' + esc(placement || '') + '" novalidate>'
      + (opts.title ? '<div class="save-t">' + esc(opts.title) + '</div>' : '')
      + '<div class="save-row">'
      + '<input type="email" name="email" autocomplete="email" inputmode="email" placeholder="Email" aria-label="Email" required>'
      + '<input type="password" name="password" autocomplete="new-password" placeholder="Password (6+)" aria-label="Password" minlength="6" required>'
      + '</div>'
      + '<label class="consent"><input type="checkbox" name="consent"><span>I am 21 or older and agree to the '
      + '<a href="/terms.html" target="_blank" rel="noopener">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>'
      + '<div class="msg" data-save-msg aria-live="polite"></div>'
      + '<div class="btn-row"><button class="btn btn-go btn-big" type="submit">' + esc(opts.cta || 'Save my franchise') + '</button></div>'
      + '<div class="ftp save-ftp">One EdgeDesk account for everything — the games, the research terminal, a subscription if you ever want one. '
      + 'Already have one? Use it here: same email, same password. '
      + '<button type="button" class="linkish" data-save-forgot>Forgot password?</button></div>'
      + '</form>';
  }
  function wireSaveCard(onSaved) {
    var d = root.document;
    Array.prototype.forEach.call(d.querySelectorAll('form[data-save]'), function (form) {
      if (form.getAttribute('data-wired')) return;
      form.setAttribute('data-wired', '1');
      var placement = form.getAttribute('data-save') || '';
      var msgEl = form.querySelector('[data-save-msg]');
      function msg(t, ok) { if (msgEl) { msgEl.className = 'msg' + (ok ? ' ok' : ''); msgEl.textContent = t || ''; } }
      var forgot = form.querySelector('[data-save-forgot]');
      if (forgot) forgot.addEventListener('click', function () {
        var email = form.elements.email.value.trim();
        if (!email) { msg('Enter your email first, then tap Forgot password.'); return; }
        AU.recover(email).then(function (r) { msg(r.ok ? 'Reset email sent to ' + email + '.' : (r.message || 'Could not send the reset email.'), r.ok); });
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = form.elements.email.value.trim(), pass = form.elements.password.value, consent = !!form.elements.consent.checked;
        var btn = form.querySelector('button[type=submit]'), old = btn.textContent;
        if (!email || !pass) { msg('Enter your email and a password.'); return; }
        if (pass.length < 6) { msg('Choose a password of at least 6 characters.'); return; }
        if (!consent) { msg('Please confirm you are 21+ and agree to the Terms to continue.'); return; }
        track('signup_start_from_games', { placement: placement, game_type: 'franchise' });
        btn.disabled = true; btn.textContent = '…'; msg('');
        AU.save(email, pass, consent).then(function (r) {
          if (!r.ok) { msg(r.message || 'Something went wrong.'); btn.disabled = false; btn.textContent = old; return; }
          if (r.confirm) {
            track('franchise_signup', { confirm: true, placement: placement });
            msg('Account created. Confirm your email (' + email + '), then come back — your franchise is saved the moment you sign in.', true);
            btn.disabled = false; btn.textContent = old; return;
          }
          track(r.mode === 'signin' ? 'franchise_signin' : 'franchise_signup', { placement: placement });
          track('signup_complete_from_games', { game_type: 'franchise', placement: placement, mode: r.mode });
          return FR.boot().then(function (b) {
            paintFranchise();
            var snap = FR.snapshot(), name = snap && snap.franchise ? snap.franchise.city + ' ' + snap.franchise.name : 'Your franchise';
            if (b && b.claimed) { track('franchise_claimed', { placement: placement }); toast('Saved — the ' + name + ' are on your account'); }
            else toast('Signed in');
            form.innerHTML = '<div class="msg ok">' + esc(name) + ' — saved to ' + esc(email) + '. Same account for the research terminal, whenever you want it.</div>';
            notifyFranchise(b);
            if (typeof onSaved === 'function') onSaved(b, r);
          });
        });
      });
    });
  }

  var API = {
    ART: ART, TERMINAL: TERMINAL, FUNNEL: FUNNEL,
    SPREAD_RANGE: SPREAD_RANGE, SPREAD_STEP: SPREAD_STEP,
    track: track, withAttribution: withAttribution, initAttribution: initAttribution,
    artifact: artifact, config: config, researchUrl: researchUrl, openResearch: openResearch,
    pts: pts, line: line, kickoffLabel: kickoffLabel, esc: esc,
    shareText: shareText, shareUrl: shareUrl, share: share,
    toast: toast, header: header, footer: footer, mount: mount, boot: boot,
    pulse: pulse, summaryNow: summaryNow, chip: chip, moment: moment,
    PRO_AFTER_OPENS: PRO_AFTER_OPENS, proDue: proDue, proMoment: proMoment, wireProMoment: wireProMoment,
    ROOMS: ROOMS, tabs: tabs, franchiseReady: franchiseReady, paintFranchise: paintFranchise,
    rewardPanel: rewardPanel, rewardChips: rewardChips, conversionCard: conversionCard, wireConversion: wireConversion,
    saveCard: saveCard, wireSaveCard: wireSaveCard
  };
  root.EDGames = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
