/* UFC fights and title-path simulation:
   - the gamma gap helpers (known values, the quantile table inverts the CDF, unit mean)
   - the module on a SYNTHETIC two-division fixture: sum rules (one winner per bout, one champion per division
     per run), every booked bout keeps its probability exactly (win share, finish share, round distribution),
     title-path invariants checked run by run from the traces (a champion who loses is no longer champion; each
     title fight's champion is the reigning one; each challenger comes off a win and has rested the minimum; no
     title fight before the renewal's earliest date or after the horizon; no title without a shot), the rank rule
     (a lower-ranked winner takes the loser's place and gets the next shot), the reader summary agrees with the
     per-fighter counts
   - determinism and worker-count independence
   - the input gates on mutated snapshots
   - the committed data: the snapshot builds, the Elo port reproduces every published price, ufc.com's champions,
     the four booked title fights, a 4,000-run execution, the registry and the nightly plan */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kit } from './_kit.ts';
import { ufcModule, gammaP, gammaUnit, lnGamma, OUTCOMES } from '../src/sports/ufc/module.ts';
import { buildUfcSnapshot, readUfcSnapshot, writeUfcSnapshot, type UfcInputData, type UfcSnapshot } from '../src/sports/ufc/inputs.ts';
import { validateUfcInputs, executeUfc, readerSummary } from '../src/sports/ufc/run.ts';
import { runRange, checkAggregateSums, type RunMarks } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { buildResults } from '../src/core/results.ts';
import { hashCanonical } from '../src/core/canonical.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns } from '../src/cli/plan.ts';

const K = kit('UFC simulation');
const DAY = 86400000;

/* ---- gamma helpers ---- */
K.near('lnGamma(5) = ln 24', lnGamma(5), Math.log(24), 1e-12);
K.near('lnGamma(0.5) = ln sqrt(pi)', lnGamma(0.5), 0.5 * Math.log(Math.PI), 1e-12);
K.near('P(1, x) = 1 - exp(-x)', gammaP(1, 0.7), 1 - Math.exp(-0.7), 1e-12);
K.near('P(3, 2) (series side)', gammaP(3, 2), 1 - Math.exp(-2) * (1 + 2 + 2), 1e-12);
K.near('P(2, 9) (continued-fraction side)', gammaP(2, 9), 1 - Math.exp(-9) * (1 + 9), 1e-12);
{
  const G = gammaUnit(4.5);
  let worst = 0; for (const u of [0.01, 0.1, 0.33, 0.5, 0.77, 0.95, 0.999]) worst = Math.max(worst, Math.abs(G.cdf(G.quantile(u)) - u));
  K.chk('the quantile table inverts the CDF (max error ' + worst.toExponential(1) + ')', worst < 2e-4, worst);
  let m = 0; const n = 20000; for (let i = 0; i < n; i++) m += G.quantile((i + 0.5) / n); m /= n;
  K.near('the unit gamma has mean 1', m, 1, 0.005);
}

/* ---- SYNTHETIC fixture: two divisions, five booked bouts ---- */
type F = UfcInputData['fighters'][number];
const fighter = (id: string, division: string, o: Partial<F> = {}): F => ({ id, name: 'Fighter ' + id, division, ranked_division: division, rank: null, champion: false, moved_from: null,
  rating: 1500, bouts: 10, debut: false, last_fight: '2026-06-01T00:00:00.000Z', last_result: 'W', record: { w: 8, l: 2, d: 0 }, fin_win: 0, fin_loss: 0, ...o });
