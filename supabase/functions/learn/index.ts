// ============================================================
//  FILE:    supabase/functions/learn/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy learn --no-verify-jwt
//  CRON:    hourly is plenty; nightly is fine.
// ============================================================
// LEARN — turns graded signals into knowledge that is allowed to be quoted.
//
// The previous rebuild was a GROUP BY with a minimum sample size. That is not a
// learning loop, it is a leaderboard: slice a few hundred bets nine ways and
// something always looks like a 60% edge. This replaces it with the discipline
// that separates a discovered pattern from a discovered coincidence.
//
// SIX RULES, AND WHY EACH ONE EXISTS
//
// 1. LEARN ON CLV, NOT ON WIN/LOSS.
//    Win rate at n=100 is almost entirely noise — a 55% true edge and a 45%
//    losing strategy overlap heavily at that sample. Beating the close is a
//    far lower-variance signal, it is available hours after the bet instead of
//    seasons later, and it is the thing this product actually claims. W/L is
//    recorded but never drives a pattern.
//
// 2. THE HYPOTHESES ARE PRE-REGISTERED, IN CODE.
//    Every question this function will ever ask is in HYPOTHESES below. You
//    cannot data-dredge a fixed list. If a new slice is worth testing it gets
//    added deliberately, as a code change, which is exactly the friction that
//    should exist before "I noticed something on Tuesdays" becomes a claim.
//
// 3. CHRONOLOGICAL HOLDOUT, NOT A RANDOM SPLIT.
//    Discovery runs on the older 70%, confirmation on the newer 30%. A random
//    split leaks the future into the past — the market regime a bet was placed
//    in is the whole point. A pattern that only worked before the holdout is a
//    pattern that stopped working.
//
// 4. MULTIPLE-COMPARISON CONTROL (Benjamini-Hochberg, q = 0.10).
//    Testing ~40 hypotheses at p<0.05 yields two false positives by
//    construction. BH controls the false DISCOVERY rate across the family, so
//    "confirmed" means confirmed relative to everything else that was asked.
//
// 5. AN EFFECT FLOOR.
//    A statistically significant 51.5% beat rate is real and worthless. A
//    pattern must clear both significance and a minimum edge over the base
//    rate before it is allowed to be quoted at all.
//
// 6. PATTERNS EXPIRE.
//    A CONFIRMED pattern that stops holding on fresh data is demoted, not
//    quietly left standing. Markets adapt; a learning loop that can only add
//    beliefs is a superstition generator.
//
// It also builds a CALIBRATION table, which is the most immediately useful
// thing here and needs no pattern at all: for each predicted-edge bucket, what
// CLV actually came back. "When EdgeDesk says +3%, it realises +1.2%" improves
// every decision without changing a single model coefficient.
//
// SECURITY: runs with the service role because it must aggregate across users
// to reach a usable sample. It is a cron job — it takes no user input, runs no
// caller-supplied SQL, and returns only aggregates. The research engine that
// talks to the model still runs under the caller's JWT with RLS and never
// holds this key.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/* Tunables. Deliberately conservative; loosening them is a decision, not a default. */
export const MIN_N = Number(Deno.env.get('LEARN_MIN_N') ?? '30');          // schema floor too
export const MIN_HOLDOUT = Number(Deno.env.get('LEARN_MIN_HOLDOUT') ?? '10');
export const FDR_Q = Number(Deno.env.get('LEARN_FDR_Q') ?? '0.10');
export const EFFECT_FLOOR = Number(Deno.env.get('LEARN_EFFECT_FLOOR') ?? '0.04'); // 4pp over base
export const HOLDOUT_FRAC = Number(Deno.env.get('LEARN_HOLDOUT_FRAC') ?? '0.30');

/* Bumped whenever this file changes in a way you would want to confirm landed.
   Returned on every response, because "is the new build actually deployed?"
   should be answerable rather than inferred from whether the old bug recurs. */
export const BUILD = '2026-08-13.3-actionable-only';

/* ========================================================================
   STATISTICS — pure, exported, tested. No database, no network.
   ======================================================================== */

/** Wilson score interval, lower bound. Honest at small n where normal is not. */
export function wilsonLo(k: number, n: number, z = 1.96): number | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (centre - margin) / denom;
}

/** Abramowitz-Stegun 7.1.26 error function; ~1e-7 absolute, ample here. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Two-sided p for k successes in n against base rate p0.
 * Normal approximation with a continuity correction — adequate at n>=30, which
 * is the floor anyway, and it keeps this dependency-free.
 */
export function twoSidedP(k: number, n: number, p0 = 0.5): number | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return null;
  if (p0 <= 0 || p0 >= 1) return null;
  const sd = Math.sqrt(n * p0 * (1 - p0));
  if (!(sd > 0)) return null;
  const diff = Math.abs(k - n * p0) - 0.5;          // continuity correction
  if (diff <= 0) return 1;
  return Math.min(1, 2 * (1 - normalCdf(diff / sd)));
}

/**
 * Benjamini-Hochberg. Returns, per input index, the adjusted q-value and
 * whether it is significant at the given FDR level.
 *
 * Controls the expected proportion of FALSE discoveries among the things
 * called significant — the right control when you are asking many questions
 * and want to keep the interesting ones, rather than Bonferroni's "keep almost
 * nothing".
 */
