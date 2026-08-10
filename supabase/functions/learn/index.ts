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
  verdict: string | null;
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

export function edgeBand(edge: number | null): string | null {
  if (edge == null || !Number.isFinite(edge)) return null;
  if (edge < 0.01) return 'edge<1%';
  if (edge < 0.02) return 'edge 1-2%';
  if (edge < 0.04) return 'edge 2-4%';
  if (edge < 0.08) return 'edge 4-8%';
  return 'edge>8%';
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
  { family: 'verdict', label: (g) => g.verdict ? String(g.verdict).toUpperCase() : null,
    describe: (l) => `signals the engine graded ${l}` },
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

const beat = (g: Graded) => g.beat_close === true;
const hasOutcome = (g: Graded) => g.beat_close != null;

/**
 * Score every level of every pre-registered hypothesis, then apply BH across
 * the whole family at once. The base rate is the population's own beat rate,
 * not 0.5 — the question is never "does this beat a coin", it is "does this
 * slice beat EdgeDesk's own average".
 */
export function evaluate(rows: Graded[], opts: {
  minN?: number; minHoldout?: number; q?: number; effectFloor?: number; holdoutFrac?: number;
} = {}): { patterns: Evaluated[]; base_rate: number; n_graded: number; tested: number } {
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

  return { patterns, base_rate: base, n_graded: graded.length, tested: scored.length };
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
    if (!b || g.clv == null) continue;
    (by.get(b) ?? by.set(b, []).get(b)!).push(g);
  }
  const order = ['edge<1%', 'edge 1-2%', 'edge 2-4%', 'edge 4-8%', 'edge>8%'];
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

/* Columns this function would LIKE. Only the first four are load-bearing; the
   rest each power one hypothesis family and are individually optional.
   `verdict` in particular is computed in the browser and is not a column on
   every deployment — assuming it was there took the whole run down with
   "column signals.verdict does not exist", which is a poor way for a learning
   job to fail. A missing column should cost one hypothesis family, not the
   loop. */
const WANTED = [
  'sport_key', 'market', 'beat_close', 'clv', 'graded_at', 'commence_time',
  'edge', 'best_dec', 'n_books', 'has_sharp', 'verdict',
] as const;
const REQUIRED = new Set(['beat_close', 'clv', 'graded_at']);

/** PostgREST names the offending column; pull it out of the message. */
function missingColumn(msg: string): string | null {
  const m = /column\s+(?:\w+\.)?"?([a-z0-9_]+)"?\s+does not exist/i.exec(msg);
  return m?.[1] ?? null;
}

async function loadGraded(sb: any, days: number): Promise<{ rows: Graded[]; dropped: string[] }> {
  const from = new Date(Date.now() - days * 864e5).toISOString();
  let cols = [...WANTED] as string[];
  const dropped: string[] = [];
  const out: any[] = [];
  const PAGE = 1000;

  for (let page = 0; page < 20; page++) {              // hard ceiling: 20k rows
    let data: any[] | null = null;

    // Retry the SAME page with the offending column removed, up to once per
    // optional column, so one schema difference cannot end the run.
    for (let attempt = 0; attempt <= WANTED.length; attempt++) {
      const r = await sb.from('signals')
        .select(cols.join(','))
        .not('graded_at', 'is', null)
        .gte('graded_at', from)
        .order('graded_at', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (!r.error) { data = r.data ?? []; break; }

      const bad = missingColumn(r.error.message);
      if (!bad || !cols.includes(bad)) throw new Error(r.error.message);
      if (REQUIRED.has(bad)) {
        throw new Error(
          `signals.${bad} does not exist, and the learning loop cannot run without it. `
          + `Run the close job so CLV and beat_close are populated.`);
      }
      cols = cols.filter((c) => c !== bad);
      if (!dropped.includes(bad)) dropped.push(bad);
    }

    if (data == null) throw new Error('could not read signals with any column set');
    out.push(...data);
    if (data.length < PAGE) break;
  }

  // Absent optional columns come back undefined; normalise so the label
  // functions see null and skip the family cleanly.
  const rows: Graded[] = out.map((r) => ({
    sport_key: r.sport_key ?? null, market: r.market ?? null,
    beat_close: r.beat_close ?? null, clv: r.clv ?? null, edge: r.edge ?? null,
    best_dec: r.best_dec ?? null, n_books: r.n_books ?? null,
    has_sharp: r.has_sharp ?? null, verdict: r.verdict ?? null,
    commence_time: r.commence_time ?? null, graded_at: r.graded_at ?? null,
  }));
  return { rows, dropped };
}

Deno.serve(async (req) => {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    let body: any = {}; try { body = await req.json(); } catch { /* GET */ }
    const mode = body.mode ?? params.mode ?? 'rebuild';
    const days = Math.max(7, Math.min(400, Number(body.days ?? params.days ?? 365)));
    const sb = createClient(url, serviceKey);

    const { rows, dropped } = await loadGraded(sb, days);
    const { patterns, base_rate, n_graded, tested } = evaluate(rows);
    const buckets = calibrate(rows);

    const state = {
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
      ...(dropped.length ? { columns_unavailable: dropped,
        note: `signals has no ${dropped.join(', ')} column, so the matching hypothesis families were skipped.` } : {}),
      readiness: n_graded >= MIN_N
        ? `${n_graded} graded signals — patterns are being evaluated`
        : `${n_graded} of ${MIN_N} graded signals needed before any pattern can be evaluated`,
    };

    if (mode === 'state' || mode === 'dry') {
      return json({ ...state, patterns: patterns.slice(0, 40), calibration: buckets });
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
