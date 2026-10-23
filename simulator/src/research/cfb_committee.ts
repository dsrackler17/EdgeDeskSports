/* ===========================================================================
   CAN A COMMITTEE PROXY BE DEFENDED? — fit, chronological validation and
   registration of simulator/src/sports/cfb/committee.ts.

   Historical inputs (all owned or sourced):
     the committee's final top 25, 2014-2025   simulator/data/cfb_cfp_rankings_history.json
     every game and result                     cfbfastR-data schedules (the simulator's own feed)
     the frozen as-of-week rating              the served engine replayed cold (cfb_replay.ts),
                                               frozen after week 4, 7 and 10 — the rating the
                                               simulator holds at that as-of week
   A team's resume is computed by committee.ts resumes() from games played
   before the final ranking was released (conference championship games in,
   bowls and later games out), exactly as the simulation computes it from a
   simulated season.

   Specifications, written before any validation:
     record     losses, wins, power
     rating     rating
     resume     losses, wins, undefeated, power, champ_power, champ_other, rating, sos, quality_wins
     compact    losses, wins, power, champ_power, champ_other, rating, sos
   Chronological validation: for each season S in 2017-2025, fit on the
   seasons before S only, score S. Selection: the specification with the best
   mean Plackett-Luce log-likelihood per ranked place over 2017-2023; 2024 and
   2025 (the 12-team seasons) are reported after the choice.
   DEFENSIBLE (all three, pooled over 2017-2025, decided before looking at 2024-25):
     D1 beats both baselines (record, rating) on mean log-likelihood per place
     D2 P(top 12) calibrated: no bucket with n >= 30 whose mean prediction lies
        outside the Wilson 95% interval of the observed rate
     D3 expected overlap with the actual top 12 of at least 10 teams on average
   If any fails, the simulator publishes NO unconditional CFP or title
   probability (validate.ts reads `decision.defensible`).

   Output (committed): simulator/data/cfb_committee_proxy.json
   Usage: node simulator/src/research/cfb_committee.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, loadCfbEngine, loadSeasonFeedSync, type FeedGame } from '../sports/cfb/engine_adapter.ts';
import { cachedReplay } from './cfb_replay.ts';
import { resumes, fitPL, design, scores, noisyOrder, plLogLik, type ResumeFeature, type Resume, type ProxyFit } from '../sports/cfb/committee.ts';
import { streamFor } from '../core/prng.ts';
import { wilson } from '../core/stats.ts';
import { sha256Hex } from '../core/canonical.ts';

export const CFB_COMMITTEE_FILE = path.join(REPO, 'simulator', 'data', 'cfb_committee_proxy.json');
const HISTORY = path.join(REPO, 'simulator', 'data', 'cfb_cfp_rankings_history.json');
const SEASONS = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const VALIDATE = SEASONS.filter((s) => s >= 2017), SELECT = VALIDATE.filter((s) => s <= 2023), LATE = [2024, 2025];
const AS_OF = [4, 7, 10];
export const SPECS: Record<string, ResumeFeature[]> = {
  record: ['losses', 'wins', 'power'],
  rating: ['rating'],
  resume: ['losses', 'wins', 'undefeated', 'power', 'champ_power', 'champ_other', 'rating', 'sos', 'quality_wins'],
  compact: ['losses', 'wins', 'power', 'champ_power', 'champ_other', 'rating', 'sos']
};
const DRAWS = 4000, BOOT = 200;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
export const powerConferences = (season: number) => (season <= 2023 ? ['ACC', 'Big Ten', 'Big 12', 'Pac-12', 'SEC'] : ['ACC', 'Big Ten', 'Big 12', 'SEC']);

/* Wikipedia's spellings that the feed spells differently (normalized keys) */
const ALIAS: Record<string, string> = { miamifl: 'miami', miamioh: 'miamioh', pitt: 'pittsburgh', louisianalafayette: 'louisiana', ulmonroe: 'ulmonroe', appalachianstate: 'appstate', hawaii: 'hawaii', ucf: 'ucf', usc: 'usc' };

