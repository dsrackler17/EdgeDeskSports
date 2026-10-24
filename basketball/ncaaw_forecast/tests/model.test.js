#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAW forecast: the properties the system promises, tested.

     node basketball/ncaaw_forecast/tests/model.test.js

   Offline (synthetic fixtures, labelled SYNTHETIC) unless a block says it
   reads the committed dataset. Nothing here calls a network or a database.
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./_kit').kit('ncaaw forecast model');
const D = require('../dist');
const Q = require('../quality');
const I = require('../ingest');
const UP = require('../upset');
const EV = require('../evaluate');
const FA = require('../factors');
const C = require('../config');

/* a tiny deterministic generator for synthetic fixtures (never production) */
function lcg(seed) { let s = seed >>> 0; return { nextOpen() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; } }; }
const CAL = { margin: { a: 1.2, b: 0.9 }, var_margin: { s0: 120, k: 0.3 }, kappa: 2.1, ot: { sd: 4.8 }, rho: 0.04, total: { c: 30, d: 0.78 }, var_total: { s0: 240, k: 0.3, t: 5 }, ot_total: { ratio: 0.95, sd: 6 } };

/* ------------------------------------------------------------------ the distribution */
T.near('Phi(0) = 0.5', D.Phi(0), 0.5, 1e-15);
T.near('Phi(1.959963984540054) = 0.975', D.Phi(1.959963984540054), 0.975, 1e-12);
/* Hart/West: absolute error <= 2e-16 on the whole line; relative error <= 1e-8
   in the deep lower tail (measured against an erfc reference: 9e-9 at z = -7.75) */
