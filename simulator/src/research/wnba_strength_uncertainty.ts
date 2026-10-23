/* ===========================================================================
   HOW WRONG IS A FROZEN WNBA RATING, AND DOES IT CARRY THROUGH A SERIES? —
   the evidence behind the WNBA series simulation's shared offset.

   A playoff series is priced game by game from the served ratings as they
   stand before it. Whatever is wrong with the two clubs' ratings is wrong in
   EVERY game of the series at once: that shared error is what makes a
   series' games move together (a club the model underrates tends to win
   more than one of them). Game-to-game randomness is separate: it is the
   served calibration's own margin distribution.

   THE ESTIMATE, from owned history only (basketball/data/wnba, wehoop):
   1. Replay the SERVED configuration (basketball/walkforward.js pass + score:
      the served hyperparameters, each season's calibration fitted on the
      three before it), so every forecast is point-in-time.
   2. Residual r = actual home margin - calibrated margin mean; from a club's
      side r_t = +-r. If e_t is club t's persistent error, two of t's games
      against DIFFERENT opponents close in time satisfy E[r_t,1 r_t,2] =
      Var(e_t) (the opponents' errors are uncorrelated). Pairs are taken in
      the last 30 days of each regular season (the state a postseason is
      priced from), opponent-distinct, weighted by pair:
         sigma_club^2 = mean of r_t,1 * r_t,2
      A series pits two clubs, so the error in their DIFFERENCE has variance
         tau^2 = 2 sigma_club^2   (independent clubs)
   3. Direct check on the postseason itself: within one playoff series, two
      games' residuals (from the same club's side) satisfy E[r_1 r_2] = tau^2.
      Few series exist, so this is a check, not the estimate.
   4. Uncertainty: a bootstrap over SEASONS (2,000 resamples).
   5. The shared offset is carved OUT of the served distribution, never added
      to it: a game's probability stays exactly the served one on average
      (the reader's per-game numbers equal the board's), and tau must be
      below the calibration's margin sd for that to be possible.

   2010-2024 is the estimation window (2008-2009 burn in the ratings and the
   first calibration); 2025 is reported separately as a holdout; 2026 is
   never used. Output: simulator/data/wnba_strength_uncertainty.json
   Usage: node simulator/src/research/wnba_strength_uncertainty.ts
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, replay, type Forecast } from '../sports/wnba/model_adapter.ts';
import { streamFor } from '../core/prng.ts';
import { sha256Hex } from '../core/canonical.ts';

const OUT = path.join(REPO, 'simulator', 'data', 'wnba_strength_uncertainty.json');
const FIRST = 2010, LAST_EST = 2024, HOLDOUT = 2025, WINDOW_DAYS = 30, BOOT = 2000;

type Pair = { season: number; prod: number };
function clubPairs(fc: Forecast[]): Pair[] {
  const out: Pair[] = [];
  const bySeason = new Map<number, Forecast[]>();
  for (const f of fc) if (f.type === 'R') { const a = bySeason.get(f.season) || []; a.push(f); bySeason.set(f.season, a); }
  for (const [season, rows] of bySeason) {
    const last = Math.max(...rows.map((r) => r.start));
    const late = rows.filter((r) => r.start >= last - WINDOW_DAYS * 864e5);
    const byClub = new Map<string, Array<{ r: number; opp: string }>>();
    for (const g of late) {
      const res = g.y.margin - g.margin_mu;
      (byClub.get(g.home) || byClub.set(g.home, []).get(g.home)!).push({ r: res, opp: g.away });
      (byClub.get(g.away) || byClub.set(g.away, []).get(g.away)!).push({ r: -res, opp: g.home });
    }
    for (const list of byClub.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[i].opp !== list[j].opp) out.push({ season, prod: list[i].r * list[j].r });
  }
  return out;
}
function seriesPairs(fc: Forecast[]): Pair[] {
  const out: Pair[] = [];
  const series = new Map<string, Forecast[]>();
  for (const f of fc) if (f.type === 'P') { const k = f.season + ':' + [f.home, f.away].sort().join('-'); const a = series.get(k) || []; a.push(f); series.set(k, a); }
  for (const [k, games] of series) {
    const season = Number(k.split(':')[0]), ref = [games[0].home, games[0].away].sort()[0];
    const rs = games.map((g) => (g.home === ref ? 1 : -1) * (g.y.margin - g.margin_mu));
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) out.push({ season, prod: rs[i] * rs[j] });
  }
  return out;
}
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
function bootstrap(pairs: Pair[], seasons: number[], f: (ps: Pair[]) => number) {
  const by = new Map<number, Pair[]>(); for (const p of pairs) (by.get(p.season) || by.set(p.season, []).get(p.season)!).push(p);
  const rng = streamFor(0x5eedn, 0, 1), vals: number[] = [];
  for (let b = 0; b < BOOT; b++) {
    const ps: Pair[] = [];
    for (let i = 0; i < seasons.length; i++) ps.push(...(by.get(seasons[rng.nextInt(seasons.length)]) || []));
    if (ps.length) vals.push(f(ps));
  }
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

function main() {
  const R = replay(HOLDOUT);
  const est = R.forecasts.filter((f) => f.season >= FIRST && f.season <= LAST_EST);
  const hold = R.forecasts.filter((f) => f.season === HOLDOUT);
  const seasons: number[] = []; for (let s = FIRST; s <= LAST_EST; s++) seasons.push(s);
  const tauOf = (ps: Pair[]) => Math.sqrt(Math.max(0, 2 * mean(ps.map((p) => p.prod))));
  const sOf = (ps: Pair[]) => Math.sqrt(Math.max(0, mean(ps.map((p) => p.prod))));
  const cp = clubPairs(est), sp = seriesPairs(est), cpH = clubPairs(hold), spH = seriesPairs(hold);
  const sigClub = sOf(cp), tau = tauOf(cp);
  const ciTau = bootstrap(cp, seasons, tauOf);
  const tauSeries = sOf(sp), ciSeries = bootstrap(sp, seasons, sOf);
  /* the served game noise at the end of the estimation window, for the carve-out check */
  const sdMargin = (R.cal[HOLDOUT] as any).sd_margin as number;
  const pg = est.filter((f) => f.type === 'P');
  const doc = {
    schema: 'edgedesk_sim_wnba_strength_uncertainty_v1',
    generated_at: new Date().toISOString(),
    model: { league: 'wnba', model: R.model, params: R.params, method: 'basketball/walkforward.js pass + score (served configuration, point-in-time)' },
    windows: { estimation: [FIRST, LAST_EST], holdout: HOLDOUT, late_season_days: WINDOW_DAYS },
    club_error: { sigma_points: round(sigClub), pairs: cp.length, method: 'mean product of one club\'s residuals in two late-regular-season games against different opponents' },
    production: {
      tau_points: round(tau), ci95: ciTau.map(round), method: 'tau = sqrt(2) x sigma_club: the error in the difference of two independent clubs\' ratings, in points of final margin',
      carve_out_sd_margin: round(sdMargin), conditional_game_sd: round(Math.sqrt(Math.max(0, sdMargin * sdMargin - tau * tau))),
      note: 'Carved out of the served margin distribution: each game keeps exactly its served probability on average; tau only makes a series\' games move together.'
    },
    postseason_check: { tau_points: round(tauSeries), ci95: ciSeries.map(round), pairs: sp.length, games: pg.length, method: 'mean product of two games\' residuals within one playoff series, from the same club\'s side' },
    holdout_2025: { club_pairs: cpH.length, tau_points: round(tauOf(cpH)), series_pairs: spH.length, postseason_tau_points: spH.length ? round(sOf(spH)) : null },
    source_files: { data_manifest_sha256: sha256Hex(fs.readFileSync(path.join(REPO, 'basketball', 'data', 'wnba', 'manifest.json'))) }
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('sigma_club ' + doc.club_error.sigma_points + ' (' + cp.length + ' pairs); tau ' + doc.production.tau_points + ' [' + doc.production.ci95.join(', ') + ']; postseason check ' + doc.postseason_check.tau_points + ' [' + doc.postseason_check.ci95.join(', ') + '] (' + sp.length + ' pairs, ' + pg.length + ' games); holdout tau ' + doc.holdout_2025.tau_points + ', postseason ' + doc.holdout_2025.postseason_tau_points + '; sd_margin ' + doc.production.carve_out_sd_margin);
}
function round(x: number) { return Math.round(x * 1e4) / 1e4; }
main();
