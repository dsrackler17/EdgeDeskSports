/* ===========================================================================
   Completed NHL seasons from the committed team-game table
   (hockey/data/team_games, compiled by hockey/ingest/team_games.js from the
   NHL's public game feeds), in the shape the rules engine reads. Used by the
   history test and the research replays; never by a production run.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from '../nfl/model_adapter.ts';
import { NhlLeague, NhlStandings, nhlRulesFor, resultCode, type NhlTeam, type ObservedPlayoffGame, type GameGoals, type TieContext } from './rules.ts';
import { nhlAlignment, teamsFromAlignment } from './config.ts';

const require = createRequire(import.meta.url);

export const dayNum = (date: string) => Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5);

export interface HockeyGame {
  game_id: number; season: number; type: string; date: string; start_utc: string;
  home: string; away: string; final_home: number; final_away: number; reg_home: number; reg_away: number; decided: string; hw: number;
}
let W: any = null;
/** hockey/model/walkforward.js (loadGames, seasonParams, ratingsPass, ...) */
export function hockeyWalkforward(): any {
  if (!W) W = require(path.join(REPO, 'hockey', 'model', 'walkforward.js'));
  return W;
}
/** every completed game of the given seasons (regular season and playoffs), chronological */
export function loadHockeyGames(seasons: number[]): HockeyGame[] {
  return hockeyWalkforward().loadGames(seasons).games as HockeyGame[];
}

export interface SeasonReplay {
  season: number;
  teams: NhlTeam[];
  L: NhlLeague;
  results: Int8Array;
  goals: GameGoals;
  observed: ObservedPlayoffGame[];
  standings: (ctx: TieContext) => NhlStandings;
}

/** one completed season, from its games, under its own alignment and rules version */
export function replaySeason(season: number, games: HockeyGame[]): SeasonReplay {
  const teams = teamsFromAlignment(nhlAlignment(season));
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const reg = games.filter((g) => g.season === season && g.type === 'R');
  for (const g of reg) if (ix[g.home] == null || ix[g.away] == null) throw new Error(season + ': ' + g.home + '-' + g.away + ' not in the alignment');
  const L = new NhlLeague(teams, reg.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayNum(g.date) })));
  const results = new Int8Array(reg.length);
  const goals: GameGoals = { home: new Int16Array(reg.length), away: new Int16Array(reg.length) };
  reg.forEach((g, k) => {
    results[k] = resultCode(g.decided, g.hw === 1);
    goals.home[k] = g.final_home; goals.away[k] = g.final_away;
  });
  const observed = games.filter((g) => g.season === season && g.type === 'P').map((g) => ({
    a: ix[g.home], b: ix[g.away], home: ix[g.home], winner: g.hw === 1 ? ix[g.home] : ix[g.away], ot: g.decided !== 'REG', day: dayNum(g.date)
  }));
  const rules = nhlRulesFor(season);
  return { season, teams, L, results, goals, observed, standings: (ctx) => new NhlStandings(L, rules, results, () => goals, ctx) };
}
