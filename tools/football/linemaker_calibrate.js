#!/usr/bin/env node
/* ===========================================================================
   THE LINEMAKER'S CALIBRATION RECORD — how EdgeDesk's football probabilities
   for the spread, the moneyline, the total and each TEAM total held up on
   seasons they never saw, and which distribution each market ships with.

   1. THE REPLAY. The shipped engines (football/engine.js for the NFL,
      football/cfb_p4/engine.js for college) are replayed cold from public
      history, a WEEK AT A TIME: every game of a week is projected from the
      state before the week, and only then is the week absorbed. This avoids
      the same-slate look-ahead that a kickoff-order replay allows
      (docs/research-terminal.md §4.7). The market is never passed to a
      projection.
        NFL  football/pricing/lines_nfl.json (scores, closes) + nflverse
             stats_team_week (football/nfl/.cache, public, keyless)
        CFB  cfbfastR schedules (football/cfb_p4/research/.cache/sched,
             public, keyless)
      A replay season with missing input is REFUSED, not skipped: a partial
      replay changes every later rating.

   2. THE CANDIDATES. Each market has candidate distributions, all fitted
      only on seasons before the one being scored:
        NORMAL_RAW    a normal on the engine's number with the training residual sd
        NORMAL_CAL    a normal on the recalibrated number y = a + b·x
        KERNEL_JOINT  each team's points as a kernel-weighted empirical
                      distribution of real scores given its projected points
                      (lib/edgedesk_fairline.js reads exactly this grid), the
                      teams independent, convolved into margin and total
        ENGINE        the shipped engine's own distribution (spread, moneyline,
                      total; there is no engine team total)

   3. THE SCORE. Each game contributes the same events to every candidate,
      anchored on the ENGINE's own number so that no candidate chooses its
      own questions:
        spread / total   win-push-lose at the engine's rounded number + each
                         offset in OFFSETS (whole and half points), and at the
                         market's closing number where the archive has one
        team total       win-push-lose at each team's rounded projection + TEAM_OFFSETS
        moneyline        home win / tie / away win
      The score is the mean multinomial log loss. Brier is reported beside it.

   4. THE CHOICE (written down before any score was read, recorded in the
      file). On the SELECTION window, the lowest mean log loss wins. The
      incumbent ENGINE is kept unless a challenger beats it by at least
      INCUMBENT_MARGIN nats. The CONFIRMATION window and the LIVE season
      (never seen by any fit, and later than the engines' own training cut)
      are reported for the chosen method and its rivals. They are never used
      to choose.

   5. THE STATUS of the chosen method, from the confirmation window's binary
      events (cover given no push). CALIBRATED needs every one of:
        n ≥ 1000
        |mean p − mean y| ≤ 0.02
        logistic calibration slope in [0.85, 1.15]
        no 0.05-wide bin with n ≥ 200 off by more than 0.05
        Brier skill > 0 against climatology (the training seasons'
          unconditional outcome distribution)
      Anything else is PROVISIONAL, with the failed rules listed.

   6. THE LIVE FIT. The chosen method is refitted on every completed season
      up to LIVE_CUT, and its parameters (centres, sds, tie rate, team-points
      grid) are published for lib/edgedesk_fairline.js. The held-out bands
      (observed frequency and Wilson 95% interval per probability bin, out of
      sample only) ship beside them.

   CAVEAT, printed in the file. Both engines' linear weights and residual
   tables were fitted through 2025, so on 2016–2025 they are partly in-sample
   (the cold replay rebuilds team state, not weights). That favours the
   ENGINE candidate. The LIVE season is clean of it.

   Run:
     node tools/football/linemaker_calibrate.js [--sport nfl|cfb|both] [--offline] [--write]
     node tools/football/linemaker_calibrate.js --check     (verify the committed records parse and agree with the rules)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const RC = require(path.join(ROOT, 'lib', 'research_core.js'));
const FL = require(path.join(ROOT, 'lib', 'edgedesk_fairline.js'));
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));
const QB = require(path.join(__dirname, 'build_qb_starts_archive.js'));

const SCHEMA = 'edgedesk_linemaker_calibration_v1';
const VERSION = 1;
const OUT = (s) => path.join(ROOT, 'football', 'validation', 'linemaker_' + s + '.json');

const OFFSETS = [-10, -7, -6, -4, -3, -2.5, -1, 0, 0.5, 1, 3, 3.5, 4, 6, 7, 7.5, 10];
const TEAM_OFFSETS = [-7, -4, -3, -1, 0, 0.5, 1, 3, 3.5, 4, 7];
const INCUMBENT_MARGIN = 0.001;
const KERNEL = { h0: 1.0, grow: 1.25, min_eff: 600, max_iter: 16, normal_mix: 0.03 };
const STATUS_RULES = { min_n: 1000, citl_max: 0.02, slope_lo: 0.85, slope_hi: 1.15, bin_width: 0.05, bin_min_n: 200, bin_max_dev: 0.05, skill_min: 0 };
const BAND = { width: 0.05, min_n: 100 };

const LEAGUES = {
  nfl: { label: 'NFL', sport: 'americanfootball_nfl', first_row: 2010, first_holdout: 2016, selection: [2016, 2020], confirmation: [2021, 2025], live_cut: 2025, live: 2026,
    grid: { p0: 0, step: 0.5, max: 60 }, points_range: [0, 80], margin_range: [-80, 80], total_range: [0, 140] },
  cfb: { label: 'CFB', sport: 'americanfootball_ncaaf', first_row: 2010, first_holdout: 2014, selection: [2014, 2019], confirmation: [2020, 2025], live_cut: 2025, live: 2026,
    grid: { p0: 0, step: 0.5, max: 75 }, points_range: [0, 100], margin_range: [-110, 110], total_range: [0, 180] }
};

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function r5(v) { return v == null ? null : Math.round(v * 100000) / 100000; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function inWin(s, w) { return s >= w[0] && s <= w[1]; }

/* ------------------------------------------------------------- replays */
const NFL_CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
const STW = (s) => path.join(NFL_CACHE, ('https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + s + '.csv').replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const CFB_SCHED = path.join(ROOT, 'football', 'cfb_p4', 'research', '.cache', 'sched');
const SCHED = (y) => path.join(CFB_SCHED, 'sched_' + y + '.csv');

async function ensureInputs(league, offline, lastSeason) {
  const missing = [];
  if (league === 'nfl') { for (let s = 2006; s <= lastSeason; s++) if (!fs.existsSync(STW(s))) missing.push(s); }
  else { for (let y = 2004; y <= lastSeason; y++) if (!fs.existsSync(SCHED(y))) missing.push(y); }
  if (!missing.length || offline) return missing;
  for (const s of missing) {
    const url = league === 'nfl'
      ? 'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + s + '.csv'
      : 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + s + '.csv';
    try {
      const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text(); const f = league === 'nfl' ? STW(s) : SCHED(s);
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); console.log('fetched ' + path.relative(ROOT, f));
    } catch (e) { console.error('could not fetch ' + url + ': ' + e.message); }
  }
  return league === 'nfl' ? [...Array(lastSeason - 2005).keys()].map((i) => 2006 + i).filter((s) => !fs.existsSync(STW(s)))
    : [...Array(lastSeason - 2003).keys()].map((i) => 2004 + i).filter((y) => !fs.existsSync(SCHED(y)));
}

/** the NFL engine replayed week by week; one row per projected game. opts.qbStarts (football/pricing/qb_starts_nfl.json)
    feeds the quarterback layer the listed starters; without it the layer sees no start, as the live board runs. */
function replayNfl(opts) {
  const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
  const E = require(path.join(ROOT, 'football', 'engine.js'));
  const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_nfl.json'), 'utf8'));
  const last = opts.lastSeason;
  const stw = {};
  for (let s = 2006; s <= last; s++) { if (!fs.existsSync(STW(s))) continue; R.parseCsv(fs.readFileSync(STW(s), 'utf8')).forEach((x) => { (stw[x.game_id] = stw[x.game_id] || []).push(x); }); }
  const games = archive.games.filter((g) => g.season >= 2006 && g.season <= last);
  games.sort((a, b) => a.season - b.season || String(a.type).localeCompare(String(b.type)) || a.week - b.week || String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const groups = []; let cur = null;
  for (const g of games) { const k = g.season + '|' + g.type + '|' + g.week; if (!cur || cur.k !== k) { cur = { k, season: g.season, games: [] }; groups.push(cur); } cur.games.push(g); }
  const st = E.nfl.newState(); st.team = {}; st.ngames = {}; st.teamQb = {}; st.qb = {}; st.seededThrough = 2005;
  const rows = []; let season = null, refused = 0, absorbed = 0, noRows = 0, qbWithDev = 0;
  const qbArc = opts.qbStarts && opts.qbStarts.games ? opts.qbStarts : null;
  for (const grp of groups) {
    if (season != null && grp.season !== season) E.nfl.seasonBreak(st);
    season = grp.season;
    for (const g of grp.games) {
      if (g.season < LEAGUES.nfl.first_row) continue;
      const req = { sport: 'nfl', state: st, season: g.season, game: { home: g.home, away: g.away, week: g.week, home_rest: g.ctx.home_rest, away_rest: g.ctx.away_rest, roof: g.ctx.roof, surface: g.ctx.surface, div_game: g.ctx.divisional ? 1 : 0, temp: g.ctx.temp, wind: g.ctx.wind, home_qb_id: g.ctx.home_qb_id, away_qb_id: g.ctx.away_qb_id }, market: {} };
      let p = null; try { p = E.predictGame(req); } catch (_) { p = null; }
      if (p && p.status === 'PREDICTED' && (st.ngames[g.home] || 0) >= 8 && (st.ngames[g.away] || 0) >= 8) {
        rows.push({ id: g.id, season: g.season, week: g.week, type: g.type, m: p.model.fair_spread, t: p.model.fair_total, hs: g.home_score, as: g.away_score,
          close_margin: g.close && g.close.home_line != null ? -g.close.home_line : null, close_total: g.close ? num(g.close.total) : null });
      } else refused++;
    }
    for (const g of grp.games) {
      if (g.home_score == null) continue;
      const pair = stw[g.id]; if (!pair || pair.length !== 2) { noRows++; continue; }
      const h = pair.find((x) => x.team === g.home), a = pair.find((x) => x.team === g.away); if (!h || !a) { noRows++; continue; }
      const hr = E.nfl.teamGameFromStw(h), ar = E.nfl.teamGameFromStw(a);
      hr.pts_for = g.home_score; hr.pts_against = g.away_score; ar.pts_for = g.away_score; ar.pts_against = g.home_score;
      const qbs = qbArc ? QB.startsFor(E, st, qbArc.games[g.id], g.home, g.away) : [];
      qbWithDev += qbs.filter((x) => x[2] != null).length;
      E.nfl.absorbGame(st, [[g.home, hr], [g.away, ar]], qbs); absorbed++;
    }
  }
  const ou = (c) => (c ? { over: c.win, push: c.push, under: c.lose } : null);
  const engine = {
    cover: (raw, thr) => ou(E.dist.coverProbSpread('nfl', raw.home_margin, thr)),
    over: (raw, L) => ou(E.dist.coverProbTotal('nfl', raw.total, L, 'over')),
    winProb: (raw) => E.dist.winProb('nfl', raw.home_margin)
  };
  return { rows, refused, absorbed, no_team_week_rows: noRows, qb_starts_with_pass_dev: qbArc ? qbWithDev : null, engine, version: E.version(), meta: E.meta() };
}

/** the college engine replayed week by week; one row per FBS-v-FBS game */
function replayCfb(opts) {
  global.window = global.window || global;
  require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const P = global.window.EDCfbP4Params;
  const { readCsv } = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'replay_rows.js'));
  const games = [];
  for (let y = 2004; y <= opts.lastSeason; y++) {
    if (!fs.existsSync(SCHED(y))) continue;
    readCsv(SCHED(y)).forEach((r) => {
      const hp = num(r.home_points), ap = num(r.away_points);
      games.push({ id: String(r.game_id), season: num(r.season), week: num(r.week), stype: r.season_type, kick: Date.parse(r.start_date) || 0, home: r.home_team, away: r.away_team,
        home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs', hc: r.home_conference, ac: r.away_conference,
        neutral: String(r.neutral_site).toLowerCase() === 'true', hp, ap, completed: hp != null && ap != null });
    });
  }
  games.sort((a, b) => (a.season - b.season) || String(a.stype).localeCompare(String(b.stype)) || (a.week - b.week) || (a.kick - b.kick) || a.id.localeCompare(b.id));
  const groups = []; let cur = null;
  for (const g of games) { const k = g.season + '|' + g.stype + '|' + g.week; if (!cur || cur.k !== k) { cur = { k, season: g.season, games: [] }; groups.push(cur); } cur.games.push(g); }
  const st = E.strength.newState();
  st.r = {}; st.r0 = {}; st.rf = {}; st.n = {}; st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
  st.lmeanPts = P.rating.league_mean_pts; st.season = 2004;
  let season = 2004, refused = 0, absorbed = 0; const rows = [];
  /* the archive's closing numbers, joined by date and teams for the at-the-close events */
  const close = cfbCloses();
  for (const grp of groups) {
    if (grp.season !== season) { E.ingest.seasonBreak(st); season = grp.season; }
    for (const g of grp.games) {
      if (g.season < LEAGUES.cfb.first_row || !g.home_fbs || !g.away_fbs) continue;
      const out = E.projectGame({ season: g.season, week: g.week, state: st, game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral }, teams: { home: { conference: g.hc }, away: { conference: g.ac } } });
      if (out.status !== 'PREDICTED' || out.model.fair_total == null) { refused++; continue; }
      const unc = (out.layers && out.layers.uncertainty) || {};
      const c = close[g.id] || null;
      rows.push({ id: g.id, season: g.season, week: g.week, type: g.stype, m: out.model.fair_spread, t: out.model.fair_total, sigma: num(unc.sigma), sigma_base: num(unc.sigma_base),
        hs: g.hp, as: g.ap, close_margin: c ? c.margin : null, close_total: c ? c.total : null });
    }
    for (const g of grp.games) {
      if (!g.completed) continue;
      E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral, home_points: g.hp, away_points: g.ap });
      absorbed++;
    }
  }
  const sigmaBase = (P.volatility && P.volatility.sigma_base) || (P.distributions && P.distributions.sigma_margin) || 15;
  const ou = (c) => (c ? { over: c.win, push: c.push, under: c.lose } : null);
  /* the spread exactly as the sheets price it: one distribution per game
     (tools/football/build_fair_lines.js cfbSpreadCover), never the engine's
     per-line read, whose shape changed with the line it priced */
  const cover = require(path.join(__dirname, 'build_fair_lines.js')).cfbSpreadCover(P, E, sigmaBase);
  const engine = {
    cover: (raw, thr) => ou(cover(raw, thr)),
    over: (raw, L) => ou(E.dist.coverProbTotal(raw.total, L, 'over')),
    winProb: (raw) => E.dist.winProb(raw.home_margin, raw.sigma || sigmaBase)
  };
  return { rows, refused, absorbed, engine, version: P.model_version, sigma_base: sigmaBase };
}
function cfbCloses() {
  const out = {};
  try {
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'pricing', 'lines_cfb.json'), 'utf8'));
    (a.games || []).forEach((g) => {
      if (!g.close) return;
      /* the archive keys games by the same id as the schedules (cfbfastR / ESPN) */
      out[String(g.id)] = { margin: g.close.home_line != null ? -g.close.home_line : null, total: num(g.close.total) };
    });
  } catch (_) { /* no archive: at-the-close events are simply absent */ }
  return out;
}