function synth(): UfcInputData {
  const LW = 'Lightweight', WF = 'W Flyweight';
  const fighters: F[] = [
    fighter('LC', LW, { champion: true, rating: 1700 }), fighter('L1', LW, { rank: 1, rating: 1680 }), fighter('L2', LW, { rank: 2, rating: 1600, last_result: 'L' }), fighter('L3', LW, { rank: 3, rating: 1580 }), fighter('L4', LW, { rank: 4, rating: 1620, last_result: 'L' }),
    fighter('WC', WF, { champion: true, rating: 1650 }), fighter('W1', WF, { rank: 1, rating: 1600 }), fighter('W2', WF, { rank: 2, rating: 1560 }), fighter('W3', WF, { rank: 3, rating: 1540 }),
    fighter('U1', LW, { ranked_division: null, rank: null }), fighter('U2', LW, { ranked_division: null, rank: null, debut: true, bouts: 0, last_fight: null, last_result: null, record: { w: 0, l: 0, d: 0 } }),
    fighter('M1', LW, { ranked_division: WF, rank: null, moved_from: null })
  ];
  const bout = (id: string, start: string, a: string, b: string, p: number, division: string, o: Partial<UfcInputData['bouts'][number]> = {}) => ({ bout_id: id, event_id: 'E' + start.slice(5, 7), event: 'SYNTHETIC ' + start.slice(0, 10), start,
    weight_class: division, division, rounds: 3, order: 3, a, b, p_a: p, p_a_published: null, basis: 'elo' as const, title: null, finish_if_a: 0.55, finish_if_b: 0.35, round_dist: [0.5, 0.3, 0.2], ...o });
  const bouts = [
    bout('B1', '2026-11-01T02:00:00Z', 'LC', 'L1', 0.58, LW, { rounds: 5, order: 1, title: { division: LW, champion: 'LC' }, round_dist: [0.36, 0.27, 0.19, 0.1, 0.08], finish_if_a: 0.6, finish_if_b: 0.5 }),
    bout('B2', '2026-11-01T01:00:00Z', 'U1', 'U2', 0.62, LW),
    bout('B3', '2026-11-08T01:00:00Z', 'W3', 'W1', 0.7, WF),          // #3 v #1: the rank rule
    bout('B4', '2026-11-15T01:00:00Z', 'L3', 'M1', 0.5, LW),
    bout('B5', '2026-11-22T01:00:00Z', 'WC', 'L2', 0.5, LW)          // another division's champion booked here: never enters this title path
  ];
  const rate = (division: string, n: number) => ({ division, window: { from: '2021-10-18', to: '2026-10-18', years: 5 }, title_fights: n, per_year: n / 5, interim_fights: 0, last_title_fight: '2026-06-01', incumbent: null, incumbent_since: null, champion_fights: n, champion_won: n, champion_lost: 0, draws_nc: 0 });
  const div = (key: string, champion: string, contenders: string[], booked: string | null, start: string, minGap: number, n: number) => ({ key, label: key, champion, contenders, moved_out: [], rate: rate(key, n),
    mean_gap_days: 365.25 / (n / 5), booked_title: booked, renewal: { start, min_gap_days: minGap, basis: 'SYNTHETIC' }, finish_5: 0.6, round_dist_5: [0.36, 0.27, 0.19, 0.1, 0.08] });
  return {
    sport: 'ufc', season: 2026, competition: 'UFC Fights and Title Path', as_of: '2026-10-18T00:00:00.000Z', horizon: { from: '2026-10-18', to: '2027-10-18', days: 365 }, last_card: '2026-11-22',
    fighters, bouts: bouts.sort((x, y) => (x.start < y.start ? -1 : 1)),
    divisions: [div('Lightweight', 'LC', ['L1', 'L2', 'L3', 'L4'], 'B1', '2026-11-01', 21, 10), div('W Flyweight', 'WC', ['W1', 'W2', 'W3'], null, '2026-06-01', 174, 12)],
    elo: { version: 'SYNTHETIC', status: 'SERVED (SYNTHETIC)', config: { k: 64, k_new_mult: 1.5, new_bouts: 3, layoff_days: 365, layoff_regress: 0.25, scale: 400, calibration: 'none' }, config_sha256: 'synthetic', promoted_at: '',
      reproduction: { file: 'SYNTHETIC', generated_at: '', served_version: 'SYNTHETIC', config_sha256: 'synthetic', published: 0, reproduced: 0, max_abs_diff: 0, mismatches: [], window_missing: [], window_extra: [] }, published_agree: { listed: 0, equal: 0, newer_finals: 0 } },
    gaps: { shape: 4.5, cv: 0.47, n: 200, from: '2014-01-01' }, matchmaking: { rule: 'SYNTHETIC', min_rest_days: 100 },
    finish: { m: 10, c: null, holdout_log_loss: 0.66, base_only_log_loss: 0.68, constant_log_loss: 0.69, n_holdout: 0, rounds_holdout: { chosen: 0, format_only: 0 }, base: { all: { n: 0, finishes: 0, rate: 0.5 }, by_rounds: {}, by_division: {} },
      no_winner: { finals: 0, draws: 0, no_contests: 0, rate: 0, recent_rate: 0, recent_from: '2021-01-01' }, by_rounds: {} },
    title_record: { from: '2014-01-01', matched: 0, unmatched: [], decided: 0, champion_won: 0, elo_expected_champion_wins: 0, log_loss: 0, coin_log_loss: 0.693147, challengers: { n: 0, coming_off_win: 0, coming_off_loss: 0, coming_off_draw: 0, rest_days: { p10: 100, median: 190, p90: 400 } } },
    rankings: { url: 'SYNTHETIC', fetched_at: '2026-10-23T00:00:00Z', page_sha256: 'synthetic', html_sha256: 'synthetic', groupings: 2, divisions: 2, deduped: 0, pound_for_pound: 0 },
    title_history: { sha256: 'synthetic', unparsed: [], window_years: 5 }, cross_checks: { wikipedia: [], espn: [] }, name_matching: { matched: 0, unmatched: [], aliases: [], ambiguous: [] },
    data_checks: { finals_csv: 0, finals_feed_only: 0, scheduled_feed: 5, csv_scheduled_dropped: [], late: [], double_booked: [] }, health: { windows: [], market: 'SYNTHETIC', record_graded: 0 }, code: {},
    config: { rules_version: 'SYNTHETIC', horizon_days: 365, rate_window_years: 5, matchmaking: 'SYNTHETIC', not_modelled: [] }
  };
}
const d0 = synth();
const seed = 20261023n;
const N = 40000;
const m = ufcModule(d0, { seed });
K.eq('SYNTHETIC: six outcomes per fighter, three for the fights, three Estimated for the title path', OUTCOMES.map((o) => o.key + ':' + o.provenance), ['win_next_bout:Research', 'win_next_finish:Research', 'win_next_decision:Research', 'title_shot:Estimated', 'win_title:Estimated', 'champion_at_horizon:Estimated']);
const agg = runRange(m, { start: 0, end: N });
K.eq('SYNTHETIC: every per-run sum rule held and the aggregate sums agree (one winner per booked bout, one champion per division)', [agg.violations.length, checkAggregateSums(m, agg)], [0, []]);
const O = m.outcomes.length, E = new Map(m.entities.map((e, i) => [e.id, i]));
const cnt = (id: string, o: string) => agg.counts[E.get(id)! * O + m.outcomes.findIndex((x) => x.key === o)];
const se = (p: number) => Math.sqrt(p * (1 - p) / N);
for (const b of d0.bouts) {
  const aw = agg.diags['b' + b.bout_id + '_a'] || 0;
  K.near('SYNTHETIC ' + b.bout_id + ': the win share keeps the served price ' + b.p_a + ' (within 4 SE)', aw / N, b.p_a, 4 * se(b.p_a));
  const fin = b.round_dist.reduce((s, _, k) => s + (agg.diags['b' + b.bout_id + '_fa' + (k + 1)] || 0) + (agg.diags['b' + b.bout_id + '_fb' + (k + 1)] || 0), 0);
  const pf = b.p_a * b.finish_if_a + (1 - b.p_a) * b.finish_if_b;
  K.near('SYNTHETIC ' + b.bout_id + ': finishes = p_a x P(finish | a) + p_b x P(finish | b)', fin / N, pf, 4 * se(pf));
  K.eq('SYNTHETIC ' + b.bout_id + ': a\'s next-bout wins equal the bout\'s a wins', cnt(b.a, 'win_next_bout'), aw);
}
{
  const b = d0.bouts.find((x) => x.bout_id === 'B1')!;
  const per = b.round_dist.map((_, k) => (agg.diags['b' + b.bout_id + '_fa' + (k + 1)] || 0) + (agg.diags['b' + b.bout_id + '_fb' + (k + 1)] || 0));
  const tot = per.reduce((s, x) => s + x, 0);
  K.chk('SYNTHETIC: the round of a finish follows the measured distribution (five rounds, within 4 SE each)', per.every((x, k) => Math.abs(x / tot - b.round_dist[k]) < 4 * Math.sqrt(b.round_dist[k] * (1 - b.round_dist[k]) / tot)), per);
  K.eq('SYNTHETIC: finish + decision = wins, for every fighter', m.entities.every((e) => cnt(e.id, 'win_next_finish') + cnt(e.id, 'win_next_decision') === cnt(e.id, 'win_next_bout')), true);
  K.near('SYNTHETIC: the booked title fight\'s challenger wins the title at least as often as they win that bout', cnt('L1', 'win_title') / N, Math.max(cnt('L1', 'win_title') / N, (N - (agg.diags.bB1_a || 0)) / N), 1e-12);
  K.chk('SYNTHETIC: both title-fight fighters always get a shot (the booked title fight)', cnt('LC', 'title_shot') === N && cnt('L1', 'title_shot') === N);
  K.eq('SYNTHETIC: no title won without a shot; nobody unranked and never booked into contention wins a title', [m.entities.every((e) => cnt(e.id, 'win_title') <= cnt(e.id, 'title_shot')), cnt('U2', 'title_shot')], [true, 0]);
  K.eq('SYNTHETIC: a contender coming off a loss with no booked bout never gets a shot (L4)', cnt('L4', 'title_shot'), 0);
  K.chk('SYNTHETIC: a contender coming off a loss gets a shot only by winning a booked bout first (L2: shots <= wins of its booked bout)', cnt('L2', 'title_shot') <= cnt('L2', 'win_next_bout') && cnt('L2', 'title_shot') > 0);
}

