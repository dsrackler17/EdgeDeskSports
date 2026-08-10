// ============================================================
//  FILE:    supabase/functions/ingest_multisport/index.ts
//  TYPE:    Edge Function (deployed) - cron job
//  DEPLOY:  supabase functions deploy ingest_multisport --no-verify-jwt
//  RUN:     POST {"sport":"nfl"}            one sport, today
//           POST {"sport":"all","days":3}   every sport, next N days
//           GET  ?mode=health               is each feed alive
//           GET  ?mode=probe&sport=cbb      what a feed returns, without writing
// ============================================================
// MULTISPORT INGEST — NFL, college football, college basketball.
//
// One function rather than three, because the schedule/venue/odds shape is
// identical across ESPN's leagues and only the efficiency feed differs per
// sport. Three copies of the same adapter is three places for the same bug.
//
// SOURCES, and why each one
//   ESPN scoreboard      (keyless)  schedule, teams, venue, neutral site,
//                                   conference flag, rankings, and for NFL the
//                                   weather block. The spine every sport needs.
//   ESPN team statistics (keyless)  season team stats. Broad but shallow — it
//                                   is the fallback, not the point.
//   nflverse             (keyless)  NFL EPA per play, success rate, pass/rush
//                                   splits. This is the Statcast of football:
//                                   the difference between "scores 24 a game"
//                                   and "is actually good".
//   Barttorvik           (keyless)  college basketball adjusted efficiency,
//                                   tempo and the four factors. The single most
//                                   predictive free dataset in the sport, and
//                                   the KenPom-equivalent core.
//
// College football is the thinnest of the three and this file says so rather
// than pretending otherwise: without a CollegeFootballData key there is no free
// play-by-play EPA, so CFB gets ESPN team stats plus rankings and its
// efficiency columns stay null. That is a real gap, reported as one.
//
// THE DISCIPLINE, carried over from ingest_mlb because it is what made that one
// debuggable: every feed reports its HTTP status, byte count, parsed row count
// AND ITS COLUMN NAMES. Assuming a column is what cost a week on the MLB side
// (`era_minus_xera_diff` silently stored as xERA) and again on the learning
// loop (`signals.verdict` did not exist). A feed that changes shape should be
// visible in the first run's output, not three weeks later.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const UA = { 'User-Agent': 'EdgeDesk/1.0 (contact: ops@edgedesk)', 'Accept': 'application/json,text/csv,*/*' };

export const BUILD = '2026-08-14.5-auto-discover';

/* ========================================================================
   SPORTS
   ======================================================================== */

export interface SportDef {
  key: string;            // EdgeDesk sport_key, matching `signals`
  slug: string;           // our short name
  espnSport: string;      // ESPN path segment
  espnLeague: string;
  label: string;
  kind: 'football' | 'basketball';
  gamePrefix: string;     // game_id prefix, matching the MLB- convention
}

export const SPORTS: Record<string, SportDef> = {
  nfl: {
    key: 'americanfootball_nfl', slug: 'nfl', espnSport: 'football', espnLeague: 'nfl',
    label: 'NFL', kind: 'football', gamePrefix: 'NFL',
  },
  cfb: {
    key: 'americanfootball_ncaaf', slug: 'cfb', espnSport: 'football', espnLeague: 'college-football',
    label: 'CFB', kind: 'football', gamePrefix: 'CFB',
  },
  cbb: {
    key: 'basketball_ncaab', slug: 'cbb', espnSport: 'basketball', espnLeague: 'mens-college-basketball',
    label: 'CBB', kind: 'basketball', gamePrefix: 'CBB',
  },
};

/* ========================================================================
   HELPERS — pure, exported, tested
   ======================================================================== */

export const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** YYYYMMDD, which is what ESPN's `dates` parameter wants. */
export function espnDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * CSV -> rows. Same parser as the MLB side, including the fix that cost a week
 * there: quotes are stripped from VALUES as well as headers, because
 * parseFloat('"5.41"') is NaN and the stat silently vanishes.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim().replace(/^"|"$/g, ''));
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row: Record<string, string> = {};
    head.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/**
 * Column lookup: EXACT name first, then a fuzzy match that refuses any header
 * looking like a derived difference.
 *
 * This is the ingest_mlb bug, kept fixed here rather than reintroduced: a
 * fuzzy-first lookup for `xera` matched `era_minus_xera_diff` whenever the real
 * cell was blank, and stored a -0.62 difference as an expected ERA.
 */
export function col(row: Record<string, string>, names: string[]): number | null {
  for (const n of names) {
    if (n in row) { const v = num(row[n]); if (v != null) return v; }
  }
  const keys = Object.keys(row).filter((k) => !/_diff$|_minus_|^diff_/i.test(k));
  for (const n of names) {
    const hit = keys.find((k) => k.toLowerCase() === n.toLowerCase())
      ?? keys.find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === n.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit) { const v = num(row[hit]); if (v != null) return v; }
  }
  return null;
}

