/* WNBA postseason simulation:
   - series grouping from a SYNTHETIC schedule (rounds, wins, formats measured from the games listed)
   - the module on a SYNTHETIC Finals: sum rules, titles in k games sum to the titles, every game keeps the
     served probability on average (the carve-out), the title probability equals an exact calculation (a
     series recursion integrated over the shared offset), tau = 0 gives independent games
   - determinism and worker-count independence
   - the input gates (two open series, a started game without a final, tau outside its interval)
   - the committed 2026 data: the snapshot builds offline, every remaining game is priced exactly as the
     served board prices it, and the registry and the nightly plan carry the WNBA */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kit } from './_kit.ts';
import { groupSeries, buildWnbaSnapshot, type WnbaInputData } from '../src/sports/wnba/inputs.ts';
import { wnbaModule } from '../src/sports/wnba/module.ts';
import { validateWnbaInputs, executeWnba } from '../src/sports/wnba/run.ts';
import { runRange, summarise, checkAggregateSums } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { normalCdf, normalQuantile } from '../src/core/normal.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns } from '../src/cli/plan.ts';
import { REPO } from '../src/sports/wnba/model_adapter.ts';

const K = kit('WNBA postseason simulation');

/* ---- SYNTHETIC schedule: a first round (best of 3), a semifinal (best of 5) and an open Finals ---- */
const G = (id: string, start: string, home: string, away: string, hs: number | null, as: number | null) => ({ game_id: id, type: 'P', start_utc: start, home_id: home, away_id: away, status: hs == null ? 'SCHEDULED' : 'FINAL', hs, as, ot: hs == null ? null : 0 });
{
  const games = [
    G('1', '2026-09-01T00:00:00Z', 'A', 'H', 80, 70), G('2', '2026-09-03T00:00:00Z', 'H', 'A', 60, 75),
    G('3', '2026-09-01T02:00:00Z', 'B', 'G', 70, 72), G('4', '2026-09-03T02:00:00Z', 'G', 'B', 65, 80), G('5', '2026-09-05T02:00:00Z', 'B', 'G', 90, 70),
    G('6', '2026-09-10T00:00:00Z', 'A', 'B', 80, 70), G('7', '2026-09-12T00:00:00Z', 'A', 'B', 80, 70), G('8', '2026-09-14T00:00:00Z', 'B', 'A', 70, 80),
    G('9', '2026-09-20T00:00:00Z', 'C', 'A', 90, 80), G('10', '2026-09-22T00:00:00Z', 'C', 'A', 70, 80), G('11', '2026-09-24T00:00:00Z', 'A', 'C', 85, 80),
    G('12', '2026-09-26T00:00:00Z', 'A', 'C', null, null), G('13', '2026-09-28T00:00:00Z', 'C', 'A', null, null), G('14', '2026-09-30T00:00:00Z', 'A', 'C', null, null), G('15', '2026-10-02T00:00:00Z', 'C', 'A', null, null)
  ];
  const s = groupSeries(games, new Map([['9', 0.6]]));
  const by = (k: string) => s.find((x) => x.key === k)!;
  K.eq('SYNTHETIC: four series, in order of their first game', s.map((x) => x.key), ['A-H', 'B-G', 'A-B', 'A-C']);
  K.eq('SYNTHETIC: rounds from each club\'s earlier series', s.map((x) => x.round), [1, 1, 2, 3]);
  K.eq('SYNTHETIC: a decided best-of-3 (2-0) and best-of-3 that went the distance (2-1)', [by('A-H').best_of, by('A-H').winner, by('B-G').best_of, by('B-G').winner, by('B-G').wins], [3, 'A', 3, 'B', { B: 2, G: 1 }]);
  K.eq('SYNTHETIC: a 3-0 semifinal is a best of 5, decided', [by('A-B').best_of, by('A-B').wins_needed, by('A-B').winner], [5, 3, 'A']);
  K.eq('SYNTHETIC: the open Finals lists seven games: first to four, 2-1', [by('A-C').best_of, by('A-C').wins_needed, by('A-C').winner, by('A-C').wins], [7, 4, null, { A: 2, C: 1 }]);
  K.eq('SYNTHETIC: the served pre-game probability rides on its game', by('A-C').games[0].p_home_pregame, 0.6);
}

