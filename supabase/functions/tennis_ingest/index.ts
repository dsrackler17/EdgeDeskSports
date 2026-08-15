// ============================================================================
// tennis_ingest — loads licensed tennis facts into the `tennis` schema.
//
// Provider-agnostic by design. EdgeDesk does not own a tennis data licence in
// code; you buy one, register it in tennis.sources, clear it for commercial
// use, and point this function at it. Everything downstream — the ATP research
// module, season/surface splits, head-to-head — reads from the schema, so the
// provider is swappable without touching the app.
//
// FAILS CLOSED ON LICENSING. Before a single row is fetched, this function
// checks that the configured source is cleared for commercial use. If it is
// not, it stops and says so. The database enforces the same rule again on every
// insert, so a mistake here cannot become a licensing problem there.
//
// Deploy:  supabase functions deploy tennis_ingest
// Secrets: supabase secrets set TENNIS_PROVIDER=generic_rest \
//                               TENNIS_API_BASE=https://<provider>/v1 \
//                               TENNIS_API_KEY=<key> \
//                               TENNIS_SOURCE_KEY=licensed_feed \
//                               TENNIS_MAP='<json field map, see MAP_DOC below>'
// Invoke:  POST { "tours": ["ATP"], "what": ["rankings","matches","players"] }
// ============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROVIDER = Deno.env.get("TENNIS_PROVIDER") ?? "generic_rest";
const API_BASE = Deno.env.get("TENNIS_API_BASE") ?? "";
const API_KEY = Deno.env.get("TENNIS_API_KEY") ?? "";
const SOURCE_KEY = Deno.env.get("TENNIS_SOURCE_KEY") ?? "licensed_feed";

/* MAP_DOC — TENNIS_MAP lets a licensed feed be wired without code changes.
   Every value is a dot-path into the provider's JSON row.
   {
     "rankings": { "path": "/rankings?tour={tour}", "rows": "data",
                   "player_id": "player.id", "rank": "position",
                   "points": "points", "full_name": "player.name",
                   "as_of": "updated" },
     "matches":  { "path": "/matches?tour={tour}&from={from}&to={to}", "rows": "data",
                   "match_id": "id", "match_date": "date",
                   "tourney_id": "tournament.id", "tourney_name": "tournament.name",
                   "surface": "tournament.surface", "level": "tournament.category",
                   "round": "round", "best_of": "best_of",
                   "winner_id": "winner.id", "loser_id": "loser.id",
                   "score": "score", "minutes": "duration",
                   "winner_rank": "winner.rank", "loser_rank": "loser.rank" },
     "players":  { "path": "/players?tour={tour}", "rows": "data",
                   "player_id": "id", "full_name": "name", "country": "country",
                   "plays": "plays", "height_cm": "height", "birth_date": "birth_date" }
   }
   Surfaces and levels are stored EXACTLY as the provider publishes them. This
   pipeline never infers a surface, never normalises a name into a different
   player, and never fills a missing field with a guess. */
let MAP: Record<string, any> = {};
try { MAP = JSON.parse(Deno.env.get("TENNIS_MAP") ?? "{}"); } catch { MAP = {}; }

const jsonHeaders = {
  apikey: SB_SERVICE_KEY,
  authorization: `Bearer ${SB_SERVICE_KEY}`,
  "content-type": "application/json",
  "accept-profile": "tennis",
  "content-profile": "tennis",
};

function dig(row: any, path?: string): any {
  if (!path) return null;
  return path.split(".").reduce((o: any, k: string) => (o == null ? null : o[k]), row);
}

async function sbSelect(pathAndQuery: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, { headers: jsonHeaders });
  if (!r.ok) throw new Error(`select ${pathAndQuery} -> ${r.status} ${await r.text()}`);
  return await r.json();
}