/** Normalised team name, for joining a stats feed to a schedule feed. */
export function normTeam(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    /* Apostrophes are REMOVED, not turned into separators. "St. John's" and
       "St Johns" are the same school and two feeds will spell it both ways;
       splitting on the apostrophe yields "john s" against "johns" and the join
       silently misses. */
    .replace(/['\u2019]/g, '')
    .replace(/\bst\.?\b/g, 'state')          // "Ohio St." -> "ohio state"
    .replace(/\buniv(ersity)?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Rest days between two ISO datetimes, or null. Football and college
 * basketball both hinge on this and it is free to compute from the schedule.
 */
export function restDays(prevIso: string | null, thisIso: string | null): number | null {
  if (!prevIso || !thisIso) return null;
  const a = Date.parse(prevIso), b = Date.parse(thisIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 86400000);
  return d >= 0 && d < 60 ? d : null;
}

/** Four-factor and efficiency rows from Barttorvik's public CSV. */
export function torvikRow(r: Record<string, string>) {
  return {
    adj_o: col(r, ['adjoe', 'adj_o', 'AdjOE']),
    adj_d: col(r, ['adjde', 'adj_d', 'AdjDE']),
    adj_tempo: col(r, ['adj_t', 'adjt', 'tempo', 'AdjT']),
    efg_pct: col(r, ['efg_o', 'efg', 'eFG']),
    def_efg_pct: col(r, ['efg_d', 'efgd']),
    to_pct: col(r, ['to_o', 'tor', 'TOR']),
    def_to_pct: col(r, ['to_d', 'tord', 'TORD']),
    orb_pct: col(r, ['or_o', 'orb', 'ORB']),
    def_orb_pct: col(r, ['or_d', 'drb', 'DRB']),
    ft_rate: col(r, ['ftr_o', 'ftr', 'FTR']),
    def_ft_rate: col(r, ['ftr_d', 'ftrd', 'FTRD']),
    three_rate: col(r, ['three_rate_o', '3pr', 'three_rate']),
    def_three_rate: col(r, ['three_rate_d', '3prd']),
    three_pct: col(r, ['three_pct_o', '3p_pct', 'three_pct']),
    def_three_pct: col(r, ['three_pct_d', '3p_pct_d']),
    ft_pct: col(r, ['ft_pct', 'ftpct']),
    avg_height: col(r, ['avg_hgt', 'height', 'avg_height']),
    experience: col(r, ['exp', 'experience']),
    bench_minutes: col(r, ['bench', 'bench_minutes']),
    wab: col(r, ['wab', 'WAB']),
  };
}

/**
 * Torvik context the probe revealed: barthag, strength of schedule and the
 * conference come from the season results file, while the four factors live in
 * the trank leaderboard. Two files, two shapes — so what the results file adds
 * goes into `metrics` rather than pretending the four factors were found.
 */
export function torvikExtras(r: Record<string, string>) {
  return {
    barthag: col(r, ['barthag']),
    sos: col(r, ['sos']),
    ncsos: col(r, ['ncsos']),
    opp_oe: col(r, ['Opp OE', 'opp_oe']),
    opp_de: col(r, ['Opp DE', 'opp_de']),
    conf: r.conf ?? r.Conf ?? null,
    record: r.record ?? r.Record ?? null,
    note: 'barthag is the projected win rate against an average D1 team. From the season results file; the four factors come from the trank leaderboard and are absent here.',
  };
}

/** Team EPA rows from an nflverse-shaped team stats CSV. */
/**
 * Map an nflverse team-stats row.
 *
 * The first version of this looked for `off_epa_play` and `def_epa_play` and
 * would have found NEITHER. The probe returned the real header list and the
 * file is season TOTALS, not rates: passing_epa, rushing_epa, attempts,
 * carries, games. Every per-play number has to be derived, and the defensive
 * columns are counting stats (def_sacks, def_interceptions, tackles for loss),
 * not EPA allowed.
 *
 * So this derives what the file genuinely supports and REFUSES to fabricate
 * what it does not. Defensive EPA per play is not in this feed; it is left
 * null and named in `missing` rather than approximated from sacks, because a
 * disruption proxy dressed as an efficiency number is exactly the kind of
 * quiet substitution that makes a model look predictive and behave randomly.
 */
export function nflverseRow(r: Record<string, string>) {
  const games = col(r, ['games']);
  const att = col(r, ['attempts']);
  const car = col(r, ['carries']);
  const sacked = col(r, ['sacks_suffered']);
  const passEpa = col(r, ['passing_epa']);
  const rushEpa = col(r, ['rushing_epa']);

  // A dropback is a pass attempt plus a sack; a play is that plus a carry.
  const dropbacks = att != null ? att + (sacked ?? 0) : null;
  const plays = (att != null && car != null) ? att + car + (sacked ?? 0) : null;
  const totalEpa = (passEpa != null || rushEpa != null)
    ? (passEpa ?? 0) + (rushEpa ?? 0) : null;

  const per = (total: number | null, denom: number | null) =>
    (total != null && denom != null && denom > 0) ? +(total / denom).toFixed(4) : null;

  const passYds = col(r, ['passing_yards']);
  const rushYds = col(r, ['rushing_yards']);
  const ints = col(r, ['passing_interceptions']);
  const fumLost = col(r, ['fumbles_lost_total']);
  const defInts = col(r, ['def_interceptions']);
  const defFumRec = col(r, ['fumble_recovery_opp']);
  const takeaways = (defInts != null || defFumRec != null) ? (defInts ?? 0) + (defFumRec ?? 0) : null;
  const giveaways = (ints != null || fumLost != null) ? (ints ?? 0) + (fumLost ?? 0) : null;

  const fields = {
    off_epa_play: per(totalEpa, plays),
    pass_epa_play: per(passEpa, dropbacks),
    rush_epa_play: per(rushEpa, car),
    yards_per_play: (passYds != null && rushYds != null)
      ? per(passYds + rushYds, plays) : null,
    plays_per_game: per(plays, games),
    sack_rate_allowed: (sacked != null && dropbacks != null && dropbacks > 0)
      ? +(sacked / dropbacks).toFixed(4) : null,
    turnover_margin_pg: (takeaways != null && giveaways != null)
      ? per(takeaways - giveaways, games) : null,
    penalty_yards_pg: per(col(r, ['penalty_yards']), games),
    /* Present in the file only as counting stats, so these stay null. Naming
       them is the point: the research layer reports "not ingested" instead of
       reasoning from a hole it cannot see. */
    def_epa_play: null as number | null,
    def_pass_epa_play: null as number | null,
    def_rush_epa_play: null as number | null,
    off_success_rate: null as number | null,
    def_success_rate: null as number | null,
    explosive_play_rate: null as number | null,
  };

  /* Defensive disruption, kept out of the efficiency columns and stored as
     context. Useful for a quarterback matchup read; not a substitute for EPA. */
  const metrics = {
    def_sacks_pg: per(col(r, ['def_sacks']), games),
    def_qb_hits_pg: per(col(r, ['def_qb_hits']), games),
    def_tfl_pg: per(col(r, ['def_tackles_for_loss']), games),
    def_pass_defended_pg: per(col(r, ['def_pass_defended']), games),
    takeaways_pg: per(takeaways, games),
    cpoe: col(r, ['passing_cpoe']),
    games: games,
    note: 'Defensive counting stats per game. NOT an efficiency measure — nflverse team totals carry no EPA-allowed column, so def_epa_play is genuinely absent rather than approximated from these.',
  };

  return { ...fields, __metrics: metrics };
}

/**
 * Turn weekly team rows into DEFENSIVE efficiency.
 *
 * The identity is exact and needs no extra source: in any game, one team's
 * offensive EPA is the other team's defensive EPA allowed. Given weekly rows
 * carrying `opponent_team`, a season of defence falls straight out of a season
 * of offence — no approximation, no proxy, no substituting sack counts for
 * efficiency.
 *
 * Returns per-team defensive rates keyed by normalised team name. Rows with no
 * opponent are skipped rather than guessed at.
 */
export function defenceFromWeekly(rows: Record<string, string>[]) {
  interface Acc { epa: number; plays: number; passEpa: number; dropbacks: number; rushEpa: number; carries: number; games: number }
  const allowed = new Map<string, Acc>();
  const bump = (k: string) => {
    let a = allowed.get(k);
    if (!a) { a = { epa: 0, plays: 0, passEpa: 0, dropbacks: 0, rushEpa: 0, carries: 0, games: 0 }; allowed.set(k, a); }
    return a;
  };

  let paired = 0, orphaned = 0;
  for (const r of rows) {
    const opp = r.opponent_team ?? r.opponent ?? r.opp ?? '';
    if (!opp) { orphaned++; continue; }
    const att = col(r, ['attempts']), car = col(r, ['carries']), sk = col(r, ['sacks_suffered']);
    const pEpa = col(r, ['passing_epa']), rEpa = col(r, ['rushing_epa']);
    if (att == null && car == null) { orphaned++; continue; }
    const dropbacks = (att ?? 0) + (sk ?? 0);
    const plays = dropbacks + (car ?? 0);
    if (plays <= 0) { orphaned++; continue; }

    // This offensive performance was allowed BY the opponent.
    const a = bump(normTeam(opp));
    a.epa += (pEpa ?? 0) + (rEpa ?? 0);
    a.plays += plays;
    a.passEpa += pEpa ?? 0;
    a.dropbacks += dropbacks;
    a.rushEpa += rEpa ?? 0;
    a.carries += car ?? 0;
    a.games += 1;
    paired++;
  }

  const out = new Map<string, { def_epa_play: number | null; def_pass_epa_play: number | null; def_rush_epa_play: number | null; games: number }>();
  for (const [team, a] of allowed) {
    out.set(team, {
      def_epa_play: a.plays > 0 ? +(a.epa / a.plays).toFixed(4) : null,
      def_pass_epa_play: a.dropbacks > 0 ? +(a.passEpa / a.dropbacks).toFixed(4) : null,
      def_rush_epa_play: a.carries > 0 ? +(a.rushEpa / a.carries).toFixed(4) : null,
      games: a.games,
    });
  }
  return { byTeam: out, paired, orphaned };
}

/** Every value null means the feed produced a shape we did not recognise. */
export function anyValue(o: Record<string, unknown>): boolean {
  return Object.values(o).some((v) => v != null);
}

/* ========================================================================
   FETCH
   ======================================================================== */

interface FeedReport {
  ok: boolean; status?: number; bytes?: number; rows?: number;
  columns?: string[]; error?: string; url?: string;
}

async function getJson(u: string, ms = 20000): Promise<{ json: any; report: FeedReport }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(u, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    const text = await r.text();
    if (!r.ok) return { json: null, report: { ok: false, status: r.status, bytes: text.length, url: u } };
    try {
      return { json: JSON.parse(text), report: { ok: true, status: r.status, bytes: text.length, url: u } };
    } catch {
      return { json: null, report: { ok: false, status: r.status, bytes: text.length, error: 'not JSON', url: u } };
    }
  } catch (e) {
    return { json: null, report: { ok: false, error: String(e).slice(0, 160), url: u } };
  }
}

async function getCsv(u: string, ms = 25000): Promise<{ rows: Record<string, string>[]; report: FeedReport }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(u, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    const text = await r.text();
    if (!r.ok) return { rows: [], report: { ok: false, status: r.status, bytes: text.length, url: u } };
    /* A 200 carrying an HTML error page is the most misleading failure a CSV
         feed has: it parses, it yields "rows", and the first column is
         "<!DOCTYPE html>". Barttorvik did exactly this for a season that does
         not exist yet. Detect it as a failure rather than importing markup. */
    if (/^\s*<(!doctype|html|head|body)/i.test(text)) {
      return { rows: [], report: { ok: false, status: r.status, bytes: text.length, error: 'HTML, not CSV — the feed returned a page (wrong season, or the endpoint moved)', url: u } };
    }
    const rows = parseCsv(text);
    return {
      rows,
      /* The column list is the point. A feed that silently changes a header is
         how a stat becomes null forever without anything looking broken. */
      report: { ok: true, status: r.status, bytes: text.length, rows: rows.length, columns: Object.keys(rows[0] ?? {}), url: u },
    };
  } catch (e) {
    return { rows: [], report: { ok: false, error: String(e).slice(0, 160), url: u } };
  }
}

/* ========================================================================
   ADAPTERS
   ======================================================================== */

async function runAdapter<T>(name: string, fn: () => Promise<T>): Promise<any> {
  const t0 = Date.now();
  try {
    // Await FIRST, measure after — the property-evaluation-order bug that made
    // every ingest_mlb adapter report ms:0 forever.
    const res = await fn() as any;
    return { ok: true, ms: Date.now() - t0, ...res };
  } catch (e) {
    console.log('ADAPTER FAILED', JSON.stringify({ adapter: name, error: String(e) }));
    return { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 300) };
  }
}

/** Schedule + venue + context. The spine; everything else joins to it. */
async function ingestSchedule(sb: any, sp: SportDef, date: string) {
  const dd = date.replace(/-/g, '');
  const { json, report } = await getJson(
    `https://site.api.espn.com/apis/site/v2/sports/${sp.espnSport}/${sp.espnLeague}/scoreboard?dates=${dd}&limit=200`);
  if (!json) return { feed: report, games: 0, upserted: 0 };

  const events: any[] = json.events ?? [];
  let upserted = 0, contexts = 0;
  const teamsSeen: { game_id: string; side: string; team: string; team_id: string; rec: any }[] = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const gid = `${sp.gamePrefix}-${ev.id}`;
    const cs: any[] = comp.competitors ?? [];
    const home = cs.find((c) => c.homeAway === 'home');
    const away = cs.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const status = String(comp.status?.type?.state ?? '').toLowerCase();
    const { error } = await sb.from('games').upsert({
      game_id: gid, sport_key: sp.key,
      game_date: String(ev.date ?? '').slice(0, 10),
      start_time: ev.date ?? null,
      home_team: home.team?.displayName ?? null,
      away_team: away.team?.displayName ?? null,
      status: status === 'post' ? 'final' : status === 'in' ? 'live' : 'scheduled',
      home_score: num(home.score), away_score: num(away.score),
    }, { onConflict: 'game_id' });
    if (!error) upserted++;

    for (const [side, c] of [['home', home], ['away', away]] as const) {
      teamsSeen.push({
        game_id: gid, side, team: c.team?.displayName ?? '', team_id: String(c.team?.id ?? ''),
        rec: c.records?.find((r: any) => r.type === 'total' || r.name === 'overall') ?? c.records?.[0] ?? null,
      });
    }

    // ---- context: the situational layer ----
    const venue = comp.venue ?? {};
    const wx = comp.weather ?? ev.weather ?? null;
    const rank = (c: any) => (c?.curatedRank?.current && c.curatedRank.current <= 25 ? c.curatedRank.current : null);
    const { error: ce } = await sb.from('matchup_context').upsert({
      game_id: gid, sport_key: sp.key,
      game_date: String(ev.date ?? '').slice(0, 10),
      neutral_site: comp.neutralSite ?? null,
      conference_game: comp.conferenceCompetition ?? null,
      home_rank: rank(home), away_rank: rank(away),
      ranking_poll: (rank(home) || rank(away)) ? 'espn_curated' : null,
      venue: venue.fullName ?? null,
      indoor: venue.indoor ?? null,
      surface: venue.grass === true ? 'grass' : venue.grass === false ? 'turf' : null,
      tv: comp.broadcasts?.[0]?.names?.[0] ?? null,
      attendance_pct: (num(comp.attendance) && num(venue.capacity))
        ? +(num(comp.attendance)! / num(venue.capacity)!).toFixed(3) : null,
      notes: wx ? { weather: wx } : null,
      source: 'espn_scoreboard', updated_at: new Date().toISOString(),
    }, { onConflict: 'game_id' });
    if (!ce) contexts++;
  }

  return { feed: report, games: events.length, upserted, contexts, teams: teamsSeen };
}

