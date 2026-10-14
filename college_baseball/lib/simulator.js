'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the inning-level game simulator (Model 5).

   One simulated game, inning by inning:
     - the scheduled length is drawn: seven innings with the measured
       doubleheader share, otherwise nine (never a seven priced as a nine);
     - each half-inning's runs are drawn from the MEASURED half-inning shape
       (play-by-play/linescore 2017-2022), scaled to the batting side's rate
       against whoever is pitching: the starter until his drawn outing length
       is used up, then the bullpen (factors from the pitcher engines; 1 for a
       team-only price);
     - the home side does not bat in the last scheduled inning when ahead;
     - a walk-off ends the game at once, with the measured walk-off margin
       (the home side stops scoring when it takes the lead);
     - a ten-run lead after seven (or eight) complete innings ends the game
       only with the MEASURED probability for the game's context;
     - extra innings start with the bases empty (rule R07, supported by the
       measured extra-inning scoring) and continue until decided.
   The per-inning rates are calibrated so the simulated mean of each side's
   runs equals the run model's expectation (one short pilot run per game).

   Outputs the joint distribution of final runs, innings, first-five runs and
   starter/bullpen innings; markets are priced from it in lib/pricing.js.
   Deterministic: a seed fixes every draw.
   =========================================================================== */
const S = require('../../engine/stats');
const D = require('./distribution');

const MAX_INN = 20;

/* the half-inning sampler: a scaled copy of the measured shape, as a CDF */
function samplerFactory(shape) {
  const cache = new Map();
  return (scale) => {
    const k = Math.round(scale * 200);
    if (cache.has(k)) return cache.get(k);
    const pmf = D.halfInningPmf(shape, k / 200);
    const cdf = []; let c = 0; for (const p of pmf) { c += p; cdf.push(c); }
    cdf[cdf.length - 1] = 1;
    cache.set(k, cdf);
    return cdf;
  };
}
function draw(cdf, u) { let i = 0; while (i < cdf.length - 1 && u > cdf[i]) i++; return i; }

