#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — the MAJOR-DISAGREEMENT forensic replay.

   One question drives this file: when the production engine
   (football/cfb_p4/engine.js, the priced V1 number on the board) disagrees
   with the market by 5, 7, 10 or 15 points, what was it actually looking at,
   and was it right to disagree?

   To answer that honestly the replay has to reproduce the production number
   at the production instant, from information that existed then:

     - COLD. The rating state starts empty REPLAY_FROM seasons back; the
       shipped seed ratings already contain the results being projected.
     - FROZEN WEEKLY. Every game is priced from the state at the Tuesday
       12:00 UTC freeze before its kickoff (the validated as-of instant,
       common.prediction_ts_for_kickoff / docs/cfb-weekly/RUNBOOK.md). Games
       are absorbed only once they have finished (kickoff + 4h <= freeze).
     - PRODUCTION INPUTS. The priced terms production can move — rating,
       home field, stylistic matchup (from the SAME efficiency adapter the
       board uses, football/rankings/engine_efficiency.js), schedule stress
       (the SAME schedule index, football/matchup/inputs.js schedCtx) and
       conference — are all live. QB value, travel and rivalry contribute 0 in
       production by design and do so here. Historical injury reports do not
       exist, so the QB-absence term is 0 historically: stated, not hidden.
     - PURE. The engine is never handed a market line. The market is joined
       AFTERWARDS for comparison only, from the cfbfastR multi-book archive
       (opener + close per book, abbreviation resolved to team id by
       intersection, exactly as build_market.py does).

   Beside the engine it records, for the same freeze:
     - the PUBLIC EdgeDesk Rating core (football/rating/edr.js) computed
       point-in-time, so the public rating and the pricing state can be
       compared on the same games;
     - the V2 walk-forward submodels (efficiency, Elo, ridge, GBM, drive) from
       the frozen candidate's predictions, as independent football opinions
       for the cross-model check. They never touch the V1 number.

     node football/cfb_p4/research/disagreement_replay.js --data DIR \
          [--from 2015] [--to 2026] [--replay-from 2007]

   DIR must hold sched/sched_YYYY.csv, betting/cfb_line_odds.csv.gz and
   eff_YYYY.json (football/cfb_p4/research/disagreement_eff.js builds those).
   Writes DIR/out/disagreement_replay.jsonl, one row per projected game.
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var HERE = __dirname;
var ROOT = path.join(HERE, '..', '..', '..');
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var EDR = require(path.join(ROOT, 'football', 'rating', 'edr.js'));
var P = global.window.EDCfbP4Params;

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = String(arg('data', path.join(ROOT, '.cache', 'cfbdata')));
var FROM = parseInt(arg('from', 2015), 10);
var TO = parseInt(arg('to', 2026), 10);
var REPLAY_FROM = parseInt(arg('replay-from', FROM - 8), 10);
var V2_PRED = String(arg('v2', path.join(ROOT, 'football', 'cfb_v2', 'candidates', 'cfb_v2_candidate_001', 'predictions.csv.gz')));
var LAB_2026 = path.join(ROOT, 'football', 'cfb_lab', 'ledger', '2026');
var GAME_HOURS = 4;

/* ------------------------------------------------------------ csv */
function splitLine(line) {
  var out = [], cell = '', q = false, i, c;
  for (i = 0; i < line.length; i++) {
    c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cell); cell = ''; }
    else if (c !== '\r') cell += c;
  }
  out.push(cell);
  return out;
}
function readCsvText(text) {
  var lines = text.split('\n'), head = splitLine(lines[0]), out = [], i, j;
  for (i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    var r = splitLine(lines[i]);
    if (r.length < 2) continue;
    var o = {};
    for (j = 0; j < head.length; j++) o[head[j]] = r[j];
    out.push(o);
  }
  return out;
}
function num(v) {
  if (v == null || v === '' || v === 'NA' || v === 'NaN') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}