T.near('Phi(-6), absolute', D.Phi(-6), 9.865876450377012e-10, 2e-16);
T.near('Phi(-6), relative (deep tail)', D.Phi(-6) / 9.865876450377012e-10, 1, 1e-8);
T.near('Phi(-10), relative (deep tail)', D.Phi(-10) / 7.619853024160593e-24, 1, 1e-8);
T.near('Phi(-3) to double precision', D.Phi(-3), 0.0013498980316300957, 2e-16);
T.near('invPhi inverts Phi', D.Phi(D.invPhi(0.0123)), 0.0123, 1e-14);
{
  const row = { margin: 3.5, total: 141, var_param: 12, neutral: 0, tempo: 70 };
  const f = D.forecast(row, CAL, { pmf: true });
  const homeMass = f.pmf.filter(([k]) => k > 0).reduce((a, [, p]) => a + p, 0);
  T.near('P(win) equals the margin PMF mass above zero', f.p_home, homeMass, 1e-12);
  T.chk('the final margin is never 0', !f.pmf.some(([k]) => k === 0));
  T.near('the PMF sums to 1', f.pmf.reduce((a, [, p]) => a + p, 0), 1, 1e-12);
  T.chk('quantiles are ordered', f.margin.q05 <= f.margin.q10 && f.margin.q10 <= f.margin.q50 && f.margin.q50 <= f.margin.q90 && f.margin.q90 <= f.margin.q95);
  T.chk('total quantiles are ordered', f.total.q05 < f.total.q10 && f.total.q10 < f.total.q90 && f.total.q90 < f.total.q95);
  T.near('expected scores add to the total', f.pts_home + f.pts_away, f.total.mean, 1e-9);
  T.near('expected scores differ by the margin', f.pts_home - f.pts_away, f.margin.mean, 1e-9);
  T.chk('the endgame factor raises the overtime chance', f.p_ot > f.regulation.tie_mass_smooth);
  const sym = D.forecast(Object.assign({}, row, { margin: -3.5, neutral: 1 }), CAL), sym2 = D.forecast(Object.assign({}, row, { margin: 3.5, neutral: 1 }), CAL);
  T.near('a neutral game is symmetric (swap sides, swap probability)', sym.p_home, 1 - sym2.p_home, 1e-12);
  /* the simulator's draws follow the same distribution */
  const r = lcg(7); const N = 200000; let wins = 0, ot = 0; const reg = D.regulation(row, CAL);
  for (let i = 0; i < N; i++) { const g = D.drawGame(reg.mu, reg.sd, CAL, r); if (g.margin > 0) wins++; if (g.n_ot > 0) ot++; }
  const se = Math.sqrt(f.p_home * (1 - f.p_home) / N);
  T.near('simulated wins match P(win) within 4 Monte Carlo SE', wins / N, f.p_home, 4 * se);
  T.near('simulated overtime rate matches the tie mass within 4 SE', ot / N, f.p_ot, 4 * Math.sqrt(f.p_ot * (1 - f.p_ot) / N));
  const r2 = lcg(11); let w2 = 0; for (let i = 0; i < N; i++) w2 += D.drawWinner(reg.mu, reg.sd, CAL, r2);
  T.near('drawWinner matches P(win) within 4 SE', w2 / N, f.p_home, 4 * se);
}
{ /* fit recovers a synthetic truth (SYNTHETIC rows) */
  const r = lcg(3); const rows = [];
  for (let i = 0; i < 20000; i++) {
    const m = (r.nextOpen() - 0.5) * 30; const neutral = r.nextOpen() < 0.2 ? 1 : 0; const mu = (neutral ? 0 : 1.5) + 0.9 * m;
    const reg = D.drawRegulation(mu, 11, { kappa: 2, ot: { sd: 4.5 } }, r.nextOpen());
    let fin = reg, nOt = 0; if (reg === 0) { nOt = 1; fin = Math.round(mu / 8 + 4.5 * D.invPhi(r.nextOpen())) || 1; }
    rows.push({ margin: m, total: 140 + (r.nextOpen() - 0.5) * 20, var_param: 10, neutral, tempo: 68, y: { margin: fin, total: 140, n_ot: nOt } });
  }
  const cal = D.fit(rows, { variance: 'v1', location_fit: 'tie_consistent' });
  T.near('fit: home intercept', cal.margin.a, 1.5, 0.3);
  T.near('fit: slope (SE about 0.009)', cal.margin.b, 0.9, 0.03);
  T.near('fit: regulation sd', Math.sqrt(cal.var_margin.s0 + cal.var_margin.k * 10), 11, 0.4);
  T.near('fit: endgame factor', cal.kappa, 2, 0.35);
  /* the plain fit (the first champion's) reads the tie-compressed margin back as the location: documented, not hidden */
  const plain = D.fit(rows, { variance: 'v1' });
  T.chk('the plain fit is attenuated by the tie compression (why tie_consistent exists)', plain.margin.b < cal.margin.b - 0.01 && plain.margin.fit === 'plain' && cal.margin.fit === 'tie_consistent', { plain: plain.margin.b, tie_consistent: cal.margin.b });
  T.chk('fit: the intercept is home-only', cal.margin.intercept === 'home_games_only');
  T.chk('fit: too few rows gives no calibration', D.fit(rows.slice(0, 50)) === null);
}

