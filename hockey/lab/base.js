'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — the shared base every challenger is scored on.

   The lab never re-implements the production pipeline. It calls the
   walk-forward's own exported steps (hockey/model/walkforward.js): the same
   games, the same per-season parameters (score weights, score effects,
   overtime), the same tuned ratings, the same single chronological ratings
   pass, the same five-season GLM window and the same pair recalibration from
   the three seasons before. A lab candidate therefore differs from the
   incumbent only in what it declares it changes.

     prepare()                 games, per-season params, snapshots (+ context
                               features from hockey/lab/context.js)
     glmPredictions(base, C)   calibrated regulation λ for every scored game
                               under each named feature list in C

   Time: snapshots are built before each game date from earlier dates only;
   every fit for season S reads seasons before S only.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const W = require('../model/walkforward');
const GLM = require('../model/glm');
const { DEFAULTS } = require('../model/ratings');
const { loadLineups } = require('../ingest/lineups');
const { loadPeriods } = require('../ingest/periods');
const CTX = require('./context');

const FIRST_SCORED = 2014;
const GLM_WINDOW = 5;
const SELECTION = W.SELECTION, CONFIRMATION = W.CONFIRMATION, LIVE = W.LIVE;

function seasonsAll() { const a = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) a.push(s); return a; }
function inWin(s, w) { return s >= w[0] && s <= w[1]; }
function windowOf(s) { return inWin(s, SELECTION) ? 'selection' : inWin(s, CONFIRMATION) ? 'confirmation' : inWin(s, LIVE) ? 'live' : 'burn_in'; }

/** everything the candidates share; lineups when every scored season has them */
function prepare(o) {
  o = o || {};
  const seasons = seasonsAll();
  const { rows, games } = W.loadGames(seasons);
  const P = W.seasonParams(rows, seasons, false); /* committed score effects (effects_for_<season>.json) */
  const tuningFile = path.join(C.HOCKEY, 'model', 'params', 'tuning.json');
  const tuned = fs.existsSync(tuningFile) ? JSON.parse(fs.readFileSync(tuningFile, 'utf8')).chosen : DEFAULTS;
  const LU = o.lineups === false ? { map: new Map(), absent: seasons } : loadLineups(seasons);
  const lineupOk = seasons.filter((s) => s >= FIRST_SCORED && s < C.CURRENT_SEASON).every((s) => LU.absent.indexOf(s) < 0);
  const { snaps, state } = W.ratingsPass(games, P, tuned, lineupOk ? LU.map : null);
  /* the context features (travel, time zones, congestion, short-term form): point in time, from the schedule and earlier games */
  const ctx = CTX.contextFeatures(games, { tuned, P });
  for (const g of games) {
    const sn = snaps.get(g.game_id), cx = ctx.get(g.game_id);
    if (cx) { Object.assign(sn.fh, cx.home); Object.assign(sn.fa, cx.away); }
  }
  const periods = loadPeriods(seasons);
  return { seasons, rows, games, P, tuned, snaps, state, lineupOk, periods, scored: games.filter((g) => g.season >= FIRST_SCORED) };
}

/** calibrated λ for every scored game under each candidate feature list */
function glmPredictions(base, cands, o) {
  o = o || {};
  const { games, snaps, seasons } = base;
  const names = Object.keys(cands);
  const raw = new Map(); const fits = {};
  const scoredSeasons = seasons.filter((s) => s >= FIRST_SCORED);
  for (const S of scoredSeasons) {
    const train = W.trainRows(games, snaps, S);
    fits[S] = {};
    for (const c of names) fits[S][c] = GLM.fit(train, cands[c], { l2: o.l2 });
    for (const g of games) {
      if (g.season !== S) continue;
      const sn = snaps.get(g.game_id); const v = raw.get(g.game_id) || {};
      for (const c of names) v[c] = { lh: GLM.predict(fits[S][c], sn.fh), la: GLM.predict(fits[S][c], sn.fa) };
      raw.set(g.game_id, v);
    }
  }
  const cal = {};
  for (const S of scoredSeasons) {
    cal[S] = {};
    for (const c of names) {
      /* the production rule reads the three seasons before S; `calWindow: 'expanding'` reads every earlier scored season (a lab candidate) */
      const from = o.calWindow === 'expanding' ? FIRST_SCORED : Math.max(FIRST_SCORED, S - 3);
      const rowsCal = games.filter((g) => g.season >= from && g.season < S && raw.has(g.game_id)).map((g) => ({ lh: raw.get(g.game_id)[c].lh, la: raw.get(g.game_id)[c].la, gh: g.reg_home, ga: g.reg_away }));
      cal[S][c] = GLM.fitPairCalibration(rowsCal);
    }
  }
  const out = new Map();
  for (const g of games) {
    const r = raw.get(g.game_id); if (!r) continue;
    const v = {};
    for (const c of names) { const x = GLM.applyPairCalibration(r[c].lh, r[c].la, cal[g.season][c]); v[c] = { lh: x.lh, la: x.la }; }
    out.set(g.game_id, v);
  }
  return { lam: out, fits, cal };
}

module.exports = { prepare, glmPredictions, FIRST_SCORED, GLM_WINDOW, SELECTION, CONFIRMATION, LIVE, inWin, windowOf, seasonsAll };
