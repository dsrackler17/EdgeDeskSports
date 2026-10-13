#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the walk-forward validation, and the live parameters.

     node hockey/model/walkforward.js            (needs the ingest cache for the
                                                  score effects; see --no-cache)
     node hockey/model/walkforward.js --tune     (ratings hyperparameters, SELECTION window only)
     node hockey/model/walkforward.js --check    (the committed record passes its rules)

   THE PROTOCOL (written before any season was scored; do not edit to suit a result)
     1. Ratings are built in ONE chronological pass. Every game on date D is
        predicted from games on dates before D only; then D is absorbed.
     2. Season S is priced by a GLM fitted on the five seasons before S
        (never fewer than one; 2011-2013 are burn-in), with score-state
        weights, score effects, overtime and shootout parameters, and the
        pair recalibration (glm.js) all estimated from seasons before S. The ratings'
        hyperparameters (half-lives, priors) are chosen by --tune on the
        SELECTION window alone.
     3. Windows: SELECTION 2014-2020 · CONFIRMATION 2021 to the last
        completed season (2021-2026 at first publication) · LIVE the season
        in progress (2027 = 2026-27; no fit has seen it).
     4. Choosing a model: the candidate with the lowest moneyline log loss on
        the SELECTION window. A challenger replaces the simplest candidate only
        if it beats it by at least 0.001. The confirmation and live windows are
        reported, never used to choose.
     5. Status OUTCOME_VALIDATED (per market) requires, on CONFIRMATION:
          n >= 1000; it beats the best baseline (Elo or goals-only) with a
          block-bootstrap 95% interval wholly below zero for the moneyline;
          |mean p - mean y| <= 0.02; logistic calibration slope in [0.85, 1.15].
        Anything else is PROVISIONAL, with the failed rules listed.
     6. Market status is NOT_TESTED until a licensed archive of timestamped
        closing prices is on file (hockey/market/closing/*.csv). Without it no
        NHL price may be called an edge, whatever the outcome record says.
     7. Leakage: every scored prediction is audited (engine/validation.js);
        one violation fails --check.

   Writes hockey/validation/nhl_walkforward.json and hockey/model/params/live.json.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const TG = require('../ingest/team_games');
const { RatingState, scoreWeights, dayNum, DEFAULTS, PREDECESSOR } = require('./ratings');
const { LineupState } = require('./lineups');
const { loadLineups } = require('../ingest/lineups');
const GLM = require('./glm');
const DIST = require('./distribution');

/* every completed season after 2020 joins CONFIRMATION; the season in progress is LIVE */
const SELECTION = [2014, 2020], CONFIRMATION = [2021, C.CURRENT_SEASON - 1], LIVE = [C.CURRENT_SEASON, C.CURRENT_SEASON];
const FIRST_SCORED = 2014;
const GLM_WINDOW = 5;
const PARAMS_DIR = path.join(C.HOCKEY, 'model', 'params');
const OUT = path.join(C.PATHS.validation, 'nhl_walkforward.json');
const BASELINES = ['elo', 'goals_only', 'const_home'];

function arg(name) { return process.argv.includes('--' + name); }
function inWin(s, w) { return s >= w[0] && s <= w[1]; }
function predictedAt(g) { const t = Date.parse(g.start_utc); return isFinite(t) ? t - 30 * 60e3 : Date.parse(g.date + 'T12:00:00Z'); }

/* ---------- per-season parameters from earlier seasons only ---------- */
function otParams(rows, season) {
  /* rows: team-game rows of earlier seasons (home rows only), regular season, tied after regulation */
  const fmt3 = season >= 2016;
  const pick = rows.filter((r) => r.home === 1 && r.type === 'R' && r.gf_reg === r.ga_reg && (fmt3 ? r.season >= 2016 : true));
  const use = pick.length >= 150 ? pick : rows.filter((r) => r.home === 1 && r.type === 'R' && r.gf_reg === r.ga_reg);
  const n = use.length; const ot = use.filter((r) => r.decided === 'OT').length; const so = use.filter((r) => r.decided === 'SO');
  const soHome = (so.filter((r) => r.win === 1).length + 50) / (so.length + 100);
  const all = rows.filter((r) => r.type === 'R');
  const lam = all.length ? all.reduce((a, r) => a + r.gf_reg, 0) / all.length : 2.9;
  const pOt = n ? ot / n : 0.6;
  const k = -Math.log(Math.max(0.01, 1 - pOt)) * 60 / (10 * lam);
  return { format: fmt3 ? 'R3v3' : 'R4v4', k: +k.toFixed(4), so_home: +soHome.toFixed(4), p_ot_decided: +pOt.toFixed(4), n_tied: n, lam_reg: +lam.toFixed(3), basis: fmt3 && pick.length < 150 ? 'no 3-on-3 season before this one: the 4-on-4 rate is used' : 'seasons before' };
}

function effectsFor(season, cacheOk) {
  const file = path.join(PARAMS_DIR, 'effects_for_' + season + '.json');
  if (cacheOk) {
    const { readSeason } = require('../ingest/season');
    const games = [];
    for (let s = Math.max(C.FIRST_SEASON, season - 4); s <= season - 1; s++) {
      try { for (const r of readSeason(s)) games.push({ goals: r.shots.filter((x) => x.goal && x.gs < 3600).map((x) => ({ t: x.gs, side: x.side })) }); } catch (_) { /* season not cached */ }
    }
    if (games.length >= 1000) {
      const e = DIST.estimateScoreEffects(games);
      delete e.cells;
      e.for_season = season; e.games = games.length;
      fs.mkdirSync(PARAMS_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(e));
      return e;
    }
  }
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

/* ---------- Elo baseline (FiveThirtyEight's published NHL method, tuned on SELECTION) ---------- */
function eloPass(games, k, hfa, revert) {
  const R = new Map(); let season = null; const out = new Map();
  const get = (t) => (R.has(t) ? R.get(t) : 1500);
  for (const g of games) {
    if (g.season !== season) { for (const [t, v] of R) R.set(t, revert * v + (1 - revert) * 1500); season = g.season; }
    const diff = get(g.home) - get(g.away) + hfa;
    const p = 1 / (1 + Math.pow(10, -diff / 400));
    out.set(g.game_id, p);
    const y = g.hw;
    const mov = Math.abs(g.final_home - g.final_away) || 1;
    const mult = 0.6686 * Math.log(mov) + 0.8048;
    const d = k * mult * (y - p);
    R.set(g.home, get(g.home) + d); R.set(g.away, get(g.away) - d);
  }
  return out;
}

function loadGames(seasons) {
  const rows = TG.loadTeamGames(seasons);
  const byId = new Map();
  for (const r of rows) { if (!byId.has(r.game_id)) byId.set(r.game_id, {}); byId.get(r.game_id)[r.home ? 'h' : 'a'] = r; }
  const games = [...byId.values()].filter((x) => x.h && x.a).map((x) => ({
    game_id: x.h.game_id, season: x.h.season, type: x.h.type, date: x.h.date, start_utc: x.h.start_utc, available_at: x.h.assumed_available_at,
    home: x.h.team, away: x.a.team, final_home: x.h.gf, final_away: x.a.gf, reg_home: x.h.gf_reg, reg_away: x.a.gf_reg, decided: x.h.decided,
    hw: x.h.win, h: x.h, a: x.a,
  })).sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : (predictedAt(p) - predictedAt(q)) || p.game_id - q.game_id));
  return { rows, games };
}

