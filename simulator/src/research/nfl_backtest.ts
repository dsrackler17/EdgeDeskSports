/* ===========================================================================
   NFL SEASON-SIMULATION BACKTEST — 2010-2025, replayed from as-of weeks.

   For every season S and as-of week w in {4, 8, 12, 16}:
     ratings   the served configuration's state frozen before week w's first
               game (nfl_replay.ts): only games that had kicked off
     weights   fitted on seasons before S only (backtest.js fit)
     margins   the margin table fitted on seasons before S (backtest.js pmfFor)
     QBs       starters only for week w's games (as the live board knows them)
     results   real scores of games before week w; every later game simulated
     rules     the season's own version (6-club field before 2020)
     sigma     the production strength calibration for week w — estimated on
               2006-2024, so 2010-2024 are IN-SAMPLE for sigma (descriptive
               only, per simulator/research/registration.json); 2025 is the
               only out-of-sample season
     scores    no point-in-time points model exists, so a points-ranking tie
               is flagged unsupported and coin-tossed (counted)
   Then N seasons are simulated (production sigma, and sigma = 0 as the
   registration's C1 baseline, on the same seed) and scored against what
   happened: division titles and playoff spots (final standings), conference
   titles and the Super Bowl (the postseason games).

   Brier score and log loss (clip [eps, 1 - eps], eps = max(1e-6, 0.5/N)) per
   outcome family, pooled; a calibration table with bin counts; intervals by a
   SEASON-cluster bootstrap, because the four snapshots of one season share
   its outcomes and are not independent. Market baselines: EdgeDesk owns no
   historical Kalshi futures quotes, so that cohort is reported unavailable;
   a closing-market comparison would carry later information and is never
   mixed into these numbers.

     node simulator/src/research/nfl_backtest.ts [--runs 2000] [--workers 4] [--seasons 2010-2025] [--weeks 4,8,12,16]
   Writes simulator/data/nfl_backtest.json. Passing it proves nothing about
   predictive advantage; software tests passing proves less.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO } from '../sports/nfl/model_adapter.ts';
import { frozenReplay } from './nfl_replay.ts';
import { runPlan } from '../core/runner.ts';
import { summarise } from '../core/engine.ts';
import { NFL_2026 } from '../sports/nfl/config.ts';
import { rulesFor } from '../sports/nfl/rules.ts';
import { brier, logLoss, logLossClip } from '../core/stats.ts';
import { streamFor } from '../core/prng.ts';
import type { NflInputData, NflInputGame, PairEntry } from '../sports/nfl/inputs.ts';

const OUT = path.join(REPO, 'simulator', 'data', 'nfl_backtest.json');
const FAMILIES = ['win_division', 'make_playoffs', 'win_conference', 'win_super_bowl'] as const;
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg('--runs', '2000')), WORKERS = Number(arg('--workers', '4'));
const [S0, S1] = arg('--seasons', '2010-2025').split('-').map(Number);
const WEEKS = arg('--weeks', '4,8,12,16').split(',').map(Number);

async function main() {
  const R = frozenReplay(S0, S1);
  const { B, D } = R;
  const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'simulator', 'fixtures', 'nfl_history.json.gz'))).toString('utf8'));
  const UNC = JSON.parse(fs.readFileSync(path.join(REPO, 'simulator', 'data', 'nfl_strength_uncertainty.json'), 'utf8'));
  const FR: Record<string, string> = { STL: 'LA', SD: 'LAC', OAK: 'LV' };
  const fr = (c: string) => FR[c] || c;
  const records: Array<{ season: number; week: number; club: string; family: string; y: 0 | 1; p: number; p0: number }> = [];
  const cellDiag: any[] = [];
  const t0 = Date.now();
  for (let S = S0; S <= S1; S++) {
    const fx = FX.seasons[String(S)];
    const teams = (fx.teams as any[]).map((t) => ({ code: fr(t.code), name: fr(t.code), conference: t.conference as 'AFC' | 'NFC', division: t.division as string }));
    const truth: Record<string, Record<string, 0 | 1>> = {};
    for (const t of fx.teams as any[]) truth[fr(t.code)] = { win_division: t.div_rank === 1 ? 1 : 0, make_playoffs: t.seed ? 1 : 0, win_conference: 0, win_super_bowl: 0 };
    const sb = (fx.postseason as any[]).find((g) => g[1] === 'SB');
    truth[fr(sb[2])].win_conference = 1; truth[fr(sb[3])].win_conference = 1;
    truth[fr(sb[4] > sb[5] ? sb[2] : sb[3])].win_super_bowl = 1;
    const model = B.fit(R.cfg, R.fitRows.filter((r) => r.g.season >= B.FIRST_TRAIN && r.g.season < S));
    const table = B.pmfFor(S);
    const regS = D.games().filter((g: any) => g.season === S && g.type === 'REG');
    /* each club's home venue that season (schedule facts, known in advance) */
    const venue: Record<string, { roof: string; surface: string }> = {};
    for (const t of teams) {
      const hs = regS.filter((g: any) => g.home === t.code && !g.neutral);
      const mode = (k: string) => { const c: Record<string, number> = {}; hs.forEach((g: any) => { c[g[k]] = (c[g[k]] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || null; };
      venue[t.code] = { roof: mode('roof') as string, surface: mode('surface') as string };
    }
    const sbRow = D.games().find((g: any) => g.season === S && g.type === 'SB');
    const sbHome = (S - 1965) % 2 ? 'NFC' : 'AFC';
    const divOf: Record<string, string> = {}; teams.forEach((t) => { divOf[t.code] = t.division; });
    for (const w of WEEKS) {
      const snap = R.snaps[S + ':' + w];
      if (!snap) continue;
      const frozen = JSON.parse(snap); frozen.cfg = R.cfg;
      const sigma = (UNC.by_week as any[]).find((b) => b.as_of_week === Math.min(w, 17)).win_total_calibration.sigma as number;
      const out: { games: NflInputGame[]; pairs: { default: Record<string, Record<string, PairEntry>>; home_off_bye: Record<string, Record<string, PairEntry>>; super_bowl: Record<string, Record<string, PairEntry>> } } = { games: [], pairs: { default: {}, home_off_bye: {}, super_bowl: {} } };
      B.withTable(S, () => {
        for (const g of regS) {
          const done = g.week < w && g.done;
          let m: NflInputGame['model'] = null;
          if (!done) {
            const go = B.gameObj(g);
            if (g.week > w) { go.home_qb_id = null; go.away_qb_id = null; }
            const p = R.price(frozen, model, go, g);
            m = { fair_margin: p.margin, fair_total: p.total, home_win_prob: NaN, quality: 'OK', warnings: [], qb_notes: [] };
          }
          out.games.push({ game_id: g.id, week: g.week, gameday: g.gameday, gametime: g.gametime, home: g.home, away: g.away, neutral: !!g.neutral, div_game: divOf[g.home] === divOf[g.away],
            done, home_score: done ? g.home_score : null, away_score: done ? g.away_score : null, overtime: null, model: m });
        }
        const pair = (h: string, a: string, ctx: 'default' | 'home_off_bye' | 'super_bowl'): PairEntry => {
          const sbx = ctx === 'super_bowl';
          const go = { season: S, week: 19, home: h, away: a, home_rest: sbx ? 14 : ctx === 'home_off_bye' ? 14 : null, away_rest: sbx ? 14 : null,
            roof: sbx ? sbRow.roof : venue[h].roof, surface: sbx ? sbRow.surface : venue[h].surface, div_game: divOf[h] === divOf[a] ? 1 : 0,
            temp: null, wind: null, home_qb_id: null, away_qb_id: null, neutral: sbx, travel: null, close_home_margin: null, home_score: null, away_score: null };
          const p = R.price(frozen, model, go, { neutral: sbx });
          return { m: p.margin, t: p.total };
        };
        for (const h of teams) for (const a of teams) {
          if (h.code === a.code) continue;
          if (h.conference === a.conference) {
            (out.pairs.default[h.code] = out.pairs.default[h.code] || {})[a.code] = pair(h.code, a.code, 'default');
            (out.pairs.home_off_bye[h.code] = out.pairs.home_off_bye[h.code] || {})[a.code] = pair(h.code, a.code, 'home_off_bye');
          } else if (h.conference === sbHome) (out.pairs.super_bowl[h.code] = out.pairs.super_bowl[h.code] || {})[a.code] = pair(h.code, a.code, 'super_bowl');
        }
      });
      const rules = rulesFor(S);
      const cfg = { ...JSON.parse(JSON.stringify(NFL_2026)), season: S, rules_version: rules.id, regular_season_games_per_club: S >= 2021 ? 17 : 16, regular_season_weeks: S >= 2021 ? 18 : 17 };
      cfg.super_bowl.value.designated_home = sbHome;
      const data: NflInputData = { schema: 'edgedesk_sim_nfl_inputs_v1', sport: 'nfl', competition: 'NFL', season: S, config: cfg, teams, games: out.games, as_of_week: w, latest_result_kickoff: null,
        model: { model_version: 'backtest:' + R.PV.model_version + ':walk-forward-' + S, config_sha: R.PV.config_sha, trained_through: S - 1, feature_version: 'nfl_v2', margin_pmf_by_spread: table },
        postseason_pairs: out.pairs, strength: { distribution: 'normal', sigma_points: sigma, sigma_ci95: [sigma, sigma], as_of_week: w, method: 'production calibration', source: 'simulator/data/nfl_strength_uncertainty.json', source_sha256: '' },
        points_model: null, reconciliation: { source: '', source_sha256: null, status: 'OK', mismatches: [], nflverse_current: {} }, code_sha256: {}, board_notes: [] };
      const seed = BigInt(S * 100 + w);
      const prod = await runPlan({ sport: 'nfl', data, seed, runs: RUNS, workers: WORKERS, traceRuns: [] });
      const base = await runPlan({ sport: 'nfl', data, seed, runs: RUNS, workers: WORKERS, traceRuns: [], sigma: 0 });
      const rp = summarise(prod.module, prod.agg), r0 = summarise(base.module, base.agg);
      for (const e of rp) for (const f of FAMILIES) {
        const p0 = (r0.find((x) => x.entity_id === e.entity_id) as any).outcomes[f].probability;
        records.push({ season: S, week: w, club: e.entity_id, family: f, y: truth[e.entity_id][f], p: e.outcomes[f].probability, p0 });
      }
      cellDiag.push({ season: S, week: w, remaining_games: out.games.filter((g) => !g.done).length, sigma, flags: prod.agg.flags, unsupported_runs: prod.agg.flags.tiebreak_unsupported_input || 0 });
      process.stderr.write('season ' + S + ' week ' + w + ' done (' + Math.round((Date.now() - t0) / 1000) + ' s)\n');
    }
  }
  /* scoring */
  const eps = logLossClip(RUNS);
  const score = (rs: typeof records, k: 'p' | 'p0') => {
    const n = rs.length; let b = 0, l = 0;
    for (const r of rs) { b += brier(r[k], r.y); l += logLoss(r[k], r.y, eps); }
    return { n, brier: n ? b / n : null, logloss: n ? l / n : null };
  };
  const seasons = [...new Set(records.map((r) => r.season))];
  const rng = streamFor(20261025n, 0, 96);
  const bootDiff = (rs: typeof records) => {
    const bySeason = new Map<number, typeof records>(); for (const r of rs) { const a = bySeason.get(r.season) || []; a.push(r); bySeason.set(r.season, a); }
    const ss = [...bySeason.keys()], out: number[] = [];
    for (let i = 0; i < 2000; i++) {
      let db = 0, n = 0;
      for (let j = 0; j < ss.length; j++) { for (const r of bySeason.get(ss[rng.nextInt(ss.length)]) as typeof records) { db += brier(r.p, r.y) - brier(r.p0, r.y); n++; } }
      out.push(db / n);
    }
    out.sort((a, b) => a - b);
    return [out[50], out[1949]];
  };
  const calib = (rs: typeof records) => {
    const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, n: 0, mean_p: 0, observed: 0 }));
    for (const r of rs) { const b = bins[Math.min(9, Math.floor(r.p * 10))]; b.n++; b.mean_p += r.p; b.observed += r.y; }
    return bins.map((b) => ({ lo: b.lo, hi: b.lo + 0.1, n: b.n, mean_p: b.n ? Math.round(b.mean_p / b.n * 1e4) / 1e4 : null, observed: b.n ? Math.round(b.observed / b.n * 1e4) / 1e4 : null }));
  };
  const fam: Record<string, unknown> = {};
  for (const f of FAMILIES) {
    const rs = records.filter((r) => r.family === f), ins = rs.filter((r) => r.season <= 2024), ho = rs.filter((r) => r.season === 2025);
    fam[f] = {
      pooled: { production: score(rs, 'p'), sigma0: score(rs, 'p0'), brier_diff_ci95_season_bootstrap: bootDiff(rs) },
      in_sample_for_sigma_2010_2024: { production: score(ins, 'p'), sigma0: score(ins, 'p0') },
      holdout_2025: { production: score(ho, 'p'), sigma0: score(ho, 'p0') },
      by_week: Object.fromEntries(WEEKS.map((w) => [w, { production: score(rs.filter((r) => r.week === w), 'p'), sigma0: score(rs.filter((r) => r.week === w), 'p0') }])),
      calibration_production: calib(rs)
    };
  }
  const doc = {
    schema: 'edgedesk_sim_nfl_backtest_v1', generated_at: new Date().toISOString(), runs_per_cell: RUNS, seasons: [S0, S1], as_of_weeks: WEEKS, seasons_scored: seasons.length,
    method: 'simulator/src/research/nfl_backtest.ts header', log_loss_clip: eps,
    caveats: [
      'Strength sigma was calibrated on 2006-2024: seasons 2010-2024 are in-sample for sigma and descriptive only; 2025 is the only out-of-sample season.',
      'The four as-of snapshots of a season share its outcomes; intervals resample whole seasons.',
      'No point-in-time points model: a points-ranking tie is coin-tossed (counted in cells[].flags).',
      'Postseason rest and venues are the same estimates as production; Super Bowl designated home by the alternation rule.',
      'Market baselines: unavailable (EdgeDesk owns no historical Kalshi futures quotes). Closing-market comparisons are not part of this file.'
    ],
    market_baseline: { status: 'unavailable', reason: 'no historical Kalshi futures quotes are owned; capture starts with sim_futures_quotes' },
    families: fam, cells: cellDiag, runtime_s: Math.round((Date.now() - t0) / 1000)
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('wrote ' + path.relative(REPO, OUT) + ' (' + seasons.length + ' seasons x ' + WEEKS.length + ' weeks, ' + RUNS + ' runs each, ' + doc.runtime_s + ' s)');
  for (const f of FAMILIES) { const x = fam[f] as any; console.log(f.padEnd(16) + ' Brier prod ' + x.pooled.production.brier.toFixed(4) + ' sigma0 ' + x.pooled.sigma0.brier.toFixed(4) + ' diff CI ' + x.pooled.brier_diff_ci95_season_bootstrap.map((v: number) => v.toFixed(4)).join('..') + ' | logloss prod ' + x.pooled.production.logloss.toFixed(4) + ' sigma0 ' + x.pooled.sigma0.logloss.toFixed(4) + ' | 2025 Brier ' + x.holdout_2025.production.brier.toFixed(4) + ' vs ' + x.holdout_2025.sigma0.brier.toFixed(4)); }
}
main().catch((e) => { console.error(e); process.exit(2); });
