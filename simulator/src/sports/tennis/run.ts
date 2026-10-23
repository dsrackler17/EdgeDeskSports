/* ===========================================================================
   edgedesk-sim run, tennis: snapshots (one per singles main draw, one for
   the day's matches) -> gates -> simulate -> results -> local files;
   publication through the shared publisher (publish/publish.ts), one
   competition each, only for one whose every gate passes. Called by
   cli/run.ts for --sport tennis.

   Gates (a FAIL that blocks simulation stops that competition before a run):
     draw.order         the draw's order is known: a Wikipedia article
                        confirmed against ESPN, or ESPN's semifinals on
     draw.consistent    every decided match sits at its node with a winner
                        who reached it; no line twice
     matches.present    (the day's matches) at least one priced match
     model.study        the served rating's parameters are finite
   Publication only:
     players.rated      at most a third of the players still in the draw
                        (of the day's players) have fewer than
                        config.min_matches matches on file
     draw.open          the draw is not finished: a match is left to play
     results.current    the scoreboard is at most config.max_feed_age_hours
                        old
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
import { REPO } from './elo.ts';
import { buildTennisSnapshots, readTennisSnapshot, writeTennisSnapshot, type TennisSnapshot, type TennisDrawData, type TennisMatchesData } from './inputs.ts';
import { nodeCount } from './module.ts';
import { TENNIS_2026 } from './config.ts';

export interface TennisArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[]; offline: boolean; nowMs?: number }
export interface TennisRunOutcome { results: ResultsDoc; gates: Gate[]; snapshot: TennisSnapshot; outDir: string; publishable: boolean }
export interface TennisOutcome { sport: 'tennis'; runs: TennisRunOutcome[]; skipped: Array<{ draw: string; reason: string }>; refused: Array<{ competition: string; gates: Gate[] }>; outDir: string }

export function validateTennisInputs(snap: TennisSnapshot, nowMs: number = Date.now()): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation'): void => { out.push({ id, status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  const cfg = d.elo.config;
  g('model.study', [cfg.k_num, cfg.k_offset, cfg.k_exp, cfg.mov_weight, cfg.mov_stretch, cfg.scale].every((x) => Number.isFinite(x)) && cfg.scale > 0, 'served rating ' + d.elo.version + ' (k ' + cfg.k_num + '/(n+' + cfg.k_offset + ')^' + cfg.k_exp + ', games share ' + cfg.mov_weight + ' at stretch ' + cfg.mov_stretch + ', best of five ' + (cfg.bo5_convert ? 'converted' : 'as best of three') + ')');
  if (d.kind === 'draw') {
    const dd = d as TennisDrawData, L = dd.draw.lines.length;
    g('draw.order', L >= 2 && (L & (L - 1)) === 0, L + ' lines from ' + (dd.order.source === 'wikipedia' ? 'Wikipedia (' + (dd.order.article ? dd.order.article.title + ', revision ' + dd.order.article.revid : '?') + '), confirmed against ' + dd.order.matched + ' ESPN players' + (dd.order.filled_from_espn.length ? '; placed from ESPN: ' + dd.order.filled_from_espn.join(', ') : '') : 'ESPN\'s semifinals on (no confirmed draw article: ' + dd.order.tried.join(' | ') + ')'));
    const ids = dd.draw.lines.filter(Boolean) as string[];
    const dupe = ids.length !== new Set(ids).size;
    const pos = new Map(dd.draw.lines.map((id, i) => [id, i] as [string | null, number]).filter(([id]) => id) as Array<[string, number]>);
    const bad = dd.draw.results.filter((r) => { const x = pos.get(r.winner); return x == null || x >> (r.level - dd.draw.first_level + 1) !== r.index || r.index >= nodeCount(dd.draw, r.level); });
    g('draw.consistent', !dupe && !bad.length, dupe ? 'a player on two lines' : bad.length ? bad.length + ' results do not sit on their winner\'s path (first: match ' + bad[0].match_id + ')' : dd.draw.results.length + ' results, each on its winner\'s path; ' + dd.order.byes + ' byes');
    const alive = dd.players.filter((p) => !p.out), thin = alive.filter((p) => p.n < TENNIS_2026.min_matches);
    g('players.rated', thin.length <= alive.length / 3, alive.length + ' players still in: ' + (alive.length - thin.length) + ' with ' + TENNIS_2026.min_matches + ' or more matches on file, ' + thin.length + ' with fewer' + (thin.length ? ' (' + thin.slice(0, 4).map((p) => p.name + ' ' + p.n).join(', ') + ')' : ''), 'publication');
    g('draw.open', dd.scheduled.length > 0 || alive.length > 1, dd.scheduled.length + ' matches ready to play, ' + alive.length + ' players still in', 'publication');
  } else {
    const md = d as TennisMatchesData;
    g('matches.present', md.matches.length > 0 && md.matches.every((m) => m.p_a > 0 && m.p_a < 1), md.matches.length + ' scheduled singles matches with both players known');
    const ps = md.matches.flatMap((m) => [m.a, m.b]), thin = ps.filter((p) => p.n < TENNIS_2026.min_matches);
    g('players.rated', thin.length <= ps.length / 3, ps.length + ' players: ' + (ps.length - thin.length) + ' with ' + TENNIS_2026.min_matches + ' or more matches on file, ' + thin.length + ' with fewer', 'publication');
  }
  const age = (nowMs - Date.parse(d.as_of)) / 3600e3;
  g('results.current', Number.isFinite(age) && age <= TENNIS_2026.max_feed_age_hours, 'scoreboard read ' + d.as_of + ' (' + (Number.isFinite(age) ? age.toFixed(1) : '?') + ' h ago; at most ' + TENNIS_2026.max_feed_age_hours + ' h to publish) from ' + d.source, 'publication');
  return out;
}

/** what the reader shows beside the per-player outcomes */
function readerSummary(d: TennisDrawData | TennisMatchesData) {
  if (d.kind === 'matches') {
    return { kind: 'tennis_matches', as_of: d.as_of, source: d.source, matches: d.matches, model: { version: d.elo.version, config: d.elo.config }, model_health: d.model };
  }
  const P = new Map(d.players.map((p) => [p.id, p]));
  const name = (id: string | null) => (id ? P.get(id)!.name : null);
  const levelName = (l: number) => Object.entries(d.rounds).find(([, x]) => x === l)?.[0] || (l === 6 ? 'Final' : l === 5 ? 'Semifinal' : l === 4 ? 'Quarterfinal' : 'Round');
  return {
    kind: 'tennis_draw', tour: d.tour, tour_label: d.tour_label, as_of: d.as_of, source: d.source, tournament: d.tournament,
    order: d.order, best_of: d.draw.bo, first_level: d.draw.first_level, rounds: d.rounds,
    lines: d.draw.lines.map((id, i) => ({ line: i + 1, id, name: name(id), bye: id == null })),
    results: d.draw.results.map((r) => ({ ...r, round: levelName(r.level), winner_name: name(r.winner), loser_name: r.loser ? (P.get(r.loser)?.name ?? null) : null })),
    scheduled: d.scheduled.map((m) => ({ ...m, a_name: name(m.a), b_name: name(m.b) })),
    players: d.players.map((p) => ({ id: p.id, name: p.name, seed: p.seed, entry: p.entry, rank: p.rank, rating: p.rating, n: p.n, out: p.out, line: p.line + 1 })),
    model: { version: d.elo.version, config: d.elo.config }, model_health: d.model
  };
}

