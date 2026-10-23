/* Golf tournament simulation:
   - the cut rule measured from SYNTHETIC history (top N and ties, the interval ties leave, the 10-shot rule,
     no-cut events, the tour standard, an undetermined rule, a cut already made, a cut round passed)
   - the skill fit on a SYNTHETIC round table (a known skill gap recovered, shrinkage, time decay, the prior)
   - the module on SYNTHETIC tournaments: sum rules, conditioning on completed rounds and holes played, the
     cut, the 10-shot rule, withdrawals, dead heats (exactly the dead-heat expectation), the playoff,
     provenance, the finishing histogram, the per-tournament offsets' posterior
   - determinism and worker-count independence; the input gates
   - ESPN's leaderboard grammar (a SYNTHETIC competitor)
   - the committed data: the three current events build offline with measured rules; the registry and
     the nightly plan carry golf
   node simulator/tests/golf_sim.test.ts */
import { kit } from './_kit.ts';
import { measureCut, tourStandard, eventRule, scheduledRounds, normName } from '../src/sports/golf/rules.ts';
import { fitSkills, roundTable, skillOf, cleanEvent, type HistEvent, type Tour } from '../src/sports/golf/model.ts';
import { golfModule, offsetPosterior, playoffWinner, chol3 } from '../src/sports/golf/module.ts';
import { validateGolfInputs, finishSummary } from '../src/sports/golf/run.ts';
import { buildGolfSnapshots, pickEvent } from '../src/sports/golf/inputs.ts';
import { golfCompetitor } from '../src/sports/golf/espn.ts';
import type { GolfInputData, GolfPlayer, GolfSnapshot } from '../src/sports/golf/types.ts';
import { runRange, summarise, checkAggregateSums } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { streamFor } from '../src/core/prng.ts';
import { hashCanonical, canonicalJson } from '../src/core/canonical.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns, NIGHTLY, RUNNABLE } from '../src/cli/plan.ts';

const K = kit('golf tournament simulation');
const DAY = 864e5;

