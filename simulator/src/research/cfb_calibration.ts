/* ===========================================================================
   ARE THE CFB GAME PROBABILITIES THE SIMULATOR CONSUMES CALIBRATED —
   ESPECIALLY FOR BIG FAVOURITES?

   A 100,000-run season simulation shrinks the Monte Carlo error toward zero;
   it does nothing about an overconfident game probability, which it repeats
   100,000 times. So the inputs are audited BEFORE they are simulated, on the
   forecasts the simulator actually uses:

   A. the served engine replayed cold over 2014-2025 (cfb_replay.ts):
        pre     the next-game number (one game before kickoff)
        frozen  the season-simulator number: priced from the state frozen
                after week 4, 7 or 10, up to 11 weeks ahead
      split by era (2014-2021 is the window the engine's sigma was fitted on;
      2022-2025 is held out from every layer), by FBS-vs-FBS and FBS-vs-FCS,
      and by horizon, in favourite-probability buckets down to 98-100%.
   B. the live 2026 record (record/football/cfb_2026.json): the probability
      EdgeDesk actually published before each game, with the no-vig closing
      moneyline beside it (a benchmark, never an input).
   C. live vs replay on the same 2026 games: is the published number more
      extreme than the validated replay path?

   Output (committed): simulator/data/cfb_calibration.json
   Usage: node simulator/src/research/cfb_calibration.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../sports/cfb/engine_adapter.ts';
import { cachedReplay, replayCfb, type ReplayRow } from './cfb_replay.ts';
import { REPLAY } from './cfb_strength_uncertainty.ts';
import { wilson } from '../core/stats.ts';
import { sha256Hex } from '../core/canonical.ts';

export const CFB_CALIBRATION_FILE = path.join(REPO, 'simulator', 'data', 'cfb_calibration.json');
export const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0000001];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface Scored { p: number; y: 0 | 1; m?: number | null }
export function bucketTable(xs: Scored[]) {
  return BUCKETS.slice(0, -1).map((lo, i) => {
    const hi = BUCKETS[i + 1], s = xs.filter((x) => { const f = Math.max(x.p, 1 - x.p); return f >= lo && f < hi; });
    if (!s.length) return { bucket: [lo, Math.min(1, hi)], n: 0 };
    const fav = (x: Scored) => (x.p >= 0.5 ? x.y : 1 - x.y);
    const pred = s.reduce((a, x) => a + Math.max(x.p, 1 - x.p), 0) / s.length, won = s.reduce((a, x) => a + fav(x), 0), w = wilson(won, s.length);
    const mk = s.filter((x) => x.m != null);
    return { bucket: [lo, Math.min(1, hi)], n: s.length, predicted: r6(pred), won: r6(won / s.length), wilson95: [r6(w.lo), r6(w.hi)],
      verdict: pred > w.hi ? 'OVERCONFIDENT' : pred < w.lo ? 'UNDERCONFIDENT' : 'within interval',
      ...(mk.length ? { market_n: mk.length, market_no_vig: r6(mk.reduce((a, x) => a + (x.p >= 0.5 ? (x.m as number) : 1 - (x.m as number)), 0) / mk.length) } : {}) };
  });
}
export function summary(xs: Scored[]) {
  const n = xs.length; if (!n) return { n: 0 };
  const brier = xs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n;
  const ll = xs.reduce((a, x) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, x.p)); return a - (x.y ? Math.log(q) : Math.log(1 - q)); }, 0) / n;
  return { n, brier: r6(brier), log_loss: r6(ll) };
}
const scored = (rows: ReplayRow[]): Scored[] => rows.filter((r) => r[12] !== 0).map((r) => ({ p: r[11], y: r[12] > 0 ? 1 : 0 }));
const fbs = (r: ReplayRow) => r[6] === 1 && r[7] === 1;

const ml2p = (a: number) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function liveRecord() {
  const file = path.join(REPO, 'record', 'football', 'cfb_2026.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out: Array<Scored & { game_id: string; fbs: boolean; week: number }> = [];
  for (const g of Object.values(doc.games) as any[]) {
    const p = g.pick && g.pick.home_win_prob, f = g.final;
    if (p == null || !f || f.home_score === f.away_score) continue;
    const pr = (g.close && g.close.prices) || {};
    let m: number | null = null;
    if (pr.home_ml != null && pr.away_ml != null) { const a = ml2p(pr.home_ml), b = ml2p(pr.away_ml); m = a / (a + b); }
    out.push({ p, y: f.home_score > f.away_score ? 1 : 0, m, game_id: String(g.game_id), fbs: g.home_division === 'fbs' && g.away_division === 'fbs', week: g.week });
  }
  return { file: 'record/football/cfb_2026.json', sha256: sha256Hex(fs.readFileSync(file)), updated_at: doc.updated_at || null, rows: out };
}

function main() {
  const R = cachedReplay(REPLAY, (s) => process.stderr.write(s + '\n'));
  const pre = R.rows.filter((r) => r[1] === 0 && r[16] === 0), fz = R.rows.filter((r) => r[1] === 1 && r[0] !== 2020);
  const era = (rows: ReplayRow[], a: number, b: number) => rows.filter((r) => r[0] >= a && r[0] <= b);
  const replay = {
    pre_fbs_2014_2021: { table: bucketTable(scored(era(pre.filter(fbs), 2014, 2021))), ...summary(scored(era(pre.filter(fbs), 2014, 2021))) },
    pre_fbs_2022_2025: { table: bucketTable(scored(era(pre.filter(fbs), 2022, 2025))), ...summary(scored(era(pre.filter(fbs), 2022, 2025))) },
    pre_fcs_2014_2025: { table: bucketTable(scored(pre.filter((r) => !fbs(r)))), ...summary(scored(pre.filter((r) => !fbs(r)))) },
    frozen_fbs_2014_2021: { table: bucketTable(scored(era(fz.filter(fbs), 2014, 2021))), ...summary(scored(era(fz.filter(fbs), 2014, 2021))) },
    frozen_fbs_2022_2025: { table: bucketTable(scored(era(fz.filter(fbs), 2022, 2025))), ...summary(scored(era(fz.filter(fbs), 2022, 2025))) },
    frozen_fcs_2014_2025: { table: bucketTable(scored(fz.filter((r) => !fbs(r)))), ...summary(scored(fz.filter((r) => !fbs(r)))) },
    frozen_fbs_by_horizon: Object.fromEntries([[1, 2], [3, 5], [6, 11]].map(([a, b]) => {
      const s = scored(fz.filter((r) => fbs(r) && r[3] - r[2] >= a && r[3] - r[2] <= b));
      return ['weeks_' + a + '_' + b, { table: bucketTable(s), ...summary(s) }];
    }))
  };
  /* B + C: the live record, and the replay's number for the same 2026 games */
  const live = liveRecord();
  const r26 = replayCfb({ from: 2026, to: 2026, asOfWeeks: [] });
  const bare: Record<string, number> = {};
  for (const x of r26.rows) if (x[1] === 0) bare[x[15]] = x[11];
  const both = live.rows.filter((x) => x.fbs && bare[x.game_id] != null);
  const lg = (p: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
  const xs = both.map((x) => lg(bare[x.game_id])), ys = both.map((x) => lg(x.p));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const liveFbs = live.rows.filter((x) => x.fbs), liveFcs = live.rows.filter((x) => !x.fbs);
  const doc = {
    schema: 'edgedesk_sim_cfb_calibration_v1',
    generated_by: 'simulator/src/research/cfb_calibration.ts',
    model_version: R.model_version,
    buckets: 'favourite probability max(p, 1 - p); won = the favourite won; Wilson 95% interval on the win rate; OVERCONFIDENT = predicted above the interval',
    replay: { method: 'cfb_replay.ts cold walk-forward of football/cfb_p4/engine.js, ' + REPLAY.from + '-' + REPLAY.to + ' (replay from ' + (REPLAY.from - 8) + '), frozen after weeks ' + REPLAY.asOfWeeks.join('/') + '; frozen excludes 2020 and conference championship games; pre is regular season and conference championships', ...replay },
    live_2026: { source: live.file, source_sha256: live.sha256, record_updated_at: live.updated_at, note: 'the probability published at the pick (last pregame number); market = no-vig closing moneyline (benchmark only)',
      fbs: { table: bucketTable(liveFbs), ...summary(liveFbs), market: summary(liveFbs.filter((x) => x.m != null).map((x) => ({ p: x.m as number, y: x.y }))) },
      fcs: { table: bucketTable(liveFcs), ...summary(liveFcs) },
      fbs_90_plus: (() => { const s = liveFbs.filter((x) => Math.max(x.p, 1 - x.p) >= 0.9); const won = s.filter((x) => (x.p >= 0.5 ? x.y : 1 - x.y) === 1).length; const w = wilson(won, s.length);
        return { n: s.length, predicted: r6(s.reduce((a, x) => a + Math.max(x.p, 1 - x.p), 0) / s.length), won: r6(won / s.length), wilson95: [r6(w.lo), r6(w.hi)] }; })() },
    live_vs_replay_2026: { games: both.length, logit_slope_live_on_replay: r6(slope), mean_logit_live_minus_replay: r6(my - mx),
      at_90_plus: { live: both.filter((x) => Math.max(x.p, 1 - x.p) >= 0.9).length, replay: both.filter((x) => Math.max(bare[x.game_id], 1 - bare[x.game_id]) >= 0.9).length },
      replay_table: bucketTable(both.map((x) => ({ p: bare[x.game_id], y: x.y }))), replay_summary: summary(both.map((x) => ({ p: bare[x.game_id], y: x.y }))), live_summary: summary(both) },
    decision: [
      'The simulator prices every remaining 2026 game from the replay path these tables validate (the served engine and parameters, state replayed from the 2026 feed), not from the live board, whose 2026 numbers are more extreme than the replay on the same games (logit slope above 1) and fell short of their predicted rate in the 90%+ bucket.',
      'Per-game probabilities are kept exactly (the strength offset is carved out of the engine sigma, simulator/data/cfb_strength_uncertainty.json), so no flattening or sharpening is applied on top of a calibrated input.',
      'FCS opponents keep the engine\'s single FCS floor rating; its win probabilities are calibrated in aggregate on the FBS-vs-FCS rows above (its margins are not: FBS teams beat the floor by more than projected, which affects no win-loss outcome).'
    ]
  };
  fs.writeFileSync(CFB_CALIBRATION_FILE, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, CFB_CALIBRATION_FILE));
  const flag = (name: string, t: any[]) => t.filter((b) => b.n && b.bucket[0] >= 0.9).forEach((b) => console.log(name.padEnd(24) + b.bucket.join('-') + ' n ' + b.n + ' pred ' + b.predicted + ' won ' + b.won + ' ' + b.verdict));
  flag('pre 2022-25', replay.pre_fbs_2022_2025.table); flag('frozen 2022-25', replay.frozen_fbs_2022_2025.table); flag('live 2026 fbs', doc.live_2026.fbs.table);
  console.log('live vs replay logit slope ' + doc.live_vs_replay_2026.logit_slope_live_on_replay);
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('research', 'cfb_calibration.ts'));
if (isMain) main();
