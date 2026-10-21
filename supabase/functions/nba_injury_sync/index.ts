// @ts-nocheck — plain JavaScript cores inlined in a .ts file, as the circa and billing functions are.
// ============================================================
//  FILE:    supabase/functions/nba_injury_sync/index.ts
//  TYPE:    Edge Function — NBA injury report and rosters (T0), and the
//           Roster-Adjusted Projection (T3, EXPERIMENTAL)
//  DEPLOY:  supabase functions deploy nba_injury_sync --no-verify-jwt
//           (npm:unpdf is fetched and bundled at deploy, as circa_ownership_sync bundles it)
//           .github/workflows/deploy-nba-injury.yml does it, tests first
//  CRON:    supabase/nba_injury_cron.sql — pokes at :07 and :37, 13:00-04:59 UTC;
//           THIS function decides: every poke on a game day from 9:00 AM
//           Eastern to 30 minutes after the last tip, once a day otherwise
//  SQL:     supabase/nba_injury_layer.sql, supabase/nba_roster_adjusted_registry.sql
// ============================================================
// WHAT IT DOES, each run:
//   1. reads the slate's roster inputs (nba/roster_inputs.json, published
//      with the site): the schedule, each game's baseline means, the reference
//      rotations, every player's impact and minutes
//   2. ROSTERS (T0): ESPN's team roster JSON for all 30 teams; a team whose
//      roster changed gets a new capture. ESPN unreachable for a team: the
//      hoopR copy of ESPN's rosters carried in the inputs, only when that team
//      has no capture from the last 24 hours
//   3. STATUSES (T0): the league's official injury report — the newest PDF
//      linked from official.nba.com's season page (the file-name pattern if
//      the page cannot be read), read with pdf.js. Unreadable: ESPN's league
//      injuries JSON as a labelled FALLBACK. Both down: a FAILED run and a
//      FAILURE alert; nothing is written in their place
//   4. names matched to roster players; rows matched to slate games; an
//      identical consecutive report is not stored twice (the run still says it
//      was checked and when the league last published)
//   5. the Roster-Adjusted Projection (nba/injury/core.js) for every upcoming
//      game on the report, stamped with the registered model version, the
//      report it used, the roster captures and the impact snapshot; an
//      identical consecutive projection is not stored twice
//   6. one run row and its alerts (FAILURE / DEGRADED / DRIFT / WARNING), the
//      readiness KPIs' source (public.nba_injury_readiness)
//
// WHAT IT REFUSES. It never fills a missing status, never matches a name to
// the nearest one, never prices a game whose report is missing, unfiled or
// unmatched (WITHHELD, with why), and never stores a projection the registry
// does not name.
//
// AUTH. pg_cron sends the Vault secret nba_injury_cron_secret as
// x-cron-secret; it must equal NBA_INJURY_CRON_SECRET. A GET is a public
// health probe (BUILD only).
//
// POST body (all optional):
//   force            run outside the game-day window
//   dry              read and compute; write nothing; return everything
//   simulate_outage  ["official", "espn", "rosters"]: treat those sources as
//                    down — the operator's forced-failure test (the run is
//                    recorded with simulated = true)
//   now              ISO time to run as (dry runs and tests)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (provided), NBA_INJURY_CRON_SECRET,
//      NBA_INPUTS_URL (default https://edgedesksports.com/nba/roster_inputs.json)
// ============================================================

export const BUILD = "nba_injury_sync@2026-10-21.1";
const UNPDF = "npm:unpdf@1.8.1";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const INPUTS_URL = "https://edgedesksports.com/nba/roster_inputs.json";
const UA = { "user-agent": "EdgeDesk research (+https://edgedesksports.com)" };
const PARSER_VERSION = "nba-official-lines-1";

// ── BEGIN NBA DIST ─────────────────────────────────────────────────────
// Canonical source: nba/model/distribution.js, copied whole by tools/nba/inline_injury_core.js.
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
// ── END NBA DIST ───────────────────────────────────────────────────────

// ── BEGIN NBA INJURY CORE ─────────────────────────────────────────────────
// Canonical source: nba/injury/core.js (copied verbatim by
// tools/nba/inline_injury_core.js; edit the canonical file, never the copy).

var NBA_INJURY_CORE_VERSION = 'nba-injury-core-2026-10-21-1';

/* THE MODEL VERSION, registered before any holdout evaluation
   (nba/research/roster_adjusted/registration.json carries the same numbers;
   tools/nba/nba_injury_core.test.js fails if they differ). Changing any number
   here is a NEW version, registered first — never a silent edit. */
var NBA_ROSTER_MODEL = {
  key: 'NBA-ROSTER-ADJ',
  name: 'NBA Roster-Adjusted Projection',
  version: '0.1',
  status: 'EXPERIMENTAL',
  provenance: 'EdgeDesk research',
  /* status -> probability the player plays. Fixed estimates, registered up
     front; never tuned on results. UNKNOWN is a source status with no
     official equivalent (ESPN's "Day-To-Day", fallback feed only). */
  play_probability: { OUT: 0, DOUBTFUL: 0.25, QUESTIONABLE: 0.5, PROBABLE: 0.9, AVAILABLE: 1, UNKNOWN: 0.5 },
  minutes: {
    team_minutes: 240,          /* five players x 48 */
    max_minutes: 40,            /* the baseline player model's cap (nba/model/players.js) */
    ewm_weight_games: 4,        /* the player's EWM minutes count as four games of evidence ... */
    preseason_weight_games: 4,  /* ... beside at most four preseason games ... */
    preseason_fade_games: 10,   /* ... whose weight fades to zero over the first ten regular-season games */
    rookie_minutes: 10,         /* no NBA or preseason minutes: the baseline player model's default */
    max_uncertain: 12           /* exact expectation over at most 2^12 availability scenarios per team */
  },
  impact: { measure: 'edgedesk_rapm_v1', tier: 'T2', prior_o: -0.5, prior_d: -0.5 },
  rating_coefficient: 1.0,      /* the minutes-weighted impact change enters the team ratings at full weight */
  sanity: { max_abs_margin_shift: 25, max_abs_total_shift: 30 }
};

/* Team identity. [ESPN id, ESPN abbreviation (the slate's), NBA tricode (the
   official report's), the official report's team name, other spellings] */
var NBA_TEAMS = [
  ['1', 'ATL', 'ATL', 'Atlanta Hawks', []], ['2', 'BOS', 'BOS', 'Boston Celtics', []], ['3', 'NO', 'NOP', 'New Orleans Pelicans', []],
  ['4', 'CHI', 'CHI', 'Chicago Bulls', []], ['5', 'CLE', 'CLE', 'Cleveland Cavaliers', []], ['6', 'DAL', 'DAL', 'Dallas Mavericks', []],
  ['7', 'DEN', 'DEN', 'Denver Nuggets', []], ['8', 'DET', 'DET', 'Detroit Pistons', []], ['9', 'GS', 'GSW', 'Golden State Warriors', []],
  ['10', 'HOU', 'HOU', 'Houston Rockets', []], ['11', 'IND', 'IND', 'Indiana Pacers', []], ['12', 'LAC', 'LAC', 'LA Clippers', ['Los Angeles Clippers']],
  ['13', 'LAL', 'LAL', 'Los Angeles Lakers', ['LA Lakers']], ['14', 'MIA', 'MIA', 'Miami Heat', []], ['15', 'MIL', 'MIL', 'Milwaukee Bucks', []],
  ['16', 'MIN', 'MIN', 'Minnesota Timberwolves', []], ['17', 'BKN', 'BKN', 'Brooklyn Nets', []], ['18', 'NY', 'NYK', 'New York Knicks', []],
  ['19', 'ORL', 'ORL', 'Orlando Magic', []], ['20', 'PHI', 'PHI', 'Philadelphia 76ers', ['Philadelphia Sixers']], ['21', 'PHX', 'PHX', 'Phoenix Suns', []],
  ['22', 'POR', 'POR', 'Portland Trail Blazers', ['Portland Trailblazers']], ['23', 'SAC', 'SAC', 'Sacramento Kings', []], ['24', 'SA', 'SAS', 'San Antonio Spurs', []],
  ['25', 'OKC', 'OKC', 'Oklahoma City Thunder', []], ['26', 'UTAH', 'UTA', 'Utah Jazz', []], ['27', 'WSH', 'WAS', 'Washington Wizards', []],
  ['28', 'TOR', 'TOR', 'Toronto Raptors', []], ['29', 'MEM', 'MEM', 'Memphis Grizzlies', []], ['30', 'CHA', 'CHA', 'Charlotte Hornets', []]
];
function nbaTeam(key) {
  var k = String(key == null ? '' : key).trim().toUpperCase();
  for (var i = 0; i < NBA_TEAMS.length; i++) {
    var t = NBA_TEAMS[i];
    if (t[0] === k || t[1] === k || t[2] === k || t[3].toUpperCase() === k || t[4].some(function (a) { return a.toUpperCase() === k; })) return { id: t[0], abbr: t[1], tricode: t[2], name: t[3] };
  }
  /* the abbreviations other feeds use */
  var alt = { GSW: '9', NOP: '3', NYK: '18', SAS: '24', UTA: '26', WAS: '27', NJ: '17', BRK: '17', PHO: '21', CHO: '30' }[k];
  return alt ? nbaTeam(alt) : null;
}
/* every spelling of every team name, longest first (a name is read as a prefix) */
var NBA_TEAM_NAMES = (function () {
  var out = [];
  NBA_TEAMS.forEach(function (t) { [t[3]].concat(t[4]).forEach(function (n) { out.push({ name: n, id: t[0] }); }); });
  return out.sort(function (a, b) { return b.name.length - a.name.length; });
})();

