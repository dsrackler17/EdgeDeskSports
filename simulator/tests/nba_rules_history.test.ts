/* NBA rules against history: every season 2006-07..2025-26 (except the 2019-20 restart), from the
   committed results (nba/data/games, sportsdataverse/hoopR, ESPN). The regular season gives the
   standings, the tiebreakers and the seeds; then EVERY real play-in and playoff game is fed to the
   postseason state machine as observed, with a resolver that throws if it is ever asked: so each
   play-in pairing and host, each series pairing, the host of every game (the home-court club and the
   home pattern), every series ending at four wins and the champion must be exactly what happened.
   Two mutants must fail: place-by-place restart (2008-09) and a 2-3-2 first round. */
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { League, Standings, seedConferences, playPostseason, rulesFor, type NbaGame, type PlayedGame, type NbaRulesVersion } from '../src/sports/nba/rules.ts';
import { NBA_TEAMS } from '../src/sports/nba/config.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';

const require = createRequire(import.meta.url);
const D = require('../../nba/lib/data.js');
const T = kit('NBA rules vs history 2006-07..2025-26');
const ix: Record<string, number> = {}; NBA_TEAMS.forEach((t, i) => { ix[t.id] = i; });
const code = (i: number) => NBA_TEAMS[i].code;
export const HISTORY_SEASONS = [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];

/** the place-by-place mutant: after a step names a best GROUP, only the next place is decided and the eliminated clubs come back */
class PlaceByPlace extends Standings {
  override rankTied(set: number[], mode: string): number[] {
    if (set.length <= 1) return set.slice();
    let S = set.slice();
    for (;;) {
      const sp = (this as any).split(S, mode) as { best: number[]; rest: number[] } | null;
      if (!sp) { const w = S[0]; return [w].concat(this.rankTied(set.filter((x) => x !== w), mode)); }
      if (sp.best.length === 1) { const w = sp.best[0]; return [w].concat(this.rankTied(set.filter((x) => x !== w), mode)); }
      S = sp.best;
    }
  }
}

interface Replay { ok: boolean; err: string | null; champion: number | null; observed: number; seeds: number[][]; playIn: string[]; draws: number; steps: Record<string, number> }
function replay(S0: number, rulesOverride?: (r: NbaRulesVersion) => NbaRulesVersion, Cls: typeof Standings = Standings): Replay {
  const rules = rulesOverride ? rulesOverride(rulesFor(S0)) : rulesFor(S0);
  const all = D.games([S0]).filter((g: any) => g.status === 'FINAL');
  const reg = all.filter((g: any) => g.type === 'R' && g.scope === 'regular_season');
  const games: NbaGame[] = reg.map((g: any) => ({ game_id: g.game_id, home: ix[g.home_id], away: ix[g.away_id], done: true, home_score: g.hs, away_score: g.as }));
  const L = new League(NBA_TEAMS, games);
  const steps: Record<string, number> = {}; let draws = 0;
  const st = new Cls(L, new Int16Array(games.map((g) => (g.home_score as number) - (g.away_score as number))),
    { rng: streamFor(1n, 0, STREAM.coin), diag: (k) => { steps[k] = (steps[k] || 0) + 1; }, flag: (k) => { if (k === 'tiebreak_random_drawing') draws++; }, trace() {} }, rules);
  st.decideDivisions();
  const cs = seedConferences(st);
  const post = all.filter((g: any) => g.type === 'I' || g.type === 'P').sort((a: any, b: any) => a.start_ms - b.start_ms);
  const observed: PlayedGame[] = post.map((g: any) => ({ stage: g.type === 'I' ? 'play_in' : 'playoffs', home: ix[g.home_id], away: ix[g.away_id], winner: g.hs > g.as ? ix[g.home_id] : ix[g.away_id], game_id: g.game_id }));
  try {
    const res = playPostseason(st, cs, () => { throw new Error('the state machine asked for a game that was not played'); }, observed);
    return { ok: true, err: null, champion: res.champion, observed: observed.length, seeds: res.seeds, playIn: res.playIn.map((p) => p.conference + ' ' + p.key + ' ' + code(p.home) + '-' + code(p.away)), draws, steps };
  } catch (e) { return { ok: false, err: (e as Error).message, champion: null, observed: observed.length, seeds: [], playIn: [], draws, steps }; }
}

