// Tests for the browser odds components (collective/odds.js).
//
//   node tests/collective/odds_js.test.mjs
//
// The renderers are pure string builders over a payload, so they run outside
// a browser. The payload below is the shape collective_odds actually returns,
// copied from the SQL layer's own output in the end-to-end test.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MCOdds = require(join(ROOT, "collective", "odds.js"));

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

const now = Date.now();
const iso = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();

const ENV = { stale_after_seconds: 900, last_updated: iso(30) };

const GAME = {
  event_id: "11111111-1111-1111-1111-111111111111",
  collective_game_id: "22222222-2222-2222-2222-222222222222",
  home: "KC", away: "BUF", home_name: "Kansas City Chiefs", away_name: "Buffalo Bills",
  commence_time: new Date(now + 3600e3).toISOString(),
  status: "scheduled", is_live: false, market_closed: false,
  last_odds_at: iso(30), book_count: 4,
  consensus: {
    spread: { median: -3.75, mean: -3.75, stdev: 0.354, min: -4, max: -3.5, books: 2 },
    total: { median: 47.25, books: 2 },
    moneyline: {
      home_fair_prob: 0.6412, home_fair_american: -179,
      away_fair_prob: 0.3588, books: 2,
      method: "median of de-vigged two-way probabilities",
    },
    sharp: { pinnacle: { spread: -3.5, total: 47.5, moneyline_home: -183 } },
  },
  best: {
    spread: {
      market: "spread",
      outcomes: {
        home: {
          primary_line: -3.5,
          lines: [
            {
              line: -4, is_primary: false,
              best: { book: "betmgm", price: -105, price_decimal: 1.95238 },
              books: [
                { book: "betmgm", book_name: "BetMGM", is_sharp: false, price: -105, price_decimal: 1.95238, captured_at: iso(40) },
                { book: "draftkings", book_name: "DraftKings", is_sharp: false, price: -110, price_decimal: 1.90909, captured_at: iso(35) },
              ],
              latest_captured_at: iso(35),
            },
            {
              line: -3.5, is_primary: true,
              best: { book: "pinnacle", price: -108, price_decimal: 1.92593 },
              books: [
                { book: "pinnacle", book_name: "Pinnacle", is_sharp: true, price: -108, price_decimal: 1.92593, captured_at: iso(30) },
                { book: "fanduel", book_name: "FanDuel", is_sharp: false, price: -115, price_decimal: 1.86957, captured_at: iso(31) },
              ],
              latest_captured_at: iso(30),
            },
          ],
        },
      },
    },
    total: {
      market: "total",
      outcomes: {
        over: {
          primary_line: 47.5,
          lines: [{
            line: 47.5, is_primary: true,
            best: { book: "draftkings", price: -108, price_decimal: 1.92593 },
            books: [{ book: "draftkings", book_name: "DraftKings", is_sharp: false, price: -108, price_decimal: 1.92593, captured_at: iso(30) }],
            latest_captured_at: iso(30),
          }],
        },
      },
    },
    moneyline: { market: "moneyline", outcomes: {} },
  },
  opening: { "spread:home": { line: -2.5, books: 3, first_at: iso(86400) } },
  closing: {},
  books: {
    spread: [
      { book: "pinnacle", book_name: "Pinnacle", is_sharp: true, outcome: "home", line: -3.5, price: -108, price_decimal: 1.92593, captured_at: iso(30) },
      { book: "draftkings", book_name: "DraftKings", is_sharp: false, outcome: "home", line: -4, price: -110, price_decimal: 1.90909, captured_at: iso(35) },
    ],
  },
};

// ------------------------------------------------------------- formatting
check("American prices always carry a sign", () => {
  assert.equal(MCOdds.price(-110), "-110");
  assert.equal(MCOdds.price(135), "+135");
  assert.equal(MCOdds.price(null), "—");
  assert.equal(MCOdds.price(undefined), "—");
});