/**
 * Rest days, computed from each team's own recent schedule.
 *
 * Cheap, entirely derivable from rows already stored, and one of the few
 * situational factors with a durable effect — a short week in football and a
 * third-game-in-five-nights in college basketball both move real numbers.
 */
async function ingestRest(sb: any, sp: SportDef, date: string) {
  const { data: today } = await sb.from('games')
    .select('game_id,home_team,away_team,start_time')
    .eq('sport_key', sp.key).eq('game_date', date);
  if (!today?.length) return { games: 0, filled: 0 };

  const since = new Date(Date.parse(date + 'T00:00:00Z') - 21 * 864e5).toISOString().slice(0, 10);
  const { data: prior } = await sb.from('games')
    .select('home_team,away_team,start_time,game_date')
    .eq('sport_key', sp.key).gte('game_date', since).lt('game_date', date)
    .order('game_date', { ascending: false }).limit(4000);

  const lastFor = new Map<string, string>();
  for (const g of prior ?? []) {
    for (const t of [g.home_team, g.away_team]) {
      if (!t) continue;
      const k = normTeam(t);
      if (!lastFor.has(k)) lastFor.set(k, g.start_time ?? `${g.game_date}T00:00:00Z`);
    }
  }

  let filled = 0;
  for (const g of today) {
    const hr = restDays(lastFor.get(normTeam(g.home_team)) ?? null, g.start_time);
    const ar = restDays(lastFor.get(normTeam(g.away_team)) ?? null, g.start_time);
    if (hr == null && ar == null) continue;
    const short = sp.kind === 'football' && ((hr != null && hr <= 4) || (ar != null && ar <= 4));
    const { error } = await sb.from('matchup_context').upsert({
      game_id: g.game_id, sport_key: sp.key, game_date: date,
      home_rest_days: hr, away_rest_days: ar,
      short_week: sp.kind === 'football' ? short : null,
      off_bye_home: sp.kind === 'football' && hr != null ? hr >= 12 : null,
      off_bye_away: sp.kind === 'football' && ar != null ? ar >= 12 : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'game_id' });
    if (!error) filled++;
  }
  return { games: today.length, filled, teams_with_history: lastFor.size };
}

