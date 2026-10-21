/* ============================================================================
   EdgeDesk NFL model v2 — ONE configurable model for training AND serving.

   Why a second file beside football/engine.js: the NFL rebuild (audit_report.md,
   football/research/nfl_v2/preregistration.json) tests structural changes to
   the rating — how the 2025 prior decays, personnel and market priors, a
   season-by-season home field, travel, split offence/defence features,
   recency, garbage time, calibration — and every one of them has to be
   trained and served by the SAME arithmetic, or the backtest grades a model
   the board never runs (the defence-freeze bug was exactly that). The trainer
   (football/research/nfl_v2/backtest.js, train.js) and the board (app.html
   fbLoadNfl, through football/engine.js predictGame) both call this file.

   The rating recursion generalises engine.js:
     each team, each of the 16 features, keeps
       p   the season's starting value (last season carried: carry x final)
       S,W this season's opponent-adjusted performances, weighted lambda^age
       n   games this season that observed the feature
     and its rating is   r = w(n)*p + (1 - w(n)) * S/W
       geometric   w(n) = (1-alpha)^n, lambda = 1-alpha   <- exactly v1
       hyperbolic  w(n) = k/(k+n),     lambda from cfg      (Step 2)
   so v1 is one configuration, and football/nfl_model.test.js holds the
   geometric configuration to engine.js within 1e-12.

   Row building (the mirrored defence) and quarterback credit are NOT copied:
   they are engine.js nfl.gamePairs / nfl.qbStarts, the parity-tested path.

   ES5 on purpose: it ships inside app.html like engine.js.
   ============================================================================ */
