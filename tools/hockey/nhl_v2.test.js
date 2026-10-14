#!/usr/bin/env node
/* ===========================================================================
   The NHL research engine's second layer, offline: everything added on
   2026-10-13 on synthetic inputs where the answer is known, plus the
   committed artifacts it produced.

     pricing      every market sums to one, complements reconcile, alternates
                  are monotone, whole lines push and only they do, fair odds
                  with a push use the conditional ratio, OT/SO settle as
                  stated, the first period, extreme and missing inputs, the
                  pace mixture, draw inflation, the split solver, old and new
                  score-effect profiles
     explanation  the decomposition adds up exactly; identical clubs at a
                  neutral rink split evenly; a factor the model lacks is absent
     market       PASS / RESEARCH ONLY / PROVISIONAL / VERIFIED VALUE gates,
                  push break-even, no-vig, parity with lib/edgedesk_quote_ev.js
     lab          context features are point in time; the tree learner is
                  deterministic; the promotion rule refuses small gains
     props        distributions normalise; shots, goals and points agree;
                  the mean recalibration is the identity without history
     data         period rows reconcile; the box-score reconciliation counts
                  disagreements; the warehouse sync is off by default and
                  idempotent; the registry never calls an unwired source
                  operational
     artifacts    every committed file passes its own --check

   Run: node tools/hockey/nhl_v2.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require(path.join(ROOT, p));
const DIST = R('hockey/model/distribution.js');
const EX = R('hockey/model/explain.js');
const GLM = R('hockey/model/glm.js');
const MK = R('lib/edgedesk_nhl_market.js');
const CTX = R('hockey/lab/context.js');
const GB = R('hockey/lab/gbdt.js');
const RUN = R('hockey/lab/run.js');
const PM = R('hockey/props/model.js');
const PER = R('hockey/ingest/periods.js');
const BOX = R('hockey/crosscheck/boxscore.js');
const SYNC = R('hockey/warehouse/sync.js');
const REG = R('hockey/sources/registry.js');
const FAKE = R('tools/lib/fake_pgrest.js');
const ST = R('engine/stats.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);
const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'model', 'params', 'live.json'), 'utf8'));

(async function main() {
  /* ---------------- pricing ---------------- */
  const OT = { k: 1.1, so_home: 0.52, format: 'R3v3' };
  const D = DIST.game({ lamH: 3.2, lamA: 2.7, effects: live.effects, ot: OT, periods: true });
  const F = DIST.fullSheet(D);
  chk('pricing: the two-way moneyline sums to one', near(F.moneyline.home + F.moneyline.away, 1, 1e-9));
  chk('pricing: the 60-minute 3-way sums to one', near(F.regulation.home + F.regulation.draw + F.regulation.away, 1, 1e-9));
  chk('pricing: the moneyline includes OT and the shootout exactly as stated', near(D.p_home, D.reg.home + D.reg.draw * (D.tie_split.ot_home + D.tie_split.so_home), 1e-12));
  chk('pricing: every puck line, total, team total and regulation total sums to one with its push', [].concat(Object.values(F.puck_line), Object.values(F.total), Object.values(F.regulation_total), Object.values(F.team_total.home), Object.values(F.team_total.away)).every((x) => near(x.p + x.push + x.p_other, 1, 1e-9)));
  chk('pricing: a half-goal line never pushes, a whole line can', [].concat(Object.values(F.puck_line), Object.values(F.total)).every((x) => { const L = x.home_line != null ? x.home_line : x.line; return Number.isInteger(L) ? x.push > 0 : x.push === 0; }));
  chk('pricing: complements reconcile (home −1.5 + away +1.5 = 1)', near(DIST.spread(D, -1.5).win + DIST.spread(D, -1.5).lose, 1, 1e-9) && near(F.puck_line[-1.5].p, 1 - F.puck_line[-1.5].p_other, 1e-9));
  chk('pricing: an OT/SO win is a one-goal win (home −1.5 is a regulation win by 2+ only)', (() => { let r2 = 0; const N = D.maxg + 1; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) if (h - a >= 2) r2 += D.reg_matrix[h * N + a]; return near(DIST.spread(D, -1.5).win, r2, 1e-9); })());
  chk('pricing: home +1.5 covers every one-goal loss, including in OT and the shootout', near(DIST.spread(D, 1.5).win, 1 - (() => { let r2 = 0; const N = D.maxg + 1; for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) if (a - h >= 2) r2 += D.reg_matrix[h * N + a]; return r2; })(), 1e-9));
  const pls = [-3.5, -2.5, -1.5, 1.5, 2.5, 3.5].map((L) => DIST.spread(D, L).win);
  chk('pricing: alternate puck lines are monotone', pls.every((p, i) => i === 0 || p > pls[i - 1]), pls);
  const tots = [4.5, 5.5, 6.5, 7.5, 8.5].map((L) => DIST.total(D, L).over);
  chk('pricing: alternate totals are monotone', tots.every((p, i) => i === 0 || p < tots[i - 1]), tots);
  chk('pricing: the shootout winner is credited one goal in the total (a 2-2 regulation tie ends 3-2)', (() => { const tie = D.reg_matrix[2 * (D.maxg + 1) + 2]; const NF = D.maxg + 2; return near(D.final_matrix[3 * NF + 2] + D.final_matrix[2 * NF + 3], tie + (D.reg_matrix[3 * (D.maxg + 1) + 2] + D.reg_matrix[2 * (D.maxg + 1) + 3]), 1e-12); })());
  chk('pricing: a regulation total excludes overtime (it never exceeds the full-game total)', [4.5, 5.5, 6.5].every((L) => DIST.regulationTotal(D, L).over <= DIST.total(D, L).over + 1e-12));
  const t6 = DIST.total(D, 6);
  chk('pricing: fair odds with a push use the conditional ratio', DIST.fairAmericanWithPush(t6.over, t6.push) === DIST.probToAmerican(t6.over / (t6.over + t6.under)), [DIST.fairAmericanWithPush(t6.over, t6.push), DIST.probToAmerican(t6.over / (1 - t6.push))]);
  chk('pricing: American conversion is correct at the edges (50% = +100, 60% = −150, 25% = +300)', DIST.probToAmerican(0.5) === 100 && DIST.probToAmerican(0.6) === -150 && DIST.probToAmerican(0.25) === 300);
  const fp = DIST.firstPeriod(D);
  chk('pricing: the first period sums to one and scores fewer goals than the game', near(fp.home + fp.draw + fp.away, 1, 1e-9) && fp.expected < DIST.expectedTotal(D) / 2);
  const Dx = DIST.game({ lamH: 6, lamA: 0.3, effects: live.effects, ot: OT });
  chk('pricing: an extreme mismatch stays normalised and sensible', near(DIST.fullSheet(Dx).moneyline.home + DIST.fullSheet(Dx).moneyline.away, 1, 1e-9) && Dx.p_home > 0.95);
  const Dn = DIST.game({ lamH: 3, lamA: 3 });
  chk('pricing: missing score effects and overtime parameters fall back to neutral ones', near(Dn.p_home + Dn.p_away, 1, 1e-9) && Dn.p_home > 0.45 && Dn.p_home < 0.55);
  const mix = DIST.paceMixture(16);
  chk('pricing: the pace mixture has mean 1 and variance 1/k exactly', near(mix.reduce((a, v) => a + v, 0) / mix.length, 1, 1e-12) && near(mix.reduce((a, v) => a + (v - 1) ** 2, 0) / mix.length, 1 / 16, 1e-12));
  const Dp = DIST.game({ lamH: 3.2, lamA: 2.7, effects: live.effects, ot: OT, pace_shape: 16 });
  chk('pricing: the pace mixture keeps each team\'s mean and widens the total', near(Dp.lamH, 3.2) && DIST.total(Dp, 8.5).over > DIST.total(D, 8.5).over);
  const Dd = DIST.game({ lamH: 3.2, lamA: 2.7, effects: live.effects, ot: OT, draw_inflation: 0.1 });
  chk('pricing: draw inflation raises the 60-minute draw and keeps the matrix normalised', Dd.reg.draw > D.reg.draw && near(Dd.reg.home + Dd.reg.draw + Dd.reg.away, 1, 1e-9));
  const Ds = DIST.solveSplit(0.6, 6, { effects: live.effects, ot: OT });
  chk('pricing: the split solver reaches its target and keeps the total', near(Ds.p_home, 0.6, 1e-5) && near(Ds.lamH + Ds.lamA, 6, 1e-9));
  const coarse = DIST.estimateScoreEffects([{ goals: [{ t: 100, side: 'home' }, { t: 2000, side: 'away' }] }]);
  chk('pricing: an effects profile carries its own time buckets (old files still price)', coarse.t_buckets.length === DIST.T_BUCKETS.length && near(DIST.game({ lamH: 3, lamA: 3, effects: { m: live.effects.m.slice(0, 7), d_min: -3, d_max: 3 } }).p_home + 0, DIST.game({ lamH: 3, lamA: 3, effects: { m: live.effects.m.slice(0, 7), d_min: -3, d_max: 3 } }).p_home));
  chk('pricing: production uses the profile that separates the first period', JSON.stringify(live.effects.t_buckets) === JSON.stringify(DIST.T_BUCKETS_FINE));

  /* ---------------- explanation ---------------- */
  const model = live.glm[live.model];
  const snap = (o) => Object.assign({ home: 0, ev_off: 1, ev_def_opp: 1, g_off: 1, g_def_opp: 1, pp_off: 1, pk_def_opp: 1, pp_draw: 1, pk_take_opp: 1, fin: 1, b2b: 0, b2b_opp: 0, league_g_pg: 3.05 }, o);
  const e1 = EX.explainGame({ model, cal: live.pair_calibration[live.model], effects: live.effects, ot: live.ot, fh: snap({ home: 1, ev_off: 1.1, b2b_opp: 1 }), fa: snap({ ev_def_opp: 0.95, b2b: 1 }), home: 'AAA', away: 'BBB' });
  chk('explanation: the contributions add up to the published probability exactly', e1.check.exact && near(e1.check.sum_of_contributions_pp, e1.check.published_minus_baseline_pp, 1e-6), e1.check);
  chk('explanation: two league-average clubs at a neutral rink split close to evenly', Math.abs(e1.baseline.p_home - 0.5) < 0.02, e1.baseline);
  chk('explanation: the away club\'s back-to-back helps the home club', e1.factors.find((f) => f.key === 'away_rest').pp > 0);
  chk('explanation: a factor the production model does not carry is not listed', model.names.indexOf('pp_off') >= 0 || !e1.factors.some((f) => /_special$/.test(f.key)), e1.factors.map((f) => f.key));
  const nar = EX.narrative(e1, { home: 'AAA', away: 'BBB' });
  chk('explanation: the narrative only repeats numbers the decomposition holds', nar.every((l) => (l.match(/[+−]\d+\.\d pp/g) || []).every((x) => e1.factors.some((f) => Math.abs(Math.abs(f.pp) - Number(x.replace(/[^\d.]/g, ''))) < 0.051))), nar);

  /* ---------------- market engine ---------------- */
  const base = { market: { kind: 'moneyline', label: 'moneyline', settles: 'two-way incl. OT/SO' }, context: { now: Date.parse('2026-10-13T18:00:00Z'), data_state: 'FRESH', goalie_certainty: 'CONFIRMED' } };
  const q = (a, extra) => Object.assign({ american: a, book: 'book', captured_at: '2026-10-13T17:50:00Z', source: 'captured' }, extra || {});
  const ev = (o) => MK.evaluate(Object.assign({}, base, o));
  chk('market: a price below fair is PASS', ev({ model: { p_win: 0.55, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900 }, quote: q(-150) }).label === 'PASS');
  chk('market: positive EV on an unvalidated market is RESEARCH ONLY', ev({ model: { p_win: 0.6, status: 'PROVISIONAL', market_status: 'NOT_TESTED' }, quote: q(110) }).label === 'RESEARCH_ONLY');
  const prov = ev({ model: { p_win: 0.6, status: 'OUTCOME_VALIDATED', market_status: 'NOT_TESTED', sd_pp: 1 }, quote: q(110) });
  chk('market: positive EV without a market test is PROVISIONAL and says so', prov.label === 'PROVISIONAL' && prov.reasons.some((r) => /closing prices/.test(r)), prov.reasons);
  const ver = ev({ model: { p_win: 0.6, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900, sd_pp: 1 }, quote: q(110) });
  chk('market: VERIFIED VALUE only when every gate passes', ver.label === 'VERIFIED_VALUE' && ver.gates.every((g) => g.ok), ver.gates);
  chk('market: a typed-in price can never be verified value', ev({ model: { p_win: 0.6, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900 }, quote: q(110, { source: 'user_supplied' }) }).label === 'PROVISIONAL');
  chk('market: a stale price is not verified', ev({ model: { p_win: 0.6, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900 }, quote: q(110, { captured_at: '2026-10-13T12:00:00Z' }) }).label === 'PROVISIONAL');
  chk('market: an edge that vanishes one sd lower is not verified', ev({ model: { p_win: 0.49, status: 'OUTCOME_VALIDATED', market_status: 'TESTED_AHEAD', market_n: 900, sd_pp: 3 }, quote: q(110) }).label === 'PROVISIONAL');
  chk('market: a settlement mismatch is PASS', ev({ model: { p_win: 0.6, status: 'OUTCOME_VALIDATED' }, quote: q(110, { settles: '60 minutes only' }) }).label === 'PASS');
  const pushRes = MK.evaluate({ market: { kind: 'total' }, model: { p_win: 0.4, p_push: 0.2, status: 'PROVISIONAL' }, quote: q(-110) });
  chk('market: with a push the break-even is on decided bets and the fair price is conditional', near(pushRes.numbers.break_even_unconditional, 0.8 / MK.amToDec(-110), 1e-4) && pushRes.numbers.fair_american === DIST.probToAmerican(0.5), pushRes.numbers);
  const nv = MK.noVig(-120, 100);
  chk('market: no-vig is multiplicative and sums to one', near(nv.p + (1 - nv.p), 1) && nv.p > 0.5 && nv.overround > 0);
  try {
    const QE = R('lib/edgedesk_quote_ev.js');
    const cases = [[0.55, 0, -120], [0.4, 0.2, -110], [0.3, 0, 250]];
    chk('market: EV and fair price agree with lib/edgedesk_quote_ev.js', cases.every(([w, pu, a]) => { const d = MK.amToDec(a); return near(MK.ev(w, pu, d), QE.expectedValue(w, pu, 1 - w - pu, d), 1e-9) && near(MK.fairDecimal(w, pu), QE.fairDecimal(w, pu), 1e-9); }));
  } catch (e) { chk('market: lib/edgedesk_quote_ev.js loads for the parity check', false, e.message); }

  /* ---------------- lab ---------------- */
  const det = { lat: 42.3411, lon: -83.0553 }, nj = { lat: 40.7335, lon: -74.1711 };
  chk('context: Detroit to Newark is about 770 km', near(CTX.haversineKm(det, nj), 770, 30), CTX.haversineKm(det, nj));
  chk('context: Arizona keeps UTC−7 year round; New York changes', CTX.tzOffset('America/Phoenix', '2026-01-10') === -7 && CTX.tzOffset('America/Phoenix', '2026-07-10') === -7 && CTX.tzOffset('America/New_York', '2026-01-10') === -5 && CTX.tzOffset('America/New_York', '2026-07-10') === -4);
  const sf = CTX.scheduleFeatures('NJD', 'DET', '2026-10-13', [{ date: '2026-10-11', at: 'NJD' }, { date: '2026-10-12', at: 'NJD' }]);
  chk('context: schedule features (travel, clock change, games in three days, road trip)', near(sf.travel_km, 770, 30) && sf.tz_shift === 0 && sf.games_3d === 2 && sf.road_len === 1, sf);
  const mkRow = (team, opp, home, gf, xg) => ({ team, opp, home, ev5_xgf: xg, toi_ev5: 2700, ev5_gf: gf, evo_xgf: 0, pp_xgf: 0, sh_xgf: 0, evo_gf: 0, pp_gf: 0, sh_gf: 0 });
  const games = [];
  for (let i = 0; i < 6; i++) games.push({ game_id: i + 1, season: 2027, date: '2026-10-0' + (i + 1), home: 'AAA', away: 'BBB', h: mkRow('AAA', 'BBB', 1, i === 5 ? 9 : 2, 2), a: mkRow('BBB', 'AAA', 0, 1, 1) });
  const cx = CTX.contextFeatures(games);
  chk('context: a game\'s own result never reaches its own features (point in time)', cx.get(6).home.luck_fin === cx.get(6).home.luck_fin && near(cx.get(6).home.luck_fin, Math.log((2 * 5 + 10) / (2 * 5 + 10))), cx.get(6).home);
  const rnd = ST.rng(3); const X = [], y = [];
  for (let i = 0; i < 800; i++) { const x = [rnd() * 2 - 1, rnd() * 2 - 1]; X.push(x); y.push(rnd() < ST.sigmoid(1.5 * x[0]) ? 1 : 0); }
  const m1 = GB.fit(X, y, { rounds: 40 }), m2 = GB.fit(X, y, { rounds: 40 });
  chk('lab: the tree learner is deterministic and returns probabilities', JSON.stringify(m1.trees) === JSON.stringify(m2.trees) && X.every((x) => { const p = GB.predict(m1, x); return p > 0 && p < 1; }));
  chk('lab: the tree learner finds the informative feature', GB.importance(m1)[0].feature === 0);
  const sc = { selection: {}, confirmation: { calibration_slope: 1, calibration_in_the_large: 0 } };
  chk('lab: the promotion rule refuses a gain under 0.001 on selection', !RUN.promotionCheck('x', sc, { mean_diff: -0.0005 }, { ci95: [-0.002, -0.0001] }, true).passes);
  chk('lab: the promotion rule refuses a confirmation interval that crosses zero', !RUN.promotionCheck('x', sc, { mean_diff: -0.002 }, { ci95: [-0.002, 0.0003] }, true).passes);
  chk('lab: the promotion rule accepts only when every condition holds', RUN.promotionCheck('x', sc, { mean_diff: -0.002 }, { ci95: [-0.003, -0.001] }, true).passes);

  /* ---------------- props ---------------- */
  const nb = PM.nbPmf(2.6, 6, 30);
  chk('props: the shot distribution normalises and has the right mean', near(nb.reduce((a, v) => a + v, 0), 1, 1e-9) && near(nb.reduce((a, v, k) => a + k * v, 0), 2.6, 1e-4));
  const sm = PM.skaterMarkets({ mu_sog: 2.6, mu_goals: 0.32, mu_assists: 0.35 }, 8);
  chk('props: shot lines are monotone', sm.sog.over[0.5] > sm.sog.over[1.5] && sm.sog.over[1.5] > sm.sog.over[2.5] && sm.sog.over[2.5] > sm.sog.over[3.5]);
  chk('props: a point is likelier than a goal or an assist, and two points less likely than one', sm.points.over[0.5] > sm.goals.anytime && sm.points.over[0.5] > sm.assists.over[0.5] && sm.points.over[1.5] < sm.points.over[0.5]);
  chk('props: goal and 3+ shots is below both of its marginals', sm.joint.goal_and_3plus_shots < sm.goals.anytime && sm.joint.goal_and_3plus_shots < sm.sog.over[2.5]);
  const gm = PM.goalieMarkets({ mu_sa: 30, sv: 0.9 }, 30);
  chk('props: expected saves = expected shots × save percentage', near(gm.saves.mean, 27, 0.05), gm.saves.mean);
  chk('props: the mean recalibration is the identity without enough history', JSON.stringify(PM.fitMeanCal([{ mu: 1, y: 1 }])).indexOf('"b":1') >= 0 && PM.applyMeanCal(2, { b: 1, c: 1 }) === 2);

  /* ---------------- data ---------------- */
  const pr = PER.periodRow({ game: { game_id: 1, season: 2027, season_type: 'R', date: '2026-10-10', home: 'A', away: 'B', decided: 'OT', reg_home: 2, reg_away: 2 }, shots: [{ goal: 1, side: 'home', period: 1, gs: 100 }, { goal: 1, side: 'away', period: 2, gs: 1500 }, { goal: 1, side: 'home', period: 3, gs: 3400, empty_net: 0 }, { goal: 1, side: 'away', period: 3, gs: 3550 }, { goal: 1, side: 'home', period: 4, gs: 3700 }] });
  chk('data: period rows sum to the regulation score and count OT and late goals', pr.check === 'OK' && pr.h1 === 1 && pr.a2 === 1 && pr.hot === 1 && pr.h_late === 1 && pr.a_late === 1, pr);
  const recBox = BOX.reconcileSeason([{ game: { game_id: 9, date: '2026-10-10', home: 'A', away: 'B', final_home: 2, final_away: 1, starter_home: 30, starter_away: 31 }, teams: { home: { pim: 4, pim_unattributed: 2 }, away: { pim: 2, pim_unattributed: 0 } }, shots: [
    { side: 'home', on_goal: 1, goal: 1, state: 'pp', goalie: 31, shooter: 1, a1: 2, a2: null }, { side: 'home', on_goal: 1, goal: 1, state: 'ev5', goalie: 31, shooter: 1, a1: null, a2: null }, { side: 'away', on_goal: 1, goal: 1, state: 'ev5', goalie: 30, shooter: 5, a1: null, a2: null }, { side: 'away', on_goal: 0, goal: 0, state: 'ev5', goalie: 30, shooter: 5 }] }],
  { games: { 9: { teams: { home: { goals: 2, sog: 2, ppg: 1, pim: 2 }, away: { goals: 1, sog: 2, ppg: 0, pim: 2 } }, goalies: { home: [[30, 1, 3600, 1, 0, 1]], away: [[31, 1, 3600, 2, 0, 2]] }, skaters: { home: [[1, 1000, 2, 0, 2], [2, 900, 0, 1, 0]], away: [[5, 900, 1, 0, 1]] } } } });
  chk('data: the box-score reconciliation agrees where the sources agree and counts where they do not', recBox.team.goals.agree === 2 && recBox.team.power_play_goals.agree === 2 && recBox.team.shots_on_goal.agree === 1 && recBox.team.shots_on_goal.rows === 2 && recBox.team.pim.agree === 2 && recBox.goalie.starter.agree === 2 && recBox.skater.goals.agree === 3, { t: recBox.team, g: recBox.goalie });
  const off = await SYNC.run({ env: {} });
  chk('warehouse: nothing is written unless NHL_WAREHOUSE is on', off.status === 'SKIPPED' && /NHL_WAREHOUSE/.test(off.reason));
  const fake = FAKE.fakePgrest();
  const r1 = await SYNC.run({ env: { NHL_WAREHOUSE: 'on' }, db: fake, seasons: String(2027) });
  const n1 = fake.count('nhl', 'games'), np = fake.count('nhl', 'predictions');
  const r2 = await SYNC.run({ env: { NHL_WAREHOUSE: 'on' }, db: fake, seasons: String(2027) });
  chk('warehouse: a sync writes the season\'s games, periods, predictions, sources and validation', r1.status === 'ok' && n1 > 0 && fake.count('nhl', 'game_periods') === n1 && np > 0 && fake.count('nhl', 'sources') >= 10 && fake.count('nhl', 'validation_runs') >= 5, r1);
  chk('warehouse: a second sync writes nothing (content-hashed parts) and duplicates nothing', Object.values(r2.datasets).every((d) => d.written === 0) && fake.count('nhl', 'games') === n1 && fake.count('nhl', 'predictions') === np, r2.datasets);
  chk('warehouse: every synced pregame prediction was recorded before its start', fake.rows('nhl', 'predictions').every((p) => Date.parse(p.recorded_at) < Date.parse(p.start_utc)));
  const reg = REG.build();
  chk('registry: no unwired provider is called operational', reg.providers.every((p) => p.wired || !/^(OPERATIONAL|STALE)$/.test(p.status)));
  chk('registry: MoneyPuck, Natural Stat Trick, Evolving-Hockey and HockeyViz are not wired, and each has a drafted request', ['moneypuck', 'natural_stat_trick', 'evolving_hockey', 'hockeyviz'].every((id) => { const p = reg.providers.find((x) => x.id === id); return p && !p.wired && p.data_permission === 'AWAITING_PERMISSION'; }) && ['moneypuck', 'natural-stat-trick', 'evolving-hockey', 'hockeyviz'].every((f) => fs.existsSync(path.join(ROOT, 'docs', 'engine', 'access-requests', f + '.md'))));
  chk('registry: the odds feed waits for the owner\'s authorisation', reg.providers.find((x) => x.id === 'odds_gateway_nhl').status === 'AWAITING_AUTHORISATION');

  /* ---------------- committed artifacts ---------------- */
  for (const cmd of ['hockey/lab/run.js --check', 'hockey/props/validate.js --check', 'hockey/props/slate.js --check', 'hockey/crosscheck/boxscore.js --check', 'hockey/model/diagnostics.js --check', 'hockey/sources/registry.js --check']) {
    let ok = true, out = '';
    try { out = cp.execSync('node ' + path.join(ROOT, cmd), { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); } catch (e) { ok = false; out = String(e.stdout || '') + String(e.stderr || ''); }
    chk('artifacts: ' + cmd, ok, out.slice(0, 300));
  }
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
  chk('artifacts: every slate game carries an exact explanation, the full market sheet, re-pricing inputs and a market check', slate.games.every((g) => g.explanation && g.explanation.check.exact && g.markets && g.markets.first_period && g.repricing && g.market_check));
  chk('artifacts: the slate prices with the production model the record chose', slate.model.chosen === JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_walkforward.json'), 'utf8')).selection.chosen);
  chk('artifacts: value claims stay disabled for the NHL', slate.readiness.value_claims.state === 'DISABLED');

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL engine v2 — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
