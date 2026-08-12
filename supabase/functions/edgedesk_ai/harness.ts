/* EdgeDesk edgedesk_ai test harness.
   Loads the REAL single-file function under Node with a Deno shim and a mock
   fetch that plays the part of PostgREST + the Anthropic API. Nothing is
   reimplemented: the code under test is index.ts exactly as it would deploy. */

const ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "test-key",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  EDGEDESK_AI_RESEARCH: "1",
  EDGEDESK_MLB_FALLBACK: "0",   // keep tests off the live MLB feed
  EDGEDESK_AI_NO_SERVE: "1",
};

(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] } };

/* ---------------------------------------------------------------- ET days */
export function etDayLocal(offset = 0): string {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
export const YEST = etDayLocal(-1), TODAY = etDayLocal(0), TOM = etDayLocal(1);

/* ------------------------------------------------------- the mock backend */
export interface Backend {
  /** table -> rows, or a function of the parsed query. Missing table => []. */
  tables: Record<string, any[] | ((qs: URLSearchParams, raw: string) => any[])>;
  /** tables that should answer with an HTTP error instead of rows. */
  errors?: Record<string, { status: number; body: string }>;
  /** Make the first model call return an empty completion, to exercise the retry. */
  anthropicEmptyFirst?: boolean;
}

export interface Capture {
  reads: { table: string; query: string }[];
  anthropicPrompt: string | null;
  anthropicSystem: string | null;
  anthropicMaxTokens: number | null;
  anthropicCalls: string[];
}

/** Apply the PostgREST filters the function actually uses: eq, in, gte, lte, not.is, is. */
function applyFilters(rows: any[], qs: URLSearchParams): any[] {
  let out = rows;
  for (const [key, val] of qs.entries()) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const m = String(val);
    if (m.startsWith("eq.")) {
      const want = m.slice(3);
      out = out.filter((r) => String(r[key]) === want);
    } else if (m.startsWith("in.(")) {
      const list = m.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
      out = out.filter((r) => list.includes(String(r[key])));
    } else if (m.startsWith("gte.")) {
      const want = m.slice(4);
      out = out.filter((r) => String(r[key]) >= want);
    } else if (m.startsWith("lte.")) {
      const want = m.slice(4);
      out = out.filter((r) => String(r[key]) <= want);
    } else if (m.startsWith("gt.")) {
      const want = Number(m.slice(3));
      out = out.filter((r) => Number(r[key]) > want);
    } else if (m === "not.is.null") {
      out = out.filter((r) => r[key] != null);
    } else if (m === "is.true") {
      out = out.filter((r) => r[key] === true);
    }
  }
  return out;
}

function applyOrderLimit(rows: any[], qs: URLSearchParams): any[] {
  const order = qs.get("order");
  let out = rows.slice();
  if (order) {
    const [col, ...rest] = order.split(".");
    const desc = rest.includes("desc");
    out.sort((a, b) => {
      const x = a[col], y = b[col];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number"
        ? x - y : String(x).localeCompare(String(y));
      return desc ? -c : c;
    });
  }
  const lim = Number(qs.get("limit") ?? "0");
  // PostgREST/Supabase hard cap. Reproduced deliberately — hard-won fact #3.
  const cap = 1000;
  const eff = lim > 0 ? Math.min(lim, cap) : cap;
  return out.slice(0, eff);
}

export function install(be: Backend): Capture {
  const cap: Capture = { reads: [], anthropicPrompt: null, anthropicSystem: null, anthropicMaxTokens: null, anthropicCalls: [] };

  (globalThis as any).fetch = async (url: any, init?: any): Promise<any> => {
    const u = String(url);

    if (u.includes("api.anthropic.com")) {
      const body = JSON.parse(init?.body ?? "{}");
      cap.anthropicSystem = body.system ?? null;
      cap.anthropicMaxTokens = body.max_tokens ?? null;
      cap.anthropicPrompt = body.messages?.[body.messages.length - 1]?.content ?? null;
      cap.anthropicCalls.push(String(body.messages?.[body.messages.length - 1]?.content ?? ""));
      const empty = be.anthropicEmptyFirst && cap.anthropicCalls.length === 1;
      return {
        ok: true, status: 200,
        json: async () => ({ model: body.model, stop_reason: empty ? "max_tokens" : "end_turn",
          content: empty ? [] : [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } }),
        text: async () => "",
        headers: { get: () => null },
      };
    }

    // statsapi / savant — off in these tests
    if (u.includes("statsapi.mlb.com") || u.includes("baseballsavant")) {
      return { ok: false, status: 503, json: async () => null, text: async () => "" };
    }

    const rest = u.split("/rest/v1/")[1] ?? "";
    const [table, qstr = ""] = rest.split("?");
    cap.reads.push({ table, query: qstr });

    const err = be.errors?.[table];
    if (err) {
      return { ok: false, status: err.status, text: async () => err.body, json: async () => null };
    }

    const src = be.tables[table];
    const qs = new URLSearchParams(qstr);
    let rows: any[] = typeof src === "function" ? src(qs, qstr) : (src ?? []);
    let matched = rows.length;
    if (typeof src !== "function") {
      rows = applyFilters(rows, qs);
      matched = rows.length;                 // the true population, before the page cap
      rows = applyOrderLimit(rows, qs);
    }

    // count=exact / HEAD — Content-Range is NOT subject to the row cap.
    if (String(init?.method ?? "GET").toUpperCase() === "HEAD") {
      return {
        ok: true, status: 206, text: async () => "", json: async () => null,
        headers: { get: (h: string) => h.toLowerCase() === "content-range" ? `0-0/${matched}` : null },
      };
    }

    return {
      ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows,
      headers: { get: () => null },
    };
  };

  return cap;
}

