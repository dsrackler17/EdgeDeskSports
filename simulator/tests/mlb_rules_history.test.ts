/* MLB rules against history: every season 2012-2025 except 2020.
   The standings, the tiebreak procedure, qualification, the seeds, the bracket, the series lengths,
   the host of every postseason game and the World Series home-field rule are recomputed from the
   regular-season game logs alone; the postseason that actually happened (Retrosheet) must be
   exactly the one the engine's bracket produces: same pairings, same host for every game, same
   number of games, every logged game used once. */
import { kit } from './_kit.ts';
import { teamsFor, formatFor } from '../src/sports/mlb/config.ts';
import { Season, Standings, qualify, playPostseason, type RegGame } from '../src/sports/mlb/rules.ts';
import { loadRegularSeason, loadPostseason, dayOf } from '../src/sports/mlb/history.ts';

const K = kit('MLB rules vs history 2012-2025 (ex 2020)');
const post = loadPostseason().games;
const SEASONS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025];
const ties: Record<number, string[]> = {};

for (const season of SEASONS) {
  const teams = teamsFor(season), fmt = formatFor(season);
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const { games, dropped } = loadRegularSeason(season);
  if (season === 2024) K.eq('2024: the three resumed suspended games are counted once', dropped.length, 3);
  const reg: RegGame[] = games.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayOf(g.date), game_no: g.game_no }));
  K.chk(season + ': every club is configured', games.every((g) => ix[g.home] != null && ix[g.away] != null));
  const S = new Season(teams, reg);
  const win = Int8Array.from(games.map((g) => (g.hs > g.as ? 1 : g.hs < g.as ? -1 : 0)));
  const used: string[] = [];
  const st = new Standings(S, win, { rng: null, diag: (k) => { if (k.startsWith('tiebreak:step:')) used.push(k.slice(14)); } });
  const seeds = qualify(st, fmt);
  ties[season] = used;
  const actual = post.filter((g) => g.season === season);
  const consumed = new Set<number>();
  const problems: string[] = [];
  const res = playPostseason(st, fmt, seeds, (spec, k, home, away) => {
    const i = actual.findIndex((g, j) => !consumed.has(j) && g.round === spec.round && g.series_game === k &&
      ((g.home === teams[home].code && g.away === teams[away].code) || (g.home === teams[away].code && g.away === teams[home].code)));
    if (i < 0) { problems.push(spec.id + ' game ' + k + ': ' + teams[home].code + ' v ' + teams[away].code + ' never played'); return home; }
    consumed.add(i);
    const g = actual[i];
    if (g.home !== teams[home].code) problems.push(spec.id + ' game ' + k + ': hosted by ' + g.home + ', engine says ' + teams[home].code);
    return g.hs > g.as ? ix[g.home] : ix[g.away];
  });
  K.eq(season + ': every postseason pairing and every host matches Retrosheet', problems, []);
  K.eq(season + ': every logged postseason game is in the engine bracket (' + actual.length + ')', consumed.size, actual.length);
  K.chk(season + ': one champion', res.champion >= 0 && res.series.length === (fmt.id === 'MLB-2022' ? 11 : 9));
  const seedCodes = seeds.map((L) => L.league + ' ' + L.seeds.map((t) => teams[t].code).join(','));
  if (process.env.MLB_HISTORY_VERBOSE) console.log(season, seedCodes.join(' | '), 'tiebreak steps used:', used.join(',') || 'none');
}

/* the ties of the no-tiebreaker-game era (2022-2025) that history actually contained */
K.chk('2022-2025: the head-to-head step decided at least the 2022 NL East, 2023 AL West and 2025 AL East ties', SEASONS.filter((s) => s >= 2022).every((s) => ties[s].includes('head_to_head')), ties);
/* 2024: Atlanta, New York (NL) and Arizona finished 89-73 for two wild cards */
{
  const teams = teamsFor(2024); const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const games = loadRegularSeason(2024).games;
  const S = new Season(teams, games.map((g) => ({ home: ix[g.home], away: ix[g.away], day: dayOf(g.date), game_no: g.game_no })));
  const st = new Standings(S, Int8Array.from(games.map((g) => (g.hs > g.as ? 1 : -1))), { rng: null });
  K.eq('2024: ATL, NYN, ARI all 89-73', ['ATL', 'NYN', 'ARI'].map((c) => st.w[ix[c]] + '-' + st.l[ix[c]]), ['89-73', '89-73', '89-73']);
  const nl = qualify(st, formatFor(2024))[1].seeds.map((t) => teams[t].code);
  K.eq('2024: the three-club tie seeds ATL 5, NYN 6 and leaves ARI out', [nl[4], nl[5], nl.includes('ARI')], ['ATL', 'NYN', false]);
}
process.exit(K.done());