/* ------------------------------------------------------------- fitting */
function ols1(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys); let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx > 0 ? sxy / sxx : 1, a = my - b * mx;
  const sd = Math.sqrt(mean(ys.map((y, i) => (y - (a + b * xs[i])) ** 2)));
  return { a, b, sd };
}
function fit(train, L) {
  const M = train.map((r) => r.hs - r.as), T = train.map((r) => r.hs + r.as);
  const cm = ols1(train.map((r) => r.m), M), ct = ols1(train.map((r) => r.t), T);
  const rawSdM = Math.sqrt(mean(train.map((r, i) => (M[i] - r.m) ** 2))), rawSdT = Math.sqrt(mean(train.map((r, i) => (T[i] - r.t) ** 2)));
  /* team rows on the recalibrated centres */
  const team = [];
  train.forEach((r) => { const mc = cm.a + cm.b * r.m, tc = ct.a + ct.b * r.t; team.push({ p: (tc + mc) / 2, y: r.hs }); team.push({ p: (tc - mc) / 2, y: r.as }); });
  const sdTeam = Math.sqrt(mean(team.map((x) => (x.y - x.p) ** 2)));
  const rawTeamSd = Math.sqrt(mean([].concat(...train.map((r) => [r.hs - (r.t + r.m) / 2, r.as - (r.t - r.m) / 2])).map((x) => x * x)));
  const ties = train.filter((r) => r.hs === r.as).length / train.length;
  const grid = kernelGrid(team, L, sdTeam);
  /* climatology: the unconditional outcome distributions, for the skill baseline */
  const clim = { margin: hist(M), total: hist(T), team: hist([].concat(...train.map((r) => [r.hs, r.as]))) };
  /* residual correlation of the two teams (the independence the joint assumes) */
  const hr = train.map((r) => r.hs - (cm.a + cm.b * r.m + ct.a + ct.b * r.t) / 2), ar = train.map((r) => r.as - (ct.a + ct.b * r.t - (cm.a + cm.b * r.m)) / 2);
  return { cm, ct, rawSdM, rawSdT, sdTeam, rawTeamSd, ties, grid, clim, team_resid_corr: RC.correlation(hr, ar), n: train.length };
}
function hist(vals) { let lo = Infinity, hi = -Infinity; vals.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; }); const p = new Array(hi - lo + 1).fill(0); vals.forEach((v) => { p[v - lo]++; }); return FL.pmf.normalize({ lo, p }); }
/** the kernel team-points grid: at each grid value of projected points, the
    kernel-weighted distribution of real team scores, bandwidth widened until
    the effective sample reaches KERNEL.min_eff */
