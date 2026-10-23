/* ===========================================================================
   College football input validation (blocks the simulation), publication
   gates (block publishing), and the run gates that read the counted flags.
   Every check returns PASS / FAIL / WARN with its evidence.

   Publication is per-SPORT in the shared publisher, and today the CFB sport
   stays BLOCKED (registry.ts): six conference procedures and two eligibility
   facts are not VERIFIED. Each conference's forecast still carries its own
   status (conferenceStatus), so a reader can tell a conference whose rules
   were read from the conference's own text from one that was not.
   =========================================================================== */
import { cfbCodeIdentity } from './engine_adapter.ts';
import { cfbFacts, isCfbVerified } from './config.ts';
import { cfpMode } from './module.ts';
import type { CfbSnapshot, CfbInputData } from './inputs.ts';
import type { Gate } from '../nfl/validate.ts';
export type { Gate };

export function validateCfbInputs(snap: CfbSnapshot, opt: { ignoreCodeDrift?: boolean } = {}): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => {
    out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail });
  };
  const T = d.teams.length;
  const confs = new Set(d.config.conferences.map((c) => c.conference));
  g('schedule.membership', d.teams.every((t) => confs.has(t.conference) || t.conference === 'FBS Independents') && [...confs].every((c) => d.teams.some((t) => t.conference === c)),
    T + ' FBS teams from the ' + d.season + ' feed; every conference label has a rules entry and every rules entry has members');
  const per = new Array(T).fill(0); for (const x of d.games) { if (x.home >= 0) per[x.home]++; if (x.away >= 0) per[x.away]++; }
  const short = d.teams.map((t, i) => [t.name, per[i]] as [string, number]).filter(([, n]) => n < 11);
  const pac12Short = d.teams.filter((t, i) => t.conference === 'Pac-12' && per[i] === 11).length;
  g('schedule.complete', short.length === 0, 'every FBS team has at least 11 regular-season games in the feed' + (short.length ? ': ' + short.map(([n, c]) => n + ' ' + c).join(', ') : ''));
  g('schedule.pac12_flex', pac12Short === 0, pac12Short + ' Pac-12 teams are missing their Week 13 flex game (opponent set at most six days ahead; non-conference by rule): not simulated, missing from their overall records', 'none', true);
  g('results.completed', d.games.every((x) => !x.done || (Number.isInteger(x.home_points) && Number.isInteger(x.away_points) && x.home_points !== x.away_points)), 'every completed game has two integer scores and a winner');
  const open = d.games.filter((x) => !x.done);
  const tau = d.strength.tau_points;
  const bad = open.filter((x) => !x.model || !Number.isFinite(x.model.fair) || !(x.model.sigma > Math.sqrt(x.model.k) * tau) || Math.abs(x.model.fair) > 80);
  g('model.priced', bad.length === 0, open.length + ' remaining games priced by ' + d.model.model_version + ' from the replayed state (pricing week ' + d.model.pricing_week + ')' + (bad.length ? '; bad: ' + bad.slice(0, 5).map((x) => x.game_id).join(', ') : ''));
  const P = d.pairs, need = T * T;
  const pairsOk = [P.neutral_fair, P.neutral_sigma, P.home_fair, P.home_sigma].every((a) => a.length === need) && P.neutral_sigma.every((s, i) => i % (T + 1) === 0 || s > Math.sqrt(2) * tau) && P.home_sigma.every((s, i) => i % (T + 1) === 0 || s > Math.sqrt(2) * tau);
  g('model.postseason_pairs', pairsOk, (T * (T - 1)) + ' ordered pairings, neutral and home, each with game noise left after 2 tau^2');
  g('strength.calibrated', d.strength.tau_points > 0 && d.calibration.model_version === d.model.model_version,
    'tau ' + tau.toFixed(3) + ' (95% CI ' + d.strength.tau_ci95.map((x) => x.toFixed(2)).join('-') + ', as-of week ' + d.strength.as_of_week_used + ') from ' + d.strength.source, 'publication');
  const over = d.calibration.frozen_top_buckets.filter((b) => b.verdict === 'OVERCONFIDENT');
  g('calibration.favorites', over.length === 0 && d.calibration.frozen_top_buckets.length > 0,
    'frozen-forecast favourites 2022-2025: ' + d.calibration.frozen_top_buckets.map((b) => b.bucket.join('-') + ' n ' + b.n + ' predicted ' + b.predicted + ' won ' + b.won + ' (' + b.verdict + ')').join('; '), 'publication');
  g('calibration.live_board_divergence', true, 'the live board\'s 2026 numbers are more extreme than the validated replay (logit slope ' + d.calibration.live_vs_replay_logit_slope + '); the simulator prices from the replay', 'none');
  for (const [label, f] of cfbFacts(d.config)) {
    if (!f.affects_results) continue;
    const ok = isCfbVerified(f);
    g('rules.' + label.replace(/\s+/g, '_'), ok, f.label + ': ' + f.verification + (ok ? ' (' + f.sources[0].url + ')' : ' — ' + f.note.slice(0, 220)), 'publication');
  }
  const cm = cfpMode(d);
  g('cfp.mode', cm.mode !== 'off', cm.mode === 'off' ? 'no unconditional CFP or national-title probability: ' + cm.reason : 'CFP outputs from ' + cm.reason + (cm.mode === 'proxy' ? ' (Estimated)' : cm.mode === 'scenario' ? ' (CONDITIONAL)' : ''), 'none', true);
  /* the published tables carry a provenance per outcome but no condition: a scenario's numbers would read as unconditional */
  g('cfp.scenario_not_published', cm.mode !== 'scenario', 'a conditional bracket scenario (' + cm.reason + ') is research for its stated assumptions; the published tables cannot carry the condition, so it is never published', 'publication');
  g('availability.sourced', d.availability.entries.every((a) => /^https?:\/\//.test(a.source_url) && !!a.reported_at && !!a.recorded_by),
    d.availability.entries.length + ' sourced primary-QB absences applied; football/availability carried reports for ' + d.availability.live_layer.teams_with_records + ' teams');
  const drift = Object.entries(cfbCodeIdentity()).filter(([f, h]) => d.code_sha256[f] !== h).map(([f]) => f);
  g('replay.code_identity', drift.length === 0, drift.length ? 'pricing code changed since the snapshot: ' + drift.join(', ') + ' (check out the snapshot\'s commit)' : 'engine, parameters and input assembly match the snapshot', opt.ignoreCodeDrift ? 'publication' : 'simulation');
  g('postseason.cfp_not_complete', !d.postseason_feed.some((x) => x.kind === 'cfp' && x.done && /national championship/i.test(x.notes)), 'the national championship has not been played');
  return out;
}