/** NFL efficiency from nflverse. The Statcast layer of football. */
async function ingestNflEfficiency(sb: any, teams: any[], season: number) {
  /* Try the current season, then the previous one. A season file does not
     exist until that season starts, so in August the current-year URL is a
     legitimate 404 rather than a broken feed — and last season's numbers are
     the correct prior anyway until real games are played. */
  const candidates = [season, season - 1].flatMap((y) => [
    `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_reg_${y}.csv`,
    `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/stats_team_reg_${y}.csv`,
  ]);
  let rows: Record<string, string>[] = [];
  const feeds: FeedReport[] = [];
  for (const u of candidates) {
    const r = await getCsv(u);
    feeds.push(r.report);
    if (r.rows.length) { rows = r.rows; break; }
  }
  if (!rows.length) return { feeds, applied: 0, note: 'no nflverse feed responded — EPA columns stay null' };

  const byTeam = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const nm = r.team ?? r.team_abbr ?? r.recent_team ?? r.posteam ?? '';
    if (nm) byTeam.set(normTeam(nm), r);
  }
  let applied = 0, unmatched = 0;
  for (const t of teams) {
    const r = byTeam.get(normTeam(t.team)) ?? byTeam.get(normTeam(t.abbr ?? ''));
    if (!r) { unmatched++; continue; }
    const { __metrics, ...vals } = nflverseRow(r);
    if (!anyValue(vals)) continue;
    const { error } = await sb.from('team_features')
      .upsert({ game_id: t.game_id, side: t.side, ...vals, metrics: __metrics,
        source: 'nflverse', updated_at: new Date().toISOString() },
        { onConflict: 'game_id,side' });
    if (!error) applied++;
  }
  const sample = byTeam.values().next().value;
  const filled = sample ? Object.entries(nflverseRow(sample))
    .filter(([k, v]) => k !== '__metrics' && v != null).map(([k]) => k) : [];
  const empty = sample ? Object.entries(nflverseRow(sample))
    .filter(([k, v]) => k !== '__metrics' && v == null).map(([k]) => k) : [];
  return {
    feeds, applied, unmatched, teams_in_feed: byTeam.size,
    columns_derived: filled, columns_unavailable: empty,
    note: empty.length
      ? `This feed carries season totals, so per-play rates are derived. ${empty.join(', ')} are NOT in it and stay null — the research layer reports them as not ingested rather than guessing.`
      : undefined,
  };
}