export function benjaminiHochberg(pvals: number[], q = FDR_Q): { qvalue: number; significant: boolean }[] {
  const m = pvals.length;
  if (!m) return [];
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  // Step-up: find the largest rank whose p <= (rank/m)*q; everything at or
  // below that rank is significant.
  let cutoffRank = 0;
  for (let r = 1; r <= m; r++) if (order[r - 1].p <= (r / m) * q) cutoffRank = r;

  // Monotone q-values, computed from the top down so they never decrease.
  const out = new Array(m).fill(null).map(() => ({ qvalue: 1, significant: false }));
  let running = 1;
  for (let r = m; r >= 1; r--) {
    const { p, i } = order[r - 1];
    running = Math.min(running, (p * m) / r);
    out[i] = { qvalue: Math.min(1, running), significant: r <= cutoffRank };
  }
  return out;
}

/* ========================================================================
   THE PRE-REGISTERED HYPOTHESIS FAMILY
   ======================================================================== */

export interface Graded {
  sport_key: string | null;
  market: string | null;
  beat_close: boolean | null;
  clv: number | null;
  edge: number | null;
  best_dec: number | null;
  n_books: number | null;
  has_sharp: boolean | null;
  corrob_n: number | null;
  commence_time: string | null;
  graded_at: string | null;
}

/** US-Eastern slate day of a kickoff, matching the rest of the engine. */
export function etDow(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // Slate day boundary is 6h before midnight ET, same rule the board uses.
  const d = new Date(t - 6 * 3600000);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.getDay();                                    // 0 = Sunday
}

/**
 * An edge above this is not a price, it is a bad line.
 *
 * In a two-way market with a sharp reference, a genuine 25%+ edge does not
 * survive contact with reality — it is a stale quote, a limit-zero screen
 * price, or a de-vig that failed. The live data had 458 rows with a MEDIAN
 * edge of +40.5%, which is not a portfolio of enormous edges; it is a pile of
 * broken prices, and it was 13% of everything being learned from.
 */
export const EDGE_SANE_MAX = Number(Deno.env.get('LEARN_EDGE_MAX') ?? '0.25');

/**
 * Bands over the edge at capture.
 *
 * The first version sent every NEGATIVE edge into 'edge<1%', because it was
 * written assuming this table holds flagged bets. It does not — `signals` is
 * the full capture, every priced selection, and 78% of it has a negative edge
 * and was never actionable. Lumping those in produced a 17.5% "beat rate" that
 * was really measuring "how often does a selection nobody would bet close
 * better than it opened", which is a question with an obvious and useless
 * answer. Negative and implausible edges now have their own bands so they can
 * be seen and excluded rather than silently averaged in.
 */
export function edgeBand(edge: number | null): string | null {
  if (edge == null || !Number.isFinite(edge)) return null;
  if (edge <= 0) return 'negative edge (not actionable)';
  if (edge > EDGE_SANE_MAX) return `implausible edge (>${(EDGE_SANE_MAX * 100).toFixed(0)}%)`;
  if (edge < 0.01) return 'edge 0-1%';
  if (edge < 0.02) return 'edge 1-2%';
  if (edge < 0.04) return 'edge 2-4%';
  if (edge < 0.08) return 'edge 4-8%';
  return 'edge 8-25%';
}

/** Was this row ever something EdgeDesk would put in front of a user? */
export function isActionable(g: { edge: number | null }): boolean {
  return g.edge != null && Number.isFinite(g.edge) && g.edge > 0 && g.edge <= EDGE_SANE_MAX;
}

export function priceBand(dec: number | null): string | null {
  if (dec == null || !(dec > 1)) return null;
  if (dec < 1.5) return 'heavy favourite';
  if (dec < 2.0) return 'favourite';
  if (dec < 3.0) return 'modest dog';
  return 'big dog';
}

export function booksBand(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 8) return 'thin book coverage';
  if (n < 20) return 'normal book coverage';
  return 'deep book coverage';
}

/**
 * Every question this function is permitted to ask. Adding one is a code
 * change on purpose — that friction is the anti-dredging device.
 */
export const HYPOTHESES: { family: string; label: (g: Graded) => string | null; describe: (level: string) => string }[] = [
  { family: 'sport', label: (g) => g.sport_key ?? null,
    describe: (l) => `EdgeDesk signals in ${l}` },
  { family: 'market', label: (g) => g.market ?? null,
    describe: (l) => `EdgeDesk signals in the ${l} market` },
  { family: 'weekpart', label: (g) => { const d = etDow(g.commence_time); return d == null ? null : (d === 0 || d === 6) ? 'weekend' : 'weekday'; },
    describe: (l) => `signals on games that start on a ${l}` },
  { family: 'dow', label: (g) => { const d = etDow(g.commence_time); return d == null ? null : ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d]; },
    describe: (l) => `signals on games that start on a ${l}` },
  { family: 'edge_band', label: (g) => edgeBand(g.edge),
    describe: (l) => `signals flagged at ${l}` },
  { family: 'price_band', label: (g) => priceBand(g.best_dec),
    describe: (l) => `signals on a ${l}` },
  { family: 'books', label: (g) => booksBand(g.n_books),
    describe: (l) => `signals found with ${l}` },
  { family: 'sharp', label: (g) => g.has_sharp == null ? null : g.has_sharp ? 'Pinnacle quoting this side' : 'no Pinnacle print on this side',
    describe: (l) => `signals where there was ${l}` },
  /* There is deliberately no `verdict` family. Verdict is computed in the
     browser from the deterministic engine's output and is never persisted on
     signals, so asking about it meant selecting a column that does not exist.
     Corroboration is the stored field that carries similar information: how
     many independent sharp sources agreed before the signal was raised. */
  { family: 'corroboration', label: (g) => g.corrob_n == null ? null
      : g.corrob_n >= 3 ? 'three or more corroborating sources'
      : g.corrob_n === 2 ? 'two corroborating sources'
      : g.corrob_n === 1 ? 'one corroborating source' : 'no corroboration',
    describe: (l) => `signals raised with ${l}` },
];

