// End-to-end pipeline test: fixture -> real adapter -> real SQL.
//
//   node --experimental-strip-types tests/collective/pipeline_e2e.test.mjs
//
// Takes an OddsBlaze-shaped payload through the actual TypeScript adapter,
// then hands the actual normalized envelope to the actual odds.ingest_batch
// running on a real Postgres, and asserts on what landed. The only step not
// exercised is the outbound HTTPS request to the vendor.
//
// Requires: a local Postgres reachable as the postgres superuser, with
// tests/collective/odds_schema_fixture.sql and the migration applied to a
// database named by PGDATABASE (default "oddspipe").

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

globalThis.Deno = { env: { get: () => "" } };

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const DB = process.env.PGDATABASE || "oddspipe";

const OB = await import(join(ROOT, "supabase", "functions", "_shared", "oddsblaze.ts"));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "oddsblaze_nfl_sample.json"), "utf8"),
);

// Statements go in over stdin: they are multi-line, and a shell-quoted -c
// argument mangles the newlines.
function sql(text) {
  return execFileSync("su", ["postgres", "-c",
    `psql -d ${DB} -t -A -v ON_ERROR_STOP=1 -f -`,
  ], { encoding: "utf8", input: text, maxBuffer: 64 * 1024 * 1024 }).trim();
}
function sqlJson(text) {
  const out = sql(text);
  return out ? JSON.parse(out) : null;
}

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

// ---- 1. the adapter turns three vendor responses into one normalized slate
const merged = OB.mergeBooks([
  { book: "draftkings", body: fixture.draftkings },
  { book: "fanduel", body: fixture.fanduel_flat_variant },
  { book: "betmgm", body: fixture.unmappable_rows },
]);
const payload = { events: merged.events };

check("adapter produced a slate the database can accept", () => {
  assert.ok(merged.events.length >= 2);
  assert.ok(merged.events.every((e) => e.home && e.away && e.commence_time));
  assert.ok(merged.events.every((e) => Array.isArray(e.odds)));
  // Nothing that failed to map is smuggled through as a null-filled row.
  assert.ok(merged.events.every((e) => e.odds.every((o) => Number.isFinite(o.price))));
});

// ---- 2. hand it to the real SQL ingest
const runId = sql(`select odds.begin_ingest('oddsblaze','nfl','e2e-test')`);
const escaped = JSON.stringify(payload).replaceAll("'", "''");
const res = sqlJson(
  `select odds.ingest_batch(${runId}, 'oddsblaze', 'nfl', '${escaped}'::jsonb)`,
);

check("SQL accepted the adapter's envelope verbatim", () => {
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.snapshots_written > 0);
});

check("provider team names resolved to Collective team codes", () => {
  const rows = sqlJson(
    `select jsonb_agg(jsonb_build_object('h',home_code,'a',away_code) order by commence_time)
       from odds.events`,
  );
  assert.deepEqual(rows, [{ h: "KC", a: "BUF" }, { h: "DAL", a: "NYG" }]);
});

check("two books on the same game produced one event, not two", () => {
  assert.equal(Number(sql(`select count(*) from odds.events`)), 2);
  assert.equal(
    Number(sql(
      `select count(distinct book_id) from odds.snapshots s
        join odds.events e on e.id=s.event_id where e.home_code='KC'`,
    )),
    3,
    "DraftKings, FanDuel and BetMGM prices all landed on the one KC game",
  );
});

check("markets landed under canonical ids with the right numbers", () => {
  const dk = sqlJson(
    `select jsonb_object_agg(market_id || ':' || outcome,
              jsonb_build_object('line', line, 'price', price))
       from odds.current_main s join odds.events e on e.id = s.event_id
      where e.home_code='KC' and s.book_id='draftkings'`,
  );
  // numeric columns arrive as JSON numbers, which is what the UI consumes.
  assert.equal(Number(dk["spread:home"].line), -3.5);
  assert.equal(dk["spread:home"].price, -110);
  assert.equal(dk["moneyline:home"].line, null, "a moneyline stores no line");
  assert.equal(dk["moneyline:home"].price, -185);
  assert.equal(Number(dk["total:over"].line), 47.5);
});

