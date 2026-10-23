/* ===========================================================================
   edgedesk-sim run, WNBA: snapshot -> gates -> simulate -> results -> local
   files; publication through the shared publisher (publish/publish.ts) only
   when every gate passes. Called by cli/run.ts for --sport wnba.

   Gates (a FAIL that blocks simulation stops before a single run):
     schedule.series        every playoff game belongs to a series of two
                            clubs; at most one series is open; an open
                            series lists an odd number of games and no club
                            has more wins than it needs (config.ts: the
                            format is MEASURED from the schedule)
     schedule.final_round   the final round's two clubs are known (a round
                            not yet paired is never invented)
     model.remaining_priced every remaining game priced, 0 < p < 1
     strength.carve_out     tau (the study's) is below the served margin sd
   Publication only:
     postseason.open        a game remains (a finished postseason has
                            nothing to simulate)
     results.current        no scheduled game started more than 6 h ago (a
                            final the source has not delivered yet would be
                            simulated as if unplayed)
     model.served           the replay equals the served ratings file
                            (basketball/params/wnba_live.json) when both hold
                            the same finals
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
import { REPO } from './model_adapter.ts';
import { buildWnbaSnapshot, readWnbaSnapshot, writeWnbaSnapshot, type WnbaSnapshot, type WnbaInputData } from './inputs.ts';
import { seriesState } from './module.ts';
import { WNBA_2026 } from './config.ts';

export interface WnbaArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[]; offline: boolean; nowMs?: number }

export function validateWnbaInputs(snap: WnbaSnapshot, nowMs: number = Date.now()): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => { out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  const open = d.series.filter((s) => s.winner == null);
  const bad = d.series.filter((s) => s.teams.length !== 2 || s.best_of % 2 !== 1 || s.teams.some((t) => (s.wins[t] || 0) > s.wins_needed));
  g('schedule.series', !bad.length && open.length <= 1, d.series.length + ' series (' + d.series.map((s) => 'R' + s.round + ' ' + s.teams.join('-') + ' ' + s.teams.map((t) => s.wins[t]).join('-') + (s.winner ? ' final' : ' of ' + s.best_of)).join(', ') + ')'
    + (bad.length ? '; inconsistent: ' + bad.map((s) => s.key).join(', ') : '') + (open.length > 1 ? '; ' + open.length + ' series open at once (not supported: the 2026 configuration simulates one open series)' : ''));
  const { final } = seriesState(d);
  g('schedule.final_round', !!final && final.teams.length === 2 && d.series.filter((s) => s.round === d.rounds).length === 1,
    final ? 'final round ' + d.rounds + ': ' + final.teams.join(' v ') : 'no final-round series on the schedule yet (its clubs are not known; the bracket is not invented)');
  const badP = d.remaining.filter((r) => !(r.p_home > 0 && r.p_home < 1));
  g('model.remaining_priced', !badP.length, d.remaining.length + ' remaining games priced by the served model' + (badP.length ? '; unpriced: ' + badP.map((r) => r.game_id).join(', ') : ''));
  const t = d.strength;
  g('strength.carve_out', t.tau_points >= 0 && t.tau_points < t.sd_margin && t.tau_points >= t.ci95[0] && t.tau_points <= t.ci95[1],
    'tau ' + t.tau_points + ' points (95% CI ' + t.ci95.join('-') + ') carved out of the served margin sd ' + t.sd_margin + ' (conditional game sd ' + t.conditional_sd + ')');
  g('postseason.open', d.remaining.length > 0, d.remaining.length ? d.remaining.length + ' games left (' + d.remaining.map((r) => 'game ' + r.n + ' ' + r.start_utc.slice(0, 10)).join(', ') + ')' : 'the postseason is over: nothing to simulate', 'publication');
  const late = d.remaining.filter((r) => Date.parse(r.start_utc) < nowMs - 6 * 3600e3);
  g('results.current', !late.length, late.length ? 'scheduled games that started more than 6 h ago without a final in the source: ' + late.map((r) => r.game_id + ' (' + r.start_utc + ')').join(', ') : 'every game that has started is final in the source', 'publication');
  const sv = d.model.served;
  const served = sv.same_finals ? sv.max_rating_diff != null && sv.max_rating_diff <= 1e-3 : true;
  g('model.served', served, sv.same_finals ? 'the replay equals ' + sv.file + ' (max rating difference ' + sv.max_rating_diff + ', both through ' + sv.last_game_date + ')'
    : 'the data hold finals newer than ' + sv.file + ' (through ' + sv.last_game_date + '); the replay (through ' + d.model.ratings_through + ') prices the remaining games with the same code', 'publication');
  return out;
}

/** what the reader shows beside the per-club outcomes: the series, each game, the model's playoff record */
function readerSummary(d: WnbaInputData, diags: Record<string, number>, n: number) {
  const { open, final } = seriesState(d);
  const name = new Map(d.teams.map((t) => [t.id, t.name]));
  return {
    kind: 'wnba_postseason',
    as_of: d.as_of,
    shared_offset: { tau_points: d.strength.tau_points, ci95: d.strength.ci95, holdout_tau_points: d.strength.holdout_tau_points, sd_margin: d.strength.sd_margin },
    series: d.series.map((s) => ({ key: s.key, round: s.round, teams: s.teams, names: s.teams.map((t) => name.get(t) || t), wins: s.wins, best_of: s.best_of, wins_needed: s.wins_needed, winner: s.winner,
      games: s.games.map((g) => ({ n: g.n, game_id: g.game_id, start_utc: g.start_utc, home: g.home, away: g.away, status: g.status, hs: g.hs, as: g.as, ot: g.ot, p_home_pregame: g.p_home_pregame })) })),
    open_series: open ? open.key : null, final_series: final ? final.key : null,
    remaining: d.remaining.map((r) => {
      const played = diags['game_' + r.n + '_played'] || 0, hw = diags['game_' + r.n + '_home_win'] || 0;
      return { n: r.n, game_id: r.game_id, start_utc: r.start_utc, home: r.home, away: r.away, served_p_home: r.p_home, projected_margin: r.margin_mu,
        played_count: played, p_played: played / n, home_win_count: hw, p_home_given_played: played ? hw / played : null };
    }),
    model_health: d.health
  };
}

