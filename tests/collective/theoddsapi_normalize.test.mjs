// Unit tests for The Odds API adapter.
//
//   node --experimental-strip-types tests/collective/theoddsapi_normalize.test.mjs
//
// Runs outside Deno, so the pure parts of theoddsapi.ts hold no environment or
// network access. Deno.env is stubbed; no request is made and no credential is
// present or needed. The fixture is the documented v4 response shape, with two
// deliberately broken rows to prove the adapter reports rather than guesses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const ENV = {};
globalThis.Deno = { env: { get: (k) => ENV[k] ?? "" } };

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = join(here, "..", "..", "supabase", "functions", "_shared");

const TA = await import(join(SHARED, "theoddsapi.ts"));

const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "theoddsapi_nfl_sample.json"), "utf8"),
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

const NOW = Date.parse("2026-09-13T12:00:00Z");
const MARKETS = ["moneyline", "spread", "total"];
const readAll = () =>
  fixture.map((row) => TA.readTaEvent(row, { markets: MARKETS, now: NOW }));

// ------------------------------------------------------------- credit model

check("one poll costs markets x regions, the documented formula", () => {
  assert.equal(TA.taPredictedCost(["moneyline", "spread", "total"], "us"), 3);
  assert.equal(TA.taPredictedCost(["moneyline", "spread", "total"], "us,eu"), 6);
  assert.equal(TA.taPredictedCost(["spread"], "us"), 1);
});

check("a market the endpoint cannot serve is not billed for", () => {
  // alternate_spread lives on the per-event endpoint, so it contributes no
  // markets parameter and must not inflate the predicted cost.
  assert.equal(TA.taPredictedCost(["spread", "alternate_spread"], "us"), 1);
});

check("credit headers are read as numbers, and absent ones stay null", () => {
  const q = TA.readTaQuota(new Headers({
    "x-requests-remaining": "473",
    "x-requests-used": "27",
    "x-requests-last": "3",
  }));
  assert.deepEqual(q, { remaining: 473, used: 27, last_cost: 3 });

  const empty = TA.readTaQuota(new Headers({}));
  assert.deepEqual(empty, { remaining: null, used: null, last_cost: null });
});

check("an unparseable credit header is null, never zero", () => {
  // Zero would read as "out of credit" and stop ingestion permanently.
  const q = TA.readTaQuota(new Headers({ "x-requests-remaining": "unknown" }));
  assert.equal(q.remaining, null);
});

// ----------------------------------------------------------------- mapping

check("every book in the response is read from one request", () => {
  const [first] = readAll();
  const books = [...new Set(first.event.odds.map((o) => o.book))].sort();
  assert.deepEqual(books, ["caesars", "draftkings", "fanduel"]);
});

check("the API's bookmaker key maps onto the id the Collective already uses", () => {
  // williamhill_us and caesars are the same book. Left unmapped they would
  // both appear on the card as separate prices from separate books.
  const [first] = readAll();
  const caesars = first.event.odds.filter((o) => o.book === "caesars");
  assert.equal(caesars.length, 2);
  assert.equal(first.event.odds.some((o) => o.book === "williamhill_us"), false);
});

check("h2h, spreads and totals land on the canonical market ids", () => {
  const [first] = readAll();
  const markets = [...new Set(first.event.odds.map((o) => o.market))].sort();
  assert.deepEqual(markets, ["moneyline", "spread", "total"]);
});

check("spreads keep home convention with no sign flip", () => {
  // point is already in that team's own terms. Cincinnati is home and laying
  // 2.5, so the home line is -2.5 and the away line is +2.5.
  const [first] = readAll();
  const dk = first.event.odds.filter((o) => o.book === "draftkings" && o.market === "spread");
  const home = dk.find((o) => o.outcome === "home");
  const away = dk.find((o) => o.outcome === "away");
  assert.equal(home.line, -2.5);
  assert.equal(home.price, -110);
  assert.equal(away.line, 2.5);
});

check("totals resolve to over and under, both carrying the same number", () => {
  const [first] = readAll();
  const dk = first.event.odds.filter((o) => o.book === "draftkings" && o.market === "total");
  const over = dk.find((o) => o.outcome === "over");
  const under = dk.find((o) => o.outcome === "under");
  assert.equal(over.line, 47.5);
  assert.equal(under.line, 47.5);
  assert.equal(over.price, -112);
  assert.equal(under.price, -108);
});

check("moneyline carries no line rather than a zero", () => {
  const [first] = readAll();
  const ml = first.event.odds.filter((o) => o.market === "moneyline");
  assert.ok(ml.length > 0);
  assert.ok(ml.every((o) => o.line === null));
});