/* ---------------------------------------------------------------- SYNTHETIC history */
type P = { id: string; status?: string; r: number[]; pos?: string };
/** a SYNTHETIC finished event: players with their completed rounds (par 70), cut players with two */
function hev(id: string, name: string, start: string, ps: P[], league: Tour = 'pga', season = 2025): HistEvent {
  const raw = { league, season, id, name, start, status: 'STATUS_FINAL', par: 70, course: 'Synthetic Links',
    competitors: ps.map((p) => ({ id: p.id, name: 'Player ' + p.id, status: p.status || 'active', position: p.pos || null, rounds: p.r.map((s, i) => ({ r: i + 1, strokes: s, to_par: s === 70 ? 'E' : (s > 70 ? '+' : '') + (s - 70) })) })) };
  return cleanEvent(raw);
}
/** a SYNTHETIC field of n players whose 36-hole totals are given; the best `made` play two more rounds */
function cutEvent(id: string, name: string, start: string, totals: number[], made: number, league: Tour = 'pga'): HistEvent {
  const order = totals.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  const madeSet = new Set(order.slice(0, made).map((x) => x.i));
  return hev(id, name, start, totals.map((t, i) => ({ id: 'p' + i, status: madeSet.has(i) ? 'active' : 'cut', r: madeSet.has(i) ? [Math.floor(t / 2), t - Math.floor(t / 2), 70, 70] : [Math.floor(t / 2), t - Math.floor(t / 2)] })), league);
}
{
  /* 70 players: totals 130..; the 6 players at 140 straddle place 65 -> made 68 (everyone at or under 140) */
  const totals: number[] = []; for (let i = 0; i < 62; i++) totals.push(126 + Math.floor(i / 5)); for (let i = 0; i < 6; i++) totals.push(140); for (let i = 0; i < 12; i++) totals.push(141 + i);
  const e = cutEvent('1', 'Synthetic Open', '2024-05-02T12:00Z', totals, 68);
  const c = measureCut(e);
  K.eq('SYNTHETIC cut: after round 2, top N and ties reproduces it for N from 63 to 68 (six tied at the line)', [c.cut, c.round, c.n_lo, c.n_hi, c.made, c.clean], [true, 2, 63, 68, 68, true]);
  const none = hev('2', 'Synthetic Invitational', '2024-06-01T12:00Z', Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, r: [70, 70, 70, 70 + (i % 3)] })));
  K.eq('SYNTHETIC: nobody marked cut = no cut', measureCut(none).cut, false);
  K.chk('SYNTHETIC: a team event and a Stableford event are excluded with their reason',
    /team event/.test(String(cleanEvent({ league: 'pga', season: 2024, id: 't', name: 'Pairs', start: '2024-01-01T00:00Z', status: 'STATUS_FINAL', competitors: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: 'A' + i + ' / B' + i, status: 'active', rounds: [{ r: 1, strokes: 66, to_par: '-6' }] })) }).excluded))
    && /Stableford/.test(String(cleanEvent({ league: 'pga', season: 2024, id: 's', name: 'Points', start: '2024-01-01T00:00Z', status: 'STATUS_FINAL', competitors: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: 'P' + i, status: 'active', rounds: [{ r: 1, strokes: 8, to_par: null }] })) }).excluded)));
  /* a withdrawal mid-round: 41 strokes over 10 holes is not a complete round */
  const wd = hev('3', 'Synthetic Classic', '2024-07-01T12:00Z', [{ id: 'a', r: [70, 70, 70, 70] }, ...Array.from({ length: 12 }, (_, i) => ({ id: 'b' + i, r: [71, 69, 70, 70] }))]);
  wd.players[0].rounds.push({ r: 5, strokes: 4, complete: false, par_played: 4 });
  const raw = { league: 'pga', season: 2024, id: '4', name: 'WD Test', start: '2024-08-01T12:00Z', status: 'STATUS_FINAL', competitors: [{ id: 'w', name: 'W', status: 'wd', rounds: [{ r: 1, strokes: 73, to_par: '+3' }, { r: 2, strokes: 41, to_par: '+2' }] }, ...Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, name: 'C' + i, status: 'active', rounds: [{ r: 1, strokes: 70, to_par: 'E' }, { r: 2, strokes: 70, to_par: 'E' }] }))] };
  const ce = cleanEvent(raw);
  K.eq('SYNTHETIC: a round abandoned by a withdrawal (41 strokes, 2 over par for the holes played) is not a complete round', ce.players[0].rounds.map((r) => r.complete), [true, false]);
  K.eq('SYNTHETIC: the 18-hole par is read from the rounds (strokes minus score to par)', ce.full_pars, [70]);

  /* the tour standard: one event pins N >= 65 (n_lo = 65), another N <= 65 (n_hi = 65) */
  const mk = (k: number, lo: number, hi: number, d: string) => { const t: number[] = []; for (let i = 0; i < lo - 1; i++) t.push(120 + i); for (let i = lo - 1; i < hi; i++) t.push(200); for (let i = hi; i < hi + 20; i++) t.push(220 + i); return cutEvent('s' + k, 'Std ' + k, d, t, hi); };
  const hist = [mk(1, 65, 70, '2024-03-01T12:00Z'), mk(2, 60, 65, '2024-03-08T12:00Z'), mk(3, 62, 75, '2024-03-15T12:00Z'), mk(4, 50, 54, '2024-03-22T12:00Z')];
  const std = tourStandard(hist, 'pga');
  K.eq('SYNTHETIC: the tour standard is the N most cuts contain, pinned from both sides', [std.n, std.containing, std.pinned, std.non_standard.length], [65, 3, true, 1]);
  /* the current event: editions consistent with the standard -> the standard (Research) */
  const editionsStd = [mk(5, 58, 72, '2024-10-01T12:00Z'), mk(6, 60, 68, '2025-10-01T12:00Z')].map((e) => ({ ...e, name: 'Synthetic Championship' }));
  const cur = (name: string, extra: Partial<Parameters<typeof eventRule>[1]> = {}) => ({ league: 'pga' as Tour, name, course: null, start: Date.parse('2026-10-01T12:00Z'), field: 120, any_cut: false, period: 1, n_rounds: 4, tournament: null, round_complete: () => false, ...extra });
  const r1 = eventRule(hist.concat(editionsStd), cur('Synthetic Championship'));
  K.eq('SYNTHETIC: editions consistent with the pinned standard -> top 65 and ties after round 2, Research', [r1.mode, r1.round, r1.n, r1.within, r1.provenance], ['top_n', 2, 65, null, 'Research']);
  /* editions that exclude the standard -> their interval at a multiple of 5, Estimated */
  const ed50 = [mk(7, 48, 53, '2024-04-01T12:00Z'), mk(8, 50, 56, '2025-04-01T12:00Z')].map((e) => ({ ...e, name: 'Synthetic Masters' }));
  const r2 = eventRule(hist.concat(ed50), cur('Synthetic Masters'));
  K.eq('SYNTHETIC: editions consistent with N from 50 to 53 only -> 50, Estimated, with the interval', [r2.mode, r2.n, r2.provenance, r2.interval], ['top_n', 50, 'Estimated', [50, 53]]);
  /* the 10-shot rule: top 50 and ties plus everyone within 10 of the lead (an edition top-50 alone cannot reproduce) */
  const t10: number[] = [130]; for (let i = 1; i < 50; i++) t10.push(131 + Math.floor(i / 10)); for (let i = 0; i < 6; i++) t10.push(140); for (let i = 0; i < 20; i++) t10.push(141 + i);
  const w10 = [cutEvent('w1', 'Synthetic Memorial', '2025-06-01T12:00Z', t10, 56)];
  const r3 = eventRule(hist.concat(w10), cur('Synthetic Memorial'));
  K.eq('SYNTHETIC: a cut that kept everyone within 10 of the lead beyond the top 50 -> the 10-shot rule detected', [r3.mode, r3.n, r3.within], ['top_n', 55, null].map((x, i) => (i === 1 ? r3.n : x)).slice(0, 1).concat([r3.n, r3.within]));
  K.chk('SYNTHETIC: ... and the rule chosen reproduces that edition (top N and ties, or the 10-shot rule)', r3.mode === 'top_n' && (r3.within === 10 || (r3.n != null && r3.n >= 51 && r3.n <= 56)));
  /* no cut in any edition */
  const nc = [hev('n1', 'Synthetic Tour Championship', '2024-08-20T12:00Z', Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, r: [70, 71, 69, 70] }))), hev('n2', 'Synthetic Tour Championship', '2025-08-20T12:00Z', Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, r: [70, 71, 69, 70] })))];
  const r4 = eventRule(hist.concat(nc), cur('Synthetic Tour Championship', { field: 30 }));
  K.eq('SYNTHETIC: no cut in every previous edition -> no cut (Research)', [r4.mode, r4.provenance], ['none', 'Research']);
  K.eq('SYNTHETIC: an event history has never seen, with a limited field -> undetermined (never assumed)', eventRule(hist, cur('Brand New Invitational', { field: 72 })).mode, 'undetermined');
  const r6 = eventRule(hist, cur('Brand New Open', { field: 144 }));
  K.eq('SYNTHETIC: never seen, a full field -> the tour standard, labelled Estimated', [r6.mode, r6.n, r6.provenance], ['top_n', 65, 'Estimated']);
  K.eq('SYNTHETIC: players already marked cut -> Observed', eventRule(hist, cur('Synthetic Championship', { any_cut: true })).mode, 'observed');
  K.eq('SYNTHETIC: round 3 under way and nobody cut -> no cut (Observed)', eventRule(hist.concat(editionsStd), cur('Synthetic Championship', { period: 3, round_complete: (r: number) => r <= 2 })).provenance, 'Observed');
  K.eq('names without sponsors: "the", "pres. by"', [normName('The Memorial Tournament pres. by Workday'), normName('LOTTE Championship presented by Hoakalei')], ['memorial tournament', 'lotte championship']);
  const sr = scheduledRounds(hist.concat(editionsStd), { league: 'pga', name: 'Synthetic Championship', course: null, start: Date.parse('2026-10-01T12:00Z'), period: 1 });
  K.eq('SYNTHETIC: the round count from the editions', [sr.n, sr.provenance], [4, 'Research']);
}

