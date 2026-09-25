/* ============================================================================
   THE FCS BRIDGE — FCS teams rated on EdgeDesk's own FBS scale, through the
   games that actually cross the division line.

   WHY A BRIDGE. The engine prices every FCS opponent from one number
   (params.rating.hyperparams.fcs_rating, -28): North Dakota State and a
   first-year FCS programme are the same team to it. Rating the FCS field on
   its own and pasting it onto the FBS scale would be worse: two independently
   normalized leagues are not on one scale because both have a mean of zero.

   THE MODEL. One season at a time, a hierarchical Gaussian model:

     margin(home) = R_home - R_away + HFA x (not neutral) + e,   e ~ N(0, s^2)

     R of an FBS team is FIXED at EdgeDesk's own rating (the anchor) — the
     scale is EdgeDesk's, not refit here. R of an FCS team is the unknown
       theta_i ~ N(mu_conf(i) + offset_i, v_i)      team within its conference
       mu_c    ~ N(g + offset_c, V_c)               conference within the FCS
       g       ~ N(g0, Vg)                          the FCS level (weak)
     FBS-vs-FCS games carry the scale across; FCS-vs-FCS games order the FCS
     field within it. Margins are capped at the engine's own cap (35) and
     home field is the engine's (3.2), so a bridged rating means exactly what
     an engine rating means.

   The posterior is solved exactly (a dense precision system of ~150
   unknowns, Cholesky), so every rating has its own standard deviation:
   a team seen in twelve games against well-rated opponents is tighter than
   one seen twice. The hyperparameters (team spread within a conference,
   conference spread, game noise) are estimated from the data by a few
   expectation-maximisation passes, not chosen.

   Pure: no file, no clock.
   ========================================================================== */
'use strict';

/* ---------------------------------------------------- dense linear algebra */
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) throw new Error('precision matrix not positive definite at ' + i); L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}
function solveL(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
/* diag of the inverse, and the variance of (x_a - x_b) for requested pairs */
function inverseDiag(L, n) {
  const d = new Float64Array(n);
  /* inverse of L column by column: diag(A^-1) = sum over rows of (L^-1)^2 */
  const Linv = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    Linv[j * n + j] = 1 / L[j * n + j];
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i * n + k] * Linv[k * n + j];
      Linv[i * n + j] = s / L[i * n + i];
    }
  }
  for (let j = 0; j < n; j++) { let s = 0; for (let i = j; i < n; i++) s += Linv[i * n + j] * Linv[i * n + j]; d[j] = s; }
  return { diag: d, Linv };
}
function covOf(inv, n, a, b) {
  /* A^-1 = Linv^T Linv -> cov(a,b) = sum_i Linv[i][a] Linv[i][b] */
  let s = 0;
  for (let i = Math.max(a, b); i < n; i++) s += inv.Linv[i * n + a] * inv.Linv[i * n + b];
  return s;
}

/* ------------------------------------------------------------------- fit
   o: {
     games: [{home, away, home_fbs, away_fbs, neutral, home_points, away_points, kickoff}],
     anchors: {fbsKey: rating}   EdgeDesk ratings; for a per-game anchor pass
                                  game.home_anchor / game.away_anchor
     conference: {fcsKey: conf}
     prior: { teams: {key: {offset, var}}, confs: {conf: {offset, var}}, g0, Vg }
     hyper: { sigma, tau, kappa, hfa, cap, anchor_sd }
     estimate: true to run EM for tau/kappa/sigma
   } */