check("full team names resolve to the right side", () => {
  // New England away at Seattle is the case that breaks naive prefix matching:
  // "New England Patriots" and a "NE" alias share a prefix with nothing here,
  // but the pair has burned this codebase before, so it is pinned.
  const [, second] = readAll();
  const mgm = second.event.odds.filter((o) => o.book === "betmgm" && o.market === "moneyline");
  assert.equal(mgm.find((o) => o.outcome === "home").price, -175);
  assert.equal(mgm.find((o) => o.outcome === "away").price, 145);
});

check("the event keeps the provider id as a mapping, not as identity", () => {
  const [first] = readAll();
  assert.equal(first.event.provider_event_id, "0d2f0a1e6d0b4f7c9a3e5b8c1d4f6a90");
  assert.equal(first.event.home, "Cincinnati Bengals");
  assert.equal(first.event.away, "Tampa Bay Buccaneers");
});

check("live is inferred from the clock, and stated as a status", () => {
  const started = TA.readTaEvent(fixture[0], {
    markets: MARKETS,
    now: Date.parse("2026-09-13T18:00:00Z"),
  });
  assert.equal(started.event.is_live, true);
  assert.equal(started.event.status, "live");

  const [pre] = readAll();
  assert.equal(pre.event.is_live, false);
  assert.equal(pre.event.status, "scheduled");
});

check("the newest book timestamp becomes the event's provider_updated_at", () => {
  const [first] = readAll();
  assert.equal(first.event.provider_updated_at, "2026-09-13T16:44:03.000Z");
});

// -------------------------------------------------- reporting, not guessing

check("a spread with no point is reported, never stored with a null line", () => {
  // A spread priced at -110 with no number is not a usable price. Stored with
  // a null line it would group with genuinely different numbers in best-price.
  const [, second] = readAll();
  const reasons = second.bad.map((b) => b.reason);
  assert.ok(reasons.some((r) => r.includes("has no point")));
  const broken = second.event.odds.filter((o) => o.book === "brokenbook");
  assert.equal(broken.length, 0);
});

check("an outcome naming neither team is reported with its key names", () => {
  const [, second] = readAll();
  const hit = second.bad.find((b) => b.reason.includes("matched neither team"));
  assert.ok(hit, "expected an unmapped row for the unknown team");
  assert.deepEqual(hit.keys.sort(), ["name", "point", "price"]);
});

check("a prop market is refused at the market key, before its outcomes", () => {
  // player_pass_tds canonicalizes to nothing, so it is rejected one layer
  // above the description guard. Cheaper, and the reason names the cause.
  const [, second] = readAll();
  assert.ok(second.bad.some((b) => b.reason.includes("not one the Collective stores")));
  assert.equal(second.event.odds.some((o) => o.market === "player_pass_tds"), false);
});

check("a player line under a market key we DO store is still refused", () => {
  // The dangerous case the market-key check cannot catch: a prop arriving
  // under "totals". Without the description guard, "Over 1.5 passing TDs"
  // would be stored as the game total and poison the consensus.
  const { event, bad } = TA.readTaEvent(
    {
      id: "p", commence_time: "2026-09-13T17:00:00Z",
      home_team: "Cincinnati Bengals", away_team: "Tampa Bay Buccaneers",
      bookmakers: [{
        key: "draftkings", markets: [{
          key: "totals",
          outcomes: [
            { name: "Over", price: -130, point: 1.5, description: "Joe Burrow" },
            { name: "Over", price: -110, point: 47.5 },
          ],
        }],
      }],
    },
    { markets: MARKETS, now: NOW },
  );
  assert.equal(event.odds.length, 1);
  assert.equal(event.odds[0].line, 47.5);
  assert.ok(bad.some((b) => b.reason.includes("player description")));
});

check("an unmapped row carries a bounded sample, not the whole payload", () => {
  const [, second] = readAll();
  for (const b of second.bad) {
    assert.ok(JSON.stringify(b.sample ?? null).length <= 420);
  }
});

check("an event missing its teams yields no event and one clear reason", () => {
  const { event, bad } = TA.readTaEvent(
    { id: "x", commence_time: "2026-09-13T17:00:00Z" },
    { markets: MARKETS, now: NOW },
  );
  assert.equal(event, null);
  assert.equal(bad.length, 1);
  assert.ok(bad[0].reason.includes("home_team"));
});

check("a non-object event does not throw", () => {
  for (const junk of [null, undefined, 42, "nope", []]) {
    const { event, bad } = TA.readTaEvent(junk, { markets: MARKETS, now: NOW });
    assert.equal(event, null);
    assert.equal(bad.length, 1);
  }
});

check("asking for fewer markets drops the others without reporting them", () => {
  // A market we did not ask for is not an anomaly, so it must not show up as
  // an unmapped row and turn every run "partial".
  const { event, bad } = TA.readTaEvent(fixture[0], { markets: ["spread"], now: NOW });
  assert.ok(event.odds.every((o) => o.market === "spread"));
  assert.equal(bad.length, 0);
});