/** the status each conference's forecast carries in the results */
export function conferenceStatus(d: CfbInputData, flags: Record<string, number>, n: number) {
  const facts = new Map(cfbFacts(d.config));
  return d.config.conferences.map((c) => {
    const f = facts.get(c.conference)!, metric = (flags['ccg_metric:' + c.conference] || 0) / n, unverified = (flags['ccg_unverified_rule:' + c.conference] || 0) / n;
    const status = isCfbVerified(f) ? 'VERIFIED_RULES' : f.verification === 'UNKNOWN' ? 'PROVISIONAL_RULES' : 'UNVERIFIED_RULES';
    return { conference: c.conference, procedure: c.procedure, verification: f.verification, status,
      runs_decided_by_estimated_ranking: Math.round(metric * 1e6) / 1e6,
      runs_tie_decided_by_unverified_procedure: Math.round(unverified * 1e6) / 1e6,
      runs_decided_by_draw: Math.round(((flags['ccg_draw:' + c.conference] || 0) / n) * 1e6) / 1e6,
      publishable: status === 'VERIFIED_RULES',
      leans_on_estimated_ranking: metric > ESTIMATED_RANKING_WARN,
      note: status === 'VERIFIED_RULES' ? 'rules read from the conference\'s own text' : 'every run without a tie is rule-independent; ' + (unverified * 100).toFixed(2) + '% of runs needed the unverified procedure' };
  });
}

/** above this share of runs, a conference's title-game forecast is flagged as leaning on the Estimated ranking surrogate */
export const ESTIMATED_RANKING_WARN = 0.05;

/** run gates on the counted flags */
export function cfbRunGates(d: CfbInputData, flags: Record<string, number>, n: number): Gate[] {
  const out: Gate[] = [];
  for (const c of conferenceStatus(d, flags, n)) {
    const heavy = c.runs_decided_by_estimated_ranking > ESTIMATED_RANKING_WARN;
    out.push({ id: 'run.ccg_estimated_ranking:' + c.conference, status: heavy ? 'WARN' : 'PASS', blocks: 'none',
      detail: (c.runs_decided_by_estimated_ranking * 100).toFixed(2) + '% of runs had a title-game berth (or a hosted game\'s host) decided by a step naming an external ranking, resolved by the Estimated surrogate; draws ' + (c.runs_decided_by_draw * 100).toFixed(3) + '%'
        + (heavy ? '. Above ' + (ESTIMATED_RANKING_WARN * 100) + '%: this conference\'s title-game probabilities lean on the surrogate and are labelled so.' : '') });
    if (!c.publishable) out.push({ id: 'run.ccg_unverified_procedure:' + c.conference, status: 'FAIL', blocks: 'publication', detail: c.verification + ': ' + c.note });
  }
  for (const e of d.config.eligibility) {
    const k = 'eligibility_sensitive:' + e.team, x = (flags[k] || 0) / n;
    out.push({ id: 'run.' + k, status: isCfbVerified(e.fact) || x === 0 ? 'PASS' : 'FAIL', blocks: isCfbVerified(e.fact) || x === 0 ? 'none' : 'publication',
      detail: (x * 100).toFixed(3) + '% of runs would have a different title-game pair under the opposite eligibility assumption for ' + e.team + ' (' + e.fact.verification + ')' });
  }
  return out;
}