function kernelGrid(team, L, sdTeam) {
  const g = L.grid, rows = [], maxPts = L.points_range[1];
  const sorted = team.slice().sort((a, b) => a.p - b.p);
  const ps = sorted.map((t) => t.p);
  for (let p = g.p0; p <= g.max + 1e-9; p += g.step) {
    let h = KERNEL.h0, out = null, eff = 0;
    for (let it = 0; it < KERNEL.max_iter; it++) {
      const w = new Float64Array(maxPts + 1); let s = 0, s2 = 0;
      const lo = lowerBound(ps, p - 4 * h), hi = lowerBound(ps, p + 4 * h);
      for (let i = lo; i < hi; i++) { const z = (sorted[i].p - p) / h; const wi = Math.exp(-0.5 * z * z); w[Math.min(maxPts, Math.max(0, sorted[i].y))] += wi; s += wi; s2 += wi * wi; }
      eff = s2 > 0 ? s * s / s2 : 0;
      if (eff >= KERNEL.min_eff || it === KERNEL.max_iter - 1) { out = { w, s, h }; break; }
      h *= KERNEL.grow;
    }
    const probs = Array.from(out.w, (x) => (out.s > 0 ? x / out.s : 0));
    const c = FL.pmf.compact({ lo: 0, p: probs }, 1e-7) || FL.pmf.normal(p, sdTeam, L.points_range[0], L.points_range[1]);
    rows.push({ p: Math.round(p * 100) / 100, lo: c.lo, p: c.p, bandwidth: Math.round(out.h * 100) / 100, eff_n: Math.round(eff) });
  }
  return { p0: g.p0, step: g.step, rows: rows.map((r) => ({ lo: r.lo, p: r.p, bw: r.bandwidth, eff_n: r.eff_n })), sd: sdTeam, normal_mix: KERNEL.normal_mix };
}
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }

