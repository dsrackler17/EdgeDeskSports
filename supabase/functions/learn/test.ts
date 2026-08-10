// Tests for the learning loop. No database, no network, no key.
//   node --experimental-strip-types --import ../_testkit/register.mjs learn/test.ts
//
// The point of these is narrow and specific: a learning loop's failure mode is
// not a crash, it is confidently reporting a pattern that is noise. Most of
// what follows feeds the evaluator data with NO signal in it and asserts that
// nothing gets confirmed.
import {
  wilsonLo, normalCdf, twoSidedP, benjaminiHochberg,
  edgeBand, priceBand, booksBand, etDow, splitChrono,
  evaluate, calibrate, HYPOTHESES, BUILD, planColumns, discoverColumns,
  baseRateWarning, clvIsReal, clvProfile, beatCloseAgreement, contamination,
  fairDrift, population, isActionable, EDGE_SANE_MAX, CLV_SANE, type Graded,
} from "./index.ts";

let passed = 0, failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
function near(name: string, got: number | null, want: number, tol = 1e-3) {
  ok(name, got != null && Math.abs(got - want) <= tol, { got, want });
}
function section(s: string) { console.log(`\n${s}`); }

/* ------------------------------------------------------------ statistics */

section("Wilson lower bound");
{
  near("W1 50/100 lands near .40", wilsonLo(50, 100), 0.4038, 2e-3);
  near("W2 90/100 lands near .825", wilsonLo(90, 100), 0.8250, 3e-3);
  ok("W3 4-for-4 is NOT evidence of a >50% rate at any useful level",
    (wilsonLo(4, 4) ?? 1) < 0.55, wilsonLo(4, 4));
  ok("W4 a perfect record at tiny n stays under the base rate it must beat",
    (wilsonLo(3, 3) ?? 1) < 0.5, wilsonLo(3, 3));
  ok("W5 the bound rises with sample at a fixed rate",
    (wilsonLo(300, 400) ?? 0) > (wilsonLo(30, 40) ?? 0));
  eq("W6 zero samples has no bound", wilsonLo(0, 0), null);
  eq("W7 more successes than trials is refused", wilsonLo(5, 4), null);
  near("W8 0/50 has a lower bound of zero-ish", wilsonLo(0, 50), 0, 1e-9);
}

section("Normal tail and the two-sided test");
{
  near("N1 the standard normal is centred", normalCdf(0), 0.5, 1e-6);
  near("N2 one sigma", normalCdf(1), 0.8413, 1e-3);
  near("N3 1.96 sigma is the 97.5th percentile", normalCdf(1.96), 0.975, 1e-3);
  ok("N4 a coin at exactly half is not surprising", (twoSidedP(50, 100, 0.5) ?? 0) > 0.9);
  ok("N5 70/100 against a fair coin is", (twoSidedP(70, 100, 0.5) ?? 1) < 0.001);
  ok("N6 the same RATE at a small sample is not",
    (twoSidedP(7, 10, 0.5) ?? 0) > 0.1, twoSidedP(7, 10, 0.5));
  ok("N7 the base rate matters: 60/100 vs a 0.6 base is unremarkable",
    (twoSidedP(60, 100, 0.6) ?? 0) > 0.9);
  ok("N8 ...but the same 60/100 vs a 0.5 base is",
    (twoSidedP(60, 100, 0.5) ?? 1) < 0.06);
  eq("N9 an impossible base rate is refused", twoSidedP(5, 10, 0), null);
}

section("Benjamini-Hochberg keeps the family honest");
{
  const none = benjaminiHochberg([0.9, 0.8, 0.7, 0.6, 0.5], 0.1);
  eq("B1 nothing significant stays nothing", none.filter((r) => r.significant).length, 0);

  const one = benjaminiHochberg([0.0001, 0.9, 0.8, 0.7, 0.6], 0.1);
  eq("B2 a genuinely tiny p survives the correction", one[0].significant, true);
  eq("B3 ...and its neighbours do not", one.slice(1).filter((r) => r.significant).length, 0);

  /* The whole reason this exists. Uncorrected, a lone p=0.04 among 19 nulls
     "wins" at the conventional 5%. BH knows it was one of twenty questions and
     refuses it — that gap is the anti-dredging device.
     (BH is not Bonferroni: twenty p-values ALL at 0.04 do legitimately pass,
     because at that point the family looks like real signal rather than one
     lucky slice. Asserted below so the distinction stays deliberate.) */
  const lucky = benjaminiHochberg([0.04, ...new Array(19).fill(0.6)], 0.1);
  eq("B4 one marginal p-value among twenty questions is not a discovery", lucky[0].significant, false);
  ok("B4b ...and its q-value records how much the family cost it",
    lucky[0].qvalue > 0.5, lucky[0].qvalue);
  eq("B4c a family that is significant throughout is not penalised into nothing",
    benjaminiHochberg(new Array(20).fill(0.04), 0.1).filter((r) => r.significant).length, 20);

  ok("B5 q-values never fall below their p-values", benjaminiHochberg([0.01, 0.02, 0.03], 0.1)
    .every((r, i) => r.qvalue >= [0.01, 0.02, 0.03][i] - 1e-9));
  ok("B6 q-values are monotone in p", (() => {
    const r = benjaminiHochberg([0.001, 0.01, 0.2, 0.5], 0.1).map((x) => x.qvalue);
    return r.every((v, i) => i === 0 || v >= r[i - 1] - 1e-9);
  })());
  eq("B7 an empty family is empty", benjaminiHochberg([], 0.1), []);
  ok("B8 a stricter q admits no more than a looser one",
    benjaminiHochberg([0.01, 0.02, 0.03, 0.04], 0.01).filter((r) => r.significant).length
    <= benjaminiHochberg([0.01, 0.02, 0.03, 0.04], 0.20).filter((r) => r.significant).length);
}

