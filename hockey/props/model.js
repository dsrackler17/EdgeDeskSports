'use strict';
/* ===========================================================================
   EdgeDesk NHL PROPS — point-in-time player rates and the outcome
   distributions of the common player markets. RESEARCH: no NHL prop price is
   captured, so nothing here is ever called value.

   STATE (absorbed one game date at a time, after that date's predictions):
     skater   time on ice (recent-weighted), and per-second rates of shots on
              goal, individual xG, goals, assists — each decayed by game and
              shrunk toward his position's league rate with a prior in seconds
     team     shots on goal for and against per game, goals for per game
     goalie   saves and shots against (save percentage, shrunk to the league's)

   DISTRIBUTIONS (one consistent joint model per skater):
     shots on goal  S ~ NegBin(mean μS, size r), μS = projected TOI × SOG rate ×
                    the opponent's shots-allowed factor
     goals          every goal is a shot on goal by its scorer, so G | S ~
                    Binomial(S, π) with π = μG / μS: goals inherit the shot
                    volume's overdispersion and P(goal and 3+ shots) is defined
     assists        A ~ Poisson(μA), μA = TOI × assist rate × the club's
                    scoring factor; independent of the player's own shots
     points         P = G + A (convolution)
     goalie saves   SA ~ NegBin(μSA, rSA) for the starter; saves | SA ~
                    Binomial(SA, sv)
   The sizes r, rSA are fitted by likelihood on the seasons before the one
   predicted (hockey/props/validate.js). Participation is assumed: a prop is
   void when the player does not dress, so it is priced and scored only for
   players who played.
   =========================================================================== */

const DEFAULTS = {
  decay_games: 60,           /* a player's rates: weight halves every 60 of his games */
  toi_half_life: 6,          /* projected TOI: weight halves every 6 games */
  prior_s: { sog: 18000, xg: 60000, g: 90000, a: 60000 },   /* shrinkage, seconds of league-average play */
  toi_prior_s: { F: 900, D: 1260 }, toi_prior_games: 2,
  team_prior_games: 10, team_decay_games: 40,
  goalie_prior_shots: 1500, goalie_decay_shots: 2500,
  xg_weight: 0.6,            /* goals rate: blend of individual xG rate and finished-goal rate */
  league_half_life_dates: 150, /* league reference levels follow the current scoring environment (≈ one season) */
};

function decayW(h) { return Math.pow(0.5, 1 / h); }

class PropState {
  constructor(p) {
    this.p = Object.assign({}, DEFAULTS, p || {});
    this.pl = new Map(); this.tm = new Map(); this.gk = new Map();
    this.lg = { F: { toi: 0, sog: 0, xg: 0, g: 0, a: 0, toiSum: 0, n: 0 }, D: { toi: 0, sog: 0, xg: 0, g: 0, a: 0, toiSum: 0, n: 0 }, team: { sog: 0, goals: 0, n: 0 }, sv: { sv: 0, sa: 0 } };
    this.kP = decayW(this.p.decay_games); this.kT = decayW(this.p.toi_half_life); this.kTeam = decayW(this.p.team_decay_games);
  }
  /* league position rates per second (cumulative, all games so far) */
  posRate(pos, k) { const L = this.lg[pos]; return L.toi > 0 ? L[k] / L.toi : null; }
  posToi(pos) { const L = this.lg[pos]; return L.n > 0 ? L.toiSum / L.n : this.p.toi_prior_s[pos]; }
  leagueTeam() { const L = this.lg.team; return L.n > 0 ? { sog: L.sog / L.n, goals: L.goals / L.n } : { sog: 30, goals: 3 }; }
  leagueSv() { const L = this.lg.sv; return L.sa > 0 ? L.sv / L.sa : 0.905; }

