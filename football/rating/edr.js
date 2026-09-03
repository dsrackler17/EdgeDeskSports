/* ============================================================================
   THE EDGEDESK RATING (EDR) — how good every college football team actually is,
   on EdgeDesk's own evidence.

   Not SP+, not ESPN's, not a poll. One number in POINTS against an average FBS
   team, rebuilt every week from things EdgeDesk can observe and check:

     RESULTS      opponent-adjusted scoring margin this season. What happened.
     CARRYOVER    the same measure over prior seasons — "been there, done that" —
                  weighted by HOW MUCH LAST SEASON STILL PREDICTS THIS ONE,
                  which is MEASURED from the seasons themselves, never assumed.
     ROSTER       who is actually on the team: returning production, portal
                  inflow and the level the transfers came from.
     AVAILABILITY who is expected to play this week.

   THE PORTAL / NIL QUESTION, ANSWERED WITH ARITHMETIC.
   "Does last season even matter any more?" is the whole argument about NIL and
   the portal, and EDR does not take a side on it. It regresses each season's
   results on the previous season's and reports the slope. When last season
   stops predicting this one, the carryover weight falls on its own, in the
   data, without anybody editing a constant. That measured slope ships with the
   rating so it can be read and argued with.

   NIL DOLLARS ARE NOT IN HERE, because no public feed carries them and EdgeDesk
   does not invent numbers. What NIL BUYS is observable — portal movement, and
   the level of program each transfer came from — and that is what ROSTER reads.
   The gap is named in every rating's own `unmeasured` list rather than hidden.

   Nothing here is a betting number. EDR is research until its own graded record
   says otherwise, and it says so about itself.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDEDR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_rating_v1';

  /* How many prior seasons can carry, and how fast an older one fades. Both
     are shapes, not strengths: the STRENGTH is the measured slope below. */
  var CARRY_SEASONS = 3;
  var CARRY_DECAY = 0.55;
  /* A blowout is capped before it enters the recursion. Beating a team by 60
     is not twice the evidence of beating them by 30, and an uncapped margin
     lets one scrimmage move a season rating. */
  var MARGIN_CAP = 28;
  /* The recursion is a fixed point; these bound the work, not the answer. */
  var ITERS = 60, TOL = 1e-6;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function sd(a) {
    if (a.length < 2) return null;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
  }
  function fold(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return t;
  }
  /* The SAME team key the roster sync, the settler and the Power 4 engine use,
     so one team is one team across every part of this repo. */
  function teamKey(s) { return fold(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }

  /* ------------------------------------------------------- league constants */
  /* Home advantage is MEASURED from the games themselves — the mean home
     margin in non-neutral games, halved (it accrues to one side). */
  function measureHfa(games) {
    var m = [];
    (games || []).forEach(function (g) {
      if (g.neutral) return;
      if (!isNum(g.home_points) || !isNum(g.away_points)) return;
      m.push(g.home_points - g.away_points);
    });
    var mu = mean(m);
    return { hfa: mu == null ? null : Math.round((mu / 2) * 100) / 100, n: m.length,
      basis: mu == null ? 'no completed non-neutral games' : 'half the mean home margin over ' + m.length + ' games' };
  }

  /* ------------------------------------------- opponent-adjusted recursion */
  /* r[t] solves: r[t] = mean over t's games of (capped margin - r[opponent]),
     with the home side charged the measured HFA. Non-FBS opponents share ONE
     rating, itself solved for, so beating an FCS team is worth what the data
     says it is worth and not a number somebody chose. */
  function rate(games, opts) {
    opts = opts || {};
    var hfaInfo = opts.hfa != null ? { hfa: opts.hfa, n: null, basis: 'supplied' } : measureHfa(games);
    var hfa = hfaInfo.hfa == null ? 0 : hfaInfo.hfa;
    var cap = isNum(opts.cap) ? opts.cap : MARGIN_CAP;
    var NONFBS = ' nonfbs';
    var rows = [];
    (games || []).forEach(function (g) {
      if (!isNum(g.home_points) || !isNum(g.away_points)) return;
      var h = teamKey(g.home_team), a = teamKey(g.away_team);
      if (!h || !a || h === a) return;
      var hk = g.home_fbs === false ? NONFBS : h;
      var ak = g.away_fbs === false ? NONFBS : a;
      if (hk === NONFBS && ak === NONFBS) return;
      var margin = clamp(g.home_points - g.away_points, -cap, cap);
      var adj = g.neutral ? 0 : hfa;
      rows.push({ h: hk, a: ak, m: margin - adj });
    });
    var r = {}, gamesFor = {}, k;
    rows.forEach(function (x) {
      r[x.h] = 0; r[x.a] = 0;
      gamesFor[x.h] = (gamesFor[x.h] || 0) + 1;
      gamesFor[x.a] = (gamesFor[x.a] || 0) + 1;
    });
    for (var it = 0; it < ITERS; it++) {
      var acc = {}, cnt = {}, moved = 0;
      rows.forEach(function (x) {
        acc[x.h] = (acc[x.h] || 0) + (x.m + r[x.a]); cnt[x.h] = (cnt[x.h] || 0) + 1;
        acc[x.a] = (acc[x.a] || 0) + (-x.m + r[x.h]); cnt[x.a] = (cnt[x.a] || 0) + 1;
      });
      var next = {};
      for (k in acc) next[k] = acc[k] / cnt[k];
      /* centre on the FBS field, so the number reads "points vs an average
         FBS team" and the non-FBS pool is free to sit wherever it lands */
      var fbsVals = [];
      for (k in next) if (k !== NONFBS) fbsVals.push(next[k]);
      var c = mean(fbsVals) || 0;
      for (k in next) { next[k] -= c; moved = Math.max(moved, Math.abs(next[k] - r[k])); }
      r = next;
      if (moved < TOL) break;
    }
    var out = {};
    for (k in r) if (k !== NONFBS) out[k] = { rating: Math.round(r[k] * 100) / 100, games: gamesFor[k] || 0 };
    return { ratings: out, nonfbs: r[NONFBS] == null ? null : Math.round(r[NONFBS] * 100) / 100,
      hfa: hfaInfo, teams: Object.keys(out).length, games: rows.length };
  }

  /* ------------------------------------------- the measured carryover slope */
  /* Regress this season's rating on the previous season's, across every team
     in both. The slope IS the answer to "does last season still matter": 1.0
     means it carries whole, 0 means it tells you nothing. Reported with its
     r-squared and its sample so a thin year cannot masquerade as a finding. */
  function carryoverSlope(prev, next) {
    var xs = [], ys = [], k;
    for (k in prev) if (next[k]) {
      /* a team with almost no games in either season is noise, not evidence */
      if ((prev[k].games || 0) < 6 || (next[k].games || 0) < 6) continue;
      xs.push(prev[k].rating); ys.push(next[k].rating);
    }
    var n = xs.length;
    if (n < 20) return { slope: null, r2: null, n: n, basis: 'too few teams in both seasons to measure' };
    var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0, syy = 0, i;
    for (i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) * (xs[i] - mx);
      syy += (ys[i] - my) * (ys[i] - my);
    }
    if (!(sxx > 0) || !(syy > 0)) return { slope: null, r2: null, n: n, basis: 'no variance to regress' };
    var slope = sxy / sxx;
    var r = sxy / Math.sqrt(sxx * syy);
    return { slope: Math.round(slope * 1000) / 1000, r2: Math.round(r * r * 1000) / 1000, n: n,
      basis: 'ordinary least squares of season-on-season team ratings' };
  }
  /* Every consecutive pair EdgeDesk holds, plus the trend. If carryover has
     fallen in the portal era, THIS is where it shows up, and the rating
     reweights itself without anyone touching a constant. */
  function carryoverHistory(seasonRatings) {
    var seasons = Object.keys(seasonRatings).map(Number).sort(function (a, b) { return a - b; });
    var pairs = [], i;
    for (i = 1; i < seasons.length; i++) {
      var p = carryoverSlope(seasonRatings[seasons[i - 1]], seasonRatings[seasons[i]]);
      if (p.slope != null) pairs.push({ from: seasons[i - 1], to: seasons[i], slope: p.slope, r2: p.r2, n: p.n });
    }
    var latest = pairs.length ? pairs[pairs.length - 1] : null;
    var half = Math.max(1, Math.floor(pairs.length / 2));
    var earlyMean = mean(pairs.slice(0, half).map(function (p) { return p.slope; }));
    var lateMean = mean(pairs.slice(half).map(function (p) { return p.slope; }));
    var trend = (earlyMean != null && lateMean != null && pairs.length >= 3)
      ? Math.round((lateMean - earlyMean) * 1000) / 1000 : null;
    return {
      pairs: pairs, latest: latest,
      /* the weight EDR actually uses: the most recent measured slope, bounded
         to a sane range so one freak season cannot invert the rating */
      weight: latest ? clamp(latest.slope, 0, 1) : null,
      trend: trend,
      note: !pairs.length ? 'not enough seasons on file to measure carryover'
        : (trend == null ? 'measured on ' + pairs.length + ' season pair' + (pairs.length === 1 ? '' : 's')
          : (trend < -0.05 ? 'last season predicts this one LESS than it used to — the portal era showing up in the arithmetic'
            : trend > 0.05 ? 'last season predicts this one MORE than it used to'
              : 'how much last season carries has not measurably changed'))
    };
  }

  /* ------------------------------------------------------ roster component */
  /* What NIL buys is observable even though NIL is not: who came back, who
     arrived, and the level of the programs they left. Bounded in points so
     roster construction can inform a rating without overwhelming results. */
  var ROSTER_MAX_PTS = 6;
  function rosterPoints(bundle, opts) {
    opts = opts || {};
    if (!bundle) return { points: 0, available: false, parts: [], reason: 'no roster bundle on file for this team' };
    var parts = [], score = 0, weight = 0;
    var ret = num(bundle.returning_share);
    if (ret != null) {
      /* centred on the field's own mean, so "returning" is relative to the
         era rather than to a number chosen before the portal existed */
      var base = isNum(opts.mean_returning) ? opts.mean_returning : 0.6;
      var sdr = isNum(opts.sd_returning) && opts.sd_returning > 0 ? opts.sd_returning : 0.12;
      var z = (ret - base) / sdr;
      score += 0.6 * z; weight += 0.6;
      parts.push({ name: 'returning production', value: Math.round(ret * 100) + '%', z: Math.round(z * 100) / 100 });
    }
    var pin = num(bundle.portal_in), pout = num(bundle.portal_out);
    if (pin != null && pout != null) {
      var net = pin - pout;
      var sdp = isNum(opts.sd_portal) && opts.sd_portal > 0 ? opts.sd_portal : 8;
      var zn = net / sdp;
      score += 0.2 * zn; weight += 0.2;
      parts.push({ name: 'net portal movement', value: (net >= 0 ? '+' : '') + net + ' players', z: Math.round(zn * 100) / 100 });
    }
    var ped = num(bundle.portal_in_pedigree);
    if (ped != null) {
      var zp = (ped - 0.5) / 0.2;
      score += 0.2 * zp; weight += 0.2;
      parts.push({ name: 'level the transfers came from', value: Math.round(ped * 100) + '/100', z: Math.round(zp * 100) / 100 });
    }
    if (!weight) return { points: 0, available: false, parts: [], reason: 'the roster bundle carries no measurable field' };
    var pts = clamp((score / weight) * (ROSTER_MAX_PTS / 2), -ROSTER_MAX_PTS, ROSTER_MAX_PTS);
    return { points: Math.round(pts * 100) / 100, available: true, parts: parts, reason: null };
  }

  /* ------------------------------------------------ availability component */
  /* This week only, and reversible: a player returning takes the points back.
     Only HIGH-impact absences move the number; everything else is context. */
  var AVAIL_PTS = { OUT: 1, DOUBTFUL: 0.6, GAME_TIME_DECISION: 0.45, QUESTIONABLE: 0.35, DAY_TO_DAY: 0.3, LIMITED: 0.2 };
  var AVAIL_MAX_PTS = 7;
  function availabilityPoints(players, opts) {
    opts = opts || {};
    var per = isNum(opts.points_per_high_impact) ? opts.points_per_high_impact : 3.5;
    var hit = [], pts = 0;
    (players || []).forEach(function (p) {
      if (String(p.impact_level || p.impact || '').toUpperCase() !== 'HIGH') return;
      var w = AVAIL_PTS[String(p.availability_status || p.status || '').toUpperCase()];
      if (!w) return;
      pts -= per * w;
      hit.push({ player: p.player_name || p.name, position: p.position || null,
        status: p.availability_status || p.status, points: Math.round(-per * w * 100) / 100 });
    });
    return { points: Math.round(clamp(pts, -AVAIL_MAX_PTS, 0) * 100) / 100, players: hit, available: hit.length > 0 };
  }

  /* ---------------------------------------------------------------- blend */
  /* How much this season's own results are trusted, by games played. Not a
     hand-set schedule: it is the share of a full regular season played, eased
     so week 1 is not treated as nothing and week 8 is not treated as done. */
  function nowWeight(gamesPlayed) {
    var g = isNum(gamesPlayed) ? Math.max(0, gamesPlayed) : 0;
    return Math.round(clamp(g / (g + 4), 0, 0.95) * 1000) / 1000;
  }

  /* The rating for one team. Every component that fed it is returned, so the
     number can always be taken apart on screen. */
  function ratingFor(key, ctx) {
    var now = ctx.now && ctx.now[key];
    var gp = now ? now.games : 0;
    var wNow = nowWeight(gp);
    var carry = ctx.carryover && ctx.carryover.weight;
    var prior = null, priorParts = [], wsum = 0;
    (ctx.priorSeasons || []).forEach(function (s, i) {
      var r = ctx.seasonRatings[s] && ctx.seasonRatings[s][key];
      if (!r || (r.games || 0) < 6) return;
      var w = Math.pow(CARRY_DECAY, i);
      prior = (prior || 0) + w * r.rating; wsum += w;
      priorParts.push({ season: s, rating: r.rating, games: r.games, weight: Math.round(w * 100) / 100 });
    });
    if (wsum > 0) prior = prior / wsum; else prior = null;

    var rost = rosterPoints(ctx.bundles && ctx.bundles[key], ctx.rosterOpts);
    var avail = availabilityPoints((ctx.availability && ctx.availability[key]) || [], ctx.availOpts);

    /* the core: what happened this season, plus what carries from before at
       the strength the seasons themselves measured */
    var carried = (prior != null && carry != null) ? carry * prior : null;
    var core, basis;
    if (now && carried != null) { core = wNow * now.rating + (1 - wNow) * carried; basis = 'results and measured carryover'; }
    else if (now) { core = now.rating; basis = 'this season only — no prior season on file'; }
    else if (carried != null) { core = carried; basis = 'carryover only — no completed game this season'; }
    else return null;

    var edr = core + (rost.available ? rost.points : 0) + avail.points;
    /* how much of this number EdgeDesk actually watched happen */
    var confidence = clamp(0.35 + 0.45 * wNow + (rost.available ? 0.1 : 0) + (prior != null ? 0.1 : 0), 0, 1);

    var unmeasured = [
      'NIL spending — no public feed carries it; portal movement is read instead, and it is not the same thing',
      'per-player recruiting stars — absent from the public roster feed'
    ];
    if (!rost.available) unmeasured.push('roster construction — ' + rost.reason);
    if (!avail.available) unmeasured.push('availability — no high-impact absence is on file for this team this week');

    return {
      rating: Math.round(edr * 100) / 100,
      core: Math.round(core * 100) / 100,
      components: {
        results: now ? { rating: now.rating, games: now.games, weight: wNow } : null,
        carryover: prior == null ? null : {
          blended_prior: Math.round(prior * 100) / 100, seasons: priorParts,
          measured_weight: carry, applied: carried == null ? null : Math.round(carried * 100) / 100
        },
        roster: rost,
        availability: avail
      },
      basis: basis, confidence: Math.round(confidence * 100) / 100,
      games_played: gp, unmeasured: unmeasured
    };
  }

  /* Every team EdgeDesk can rate, ranked. */
  function build(ctx) {
    var keys = {}, k;
    for (k in (ctx.now || {})) keys[k] = 1;
    (ctx.priorSeasons || []).forEach(function (s) {
      for (var j in (ctx.seasonRatings[s] || {})) keys[j] = 1;
    });
    var out = [];
    Object.keys(keys).forEach(function (key) {
      var r = ratingFor(key, ctx);
      if (!r) return;
      r.key = key;
      r.team = (ctx.names && ctx.names[key]) || key;
      out.push(r);
    });
    out.sort(function (a, b) { return b.rating - a.rating || a.team.localeCompare(b.team); });
    out.forEach(function (r, i) { r.rank = i + 1; });
    return out;
  }

  /* Two teams, one sentence: what EDR says about the gap, and what it does not. */
  function compare(a, b, opts) {
    opts = opts || {};
    if (!a || !b) return null;
    var gap = Math.round((a.rating - b.rating) * 100) / 100;
    var hfa = isNum(opts.hfa) ? opts.hfa : 0;
    var neutral = !!opts.neutral;
    var homeIsA = opts.home === 'a';
    var edge = gap + (neutral ? 0 : (homeIsA ? hfa : -hfa));
    return {
      gap: gap, with_home: Math.round(edge * 100) / 100,
      favourite: edge > 0 ? a.team : edge < 0 ? b.team : null,
      confidence: Math.round(Math.min(a.confidence, b.confidence) * 100) / 100,
      note: 'EdgeDesk Rating is research context. It is not the model’s spread and no bet is priced from it.'
    };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CARRY_SEASONS: CARRY_SEASONS, CARRY_DECAY: CARRY_DECAY, MARGIN_CAP: MARGIN_CAP,
    ROSTER_MAX_PTS: ROSTER_MAX_PTS, AVAIL_MAX_PTS: AVAIL_MAX_PTS,
    teamKey: teamKey, measureHfa: measureHfa, rate: rate,
    carryoverSlope: carryoverSlope, carryoverHistory: carryoverHistory,
    rosterPoints: rosterPoints, availabilityPoints: availabilityPoints,
    nowWeight: nowWeight, ratingFor: ratingFor, build: build, compare: compare,
    mean: mean, sd: sd, clamp: clamp
  };
});
