/* ===========================================================================
   NFL input validation (blocks the simulation) and publication gates (block
   publishing). Every check returns PASS / FAIL / WARN with its evidence.
   =========================================================================== */
import { codeHashes, type NflInputData, type NflSnapshot } from './inputs.ts';
import { NFL_TEAMS_2026 } from './config.ts';

export interface Gate { id: string; status: 'PASS' | 'FAIL' | 'WARN'; blocks: 'simulation' | 'publication' | 'none'; detail: string }

/** checks on the snapshot itself: any FAIL here stops the run before it starts */
export function validateNflInputs(snap: NflSnapshot, opt: { allowUnreconciled?: boolean; ignoreCodeDrift?: boolean } = {}): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => {
    out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail });
  };
  const codes = new Set(NFL_TEAMS_2026.map((t) => t.code));
  const perClub: Record<string, number> = {}, divGames: Record<string, number> = {};
  const divOf: Record<string, string> = {}; NFL_TEAMS_2026.forEach((t) => { divOf[t.code] = t.division; });
  let flagMismatch = 0;
  const ids = new Set<string>();
  for (const x of d.games) {
    perClub[x.home] = (perClub[x.home] || 0) + 1; perClub[x.away] = (perClub[x.away] || 0) + 1;
    ids.add(x.game_id);
    const same = divOf[x.home] === divOf[x.away];
    if (same) { divGames[x.home] = (divGames[x.home] || 0) + 1; divGames[x.away] = (divGames[x.away] || 0) + 1; }
    if (same !== x.div_game) flagMismatch++;
  }
  const expectGames = d.config.regular_season_games_per_club * 16;
  g('schedule.complete', d.games.length === expectGames && ids.size === d.games.length && [...codes].every((c) => perClub[c] === d.config.regular_season_games_per_club),
    d.games.length + ' games (' + expectGames + ' expected), every club ' + d.config.regular_season_games_per_club + ': ' + JSON.stringify(perClub));
  g('schedule.alignment', flagMismatch === 0 && [...codes].every((c) => divGames[c] === 6),
    'division-game flags agree with the configured alignment (' + flagMismatch + ' disagree); every club plays 6 division games');
  g('schedule.teams', d.games.every((x) => codes.has(x.home) && codes.has(x.away)), 'every game names two configured clubs');
  g('results.completed', d.games.every((x) => !x.done || (Number.isInteger(x.home_score) && Number.isInteger(x.away_score))), 'every completed game has both scores');
  const recOk = d.reconciliation.status === 'OK';
  g('results.reconcile', recOk,
    'completed results vs nflverse standings: ' + d.reconciliation.status + (d.reconciliation.mismatches.length ? ' — ' + d.reconciliation.mismatches.slice(0, 6).join('; ') : ''),
    d.reconciliation.status === 'MISMATCH' ? 'simulation' : 'publication', d.reconciliation.status === 'UNAVAILABLE' && !!opt.allowUnreconciled);
  const open = d.games.filter((x) => !x.done);
  const badModel = open.filter((x) => !x.model || !Number.isFinite(x.model.fair_margin) || Math.abs(x.model.fair_margin) > 60 || !Number.isFinite(x.model.fair_total));
  g('model.every_remaining_game', badModel.length === 0, open.length + ' remaining games priced by ' + d.model.model_version + (badModel.length ? '; missing: ' + badModel.map((x) => x.game_id).join(', ') : ''));
  const q = open.filter((x) => x.model && x.model.quality !== 'OK');
  g('model.data_quality', q.length === 0, q.length + ' remaining games with a data-quality warning: ' + q.slice(0, 5).map((x) => x.game_id + ' ' + (x.model as any).quality).join(', '), 'none', true);
  let pairsOk = true, nPairs = 0;
  for (const h of NFL_TEAMS_2026) for (const a of NFL_TEAMS_2026) {
    if (h.code === a.code) continue;
    const need: Array<[string, any]> = h.conference === a.conference ? [['default', d.postseason_pairs.default], ['home_off_bye', d.postseason_pairs.home_off_bye]]
      : h.conference === d.config.super_bowl.value.designated_home ? [['super_bowl', d.postseason_pairs.super_bowl]] : [];
    for (const [, tab] of need) { const e = tab[h.code] && tab[h.code][a.code]; nPairs++; if (!e || !Number.isFinite(e.m) || !Number.isFinite(e.t) || Math.abs(e.m) > 60) pairsOk = false; }
  }
  g('model.postseason_pairs', pairsOk && nPairs === 2 * 2 * 16 * 15 + 256, nPairs + ' postseason pairings priced');
  const s = d.strength;
  g('strength.calibrated', Number.isFinite(s.sigma_points) && s.sigma_points >= 0 && s.sigma_points < 10 && Array.isArray(s.sigma_ci95), 'sigma ' + s.sigma_points + ' points, 95% CI ' + JSON.stringify(s.sigma_ci95) + ' (' + s.method + ')');
  g('scoring.points_model', !!d.points_model && d.points_model.method === 'KERNEL_JOINT', d.points_model ? 'team-points method ' + d.points_model.method + ' (' + d.points_model.status + '), source ' + d.points_model.source : 'no points model in the snapshot');
  g('postseason.not_started', d.games.length === expectGames, 'this version starts from the regular season; a schedule with postseason games is refused at build time');
  if (!opt.ignoreCodeDrift) {
    const now = codeHashes(), drift = Object.keys(d.code_sha256).filter((f) => now[f] !== d.code_sha256[f]);
    g('replay.code_identity', drift.length === 0, drift.length ? 'files changed since the snapshot was built (check out the snapshot\'s commit to replay): ' + drift.join(', ') : 'every model and rules file matches the snapshot');
  }
  return out;
}