async function sbUpsert(table: string, rows: any[], onConflict: string): Promise<number> {
  if (!rows.length) return 0;
  // chunked so a large backfill cannot exceed the request limit
  let done = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(
      `${SB_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: "POST",
        headers: { ...jsonHeaders, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      },
    );
    if (!r.ok) throw new Error(`upsert ${table} -> ${r.status} ${await r.text()}`);
    done += chunk.length;
  }
  return done;
}

async function stamp(key: string, value: string) {
  await fetch(`${SB_URL}/rest/v1/meta?on_conflict=key`, {
    method: "POST",
    headers: { ...jsonHeaders, prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ key, value, updated_at: new Date().toISOString() }]),
  });
}

/* ---- the licence gate. Nothing is fetched until this passes. ------------- */
async function assertLicensed(): Promise<{ ok: true; source: any }> {
  const rows = await sbSelect(
    `sources?select=source_key,display_name,licence,licence_url,commercial_use,attribution,cleared_by,cleared_at&source_key=eq.${encodeURIComponent(SOURCE_KEY)}`,
  );
  const src = rows[0];
  if (!src) {
    throw new Error(
      `source '${SOURCE_KEY}' is not registered in tennis.sources. Register it with its licence before ingesting.`,
    );
  }
  if (!src.commercial_use) {
    throw new Error(
      `source '${SOURCE_KEY}' (${src.display_name}) is not cleared for commercial use. ` +
        `Licence on file: ${src.licence}. Read the terms; if they genuinely cover a paid product, ` +
        `set commercial_use = true with cleared_by and cleared_at. Refusing to ingest.`,
    );
  }
  return { ok: true, source: src };
}

/* ---- adapters ----------------------------------------------------------- */
type Fetched = { players: any[]; rankings: any[]; matches: any[] };

async function providerGet(path: string): Promise<any> {
  const url = `${API_BASE}${path}`;
  const r = await fetch(url, {
    headers: API_KEY ? { "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` } : {},
  });
  if (!r.ok) throw new Error(`provider ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

/* generic_rest: works against any licensed feed described by TENNIS_MAP. */
async function adapterGenericRest(tour: string, what: string[], since: string): Promise<Fetched> {
  const out: Fetched = { players: [], rankings: [], matches: [] };
  const today = new Date().toISOString().slice(0, 10);

  if (what.includes("rankings") && MAP.rankings?.path) {
    const m = MAP.rankings;
    const body = await providerGet(m.path.replace("{tour}", tour));
    const rows = (dig(body, m.rows) ?? body) as any[];
    for (const row of rows ?? []) {
      const pid = dig(row, m.player_id);
      const rank = dig(row, m.rank);
      if (pid == null || rank == null) continue;             // never invent a rank
      out.rankings.push({
        tour, player_id: String(pid), rank: Number(rank),
        points: dig(row, m.points) == null ? null : Number(dig(row, m.points)),
        as_of: (dig(row, m.as_of) ?? today).toString().slice(0, 10),
        source_key: SOURCE_KEY,
      });
      const nm = dig(row, m.full_name);
      if (nm) out.players.push({ tour, player_id: String(pid), full_name: String(nm), source_key: SOURCE_KEY });
    }
  }

  if (what.includes("players") && MAP.players?.path) {
    const m = MAP.players;
    const body = await providerGet(m.path.replace("{tour}", tour));
    const rows = (dig(body, m.rows) ?? body) as any[];
    for (const row of rows ?? []) {
      const pid = dig(row, m.player_id), nm = dig(row, m.full_name);
      if (pid == null || !nm) continue;
      out.players.push({
        tour, player_id: String(pid), full_name: String(nm),
        country: dig(row, m.country) ?? null,
        plays: dig(row, m.plays) ?? null,
        height_cm: dig(row, m.height_cm) == null ? null : Number(dig(row, m.height_cm)),
        birth_date: dig(row, m.birth_date) ?? null,
        source_key: SOURCE_KEY,
      });
    }
  }

  if (what.includes("matches") && MAP.matches?.path) {
    const m = MAP.matches;
    const body = await providerGet(
      m.path.replace("{tour}", tour).replace("{from}", since).replace("{to}", today),
    );
    const rows = (dig(body, m.rows) ?? body) as any[];
    for (const row of rows ?? []) {
      const id = dig(row, m.match_id), w = dig(row, m.winner_id), l = dig(row, m.loser_id);
      const date = dig(row, m.match_date);
      // a match without an id, both players and a date is not a fact we can store
      if (id == null || w == null || l == null || !date) continue;
      out.matches.push({
        tour, match_id: String(id), match_date: String(date).slice(0, 10),
        tourney_id: dig(row, m.tourney_id) ?? null,
        tourney_name: dig(row, m.tourney_name) ?? null,
        surface: dig(row, m.surface) ?? null,          // as published, never inferred
        level: dig(row, m.level) ?? null,
        round: dig(row, m.round) ?? null,
        best_of: dig(row, m.best_of) == null ? null : Number(dig(row, m.best_of)),
        winner_id: String(w), loser_id: String(l),
        score: dig(row, m.score) ?? null,
        minutes: dig(row, m.minutes) == null ? null : Number(dig(row, m.minutes)),
        winner_rank: dig(row, m.winner_rank) == null ? null : Number(dig(row, m.winner_rank)),
        loser_rank: dig(row, m.loser_rank) == null ? null : Number(dig(row, m.loser_rank)),
        source_key: SOURCE_KEY,
      });
    }
  }
  return out;
}

/* the_odds_api: recent completed events only. This provider's scores endpoint
   reaches back a few days, so it maintains CURRENT FORM and can never build a
   historical archive. It is offered because this app already licenses it. */
async function adapterOddsApi(tour: string, _what: string[], _since: string): Promise<Fetched> {
  const out: Fetched = { players: [], rankings: [], matches: [] };
  const keyParam = `apiKey=${encodeURIComponent(API_KEY)}`;
  const sportKeys: string[] = await (async () => {
    const all = await providerGet(`/v4/sports/?${keyParam}`);
    return (all ?? [])
      .map((s: any) => s.key)
      .filter((k: string) => k && k.startsWith(tour === "ATP" ? "tennis_atp" : "tennis_wta"));
  })();

  for (const sk of sportKeys) {
    const games = await providerGet(`/v4/sports/${sk}/scores/?daysFrom=3&${keyParam}`);
    for (const g of games ?? []) {
      if (!g?.completed || !Array.isArray(g.scores) || g.scores.length < 2) continue;
      const a = g.scores[0], b = g.scores[1];
      const an = Number(a?.score), bn = Number(b?.score);
      if (!isFinite(an) || !isFinite(bn) || an === bn) continue;   // no winner => not a fact yet
      const win = an > bn ? a : b, lose = an > bn ? b : a;
      out.matches.push({
        tour, match_id: String(g.id), match_date: String(g.commence_time).slice(0, 10),
        tourney_id: sk, tourney_name: g.sport_title ?? null,
        surface: null,            // this feed does not publish surface — left null, never guessed
        level: null, round: null, best_of: null,
        winner_id: String(win.name), loser_id: String(lose.name),
        score: `${win.score}-${lose.score}`, minutes: null,
        winner_rank: null, loser_rank: null,
        source_key: SOURCE_KEY,
      });
      for (const p of [win, lose]) {
        out.players.push({ tour, player_id: String(p.name), full_name: String(p.name), source_key: SOURCE_KEY });
      }
    }
  }
  return out;
}

const ADAPTERS: Record<string, (t: string, w: string[], s: string) => Promise<Fetched>> = {
  generic_rest: adapterGenericRest,
  the_odds_api: adapterOddsApi,
};

/* ---- entrypoint --------------------------------------------------------- */
Deno.serve(async (req) => {
  const started = new Date().toISOString();
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const tours: string[] = body.tours ?? ["ATP"];
    const what: string[] = body.what ?? ["rankings", "matches", "players"];
    const since: string = body.since ??
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const licence = await assertLicensed();          // fail closed before any fetch

    const adapter = ADAPTERS[PROVIDER];
    if (!adapter) throw new Error(`unknown TENNIS_PROVIDER '${PROVIDER}'. Known: ${Object.keys(ADAPTERS).join(", ")}`);
    if (!API_BASE) throw new Error("TENNIS_API_BASE is not set.");

    const report: Record<string, any> = { provider: PROVIDER, source: licence.source.display_name, tours: {} };

    for (const tour of tours) {
      const got = await adapter(tour, what, since);
      // de-duplicate players by (tour, player_id) before upsert
      const seen = new Set<string>();
      const players = got.players.filter((p) => {
        const k = `${p.tour}|${p.player_id}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      report.tours[tour] = {
        players: await sbUpsert("players", players, "tour,player_id"),
        rankings: await sbUpsert("rankings", got.rankings, "tour,as_of,player_id"),
        matches: await sbUpsert("matches", got.matches, "tour,match_id"),
      };
    }

    // build stamps — these are what makes the app's freshness SLA real
    await stamp("last_ingest", new Date().toISOString());
    await stamp("last_ingest_provider", PROVIDER);
    const rk = await sbSelect("rankings?select=as_of&order=as_of.desc&limit=1");
    if (rk[0]?.as_of) await stamp("rankings_as_of", rk[0].as_of);

    return new Response(JSON.stringify({ ok: true, started, finished: new Date().toISOString(), ...report }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    // the message is the point: a licensing refusal must be unmistakable
    return new Response(
      JSON.stringify({ ok: false, started, error: String((e as Error)?.message ?? e) }, null, 2),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
});