/* ---- the invariants run by run, from full traces ---- */
{
  const runs = 3000;
  let bad: string[] = [];
  const minRest = d0.matchmaking.min_rest_days * DAY, horizon = Date.parse(d0.horizon.to + 'T00:00:00Z');
  let w3First = 0, w3Won = 0;
  for (let r = 0; r < runs; r++) {
    const ev: Array<Record<string, any>> = [], hit = new Set<string>();
    const marks: RunMarks = { mark: (e, o) => { hit.add(m.entities[e].id + ':' + m.outcomes[o].key); }, value: () => {}, diag: () => {}, flag: () => {}, trace: (x) => { ev.push(x); }, tracing: true };
    m.runOne(r, marks);
    /* replay the run's events: the reigning champion, each fighter's last result and fight time */
    const champ: Record<string, string> = { Lightweight: 'LC', 'W Flyweight': 'WC' };
    const last: Record<string, number> = {}, res: Record<string, string> = {};
    for (const f of d0.fighters) { last[f.id] = f.last_fight ? Date.parse(f.last_fight) : NaN; res[f.id] = f.last_result || ''; }
    let w3won = false, firstWF = true;
    for (const x of ev) {
      if (x.ev === 'bout') {
        const b = d0.bouts.find((y) => y.bout_id === x.id)!, l = x.winner === b.a ? b.b : b.a, t = Date.parse(b.start);
        last[x.winner] = t; last[l] = t; res[x.winner] = 'W'; res[l] = 'L';
        if (b.title) { if (x.winner !== champ[b.title.division]) champ[b.title.division] = x.winner; }
        if (b.bout_id === 'B3') w3won = x.winner === 'W3';
      } else if (x.ev === 'title_fight') {
        const t = Date.parse(x.date + 'T00:00:00Z'), dv = d0.divisions.find((y) => y.key === x.division)!;
        if (x.champion !== champ[x.division]) bad.push('run ' + r + ': ' + x.division + ' title fight with ' + x.champion + ' while ' + champ[x.division] + ' reigns');
        if (res[x.challenger] !== 'W') bad.push('run ' + r + ': challenger ' + x.challenger + ' not coming off a win');
        if (d0.fighters.find((f) => f.id === x.challenger)!.division !== x.division) bad.push('run ' + r + ': challenger ' + x.challenger + ' is not of the ' + x.division + ' division');
        if (t + DAY - last[x.challenger] < minRest) bad.push('run ' + r + ': challenger ' + x.challenger + ' rested ' + Math.round((t - last[x.challenger]) / DAY) + ' days');
        if (t > horizon + DAY) bad.push('run ' + r + ': title fight after the horizon');
        if (t + DAY < Date.parse(dv.renewal.start + 'T00:00:00Z') + dv.renewal.min_gap_days * DAY) bad.push('run ' + r + ': title fight before the renewal\'s earliest date');
        if (x.division === 'W Flyweight' && firstWF) { firstWF = false; if (w3won && t - Date.parse('2026-11-08T01:00:00Z') >= minRest) { w3Won++; if (x.challenger === 'W3') w3First++; } }
        last[x.winner] = t; last[x.challenger === x.winner ? x.champion : x.challenger] = t; res[x.winner] = 'W'; res[x.challenger === x.winner ? x.champion : x.challenger] = 'L';
        if (x.winner !== x.champion) champ[x.division] = x.winner;
      } else if (x.ev === 'horizon') {
        for (const [k, v] of Object.entries(x.champions as Record<string, string>)) if (champ[k] !== v) bad.push('run ' + r + ': horizon champion ' + v + ' != replayed ' + champ[k]);
      }
    }
    for (const dv of d0.divisions) {
      const holders = d0.fighters.filter((f) => hit.has(f.id + ':champion_at_horizon') && f.division === dv.key);
      if (holders.length !== 1 || holders[0].id !== champ[dv.key]) bad.push('run ' + r + ': ' + dv.key + ' holders ' + holders.map((f) => f.id).join(','));
    }
    /* a champion who loses is no longer champion (and, coming off a loss, never regains it within the run) */
    const b1 = ev.find((x) => x.ev === 'bout' && x.id === 'B1');
    if (b1 && b1.winner === 'L1' && hit.has('LC:champion_at_horizon')) bad.push('run ' + r + ': LC lost the booked title fight and still holds the title');
    for (const f of d0.fighters) if (hit.has(f.id + ':win_title') && !hit.has(f.id + ':title_shot')) bad.push('run ' + r + ': ' + f.id + ' won a title without a shot');
    if (bad.length > 5) break;
  }
  K.chk('per run (3,000 traced runs): one holder per division, the replayed champion; a champion who loses is not champion; every title fight\'s champion reigns, its challenger is of the division (never another division\'s champion booked there), comes off a win and rested the minimum, inside the renewal window and the horizon', !bad.length, bad.slice(0, 5));
  K.chk('the rank rule: when #3 beats #1 (and has rested), #3 takes the next shot (' + w3First + ' of ' + w3Won + ' runs)', w3Won > 100 && w3First === w3Won, { w3First, w3Won });
}