/* -------------------------------------------------------------- bucketing */

section("Bucketing");
{
  eq("K1 a small POSITIVE edge", edgeBand(0.005), "edge 0-1%");
  eq("K2 2-4% band", edgeBand(0.03), "edge 2-4%");
  eq("K3 the top band is bounded — beyond it is a broken price",
    edgeBand(0.5), "implausible edge (>25%)");
  eq("K4 a missing edge has no band", edgeBand(null), null);
  eq("K5 heavy favourite", priceBand(1.25), "heavy favourite");
  eq("K6 big dog", priceBand(4.5), "big dog");
  eq("K7 an impossible price has no band", priceBand(0.8), null);
  eq("K8 thin coverage", booksBand(4), "thin book coverage");
  eq("K9 deep coverage", booksBand(30), "deep book coverage");
  eq("K10 unknown coverage", booksBand(null), null);

  // Slate day is ET and shifts 6h back, so a late West-coast start stays on
  // the same betting day rather than rolling into the next one.
  eq("K11 a 10pm ET Saturday start is still Saturday", etDow("2026-08-08T02:00:00Z"), 5);
  eq("K12 a missing kickoff has no weekday", etDow(null), null);
  eq("K13 an unparseable kickoff has no weekday", etDow("not a date"), null);
}

section("The holdout is chronological, not random");
{
  const rows = Array.from({ length: 10 }, (_, i) => ({ graded_at: `2026-08-${String(i + 1).padStart(2, "0")}` }));
  const { discovery, holdout } = splitChrono(rows, 0.3);
  eq("S1 seventy per cent discovers", discovery.length, 7);
  eq("S2 thirty per cent confirms", holdout.length, 3);
  eq("S3 discovery is strictly older", discovery[discovery.length - 1].graded_at, "2026-08-07");
  eq("S4 holdout is strictly newer", holdout[0].graded_at, "2026-08-08");
  ok("S5 input order does not matter", (() => {
    const shuffled = [...rows].reverse();
    return splitChrono(shuffled, 0.3).holdout[0].graded_at === "2026-08-08";
  })());
}

/* ------------------------------------------------------------- evaluation */

const g = (o: Partial<Graded>): Graded => ({
  sport_key: "baseball_mlb", market: "h2h", beat_close: false, clv: 0, edge: 0.03,
  best_dec: 1.9, n_books: 12, has_sharp: true, corrob_n: 2,
  commence_time: "2026-06-01T18:00:00Z", graded_at: "2026-06-01T22:00:00Z", ...o,
});

/**
 * n rows, k of which beat the close, spread EVENLY over consecutive days.
 *
 * The even spread matters: `i < k` would put every win at the front, which is
 * indistinguishable from an effect that died before the holdout — so a fixture
 * built that way tests decay detection, not persistence. Bresenham-style
 * distribution keeps the rate the same in both windows.
 */
function series(n: number, k: number, o: Partial<Graded> = {}): Graded[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 864e5);
    const win = Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n);
    /* clv and beat_close must agree: the outcome is DERIVED from clv > 0, so a
       fixture that sets only the flag describes a row that cannot exist. */
    return g({ clv: win ? 0.02 : -0.02, ...o, beat_close: win,
               commence_time: d.toISOString(), graded_at: d.toISOString() });
  });
}

