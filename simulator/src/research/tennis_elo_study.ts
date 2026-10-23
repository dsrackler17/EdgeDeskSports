/* ===========================================================================
   HOW WELL DOES A TENNIS ELO PRICE A MATCH? — the evidence behind the
   tennis rating (simulator/src/sports/tennis/elo.ts).

   Every price is point-in-time: the walk prices a match from the ratings
   before it, then absorbs it. 2022 is warm-up (scored by nobody), 2023-2024
   the TUNING window, 2025 to the feed's last match the HOLDOUT, scored once
   with the chosen parameters.

   1. Parameters by log loss on the tuning window over both tours together:
      the step (k_num, k_exp; k_offset 5 as FiveThirtyEight's), the share
      of the target taken from games won (mov_weight 0 = the result only)
      and how steeply the games share maps to a target (mov_stretch).
   2. The holdout: log loss, Brier and accuracy per tour, against a coin and
      against FiveThirtyEight's published parameters (250, 5, 0.4, the result
      only), with a tournament-bootstrap 95% interval of each difference
      (1,000 resamples of the holdout's tournaments).
   3. Calibration on the holdout: ten bins of the price for the side the
      model favours, the mean price beside the share won.
   4. Best of five: on the holdout's men's Grand Slam main-draw matches, the
      log loss with the best-of-three price and with the conversion through
      the set (elo.ts price). The conversion is used only if it is lower on
      the tuning window's slam matches too.
   5. Straight sets: under independent sets, a best-of-three match goes the
      distance with chance 2 s (1-s) (s: the set chance from the price).
      The predicted and observed rates on the holdout, in five bins of the
      favourite's price. (2026-10-23: it predicts about 50% three-setters
      where 37% happen; sets are not independent, so no set-score figure is
      published.)

   Output: simulator/data/tennis_elo_study.json
   Usage: node simulator/src/research/tennis_elo_study.ts [--quick]
   =========================================================================== */
import fs from 'node:fs';
import { readFeed, loadMatches, walk, setFromBo3, bo5FromSet, STUDY_FILE, ELO_538, TOURS, type TennisEloConfig, type TMatch, type WalkRow } from '../sports/tennis/elo.ts';
import { streamFor } from '../core/prng.ts';
import { sha256Hex } from '../core/canonical.ts';

import { STUDY_SCHEMA } from '../sports/tennis/activation.ts';
const QUICK = process.argv.includes('--quick');
export const TUNE_FROM = Date.parse('2023-01-01T00:00:00Z'), HOLD_FROM = Date.parse('2025-01-01T00:00:00Z');
const BOOT = QUICK ? 200 : 1000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const ll = (p: number, y: number) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };

/** every match's point-in-time price under cfg */
function prices(ms: TMatch[], cfg: TennisEloConfig): WalkRow[] { const rows: WalkRow[] = []; walk(ms, cfg, undefined, (r) => rows.push(r)); return rows; }
const inTune = (r: WalkRow) => r.m.at >= TUNE_FROM && r.m.at < HOLD_FROM, inHold = (r: WalkRow) => r.m.at >= HOLD_FROM;
function score(rows: WalkRow[]) {
  let L = 0, B = 0, A = 0;
  for (const r of rows) { L += ll(r.p, r.m.y); B += (r.p - r.m.y) ** 2; A += (r.p > 0.5 ? 1 : r.p < 0.5 ? 0 : 0.5) === r.m.y ? 1 : r.p === 0.5 ? 0.5 : 0; }
  const n = rows.length || 1;
  return { n: rows.length, log_loss: r6(L / n), brier: r6(B / n), accuracy: r6(A / n) };
}
/** tournament-bootstrap 95% interval of mean(loss_a) - mean(loss_b) over the same matches */
function bootDiff(a: WalkRow[], b: WalkRow[], seedTag: number) {
  const byT = new Map<string, number[]>();
  a.forEach((r, i) => { const k = r.m.tid; (byT.get(k) || byT.set(k, []).get(k)!).push(i); });
  const keys = [...byT.keys()], d = a.map((r, i) => ll(r.p, r.m.y) - ll(b[i].p, b[i].m.y));
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const rs = streamFor(20261023n, seedTag, 1), out: number[] = [];
  for (let k = 0; k < BOOT; k++) {
    let s = 0, n = 0;
    for (let j = 0; j < keys.length; j++) { const idx = byT.get(keys[Math.floor(rs.nextDouble() * keys.length)])!; for (const i of idx) { s += d[i]; n++; } }
    out.push(s / n);
  }
  out.sort((x, z) => x - z);
  return { log_loss: r6(mean), ci95: [r6(out[Math.floor(0.025 * BOOT)]), r6(out[Math.ceil(0.975 * BOOT) - 1])] };
}

