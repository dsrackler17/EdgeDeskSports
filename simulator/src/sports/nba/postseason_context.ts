/* ===========================================================================
   THE SCHEDULE CONTEXT OF A POSTSEASON GAME THAT IS NOT ON THE SCHEDULE YET.

   The served model reads each club's rest, games in the last seven days,
   road-trip and home-stand length, travel, time-zone shift and the arena's
   altitude (nba/ingest/season.js computes them from the schedule). A
   play-in or playoff game exists on the schedule only once its pairing is
   set, so a season simulation needs those inputs for every pairing that
   could happen. They are ESTIMATED, from owned history only:

     rest, games in 7 days, road and home streaks
         the median of each (round, game number, host or visitor) cell over
         the 2021-22..2025-26 postseasons (nba/data/games + team_games), the
         games labelled by replaying each season's bracket (rules.ts) — so a
         Game 1 carries the typical gap since the previous series and a Game 2
         the typical day in between, as played;
     travel, time zone, altitude
         exact for the arenas: from the previous game's arena to this one
         (games 2-7 follow the 2-2-1-1-1 order; a series opener and a play-in
         game are reached from the club's own arena), by nba/lib/venues.js;
     back-to-back   0 (no postseason game in those seasons was played on
         consecutive days... checked: the median and the share are recorded);
     date           the median day offset of the cell from the last
         regular-season game day, at least one day after the as-of time.

   A postseason game that IS on the schedule is priced by the pass from its
   real row instead (inputs.ts). Nothing here changes a regular-season game.
   =========================================================================== */
import { League, Standings, seedConferences, playPostseason, rulesFor, type NbaTeam, type NbaGame, type PlayedGame, type Round } from './rules.ts';
import { streamFor, STREAM } from '../../core/prng.ts';

export interface SideCtx { rest_days: number; games_7d: number; road_streak: number; home_streak: number; b2b: number }
export interface CtxCell { home: SideCtx; away: SideCtx; n: number; day_offset: number; b2b_share: number; pooled: string | null }
export interface ContextTable {
  schema: 'edgedesk_nba_postseason_context_v1';
  seasons: number[];
  /** key: 'play_in:7v8' | 'play_in:9v10' | 'play_in:last' | '<round>:<game_no>' */
  cells: Record<string, CtxCell>;
  source: string;
}
export const contextKey = (round: Round, key: string, gameNo: number) => (round === 'play_in' ? 'play_in:' + key : round + ':' + gameNo);

const median = (xs: number[]) => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

/** label every observed postseason game of a season with its round, play-in key and game number */
export function labelPostseason(D: any, teams: NbaTeam[], S: number): Array<{ game: any; round: Round; key: string; game_no: number }> {
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.id] = i; });
  const all = D.games([S]).filter((g: any) => g.status === 'FINAL');
  const reg = all.filter((g: any) => g.type === 'R' && g.scope === 'regular_season');
  const games: NbaGame[] = reg.map((g: any) => ({ game_id: g.game_id, home: ix[g.home_id], away: ix[g.away_id], done: true, home_score: g.hs, away_score: g.as }));
  const L = new League(teams, games);
  const st = new Standings(L, new Int16Array(games.map((g) => (g.home_score as number) - (g.away_score as number))), { rng: streamFor(0n, 0, STREAM.coin), diag() {}, flag() {}, trace() {} }, rulesFor(S));
  const post = all.filter((g: any) => g.type === 'I' || g.type === 'P').sort((a: any, b: any) => a.start_ms - b.start_ms);
  const observed: PlayedGame[] = post.map((g: any) => ({ stage: g.type === 'I' ? 'play_in' : 'playoffs', home: ix[g.home_id], away: ix[g.away_id], winner: g.hs > g.as ? ix[g.home_id] : ix[g.away_id], game_id: g.game_id }));
  const res = playPostseason(st, seedConferences(st), () => { throw new Error('season ' + S + ': a postseason game is missing from the record'); }, observed);
  const out: Array<{ game: any; round: Round; key: string; game_no: number }> = [];
  const byPair = (stage: string, h: number, a: number) => post.filter((g: any) => (stage === 'play_in' ? g.type === 'I' : g.type === 'P') && ((ix[g.home_id] === h && ix[g.away_id] === a) || (ix[g.home_id] === a && ix[g.away_id] === h)));
  for (const p of res.playIn) out.push({ game: byPair('play_in', p.home, p.away)[0], round: 'play_in', key: p.key, game_no: 1 });
  for (const s of res.series) byPair('playoffs', s.high, s.low).forEach((g: any, i: number) => out.push({ game: g, round: s.round, key: s.round, game_no: i + 1 }));
  return out;
}