function truthy(v) { return String(v).toLowerCase() === 'true'; }
function median(a) {
  a = a.filter(function (x) { return x != null && isFinite(x); }).sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  var m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function sd(a) {
  a = a.filter(function (x) { return x != null && isFinite(x); });
  if (a.length < 2) return null;
  var mu = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - mu) * (x - mu); }, 0) / (a.length - 1));
}
function r3(x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000; }

/* ------------------------------------------------------------ the freeze */
/* the Tuesday 12:00 UTC at or before a kickoff (a Tuesday kickoff before noon
   belongs to the previous week's freeze) */
function freezeFor(kickMs) {
  var d = new Date(kickMs);
  var t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
  var dow = new Date(t).getUTCDay();            /* 0 Sun .. 2 Tue */
  var back = (dow - 2 + 7) % 7;
  t -= back * 864e5;
  if (t > kickMs) t -= 7 * 864e5;
  return t;
}

/* ------------------------------------------------------------ schedules */
var games = [], seasonRows = {};
for (var y = REPLAY_FROM; y <= TO; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) { console.error('[warn] no schedule for ' + y); continue; }
  seasonRows[y] = readCsvText(fs.readFileSync(f, 'utf8'));
  seasonRows[y].forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    var kick = Date.parse(r.start_date);
    if (!isFinite(kick)) return;
    games.push({
      game_id: String(r.game_id), season: num(r.season), week: num(r.week), season_type: r.season_type,
      kick: kick, start_date: r.start_date,
      home: r.home_team, away: r.away_team, home_id: r.home_id, away_id: r.away_id,
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
      home_conference: r.home_conference || null, away_conference: r.away_conference || null,
      conference_game: truthy(r.conference_game),
      neutral_site: truthy(r.neutral_site), venue_id: num(r.venue_id),
      home_points: hp, away_points: ap,
      completed: hp != null && ap != null
    });
  });
}
games.sort(function (a, b) { return (a.kick - b.kick) || (a.game_id < b.game_id ? -1 : 1); });
console.error('[sched] ' + games.length + ' games ' + REPLAY_FROM + '-' + TO);

/* ------------------------------------------------------------ efficiency */
var effBySeason = {};
for (y = REPLAY_FROM; y <= TO; y++) {
  var ef = path.join(DATA, 'eff_' + y + '.json');
  if (fs.existsSync(ef)) effBySeason[y] = JSON.parse(fs.readFileSync(ef, 'utf8'));
}
function teamStatsFor(g) {
  var ds = effBySeason[g.season];
  if (!ds || !ds.games) return null;
  var e = ds.games[g.game_id];
  if (!e || !e.teams) return null;
  var hk = E.normKey(g.home), ak = E.normKey(g.away);
  var h = e.teams[hk] || null, a = e.teams[ak] || null;
  if (!h && !a) return null;
  return { home: h, away: a };
}

/* ------------------------------------------------------------ market */
/* per game: consensus opener and close in the HOME BOOK-LINE convention
   (negative = home favoured), book counts, dispersion, the sharp book */
