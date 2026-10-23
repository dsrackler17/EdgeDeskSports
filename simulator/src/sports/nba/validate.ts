/* ===========================================================================
   NBA input validation (blocks the simulation) and publication gates (block
   publishing). Every check returns PASS / FAIL / WARN with its evidence.
   =========================================================================== */
import { codeHashes, MAX_POSTSEASON_GAMES, type NbaInputData, type NbaSnapshot } from './inputs.ts';
import { NBA_TEAMS } from './config.ts';
import { League, Standings, seedConferences, playPostseason, rulesFor, type NbaGame, type PlayedGame } from './rules.ts';
import { contextKeys, contextKey } from './postseason_context.ts';
import { streamFor, STREAM } from '../../core/prng.ts';
import type { Gate } from '../nfl/validate.ts';
export type { Gate };

export const NBA_REGULAR_SEASON_GAMES = 1230;

/** checks on the snapshot itself: any FAIL that blocks the simulation stops the run before it starts */
export function validateNbaInputs(snap: NbaSnapshot, opt: { allowIncompleteSchedule?: boolean; ignoreCodeDrift?: boolean } = {}): Gate[] {
  const d = snap.data, out: Gate[] = [];
  const g = (id: string, ok: boolean, detail: string, blocks: Gate['blocks'] = 'simulation', warn = false): void => {
    out.push({ id, status: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', blocks: ok ? 'none' : blocks, detail });
  };
  const codes = new Set(NBA_TEAMS.map((t) => t.code));
  const conf: Record<string, string> = {}, div: Record<string, string> = {}; for (const t of d.teams) { conf[t.code] = t.conference; div[t.code] = t.division; }
  const per: Record<string, number> = {}, pair: Record<string, number> = {}; const ids = new Set<string>();
  for (const x of d.games) { per[x.home] = (per[x.home] || 0) + 1; per[x.away] = (per[x.away] || 0) + 1; ids.add(x.game_id); const k = [x.home, x.away].sort().join('-'); pair[k] = (pair[k] || 0) + 1; }
  const n = d.config.regular_season_games_per_club;
  const complete = d.games.length === NBA_REGULAR_SEASON_GAMES && ids.size === d.games.length && [...codes].every((c) => per[c] === n);
  g('schedule.complete', complete,
    d.games.length + ' regular-season games on the schedule (' + NBA_REGULAR_SEASON_GAMES + ' expected, ' + n + ' per club)' + (complete ? '' : ': the NBA Cup-dependent games are not scheduled yet — ' + JSON.stringify(per)),
    opt.allowIncompleteSchedule ? 'publication' : 'simulation', !!opt.allowIncompleteSchedule);
  /* the alignment against the schedule: a division rival at least three times so far (four when complete), a conference rival at least three, the other conference two */
  let bad: string[] = [];
  for (const a of d.teams) for (const b of d.teams) {
    if (a.code >= b.code) continue;
    const c = pair[[a.code, b.code].sort().join('-')] || 0;
    const want = div[a.code] === div[b.code] ? (complete ? 4 : 3) : conf[a.code] === conf[b.code] ? 3 : 2;
    if (c < want || (conf[a.code] !== conf[b.code] && c > 3)) bad.push(a.code + '-' + b.code + ' ' + c);
  }
  g('schedule.alignment', bad.length === 0, 'game counts agree with the configured conferences and divisions' + (bad.length ? '; disagree: ' + bad.slice(0, 8).join(', ') : ''));
  g('schedule.teams', d.games.every((x) => codes.has(x.home) && codes.has(x.away)) && d.teams.length === 30, 'every game names two configured clubs; 30 clubs');
  g('results.completed', d.games.concat(d.postseason_rows).every((x) => !x.done || (Number.isInteger(x.home_score) && Number.isInteger(x.away_score) && x.home_score !== x.away_score)), 'every completed game has both scores and a winner');
  g('results.integrity', d.integrity.box_mismatch === 0, 'schedule finals vs team box-score points: ' + d.integrity.box_mismatch + ' mismatches (' + d.integrity.source + '); play-by-play final mismatches ' + d.integrity.final_mismatch + ' (diagnostic)', 'publication');
  g('results.current', d.integrity.stale_scheduled.length === 0, d.integrity.stale_scheduled.length + ' games started more than 6 hours before the as-of time and are not final in the data' + (d.integrity.stale_scheduled.length ? ' (' + d.integrity.stale_scheduled.slice(0, 6).join(', ') + '): the results feed is behind; they are simulated as remaining' : ''), 'publication', true);
  const open = d.games.filter((x) => !x.done);
  const badModel = open.filter((x) => !x.model || ![x.model.mu, x.model.pace, x.model.s_plr, x.model.s_adj].every(Number.isFinite) || Math.abs(x.model.mu) > 40);
  g('model.every_remaining_game', badModel.length === 0, open.length + ' remaining regular-season games priced by ' + d.model.model_version + (badModel.length ? '; missing: ' + badModel.slice(0, 6).map((x) => x.game_id).join(', ') : ''));
  let nPairs = 0, pairsOk = true;
  for (const ck of contextKeys()) {
    const tab = d.postseason_pairs[contextKey(ck.round, ck.key, ck.game_no)] || {};
    for (const h of d.teams) for (const a of d.teams) {
      if (h.code === a.code || (ck.round === 'finals') !== (h.conference !== a.conference)) continue;
      const e = tab[h.code] && tab[h.code][a.code]; nPairs++;
      if (!e || ![e.mu, e.pace, e.s_plr, e.s_adj].every(Number.isFinite) || Math.abs(e.mu) > 40) pairsOk = false;
    }
  }
  g('model.postseason_pairs', pairsOk && nPairs === (3 + 21) * 420 + 7 * 450, nPairs + ' postseason pairings priced (play-in and three rounds within each conference, the Finals across)');
  const s = d.strength;
  g('strength.calibrated', !!s && Number.isFinite(s.sigma_points) && s.sigma_points >= 0 && s.sigma_points < 15 && Array.isArray(s.sigma_ci95),
    s ? 'sigma ' + s.sigma_points.toFixed(3) + ' points at ' + s.as_of_games + ' games, 95% CI ' + JSON.stringify(s.sigma_ci95.map((x) => Math.round(x * 1000) / 1000)) + ' (' + s.method + ')' : 'no strength-uncertainty study: simulator/data/nba_strength_uncertainty.json (npm run sim:nba:uncertainty)');
  /* availability: every distribution a unit mass, every subset table complete */
  const av = d.availability; let avBad: string[] = [], nTracked = 0;
  for (const t of d.teams) {
    const a = av.teams[t.code]; if (!a) { avBad.push(t.code + ': no entry'); continue; }
    nTracked += a.tracked.length;
    if (a.subsets.net.length !== 1 << a.tracked.length || a.subsets.full.length !== a.subsets.net.length) avBad.push(t.code + ': subset table');
    for (const x of a.tracked) { const m = x.dist.periods.reduce((u, p) => u + p.probability, 0) + x.dist.out_for_season; if (!(Math.abs(m - 1) < 1e-9) || !x.dist.source) avBad.push(t.code + ' ' + x.player_id + ': mass ' + m); if (x.dist.periods.some((p) => p.period < 1 || p.period > open.length + MAX_POSTSEASON_GAMES)) avBad.push(t.code + ' ' + x.player_id + ': period out of range'); }
  }
  if (av.mode === 'return_hazards' && !av.hazards) avBad.push('no hazard table');
  g('availability.trajectories', avBad.length === 0, av.mode === 'off' ? 'availability sampling OFF: the projected rotation for every game' : nTracked + ' tracked absences with return distributions from ' + (av.hazards ? av.hazards.source : '?') + (avBad.length ? '; bad: ' + avBad.slice(0, 5).join('; ') : ''));
  /* the postseason so far must be the one these standings produce */
  const post = d.postseason_rows.filter((x) => x.done);
  if (post.length) {
    let ok = false, why = '';
    if (open.length) why = 'postseason games are final while ' + open.length + ' regular-season games are not';
    else {
      try {
        const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
        const games: NbaGame[] = d.games.map((x) => ({ game_id: x.game_id, home: ix[x.home], away: ix[x.away], done: true, home_score: x.home_score, away_score: x.away_score }));
        const L = new League(d.teams, games), rules = rulesFor(d.season);
        const st = new Standings(L, new Int16Array(games.map((x) => (x.home_score as number) - (x.away_score as number))), { rng: streamFor(0n, 0, STREAM.coin), diag() {}, flag(k) { if (k === 'tiebreak_random_drawing') throw new Error('the standings need a random drawing: the bracket cannot be checked'); }, trace() {} }, rules);
        st.decideDivisions();
        const observed: PlayedGame[] = post.map((x) => ({ stage: x.stage, home: ix[x.home], away: ix[x.away], winner: (x.home_score as number) > (x.away_score as number) ? ix[x.home] : ix[x.away], game_id: x.game_id }));
        /* any unplayed game is decided by its host here: only the fit of the played games is checked */
        playPostseason(st, seedConferences(st), (q) => q.home, observed);
        ok = true; why = post.length + ' completed postseason games fit the bracket the final standings produce (pairings, hosts, home-court order, four wins)';
      } catch (e) { why = (e as Error).message; }
    }
    g('postseason.observed_fit', ok, why);
  } else g('postseason.observed_fit', true, 'no postseason game has been played');
  if (!opt.ignoreCodeDrift) {
    const now = codeHashes(), drift = Object.keys(d.code_sha256).filter((f) => now[f] !== d.code_sha256[f]);
    g('replay.code_identity', drift.length === 0, drift.length ? 'files changed since the snapshot was built (check out the snapshot\'s commit to replay): ' + drift.join(', ') : 'every model and rules file matches the snapshot');
  }
  return out;
}

/** sound SUFFICIENT conditions on the current standings only (no tiebreakers): Clinched / Eliminated */
export function nbaMathStatus(d: NbaInputData): Record<string, { division: 'clinched' | 'eliminated' | null; top6: 'clinched' | 'eliminated' | null; top10: 'clinched' | 'eliminated' | null }> {
  const w: Record<string, number> = {}, rem: Record<string, number> = {};
  for (const t of d.teams) { w[t.code] = 0; rem[t.code] = 0; }
  for (const g of d.games) {
    if (!g.done) { rem[g.home]++; rem[g.away]++; continue; }
    if ((g.home_score as number) > (g.away_score as number)) w[g.home]++; else w[g.away]++;
  }
  const max = (c: string) => w[c] + rem[c];
  const out: Record<string, { division: 'clinched' | 'eliminated' | null; top6: 'clinched' | 'eliminated' | null; top10: 'clinched' | 'eliminated' | null }> = {};
  for (const t of d.teams) {
    const div = d.teams.filter((x) => x.division === t.division && x.code !== t.code);
    const conf = d.teams.filter((x) => x.conference === t.conference && x.code !== t.code);
    /* a club is in the top N if at most N-1 rivals can even reach its current wins; out of it if N rivals already beat its best */
    const top = (N: number): 'clinched' | 'eliminated' | null => conf.filter((x) => max(x.code) >= w[t.code]).length <= N - 1 ? 'clinched' : conf.filter((x) => w[x.code] > max(t.code)).length >= N ? 'eliminated' : null;
    out[t.code] = { division: div.every((x) => max(x.code) < w[t.code]) ? 'clinched' : div.some((x) => w[x.code] > max(t.code)) ? 'eliminated' : null, top6: top(6), top10: top(10) };
  }
  return out;
}