let totalGames = 0, totalPlayIn = 0, tieSteps = 0;
for (const S of HISTORY_SEASONS) {
  const r = replay(S);
  const post = D.games([S]).filter((g: any) => g.status === 'FINAL' && (g.type === 'I' || g.type === 'P')).sort((a: any, b: any) => a.start_ms - b.start_ms);
  const last = post[post.length - 1];
  const actualChampion = last.hs > last.as ? ix[last.home_id] : ix[last.away_id];
  T.chk(S + ' (' + rulesFor(S).id + '): every play-in and playoff game fits the bracket, its host and the four-win end', r.ok, r.err);
  T.chk(S + ': the champion is the winner of the last game played (' + code(actualChampion) + ')', r.champion === actualChampion, r.champion == null ? null : code(r.champion));
  T.chk(S + ': no random drawing was needed', r.draws === 0, r.draws);
  T.chk(S + ': 8 playoff clubs per conference, each once', r.seeds.length === 2 && r.seeds.every((s) => s.length === 8 && new Set(s).size === 8));
  const playIn = post.filter((g: any) => g.type === 'I').length;
  T.eq(S + ': play-in games played', playIn, rulesFor(S).play_in ? 6 : 0);
  totalGames += r.observed; totalPlayIn += playIn;
  for (const [k, v] of Object.entries(r.steps)) if (!k.endsWith('tied_groups')) tieSteps += v;
}
T.chk('postseason games replayed (play-in + playoffs)', totalGames > 1600 && totalPlayIn === 36, [totalGames, totalPlayIn]);
T.chk('tied groups broken along the way (the steps that decided them)', tieSteps > 60, tieSteps);

/* the 2008-09 three-way tie (DEN, POR, SA at 54-28): the division-winner step eliminates POR */
{
  const r = replay(2009);
  T.eq('2008-09 West seeds 2-4: DEN, SA, POR (the league\'s order)', r.seeds[1].slice(1, 4).map(code), ['DEN', 'SA', 'POR']);
  const m = replay(2009, undefined, PlaceByPlace);
  T.chk('MUTANT place-by-place restart: 2008-09 no longer reproduces', !m.ok, m.err);
  const ok = HISTORY_SEASONS.filter((s) => s !== 2009).every((s) => replay(s, undefined, PlaceByPlace).ok);
  T.chk('  ... (every other season is blind to the difference)', ok);
}
/* a 2-3-2 first round cannot be the format of any season */
{
  const fails = HISTORY_SEASONS.filter((s) => !replay(s, (r) => ({ ...r, home_games: { ...r.home_games, first_round: [1, 2, 6, 7] } })).ok);
  T.eq('MUTANT 2-3-2 first round: every season fails', fails.length, HISTORY_SEASONS.length);
  const finals = HISTORY_SEASONS.filter((s) => s >= 2014 && !replay(s, (r) => ({ ...r, home_games: { ...r.home_games, finals: [1, 2, 6, 7] } })).ok);
  T.chk('MUTANT 2-3-2 Finals from 2013-14: the seasons whose Finals reached game 5 fail', finals.length >= 6, finals);
  const noSeedBlock = [2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015].filter((s) => !replay(s, (r) => ({ ...r, division_seed_block: 0 })).ok);
  T.chk('MUTANT no division-winner seed block before 2015-16: some season fails', noSeedBlock.length >= 1, noSeedBlock);
  const noPlayIn = [2021, 2022, 2023, 2024, 2025, 2026].filter((s) => !replay(s, (r) => ({ ...r, play_in: false, direct_seeds: 8 })).ok);
  T.eq('MUTANT no play-in from 2020-21: every season fails', noPlayIn.length, 6);
}
/* "playoff clubs" for steps 5-6: history cannot tell the definitions apart (recorded, not claimed) */
{
  const same = [6, 8, 10, 12].map((p) => [2021, 2022, 2023, 2024, 2025, 2026].every((s) => replay(s, (r) => ({ ...r, tiebreak_playoff_place: p })).ok));
  T.eq('playoff-club place 6, 8, 10 or 12: every play-in season reproduces under each (the definition is not identified by history)', same, [true, true, true, true]);
}

process.exit(T.done());
