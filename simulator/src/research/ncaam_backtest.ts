/* ===========================================================================
   NCAA tournament backtest: advancement probabilities from the frozen model,
   scored against what happened, 2011-2026 (2020 cancelled).

     node simulator/src/research/ncaam_backtest.ts [--runs 20000] [--workers 4]
       -> basketball/ncaam_forecast/validation/tournament_backtest.json

   Per season: the bracket exactly as played (tournament.js reconstruction:
   real pairings, fixed paths, no reseeding), the champion-candidate model
   (the frozen development selection) built 30 minutes before the first First
   Four tip from data available by then, simulated twice on the same seed:
     V      the measured persistent strength variance (strength.js)
     V = 0  no persistent strength draw (every game independent)
   Outcomes scored (Brier; log loss with probabilities clipped at
   max(1e-6, 0.5/N), documented): reach R32, Sweet 16, Elite 8, Final Four,
   the title game, and win the title, for every entrant.
   DEPENDENCE: the 63-67 games of one tournament share one season, so the
   unit of evidence is the SEASON. Differences carry a season-cluster
   bootstrap interval; one tournament is never treated as many independent
   trials. DEVELOPMENT tournaments (2011-2019, 2021-2023) and the final
   HOLDOUT (2024-2026) are reported separately; the holdout is scored here
   once and is never used to choose anything.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runPlan } from '../core/runner.ts';
import { summarise } from '../core/engine.ts';
import { logLossClip, brier, logLoss } from '../core/stats.ts';
import { buildNcaamSnapshot, REPO } from '../sports/ncaam/inputs.ts';
import { outcomeKey } from '../sports/ncaam/module.ts';

const req = createRequire(import.meta.url);
const FC = (m: string) => req(path.join(REPO, 'basketball', 'ncaam_forecast', m));
const OUT = path.join(REPO, 'basketball', 'ncaam_forecast', 'validation', 'tournament_backtest.json');
const HOLDOUT = [2024, 2025, 2026];
const FAMILIES = ['R32', 'S16', 'E8', 'F4', 'NC'].map(outcomeKey).concat(['win_title']);

function arg(k: string, d: string): string { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; }

function realized(bracket: any): Map<string, Set<string>> {
  /* outcome keys each team achieved in the real tournament */
  const out = new Map<string, Set<string>>();
  const add = (t: string, k: string) => { if (!out.has(t)) out.set(t, new Set()); out.get(t)!.add(k); };
  const winners = new Map<string, string>();
  const order = bracket.slots.slice().sort((a: any, b: any) => bracket.rounds.indexOf(a.round) - bracket.rounds.indexOf(b.round));
  for (const s of order) {
    const who = (x: any) => (x.team != null ? x.team : winners.get(x.winnerOf));
    const a = who(s.a), b = who(s.b);
    add(a, outcomeKey(s.round)); add(b, outcomeKey(s.round));
    winners.set(s.id, s.winner);
  }
  const root = order[order.length - 1]; add(winners.get(root.id) as string, 'win_title');
  for (const t of Object.keys(bracket.entrants)) if (!out.has(t)) out.set(t, new Set());
  return out;
}

function bootstrapSeasons(diffBySeason: Array<{ season: number; d: number; n: number }>, B = 2000): [number, number] {
  let s = 12345; const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const stats: number[] = [];
  for (let b = 0; b < B; b++) { let sum = 0, n = 0; for (let i = 0; i < diffBySeason.length; i++) { const x = diffBySeason[Math.floor(rnd() * diffBySeason.length)]; sum += x.d; n += x.n; } stats.push(sum / n); }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * B)], stats[Math.floor(0.975 * B)]];
}