/** College basketball efficiency from Barttorvik. */
async function ingestCbbEfficiency(sb: any, teams: any[], season: number) {
  const candidates = [season, season - 1].flatMap((y) => [
    `https://barttorvik.com/trank.php?year=${y}&csv=1`,
    `https://barttorvik.com/${y}_team_results.csv`,
  ]);
  let rows: Record<string, string>[] = [];
  const feeds: FeedReport[] = [];
  for (const u of candidates) {
    const r = await getCsv(u);
    feeds.push(r.report);
    if (r.rows.length) { rows = r.rows; break; }
  }
  if (!rows.length) return { feeds, applied: 0, note: 'no Torvik feed responded — adjusted efficiency stays null' };

  const byTeam = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const nm = r.team ?? r.Team ?? r.school ?? Object.values(r)[1] ?? '';
    if (nm) byTeam.set(normTeam(nm), r);
  }
  let applied = 0, unmatched = 0;
  const unmatchedNames: string[] = [];
  for (const t of teams) {
    const r = byTeam.get(normTeam(t.team));
    if (!r) { unmatched++; if (unmatchedNames.length < 10) unmatchedNames.push(t.team); continue; }
    const vals = torvikRow(r);
    if (!anyValue(vals)) continue;
    const adjO = vals.adj_o, adjD = vals.adj_d;
    const { error } = await sb.from('team_features').upsert({
      game_id: t.game_id, side: t.side, ...vals,
      adj_em: (adjO != null && adjD != null) ? +(adjO - adjD).toFixed(2) : null,
      metrics: torvikExtras(r),
      source: 'barttorvik', updated_at: new Date().toISOString(),
    }, { onConflict: 'game_id,side' });
    if (!error) applied++;
  }
  return { feeds, applied, unmatched, unmatched_examples: unmatchedNames, teams_in_feed: byTeam.size };
}

