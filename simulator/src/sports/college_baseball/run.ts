/* ===========================================================================
   edgedesk-sim run, college baseball: snapshot (the served model replayed
   over the committed warehouse, inputs.ts) -> gates -> simulate -> results
   -> local files; publication through the shared publisher (publish/
   publish.ts), only when every gate passes. Called by cli/run.ts for
   --sport college_baseball.

   Gates (a FAIL that blocks simulation stops the run before it starts):
     model.replay       the served model replayed every warehouse game, and
                        the season has its run-space calibration
     season.window      the as-of date is before Selection Monday (from the
                        field's announcement the committee proxy no longer
                        applies)
     teams.field        at least 64 Division I programs, every conference
                        with an automatic bid among them
     research.params    the season's move and the committee proxy are finite
   Publication only:
     results.current    in season (config.in_season_from to the regionals),
                        the warehouse's last game is at most
                        config.max_results_age_days old
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
import { buildCbaseSnapshot, readCbaseSnapshot, writeCbaseSnapshot, type CbaseSnapshot, type CbaseRoadData } from './inputs.ts';
import { CBASE_2027 } from './config.ts';

export interface CbaseArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[]; nowMs?: number }
export interface CbaseOutcome { sport: 'college_baseball'; results: ResultsDoc | null; gates: Gate[]; snapshot: CbaseSnapshot; outDir: string; publishable: boolean }

export function validateCbaseInputs(snap: CbaseSnapshot, nowMs: number = Date.now()): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation'): void => { out.push({ id, status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  g('model.replay', d.model.games_replayed > 50000 && !!d.model.calibration, 'served model ' + d.model.version + ' replayed over ' + d.model.games_replayed + ' scored games (' + d.model.warehouse.first + '-' + d.model.warehouse.last + '); ' + d.season + ' run-space calibration ' + (d.model.calibration ? 'a ' + d.model.calibration.a + ', b ' + d.model.calibration.b + ' (' + d.model.calibration.n + ' games of the three seasons before)' : 'missing'));
  g('season.window', d.phase !== 'selected', d.phase === 'selected' ? 'as of ' + d.as_of + ', ' + d.days_to_regionals + ' days before the regionals: the field is announced, and this view stops on Selection Monday' : (d.phase === 'preseason' ? d.season + ' preseason (no ' + d.season + ' game in the warehouse; ratings as of ' + d.as_of + ')' : d.season + ' through ' + d.last_game) + '; ' + d.days_to_regionals + ' days to the regionals (' + CBASE_2027.regionals_start + ')');
  const confs = new Set(d.teams.map((id) => d.snapshot.teams[id].conf));
  const missing = d.aq_conferences.filter((c) => !confs.has(c));
  g('teams.field', d.teams.length >= 64 && !missing.length && d.aq_conferences.length < 64, d.teams.length + ' Division I programs, ' + d.aq_conferences.length + ' conferences with an automatic bid' + (missing.length ? '; no program in ' + missing.join(', ') : ''));
  const p = d.params, nums = [p.drift.slope, p.drift.team_sd, p.drift.conf_sd, p.drift.end_sd_team, p.drift.end_sd_conf, p.select.k, p.select.tau, p.select.tau_host];
  g('research.params', nums.every((x) => Number.isFinite(x)) && p.drift.team_sd > 0 && p.select.tau > 0, 'the move to Selection Monday: slope ' + p.drift.slope.toFixed(3) + ', team sd ' + p.drift.team_sd.toFixed(3) + ', conference sd ' + p.drift.conf_sd.toFixed(3) + '; the committee proxy: k ' + p.select.k + ', selection noise ' + p.select.tau + ', hosting noise ' + p.select.tau_host);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const inSeason = today >= CBASE_2027.in_season_from && today < CBASE_2027.regionals_start;
  const age = d.last_game ? Math.round((Date.parse(today) - Date.parse(d.last_game)) / 864e5) : null;
  g('results.current', !inSeason || (age != null && age <= CBASE_2027.max_results_age_days), inSeason ? 'in season: the warehouse\'s last ' + d.season + ' game is ' + (d.last_game ? d.last_game + ' (' + age + ' days ago; at most ' + CBASE_2027.max_results_age_days + ')' : 'missing') : 'out of season (' + today + '): the ratings stand until the season\'s first game', 'publication');
  return out;
}

/** what the reader shows beside the per-team outcomes */
export function cbaseReaderSummary(d: CbaseRoadData) {
  const S = d.snapshot;
  const net = (id: string) => S.teams[id].off + S.teams[id].def;
  const ranked = d.teams.slice().sort((a, b) => net(b) - net(a));
  const rank = new Map(ranked.map((id, i) => [id, i + 1]));
  const confs = [...new Set(d.teams.map((id) => S.teams[id].conf))].sort();
  return {
    kind: 'cbase_road', season: d.season, phase: d.phase, as_of: d.as_of, last_game: d.last_game, days_to_regionals: d.days_to_regionals, regionals_start: CBASE_2027.regionals_start,
    teams: d.teams.map((id) => ({ id, name: S.teams[id].name, conf: S.teams[id].conf, net: Math.round(net(id) * 1e4) / 1e4, rank: rank.get(id), sd: Math.round(Math.sqrt(S.teams[id].sd_team ** 2 + S.teams[id].sd_conf ** 2) * 1e4) / 1e4 })),
    conferences: confs.map((c) => ({ name: c, aq: d.aq_conferences.includes(c), teams: d.teams.filter((id) => S.teams[id].conf === c).length })),
    params: d.params, model: d.model, model_health: d.model_health, not_modelled: CBASE_2027.not_modelled
  };
}

