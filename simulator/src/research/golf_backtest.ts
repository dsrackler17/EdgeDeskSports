/* ===========================================================================
   DOES THE GOLF SIMULATION FORECAST TOURNAMENTS? — a walk-forward backtest
   of the full simulation (inputs.ts buildData + module.ts), reported
   exactly as it comes out.

   Every finished event of the three tours is replayed point-in-time:
     pre   before round 1: the field that teed off, skills fitted on the
           rounds before the event, the cut rule and round count read from
           earlier editions only (an event whose rule history cannot give is
           skipped and counted, as production would refuse it);
     r2    after round 2 with the cut applied (Observed): rounds 1-2 played,
           the rest simulated (events whose cut comes after round 3 are
           skipped at this stage).
   Arms (each event, each stage, the same seed):
     model        the production simulation, at the uncertainty scale chosen
                  on the tuning season;
     point        the same with the per-tournament offsets off (scale 0):
                  skill as a point, rounds independent; after round 2 it
                  does not learn from the rounds played either;
     scores_only  after round 2: every player equally skilled (the field's
                  mean posterior variance, the tour's round noise): what
                  the leaderboard alone says;
     uniform      the field-size baseline: win 1/F, top k k/F, the cut
                  N/F (N the cut rule's count) before round 1; after round
                  2, 1/A and k/A over the A players left.
   Targets (Observed): the winner (position 1, a playoff included); top k
   as the dead-heat share (a player tied for 9th with three others counts
   0.5 toward the top 10: the expectation the simulation's random tie-break
   targets); made the cut. Scores: Brier and log loss per player-event, the
   simulated frequency smoothed as (count + 0.5) / (N + 1) so a zero count
   is not a certainty. Calibration bins per outcome. Differences against
   each baseline carry an event bootstrap (resampling events within season,
   1,000 resamples): with only two holdout seasons, a season bootstrap would
   have two draws.

   The uncertainty scale (a multiplier on the study's measured offset
   variances) is checked on the TUNING season (2024: scales 0, 0.5, 1, 1.5,
   2; the summed log loss of win, top 10, top 20 and the cut before round
   1). The measured variances (scale 1) are kept unless the best scale beats
   them with an event-bootstrap 95% interval entirely below zero: the
   tuning curve is flat to the fourth decimal, and an argmin of noise is not
   a calibration. The HOLDOUT seasons (2025-2026) are then scored once.

   Output: simulator/data/golf_backtest.json
   Usage:  node simulator/src/research/golf_backtest.ts --tour pga|lpga|eur [--runs 4000]   (writes simulator/out/golf_backtest.<tour>.json)
           node simulator/src/research/golf_backtest.ts --merge                             (writes simulator/data/golf_backtest.json)
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { loadHistory, REPO, STUDY_FILE, BACKTEST_FILE, TOURS, TOUR_LABEL, type HistEvent, type Tour } from '../sports/golf/model.ts';
import { measureCut } from '../sports/golf/rules.ts';
import { buildData, readJson, type FieldEntry } from '../sports/golf/inputs.ts';
import { golfModule } from '../sports/golf/module.ts';
import { runRange } from '../core/engine.ts';
import { streamFor } from '../core/prng.ts';
import { sha256Hex } from '../core/canonical.ts';
import { BACKTEST_SCHEMA } from '../sports/golf/activation.ts';
import type { GolfInputData } from '../sports/golf/types.ts';

const argv = process.argv.slice(2), opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
export const TUNE = [2024], HOLD = [2025, 2026], SCALES = [0, 0.5, 1, 1.5, 2];
const OUTCOMES = ['win', 'top_5', 'top_10', 'top_20', 'make_cut'];
const BOOT = 1000;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const fmtPar = (x: number) => (x === 0 ? 'E' : x > 0 ? '+' + x : String(x));

/* ------------------------------------------------------------ targets */
/** each finisher's dead-heat share of the top k, from the final positions (T5 with three others: places 5-8) */
export function deadHeat(e: HistEvent, k: number): Map<string, number> {
  const fin = e.players.filter((p) => (p.status === 'active' || p.status === 'mdf') && p.position && /^T?\d+$/.test(p.position));
  const pos = (p: HistEvent['players'][number]) => Number(String(p.position).replace('T', ''));
  const count = new Map<number, number>(); for (const p of fin) count.set(pos(p), (count.get(pos(p)) || 0) + 1);
  const out = new Map<string, number>();
  for (const p of fin) { const s = pos(p), m = count.get(s)!; out.set(p.id, s > k ? 0 : s + m - 1 <= k ? 1 : (k - s + 1) / m); }
  return out;
}
const madeCut = (p: HistEvent['players'][number]) => p.status === 'active' || p.status === 'mdf' || p.rounds.some((r) => r.r >= 3);