/* ------------------------------------------------------------------ data quality (SYNTHETIC rows) */
{
  const sched = (o) => Object.assign({ game_id: 1, season: 2026, season_type: 2, date: '2025-11-10T00:00Z', status_type_name: 'STATUS_FINAL', status_type_completed: true, status_period: 4, format_regulation_periods: 4, neutral_site: false,
    conference_competition: false, home_id: 10, away_id: 20, home_score: 70, away_score: 60, home_conference_id: 5, away_conference_id: 6, home_display_name: 'H', away_display_name: 'A' }, o);
  const box = (gid, t, o, pts, extra) => Object.assign({ game_id: gid, team_id: t, opponent_team_id: o, team_score: pts, field_goals_made: 25, field_goals_attempted: 58, three_point_field_goals_made: 6, three_point_field_goals_attempted: 20,
    free_throws_made: pts - 56, free_throws_attempted: pts - 50, offensive_rebounds: 9, defensive_rebounds: 25, total_turnovers: 12, fouls: 17 }, extra || {});
  const rows = [sched({}), sched({ game_id: 2, status_type_name: 'STATUS_POSTPONED', status_type_completed: false, home_score: null, away_score: null }),
    sched({ game_id: 3, status_period: 5, home_score: 80, away_score: 78, date: '2025-11-12T00:00Z' }), sched({ game_id: 4, date: '2025-11-10T01:00Z' }),
    sched({ game_id: 5, home_id: 30, away_id: 40, home_conference_id: null, away_conference_id: 6, date: '2025-11-14T00:00Z', home_score: 66, away_score: 90 }),
    sched({ game_id: 6, home_score: null, date: '2025-11-15T00:00Z' })];
  const bx = [box(1, 10, 20, 70), box(1, 20, 10, 60), box(3, 10, 20, 80), box(3, 20, 10, 78), box(5, 30, 40, 66), box(5, 40, 30, 90, { field_goals_made: 30 })];
  const n = I.normalise(2026, rows, bx);
  T.eq('no row is dropped: every schedule row is kept', n.games.length, 6);
  T.eq('a postponed game is kept with its status and never scored', [n.games.find((g) => g.game_id === '2').status, n.games.find((g) => g.game_id === '2').score_ok], ['POSTPONED', 0]);
  T.eq('overtime periods are counted after four quarters (period 5 is the first overtime)', n.games.find((g) => g.game_id === '3').n_ot, 1);
  T.eq('regulation is recorded per game', n.games.find((g) => g.game_id === '1').regulation_periods, 4);
  T.chk('a same-day repeat of the same pairing is quarantined as a duplicate suspect', /DUPLICATE_SUSPECT_OF_1/.test(n.games.find((g) => g.game_id === '4').quarantine));
  T.chk('a final without a score is quarantined', /MISSING_SCORE/.test(n.games.find((g) => g.game_id === '6').quarantine));
  T.chk('a box score whose shots do not add to the points is quarantined from the possession model', /BOX_POINTS_NE_SHOTS/.test(n.games.find((g) => g.game_id === '5').quarantine) && n.games.find((g) => g.game_id === '5').score_ok === 1);
  T.eq('membership: a team without a conference is not D1', [n.games.find((g) => g.game_id === '5').home_d1, n.games.find((g) => g.game_id === '5').away_d1], [0, 1]);
  T.chk('every quarantined game is listed with its reasons', n.quarantine.length === n.games.filter((g) => g.quarantine).length && n.quarantine.every((q) => q.reasons.length));
  T.chk('box_ok implies score_ok', n.games.every((g) => !g.box_ok || g.score_ok));
  /* the halves era (through 2015): period 3 is the first overtime */
  const h = I.normalise(2015, [sched({ game_id: 7, season: 2015, status_period: 3, format_regulation_periods: 2, home_score: 80, away_score: 78 }), sched({ game_id: 8, season: 2015, status_period: 2, format_regulation_periods: null, date: '2014-11-12T00:00Z' })], []);
  T.eq('in the halves era period 3 is the first overtime; the season rule fills a missing format', [h.games.find((g) => g.game_id === '7').n_ot, h.games.find((g) => g.game_id === '8').regulation_periods, h.games.find((g) => g.game_id === '8').n_ot], [1, 2, 0]);
  const q = I.normalise(2016, [sched({ game_id: 9, season: 2016, status_period: 2, format_regulation_periods: 4 })], []);
  T.chk('a quarters-era final with only two periods is quarantined', /PERIODS_INVALID/.test(q.games[0].quarantine) && q.games[0].score_ok === 0);
  T.eq('the season rule: halves through 2015, quarters from 2016', [C.RULES.regulationPeriods(2015), C.RULES.regulationPeriods(2016), C.RULES.regulationPeriods(2027)], [2, 4, 4]);
  T.eq('the possession constant is the two-shot-bonus 0.44 (no one-and-one)', Q.POSS_FTA, 0.44);
  T.eq('the women\'s postseason: NCAA, Women\'s NIT, WBIT', [Q.classifyEvent({ tournament_id: 22, season_type: 3, notes_headline: "NCAA Women's Championship - Regional 1 in Spokane - 1st Round" }),
    Q.classifyEvent({ tournament_id: 37, season_type: 3, notes_headline: "Women's NIT - 1st Round" }), Q.classifyEvent({ tournament_id: 62, season_type: 3, notes_headline: 'WBIT - 1st Round' })], ['ncaa_tournament', 'nit', 'other_postseason']);
  T.eq('NCAA regions: a city region (to 2022) and a numbered regional at a site (2023-)', [Q.ncaaRegion("NCAA WOMEN'S CHAMPIONSHIP - ALBANY REGION - 1ST ROUND"), Q.ncaaRegion("NCAA Women's Championship - Regional 3 in Birmingham - Sweet 16"), Q.ncaaRegion("NCAA Women's Championship - Final Four")], ['Albany', 'Birmingham 3', null]);
}
{ /* the NCAA bracket from structure, and the seed rule */
  const mk = (id, t, h, a, hs, as, hr, ar) => ({ game_id: String(id), season: 2026, event: 'ncaa_tournament', status: 'FINAL', start_utc: t, home_id: h, away_id: a, hs, as, home_rank: hr, away_rank: ar });
  const g = [mk(1, '2026-03-17T00:00Z', 'a', 'b', 70, 60, 16, 16), mk(2, '2026-03-19T00:00Z', 'c', 'a', 80, 50, 1, 16), mk(3, '2026-03-19T01:00Z', 'd', 'e', 70, 71, 8, 9), mk(4, '2026-03-21T00:00Z', 'c', 'e', 75, 70, 1, 9)];
  const nr = Q.ncaaRounds(g);
  T.eq('structural rounds are depths from the last game: the final, its feeders, theirs', [nr.rounds.get('4'), nr.rounds.get('2'), nr.rounds.get('3'), nr.rounds.get('1')], ['NC', 'F4', 'F4', 'E8']);
  T.eq('no structural issue', nr.issues, []);
  /* a full 68-team field (SYNTHETIC): four First Four games feed four first-round slots; the home side always wins */
  const full = []; let gid = 100; const day = ['2026-03-17', '2026-03-19', '2026-03-21', '2026-03-26', '2026-03-28', '2026-04-04', '2026-04-06'];
  const play = (pairs, d) => pairs.map(([h, a], i) => { full.push(mk(++gid, day[d] + 'T' + String(10 + Math.floor(i / 6)).padStart(2, '0') + ':' + String((i % 6) * 10).padStart(2, '0') + 'Z', h, a, 70, 60, null, null)); return h; });
  const ffW = play([['f1', 'f2'], ['f3', 'f4'], ['f5', 'f6'], ['f7', 'f8']], 0);
  let field = Array.from({ length: 60 }, (_, i) => 't' + i).concat(ffW);
  for (let d = 1; field.length > 1; d++) { const pairs = []; for (let i = 0; i < field.length; i += 2) pairs.push([field[i], field[i + 1]]); field = play(pairs, d); }
  const fr = Q.ncaaRounds(full); const count = {}; for (const r of fr.rounds.values()) count[r] = (count[r] || 0) + 1;
  T.eq('a full field: 4 First Four, 32, 16, 8, 4, 2, 1 games by round, no issue', [count.FF, count.R64, count.R32, count.S16, count.E8, count.F4, count.NC, fr.issues.length, fr.games], [4, 32, 16, 8, 4, 2, 1, 0, 67]);
  const bad = [mk(1, '2026-03-19T00:00Z', 'a', 'b', 70, 60, 1, 15)]; const r2 = Q.ncaaRounds(bad);
  T.chk('a rank pair that does not sum to 17 is not accepted as seeds', !Q.ncaaSeeds(bad, new Map([['1', 'R64']])).ok && r2.games === 1);
  T.chk('a missing rank field records no seeds and says why', /no tournament-game rank/.test(Q.ncaaSeeds([mk(1, 't', 'a', 'b', 1, 0, null, null)], new Map([['1', 'R64']])).reason));
}

