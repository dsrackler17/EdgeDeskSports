#!/usr/bin/env node
/* ============================================================================
   LEAVE ONE TERM OUT — does each term that moves EdgeDesk's college number
   earn its place on games it never saw, and is its weight right?

   THE QUESTION, TWICE.
     1  KEEP OR DROP. For every priced term, the shipped engine is compared
        with the same engine minus that term's contribution, game by game, on
        seasons the term was never fitted on. The term is the arm; the engine
        without it is the baseline; football/validation/promote.js — the
        repository's own promotion rules — decides. A term that the rules
        call REJECTED is making held-out predictions worse.
     2  THE WEIGHT. With everything else held at its shipped value, the
        multiplier k that best fits the result: margin = (engine − term) +
        k × term. k ≈ 1 means the weight is right, k ≈ 0 means the term
        carries no information, k < 0 means it points the wrong way. Its 95%
        interval is a game bootstrap.

   A SHADOW TERM is measured by the engine but kept out of the number
   (published as contribution shadow_points). It is tested the other way
   round: the arm is the shipped engine PLUS the term, the baseline the
   shipped engine, and the same rules decide whether it should go in.

   NO REFIT. Nothing here re-estimates a weight. Dropping a term without
   refitting the others is the question a reader of the line is asking ("is
   the +1.4 real?"); a refit is a different, later question.

   THE ROWS. football/cfb_p4/research/disagreement_replay.js: the shipped
   engine replayed cold and FROZEN WEEKLY (every game priced from the state at
   the Tuesday freeze before it, absorbing only games finished before then),
   with the stylistic matchup layer fed by the SAME efficiency adapter the
   board uses (football/rankings/engine_efficiency.js via disagreement_eff.js),
   the schedule index and conference strength live, and per-term
   contributions plus the matchup term by pairing on every row.

     node football/cfb_p4/research/disagreement_eff.js --data DIR 2014 ... 2025
     node football/cfb_p4/research/disagreement_replay.js --data DIR --from 2014 --to 2025 --replay-from 2007
     node football/cfb_p4/research/loto.js --rows DIR/out/disagreement_replay.jsonl [--live] [--write] [--boot 2000]
     node football/cfb_p4/research/loto.js --render-only

   --live adds the live slate's split of the matchup term into this season's
   data and last season's carried values (liveSplit below).
   --write writes football/validation/loto_cfb.json and docs/cfb-validation/LOTO.md.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const PROMOTE = require(path.join(ROOT, 'football', 'validation', 'promote.js'));
const OUT_JSON = path.join(ROOT, 'football', 'validation', 'loto_cfb.json');
const OUT_MD = path.join(ROOT, 'docs', 'cfb-validation', 'LOTO.md');

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}

/* ---------------------------------------------------------- the declaration
   Declared 2026-10-24, before the first run. The held-out window is the
   repository's own (2022-2025: no layer was tuned on it,
   params.validation_summary.market). Each term also names where it was fitted,
   so its in-sample record can be read beside its held-out one: a term that
   helps where it was fitted and not after is the signature of overfitting. */
const DECLARED = '2026-10-24';
const HOLDOUT = [2022, 2023, 2024, 2025];
const AFFECTED_PTS = 1;
/* a term that moves the number by less than this on average is reported, not graded */
const NEGLIGIBLE_PTS = 0.05;
const TERMS = [
  { key: 'matchup', label: 'Stylistic matchup', droppable: true, fit_window: [2014, 2019],
    fit: 'football/cfb_p4/research/train_p4.py fit_matchup on 2014-2019 residuals (B_TUNE_LO, B_TUNE_HI)' },
  { key: 'schedule', label: 'Rest and schedule', droppable: true, fit_window: [2014, 2019], shadow: true,
    fit: 'football/cfb_p4/research/train_layers.py schedule_layer on 2014-2019 residuals (B_LO, B_HI): sum of w_k (home_k − away_k) over the rest, road-trip and opponent-strength components',
    caveat: 'not in the shipped number. The engine computes it in its trained form and publishes it as shadow points (params schedule.points_applied is absent), so it is tested as the shipped engine PLUS the term against the shipped engine: VALIDATED here is the case for putting it in. Its earlier priced form (a 0-100 stress index, floored at 0, with the weights’ signs ignored and a second ÷100) moved the number by 0.001 pts on average and is retired' },
  { key: 'conference', label: 'Conference strength', droppable: true, fit_window: [2014, 2019],
    fit: 'football/cfb_p4/research/train_layers.py conference_layer on 2014-2019 cross-conference games (B_LO, B_HI): points per point of the gap in the two conferences’ prior-season cross-conference margin, faded to 0 by six games played',
    caveat: 'the prior season’s strength only. engine.js situation.conference also reads an in-season table (state.conf), but nothing writes it, so that path never runs; the term is the prior season’s table faded to 0 by six games played' },
  { key: 'hfa', label: 'Home field', droppable: true, fit_window: null,
    fit: 'football/cfb_p4/research/hfa_unify.js chose the value with the lowest 2022-2025 MAE, so 2022-2025 is not held out for its SIZE',
    caveat: 'the 2.8-pt value was selected on this window; read its multiplier as a check, not a validation' },
  { key: 'rating', label: 'Team strength', droppable: false, fit_window: null,
    fit: 'the opponent-adjusted rating recursion, hyperparameters tuned before 2022',
    caveat: 'the base of the model: dropping it is not a question, only its weight is' }
];
/* terms the replay cannot exercise: their live inputs have no history */
const NOT_TESTABLE = {
  qb: 'no historical starter series is fed to the replay, so the term is 0 on every row',
  injury: 'historical injury reports do not exist, so the term is 0 on every row',
  travel: 'not priced (params.travel.points_applied false): 0 on every row',
  rivalry: 'not priced (0 to the mean): 0 on every row',
  altitude: 'not priced: tested separately in football/altitude (REJECTED)'
};