/** Base team rows: identity and record, so a row exists even if efficiency fails. */
async function ingestTeamBase(sb: any, sp: SportDef, teams: any[]) {
  let written = 0;
  for (const t of teams) {
    const summary = String(t.rec?.summary ?? '');
    const m = /^(\d+)-(\d+)/.exec(summary);
    const w = m ? parseInt(m[1], 10) : null, l = m ? parseInt(m[2], 10) : null;
    const { error } = await sb.from('team_features').upsert({
      game_id: t.game_id, side: t.side, sport_key: sp.key,
      team: t.team, team_id: t.team_id,
      wins: w, losses: l,
      win_pct: (w != null && l != null && w + l > 0) ? +(w / (w + l)).toFixed(4) : null,
      source: 'espn_scoreboard', updated_at: new Date().toISOString(),
    }, { onConflict: 'game_id,side' });
    if (!error) written++;
  }
  return { team_rows: written };
}

/**
 * Which feed files exist, and can defence be derived from any of them.
 *
 * Runs automatically when a sport's card is empty, because an ingest with no
 * games has nothing else to do and the operator's real question in the
 * off-season is "will this work when the season starts". It also removes a
 * parameter: three separate runs tried to reach this through `mode=discover`
 * and all three arrived as a default ingest, so the information now comes to
 * you instead of having to be asked for.
 */