/* ------------------------------------------------------------------ point in time: no look-ahead (committed dataset) */
{
  const DS = require('../dataset'); const MD = require('../model');
  const sel = JSON.parse(fs.readFileSync(path.join(C.PATHS.configDir, 'selection_v1.json'), 'utf8'));
  const cfg = { engine: 'research_team_model', params: sel.chosen, calibration: sel.calibration };
  const games = DS.load([2025, 2026]);
  const eg = DS.engineGames(games);
  const target = eg.find((g) => g.season === 2026 && g.start_ms > Date.parse('2026-01-15') && g.regime === 'D1_D1');
  const R1 = MD.researchRows(eg, cfg);
  const later = eg.map((g) => (g.start_ms > target.start_ms + 5 * 864e5 && g.season === 2026 ? Object.assign({}, g, { hs: g.as, as: g.hs, yH: g.yA, yA: g.yH }) : g));
  const R2 = MD.researchRows(later, cfg);
  const a = R1.rows.find((r) => r.game_id === target.game_id), b = R2.rows.find((r) => r.game_id === target.game_id);
  T.chk('changing results AFTER a game never changes its forecast', a && b && a.margin === b.margin && a.var_param === b.var_param, { a: a && a.margin, b: b && b.margin });
  const changedOwn = eg.map((g) => (g.game_id === target.game_id ? Object.assign({}, g, { hs: g.hs + 30, yH: g.yH + 40 }) : g));
  const R3 = MD.researchRows(changedOwn, cfg);
  T.chk('a game\'s own result never changes its own forecast', R3.rows.find((r) => r.game_id === target.game_id).margin === a.margin);
  MD.calibrateCausal(R1.rows, cfg.calibration); MD.calibrateCausal(R2.rows, cfg.calibration);
  const ca = R1.rows.find((r) => r.game_id === target.game_id), cb = R2.rows.find((r) => r.game_id === target.game_id);
  T.chk('the calibration of a game never reads a later game', ca.s && cb.s && ca.s.p_home === cb.s.p_home);
  const leak = EV.leakage(R1.rows.filter((r) => r.season === 2026));
  T.chk('every walk-forward row was predicted from inputs known before it', leak.checked > 1000 && leak.violations === 0, leak);
  const at = target.start_ms - C.PREDICT_BEFORE_MS;
  const fin = games.filter((g) => g.season === 2025);
  const cache = MD.researchRows(DS.engineGames(fin), cfg);
  const art1 = MD.buildArtifact(games, cfg, at, { season: 2026, cache });
  const games2 = games.map((g) => (g.season === 2026 && g.start_ms > at ? Object.assign({}, g, { hs: g.as, as: g.hs }) : g));
  const art2 = MD.buildArtifact(games2, cfg, at, { season: 2026, cache });
  T.eq('an artifact as of T is identical whatever happens after T', art1.artifact_sha256, art2.artifact_sha256);
  const art3 = MD.buildArtifact(games, cfg, at, { season: 2026, cache });
  T.eq('the same inputs rebuild the same artifact', art3.artifact_sha256, art1.artifact_sha256);
  const pr = MD.predict(art1, games.find((g) => g.game_id === String(target.game_id)));
  T.near('the artifact path reproduces the walk-forward mean', pr.raw.margin, a.margin, 1e-9);
  T.near('...and its parameter variance', pr.raw.var_param, a.var_param, 1e-9);
  const s1 = DS.snapshot(games, at), s2 = DS.snapshot(games2, at), s3 = DS.snapshot(games, at + 864e5 * 30);
  T.eq('the training snapshot ignores rows after its cut-off', s1.sha256, s2.sha256);
  T.chk('a later cut-off is a different snapshot', s3.sha256 !== s1.sha256);
  const man = DS.manifest(); const bad = JSON.parse(JSON.stringify(man)); bad.seasons[2025].sha256 = '0'.repeat(64);
  T.throws('a data file that does not match the manifest is refused', () => DS.loadSeason(2025, bad), /HASH MISMATCH/);
}

