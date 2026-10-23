/* ===========================================================================
   NBA AVAILABILITY: who is missing at the as-of time, and when (if ever)
   each one plays again — from owned appearance data only.

   WHAT THE DATA CAN SAY. The committed box scores (sportsdataverse/hoopR,
   ESPN) list the players who DRESSED; a player on the inactive list is
   usually not in the box at all, so a "DNP - injury" row is rare (1,033 in
   all of 2025-26) and the reason for most absences is not observed. No
   injury report, return date or team timeline is committed (the official
   report is read into Supabase by the nba_injury_sync function and carries
   statuses, never dates). So an absence is defined the way the served
   model already sees it:

     TRACKED ABSENCE (team t, as-of time): a player whose most recent
     appearance (minutes played) anywhere was for t, in the current or the
     previous season, who did not play in t's latest game, and whose
     expected minutes when he plays (the player model's own EWM) are at
     least MIN_MINUTES. k = the number of t's games since his last
     appearance; carried = that appearance was in an earlier season.

   The served projected rotation (nba/model/players.js lastGamePlayers) is
   exactly the complement: everyone who played in the team's latest game.

   RETURN HAZARDS (Estimated, owned data). From every team game of the
   estimation seasons, the same definition gives an at-risk set before the
   game and an outcome: did the player play in it? A player who next appears
   for ANOTHER team never returns to t (traded, waived, signed elsewhere);
   one who never appears again never returns. The empirical hazard
   h(cell) = returns / at-risk is pooled in cells of (carried, minutes tier,
   games missed so far). The probability he first plays again in t's j-th
   remaining game is the product of survivals times the hazard; the mass
   left after the last game a team can play is "does not return this season".
   The reason for the absence is not known, so it is not used: the hazard is
   the average over injuries, rest, suspensions, personal leave, trades and
   releases, as the record mixes them.
   =========================================================================== */
import type { ReturnDistribution } from '../../core/hooks.ts';

export const MIN_MINUTES = 10;
/** the player model's minutes half-life in games (nba/model/players.js min_half_life) */
const MIN_HALF_LIFE = 8;
export const K_BINS: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [7, 9], [10, 14], [15, 24], [25, 39], [40, 59], [60, 9999]];
export const TIERS: Array<[number, number]> = [[MIN_MINUTES, 24], [24, 99]];
export const kBin = (k: number) => K_BINS.findIndex(([a, b]) => k >= a && k <= b);
export const tierOf = (m: number) => (m >= 24 ? 1 : 0);
export const cellKey = (carried: boolean, tier: number, k: number) => (carried ? 'C' : 'S') + tier + ':' + kBin(k);

export interface TeamGame { game_id: string; season: number; start_ms: number; team: string; players: Array<{ p: string; min: number }> }

/** every team's FINAL games of the given seasons, in start order, with who played (minutes > 0 or an appearance) */
export function teamGameLog(D: any, seasons: number[], before?: number): TeamGame[] {
  const out: TeamGame[] = [];
  for (const s of seasons) {
    const gs = D.games([s]).filter((g: any) => g.status === 'FINAL' && (before == null || g.start_ms < before));
    const pg = new Map<string, any[]>();
    for (const r of D.playerGames(s)) { if (!r.pl) continue; let a = pg.get(r.g); if (!a) pg.set(r.g, a = []); a.push(r); }
    for (const g of gs) {
      const rows = pg.get(g.game_id) || [];
      for (const t of [String(g.home_id), String(g.away_id)]) {
        out.push({ game_id: g.game_id, season: s, start_ms: g.start_ms, team: t, players: rows.filter((r) => String(r.tm) === t).map((r) => ({ p: String(r.p), min: Number(r.min) || 0 })) });
      }
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : a.game_id > b.game_id ? 1 : a.team < b.team ? -1 : 1));
  return out;
}

interface PState { team: string; season: number; idx: number; ewm: number; wsum: number }

