/* ===========================================================================
   MLB starting-rotation study: simulator/data/mlb_rotation_study.json

   Measures, on every club-season 2012-2025 with starters on file (2020 and
   2024 left out: a 60-game season, and no starters in the 2024 table), what
   the simulator's rotation code (src/sports/mlb/rotation.ts, called here,
   not re-implemented) gets right, and fits the two uncertainty terms it
   draws:

   1 REST. Calendar days between consecutive starts of the same pitcher,
     regular season and postseason.
   2 PROJECTION BY HORIZON. From an as-of point every third club game, the
     rotation (last five distinct starters) is projected over the club's next
     140 actual games (their real dates and doubleheaders) with no draw:
       hit(k)    the projected starter of game k is the actual one
       inset(k)  the actual starter of game k is a member of the as-of rotation
       repl(k)   the rule found no rested member (a replacement)
     Windows: FIT 2018-2023 (the recent era the simulated season belongs
     to: rotations are less stable than in 2012-2017, which is reported as
     HISTORY), HOLDOUT 2025 (reported only).
   3 FIT (on FIT only). The spot probability by game kind (single game,
     doubleheader game 1, game 2) so that (1 - p_spot)(1 - repl) equals the
     measured in-rotation share over the first rotation turn (k = 1..5); the
     survival curve S(k) = in-rotation(k) / in-rotation(1..5), held at 1 for
     k <= 5, made non-increasing and at most 1. Two spot conventions (a spot
     start takes the turn of the member the rule would have started, or
     not) are replayed with the stochastic model on the FIT as-of points; the
     one whose simulated hit curve (k = 1..20) is closer to the observed is
     chosen. Both are then set beside HOLDOUT.
   4 DOUBLEHEADERS. Starts outside the rotation in game 1 and game 2 of a
     doubleheader against single games, observed and as the rule produces
     them (the rest clock alone forces a replacement in many second games).
   5 POSTSEASON. One-step-ahead accuracy of candidate postseason rules,
     every postseason game 2012-2025 except 2020 and 2024 (no 2024
     regular-season starters): the four (or five) best rotation members by
     the frozen model's s, best rested first, short rest second; the cycle
     among those four; the plain cycle. Chosen on 2012-2023, 2025 reported.
     The share of postseason starts outside the chosen postseason rotation
     is the postseason spot probability.

     node simulator/src/research/mlb_rotation_study.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { studyReplay, studyCaptureDays, seasonEndDay, STUDY_SEASONS, fileSha } from './mlb_replay.ts';
import { loadRegularSeason, loadPostseason, dayOf, REPO } from '../sports/mlb/history.ts';
import { rotationAt, lastStarts, RotationState, pickRegular, pickPostseason, postseasonRotation, recordStart, drawDepartures, projectRegular, projectPostseason, REPLACEMENT, type Start, type RotationParams, type GameKind } from '../sports/mlb/rotation.ts';
import { starterEffect } from '../sports/mlb/model_adapter.ts';
import { streamFor } from '../core/prng.ts';
import { wilson } from '../core/stats.ts';

export const ROTATION_STUDY = path.join(REPO, 'simulator', 'data', 'mlb_rotation_study.json');
const H = 140, STEP = 3, FIRST = 20;
const HISTORY = [2012, 2013, 2014, 2015, 2016, 2017], FIT = [2018, 2019, 2021, 2022, 2023], HOLDOUT = [2025];
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const BASE: RotationParams = { min_rest_days: 5, short_rest_days: 4, postseason_rotation_size: 4, p_spot: { single: 0, dh1: 0, dh2: 0, postseason: 0 }, spot_takes_turn: false, postseason_spot_takes_turn: false, survival: [] };

interface ClubGame { day: number; game_no: number; pitcher: string; kind: GameKind }
function clubGames(season: number): Map<string, ClubGame[]> {
  const out = new Map<string, ClubGame[]>();
  for (const g of loadRegularSeason(season).games) {
    const kind = g.game_no === 0 ? 'single' : g.game_no === 1 ? 'dh1' : 'dh2';
    for (const [t, p] of [[g.home, g.sp_home], [g.away, g.sp_away]] as Array<[string, string | null]>) {
      if (!out.has(t)) out.set(t, []);
      out.get(t)!.push({ day: dayOf(g.date), game_no: g.game_no, pitcher: p || '', kind });
    }
  }
  return out;
}

interface Curve { n: number[]; hit: number[]; inset: number[]; repl: number[] }
const newCurve = (): Curve => ({ n: new Array(H).fill(0), hit: new Array(H).fill(0), inset: new Array(H).fill(0), repl: new Array(H).fill(0) });
const KINDS: GameKind[] = ['single', 'dh1', 'dh2'];
const windowOf = (s: number) => (HISTORY.includes(s) ? 'history' : FIT.includes(s) ? 'fit' : 'holdout');
interface AsOf { season: number; ids: string[]; last: number[]; fut: ClubGame[] }

function main() {
  const log = (s: string) => console.log('[mlb rotation] ' + s);
  const post = loadPostseason().games.filter((g) => g.season !== 2020);
  /* 1 rest */
  const restReg = new Map<number, number>(), restPost = new Map<number, number>();
  const bump = (m: Map<number, number>, d: number) => m.set(Math.min(d, 12), (m.get(Math.min(d, 12)) || 0) + 1);
  for (const s of STUDY_SEASONS) {
    const last: Record<string, number> = {};
    for (const g of loadRegularSeason(s).games) for (const p of [g.sp_home, g.sp_away]) { if (!p) continue; const d = dayOf(g.date); if (last[p] != null) bump(restReg, d - last[p]); last[p] = d; }
    for (const g of post.filter((x) => x.season === s)) for (const p of [g.sp_home, g.sp_away]) { if (!p) continue; const d = dayOf(g.date); if (last[p] != null) bump(restPost, d - last[p]); last[p] = d; }
  }
  const dist = (m: Map<number, number>) => { const n = [...m.values()].reduce((a, b) => a + b, 0); return { starts: n, share_by_days: Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k === 12 ? '12+' : String(k), r4(v / n)])) }; };

  /* 2 projection by horizon (the rule, no draw) */
  const curves: Record<string, Curve> = { history: newCurve(), fit: newCurve(), holdout: newCurve() };
  const kindCount: Record<string, Record<GameKind, { n: number; out: number; repl: number }>> = {};
  for (const w of ['history', 'fit', 'holdout']) kindCount[w] = { single: { n: 0, out: 0, repl: 0 }, dh1: { n: 0, out: 0, repl: 0 }, dh2: { n: 0, out: 0, repl: 0 } };
  const points: Record<string, AsOf[]> = { history: [], fit: [], holdout: [] };
  for (const s of STUDY_SEASONS) {
    const win = windowOf(s);
    for (const games of clubGames(s).values()) {
      for (let a = FIRST; a < games.length - 1; a += STEP) {
        const hist: Start[] = games.slice(0, a).map((g) => ({ day: g.day, game_no: g.game_no, pitcher: g.pitcher }));
        const fut = games.slice(a, a + H);
        const ids = rotationAt(hist, 5); const ls = lastStarts(hist); const last = ids.map((p) => ls[p]);
        const st = new RotationState(ids, ids.map(() => 0), last);
        const c = curves[win];
        fut.forEach((g, k) => {
          const slot = pickRegular(st, g.day, BASE);
          const proj = slot === REPLACEMENT ? null : st.ids[slot];
          recordStart(st, slot, g.day);
          c.n[k]++; if (proj === g.pitcher) c.hit[k]++; if (ids.includes(g.pitcher)) c.inset[k]++; if (slot === REPLACEMENT) c.repl[k]++;
          if (k < 5) { const kc = kindCount[win][g.kind]; kc.n++; if (!ids.includes(g.pitcher)) kc.out++; if (slot === REPLACEMENT) kc.repl++; }
        });
        points[win].push({ season: s, ids, last, fut });
      }
    }
  }

  /* 3 fit on FIT */
  const F = curves.fit;
  const first = (c: Curve, key: 'inset' | 'repl') => [0, 1, 2, 3, 4].reduce((a, k) => a + c[key][k], 0) / [0, 1, 2, 3, 4].reduce((a, k) => a + c.n[k], 0);
  const ins5 = first(F, 'inset');
  const pSpot: Record<GameKind, number> = { single: 0, dh1: 0, dh2: 0 };
  for (const k of KINDS) { const x = kindCount.fit[k]; pSpot[k] = r4(Math.max(0, 1 - (1 - x.out / x.n) / (1 - x.repl / x.n))); }
  const survival: number[] = []; let m = 1;
  for (let k = 0; k < H; k++) { if (k >= 5 && F.n[k] >= 200) m = Math.min(m, F.inset[k] / F.n[k] / ins5); survival.push(r4(Math.min(1, m))); }
  log('p_spot ' + JSON.stringify(pSpot) + ', survival at 10/40/80/140 games ' + [survival[9], survival[39], survival[79], survival[139]].join(' / '));

  const simulate = (pts: AsOf[], P: RotationParams, reps: number): Curve => {
    const c = newCurve();
    pts.forEach((pt, i) => {
      for (let rep = 0; rep < reps; rep++) {
        const rng = streamFor(0x5eedn, i * reps + rep, 9);
        const st = new RotationState(pt.ids, pt.ids.map(() => 0), pt.last);
        drawDepartures(st, P, rng);
        pt.fut.forEach((g, k) => {
          const slot = projectRegular(st, g.day, g.kind, P, rng); st.games++;
          const proj = slot === REPLACEMENT ? null : st.ids[slot];
          c.n[k]++; if (proj === g.pitcher) c.hit[k]++; if (proj !== null) c.inset[k]++;
        });
      }
    });
    return c;
  };
  const KS = [1, 2, 3, 4, 5, 6, 10, 20, 40, 60, 80, 100, 140];
  const table = (c: Curve, label: string) => KS.filter((k) => c.n[k - 1] > 0).map((k) => ({ k, n: c.n[k - 1], [label + '_hit']: r4(c.hit[k - 1] / c.n[k - 1]), [label + '_in_rotation']: r4(c.inset[k - 1] / c.n[k - 1]), ...(label === 'observed' ? { rule_replacement: r4(c.repl[k - 1] / c.n[k - 1]) } : {}) }));
  const gap = (sim: Curve, obs: Curve, key: 'hit' | 'inset', ks: number) => { let a = 0; for (let k = 0; k < ks; k++) a += Math.abs(sim[key][k] / sim.n[k] - obs[key][k] / obs.n[k]); return r4(a / ks); };
  const variants: Record<string, { P: RotationParams; fit: Curve; holdout: Curve }> = {};
  for (const takes of [true, false]) {
    const P: RotationParams = { ...BASE, p_spot: { ...pSpot, postseason: 0 }, spot_takes_turn: takes, survival };
    variants[takes ? 'spot_takes_turn' : 'spot_free'] = { P, fit: simulate(points.fit, P, 2), holdout: simulate(points.holdout, P, 4) };
  }
  const gaps = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { fit_hit_mae_k1_20: gap(v.fit, F, 'hit', 20), fit_in_rotation_mae_k1_60: gap(v.fit, F, 'inset', 60), holdout_hit_mae_k1_20: gap(v.holdout, curves.holdout, 'hit', 20), holdout_in_rotation_mae_k1_60: gap(v.holdout, curves.holdout, 'inset', 60) }]));
  const chosenSpot = gaps.spot_takes_turn.fit_hit_mae_k1_20 <= gaps.spot_free.fit_hit_mae_k1_20 ? 'spot_takes_turn' : 'spot_free';
  log('spot convention ' + chosenSpot + ' ' + JSON.stringify(gaps));

  /* 5 postseason */
  const R = studyReplay(studyCaptureDays(), log);
  type Rule = 'quality4' | 'quality5' | 'quality4_rested_fallback' | 'recent4_quality' | 'cycle_in_quality4' | 'cycle';
  const RULES: Rule[] = ['quality4', 'quality5', 'quality4_rested_fallback', 'recent4_quality', 'cycle_in_quality4', 'cycle'];
  const shortPicks: Record<Rule, number> = { quality4: 0, quality5: 0, quality4_rested_fallback: 0, recent4_quality: 0, cycle_in_quality4: 0, cycle: 0 };
  const hits: Record<string, Record<Rule, number[]>> = { choose: {} as any, holdout: {} as any };
  for (const w of ['choose', 'holdout']) for (const r of RULES) hits[w][r] = [0, 0];
  const outside = { choose: [0, 0], holdout: [0, 0] }; let shortRest = 0, memberStarts = 0;
  for (let s = 2012; s <= 2025; s++) {
    if (s === 2020 || s === 2024) continue;
    const w = s === 2025 ? 'holdout' : 'choose';
    const M = R.captures.get(seasonEndDay(s))!;
    const reg = clubGames(s); const games = post.filter((g) => g.season === s).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const t of [...new Set(games.flatMap((g) => [g.home, g.away]))]) {
      const hist: Start[] = (reg.get(t) || []).map((g) => ({ day: g.day, game_no: g.game_no, pitcher: g.pitcher }));
      const ids = rotationAt(hist, 5); const ls = lastStarts(hist);
      const st = new RotationState(ids, ids.map((p) => starterEffect(M, p)), ids.map((p) => ls[p]));
      const rot4 = postseasonRotation(st, BASE), rot5 = postseasonRotation(st, { ...BASE, postseason_rotation_size: 5 });
      for (const g of games.filter((x) => x.home === t || x.away === t)) {
        const actual = g.home === t ? g.sp_home : g.sp_away; const day = dayOf(g.date);
        const q4 = pickPostseason(st, rot4, day, BASE);
        const recent4 = (() => { const idx = st.ids.map((_, i) => i).sort((a, b) => st.last[b] - st.last[a]).slice(0, 4); return idx.sort((a, b) => st.s[b] - st.s[a] || a - b); })();
        const r4p = pickPostseason(st, recent4, day, BASE);
        const fb = (() => { for (const i of rot4) if (day - st.last[i] >= BASE.min_rest_days) return { slot: i, short: false };
          let b = REPLACEMENT, bl = Infinity; for (let i = 0; i < st.ids.length; i++) if (day - st.last[i] >= BASE.min_rest_days && st.last[i] < bl) { b = i; bl = st.last[i]; }
          return b !== REPLACEMENT ? { slot: b, short: false } : pickPostseason(st, rot4, day, BASE); })();
        if (q4.short) shortPicks.quality4++; if (r4p.short) shortPicks.recent4_quality++; if (fb.short) shortPicks.quality4_rested_fallback++;
        const pick: Record<Rule, number> = {
          quality4: q4.slot,
          quality5: pickPostseason(st, rot5, day, BASE).slot,
          quality4_rested_fallback: fb.slot,
          recent4_quality: r4p.slot,
          cycle_in_quality4: (() => { let b = REPLACEMENT, bl = Infinity; for (const i of rot4) if (day - st.last[i] >= BASE.min_rest_days && st.last[i] < bl) { b = i; bl = st.last[i]; } return b; })(),
          cycle: pickRegular(st, day, BASE)
        };
        for (const r of RULES) { hits[w][r][0]++; if (pick[r] >= 0 && st.ids[pick[r]] === actual) hits[w][r][1]++; }
        outside[w][0]++; if (!rot4.some((i) => st.ids[i] === actual)) outside[w][1]++;
        const si = st.slotOf(actual || '');
        if (si >= 0) { memberStarts++; if (day - st.last[si] < BASE.min_rest_days) shortRest++; recordStart(st, si, day); }
      }
    }
  }
  /* the postseason convention for spot starts: simulate each club's postseason rotation from its season-end
     state over the dates it actually played, and compare the simulated share of member starts on short rest
     (and of starts outside the rotation) with the observed one */
  const pSpotPostEst = outside.choose[1] / outside.choose[0];
  const postSim: Record<string, { member: number; short: number; repl: number; starts: number }> = {};
  for (const takes of [true, false]) {
    const P: RotationParams = { ...BASE, p_spot: { ...pSpot, postseason: pSpotPostEst }, spot_takes_turn: chosenSpot === 'spot_takes_turn', postseason_spot_takes_turn: takes, survival };
    const acc = { member: 0, short: 0, repl: 0, starts: 0 };
    let i = 0;
    for (let s = 2012; s <= 2023; s++) {
      if (s === 2020) continue;
      const M = R.captures.get(seasonEndDay(s))!; const reg = clubGames(s); const games = post.filter((g) => g.season === s).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (const t of [...new Set(games.flatMap((g) => [g.home, g.away]))]) {
        const hist: Start[] = (reg.get(t) || []).map((g) => ({ day: g.day, game_no: g.game_no, pitcher: g.pitcher }));
        const ids = rotationAt(hist, 5); const ls = lastStarts(hist);
        const days = games.filter((x) => x.home === t || x.away === t).map((x) => dayOf(x.date));
        for (let rep = 0; rep < 20; rep++, i++) {
          const rng = streamFor(0x9057n, i, 9);
          const st = new RotationState(ids, ids.map((p) => starterEffect(M, p)), ids.map((p) => ls[p]));
          const rot = postseasonRotation(st, P);
          for (const d of days) { const pk = projectPostseason(st, rot, d, P, rng); acc.starts++; if (pk.slot === REPLACEMENT) acc.repl++; else { acc.member++; if (pk.short) acc.short++; } }
        }
      }
    }
    postSim[takes ? 'postseason_spot_takes_turn' : 'postseason_spot_free'] = acc;
  }
  const obsShort = shortRest / memberStarts;
  const postConv = Object.fromEntries(Object.entries(postSim).map(([k, a]) => [k, { simulated_member_starts_on_short_rest: r4(a.short / a.member), simulated_outside_rotation: r4(a.repl / a.starts), starts: a.starts }]));
  const chosenPostSpot = Math.abs(postSim.postseason_spot_free.short / postSim.postseason_spot_free.member - obsShort) <= Math.abs(postSim.postseason_spot_takes_turn.short / postSim.postseason_spot_takes_turn.member - obsShort) ? 'postseason_spot_free' : 'postseason_spot_takes_turn';
  log('postseason spot convention ' + chosenPostSpot + ' ' + JSON.stringify(postConv) + ' observed short ' + r4(obsShort));
  const rateOf = (x: number[]) => { const w = wilson(x[1], x[0]); return { n: x[0], rate: r4(x[1] / x[0]), ci95: [r4(w.lo), r4(w.hi)] }; };
  const chosenPost = RULES.slice().sort((a, b) => hits.choose[b][1] / hits.choose[b][0] - hits.choose[a][1] / hits.choose[a][0])[0];
  const pSpotPost = r4(outside.choose[1] / outside.choose[0]);
  const chosen: RotationParams = { ...variants[chosenSpot].P, p_spot: { ...pSpot, postseason: pSpotPost }, postseason_spot_takes_turn: chosenPostSpot === 'postseason_spot_takes_turn' };
  const doc = {
    schema: 'edgedesk_sim_mlb_rotation_study_v1',
    built_at: new Date().toISOString(),
    inputs: { seasons: STUDY_SEASONS, windows: { history: HISTORY, fit: FIT, holdout: HOLDOUT }, regular_season: 'mlb/history/data/<season>.csv (Retrosheet starters)', postseason: 'simulator/fixtures/mlb_postseason_2012_2025.json', postseason_fixture_sha256: loadPostseason().sha256,
      rotation_code_sha256: fileSha('simulator/src/sports/mlb/rotation.ts'), data_sha256: R.data_sha256 },
    rest_days_between_starts: { regular_season: dist(restReg), postseason: dist(restPost) },
    projection: {
      rotation: 'last five distinct starters at the as-of point', rule: 'rested (>= 5 calendar days) member with the oldest last start; none rested: a replacement',
      as_of_points: 'every third club game from game ' + FIRST + ', each projected over the next ' + H + ' actual club games (their real dates and doubleheaders)',
      history: { seasons: HISTORY, by_horizon: table(curves.history, 'observed') },
      fit: { seasons: FIT, by_horizon: table(curves.fit, 'observed') },
      holdout: { seasons: HOLDOUT, by_horizon: table(curves.holdout, 'observed') }
    },
    fitted: {
      on: 'FIT ' + FIT.join(','), p_spot: pSpot, in_rotation_first_turn: r4(ins5),
      first_turn_by_kind: Object.fromEntries(KINDS.map((k) => [k, { n: kindCount.fit[k].n, observed_outside_rotation: r4(kindCount.fit[k].out / kindCount.fit[k].n), rule_replacement: r4(kindCount.fit[k].repl / kindCount.fit[k].n) }])),
      survival_by_club_game: survival,
      method: 'p_spot by kind: (1 - p_spot)(1 - rule replacement share) = in-rotation share over k = 1..5; survival: in-rotation share at k over the k = 1..5 share, held at 1 for k <= 5, non-increasing, at most 1; beyond k = ' + H + ': its last value'
    },
    spot_convention: { compared: gaps, chosen: chosenSpot, rule: 'the smaller FIT-window mean absolute gap of the simulated hit curve, k = 1..20' },
    stochastic_check: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { fit: table(v.fit, 'simulated'), holdout: table(v.holdout, 'simulated') }])),
    doubleheaders: Object.fromEntries(['history', 'fit', 'holdout'].map((w) => [w, Object.fromEntries(KINDS.map((k) => [k, { n: kindCount[w][k].n, observed_outside_rotation: r4(kindCount[w][k].out / kindCount[w][k].n), rule_replacement: r4(kindCount[w][k].repl / kindCount[w][k].n) }]))])),
    postseason: {
      seasons: '2012-2025 except 2020 and 2024 (no 2024 regular-season starters to build the rotation from); chosen on 2012-2023, 2025 reported',
      one_step_hit: { choose: Object.fromEntries(RULES.map((r) => [r, rateOf(hits.choose[r])])), holdout_2025: Object.fromEntries(RULES.map((r) => [r, rateOf(hits.holdout[r])])) },
      chosen_rule: chosenPost,
      outside_four_man_rotation: { choose: rateOf(outside.choose), holdout_2025: rateOf(outside.holdout) },
      member_starts_on_short_rest: { starts: memberStarts, short_rest: shortRest, share: r4(shortRest / memberStarts) },
      rule_short_rest_picks: Object.fromEntries(Object.entries(shortPicks).map(([k, v]) => [k, { picks: v, share: r4(v / (hits.choose[k as Rule][0] + hits.holdout[k as Rule][0])) }])),
      p_spot_postseason: pSpotPost,
      spot_convention: { compared: postConv, observed_member_starts_on_short_rest: r4(obsShort), chosen: chosenPostSpot, rule: 'simulated short-rest share of member starts closest to the observed one (2012-2023, each club\'s actual postseason dates, 20 seeded draws)' }
    },
    simulator_parameters: chosen
  };
  if (chosenPost !== 'quality4') throw new Error('the study prefers postseason rule ' + chosenPost + ': rotation.ts implements quality4 — change the code, then re-run');
  fs.writeFileSync(ROTATION_STUDY, JSON.stringify(doc, null, 1) + '\n');
  log('postseason one-step hit ' + JSON.stringify(doc.postseason.one_step_hit.choose) + ' outside rotation ' + JSON.stringify(doc.postseason.outside_four_man_rotation));
  log('wrote ' + path.relative(REPO, ROTATION_STUDY));
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