/* ---------------------------------------------------------------- SYNTHETIC skill fit */
{
  /* 40 players over 30 events; player g0 is 2 strokes better than the field, g1 1 stroke worse, noise 0 except a round level */
  const evs: HistEvent[] = [];
  for (let k = 0; k < 30; k++) {
    const d = new Date(Date.parse('2025-01-01T12:00Z') + k * 7 * DAY).toISOString();
    evs.push(hev('f' + k, 'Fit ' + k, d, Array.from({ length: 40 }, (_, i) => ({ id: 'g' + i, r: [0, 1, 2, 3].map((r) => 70 + ((k + r) % 3) + (i === 0 ? -2 : i === 1 ? 1 : ((i * 7 + r * 3 + k) % 5) - 2)) }))));
  }
  const tab = roundTable(evs);
  const f = fitSkills(tab, Date.parse('2026-01-01') / DAY, { half_life_days: 365, kappa: 4, nu0: Infinity, window_days: 1500 });
  const g0 = skillOf(f, 'g0'), g1 = skillOf(f, 'g1');
  /* shrinkage: each estimate is the player's mean times n_eff / (n_eff + kappa) (plus the round levels' share) */
  K.near('SYNTHETIC fit: a 3-stroke gap between two players is recovered, shrunk by n_eff / (n_eff + kappa)', g1.theta - g0.theta, 3 * g0.n_eff / (g0.n_eff + 4), 0.05);
  K.chk('SYNTHETIC fit: the better player is negative (strokes against an average round)', g0.theta < -1.5);
  K.eq('SYNTHETIC fit: an unseen player sits on the prior', skillOf(f, 'nobody').on_prior, true);
  const f2 = fitSkills(tab, Date.parse('2025-01-20') / DAY, { half_life_days: 365, kappa: 4, nu0: Infinity, window_days: 1500 });
  K.chk('SYNTHETIC fit: point-in-time (an as-of before most events reads only the rounds before it)', f2.rounds_used < f.rounds_used && f2.rounds_used === 3 * 4 * 40);
  K.chk('SYNTHETIC fit: few rounds are shrunk harder than many (posterior variance falls with rounds)', skillOf(f2, 'g0').var_post > g0.var_post && Math.abs(skillOf(f2, 'g0').theta) < Math.abs(g0.theta) + 0.5);
  const f3 = fitSkills(tab, Date.parse('2026-01-01') / DAY, { half_life_days: 365, kappa: 4, nu0: Infinity, window_days: 1500, prior_shift_new: 1.5 });
  K.near('SYNTHETIC fit: the newcomer prior shift moves an unseen player\'s mean by exactly that much', skillOf(f3, 'nobody').theta - skillOf(f, 'nobody').theta, 1.5, 1e-9);
}

/* ---------------------------------------------------------------- SYNTHETIC tournaments */
const pl = (id: string, theta: number, rounds: number[], extra: Partial<GolfPlayer> = {}): GolfPlayer => ({ id, name: 'Golfer ' + id, country: null, status: 'active', position: null, score: null, sort_order: null, thru: null, tee_time: null,
  rounds: rounds.map((s, i) => ({ r: i + 1, strokes: s, par: 70 })), partial: null, skill: { theta, var_post: 0.2, sd_round: 2.7, n_eff: 50, n_rounds: 80, on_prior: false }, ...extra });