/* ------------------------------------------------------------ the field at a stage */
function fieldAt(e: HistEvent, stage: 'pre' | 'r2'): FieldEntry[] {
  return e.players.filter((p) => p.rounds.length > 0).map((p) => {
    const rds = stage === 'pre' ? [] : p.rounds.filter((r) => r.r <= 2 && r.complete).map((r) => ({ r: r.r, strokes: r.strokes, to_par: fmtPar(r.strokes - (r.par_played as number)) }));
    const status = stage === 'pre' ? 'active' : p.status === 'cut' ? 'cut' : rds.length < 2 ? 'wd' : 'active';
    return { id: p.id, name: p.name, country: p.country, status, position: null, score: null, sort_order: null, thru: null, tee_time: null, rounds: rds } as FieldEntry;
  });
}

interface Pred { id: string; p: Record<string, number>; y: Record<string, number> }
interface EventResult { key: string; season: number; name: string; stage: 'pre' | 'r2'; players: number; arms: Record<string, Pred[]>; playoff_share: number | null; playoff_actual: boolean }

function simulate(d: GolfInputData, runs: number, scale: number, seed: bigint): { p: Map<string, Record<string, number>>; playoff: number } {
  const m = golfModule(d, { seed, scale });
  const agg = runRange(m, { start: 0, end: runs });
  const O = m.outcomes.length, out = new Map<string, Record<string, number>>();
  m.entities.forEach((e, i) => { const r: Record<string, number> = {}; m.outcomes.forEach((o, j) => { r[o.key] = (agg.counts[i * O + j] + 0.5) / (runs + 1); }); out.set(e.id, r); });
  return { p: out, playoff: (agg.diags.playoff || 0) / runs };
}