function fit(o) {
  const H = Object.assign({ sigma: 14.9, tau: 8, kappa: 5, hfa: 3.2, cap: 35, anchor_sd: 3 }, o.hyper || {});
  const prior = o.prior || {};
  const games = (o.games || []).filter((g) => isFinite(g.home_points) && isFinite(g.away_points) && !(g.home_fbs && g.away_fbs));
  /* the FCS unknowns */
  const teams = [], tix = {};
  const addTeam = (k) => { if (!(k in tix)) { tix[k] = teams.length; teams.push(k); } };
  const obs = [];
  games.forEach((g) => {
    const m = Math.max(-H.cap, Math.min(H.cap, g.home_points - g.away_points));
    const hfa = g.neutral ? 0 : H.hfa;
    if (g.home_fbs && !g.away_fbs) {
      const A = g.home_anchor != null ? g.home_anchor : (o.anchors || {})[g.home];
      if (A == null) return;
      addTeam(g.away);
      /* margin = A - theta + hfa  ->  theta = A + hfa - margin */
      obs.push({ kind: 'bridge', a: g.away, b: null, y: A + hfa - m, sign: 1, g });
    } else if (!g.home_fbs && g.away_fbs) {
      const A = g.away_anchor != null ? g.away_anchor : (o.anchors || {})[g.away];
      if (A == null) return;
      addTeam(g.home);
      /* margin = theta - A + hfa  ->  theta = margin + A - hfa */
      obs.push({ kind: 'bridge', a: g.home, b: null, y: m + A - hfa, sign: 1, g });
    } else {
      addTeam(g.home); addTeam(g.away);
      obs.push({ kind: 'fcs', a: g.home, b: g.away, y: m - hfa, g });
    }
  });
  Object.keys(prior.teams || {}).forEach(addTeam);
  const conf = o.conference || {};
  const confs = [], cix = {};
  teams.forEach((k) => { const c = conf[k] || 'FCS (unassigned)'; if (!(c in cix)) { cix[c] = confs.length; confs.push(c); } });
  const nT = teams.length, nC = confs.length, N = nT + nC + 1, G = nT + nC;
  if (!nT) return { teams: {}, confs: {}, g: null, hyper: H, n_obs: 0 };

  let tau = H.tau, kappa = H.kappa, sigma = H.sigma;
  let sol = null, inv = null;
  const iters = o.estimate ? 6 : 1;
  for (let it = 0; it < iters; it++) {
    const A = new Float64Array(N * N), b = new Float64Array(N);
    const add = (i, j, v) => { A[i * N + j] += v; };
    const wGame = (kind) => 1 / (sigma * sigma + (kind === 'bridge' ? H.anchor_sd * H.anchor_sd : 0));
    obs.forEach((x) => {
      const w = wGame(x.kind);
      const i = tix[x.a];
      if (x.kind === 'bridge') { add(i, i, w); b[i] += w * x.y; }
      else { const j = tix[x.b]; add(i, i, w); add(j, j, w); add(i, j, -w); add(j, i, -w); b[i] += w * x.y; b[j] -= w * x.y; }
    });
    teams.forEach((k, i) => {
      const p = (prior.teams || {})[k];
      const off = p && isFinite(p.offset) ? p.offset : 0;
      const v = p && isFinite(p.var) ? p.var : tau * tau;
      const w = 1 / v, c = nT + cix[conf[k] || 'FCS (unassigned)'];
      /* theta_i - mu_c = off */
      add(i, i, w); add(c, c, w); add(i, c, -w); add(c, i, -w); b[i] += w * off; b[c] -= w * off;
    });
    confs.forEach((cname, ci) => {
      const p = (prior.confs || {})[cname];
      const off = p && isFinite(p.offset) ? p.offset : 0;
      const v = p && isFinite(p.var) ? p.var : kappa * kappa;
      const w = 1 / v, c = nT + ci;
      add(c, c, w); add(G, G, w); add(c, G, -w); add(G, c, -w); b[c] += w * off; b[G] -= w * off;
    });
    const g0 = isFinite(prior.g0) ? prior.g0 : -20, Vg = isFinite(prior.Vg) ? prior.Vg : 225;
    add(G, G, 1 / Vg); b[G] += g0 / Vg;
    const L = cholesky(A, N);
    sol = solveL(L, N, b);
    inv = inverseDiag(L, N);
    if (!o.estimate) break;
    /* EM: the spread of teams around their conference, of conferences around
       the FCS mean, and the game noise, each with its posterior variance */
    let st = 0, nt = 0;
    teams.forEach((k, i) => {
      if ((prior.teams || {})[k]) return;
      const c = nT + cix[conf[k] || 'FCS (unassigned)'];
      const d = sol[i] - sol[c];
      st += d * d + inv.diag[i] + inv.diag[c] - 2 * covOf(inv, N, i, c); nt++;
    });
    if (nt > 5) tau = Math.sqrt(st / nt);
    let sc = 0, nc = 0;
    confs.forEach((cname, ci) => {
      if ((prior.confs || {})[cname]) return;
      const c = nT + ci, d = sol[c] - sol[G];
      sc += d * d + inv.diag[c] + inv.diag[G] - 2 * covOf(inv, N, c, G); nc++;
    });
    if (nc > 3) kappa = Math.sqrt(sc / nc);
    let ss = 0, ns = 0;
    obs.forEach((x) => {
      const i = tix[x.a];
      let r, v;
      if (x.kind === 'bridge') { r = x.y - sol[i]; v = inv.diag[i]; ss += r * r + v - H.anchor_sd * H.anchor_sd; }
      else { const j = tix[x.b]; r = x.y - (sol[i] - sol[j]); v = inv.diag[i] + inv.diag[j] - 2 * covOf(inv, N, i, j); ss += r * r + v; }
      ns++;
    });
    if (ns > 30) sigma = Math.sqrt(Math.max(64, ss / ns));
  }
  /* per-team results */
  const games_by = {}, bridge_by = {};
  obs.forEach((x) => {
    games_by[x.a] = (games_by[x.a] || 0) + 1;
    if (x.kind === 'bridge') bridge_by[x.a] = (bridge_by[x.a] || 0) + 1;
    else games_by[x.b] = (games_by[x.b] || 0) + 1;
  });
  const outT = {};
  teams.forEach((k, i) => {
    outT[k] = { rating: sol[i], sd: Math.sqrt(inv.diag[i]), games: games_by[k] || 0, bridge_games: bridge_by[k] || 0,
      conference: conf[k] || null, dev: sol[i] - sol[nT + cix[conf[k] || 'FCS (unassigned)']],
      dev_var: inv.diag[i] + inv.diag[nT + cix[conf[k] || 'FCS (unassigned)']] - 2 * covOf(inv, N, i, nT + cix[conf[k] || 'FCS (unassigned)']) };
  });
  const outC = {};
  confs.forEach((c, ci) => { outC[c] = { mean: sol[nT + ci], sd: Math.sqrt(inv.diag[nT + ci]), off: sol[nT + ci] - sol[G],
    off_var: inv.diag[nT + ci] + inv.diag[G] - 2 * covOf(inv, N, nT + ci, G), teams: teams.filter((k) => (conf[k] || 'FCS (unassigned)') === c).length }; });
  /* residuals of the bridge games: how well the scale carries across */
  const br = obs.filter((x) => x.kind === 'bridge').map((x) => x.y - sol[tix[x.a]]);
  const fr = obs.filter((x) => x.kind === 'fcs').map((x) => x.y - (sol[tix[x.a]] - sol[tix[x.b]]));
  const rms = (a) => a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : null;
  return { teams: outT, confs: outC, g: { mean: sol[G], sd: Math.sqrt(inv.diag[G]) },
    hyper: { sigma, tau, kappa, hfa: H.hfa, cap: H.cap, anchor_sd: H.anchor_sd },
    n_obs: obs.length, n_bridge: obs.filter((x) => x.kind === 'bridge').length, n_fcs: obs.filter((x) => x.kind === 'fcs').length,
    residual_rms: { bridge: rms(br), fcs: rms(fr) } };
}

/* the next season's prior from a finished season: each team keeps `carry`
   of its deviation from its conference (the engine's own season carry), and
   the rest of the between-team spread comes back as uncertainty */
function carryPrior(prev, carry, tau) {
  const teams = {}, confs = {};
  Object.keys(prev.teams).forEach((k) => {
    const t = prev.teams[k];
    teams[k] = { offset: carry * t.dev, var: carry * carry * t.dev_var + (1 - carry * carry) * tau * tau };
  });
  Object.keys(prev.confs).forEach((c) => {
    const x = prev.confs[c];
    /* a conference's level moves less than a team's; its posterior variance
       plus one season of drift (a quarter of the conference spread) */
    confs[c] = { offset: x.off, var: x.off_var + Math.pow(prev.hyper.kappa / 2, 2) };
  });
  return { teams, confs, g0: prev.g.mean, Vg: prev.g.sd * prev.g.sd + 4 };
}

module.exports = { fit, carryPrior, cholesky, solveL, inverseDiag };