/* ------------------------------------------------------------------ the NCAA tournament in the committed data */
{
  const man = require('../dataset').manifest();
  const S = (y) => man.seasons[y].stats;
  T.chk('every tournament season rebuilds its bracket with no structural issue (63 games to 2021, 67 with the First Four from 2022)',
    [2017, 2018, 2019, 2021].every((y) => S(y).ncaa.games === 63 && !S(y).ncaa.structural_issues.length) && [2022, 2023, 2024, 2025, 2026].every((y) => S(y).ncaa.games === 67 && !S(y).ncaa.structural_issues.length) && S(2020).ncaa.games === 0);
  T.chk('seeds are verified where the source carries them (2024-2026) and nowhere else', [2024, 2025, 2026].every((y) => S(y).ncaa.seeds_verified) && [2017, 2018, 2019, 2021, 2022, 2023].every((y) => !S(y).ncaa.seeds_verified));
  T.chk('the first two rounds on the top 16 seeds\' campuses are not neutral (32 host games a year from 2022)', [2022, 2023, 2024, 2025, 2026].every((y) => S(y).ncaa.host_games === 32));
  T.chk('Division I membership is plausible every season (330-375 teams)', Object.keys(man.seasons).every((y) => S(y).d1_teams >= 330 && S(y).d1_teams <= 375));
  T.chk('box scores are sparse before 2017 and near complete after: the possession model starts at 2017', [2012, 2015, 2016].every((y) => S(y).box_ok / S(y).final < 0.4) && [2017, 2019, 2023, 2026].every((y) => S(y).box_ok / S(y).final > 0.9) && C.MODEL_FIRST_SEASON === 2017);
  T.chk('no season before 2017 reaches the possession engine', require('../dataset').engineGames(require('../dataset').load([2016, 2017])).every((g) => g.season >= 2017));
}

