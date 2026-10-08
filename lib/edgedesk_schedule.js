/* ===========================================================================
   EdgeDesk SCHEDULE — kickoff truth, game status, time zones and week scope.
   docs/system-integrity/DATA_CONTRACT.md §2 · AUDIT.md §2

   WHY IT EXISTS
     The cfbfastR schedule marks a game whose time is not announced with
     start_time_tbd = TRUE and a placeholder instant of midnight Eastern
     (04:00Z in daylight time, 05:00Z in standard time). Every reader of the
     feed dropped that column, so 43 week-7 games reached the board as
     confirmed "FRI 11:00p" kickoffs, and the board's rolling 10-day window put
     them beside the current week's games. A clock rule alone cannot catch it:
     the same feed has a real 04:00Z kickoff (a Hawai'i night game).

   THE RULES
     1. The source's own flag decides. A game the source marks TBA is TBA,
        whatever its timestamp says. A source that supplies no flag and a
        timestamp at a known placeholder instant (midnight Eastern) is
        SUSPECT_PLACEHOLDER — never CONFIRMED.
     2. Every instant is held in UTC. A timestamp without a time zone is
        refused (it is ambiguous), not assumed to be UTC.
     3. A kickoff is displayed in the reader's selected time zone, with the
        zone named. An unconfirmed time is displayed as "time TBA" on the
        game's own date (the placeholder's Eastern date), never as a clock
        time.
     4. A kickoff is never invented: a missing time stays missing.
     5. The week is the source's own week (season, season type, week). The
        CURRENT week is the earliest week that still has an unstarted game
        inside its own schedule cluster, so one rescheduled game cannot pin the
        board to an old week. Everything after it is FUTURE_WEEK research.
     6. Only a CONFIRMED, SCHEDULED, CURRENT_WEEK, not-yet-started game is
        publishable (publishable()). Everything else is research only.

   Browser: window.EDSchedule. Node: require('./edgedesk_schedule.js'). ES5
   apart from Intl (present in every supported browser and in Node).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDSchedule = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var S = { VERSION: 'edgedesk_schedule/1' };

  var H = 3600e3, D = 86400e3;
  S.CONFIG = {
    /* the feed's placeholder convention: midnight in this zone */
    placeholder_zone: 'America/New_York',
    /* a game more than this far from its week's median kickoff is outside
       the week's cluster (rescheduled) and does not decide the current week */
    cluster_days: 4,
    /* a started game with no result is presumed LIVE for this long */
    live_hours: 8,
    default_zone: 'America/Chicago'
  };

  S.ZONES = [
    { id: 'America/New_York', label: 'Eastern' },
    { id: 'America/Chicago', label: 'Central' },
    { id: 'America/Denver', label: 'Mountain' },
    { id: 'America/Phoenix', label: 'Arizona' },
    { id: 'America/Los_Angeles', label: 'Pacific' },
    { id: 'America/Anchorage', label: 'Alaska' },
    { id: 'Pacific/Honolulu', label: 'Hawaii' },
    { id: 'UTC', label: 'UTC' }
  ];

  S.KICKOFF_STATE = {
    CONFIRMED: { key: 'CONFIRMED', label: 'Kickoff confirmed', verified: true,
      means: 'The schedule source gives a time and does not mark it as to be announced.' },
    TBA: { key: 'TBA', label: 'Time TBA', verified: false,
      means: 'The source knows the date but marks the time as to be announced; its timestamp is a placeholder.' },
    SUSPECT_PLACEHOLDER: { key: 'SUSPECT_PLACEHOLDER', label: 'Time unverified', verified: false,
      means: 'The source supplied no TBA flag and the timestamp sits on the feed’s placeholder instant (midnight Eastern). Treated as unannounced until a source confirms it.' },
    MISSING: { key: 'MISSING', label: 'No kickoff on file', verified: false,
      means: 'No usable kickoff timestamp (none, unparseable, or without a time zone).' }
  };
  S.STATUS = {
    SCHEDULED: { key: 'SCHEDULED', label: 'Scheduled', pregame: true },
    TENTATIVE: { key: 'TENTATIVE', label: 'Tentative', pregame: true },
    POSTPONED: { key: 'POSTPONED', label: 'Postponed', pregame: false },
    CANCELED: { key: 'CANCELED', label: 'Canceled', pregame: false },
    LIVE: { key: 'LIVE', label: 'Live', pregame: false },
    COMPLETED: { key: 'COMPLETED', label: 'Final', pregame: false }
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function truthy(v) { return v === true || /^(true|t|1|yes)$/i.test(String(v == null ? '' : v).trim()); }
  function falsy(v) { return v === false || /^(false|f|0|no)$/i.test(String(v == null ? '' : v).trim()); }

  /* ============================================================ UTC */
  /* An ISO instant WITH a zone (Z or ±hh:mm) or epoch ms → epoch ms. A date
     alone is a date, not an instant (returned as {date}). A naive local
     timestamp is refused. */
  S.parse = function (t) {
    if (typeof t === 'number') return isFinite(t) ? { ms: t } : { error: 'not a finite epoch' };
    if (!present(t)) return { error: 'no timestamp' };
    var s = String(t).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return { error: 'timestamp without a time zone (' + s + ')' };
    var v = Date.parse(s);
    return isFinite(v) ? { ms: v } : { error: 'unparseable timestamp (' + s + ')' };
  };
  S.toUtc = function (t) { var p = S.parse(t); return p.ms != null ? new Date(p.ms).toISOString() : null; };

  /* the wall clock of an instant in a zone */
  var fmtCache = {};
  function parts(ms, zone) {
    var key = zone || 'UTC';
    if (!fmtCache[key]) fmtCache[key] = new Intl.DateTimeFormat('en-US', { timeZone: key, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    var o = {};
    fmtCache[key].formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  S.wallClock = parts;
  function zoneAbbr(ms, zone) {
    try {
      var p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
      for (var i = 0; i < p.length; i++) if (p[i].type === 'timeZoneName') return p[i].value;
    } catch (_) { /* unknown zone */ }
    return zone;
  }
  S.validZone = function (zone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; } catch (_) { return false; }
  };
  /* the instant is midnight in the placeholder zone */
  S.isPlaceholderInstant = function (ms) {
    var p = parts(ms, S.CONFIG.placeholder_zone);
    return p.h === 0 && p.mi === 0 && p.s === 0;
  };

  /* ===================================================== KICKOFF STATE
     g: { kickoff | start_date | commence_time, start_time_tbd | kickoff_tbd |
          time_tbd, kickoff_state } — any of the source spellings */
  function tbdFlag(g) {
    var k = ['start_time_tbd', 'kickoff_tbd', 'time_tbd', 'startTimeTBD', 'tbd'];
    for (var i = 0; i < k.length; i++) if (g && Object.prototype.hasOwnProperty.call(g, k[i]) && present(g[k[i]])) {
      if (truthy(g[k[i]])) return true;
      if (falsy(g[k[i]])) return false;
    }
    return null;
  }
  S.kickoffOf = function (g) {
    g = g || {};
    var raw = present(g.kickoff) ? g.kickoff : (present(g.start_date) ? g.start_date : (present(g.commence_time) ? g.commence_time : g.kickoff_utc));
    var p = S.parse(raw);
    var flag = tbdFlag(g);
    var st, basis;
    /* an upstream verdict already made by this module is kept — but a carried
       verdict can only ever keep a time UNverified: it never confirms a time
       the source now marks TBA, and a carried CONFIRMED on the placeholder
       instant stands only if it was confirmed by the source's own flag */
    if (g.kickoff_state && S.KICKOFF_STATE[g.kickoff_state] && p.ms != null) {
      st = g.kickoff_state; basis = g.kickoff_basis || 'carried from the source artifact';
      if (st === 'CONFIRMED' && flag === true) { st = 'TBA'; basis = 'the source marks the time as to be announced (start_time_tbd); a carried CONFIRMED cannot override it'; }
      else if (st === 'CONFIRMED' && flag !== false && S.isPlaceholderInstant(p.ms) && !/start_time_tbd = false/.test(String(g.kickoff_basis || ''))) {
        st = 'SUSPECT_PLACEHOLDER'; basis = 'a carried CONFIRMED on the feed’s placeholder instant (midnight Eastern) with no source flag behind it';
      }
    } else if (p.error && !p.date) { st = 'MISSING'; basis = p.error; }
    else if (p.date) { st = 'TBA'; basis = 'the source gives a date only'; }
    else if (flag === true) { st = 'TBA'; basis = 'the source marks the time as to be announced (start_time_tbd)'; }
    else if (flag === false) { st = 'CONFIRMED'; basis = 'the source gives a time and marks it as set (start_time_tbd = false)'; }
    else if (S.isPlaceholderInstant(p.ms)) { st = 'SUSPECT_PLACEHOLDER'; basis = 'no TBA flag supplied, and the time is the feed’s placeholder instant (midnight Eastern)'; }
    else { st = 'CONFIRMED'; basis = 'the source gives a time (no TBA flag supplied; not a placeholder instant)'; }
    var ms = p.ms != null ? p.ms : null;
    /* the game's own calendar date: for a placeholder, the Eastern date the
       placeholder encodes; for a confirmed time, the Eastern date of kickoff */
    var date = null;
    if (p.date) date = p.date;
    else if (ms != null) { var e = parts(ms, S.CONFIG.placeholder_zone); date = e.y + '-' + ('0' + e.mo).slice(-2) + '-' + ('0' + e.d).slice(-2); }
    var def = S.KICKOFF_STATE[st];
    return { state: st, verified: def.verified, label: def.label, basis: basis,
      utc: ms != null ? new Date(ms).toISOString() : null, ms: ms, game_date: date, source_flag: flag };
  };

  /* ======================================================== GAME STATUS */
  var STATUS_WORDS = [
    [/cancel/i, 'CANCELED'], [/no[_ ]?contest|forfeit/i, 'CANCELED'],
    [/postpon|suspend|delay/i, 'POSTPONED'],
    [/final|complete|finished|status_final|^post$/i, 'COMPLETED'],
    [/in[_ ]?progress|live|halftime|end[_ ]of[_ ]period|^in$/i, 'LIVE'],
    [/scheduled|pre|status_scheduled|^tbd$/i, 'SCHEDULED']
  ];
  S.statusOf = function (g, now) {
    g = g || {};
    now = now == null ? Date.now() : now;
    var k = S.kickoffOf(g);
    var raw = g.status || g.game_status || g.state || null;
    var from = null, i;
    if (present(raw)) for (i = 0; i < STATUS_WORDS.length; i++) if (STATUS_WORDS[i][0].test(String(raw))) { from = STATUS_WORDS[i][1]; break; }
    if (truthy(g.completed)) from = 'COMPLETED';
    var st, inferred = false;
    if (from === 'CANCELED' || from === 'POSTPONED' || from === 'COMPLETED' || from === 'LIVE') st = from;
    else if (k.ms != null && k.verified && now >= k.ms) { st = 'LIVE'; inferred = true; }
    else if (!k.verified) st = 'TENTATIVE';
    else st = 'SCHEDULED';
    var def = S.STATUS[st];
    return { status: st, label: def.label, pregame: def.pregame && !(k.ms != null && k.verified && now >= k.ms),
      inferred: inferred, result_overdue: inferred && now - k.ms > S.CONFIG.live_hours * H, source_status: raw || null, kickoff: k };
  };

  /* ============================================================ DISPLAY */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateText(y, mo, d) {
    var wd = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd] + ', ' + MON[mo - 1] + ' ' + d;
  }
  /* "Sat, Oct 10 · 2:30 PM CDT" — or "Sat, Oct 17 · time TBA" */
  S.display = function (g, zone, opts) {
    opts = opts || {};
    zone = zone && S.validZone(zone) ? zone : S.CONFIG.default_zone;
    var k = g && g.state && g.ms !== undefined ? g : S.kickoffOf(g);
    if (k.state === 'MISSING') return { text: 'Kickoff not on file', short: 'TBA', zone: zone, verified: false, state: k.state };
    if (!k.verified) {
      var dt = k.game_date ? k.game_date.split('-').map(Number) : null;
      var t = (dt ? dateText(dt[0], dt[1], dt[2]) + ' · ' : '') + 'time TBA';
      return { text: t, short: dt ? dateText(dt[0], dt[1], dt[2]).slice(0, 3).toUpperCase() + ' TBA' : 'TBA', zone: zone, verified: false, state: k.state };
    }
    var p = parts(k.ms, zone);
    var h12 = (p.h % 12) || 12, ap = p.h < 12 ? 'AM' : 'PM';
    var clock = h12 + ':' + ('0' + p.mi).slice(-2) + ' ' + ap;
    var abbr = zoneAbbr(k.ms, zone);
    return { text: dateText(p.y, p.mo, p.d) + ' · ' + clock + ' ' + abbr, clock: clock, zone_abbr: abbr,
      short: p.wd.toUpperCase() + ' ' + h12 + ':' + ('0' + p.mi).slice(-2) + (p.h < 12 ? 'a' : 'p'),
      zone: zone, verified: true, state: k.state, local: { y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi } };
  };
  /* a capture time, for "as of" lines */
  S.timestampText = function (t, zone) {
    var p = S.parse(t);
    if (p.ms == null) return 'time unknown';
    zone = zone && S.validZone(zone) ? zone : S.CONFIG.default_zone;
    var w = parts(p.ms, zone), h12 = (w.h % 12) || 12;
    return MON[w.mo - 1] + ' ' + w.d + ', ' + h12 + ':' + ('0' + w.mi).slice(-2) + ' ' + (w.h < 12 ? 'AM' : 'PM') + ' ' + zoneAbbr(p.ms, zone);
  };

  /* ============================================================== WEEKS */
  function seasonTypeRank(t) { return /post/i.test(String(t || '')) ? 1 : 0; }
  S.weekKey = function (g) {
    if (!g || g.week == null || g.season == null) return null;
    return g.season + ':' + seasonTypeRank(g.season_type) + ':' + ('0' + g.week).slice(-2);
  };
  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); var n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; }
  /* the current week of a slate: games carry season, week, (season_type),
     a kickoff and optionally a status */
  S.currentWeek = function (games, now) {
    now = now == null ? Date.now() : now;
    var byWeek = {};
    (games || []).forEach(function (g) {
      var key = S.weekKey(g); if (!key) return;
      var k = S.kickoffOf(g);
      (byWeek[key] = byWeek[key] || []).push({ g: g, k: k });
    });
    var keys = Object.keys(byWeek).sort();
    for (var i = 0; i < keys.length; i++) {
      var list = byWeek[keys[i]];
      var conf = list.filter(function (x) { return x.k.verified && x.k.ms != null; }).map(function (x) { return x.k.ms; });
      var all = list.filter(function (x) { return x.k.ms != null; }).map(function (x) { return x.k.ms; });
      var med = median(conf.length ? conf : all);
      if (med == null) continue;
      var open = list.some(function (x) {
        if (x.k.ms == null || Math.abs(x.k.ms - med) > S.CONFIG.cluster_days * D) return false;
        var st = S.statusOf(x.g, now).status;
        if (st === 'COMPLETED' || st === 'CANCELED' || st === 'POSTPONED') return false;
        /* a TBA game is open until the end of its date */
        var end = x.k.verified ? x.k.ms : x.k.ms + D;
        return end > now;
      });
      if (open) return { key: keys[i], season: list[0].g.season, week: list[0].g.week, season_type: list[0].g.season_type || null, median_kickoff: new Date(med).toISOString() };
    }
    return null;
  };
  /* where a game sits relative to the current week */
  S.scope = function (g, current) {
    var key = S.weekKey(g);
    if (!current || !key) return 'UNKNOWN_WEEK';
    return key === current.key ? 'CURRENT_WEEK' : (key > current.key ? 'FUTURE_WEEK' : 'PAST_WEEK');
  };

  /* ===================================================== PUBLISHABILITY */
  S.publishable = function (g, now, current) {
    now = now == null ? Date.now() : now;
    var st = S.statusOf(g, now), reasons = [];
    if (!st.kickoff.verified) reasons.push({ code: 'KICKOFF_' + st.kickoff.state, text: 'The kickoff is not confirmed (' + st.kickoff.label.toLowerCase() + ': ' + st.kickoff.basis + ').' });
    if (st.status !== 'SCHEDULED' && st.status !== 'TENTATIVE') reasons.push({ code: 'STATUS_' + st.status, text: 'The game is ' + st.label.toLowerCase() + '.' });
    else if (!st.pregame) reasons.push({ code: 'STARTED', text: 'The game has kicked off.' });
    var sc = current ? S.scope(g, current) : 'UNKNOWN_WEEK';
    if (current && sc !== 'CURRENT_WEEK') reasons.push({ code: sc, text: sc === 'FUTURE_WEEK' ? 'The game is in a future week (week ' + g.week + '); it belongs to future-week research, not this week’s content.' : 'The game belongs to a past week.' });
    return { ok: !reasons.length, reasons: reasons, status: st.status, kickoff_state: st.kickoff.state, scope: sc };
  };

  /* ====================================================== EVENT MATCHING
     Odds are assigned to a game only when the event is the same game:
     the same two teams in the same orientation, on the same game date
     (a TBA game) or within the kickoff window (a confirmed game). */
  S.EVENT_WINDOW_H = 36;
  S.eventMatch = function (ev, g, sameTeam) {
    sameTeam = sameTeam || function (a, b) { return String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
    if (!ev || !g) return { match: false, code: 'MISSING' };
    var gh = g.home_team || g.home, ga = g.away_team || g.away;
    var eh = ev.home_team || ev.home, ea = ev.away_team || ev.away;
    var straight = sameTeam(eh, gh) && sameTeam(ea, ga), swapped = sameTeam(eh, ga) && sameTeam(ea, gh);
    if (!straight && !swapped) return { match: false, code: 'TEAM_MISMATCH', text: 'the event names different teams' };
    var k = S.kickoffOf(g), e = S.parse(ev.commence_time || ev.kickoff || ev.start);
    if (e.ms == null) return { match: false, code: 'EVENT_TIME_MISSING', text: 'the event carries no usable start time' };
    var ok;
    if (k.verified && k.ms != null) ok = Math.abs(e.ms - k.ms) <= S.EVENT_WINDOW_H * H;
    else {
      var ed = parts(e.ms, S.CONFIG.placeholder_zone), d = ed.y + '-' + ('0' + ed.mo).slice(-2) + '-' + ('0' + ed.d).slice(-2);
      ok = !!k.game_date && (d === k.game_date || Math.abs(Date.parse(d) - Date.parse(k.game_date)) <= D);
    }
    if (!ok) return { match: false, code: 'DATE_MISMATCH', text: 'the event starts on a different date from the game' };
    return { match: true, code: swapped ? 'ORIENTATION_REVERSED' : 'MATCH', reversed: swapped,
      text: swapped ? 'the provider lists home and away the other way round; every line must be re-signed to the schedule’s home team' : 'same game' };
  };

  return S;
});
