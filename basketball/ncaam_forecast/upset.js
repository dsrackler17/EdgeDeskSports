'use strict';
/* ===========================================================================
   UPSET WATCH: definitions, the frozen policy, and its evaluation.

   WHO IS THE UNDERDOG (one rule, its basis always shown, never mixed silently):
     1. 'market'  a valid synchronized pregame quote exists (captured within
                  max_quote_age_min before the forecast, both sides priced):
                  the side the market prices below 50%.
     2. 'seed'    an NCAA tournament game with VERIFIED seeds that differ:
                  the worse (numerically higher) seed.
     3. 'model'   otherwise: the side the model gives under 50%.
   Today no NCAAM quote is captured (the odds gateway does not carry it), so
   'market' never applies until quotes are logged; the code path is tested
   with synthetic quotes only.

   THREE SEPARATE SIGNALS (never one blended score):
     upset_probability   the calibrated probability that the underdog wins is
                         at least theta and below toss_up (0.45). theta is
                         chosen on the DEVELOPMENT window by a rule fixed
                         before looking (select()), then frozen in
                         config/upset_policy.json.
     market_disagreement |model - market| >= delta on a synchronized quote.
                         UNAVAILABLE without quotes; delta is fixed now so it
                         cannot be tuned to a later outcome.
     high_uncertainty    the regulation-margin sd is at least the development
                         window's 90th percentile, or either team has played
                         fewer than 5 games this season.
   A game whose underdog the MODEL favours (basis seed or market, model p >=
   0.5) is labelled model_favours_underdog: a disagreement, not an upset call.

   No boost exists for "March", momentum, conference reputation or being due.
   Matchup factors (factors.js) are shown as descriptive context; they move
   no probability unless a validated model change says so.
   =========================================================================== */

const TOSS_UP = 0.45;

function underdog(g, o) {
  o = o || {};
  const q = o.quote;
  if (q && q.valid && q.synchronized && Number.isFinite(q.p_home_fair)) {
    const home = q.p_home_fair < 0.5;
    return { side: home ? 'home' : 'away', basis: 'market', p_market: home ? q.p_home_fair : 1 - q.p_home_fair };
  }
  if (g.event === 'ncaa_tournament' && o.seeds_verified && Number.isFinite(g.home_seed) && Number.isFinite(g.away_seed) && g.home_seed !== g.away_seed) {
    return { side: g.home_seed > g.away_seed ? 'home' : 'away', basis: 'seed', p_market: null };
  }
  return { side: o.p_home < 0.5 ? 'home' : 'away', basis: 'model', p_market: null };
}

/** the signals for one game under a frozen policy */
function classify(g, fc, policy, o) {
  o = o || {};
  const u = underdog(g, { quote: o.quote, seeds_verified: o.seeds_verified, p_home: fc.p_home });
  const pDog = u.side === 'home' ? fc.p_home : 1 - fc.p_home;
  const out = { underdog: u.side, basis: u.basis, p_underdog: pDog, p_favorite: 1 - pDog, signals: [] };
  if (pDog >= 0.5) out.signals.push('model_favours_underdog');
  else if (pDog >= TOSS_UP) out.signals.push('toss_up');
  else if (pDog >= policy.signals.upset_probability.theta) out.signals.push('upset_probability');
  if (u.p_market != null) {
    out.p_market_underdog = u.p_market; out.disagreement = pDog - u.p_market;
    if (Math.abs(out.disagreement) >= policy.signals.market_disagreement.delta) out.signals.push('market_disagreement');
  }
  if ((fc.regulation && fc.regulation.sd >= policy.signals.high_uncertainty.sd_threshold) || Math.min(o.games_home == null ? 99 : o.games_home, o.games_away == null ? 99 : o.games_away) < policy.signals.high_uncertainty.min_games) out.signals.push('high_uncertainty');
  return out;
}

/** theta and the uncertainty threshold, from development rows only (the rule is fixed here) */
function select(devRows, o) {
  o = o || {};
  const dogs = devRows.map((r) => Math.min(r.s.p_home, 1 - r.s.p_home)).filter((p) => p < TOSS_UP).sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const theta = Math.round(q(dogs, o.flag_share == null ? 0.8 : 1 - o.flag_share) * 100) / 100;
  const sds = devRows.map((r) => r.s.reg_sd).sort((a, b) => a - b);
  return { theta, sd_threshold: Math.round(q(sds, 0.9) * 100) / 100, development_rows: devRows.length, clear_favourite_rows: dogs.length };
}

/** coverage and outcomes of the upset_probability signal on scored rows (model basis) */
function evaluate(rows, policy) {
  const flagged = []; let n = 0;
  for (const r of rows) {
    const pDog = Math.min(r.s.p_home, 1 - r.s.p_home); n++;
    if (pDog >= policy.signals.upset_probability.theta && pDog < TOSS_UP) flagged.push({ p: pDog, y: (r.s.p_home < 0.5 ? r.y.hw : 1 - r.y.hw) });
  }
  const k = flagged.reduce((a, x) => a + x.y, 0); const m = flagged.reduce((a, x) => a + x.p, 0);
  const w = flagged.length ? wilson(k, flagged.length) : [null, null];
  /* every game's underdog, for the base rate */
  const all = rows.map((r) => (r.s.p_home < 0.5 ? r.y.hw : 1 - r.y.hw));
  return { games: n, flagged: flagged.length, coverage: n ? +(flagged.length / n).toFixed(4) : null, realized_upset_rate: flagged.length ? +(k / flagged.length).toFixed(4) : null,
    realized_ci95: w.map((x) => (x == null ? null : +x.toFixed(4))), mean_forecast: flagged.length ? +(m / flagged.length).toFixed(4) : null, base_upset_rate_all_games: n ? +(all.reduce((a, b) => a + b, 0) / n).toFixed(4) : null };
}
function wilson(k, n) { const z = 1.959963984540054; const p = k / n; const den = 1 + z * z / n; const c = (p + z * z / (2 * n)) / den; const h = (z / den) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, c - h), Math.min(1, c + h)]; }

module.exports = { TOSS_UP, underdog, classify, select, evaluate, wilson };