async function runOne(snap: TennisSnapshot, a: TennisArgs, outRoot: string, log: (s: string) => void): Promise<TennisRunOutcome | { refused: Gate[] }> {
  const inputGates = validateTennisInputs(snap, a.nowMs);
  const d = snap.data;
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) { log(d.competition + ': invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')); return { refused: inputGates }; }
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log(d.competition + (d.kind === 'draw' ? ' ' + (d as TennisDrawData).tournament.name : ' (the day\'s matches)') + ' · inputs ' + snap.input_hash.slice(0, 12) + ' · as of ' + d.as_of + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'tennis', data: d, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const P = d.kind === 'draw' ? new Map((d as TennisDrawData).players.map((p) => [p.id, p])) : null;
  const M = d.kind === 'matches' ? new Map((d as TennisMatchesData).matches.flatMap((m) => [['m' + m.id + ':' + m.a.id, { m, side: m.a, opp: m.b, p: m.p_a }], ['m' + m.id + ':' + m.b.id, { m, side: m.b, opp: m.a, p: 1 - m.p_a }]] as Array<[string, any]>)) : null;
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.elo.version, config: { elo: d.elo.config, kind: d.kind, ...(d.kind === 'draw' ? { lines: (d as TennisDrawData).draw.lines.length, best_of: (d as TennisDrawData).draw.bo, order: (d as TennisDrawData).order.source } : {}) },
    rules_version: TENNIS_2026.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => {
      if (P) { const p = P.get(id)!; return { record: { seed: p.seed, entry: p.entry, rank: p.rank, rating: p.rating, n: p.n, line: p.line + 1, out: p.out, exact: (d as TennisDrawData).exact[id] }, math_status: { eliminated: p.out } }; }
      const x = M!.get(id)!; return { record: { match_id: x.m.id, tournament: x.m.tournament, round: x.m.round, at: x.m.at, opponent: x.opp.name, rating: x.side.rating, n: x.side.n, seed: x.side.seed, rank: x.side.rank, price: x.p, best_of: x.m.bo }, math_status: { eliminated: false } };
    } });
  (results as any).sport_summary = readerSummary(d as any);
  const reg = sportRegistry().find((s) => s.key === 'tennis')!;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none',
      detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate sum holds (' + module.sumRules.map((r) => r.perGroup + ' ' + r.outcome + (r.by === 'league' ? '' : ' per ' + r.by)).join(', ') + ')' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((x) => x.blocks === 'none');
  const outDir = path.join(outRoot, d.competition);
  fs.mkdirSync(outDir, { recursive: true });
  writeTennisSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export async function executeTennis(a: TennisArgs, log: (s: string) => void = console.log): Promise<TennisOutcome> {
  if (!a.snapshot && a.season !== TENNIS_2026.season) throw Object.assign(new Error('no tennis season config for ' + a.season + ' (configured: ' + TENNIS_2026.season + ')'), { exitCode: 2 });
  let snaps: TennisSnapshot[], skipped: TennisOutcome['skipped'] = [];
  if (a.snapshot) snaps = [readTennisSnapshot(a.snapshot)];
  else { const b = await buildTennisSnapshots({ offline: a.offline, log }); snaps = b.snapshots; skipped = b.skipped; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outRoot = a.out || path.join(REPO, 'simulator', 'out', 'tennis-' + TENNIS_2026.season + '-' + stamp);
  const runs: TennisRunOutcome[] = [], refused: TennisOutcome['refused'] = [];
  for (const s of snaps) {
    const o = await runOne(s, a, outRoot, log);
    if ('refused' in o) refused.push({ competition: s.data.competition, gates: o.refused }); else runs.push(o);
  }
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'tennis_runs.json'), JSON.stringify({ schema: 'edgedesk_sim_tennis_runs_v1', runs: runs.map((r) => ({ competition: r.results.run.competition, dir: path.basename(r.outDir), publishable: r.publishable, input_hash: r.snapshot.input_hash })),
    refused: refused.map((r) => ({ competition: r.competition, failed: r.gates.filter((g) => g.status === 'FAIL').map((g) => g.id + ': ' + g.detail) })), skipped }, null, 1));
  if (!runs.length && !refused.length) log('tennis: nothing to simulate (' + skipped.map((s) => s.draw + ': ' + s.reason).join(' | ') + ')');
  return { sport: 'tennis', runs, skipped, refused, outDir: outRoot };
}

