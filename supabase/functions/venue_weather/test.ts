// supabase/functions/venue_weather/test.ts
//   node --experimental-strip-types --import ./supabase/functions/_testkit/register.mjs \
//        supabase/functions/venue_weather/test.ts
//
// Covers the venue-matching data loss, the shared-array aliasing bug, and the
// wind/air-density maths the model features are built on. No network, no keys.

let passed = 0, failed = 0; const fails: string[] = [];
function ok(n: string, c: boolean, d?: unknown) {
  if (c) { passed++; console.log(`  PASS  ${n}`); }
  else { failed++; fails.push(n); console.log(`  FAIL  ${n}${d !== undefined ? "  " + JSON.stringify(d) : ""}`); }
}
function eq(n: string, got: unknown, want: unknown) { ok(n, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
function near(n: string, got: number | null, want: number, tol: number) {
  ok(n, got != null && Math.abs(got - want) <= tol, { got, want, tol });
}
function sec(s: string) { console.log(`\n${s}`); }

(globalThis as any).Deno = { env: { get: () => "x" }, serve: () => {} };

const M = await import("./index.ts");
const {
  norm180, windRelative, windComponents, windClass, windOutClass, crosswindClass,
  airDensity, adiClass, hrBoostPct, runEnvironment, impactScore, flyBallScore, flyBallRating,
  towardText, buildInsights, normTeam, makeVenueIndex, durMs, sample, extractWx, computeRow,
} = M;

/* ===================================================================== */
sec("Venue matching (the silent data-loss bug)");

const VENUES = [
  { id: "OAK", league: "MLB", team: "Athletics", venue_name: "Sutter Health Park", orientation_deg: 60, is_dome: false, elevation_m: 9 },
  { id: "BOS", league: "MLB", team: "Boston Red Sox", venue_name: "Fenway Park", orientation_deg: 45, is_dome: false, elevation_m: 6 },
  { id: "CHW", league: "MLB", team: "Chicago White Sox", venue_name: "Rate Field", orientation_deg: 130, is_dome: false, elevation_m: 180 },
  { id: "CHC", league: "MLB", team: "Chicago Cubs", venue_name: "Wrigley Field", orientation_deg: 30, is_dome: false, elevation_m: 182 },
  { id: "NE", league: "NFL", team: "New England Patriots", venue_name: "Gillette", orientation_deg: 0, is_dome: false, elevation_m: 90 },
  { id: "MIN", league: "MLB", team: "Minnesota Twins", venue_name: "Target Field", orientation_deg: 90, is_dome: false, elevation_m: 250 },
];
const find = makeVenueIndex(VENUES);

eq("V1 exact name", find("MLB", "Boston Red Sox").venue?.id, "BOS");
eq("V2 the case that lost weather entirely", find("MLB", "Oakland Athletics").venue?.id, "OAK");
eq("V3 how is reported, not hidden", find("MLB", "Oakland Athletics").how, "nickname");
eq("V4 lowercase + punctuation folds", find("MLB", "boston red sox").venue?.id, "BOS");
eq("V5 nickname only", find("MLB", "Red Sox").venue?.id, "BOS");
eq("V6 league is respected", find("NFL", "Boston Red Sox").venue, null);
eq("V7 an unknown club is a real miss", find("MLB", "Seattle Mariners").venue, null);
eq("V8 ...and is reported as none, not ambiguous", find("MLB", "Seattle Mariners").how, "none");
eq("V9 'Sox' is ambiguous, so it REFUSES rather than guessing a stadium bearing",
  find("MLB", "Sox").venue, null);
eq("V10 ambiguity is labelled", find("MLB", "Sox").how, "ambiguous");
eq("V11 an empty name is refused", find("MLB", "").venue, null);
eq("V12 normTeam folds accents and punctuation", normTeam(" St. Louis  CARDINALS "), "st louis cardinals");

/* ===================================================================== */
sec("Wind geometry");

eq("W1 angles normalise into (-180,180]", [norm180(190), norm180(-190), norm180(180), norm180(540)], [-170, 170, 180, 180]);
// Wind FROM 180 (south) blows toward 0 (north). A park whose CF bearing is 0
// therefore has it blowing straight out.
eq("W2 wind from behind home plate blows straight out", windRelative(180, 0), 0);
eq("W3 wind from CF blows straight in", windRelative(0, 0), 180);
eq("W4 wind across to right", windRelative(270, 0), 90);
eq("W5 wind across to left", windRelative(90, 0), -90);
eq("W6 orientation is applied", windRelative(225, 45), 0);

eq("W7 straight out is all out-component", windComponents(10, 0), { out: 10, cross: 0 });
eq("W8 straight in is negative out", windComponents(10, 180), { out: -10, cross: 0 });
eq("W9 pure crosswind right", windComponents(10, 90), { out: 0, cross: 10 });
eq("W10 pure crosswind left", windComponents(10, -90), { out: 0, cross: -10 });

eq("W11 tailwind band", [windClass(0), windClass(45)], ["Tailwind", "Tailwind"]);
eq("W12 headwind band", [windClass(180), windClass(-135)], ["Headwind", "Headwind"]);
eq("W13 crosswind sides", [windClass(90), windClass(-90)], ["Crosswind Right", "Crosswind Left"]);
eq("W14 out-class buckets", [windOutClass(12), windOutClass(0), windOutClass(-8), windOutClass(-20)],
  ["Excellent for HRs", "Neutral", "Slightly In", "Strongly In"]);
eq("W15 crosswind buckets", [crosswindClass(2), crosswindClass(7), crosswindClass(12), crosswindClass(20)],
  ["None", "Slight", "Moderate", "Strong"]);

/* ===================================================================== */
sec("Air density");

const sea = airDensity(70, 50, null, null, 0);
near("A1 sea level, mild, is about neutral", sea?.adi ?? null, 1.0, 0.03);
eq("A2 and says the pressure was derived", sea?.pressure_source, "std_atmosphere(elevation)");

const coors = airDensity(75, 45, null, null, 1580);   // Coors Field, 1580 m
// std-atmosphere pressure at 1580 m is ~837 hPa, which puts ADI at ~0.80.
near("A3 Coors comes out thin, as it must", coors?.adi ?? null, 0.80, 0.02);
ok("A4 thin air really is thinner than sea level", (coors!.adi) < (sea!.adi));

const measured = airDensity(70, 50, null, 1013.25, 1580);
eq("A5 a real NWS pressure is used and labelled", measured?.pressure_source, "nws");
ok("A6 ...and elevation is then ignored", Math.abs(measured!.adi - sea!.adi) < 0.02);

eq("A7 no temperature means no density, not a guess", airDensity(null, 50, 60, 1013, 0), null);
eq("A8 no pressure AND no elevation is refused", airDensity(70, 50, 60, null, null), null);
ok("A9 humid air is lighter than dry air at the same temperature",
  airDensity(85, 80, null, 1013, 0)!.adi < airDensity(85, 30, null, 1013, 0)!.adi);
eq("A10 class boundaries", [adiClass(0.9), adiClass(0.95), adiClass(1.0), adiClass(1.05), adiClass(1.1)],
  ["Excellent Carry", "Above Average", "Neutral", "Poor Carry", "Heavy Air"]);

/* ===================================================================== */
sec("Model features (unvalidated, but must be consistent)");

ok("M1 hr boost is clamped at +15", hrBoostPct(40, 0.8) === 15);
ok("M2 hr boost is clamped at -15", hrBoostPct(-40, 1.2) === -15);
eq("M3 dead-neutral conditions give no boost", hrBoostPct(0, 1.0), 0);
ok("M4 wind out raises the boost", hrBoostPct(10, 1.0) > hrBoostPct(0, 1.0));
eq("M5 run environment scales with boost",
  [runEnvironment(15, 0), runEnvironment(6, 0), runEnvironment(0, 0), runEnvironment(-6, 0), runEnvironment(-15, 0)],
  ["Very Hitter Friendly", "Hitter Friendly", "Neutral", "Pitcher Friendly", "Very Pitcher Friendly"]);
eq("M6 heavy rain steps the environment down", runEnvironment(15, 80), "Hitter Friendly");
ok("M7 impact score is bounded at 100", impactScore(60, 60, 0.5, 100) === 100);
eq("M8 calm neutral conditions score ~0", impactScore(0, 0, 1.0, 0), 0);
eq("M9 fly-ball ratings", [flyBallRating(flyBallScore(15, 0.95, 90)), flyBallRating(flyBallScore(0, 1.0, 70)), flyBallRating(flyBallScore(-15, 1.05, 50))],
  ["Excellent", "Neutral", "Poor"]);
eq("M10 toward-text follows the angle",
  [towardText(0), towardText(90), towardText(180), towardText(-90)],
  ["out to center", "across toward right field", "in from center", "across toward left field"]);

/* ===================================================================== */
sec("Insights are gated on data, never invented");

eq("I1 nothing known means nothing claimed", buildInsights({}), []);
eq("I2 a light breeze is not narrated", buildInsights({ wind_mph: 6, wind_relative_angle: 0 }), []);
ok("I3 a real wind is narrated with its direction",
  buildInsights({ wind_mph: 18, wind_relative_angle: 0 })[0].includes("out to center"));
ok("I4 carry is claimed only with the out-component",
  buildInsights({ wind_component_out: 10 }).includes("Fly balls expected to carry."));
ok("I5 gusts need both gust and base wind",
  buildInsights({ wind_mph: 10, wind_gust_mph: 25 }).some((s: string) => s.includes("Gusts")));
ok("I6 a gust without a base wind claims nothing", buildInsights({ wind_gust_mph: 25 }).length === 0);

/* ===================================================================== */
sec("NWS gridpoint parsing");

eq("G1 ISO-8601 durations", [durMs("PT1H"), durMs("PT6H"), durMs("P1D"), durMs("P1DT2H"), durMs("junk")],
  [3600000, 21600000, 86400000, 93600000, 3600000]);

const T0 = Date.parse("2026-08-10T18:00:00Z");
const layer = { uom: "wmoUnit:degC", values: [
  { validTime: "2026-08-10T17:00:00+00:00/PT1H", value: 20 },
  { validTime: "2026-08-10T18:00:00+00:00/PT2H", value: 25 },
  { validTime: "2026-08-10T23:00:00+00:00/PT1H", value: 18 },
] };
eq("G2 the covering interval is selected", sample(layer, T0)?.value, 25);
eq("G3 a time inside a 2h block still resolves", sample(layer, T0 + 3600e3)?.value, 25);
eq("G4 a gap in coverage returns null, not the nearest hour", sample(layer, T0 + 3.5 * 3600e3), null);
eq("G5 a null value is null", sample({ uom: "x", values: [{ validTime: "2026-08-10T18:00:00+00:00/PT1H", value: null }] }, T0), null);

const props = {
  temperature: layer,
  windSpeed: { uom: "wmoUnit:km_h-1", values: [{ validTime: "2026-08-10T18:00:00+00:00/PT2H", value: 16.09 }] },
  windDirection: { uom: "wmoUnit:degree_(angle)", values: [{ validTime: "2026-08-10T18:00:00+00:00/PT2H", value: 180 }] },
  pressure: { uom: "wmoUnit:Pa", values: [{ validTime: "2026-08-10T18:00:00+00:00/PT2H", value: 101325 }] },
  visibility: { uom: "wmoUnit:m", values: [{ validTime: "2026-08-10T18:00:00+00:00/PT2H", value: 16093.4 }] },
};
const wx = extractWx(props, T0)!;
near("G6 celsius converts to fahrenheit", wx.temp_f, 77, 0.2);
near("G7 km/h converts to mph", wx.wind_mph, 10, 0.2);
near("G8 pascals convert to hPa", wx.pressure_hpa, 1013.3, 0.5);
near("G9 metres convert to miles", wx.visibility_mi, 10, 0.1);
eq("G10 direction is kept in true degrees", wx.wind_dir_deg, 180);
eq("G11 no temperature coverage means no reading at all", extractWx(props, T0 + 3.5 * 3600e3), null);

/* ===================================================================== */
sec("Row assembly");

const diag = () => ({ dome_events: 0, no_forecast_hour: 0, uncalibrated: [] as string[] });
const ev = { event_id: "e1", commence_time: "2026-08-10T18:00:00Z" };

{
  const d = diag();
  const dome = { id: "TB", league: "MLB", team: "Tampa Bay Rays", venue_name: "Trop", is_dome: true };
  const a = computeRow(dome, ev, {}, d) as any;
  const b = computeRow(dome, { ...ev, event_id: "e2" }, {}, d) as any;
  eq("Y1 a dome records that it is a dome, not a temperature", a.source, "n/a - dome");
  eq("Y2 and reports no conditions", [a.temp_f, a.wind_mph, a.air_density_index], [null, null, null]);

  // FIX 5: NULL_ROW used to be a const, so every dome row aliased one array.
  a.insights.push("mutated");
  eq("Y3 dome rows do NOT share one insights array", b.insights.length, 0);
  eq("Y4 every row carries identical keys (PostgREST PGRST102)",
    JSON.stringify(Object.keys(a).sort()), JSON.stringify(Object.keys(b).sort()));
}
{
  const d = diag();
  const cal = { id: "BOS", league: "MLB", team: "Boston Red Sox", venue_name: "Fenway", is_dome: false, orientation_deg: 0, elevation_m: 6 };
  const row = computeRow(cal, ev, props, d) as any;
  eq("Y5 a calibrated park gets full wind geometry", row.wind_class, "Tailwind");
  near("Y6 with the out-component computed", row.wind_component_out, 10, 0.2);
  ok("Y7 and the model features populated", row.hr_boost_pct != null && row.run_environment != null);
  eq("Y8 pressure provenance is recorded", row.pressure_source, "nws");

  const unc = { ...cal, id: "X", team: "Uncalibrated Park", orientation_deg: null };
  const row2 = computeRow(unc, ev, props, d) as any;
  eq("Y9 an uncalibrated park leaves wind geometry NULL rather than guessing",
    [row2.wind_class, row2.wind_component_out, row2.hr_boost_pct], [null, null, null]);
  ok("Y10 ...and says so", d.uncalibrated.includes("Uncalibrated Park"));
  ok("Y11 but still reports the raw conditions it does have", row2.temp_f != null && row2.wind_mph != null);
  eq("Y12 key sets still match across calibrated and uncalibrated rows",
    JSON.stringify(Object.keys(row).sort()), JSON.stringify(Object.keys(row2).sort()));

  const d2 = diag();
  eq("Y13 no forecast at that hour yields no row at all",
    computeRow(cal, { ...ev, commence_time: "2026-08-11T09:00:00Z" }, props, d2), null);
  eq("Y14 ...and is counted", d2.no_forecast_hour, 1);
}

console.log(`\n${failed === 0 ? "ALL GREEN" : "FAILURES"} — ${passed} passed, ${failed} failed`);
if (fails.length) console.log("failed:", fails.join(" | "));
if (typeof process !== "undefined" && failed > 0) (process as any).exit(1);