check("alternate lines are stored but kept out of the main-line view", () => {
  const alts = Number(sql(
    `select count(*) from odds.snapshots where is_main = false`,
  ));
  assert.ok(alts >= 1, "the -7.5 alternate was stored");
  const mainOnly = Number(sql(
    `select count(*) from odds.current_main s join odds.events e on e.id=s.event_id
      where e.home_code='KC' and s.book_id='draftkings' and s.market_id='spread'
        and s.line = -7.5`,
  ));
  assert.equal(mainOnly, 0, "and it does not pollute the main line");
});

check("a live vendor event is stored live", () => {
  assert.equal(sql(`select is_live from odds.events where home_code='DAL'`), "t");
});

check("unmappable vendor rows never reached the database", () => {
  // The BetMGM fixture carries a player prop, an unknown market, a price of
  // 0, an unknown team and a spread with no line. Exactly one of its six
  // rows is a real game line.
  const mgm = Number(sql(
    `select count(*) from odds.snapshots where book_id='betmgm'`,
  ));
  assert.equal(mgm, 1, "only the valid BetMGM moneyline landed");
  assert.equal(
    Number(sql(`select count(*) from odds.team_aliases
                 where alias_norm = 'someunknownfranchise'`)),
    0,
    "an unknown team did not create an alias",
  );
});

// ---- 3. a second identical run must not duplicate anything
const before = Number(sql(`select count(*) from odds.snapshots`));
const run2 = sql(`select odds.begin_ingest('oddsblaze','nfl','e2e-test')`);
const res2 = sqlJson(
  `select odds.ingest_batch(${run2}, 'oddsblaze', 'nfl', '${escaped}'::jsonb)`,
);

check("re-polling an unchanged market writes nothing", () => {
  assert.equal(res2.snapshots_written, 0, JSON.stringify(res2));
  assert.ok(res2.snapshots_unchanged > 0);
  assert.equal(Number(sql(`select count(*) from odds.snapshots`)), before);
  assert.equal(Number(sql(`select count(*) from odds.events`)), 2);
});

// ---- 4. a real move is stored
const moved = structuredClone(payload);
const kc = moved.events.find((e) => e.home.includes("Kansas City"));
const dkSpread = kc.odds.find((o) => o.book === "draftkings" && o.market === "spread" && o.outcome === "home");
dkSpread.line = -4;
dkSpread.price = -105;
const run3 = sql(`select odds.begin_ingest('oddsblaze','nfl','e2e-test')`);
const res3 = sqlJson(
  `select odds.ingest_batch(${run3}, 'oddsblaze', 'nfl', '${JSON.stringify(moved).replaceAll("'", "''")}'::jsonb)`,
);

check("a real line move is stored as a new state, not an overwrite", () => {
  assert.equal(res3.snapshots_written, 1, JSON.stringify(res3));
  const hist = sqlJson(
    `select jsonb_agg(jsonb_build_object('l',s.line,'p',s.price) order by s.id)
       from odds.snapshots s join odds.events e on e.id=s.event_id
      where e.home_code='KC' and s.book_id='draftkings' and s.market_id='spread'
        and s.outcome='home' and s.is_main`,
  );
  assert.deepEqual(hist.map((h) => [Number(h.l), h.p]), [[-3.5, -110], [-4, -105]]);
});

// ---- 5. the read payload the frontend will actually receive
const board = sqlJson(`select collective.odds_board('nfl', null, null, true, 40)`);

check("the board payload is shaped for the UI", () => {
  assert.equal(board.games.length, 2);
  const g = board.games.find((x) => x.home === "KC");
  assert.ok(g.consensus, "consensus present");
  assert.ok(g.best, "best price present");
  assert.ok(g.books.spread.length > 0, "book grid present");
  assert.ok(board.last_odds_at, "a freshness timestamp is always present");
  assert.ok(board.stale_after_seconds > 0);
});

check("consensus follows the stated rules on real adapter output", () => {
  const g = board.games.find((x) => x.home === "KC");
  // DK moved to -4.0, FanDuel is at -3.5. Both are retail, so the median of
  // the two is -3.75.
  assert.equal(Number(g.consensus.spread.median), -3.75);
  assert.equal(Number(g.consensus.spread.books), 2);
  assert.equal(
    g.consensus.moneyline.method,
    "median of de-vigged two-way probabilities",
  );
});

