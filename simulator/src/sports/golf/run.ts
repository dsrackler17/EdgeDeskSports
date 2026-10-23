/* ===========================================================================
   edgedesk-sim run, golf: snapshots (one per tour event) -> gates ->
   simulate -> results -> local files; publication through the shared
   publisher (publish/publish.ts), one competition per event, only for an
   event whose every gate passes. Called by cli/run.ts for --sport golf.

   Gates (a FAIL that blocks simulation stops that event before a run):
     field.present        at least 10 players still playing
     rounds.known         the number of regulation rounds is determined
                          (rules.ts scheduledRounds) and not below the
                          round being played
     cut.rule             the cut is Observed, measured, or there is none;
                          an undetermined rule is never assumed
     data.consistent      completed rounds are 18-hole rounds at the
                          event's par, a round in progress has 1-17 holes
     model.study          the study's variances are present and finite
   Publication only:
     players.rated        every player carries a skill, fitted or the
                          prior, counted; refused when more than a third of
                          those still playing are on the prior
     event.open           the event is not finished
     results.current      the leaderboard is at most config.max_feed_age_hours
                          old (a committed feed older than that, or a live
                          read that failed long ago, never publishes)
   then run.sum_rules, run.finite, run.count (100,000 to publish) and
   sport.active (registry.ts).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { runPlan } from '../../core/runner.ts';
import { buildResults, PRODUCTION_RUNS, type ResultsDoc } from '../../core/results.ts';
import { parseSeed } from '../../core/prng.ts';
import { sha256Hex } from '../../core/canonical.ts';
import { sportRegistry } from '../registry.ts';
import type { Gate } from '../nfl/validate.ts';
import { REPO } from './model.ts';
import { buildGolfSnapshots, readGolfSnapshot, writeGolfSnapshot } from './inputs.ts';
import type { GolfSnapshot, GolfInputData } from './types.ts';
import { GOLF_2026 } from './config.ts';
import type { Tour } from './model.ts';

export interface GolfArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[]; offline: boolean; tours?: Tour[]; nowMs?: number }
export interface GolfRunOutcome { results: ResultsDoc; gates: Gate[]; snapshot: GolfSnapshot; outDir: string; publishable: boolean }
export interface GolfOutcome { sport: 'golf'; runs: GolfRunOutcome[]; skipped: Array<{ tour: string; reason: string }>; refused: Array<{ competition: string; gates: Gate[] }>; outDir: string }

export function validateGolfInputs(snap: GolfSnapshot, nowMs: number = Date.now()): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation'): void => { out.push({ id, status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  const playing = d.players.filter((p) => p.status === 'active');
  const st = (s: string) => d.players.filter((p) => p.status === s).length;
  g('field.present', playing.length >= 10, d.players.length + ' players: ' + playing.length + ' playing, ' + st('cut') + ' cut, ' + (st('wd') + st('dq')) + ' withdrawn or disqualified' + (st('mdf') ? ', ' + st('mdf') + ' made the cut and did not finish' : ''));
  g('rounds.known', d.event.n_rounds >= 1 && d.event.n_rounds >= d.event.period && d.event.n_rounds <= 6, d.event.n_rounds >= 1 ? d.event.n_rounds + ' regulation rounds (' + d.event.rounds_source + '); round ' + d.event.period + ' is the current one' : 'the number of rounds could not be determined (' + d.event.rounds_source + ')');
  g('cut.rule', d.cut.state !== 'undetermined', (d.cut.state === 'made' ? 'Observed: ' : d.cut.state === 'none' ? 'no cut: ' : d.cut.state === 'pending' ? (d.cut.provenance || '') + ': ' : 'undetermined: ') + d.cut.source);
  const badRound = d.players.filter((p) => p.rounds.some((r) => !(r.strokes >= 50 && r.strokes <= 100) || Math.abs(r.par - d.event.par) > 3) || (p.partial && !(p.partial.holes >= 1 && p.partial.holes <= 17)));
  g('data.consistent', !badRound.length, badRound.length ? 'implausible rounds: ' + badRound.slice(0, 5).map((p) => p.name).join(', ') : 'every completed round is an 18-hole round within 3 of par ' + d.event.par + '; ' + d.players.filter((p) => p.partial).length + ' rounds in progress with 1-17 holes played');
  const tv = d.model.tournament;
  g('model.study', [tv.c2, tv.W1, tv.W2, tv.sigma_eps, tv.scale].every((x) => Number.isFinite(x) && x >= 0) && tv.sigma_eps > 1 && d.model.rounds_used > 1000,
    'skill fit on ' + d.model.rounds_used + ' rounds (' + d.model.fit_tours.join(' + ') + ', ' + d.model.model_version + '); offsets c2 ' + tv.c2 + ', W1 ' + tv.W1 + ', W2 ' + tv.W2 + ', round noise ' + tv.sigma_eps + ', scale ' + tv.scale);
  const prior = playing.filter((p) => p.skill.on_prior).length, few = playing.filter((p) => !p.skill.on_prior && p.skill.n_rounds <= 24).length;
  g('players.rated', prior <= playing.length / 3, playing.length + ' playing: ' + (playing.length - prior - few) + ' rated on 25 or more rounds, ' + few + ' on 1-24 rounds (shrunk toward the few-round prior), ' + prior + ' with no round in the history (the newcomer prior)', 'publication');
  const left = d.event.status !== 'STATUS_FINAL' && playing.some((p) => p.rounds.length < d.event.n_rounds);
  g('event.open', left, left ? 'round ' + d.event.period + ' of ' + d.event.n_rounds + ' (' + d.event.status + ')' : 'the event is finished: nothing to simulate', 'publication');
  const age = (nowMs - Date.parse(d.as_of)) / 3600e3;
  g('results.current', Number.isFinite(age) && age <= GOLF_2026.max_feed_age_hours, 'leaderboard read ' + d.as_of + ' (' + (Number.isFinite(age) ? age.toFixed(1) : '?') + ' h ago; at most ' + GOLF_2026.max_feed_age_hours + ' h to publish)', 'publication');
  return out;
}

/** the finishing-place summary of one player from their histogram: places 1..F, missed cut, withdrawn */
export function finishSummary(hist: number[], n: number) {
  const F = hist.length - 2;
  let last = F - 1; while (last >= 0 && !hist[last]) last--;
  const places = hist.slice(0, last + 1), mc = hist[F], wd = hist[F + 1];
  const fin = places.reduce((s, c) => s + c, 0);
  const meanIfFinished = fin ? places.reduce((s, c, b) => s + c * (b + 1), 0) / fin : null;
  /* the median place over every run, a missed cut and a withdrawal counting below every place */
  let acc = 0, median: number | 'MC' | 'WD' = 'WD';
  for (let b = 0; b <= F + 1; b++) { acc += hist[b] || 0; if (acc >= n / 2) { median = b < F ? b + 1 : b === F ? 'MC' : 'WD'; break; } }
  return { places, missed_cut: mc, withdrawn: wd, finished: fin, mean_place_if_finished: meanIfFinished == null ? null : Math.round(meanIfFinished * 100) / 100, median_place: median };
}