(function () {
  'use strict';
  var root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined') ? globalThis : this;

  var RATE_FEATS = ['off_epa_play', 'pass_epa_db', 'rush_epa_att', 'expl_pass', 'expl_rush', 'sack_rate_all', 'pass_rate', 'plays',
    'def_epa_play', 'def_pass_epa_db', 'def_rush_epa_att', 'def_expl_pass', 'def_expl_rush', 'sack_rate_made', 'pts_for', 'pts_against'];
  var COUNTER = { off_epa_play: 'def_epa_play', pass_epa_db: 'def_pass_epa_db', rush_epa_att: 'def_rush_epa_att', expl_pass: 'def_expl_pass',
    expl_rush: 'def_expl_rush', sack_rate_all: 'sack_rate_made', def_epa_play: 'off_epa_play', def_pass_epa_db: 'pass_epa_db',
    def_rush_epa_att: 'rush_epa_att', def_expl_pass: 'expl_pass', def_expl_rush: 'expl_rush', sack_rate_made: 'sack_rate_all',
    pts_for: 'pts_against', pts_against: 'pts_for' };
  var IS_PTS = { pts_for: 1, pts_against: 1 };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function E() { var e = root.EDFootball; if (!e && typeof require === 'function') { try { e = require('./engine.js'); } catch (_) { e = null; } } return e; }

  /* ------------------------------------------------------------ config */
  /* v1 exactly (football/params.js hyperparams + the v1 feature set) */
  var V1 = {
    carry: 0.8,
    prior: { kind: 'geometric', alpha: 0.10, alpha_pts: 0.06, k: null, k_pts: null },
    recency: null,                 /* null = (1 - alpha) per feature: the v1 EWMA */
    alpha_league: 0.02,
    qb: { alpha_qb: 0.18, qb_shrink: 12, qb_prior: -0.04, alpha_team: 0.10 },
    features: { net_pts_fix: false, split_od: false },
    hfa: { kind: 'intercept', rho: null, m: null },
    ctx: { travel: false, venue: true },
    market: { on: false, beta: null, carry_m: null },
    personnel: { on: false },
    source: 'stw',                 /* 'stw' | 'pbp_G0' | 'pbp_G1' | 'pbp_G2' */
    calibration: { kind: 'none' },
    ridge: { strength: 60, context: 200, total: 60 }
  };
  function config(over) {
    var c = clone(V1), k, j;
    over = over || {};
    for (k in over) if (over.hasOwnProperty(k)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && c[k] && typeof c[k] === 'object') {
        for (j in over[k]) if (over[k].hasOwnProperty(j)) c[k][j] = over[k][j];
      } else c[k] = over[k];
    }
    return c;
  }
  function alphaOf(cfg, f) { return IS_PTS[f] ? cfg.prior.alpha_pts : cfg.prior.alpha; }
  /* the prior's weight after n games this season */
  function priorWeight(cfg, f, n) {
    if (!(n > 0)) return 1;
    if (cfg.prior.kind === 'hyperbolic') { var k = IS_PTS[f] ? cfg.prior.k_pts : cfg.prior.k; return k / (k + n); }
    return Math.pow(1 - alphaOf(cfg, f), n);
  }
  function lambdaOf(cfg, f) {
    if (cfg.recency == null) return cfg.prior.kind === 'geometric' ? 1 - alphaOf(cfg, f) : 1;
    return cfg.recency;
  }

  /* ------------------------------------------------------------ state */
  function blankTeam() { var o = {}, i; for (i = 0; i < RATE_FEATS.length; i++) o[RATE_FEATS[i]] = { p: 0, S: 0, W: 0, n: 0 }; return o; }
  function newState(cfg) {
    return { cfg: cfg, team: {}, ngames: {}, games: {}, lmean: {}, qb: {}, teamQb: {}, season: null,
      mr: {}, mkt: { hsum: 0, hn: 0 }, hfa: { seasons: {}, cur: { sum: 0, n: 0 } }, personnel: {} };
  }
  /* a state seeded from a trained end-of-season snapshot (params.seeds):
     ratings as season-start priors, QB values, league means, market ratings,
     home-field history. The caller applies seasonBreak for each season between. */
  function fromSeeds(cfg, seeds) {
    var st = newState(cfg), t, f;
    for (t in seeds.team) if (seeds.team.hasOwnProperty(t)) {
      st.team[t] = blankTeam();
      for (f in seeds.team[t]) if (st.team[t][f]) st.team[t][f].p = seeds.team[t][f];
      st.ngames[t] = 99; st.games[t] = 0;
    }
    st.lmean = clone(seeds.lmean || {});
    st.qb = clone(seeds.qb || {});
    st.teamQb = clone(seeds.team_qb || {});
    st.mr = clone(seeds.mr || {});
    st.mkt = clone(seeds.mkt || { hsum: 0, hn: 0 });
    st.hfa = clone(seeds.hfa || { seasons: {}, cur: { sum: 0, n: 0 } });
    st.season = seeds.season || null;
    return st;
  }
  function team(st, t) {
    if (!st.team[t]) { st.team[t] = blankTeam(); st.ngames[t] = 0; st.games[t] = 0; if (st.teamQb[t] == null) st.teamQb[t] = 0; }
    return st.team[t];
  }
  /* one team's rating on one feature, and its prior part */
  function rating(st, t, f) {
    var x = st.team[t] && st.team[t][f];
    if (!x) return 0;
    if (!(x.n > 0) || !(x.W > 0)) return x.p;
    var w = priorWeight(st.cfg, f, x.n);
    return w * x.p + (1 - w) * (x.S / x.W);
  }
  function priorPart(st, t, f) {
    var x = st.team[t] && st.team[t][f];
    if (!x) return 0;
    return priorWeight(st.cfg, f, x.n) * x.p;
  }
  function snapshot(st, t) { var o = {}, i; team(st, t); for (i = 0; i < RATE_FEATS.length; i++) o[RATE_FEATS[i]] = rating(st, t, RATE_FEATS[i]); return o; }

  /* the season break: last season's final rating, carried, is this season's prior */
  function seasonBreak(st, season) {
    var cfg = st.cfg, t, i, f;
    var fin = {};
    for (t in st.team) if (st.team.hasOwnProperty(t)) fin[t] = snapshot(st, t);
    for (t in st.team) if (st.team.hasOwnProperty(t)) {
      for (i = 0; i < RATE_FEATS.length; i++) {
        f = RATE_FEATS[i];
        st.team[t][f] = { p: cfg.carry * fin[t][f], S: 0, W: 0, n: 0 };
      }
      st.teamQb[t] = (st.teamQb[t] || 0) * cfg.carry;
      st.games[t] = 0;
    }
    if (cfg.market.on) for (t in st.mr) if (st.mr.hasOwnProperty(t)) st.mr[t] *= cfg.market.carry_m;
    /* home field: close the season that ended into the history */
    if (st.season != null && st.hfa.cur.n > 0) st.hfa.seasons[st.season] = { sum: st.hfa.cur.sum, n: st.hfa.cur.n };
    st.hfa.cur = { sum: 0, n: 0 };
    st.season = season != null ? season : (st.season != null ? st.season + 1 : null);
  }

  /* ------------------------------------------------------------ absorb */
  function qbEff(st, id) {
    var q = st.qb[id], h = st.cfg.qb;
    if (!q) return h.qb_prior;
    return q.v * (q.n / (q.n + h.qb_shrink)) + h.qb_prior * (h.qb_shrink / (q.n + h.qb_shrink));
  }
  function qbAdjust(st, t, id) { if (typeof id !== 'string' || !id) return 0; return qbEff(st, id) - (st.teamQb[t] || 0); }
  /* pairs: engine.js nfl.gamePairs output (each club's row with its mirrored
     defence, in the feed's order); qbStarts: engine.js nfl.qbStarts output */
  function absorbGame(st, pairs, qbStarts) {
    var cfg = st.cfg, pre = {}, i, j, t, raw, opp, f, v, lm, cf, perf, x, lam;
    for (i = 0; i < pairs.length; i++) { team(st, pairs[i][0]); pre[pairs[i][0]] = snapshot(st, pairs[i][0]); }
    for (i = 0; i < pairs.length; i++) {
      t = pairs[i][0]; raw = pairs[i][1]; opp = pairs[1 - i][0];
      for (j = 0; j < RATE_FEATS.length; j++) {
        f = RATE_FEATS[j]; v = raw[f];
        if (!isNum(v)) continue;
        lm = st.lmean[f];
        if (lm === undefined || lm === null) { st.lmean[f] = v; continue; }
        cf = COUNTER[f];
        perf = v - lm - (cf && isNum(pre[opp][cf]) ? pre[opp][cf] : 0);
        x = st.team[t][f]; lam = lambdaOf(cfg, f);
        x.S = lam * x.S + perf; x.W = lam * x.W + 1; x.n += 1;
        st.lmean[f] = (1 - cfg.alpha_league) * lm + cfg.alpha_league * v;
      }
      st.ngames[t] = (st.ngames[t] || 0) + 1;
      st.games[t] = (st.games[t] || 0) + 1;
    }
    for (i = 0; i < (qbStarts || []).length; i++) {
      t = qbStarts[i][0];
      var id = qbStarts[i][1], dev = qbStarts[i][2];
      if (typeof id === 'string' && id && isNum(dev)) {
        var q = st.qb[id] || (st.qb[id] = { v: 0, n: 0 }), aq = cfg.qb.alpha_qb;
        q.v = (1 - aq) * q.v + aq * dev; q.n += 1;
        var at = cfg.prior.kind === 'geometric' ? cfg.prior.alpha : cfg.qb.alpha_team;
        st.teamQb[t] = (1 - at) * (st.teamQb[t] || 0) + at * qbEff(st, id);
      }
    }
  }
  /* after a game: the market rating learns from its CLOSING spread (known at
     kickoff, so it informs only later games) and the home-field tally counts
     its margin. close_home_margin: nflverse spread_line (positive = home favoured). */
  function afterGame(st, g) {
    var cfg = st.cfg, h = g.home, a = g.away;
    if (cfg.market.on && isNum(g.close_home_margin)) {
      var mh = st.mkt.hn > 0 ? st.mkt.hsum / st.mkt.hn : 0;
      var e = g.close_home_margin - ((st.mr[h] || 0) - (st.mr[a] || 0) + (g.neutral ? 0 : mh));
      st.mr[h] = (st.mr[h] || 0) + cfg.market.beta * e / 2;
      st.mr[a] = (st.mr[a] || 0) - cfg.market.beta * e / 2;
      if (!g.neutral) { st.mkt.hsum += g.close_home_margin; st.mkt.hn += 1; }
    }
    if (!g.neutral && isNum(g.home_score) && isNum(g.away_score)) { st.hfa.cur.sum += g.home_score - g.away_score; st.hfa.cur.n += 1; }
  }
  /* one completed game, the way training does it (engine.js row building) */
  function absorbCompleted(st, g, stwRows, qbRows) {
    var EN = E(), pairs = EN.nfl.gamePairs(g, stwRows);
    if (!pairs) return false;
    var qbs = EN.nfl.qbStarts(st, pairs, qbRows || []);
    absorbGame(st, pairs, qbs);
    return true;
  }

  /* ------------------------------------------------------------ home field */
  function hfaEstimate(st) {
    var c = st.cfg.hfa, s, sum = 0, n = 0, wsum = 0, wn = 0, cur = st.season;
    for (s in st.hfa.seasons) if (st.hfa.seasons.hasOwnProperty(s)) { sum += st.hfa.seasons[s].sum; n += st.hfa.seasons[s].n; }
    var mu = n > 0 ? sum / n : 0;
    for (s in st.hfa.seasons) if (st.hfa.seasons.hasOwnProperty(s)) {
      var age = cur != null ? Math.max(1, cur - (+s)) : 1, w = Math.pow(c.rho, age);
      wsum += w * st.hfa.seasons[s].sum; wn += w * st.hfa.seasons[s].n;
    }
    wsum += st.hfa.cur.sum; wn += st.hfa.cur.n;           /* this season to date, weight 1 */
    return (wsum + c.m * mu) / (wn + c.m);
  }

  /* ------------------------------------------------------------ travel */
  var R_KM = 6371.0088;
  function km(a, b) {
    if (!a || !b) return null;
    var rad = Math.PI / 180, dlat = (b.lat - a.lat) * rad, dlon = (b.lon - a.lon) * rad;
    var x = Math.sin(dlat / 2) * Math.sin(dlat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  var OFFSET_MEMO = {};
  /* hours from UTC of an IANA zone on a date (DST-aware, through Intl) */
  function utcOffset(tz, isoDate) {
    if (!tz || !isoDate) return null;
    var key = tz + '|' + isoDate;
    if (OFFSET_MEMO[key] != null) return OFFSET_MEMO[key];
    var out = null;
    try {
      var d = new Date(isoDate + 'T17:00:00Z');
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d);
      var nm = '';
      for (var i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') nm = parts[i].value;
      var m = /GMT([+-]\d+)(?::(\d+))?/.exec(nm);
      out = m ? (+m[1] + (m[2] ? (m[1].charAt(0) === '-' ? -1 : 1) * (+m[2]) / 60 : 0)) : (nm === 'GMT' ? 0 : null);
    } catch (_) { out = null; }
    OFFSET_MEMO[key] = out;
    return out;
  }
  /* the club's home city in a season (relocations: STL -> LA 2016, SD -> LAC 2017, OAK -> LV 2020) */
  var HISTORIC_HOME = {
    LA: [{ through: 2015, lat: 38.6328, lon: -90.1885, tz_name: 'America/Chicago', city: 'St. Louis, MO' }],
    LAC: [{ through: 2016, lat: 32.7831, lon: -117.1196, tz_name: 'America/Los_Angeles', city: 'San Diego, CA' }],
    LV: [{ through: 2019, lat: 37.7516, lon: -122.2005, tz_name: 'America/Los_Angeles', city: 'Oakland, CA' }]
  };
  /* clubs that share a stadium the table lists under its partner */
  var SHARED_HOME = { NYG: 'NYJ', LA: 'LAC' };
  function homeOf(stadiums, club, season) {
    var h = HISTORIC_HOME[club], i;
    if (h) for (i = 0; i < h.length; i++) if (season <= h[i].through) return h[i];
    var by = stadiums && stadiums.byClub ? stadiums.byClub : {};
    return by[club] || (SHARED_HOME[club] ? by[SHARED_HOME[club]] : null) || null;
  }
  /* stadiums: football/venues/nfl_stadiums.json, indexed (indexStadiums) */
  function indexStadiums(json) {
    var out = { byClub: {}, byName: {} }, list = (json && json.stadiums) || [], i, j;
    for (i = 0; i < list.length; i++) {
      var s = list[i], rec = { lat: s.lat, lon: s.lon, tz_name: s.tz_name, city: s.city, name: s.name };
      if (s.club && !out.byClub[s.club]) out.byClub[s.club] = rec;
      [s.name].concat(s.aliases || []).forEach(function (n) { if (n) out.byName[String(n).toLowerCase()] = rec; });
    }
    return out;
  }
  /* g: {season, gameday 'YYYY-MM-DD', gametime 'HH:MM' ET, home, away, neutral, stadium} */
  function travelFor(stadiums, g) {
    var hh = homeOf(stadiums, g.home, g.season), ah = homeOf(stadiums, g.away, g.season);
    var venue = g.neutral ? (stadiums && g.stadium ? stadiums.byName[String(g.stadium).toLowerCase()] : null) : hh;
    if (!hh || !ah || !venue) return null;
    var vo = utcOffset(venue.tz_name, g.gameday), ho = utcOffset(hh.tz_name, g.gameday), ao = utcOffset(ah.tz_name, g.gameday);
    var et = utcOffset('America/New_York', g.gameday);
    var hm = /^(\d{1,2}):(\d{2})/.exec(String(g.gametime || '')), etHour = hm ? +hm[1] + (+hm[2]) / 60 : null;
    /* a club from Pacific time playing a 1 pm ET kickoff: 10 am on its body clock */
    var westEarly = function (o) { return o != null && et != null && etHour != null && (et - o) >= 3 && etHour < 14 ? 1 : 0; };
    return {
      home_km: g.neutral ? km(hh, venue) : 0, away_km: km(ah, venue),
      home_tz: vo != null && ho != null ? Math.abs(vo - ho) : 0, away_tz: vo != null && ao != null ? Math.abs(vo - ao) : 0,
      home_west_early: g.neutral ? westEarly(ho) : 0, away_west_early: westEarly(ao)
    };
  }

  /* ------------------------------------------------------------ features */
  function featureNames(cfg) {
    var s = [cfg.features.net_pts_fix ? 'net_pts_fix' : 'net_pts'];
    if (cfg.features.split_od) s.push('off_epa', 'def_epa', 'pass_off', 'pass_def', 'rush_off', 'rush_def');
    else s.push('net_epa', 'net_pass', 'net_rush');
    s.push('qb_adj_diff', 'rest_diff', 'div_game');
    if (cfg.personnel.on) s.push('pers_rb', 'pers_wr', 'pers_ol');
    if (cfg.market.on) s.push('mkt_diff');
    var c = ['rest_diff', 'home_short', 'away_short', 'home_off_bye', 'away_off_bye', 'div_game', 'week_frac'];
    if (cfg.ctx.venue) c.push('is_dome', 'grass');
    if (cfg.ctx.travel) c.push('travel_diff', 'tz_diff', 'west_early');
    var t = ['off_epa_sum', 'def_epa_sum', 'pass_matchup', 'rush_matchup', 'expl_sum', 'sack_env', 'pace_sum', 'pts_env',
      'is_dome', 'temp_c', 'wind_o', 'div_game', 'week_frac'];
    return { spread: s, ctx: c, total: t };
  }
  /* the strength features from two rating snapshots (rh, ra) */
  function strengthFrom(rh, ra, qbd, restd, div, pers, mkt) {
    return {
      net_pts: (rh.pts_for + rh.pts_against) - (ra.pts_for + ra.pts_against),
      net_pts_fix: (rh.pts_for - rh.pts_against) - (ra.pts_for - ra.pts_against),
      net_epa: (rh.off_epa_play - rh.def_epa_play) - (ra.off_epa_play - ra.def_epa_play),
      off_epa: rh.off_epa_play - ra.off_epa_play, def_epa: ra.def_epa_play - rh.def_epa_play,
      net_pass: (rh.pass_epa_db - rh.def_pass_epa_db) - (ra.pass_epa_db - ra.def_pass_epa_db),
      pass_off: rh.pass_epa_db - ra.pass_epa_db, pass_def: ra.def_pass_epa_db - rh.def_pass_epa_db,
      net_rush: (rh.rush_epa_att - rh.def_rush_epa_att) - (ra.rush_epa_att - ra.def_rush_epa_att),
      rush_off: rh.rush_epa_att - ra.rush_epa_att, rush_def: ra.def_rush_epa_att - rh.def_rush_epa_att,
      qb_adj_diff: qbd, rest_diff: restd, div_game: div,
      pers_rb: pers ? pers.rb : 0, pers_wr: pers ? pers.wr : 0, pers_ol: pers ? pers.ol : 0,
      mkt_diff: mkt
    };
  }
  /* game = {season, week, home, away, home_rest, away_rest, roof, surface, div_game,
             temp, wind, home_qb_id, away_qb_id, neutral, travel (travelFor)} */
  function features(st, game) {
    var cfg = st.cfg, h = game.home, a = game.away;
    team(st, h); team(st, a);
    var rh = snapshot(st, h), ra = snapshot(st, a);
    var restH = isNum(game.home_rest) ? game.home_rest : 7, restA = isNum(game.away_rest) ? game.away_rest : 7;
    var dome = (String(game.roof) === 'dome' || String(game.roof) === 'closed') ? 1 : 0;
    var temp = (isNum(game.temp) && !dome) ? game.temp : 68, wind = (isNum(game.wind) && !dome) ? game.wind : 0;
    var weekFrac = Math.min(1, (isNum(game.week) ? game.week : 9) / 18);
    var div = game.div_game ? 1 : 0;
    var qbd = qbAdjust(st, h, game.home_qb_id) - qbAdjust(st, a, game.away_qb_id);
    /* personnel: each club's offseason delta, scaled by how much of its rating is still prior */
    var pers = null;
    if (cfg.personnel.on) {
      var P = st.personnel[st.season] || {}, ph = P[h] || {}, pa = P[a] || {};
      var wh = priorWeight(cfg, 'off_epa_play', st.team[h].off_epa_play.n), wa = priorWeight(cfg, 'off_epa_play', st.team[a].off_epa_play.n);
      pers = { rb: wh * (ph.rb || 0) - wa * (pa.rb || 0), wr: wh * (ph.wr || 0) - wa * (pa.wr || 0), ol: wh * (ph.ol || 0) - wa * (pa.ol || 0) };
    }
    var mkt = cfg.market.on ? (st.mr[h] || 0) - (st.mr[a] || 0) : 0;
    var sp = strengthFrom(rh, ra, qbd, (restH - restA) / 7, div, pers, mkt);
    var tv = game.travel || null;
    var ctx = {
      rest_diff: (restH - restA) / 7, home_short: restH <= 5 ? 1 : 0, away_short: restA <= 5 ? 1 : 0,
      home_off_bye: restH >= 12 ? 1 : 0, away_off_bye: restA >= 12 ? 1 : 0, div_game: div, week_frac: weekFrac,
      is_dome: dome, grass: String(game.surface || '').toLowerCase().indexOf('grass') === 0 ? 1 : 0,
      travel_diff: tv && isNum(tv.away_km) && isNum(tv.home_km) ? (tv.away_km - tv.home_km) / 1000 : 0,
      tz_diff: tv ? (tv.away_tz || 0) - (tv.home_tz || 0) : 0,
      west_early: tv ? (tv.away_west_early || 0) - (tv.home_west_early || 0) : 0
    };
    var total = {
      off_epa_sum: rh.off_epa_play + ra.off_epa_play, def_epa_sum: rh.def_epa_play + ra.def_epa_play,
      pass_matchup: rh.pass_epa_db + ra.def_pass_epa_db + ra.pass_epa_db + rh.def_pass_epa_db,
      rush_matchup: rh.rush_epa_att + ra.def_rush_epa_att + ra.rush_epa_att + rh.def_rush_epa_att,
      expl_sum: rh.expl_pass + ra.expl_pass + rh.def_expl_pass + ra.def_expl_pass,
      sack_env: rh.sack_rate_all + ra.sack_rate_all - rh.sack_rate_made - ra.sack_rate_made,
      pace_sum: rh.plays + ra.plays, pts_env: rh.pts_for + ra.pts_for + rh.pts_against + ra.pts_against,
      is_dome: dome, temp_c: (temp - 68) / 25, wind_o: Math.max(0, wind - 8) / 10, div_game: div, week_frac: weekFrac
    };
    /* the same strength features on the PRIOR parts alone (the card's split) */
    var ph2 = {}, pa2 = {}, i;
    for (i = 0; i < RATE_FEATS.length; i++) { ph2[RATE_FEATS[i]] = priorPart(st, h, RATE_FEATS[i]); pa2[RATE_FEATS[i]] = priorPart(st, a, RATE_FEATS[i]); }
    var prior = strengthFrom(ph2, pa2, 0, 0, 0, pers, mkt);
    return { spread: sp, ctx: ctx, total: total, prior: prior,
      hfa: cfg.hfa.kind === 'season' && !game.neutral ? hfaEstimate(st) : 0,
      season_games: { home: st.games[h] || 0, away: st.games[a] || 0 },
      /* the same contract engine.js gameFeatures publishes */
      known: Math.min(st.ngames[h] || 0, st.ngames[a] || 0),
      qb_known: { home: !!game.home_qb_id, away: !!game.away_qb_id } };
  }

  /* ------------------------------------------------------------ predict */
  /* params: { cfg, spread:{names,w,b}, ctx:{names,w,b}, total:{names,w,b}, calibration } */
  var PRIOR_TERMS = { net_pts: 1, net_pts_fix: 1, net_epa: 1, off_epa: 1, def_epa: 1, net_pass: 1, pass_off: 1, pass_def: 1,
    net_rush: 1, rush_off: 1, rush_def: 1, pers_rb: 1, pers_wr: 1, pers_ol: 1, mkt_diff: 1 };
  function lin(F, M, terms, intercept) {
    var s = intercept, i, t;
    if (terms) terms.push({ key: 'baseline', value: null, weight: M.b, points: intercept });
    for (i = 0; i < M.names.length; i++) {
      t = F[M.names[i]] * M.w[i]; s += t;
      if (terms) terms.push({ key: M.names[i], value: F[M.names[i]], weight: M.w[i], points: t });
    }
    return s;
  }
  function predict(st, game, params) {
    var cfg = st.cfg, F = features(st, game), neutral = game.neutral === true;
    var sT = [], cT = [], tT = [];
    var seasonHfa = cfg.hfa.kind === 'season';
    /* a neutral site has no home team: no intercept, no home field */
    /* v1 (intercept mode) zeroes only the strength intercept at a neutral site,
       as engine.js does; the season home field has no intercepts at all */
    var bS = seasonHfa || neutral ? 0 : params.spread.b;
    var bC = seasonHfa ? 0 : params.ctx.b;
    var strength = lin(F.spread, params.spread, sT, bS);
    var context = lin(F.ctx, params.ctx, cT, bC);
    var hfa = seasonHfa ? F.hfa : 0;
    var total = lin(F.total, params.total, tT, params.total.b);
    var i, x;
    for (i = 0; i < sT.length; i++) {
      x = sT[i];
      if (PRIOR_TERMS[x.key]) { x.prior = F.prior[x.key] * x.weight; x.current = x.points - x.prior; }
    }
    var margin = strength + context + hfa;
    return { margin: margin, strength: strength, context: context, hfa: hfa, total: total,
      terms: { spread: sT, ctx: cT, total: tT, hfa: hfa }, features: F, season_games: F.season_games };
  }

  /* ------------------------------------------------------------ the card */
  var CARD = [
    { key: 'base_strength', label: 'Base team strength', terms: ['spread:net_pts', 'spread:net_pts_fix', 'spread:net_epa', 'spread:off_epa', 'spread:def_epa', 'spread:pers_rb', 'spread:pers_wr', 'spread:pers_ol', 'spread:mkt_diff'] },
    { key: 'passing', label: 'Passing', terms: ['spread:net_pass', 'spread:pass_off', 'spread:pass_def'] },
    { key: 'rushing', label: 'Rushing', terms: ['spread:net_rush', 'spread:rush_off', 'spread:rush_def'] },
    { key: 'quarterback', label: 'Quarterback', terms: ['spread:qb_adj_diff'] },
    { key: 'home_field', label: 'Home field', terms: ['spread:baseline', 'ctx:baseline', 'ctx:week_frac', 'hfa:hfa'] },
    { key: 'context', label: 'Context (venue, division)', terms: ['spread:div_game', 'ctx:div_game', 'ctx:is_dome', 'ctx:grass'] },
    { key: 'rest_travel', label: 'Rest / travel', terms: ['spread:rest_diff', 'ctx:rest_diff', 'ctx:home_short', 'ctx:away_short', 'ctx:home_off_bye', 'ctx:away_off_bye', 'ctx:travel_diff', 'ctx:tz_diff', 'ctx:west_early'] }
  ];
  /* the engine-shaped term lists (spread / ctx, with the season home field as
     a ctx-side 'hfa' row) so engine.js nfl.card folds them into the same seven rows */
  function engineTerms(pr) {
    var ctx = pr.terms.ctx.slice();
    return { spread: pr.terms.spread, ctx: ctx, hfa: [{ key: 'hfa', value: null, weight: 1, points: pr.hfa }], total: pr.terms.total };
  }

  /* ------------------------------------------------------------ calibration */
  /* isotonic map: sorted knots {x, y}; linear between knots, clipped */
  function calibrate(cal, p) {
    if (!cal || cal.kind !== 'isotonic' || !cal.x || !cal.x.length || !isNum(p)) return p;
    var x = cal.x, y = cal.y, lo = cal.clip ? cal.clip[0] : 0.01, hi = cal.clip ? cal.clip[1] : 0.99, i;
    var v;
    if (p <= x[0]) v = y[0];
    else if (p >= x[x.length - 1]) v = y[y.length - 1];
    else { for (i = 1; i < x.length; i++) if (p <= x[i]) break; var t = (p - x[i - 1]) / (x[i] - x[i - 1] || 1); v = y[i - 1] + t * (y[i] - y[i - 1]); }
    return Math.min(hi, Math.max(lo, v));
  }
  /* pool-adjacent-violators on (p, y) pairs -> knots (fit by the trainer) */
  function fitIsotonic(pairs) {
    var a = pairs.filter(function (q) { return isNum(q[0]) && isNum(q[1]); }).sort(function (u, v) { return u[0] - v[0]; });
    var blocks = [], i;
    for (i = 0; i < a.length; i++) {
      blocks.push({ s: a[i][1], n: 1, lo: a[i][0], hi: a[i][0] });
      while (blocks.length > 1 && blocks[blocks.length - 2].s / blocks[blocks.length - 2].n > blocks[blocks.length - 1].s / blocks[blocks.length - 1].n) {
        var b2 = blocks.pop(), b1 = blocks.pop();
        blocks.push({ s: b1.s + b2.s, n: b1.n + b2.n, lo: b1.lo, hi: b2.hi });
      }
    }
    var x = [], y = [];
    blocks.forEach(function (b) { var m = (b.lo + b.hi) / 2; x.push(m); y.push(b.s / b.n); });
    return { kind: 'isotonic', x: x, y: y, clip: [0.01, 0.99], n: a.length };
  }

  /* ------------------------------------------------------------ ridge */
  /* min ||Xw + b - y||^2 + lam ||w||^2 (intercept unpenalised), or with no
     intercept when withIntercept is false. Gaussian elimination with pivoting. */
  function ridge(X, y, lam, withIntercept) {
    var p = X.length ? X[0].length : 0, q = p + (withIntercept ? 1 : 0), A = [], bv = [], i, j, k, r;
    for (i = 0; i < q; i++) { var z = []; for (j = 0; j < q; j++) z.push(0); A.push(z); bv.push(0); }
    for (r = 0; r < X.length; r++) {
      var row = X[r], yy = y[r];
      for (i = 0; i < q; i++) {
        var xi = i < p ? row[i] : 1;
        bv[i] += xi * yy;
        for (j = i; j < q; j++) A[i][j] += xi * (j < p ? row[j] : 1);
      }
    }
    for (i = 0; i < q; i++) for (j = 0; j < i; j++) A[i][j] = A[j][i];
    for (i = 0; i < p; i++) A[i][i] += lam;
    for (i = 0; i < q; i++) {
      var piv = i;
      for (k = i + 1; k < q; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      var tmp = A[i]; A[i] = A[piv]; A[piv] = tmp; var tb = bv[i]; bv[i] = bv[piv]; bv[piv] = tb;
      if (Math.abs(A[i][i]) < 1e-12) continue;
      for (k = i + 1; k < q; k++) {
        var f = A[k][i] / A[i][i];
        if (!f) continue;
        for (j = i; j < q; j++) A[k][j] -= f * A[i][j];
        bv[k] -= f * bv[i];
      }
    }
    var w = []; for (i = 0; i < q; i++) w.push(0);
    for (i = q - 1; i >= 0; i--) {
      var s = bv[i];
      for (j = i + 1; j < q; j++) s -= A[i][j] * w[j];
      w[i] = Math.abs(A[i][i]) < 1e-12 ? 0 : s / A[i][i];
    }
    return { w: w.slice(0, p), b: withIntercept ? w[p] : 0 };
  }

  /* THE BOARD'S VIEW of a v2 state: the v1 shape every reader in app.html and
     the slate builder already reads (team -> feature -> number, qb, teamQb,
     lmean, ngames, the engine's prior book), with the live v2 state attached
     as .v2 so engine.js predictGame prices from it. Rebuilt after the absorb
     pass; the numbers are snapshots, never written back. */
  function view(st, seededThrough) {
    var out = { team: {}, qb: st.qb, teamQb: st.teamQb, lmean: st.lmean, ngames: st.ngames, season_games: st.games,
      pri: {}, seededThrough: seededThrough, hp: null, v2: st }, t, i, f;
    for (t in st.team) if (st.team.hasOwnProperty(t)) {
      out.team[t] = snapshot(st, t); out.pri[t] = {};
      for (i = 0; i < RATE_FEATS.length; i++) { f = RATE_FEATS[i]; out.pri[t][f] = [priorPart(st, t, f), 1]; }
    }
    return out;
  }

  var API = {
    RATE_FEATS: RATE_FEATS, V1: V1, CARD_ROWS: CARD, view: view,
    config: config, priorWeight: priorWeight, newState: newState, fromSeeds: fromSeeds, team: team,
    rating: rating, priorPart: priorPart, snapshot: snapshot, seasonBreak: seasonBreak,
    absorbGame: absorbGame, absorbCompleted: absorbCompleted, afterGame: afterGame,
    qbEff: qbEff, qbAdjust: qbAdjust, hfaEstimate: hfaEstimate,
    indexStadiums: indexStadiums, travelFor: travelFor, homeOf: homeOf, km: km, utcOffset: utcOffset,
    featureNames: featureNames, features: features, predict: predict, engineTerms: engineTerms,
    calibrate: calibrate, fitIsotonic: fitIsotonic, ridge: ridge
  };
  root.EDNflModel = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
