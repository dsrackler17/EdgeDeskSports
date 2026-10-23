/* ===========================================================================
   edgedesk-sim run, UFC: snapshot -> gates -> simulate -> results -> local
   files; publication through the shared publisher (publish/publish.ts) only
   when every gate passes. Called by cli/run.ts for --sport ufc.

   Gates (a FAIL that blocks simulation stops before a single run):
     model.reproduces      the port of the served Elo reproduces every p_a the
                           model loop published (current.json), with the same
                           fighters and bout counts, and misses no bout in its
                           window
     fighters.rated        every fighter rated from the data or priced as a
                           debutant (1500) exactly as the served model does; no
                           champion or ranked contender without a UFC bout (a
                           name that did not match)
     rankings.parsed       eleven divisions, each a champion and ranked
                           contenders, every name matched, the recorded page
                           sha256 equal to the saved page's
     title_history.parsed  every division's table read, no line unparsed, a
                           measured title-fight rate in each
     schedule.single       no fighter booked twice in the horizon
   Publication only:
     model.served          the loop serves the version (SERVED status)
     model.booked_priced   every booked bout priced in (0, 1); the bouts the
                           loop lists carry its published price exactly
     rankings.fresh        the page read within 8 days
     champions.agree       Wikipedia's incumbents and ESPN's title accolades
                           name the same champions as ufc.com
     schedule.current      no scheduled bout before the last result (a result
                           the feed has not delivered)
   then run.sum_rules (with: finish + decision = wins, per fighter),
   run.finite, run.count (100,000 to publish) and sport.active.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { runPlan } from '../../core/runner.ts';
import { buildResults, PRODUCTION_RUNS, type ResultsDoc } from '../../core/results.ts';
import { parseSeed } from '../../core/prng.ts';
import { sha256Hex } from '../../core/canonical.ts';
import { outcomeStat } from '../../core/stats.ts';
import { sportRegistry } from '../registry.ts';
import type { Gate } from '../nfl/validate.ts';
import { REPO } from './elo.ts';
import { buildUfcSnapshot, readUfcSnapshot, writeUfcSnapshot, type UfcSnapshot, type UfcInputData } from './inputs.ts';
import { UFC_2026 } from './config.ts';

export interface UfcArgs { season: number; runs: number; seed: string | null; workers: number; snapshot: string | null; out: string | null; traceRuns: number[]; nowMs?: number }

export function validateUfcInputs(snap: UfcSnapshot, nowMs: number = Date.now()): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation'): void => { out.push({ id, status: ok ? 'PASS' : 'FAIL', blocks: ok ? 'none' : blocks, detail }); };
  const rp = d.elo.reproduction;
  g('model.reproduces', rp.published > 0 && rp.reproduced === rp.published && !rp.mismatches.length && !rp.window_missing.length && !rp.window_extra.length,
    'the port of the served Elo ' + d.elo.version + ' reproduces ' + rp.reproduced + ' of ' + rp.published + ' published p_a (' + rp.file + ', ' + rp.generated_at + ') to four decimals, same fighters and bout counts'
    + (rp.mismatches.length ? '; mismatches: ' + rp.mismatches.slice(0, 5).map((m) => m.bout_id + ' ' + m.why).join('; ') : '') + (rp.window_missing.length ? '; priced in the window but not published: ' + rp.window_missing.join(', ') : ''));
  const ranked = d.fighters.filter((f) => f.champion || f.rank != null);
  const unrated = d.fighters.filter((f) => !(Number.isFinite(f.rating) && (f.bouts > 0 || (f.debut && f.rating === 1500))));
  const ghost = ranked.filter((f) => f.bouts === 0);
  g('fighters.rated', !unrated.length && !ghost.length, d.fighters.length + ' fighters: ' + d.fighters.filter((f) => !f.debut).length + ' rated from their UFC bouts, ' + d.fighters.filter((f) => f.debut).length + ' debutants priced as an average fighter (1500), as the served model prices them'
    + (unrated.length ? '; unrated: ' + unrated.map((f) => f.name).join(', ') : '') + (ghost.length ? '; champions or ranked contenders with no UFC bout in the data (unmatched names?): ' + ghost.map((f) => f.name).join(', ') : ''));
  const rk = d.rankings, nm = d.name_matching;
  const thin = d.divisions.filter((v) => v.contenders.length + v.moved_out.length < 10);
  g('rankings.parsed', d.divisions.length === 11 && !thin.length && !nm.unmatched.length && !!rk.html_sha256 && rk.html_sha256 === rk.page_sha256,
    rk.divisions + ' divisions from ' + rk.groupings + ' groupings on ' + rk.url + ' (' + rk.deduped + ' repeated divisions deduplicated, ' + rk.pound_for_pound + ' pound-for-pound lists dropped); ' + nm.matched + ' names matched to ESPN (' + (nm.aliases.join('; ') || 'no alias') + ')'
    + '; page sha256 ' + rk.page_sha256.slice(0, 16) + (rk.html_sha256 === rk.page_sha256 ? ' = the saved page' : ' != the saved page (' + String(rk.html_sha256).slice(0, 16) + ')')
    + (thin.length ? '; divisions with fewer than 10 contenders: ' + thin.map((v) => v.key).join(', ') : '') + (nm.unmatched.length ? '; unmatched: ' + nm.unmatched.join(', ') : ''));
  const th = d.title_history, noRate = d.divisions.filter((v) => !(v.rate.per_year > 0));
  g('title_history.parsed', !th.unparsed.length && !noRate.length, 'Wikipedia\'s title history (sha256 ' + th.sha256.slice(0, 16) + '): ' + d.divisions.map((v) => v.key + ' ' + v.rate.title_fights).join(', ') + ' undisputed title fights in the ' + th.window_years + ' years to ' + d.horizon.from
    + (th.unparsed.length ? '; unparsed: ' + th.unparsed.slice(0, 5).join(' | ') : '') + (noRate.length ? '; no measured rate: ' + noRate.map((v) => v.key).join(', ') : ''));
  g('schedule.single', !d.data_checks.double_booked.length, d.bouts.length + ' booked bouts through ' + (d.last_card || '—') + (d.data_checks.double_booked.length ? '; fighters booked twice: ' + d.data_checks.double_booked.join(', ') : '; no fighter booked twice'));
  /* publication */
  g('model.served', /^SERVED/.test(d.elo.status), 'versions.json: ' + d.elo.version + ' ' + d.elo.status, 'publication');
  const badP = d.bouts.filter((b) => !(b.p_a > 0 && b.p_a < 1));
  const pa = d.elo.published_agree;
  g('model.booked_priced', !badP.length && (pa.newer_finals > 0 || pa.equal === pa.listed), d.bouts.length + ' booked bouts priced; ' + pa.equal + ' of the ' + pa.listed + ' the loop lists carry its published price' + (pa.newer_finals ? ' (' + pa.newer_finals + ' newer results walked since it published)' : '')
    + (badP.length ? '; unpriced: ' + badP.map((b) => b.bout_id).join(', ') : ''), 'publication');
  const age = (nowMs - Date.parse(rk.fetched_at)) / 86400000;
  g('rankings.fresh', Number.isFinite(age) && age <= UFC_2026.rankings_max_age_days, 'ufc.com rankings read ' + rk.fetched_at + ' (' + (Number.isFinite(age) ? age.toFixed(1) : '?') + ' days before this run; at most ' + UFC_2026.rankings_max_age_days + ')', 'publication');
  const cw = d.cross_checks.wikipedia.filter((x) => !x.agree), ce = d.cross_checks.espn.filter((x) => !x.agree);
  g('champions.agree', !cw.length && !ce.length, 'Wikipedia\'s incumbents agree in ' + (d.cross_checks.wikipedia.length - cw.length) + ' of ' + d.cross_checks.wikipedia.length + ' divisions; ESPN\'s title accolades on ' + d.cross_checks.espn.length + ' booked bouts agree in ' + (d.cross_checks.espn.length - ce.length)
    + (cw.length ? '; Wikipedia differs: ' + cw.map((x) => x.division + ' (ufc.com ' + x.ufc + ', Wikipedia ' + x.wikipedia + ')').join(', ') : '') + (ce.length ? '; ESPN differs on ' + ce.map((x) => x.bout_id).join(', ') : ''), 'publication');
  const late = d.data_checks.late;
  g('schedule.current', !late.length, late.length ? 'scheduled bouts before the last result, without a result: ' + late.join(', ') : 'every bout before the last result (' + d.as_of + ') has its result', 'publication');
  return out;
}