/* ---------------------------------------------------------------- time (Eastern) */
var NBA_ET_FMT = null;
function nbaEtParts(t) {
  if (!NBA_ET_FMT) NBA_ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  var p = {}; NBA_ET_FMT.formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute };
}
function nbaEtOffsetMin(t) { var p = nbaEtParts(t); return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000) / 60000); }
/** an Eastern wall-clock time -> epoch ms (daylight time handled by the zone database) */
function nbaEtToUtc(y, mo, d, h, mi) {
  var wall = Date.UTC(y, mo - 1, d, h, mi);
  var t = wall - nbaEtOffsetMin(wall + 5 * 3600e3) * 60000;
  var off2 = nbaEtOffsetMin(t);
  return wall - off2 * 60000;
}
/** epoch ms -> the Eastern date 'YYYY-MM-DD' */
function nbaEtDate(t) { var p = nbaEtParts(t); return p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d; }
function nbaIso(t) { return new Date(t).toISOString().replace(/\.000Z$/, 'Z'); }

/* ---------------------------------------------------------------- the official report: finding it */
var NBA_REPORT_BASE = 'https://ak-static.cms.nba.com/referee/injury/';
var NBA_REPORT_FILE_RE = /Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{1,2})(?:_(\d{2}))?(AM|PM)\.pdf/i;
/** a report's publication time from its file name (Eastern), or null */
function nbaReportTimeFromName(url) {
  var m = NBA_REPORT_FILE_RE.exec(String(url || ''));
  if (!m) return null;
  var h = (+m[4]) % 12 + (m[6].toUpperCase() === 'PM' ? 12 : 0);
  return nbaEtToUtc(+m[1], +m[2], +m[3], h, m[5] ? +m[5] : 0);
}
/** every report PDF linked from the league's season page, newest first */
function nbaFindReportLinks(html, base) {
  var seen = {}, out = [], re = /href\s*=\s*["']([^"']*Injury-Report_[^"']*\.pdf)["']/gi, m;
  while ((m = re.exec(String(html || ''))) !== null) {
    var u = m[1];
    try { u = new URL(u, base || NBA_REPORT_BASE).toString(); } catch (_) { continue; }
    var t = nbaReportTimeFromName(u);
    if (t == null || seen[u]) continue;
    seen[u] = 1; out.push({ url: u, published_ms: t });
  }
  return out.sort(function (a, b) { return b.published_ms - a.published_ms; });
}
/** file names the league uses, newest first, for the last `hours` (the fallback when the season page cannot be read) */
function nbaReportCandidates(nowMs, hours) {
  var out = [], step = 15 * 60000, start = Math.floor(nowMs / step) * step;
  for (var t = start; t > nowMs - (hours || 8) * 3600e3; t -= step) {
    var p = nbaEtParts(t), h12 = p.h % 12 === 0 ? 12 : p.h % 12, ap = p.h < 12 ? 'AM' : 'PM';
    var day = p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d, hh = (h12 < 10 ? '0' : '') + h12, mm = (p.mi < 10 ? '0' : '') + p.mi;
    out.push({ url: NBA_REPORT_BASE + 'Injury-Report_' + day + '_' + hh + '_' + mm + ap + '.pdf', published_ms: t });
    if (p.mi === 0) out.push({ url: NBA_REPORT_BASE + 'Injury-Report_' + day + '_' + hh + ap + '.pdf', published_ms: t });
  }
  return out;
}
function nbaSeasonPageUrl(nowMs) {
  var p = nbaEtParts(nowMs), y = p.mo >= 8 ? p.y : p.y - 1;
  return 'https://official.nba.com/nba-injury-report-' + y + '-' + String(y + 1).slice(2) + '-season/';
}

/* ---------------------------------------------------------------- the official report: reading it */
/** pdf.js text items -> reading-order lines (by y, then x), as the circa core reads its PDF */
function nbaLinesFromItems(items, tol) {
  tol = tol == null ? 2 : tol;
  var rows = [];
  (items || []).forEach(function (it) {
    if (!it || typeof it.str !== 'string' || !it.str.trim() || !it.transform) return;
    var x = +it.transform[4], y = +it.transform[5], row = null;
    for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - y) <= tol) { row = rows[i]; break; }
    if (!row) { row = { y: y, parts: [] }; rows.push(row); }
    row.parts.push({ x: x, s: it.str });
  });
  rows.sort(function (a, b) { return b.y - a.y; });
  return rows.map(function (r) { r.parts.sort(function (a, b) { return a.x - b.x; }); return r.parts.map(function (p) { return p.s.trim(); }).join(' ').replace(/\s+/g, ' ').trim(); });
}
var NBA_STATUS_OFFICIAL = { out: 'OUT', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE', probable: 'PROBABLE', available: 'AVAILABLE' };
var NBA_PLAYER_RE = /^(.+?,\s*\S.*?)\s+(Out|Doubtful|Questionable|Probable|Available)(?:\s+(.*))?$/;
/**
 * The official report's lines -> rows. The table's columns are Game Date,
 * Game Time, Matchup, Team, Player Name, Current Status, Reason; a column is
 * printed only where its value changes, so each is carried down. A team that
 * has not filed reads "NOT YET SUBMITTED". A line that is none of these and
 * follows a player is the wrapped end of his reason. Anything else is UNREAD,
 * returned, never guessed at.
 */
function nbaParseOfficialLines(lines, meta) {
  var out = { published_ms: null, rows: [], not_submitted: [], matchups: [], unread: [], header_seen: false };
  var cur = { date: null, time: null, matchup: null, team: null }, last = null, orphan = [];
  var seenMatch = {};
  function noteMatchup() {
    if (!cur.date || !cur.matchup) return;
    var k = cur.date + '|' + cur.matchup;
    if (seenMatch[k]) return;
    seenMatch[k] = 1;
    var ab = cur.matchup.split('@'), a = nbaTeam(ab[0]), h = nbaTeam(ab[1]);
    out.matchups.push({ game_date: cur.date, game_time_et: cur.time, matchup: cur.matchup, away_id: a ? a.id : null, home_id: h ? h.id : null });
  }
  (lines || []).forEach(function (raw) {
    var s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return;
    var hm = /Injury Report:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s);
    if (hm) { var yy = +hm[3] < 100 ? 2000 + +hm[3] : +hm[3]; out.published_ms = nbaEtToUtc(yy, +hm[1], +hm[2], (+hm[4]) % 12 + (hm[6].toUpperCase() === 'PM' ? 12 : 0), +hm[5]); return; }
    if (/^Page \d+ of \d+$/i.test(s)) return;
    if (/Game Date/i.test(s) && /Player Name/i.test(s)) { out.header_seen = true; return; }
    var m, prefix = false;
    if ((m = /^(\d{2})\/(\d{2})\/(\d{4})\s*/.exec(s))) { cur.date = m[3] + '-' + m[1] + '-' + m[2]; cur.time = null; cur.matchup = null; cur.team = null; s = s.slice(m[0].length); prefix = true; }
    if ((m = /^(\d{1,2}):(\d{2})\s*\(ET\)\s*/i.exec(s))) { cur.time = (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2]; cur.matchup = null; cur.team = null; s = s.slice(m[0].length); prefix = true; }
    if ((m = /^([A-Z]{2,4})\s*@\s*([A-Z]{2,4})\b\s*/.exec(s))) { cur.matchup = m[1] + '@' + m[2]; cur.team = null; s = s.slice(m[0].length); prefix = true; noteMatchup(); }
    for (var i = 0; i < NBA_TEAM_NAMES.length; i++) {
      var n = NBA_TEAM_NAMES[i].name;
      if (s.slice(0, n.length).toUpperCase() === n.toUpperCase() && (s.length === n.length || s.charAt(n.length) === ' ')) { cur.team = NBA_TEAM_NAMES[i].id; s = s.slice(n.length).trim(); prefix = true; break; }
    }
    if (!s) return;
    var ctx = { game_date: cur.date, game_time_et: cur.time, matchup: cur.matchup, team_id: cur.team };
    if (/^NOT YET SUBMITTED$/i.test(s)) {
      if (cur.team && cur.matchup) out.not_submitted.push(ctx); else out.unread.push(raw);
      last = null; return;
    }
    var pm = NBA_PLAYER_RE.exec(s);
    if (pm && cur.team && cur.matchup && cur.date) {
      var row = { game_date: ctx.game_date, game_time_et: ctx.game_time_et, matchup: ctx.matchup, team_id: ctx.team_id,
        player_raw: pm[1].trim(), player_name: nbaDisplayName(pm[1]), status: NBA_STATUS_OFFICIAL[pm[2].toLowerCase()], source_status: pm[2], reason: (pm[3] || '').trim() };
      /* a vertically centred reason can print its first line above the row */
      if (!row.reason && orphan.length) { row.reason = orphan.join(' '); orphan = []; }
      else if (orphan.length && last) { last.reason = (last.reason + ' ' + orphan.join(' ')).trim(); orphan = []; }
      out.rows.push(row); last = row; return;
    }
    if (!prefix && !/(Out|Doubtful|Questionable|Probable|Available)\b/.test(s) && s.length <= 120 && (last || out.rows.length)) { orphan.push(s); return; }
    out.unread.push(raw);
  });
  if (orphan.length) { if (last) last.reason = (last.reason + ' ' + orphan.join(' ')).trim(); else orphan.forEach(function (x) { out.unread.push(x); }); }
  if (out.published_ms == null && meta && meta.url) out.published_ms = nbaReportTimeFromName(meta.url);
  return out;
}

