'use strict';
/* ===========================================================================
   EdgeDesk NBA — MODEL C: player impact, minutes and availability.

   REGULARISED ADJUSTED PLUS-MINUS (Rosenbaum 2004; Sill 2010; the ridge form
   used by every public RAPM). Each lineup stint gives two observations, one
   per offence:
       y = 100 · points / possessions
         = L_season + h·home + Σ_{offence} O_i − Σ_{defence} D_j + ε
   weighted by the stint's possessions (FGA − OREB + TOV + 0.44·FTA, its own
   counts) times an exponential age decay (half-life H days). O is a player's
   offensive impact and D his defensive impact (positive = good), both in
   points per 100 possessions against an average lineup. The ridge pulls
   every player toward a prior mean (`prior_o`, `prior_d`: a newcomer is
   assumed slightly below average until his minutes say otherwise) with
   strength λ; L (one per season in the window) and h are not penalised.
   Solved by conjugate gradient on the sparse normal equations, warm-started
   from the previous fit, refitted every `refit_days`. Window: the current
   season and the two before it. Only stints whose two fives were both
   reconstructed (ok = 1) are used.

   MINUTES. A player's expected minutes when available: an exponentially
   weighted mean of his minutes in games he played (half-life `min_half_life`
   games), carried across a trade; a player with no NBA minutes yet starts at
   `rookie_minutes`. A team's available players are scaled so their expected
   minutes sum to 240 (no one above `max_minutes`): the minutes of an absent
   player go to the teammates who are available, in proportion to their own.

   AVAILABILITY, two regimes (the walk-forward reports both):
     projected   who played in the team's previous game. Knowable the night
                 before; no injury report is used (none is licensed here).
                 A team's first game of a season uses the confirmed five-plus
                 bench (stated in the record).
     confirmed   who played in this game — the inactive list and starting
                 lineups, published about 30 minutes before tip-off, are
                 assumed known at prediction time (the NHL engine's
                 confirmed-lineup assumption applied to the NBA).

   TEAM STRENGTH = Σ (expected minutes / 48) · (O, D) over the available
   players. The AVAILABILITY ADJUSTMENT is tonight's strength minus the
   team's full-strength reference (every player with minutes in its last ten
   games, valued at his usual minutes): a star's absence costs what his
   minutes and his impact say against the minutes that replace him — never a
   fixed number of points.
   =========================================================================== */

class PlayerModel {
  constructor(p) {
    this.p = Object.assign({ half_life_days: 365, lambda: 3000, prior_o: -0.5, prior_d: -0.5, refit_days: 7, window_seasons: 3, cg_iters: 40,
      min_half_life: 8, rookie_minutes: 10, max_minutes: 40 }, p || {});
    this.rows = [];           /* { day, season, off:[k…5], def:[k…5], home, y, w } */
    this.pidx = new Map();    /* pid → k (O at 2k, D at 2k+1) */
    this.pids = [];
    this.x = new Float64Array(0); /* solution vector: player params then season Ls then h */
    this.seasonIdx = new Map();
    this.lastFit = null; this.season = null;
    this.pl = new Map();      /* pid → { ewm, wsum, team, last_day, starts_ewm, games } */
    this.teamRecent = new Map(); /* team → [ [pids played], … ] last 10 games, newest last */
  }
  k(pid) { let k = this.pidx.get(pid); if (k == null) { k = this.pids.length; this.pidx.set(pid, k); this.pids.push(pid); } return k; }
  startSeason(s) { this.season = s; }

  /** a finished game's stints: [[t0,t1,h5,a5,hp,ap,hfga,afga,hfta,afta,hor,aor,htov,atov,ok]…] */
  addStints(day, season, stints, neutral) {
    for (const s of stints) {
      if (!s[14]) continue;
      const h5 = s[2].split(' '), a5 = s[3].split(' ');
      if (h5.length !== 5 || a5.length !== 5) continue;
      const hposs = s[6] - s[10] + s[12] + 0.44 * s[8], aposs = s[7] - s[11] + s[13] + 0.44 * s[9];
      const hk = h5.map((p) => this.k(p)), ak = a5.map((p) => this.k(p));
      if (hposs > 0.3) this.rows.push({ day, season, off: hk, def: ak, home: neutral ? 0 : 1, y: 100 * s[4] / hposs, w: hposs });
      if (aposs > 0.3) this.rows.push({ day, season, off: ak, def: hk, home: neutral ? 0 : -1, y: 100 * s[5] / aposs, w: aposs });
    }
  }

