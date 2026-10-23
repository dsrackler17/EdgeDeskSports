/* ===========================================================================
   THE GOLF TOURNAMENT SIMULATION — one simulated run = the rest of one
   tournament, round by round, to a winner.

   Everything already played is kept as played (Observed): completed rounds,
   the strokes of a round in progress, the cut once it is made, players who
   withdrew. The rest is simulated from the skill model (model.ts) and the
   variance study (simulator/data/golf_skill_study.json):

   A player's strokes in a round still to play
        round( par + l_r + theta_p + delta_p + omega_p,h + s_p Z )
   - l_r, the round's level (course, set-up, weather) relative to par for a
     0-skill player: SHARED by the whole field. Estimated from the field for
     a round complete or in progress; for a future round drawn once per run,
     l_r = course level + day effect. Shared, it moves everyone together:
     it changes the scores to par (the projected winning score), never who
     beats whom;
   - theta_p, the player's pre-event skill (point-in-time fit);
   - delta_p ~ N(0, c2 var_post_p): drawn ONCE per player per simulated
     tournament and kept in every round (what is wrong with their skill this
     week: the analog of the other sports' strength offset), and
     omega_p,h ~ N(0, W_h) for each half (rounds 1-2, rounds 3-4): what two
     rounds of the same half share beyond it (the tee-time draw). Both are
     conditioned on this event's completed rounds and the holes already
     played (Bayes, offsetPosterior): a player 6 under after two rounds is
     expected to be somewhat better than their pre-event skill, by exactly as
     much as the measured variances say;
   - s_p Z, round noise (s_p: the player's own sd, shrunk to the tour's,
     scaled on rounds 3-4 to the weekend's measured noise: those who make
     the cut are steadier than the field);
   - rounded to whole strokes, so ties happen as they do on a leaderboard.
   A round in progress: the remaining holes' par plus the same terms scaled
   by the share of the round left (sd by its square root).

   THE CUT (rules.ts eventRule, never assumed): after the cut round, the
   top N and ties (and anyone within X strokes of the lead where the event's
   history shows the 10-shot rule) play on. A cut already made is Observed.
   A withdrawal after the as-of time is not simulated.

   THE FINISH. The lowest total wins; a tie for the lead goes to a playoff
   (playoffWinner: sudden death, hole by hole, each hole's score a rounded
   normal around the player's per-hole skill, Estimated: the feed has no
   hole-by-hole history). Places 2.. are ordered by total with ties broken
   at random, so top 5 / top 10 / top 20 hold exactly 5 / 10 / 20 players in
   every run: a player tied for 9th with three others is in the top 10 in
   half of the runs where that happens, which is exactly a dead-heat
   settlement's expected value (two spots for four players pays half).

   Outcomes per player: win (sum rule: one per run), top_5, top_10, top_20
   (sum rules: k per run, when at least k players are certain to finish),
   make_cut (no sum rule: ties at the line), and the finishing position
   (value histogram: places 1..F, then missed cut, then withdrawn).
   =========================================================================== */
import type { SimModule, EntityDef, OutcomeDef, SumRule, RunMarks } from '../../core/engine.ts';
import { streamFor, STREAM, type Xoshiro128 } from '../../core/prng.ts';
import { normalQuantile } from '../../core/normal.ts';
import type { GolfInputData, GolfPlayer, RoundLevel } from './types.ts';

export const TOP_K = [5, 10, 20];

/* ------------------------------------------------------------ small linear algebra */
/** solve S X = B for symmetric positive definite S (m x m) and B (m x c), by Gaussian elimination with pivoting */
function solve(S: number[][], B: number[][]): number[][] {
  const m = S.length, c = B[0].length;
  const M = S.map((row, i) => row.concat(B[i]));
  for (let k = 0; k < m; k++) {
    let piv = k; for (let i = k + 1; i < m; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    [M[k], M[piv]] = [M[piv], M[k]];
    const d = M[k][k]; if (Math.abs(d) < 1e-14) throw new Error('offsetPosterior: singular system');
    for (let j = k; j < m + c; j++) M[k][j] /= d;
    for (let i = 0; i < m; i++) if (i !== k) { const f = M[i][k]; if (f) for (let j = k; j < m + c; j++) M[i][j] -= f * M[k][j]; }
  }
  return M.map((row) => row.slice(m));
}
/** lower Cholesky factor of a 3x3 symmetric positive semi-definite matrix (a zero pivot leaves its column zero) */
export function chol3(S: number[][]): number[] {
  const L = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) {
    let s = S[i][j];
    for (let k = 0; k < j; k++) s -= L[i * 3 + k] * L[j * 3 + k];
    if (i === j) L[i * 3 + i] = s > 1e-12 ? Math.sqrt(s) : 0;
    else L[i * 3 + j] = L[j * 3 + j] > 0 ? s / L[j * 3 + j] : 0;
  }
  return L;
}

