#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — diagnostics of the production model's held-out record.

     node hockey/model/diagnostics.js            write hockey/validation/nhl_diagnostics.json
     node hockey/model/diagnostics.js --check    the committed file is well formed

   The walk-forward record (nhl_walkforward.json) says whether the model is
   validated. This file says WHERE it is strong and weak, from the same
   out-of-sample predictions (rebuilt by the lab's base, which reproduces the
   production record exactly):

     discrimination   AUC (the chance a home win was priced above a home loss)
     by season        log loss, Brier, AUC, calibration in the large
     season phase     the first 20 games of each club's season vs the rest
                      (early ratings lean on last season)
     by club          error when a club plays, with a Wilson interval on its
                      calibration in the large — a club the model reads badly
     starters         how often the projected starter started, by season, and
                      the record when both projections were right vs not
     totals           80% interval coverage of total goals and mean bias
     drift            the season in progress against the confirmation window:
                      rolling log loss, a one-sided CUSUM, a status
                      (OK / WATCH / ALERT) — a monitor, never a retrain trigger
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const DIST = require('./distribution');
const GLM = require('./glm');

const OUT = path.join(C.PATHS.validation, 'nhl_diagnostics.json');
const SCHEMA = 'edgedesk_nhl_diagnostics_v1';
const r = V.r;

/** AUC by ranks (ties averaged) */
function auc(rows) {
  const s = rows.map((x, i) => ({ p: x.p, y: x.y, i })).sort((a, b) => a.p - b.p);
  let rank = 1, sumPos = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < s.length;) {
    let j = i; while (j < s.length && s[j].p === s[i].p) j++;
    const avg = (rank + rank + (j - i) - 1) / 2;
    for (let k = i; k < j; k++) if (s[k].y) { sumPos += avg; nPos++; } else nNeg++;
    rank += j - i; i = j;
  }
  return nPos && nNeg ? r((sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg), 4) : null;
}
function summary(rows) { if (!rows.length) return { n: 0 }; const b = V.binary(rows); return { n: b.n, log_loss: b.log_loss, brier: b.brier, auc: auc(rows), mean_p: b.mean_p, mean_y: b.mean_y, calibration_in_the_large: b.calibration_in_the_large, calibration_slope: b.calibration_slope }; }

/** one-sided CUSUM of log-loss excess over a reference mean (k = half an sd), status by the decision interval h */
function drift(liveRows, refMean, refSd) {
  const k = 0.5 * refSd, h = 5 * refSd / Math.sqrt(1);
  let cs = 0, maxCs = 0; const path = [];
  liveRows.forEach((x, i) => { cs = Math.max(0, cs + (x.loss - refMean - k)); maxCs = Math.max(maxCs, cs); if ((i + 1) % 25 === 0 || i === liveRows.length - 1) path.push({ n: i + 1, cusum: r(cs, 3) }); });
  const n = liveRows.length; const mean = n ? liveRows.reduce((a, x) => a + x.loss, 0) / n : null;
  const se = refSd / Math.sqrt(Math.max(1, n)); const z = n ? (mean - refMean) / se : null;
  const last100 = liveRows.slice(-100); const roll = last100.length ? last100.reduce((a, x) => a + x.loss, 0) / last100.length : null;
  const status = n < 50 ? 'TOO_EARLY' : cs > h ? 'ALERT' : z > 2 ? 'WATCH' : 'OK';
  return { n, live_mean_log_loss: r(mean, 5), reference_mean: r(refMean, 5), reference_sd_per_game: r(refSd, 4), z: r(z, 2), rolling_100: r(roll, 5), cusum: r(cs, 3), cusum_max: r(maxCs, 3), decision_interval: r(h, 3), status, path,
    rule: 'one-sided CUSUM on per-game log loss minus the confirmation mean, allowance half a per-game sd, alarm at 5 sd; WATCH when the season mean sits 2 standard errors above the reference. A monitor: it never retrains or reprices anything.' };
}