function seasonParams(rows, seasons, cacheOk) {
  const P = {};
  for (const s of seasons) {
    const prior = rows.filter((r) => r.season >= s - 3 && r.season < s);
    P[s] = { sw: prior.length ? scoreWeights(prior) : { lead: 1, tie: 1, trail: 1 }, ot: otParams(prior, s), effects: s >= FIRST_SCORED ? effectsFor(s, cacheOk) : null };
    if (!prior.length) P[s].ot = { format: 'R4v4', k: 1, so_home: 0.5, basis: 'burn-in: no earlier season' };
  }
  return P;
}

/* lineup features of one team-game snapshot pair (lineups.js); conf is null when the box score is absent */
function lineupFeatures(luOwn, luOpp) {
  return { lu_own_proj: luOwn.proj, lu_opp_proj: luOpp.proj, lu_own_conf: luOwn.conf, lu_opp_conf: luOpp.conf, lu_known: luOwn.known && luOpp.known };
}

/* one chronological ratings pass: games on date D see only games before D.
   `lineups` (game_id -> { home, away } dressed skaters) is optional. */
function ratingsPass(games, P, ratingParams, lineups) {
  const rs = new RatingState(ratingParams);
  const ls = new LineupState(null, PREDECESSOR);
  const snaps = new Map();
  let curSeason = null, maxKnown = null;
  let i = 0;
  while (i < games.length) {
    const date = games[i].date; let j = i;
    while (j < games.length && games[j].date === date) j++;
    const day = games.slice(i, j);
    if (day[0].season !== curSeason) { curSeason = day[0].season; rs.sw = P[curSeason].sw; }
    for (const g of day) {
      const fh = rs.snapshot(g.home, g.away, true, g.date, { opp: g.a.g_start });
      const fa = rs.snapshot(g.away, g.home, false, g.date, { opp: g.h.g_start });
      if (lineups) {
        const lu = lineups.get(g.game_id);
        const ids = (side) => (lu && lu[side] && lu[side].length ? lu[side].map((x) => x[0]) : null);
        const lh = ls.snapshot(g.home, ids('home')), la = ls.snapshot(g.away, ids('away'));
        Object.assign(fh, lineupFeatures(lh, la)); Object.assign(fa, lineupFeatures(la, lh));
        fh.lu_box = fa.lu_box = !!lu;
      }
      snaps.set(g.game_id, { fh, fa, inputs_known_at: maxKnown });
    }
    for (const g of day) {
      rs.absorb([g.h, g.a]); const k = Date.parse(g.available_at); if (maxKnown == null || k > maxKnown) maxKnown = k;
      const lu = lineups && lineups.get(g.game_id);
      if (lu) { if (lu.home.length) ls.absorb(g.home, lu.home); if (lu.away.length) ls.absorb(g.away, lu.away); }
    }
    i = j;
  }
  return { snaps, state: rs, lineups: ls };
}