/* ========================================================================
   EVALUATION
   ======================================================================== */

export interface Evaluated {
  family: string; level: string; key: string; description: string;
  n: number; k: number; rate: number; lo: number | null;
  n_discovery: number; lo_discovery: number | null;
  n_holdout: number; lo_holdout: number | null; rate_holdout: number | null;
  avg_clv: number | null;
  p: number; qvalue: number; significant: boolean;
  effect: number; base_rate: number;
  status: 'CONFIRMED' | 'CANDIDATE' | 'REJECTED';
  why: string;
}

/** Chronological split: older rows discover, newer rows confirm. */
export function splitChrono<T extends { graded_at: string | null }>(rows: T[], frac = HOLDOUT_FRAC) {
  const sorted = [...rows].sort((a, b) =>
    String(a.graded_at ?? '').localeCompare(String(b.graded_at ?? '')));
  const cut = Math.max(0, Math.floor(sorted.length * (1 - frac)));
  return { discovery: sorted.slice(0, cut), holdout: sorted.slice(cut) };
}

/**
 * Beating the close IS a positive CLV, so derive it rather than trusting a
 * generated column whose definition is not visible from here.
 *
 * CLV = entry_decimal x closing_fair - 1. Positive means the price taken was
 * better than the de-vigged closing fair. That is the definition; reading it
 * off `beat_close` adds a dependency on a column expression this function
 * cannot inspect, and if that expression disagrees the disagreement is silent.
 * It is now measured and reported instead (see beatCloseAgreement).
 */
const beat = (g: Graded) => g.clv != null && g.clv > 0;

/** Does the stored generated column agree with the definition? */
export function beatCloseAgreement(rows: Graded[]) {
  const both = rows.filter((r) => clvIsReal(r.clv) && r.beat_close != null);
  const agree = both.filter((r) => (r.clv! > 0) === (r.beat_close === true)).length;
  return {
    comparable: both.length,
    agree,
    disagree: both.length - agree,
    stored_true_rate: both.length ? +(both.filter((r) => r.beat_close === true).length / both.length).toFixed(4) : null,
    derived_true_rate: both.length ? +(both.filter((r) => r.clv! > 0).length / both.length).toFixed(4) : null,
    reading: !both.length ? 'nothing comparable'
      : both.length === agree
        ? 'beat_close agrees with clv > 0 on every comparable row, so the outcome column is not the problem.'
        : `beat_close disagrees with clv > 0 on ${both.length - agree} of ${both.length} rows — the generated `
          + `column is not simply (clv > 0), and any rate computed from it is measuring something else.`,
  };
}

/**
 * A signal only has an OUTCOME on this metric if a real CLV was computed.
 *
 * beat_close is a generated column, so a signal that never reached the close
 * job resolves to `false` rather than null — and roughly three quarters of the
 * history is in that state. Counting those as losses put the population beat
 * rate at 17%, which is not a finding about EdgeDesk, it is a finding about
 * un-closed rows. Every pattern built on that base rate would have been
 * measuring which slices get CLOSED properly, not which slices beat the close.
 *
 * A CLV outside the plausible band is likewise not an outcome. The old close
 * bug wrote exactly -1 whenever the entry price was missing, and those rows are
 * still in the history — averaging a fabricated -100% with real results is how
 * a 17% population beat rate appears out of a pipeline that should sit near 50%.
 *
 * No real CLV means no outcome. Such rows are excluded, never counted against.
 */
/**
 * A row counts as an outcome only if it had a real CLV AND was actionable.
 *
 * Learning from every priced selection answers the wrong question. The loop
 * exists to say something about the bets EdgeDesk would actually surface, so
 * the population is flagged signals with a plausible edge — not the capture
 * table, and not the broken prices inside it.
 */
const hasOutcome = (g: Graded) => clvIsReal(g.clv) && isActionable(g);

/**
 * Score every level of every pre-registered hypothesis, then apply BH across
 * the whole family at once. The base rate is the population's own beat rate,
 * not 0.5 — the question is never "does this beat a coin", it is "does this
 * slice beat EdgeDesk's own average".
 */
/**
 * A base rate this far from even is a data fault, not a discovery.
 *
 * Every pattern here is measured AGAINST the population beat rate, so if that
 * number is wrong, all of them are wrong in the same direction and none of the
 * statistics downstream can detect it — the yardstick itself is bent. A live
 * run reported 17.35%, which was un-closed rows counted as losses. Anything
 * outside this band means the outcome column is contaminated and the run's
 * output must not be quoted.
 */
export const BASE_RATE_SANE = { lo: 0.30, hi: 0.70 };

/**
 * The plausible range for a real CLV.
 *
 * CLV is entry_decimal x closing_fair_probability - 1. For a two-way market
 * the close rarely moves the fair price more than a few points, so real values
 * cluster inside roughly +/-15% and essentially never leave +/-50%. A value at
 * or near -1 is the signature of the old close bug, which computed
 * `(best_dec ?? 0) * closeFair - 1` and so produced exactly -100% whenever the
 * entry price was missing. Those rows are still in the history; they are
 * fabrications, not losses, and they must not be averaged with real outcomes.
 */
export const CLV_SANE = { lo: -0.5, hi: 0.5 };

export function clvIsReal(clv: number | null | undefined): boolean {
  return clv != null && Number.isFinite(clv) && clv >= CLV_SANE.lo && clv <= CLV_SANE.hi;
}