/** the scan both the estimator and the as-of extraction use: one pass over team games in order */
export class AppearanceScan {
  /** player -> his last appearance (team, season, that team's game index) and minutes EWM */
  last = new Map<string, PState>();
  /** team -> number of its games seen so far */
  tgCount = new Map<string, number>();
  teamPlayers = new Map<string, Set<string>>();
  expMinutes(p: string): number { const s = this.last.get(p); return s && s.wsum > 0 ? s.ewm / s.wsum : 0; }
  /** the tracked absences of team t before its next game, in season `season` */
  absent(t: string, season: number): Array<{ p: string; k: number; carried: boolean; exp_min: number }> {
    const n = this.tgCount.get(t) || 0, out: Array<{ p: string; k: number; carried: boolean; exp_min: number }> = [];
    const set = this.teamPlayers.get(t); if (!set) return out;
    for (const p of set) {
      const s = this.last.get(p)!;
      if (s.team !== t || s.season < season - 1) continue;
      const k = n - s.idx;
      if (k < 1) continue;
      const m = s.ewm / s.wsum;
      if (m < MIN_MINUTES) continue;
      out.push({ p, k, carried: s.season < season, exp_min: m });
    }
    return out.sort((a, b) => b.exp_min - a.exp_min || (a.p < b.p ? -1 : 1));
  }
  /** absorb one team game (who played, minutes) */
  add(g: TeamGame): void {
    const n = (this.tgCount.get(g.team) || 0) + 1; this.tgCount.set(g.team, n);
    let set = this.teamPlayers.get(g.team); if (!set) this.teamPlayers.set(g.team, set = new Set());
    const a = Math.pow(0.5, 1 / MIN_HALF_LIFE);
    for (const x of g.players) {
      const prev = this.last.get(x.p);
      if (prev && prev.team !== g.team) { const ps = this.teamPlayers.get(prev.team); if (ps) ps.delete(x.p); }
      const s: PState = prev ? prev : { team: g.team, season: g.season, idx: n, ewm: 0, wsum: 0 };
      s.ewm = s.ewm * a + x.min; s.wsum = s.wsum * a + 1; s.team = g.team; s.season = g.season; s.idx = n;
      this.last.set(x.p, s); set.add(x.p);
    }
  }
}

export interface HazardTable {
  schema: 'edgedesk_nba_return_hazard_v1';
  estimation_seasons: number[];
  min_minutes: number;
  k_bins: Array<[number, number]>;
  tiers: Array<[number, number]>;
  /** cell -> [returns, at-risk] */
  cells: Record<string, [number, number]>;
  source: string;
}

/** estimate the hazards from the team games of `seasons` (the scan starts one season earlier so carried spells are seen) */
export function estimateHazards(D: any, seasons: number[]): HazardTable {
  const first = Math.min(...seasons), last = Math.max(...seasons);
  const log = teamGameLog(D, Array.from({ length: last - first + 2 }, (_, i) => first - 1 + i));
  const scan = new AppearanceScan(), cells: Record<string, [number, number]> = {};
  const want = new Set(seasons);
  for (const g of log) {
    if (want.has(g.season)) {
      const played = new Set(g.players.map((x) => x.p));
      for (const a of scan.absent(g.team, g.season)) {
        const key = cellKey(a.carried, tierOf(a.exp_min), a.k);
        const c = cells[key] || (cells[key] = [0, 0]);
        c[1]++; if (played.has(a.p)) c[0]++;
      }
    }
    scan.add(g);
  }
  return { schema: 'edgedesk_nba_return_hazard_v1', estimation_seasons: seasons.slice(), min_minutes: MIN_MINUTES, k_bins: K_BINS, tiers: TIERS, cells,
    source: 'nba/data/games + .cache/nba_work player_games (sportsdataverse/hoopR, ESPN box scores): appearances only' };
}

/** the hazard of a cell, pooled toward coarser cells when thin (at least `minN` at-risk observations) */
export function hazard(H: HazardTable, carried: boolean, tier: number, k: number, minN = 200): number {
  const c = H.cells[cellKey(carried, tier, k)];
  if (c && c[1] >= minN) return c[0] / c[1];
  /* pool the two tiers, then neighbouring k bins outward */
  let r = 0, n = 0; const b = kBin(k);
  for (let w = 0; w < K_BINS.length && n < minN; w++) {
    for (const bb of w === 0 ? [b] : [b - w, b + w]) {
      if (bb < 0 || bb >= K_BINS.length) continue;
      for (const tt of [0, 1]) { const x = H.cells[(carried ? 'C' : 'S') + tt + ':' + bb]; if (x) { r += x[0]; n += x[1]; } }
    }
  }
  if (!(n > 0)) throw new Error('no return-hazard evidence for ' + cellKey(carried, tier, k));
  return r / n;
}

/** the return distribution over the team's next `horizon` games (period j = its j-th game from now) */
export function returnDistribution(H: HazardTable, a: { k: number; carried: boolean; exp_min: number }, horizon: number, source: string): ReturnDistribution {
  const periods: Array<{ period: number; probability: number }> = [];
  let surv = 1;
  const tier = tierOf(a.exp_min);
  for (let j = 1; j <= horizon; j++) {
    const h = hazard(H, a.carried, tier, a.k + j - 1);
    const p = surv * h;
    if (p > 0) periods.push({ period: j, probability: p });
    surv *= 1 - h;
  }
  /* exact unit mass: the remainder is "does not return this season" */
  const tot = periods.reduce((x, q) => x + q.probability, 0);
  return { periods, out_for_season: Math.max(0, 1 - tot), source };
}
