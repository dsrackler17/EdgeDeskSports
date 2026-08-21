// Offline tests for the OddsBlaze adapter, run against a captured response
// rather than a hand-written mock. The fixture in fixtures/ is a real
// DraftKings/MLB payload with the alternate lines thinned out and the
// per-selection deep links and SGP tokens removed; every field the adapter
// reads is exactly as the provider sent it.
//
//   node --experimental-strip-types tools/collective/test_oddsblaze.ts
//
// No network, no database, no credentials.

import { readFileSync } from "node:fs";

import {
  classifyMarket,
  marketCensus,
  normalizeOddsBlaze,
  oddsUrl,
  parseAmericanPrice,
  parsePoints,
  redactUrl,
  seasonFor,
  type SeasonWindow,
  type SnapshotRow,
} from "../../supabase/functions/_shared/oddsblaze.ts";

let failures = 0;
let checks = 0;

function eq(actual: unknown, expected: unknown, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failures++;
    console.error(`FAIL ${what}\n  expected ${b}\n  actual   ${a}`);
  }
}

function ok(cond: boolean, what: string): void {
  eq(Boolean(cond), true, what);
}

const fixtureUrl = new URL("./fixtures/oddsblaze_mlb_draftkings.json", import.meta.url);
const feed = JSON.parse(readFileSync(fixtureUrl, "utf8"));

// The 2026 MLB window as migration 19 seeds it.
const SEASONS: SeasonWindow[] = [
  { sport_code: "MLB", season: 2026, starts_on: "2026-03-25", ends_on: "2026-11-08" },
  { sport_code: "NFL", season: 2026, starts_on: "2026-08-01", ends_on: "2027-02-15" },
];

// ------------------------------------------------------------- price/points

eq(parseAmericanPrice("-132"), -132, "price: negative string");
eq(parseAmericanPrice("+168"), 168, "price: plus-prefixed string");
eq(parseAmericanPrice(-181), -181, "price: number");
eq(parseAmericanPrice("-1100"), -1100, "price: four figures");
eq(parseAmericanPrice("1.91"), null, "price: decimal odds rejected, not converted");
eq(parseAmericanPrice("0.52"), null, "price: probability rejected");
eq(parseAmericanPrice("-99"), null, "price: sub-100 magnitude rejected");
eq(parseAmericanPrice(""), null, "price: empty rejected");

eq(parsePoints(-1.5), -1.5, "points: number");
eq(parsePoints("+3.5"), 3.5, "points: plus-prefixed");
eq(parsePoints("PK"), 0, "points: pick'em is zero");
eq(parsePoints("n/a"), null, "points: junk rejected");

// ------------------------------------------------------------ market names

eq(classifyMarket("Run Line"), "spread", "market: MLB run line is the spread");
eq(classifyMarket("Point Spread"), "spread", "market: NFL point spread");
eq(classifyMarket("Moneyline"), "moneyline", "market: moneyline");
eq(classifyMarket("Total Runs"), "total", "market: MLB total");

// The whole reason classification is exact: every one of these is a
// different bet that a substring rule would file as the game line.
for (
  const derivative of [
    "1st 5 Innings Run Line",
    "1st 3 Innings Moneyline",
    "3rd Inning Run Line",
    "9th Inning Run Line",
    "1st Inning Total Runs",
    "1st Inning Total Runs Odd/Even",
    "Team Total Runs",
    "Team Total Runs Odd/Even",
    "Player Hits",
    "Player Hits + Runs + RBIs",
    "Player Walks Allowed",
    "Alternate Run Line",
  ]
) {
  eq(classifyMarket(derivative), null, `market: "${derivative}" is not the game line`);
}

// ---------------------------------------------------------------- seasons

eq(seasonFor("MLB", "2026-08-21T00:05:00.000Z", SEASONS), 2026, "season: in window");
eq(seasonFor("MLB", "2026-01-04T00:00:00.000Z", SEASONS), null, "season: before opening day");
eq(seasonFor("NBA", "2026-08-21T00:05:00.000Z", SEASONS), null, "season: unconfigured sport");