export function estimateContexts(D: any, teams: NbaTeam[], seasons: number[]): ContextTable {
  const acc: Record<string, { h: SideCtx[]; a: SideCtx[]; off: number[] }> = {};
  for (const S of seasons) {
    const tg = new Map<string, any>(D.teamGames([S]).map((r: any) => [r.game_id + '|' + r.team_id, r]));
    const reg = D.games([S]).filter((g: any) => g.type === 'R' && g.scope === 'regular_season' && g.status === 'FINAL');
    const lastDay = Math.max(...reg.map((g: any) => Date.parse(g.date + 'T00:00:00Z')));
    for (const x of labelPostseason(D, teams, S)) {
      const k = contextKey(x.round, x.key, x.game_no);
      const c = acc[k] || (acc[k] = { h: [], a: [], off: [] });
      const side = (tid: string): SideCtx => { const r = tg.get(x.game.game_id + '|' + tid); if (!r) throw new Error('no team-game row for ' + x.game.game_id); return { rest_days: Math.min(4, Math.max(0, Number(r.rest_days))), games_7d: Number(r.games_7d) || 0, road_streak: Number(r.road_streak) || 0, home_streak: Number(r.home_streak) || 0, b2b: Number(r.b2b) || 0 }; };
      c.h.push(side(String(x.game.home_id))); c.a.push(side(String(x.game.away_id)));
      c.off.push(Math.round((Date.parse(x.game.date + 'T00:00:00Z') - lastDay) / 864e5));
    }
  }
  const med = (xs: SideCtx[]): SideCtx => ({ rest_days: median(xs.map((x) => x.rest_days)), games_7d: Math.round(median(xs.map((x) => x.games_7d))), road_streak: Math.round(median(xs.map((x) => x.road_streak))), home_streak: Math.round(median(xs.map((x) => x.home_streak))), b2b: 0 });
  const cells: Record<string, CtxCell> = {};
  for (const ck of contextKeys()) {
    const k = contextKey(ck.round, ck.key, ck.game_no);
    let c = acc[k], pooled: string | null = null;
    /* a thin cell (fewer than MIN_CELL games) takes the round's late games (5-7), then games 2-7 */
    if (!c || c.h.length < MIN_CELL) {
      for (const lo of [5, 2]) {
        if (ck.round === 'play_in' || ck.game_no < lo) continue;
        const ks = [1, 2, 3, 4, 5, 6, 7].filter((n) => n >= lo).map((n) => contextKey(ck.round, ck.key, n)).filter((x) => acc[x]);
        const h = ks.flatMap((x) => acc[x].h), a = ks.flatMap((x) => acc[x].a);
        if (h.length >= MIN_CELL) { c = { h, a, off: c ? c.off : ks.flatMap((x) => acc[x].off) }; pooled = 'games ' + lo + '-7 of the round'; break; }
      }
    }
    if (!c || !c.h.length) throw new Error('no postseason history for ' + k);
    const b2b = c.h.concat(c.a).filter((x) => x.b2b).length / (2 * c.h.length);
    cells[k] = { home: med(c.h), away: med(c.a), n: c.h.length, day_offset: Math.round(median(c.off)), b2b_share: Math.round(b2b * 1e4) / 1e4, pooled };
  }
  return { schema: 'edgedesk_nba_postseason_context_v1', seasons: seasons.slice(), cells, source: 'nba/data/games + nba/data/team_games, postseasons ' + seasons[0] + '-' + seasons[seasons.length - 1] + ' (labelled by simulator/src/sports/nba/rules.ts playPostseason)' };
}
export const MIN_CELL = 5;

/** every postseason context the format can produce, in the order the pair table stores them */
export function contextKeys(): Array<{ round: Round; key: string; game_no: number }> {
  const out: Array<{ round: Round; key: string; game_no: number }> = [];
  for (const k of ['7v8', '9v10', 'last']) out.push({ round: 'play_in', key: k, game_no: 1 });
  for (const r of ['first_round', 'conference_semifinals', 'conference_finals', 'finals'] as Round[]) for (let n = 1; n <= 7; n++) out.push({ round: r, key: r, game_no: n });
  return out;
}