// ------------------------------------------------------------------ safety

check("the adapter holds no credential and no key ever reaches a row", () => {
  const src = readFileSync(join(SHARED, "theoddsapi.ts"), "utf8");
  // The key is read from the environment in exactly one place.
  const reads = src.match(/Deno\.env\.get\("THE_ODDS_API_KEY"\)/g) ?? [];
  assert.equal(reads.length, 1);
  assert.equal(/apiKey\s*=\s*["'][A-Za-z0-9]{8,}/.test(src), false);

  const all = JSON.stringify(readAll());
  assert.equal(all.includes("apiKey"), false);
});

check("oddsFormat is pinned to american, never left to default to decimal", () => {
  // The default is decimal, and 1.91 parses as a number just fine. Omitting
  // this does not fail loudly; it stores quiet nonsense.
  const src = readFileSync(join(SHARED, "theoddsapi.ts"), "utf8");
  assert.ok(src.includes('u.searchParams.set("oddsFormat", "american")'));
});

check("a decimal price is refused, so a format regression cannot pass silently", () => {
  const { event, bad } = TA.readTaEvent(
    {
      id: "d", commence_time: "2026-09-13T17:00:00Z",
      home_team: "Cincinnati Bengals", away_team: "Tampa Bay Buccaneers",
      bookmakers: [{
        key: "draftkings", markets: [{
          key: "spreads",
          outcomes: [{ name: "Cincinnati Bengals", price: 1.91, point: -2.5 }],
        }],
      }],
    },
    { markets: MARKETS, now: NOW },
  );
  assert.equal(event.odds.length, 0);
  assert.ok(bad.some((b) => b.reason.includes("american price")));
});

// ------------------------------------------------ diagnosable failures
// Exercised against real Response objects rather than matched in the source:
// what matters is the string an operator ends up reading in ingest_runs.

const resp = (body, status = 401) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

check("a 401 reports the vendor's own explanation, not just the status", async () => {
  // "invalid key" and "quota reached" are BOTH 401 and need opposite fixes:
  // a different key versus a different plan. A bare status cannot tell them
  // apart, and guessing wrong costs another round trip.
  const invalid = await TA.taErrorDetail(
    resp(JSON.stringify({ message: "The api key provided is invalid or incorrect." })));
  assert.match(invalid, /api key provided is invalid/);

  const quota = await TA.taErrorDetail(
    resp(JSON.stringify({ message: "Usage quota has been reached." })));
  assert.match(quota, /Usage quota has been reached/);

  assert.notEqual(invalid, quota);
});

check("it reads the other names this API uses for the same field", async () => {
  assert.match(await TA.taErrorDetail(resp(JSON.stringify({ error: "nope" }))), /nope/);
  assert.match(await TA.taErrorDetail(resp(JSON.stringify({ error_message: "nah" }))), /nah/);
});

check("a non-JSON body is still reported rather than discarded", async () => {
  const out = await TA.taErrorDetail(new Response("upstream exploded", { status: 502 }));
  assert.match(out, /upstream exploded/);
});

check("an empty body yields no suffix, so the reason stays clean", async () => {
  assert.equal(await TA.taErrorDetail(new Response("", { status: 401 })), "");
  assert.equal(await TA.taErrorDetail(new Response("   ", { status: 401 })), "");
});

check("the detail is bounded, so an error body cannot balloon a run record", async () => {
  const out = await TA.taErrorDetail(resp(JSON.stringify({ message: "x".repeat(5000) })));
  assert.ok(out.length <= 302, `expected a bounded suffix, got ${out.length}`);
});

check("newlines are flattened, so the reason stays one line", async () => {
  const out = await TA.taErrorDetail(new Response("line one\nline two\n\tthree", { status: 500 }));
  assert.equal(out.includes("\n"), false);
  assert.match(out, /line one line two three/);
});

check("a key echoed back by a vendor never reaches the run record", async () => {
  // This API does not echo the key, but a body is untrusted text and a
  // credential must not ride one into a stored row.
  ENV.THE_ODDS_API_KEY = "supersecretkey123";
  try {
    const out = await TA.taErrorDetail(
      resp(JSON.stringify({ message: "bad key supersecretkey123 rejected" })));
    assert.equal(out.includes("supersecretkey123"), false);
    assert.match(out, /bad key .* rejected/);
  } finally {
    delete ENV.THE_ODDS_API_KEY;
  }
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) {
  console.error("SOME ADAPTER TESTS FAILED");
} else {
  console.log("ALL THE ODDS API ADAPTER TESTS PASSED");
}
