/* ===========================================================================
   EdgeDesk GAMES — the daily slate: what is being played, on the reader's own
   calendar day, in every sport EdgeDesk lists. docs/games/README.md

   WHY IT EXISTS
     Every sport already had a board of its own (football/home/schedule.json,
     hockey/slate.json, the baseball card, basketball/ and soccer/ slates, the
     UFC fight center), each with its own window, its own time zone habits and
     its own idea of "today". None of them answered the first question a reader
     opens the site with: what is on today, and where is the research? This file
     is the one place that answers it, for the dashboard strip, the full games
     page and the public /today/ page alike.

   THE RULES
     1. "Today" is the reader's calendar day in the reader's time zone (the
        browser's, else America/Chicago). Day boundaries are computed, never
        assumed to be 24 hours: a daylight-saving day is 23 or 25 hours, and a
        zone whose clocks jump at midnight starts its day at the first instant
        that exists.
     2. Every instant is held in UTC and displayed in the reader's zone, with
        the zone named.
     3. A game appears under a date only if it starts on that local date. A
        later game is never put under "Today"; when a sport has nothing on the
        selected day, its next games are offered under a separate, labelled
        "Upcoming" list.
     4. Nothing is invented. A missing price is "Odds unavailable", a missing
        research page is "Research not available yet", a score is shown only
        when the feed carries one, and a signal only when the existing
        validation passed (lib/edgedesk_readiness.js decides, not this file).
     5. One event, one id: <sport>:<provider>:<provider event id>. A
        doubleheader is two events with two ids; the same event read twice
        (two scoreboard days, two refreshes) is one.

   Browser: window.EDGames. Node: require('./edgedesk_games.js'). ES5 apart
   from Intl (present in every supported browser and in Node).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDGames = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var G = { VERSION: 'edgedesk_games/1', SCHEMA: 'edgedesk_slate/1' };
  var MIN = 60000, H = 3600000, D = 86400000;

  G.CONFIG = {
    default_zone: 'America/Chicago',
    /* how far ahead "Upcoming" looks for a sport with nothing on the day */
    upcoming_days: 14,
    upcoming_max: 6,
    /* freshness limits, minutes: past these the data is labelled stale */
    stale_schedule_min: 6 * 60,
    stale_live_min: 10,
    /* a captured price older than this is not shown as current: the public
       board's own "stale" line (lib/edgedesk_home.js AGE.stale) */
    market_limit_min: 90,
    /* a game the feed still calls live this long after its start is overdue */
    live_overdue_h: 7
  };

  /* ================================================================ SPORTS
     The sports the slate lists, in pill order. `espn` is the public scoreboard
     path the schedule adapter reads (tools/games/providers/espn.js); `groups`
     narrows a college scoreboard to its division (80 = FBS, 50 = Division I),
     without which ESPN returns only its featured games. `odds` are The Odds API
     sport keys capture stores prices under. `research` is the Research shell
     module that holds the sport's game research (null: none yet).
     Market words follow each sport's own convention: a hockey spread is the
     puck line, a baseball spread the run line, and a soccer moneyline is the
     three-way 1X2 with the draw priced. */
  G.SPORTS = [
    { id: 'nfl', label: 'NFL', name: 'NFL', espn: [{ path: 'football/nfl', league: 'NFL' }],
      odds: ['americanfootball_nfl'], research: 'football', spread: 'Spread', total: 'Total', draw: false, unit: 'points' },
    { id: 'cfb', label: 'CFB', name: 'College Football', espn: [{ path: 'football/college-football', groups: '80', league: 'FBS' }],
      odds: ['americanfootball_ncaaf'], research: 'football', spread: 'Spread', total: 'Total', draw: false, unit: 'points' },
    { id: 'nba', label: 'NBA', name: 'NBA', espn: [{ path: 'basketball/nba', league: 'NBA' }],
      odds: ['basketball_nba'], research: null, spread: 'Spread', total: 'Total', draw: false, unit: 'points' },
    { id: 'ncaam', label: 'NCAAB', name: 'College Basketball', espn: [{ path: 'basketball/mens-college-basketball', groups: '50', league: 'NCAAM' }],
      odds: ['basketball_ncaab'], research: null, spread: 'Spread', total: 'Total', draw: false, unit: 'points' },
    { id: 'nhl', label: 'NHL', name: 'NHL', espn: [{ path: 'hockey/nhl', league: 'NHL' }],
      odds: ['icehockey_nhl'], research: 'nhl', spread: 'Puck line', total: 'Total', draw: false, unit: 'goals' },
    { id: 'mlb', label: 'MLB', name: 'MLB', espn: [{ path: 'baseball/mlb', league: 'MLB' }],
      odds: ['baseball_mlb'], research: 'baseball', spread: 'Run line', total: 'Total', draw: false, unit: 'runs' },
    { id: 'ncaabase', label: 'NCAA Baseball', name: 'College Baseball', espn: [{ path: 'baseball/college-baseball', league: 'NCAA' }],
      odds: ['baseball_ncaa'], research: 'baseball', spread: 'Run line', total: 'Total', draw: false, unit: 'runs' },
    { id: 'soccer', label: 'Soccer', name: 'Soccer', espn: [
      { path: 'soccer/eng.1', league: 'Premier League', odds: 'soccer_epl', model: 'epl' },
      { path: 'soccer/esp.1', league: 'La Liga', odds: 'soccer_spain_la_liga', model: 'laliga' },
      { path: 'soccer/ger.1', league: 'Bundesliga', odds: 'soccer_germany_bundesliga', model: 'bundesliga' },
      { path: 'soccer/ita.1', league: 'Serie A', odds: 'soccer_italy_serie_a', model: 'seriea' },
      { path: 'soccer/fra.1', league: 'Ligue 1', odds: 'soccer_france_ligue_one', model: 'ligue1' },
      { path: 'soccer/usa.1', league: 'MLS', odds: 'soccer_usa_mls' },
      { path: 'soccer/uefa.champions', league: 'Champions League', odds: 'soccer_uefa_champs_league' },
      { path: 'soccer/uefa.europa', league: 'Europa League', odds: 'soccer_uefa_europa_league' }],
      odds: ['soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_usa_mls', 'soccer_uefa_champs_league', 'soccer_uefa_europa_league'],
      research: null, spread: 'Handicap', total: 'Total', draw: true, unit: 'goals' },
    { id: 'mma', label: 'UFC/MMA', name: 'UFC / MMA', espn: [{ path: 'mma/ufc', league: 'UFC' }],
      odds: ['mma_mixed_martial_arts'], research: 'ufc', spread: null, total: null, draw: false, unit: null, card: true }
  ];
  var BY_ID = {};
  G.SPORTS.forEach(function (s) { BY_ID[s.id] = s; });
  G.sport = function (id) { return BY_ID[String(id || '')] || null; };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function num(v) { if (!present(v)) return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toMs(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (!present(v)) return null;
    var s = String(v).trim();
    /* an instant without a zone is ambiguous and refused (lib/edgedesk_schedule.js rule 2) */
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
    var t = Date.parse(s);
    return isFinite(t) ? t : null;
  }
  G.toMs = toMs;

  /* ============================================================ TIME ZONES */
  var fmtCache = {};
  function wall(ms, zone) {
    var f = fmtCache[zone];
    if (!f) f = fmtCache[zone] = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: o.weekday };
  }
  G.validZone = function (zone) {
    if (!present(zone)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(zone) }).format(0); return true; } catch (_) { return false; }
  };
  /* The zone the slate is read in: an explicit preference, else the browser's,
     else America/Chicago. `source` says which, so the page can say so. */
  G.resolveZone = function (pref, browserZone) {
    if (G.validZone(pref)) return { zone: String(pref), source: 'preference' };
    var b = browserZone;
    if (b === undefined) { try { b = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { b = null; } }
    if (G.validZone(b)) return { zone: String(b), source: 'browser' };
    return { zone: G.CONFIG.default_zone, source: 'fallback' };
  };
  /* "YYYY-MM-DD" of an instant on the zone's calendar */
  G.dateKey = function (ms, zone) {
    var p = wall(ms, zone);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d);
  };
  G.isDateKey = function (k) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(k));
    if (!m) return false;
    var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
  };
  /* calendar arithmetic on a date key, independent of any zone */
  G.addDays = function (key, n) {
    var p = str(key).split('-').map(Number);
    var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + (n || 0), 12));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  };
  /* The first instant of a local date. Not "UTC midnight minus the offset":
     the offset itself changes on daylight-saving days, and some zones jump
     over midnight. The local date is non-decreasing in time, so the boundary
     is found by bisection to the minute between −16 h and +16 h of UTC
     midnight (every real offset lies inside ±14 h). */
  function dayStart(key, zone) {
    var p = key.split('-').map(Number);
    var base = Date.UTC(p[0], p[1] - 1, p[2]);
    var lo = base - 16 * H, hi = base + 16 * H;
    while (hi - lo > MIN) {
      var mid = Math.floor((lo + hi) / 2 / MIN) * MIN;
      if (mid <= lo) mid = lo + MIN;
      if (G.dateKey(mid, zone) >= key) hi = mid; else lo = mid;
    }
    return hi;
  }
  /* [from, to) of a local date, and its length in hours (23, 24, 25, 23.5 …) */
  G.dayBounds = function (key, zone) {
    var from = dayStart(key, zone), to = dayStart(G.addDays(key, 1), zone);
    return { date: key, zone: zone, from: from, to: to, hours: (to - from) / H };
  };
  G.today = function (now, zone) { return G.dateKey(now == null ? Date.now() : now, zone); };
  /* milliseconds until the reader's next local midnight (for the auto-advance timer) */
  G.msUntilNextDay = function (now, zone) {
    now = now == null ? Date.now() : now;
    return Math.max(1000, G.dayBounds(G.dateKey(now, zone), zone).to - now);
  };
  function zoneAbbr(ms, zone) {
    try {
      var p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
      for (var i = 0; i < p.length; i++) if (p[i].type === 'timeZoneName') return p[i].value;
    } catch (_) { /* unknown zone */ }
    return zone;
  }
  G.zoneAbbr = zoneAbbr;
  /* "Times in CDT (America/Chicago)" */
  G.zoneText = function (zone, ms) {
    var a = zoneAbbr(ms == null ? Date.now() : ms, zone);
    return a === zone ? zone : a + ' (' + zone.replace(/_/g, ' ') + ')';
  };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function keyParts(key) { var p = str(key).split('-').map(Number); return { y: p[0], mo: p[1], d: p[2], wd: new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay() }; }
  /* "Tue, Oct 13" */
  G.dateText = function (key, long) {
    var p = keyParts(key);
    return (long ? WDL[p.wd] : WD[p.wd]) + ', ' + MON[p.mo - 1] + ' ' + p.d;
  };
  /* "Today" / "Yesterday" / "Tomorrow" / "Thu, Oct 15" relative to the reader's today */
  G.relDay = function (key, todayKey) {
    if (key === todayKey) return 'Today';
    if (key === G.addDays(todayKey, -1)) return 'Yesterday';
    if (key === G.addDays(todayKey, 1)) return 'Tomorrow';
    return G.dateText(key);
  };
  /* "7:00 PM" and its zone abbreviation */
  G.clock = function (ms, zone) {
    var p = wall(ms, zone), h12 = (p.h % 12) || 12;
    return h12 + ':' + pad(p.mi) + ' ' + (p.h < 12 ? 'AM' : 'PM');
  };
  G.timeText = function (ms, zone) { return G.clock(ms, zone) + ' ' + zoneAbbr(ms, zone); };
  /* a capture or build time: "Oct 13, 6:05 AM CDT" */
  G.stampText = function (t, zone) {
    var ms = typeof t === 'number' ? t : toMs(t);
    if (ms == null) return 'time unknown';
    var p = wall(ms, zone);
    return MON[p.mo - 1] + ' ' + p.d + ', ' + G.clock(ms, zone) + ' ' + zoneAbbr(ms, zone);
  };
  G.ageText = function (t, now) {
    var ms = typeof t === 'number' ? t : toMs(t);
    if (ms == null) return null;
    var m = Math.max(0, Math.round(((now == null ? Date.now() : now) - ms) / MIN));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  };

  /* ================================================================ STATUS
     One vocabulary across providers. `order` is the slate's sort rank: live
     games first, then upcoming by start time, then finished ones, then the
     games that will not be played as scheduled. */
  G.STATUS = {
    LIVE: { key: 'LIVE', label: 'Live', order: 0 },
    /* past its start, and no feed has said what happened since: never shown
       as Live, never given a score (see effective()) */
    STARTED: { key: 'STARTED', label: 'Started', order: 0 },
    DELAYED: { key: 'DELAYED', label: 'Delayed', order: 1 },
    SCHEDULED: { key: 'SCHEDULED', label: 'Scheduled', order: 1 },
    FINAL: { key: 'FINAL', label: 'Final', order: 2 },
    SUSPENDED: { key: 'SUSPENDED', label: 'Suspended', order: 3 },
    POSTPONED: { key: 'POSTPONED', label: 'Postponed', order: 3 },
    CANCELED: { key: 'CANCELED', label: 'Canceled', order: 3 }
  };
  G.STATUS_FILTERS = [
    { id: 'all', label: 'All' }, { id: 'live', label: 'Live' }, { id: 'upcoming', label: 'Upcoming' },
    { id: 'final', label: 'Final' }, { id: 'off', label: 'Postponed / canceled' }];
  function statusGroup(st) {
    if (st === 'LIVE' || st === 'STARTED') return 'live';
    if (st === 'SCHEDULED' || st === 'DELAYED') return 'upcoming';
    if (st === 'FINAL') return 'final';
    return 'off';
  }
  G.statusGroup = statusGroup;
  /* ESPN's status block → { status, detail, period, clock }. The provider's
     type name decides; its state ('pre' | 'in' | 'post') is the fallback. A
     game the provider has not started is never inferred live from the clock:
     the slate shows what the feed says, and the age of what it says. */
  G.statusFromEspn = function (st) {
    st = st || {};
    var t = st.type || {};
    var name = str(t.name).toUpperCase(), state = str(t.state).toLowerCase();
    var s;
    if (/CANCEL|ABANDON/.test(name)) s = 'CANCELED';
    else if (/POSTPONE/.test(name)) s = 'POSTPONED';
    else if (/SUSPEND/.test(name)) s = 'SUSPENDED';
    else if (/FORFEIT/.test(name)) s = 'FINAL';
    else if (/DELAY/.test(name)) s = state === 'in' ? 'LIVE' : 'DELAYED';
    else if (t.completed === true || /FINAL|FULL_TIME|^STATUS_END$/.test(name) || state === 'post') s = 'FINAL';
    else if (state === 'in' || /IN_PROGRESS|HALFTIME|END_PERIOD|OVERTIME|SHOOTOUT|FIRST_HALF|SECOND_HALF|EXTRA_TIME|PENALT/.test(name)) s = 'LIVE';
    else s = 'SCHEDULED';
    var detail = str(t.shortDetail || t.detail || t.description) || null;
    return { status: s, detail: detail, period: num(st.period), clock: present(st.displayClock) ? String(st.displayClock) : null, provider_status: name || null };
  };
  /* What the slate may say about a game NOW, from what its feed last said.
     A game the feed still calls scheduled after its start is "Started" with
     no score — the feed has not spoken since, and the page says when it last
     did. A live read older than the live freshness limit stays Live but is
     marked stale with its age. Returns a shallow copy; the event is untouched. */
  G.effective = function (e, now) {
    if (!e) return e;
    now = now == null ? Date.now() : now;
    var out = {}, k;
    for (k in e) if (Object.prototype.hasOwnProperty.call(e, k)) out[k] = e[k];
    var start = toMs(e.start_utc), upd = toMs(e.updated_at);
    out.feed_status = e.status;
    if (e.status === 'SCHEDULED' && !e.time_tbd && start != null && now >= start + 2 * MIN) {
      out.status = 'STARTED';
      out.status_detail = upd != null && upd < start ? 'No live update since ' + G.ageText(upd, now) : 'Started';
      out.status_stale = true;
    } else if (e.status === 'LIVE' && upd != null && now - upd > G.CONFIG.stale_live_min * MIN) {
      out.status_stale = true;
    } else out.status_stale = false;
    if (out.status === 'LIVE' && start != null && now - start > G.CONFIG.live_overdue_h * H && out.status_stale) out.result_overdue = true;
    return out;
  };

  /* ========================================================== NORMALIZING */
  function logoOf(team) {
    if (!team) return null;
    if (present(team.logo) && /^https:\/\//.test(team.logo)) return String(team.logo);
    var l = team.logos && team.logos[0] && team.logos[0].href;
    return present(l) && /^https:\/\//.test(l) ? String(l) : null;
  }
  function side(c, isAthlete) {
    c = c || {};
    var t = isAthlete ? (c.athlete || {}) : (c.team || {});
    var rec = c.records && c.records[0] && c.records[0].summary;
    var score = present(c.score) && isFinite(Number(typeof c.score === 'object' ? c.score.value : c.score)) ? Number(typeof c.score === 'object' ? c.score.value : c.score) : null;
    var name = str(t.displayName || t.fullName || t.name) || null;
    return {
      id: present(t.id) ? String(t.id) : (present(c.id) ? String(c.id) : null),
      name: name,
      short: str(t.shortDisplayName || t.shortName || t.location || name) || null,
      abbr: str(t.abbreviation) || null,
      logo: isAthlete ? null : logoOf(t),
      score: score,
      record: present(rec) ? String(rec) : null,
      winner: c.winner === true ? true : null,
      rank: c.curatedRank && num(c.curatedRank.current) != null && num(c.curatedRank.current) < 99 ? num(c.curatedRank.current) : null
    };
  }
  /* The headline bout of a card: the one whose fighters the event is named
     after, else the last bout listed (ESPN lists a card in running order). */
  function mainBout(ev) {
    var comps = ev.competitions || [];
    if (!comps.length) return null;
    var nm = str(ev.shortName || ev.name).toLowerCase();
    for (var i = comps.length - 1; i >= 0; i--) {
      var cs = comps[i].competitors || [];
      if (cs.length === 2 && cs.every(function (c) {
        var a = c.athlete || {}, last = str(a.shortName || a.displayName).split(' ').pop().toLowerCase();
        return last && nm.indexOf(last) >= 0;
      })) return comps[i];
    }
    return comps[comps.length - 1];
  }
  /* One ESPN scoreboard event → one slate event (or null with no usable
     teams / start). `src` = { sport, league, fetched_at }. */
  G.fromEspn = function (ev, src) {
    if (!ev || !present(ev.id)) return null;
    var sp = G.sport(src && src.sport);
    if (!sp) return null;
    var card = !!sp.card;
    var comp = card ? mainBout(ev) : (ev.competitions || [])[0];
    if (!comp) return null;
    var cs = comp.competitors || [];
    var home, away;
    if (card) {
      var a = cs.filter(function (c) { return num(c.order) === 1; })[0] || cs[0];
      var b = cs.filter(function (c) { return num(c.order) === 2; })[0] || cs[1];
      away = side(a, true); home = side(b, true);
    } else {
      var h = cs.filter(function (c) { return c.homeAway === 'home'; })[0];
      var w = cs.filter(function (c) { return c.homeAway === 'away'; })[0];
      if (!h || !w) { h = cs[0]; w = cs[1]; }
      home = side(h, false); away = side(w, false);
    }
    if (!home.name || !away.name) return null;
    var startMs = toMs(comp.date || ev.date) != null ? toMs(comp.date || ev.date) : toMs(ev.date);
    /* ESPN's "HH:MMZ" lacks seconds; Date.parse reads it, toMs needs the zone, which it has */
    if (startMs == null) return null;
    var st = G.statusFromEspn((card ? ev.status : comp.status) || ev.status);
    var venue = comp.venue || {};
    var addr = venue.address || {};
    var notes = (comp.notes || []).map(function (n) { return str(n && n.headline); }).filter(Boolean);
    var gn = null;
    notes.forEach(function (n) { var m = /\bgame\s*(\d)\b/i.exec(n); if (m && /double|header|game\s*[12]\b/i.test(n)) gn = gn || Number(m[1]); });
    var out = {
      id: sp.id + ':espn:' + String(ev.id),
      sport: sp.id,
      league: (src && src.league) || sp.name,
      provider: 'espn',
      provider_id: String(ev.id),
      start_utc: new Date(startMs).toISOString(),
      time_tbd: comp.timeValid === false || ev.timeValid === false,
      status: st.status,
      status_detail: st.detail,
      period: st.period,
      clock: st.clock,
      home: home,
      away: away,
      neutral: comp.neutralSite === true,
      venue: str(venue.fullName) || null,
      city: [addr.city, addr.state || addr.country].filter(present).join(', ') || null,
      notes: notes.length ? notes : null,
      game_number: gn,
      title: card ? (str(ev.name) || null) : null,
      bouts: card ? (ev.competitions || []).length : null,
      season: ev.season && num(ev.season.year) != null ? num(ev.season.year) : null,
      week: ev.week && num(ev.week.number) != null ? num(ev.week.number) : null,
      updated_at: (src && src.fetched_at) || null
    };
    /* a final with no scores on the wire keeps its status and shows no score */
    if (out.status !== 'LIVE' && out.status !== 'FINAL' && out.status !== 'SUSPENDED') { out.home.score = null; out.away.score = null; }
    return out;
  };

  /* ============================================================== DEDUPING
     The same event read twice (two scoreboard days, an older snapshot and a
     newer live read) is one event: the newest read wins, field by field only
     where the newer read is silent. */
  function newer(a, b) {
    var ta = toMs(a.updated_at), tb = toMs(b.updated_at);
    if (ta == null) return b; if (tb == null) return a;
    return tb >= ta ? b : a;
  }
  G.dedupe = function (events) {
    var by = {}, order = [];
    (events || []).forEach(function (e) {
      if (!e || !e.id) return;
      if (!by[e.id]) { by[e.id] = e; order.push(e.id); return; }
      var keep = newer(by[e.id], e), drop = keep === e ? by[e.id] : e;
      var merged = {};
      Object.keys(drop).forEach(function (k) { merged[k] = drop[k]; });
      Object.keys(keep).forEach(function (k) { if (present(keep[k]) || !present(merged[k])) merged[k] = keep[k]; });
      by[e.id] = merged;
    });
    return order.map(function (id) { return by[id]; });
  };

  /* ===================================================== TEAM IDENTITY
     Matching one source's game to another's (a schedule event to a research
     artifact, a snapshot to a live read) is by both sides and the start time,
     never by one name alone. Names are compared after removing accents,
     punctuation and the club-form words soccer sources add ("FC", "AFC",
     "Calcio" …); a code match counts only through ALIAS, which maps the codes
     two sources spell differently for the same club. */
  var CLUB_WORDS = /\b(fc|afc|cf|sc|ac|ssc|as|us|rc|rcd|ud|cd|sd|ca|bc|vfb|vfl|tsg|sv|fsv|calcio|club|de|the|1)\b/g;
  G.normName = function (s) {
    var t = str(s).toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(CLUB_WORDS, ' ').replace(/\s+/g, ' ').trim();
  };
  /* codes two sources spell differently for the same club: ESPN ↔ the source */
  G.ALIAS = {
    nhl: { NJ: 'NJD', TB: 'TBL', LA: 'LAK', SJ: 'SJS', UTAH: 'UTA', MON: 'MTL', WAS: 'WSH' },
    nfl: { WSH: 'WAS', LAR: 'LA' }
  };
  function code(sport, c) {
    var u = str(c).toUpperCase();
    var a = G.ALIAS[sport] || {};
    return a[u] || u;
  }
  G.sameSide = function (sport, a, b) {
    if (!a || !b) return false;
    if (a.abbr && b.abbr && code(sport, a.abbr) === code(sport, b.abbr)) return true;
    var x = G.normName(a.name), y = G.normName(b.name);
    if (!x || !y) return false;
    if (x === y) return true;
    var xs = x.split(' '), ys = y.split(' ');
    var short = xs.length <= ys.length ? xs : ys, long = xs.length <= ys.length ? y : x;
    /* "Brentford" vs "Brentford" after club words; "Middle Tennessee" inside
       "Middle Tennessee Blue Raiders" — every word of the shorter, as words */
    return short.join('').length >= 4 && short.every(function (w) { return (' ' + long + ' ').indexOf(' ' + w + ' ') >= 0; });
  };
  /* the same game from two sources: same sport, both sides (either
     orientation, a neutral-site listing can flip), starts within `hours` */
  G.sameEvent = function (a, b, hours) {
    if (!a || !b || a.sport !== b.sport) return false;
    var ta = toMs(a.start_utc), tb = toMs(b.start_utc);
    if (ta == null || tb == null || Math.abs(ta - tb) > (hours || 6) * H) return false;
    return (G.sameSide(a.sport, a.home, b.home) && G.sameSide(a.sport, a.away, b.away))
      || (G.sameSide(a.sport, a.home, b.away) && G.sameSide(a.sport, a.away, b.home));
  };

  /* ===================================================== LIVE OVERLAY
     The snapshot (today/slate.json) is the baseline; a live read is laid over
     it. Within every (sport, US-Eastern day) the live read covered
     successfully it is the truth: its events replace the snapshot's, a game
     it no longer lists for that day has moved or been dropped by the source
     and leaves the day. Days and sports it did not cover keep the snapshot,
     with the snapshot's own age. */
  G.etDay = function (ms) { return G.dateKey(ms, 'America/New_York'); };
  G.overlay = function (base, live, covered) {
    var cov = {};
    (covered || []).forEach(function (c) { cov[c.sport + '|' + c.day] = true; });
    /* an event remembers the scoreboard day it was read from (sb_day): a
       10:30 PM Pacific game sits on the previous Eastern day's scoreboard */
    var out = (base || []).filter(function (e) {
      var t = toMs(e.start_utc);
      var d = e.sb_day || (t != null ? G.etDay(t) : null);
      return !(d && cov[e.sport + '|' + d]);
    });
    return G.dedupe(out.concat(live || []));
  };

  /* ========================================================== DOUBLEHEADERS
     Two games between the same teams on the same local date are a
     doubleheader: each keeps its own id and is labelled Game 1 / Game 2 by
     start time (the provider's own "Game 2" note wins when it has one). */
  G.markDoubleheaders = function (events, zone) {
    var groups = {};
    (events || []).forEach(function (e) {
      if (!e || !e.home || !e.away) return;
      var pair = [str(e.home.id || e.home.name), str(e.away.id || e.away.name)].sort().join('|');
      var k = e.sport + '|' + pair + '|' + G.dateKey(toMs(e.start_utc), zone);
      (groups[k] = groups[k] || []).push(e);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.length < 2) return;
      /* a provider's own game number is kept; the games without one take the
         numbers left over, in start order (one game noted "Game 2" makes
         the other Game 1, never a second Game 2) */
      g.sort(function (a, b) { return toMs(a.start_utc) - toMs(b.start_utc) || (a.id < b.id ? -1 : 1); });
      var used = {}, next = 1;
      g.forEach(function (e) { if (e.game_number) used[e.game_number] = true; });
      g.forEach(function (e) {
        var n = e.game_number;
        if (!n) { while (used[next]) next++; n = next; used[n] = true; }
        e.doubleheader = { game: n, of: g.length };
      });
    });
    return events;
  };

  /* ============================================================== ORDERING */
  G.compare = function (a, b) {
    var ra = (G.STATUS[a.status] || G.STATUS.SCHEDULED).order, rb = (G.STATUS[b.status] || G.STATUS.SCHEDULED).order;
    if (ra !== rb) return ra - rb;
    var ta = toMs(a.start_utc), tb = toMs(b.start_utc);
    if (ta !== tb) return ta - tb;
    var sa = G.SPORTS.indexOf(G.sport(a.sport)), sb = G.SPORTS.indexOf(G.sport(b.sport));
    if (sa !== sb) return sa - sb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  G.order = function (events) { return (events || []).slice().sort(G.compare); };

  /* ============================================================ SELECTING
     The slate for one local date: every event that starts on it, filtered by
     sport, status and a team / competitor search, in slate order. When the
     date holds nothing for the selected sport (or for a sport with nothing on
     the day, under "All sports"), the next scheduled games are returned
     separately as `upcoming`, never mixed into the day. */
  function norm(s) { return str(s).toLowerCase().normalize ? str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() : str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  G.matchesQuery = function (e, q) {
    var n = norm(q);
    if (!n) return true;
    var hay = norm([e.home && e.home.name, e.home && e.home.short, e.home && e.home.abbr,
      e.away && e.away.name, e.away && e.away.short, e.away && e.away.abbr, e.title, e.league, e.venue].join(' '));
    return n.split(' ').every(function (w) { return hay.indexOf(w) >= 0; });
  };
  G.select = function (events, o) {
    o = o || {};
    var zone = o.zone || G.CONFIG.default_zone;
    var now = o.now == null ? Date.now() : o.now;
    var date = G.isDateKey(o.date) ? o.date : G.today(now, zone);
    var b = G.dayBounds(date, zone);
    var sport = o.sport && o.sport !== 'all' ? o.sport : null;
    var status = o.status && o.status !== 'all' ? o.status : null;
    var all = G.markDoubleheaders(G.dedupe(events).map(function (e) { return G.effective(e, now); }), zone);
    var inSport = all.filter(function (e) { return !sport || e.sport === sport; });
    var day = inSport.filter(function (e) { var t = toMs(e.start_utc); return t != null && t >= b.from && t < b.to; });
    var counts = { all: day.length };
    G.SPORTS.forEach(function (s) { counts[s.id] = 0; });
    all.forEach(function (e) { var t = toMs(e.start_utc); if (t != null && t >= b.from && t < b.to && counts[e.sport] != null) counts[e.sport]++; });
    var byStatus = { live: 0, upcoming: 0, final: 0, off: 0 };
    day.forEach(function (e) { byStatus[statusGroup(e.status)]++; });
    var games = G.order(day.filter(function (e) { return (!status || statusGroup(e.status) === status) && G.matchesQuery(e, o.q); }));
    /* UPCOMING: only for a day in the reader's present or future, only games
       that start after the day ends, and only for sports with nothing on it */
    var upcoming = [];
    var today = G.today(now, zone);
    if (date >= today && !o.q && (!status || status === 'upcoming')) {
      var empty = sport ? (day.length ? [] : [sport]) : G.SPORTS.filter(function (s) { return !counts[s.id]; }).map(function (s) { return s.id; });
      var horizon = b.to + G.CONFIG.upcoming_days * D;
      empty.forEach(function (sid) {
        var next = all.filter(function (e) {
          var t = toMs(e.start_utc);
          return e.sport === sid && t != null && t >= b.to && t < horizon && (e.status === 'SCHEDULED' || e.status === 'DELAYED');
        });
        next = G.order(next).slice(0, sport ? G.CONFIG.upcoming_max : 2);
        if (next.length) upcoming.push({ sport: sid, games: next });
      });
    }
    return { date: date, zone: zone, bounds: b, games: games, counts: counts, by_status: byStatus, upcoming: upcoming, total_day: day.length };
  };

  /* ================================================================ MARKETS
     A market is shown only as captured: a book, a capture time, both sides'
     prices. Formatting never fills a side the capture did not carry. */
  G.american = function (v) {
    var n = num(v);
    if (n == null || (n > -100 && n < 100)) return null;
    n = Math.round(n);
    return (n > 0 ? '+' : '−') + Math.abs(n);
  };
  G.point = function (v, pk) {
    var n = num(v);
    if (n == null) return null;
    if (n === 0) return pk === false ? '0' : 'PK';
    var s = Math.abs(n) % 1 === 0 ? String(Math.abs(n)) : String(Math.abs(n));
    return (n > 0 ? '+' : '−') + s;
  };
  /* market: { book, source, captured_at, moneyline:{home,away,draw},
     spread:{home:{point,price}, away:{point,price}}, total:{point, over, under} }
     → { ok, book, captured_at, age_min, current, cols:[label…], rows:[{side, label, cells:[…]}], note } */
  G.formatMarket = function (event, market, o) {
    o = o || {};
    var sp = G.sport(event && event.sport) || {};
    var now = o.now == null ? Date.now() : o.now;
    var limit = o.limit_min || G.CONFIG.market_limit_min;
    var none = { ok: false, text: 'Odds unavailable', reason: 'no captured price on file for this game' };
    if (!market) return none;
    var cap = toMs(market.captured_at);
    if (cap == null) return { ok: false, text: 'Odds unavailable', reason: 'the captured price carries no capture time, so it cannot be verified' };
    var age = Math.max(0, (now - cap) / MIN);
    var ml = market.moneyline || {}, spd = market.spread || {}, tot = market.total || {};
    var mlH = G.american(ml.home), mlA = G.american(ml.away), mlD = sp.draw ? G.american(ml.draw) : null;
    var hasMl = !!(mlH && mlA) && (!sp.draw || !!mlD);
    var sH = spd.home || {}, sA = spd.away || {};
    var hasSp = !!sp.spread && G.point(sH.point) != null && G.point(sA.point) != null && !!G.american(sH.price) && !!G.american(sA.price);
    var hasTot = !!sp.total && num(tot.point) != null && !!G.american(tot.over) && !!G.american(tot.under);
    if (!hasMl && !hasSp && !hasTot) return { ok: false, text: 'Odds unavailable', reason: 'the capture carried no market with both sides priced' };
    var cols = [];
    if (hasSp) cols.push(sp.spread);
    if (hasMl) cols.push(sp.draw ? '1X2' : 'Moneyline');
    if (hasTot) cols.push(sp.total);
    var tp = num(tot.point);
    function row(key, team, spPart, mlPart, totPart) {
      var cells = [];
      if (hasSp) cells.push(spPart ? spPart : '');
      if (hasMl) cells.push(mlPart || '');
      if (hasTot) cells.push(totPart || '');
      return { side: key, label: team, cells: cells };
    }
    var aName = (event.away && (event.away.abbr || event.away.short || event.away.name)) || 'Away';
    var hName = (event.home && (event.home.abbr || event.home.short || event.home.name)) || 'Home';
    var rows = [
      row('away', aName, hasSp ? G.point(sA.point) + ' ' + G.american(sA.price) : null, mlA, hasTot ? 'O ' + tp + ' ' + G.american(tot.over) : null),
      row('home', hName, hasSp ? G.point(sH.point) + ' ' + G.american(sH.price) : null, mlH, hasTot ? 'U ' + tp + ' ' + G.american(tot.under) : null)
    ];
    if (sp.draw && hasMl) rows.push(row('draw', 'Draw', null, mlD, null));
    var current = age <= limit;
    return {
      ok: true, current: current, stale: !current, book: market.book || null, source: market.source || null,
      captured_at: new Date(cap).toISOString(), age_min: Math.round(age), cols: cols, rows: rows,
      text: (market.book ? market.book : 'Captured price') + ' · ' + (G.ageText(cap, now) || ''),
      note: current ? null : 'Captured ' + G.ageText(cap, now) + ', past the ' + limit + '-minute limit: shown as a past price, not a current one.'
    };
  };

  /* ===================================================== MARKET INTEGRITY
     One check for every source, before a price can reach a card: both sides
     priced, valid American odds, the spread's two numbers opposite, the total
     and the spread inside what the sport plays, the moneyline's overround
     between 0 and 25 % (30 % with a draw). A market that fails is dropped
     whole and the reason kept; it is never repaired. */
  G.RANGES = {
    nfl: { total: [25, 70], spread: 30 }, cfb: { total: [25, 100], spread: 60 },
    nba: { total: [170, 280], spread: 30 }, ncaam: { total: [100, 190], spread: 45 },
    nhl: { total: [3.5, 9], spread: 3 }, mlb: { total: [4.5, 15], spread: 3 },
    ncaabase: { total: [4.5, 25], spread: 6 }, soccer: { total: [0.5, 7], spread: 4 },
    mma: { total: null, spread: null }
  };
  function amOk(v) { var n = num(v); return n != null && Math.abs(n) >= 100 && Math.abs(n) <= 100000 ? Math.round(n) : null; }
  function overround(list) { var s = 0; list.forEach(function (p) { s += 1 / (p > 0 ? 1 + p / 100 : 1 + 100 / Math.abs(p)); }); return s - 1; }
  G.decToAm = function (d) {
    d = num(d);
    if (d == null || d <= 1.0001) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
  };
  /* raw: { moneyline:{home,away,draw}, spread:{home:{point,price}, away:{…}}, total:{point,over,under} }
     → { market: the parts that pass (or null), why: [reasons a part was dropped] } */
  G.cleanMarket = function (sportId, raw) {
    var sp = G.sport(sportId), r = G.RANGES[sportId] || {}, why = [], out = {};
    if (!sp || !raw) return { market: null, why: ['no market'] };
    var ml = raw.moneyline;
    if (ml) {
      var h = amOk(ml.home), a = amOk(ml.away), d = sp.draw ? amOk(ml.draw) : null;
      if (h == null || a == null || (sp.draw && d == null)) why.push('moneyline not priced on every side' + (sp.draw ? ' (the draw included)' : ''));
      else {
        var ov = overround(sp.draw ? [h, a, d] : [h, a]);
        if (ov < 0 || ov > (sp.draw ? 0.3 : 0.25)) why.push('moneyline overround ' + Math.round(ov * 1000) / 10 + '% is outside 0–' + (sp.draw ? 30 : 25) + '%');
        else out.moneyline = sp.draw ? { home: h, away: a, draw: d } : { home: h, away: a };
      }
    }
    var s = raw.spread;
    if (s && sp.spread) {
      var hp = s.home && num(s.home.point), ap = s.away && num(s.away.point);
      var hpr = s.home && amOk(s.home.price), apr = s.away && amOk(s.away.price);
      if (hp == null || ap == null || hpr == null || apr == null) why.push(sp.spread.toLowerCase() + ' not priced on both sides');
      else if (Math.abs(hp + ap) > 1e-9) why.push(sp.spread.toLowerCase() + ' sides are not opposite (' + hp + ' / ' + ap + ')');
      else if (r.spread != null && Math.abs(hp) > r.spread) why.push(sp.spread.toLowerCase() + ' ' + hp + ' is outside what ' + sp.name + ' plays');
      else if (!sp.draw && Math.abs(hp * 2 - Math.round(hp * 2)) > 1e-9) why.push(sp.spread.toLowerCase() + ' is off the half-point grid');
      else out.spread = { home: { point: hp, price: hpr }, away: { point: ap, price: apr } };
    }
    var t = raw.total;
    if (t && sp.total) {
      var tp = num(t.point), o = amOk(t.over), u = amOk(t.under);
      if (tp == null || o == null || u == null) why.push('total not priced on both sides');
      else if (r.total && (tp < r.total[0] || tp > r.total[1])) why.push('total ' + tp + ' is outside what ' + sp.name + ' plays');
      else out.total = { point: tp, over: o, under: u };
    }
    return { market: out.moneyline || out.spread || out.total ? out : null, why: why };
  };

  /* THE SUBSCRIBER'S PRICES: The Odds API events capture stored (slate_markets
     in supabase/games_slate.sql) → { slate event id: market }. One book per
     game, chosen by preference among the US-regulated books, so both sides of
     every number are the same book's at the same update; the capture time is
     the oldest last_update among the markets used. An event is matched to the
     slate by sport, both sides and a start within 12 hours, and only when the
     match is unique. */
  G.BOOK_PREF = ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'espnbet', 'betrivers', 'hardrockbet', 'betonlineag', 'bovada', 'pinnacle'];
  G.fromOddsApi = function (oddsEvents, slate) {
    var out = {};
    (oddsEvents || []).forEach(function (oe) {
      if (!oe) return;
      var sp = null;
      G.SPORTS.forEach(function (s) { if (s.odds.indexOf(oe.sport_key) >= 0) sp = s; });
      if (!sp) return;
      var cand = { sport: sp.id, start_utc: oe.commence_time, home: { name: oe.home_team }, away: { name: oe.away_team } };
      var hits = (slate || []).filter(function (e) { return G.sameEvent(e, cand, 12); });
      if (hits.length !== 1) return;
      var e = hits[0];
      var flip = !(G.sameSide(sp.id, e.home, cand.home) && G.sameSide(sp.id, e.away, cand.away));
      var dec = String(oe.odds_format || 'decimal').toLowerCase() !== 'american';
      function px(v) { return dec ? G.decToAm(v) : amOk(v); }
      var books = (oe.bookmakers || []).slice().sort(function (a, b) {
        var ia = G.BOOK_PREF.indexOf(a.key), ib = G.BOOK_PREF.indexOf(b.key);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (var i = 0; i < books.length; i++) {
        var bk = books[i], raw = {}, stamps = [];
        (bk.markets || []).forEach(function (m) {
          var oc = m.outcomes || [];
          function side(name) {
            if (/^draw$/i.test(String(name))) return 'draw';
            var isHome = G.sameSide(sp.id, { name: name }, { name: oe.home_team }), isAway = G.sameSide(sp.id, { name: name }, { name: oe.away_team });
            if (isHome === isAway) return null;
            var s2 = isHome ? 'home' : 'away';
            return flip ? (s2 === 'home' ? 'away' : 'home') : s2;
          }
          if (m.key === 'h2h') {
            var ml = {};
            oc.forEach(function (o) { var s3 = side(o.name); if (s3) ml[s3] = px(o.price); });
            raw.moneyline = ml; stamps.push(m.last_update || bk.last_update);
          } else if (m.key === 'spreads') {
            var spd = {};
            oc.forEach(function (o) { var s3 = side(o.name); if (s3 === 'home' || s3 === 'away') spd[s3] = { point: num(o.point), price: px(o.price) }; });
            raw.spread = spd; stamps.push(m.last_update || bk.last_update);
          } else if (m.key === 'totals') {
            var tt = {};
            oc.forEach(function (o) { if (/^over$/i.test(o.name)) { tt.point = num(o.point); tt.over = px(o.price); } else if (/^under$/i.test(o.name)) { tt.under = px(o.price); if (tt.point != null && num(o.point) !== tt.point) tt.mismatch = true; } });
            if (!tt.mismatch) { raw.total = tt; stamps.push(m.last_update || bk.last_update); }
          }
        });
        var c = G.cleanMarket(sp.id, raw);
        var times = stamps.map(toMs).filter(function (x) { return x != null; });
        if (!c.market || !times.length) continue;
        var m2 = c.market;
        m2.book = bk.title || bk.key; m2.source = 'odds_api'; m2.captured_at = new Date(Math.min.apply(null, times)).toISOString();
        if (c.why.length) m2.partial = c.why;
        out[e.id] = m2;
        break;
      }
    });
    return out;
  };

  /* ============================================================== RESEARCH
     Where "View Research" goes. A game whose sport has a Research module and
     whose research artifact lists it opens that module on the game; one with a
     free published article can open the article; anything else opens the
     slate's own matchup view with what is known and a plain statement of what
     research exists. `host` is 'app' (the subscriber terminal) or 'public'. */
  G.researchTarget = function (event, host) {
    var r = (event && event.research) || {};
    var route = r.module ? '#research/' + r.module + (r.entity ? '/' + encodeURIComponent(r.entity) : '') : null;
    if (host !== 'public' && route) return { kind: 'module', href: route, label: 'View Research', exact: !!r.entity };
    if (r.article && r.article.url) return { kind: 'article', href: r.article.url, label: r.article.type === 'postgame' ? 'Read the postgame' : 'View Research' };
    if (host === 'public' && route) return { kind: 'terminal', href: '/app.html' + route, label: 'Research in the terminal', exact: !!r.entity };
    return { kind: 'detail', href: null, label: 'View Matchup' };
  };

  /* ============================================================= READINESS
     The five readiness states come from lib/edgedesk_readiness.js (EDREADY),
     fed only with what the slate holds for the game. The page shows them
     simply; the signal line appears only when EDREADY's ACTIONABLE passed. */
  G.readinessInput = function (event, market, now) {
    var r = (event && event.research) || {};
    var st = event.status === 'FINAL' ? 'FINAL' : event.status === 'LIVE' ? 'LIVE' : event.status;
    var mk = null;
    if (market && toMs(market.captured_at) != null) {
      var age = ((now == null ? Date.now() : now) - toMs(market.captured_at)) / MIN;
      var current = age <= G.CONFIG.market_limit_min;
      var ml = market.moneyline || {};
      mk = { kind: 'PRICE', status: current ? 'CURRENT' : 'STALE', actionable: current, captured_at: market.captured_at,
        limit_min: G.CONFIG.market_limit_min, book: market.book || null, odds_american: num(ml.home) != null ? num(ml.home) : null, source: market.source || null };
    }
    var m = r.model || null;
    return {
      sport: event.sport, game_id: event.id, home: event.home && event.home.name, away: event.away && event.away.name,
      kickoff: event.time_tbd ? null : event.start_utc, status: st,
      model: m ? { status: m.status || 'PREDICTED', home_line: m.home_line != null ? m.home_line : (m.fair_home != null ? m.fair_home : null),
        tier: m.tier || null, data_quality: m.data_quality || null, note: m.note || null } : null,
      market: mk,
      metrics: !!r.metrics,
      audit: r.audit || null,
      gate: r.signal ? { status: r.signal.status || null, actionable: r.signal.actionable === true, why: r.signal.why || null } : null
    };
  };
  G.readiness = function (event, market, now, EDREADY) {
    var R = EDREADY || (typeof globalThis !== 'undefined' && globalThis.EDREADY) || null;
    var r = (event && event.research) || {};
    var hasPage = !!(r.module || (r.article && r.article.url));
    var out = { research: { ok: hasPage, text: hasPage ? 'Research available' : 'Research not available yet' },
      odds: { ok: false, text: 'Odds unavailable' }, model: { ok: false, text: 'No model projection' }, signal: { ok: false, text: null }, assess: null };
    if (market && G.formatMarket(event, market, { now: now }).ok) {
      var f = G.formatMarket(event, market, { now: now });
      out.odds = { ok: f.current, text: f.current ? 'Odds verified' : 'Odds stale' };
    }
    if (!R || !R.assess) { if (r.model) out.model = { ok: true, text: 'Model ready' }; return out; }
    var a = R.assess(G.readinessInput(event, market, now), { now: now });
    out.assess = a;
    out.model = { ok: a.states.MODEL.ok, text: a.states.MODEL.ok ? 'Model ready' : (r.model ? 'Model not ready' : 'No model projection'), why: a.states.MODEL.why };
    if (!hasPage && a.states.RESEARCH.ok) out.research = { ok: false, text: 'Research data on file; no research page yet' };
    out.odds.why = a.states.MARKET.why;
    out.signal = a.states.ACTIONABLE.ok ? { ok: true, text: (r.signal && r.signal.label) || 'Actionable signal', why: a.states.ACTIONABLE.why } : { ok: false, text: null, why: a.states.ACTIONABLE.why };
    return out;
  };

  /* ============================================================= FRESHNESS */
  G.freshness = function (stamp, now, limitMin) {
    var ms = typeof stamp === 'number' ? stamp : toMs(stamp);
    if (ms == null) return { known: false, stale: true, age_min: null, text: 'update time unknown' };
    var age = Math.max(0, ((now == null ? Date.now() : now) - ms) / MIN);
    return { known: true, stale: age > (limitMin || G.CONFIG.stale_schedule_min), age_min: Math.round(age), text: G.ageText(ms, now) };
  };

  /* ================================================================ URL STATE
     The games page keeps sport, date, status and search in its own hash so a
     reader who opens research and comes Back lands on the same slate:
       #games[/<sport>[/<date>]][?status=live&q=text] */
  G.parseState = function (hash) {
    var h = str(hash).replace(/^#/, '');
    var m = /^games(?:\/([a-z0-9]+))?(?:\/(\d{4}-\d{2}-\d{2}))?(?:\?(.*))?$/.exec(h);
    if (!m) return null;
    var st = { sport: m[1] && (m[1] === 'all' || G.sport(m[1])) ? m[1] : 'all', date: m[2] && G.isDateKey(m[2]) ? m[2] : null, status: 'all', q: '' };
    str(m[3]).split('&').forEach(function (kv) {
      var p = kv.split('='), k = p[0], v = p.slice(1).join('=');
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (_) { /* keep raw */ }
      if (k === 'status' && G.STATUS_FILTERS.some(function (f) { return f.id === v; })) st.status = v;
      if (k === 'q') st.q = v.slice(0, 60);
    });
    return st;
  };
  G.stateHash = function (st) {
    st = st || {};
    var h = '#games/' + (st.sport && st.sport !== 'all' ? st.sport : 'all') + (st.date ? '/' + st.date : '');
    var q = [];
    if (st.status && st.status !== 'all') q.push('status=' + encodeURIComponent(st.status));
    if (st.q) q.push('q=' + encodeURIComponent(st.q));
    return h + (q.length ? '?' + q.join('&') : '');
  };

  return G;
});
