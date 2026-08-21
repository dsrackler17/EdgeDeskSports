// Unit tests for the vendor adapter and the normalization primitives.
//
//   node --experimental-strip-types tests/collective/oddsblaze_normalize.test.mjs
//
// These run outside Deno, which is why odds_normalize.ts and the pure parts
// of oddsblaze.ts hold no environment or network access. The only Deno global
// the adapter touches is env.get, stubbed below with an empty key: the tests
// never make a request, and no credential is present or needed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

globalThis.Deno = { env: { get: () => "" } };

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = join(here, "..", "..", "supabase", "functions", "_shared");

const N = await import(join(SHARED, "odds_normalize.ts"));
const OB = await import(join(SHARED, "oddsblaze.ts"));

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "oddsblaze_nfl_sample.json"), "utf8"),
);

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`pass: ${label}`);
  } catch (e) {
    console.error(`FAIL: ${label}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

// --------------------------------------------------------------- prices
check("American prices parse from string and number", () => {
  assert.equal(N.parseAmericanPrice("-110"), -110);
  assert.equal(N.parseAmericanPrice("+135"), 135);
  assert.equal(N.parseAmericanPrice(-280), -280);
  assert.equal(N.parseAmericanPrice("EVEN"), 100);
});

check("a value that is not American odds returns null instead of a number", () => {
  // The band between -99 and +99 cannot be an American price. Accepting one
  // would silently produce a nonsense probability downstream.
  assert.equal(N.parseAmericanPrice("0"), null);
  assert.equal(N.parseAmericanPrice(5), null);
  assert.equal(N.parseAmericanPrice(-99), null);
  assert.equal(N.parseAmericanPrice("n/a"), null);
  assert.equal(N.parseAmericanPrice(null), null);
  assert.equal(N.parseAmericanPrice(undefined), null);
  assert.equal(N.parseAmericanPrice(""), null);
});

check("lines parse, including pick'em", () => {
  assert.equal(N.parseLine("-3.5"), -3.5);
  assert.equal(N.parseLine("+3.5"), 3.5);
  assert.equal(N.parseLine(47.5), 47.5);
  assert.equal(N.parseLine("PK"), 0);
  assert.equal(N.parseLine("pick'em"), 0);
  assert.equal(N.parseLine(null), null);
  assert.equal(N.parseLine("abc"), null);
});

check("decimal and probability conversions match the SQL side", () => {
  assert.equal(N.americanToDecimal(135), 2.35);
  assert.equal(Number(N.americanToDecimal(-110).toFixed(4)), 1.9091);
  assert.equal(Number(N.americanToProb(-110).toFixed(4)), 0.5238);
  assert.equal(N.americanToDecimal(0), null);
});

check("two-way de-vig normalizes an overround to one", () => {
  const a = N.americanToProb(-185), b = N.americanToProb(155);
  const fair = N.devigTwoWay(a, b);
  assert.ok(a + b > 1, "the vigged book should overround");
  assert.equal(Number((fair + N.devigTwoWay(b, a)).toFixed(6)), 1);
  assert.ok(fair < a, "the fair price must sit below the vigged one");
});

// -------------------------------------------------------------- markets
check("documented market labels map to canonical ids", () => {
  assert.equal(N.canonicalMarket("Point Spread"), "spread");
  assert.equal(N.canonicalMarket("point-spread"), "spread");
  assert.equal(N.canonicalMarket("Moneyline"), "moneyline");
  assert.equal(N.canonicalMarket("Total Points"), "total");
  assert.equal(N.canonicalMarket("total-points"), "total");
});

check("an unknown market is null, never guessed into a bucket", () => {
  assert.equal(N.canonicalMarket("First Team To Score A Safety"), null);
  assert.equal(N.canonicalMarket(""), null);
  assert.equal(N.canonicalMarket(undefined), null);
});

// ------------------------------------------------------------- outcomes
const NAMES = {
  homeNames: ["Kansas City Chiefs", "KC"],
  awayNames: ["Buffalo Bills", "BUF"],
};

check("an explicit side wins", () => {
  assert.equal(N.resolveOutcome({ market: "spread", side: "home", ...NAMES }), "home");
  assert.equal(N.resolveOutcome({ market: "spread", side: "away", ...NAMES }), "away");
  assert.equal(N.resolveOutcome({ market: "total", side: "over", ...NAMES }), "over");
});

check("without a side, the selection text is matched against the teams", () => {
  assert.equal(
    N.resolveOutcome({ market: "spread", selectionName: "Buffalo Bills", ...NAMES }),
    "away",
  );
  assert.equal(
    N.resolveOutcome({ market: "moneyline", selectionName: "KC", ...NAMES }),
    "home",
  );
  assert.equal(
    N.resolveOutcome({ market: "total", selectionName: "Under 47.5", ...NAMES }),
    "under",
  );
});

check("an unattributable price is null, not a coin flip", () => {
  // Guessing here would invert a whole market for one book.
  assert.equal(
    N.resolveOutcome({ market: "spread", selectionName: "Some Unknown Franchise", ...NAMES }),
    null,
  );
  assert.equal(N.resolveOutcome({ market: "spread", ...NAMES }), null);
});

check("a line can be recovered from a label as a last resort", () => {
  assert.equal(N.lineFromLabel("Kansas City Chiefs -3.5"), -3.5);
  assert.equal(N.lineFromLabel("Over 47"), 47);
  assert.equal(N.lineFromLabel("Kansas City Chiefs"), null);
});

// ---------------------------------------------------------- redaction
check("a credential never survives into a logged URL", () => {
  const red = N.redactUrl("https://odds.oddsblaze.com/?key=sk_live_supersecret123&league=nfl");
  assert.ok(!red.includes("supersecret"), red);
  assert.ok(red.includes("key=REDACTED"), red);
  assert.ok(red.includes("league=nfl"), "non-secret params must survive");
});

check("a credential never survives into an error message", () => {
  const secret = "sk_live_supersecret123";
  const msg = N.redactSecret(`fetch failed for https://x/?key=${secret}&league=nfl`, secret);
  assert.ok(!msg.includes(secret), msg);
  assert.ok(msg.includes("REDACTED"));
  // Also redacted when the secret itself is not supplied to the redactor.
  assert.ok(!N.redactSecret("?api_key=abc123def456&x=1", null).includes("abc123def456"));
});