// -------------------------------------------------------------- normalize

const res = normalizeOddsBlaze(feed, {
  leagueToSport: { mlb: "MLB" },
  seasons: SEASONS,
  now: "2026-08-20T22:00:00.000Z",
});

eq(res.book, "DraftKings", "feed: sportsbook name");
eq(res.league, "mlb", "feed: league id");
eq(res.captured_at, "2026-08-20T21:52:44.736Z", "feed: captured_at is the feed's own `updated`");
eq(res.rows.length, feed.events.length, "normalize: every event produced a row");
eq(res.links.length, feed.events.length, "normalize: every event produced an id link");

const byAway = new Map<string, SnapshotRow>(res.rows.map((r) => [r.away_team, r]));

// Washington @ Texas, read straight off the capture:
//   Run Line   WSH +1.5 -132   TEX -1.5 +109      (both main:true)
//   Total Runs Over 7.5 -105   Under 7.5 -115
//   Moneyline  WSH +168        TEX -181
const tex = byAway.get("Washington Nationals");
ok(tex !== undefined, "normalize: Washington @ Texas is present");
if (tex) {
  eq(tex.sport, "MLB", "row: sport from the league id");
  eq(tex.season, 2026, "row: season from the configured window");
  eq(tex.home_team, "Texas Rangers", "row: home team");
  eq(tex.kickoff, "2026-08-21T00:05:00.000Z", "row: kickoff");
  eq(tex.book, "DraftKings", "row: book");
  eq(tex.source, "oddsblaze", "row: source");
  eq(tex.home_line, -1.5, "row: home run line, home convention");
  eq(tex.home_price, 109, "row: home run line price");
  eq(tex.away_line, 1.5, "row: away run line");
  eq(tex.away_price, -132, "row: away run line price");
  eq(tex.total_line, 7.5, "row: total");
  eq(tex.over_price, -105, "row: over price");
  eq(tex.under_price, -115, "row: under price");
  eq(tex.home_ml_price, -181, "row: home moneyline");
  eq(tex.away_ml_price, 168, "row: away moneyline");
}

// DraftKings hangs a second main run line (-1) on that game. The first in
// feed order is the one stored; the second must not overwrite it, and the
// stored pair must always satisfy home_line = -away_line.
for (const r of res.rows) {
  ok(Math.abs(r.home_line ?? 0) === 1.5, `row: ${r.away_team} kept the first main run line`);
  eq(r.home_line, -(r.away_line as number), `row: ${r.away_team} home convention holds`);
  ok(r.total_line !== null && r.total_line > 0, `row: ${r.away_team} has a total`);
  ok(r.home_ml_price !== null && r.away_ml_price !== null, `row: ${r.away_team} has both moneylines`);
}

// A team total is priced on one team and would look exactly like a spread to
// a looser reader. Nothing in the fixture's team totals may reach a row: the
// totals stored are the game totals, which are all above 6 runs.
for (const r of res.rows) {
  ok((r.total_line as number) >= 6, `row: ${r.away_team} total is the game total, not a team total`);
}

// ------------------------------------------------------------ id mappings

const link = res.links.find((l) => l.away_team === "Washington Nationals");
ok(link !== undefined, "link: Washington @ Texas linked");
if (link) {
  eq(link.provider, "oddsblaze", "link: provider");
  eq(link.provider_event_id, "d18ab4b2-cbc4-5801-951c-191abec1070d", "link: provider event id");
  eq((link.mappings as Record<string, unknown>).MLB, "822861", "link: official MLB game id flattened");
  eq(
    (link.mappings as Record<string, unknown>).Kalshi,
    "KXMLBGAME-26AUG202005WSHTEX",
    "link: Kalshi id flattened",
  );
  eq((link.mappings as Record<string, unknown>).home_abbr, "TEX", "link: home abbreviation");
  eq((link.mappings as Record<string, unknown>).away_abbr, "WSH", "link: away abbreviation");
}

// ------------------------------------------------------------------ skips

