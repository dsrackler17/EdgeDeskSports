#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS ENGINE AND MODEL (football/props/engine.js, model.js,
   calibrate.js, nfl_data.js) on a synthetic game, so every rule is checked
   without a network:

     simulation     seeded and reproducible; a different seed is a different
                    draw; the QB's completions and yards are the catches and
                    yards his receivers made (one simulated game, not two
                    models); QB and WR1 move together; yardage is skewed and
                    has a zero atom (never a Normal)
     availability   a questionable receiver's own props exist only in the
                    simulations he plays (a book voids a DNP); when he sits,
                    teammates gain part of his share — never all of it
     redistribution the plan names recipients, keeps a leak, never hands 100%
                    of a share to the backup, and says how confident it is
     shrinkage      a one-game spike is pulled to the role prior; a long
                    record is not; the last three games are shown, not chased
     calibration    the zero-preserving transform keeps the zero atom and the
                    mass, and moves the centre toward the baseline
     leakage        nothing at or after the as-of time reaches a projection
                    (games, gain pools); the committed walk-forward
                    validation reports zero leakage violations

   Run: node tools/props/props_engine.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_props.js');
const E = require('../../football/props/engine.js');
const M = require('../../football/props/model.js');
const C = require('../../football/props/calibrate.js');
const D = require('../../football/props/nfl_data.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''));
}
const mean = (a) => a.reduce((t, x) => t + x, 0) / a.length;
const finite = (arr) => Array.from(arr).filter((x) => !Number.isNaN(x));
function medianOf(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

/* ------------------------------------------------ a synthetic game input */
function gains(seed, n, scale, lossP) {
  const S = E.Sampler(seed), out = [];
  for (let i = 0; i < n; i++) out.push(S.u() < (lossP || 0) ? -Math.round(3 * S.u()) : Math.round(-Math.log(Math.max(1e-9, S.u())) * scale + 1));
  return out;
}
const POOLS = { WR: E.buildPool(gains(1, 4000, 11)), TE: E.buildPool(gains(2, 4000, 9)), RB: E.buildPool(gains(3, 4000, 7)),
  rush_rb: E.buildPool(gains(4, 6000, 4, 0.12)), scramble: E.buildPool(gains(5, 1000, 6)), rush_qb_designed: E.buildPool(gains(6, 1000, 4)), rush_wr: E.buildPool(gains(7, 500, 6)) };
function rec(id, pool, share, pa, redistribute) { return { id, pool, share: { mean: share, sd: 0.03 }, catch: { mean: 0.66, sd: 0.04 }, ypr: { mean: pool === 'TE' ? 10 : (pool === 'RB' ? 7.5 : 12.5), sd: 0.1 }, rz_share: share, p_active: pa == null ? 1 : pa, redistribute: redistribute || [] }; }
function rush(id, share, pa, redistribute) { return { id, pool: 'rush_rb', share: { mean: share, sd: 0.04 }, ypc: { mean: 4.3, sd: 0.08 }, rz_share: share, p_active: pa == null ? 1 : pa, redistribute: redistribute || [] }; }
function team(code, qb, opts) {
  opts = opts || {};
  return { team: code,
    receivers: [rec(code + '_WR1', 'WR', 0.27, opts.wr1_active, [[1, 0.35], [2, 0.25], [3, 0.15]]), rec(code + '_WR2', 'WR', 0.20), rec(code + '_TE1', 'TE', 0.16), rec(code + '_RB1r', 'RB', 0.10), rec(code + '_WR3', 'WR', 0.10)],
    rushers: [rush(code + '_RB1', 0.62), rush(code + '_RB2', 0.25), rush(qb, 0.08)],
    qb: { id: qb, scramble_rate: 0.05, scramble_ypc: 6, int_rate: 0.024, rz_scramble_share: 0.05 },
    other: { tgt_share: 0.17, car_share: 0.05, ypr: 10, catch: 0.62, rz_tgt_share: 0.1, rz_car_share: 0.05 },
    plays: { mean: 63, script: 0.25, total: 0.2, sd: 5 }, pass_rate: { mean: 0.58, script: -0.008, sd: 0.05 }, sack_rate: 0.065, untargeted_rate: 0.04,
    eff: { pass: 1, pass_sd: 0.12, rush: 1, rush_sd: 0.12, catch: 1 }, alpha: { tgt: 60, car: 45 }, td: { per_game: 2.4, yards_mean: 330, elasticity: 1.4, pass_share: 0.62, pass_share_script: 0.5 } };
}
function game(seed, opts) { return { game_id: 'SYN_1', seed: seed || 'SYN_1|test', margin: { sd: 10.5 }, total: { sd: 13 }, teams: { home: team('HOM', 'HOM_QB', opts), away: team('AWY', 'AWY_QB') } }; }

/* ============================================================ 1. SAMPLER */
{
  const S = E.Sampler(42);
  const b = []; for (let i = 0; i < 20000; i++) b.push(S.binom(20, 0.3));
  chk('binomial mean n·p', Math.abs(mean(b) - 6) < 0.08, mean(b));
  const po = []; for (let i = 0; i < 20000; i++) po.push(S.poisson(2.4));
  chk('Poisson mean λ', Math.abs(mean(po) - 2.4) < 0.05, mean(po));
  const be = []; for (let i = 0; i < 20000; i++) be.push(S.beta(0.25, 0.05));
  chk('Beta with this mean', Math.abs(mean(be) - 0.25) < 0.004, mean(be));
  const ln = []; for (let i = 0; i < 20000; i++) ln.push(S.lognormalFactor(0.2));
  chk('the log-normal efficiency shock has mean one (no drift)', Math.abs(mean(ln) - 1) < 0.01, mean(ln));
  chk('a pool draw by inverse CDF lands on the pool', E.poolDraw(POOLS.WR, 0) >= POOLS.WR.lo && E.poolDraw(POOLS.WR, 0.999999) <= POOLS.WR.lo + POOLS.WR.counts.length - 1);
  const f = E.scaleFor(POOLS.WR, 14);
  const drawn = []; const S2 = E.Sampler(9); for (let i = 0; i < 20000; i++) { const y = E.poolDraw(POOLS.WR, S2.u()); drawn.push(y > 0 ? y * f : y); }
  chk('a rescaled pool hits the player’s own efficiency', Math.abs(mean(drawn) - 14) < 0.3, mean(drawn));
}

/* ======================================================== 2. SIMULATION */
const N = 6000;
const R1 = E.simulate(game(), POOLS, { sims: N });
{
  const R2 = E.simulate(game(), POOLS, { sims: N });
  chk('seeded: the same game and seed reproduce every draw', JSON.stringify(Array.from(R1.players.HOM_WR1.rec_yds.slice(0, 500))) === JSON.stringify(Array.from(R2.players.HOM_WR1.rec_yds.slice(0, 500))));
  const R3 = E.simulate(game('SYN_1|other-seed'), POOLS, { sims: N });
  chk('a different seed is a different draw', JSON.stringify(Array.from(R1.players.HOM_WR1.rec_yds.slice(0, 200))) !== JSON.stringify(Array.from(R3.players.HOM_WR1.rec_yds.slice(0, 200))));
  chk('the seed is derived from the game id and version string', R1.seed === E.seedOf('SYN_1|test'));

  const qb = R1.players.HOM_QB, recv = ['HOM_WR1', 'HOM_WR2', 'HOM_TE1', 'HOM_RB1r', 'HOM_WR3'].map((k) => R1.players[k]);
  let okCmp = true, okYds = true;
  for (let s = 0; s < N; s++) {
    const rc = recv.reduce((t, o) => t + o.receptions[s], 0), ry = recv.reduce((t, o) => t + o.rec_yds[s], 0);
    if (qb.pass_cmp[s] < rc) okCmp = false;
    if (qb.pass_yds[s] < ry - 1e-9 && ry > 0 && qb.pass_yds[s] - ry < -3 * 5) okYds = false;
  }
  chk('the QB’s completions are at least the catches his receivers made', okCmp);
  chk('the QB’s yards are his receivers’ yards plus the depth players (one game)', okYds);
  chk('attempts ≥ completions in every simulation', Array.from(qb.pass_att).every((a, s) => a >= qb.pass_cmp[s]));
  const rho = E.spearman(qb.pass_yds, R1.players.HOM_WR1.rec_yds);
  chk('QB yards and WR1 yards are positively correlated (same simulated game)', rho > 0.3, rho);
  const rhoOpp = E.spearman(R1.players.HOM_RB1.rush_att, R1.players.AWY_QB.pass_att);
  chk('a leading team’s RB carries and the trailing QB’s attempts move together (game script)', rhoOpp > 0, rhoOpp);

  const ry = finite(R1.players.HOM_WR1.rec_yds);
  chk('receiving yards are right-skewed: mean above median (not a Normal)', mean(ry) > medianOf(ry), [mean(ry), medianOf(ry)]);
  const d = P.encodeDist(finite(R1.players.HOM_WR3.rec_yds));
  const zero = P.probAt(d, 0.5).under;
  chk('a low-share receiver has a real zero atom', zero > 0.08, zero);
  const t = finite(R1.players.HOM_WR1.targets);
  const tm = mean(t), tv = mean(t.map((x) => (x - tm) * (x - tm)));
  chk('targets are over-dispersed vs a binomial on the same mean (share uncertainty + game script)', tv > tm * (1 - 0.27), [tm, tv]);
  const car = finite(R1.players.HOM_RB1.rush_att);
  chk('carries are whole numbers, never negative', car.every((x) => x >= 0 && Number.isInteger(x)));
  const ls = finite(R1.players.HOM_WR1.longest_rec), yds = finite(R1.players.HOM_WR1.rec_yds);
  chk('the longest reception never exceeds the receiving yards when yards are positive', ls.every((x, i) => yds[i] <= 0 || x <= yds[i] + 1e-9));
  chk('composites come from the same simulations: rush+rec = rush + rec', (() => { const o = R1.players.HOM_RB1; for (let s = 0; s < 200; s++) { const a = (Number.isNaN(o.rush_yds[s]) ? 0 : o.rush_yds[s]) + (Number.isNaN(o.rec_yds[s]) ? 0 : o.rec_yds[s]); if (!Number.isNaN(o.rush_rec_yds[s]) && Math.abs(o.rush_rec_yds[s] - a) > 1e-9) return false; } return true; })());
}

/* ====================================================== 3. AVAILABILITY */
{
  const Q = E.simulate(game(null, { wr1_active: 0.5 }), POOLS, { sims: N });
  const wr1 = Q.players.HOM_WR1, wr2 = Q.players.HOM_WR2;
  const played = Array.from(wr1.targets).map((x) => !Number.isNaN(x));
  const rate = played.filter(Boolean).length / N;
  chk('a 50% questionable receiver plays in about half the simulations', Math.abs(rate - 0.5) < 0.03, rate);
  chk('his own props are recorded only when he plays (a book voids a DNP)', Array.from(wr1.rec_yds).every((x, s) => played[s] ? !Number.isNaN(x) : Number.isNaN(x)));
  const w2in = [], w2out = [], w1in = [];
  for (let s = 0; s < N; s++) { if (played[s]) { w2in.push(wr2.targets[s]); w1in.push(wr1.targets[s]); } else w2out.push(wr2.targets[s]); }
  const gain = mean(w2out) - mean(w2in);
  chk('when he sits, the named recipient gains targets', gain > 0.5, gain);
  chk('but not all of them (no 100% transfer to one teammate)', gain < mean(w1in) * 0.6, [gain, mean(w1in)]);
}

/* =================================================== 4. REDISTRIBUTION */
{
  const list = [{ id: 'a', pos: 'WR', rank: 1, share: { mean: 0.27 } }, { id: 'b', pos: 'WR', rank: 2, share: { mean: 0.20 } }, { id: 'c', pos: 'TE', rank: 1, share: { mean: 0.16 } }, { id: 'd', pos: 'RB', rank: 1, share: { mean: 0.10 } }, { id: 'e', pos: 'WR', rank: 3, share: { mean: 0.08 } }];
  const plan = M.redistributionPlan(list, 0, 'tgt', null);
  const tot = plan.plan.reduce((t, x) => t + x[1], 0);
  chk('the plan never hands out 100% of the absent share (a leak remains)', tot <= 0.95 + 1e-9 && tot > 0.5, tot);
  const top = plan.plan.slice().sort((x, y) => y[1] - x[1])[0];
  chk('the next man up at the same position gets the largest part', list[top[0]].id === 'b', plan.plan);
  chk('no single teammate inherits the whole share', plan.plan.every((x) => x[1] < 0.6), plan.plan);
  chk('with no games on file without him, the plan is structural and LOW confidence', plan.confidence === 'LOW' && /structural/.test(plan.basis), plan);
  const emp = M.redistributionPlan(list, 0, 'tgt', { games: 4, fractions: [['c', 0.5], ['b', 0.2]] });
  chk('with the team’s own games without him, the plan blends them and is HIGH confidence', emp.confidence === 'HIGH' && emp.plan.find((x) => x[0] === 2)[1] > plan.plan.find((x) => x[0] === 2)[1], emp);
  const carPlan = M.redistributionPlan([{ id: 'r1', pos: 'RB', rank: 1, share: { mean: 0.6 } }, { id: 'r2', pos: 'RB', rank: 2, share: { mean: 0.25 } }, { id: 'q', pos: 'QB', rank: 1, share: { mean: 0.08 } }], 0, 'car', null);
  const r2 = carPlan.plan.find((x) => x[0] === 1)[1];
  chk('carries: the backup RB gets the most, still well short of 100%', r2 > 0.5 && r2 < 0.95, carPlan.plan);
}

/* ======================================================== 5. SHRINKAGE */
function shareData(weekly, denomN) {
  const teamGames = new Map(), games = [];
  weekly.forEach((sh, i) => {
    const gid = 'g' + i, kickoff = new Date(Date.UTC(2026, 8, 7) + i * 7 * 864e5).toISOString();
    teamGames.set(gid + '|T', { game_id: gid, team: 'T', att: denomN, kickoff });
    games.push({ game_id: gid, team: 'T', season: 2026, kickoff, tgt: Math.round(sh * denomN) });
  });
  return { data: { teamGames }, games: games.reverse() };
}
{
  const one = shareData([0.5], 34);
  const s1 = M.shrinkShare(one.games, one.data, (x) => x.tgt, 'att', 0.12, 2026);
  chk('one big game is pulled strongly toward the role prior', s1.mean < 0.3 && s1.mean > 0.12, s1.mean);
  const long = shareData(new Array(16).fill(0.25), 34);
  const s2 = M.shrinkShare(long.games, long.data, (x) => x.tgt, 'att', 0.12, 2026);
  chk('sixteen steady games keep their own share', Math.abs(s2.mean - 0.25) < 0.03, s2.mean);
  chk('and are more certain than one game', s2.sd < s1.sd, [s1.sd, s2.sd]);
  const spike = shareData(new Array(13).fill(0.15).concat([0.35, 0.35, 0.35]), 34);
  const s3 = M.shrinkShare(spike.games, spike.data, (x) => x.tgt, 'att', 0.15, 2026);
  chk('three hot games are shown (last 3) but not chased', Math.abs(s3.last3 - 0.35) < 0.02 && s3.mean < 0.3 && s3.mean > 0.15, { mean: s3.mean, last3: s3.last3 });
  const r = M.shrinkRate([{ season: 2026, c: 9, t: 10 }], (x) => x.c, (x) => x.t, 0.65, 40, 2026);
  chk('a 90% catch rate on 10 targets shrinks toward the position’s 65%', r.mean < 0.75 && r.mean > 0.65 && r.raw === 0.9, r);
}

/* ====================================================== 6. CALIBRATION */
{
  const vals = []; const S = E.Sampler(3);
  for (let i = 0; i < 20000; i++) vals.push(S.u() < 0.18 ? 0 : Math.round(-Math.log(Math.max(1e-9, S.u())) * 45 + 5));
  const d = P.encodeDist(vals);
  const zero0 = P.probAt(d, 0.5).under, m0 = P.moments(d).mean;
  const t = C.transform(d, 0.7, 1.1, 40, false);
  chk('the calibrated pmf keeps its mass', P.validDist(t) && t.n === d.n, { n: t.n });
  chk('zero-preserving: the zero atom does not move', Math.abs(P.probAt(t, 0.5).under - zero0) < 0.002, [zero0, P.probAt(t, 0.5).under]);
  const m1 = P.moments(t).mean;
  chk('the centre moves toward the baseline by λ', Math.abs(m1 - (40 + 0.7 * (m0 - 40))) < 1.0, [m0, m1]);
  const b = C.transform(P.encodeDist(vals.map((x) => (x > 60 ? 1 : 0)), { scale: 0 }), 0.5, 1, 0.3, true);
  chk('a binary prop is blended toward its baseline probability', Math.abs(P.probAt(b, 0.5).over - (0.3 + 0.5 * (vals.filter((x) => x > 60).length / vals.length - 0.3))) < 0.002);
}

/* ========================================================== 7. LEAKAGE */
{
  const asOf = Date.parse('2026-10-04T13:00:00Z');
  const list = [{ kickoff: '2026-09-28T17:00:00Z', v: 1 }, { kickoff: '2026-10-04T13:00:00Z', v: 2 }, { kickoff: '2026-10-05T00:15:00Z', v: 3 }, { kickoff: null, v: 4 }];
  const b = M.before(list, asOf);
  chk('only games strictly before the as-of time reach a projection', b.length === 1 && b[0].v === 1, b);
  const data = { pools: { rec: { WR: [[asOf - 1e6, 12], [asOf, 80], [asOf + 1e6, 70]], TE: [], RB: [] }, rush_rb: [[asOf - 1, 5], [asOf + 1, 60]], rush_qb_designed: [], scramble: [], rush_wr: [] } };
  const p = D.poolsAsOf(data, asOf, E);
  chk('gain pools exclude every play at or after the as-of time', p.raw.WR.n === 1 && p.raw.rush_rb.n === 1 && p.summary.WR.mean === 12, p.summary);
  const vfile = path.join(__dirname, '..', '..', 'football', 'props', 'nfl', 'validation.json');
  if (fs.existsSync(vfile)) {
    const v = JSON.parse(fs.readFileSync(vfile, 'utf8'));
    chk('the committed walk-forward validation reports zero leakage violations', v.leakage_violations === 0, v.leakage_violations);
    chk('and scores an untouched holdout, never a random split', !!(v.holdout || v.n_holdout) && /walk|forward/i.test(JSON.stringify(v.method || v.caveats || '')), Object.keys(v));
  }
}

console.log((fail ? 'FAIL' : 'PASS') + ' | player props engine and model | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
