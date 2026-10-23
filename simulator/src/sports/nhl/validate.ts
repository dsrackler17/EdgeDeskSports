/* ===========================================================================
   NHL input validation (blocks the simulation) and publication gates (block
   publishing). Every check returns PASS / FAIL / WARN with its evidence.
   =========================================================================== */
import { codeHashes, type NhlSnapshot } from './inputs.ts';
import { NHL_TEAMS_2027 } from './config.ts';
import type { Gate } from '../nfl/validate.ts';

export function validateNhlInputs(snap: NhlSnapshot, opt: { ignoreCodeDrift?: boolean } = {}): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => {
    out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail });
  };
  const teams = NHL_TEAMS_2027, codes = new Set(teams.map((t) => t.code));
  const N = d.config.regular_season_games_per_club;
  const perClub: Record<string, number> = {}, homes: Record<string, number> = {};
  const pair = new Map<string, number>();
  const divOf: Record<string, string> = {}, confOf: Record<string, string> = {};
  teams.forEach((t) => { divOf[t.code] = t.division; confOf[t.code] = t.conference; });
  const ids = new Set<number>();
  for (const x of d.games) {
    perClub[x.home] = (perClub[x.home] || 0) + 1; perClub[x.away] = (perClub[x.away] || 0) + 1; homes[x.home] = (homes[x.home] || 0) + 1;
    ids.add(x.game_id);
    const k = [x.home, x.away].sort().join('-'); pair.set(k, (pair.get(k) || 0) + 1);
  }
  g('schedule.complete', d.games.length === N * teams.length / 2 && ids.size === d.games.length && [...codes].every((c) => perClub[c] === N && homes[c] === N / 2),
    d.games.length + ' regular-season games (' + (N * teams.length / 2) + ' expected), every club ' + N + ' (' + N / 2 + ' at home)');
  /* the alignment, re-derived from how often each pair meets */
  let bad = 0;
  for (const a of teams) for (const b of teams) {
    if (a.code >= b.code) continue;
    const n = pair.get(a.code + '-' + b.code) || 0;
    const want = divOf[a.code] === divOf[b.code] ? 4 : confOf[a.code] === confOf[b.code] ? 3 : 2;
    if (n !== want) bad++;
  }
  g('schedule.alignment', bad === 0, 'division rivals meet 4 times, other conference clubs 3, cross-conference clubs 2 (' + bad + ' pairs disagree with the configured alignment)');
  g('schedule.teams', d.games.every((x) => codes.has(x.home) && codes.has(x.away)), 'every game names two configured clubs');
  const doneBad = d.games.filter((x) => x.done && !(Number.isInteger(x.home_score) && Number.isInteger(x.away_score) && Number.isInteger(x.reg_home) && Number.isInteger(x.reg_away)
    && (x.decided === 'REG' ? x.reg_home !== x.reg_away && Math.sign(x.home_score! - x.away_score!) === Math.sign(x.reg_home! - x.reg_away!)
      : (x.decided === 'OT' || x.decided === 'SO') && x.reg_home === x.reg_away && Math.abs(x.home_score! - x.away_score!) === 1)));
  g('results.classified', doneBad.length === 0, d.games.filter((x) => x.done).length + ' completed games, each decided REG (60-minute winner), OT or SO (tied after 60 minutes, won by one)' + (doneBad.length ? '; inconsistent: ' + doneBad.slice(0, 5).map((x) => x.game_id).join(', ') : ''));
  g('results.reconcile', d.reconciliation.mismatches.length === 0, d.reconciliation.compared + ' team-game results compared with the schedule\'s finals' + (d.reconciliation.mismatches.length ? '; ' + d.reconciliation.mismatches.slice(0, 5).join('; ') : ''));
  const unresolved = d.reconciliation.lagging.filter((x) => x.status === 'UNRESOLVED');
  g('results.lagging', unresolved.length === 0, d.reconciliation.lagging.length + ' finals not yet in the team-game table, read from their game files' + (unresolved.length ? '; UNRESOLVED (a played game is never simulated): ' + unresolved.map((x) => x.detail).join('; ') : ''));
  const open = d.games.filter((x) => !x.done);
  const live = open.filter((x) => /^(LIVE|CRIT)$/.test(String(x.state || '')));
  g('schedule.no_live_games', live.length === 0, live.length + ' games in progress when the snapshot was built' + (live.length ? ' (priced from puck drop as if unplayed: rebuild after they end): ' + live.map((x) => x.game_id).join(', ') : ''), 'publication', true);
  const badModel = open.filter((x) => !x.model || !(x.model.lam_home > 0.5 && x.model.lam_home < 8) || !(x.model.lam_away > 0.5 && x.model.lam_away < 8));
  g('model.every_remaining_game', badModel.length === 0, open.length + ' remaining games priced by ' + d.model.model_version + (badModel.length ? '; missing or out of range: ' + badModel.slice(0, 5).map((x) => x.game_id).join(', ') : ''));
  const gl = open.filter((x) => x.model && x.model.goalies);
  g('model.goalies', gl.every((x) => !!x.model!.goalies!.source && !!x.model!.goalies!.recorded_at), gl.length + ' remaining games priced with a confirmed starter (source and time recorded); every other game on the baseline: ' + d.config.availability.baseline.split('.')[0] + '.', 'simulation');
  let pairsOk = 0;
  for (const h of teams) for (const a of teams) { if (h.code === a.code) continue; const e = d.postseason_pairs[h.code] && d.postseason_pairs[h.code][a.code]; if (e && e[0] > 0.5 && e[0] < 8 && e[1] > 0.5 && e[1] < 8) pairsOk++; }
  g('model.postseason_pairs', pairsOk === teams.length * (teams.length - 1), pairsOk + ' playoff pairings priced (' + teams.length * (teams.length - 1) + ' expected)');
  const dp = d.model.dist;
  g('model.distribution', !!dp && !!dp.effects && dp.ot && dp.ot.format === 'R3v3' && dp.ot.k > 0 && dp.ot.so_home > 0 && dp.ot.so_home < 1 && dp.draw_inflation >= 0,
    'score effects, 3-on-3 overtime (k ' + (dp && dp.ot.k) + ', shootout home ' + (dp && dp.ot.so_home) + '), 60-minute draw inflation ' + (dp && dp.draw_inflation) + ' (' + (d.goal_distribution.adopted ? 'adopted by' : 'not adopted by') + ' the goal-distribution study)');
  g('model.draw_bias', true, 'served 60-minute tie bias (predicted − observed): ' + JSON.stringify(d.goal_distribution.tie_bias) + ' — a stated limitation', 'none');
  const s = d.strength;
  g('strength.calibrated', Number.isFinite(s.sigma) && s.sigma >= 0 && s.sigma < 0.5 && Array.isArray(s.sigma_ci95), 'sigma ' + s.sigma.toFixed(4) + ' (log goal rate), 95% CI ' + JSON.stringify(s.sigma_ci95.map((x) => Math.round(x * 1e4) / 1e4)) + ' at ' + s.at_games_played + ' games played (' + s.checkpoint + ')');
  /* the playoff state: every completed playoff game classified and only after the regular season */
  const pDone = d.playoffs.filter((x) => x.done);
  const pBad = pDone.filter((x) => !(Number.isInteger(x.home_score) && Number.isInteger(x.away_score) && x.home_score !== x.away_score && (x.decided === 'REG' || x.decided === 'OT')));
  g('postseason.state', pBad.length === 0 && (pDone.length === 0 || open.length === 0),
    pDone.length + ' completed playoff games kept as played' + (pBad.length ? '; inconsistent (a playoff game has no shootout): ' + pBad.map((x) => x.game_id).join(', ') : '') + (pDone.length && open.length ? '; playoff games before the regular season ended' : ''));
  if (!opt.ignoreCodeDrift) {
    const now = codeHashes(), drift = Object.keys(d.code_sha256).filter((f) => now[f] !== d.code_sha256[f]);
    g('replay.code_identity', drift.length === 0, drift.length ? 'files changed since the snapshot was built (check out the snapshot\'s commit to replay): ' + drift.join(', ') : 'every hockey model, parameter and study file matches the snapshot (simulator code is identified by engine_version)');
  }
  return out;
}