/* ------------------------------------------------------------------ Upset Watch */
{
  const policy = { signals: { upset_probability: { theta: 0.3 }, market_disagreement: { delta: 0.06 }, high_uncertainty: { sd_threshold: 13, min_games: 5 } } };
  const fc = (p, sd) => ({ p_home: p, regulation: { sd: sd || 11 } });
  T.eq('model basis: the model underdog', UP.classify({ event: 'regular' }, fc(0.68), policy).basis, 'model');
  T.eq('a 35% underdog is an upset threat', UP.classify({ event: 'regular' }, fc(0.65), policy).signals, ['upset_probability']);
  T.eq('a 47% underdog is a toss-up, not an upset call', UP.classify({ event: 'regular' }, fc(0.53), policy).signals, ['toss_up']);
  T.eq('a 20% underdog raises nothing', UP.classify({ event: 'regular' }, fc(0.8), policy).signals, []);
  const seedG = { event: 'ncaa_tournament', home_seed: 12, away_seed: 5 };
  const sc = UP.classify(seedG, fc(0.55), policy, { seeds_verified: true });
  T.eq('seed basis: the worse seed is the underdog; the model favouring it is a disagreement', [sc.basis, sc.underdog, sc.signals], ['seed', 'home', ['model_favours_underdog']]);
  T.eq('unverified seeds fall back to the model', UP.classify(seedG, fc(0.55), policy, { seeds_verified: false }).basis, 'model');
  const mk = UP.classify({ event: 'regular' }, fc(0.6), policy, { quote: { valid: true, synchronized: true, p_home_fair: 0.7 } });
  T.eq('market basis with a disagreement of 10 points', [mk.basis, mk.signals.includes('market_disagreement')], ['market', true]);
  T.chk('an unsynchronized quote is never the basis', UP.classify({ event: 'regular' }, fc(0.6), policy, { quote: { valid: true, synchronized: false, p_home_fair: 0.7 } }).basis === 'model');
  T.chk('high uncertainty is its own signal', UP.classify({ event: 'regular' }, fc(0.8, 14), policy).signals.includes('high_uncertainty') && UP.classify({ event: 'regular' }, fc(0.8), policy, { games_home: 2 }).signals.includes('high_uncertainty'));
  const rows = []; const r = lcg(5); for (let i = 0; i < 5000; i++) { const p = 0.5 + 0.49 * r.nextOpen(); rows.push({ s: { p_home: p, reg_sd: 10 + 3 * r.nextOpen() }, y: { hw: r.nextOpen() < p ? 1 : 0 } }); }
  const s = UP.select(rows); T.chk('theta is a fixed quantile rule, deterministic', s.theta === UP.select(rows).theta && s.theta > 0 && s.theta < UP.TOSS_UP);
  const ev = UP.evaluate(rows, { signals: { upset_probability: { theta: s.theta } } });
  T.near('on calibrated SYNTHETIC rows the flagged upset rate matches its forecast', ev.realized_upset_rate, ev.mean_forecast, 0.04);
  T.chk('no factor test runs on too small a sample', FA.test([{ p_dog: 0.3, dog_won: 0, h: { pace: 66 } }]).pace.verdict === 'INSUFFICIENT_SAMPLE');
}