/**
 * How far the sharp fair price MOVED between entry and close.
 *
 * This is derivable exactly, with no new data, because the entry price cancels:
 *   edge = fair_entry x dec - 1      ->  fair_entry = (1 + edge) / dec
 *   clv  = dec x fair_close - 1      ->  fair_close = (1 + clv)  / dec
 *   fair_entry / fair_close = (1 + edge) / (1 + clv)
 *
 * A positive edge at entry with a negative CLV at close means, arithmetically,
 * that the entry fair was HIGHER than the closing fair. This quantifies by how
 * much, and separates the two explanations that matter:
 *
 *   retention ~ 0     the projected edge is not being realised at all; the
 *                     entry fair is inflated by roughly the edge itself, so
 *                     the "edge" is measurement error rather than value
 *   retention ~ 1     the edge is real and survives, and a negative CLV would
 *                     have to come from somewhere else entirely
 *   drift constant    a fixed offset in the fair price - a de-vig or book-set
 *                     difference between capture and close, and fixable
 *   drift scales      bigger flagged edges drift more, the signature of edges
 *                     driven by noise in a thin book set
 */
export function fairDrift(rows: Graded[]) {
  const usable = rows.filter((r) => clvIsReal(r.clv) && r.edge != null && Number.isFinite(r.edge));
  const med = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const summarise = (rs: Graded[]) => {
    if (!rs.length) return null;
    const drift = rs.map((r) => (1 + r.edge!) / (1 + r.clv!));
    const edges = rs.map((r) => r.edge!);
    const clvs = rs.map((r) => r.clv!);
    const mE = med(edges)!, mC = med(clvs)!;
    return {
      n: rs.length,
      median_edge: +mE.toFixed(5),
      median_clv: +mC.toFixed(5),
      /* How much of the projected edge actually showed up at the close. */
      edge_retention: mE !== 0 ? +(mC / mE).toFixed(3) : null,
      /* fair_entry / fair_close. Above 1 means the entry fair was optimistic. */
      median_fair_ratio: +med(drift)!.toFixed(5),
      fair_overstated_pct: +((med(drift)! - 1) * 100).toFixed(2),
    };
  };

  const overall = summarise(usable);
  const byBand: Record<string, unknown> = {};
  for (const b of ['edge 0-1%', 'edge 1-2%', 'edge 2-4%', 'edge 4-8%', 'edge 8-25%']) {
    const rs = usable.filter((r) => edgeBand(r.edge) === b);
    if (rs.length >= 20) byBand[b] = summarise(rs);
  }

  const bands = Object.values(byBand) as any[];
  const spread = bands.length >= 2
    ? Math.max(...bands.map((b) => b.fair_overstated_pct)) - Math.min(...bands.map((b) => b.fair_overstated_pct))
    : null;

  return {
    ...overall, by_edge_band: byBand,
    reading: !overall ? 'no rows carry both an edge and a CLV'
      : overall.edge_retention != null && overall.edge_retention <= 0.1
        ? `Of a median projected edge of ${(overall.median_edge * 100).toFixed(2)}%, `
          + `${(overall.median_clv * 100).toFixed(2)}% was realised — retention ${overall.edge_retention}. `
          + `The entry fair price is overstated by ${overall.fair_overstated_pct}% relative to the close`
          + (spread != null && spread > 2
            ? `, and the overstatement GROWS with the flagged edge (${spread.toFixed(1)}pp spread across bands), `
              + `which is the signature of edges driven by noise in a thin book set rather than by real value.`
            : `, and the overstatement is roughly CONSTANT across edge bands, which points at a systematic `
              + `de-vig or book-set difference between capture and close rather than at the edge model.`)
      : `Median projected edge ${(overall.median_edge * 100).toFixed(2)}%, median realised `
        + `${(overall.median_clv * 100).toFixed(2)}%, retention ${overall.edge_retention}.`,
  };
}

/**
 * What the capture table actually contains, so the population being learned
 * from is stated rather than assumed. This is the breakdown that would have
 * made the first three runs unnecessary.
 */
export function population(rows: Graded[]) {
  const withClv = rows.filter((r) => clvIsReal(r.clv));
  const negative = withClv.filter((r) => r.edge != null && r.edge <= 0).length;
  const absurd = withClv.filter((r) => r.edge != null && r.edge > EDGE_SANE_MAX).length;
  const noEdge = withClv.filter((r) => r.edge == null).length;
  const actionable = withClv.filter(isActionable);
  const beatRate = actionable.length
    ? actionable.filter((r) => r.clv! > 0).length / actionable.length : null;
  return {
    rows_with_clv: withClv.length,
    negative_edge_never_actionable: negative,
    implausible_edge_bad_price: absurd,
    no_edge_recorded: noEdge,
    actionable: actionable.length,
    actionable_beat_rate: beatRate == null ? null : +beatRate.toFixed(4),
    reading: `${withClv.length} rows carry a real CLV. ${negative} have a negative edge and were never `
      + `actionable; ${absurd} carry an edge above ${(EDGE_SANE_MAX * 100).toFixed(0)}%, which is a broken `
      + `price rather than an opportunity. That leaves ${actionable.length} genuinely flagged signals`
      + (beatRate == null ? '.' : `, which beat the close ${(beatRate * 100).toFixed(1)}% of the time.`),
  };
}