section("A pattern must survive being asked about honestly");
{
  eq("E1 no graded rows yields no patterns", evaluate([]).patterns.length, 0);
  eq("E2 ...and reports a zero sample", evaluate([]).n_graded, 0);

  // Below the floor: nothing is even scored.
  eq("E3 a 20-row slice is never evaluated", evaluate(series(20, 18)).patterns.length, 0);

  /* PURE NOISE. Every row is an independent coin flip at the base rate, so
     across ~9 pre-registered families NOTHING should be confirmed. This is the
     test that would fail if the loop were a leaderboard. */
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noise: Graded[] = [];
  for (let i = 0; i < 600; i++) {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 36e5);
    noise.push(g({
      beat_close: rand() < 0.5,
      sport_key: ["baseball_mlb", "americanfootball_nfl", "mma_mixed_martial_arts"][Math.floor(rand() * 3)],
      market: ["h2h", "spreads", "totals"][Math.floor(rand() * 3)],
      edge: [0.005, 0.015, 0.03, 0.06, 0.12][Math.floor(rand() * 5)],
      best_dec: [1.25, 1.8, 2.5, 4.5][Math.floor(rand() * 4)],
      n_books: [4, 12, 30][Math.floor(rand() * 3)],
      has_sharp: rand() < 0.5, verdict: rand() < 0.5 ? "BET" : "LEAN",
      commence_time: d.toISOString(), graded_at: d.toISOString(),
    }));
  }
  const noisy = evaluate(noise);
  ok("E4 many slices ARE tested on 600 rows", noisy.tested > 10, noisy.tested);
  eq("E5 pure noise confirms nothing", noisy.patterns.filter((p) => p.status === "CONFIRMED").length, 0);
  ok("E6 ...and says why, per slice", noisy.patterns.every((p) => p.why.length > 0));

  /* A REAL, LARGE, PERSISTENT effect must get through — a loop that confirms
     nothing is as useless as one that confirms everything. */
  const strong = [
    ...series(300, 150, { market: "h2h" }),                       // base ~50%
    ...series(200, 150, { market: "totals" }),                    // 75%, throughout
  ];
  const found = evaluate(strong);
  const totals = found.patterns.find((p) => p.key === "market:totals");
  eq("E7 a large persistent effect is confirmed", totals?.status, "CONFIRMED");
  ok("E8 ...with the holdout counted separately", (totals?.n_holdout ?? 0) >= 10, totals);
  ok("E9 ...and measured against the population base rate, not a coin",
    totals != null && totals.base_rate > 0.55 && totals.base_rate < 0.65, totals?.base_rate);
  ok("E10 ...and the rationale states the effect size",
    /pp over the/.test(totals?.why ?? ""), totals?.why);

  /* The specific lie a chronological holdout exists to catch: an effect that
     was real early and died. Front-loaded wins, chance afterwards. */
  const decayed = [
    ...series(140, 140, { market: "totals" }),                    // perfect, early
    ...Array.from({ length: 160 }, (_, i) => {
      const d = new Date(Date.parse("2026-01-01T18:00:00Z") + (140 + i) * 864e5);
      return g({ market: "totals", beat_close: i % 2 === 0, commence_time: d.toISOString(), graded_at: d.toISOString() });
    }),
    ...series(300, 150, { market: "h2h" }),
  ];
  const dead = evaluate(decayed).patterns.find((p) => p.key === "market:totals");
  ok("E11 an effect that died before the holdout is not confirmed",
    dead?.status !== "CONFIRMED", { status: dead?.status, why: dead?.why });
  ok("E12 ...and the reason names the holdout explicitly",
    /discovery and holdout/.test(dead?.why ?? ""), dead?.why);

  /* Significant but trivial. 53% over a 50% base at huge n is real and
     unusable; the effect floor is what keeps it out of the user's face. */
  const tiny = [...series(2000, 1060, { market: "totals" }), ...series(2000, 1000, { market: "h2h" })];
  const trivial = evaluate(tiny).patterns.find((p) => p.key === "market:totals");
  ok("E13 a real but trivial effect is not promoted", trivial?.status !== "CONFIRMED", trivial?.why);
  ok("E14 ...and the floor is named as the reason", /floor/.test(trivial?.why ?? ""), trivial?.why);
}

section("Every stored pattern can be interrogated");
{
  const found = evaluate([...series(300, 150, { market: "h2h" }), ...series(200, 150, { market: "totals" })]);
  const p = found.patterns.find((x) => x.key === "market:totals")!;
  ok("Q1 it carries both window sizes", p.n_discovery > 0 && p.n_holdout > 0);
  ok("Q2 it carries a bound for each window", p.lo_discovery != null && p.lo_holdout != null);
  ok("Q3 it carries the family-adjusted q, not just a raw p", p.qvalue >= p.p - 1e-9);
  ok("Q4 it carries the base rate it was measured against", p.base_rate > 0);
  ok("Q5 it carries a human description", /totals/.test(p.description));
  ok("Q6 every hypothesis family can describe its own levels",
    HYPOTHESES.every((h) => typeof h.describe("x") === "string" && h.describe("x").length > 0));
  ok("Q7 statuses are drawn from the closed set",
    found.patterns.every((x) => ["CONFIRMED", "CANDIDATE", "REJECTED"].includes(x.status)));
}

/* ------------------------------------------------------------ calibration */

