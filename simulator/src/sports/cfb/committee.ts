/* ===========================================================================
   THE CFP COMMITTEE PROXY — an explicit research model, never a fact.

   The committee ranks teams by judgement ("strength of schedule, head-to-
   head competition, comparative outcomes of common opponents ... other
   relevant factors", CFP protocol). Nothing here reproduces that judgement.
   What it does is model, from history, how the committee's FINAL ranking has
   related to things the simulation can compute the same way for a simulated
   season, and how much it has varied around that relationship:

     resume(t)   wins, losses, undefeated, power-conference membership (or
                 Notre Dame), power / other conference champion, the team's
                 frozen as-of rating (what was known about its quality at the
                 as-of week), the mean frozen rating of its opponents, and its
                 wins over opponents rated 5.0 or better — all over the games
                 played before Selection Day (the committee does not consider
                 later ones)
     score       s_t = beta . standardized resume(t)
     ranking     Plackett-Luce: the committee's order is drawn as the order of
                 s_t + Gumbel noise, which is exactly a Plackett-Luce draw. The
                 noise is the committee's own unpredictability around the
                 resume, fitted on 2014-2025; beta is drawn per run from a
                 season bootstrap, so parameter uncertainty is in it too.

   Fitted, validated chronologically and registered by
   simulator/src/research/cfb_committee.ts (simulator/data/cfb_committee_proxy.json).
   Every output that passes through it is labelled Estimated. It never sees
   a simulated record as a ranking: two teams with the same record are
   ranked by their resumes plus noise, and the noise reorders them across runs.
   =========================================================================== */

export const RESUME_FEATURES = ['losses', 'wins', 'undefeated', 'power', 'champ_power', 'champ_other', 'rating', 'sos', 'quality_wins'] as const;
export type ResumeFeature = typeof RESUME_FEATURES[number];
export const QUALITY_RATING = 5.0;

export interface ResumeInput {
  T: number;
  rating: ArrayLike<number>;          // frozen as-of rating per team
  fcsRating: number;                  // the engine's single FCS floor rating
  power: ArrayLike<number>;           // 1 = power conference member or Notre Dame
  champion: ArrayLike<number>;        // 1 = conference champion
  /** games played before Selection Day: home, away (-1 = non-FBS), home margin */
  games: Array<{ h: number; a: number; m: number }>;
}
export type Resume = Record<ResumeFeature, number>;

export function resumes(x: ResumeInput): Resume[] {
  const w = new Float64Array(x.T), l = new Float64Array(x.T), opp = new Float64Array(x.T), n = new Float64Array(x.T), q = new Float64Array(x.T);
  for (const g of x.games) {
    const rh = g.h >= 0 ? x.rating[g.h] : x.fcsRating, ra = g.a >= 0 ? x.rating[g.a] : x.fcsRating;
    if (g.h >= 0) { n[g.h]++; opp[g.h] += ra; if (g.m > 0) { w[g.h]++; if (ra >= QUALITY_RATING) q[g.h]++; } else l[g.h]++; }
    if (g.a >= 0) { n[g.a]++; opp[g.a] += rh; if (g.m < 0) { w[g.a]++; if (rh >= QUALITY_RATING) q[g.a]++; } else l[g.a]++; }
  }
  const out: Resume[] = [];
  for (let t = 0; t < x.T; t++) {
    const p = x.power[t] ? 1 : 0, c = x.champion[t] ? 1 : 0;
    out.push({ losses: l[t], wins: w[t], undefeated: l[t] === 0 && w[t] > 0 ? 1 : 0, power: p, champ_power: c && p ? 1 : 0, champ_other: c && !p ? 1 : 0,
      rating: x.rating[t], sos: n[t] ? opp[t] / n[t] : x.fcsRating, quality_wins: q[t] });
  }
  return out;
}