export interface SeasonFrame { season: number; teams: string[]; resumes: Resume[]; order: number[]; ranked: number; rankingDate: string; unmatched: string[] }

export function seasonFrame(season: number, K: number, ratings: Record<string, number>, ranking: Array<[number, string, number, number]>, header: string,
  rows?: FeedGame[]): SeasonFrame {
  const E = loadCfbEngine().E, P = loadCfbEngine().P;
  /* rows: the season's games (every game with an FBS team), e.g. the committed fixture; default the cached feed */
  const feed = rows ?? loadSeasonFeedSync(season);
  const m = /(Dec|Jan)\.?\s*(\d{1,2})/.exec(header);
  if (!m) throw new Error('no ranking date in ' + header);
  const rankingDate = (m[1] === 'Jan' ? season + 1 : season) + '-' + (m[1] === 'Jan' ? '01' : '12') + '-' + String(m[2]).padStart(2, '0');
  const fbs = new Map<string, string>();
  for (const g of feed) {
    if (g.home_division === 'fbs') fbs.set(g.home, g.home_conference || 'FBS Independents');
    if (g.away_division === 'fbs') fbs.set(g.away, g.away_conference || 'FBS Independents');
  }
  const teams = [...fbs.keys()].sort();
  const ix = new Map(teams.map((t, i) => [t, i]));
  const byKey = new Map(teams.map((t) => [E.normKey(t), t]));
  /* games before the final ranking (regular season and championship games) */
  const before = feed.filter((g) => g.completed && g.start_date.slice(0, 10) < rankingDate && (g.season_type === 'regular' || /championship/i.test(g.notes || '')) && !/playoff|bowl/i.test(g.notes || ''));
  const games = before.filter((g) => ix.has(g.home) || ix.has(g.away)).map((g) => ({ h: g.home_division === 'fbs' ? ix.get(g.home)! : -1, a: g.away_division === 'fbs' ? ix.get(g.away)! : -1, m: (g.home_points as number) - (g.away_points as number) }));
  const champs = conferenceChampions(before, fbs);
  const power = new Set(powerConferences(season));
  const rating = teams.map((t) => (t in ratings ? ratings[t] : P.rating.hyperparams.init_rating ?? 0));
  const rs = resumes({ T: teams.length, rating, fcsRating: P.rating.hyperparams.fcs_rating, power: teams.map((t) => (power.has(fbs.get(t)!) || t === 'Notre Dame' ? 1 : 0)),
    champion: teams.map((t) => (champs.has(t) ? 1 : 0)), games });
  const unmatched: string[] = [], order: number[] = [];
  for (const [, name] of ranking) {
    const k = E.normKey(name.replace(/\s*\(FL\)\s*/i, ' fl')), key = ALIAS[k] || k;
    const t = byKey.get(key);
    if (!t) { unmatched.push(name); continue; }
    order.push(ix.get(t)!);
  }
  return { season, teams, resumes: rs, order, ranked: ranking.length, rankingDate, unmatched };
}

/** the conference championship games of a season. The feed labels them in its notes from 2022 on; earlier seasons
    carry them as plain conference games, so there a title game is identified as the ONLY conference game a conference
    played on its last conference date, on or after Nov 28 (checked against the labelled 2022-2025 games by
    simulator/tests/cfb_committee.test.ts) */
