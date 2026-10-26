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
     team strength    does the model rate clubs too far apart (overrating the
                      strong, underrating the weak) or too close together?
                      Each club's regulation goals against the λ it was priced
                      at: the recalibration slope, by tenth of λ, split into
                      the game total and the home share, and the clubs whose
                      season-to-date numbers stand out (hot scoring, a run of
                      goals, power-play goals, finishing, a leaky opponent)
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const ST = require('../../engine/stats');
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

/* ---------- team strength ---------- */

/** Poisson recalibration slope of counts on log λ: y ~ Poisson(λ · exp(c + (s − 1)(log λ − mean))). rows [{y, lam}] */
function poissonSlope(rows) {
  const n = rows.length;
  if (n < 30) return { n, slope: null, ci95: null };
  const mu = rows.reduce((a, x) => a + Math.log(x.lam), 0) / n;
  const m = ST.poisson(rows.map((x) => [1, Math.log(x.lam) - mu]), rows.map((x) => x.y), { l2: 0, offset: rows.map((x) => Math.log(x.lam)) });
  const s = 1 + m.beta[1], se = m.se ? m.se[1] : null;
  return { n, slope: r(s, 3), ci95: se == null ? null : [r(s - 1.96 * se, 3), r(s + 1.96 * se, 3)], mean_lambda: r(rows.reduce((a, x) => a + x.lam, 0) / n, 3), mean_goals: r(rows.reduce((a, x) => a + x.y, 0) / n, 3) };
}
/** the home share of goals on the priced log ratio log(λH/λA), binomial in the goals scored. rows [{gh, ga, lh, la}] */
function splitSlope(rows) {
  const k = rows.filter((x) => x.gh + x.ga > 0);
  if (k.length < 30) return { n: k.length, slope: null, ci95: null };
  const m = ST.irls(k.map((x) => [1, Math.log(x.lh / x.la)]), k.map((x) => x.gh / (x.gh + x.ga)), { family: 'logistic', l2: 0, weights: k.map((x) => x.gh + x.ga) });
  const s = m.beta[1], se = m.se ? m.se[1] : null;
  return { n: k.length, slope: r(s, 3), ci95: se == null ? null : [r(s - 1.96 * se, 3), r(s + 1.96 * se, 3)] };
}
/** goals scored ÷ goals forecast over a group of team-games, with a Poisson standard error */
function ratio(rows) {
  const n = rows.length;
  if (n < 30) return { n };
  const y = rows.reduce((a, x) => a + x.y, 0), l = rows.reduce((a, x) => a + x.lam, 0);
  return { n, forecast: r(l / n, 3), scored: r(y / n, 3), ratio: r(y / l, 3), se: r(Math.sqrt(Math.max(1, y)) / l, 3) };
}
/** TOO_WIDE: clubs priced too far apart (the strong overrated, the weak underrated); TOO_NARROW: too close together */
function spreadReading(s) {
  if (!s || s.slope == null || !s.ci95) return 'TOO_EARLY';
  return s.ci95[1] < 1 ? 'TOO_WIDE' : s.ci95[0] > 1 ? 'TOO_NARROW' : 'OK';
}
/** equal-count groups by λ */
function byLambda(rows, groups) {
  const s = rows.slice().sort((a, b) => a.lam - b.lam); const out = [];
  for (let d = 0; d < groups; d++) out.push(Object.assign({ group: d + 1, of: groups }, ratio(s.slice(Math.floor(d * s.length / groups), Math.floor((d + 1) * s.length / groups)))));
  return out;
}

/* Clubs whose season-to-date numbers stand out, 8 to 24 games into their season (when last
   season still weighs most in the ratings). Ratios are to the league's season to date;
   finishing is goals ÷ xG on attempts against a goalie, as ratings.js reads it. */
const STANDOUT_GAMES = [8, 24];
const STANDOUTS = [
  ['hot_scoring', 'scoring ≥ 1.20× the league (regulation goals a game)', (x) => x.gf >= 1.2],
  ['cold_scoring', 'scoring ≤ 0.83× the league', (x) => x.gf <= 0.83],
  ['hot_last_3', 'last three games ≥ 1.33× the league\'s scoring rate', (x) => x.l3 >= 1.33],
  ['cold_last_3', 'last three games ≤ 0.67× the league\'s scoring rate', (x) => x.l3 <= 0.67],
  ['high_pp_goals', 'power-play goals a game ≥ 1.35× the league', (x) => x.pp >= 1.35],
  ['low_pp_goals', 'power-play goals a game ≤ 0.65× the league', (x) => x.pp <= 0.65],
  ['hot_finishing', 'finishing (goals ÷ xG) ≥ 1.15', (x) => x.fin >= 1.15],
  ['cold_finishing', 'finishing (goals ÷ xG) ≤ 0.87', (x) => x.fin <= 0.87],
  ['hot_scoring_and_finishing', 'scoring ≥ 1.20× the league with finishing ≥ 1.10', (x) => x.gf >= 1.2 && x.fin >= 1.1],
  ['vs_leaky_defence', 'opponent allows ≥ 1.20× the league', (x) => x.ga_opp >= 1.2],
  ['vs_stingy_defence', 'opponent allows ≤ 0.83× the league', (x) => x.ga_opp <= 0.83],
];

