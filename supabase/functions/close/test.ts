// supabase/functions/close/test.ts
//   node --experimental-strip-types --import ./supabase/functions/_testkit/register.mjs \
//        supabase/functions/close/test.ts
//
// The close decision is what fills (or fails to fill) the CLV column the whole
// record rests on. These assert it never produces a number it cannot justify.

let passed = 0, failed = 0; const fails: string[] = [];
function ok(n: string, c: boolean, d?: unknown) {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; fails.push(n); console.log(`  FAIL  ${n}${d !== undefined ? "  " + JSON.stringify(d) : ""}`); }
}
function eq(n: string, got: unknown, want: unknown) { ok(n, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
function near(n: string, got: number | null, want: number, tol: number) {
  ok(n, got != null && Math.abs(got - want) <= tol, { got, want });
}
function sec(s: string) { console.log(`\n${s}`); }

(globalThis as any).Deno = { env: { get: () => undefined }, serve: () => {} };
const { decideClose, entryPrice } = await import("./index.ts");

const OPTS = { minDec: 1.02, maxDec: 30, ovrLo: 0.98, ovrHi: 1.25, requireSharp: false };
// a clean, coherent Pinnacle close
const good = { best_dec: 1.90, sharp_fair: 0.55, best_book: "pinnacle", has_sharp: true, pin_dec: 1.90, pin_opp_dec: 2.10, n_books: 8 };

sec("A real close produces a real CLV");
near("C1 beat the close", decideClose(2.00, good, OPTS).clv, 0.10, 1e-9);
eq("C2 no exclusion reason", decideClose(2.00, good, OPTS).reason, null);
near("C3 worse than the close is negative", decideClose(1.70, good, OPTS).clv, -0.065, 1e-9);

sec("The fabricated -100% CLV bug");
// (p.best_dec ?? 0) * closeFair - 1  ===  -1 whenever best_dec was null.
eq("C4 a null entry price is EXCLUDED, not scored -100%",
  decideClose(null, good, OPTS), { clv: null, reason: "no_entry_price" });
eq("C5 an impossible entry price is excluded too",
  decideClose(1.0, good, OPTS), { clv: null, reason: "no_entry_price" });
eq("C6 undefined is treated the same", decideClose(undefined, good, OPTS).reason, "no_entry_price");
ok("C7 no input path can return exactly -1 from a null price",
  decideClose(null, good, OPTS).clv !== -1);

sec("Close integrity guards are unchanged");
eq("C8 no snapshot means the line was pulled",
  decideClose(2.0, null, OPTS), { clv: null, reason: "line_pulled_no_close" });
eq("C9 a 50.0 placeholder is rejected",
  decideClose(2.0, { ...good, best_dec: 50 }, OPTS).reason, "implausible_close_price");
eq("C10 an extreme snap is rejected",
  decideClose(2.0, { ...good, best_dec: 1.001 }, OPTS).reason, "implausible_close_price");
eq("C11 a non-probability fair is rejected",
  decideClose(2.0, { ...good, sharp_fair: 1.4 }, OPTS).reason, "invalid_close_fair");
eq("C12 a null fair is rejected",
  decideClose(2.0, { ...good, sharp_fair: null }, OPTS).reason, "invalid_close_fair");
eq("C13 an incoherent two-sided market is rejected",
  decideClose(2.0, { ...good, pin_dec: 5.0, pin_opp_dec: 5.0 }, OPTS).reason, "incoherent_close_market");
eq("C14 a sub-1.0 overround (stale flip) is rejected",
  decideClose(2.0, { ...good, pin_dec: 2.5, pin_opp_dec: 2.5 }, OPTS).reason, "incoherent_close_market");
eq("C15 a one-sided market skips the overround test and still prices",
  decideClose(2.0, { ...good, pin_opp_dec: null }, OPTS).reason, null);
eq("C16 requireSharp is opt-in and enforced when on",
  decideClose(2.0, { ...good, has_sharp: false }, { ...OPTS, requireSharp: true }).reason, "no_sharp_at_close");
eq("C17 ...and ignored when off",
  decideClose(2.0, { ...good, has_sharp: false }, OPTS).reason, null);

sec("Every rejection is a null CLV, never a guess");
for (const [name, o, entry] of [
  ["pulled", null, 2.0],
  ["placeholder", { ...good, best_dec: 77 }, 2.0],
  ["bad fair", { ...good, sharp_fair: 0 }, 2.0],
  ["incoherent", { ...good, pin_dec: 5, pin_opp_dec: 5 }, 2.0],
  ["no entry", good, null],
] as any[]) {
  const r = decideClose(entry, o, OPTS);
  ok(`C18 ${name}: clv is null and a reason is given`, r.clv === null && !!r.reason, r);
}

/* The -2.09% constant offset the learning loop found across every edge band.
   capture inserts a selection the first time it appears anywhere, usually
   before it is a signal; the row becomes a signal LATER, when the price drifts
   out. Measuring CLV from the first-seen price charges the scanner for a price
   it never offered. */
sec("CLV is measured from the price EdgeDesk actually offered");
{
  eq("P1 the flag price wins when present",
    entryPrice({ flagged_best_dec: 2.10, first_best_dec: 1.95, best_dec: 2.02 }),
    { dec: 2.10, basis: "flagged" });
  eq("P2 first-seen is the fallback, and is labelled as such",
    entryPrice({ flagged_best_dec: null, first_best_dec: 1.95, best_dec: 2.02 }),
    { dec: 1.95, basis: "first_seen" });
  eq("P3 the current price is the last resort",
    entryPrice({ best_dec: 2.02 }), { dec: 2.02, basis: "current" });
  eq("P4 no usable price is stated rather than guessed",
    entryPrice({}), { dec: null, basis: "none" });
  eq("P5 a decimal at or below 1 is not a price",
    entryPrice({ flagged_best_dec: 1, first_best_dec: 1.95 }), { dec: 1.95, basis: "first_seen" });
  eq("P6 a non-numeric price is skipped",
    entryPrice({ flagged_best_dec: "2.1" as any, first_best_dec: 1.95 }), { dec: 1.95, basis: "first_seen" });

  /* The size of the artifact: the same close, priced from the open versus the
     flag price, on a row whose price drifted out before it was flagged. */
  const close = { best_dec: 2.00, sharp_fair: 0.505, pin_dec: 1.98, pin_opp_dec: 2.02 };
  const fromOpen = decideClose(entryPrice({ first_best_dec: 1.92 }).dec, close);
  const fromFlag = decideClose(entryPrice({ flagged_best_dec: 2.06, first_best_dec: 1.92 }).dec, close);
  ok("P7 measuring from the open produces a negative CLV", (fromOpen.clv ?? 0) < 0, fromOpen);
  ok("P8 measuring from the flag price produces a positive one", (fromFlag.clv ?? 0) > 0, fromFlag);
  ok("P9 the gap is the size of the reported offset",
    Math.abs((fromFlag.clv! - fromOpen.clv!) - 0.0707) < 0.002, fromFlag.clv! - fromOpen.clv!);

  eq("P10 a row with no price at all is still excluded, not fabricated",
    decideClose(entryPrice({}).dec, close).reason, "no_entry_price");
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (fails.length) console.log("failed:", fails.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