/** the `live` model block lib/edgedesk_fairline.js reads, for a given method set */
function modelBlock(F, L, methods) {
  const sd = { NORMAL_RAW: { margin: F.rawSdM, total: F.rawSdT, team: F.rawTeamSd }, NORMAL_CAL: { margin: F.cm.sd, total: F.ct.sd, team: F.sdTeam } };
  const markets = {};
  [['spread', 'margin'], ['moneyline', 'margin'], ['total', 'total'], ['team_total', 'team']].forEach(([mk, kind]) => {
    const m = methods[mk]; markets[mk] = { method: m, sd: sd[m] ? r4(sd[m][kind]) : null };
  });
  return {
    centres: { margin: { a: F.cm.a, b: F.cm.b }, total: { a: F.ct.a, b: F.ct.b } },
    markets, tie_rate: F.ties, team_grid: F.grid,
    margin_range: L.margin_range, total_range: L.total_range, points_range: L.points_range
  };
}

/* ---------------------------------------------------------- scoring */
function wpl(t) { return t ? { w: t.over, p: t.push, l: t.under } : null; }
function outcome(x, L) { return x > L ? 'w' : x === L ? 'p' : 'l'; }
function evAcc() { return { n: 0, ll: 0, br: 0, bin: [], seasons: {} }; }
/** one event's multinomial log loss and Brier */
function evLoss(pr, y) {
  const e = 1e-6;
  const pw = Math.max(e, pr.w), pp = Math.max(e, pr.p), pl = Math.max(e, pr.l), s = pw + pp + pl;
  const py = (y === 'w' ? pw : y === 'p' ? pp : pl) / s;
  const yw = y === 'w' ? 1 : 0, yp = y === 'p' ? 1 : 0, yl = y === 'l' ? 1 : 0;
  return { ll: -Math.log(py), br: (pr.w - yw) ** 2 + (pr.p - yp) ** 2 + (pr.l - yl) ** 2 };
}
function addEv(acc, pr, y, season) {
  if (!pr) return;
  const { ll, br } = evLoss(pr, y);
  const yw = y === 'w' ? 1 : 0;
  acc.n++; acc.ll += ll; acc.br += br;
  const S = acc.seasons[season] = acc.seasons[season] || { n: 0, ll: 0 }; S.n++; S.ll += ll;
  /* the binary event (cover given no push) for calibration diagnostics */
  if (y !== 'p' && pr.w + pr.l > 0) acc.bin.push([pr.w / (pr.w + pr.l), yw]);
}
function summary(acc) { return acc.n ? { n: acc.n, log_loss: r5(acc.ll / acc.n), brier: r5(acc.br / acc.n) } : { n: 0, log_loss: null, brier: null }; }

/** what one candidate says about one game: line-by-line answers for every market */
function provider(r, method, block, engine) {
  const raw = { home_margin: r.m, total: r.t, sigma: r.sigma, sigma_base: r.sigma_base };
  if (method === 'ENGINE') {
    const wp = engine.winProb(raw);
    return { margin: (thr) => engine.cover(raw, thr), total: (L) => engine.over(raw, L), home: null, away: null,
      ml: wp == null ? null : { w: (1 - block.tie_rate) * wp, p: block.tie_rate, l: (1 - block.tie_rate) * (1 - wp) } };
  }
  const d = FL.distributions(raw, block);
  if (d.error) return null;
  const T = (pm) => (pm ? (x) => FL.pmf.tail(pm, x) : null);
  return { margin: T(d.margin), total: T(d.total), home: T(d.home), away: T(d.away),
    ml: d.moneyline ? { w: d.moneyline.home, p: d.moneyline.tie, l: d.moneyline.away } : null };
}
/** every event one game contributes to one market */
function scoreGame(r, mk, pv, accs) {
  if (!pv) return;
  const M = r.hs - r.as, T = r.hs + r.as, s = r.season;
  if (mk === 'spread' && pv.margin) {
    OFFSETS.forEach((o) => { const thr = Math.round(r.m) + o; addEv(accs.ladder, wpl(pv.margin(thr)), outcome(M, thr), s); });
    if (r.close_margin != null) addEv(accs.close, wpl(pv.margin(r.close_margin)), outcome(M, r.close_margin), s);
  } else if (mk === 'total' && pv.total) {
    OFFSETS.forEach((o) => { const thr = Math.round(r.t) + o; if (thr > 0) addEv(accs.ladder, wpl(pv.total(thr)), outcome(T, thr), s); });
    if (r.close_total != null) addEv(accs.close, wpl(pv.total(r.close_total)), outcome(T, r.close_total), s);
  } else if (mk === 'team_total' && pv.home && pv.away) {
    const hp = (r.t + r.m) / 2, ap = (r.t - r.m) / 2;
    TEAM_OFFSETS.forEach((o) => {
      const th = Math.round(hp) + o, ta = Math.round(ap) + o;
      if (th > 0) addEv(accs.ladder, wpl(pv.home(th)), outcome(r.hs, th), s);
      if (ta > 0) addEv(accs.ladder, wpl(pv.away(ta)), outcome(r.as, ta), s);
    });
  } else if (mk === 'moneyline' && pv.ml) {
    addEv(accs.ladder, pv.ml, outcome(M, 0), s);
  }
}
function climatologyScore(r, mk, F, acc) {
  const M = r.hs - r.as, T = r.hs + r.as, s = r.season;
  if (mk === 'spread') OFFSETS.forEach((o) => { const thr = Math.round(r.m) + o; addEv(acc, wpl(FL.pmf.tail(F.clim.margin, thr)), outcome(M, thr), s); });
  else if (mk === 'total') OFFSETS.forEach((o) => { const thr = Math.round(r.t) + o; if (thr > 0) addEv(acc, wpl(FL.pmf.tail(F.clim.total, thr)), outcome(T, thr), s); });
  else if (mk === 'team_total') {
    const hp = (r.t + r.m) / 2, ap = (r.t - r.m) / 2;
    TEAM_OFFSETS.forEach((o) => { const th = Math.round(hp) + o, ta = Math.round(ap) + o; if (th > 0) addEv(acc, wpl(FL.pmf.tail(F.clim.team, th)), outcome(r.hs, th), s); if (ta > 0) addEv(acc, wpl(FL.pmf.tail(F.clim.team, ta)), outcome(r.as, ta), s); });
  } else if (mk === 'moneyline') { const t = FL.pmf.tail(F.clim.margin, 0); addEv(acc, { w: t.over, p: t.push, l: t.under }, outcome(M, 0), s); }
}