/** a share from counts, as the reader shows it (rounded: the count is exact, the summary rides in validation_summary) */
const P = (k: number, n: number) => { const s = outcomeStat(k, n); return { count: k, probability: Math.round(s.probability * 1e6) / 1e6, mcse: Math.round(s.mcse * 1e7) / 1e7 }; };

/** what the reader shows beside the per-fighter outcomes: the cards bout by bout, each division's title path, the model's record */
export function readerSummary(d: UfcInputData, results: ResultsDoc, diags: Record<string, number>, n: number) {
  const F = new Map(d.fighters.map((f) => [f.id, f]));
  const ent = new Map((results.entities as any[]).map((e) => [e.entity_id, e]));
  const side = (id: string) => { const f = F.get(id)!; return { id, name: f.name, rating: Math.round(f.rating * 10) / 10, record: f.record, rank: f.rank, ranked_division: f.ranked_division, champion: f.champion, debut: f.debut }; };
  const cards = new Map<string, any>();
  for (const b of d.bouts) {
    const c = cards.get(b.event_id) || cards.set(b.event_id, { event_id: b.event_id, event: b.event, date: b.start, bouts: [] }).get(b.event_id);
    if (b.start < c.date) c.date = b.start;
    const aw = diags['b' + b.bout_id + '_a'] || 0;
    const fa = b.round_dist.map((_, k) => diags['b' + b.bout_id + '_fa' + (k + 1)] || 0), fb = b.round_dist.map((_, k) => diags['b' + b.bout_id + '_fb' + (k + 1)] || 0);
    const sa = fa.reduce((x, y) => x + y, 0), sb = fb.reduce((x, y) => x + y, 0);
    c.bouts.push({ bout_id: b.bout_id, start: b.start, order: b.order, weight_class: b.weight_class, division: b.division, rounds: b.rounds, title: b.title,
      a: side(b.a), b: side(b.b), served_p_a: b.p_a, published_p_a: b.p_a_published, basis: b.basis,
      a_win: P(aw, n), b_win: P(n - aw, n), a_finish: P(sa, n), a_decision: P(aw - sa, n), b_finish: P(sb, n), b_decision: P(n - aw - sb, n),
      finish: P(sa + sb, n), decision: P(n - sa - sb, n), finish_rounds: fa.map((x, k) => P(x + fb[k], n)),
      new_champion: b.title ? P(b.title.champion === b.a ? n - aw : aw, n) : null });
  }
  for (const c of cards.values()) c.bouts.sort((x: any, y: any) => (x.order ?? 99) - (y.order ?? 99) || (x.start < y.start ? 1 : -1));
  const divisions = d.divisions.map((v) => {
    const people = [v.champion, ...v.contenders, ...d.fighters.filter((f) => f.division === v.key && f.id !== v.champion && !v.contenders.includes(f.id)).map((f) => f.id)];
    const rows = people.map((id) => {
      const e = ent.get(id); const o = e ? e.outcomes : {};
      const shot = o.title_shot ? o.title_shot.count : 0, won = o.win_title ? o.win_title.count : 0;
      const f = F.get(id)!;
      return { id, name: f.name, rank: f.ranked_division === v.key ? f.rank : null, champion: id === v.champion, moved_from: f.moved_from, last_result: f.last_result, last_fight: f.last_fight,
        booked: d.bouts.find((b) => b.a === id || b.b === id)?.bout_id || null,
        beat_champion_given_shot: id !== v.champion && shot > 0 ? { count: won, of: shot, probability: won / shot, mcse: Math.sqrt((won / shot) * (1 - won / shot) / shot) } : null };
    });
    const booked = v.booked_title ? d.bouts.find((b) => b.bout_id === v.booked_title)! : null;
    return { key: v.key, label: v.label, champion: v.champion, booked_title: booked ? { bout_id: booked.bout_id, date: booked.start, event: booked.event, challenger: booked.a === v.champion ? booked.b : booked.a } : null,
      rate: v.rate, mean_gap_days: v.mean_gap_days, renewal: v.renewal, moved_out: v.moved_out,
      expected_title_fights: (diags['tf_' + v.key] || 0) / n, expected_title_changes: (diags['tfch_' + v.key] || 0) / n, p_unbooked_fight: P(diags['tfu_' + v.key] || 0, n), no_challenger_events: diags['tfnone_' + v.key] || 0,
      people: rows };
  });
  return {
    kind: 'ufc_fights_title_path', as_of: d.as_of, horizon: d.horizon, last_card: d.last_card,
    cards: [...cards.values()].sort((x, y) => (x.date < y.date ? -1 : 1)),
    divisions,
    matchmaking: { rule: d.matchmaking.rule, min_rest_days: d.matchmaking.min_rest_days, challengers: d.title_record.challengers },
    model_health: { elo: { version: d.elo.version, status: d.elo.status, promoted_at: d.elo.promoted_at, config: d.elo.config, reproduced: d.elo.reproduction.reproduced, published: d.elo.reproduction.published },
      windows: d.health.windows, market: d.health.market, title_record: { matched: d.title_record.matched, unmatched: d.title_record.unmatched.length, decided: d.title_record.decided, champion_won: d.title_record.champion_won,
        elo_expected: d.title_record.elo_expected_champion_wins, log_loss: d.title_record.log_loss, coin: d.title_record.coin_log_loss,
        periods: (d.title_record.periods || []).map((x) => ({ from: x.from, to: x.to, decided: x.decided, champion_won: x.champion_won, elo_expected: x.elo_expected_champion_wins })) },
      champion_term: { served_bonus: d.elo.config.champ_bonus || 0, last_test: d.champion_term },
      finish: { m: d.finish.m, c: d.finish.c, holdout_log_loss: d.finish.holdout_log_loss, base_only_log_loss: d.finish.base_only_log_loss, constant_log_loss: d.finish.constant_log_loss, n_holdout: d.finish.n_holdout,
        rate_3: d.finish.base.by_rounds['3'] ? d.finish.base.by_rounds['3'].rate : null, rate_5: d.finish.base.by_rounds['5'] ? d.finish.base.by_rounds['5'].rate : null, no_winner: d.finish.no_winner },
      gaps: d.gaps, rankings: { fetched_at: d.rankings.fetched_at, page_sha256: d.rankings.page_sha256, url: d.rankings.url } }
  };
}