export function printTennisSummary(o: TennisOutcome, log: (s: string) => void): void {
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1).padEnd(3) : '   —     ');
  for (const r of o.runs) {
    const R = r.results as any, S = R.sport_summary;
    if (S.kind === 'tennis_draw') {
      log('== ' + S.tour_label + ': ' + S.tournament.name + ' (' + R.run.competition + ') · ' + S.lines.length + ' lines from ' + S.order.source + (S.order.article ? ' (' + S.order.article.title + ')' : '') + ' · best of ' + S.best_of);
      log('runs ' + R.run.n_sims + ' · ' + (R.run.runtime_ms / 1000).toFixed(1) + ' s · ' + R.run.workers + ' worker(s) · peak RSS ' + R.run.peak_rss_mb + ' MB');
      log('player                    seed  rating  title      final      semis      quarters   next match (percent, ±95% Monte Carlo half-width)');
      const ents = (R.entities as any[]).filter((e) => !e.record.out).sort((x, z) => z.outcomes.win_title.probability - x.outcomes.win_title.probability);
      for (const e of ents.slice(0, 20)) log(String(e.entity_name).slice(0, 24).padEnd(25) + String(e.record.seed || e.record.entry || '').padEnd(6) + String(Math.round(e.record.rating)).padStart(6) + '  ' + [e.outcomes.win_title, e.outcomes.reach_final, e.outcomes.reach_semifinal, e.outcomes.reach_quarterfinal, e.outcomes.win_next_match].map(pp).join('  '));
      for (const m of S.scheduled) log('  ' + m.round + ': ' + m.a_name + ' v ' + m.b_name + ' · ' + (100 * m.p_a).toFixed(1) + '% / ' + (100 * (1 - m.p_a)).toFixed(1) + '%');
    } else {
      log('== the day\'s matches (' + R.run.competition + ') · ' + S.matches.length + ' matches · runs ' + R.run.n_sims);
      for (const m of S.matches.slice(0, 25)) log('  ' + String(m.tournament).slice(0, 28).padEnd(29) + String(m.round).slice(0, 22).padEnd(23) + m.a.name + ' v ' + m.b.name + ' · ' + (100 * m.p_a).toFixed(1) + '%');
    }
    for (const g of r.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
    log((r.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), r.outDir));
  }
  for (const r of o.refused) log('REFUSED ' + r.competition + ': ' + r.gates.filter((g) => g.status === 'FAIL').map((g) => g.id + ' (' + g.detail + ')').join('; '));
  for (const s of o.skipped) log('skipped ' + s.draw + ': ' + s.reason);
}

/** every publishable competition, through the shared publisher; the exit code (0 all published or nothing to publish, 1 a gate blocked one, 3 a publication failed) */
export async function publishTennis(o: TennisOutcome, log: (s: string) => void): Promise<number> {
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
