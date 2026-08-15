// ============================================================================
// EdgeDesk : model_predict tests / helpers
//
// Fakes for the three things the pipeline touches: PostgREST, an isolated
// Postgres schema, and a keyless HTTP provider. Nothing here reaches a network
// or a database, so the suite is runnable in CI and on a laptop.
// ============================================================================

import type { ModelDeps, SignalRow } from "../supabase/functions/model_predict/core/types.ts";
import { makeRng } from "../supabase/functions/model_predict/core/rng.ts";

export interface FakeOpts {
  /** path prefix (e.g. "signals?") -> rows */
  tables?: Record<string, any[]>;
  /** "schema:pathPrefix" -> rows */
  schemas?: Record<string, any[]>;
  /** url substring -> json */
  http?: Record<string, any>;
  /** paths that should throw, simulating a missing table or unexposed schema */
  missing?: string[];
  seed?: number;
  now?: Date;
  etDate?: string;
}

export interface FakeDeps extends ModelDeps {
  calls: string[];
}

function matchKeyed(map: Record<string, any[]>, path: string): any[] | undefined {
  let best: any[] | undefined;
  let bestLen = -1;
  for (const k of Object.keys(map)) {
    if (path.indexOf(k) === 0 && k.length > bestLen) {
      best = map[k];
      bestLen = k.length;
    }
  }
  return best;
}

/** PostgREST returns pages; the fakes honour limit/offset so pagination loops
 *  in the models are actually exercised rather than short-circuited. */
function paginate(rows: any[], path: string): any[] {
  const lim = /[?&]limit=(\d+)/.exec(path);
  const off = /[?&]offset=(\d+)/.exec(path);
  const o = off ? +off[1] : 0;
  const l = lim ? +lim[1] : rows.length;
  return rows.slice(o, o + l);
}

/** Apply the sport_key prefix filter and the commence_time window the runner
 *  asks for, the way PostgREST would. */
function filterSignals(rows: any[], path: string): any[] {
  const like = /sport_key=like\.([^&]*)/.exec(path);
  const gte = /commence_time=gte\.([^&]*)/.exec(path);
  const lte = /commence_time=lte\.([^&]*)/.exec(path);
  let out = rows;
  if (like) {
    const prefix = decodeURIComponent(like[1]).replace(/\*$/, "");
    out = out.filter((r) => String(r.sport_key ?? "").indexOf(prefix) === 0);
  }
  if (gte) {
    const lo = decodeURIComponent(gte[1]);
    out = out.filter((r) => !r.commence_time || String(r.commence_time) >= lo);
  }
  if (lte) {
    const hi = decodeURIComponent(lte[1]);
    out = out.filter((r) => !r.commence_time || String(r.commence_time) <= hi);
  }
  return out;
}

export function makeFakeDeps(opts: FakeOpts = {}): FakeDeps {
  const calls: string[] = [];
  const tables = opts.tables ?? {};
  const schemas = opts.schemas ?? {};
  const http = opts.http ?? {};
  const missing = new Set(opts.missing ?? []);

  const deps: FakeDeps = {
    calls,
    rng: makeRng(opts.seed ?? 12345),
    now: opts.now ?? new Date("2026-08-15T16:00:00.000Z"),
    etDate: opts.etDate ?? "2026-08-15",
    async sbGet(path: string) {
      calls.push("sbGet:" + path);
      for (const m of missing) if (path.indexOf(m) === 0) throw new Error(`sbGet 404 relation "${m}" does not exist`);
      let rows = matchKeyed(tables, path);
      if (!rows) return [];
      /* The signals read is the one place the runner relies on PostgREST doing
         real filtering, so the fake honours it. Without this, every sport would
         see every sport's rows and the isolation tests would prove nothing. */
      if (path.indexOf("signals?") === 0) rows = filterSignals(rows, path);
      return paginate(rows, path);
    },
    async sbGetSchema(schema: string, path: string) {
      calls.push(`sbGetSchema:${schema}:${path}`);
      for (const m of missing) if (`${schema}:${path}`.indexOf(m) === 0) throw new Error(`sbGet[${schema}] 404`);
      const rows = matchKeyed(schemas, `${schema}:${path}`);
      if (!rows) return [];
      return paginate(rows, path);
    },
    async jget(url: string) {
      calls.push("jget:" + url);
      for (const k of Object.keys(http)) if (url.indexOf(k) >= 0) return http[k];
      throw new Error("GET 404 " + url);
    },
    async pmap<T>(arr: T[], n: number, fn: (x: T) => Promise<void>) {
      for (let i = 0; i < arr.length; i += n) await Promise.all(arr.slice(i, i + n).map(fn));
    },
    log() {},
  };
  return deps;
}

