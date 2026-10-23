/* ===========================================================================
   DOES THE SERVED NBA MODEL TREAT A PLAYOFF GAME DIFFERENTLY — AND SHOULD IT?

   An audit, not a model change. The simulator prices play-in and playoff
   games with the served model exactly as it prices a regular-season game;
   this file records what that means and what the record says about it.

   WHAT THE MODEL DOES (read from the code and the live parameters):
     - one learned postseason term: the ridge feature `playoff` (1 for play-in
       and playoff games, nba/model/pass.js), coefficient read from
       nba/params/ml_live.json — a home-margin shift fitted on every
       postseason game 2003-04..2025-26, the model's own number;
     - the rotation: the player layer values the projected rotation (who
       played in the club's latest game) at each player's EWM minutes when he
       plays (half-life 8 games, cap 40), scaled to 240 — the same rule in
       April as in June. No playoff minutes concentration is assumed.

   WHAT THE RECORD SAYS: every regular-season, play-in and playoff game of
   2009-10..2025-26, priced OUT OF SAMPLE (season S with parameters rebuilt
   on seasons before S: model_adapter.ts seasonParams) from the walk-forward
   pass rows (one game ahead, the served pass). Per kind of game: the mean
   residual (actual regulation margin minus the mean), the calibration slope
   of the margin on the mean (1 = right spread of strength; > 1 = favourites
   do better than the model says, what a tightened playoff rotation would
   produce), the moneyline log loss, with season-bootstrap intervals.

     node simulator/src/research/nba_postseason_audit.ts
   Output (committed): simulator/data/nba_postseason_audit.json
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, nbaModules, seasonParams, priceRow } from '../sports/nba/model_adapter.ts';
import { NbaGameDist } from '../sports/nba/game_dist.ts';
import { streamFor } from '../core/prng.ts';
import { sha256Hex } from '../core/canonical.ts';

const OUT = path.join(REPO, 'simulator', 'data', 'nba_postseason_audit.json');
const SEASONS = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
const BOOT = 2000;
const round = (v: number, k = 4) => Math.round(v * 10 ** k) / 10 ** k;

interface G { season: number; kind: 'regular' | 'play_in' | 'playoffs'; mu: number; y: number; hw: number; p: number }

async function main() {
  const { WF } = nbaModules();
  const tuning = JSON.parse(fs.readFileSync(WF.TUNING, 'utf8'));
  const rows = await WF.buildRows(tuning);
  const out: G[] = [];
  for (const S of SEASONS) {
    const sp = seasonParams(rows, S, tuning);
    const dist = new NbaGameDist({ calibration: { sd_m: sp.calibration.sd_m }, shape: sp.shape, ot: sp.ot });
    for (const r of rows) {
      if (r.season !== S || !r.y || r.y.reg_margin == null) continue;
      const p = priceRow(sp, r); if (!p) continue;
      const kind = r.type === 'R' ? 'regular' : r.type === 'I' ? 'play_in' : 'playoffs';
      out.push({ season: S, kind, mu: p.mu_m, y: r.y.reg_margin, hw: r.y.hw, p: dist.pHome(p.mu_m) });
    }
    console.error('[nba audit] ' + S + ' priced');
  }
  const stat = (gs: G[]) => {
    const n = gs.length; if (!n) return null;
    const mr = gs.reduce((u, g) => u + (g.y - g.mu), 0) / n;
    const mx = gs.reduce((u, g) => u + g.mu, 0) / n, my = gs.reduce((u, g) => u + g.y, 0) / n;
    let sxy = 0, sxx = 0; for (const g of gs) { sxy += (g.mu - mx) * (g.y - my); sxx += (g.mu - mx) ** 2; }
    const ll = -gs.reduce((u, g) => u + (g.hw ? Math.log(g.p) : Math.log(1 - g.p)), 0) / n;
    const home = gs.reduce((u, g) => u + g.hw, 0) / n, pred = gs.reduce((u, g) => u + g.p, 0) / n;
    return { n, mean_residual: mr, slope: sxy / sxx, log_loss: ll, home_win_rate: home, mean_p_home: pred, mean_mu: mx };
  };
  const bySeason = (kind: string) => SEASONS.map((s) => out.filter((g) => g.season === s && (kind === 'postseason' ? g.kind !== 'regular' : g.kind === kind)));
  const boot = (kind: string) => {
    const per = bySeason(kind); const rng = streamFor(20261023n, 0, 9);
    const mrs: number[] = [], sls: number[] = [];
    for (let b = 0; b < BOOT; b++) {
      const pick: G[] = []; for (let i = 0; i < per.length; i++) pick.push(...per[rng.nextInt(per.length)]);
      const s = stat(pick); if (s) { mrs.push(s.mean_residual); sls.push(s.slope); }
    }
    const q = (xs: number[], a: number) => { const v = xs.slice().sort((x, y) => x - y); return v[Math.floor(a * (v.length - 1))]; };
    return { mean_residual_ci95: [round(q(mrs, 0.025), 3), round(q(mrs, 0.975), 3)], slope_ci95: [round(q(sls, 0.025), 3), round(q(sls, 0.975), 3)] };
  };
  const fmt = (s: ReturnType<typeof stat>) => s && { n: s.n, mean_residual: round(s.mean_residual, 3), calibration_slope: round(s.slope, 3), log_loss: round(s.log_loss), home_win_rate: round(s.home_win_rate), mean_p_home: round(s.mean_p_home), mean_mu: round(s.mean_mu, 3) };
  const ml = JSON.parse(fs.readFileSync(WF.ML_LIVE, 'utf8')).models.P;
  const j = ml.features.indexOf('playoff');
  const doc = {
    schema: 'edgedesk_nba_postseason_audit_v1', generated_at: new Date().toISOString(),
    model: { chosen: 'E_ridge_P', playoff_feature: { coefficient_points_home_margin: round(ml.ridge_m[j + 1], 4), training_mean: round(ml.mean[j], 4), trained_through: ml.trained_through, note: 'the ridge margin model\'s own postseason term (nba/params/ml_live.json): a learned home-margin shift on play-in and playoff games, applied by the simulator as the served model applies it' },
      rotation: 'player layer: projected rotation = the club\'s latest game; minutes = each player\'s EWM when he plays (half-life 8 games, cap 40), scaled to 240 (nba/model/players.js strength). No postseason minutes concentration.' },
    seasons: SEASONS,
    regular: { ...fmt(stat(out.filter((g) => g.kind === 'regular'))), ...boot('regular') },
    play_in: fmt(stat(out.filter((g) => g.kind === 'play_in'))),
    playoffs: { ...fmt(stat(out.filter((g) => g.kind === 'playoffs'))), ...boot('playoffs') },
    postseason: { ...fmt(stat(out.filter((g) => g.kind !== 'regular'))), ...boot('postseason') },
    reading: 'mean_residual > 0: the home club does better than the model says; calibration_slope > 1: the better club does better than the model says (a tightened rotation would show here). Intervals are a season bootstrap (' + BOOT + ' resamples).',
    code_sha256: { 'nba/model/pass.js': sha256Hex(fs.readFileSync(path.join(REPO, 'nba', 'model', 'pass.js'))), 'nba/params/ml_live.json': sha256Hex(fs.readFileSync(WF.ML_LIVE)) }
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(JSON.stringify({ regular: doc.regular, playoffs: doc.playoffs, play_in: doc.play_in }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
