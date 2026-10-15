// deno-lint-ignore-file
/*__EDMULTI_START__*/
/* ===========================================================================
   EdgeDesk MULTI-SPORT RESEARCH DESK — "What's the best researched
   opportunity tonight?" answered across every sport EdgeDesk models.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   TWO PHASES, IN THIS ORDER, AND THE ORDER IS ENFORCED
     prepare()   DISCOVER every event in the window from the schedule (the
                 ESPN scoreboard snapshot, today/slate.json — never the odds
                 pipeline) and from every engine's own slate; run every
                 operational sport adapter (EDPROJ); assess each projection
                 (RESEARCH READY / CONDITIONAL / DATA INSUFFICIENT / MODEL
                 UNAVAILABLE); write the fundamental research; FREEZE the
                 projections (hash, timestamp). No price is read here.
     complete()  only now the quotes: EDMKT compares the frozen snapshot with
                 whatever executable prices exist, re-checks the snapshot hash
                 (a comparison can never move a projection), and ranks.
   The host persists the frozen snapshot between the two calls.

   THREE MEASUREMENTS, NEVER ONE SCORE
     research outcome   READY / CONDITIONAL / INSUFFICIENT / UNAVAILABLE
     modeled probability the engine's probability of the outcome, with its own
                        uncertainty (model, calibration, lineup) — a chance of
                        winning, not a confidence score
     executable edge    EV at a real, fresh, verified price, or nothing
   They are reported side by side and ranked by the documented rules in
   RANKING_RULES; no sport-blind "confidence %" is ever produced.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDMULTI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_multisport_v1';
  var DEFAULT_TZ = 'America/New_York';
  var RANKING_RULES = {
    research: [
      'Only projections whose research outcome is READY or CONDITIONAL are ranked; DATA INSUFFICIENT, MODEL UNAVAILABLE and any projection invalidated by a conflict are listed, never ranked.',
      'Tier 1 before tier 2: a projection whose primary market (moneyline; 1X2 for soccer) is OUTCOME_VALIDATED or MARKET_VALIDATED out of sample ranks above one whose primary market is EXPERIMENTAL.',
      'Within a tier: the conservative probability of the favoured side, p − z·σ, highest first. σ combines the projection\'s own model spread, its measured calibration error and its lineup uncertainty in quadrature; z = Φ⁻¹(1 − 0.10/N) for the N projections ranked, so a wider search needs a stronger number (the cross-sport board\'s selection rule).',
      'Ties: RESEARCH READY before CONDITIONAL, then the larger validation sample.'
    ],
    execution: [
      'Only comparisons of a frozen independent projection with an executable, identity-verified quote are ranked.',
      'By outcome first (VERIFIED POSITIVE EV, then CONDITIONAL EDGE, then MARKET WATCH), then by EV at the conservative probability — never by headline EV.',
      'A DATA CHECK (EV past the 15% sanity ceiling, where a data or identity error is likelier than an edge) is listed, never ranked.',
      'A market-derived (no-vig) reference is never ranked as an EdgeDesk edge; it is reported as a benchmark.'
    ]
  };

  function M() { return root.EDMKT || (typeof require === 'function' ? safeReq('./edgedesk_market_compare.js') : null); }
  function P() { return root.EDPROJ || (typeof require === 'function' ? safeReq('./edgedesk_projections.js') : null); }
  function safeReq(p) { try { return require(p); } catch (_) { return null; } }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function r4(v) { v = num(v); return v == null ? null : Math.round(v * 10000) / 10000; }
  function pct(x, d) { x = num(x); return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function fmtAm(n) { n = num(n); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function slug(s) { return str(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ''); }

  /* ================================================================ */
  /* 1. THE WINDOW — calendar windows in the reader's own zone         */
  /* ================================================================ */
  function validZone(tz) { if (!tz || typeof tz !== 'string' || tz.length > 64) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; } }
  function parts(ms, tz) { var o = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; }); return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday }; }
  function offsetMs(ms, tz) { var p = parts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
  /** local midnight of the day `ms` falls in, plus `days`; the offset is re-read at the target so a DST change lands right */
  function localMidnight(ms, tz, days) { var p = parts(ms, tz); var guess = Date.UTC(p.y, p.m - 1, p.d + (days || 0)) - offsetMs(ms, tz); return Date.UTC(p.y, p.m - 1, p.d + (days || 0)) - offsetMs(guess, tz); }
  /** local midnight of the calendar date y-m-d in tz, read from the date itself (no noon-UTC anchor, which lands on the next day east of UTC+12) */
  function midnightOfDate(y, m, d, tz) { var u = Date.UTC(y, m - 1, d); var guess = u - offsetMs(u, tz); return u - offsetMs(guess, tz); }
  function localDate(ms, tz) { var p = parts(ms, tz); return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2); }
  function localTime(ms, tz) { var t = toMs(ms); if (t == null) return null; try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(t)); } catch (_) { return new Date(t).toISOString(); } }
  /**
   * "tonight" / "today" (the default): from now to the next local midnight. "tomorrow": the next local day.
   * "this weekend": to Monday 00:00 local. "this week": seven days. "next N hours": N hours. o.date (YYYY-MM-DD) pins a replay day.
   */
  function windowFor(question, now, tz, o) {
    o = o || {};
    var zone = validZone(tz) ? tz : DEFAULT_TZ, basis = validZone(tz) ? 'the reader\'s time zone (' + zone + ')' : 'no usable time zone was sent, so ' + DEFAULT_TZ + ' was used';
    var q = str(question).toLowerCase(), from, to, label, past = false;
    var nh = /\bnext (\d{1,3}) hours?\b/.exec(q);
    var dm = o.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.date) : null;
    if (dm && +dm[2] >= 1 && +dm[2] <= 12 && +dm[3] >= 1 && +dm[3] <= 31) {
      var dayStart = midnightOfDate(+dm[1], +dm[2], +dm[3], zone), dayEnd = midnightOfDate(+dm[1], +dm[2], +dm[3] + 1, zone);
      /* today: from now on (a started game is not pregame). A day already over: the whole day, every event of
         which has started, so discovery excludes them all and nothing is frozen — a past day is never projected now */
      past = dayEnd <= now;
      from = past ? dayStart : Math.max(dayStart, now); to = dayEnd; label = o.date + ' (' + zone + ')' + (past ? ' — a day already over: every event has started' : '');
    } else if (nh) { from = now; to = now + Number(nh[1]) * 3600000; label = 'the next ' + nh[1] + ' hours'; }
    else if (/\btomorrow\b/.test(q)) { from = localMidnight(now, zone, 1); to = localMidnight(now, zone, 2); label = 'tomorrow, ' + localDate(from + 3600000, zone); }
    else if (/\bthis weekend\b|\bweekend\b/.test(q)) { var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts(now, zone).wd]; var toMon = (8 - wd) % 7 || 7; var startFri = wd >= 5 || wd === 0 ? now : localMidnight(now, zone, 5 - wd); from = Math.max(now, startFri); to = localMidnight(now, zone, toMon); label = 'this weekend'; }
    else if (/\bthis week\b|\bnext 7 days\b/.test(q)) { from = now; to = now + 7 * 86400000; label = 'the next seven days'; }
    else { from = now; to = localMidnight(now, zone, 1); label = (/\btonight\b/.test(q) ? 'tonight' : 'today') + ', ' + localDate(now, zone) + ' (' + zone + ')'; }
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: label, timezone: zone, basis: basis, past: past };
  }

  /* ================================================================ */
  /* 2. DISCOVERY — the schedule decides what exists, never the prices */
  /* ================================================================ */
  function sportOfEvent(e) {
    var Pj = P(); var id = Pj ? Pj.SCHEDULE_CODE[str(e.sport)] : null;
    return id || null;
  }
  function competitionOf(e) {
    var Pj = P(); if (!Pj) return null;
    var comps = Pj.SPORTS.soccer.competitions, s = slug(e.league);
    for (var k in comps) if (slug(comps[k].label) === s || slug(comps[k].espn) === s) return k;
    return null;
  }
  function teamOf(t) { t = t || {}; return { name: t.name || t.short || t.abbr || '', abbr: t.abbr || null, short: t.short || null }; }
  /** Does schedule event e name projection p by id? (the scoreboard builder's entity link, or the provider's id) */
  function matchesById(e, p) {
    var r = e.research || {};
    if (r.entity != null) {
      var ent = str(r.entity).replace(/^nfl\|/, '');
      if (ent && ent === str(p.event_id)) return true;
    }
    return !!(str(e.provider_id) && str(e.provider_id) === str(p.event_id));
  }
  /** Both teams on the right sides, starts within three hours. */
  function matchesByName(e, p) {
    var Mk = M(); if (!Mk) return false;
    var te = toMs(e.start_utc), tp = toMs(p.start_utc);
    var near = te != null && tp != null && Math.abs(te - tp) <= 3 * 3600000;
    return near && Mk.sameTeam(p.home, e.home && e.home.name) && Mk.sameTeam(p.away, e.away && e.away.name);
  }
  /** Does schedule event e describe projection p? An id link first, then teams and time. */
  function matches(e, p) { return matchesById(e, p) || matchesByName(e, p); }
  /**
   * The projection a schedule event describes, from the candidates of its sport: an id link wins over any name
   * match; then both names; then — for providers that spell a club differently ("Bayern Munich" / "FC Bayern
   * München") — the same competition, a kick-off within 15 minutes and ONE team named on its side, when exactly
   * one candidate qualifies (a team plays one game at a time).
   */
  function joinOf(e, cands, competition) {
    var Mk = M();
    var byId = cands.filter(function (p) { return matchesById(e, p); })[0];
    if (byId) return byId;
    var byName = cands.filter(function (p) { return matchesByName(e, p); });
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return null;
    if (!Mk) return null;
    var te = toMs(e.start_utc);
    var loose = cands.filter(function (p) {
      var tp = toMs(p.start_utc);
      if (te == null || tp == null || Math.abs(te - tp) > 15 * 60000) return false;
      if (competition && p.competition && p.competition !== competition) return false;
      return Mk.sameTeam(p.home, e.home && e.home.name) || Mk.sameTeam(p.away, e.away && e.away.name);
    });
    return loose.length === 1 ? loose[0] : null;
  }
  /**
   * o: { today (today/slate.json), build (EDPROJ.buildAll), window, now }
   * → { events: [...], by_sport: {id: {discovered, with_projection, unavailable, reasons}} }
   */
  function discover(o) {
    var Pj = P(), today = o.today, build = o.build, w = o.window, now = toMs(o.now);
    var from = toMs(w.from), to = toMs(w.to);
    var inWin = function (t) { t = toMs(t); return t != null && t >= from && t < to; };
    var events = [], used = {};
    var sched = today && (today.events || today.upcoming) ? (today.events || []).concat(today.upcoming || []) : [];
    var seen = {};
    sched.forEach(function (e) {
      if (!e || seen[e.id]) return; seen[e.id] = 1;
      if (!inWin(e.start_utc)) return;
      var st = str(e.status).toUpperCase();
      var sport = sportOfEvent(e);
      var row = { sport: sport || str(e.sport), league: e.league || null, competition: null, schedule_id: e.id, start_utc: iso(e.start_utc), home: teamOf(e.home), away: teamOf(e.away), venue: e.venue || null,
        schedule_source: 'today/slate.json (' + (e.provider || 'scoreboard') + ')', status: st || 'SCHEDULED', projection_id: null, research: null, reason: null };
      var sp = sport && Pj ? Pj.SPORTS[sport] : null;
      if (sport === 'soccer' && sp) row.competition = competitionOf(e);
      var cands = sp && sp.adapter ? (build.projections || []).filter(function (p) { return p.sport === sport && !used[p.projection_id]; }) : [];
      var hit = cands.length ? joinOf(e, cands, row.competition) : null;
      /* a game that is not pregame (started, finished, postponed, cancelled, delayed — or past its start time)
         is excluded, and so is its projection: the engine-only pass below must not bring it back as scheduled */
      var notPre = st && st !== 'SCHEDULED' && st !== 'PRE' ? 'the event is not pregame (' + st.toLowerCase() + ')' : now != null && toMs(e.start_utc) <= now ? 'the event has started (its start time has passed)' : null;
      if (notPre) { row.excluded = notPre; if (hit) { used[hit.projection_id] = 1; row.excluded_projection_id = hit.projection_id; } events.push(row); return; }
      if (!sport || !sp) { row.research = { outcome: 'MODEL_UNAVAILABLE', reasons: ['EdgeDesk has no research adapter for ' + str(e.sport)] }; events.push(row); return; }
      if (sport === 'soccer' && !row.competition) { row.research = { outcome: 'MODEL_UNAVAILABLE', reasons: [str(e.league) + ' is not a modelled competition (only ' + Object.keys(sp.competitions).map(function (k) { return sp.competitions[k].label; }).join(', ') + ')'] }; events.push(row); return; }
      if (!sp.adapter) { row.research = { outcome: 'MODEL_UNAVAILABLE', reasons: sp.unsupported.map(function (u) { return u.why; }) }; events.push(row); return; }
      if (hit) { used[hit.projection_id] = 1; row.projection_id = hit.projection_id; row.research = hit.research; }
      else {
        /* before the engine's first scheduled regular-season game: a preseason game, which the ingest drops */
        var first = (build.projections || []).filter(function (p) { return p.sport === sport; }).map(function (p) { return toMs(p.start_utc); }).filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; })[0];
        var pre = /pre/i.test(str(e.season_type)) || (sport === 'nba' && first != null && toMs(e.start_utc) < first - 6 * 3600000);
        var why = sport === 'nba' ? 'not on the NBA engine\'s slate' + (pre ? ' — a preseason game (before the first regular-season game on the engine\'s schedule, ' + new Date(first).toISOString().slice(0, 10) + '); the NBA ingest drops preseason and no preseason model is validated' : '')
          : build.sports[sport] && build.sports[sport].blocker ? 'the ' + sp.label + ' engine artifact could not be read: ' + build.sports[sport].blocker
            : 'the ' + sp.label + ' engine\'s slate has no projection for this game';
        row.research = { outcome: 'MODEL_UNAVAILABLE', reasons: [why] };
      }
      events.push(row);
    });
    /* projections in the window the schedule snapshot did not list (or no snapshot was read) */
    (build.projections || []).forEach(function (p) {
      if (used[p.projection_id] || !inWin(p.start_utc)) return;
      if (now != null && toMs(p.start_utc) <= now) return;
      used[p.projection_id] = 1;
      events.push({ sport: p.sport, league: p.league, competition: p.competition, schedule_id: null, start_utc: p.start_utc, home: p.home, away: p.away, venue: p.venue,
        schedule_source: p.model.artifact + ' (the engine\'s own schedule' + (sched.length ? '; not on the scoreboard snapshot' : '; no scoreboard snapshot was read') + ')', status: 'SCHEDULED', projection_id: p.projection_id, research: p.research, reason: null });
    });
    events.sort(function (a, b) { return (toMs(a.start_utc) || 0) - (toMs(b.start_utc) || 0); });
    var by = {};
    Object.keys(Pj ? Pj.SPORTS : {}).forEach(function (id) { by[id] = { discovered: 0, with_projection: 0, unavailable: 0, excluded: 0, outcomes: {}, reasons: [] }; });
    events.forEach(function (e) {
      var b = by[e.sport] || (by[e.sport] = { discovered: 0, with_projection: 0, unavailable: 0, excluded: 0, outcomes: {}, reasons: [] });
      if (e.excluded) { b.excluded++; return; }
      b.discovered++;
      if (e.projection_id) b.with_projection++; else b.unavailable++;
      var oc = e.research ? e.research.outcome : 'MODEL_UNAVAILABLE'; b.outcomes[oc] = (b.outcomes[oc] || 0) + 1;
      if (!e.projection_id && e.research && e.research.reasons[0] && b.reasons.indexOf(e.research.reasons[0]) < 0) b.reasons.push(e.research.reasons[0]);
    });
    return { events: events, by_sport: by, schedule_read: !!sched.length, schedule_generated_at: today ? iso(today.generated_at) : null, window: w };
  }

  /* ================================================================ */
  /* 3. FUNDAMENTAL RESEARCH — one matchup, from its projection        */
  /* ================================================================ */
  function favoured(p) {
    var o = p.outcome || {};
    if (p.sport === 'soccer') { var best = [['home', o.p_home], ['draw', o.p_draw], ['away', o.p_away]].sort(function (a, b) { return (b[1] || 0) - (a[1] || 0); })[0]; return { side: best[0], p: num(best[1]) }; }
    return num(o.p_home) >= num(o.p_away) ? { side: 'home', p: num(o.p_home) } : { side: 'away', p: num(o.p_away) };
  }
  function sideName(p, side) { return side === 'home' ? p.home.name : side === 'away' ? p.away.name : 'the draw'; }
  /** "VGK 5v5 chance suppression: +2.8 pp toward VGK" — whose factor it is and whom it helps, never ambiguous */
  function factorLine(f, toward, towardName) {
    var x = f.pp_toward_home != null ? f.pp_toward_home : f.points_toward_home;
    var v = x == null ? '' : (f.pp_toward_home != null ? Math.abs(x).toFixed(1) + ' pp of win probability' : Math.abs(x).toFixed(2) + ' points of margin');
    return (f.team ? f.team + ' ' : '') + f.label + (v ? ': ' + v + ' toward ' + towardName : '');
  }
  /**
   * The research block: probability and its uncertainty, the strongest measured advantages for the favoured side,
   * the factors against it, what could make it wrong, model confidence and freshness — separately.
   */
  function researchFor(p, o) {
    o = o || {};
    var Pj = P();
    var fav = favoured(p), prim = Pj.primaryMarket(p);
    var sig = Pj.marketSigma(p, prim);
    var z = o.z != null ? o.z : 1.2816;
    var pLo = fav.p != null ? Math.max(0, fav.p - z * sig.total) : null;
    var toward = function (f) { var x = f.pp_toward_home != null ? f.pp_toward_home : f.points_toward_home; if (x == null) return 0; return fav.side === 'home' ? x : -x; };
    var fs = (p.matchup && p.matchup.factors || []).slice().filter(function (f) { return toward(f) !== 0; });
    var pro = fs.filter(function (f) { return toward(f) > 0; }).sort(function (a, b) { return toward(b) - toward(a); }).slice(0, 3);
    var con = fs.filter(function (f) { return toward(f) < 0; }).sort(function (a, b) { return toward(a) - toward(b); }).slice(0, 2);
    var favName = fav.side === 'home' ? (p.home.abbr || p.home.name) : fav.side === 'away' ? (p.away.abbr || p.away.name) : 'the draw';
    var othName = fav.side === 'home' ? (p.away.abbr || p.away.name) : (p.home.abbr || p.home.name);
    var advantages = pro.map(function (f) { return factorLine(f, true, favName); });
    var counter = con.map(function (f) { return factorLine(f, false, othName); });
    /* the out-of-sample record in this probability range is a counterargument when the model ran hot there */
    var bin = p.uncertainty && p.uncertainty.calibration_bin;
    if (bin && num(bin.model_mean) != null && num(bin.observed) != null && fav.side !== 'draw') {
      var hot = fav.side === 'home' ? num(bin.model_mean) - num(bin.observed) : num(bin.observed) - num(bin.model_mean);
      if (hot > 0.005) counter.push('out of sample, games the model priced at ' + pct(bin.range[0], 0) + '–' + pct(bin.range[1], 0) + ' for the home side came in ' + (Math.abs(num(bin.model_mean) - num(bin.observed)) * 100).toFixed(1) + ' pp ' + (fav.side === 'home' ? 'below' : 'above') + ' the model (n ' + bin.n + ', ' + bin.window + ')');
    }
    var mx = p.matchup && p.matchup.metrics || {};
    /* every figure is printed only when the engine published it: a missing field drops the line, never the desk */
    var fx = function (v, d) { v = num(v); return v == null ? null : v.toFixed(d); };
    if (p.sport === 'nhl' && mx.home && mx.away) {
      var me = fav.side === 'home' ? mx.home : mx.away, them = fav.side === 'home' ? mx.away : mx.home;
      var xf = [fx(me.ev_xg_for_vs_league, 2), fx(them.ev_xg_for_vs_league, 2)], xa = [fx(me.ev_xg_against_vs_league, 2), fx(them.ev_xg_against_vs_league, 2)];
      var xParts = [xf[0] != null && xf[1] != null ? '5v5 xG for ' + xf[0] + '× league vs ' + xf[1] + '×' : null, xa[0] != null && xa[1] != null ? 'xG against ' + xa[0] + '× vs ' + xa[1] + '×' : null].filter(Boolean);
      if (xParts.length) advantages.push(xParts.join('; ') + ' (score- and opponent-adjusted)');
    }
    if (p.sport === 'nba' && fx(mx.home_offence_vs_away_defence, 1) != null && fx(mx.away_offence_vs_home_defence, 1) != null) advantages.push('projected efficiency ' + (p.home.abbr || p.home.name) + ' ' + fx(mx.home_offence_vs_away_defence, 1) + ' vs ' + (p.away.abbr || p.away.name) + ' ' + fx(mx.away_offence_vs_home_defence, 1) + ' per 100' + (fx(mx.pace, 1) != null ? ' at pace ' + fx(mx.pace, 1) : ''));
    if (p.sport === 'cfb') {
      var qbLine = function (x, nm) { if (!x || typeof x !== 'object' || !x.season || num(x.season.epa_per_dropback) == null) return null; return nm + ' ' + (x.identity && x.identity.player ? x.identity.player + ' ' : '') + num(x.season.epa_per_dropback).toFixed(3) + ' EPA/dropback (' + x.season.dropbacks + ' dropbacks)'; };
      var qa = [qbLine(mx.home_qb_epa, p.home.name), qbLine(mx.away_qb_epa, p.away.name)].filter(Boolean);
      if (qa.length) advantages.push('quarterback passing ' + qa.join(' vs ') + ' — research context, not in the fair line');
    }
    if (p.sport === 'soccer' && p.projected_score && fx(p.projected_score.home, 2) != null && fx(p.projected_score.away, 2) != null) advantages.push('expected goals ' + p.home.name + ' ' + fx(p.projected_score.home, 2) + ', ' + p.away.name + ' ' + fx(p.projected_score.away, 2));
    var ctx = p.context || {};
    var rest = ctx.home && ctx.away && ctx.home.rest_days != null && ctx.away.rest_days != null ? 'rest ' + p.home.abbr + ' ' + ctx.home.rest_days + ' d' + (ctx.home.back_to_back ? ' (back-to-back)' : '') + ', ' + p.away.abbr + ' ' + ctx.away.rest_days + ' d' + (ctx.away.back_to_back ? ' (back-to-back)' : '') + (ctx.away.travel_km != null ? '; ' + p.away.abbr + ' travel ' + Math.round(ctx.away.travel_km) + ' km' : '') : null;
    var wrong = [].concat((p.integrity && p.integrity.conflicts || []).map(function (c) { return c.detail; }), (p.sensitivity || []).slice(0, 2).map(function (s) { return s.what + (s.range_p_home ? ': home probability ' + pct(s.range_p_home[0]) + '–' + pct(s.range_p_home[1]) : s.delta_p_home != null ? ': home probability ' + (s.delta_p_home >= 0 ? '+' : '') + (s.delta_p_home * 100).toFixed(1) + ' pp' : s.delta_home_line != null ? ': home line moves ' + s.delta_home_line + ' pts' : ''); }), (p.invalidators || []).slice(0, 2));
    var v = p.validation && p.validation.markets ? p.validation.markets[prim] : null;
    var rec = p.validation ? p.validation.record || p.validation.engine_record || null : null;
    var recM = rec && rec.moneyline ? rec.moneyline : rec;
    return {
      projection_id: p.projection_id, sport: p.sport, sport_label: p.sport_label, league: p.league, event: p.away.name + ' @ ' + p.home.name, start_utc: p.start_utc,
      research_outcome: p.research.outcome, research_reasons: p.research.reasons,
      modeled: { side: fav.side, selection: sideName(p, fav.side), probability: r4(fav.p), market: prim, sigma: sig, z: r4(z), conservative_probability: r4(pLo),
        fair_american: fav.side === 'home' ? p.fair.moneyline.home : fav.side === 'away' ? p.fair.moneyline.away : p.fair.moneyline.draw,
        p_home: p.outcome.p_home, p_away: p.outcome.p_away, p_draw: p.outcome.p_draw, fair_home_line: p.fair.spread ? p.fair.spread.home_line : null, fair_total: p.fair.total ? p.fair.total.line : null, projected_score: p.projected_score,
        note: 'the model\'s probability of this outcome — not a confidence score' },
      advantages: advantages, counterarguments: counter, context: rest, could_be_wrong: wrong,
      model_confidence: { validation_state: v ? v.state : 'UNAVAILABLE', market: prim, n: v ? v.n : null, held_out_log_loss: v ? v.held_out_log_loss : null, headline: v ? v.headline : null,
        engine_record: recM ? { n: recM.n, log_loss: recM.log_loss, brier: recM.brier, baseline_log_loss: recM.baseline_home_only_log_loss || null } : null, calibration_sd: sig.calibration, value_claims: v ? !!v.value_claims : false },
      freshness: { model_built_at: p.model.artifact_generated_at, age_hours: p.freshness.age_hours, state: p.freshness.state, inputs_known_at: p.model.inputs_known_at || null, data_state: p.freshness.data_state || null },
      availability: { key_role: p.availability.key_role, certainty: p.availability.certainty, conflicts: p.availability.conflicts || [] },
      model: { id: p.model.id, artifact: p.model.artifact }, invalidated: !!(p.integrity && p.integrity.invalidated)
    };
  }

  /* ================================================================ */
  /* 4. RANKING                                                        */
  /* ================================================================ */
  function rankResearch(rows) {
    var Mk = M(), Pj = P();
    var eligible = rows.filter(function (r) { return (r.research_outcome === 'RESEARCH_READY' || r.research_outcome === 'RESEARCH_CONDITIONAL') && !r.invalidated && r.modeled.probability != null; });
    var z = Mk ? Mk.selectionZ(eligible.length, 0.10) : 1.2816;
    eligible.forEach(function (r) { r.modeled.z = r4(z); r.modeled.conservative_probability = r4(Math.max(0, r.modeled.probability - z * r.modeled.sigma.total)); r.tier = Pj.PRICING_STATES[r.model_confidence.validation_state] ? 1 : 2; });
    eligible.sort(function (a, b) {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.modeled.conservative_probability !== a.modeled.conservative_probability) return b.modeled.conservative_probability - a.modeled.conservative_probability;
      if (a.research_outcome !== b.research_outcome) return a.research_outcome === 'RESEARCH_READY' ? -1 : 1;
      return (b.model_confidence.n || 0) - (a.model_confidence.n || 0);
    });
    eligible.forEach(function (r, i) { r.rank = i + 1; });
    var held = rows.filter(function (r) { return eligible.indexOf(r) < 0; });
    return { ranked: eligible, held_back: held, z: r4(z), rules: RANKING_RULES.research };
  }
  function rankExecution(cmp) {
    var Mk = M();
    var all = (cmp && cmp.rows || []).filter(function (r) { return r.outcome === 'VERIFIED_POSITIVE_EV' || r.outcome === 'CONDITIONAL_EDGE' || r.outcome === 'MARKET_WATCH'; });
    /* the highest EVs are the likeliest data errors: a DATA CHECK is listed beside the ranking, never in it */
    var checks = all.filter(function (r) { return r.data_check; });
    var rows = all.filter(function (r) { return !r.data_check; });
    rows.sort(function (a, b) { var d = Mk.OUTCOME_RANK[a.outcome] - Mk.OUTCOME_RANK[b.outcome]; if (d) return d; return (num(b.math && b.math.conservative_ev_per_dollar) || -1) - (num(a.math && a.math.conservative_ev_per_dollar) || -1); });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return { ranked: rows, data_checks: checks, rules: RANKING_RULES.execution };
  }

  /* ================================================================ */
  /* 5. THE TWO PHASES                                                 */
  /* ================================================================ */
  /**
   * PHASE 1 — no price is read. o: { artifacts: {path: json|null}, artifact_errors, question, now, timezone, date }
   */
  function prepare(o) {
    o = o || {};
    var Pj = P();
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var A = o.artifacts || {};
    var w = windowFor(o.question, now, o.timezone, { date: o.date });
    var build = Pj.buildAll(A, { now: now, registry: A['engine/registry.json'] || null });
    Object.keys(o.artifact_errors || {}).forEach(function (k) { Object.keys(Pj.SPORTS).forEach(function (id) { if (Pj.SPORTS[id].artifacts[0] === k && build.sports[id] && !build.sports[id].blocker && !build.sports[id].projections) build.sports[id].blocker = k + ' could not be read (' + o.artifact_errors[k] + ')'; }); });
    var disc = discover({ today: A['today/slate.json'] || null, build: build, window: w, now: now });
    var inWindow = {}; disc.events.forEach(function (e) { if (e.projection_id) inWindow[e.projection_id] = 1; });
    var proj = build.projections.filter(function (p) { return inWindow[p.projection_id]; });
    /* the freeze: before any market is touched */
    var snapshot = Pj.freeze(proj, now);
    var research = snapshot.projections.map(function (p) { return researchFor(p); });
    return { schema: VERSION + ':prepared', prepared_at: new Date(now).toISOString(), window: w, build_summary: build.sports, registry_generated_at: build.registry_generated_at,
      discovery: disc, snapshot: snapshot, research: research, artifacts_read: Object.keys(A).filter(function (k) { return A[k] != null; }), artifact_errors: o.artifact_errors || {},
      artifact_times: artifactTimes(A) };
  }
  /* the schedule's own names for each joined projection's teams: the comparison accepts a quote that names the
     game the way the scoreboard does ("Bayern Munich"), because discovery already proved the two are one game */
  function aliasesOf(prep) {
    var out = {};
    (prep.discovery && prep.discovery.events || []).forEach(function (e) {
      if (!e.projection_id || !e.schedule_id) return;
      out[e.projection_id] = { home: [e.home && e.home.name, e.home && e.home.short].filter(Boolean), away: [e.away && e.away.name, e.away && e.away.short].filter(Boolean) };
    });
    return out;
  }
  function artifactTimes(A) { var out = {}; Object.keys(A || {}).forEach(function (k) { var a = A[k]; if (a && typeof a === 'object') out[k] = iso(a.generated_at) || null; }); return out; }
  /**
   * PHASE 2 — the market. o: { quotes: [raw quotes], odds_disabled, odds_status, now, audits, benchmark }
   */
  function complete(prep, o) {
    o = o || {};
    var Mk = M(), Pj = P();
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var hashBefore = prep.snapshot.snapshot_hash;
    var cmp = Mk.compareSnapshot(prep.snapshot, o.odds_disabled ? [] : (o.quotes || []), { now: now, odds_disabled: !!o.odds_disabled, audits: o.audits || null, cfg: o.cfg || null, aliases: aliasesOf(prep) });
    var verify = Pj.verifySnapshot(prep.snapshot);
    var rr = rankResearch(prep.research.map(function (r) { return JSON.parse(JSON.stringify(r)); }));
    var ex = rankExecution(cmp);
    /* The price each top research candidate would need, from the frozen projection only (never a quote), on the
       SAME bar the comparison classifies on: the edge bar, and z for N = every market this run compares (at
       least as many as are priced, so a quote at this price reads CONDITIONAL EDGE or better, not MARKET WATCH). */
    var cfgN = Object.assign({}, Mk.DEFAULTS, o.cfg || {});
    var nNeed = Math.max(1, cmp.rows.length, cmp.priced_markets || 0);
    var zNeed = Mk.selectionZ(nNeed, cfgN.alpha);
    var needs = rr.ranked.slice(0, 6).map(function (r) {
      var p = prep.snapshot.projections.filter(function (x) { return x.projection_id === r.projection_id; })[0];
      var mk = p.sport === 'soccer' ? 'three_way' : 'moneyline';
      var el = Pj.pricingEligibility(p, mk);
      if (!el.ok) return { projection_id: r.projection_id, needs: null, why: el.why };
      var model = Pj.probabilityAt(p, mk, r.modeled.side, null);
      var sig = Pj.marketSigma(p, mk); var pc = Math.max(0, r.modeled.probability - zNeed * sig.total);
      var am = Mk.maxEntry(pc, model ? model.p_push : 0, cfgN);
      return { projection_id: r.projection_id, needs: am, z: r4(zNeed), n_markets: nNeed,
        why: 'the worst ' + (mk === 'three_way' ? '1X2' : 'moneyline') + ' price at which the conservative probability ' + pct(pc) + ' (z ' + r4(zNeed) + ' for the ' + nNeed + ' markets this run compares; more priced markets raise it) still clears the ' + pct(cfgN.edge_bar, 0) + ' bar on EV' };
    });
    var res = {
      schema: VERSION, version: VERSION, built_at: new Date(now).toISOString(), window: prep.window,
      order: { projections_frozen_at: prep.snapshot.frozen_at, quotes_compared_at: cmp.compared_at, snapshot_hash: hashBefore, snapshot_unchanged: cmp.snapshot_unchanged && verify.ok && hashBefore === prep.snapshot.snapshot_hash, frozen_before_market: toMs(prep.snapshot.frozen_at) <= toMs(cmp.compared_at) },
      odds: { disabled: !!o.odds_disabled, status: o.odds_status || (o.odds_disabled ? 'DISABLED' : 'READ'), quotes_in: cmp.quotes_in, executable_quotes: cmp.executable_quotes, priced_markets: cmp.priced_markets, sources: o.quote_sources || [] },
      research_ranking: rr, execution_ranking: ex, comparison: cmp, price_needed: needs,
      discovery: prep.discovery, build_summary: prep.build_summary, artifacts_read: prep.artifacts_read, artifact_errors: prep.artifact_errors, artifact_times: prep.artifact_times,
      benchmark: o.benchmark || null
    };
    res.coverage = coverage(res, prep);
    res.sections = sections(res, prep);
    res.answer = render(res);
    res.counts = countsOf(res, prep);
    return res;
  }

  /* ================================================================ */
  /* 6. COVERAGE, SECTIONS, ANSWER                                     */
  /* ================================================================ */
  function coverage(res, prep) {
    var Pj = P(), out = [];
    var bySport = prep.discovery.by_sport;
    Object.keys(Pj.SPORTS).forEach(function (id) {
      var sp = Pj.SPORTS[id], d = bySport[id] || { discovered: 0, with_projection: 0, unavailable: 0, outcomes: {}, reasons: [] }, b = prep.build_summary[id] || {};
      var rows = res.comparison.rows.filter(function (r) { return r.sport === id; });
      var priced = rows.filter(function (r) { return r.quote; });
      var newest = priced.map(function (r) { return r.quote.age_min; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; })[0];
      var researched = (d.outcomes.RESEARCH_READY || 0) + (d.outcomes.RESEARCH_CONDITIONAL || 0) + (d.outcomes.DATA_INSUFFICIENT || 0);
      var blockers = [];
      if (!sp.adapter) blockers.push(sp.unsupported.map(function (u) { return u.why; })[0]);
      else if (b.blocker) blockers.push(b.blocker);
      d.reasons.forEach(function (x) { if (blockers.indexOf(x) < 0) blockers.push(x); });
      if (d.outcomes.DATA_INSUFFICIENT) blockers.push(d.outcomes.DATA_INSUFFICIENT + ' with insufficient data' + (b.notes && b.notes[0] ? ' (' + b.notes[0] + ')' : ''));
      if (!d.discovered && sp.adapter && b.note) blockers.push(b.note);
      out.push({
        sport: id, label: sp.label, events_discovered: d.discovered, events_researched: researched, projections: d.with_projection,
        research_outcomes: d.outcomes, model_executed: !!(sp.adapter && b.model_executed), model: b.model ? b.model.id || null : null, model_built_at: b.model ? iso(b.model.generated_at) : null,
        markets_evaluated: rows.length, markets_priced: priced.length,
        price_freshness: res.odds.disabled ? 'odds integrations disabled' : priced.length ? 'newest quote ' + newest + ' min old' : rows.length ? 'no quote for any market' : '—',
        verified_edges: rows.filter(function (r) { return r.outcome === 'VERIFIED_POSITIVE_EV'; }).length,
        blockers: blockers.filter(Boolean).slice(0, 4)
      });
    });
    return out;
  }
  function sections(res, prep) {
    var Mk = M();
    var verified = res.execution_ranking.ranked.filter(function (r) { return r.outcome === 'VERIFIED_POSITIVE_EV'; });
    var watch = res.execution_ranking.ranked.filter(function (r) { return r.outcome === 'CONDITIONAL_EDGE' || r.outcome === 'MARKET_WATCH'; });
    var rk = res.research_ranking.ranked;
    var byOutcome = res.comparison.counts;
    return {
      best_verified: verified[0] || null,
      no_verified_reason: verified.length ? null : noVerifiedReason(res),
      best_research: rk[0] || null,
      runner_up: rk[1] || null,
      market_watch: watch[0] || null,
      data_checks: res.execution_ranking.data_checks || [],
      alternatives: rk.slice(1, 6),
      /* the strongest ranked projection of every sport, so a sport outside the top five is still compared, with its rank */
      best_by_sport: rk.filter(function (r, i) { return rk.findIndex(function (x) { return x.sport === r.sport; }) === i; }),
      held_back: res.research_ranking.held_back.filter(function (r) { return r.invalidated || r.research_outcome === 'DATA_INSUFFICIENT'; }).slice(0, 4),
      outcomes: byOutcome,
      label: Mk.OUTCOME_LABEL
    };
  }
  function noVerifiedReason(res) {
    var c = res.comparison.counts;
    if (res.odds.disabled) return 'sportsbook odds integrations are disabled for this run, so no price was compared: every market reads NO CURRENT ODDS';
    var parts = [], dc = res.comparison.data_checks || 0;
    ['STALE_PRICE', 'NO_CURRENT_ODDS', 'INSUFFICIENT_MODEL_RELIABILITY', 'NO_VERIFIED_EDGE', 'MARKET_WATCH', 'CONDITIONAL_EDGE'].forEach(function (k) {
      var n = k === 'MARKET_WATCH' ? c[k] - dc : c[k];
      if (n) parts.push(n + ' ' + M().OUTCOME_LABEL[k].toLowerCase());
      if (k === 'MARKET_WATCH' && dc) parts.push(dc + ' data check' + (dc === 1 ? '' : 's'));
    });
    return parts.length ? 'of ' + plural(res.comparison.rows.length, 'market') + ' compared: ' + parts.join(', ') : 'no market was compared';
  }
  function countsOf(res, prep) {
    var cov = res.coverage;
    var bySport = {}; cov.forEach(function (c) { bySport[c.sport] = c.events_discovered; });
    return {
      sports_discovered: cov.filter(function (c) { return c.events_discovered > 0; }).length,
      sports_with_operational_models: cov.filter(function (c) { return c.model_executed; }).length,
      sports_researched: cov.filter(function (c) { return c.events_researched > 0; }).length,
      eligible_games_by_sport: bySport,
      research_evaluations: prep.research.length,
      independent_projections: prep.snapshot.count,
      valid_price_captures: res.comparison.rows.filter(function (r) { return r.quote && r.quote.freshness && r.quote.freshness.actionable; }).length,
      price_captures_seen: res.comparison.executable_quotes_matched || 0,
      verified_positive_ev: res.comparison.counts.VERIFIED_POSITIVE_EV || 0
    };
  }

  function researchCard(r, heading, res) {
    var L = [];
    var m = r.modeled, mc = r.model_confidence, f = r.freshness;
    L.push(heading);
    L.push('Sport: ' + r.sport_label + (r.league && r.sport_label.indexOf(r.league) < 0 ? ' (' + r.league + ')' : '') + ' · Event: ' + r.event + ' · ' + localTime(r.start_utc, res.window.timezone));
    L.push('Modeled probability: ' + m.selection + ' ' + pct(m.probability) + ' (' + (m.market === 'three_way' ? '1X2' : 'moneyline') + ', fair ' + fmtAm(m.fair_american) + ') — the model\'s probability of the outcome, not a confidence score. Uncertainty σ ' + pct(m.sigma.total) + ' (model ' + pct(m.sigma.model) + ', calibration ' + pct(m.sigma.calibration) + ', lineup ' + pct(m.sigma.lineup) + '); conservative ' + pct(m.conservative_probability) + ' at z ' + m.z + '.');
    if (m.fair_home_line != null || m.fair_total != null || (m.projected_score && num(m.projected_score.home) != null && num(m.projected_score.away) != null)) L.push('EdgeDesk fair lines: ' + [m.fair_home_line != null ? 'home ' + (m.fair_home_line > 0 ? '+' : '') + m.fair_home_line : null, m.fair_total != null ? 'total ' + m.fair_total : null, m.projected_score && num(m.projected_score.home) != null && num(m.projected_score.away) != null ? 'projected ' + Number(m.projected_score.away).toFixed(2) + '–' + Number(m.projected_score.home).toFixed(2) + ' (away–home)' : null].filter(Boolean).join('; ') + '.');
    L.push('Research: ' + r.research_outcome.replace(/_/g, ' ') + (r.research_reasons && r.research_reasons.length && r.research_outcome !== 'RESEARCH_READY' ? ' — ' + r.research_reasons.join('; ') : '') + '.');
    if (r.advantages.length) L.push('Strongest measured advantages: ' + r.advantages.join('; ') + '.');
    if (r.context) L.push('Rest and travel: ' + r.context + '.');
    L.push('Counterargument: ' + (r.counterarguments.length ? r.counterarguments.join('; ') : 'no measured factor runs against the favoured side; the uncertainty is the counterargument') + '.');
    L.push('Model reliability: ' + mc.validation_state.replace(/_/g, ' ') + (mc.n ? ', n ' + mc.n.toLocaleString('en-US') : '') + (mc.held_out_log_loss != null ? ', held-out log loss ' + mc.held_out_log_loss : '') + (mc.engine_record && mc.engine_record.brier != null ? ', Brier ' + mc.engine_record.brier : '') + '; ' + (mc.value_claims ? 'beats the close' : 'never shown to beat the closing market') + '.');
    L.push('Freshness (separate from reliability): model built ' + (f.age_hours != null ? f.age_hours + ' h ago' : 'at an unknown time') + ' (' + str(f.state).toLowerCase() + ')' + (f.inputs_known_at ? '; inputs known through ' + String(f.inputs_known_at).slice(0, 10) : '') + '.');
    return L;
  }
  function execCard(x, heading, res) {
    var L = [], mt = x.math || {};
    L.push(heading);
    L.push('Sport: ' + x.sport + ' · Event: ' + x.event + ' · Market: ' + x.selection + (x.quote ? ' · Book: ' + (x.quote.book || '—') + ' (' + x.quote.kind_label + ', captured ' + (x.quote.captured_at || 'untimed') + ', ' + (x.quote.age_min != null ? x.quote.age_min + ' min old' : 'age unknown') + ')' : ''));
    if (x.model) L.push('Modeled probability ' + pct(x.model.p_win) + ' (EdgeDesk fair ' + fmtAm(x.model.fair_american) + ')' + (x.quote ? '; available price ' + fmtAm(x.quote.american) : '') + (mt.break_even_probability != null ? '; break-even ' + pct(mt.break_even_probability) : '') + (mt.ev_per_dollar != null ? '; EV ' + pct(mt.ev_per_dollar, 2) + ' per $1 at the point estimate, ' + pct(mt.conservative_ev_per_dollar, 2) + ' at the conservative probability ' + pct(mt.conservative_probability) : '') + (mt.max_acceptable_american != null ? '; maximum acceptable price ' + fmtAm(mt.max_acceptable_american) : '') + '.');
    L.push('Verdict: ' + x.outcome_label + ' — ' + x.reasons.join('; ') + '.');
    return L;
  }
  function render(res) {
    var s = res.sections, L = [], tz = res.window.timezone;
    L.push('BEST VERIFIED OPPORTUNITY');
    if (s.best_verified) execCard(s.best_verified, '', res).slice(1).forEach(function (l) { L.push(l); });
    else L.push('None. No independently modeled market has a fresh, verified executable price that clears every execution gate — ' + s.no_verified_reason + '.');
    L.push('');
    L.push('BEST RESEARCHED MATCHUP');
    if (s.best_research) {
      researchCard(s.best_research, '', res).slice(1).forEach(function (l) { L.push(l); });
      var why = 'Why it ranks first: ' + (s.runner_up ? 'its conservative probability ' + pct(s.best_research.modeled.conservative_probability) + ' is the highest among ' + plural(res.research_ranking.ranked.length, 'ranked projection') + (s.best_research.tier === 1 ? ' with an out-of-sample validated primary market' : '') + '; next is ' + s.runner_up.event + ' (' + s.runner_up.sport_label + ', ' + pct(s.runner_up.modeled.conservative_probability) + ')' : 'it is the only projection that could be ranked') + '. A matchup with no current odds is research, never a verified bet.';
      L.push(why);
      var need = (res.price_needed || []).filter(function (n) { return n.projection_id === s.best_research.projection_id; })[0];
      if (need) L.push('Price to watch: ' + (need.needs != null ? s.best_research.modeled.selection + ' at ' + fmtAm(need.needs) + ' or better (' + need.why + ').' : 'none — ' + need.why + '.'));
    } else L.push('No projection could be ranked in ' + res.window.label + ' (see the coverage report).');
    L.push('');
    L.push('STRONGEST CONDITIONAL MARKET WATCH');
    if (s.market_watch) execCard(s.market_watch, '', res).slice(1).forEach(function (l) { L.push(l); });
    else L.push('None: ' + (res.odds.disabled ? 'odds integrations are disabled for this run.' : res.comparison.priced_markets ? 'no compared price is positive against the model' + (s.data_checks.length ? ' outside the data checks below.' : '.') : 'no fresh executable price was available for a modelled market.'));
    if (s.data_checks.length) L.push('Data checks (not ranked; EV past the 15% sanity ceiling, so a data or identity error is likelier than an edge): ' + s.data_checks.slice(0, 4).map(function (x) { return x.selection + ' at ' + fmtAm(x.quote && x.quote.american) + ' (' + x.event + ')'; }).join('; ') + (s.data_checks.length > 4 ? '; and ' + (s.data_checks.length - 4) + ' more' : '') + '.');
    L.push('');
    L.push('OTHER TOP CANDIDATES (ranked by the rules below; probability, uncertainty and validation are reported separately)');
    if (s.alternatives.length) s.alternatives.forEach(function (r) { L.push(r.rank + '. ' + r.sport_label + ' — ' + r.event + ', ' + localTime(r.start_utc, tz) + ': ' + r.modeled.selection + ' ' + pct(r.modeled.probability) + ' (σ ' + pct(r.modeled.sigma.total) + ', conservative ' + pct(r.modeled.conservative_probability) + '); ' + r.model_confidence.validation_state.replace(/_/g, ' ').toLowerCase() + ' ' + (r.modeled.market === 'three_way' ? '1X2' : 'moneyline') + '; ' + r.research_outcome.replace(/_/g, ' ').toLowerCase() + (r.research_reasons[0] ? ' (' + r.research_reasons[0] + ')' : '') + '.'); });
    else L.push('None.');
    if (s.best_by_sport.length > 1 || (s.best_by_sport.length === 1 && res.research_ranking.ranked.length > 6)) {
      L.push('Best per sport: ' + s.best_by_sport.map(function (r) { return r.sport_label + ' #' + r.rank + ' ' + r.modeled.selection + ' ' + pct(r.modeled.probability) + ' (conservative ' + pct(r.modeled.conservative_probability) + ', tier ' + r.tier + ': ' + r.model_confidence.validation_state.replace(/_/g, ' ').toLowerCase() + ' ' + (r.modeled.market === 'three_way' ? '1X2' : 'moneyline') + ')'; }).join('; ') + '.');
    }
    s.held_back.forEach(function (r) { L.push('Held back — ' + r.sport_label + ' ' + r.event + ': ' + (r.invalidated ? 'projection invalidated: ' + r.availability.conflicts.join('; ') : r.research_outcome.replace(/_/g, ' ').toLowerCase() + ': ' + r.research_reasons.join('; ')) + '.'); });
    L.push('');
    L.push('WHAT COULD CHANGE THE ANSWER');
    var change = [];
    if (s.best_research) s.best_research.could_be_wrong.slice(0, 3).forEach(function (w) { change.push(w); });
    s.held_back.filter(function (r) { return r.invalidated; }).forEach(function (r) { change.push('a re-run of the ' + r.sport_label + ' engine on the current starter for ' + r.event); });
    if (!res.odds.disabled && !res.comparison.priced_markets) change.push('a fresh executable price on any modelled market (none is current now)');
    if (res.odds.disabled) change.push('re-enabling the odds integrations: the frozen projections above would be compared with live prices without being changed');
    change.push('goalie, quarterback and lineup confirmations closer to the start');
    change.slice(0, 6).forEach(function (c, i) { L.push((i + 1) + '. ' + c); });
    L.push('');
    L.push('COVERAGE REPORT (' + res.window.label + ')');
    res.coverage.forEach(function (c) {
      if (!c.events_discovered && !c.model_executed && !c.blockers.length) return;
      L.push('- ' + c.label + ': ' + c.events_discovered + ' discovered, ' + c.events_researched + ' researched, model ' + (c.model_executed ? 'executed (' + c.model + ')' : 'not executed') + ', ' + c.markets_evaluated + ' markets evaluated, prices: ' + c.price_freshness + ', ' + c.verified_edges + ' verified edge' + (c.verified_edges === 1 ? '' : 's') + (c.blockers.length ? '; blockers: ' + c.blockers.join('; ') : '') + '.');
    });
    if (res.benchmark && res.benchmark.text) { L.push(''); L.push('MARKET BENCHMARK — CAPTURED-PRICE AUDIT (market-derived: a book against the sharp market or the model-market blend; not an EdgeDesk independent projection)'); L.push(res.benchmark.text); }
    L.push('');
    L.push('RESEARCH SOURCES');
    Object.keys(res.artifact_times || {}).sort().forEach(function (k) { L.push('- ' + k + (res.artifact_times[k] ? ' — built ' + res.artifact_times[k] : '')); });
    Object.keys(res.artifact_errors || {}).forEach(function (k) { L.push('- ' + k + ' — NOT READ (' + res.artifact_errors[k] + ')'); });
    (res.odds.sources || []).forEach(function (q) { L.push('- prices: ' + q); });
    L.push('Order: projections frozen ' + res.order.projections_frozen_at + ' (snapshot ' + str(res.order.snapshot_hash).slice(0, 16) + '), compared with prices ' + res.order.quotes_compared_at + '; projections unchanged by the comparison: ' + (res.order.snapshot_unchanged ? 'yes' : 'NO') + '.');
    return L.join('\n');
  }

  return {
    VERSION: VERSION, RANKING_RULES: RANKING_RULES, DEFAULT_TZ: DEFAULT_TZ,
    windowFor: windowFor, localMidnight: localMidnight, localDate: localDate, discover: discover, matches: matches, joinOf: joinOf,
    researchFor: researchFor, rankResearch: rankResearch, rankExecution: rankExecution,
    prepare: prepare, complete: complete, coverage: coverage, render: render
  };
});
/*__EDMULTI_END__*/