/* ---------------------------------------------------------------- the ESPN feeds (fallback statuses, rosters) */
var NBA_STATUS_ESPN = { out: 'OUT', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE', probable: 'PROBABLE', available: 'AVAILABLE', active: 'AVAILABLE' };
function nbaEspnId(a) {
  if (!a) return null;
  if (a.id != null && /^\d+$/.test(String(a.id))) return String(a.id);
  var links = a.links || [];
  for (var i = 0; i < links.length; i++) { var m = /\/id\/(\d+)/.exec(String(links[i] && links[i].href || '')); if (m) return m[1]; }
  var u = /\/athletes\/(\d+)/.exec(String(a.$ref || a.uid || ''));
  return u ? u[1] : null;
}
/** ESPN's league injuries JSON -> rows (a status with no official equivalent, e.g. Day-To-Day, is UNKNOWN; the source's own word is kept) */
function nbaParseEspnInjuries(json) {
  var out = { rows: [], teams: [], unread: [] };
  ((json && json.injuries) || []).forEach(function (t) {
    var team = nbaTeam(t && (t.id || (t.team && t.team.id) || t.abbreviation));
    if (!team) { out.unread.push(t && t.displayName); return; }
    out.teams.push(team.id);
    (t.injuries || []).forEach(function (x) {
      var a = x.athlete || {}, raw = String(x.status || (x.type && x.type.description) || '').trim();
      if (!a.displayName && !a.fullName) { out.unread.push(raw); return; }
      var d = x.details || {}, why = [d.side && d.side !== 'Not Specified' ? d.side : null, d.location, d.type, d.detail].filter(Boolean).join(' ');
      out.rows.push({ team_id: team.id, player_id: nbaEspnId(a), player_name: a.displayName || a.fullName, status: NBA_STATUS_ESPN[raw.toLowerCase()] || 'UNKNOWN', source_status: raw,
        reason: why || x.shortComment || '', source_date: x.date || null });
    });
  });
  return out;
}
/** ESPN's team roster JSON -> players (flat list, or grouped by position) */
function nbaParseEspnRoster(json, teamId) {
  var list = [];
  ((json && json.athletes) || []).forEach(function (a) { if (a && Array.isArray(a.items)) list = list.concat(a.items); else if (a) list.push(a); });
  var players = [];
  list.forEach(function (a) {
    var id = nbaEspnId(a), name = a.displayName || a.fullName;
    if (!id || !name) return;
    var st = a.status || {}, raw = String(st.name || st.type || '').trim(), k = raw.toLowerCase().replace(/[^a-z]/g, '');
    players.push({ player_id: id, player_name: name, position: a.position && (a.position.abbreviation || a.position.name) || null, jersey: a.jersey != null ? String(a.jersey) : null,
      roster_status: k === 'active' ? 'ACTIVE' : k === 'twoway' ? 'TWO_WAY' : k === 'suspended' ? 'SUSPENDED' : k === 'inactive' ? 'INACTIVE' : (raw ? 'OTHER' : 'ACTIVE'), source_status: raw || null });
  });
  players.sort(function (a, b) { return a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0; });
  return { team_id: String(teamId), players: players };
}

/* ---------------------------------------------------------------- names */
/** "White, Coby" -> "Coby White"; "Porter Jr., Michael" -> "Michael Porter Jr." */
function nbaDisplayName(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  var m = /^([^,]+),\s*(.+)$/.exec(s);
  return m ? (m[2] + ' ' + m[1]).trim() : s;
}
/* official spelling -> the spelling ESPN's roster uses, where they differ (keys as nbaNameKey makes them) */
var NBA_NAME_ALIASES = { 'nicolas claxton': 'nic claxton', 'herbert jones': 'herb jones', 'cameron thomas': 'cam thomas', 'kenyon martin': 'kj martin', 'moe wagner': 'moritz wagner', 'alex sarr': 'alexandre sarr' };
function nbaNameKey(s) {
  s = nbaDisplayName(s);
  if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/[’'`.]/g, '').replace(/[-‐–—]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return NBA_NAME_ALIASES[s] || s;
}
/** rosters: { teamId: [{ player_id, player_name }] } -> an index the matcher reads */
function nbaNameIndex(rosters) {
  var idx = { byTeam: {}, byKey: {} };
  Object.keys(rosters || {}).forEach(function (t) {
    idx.byTeam[t] = (rosters[t] || []).map(function (p) {
      var k = nbaNameKey(p.player_name), parts = k.split(' ');
      var e = { id: String(p.player_id), team: t, key: k, last: parts.slice(1).join(' '), first: parts[0] || '' };
      (idx.byKey[k] = idx.byKey[k] || []).push(e);
      return e;
    });
  });
  return idx;
}
/**
 * One published name -> an ESPN player id. In order: exact on the team's
 * roster; same surname and first initial, unique on the team's roster; exact
 * and unique anywhere in the league (reported as a team mismatch: the report
 * and the roster disagree). Otherwise UNMATCHED, never a nearest guess.
 */
function nbaMatchPlayer(name, teamId, idx) {
  var k = nbaNameKey(name), parts = k.split(' '), first = parts[0] || '', last = parts.slice(1).join(' ');
  var team = (idx.byTeam[String(teamId)] || []);
  var ex = team.filter(function (p) { return p.key === k; });
  if (ex.length === 1) return { player_id: ex[0].id, method: 'team_exact', team_id: String(teamId) };
  var ini = team.filter(function (p) { return p.last === last && last && p.first.charAt(0) === first.charAt(0); });
  if (!ex.length && ini.length === 1) return { player_id: ini[0].id, method: 'team_initial', team_id: String(teamId) };
  var lg = idx.byKey[k] || [];
  if (lg.length === 1) return { player_id: lg[0].id, method: 'league_exact', team_id: lg[0].team, team_mismatch: lg[0].team !== String(teamId) };
  return { player_id: null, method: ex.length > 1 || lg.length > 1 ? 'ambiguous' : 'unmatched', team_id: String(teamId) };
}

/* ---------------------------------------------------------------- games */
/** a report row's (Eastern date, matchup) -> the slate game; games: [{ game_id, start_utc, home: {id}, away: {id} }] */
function nbaResolveGame(row, games) {
  var ab = String(row.matchup || '').split('@'), a = nbaTeam(ab[0]), h = nbaTeam(ab[1]);
  if (!a || !h || !row.game_date) return null;
  for (var i = 0; i < (games || []).length; i++) {
    var g = games[i], t = Date.parse(g.start_utc);
    if (String(g.home.id) === h.id && String(g.away.id) === a.id && isFinite(t) && nbaEtDate(t) === row.game_date) return g;
  }
  return null;
}
/** a team's next game on the slate within `hours` (the ESPN fallback carries no game) */
function nbaNextGame(teamId, games, nowMs, hours) {
  var best = null;
  (games || []).forEach(function (g) {
    var t = Date.parse(g.start_utc);
    if (!isFinite(t) || t <= nowMs || t > nowMs + (hours || 36) * 3600e3) return;
    if (String(g.home.id) !== String(teamId) && String(g.away.id) !== String(teamId)) return;
    if (!best || t < Date.parse(best.start_utc)) best = g;
  });
  return best;
}

/* ---------------------------------------------------------------- T2: minutes */
/** a player's expected minutes when available: his EWM minutes beside the preseason prior, fading as the season accrues */
function nbaExpectedMinutes(pl, model) {
  var c = (model || NBA_ROSTER_MODEL).minutes;
  if (!pl) return { e: c.rookie_minutes, basis: 'default' };
  var hasM = pl.ewm_minutes != null && isFinite(pl.ewm_minutes) && (pl.games || 0) > 0;
  var pre = (pl.preseason_games || 0) > 0 && pl.preseason_minutes != null && isFinite(pl.preseason_minutes);
  var w = pre ? Math.min(pl.preseason_games, c.preseason_weight_games) * Math.max(0, 1 - (pl.season_games || 0) / c.preseason_fade_games) : 0;
  if (hasM && w > 0) return { e: (c.ewm_weight_games * pl.ewm_minutes + w * pl.preseason_minutes) / (c.ewm_weight_games + w), basis: 'ewm+preseason' };
  if (hasM) return { e: pl.ewm_minutes, basis: 'ewm' };
  if (pre) return { e: pl.preseason_minutes, basis: 'preseason' };
  return { e: c.rookie_minutes, basis: 'default' };
}
/** scale to the team's minutes with a per-player cap, the excess redistributed — PlayerModel.strength's own loop */
function nbaScaleMinutes(list, c) {
  var out = {}, tot = 0;
  list.forEach(function (x) { tot += x.e; });
  if (!list.length || tot <= 0) return out;
  var scale = c.team_minutes / tot;
  for (var iter = 0; iter < 5; iter++) {
    var capped = 0, free = 0;
    list.forEach(function (x) { var v = x.e * scale; if (v > c.max_minutes) capped += c.max_minutes; else free += v; });
    if (capped + free >= c.team_minutes - 0.5 && capped + free <= c.team_minutes + 0.5) break;
    var freeBase = 0;
    list.forEach(function (x) { if (x.e * scale <= c.max_minutes) freeBase += x.e; });
    if (freeBase <= 0) break;
    scale = (c.team_minutes - capped) / freeBase;
  }
  list.forEach(function (x) { out[x.id] = Math.min(c.max_minutes, x.e * scale); });
  return out;
}
/** THE DEPTH CHART: the available players by expected minutes; the rotation is
    the shortest top of it that covers the team's minutes, scaled to them. A
    player who is out opens his minutes to the next man down. */
function nbaRotationMinutes(avail, c) {
  var s = avail.filter(function (x) { return x.e > 0; }).sort(function (a, b) { return b.e - a.e || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  var rot = [], sum = 0;
  for (var i = 0; i < s.length && sum < c.team_minutes; i++) { rot.push(s[i]); sum += s[i].e; }
  return nbaScaleMinutes(rot, c);
}
/** expected minutes over every availability scenario (players [{ id, e, p }]; independent; exact) */
function nbaExpectedAllocation(players, c) {
  var sure = players.filter(function (p) { return p.p >= 1; }), unc = players.filter(function (p) { return p.p > 0 && p.p < 1; });
  if (unc.length > c.max_uncertain) return null;
  var acc = {};
  players.forEach(function (p) { acc[p.id] = 0; });
  for (var mask = 0; mask < (1 << unc.length); mask++) {
    var w = 1, avail = sure.slice();
    for (var k = 0; k < unc.length; k++) { if (mask & (1 << k)) { w *= unc[k].p; avail.push(unc[k]); } else w *= 1 - unc[k].p; }
    if (w <= 0) continue;
    var m = nbaRotationMinutes(avail, c);
    for (var id in m) acc[id] += w * m[id];
  }
  return acc;
}
function nbaSdOf(rule, mu) { return typeof rule === 'number' ? rule : Math.max(6, rule.s0 + rule.s1 * Math.min(Math.abs(mu), 10)); }

/* ---------------------------------------------------------------- T3: the roster-adjusted projection */
function nbaR2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function nbaR4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e4) / 1e4; }
function nbaSummary(DIST, shape, mu_m, mu_t) {
  var p = { mu_m: mu_m, sd_m: nbaSdOf(shape.sd_rule, mu_m), mu_t: mu_t, sd_t: shape.sd_t, theta: shape.theta, gamma: shape.gamma, ot: shape.ot, half: shape.half, quarter: shape.quarter };
  var pr = DIST.price(p, { joint: false });
  return { mu_m: nbaR4(mu_m), mu_t: nbaR4(mu_t), p_home: pr.moneyline.home, fair_spread_home: pr.spread.fair_line_home, fair_total: pr.total.fair_line,
    expected: { home: pr.expected.home, away: pr.expected.away, margin: pr.expected.margin, total: pr.expected.total }, margin_interval_80: pr.margin_interval_80, moneyline_american: { home: pr.moneyline.home_american, away: pr.moneyline.away_american } };
}
var NBA_STATUS_WORD = { OUT: 'OUT', DOUBTFUL: 'DOUBTFUL', QUESTIONABLE: 'QUESTIONABLE', PROBABLE: 'PROBABLE', UNKNOWN: 'status not an official designation' };
function nbaSigned(v) { var r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '±') + Math.abs(r).toFixed(1); }

/**
 * Price one game with current rosters and the injury report.
 *
 * input = {
 *   game:        one nba/roster_inputs.json game (baseline and neutral means,
 *                pace, each team's reference rotation)
 *   shape:       nba/roster_inputs.json shape (the chosen model's distribution
 *                parameters, the same for every game)
 *   players:     nba/roster_inputs.json players (impact and minutes by ESPN id)
 *   rosters:     { home: [player_id], away: [player_id] }  the latest capture
 *   roster_meta: { home: { capture_id, captured_at, source }, away: {...} }
 *   statuses:    { home: [row], away: [row] }  this game's report rows, each
 *                { id, player_id, player_name, status, source_status, match_method, team_mismatch }
 *   report:      { id, source, published_at, on_report, not_submitted: { home, away } }
 *   team_of:     { player_id: team_id } every current roster (names a departed player's new team)
 *   slate_generated_at
 * }
 * Returns { status: 'OK' | 'WITHHELD', reasons, baseline, adjusted, delta,
 * adjustments, roster_changes, minutes }. A WITHHELD game carries no adjusted
 * number — only why, and the roster facts.
 */
function nbaRosterAdjust(input, DIST, model) {
  model = model || NBA_ROSTER_MODEL;
  var c = model.minutes, g = input.game, P = input.players || {}, reasons = [];
  var sides = { home: g.home, away: g.away }, pace = g.pace;
  var team = function (k) { return sides[k].abbr; };
  var out = { status: 'OK', reasons: reasons, model: { key: model.key, version: model.version }, baseline: null, neutral: null, adjusted: null, delta: null, adjustments: [], roster_changes: { home: null, away: null }, minutes: { home: [], away: [] } };
  var stat = input.statuses || { home: [], away: [] }, rep = input.report || {};

  if (!rep.id) reasons.push('no injury report');
  else if (!rep.on_report) reasons.push('this game is not on the latest injury report');
  ['home', 'away'].forEach(function (k) {
    if (rep.not_submitted && rep.not_submitted[k]) reasons.push(team(k) + ' has not submitted its injury report');
    if (!input.rosters || !input.rosters[k] || !input.rosters[k].length) reasons.push('no current roster on file for ' + team(k));
    (stat[k] || []).forEach(function (r) {
      if (r.status === 'AVAILABLE') return;
      if (!r.player_id) reasons.push(team(k) + ': ' + r.player_name + ' (' + r.status + ') could not be matched to a player');
      else if (r.team_mismatch) reasons.push(team(k) + ': the report lists ' + r.player_name + ' but the roster capture has him elsewhere');
    });
  });

  var imp = function (id) { var p = P[id]; return p && p.o != null && p.d != null ? { o: p.o, d: p.d, known: p.known !== false } : { o: model.impact.prior_o, d: model.impact.prior_d, known: false }; };
  var nm = function (id, fallback) { return (P[id] && P[id].name) || fallback || id; };
  var perMin = function (id) { var v = imp(id); return { m: (v.o + v.d) / 48 * pace / 100 * model.rating_coefficient, t: (v.o - v.d) / 48 * pace / 100 * model.rating_coefficient }; };

  /* the roster facts first: they are observations and stand even when the number is withheld */
  var teamState = {};
  ['home', 'away'].forEach(function (k) {
    var roster = (input.rosters && input.rosters[k]) || [], inRoster = {};
    roster.forEach(function (id) { inRoster[id] = 1; });
    var ref = (g.reference && g.reference[k]) || [], inRef = {};
    ref.forEach(function (r) { inRef[r.id] = r; });
    var R = nbaRotationMinutes(ref.map(function (r) { return { id: r.id, e: r.minutes }; }), c);
    var departed = ref.filter(function (r) { return !inRoster[r.id] && (R[r.id] || 0) > 0; }).map(function (r) {
      var now = input.team_of ? input.team_of[r.id] : null, nt = now ? nbaTeam(now) : null;
      return { player_id: r.id, player_name: nm(r.id, r.name), reference_minutes: nbaR2(R[r.id]), now_with: nt ? nt.abbr : null };
    }).sort(function (a, b) { return b.reference_minutes - a.reference_minutes; });
    var E = {};
    roster.forEach(function (id) { E[id] = nbaExpectedMinutes(P[id], model); });
    var arrived = roster.filter(function (id) { return !inRef[id]; }).map(function (id) {
      var last = P[id] && P[id].team_id ? nbaTeam(P[id].team_id) : null;
      return { player_id: id, player_name: nm(id), expected_minutes: nbaR2(E[id].e), from: last && last.id !== String(sides[k].id) ? last.abbr : null, minutes_basis: E[id].basis };
    }).sort(function (a, b) { return b.expected_minutes - a.expected_minutes; });
    out.roster_changes[k] = { team: team(k), capture: input.roster_meta ? input.roster_meta[k] || null : null, departed: departed, arrived: arrived };
    teamState[k] = { roster: roster, R: R, E: E, inRef: inRef };
  });

  /* the baseline as published, and the baseline with its availability features reset */
  out.baseline = nbaSummary(DIST, input.shape, g.baseline.mu_m, g.baseline.mu_t);
  out.neutral = nbaSummary(DIST, input.shape, g.neutral.mu_m, g.neutral.mu_t);
  if (reasons.length) { out.status = 'WITHHELD'; return out; }

  var shift = { m: 0, t: 0 }, lines = [];
  var push = function (l) { lines.push(l); };
  /* stage 0: the baseline priced each team's last game; the reset prices its full rotation */
  var d0m = g.neutral.mu_m - g.baseline.mu_m, d0t = g.neutral.mu_t - g.baseline.mu_t;
  push({ stage: 'baseline_reset', kind: 'availability_reset', team: d0m >= 0 ? team('home') : team('away'), player_id: null, player_name: null,
    margin_home: nbaR4(d0m), total: nbaR4(d0t),
    text:'Baseline availability reset (each team’s last game → its full rotation): ' + nbaSigned(Math.abs(d0m)) + ' pts ' + (d0m >= 0 ? team('home') : team('away')),
    evidence: { source: 'nba/roster_inputs.json', slate_generated_at: input.slate_generated_at || null } });

  ['home', 'away'].forEach(function (k) {
    var S = teamState[k], sgn = k === 'home' ? 1 : -1, T = team(k), meta = input.roster_meta && input.roster_meta[k];
    var players = S.roster.map(function (id) { return { id: id, e: S.E[id].e, p: 1 }; });
    var H = nbaRotationMinutes(players, c);
    /* stage 1: the current roster, everyone available, against the reference rotation */
    var rc = out.roster_changes[k];
    rc.departed.forEach(function (d) {
      var pm = perMin(d.player_id), mins = S.R[d.player_id] || 0;
      push({ stage: 'roster', kind: 'departed', team: T, player_id: d.player_id, player_name: d.player_name, minutes: nbaR2(-mins), margin_home: nbaR4(-mins * pm.m * sgn), total: nbaR4(-mins * pm.t),
        text: d.player_name + ' no longer on ' + T + '’s roster' + (d.now_with ? ' (now ' + d.now_with + ')' : '') + ': ' + nbaSigned(-mins * pm.m) + ' pts ' + T,
        evidence: { roster_capture_id: meta ? meta.capture_id : null, roster_captured_at: meta ? meta.captured_at : null, roster_source: meta ? meta.source : null } });
    });
    var reshM = 0, reshT = 0;
    S.roster.forEach(function (id) {
      var pm = perMin(id), h = H[id] || 0;
      if (!S.inRef[id]) {
        if (h <= 0) return;
        var a = rc.arrived.filter(function (x) { return x.player_id === id; })[0];
        push({ stage: 'roster', kind: 'arrived', team: T, player_id: id, player_name: nm(id), minutes: nbaR2(h), margin_home: nbaR4(h * pm.m * sgn), total: nbaR4(h * pm.t), impact_known: imp(id).known,
          text: nm(id) + (a && a.from ? ' joined ' + T + ' (from ' + a.from + ')' : ' in ' + T + '’s rotation (not in the reference rotation)') + (imp(id).known ? '' : ', no NBA impact on file (prior)') + ': ' + nbaSigned(h * pm.m) + ' pts ' + T,
          evidence: { roster_capture_id: meta ? meta.capture_id : null, roster_captured_at: meta ? meta.captured_at : null, roster_source: meta ? meta.source : null, minutes_basis: S.E[id].basis } });
      } else { reshM += (h - (S.R[id] || 0)) * pm.m; reshT += (h - (S.R[id] || 0)) * pm.t; }
    });
    if (Math.abs(reshM) >= 0.005 || Math.abs(reshT) >= 0.005) push({ stage: 'roster', kind: 'rotation', team: T, player_id: null, player_name: null, margin_home: nbaR4(reshM * sgn), total: nbaR4(reshT),
      text: T + ' returning players’ minutes in the new rotation (expected minutes, preseason prior): ' + nbaSigned(reshM) + ' pts ' + T,
      evidence: { roster_capture_id: meta ? meta.capture_id : null, minutes: 'nbaExpectedMinutes' } });

    /* stage 2: the report's statuses, the expectation over every availability scenario */
    var prob = {}, rowOf = {};
    (stat[k] || []).forEach(function (r) { if (r.player_id && S.E[r.player_id] && model.play_probability[r.status] != null) { prob[r.player_id] = model.play_probability[r.status]; rowOf[r.player_id] = r; } });
    var withP = S.roster.map(function (id) { return { id: id, e: S.E[id].e, p: prob[id] != null ? prob[id] : 1 }; });
    var A = nbaExpectedAllocation(withP, c);
    if (!A) { reasons.push(T + ': more than ' + c.max_uncertain + ' players with an uncertain status'); return; }
    var J = Object.keys(prob).filter(function (id) { return prob[id] < 1; });
    var freed = {}, fTot = 0, gM = 0, gT = 0;
    J.forEach(function (id) { freed[id] = Math.max(0, (H[id] || 0) - (A[id] || 0)); fTot += freed[id]; });
    S.roster.forEach(function (id) { if (prob[id] != null && prob[id] < 1) return; var pm = perMin(id), d = (A[id] || 0) - (H[id] || 0); gM += d * pm.m; gT += d * pm.t; });
    var takers = S.roster.filter(function (id) { return !(prob[id] < 1); }).map(function (id) { return { id: id, d: (A[id] || 0) - (H[id] || 0) }; }).filter(function (x) { return x.d >= 0.5; }).sort(function (a, b) { return b.d - a.d; }).slice(0, 3);
    J.forEach(function (id) {
      var pm = perMin(id), own = ((A[id] || 0) - (H[id] || 0)), share = fTot > 0 ? freed[id] / fTot : 0, r = rowOf[id];
      var lm = own * pm.m + share * gM, lt = own * pm.t + share * gT, pPlay = prob[id];
      push({ stage: 'injury', kind: 'status', status: r.status, team: T, player_id: id, player_name: nm(id, r.player_name), minutes: nbaR2(own), play_probability: pPlay, margin_home: nbaR4(lm * sgn), total: nbaR4(lt),
        text: nm(id, r.player_name) + ' ' + (NBA_STATUS_WORD[r.status] || r.status) + (pPlay > 0 && pPlay < 1 ? ' (' + Math.round(pPlay * 100) + '% to play, registered)' : '') + ': ' + nbaSigned(lm) + ' pts ' + T
          + (freed[id] >= 0.5 && takers.length ? ' · ' + (Math.round(freed[id] * 10) / 10).toFixed(1) + ' expected minutes freed; ' + T + '’s freed minutes go mostly to ' + takers.map(function (x) { return nm(x.id); }).join(', ') : ''),
        evidence: { report_id: rep.id || null, report_row_id: r.id || null, report_source: rep.source || null, report_published_at: rep.published_at || null, source_status: r.source_status || null, match_method: r.match_method || null } });
    });
    /* nothing freed (every listed player was outside the rotation) yet teammates' minutes moved: keep the sum exact */
    if (fTot <= 0 && (Math.abs(gM) >= 0.005 || Math.abs(gT) >= 0.005)) push({ stage: 'injury', kind: 'redistribution', team: T, player_id: null, player_name: null, margin_home: nbaR4(gM * sgn), total: nbaR4(gT),
      text: T + ' minutes redistributed down the depth chart: ' + nbaSigned(gM) + ' pts ' + T, evidence: { report_id: rep.id || null } });
    out.minutes[k] = S.roster.map(function (id) { return { player_id: id, player_name: nm(id), reference: nbaR2(S.R[id] || 0), healthy: nbaR2(H[id] || 0), expected: nbaR2(A[id] || 0), status: rowOf[id] ? rowOf[id].status : null, basis: S.E[id].basis, impact_known: imp(id).known }; })
      .filter(function (x) { return x.reference > 0 || x.healthy > 0 || x.status; }).sort(function (a, b) { return b.expected - a.expected; });
  });
  if (reasons.length) { out.status = 'WITHHELD'; out.adjustments = []; return out; }
  lines.forEach(function (l) { shift.m += l.margin_home || 0; shift.t += l.total || 0; });
  /* the reset is already inside the neutral means; the rest shifts them */
  var mu_m = g.baseline.mu_m + shift.m, mu_t = g.baseline.mu_t + shift.t;
  if (Math.abs(mu_m - g.neutral.mu_m) > model.sanity.max_abs_margin_shift || Math.abs(mu_t - g.neutral.mu_t) > model.sanity.max_abs_total_shift) {
    out.status = 'WITHHELD'; reasons.push('the adjustment is outside the registered sanity bound (margin ' + nbaR2(mu_m - g.neutral.mu_m) + ', total ' + nbaR2(mu_t - g.neutral.mu_t) + ')');
    return out;
  }
  out.adjusted = nbaSummary(DIST, input.shape, mu_m, mu_t);
  out.adjustments = lines.filter(function (l) { return Math.abs(l.margin_home || 0) >= 0.005 || Math.abs(l.total || 0) >= 0.005 || l.kind === 'status'; });
  var b = out.baseline, a = out.adjusted;
  out.delta = { mu_m: nbaR4(mu_m - g.baseline.mu_m), mu_t: nbaR4(mu_t - g.baseline.mu_t), fair_spread_home: nbaR2(a.fair_spread_home - b.fair_spread_home), fair_total: nbaR2(a.fair_total - b.fair_total),
    p_home: nbaR4(a.p_home - b.p_home), exp_margin: nbaR2(a.expected.margin - b.expected.margin), exp_total: nbaR2(a.expected.total - b.expected.total) };
  return out;
}

/* ---------------------------------------------------------------- hashing and dedupe */
/** JSON with sorted keys (a content hash must not depend on key order) */
function nbaStable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(nbaStable).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + nbaStable(v[k]); }).join(',') + '}';
}
/** what makes two reports the same report: their rows and unfiled teams, not when they were fetched */
function nbaReportContent(rep) {
  var rows = (rep.rows || []).map(function (r) { return [r.game_date || '', r.matchup || '', r.team_id || '', nbaNameKey(r.player_name), r.status, r.reason || '']; })
    .sort(function (a, b) { var x = a.join('|'), y = b.join('|'); return x < y ? -1 : x > y ? 1 : 0; });
  var ns = (rep.not_submitted || []).map(function (r) { return [r.game_date || '', r.matchup || '', r.team_id || ''].join('|'); }).sort();
  var mu = (rep.matchups || []).map(function (r) { return [r.game_date || '', r.matchup || ''].join('|'); }).sort();
  return nbaStable({ rows: rows, not_submitted: ns, matchups: mu });
}
// ── END NBA INJURY CORE ───────────────────────────────────────────────────