let sigSeq = 0;

/** One captured signals row. Defaults are a realistic h2h quote. */
export function sig(over: Partial<SignalRow> & { event_id: string }): SignalRow {
  sigSeq++;
  return {
    sport_key: "baseball_mlb",
    sport_title: "MLB",
    market: "h2h",
    selection: over.home_team ?? "Home",
    point: null,
    sharp_fair: 0.5,
    best_dec: 2.0,
    best_book: "pinnacle",
    n_books: 8,
    commence_time: "2026-08-15T23:05:00Z",
    home_team: "Home",
    away_team: "Away",
    ...over,
  } as SignalRow;
}

/** h2h pair + a totals pair for one event, the shape capture actually writes. */
export function eventRows(
  eventId: string,
  home: string,
  away: string,
  commence: string,
  opts: { sportKey?: string; total?: number; sharpHome?: number; spread?: number } = {},
): SignalRow[] {
  const sk = opts.sportKey ?? "baseball_mlb";
  const rows: SignalRow[] = [
    sig({ event_id: eventId, sport_key: sk, market: "h2h", selection: home, home_team: home, away_team: away, commence_time: commence, sharp_fair: opts.sharpHome ?? 0.54, best_dec: 1.9 }),
    sig({ event_id: eventId, sport_key: sk, market: "h2h", selection: away, home_team: home, away_team: away, commence_time: commence, sharp_fair: 1 - (opts.sharpHome ?? 0.54), best_dec: 2.1 }),
  ];
  if (opts.total != null) {
    rows.push(
      sig({ event_id: eventId, sport_key: sk, market: "totals", selection: "Over", point: opts.total, home_team: home, away_team: away, commence_time: commence, sharp_fair: 0.5, best_dec: 1.95 }),
      sig({ event_id: eventId, sport_key: sk, market: "totals", selection: "Under", point: opts.total, home_team: home, away_team: away, commence_time: commence, sharp_fair: 0.5, best_dec: 1.95 }),
    );
  }
  if (opts.spread != null) {
    rows.push(
      sig({ event_id: eventId, sport_key: sk, market: "spreads", selection: home, point: opts.spread, home_team: home, away_team: away, commence_time: commence, sharp_fair: 0.5, best_dec: 1.91 }),
      sig({ event_id: eventId, sport_key: sk, market: "spreads", selection: away, point: -opts.spread, home_team: home, away_team: away, commence_time: commence, sharp_fair: 0.5, best_dec: 1.91 }),
    );
  }
  return rows;
}

/** A StatsAPI /schedule payload with the fields the MLB model reads. */
export function mlbSchedule(games: Array<{
  gamePk: number;
  gameDate: string;
  home: string;
  away: string;
  homeId: number;
  awayId: number;
  homePid?: number | null;
  awayPid?: number | null;
  state?: string;
  gameNumber?: number;
}>) {
  return {
    dates: [{
      games: games.map((g) => ({
        gamePk: g.gamePk,
        gameDate: g.gameDate,
        gameNumber: g.gameNumber ?? 1,
        status: { abstractGameState: g.state ?? "Preview" },
        teams: {
          home: { team: { id: g.homeId, name: g.home }, probablePitcher: g.homePid === null ? undefined : { id: g.homePid ?? 100 } },
          away: { team: { id: g.awayId, name: g.away }, probablePitcher: g.awayPid === null ? undefined : { id: g.awayPid ?? 200 } },
        },
      })),
    }],
  };
}

/** 30 synthetic teams with league-plausible totals, so leagueConstants() lands
 *  inside its own sanity bounds. */
export function mlbTeamPayloads(): { teams: any; hitting: any; pitching: any; ids: number[] } {
  const ids: number[] = [];
  for (let i = 1; i <= 30; i++) ids.push(i);
  return {
    ids,
    teams: { teams: ids.map((id) => ({ id, sport: { id: 1 }, active: true })) },
    hitting: { stats: [{ splits: [{ stat: { runs: 700, gamesPlayed: 162 } }] }] },
    pitching: {
      stats: [{
        splits: [{
          stat: {
            runs: 700, inningsPitched: "1450.0", earnedRuns: 645,
            strikeOuts: 1350, baseOnBalls: 480, hitBatsmen: 60, homeRuns: 185,
          },
        }],
      }],
    },
  };
}