check("a missing number renders as a dash, never as zero", () => {
  assert.equal(MCOdds.line(null), "—");
  assert.equal(MCOdds.total(null), "—");
  assert.equal(MCOdds.pct(null), "—");
  // Zero is a real spread and must not be confused with "no line".
  assert.equal(MCOdds.line(0), "PK");
});

check("spreads render in home convention with a sign", () => {
  assert.equal(MCOdds.line(-3.5), "-3.5");
  assert.equal(MCOdds.line(3.5), "+3.5");
  assert.equal(MCOdds.line(-4), "-4");
  assert.equal(MCOdds.total(47.5), "47.5");
  assert.equal(MCOdds.total(47), "47");
});

// -------------------------------------------------------------- freshness
check("a recent capture is live", () => {
  const f = MCOdds.freshness(ENV, iso(30));
  assert.equal(f.state, "live");
  assert.ok(f.age <= 31);
});

check("an old capture is stale, and says how old", () => {
  const f = MCOdds.freshness(ENV, iso(1800));
  assert.equal(f.state, "stale");
  const html = MCOdds.freshChip(ENV, iso(1800));
  assert.match(html, /Stale/);
  assert.match(html, /30 minutes ago|30m ago/);
});

check("no timestamp means unavailable, not fresh", () => {
  assert.equal(MCOdds.freshness(ENV, null).state, "unavailable");
  assert.match(MCOdds.freshChip(ENV, null), /Odds unavailable/);
});

check("age is recomputed from the timestamp, not trusted from the payload", () => {
  // A cached response whose age_seconds says 5 must not read as 5s old later.
  const stale = { stale_after_seconds: 900, last_updated: iso(3600), age_seconds: 5 };
  assert.equal(MCOdds.freshness(stale).state, "stale");
});

// -------------------------------------------------------- reading a payload
check("consensus values are read from the documented fields", () => {
  assert.equal(MCOdds.consensusSpread(GAME), -3.75);
  assert.equal(MCOdds.consensusTotal(GAME), 47.25);
  assert.equal(MCOdds.consensusHomeProb(GAME), 0.6412);
  assert.equal(MCOdds.consensusSpread({}), null);
});

check("the sharp book is reachable separately from the consensus", () => {
  const p = MCOdds.sharp(GAME, "pinnacle");
  assert.equal(p.spread, -3.5);
  assert.notEqual(MCOdds.consensusSpread(GAME), p.spread, "sharp is not the consensus");
});

check("best price is read at the primary line, not across lines", () => {
  const b = MCOdds.bestAtPrimary(GAME, "spread", "home");
  assert.equal(b.line, -3.5, "the primary line is the one most books are on");
  assert.equal(b.book, "pinnacle");
  assert.equal(b.price, -108);
  assert.equal(b.other_lines, 1, "the -4 group is counted, not merged in");
});

check("a market with no prices returns null instead of an empty shell", () => {
  assert.equal(MCOdds.bestAtPrimary(GAME, "moneyline", "home"), null);
  assert.equal(MCOdds.bestAtPrimary({}, "spread", "home"), null);
});

// ------------------------------------------------------- model vs market
check("model-versus-market difference needs both numbers", () => {
  assert.equal(MCOdds.edge(null, -3.5, "KC", "BUF"), null);
  assert.equal(MCOdds.edge(-6.2, null, "KC", "BUF"), null);
  assert.match(MCOdds.edgeHtml(null, -3.5, "KC", "BUF"), /—/);
});

check("the difference is signed toward the side the model prefers", () => {
  // The spec's example: model KC -6.2 against a market of KC -3.5.
  const e = MCOdds.edge(-6.2, -3.5, "KC", "BUF");
  assert.equal(Number(e.points.toFixed(1)), 2.7);
  assert.equal(e.side, "KC");
  const other = MCOdds.edge(-1.5, -3.5, "KC", "BUF");
  assert.equal(Number(other.points.toFixed(1)), 2.0);
  assert.equal(other.side, "BUF", "a model shorter than the market leans away");
});