/* ---- SYNTHETIC Finals: A leads C 2-1, games 4-7 remaining ---- */
function synth(tau: number): WnbaInputData {
  const sg = (n: number, home: string, away: string, hs: number | null, as: number | null) => ({ game_id: 'g' + n, n, start_utc: '2026-10-' + String(10 + 2 * n).padStart(2, '0') + 'T00:00:00Z', home, away, status: (hs == null ? 'SCHEDULED' : 'FINAL') as 'FINAL' | 'SCHEDULED', hs, as, ot: null, p_home_pregame: null });
  const fin = { key: 'A-C', round: 3, teams: ['A', 'C'] as [string, string], best_of: 7, wins_needed: 4, wins: { A: 2, C: 1 }, winner: null,
    games: [sg(1, 'C', 'A', 70, 80), sg(2, 'C', 'A', 80, 70), sg(3, 'A', 'C', 80, 70), sg(4, 'A', 'C', null, null), sg(5, 'C', 'A', null, null), sg(6, 'A', 'C', null, null), sg(7, 'C', 'A', null, null)] };
  const semi = (k: string, a: string, b: string, w: string) => ({ key: k, round: 2, teams: [a, b] as [string, string], best_of: 5, wins_needed: 3, wins: { [a]: w === a ? 3 : 0, [b]: w === b ? 3 : 0 }, winner: w, games: [] });
  const first = (k: string, a: string, b: string) => ({ key: k, round: 1, teams: [a, b] as [string, string], best_of: 3, wins_needed: 2, wins: { [a]: 2, [b]: 0 }, winner: a, games: [] });
  const P: Record<number, number> = { 4: 0.62, 5: 0.52, 6: 0.62, 7: 0.52 };
  return {
    sport: 'wnba', season: 2026, competition: 'WNBA Playoffs', as_of: '2026-10-16',
    teams: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => ({ id, name: 'Club ' + id, record: { w: 20, l: 20 } })),
    series: [first('A-H', 'A', 'H'), first('B-G', 'B', 'G'), first('C-F', 'C', 'F'), first('D-E', 'D', 'E'), semi('A-B', 'A', 'B', 'A'), semi('C-D', 'C', 'D', 'C'), fin],
    remaining: [4, 5, 6, 7].map((n) => ({ game_id: 'g' + n, series: 'A-C', n, start_utc: fin.games[n - 1].start_utc, home: fin.games[n - 1].home, away: fin.games[n - 1].away, m: 0, p_home: P[n], margin_mu: 0 })),
    rounds: 3,
    strength: { tau_points: tau, ci95: [0, 5], sd_margin: 12.5, conditional_sd: Math.sqrt(12.5 * 12.5 - tau * tau), study_sha256: 'synthetic', holdout_tau_points: 0, source: 'synthetic' },
    model: { model_version: 'synthetic', params: {}, calibration: { version: 'synthetic', intercept: 'home_games_only', win: [0, 0.126], margin: { a: 0, b: 1 }, sd_margin: 12.5, n: 0 }, ratings_through: '2026-10-16',
      served: { file: 'synthetic', generated_at: null, last_game_date: '2026-10-16', same_finals: true, max_rating_diff: 0 } },
    code: {}, config: { rules_version: 'WNBA-PO-2026', series_format: 'synthetic', home_court: 'synthetic' },
    health: { windows: [], playoff_calibration: [] }
  };
}
/** exact P(A wins the Finals): the series recursion for each shared offset, integrated over N(0, tau^2) */
function exactTitle(d: WnbaInputData, tau: number): number {
  const sigma = d.strength.sd_margin, s = Math.sqrt(sigma * sigma - tau * tau);
  const rem = d.remaining.slice().sort((a, b) => a.n - b.n);
  const series = (delta: number) => {
    const ps = rem.map((g) => { const p = normalCdf((normalQuantile(g.p_home) * sigma + (g.home === 'A' ? delta : -delta)) / s); return g.home === 'A' ? p : 1 - p; });
    const rec = (i: number, a: number, c: number): number => (a >= 4 ? 1 : c >= 4 ? 0 : ps[i] * rec(i + 1, a + 1, c) + (1 - ps[i]) * rec(i + 1, a, c + 1));
    return rec(0, 2, 1);
  };
  if (tau === 0) return series(0);
  let num = 0, den = 0;
  for (let i = -800; i <= 800; i++) { const x = i / 100, w = Math.exp(-x * x / 2); num += w * series(tau * x); den += w; }
  return num / den;
}
{
  const N = 200000;
  for (const tau of [0, 2.6914, 6]) {
    const d = synth(tau);
    const m = wnbaModule(d, { seed: 99n });
    const agg = runRange(m, { start: 0, end: N });
    const r = summarise(m, agg);
    const pA = r.find((e) => e.entity_id === 'A')!.outcomes.win_title.probability;
    const want = exactTitle(d, tau), se = Math.sqrt(want * (1 - want) / N);
    K.near('SYNTHETIC tau ' + tau + ': P(A title) equals the exact series recursion within 4 Monte Carlo SE', pA, want, 4 * se);
    K.eq('SYNTHETIC tau ' + tau + ': sum rules on every run and in aggregate', [agg.violations.length, checkAggregateSums(m, agg)], [0, []]);
    const titles = r.reduce((s, e) => s + e.outcomes.win_title.count, 0), byK = r.reduce((s, e) => s + ['title_in_4', 'title_in_5', 'title_in_6', 'title_in_7'].reduce((x, k) => x + e.outcomes[k].count, 0), 0);
    K.eq('SYNTHETIC tau ' + tau + ': titles in exactly k games sum to the titles; none in 4 (already 3 games played, 2-1)', [byK, titles, r.reduce((s, e) => s + e.outcomes.title_in_4.count, 0)], [N, N, 0]);
    /* game 4 is always played: its home-win rate is the served price, whatever tau is (the carve-out) */
    const g4 = (agg.diags.game_4_home_win || 0) / N;
    K.near('SYNTHETIC tau ' + tau + ': game 4 (always played) is won at home at the served 62%', g4, 0.62, 4 * Math.sqrt(0.62 * 0.38 / N));
    K.eq('SYNTHETIC tau ' + tau + ': game 4 and game 5 are played in every run (2-1, first to 4)', [agg.diags.game_4_played, agg.diags.game_5_played], [N, N]);
    K.chk('SYNTHETIC tau ' + tau + ': rounds already decided are exact (A, C finalists; A, B, C, D semifinalists)', ['A', 'C'].every((t) => r.find((e) => e.entity_id === t)!.outcomes.reach_finals.probability === 1)
      && ['A', 'B', 'C', 'D'].every((t) => r.find((e) => e.entity_id === t)!.outcomes.reach_semifinals.probability === 1) && ['E', 'F', 'G', 'H'].every((t) => r.find((e) => e.entity_id === t)!.outcomes.win_title.count === 0));
  }
  /* the shared offset widens the series' spread: the leader's edge shrinks toward a coin as tau grows (here the
     leader is also the better-priced club), and the run-level games move together */
  const p0 = exactTitle(synth(0), 0), p6 = exactTitle(synth(6), 6);
  K.chk('SYNTHETIC: a larger shared offset moves the title probability (games no longer independent)', Math.abs(p0 - p6) > 0.003, { p0, p6 });
  K.throws('SYNTHETIC: tau at or above the served margin sd is refused (nothing left to carve out of)', () => wnbaModule(synth(12.5), { seed: 1n }), /must be below/);
}