/** calibration diagnostics over binary (cover-given-no-push) events */
function diagnostics(pairs, climPairs) {
  const n = pairs.length; if (!n) return { n: 0 };
  const mp = mean(pairs.map((x) => x[0])), my = mean(pairs.map((x) => x[1]));
  /* logistic calibration: y ~ a + b·logit(p), by Newton */
  const lg = (p) => { p = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(p / (1 - p)); };
  let a = 0, b = 1;
  for (let it = 0; it < 30; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (const [p, y] of pairs) { const x = lg(p), q = 1 / (1 + Math.exp(-(a + b * x))), w = q * (1 - q); g0 += y - q; g1 += (y - q) * x; h00 += w; h01 += w * x; h11 += w * x * x; }
    const det = h00 * h11 - h01 * h01; if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det, db = (-h01 * g0 + h00 * g1) / det; a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  const bins = binTable(pairs, STATUS_RULES.bin_width);
  const brier = mean(pairs.map(([p, y]) => (p - y) ** 2));
  const brierClim = climPairs && climPairs.length ? mean(climPairs.map(([p, y]) => (p - y) ** 2)) : null;
  return { n, mean_p: r4(mp), mean_y: r4(my), citl: r4(mp - my), slope: r3(b), intercept: r3(a), brier: r5(brier), brier_climatology: r5(brierClim),
    skill: brierClim ? r4(1 - brier / brierClim) : null, bins };
}
function binTable(pairs, width) {
  const nb = Math.round(1 / width), B = Array.from({ length: nb }, (_, i) => ({ lo: r3(i * width), hi: r3((i + 1) * width), n: 0, sp: 0, sy: 0 }));
  for (const [p, y] of pairs) { const i = Math.min(nb - 1, Math.max(0, Math.floor(p / width))); B[i].n++; B[i].sp += p; B[i].sy += y; }
  return B.map((b) => {
    if (!b.n) return { lo: b.lo, hi: b.hi, n: 0 };
    const w = RC.wilson(b.sy, b.n);
    return { lo: b.lo, hi: b.hi, n: b.n, mean_p: r4(b.sp / b.n), observed: r4(b.sy / b.n), wilson_lo: r4(w.lo), wilson_hi: r4(w.hi) };
  });
}
function statusOf(dg) {
  const R = STATUS_RULES, fails = [];
  if (!(dg.n >= R.min_n)) fails.push('n ' + dg.n + ' < ' + R.min_n);
  if (!(Math.abs(dg.citl) <= R.citl_max)) fails.push('mean probability off the observed rate by ' + dg.citl + ' (limit ' + R.citl_max + ')');
  if (!(dg.slope >= R.slope_lo && dg.slope <= R.slope_hi)) fails.push('calibration slope ' + dg.slope + ' outside [' + R.slope_lo + ', ' + R.slope_hi + ']');
  const bad = (dg.bins || []).filter((b) => b.n >= R.bin_min_n && Math.abs(b.observed - b.mean_p) > R.bin_max_dev);
  if (bad.length) fails.push(bad.length + ' probability bin(s) off by more than ' + R.bin_max_dev + ' (' + bad.map((b) => b.lo + '–' + b.hi).join(', ') + ')');
  if (!(dg.skill > R.skill_min)) fails.push('no Brier skill over climatology (' + dg.skill + ')');
  return { status: fails.length ? 'PROVISIONAL' : 'CALIBRATED', reasons: fails };
}

/* ---------------------------------------------------------- the run */
async function run(league, opts) {
  const L = LEAGUES[league];
  const lastSeason = L.live;
  const missing = await ensureInputs(league, !!opts.offline, lastSeason - 1);
  if (missing.length) return { refused: true, why: 'missing replay input for season(s) ' + missing.join(', ') + (opts.offline ? ' (offline)' : '') };
  const rep = league === 'nfl' ? replayNfl({ lastSeason }) : replayCfb({ lastSeason });
  const rows = rep.rows.filter((r) => r.hs != null && r.as != null && r.m != null && r.t != null);
  const seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b);
  const markets = ['spread', 'moneyline', 'total', 'team_total'];
  const cands = { spread: ['ENGINE', 'NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT'], moneyline: ['ENGINE', 'NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT'], total: ['ENGINE', 'NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT'], team_total: ['NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT'] };
  /* acc[market][candidate][window] = {ladder, close}; clim[market][window] */
  const W = (s) => inWin(s, L.selection) ? 'selection' : inWin(s, L.confirmation) ? 'confirmation' : s === L.live ? 'live' : null;
  const acc = {}, clim = {};
  markets.forEach((mk) => { acc[mk] = {}; clim[mk] = { selection: evAcc(), confirmation: evAcc(), live: evAcc() }; cands[mk].forEach((c) => { acc[mk][c] = { selection: { ladder: evAcc(), close: evAcc() }, confirmation: { ladder: evAcc(), close: evAcc() }, live: { ladder: evAcc(), close: evAcc() } }; }); });
  const fits = {};
  for (const S of seasons) {
    const w = W(S); if (!w) continue;
    const train = rows.filter((r) => r.season < S && r.season !== L.live);
    const test = rows.filter((r) => r.season === S);
    if (train.length < 500 || !test.length) continue;
    const F = fit(train, L); fits[S] = { n_train: F.n, margin: { a: r3(F.cm.a), b: r3(F.cm.b), sd: r3(F.cm.sd) }, total: { a: r3(F.ct.a), b: r3(F.ct.b), sd: r3(F.ct.sd) }, team_sd: r3(F.sdTeam), tie_rate: r4(F.ties), team_resid_corr: r3(F.team_resid_corr) };
    for (const c of ['ENGINE', 'NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT']) {
      const mks = markets.filter((mk) => cands[mk].includes(c)); if (!mks.length) continue;
      const block = modelBlock(F, L, { spread: c, moneyline: c, total: c, team_total: c });
      for (const r of test) { const pv = provider(r, c, block, rep.engine); mks.forEach((mk) => scoreGame(r, mk, pv, acc[mk][c][w])); }
    }
    for (const mk of markets) for (const r of test) climatologyScore(r, mk, F, clim[mk][w]);
  }
  /* the choice, the status, the bands */
  const report = {};
  const chosen = {};
  markets.forEach((mk) => {
    const sel = {};
    cands[mk].forEach((c) => { sel[c] = summary(acc[mk][c].selection.ladder); });
    const incumbent = cands[mk].includes('ENGINE') ? 'ENGINE' : null;
    let best = null;
    cands[mk].forEach((c) => { if (sel[c].n && (best == null || sel[c].log_loss < sel[best].log_loss)) best = c; });
    let pick = best, rule = 'lowest selection-window log loss';
    if (incumbent && best !== incumbent && sel[incumbent].n && !(sel[incumbent].log_loss - sel[best].log_loss >= INCUMBENT_MARGIN)) { pick = incumbent; rule = 'the incumbent is kept: ' + best + ' beat it by less than ' + INCUMBENT_MARGIN + ' nats'; }
    else if (incumbent && best !== incumbent) rule = best + ' beat the incumbent ENGINE by ' + r5(sel[incumbent].log_loss - sel[best].log_loss) + ' nats (margin ' + INCUMBENT_MARGIN + ')';
    chosen[mk] = pick;
    const conf = acc[mk][pick].confirmation.ladder;
    const climConf = clim[mk].confirmation;
    const dg = diagnostics(conf.bin, climConf.bin);
    const st = statusOf(dg);
    /* the bands: every held-out window, chosen method, binary events */
    const allHeld = [].concat(acc[mk][pick].selection.ladder.bin, acc[mk][pick].confirmation.ladder.bin);
    report[mk] = {
      candidates: cands[mk].map((c) => ({ method: c,
        selection: summary(acc[mk][c].selection.ladder), confirmation: summary(acc[mk][c].confirmation.ladder), live: summary(acc[mk][c].live.ladder),
        at_close: { selection: summary(acc[mk][c].selection.close), confirmation: summary(acc[mk][c].confirmation.close), live: summary(acc[mk][c].live.close) } })),
      climatology: { selection: summary(clim[mk].selection), confirmation: summary(clim[mk].confirmation), live: summary(clim[mk].live) },
      chosen: pick, rule, status: st.status, status_reasons: st.reasons,
      diagnostics: { confirmation: dg, live: diagnostics(acc[mk][pick].live.ladder.bin, clim[mk].live.bin) },
      bands: binTable(allHeld, BAND.width),
      /* the same, measured ONLY at the number the market actually closed at:
         where a model disagrees with a posted number its probabilities are
         least trustworthy, and an unconditional table hides that */
      bands_at_market: acc[mk][pick].selection.close.n ? binTable([].concat(acc[mk][pick].selection.close.bin, acc[mk][pick].confirmation.close.bin), BAND.width) : null,
      at_market: acc[mk][pick].confirmation.close.n ? diagnostics(acc[mk][pick].confirmation.close.bin, null) : null,
      by_season: Object.keys(acc[mk][pick].selection.ladder.seasons).concat(Object.keys(acc[mk][pick].confirmation.ladder.seasons)).concat(Object.keys(acc[mk][pick].live.ladder.seasons))
        .map((s) => { const x = acc[mk][pick].selection.ladder.seasons[s] || acc[mk][pick].confirmation.ladder.seasons[s] || acc[mk][pick].live.ladder.seasons[s]; return { season: +s, n: x.n, log_loss: r5(x.ll / x.n) }; })
    };
  });
  /* the live fit: every completed season through the cut */
  const trainLive = rows.filter((r) => r.season <= L.live_cut);
  const FL_ = fit(trainLive, L);
  const live = modelBlock(FL_, L, chosen);
  live.engine_note = chosen.spread === 'ENGINE' || chosen.total === 'ENGINE' || chosen.moneyline === 'ENGINE' ? 'ENGINE markets are computed by the builder with the shipped engine and published as distributions' : null;
  if (league === 'cfb') live.sigma_base = rep.sigma_base;
  /* centre accuracy, raw vs recalibrated vs the close, out of sample */
  const centre = centreAccuracy(rows, L);
  const tiers = readTiers(league);
  markets.forEach((mk) => {
    live.markets[mk].status = report[mk].status; live.markets[mk].status_reasons = report[mk].status_reasons;
    const tk = mk === 'team_total' ? null : mk;
    live.markets[mk].tier = tk && tiers[tk] ? tiers[tk].tier : 'RESEARCH';
    live.markets[mk].tier_basis = tk && tiers[tk] ? tiers[tk].basis : 'no closing team-total line is archived, so this market has never been tested against the market (football/validation/markets_extra.json)';
  });
  live.bands = {}; markets.forEach((mk) => { live.bands[mk] = report[mk].bands; });
  live.bands_at_market = {}; markets.forEach((mk) => { if (report[mk].bands_at_market) live.bands_at_market[mk] = report[mk].bands_at_market; });
  live.band_min_n = BAND.min_n;
  const qb = league === 'nfl' ? qbLayer(rows, L, lastSeason, rep.engine) : null;
  return {
    schema: SCHEMA, version: VERSION, league, sport: L.sport, generated_at: new Date().toISOString(),
    source: 'tools/football/linemaker_calibrate.js',
    frame: {
      engine: league === 'nfl' ? 'football/engine.js ' + (rep.version || '') : 'football/cfb_p4/engine.js ' + (rep.version || ''),
      replay: 'cold from ' + (league === 'nfl' ? 2006 : 2004) + ', a week at a time: every game of a week projected before any of it is absorbed; the market never enters a projection',
      inputs: league === 'nfl' ? 'football/pricing/lines_nfl.json + nflverse stats_team_week (public)' : 'cfbfastR schedules (public); closes from football/pricing/lines_cfb.json',
      rows: rows.length, refused: rep.refused, absorbed: rep.absorbed, seasons: [seasons[0], seasons[seasons.length - 1]],
      windows: { selection: L.selection, confirmation: L.confirmation, live: L.live, live_fit_through: L.live_cut },
      caveat: 'The engines’ linear weights and residual tables were fitted through 2025: on ' + L.selection[0] + '–' + L.confirmation[1] + ' they are partly in-sample (the replay rebuilds team state, not weights), which favours the ENGINE candidate. The ' + L.live + ' season is out of sample for everything.'
    },
    rules: { offsets: OFFSETS, team_offsets: TEAM_OFFSETS, score: 'mean multinomial log loss over win / push / lose events anchored on the engine’s own rounded number', selection: 'lowest selection-window log loss; the incumbent ENGINE is kept unless beaten by at least ' + INCUMBENT_MARGIN + ' nats', status: STATUS_RULES, kernel: KERNEL, band: BAND,
      note: 'Written into the tool before any score was read. Confirmation and live windows are reported, never used to choose.' },
    fits_by_holdout: fits,
    centre_accuracy: centre,
    markets: report,
    live,
    ...(qb ? { qb_layer: qb } : {}),
    note: 'Calibrated against OUTCOMES. Whether a market beats the closing line is a separate question with its own record (football/validation/pricing_' + league + '.json); every market carries that tier beside its status. Nothing here is a betting record.'
  };
}
/** The engine's quarterback layer, measured on this record's own events: the NFL replay again with the listed starters
    absorbed (on) against the replay above (off, the arm the live board runs and every other number here describes).
    ENGINE is the shipped distribution for the spread and the moneyline; the totals cannot move (the quarterback term is not
    a total feature). Paired game by game over the held-out seasons. Whether the layer may move a published number is
    decided by football/validation/pricing_nfl.json (qb_layer), not here. */
