// EdgeDesk MLB Engine · ingest_mlb Edge Function
// LIVE adapters:
//   • schedule + finals  — MLB StatsAPI (no key)          -> games (+ probable pitchers)
//   • odds               — The Odds API (ODDS_API_KEY)    -> market_features (open + close)
//   • pitching           — Baseball Savant CSV (no key)   -> pitcher_features
//   • offense            — MLB StatsAPI team hitting      -> offense_features
//   • weather            — Open-Meteo (no key)            -> weather_features
// Secrets: `supabase secrets set ODDS_API_KEY=...`   (SUPABASE_* are auto-injected)
// Manual: POST /functions/v1/ingest_mlb {"date":"YYYY-MM-DD"}
//         POST {"date":"YYYY-MM-DD","backfill":7}   re-runs the last N days
//         GET  ?mode=health                          is the pipeline alive today?
//
// ─────────────────────────────────────────────────────────────────────────────
// FIVE BUGS FIXED IN THIS REVISION
//
// 1. ONE FAILURE KILLED THE WHOLE RUN
//    ingestSchedule() was the only adapter not wrapped in .catch(). It throws on
//    any non-200 from StatsAPI, so a single upstream blip returned 500 and NOTHING
//    was written — not odds, not offense, not weather. Every adapter is now
//    isolated and reports its own {ok, rows, error}, so a bad day degrades to a
//    partial slate instead of an empty one.
//
// 2. SAVANT COLUMN RESOLUTION CORRUPTED STATS  (the xERA bug)
//    col() returned the first header *containing* the needle that parsed as a
//    number. When a pitcher's `xera` cell was blank it fell through to
//    `era_minus_xera_diff` and stored the DIFF as the xERA — e.g. -0.62. Column
//    lookup is now exact-name-first, and any *_diff / *_minus_* header is
//    excluded from fuzzy matching entirely.
//
// 3. SILENT SAVANT FAILURE
//    Both Savant fetches were wrapped in bare `catch (_) {}`, so a changed URL or
//    a 403 produced zero stats with no trace — exactly the failure mode that let
//    pitcher_features go stale unnoticed. HTTP status, byte count and parsed row
//    count are now reported per leaderboard.
//
// 4. WEATHER COULD NEVER RUN FOR A NEW PARK
//    ingestSchedule wrote park_static stubs with only {park_id, name}, and
//    ingestWeather requires lat/lon — so a stub park was skipped forever. Venue
//    coordinates are now hydrated from StatsAPI and written with the stub.
//
// 5. PROBABLE PITCHERS WERE NEVER BACKFILLED
//    Probables are announced through the day. The upsert also lacked an explicit
//    conflict target. Both fixed: onConflict 'game_id,side', and the schedule
//    adapter re-runs cleanly so a late-named starter is picked up on the next pass.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'jsr:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ODDS_KEY = Deno.env.get('ODDS_API_KEY') ?? '';
const gid = (pk: number | string) => `MLB-${pk}`;
const todayUTC = () => new Date().toISOString().slice(0, 10);
const UA = { 'User-Agent': 'EdgeDesk/1.0 (contact: ops@edgedesk)', 'Accept': 'application/json,text/csv,*/*' };

// ---------- tiny helpers ----------
const num = (v: any) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null; };

/**
 * CSV -> rows.
 *
 * BUG FIX: the previous version stripped surrounding quotes from HEADERS but not
 * from VALUES. Savant quotes any cell it feels like, and parseFloat('"5.41"') is
 * NaN — so a quoted number resolved to null and the stat vanished with no error.
 * Quotes are now unwrapped on both, with the CSV "" escape handled.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/); if (lines.length < 2) return [];
  const split = (l: string) => { // handles quoted "last, first"
    const out: string[] = []; let cur = '', q = false;
    for (const c of l) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c; }
    out.push(cur); return out;
  };
  const clean = (s: string) => s.trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim();
  const head = split(lines[0]).map(clean);
  return lines.slice(1).map(l => {
    const c = split(l); const o: Record<string, string> = {};
    head.forEach((h, i) => o[h] = clean(c[i] ?? ''));
    return o;
  });
}

/**
 * BUG 2 FIX — column lookup that cannot substitute a derived column for a base one.
 *
 * Savant's expected_statistics CSV carries `era`, `xera` AND `era_minus_xera_diff`.
 * The old fuzzy-only lookup returned the first header *containing* the needle that
 * parsed as a number, so a blank `xera` silently resolved to the diff column and a
 * nonsense value (-0.62) was stored as the pitcher's xERA.
 *
 * Order is now: exact header match, then prefix match, then contains — and any
 * header that looks derived (*_diff, *_minus_*, *_percentile) is never eligible
 * for a fuzzy match. A blank cell returns null, which is the correct answer.
 */
