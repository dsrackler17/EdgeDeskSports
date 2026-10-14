#!/usr/bin/env node
/* ===========================================================================
   The NBA engine, offline: every unit that turns data into a price, on
   fixtures and on the committed artifacts. No network, no model call.

     node tools/nba/nba.test.js

   1  ingest: the play-by-play parser (simultaneous substitutions, period
      starts, stint seconds, points, possessions, shots), the DNP reason
      categories, the three linescore layouts, the possessions estimator
   2  the committed data: games and team games agree, the manifest's integrity
      record, the bubble is neutral, known_at is blank, the PBP spread label
   3  learners: ridge, logistic, boosted trees, Platt, the inverse normal
   4  ratings: Elo is zero-sum, Kalman variance shrinks with data, the adjusted
      ratings recover a synthetic league, RAPM recovers synthetic players and
      a player first seen after a fit gets the prior (the bug this caught)
   5  the distribution: mass 1, moneyline + its complement = 1, the favourite
      agrees across markets, pushes at whole lines, ladders monotone, team
      totals add to the total, the oriented shape is symmetric at pick'em
   6  props: negative-binomial pmf, combined variance, the copula's bounds
   7  the market block: break-even, EV with pushes, the no-vig kept apart;
      quotes matched by team and start; DISABLED without authorisation
   8  the ledger: a sheet after tip is never graded; grades on a fixture
   9  the loader's mapping; the desk module's slate contract
  10  the committed record, props record and slate pass their checks
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } } if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-6 : tol);

/* ---------------------------------------------------------------- 1. ingest */
const PBP = R('nba/ingest/pbp.js');
const SEA = R('nba/ingest/season.js');
{
  /* a two-period fixture: home 1, away 2; starters h1..h5 / a1..a5 */
  const H = '1', A = '2';
  const roster = new Map(); for (let i = 1; i <= 8; i++) { roster.set(String(100 + i), H); roster.set(String(200 + i), A); }
  const starters = { [H]: ['101', '102', '103', '104', '105'], [A]: ['201', '202', '203', '204', '205'] };
  let seq = 0;
  const ev = (per, clk, type, o) => Object.assign({ game_id: 'g', sequence_number: String(++seq), type_text: type, text: '', period_number: per, clock_minutes: Math.floor(clk / 60), clock_seconds: clk % 60, home_score: null, away_score: null, scoring_play: false, score_value: 0, shooting_play: false, team_id: null, athlete_id_1: null, athlete_id_2: null, athlete_id_3: null, coordinate_x: null, coordinate_y: null }, o || {});
  const rows = [
    ev(1, 700, 'Jump Shot', { text: 'Player makes 24-foot three point jumper', team_id: 1, athlete_id_1: '101', shooting_play: true, scoring_play: true, score_value: 3, home_score: 3, away_score: 0, coordinate_x: -18.75, coordinate_y: -16 }),
    ev(1, 650, 'Driving Layup Shot', { text: 'Player misses 2-foot driving layup', team_id: 2, athlete_id_1: '201', shooting_play: true, home_score: 3, away_score: 0, coordinate_x: 40, coordinate_y: 1 }),
    ev(1, 648, 'Defensive Rebound', { team_id: 1, athlete_id_1: '102', home_score: 3, away_score: 0 }),
    /* two substitutions in one dead ball (the case that once lost the second) */
    ev(1, 600, 'Substitution', { team_id: 1, athlete_id_1: '106', athlete_id_2: '101' }),
    ev(1, 600, 'Substitution', { team_id: 1, athlete_id_1: '107', athlete_id_2: '102' }),
    ev(1, 590, 'Bad Pass\nTurnover', { team_id: 1, athlete_id_1: '106', home_score: 3, away_score: 0 }),
    ev(1, 500, 'Free Throw - 1 of 2', { team_id: 2, athlete_id_1: '202', shooting_play: true, scoring_play: true, score_value: 1, home_score: 3, away_score: 1 }),
    ev(1, 500, 'Free Throw - 2 of 2', { team_id: 2, athlete_id_1: '202', shooting_play: true, scoring_play: true, score_value: 1, home_score: 3, away_score: 2 }),
    ev(1, 0, 'End Period', { home_score: 3, away_score: 2 }),
    /* period 2 starts with h1 back (he is subbed out first) and h6 on the bench (he enters first) */
    ev(2, 700, 'Substitution', { team_id: 1, athlete_id_1: '108', athlete_id_2: '101' }),
    ev(2, 650, 'Substitution', { team_id: 1, athlete_id_1: '106', athlete_id_2: '103' }),
    ev(2, 600, 'Jump Shot', { text: 'Player makes 18-foot jumper', team_id: 2, athlete_id_1: '203', shooting_play: true, scoring_play: true, score_value: 2, home_score: 3, away_score: 4 }),
    ev(2, 0, 'End Period', { home_score: 3, away_score: 4 }),
  ];
  const r = PBP.processGame(rows, { home: H, away: A, roster, starters, minutes: new Map() });
  ok('the parser keeps both simultaneous substitutions', r.stints.some((s) => s.h5.includes('106') && s.h5.includes('107') && !s.h5.includes('101') && !s.h5.includes('102')));
  ok('stint seconds sum to the periods played', near(r.stints.reduce((a, s) => a + (s.t1 - s.t0), 0), 1440), r.issues);
  ok('stint points sum to the final', r.stints.reduce((a, s) => a + s.hp, 0) === 3 && r.stints.reduce((a, s) => a + s.ap, 0) === 4);
  ok('period scores from the running score', JSON.stringify(r.periods) === JSON.stringify([{ p: 1, h: 3, a: 2 }, { p: 2, h: 0, a: 2 }]), r.periods);
  const p2 = r.stints.find((s) => s.t0 === 720);
  ok('period 2 starts with the player first subbed out, not the one first subbed in', p2 && p2.h5.includes('101') && !p2.h5.includes('106'), p2 && p2.h5);
  ok('every reconstructed five is five', r.stints.every((s) => s.ok === 1));
  ok('a three is a three, at 24 feet, above the break', r.shots[0].v === 3 && r.shots[0].d === 24 && PBP.zoneOf(24, true, -18.75, -16) === 'ab3');
  ok('a corner three is a corner three', PBP.zoneOf(22, true, -40, 22) === 'c3');
  ok('a layup is at the rim and a miss', r.shots[1].mk === 0 && r.shots[1].d === 2 && PBP.zoneOf(2, false) === 'rim');
  ok('free throws and the turnover are counted', r.team['2'].fta === 2 && r.team['2'].ftm === 2 && r.team['1'].tov === 1);
  ok('shot families come from the pre-shot description', PBP.shotFamily('Driving Floating Jump Shot') === 'floater' && PBP.shotFamily('Alley Oop Dunk Shot') === 'alley_oop' && PBP.shotFamily('Step Back Jump Shot') === 'stepback');
}
ok('a DNP reason is categorised (only read when the player did not play)', SEA.reasonCat("COACH'S DECISION") === 'COACH' && SEA.reasonCat('RIGHT ANKLE SPRAIN') === 'INJURY' && SEA.reasonCat('REST') === 'REST' && SEA.reasonCat('SUSPENDED BY LEAGUE') === 'SUSPENSION' && SEA.reasonCat('ILLNESS') === 'ILLNESS' && SEA.reasonCat('') === 'UNKNOWN');
ok('all three linescore layouts parse', JSON.stringify(SEA.linescore("[{'value': 22.0} {'value': 17.0}]")) === JSON.stringify([{ p: 1, v: 22 }, { p: 2, v: 17 }])
  && JSON.stringify(SEA.linescore("[{'displayValue': '23', 'period': 1, 'value': 23.0}  {'displayValue': '19', 'period': 2, 'value': 19.0}]")) === JSON.stringify([{ p: 1, v: 23 }, { p: 2, v: 19 }])
  && JSON.stringify(SEA.linescore("[{'value': 25.0, 'displayValue': '25', 'period': 1.0}]")) === JSON.stringify([{ p: 1, v: 25 }]));