export async function executeUfc(a: UfcArgs, log: (s: string) => void = console.log): Promise<{ results: ResultsDoc; gates: Gate[]; snapshot: UfcSnapshot; outDir: string; publishable: boolean }> {
  if (!a.snapshot && a.season !== UFC_2026.season) throw Object.assign(new Error('no UFC season config for ' + a.season + ' (configured: ' + UFC_2026.season + ')'), { exitCode: 2 });
  const snap = a.snapshot ? readUfcSnapshot(a.snapshot) : buildUfcSnapshot();
  const inputGates = validateUfcInputs(snap, a.nowMs);
  const blocked = inputGates.filter((g) => g.status === 'FAIL' && g.blocks === 'simulation');
  if (blocked.length) throw Object.assign(new Error('invalid inputs, nothing simulated: ' + blocked.map((g) => g.id + ' (' + g.detail + ')').join('; ')), { exitCode: 2, gates: inputGates });
  const d = snap.data;
  const seed = a.seed != null ? parseSeed(a.seed) : BigInt('0x' + snap.input_hash.slice(0, 16));
  log('inputs ' + snap.input_hash.slice(0, 12) + ' · as of ' + d.as_of.slice(0, 10) + ' · ' + d.bouts.length + ' booked bouts through ' + d.last_card + ' · horizon ' + d.horizon.to + ' · Elo ' + d.elo.version + ' · seed ' + seed);
  const t0 = Date.now(), startedAt = new Date().toISOString();
  let peak = 0; const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 250);
  const { agg, module, workers } = await runPlan({ sport: 'ufc', data: d, seed, runs: a.runs, workers: a.workers, traceRuns: a.traceRuns });
  clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss);
  const ms = Date.now() - t0;
  const F = new Map(d.fighters.map((f) => [f.id, f]));
  const results = buildResults({ module, agg, seed, runs: a.runs, workers, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at,
    model_version: 'edgedesk_ufc_elo@' + d.elo.version + '+cfg' + d.elo.config_sha256.slice(0, 8), config: { elo: d.elo.config, horizon: d.horizon, gaps: d.gaps, matchmaking: d.matchmaking, finish: { m: d.finish.m, c: d.finish.c }, rules: d.config },
    rules_version: d.config.rules_version, started_at: startedAt, finished_at: new Date().toISOString(), runtime_ms: ms, peak_rss_mb: Math.round(peak / 1048576),
    entityExtras: (id) => { const f = F.get(id)!; return { record: { w: f.record.w, l: f.record.l, d: f.record.d, rating: Math.round(f.rating * 10) / 10, bouts: f.bouts, debut: f.debut, rank: f.rank, ranked_division: f.ranked_division, champion: f.champion, moved_from: f.moved_from, last_result: f.last_result, last_fight: f.last_fight }, math_status: {} }; } });
  (results as any).sport_summary = readerSummary(d, results, agg.diags, agg.n);
  const reg = sportRegistry().find((s) => s.key === 'ufc')!;
  const ents = results.entities as any[];
  const splitBad = ents.filter((e) => e.outcomes.win_next_finish.count + e.outcomes.win_next_decision.count !== e.outcomes.win_next_bout.count);
  const pathBad = ents.filter((e) => e.outcomes.win_title.count > e.outcomes.title_shot.count);
  const sumBad = results.checks.sum_rule_errors.length > 0 || splitBad.length > 0 || pathBad.length > 0;
  const runGates: Gate[] = [
    { id: 'run.sum_rules', status: sumBad ? 'FAIL' : 'PASS', blocks: sumBad ? 'publication' : 'none',
      detail: results.checks.sum_rule_errors.length ? results.checks.sum_rule_errors.slice(0, 5).join('; ') : splitBad.length ? 'finish + decision != wins for ' + splitBad.map((e) => e.entity_id).join(', ') : pathBad.length ? 'a title won without a title shot: ' + pathBad.map((e) => e.entity_id).join(', ')
        : 'every per-run and aggregate sum holds (one winner per booked bout, one champion per division at the horizon; finishes and decisions sum to the wins; no title without a shot)' },
    { id: 'run.finite', status: results.checks.finite_and_bounded ? 'PASS' : 'FAIL', blocks: results.checks.finite_and_bounded ? 'none' : 'publication', detail: 'every probability finite and in [0,1]' },
    { id: 'run.count', status: agg.n >= PRODUCTION_RUNS ? 'PASS' : 'FAIL', blocks: agg.n >= PRODUCTION_RUNS ? 'none' : 'publication', detail: agg.n + ' runs (' + PRODUCTION_RUNS + ' required to publish)' },
    { id: 'sport.active', status: reg.status === 'ACTIVE' ? 'PASS' : 'FAIL', blocks: reg.status === 'ACTIVE' ? 'none' : 'publication', detail: reg.status + (reg.blockers.length ? ': ' + reg.blockers.join(' | ') : '') }
  ];
  const gates = inputGates.concat(runGates);
  const publishable = gates.every((x) => x.blocks === 'none');
  const stamp = startedAt.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outDir = a.out || path.join(REPO, 'simulator', 'out', 'ufc-' + d.season + '-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });
  writeUfcSnapshot(path.join(outDir, 'snapshot.json'), snap);
  const resText = JSON.stringify(results, null, 1), gateText = JSON.stringify(gates, null, 1);
  fs.writeFileSync(path.join(outDir, 'results.json'), resText);
  fs.writeFileSync(path.join(outDir, 'gates.json'), gateText);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ schema: 'edgedesk_sim_run_manifest_v1', input_hash: snap.input_hash, results_sha256: sha256Hex(resText), gates_sha256: sha256Hex(gateText),
    snapshot_sha256: sha256Hex(fs.readFileSync(path.join(outDir, 'snapshot.json'))), publishable, published: false }, null, 1));
  return { results, gates, snapshot: snap, outDir, publishable };
}

