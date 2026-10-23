/* ===========================================================================
   THE UFC SIMULATION — one simulated run = every booked bout, then each
   division's title path to the horizon.

   1. BOOKED BOUTS, in the schedule's order. The winner is drawn with the
      served Elo's probability exactly (the published p_a: the marginal is
      kept, nothing is added to it). Then how it ends: a finish with
      P(finish | this winner) (finish.ts: the division's and format's rate,
      each fighter's shrunk tendency), else a decision; a finish's round from
      the measured distribution for the division and scheduled rounds. Every
      simulated fight has a winner (draws and no contests are not simulated;
      their measured rate is stated). A booked bout between a division's
      champion (ufc.com) and another fighter at that weight is a title fight:
      its winner leaves as champion.
   2. RANKINGS MOVE ONLY THROUGH BOOKED BOUTS (Estimated). A winner takes the
      loser's place in the division's contender order when the loser was
      ahead of him; a champion who loses goes to the front of the order,
      coming off a loss.
   3. TITLE FIGHTS NOT YET BOOKED (the schedule MEASURED, the matchmaking
      ESTIMATED). Each division's next title fight comes a gamma-distributed
      gap after its last one (mean: the division's measured gap; shape: the
      pooled fit), drawn conditionally so that it falls after the cards the
      schedule already lists; then gap after gap to the horizon. At each, the
      champion meets the first contender in order who is coming off a win
      and has rested at least the measured minimum; the winner is drawn from
      the served Elo on the ratings frozen at the as-of time, with the served
      layoff rule at the fight's date (a fighter idle 365 days or more loses
      25% of his distance from 1500, and keeps the loss). A simulated fight
      never moves a rating.
   Outcomes per fighter: the next booked bout won (by finish, by decision);
   a title shot, a title won and the title held at the horizon (Estimated:
   they pass through the matchmaking rule). Sum rules (after every run): one
   winner per booked bout; one champion per division at the horizon.
   =========================================================================== */
import type { SimModule, EntityDef, OutcomeDef, SumRule, RunMarks } from '../../core/engine.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import type { UfcInputData } from './inputs.ts';

const DAY = 86400000;
export const LAYOFF_DAYS = 365;

/* ------------------------------------------------------------ the gamma gaps */
/** ln Gamma(x), Lanczos (g = 7, n = 9) */
export function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** the regularized lower incomplete gamma P(a, x): series below a + 1, continued fraction above */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}
/** the gamma with mean 1 and shape k: its CDF, and its quantile from a table built once (linear between knots) */
export function gammaUnit(k: number, knots = 4096): { cdf: (x: number) => number; quantile: (u: number) => number } {
  const cdf = (x: number) => gammaP(k, k * x);
  const Q = new Float64Array(knots + 1);
  for (let i = 1; i <= knots; i++) {
    const u = i === knots ? 1 - 1e-9 : i / knots;
    let lo = Q[i - 1], hi = Math.max(lo * 2, 1) + 1;
    while (cdf(hi) < u) hi *= 2;
    for (let it = 0; it < 80; it++) { const mid = 0.5 * (lo + hi); if (cdf(mid) < u) lo = mid; else hi = mid; }
    Q[i] = 0.5 * (lo + hi);
  }
  const quantile = (u: number) => { const x = Math.min(knots, Math.max(0, u * knots)), i = Math.min(knots - 1, Math.floor(x)); return Q[i] + (Q[i + 1] - Q[i]) * (x - i); };
  return { cdf, quantile };
}

export const OUTCOMES: OutcomeDef[] = [
  { key: 'win_next_bout', label: 'Win the next booked bout', category: 'fights', provenance: 'Research' },
  { key: 'win_next_finish', label: 'Win it by a finish', category: 'fights', provenance: 'Research' },
  { key: 'win_next_decision', label: 'Win it on the scorecards', category: 'fights', provenance: 'Research' },
  { key: 'title_shot', label: 'Fight for the title within the horizon (a champion: defend it)', category: 'title_path', provenance: 'Estimated' },
  { key: 'win_title', label: 'Win the title within the horizon', category: 'title_path', provenance: 'Estimated' },
  { key: 'champion_at_horizon', label: 'Hold the title at the horizon', category: 'title_path', provenance: 'Estimated' }
];