export interface ProxyFit { spec: ResumeFeature[]; mean: number[]; sd: number[]; beta: number[] }
export function design(r: Resume, fit: { spec: ResumeFeature[]; mean: number[]; sd: number[] }): number[] {
  return fit.spec.map((f, i) => (r[f] - fit.mean[i]) / (fit.sd[i] || 1));
}
export function scores(rs: Resume[], fit: ProxyFit, beta: number[] = fit.beta): Float64Array {
  const s = new Float64Array(rs.length);
  rs.forEach((r, t) => { const x = design(r, fit); let v = 0; for (let i = 0; i < x.length; i++) v += beta[i] * x[i]; s[t] = v; });
  return s;
}
/** a Plackett-Luce draw of the full order: sort by score + standard Gumbel noise (best first) */
export function noisyOrder(s: ArrayLike<number>, eligible: (t: number) => boolean, u: () => number): number[] {
  const idx: number[] = [], key: number[] = [];
  for (let t = 0; t < s.length; t++) {
    if (!eligible(t)) continue;
    idx.push(t); key.push(s[t] - Math.log(-Math.log(u())));
  }
  const ord = idx.map((_, i) => i).sort((a, b) => key[b] - key[a] || idx[a] - idx[b]);
  return ord.map((i) => idx[i]);
}

/** Plackett-Luce log-likelihood of an observed top-K order (best first) over all teams, and its gradient / Hessian */
export function plLogLik(X: number[][], order: number[], beta: number[], want: 'll' | 'all' = 'all'): { ll: number; g: number[]; H: number[][] } {
  const p = beta.length, T = X.length;
  const s = X.map((x) => x.reduce((a, v, i) => a + v * beta[i], 0));
  const alive = new Uint8Array(T).fill(1);
  let ll = 0;
  const g = new Array(p).fill(0), H = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const c of order) {
    let mx = -Infinity; for (let t = 0; t < T; t++) if (alive[t] && s[t] > mx) mx = s[t];
    let z = 0; for (let t = 0; t < T; t++) if (alive[t]) z += Math.exp(s[t] - mx);
    ll += s[c] - mx - Math.log(z);
    if (want === 'all') {
      const ex = new Array(p).fill(0), exx = Array.from({ length: p }, () => new Array(p).fill(0));
      for (let t = 0; t < T; t++) if (alive[t]) {
        const w = Math.exp(s[t] - mx) / z;
        for (let i = 0; i < p; i++) { ex[i] += w * X[t][i]; for (let j = 0; j <= i; j++) exx[i][j] += w * X[t][i] * X[t][j]; }
      }
      for (let i = 0; i < p; i++) { g[i] += X[c][i] - ex[i]; for (let j = 0; j <= i; j++) { const v = exx[i][j] - ex[i] * ex[j]; H[i][j] -= v; if (i !== j) H[j][i] -= v; } }
    }
    alive[c] = 0;
  }
  return { ll, g, H };
}

/** Newton's method on the summed Plackett-Luce likelihood with a small ridge (lambda) */
export function fitPL(seasons: Array<{ X: number[][]; order: number[] }>, p: number, lambda = 1e-3): { beta: number[]; ll: number; iterations: number } {
  let beta = new Array(p).fill(0), ll = -Infinity, it = 0;
  for (; it < 100; it++) {
    const g = new Array(p).fill(0), H = Array.from({ length: p }, () => new Array(p).fill(0));
    let cur = 0;
    for (const s of seasons) { const r = plLogLik(s.X, s.order, beta); cur += r.ll; for (let i = 0; i < p; i++) { g[i] += r.g[i]; for (let j = 0; j < p; j++) H[i][j] += r.H[i][j]; } }
    for (let i = 0; i < p; i++) { cur -= 0; g[i] -= lambda * beta[i]; H[i][i] -= lambda; }
    const step = solve(H.map((r) => r.map((v) => -v)), g);
    let t = 1, next = beta.map((b, i) => b + t * step[i]);
    const val = (b: number[]) => seasons.reduce((a, s) => a + plLogLik(s.X, s.order, b, 'll').ll, 0) - 0.5 * lambda * b.reduce((a, v) => a + v * v, 0);
    const base = val(beta);
    while (val(next) < base && t > 1e-6) { t /= 2; next = beta.map((b, i) => b + t * step[i]); }
    const delta = Math.max(...next.map((v, i) => Math.abs(v - beta[i])));
    beta = next; ll = val(beta);
    if (delta < 1e-9) break;
  }
  return { beta, ll, iterations: it };
}
function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new Error('singular system in the Plackett-Luce fit');
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