export async function executeWnba(a: WnbaArgs, log: (s: string) => void = console.log): Promise<{ results: ResultsDoc; gates: Gate[]; snapshot: WnbaSnapshot; outDir: string; publishable: boolean }> {
  if (!a.snapshot && a.season !== WNBA_2026.season) throw Object.assign(new Error('no WNBA season config for ' + a.season + ' (configured: ' + WNBA_2026.season + ')'), { exitCode: 2 });
  const snap = a.snapshot ? readWnbaSnapshot(a.snapshot) : await buildWnbaSnapshot({ offline: a.offline, season: a.season });
  const inputGates = validateWnbaInputs(snap, a.nowMs);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const d = snap.data;
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  const { open } = seriesState(d);
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · as of ' + d.as_of + ' · ' + (open ? open.teams.map((t) => t + ' ' + open.wins[t]).join('-') + ' (first to ' + open.wins_needed + ')' : 'no open series') + ' · ' + d.remaining.length + ' games left · tau ' + d.strength.tau_points + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'wnba', data: d, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const team = new Map(d.teams.map((t) => [t.id, t]));
  const eliminated = new Set(d.series.filter((s) => s.winner).map((s) => s.teams.find((t) => t !== s.winner) as string));
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: d.model.model_version, config: { model: d.model.params, calibration: d.model.calibration, strength: d.strength, rules: d.config },
    rules_version: d.config.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => ({ record: { ...(team.get(id) as any).record, playoffs: d.series.filter((s) => s.teams.includes(id)).map((s) => ({ round: s.round, opponent: s.teams.find((t) => t !== id), wins: s.wins[id], losses: s.wins[s.teams.find((t) => t !== id) as string], winner: s.winner })) },
      math_status: { eliminated: eliminated.has(id) } }) });
  (results as any).sport_summary = readerSummary(d, agg.diags, agg.n);
  const reg = sportRegistry().find((s) => s.key === 'wnba')!;
  const titleSum = (results.entities as any[]).reduce((s, e) => s + e.outcomes.win_title.count, 0);
  const byK = (results.entities as any[]).reduce((s, e) => s + Object.keys(e.outcomes).filter((k) => /^title_in_/.test(k)).reduce((x, k) => x + e.outcomes[k].count, 0), 0);
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: results.checks.sum_rule_errors.length || byK !== titleSum ? 'FAIL' : 'PASS', blocks: results.checks.sum_rule_errors.length || byK !== titleSum ? 'publication' : 'none',
      detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : byK !== titleSum ? 'title-in-k counts ' + byK + ' != titles ' + titleSum : 'every per-run and aggregate sum holds (one champion, two finalists, four semifinalists; titles in k games sum to the titles)' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((x) => x.blocks === 'none');
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = a.out || path.join(REPO, 'simulator', 'out', 'wnba-' + d.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeWnbaSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export function printWnbaSummary(o: { results: ResultsDoc; gates: Gate[]; outDir: string; publishable: boolean }, log: (s: string) => void): void {
  const r = o.results as any;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1) : '    —   ');
  const ents = (r.entities as any[]).slice().sort((a, b) => b.outcomes.win_title.probability - a.outcomes.win_title.probability);
  const ks = Object.keys(ents[0].outcomes).filter((k) => /^title_in_/.test(k));
  log('club                      W-L    title      ' + ks.map((k) => ('in ' + k.slice(9)).padEnd(11)).join('') + '(percent, ±95% Monte Carlo half-width)');
  for (const e of ents) if (e.outcomes.win_title.count > 0 || !(e.math_status && e.math_status.eliminated)) log(String(e.entity_name).padEnd(25) + (e.record.w + '-' + e.record.l).padEnd(7) + pp(e.outcomes.win_title) + '  ' + ks.map((k) => pp(e.outcomes[k]) + '  ').join(''));
  for (const g of r.sport_summary.remaining) log('game ' + g.n + ' ' + g.start_utc.slice(0, 10) + ' ' + g.away + ' @ ' + g.home + ': played ' + (100 * g.p_played).toFixed(1) + '%, home wins ' + (g.p_home_given_played == null ? '—' : (100 * g.p_home_given_played).toFixed(1) + '%') + ' if played (served ' + (100 * g.served_p_home).toFixed(1) + '%)');
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}