  /** a finished game's player rows (box): minutes history and recent rotations */
  addPlayerGames(day, rows) {
    const byTeam = new Map();
    for (const r of rows) {
      if (!r.pl) continue;
      let s = this.pl.get(r.p);
      if (!s) { s = { ewm: 0, wsum: 0, team: r.tm, last_day: null, starts: 0, games: 0 }; this.pl.set(r.p, s); }
      const a = Math.pow(0.5, 1 / this.p.min_half_life);
      s.ewm = s.ewm * a + r.min; s.wsum = s.wsum * a + 1;
      s.starts = s.starts * a + (r.st ? 1 : 0);
      s.team = r.tm; s.last_day = day; s.games++;
      if (!byTeam.has(r.tm)) byTeam.set(r.tm, []);
      byTeam.get(r.tm).push(r.p);
    }
    for (const [tm, list] of byTeam) { const q = this.teamRecent.get(tm) || []; q.push(list); while (q.length > 10) q.shift(); this.teamRecent.set(tm, q); }
  }
  expMinutes(pid) { const s = this.pl.get(pid); return s && s.wsum > 0 ? s.ewm / s.wsum : this.p.rookie_minutes; }
  startRate(pid) { const s = this.pl.get(pid); return s && s.wsum > 0 ? s.starts / s.wsum : 0; }
  lastGamePlayers(team) { const q = this.teamRecent.get(team); return q && q.length ? q[q.length - 1].slice() : null; }
  regulars(team) { const q = this.teamRecent.get(team) || []; const set = new Set(); for (const g of q) for (const p of g) set.add(p); return [...set]; }

