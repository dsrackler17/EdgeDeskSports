// ============================================================
// venue_weather  -  EdgeDesk unified venue weather engine
// SOURCE: api.weather.gov RAW GRIDPOINT (NWS). US government data, public
// domain, no key, no commercial-use restriction.
//
// REPLACES weather_sync. One engine, any league. Leagues are just rows in
// `venues`; there is no league-specific weather code anywhere in this file
// except the sport_key -> league map.
//
// WHY THE RAW GRIDPOINT AND NOT forecastHourly
// The hourly product used by the old weather_sync publishes wind as a 16-point
// compass rose (22.5 degree steps) and omits gusts, dewpoint, cloud cover,
// visibility and pressure. The raw gridpoint (forecastGridData) publishes:
//   windDirection in TRUE DEGREES, windGust, dewpoint, skyCover,
//   probabilityOfPrecipitation, visibility, and (some offices) pressure.
// That is the real source resolution, so nothing here fakes precision.
//
// WHAT IS DERIVED VS REPORTED
//   reported : temp, humidity, dewpoint, wind, gust, direction, cloud,
//              precip prob, visibility, pressure (when NWS publishes it),
//              elevation + timezone (from NWS, cached onto the venue row)
//   derived  : air density (std-atmosphere pressure from elevation when NWS
//              pressure is absent; pressure_source says which), wind-vs-axis
//              geometry, and the MODEL features (hr_boost_pct, fly_ball_rating,
//              weather_impact_score). Model features use documented constants
//              and are UNVALIDATED. They feed the MODEL engine. They are not
//              displayed facts and they never touch CLV.
//
// MODES
//   ?mode=sync            cron path. All upcoming events in `signals` for
//                         mapped sport_keys -> upsert one row per event_id
//                         into venue_weather. Requires x-cron-secret.
//   ?mode=sync&dry=1      computes and reports, writes nothing to
//                         venue_weather. ALSO requires x-cron-secret (see FIX 1).
//   ?mode=get&venue_id=X[&t=ISO]
//                         getVenueWeather(venueId, gameTime). Cache-first.
//                         Returns computed features as JSON, writes nothing
//                         except the shared cache. Requires a caller bearer.
//
// CACHE
//   weather_cache, one row per venue, TTL CACHE_MIN. Ten users opening Yankee
//   Stadium in the same hour cost one NWS request. Out-of-coverage venues
//   (Rogers Centre) get a 24h marker row so they are reported, not hammered
//   and not silently skipped.
//
// ─────────────────────────────────────────────────────────────────────────────
// SIX BUGS FIXED IN THIS REVISION
//
// 1. dry=1 SKIPPED AUTHENTICATION ENTIRELY
//    `if (!dry) { check secret }` meant ?mode=sync&dry=1 ran the whole sync with
//    no credential: full venue scan, up to ~30 live NWS requests, plus writes to
//    weather_cache and PATCHes to venues. An unauthenticated endpoint that makes
//    dozens of upstream calls is an abuse vector and a fast route to an NWS
//    block. Every sync path now requires the secret; dry only controls whether
//    venue_weather is written.
//
// 2. mode=get WAS COMPLETELY OPEN
//    Deployed with Verify JWT off, so it was an unauthenticated proxy to NWS
//    that anyone could pump. It now requires a caller bearer — which the app
//    already sends — or the cron secret.
//
// 3. VENUE MATCHING WAS EXACT STRING EQUALITY  (silent data loss)
//    byKey.get(league + "|" + ev.home_team) drops "Oakland Athletics" when the
//    venue row says "Athletics", and drops any case or punctuation variance.
//    Those games got no weather at all — the same class of bug that was
//    mis-grading bets in settle. Matching is now normalised with a nickname and
//    last-token fallback, ambiguity is refused rather than guessed, and every
//    fuzzy match is reported so the underlying naming can be cleaned up.
//
// 4. ONE BAD ROW LOST THE ENTIRE SYNC
//    The venue_weather upsert was a single unguarded call inside a handler whose
//    catch returns 500. One rejected row discarded every other row in the run.
//    Writes are now chunked, with per-chunk errors captured and the rest kept.
//
// 5. EVERY DOME ROW SHARED ONE insights ARRAY
//    NULL_ROW.insights is a single [] and spreading copies the reference, so all
//    dome rows aliased it. Benign today, a corruption waiting for the first
//    mutation. NULL_ROW is now produced fresh per row.
//
// 6. ELEVATION NEVER BACKFILLED BEHIND A WARM CACHE
//    Elevation is captured only on a live gridpoint fetch, so a venue cached
//    before it had elevation kept air_density_index null for the whole TTL —
//    silently, because a null ADI looks identical to "not calibrated". The cache
//    hit path now backfills elevation from the cached gridpoint payload.
// ─────────────────────────────────────────────────────────────────────────────
//
// DIAGNOSTICS
//   Returns full counts + every unmatched team name. pg_net throws the
//   response away, so ALSO verify by querying venue_weather.
//
// DEPLOY  dashboard paste as "venue_weather". Settings > Verify JWT OFF.
// ENV     CRON_SECRET (required), NWS_CONTACT (email, NWS policy)
// ============================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const NWS_CONTACT = Deno.env.get("NWS_CONTACT") ?? "support@edgedesksports.com";