const DIST = (globalThis as any).EDNBADist;
// deno-lint-ignore no-explicit-any
type Any = any;
const env = (k: string): string => ((globalThis as Any).Deno?.env.get(k) ?? "");
function deadline(ms: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(ms); } catch { return undefined; } }

/* ---------------------------------------------------------------- the database (PostgREST, service role) */
async function db(path: string, init?: RequestInit): Promise<Any> {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path, {
    ...init, signal: deadline(20000),
    headers: { apikey: key, authorization: "Bearer " + key, "content-type": "application/json", ...((init?.headers as Any) ?? {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error("db " + r.status + " " + path.split("?")[0] + ": " + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}
const insert = (table: string, rows: Any, ret = false) =>
  db(table, { method: "POST", body: JSON.stringify(rows), headers: { prefer: ret ? "return=representation" : "return=minimal" } });

async function sha256hex(s: string | Uint8Array): Promise<string> {
  const b = typeof s === "string" ? new TextEncoder().encode(s) : s;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function getResp(url: string, ms = 20000) {
  return await fetch(url, { headers: UA, redirect: "follow", signal: deadline(ms) });
}
async function getJson(url: string, ms = 20000) {
  const r = await getResp(url, ms);
  if (!r.ok) throw new Error(url + " answered HTTP " + r.status);
  return await r.json();
}

/* ---------------------------------------------------------------- the PDF (a hook, so Node tests can stand in for pdf.js) */
export const hooks: Any = {
  async pdfLines(bytes: Uint8Array): Promise<string[]> {
    const { getDocumentProxy } = await import(UNPDF);
    const pdf = await getDocumentProxy(bytes);
    const out: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      out.push(...nbaLinesFromItems(tc.items, 2));
    }
    return out;
  },
};
async function getPdf(url: string): Promise<Uint8Array | null> {
  const r = await getResp(url, 25000);
  if (!r.ok) return null;
  const b = new Uint8Array(await r.arrayBuffer());
  return b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? b : null; // %PDF
}

/* ---------------------------------------------------------------- the sources */
/** the league's newest readable report: the season page's links, then the file-name pattern */
export async function readOfficial(nowMs: number) {
  const tried: string[] = [];
  let links: Any[] = [];
  try {
    const page = nbaSeasonPageUrl(nowMs);
    const r = await getResp(page, 20000);
    if (r.ok) links = nbaFindReportLinks(await r.text(), page).filter((l: Any) => l.published_ms <= nowMs + 5 * 60000);
  } catch (_) { /* the pattern below is the fallback */ }
  const cands = links.length ? links.slice(0, 3) : nbaReportCandidates(nowMs, 8).slice(0, 40);
  for (const c of cands) {
    tried.push(c.url);
    let bytes: Uint8Array | null = null;
    try { bytes = await getPdf(c.url); } catch (_) { bytes = null; }
    if (!bytes) continue;
    let lines: string[];
    try { lines = await hooks.pdfLines(bytes); } catch (e) { return { ok: false, error: "the report PDF would not read: " + String((e as Error)?.message ?? e).slice(0, 200), url: c.url, tried }; }
    const parsed = nbaParseOfficialLines(lines, { url: c.url });
    if (!parsed.header_seen && !parsed.matchups.length) return { ok: false, error: "the report PDF read, but not as the league's table (layout drift)", url: c.url, tried, parsed, drift: true };
    return { ok: true, url: c.url, published_ms: parsed.published_ms ?? c.published_ms, parsed, pdf_sha256: await sha256hex(bytes), tried, via: links.length ? "season_page" : "file_pattern" };
  }
  return { ok: false, error: links.length ? "the newest reports linked from the season page would not download" : "no report found (season page unreadable and no file at the published pattern in the last 8 hours)", tried };
}
export async function readEspnInjuries() {
  try {
    const parsed = nbaParseEspnInjuries(await getJson(ESPN + "/injuries", 20000));
    if (!parsed.teams.length) return { ok: false, error: "ESPN's injuries feed listed no team" };
    return { ok: true, parsed, url: ESPN + "/injuries" };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }; }
}
async function readRoster(teamId: string) {
  const url = ESPN + "/teams/" + teamId + "/roster";
  try {
    const r = nbaParseEspnRoster(await getJson(url, 15000), teamId);
    if (!r.players.length) return { ok: false, error: "an empty roster", url };
    return { ok: true, players: r.players, url };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160), url }; }
}

/* ---------------------------------------------------------------- when to run */
/** a game day runs from 9:00 AM Eastern to 30 minutes after the last tip; any other day once, from 9:00 AM */
export function windowFor(nowMs: number, inputs: Any, lastGood: Any) {
  const today = nbaEtDate(nowMs), p = nbaEtParts(nowMs);
  const open = nbaEtToUtc(p.y, p.mo, p.d, 9, 0);
  const tips = ((inputs && inputs.games) || []).map((g: Any) => Date.parse(g.start_utc)).filter((t: number) => isFinite(t) && nbaEtDate(t) === today);
  if (!inputs) return { et_date: today, game_day: null, run: true, reason: "the slate's roster inputs could not be read: every poke runs" };
  if (tips.length) {
    const close = Math.max(...tips) + 30 * 60000;
    if (nowMs < open) return { et_date: today, game_day: true, run: false, reason: "game day: the window opens at 9:00 AM Eastern" };
    if (nowMs > close) return { et_date: today, game_day: true, run: false, reason: "game day: the window closed 30 minutes after the last tip" };
    return { et_date: today, game_day: true, run: true, reason: "game day window", first_tip: Math.min(...tips), last_tip: Math.max(...tips) };
  }
  if (nowMs < open) return { et_date: today, game_day: false, run: false, reason: "no game today: the daily check runs from 9:00 AM Eastern" };
  if (lastGood && lastGood.et_date === today) return { et_date: today, game_day: false, run: false, reason: "no game today: already checked today" };
  return { et_date: today, game_day: false, run: true, reason: "no game today: the daily check" };
}

/* ---------------------------------------------------------------- one run */
export async function syncOnce(opts: Any = {}) {
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const dry = !!opts.dry, sim: string[] = Array.isArray(opts.simulate_outage) ? opts.simulate_outage.map(String) : [];
  const run: Any = { run_id: crypto.randomUUID(), build: BUILD, trigger: opts.trigger || "manual", status: "ok", started_at: new Date(nowMs).toISOString(), simulated: sim.length > 0, details: {} };
  const alerts: Any[] = [];
  const alert = (severity: string, code: string, message: string, detail?: Any) => alerts.push({ severity, code, message, detail: detail ?? null });
  const out: Any = { ok: true, build: BUILD, run_id: run.run_id, dry };
  try {
    /* 1 · the slate's roster inputs */
    let inputs: Any = null;
    try {
      inputs = await getJson(env("NBA_INPUTS_URL") || INPUTS_URL, 20000);
      if (!inputs || inputs.schema !== "edgedesk_nba_roster_inputs_v1" || !Array.isArray(inputs.games)) { alert("DRIFT", "inputs_schema", "nba/roster_inputs.json is not edgedesk_nba_roster_inputs_v1: no projection this run"); inputs = null; }
    } catch (e) { alert("DEGRADED", "inputs_unavailable", "the slate's roster inputs could not be read (" + String((e as Error)?.message ?? e).slice(0, 160) + "): statuses and rosters only, no projection"); }
    if (inputs && nowMs - Date.parse(inputs.generated_at) > 12 * 3600e3) alert("DEGRADED", "inputs_stale", "the slate's roster inputs were built " + Math.round((nowMs - Date.parse(inputs.generated_at)) / 3600e3) + " hours ago (the NBA build has not run)");
    run.inputs_generated_at = inputs ? inputs.generated_at : null;
    const games: Any[] = inputs ? inputs.games : [];

    /* 2 · the window */
    const lastGood = dry ? null : ((await db("nba_injury_sync_runs?select=et_date,finished_at&status=in.(ok,warn)&order=finished_at.desc&limit=1")) || [])[0] || null;
    const plan = windowFor(nowMs, inputs, lastGood);
    run.et_date = plan.et_date; run.game_day = plan.game_day;
    if (!plan.run && !opts.force) {
      run.status = "skipped"; run.skipped_reason = plan.reason;
      out.skipped = plan.reason;
      return out;
    }
    const todayIds = new Set<string>();
    for (const g of games) if (nbaEtDate(Date.parse(g.start_utc)) === plan.et_date) { todayIds.add(String(g.home.id)); todayIds.add(String(g.away.id)); }
    run.teams_playing = [...todayIds].map((id) => nbaTeam(id)?.abbr || id).sort();

    /* 3 · rosters */
    const latestCaps: Any[] = dry ? [] : ((await db("nba_roster_captures?select=id,team_id,content_hash,captured_at,source&order=captured_at.desc,id.desc&limit=300")) || []);
    const capOf: Record<string, Any> = {};
    for (const c of latestCaps) if (!capOf[c.team_id]) capOf[c.team_id] = c;
    const currentRows: Any[] = dry ? [] : ((await db("nba_roster_current?select=team_id,player_id,player_name,capture_id")) || []);
    const rosters: Record<string, Any[]> = {};
    for (const r of currentRows) (rosters[r.team_id] = rosters[r.team_id] || []).push({ player_id: r.player_id, player_name: r.player_name });
    const fresh: Any[] = [], failures: string[] = [];
    const teamIds = NBA_TEAMS.map((t: Any) => t[0]);
    for (let i = 0; i < teamIds.length; i += 6) {
      const batch = teamIds.slice(i, i + 6);
      const got = await Promise.all(batch.map((t: string) => sim.includes("rosters") ? Promise.resolve({ ok: false, error: "simulated outage" }) : readRoster(t)));
      batch.forEach((t: string, k: number) => {
        const g: Any = got[k], team = nbaTeam(t);
        let players: Any[] | null = null, source = "espn_roster", url = g.url || null;
        if (g.ok) players = g.players;
        else {
          failures.push(team.abbr);
          const prev = capOf[t], fb = inputs && inputs.rosters_fallback && inputs.rosters_fallback.teams ? inputs.rosters_fallback.teams[t] : null;
          if ((!prev || nowMs - Date.parse(prev.captured_at) > 24 * 3600e3) && fb && fb.length) {
            players = fb.map((p: Any) => ({ player_id: String(p.id), player_name: p.name || String(p.id), position: p.pos || null, jersey: null, roster_status: "ACTIVE", source_status: null }));
            source = "hoopr_rosters"; url = inputs.rosters_fallback.url;
          }
        }
        if (players) fresh.push({ team, players, source, url });
      });
    }
    run.rosters_checked = teamIds.length - failures.length; run.roster_failures = failures;
    if (failures.length) alert(failures.length >= 10 ? "DEGRADED" : "WARNING", "roster_fetch", "ESPN's roster could not be read for " + failures.join(", ") + (failures.length >= 10 ? "" : "; their last capture stands"), { teams: failures });
    let changed = 0;
    const newCaps: Any[] = [];
    for (const f of fresh) {
      const hash = await sha256hex(nbaStable(f.players.map((p: Any) => [p.player_id, p.player_name, p.roster_status])));
      const prev = capOf[f.team.id];
      if (prev && prev.content_hash === hash) continue;
      if (prev && rosters[f.team.id]) {
        const before = new Set(rosters[f.team.id].map((p: Any) => p.player_id)), after = new Set(f.players.map((p: Any) => p.player_id));
        const moved = [...before].filter((x) => !after.has(x)).length + [...after].filter((x) => !before.has(x)).length;
        if (moved > 8) alert("DRIFT", "roster_jump", f.team.abbr + "'s roster changed by " + moved + " players in one capture (" + f.source + "): check the source", { team: f.team.abbr, moved });
      }
      changed++;
      newCaps.push({ team: f.team, players: f.players, source: f.source, url: f.url, hash });
      rosters[f.team.id] = f.players.map((p: Any) => ({ player_id: p.player_id, player_name: p.player_name }));
    }
    run.rosters_changed = changed;
    if (!dry) for (const c of newCaps) {
      const at = new Date(nowMs).toISOString();
      const [cap] = await insert("nba_roster_captures", [{ team_id: c.team.id, team_abbr: c.team.abbr, source: c.source, source_url: c.url, captured_at: at, content_hash: c.hash, player_count: c.players.length, run_id: run.run_id }], true);
      await insert("nba_roster_snapshots", c.players.map((p: Any) => ({ capture_id: cap.id, team_id: c.team.id, team_abbr: c.team.abbr, player_id: p.player_id, player_name: p.player_name, position: p.position, jersey: p.jersey,
        roster_status: p.roster_status, source_status: p.source_status, source: c.source, captured_at: at })));
      capOf[c.team.id] = cap;
    }
    const teamOf: Record<string, string> = {};
    for (const t of Object.keys(rosters)) for (const p of rosters[t]) teamOf[p.player_id] = t;
    const idx = nbaNameIndex(rosters);

    /* 4 · the report: the league's, then the fallback */
    let rep: Any = null;
    const off = sim.includes("official") ? { ok: false, error: "simulated outage" } : await readOfficial(nowMs);
    run.official_ok = !!off.ok;
    if (off.ok) {
      rep = { source: "nba_official", url: off.url, published_ms: off.published_ms, rows: off.parsed.rows, matchups: off.parsed.matchups, not_submitted: off.parsed.not_submitted, unread: off.parsed.unread, pdf_sha256: off.pdf_sha256 };
      if (off.parsed.unread.length) alert("DRIFT", "report_unread_lines", off.parsed.unread.length + " line(s) of the league's report did not read as a row; they are kept with the report", { lines: off.parsed.unread.slice(0, 20), url: off.url });
    } else {
      alert(off.drift ? "DRIFT" : "DEGRADED", off.drift ? "report_layout" : "official_unavailable", "the league's injury report could not be read: " + off.error, { tried: (off.tried || []).slice(0, 6) });
      const espn = sim.includes("espn") ? { ok: false, error: "simulated outage" } : await readEspnInjuries();
      if (espn.ok) {
        run.fallback_used = true;
        const covered = games.filter((g: Any) => { const t = Date.parse(g.start_utc); return t > nowMs && t <= nowMs + 36 * 3600e3; });
        const rows: Any[] = [];
        for (const r of espn.parsed.rows) {
          const g = nbaNextGame(r.team_id, covered, nowMs, 36);
          rows.push(Object.assign({}, r, { game_date: g ? nbaEtDate(Date.parse(g.start_utc)) : null, matchup: g ? (g.away.abbr + "@" + g.home.abbr) : null, espn_game: g || null }));
        }
        rep = { source: "espn_injuries", url: espn.url, published_ms: null, rows, matchups: covered.map((g: Any) => ({ game_date: nbaEtDate(Date.parse(g.start_utc)), matchup: g.away.abbr + "@" + g.home.abbr, away_id: String(g.away.id), home_id: String(g.home.id) })), not_submitted: [], unread: espn.parsed.unread };
      } else {
        alert("FAILURE", "no_injury_source", "no injury report could be read: the league's (" + off.error + ") and ESPN's (" + espn.error + "); nothing is shown in their place");
        run.status = "error"; run.message = "the official report and the ESPN fallback both failed";
      }
    }

    let reportId: number | null = null;
    if (rep) {
      /* names and games */
      const unmatched: Any[] = [];
      const rows = rep.rows.map((r: Any) => {
        let m: Any;
        if (rep.source === "espn_injuries" && r.player_id) m = { player_id: r.player_id, method: "espn_id", team_id: r.team_id, team_mismatch: !!(teamOf[r.player_id] && teamOf[r.player_id] !== r.team_id) };
        else m = nbaMatchPlayer(r.player_name, r.team_id, idx);
        if (!m.player_id) unmatched.push(r.player_name + " (" + (nbaTeam(r.team_id)?.abbr || r.team_id) + ")");
        const g = rep.source === "espn_injuries" ? r.espn_game : nbaResolveGame(r, games);
        return { game_id: g ? String(g.game_id) : null, game_date: r.game_date || null, game_start_utc: g ? g.start_utc : null, matchup: r.matchup || null, team_id: String(r.team_id), team_abbr: nbaTeam(r.team_id)?.abbr || String(r.team_id),
          player_id: m.player_id, player_name: r.player_name, player_raw: r.player_raw || null, match_method: m.player_id ? m.method : (m.method === "ambiguous" ? "ambiguous" : "unmatched"), team_mismatch: !!m.team_mismatch,
          status: r.status, source_status: r.source_status || null, reason: r.reason || null };
      });
      const mismatches = rows.filter((r: Any) => r.team_mismatch);
      if (unmatched.length) alert("WARNING", "unmatched_names", unmatched.length + " name(s) on the report did not match a rostered player: " + unmatched.slice(0, 8).join(", ") + " (the games they affect are WITHHELD)", { names: unmatched });
      if (mismatches.length) alert("DRIFT", "team_mismatch", mismatches.length + " player(s) the report lists under a team the roster capture disagrees with: " + mismatches.slice(0, 6).map((r: Any) => r.player_name).join(", "), { players: mismatches.map((r: Any) => r.player_name) });
      const matchups = rep.matchups.map((m: Any) => {
        const g = (games || []).find((x: Any) => String(x.home.id) === String(m.home_id) && String(x.away.id) === String(m.away_id) && nbaEtDate(Date.parse(x.start_utc)) === m.game_date);
        return Object.assign({}, m, { game_id: g ? String(g.game_id) : null, game_start_utc: g ? g.start_utc : null });
      });
      const notSub = rep.not_submitted.map((n: Any) => {
        const ab = String(n.matchup || "").split("@"), a = nbaTeam(ab[0]), h = nbaTeam(ab[1]);
        const g = a && h ? (games || []).find((x: Any) => String(x.home.id) === h.id && String(x.away.id) === a.id && nbaEtDate(Date.parse(x.start_utc)) === n.game_date) : null;
        return { game_id: g ? String(g.game_id) : null, game_date: n.game_date, matchup: n.matchup, team_id: n.team_id, team_abbr: nbaTeam(n.team_id)?.abbr || n.team_id };
      });
      const onReport = new Set<string>();
      for (const m of matchups) { if (m.home_id) onReport.add(String(m.home_id)); if (m.away_id) onReport.add(String(m.away_id)); }
      run.teams_missing = rep.source === "nba_official" ? [...todayIds].filter((t) => !onReport.has(t)).map((t) => nbaTeam(t)?.abbr || t).sort() : [];
      run.teams_not_submitted = notSub.map((n: Any) => n.team_abbr);
      if (run.teams_missing.length && plan.game_day) alert("WARNING", "teams_missing", "teams playing today with no game on the latest report: " + run.teams_missing.join(", "), { teams: run.teams_missing });
      run.rows_read = rows.length; run.unmatched = unmatched.length; run.unread_lines = rep.unread.length;
      run.report_source = rep.source; run.report_url = rep.url; run.report_published_at = rep.published_ms ? new Date(rep.published_ms).toISOString() : null;

      /* dedupe: an identical consecutive report is the same report */
      const content = nbaReportContent({ rows: rows.map((r: Any) => Object.assign({}, r, { game_date: r.game_date })), not_submitted: notSub, matchups });
      const hash = await sha256hex(rep.source + "|" + content);
      const last = dry ? null : ((await db("nba_injury_reports?select=id,source,content_hash,report_published_at&order=captured_at.desc,id.desc&limit=1")) || [])[0];
      /* every status row's id, so each adjustment names the exact snapshot row it came from */
      const rowIds: Record<string, number> = {};
      const rkey = (r: Any) => [r.game_id || "", r.team_id, r.player_id || r.player_name, r.status].join("|");
      if (last && last.content_hash === hash && last.source === rep.source) {
        reportId = last.id; run.report_changed = false;
        for (const x of (await db("nba_injury_report_snapshots?select=id,game_id,team_id,player_id,player_name,status&report_id=eq." + reportId)) || []) rowIds[rkey(x)] = x.id;
      }
      else {
        run.report_changed = true;
        if (!dry) {
          const at = new Date(nowMs).toISOString();
          const [r0] = await insert("nba_injury_reports", [{ source: rep.source, source_url: rep.url, report_published_at: run.report_published_at, captured_at: at, content_hash: hash, parser_version: rep.source === "nba_official" ? PARSER_VERSION : "espn-injuries-1",
            rows_count: rows.length, unmatched: unmatched.length, unread_lines: rep.unread.length, matchups, not_submitted: notSub, unread: rep.unread.slice(0, 200), pdf_sha256: rep.pdf_sha256 || null, run_id: run.run_id }], true);
          reportId = r0.id;
          if (rows.length) for (const x of (await insert("nba_injury_report_snapshots", rows.map((r: Any) => Object.assign({}, r, { report_id: reportId, report_published_at: run.report_published_at, captured_at: at, source: rep.source })), true)) || []) rowIds[rkey(x)] = x.id;
        }
      }
      run.report_id = reportId;
      out.report = { source: rep.source, url: rep.url, published_at: run.report_published_at, rows: rows.length, unmatched: unmatched.length, changed: run.report_changed, id: reportId, matchups: matchups.length, not_submitted: run.teams_not_submitted };
      if (run.fallback_used) run.status = "warn";

      /* 5 · the Roster-Adjusted Projection */
      const cfg: Record<string, string> = {};
      for (const c of (dry ? [] : (await db("nba_injury_config?select=key,value")) || [])) cfg[c.key] = c.value;
      if (!inputs) { /* already alerted */ }
      else if (!dry && (!cfg.roster_model_version_ref || cfg.roster_model_key !== NBA_ROSTER_MODEL.key || cfg.roster_model_version !== NBA_ROSTER_MODEL.version)) {
        alert("FAILURE", "model_not_registered", "the Roster-Adjusted Projection " + NBA_ROSTER_MODEL.key + " v" + NBA_ROSTER_MODEL.version + " is not the registered version (" + (cfg.roster_model_version || "none") + "): no projection is stored (apply supabase/nba_roster_adjusted_registry.sql)");
      } else {
        const impactPlayers = inputs.players || {};
        const impactHash = await sha256hex(nbaStable(impactPlayers));
        let impactId: number | null = null;
        if (!dry) {
          const have = (await db("nba_player_impact_snapshots?select=id&content_hash=eq." + impactHash)) || [];
          if (have.length) impactId = have[0].id;
          else {
            const [im] = await insert("nba_player_impact_snapshots", [{ measure: inputs.impact?.measure || "edgedesk_rapm_v1", tier: inputs.impact?.tier || "T2", formula: inputs.impact?.formula || "nba/model/players.js",
              source_url: env("NBA_INPUTS_URL") || INPUTS_URL, inputs_generated_at: inputs.generated_at, content_hash: impactHash, player_count: Object.keys(impactPlayers).length,
              preseason_games: inputs.minutes?.preseason_games || 0, players: impactPlayers }], true);
            impactId = im.id;
          }
        }
        const lastProj: Record<string, Any> = {};
        if (!dry) for (const p of (await db("nba_adjusted_projection_current?select=game_id,inputs_hash")) || []) lastProj[p.game_id] = p;
        const covered = new Set(matchups.filter((m: Any) => m.game_id).map((m: Any) => m.game_id));
        const rowsByGame: Record<string, Any[]> = {};
        for (const r of rows) if (r.game_id) (rowsByGame[r.game_id] = rowsByGame[r.game_id] || []).push(r);
        let written = 0, withheld = 0, unchanged = 0;
        const shown: Any[] = [];
        for (const g of games) {
          const start = Date.parse(g.start_utc);
          if (!(start > nowMs) || !covered.has(String(g.game_id))) continue;
          const H = String(g.home.id), A = String(g.away.id), gr = rowsByGame[String(g.game_id)] || [];
          const st = (t: string) => gr.filter((r: Any) => r.team_id === t).map((r: Any) => ({ id: rowIds[rkey(r)] ?? null, player_id: r.player_id, player_name: r.player_name, status: r.status, source_status: r.source_status, match_method: r.match_method, team_mismatch: r.team_mismatch }));
          const ns = { home: notSub.some((n: Any) => n.game_id === String(g.game_id) && n.team_id === H), away: notSub.some((n: Any) => n.game_id === String(g.game_id) && n.team_id === A) };
          const meta = (t: string) => capOf[t] ? { capture_id: capOf[t].id, captured_at: capOf[t].captured_at, source: capOf[t].source } : null;
          const input = { game: g, shape: inputs.shape, players: impactPlayers, rosters: { home: (rosters[H] || []).map((p: Any) => p.player_id), away: (rosters[A] || []).map((p: Any) => p.player_id) },
            roster_meta: { home: meta(H), away: meta(A) }, statuses: { home: st(H), away: st(A) },
            report: { id: dry ? "dry-run" : reportId, source: rep.source, published_at: run.report_published_at, on_report: true, not_submitted: ns }, team_of: teamOf, slate_generated_at: inputs.slate_generated_at || inputs.generated_at };
          const res = nbaRosterAdjust(input, DIST, NBA_ROSTER_MODEL);
          const inputsHash = await sha256hex(nbaStable({ model: [NBA_ROSTER_MODEL.key, NBA_ROSTER_MODEL.version, NBA_INJURY_CORE_VERSION], report: reportId, caps: [meta(H)?.capture_id ?? null, meta(A)?.capture_id ?? null], impact: impactHash,
            slate: input.slate_generated_at, game: g.game_id, statuses: input.statuses, rosters: input.rosters, not_submitted: ns }));
          if (lastProj[String(g.game_id)] && lastProj[String(g.game_id)].inputs_hash === inputsHash) { unchanged++; continue; }
          const row = { game_id: String(g.game_id), game_start_utc: g.start_utc, home_id: H, away_id: A, home_abbr: g.home.abbr, away_abbr: g.away.abbr,
            model_key: NBA_ROSTER_MODEL.key, model_version: NBA_ROSTER_MODEL.version, model_version_ref: cfg.roster_model_version_ref || "dry-run", injury_report_id: reportId, report_source: rep.source,
            home_roster_capture_id: meta(H)?.capture_id ?? null, away_roster_capture_id: meta(A)?.capture_id ?? null, impact_snapshot_id: impactId, slate_generated_at: input.slate_generated_at,
            status: res.status, reasons: res.reasons, baseline: res.baseline, adjusted: res.adjusted, delta: res.delta, adjustments: res.adjustments, roster_changes: res.roster_changes, minutes: res.minutes,
            inputs_hash: inputsHash, core_version: NBA_INJURY_CORE_VERSION, run_id: run.run_id, computed_at: new Date(nowMs).toISOString() };
          if (!dry) await insert("nba_adjusted_projection_snapshots", [row]);
          if (res.status === "OK") written++; else withheld++;
          shown.push({ game_id: row.game_id, matchup: g.away.abbr + "@" + g.home.abbr, status: res.status, reasons: res.reasons, baseline_spread_home: res.baseline.fair_spread_home, adjusted_spread_home: res.adjusted ? res.adjusted.fair_spread_home : null });
        }
        run.projections_written = written; run.projections_withheld = withheld; run.projections_unchanged = unchanged;
        out.projections = { written, withheld, unchanged, games: dry ? shown : shown.slice(0, 20) };
      }
    }
    if (run.status === "ok" && alerts.some((a) => a.severity !== "WARNING" || a.code === "unmatched_names")) run.status = "warn";
    out.rosters = { checked: run.rosters_checked, changed: run.rosters_changed, failures };
  } catch (e) {
    run.status = "error"; run.message = "sync error: " + String((e as Error)?.message ?? e).slice(0, 300);
    alert("FAILURE", "sync_error", run.message);
  } finally {
    run.finished_at = new Date(Math.max(Date.now(), nowMs)).toISOString();
    if (run.status !== "skipped" && !run.message) run.message = alerts.filter((a) => a.severity !== "WARNING").map((a) => a.message).join("; ").slice(0, 600) || null;
    run.details = { alerts: alerts.map((a) => a.code), simulate_outage: sim.length ? sim : undefined };
    out.status = run.status; out.alerts = alerts; out.ok = run.status !== "error";
    if (!dry) {
      try {
        await insert("nba_injury_sync_runs", [run]);
        if (alerts.length) await insert("nba_injury_alerts", alerts.map((a) => Object.assign({ run_id: run.run_id }, a)));
      } catch (e) { out.ok = false; out.record_error = String((e as Error)?.message ?? e).slice(0, 300); }
    }
    console.log("NBA_INJURY_SYNC", JSON.stringify({ run_id: run.run_id, status: run.status, skipped: run.skipped_reason || null, report: out.report || null, projections: out.projections ? { written: out.projections.written, withheld: out.projections.withheld, unchanged: out.projections.unchanged } : null, alerts: alerts.map((a) => a.severity + ":" + a.code) }));
  }
  return out;
}

/* ---------------------------------------------------------------- the handler */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, core: NBA_INJURY_CORE_VERSION, model: { key: NBA_ROSTER_MODEL.key, version: NBA_ROSTER_MODEL.version, status: NBA_ROSTER_MODEL.status } });
  if (req.method !== "POST") return Response.json({ ok: false, error: "method" }, { status: 405 });
  const secret = env("NBA_INJURY_CRON_SECRET");
  if (!secret) return Response.json({ ok: false, error: "unauthorized", reason: "NBA_INJURY_CRON_SECRET is not set on this function" }, { status: 401 });
  if (!safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body: Any = await req.json().catch(() => ({}));
  const out = await syncOnce({ force: !!body.force, dry: !!body.dry, simulate_outage: body.simulate_outage, now: body.now, trigger: body.source === "supabase_cron" ? "cron" : "manual" });
  return Response.json(out, { status: out.ok ? 200 : 500 });
}
if (typeof (globalThis as Any).Deno !== "undefined" && (globalThis as Any).Deno.serve) (globalThis as Any).Deno.serve(handle);