/* Gamma(k, 1/k) (mean 1) by Marsaglia-Tsang */
function gammaDraw(k, rand) {
  if (!(k > 0) || !isFinite(k)) return 1;
  if (k < 1) return gammaDraw(k + 1, rand) * Math.pow(rand(), 1 / k);
  const d = k - 1 / 3; const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x; let v; do { x = normalDraw(rand); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v / k;
  }
}
function normalDraw(rand) { let u = 0; let v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/**
 * simulate(game, constants, opts)
 * game: { lh, la,                       nine-inning run expectations (the run model's)
 *         p7,                           probability the game is scheduled for seven
 *         run_rule_p,                   probability a 10-run lead after 7 ends it (measured, by context)
 *         home_staff: {starter_outs, starter_outs_sd, starter_factor, bullpen_factor},
 *         away_staff: {...} }           factors multiply the OPPONENT's scoring rate
 * opts: { n, seed, calibrate }
 */
function simulate(game, constants, opts) {
  opts = Object.assign({ n: 5000, seed: 20261013, calibrate: true }, opts || {});
  const share = constants.run_share_by_inning.slice(0, 8);
  const s9 = share.reduce((a, b) => a + b, 0) / 8;              // the ninth as an average full inning (its measured share is depressed by unplayed halves)
  const shares = share.concat([s9]); const shSum = shares.reduce((a, b) => a + b, 0);
  const inningW = shares.map((x) => x / shSum * 9);             // per-inning weight, mean 1
  const regShape = constants.half_inning.regulation; const exShape = constants.half_inning.extra;
  const shapeMean = regShape.reduce((a, v, i) => a + v * i, 0); const exMean = exShape.reduce((a, v, i) => a + v * i, 0);
  const regS = samplerFactory(regShape); const exS = samplerFactory(exShape);
  const wo = constants.walkoff.margin; const woCdf = []; { let c = 0; const t = wo.slice(1).reduce((a, b) => a + b, 0); for (let i = 1; i < wo.length; i++) { c += wo[i] / t; woCdf.push(c); } }
  const hs = Object.assign({ starter_outs: 12.5, starter_outs_sd: 5.7, starter_factor: 1, bullpen_factor: 1 }, game.home_staff || {});
  const as = Object.assign({ starter_outs: 12.5, starter_outs_sd: 5.7, starter_factor: 1, bullpen_factor: 1 }, game.away_staff || {});

  const run = (n, seed, kh, ka, collect) => {
    const rand = S.rng(seed);
    const res = { home: new Float64Array(41), away: new Float64Array(41), joint: new Map(), innings: new Float64Array(MAX_INN + 1), f5home: new Float64Array(41), f5away: new Float64Array(41), f5joint: new Map(),
      starterOutsHome: 0, starterOutsAway: 0, sumH: 0, sumA: 0, walkoffs: 0, runRule: 0, seven: 0, n };
    for (let it = 0; it < n; it++) {
      const sched = rand() < (game.p7 || 0) ? 7 : 9; if (sched === 7) res.seven++;
      /* game-level variation the innings do not carry: a shared factor (park-day, weather, umpire)
         and one per side (lineup, form); their sizes are calibrated to the measured game dispersion */
      const fr = game.frailty || {};
      const gS = gammaDraw(fr.shared_k, rand); const gH = gammaDraw(fr.team_k, rand) * gS; const gA = gammaDraw(fr.team_k, rand) * gS;
      const sOutsH = Math.max(0, Math.min(3 * sched, Math.round(hs.starter_outs + hs.starter_outs_sd * normalDraw(rand))));   // home starter (pitches to away)
      const sOutsA = Math.max(0, Math.min(3 * sched, Math.round(as.starter_outs + as.starter_outs_sd * normalDraw(rand))));
      let H = 0; let A = 0; let f5h = 0; let f5a = 0; let inn = 0; let outsH = 0; let outsA = 0;
      let ended = false;
      for (inn = 1; inn <= MAX_INN && !ended; inn++) {
        const extra = inn > sched;
        const w = extra ? 1 : (sched === 9 ? inningW[inn - 1] : inningW[Math.min(inn - 1, 8)]);
        /* top: away bats against the home staff */
        const phaseH = outsH + 3 <= sOutsH ? hs.starter_factor : (outsH >= sOutsH ? hs.bullpen_factor : (hs.starter_factor * (sOutsH - outsH) + hs.bullpen_factor * (outsH + 3 - sOutsH)) / 3);
        const rateA = ka * game.la / 9 * w * phaseH * gA;
        const ra = draw(extra ? exS(rateA / exMean) : regS(rateA / shapeMean), rand());
        A += ra; outsH += 3; if (inn <= 5) f5a += ra;
        /* bottom: home bats unless already ahead in the last scheduled inning or later */
        if (inn >= sched && H > A) { ended = true; break; }
        /* run rule after the top of 7/8 with the home side up 10 */
        if ((inn === 7 || inn === 8) && inn < sched && H - A >= 10 && rand() < (game.run_rule_p || 0)) { res.runRule++; ended = true; break; }
        const phaseA = outsA + 3 <= sOutsA ? as.starter_factor : (outsA >= sOutsA ? as.bullpen_factor : (as.starter_factor * (sOutsA - outsA) + as.bullpen_factor * (outsA + 3 - sOutsA)) / 3);
        const rateH = kh * game.lh / 9 * w * phaseA * gH;
        let rh = draw(extra ? exS(rateH / exMean) : regS(rateH / shapeMean), rand());
        if (inn >= sched && H + rh > A) {
          /* walk-off: the home side stops once ahead, by the measured margin */
          const need = A - H + 1; const m = Math.min(rh - (A - H), 1 + draw(woCdf, rand()));
          rh = Math.max(need, A - H + m); H += rh; if (inn <= 5) f5h += rh; outsA += 3; res.walkoffs++; ended = true; break;
        }
        H += rh; outsA += 3; if (inn <= 5) f5h += rh;
        if (inn >= sched && H !== A) { ended = true; break; }
        if ((inn === 7 || inn === 8) && inn < sched && Math.abs(H - A) >= 10 && rand() < (game.run_rule_p || 0)) { res.runRule++; ended = true; break; }
      }
      const played = Math.min(MAX_INN, inn);
      res.innings[played]++;
      res.sumH += H; res.sumA += A;
      res.home[Math.min(40, H)]++; res.away[Math.min(40, A)]++;
      if (collect) {
        const k = Math.min(40, H) * 41 + Math.min(40, A); res.joint.set(k, (res.joint.get(k) || 0) + 1);
        const k5 = Math.min(40, f5h) * 41 + Math.min(40, f5a); res.f5joint.set(k5, (res.f5joint.get(k5) || 0) + 1);
        res.f5home[Math.min(40, f5h)]++; res.f5away[Math.min(40, f5a)]++;
        res.starterOutsHome += Math.min(sOutsH, outsH); res.starterOutsAway += Math.min(sOutsA, outsA);
      }
    }
    return res;
  };
  let kh = 1; let ka = 1;
  /* the run model's expectations already contain the league's usual share of
     seven-inning games; this game's own seven-inning probability moves its target */
  const f7 = constants.seven_inning_factor || 0.77; const base7 = constants.scheduled_seven_share || 0;
  const lenAdj = (1 - (game.p7 || 0) + (game.p7 || 0) * f7) / (1 - base7 + base7 * f7);
  const tH = game.lh * lenAdj; const tA = game.la * lenAdj;
  if (opts.calibrate) {
    /* the run model's expectation is of FINAL runs; scale the per-inning rates so the simulated means match */
    for (let pass = 0; pass < 2; pass++) {
      const pilot = run(Math.max(1500, Math.floor(opts.n / 3)), opts.seed + 7 + pass, kh, ka, false);
      kh *= tH / Math.max(0.05, pilot.sumH / pilot.n); ka *= tA / Math.max(0.05, pilot.sumA / pilot.n);
    }
  }
  const res = run(opts.n, opts.seed, kh, ka, true);
  return summarise(res, { kh, ka });
}

function summarise(res, scale) {
  const n = res.n;
  let pH = 0; const joint = []; const f5 = [];
  for (const [k, c] of res.joint) { const h = Math.floor(k / 41); const a = k % 41; joint.push([h, a, c / n]); if (h > a) pH += c / n; }
  for (const [k, c] of res.f5joint) f5.push([Math.floor(k / 41), k % 41, c / n]);
  return {
    n, p_home: pH, se_p_home: Math.sqrt(pH * (1 - pH) / n), joint, f5_joint: f5,
    mean_home: res.sumH / n, mean_away: res.sumA / n,
    innings: Array.from(res.innings).map((c) => c / n),
    walkoff_share: res.walkoffs / n, run_rule_share: res.runRule / n, seven_share: res.seven / n,
    starter_outs_home: res.starterOutsHome / n, starter_outs_away: res.starterOutsAway / n,
    scale,
  };
}

module.exports = { simulate, samplerFactory, gammaDraw, MAX_INN };
