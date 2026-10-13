#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the test against the market. Is the model better than the
   closing price, and would betting it have made money?

     node hockey/model/market_test.js [--closing DIR] [--predictions FILE]

   Inputs
     hockey/market/closing/<season>.csv   a LICENSED archive of timestamped
                                          closing prices (schema below); none
                                          ships with this repository
     .cache/nhl_work/predictions.jsonl    the walk-forward's per-game,
                                          out-of-sample predictions
   Output: hockey/validation/nhl_market.json, read back by walkforward.js
   (rule 6) and from there by the registry and the board.

   CSV schema (one row per game and book; header required):
     game_id,source,book,captured_at,close_home_ml,close_away_ml[,open_home_ml,open_away_ml,opened_at]
     [,close_total_line,close_over,close_under][,close_pl_home_line,close_pl_home,close_pl_away]
   `captured_at` must be BEFORE the game's start: a "closing" price captured
   after the puck dropped is rejected (and counted), never scored.

   What is computed, per market, through lib/edgedesk_calibration.js:
     - log loss and Brier of the model and of the no-vig close on the SAME
       games, and a date-block bootstrap of the log-loss difference;
     - a flat-stake strategy (bet the side whose model EV at the closing price
       is ≥ 2%), with pushes settled as pushes, ROI after a zero fee, its
       interval, drawdown — at the CLOSING price, which no bettor gets, so it
       is an upper bound on what the model could add, not a track record;
     - CLV of the OPENING price against the close where the archive has both.
   Status per market: TESTED_AHEAD only with n ≥ 500 and a bootstrap 95%
   interval of (model − close) log loss wholly below zero; TESTED_EVEN when
   the interval straddles zero; TESTED_BEHIND otherwise.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const CAL = require('../../lib/edgedesk_calibration');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
function amToDec(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
function noVig(a, b) { const da = amToDec(a), db = amToDec(b); if (!da || !db) return null; const ia = 1 / da, ib = 1 / db; return [ia / (ia + ib), ib / (ia + ib)]; }

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => { const f = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = f[i] == null || f[i] === '' ? null : f[i].trim(); }); return o; });
}