ok('the possessions estimator is symmetric and in range', (() => { const t = { fga: 88, fta: 22, oreb: 10, dreb: 34, fgm: 41, tov: 13 }, o = { fga: 85, fta: 20, oreb: 9, dreb: 35, fgm: 40, tov: 14 }; const p = SEA.possEst(t, o); return near(p, SEA.possEst(o, t)) && p > 90 && p < 105; })());

/* ---------------------------------------------------------------- 2. the committed data */
const D = R('nba/lib/data.js');
const C = R('nba/config.js');
{
  const g = D.games([2025]); const tg = D.teamGames([2025]);
  ok('the committed 2024-25 season is whole', g.filter((x) => x.status === 'FINAL').length >= 1300 && tg.length === 2 * g.length);
  const byId = new Map(g.map((x) => [x.game_id, x]));
  ok('team-game points equal the game\'s final on every row', tg.filter((t) => t.pts != null).every((t) => { const x = byId.get(t.game_id); return t.pts === (t.home ? x.hs : x.as); }));
  ok('every historical row says RETRO with a blank known_at', g.every((x) => x.pit === 'RETRO' && !x.known_at));
  ok('assumed availability is the start plus four hours', g.filter((x) => x.status === 'FINAL').every((x) => x.avail_ms - x.start_ms === 4 * 3600e3));
  const bub = D.games([2020]).filter((x) => x.bubble);
  ok('the 2020 Orlando restart is neutral', bub.length > 80 && bub.every((x) => x.neutral === 1));
  const man = JSON.parse(fs.readFileSync(C.PATHS.manifest, 'utf8'));
  const s25 = man.seasons['2025'];
  ok('the manifest carries provenance and integrity', s25.sources.pbp && /^[0-9a-f]{64}$/.test(s25.sources.pbp.sha256) && s25.integrity.minutes_mae < 0.35 && s25.integrity.valid_lineup_share > 0.99, s25.integrity);
  ok('the ESPN spread is labelled untimestamped in the licence', /untimestamped/i.test(C.LICENSE.odds) && /never a market test/i.test(C.LICENSE.odds));
  /* the NBA Data Pack's scope rule: the Cup final is season type 2 but not a regular-season game */
  for (const season of [2024, 2025, 2026]) {
    const fin = D.games([season]).filter((x) => x.status === 'FINAL'); const reg = fin.filter((x) => x.scope === 'regular_season');
    const per = {}; for (const x of reg) { per[x.home_id] = (per[x.home_id] || 0) + 1; per[x.away_id] = (per[x.away_id] || 0) + 1; }
    ok(season + ': one NBA Cup final, kept out of the regular season (1,230 games, 82 a club)', fin.filter((x) => x.scope === 'nba_cup_final').length === 1 && fin.filter((x) => x.scope === 'nba_cup_final').every((x) => x.type === 'R' && x.neutral === 1) && reg.length === 1230 && Object.values(per).every((n) => n === 82), { reg: reg.length });
  }
  ok('club games only: every team id is one of the 30 franchises, and so are the team files', D.games(D.seasonList(2003, 2027)).every((x) => +x.home_id >= 1 && +x.home_id <= 30 && +x.away_id >= 1 && +x.away_id <= 30)
    && Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'data', 'teams.json'), 'utf8'))).length === 30);
  ok('every final game carries a scope that matches its type', D.games([2008, 2016, 2026]).filter((x) => x.status === 'FINAL').every((x) => (x.type === 'P' ? x.scope === 'playoffs' : x.type === 'I' ? x.scope === 'play_in' : x.scope === 'regular_season' || x.scope === 'nba_cup_final')));
  const pg26 = D.playerGames(2026);
  ok('a zero-minute entry the play-by-play puts on court is an appearance', pg26.some((r) => r.pl === 1 && r.min === 0) && pg26.every((r) => !(r.pl === 1 && r.dnp === 1)));
}
/* the streamed work cache round-trips rows a single JSON string could not hold */
{
  const io = R('nba/lib/io.js');
  io.writeWorkLines('test_roundtrip.jsonl.gz', { key: 'k1' }, [{ a: 1 }, { b: [2, null] }, { c: 'x\ny' }]).then(() => io.readWorkLines('test_roundtrip.jsonl.gz')).then((r) => {
    ok('the line-streamed work cache round-trips its head and rows', r.head.key === 'k1' && JSON.stringify(r.rows) === JSON.stringify([{ a: 1 }, { b: [2, null] }, { c: 'x\ny' }]));
    fs.unlinkSync(path.join(C.PATHS.cacheWork, 'test_roundtrip.jsonl.gz'));
  }).catch((e) => ok('the line-streamed work cache round-trips', false, String(e)));
}