section("Calibration says whether the number means what it claims");
{
  // An engine that is systematically optimistic: predicts ~3%, realises ~1%.
  const rows = [
    ...Array.from({ length: 60 }, () => g({ edge: 0.03, clv: 0.01, beat_close: true })),
    ...Array.from({ length: 40 }, () => g({ edge: 0.06, clv: -0.01, beat_close: false })),
  ];
  const cal = calibrate(rows);
  eq("C1 one bucket per populated band", cal.length, 2);
  const b24 = cal.find((c) => c.bucket === "edge 2-4%")!;
  near("C2 the predicted mean is reported", b24.mean_edge_predicted, 0.03);
  near("C3 the realised mean is reported", b24.mean_clv_realised, 0.01);
  near("C4 the shortfall is predicted minus realised", b24.shortfall, 0.02);
  eq("C5 the beat rate comes from the graded rows", b24.beat_rate, 1);
  ok("C6 ...with an interval, not a bare rate", b24.beat_lo != null && b24.beat_lo! < 1);

  const b48 = cal.find((c) => c.bucket === "edge 4-8%")!;
  ok("C7 a bucket can be negative — that is the finding", b48.mean_clv_realised! < 0);
  ok("C8 ...and the shortfall shows how optimistic it was", b48.shortfall! > 0.06);

  eq("C9 buckets below the floor are not reported",
    calibrate([...Array.from({ length: 5 }, () => g({ edge: 0.03, clv: 0.01 }))]).length, 0);
  eq("C10 rows with no CLV cannot calibrate anything",
    calibrate(Array.from({ length: 60 }, () => g({ edge: 0.03, clv: null }))).length, 0);
  eq("C11 buckets come back in edge order", cal.map((c) => c.bucket), ["edge 2-4%", "edge 4-8%"]);
}

/* Live failure: `verdict` is computed in the browser and is not a column on
   every deployment, so selecting it returned
   "column signals.verdict does not exist" and took the entire run down. A
   missing optional column must cost one hypothesis family, not the loop. */
section("A missing optional column costs one family, not the run");
{
  const noCorrob = [
    ...series(300, 150, { market: "h2h", corrob_n: null }),
    ...series(200, 150, { market: "totals", corrob_n: null }),
  ];
  const r = evaluate(noCorrob);
  ok("M1 evaluation still runs with an optional column absent", r.tested > 0, r.tested);
  eq("M2 the family that column fed simply produces no slices",
    r.patterns.filter((p) => p.family === "corroboration").length, 0);
  eq("M2b nothing asks about verdict at all — it is never a stored column",
    HYPOTHESES.filter((h) => h.family === "verdict").length, 0);
  ok("M2c the build marker is exported so a deploy can be confirmed",
    typeof BUILD === "string" && BUILD.length > 0, BUILD);
  eq("M3 ...and the other families are unaffected",
    r.patterns.find((p) => p.key === "market:totals")?.status, "CONFIRMED");

  // Every label function must tolerate a fully empty row rather than throwing.
  const blank: Graded = {
    sport_key: null, market: null, beat_close: null, clv: null, edge: null,
    best_dec: null, n_books: null, has_sharp: null, corrob_n: null,
    commence_time: null, graded_at: null,
  };
  ok("M4 every hypothesis label survives an entirely empty row",
    HYPOTHESES.every((h) => { try { return h.label(blank) === null; } catch { return false; } }));
  eq("M5 rows with no outcome are never counted as graded",
    evaluate([blank, blank]).n_graded, 0);
}

/* The query is built from the table's ACTUAL columns, so a missing one can no
   longer produce a failed request at all. This replaced a retry-on-error
   scheme, which still had to send one doomed query to discover the problem. */
section("The column set is discovered, never assumed");
{
  const REAL = ["sig_key", "sport_key", "event_id", "market", "selection", "best_dec",
    "sharp_fair", "consensus_fair", "edge", "n_books", "has_sharp", "corrob_n",
    "commence_time", "clv", "beat_close", "result", "graded_at"];

  const plan = planColumns(REAL);
  ok("D1 verdict is never requested — it is not a stored column",
    !plan.select.includes("verdict"));
  ok("D2 the required columns are all selected",
    ["beat_close", "clv", "graded_at"].every((c) => plan.select.includes(c)));
  eq("D3 nothing required is missing", plan.missingRequired, []);
  ok("D4 optional columns that exist are selected",
    plan.select.includes("corrob_n") && plan.select.includes("edge"));

  // A deployment without the optional columns still runs.
  const thin = planColumns(["beat_close", "clv", "graded_at", "market"]);
  eq("D5 a thin schema selects only what is there",
    thin.select.sort(), ["beat_close", "clv", "graded_at", "market"]);
  eq("D6 ...and reports what it could not ask for", thin.missingRequired, []);
  ok("D7 ...naming the absent optional columns", thin.missing.includes("edge")
    && thin.missing.includes("corrob_n"));

  // A schema genuinely missing CLV cannot learn, and must say why.
  const broken = planColumns(["sport_key", "market", "graded_at"]);
  eq("D8 missing CLV is reported as required", broken.missingRequired.sort(), ["beat_close", "clv"]);

  eq("D9 an empty column list needs everything", planColumns([]).select, []);

  // Discovery itself: one select('*') limit 1, keys off the row.
  const fake = (rows: any[], error?: string) => ({
    from: () => ({ select: () => ({ limit: async () => ({ data: rows, error: error ? { message: error } : null }) }) }),
  });
  eq("D10 columns come from the row's own keys",
    (await discoverColumns(fake([{ a: 1, b: 2, c: null }]))).sort(), ["a", "b", "c"]);
  eq("D11 an empty table yields no columns rather than an error",
    await discoverColumns(fake([])), []);
  ok("D12 an unreadable table is a clear error", await (async () => {
    try { await discoverColumns(fake([], "permission denied")); return false; }
    catch (e) { return /signals is not readable/.test(String(e)); }
  })());

  ok("D13 the build marker is set so a deploy can be confirmed",
    /^\d{4}-\d{2}-\d{2}\.\d+-/.test(BUILD), BUILD);
}