var market = {};
(function () {
  var f = path.join(DATA, 'betting', 'cfb_line_odds.csv.gz');
  if (!fs.existsSync(f)) { console.error('[warn] no line archive — market comparison skipped'); return; }
  var L = readCsvText(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  var seen = {}, rows = [];
  L.forEach(function (r) {
    if (r.market_type !== 'spread') return;
    var k = [r.game_id, r.abbr, r.book, r.lines, r.opening_lines].join('|');
    if (seen[k]) return; seen[k] = 1;
    rows.push({ gid: String(num(r.game_id)), abbr: r.abbr, book: r.book || 'unknown',
      line: num(r.lines), open: num(r.opening_lines), hid: num(r.home_team_id), aid: num(r.away_team_id) });
  });
  /* abbr -> team id by majority over every game it appears in */
  var cnt = {};
  rows.forEach(function (r) {
    if (r.hid == null || r.aid == null) return;
    [r.hid, r.aid].forEach(function (t) { var k = r.abbr + '|' + t; cnt[k] = (cnt[k] || 0) + 1; });
  });
  var best = {};
  Object.keys(cnt).forEach(function (k) {
    var i = k.lastIndexOf('|'), ab = k.slice(0, i), t = +k.slice(i + 1);
    if (!best[ab] || cnt[k] > best[ab].n) best[ab] = { t: t, n: cnt[k] };
  });
  var byGame = {};
  rows.forEach(function (r) {
    var b = best[r.abbr];
    if (!b || r.hid == null) return;
    var sign = b.t === r.hid ? 1 : (b.t === r.aid ? -1 : 0);
    if (!sign) return;
    var G = byGame[r.gid] || (byGame[r.gid] = {});
    var bk = G[r.book] || (G[r.book] = { close: null, open: null, homeSide: false });
    /* prefer the home side's own row; the away row is the same number negated */
    if (sign === 1 || !bk.homeSide) {
      if (r.line != null) bk.close = sign * r.line;
      if (r.open != null) bk.open = sign * r.open;
      if (sign === 1) bk.homeSide = true;
    }
  });
  Object.keys(byGame).forEach(function (gid) {
    var books = byGame[gid], names = Object.keys(books);
    var closes = names.map(function (b) { return books[b].close; }).filter(function (x) { return x != null; });
    var opens = names.map(function (b) { return books[b].open; }).filter(function (x) { return x != null; });
    var pin = null;
    names.forEach(function (b) { if (/pinnacle/i.test(b) && books[b].close != null) pin = books[b].close; });
    market[gid] = {
      close_home_line: median(closes), open_home_line: median(opens),
      close_books: closes.length, open_books: opens.length,
      close_sd: sd(closes), open_sd: sd(opens),
      close_range: closes.length ? Math.max.apply(null, closes) - Math.min.apply(null, closes) : null,
      pin_close_home_line: pin, source: 'cfbfastR cfb_line_odds'
    };
  });
  console.error('[market] ' + Object.keys(market).length + ' games with a spread');
})();
/* 2026: the Model Lab's own derived OPEN / CLOSE consensus */
(function () {
  var f = path.join(LAB_2026, 'lines.jsonl');
  if (!fs.existsSync(f)) return;
  var n = 0;
  fs.readFileSync(f, 'utf8').split('\n').forEach(function (l) {
    if (!l) return;
    var r = JSON.parse(l);
    if (r.market_type !== 'spread' || r.home_line == null) return;
    var m = market[String(r.game_id)] || (market[String(r.game_id)] = { source: 'cfb_lab ledger 2026' });
    if (r.kind === 'OPEN') { m.open_home_line = r.home_line; m.open_books = r.n_books; }
    if (r.kind === 'CLOSE') { m.close_home_line = r.home_line; m.close_books = r.n_books; n++; }
  });
  console.error('[market] 2026 lab closes: ' + n);
})();

/* ------------------------------------------------------------ V2 submodels */
var v2 = {};
(function () {
  if (!fs.existsSync(V2_PRED)) { console.error('[warn] no V2 predictions'); return; }
  readCsvText(zlib.gunzipSync(fs.readFileSync(V2_PRED)).toString('utf8')).forEach(function (r) {
    v2[String(r.game_id)] = {
      A_adj_eff: num(r.pred_A_adj_eff), B_elo: num(r.pred_B_elo), C_ridge: num(r.pred_C_ridge),
      D_gbm: num(r.pred_D_gbm), E_drive: num(r.pred_E_drive), ens: num(r.ens_equal),
      ens_sd: num(r.ens_sd), sigma: num(r.sigma), reliability: num(r.reliability)
    };
  });
})();

/* ------------------------------------------------------------ EDR, point in time */
var edrSeasonFull = {};                          /* completed season ratings, once each */
function edrGames(season, beforeMs) {
  return (seasonRows[season] || []).filter(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points), k = Date.parse(r.start_date);
    return hp != null && ap != null && isFinite(k) && (beforeMs == null || k + GAME_HOURS * 36e5 <= beforeMs);
  }).map(function (r) {
    return { home_team: r.home_team, away_team: r.away_team, home_points: num(r.home_points),
      away_points: num(r.away_points), neutral: truthy(r.neutral_site),
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs' };
  });
}
function edrFull(season) {
  if (!edrSeasonFull[season]) edrSeasonFull[season] = EDR.rate(edrGames(season, null)).ratings;
  return edrSeasonFull[season];
}
function edrAt(season, T) {
  var now = EDR.rate(edrGames(season, T));
  var priors = [season - 1, season - 2, season - 3].filter(function (s) { return seasonRows[s]; });
  var sr = {};
  priors.forEach(function (s) { sr[s] = edrFull(s); });
  var carry = (seasonRows[season - 2] && seasonRows[season - 1])
    ? EDR.carryoverSlope(edrFull(season - 2), edrFull(season - 1)) : { slope: null };
  var ctx = { now: now.ratings, seasonRatings: sr, priorSeasons: priors,
    carryover: { weight: carry.slope }, bundles: {}, availability: {} };
  return { ctx: ctx, hfa: now.hfa && now.hfa.hfa };
}