/* ------------------------------------------------------------------ live: not built for the women's game */
{
  const dir = path.join(__dirname, '..');
  T.chk('no live model or live writer ships for the women\'s game', !fs.existsSync(path.join(dir, 'live.js')) && !fs.existsSync(path.join(dir, 'live_writer.js')) && !fs.existsSync(path.join(dir, 'config', 'live.json')));
}

/* ------------------------------------------------------------------ the promotion gates (SYNTHETIC rows) */
{
  const policy = JSON.parse(fs.readFileSync(C.PATHS.promotion, 'utf8'));
  const r = lcg(9); const champ = [], good = [], bad = [];
  for (let i = 0; i < 24000; i++) {
    const season = 2020 + (i % 6); const truth = 0.15 + 0.7 * r.nextOpen(); const y = r.nextOpen() < truth ? 1 : 0; const regime = i % 10 === 0 ? 'D1_OTHER' : 'D1_D1';
    const base = { game_id: i, season, regime, neutral: i % 7 === 0, event: i % 13 === 0 ? 'conference_tournament' : 'regular', n_h: 10, n_a: 10, start_ms: Date.parse('2020-11-10') + season * 1e7 + i * 6e5, y: { hw: y, margin: y ? 5 : -5, total: 140, n_ot: 0 } };
    const sc = (p) => ({ p_home: p, m_crps: Math.abs(p - y) * 10, m_mean: (p - 0.5) * 20, t_mean: 140, t_crps: 9, m_pit: r.nextOpen(), t_pit: r.nextOpen(), p_ot: 0.06 });
    champ.push(Object.assign({}, base, { s: sc(0.5 + (truth - 0.5) * 0.7) }));
    good.push(Object.assign({}, base, { s: sc(truth) }));
    bad.push(Object.assign({}, base, { s: sc(0.5) }));
  }
  const ctx = { window: { from: 2020, to: 2027 }, recent_season: 2025, integrity: { dataset_hashes_ok: true, leakage_violations: 0, snapshot_sha256: 'x'.repeat(64), artifact_reproducible: true }, operations: { runtime_min: 3 } };
  const g1 = EV.gate(champ, good, policy, ctx);
  T.chk('a clearly better challenger passes the log-loss gate', g1.gates.find((x) => x.id === 'G2_log_loss').pass);
  T.eq('a worse challenger is RETAINED', EV.gate(champ, bad, policy, ctx).decision, 'RETAIN');
  T.eq('too few games is INSUFFICIENT_EVIDENCE whatever the point estimate', EV.gate(champ.slice(0, 3000), good.slice(0, 3000), policy, ctx).decision, 'INSUFFICIENT_EVIDENCE');
  T.eq('a leakage violation blocks promotion', EV.gate(champ, good, policy, Object.assign({}, ctx, { integrity: Object.assign({}, ctx.integrity, { leakage_violations: 1 }) })).gates.find((x) => x.id === 'G7_integrity').pass, false);
  T.eq('a slow run blocks promotion', EV.gate(champ, good, policy, Object.assign({}, ctx, { operations: { runtime_min: 99 } })).gates.find((x) => x.id === 'G8_operations').pass, false);
  T.chk('holdout tournament games never enter the window', !EV.inWindow({ regime: 'D1_D1', s: { p_home: 0.5 }, season: 2025, ncaa_round: 'R64' }, ctx.window));
}