/* ------------------------------------------------------------ small maths */
function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; }
function q(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
function r(x, d) { return x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d == null ? 3 : d)) / Math.pow(10, d == null ? 3 : d); }
function phi(z) { /* standard normal CDF (Abramowitz-Stegun 7.1.26) */
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/* two-sided p of a paired mean difference, normal approximation (n in the hundreds) */
function pairedP(d) {
  const n = d.length; if (n < 3) return null;
  const m = mean(d); let v = 0; for (const x of d) v += (x - m) * (x - m); v /= (n - 1);
  const se = Math.sqrt(v / n); if (!se) return null;
  return 2 * (1 - phi(Math.abs(m / se)));
}

/* ------------------------------------------------------------ the rows */
function readRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/* scored games: completed FBS vs FBS with a projection; the result as home margin */
function scored(rows) {
  return rows.filter((x) => x.completed && x.home_fbs && x.away_fbs && x.final_margin != null && x.fair != null && x.c);
}
function closeMargin(x) { const m = x.mkt; return m && m.close_home_line != null ? -m.close_home_line : null; }
/* every row must be priced before it kicked off */
function leakage(rows) {
  const bad = rows.filter((x) => !(Date.parse(x.prediction_ts) < Date.parse(x.kickoff)));
  return { clean: bad.length === 0, checked: rows.length, violations: bad.length, rule: 'prediction_ts (the weekly freeze the row was priced at) is before kickoff on every row, and the replay absorbs only games finished before the freeze' };
}

/* ------------------------------------------------------- one term, one window
   g: rows; t(x): the term's points on row x (home-margin convention).
   opts.shadow: the term is not in x.fair, so the arm is fair + t and the
   baseline is fair; otherwise the arm is fair and the baseline fair − t. */
function measure(g, t, opts) {
  const B = opts.boot, R = rng(opts.seed);
  const rows = g.filter((x) => t(x) != null);
  const n = rows.length;
  if (!n) return { n: 0 };
  const meanAbs = mean(rows.map((x) => Math.abs(t(x))));
  /* a term that never moves the number has nothing to test */
  if (!(meanAbs > 0)) return { n, inert: true, mean_abs_term: 0 };
  const y = rows.map((x) => x.final_margin), tv = rows.map(t);
  const f = rows.map((x, i) => opts.shadow ? x.fair + tv[i] : x.fair), b = f.map((v, i) => v - tv[i]);
  const ew = y.map((v, i) => Math.abs(v - f[i])), eo = y.map((v, i) => Math.abs(v - b[i]));
  const d = eo.map((v, i) => v - ew[i]);                      /* + = the term helps */
  const sq = (a) => Math.sqrt(mean(a.map((v) => v * v)));
  /* k: least squares of (y - b) on t through the origin */
  function kfit(idx, target) {
    let num = 0, den = 0;
    for (const i of idx) { const yy = target[i]; if (yy == null) continue; num += tv[i] * (yy - b[i]); den += tv[i] * tv[i]; }
    return den ? num / den : null;
  }
  const all = rows.map((_, i) => i);
  const close = rows.map(closeMargin);
  const kY = kfit(all, y), kC = kfit(all, close);
  const dB = [], kB = [], kCB = [];
  for (let s = 0; s < B; s++) {
    const idx = []; let sd = 0;
    for (let j = 0; j < n; j++) { const i = Math.floor(R() * n); idx.push(i); sd += d[i]; }
    dB.push(sd / n); kB.push(kfit(idx, y)); kCB.push(kfit(idx, close));
  }
  dB.sort((a, c) => a - c); kB.sort((a, c) => a - c); kCB.sort((a, c) => a - c);
  /* the close: does the term move EdgeDesk toward where the market settled? */
  const withC = rows.map((x, i) => close[i] == null ? null : [Math.abs(close[i] - f[i]), Math.abs(close[i] - b[i])]).filter(Boolean);
  /* Brier under one normal per game at the row's own sigma (the engine's
     win probability is not stored per arm, so both arms are put on the same footing) */
  const pr = rows.map((x, i) => (x.final_margin === 0 || !x.sigma) ? null : { w: x.final_margin > 0 ? 1 : 0, pw: phi(f[i] / x.sigma), po: phi(b[i] / x.sigma) }).filter(Boolean);
  const brW = mean(pr.map((p) => (p.pw - p.w) * (p.pw - p.w))), brO = mean(pr.map((p) => (p.po - p.w) * (p.po - p.w)));
  const seasons = {};
  rows.forEach((x, i) => { const s = seasons[x.season] || (seasons[x.season] = { n: 0, ew: 0, eo: 0 }); s.n++; s.ew += ew[i]; s.eo += eo[i]; });
  return {
    n, mean_abs_term: r(mean(tv.map(Math.abs))), negligible: meanAbs < NEGLIGIBLE_PTS,
    mae_with: r(mean(ew)), mae_without: r(mean(eo)), rmse_with: r(sq(y.map((v, i) => v - f[i]))), rmse_without: r(sq(y.map((v, i) => v - b[i]))),
    delta: r(mean(d)), delta_ci95: [r(q(dB, 0.025)), r(q(dB, 0.975))], paired_p: r(pairedP(d), 4),
    k: r(kY), k_ci95: [r(q(kB, 0.025)), r(q(kB, 0.975))],
    close: withC.length ? { n: withC.length, mae_with: r(mean(withC.map((p) => p[0]))), mae_without: r(mean(withC.map((p) => p[1]))),
      delta: r(mean(withC.map((p) => p[1] - p[0]))), k: r(kC), k_ci95: [r(q(kCB, 0.025)), r(q(kCB, 0.975))] } : null,
    brier_with: r(brW, 5), brier_without: r(brO, 5),
    per_season: Object.keys(seasons).sort().map((k) => ({ season: +k, n: seasons[k].n, mae_before: r(seasons[k].eo / seasons[k].n), mae_after: r(seasons[k].ew / seasons[k].n) }))
  };
}

/* the weight, in words, from k's interval */
function weightVerdict(m) {
  if (m && m.inert) return { key: 'INERT', text: 'always 0: nothing to weigh' };
  if (m && m.negligible) return { key: 'NEGLIGIBLE', text: 'moves the number by ' + m.mean_abs_term.toFixed(3) + ' pts on average: too small to weigh' };
  if (!m || !m.n || !m.k_ci95 || m.k_ci95[0] == null) return { key: 'UNMEASURED', text: 'not measured' };
  const [lo, hi] = m.k_ci95;
  if (hi < 0) return { key: 'WRONG_SIGN', text: 'points the wrong way: the best-fit multiplier is below 0' };
  if (lo <= 0) return { key: 'NO_SIGNAL', text: 'no measurable information: the multiplier’s interval includes 0' };
  if (hi < 1) return { key: 'OVERWEIGHTED', text: 'real but over-weighted: the best-fit multiplier is ' + m.k.toFixed(2) };
  if (lo > 1) return { key: 'UNDERWEIGHTED', text: 'real and under-weighted: the best-fit multiplier is ' + m.k.toFixed(2) };
  return { key: 'WEIGHT_SUPPORTED', text: 'the shipped weight is consistent with the data (multiplier ' + m.k.toFixed(2) + ')' };
}

function inWindow(rows, seasons) { return rows.filter((x) => seasons.indexOf(x.season) >= 0); }
function range(a, b) { const o = []; for (let y = a; y <= b; y++) o.push(y); return o; }

function run(rows, opts) {
  const S = scored(rows), leak = leakage(rows);
  const seasons = Array.from(new Set(S.map((x) => x.season))).sort();
  const hold = inWindow(S, HOLDOUT);
  const out = { schema: 'edgedesk_cfb_loto_v1', generated_at: new Date().toISOString(), declared: DECLARED,
    question: 'For each priced term: does the shipped engine predict held-out games better with it than without it, and is its weight right?',
    rows: { file: opts.rowsFile ? path.relative(ROOT, opts.rowsFile) : null, total: rows.length, scored: S.length, seasons },
    holdout: HOLDOUT, affected_pts: AFFECTED_PTS, bootstrap: opts.boot, leakage: leak,
    target_note: 'error = final home margin minus the projection; + delta = the term makes held-out predictions better. The close is the archive’s final consensus line (cfb_market_orientation_v2), a lower-noise second target.',
    brier_note: 'Brier with one normal per game at the row’s own sigma for both arms, because the replay stores the engine’s win probability for the full projection only.',
    terms: [], pairs: null, not_testable: NOT_TESTABLE };
  TERMS.forEach((T, ti) => {
    const t = T.shadow
      ? (x) => (x.shadow && typeof x.shadow[T.key] === 'number') ? x.shadow[T.key] : null
      : (x) => (x.c && typeof x.c[T.key] === 'number' && (T.key !== 'matchup' || (x.c_avail && x.c_avail.matchup))) ? x.c[T.key] : null;
    const mo = (seed) => ({ boot: opts.boot, seed, shadow: !!T.shadow });
    const m = measure(hold, t, mo(1000 + ti));
    const aff = measure(hold.filter((x) => t(x) != null && Math.abs(t(x)) >= AFFECTED_PTS), t, mo(2000 + ti));
    const fitw = T.fit_window ? measure(inWindow(S, range(T.fit_window[0], T.fit_window[1])), t, mo(3000 + ti)) : null;
    const gap = T.fit_window ? measure(inWindow(S, range(T.fit_window[1] + 1, HOLDOUT[0] - 1)), t, mo(4000 + ti)) : null;
    const promote = T.droppable && m.n && !m.inert && !m.negligible ? PROMOTE.evaluate(
      { feature: 'cfb_term_' + T.key, per_season: m.per_season, spread_mae: m.mae_with, paired: { p: m.paired_p }, brier: m.brier_with, leakage_clean: leak.clean, coefficient: m.k },
      { spread_mae: m.mae_without, brier: m.brier_without }) : null;
    out.terms.push({ key: T.key, label: T.label, droppable: T.droppable, shadow: !!T.shadow, fit: T.fit, caveat: T.caveat || null,
      holdout: m, holdout_affected: aff, fit_window: T.fit_window ? { seasons: T.fit_window, result: fitw } : null,
      between: gap && gap.n ? { seasons: [T.fit_window[1] + 1, HOLDOUT[0] - 1], result: gap } : null,
      status: promote ? promote.status : (m.inert ? 'INERT' : (m.negligible ? 'NEGLIGIBLE' : null)), conditions_failed: promote ? promote.conditions_failed : null, reasons: promote ? promote.reasons : null,
      weight: weightVerdict(m) });
  });
  /* the matchup term by pairing: each learned pairing dropped on its own */
  const names = {};
  S.forEach((x) => { if (x.mpairs) Object.keys(x.mpairs).forEach((k) => { names[k] = 1; }); });
  const P = (() => { try { return require(path.join(ROOT, 'football', 'cfb_p4', 'params.js')); } catch (e) { return null; } })();
  const W = {}; ((P && P.matchup && P.matchup.pairs) || []).forEach((p) => { W[p.name] = p.w; });
  const PD = {}; ((P && P.matchup && P.matchup.pairs) || []).forEach((p) => { PD[p.name] = p; });
  const UNFED = (() => { try { return require(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.js')).UNAVAILABLE || []; } catch (e) { return []; } })();
  out.pairs = Object.keys(names).sort().map((name, i) => {
    const t = (x) => x.mpairs && typeof x.mpairs[name] === 'number' ? x.mpairs[name] : null;
    const m = measure(hold, t, { boot: opts.boot, seed: 5000 + i });
    const fw = measure(inWindow(S, range(2014, 2019)), t, { boot: opts.boot, seed: 6000 + i });
    const pd = PD[name] || {}, unfed = Array.from(new Set([pd.off, String(pd.def || '').replace(/^def_/, '')].filter((f) => f && UNFED.indexOf(f) >= 0)));
    return { name, shipped_weight: W[name] == null ? null : W[name], features: [pd.off || null, pd.def || null], unfed_features: unfed,
      holdout: m, fit_window: fw, weight: weightVerdict(m) };
  });
  out.conference = conferenceBreakdown(S, hold, opts);
  return out;
}

/* ---------------------------------------------- conference strength, by part
   The term (engine.js confGap) is points_per_strength x (home conference's
   prior-season cross-conference margin - away's) x (1 - fewer games played /
   6), on cross-conference FBS games with neither side independent. It is
   taken apart on the games it moved: by how far it has faded (the fewer games
   either team has played), by the kind of pairing, and with the team-strength
   multiplier fitted beside it, because both terms say how good a team is.
   These splits describe the record; only the whole term is put to the
   promotion rules. */
const P4_CONFERENCES = ['SEC', 'Big Ten', 'Big 12', 'ACC'];
/* the Pac-12 was a Power 4 conference through 2023; from 2024 it is two programmes */
function isP4(conf, season) { return P4_CONFERENCES.indexOf(conf) >= 0 || (conf === 'Pac-12' && season <= 2023); }
const CONF_KINDS = ['Power 4 v Group of 5', 'Power 4 v Power 4', 'Group of 5 v Group of 5'];
function confKind(x) {
  const a = isP4(x.home_conference, x.season), b = isP4(x.away_conference, x.season);
  return a && b ? CONF_KINDS[1] : (a || b ? CONF_KINDS[0] : CONF_KINDS[2]);
}
/* two multipliers at once: (result - (engine - t1 - t2)) on t1 and t2 */
function jointFit(g, ts, opts) {
  const rows = g.filter((x) => ts.every((t) => t(x) != null));
  const n = rows.length;
  if (n < 10) return { n };
  const T = rows.map((x) => ts.map((t) => t(x)));
  const Y = rows.map((x, i) => x.final_margin - (x.fair - T[i][0] - T[i][1]));
  function fit(idx) {
    let a = 0, b = 0, c = 0, u = 0, v = 0;
    for (const i of idx) { const p = T[i][0], q = T[i][1]; a += p * p; b += p * q; c += q * q; u += p * Y[i]; v += q * Y[i]; }
    const det = a * c - b * b;
    return det ? [(c * u - b * v) / det, (a * v - b * u) / det] : [null, null];
  }
  const k = fit(rows.map((_, i) => i)), R = rng(opts.seed), B0 = [], B1 = [];
  for (let s = 0; s < opts.boot; s++) {
    const idx = []; for (let j = 0; j < n; j++) idx.push(Math.floor(R() * n));
    const kk = fit(idx); B0.push(kk[0]); B1.push(kk[1]);
  }
  B0.sort((a, c) => a - c); B1.sort((a, c) => a - c);
  return { n, k: [r(k[0]), r(k[1])], k_ci95: [[r(q(B0, 0.025)), r(q(B0, 0.975))], [r(q(B1, 0.025)), r(q(B1, 0.975))]] };
}
function conferenceBreakdown(S, hold, opts) {
  const t = (x) => (x.c && typeof x.c.conference === 'number') ? x.c.conference : null;
  const moved = (g) => g.filter((x) => t(x) != null && Math.abs(t(x)) > 1e-9);
  const mo = (seed) => ({ boot: opts.boot, seed });
  const mh = moved(hold), gp = (x) => Math.min(x.h_gp, x.a_gp);
  const rating = (x) => (x.c && typeof x.c.rating === 'number') ? x.c.rating : null;
  const jf = jointFit(hold, [rating, t], mo(7300));
  /* the prior-season table each season is priced from, and how many games the
     term moved that season: a thin table (the 2020 pandemic season) is noise */
  const PC = (() => { try { global.window = global.window || global; return require(path.join(ROOT, 'football', 'cfb_p4', 'params.js')).conference || {}; } catch (e) { return {}; } })();
  const seasons = Array.from(new Set(S.map((x) => x.season))).sort();
  const tables = seasons.map((y) => {
    const tab = (PC.by_season || {})[String(y - 1)] || {}, ks = Object.keys(tab);
    return { season: y, table_season: y - 1, conferences: ks.length, team_games: ks.reduce((a, k) => a + (tab[k].n || 0), 0),
      moved: moved(S.filter((x) => x.season === y)).length };
  });
  const med = tables.map((x) => x.team_games).sort((a, b) => a - b)[Math.floor(tables.length / 2)] || 0;
  return {
    rule: 'cross-conference FBS games, neither side independent, while the team with fewer games played has played under six',
    holdout_games: hold.length,
    holdout_moved: measure(mh, t, mo(7000)),
    by_games_played: [0, 1, 2, 3, 4, 5].map((n, i) => ({ min_games_played: n, fade: r(1 - n / 6, 3), result: measure(mh.filter((x) => gp(x) === n), t, mo(7100 + i)) })),
    by_matchup: CONF_KINDS.map((kind, i) => ({ kind, result: measure(mh.filter((x) => confKind(x) === kind), t, mo(7200 + i)) })),
    joint: jf.k ? { n: jf.n, terms: ['rating', 'conference'], k: { rating: jf.k[0], conference: jf.k[1] }, k_ci95: { rating: jf.k_ci95[0], conference: jf.k_ci95[1] } } : { n: jf.n },
    p4: P4_CONFERENCES.concat(['Pac-12 (through 2023)']),
    tables, table_median_team_games: med,
    note: 'the splits describe the record; only the whole term is judged by the promotion rules, and a rule chosen from these numbers would be a new term to declare and test on later games'
  };
}

/* ------------------------------------------------------------ the live board
   The replay starts cold, so a feature the current-season feed never supplies
   (football/rankings/engine_efficiency.js UNAVAILABLE) is 0 there: the term the
   replay tests is the current-season part. The LIVE board starts from
   params.efficiency.seed (the closing snapshot of the training season); the
   build resets those features to league average at the season break
   (engine.js strength.resetUnmeasured), so they should add nothing. This
   splits the live slate's matchup points into the two parts, from the same
   state the slate build uses (football/fbs/build_coverage.js buildState), and
   is the check that they do. */
async function liveSplit() {
  global.window = global.window || global;
  const P = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
  const EF = require(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.js'));
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const eff = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), 'utf8'));
  const season = slate.season, text = await BC.loadSeason(season, true);
  const { st } = BC.buildState({ [season]: BC.normRows(BC.parseCsv(text)) }, season, eff);
  const UN = new Set(EF.UNAVAILABLE), pairs = (P.matchup && P.matchup.pairs) || [];
  let n = 0, tot = 0, cur = 0, old = 0, big = 0; const per = {};
  (slate.games || []).forEach((g) => {
    const H = E.strength.profile(st, E.normKey(g.home_team), true), A = E.strength.profile(st, E.normKey(g.away_team), true);
    const mH = E.matchup.evaluate(H, A, 'home'), mA = E.matchup.evaluate(A, H, 'away');
    let c = 0, o = 0, all = 0;
    pairs.forEach((p, i) => {
      const part = (d) => d && d.available ? { off: p.w * (p.off_sign || 1) * d.off, def: p.w * (p.def_sign || 1) * d.def } : { off: 0, def: 0 };
      const ph = part(mH.detail[i]), pa = part(mA.detail[i]), offN = ph.off - pa.off, defN = ph.def - pa.def;
      const offOld = UN.has(p.off), defOld = UN.has(String(p.def).replace(/^def_/, ''));
      o += (offOld ? offN : 0) + (defOld ? defN : 0); c += (offOld ? 0 : offN) + (defOld ? 0 : defN);
      all += offN + defN; per[p.name] = (per[p.name] || 0) + Math.abs(offN + defN);
    });
    n++; tot += Math.abs(all); cur += Math.abs(c); old += Math.abs(o); if (Math.abs(o) >= 0.5) big++;
  });
  return { slate_generated_at: slate.generated_at, season, seed_season: P.trained_through_season, games: n,
    mean_abs_matchup: r(tot / n, 2), mean_abs_current: r(cur / n, 2), mean_abs_last_season: r(old / n, 2), games_last_season_ge_half_pt: big,
    by_pairing: Object.keys(per).map((k) => ({ name: k, mean_abs: r(per[k] / n, 2) })), unfed_features: EF.UNAVAILABLE.slice(),
    reset: !!st.effUnmeasured,
    note: 'current = features the season feed updates; last season = features it never supplies, ' + (st.effUnmeasured
      ? 'reset to league average at the season break (engine.js strength.resetUnmeasured)'
      : 'held at the ' + P.trained_through_season + ' closing seed (decayed once at the season break)') };
}

/* the live slate's conference term, from the same state the slate build uses:
   it fades to 0 by six games played, so late in a season it moves few games */
async function liveConference() {
  global.window = global.window || global;
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const eff = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), 'utf8'));
  const season = slate.season, text = await BC.loadSeason(season, true);
  const { st } = BC.buildState({ [season]: BC.normRows(BC.parseCsv(text)) }, season, eff);
  const pts = [];
  (slate.games || []).forEach((g) => {
    const o = E.projectGame({ season, week: g.week, state: st,
      game: { home: g.home_team, away: g.away_team, home_fbs: g.home_division === 'fbs', away_fbs: g.away_division === 'fbs', neutral_site: !!g.neutral_site },
      teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } } });
    if (o.status !== 'PREDICTED') return;
    const c = (o.contributions || []).filter((x) => x.key === 'conference')[0];
    pts.push(c && typeof c.points === 'number' ? c.points : 0);
  });
  const mv = pts.filter((x) => Math.abs(x) > 1e-9).map(Math.abs);
  return { slate_generated_at: slate.generated_at, season, games: pts.length, moved: mv.length,
    mean_abs_moved: mv.length ? r(mv.reduce((a, b) => a + b, 0) / mv.length, 2) : 0, max_abs: mv.length ? r(Math.max.apply(null, mv), 2) : 0 };
}

