#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL LAB — the split-factor shadow: the study behind it, and its
   live record (hockey/model/split_shadow.js holds the candidate and the rule).

     node hockey/lab/split_shadow.js           the study (every season since
                                               2013-14, about 5 minutes) and
                                               the live record
     node hockey/lab/split_shadow.js --live    the live record only (the shadow
                                               ledger graded, the DraftKings
                                               monitor); the study is kept
     node hockey/lab/split_shadow.js --check   the committed record is well
                                               formed and the frozen split
                                               factor is the one its rule gives

   Writes hockey/validation/nhl_split_shadow.json.

   THE STUDY reuses the lab's base (hockey/lab/base.js): the production
   ratings pass, GLM fits and pair recalibration, which reproduce the
   production record (checked below). Every scored game is priced at each
   split factor on glm.js's grid with its own season's total compression and
   centre, its own score effects and overtime. For season S the shadow's
   split is the grid value with the best moneyline likelihood over the
   seasons before S (split_shadow.fitMoneylineSplit). Nothing a season is
   priced with reads that season.

   DISCLOSURE. The investigation read both windows and the season so far
   before the candidate was chosen. Three other variants were scored the same
   way and are reported under `variants`. Only the live shadow ledger, which
   starts with this change, is a clean test.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const GLM = require('../model/glm');
const DIST = require('../model/distribution');
const SH = require('../model/split_shadow');
const B = require('./base');

const OUT = path.join(C.PATHS.validation, 'nhl_split_shadow.json');
const SCHEMA = 'edgedesk_nhl_split_shadow_v1';
const WINDOWS = { selection: B.SELECTION, confirmation: B.CONFIRMATION, live: B.LIVE };
const r = V.r;

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } }
/* the pair recalibration with split b; a season with no earlier record (identity) keeps its total and takes only the split */
function withSplit(raw, cal, b) { return GLM.applyPairCalibration(raw.lh, raw.la, Object.assign({}, cal, { b, a: cal && cal.c ? cal.a : 1, c: cal && cal.c ? cal.c : raw.lh + raw.la })); }