async function discoverFeeds(sp: SportDef, season: number) {
  const candidates = sp.slug === 'nfl'
    ? [
      `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_reg_${season}.csv`,
      `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`,
      `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_reg_${season}.csv`,
    ]
    : sp.slug === 'cbb'
      ? [
        `https://barttorvik.com/trank.php?year=${season}&csv=1`,
        `https://barttorvik.com/getadvstats.php?year=${season}&csv=1`,
        `https://barttorvik.com/${season}_team_results.csv`,
      ]
      : [];
  if (!candidates.length) {
    return { note: 'College football advanced stats need a CollegeFootballData API key; there is nothing unauthenticated to discover.' };
  }

  const tried: any[] = [];
  for (const u of candidates) {
    const r = await getCsv(u, 20000);
    const cols = r.report.columns ?? [];
    tried.push({
      url: u, ok: r.report.ok, status: r.report.status, rows: r.report.rows,
      error: r.report.error,
      column_count: cols.length,
      has_opponent_column: cols.some((c) => /^(opponent|opponent_team|opp|def_team)$/i.test(c)),
      has_week_column: cols.some((c) => /^week$/i.test(c)),
      has_four_factors: ['efg_o', 'efg', 'to_o', 'or_o', 'ftr'].some((k) => cols.includes(k)),
      /* Only the first 40 headers: enough to identify the file, short enough
         that this block does not bury the run report. */
      columns: cols.slice(0, 40),
    });
  }

  const weekly = tried.find((t) => t.ok && t.has_opponent_column && t.has_week_column);
  const factors = tried.find((t) => t.ok && t.has_four_factors);
  return {
    season, tried,
    verdict: sp.slug === 'nfl'
      ? (weekly
        ? `DEFENSIVE EPA IS DERIVABLE. ${weekly.url} carries week and opponent columns, so one team's offensive EPA in a game is the other's defensive EPA allowed. defenceFromWeekly() is already written and tested against this shape — wiring it to this URL fills def_epa_play, def_pass_epa_play and def_rush_epa_play with real numbers.`
        : 'No weekly file with an opponent column responded. Defensive EPA cannot be derived from the free team feeds, and def_epa_play stays honestly null.')
      : (factors
        ? `The four factors are available from ${factors.url} — in-season these populate.`
        : 'No four-factor feed responded for this season. Adjusted efficiency, tempo, barthag and SOS still land; the four factors need the trank leaderboard, which only exists once a season has games.'),
  };
}

/* ========================================================================
   ONE SPORT, ONE DAY
   ======================================================================== */

async function ingestSport(sb: any, sp: SportDef, date: string, season: number) {
  const schedule = await runAdapter('schedule', () => ingestSchedule(sb, sp, date));
  const teams = (schedule.teams ?? []) as any[];

  const base = await runAdapter('team_base', () => ingestTeamBase(sb, sp, teams));
  const rest = await runAdapter('rest', () => ingestRest(sb, sp, date));
  const efficiency = sp.slug === 'nfl'
    ? await runAdapter('efficiency', () => ingestNflEfficiency(sb, teams, season))
    : sp.slug === 'cbb'
      ? await runAdapter('efficiency', () => ingestCbbEfficiency(sb, teams, season))
      : { ok: true, applied: 0, skipped: 'college football has no free play-by-play EPA feed without a CollegeFootballData key; efficiency columns stay null and the research layer reports that rather than guessing' };

  /* A feed that answered 200 with an empty card is telling the truth: these
     sports do not play every day, and none of them plays in August. Reporting
     that as "starved" trains you to ignore the warning that matters. A failure
     is the feed not answering; an empty slate is an empty slate. */
  const feedAnswered = schedule.ok && (schedule.feed?.ok === true);
  const empty = feedAnswered && (schedule.games ?? 0) === 0;
  const healthy = feedAnswered && (empty || (schedule.upserted ?? 0) > 0);

  const warnings: string[] = [];
  if (!feedAnswered) {
    warnings.push(`${sp.label}: the schedule feed did not answer — every downstream adapter is starved`);
  } else if ((schedule.games ?? 0) > 0 && (schedule.upserted ?? 0) === 0) {
    warnings.push(`${sp.label}: the feed returned ${schedule.games} games but NONE were written — check the games upsert`);
  }
  if (!empty && (efficiency as any).applied === 0 && sp.slug !== 'cfb') {
    warnings.push(`${sp.label}: games landed but NO efficiency rows were applied — the stats feed changed shape or the team names do not match. Check the feeds block.`);
  }
  /* Nothing to ingest means nothing to do, so use the run to answer the
     question that actually matters out of season. */
  /* Ask about the LAST COMPLETED season. The question is "does this file type
     exist and what shape is it", and a season that has not started yet is a
     404 that answers nothing. */
  const discovery = empty ? await discoverFeeds(sp, season - 1) : undefined;

  return {
    sport: sp.label, date, healthy,
    ...(empty ? { note: `no ${sp.label} games scheduled on ${date} — the feed answered with an empty card, which is not a fault` } : {}),
    ...(discovery ? { feed_discovery: discovery } : {}),
    ...(warnings.length ? { warnings } : {}),
    schedule: { ...schedule, teams: undefined }, team_base: base, rest, efficiency,
  };
}

