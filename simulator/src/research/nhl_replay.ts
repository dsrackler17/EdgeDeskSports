/* ===========================================================================
   THE NHL WALK-FORWARD, REPLAYED FOR THE SIMULATOR'S STUDIES.

   Reproduces the served model's out-of-sample record exactly as
   hockey/model/walkforward.js builds it, for the chosen candidate only
   (xg_core): one chronological ratings pass with the tuned hyperparameters
   (hockey/model/params/live.json ratings), per-season GLM fits on the five
   seasons before (trainRows), per-season pair recalibration on the three
   seasons before, per-season score effects (the committed
   hockey/model/params/effects_for_<season>.json) and overtime parameters
   (otParams on earlier seasons). The replay is checked against the
   committed record (hockey/validation/nhl_walkforward.json, by season) before
   any study reads it.

   FROZEN FORECASTS. A season-simulation forecast is made once, at an as-of
   date, for every remaining game. frozenForecasts() replays the ratings
   pass, stops before the first game day on which the clubs have played g
   games on average, and prices every remaining regular-season game of that
   season from that frozen state, with each game's back-to-back flags from
   the real schedule (as hockey/build_slate.js does). Two pricing variants:
     asof       every remaining game's ratings read at the as-of day
     game_date  each game's ratings decayed to its own date (the served
                ratings' 180-day half-life pulls a far-off game toward the
                league average)
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from '../sports/nfl/model_adapter.ts';
import { dayNum, type HockeyGame } from '../sports/nhl/history.ts';

const require = createRequire(import.meta.url);
const H = (f: string) => require(path.join(REPO, 'hockey', ...f.split('/')));

export const FIRST_SCORED = 2014;
export const MODEL = 'xg_core';

export interface ReplayGame extends HockeyGame { lh: number; la: number }
export interface Replay {
  seasons: number[];
  games: ReplayGame[];          // every completed game, chronological, with its point-in-time calibrated λ (seasons >= FIRST_SCORED)
  P: Record<number, { sw: any; ot: any; effects: any }>;
  fits: Record<number, any>;
  cal: Record<number, any>;
  ratings: any;
}

export function walkforwardReplay(lastSeason: number): Replay {
  const W = H('model/walkforward.js'), GLM = H('model/glm.js');
  const live = H('model/params/live.json');
  const seasons: number[] = []; for (let s = 2011; s <= lastSeason; s++) seasons.push(s);
  const { rows, games } = W.loadGames(seasons);
  const P = W.seasonParams(rows, seasons, false);
  const { snaps } = W.ratingsPass(games, P, live.ratings, null);
  const fits: Record<number, any> = {}, cal: Record<number, any> = {};
  const raw = new Map<number, { lh: number; la: number }>();
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    fits[S] = GLM.fit(W.trainRows(games, snaps, S), GLM.CANDIDATES[MODEL]);
    for (const g of games) if (g.season === S) { const sn = snaps.get(g.game_id); raw.set(g.game_id, { lh: GLM.predict(fits[S], sn.fh), la: GLM.predict(fits[S], sn.fa) }); }
  }
  for (const S of seasons.filter((s) => s >= FIRST_SCORED)) {
    const rowsCal = games.filter((g: any) => g.season >= Math.max(FIRST_SCORED, S - 3) && g.season < S && raw.has(g.game_id))
      .map((g: any) => ({ lh: raw.get(g.game_id)!.lh, la: raw.get(g.game_id)!.la, gh: g.reg_home, ga: g.reg_away }));
    cal[S] = GLM.fitPairCalibration(rowsCal);
  }
  const out: ReplayGame[] = games.map((g: any) => {
    const r = raw.get(g.game_id);
    if (!r) return Object.assign({}, g, { lh: NaN, la: NaN });
    const c = GLM.applyPairCalibration(r.lh, r.la, cal[g.season]);
    return Object.assign({}, g, { lh: c.lh, la: c.la });
  });
  return { seasons, games: out, P, fits, cal, ratings: live.ratings };
}

/** a deep copy of a hockey RatingState (Maps of accumulators), so a frozen state can be aged forward without touching the pass */
function cloneState(rs: any): any {
  const c = Object.create(Object.getPrototypeOf(rs));
  const acc = (a: any) => { const x = Object.create(Object.getPrototypeOf(a)); x.s = Object.assign({}, a.s); x.t = a.t; return x; };
  c.p = Object.assign({}, rs.p); c.sw = Object.assign({}, rs.sw);
  c.team = new Map([...rs.team].map(([k, v]: [string, any]) => [k, acc(v)]));
  c.goalie = new Map([...rs.goalie].map(([k, v]: [any, any]) => [k, acc(v)]));
  c.league = acc(rs.league);
  c.lastGame = new Map([...rs.lastGame].map(([k, v]: [string, any]) => [k, Object.assign({}, v)]));
  c.starts = new Map([...rs.starts].map(([k, v]: [string, any]) => [k, v.slice()]));
  c.b2bSecond = Object.assign({}, rs.b2bSecond);
  return c;
}