/* ---- determinism and workers ---- */
{
  const a1 = runRange(m, { start: 0, end: 3000 }), a2 = runRange(ufcModule(synth(), { seed }), { start: 0, end: 3000 });
  K.eq('the same seed and data give identical counts and diagnostics', [a1.counts, a1.diags], [a2.counts, a2.diags]);
  const w1 = await runPlan({ sport: 'ufc', data: d0, seed, runs: 6000, workers: 1, traceRuns: [] });
  const w3 = await runPlan({ sport: 'ufc', data: d0, seed, runs: 6000, workers: 3, traceRuns: [] });
  K.chk('one worker and three workers give byte-identical aggregates (counts, histograms, diagnostics)', JSON.stringify([w1.agg.counts, w1.agg.hist]) === JSON.stringify([w3.agg.counts, w3.agg.hist])
    && JSON.stringify(Object.entries(w1.agg.diags).sort()) === JSON.stringify(Object.entries(w3.agg.diags).sort()), { w: w3.workers });
  const b = runRange(ufcModule(d0, { seed: seed + 1n }), { start: 0, end: 3000 });
  K.chk('another seed gives other draws', JSON.stringify(b.counts) !== JSON.stringify(a1.counts));
  /* the reader summary agrees with the per-fighter counts */
  const res = buildResults({ module: m, agg: a1, seed, runs: 3000, workers: 1, input_hash: 'x'.repeat(64), input_snapshot_at: '2026-10-23T00:00:00Z', model_version: 'SYNTHETIC', config: {}, rules_version: 'SYNTHETIC',
    started_at: '', finished_at: '', runtime_ms: 0, peak_rss_mb: 0 });
  const S = readerSummary(d0, res, a1.diags, a1.n);
  const bt = S.cards.flatMap((c: any) => c.bouts).find((x: any) => x.bout_id === 'B1');
  const ent = new Map((res.entities as any[]).map((e) => [e.entity_id, e]));
  K.eq('reader summary: a bout\'s win counts are the fighters\' next-bout wins; a new champion = the challenger\'s wins', [bt.a_win.count, bt.b_win.count, bt.new_champion.count], [ent.get('LC').outcomes.win_next_bout.count, ent.get('L1').outcomes.win_next_bout.count, ent.get('L1').outcomes.win_next_bout.count]);
  K.eq('reader summary: finish + decision = 100% and the rounds sum to the finishes', [bt.finish.count + bt.decision.count, bt.finish_rounds.reduce((s: number, x: any) => s + x.count, 0)], [3000, bt.finish.count]);
  K.chk('reader summary: cards in date order, the main event first on its card', S.cards[0].date <= S.cards[S.cards.length - 1].date && S.cards.find((c: any) => c.bouts.some((x: any) => x.bout_id === 'B1')).bouts[0].bout_id === 'B1');
  const lw = S.divisions.find((x: any) => x.key === 'Lightweight')!;
  const l1 = lw.people.find((p: any) => p.id === 'L1')!;
  K.near('reader summary: beat the champion if given the shot = titles won / shots', l1.beat_champion_given_shot!.probability, ent.get('L1').outcomes.win_title.count / ent.get('L1').outcomes.title_shot.count, 1e-12);
}