check("shape reporting describes structure without leaking values", () => {
  const paths = N.shapePaths(fixture.draftkings);
  assert.ok(paths.includes("events[].odds[].price"), paths.join(","));
  assert.ok(paths.includes("events[].teams.home.abbreviation"));
  const flat = JSON.stringify(paths);
  assert.ok(!flat.includes("Kansas City"), "shape output must not carry values");
  assert.ok(!flat.includes("-110"));
});

// ------------------------------------------------ the OddsBlaze adapter
const CTX = {
  book: "draftkings",
  homeNames: ["Kansas City Chiefs", "KC"],
  awayNames: ["Buffalo Bills", "BUF"],
  eventLive: false,
};

check("the documented odds row shape maps cleanly", () => {
  const rows = fixture.draftkings.events[0].odds;
  const spread = OB.readOdd(rows[0], CTX);
  assert.ok("odd" in spread, JSON.stringify(spread));
  assert.deepEqual(
    { market: spread.odd.market, outcome: spread.odd.outcome, line: spread.odd.line, price: spread.odd.price },
    { market: "spread", outcome: "home", line: -3.5, price: -110 },
  );

  const ml = OB.readOdd(rows[2], CTX);
  assert.ok("odd" in ml);
  assert.equal(ml.odd.market, "moneyline");
  assert.equal(ml.odd.line, null, "a moneyline must carry no line");
  assert.equal(ml.odd.price, -185);

  const total = OB.readOdd(rows[4], CTX);
  assert.ok("odd" in total);
  assert.deepEqual(
    { m: total.odd.market, o: total.odd.outcome, l: total.odd.line },
    { m: "total", o: "over", l: 47.5 },
  );
});

check("main and alternate lines are distinguished, not merged", () => {
  const main = OB.readOdd(fixture.draftkings.events[0].odds[0], CTX);
  const alt = OB.readOdd(fixture.draftkings.events[0].odds[6], CTX);
  assert.equal(main.odd.is_main, true);
  assert.equal(alt.odd.is_main, false);
  assert.equal(alt.odd.line, -7.5);
});

check("the flat field variants are read via the documented fallbacks", () => {
  const g = fixture.fanduel_flat_variant.games[0];
  const ctx = { ...CTX, book: "fanduel" };
  const a = OB.readOdd(g.odds[0], ctx); // string selection + `points`
  assert.ok("odd" in a, JSON.stringify(a));
  assert.deepEqual([a.odd.market, a.odd.outcome, a.odd.line, a.odd.price], ["spread", "home", -3.5, -115]);

  const b = OB.readOdd(g.odds[1], ctx); // string selection, no line at all
  assert.ok("odd" in b);
  assert.deepEqual([b.odd.market, b.odd.outcome, b.odd.price], ["moneyline", "away", 152]);

  const c = OB.readOdd(g.odds[2], ctx); // line only recoverable from the label
  assert.ok("odd" in c);
  assert.deepEqual([c.odd.market, c.odd.outcome, c.odd.line], ["total", "over", 47]);
});