export function col(row: Record<string, string>, needles: string[]): number | null {
  const keys = Object.keys(row);
  const derived = (k: string) => /(_diff|_minus_|percentile|_rank)/.test(k.toLowerCase());

  for (const n of needles) {
    const lower = n.toLowerCase();
    const exact = keys.find(k => k.toLowerCase() === lower);
    if (exact) return num(row[exact]);            // blank -> null, and we stop here
  }
  for (const n of needles) {
    const lower = n.toLowerCase();
    const pref = keys.find(k => !derived(k) && k.toLowerCase().startsWith(lower));
    if (pref) return num(row[pref]);
  }
  for (const n of needles) {
    const lower = n.toLowerCase();
    const has = keys.find(k => !derived(k) && k.toLowerCase().includes(lower));
    if (has) return num(row[has]);
  }
  return null;
}

const americanFromProb = (p: number) => p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
const impliedProb = (ml: number) => ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);

async function getText(u: string, ms = 20000): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(u, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    const text = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, text };
  } catch (e) { return { ok: false, status: 0, text: '', error: String(e) }; }
}

// ---------- StatsAPI team map (name<->abbr<->id), used by odds + offense ----------
async function teamMaps(season: number) {
  const r = await fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${season}`, { headers: UA });
  const d = await r.json();
  const teams = (d.teams ?? []).map((t: any) => ({
    abbr: t.abbreviation, id: t.id,
    name: (t.name ?? '').toLowerCase(), nick: (t.teamName ?? '').toLowerCase(),
  }));
  const abbrToId = new Map<string, number>(teams.map((t: any) => [t.abbr, t.id]));
  const resolve = (s: string): string | undefined => {
    const q = (s ?? '').toLowerCase().trim();
    let t = teams.find((t: any) => t.name === q);                       // exact full name
    if (!t) t = teams.find((t: any) => t.nick && q.endsWith(t.nick));   // "... Athletics"
    if (!t) t = teams.find((t: any) => t.nick && q.includes(t.nick));   // contains nickname
    return t?.abbr;
  };
  return { resolve, abbrToId };
}

// ---------- 1. schedule + finals + probable pitchers ----------
async function ingestSchedule(sb: any, date: string) {
  // BUG 4 FIX: hydrate venue location so park_static gets real coordinates and
  // the weather adapter is not permanently skipped for that park.
  const u = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`
    + `&hydrate=probablePitcher,team,venue(location),linescore`;
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(`statsapi ${r.status}`);
  const games = ((await r.json()).dates?.[0]?.games ?? []);
  const season = Number(date.slice(0, 4));
  let upserted = 0, finals = 0, pitchers = 0; const errors: string[] = [];

  // park stubs WITH coordinates, to satisfy the games.park_id FK and feed weather
  const parks = new Map<string, any>();
  for (const g of games) {
    const t = g.teams?.home?.team;
    const a = t?.abbreviation ?? String(t?.id ?? '');
    if (!a) continue;
    const c = g.venue?.location?.defaultCoordinates;
    parks.set(a, {
      park_id: a, name: g.venue?.name ?? a,
      ...(c?.latitude != null ? { lat: c.latitude } : {}),
      ...(c?.longitude != null ? { lon: c.longitude } : {}),
    });
  }
  let parkRows = 0;
  if (parks.size) {
    // no ignoreDuplicates: coordinates must land on rows stubbed by earlier runs
    const { error } = await sb.from('park_static').upsert([...parks.values()], { onConflict: 'park_id' });
    if (error) errors.push(`park_static: ${error.message}`); else parkRows = parks.size;
  }

  for (const g of games) {
    const home = g.teams?.home, away = g.teams?.away;
    const homeAbbr = home?.team?.abbreviation ?? String(home?.team?.id ?? '');
    const awayAbbr = away?.team?.abbreviation ?? String(away?.team?.id ?? '');
    const isFinal = g.status?.abstractGameState === 'Final' || g.status?.codedGameState === 'F';
    const home_won = isFinal && home?.score != null && away?.score != null ? Number(home.score) > Number(away.score) : null;
    if (isFinal) finals++;

    const { error } = await sb.from('games').upsert({
      game_id: gid(g.gamePk), game_date: date, season, home_team: homeAbbr, away_team: awayAbbr,
      park_id: homeAbbr, start_time: g.gameDate ?? null, status: isFinal ? 'final' : 'scheduled', home_won,
    }, { onConflict: 'game_id' });
    if (error) { if (errors.length < 5) errors.push(`games: ${error.message}`); continue; }
    upserted++;

    // BUG 5 FIX: explicit conflict target so a re-run updates rather than duplicating,
    // which is what lets a late-announced starter get picked up by a later pass.
    for (const side of ['home', 'away'] as const) {
      const pp = g.teams?.[side]?.probablePitcher;
      if (!pp?.id) continue;
      const { error: pe } = await sb.from('pitcher_features').upsert(
        { game_id: gid(g.gamePk), side, pitcher_id: String(pp.id), name: pp.fullName ?? null },
        { onConflict: 'game_id,side' },
      );
      if (pe) { if (errors.length < 5) errors.push(`pitcher_features: ${pe.message}`); continue; }
      pitchers++;
    }
  }
  return {
    games: games.length, upserted, finals, probable_pitchers: pitchers, parks: parkRows,
    ...(errors.length ? { errors } : {}),
  };
}

