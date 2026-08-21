// OddsBlaze adapter: the only file in the Collective that knows what an odds
// provider's JSON looks like. Everything downstream of normalizeOddsBlaze()
// sees the record_market_snapshots row shape from docs/collective/M-odds.md
// section 7 and nothing else, which is what makes the provider replaceable.
//
// Deliberately free of Deno APIs so it can be exercised offline against the
// captured fixture in tools/collective/fixtures/. The API key is read in
// collective_odds/index.ts and passed in as an argument; it is never read,
// stored, or logged here.
//
// ---------------------------------------------------------------- the feed
//
// Written against a real captured response (DraftKings / MLB), not against a
// guess. One sportsbook and one league per call, the key carried as the `key`
// query parameter:
//
//   { "updated": "2026-08-20T21:52:44.736Z",
//     "league":     { "id": "mlb", "name": "MLB", "sport": "Baseball" },
//     "sportsbook": { "id": "draftkings", "name": "DraftKings" },
//     "events": [
//       { "id": "d18ab4b2-...", "date": "2026-08-21T00:05:00.000Z", "live": false,
//         "mappings": { "MLB": { "id": "822861" }, "Kalshi": { "id": "KXMLB..." } },
//         "teams": { "home": { "id": "...", "name": "Texas Rangers", "abbreviation": "TEX" },
//                    "away": { "id": "...", "name": "Washington Nationals", "abbreviation": "WSH" } },
//         "odds": [
//           { "id": "DraftKings#<event>#Run Line#Texas Rangers -1.5",
//             "market": "Run Line", "name": "Texas Rangers -1.5", "price": "-181",
//             "main": true, "selection": { "name": "Texas Rangers", "line": -1.5 } },
//           { "market": "Total Runs", "name": "Over 7.5", "price": "-105",
//             "main": true, "selection": { "side": "Over", "line": 7.5 } } ] } ] }
//
// Three things about that shape are easy to get wrong and are the reason this
// file exists:
//
//   * `selection` is an OBJECT, not a string. The team is `selection.name`,
//     the over/under side is `selection.side`, and the handicap or total is
//     `selection.line`. There is no top-level `points` field.
//   * market names are the sport's own vocabulary — "Run Line", "Total Runs" —
//     and the same words prefixed by a period name a different bet entirely
//     ("1st 5 Innings Run Line", "Team Total Runs"). Classification is by
//     exact match for that reason: a substring rule writes an inning's line
//     into the game line and nothing downstream can tell.
//   * `main: true` appears on player props too. It separates the primary line
//     from alternates WITHIN a market; it does not mark the game line.
//
// Field names the capture shows are read first; documented synonyms are
// accepted; anything it cannot read with confidence is reported as a skip
// with a reason rather than guessed at. `GET /v1/odds/probe` prints the shape
// the live feed actually returned, so a drift shows up as a probe diff
// instead of as silently wrong numbers on the board.

// ------------------------------------------------------------------ types

export interface SeasonWindow {
  sport_code: string;
  season: number;
  starts_on: string; // date
  ends_on: string; // date
}

// A row in the record_market_snapshots contract (M-odds section 7).
export interface SnapshotRow {
  sport: string;
  season: number;
  market: "spread";
  home_team: string;
  away_team: string;
  kickoff: string;
  book: string;
  source: string;
  captured_at: string;
  home_line: number | null;
  home_price: number | null;
  away_line: number | null;
  away_price: number | null;
  total_line: number | null;
  over_price: number | null;
  under_price: number | null;
  home_ml_price: number | null;
  away_ml_price: number | null;
}

// A row for collective.link_provider_events.
export interface EventLinkRow {
  provider: string;
  provider_event_id: string;
  sport: string;
  season: number | null;
  home_team: string;
  away_team: string;
  starts_at: string;
  mappings: Record<string, unknown>;
}

export interface Skipped {
  reason: string;
  event_id?: string;
  detail?: string;
}

export interface NormalizeResult {
  rows: SnapshotRow[];
  links: EventLinkRow[];
  skipped: Skipped[];
  book: string | null;
  league: string | null;
  captured_at: string;
}