export function printUfcSummary(o: { results: ResultsDoc; gates: Gate[]; outDir: string; publishable: boolean }, log: (s: string) => void): void {
  const r = o.results as any, S = r.sport_summary;
  log('runs ' + r.run.n_sims + ' · ' + (r.run.runtime_ms / 1000).toFixed(1) + ' s · ' + r.run.workers + ' worker(s) · peak RSS ' + r.run.peak_rss_mb + ' MB · ' + r.run.platform + ' ' + r.run.node);
  const pp = (x: any) => (x ? (100 * x.probability).toFixed(1).padStart(5) + '±' + (100 * 1.96 * x.mcse).toFixed(1) : '   —   ');
  for (const c of S.cards) {
    log('— ' + c.event + ' (' + c.date.slice(0, 10) + ')');
    for (const b of c.bouts) log('  ' + (b.title ? '[TITLE] ' : '') + (b.a.name + ' ' + pp(b.a_win)).padEnd(34) + ' v ' + (b.b.name + ' ' + pp(b.b_win)).padEnd(34) + ' served ' + (100 * b.served_p_a).toFixed(1) + '% · finish ' + pp(b.finish) + ' · R1 ' + pp(b.finish_rounds[0]) + (b.new_champion ? ' · new champion ' + pp(b.new_champion) : ''));
  }
  const ent = new Map((r.entities as any[]).map((e) => [e.entity_id, e]));
  log('title path to ' + S.horizon.to + ' (percent: hold the title at the horizon · win it · title shot · beat the champion if given the shot) — Estimated');
  for (const v of S.divisions) {
    const top = v.people.slice().sort((x: any, y: any) => ent.get(y.id).outcomes.champion_at_horizon.probability - ent.get(x.id).outcomes.champion_at_horizon.probability).slice(0, 5);
    log('  ' + v.key + ' (' + v.rate.title_fights + ' title fights in ' + v.rate.window.years + ' years; ' + v.expected_title_fights.toFixed(2) + ' expected in the horizon): '
      + top.map((x: any) => { const o = ent.get(x.id).outcomes; return x.name + (x.champion ? ' (C)' : '') + ' ' + (100 * o.champion_at_horizon.probability).toFixed(1) + ' · ' + (100 * o.win_title.probability).toFixed(1) + ' · ' + (100 * o.title_shot.probability).toFixed(1) + (x.beat_champion_given_shot ? ' · ' + (100 * x.beat_champion_given_shot.probability).toFixed(1) : ''); }).join(' | '));
  }
  for (const g of o.gates) if (g.status !== 'PASS') log(g.status + ' ' + g.id + ' [' + g.blocks + '] ' + g.detail);
  log((o.publishable ? 'PUBLISHABLE' : 'NOT PUBLISHABLE') + ' · local output ' + path.relative(process.cwd(), o.outDir));
}