// ---------- 2. odds -> market_features (open first run, close on later runs) ----------
async function ingestOdds(sb: any, date: string) {
  if (!ODDS_KEY) return { note: 'ODDS_API_KEY not set' };
  const season = Number(date.slice(0, 4));
  const { resolve } = await teamMaps(season);
  const r = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?regions=us&markets=h2h&oddsFormat=american&apiKey=${ODDS_KEY}`, { headers: UA });
  if (!r.ok) return { error: `odds-api ${r.status}` };
  const events = await r.json();
  const { data: myGames } = await sb.from('games').select('game_id,home_team,away_team,start_time').eq('game_date', date);
  const byHome = new Map<string, any[]>();
  for (const g of (myGames ?? [])) { const arr = byHome.get(g.home_team) ?? []; arr.push(g); byHome.set(g.home_team, arr); }
  let updated = 0, unresolved = 0, not_today = 0, overflow = 0;

  for (const ev of events ?? []) {
    const homeAbbr = resolve(ev.home_team);
    if (!homeAbbr) { unresolved++; continue; }
    const pool: any[] | undefined = byHome.get(homeAbbr);
    if (!pool) { not_today++; continue; }
    if (pool.length === 0) { overflow++; continue; }

    const evTime = new Date(ev.commence_time).getTime();
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const st = pool[i].start_time ? new Date(pool[i].start_time).getTime() : NaN;
      const diff = Number.isFinite(st) ? Math.abs(st - evTime) : Infinity;
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    const myGame: any = pool[bestIdx];
    pool.splice(bestIdx, 1);

    const homeFair: number[] = [];
    for (const bk of ev.bookmakers ?? []) {
      const h2h = (bk.markets ?? []).find((m: any) => m.key === 'h2h'); if (!h2h) continue;
      const oh = h2h.outcomes?.find((o: any) => o.name === ev.home_team)?.price;
      const oa = h2h.outcomes?.find((o: any) => o.name === ev.away_team)?.price;
      if (oh == null || oa == null) continue;
      const ph = impliedProb(oh), pa = impliedProb(oa); if (ph + pa === 0) continue;
      homeFair.push(ph / (ph + pa));
    }
    if (!homeFair.length) continue;
    const mean = homeFair.reduce((s, x) => s + x, 0) / homeFair.length;
    const sd = Math.sqrt(homeFair.reduce((s, x) => s + (x - mean) ** 2, 0) / homeFair.length);
    const homeMl = americanFromProb(mean), awayMl = americanFromProb(1 - mean);

    const { data: existing } = await sb.from('market_features').select('consensus_home_ml').eq('game_id', myGame.game_id).maybeSingle();
    const row: any = {
      game_id: myGame.game_id, home_close_ml: homeMl, away_close_ml: awayMl,
      book_disagreement: Number(sd.toFixed(4)), closed_at: new Date().toISOString(),
    };
    if (!existing || existing.consensus_home_ml == null) { row.consensus_home_ml = homeMl; row.consensus_away_ml = awayMl; }
    const { error } = await sb.from('market_features').upsert(row, { onConflict: 'game_id' });
    if (!error) updated++;
  }
  return { books_games_matched: updated, not_today, unresolved, overflow };
}

// ---------- 3. pitching -> pitcher_features -------------------------------
// Two tiers, and the second is why this now fills the table even on a bad day.
//   Statcast : Baseball Savant CSV  -> xERA, xwOBA, barrel%, hard-hit%, whiff%
//   Line     : MLB StatsAPI         -> ERA, WHIP, K%, BB%, FIP, workload
// Savant changes its leaderboard URLs periodically and has no contract with
// anyone. When it breaks, the old code wrote nothing and the whole matchup
// layer went dark — which is exactly what happened on 19 July. Now the
// traditional line lands regardless, so a Savant outage costs the Statcast
// columns and nothing else.
const IP_NUM = (v: any) => {                 // "121.2" is 121 innings and TWO OUTS
  const t = String(v ?? '').trim(); if (!t) return null;
  const m = t.match(/^(\d+)(?:\.(\d))?$/);
  return m ? parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 3 : 0) : num(t);
};

async function ingestPitching(sb: any, date: string) {
  const year = Number(date.slice(0, 4));
  const feeds: Record<string, any> = {};
  const stats = new Map<string, any>();
  const put = (id: string, k: string, v: number | null) => {
    if (v == null || !id) return; const o = stats.get(id) ?? {}; o[k] = v; stats.set(id, o);
  };

  /* ---- tier 1: Statcast ---- */
  const expUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${year}&position=&team=&filterType=bip&min=1&csv=true`;
  const rateUrl = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&filter=&min=1&selections=player_id,k_percent,bb_percent,barrel_batted_rate,hard_hit_percent,whiff_percent&csv=true`;

  const exp = await getText(expUrl);
  feeds.expected_statistics = { ok: exp.ok, status: exp.status, bytes: exp.text.length, ...(exp.error ? { error: exp.error } : {}) };
  if (exp.ok) {
    const rows = parseCsv(exp.text);
    feeds.expected_statistics.rows = rows.length;
    feeds.expected_statistics.columns = rows.length ? Object.keys(rows[0]).slice(0, 24) : [];
    for (const row of rows) {
      const id = String(col(row, ['player_id']) ?? ''); if (!id) continue;
      put(id, 'xera', col(row, ['xera']));
      put(id, 'xwoba_against', col(row, ['est_woba']));
    }
  }
  const rate = await getText(rateUrl);
  feeds.custom = { ok: rate.ok, status: rate.status, bytes: rate.text.length, ...(rate.error ? { error: rate.error } : {}) };
  if (rate.ok) {
    const rows = parseCsv(rate.text);
    feeds.custom.rows = rows.length;
    feeds.custom.columns = rows.length ? Object.keys(rows[0]).slice(0, 24) : [];
    for (const row of rows) {
      const id = String(col(row, ['player_id']) ?? ''); if (!id) continue;
      put(id, 'k_pct', col(row, ['k_percent']));
      put(id, 'bb_pct', col(row, ['bb_percent']));
      put(id, 'barrel_pct', col(row, ['barrel_batted_rate', 'barrel']));
      put(id, 'hardhit_pct', col(row, ['hard_hit_percent', 'hard_hit']));
      put(id, 'whiff_pct', col(row, ['whiff_percent', 'whiff']));
    }
  }
  feeds.statcast_players = stats.size;

  /* ---- who is starting today ---- */
  const ids = await todaysGameIds(sb, date);
  if (!ids.length) {
    return { feeds, statcast_players: stats.size, pitchers_updated: 0,
      error: 'no games rows for this date — the schedule adapter has to run first' };
  }
  const { data: pf } = await sb.from('pitcher_features').select('game_id,side,pitcher_id,name').in('game_id', ids);
  const starters = (pf ?? []).filter((r: any) => r.pitcher_id != null);
  if (!starters.length) {
    return { feeds, statcast_players: stats.size, pitchers_updated: 0,
      error: 'no probable pitchers on file for this date yet' };
  }

  /* ---- tier 2: the traditional line, for every starter, from StatsAPI ----
     Fetched in small batches with the season stats separated from the game
     logs: a combined hydrate returns a partial payload, which looks identical
     to missing data and is how most starters end up with no line at all. */
  const line = new Map<string, any>(), logs = new Map<string, any[]>(), hand = new Map<string, string>();
  const idList = starters.map((r: any) => String(r.pitcher_id));
  for (let i = 0; i < idList.length; i += 12) {
    const batch = idList.slice(i, i + 12).join(',');
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${batch}&hydrate=stats(group=[pitching],type=[season],season=${year})`, { headers: UA });
      if (!r.ok) continue;
      for (const p of (await r.json()).people ?? []) {
        if (p.pitchHand?.code) hand.set(String(p.id), p.pitchHand.code);
        const sp = p.stats?.find((x: any) => x.group?.displayName === 'pitching')?.splits?.[0];
        if (sp?.stat) line.set(String(p.id), sp.stat);
      }
    } catch (_) { /* keep whatever landed */ }
  }
  for (let i = 0; i < idList.length; i += 6) {
    const batch = idList.slice(i, i + 6).join(',');
    try {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/people?personIds=${batch}&hydrate=stats(group=[pitching],type=[gameLog],season=${year})`, { headers: UA });
      if (!r.ok) continue;
      for (const p of (await r.json()).people ?? []) {
        const gl = p.stats?.find((x: any) => x.type?.displayName === 'gameLog');
        if (gl) logs.set(String(p.id), gl.splits ?? []);
      }
    } catch (_) { /* workload is context, not the read */ }
  }
  feeds.statsapi_lines = line.size;
  feeds.statsapi_logs = logs.size;

  /* ---- the FIP constant, SOLVED from league totals in this same run ----
     Hardcoding 3.10 would be a quiet fudge. Deriving it means every FIP stored
     is reproducible from data captured at the same moment. */
  let cFIP: number | null = null;
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/teams/stats?season=${year}&stats=season&group=pitching&sportIds=1`, { headers: UA });
    if (r.ok) {
      let hr = 0, bb = 0, hbp = 0, so = 0, ip = 0, er = 0, teams = 0;
      for (const st of (await r.json()).stats ?? []) for (const sp of st.splits ?? []) {
        const s2 = sp.stat ?? {}, i = IP_NUM(s2.inningsPitched); if (i == null) continue;
        hr += num(s2.homeRuns) ?? 0; bb += num(s2.baseOnBalls) ?? 0; hbp += num(s2.hitBatsmen) ?? 0;
        so += num(s2.strikeOuts) ?? 0; er += num(s2.earnedRuns) ?? 0; ip += i; teams++;
      }
      if (ip > 0 && teams >= 20) cFIP = (9 * er) / ip - ((13 * hr + 3 * (bb + hbp) - 2 * so) / ip);
    }
  } catch (_) { /* no constant, no FIP — never an assumed one */ }
  feeds.fip_constant = cFIP == null ? 'unavailable — FIP not computed' : +cFIP.toFixed(3);

  /* ---- write ---- */
  let updated = 0, withStatcast = 0, withLine = 0;
  const nowIso = new Date().toISOString();
  for (const row of starters) {
    const key = String(row.pitcher_id);
    const sc = stats.get(key) ?? null;
    const ln = line.get(key) ?? null;
    const ip = ln ? IP_NUM(ln.inningsPitched) : null;
    const bf = ln ? num(ln.battersFaced) : null;
    const so = ln ? num(ln.strikeOuts) : null, bb = ln ? num(ln.baseOnBalls) : null;
    const hr = ln ? num(ln.homeRuns) : null, hbp = ln ? (num(ln.hitBatsmen) ?? 0) : 0;
    const fip = (cFIP != null && ip && hr != null && bb != null && so != null)
      ? +(((13 * hr + 3 * (bb + hbp) - 2 * so) / ip) + cFIP).toFixed(2) : null;

    const starts = (logs.get(key) ?? []).filter((g: any) => num(g.stat?.gamesStarted) === 1)
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))).slice(0, 3);
    const lastStart = starts[0]?.date ? String(starts[0].date).slice(0, 10) : null;
    const rest = lastStart
      ? Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(lastStart + 'T00:00:00Z')) / 86400000) : null;

    const patch: any = {
      // Statcast half. K%/BB% prefer Savant; StatsAPI over batters faced is the
      // fallback so the field is populated either way.
      xera: sc?.xera ?? null, xwoba_against: sc?.xwoba_against ?? null,
      barrel_pct: sc?.barrel_pct ?? null, hardhit_pct: sc?.hardhit_pct ?? null,
      whiff_pct: sc?.whiff_pct ?? null,
      k_pct: sc?.k_pct ?? (bf && so != null ? +(so / bf * 100).toFixed(1) : null),
      bb_pct: sc?.bb_pct ?? (bf && bb != null ? +(bb / bf * 100).toFixed(1) : null),
      // traditional half
      throws: hand.get(key) ?? null,
      era: ln ? num(ln.era) : null, whip: ln ? num(ln.whip) : null,
      fip, fip_constant: cFIP == null ? null : +cFIP.toFixed(3),
      hr_per_9: (ip && hr != null) ? +((9 * hr) / ip).toFixed(2) : null,
      k_bb_ratio: ln ? num(ln.strikeoutWalkRatio) : null,
      ground_to_air: ln ? num(ln.groundOutsToAirouts) : null,
      strike_pct: ln ? num(ln.strikePercentage) : null,
      pitches_per_inning: ln ? num(ln.pitchesPerInning) : null,
      innings: ip == null ? null : +ip.toFixed(1),
      batters_faced: bf, games_started: ln ? num(ln.gamesStarted) : null,
      // workload
      last_start: lastStart, days_rest: (rest != null && rest >= 0) ? rest : null,
      recent_starts: starts.length ? starts.map((g: any) => ({
        date: String(g.date).slice(0, 10), innings: g.stat?.inningsPitched ?? null,
        pitches: num(g.stat?.numberOfPitches), earned_runs: num(g.stat?.earnedRuns),
        strikeouts: num(g.stat?.strikeOuts), walks: num(g.stat?.baseOnBalls),
      })) : null,
      // provenance, so a null is readable as "this feed was down" not "unknown"
      quality_source: sc ? 'baseball_savant' : null,
      line_source: ln ? 'mlb_statsapi' : null,
      updated_at: nowIso,
    };
    const { error } = await sb.from('pitcher_features').update(patch)
      .eq('game_id', row.game_id).eq('side', row.side);
    if (error) continue;
    updated++; if (sc) withStatcast++; if (ln) withLine++;
  }

  const missing = starters.filter((r: any) => !stats.get(String(r.pitcher_id)) && !line.get(String(r.pitcher_id)))
    .map((r: any) => r.name).slice(0, 10);
  return {
    feeds, statcast_players: stats.size, starters: starters.length,
    pitchers_updated: updated, with_statcast: withStatcast, with_line: withLine,
    ...(missing.length ? { no_data_for: missing } : {}),
  };
}