export function ufcModule(d: UfcInputData, opt: { seed: bigint }): SimModule {
  const firstBout = new Map<string, string>();
  for (const b of d.bouts) for (const f of [b.a, b.b]) if (!firstBout.has(f)) firstBout.set(f, b.bout_id);
  const entities: EntityDef[] = d.fighters.map((f) => ({ id: f.id, name: f.name, groups: { division: f.division, bout: firstBout.get(f.id) || 'none' } }));
  const E = new Map(entities.map((e, i) => [e.id, i]));
  const O = new Map(OUTCOMES.map((o, i) => [o.key, i]));
  const oNext = O.get('win_next_bout')!, oFin = O.get('win_next_finish')!, oDec = O.get('win_next_decision')!;
  const oShot = O.get('title_shot')!, oWin = O.get('win_title')!, oHold = O.get('champion_at_horizon')!;
  const nE = entities.length;
  /* the fighters' state at the as-of time */
  const baseRating = new Float64Array(nE), baseLast = new Float64Array(nE), baseRes = new Uint8Array(nE), finW = new Float64Array(nE), finL = new Float64Array(nE);
  d.fighters.forEach((f, i) => {
    baseRating[i] = f.rating; baseLast[i] = f.last_fight ? Date.parse(f.last_fight) : NaN;
    baseRes[i] = f.last_result === 'W' ? 1 : f.last_result === 'L' ? 2 : f.last_result === 'D' ? 3 : 0;
    finW[i] = f.fin_win; finL[i] = f.fin_loss;
  });
  const logit = (p: number) => Math.log(p / (1 - p));
  /* booked bouts, in order */
  const B = d.bouts.map((b) => {
    const cum: number[] = []; let s = 0; for (const x of b.round_dist) { s += x; cum.push(s); }
    return { id: b.bout_id, t: Date.parse(b.start), a: E.get(b.a)!, b: E.get(b.b)!, p: b.p_a, fa: b.finish_if_a, fb: b.finish_if_b, cum,
      division: b.division, title: b.title ? { division: b.title.division } : null,
      next: { a: firstBout.get(b.a) === b.bout_id, b: firstBout.get(b.b) === b.bout_id },
      key: { a: 'b' + b.bout_id + '_a', fa: b.round_dist.map((_, k) => 'b' + b.bout_id + '_fa' + (k + 1)), fb: b.round_dist.map((_, k) => 'b' + b.bout_id + '_fb' + (k + 1)) } };
  });
  for (const b of B) if (!(b.p > 0 && b.p < 1) || b.a == null || b.b == null) throw new Error('booked bout ' + b.id + ' is not priced');
  /* divisions */
  const G = gammaUnit(d.gaps.shape);
  const horizonEnd = Date.parse(d.horizon.to + 'T00:00:00Z');
  const minRest = d.matchmaking.min_rest_days * DAY;
  const D = d.divisions.map((v) => {
    const cum: number[] = []; let s = 0; for (const x of v.round_dist_5) { s += x; cum.push(s); }
    const mu = v.mean_gap_days;
    const z0 = mu ? v.renewal.min_gap_days / mu : 0;
    return { key: v.key, champion: E.get(v.champion)!, contenders: v.contenders.map((x) => E.get(x)!), mu, start: Date.parse(v.renewal.start + 'T00:00:00Z'), z0, F0: mu ? G.cdf(z0) : 0,
      lf5: logit(v.finish_5), cum, k: { tf: 'tf_' + v.key, ch: 'tfch_' + v.key, un: 'tfu_' + v.key, none: 'tfnone_' + v.key, fin: 'tffin_' + v.key } };
  });
  const DI = new Map(D.map((x, i) => [x.key, i]));
  for (const x of D) if (x.champion == null) throw new Error('division ' + x.key + ' has no champion among the entities');
  /* per-run working state, reset at the start of every run */
  const rating = new Float64Array(nE), last = new Float64Array(nE), res = new Uint8Array(nE), wins = new Uint8Array(nE);
  const champ = new Int32Array(D.length);
  const order: number[][] = D.map(() => []);
  const regress = (i: number, t: number) => {
    const lt = last[i];
    if (lt === lt && Math.floor((t - lt) / DAY) >= LAYOFF_DAYS) rating[i] = 1500 + (rating[i] - 1500) * 0.75;
  };
  const pick = (cum: number[], u: number) => { for (let k = 0; k < cum.length; k++) if (u < cum[k]) return k; return cum.length - 1; };
  const moveAhead = (ord: number[], w: number, l: number) => {
    const pl = ord.indexOf(l); if (pl < 0) return;
    const pw = ord.indexOf(w);
    if (pw >= 0 && pw < pl) return;
    if (pw >= 0) ord.splice(pw, 1);
    ord.splice(ord.indexOf(l), 0, w);
  };

  function runOne(run: number, marks: RunMarks): void {
    const rg = streamFor(opt.seed, run, STREAM.games), rm = streamFor(opt.seed, run, STREAM.method);
    const rs = streamFor(opt.seed, run, STREAM.schedule), rt = streamFor(opt.seed, run, STREAM.postseason);
    rating.set(baseRating); last.set(baseLast); res.set(baseRes); wins.fill(0);
    D.forEach((x, j) => { champ[j] = x.champion; order[j] = x.contenders.slice(); });
    /* 1 the booked bouts */
    for (const b of B) {
      const aWins = rg.nextDouble() < b.p;
      const w = aWins ? b.a : b.b, l = aWins ? b.b : b.a;
      const fin = rm.nextDouble() < (aWins ? b.fa : b.fb);
      let round = 0;
      if (fin) { round = pick(b.cum, rm.nextDouble()) + 1; marks.diag(aWins ? b.key.fa[round - 1] : b.key.fb[round - 1]); }
      if (aWins) marks.diag(b.key.a);
      if (aWins ? b.next.a : b.next.b) { marks.mark(w, oNext); marks.mark(w, fin ? oFin : oDec); }
      regress(w, b.t); regress(l, b.t);
      last[w] = b.t; last[l] = b.t; res[w] = 1; res[l] = 2; wins[w]++;
      if (b.title) {
        const j = DI.get(b.title.division)!;
        const c = champ[j], ch = c === w ? l : w;
        marks.mark(c, oShot); marks.mark(ch, oShot);
        marks.diag(D[j].k.tf);
        if (w !== c) { marks.mark(w, oWin); champ[j] = w; marks.diag(D[j].k.ch); const ord = order[j]; const pw = ord.indexOf(w); if (pw >= 0) ord.splice(pw, 1); ord.unshift(c); }
      } else if (b.division != null && DI.has(b.division)) {
        moveAhead(order[DI.get(b.division)!], w, l);
      }
      if (marks.tracing) marks.trace({ ev: 'bout', id: b.id, winner: entities[w].id, finish: fin, round });
    }
    /* 2 each division's title fights not yet booked */
    for (let j = 0; j < D.length; j++) {
      const x = D[j];
      if (!x.mu) continue;
      let t = x.start + x.mu * G.quantile(x.F0 + (1 - x.F0) * rs.nextDouble()) * DAY;
      if (t < x.start + x.z0 * x.mu * DAY) t = x.start + x.z0 * x.mu * DAY;
      let unbooked = 0;
      while (t <= horizonEnd) {
        const c = champ[j];
        let ch = -1;
        for (const k of order[j]) if (k !== c && res[k] === 1 && last[k] === last[k] && t - last[k] >= minRest) { ch = k; break; }
        if (ch < 0) marks.diag(x.k.none);
        else {
          unbooked++;
          regress(c, t); regress(ch, t);
          const pCh = 1 / (1 + 10 ** (-(rating[ch] - rating[c]) / 400));
          const chWins = rt.nextDouble() < pCh;
          const w = chWins ? ch : c, l = chWins ? c : ch;
          const fin = rm.nextDouble() < 1 / (1 + Math.exp(-(x.lf5 + finW[w] + finL[l])));
          if (fin) { pick(x.cum, rm.nextDouble()); marks.diag(x.k.fin); }
          marks.mark(c, oShot); marks.mark(ch, oShot); marks.diag(x.k.tf);
          last[w] = t; last[l] = t; res[w] = 1; res[l] = 2; wins[w]++;
          if (chWins) { marks.mark(ch, oWin); champ[j] = ch; marks.diag(x.k.ch); const ord = order[j]; ord.splice(ord.indexOf(ch), 1); ord.unshift(c); }
          if (marks.tracing) marks.trace({ ev: 'title_fight', division: x.key, date: new Date(t).toISOString().slice(0, 10), champion: entities[c].id, challenger: entities[ch].id, p_challenger: Math.round(pCh * 1e4) / 1e4, winner: entities[w].id });
        }
        t += x.mu * G.quantile(rs.nextDouble()) * DAY;
      }
      if (unbooked) marks.diag(x.k.un);
    }
    /* 3 the horizon */
    for (let j = 0; j < D.length; j++) marks.mark(champ[j], oHold);
    for (let i = 0; i < nE; i++) marks.value(i, Math.min(4, wins[i]));
    if (marks.tracing) marks.trace({ ev: 'horizon', champions: Object.fromEntries(D.map((x, j) => [x.key, entities[champ[j]].id])) });
  }
  const sumRules: SumRule[] = [
    { outcome: 'win_next_bout', by: 'bout', perGroup: 1, skip: ['none'] },
    { outcome: 'champion_at_horizon', by: 'division', perGroup: 1, skip: ['Other'] }
  ];
  return { sport: 'ufc', competition: d.competition, season: String(d.season), entities, outcomes: OUTCOMES, sumRules, valueBins: 5,
    value: { key: 'wins', label: 'Fights won within the horizon', divisor: 1 }, runOne };
}