/* The live run that caught this reported base_beat_rate 0.1735 over 3216
   "graded" signals. beat_close is a GENERATED column, so a signal that never
   reached the close job resolves to false rather than null — and roughly three
   quarters of the history was in that state. Those are not losses. Counted as
   losses they bend the yardstick every pattern is measured against, so all 11
   "confirmed" patterns from that run were measuring which slices get CLOSED,
   not which slices beat the close. */
section("A signal with no CLV is not a loss");
{
  const closed = (n: number, k: number) => series(n, k, {});
  const neverClosed = (n: number) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 864e5);
    // Exactly the shape the generated column produces: clv null, beat_close false.
    return g({ clv: null, beat_close: false, commence_time: d.toISOString(), graded_at: d.toISOString() });
  });

  const clean = evaluate(closed(200, 100));
  near("V1 a properly closed population sits near even", clean.base_rate, 0.5, 0.02);
  eq("V2 ...and every row counts as an outcome", clean.n_graded, 200);

  const contaminated = evaluate([...closed(200, 100), ...neverClosed(600)]);
  eq("V3 un-closed rows are excluded, not counted against", contaminated.n_graded, 200);
  near("V4 ...so the base rate is unmoved by 600 of them", contaminated.base_rate, 0.5, 0.02);
  eq("V5 ...and no false warning is raised", contaminated.base_rate_warning, null);

  // The guard itself, on the number the live run actually produced.
  ok("V6 a 17% base rate is reported as a fault", !!baseRateWarning(0.1735, 3216));
  ok("V7 ...stating what the rate means rather than assuming corruption",
    /close WORSE than they open/.test(baseRateWarning(0.1735, 3216) ?? ""));
  ok("V8 ...and pointing at the base rate itself as the finding",
    /base rate itself as the finding/.test(baseRateWarning(0.1735, 3216) ?? ""));
  eq("V9 a sane base rate raises nothing", baseRateWarning(0.52, 3216), null);
  eq("V10 an implausibly HIGH rate is caught too", baseRateWarning(0.94, 500) != null, true);
  eq("V11 an empty population is not a fault", baseRateWarning(0, 0), null);

  ok("V12 the guard rides on every evaluation",
    "base_rate_warning" in evaluate(closed(100, 50)));
  ok("V13 the build marker is present", typeof BUILD === "string" && BUILD.length > 0, BUILD);

  // Calibration must obey the same rule.
  const cal = calibrate([
    ...Array.from({ length: 40 }, () => g({ edge: 0.03, clv: 0.01, beat_close: true })),
    ...Array.from({ length: 400 }, () => g({ edge: 0.03, clv: null, beat_close: false })),
  ]);
  eq("V14 calibration ignores rows with no CLV", cal[0].n, 40);
  eq("V15 ...so its beat rate is not dragged down either", cal[0].beat_rate, 1);
}

/* Second live run: excluding null CLV changed nothing — the count went UP, to
   3642, and the base rate stayed at 17.1%. So these rows DO carry a CLV, and
   83% of them are negative. The old close computed
   `(best_dec ?? 0) * closeFair - 1`, which is exactly -1 whenever the entry
   price was missing, and those fabrications are still in the history. */