export function championshipGames(games: FeedGame[], confOf: Map<string, string>): FeedGame[] {
  const labelled = games.filter((g) => /championship/i.test(g.notes || '') && !/playoff|bowl|division i|fcs|swac|siac/i.test(g.notes || '') && confOf.get(g.home) && confOf.get(g.home) === confOf.get(g.away));
  if (labelled.length) return labelled;
  const byConf = new Map<string, FeedGame[]>();
  for (const g of games) {
    const c = confOf.get(g.home);
    if (!g.conference_game || !c || c !== confOf.get(g.away) || c === 'FBS Independents' || !g.completed) continue;
    byConf.set(c, (byConf.get(c) || []).concat(g));
  }
  const out: FeedGame[] = [];
  for (const [, gs] of byConf) {
    const last = gs.reduce((a, g) => (g.start_date.slice(0, 10) > a ? g.start_date.slice(0, 10) : a), '');
    const onLast = gs.filter((g) => g.start_date.slice(0, 10) === last);
    if (onLast.length === 1 && last.slice(5) >= '11-28') out.push(onLast[0]);
  }
  return out;
}

/** champions: the winner of a championship game before the ranking; a conference without one: its best conference record (co-champions) */
export function conferenceChampions(games: FeedGame[], confOf: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const withGame = new Set<string>();
  const ccg = championshipGames(games, confOf), ccgIds = new Set(ccg.map((g) => g.game_id));
  for (const g of ccg) { withGame.add(confOf.get(g.home)!); out.add((g.home_points as number) > (g.away_points as number) ? g.home : g.away); }
  const rec = new Map<string, [number, number]>();
  for (const g of games) {
    if (!g.conference_game || ccgIds.has(g.game_id)) continue;
    const c = confOf.get(g.home);
    if (!c || c !== confOf.get(g.away) || withGame.has(c) || c === 'FBS Independents') continue;
    const hw = (g.home_points as number) > (g.away_points as number);
    for (const [t, w] of [[g.home, hw], [g.away, !hw]] as Array<[string, boolean]>) { const r = rec.get(t) || [0, 0]; r[0] += w ? 1 : 0; r[1]++; rec.set(t, r); }
  }
  const byConf = new Map<string, string[]>();
  for (const t of rec.keys()) { const c = confOf.get(t)!; byConf.set(c, (byConf.get(c) || []).concat(t)); }
  for (const [, ts] of byConf) {
    const best = Math.max(...ts.map((t) => rec.get(t)![0] / rec.get(t)![1]));
    ts.filter((t) => rec.get(t)![0] / rec.get(t)![1] === best).forEach((t) => out.add(t));
  }
  return out;
}

function standardize(frames: SeasonFrame[], spec: ResumeFeature[]): { mean: number[]; sd: number[] } {
  const mean = spec.map(() => 0), sd = spec.map(() => 0); let n = 0;
  for (const f of frames) for (const r of f.resumes) { n++; spec.forEach((k, i) => { mean[i] += r[k]; }); }
  spec.forEach((_, i) => { mean[i] /= n; });
  for (const f of frames) for (const r of f.resumes) spec.forEach((k, i) => { sd[i] += (r[k] - mean[i]) ** 2; });
  spec.forEach((_, i) => { sd[i] = Math.sqrt(sd[i] / n) || 1; });
  return { mean, sd };
}
export function fitSpec(frames: SeasonFrame[], spec: ResumeFeature[]): ProxyFit {
  const st = standardize(frames, spec);
  const data = frames.map((f) => ({ X: f.resumes.map((r) => design(r, { spec, ...st })), order: f.order }));
  const fit = fitPL(data, spec.length);
  return { spec, ...st, beta: fit.beta };
}
/** Monte Carlo place probabilities of one season under a fit: P(top 4), P(top 12), P(top 25) per team */
export function placeProbs(f: SeasonFrame, fit: ProxyFit, draws: number, seed: bigint) {
  const s = scores(f.resumes, fit), T = f.teams.length;
  const p4 = new Float64Array(T), p12 = new Float64Array(T), p25 = new Float64Array(T);
  let overlap = 0;
  const actual12 = new Set(f.order.slice(0, 12));
  for (let d = 0; d < draws; d++) {
    const rng = streamFor(seed, d, 41);
    const o = noisyOrder(s, () => true, () => rng.nextOpen());
    o.slice(0, 4).forEach((t) => p4[t]++); o.slice(0, 12).forEach((t) => { p12[t]++; if (actual12.has(t)) overlap++; }); o.slice(0, 25).forEach((t) => p25[t]++);
  }
  for (let t = 0; t < T; t++) { p4[t] /= draws; p12[t] /= draws; p25[t] /= draws; }
  return { p4, p12, p25, overlap: overlap / draws };
}