async function main() {
  const runs = Number(arg('runs', '20000')), workers = Number(arg('workers', '4'));
  const DS = FC('dataset.js'), MD = FC('model.js'), TT = FC('tournament.js'), W = FC('weekly.js');
  const t0 = Date.now();
  const games = DS.load();
  const cfg = W.selectionConfig();
  const walk = MD.researchRows(DS.engineGames(games.filter((g: any) => g.season <= 2026)), cfg);
  const seasons: number[] = []; for (let s = 2011; s <= 2026; s++) if (s !== 2020) seasons.push(s);
  const eps = logLossClip(runs);
  const perSeason: any[] = []; const calib: Array<{ p: number; y: number; arm: string; season: number; outcome: string }> = [];
  for (const season of seasons) {
    const cache = { rows: walk.rows.filter((r: any) => r.season < season), states: walk.states };
    const snap = buildNcaamSnapshot({ season, mode: 'historical', modelSource: 'selection', cacheWalk: cache, games });
    const real = realized(TT.reconstructBracket(games, season, { withResults: true }));
    const seed = BigInt('0x' + snap.input_hash.slice(0, 16));
    const arms: Record<string, any> = {};
    for (const [arm, sigma] of [['V', undefined], ['V0', 0]] as Array<[string, number | undefined]>) {
      const { agg, module } = await runPlan({ sport: 'ncaam', data: snap.data, seed, runs, workers, traceRuns: [], sigma });
      const ents = summarise(module, agg);
      /* per family: Brier and log-loss sums over entrants. The forecast sum of a
         family equals its slot count by construction (sum rules), so it is a
         CHECK here (sum_rule_ok), never reported as calibration evidence */
      const fam: Record<string, { brier: number; ll: number; n: number; sum_rule_ok?: boolean }> = {};
      const sums: Record<string, { p: number; y: number }> = {};
      for (const k of FAMILIES) { fam[k] = { brier: 0, ll: 0, n: 0 }; sums[k] = { p: 0, y: 0 }; }
      for (const e of ents) for (const k of FAMILIES) {
        const p = e.outcomes[k].probability; const y = real.get(e.entity_id)!.has(k) ? 1 : 0;
        fam[k].brier += brier(p, y as 0 | 1); fam[k].ll += logLoss(p, y as 0 | 1, eps); fam[k].n++; sums[k].p += p; sums[k].y += y;
        calib.push({ p, y, arm, season, outcome: k });
      }
      for (const k of FAMILIES) fam[k].sum_rule_ok = Math.abs(sums[k].p - sums[k].y) < 1e-6;
      const champ = ents.slice().sort((a, b) => b.outcomes.win_title.probability - a.outcomes.win_title.probability);
      const winner = [...real.entries()].find(([, s]) => s.has('win_title'))![0];
      arms[arm] = { families: fam, top3: champ.slice(0, 3).map((e) => [e.entity_name, +e.outcomes.win_title.probability.toFixed(4)]),
        champion: { team: champ.find((e) => e.entity_id === winner)!.entity_name, p_title: +champ.find((e) => e.entity_id === winner)!.outcomes.win_title.probability.toFixed(4), rank: champ.findIndex((e) => e.entity_id === winner) + 1 } };
    }
    perSeason.push({ season, split: HOLDOUT.includes(season) ? 'holdout' : 'development', entrants: snap.data.teams.length, as_of: snap.meta.as_of, input_hash: snap.input_hash, notes: snap.meta.notes, V: snap.data.strength.variance[0], arms });
    console.log('[ncaam backtest] ' + season + ' champion ' + arms.V.champion.team + ' p ' + arms.V.champion.p_title + ' (rank ' + arms.V.champion.rank + ') · title Brier V ' + arms.V.families.win_title.brier.toFixed(4) + ' V0 ' + arms.V0.families.win_title.brier.toFixed(4));
  }
  const summary: any = {};
  for (const split of ['development', 'holdout']) {
    const S = perSeason.filter((x) => x.split === split); summary[split] = { seasons: S.map((x) => x.season), families: {} };
    for (const k of FAMILIES) {
      const tot = (arm: string, f: 'brier' | 'll') => S.reduce((a, x) => a + x.arms[arm].families[k][f], 0) / S.reduce((a, x) => a + x.arms[arm].families[k].n, 0);
      const diffs = S.map((x) => ({ season: x.season, d: x.arms.V.families[k].brier - x.arms.V0.families[k].brier, n: x.arms.V.families[k].n }));
      summary[split].families[k] = { brier_V: +tot('V', 'brier').toFixed(5), brier_V0: +tot('V0', 'brier').toFixed(5), log_loss_V: +tot('V', 'll').toFixed(5), log_loss_V0: +tot('V0', 'll').toFixed(5),
        diff_brier_V_minus_V0: +(diffs.reduce((a, x) => a + x.d, 0) / diffs.reduce((a, x) => a + x.n, 0)).toFixed(6), ci95_season_bootstrap: bootstrapSeasons(diffs).map((v) => +v.toFixed(6)),
        seasons: S.length, note: S.length < 5 ? 'fewer than 5 seasons: the season bootstrap interval is fragile' : undefined };
    }
  }
  /* reliability of every advancement probability (V arm), pooled, with counts */
  const bins = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.000001];
  const rel = (split: string) => bins.slice(0, -1).map((lo, i) => {
    const xs = calib.filter((c) => c.arm === 'V' && (HOLDOUT.includes(c.season) ? 'holdout' : 'development') === split && c.p >= lo && c.p < bins[i + 1]);
    return { band: lo + '-' + Math.min(1, bins[i + 1]), n: xs.length, mean_forecast: xs.length ? +(xs.reduce((a, c) => a + c.p, 0) / xs.length).toFixed(4) : null, observed: xs.length ? +(xs.reduce((a, c) => a + c.y, 0) / xs.length).toFixed(4) : null };
  });
  const doc = { schema: 'edgedesk_ncaam_fc_tournament_backtest_v1', generated_at: new Date().toISOString(), runs_per_arm: runs, log_loss_clip: eps,
    model: { source: 'config/selection_v1.json (frozen development selection)', selection_hash: cfg.selection_hash }, families: FAMILIES,
    dependence: 'one season = one unit of evidence; intervals bootstrap seasons, never games or teams', per_season: perSeason, summary,
    reliability: { development: rel('development'), holdout: rel('holdout') }, runtime_s: Math.round((Date.now() - t0) / 1000) };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('[ncaam backtest] wrote ' + path.relative(REPO, OUT) + ' in ' + doc.runtime_s + ' s');
  for (const split of ['development', 'holdout']) for (const k of FAMILIES) console.log('  ' + split.padEnd(11) + k.padEnd(10) + JSON.stringify(summary[split].families[k]));
}

main().catch((e) => { console.error(e); process.exit(1); });