/** one event at one stage: every arm's forecast for every player still playing, beside what happened */
function evalEvent(e: HistEvent, stage: 'pre' | 'r2', ctx: { history: HistEvent[]; study: any; historySha: string; fetchedAt: string; studySha: string }, runs: number, scales: number[], arms: string[]): EventResult | { skip: string } {
  if (!e.winner) return { skip: 'no winner in the feed' };
  const c = measureCut(e);
  if (stage === 'r2' && c.cut && c.round !== 2) return { skip: 'cut after round ' + c.round };
  if (stage === 'r2' && e.n_rounds < 3) return { skip: 'fewer than three rounds' };
  const field = fieldAt(e, stage);
  if (field.length < 30) return { skip: 'field under 30' };
  const meta = { tour: e.league, id: e.id, name: e.name, course: e.course, par: e.par, start: e.start_iso, end: null, status: stage === 'pre' ? 'STATUS_SCHEDULED' : 'STATUS_PLAY_COMPLETE', period: stage === 'pre' ? 0 : 3, tournament: null };
  let d: GolfInputData;
  try { d = buildData({ meta, field, as_of: e.start_iso, history: ctx.history, study: ctx.study, backtest: null, scaleOverride: 1, historySha: ctx.historySha, historyFetchedAt: ctx.fetchedAt, studySha: ctx.studySha }); }
  catch (err) { return { skip: 'build failed: ' + (err as Error).message }; }
  if (d.cut.state === 'undetermined') return { skip: 'cut rule undetermined (' + d.cut.source.slice(0, 80) + ')' };
  if (!d.event.n_rounds) return { skip: 'round count undetermined' };
  const seed = BigInt('0x' + sha256Hex(e.key + ':' + stage).slice(0, 16));
  const playing = d.players.filter((p) => p.status === 'active');
  const y = new Map<string, Record<string, number>>();
  const dh: Record<number, Map<string, number>> = { 5: deadHeat(e, 5), 10: deadHeat(e, 10), 20: deadHeat(e, 20) };
  for (const p of playing) { const hp = e.players.find((x) => x.id === p.id)!; y.set(p.id, { win: p.id === e.winner ? 1 : 0, top_5: dh[5].get(p.id) || 0, top_10: dh[10].get(p.id) || 0, top_20: dh[20].get(p.id) || 0, make_cut: madeCut(hp) ? 1 : 0 }); }
  const res: EventResult = { key: e.key, season: e.season, name: e.name, stage, players: playing.length, arms: {}, playoff_share: null, playoff_actual: e.playoff.length > 1 };
  const pack = (pm: Map<string, Record<string, number>>) => playing.map((p) => ({ id: p.id, p: pm.get(p.id) || {}, y: y.get(p.id)! }));
  for (const s of scales) { const r = simulate(d, runs, s, seed); res.arms['scale_' + s] = pack(r.p); if (s === 1) res.playoff_share = r.playoff; }
  if (arms.includes('scores_only')) {
    const vbar = playing.reduce((a, p) => a + p.skill.var_post, 0) / playing.length;
    const eq: GolfInputData = { ...d, players: d.players.map((p) => ({ ...p, skill: { ...p.skill, theta: 0, var_post: vbar, sd_round: d.model.tournament.sigma_eps } })) };
    res.arms.scores_only = pack(simulate(eq, runs, scales.includes(1) ? 1 : scales[scales.length - 1], seed).p);
  }
  /* the field-size baseline */
  const A = playing.length, N = d.cut.state === 'pending' && d.cut.n ? Math.min(d.cut.n, A) : A;
  res.arms.uniform = playing.map((p) => ({ id: p.id, p: { win: 1 / A, top_5: Math.min(1, 5 / A), top_10: Math.min(1, 10 / A), top_20: Math.min(1, 20 / A), ...(d.cut.state === 'pending' ? { make_cut: Math.min(1 - 1e-6, N / A) } : {}) }, y: y.get(p.id)! }));
  return res;
}