check("agreement is stated as agreement, not as a zero edge", () => {
  const e = MCOdds.edge(-3.5, -3.5, "KC", "BUF");
  assert.equal(e.points, 0);
  assert.equal(e.side, null);
  assert.match(MCOdds.edgeHtml(-3.5, -3.5, "KC", "BUF"), /in line/);
});

// ------------------------------------------------------------- rendering
check("the one-line market shows numbers, the book, and the capture time", () => {
  const html = MCOdds.marketLine(GAME, ENV);
  assert.match(html, /KC -3\.75/, "consensus spread in home convention");
  assert.match(html, /47\.25/, "consensus total");
  assert.match(html, /Pinnacle/, "the book behind the best price is named");
  assert.match(html, /Updated \d+s ago/, "capture time always present");
  assert.doesNotMatch(html, /LIVE/, "no live badge on a scheduled game");
});

check("a live game is the only thing that produces a LIVE badge", () => {
  const live = MCOdds.marketLine({ ...GAME, is_live: true }, ENV);
  assert.match(live, /LIVE/);
});

check("with no stored price the markup says so and shows the last update", () => {
  const html = MCOdds.marketLine({ ...GAME, last_odds_at: null }, ENV);
  assert.match(html, /Market unavailable/);
  assert.doesNotMatch(html, /-3\.75/, "no number is rendered when there is none");
});

check("a null game renders an explicit unavailable state", () => {
  assert.match(MCOdds.marketLine(null, ENV), /Market unavailable/);
  assert.match(MCOdds.marketCard(null, ENV), /Market unavailable/);
});

check("the full card separates lines and marks the best price within one", () => {
  const html = MCOdds.marketCard(GAME, ENV);
  assert.match(html, /Spread/);
  assert.match(html, /at another line/, "prices at another line are flagged, not ranked");
  assert.match(html, /mco-best/, "a winner is marked within a line");
  assert.match(html, /SHARP REFERENCE/, "the sharp book gets its own row");
  assert.match(html, /Kept out of the consensus/);
});

check("open, current and close are distinct, and an open market is not closed", () => {
  const html = MCOdds.marketCard(GAME, ENV);
  assert.match(html, /Open/);
  assert.match(html, /not closed/, "an unfinished market must not show a closing line");
  const closed = MCOdds.marketCard(
    { ...GAME, market_closed: true, closing: { "spread:home": { line: -4, books: 3 } } },
    ENV,
  );
  assert.match(closed, /Market closed/);
  assert.doesNotMatch(closed, /not closed/);
});

check("a market with no price says 'no price posted' for that outcome", () => {
  const html = MCOdds.marketCard(GAME, ENV);
  assert.match(html, /no price posted/, "the away spread has no group in this fixture");
});

check("movement renders every stored state and nothing when there is none", () => {
  assert.match(MCOdds.movementHtml({ points: [] }, GAME), /No stored movement/);
  const html = MCOdds.movementHtml({
    points: [
      { at: iso(7200), book: "draftkings", line: -3.5, price: -110, is_live: false },
      { at: iso(3600), book: "draftkings", line: -4, price: -105, is_live: false },
    ],
  }, GAME);
  assert.match(html, /-3\.5/);
  assert.match(html, /-4/);
  assert.match(html, /DraftKings/);
});

check("every rendered string escapes what came from the payload", () => {
  const nasty = { ...GAME, home: '<img src=x onerror=alert(1)>', home_name: '<script>x</script>' };
  const html = MCOdds.marketCard(nasty, ENV);
  assert.doesNotMatch(html, /<img /);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img/);
});

check("the component holds no provider URL and no credential", () => {
  const src = require("node:fs").readFileSync(join(ROOT, "collective", "odds.js"), "utf8");
  for (const needle of ["oddsblaze", "NFL_ODDS_API_KEY", "api_key", "apikey=", "?key="]) {
    assert.ok(!src.toLowerCase().includes(needle.toLowerCase()), `odds.js mentions ${needle}`);
  }
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME CHECKS FAILED");
else console.log("ALL COMPONENT TESTS PASSED");