export async function executeCbase(a: CbaseArgs, log: (s: string) => void = console.log): Promise<CbaseOutcome> {
  if (!a.snapshot && a.season !== CBASE_2027.season) throw Object.assign(new Error('no college baseball season config for ' + a.season + ' (configured: ' + CBASE_2027.season + ')'), { exitCode: 2 });
  const snap = a.snapshot ? readCbaseSnapshot(a.snapshot) : buildCbaseSnapshot({ nowMs: a.nowMs, log });
  const d = snap.data;
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = a.out || path.join(REPO, 'simulator', 'out', 'college_baseball-' + d.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeCbaseSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const inputGates = validateCbaseInputs(snap, a.nowMs);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) {
    log('college baseball: invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; '));
    fs.writeFileSync(path.join(outDir, 'gates.json'), JSON.stringify(inputGates, null, 1));
    return { sport: 'college_baseball', results: null, gates: inputGates, snapshot: snap, outDir, publishable: false };
  }
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log('college baseball ' + d.competition + ' ' + d.season + ' · ' + d.phase + ' · inputs ' + snap.input_hash.slice(0, 12) + ' · as of ' + d.as_of + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'college_baseball', data: d, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const S = d.snapshot;
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.version, config: { tq: d.model.tq, dist: d.model.dist, calibration: d.model.calibration, drift: d.params.drift, select: d.params.select, phase: d.phase, as_of: d.as_of },
    rules_version: CBASE_2027.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: Date.now() - t0, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => { const t = S.teams[id]; return { record: { conf: t.conf, net: Math.round((t.off + t.def) * 1e4) / 1e4, off: Math.round(t.off * 1e4) / 1e4, def: Math.round(t.def * 1e4) / 1e4, sd: Math.round(Math.sqrt(t.sd_team ** 2 + t.sd_conf ** 2) * 1e4) / 1e4, aq_conference: d.aq_conferences.includes(t.conf) }, math_status: { eliminated: false } }; } });
  (results as any).sport_summary = cbaseReaderSummary(d);
  const reg = sportRegistry().find((s) => s.key === 'college_baseball')!;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length ? 'publication' : 'none',
      detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : 'every per-run and aggregate sum holds (' + module.sumRules.map((r) => r.perGroup + ' ' + r.outcome + (r.by === 'league' ? '' : ' per ' + r.by)).join(', ') + ')' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((x) => x.blocks === 'none');
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { sport: 'college_baseball', results, gates, snapshot: snap, outDir, publishable };
}

export function printCbaseSummary(o: CbaseOutcome, log: (s: string) => void): void {
  const R = o.results as any;
  if (R) {
    const S = R.sport_summary;
    log('== College Baseball ' + S.season + ': the Road to Omaha (' + S.phase + ', as of ' + S.as_of + ') · ' + S.teams.length + ' Division I teams · ' + S.conferences.filter((c: any) => c.aq).length + ' automatic bids');
    log('runs ' + R.run.n_sims + ' · ' + (R.run.runtime_ms / 1000).toFixed(1) + ' s · ' + R.run.workers + ' worker(s) · peak RSS ' + R.run.peak_rss_mb + ' MB');
    const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1).padEnd(3) : '   —     ');
    log('team                      conf               field      host       omaha      final      title (percent, ±95% Monte Carlo half-width)');
    const ents = (R.entities as any[]).slice().sort((x, z) => z.outcomes.win_title.probability - x.outcomes.win_title.probability);
    for (const e of ents.slice(0, 25)) log(String(e.entity_name).slice(0, 24).padEnd(26) + String(e.record.conf).slice(0, 17).padEnd(19) + [e.outcomes.make_field, e.outcomes.host_regional, e.outcomes.reach_omaha, e.outcomes.reach_final, e.outcomes.win_title].map(pp).join('  '));
  }
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}

/** publish when every gate passed; the exit code (0 published, 1 a gate blocked it, 3 the publication failed) */
export async function publishCbase(o: CbaseOutcome, log: (s: string) => void): Promise<number> {
  if (!o.publishable || !o.results) { log('nothing published for college baseball: a gate failed (see gates.json)'); return 1; }
  const { publishRun } = await import('../../publish/publish.ts');
  try {
    const p = await publishRun(o as any, { log });
    fs.writeFileSync(path.join(o.outDir, 'publish.json'), JSON.stringify(p, null, 1));
    log('published college baseball run ' + p.run_id + ' (' + p.status + ')');
    return 0;
  } catch (e) { log('publish failed for college baseball: ' + (e as Error).message + ' — the previously published run is unchanged'); return 3; }
}
