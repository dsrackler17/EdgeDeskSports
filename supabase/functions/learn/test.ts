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
  evaluate, calibrate, HYPOTHESES, BUILD, type Graded,
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
  eq("K1 sub-1% edge", edgeBand(0.005), "edge<1%");
  eq("K2 2-4% band", edgeBand(0.03), "edge 2-4%");
  eq("K3 the top band is open-ended", edgeBand(0.5), "edge>8%");
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
    return g({ ...o, beat_close: win, commence_time: d.toISOString(), graded_at: d.toISOString() });
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

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (failures.length) console.log("failed:", failures.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
