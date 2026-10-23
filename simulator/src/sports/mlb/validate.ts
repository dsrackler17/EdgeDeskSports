/* ===========================================================================
   MLB input validation (blocks the simulation) and publication gates.
   Every check returns PASS / FAIL / WARN with its evidence.
   =========================================================================== */
import { codeHashes, type MlbSnapshot, type MlbInputGame } from './inputs.ts';
import { Season, Standings, qualify, playPostseason, type RegGame } from './rules.ts';
import { lambdas } from './model_adapter.ts';
import { dayOf } from './history.ts';
import type { Gate } from '../nfl/validate.ts';

export type { Gate };

export function validateMlbInputs(snap: MlbSnapshot, opt: { ignoreCodeDrift?: boolean } = {}): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => {
    out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail });
  };
  const codes = new Set(d.teams.map((t) => t.code));
  const reg = d.games.filter((x) => x.phase === 'regular'), post = d.games.filter((x) => x.phase === 'postseason');
  g('format.supported', d.format.id === 'MLB-2022', 'format ' + d.format.id + ' (the module simulates MLB-2022: no tiebreaker games)');
  /* the schedule */
  const per: Record<string, number> = {}; const ids = new Set<string>();
  for (const x of d.games) { ids.add(x.id); if (x.phase === 'regular') { per[x.home] = (per[x.home] || 0) + 1; per[x.away] = (per[x.away] || 0) + 1; } }
  const counts = [...codes].map((c) => per[c] || 0);
  const full = counts.every((c) => c === d.config.regular_season_games_per_club);
  g('schedule.teams', d.games.every((x) => codes.has(x.home) && codes.has(x.away) && x.home !== x.away) && d.teams.length === 30, 'every game names two of the 30 configured clubs');
  g('schedule.unique', ids.size === d.games.length, d.games.length + ' games, ' + ids.size + ' distinct ids');
  g('schedule.complete', counts.every((c) => c >= d.config.regular_season_games_per_club - 2 && c <= d.config.regular_season_games_per_club + 1),
    reg.length + ' regular-season games; per club ' + Math.min(...counts) + '-' + Math.max(...counts) + ' (' + d.config.regular_season_games_per_club + ' scheduled; a cancelled game is not made up)');
  g('schedule.full_162', full, 'every club has exactly ' + d.config.regular_season_games_per_club + ' games: ' + JSON.stringify(per), 'none', true);
  /* alignment: every pair of division rivals meets more often than any two clubs of different divisions */
  const pair: Record<string, number> = {};
  for (const x of reg) { const k = x.home < x.away ? x.home + x.away : x.away + x.home; pair[k] = (pair[k] || 0) + 1; }
  const divOf: Record<string, string> = {}; d.teams.forEach((t) => { divOf[t.code] = t.division; });
  let minDiv = Infinity, maxOther = 0;
  for (const a of d.teams) for (const b of d.teams) { if (a.code >= b.code) continue; const n = pair[a.code < b.code ? a.code + b.code : b.code + a.code] || 0; if (a.division === b.division) minDiv = Math.min(minDiv, n); else maxOther = Math.max(maxOther, n); }
  g('schedule.alignment', minDiv > maxOther, 'division rivals meet at least ' + minDiv + ' times, any other pair at most ' + maxOther + ' (the configured divisions are the schedule\'s)');
  /* results */
  const asDay = dayOf(d.as_of);
  const fin = d.games.filter((x) => x.status === 'final');
  g('results.completed', fin.every((x) => Number.isInteger(x.home_score) && Number.isInteger(x.away_score) && (x.home_score as number) >= 0 && (x.away_score as number) >= 0), fin.length + ' completed games, every one with both scores');
  g('results.as_of', fin.every((x) => dayOf(x.date) < asDay) && d.games.filter((x) => x.status === 'scheduled').every((x) => x.date_estimated || dayOf(x.date) >= asDay),
    'every completed game is dated before the as-of morning ' + d.as_of + ' and every scheduled one on or after it');
  const ties = fin.filter((x) => x.phase === 'regular' && x.home_score === x.away_score);
  g('results.no_ties', ties.length === 0, ties.length + ' completed regular-season games ended level (a called game never resumed): counted in neither column' + (ties.length ? ': ' + ties.map((x) => x.id).join(', ') : ''), 'none', true);
  g('results.postseason_decided', post.filter((x) => x.status === 'final').every((x) => x.home_score !== x.away_score), 'every completed postseason game has a winner');
  /* starters: only Observed (completed) and Confirmed (announced) are stored; Projected exists only inside a run */
  const badLabel = d.games.filter((x) => [x.starters.home, x.starters.away].some((s) => s && (x.status === 'final' ? s.status !== 'Observed' : s.status !== 'Confirmed')));
  g('starters.labels', badLabel.length === 0, 'completed games carry Observed starters, scheduled games Confirmed ones or none (projected in the run)' + (badLabel.length ? '; wrong: ' + badLabel.slice(0, 5).map((x) => x.id).join(', ') : ''));
  const confirmed = d.games.filter((x) => x.status === 'scheduled' && (x.starters.home || x.starters.away)).length;
  const noStarter = fin.filter((x) => !x.starters.home || !x.starters.away).length;
  g('starters.observed', noStarter === 0, noStarter + ' completed games without an observed starter (rotations are built from the others)', 'none', true);
  const thin = d.teams.filter((t) => (d.rotation.clubs[t.code] || { members: [] }).members.length < 5);
  g('rotation.clubs', thin.length === 0, 'every club has a five-man as-of rotation' + (thin.length ? '; fewer: ' + thin.map((t) => t.code + ' ' + (d.rotation.clubs[t.code] || { members: [] }).members.length).join(', ') : '') + '; ' + confirmed + ' scheduled games carry an announced starter', 'none', true);
  const P = d.rotation.params;
  g('rotation.params', P && P.min_rest_days === 5 && P.survival.length > 0 && Object.values(P.p_spot).every((x) => x >= 0 && x < 1), 'rotation model from ' + d.rotation.source + ' (spot ' + JSON.stringify(P.p_spot) + ')');
  /* the model */
  const M = d.model.state, c = d.model.calibration;
  g('model.fit', !!M && Number.isFinite(M.mu) && Number.isFinite(M.home) && d.teams.every((t) => M.teams[t.code] && Number.isFinite(M.teams[t.code].o)) && c.r > 0 && c.xi > 0 && c.xi < 1 && c.recal.every(Number.isFinite),
    d.model.model_version + ' fitted as of ' + d.model.fit_as_of + '; calibration of ' + c.season + ': r ' + c.r + ', xi ' + c.xi.toFixed(4) + ', recal ' + c.recal.map((x) => x.toFixed(4)).join('/'));
  const open = d.games.filter((x) => x.status === 'scheduled');
  const bad = open.filter((x) => { const l = lambdas(M, x.home, x.away, 0, 0); return !(l.lh > 0.5 && l.lh < 15 && l.la > 0.5 && l.la < 15); });
  g('model.every_remaining_game', bad.length === 0, open.length + ' scheduled games priced' + (bad.length ? '; out of range: ' + bad.slice(0, 5).map((x) => x.id).join(', ') : ''));
  g('model.postseason_xi', d.model.xi_postseason > 0.4 && d.model.xi_postseason < 0.6, 'postseason level draws resolve at ' + d.model.xi_postseason + ' (' + d.model.xi_postseason_source + ')');
  const s = d.strength;
  g('strength.calibrated', Number.isFinite(s.sigma_team) && s.sigma_team >= 0 && s.sigma_team < 0.5 && Number.isFinite(s.sigma_sp) && s.sigma_sp >= 0 && s.sigma_sp < 0.5,
    'sigma_team ' + s.sigma_team + ' ' + JSON.stringify(s.sigma_team_ci95) + ' (stage ' + s.stage + '), sigma_sp ' + s.sigma_sp + ' ' + JSON.stringify(s.sigma_sp_ci95));
  /* the postseason the schedule already holds must be the bracket's */
  if (post.length) {
    const okReg = d.regular_season_complete;
    g('postseason.after_regular_season', okReg, 'postseason games exist and the regular season is ' + (okReg ? 'complete' : 'NOT complete'));
    if (okReg) {
      const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
      const S = new Season(d.teams, reg.map((x): RegGame => ({ home: ix[x.home], away: ix[x.away], day: dayOf(x.date), game_no: x.game_no })));
      const win = Int8Array.from(reg.map((x) => ((x.home_score as number) > (x.away_score as number) ? 1 : (x.home_score as number) < (x.away_score as number) ? -1 : 0)));
      const st = new Standings(S, win, { rng: null });
      const key = (r: string, a: string, b: string, k: number) => r + '|' + (a < b ? a + b : b + a) + '|' + k;
      const known = new Map<string, MlbInputGame>(); post.forEach((x) => known.set(key(x.round as string, x.home, x.away, x.series_game as number), x));
      const seen = new Set<string>(); const problems: string[] = [];
      try {
        playPostseason(st, d.format, qualify(st, d.format), (spec, k, home, away) => {
          const x = known.get(key(spec.round, d.teams[home].code, d.teams[away].code, k));
          if (!x) return home;
          seen.add(x.id);
          if (x.home !== d.teams[home].code) problems.push(x.id + ': hosted by ' + x.home + ', the format says ' + d.teams[home].code);
          return x.status === 'final' ? ((x.home_score as number) > (x.away_score as number) ? ix[x.home] : ix[x.away]) : home;
        });
      } catch (e) { problems.push(String((e as Error).message)); }
      const missing = post.filter((x) => !seen.has(x.id));
      g('postseason.consistent', problems.length === 0 && missing.length === 0,
        post.length + ' postseason games on the schedule (' + post.filter((x) => x.status === 'final').length + ' final, fixed); every one is a game of the bracket the final standings produce, at the format\'s host' +
        (problems.length ? '; ' + problems.slice(0, 4).join('; ') : '') + (missing.length ? '; not in the bracket: ' + missing.slice(0, 4).map((x) => x.id).join(', ') : ''));
    }
  }
  if (!opt.ignoreCodeDrift) {
    const now = codeHashes(), drift = Object.keys(d.code_sha256).filter((f) => now[f] !== d.code_sha256[f]);
    g('replay.code_identity', drift.length === 0, drift.length ? 'files changed since the snapshot was built (check out the snapshot\'s commit to replay): ' + drift.join(', ') : 'every model, rules, rotation and study file matches the snapshot');
  }
  return out;
}