check("best price is grouped by line, with no cross-line winner", () => {
  const g = board.games.find((x) => x.home === "KC");
  const home = g.best.spread.outcomes.home;
  const lines = home.lines.map((l) => Number(l.line)).sort((a, b) => a - b);
  assert.deepEqual(lines, [-4, -3.5]);
  assert.equal(home.best, undefined, "no single best across different lines");
  for (const l of home.lines) assert.ok(l.best.book, "each line names its own winner");
});

check("nothing in the stored rows carries a credential", () => {
  const raw = sql(`select coalesce(string_agg(raw::text, ' '), '') from odds.snapshots`);
  for (const needle of ["key=", "apikey", "api_key", "NFL_ODDS_API_KEY", "Bearer "]) {
    assert.ok(!raw.toLowerCase().includes(needle.toLowerCase()), `found ${needle} in stored raw`);
  }
  const runs = sql(`select coalesce(string_agg(coalesce(error_message,'') || ' ' ||
                     coalesce(unmatched::text,''), ' '), '') from odds.ingest_runs`);
  assert.ok(!/key=[^R&\s]/i.test(runs), "an ingest run recorded a raw key");
});

// ---- 6. the browser components, over the payload SQL actually produced
const { createRequire } = await import("node:module");
const requireCJS = createRequire(import.meta.url);
const MCOdds = requireCJS(join(ROOT, "collective", "odds.js"));

// This is what the edge function wraps around the board, so the renderers
// see exactly what a page will hand them.
const env = { stale_after_seconds: board.stale_after_seconds, last_updated: board.last_odds_at };
const kcGame = board.games.find((g) => g.home === "KC");

check("the browser renderers read the real payload", () => {
  const line = MCOdds.marketLine(kcGame, env);
  // DK moved to -4.0 and FanDuel is at -3.5, so the consensus median is -3.75.
  assert.match(line, /KC -3\.75/, line);
  assert.match(line, /O\/U/, "the total renders");
  assert.match(line, /Updated \d+s ago/, "the capture time is always attached");
});

check("the full card renders every book from the real payload", () => {
  const card = MCOdds.marketCard(kcGame, env);
  assert.match(card, /DraftKings/);
  assert.match(card, /FanDuel/);
  assert.match(card, /BetMGM/);
  assert.match(card, /at another line/, "lines are kept apart, not ranked together");
  // No sharp book is in this feed, so no sharp reference is rendered. The
  // section appears when one is present and is never synthesised from retail.
  assert.doesNotMatch(card, /SHARP REFERENCE/);
  assert.match(
    MCOdds.marketCard({ ...kcGame,
      consensus: { ...kcGame.consensus, sharp: { pinnacle: { spread: -3.5 } } } }, env),
    /SHARP REFERENCE/,
  );
});

check("the same payload gives every surface the same number", () => {
  // The wall, the board and the market page all call these two helpers on the
  // same object, so agreement here is agreement on the site.
  const a = MCOdds.consensusSpread(kcGame);
  const b = MCOdds.consensusSpread(board.games.find((g) => g.event_id === kcGame.event_id));
  assert.equal(a, b);
  assert.match(MCOdds.marketLine(kcGame, env), new RegExp(String(a).replace("-", "-")));
});

check("a model number and the market number are comparable", () => {
  // Both are home-convention spreads. -6.2 model against a -3.75 market.
  const e = MCOdds.edge(-6.2, MCOdds.consensusSpread(kcGame), kcGame.home, kcGame.away);
  assert.equal(Number(e.points.toFixed(2)), 2.45);
  assert.equal(e.side, "KC");
});

check("a game with no market renders as unavailable, not as zero", () => {
  const empty = { ...kcGame, last_odds_at: null, consensus: null, best: null };
  assert.match(MCOdds.marketLine(empty, env), /unavailable/i);
  assert.doesNotMatch(MCOdds.marketLine(empty, env), /-3\.75/);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error("SOME CHECKS FAILED");
else console.log("ALL PIPELINE E2E TESTS PASSED");