/** Distribution of CLV, so the shape of the history is a fact rather than a guess. */
export function clvProfile(rows: { clv: number | null; clv_excluded_reason?: string | null }[]) {
  const bands = [
    ['<= -0.9 (fabricated -100%)', (v: number) => v <= -0.9],
    ['-0.9 to -0.5', (v: number) => v > -0.9 && v <= -0.5],
    ['-0.5 to -0.15', (v: number) => v > -0.5 && v <= -0.15],
    ['-0.15 to 0', (v: number) => v > -0.15 && v <= 0],
    ['0 to 0.15', (v: number) => v > 0 && v <= 0.15],
    ['0.15 to 0.5', (v: number) => v > 0.15 && v <= 0.5],
    ['> 0.5', (v: number) => v > 0.5],
  ] as [string, (v: number) => boolean][];

  const vals = rows.map((r) => r.clv).filter((v): v is number => v != null && Number.isFinite(v));
  const hist: Record<string, number> = {};
  for (const [label] of bands) hist[label] = 0;
  for (const v of vals) for (const [label, test] of bands) if (test(v)) { hist[label]++; break; }

  const sorted = [...vals].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
  const real = vals.filter(clvIsReal);

  return {
    rows: rows.length,
    clv_null: rows.filter((r) => r.clv == null).length,
    with_excluded_reason: rows.filter((r) => r.clv_excluded_reason != null).length,
    exactly_minus_one: vals.filter((v) => v <= -0.999 && v >= -1.001).length,
    histogram: hist,
    min: sorted[0] ?? null, p25: at(0.25), median: at(0.5), p75: at(0.75), max: sorted[sorted.length - 1] ?? null,
    plausible: real.length,
    plausible_beat_rate: real.length ? +(real.filter((v) => v > 0).length / real.length).toFixed(4) : null,
    reading: real.length
      ? `${real.length} of ${vals.length} CLV values are inside the plausible ${CLV_SANE.lo}..${CLV_SANE.hi} band; `
        + `those beat the close ${((real.filter((v) => v > 0).length / real.length) * 100).toFixed(1)}% of the time.`
      : 'No CLV value is inside the plausible band — the close job is producing values that are not CLV.',
  };
}

/**
 * Is an unusual base rate a DATA fault, or a real and unflattering result?
 *
 * These are different things and the first version conflated them: it saw 17.5%
 * and refused to write, on the assumption that a number that far from even had
 * to be contamination. The profile then showed a clean population — no
 * fabricated values, no nulls, no exclusion reasons, a smooth distribution, and
 * the stored beat_close column agreeing with clv > 0 on all 3539 rows.
 *
 * So the yardstick was not bent. The signals genuinely close worse than they
 * open. That is a finding about the pricing engine, and refusing to learn from
 * it would be the tool protecting a conclusion rather than reporting one.
 *
 * Contamination now has to be POSITIVELY identified before anything is blocked.
 * An unusual but clean base rate proceeds, loudly.
 */
export function contamination(
  rows: { clv: number | null; clv_excluded_reason?: string | null }[],
  agreement: { disagree: number },
): { contaminated: boolean; issues: string[] } {
  const p = clvProfile(rows);
  const issues: string[] = [];
  if (p.exactly_minus_one > 0) {
    issues.push(`${p.exactly_minus_one} rows carry exactly -1, the signature of the old close bug computing `
      + `(best_dec ?? 0) * closeFair - 1 with no entry price.`);
  }
  if (p.histogram['> 0.5'] > 0 || p.histogram['-0.9 to -0.5'] > 0) {
    issues.push(`${p.histogram['> 0.5'] + p.histogram['-0.9 to -0.5']} rows sit outside any plausible CLV range.`);
  }
  if (agreement.disagree > 0) {
    issues.push(`beat_close disagrees with clv > 0 on ${agreement.disagree} rows, so the stored outcome column `
      + `is not the definition and any rate taken from it measures something else.`);
  }
  return { contaminated: issues.length > 0, issues };
}

/**
 * A clean population with an extreme rate is not blocked — it is reported. The
 * statistics below still work: every slice is measured against the population's
 * OWN rate, so "beats 17.5%" remains a meaningful comparison even when 17.5% is
 * itself bad news.
 */
export function baseRateWarning(base: number, n: number): string | null {
  if (!n) return null;
  if (base >= BASE_RATE_SANE.lo && base <= BASE_RATE_SANE.hi) return null;
  return `The population beat-close rate is ${(base * 100).toFixed(1)}% over ${n} outcomes, outside the usual `
    + `${BASE_RATE_SANE.lo * 100}-${BASE_RATE_SANE.hi * 100}% band. The CLV distribution has been checked and is `
    + `clean, so this is a real result rather than a data fault: these signals close WORSE than they open. `
    + `Patterns below are still valid comparisons — each slice is measured against this same population rate, so `
    + `"beats the base" means "loses to the close less than average", NOT "profitable". Treat the base rate itself `
    + `as the finding: the edges being flagged are not surviving to the close.`;
}