function qbLayer(offRows, L, lastSeason, engine) {
  const arc = QB.readArchive();
  if (!arc) return { status: 'NOT_EVALUATED', reasons: ['no quarterback-start archive (' + path.relative(ROOT, QB.OUT) + ')'] };
  const { pairedT } = require(path.join(__dirname, 'validate_pricing.js'));
  const on = replayNfl({ lastSeason, qbStarts: arc });
  const ON = {}; on.rows.filter((r) => r.hs != null && r.as != null && r.m != null && r.t != null).forEach((r) => { ON[r.id] = r; });
  const pairs = offRows.filter((r) => ON[r.id]);
  const W = (s) => inWin(s, L.selection) ? 'selection' : inWin(s, L.confirmation) ? 'confirmation' : s === L.live ? 'live' : null;
  const tie = {}; [...new Set(pairs.map((r) => r.season))].forEach((S) => { const tr = pairs.filter((r) => r.season < S && r.season !== L.live); tie[S] = tr.length >= 500 ? tr.filter((r) => r.hs === r.as).length / tr.length : null; });
  const engineAcc = (get) => {
    const acc = {}; ['spread', 'moneyline'].forEach((mk) => { acc[mk] = {}; ['selection', 'confirmation', 'live'].forEach((w) => { acc[mk][w] = { ladder: evAcc(), close: evAcc() }; }); });
    pairs.forEach((r0) => { const r = get(r0), w = W(r.season); if (!w || tie[r.season] == null) return; const pv = provider(r, 'ENGINE', { tie_rate: tie[r.season] }, engine); scoreGame(r, 'spread', pv, acc.spread[w]); scoreGame(r, 'moneyline', pv, acc.moneyline[w]); });
    const o = {}; Object.keys(acc).forEach((mk) => { const a = acc[mk], dg = diagnostics(a.confirmation.ladder.bin, null);
      o[mk] = { selection: summary(a.selection.ladder), confirmation: summary(a.confirmation.ladder), live: summary(a.live.ladder), at_close_confirmation: summary(a.confirmation.close), confirmation_calibration: { citl: dg.citl, slope: dg.slope, brier: dg.brier } }; });
    return o;
  };
  /* per game, over the held-out seasons: the margin error, the ENGINE cover probability at the close, the ENGINE moneyline */
  const held = pairs.filter((r) => r.season >= L.selection[0] && r.season <= L.confirmation[1] && tie[r.season] != null);
  const raw = (r) => ({ home_margin: r.m, total: r.t });
  const atClose = (r) => evLoss(wpl(engine.cover(raw(r), r.close_margin)), outcome(r.hs - r.as, r.close_margin)).ll;
  const ml = (r) => { const wp = engine.winProb(raw(r)), t = tie[r.season]; return evLoss({ w: (1 - t) * wp, p: t, l: (1 - t) * (1 - wp) }, outcome(r.hs - r.as, 0)).ll; };
  const test = (rows, f) => { const a = rows.map(f), b = rows.map((r) => f(ON[r.id])), p = pairedT(a, b); const d = mean(a) - mean(b);
    return { n: rows.length, off: r5(mean(a)), on: r5(mean(b)), improvement: r5(d), paired_t: p.t, paired_p: p.p, reading: p.p != null && p.p < 0.05 ? (d > 0 ? 'better' : 'worse') : 'no different' }; };
  const tests = { margin_abs_error: test(held, (r) => Math.abs(r.hs - r.as - r.m)), spread_log_loss_at_close: test(held.filter((r) => r.close_margin != null), atClose), moneyline_log_loss: test(held, ml) };
  const reads = Object.values(tests).map((t) => t.reading);
  const verdict = reads.includes('better') ? (reads.includes('worse') ? 'MIXED' : 'BETTER') : reads.includes('worse') ? 'WORSE' : 'NO_DIFFERENCE';
  return {
    question: 'with the listed starters absorbed into the engine’s quarterback layer, are the projections and the shipped ENGINE probabilities any closer to the outcomes?',
    scenario: arc.scenario, scenario_basis: arc.scenario_basis, source: path.relative(ROOT, QB.OUT),
    arms: { off: 'no quarterback starts absorbed, as the live board runs (every other number in this file)', on: 'the listed starter of each side absorbed with his pass deviation' },
    coverage: { rows: pairs.length, starts_with_pass_dev: on.qb_starts_with_pass_dev },
    centre_accuracy: { off: centreAccuracy(pairs, L), on: centreAccuracy(pairs.map((r) => ON[r.id]), L) },
    engine: { off: engineAcc((r) => r), on: engineAcc((r) => ON[r.id]) },
    paired_held_out: Object.assign({ window: L.selection[0] + '-' + L.confirmation[1] }, tests),
    total: { identical: pairs.every((r) => r.t === ON[r.id].t), basis: 'the quarterback term is not a total feature and the layer does not touch the club ratings' },
    verdict,
    verdict_text: verdict === 'NO_DIFFERENCE' ? 'no different: none of the paired held-out comparisons moved by a distinguishable margin' : 'paired held-out readings: ' + Object.keys(tests).map((k) => k + ' ' + tests[k].reading).join(', '),
    promotion: 'decided by football/validation/pricing_nfl.json qb_layer under the feature intake rules; nothing here changes the live distributions',
  };
}
function centreAccuracy(rows, L) {
  const out = {};
  [['selection', L.selection], ['confirmation', L.confirmation], ['live', [L.live, L.live]]].forEach(([k, w]) => {
    const te = rows.filter((r) => inWin(r.season, w));
    if (!te.length) return;
    let n = 0, mr = 0, mc = 0, mk = 0, tr = 0, tc = 0, tk = 0, nk = 0, ntk = 0, rr = 0, rc = 0;
    te.forEach((r) => {
      const M = r.hs - r.as, T = r.hs + r.as; n++;
      mr += Math.abs(M - r.m); tr += Math.abs(T - r.t); rr += (M - r.m) ** 2;
      if (r.close_margin != null) { mk += Math.abs(M - r.close_margin); nk++; }
      if (r.close_total != null) { tk += Math.abs(T - r.close_total); ntk++; }
    });
    out[k] = { n, margin_mae_model: r3(mr / n), margin_rmse_model: r3(Math.sqrt(rr / n)), total_mae_model: r3(tr / n), margin_mae_close: nk ? r3(mk / nk) : null, n_close: nk, total_mae_close: ntk ? r3(tk / ntk) : null, n_close_total: ntk };
  });
  return out;
}
function readTiers(league) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'pricing_' + league + '.json'), 'utf8'));
    const o = {}; Object.keys(v.markets || {}).forEach((k) => { o[k] = { tier: v.markets[k].tier || 'RESEARCH', basis: v.markets[k].tier_basis || null }; });
    return o;
  } catch (_) { return {}; }
}