export function runStudy() {
  const feed = readFeed();
  const { matches, dropped } = loadMatches(feed);
  /* 1 the grid on the tuning window */
  const grid: Array<{ k_num: number; k_exp: number; mov_weight: number; mov_stretch: number; tune_log_loss: number }> = [];
  const K = QUICK ? [250, 450] : [200, 300, 400, 500, 600, 700, 800], E = QUICK ? [0.4, 0.5] : [0.4, 0.5, 0.6, 0.7], W = QUICK ? [0, 0.75] : [0, 0.25, 0.5, 0.75, 1], C = QUICK ? [1] : [0.5, 1, 1.5, 2, 2.5];
  for (const k_num of K) for (const k_exp of E) for (const mov_weight of W) for (const mov_stretch of mov_weight ? C : [1]) {
    const cfg: TennisEloConfig = { ...ELO_538, k_num, k_exp, mov_weight, mov_stretch };
    grid.push({ k_num, k_exp, mov_weight, mov_stretch, tune_log_loss: score(prices(matches, cfg).filter(inTune)).log_loss });
  }
  grid.sort((x, z) => x.tune_log_loss - z.tune_log_loss);
  const best = grid[0];
  let chosen: TennisEloConfig = { ...ELO_538, k_num: best.k_num, k_exp: best.k_exp, mov_weight: best.mov_weight, mov_stretch: best.mov_stretch };
  /* 4 best of five, decided on the tuning window's slam matches */
  const slamRows = (rows: WalkRow[]) => rows.filter((r) => r.m.bo === 5);
  const noConv = prices(matches, chosen), conv = prices(matches, { ...chosen, bo5_convert: true });
  const bo5 = {
    tune: { n: slamRows(noConv.filter(inTune)).length, best_of_3_price: score(slamRows(noConv.filter(inTune))).log_loss, converted: score(slamRows(conv.filter(inTune))).log_loss },
    holdout: { n: slamRows(noConv.filter(inHold)).length, best_of_3_price: score(slamRows(noConv.filter(inHold))).log_loss, converted: score(slamRows(conv.filter(inHold))).log_loss },
    used: false
  };
  bo5.used = bo5.tune.converted < bo5.tune.best_of_3_price;
  if (bo5.used) chosen = { ...chosen, bo5_convert: true };
  const rowsC = bo5.used ? conv : noConv, rows538 = prices(matches, ELO_538);
  const hold = rowsC.filter(inHold), hold538 = rows538.filter(inHold);
  /* 2 the holdout per tour */
  const holdout: Record<string, any> = {};
  for (const t of [...TOURS, 'ALL'] as const) {
    const a = hold.filter((r) => t === 'ALL' || r.m.tour === t), b = hold538.filter((r) => t === 'ALL' || r.m.tour === t);
    const coin = a.map((r) => ({ ...r, p: 0.5 }));
    holdout[t] = { chosen: score(a), elo_538: score(b), coin_log_loss: r6(Math.LN2), vs_coin: bootDiff(a, coin, 1 + TOURS.indexOf(t as any)), vs_538: bootDiff(a, b, 11 + TOURS.indexOf(t as any)),
      main_draw: score(a.filter((r) => !/qualif/i.test(r.m.round))), qualifying: score(a.filter((r) => /qualif/i.test(r.m.round))) };
  }
  /* 3 calibration (the favourite's price, ten bins from 0.5) */
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: r6(0.5 + i * 0.05), to: r6(0.55 + i * 0.05), n: 0, mean_price: 0, won: 0 }));
  for (const r of hold) {
    const pf = Math.max(r.p, 1 - r.p), yf = r.p >= 0.5 ? r.m.y : 1 - r.m.y, b = bins[Math.min(9, Math.floor((pf - 0.5) / 0.05))];
    b.n++; b.mean_price += pf; b.won += yf;
  }
  const calibration = bins.map((b) => ({ from: b.from, to: b.to, n: b.n, mean_price: b.n ? r6(b.mean_price / b.n) : null, share_won: b.n ? r6(b.won / b.n) : null }));
  const ece = r6(calibration.reduce((s, b) => s + (b.n >= 30 ? b.n * Math.abs((b.mean_price as number) - (b.share_won as number)) : 0), 0) / calibration.reduce((s, b) => s + (b.n >= 30 ? b.n : 0), 0));
  /* 5 straight sets in best-of-three matches that finished (no retirement) */
  const ss = Array.from({ length: 5 }, (_, i) => ({ from: r6(0.5 + i * 0.1), to: r6(0.6 + i * 0.1), n: 0, predicted_three_sets: 0, three_sets: 0 }));
  for (const r of hold) {
    if (r.m.bo !== 3 || r.m.retired || r.m.sets_a + r.m.sets_b < 2) continue;
    const s = setFromBo3(Math.max(r.p, 1 - r.p)), b = ss[Math.min(4, Math.floor((Math.max(r.p, 1 - r.p) - 0.5) / 0.1))];
    b.n++; b.predicted_three_sets += 2 * s * (1 - s); b.three_sets += r.m.sets_a + r.m.sets_b === 3 ? 1 : 0;
  }
  const straight = ss.map((b) => ({ from: b.from, to: b.to, n: b.n, predicted_three_sets: b.n ? r6(b.predicted_three_sets / b.n) : null, three_sets: b.n ? r6(b.three_sets / b.n) : null }));
  const counts: Record<string, Record<string, number>> = {};
  for (const m of matches) { const y = new Date(m.at).getUTCFullYear(); (counts[m.tour] ||= {})[y] = (counts[m.tour][y] || 0) + 1; }
  return {
    schema: STUDY_SCHEMA, generated_at: new Date().toISOString(), quick: QUICK,
    data: { file: 'simulator/data/feeds/tennis_matches.json.gz', fetched_at: (feed as any).fetched_at, matches_sha256: sha256Hex(JSON.stringify(feed.matches)), played: matches.length, dropped, by_tour_year: counts,
      last_match: new Date(matches[matches.length - 1].at).toISOString() },
    windows: { warm_up: '2022', tune: '2023-01-01 to 2024-12-31', holdout: '2025-01-01 to ' + new Date(matches[matches.length - 1].at).toISOString().slice(0, 10) },
    grid: grid.slice(0, 12), grid_size: grid.length, chosen, best_of_five: bo5, holdout, calibration, ece_bins_30: ece, straight_sets: straight
  };
}

const isMain = !!process.argv[1] && process.argv[1].endsWith('tennis_elo_study.ts');
if (isMain) {
  const out = runStudy();
  fs.writeFileSync(STUDY_FILE, JSON.stringify(out, null, 1) + '\n');
  const h = out.holdout;
  console.log('tennis Elo: chosen ' + JSON.stringify(out.chosen) + '; holdout log loss ATP ' + h.ATP.chosen.log_loss + ' (538 ' + h.ATP.elo_538.log_loss + '), WTA ' + h.WTA.chosen.log_loss + ' (538 ' + h.WTA.elo_538.log_loss + '); ECE ' + out.ece_bins_30 + '; best of five used: ' + out.best_of_five.used);
}
