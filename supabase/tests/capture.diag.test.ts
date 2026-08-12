// supabase/tests/capture.diag.test.ts
// ============================================================================
// HANDLER-level tests for capture: authorization, preconditions, sport
// resolution, response semantics and ?diag=1.
//
// The pure-logic suite (capture.test.ts) covers pricing and flag discipline.
// This one drives the actual Deno.serve handler with a MOCKED Odds API so the
// paths that decide ok / status / HTTP code are exercised without a live key,
// a live database, or a single unit of quota.
//
// Nothing here writes: every case runs ?diag=1, which is the mode whose whole
// contract is "read real odds, persist nothing".
//
// RUN: node --experimental-strip-types --import ./supabase/tests/_deno-shim.mjs \
//        supabase/tests/capture.diag.test.ts
// ============================================================================

let PASS = 0, FAIL = 0, N = 0;
const rows: { n: number; name: string; ok: boolean; detail: string }[] = [];
function check(name: string, cond: boolean, detail = "") {
  N++; if (cond) PASS++; else FAIL++;
  rows.push({ n: N, name, ok: cond, detail });
}

// ---- env must be set BEFORE the module is imported: it reads config at load.
process.env.CRON_SECRET = "test-secret";
process.env.ODDS_API_KEY = "test-key";
process.env.CAPTURE_SPORTS = "baseball_mlb";
process.env.CAPTURE_AUTO_PREFIXES = "tennis_";
process.env.SUPABASE_URL = "http://localhost";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

// ---- capture the handler Deno.serve() is called with.
let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno.serve = (fn: any) => { handler = fn; };

// ---- a mock Odds API. `plan` decides what each endpoint returns.
type Plan = { sports?: any; odds?: any };
let plan: Plan = {};
const evt = (id: string, books: [string, number, number][]) => ({
  id, sport_key: "baseball_mlb", sport_title: "MLB",
  commence_time: new Date(Date.now() + 3600e3).toISOString(),
  home_team: "Home", away_team: "Away",
  bookmakers: books.map(([key, a, b]) => ({
    key, title: key,
    markets: [{ key: "h2h", outcomes: [{ name: "Away", price: a }, { name: "Home", price: b }] }],
  })),
});
globalThis.fetch = (async (u: any) => {
  const url = String(u);
  const pick = url.includes("/sports/?") ? plan.sports : plan.odds;
  const r = pick ?? { status: 200, body: [] };
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json", "x-requests-remaining": "123" },
  });
}) as any;

const call = async (qs: string, secret: string | null = "test-secret") => {
  const res = await handler(new Request(`http://x/capture${qs}`, {
    headers: secret == null ? {} : { "x-cron-secret": secret },
  }));
  return { res, body: await res.json() };
};

