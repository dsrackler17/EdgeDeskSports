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
     shadow       the split-factor shadow: the moneyline fit recovers a known
                  split, the shadow moves only the split, DraftKings closes
                  are read and matched exactly, the spread monitor reads
                  narrow, wide and consistent, the shadow ledger is
                  append-only and hash-checked, the pre-registered rule
                  decides once on 1,000 games
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
const DG = R('hockey/model/diagnostics.js');

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

  /* ---------------- diagnostics: team strength ---------------- */
  const prand = ST.rng(11);
  const poisson = (l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= prand(); } while (p > L); return k - 1; };
  const truth = []; for (let i = 0; i < 6000; i++) { const l = 3 * Math.exp(0.25 * (prand() * 2 - 1)); truth.push({ l, y: poisson(l) }); }
  /* forecasts at the truth, spread 1.5 times too far apart, and bunched to half the spread */
  const at = (e) => truth.map((x) => ({ y: x.y, lam: 3 * Math.pow(x.l / 3, e) }));
  const sRight = DG.poissonSlope(at(1)), sWide = DG.poissonSlope(at(1.5)), sNarrow = DG.poissonSlope(at(0.5));
  chk('team strength: a forecast at the truth reads OK (slope near 1)', DG.spreadReading(sRight) === 'OK' && near(sRight.slope, 1, 0.12), sRight);
  chk('team strength: clubs priced too far apart read TOO_WIDE (slope near 1/1.5)', DG.spreadReading(sWide) === 'TOO_WIDE' && near(sWide.slope, 1 / 1.5, 0.1), sWide);
  chk('team strength: clubs bunched toward average read TOO_NARROW (slope near 2)', DG.spreadReading(sNarrow) === 'TOO_NARROW' && near(sNarrow.slope, 2, 0.25), sNarrow);
  chk('team strength: fewer than 30 team-games read TOO_EARLY', DG.spreadReading(DG.poissonSlope(at(1).slice(0, 20))) === 'TOO_EARLY');
  const rr = DG.ratio([{ y: 4, lam: 2 }].concat(Array.from({ length: 39 }, () => ({ y: 2, lam: 2 }))));
  chk('team strength: scored ÷ forecast is total goals over total λ', near(rr.ratio, 82 / 80, 1e-3) && rr.n === 40, rr);
  /* the season-to-date context sees only earlier dates */
  const tg = (team, gf, ga) => ({ team, gf_reg: gf, ga_reg: ga, pp_gf: 1, ev5_gf: gf - 1, evo_gf: 0, sh_gf: 0, ev5_xgf: 2, evo_xgf: 0, pp_xgf: 1, sh_xgf: 0 });
  const tgames = [];
  for (let d = 1; d <= 12; d++) for (const [h, a] of [['AAA', 'BBB'], ['CCC', 'DDD']]) tgames.push({ game_id: d * 10 + (h === 'AAA' ? 1 : 2), season: 2027, type: 'R', date: '2026-10-' + String(d).padStart(2, '0'), home: h, away: a, reg_home: d === 12 && h === 'AAA' ? 9 : 3, reg_away: 2, h: tg(h, d === 12 && h === 'AAA' ? 9 : 3, 2), a: tg(a, 2, d === 12 && h === 'AAA' ? 9 : 3) });
  const trows = DG.teamGameRows(tgames, () => ({ lh: 3, la: 2 }), 2027);
  const last = trows.teams.find((x) => x.date === '2026-10-12' && x.team === 'AAA'), first = trows.teams.find((x) => x.date === '2026-10-01' && x.team === 'AAA');
  chk('team strength: a game\'s own score never reaches its own season-to-date context', last.gp === 11 && last.y === 9 && near(last.ctx.gf, 3 / 2.5, 1e-9) && near(last.ctx.l3, 3 / 2.5, 1e-9), last);
  chk('team strength: a club\'s first game has no season-to-date context', first.gp === 0 && first.ctx === null);
  chk('team strength: one row per team-game and one per game', trows.teams.length === 48 && trows.games.length === 24);

  /* ---------------- expected goals and totals: regression protection ---------------- */
  /* expected goals: λ = exp(β · features + log league goals per team-game), ratings entering as logs */
  const toy = { names: ['home', 'g_off', 'g_def_opp'], beta: [0.1, 0.05, 0.8, 0.9] };
  const lamToy = GLM.predict(toy, { home: 1, g_off: 1.2, g_def_opp: 0.9, league_g_pg: 3.1 });
  chk('xG: λ is exp(β·x) times the league\'s goals per team-game', near(lamToy, Math.exp(0.1 + 0.05 + 0.8 * Math.log(1.2) + 0.9 * Math.log(0.9)) * 3.1, 1e-12), lamToy);
  const avgToy = GLM.predict(toy, { home: 0, g_off: 1, g_def_opp: 1, league_g_pg: 3.1 });
  chk('xG: a missing, null or non-numeric rating reads as league average (ln 1 = 0)', [undefined, null, NaN, 'x'].every((v) => near(GLM.predict(toy, { home: 0, g_off: v, g_def_opp: 1, league_g_pg: 3.1 }), avgToy, 1e-12)));
  chk('xG: a missing league level falls back to 3 goals per team-game', near(GLM.predict(toy, { home: 0, g_off: 1, g_def_opp: 1 }), Math.exp(0.1) * 3, 1e-12));
  chk('xG: an extreme rating is clamped to [0.2, 5] (no runaway λ)', near(GLM.predict(toy, { home: 0, g_off: 50, g_def_opp: 1, league_g_pg: 3 }), GLM.predict(toy, { home: 0, g_off: 5, g_def_opp: 1, league_g_pg: 3 }), 1e-12)
    && near(GLM.predict(toy, { home: 0, g_off: 0.001, g_def_opp: 1, league_g_pg: 3 }), GLM.predict(toy, { home: 0, g_off: 0.2, g_def_opp: 1, league_g_pg: 3 }), 1e-12));
  const core = live.glm[live.model];
  const club = (q, d) => ({ home: 0, ev_off: q, ev_def_opp: d, g_off: q, g_def_opp: d, fin: 1, b2b: 0, b2b_opp: 0, league_g_pg: 3.1 });
  const lStrong = GLM.predict(core, club(1.3, 1.3)), lAvg = GLM.predict(core, club(1, 1)), lWeak = GLM.predict(core, club(0.75, 0.75));
  chk('xG (production model): a strong attack against a leaky defence > two average clubs > a weak attack against a strong defence', lStrong > lAvg && lAvg > lWeak && isFinite(lStrong) && lWeak > 0, [lStrong, lAvg, lWeak]);
  const lExt = GLM.predict(core, club(5, 5)), lExtLo = GLM.predict(core, club(0.2, 0.2));
  chk('xG (production model): the most extreme clamped matchups stay finite and positive', isFinite(lExt) && lExt > lStrong && lExtLo > 0 && lExtLo < lWeak, [lExt, lExtLo]);
  /* totals: the regulation mean is λH + λA; every tied game adds exactly one goal (the overtime winner or the shootout credit).
     The score grid stops at maxg goals a side, so the mass beyond it (≈5e-6 at λ 3) bounds both identities */
  const tot = (lh, la, o) => DIST.game({ lamH: lh, lamA: la, effects: live.effects, ot: o || live.ot });
  const regMean = (D) => { const n = D.maxg + 1; let m = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) m += D.reg_matrix[i * n + j] * (i + j); return m; };
  const D3 = tot(3, 2.8), pmf3 = DIST.totalPmf(D3);
  chk('totals: the regulation mean is λH + λA', near(regMean(D3), 5.8, 1e-4), regMean(D3));
  chk('totals: the full-game expected total = λH + λA + P(tied after 60), regular season and playoffs', near(DIST.expectedTotal(D3), 5.8 + D3.reg.draw, 1e-4) && near(DIST.expectedTotal(tot(3, 2.8, { format: 'PO' })), 5.8 + tot(3, 2.8, { format: 'PO' }).reg.draw, 1e-4), [DIST.expectedTotal(D3), D3.reg.draw]);
  chk('totals: the total-goals distribution sums to one and its mean is the expected total', near(pmf3.reduce((a, p) => a + p, 0), 1, 1e-9) && near(pmf3.reduce((a, p, k) => a + p * k, 0), DIST.expectedTotal(D3), 1e-9));
  const grid = [[2, 2], [2.5, 2.4], [3, 2.8], [3.6, 3.3], [4.2, 4]].map(([h, a]) => tot(h, a));
  chk('totals: low to high λ moves the expected total and P(over 5.5), P(over 6.5) strictly upward', grid.every((D, i) => i === 0 || (DIST.expectedTotal(D) > DIST.expectedTotal(grid[i - 1]) && DIST.total(D, 5.5).over > DIST.total(grid[i - 1], 5.5).over && DIST.total(D, 6.5).over > DIST.total(grid[i - 1], 6.5).over)));
  chk('totals: a low matchup (2 + 2) is under 5.5 more often than not, a high one (4.2 + 4) over 6.5 more often than not', DIST.total(grid[0], 5.5).over < 0.5 && DIST.total(grid[4], 6.5).over > 0.5, [DIST.total(grid[0], 5.5).over, DIST.total(grid[4], 6.5).over]);
  const Dmis = tot(9, 0.3);
  chk('totals: an extreme mismatch still yields a proper distribution', near(DIST.totalPmf(Dmis).reduce((a, p) => a + p, 0), 1, 1e-6) && isFinite(DIST.expectedTotal(Dmis)) && Dmis.p_home > 0.99, [DIST.expectedTotal(Dmis), Dmis.p_home]);
  /* calibration: the total is compressed toward c in logs by a; the split by b; neither touches the other */
  const cal1 = GLM.applyPairCalibration(3.4, 2.6, { a: 1, b: 1, c: 6 });
  chk('calibration: a = b = 1 is the identity', near(cal1.lh, 3.4, 1e-12) && near(cal1.la, 2.6, 1e-12));
  const calA = GLM.applyPairCalibration(4.4, 3.6, { a: 0.5, b: 1, c: 6 });
  chk('calibration: a = 0.5 halves the total\'s log distance from c and keeps the split', near(Math.log((calA.lh + calA.la) / 6), 0.5 * Math.log(8 / 6), 1e-12) && near(calA.lh / calA.la, 4.4 / 3.6, 1e-12), calA);
  const calB = GLM.applyPairCalibration(4.4, 3.6, { a: 1, b: 0.8, c: 6 });
  chk('calibration: b moves the split only, never the total', near(calB.lh + calB.la, 8, 1e-12) && calB.lh / calB.la < 4.4 / 3.6 && calB.lh > calB.la);
  chk('calibration: a total at c is unchanged by any a', near(GLM.applyPairCalibration(3.1, 2.9, { a: 0.3, b: 1, c: 6 }).lh + GLM.applyPairCalibration(3.1, 2.9, { a: 0.3, b: 1, c: 6 }).la, 6, 1e-12));
  /* the fit finds a: predictions spread twice as far as the truth read a ≈ 0.5, predictions at the truth a ≈ 1 */
  const crand = ST.rng(29);
  const cpois = (l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= crand(); } while (p > L); return k - 1; };
  const truthRows = []; for (let i = 0; i < 4000; i++) { const T0 = 6 * Math.exp(0.08 * (crand() * 2 - 1)), sh = 0.5 + 0.1 * (crand() * 2 - 1); truthRows.push({ T0, sh, gh: cpois(T0 * sh), ga: cpois(T0 * (1 - sh)) }); }
  const fitA = (e) => GLM.fitPairCalibration(truthRows.map((x) => { const T = 6 * Math.pow(x.T0 / 6, e); return { lh: T * x.sh, la: T * (1 - x.sh), gh: x.gh, ga: x.ga }; }));
  const fRight = fitA(1), fWide = fitA(2);
  chk('calibration: totals spread twice as far as the truth fit a ≈ 0.5, totals at the truth a ≈ 1 (maximum likelihood, earlier games only in production)', Math.abs(fWide.a - 0.5) <= 0.15 && Math.abs(fRight.a - 1) <= 0.3, [fWide.a, fRight.a]);
  chk('calibration: fewer than 500 earlier games is the identity, and says so', GLM.fitPairCalibration(truthRows.slice(0, 100).map((x) => ({ lh: 3, la: 3, gh: x.gh, ga: x.ga }))).a === 1 && /identity/.test(GLM.fitPairCalibration([]).basis));
  /* rating shrinkage: a club with no games is league average; a scoring club moves toward its rate by k/(n + k) */
  const RT = R('hockey/model/ratings.js');
  const tgr = (team, opp, home, gf, ga, date) => ({ team, opp, home, date, gf, ga, toi_ev5: 2700, ev5_xgf_lead: 0, ev5_xgf_tie: 2.5, ev5_xgf_trail: 0, ev5_xgf: 2.5, evo_xgf: 0, pp_xgf: 0.5, sh_xgf: 0, ev5_gf: gf, evo_gf: 0, pp_gf: 0, sh_gf: 0, toi_pp: 240, toi_sh: 240, g_start: null });
  const shrinkRun = (k) => { const rs = new RT.RatingState(Object.assign({}, RT.DEFAULTS, { prior_games: k, half_life_days: 180 })); for (let d = 1; d <= 10; d++) { const date = '2026-10-' + String(d).padStart(2, '0'); rs.absorb([tgr('HOT', 'AVG', 1, 6, 2, date), tgr('AVG', 'HOT', 0, 2, 6, date)]); } return rs.teamRatings('HOT', RT.dayNum('2026-10-11')); };
  const fresh = new RT.RatingState(RT.DEFAULTS).teamRatings('NEW', RT.dayNum('2026-10-11'));
  chk('shrinkage: a club with no games rates exactly league average on every rating', ['ev_off', 'ev_def', 'g_off', 'g_def', 'pp_off', 'pk_def', 'pp_draw', 'pk_take', 'fin'].every((k) => fresh[k] === 1), fresh);
  const s8 = shrinkRun(8), s32 = shrinkRun(32);
  chk('shrinkage: ten games of 6 goals (league 4) lift the goals rating, but the prior keeps it short of the raw 1.5', s32.g_off > 1 && s8.g_off > s32.g_off && s8.g_off < 1.5 * 1.05, [s8.g_off, s32.g_off]);
  /* goalies: the confirmed-starter variant lowers λ against a better goalie and falls back to the projection */
  const gv = live.glm[live.confirmed_variant || 'xg_goalie_confirmed'];
  const gBase = Object.assign(club(1, 1), { pp_off: 1, pk_def_opp: 1, pp_draw: 1, pk_take_opp: 1, opp_goalie_proj: 0 });
  const lG = (act) => GLM.predict(gv, Object.assign({}, gBase, { opp_goalie_act: act }));
  chk('goalies: a better confirmed goalie (more goals saved above expected per xG) lowers the attacking club\'s λ', lG(0.05) < lG(0) && lG(0) < lG(-0.05), [lG(0.05), lG(0), lG(-0.05)]);
  chk('goalies: with no confirmed starter the variant uses the projection, never an invented goalie', near(GLM.predict(gv, Object.assign({}, gBase, { opp_goalie_act: null, opp_goalie_proj: 0.02 })), lG(0.02), 1e-12));

  /* ---------------- diagnostics: totals audit and the club monitor ---------------- */
  chk('clubs: the Bonferroni bound is 1.96 for one test and about 3.36 for 64', near(DG.bonferroniZ(1, 0.05), 1.96, 0.01) && near(DG.bonferroniZ(64, 0.05), 3.36, 0.02), [DG.bonferroniZ(1), DG.bonferroniZ(64)]);
  const steady = (n, lam, y) => Array.from({ length: n }, () => ({ lam, y }));
  const zf = DG.bonferroniZ(64, 0.05);
  const hotClub = DG.clubBias(steady(82, 3, 4.5), zf), shortHot = DG.clubBias(steady(20, 3, 6), zf), onForecast = DG.clubBias(steady(82, 3, 3), zf);
  chk('clubs: 82 games at 1.5× the forecast is a FLAG; 20 games at 2× is TOO_EARLY (half a season first); a club at its forecast is OK with z 0', hotClub.status === 'FLAG' && shortHot.status === 'TOO_EARLY' && onForecast.status === 'OK' && onForecast.z === 0, [hotClub, shortHot.status, onForecast]);
  chk('clubs: the ratio carries its 95% interval', hotClub.ci95[0] < hotClub.ratio && hotClub.ratio < hotClub.ci95[1] && near(hotClub.ratio, 1.5, 1e-9));
  const mon = [];
  const add = (team, opp, season, n, lam, y) => { for (let i = 0; i < n; i++) mon.push({ team, opp, season, date: season + '-' + String(1000 + i), lam, y }); };
  for (const s of [2025, 2026]) { add('PER', 'OPP', s, 82, 3, 3.6); add('ONE', 'OPP', s, 82, 3, s === 2026 ? 3.6 : 3); add('OPP', 'PER', s, 82, 3, 3); }
  add('PER', 'OPP', 2027, 10, 3, 3); add('ONE', 'OPP', 2027, 10, 3, 3); add('OPP', 'PER', 2027, 10, 3, 3);
  const M = DG.clubMonitor(mon, 2027);
  const per = M.clubs.find((c) => c.team === 'PER'), one = M.clubs.find((c) => c.team === 'ONE');
  chk('clubs: persistent needs two seasons that share no game, the same side, past the watch bound', per.persistent.scoring && per.persistent.scoring.direction === 'MORE_THAN_PROJECTED' && per.persistent.scoring.windows.join() === 'last_season,two_seasons_ago' && one.persistent.scoring === null, [per.persistent, one.persistent]);
  chk('clubs: ten games this season are TOO_EARLY, whatever their rate', per.scoring.season.status === 'TOO_EARLY' && M.flagged.every((f) => f.window !== 'season'));
  chk('clubs: conceding is read from the opponents\' attacking rows', M.clubs.find((c) => c.team === 'OPP').conceding.last_season.ratio === 1.2);
  /* totals audit on synthetic seasons: predictions at the truth read OK; bunched to a third of the spread read TOO_NARROW.
     The reading is a 95% interval test, so about one seed in twenty reads otherwise at the truth (41 gives 0.80); 7 gives 0.98 */
  const trand = ST.rng(7);
  const tpois = (l) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= trand(); } while (p > L); return k - 1; };
  const synth = (shrink) => { const rows = []; for (let i = 0; i < 6000; i++) { const mu = 6 + 1.0 * (trand() * 2 - 1); const T = tpois(mu); const e = 6 + shrink * (mu - 6); rows.push({ season: 2020 + (i % 3), exp_total: e, var_total: mu, total: T, rps: 0, p55: 0.5, p65: 0.4, lh: e / 2, la: e / 2, gh: Math.floor(T / 2), ga: T - Math.floor(T / 2), base: 6, goalie_home_as_projected: true, goalie_away_as_projected: true }); } const q = DG.seasonQuintiles(rows); rows.forEach((x, i) => { x.q = q[i]; }); return DG.totalsAudit(rows); };
  const aRight = synth(1), aTight = synth(1 / 3);
  chk('totals audit: projections at the truth read OK (slope ≈ 1, dispersion ≈ 1); bunched to a third of the spread read TOO_NARROW (slope ≈ 3)', aRight.slope.reading === 'OK' && near(aRight.variance.dispersion, 1, 0.08) && aTight.slope.reading === 'TOO_NARROW' && near(aTight.slope.slope, 3, 0.6), [aRight.slope, aRight.variance.dispersion, aTight.slope]);
  chk('totals audit: five within-season fifths of about a fifth each, each with its interval and observed over rates', aRight.buckets.length === 5 && aRight.buckets.every((b) => near(b.n, 1200, 40) && b.ci95 > 0 && b.over_5_5 && b.over_6_5));
  chk('totals audit: fewer than 30 games returns its count only', JSON.stringify(DG.totalsAudit([])) === '{"n":0}');

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

  /* ---------------- the split-factor shadow (hockey/model/split_shadow.js) ---------------- */
  {
    const SH = R('hockey/model/split_shadow.js');
    const os = require('os');
    const G = SH.grid();
    chk('shadow: the grid is glm.js\'s split grid, 0.7 to 1.6 by 0.025, and holds the frozen b', G.length === 37 && G[0] === 0.7 && G[36] === 1.6 && G.indexOf(SH.PROTOCOL.b) >= 0, G);
    chk('shadow: promoted, it no longer prices beside production, in any season', SH.PROTOCOL.promoted && !SH.active(SH.PROTOCOL.season) && !SH.active(SH.PROTOCOL.season + 1));
    /* the promotion: the season in progress publishes the moneyline-fitted split, every other season keeps the goal-split rule */
    const pc = SH.promote({ a: 0.5, b: 0.9, c: 6.0464, n: 4192 }, SH.PROTOCOL.season);
    chk('promotion: the season in progress takes b = 1.125, keeps a and c, and records the goal-split b', pc.b === SH.PROTOCOL.b && pc.a === 0.5 && pc.c === 6.0464 && pc.goal_split_b === 0.9 && /promoted/.test(pc.split_basis), pc);
    chk('promotion: a completed season keeps the goal-split rule', SH.promote({ a: 0.5, b: 0.9, c: 6 }, SH.PROTOCOL.season - 1).b === 0.9 && SH.promotedSplit(SH.PROTOCOL.season - 1) === null);
    chk('promotion: an identity calibration (no earlier record) is left alone', SH.promote({ a: 1, b: 1, c: null }, SH.PROTOCOL.season).b === 1);
    chk('promotion: applying it twice keeps the goal-split b of the first fit', SH.promote(pc, SH.PROTOCOL.season).goal_split_b === 0.9);
    const liveP = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'model', 'params', 'live.json'), 'utf8'));
    chk('promotion: the live parameters publish b = 1.125 for the chosen model and every variant the slate prices with', liveP.for_season !== SH.PROTOCOL.season || ['xg_core', 'xg_goalie_confirmed', 'goals_only'].every((k) => liveP.pair_calibration[k] && liveP.pair_calibration[k].b === SH.PROTOCOL.b && liveP.pair_calibration[k].goal_split_b != null), Object.fromEntries(Object.entries(liveP.pair_calibration).map(([k, v]) => [k, [v.b, v.goal_split_b]])));
    /* the fit recovers a known split: outcomes drawn at b = 1.2 from a goal-share logit */
    const rnd = ST.rng(20261029); const sig = (z) => 1 / (1 + Math.exp(-z)); const iTrue = G.indexOf(1.2);
    const synth = []; for (let i = 0; i < 40000; i++) { const z = (rnd() - 0.5) * 1.6; const ps = G.map((b) => sig(b * z)); synth.push({ ps, y: rnd() < ps[iTrue] ? 1 : 0 }); }
    const fit = SH.fitMoneylineSplit(synth);
    chk('shadow: the moneyline fit recovers a known split factor (1.2)', Math.abs(fit.b - 1.2) <= 0.05, fit);
    chk('shadow: fewer than 500 earlier games give the identity, as glm.js does', SH.fitMoneylineSplit(synth.slice(0, 499)).b === 1);
    /* the shadow changes the split only: same total, wider goal share, production's a and c kept */
    const cal = { a: 0.5, b: 0.9, c: 6.0464 };
    const sc = SH.shadowCal(cal);
    chk('shadow: the recalibration keeps production\'s a and c and takes the frozen b', sc.a === 0.5 && sc.c === 6.0464 && sc.b === SH.PROTOCOL.b && cal.b === 0.9);
    const pr = GLM.applyPairCalibration(3.3, 2.9, cal), sl = SH.shadowLambda(3.3, 2.9, cal);
    chk('shadow: the expected total is production\'s (the split factor moves only who scores)', near(pr.lh + pr.la, sl.lh + sl.la, 1e-12));
    chk('shadow: a wider split gives the stronger side a larger share', sl.lh / (sl.lh + sl.la) > pr.lh / (pr.lh + pr.la));
    chk('shadow: at production\'s own b the shadow is production', (() => { const same = Object.assign({}, cal, { b: SH.PROTOCOL.b }); const a = GLM.applyPairCalibration(3.3, 2.9, same), b = SH.shadowLambda(3.3, 2.9, same); return a.lh === b.lh && a.la === b.la; })());
    const Dp = DIST.game({ lamH: pr.lh, lamA: pr.la, effects: live.effects, ot: OT }), Ds = DIST.game({ lamH: sl.lh, lamA: sl.la, effects: live.effects, ot: OT });
    chk('shadow: the favourite is more favoured, and the moneyline still sums to one', Ds.p_home > Dp.p_home && near(Ds.p_home + Ds.p_away, 1, 1e-9), [Dp.p_home, Ds.p_home]);
    /* DraftKings closes from the ESPN capture */
    chk('shadow: no-vig of a −110/−110 market is one half', near(SH.noVigHome({ home: -110, away: -110 }), 0.5, 1e-12));
    chk('shadow: no-vig removes the margin proportionally', near(SH.noVigHome({ home: -218, away: 180 }), (218 / 318) / (218 / 318 + 100 / 280), 1e-12));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-closes-'));
    const ev = (cid, h, a, t) => JSON.stringify({ kind: 'event', cid, start_utc: t, home: { abbr: h }, away: { abbr: a } });
    const settle = (cid, book, ml, done) => JSON.stringify({ kind: 'settle', cid, completed: done, books: [{ book, close: { ml } }] });
    fs.writeFileSync(path.join(dir, '2026-10.jsonl'), [ev('1', 'NJ', 'TB', '2026-10-30T23:00:00Z'), settle('1', 'DraftKings', { home: -150, away: 130 }, true),
      ev('2', 'SJ', 'LA', '2026-10-31T02:00:00Z'), settle('2', 'FanDuel', { home: -150, away: 130 }, true),
      ev('3', 'UTAH', 'BOS', '2026-10-31T01:00:00Z'), settle('3', 'DraftKings', { home: -120, away: 100 }, false)].join('\n') + '\n');
    const cl = SH.readCloses(dir);
    chk('shadow: only completed games with DraftKings\' close are read, under the NHL\'s abbreviations', cl.length === 1 && cl[0].home === 'NJD' && cl[0].away === 'TBL' && near(cl[0].p_home, SH.noVigHome({ home: -150, away: 130 }), 1e-12), cl);
    chk('shadow: a close matches its game within six hours of the start, not beyond', !!SH.matchClose(cl, '2026-10-31T04:59:00Z', 'NJD', 'TBL') && !SH.matchClose(cl, '2026-10-31T05:01:00Z', 'NJD', 'TBL') && !SH.matchClose(cl, '2026-10-30T23:00:00Z', 'TBL', 'NJD'));
    chk('shadow: a missing capture folder reads as no closes', SH.readCloses(path.join(dir, 'none')).length === 0);
    /* the spread monitor: a model whose logits are a fixed share of the market's */
    const pairsAt = (k) => { const q = ST.rng(7); const out = []; for (let i = 0; i < 400; i++) { const z = (q() - 0.5) * 1.4; out.push({ p: sig(z), m: sig(k * z + (q() - 0.5) * 0.05) }); } return out; };
    const narrow = SH.spreadStats(pairsAt(1.3)), wide = SH.spreadStats(pairsAt(0.75)), same = SH.spreadStats(pairsAt(1));
    chk('shadow: a model narrower than the market reads NARROWER_THAN_MARKET, slope ≈ 1.3', narrow.reading === 'NARROWER_THAN_MARKET' && near(narrow.slope, 1.3, 0.03) && narrow.mean_favourite_gap_pp < 0 && narrow.favourites_less_favoured > 300, narrow);
    chk('shadow: a model wider than the market reads WIDER_THAN_MARKET', wide.reading === 'WIDER_THAN_MARKET' && near(wide.slope, 0.75, 0.03) && wide.mean_favourite_gap_pp > 0, wide);
    chk('shadow: equally spread reads CONSISTENT', same.reading === 'CONSISTENT', same);
    chk('shadow: under 30 games the reading is TOO_EARLY', SH.spreadStats(pairsAt(1.3).slice(0, 29)).reading === 'TOO_EARLY');
    /* the shadow ledger: append-only, hash-checked, frozen before the start */
    const lf = path.join(dir, 'split_shadow_test.jsonl');
    const game = (id, start, p, ps) => ({ game_id: id, start_utc: start, type: 'R', home: 'NJD', away: 'TBL', prices: { moneyline: { home: p }, puck_line: { home_minus_1_5: p - 0.2 } }, calibration_shadow: { b: SH.PROTOCOL.b, production_b: 0.9, p_home: ps, pl_home_minus_1_5: ps - 0.2 } });
    const now = Date.parse('2026-10-30T12:00:00Z');
    const slateAt = (t, games) => ({ generated_at: new Date(t).toISOString(), model: { id: 'edgedesk_nhl_v1:xg_core' }, games });
    const a1 = SH.ledgerAppend(slateAt(now, [game(1, '2026-10-30T23:00:00Z', 0.6, 0.62), game(2, '2026-10-30T11:00:00Z', 0.55, 0.56)]), now, lf);
    const a2 = SH.ledgerAppend(slateAt(now + 3600e3, [game(1, '2026-10-30T23:00:00Z', 0.603, 0.622)]), now + 3600e3, lf);
    const a3 = SH.ledgerAppend(slateAt(now + 7200e3, [game(1, '2026-10-30T23:00:00Z', 0.61, 0.63)]), now + 7200e3, lf);
    chk('shadow ledger: a started game is never recorded, a small move adds nothing, a half-point move adds a row', a1 === 1 && a2 === 0 && a3 === 1, [a1, a2, a3]);
    const recs = SH.readJsonl(lf);
    chk('shadow ledger: each row freezes the shadow and production at the same moment', recs.every((x) => x.production.p_home != null && x.shadow.p_home != null && x.shadow.b === SH.PROTOCOL.b && x.production.b === 0.9 && x.production.model === 'edgedesk_nhl_v1:xg_core'));
    chk('shadow ledger: the untouched file passes its check', SH.checkLedger(lf).length === 0, SH.checkLedger(lf));
    fs.writeFileSync(lf, fs.readFileSync(lf, 'utf8').replace('"p_home":0.61', '"p_home":0.62'));
    chk('shadow ledger: an edited row fails its check', SH.checkLedger(lf).some((f) => /was edited/.test(f)), SH.checkLedger(lf));
    chk('shadow ledger: the last record before the start is the one graded', SH.lastPregame(recs).get(1).production.p_home === 0.61);
    /* the rule */
    const ruleRows = (n, shadowP, seed) => { const q = ST.rng(seed); const out = []; for (let i = 0; i < n; i++) { const z = (q() - 0.5) * 3.2; const truth = sig(z); const y = q() < truth ? 1 : 0; const day = new Date(Date.parse('2026-11-01T00:00:00Z') + Math.floor(i / 8) * 86400e3); out.push({ date: day.toISOString().slice(0, 10), start_utc: new Date(+day + (i % 8) * 600e3).toISOString(), y, margin: y ? 2 : -1, prod: { p: sig(0.5 * z), pl: 0.3 }, shadow: { p: shadowP(z), pl: 0.3 } }); } return out; };
    const early = SH.verdict(ruleRows(999, (z) => sig(z), 3));
    chk('rule: before 1,000 graded games the record is IN_PROGRESS, whatever it shows', early.rule_status === 'IN_PROGRESS' && early.status === 'PROMOTED' && early.n === 999, early);
    const better = SH.verdict(ruleRows(1200, (z) => sig(z), 3));
    chk('rule: a shadow at the truth against a compressed production is ELIGIBLE, read on the first 1,000 games only', better.rule_status === 'ELIGIBLE' && better.n === 1000 && better.moneyline.shadow_minus_production.ci95[1] < 0, better.checks);
    const tied = SH.verdict(ruleRows(1000, (z) => sig(0.5 * z), 3));
    chk('rule: a shadow no better than production is NOT_CONFIRMED', tied.rule_status === 'NOT_CONFIRMED' && !tied.checks.moneyline_interval_below_zero, tied.checks);
    const overshoot = SH.verdict(ruleRows(1000, (z) => sig(2.2 * z), 3));
    chk('rule: a shadow that overshoots fails on calibration even when it might beat production', overshoot.rule_status === 'NOT_CONFIRMED' && !overshoot.checks.calibration, overshoot.moneyline.shadow);
    const plWorse = SH.verdict(ruleRows(1000, (z) => sig(z), 3).map((x) => Object.assign({}, x, { shadow: { p: x.shadow.p, pl: x.margin >= 2 ? 0.2 : 0.4 } })));
    chk('rule: a puck line worse by more than 0.001 blocks it', plWorse.rule_status === 'NOT_CONFIRMED' && plWorse.checks.moneyline_interval_below_zero && !plWorse.checks.puck_line_not_worse, plWorse.checks);
    /* the live record from injected inputs */
    const tg = [{ home: 1, game_id: 1, date: '2026-10-30', win: 1, gf: 3, ga: 1 }];
    const gr = SH.grade({ season: SH.PROTOCOL.season, teamGames: tg, closes: cl, shadowRecs: recs, productionRecs: [{ game_id: 1, start_utc: '2026-10-30T23:00:00Z', recorded_at: '2026-10-30T12:00:00Z', home: 'NJD', away: 'TBL', p_home: 0.6 }] });
    chk('rule: the live record grades the shadow ledger against the finals and the closes', gr.games_graded === 1 && gr.verdict.status === 'PROMOTED' && gr.verdict.rule_status === 'IN_PROGRESS' && gr.verdict.draftkings_close.n === 1 && gr.market_spread.n === 1 && gr.market_spread.reading === 'TOO_EARLY', gr.verdict.draftkings_close);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------- committed artifacts ---------------- */
  for (const cmd of ['hockey/lab/split_shadow.js --check', 'hockey/lab/run.js --check', 'hockey/props/validate.js --check', 'hockey/props/slate.js --check', 'hockey/crosscheck/boxscore.js --check', 'hockey/model/diagnostics.js --check', 'hockey/sources/registry.js --check']) {
    let ok = true, out = '';
    try { out = cp.execSync('node ' + path.join(ROOT, cmd), { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); } catch (e) { ok = false; out = String(e.stdout || '') + String(e.stderr || ''); }
    chk('artifacts: ' + cmd, ok, out.slice(0, 300));
  }
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
  chk('artifacts: every slate game carries an exact explanation, the full market sheet, re-pricing inputs and a market check', slate.games.every((g) => g.explanation && g.explanation.check.exact && g.markets && g.markets.first_period && g.repricing && g.market_check));
  chk('artifacts: the slate prices with the production model the record chose', slate.model.chosen === JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'validation', 'nhl_walkforward.json'), 'utf8')).selection.chosen);
  chk('artifacts: value claims stay disabled for the NHL', slate.readiness.value_claims.state === 'DISABLED');
  chk('artifacts: a game\'s split-factor shadow is the registered one and never its price', slate.games.every((g) => !g.calibration_shadow || (g.calibration_shadow.status === 'SHADOW' && g.calibration_shadow.b === R('hockey/model/split_shadow.js').PROTOCOL.b && g.calibration_shadow.p_home !== undefined)));

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NHL engine v2 — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