  /* -------------------------------------------------------------- the fit */
  refit(day) {
    const P = this.p;
    const minSeason = this.season - P.window_seasons + 1;
    const rows = this.rows.filter((r) => r.season >= minSeason);
    this.rows = rows;
    if (rows.length < 200) return;
    const seasons = [...new Set(rows.map((r) => r.season))].sort();
    const np = this.pids.length; const base = 2 * np; const nS = seasons.length;
    const sIdx = new Map(seasons.map((s, i) => [s, base + i])); const hI = base + nS; const N = hI + 1;
    const lam = Math.LN2 / P.half_life_days;
    const w = new Float64Array(rows.length); for (let i = 0; i < rows.length; i++) w[i] = rows[i].w * Math.exp(-lam * Math.max(0, day - rows[i].day));
    /* prior mean and penalty per parameter */
    const mu = new Float64Array(N), pen = new Float64Array(N);
    for (let k = 0; k < np; k++) { mu[2 * k] = P.prior_o; mu[2 * k + 1] = P.prior_d; pen[2 * k] = P.lambda; pen[2 * k + 1] = P.lambda; }
    for (let i = base; i < N; i++) pen[i] = 1e-3;
    /* start from the last solution (re-indexed) */
    let x = new Float64Array(N);
    for (let k = 0; k < np; k++) { if (2 * k + 1 < this.x.length && this.lastNp != null && k < this.lastNp) { x[2 * k] = this.x[2 * k]; x[2 * k + 1] = this.x[2 * k + 1]; } else { x[2 * k] = mu[2 * k]; x[2 * k + 1] = mu[2 * k + 1]; } }
    for (const s of seasons) { const old = this.seasonIdx.get(s); x[sIdx.get(s)] = old != null && old < this.x.length ? this.x[old] : 105; }
    x[hI] = this.hIdx != null && this.hIdx < this.x.length ? this.x[this.hIdx] : 1.5;
    const Xv = (v, r) => { let s = v[sIdx.get(r.season)] + v[hI] * r.home; for (const k of r.off) s += v[2 * k]; for (const k of r.def) s -= v[2 * k + 1]; return s; };
    const XtWX = (v, out) => {
      out.fill(0);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]; const z = w[i] * Xv(v, r);
        out[sIdx.get(r.season)] += z; out[hI] += z * r.home;
        for (const k of r.off) out[2 * k] += z; for (const k of r.def) out[2 * k + 1] -= z;
      }
      for (let j = 0; j < N; j++) out[j] += pen[j] * v[j];
    };
    const b = new Float64Array(N);
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; const z = w[i] * r.y; b[sIdx.get(r.season)] += z; b[hI] += z * r.home; for (const k of r.off) b[2 * k] += z; for (const k of r.def) b[2 * k + 1] -= z; }
    for (let j = 0; j < N; j++) b[j] += pen[j] * mu[j];
    /* conjugate gradient, Jacobi-preconditioned */
    const diag = new Float64Array(N);
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; diag[sIdx.get(r.season)] += w[i]; diag[hI] += w[i] * r.home * r.home; for (const k of r.off) diag[2 * k] += w[i]; for (const k of r.def) diag[2 * k + 1] += w[i]; }
    for (let j = 0; j < N; j++) diag[j] += pen[j];
    const Ax = new Float64Array(N); XtWX(x, Ax);
    const rr = new Float64Array(N), z = new Float64Array(N), pp = new Float64Array(N), Ap = new Float64Array(N);
    for (let j = 0; j < N; j++) { rr[j] = b[j] - Ax[j]; z[j] = rr[j] / diag[j]; pp[j] = z[j]; }
    let rz = 0; for (let j = 0; j < N; j++) rz += rr[j] * z[j];
    const b2 = Math.sqrt(b.reduce((a, v) => a + v * v, 0)) || 1;
    let it = 0;
    for (; it < P.cg_iters; it++) {
      XtWX(pp, Ap);
      let pAp = 0; for (let j = 0; j < N; j++) pAp += pp[j] * Ap[j];
      const alpha = rz / pAp;
      let rn = 0; for (let j = 0; j < N; j++) { x[j] += alpha * pp[j]; rr[j] -= alpha * Ap[j]; rn += rr[j] * rr[j]; }
      if (Math.sqrt(rn) / b2 < 1e-7) break;
      let rz2 = 0; for (let j = 0; j < N; j++) { z[j] = rr[j] / diag[j]; rz2 += rr[j] * z[j]; }
      const beta = rz2 / rz; rz = rz2;
      for (let j = 0; j < N; j++) pp[j] = z[j] + beta * pp[j];
    }
    this.x = x; this.lastNp = np; this.seasonIdx = sIdx; this.hIdx = hI; this.lastFit = day; this.cgIters = it;
  }
  maybeRefit(day) { if (this.lastFit == null || day - this.lastFit >= this.p.refit_days) this.refit(day); }

  value(pid) {
    const k = this.pidx.get(pid);
    /* a player first seen after the last fit has no estimate yet: the prior, never
       a neighbouring entry of the solution vector (the season levels follow the
       players in it) */
    if (k == null || this.lastNp == null || k >= this.lastNp) return { o: this.p.prior_o, d: this.p.prior_d, known: false };
    return { o: this.x[2 * k], d: this.x[2 * k + 1], known: true };
  }
  homeEdge() { return this.hIdx != null && this.hIdx < this.x.length ? this.x[this.hIdx] : 1.5; }

  /**
   * Team strength for a set of available players.
   * Returns { off, def, net, minutes: [{pid, min, o, d}] } with minutes scaled to 240.
   */
  strength(pids) {
    const P = this.p; const list = pids.map((pid) => ({ pid, m: this.expMinutes(pid) }));
    let tot = list.reduce((a, x) => a + x.m, 0);
    if (!list.length || tot <= 0) return { off: 5 * P.prior_o, def: 5 * P.prior_d, net: 5 * (P.prior_o + P.prior_d), minutes: [] };
    /* scale to 240 with a per-player cap, redistributing the excess */
    let scale = 240 / tot;
    for (let iter = 0; iter < 5; iter++) {
      let capped = 0, free = 0;
      for (const x of list) { const v = x.m * scale; if (v > P.max_minutes) capped += P.max_minutes; else free += v; }
      if (capped + free >= 239.5 && capped + free <= 240.5) break;
      const freeBase = list.filter((x) => x.m * scale <= P.max_minutes).reduce((a, x) => a + x.m, 0);
      if (freeBase <= 0) break;
      scale = (240 - capped) / freeBase;
    }
    let off = 0, def = 0; const minutes = [];
    for (const x of list) {
      const mm = Math.min(P.max_minutes, x.m * scale); const v = this.value(x.pid);
      off += (mm / 48) * v.o; def += (mm / 48) * v.d; minutes.push({ pid: x.pid, min: mm, o: v.o, d: v.d, known: v.known });
    }
    return { off, def, net: off + def, minutes };
  }
}

module.exports = { PlayerModel };