/* ---------------------------------------------------------------- 3. learners */
const L = R('nba/model/learn.js');
const S = R('engine/stats.js');
{
  const rand = S.rng(5); const X = [], y = [], yb = [];
  for (let i = 0; i < 3000; i++) { const a = rand() * 2 - 1, b = rand() * 2 - 1; X.push([1, a, b]); y.push(1 + 2 * a - 3 * b + (rand() - 0.5) * 0.1); yb.push(rand() < S.sigmoid(0.5 + 1.5 * a) ? 1 : 0); }
  const f = L.ridge(X, y, { l2: 1e-6 });
  ok('ridge recovers its coefficients', near(f.beta[0], 1, 0.01) && near(f.beta[1], 2, 0.01) && near(f.beta[2], -3, 0.01), f.beta);
  const lg = L.logisticRidge(X, yb, { l2: 1e-6 });
  ok('ridge logistic recovers its slope', near(lg.beta[1], 1.5, 0.25) && near(lg.beta[0], 0.5, 0.15), lg.beta);
  const yn = X.map((x) => (x[1] > 0 ? 1 : 0) * 2 + (x[2] > 0.5 ? 1 : 0));
  const gb = L.gbdt(X, yn, { loss: 'squared', trees: 150, depth: 2, lr: 0.2, minLeaf: 20 });
  /* away from the steps: 32 quantile bins place a split within ~0.06 of the true threshold */
  ok('boosted trees learn a step function', X.slice(0, 600).every((x, i) => Math.abs(x[1]) < 0.07 || Math.abs(x[2] - 0.5) < 0.07 || Math.abs(L.predictGbdt(gb, x) - yn[i]) < 0.3));
  ok('the inverse normal inverts Phi', [0.01, 0.2, 0.5, 0.77, 0.99].every((p) => near(R('nba/model/distribution.js').Phi(L.qnorm(p)), p, 1e-6)));
  const pl = L.platt([0.2, 0.4, 0.6, 0.8, 0.2, 0.4, 0.6, 0.8].concat(new Array(200).fill(0.5)), [0, 0, 1, 1, 0, 1, 0, 1].concat(new Array(200).fill(0).map((_, i) => i % 2)));
  ok('Platt recalibration returns a finite map', isFinite(pl.a) && isFinite(pl.b));
}