section("A fabricated CLV is not a loss either");
{
  eq("F1 a normal CLV is real", clvIsReal(0.03), true);
  eq("F2 a normal negative CLV is real", clvIsReal(-0.04), true);
  eq("F3 the fabricated -100% is not", clvIsReal(-1), false);
  eq("F4 nor is anything near it", clvIsReal(-0.95), false);
  eq("F5 an absurd positive is not", clvIsReal(2.5), false);
  eq("F6 null is not", clvIsReal(null), false);
  eq("F7 the band edges are inclusive", [clvIsReal(CLV_SANE.lo), clvIsReal(CLV_SANE.hi)], [true, true]);

  /* The exact shape of the live data: a real population near even, buried
     under fabricated -1s. */
  const real = Array.from({ length: 200 }, (_, i) => g({ clv: i < 100 ? 0.02 : -0.02, beat_close: i < 100 }));
  const fabricated = Array.from({ length: 800 }, () => g({ clv: -1, beat_close: false }));

  const before = evaluate([...real, ...fabricated]);
  eq("F8 fabricated rows are excluded from the population", before.n_graded, 200);
  near("F9 ...so the base rate is the real one", before.base_rate, 0.5, 0.02);
  eq("F10 ...and no contamination warning is raised", before.base_rate_warning, null);

  // The profile is what turns "why is it 17%" into a fact.
  const prof = clvProfile([...real, ...fabricated].map((r) => ({ clv: r.clv })));
  eq("F11 the profile counts the fabricated rows exactly", prof.exactly_minus_one, 800);
  eq("F12 ...and separates the plausible ones", prof.plausible, 200);
  eq("F13 ...reporting their true beat rate", prof.plausible_beat_rate, 0.5);
  eq("F14 the histogram puts them in the fabricated band",
    prof.histogram["<= -0.9 (fabricated -100%)"], 800);
  ok("F15 the reading states both counts", /200 of 1000 CLV values/.test(prof.reading), prof.reading);

  eq("F16 rows with no CLV are counted separately",
    clvProfile([{ clv: null }, { clv: 0.01 }]).clv_null, 1);
  eq("F17 exclusion reasons are counted when present",
    clvProfile([{ clv: null, clv_excluded_reason: "missed_close_window" }]).with_excluded_reason, 1);
  ok("F18 an entirely fabricated history says so plainly",
    /not CLV/.test(clvProfile([{ clv: -1 }, { clv: -1 }]).reading));
  eq("F19 quartiles come back for a real distribution",
    clvProfile([{ clv: -0.02 }, { clv: 0 }, { clv: 0.02 }]).median, 0);

  // Calibration must apply the same rule.
  const cal = calibrate([
    ...Array.from({ length: 40 }, () => g({ edge: 0.03, clv: 0.01, beat_close: true })),
    ...Array.from({ length: 400 }, () => g({ edge: 0.03, clv: -1, beat_close: false })),
  ]);
  eq("F20 calibration ignores fabricated CLV", cal[0].n, 40);
  near("F21 ...so the realised mean is the real one, not -0.91", cal[0].mean_clv_realised, 0.01);
}

/* Third run at 17.5%, and the plausibility filter removed only ~100 of 3642
   rows — so the fabricated -1s were not the cause either. The outcome is now
   DERIVED from clv > 0 rather than read off a generated column whose
   expression is not visible from here, and any disagreement is measured. */
section("The outcome is derived, and the stored column is checked against it");
{
  const rows = [
    ...Array.from({ length: 60 }, () => g({ clv: 0.02, beat_close: true })),
    ...Array.from({ length: 40 }, () => g({ clv: -0.02, beat_close: false })),
  ];
  const agreed = beatCloseAgreement(rows);
  eq("A1 every comparable row agrees", agreed.disagree, 0);
  eq("A2 both rates match", [agreed.stored_true_rate, agreed.derived_true_rate], [0.6, 0.6]);
  ok("A3 ...and it says the column is not the problem",
    /not the problem/.test(agreed.reading), agreed.reading);

  /* The case worth catching: the generated column says false while the CLV is
     positive. That is what a 17% rate looks like if beat_close is not (clv>0). */
  const skewed = [
    ...Array.from({ length: 80 }, () => g({ clv: 0.02, beat_close: false })),
    ...Array.from({ length: 20 }, () => g({ clv: 0.03, beat_close: true })),
  ];
  const bad = beatCloseAgreement(skewed);
  eq("A4 disagreement is counted exactly", bad.disagree, 80);
  eq("A5 the stored rate is the misleading one", bad.stored_true_rate, 0.2);
  eq("A6 the derived rate is the true one", bad.derived_true_rate, 1);
  ok("A7 ...and the reading names the column as the fault",
    /not simply \(clv > 0\)/.test(bad.reading), bad.reading);

  // Evaluation must follow the CLV, not the column.
  const ev = evaluate(skewed.map((r, i) => g({ ...r, market: i < 50 ? "h2h" : "totals" })));
  near("A8 the base rate follows clv > 0, not beat_close", ev.base_rate, 1, 1e-9);
  eq("A9 a row with a real CLV counts even if beat_close is null",
    evaluate(Array.from({ length: 40 }, () => g({ clv: 0.01, beat_close: null }))).n_graded, 40);

  eq("A10 nothing comparable is handled", beatCloseAgreement([]).reading, "nothing comparable");
  eq("A11 fabricated rows are not comparable",
    beatCloseAgreement([g({ clv: -1, beat_close: false })]).comparable, 0);
}

/* The real data, finally characterised: 3539 rows, zero nulls, zero fabricated
   -1s, zero exclusion reasons, beat_close agreeing with clv>0 on every row, and
   a smooth distribution from -0.498 to +0.418 with a median of -0.027. Clean
   data, genuinely bad result. Blocking that was the tool protecting a
   conclusion rather than reporting one. */