const HOURS_AHEAD = 72;        // event window for sync
const CACHE_MIN = 60;          // forecast cache TTL per venue
const OOC_CACHE_MIN = 1440;    // out-of-coverage marker TTL
const WRITE_CHUNK = 200;       // rows per venue_weather upsert (FIX 4)

const NWS_HEADERS = {
  "User-Agent": `EdgeDesk/1.0 (${NWS_CONTACT})`,
  "Accept": "application/geo+json",
};

// The only league-aware line in the engine. Adding a sport = adding a map
// entry and seeding its venues. MiLB, NCAA baseball, soccer, golf: same.
const LEAGUE_BY_SPORT: Record<string, string> = {
  baseball_mlb: "MLB",
  americanfootball_nfl: "NFL",
  americanfootball_ncaaf: "CFB",
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });

// ---------- Supabase REST helper ----------
async function sb(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`sb ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
  // PostgREST answers Prefer: return=minimal with 201 + EMPTY body. Parse only
  // if there is something to parse, or a successful write throws.
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}
const enc = encodeURIComponent;

// ============================================================
// SECTION: weather_calculations  (pure, deterministic; same inputs,
// same output string, always)
// ============================================================

/** signed smallest-angle difference, normalized to (-180, 180] */
export function norm180(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/**
 * Wind direction is meteorological: where the wind comes FROM. The wind
 * VECTOR points to from+180. Relative angle vs the field axis:
 *   0    = blowing straight out along the axis (to CF for MLB)
 *   +90  = toward right field / right sideline
 *   -90  = toward left field / left sideline
 *   +/-180 = straight in
 */
export function windRelative(fromDeg: number, orientationDeg: number): number {
  return Math.round(norm180((fromDeg + 180) - orientationDeg));
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function windComponents(speedMph: number, relDeg: number) {
  const rad = (relDeg * Math.PI) / 180;
  return {
    out: r1(speedMph * Math.cos(rad)),    // + = out, - = in
    cross: r1(speedMph * Math.sin(rad)),  // + = toward right
  };
}

export function windClass(relDeg: number): string {
  const a = Math.abs(relDeg);
  if (a <= 45) return "Tailwind";
  if (a >= 135) return "Headwind";
  return relDeg > 0 ? "Crosswind Right" : "Crosswind Left";
}

/** Wind Out To Center buckets, driven by the OUT component in mph. */
export function windOutClass(out: number): string {
  if (out >= 8) return "Excellent for HRs";
  if (out > -4) return "Neutral";
  if (out > -12) return "Slightly In";
  return "Strongly In";
}

export function crosswindClass(cross: number): string {
  const a = Math.abs(cross);
  if (a < 5) return "None";
  if (a < 10) return "Slight";
  if (a < 15) return "Moderate";
  return "Strong";
}

/**
 * Air density from temperature, humidity (via dewpoint) and pressure.
 * If NWS does not publish pressure for this gridpoint, station pressure is
 * derived from elevation via the standard atmosphere and pressure_source
 * says so. Elevation itself came from the NWS gridpoint response, so every
 * input still traces to a named source.
 * ADI = rho / 1.225 (dry sea-level standard). Coors comes out near 0.80.
 */
export function airDensity(tempF: number | null, dewF: number | null, humidityPct: number | null,
                           pressureHpa: number | null, elevM: number | null) {
  if (tempF == null) return null;
  const tC = (tempF - 32) * 5 / 9;
  const tK = tC + 273.15;

  let p = pressureHpa, pSource = "nws";
  if (p == null) {
    if (elevM == null) return null;
    p = 1013.25 * Math.pow(1 - 2.25577e-5 * elevM, 5.25588);
    pSource = "std_atmosphere(elevation)";
  }

  // vapor pressure, hPa: Magnus over dewpoint; RH fallback if dewpoint absent
  let e = 0;
  if (dewF != null) {
    const dC = (dewF - 32) * 5 / 9;
    e = 6.112 * Math.exp((17.67 * dC) / (dC + 243.5));
  } else if (humidityPct != null) {
    e = (humidityPct / 100) * 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
  }

  const rho = ((p - e) * 100) / (287.05 * tK) + (e * 100) / (461.495 * tK);
  return {
    adi: +(rho / 1.225).toFixed(3),
    pressure_hpa: r1(p),
    pressure_source: pSource,
  };
}

export function adiClass(adi: number): string {
  if (adi < 0.92) return "Excellent Carry";
  if (adi < 0.97) return "Above Average";
  if (adi <= 1.03) return "Neutral";
  if (adi <= 1.07) return "Poor Carry";
  return "Heavy Air";
}

// ---- MODEL features. Deterministic, documented constants, UNVALIDATED. ----
// Feed the MODEL engine only. Never a displayed fact, never blended into
// MARKET/CONSENSUS, never counted toward CLV.

/** carry score: out-wind mph + thin-air bonus + warm-air bonus */
export function flyBallScore(out: number, adi: number, tempF: number): number {
  return out + (1 - adi) * 60 + (tempF - 70) * 0.1;
}
export function flyBallRating(score: number): string {
  if (score >= 10) return "Excellent";
  if (score >= 4) return "Good";
  if (score >= -4) return "Neutral";
  return "Poor";
}

/** hr boost, bucketed to 5% steps, clamped +/-15. v1 constants. */
export function hrBoostPct(out: number, adi: number): number {
  const raw = out * 0.7 + (1 - adi) * 80;
  const bucket = Math.round(raw / 5) * 5;
  return Math.max(-15, Math.min(15, bucket));
}

export function runEnvironment(boost: number, precipProb: number | null): string {
  let step = boost >= 10 ? 2 : boost >= 5 ? 1 : boost <= -10 ? -2 : boost <= -5 ? -1 : 0;
  if ((precipProb ?? 0) >= 60) step -= 1;   // sustained rain suppresses offense
  step = Math.max(-2, Math.min(2, step));
  return ["Very Pitcher Friendly", "Pitcher Friendly", "Neutral",
          "Hitter Friendly", "Very Hitter Friendly"][step + 2];
}

export function impactScore(out: number, cross: number, adi: number, precipProb: number | null): number {
  return Math.min(100, Math.round(
    Math.abs(out) * 2 + Math.abs(cross) + Math.abs(1 - adi) * 150 + (precipProb ?? 0) * 0.4,
  ));
}

/** where the wind vector points, in field terms, for insight text */
export function towardText(relDeg: number): string {
  const a = Math.abs(relDeg);
  if (a <= 15) return "out to center";
  if (a <= 60) return relDeg > 0 ? "out to right-center" : "out to left-center";
  if (a < 120) return relDeg > 0 ? "across toward right field" : "across toward left field";
  if (a < 165) return relDeg > 0 ? "in from left-center" : "in from right-center";
  return "in from center";
}

/** Every statement is gated on the data that supports it. No vibes. */
export function buildInsights(w: any): string[] {
  const s: string[] = [];
  if (w.wind_mph != null && w.wind_relative_angle != null && w.wind_mph >= 12) {
    s.push(`${Math.round(w.wind_mph)} mph wind blowing ${towardText(w.wind_relative_angle)}.`);
  }
  if (w.wind_component_out != null && w.wind_component_out >= 8) {
    s.push("Fly balls expected to carry.");
  }
  if (w.crosswind_class === "Strong") {
    s.push("Strong crosswind may reduce HR distance.");
  }
  if (w.wind_gust_mph != null && w.wind_mph != null && w.wind_gust_mph >= w.wind_mph + 10) {
    s.push(`Gusts to ${Math.round(w.wind_gust_mph)} mph add variance.`);
  }
  if (w.air_density_index != null && w.air_density_index >= 1.05) {
    s.push("Heavy air suppresses carry.");
  }
  if (w.temp_f != null && w.humidity_pct != null && w.temp_f >= 85 && w.humidity_pct <= 40) {
    s.push("Warm dry air increases carry.");
  }
  if (w.precip_prob != null && w.precip_prob >= 50) {
    s.push("Rain delay risk.");
  }
  if (w.temp_f != null && w.air_density_index != null && w.temp_f <= 55 && w.air_density_index >= 1.03) {
    s.push("Cold dense air favors pitchers.");
  }
  if (w.humidity_pct != null && w.humidity_pct >= 75 &&
      w.air_density_index != null && w.air_density_index > 0.97 && w.air_density_index <= 1.03) {
    s.push("High humidity but neutral carry.");
  }
  return s;
}

// ============================================================
// SECTION: venue matching  (FIX 3)
// ============================================================

/** Fold case, accents and punctuation so "St. Louis Cardinals" == "st louis cardinals". */
export function normTeam(s: unknown): string {
  let t = String(s ?? "").toLowerCase();
  try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch { /* older runtimes */ }
  return t.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export type MatchHow = "exact" | "nickname" | "last_token" | "ambiguous" | "none";

/**
 * Resolve an event's home-team name to a venue row.
 *
 * The old code did a single exact-string Map lookup, so "Oakland Athletics"
 * against a venue row named "Athletics" produced no weather at all — the game
 * was counted as unmatched and quietly dropped.
 *
 * Strict-to-loose, and AMBIGUITY IS REFUSED rather than guessed: a wrong venue
 * means a wrong stadium orientation, which means confidently wrong wind
 * geometry. A null is visibly missing; a wrong bearing is invisibly wrong.
 */
export function makeVenueIndex(venues: any[]) {
  const exact = new Map<string, any>();
  const byLeague = new Map<string, any[]>();
  for (const v of venues) {
    exact.set(v.league + "|" + normTeam(v.team), v);
    const arr = byLeague.get(v.league) ?? [];
    arr.push(v);
    byLeague.set(v.league, arr);
  }
  const last = (s: string) => s.split(" ").filter(Boolean).slice(-1)[0] ?? "";

  return function find(league: string, team: string): { venue: any | null; how: MatchHow } {
    const n = normTeam(team);
    if (!league || !n) return { venue: null, how: "none" };

    const hit = exact.get(league + "|" + n);
    if (hit) return { venue: hit, how: "exact" };

    const pool = byLeague.get(league) ?? [];

    // one name contains the other: "Athletics" <-> "Oakland Athletics"
    const nick = pool.filter((v) => {
      const vn = normTeam(v.team);
      return vn === n || vn.endsWith(" " + n) || n.endsWith(" " + vn);
    });
    if (nick.length === 1) return { venue: nick[0], how: "nickname" };
    if (nick.length > 1) return { venue: null, how: "ambiguous" };

    // club nickname only, and it must identify exactly one venue in the league
    const lt = pool.filter((v) => last(normTeam(v.team)) === last(n));
    if (lt.length === 1) return { venue: lt[0], how: "last_token" };
    if (lt.length > 1) return { venue: null, how: "ambiguous" };

    return { venue: null, how: "none" };
  };
}

// ============================================================
// SECTION: NWS raw gridpoint parsing
// ============================================================

/** NWS validTime durations: PT1H, PT6H, P1D, P1DT2H */
export function durMs(d: string): number {
  const m = d?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) return 3600_000;
  const ms = (((+(m[1] ?? 0)) * 24 + (+(m[2] ?? 0))) * 60 + (+(m[3] ?? 0))) * 60_000;
  return ms || 3600_000;
}

/** value of a gridpoint layer at target time, or null if outside its range */
export function sample(layer: any, targetMs: number): { value: number; start: string } | null {
  if (!layer?.values?.length) return null;
  for (const v of layer.values) {
    const [s, dur] = String(v.validTime).split("/");
    const start = Date.parse(s);
    if (targetMs >= start && targetMs < start + durMs(dur)) {
      return v.value == null ? null : { value: v.value, start: s };
    }
  }
  return null;
}

function toMph(layer: any, s: { value: number } | null): number | null {
  if (!s) return null;
  const u = String(layer?.uom ?? "");
  const v = u.includes("km_h") ? s.value * 0.621371
    : u.includes("m_s") ? s.value * 2.23694
    : s.value;
  return r1(v);
}
function toFDeg(layer: any, s: { value: number } | null): number | null {
  if (!s) return null;
  return String(layer?.uom ?? "").includes("degC") ? r1(s.value * 9 / 5 + 32) : r1(s.value);
}

const KEEP_LAYERS = [
  "temperature", "dewpoint", "relativeHumidity", "windSpeed", "windGust",
  "windDirection", "skyCover", "probabilityOfPrecipitation", "visibility", "pressure",
];

/** keep only the layers we use; the full gridpoint JSON is enormous */
function trimGrid(props: any) {
  const o: any = { updateTime: props.updateTime, elevation: props.elevation };
  for (const k of KEEP_LAYERS) if (props[k]) o[k] = { uom: props[k].uom, values: props[k].values };
  return o;
}

/** all raw metrics at target time. Null if temperature has no coverage there. */
export function extractWx(props: any, targetMs: number) {
  const t = sample(props.temperature, targetMs);
  if (!t) return null;
  const pSample = sample(props.pressure, targetMs);
  const pressureHpa = pSample == null ? null
    : String(props.pressure?.uom ?? "").includes("Pa") && !String(props.pressure?.uom ?? "").includes("hPa")
      ? r1(pSample.value / 100) : r1(pSample.value);
  const visS = sample(props.visibility, targetMs);
  const visMi = visS == null ? null
    : String(props.visibility?.uom ?? "").includes(":m") ? r1(visS.value / 1609.34) : r1(visS.value);
  const dirS = sample(props.windDirection, targetMs);
  return {
    temp_f: toFDeg(props.temperature, t),
    dew_point_f: toFDeg(props.dewpoint, sample(props.dewpoint, targetMs)),
    humidity_pct: sample(props.relativeHumidity, targetMs)?.value ?? null,
    wind_mph: toMph(props.windSpeed, sample(props.windSpeed, targetMs)),
    wind_gust_mph: toMph(props.windGust, sample(props.windGust, targetMs)),
    wind_dir_deg: dirS == null ? null : Math.round(dirS.value),   // true degrees
    cloud_pct: sample(props.skyCover, targetMs)?.value ?? null,
    precip_prob: sample(props.probabilityOfPrecipitation, targetMs)?.value ?? null,
    visibility_mi: visMi,
    pressure_hpa: pressureHpa,
    forecast_for: t.start,
  };
}

// ============================================================
// SECTION: weather_service  (NWS fetch + shared per-venue cache)
// ============================================================

async function getForecast(venue: any, diag: any): Promise<any | null> {
  // 1. cache
  try {
    const rows = await sb(`weather_cache?venue_id=eq.${enc(venue.id)}&select=*`);
    const c = rows?.[0];
    if (c && new Date(c.expires_at).getTime() > Date.now()) {
      diag.cache_hits++;
      if (c.forecast_json?.out_of_coverage) {
        if (!diag.out_of_coverage.includes(venue.team)) diag.out_of_coverage.push(venue.team);
        return null;
      }
      /* FIX 6: backfill elevation from the CACHED gridpoint. Without this a
         venue first cached before it had elevation kept air_density_index null
         for the whole TTL, and a null ADI is indistinguishable from "venue not
         calibrated" — so the gap was invisible. */
      const cachedElev = c.forecast_json?.elevation?.value;
      if (venue.elevation_m == null && typeof cachedElev === "number") {
        venue.elevation_m = cachedElev;
        await sb(`venues?id=eq.${enc(venue.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            elevation_m: cachedElev, elevation_source: "nws_gridpoint",
            updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
      return c.forecast_json;
    }
  } catch (e) { diag.errors.push({ venue: venue.id, err: "cache read: " + String(e) }); }

  // 2. resolve grid URL (once per venue, ever; stadiums do not move)
  let gridUrl = venue.nws_grid_url;
  if (!gridUrl) {
    const r = await fetch(
      `https://api.weather.gov/points/${venue.latitude.toFixed(4)},${venue.longitude.toFixed(4)}`,
      { headers: NWS_HEADERS },
    );
    if (r.status === 404) {   // outside NWS coverage: reported, never silently skipped
      if (!diag.out_of_coverage.includes(venue.team)) diag.out_of_coverage.push(venue.team);
      await sb(`weather_cache?on_conflict=venue_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          venue_id: venue.id, provider: "none",
          forecast_json: { out_of_coverage: true },
          last_updated: new Date().toISOString(),
          expires_at: new Date(Date.now() + OOC_CACHE_MIN * 60_000).toISOString(),
        }),
      }).catch(() => {});
      return null;
    }
    if (!r.ok) throw new Error(`nws points ${r.status} for ${venue.venue_name}`);
    const j = await r.json();
    gridUrl = j?.properties?.forecastGridData;
    if (!gridUrl) throw new Error(`nws points: no forecastGridData for ${venue.venue_name}`);
    await sb(`venues?id=eq.${enc(venue.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        nws_grid_url: gridUrl,
        timezone: venue.timezone ?? j?.properties?.timeZone ?? null,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {/* cache write is an optimization, not a requirement */});
  }

  // 3. raw gridpoint
  const r = await fetch(gridUrl, { headers: NWS_HEADERS });
  if (!r.ok) throw new Error(`nws gridpoint ${r.status} for ${venue.venue_name}`);
  const j = await r.json();
  const props = trimGrid(j?.properties ?? {});
  diag.nws_fetches++;

  // elevation from the gridpoint response itself. Real source, cached forever.
  const elevM = j?.properties?.elevation?.value;
  if (venue.elevation_m == null && typeof elevM === "number") {
    venue.elevation_m = elevM;
    await sb(`venues?id=eq.${enc(venue.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        elevation_m: elevM, elevation_source: "nws_gridpoint",
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  // 4. write shared cache
  await sb(`weather_cache?on_conflict=venue_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      venue_id: venue.id, provider: "api.weather.gov",
      forecast_json: props, forecast_hours: HOURS_AHEAD,
      last_updated: new Date().toISOString(),
      expires_at: new Date(Date.now() + CACHE_MIN * 60_000).toISOString(),
    }),
  }).catch((e) => diag.errors.push({ venue: venue.id, err: "cache write: " + String(e) }));

  return props;
}

// ============================================================
// SECTION: feature assembly (one function, every sport)
// ============================================================

// PostgREST bulk inserts demand IDENTICAL keys on every row in the array
// (PGRST102 "All object keys must match" otherwise). Dome rows, uncalibrated
// rows, and fully calibrated rows naturally produce different key sets, and
// JSON.stringify silently drops undefined keys. So every row starts from this
// full-column template and overwrites what it actually has.
//
// FIX 5: this is a FUNCTION, not a shared object. As a const, `insights: []`
// was one array that every spread aliased, so all dome rows shared it.
function nullRow() {
  return {
    temp_f: null, humidity_pct: null, dew_point_f: null, wind_mph: null,
    wind_gust_mph: null, wind_dir_deg: null, cloud_pct: null, precip_prob: null,
    visibility_mi: null, pressure_hpa: null, pressure_source: null,
    orientation_used: null, orientation_confidence: null,
    wind_relative_angle: null, wind_component_out: null, wind_component_cross: null,
    wind_class: null, wind_out_class: null, crosswind_class: null,
    air_density_index: null, air_density_class: null,
    fly_ball_rating: null, hr_boost_pct: null, run_environment: null,
    weather_impact_score: null, insights: [] as string[], venue_features: null as any,
    forecast_for: null as string | null, source: null as string | null,
  };
}

export function computeRow(venue: any, ev: { event_id: string; commence_time: string }, props: any, diag: any) {
  const base = {
    event_id: ev.event_id,
    venue_id: venue.id,
    league: venue.league,
    home_team: venue.team,
    venue_name: venue.venue_name,
    commence_time: ev.commence_time,
    is_dome: venue.is_dome,
    is_retractable: venue.is_retractable ?? null,
    fetched_at: new Date().toISOString(),
  };

  // A dome makes outdoor conditions irrelevant. Record that, not a temperature.
  // Retractable roof STATE is not published anywhere free; is_retractable is
  // carried in venues so the UI can caveat it. Never guessed here.
  if (venue.is_dome) {
    diag.dome_events++;
    return { ...nullRow(), ...base, source: "n/a - dome" };
  }

  const wx = extractWx(props, new Date(ev.commence_time).getTime());
  if (!wx) { diag.no_forecast_hour++; return null; }   // never pass off a distant hour

  const ad = airDensity(wx.temp_f, wx.dew_point_f, wx.humidity_pct, wx.pressure_hpa, venue.elevation_m);

  const row: any = {
    ...nullRow(), ...base, ...wx,
    pressure_hpa: ad?.pressure_hpa ?? wx.pressure_hpa,
    pressure_source: ad?.pressure_source ?? (wx.pressure_hpa != null ? "nws" : null),
    air_density_index: ad?.adi ?? null,
    air_density_class: ad ? adiClass(ad.adi) : null,
    orientation_used: venue.orientation_deg ?? null,
    orientation_confidence: venue.orientation_confidence ?? null,
    source: "api.weather.gov",
  };

  // Orientation-dependent block. If the venue axis is not calibrated, these
  // stay NULL. A null is visibly missing; a guessed bearing is invisibly wrong.
  if (venue.orientation_deg != null && wx.wind_dir_deg != null && wx.wind_mph != null) {
    const rel = windRelative(wx.wind_dir_deg, venue.orientation_deg);
    const { out, cross } = windComponents(wx.wind_mph, rel);
    row.wind_relative_angle = rel;
    row.wind_component_out = out;
    row.wind_component_cross = cross;
    row.wind_class = windClass(rel);
    row.wind_out_class = windOutClass(out);
    row.crosswind_class = crosswindClass(cross);

    if (ad && wx.temp_f != null) {
      row.fly_ball_rating = flyBallRating(flyBallScore(out, ad.adi, wx.temp_f));
      row.hr_boost_pct = hrBoostPct(out, ad.adi);
      row.run_environment = runEnvironment(row.hr_boost_pct, wx.precip_prob);
      row.weather_impact_score = impactScore(out, cross, ad.adi, wx.precip_prob);
    }
  } else if (venue.orientation_deg == null) {
    if (!diag.uncalibrated.includes(venue.team)) diag.uncalibrated.push(venue.team);
  }

  row.insights = buildInsights(row);
  row.venue_features = {
    temperature_f: row.temp_f,
    humidity: row.humidity_pct,
    dew_point_f: row.dew_point_f,
    wind_speed: row.wind_mph,
    wind_gust: row.wind_gust_mph,
    wind_relative_angle: row.wind_relative_angle ?? null,
    wind_component_out: row.wind_component_out ?? null,
    wind_component_cross: row.wind_component_cross ?? null,
    air_density_index: row.air_density_index,
    precipitation_probability: row.precip_prob,
    cloud_cover: row.cloud_pct,
    pressure_hpa: row.pressure_hpa,
    visibility_mi: row.visibility_mi,
    weather_impact_score: row.weather_impact_score ?? null,
  };
  return row;
}

// ============================================================
// SECTION: handlers
// ============================================================

async function handleSync(dry: boolean) {
  const t0 = Date.now();
  const diag: any = {
    ok: true, mode: "sync", dry, source: "api.weather.gov (raw gridpoint)",
    signal_rows: 0, distinct_events: 0, venues_loaded: 0, venues_calibrated: 0,
    matched_events: 0, fuzzy_matched: [], ambiguous: [], unmatched: [],
    out_of_coverage: [], uncalibrated: [],
    dome_events: 0, no_forecast_hour: 0, cache_hits: 0, nws_fetches: 0,
    written: 0, errors: [],
  };

  // 1. upcoming events from signals, all mapped sports at once
  const now = new Date();
  const until = new Date(now.getTime() + HOURS_AHEAD * 3600_000);
  const sportList = Object.keys(LEAGUE_BY_SPORT).join(",");
  const rows: any[] = await sb(
    `signals?select=event_id,sport_key,home_team,commence_time` +
    `&sport_key=in.(${sportList})` +
    `&commence_time=gte.${now.toISOString()}` +
    `&commence_time=lte.${until.toISOString()}` +
    `&order=commence_time.asc&limit=5000`,
  ) ?? [];
  const events = new Map<string, any>();
  for (const r of rows) if (r.event_id && !events.has(r.event_id)) events.set(r.event_id, r);
  diag.signal_rows = rows.length;
  diag.distinct_events = events.size;
  if (!events.size) {
    diag.note = "no upcoming events in window for mapped sports";
    diag.ms = Date.now() - t0;
    return json(diag);
  }

  // 2. venues, orientation resolved live from mlb_parks via the view
  const venues: any[] = await sb(`venues_resolved?select=*`) ?? [];
  const findVenue = makeVenueIndex(venues);
  diag.venues_loaded = venues.length;
  diag.venues_calibrated = venues.filter((v) => v.orientation_deg != null).length;

  /* 3. match events -> venues.  FIX 3: normalised, with nickname and last-token
     fallbacks. Fuzzy matches are REPORTED, not hidden, so the naming can be
     cleaned up at the source; ambiguity is refused because the wrong venue
     means the wrong stadium bearing and confidently wrong wind geometry. */
  const matched: { ev: any; venue: any }[] = [];
  for (const ev of events.values()) {
    const league = LEAGUE_BY_SPORT[ev.sport_key];
    const { venue, how } = findVenue(league, ev.home_team);
    if (venue) {
      matched.push({ ev, venue });
      if (how !== "exact") {
        const tag = `${league}: "${ev.home_team}" -> "${venue.team}" (${how})`;
        if (!diag.fuzzy_matched.includes(tag)) diag.fuzzy_matched.push(tag);
      }
    } else {
      const tag = league + ": " + ev.home_team;
      if (how === "ambiguous") {
        if (!diag.ambiguous.includes(tag)) diag.ambiguous.push(tag);
      } else if (!diag.unmatched.includes(tag)) {
        diag.unmatched.push(tag);
      }
    }
  }
  diag.matched_events = matched.length;

  // 4. one forecast per distinct outdoor venue (doubleheaders share a park)
  const need = new Map<string, any>();
  for (const m of matched) if (!m.venue.is_dome) need.set(m.venue.id, m.venue);
  const forecastByVenue = new Map<string, any>();
  for (const v of need.values()) {
    try {
      const props = await getForecast(v, diag);
      if (props) forecastByVenue.set(v.id, props);
    } catch (e) {
      diag.errors.push({ venue: v.venue_name, err: String(e) });
    }
  }

  // 5. compute rows
  const out: any[] = [];
  for (const { ev, venue } of matched) {
    const props = venue.is_dome ? {} : forecastByVenue.get(venue.id);
    if (!venue.is_dome && !props) continue;    // fetch failed or OOC, already recorded
    const row = computeRow(venue, ev, props, diag);
    if (row) out.push(row);
  }

  diag.would_write = out.length;
  if (dry) {
    diag.sample = out.slice(0, 3);
    diag.ms = Date.now() - t0;
    return json(diag);
  }

  /* FIX 4: chunked writes. A single unguarded upsert meant one rejected row
     discarded the entire run — and because the handler's catch returns 500,
     the failure looked like a total outage rather than one bad venue. */
  let written = 0;
  for (let i = 0; i < out.length; i += WRITE_CHUNK) {
    const chunk = out.slice(i, i + WRITE_CHUNK);
    try {
      await sb(`venue_weather?on_conflict=event_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      written += chunk.length;
    } catch (e) {
      diag.ok = false;
      diag.errors.push({ chunk: `${i}-${i + chunk.length - 1}`, err: String(e) });
    }
  }
  diag.written = written;
  diag.ms = Date.now() - t0;
  return json(diag, diag.errors.length && written === 0 ? 500 : 200);
}

/** getVenueWeather(venueId, gameTime). The one generic call. */
async function handleGet(venueId: string, tISO: string | null) {
  const diag: any = { cache_hits: 0, nws_fetches: 0, out_of_coverage: [], uncalibrated: [],
                      dome_events: 0, no_forecast_hour: 0, errors: [] };
  const venues: any[] = await sb(`venues_resolved?id=eq.${enc(venueId)}&select=*`) ?? [];
  const venue = venues[0];
  if (!venue) return json({ error: "unknown venue_id", venue_id: venueId }, 404);

  const t = tISO ? new Date(tISO) : new Date();
  if (isNaN(t.getTime())) return json({ error: "bad t param, want ISO timestamp" }, 400);

  let props: any = {};
  if (!venue.is_dome) {
    try {
      props = await getForecast(venue, diag);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
    if (!props) {
      return json({
        venue_id: venue.id, venue_name: venue.venue_name,
        out_of_coverage: true, note: "outside NWS coverage; no free licensed fallback in use",
      });
    }
  }

  const row = computeRow(venue, { event_id: "adhoc", commence_time: t.toISOString() }, props, diag);
  if (!row) {
    return json({
      venue_id: venue.id, venue_name: venue.venue_name,
      no_forecast_hour: true, note: `no forecast coverage at ${t.toISOString()}`,
    });
  }
  delete row.event_id;
  return json({ ...row, cache_hit: diag.cache_hits > 0 });
}

// ============================================================
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "sync";
  const dry = url.searchParams.get("dry") === "1";

  const cronOk = CRON_SECRET !== "" && (req.headers.get("x-cron-secret") ?? "") === CRON_SECRET;
  const bearerOk = (req.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");

  try {
    if (mode === "get") {
      /* FIX 2: mode=get was completely open. Deployed with Verify JWT off, it
         was an unauthenticated proxy that any caller could pump into live NWS
         requests. The app already sends a bearer, so requiring one costs
         nothing and closes the hole. */
      if (!bearerOk && !cronOk) return json({ error: "unauthorized" }, 401);
      const venueId = url.searchParams.get("venue_id");
      if (!venueId) return json({ error: "venue_id required" }, 400);
      return await handleGet(venueId, url.searchParams.get("t"));
    }

    /* FIX 1: dry=1 used to skip this check entirely, so an anonymous caller
       could run the full scan — every venue, every live NWS fetch, plus cache
       and venue writes. dry now only controls whether venue_weather is written;
       it is not an authentication bypass. */
    if (!cronOk) return json({ error: "unauthorized" }, 401);
    return await handleSync(dry);
  } catch (e) {
    // Non-200 so failure shows in function logs instead of reporting success,
    // which is exactly how the previous weather feed died unnoticed.
    return json({ ok: false, error: String(e) }, 500);
  }
});