/** what the reader shows beside the per-player outcomes: the event, the leaderboard, the cut, the scores, the model */
/** a player's score to par from their rounds (completed, and the holes of the round in progress): ESPN's own score
    string can lag a round in progress, so the reader shows this */
export const scoreToPar = (p: GolfInputData['players'][number]) => p.rounds.reduce((s, r) => s + r.strokes - r.par, 0) + (p.partial ? p.partial.strokes - p.partial.par_played : 0);
function readerSummary(d: GolfInputData, diags: Record<string, number>, n: number) {
  const hist = (prefix: string) => Object.entries(diags).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ to_par: Number(k.slice(prefix.length)), count: v })).sort((a, b) => a.to_par - b.to_par);
  return {
    kind: 'golf_tournament', tour: d.tour, tour_label: d.tour_label, as_of: d.as_of,
    event: d.event,
    cut: { state: d.cut.state, round: d.cut.round, n: d.cut.n, within: d.cut.within, provenance: d.cut.provenance, source: d.cut.source, interval: d.cut.interval, editions: d.cut.editions, projected_line: hist('cut_line_') },
    levels: d.levels, course: d.course,
    winning_score: hist('win_to_par_'),
    playoff: { runs: diags.playoff || 0, share: (diags.playoff || 0) / n, mean_holes: diags.playoff ? (diags.playoff_holes || 0) / diags.playoff : null, mode: d.playoff.mode, note: d.playoff.note,
      history: { events: d.frequencies.events, with_playoff: d.frequencies.playoff_events } },
    leaderboard: d.players.map((p) => ({ id: p.id, name: p.name, country: p.country, position: p.position, score: p.score, to_par: scoreToPar(p), thru: p.thru, status: p.status, tee_time: p.tee_time,
      rounds: p.rounds.map((r) => ({ r: r.r, strokes: r.strokes })), partial: p.partial, skill: { theta: p.skill.theta, sd: Math.round(Math.sqrt(p.skill.var_post) * 1000) / 1000, n_rounds: p.skill.n_rounds, on_prior: p.skill.on_prior } })),
    model: { version: d.model.model_version, fit_tours: d.model.fit_tours, params: d.model.params, tournament: d.model.tournament, prior_mean: d.model.prior_mean, prior_sd: d.model.prior_sd, history_fetched_at: d.model.history_fetched_at },
    withdrawals_per_round: d.frequencies.withdrawals_per_round,
    model_health: d.health
  };
}

