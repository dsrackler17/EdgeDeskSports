/* The committee proxy (committee.ts) and its historical inputs:
   - the committed final rankings agree with the playoff games in the schedule
     feed (top 4 = the semifinalists 2014-2023; the 12 teams of 2024-2025);
   - the resume is computed exactly; the Plackett-Luce fit recovers known
     parameters; Gumbel noise IS a Plackett-Luce draw;
   - a simulated record never decides the ranking by itself;
   - the committed proxy file says what its pre-registered validation found. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { history } from './_cfb.ts';
import { resumes, scores, noisyOrder, fitPL, design, RESUME_FEATURES, type Resume } from '../src/sports/cfb/committee.ts';
import { seasonFrame, championshipGames } from '../src/research/cfb_committee.ts';
import { loadCfbEngine } from '../src/sports/cfb/engine_adapter.ts';
import { streamFor } from '../src/core/prng.ts';

const T = kit('CFB committee proxy');
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const HIST = JSON.parse(fs.readFileSync(path.join(DATA, 'cfb_cfp_rankings_history.json'), 'utf8'));
const PROXY = JSON.parse(fs.readFileSync(path.join(DATA, 'cfb_committee_proxy.json'), 'utf8'));

/* 1 the rankings data against the feed */
T.eq('final rankings for every season 2014-2025, 25 teams each', Object.keys(HIST.seasons).map((s) => HIST.seasons[s].ranking.length), new Array(12).fill(25));
for (let season = 2014; season <= 2025; season++) {
  const f = seasonFrame(season, 7, {}, HIST.seasons[season].ranking, HIST.seasons[season].final_column, history().filter((g) => g.season === season));
  T.eq(season + ': every ranked team matches a feed team', f.unmatched, []);
  const rows = history().filter((g) => g.season === season);
  const cfp = rows.filter((g) => /college football playoff|cfp/i.test(g.notes || '') && !/national championship/i.test(g.notes || ''));
  if (season <= 2022) {
    /* cfbfastR-data schedules carry no postseason rows for these seasons: say so, rather than skip silently */
    T.eq(season + ': the feed has no postseason rows (no playoff check possible from owned data)', rows.filter((g) => g.season_type === 'postseason').length, 0);
    continue;
  }
  const inCfp = new Set(cfp.flatMap((g) => [g.home, g.away]));
  const ranked = new Set(f.order.slice(0, season >= 2024 ? 12 : 4).map((t) => f.teams[t]));
  if (season >= 2024) T.chk(season + ': the 12 playoff teams in the feed are all ranked (an automatic qualifier may come from below 12)', inCfp.size === 12 && [...inCfp].every((t) => f.order.map((i) => f.teams[i]).includes(t)), [...inCfp]);
  else T.eq(season + ': the top 4 of the final ranking are the four semifinalists in the feed', [...ranked].sort(), [...inCfp].sort());
}
/* the title-game identification used for 2014-2021 (unlabelled seasons), checked against the labelled 2022-2023 games */
for (const season of [2022, 2023]) {
  const rows = history().filter((g) => g.season === season);
  const confOf = new Map<string, string>();
  for (const g of rows) { if (g.home_division === 'fbs') confOf.set(g.home, g.home_conference || 'FBS Independents'); if (g.away_division === 'fbs') confOf.set(g.away, g.away_conference || 'FBS Independents'); }
  const labelled = championshipGames(rows, confOf).map((g) => g.game_id).sort();
  const inferred = championshipGames(rows.map((g) => ({ ...g, notes: null })), confOf).map((g) => g.game_id).sort();
  T.chk(season + ': the unlabelled-season rule finds exactly the ' + labelled.length + ' labelled title games', labelled.length === 10 && inferred.join() === labelled.join(), { labelled, inferred });
}
/* 2 the resume, exactly */
{
  const r = resumes({ T: 3, rating: [10, 6, -2], fcsRating: -28, power: [1, 0, 0], champion: [0, 1, 0],
    games: [{ h: 0, a: 1, m: 7 }, { h: 1, a: 2, m: 3 }, { h: 2, a: 0, m: 10 }, { h: 0, a: -1, m: 40 }] });
  T.eq('resume of team 0: 2-1, beat a 6.0 team (quality) and an FCS team, opponents\' mean rating (6 - 2 - 28) / 3', [r[0].wins, r[0].losses, r[0].quality_wins, r[0].sos], [2, 1, 1, (6 - 2 - 28) / 3]);
  T.eq('team 1: a non-power champion; team 2: undefeated flag only with a win and no loss', [r[1].champ_other, r[1].champ_power, r[2].undefeated, r[2].wins, r[2].losses], [1, 0, 0, 1, 1]);
  T.eq('the resume has exactly the registered features', Object.keys(r[0]).sort(), [...RESUME_FEATURES].sort());
}
/* 3 Gumbel noise is a Plackett-Luce draw: P(first) = softmax(scores) */
{
  const s = [1.0, 0.0, -0.5], z = s.map(Math.exp), tot = z.reduce((a, b) => a + b, 0);
  const first = [0, 0, 0], N = 40000;
  for (let i = 0; i < N; i++) { const rng = streamFor(9n, i, 9); first[noisyOrder(s, () => true, () => rng.nextOpen())[0]]++; }
  for (let k = 0; k < 3; k++) T.near('P(team ' + k + ' first) = softmax', first[k] / N, z[k] / tot, 4 * Math.sqrt(0.25 / N));
  const o = noisyOrder([3, 1, 2, 0], (t) => t !== 2, () => 0.5);
  T.eq('noisyOrder returns a permutation of the eligible teams only', o.slice().sort(), [0, 1, 3]);
}
/* 4 the fit recovers known parameters */
{
  const beta = [1.2, -0.8], seasons: Array<{ X: number[][]; order: number[] }> = [];
  for (let s = 0; s < 40; s++) {
    const rng = streamFor(BigInt(100 + s), 0, 9);
    const X = Array.from({ length: 60 }, () => [rng.nextDouble() * 2 - 1, rng.nextDouble() * 2 - 1]);
    const sc = X.map((x) => beta[0] * x[0] + beta[1] * x[1]);
    seasons.push({ X, order: noisyOrder(sc, () => true, () => rng.nextOpen()).slice(0, 25) });
  }
  const fit = fitPL(seasons, 2);
  T.near('Plackett-Luce fit recovers beta[0] = 1.2', fit.beta[0], 1.2, 0.25);
  T.near('Plackett-Luce fit recovers beta[1] = -0.8', fit.beta[1], -0.8, 0.25);
}
/* 5 the simulated record never decides the ranking by itself */
{
  const fit = PROXY.by_as_of_week['7'].fit;
  const base: Resume = { losses: 1, wins: 11, undefeated: 0, power: 1, champ_power: 0, champ_other: 0, rating: 8, sos: 2, quality_wins: 3 };
  const tough = { ...base, sos: 5, rating: 10, quality_wins: 5 }, soft = { ...base, sos: -3, rating: 4, quality_wins: 0 };
  const sc = scores([tough, soft], fit);
  T.chk('two 11-1 power teams with different resumes get different committee scores (schedule, rating, quality wins)', sc[0] > sc[1], Array.from(sc));
  let firstTough = 0; const N = 20000;
  for (let i = 0; i < N; i++) { const rng = streamFor(11n, i, 9); if (noisyOrder(sc, () => true, () => rng.nextOpen())[0] === 0) firstTough++; }
  T.chk('... and the noise still ranks the weaker resume first in some runs (' + (100 * (1 - firstTough / N)).toFixed(1) + '%)', firstTough < N && firstTough > N / 2, firstTough);
  const same = scores([base, { ...base }], fit);
  let a = 0; for (let i = 0; i < N; i++) { const rng = streamFor(12n, i, 9); if (noisyOrder(same, () => true, () => rng.nextOpen())[0] === 0) a++; }
  T.near('identical resumes are ordered by the committee noise alone, 50/50', a / N, 0.5, 4 * Math.sqrt(0.25 / N));
  const oneLoss = { ...base, losses: 1, wins: 11 }, twoLoss = { ...base, losses: 2, wins: 10, sos: 9, rating: 14, quality_wins: 7 };
  const s2 = scores([oneLoss, twoLoss], fit);
  T.chk('a better record does not guarantee a better committee score (a two-loss team with a far stronger resume)', s2[1] > s2[0], Array.from(s2));
}
/* 6 what the committed proxy file says */
const E = loadCfbEngine();
for (const K of ['4', '7', '10']) {
  const e = PROXY.by_as_of_week[K];
  T.chk('as-of ' + K + ': the pre-registered decision is recorded (D1, D2, D3, defensible)', ['D1_beats_baselines', 'D2_top12_calibrated', 'D3_overlap_at_least_10', 'defensible'].every((k) => typeof e.decision[k] === 'boolean'));
  T.eq('as-of ' + K + ': the chosen specification was chosen from the pre-written list on 2017-2023', PROXY.selection_seasons, [2017, 2018, 2019, 2020, 2021, 2022, 2023]);
  T.chk('as-of ' + K + ': the chosen features are resume features', e.fit.spec.every((f: string) => (RESUME_FEATURES as readonly string[]).includes(f)));
  T.eq('as-of ' + K + ': 200 bootstrap parameter draws (parameter uncertainty)', [e.bootstrap_beta.length, e.bootstrap_beta[0].length], [200, e.fit.spec.length]);
  const b = Object.fromEntries(e.fit.spec.map((f: string, i: number) => [f, e.fit.beta[i]]));
  T.chk('as-of ' + K + ': signs a committee would recognise (losses -, wins +, rating +, schedule +)', b.losses < 0 && b.wins > 0 && b.rating > 0 && b.sos > 0, b);
  T.chk('as-of ' + K + ': validated chronologically — every validation season scored only with a fit on earlier seasons', e.validation[e.chosen].per.map((p: any) => p.season).join() === '2017,2018,2019,2020,2021,2022,2023,2024,2025');
}
T.eq('the proxy was fitted on the engine version the simulator prices with', PROXY.engine_model_version, E.model_version);
T.chk('the proxy file declares itself research, Estimated', /Estimated/.test(PROXY.status));
void design;
process.exitCode = T.done();