export interface TournamentVariance { c2: number; W1: number; W2: number; scale: number; sigma_eps?: number; sigma_eps_weekend?: number }
/** the weekend's round noise relative to the first two rounds' (those who make the cut are steadier) */
export const weekendRatio = (tv: TournamentVariance) => (tv.sigma_eps && tv.sigma_eps_weekend ? tv.sigma_eps_weekend / tv.sigma_eps : 1);
/** the posterior of (delta, omega1, omega2) given the event's completed rounds and holes played:
    each observation o = f (delta + omega_half) + e, e ~ N(0, f s^2), with f the share of a round it covers */
export function offsetPosterior(p: GolfPlayer, levels: RoundLevel[], tv: TournamentVariance, scale?: number): { mean: number[]; cov: number[][]; chol: number[]; obs: number } {
  const k = scale != null ? scale : tv.scale;
  const P = [k * tv.c2 * p.skill.var_post, k * tv.W1, k * tv.W2];
  const A: number[][] = [], o: number[] = [], R: number[] = [];
  const s2 = p.skill.sd_round * p.skill.sd_round, wk = weekendRatio(tv) ** 2;
  const lv = (r: number) => { const x = levels.find((l) => l.r === r); return x && x.level != null ? x.level : null; };
  for (const rd of p.rounds) { const l = lv(rd.r); if (l == null) continue; A.push([1, rd.r <= 2 ? 1 : 0, rd.r >= 3 ? 1 : 0]); o.push(rd.strokes - rd.par - l - p.skill.theta); R.push(rd.r >= 3 ? s2 * wk : s2); }
  if (p.partial && p.partial.holes > 0) {
    const l = lv(p.partial.r), f = p.partial.holes / 18;
    if (l != null) { A.push([f, p.partial.r <= 2 ? f : 0, p.partial.r >= 3 ? f : 0]); o.push(p.partial.strokes - p.partial.par_played - (l + p.skill.theta) * f); R.push(f * s2 * (p.partial.r >= 3 ? wk : 1)); }
  }
  const Pm = [[P[0], 0, 0], [0, P[1], 0], [0, 0, P[2]]];
  if (!A.length || P.every((x) => x === 0)) return { mean: [0, 0, 0], cov: Pm, chol: chol3(Pm), obs: A.length };
  /* K = P A' S^-1, S = A P A' + R; mean = K o; cov = P - K A P */
  const m = A.length;
  const AP = A.map((a) => [a[0] * P[0], a[1] * P[1], a[2] * P[2]]);
  const S = A.map((a, i) => A.map((b, j) => a[0] * b[0] * P[0] + a[1] * b[1] * P[1] + a[2] * b[2] * P[2] + (i === j ? R[i] : 0)));
  const X = solve(S, AP);                       /* X = S^-1 A P (m x 3); K = X' */
  const mean = [0, 1, 2].map((c) => X.reduce((s, row, i) => s + row[c] * o[i], 0));
  const cov = [0, 1, 2].map((r) => [0, 1, 2].map((c) => Pm[r][c] - X.reduce((s, row, i) => s + row[r] * AP[i][c], 0)));
  for (let r = 0; r < 3; r++) for (let c = 0; c < r; c++) { const v = (cov[r][c] + cov[c][r]) / 2; cov[r][c] = cov[c][r] = v; }
  return { mean, cov, chol: chol3(cov), obs: m };
}

/** a standard normal from one uniform (the simulator's one normal: AS241) */
const nz = (rs: Xoshiro128) => normalQuantile(rs.nextOpen());

/** sudden death between tied players: each hole, every player's score is a rounded normal around their per-hole skill
    (round level shared); the unique low score wins; after max_holes, an equal draw (never reached in practice) */
export function playoffWinner(ids: number[], perHole: (i: number) => number, sdHole: (i: number) => number, rs: Xoshiro128, maxHoles: number, holes?: { n: number }): number {
  let alive = ids.slice();
  for (let h = 0; h < maxHoles && alive.length > 1; h++) {
    const sc = alive.map((i) => Math.round(perHole(i) + sdHole(i) * nz(rs)));
    const lo = Math.min(...sc);
    alive = alive.filter((_, j) => sc[j] === lo);
    if (holes) holes.n++;
  }
  return alive.length === 1 ? alive[0] : alive[rs.nextInt(alive.length)];
}

export interface ModuleOptions { seed: bigint; scale?: number }