function T(players: GolfPlayer[], o: Partial<GolfInputData> = {}): GolfInputData {
  const R = o.event ? o.event.n_rounds : 4;
  const levels = Array.from({ length: R }, (_, i) => { const r = i + 1, done = players.filter((p) => p.rounds.some((x) => x.r === r)); return { r, level: done.length ? 0 : null, state: (done.length ? 'complete' : 'future') as 'complete' | 'future', weight: done.length }; });
  return {
    sport: 'golf', tour: 'pga', tour_label: 'PGA Tour', competition: 'pga-synthetic', season: 2026, as_of: '2026-10-23T12:00:00Z',
    event: { id: 'synthetic', name: 'SYNTHETIC Classic', course: null, par: 70, start: '2026-10-22T12:00Z', end: null, status: 'STATUS_IN_PROGRESS', period: 1, n_rounds: 4, rounds_source: 'synthetic', rounds_provenance: 'Research' },
    players, cut: { mode: 'none', round: null, n: null, within: null, provenance: 'Research', source: 'synthetic: no cut', editions: [], interval: null, state: 'none' }, levels,
    course: { level_mean: 0, level_sd: 1, day_sd: 0.9, source: 'synthetic' },
    model: { model_version: 'synthetic', fit_tours: ['pga'], params: {}, as_of_day: 0, rounds_used: 5000, prior_mean: 1, prior_sd: 1.3, sigma_in_sample: 2.7, tournament: { c2: 0.7, W1: 0.35, W2: 0, sigma_eps: 2.7, sigma_eps_weekend: 2.7, scale: 1 }, study_sha256: 'x', history_sha256: 'x', history_fetched_at: 'x' },
    playoff: { mode: 'sudden_death', hole_level: 0, max_holes: 30, note: 'synthetic' }, code: {}, frequencies: { playoff_events: 0, events: 0, withdrawals_per_round: [] }, health: null, ...o
  };
}
const run = (d: GolfInputData, n: number, seed = 7n, scale?: number) => { const m = golfModule(d, { seed, scale }); const agg = runRange(m, { start: 0, end: n, traceRuns: [0] }); return { m, agg, res: summarise(m, agg) }; };
const P = (x: ReturnType<typeof run>, id: string, k: string) => { const e = x.res.find((r) => r.entity_id === id)!; return e.outcomes[k] ? e.outcomes[k].probability : NaN; };
{
  /* 30 players, nothing played: sum rules in every run */
  const field = Array.from({ length: 30 }, (_, i) => pl('s' + i, -1.5 + i * 0.1, []));
  const x = run(T(field), 4000);
  K.eq('SYNTHETIC: one winner and exactly 5 / 10 / 20 in the top 5 / 10 / 20 of every run (no violation, aggregate sums exact)', [x.agg.violations.length, checkAggregateSums(x.m, x.agg).length, x.m.sumRules.map((r) => r.outcome + ':' + r.perGroup).join()], [0, 0, 'win:1,top_5:5,top_10:10,top_20:20']);
  K.chk('SYNTHETIC: the best player wins most often, the worst least', P(x, 's0', 'win') > P(x, 's15', 'win') && P(x, 's15', 'win') > P(x, 's29', 'win'));
  K.eq('SYNTHETIC: no cut, no make-the-cut outcome', x.m.outcomes.map((o) => o.key), ['win', 'top_5', 'top_10', 'top_20']);
  const hist = x.res.map((e) => e.value_hist.reduce((a, b) => a + b, 0));
  K.chk('SYNTHETIC: every player\'s finishing histogram holds every run (places 1..30)', hist.every((h) => h === 4000) && x.res.every((e) => e.value_hist[30] === 0 && e.value_hist[31] === 0));
  K.chk('SYNTHETIC: rounds are whole strokes, so ties for the lead happen (playoffs counted)', (x.agg.diags.playoff || 0) > 100 && (x.agg.diags.playoff || 0) < 2000);
  /* worker-count independence through the real runner (worker threads) */
  const d = T(field), seed = 99n;
  const a = await runPlan({ sport: 'golf', data: d, seed, runs: 3000, workers: 1, traceRuns: [] });
  const b = await runPlan({ sport: 'golf', data: d, seed, runs: 3000, workers: 3, traceRuns: [] });
  K.chk('SYNTHETIC: 1 worker and 3 workers give identical counts and histograms', canonicalJson(a.agg.counts) === canonicalJson(b.agg.counts) && canonicalJson(a.agg.hist) === canonicalJson(b.agg.hist) && b.workers === 3);
  const c = run(T(field), 3000, 99n);
  K.chk('SYNTHETIC: deterministic for a seed, different for another', canonicalJson(c.agg.counts) === canonicalJson(a.agg.counts) && canonicalJson(run(T(field), 3000, 100n).agg.counts) !== canonicalJson(a.agg.counts));
}
{
  /* dead heat: every round played. A 130, B 131, C 132, then D..G tied at 133, the rest 140 */
  const rd = (t: number) => [Math.floor(t / 2), t - Math.floor(t / 2)];
  const ps = [pl('A', 0, rd(130)), pl('B', 0, rd(131)), pl('C', 0, rd(132)), ...['D', 'E', 'F', 'G'].map((id) => pl(id, 0, rd(133))), ...Array.from({ length: 23 }, (_, i) => pl('z' + i, 0, rd(140 + i)))];
  const d = T(ps, { event: { ...T([]).event, n_rounds: 2, period: 2, status: 'STATUS_PLAY_COMPLETE' } });
  d.levels = [{ r: 1, level: 0, state: 'complete', weight: 30 }, { r: 2, level: 0, state: 'complete', weight: 30 }];
  const x = run(d, 8000);
  K.eq('SYNTHETIC dead heat: the leader by a stroke wins every run, and the next three are always in the top 5', [P(x, 'A', 'win'), P(x, 'B', 'top_5'), P(x, 'C', 'top_5')], [1, 1, 1]);
  K.chk('SYNTHETIC dead heat: four tied for 4th share the last two top-5 places: each is in the top 5 in half the runs (dead-heat 2/4)', ['D', 'E', 'F', 'G'].every((id) => Math.abs(P(x, id, 'top_5') - 0.5) < 0.02));
  K.chk('SYNTHETIC dead heat: ... and each is in the top 10 every time (all four places inside it)', ['D', 'E', 'F', 'G'].every((id) => P(x, id, 'top_10') === 1));
  K.eq('SYNTHETIC dead heat: the per-run sum still holds exactly', checkAggregateSums(x.m, x.agg), []);
}
{
  /* the playoff: two tied for the lead after the last round */
  const rd = (t: number) => [Math.floor(t / 2), t - Math.floor(t / 2)];
  const mk = (ta: number, tb: number) => { const d = T([pl('A', ta, rd(130)), pl('B', tb, rd(130)), ...Array.from({ length: 20 }, (_, i) => pl('c' + i, 0, rd(135 + i)))], { event: { ...T([]).event, n_rounds: 2, period: 2 } }); d.levels = [{ r: 1, level: 0, state: 'complete', weight: 22 }, { r: 2, level: 0, state: 'complete', weight: 22 }]; return d; };
  const eq = run(mk(0, 0), 6000, 11n, 0);
  K.chk('SYNTHETIC playoff: equal players tied for the lead split the win near 50/50, and every run goes to a playoff', Math.abs(P(eq, 'A', 'win') - 0.5) < 0.025 && eq.agg.diags.playoff === 6000 && (eq.agg.diags.playoff_players_2 || 0) === 6000);
  const sk = run(mk(-3, 1), 6000, 11n, 0);
  K.chk('SYNTHETIC playoff: hole by hole, the better player (4 strokes a round) wins it more often, not always', P(sk, 'A', 'win') > 0.55 && P(sk, 'A', 'win') < 0.85);
  K.chk('SYNTHETIC playoff: a playoff lasts about two to four holes on average', eq.agg.diags.playoff_holes / 6000 > 1.5 && eq.agg.diags.playoff_holes / 6000 < 4.5);
  const holes = { n: 0 }, rs = streamFor(5n, 0, 5);
  K.chk('SYNTHETIC playoff: the winner is one of the tied players', ['x', 'y', 'z'].includes(['x', 'y', 'z'][playoffWinner([0, 1, 2], () => 0, () => 0.58, rs, 30, holes)]) && holes.n >= 1);
}
{
  /* conditioning: rounds played are kept; a 10-stroke lead with one round left wins; a round in progress counts its holes */
  const field = [pl('L', 0, [60, 60, 60]), ...Array.from({ length: 30 }, (_, i) => pl('o' + i, -1, [65, 65, 65]))];
  const x = run(T(field, { levels: [1, 2, 3, 4].map((r) => ({ r, level: r <= 3 ? 0 : null, state: (r <= 3 ? 'complete' : 'future') as 'complete' | 'future', weight: r <= 3 ? 31 : 0 })) }), 3000);
  K.chk('SYNTHETIC conditioning: fifteen strokes ahead of 30 players with one round left -> wins nearly every run', P(x, 'L', 'win') > 0.99);
  const part = [pl('M', 0, [65, 65], { partial: { r: 3, holes: 17, strokes: 61, par_played: 66 } }), ...Array.from({ length: 30 }, (_, i) => pl('o' + i, 0, [68, 68, 72]))];
  const d = T(part, { levels: [{ r: 1, level: 0, state: 'complete', weight: 31 }, { r: 2, level: 0, state: 'complete', weight: 31 }, { r: 3, level: 0, state: 'partial', weight: 30.9 }, { r: 4, level: null, state: 'future', weight: 0 }] });
  const y = run(d, 2000);
  const fin = (y.agg.traces[0].events.find((e: any) => e.ev === 'final') as any);
  K.chk('SYNTHETIC conditioning: a round in progress adds only the holes left to its strokes so far (the leader 17 ahead thru 17 of round 3 wins almost always)', P(y, 'M', 'win') > 0.97 && fin && typeof fin.total === 'number');
  /* the offsets' posterior: a player 4 under their skill in each of two rounds is expected better, with less spread */
  const p0 = pl('Q', 0, [66, 66]);
  const lv = [{ r: 1, level: 0, state: 'complete' as const, weight: 1 }, { r: 2, level: 0, state: 'complete' as const, weight: 1 }];
  const tv = { c2: 0.7, W1: 0.35, W2: 0, scale: 1 };
  const post = offsetPosterior(p0, lv, tv);
  const V = 0.7 * 0.2, W = 0.35, s2 = 2.7 * 2.7, S = 4 * V + 4 * W + 2 * s2;
  K.near('SYNTHETIC posterior: delta given two rounds 4 under = 2V/(4V+4W+2s^2) x (-8) (the exact Gaussian update)', post.mean[0], 2 * V / S * -8, 1e-9);
  K.near('SYNTHETIC posterior: its variance V - 4V^2/(4V+4W+2s^2)', post.cov[0][0], V - 4 * V * V / S, 1e-9);
  K.eq('SYNTHETIC posterior: with the offsets off (scale 0), no update at all', offsetPosterior(p0, lv, tv, 0).mean, [0, 0, 0]);
  K.eq('SYNTHETIC posterior: nothing played -> the prior', offsetPosterior(pl('R', 0, []), lv, tv).mean, [0, 0, 0]);
  const L = chol3([[4, 2, 0], [2, 3, 0], [0, 0, 0]]);
  K.chk('chol3: L L\' reproduces a PSD matrix, a zero variance leaves a zero column', Math.abs(L[0] * L[0] - 4) < 1e-12 && Math.abs(L[3] * L[0] - 2) < 1e-12 && Math.abs(L[3] * L[3] + L[4] * L[4] - 3) < 1e-12 && L[8] === 0);
}
{
  /* the cut: top 3 and ties after round 2, a field of 10 with every round 2 played (deterministic); four tied for 3rd all make it */
  const rd = (t: number) => [Math.floor(t / 2), t - Math.floor(t / 2)];
  const ps = [pl('a', 0, rd(130)), pl('b', 0, rd(131)), ...['c', 'd', 'e', 'f'].map((id) => pl(id, 0, rd(133))), ...['g', 'h', 'i', 'j'].map((id, k) => pl(id, 0, rd(135 + k)))];
  const cut = { mode: 'top_n' as const, round: 2, n: 3, within: null, provenance: 'Research' as const, source: 'synthetic: top 3 and ties', editions: [], interval: null, state: 'pending' as const };
  const d = T(ps, { cut });
  d.levels = [{ r: 1, level: 0, state: 'complete', weight: 10 }, { r: 2, level: 0, state: 'complete', weight: 10 }, { r: 3, level: null, state: 'future', weight: 0 }, { r: 4, level: null, state: 'future', weight: 0 }];
  const x = run(d, 2000);
  K.eq('SYNTHETIC cut: top 3 and ties keeps the six at 133 or better, every run', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'j'].map((id) => P(x, id, 'make_cut')), [1, 1, 1, 1, 1, 1, 0, 0]);
  K.chk('SYNTHETIC cut: a player who misses the cut never wins and lands in the missed-cut bin', P(x, 'g', 'win') === 0 && x.res.find((r) => r.entity_id === 'g')!.value_hist[10] === 2000);
  K.eq('SYNTHETIC cut: top 5 only (not 10 or 20): the cut guarantees 3 finishers... and the field is 10', x.m.outcomes.map((o) => o.key), ['win', 'make_cut']);
  const w = run(T(ps, { cut: { ...cut, within: 5 }, levels: d.levels }), 1000);
  K.eq('SYNTHETIC cut: with a 5-shot rule, everyone within 5 of the lead plays on too', ['g', 'h', 'i', 'j'].map((id) => P(w, id, 'make_cut')), [1, 0, 0, 0]);
  const est = run(T(ps, { cut: { ...cut, provenance: 'Estimated' }, levels: d.levels }), 200);
  K.eq('SYNTHETIC provenance: a cut rule the editions cannot narrow is labelled Estimated', est.m.outcomes.find((o) => o.key === 'make_cut')!.provenance, 'Estimated');
  const made = run(T(ps.map((p, i) => ({ ...p, status: i < 6 ? 'active' as const : 'cut' as const })), { cut: { ...cut, mode: 'observed', state: 'made', provenance: 'Observed' }, levels: d.levels }), 500);
  K.chk('SYNTHETIC provenance: once made, the cut is Observed (players cut: 0, the rest: all)', made.m.outcomes.find((o) => o.key === 'make_cut')!.provenance === 'Observed' && P(made, 'g', 'make_cut') === 0 && P(made, 'a', 'make_cut') === 1);
  const rp = run(T(ps, { event: { ...T([]).event, rounds_provenance: 'Estimated' } }), 100);
  K.eq('SYNTHETIC provenance: a round count assumed from the tour\'s format makes the finishes Estimated', rp.m.outcomes.find((o) => o.key === 'win')!.provenance, 'Estimated');
  /* withdrawals */
  const wdx = run(T([...Array.from({ length: 24 }, (_, i) => pl('k' + i, 0, [])), pl('W', -5, [], { status: 'wd' })]), 1000);
  K.chk('SYNTHETIC: a player who withdrew never wins and lands in the withdrawn bin', P(wdx, 'W', 'win') === 0 && wdx.res.find((r) => r.entity_id === 'W')!.value_hist[26] === 1000);
  K.throws('SYNTHETIC: an undetermined cut is never simulated', () => golfModule(T(ps, { cut: { ...cut, mode: 'undetermined', state: 'undetermined', provenance: null } }), { seed: 1n }), /undetermined/);
}
{
  /* finishSummary */
  const h = [10, 20, 30, 0, 0, 40, 0];  /* places 1..5, missed cut, withdrawn */
  const s = finishSummary(h, 100);
  K.eq('finishSummary: places, missed cut, the mean place of the tournaments finished, the median over all (MC below every place)', [s.places, s.missed_cut, s.mean_place_if_finished, s.median_place], [[10, 20, 30], 40, 2.33, 3]);
  K.eq('finishSummary: a player who misses the cut more often than not has a median of MC', finishSummary([5, 5, 0, 90, 0], 100).median_place, 'MC');
}
{
  /* the gates on a SYNTHETIC snapshot */
  const d = T(Array.from({ length: 20 }, (_, i) => pl('g' + i, 0, [70])));
  const snap: GolfSnapshot = { schema: 'edgedesk_sim_golf_input_v1', input_hash: hashCanonical(d), data: d, meta: { built_at: '', builder: '', source: null, feeds: [] } };
  const now = Date.parse('2026-10-23T13:00:00Z');
  const ok = validateGolfInputs(snap, now);
  K.chk('SYNTHETIC gates: a current, consistent event passes every input gate', ok.every((g) => g.status === 'PASS'), ok.filter((g) => g.status !== 'PASS'));
  const stale = validateGolfInputs(snap, now + 10 * 3600e3).find((g) => g.id === 'results.current')!;
  K.eq('SYNTHETIC gates: a leaderboard older than 6 hours blocks publication', [stale.status, stale.blocks], ['FAIL', 'publication']);
  const und = validateGolfInputs({ ...snap, data: { ...d, cut: { ...d.cut, mode: 'undetermined', state: 'undetermined' } } }, now).find((g) => g.id === 'cut.rule')!;
  K.eq('SYNTHETIC gates: an undetermined cut blocks simulation', [und.status, und.blocks], ['FAIL', 'simulation']);
  const fin = validateGolfInputs({ ...snap, data: { ...d, event: { ...d.event, status: 'STATUS_FINAL' } } }, now).find((g) => g.id === 'event.open')!;
  K.eq('SYNTHETIC gates: a finished event is never published', [fin.status, fin.blocks], ['FAIL', 'publication']);
  const prior = validateGolfInputs({ ...snap, data: { ...d, players: d.players.map((p, i) => ({ ...p, skill: { ...p.skill, on_prior: i < 10, n_rounds: i < 10 ? 0 : 80 } })) } }, now).find((g) => g.id === 'players.rated')!;
  K.chk('SYNTHETIC gates: half the field on the prior blocks publication, and the counts are stated', prior.status === 'FAIL' && /10 with no round/.test(prior.detail));
  const few = validateGolfInputs({ ...snap, data: { ...d, players: d.players.slice(0, 8) } }, now).find((g) => g.id === 'field.present')!;
  K.eq('SYNTHETIC gates: fewer than 10 players blocks simulation', few.status, 'FAIL');
}
{
  /* ESPN's leaderboard grammar: a SYNTHETIC competitor */
  const c = golfCompetitor({ id: '1', athlete: { id: '77', displayName: 'Synthetic Golfer', flag: { alt: 'USA' } }, sortOrder: 9, score: { displayValue: '-5' },
    status: { thru: 12, period: 2, teeTime: '2026-10-23T12:00Z', type: { name: 'STATUS_IN_PROGRESS' }, position: { displayName: 'T9' } },
    linescores: [{ period: 1, value: 66, displayValue: '-4', teeTime: '2026-10-22T12:00Z' }, { period: 2, value: 42, displayValue: '-1' }, { period: 5, value: 4, displayValue: 'E', isPlayoff: true }] });
  K.eq('ESPN grammar: id, name, country, position, thru, rounds with tee times and the playoff flag', [c.id, c.name, c.country, c.position, c.thru, c.rounds.length, c.rounds[0].tee_time, c.rounds[2].is_playoff, c.status], ['77', 'Synthetic Golfer', 'USA', 'T9', 12, 3, '2026-10-22T12:00Z', true, 'active']);
  K.eq('ESPN grammar: WD and CUT read from the status text', [golfCompetitor({ athlete: { id: '1', displayName: 'X' }, status: { type: { name: 'STATUS_CUT' }, displayValue: 'WD' } }).status, golfCompetitor({ athlete: { id: '2', displayName: 'Y' }, status: { type: { name: 'STATUS_CUT' }, displayValue: 'CUT' } }).status], ['wd', 'cut']);
}