/* ---- the committed data ---- */
const snap = buildUfcSnapshot();
const d = snap.data;
const now = Date.parse(d.rankings.fetched_at) + DAY;
const gates = validateUfcInputs(snap, now);
K.chk('committed data: every input gate passes (fetched rankings + 1 day)', gates.every((g) => g.status === 'PASS'), gates.filter((g) => g.status !== 'PASS'));
K.eq('committed data: the Elo port reproduces every published p_a (' + d.elo.reproduction.reproduced + ' of ' + d.elo.reproduction.published + ')', [d.elo.reproduction.reproduced === d.elo.reproduction.published, d.elo.reproduction.mismatches.length], [true, 0]);
const name = (id: string) => d.fighters.find((f) => f.id === id)!.name;
const champs = Object.fromEntries(d.divisions.map((v) => [v.key, name(v.champion)]));
K.eq('committed data: the ufc.com champions', champs, { Flyweight: 'Joshua Van', Bantamweight: 'Petr Yan', Featherweight: 'Alexander Volkanovski', Lightweight: 'Justin Gaethje', Welterweight: 'Islam Makhachev', Middleweight: 'Sean Strickland',
  'Light Heavyweight': 'Carlos Ulberg', Heavyweight: 'Ciryl Gane', 'W Strawweight': 'Mackenzie Dern', 'W Flyweight': 'Natalia Silva', 'W Bantamweight': 'Kayla Harrison' });
