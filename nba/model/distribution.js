'use strict';
/* ===========================================================================
   EdgeDesk NBA — one predictive distribution per game, and every market's
   fair price read from it. Browser and Node (UMD: window.EDNBADist), so the
   research panel prices with exactly the code the record was scored with.

   ONE DISTRIBUTION. Every market of a game comes from a single joint pmf over
   (final margin, final total). Moneyline, spread, total, team totals and the
   alternate ladders therefore cannot contradict one another: the moneyline is
   P(margin > 0) of the same distribution the spread is priced from.

   REGULATION MARGIN (home − away, integers). A discretised normal N(μm, σm)
   reshaped by end-game weights w(|m|) for |m| ≤ K:
       P(m) ∝ [Φ((m + ½ − μm)/σm) − Φ((m − ½ − μm)/σm)] · exp(θ_|m|)
   The weights are fitted by maximum likelihood on earlier seasons' regulation
   margins (nba/model/dist_fit.js). They encode what a plain normal misses:
   ties are more common (a team down two plays for the tie; a team down three
   fouls and shoots for it), and one-point margins rarer. Stern (1994) is the
   normal; the end-game reshaping is fitted, not assumed.

   OVERTIME. A regulation tie goes to a 5-minute period whose margin is a
   discretised N(κ·μm, σot) with its own tie weight (fitted), repeated while
   tied (six periods are carried; the remainder, < 1e-6, is split evenly).
   Each period adds a total ~ N(τ, sτ) of the parity its margin requires.

   REGULATION TOTAL. A discretised normal N(μt + γ·(|m| − E|m|), σt) given the
   regulation margin, of the parity the margin requires (home and away points
   are integers). γ (fitted; 0 if not material) lets blowouts and close-game
   fouling move the total without moving its mean.

   HALVES AND QUARTERS. First half and first quarter: discretised normals
   N(f·μm, σ), N(g·μt, σ) with f, g, σ fitted on earlier seasons; a tie is
   possible and is a push for a two-way line.

   SETTLEMENT (the common North American book rules, stated on every price):
     moneyline, spread, total, team totals   include overtime
     first half / first quarter              regulation periods only; a tied
                                             half on a 2-way moneyline pushes
     whole-number lines push                 the fair price excludes the push
   =========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDNBADist = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 'edgedesk_nba_dist_v1';
  const MMAX = 70, OTMAX = 30, OT_PERIODS = 6;

  function Phi(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  /** discretised normal over integers lo..hi (array index i ↔ value lo + i), optional parity (0 even, 1 odd) */
  function discNormal(mu, sd, lo, hi, parity) {
    const out = new Float64Array(hi - lo + 1); let s = 0;
    for (let v = lo; v <= hi; v++) {
      if (parity != null && ((v % 2) + 2) % 2 !== parity) continue;
      const w = parity != null ? 1 : 0.5;
      const p = Phi((v + w - mu) / sd) - Phi((v - w - mu) / sd);
      out[v - lo] = p; s += p;
    }
    if (s > 0) for (let i = 0; i < out.length; i++) out[i] /= s;
    return out;
  }
  /* end-game log-weight of a regulation margin m. A plain array is symmetric in
     |m|. An oriented shape { zero, fav: [θ1…], dog: [θ1…], blend } weights the
     favourite's side and the underdog's side separately (the trailing team
     plays for the tie and fouls; the leader extends late leads), blended by
     s = Φ(μ/blend) so a pick'em game gets the average and nothing jumps at μ = 0. */
  function shapeLog(theta, m, mu) {
    if (!theta) return 0;
    const k = Math.abs(m);
    if (Array.isArray(theta)) return k < theta.length ? theta[k] : 0;
    if (k === 0) return theta.zero || 0;
    const f = k <= theta.fav.length ? theta.fav[k - 1] : 0, d = k <= theta.dog.length ? theta.dog[k - 1] : 0;
    const s = Phi(mu / (theta.blend || 2));
    return m > 0 ? s * f + (1 - s) * d : s * d + (1 - s) * f;
  }
  function shapeWeight(theta, m, mu) { return Math.exp(shapeLog(theta, m, mu)); }

  /** regulation margin pmf over −MMAX..MMAX */
  function regMargin(p) {
    const out = new Float64Array(2 * MMAX + 1); let s = 0;
    for (let m = -MMAX; m <= MMAX; m++) {
      const v = (Phi((m + 0.5 - p.mu_m) / p.sd_m) - Phi((m - 0.5 - p.mu_m) / p.sd_m)) * shapeWeight(p.theta, m, p.mu_m);
      out[m + MMAX] = v; s += v;
    }
    for (let i = 0; i < out.length; i++) out[i] /= s;
    return out;
  }
  /** one overtime period's margin pmf over −OTMAX..OTMAX */
  function otMargin(p) {
    const o = p.ot || {}; const mu = (o.kappa == null ? 5 / 48 : o.kappa) * p.mu_m; const sd = o.sd || 5;
    const out = new Float64Array(2 * OTMAX + 1); let s = 0;
    for (let m = -OTMAX; m <= OTMAX; m++) {
      const v = (Phi((m + 0.5 - mu) / sd) - Phi((m - 0.5 - mu) / sd)) * (m === 0 && o.tie_w != null ? Math.exp(o.tie_w) : 1);
      out[m + OTMAX] = v; s += v;
    }
    for (let i = 0; i < out.length; i++) out[i] /= s;
    return out;
  }

  /**
   * FAST MARGINALS (used to score tens of thousands of games):
   * { margin: { lo, pmf } final margin, reg: regulation margin pmf, p_ot,
   *   total: { lo, pmf } final total (parity ignored), p_home }
   */
  function marginals(p) {
    const reg = regMargin(p);
    const p0 = reg[MMAX];
    const ot = otMargin(p); const otTie = ot[OTMAX];
    const fin = new Float64Array(2 * MMAX + 1);
    for (let i = 0; i < reg.length; i++) if (i !== MMAX) fin[i] = reg[i];
    /* a tie at the end of overtime k: mass p0·otTie^(k-1) enters period k */
    let mass = p0;
    for (let k = 0; k < OT_PERIODS; k++) {
      for (let j = 0; j < ot.length; j++) if (j !== OTMAX) fin[j - OTMAX + MMAX] += mass * ot[j];
      mass *= otTie;
    }
    fin[MMAX + 1] += mass / 2; fin[MMAX - 1] += mass / 2;
    let ph = 0; for (let m = 1; m <= MMAX; m++) ph += fin[m + MMAX];
    /* total: the regulation normal, plus k overtime periods with probability
       p0·otTie^(k−1)·(1 − otTie); k periods add N(k·τ, k·sτ²), so the total
       given k overtimes is N(μt + kτ, σt² + k·sτ²) — a normal mixture */
    const TLO = 100, THI = 380;
    const o = p.ot || {}; const tau = o.total_mean == null ? 20 : o.total_mean, stau = o.total_sd == null ? 5 : o.total_sd;
    const tot = new Float64Array(THI - TLO + 1);
    const add = (w, mu, sd) => { if (w < 1e-9) return; const d = discNormal(mu, sd, TLO, THI, null); for (let i = 0; i < tot.length; i++) tot[i] += w * d[i]; };
    add(1 - p0, p.mu_t, p.sd_t);
    let pk = p0;
    for (let k = 1; k <= OT_PERIODS; k++) { const share = k === OT_PERIODS ? pk : pk * (1 - otTie); add(share, p.mu_t + k * tau, Math.sqrt(p.sd_t * p.sd_t + k * stau * stau)); pk *= otTie; }
    return { margin: { lo: -MMAX, pmf: fin }, reg: { lo: -MMAX, pmf: reg }, p_ot: p0, total: { lo: TLO, pmf: tot }, p_home: ph };
  }

  /**
   * THE JOINT (for pricing a slate: team totals need it).
   * Returns { lo_m, lo_t, J: Float64Array[(m - lo_m) * NT + (t - lo_t)] } over final margin × final total.
   */
  function joint(p) {
    const reg = regMargin(p);
    const TLO = 120, THI = 340, NT = THI - TLO + 1, NM = 2 * MMAX + 1;
    const J = new Float64Array(NM * NT);
    let em = 0; for (let m = -MMAX; m <= MMAX; m++) em += Math.abs(m) * reg[m + MMAX];
    const g = p.gamma || 0;
    const ot = otMargin(p); const otTie = ot[OTMAX];
    const o = p.ot || {}; const tau = o.total_mean == null ? 20 : o.total_mean, stau = o.total_sd == null ? 5 : o.total_sd;
    const addOdd = discNormal(tau, stau, 0, 60, 1), addEven = discNormal(tau, stau, 0, 60, 0);
    let tieTot = null;
    for (let m = -MMAX; m <= MMAX; m++) {
      const pm = reg[m + MMAX]; if (pm < 1e-12) continue;
      const pt = discNormal(p.mu_t + g * (Math.abs(m) - em), p.sd_t, TLO, THI, ((m % 2) + 2) % 2);
      if (m === 0) { tieTot = pt.map((v) => v * pm); continue; }
      const row = (m + MMAX) * NT;
      for (let i = 0; i < NT; i++) J[row + i] += pm * pt[i];
    }
    /* overtime: carry the still-tied mass over totals */
    let cur = tieTot || new Float64Array(NT);
    for (let k = 0; k < OT_PERIODS; k++) {
      const next = new Float64Array(NT);
      for (let i = 0; i < NT; i++) {
        const c = cur[i]; if (c < 1e-14) continue;
        for (let j = 0; j < ot.length; j++) {
          const km = j - OTMAX; const q = ot[j]; if (q < 1e-12) continue;
          const add = (km % 2 === 0) ? addEven : addOdd;
          for (let a = 0; a < add.length; a++) {
            const ti = i + a; if (ti >= NT || add[a] < 1e-12) continue;
            const w = c * q * add[a];
            if (km === 0) next[ti] += w; else J[(km + MMAX) * NT + ti] += w;
          }
        }
      }
      cur = next;
    }
    for (let i = 0; i < NT; i++) if (cur[i] > 0) { if (i + 1 < NT) { J[(1 + MMAX) * NT + i + 1] += cur[i] / 2; J[(-1 + MMAX) * NT + i + 1] += cur[i] / 2; } }
    let s = 0; for (let i = 0; i < J.length; i++) s += J[i];
    if (s > 0) for (let i = 0; i < J.length; i++) J[i] /= s;
    return { lo_m: -MMAX, lo_t: TLO, NM, NT, J, p_ot: reg[MMAX] };
  }

  function probToAmerican(p) { if (!(p > 0 && p < 1)) return null; const d = 1 / p; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function americanToProb(a) { a = Number(a); if (!isFinite(a) || a === 0 || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  function americanToDecimal(a) { a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }

  /** win / push / lose of a two-way line, with the push-free fair probability */
  function twoWay(win, push, lose) {
    const s = win + lose;
    return { win: r6(win), push: r6(push), lose: r6(lose), fair: s > 0 ? r6(win / s) : null, fair_american: s > 0 ? probToAmerican(win / s) : null };
  }
  function r6(v) { return Math.round(v * 1e6) / 1e6; }

  /* readers over a marginal pmf { lo, pmf } */
  function pGreater(d, x) { let s = 0; for (let i = 0; i < d.pmf.length; i++) if (d.lo + i > x) s += d.pmf[i]; return s; }
  function pEqual(d, x) { const i = x - d.lo; return Number.isInteger(x) && i >= 0 && i < d.pmf.length ? d.pmf[i] : 0; }
  function mean(d) { let s = 0; for (let i = 0; i < d.pmf.length; i++) s += (d.lo + i) * d.pmf[i]; return s; }
  function quantile(d, q) { let c = 0; for (let i = 0; i < d.pmf.length; i++) { c += d.pmf[i]; if (c >= q) return d.lo + i; } return d.lo + d.pmf.length - 1; }
  /** CRPS of an integer pmf for outcome y (sum over the cdf) */
  function crps(d, y) { let c = 0, s = 0; for (let i = 0; i < d.pmf.length; i++) { c += d.pmf[i]; const v = d.lo + i; const o = v >= y ? 1 : 0; s += (c - o) * (c - o); } return s; }
  /** randomised PIT for a discrete outcome: F(y-1) + u·P(y) with u = ½ (mid-PIT) */
  function pit(d, y) { let c = 0; for (let i = 0; i < d.pmf.length; i++) { const v = d.lo + i; if (v < y) c += d.pmf[i]; else if (v === y) return c + d.pmf[i] / 2; else break; } return c; }

  /** home spread: line L for the home side (−5.5 = home favoured by 5.5) */
  function spread(dm, L) { return twoWay(pGreater(dm, -L), pEqual(dm, -L), 1 - pGreater(dm, -L) - pEqual(dm, -L)); }
  function total(dt, line) { const over = pGreater(dt, line), push = pEqual(dt, line); return Object.assign({ line }, { over: twoWay(over, push, 1 - over - push), under: twoWay(1 - over - push, push, over) }); }

  /** team totals from the joint: home points = (t + m)/2 */
  function teamTotals(jt) {
    const h = new Map(), a = new Map();
    for (let mi = 0; mi < jt.NM; mi++) for (let ti = 0; ti < jt.NT; ti++) {
      const p = jt.J[mi * jt.NT + ti]; if (p < 1e-12) continue;
      const m = jt.lo_m + mi, t = jt.lo_t + ti; if ((t + m) % 2) continue;
      const hp = (t + m) / 2, ap = (t - m) / 2;
      h.set(hp, (h.get(hp) || 0) + p); a.set(ap, (a.get(ap) || 0) + p);
    }
    const toD = (mp) => { const ks = [...mp.keys()].sort((x, y) => x - y); const lo = ks[0], hi = ks[ks.length - 1]; const pmf = new Float64Array(hi - lo + 1); for (const [k, v] of mp) pmf[k - lo] = v; return { lo, pmf }; };
    return { home: toD(h), away: toD(a) };
  }

  function periodDist(muM, sdM, muT, sdT) {
    return { margin: { lo: -60, pmf: discNormal(muM, sdM, -60, 60, null) }, total: { lo: 0, pmf: discNormal(muT, sdT, 0, 220, null) } };
  }


  /**
   * PRICE A GAME: params → every market's fair price.
   * params: { mu_m, sd_m, mu_t, sd_t, theta, gamma, ot:{kappa, sd, tie_w, total_mean, total_sd},
   *           half:{f_m, sd_m, f_t, sd_t}, quarter:{f_m, sd_m, f_t, sd_t} }
   */
  function price(p, o) {
    o = o || {};
    const mg = marginals(p);
    const jt = o.joint === false ? null : joint(p);
    const dm = mg.margin, dt = mg.total;
    const fairSpread = -fairHalf(dm);
    const fairTotal = fairHalf(dt);
    const ladder = (center, f, step, n) => { const out = []; for (let k = -n; k <= n; k++) out.push(f(center + k * step)); return out; };
    const out = {
      version: VERSION,
      moneyline: { home: r6(mg.p_home), away: r6(1 - mg.p_home), home_american: probToAmerican(mg.p_home), away_american: probToAmerican(1 - mg.p_home), settles: 'includes overtime' },
      expected: { margin: r2(mean(dm)), total: r2(mean(dt)), home: r2((mean(dt) + mean(dm)) / 2), away: r2((mean(dt) - mean(dm)) / 2), regulation_margin: r2(mean(mg.reg)) },
      p_overtime: r6(mg.p_ot),
      margin_interval_80: [quantile(dm, 0.1), quantile(dm, 0.9)], total_interval_80: [quantile(dt, 0.1), quantile(dt, 0.9)],
      spread: { fair_line_home: fairSpread, main: Object.assign({ line_home: fairSpread }, spread(dm, fairSpread)), ladder: ladder(fairSpread, (L) => Object.assign({ line_home: L }, spread(dm, L)), 0.5, 16), settles: 'includes overtime; a whole-number line can push' },
      total: { fair_line: fairTotal, main: total(dt, fairTotal), ladder: ladder(fairTotal, (L) => total(dt, L), 0.5, 20), settles: 'includes overtime; a whole-number line can push' },
      margin_bands: bands(dm),
    };
    if (jt) {
      const tt = teamTotals(jt);
      const hl = fairHalf(tt.home), al = fairHalf(tt.away);
      out.team_totals = { home: { fair_line: hl, main: total(tt.home, hl), ladder: ladder(hl, (L) => total(tt.home, L), 0.5, 10) }, away: { fair_line: al, main: total(tt.away, al), ladder: ladder(al, (L) => total(tt.away, L), 0.5, 10) }, settles: 'include overtime' };
    }
    for (const [key, q] of [['first_half', p.half], ['first_quarter', p.quarter]]) {
      if (!q) continue;
      const d = periodDist(q.f_m * p.mu_m, q.sd_m, q.f_t * p.mu_t, q.sd_t);
      const ph = pGreater(d.margin, 0), pt = pEqual(d.margin, 0);
      const fl = -fairHalf(d.margin), ft = fairHalf(d.total);
      out[key] = {
        moneyline_2way: twoWay(ph, pt, 1 - ph - pt), moneyline_3way: { home: r6(ph), tie: r6(pt), away: r6(1 - ph - pt) },
        spread: Object.assign({ line_home: fl }, spread(d.margin, fl)), total: total(d.total, ft),
        expected: { margin: r2(mean(d.margin)), total: r2(mean(d.total)) },
        settles: 'regulation periods only; a tie pushes a two-way moneyline',
      };
    }
    return out;
  }
  /** the half-point x whose P(value > x) is closest to ½ (a fair line has no push) */
  function fairHalf(d) {
    let best = null, c = 0;
    for (let i = 0; i < d.pmf.length; i++) {
      c += d.pmf[i]; const x = d.lo + i + 0.5; const over = 1 - c;
      if (!best || Math.abs(over - 0.5) < Math.abs(best.over - 0.5)) best = { x, over };
    }
    return best ? best.x : 0;
  }
  function bands(dm) {
    const B = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 99]]; const o = { home: {}, away: {} };
    for (const [a, b] of B) { let h = 0, w = 0; for (let m = a; m <= b; m++) { h += pEqual(dm, m); w += pEqual(dm, -m); } o.home[a + '-' + (b === 99 ? '+' : b)] = r6(h); o.away[a + '-' + (b === 99 ? '+' : b)] = r6(w); }
    return o;
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  /** EV of a quoted American price on a two-way outcome with push probability */
  function evAt(win, push, american) {
    const d = americanToDecimal(american); if (d == null) return null;
    const lose = 1 - win - push; return r6(win * (d - 1) - lose);
  }

  return { VERSION, fairHalf, shapeLog, Phi, discNormal, regMargin, otMargin, marginals, joint, price, spread, total, teamTotals, periodDist, pGreater, pEqual, mean, quantile, crps, pit, probToAmerican, americanToProb, americanToDecimal, twoWay, evAt, MMAX };
});