/** regular-season rows from `firstSeason` on: one per team-game (the λ it was priced at, its regulation goals,
    season-to-date context from earlier dates only) and one per game (both λ, both scores) */
function teamGameRows(games, lamOf, firstSeason) {
  const std = new Map(); const lg = new Map(); const teams = [], pairs = [];
  const blank = () => ({ gp: 0, gf: 0, ga: 0, pp: 0, g_vs: 0, xg_vs: 0, last: [] });
  const vsG = (x) => (x.ev5_gf || 0) + (x.evo_gf || 0) + (x.pp_gf || 0) + (x.sh_gf || 0);
  const vsXg = (x) => (x.ev5_xgf || 0) + (x.evo_xgf || 0) + (x.pp_xgf || 0) + (x.sh_xgf || 0);
  let i = 0;
  while (i < games.length) {
    const date = games[i].date; let j = i;
    while (j < games.length && games[j].date === date) j++;
    const day = games.slice(i, j);
    for (const g of day) {
      const L = g.type === 'R' && g.season >= firstSeason ? lamOf(g) : null;
      if (!L) continue;
      const lgS = lg.get(g.season); const lgOk = lgS && lgS.gp >= 30;
      for (const home of [true, false]) {
        const team = home ? g.home : g.away, opp = home ? g.away : g.home;
        const me = std.get(team + '|' + g.season) || blank(), op = std.get(opp + '|' + g.season) || blank();
        const l3 = me.last.slice(-3);
        teams.push({ season: g.season, date: g.date, team, gp: me.gp, y: home ? g.reg_home : g.reg_away, lam: home ? L.lh : L.la,
          ctx: lgOk && me.gp && op.gp ? { gf: me.gf / me.gp / lgS.gpg(), ga_opp: op.ga / op.gp / lgS.gpg(), l3: l3.reduce((a, v) => a + v, 0) / l3.length / lgS.gpg(), pp: me.pp / me.gp / lgS.ppg(), fin: me.xg_vs > 0 ? me.g_vs / me.xg_vs : null } : null });
      }
      pairs.push({ season: g.season, date: g.date, gh: g.reg_home, ga: g.reg_away, lh: L.lh, la: L.la });
    }
    for (const g of day) {
      const lgS = lg.get(g.season) || { gp: 0, gf: 0, pp: 0, gpg() { return this.gf / this.gp; }, ppg() { return this.pp / this.gp; } };
      for (const [x, o] of [[g.h, g.a], [g.a, g.h]]) {
        const k = x.team + '|' + g.season; const me = std.get(k) || blank();
        me.gp++; me.gf += x.gf_reg; me.ga += o.gf_reg; me.pp += x.pp_gf || 0; me.g_vs += vsG(x); me.xg_vs += vsXg(x); me.last.push(x.gf_reg); if (me.last.length > 3) me.last.shift();
        std.set(k, me);
        if (g.type === 'R') { lgS.gp++; lgS.gf += x.gf_reg; lgS.pp += x.pp_gf || 0; }
      }
      lg.set(g.season, lgS);
    }
    i = j;
  }
  return { teams, games: pairs };
}