export function golfModule(d: GolfInputData, opt: ModuleOptions): SimModule {
  const F = d.players.length, R = d.event.n_rounds, par = d.event.par;
  const entities: EntityDef[] = d.players.map((p) => ({ id: p.id, name: p.name, groups: { tour: d.tour_label } }));
  const active = d.players.map((p, i) => (p.status === 'active' ? i : -1)).filter((i) => i >= 0);
  const cutPending = d.cut.state === 'pending', cutMade = d.cut.state === 'made';
  if (d.cut.state === 'undetermined') throw new Error('the cut rule is undetermined: nothing can be simulated (' + d.cut.source + ')');
  if (cutPending && (d.cut.round == null || d.cut.n == null)) throw new Error('a pending cut needs its round and N');
  const C = cutPending ? (d.cut.round as number) : 0;
  /* players certain to finish: the cut keeps at least min(N, starters) (ties only add), no withdrawal is simulated */
  const certain = cutPending ? Math.min(d.cut.n as number, active.length) : active.length;
  const tops = TOP_K.filter((k) => k < active.length && k <= certain);
  /* a round count assumed from the tour's usual format (an event history has never seen) makes every finish Estimated */
  const fin = d.event.rounds_provenance === 'Estimated' ? 'Estimated' : 'Research';
  const outcomes: OutcomeDef[] = [{ key: 'win', label: 'Win the tournament', category: 'title', provenance: fin }];
  for (const k of tops) outcomes.push({ key: 'top_' + k, label: 'Finish in the top ' + k + ' (ties broken at random: the dead-heat expectation)', category: 'finish', provenance: fin });
  const hasCut = d.cut.state !== 'none';
  if (hasCut) outcomes.push({ key: 'make_cut', label: 'Make the cut', category: 'cut', provenance: cutMade ? 'Observed' : (d.cut.provenance === 'Estimated' ? 'Estimated' : 'Research') });
  const O = new Map(outcomes.map((o, i) => [o.key, i]));
  const sumRules: SumRule[] = [{ outcome: 'win', by: 'league', perGroup: 1 }].concat(tops.map((k) => ({ outcome: 'top_' + k, by: 'league', perGroup: k })));
  if (!active.length) throw new Error('nobody is left to play');

  /* per active player, once: the offsets' posterior, the round noise, what is already played */
  const tv: TournamentVariance = d.model.tournament;
  const post = active.map((i) => offsetPosterior(d.players[i], d.levels, tv, opt.scale));
  const theta = active.map((i) => d.players[i].skill.theta), sd = active.map((i) => d.players[i].skill.sd_round);
  const wkr = weekendRatio(tv), sdWk = sd.map((x) => x * wkr);
  const done = active.map((i) => { const m = new Map<number, number>(); for (const r of d.players[i].rounds) m.set(r.r, r.strokes); return m; });
  const partial = active.map((i) => d.players[i].partial);
  const level = new Map(d.levels.filter((l) => l.level != null).map((l) => [l.r, l.level as number]));
  const anyLevel = level.size > 0;
  const hole = d.playoff;
  const nA = active.length;
  const off = new Float64Array(nA * 3), tot = new Float64Array(nA), alive = new Uint8Array(nA), made = new Uint8Array(nA), key = new Float64Array(nA);
  const out = new Set(d.players.map((p, i) => (p.status === 'wd' || p.status === 'dq' ? i : -1)).filter((i) => i >= 0));
  const missedObserved = new Set(d.players.map((p, i) => (p.status === 'cut' || p.status === 'mdf' ? i : -1)).filter((i) => i >= 0));

  function runOne(run: number, marks: RunMarks): void {
    const rs = streamFor(opt.seed, run, STREAM.strength), rg = streamFor(opt.seed, run, STREAM.games), rc = streamFor(opt.seed, run, STREAM.coin);
    /* 1 offsets, once per player per tournament */
    for (let a = 0; a < nA; a++) {
      const z0 = nz(rs), z1 = nz(rs), z2 = nz(rs), L = post[a].chol, m = post[a].mean;
      off[a * 3] = m[0] + L[0] * z0; off[a * 3 + 1] = m[1] + L[3] * z0 + L[4] * z1; off[a * 3 + 2] = m[2] + L[6] * z0 + L[7] * z1 + L[8] * z2;
      alive[a] = 1; made[a] = cutMade ? 1 : 0; tot[a] = 0;
      for (const v of done[a].values()) tot[a] += v;
    }
    /* 2 the course level of future rounds (shared): drawn once per run when no round of the event has been played */
    const course = d.course.level_mean + (anyLevel ? 0 : d.course.level_sd * nz(rg));
    let cutLine: number | null = null, nMade = 0;
    for (let r = 1; r <= R; r++) {
      /* the cut, after its round */
      if (cutPending && r === C + 1) {
        const ts: number[] = []; for (let a = 0; a < nA; a++) if (alive[a]) ts.push(tot[a]);
        ts.sort((x, y) => x - y);
        const n = d.cut.n as number, lead = ts[0];
        const nth = ts[Math.min(n, ts.length) - 1];
        const lim = d.cut.within != null ? Math.max(nth, lead + d.cut.within) : nth;
        for (let a = 0; a < nA; a++) if (alive[a]) { if (tot[a] <= lim) { made[a] = 1; nMade++; } else alive[a] = 0; }
        cutLine = lim;
        marks.diag('cut_line_' + (lim - par * C));
        if (marks.tracing) marks.trace({ ev: 'cut', after_round: C, line_to_par: lim - par * C, made: nMade });
      }
      const known = level.get(r);
      const lr = known != null ? known : course + d.course.day_sd * nz(rg);
      const h = r <= 2 ? 1 : 2, sr = h === 1 ? sd : sdWk;
      for (let a = 0; a < nA; a++) {
        if (!alive[a] || done[a].has(r)) continue;
        const mu = theta[a] + off[a * 3] + off[a * 3 + h];
        const pt = partial[a];
        if (pt && pt.r === r && pt.holes > 0) {
          const f = (18 - pt.holes) / 18;
          tot[a] += pt.strokes + Math.round((par - pt.par_played) + (lr + mu) * f + sr[a] * Math.sqrt(f) * nz(rg));
        } else tot[a] += Math.round(par + lr + mu + sr[a] * nz(rg));
      }
    }
    if (!cutPending && !cutMade) for (let a = 0; a < nA; a++) made[a] = 1;
    /* 3 the winner: lowest total, a playoff on a tie */
    let best = Infinity; for (let a = 0; a < nA; a++) if (alive[a] && tot[a] < best) best = tot[a];
    const lead: number[] = []; for (let a = 0; a < nA; a++) if (alive[a] && tot[a] === best) lead.push(a);
    let winner = lead[0];
    if (lead.length > 1) {
      const ro = streamFor(opt.seed, run, STREAM.overtime), holes = { n: 0 };
      winner = playoffWinner(lead, (a) => hole.hole_level + (theta[a] + off[a * 3] + off[a * 3 + 2]) / 18, (a) => Math.sqrt(Math.max(0.05, sdWk[a] * sdWk[a] / 18 - 1 / 12)), ro, hole.max_holes, holes);
      marks.diag('playoff'); marks.diag('playoff_players_' + lead.length); marks.diag('playoff_holes', holes.n);
      if (marks.tracing) marks.trace({ ev: 'playoff', players: lead.map((a) => d.players[active[a]].id), holes: holes.n, winner: d.players[active[winner]].id });
    }
    marks.diag('win_to_par_' + (best - par * R));
    /* 4 places: by total, ties broken at random (the winner first) */
    const order: number[] = [];
    for (let a = 0; a < nA; a++) if (alive[a]) { order.push(a); key[a] = a === winner ? -1 : rc.nextDouble(); }
    order.sort((x, y) => tot[x] - tot[y] || key[x] - key[y]);
    const pos = new Int32Array(nA).fill(-1);
    order.forEach((a, i) => { pos[a] = i; });
    const oWin = O.get('win')!, oCut = O.get('make_cut');
    marks.mark(active[winner], oWin);
    for (const k of tops) { const ok = O.get('top_' + k)!; for (let i = 0; i < k && i < order.length; i++) marks.mark(active[order[i]], ok); }
    if (oCut != null) for (let a = 0; a < nA; a++) if (made[a]) marks.mark(active[a], oCut);
    /* 5 the finishing position histogram: places 1..F (bins 0..F-1), missed cut (F), withdrawn (F+1) */
    for (let a = 0; a < nA; a++) marks.value(active[a], pos[a] >= 0 ? pos[a] : F);
    for (const i of missedObserved) marks.value(i, F);
    for (const i of out) marks.value(i, F + 1);
    if (marks.tracing) marks.trace({ ev: 'final', winner: d.players[active[winner]].id, total: best, to_par: best - par * R, leaders: lead.length, cut_line: cutLine == null ? null : cutLine - par * C,
      top5: order.slice(0, 5).map((a) => d.players[active[a]].id + ' ' + (tot[a] - par * R)) });
  }
  return { sport: 'golf', competition: d.competition, season: String(d.season), entities, outcomes, sumRules, valueBins: F + 2,
    value: { key: 'finish_bin', label: 'Finishing place bin (0 = 1st; F = missed cut; F+1 = withdrawn)', divisor: 1 }, runOne };
}