/** Clinched / Eliminated. With regular-season games left: sound SUFFICIENT conditions on the current standings
    only (no tiebreakers). With none left: the final standings through the tiebreak procedure (exact). */
export function mlbMathStatus(d: MlbSnapshot['data']): Record<string, { division: 'clinched' | 'eliminated' | null; playoffs: 'clinched' | 'eliminated' | null }> {
  if (d.games.every((x) => x.phase !== 'regular' || x.status === 'final')) {
    const reg = d.games.filter((x) => x.phase === 'regular');
    const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
    const S = new Season(d.teams, reg.map((x): RegGame => ({ home: ix[x.home], away: ix[x.away], day: dayOf(x.date), game_no: x.game_no })));
    const st = new Standings(S, Int8Array.from(reg.map((x) => ((x.home_score as number) > (x.away_score as number) ? 1 : (x.home_score as number) < (x.away_score as number) ? -1 : 0))), { rng: null });
    const q = qualify(st, d.format);
    const winners = new Set(q.flatMap((L) => L.divisionWinners)), seeded = new Set(q.flatMap((L) => L.seeds));
    return Object.fromEntries(d.teams.map((t, i) => [t.code, { division: winners.has(i) ? 'clinched' : 'eliminated', playoffs: seeded.has(i) ? 'clinched' : 'eliminated' }])) as any;
  }
  const w: Record<string, number> = {}, rem: Record<string, number> = {};
  for (const t of d.teams) { w[t.code] = 0; rem[t.code] = 0; }
  for (const x of d.games) {
    if (x.phase !== 'regular') continue;
    if (x.status !== 'final') { rem[x.home]++; rem[x.away]++; continue; }
    if ((x.home_score as number) > (x.away_score as number)) w[x.home]++; else if ((x.home_score as number) < (x.away_score as number)) w[x.away]++;
  }
  const max = (c: string) => w[c] + rem[c];
  const out: Record<string, { division: 'clinched' | 'eliminated' | null; playoffs: 'clinched' | 'eliminated' | null }> = {};
  for (const t of d.teams) {
    const div = d.teams.filter((x) => x.division === t.division && x.code !== t.code);
    const lg = d.teams.filter((x) => x.league === t.league && x.code !== t.code);
    let division: 'clinched' | 'eliminated' | null = null, playoffs: 'clinched' | 'eliminated' | null = null;
    if (div.every((x) => max(x.code) < w[t.code])) division = 'clinched';
    else if (div.some((x) => w[x.code] > max(t.code))) division = 'eliminated';
    /* CLINCHED if at most 2 league rivals can even reach this club's wins: then at most 2 clubs finish level or
       ahead, so it is at worst the third wild card. ELIMINATED if it cannot win its division and 6 rivals already
       have more wins than its best: at most 3 of them win divisions, so 3 non-winners take every wild card. */
    if (division === 'clinched' || lg.filter((x) => max(x.code) >= w[t.code]).length <= 2) playoffs = 'clinched';
    else if (division === 'eliminated' && lg.filter((x) => w[x.code] > max(t.code)).length >= 6) playoffs = 'eliminated';
    out[t.code] = { division, playoffs };
  }
  return out;
}