check("rows that cannot be mapped are reported with their keys, never invented", () => {
  const rows = fixture.unmappable_rows.events[0].odds;
  const ctx = { ...CTX, book: "betmgm" };
  const results = rows.map((r) => OB.readOdd(r, ctx));

  const reasons = results.map((r) => ("bad" in r ? r.bad.reason : "MAPPED"));
  assert.match(reasons[0], /player market/, "a player prop is not a game line");
  assert.match(reasons[1], /unrecognised market/, "an unknown market is reported");
  assert.match(reasons[2], /American price/, "price 0 is rejected");
  assert.match(reasons[3], /attribute the price/, "an unknown team is not guessed");
  assert.match(reasons[4], /carries no line/, "a spread with no line is rejected");
  assert.equal(reasons[5], "MAPPED", "the one good row still maps");

  // The report names the fields that were present, so an API change is
  // diagnosable from the run record without re-running anything.
  assert.ok(results[1].bad.keys.includes("market"));
  assert.ok(results[1].bad.keys.includes("selection"));
});

check("events normalize with team names passed through for the alias table", () => {
  const { event, bad } = OB.readEvent(fixture.draftkings.events[0], {
    book: "draftkings",
    providerUpdatedAt: "2026-09-20T14:31:07Z",
  });
  assert.equal(bad.length, 0);
  assert.equal(event.home, "Kansas City Chiefs");
  assert.equal(event.away, "Buffalo Bills");
  assert.equal(event.commence_time, "2026-09-20T17:00:00Z");
  assert.equal(event.provider_event_id, "ob_evt_1001");
  assert.equal(event.odds.length, 7);
  // Codes are the database's job, via odds.team_aliases: one owner for team
  // identity rather than a second mapping table in TypeScript.
  assert.equal(event.home.length > 3, true);
});

check("a live event marks its prices live", () => {
  const { event } = OB.readEvent(fixture.draftkings.events[1], {
    book: "draftkings",
    providerUpdatedAt: null,
  });
  assert.equal(event.is_live, true);
  assert.equal(event.status, "live");
  assert.ok(event.odds.every((o) => o.is_live === true));
});

check("an event missing teams or a kickoff is reported, not partly stored", () => {
  const { event, bad } = OB.readEvent({ id: "x", odds: [] }, { book: "b", providerUpdatedAt: null });
  assert.equal(event, null);
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /missing teams or kickoff/);
});

check("the same game across two books collapses to one event", () => {
  const merged = OB.mergeBooks([
    { book: "draftkings", body: fixture.draftkings },
    { book: "fanduel", body: fixture.fanduel_flat_variant },
  ]);
  const kc = merged.events.filter((e) => e.home === "Kansas City Chiefs");
  assert.equal(kc.length, 1, "KC/BUF must not appear twice");
  const books = new Set(kc[0].odds.map((o) => o.book));
  assert.deepEqual([...books].sort(), ["draftkings", "fanduel"]);
  assert.equal(merged.events.length, 2, "DAL/NYG is a separate game");
  assert.equal(merged.providerUpdatedAt, "2026-09-20T14:31:12Z", "newest vendor timestamp wins");
});

check("a response with no events array is reported rather than treated as empty", () => {
  const merged = OB.mergeBooks([{ book: "caesars", body: { updated: "x", message: "no data" } }]);
  assert.equal(merged.events.length, 0);
  assert.equal(merged.unmapped.length, 1);
  assert.match(merged.unmapped[0].reason, /no events array/);
});

check("the provider reports itself unconfigured when the secret is absent", () => {
  // Deno.env.get is stubbed to "" for these tests.
  assert.equal(OB.oddsBlazeProvider.isConfigured(), false);
});

check("an unconfigured fetch fails closed instead of calling out", async () => {
  const slate = await OB.oddsBlazeProvider.fetchSlate({
    league: "nfl", books: ["draftkings"], markets: ["spread"],
  });
  assert.equal(slate.events.length, 0);
  assert.equal(slate.books_ok.length, 0);
  assert.equal(slate.books_failed[0].reason, "missing_api_key");
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME CHECKS FAILED");
else console.log("ALL ADAPTER TESTS PASSED");