async function runOneEvent(snap: GolfSnapshot, a: GolfArgs, outRoot: string, log: (s: string) => void): Promise<GolfRunOutcome | { refused: Gate[] }> {
  const inputGates = validateGolfInputs(snap, a.nowMs);
  const d = snap.data;
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) { log(d.competition + ': invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')); return { refused: inputGates }; }
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log(d.competition + ' ' + d.event.name + ' · inputs ' + snap.input_hash.slice(0, 12) + ' · as of ' + d.as_of + ' · round ' + d.event.period + '/' + d.event.n_rounds + ' · cut ' + d.cut.state + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'golf', data: d, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const P = new Map(d.players.map((p) => [p.id, p]));
  const B = module.valueBins, idx = new Map(module.entities.map((e, i) => [e.id, i]));
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.model_version, config: { model: d.model.params, tournament: d.model.tournament, cut: { state: d.cut.state, round: d.cut.round, n: d.cut.n, within: d.cut.within }, rounds: d.event.n_rounds, playoff: d.playoff },
    rules_version: GOLF_2026.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => { const p = P.get(id)!, i = idx.get(id)!; return { record: { position: p.position, score: p.score, to_par: scoreToPar(p), thru: p.thru, status: p.status, country: p.country,
      rounds: p.rounds.map((r) => r.strokes), partial: p.partial, skill: { theta: p.skill.theta, sd: Math.round(Math.sqrt(p.skill.var_post) * 1000) / 1000, n_rounds: p.skill.n_rounds, on_prior: p.skill.on_prior },
      finish: finishSummary(agg.hist.slice(i * B, (i + 1) * B), agg.n) }, math_status: { eliminated: p.status !== 'active' } }; } });
  (results as any).sport_summary = readerSummary(d, agg.diags, agg.n);
  const reg = sportRegistry().find((s) => s.key === 'golf')!;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none',
      detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate sum holds (one winner; ' + module.sumRules.filter((r) => r.outcome !== 'win').map((r) => r.perGroup + ' in the top ' + r.perGroup).join(', ') + ' in every run)' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((x) => x.blocks === 'none');
  const outDir = path.join(outRoot, d.competition);
  fs.mkdirSync(outDir, { recursive: true });
  writeGolfSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export async function executeGolf(a: GolfArgs, log: (s: string) => void = console.log): Promise<GolfOutcome> {
  if (!a.snapshot && a.season !== GOLF_2026.season) throw Object.assign(new Error('no golf season config for ' + a.season + ' (configured: ' + GOLF_2026.season + ')'), { exitCode: 2 });
  let snaps: GolfSnapshot[], skipped: GolfOutcome['skipped'] = [];
  if (a.snapshot) snaps = [readGolfSnapshot(a.snapshot)];
  else { const b = await buildGolfSnapshots({ offline: a.offline, tours: a.tours, log }); snaps = b.snapshots; skipped = b.skipped; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outRoot = a.out || path.join(REPO, 'simulator', 'out', 'golf-' + GOLF_2026.season + '-' + stamp);
  const runs: GolfRunOutcome[] = [], refused: GolfOutcome['refused'] = [];
  for (const s of snaps) {
    const o = await runOneEvent(s, a, outRoot, log);
    if ('refused' in o) refused.push({ competition: s.data.competition, gates: o.refused }); else runs.push(o);
  }
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'golf_runs.json'), JSON.stringify({ schema: 'edgedesk_sim_golf_runs_v1', runs: runs.map((r) => ({ competition: r.results.run.competition, dir: path.basename(r.outDir), publishable: r.publishable, input_hash: r.snapshot.input_hash })),
    refused: refused.map((r) => ({ competition: r.competition, failed: r.gates.filter((g) => g.status === 'FAIL').map((g) => g.id + ': ' + g.detail) })), skipped }, null, 1));
  if (!runs.length && !refused.length) log('golf: no tour event to simulate (' + skipped.map((s) => s.tour + ': ' + s.reason).join(' | ') + ')');
  return { sport: 'golf', runs, skipped, refused, outDir: outRoot };
}

