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
  var W = root.EDGamesWeek, ST = root.EDGamesStore,
      CH = root.EDGamesChallenge, SC = root.EDGamesScoring,
      RS = root.EDGamesResearchState, AT = root.EDGamesAttribution;

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
    'signup_from_h2h', 'signup_from_group', 'subscription_from_games'];

  function track(event, props) {
    var p = props || {}, k;
    p.sport = p.sport || 'americanfootball_ncaaf';
    p.surface = 'games';
    p.identity = 'anonymous';        /* games are anonymous-first; an account
                                        layer flips this when one exists */
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
    return withAttribution(TERMINAL, q) + frag;
  }

  function openResearch(ch, where) {
    track('research_cta_click', {
      game_id: ch && ch.game_id, game_slug: ch && ch.slug, game_type: 'price_it',
      research_state: ch && ch.research_state, placement: where || 'reveal'
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
      + '<a href="/games/price-it/"' + (current === 'price-it' ? ' aria-current="page"' : '') + '>Price It</a>'
      + '<a href="/games/h2h/"' + (current === 'h2h' ? ' aria-current="page"' : '') + '>H2H</a>'
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
      + '<a href="/games/">Games home</a><a href="/games/pick-5/">Pick 5</a>'
      + '<a href="/games/groups/">Groups</a>'
      + '<a href="' + esc(withAttribution(TERMINAL)) + '">The terminal</a>'
      + '<a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a>'
      + '<a href="/disclaimer.html">Disclaimer</a>'
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
  function boot(page) {
    initAttribution();
    mount(page);
    track('games_page_view', { page: page });
    return config();
  }

  var API = {
    ART: ART, TERMINAL: TERMINAL, FUNNEL: FUNNEL,
    track: track, withAttribution: withAttribution, initAttribution: initAttribution,
    artifact: artifact, config: config, researchUrl: researchUrl, openResearch: openResearch,
    pts: pts, line: line, kickoffLabel: kickoffLabel, esc: esc,
    shareText: shareText, shareUrl: shareUrl, share: share,
    toast: toast, header: header, footer: footer, mount: mount, boot: boot
  };
  root.EDGames = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
