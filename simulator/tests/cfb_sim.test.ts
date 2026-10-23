/* One simulated CFB season, end to end, on the committed 2026 snapshot
   (simulator/fixtures/cfb_2026_wk7_snapshot.json.gz): format sums, worker
   independence, completed results fixed, ineligibility, clinched/eliminated
   and undefeated cases, per-game probabilities preserved for big favourites,
   the persistent offset's correlation, every CFP mode, an observed bracket
   and an observed title game replacing simulation, and the command line. */
import { kit } from './_kit.ts';
import { cfbFixture, clone, CFB_FIXTURE } from './_cfb.ts';
import { cfbModule, cfpMode } from '../src/sports/cfb/module.ts';
import { cfbMathStatus } from '../src/sports/cfb/status.ts';
import { runRange, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { normalCdf } from '../src/core/normal.ts';
import { execute, parseArgs } from '../src/cli/run.ts';
import type { CfbInputData } from '../src/sports/cfb/inputs.ts';

const T = kit('CFB season simulation');
const snap = cfbFixture(), D = snap.data;
const seed = 0x5eedn;
const N = 1500;
const stat = (m: any, agg: any, team: string, key: string) => {
  const e = m.entities.findIndex((x: any) => x.name === team), o = m.outcomes.findIndex((x: any) => x.key === key);
  return agg.counts[e * m.outcomes.length + o];
};

/* 1 the format sums hold in every run (runRange throws on the first violation), determinism */
const m = cfbModule(D, { seed });
T.eq('the committee proxy is the CFP mode for this snapshot (validated, same engine)', m.mode, 'proxy');
const a1 = runRange(m, { start: 0, end: N });
T.eq('no sum-rule violation in ' + N + ' runs (2 per title game, 12-team field, 4 byes, one champion)', a1.violations.length, 0);
T.chk('the SEC\'s scoring-margin step always finds its Estimated scores (non-conference games without a total are never needed)', !Object.keys(a1.flags).some((k) => k.startsWith('ccg_points_unavailable')), a1.flags);
T.chk('the SEC\'s scoring-margin step is reached in some runs (it is exercised)', (a1.flags['ccg_estimated_points:SEC'] || 0) > 0, a1.flags);
const a2 = runRange(cfbModule(D, { seed }), { start: 0, end: N });
T.eq('same seed, same counts', a1.counts.join(), a2.counts.join());
const a3 = runRange(cfbModule(D, { seed: seed + 1n }), { start: 0, end: 300 });
T.chk('another seed, other counts', a3.counts.slice(0, 400).join() !== runRange(cfbModule(D, { seed }), { start: 0, end: 300 }).counts.slice(0, 400).join());
const s1 = await runPlan({ sport: 'cfb', data: D, seed, runs: 900, workers: 1, traceRuns: [] });
const s3 = await runPlan({ sport: 'cfb', data: D, seed, runs: 900, workers: 3, traceRuns: [] });
T.eq('1 worker and 3 workers give identical counts', s1.agg.counts.join(), s3.agg.counts.join());

/* 2 completed results are fixed: only unplayed games are ever drawn */
{
  const open = new Set(D.games.filter((g) => !g.done).map((g) => g.game_id));
  let drawn = 0, foreign = 0;
  const mm = cfbModule(D, { seed, observe: (ev) => { if (ev.phase === 'regular') { drawn++; if (!open.has(ev.game)) foreign++; } } });
  runRange(mm, { start: 0, end: 20 });
  T.eq('every run draws exactly the ' + open.size + ' unplayed regular-season games and no completed one', [drawn, foreign], [20 * open.size, 0]);
}
/* 3 ineligibility: Sacramento State never plays for the MAC title */
T.eq('Sacramento State (ineligible for the MAC title game) never reaches it', stat(m, a1, 'Sacramento State', 'ccg_appearance'), 0);
T.chk('an ineligible team can still be ranked and play in the CFP field (cfp_eligible) — its outcome exists', m.outcomes.some((o) => o.key === 'cfp_field'));
/* 4 the mathematical status agrees with the simulation */
{
  const st = cfbMathStatus(D);
  T.chk('no team is mathematically eliminated or clinched at week 7 that the simulation contradicts', D.teams.every((t) => st[t.id].ccg === 'eliminated' ? stat(m, a1, t.name, 'ccg_appearance') === 0 : st[t.id].ccg === 'clinched' ? stat(m, a1, t.name, 'ccg_appearance') === N : true));
  T.chk('independents have no title game', D.teams.filter((t) => t.conference === 'FBS Independents').every((t) => st[t.id].ccg === 'no_title_game'));
  /* every remaining MAC game played (home teams win): the table is final, so status is decided for most teams */
  const d3: CfbInputData = clone(D);
  for (const g of d3.games) if (!g.done && g.conf === 'Mid-American') { g.done = true; g.home_points = 28; g.away_points = 14; g.model = null; }
  const st3 = cfbMathStatus(d3);
  const mac = d3.teams.filter((t) => t.conference === 'Mid-American');
  const elim = mac.filter((t) => st3[t.id].ccg === 'eliminated'), clin = mac.filter((t) => st3[t.id].ccg === 'clinched');
  T.chk('a final MAC table: most teams eliminated (' + elim.length + '), some clinched (' + clin.length + ')', elim.length >= 8 && clin.length + mac.filter((t) => st3[t.id].ccg === 'alive').length >= 2, { elim: elim.length, clin: clin.map((t) => t.name) });
  const m3 = cfbModule(d3, { seed }), a3m = runRange(m3, { start: 0, end: 400 });
  T.chk('no eliminated MAC team ever reaches the title game', elim.every((t) => stat(m3, a3m, t.name, 'ccg_appearance') === 0), elim.filter((t) => stat(m3, a3m, t.name, 'ccg_appearance') > 0).map((t) => t.name));
  T.chk('every clinched MAC team reaches it in every run', clin.every((t) => stat(m3, a3m, t.name, 'ccg_appearance') === 400), clin.map((t) => [t.name, stat(m3, a3m, t.name, 'ccg_appearance')]));
}
/* 5 an undefeated, clinched team: James Madison wins out (its remaining games set as played wins) */
{
  const d2: CfbInputData = clone(D);
  const jmu = d2.teams.findIndex((t) => t.name === 'James Madison');
  for (const g of d2.games) if (!g.done && (g.home === jmu || g.away === jmu)) { g.done = true; g.home_points = g.home === jmu ? 35 : 10; g.away_points = g.home === jmu ? 10 : 35; g.model = null; }
  const st = cfbMathStatus(d2);
  T.eq('James Madison winning out has clinched the Sun Belt East', st[d2.teams[jmu].id].ccg, 'clinched');
  const mm = cfbModule(d2, { seed }), ag = runRange(mm, { start: 0, end: 400 });
  T.eq('a clinched team reaches its title game in every run', stat(mm, ag, 'James Madison', 'ccg_appearance'), 400);
  const res = summarise(mm, ag).find((e) => e.entity_name === 'James Madison')!;
  const maxBin = res.value_hist.length - 1, top = res.value_hist.findIndex((c) => c > 0);
  T.chk('an undefeated team finishes the regular season undefeated in every run', res.value_hist.filter((c) => c > 0).length === 1 && res.value_hist[top] === 400 && top <= maxBin, res.value_hist);
  T.chk('an undefeated Sun Belt champion is never unranked out of the field: it makes the CFP in nearly every run (Estimated)', stat(mm, ag, 'James Madison', 'cfp_field') >= 0.9 * 400, stat(mm, ag, 'James Madison', 'cfp_field'));
}
/* 6 per-game probabilities are the engine's, big favourites included, however many runs */
{
  const R = 20000, wins = new Map<string, number>();
  const mm = cfbModule(D, { seed: 77n, mode: 'off', observe: (ev) => { if (ev.phase === 'regular' && ev.margin > 0) wins.set(ev.game, (wins.get(ev.game) || 0) + 1); } });
  const ag = runRange(mm, { start: 0, end: R });
  const open = D.games.filter((g) => !g.done);
  let worst = 0, sumP = 0, sumW = 0, n = 0, favs = 0;
  for (const g of open) {
    const p = normalCdf(g.model!.fair / g.model!.sigma), w = (wins.get(g.game_id) || 0) / R;
    const fav = Math.max(p, 1 - p);
    const z = (w - p) / Math.sqrt(Math.max(p * (1 - p), 1e-6) / R);
    worst = Math.max(worst, Math.abs(z));
    if (fav >= 0.9) { favs++; sumP += fav; sumW += p >= 0.5 ? w : 1 - w; n++; }
  }
  T.chk('every remaining game\'s simulated home-win rate matches the engine\'s Phi(fair/sigma) (max |z| ' + worst.toFixed(2) + ' over ' + open.length + ' games)', worst < 4.5, worst);
  T.near('favourites at 90%+ (' + favs + ' games) win at the engine\'s rate: simulation volume adds no confidence', sumW / n, sumP / n, 4 * Math.sqrt((sumP / n) * (1 - sumP / n) / (n * R)) + 1e-4);
  /* the persistent offset correlates a team's games: simulated remaining-win variance exceeds the independent-game variance */
  const res = summarise(mm, ag);
  let vSim = 0, vInd = 0;
  for (const e of res) {
    const t = D.teams.findIndex((x) => x.id === e.entity_id);
    let ind = 0, cnt = 0;
    for (const g of open) if (g.home === t || g.away === t) { const p = normalCdf(g.model!.fair / g.model!.sigma); ind += p * (1 - p); cnt++; }
    if (cnt < 4) continue;
    const mean = e.value_hist.reduce((a, c, b) => a + c * b / 2, 0) / R, v = e.value_hist.reduce((a, c, b) => a + c * (b / 2 - mean) ** 2, 0) / R;
    vSim += v; vInd += ind;
  }
  T.chk('the persistent strength offset spreads win totals beyond independent games (ratio ' + (vSim / vInd).toFixed(3) + ')', vSim / vInd > 1.15, vSim / vInd);
  const m0 = cfbModule(D, { seed: 78n, tau: 0, mode: 'off' }), a0 = runRange(m0, { start: 0, end: 6000 });
  let v0 = 0, i0 = 0;
  for (const e of summarise(m0, a0)) {
    const t = D.teams.findIndex((x) => x.id === e.entity_id);
    let ind = 0, cnt = 0;
    for (const g of open) if (g.home === t || g.away === t) { const p = normalCdf(g.model!.fair / g.model!.sigma); ind += p * (1 - p); cnt++; }
    if (cnt < 4) continue;
    const mean = e.value_hist.reduce((a, c, b) => a + c * b / 2, 0) / 6000, v = e.value_hist.reduce((a, c, b) => a + c * (b / 2 - mean) ** 2, 0) / 6000;
    v0 += v; i0 += ind;
  }
  T.near('with tau = 0 the games are independent (variance ratio ' + (v0 / i0).toFixed(3) + ')', v0 / i0, 1, 0.05);
}
/* 7 the CFP modes */
{
  const off = clone(D); off.committee = null;
  const mo = cfbModule(off, { seed });
  T.eq('without a committee proxy: no CFP and no national-title outcome at all', [mo.mode, mo.outcomes.map((o) => o.key)], ['off', ['ccg_appearance', 'ccg_seed_1', 'conf_champion']]);
  T.chk('proxy mode: every CFP outcome is Estimated, every conference outcome Research', m.outcomes.every((o) => (o.key.startsWith('ccg') || o.key === 'conf_champion') ? o.provenance === 'Research' : o.provenance === 'Estimated'));
  const failed = clone(D); failed.committee.by_as_of_week['7'].decision.defensible = false;
  T.eq('a proxy that failed its pre-registered validation is not used', cfpMode(failed).mode, 'off');
  const other = clone(D); other.committee.engine_model_version = 'edgedesk_cfb_p4_v0.9';
  T.eq('a proxy fitted on another engine version is not used', cfpMode(other).mode, 'off');
  /* an OBSERVED bracket: the seeds are facts, the proxy is never used, completed playoff games are fixed */
  const ob: CfbInputData = clone(D);
  const top = ['Miami', 'Ohio State', 'Indiana', 'Notre Dame', 'BYU', 'Ole Miss', 'Texas Tech', 'Georgia', 'UCLA', 'Utah', 'Wake Forest', 'James Madison'];
  ob.cfp_bracket = { schema: 'edgedesk_sim_cfb_cfp_bracket_v1', season: 2026, status: 'observed', label: 'TEST', seeds: top, source_url: 'https://collegefootballplayoff.com/', announced_at: '2026-12-06', assumptions: [] };
  const ix = (n: string) => ob.teams.findIndex((t) => t.name === n);
  ob.postseason_feed.push({ game_id: 'T1', kind: 'cfp', conference: null, round: 'College Football Playoff First Round Game', kickoff: '2026-12-19T20:00:00.000Z', home: ix('BYU'), away: ix('James Madison'), neutral: false, done: true, home_points: 20, away_points: 27, notes: 'College Football Playoff First Round Game' });
  const mob = cfbModule(ob, { seed }), aob = runRange(mob, { start: 0, end: 600, traceRuns: [0] });
  T.eq('observed bracket mode', mob.mode, 'observed');
  T.chk('observed bracket: every seed is its announced team in every run', top.every((n, k) => stat(mob, aob, n, 'cfp_seed_' + (k + 1)) === 600));
  T.chk('observed bracket: the field and seeds are Observed, the games Research', mob.outcomes.find((o) => o.key === 'cfp_field')!.provenance === 'Observed' && mob.outcomes.find((o) => o.key === 'national_champion')!.provenance === 'Research');
  T.eq('observed bracket: the completed 5v12 game is preserved (James Madison advances in every run, BYU never)', [stat(mob, aob, 'James Madison', 'reach_qf'), stat(mob, aob, 'BYU', 'reach_qf')], [600, 0]);
  T.chk('observed bracket: the committee proxy is never consulted', !aob.traces[0].events.some((e: any) => e.type === 'committee_top25'));
  /* a SCENARIO bracket: every CFP output carries its assumptions */
  const sc: CfbInputData = clone(ob); sc.cfp_bracket.status = 'scenario'; sc.cfp_bracket.label = 'chalk'; sc.cfp_bracket.assumptions = ['the twelve teams ranked as listed'];
  const msc = cfbModule(sc, { seed });
  T.chk('scenario bracket: every CFP outcome is labelled CONDITIONAL on the stated assumptions', msc.outcomes.filter((o) => o.key.startsWith('cfp') || o.key.startsWith('reach') || o.key === 'national_champion').every((o) => /assumptions: the twelve teams/.test(o.conditional_on || '')));
}
/* 8 an observed conference title game fixes its participants and result */
{
  const ob: CfbInputData = clone(D);
  const ix = (n: string) => ob.teams.findIndex((t) => t.name === n);
  ob.postseason_feed.push({ game_id: 'T2', kind: 'ccg', conference: 'SEC', round: 'SEC Championship', kickoff: '2026-12-05T21:00:00.000Z', home: ix('Alabama'), away: ix('Tennessee'), neutral: true, done: true, home_points: 17, away_points: 24, notes: 'SEC Championship' });
  const mm = cfbModule(ob, { seed }), ag = runRange(mm, { start: 0, end: 300 });
  T.eq('an observed SEC title game fixes its participants (both in every run) and its winner', [stat(mm, ag, 'Alabama', 'ccg_appearance'), stat(mm, ag, 'Tennessee', 'ccg_appearance'), stat(mm, ag, 'Tennessee', 'conf_champion'), stat(mm, ag, 'Georgia', 'ccg_appearance')], [300, 300, 300, 0]);
}
/* 9 the command line, replaying the committed snapshot */
{
  const args = parseArgs(['--sport', 'cfb', '--season', '2026', '--snapshot', CFB_FIXTURE, '--runs', '400', '--workers', '2', '--dry-run', '--out', '/tmp/edgedesk-sim-cfb-test', '--trace-runs', '0']);
  const o: any = await execute(args, () => {});
  T.eq('cli: the replayed run simulates every run', o.results.run.n_sims, 400);
  T.chk('cli: the code identity of the snapshot matches the engine', o.gates.find((g: any) => g.id === 'replay.code_identity').status === 'PASS');
  T.chk('cli: CFB is not publishable while facts are unverified (sport.active and the per-conference gates block)', !o.publishable && o.gates.find((g: any) => g.id === 'sport.active').status === 'FAIL');
  T.eq('cli: every conference carries its rules status', o.results.cfb.conferences.map((c: any) => c.status).sort().filter((x: string, i: number, a: string[]) => a.indexOf(x) === i), ['PROVISIONAL_RULES', 'UNVERIFIED_RULES', 'VERIFIED_RULES']);
  T.chk('cli: the three uncertainty layers are stated separately', ['game_results', 'conference_qualification', 'committee'].every((k) => typeof o.results.cfb.uncertainty_layers[k] === 'string'));
  T.chk('cli: CFP outcomes are Estimated in the results document', o.results.entities[0].outcomes.cfp_field.provenance === 'Estimated' && o.results.entities[0].outcomes.conf_champion.provenance === 'Research');
}
process.exitCode = T.done();