/* ------------------------------------------------------------ the report */
function sg(x, d) { return x == null ? '—' : (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(x).toFixed(d == null ? 3 : d); }
function ci(a, d) { return a && a[0] != null ? '[' + sg(a[0], d) + ', ' + sg(a[1], d) + ']' : '—'; }
function render(J) {
  const L = [];
  L.push('# Leave one term out — EdgeDesk college number');
  L.push('');
  L.push('Generated by `football/cfb_p4/research/loto.js` from `football/validation/loto_cfb.json` (' + String(J.generated_at).slice(0, 10) + '). Do not edit by hand: rerun the harness. Declared ' + J.declared + ', before the first run.');
  L.push('');
  L.push('**The question.** For every term that moves the college number: does the shipped engine predict games it never saw better WITH the term than without it, and is the term’s weight right? Nothing is refitted: each term is removed from the shipped projection, game by game, and the repository’s own promotion rules (`football/validation/promote.js`) judge the difference. The weight is the multiplier k that best fits the result with everything else held at its shipped value: k ≈ 1 is right, k ≈ 0 carries nothing, k < 0 points the wrong way.');
  L.push('');
  L.push('**The rows.** ' + J.rows.scored.toLocaleString('en-US') + ' completed FBS-vs-FBS games, ' + J.rows.seasons[0] + '–' + J.rows.seasons[J.rows.seasons.length - 1] + ', priced by `disagreement_replay.js`: the shipped engine replayed cold and frozen weekly, with the matchup layer fed by the board’s own efficiency adapter. Held out: ' + J.holdout[0] + '–' + J.holdout[J.holdout.length - 1] + '. Leakage check: ' + (J.leakage.clean ? 'clean on all ' + J.leakage.checked.toLocaleString('en-US') + ' rows' : J.leakage.violations + ' VIOLATIONS') + '.');
  L.push('');
  L.push('## Verdicts (held out ' + J.holdout[0] + '–' + J.holdout[J.holdout.length - 1] + ')');
  L.push('');
  L.push('| term | games | mean size | MAE with → without | Δ (+ helps) | 95% CI | p | weight k | k 95% CI | status | weight |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  J.terms.forEach((T) => {
    const m = T.holdout, z = m.inert || m.negligible;
    L.push('| ' + T.label + (T.shadow ? ' (not priced; tested added)' : '') + ' | ' + (m.n || 0).toLocaleString('en-US') + ' | ' + (m.mean_abs_term == null ? '—' : m.mean_abs_term.toFixed(z ? 3 : 2)) + ' | ' + (m.n && !z ? m.mae_with.toFixed(3) + ' → ' + m.mae_without.toFixed(3) : '—') + ' | ' + (z ? '—' : sg(m.delta)) + ' | ' + (z ? '—' : ci(m.delta_ci95)) + ' | ' + (z || m.paired_p == null ? '—' : m.paired_p.toFixed(3)) + ' | ' + (z || m.k == null ? '—' : m.k.toFixed(2)) + ' | ' + (z ? '—' : ci(m.k_ci95, 2)) + ' | ' + (T.status || (T.droppable ? '—' : 'core')) + ' | ' + T.weight.text + ' |');
  });
  L.push('');
  J.terms.forEach((T) => { if (T.caveat) L.push('- **' + T.label + ':** ' + T.caveat + '.'); });
  L.push('');
  L.push('## Each term, in and out of the window it was fitted on');
  J.terms.forEach((T) => {
    L.push('');
    L.push('### ' + T.label);
    L.push('');
    L.push('Fitted: ' + T.fit + '.');
    if (T.reasons && T.reasons.length) L.push('Promotion rules: ' + T.status + ' — ' + T.reasons.join('; ') + '.');
    L.push('');
    L.push('| window | games | MAE with → without | Δ (+ helps) | 95% CI | k | k 95% CI | vs close: Δ | close k | Brier with → without |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    const rowsOut = [];
    if (T.fit_window && T.fit_window.result && T.fit_window.result.n) rowsOut.push(['fitted ' + T.fit_window.seasons.join('–') + ' (in sample)', T.fit_window.result]);
    if (T.between) rowsOut.push([T.between.seasons.join('–') + ' (after the fit, before the hold-out)', T.between.result]);
    rowsOut.push(['held out ' + J.holdout[0] + '–' + J.holdout[J.holdout.length - 1], T.holdout]);
    if (T.holdout_affected && T.holdout_affected.n) rowsOut.push(['held out, games where it moved ' + J.affected_pts + '+ pts', T.holdout_affected]);
    rowsOut.forEach(([w, m]) => {
      if (m.inert || m.negligible) { L.push('| ' + w + ' | ' + m.n.toLocaleString('en-US') + ' | moves ' + m.mean_abs_term.toFixed(3) + ' pts on average: nothing to grade | | | | | | | |'); return; }
      L.push('| ' + w + ' | ' + m.n.toLocaleString('en-US') + ' | ' + m.mae_with.toFixed(3) + ' → ' + m.mae_without.toFixed(3) + ' | ' + sg(m.delta) + ' | ' + ci(m.delta_ci95) + ' | ' + (m.k == null ? '—' : m.k.toFixed(2)) + ' | ' + ci(m.k_ci95, 2) + ' | ' + (m.close ? sg(m.close.delta) : '—') + ' | ' + (m.close && m.close.k != null ? m.close.k.toFixed(2) + ' ' + ci(m.close.k_ci95, 2) : '—') + ' | ' + (m.brier_with == null ? '—' : m.brier_with.toFixed(4) + ' → ' + m.brier_without.toFixed(4)) + ' |');
    });
    if (T.holdout.per_season && T.holdout.per_season.length && !T.holdout.negligible && !T.holdout.inert) {
      L.push('');
      L.push('Held out, by season (MAE without → with): ' + T.holdout.per_season.map((s) => s.season + ' ' + s.mae_before.toFixed(3) + ' → ' + s.mae_after.toFixed(3) + ' (n ' + s.n + ')').join('; ') + '.');
    }
  });
  if (J.conference && J.conference.holdout_moved && J.conference.holdout_moved.n) {
    const C = J.conference, m = C.holdout_moved, w = (x) => x.toLocaleString('en-US');
    const row = (lab, x) => x && x.n && !x.inert ? '| ' + lab + ' | ' + w(x.n) + ' | ' + x.mean_abs_term.toFixed(2) + ' | ' + x.mae_with.toFixed(3) + ' → ' + x.mae_without.toFixed(3) + ' | ' + sg(x.delta) + ' | ' + ci(x.delta_ci95) + ' | ' + (x.k == null ? '—' : x.k.toFixed(2)) + ' | ' + ci(x.k_ci95, 2) + ' |'
      : '| ' + lab + ' | ' + w((x && x.n) || 0) + ' | — | — | — | — | — | — |';
    L.push('');
    L.push('## Conference strength, piece by piece');
    L.push('');
    L.push('The term is points per strength × (the home conference’s prior-season cross-conference margin − the away conference’s) × (1 − fewer games played ÷ 6). It applies to ' + C.rule + '. Held out, it moved ' + w(m.n) + ' of ' + w(C.holdout_games) + ' games (' + Math.round(100 * m.n / C.holdout_games) + '%), by ' + m.mean_abs_term.toFixed(2) + ' pts on average; on those games MAE is ' + sg(m.delta) + ' ' + ci(m.delta_ci95) + ' better with it and k = ' + m.k.toFixed(2) + ' ' + ci(m.k_ci95, 2) + '.');
    L.push('');
    L.push('**By how far it has faded** (held out, games it moved):');
    L.push('');
    L.push('| fewer games played | weight left | games | mean size | MAE with → without | Δ (+ helps) | 95% CI | k | k 95% CI |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    C.by_games_played.forEach((b) => { L.push(row(b.min_games_played + ' | ' + Math.round(100 * b.fade) + '%', b.result)); });
    L.push('');
    L.push('**By the kind of pairing** (held out, games it moved; Power 4: ' + C.p4.join(', ') + '):');
    L.push('');
    L.push('| pairing | games | mean size | MAE with → without | Δ (+ helps) | 95% CI | k | k 95% CI |');
    L.push('|---|---|---|---|---|---|---|---|');
    C.by_matchup.forEach((b) => { L.push(row(b.kind, b.result)); });
    if (m.per_season && m.per_season.length) {
      L.push('');
      L.push('By held-out season, on the games it moved (MAE without → with): ' + m.per_season.map((x) => x.season + ' ' + x.mae_before.toFixed(3) + ' → ' + x.mae_after.toFixed(3) + ' (n ' + x.n + ')').join('; ') + '.');
    }
    const thin = (C.tables || []).filter((x) => x.team_games < C.table_median_team_games / 2);
    if (thin.length) {
      L.push('');
      L.push('**Thin tables.** ' + thin.map((x) => x.season + ' was priced from the ' + x.table_season + ' table: ' + w(x.team_games) + ' cross-conference team-games in ' + x.conferences + ' conferences, against a median of ' + w(C.table_median_team_games) + ' (the term moved ' + x.moved + ' games in ' + x.season + ', and '
        + (((C.tables || []).filter((y) => y.season === x.table_season)[0] || {}).moved || 0) + ' in ' + x.table_season + ')').join('; ') + '.'
        + (function () {
          const T = J.terms.filter((x) => x.key === 'conference')[0], bw = T && T.between && T.between.seasons;
          return bw && thin.every((x) => x.season >= bw[0] && x.season <= bw[1]) ? ' It falls in ' + bw.join('–') + ', the window after the fit where the term carried nothing.' : '';
        })());
    }
    if (C.joint && C.joint.k) {
      L.push('');
      L.push('**Beside team strength.** Both terms say how good a team is, so their multipliers are also fitted together on all ' + w(C.joint.n) + ' held-out games: team strength k = ' + C.joint.k.rating.toFixed(2) + ' ' + ci(C.joint.k_ci95.rating, 2) + ', conference k = ' + C.joint.k.conference.toFixed(2) + ' ' + ci(C.joint.k_ci95.conference, 2) + '.');
    }
    if (C.live) {
      L.push('');
      L.push('**Live.** On the ' + C.live.season + ' slate of ' + String(C.live.slate_generated_at).slice(0, 10) + ', the term moves ' + C.live.moved + ' of ' + C.live.games + ' games' + (C.live.moved ? ' (by ' + C.live.mean_abs_moved.toFixed(2) + ' pts on average, at most ' + C.live.max_abs.toFixed(2) + ')' : '') + ': it fades to 0 by six games played.');
    }
    L.push('');
    L.push(C.note.charAt(0).toUpperCase() + C.note.slice(1) + '.');
  }
  if (J.pairs && J.pairs.length) {
    L.push('');
    L.push('## The stylistic matchup term, pairing by pairing');
    L.push('');
    L.push('Each of the learned pairings dropped on its own (home edge minus away edge). Shipped weights from `football/cfb_p4/params.js` `matchup.pairs`, fitted on 2014–2019.');
    L.push('');
    L.push('| pairing | shipped weight | held-out games | mean size | Δ held out (+ helps) | 95% CI | k held out | k 95% CI | Δ in sample 2014–2019 | k in sample |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    J.pairs.forEach((p) => {
      const m = p.holdout, f = p.fit_window;
      if (m.inert) { L.push('| ' + p.name + ' | ' + (p.shipped_weight == null ? '—' : p.shipped_weight) + ' | ' + (m.n || 0).toLocaleString('en-US') + ' | 0 | always 0: it needs `' + p.unfed_features.join('`, `') + '` (offence and defence), which the current-season feed does not supply | | | | | |'); return; }
      L.push('| ' + p.name + ' | ' + (p.shipped_weight == null ? '—' : p.shipped_weight) + ' | ' + (m.n || 0).toLocaleString('en-US') + ' | ' + (m.mean_abs_term == null ? '—' : m.mean_abs_term.toFixed(2)) + ' | ' + sg(m.delta) + ' | ' + ci(m.delta_ci95) + ' | ' + (m.k == null ? '—' : m.k.toFixed(2)) + ' | ' + ci(m.k_ci95, 2) + ' | ' + (f && f.n ? sg(f.delta) : '—') + ' | ' + (f && f.k != null ? f.k.toFixed(2) : '—') + ' |');
    });
  }
  if (J.live) {
    const V = J.live;
    L.push('');
    if (V.reset) {
      L.push('## The live board matches the replay');
      L.push('');
      L.push('The replay starts cold, so features the current-season feed never supplies (' + V.unfed_features.join(', ') + ') are 0 in it: the matchup term tested above is its current-season part. The live board starts from the ' + V.seed_season + ' closing seed and resets those features to league average at the break into ' + V.season + ', so it prices the same term. On the ' + V.season + ' slate of ' + String(V.slate_generated_at).slice(0, 10) + ' (' + V.games + ' games), the matchup term moves the line ' + V.mean_abs_matchup.toFixed(2) + ' pts on average: ' + V.mean_abs_current.toFixed(2) + ' pts from this season’s features and ' + V.mean_abs_last_season.toFixed(2) + ' pts from last season’s values (' + V.games_last_season_ge_half_pt + ' games carry half a point or more from them).');
    } else {
      L.push('## The live board is not the replay');
      L.push('');
      L.push('The replay starts cold, so features the current-season feed never supplies (' + V.unfed_features.join(', ') + ') are 0 in it: the matchup term tested above is its current-season part. The live board starts from the ' + V.seed_season + ' closing seed, so those features hold last season’s values all ' + V.season + ' season. On the ' + V.season + ' slate of ' + String(V.slate_generated_at).slice(0, 10) + ' (' + V.games + ' games), the matchup term moves the line ' + V.mean_abs_matchup.toFixed(2) + ' pts on average. Its this-season part averages ' + V.mean_abs_current.toFixed(2) + ' pts and its last-season part ' + V.mean_abs_last_season.toFixed(2) + ' pts (sizes, so they do not add). No test here covers the last-season part. ' + V.games_last_season_ge_half_pt + ' games carry half a point or more from last season’s values.');
    }
    L.push('');
    L.push('Live, by pairing (mean |points|): ' + V.by_pairing.map((x) => x.name + ' ' + x.mean_abs.toFixed(2)).join('; ') + '.');
  }
  L.push('');
  L.push('## Not testable here');
  L.push('');
  Object.keys(J.not_testable).forEach((k) => L.push('- **' + k + '**: ' + J.not_testable[k] + '.'));
  L.push('');
  L.push('## Reading it');
  L.push('');
  L.push('- ' + J.target_note);
  L.push('- ' + J.brier_note);
  L.push('- Dropping a term without refitting the rest answers "is the shipped term worth its points". A term that fails here could still be worth something with new weights; that is a refit, judged by the same rules on a later window.');
  L.push('');
  L.push('Reproduce: `node football/cfb_p4/research/disagreement_eff.js --data DIR 2014 … 2025`, then `node football/cfb_p4/research/disagreement_replay.js --data DIR --from 2014 --to 2025 --replay-from 2007`, then `node football/cfb_p4/research/loto.js --rows DIR/out/disagreement_replay.jsonl --live --write`.');
  L.push('');
  return L.join('\n');
}

module.exports = { measure, weightVerdict, jointFit, conferenceBreakdown, confKind, run, render, scored, leakage, liveSplit, liveConference, TERMS, HOLDOUT, NEGLIGIBLE_PTS };

if (require.main === module) {
  if (arg('render-only', false)) {
    const J = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    fs.writeFileSync(OUT_MD, render(J));
    console.error('[loto] rendered ' + path.relative(ROOT, OUT_MD));
    process.exit(0);
  }
  (async () => {
  const rowsFile = path.resolve(String(arg('rows', path.join(ROOT, '.cache', 'cfbdata', 'out', 'disagreement_replay.jsonl'))));
  const J = run(readRows(rowsFile), { boot: +arg('boot', 2000), rowsFile });
  if (arg('live', false)) { J.live = await liveSplit(); J.conference.live = await liveConference(); }
  J.rows.file = 'DIR/out/disagreement_replay.jsonl (disagreement_replay.js, ' + J.rows.total + ' rows)';
  const summary = J.terms.map((T) => T.label + ': ' + (T.status || 'core') + ', Δ ' + sg(T.holdout.delta) + ' ' + ci(T.holdout.delta_ci95) + ', k ' + (T.holdout.k == null ? '—' : T.holdout.k.toFixed(2)) + ' ' + ci(T.holdout.k_ci95, 2));
  console.log(summary.join('\n'));
  if (arg('write', false)) {
    fs.writeFileSync(OUT_JSON, JSON.stringify(J, null, 1) + '\n');
    fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
    fs.writeFileSync(OUT_MD, render(J));
    console.error('[loto] wrote ' + path.relative(ROOT, OUT_JSON) + ' and ' + path.relative(ROOT, OUT_MD));
  }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
