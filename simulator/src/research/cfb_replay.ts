/* ===========================================================================
   THE SERVED CFB ENGINE, REPLAYED COLD OVER HISTORY — the forecasts every
   CFB simulator study scores.

   Exactly the walk-forward of football/cfb_p4/research/backtest_engine.js:
   the rating state starts zeroed eight seasons before the first scored season
   (the shipped seeds already contain the results being projected), every
   game is projected from the state BEFORE it and only then absorbed, in
   kickoff order, with a season break between seasons. No play-level
   efficiency is fed (the backtest's optional team_game.csv is not rebuilt
   here), so the matchup term reports itself unavailable — the same engine,
   one input fewer, stated in CFB_SIMULATOR_NOTES.md.

   Two kinds of forecast are recorded:
     pre      the next-game number: projected from the state one game before
              kickoff (what the board publishes the week of the game)
     frozen   the SEASON-SIMULATOR number: the state is frozen after week K
              of the regular season and every remaining regular-season game
              of that season is priced from the frozen state, however many
              weeks ahead it is. This is the probability a season simulation
              consumes, and the one whose calibration matters here.
   Conference championship games are excluded from `frozen` (their pairing
   is not known at the as-of date). FBS-vs-FCS games are kept and labelled.

   Output (gitignored cache): simulator/.cache/cfb_replay_rows.json
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, loadCfbEngine, loadSeasonFeedSync, priceBare, type FeedGame } from '../sports/cfb/engine_adapter.ts';

export const REPLAY_CACHE = path.join(REPO, 'simulator', '.cache', 'cfb_replay_rows.json');
/** [season, kind 0=pre 1=frozen, asOfWeek, week, home, away, homeFbs, awayFbs, neutral, fair, sigma, pHome, margin, homeConf, awayConf, gameId, postseason] */
export type ReplayRow = [number, 0 | 1, number, number, string, string, 0 | 1, 0 | 1, 0 | 1, number, number, number, number, string, string, string, 0 | 1];

export interface ReplayOptions { from: number; to: number; replayFrom?: number; asOfWeeks: number[]; captureRatings?: boolean }
/** frozen ratings, keyed 'season:asOfWeek' -> feed team name -> the engine's blended rating at the freeze */
export type FrozenRatings = Record<string, Record<string, number>>;
export const isCcg = (g: FeedGame) => !!g.notes && /championship/i.test(g.notes) && !/playoff|bowl/i.test(g.notes);

export function replayCfb(o: ReplayOptions, log: (s: string) => void = () => {}): { rows: ReplayRow[]; model_version: string; refused: Record<string, number>; ratings: FrozenRatings } {
  const eng = loadCfbEngine(), E = eng.E, P = eng.P;
  const replayFrom = o.replayFrom ?? o.from - 8;
  const games: FeedGame[] = [];
  for (let y = replayFrom; y <= o.to; y++) games.push(...loadSeasonFeedSync(y));
  games.sort((a, b) => (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week) || a.game_id.localeCompare(b.game_id));
  const st = E.strength.newState();
  st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
  st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
  st.lmeanPts = P.rating.league_mean_pts;
  st.season = replayFrom;
  const rows: ReplayRow[] = [], refused: Record<string, number> = {}, ratings: FrozenRatings = {};
  const isFbs = (d: string) => d === 'fbs';
  const bySeason = new Map<number, FeedGame[]>();
  for (const g of games) { let a = bySeason.get(g.season); if (!a) { a = []; bySeason.set(g.season, a); } a.push(g); }
  let season = replayFrom;
  const frozenDone = new Set<string>();
  const freeze = (S: number, K: number) => {
    const key = S + ':' + K;
    if (frozenDone.has(key)) return;
    frozenDone.add(key);
    const snap = structuredClone(st);
    if (o.captureRatings) {
      const r: Record<string, number> = {};
      for (const g of bySeason.get(S) || []) for (const [t, d] of [[g.home, g.home_division], [g.away, g.away_division]] as Array<[string, string]>) {
        if (d !== 'fbs' || t in r) continue;
        const b = E.strength.blendedRating(snap, E.normKey(t), true, K + 1, null);
        if (b && Number.isFinite(b.value)) r[t] = Math.round(b.value * 1e4) / 1e4;
      }
      ratings[S + ':' + K] = r;
    }
    for (const g of bySeason.get(S) || []) {
      if (g.season_type !== 'regular' || g.week <= K || !g.completed || isCcg(g)) continue;
      if (!isFbs(g.home_division) && !isFbs(g.away_division)) continue;
      const p = priceBare(eng, snap, S, K + 1, { home: g.home, away: g.away, home_fbs: isFbs(g.home_division), away_fbs: isFbs(g.away_division), neutral: g.neutral, home_conference: g.home_conference, away_conference: g.away_conference });
      if (p.status !== 'PREDICTED') { refused['frozen:' + p.status] = (refused['frozen:' + p.status] || 0) + 1; continue; }
      rows.push([S, 1, K, g.week, g.home, g.away, isFbs(g.home_division) ? 1 : 0, isFbs(g.away_division) ? 1 : 0, g.neutral ? 1 : 0, p.fair, p.sigma, p.p_home,
        (g.home_points as number) - (g.away_points as number), g.home_conference, g.away_conference, g.game_id, 0]);
    }
  };
  for (const g of games) {
    if (g.season !== season) {
      /* a season that ended before the last as-of week was reached (e.g. 2020) freezes nothing more */
      season = g.season;
      E.ingest.seasonBreak(st);
      log('season ' + season + ' · rows ' + rows.length);
    }
    const scored = g.season >= o.from && g.season <= o.to;
    if (scored) for (const K of o.asOfWeeks) if (g.season_type !== 'regular' || g.week > K) freeze(g.season, K);
    if (!g.completed) continue;
    const hf = isFbs(g.home_division), af = isFbs(g.away_division);
    if (scored && (hf || af)) {
      const p = priceBare(eng, st, g.season, g.week, { home: g.home, away: g.away, home_fbs: hf, away_fbs: af, neutral: g.neutral, home_conference: g.home_conference, away_conference: g.away_conference });
      if (p.status === 'PREDICTED') rows.push([g.season, 0, 0, g.week, g.home, g.away, hf ? 1 : 0, af ? 1 : 0, g.neutral ? 1 : 0, p.fair, p.sigma, p.p_home,
        (g.home_points as number) - (g.away_points as number), g.home_conference, g.away_conference, g.game_id, g.season_type === 'regular' ? 0 : 1]);
      else refused['pre:' + p.status] = (refused['pre:' + p.status] || 0) + 1;
    }
    E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: hf, away_fbs: af, neutral_site: g.neutral, home_points: g.home_points, away_points: g.away_points, team_stats: null });
  }
  return { rows, model_version: eng.model_version, refused, ratings };
}

export function cachedReplay(o: ReplayOptions, log: (s: string) => void = () => {}): { rows: ReplayRow[]; model_version: string; refused: Record<string, number>; ratings: FrozenRatings } {
  const key = JSON.stringify(o);
  if (fs.existsSync(REPLAY_CACHE)) {
    const c = JSON.parse(fs.readFileSync(REPLAY_CACHE, 'utf8'));
    if (c.key === key && c.model_version === loadCfbEngine().model_version) return c;
  }
  const r = replayCfb(o, log);
  fs.mkdirSync(path.dirname(REPLAY_CACHE), { recursive: true });
  fs.writeFileSync(REPLAY_CACHE, JSON.stringify({ key, ...r }));
  return r;
}