export function printGolfSummary(o: GolfOutcome, log: (s: string) => void): void {
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1).padEnd(3) : '   —     ');
  for (const r of o.runs) {
    const R = r.results as any, S = R.sport_summary;
    log('== ' + S.tour_label + ': ' + S.event.name + ' (' + R.run.competition + ') · round ' + S.event.period + ' of ' + S.event.n_rounds + ' · cut ' + S.cut.state + (S.cut.n ? ' (top ' + S.cut.n + ' and ties after round ' + S.cut.round + ', ' + S.cut.provenance + ')' : ''));
    log('runs ' + R.run.n_sims + ' · ' + (R.run.runtime_ms / 1000).toFixed(1) + ' s · ' + R.run.workers + ' worker(s) · peak RSS ' + R.run.peak_rss_mb + ' MB · ' + R.run.platform + ' ' + R.run.node);
    const has = (k: string) => R.outcomes.some((x: any) => x.key === k);
    log('player                    pos   to par  skill  win        top 5      top 10     top 20     cut        mean place  (percent, ±95% Monte Carlo half-width)');
    const ents = (R.entities as any[]).filter((e) => e.record.status === 'active').sort((a, b) => b.outcomes.win.probability - a.outcomes.win.probability || (a.record.finish.mean_place_if_finished ?? 999) - (b.record.finish.mean_place_if_finished ?? 999));
    const sgn = (x: number) => (x > 0 ? '+' : x === 0 ? '' : '') + (x === 0 ? 'E' : String(x));
    for (const e of ents.slice(0, 25)) log(String(e.entity_name).slice(0, 24).padEnd(25) + String(e.record.position || '-').padEnd(6) + sgn(e.record.to_par).padStart(5) + ((e.record.skill.theta > 0 ? '+' : '') + e.record.skill.theta.toFixed(2)).padStart(8) + '  '
      + pp(e.outcomes.win) + '  ' + (has('top_5') ? pp(e.outcomes.top_5) : '   —     ') + '  ' + (has('top_10') ? pp(e.outcomes.top_10) : '   —     ') + '  ' + (has('top_20') ? pp(e.outcomes.top_20) : '   —     ') + '  ' + (has('make_cut') ? pp(e.outcomes.make_cut) : '   —     ') + '  ' + String(e.record.finish.mean_place_if_finished ?? '—').padStart(6));
    const ws = S.winning_score as Array<{ to_par: number; count: number }>, n = R.run.n_sims;
    const q = (p: number) => { let acc = 0; for (const x of ws) { acc += x.count; if (acc >= p * n) return x.to_par; } return null; };
    log('winning score to par: median ' + q(0.5) + ' (80% between ' + q(0.1) + ' and ' + q(0.9) + ') · playoff in ' + (100 * S.playoff.share).toFixed(1) + '% of runs' + (S.cut.projected_line.length ? ' · cut line ' + S.cut.projected_line.map((x: any) => (x.to_par > 0 ? '+' : '') + x.to_par + ': ' + (100 * x.count / n).toFixed(1) + '%').join(', ') : ''));
    for (const g of r.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
    log((r.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), r.outDir));
  }
  for (const r of o.refused) log('REFUSED ' + r.competition + ': ' + r.gates.filter((g) => g.status === 'FAIL').map((g) => g.id + ' (' + g.detail + ')').join('; '));
  for (const s of o.skipped) log('skipped ' + s.tour + ': ' + s.reason);
}

/** every publishable event, through the shared publisher; returns the exit code (0 all published or nothing to publish,
    1 a gate blocked an event, 3 a publication failed) */
export async function publishGolf(o: GolfOutcome, log: (s: string) => void): Promise<number> {
  const { publishRun } = await import('../../publish/publish.ts');
  let code = o.refused.length ? 1 : 0;
  for (const r of o.runs) {
    if (!r.publishable) { log('nothing published for ' + r.results.run.competition + ': a gate failed (see gates.json)'); code = Math.max(code, 1); continue; }
    try {
      const p = await publishRun(r as any, { log });
      fs.writeFileSync(path.join(r.outDir, 'publish.json'), JSON.stringify(p, null, 1));
      log('published ' + r.results.run.competition + ' run ' + p.run_id + ' (' + p.status + ')');
    } catch (e) { log('publish failed for ' + r.results.run.competition + ': ' + (e as Error).message + ' — the previously published run is unchanged'); code = 3; }
  }
  return code;
}