function study() {
  const base = B.prepare();
  const wf = readJson(path.join(C.PATHS.validation, 'nhl_walkforward.json'), null);
  const chosen = wf && wf.selection ? wf.selection.chosen : 'xg_core';
  const G = B.glmPredictions(base, { p: GLM.CANDIDATES[chosen] });
  const grid = SH.grid(); const at = (b) => grid.indexOf(+b.toFixed(3));
  const eff = (g) => base.P[g.season].effects || DIST.neutralEffects();
  const ot = (g) => (g.type === 'P' ? { format: 'PO' } : base.P[g.season].ot);
  const seasons = [...new Set(base.scored.map((g) => g.season))].sort();
  const rows = [], bShadow = {}, bProd = {};
  for (const S of seasons) {
    const cal = G.cal[S].p;
    bProd[S] = cal.b;
    bShadow[S] = SH.fitMoneylineSplit(rows.filter((x) => x.season < S)).b;
    for (const g of base.scored) {
      if (g.season !== S) continue;
      const raw = G.raw.get(g.game_id).p, lam = G.lam.get(g.game_id).p;
      const Dp = DIST.game({ lamH: lam.lh, lamA: lam.la, effects: eff(g), ot: ot(g) });
      const ps = []; let plShadow = null;
      for (const b of grid) {
        const l = withSplit(raw, cal, b); const D = DIST.game({ lamH: l.lh, lamA: l.la, effects: eff(g), ot: ot(g) });
        ps.push(D.p_home);
        if (b === bShadow[S]) plShadow = DIST.spread(D, -1.5).win;
      }
      rows.push({ id: g.game_id, season: S, date: g.date, start_utc: g.start_utc, home: g.home, away: g.away, w: B.windowOf(S), y: g.hw, margin: g.final_home - g.final_away,
        raw, gh: g.reg_home, ga: g.reg_away, ps, prod: Dp.p_home, plProd: DIST.spread(Dp, -1.5).win, plShadow });
    }
    console.log('[split shadow] ' + S + ': production b ' + bProd[S] + ', shadow b ' + bShadow[S]);
  }
  /* production, reproduced: the same log loss as the walk-forward record on the two completed windows (the live one grows between runs) */
  const repro = {};
  for (const [w, s] of Object.entries({ selection: B.SELECTION, confirmation: B.CONFIRMATION })) {
    const sub = rows.filter((x) => x.season >= s[0] && x.season <= s[1]);
    const ll = r(sub.reduce((a, x) => a + V.logLoss(x.prod, x.y), 0) / sub.length, 5);
    const rec = wf && wf.windows && wf.windows[w] ? wf.windows[w].by_candidate[chosen].moneyline.log_loss : null;
    repro[w] = { log_loss: ll, record: rec, ok: rec == null || ll === rec };
  }
  const reproOk = Object.values(repro).every((x) => x.ok);
  const pShadow = (x) => x.ps[at(bShadow[x.season])];
  const pb = (x, b) => x.ps[at(b)];
  /* the three other variants the investigation scored */
  const bVar = { b_one: {}, goal_split_every_earlier_season: {}, moneyline_three_seasons: {} };
  for (const S of seasons) {
    bVar.b_one[S] = 1;
    bVar.goal_split_every_earlier_season[S] = GLM.fitPairCalibration(rows.filter((x) => x.season < S).map((x) => ({ lh: x.raw.lh, la: x.raw.la, gh: x.gh, ga: x.ga }))).b;
    bVar.moneyline_three_seasons[S] = SH.fitMoneylineSplit(rows.filter((x) => x.season < S && x.season >= S - 3)).b;
  }
  const cmp = (sub, f) => V.pairedBootstrap(sub.map((x) => ({ date: x.date, a: V.logLoss(f(x), x.y), b: V.logLoss(x.prod, x.y) })), { B: 1000, seed: 20261013 });
  const ml = (sub, f) => { const m = V.binary(sub.map((x) => ({ p: f(x), y: x.y }))); return { log_loss: m.log_loss, calibration_slope: m.calibration_slope, calibration_in_the_large: m.calibration_in_the_large }; };
  const plLL = (sub, k) => r(sub.reduce((a, x) => a + V.logLoss(x[k], x.margin >= 2 ? 1 : 0), 0) / sub.length, 5);
  const windows = {};
  for (const [w, s] of Object.entries(WINDOWS)) {
    const sub = rows.filter((x) => x.season >= s[0] && x.season <= s[1]);
    windows[w] = { seasons: s, n: sub.length, production: ml(sub, (x) => x.prod), shadow: ml(sub, pShadow), shadow_minus_production: cmp(sub, pShadow),
      puck_line_home_minus_1_5: { production_log_loss: plLL(sub, 'plProd'), shadow_log_loss: plLL(sub, 'plShadow') } };
  }
  const bySeason = seasons.map((S) => {
    const sub = rows.filter((x) => x.season === S);
    const a = sub.reduce((t, x) => t + V.logLoss(x.prod, x.y), 0) / sub.length, b = sub.reduce((t, x) => t + V.logLoss(pShadow(x), x.y), 0) / sub.length;
    return { season: S, n: sub.length, b_production: bProd[S], b_shadow: bShadow[S], goal_split_b_in_season: GLM.fitPairCalibration(sub.map((x) => ({ lh: x.raw.lh, la: x.raw.la, gh: x.gh, ga: x.ga }))).b, moneyline_b_in_season: sub.length >= SH.PROTOCOL.min_fit_games ? SH.fitMoneylineSplit(sub).b : null,
      log_loss_production: r(a, 5), log_loss_shadow: r(b, 5), shadow_minus_production: r(b - a, 5) };
  });
  /* the finding: on goals the split is about right; on the moneyline it wants to be wider (in-sample, pooled) */
  const pooled = {};
  for (const w of ['selection', 'confirmation']) {
    const sub = rows.filter((x) => x.w === w);
    pooled[w] = { n: sub.length, goal_split_b: GLM.fitPairCalibration(sub.map((x) => ({ lh: x.raw.lh, la: x.raw.la, gh: x.gh, ga: x.ga }))).b, moneyline_b: SH.fitMoneylineSplit(sub).b };
  }
  const variants = {};
  for (const [k, bs] of Object.entries(bVar)) {
    variants[k] = { b_2026_27: bs[C.CURRENT_SEASON], windows: {} };
    for (const [w, s] of Object.entries(WINDOWS)) { const sub = rows.filter((x) => x.season >= s[0] && x.season <= s[1]); variants[k].windows[w] = Object.assign(ml(sub, (x) => pb(x, bs[x.season])), { shadow_minus_production: cmp(sub, (x) => pb(x, bs[x.season])) }); }
  }
  /* the observation that started this: 2026-27 so far against DraftKings' closes (walk-forward prices, not frozen ones) */
  const closes = SH.readCloses();
  const liveRows = rows.filter((x) => x.w === 'live').map((x) => Object.assign({ close: SH.matchClose(closes, x.start_utc, x.home, x.away) }, x)).filter((x) => x.close);
  const dk = { n: liveRows.length, production: SH.spreadStats(liveRows.map((x) => ({ p: x.prod, m: x.close.p_home }))), shadow: SH.spreadStats(liveRows.map((x) => ({ p: pShadow(x), m: x.close.p_home }))),
    basis: 'walk-forward prices of 2026-27 games with a DraftKings close in research/clv/openers/nhl (the capture began 2026-10-21); read before the registration' };
  /* how many unseen games the rule needs */
  const liveDiff = rows.filter((x) => x.w === 'live').map((x) => V.logLoss(pShadow(x), x.y) - V.logLoss(x.prod, x.y));
  const md = liveDiff.reduce((a, v) => a + v, 0) / liveDiff.length;
  const sd = Math.sqrt(liveDiff.reduce((a, v) => a + (v - md) ** 2, 0) / (liveDiff.length - 1));
  const need = (h) => Math.ceil((1.96 * sd / h) ** 2);
  const power = { per_game_sd_2026_27: r(sd, 4), games_for_95_half_width: { '0.001': need(0.001), '0.002': need(0.002), observed: need(Math.abs(md)) }, observed_mean_diff: r(md, 5),
    reading: 'the interval of the shadow-minus-production log loss is about ±1.96·sd/√n; with this season\'s spread an effect the size seen so far needs about ' + need(Math.abs(md)) + ' games, one of 0.001 about ' + need(0.001) };
  return {
    generated_at: new Date().toISOString(), model: 'edgedesk_nhl_v1:' + chosen,
    reproduces_production: { ok: reproOk, windows: repro },
    b_by_season: Object.fromEntries(seasons.map((S) => [S, { production: bProd[S], shadow: bShadow[S] }])),
    windows, by_season: bySeason, pooled_in_sample: pooled, variants, draftkings_2026_27_to_date: dk, power,
  };
}