export interface NormalizeOptions {
  // league id from the feed -> Collective sport code, e.g. { mlb: "MLB" }.
  leagueToSport: Record<string, string>;
  seasons: SeasonWindow[];
  // Used when the feed carries no `updated` timestamp.
  now: string;
  source?: string;
  // In-progress games. Off by default: a live price is a different market
  // from the pregame one, and the closing line is defined as the last
  // snapshot before kickoff. Mixing them would corrupt CLV silently.
  includeLive?: boolean;
}

// The league ids the feed uses, mapped to Collective sport codes. Overridable
// from config so a new league needs no deploy.
export const DEFAULT_LEAGUE_TO_SPORT: Record<string, string> = {
  mlb: "MLB",
  nfl: "NFL",
  ncaaf: "NCAAF",
  "ncaa football": "NCAAF",
};

// --------------------------------------------------------------- utilities

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

// Reads the first present key. The captured name always leads.
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

// American prices only. A price that is not an integer, or whose magnitude is
// under 100, is not American: it is decimal, fractional, or probability, and
// storing it as American would be a silent factor-of-anything error. Rejected
// rather than converted, because guessing which format arrived is guessing.
export function parseAmericanPrice(v: unknown): number | null {
  let raw: string | null = null;
  if (typeof v === "number") raw = String(v);
  else if (typeof v === "string") raw = v.trim();
  else if (isObj(v)) raw = str(pick(v, ["american", "price", "odds"]));
  if (!raw) return null;
  raw = raw.replace(/^\+/, "").replace(/,/g, "");
  if (!/^-?\d+(\.0+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return Math.trunc(n);
}

// A points/handicap value: -1.5, "-1.5", "+3.5", "7.5". "PK"/"EVEN" is 0.
export function parsePoints(v: unknown): number | null {
  let raw: string | null = null;
  if (typeof v === "number") raw = String(v);
  else if (typeof v === "string") raw = v.trim();
  if (!raw) return null;
  if (/^(pk|pick|pick'?em|even)$/i.test(raw)) return 0;
  raw = raw.replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type MarketKind = "spread" | "moneyline" | "total" | null;

// The full-game two-way markets, by exact normalized name. Exactness is the
// whole safety property: "1st 5 Innings Run Line", "3rd Inning Run Line",
// "Team Total Runs", and "Player Hits" all normalize to tokens that are not
// in these sets, so a derivative market can never be read as the game line.
// Adding a league means adding its words here, deliberately, in one place.
const SPREAD_MARKETS = new Set([
  "pointspread", "pointspreads", "spread", "spreads",
  "runline", "runlines", "puckline", "pucklines", "handicap", "asianhandicap",
]);
const MONEYLINE_MARKETS = new Set([
  "moneyline", "moneylines", "ml", "headtohead", "h2h", "matchwinner",
]);
const TOTAL_MARKETS = new Set([
  "total", "totals", "totalpoints", "totalruns", "totalgoals", "overunder",
  "totalpointsoverunder",
]);

export function classifyMarket(market: unknown): MarketKind {
  const raw = typeof market === "string"
    ? market
    : isObj(market)
    ? (str(pick(market, ["id", "name"])) ?? "")
    : "";
  const t = normToken(raw);
  if (!t) return null;
  if (SPREAD_MARKETS.has(t)) return "spread";
  if (MONEYLINE_MARKETS.has(t)) return "moneyline";
  if (TOTAL_MARKETS.has(t)) return "total";
  return null;
}

interface TeamRef {
  id: string | null;
  name: string | null;
  abbreviation: string | null;
}

function teamRef(v: unknown): TeamRef {
  if (typeof v === "string") return { id: null, name: v.trim() || null, abbreviation: null };
  if (!isObj(v)) return { id: null, name: null, abbreviation: null };
  return {
    id: str(pick(v, ["id"])),
    name: str(pick(v, ["name", "full_name", "display_name"])),
    abbreviation: str(pick(v, ["abbreviation", "abbr", "short_name", "code"])),
  };
}

// What an odds entry is selecting. The capture puts all three parts inside
// `selection`; a feed that sends a bare string, or that hoists the parts to
// the top level, is read too.
interface Selection {
  team: string | null;
  side: string | null;
  line: number | null;
}

function selectionOf(o: Record<string, unknown>): Selection {
  const sel = o["selection"];
  let team: string | null = null;
  let side: string | null = null;
  let line: number | null = null;

  if (isObj(sel)) {
    team = str(pick(sel, ["name", "team", "participant"]));
    side = str(pick(sel, ["side", "type"]));
    line = parsePoints(pick(sel, ["line", "points", "point", "handicap", "total"]));
  } else if (typeof sel === "string") {
    team = sel.trim() || null;
  }

  if (team === null) team = str(pick(o, ["team", "participant"]));
  if (side === null) side = str(pick(o, ["side"]));
  if (line === null) {
    line = parsePoints(pick(o, ["points", "point", "line", "handicap", "spread", "total"]));
  }

  // Last resort: the display name, which leads with the team and ends with
  // the number — "Texas Rangers -1.5", "Over 7.5".
  const name = str(pick(o, ["name"]));
  if (name) {
    if (line === null) {
      const m = name.match(/([+-]?\d+(?:\.\d+)?)\s*$/);
      if (m) line = parsePoints(m[1]);
    }
    if (side === null) {
      const m = name.match(/\b(over|under)\b/i);
      if (m) side = m[1];
    }
    if (team === null) team = name;
  }
  return { team, side, line };
}

// Which side of a two-way team market this selection is. An exact match on
// the abbreviation, exact-or-prefix on the name: "New York Yankees" and
// "New York Mets" must never collide, and a bare "NY" must never be taken as
// either. A selection that hits both teams, or neither, is not read.
function sideForTeam(sel: Selection, home: TeamRef, away: TeamRef): "home" | "away" | null {
  if (!sel.team) return null;
  const t = normToken(sel.team);
  if (!t) return null;
  const hits = (ref: TeamRef) => {
    const name = ref.name ? normToken(ref.name) : "";
    if (name && (t === name || t.startsWith(name))) return true;
    const abbr = ref.abbreviation ? normToken(ref.abbreviation) : "";
    if (abbr && t === abbr) return true;
    const id = ref.id ? normToken(ref.id) : "";
    return Boolean(id) && t === id;
  };
  const h = hits(home);
  const a = hits(away);
  if (h && !a) return "home";
  if (a && !h) return "away";
  return null;
}

function sideForTotal(sel: Selection): "over" | "under" | null {
  const raw = sel.side ?? sel.team;
  if (!raw) return null;
  const t = normToken(raw);
  if (t === "over" || t === "o" || t.startsWith("over")) return "over";
  if (t === "under" || t === "u" || t.startsWith("under")) return "under";
  return null;
}

// ISO 8601 or epoch seconds/milliseconds. Anything else is unreadable, not
// "now": a snapshot stamped with the wrong time is worse than no snapshot.
export function parseTimestamp(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = str(v);
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseTimestamp(Number(s));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The season a kickoff belongs to, from collective.sport_seasons and nothing
// else. A kickoff outside every configured window returns null and the row is
// skipped: resolve_game_ref matches on an exact season, so a guessed season
// silently fails to match instead of loudly refusing.
export function seasonFor(
  sport: string,
  kickoffIso: string,
  seasons: SeasonWindow[],
): number | null {
  const t = new Date(kickoffIso).getTime();
  if (isNaN(t)) return null;
  for (const w of seasons) {
    if (w.sport_code !== sport) continue;
    const start = new Date(`${w.starts_on}T00:00:00Z`).getTime();
    const end = new Date(`${w.ends_on}T23:59:59Z`).getTime();
    if (t >= start && t <= end) return w.season;
  }
  return null;
}

// ------------------------------------------------------------- normalizer

interface Payload {
  updated?: unknown;
  sportsbook?: unknown;
  league?: unknown;
  events?: unknown;
}

// Accepts a single payload, an array of payloads (several sportsbook/league
// calls collected together), or a bare array of events.
export function payloadsOf(body: unknown): Payload[] {
  if (Array.isArray(body)) {
    if (body.length > 0 && isObj(body[0]) && "events" in (body[0] as object)) {
      return body as Payload[];
    }
    return [{ events: body }];
  }
  if (!isObj(body)) return [];
  if (Array.isArray(body.events)) return [body as Payload];
  for (const k of ["data", "odds", "results", "leagues", "sportsbooks"]) {
    const inner = body[k];
    if (Array.isArray(inner)) return payloadsOf(inner);
  }
  return [];
}

export function normalizeOddsBlaze(body: unknown, opts: NormalizeOptions): NormalizeResult {
  const source = opts.source ?? "oddsblaze";
  const rows: SnapshotRow[] = [];
  const links: EventLinkRow[] = [];
  const skipped: Skipped[] = [];
  let book: string | null = null;
  let league: string | null = null;
  let captured = opts.now;

  const payloads = payloadsOf(body);
  if (payloads.length === 0) {
    return {
      rows,
      links,
      skipped: [{ reason: "no_events_in_response" }],
      book,
      league,
      captured_at: captured,
    };
  }

  for (const p of payloads) {
    const sbObj = isObj(p.sportsbook) ? p.sportsbook : {};
    const payloadBook = typeof p.sportsbook === "string"
      ? p.sportsbook
      : str(pick(sbObj, ["name", "id"]));
    const lgObj = isObj(p.league) ? p.league : {};
    const payloadLeague = typeof p.league === "string"
      ? p.league
      : str(pick(lgObj, ["id", "name"]));
    const payloadCaptured = parseTimestamp(
      pick(p as Record<string, unknown>, ["updated", "timestamp", "last_updated"]),
    );
    if (payloadCaptured) captured = payloadCaptured;
    if (payloadBook) book = payloadBook;
    if (payloadLeague) league = payloadLeague;

    const sportFromLeague = payloadLeague
      ? opts.leagueToSport[payloadLeague.toLowerCase()] ?? null
      : null;

    const events = Array.isArray(p.events) ? p.events : [];
    for (const ev of events) {
      if (!isObj(ev)) {
        skipped.push({ reason: "event_not_an_object" });
        continue;
      }
      const eventId = str(pick(ev, ["id", "event_id"]));

      if (ev.live === true && !opts.includeLive) {
        skipped.push({ reason: "live_game", event_id: eventId ?? undefined });
        continue;
      }

      // Teams. teams.home / teams.away as captured; the flat form is accepted
      // because it is the other common spelling.
      const teamsObj = isObj(ev.teams) ? ev.teams : null;
      const home = teamRef(teamsObj ? pick(teamsObj, ["home"]) : pick(ev, ["home_team", "home"]));
      const away = teamRef(teamsObj ? pick(teamsObj, ["away"]) : pick(ev, ["away_team", "away"]));
      if (!home.name || !away.name) {
        skipped.push({ reason: "unreadable_teams", event_id: eventId ?? undefined });
        continue;
      }

      const kickoff = parseTimestamp(
        pick(ev, ["date", "start_date", "start_time", "starts_at", "commence_time"]),
      );
      if (!kickoff) {
        skipped.push({ reason: "unreadable_kickoff", event_id: eventId ?? undefined });
        continue;
      }

      const evLeague = isObj(ev.league) ? str(pick(ev.league, ["id", "name"])) : str(ev.league);
      const sport = sportFromLeague ??
        (evLeague ? opts.leagueToSport[evLeague.toLowerCase()] ?? null : null);
      if (!sport) {
        skipped.push({
          reason: "league_not_mapped_to_sport",
          event_id: eventId ?? undefined,
          detail: payloadLeague ?? evLeague ?? "unknown",
        });
        continue;
      }

      const season = seasonFor(sport, kickoff, opts.seasons);
      if (season === null) {
        skipped.push({
          reason: "kickoff_outside_configured_seasons",
          event_id: eventId ?? undefined,
          detail: kickoff,
        });
        continue;
      }

      const evBook = isObj(ev.sportsbook)
        ? str(pick(ev.sportsbook, ["name", "id"]))
        : str(ev.sportsbook);
      const rowBook = evBook ?? payloadBook;
      if (!rowBook) {
        skipped.push({ reason: "no_sportsbook_on_response", event_id: eventId ?? undefined });
        continue;
      }

      const oddsList = Array.isArray(ev.odds)
        ? ev.odds
        : Array.isArray((ev as Record<string, unknown>).markets)
        ? (ev as Record<string, unknown>).markets as unknown[]
        : [];

      const row: SnapshotRow = {
        sport,
        season,
        market: "spread",
        home_team: home.name,
        away_team: away.name,
        kickoff,
        book: rowBook,
        source,
        captured_at: payloadCaptured ?? captured,
        home_line: null,
        home_price: null,
        away_line: null,
        away_price: null,
        total_line: null,
        over_price: null,
        under_price: null,
        home_ml_price: null,
        away_ml_price: null,
      };

      // `main` separates the primary line from alternates within a market.
      // Alternates carry main:false and are skipped: one snapshot row is the
      // game line, and an alt line written into it would misreport what the
      // book was hanging. Where a book posts more than one primary line (the
      // capture shows DraftKings hanging both a -1.5 and a -1 run line, both
      // main), the first in feed order wins and the rest are left alone —
      // deterministic, and it is the line the book lists first.
      const taken = new Set<string>();
      let sawAlt = false;
      for (const o of oddsList) {
        if (!isObj(o)) continue;
        const kind = classifyMarket(pick(o, ["market", "market_name", "market_id"]));
        if (!kind) continue;
        if (pick(o, ["main"]) === false) {
          sawAlt = true;
          continue;
        }
        const sel = selectionOf(o);
        const price = parseAmericanPrice(pick(o, ["price", "odds", "american", "american_odds"]));

        if (kind === "moneyline") {
          const side = sideForTeam(sel, home, away);
          if (!side || price === null) continue;
          const slot = side === "home" ? "home_ml_price" : "away_ml_price";
          if (taken.has(slot)) continue;
          row[slot] = price;
          taken.add(slot);
          continue;
        }

        if (kind === "spread") {
          const side = sideForTeam(sel, home, away);
          if (!side || sel.line === null) continue;
          const slot = side === "home" ? "spread_home" : "spread_away";
          if (taken.has(slot)) continue;
          taken.add(slot);
          if (side === "home") {
            row.home_line = sel.line;
            row.home_price = price;
          } else {
            row.away_line = sel.line;
            row.away_price = price;
          }
          continue;
        }

        // total
        const side = sideForTotal(sel);
        if (!side || sel.line === null) continue;
        const slot = side === "over" ? "total_over" : "total_under";
        if (taken.has(slot)) continue;
        taken.add(slot);
        if (row.total_line === null) row.total_line = sel.line;
        if (side === "over") row.over_price = price;
        else row.under_price = price;
      }

      // Home convention, enforced here so the database CHECK never sees a
      // violation: the stored pair is always home_line = -away_line. A book
      // quoting only the away side is flipped before writing, never after.
      if (row.home_line !== null && row.away_line !== null) {
        if (row.home_line !== -row.away_line) {
          // Two different lines in one capture is a feed the reader does not
          // understand. The spread is dropped; totals and moneyline still
          // stand, because they are independently readable.
          skipped.push({
            reason: "spread_sides_disagree",
            event_id: eventId ?? undefined,
            detail: `home ${row.home_line} vs away ${row.away_line}`,
          });
          row.home_line = null;
          row.away_line = null;
          row.home_price = null;
          row.away_price = null;
        }
      } else if (row.home_line === null && row.away_line !== null) {
        row.home_line = -row.away_line;
      } else if (row.away_line === null && row.home_line !== null) {
        row.away_line = -row.home_line;
      }

      const hasMarket = row.home_line !== null || row.total_line !== null ||
        row.home_ml_price !== null || row.away_ml_price !== null;
      if (!hasMarket) {
        skipped.push({
          reason: sawAlt ? "no_main_line_only_alternates" : "no_readable_game_line",
          event_id: eventId ?? undefined,
        });
        continue;
      }

      rows.push(row);
      if (eventId) {
        links.push({
          provider: source,
          provider_event_id: eventId,
          sport,
          season,
          home_team: home.name,
          away_team: away.name,
          starts_at: kickoff,
          mappings: collectMappings(ev, home, away),
        });
      }
    }
  }

  return { rows, links, skipped, book, league, captured_at: captured };
}

// Ids the feed carries for the same fixture, kept as a ledger so a later
// settle-from-official-id path has something to work with. Never
// authoritative. The capture nests them one level — { "MLB": { "id": "822861" },
// "Kalshi": { "id": "KXMLB..." } } — so each provider is flattened to its id.
function collectMappings(
  ev: Record<string, unknown>,
  home: TeamRef,
  away: TeamRef,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const m = ev["mappings"];
  if (isObj(m)) {
    for (const [k, v] of Object.entries(m)) {
      const id = isObj(v) ? str(pick(v, ["id", "value"])) : str(v);
      if (id) out[k] = id;
    }
  }
  for (const k of ["sport_id", "league_id", "espn_id", "sportradar_id", "sr_id", "external_id"]) {
    const v = str(ev[k]);
    if (v) out[k] = v;
  }
  if (home.id) out.home_team_id = home.id;
  if (away.id) out.away_team_id = away.id;
  if (home.abbreviation) out.home_abbr = home.abbreviation;
  if (away.abbreviation) out.away_abbr = away.abbreviation;
  return out;
}

// ------------------------------------------------------------------ fetch

// The documented odds endpoint: one sportsbook, one league, key as a query
// parameter. Not guessed — it is the URL the captured response came from.
// ODDS_API_BASE_URL overrides it without a deploy if the account is served
// somewhere else; sportsbook and league are appended unless already present.
export const ODDS_BASE_URL = "https://odds.oddsblaze.com/";

export function oddsUrl(
  baseUrl: string | null,
  sportsbook: string,
  league: string,
  key: string,
): string {
  const u = new URL(baseUrl || ODDS_BASE_URL);
  if (!u.searchParams.has("sportsbook")) u.searchParams.set("sportsbook", sportsbook);
  if (!u.searchParams.has("league")) u.searchParams.set("league", league);
  u.searchParams.set("key", key);
  return u.toString();
}

// A URL safe to print: the key never appears in a response, a log line, or an
// error message.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("key")) u.searchParams.set("key", "REDACTED");
    return u.toString();
  } catch {
    return "unparseable-url";
  }
}

export interface FetchOutcome {
  ok: boolean;
  url: string; // redacted
  status: number;
  body: unknown;
  error?: string;
}

export async function fetchOddsBlaze(
  fetchImpl: typeof fetch,
  baseUrl: string | null,
  sportsbook: string,
  league: string,
  key: string,
  timeoutMs = 20000,
): Promise<FetchOutcome> {
  const url = oddsUrl(baseUrl, sportsbook, league, key);
  const shown = redactUrl(url);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "Accept": "application/json" },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // The provider's error text can echo the request, key included. The
      // status is reported; the body never is.
      return { ok: false, url: shown, status: res.status, body: null, error: `provider_status_${res.status}` };
    }
    try {
      return { ok: true, url: shown, status: res.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, url: shown, status: res.status, body: null, error: "provider_returned_non_json" };
    }
  } catch (e) {
    return {
      ok: false,
      url: shown,
      status: 0,
      body: null,
      error: e instanceof Error && e.name === "AbortError" ? "provider_timeout" : "provider_unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- probe

// The shape of a value, to the depth worth reading: enough to compare the
// live response against the shape this adapter was written for, without
// printing odds data or anything else that could carry a credential.
export function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return depth >= 4
      ? `array[${v.length}]`
      : { array: v.length, of: v.length ? shapeOf(v[0], depth + 1) : "empty" };
  }
  if (isObj(v)) {
    if (depth >= 4) return `object{${Object.keys(v).length}}`;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).slice(0, 40)) out[k] = shapeOf(v[k], depth + 1);
    return out;
  }
  return typeof v;
}

// The market names the feed printed and whether this adapter reads each one.
// The answer to "why is there no line for that game" is usually here.
export function marketCensus(body: unknown): Array<{ market: string; count: number; read_as: string }> {
  const seen = new Map<string, number>();
  for (const p of payloadsOf(body)) {
    const events = Array.isArray(p.events) ? p.events : [];
    for (const ev of events) {
      if (!isObj(ev)) continue;
      const oddsList = Array.isArray(ev.odds) ? ev.odds : [];
      for (const o of oddsList) {
        if (!isObj(o)) continue;
        const name = typeof o.market === "string"
          ? o.market
          : isObj(o.market)
          ? (str(pick(o.market, ["name", "id"])) ?? "")
          : "";
        if (!name) continue;
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
    }
  }
  return [...seen.entries()]
    .map(([market, count]) => ({ market, count, read_as: classifyMarket(market) ?? "ignored" }))
    .sort((a, b) => b.count - a.count);
}