/* ---------------------------------------------------------------- 4. ratings */
const RT = R('nba/model/ratings.js');
const PL = R('nba/model/players.js');
{
  const e = new RT.Elo({ k: 20, hfa: 100, revert: 0.75 });
  e.absorb({ home_id: '1', away_id: '2', hs: 110, as: 100, neutral: 0 });
  ok('Elo is zero-sum', near(e.get('1') + e.get('2'), 3010));
  const k = new RT.Kalman({});
  k.update('1', '2', 1, 110, 100); const v1 = k.P[k.idx.get('1')][k.idx.get('1')];
  for (let i = 0; i < 20; i++) k.update('1', '2', 1, 110, 100);
  ok('Kalman variance shrinks as evidence arrives', k.P[k.idx.get('1')][k.idx.get('1')] < v1);
  const gap = k.expectGap('1', '2', 0);
  ok('Kalman learns the stronger offence', gap.gap > 0 && gap.var_gap > 0, gap);
  /* a synthetic league: team i scores 100 + i − (defence of j) */
  const A = new RT.Adjusted('eff', 'offdef', { half_life_days: 1e6, prior_games: 0.1, carry: 0.6, sweeps: 30 });
  A.startSeason(1);
  const rows = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (i !== j) for (let r = 0; r < 4; r++) { rows.push({ t: String(i), o: String(j), y: 100 + i - j * 0.5, home: 0 }); }
  A.add(1, rows); A.refit(1);
  ok('adjusted ratings recover a synthetic league', near(A.T('5').a - A.T('0').a, 5, 0.05) && near(A.T('4').b - A.T('0').b, -2, 0.05), [A.T('5').a - A.T('0').a, A.T('4').b - A.T('0').b]);
  /* RAPM on synthetic stints: p0 adds +6 offence, q0 adds +6 defence */
  const pm = new PL.PlayerModel({ lambda: 50, refit_days: 0, cg_iters: 200 }); pm.startSeason(1);
  const rr = S.rng(3); const pool = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'], qool = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
  const pick = (arr) => arr.slice().sort(() => rr() - 0.5).slice(0, 5);
  const stints = [];
  for (let n = 0; n < 3000; n++) {
    const h5 = pick(pool), a5 = pick(qool); const hposs = 10;
    const hpts = Math.round(hposs * (1.05 + (h5.includes('p0') ? 0.06 : 0) - (a5.includes('q0') ? 0.06 : 0)) + (rr() - 0.5) * 2);
    stints.push([0, 60, h5.sort().join(' '), a5.sort().join(' '), hpts, 10, hposs, 10, 0, 0, 0, 0, 0, 0, 1]);
  }
  pm.addStints(1, 1, stints, 0); pm.refit(1);
  ok('RAPM recovers a synthetic offensive and defensive player', pm.value('p0').o - pm.value('p3').o > 4 && pm.value('q0').d - pm.value('q3').d > 4, [pm.value('p0'), pm.value('q0')]);
  pm.k('newcomer');
  ok('a player first seen after a fit gets the prior, never a neighbouring entry', pm.value('newcomer').o === pm.p.prior_o && pm.value('newcomer').known === false, pm.value('newcomer'));
  const st = pm.strength(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  ok('expected minutes are scaled to 240', near(st.minutes.reduce((a, x) => a + x.min, 0), 240, 0.6), st.minutes.reduce((a, x) => a + x.min, 0));
}

/* ---------------------------------------------------------------- 5. the distribution */
const DIST = R('nba/model/distribution.js');
{
  const shape = { zero: 0.83, fav: [-0.64, -0.16, -0.14, 0, 0.27, 0.02, 0.37, 0.18, 0.18, 0.06], dog: [-0.42, -0.30, -0.12, -0.01, -0.25, 0.17, 0.07, 0.13, 0.15, 0.12], blend: 2 };
  const base = { mu_m: 5.5, sd_m: 12, mu_t: 224, sd_t: 18, theta: shape, gamma: 0.05, ot: { kappa: 0.2, sd: 4.9, tie_w: 0.78, total_mean: 20.6, total_sd: 6.1 }, half: { f_m: 0.5, sd_m: 8.6, f_t: 0.5, sd_t: 12 }, quarter: { f_m: 0.25, sd_m: 6.2, f_t: 0.25, sd_t: 8 } };
  const mg = DIST.marginals(base);
  const sum = (d) => Array.from(d.pmf).reduce((a, v) => a + v, 0);
  ok('the margin and total pmfs have mass 1', near(sum(mg.margin), 1, 1e-9) && near(sum(mg.total), 1, 1e-9));
  ok('no final margin is a tie (overtime resolves it)', DIST.pEqual(mg.margin, 0) === 0);
  const p = DIST.price(base);
  ok('the moneyline sums to 1', near(p.moneyline.home + p.moneyline.away, 1, 1e-6));
  ok('the moneyline favourite is the spread favourite', (p.moneyline.home > 0.5) === (p.spread.fair_line_home < 0));
  ok('the fair spread line covers near 50%', Math.abs(p.spread.main.fair - 0.5) < 0.04 && Math.abs(p.total.main.over.fair - 0.5) < 0.04);
  ok('a whole-number spread line can push, a half point cannot', p.spread.ladder.some((x) => Number.isInteger(x.line_home) && x.push > 0) && p.spread.ladder.filter((x) => !Number.isInteger(x.line_home)).every((x) => x.push === 0));
  ok('the spread ladder is monotone', p.spread.ladder.every((x, i, a) => i === 0 || x.win >= a[i - 1].win - 1e-12));
  ok('the total ladder is monotone', p.total.ladder.every((x, i, a) => i === 0 || x.over.win <= a[i - 1].over.win + 1e-12));
  ok('team totals add to the total', near(p.expected.home + p.expected.away, p.expected.total, 0.02) && near(p.team_totals.home.fair_line + p.team_totals.away.fair_line, p.total.fair_line, 4));
  ok('the oriented shape is exactly 50% at pick\'em', near(DIST.marginals(Object.assign({}, base, { mu_m: 0 })).p_home, 0.5, 1e-9));
  ok('win probability rises with the expected margin', [-8, -3, 0, 3, 8].map((m) => DIST.marginals(Object.assign({}, base, { mu_m: m })).p_home).every((v, i, a) => i === 0 || v > a[i - 1]));
  ok('symmetric: home at +m equals away at −m', near(DIST.marginals(Object.assign({}, base, { mu_m: 4 })).p_home, 1 - DIST.marginals(Object.assign({}, base, { mu_m: -4 })).p_home, 1e-9));
  ok('first half has a tie and three outcomes that sum to 1', p.first_half.moneyline_3way.tie > 0 && near(p.first_half.moneyline_3way.home + p.first_half.moneyline_3way.tie + p.first_half.moneyline_3way.away, 1, 1e-6));
  ok('American odds round-trip', [-250, -110, 100, 145, 400].every((a) => DIST.probToAmerican(DIST.americanToProb(a)) === a || Math.abs(DIST.probToAmerican(DIST.americanToProb(a)) - a) <= 1));
  ok('EV at a price with a push', near(DIST.evAt(0.5, 0.05, -110), 0.5 * (100 / 110) - 0.45, 1e-6));
  ok('CRPS of a point mass at the outcome is 0', DIST.crps({ lo: 0, pmf: Float64Array.from([0, 0, 1, 0]) }, 2) === 0);
}

/* ---------------------------------------------------------------- 6. props */
const PM = R('nba/props/model.js');
{
  const pmf = PM.nbPmf(12.4, 6, 120);
  ok('the negative-binomial pmf has mass 1 and the right mean', near(Array.from(pmf).reduce((a, v) => a + v, 0), 1, 1e-9) && near(Array.from(pmf).reduce((a, v, i) => a + i * v, 0), 12.4, 0.02));
  /* one minutes node: the combination is exact (mean sum, correlated variance) */
  const model = { corr: { pts: { pts: 1, reb: 0.2, ast: 0.3 }, reb: { pts: 0.2, reb: 1, ast: 0.1 }, ast: { pts: 0.3, reb: 0.1, ast: 1 }, stl: {}, blk: {} } };
  const st = (mu, a, b) => ({ mu, lam: mu / 30, a, b, var: a * mu + b * mu * mu });
  const pred = { min: { nodes: [30] }, stat: { pts: st(20, 2, 0.05), reb: st(6, 1, 0.08), ast: st(5, 1, 0.1) } };
  const v = (x) => x.a * x.mu + x.b * x.mu * x.mu; const P_ = pred.stat;
  const c = PM.combo(model, pred, ['pts', 'reb', 'ast']);
  ok('a combined prop adds its means and its correlated variance (given minutes)', near(c.mu, 31) && near(c.var, v(P_.pts) + v(P_.reb) + v(P_.ast) + 2 * (0.2 * Math.sqrt(v(P_.pts) * v(P_.reb)) + 0.3 * Math.sqrt(v(P_.pts) * v(P_.ast)) + 0.1 * Math.sqrt(v(P_.reb) * v(P_.ast))), 1e-6));
  /* minutes nodes widen it: the same rates over 20 and 40 minutes */
  const pred2 = { min: { nodes: [20, 40] }, stat: { pts: st(20, 2, 0.05), reb: st(6, 1, 0.08), ast: st(5, 1, 0.1) } };
  ok('mixing over minutes adds the minutes variance to a combination', PM.combo(model, pred2, ['pts', 'reb', 'ast']).var > c.var + 50);
  /* the lattice negative binomial: mass 1, the mean, Var = a·μ + b·μ² (the uniform spread adds about a²/12), no empty integer */
  const sp = Array.from(PM.scaledPmf(6, 2.3, 0.05, 80)); const m1 = sp.reduce((a, x, i) => a + i * x, 0); const v1 = sp.reduce((a, x, i) => a + (i - m1) * (i - m1) * x, 0);
  ok('a points-like count (step 2.3) keeps its mass, mean and variance', near(sp.reduce((a, x) => a + x, 0), 1, 1e-9) && near(m1, 6, 0.01) && Math.abs(v1 - (2.3 * 6 + 0.05 * 36)) < 2.3 * 2.3 / 12 + 0.1, { m1, v1 });
  ok('...and leaves no integer between lattice points empty', sp.slice(1, 20).every((x) => x > 0));
  ok('a step of 1 is the negative binomial itself', near(Array.from(PM.scaledPmf(4, 1, 0.1, 60)).reduce((a, x, i) => a + i * x, 0), 4, 0.01));
  /* the variance function is recovered from data drawn from it */
  const rng = S.rng(5); const mus = [], ys = [];
  for (let i = 0; i < 20000; i++) { const mu = 1 + 25 * rng(); const pm = PM.scaledPmf(mu, 2.2, 0.03, 200); let u = rng(), y = 0; while (y < pm.length - 1 && u > pm[y]) { u -= pm[y]; y++; } mus.push(mu); ys.push(y); }
  const vf = PM.fitVarFn(mus, ys);
  ok('the variance function a·μ + b·μ² is recovered', Math.abs(vf.a - 2.2) < 0.35 && Math.abs(vf.b - 0.03) < 0.02, vf);
  /* the availability model learns that a player who missed the last game, injured, is less likely to play */
  const av = []; const r2 = S.rng(9);
  for (let i = 0; i < 6000; i++) { const inj = r2() < 0.2 ? 1 : 0; const f = { in_last: inj ? 0 : 1, out: inj ? 1 + Math.floor(r2() * 5) : 0, ew: 0.8, min_ew: 25, start_rate: 0.5, g_ss: 20, b2b: 0 }; for (const k of R('nba/props/state.js').RC) f['rc_' + k] = 0; if (inj) f.rc_INJURY = 1; av.push({ f, y: r2() < (inj ? 0.25 : 0.95) ? 1 : 0 }); }
  const am = PM.fitAvail(av); const fx = (inj) => Object.assign({}, av.find((x) => x.f.rc_INJURY === inj).f);
  ok('the availability model separates a recent injury from a healthy regular', am && PM.predictAvail(am, fx(1)) < 0.4 && PM.predictAvail(am, fx(0)) > 0.9, am && [PM.predictAvail(am, fx(1)), PM.predictAvail(am, fx(0))]);
}

/* ---------------------------------------------------------------- 7. the market */
const Q = R('nba/market/quotes.js');
{
  const sched = [{ game_id: 'G1', home: '2', away: '18', start_utc: '2026-10-21T23:30:00Z' }];
  const evs = [{ id: 'e1', home_team: 'Boston Celtics', away_team: 'New York Knicks', commence_time: '2026-10-21T23:35:00Z', bookmakers: [{ key: 'bk', last_update: '2026-10-21T20:00:00Z', markets: [
    { key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -180 }, { name: 'New York Knicks', price: 150 }] },
    { key: 'spreads', outcomes: [{ name: 'Boston Celtics', price: -110, point: -4.5 }, { name: 'New York Knicks', price: -110, point: 4.5 }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: -105, point: 224.5 }, { name: 'Under', price: -115, point: 224.5 }] }] }] },
  { id: 'e2', home_team: 'Nowhere Team', away_team: 'Boston Celtics', commence_time: '2026-10-21T23:35:00Z', bookmakers: [] }];
  const n = Q.normaliseEvents(evs, sched);
  ok('a quote is matched to its game by both teams and the start', n.events.length === 1 && n.events[0].game_id === 'G1' && n.events[0].books[0].h2h.home === -180 && n.events[0].books[0].spreads[0].home_line === -4.5);
  ok('an unmatched event is kept with its reason, never guessed', n.unmatched.length === 1 && /teams\.json/.test(n.unmatched[0].reason));
  const nv = Q.noVig(-180, 150); ok('the no-vig probability is normalised', near(nv.a + nv.b, 1) && nv.overround > 0);
  const nm = Q.noVigMethods(-400, 320);
  ok('four de-vig methods agree at a pick\'em and their spread is reported', near(Q.noVigMethods(-110, -110).spread, 0) && nm.spread > 0.01 && nm.multiplicative < nm.shin && nm.shin <= nm.power + 1e-9);
  ok('two-way Shin equals the additive method (a known identity)', near(nm.shin, nm.additive, 1e-6));
  const dup = Q.normaliseEvents([Object.assign({}, evs[0], { bookmakers: [evs[0].bookmakers[0], Object.assign({}, evs[0].bookmakers[0], { last_update: '2026-10-21T21:00:00Z', markets: [{ key: 'h2h', outcomes: [{ name: 'Boston Celtics', price: -170 }, { name: 'New York Knicks', price: 145 }] }] })] }), Object.assign({}, evs[0], { id: 'e1b', bookmakers: [] })], sched);
  ok('a book listed twice keeps its latest update; a second event for the game is reported, never merged', dup.events.length === 1 && dup.events[0].books.length === 1 && dup.events[0].books[0].h2h.home === -170 && dup.events[0].duplicate_books_dropped === 1 && dup.unmatched.some((u) => /duplicate provider event/.test(u.reason)));
  const FQ = R('nba/market/fetch_quotes.js');
  FQ.run({ env: {}, dryRun: true }).then((r) => ok('without NBA_PRICES=on nothing is requested', r.status === 'DISABLED' && /not authorised/.test(r.reason)));
}