/* ------------------------------------------------------------ scores */
const clip = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
const ll = (p: number, y: number) => -(y * Math.log(clip(p)) + (1 - y) * Math.log(1 - clip(p)));
const br = (p: number, y: number) => (p - y) ** 2;
function sums(rows: EventResult[], arm: string, k: string, f: (p: number, y: number) => number): Array<{ season: number; s: number; n: number }> {
  return rows.filter((r) => r.arms[arm] && r.arms[arm].some((x) => x.p[k] != null)).map((r) => { let s = 0, n = 0; for (const x of r.arms[arm]) if (x.p[k] != null) { s += f(x.p[k], x.y[k]); n++; } return { season: r.season, s, n }; });
}
const mean = (a: Array<{ s: number; n: number }>) => a.reduce((x, y) => x + y.s, 0) / Math.max(1, a.reduce((x, y) => x + y.n, 0));
/** the bootstrap interval of mean(arm) - mean(base), resampling events within season */
function diffBoot(rows: EventResult[], arm: string, base: string, k: string, seed: bigint): { log_loss: number; ci95: number[]; brier: number; events: number } | null {
  const ok = rows.filter((r) => r.arms[arm] && r.arms[base] && r.arms[arm].some((x) => x.p[k] != null) && r.arms[base].some((x) => x.p[k] != null));
  if (!ok.length) return null;
  const per = ok.map((r) => { let a = 0, b = 0, ba = 0, bb = 0, n = 0; r.arms[arm].forEach((x, i) => { const z = r.arms[base][i]; if (x.p[k] == null || z.p[k] == null) return; a += ll(x.p[k], x.y[k]); b += ll(z.p[k], z.y[k]); ba += br(x.p[k], x.y[k]); bb += br(z.p[k], z.y[k]); n++; }); return { season: r.season, a, b, ba, bb, n }; });
  const by = new Map<number, typeof per>(); for (const x of per) (by.get(x.season) || by.set(x.season, []).get(x.season)!).push(x);
  const rs = streamFor(seed, 0, 1), ds: number[] = [];
  for (let i = 0; i < BOOT; i++) { let a = 0, b = 0, n = 0; for (const g of by.values()) for (let j = 0; j < g.length; j++) { const x = g[rs.nextInt(g.length)]; a += x.a; b += x.b; n += x.n; } ds.push((a - b) / n); }
  ds.sort((x, y) => x - y);
  const N = per.reduce((s, x) => s + x.n, 0);
  return { log_loss: r5((per.reduce((s, x) => s + x.a, 0) - per.reduce((s, x) => s + x.b, 0)) / N), ci95: [r5(ds[Math.floor(0.025 * BOOT)]), r5(ds[Math.floor(0.975 * BOOT)])], brier: r5((per.reduce((s, x) => s + x.ba, 0) - per.reduce((s, x) => s + x.bb, 0)) / N), events: ok.length };
}
/** the bootstrap interval of the summed (over outcomes) mean log loss of arm a minus arm b, resampling events within season */
function bootSum(rows: EventResult[], a: string, b: string, ks: string[], seed: bigint): { diff: number; ci95: number[] } {
  const per = rows.map((r) => ({ season: r.season, k: ks.map((k) => { let sa = 0, sb = 0, n = 0; (r.arms[a] || []).forEach((x, i) => { const z = r.arms[b][i]; if (x.p[k] == null || !z || z.p[k] == null) return; sa += ll(x.p[k], x.y[k]); sb += ll(z.p[k], z.y[k]); n++; }); return { sa, sb, n }; }) }));
  const stat = (sample: typeof per) => ks.reduce((t, _, j) => { let sa = 0, sb = 0, n = 0; for (const x of sample) { sa += x.k[j].sa; sb += x.k[j].sb; n += x.k[j].n; } return t + (n ? (sa - sb) / n : 0); }, 0);
  const by = new Map<number, typeof per>(); for (const x of per) (by.get(x.season) || by.set(x.season, []).get(x.season)!).push(x);
  const rs = streamFor(seed, 0, 1), ds: number[] = [];
  for (let i = 0; i < BOOT; i++) { const smp: typeof per = []; for (const g of by.values()) for (let j = 0; j < g.length; j++) smp.push(g[rs.nextInt(g.length)]); ds.push(stat(smp)); }
  ds.sort((x, y) => x - y);
  return { diff: r5(stat(per)), ci95: [r5(ds[Math.floor(0.025 * BOOT)]), r5(ds[Math.floor(0.975 * BOOT)])] };
}
const BINS = [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.0001];
function calibration(rows: EventResult[], arm: string, k: string) {
  const xs = rows.flatMap((r) => (r.arms[arm] || []).filter((x) => x.p[k] != null).map((x) => ({ p: x.p[k], y: x.y[k] })));
  const out: Array<{ bin: string; n: number; mean_p: number; observed: number }> = [];
  for (let i = 0; i < BINS.length - 1; i++) { const b = xs.filter((x) => x.p >= BINS[i] && x.p < BINS[i + 1]); if (b.length) out.push({ bin: BINS[i] + '-' + Math.min(1, BINS[i + 1]), n: b.length, mean_p: r5(b.reduce((s, x) => s + x.p, 0) / b.length), observed: r5(b.reduce((s, x) => s + x.y, 0) / b.length) }); }
  return out;
}
function metrics(rows: EventResult[], model: string, stage: 'pre' | 'r2') {
  const out: Record<string, unknown> = {};
  const ks = stage === 'pre' ? OUTCOMES : OUTCOMES.filter((k) => k !== 'make_cut');
  for (const k of ks) {
    const arm = (a: string) => { const L = sums(rows, a, k, ll), B = sums(rows, a, k, br); return L.length ? { log_loss: r5(mean(L)), brier: r5(mean(B)), player_events: L.reduce((s, x) => s + x.n, 0) } : null; };
    out[k] = { model: arm(model), point: arm('scale_0'), uniform: arm('uniform'), ...(stage === 'r2' ? { scores_only: arm('scores_only') } : {}),
      diff_vs_uniform: diffBoot(rows, model, 'uniform', k, 0x601an), diff_vs_point: diffBoot(rows, model, 'scale_0', k, 0x601bn), ...(stage === 'r2' ? { diff_vs_scores_only: diffBoot(rows, model, 'scores_only', k, 0x601cn) } : {}),
      calibration: calibration(rows, model, k) };
  }
  return out;
}