/** back-to-back flags of every game of a list, from the list's own dates (the schedule) */
export function scheduleB2b(games: Array<{ home: string; away: string; date: string }>, allDates: Map<string, number[]>): Array<[number, number]> {
  const prev = (team: string, d: number) => { let best: number | null = null; for (const x of allDates.get(team) || []) if (x < d) best = x; return best; };
  return games.map((g) => {
    const d = dayNum(g.date), ph = prev(g.home, d), pa = prev(g.away, d);
    return [ph != null && d - ph === 1 ? 1 : 0, pa != null && d - pa === 1 ? 1 : 0];
  });
}

export interface FrozenGame { game_id: number; home: string; away: string; date: string; lh: number; la: number; decided: string; hw: number; final_home: number; final_away: number }
export interface Frozen {
  season: number;
  checkpoint: number;
  as_of: string;
  mean_games_played: number;
  /** points per club in the games before the as-of date */
  points_so_far: Record<string, number>;
  remaining: FrozenGame[];
}

/**
 * Frozen forecasts of every remaining regular-season game, at each checkpoint
 * (clubs' mean games played) of each season, under one pricing variant.
 */
export function frozenForecasts(rep: Replay, seasons: number[], checkpoints: number[], variant: 'asof' | 'game_date'): Frozen[] {
  const GLM = H('model/glm.js');
  const { RatingState } = H('model/ratings.js');
  const rs = new RatingState(rep.ratings);
  const all = rep.games;
  /* the as-of date of each (season, checkpoint): the first game day on which mean games played >= checkpoint */
  const cut = new Map<string, { season: number; g: number }>();
  for (const S of seasons) {
    const reg = all.filter((x) => x.season === S && x.type === 'R');
    const nTeams = new Set(reg.map((x) => x.home)).size;
    let played = 0; const byDate = new Map<string, number>();
    for (const x of reg) byDate.set(x.date, (byDate.get(x.date) || 0) + 1);
    const dates = [...byDate.keys()].sort();
    const done = new Set<number>();
    for (const d of dates) {
      for (const g of checkpoints) if (!done.has(g) && (2 * played) / nTeams >= g) { cut.set(d, { season: S, g }); done.add(g); }
      played += byDate.get(d)!;
    }
  }
  const out: Frozen[] = [];
  let i = 0, curSeason: number | null = null;
  while (i < all.length) {
    const date = all[i].date; let j = i;
    while (j < all.length && all[j].date === date) j++;
    const day = all.slice(i, j);
    if (day[0].season !== curSeason) { curSeason = day[0].season; rs.sw = rep.P[curSeason].sw; }
    const hit = cut.get(date);
    if (hit) out.push(...freezeAt(hit.season, hit.g, date));
    for (const g of day) rs.absorb([(g as any).h, (g as any).a]);
    i = j;
  }
  return out;

  function freezeAt(S: number, g: number, asOf: string): Frozen[] {
    const reg = all.filter((x) => x.season === S && x.type === 'R');
    const before = reg.filter((x) => x.date < asOf), after = reg.filter((x) => x.date >= asOf);
    const pts: Record<string, number> = {};
    for (const x of reg) { pts[x.home] = pts[x.home] || 0; pts[x.away] = pts[x.away] || 0; }
    for (const x of before) { const w = x.hw === 1 ? x.home : x.away, l = x.hw === 1 ? x.away : x.home; pts[w] += 2; if (x.decided !== 'REG') pts[l] += 1; }
    const dates = new Map<string, number[]>();
    for (const x of reg) for (const t of [x.home, x.away]) { if (!dates.has(t)) dates.set(t, []); dates.get(t)!.push(dayNum(x.date)); }
    for (const v of dates.values()) v.sort((a, b) => a - b);
    const b2b = scheduleB2b(after, dates);
    const st = cloneState(rs);
    const remaining: FrozenGame[] = after.map((x, k) => {
      const at = variant === 'asof' ? asOf : x.date;
      const fh = st.snapshot(x.home, x.away, true, at, null), fa = st.snapshot(x.away, x.home, false, at, null);
      fh.b2b = b2b[k][0]; fh.b2b_opp = b2b[k][1]; fa.b2b = b2b[k][1]; fa.b2b_opp = b2b[k][0];
      const c = GLM.applyPairCalibration(GLM.predict(rep.fits[S], fh), GLM.predict(rep.fits[S], fa), rep.cal[S]);
      return { game_id: x.game_id, home: x.home, away: x.away, date: x.date, lh: c.lh, la: c.la, decided: x.decided, hw: x.hw, final_home: x.final_home, final_away: x.final_away };
    });
    const nTeams = Object.keys(pts).length;
    return [{ season: S, checkpoint: g, as_of: asOf, mean_games_played: (2 * before.length) / nTeams, points_so_far: pts, remaining }];
  }
}