async function main() {
  await import("../functions/capture/index.ts");
  check("Deno.serve handler was registered", typeof handler === "function");

  /* ---- authorization ---------------------------------------------------- */
  {
    const { res, body } = await call("?diag=1", null);
    check("A caller with no x-cron-secret is refused",
      res.status === 401 && body.ok === false && body.error === "unauthorized", `${res.status}`);
    check("...and the refusal names the precondition without leaking the secret",
      typeof body.reason === "string" && !JSON.stringify(body).includes("test-secret"));
  }
  {
    const { res } = await call("?diag=1", "wrong");
    check("A caller with the WRONG secret is refused", res.status === 401);
  }

  /* ---- diagnostic mode writes nothing and reports scope ----------------- */
  {
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 200, body: [evt("e1", [["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["soft", 2.10, 1.80]])] },
    };
    const { res, body } = await call("?diag=1");
    check("diag returns 200", res.status === 200, `${res.status}`);
    check("diag is labelled as a diagnostic run",
      body.status === "diagnostic" && body.mode === "diagnostic", `${body.status}/${body.mode}`);
    check("diag states that persistence was skipped ON PURPOSE",
      body.persistence === "skipped_intentionally", `${body.persistence}`);
    check("diag reports the single sport it scoped to",
      body.sports === 1 && body.diag_scope_sport === "baseball_mlb", JSON.stringify(body.sports_list));
    check("diag reports how many EVENTS the provider returned",
      body.per_sport_events?.baseball_mlb === 1, JSON.stringify(body.per_sport_events));
    check("diag reports how many outcomes priced", body.priced === 2, `priced=${body.priced}`);
    check("diag reports the books it saw",
      Array.isArray(body.books_seen) && body.books_seen.length === 3, JSON.stringify(body.books_seen));
    check("diag reports flaggable candidates", body.flaggable_candidates >= 1, `${body.flaggable_candidates}`);
    check("diag shows representative flaggable candidates",
      Array.isArray(body.flaggable_candidate_samples) && body.flaggable_candidate_samples.length >= 1);
    check("diag never reports rows written",
      body.new_signals === 0 && body.refreshed === 0 && body.ticks_written === 0 && body.flag_frozen === 0,
      `${body.new_signals}/${body.refreshed}/${body.ticks_written}/${body.flag_frozen}`);
    check("diag exposes no secrets",
      !JSON.stringify(body).includes("test-secret") && !JSON.stringify(body).includes("test-key"));
  }

  /* ---- rejection reasons are visible without reading the source --------- */
  {
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 200, body: [evt("e2", [
        ["bookA", 1.90, 1.95], ["bookB", 1.92, 1.93], ["bookC", 1.88, 1.98], ["stale", 12.0, 1.05]])] },
    };
    const { body } = await call("?diag=1");
    check("A board of broken prices is reported as REJECTED, not as a quiet day",
      body.flag_rejected_total >= 1
      && body.flag_rejected_by_reason?.best_price_is_an_outlier_vs_the_other_books >= 1,
      JSON.stringify(body.flag_rejected_by_reason));
    check("...with a representative example so the cause is legible",
      Array.isArray(body.flag_rejected_samples) && body.flag_rejected_samples.length >= 1);
  }

  /* ---- a provider failure is never a quiet day -------------------------- */
  {
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 401, body: { message: "bad key" } },
    };
    const { res, body } = await call("?diag=1");
    check("A 401 from the odds provider is NOT reported as ok",
      body.ok === false && res.status === 500, `ok=${body.ok} status=${res.status}`);
    check("...and the HTTP status is carried per sport so it can be acted on",
      body.errored?.[0]?.status === 401, JSON.stringify(body.errored));
  }
  {
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 429, body: { message: "quota" } },
    };
    const { body } = await call("?diag=1");
    check("An exhausted quota (429) is distinguishable from a bad key (401)",
      body.errored?.[0]?.status === 429, JSON.stringify(body.errored));
  }

  /* ---- events that price to nothing vs no events at all ----------------- */
  {
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 200, body: [] },
    };
    const { body } = await call("?diag=1");
    check("An empty slate is reported as captured-nothing, not success",
      body.ok === false && body.per_sport_events.baseball_mlb === 0, `ok=${body.ok}`);
  }
  {
    // events ARRIVE but every market is malformed — the v6 crash case.
    plan = {
      sports: { status: 200, body: [{ key: "baseball_mlb", active: true, has_outrights: false }] },
      odds: { status: 200, body: [{
        id: "bad", sport_key: "baseball_mlb", sport_title: "MLB",
        commence_time: new Date().toISOString(), home_team: "H", away_team: "A",
        bookmakers: [{ key: "b", title: "B", markets: [{ key: "h2h" }] }],
      }] },
    };
    const { body } = await call("?diag=1");
    check("A feed of malformed markets does NOT crash the run",
      typeof body.priced === "number", JSON.stringify(body).slice(0, 200));
    check("...it is reported as events-returned-but-nothing-priced",
      body.per_sport_events.baseball_mlb === 1 && body.priced === 0,
      `events=${body.per_sport_events.baseball_mlb} priced=${body.priced}`);
  }

  /* ---- sport resolution ------------------------------------------------- */
  {
    plan = {
      sports: { status: 500, body: { message: "down" } },
      odds: { status: 200, body: [evt("e3", [["a", 1.90, 1.95], ["b", 1.92, 1.93]])] },
    };
    const { body } = await call("?diag=1");
    check("A FAILED discovery call is reported, not silently treated as 'no tennis today'",
      body.sports_discovery_ok === false && typeof body.sports_discovery_error === "string",
      JSON.stringify(body.sports_discovery_ok));
    check("...and the stable configured sport is still captured",
      body.priced === 2 && body.sports_list[0] === "baseball_mlb", `priced=${body.priced}`);
  }
  {
    plan = {
      sports: { status: 200, body: [
        { key: "baseball_mlb", active: true, has_outrights: false },
        { key: "tennis_atp_wimbledon", active: true, has_outrights: false },
        { key: "tennis_futures", active: true, has_outrights: true },
        { key: "americanfootball_nfl_preseason", active: true, has_outrights: false },
        { key: "soccer_epl", active: true, has_outrights: false },
      ] },
      odds: { status: 200, body: [evt("e4", [["a", 1.90, 1.95], ["b", 1.92, 1.93]])] },
    };
    const { body } = await call("?diag=1");
    check("Rotating tennis tournaments are auto-discovered",
      body.auto_added.includes("tennis_atp_wimbledon"), JSON.stringify(body.auto_added));
    check("NFL preseason is auto-discovered by prefix",
      body.auto_added.includes("americanfootball_nfl_preseason"), JSON.stringify(body.auto_added));
    check("Outright/futures markets are NOT auto-added",
      !body.auto_added.includes("tennis_futures"), JSON.stringify(body.auto_added));
    check("An unrelated active sport is not auto-added",
      !body.auto_added.includes("soccer_epl"), JSON.stringify(body.auto_added));
  }

  console.log("\n=========== capture handler / diagnostic tests ===========");
  for (const r of rows) {
    console.log(`${r.ok ? " ok " : "FAIL"}  #${String(r.n).padStart(2)} ${r.name}`
      + (!r.ok && r.detail ? `\n           ${r.detail}` : ""));
  }
  console.log("----------------------------------------------------------");
  console.log(`TOTAL ${PASS} passed, ${FAIL} failed, ${N} total`);
  console.log("==========================================================");
  if (FAIL && typeof process !== "undefined") process.exitCode = 1;
}

await main();