section("An unflattering result is not the same as a broken one");
{
  // A faithful reconstruction of the live distribution's shape.
  const live: Graded[] = [];
  const mk = (clv: number, i: number) => {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 36e5);
    return g({ clv, beat_close: clv > 0, commence_time: d.toISOString(), graded_at: d.toISOString() });
  };
  let i = 0;
  for (let k = 0; k < 558; k++) live.push(mk(-0.30, i++));
  for (let k = 0; k < 2363; k++) live.push(mk(-0.03, i++));
  for (let k = 0; k < 614; k++) live.push(mk(0.02, i++));
  for (let k = 0; k < 4; k++) live.push(mk(0.30, i++));

  const agree = beatCloseAgreement(live);
  eq("X1 the reconstruction reproduces the live beat rate", agree.derived_true_rate, 0.1746);

  const contam = contamination(live.map((r) => ({ clv: r.clv })), agree);
  eq("X2 clean data is NOT flagged as contaminated", contam.contaminated, false);
  eq("X3 ...with no issues listed", contam.issues, []);

  const warn = baseRateWarning(0.1746, 3539);
  ok("X4 an extreme clean rate still warns", !!warn);
  ok("X5 ...but calls it a real result, not a data fault",
    /real result rather than a data fault/.test(warn ?? ""), warn);
  ok("X6 ...and says plainly what it means", /close WORSE than they open/.test(warn ?? ""));
  ok("X7 ...and refuses to let 'beats the base' read as profitable",
    /NOT "profitable"/.test(warn ?? ""));

  // Contamination must still be caught when it is genuinely present.
  const fabricated = [...live.map((r) => ({ clv: r.clv })), ...Array.from({ length: 50 }, () => ({ clv: -1 }))];
  const c2 = contamination(fabricated, agree);
  eq("X8 fabricated -1s are still contamination", c2.contaminated, true);
  ok("X9 ...counted and named", /50 rows carry exactly -1/.test(c2.issues[0]), c2.issues);

  const c3 = contamination(live.map((r) => ({ clv: r.clv })), { disagree: 12 });
  eq("X10 a disagreeing outcome column is still contamination", c3.contaminated, true);
  ok("X11 ...and says the stored column is not the definition",
    /not the definition/.test(c3.issues.join(" ")));

  // Patterns remain meaningful against a low base rate.
  const skewed = [...series(300, 30, { market: "h2h" }), ...series(300, 120, { market: "totals" })];
  const ev = evaluate(skewed);
  near("X12 the base rate is the population's own", ev.base_rate, 0.25, 0.02);
  eq("X13 a slice that beats a bad base is still detectable",
    ev.patterns.find((p) => p.key === "market:totals")?.status, "CONFIRMED");
}

/* The entry price cancels out of edge and clv, so how far the FAIR price moved
   between capture and close is derivable exactly from two columns already on
   the table. That distinguishes "the edge model is wrong" from "there is a
   fixed offset between the two fair prices", which are different bugs. */
section("Fair-price drift separates a bad model from a fixed offset");
{
  const row = (edge: number, clv: number, i = 0) => {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 36e5);
    return g({ edge, clv, beat_close: clv > 0, commence_time: d.toISOString(), graded_at: d.toISOString() });
  };

  // Edge fully realised: fair did not move.
  const kept = fairDrift(Array.from({ length: 50 }, (_, i) => row(0.03, 0.03, i)));
  eq("R1 a fully realised edge shows retention 1", kept.edge_retention, 1);
  eq("R2 ...and no overstatement", kept.fair_overstated_pct, 0);

  // Edge entirely illusory: realised zero.
  const lost = fairDrift(Array.from({ length: 50 }, (_, i) => row(0.03, 0, i)));
  eq("R3 an unrealised edge shows retention 0", lost.edge_retention, 0);
  near("R4 ...and the entry fair overstated by the edge", lost.fair_overstated_pct, 3, 0.05);

  // The live shape: +3% projected, -2.7% realised.
  const live = fairDrift(Array.from({ length: 200 }, (_, i) => row(0.03, -0.027, i)));
  ok("R5 the live shape shows negative retention", (live.edge_retention ?? 0) < 0, live.edge_retention);
  near("R6 ...and quantifies how far the fair moved", live.fair_overstated_pct, 5.86, 0.1);
  ok("R7 ...and the reading names the cause candidates",
    /de-vig or book-set difference|noise in a thin book set/.test(live.reading), live.reading);

  /* Constant offset across bands vs one that grows with the flagged edge -
     the whole point of splitting by band. */
  /* A constant OFFSET means a constant fair_entry/fair_close ratio, so the
     realised CLV is (1+edge)/ratio - 1 — not simply -edge, which is what a
     model whose error scales with the edge would produce. */
  const atRatio = (e: number, ratio: number) => (1 + e) / ratio - 1;
  const constant = fairDrift([
    ...Array.from({ length: 40 }, (_, i) => row(0.015, atRatio(0.015, 1.03), i)),
    ...Array.from({ length: 40 }, (_, i) => row(0.03, atRatio(0.03, 1.03), i + 40)),
    ...Array.from({ length: 40 }, (_, i) => row(0.06, atRatio(0.06, 1.03), i + 80)),
  ]);
  ok("R8 a constant offset is called systematic",
    /roughly CONSTANT/.test(constant.reading), constant.reading);

  const growing = fairDrift([
    ...Array.from({ length: 40 }, (_, i) => row(0.015, 0.010, i)),
    ...Array.from({ length: 40 }, (_, i) => row(0.03, -0.010, i + 40)),
    ...Array.from({ length: 40 }, (_, i) => row(0.12, -0.20, i + 80)),
  ]);
  ok("R9 an offset that grows with the edge is called noise",
    /noise in a thin book set/.test(growing.reading), growing.reading);

  ok("R10 bands below the floor are not reported",
    Object.keys(fairDrift([row(0.03, -0.02, 0)]).by_edge_band).length === 0);
  eq("R11 rows with no edge cannot contribute",
    fairDrift([g({ edge: null, clv: -0.02 })]).reading, "no rows carry both an edge and a CLV");
  eq("R12 fabricated CLV is excluded here too",
    fairDrift([g({ edge: 0.03, clv: -1 })]).reading, "no rows carry both an edge and a CLV");
}

