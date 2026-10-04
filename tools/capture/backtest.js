#!/usr/bin/env node
/* ===========================================================================
   THE HONEST BACKTEST HARNESS
   ---------------------------------------------------------------------------
   Answers one question: does EdgeDesk's qualification policy, run on data it
   has never seen, produce signals that beat the closing market and make money.

   It is built so that the ways a backtest normally lies are structurally
   impossible rather than merely discouraged.

   1. LEAKAGE IS A CRASH, NOT A CONVENTION.
      A policy function is handed a decisionView() — a Proxy that THROWS on any
      attempt to read result, closing_fair, closing_dec, closing_point,
      graded_at or clv. A policy cannot accidentally see the future because
      touching the future raises. Asserted directly in backtest.test.js.

   2. VALIDATION IS CHRONOLOGICAL, NEVER RANDOM.
      Rows are sorted by decision_at and cut into contiguous folds. Fold i is
      validated by a policy chosen using folds 0..i-1 ONLY. A random split of
      betting data leaks: the same game, the same team's season form, and the
      same market regime appear on both sides of the split.

   3. THE SHIPPED POLICY IS REPORTED SEPARATELY FROM THE SWEPT ONE.
      `fixed` is capture's actual defaults evaluated out of sample on every
      fold — the number that describes what the deployed system does. `swept`
      is the best grid point chosen on train and applied to validation, which
      is what a tuned system would do. The gap between them is the size of the
      overfitting you would be buying. Both are printed. The first is the
      headline, because it is the one that is true today.

   4. NO SEGMENT IS "PROVEN" BELOW A STATED SAMPLE SIZE.
      Every rate carries a Wilson interval, every ROI carries a bootstrap
      interval, and a segment under MIN_N is labelled UNPROVEN however good its
      point estimate looks. 68% over 19 bets is not a result.

   5. ONE PREDICTION IS ONE OBSERVATION.
      Both sides of a market, the same game at several lines, and a signal seen
      on many capture cycles are collapsed before anything is counted. A
      performance report that counts a bet twice is arithmetic about itself.

   ---------------------------------------------------------------------------
   INPUT
     A newline-delimited JSON file, one object per QUALIFIED signal, produced by
     tools/capture/export_history.js. Field contract in ROW_CONTRACT below.

   USAGE
     node tools/capture/export_history.js > history.ndjson     # needs the DB
     node tools/capture/backtest.js history.ndjson
     node tools/capture/backtest.js history.ndjson --json out.json --folds 6

   This repository contains NO historical EdgeDesk signals — record/grades.json
   is an empty seed and the `signals` table lives only in Supabase. Run against
   a real export; with no file the harness says so and exits non-zero rather
   than printing a number.
   =========================================================================== */
'use strict';

const fs = require('fs');

/* ── THE ROW CONTRACT ───────────────────────────────────────────────────────
   DECISION fields are everything known at the moment EdgeDesk committed.
   OUTCOME fields are everything that happened afterwards. The split is the
   whole safety property of this file. */
const DECISION_FIELDS = [
  'sig_key', 'event_id', 'sport_key', 'sport_title', 'market', 'selection', 'point',
  'commence_time', 'decision_at', 'hours_to_start',
  'entry_dec', 'entry_book', 'fair_prob', 'edge', 'edge_floor',
  'tier', 'reference_type', 'reference_book', 'quality_score',
  'n_books', 'fresh_books', 'families', 'dispersion',
  'ref_quote_age_s', 'best_quote_age_s', 'qual_streak',
  'pin_dec', 'pin_opp_dec', 'is_fav', 'devig_method', 'flagged_policy',
  'point_is_modal', 'modal_point',
];
const OUTCOME_FIELDS = [
  'result', 'graded_at', 'closing_fair', 'closing_dec', 'closing_point',
  'clv', 'beat_close', 'final_score',
];

/**
 * A view of a row that CANNOT see the future.
 *
 * Reading an outcome field throws with the field named. This is deliberately
 * louder than returning undefined: a policy that quietly reads `undefined` for
 * `closing_fair` still runs, still produces numbers, and the numbers are wrong
 * in a way nobody notices. A policy that crashes gets fixed.
 */