function write(history) {
  const out = { schema: SCHEMA, generated_at: new Date().toISOString(), protocol: SH.PROTOCOL, history, live: SH.grade() };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const L = out.live, M = L.market_spread;
  console.log('[split shadow] live: ' + L.games_graded + ' graded from ' + L.shadow_ledger_records + ' shadow ledger rows, ' + L.verdict.status + ' (' + L.verdict.n + '/' + L.verdict.needed + '); production vs DraftKings closes: n ' + M.n + ', slope ' + M.slope + ' ' + JSON.stringify(M.ci95) + ' ' + M.reading + ', favourites less favoured ' + M.favourites_less_favoured + ', mean gap ' + M.mean_favourite_gap_pp + ' pp');
}

function check() {
  const fails = []; const d = readJson(OUT, null);
  if (!d) fails.push('no ' + path.relative(C.ROOT, OUT));
  else {
    if (d.schema !== SCHEMA) fails.push('schema');
    if (!d.protocol || d.protocol.id !== SH.PROTOCOL.id || d.protocol.b !== SH.PROTOCOL.b) fails.push('the record was written under another protocol');
    const h = d.history;
    if (!h || !h.reproduces_production || !h.reproduces_production.ok) fails.push('the study does not reproduce the production record');
    else if (!h.b_by_season[SH.PROTOCOL.season] || h.b_by_season[SH.PROTOCOL.season].shadow !== SH.PROTOCOL.b) fails.push('the frozen split factor ' + SH.PROTOCOL.b + ' is not what its rule gives for ' + SH.PROTOCOL.season + ' (' + (h.b_by_season[SH.PROTOCOL.season] || {}).shadow + ')');
    if (h && ['selection', 'confirmation', 'live'].some((w) => !h.windows[w] || !h.windows[w].shadow_minus_production || !h.windows[w].shadow_minus_production.ci95)) fails.push('a study window is missing');
    const L = d.live;
    if (!L || !L.verdict || SH.VERDICTS.indexOf(L.verdict.status) < 0) fails.push('no live verdict');
    else if (/^(ELIGIBLE|NOT_CONFIRMED)$/.test(L.verdict.rule_status) && L.verdict.n !== SH.PROTOCOL.decision_n) fails.push('a decision was read on ' + L.verdict.n + ' games, not ' + SH.PROTOCOL.decision_n);
    if (L && L.verdict && SH.PROTOCOL.promoted && L.verdict.status !== 'PROMOTED') fails.push('the protocol is promoted but the record does not say so');
    if (!L || !L.market_spread || SH.SPREAD_READINGS.indexOf(L.market_spread.reading) < 0) fails.push('no DraftKings spread reading');
  }
  fails.push(...SH.checkLedger());
  if (fails.length) { console.error('[split shadow --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[split shadow --check] ok: b ' + d.protocol.b + ' (production ' + d.history.b_by_season[SH.PROTOCOL.season].production + '), live ' + d.live.verdict.status + ' ' + d.live.verdict.n + '/' + d.live.verdict.needed + ', DraftKings spread ' + d.live.market_spread.reading);
}

function main() {
  if (process.argv.includes('--check')) return check();
  if (process.argv.includes('--live')) {
    const d = readJson(OUT, null);
    if (!d || !d.history) { console.error('[split shadow --live] no study on file: run node hockey/lab/split_shadow.js first'); process.exit(1); }
    return write(d.history);
  }
  const h = study();
  if (!h.reproduces_production.ok) { console.error('[split shadow] the study does not reproduce the production record: ' + JSON.stringify(h.reproduces_production.windows)); process.exit(1); }
  if (h.b_by_season[SH.PROTOCOL.season] && h.b_by_season[SH.PROTOCOL.season].shadow !== SH.PROTOCOL.b) { console.error('[split shadow] the rule gives b = ' + h.b_by_season[SH.PROTOCOL.season].shadow + ' for ' + SH.PROTOCOL.season + ', not the frozen ' + SH.PROTOCOL.b + '. The protocol is frozen: do not edit it to match; find out what changed.'); process.exit(1); }
  write(h);
}

if (require.main === module) main();
module.exports = { study, check, SCHEMA, OUT };