function trainRows(games, snaps, S) {
  const from = Math.max(C.FIRST_SEASON + 1, S - GLM_WINDOW);
  const train = [];
  for (const g of games) if (g.season >= from && g.season < S) { const sn = snaps.get(g.game_id); train.push({ f: sn.fh, y: g.reg_home }, { f: sn.fa, y: g.reg_away }); }
  return train;
}

/* the common-shock share, by likelihood of the regulation score on the three seasons before S */
function fitRho(games, snaps, S, fit, P) {
  const pool = games.filter((g) => g.season >= S - 3 && g.season < S);
  const step = Math.max(1, Math.floor(pool.length / 3000));
  const sample = pool.filter((_, i) => i % step === 0);
  const grid = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35];
  let best = null; const curve = [];
  for (const rho of grid) {
    let ll = 0;
    for (const g of sample) {
      const sn = snaps.get(g.game_id);
      const eff = P[g.season].effects || DIST.neutralEffects();
      const D = DIST.game({ lamH: GLM.predict(fit, sn.fh), lamA: GLM.predict(fit, sn.fa), effects: eff, rho, ot: { k: 1, so_home: 0.5, format: 'R3v3' } });
      ll += -Math.log(Math.max(1e-12, DIST.regProb(D, g.reg_home, g.reg_away)));
    }
    curve.push({ rho, nll: +(ll / sample.length).toFixed(5) });
    if (!best || ll < best.ll) best = { rho, ll };
  }
  return { rho: best.rho, n: sample.length, seasons: [S - 3, S - 1], curve };
}

/* the selection-window score of one ratings configuration (tuning never reads later windows) */
function selectionScore(games, P, ratingParams, cand) {
  const { snaps } = ratingsPass(games, P, ratingParams);
  let ll = 0, n = 0;
  for (let S = SELECTION[0]; S <= SELECTION[1]; S++) {
    const fit = GLM.fit(trainRows(games, snaps, S), GLM.CANDIDATES[cand]);
    for (const g of games) {
      if (g.season !== S) continue;
      const sn = snaps.get(g.game_id);
      const D = DIST.game({ lamH: GLM.predict(fit, sn.fh), lamA: GLM.predict(fit, sn.fa), effects: P[S].effects || DIST.neutralEffects(), ot: g.type === 'P' ? { format: 'PO' } : P[S].ot });
      ll += V.logLoss(D.p_home, g.hw); n++;
    }
  }
  return ll / n;
}

const TUNING = path.join(PARAMS_DIR, 'tuning.json');
function tune() {
  const seasons = []; for (let s = C.FIRST_SEASON; s <= SELECTION[1]; s++) seasons.push(s);
  const { rows, games } = loadGames(seasons);
  const cacheOk = fs.existsSync(path.join(C.PATHS.cacheWork, 'games_' + (C.CURRENT_SEASON - 1) + '.jsonl.gz'));
  const P = seasonParams(rows, seasons, cacheOk);
  const grid = [];
  let best = null;
  const tryP = (rp) => { const ll = selectionScore(games, P, rp, 'xg_goalie_projected'); grid.push(Object.assign({ selection_ml_log_loss: +ll.toFixed(5) }, rp)); console.log('[tune] ' + JSON.stringify(rp) + ' → selection ML LL ' + ll.toFixed(5)); if (!best || ll < best.ll) best = { ll, rp }; };
  for (const hl of [45, 75, 120, 180, 270, 400]) for (const pg of [4, 8, 16, 32]) tryP({ half_life_days: hl, prior_games: pg });
  const base = Object.assign({}, best.rp);
  for (const gx of [30, 120, 250]) tryP(Object.assign({}, base, { goalie_prior_xg: gx }));
  for (const ghl of [200, 800]) tryP(Object.assign({}, best.rp, { goalie_half_life_days: ghl }));
  const out = { schema: 'edgedesk_nhl_tuning_v1', generated_at: new Date().toISOString(), rule: 'ratings hyperparameters chosen by SELECTION-window (2014-2020) moneyline log loss of xg_goalie_projected; no later season is read', chosen: Object.assign({}, DEFAULTS, best.rp), selection_ml_log_loss: +best.ll.toFixed(5), grid };
  fs.mkdirSync(PARAMS_DIR, { recursive: true });
  fs.writeFileSync(TUNING, JSON.stringify(out, null, 1));
  console.log('[tune] chosen ' + JSON.stringify(out.chosen));
}