{
  /* which event a tour simulates: SYNTHETIC feeds */
  const ev = (id: string, status: string, n: number, start = '2026-10-22T04:00Z') => ({ league: 'pga', id, name: 'E' + id, short_name: null, start, end: null, course: null, par: 70, status, period: 1, fetched_by: 'leaderboard', competitors: Array.from({ length: n }, (_, i) => golfCompetitor({ athlete: { id: String(i), displayName: 'P' + i } })), tournament: null, playoff_type: null, shape: null });
  const feed = (events: any[], upcoming: any[] = []) => ({ tour: 'pga' as Tour, events, upcoming, fetched_at: '', source: 'committed' as const, sha256: '' });
  K.eq('SYNTHETIC pick: the current event in play', pickEvent(feed([ev('1', 'STATUS_IN_PROGRESS', 120)]), 2026).event!.id, '1');
  const two = pickEvent(feed([ev('1', 'STATUS_IN_PROGRESS', 120), ev('2', 'STATUS_IN_PROGRESS', 132)]), 2026);
  K.chk('SYNTHETIC pick: a second event in play the same week is skipped and said so', two.event!.id === '1' && two.skipped.some((x) => /second event in play/.test(x)));
  const fin = pickEvent(feed([ev('1', 'STATUS_FINAL', 120)], [ev('3', 'STATUS_SCHEDULED', 132, '2026-10-29T04:00Z'), ev('4', 'STATUS_SCHEDULED', 0, '2026-11-05T04:00Z')]), 2026);
  K.chk('SYNTHETIC pick: after a finished event, the next one with its field listed (before round 1)', fin.event!.id === '3' && fin.skipped.some((x) => /finished/.test(x)));
  K.eq('SYNTHETIC pick: no field listed anywhere -> nothing, with the reasons', pickEvent(feed([ev('1', 'STATUS_FINAL', 120)], [ev('4', 'STATUS_SCHEDULED', 0)]), 2026).event, null);
  K.eq('SYNTHETIC pick: an event starting outside the configured season is not simulated', pickEvent(feed([ev('5', 'STATUS_SCHEDULED', 120, '2027-01-08T04:00Z')]), 2026).event, null);
}