/* ---- determinism and worker-count independence ---- */
{
  const d = synth(2.6914);
  const a = await runPlan({ sport: 'wnba', data: d, seed: 7n, runs: 20000, workers: 1, traceRuns: [0] });
  const b = await runPlan({ sport: 'wnba', data: d, seed: 7n, runs: 20000, workers: 3, traceRuns: [0] });
  K.eq('the same seed gives byte-identical counts with 1 and 3 workers', [a.agg.counts, a.agg.hist, a.agg.diags], [b.agg.counts, b.agg.hist, b.agg.diags]);
  const c = await runPlan({ sport: 'wnba', data: d, seed: 8n, runs: 20000, workers: 1, traceRuns: [] });
  K.chk('a different seed gives different counts', JSON.stringify(c.agg.counts) !== JSON.stringify(a.agg.counts));
  K.chk('a traced run records the offset, each game and the champion', a.agg.traces[0] && a.agg.traces[0].events.some((e: any) => e.ev === 'start') && a.agg.traces[0].events.some((e: any) => e.ev === 'champion'));
}

/* ---- input gates ---- */
{
  const snap = { schema: 'edgedesk_sim_wnba_input_v1', input_hash: 'x', data: synth(2.6914), meta: { built_at: '', builder: '', refresh: null, feeds: [] } };
  const now = Date.parse('2026-10-17T00:00:00Z');
  const ok = validateWnbaInputs(snap, now);
  K.chk('SYNTHETIC: a consistent open Finals passes every gate', ok.every((g) => g.status === 'PASS'), ok.filter((g) => g.status !== 'PASS'));
  const two = JSON.parse(JSON.stringify(snap)); two.data.series[5].winner = null;
  K.chk('SYNTHETIC: two open series at once are refused before simulating', validateWnbaInputs(two, now).some((g) => g.id === 'schedule.series' && g.status === 'FAIL' && g.blocks === 'simulation'));
  K.chk('SYNTHETIC: a scheduled game that started 7 h ago without a final blocks publication', validateWnbaInputs(snap, Date.parse('2026-10-18T07:00:00Z')).some((g) => g.id === 'results.current' && g.blocks === 'publication'));
  const done = JSON.parse(JSON.stringify(snap)); done.data.remaining = [];
  K.chk('SYNTHETIC: a finished postseason blocks publication (nothing to simulate)', validateWnbaInputs(done, now).some((g) => g.id === 'postseason.open' && g.blocks === 'publication'));
  const wide = JSON.parse(JSON.stringify(snap)); wide.data.strength.tau_points = 9;
  K.chk('SYNTHETIC: tau outside its study interval is refused', validateWnbaInputs(wide, now).some((g) => g.id === 'strength.carve_out' && g.status === 'FAIL'));
  const drift = JSON.parse(JSON.stringify(snap)); drift.data.model.served.max_rating_diff = 0.5;
  K.chk('SYNTHETIC: a replay that differs from the served ratings on the same finals blocks publication', validateWnbaInputs(drift, now).some((g) => g.id === 'model.served' && g.blocks === 'publication'));
}