// ---------- 4. offense -> offense_features (StatsAPI team hitting, no key) -------
// Now stores the PLATOON SPLITS alongside the season line. A right-hander does
// not face a lineup's overall numbers, he faces its numbers against
// right-handers, and storing only the overall line throws that away on every
// row. Three requests instead of one; the splits are the single most
// matchup-relevant field in the table.
async function ingestOffense(sb: any, date: string) {
  const season = Number(date.slice(0, 4));
  const { abbrToId } = await teamMaps(season);

  const pull = async (sit?: string) => {
    const u = sit
      ? `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&stats=statSplits&group=hitting&sitCodes=${sit}&sportIds=1`
      : `https://statsapi.mlb.com/api/v1/teams/stats?season=${season}&stats=season&group=hitting&sportIds=1`;
    try {
      const r = await fetch(u, { headers: UA });
      if (!r.ok) return { by: new Map<number, any>(), error: `HTTP ${r.status}` };
      const by = new Map<number, any>();
      for (const st of (await r.json()).stats ?? []) for (const sp of st.splits ?? []) {
        if (sp.team?.id != null) by.set(sp.team.id, sp.stat ?? {});
      }
      return { by, error: null as string | null };
    } catch (e) { return { by: new Map<number, any>(), error: String(e) }; }
  };

  const shape = (st: any) => {
    if (!st) return null;
    const avg = num(st.avg), slg = num(st.slg), pa = num(st.plateAppearances);
    return {
      avg, obp: num(st.obp), slg, ops: num(st.ops),
      iso: (slg != null && avg != null) ? +(slg - avg).toFixed(3) : null,
      k_pct: (pa && num(st.strikeOuts) != null) ? +(num(st.strikeOuts)! / pa * 100).toFixed(1) : null,
      bb_pct: (pa && num(st.baseOnBalls) != null) ? +(num(st.baseOnBalls)! / pa * 100).toFixed(1) : null,
      runs_per_game: num(st.gamesPlayed) ? +((num(st.runs) ?? 0) / num(st.gamesPlayed)!).toFixed(2) : null,
      home_runs: num(st.homeRuns), plate_appearances: pa,
    };
  };

  const all = await pull(), vl = await pull('vl'), vr = await pull('vr');
  const { data: games } = await sb.from('games').select('game_id,home_team,away_team').eq('game_date', date);
  const nowIso = new Date().toISOString();
  let updated = 0, unmatched = 0, withSplits = 0;

  for (const g of games ?? []) {
    for (const [side, abbr] of [['home', g.home_team], ['away', g.away_team]] as const) {
      const id = abbrToId.get(abbr) ?? -1;
      const base = shape(all.by.get(id));
      if (!base) { unmatched++; continue; }
      const L = shape(vl.by.get(id)), R = shape(vr.by.get(id));
      const { error } = await sb.from('offense_features').upsert({
        game_id: g.game_id, side,
        obp: base.obp, iso: base.iso, k_pct: base.k_pct, runs_per_game: base.runs_per_game,
        avg: base.avg, slg: base.slg, ops: base.ops, bb_pct: base.bb_pct,
        home_runs: base.home_runs, plate_appearances: base.plate_appearances,
        vs_lhp: L, vs_rhp: R,           // null here means the split was not retrievable
        source: 'mlb_statsapi', updated_at: nowIso,
      }, { onConflict: 'game_id,side' });
      if (error) continue;
      updated++; if (L || R) withSplits++;
    }
  }
  return {
    teams: all.by.size, offense_rows: updated, rows_with_splits: withSplits,
    splits: { vs_lhp: vl.by.size, vs_rhp: vr.by.size, ...(vl.error || vr.error ? { error: vl.error ?? vr.error } : {}) },
    ...(all.error ? { error: all.error } : {}),
    ...(unmatched ? { unmatched_teams: unmatched } : {}),
  };
}

