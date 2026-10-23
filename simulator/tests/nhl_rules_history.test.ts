/* The NHL rules against history: every regular season 2013-14 .. 2018-19 and
   2021-22 .. 2025-26, replayed from the committed team-game table
   (hockey/data/team_games, from the NHL's game feeds), must produce the
   playoff field, every series pairing in every round, the club with home ice
   in every series, the 2-2-1-1-1 venue order of every game and the Stanley
   Cup winner that actually happened. The playoff games are fed in as
   observed; the resolver must never be called (every series is complete).
   Mutations of the rules this history can tell apart are checked to fail.
   node simulator/tests/nhl_rules_history.test.ts */
import { kit } from './_kit.ts';
import { replaySeason, loadHockeyGames } from '../src/sports/nhl/history.ts';
import { playPostseason, NhlStandings, NHL_TB_2019, NHL_TB_2014, nhlRulesFor, seriesHome, type NhlRulesVersion } from '../src/sports/nhl/rules.ts';

const T = kit('NHL rules vs history 2013-14 .. 2025-26');
const SEASONS = [2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025, 2026];
const CHAMPIONS: Record<number, string> = { 2014: 'LAK', 2015: 'CHI', 2016: 'PIT', 2017: 'PIT', 2018: 'WSH', 2019: 'STL', 2022: 'COL', 2023: 'VGK', 2024: 'FLA', 2025: 'FLA', 2026: 'CAR' };
const games = loadHockeyGames(SEASONS);
const never = () => { throw new Error('the resolver was called: a series the data has not finished'); };
const steps: Record<string, number> = {};

for (const s of SEASONS) {
  const R = replaySeason(s, games);
  const st = R.standings({ rng: null, diag: (k, n) => { if (k.startsWith('tb:')) steps[k] = (steps[k] || 0) + (n ?? 1); } });
  const diags: Record<string, number> = {};
  let post: ReturnType<typeof playPostseason> | null = null;
  try { post = playPostseason(st, never, { observed: R.observed, diag: (k, n) => { diags[k] = (diags[k] || 0) + (n ?? 1); } }); }
  catch (e) { T.chk(s + ': the standings reproduce every observed series', false, (e as Error).message); continue; }
  const code = (i: number) => R.teams[i].code;
  T.chk(s + ' (' + nhlRulesFor(s).id + '): the bracket from the standings contains every one of the 15 series played, in its round', post.series.length === 15 && post.series.every((x) => x.games.every((g) => g.observed)));
  T.eq(s + ': 16 playoff clubs, 8 per conference', post.brackets.map((b) => b.pos.size), [8, 8]);
  const homeBad = post.series.filter((x) => x.games[0].home !== x.hi).map((x) => code(x.hi) + '-' + code(x.lo));
  T.eq(s + ': home ice in every series (rounds 1-2 by bracket placement, then by record)', homeBad, []);
  const orderBad = post.series.filter((x) => x.games.some((g) => g.home !== seriesHome(x.hi, x.lo, g.game))).map((x) => code(x.hi) + '-' + code(x.lo));
  T.eq(s + ': every game at the 2-2-1-1-1 venue', orderBad, []);
  T.eq(s + ': Stanley Cup winner', code(post.champion), CHAMPIONS[s]);
  let pts = 0, past60 = 0;
  for (let t = 0; t < R.L.T; t++) pts += st.pts[t];
  for (let k = 0; k < R.L.G; k++) if (R.results[k] % 3 !== 0) past60++;
  T.eq(s + ': league points = 2 x games + games decided past 60 minutes', pts, 2 * R.L.G + past60);
}
T.chk('reported ties were decided by regulation wins, ROW and head-to-head in this history (the steps are exercised)', (steps['tb:regulation_wins'] || 0) >= 4 && (steps['tb:regulation_ot_wins'] || 0) >= 5 && (steps['tb:head_to_head_points'] || 0) >= 2, steps);
T.chk('no reported tie in this history needed the coin', !steps['tb:coin'], steps);

/* the history tells these rule changes apart */
function detects(rulesFor: (s: number) => NhlRulesVersion, homeByRecord = false): string[] {
  const fails: string[] = [];
  for (const s of SEASONS) {
    const R = replaySeason(s, games);
    const st = new NhlStandings(R.L, rulesFor(s), R.results, () => R.goals, { rng: null });
    try {
      const post = playPostseason(st, never, { observed: R.observed });
      for (const x of post.series) {
        const hi = homeByRecord ? (st.better(x.hi, x.lo, 'h') ? x.hi : x.lo) : x.hi;
        if (x.games[0].home !== hi) fails.push(s + ' home ' + R.teams[x.hi].code);
      }
    } catch (e) { fails.push(s + ' ' + (e as Error).message.slice(0, 60)); }
  }
  return fails;
}
T.chk('ROW-first rules in 2021-22 .. 2025-26 contradict history (regulation wins came first)', detects(() => NHL_TB_2014).some((f) => /^20(22|24)/.test(f)));
T.chk('RW-first rules in 2014-15 .. 2018-19 contradict history (ROW came first)', detects(() => NHL_TB_2019).some((f) => /^201[5-8]/.test(f)));
T.chk('head-to-head before regulation wins contradicts 2025-26', detects((s) => (s >= 2020 ? { ...NHL_TB_2019, steps: ['points_pct', 'head_to_head_points', 'regulation_wins', 'regulation_ot_wins', 'wins', 'goal_differential', 'goals_for'] } : NHL_TB_2014)).some((f) => f.startsWith('2026')));
T.chk('home ice by points alone in rounds 1-2 contradicts 2015-16 (TBL, 97 points, hosted the wild-card NYI, 100)', detects((s) => nhlRulesFor(s), true).some((f) => f.startsWith('2016')));
process.exit(T.done('Tiebreak steps that decided a reported place across the 11 seasons: ' + JSON.stringify(steps)));