/* The fair-drift run revealed the actual problem, and it was the population.
   median_edge came back NEGATIVE (-3.0%), and the 'edge<1%' band held 2748 of
   3539 rows at a median edge of -4.5%. `signals` is the full capture table -
   every priced selection - not a list of flagged bets. The 17.5% "beat rate"
   was mostly measuring selections nobody would ever have bet. */
section("The population is flagged signals, not every priced selection");
{
  eq("P1 a negative edge gets its own band, not the small-edge one",
    edgeBand(-0.045), "negative edge (not actionable)");
  eq("P2 a small positive edge is distinguishable from it", edgeBand(0.005), "edge 0-1%");
  eq("P3 a 40% edge is a broken price, not a huge opportunity",
    edgeBand(0.405), "implausible edge (>25%)");
  eq("P4 the top real band is bounded", edgeBand(0.12), "edge 8-25%");
  eq("P5 exactly zero is not actionable", edgeBand(0), "negative edge (not actionable)");

  eq("P6 only a plausible positive edge is actionable", isActionable({ edge: 0.03 }), true);
  eq("P7 a negative edge is not", isActionable({ edge: -0.02 }), false);
  eq("P8 an absurd edge is not", isActionable({ edge: 0.41 }), false);
  eq("P9 a missing edge is not", isActionable({ edge: null }), false);
  eq("P10 the boundary is inclusive", isActionable({ edge: EDGE_SANE_MAX }), true);

  /* The live composition, reconstructed: 2748 negative, 458 absurd, 333 real. */
  const mk = (edge: number, clv: number, i: number) => {
    const d = new Date(Date.parse("2026-01-01T18:00:00Z") + i * 36e5);
    return g({ edge, clv, beat_close: clv > 0, commence_time: d.toISOString(), graded_at: d.toISOString() });
  };
  let i = 0;
  const live = [
    ...Array.from({ length: 2748 }, () => mk(-0.045, -0.033, i++)),
    ...Array.from({ length: 458 }, () => mk(0.405, -0.008, i++)),
    ...Array.from({ length: 200 }, () => mk(0.027, 0.01, i++)),
    ...Array.from({ length: 133 }, () => mk(0.027, -0.013, i++)),
  ];

  const pop = population(live);
  eq("P11 the never-actionable rows are counted", pop.negative_edge_never_actionable, 2748);
  eq("P12 the broken prices are counted separately", pop.implausible_edge_bad_price, 458);
  eq("P13 ...leaving only the genuinely flagged signals", pop.actionable, 333);
  eq("P14 ...whose beat rate is the one that matters", pop.actionable_beat_rate, 0.6006);
  ok("P15 the reading spells out all three groups",
    /2748 have a negative edge/.test(pop.reading) && /458 carry an edge above 25%/.test(pop.reading),
    pop.reading);

  const ev = evaluate(live);
  eq("P16 evaluation uses only the actionable population", ev.n_graded, 333);
  near("P17 ...so the base rate is theirs, not the capture table's", ev.base_rate, 0.6006, 0.001);
  eq("P18 ...and no false contamination warning follows", ev.base_rate_warning, null);

  // Drift must be measured on the same population.
  const drift = fairDrift(live.filter(isActionable));
  eq("P19 drift excludes the broken prices", drift.n, 333);
  ok("P20 ...so a 46% overstatement from junk lines cannot leak in",
    Math.abs(drift.fair_overstated_pct ?? 0) < 10, drift.fair_overstated_pct);
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