/* ---------------------------------------------------------- the check */
function check(league) {
  const f = OUT(league);
  if (!fs.existsSync(f)) return ['missing ' + path.relative(ROOT, f)];
  const d = JSON.parse(fs.readFileSync(f, 'utf8')); const errs = [];
  if (d.schema !== SCHEMA) errs.push('schema ' + d.schema);
  ['spread', 'moneyline', 'total', 'team_total'].forEach((mk) => {
    const m = d.markets && d.markets[mk]; if (!m) { errs.push('no ' + mk); return; }
    const lm = d.live && d.live.markets && d.live.markets[mk];
    if (!lm || lm.method !== m.chosen) errs.push(mk + ': the live block does not ship the chosen method');
    if (!['CALIBRATED', 'PROVISIONAL'].includes(m.status)) errs.push(mk + ': status ' + m.status);
    if (lm && lm.status !== m.status) errs.push(mk + ': the live block carries a different status');
    if (mk === 'team_total' && lm && lm.tier === 'VALIDATED') errs.push('team_total cannot carry a market tier with no archive to test it');
  });
  if (!d.live || !d.live.team_grid || !(d.live.team_grid.rows || []).length) errs.push('no team grid');
  return errs;
}

async function main() {
  const a = process.argv.slice(2);
  const which = a.includes('--sport') ? a[a.indexOf('--sport') + 1] : 'both';
  const leagues = which === 'both' ? ['nfl', 'cfb'] : [which];
  if (a.includes('--check')) {
    let bad = 0; leagues.forEach((l) => { const e = check(l); if (e.length) { bad++; console.error('linemaker_' + l + '.json: ' + e.join('; ')); } else console.log('linemaker_' + l + '.json ok'); });
    process.exit(bad ? 1 : 0);
  }
  let exit = 0;
  for (const l of leagues) {
    const t0 = Date.now();
    const out = await run(l, { offline: a.includes('--offline') });
    if (out.refused) { console.error('linemaker calibration (' + l + '): REFUSED — ' + out.why + '; the committed record is left as it is'); exit = 3; continue; }
    console.log('== ' + l.toUpperCase() + ' (' + out.frame.rows + ' rows, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
    Object.keys(out.markets).forEach((mk) => {
      const m = out.markets[mk];
      console.log('  ' + mk.padEnd(11) + ' chosen ' + m.chosen.padEnd(12) + ' ' + m.status + (m.status_reasons.length ? ' (' + m.status_reasons.join('; ') + ')' : ''));
      m.candidates.forEach((c) => console.log('      ' + c.method.padEnd(12) + ' sel ' + c.selection.log_loss + '  conf ' + c.confirmation.log_loss + '  live ' + c.live.log_loss + (c.at_close.confirmation.n ? '  @close conf ' + c.at_close.confirmation.log_loss : '')));
    });
    if (out.qb_layer) { const q = out.qb_layer; console.log('  quarterback layer: ' + (q.verdict || q.status) + (q.paired_held_out ? ' (' + ['margin_abs_error', 'spread_log_loss_at_close', 'moneyline_log_loss'].map((k) => k + ' ' + q.paired_held_out[k].off + ' -> ' + q.paired_held_out[k].on + ' p ' + q.paired_held_out[k].paired_p).join('; ') + ')' : '')); }
    if (a.includes('--write')) console.log('  ' + writeIfChanged(OUT(l), out, { pretty: false }) + ' ' + path.relative(ROOT, OUT(l)));
  }
  process.exit(exit);
}

module.exports = { run, qbLayer, replayNfl, fit, kernelGrid, modelBlock, diagnostics, statusOf, binTable, scoreGame, provider, LEAGUES, OFFSETS, TEAM_OFFSETS, INCUMBENT_MARGIN, STATUS_RULES, KERNEL, BAND, SCHEMA, check };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