/* ---------------------------------------------------------------- 8. the ledger */
const GL = R('nba/grade_ledger.js');
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nbaled-'));
  const save = C.PATHS.ledger; C.PATHS.ledger = tmp;
  const L1 = { schema: 'edgedesk_nba_ledger_v1', game_id: 'X1', start_utc: '2026-01-01T00:00:00Z', recorded_at: '2025-12-31T20:00:00Z', p_home: 0.6, fair_spread_home: -3.5, fair_total: 220.5, exp_margin: 3.6, exp_total: 220.8, id: 'a' };
  const late = Object.assign({}, L1, { recorded_at: '2026-01-01T00:10:00Z', p_home: 0.99, id: 'b' });
  fs.writeFileSync(path.join(tmp, '2026.jsonl'), JSON.stringify(L1) + '\n' + JSON.stringify(late) + '\n');
  const g = GL.grade({ season: 2026, dryRun: true, games: [{ game_id: 'X1', status: 'FINAL', hs: 110, as: 100, date: '2025-12-31' }] });
  ok('a sheet recorded after tip is never graded', g.games_graded === 1 && near(g.moneyline.mean_p, 0.6), g.moneyline);
  ok('the grade says there is no profit (nothing was bet)', /nothing was bet/.test(g.profit));
  C.PATHS.ledger = save;
}