function run(o) {
  o = o || {};
  const dir = o.closing || arg('closing', path.join(C.PATHS.market, 'closing'));
  const predFile = o.predictions || arg('predictions', path.join(C.PATHS.cacheWork, 'predictions.jsonl'));
  const model = o.model || 'xg_no_goalie';
  const out = { schema: 'edgedesk_nhl_market_test_v1', generated_at: new Date().toISOString(), model, markets: {}, rejected: {}, sources: [] };
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => /\.csv$/.test(f))) {
    out.status = 'NO_ARCHIVE';
    out.why = 'no licensed closing-price archive in ' + path.relative(C.ROOT, dir) + ': the model has not been compared with the market';
    return out;
  }
  const preds = new Map();
  for (const line of fs.readFileSync(predFile, 'utf8').split('\n')) { if (!line) continue; const r = JSON.parse(line); preds.set(String(r.game_id), r); }
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.csv$/.test(x)).sort()) {
    const recs = readCsv(path.join(dir, f));
    out.sources.push({ file: path.relative(C.ROOT, path.join(dir, f)), rows: recs.length, sources: [...new Set(recs.map((r) => r.source))] });
    rows.push(...recs);
  }
  const rej = (k) => { out.rejected[k] = (out.rejected[k] || 0) + 1; };
  /* one row per game: the first book listed for it */
  const byGame = new Map();
  for (const r of rows) {
    if (!r.game_id || !r.source || !r.captured_at) { rej('MISSING_PROVENANCE'); continue; }
    const p = preds.get(String(r.game_id)); if (!p) { rej('NO_PREDICTION'); continue; }
    const start = Date.parse(p.start_utc);
    if (!(Date.parse(r.captured_at) < start)) { rej('CAPTURED_AT_OR_AFTER_START'); continue; }
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, { r, p });
  }
  const evalRows = { moneyline: [], total_over_5_5: [], total_over_6_5: [], puck_line_home_minus_1_5: [] };
  const pairs = { moneyline: [], total_over_5_5: [], total_over_6_5: [], puck_line_home_minus_1_5: [] };
  for (const { r, p } of byGame.values()) {
    const m = p.p[model]; if (!m) continue;
    const base = { predicted_at: p.predicted_at, event_start: p.start_utc, sport: 'NHL', model_version: model };
    /* moneyline: calibration rows on the home side; a bet on whichever side the model prices 2%+ above the close */
    const nv = noVig(r.close_home_ml, r.close_away_ml);
    if (nv) {
      pairs.moneyline.push({ date: p.date, a: V.logLoss(m.ml, p.y.hw), b: V.logLoss(nv[0], p.y.hw) });
      const evH = m.ml * amToDec(r.close_home_ml) - 1, evA = (1 - m.ml) * amToDec(r.close_away_ml) - 1;
      const side = evH >= evA ? 'home' : 'away';
      const nvOpen = r.open_home_ml && r.open_away_ml ? true : false;
      evalRows.moneyline.push(Object.assign({}, base, { id: r.game_id + ':ml', market: 'moneyline',
        prob: side === 'home' ? m.ml : 1 - m.ml, close_prob: side === 'home' ? nv[0] : nv[1],
        american: Number(nvOpen ? (side === 'home' ? r.open_home_ml : r.open_away_ml) : (side === 'home' ? r.close_home_ml : r.close_away_ml)),
        outcome: side === 'home' ? p.y.hw : 1 - p.y.hw, bet: Math.max(evH, evA) >= 0.02 }));
    }
    /* totals at 5.5 / 6.5 where the archive's line is one of them (whole lines would need push handling at the same line) */
    const tl = Number(r.close_total_line);
    if ((tl === 5.5 || tl === 6.5) && r.close_over && r.close_under) {
      const key = tl === 5.5 ? 'total_over_5_5' : 'total_over_6_5'; const po = tl === 5.5 ? m.o55 : m.o65;
      const nvT = noVig(r.close_over, r.close_under);
      if (nvT && po != null) {
        const yo = p.y.total > tl ? 1 : 0;
        pairs[key].push({ date: p.date, a: V.logLoss(po, yo), b: V.logLoss(nvT[0], yo) });
        const evO = po * amToDec(r.close_over) - 1, evU = (1 - po) * amToDec(r.close_under) - 1; const over = evO >= evU;
        evalRows[key].push(Object.assign({}, base, { id: r.game_id + ':' + key, market: key, prob: over ? po : 1 - po, close_prob: over ? nvT[0] : nvT[1], american: Number(over ? r.close_over : r.close_under), outcome: over ? yo : 1 - yo, bet: Math.max(evO, evU) >= 0.02 }));
      }
    }
    /* puck line home −1.5 */
    if (Number(r.close_pl_home_line) === -1.5 && r.close_pl_home && r.close_pl_away) {
      const nvP = noVig(r.close_pl_home, r.close_pl_away); const y = p.y.margin >= 2 ? 1 : 0;
      if (nvP && m.pl_home != null) {
        pairs.puck_line_home_minus_1_5.push({ date: p.date, a: V.logLoss(m.pl_home, y), b: V.logLoss(nvP[0], y) });
        const evF = m.pl_home * amToDec(r.close_pl_home) - 1, evD = (1 - m.pl_home) * amToDec(r.close_pl_away) - 1; const fav = evF >= evD;
        evalRows.puck_line_home_minus_1_5.push(Object.assign({}, base, { id: r.game_id + ':pl', market: 'puck_line', prob: fav ? m.pl_home : 1 - m.pl_home, close_prob: fav ? nvP[0] : nvP[1], american: Number(fav ? r.close_pl_home : r.close_pl_away), outcome: fav ? y : 1 - y, bet: Math.max(evF, evD) >= 0.02 }));
      }
    }
  }
  for (const k of Object.keys(evalRows)) {
    const n = pairs[k].length;
    if (!n) continue;
    const boot = V.pairedBootstrap(pairs[k], { B: 1000 });
    const rep = CAL.evaluate(evalRows[k], { groups: [] });
    const status = n >= 500 && boot.a_better ? 'TESTED_AHEAD' : boot.b_better ? 'TESTED_BEHIND' : 'TESTED_EVEN';
    out.markets[k] = {
      status, n, why: 'model − close log loss ' + boot.mean_diff + ' (95% ' + boot.ci95.join(' to ') + ', n ' + n + ')',
      log_loss_vs_close: boot, calibration: { brier: rep.overall.brier, log_loss: rep.overall.log_loss, versus_close: rep.overall.versus_close, buckets: rep.overall.buckets },
      strategy_at_close: Object.assign({ rule: 'flat 1 unit on the side the model prices ≥ 2% EV above the closing price, settled at the opening price where the archive has one (moneyline) and otherwise at the close — an upper bound, since nobody bets the exact close', profit_claim: rep.overall.profit_claim, profit_why: rep.overall.profit_why }, rep.overall.staking),
      clv: rep.overall.clv, lookahead_rejected: rep.lookahead_violations,
    };
  }
  out.status = Object.keys(out.markets).length ? 'EVALUATED' : 'NO_MATCHING_GAMES';
  return out;
}

if (require.main === module) {
  const r = run();
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(path.join(C.PATHS.validation, 'nhl_market.json'), JSON.stringify(r, null, 1) + '\n');
  console.log('[nhl market test] ' + r.status + (r.why ? ': ' + r.why : '') + ' ' + Object.entries(r.markets).map(([k, v]) => k + '=' + v.status + ' (' + v.why + ')').join('; '));
}
module.exports = { run, noVig };