/* ---- the committed 2026 data ---- */
{
  const snap = await buildWnbaSnapshot({ offline: true });
  const d = snap.data;
  K.chk('2026: the snapshot builds offline from the committed schedule and the served model', d.series.length >= 7 && d.teams.length === 8, { series: d.series.length, teams: d.teams.length });
  K.eq('2026: the replay reproduces the served ratings file when both hold the same finals', d.model.served.same_finals ? d.model.served.max_rating_diff : 0, 0);
  const slate = JSON.parse(fs.readFileSync(path.join(REPO, 'basketball', 'slate.json'), 'utf8'));
  const board = new Map(((slate.leagues.wnba || {}).games || []).map((g: any) => [String(g.game_id), g.prices.moneyline.home]));
  const shared = d.remaining.filter((r) => board.has(r.game_id));
  K.chk('2026: every remaining game on the published board is priced exactly as the board prices it (4 decimals)', shared.every((r) => Math.abs(r.p_home - (board.get(r.game_id) as number)) < 6e-5), shared.map((r) => [r.game_id, r.p_home, board.get(r.game_id)]));
  const gates = validateWnbaInputs(snap, Date.parse(d.as_of + 'T12:00:00Z'));
  K.chk('2026: the schedule, model and offset gates pass', gates.filter((g) => g.blocks === 'simulation').length === 0 && gates.find((g) => g.id === 'schedule.series')!.status === 'PASS', gates.filter((g) => g.status !== 'PASS'));
  if (d.remaining.length) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wnba-'));
    const o = await executeWnba({ season: 2026, runs: 5000, seed: '1', workers: 1, snapshot: null, out, traceRuns: [0], offline: true, nowMs: Date.parse(d.as_of + 'T12:00:00Z') }, () => {});
    const sum = (o.results as any).sport_summary;
    K.chk('2026: a run writes the results with the reader summary (series, remaining games, model health)', sum && sum.kind === 'wnba_postseason' && sum.remaining.length === d.remaining.length && sum.model_health.windows.length === 4);
    K.chk('2026: the first remaining game is played in every run', sum.remaining[0].p_played === 1);
    K.eq('2026: the run directory holds the snapshot, results, gates and manifest', ['gates.json', 'manifest.json', 'results.json', 'snapshot.json'].every((f) => fs.existsSync(path.join(out, f))), true);
  }
}

/* ---- registry and plan ---- */
{
  const w = sportRegistry().find((s) => s.key === 'wnba')!;
  K.eq('the registry: WNBA ACTIVE (formats measured, not standing blockers), series structure, its tabs', [w.status, w.structure, w.tabs], ['ACTIVE', 'series', ['title', 'games', 'model_health']]);
  K.chk('the registry carries the WNBA limitations (served model, shared offset, no player input)', w.limitations.length >= 5 && w.limitations.some((l) => /player input/.test(l)));
  K.chk('the nightly plan runs the WNBA through its window and publishes it', planRuns('schedule', {}, undefined, new Date('2026-10-24T10:17:00Z')).some((r) => r.sport === 'wnba' && r.publish));
  K.chk('after the window the nightly plan leaves the WNBA out', !planRuns('schedule', {}, undefined, new Date('2026-11-09T10:17:00Z')).some((r) => r.sport === 'wnba'));
  K.eq('a dispatch can publish the WNBA', planRuns('workflow_dispatch', { sport: 'wnba', season: '2026', runs: '100000', seed: '', publish: 'true' }).map((r) => [r.sport, r.publish]), [['wnba', true]]);
}

process.exit(K.done());