/** the team-strength audit over the three windows; rows from teamGameRows */
function teamStrength(rows, windowOf) {
  const W = ['selection', 'confirmation', 'live'];
  const teams = (w) => rows.teams.filter((x) => windowOf(x.season) === w);
  const games = (w) => rows.games.filter((x) => windowOf(x.season) === w);
  const out = {
    rule: 'Each club\'s regulation goals against the regulation λ it was priced at, regular season, out of sample. Slope: Poisson recalibration of goals on log λ (1 = right). TOO_WIDE when the 95% interval sits below 1: the model rates clubs too far apart, overrating the strong and underrating the weak. TOO_NARROW when it sits above 1: too close together. Total and split repeat the slope on the game total and on the home share of goals. Scored ÷ forecast above 1 means the model expected too few goals from that group. A monitor: it never retrains or reprices anything.',
    windows: {}, phase: {},
    standouts: { games_into_season: STANDOUT_GAMES, basis: 'season-to-date numbers from games on earlier dates; ratios to the league\'s season to date', rows: [] },
  };
  for (const w of W) {
    const t = teams(w), gm = games(w);
    const sl = poissonSlope(t), tot = poissonSlope(gm.map((x) => ({ y: x.gh + x.ga, lam: x.lh + x.la }))), sp = splitSlope(gm);
    out.windows[w] = { team_games: t.length, games: gm.length, sample_state: V.sampleState(gm.length), slope: sl, reading: spreadReading(sl),
      total: Object.assign(tot, { reading: spreadReading(tot) }),
      split: Object.assign(sp, { reading: spreadReading(sp) }),
      by_lambda: byLambda(t, t.length >= 2000 ? 10 : 5) };
    out.phase[w] = { first_20_games: poissonSlope(t.filter((x) => x.gp < 20)), rest: poissonSlope(t.filter((x) => x.gp >= 20)) };
  }
  for (const [key, label, test] of STANDOUTS) {
    const row = { key, label };
    for (const w of W) row[w] = ratio(teams(w).filter((x) => x.gp >= STANDOUT_GAMES[0] && x.gp <= STANDOUT_GAMES[1] && x.ctx && x.ctx.fin != null && test(x.ctx)));
    out.standouts.rows.push(row);
  }
  out.summary = W.map((w) => {
    const v = out.windows[w], s = v.slope; if (s.slope == null) return w + ': too few games.';
    const top = v.by_lambda[v.by_lambda.length - 1], bot = v.by_lambda[0];
    return w + ' (' + v.team_games + ' team-games): slope ' + s.slope + ' (95% ' + s.ci95.join('–') + '), ' + v.reading +
      '; the highest-λ ' + (v.by_lambda.length === 10 ? 'tenth' : 'fifth') + ' scored ' + top.ratio + '× its forecast, the lowest ' + bot.ratio + '×.';
  });
  return out;
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
  /* team strength */
  out.team_strength = teamStrength(teamGameRows(base.games, (g) => (G.lam.get(g.game_id) || {}).p, B.FIRST_SCORED), B.windowOf);
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('[nhl diagnostics] AUC sel ' + out.windows.selection.auc + ' conf ' + out.windows.confirmation.auc + ' live ' + out.windows.live.auc + '; early-season conf LL ' + out.season_phase.confirmation.first_20_games.log_loss + ' vs rest ' + out.season_phase.confirmation.rest.log_loss + '; clubs outside their interval ' + out.by_club_outside.length + '; starters ' + JSON.stringify(out.starters.by_season[2026]) + '; totals 80% coverage conf ' + out.totals.confirmation.coverage_80 + '; drift ' + out.drift.status +
    '; team strength ' + ['selection', 'confirmation', 'live'].map((w) => w + ' ' + out.team_strength.windows[w].slope.slope + ' ' + out.team_strength.windows[w].reading).join(', '));
}

function check() {
  const fails = []; let d = null;
  try { d = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { fails.push('no diagnostics file'); }
  if (d) { if (d.schema !== SCHEMA) fails.push('schema'); if (!d.drift || !/^(OK|WATCH|ALERT|TOO_EARLY)$/.test(d.drift.status)) fails.push('no drift status'); if (!d.windows || !d.windows.confirmation || !(d.windows.confirmation.auc > 0.5)) fails.push('confirmation AUC missing or ≤ 0.5');
    const ts = d.team_strength;
    if (!ts || !ts.windows || ['selection', 'confirmation', 'live'].some((w) => !ts.windows[w] || !/^(OK|TOO_WIDE|TOO_NARROW|TOO_EARLY)$/.test(ts.windows[w].reading))) fails.push('no team-strength reading for every window');
    else if (!(ts.windows.confirmation.slope.slope > 0) || !ts.standouts || !ts.standouts.rows.length) fails.push('team-strength slope or standouts missing'); }
  if (fails.length) { console.error('[nhl diagnostics --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl diagnostics --check] ok: drift ' + d.drift.status + ', confirmation AUC ' + d.windows.confirmation.auc);
}

if (require.main === module) { if (process.argv.includes('--check')) check(); else main(); }
module.exports = { auc, drift, summary, poissonSlope, splitSlope, ratio, spreadReading, teamGameRows, teamStrength, STANDOUTS };