// Nothing may be dropped for a reason that means the reader misread the feed.
for (const s of res.skipped) {
  ok(
    s.reason !== "spread_sides_disagree" && s.reason !== "unreadable_teams" &&
      s.reason !== "unreadable_kickoff",
    `skip: unexpected reason ${s.reason}`,
  );
}

// A league the Collective has no sport for is reported, not guessed at.
const unmapped = normalizeOddsBlaze(feed, {
  leagueToSport: { nfl: "NFL" },
  seasons: SEASONS,
  now: "2026-08-20T22:00:00.000Z",
});
eq(unmapped.rows.length, 0, "unmapped league: no rows");
eq(unmapped.skipped[0]?.reason, "league_not_mapped_to_sport", "unmapped league: reported as such");

// A kickoff outside every configured window is refused rather than assigned a
// guessed season, because resolve_game_ref would silently fail to match.
const noSeason = normalizeOddsBlaze(feed, {
  leagueToSport: { mlb: "MLB" },
  seasons: [{ sport_code: "MLB", season: 2025, starts_on: "2025-03-25", ends_on: "2025-11-08" }],
  now: "2026-08-20T22:00:00.000Z",
});
eq(noSeason.rows.length, 0, "no season window: no rows");
eq(
  noSeason.skipped[0]?.reason,
  "kickoff_outside_configured_seasons",
  "no season window: reported as such",
);

// A live game is not a pregame market and is left out by default.
const liveFeed = JSON.parse(JSON.stringify(feed));
liveFeed.events[0].live = true;
const live = normalizeOddsBlaze(liveFeed, {
  leagueToSport: { mlb: "MLB" },
  seasons: SEASONS,
  now: "2026-08-20T22:00:00.000Z",
});
eq(live.rows.length, feed.events.length - 1, "live: in-progress game excluded by default");
ok(live.skipped.some((s) => s.reason === "live_game"), "live: exclusion is reported");
eq(
  normalizeOddsBlaze(liveFeed, {
    leagueToSport: { mlb: "MLB" },
    seasons: SEASONS,
    now: "2026-08-20T22:00:00.000Z",
    includeLive: true,
  }).rows.length,
  feed.events.length,
  "live: included when asked for",
);

// An empty or unrecognizable body is an empty result with a reason, never a throw.
eq(normalizeOddsBlaze({}, { leagueToSport: {}, seasons: [], now: "2026-01-01T00:00:00Z" }).skipped[0]
  ?.reason, "no_events_in_response", "empty body: reported, not thrown");
eq(normalizeOddsBlaze(null, { leagueToSport: {}, seasons: [], now: "2026-01-01T00:00:00Z" }).rows.length,
  0, "null body: no rows");

// ----------------------------------------------------------------- census

const census = marketCensus(feed);
const runLine = census.find((c) => c.market === "Run Line");
eq(runLine?.read_as, "spread", "census: Run Line reads as the spread");
eq(census.find((c) => c.market === "Team Total Runs")?.read_as, "ignored", "census: team total ignored");

// --------------------------------------------------------------- the key

// The key is a query parameter, and it must never survive into anything the
// adapter hands back to a caller or a log.
const url = oddsUrl(null, "draftkings", "mlb", "super-secret-key");
ok(url.startsWith("https://odds.oddsblaze.com/?"), "url: documented endpoint");
ok(url.includes("sportsbook=draftkings") && url.includes("league=mlb"), "url: sportsbook and league");
ok(url.includes("key=super-secret-key"), "url: key is sent");
ok(!redactUrl(url).includes("super-secret-key"), "url: key is redacted for display");
ok(redactUrl(url).includes("key=REDACTED"), "url: redaction is visible");
eq(
  oddsUrl("https://example.test/v1/odds?sportsbook=pinnacle", "draftkings", "mlb", "k"),
  "https://example.test/v1/odds?sportsbook=pinnacle&league=mlb&key=k",
  "url: an override's own parameters are not overwritten",
);

// -----------------------------------------------------------------------

console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