function decisionView(row) {
  return new Proxy(row, {
    get(t, k) {
      if (typeof k === 'string' && OUTCOME_FIELDS.indexOf(k) >= 0) {
        throw new Error(
          `LEAKAGE: a decision function read "${k}", which is not known at decision time. `
          + `If this is a legitimate evaluation read, use the raw row on the evaluation side of the fold.`);
      }
      return t[k];
    },
    has(t, k) {
      if (typeof k === 'string' && OUTCOME_FIELDS.indexOf(k) >= 0) return false;
      return k in t;
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

/** Wilson score interval for a binomial proportion. The normal approximation
    is worst exactly where a betting record lives — small n, p near 0.5 — and a
    win rate printed without an interval is a claim wearing a number's clothes. */
function wilson(k, n, z) {
  if (!n) return null;
  z = z || 1.96;
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** Deterministic bootstrap. A seeded LCG rather than Math.random so two runs of
    the same data print the same interval — a confidence interval that moves
    when you re-run it is not evidence, it is weather. */
function bootstrapCI(xs, iters, seed) {
  if (!xs.length) return null;
  iters = iters || 2000;
  let s = (seed || 12345) >>> 0;
  const rnd = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
  const means = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[(rnd() * xs.length) | 0];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function medianOf(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Brier score over binary outcomes. Lower is better; 0.25 is a coin flip. */
function brier(pairs) {
  if (!pairs.length) return null;
  return mean(pairs.map(([p, y]) => (p - y) * (p - y)));
}
/** Log loss, clipped so a confident miss is finite rather than infinite. */
function logLoss(pairs) {
  if (!pairs.length) return null;
  const c = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));
  return -mean(pairs.map(([p, y]) => (y ? Math.log(c(p)) : Math.log(1 - c(p)))));
}
/** Expected calibration error plus the reliability table behind it. A single
    ECE number hides which end of the range is miscalibrated; the bins do not. */
function calibration(pairs, nbins) {
  nbins = nbins || 10;
  const bins = Array.from({ length: nbins }, () => ({ n: 0, p: 0, y: 0 }));
  pairs.forEach(([p, y]) => {
    const i = Math.min(nbins - 1, Math.max(0, Math.floor(p * nbins)));
    bins[i].n++; bins[i].p += p; bins[i].y += y;
  });
  const n = pairs.length;
  let ece = 0;
  const table = bins.map((b, i) => {
    const row = {
      bin: `${(i / nbins).toFixed(1)}-${((i + 1) / nbins).toFixed(1)}`,
      n: b.n,
      predicted: b.n ? b.p / b.n : null,
      actual: b.n ? b.y / b.n : null,
    };
    if (b.n) ece += (b.n / n) * Math.abs(row.predicted - row.actual);
    return row;
  });
  return { ece: n ? ece : null, bins: table };
}

/** Largest peak-to-trough fall in the cumulative unit curve, in units. */
function maxDrawdown(pnl) {
  let peak = 0, cum = 0, dd = 0;
  for (const x of pnl) { cum += x; if (cum > peak) peak = cum; if (peak - cum > dd) dd = peak - cum; }
  return dd;
}

// ═══════════════════════════════════════════════════════════════════════════
// GRADING — outcome side only. Nothing here is visible to a policy.
// ═══════════════════════════════════════════════════════════════════════════

/** Profit in units for a 1-unit stake. A push returns the stake; a void is not
    a bet and is excluded upstream rather than scored as a push. */
function unitPnl(row) {
  if (row.result === 'win') return row.entry_dec - 1;
  if (row.result === 'loss') return -1;
  if (row.result === 'push') return 0;
  return null;
}

/**
 * Closing line value.
 *
 * PRICE CLV is the standard construction: the closing fair probability times
 * the price you actually took, minus one. It answers "was my number better than
 * the market's final answer", which is the question, and it is defined for
 * every market including moneylines where win rate is meaningless.
 *
 * LINE CLV is only defined for handicap markets and is reported separately in
 * POINTS, because for football the number matters independently of the price:
 * taking +3 and closing +2.5 is a materially different outcome from taking +3
 * and closing +3 at a worse price, and averaging them into one figure hides the
 * distinction the brief specifically asks to be able to see.
 */
function priceCLV(row) {
  if (row.closing_fair == null || !(row.entry_dec > 1)) return null;
  const p = Number(row.closing_fair);
  if (!(p > 0 && p < 1)) return null;
  return p * Number(row.entry_dec) - 1;
}

function lineCLV(row) {
  if (row.closing_point == null || row.point == null) return null;
  if (row.market !== 'spreads' && row.market !== 'totals') return null;
  const entry = Number(row.point), close = Number(row.closing_point);
  if (!Number.isFinite(entry) || !Number.isFinite(close)) return null;
  /* For a spread, a bet is better the MORE points it is getting, so entry minus
     close is positive when the line moved against the number we took — i.e. we
     got the better side of the move. For a total, Over wants a lower number and
     Under wants a higher one, so the sign depends on the side. */
  if (row.market === 'spreads') return entry - close;
  const isOver = /over/i.test(String(row.selection || ''));
  return isOver ? close - entry : entry - close;
}

// ═══════════════════════════════════════════════════════════════════════════
// DE-DUPLICATION — one prediction is one observation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collapse related and repeated rows so nothing is counted twice.
 *
 * THREE distinct inflations, all of which a naive export contains:
 *   - The SAME signal seen on many capture cycles. Keep the first qualified
 *     observation: that is the one whose entry price was frozen.
 *   - BOTH SIDES of a market. Chiefs -3.5 and Ravens +3.5 are one disagreement
 *     with the market, not two independent tests of the model. Keep one per
 *     (event, market), the earliest decision.
 *   - THE SAME GAME at several lines or in several markets. These are
 *     correlated but not identical, so they are NOT collapsed by default —
 *     collapsing them would throw away real information — but `perEvent: true`
 *     reports the stricter view, and both numbers are printed so the difference
 *     is visible rather than assumed.
 */
function dedupe(rows, opts) {
  const perEvent = !!(opts && opts.perEvent);
  const bySig = new Map();
  for (const r of rows) {
    const prev = bySig.get(r.sig_key);
    if (!prev || Date.parse(r.decision_at) < Date.parse(prev.decision_at)) bySig.set(r.sig_key, r);
  }
  const byMarket = new Map();
  for (const r of bySig.values()) {
    const k = perEvent ? r.event_id : `${r.event_id}|${r.market}`;
    const prev = byMarket.get(k);
    if (!prev || Date.parse(r.decision_at) < Date.parse(prev.decision_at)) byMarket.set(k, r);
  }
  return [...byMarket.values()].sort((a, b) => Date.parse(a.decision_at) - Date.parse(b.decision_at));
}

// ═══════════════════════════════════════════════════════════════════════════
// POLICY — what a candidate set of thresholds does to a decision row
// ═══════════════════════════════════════════════════════════════════════════

/** Capture's shipped defaults, restated here so the backtest measures the
    system that is actually deployed rather than an idealised version of it. */
const SHIPPED_POLICY = {
  name: 'shipped',
  minEdgeA: 0.015, minEdgeB: 0.025, ncaafPenalty: 0.005,
  minFreshBooksA: 3, minFreshBooksB: 4, minFamiliesB: 3,
  maxRefAgeS: 1800, minQuality: 0, requireTierA: false, minStreakB: 2,
};

/**
 * Does this decision row survive the policy?
 *
 * Takes a decisionView, so it physically cannot consult the outcome. Every
 * comparison below is against a field EdgeDesk knew at decision_at.
 */
function policyAdmits(d, p) {
  const isCfb = String(d.sport_key || '').startsWith('americanfootball_ncaaf');
  const bump = isCfb ? (p.ncaafPenalty || 0) : 0;
  if (p.requireTierA && d.tier !== 'A') return false;
  if (d.tier === 'A') {
    if (!(d.edge >= p.minEdgeA + bump)) return false;
    if (!(d.fresh_books >= p.minFreshBooksA)) return false;
  } else if (d.tier === 'B') {
    if (!(d.edge >= p.minEdgeB + bump)) return false;
    if (!(d.fresh_books >= p.minFreshBooksB)) return false;
    if (!(d.families >= p.minFamiliesB)) return false;
    if (d.qual_streak != null && !(d.qual_streak >= p.minStreakB)) return false;
  } else {
    return false;
  }
  if (d.ref_quote_age_s != null && !(d.ref_quote_age_s <= p.maxRefAgeS)) return false;
  if (d.quality_score != null && !(d.quality_score >= p.minQuality)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════════════════════

const MIN_N_PROVEN = 200;

/**
 * Every number the brief asks for, over one population.
 *
 * Denominators are named rather than shared: win rate is over settled bets,
 * CLV is over rows that have a close, calibration is over rows with both a
 * probability and a binary result. Publishing three figures side by side over
 * three different denominators without saying so is how a record misleads
 * without a single false statement in it.
 */
function score(rows, label) {
  const settled = rows.filter((r) => r.result === 'win' || r.result === 'loss');
  const pushes = rows.filter((r) => r.result === 'push').length;
  const w = settled.filter((r) => r.result === 'win').length;
  const l = settled.length - w;

  const pnl = rows.map(unitPnl).filter((x) => x != null);
  const staked = pnl.length;
  const units = pnl.reduce((a, b) => a + b, 0);

  const clvs = rows.map(priceCLV).filter((x) => x != null);
  const lineClvs = rows.map(lineCLV).filter((x) => x != null);

  const cal = rows
    .filter((r) => r.fair_prob != null && (r.result === 'win' || r.result === 'loss'))
    .map((r) => [Number(r.fair_prob), r.result === 'win' ? 1 : 0]);

  const decs = rows.map((r) => Number(r.entry_dec)).filter((d) => d > 1);
  const avgDec = mean(decs);

  const out = {
    label,
    n: rows.length,
    settled: settled.length,
    wins: w, losses: l, pushes,
    win_rate: settled.length ? w / settled.length : null,
    win_rate_ci: wilson(w, settled.length),
    avg_decimal_odds: avgDec,
    break_even_rate: avgDec ? 1 / avgDec : null,
    units: staked ? units : null,
    roi: staked ? units / staked : null,
    roi_ci: staked ? bootstrapCI(pnl) : null,
    max_drawdown_units: staked ? maxDrawdown(pnl) : null,
    clv_n: clvs.length,
    clv_mean: mean(clvs),
    clv_median: medianOf(clvs),
    clv_ci: clvs.length ? bootstrapCI(clvs) : null,
    clv_hit_rate: clvs.length ? clvs.filter((x) => x > 0).length / clvs.length : null,
    clv_hit_rate_ci: clvs.length ? wilson(clvs.filter((x) => x > 0).length, clvs.length) : null,
    line_clv_n: lineClvs.length,
    line_clv_mean_points: mean(lineClvs),
    brier: brier(cal),
    log_loss: logLoss(cal),
    calibration: cal.length ? calibration(cal) : null,
    proven: settled.length >= MIN_N_PROVEN,
    verdict: null,
  };

  /* THE VERDICT IS ABOUT THE INTERVAL, NOT THE POINT ESTIMATE. */
  if (settled.length < MIN_N_PROVEN) {
    out.verdict = `UNPROVEN — ${settled.length} settled bets, below the ${MIN_N_PROVEN} minimum. `
      + `Whatever the point estimate says, this segment has not demonstrated anything.`;
  } else if (out.roi_ci && out.roi_ci[0] > 0) {
    out.verdict = 'PROFITABLE — the 95% ROI interval is entirely above zero.';
  } else if (out.roi_ci && out.roi_ci[1] < 0) {
    out.verdict = 'LOSING — the 95% ROI interval is entirely below zero.';
  } else {
    out.verdict = 'INCONCLUSIVE — the 95% ROI interval spans zero. Enough bets to be worth watching, '
      + 'not enough to make a claim.';
  }
  return out;
}

/** The segment axes the brief asks for. Each is reported independently. */
function segmentsOf(r) {
  const dec = Number(r.entry_dec);
  const priceBand = dec < 1.5 ? 'price:<1.50 (heavy fav)'
    : dec < 1.83 ? 'price:1.50-1.83'
    : dec <= 2.20 ? 'price:1.83-2.20 (standard two-way)'
    : dec <= 3.5 ? 'price:2.20-3.50'
    : 'price:>3.50 (longshot)';
  const h = Number(r.hours_to_start);
  const ttk = !Number.isFinite(h) ? 'ttk:unknown'
    : h <= 2 ? 'ttk:<2h' : h <= 12 ? 'ttk:2-12h' : h <= 48 ? 'ttk:12-48h' : 'ttk:>48h';
  const edgeBand = r.edge == null ? 'edge:unknown'
    : r.edge < 0.02 ? 'edge:<2%' : r.edge < 0.035 ? 'edge:2-3.5%' : r.edge < 0.06 ? 'edge:3.5-6%' : 'edge:>6%';
  const qb = r.quality_score == null ? 'quality:unknown'
    : r.quality_score < 50 ? 'quality:<50' : r.quality_score < 70 ? 'quality:50-70' : 'quality:>=70';
  const season = String(r.commence_time || '').slice(0, 4);
  return [
    'ALL',
    `sport:${r.sport_title || r.sport_key}`,
    `market:${r.market}`,
    `sport+market:${r.sport_title || r.sport_key}|${r.market}`,
    `tier:${r.tier}`,
    `reference:${r.reference_type}`,
    edgeBand, qb, priceBand, ttk,
    `side:${r.is_fav ? 'favourite' : 'underdog'}`,
    `book:${r.entry_book || 'unknown'}`,
    `season:${season}`,
    /* THE HEADLINE SEGMENT. Standard football spreads and totals at ordinary
       two-way prices is the population the 55% target is about, and it is the
       only one where a raw win rate is the right measure. */
    (String(r.sport_key || '').startsWith('americanfootball_')
      && (r.market === 'spreads' || r.market === 'totals')
      && dec >= 1.83 && dec <= 2.20) ? 'HEADLINE:football standard spreads+totals' : null,
  ].filter(Boolean);
}

function scoreAllSegments(rows) {
  const by = new Map();
  rows.forEach((r) => segmentsOf(r).forEach((s) => {
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(r);
  }));
  const out = {};
  for (const [k, v] of by) out[k] = score(v, k);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// WALK-FORWARD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Chronological folds. Fold i is validated using only folds 0..i-1 to choose a
 * policy, so no row is ever evaluated by a policy that saw it.
 *
 * Fold 0 has no training data and is therefore NEVER evaluated in the swept
 * arm. It is included in the fixed arm, because the shipped policy was not
 * chosen from this data at all — that asymmetry is the point of running both.
 */
function walkForward(rows, opts) {
  const folds = Math.max(2, (opts && opts.folds) || 5);
  const minTrain = (opts && opts.minTrain) || 100;
  const grid = (opts && opts.grid) || defaultGrid();
  const objective = (opts && opts.objective) || 'clv_mean';

  const sorted = [...rows].sort((a, b) => Date.parse(a.decision_at) - Date.parse(b.decision_at));
  const size = Math.floor(sorted.length / folds);
  if (size < 1) return { ok: false, reason: `only ${sorted.length} rows — not enough for ${folds} folds` };

  const cuts = [];
  for (let i = 0; i < folds; i++) {
    cuts.push(sorted.slice(i * size, i === folds - 1 ? sorted.length : (i + 1) * size));
  }

  const fixedOOS = [], sweptOOS = [], perFold = [];
  for (let i = 0; i < folds; i++) {
    const valid = cuts[i];
    const train = sorted.slice(0, i * size);
    const validRange = [valid[0] && valid[0].decision_at, valid[valid.length - 1] && valid[valid.length - 1].decision_at];

    /* THE FIXED ARM. The shipped policy applied to this fold. It was not chosen
       from any of this data, so every fold is out of sample for it. */
    const fixedSel = valid.filter((r) => policyAdmits(decisionView(r), SHIPPED_POLICY));
    fixedOOS.push(...fixedSel);

    /* THE SWEPT ARM. Choose on train, apply to valid, never the reverse. */
    let chosen = null, sweptSel = [];
    if (train.length >= minTrain) {
      let best = null;
      for (const p of grid) {
        const sel = train.filter((r) => policyAdmits(decisionView(r), p));
        if (sel.length < 30) continue;                 // a policy that selects nothing proves nothing
        const s = score(sel, p.name);
        const v = objective === 'roi' ? s.roi : s.clv_mean;
        if (v == null) continue;
        if (!best || v > best.v) best = { v, p, n: sel.length };
      }
      if (best) {
        chosen = best;
        sweptSel = valid.filter((r) => policyAdmits(decisionView(r), best.p));
        sweptOOS.push(...sweptSel);
      }
    }

    perFold.push({
      fold: i,
      train_rows: train.length,
      valid_rows: valid.length,
      valid_from: validRange[0], valid_to: validRange[1],
      fixed: score(fixedSel, `fold${i}:fixed`),
      chosen_policy: chosen ? chosen.p : null,
      chosen_on_train_objective: chosen ? chosen.v : null,
      swept: chosen ? score(sweptSel, `fold${i}:swept`) : null,
      note: train.length < minTrain
        ? `no swept arm: ${train.length} training rows is below the ${minTrain} minimum, and a policy `
          + `chosen from too little history is noise with a threshold attached`
        : null,
    });
  }

  return {
    ok: true,
    folds, objective,
    per_fold: perFold,
    fixed_oos: scoreAllSegments(dedupe(fixedOOS)),
    swept_oos: sweptOOS.length ? scoreAllSegments(dedupe(sweptOOS)) : null,
    overfitting_gap: (() => {
      const f = score(dedupe(fixedOOS), 'fixed'), s = sweptOOS.length ? score(dedupe(sweptOOS), 'swept') : null;
      if (!s || f.roi == null || s.roi == null) return null;
      return {
        fixed_roi: f.roi, swept_roi: s.roi, gap: s.roi - f.roi,
        note: 'The swept arm chose thresholds on earlier folds and was applied to later ones, so both are out '
          + 'of sample. A large positive gap means the tuning generalised; a gap near zero or negative means '
          + 'the sweep was fitting noise and the shipped defaults are as good as anything found.',
      };
    })(),
  };
}

/** The threshold grid. Small on purpose: every extra dimension multiplies the
    number of chances the sweep has to find noise that looks like signal. */
function defaultGrid() {
  const grid = [];
  for (const eA of [0.010, 0.015, 0.020, 0.030]) {
    for (const eB of [0.020, 0.025, 0.035, 0.050]) {
      for (const streak of [1, 2, 3]) {
        for (const tierA of [false, true]) {
          grid.push({
            ...SHIPPED_POLICY,
            name: `A>=${eA} B>=${eB} streak>=${streak}${tierA ? ' tierAonly' : ''}`,
            minEdgeA: eA, minEdgeB: eB, minStreakB: streak, requireTierA: tierA,
          });
        }
      }
    }
  }
  return grid;
}

// ═══════════════════════════════════════════════════════════════════════════
// DEVIG METHOD COMPARISON (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which de-vig method calibrates best, per segment, measured out of sample.
 *
 * Needs the RAW two-way reference price (pin_dec / pin_opp_dec) and a settled
 * result. capture v9 writes both; capture v8 wrote neither, so on any history
 * predating v9 this correctly reports that it cannot answer instead of
 * answering from data it does not have.
 */
function devigComparison(rows, devigFn) {
  const usable = rows.filter((r) => r.pin_dec > 1 && r.pin_opp_dec > 1
    && (r.result === 'win' || r.result === 'loss'));
  if (usable.length < 100) {
    return {
      ok: false,
      usable: usable.length,
      reason: `only ${usable.length} rows carry a raw two-way reference price AND a settled result. `
        + `A de-vig comparison below ~100 rows per segment cannot separate the methods — they differ by `
        + `well under a point of probability on a normal two-way market. capture v8 never wrote pin_dec, `
        + `so this fills in only for signals captured under v9.`,
    };
  }
  const methods = ['shin', 'multiplicative', 'power'];
  const bySeg = new Map();
  usable.forEach((r) => {
    const k = `${r.sport_title || r.sport_key}|${r.market}`;
    if (!bySeg.has(k)) bySeg.set(k, []);
    bySeg.get(k).push(r);
  });
  const out = {};
  for (const [seg, rs] of bySeg) {
    if (rs.length < 100) { out[seg] = { n: rs.length, verdict: 'too few rows to separate the methods' }; continue; }
    const res = {};
    for (const m of methods) {
      const pairs = rs.map((r) => {
        const f = devigFn([Number(r.pin_dec), Number(r.pin_opp_dec)], m);
        return [f[0], r.result === 'win' ? 1 : 0];
      });
      res[m] = { brier: brier(pairs), log_loss: logLoss(pairs), ece: calibration(pairs).ece };
    }
    const best = methods.slice().sort((a, b) => res[a].brier - res[b].brier)[0];
    const spread = Math.max(...methods.map((m) => res[m].brier)) - Math.min(...methods.map((m) => res[m].brier));
    out[seg] = {
      n: rs.length, by_method: res, best_by_brier: best,
      brier_spread: spread,
      verdict: spread < 0.0005
        ? `no meaningful difference (Brier spread ${spread.toFixed(5)}). Keep shin; changing the policy on `
          + `this evidence would be fitting noise.`
        : `${best} calibrates best by Brier, spread ${spread.toFixed(5)}. Worth a DEVIG_POLICY entry if it `
          + `holds on the next fold too.`,
    };
  }
  return { ok: true, segments: out };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOADING AND REPORTING
// ═══════════════════════════════════════════════════════════════════════════

function loadNdjson(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const rows = [];
  const bad = [];
  txt.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      const o = JSON.parse(t);
      if (!o.decision_at || !(o.entry_dec > 1)) { bad.push({ line: i + 1, why: 'no decision_at or no entry price' }); return; }
      rows.push(o);
    } catch (e) { bad.push({ line: i + 1, why: 'unparseable' }); }
  });
  return { rows, bad };
}

function pct(x) { return x == null ? '—' : (x * 100).toFixed(2) + '%'; }
function ci(x) { return x == null ? '—' : `[${(x[0] * 100).toFixed(1)}%, ${(x[1] * 100).toFixed(1)}%]`; }

function printSegment(s) {
  console.log(`\n  ${s.label}`);
  console.log(`    n=${s.n}  settled=${s.settled}  W-L-P ${s.wins}-${s.losses}-${s.pushes}`);
  console.log(`    win rate      ${pct(s.win_rate)}  95% CI ${ci(s.win_rate_ci)}   break-even ${pct(s.break_even_rate)} (avg ${s.avg_decimal_odds ? s.avg_decimal_odds.toFixed(3) : '—'})`);
  console.log(`    ROI           ${pct(s.roi)}  95% CI ${ci(s.roi_ci)}   units ${s.units == null ? '—' : s.units.toFixed(2)}   max DD ${s.max_drawdown_units == null ? '—' : s.max_drawdown_units.toFixed(2)}u`);
  console.log(`    CLV           mean ${pct(s.clv_mean)}  median ${pct(s.clv_median)}  hit ${pct(s.clv_hit_rate)} ${ci(s.clv_hit_rate_ci)}  (n=${s.clv_n})`);
  if (s.line_clv_n) console.log(`    line CLV      ${s.line_clv_mean_points.toFixed(3)} pts over ${s.line_clv_n} handicap bets`);
  console.log(`    calibration   Brier ${s.brier == null ? '—' : s.brier.toFixed(4)}  logloss ${s.log_loss == null ? '—' : s.log_loss.toFixed(4)}  ECE ${s.calibration && s.calibration.ece != null ? s.calibration.ece.toFixed(4) : '—'}`);
  console.log(`    ${s.verdict}`);
}

function report(result, opts) {
  console.log('='.repeat(78));
  console.log('EDGEDESK BACKTEST — chronological walk-forward, no leakage');
  console.log('='.repeat(78));
  if (!result.ok) { console.log('\n  ' + result.reason); return; }
  console.log(`\nfolds: ${result.folds}   objective for the swept arm: ${result.objective}`);
  console.log(`minimum settled bets before a segment is called proven: ${MIN_N_PROVEN}`);

  console.log('\n' + '-'.repeat(78));
  console.log('PER FOLD (validation is always later in time than training)');
  console.log('-'.repeat(78));
  result.per_fold.forEach((f) => {
    console.log(`\nfold ${f.fold}: train ${f.train_rows} rows -> validate ${f.valid_rows} rows `
      + `(${String(f.valid_from).slice(0, 10)} .. ${String(f.valid_to).slice(0, 10)})`);
    console.log(`  fixed  : n=${f.fixed.n} win ${pct(f.fixed.win_rate)} ROI ${pct(f.fixed.roi)} CLV ${pct(f.fixed.clv_mean)}`);
    if (f.swept) console.log(`  swept  : n=${f.swept.n} win ${pct(f.swept.win_rate)} ROI ${pct(f.swept.roi)} CLV ${pct(f.swept.clv_mean)}  <- ${f.chosen_policy.name}`);
    if (f.note) console.log(`  note   : ${f.note}`);
  });

  console.log('\n' + '='.repeat(78));
  console.log('OUT-OF-SAMPLE RESULTS — THE SHIPPED POLICY (this is the headline)');
  console.log('='.repeat(78));
  const order = ['ALL', 'HEADLINE:football standard spreads+totals', 'tier:A', 'tier:B'];
  order.forEach((k) => { if (result.fixed_oos[k]) printSegment(result.fixed_oos[k]); });
  Object.keys(result.fixed_oos).sort().forEach((k) => {
    if (order.indexOf(k) < 0 && result.fixed_oos[k].n >= 25) printSegment(result.fixed_oos[k]);
  });

  if (result.overfitting_gap) {
    console.log('\n' + '-'.repeat(78));
    console.log(`OVERFITTING GAP: fixed ROI ${pct(result.overfitting_gap.fixed_roi)} vs swept ROI `
      + `${pct(result.overfitting_gap.swept_roi)} (gap ${pct(result.overfitting_gap.gap)})`);
    console.log(result.overfitting_gap.note);
  }
  if (opts && opts.devig) {
    console.log('\n' + '-'.repeat(78));
    console.log('DE-VIG METHOD, MEASURED');
    console.log(JSON.stringify(opts.devig, null, 2));
  }
}

// ═══════════════════════════════════════════════════════════════════════════

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
  const folds = argv.includes('--folds') ? Number(argv[argv.indexOf('--folds') + 1]) : 5;
  const perEvent = argv.includes('--per-event');

  if (!file) {
    console.error('usage: node tools/capture/backtest.js <history.ndjson> [--folds N] [--json out.json] [--per-event]');
    console.error('');
    console.error('Produce the input with:  node tools/capture/export_history.js > history.ndjson');
    console.error('(that needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, because `signals` is RLS-protected)');
    console.error('');
    console.error('THERE IS NO HISTORICAL SIGNAL DATA IN THIS REPOSITORY. record/grades.json is an empty seed and');
    console.error('the signals table lives only in Supabase, so this harness cannot be run to a number from a');
    console.error('clean checkout. That is a statement of fact, not a failure of the harness.');
    process.exit(2);
  }
  if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2); }

  const { rows, bad } = loadNdjson(file);
  console.log(`loaded ${rows.length} rows${bad.length ? `, skipped ${bad.length} unusable` : ''}`);
  const deduped = dedupe(rows, { perEvent });
  console.log(`after de-duplication: ${deduped.length} independent observations `
    + `(${rows.length - deduped.length} collapsed as the same bet seen more than once)`);

  const graded = deduped.filter((r) => r.result === 'win' || r.result === 'loss' || r.result === 'push');
  console.log(`graded: ${graded.length}   ungraded (still pending): ${deduped.length - graded.length}`);
  if (!graded.length) {
    console.log('\nNothing is graded yet, so there is no out-of-sample result to report. This is the honest');
    console.log('answer, not an error: run again once games have settled.');
    process.exit(1);
  }

  const result = walkForward(graded, { folds });
  let devig = null;
  try {
    const cap = await import('../../supabase/functions/capture/index.ts');
    devig = devigComparison(graded, cap.devig);
  } catch (e) { devig = { ok: false, reason: 'could not load capture devig: ' + e.message }; }

  report(result, { devig });
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ generated_from: file, rows: rows.length, deduped: deduped.length, graded: graded.length, result, devig }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

module.exports = {
  DECISION_FIELDS, OUTCOME_FIELDS, decisionView,
  wilson, bootstrapCI, brier, logLoss, calibration, maxDrawdown, medianOf, mean,
  unitPnl, priceCLV, lineCLV, dedupe, policyAdmits, SHIPPED_POLICY, defaultGrid,
  score, segmentsOf, scoreAllSegments, walkForward, devigComparison, loadNdjson, MIN_N_PROVEN,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