/* ------------------------------------------------------------ one tour */
function runTour(tour: Tour, runs: number) {
  const H = loadHistory(), study = readJson(STUDY_FILE), studySha = sha256Hex(fs.readFileSync(STUDY_FILE));
  const ctx = { history: H.events, study, historySha: H.sha256, fetchedAt: H.fetched_at, studySha };
  const t0 = Date.now(), log = (s: string) => console.log(tour + ' ' + s + ' · ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  const evs = (seasons: number[]) => H.events.filter((e) => e.league === tour && seasons.includes(e.season));
  const skipped: Array<{ key: string; name: string; stage: string; reason: string }> = [];
  const collect = (seasons: number[], stage: 'pre' | 'r2', scales: number[], arms: string[], n: number) => {
    const out: EventResult[] = [];
    for (const e of evs(seasons)) { const r = evalEvent(e, stage, ctx, n, scales, arms); if ('skip' in r) skipped.push({ key: e.key, name: e.season + ' ' + e.name, stage, reason: r.skip }); else out.push(r); }
    return out;
  };
  /* tuning: the scale */
  const tune = collect(TUNE, 'pre', SCALES, [], Math.max(1000, Math.round(runs / 2)));
  const tuneScores = SCALES.map((s) => { const parts = ['win', 'top_10', 'top_20', 'make_cut'].map((k) => mean(sums(tune, 'scale_' + s, k, ll))); return { scale: s, log_loss: parts.map(r5), sum: r5(parts.reduce((a, b) => a + b, 0)) }; });
  const argmin = tuneScores.slice().sort((a, b) => a.sum - b.sum)[0].scale;
  const vs1 = argmin === 1 ? null : bootSum(tune, 'scale_' + argmin, 'scale_1', ['win', 'top_10', 'top_20', 'make_cut'], 0x601dn);
  const best = vs1 && vs1.ci95[1] < 0 ? argmin : 1;
  log('tuning ' + tune.length + ' events: ' + tuneScores.map((x) => 'scale ' + x.scale + ' ' + x.sum).join(', ') + ' -> lowest ' + argmin + (vs1 ? ' (vs 1: ' + vs1.diff + ' [' + vs1.ci95.join(', ') + '])' : '') + ', kept ' + best);
  return { tour, runs, tune, tuneScores, best, argmin, vs1, skipped, ctx, collect, log };
}

async function main() {
  if (argv.includes('--merge')) return merge();
  const tour = opt('--tour') as Tour, runs = Number(opt('--runs') || 4000);
  if (!TOURS.includes(tour)) { console.error('usage: --tour pga|lpga|eur [--runs N] | --merge'); process.exit(2); }
  const T = runTour(tour, runs);
  /* the holdout, scored once with the tuning season's scale (and the point arm, and scale 1 for the playoff check) */
  const scales = [...new Set([0, T.best, 1])];
  const pre = T.collect(HOLD, 'pre', scales, [], runs);
  T.log('holdout pre ' + pre.length + ' events');
  const r2 = T.collect(HOLD, 'r2', [...new Set([0, T.best])], ['scores_only'], runs);
  T.log('holdout r2 ' + r2.length + ' events');
  const model = 'scale_' + T.best;
  const doc = {
    tour, runs, scale: { chosen: T.best, lowest_on_tuning: T.argmin, lowest_vs_scale_1: T.vs1, rule: 'scale 1 (the measured variances) unless the lowest beats it with a bootstrap 95% interval below zero', tuning: T.tuneScores, tuning_events: T.tune.length },
    tuning: { pre: metrics(T.tune, model, 'pre') },
    holdout: { seasons: HOLD, pre: { events: pre.length, player_events: pre.reduce((s, r) => s + r.players, 0), metrics: metrics(pre, model, 'pre') }, r2: { events: r2.length, player_events: r2.reduce((s, r) => s + r.players, 0), metrics: metrics(r2, model, 'r2') } },
    playoffs: { simulated_share_mean: r5(pre.reduce((s, r) => s + (r.playoff_share || 0), 0) / Math.max(1, pre.length)), events: pre.length, events_with_playoff_in_feed: pre.filter((r) => r.playoff_actual).length,
      note: 'the simulated share of runs ending in a playoff (scale 1) against the share of holdout events the feed shows a playoff for (the PGA Tour\'s feed records playoffs; the LPGA\'s and DP World Tour\'s mostly do not)' },
    events: { pre: pre.map((r) => ({ key: r.key, name: r.season + ' ' + r.name, players: r.players, winner_p: r5((r.arms[model].find((x) => x.y.win === 1) || { p: { win: NaN } }).p.win) })), r2: r2.map((r) => ({ key: r.key, name: r.season + ' ' + r.name, players: r.players, winner_p: r5((r.arms[model].find((x) => x.y.win === 1) || { p: { win: NaN } }).p.win) })) },
    skipped: T.skipped
  };
  const file = path.join(REPO, 'simulator', 'out', 'golf_backtest.' + tour + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  T.log('wrote ' + path.relative(REPO, file));
}

function merge() {
  const parts = TOURS.map((t) => readJson(path.join(REPO, 'simulator', 'out', 'golf_backtest.' + t + '.json')));
  if (parts.some((p) => !p)) { console.error('run every tour first (simulator/out/golf_backtest.<tour>.json)'); process.exit(2); }
  const H = loadHistory();
  const doc = {
    schema: BACKTEST_SCHEMA, generated_at: new Date().toISOString(),
    method: 'walk-forward replay of the production simulation (simulator/src/research/golf_backtest.ts): tuning 2024, holdout 2025-2026; see the file header',
    data: { history_sha256: H.sha256, history_fetched_at: H.fetched_at, study_sha256: sha256Hex(fs.readFileSync(STUDY_FILE)) },
    production: { scale_by_tour: Object.fromEntries(parts.map((p: any) => [p.tour, p.scale.chosen])), method: 'each tour\'s tuning-season check (2024, before round 1, summed log loss of win, top 10, top 20 and the cut over scales ' + SCALES.join(', ') + '): the measured variances (1) unless another scale beats them with a bootstrap 95% interval below zero' },
    tours: Object.fromEntries(parts.map((p: any) => [p.tour, { label: TOUR_LABEL[p.tour as Tour], runs_per_event: p.runs, scale: p.scale, tuning: p.tuning, holdout: p.holdout, playoffs: p.playoffs, events: p.events, skipped: p.skipped }]))
  };
  fs.writeFileSync(BACKTEST_FILE, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, BACKTEST_FILE) + ' · production scales ' + JSON.stringify(doc.production.scale_by_tour));
}
main();