/* ------------------------------------------------------------ schedule index */
function scheduleIndex(season) {
  var idx = {};
  (seasonRows[season] || []).forEach(function (g) {
    var t = Date.parse(g.start_date);
    if (!isFinite(t)) return;
    var hk = E.normKey(g.home_team), ak = E.normKey(g.away_team);
    if (hk) (idx[hk] = idx[hk] || []).push({ gid: String(g.game_id), t: t, road: false, oppKey: ak });
    if (ak) (idx[ak] = idx[ak] || []).push({ gid: String(g.game_id), t: t, road: !truthy(g.neutral_site), oppKey: hk });
  });
  Object.keys(idx).forEach(function (k) { idx[k].sort(function (a, b) { return a.t - b.t; }); });
  return idx;
}
/* football/matchup/inputs.js schedCtx, with the ratings read from the
   PREGAME state (the board reads its own current state the same way) */
function schedCtx(idx, st, g, which) {
  var tk = E.normKey(which === 'home' ? g.home : g.away);
  var list = idx[tk];
  if (!list || !list.length) return null;
  var i = -1, j;
  for (j = 0; j < list.length; j++) if (list[j].gid === g.game_id) { i = j; break; }
  if (i < 0) return null;
  var prev = i > 0 ? list[i - 1] : null, next = (i + 1 < list.length) ? list[i + 1] : null;
  var consec = 0; for (j = i - 1; j >= 0 && list[j].road; j--) consec++;
  var road3 = 0; for (j = Math.max(0, i - 3); j < i; j++) if (list[j].road) road3++;
  function rt(k) { return (k && (st.r[k] != null)) ? st.r[k] : null; }
  var out = {
    rest_days: prev ? Math.round((list[i].t - prev.t) / 864e5) : null,
    consecutive_road: i > 0 ? consec : null,
    road_last3: i > 0 ? road3 : null,
    prev_opp_rating: prev ? rt(prev.oppKey) : null,
    next_opp_rating: next ? rt(next.oppKey) : null
  };
  return Object.keys(out).some(function (k) { return out[k] != null; }) ? out : null;
}

/* ------------------------------------------------------------ replay */
var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var byFreeze = {}, freezes = [];
games.forEach(function (g) {
  g.T = freezeFor(g.kick);
  if (!byFreeze[g.T]) { byFreeze[g.T] = []; freezes.push(g.T); }
  byFreeze[g.T].push(g);
});
freezes.sort(function (a, b) { return a - b; });