function main() {
  const hist = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  const R = cachedReplay({ from: 2014, to: 2025, asOfWeeks: AS_OF, captureRatings: true }, (s) => process.stderr.write(s + '\n'));
  const out: Record<string, any> = {};
  for (const K of AS_OF) {
    const frames = SEASONS.map((S) => seasonFrame(S, K, R.ratings[S + ':' + K], hist.seasons[S].ranking, hist.seasons[S].final_column));
    const unmatched = frames.flatMap((f) => f.unmatched.map((u) => f.season + ':' + u));
    if (unmatched.length) throw new Error('ranked teams not matched to the feed: ' + unmatched.join(', '));
    /* chronological validation of every specification */
    const val: Record<string, any> = {};
    for (const [name, spec] of Object.entries(SPECS)) {
      const per: any[] = [];
      for (const S of VALIDATE) {
        const train = frames.filter((f) => f.season < S), test = frames.find((f) => f.season === S)!;
        const fit = fitSpec(train, spec);
        const X = test.resumes.map((r) => design(r, fit));
        const ll = plLogLik(X, test.order, fit.beta, 'll').ll / test.order.length;
        const pp = placeProbs(test, fit, DRAWS, BigInt(S * 10 + K));
        const in12 = new Set(test.order.slice(0, 12)), in4 = new Set(test.order.slice(0, 4));
        const pts12 = test.teams.map((_, t) => [pp.p12[t], in12.has(t) ? 1 : 0]), pts4 = test.teams.map((_, t) => [pp.p4[t], in4.has(t) ? 1 : 0]);
        const brier = (a: number[][]) => a.reduce((s, [p, y]) => s + (p - y) ** 2, 0);
        per.push({ season: S, ll_per_place: r6(ll), brier12_sum: r6(brier(pts12)), brier4_sum: r6(brier(pts4)), expected_overlap12: r6(pp.overlap), pts12, pts4 });
      }
      const mean = (k: string, ss: number[]) => r6(per.filter((p) => ss.includes(p.season)).reduce((a, p) => a + p[k], 0) / ss.length);
      val[name] = { spec, select_ll: mean('ll_per_place', SELECT), late_ll: mean('ll_per_place', LATE), all_ll: mean('ll_per_place', VALIDATE),
        mean_overlap12: mean('expected_overlap12', VALIDATE), late_overlap12: mean('expected_overlap12', LATE), per };
    }
    const chosen = Object.keys(SPECS).filter((n) => n !== 'record' && n !== 'rating').sort((a, b) => val[b].select_ll - val[a].select_ll)[0];
    /* calibration of P(top 12) and P(top 4), pooled over the validation seasons */
    const calib = (key: 'pts12' | 'pts4') => {
      const pts = val[chosen].per.flatMap((p: any) => p[key]) as number[][];
      const B = [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98, 1.0000001];
      return B.slice(0, -1).map((lo, i) => {
        const s = pts.filter(([p]) => p >= lo && p < B[i + 1]);
        if (!s.length) return { bucket: [lo, Math.min(1, B[i + 1])], n: 0 };
        const k = s.reduce((a, [, y]) => a + y, 0), pred = s.reduce((a, [p]) => a + p, 0) / s.length, w = wilson(k, s.length);
        return { bucket: [lo, Math.min(1, B[i + 1])], n: s.length, predicted: r6(pred), observed: r6(k / s.length), wilson95: [r6(w.lo), r6(w.hi)], verdict: pred > w.hi ? 'OVERCONFIDENT' : pred < w.lo ? 'UNDERCONFIDENT' : 'within interval' };
      });
    };
    const c12 = calib('pts12'), c4 = calib('pts4');
    const D1 = val[chosen].all_ll > val.record.all_ll && val[chosen].all_ll > val.rating.all_ll;
    const D2 = c12.every((b: any) => !b.n || b.n < 30 || b.verdict === 'within interval');
    const D3 = val[chosen].mean_overlap12 >= 10;
    /* production: every season, plus a season bootstrap for parameter uncertainty */
    const fit = fitSpec(frames, SPECS[chosen]);
    const rng = streamFor(20261023n + BigInt(K), 0, 42);
    const boot: number[][] = [];
    for (let b = 0; b < BOOT; b++) {
      const res = SEASONS.map(() => frames[rng.nextInt(frames.length)]);
      const st = { spec: fit.spec, mean: fit.mean, sd: fit.sd };
      const data = res.map((f) => ({ X: f.resumes.map((r) => design(r, st)), order: f.order }));
      boot.push(fitPL(data, fit.spec.length).beta.map(r6));
    }
    for (const n of Object.keys(val)) for (const p of val[n].per) { delete p.pts12; delete p.pts4; }
    out[K] = { chosen, fit: { spec: fit.spec, mean: fit.mean.map(r6), sd: fit.sd.map(r6), beta: fit.beta.map(r6) }, bootstrap_beta: boot,
      validation: val, calibration_top12: c12, calibration_top4: c4,
      decision: { D1_beats_baselines: D1, D2_top12_calibrated: D2, D3_overlap_at_least_10: D3, defensible: D1 && D2 && D3 } };
    console.log('as-of ' + K + ': chosen ' + chosen + ' · ll/place ' + val[chosen].all_ll + ' (record ' + val.record.all_ll + ', rating ' + val.rating.all_ll + ') · overlap12 ' + val[chosen].mean_overlap12 + ' (2024-25 ' + val[chosen].late_overlap12 + ') · D1 ' + D1 + ' D2 ' + D2 + ' D3 ' + D3);
  }
  const doc = {
    schema: 'edgedesk_sim_cfb_committee_proxy_v1',
    generated_by: 'simulator/src/research/cfb_committee.ts',
    status: 'RESEARCH / EXPERIMENTAL: every output using it is Estimated',
    model: 'Plackett-Luce over all FBS teams on a standardized resume (committee.ts); simulation adds standard Gumbel noise per team per run and draws beta from the season bootstrap',
    engine_model_version: R.model_version,
    rankings_source: 'simulator/data/cfb_cfp_rankings_history.json', rankings_sha256: sha256Hex(fs.readFileSync(HISTORY)),
    seasons: SEASONS, validation_seasons: VALIDATE, selection_seasons: SELECT, late_seasons: LATE,
    specs: SPECS, criteria: { D1: 'beats the record and rating baselines on mean log-likelihood per ranked place, 2017-2025', D2: 'P(top 12) calibrated: no bucket with n >= 30 outside its Wilson 95% interval', D3: 'expected overlap with the actual top 12 >= 10 on average' },
    by_as_of_week: out,
    limitations: [
      'Twelve seasons; only 2024 and 2025 were 12-team selections, the rest ranked for a 4-team field.',
      'The resume is a summary: it cannot see injuries the committee weighs, margins it is told not to reward, or the eye test.',
      'The rating feature is the engine\'s frozen as-of rating, not the committee\'s perception; the committee saw every later game.',
      'The noise is the committee\'s historical unpredictability around this resume, not a model of its deliberation.'
    ]
  };
  fs.writeFileSync(CFB_COMMITTEE_FILE, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, CFB_COMMITTEE_FILE));
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('research', 'cfb_committee.ts'));
if (isMain) main();