// ---------- 5. weather (Open-Meteo, needs park lat/lon) ----------
async function ingestWeather(sb: any, date: string) {
  const { data: rows } = await sb.from('games').select('game_id, park_id').eq('game_date', date).eq('status', 'scheduled');
  let done = 0, no_coords = 0;
  const missing: string[] = [];
  for (const row of rows ?? []) {
    const { data: park } = await sb.from('park_static').select('lat,lon,cf_azimuth').eq('park_id', row.park_id).maybeSingle();
    if (!park?.lat || !park?.lon) {
      no_coords++;
      if (missing.length < 8 && !missing.includes(row.park_id)) missing.push(row.park_id);
      continue;
    }
    const wr = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${park.lat}&longitude=${park.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`, { headers: UA });
    if (!wr.ok) continue;
    const w = (await wr.json()).current ?? {};
    const windVsCf = park.cf_azimuth != null && w.wind_direction_10m != null ? ((w.wind_direction_10m - park.cf_azimuth + 540) % 360) - 180 : null;
    const { error } = await sb.from('weather_features').upsert(
      { game_id: row.game_id, temp_f: w.temperature_2m, humidity_pct: w.relative_humidity_2m, wind_mph: w.wind_speed_10m, wind_dir_vs_cf: windVsCf },
      { onConflict: 'game_id' },
    );
    if (!error) done++;
  }
  return { weather_rows: done, ...(no_coords ? { parks_without_coords: no_coords, missing_coords_for: missing } : {}) };
}

async function todaysGameIds(sb: any, date: string): Promise<string[]> {
  const { data } = await sb.from('games').select('game_id').eq('game_date', date);
  return (data ?? []).map((g: any) => g.game_id);
}

/* BUG 1 FIX — every adapter runs isolated. One upstream failure can no longer
   take the whole ingestion down, which is what turned a transient StatsAPI blip
   into weeks of an empty `games` table. */
async function runAdapter<T>(name: string, fn: () => Promise<T>): Promise<any> {
  const t0 = Date.now();
  try { return { ok: true, ms: Date.now() - t0, ...(await fn() as any) }; }
  catch (e) {
    console.log('ADAPTER FAILED', JSON.stringify({ adapter: name, error: String(e) }));
    return { ok: false, ms: Date.now() - t0, error: String(e) };
  }
}

async function ingestOneDay(sb: any, date: string) {
  const schedule = await runAdapter('schedule', () => ingestSchedule(sb, date));
  const odds = await runAdapter('odds', () => ingestOdds(sb, date));
  const pitching = await runAdapter('pitching', () => ingestPitching(sb, date));
  const offense = await runAdapter('offense', () => ingestOffense(sb, date));
  const weather = await runAdapter('weather', () => ingestWeather(sb, date));

  // A run that wrote no games is a failure worth shouting about, not a quiet 200.
  const healthy = schedule.ok && (schedule.upserted ?? 0) > 0;
  const warnings: string[] = [];
  if (!healthy) warnings.push('schedule wrote 0 games — every downstream adapter is starved until this is fixed');
  if (pitching.ok && (pitching.pitchers_updated ?? 0) === 0 && (schedule.probable_pitchers ?? 0) > 0) {
    warnings.push('probables exist but no pitcher stats were applied — check the savant feeds block');
  }
  if ((weather.parks_without_coords ?? 0) > 0) {
    warnings.push('some parks have no lat/lon in park_static — weather is skipped for those games');
  }
  return { date, healthy, ...(warnings.length ? { warnings } : {}), schedule, odds, pitching, offense, weather };
}

/* HEALTH — one call that answers "is this pipeline alive and complete today".
   The July outage lasted three weeks because nothing ever surfaced it: the cron
   returned 200, the table quietly stopped filling, and the only symptom was an
   AI answer saying data was unavailable. This turns that into a number anyone
   can check, and something a monitor can alert on. GET ?mode=health */
async function health(sb: any, date: string) {
  const out: any = { date, checked_at: new Date().toISOString() };
  const count = async (table: string, filter: (q: any) => any) => {
    try { const { count: c, error } = await filter(sb.from(table).select('*', { count: 'exact', head: true }));
      return error ? { error: error.message } : c ?? 0; } catch (e) { return { error: String(e) }; }
  };
  const ids = await todaysGameIds(sb, date);
  out.games_today = ids.length;

  if (ids.length) {
    const { data: pf } = await sb.from('pitcher_features')
      .select('pitcher_id,name,xera,era,updated_at').in('game_id', ids);
    const rows = pf ?? [];
    out.starters_on_file = rows.length;
    out.with_statcast = rows.filter((r: any) => r.xera != null).length;
    out.with_line = rows.filter((r: any) => r.era != null).length;
    out.missing_both = rows.filter((r: any) => r.xera == null && r.era == null).map((r: any) => r.name).slice(0, 10);
    out.last_written = rows.map((r: any) => r.updated_at).filter(Boolean).sort().slice(-1)[0] ?? null;

    const { data: off } = await sb.from('offense_features').select('side,obp,vs_lhp').in('game_id', ids);
    out.offense_rows = (off ?? []).length;
    out.offense_with_splits = (off ?? []).filter((r: any) => r.vs_lhp != null).length;

    const { data: mk } = await sb.from('market_features').select('game_id').in('game_id', ids);
    out.market_rows = (mk ?? []).length;
    const { data: wx } = await sb.from('weather_features').select('game_id').in('game_id', ids);
    out.weather_rows = (wx ?? []).length;
  }

  const problems: string[] = [];
  if (!out.games_today) problems.push('no games rows for this date — the schedule adapter is not writing');
  if (out.games_today && !out.starters_on_file) problems.push('games exist but no probable pitchers are on file');
  if (out.starters_on_file && !out.with_line) problems.push('starters on file but no traditional line — the StatsAPI tier is failing');
  if (out.starters_on_file && !out.with_statcast) problems.push('no Statcast on any starter — the Savant tier is failing (check the leaderboard URLs)');
  if (out.offense_rows && !out.offense_with_splits) problems.push('offense rows carry no platoon splits — the statSplits call is failing');
  out.healthy = problems.length === 0;
  out.problems = problems;
  out.summary = problems.length
    ? `${problems.length} problem(s): ${problems[0]}`
    : `complete: ${out.with_line}/${out.starters_on_file} lines, ${out.with_statcast}/${out.starters_on_file} Statcast, ${out.offense_with_splits}/${out.offense_rows} offense splits`;
  return out;
}

Deno.serve(async (req) => {
  try {
    let body: any = {}; try { body = await req.json(); } catch { body = {}; }
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const date = body.date ?? params.date ?? todayUTC();
    if ((body.mode ?? params.mode) === 'health') {
      return json(await health(createClient(url, serviceKey), date), 200);
    }
    const backfill = Math.max(0, Math.min(14, Number(body.backfill ?? params.backfill ?? 0)));
    const sb = createClient(url, serviceKey);

    if (!backfill) {
      const out = await ingestOneDay(sb, date);
      console.log('INGEST', JSON.stringify({ date, healthy: out.healthy, warnings: out.warnings ?? [] }));
      return json(out, 200);
    }

    // Backfill: recover a gap without hand-running one date at a time.
    const days: any[] = [];
    for (let i = 0; i < backfill; i++) {
      const d = new Date(Date.parse(date + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10);
      days.push(await ingestOneDay(sb, d));
    }
    return json({ backfill: backfill, healthy: days.every(d => d.healthy), days }, 200);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