/* ------------------------------------------------------------------ the champion registry: atomic, gated, reversible */
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaawreg-'));
  process.env.NCAAW_REGISTRY_DIR = TMP;
  delete require.cache[require.resolve('../registry')];
  const RG = require('../registry');
  const p0 = RG.init();
  T.eq('the incumbent starts as champion', p0.current.model_id, 'ncaaw_points');
  const m = { model_id: 'ncaaw_adjeff', version: '1.0.0', engine: 'research_team_model', config: { a: 1 }, config_sha256: 'a'.repeat(64) };
  T.throws('a RETAIN decision cannot promote', () => RG.promote(m, { decision: 'RETAIN', report_sha256: 'b'.repeat(64) }), /refused/);
  T.throws('a PROMOTE without an immutable report cannot promote', () => RG.promote(m, { decision: 'PROMOTE' }), /no immutable report/);
  T.eq('the champion is unchanged after refusals', RG.readPointer().current.key, p0.current.key);
  const p1 = RG.promote(m, { decision: 'PROMOTE', file: 'x.json', report_sha256: 'b'.repeat(64) });
  T.eq('a PROMOTE moves the pointer', p1.current.key, 'ncaaw_adjeff@1.0.0');
  T.throws('a model version cannot be re-recorded with another configuration', () => RG.recordModel(Object.assign({}, m, { config_sha256: 'c'.repeat(64) })), /already exists/);
  T.throws('a rollback needs a reason', () => RG.rollback({}), /reason/);
  const p2 = RG.rollback({ reason: 'test' });
  T.eq('rollback restores the previous champion', p2.current.key, p0.current.key);
  T.eq('...keeping the rolled-back model as a rollback target', p2.previous[0].key, 'ncaaw_adjeff@1.0.0');
  const hist = fs.readFileSync(path.join(TMP, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).decision);
  T.eq('every decision is in the append-only history', hist, ['INIT', 'PROMOTE', 'ROLLBACK']);
  T.chk('no temporary file is left behind (atomic rename)', !fs.readdirSync(TMP).some((f) => /\.tmp-/.test(f)));
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.NCAAW_REGISTRY_DIR;
}

/* ------------------------------------------------------------------ the refresh window (SYNTHETIC schedule)
   PRESEASON before the first regular-season game: through the end of the opening week; the routine hours from the
   opener on, by the clock alone */
{
  const R = require('../refresh');
  const H = 3600e3, opener = Date.parse('2026-11-02T05:00:00Z');
  const sched = [{ season: 2027, season_type: 2, start_ms: opener + 18 * H }, { season: 2027, season_type: 2, start_ms: opener }, { season: 2027, season_type: 3, start_ms: opener - 30 * 24 * H }, { season: 2026, season_type: 2, start_ms: opener - 365 * 24 * H }];
  T.eq('the opener is the season\'s first regular-season game (another season and other season types ignored)', R.regularSeasonStart(sched, 2027), opener);
  T.eq('a season whose schedule lists no game has no opener', R.regularSeasonStart(sched, 2028), Infinity);
  const pre = R.forecastWindow(sched, 2027, Date.parse('2026-10-24T13:37:00Z'), 48);
  T.chk('preseason: the window runs to the end of the opening week', pre.phase === 'preseason' && pre.to === opener + 7 * 24 * H && pre.regular_season_start === '2026-11-02T05:00:00.000Z');
  const eve = R.forecastWindow(sched, 2027, opener - H, 48);
  T.chk('the hour before the opener is still preseason', eve.phase === 'preseason' && eve.to === opener + 7 * 24 * H);
  const day1 = R.forecastWindow(sched, 2027, opener, 48);
  T.chk('from the opener: the season and the routine window, with no change by anyone', day1.phase === 'season' && day1.to === opener + 48 * H);
  T.chk('preseason never shortens a longer requested window', R.forecastWindow(sched, 2027, opener - 2 * H, 400).to === opener - 2 * H + 400 * H);
  T.chk('no opener in the schedule: the routine window', R.forecastWindow(sched, 2028, opener, 48).phase === 'season');
}

/* ------------------------------------------------------------------ scope */
{
  const dir = path.join(__dirname, '..');
  const src = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  T.chk('women\'s data only: no men\'s source is read (the shared research engine aside)', !/mbb_|hoopR|\/mbb\/|basketball\/data\/ncaam|ncaam_forecast|'ncaam'/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  T.chk('...and every men\'s file reached is the league-neutral research engine', (src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').match(/ncaam[a-z_]*/g) || []).every((x) => x === 'ncaam_research'));
  T.chk('no odds source is called by the forecast system', !/the-odds-api|odds_gateway|ODDS_API_KEY/.test(src));
  T.chk('Math.random is never used', !/Math\.random/.test(src));
}

process.exit(T.done());