/* ========================================================================
   HANDLER
   ======================================================================== */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function seasonFor(sp: SportDef, d: Date): number {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  // Football seasons are labelled by the year they start; basketball by the
  // year they END, which is the convention every college feed uses.
  if (sp.kind === 'football') return m >= 3 ? y : y - 1;
  return m >= 7 ? y + 1 : y;
}

Deno.serve(async (req) => {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    let body: any = {}; try { body = await req.json(); } catch { /* GET */ }
    const mode = body.mode ?? params.mode ?? 'ingest';
    const want = String(body.sport ?? params.sport ?? 'all').toLowerCase();
    const days = Math.max(1, Math.min(7, Number(body.days ?? params.days ?? 1)));
    const sb = createClient(url, serviceKey);

    const chosen = want === 'all' ? Object.values(SPORTS)
      : SPORTS[want] ? [SPORTS[want]] : [];
    if (!chosen.length) {
      return json({ ok: false, error: `unknown sport "${want}"`, valid: Object.keys(SPORTS) }, 400);
    }

    /* DISCOVER — which feed files actually exist, without writing anything.
       nflverse team totals carry no EPA-allowed column, so NFL defence is the
       biggest hole in the football layer. A WEEKLY file with an opponent column
       would close it exactly: in any game, one team's offensive EPA IS the
       other team's defensive EPA allowed, so a season of weekly rows gives real
       defensive efficiency with no extra source and no approximation.
       Rather than guess an asset name and ship it, this reports which
       candidates respond and what columns they carry. */
    if (mode === 'discover') {
      const sp = chosen[0];
      const season = seasonFor(sp, new Date()) - 1;   // last completed season
      return json({ build: BUILD, sport: sp.label, ...(await discoverFeeds(sp, season)) });
    }

    /* PROBE — what does a feed actually return, without writing anything.
       Exists because assuming a feed's shape has cost this project a week
       twice now, and one read is cheaper than a deploy-and-see cycle. */
    if (mode === 'probe') {
      const sp = chosen[0];
      const dd = espnDate(new Date());
      const sched = await getJson(
        `https://site.api.espn.com/apis/site/v2/sports/${sp.espnSport}/${sp.espnLeague}/scoreboard?dates=${dd}&limit=200`);
      const season = seasonFor(sp, new Date());
      const eff = sp.slug === 'cbb'
        ? await getCsv(`https://barttorvik.com/trank.php?year=${season}&csv=1`)
        : sp.slug === 'nfl'
          ? await getCsv(`https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_reg_${season}.csv`)
          : { rows: [], report: { ok: false, error: 'no free efficiency feed for CFB without a CollegeFootballData key' } };
      return json({
        build: BUILD, sport: sp.label, season,
        schedule_feed: sched.report,
        schedule_events: (sched.json?.events ?? []).length,
        sample_event: sched.json?.events?.[0]
          ? {
            id: sched.json.events[0].id,
            name: sched.json.events[0].name,
            keys_on_competition: Object.keys(sched.json.events[0].competitions?.[0] ?? {}),
          } : null,
        efficiency_feed: (eff as any).report,
        efficiency_sample_columns: Object.keys(((eff as any).rows ?? [])[0] ?? {}),
      });
    }

    if (mode === 'health') {
      const out: any = { build: BUILD, checked_at: new Date().toISOString(), sports: {} };
      for (const sp of chosen) {
        const { count: games } = await sb.from('games')
          .select('*', { count: 'exact', head: true }).eq('sport_key', sp.key)
          .gte('game_date', new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10));
        const { count: tf } = await sb.from('team_features')
          .select('*', { count: 'exact', head: true }).eq('sport_key', sp.key)
          .gte('updated_at', new Date(Date.now() - 36 * 3600e3).toISOString());
        out.sports[sp.slug] = {
          games_last_2_days: games ?? 0, fresh_team_rows: tf ?? 0,
          verdict: (games ?? 0) === 0 ? 'NO GAMES — schedule feed is not writing'
            : (tf ?? 0) === 0 ? 'GAMES BUT NO TEAM ROWS — the efficiency tier is broken'
              : 'ok',
        };
      }
      return json(out);
    }

    const results: any[] = [];
    for (const sp of chosen) {
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() + i * 864e5);
        const date = d.toISOString().slice(0, 10);
        results.push(await ingestSport(sb, sp, date, seasonFor(sp, d)));
      }
    }
    const summary = {
      ok: true, build: BUILD,
      healthy: results.every((r) => r.healthy),
      warnings: results.flatMap((r) => r.warnings ?? []),
      results,
    };
    console.log('INGEST_MULTISPORT', JSON.stringify({ healthy: summary.healthy, warnings: summary.warnings }));
    return json(summary);
  } catch (e) {
    return json({ ok: false, build: BUILD, error: String(e) }, 500);
  }
});