export function evaluate(rows: Graded[], opts: {
  minN?: number; minHoldout?: number; q?: number; effectFloor?: number; holdoutFrac?: number;
} = {}): { patterns: Evaluated[]; base_rate: number; n_graded: number; tested: number; base_rate_warning: string | null } {
  const minN = opts.minN ?? MIN_N;
  const minHoldout = opts.minHoldout ?? MIN_HOLDOUT;
  const q = opts.q ?? FDR_Q;
  const floor = opts.effectFloor ?? EFFECT_FLOOR;

  const graded = rows.filter(hasOutcome);
  const base = graded.length ? graded.filter(beat).length / graded.length : 0.5;

  type Cell = { family: string; level: string; rows: Graded[] };
  const cells: Cell[] = [];
  for (const h of HYPOTHESES) {
    const by = new Map<string, Graded[]>();
    for (const g of graded) {
      const l = h.label(g);
      if (!l) continue;
      (by.get(l) ?? by.set(l, []).get(l)!).push(g);
    }
    for (const [level, rs] of by) if (rs.length >= minN) cells.push({ family: h.family, level, rows: rs });
  }

  const scored = cells.map((c) => {
    const { discovery, holdout } = splitChrono(c.rows, opts.holdoutFrac ?? HOLDOUT_FRAC);
    const n = c.rows.length, k = c.rows.filter(beat).length;
    const kd = discovery.filter(beat).length, kh = holdout.filter(beat).length;
    const clvs = c.rows.map((g) => g.clv).filter((v): v is number => v != null && Number.isFinite(v));
    return {
      cell: c, n, k, rate: k / n,
      lo: wilsonLo(k, n),
      n_discovery: discovery.length, lo_discovery: wilsonLo(kd, discovery.length),
      n_holdout: holdout.length, lo_holdout: wilsonLo(kh, holdout.length),
      rate_holdout: holdout.length ? kh / holdout.length : null,
      avg_clv: clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null,
      p: twoSidedP(k, n, base) ?? 1,
    };
  });

  const bh = benjaminiHochberg(scored.map((s) => s.p), q);

  const patterns: Evaluated[] = scored.map((s, i) => {
    const h = HYPOTHESES.find((x) => x.family === s.cell.family)!;
    const effect = s.rate - base;
    const { qvalue, significant } = bh[i];

    /* Every gate must pass. Each one is here because it is the specific way a
       backtest lies, and the reason is recorded so a rejected pattern explains
       itself rather than just vanishing. */
    const gates: [boolean, string][] = [
      [s.n >= minN, `sample ${s.n} is below the floor of ${minN}`],
      [s.n_holdout >= minHoldout, `holdout ${s.n_holdout} is below ${minHoldout} — nothing to confirm on`],
      [significant, `not significant at FDR ${q} across ${scored.length} tested slices (q=${qvalue.toFixed(3)})`],
      [Math.abs(effect) >= floor, `effect ${(effect * 100).toFixed(1)}pp is inside the ${(floor * 100).toFixed(0)}pp floor`],
      [s.lo != null && s.lo_discovery != null && s.lo_holdout != null, `an interval could not be computed`],
      [effect > 0
        ? (s.lo_discovery! > base && s.lo_holdout! > base)
        : (s.lo_discovery! < base && s.lo_holdout! < base),
        `it does not hold in BOTH the discovery and holdout windows`],
    ];
    const failed = gates.filter(([ok]) => !ok).map(([, why]) => why);

    const status: Evaluated['status'] = !failed.length
      ? 'CONFIRMED'
      : (significant && s.n >= minN) ? 'CANDIDATE' : 'REJECTED';

    return {
      family: s.cell.family, level: s.cell.level,
      key: `${s.cell.family}:${s.cell.level}`,
      description: h.describe(s.cell.level),
      n: s.n, k: s.k, rate: s.rate, lo: s.lo,
      n_discovery: s.n_discovery, lo_discovery: s.lo_discovery,
      n_holdout: s.n_holdout, lo_holdout: s.lo_holdout, rate_holdout: s.rate_holdout,
      avg_clv: s.avg_clv, p: s.p, qvalue, significant,
      effect, base_rate: base,
      status,
      why: failed.length ? failed.join('; ') : `holds in both windows, ${(effect * 100).toFixed(1)}pp over the ${(base * 100).toFixed(1)}% base rate`,
    };
  });

  return {
    patterns, base_rate: base, n_graded: graded.length, tested: scored.length,
    base_rate_warning: baseRateWarning(base, graded.length),
  };
}

/* ========================================================================
   CALIBRATION — the useful thing that needs no pattern at all.
   ======================================================================== */

export interface CalibrationBucket {
  bucket: string; n: number;
  mean_edge_predicted: number | null;
  mean_clv_realised: number | null;
  beat_rate: number | null; beat_lo: number | null;
  /* Positive means the realised CLV came in BELOW what the edge implied. */
  shortfall: number | null;
}

/**
 * Predicted edge vs realised CLV, bucketed. This is the reliability curve, and
 * it is worth more than any pattern: it says whether the number on the card
 * means what it claims. It changes nothing automatically — the deterministic
 * engine still owns every price — it just makes the gap visible.
 */
export function calibrate(rows: Graded[], minN = MIN_N): CalibrationBucket[] {
  const by = new Map<string, Graded[]>();
  for (const g of rows) {
    const b = edgeBand(g.edge);
    /* Same rule as the pattern side: a fabricated -100% is not a realised CLV.
       Averaging it in reported a -0.91 mean realised CLV, which would have been
       read as the engine being catastrophically wrong rather than the close job
       having written a placeholder. */
    if (!b || !clvIsReal(g.clv)) continue;
    (by.get(b) ?? by.set(b, []).get(b)!).push(g);
  }
  const order = ['edge 0-1%', 'edge 1-2%', 'edge 2-4%', 'edge 4-8%', 'edge 8-25%'];
  return [...by.entries()]
    .filter(([, rs]) => rs.length >= minN)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([bucket, rs]) => {
      const edges = rs.map((r) => r.edge).filter((v): v is number => v != null);
      const clvs = rs.map((r) => r.clv).filter((v): v is number => v != null);
      const withBeat = rs.filter(hasOutcome);
      const k = withBeat.filter(beat).length;
      const mE = edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : null;
      const mC = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : null;
      return {
        bucket, n: rs.length,
        mean_edge_predicted: mE, mean_clv_realised: mC,
        beat_rate: withBeat.length ? k / withBeat.length : null,
        beat_lo: withBeat.length ? wilsonLo(k, withBeat.length) : null,
        shortfall: (mE != null && mC != null) ? mE - mC : null,
      };
    });
}