  rateOf(s, pos, k, priorKey) {
    const base = this.posRate(pos, k); if (base == null) return null;
    const ps = this.p.prior_s[priorKey || k];
    return ((s ? s[k] : 0) + base * ps) / ((s ? s.toi : 0) + ps);
  }
  teamFactor(abbr, kind) {
    const t = this.tm.get(abbr); const L = this.leagueTeam(); const k = this.p.team_prior_games;
    if (kind === 'sog_against') return ((t ? t.sa : 0) + L.sog * k) / ((t ? t.n : 0) + k) / L.sog;
    if (kind === 'sog_for') return ((t ? t.sf : 0) + L.sog * k) / ((t ? t.n : 0) + k) / L.sog;
    if (kind === 'goals_for') return ((t ? t.gf : 0) + L.goals * k) / ((t ? t.n : 0) + k) / L.goals;
    return 1;
  }
  /** a skater's projection for tonight (he dresses: props settle only then) */
  skater(pid, pos, opp, team) {
    const s = this.pl.get(pid); pos = pos === 'D' ? 'D' : 'F';
    const toi = s && s.tn > 0 ? (s.tw + this.posToi(pos) * this.p.toi_prior_games * 0.5) / (s.tn + this.p.toi_prior_games * 0.5) : this.posToi(pos);
    const sogR = this.rateOf(s, pos, 'sog'), xgR = this.rateOf(s, pos, 'xg'), gR = this.rateOf(s, pos, 'g'), aR = this.rateOf(s, pos, 'a');
    if (sogR == null) return null;
    const oppSog = this.teamFactor(opp, 'sog_against'), teamGoals = this.teamFactor(team, 'goals_for');
    const muS = toi * sogR * oppSog;
    const goalRate = this.p.xg_weight * xgR + (1 - this.p.xg_weight) * gR;
    const muG = toi * goalRate * oppSog;
    const muA = toi * aR * teamGoals;
    return { toi_s: toi, mu_sog: muS, mu_goals: muG, mu_assists: muA, games: s ? s.games : 0, opp_sog_factor: oppSog, team_goals_factor: teamGoals };
  }
  /** a goalie's projection as the starter */
  goalie(gid, team, opp) {
    const g = this.gk.get(gid); const L = this.leagueTeam(); const svL = this.leagueSv(); const k = this.p.goalie_prior_shots;
    const sv = ((g ? g.sv : 0) + svL * k) / ((g ? g.sa : 0) + k);
    const muSA = L.sog * this.teamFactor(opp, 'sog_for') * this.teamFactor(team, 'sog_against');
    return { mu_sa: muSA, sv, shots_seen: g ? g.sa : 0 };
  }

  /** absorb one date's completed rows (call after that date's predictions) */
  absorb(skaters, goalies, teams) {
    /* the league's reference levels decay by game date: a 2011 shot rate must not anchor a 2026 projection */
    const kL = Math.pow(0.5, 1 / this.p.league_half_life_dates);
    for (const pos of ['F', 'D']) for (const k of ['toi', 'sog', 'xg', 'g', 'a', 'toiSum', 'n']) this.lg[pos][k] *= kL;
    for (const k of ['sog', 'goals', 'n']) this.lg.team[k] *= kL;
    this.lg.sv.sv *= kL; this.lg.sv.sa *= kL;
    for (const r of skaters) {
      if (r.toi == null) continue;
      const pos = r.pos === 'D' ? 'D' : 'F';
      let s = this.pl.get(r.player); if (!s) { s = { toi: 0, sog: 0, xg: 0, g: 0, a: 0, tw: 0, tn: 0, games: 0 }; this.pl.set(r.player, s); }
      for (const k of ['toi', 'sog', 'xg', 'g', 'a']) s[k] *= this.kP;
      s.toi += r.toi; s.sog += r.sog || 0; s.xg += r.ixg == null ? (r.g || 0) : r.ixg; s.g += r.g || 0; s.a += r.a || 0;
      s.tw = s.tw * this.kT + r.toi; s.tn = s.tn * this.kT + 1; s.games++;
      const L = this.lg[pos]; L.toi += r.toi; L.sog += r.sog || 0; L.xg += r.ixg == null ? (r.g || 0) : r.ixg; L.g += r.g || 0; L.a += r.a || 0; L.toiSum += r.toi; L.n++;
    }
    for (const [, t] of Object.entries(teams)) {
      for (const side of ['home', 'away']) {
        const me = t[side], op = t[side === 'home' ? 'away' : 'home']; if (!me || !op || me.sog == null || op.sog == null) continue;
        let x = this.tm.get(me.team); if (!x) { x = { sf: 0, sa: 0, gf: 0, n: 0 }; this.tm.set(me.team, x); }
        x.sf = x.sf * this.kTeam + me.sog; x.sa = x.sa * this.kTeam + op.sog; x.gf = x.gf * this.kTeam + (me.goals || 0); x.n = x.n * this.kTeam + 1;
        this.lg.team.sog += me.sog; this.lg.team.goals += me.goals || 0; this.lg.team.n++;
      }
    }
    for (const r of goalies) {
      if (r.sa == null || r.sv == null) continue;
      let g = this.gk.get(r.goalie); if (!g) { g = { sv: 0, sa: 0 }; this.gk.set(r.goalie, g); }
      const k = Math.pow(0.5, (r.sa || 0) / this.p.goalie_decay_shots); g.sv = g.sv * k + r.sv; g.sa = g.sa * k + r.sa;
      this.lg.sv.sv += r.sv; this.lg.sv.sa += r.sa;
    }
  }
}

/* ---------- distributions ---------- */
function lgamma(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const v of c) s += v / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
/** NegBin pmf over 0..K (size r; r = Infinity → Poisson), the tail folded into K */
function nbPmf(mu, r, K) {
  const out = new Array(K + 1).fill(0); let acc = 0;
  for (let k = 0; k <= K; k++) {
    let lp;
    if (!isFinite(r)) lp = -mu + k * Math.log(Math.max(1e-300, mu)) - lgamma(k + 1);
    else lp = lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(r / (r + mu)) + k * Math.log(Math.max(1e-300, mu / (r + mu)));
    out[k] = Math.exp(lp); acc += out[k];
  }
  out[K] += Math.max(0, 1 - acc);
  return out;
}
function poisPmf(mu, K) { return nbPmf(mu, Infinity, K); }
function tailGE(pmf, k) { let s = 0; for (let i = Math.ceil(k); i < pmf.length; i++) s += pmf[i]; return Math.min(1, Math.max(0, s)); }