/* --------------------------------------------------------------- fixtures */

export const MLB_TEAM_POOL = [
  ["New York Yankees", 147], ["Boston Red Sox", 111], ["Los Angeles Dodgers", 119],
  ["San Diego Padres", 135], ["Chicago Cubs", 112], ["St. Louis Cardinals", 138],
  ["Houston Astros", 117], ["Seattle Mariners", 136], ["Atlanta Braves", 144],
  ["Philadelphia Phillies", 143], ["New York Mets", 121], ["Miami Marlins", 146],
  ["Milwaukee Brewers", 158], ["Cincinnati Reds", 113], ["Toronto Blue Jays", 141],
  ["Baltimore Orioles", 110], ["Detroit Tigers", 116], ["Minnesota Twins", 142],
  ["Texas Rangers", 140], ["Oakland Athletics", 133], ["Arizona Diamondbacks", 109],
  ["Colorado Rockies", 115], ["San Francisco Giants", 137], ["Washington Nationals", 120],
  ["Cleveland Guardians", 114], ["Kansas City Royals", 118], ["Tampa Bay Rays", 139],
  ["Pittsburgh Pirates", 134], ["Chicago White Sox", 145], ["Los Angeles Angels", 108],
] as [string, number][];

/** A day of MLB games. `n` pairs of clubs, offset into the pool so days differ. */
export function mlbCardDay(date: string, n: number, status: string, poolOffset = 0) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const [away, awayId] = MLB_TEAM_POOL[(poolOffset + i * 2) % 30];
    const [home, homeId] = MLB_TEAM_POOL[(poolOffset + i * 2 + 1) % 30];
    out.push({
      game_date: date,
      start_time: `${date}T${String(17 + (i % 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`,
      start_time_local: "7:05 PM", venue: `${home} Park`, status,
      doubleheader: "N", game_number: 1,
      away_team_id: awayId, away_team_name: away, away_record: "60-50", away_streak: "W2",
      away_pitcher_name: `${date}-AwayArm-${i}`, away_pitcher_throws: i % 2 ? "L" : "R",
      home_team_id: homeId, home_team_name: home, home_record: "58-52", home_streak: "L1",
      home_pitcher_name: `${date}-HomeArm-${i}`, home_pitcher_throws: i % 3 ? "R" : "L",
      park_factor: 100, hr_factor: 101, run_factor: 99,
      roof_type: "Open", is_dome: false,
      temp_f: 74, humidity: 50, precip_prob: 5, wind_mph: 8, wind_dir: "out", wind_rel: "out to CF",
    });
  }
  return out;
}

/** signals rows for a set of matchups. */
export function signalsFor(games: any[], sport = "baseball_mlb") {
  return games.map((g, i) => ({
    event_id: `evt-${g.game_date}-${i}`,
    sport_key: sport, sport_title: "MLB", market: "h2h",
    selection: g.home_team_name ?? g.home_team, point: null,
    best_dec: 1.9 + (i % 5) * 0.05, first_best_dec: 1.95, best_book: "draftkings",
    sharp_fair: 0.52, consensus_fair: 0.515, edge: 0.03 + (i % 4) * 0.005, first_edge: 0.04,
    n_books: 8, n_books_eff: 7, has_sharp: true, corrob_n: 5,
    pin_dec: 1.92, pin_opp_dec: 2.02,
    home_team: g.home_team_name ?? g.home_team, away_team: g.away_team_name ?? g.away_team,
    commence_time: new Date(Date.now() + 3600_000 * (2 + i)).toISOString(),
    first_seen_at: new Date(Date.now() - 3600_000).toISOString(),
    last_seen_at: new Date(Date.now() - 300_000).toISOString(),
    clv: null, beat_close: null, result: null, graded_at: null, closing_sharp_fair: null,
  }));
}

/* ------------------------------------------------------------------ asserts */
let PASS = 0, FAIL = 0;
const FAILURES: string[] = [];

export function check(name: string, cond: boolean, detail = "") {
  if (cond) { PASS++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { FAIL++; FAILURES.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? "\n       " + detail : ""}`); }
}
export function section(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
export function report(): number {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`${PASS} passed, ${FAIL} failed`);
  if (FAILURES.length) { console.log("\nFailures:"); FAILURES.forEach((f) => console.log("  - " + f)); }
  return FAIL === 0 ? 0 : 1;
}