/* ---------------------------------------------------------------- the committed data */
{
  const { snapshots, skipped } = await buildGolfSnapshots({ offline: true });
  const by = (t: string) => snapshots.find((s) => s.data.tour === t);
  K.chk('committed data: a snapshot per tour event in play, offline (or each skip with its reason)', snapshots.length + skipped.length === 3 && skipped.every((s) => s.reason.length > 0));
  const pga = by('pga');
  /* the committed feed is refreshed daily: the Bermuda Championship's cut is measured before round 2 ends and Observed after */
  if (pga && pga.data.event.name === 'Butterfield Bermuda Championship') {
    if (pga.data.cut.state === 'pending') {
      K.eq('committed data: the Bermuda Championship\'s cut is measured (top 65 and ties after round 2, the tour standard)', [pga.data.cut.state, pga.data.cut.n, pga.data.cut.round, pga.data.cut.provenance], ['pending', 65, 2, 'Research']);
      K.chk('committed data: round 2 in progress: holes played counted', pga.data.players.some((p) => p.partial && p.partial.r === 2));
    } else K.eq('committed data: the Bermuda Championship\'s cut, once made, is Observed', [pga.data.cut.state, pga.data.cut.provenance], ['made', 'Observed']);
  }
  const lpga = by('lpga');
  if (lpga && lpga.data.event.name === 'BMW Ladies Championship') K.eq('committed data: the BMW Ladies Championship has no cut (every edition)', lpga.data.cut.state, 'none');
  const eur = by('eur');
  if (eur && eur.data.event.name === 'Genesis Championship') K.eq('committed data: the Genesis Championship\'s cut is Observed', [eur.data.cut.state, eur.data.cut.provenance], ['made', 'Observed']);
  K.chk('committed data: every snapshot\'s rounds are known and its players rated or on the prior', snapshots.every((s) => s.data.event.n_rounds === 4 && s.data.players.every((p) => Number.isFinite(p.skill.theta))));
}
{
  const g = sportRegistry().find((s) => s.key === 'golf')!;
  K.eq('registry: golf is a tournament sport with Leaderboard, Finishes and Model Health', [g.structure, g.tabs.join()], ['events', 'leaderboard,finishes,model_health']);
  K.chk('registry: golf is ACTIVE only with no blocker, BLOCKED with each failed condition otherwise', (g.status === 'ACTIVE') === (g.blockers.length === 0));
  K.chk('the plan: golf is runnable and nightly through its window', RUNNABLE.golf === 2026 && NIGHTLY.includes('golf') && planRuns('schedule', {}, undefined, new Date('2026-11-09T10:17:00Z')).some((r) => r.sport === 'golf') && !planRuns('schedule', {}, undefined, new Date('2026-12-21T10:17:00Z')).some((r) => r.sport === 'golf'));
  K.eq('the plan: a golf dispatch', planRuns('workflow_dispatch', { sport: 'golf', season: '2026', runs: '100000', seed: '', publish: 'false' }).map((r) => [r.sport, r.season]), [['golf', '2026']]);
}
process.exit(K.done());