/* ---------------------------------------------------------------- 9. loader and desk */
const SY = R('nba/tools/sync_supabase.js');
{
  const gr = SY.gameRows([2025]);
  ok('the loader maps games with period arrays and the diagnostic line', gr.length > 1300 && Array.isArray(gr[0].home_q) && gr[0].home_q.length === 4 && 'ref_line_home' in gr[0] && gr[0].pit === 'RETRO');
  const tr = SY.teamGameRows([2025]);
  ok('the loader maps team games with possessions and context', tr.length > 2600 && tr.every((r) => typeof r.is_home === 'boolean') && tr.some((r) => r.possessions > 80));
}

/* ---------------------------------------------------------------- 10. committed artifacts */
const run = (cmd) => { try { require('child_process').execSync(cmd, { cwd: ROOT, stdio: 'pipe' }); return true; } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
if (fs.existsSync(path.join(ROOT, 'nba', 'validation', 'nba_walkforward.json'))) {
  const r = run('node nba/model/walkforward.js --check'); ok('the walk-forward record passes its check', r === true, r);
  const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'validation', 'nba_walkforward.json'), 'utf8'));
  ok('the record\'s leakage audit found no violation', rec.leakage.violations === 0 && rec.leakage.checked > 10000, rec.leakage);
  ok('no market claims a market test', Object.values(rec.markets).every((t) => Object.values(t).every((m) => typeof m !== 'object' || !m.market_status || m.market_status === 'NOT_TESTED')));
  const sf = path.join(ROOT, 'nba', 'validation', 'summary.json');
  ok('the panel\'s summary exists and matches the record', fs.existsSync(sf) && (() => { const sum = JSON.parse(fs.readFileSync(sf, 'utf8')); return sum.spec_hash === rec.spec_hash && sum.choice.P === rec.choice.P.chosen; })());
}
if (fs.existsSync(path.join(ROOT, 'nba', 'slate.json'))) {
  const r = run('node nba/build_slate.js --check'); ok('the slate passes its check', r === true, r);
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'slate.json'), 'utf8'));
  ok('the slate keeps value claims off', s.value_claims === 'DISABLED' && s.games.every((g) => g.market.value_claims === 'DISABLED'));
  ok('every slate game has reasons to pass and its distribution\'s prices', s.games.every((g) => g.reasons_to_pass.length >= 1 && g.price && g.price.spread.ladder.length > 5));
  const DK = R('nba/desk.js');
  ok('the desk reads the slate schema it was written for', DK.SLATE_SCHEMA === s.schema);
  ok('every game is PASS with its gates, and the market-test gate fails', s.games.every((g) => g.decision && g.decision.decision === 'PASS' && g.decision.gates.length >= 6 && g.decision.gates[0].pass === false));
  ok('the market block keeps the model market-independent and the no-vig market beside it', s.games.every((g) => !g.market.quotes || !g.market.quotes.length || (g.market.forecast_basis && /MARKET_INDEPENDENT/.test(g.market.forecast_basis.model))));
}
/* the NBA Data Pack: the committed verification and reconciliation reproduce, and a tampered pack fails */
if (fs.existsSync(path.join(ROOT, 'datapack', 'nba_v1', 'EDGEDESK_VERIFICATION.json')) && !process.env.NBA_TEST_SKIP_PACK) {
  const r1 = run('node --max-old-space-size=6000 tools/datapack/verify_nba.js --check'); ok('the NBA Data Pack verification reproduces', r1 === true, r1);
  const r2 = run('node --max-old-space-size=6000 nba/crosscheck/pack.js --check'); ok('the pack reconciliation reproduces', r2 === true, r2);
  const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-pack-'));
  try {
    fs.cpSync(path.join(ROOT, 'datapack', 'nba_v1'), tmp, { recursive: true });
    const inv = JSON.parse(fs.readFileSync(path.join(tmp, 'sources', 'inventory.json'), 'utf8')); inv.find((t) => t.table === 'games').rows += 1;
    fs.writeFileSync(path.join(tmp, 'sources', 'inventory.json'), JSON.stringify(inv));
    let failed = false; try { require('child_process').execSync('node --max-old-space-size=6000 tools/datapack/verify_nba.js', { cwd: ROOT, stdio: 'pipe', env: Object.assign({}, process.env, { EDGEDESK_NBA_PACK: tmp }) }); } catch (_) { failed = true; }
    ok('a pack whose inventory disagrees with its tables fails verification', failed);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
if (fs.existsSync(path.join(ROOT, 'nba', 'validation', 'nba_props_walkforward.json'))) { const r = run('node nba/props/walkforward.js --check'); ok('the props record passes its check', r === true, r); }

setTimeout(() => { console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NBA engine — ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail === 0 ? 0 : 1); }, 50);