/* ========================================================================
   HANDLER
   ======================================================================== */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* Columns this function would LIKE. Three are load-bearing; the rest each feed
   exactly one hypothesis family and are individually optional.

   It does not guess whether they exist. Twice now a column was assumed and the
   whole run died on "column signals.verdict does not exist" — first because
   verdict is computed in the browser and never stored, and then again because a
   retry-on-error scheme still has to send one doomed request to find out.
   Guessing and then recovering is strictly worse than asking. So: read the
   actual column list from the table once, intersect, and send a query that
   cannot fail on a missing column. */
const WANTED = [
  'sport_key', 'market', 'beat_close', 'clv', 'graded_at', 'commence_time',
  'edge', 'best_dec', 'n_books', 'has_sharp', 'corrob_n',
] as const;
const REQUIRED = ['beat_close', 'clv', 'graded_at'] as const;

/**
 * What columns does `signals` ACTUALLY have?
 *
 * One `select('*') limit 1` is authoritative and costs a single round trip.
 * An empty table returns no keys, which is not an error — it means there is
 * nothing to learn from yet, and the caller reports exactly that.
 */
export async function discoverColumns(sb: any): Promise<string[]> {
  const r = await sb.from('signals').select('*').limit(1);
  if (r.error) throw new Error(`signals is not readable: ${r.error.message}`);
  const row = (r.data ?? [])[0];
  return row ? Object.keys(row) : [];
}

/** Intersect what we want with what exists. Pure, so it is testable. */
export function planColumns(available: string[]): {
  select: string[]; missing: string[]; missingRequired: string[];
} {
  const have = new Set(available);
  const select = WANTED.filter((c) => have.has(c));
  const missing = WANTED.filter((c) => !have.has(c));
  return {
    select: [...select],
    missing: [...missing],
    missingRequired: REQUIRED.filter((c) => !have.has(c)),
  };
}