const titles = d.bouts.filter((b) => b.title).map((b) => b.title!.division + ': ' + name(b.a) + ' v ' + name(b.b)).sort();
K.eq('committed data: the booked title fights (champion v another fighter at that weight)', titles, ['Bantamweight: Merab Dvalishvili v Petr Yan', 'Featherweight: Alexander Volkanovski v Movsar Evloev', 'Heavyweight: Ciryl Gane v Josh Hokit', 'W Bantamweight: Kayla Harrison v Amanda Nunes']);
const main = d.bouts.find((b) => b.event.startsWith('UFC 333') && b.order === 1)!;
K.eq('committed data: UFC 333\'s main event is Volkanovski v Evloev at the published price', [name(main.a), name(main.b), main.p_a_published, main.rounds], ['Alexander Volkanovski', 'Movsar Evloev', 0.4593, 5]);
K.chk('committed data: ESPN\'s title accolades and Wikipedia\'s incumbents agree with ufc.com', d.cross_checks.espn.length === 4 && d.cross_checks.espn.every((x) => x.agree) && d.cross_checks.wikipedia.every((x) => x.agree));
K.chk('committed data: a title-fight rate in every division from Wikipedia, the gaps\' shape measured', d.divisions.every((v) => v.rate.per_year > 0 && v.mean_gap_days! > 0) && d.gaps.shape > 1 && d.gaps.n > 100, d.gaps);
K.chk('committed data: no booked bout before the as-of time, every fighter rated or a debutant at 1500', d.bouts.every((b) => Date.parse(b.start) > Date.parse(d.as_of)) && d.fighters.every((f) => f.bouts > 0 || (f.debut && f.rating === 1500)));