/** sound SUFFICIENT conditions on the current standings only (no tiebreakers):
    shown as Clinched / Eliminated; anything else is left to the simulation */
export function nflMathStatus(d: NflInputData): Record<string, { division: 'clinched' | 'eliminated' | null; playoffs: 'clinched' | 'eliminated' | null }> {
  const w2: Record<string, number> = {}, rem: Record<string, number> = {};
  for (const t of d.teams) { w2[t.code] = 0; rem[t.code] = 0; }
  for (const g of d.games) {
    if (!g.done) { rem[g.home]++; rem[g.away]++; continue; }
    const m = (g.home_score as number) - (g.away_score as number);
    w2[g.home] += m > 0 ? 2 : m === 0 ? 1 : 0; w2[g.away] += m < 0 ? 2 : m === 0 ? 1 : 0;
  }
  const max = (c: string) => w2[c] + 2 * rem[c];
  const out: Record<string, { division: 'clinched' | 'eliminated' | null; playoffs: 'clinched' | 'eliminated' | null }> = {};
  for (const t of d.teams) {
    const div = d.teams.filter((x) => x.division === t.division && x.code !== t.code);
    const conf = d.teams.filter((x) => x.conference === t.conference && x.code !== t.code);
    let division: 'clinched' | 'eliminated' | null = null, playoffs: 'clinched' | 'eliminated' | null = null;
    if (div.every((x) => max(x.code) < w2[t.code])) division = 'clinched';
    else if (div.some((x) => w2[x.code] > max(t.code))) division = 'eliminated';
    /* playoffs. CLINCHED if at most 2 conference rivals can even reach this club's
       current record: then, division winner or not, at most 2 non-winners can finish
       level or ahead, so it is at worst the 3rd wild card. ELIMINATED only if it
       cannot win its division AND 7 rivals are already beyond its best possible
       record: at most 4 of them are division winners, so at least 3 non-winners
       finish strictly ahead and take every wild card. */
    if (division === 'clinched' || conf.filter((x) => max(x.code) >= w2[t.code]).length <= 2) playoffs = 'clinched';
    else if (division === 'eliminated' && conf.filter((x) => w2[x.code] > max(t.code)).length >= 7) playoffs = 'eliminated';
    out[t.code] = { division, playoffs };
  }
  return out;
}