async function loadGraded(sb: any, days: number): Promise<{
  rows: Graded[]; dropped: string[]; columns_seen: number;
}> {
  const available = await discoverColumns(sb);
  if (!available.length) return { rows: [], dropped: [], columns_seen: 0 };

  const { select, missing, missingRequired } = planColumns(available);
  if (missingRequired.length) {
    throw new Error(
      `signals has no ${missingRequired.join(', ')} column, and the learning loop cannot run without `
      + `${missingRequired.length === 1 ? 'it' : 'them'}. CLV and beat_close are written by the close job — `
      + `deploy and run close first.`);
  }

  const from = new Date(Date.now() - days * 864e5).toISOString();
  const out: any[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 20; page++) {              // hard ceiling: 20k rows
    const r = await sb.from('signals')
      .select(select.join(','))
      .not('graded_at', 'is', null)
      /* A signal with no CLV was never closed, and one outside the plausible
         band was not measured — the old close bug wrote exactly -1 when the
         entry price was missing. Neither is a loss; both corrupt every rate
         downstream if counted as one. */
      .not('clv', 'is', null)
      .gte('clv', CLV_SANE.lo)
      .lte('clv', CLV_SANE.hi)
      .gte('graded_at', from)
      .order('graded_at', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (r.error) throw new Error(`reading signals failed: ${r.error.message}`);
    const data = r.data ?? [];
    out.push(...data);
    if (data.length < PAGE) break;
  }

  // A column that exists but was not selected, or one that is absent entirely,
  // both arrive as undefined. Normalise so the label functions see null and
  // skip their family cleanly instead of throwing.
  const rows: Graded[] = out.map((r) => ({
    sport_key: r.sport_key ?? null, market: r.market ?? null,
    beat_close: r.beat_close ?? null, clv: r.clv ?? null, edge: r.edge ?? null,
    best_dec: r.best_dec ?? null, n_books: r.n_books ?? null,
    has_sharp: r.has_sharp ?? null, corrob_n: r.corrob_n ?? null,
    commence_time: r.commence_time ?? null, graded_at: r.graded_at ?? null,
  }));
  return { rows, dropped: missing, columns_seen: available.length };
}

Deno.serve(async (req) => {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    let body: any = {}; try { body = await req.json(); } catch { /* GET */ }
    const mode = body.mode ?? params.mode ?? 'rebuild';
    const days = Math.max(7, Math.min(400, Number(body.days ?? params.days ?? 365)));
    const sb = createClient(url, serviceKey);

    /* Ends the guessing: returns exactly what `signals` has, so a column
       question never needs another round of redeploy-and-see. */
    /* Reports the actual SHAPE of the CLV history. Added because the base rate
       came back at 17% twice and guessing at the cause was not converging —
       this answers it from the data instead. */
    if (mode === 'diagnose') {
      const available = await discoverColumns(sb);
      const cols = ['clv', 'graded_at'].concat(available.includes('clv_excluded_reason') ? ['clv_excluded_reason'] : []);
      const rows: any[] = [];
      for (let page = 0; page < 20; page++) {
        const r = await sb.from('signals').select(cols.join(','))
          .not('graded_at', 'is', null)
          .order('graded_at', { ascending: false })
          .range(page * 1000, page * 1000 + 999);
        if (r.error) return json({ ok: false, error: r.error.message }, 500);
        rows.push(...(r.data ?? []));
        if ((r.data ?? []).length < 1000) break;
      }
      const profile = clvProfile(rows);
      return json({
        build: BUILD, ...profile,
        next: profile.plausible >= MIN_N
          ? 'Enough plausible CLV to learn from. Re-run without mode to rebuild patterns.'
          : `Only ${profile.plausible} plausible CLV values — the close job needs to produce more before any pattern can be evaluated.`,
      });
    }

    if (mode === 'columns') {
      const available = await discoverColumns(sb);
      return json({ build: BUILD, columns_on_signals: available.sort(), ...planColumns(available) });
    }

    const { rows, dropped, columns_seen } = await loadGraded(sb, days);
    const { patterns, base_rate, n_graded, tested, base_rate_warning } = evaluate(rows);
    const buckets = calibrate(rows);

    const state = {
      build: BUILD,
      graded_signals: n_graded,
      base_beat_rate: n_graded ? +base_rate.toFixed(4) : null,
      slices_tested: tested,
      confirmed: patterns.filter((p) => p.status === 'CONFIRMED').length,
      candidates: patterns.filter((p) => p.status === 'CANDIDATE').length,
      calibration_buckets: buckets.length,
      /* Says plainly how far off a usable sample this is, so "the loop is
         learning" can never be implied by an empty table. */
      /* Named, not swallowed: a family that silently stopped being tested is
         indistinguishable from one that found nothing. */
      columns_on_signals: columns_seen,
      ...(base_rate_warning ? { base_rate_warning } : {}),
      population: population(rows),
      clv_profile: clvProfile(rows as any),
      beat_close_column: beatCloseAgreement(rows),
      fair_drift: fairDrift(rows.filter(isActionable)),
      ...(dropped.length ? { columns_unavailable: dropped,
        note: `signals has no ${dropped.join(', ')} column, so the matching hypothesis families were skipped.` } : {}),
      readiness: n_graded >= MIN_N
        ? `${n_graded} graded signals — patterns are being evaluated`
        : `${n_graded} of ${MIN_N} graded signals needed before any pattern can be evaluated`,
    };

    if (mode === 'state' || mode === 'dry') {
      return json({ ...state, patterns: patterns.slice(0, 40), calibration: buckets });
    }

    /* If the yardstick is bent, nothing measured against it may be published.
       Writing these as CONFIRMED would put a data artifact in front of a user
       wearing the clothes of a validated finding. */
    const contam = contamination(rows as any, beatCloseAgreement(rows));
    if (contam.contaminated) {
      /* Attach the evidence WITH the refusal. Three runs were spent asking the
         user to make a second call for the distribution; a refusal that does
         not carry its own diagnosis is an incomplete answer. */
      const blocked = {
        ok: false, ...state, patterns_written: 0, calibration_written: 0,
        blocked: 'Nothing was written — the CLV history is contaminated: ' + contam.issues.join(' '),
        issues: contam.issues,
        clv_profile: clvProfile(rows as any),
        beat_close_column: beatCloseAgreement(rows),
      };
      console.log('LEARN BLOCKED', JSON.stringify(blocked));
      return json(blocked, 200);
    }

    // ---- write: patterns
    let written = 0, cleared = 0;
    const now = new Date().toISOString();
    for (const p of patterns) {
      const { error } = await sb.from('research_patterns').upsert({
        user_id: null, pattern_key: p.key, sport: p.family === 'sport' ? p.level : null,
        description: `${p.description}: ${(p.rate * 100).toFixed(1)}% beat the close over ${p.n} graded signals `
          + `(base rate ${(p.base_rate * 100).toFixed(1)}%).`,
        metric: 'beat_close_rate', metric_value: +p.rate.toFixed(4),
        sample_size: p.n,
        confidence: p.status === 'CONFIRMED' ? (p.n >= 200 ? 'HIGH' : 'MEDIUM') : 'LOW',
        status: p.status, family: p.family, effect: +p.effect.toFixed(4),
        base_rate: +p.base_rate.toFixed(4),
        n_discovery: p.n_discovery, n_holdout: p.n_holdout,
        lo_overall: p.lo == null ? null : +p.lo.toFixed(4),
        lo_discovery: p.lo_discovery == null ? null : +p.lo_discovery.toFixed(4),
        lo_holdout: p.lo_holdout == null ? null : +p.lo_holdout.toFixed(4),
        p_value: +p.p.toFixed(6), q_value: +p.qvalue.toFixed(6),
        avg_clv: p.avg_clv == null ? null : +p.avg_clv.toFixed(5),
        rationale: p.why,
        updated_at: now,
        ...(p.status === 'CONFIRMED' ? { last_confirmed_at: now } : {}),
      }, { onConflict: 'pattern_key,sport,metric' });
      if (!error) written++;
    }

    /* A pattern that stopped being re-evaluated is a pattern about a world
       that no longer exists. Demote anything this run did not touch. */
    const keys = patterns.map((p) => p.key);
    if (keys.length) {
      const { count } = await sb.from('research_patterns')
        .update({ status: 'EXPIRED', updated_at: now }, { count: 'exact' })
        .eq('metric', 'beat_close_rate').neq('status', 'EXPIRED')
        .not('pattern_key', 'in', `(${keys.map((k) => `"${k}"`).join(',')})`);
      cleared = count ?? 0;
    }

    // ---- write: calibration
    let calWritten = 0;
    for (const b of buckets) {
      const { error } = await sb.from('research_calibration').upsert({
        bucket: b.bucket, n: b.n,
        mean_edge_predicted: b.mean_edge_predicted, mean_clv_realised: b.mean_clv_realised,
        beat_rate: b.beat_rate, beat_lo: b.beat_lo, shortfall: b.shortfall,
        updated_at: now,
      }, { onConflict: 'bucket' });
      if (!error) calWritten++;
    }

    const summary = { ok: true, ...state, patterns_written: written, patterns_expired: cleared, calibration_written: calWritten };
    console.log('LEARN', JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});