function main() {
  const B = require('../lab/base');
  const base = B.prepare();
  const chosen = (() => { try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nhl_walkforward.json'), 'utf8')).selection.chosen; } catch (_) { return 'xg_no_goalie'; } })();
  const G = B.glmPredictions(base, { p: GLM.CANDIDATES[chosen] });
  const eff = (g) => base.P[g.season].effects || DIST.neutralEffects();
  const ot = (g) => (g.type === 'P' ? { format: 'PO' } : base.P[g.season].ot);
  const rows = [];
  for (const g of base.scored) {
    const L = G.lam.get(g.game_id).p; const D = DIST.game({ lamH: L.lh, lamA: L.la, effects: eff(g), ot: ot(g) });
    const sn = base.snaps.get(g.game_id); const pmf = DIST.totalPmf(D);
    /* the central 80% set of total goals */
    let cum = 0, lo = null, hi = null; for (let t = 0; t < pmf.length; t++) { const prev = cum; cum += pmf[t]; if (lo == null && cum >= 0.1) lo = t; if (hi == null && cum >= 0.9) hi = t; void prev; }
    const tot = g.final_home + g.final_away;
    rows.push({ id: g.game_id, season: g.season, date: g.date, type: g.type, home: g.home, away: g.away, w: B.windowOf(g.season), p: D.p_home, y: g.hw, loss: V.logLoss(D.p_home, g.hw),
      early: Math.min(sn.fh.season_games || 0, sn.fa.season_games || 0) < 20,
      proj_home: sn.fa.opp_goalie_proj_top, proj_away: sn.fh.opp_goalie_proj_top, start_home: g.h.g_start, start_away: g.a.g_start,
      in80: tot >= lo && tot <= hi, exp_total: DIST.expectedTotal(D), total: tot });
  }
  const win = (w) => rows.filter((x) => x.w === w);
  const out = { schema: SCHEMA, generated_at: new Date().toISOString(), model: 'edgedesk_nhl_v1:' + chosen + ' (production)', source: 'out-of-sample predictions rebuilt by hockey/lab/base.js (reproduces hockey/validation/nhl_walkforward.json)' };
  out.windows = {}; for (const w of ['selection', 'confirmation', 'live']) out.windows[w] = summary(win(w));
  out.by_season = {}; for (const s of [...new Set(rows.map((x) => x.season))]) out.by_season[s] = summary(rows.filter((x) => x.season === s));
  out.season_phase = {}; for (const w of ['selection', 'confirmation']) out.season_phase[w] = { first_20_games: summary(win(w).filter((x) => x.early)), rest: summary(win(w).filter((x) => !x.early)) };
  out.by_month = {}; for (const x of win('confirmation')) { const m = x.date.slice(5, 7); (out.by_month[m] || (out.by_month[m] = [])).push(x); }
  for (const m of Object.keys(out.by_month)) out.by_month[m] = summary(out.by_month[m]);
  /* by club: the club's own win probability, home or away */
  const clubs = {};
  for (const x of win('confirmation')) for (const [t, p, y] of [[x.home, x.p, x.y], [x.away, 1 - x.p, 1 - x.y]]) (clubs[t] || (clubs[t] = [])).push({ p, y });
  out.by_club = Object.fromEntries(Object.entries(clubs).map(([t, a]) => {
    const n = a.length, k = a.reduce((s, x) => s + x.y, 0), mp = a.reduce((s, x) => s + x.p, 0) / n; const w = V.wilson(k, n);
    return [t, { n, mean_p: r(mp), observed: r(k / n), wilson95: [w.low, w.high], outside: mp < w.low || mp > w.high, log_loss: r(a.reduce((s, x) => s + V.logLoss(x.p, x.y), 0) / n, 5) }];
  }).sort((a, b) => a[0] < b[0] ? -1 : 1));
  out.by_club_outside = Object.entries(out.by_club).filter(([, v]) => v.outside).map(([t]) => t);
  /* starters */
  out.starters = { by_season: {}, note: 'projected = the most likely starter from recent usage and the league\'s back-to-back rule (hockey/model/ratings.js); actual = the box score\'s starter' };
  for (const s of [...new Set(rows.map((x) => x.season))]) {
    const a = rows.filter((x) => x.season === s); let hit = 0, n = 0;
    for (const x of a) for (const [pj, st] of [[x.proj_home, x.start_home], [x.proj_away, x.start_away]]) if (pj != null && st != null) { n++; if (Number(pj) === Number(st)) hit++; }
    out.starters.by_season[s] = { team_games: n, projected_started: hit, rate: n ? r(hit / n) : null };
  }
  for (const w of ['selection', 'confirmation']) {
    const a = win(w); const both = (x) => x.proj_home != null && x.proj_away != null && Number(x.proj_home) === Number(x.start_home) && Number(x.proj_away) === Number(x.start_away);
    out.starters[w] = { both_projections_right: summary(a.filter(both)), at_least_one_wrong: summary(a.filter((x) => !both(x))) };
  }
  /* totals */
  out.totals = {}; for (const w of ['selection', 'confirmation', 'live']) { const a = win(w); out.totals[w] = { n: a.length, coverage_80: a.length ? r(a.filter((x) => x.in80).length / a.length) : null, mean_bias_goals: a.length ? r(a.reduce((s, x) => s + x.exp_total - x.total, 0) / a.length, 3) : null, note: 'total goals is discrete: the central set holding at least 80% probability covers ≥ 80% by construction when calibrated' }; }
  /* drift */
  const conf = win('confirmation'); const refMean = conf.reduce((a, x) => a + x.loss, 0) / conf.length;
  const refSd = Math.sqrt(conf.reduce((a, x) => a + (x.loss - refMean) ** 2, 0) / conf.length);
  out.drift = drift(win('live').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)), refMean, refSd);
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('[nhl diagnostics] AUC sel ' + out.windows.selection.auc + ' conf ' + out.windows.confirmation.auc + ' live ' + out.windows.live.auc + '; early-season conf LL ' + out.season_phase.confirmation.first_20_games.log_loss + ' vs rest ' + out.season_phase.confirmation.rest.log_loss + '; clubs outside their interval ' + out.by_club_outside.length + '; starters ' + JSON.stringify(out.starters.by_season[2026]) + '; totals 80% coverage conf ' + out.totals.confirmation.coverage_80 + '; drift ' + out.drift.status);
}

function check() {
  const fails = []; let d = null;
  try { d = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { fails.push('no diagnostics file'); }
  if (d) { if (d.schema !== SCHEMA) fails.push('schema'); if (!d.drift || !/^(OK|WATCH|ALERT|TOO_EARLY)$/.test(d.drift.status)) fails.push('no drift status'); if (!d.windows || !d.windows.confirmation || !(d.windows.confirmation.auc > 0.5)) fails.push('confirmation AUC missing or ≤ 0.5'); }
  if (fails.length) { console.error('[nhl diagnostics --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl diagnostics --check] ok: drift ' + d.drift.status + ', confirmation AUC ' + d.windows.confirmation.auc);
}

if (require.main === module) { if (process.argv.includes('--check')) check(); else main(); }
module.exports = { auc, drift, summary };