function main() {
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const { rows, games } = loadGames(seasons);
  const cacheOk = !arg('no-cache') && fs.existsSync(path.join(C.PATHS.cacheWork, 'games_' + (C.CURRENT_SEASON - 1) + '.jsonl.gz'));
  const P = seasonParams(rows, seasons, cacheOk);
  const tuned = fs.existsSync(TUNING) ? JSON.parse(fs.readFileSync(TUNING, 'utf8')).chosen : DEFAULTS;
  /* lineups (hockey/ingest/lineups.js): every scored season must have its box scores, or the lineup candidates sit out */
  const LU = loadLineups(seasons);
  const scoredSeasons = seasons.filter((s) => s >= FIRST_SCORED);
  const lineupOk = !arg('no-lineups') && scoredSeasons.filter((s) => s < C.CURRENT_SEASON).every((s) => LU.absent.indexOf(s) < 0);
  const { snaps } = ratingsPass(games, P, tuned, lineupOk ? LU.map : null);
  const luCover = lineupOk ? games.filter((g) => g.season >= FIRST_SCORED && LU.map.has(g.game_id)).length : 0;
  const lineupInfo = {
    available: lineupOk,
    source: 'per-game skater box scores (sportsdataverse fastRhockey skater_box, from the NHL game feeds)',
    coverage: lineupOk ? { scored_games: games.filter((g) => g.season >= FIRST_SCORED).length, with_box_score: luCover } : null,
    absent_seasons: LU.absent,
    method: 'player value = recent TOI per game (last 20 of his games, any team) shrunk toward 10 min with 3 games of prior; lineup value = sum over the dressed skaters; feature = ln(lineup value / the team\'s mean over its last 10 games, re-valued today). Projected = the previous game\'s lineup; confirmed = the lineup that dressed.',
    assumption: 'the dressed lineup is known at warmups, about 30 minutes before puck drop (the prediction time). No injury report is used; nothing about the game itself enters its own snapshot.',
    added: 'the three lineup candidates were declared on 2026-10-13, after the confirmation window had been read for the original five; the selection rule is unchanged.',
  };

  /* Elo: tuned on SELECTION only */
  let bestElo = null;
  for (const k of [4, 6, 8, 10, 12]) for (const hfa of [20, 35, 50, 65]) for (const rev of [0.5, 0.7]) {
    const pr = eloPass(games, k, hfa, rev);
    let ll = 0, n = 0;
    for (const g of games) if (inWin(g.season, SELECTION)) { ll += V.logLoss(pr.get(g.game_id), g.hw); n++; }
    if (!bestElo || ll / n < bestElo.ll) bestElo = { k, hfa, revert: rev, ll: ll / n };
  }
  const eloP = eloPass(games, bestElo.k, bestElo.hfa, bestElo.revert);

  /* per-season GLM fits: raw λ for every game of season S from a fit on seasons before S */
  const cands = Object.keys(GLM.CANDIDATES).filter((c) => lineupOk || GLM.LINEUP_CANDIDATES.indexOf(c) < 0);
  const fits = {}; const raw = new Map(); /* game_id → { c: { lh, la } } */
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    const train = trainRows(games, snaps, S);
    fits[S] = {};
    for (const c of cands) fits[S][c] = GLM.fit(train, GLM.CANDIDATES[c]);
    for (const g of games) {
      if (g.season !== S) continue;
      const sn = snaps.get(g.game_id); const o = {};
      for (const c of cands) o[c] = { lh: GLM.predict(fits[S][c], sn.fh), la: GLM.predict(fits[S][c], sn.fa) };
      raw.set(g.game_id, o);
    }
  }
  /* pair recalibration for season S from the out-of-sample predictions of the three seasons before it */
  const cal = {};
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    cal[S] = {};
    for (const c of cands) {
      const rowsCal = games.filter((g) => g.season >= Math.max(FIRST_SCORED, S - 3) && g.season < S && raw.has(g.game_id)).map((g) => ({ lh: raw.get(g.game_id)[c].lh, la: raw.get(g.game_id)[c].la, gh: g.reg_home, ga: g.reg_away }));
      cal[S][c] = GLM.fitPairCalibration(rowsCal);
    }
    P[S].pair_calibration = cal[S].xg_goalie_projected;
  }
  const preds = [];
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    const eff = P[S].effects || DIST.neutralEffects();
    for (const g of games) {
      if (g.season !== S) continue;
      const sn = snaps.get(g.game_id);
      const row = { game_id: g.game_id, season: S, type: g.type, date: g.date, home: g.home, away: g.away, start_utc: g.start_utc,
        y: { hw: g.hw, reg: g.reg_home > g.reg_away ? 0 : g.reg_home === g.reg_away ? 1 : 2, total: g.final_home + g.final_away, margin: g.final_home - g.final_away, reg_home: g.reg_home, reg_away: g.reg_away },
        predicted_at: predictedAt(g), inputs_known_at: sn.inputs_known_at, p: {} };
      const ot = g.type === 'P' ? { format: 'PO' } : P[S].ot;
      for (const c of cands) {
        const rw = raw.get(g.game_id)[c];
        const { lh, la } = GLM.applyPairCalibration(rw.lh, rw.la, cal[S][c]);
        const D = DIST.game({ lamH: lh, lamA: la, effects: eff, ot });
        const pmf = DIST.totalPmf(D);
        row.p[c] = {
          lamH: +lh.toFixed(4), lamA: +la.toFixed(4), ml: D.p_home, reg: [D.reg.home, D.reg.draw, D.reg.away],
          pl_home: DIST.spread(D, -1.5).win, pl_away: DIST.spread(D, 1.5).lose,
          o55: DIST.total(D, 5.5).over, o65: DIST.total(D, 6.5).over, pmf, exp_total: DIST.expectedTotal(D),
        };
      }
      row.p.elo = { ml: eloP.get(g.game_id) };
      preds.push(row);
    }
  }

  /* per-game predictions for the market test (hockey/model/market_test.js); cache only */
  try {
    fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
    const chosenNow = 'xg_no_goalie';
    fs.writeFileSync(path.join(C.PATHS.cacheWork, 'predictions.jsonl'), preds.map((r) => JSON.stringify({ game_id: r.game_id, season: r.season, type: r.type, date: r.date, start_utc: r.start_utc, predicted_at: new Date(r.predicted_at).toISOString(), home: r.home, away: r.away,
      p: Object.fromEntries(Object.entries(r.p).filter(([c]) => c !== 'elo').map(([c, v]) => [c, { ml: v.ml, pl_home: v.pl_home, pl_away: v.pl_away, o55: v.o55, o65: v.o65, exp_total: v.exp_total }])), y: r.y })).join('\n') + '\n');
    void chosenNow;
  } catch (_) { /* a read-only cache is not fatal */ }

  /* ---------- scoring ---------- */
  const leak = V.leakageAudit(preds.map((r) => ({ id: r.game_id, predicted_at: r.predicted_at, event_start: Date.parse(r.start_utc) || (r.predicted_at + 1), inputs_known_at: r.inputs_known_at })));
  const allC = cands.concat(['elo']);
  function metrics(sub, c) {
    const ml = V.binary(sub.map((r) => ({ p: r.p[c].ml, y: r.y.hw })));
    const out = { n: sub.length, moneyline: ml };
    if (c === 'elo') return out;
    let reg = 0, regB = 0, rps = 0, bias = 0;
    for (const r of sub) { reg += V.mlogLoss(r.p[c].reg, r.y.reg); regB += V.mbrier(r.p[c].reg, r.y.reg); rps += V.rps(r.p[c].pmf, Math.min(r.y.total, r.p[c].pmf.length - 1)); bias += r.p[c].exp_total - r.y.total; }
    const n = sub.length || 1;
    const pd = sub.reduce((a, r) => a + r.p[c].reg[1], 0) / n, yd = sub.reduce((a, r) => a + (r.y.reg === 1 ? 1 : 0), 0) / n;
    out.regulation_3way = { log_loss: V.r(reg / n, 5), brier: V.r(regB / n, 5), mean_p_draw: V.r(pd), observed_draw: V.r(yd) };
    out.puck_line_home_minus_1_5 = V.binary(sub.map((r) => ({ p: r.p[c].pl_home, y: r.y.margin >= 2 ? 1 : 0 })));
    out.puck_line_away_minus_1_5 = V.binary(sub.map((r) => ({ p: r.p[c].pl_away, y: r.y.margin <= -2 ? 1 : 0 })));
    out.total_over_5_5 = V.binary(sub.map((r) => ({ p: r.p[c].o55, y: r.y.total > 5.5 ? 1 : 0 })));
    out.total_over_6_5 = V.binary(sub.map((r) => ({ p: r.p[c].o65, y: r.y.total > 6.5 ? 1 : 0 })));
    out.total_goals = { rps: V.r(rps / n, 5), mean_bias: V.r(bias / n, 4) };
    return out;
  }
  const slim = (m) => {
    if (!m) return m;
    const o = JSON.parse(JSON.stringify(m));
    for (const k of Object.keys(o)) if (o[k] && o[k].bins && k !== 'moneyline') delete o[k].bins;
    return o;
  };
  const bySeason = {};
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    const sub = preds.filter((r) => r.season === S);
    bySeason[S] = {};
    for (const c of allC) { const m = metrics(sub, c); delete m.moneyline.bins; bySeason[S][c] = slim(m); }
  }
  const windows = {};
  for (const [name, w] of Object.entries({ selection: SELECTION, confirmation: CONFIRMATION, live: LIVE })) {
    const sub = preds.filter((r) => inWin(r.season, w));
    windows[name] = { seasons: w, n: sub.length, by_candidate: {} };
    for (const c of allC) windows[name].by_candidate[c] = slim(metrics(sub, c));
    windows[name].regular_season_n = sub.filter((r) => r.type === 'R').length;
    windows[name].playoff_n = sub.filter((r) => r.type === 'P').length;
  }

  /* ---------- selection (rule 4) ---------- */
  const selLL = (c) => windows.selection.by_candidate[c].moneyline.log_loss;
  const simplest = 'goals_only';
  let chosen = simplest;
  for (const c of ['xg_no_goalie', 'xg_goalie_projected'].concat(lineupOk ? ['xg_lineup_projected'] : [])) if (selLL(c) <= selLL(chosen) - 0.001) chosen = c;
  /* the confirmed-starter variant is the same model with the announced goalie; it is reported, and used when a starter is confirmed */
  const selection = { rule: 'lowest selection-window moneyline log loss; a challenger must beat the incumbent by >= 0.001', ll: Object.fromEntries(allC.map((c) => [c, selLL(c)])), chosen, confirmed_variant: 'xg_goalie_confirmed' };

  /* ---------- paired comparisons on CONFIRMATION ---------- */
  const conf = preds.filter((r) => inWin(r.season, CONFIRMATION));
  const pair = (a, b) => V.pairedBootstrap(conf.map((r) => ({ date: r.date, a: V.logLoss(r.p[a].ml, r.y.hw), b: V.logLoss(r.p[b].ml, r.y.hw) })), { B: 1000 });
  const comparisons = {};
  for (const b of BASELINES) comparisons[chosen + '_vs_' + b] = pair(chosen, b);
  comparisons.xg_goalie_confirmed_vs_xg_goalie_projected = pair('xg_goalie_confirmed', 'xg_goalie_projected');
  comparisons.xg_goalie_projected_vs_xg_no_goalie = pair('xg_goalie_projected', 'xg_no_goalie');
  if (lineupOk) {
    comparisons.xg_lineup_projected_vs_xg_no_goalie = pair('xg_lineup_projected', 'xg_no_goalie');
    comparisons.xg_lineup_confirmed_vs_xg_no_goalie = pair('xg_lineup_confirmed', 'xg_no_goalie');
    comparisons.xg_all_confirmed_vs_xg_goalie_confirmed = pair('xg_all_confirmed', 'xg_goalie_confirmed');
  }

  /* ---------- status (rule 5) ---------- */
  function status(market, getter, baselineBeat) {
    const m = getter(windows.confirmation.by_candidate[chosen]);
    const fails = [];
    if (!m || m.n < 1000) fails.push('n ' + (m ? m.n : 0) + ' < 1000');
    if (m && Math.abs(m.calibration_in_the_large) > 0.02) fails.push('mean p off by ' + m.calibration_in_the_large);
    if (m && (m.calibration_slope == null || m.calibration_slope < 0.85 || m.calibration_slope > 1.15)) fails.push('calibration slope ' + m.calibration_slope);
    if (baselineBeat === false) fails.push('does not beat the best baseline with a 95% interval below zero');
    return { market, status: fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED', failed: fails, n: m ? m.n : 0, brier: m ? m.brier : null, log_loss: m ? m.log_loss : null, calibration_in_the_large: m ? m.calibration_in_the_large : null, calibration_slope: m ? m.calibration_slope : null, market_status: 'NOT_TESTED', market_reason: 'no licensed archive of timestamped NHL closing prices is on file (hockey/market/closing/); until one is, no NHL price is called an edge' };
  }
  const bestBaseline = BASELINES.reduce((b, c) => (windows.confirmation.by_candidate[c].moneyline.log_loss < windows.confirmation.by_candidate[b].moneyline.log_loss ? c : b), BASELINES[0]);
  const beatsBest = comparisons[chosen + '_vs_' + bestBaseline].a_better;
  const markets = {
    moneyline: status('moneyline', (x) => x.moneyline, beatsBest),
    puck_line_home_minus_1_5: status('puck line (home −1.5)', (x) => x.puck_line_home_minus_1_5, null),
    puck_line_away_minus_1_5: status('puck line (away −1.5)', (x) => x.puck_line_away_minus_1_5, null),
    total_over_5_5: status('total 5.5', (x) => x.total_over_5_5, null),
    total_over_6_5: status('total 6.5', (x) => x.total_over_6_5, null),
  };
  /* rule 6: a market test, when a licensed closing archive has been evaluated */
  const mt = (() => { try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nhl_market.json'), 'utf8')); } catch (_) { return null; } })();
  if (mt && mt.markets) for (const [k, v] of Object.entries(mt.markets)) if (markets[k] && v.status) { markets[k].market_status = v.status; markets[k].market_reason = v.why; markets[k].market_n = v.n; }
  markets.regulation_3way = { market: 'regulation 3-way', status: 'PROVISIONAL', failed: ['no binary calibration rule defined for a 3-way market yet; log loss reported'], log_loss: windows.confirmation.by_candidate[chosen].regulation_3way.log_loss, market_status: 'NOT_TESTED' };
  markets.team_total = { market: 'team total', status: 'PROVISIONAL', failed: ['not separately scored in this record'], market_status: 'NOT_TESTED' };

  /* ---------- live parameters for the slate ---------- */
  const liveS = C.CURRENT_SEASON;
  const live = {
    schema: 'edgedesk_nhl_live_params_v1', generated_at: new Date().toISOString(), for_season: liveS,
    model: chosen, confirmed_variant: 'xg_goalie_confirmed',
    glm: Object.assign({ [chosen]: fits[liveS][chosen], xg_no_goalie: fits[liveS].xg_no_goalie, xg_goalie_confirmed: fits[liveS].xg_goalie_confirmed, goals_only: fits[liveS].goals_only },
      lineupOk ? { xg_lineup_confirmed: fits[liveS].xg_lineup_confirmed, xg_all_confirmed: fits[liveS].xg_all_confirmed } : {}),
    lineups: { available: lineupOk },
    glm_train_seasons: [Math.max(C.FIRST_SEASON + 1, liveS - GLM_WINDOW), liveS - 1],
    ratings: tuned, pair_calibration: cal[liveS], score_weights: P[liveS].sw, ot: P[liveS].ot, effects: P[liveS].effects, elo: bestElo,
  };
  fs.mkdirSync(PARAMS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PARAMS_DIR, 'live.json'), JSON.stringify(live, null, 1));

  /* live-season predictions, game by game (small; the record a reader can audit) */
  const liveGames = preds.filter((r) => r.season === liveS).map((r) => ({
    game_id: r.game_id, date: r.date, home: r.home, away: r.away, type: r.type,
    p_home: V.r(r.p[chosen].ml), p_home_confirmed_goalies: V.r(r.p.xg_goalie_confirmed.ml), p_home_elo: V.r(r.p.elo.ml),
    exp_total: V.r(r.p[chosen].exp_total, 2), result: { home_win: r.y.hw, total: r.y.total, margin: r.y.margin },
  }));

  const report = {
    schema: C.SCHEMA.validation, generated_at: live.generated_at,
    protocol: { selection: SELECTION, confirmation: CONFIRMATION, live: LIVE, glm_window_seasons: GLM_WINDOW, first_scored: FIRST_SCORED, prediction_time: 'scheduled start − 30 min; inputs: games on earlier dates only', candidates: GLM.CANDIDATES, baselines: { elo: 'FiveThirtyEight NHL Elo form (MOV multiplier 0.6686·ln(MOV)+0.8048), K/HFA/reversion tuned on the selection window', goals_only: 'the same GLM on goals ratings and rest only', const_home: 'home advantage only' } },
    data: { seasons: [C.FIRST_SEASON, C.CURRENT_SEASON], games_scored: preds.length, source: 'hockey/data/team_games (sportsdataverse fastRhockey, from the NHL public game feeds)', license: C.LICENSE.sportsdataverse,
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank (unknown first publication; never backdated)', assumed_available_at: 'scheduled start + 4 h', revisions: 'the history was retrieved after the fact; later source corrections may be present, so this is a retrospective test, not a certified point-in-time one' } },
    lineups: lineupInfo,
    leakage: Object.assign({ basis: 'inputs dated by assumed_available_at (scheduled start + 4 h); the source never recorded when it first published each game' }, leak),
    elo: bestElo,
    selection, comparisons, best_baseline: bestBaseline, markets,
    windows, by_season: bySeason,
    season_params: Object.fromEntries(Object.entries(P).map(([s, v]) => [s, { score_weights: v.sw, ot: v.ot, pair_calibration: v.pair_calibration || null, effects_games: v.effects ? v.effects.games : null }])),
    rejected: [{ what: 'common-shock (bivariate Poisson) share rho', result: 'maximum likelihood rho = 0 for every season 2014-2027 on the regulation score; not used', tool: 'fitRho in this file' }],
    ratings_params: tuned,
    live_games: liveGames,
    caveats: [
      'Retrospective, not point-in-time certified: every input row was retrieved after the fact, its first-publication time is unknown, and the walk-forward assumes a game\'s facts were available four hours after its scheduled start.',
      'Outcome validation only: no licensed archive of NHL closing prices is available to this build, so the model has NOT been compared with the market. Beating Elo is not beating a sportsbook.',
      'The xG model is fitted walk-forward on seasons before each season it scores; from 2022-23 the source changed how it records shot locations and the xG model is less well calibrated on those seasons (hockey/xg/report.json).',
      'Confirmed-goalie results assume the starter is known 30 minutes before puck drop; prices posted earlier use the projected starter.',
      'Playoff games are included and use sudden-death overtime; they are a small share of every window.',
    ],
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  const w = windows.confirmation.by_candidate;
  console.log('[nhl walkforward] scored ' + preds.length + ' games; leakage violations ' + leak.violations + '; chosen ' + chosen);
  for (const c of allC) console.log('  ' + c.padEnd(22) + ' sel LL ' + windows.selection.by_candidate[c].moneyline.log_loss + ' | conf LL ' + w[c].moneyline.log_loss + ' brier ' + w[c].moneyline.brier + ' slope ' + w[c].moneyline.calibration_slope + ' citl ' + w[c].moneyline.calibration_in_the_large + (w[c].total_goals ? ' | RPS ' + w[c].total_goals.rps + ' bias ' + w[c].total_goals.mean_bias + ' | PL-1.5 brier ' + w[c].puck_line_home_minus_1_5.brier + ' | o5.5 brier ' + w[c].total_over_5_5.brier : '') + ' | live LL ' + windows.live.by_candidate[c].moneyline.log_loss);
  console.log('  comparisons', JSON.stringify(comparisons));
  console.log('  markets', JSON.stringify(Object.fromEntries(Object.entries(markets).map(([k, v]) => [k, v.status + (v.failed && v.failed.length ? ' (' + v.failed.join('; ') + ')' : '')]))));
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const fails = [];
  if (r.schema !== C.SCHEMA.validation) fails.push('schema');
  if (!r.leakage || r.leakage.violations !== 0) fails.push('leakage violations: ' + (r.leakage && r.leakage.violations));
  if (!r.data || !r.data.temporal || r.data.temporal.point_in_time !== 'RETROSPECTIVE') fails.push('the record must say it is retrospective (pack temporal rule)');
  if (!r.markets || !r.markets.moneyline) fails.push('no moneyline status');
  for (const [k, m] of Object.entries(r.markets || {})) if (m.market_status !== 'NOT_TESTED' && !fs.existsSync(path.join(C.PATHS.market, 'closing'))) fails.push(k + ' claims a market test with no closing archive');
  if (!fs.existsSync(path.join(PARAMS_DIR, 'live.json'))) fails.push('no live params');
  if (fails.length) { console.error('[nhl walkforward --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl walkforward --check] ok: ' + r.data.games_scored + ' games, 0 leakage violations, moneyline ' + r.markets.moneyline.status);
}

if (require.main === module) { if (arg('check')) check(); else if (arg('tune')) tune(); else main(); }
module.exports = { otParams, eloPass, predictedAt, loadGames, seasonParams, ratingsPass, trainRows, fitRho, lineupFeatures, SELECTION, CONFIRMATION, LIVE };