/** the skater's joint markets from his projection; r = SOG dispersion */
function skaterMarkets(pr, r) {
  const K = 20;
  const S = nbPmf(pr.mu_sog, r, K);
  const pi = pr.mu_sog > 0 ? Math.min(0.6, pr.mu_goals / pr.mu_sog) : 0;
  /* G | S ~ Bin(S, π): marginal goals pmf, and P(G ≥ 1, S ≥ 3) */
  const G = new Array(8).fill(0); let pG1S3 = 0;
  for (let s = 0; s <= K; s++) {
    if (!S[s]) continue;
    let pg = Math.pow(1 - pi, s);
    for (let g = 0; g <= Math.min(s, 7); g++) { G[g] += S[s] * pg; pg = pg * (s - g) / (g + 1) * (pi / Math.max(1e-12, 1 - pi)); }
    if (s >= 3) pG1S3 += S[s] * (1 - Math.pow(1 - pi, s));
  }
  const A = poisPmf(pr.mu_assists, 7);
  const P = new Array(10).fill(0); for (let g = 0; g < G.length; g++) for (let a = 0; a < A.length; a++) P[Math.min(9, g + a)] += G[g] * A[a];
  return {
    sog: { mean: pr.mu_sog, over: { 0.5: tailGE(S, 1), 1.5: tailGE(S, 2), 2.5: tailGE(S, 3), 3.5: tailGE(S, 4), 4.5: tailGE(S, 5) } },
    goals: { mean: pr.mu_goals, anytime: 1 - G[0], two_plus: 1 - G[0] - G[1] },
    assists: { mean: pr.mu_assists, over: { 0.5: 1 - A[0] } },
    points: { mean: pr.mu_goals + pr.mu_assists, over: { 0.5: 1 - P[0], 1.5: 1 - P[0] - P[1] } },
    joint: { goal_and_3plus_shots: pG1S3, note: 'goals are a thinning of the shots-on-goal distribution: the two are dependent by construction' },
    shot_pmf: S,
  };
}
/** the starter's saves distribution */
function goalieMarkets(pr, r) {
  const K = 70; const SA = nbPmf(pr.mu_sa, r, K);
  const sv = new Array(K + 1).fill(0);
  for (let n = 0; n <= K; n++) { if (SA[n] < 1e-12) continue; const B = binomPmf(n, pr.sv); for (let k = 0; k <= n; k++) sv[k] += SA[n] * B[k]; }
  const over = {}; for (const L of [20.5, 22.5, 23.5, 24.5, 25.5, 26.5, 27.5, 28.5, 29.5, 30.5, 31.5, 32.5]) over[L] = tailGE(sv, L + 0.5);
  let mean = 0; sv.forEach((p, k) => { mean += k * p; });
  return { saves: { mean, over }, shots_against: { mean: pr.mu_sa }, save_pct: pr.sv };
}
function binomPmf(n, p) { const out = new Array(n + 1).fill(0); let c = Math.pow(1 - p, n); out[0] = c; for (let k = 1; k <= n; k++) { c = c * (n - k + 1) / k * (p / (1 - p)); out[k] = c; } return out; }

/* ---------- mean recalibration: μ' = c·μ^b, fitted on earlier seasons ----------
   b > 1 stretches the projections apart (they were shrunk too hard), c sets
   the level. For a given b the Poisson maximum-likelihood c is Σy / Σμ^b, so
   only b is searched. One transform per statistic keeps every line of a
   player's distribution consistent (no line is patched on its own). */
function fitMeanCal(rows) {
  if (!rows || rows.length < 2000) return { b: 1, c: 1, n: rows ? rows.length : 0, basis: 'identity: fewer than 2000 earlier predictions' };
  let best = null; let sy = 0; for (const x of rows) sy += x.y;
  for (let b = 0.8; b <= 1.8001; b += 0.05) {
    let sm = 0; for (const x of rows) sm += Math.pow(Math.max(1e-9, x.mu), b);
    const c = sy / sm; let ll = 0;
    for (const x of rows) { const m = c * Math.pow(Math.max(1e-9, x.mu), b); ll += x.y * Math.log(m) - m; }
    if (!best || ll > best.ll) best = { b: +b.toFixed(2), c: +c.toFixed(5), ll };
  }
  return { b: best.b, c: best.c, n: rows.length, basis: 'Poisson maximum likelihood on the three seasons before' };
}
function applyMeanCal(mu, cal) { return !cal || (cal.b === 1 && cal.c === 1) ? mu : cal.c * Math.pow(Math.max(1e-9, mu), cal.b); }

module.exports = { PropState, DEFAULTS, nbPmf, poisPmf, tailGE, skaterMarkets, goalieMarkets, binomPmf, fitMeanCal, applyMeanCal };