/* ---- the gates refuse what they must ---- */
const mutate = (fn: (x: UfcInputData) => void): UfcSnapshot => { const s = JSON.parse(JSON.stringify(snap)) as UfcSnapshot; fn(s.data); s.input_hash = hashCanonical(s.data); return s; };
const gate = (s: UfcSnapshot, id: string, t = now) => validateUfcInputs(s, t).find((g) => g.id === id)!;
K.eq('gate: a published price the port does not reproduce blocks the simulation', [gate(mutate((x) => { x.elo.reproduction.reproduced--; x.elo.reproduction.mismatches.push({ bout_id: '1', published: 0.5, ported: 0.6, why: 'p_a differs' }); }), 'model.reproduces').blocks], ['simulation']);
K.eq('gate: an unmatched ranked name blocks the simulation', gate(mutate((x) => { x.name_matching.unmatched.push('Nobody'); }), 'rankings.parsed').blocks, 'simulation');
K.eq('gate: a rankings page that differs from the saved one blocks the simulation', gate(mutate((x) => { x.rankings.html_sha256 = 'f'.repeat(64); }), 'rankings.parsed').blocks, 'simulation');
K.eq('gate: rankings older than 8 days block publication', gate(snap, 'rankings.fresh', Date.parse(d.rankings.fetched_at) + 9 * DAY).blocks, 'publication');
K.eq('gate: Wikipedia naming another champion blocks publication', gate(mutate((x) => { x.cross_checks.wikipedia[0].agree = false; }), 'champions.agree').blocks, 'publication');
K.eq('gate: a fighter booked twice blocks the simulation', gate(mutate((x) => { x.data_checks.double_booked.push('1'); }), 'schedule.single').blocks, 'simulation');
K.eq('gate: an unparsed title-history line blocks the simulation', gate(mutate((x) => { x.title_history.unparsed.push('x'); }), 'title_history.parsed').blocks, 'simulation');
K.eq('gate: a ranked contender with no UFC bout (an unmatched name) blocks the simulation', gate(mutate((x) => { const f = x.fighters.find((y) => y.rank != null)!; f.bouts = 0; }), 'fighters.rated').blocks, 'simulation');
K.eq('gate: a result the feed has not delivered blocks publication', gate(mutate((x) => { x.data_checks.late.push('1'); }), 'schedule.current').blocks, 'publication');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-snap-'));
  const f = path.join(dir, 'snapshot.json');
  writeUfcSnapshot(f, snap);
  K.eq('a written snapshot reads back with its hash', readUfcSnapshot(f).input_hash, snap.input_hash);
  const t = JSON.parse(fs.readFileSync(f, 'utf8')); t.data.bouts[0].p_a = 0.99; fs.writeFileSync(f, JSON.stringify(t));
  K.throws('a snapshot changed after it was built is refused', () => readUfcSnapshot(f), /hash mismatch/);
}

/* ---- a 4,000-run execution on the committed data ---- */
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-run-'));
  const o = await executeUfc({ season: 2026, runs: 4000, seed: '7', workers: 2, snapshot: null, out, traceRuns: [0], nowMs: now }, () => {});
  const fail = o.gates.filter((g) => g.status !== 'PASS').map((g) => g.id);
  K.eq('committed data: 4,000 runs pass every gate but the production run count', fail, ['run.count']);
  const S = (o.results as any).sport_summary;
  const mb = S.cards.find((c: any) => c.event.startsWith('UFC 333')).bouts[0];
  K.chk('committed data: UFC 333 leads with its main event, a featherweight title fight, Evloev\'s win share near 1 - p_a', mb.title && mb.title.division === 'Featherweight' && Math.abs(mb.b_win.probability - (1 - main.p_a)) < 4 * Math.sqrt(0.25 / 4000), mb);
  K.eq('committed data: eleven divisions in the title path, each with exactly one champion per run', [S.divisions.length, (o.results as any).checks.sum_rule_errors.length], [11, 0]);
  K.chk('committed data: the run writes snapshot, results, gates and manifest', ['snapshot.json', 'results.json', 'gates.json', 'manifest.json'].every((x) => fs.existsSync(path.join(o.outDir, x))));
}

/* ---- registry and plan ---- */
const reg = sportRegistry().find((s) => s.key === 'ufc')!;
K.eq('registry: the UFC is ACTIVE with Fights, Title Path and Model Health', [reg.status, reg.tabs.join(), reg.blockers.length], ['ACTIVE', 'fights,title_path,model_health', 0]);
K.chk('registry: the limitations state the modest edge over a coin, the Estimated title path and the champions\' record, and never the word "probability"', reg.limitations.some((l) => /coin flip/.test(l)) && reg.limitations.some((l) => /Estimated/.test(l)) && reg.limitations.some((l) => /champions have won more title fights than the Elo expected/.test(l)) && !/probability/i.test(JSON.stringify(reg)));
K.chk('plan: the UFC runs every night and can be dispatched', planRuns('schedule', {}, undefined, new Date('2027-03-01T10:17:00Z')).some((r) => r.sport === 'ufc' && r.publish) && planRuns('workflow_dispatch', { sport: 'ufc', season: '2026', runs: '100000', publish: 'true' })[0].sport === 'ufc');
process.exit(K.done());