var absorbQ = games.filter(function (g) { return g.completed; });
var qi = 0, curSeason = REPLAY_FROM, idxCache = {};
/* recency: every team's pregame residuals this season (capped margin minus
   the state's own expectation, measured BEFORE the game is absorbed), and
   the cross-conference graph: FBS-vs-FBS games absorbed this season between
   two different conferences, per conference */
var resid = {}, xconf = {};
function recentResid(k, n) {
  var a = resid[k] || [];
  if (!a.length) return null;
  var t = a.slice(-n), s = 0;
  for (var i = 0; i < t.length; i++) s += t[i];
  return r3(s / t.length);
}
var outDir = path.join(DATA, 'out');
fs.mkdirSync(outDir, { recursive: true });
var outFile = path.join(outDir, 'disagreement_replay.jsonl');
var fd = fs.openSync(outFile, 'w');
var nOut = 0, nRefused = 0;

function comp(out, key) {
  var c = (out.contributions || []).filter(function (x) { return x.key === key; })[0];
  return c ? { pts: r3(c.points), avail: !!c.available } : { pts: null, avail: false };
}

freezes.forEach(function (T) {
  var group = byFreeze[T];
  var season = group[0].season;
  /* absorb every game that had FINISHED before the freeze, in kickoff order */
  while (qi < absorbQ.length && absorbQ[qi].kick + GAME_HOURS * 36e5 <= T) {
    var a = absorbQ[qi++];
    if (a.season !== curSeason) {
      while (curSeason < a.season) { E.ingest.seasonBreak(st); curSeason++; }
      resid = {}; xconf = {};
    }
    (function () {
      var hk = E.normKey(a.home), ak = E.normKey(a.away), hp = st.hp;
      var hfaA = a.neutral_site ? 0 : hp.hfa;
      var mm = Math.max(-hp.cap, Math.min(hp.cap, a.home_points - a.away_points));
      var err = mm - E.strength.predictMargin(st, hk, ak, a.home_fbs, a.away_fbs, hfaA);
      if (a.home_fbs) (resid[hk] = resid[hk] || []).push(err);
      if (a.away_fbs) (resid[ak] = resid[ak] || []).push(-err);
      if (a.home_fbs && a.away_fbs && a.home_conference && a.away_conference && a.home_conference !== a.away_conference) {
        xconf[a.home_conference] = (xconf[a.home_conference] || 0) + 1;
        xconf[a.away_conference] = (xconf[a.away_conference] || 0) + 1;
      }
    })();
    E.ingest.absorbGame(st, {
      home: a.home, away: a.away, home_fbs: a.home_fbs, away_fbs: a.away_fbs,
      neutral_site: a.neutral_site, home_points: a.home_points, away_points: a.away_points,
      team_stats: teamStatsFor(a)
    });
  }
  if (season > curSeason) { while (curSeason < season) { E.ingest.seasonBreak(st); curSeason++; } resid = {}; xconf = {}; }
  if (season < FROM || season > TO) return;
  var proj = group.filter(function (g) { return g.home_fbs || g.away_fbs; });
  if (!proj.length) return;
  var idx = idxCache[season] || (idxCache[season] = scheduleIndex(season));
  var edr = edrAt(season, T);

  proj.forEach(function (g) {
    var req = {
      season: g.season, week: g.week, state: st,
      game: { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
        neutral_site: g.neutral_site, venue_id: g.venue_id, kickoff: g.start_date },
      teams: {
        home: { conference: g.home_conference, schedule: schedCtx(idx, st, g, 'home') },
        away: { conference: g.away_conference, schedule: schedCtx(idx, st, g, 'away') }
      }
    };
    var out = E.projectGame(req);
    if (out.status !== 'PREDICTED') { nRefused++; return; }
    var H = out.layers.strength.preseason_blend;
    var hk = E.normKey(g.home), ak = E.normKey(g.away);
    var mH = out.layers.matchup.home_offence, mA = out.layers.matchup.away_offence;
    var eh = EDR.ratingFor(EDR.teamKey(g.home), edr.ctx), ea = EDR.ratingFor(EDR.teamKey(g.away), edr.ctx);
    var mk = market[g.game_id] || null;
    var V = v2[g.game_id] || null;
    var row = {
      game_id: g.game_id, season: g.season, week: g.week, season_type: g.season_type,
      kickoff: new Date(g.kick).toISOString(), prediction_ts: new Date(T).toISOString(),
      home: g.home, away: g.away, home_conference: g.home_conference, away_conference: g.away_conference,
      home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral_site,
      conference_game: g.conference_game,
      completed: g.completed, final_margin: g.completed ? g.home_points - g.away_points : null,
      home_points: g.home_points, away_points: g.away_points,
      fair: r3(out.model.fair_spread), p_home: r3(out.model.home_win_prob), sigma: r3(out.model.sigma_margin),
      confidence: r3(out.scores.confidence), confidence_priced: r3(out.scores.confidence_priced),
      volatility: r3(out.scores.volatility),
      c: {
        rating: comp(out, 'rating').pts, hfa: comp(out, 'hfa').pts, qb: comp(out, 'qb').pts,
        matchup: comp(out, 'matchup').pts, travel: comp(out, 'travel').pts,
        schedule: comp(out, 'schedule').pts, injury: comp(out, 'injury').pts,
        rivalry: comp(out, 'rivalry').pts, conference: comp(out, 'conference').pts
      },
      c_avail: { matchup: comp(out, 'matchup').avail, schedule: comp(out, 'schedule').avail },
      matchup_home_off: mH && mH.points && mH.points.available ? r3(mH.points.value) : null,
      matchup_away_off: mA && mA.points && mA.points.available ? r3(mA.points.value) : null,
      /* the rating term, taken apart: the long-term carried state vs this
         season's own fresh track, and the learned blend weight between them */
      h_carried: r3(H.home_carried), h_fresh: r3(H.home_this_season),
      a_carried: r3(H.away_carried), a_fresh: r3(H.away_this_season),
      prior_weight: r3(H.prior_weight),
      h_gp: (st.gamesThisSeason[hk] || 0), a_gp: (st.gamesThisSeason[ak] || 0),
      h_n: E.strength.games(st, hk), a_n: E.strength.games(st, ak),
      h_eff_n: (st.effFresh && st.effFresh[hk]) || 0, a_eff_n: (st.effFresh && st.effFresh[ak]) || 0,
      edr_h: eh ? r3(eh.core) : null, edr_a: ea ? r3(ea.core) : null,
      edr_h_gp: eh ? eh.games_played : null, edr_a_gp: ea ? ea.games_played : null,
      edr_hfa: r3(edr.hfa),
      h_recent3: recentResid(hk, 3), a_recent3: recentResid(ak, 3),
      h_season_resid: recentResid(hk, 99), a_season_resid: recentResid(ak, 99),
      h_xconf: g.home_conference ? (xconf[g.home_conference] || 0) : null,
      a_xconf: g.away_conference ? (xconf[g.away_conference] || 0) : null,
      mkt: mk ? {
        open_home_line: mk.open_home_line, close_home_line: mk.close_home_line,
        open_books: mk.open_books || 0, close_books: mk.close_books || 0,
        close_sd: r3(mk.close_sd), open_sd: r3(mk.open_sd), close_range: mk.close_range,
        pin_close_home_line: mk.pin_close_home_line == null ? null : mk.pin_close_home_line,
        source: mk.source
      } : null,
      v2: V
    };
    fs.writeSync(fd, JSON.stringify(row) + '\n');
    nOut++;
  });
});
fs.closeSync(fd);
console.error('[replay] ' + nOut + ' projected, ' + nRefused + ' refused -> ' + outFile);
