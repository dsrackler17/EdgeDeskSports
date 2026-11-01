#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY T3 model and market comparison — unit suite (synthetic).

     prior      the registered blend, coach shrink, roster-only / carried-only,
                tempo with a coach history, the engine variance x multiplier
     weights    the registered decay table, interpolation, the variance scaling
     fit        recovers known ratings from many games; with none, the prior;
                a high-variance team leans on its games sooner
     project    margin, total, home term, neutral site, sd, win / cover / over
                probabilities, whole-number pushes
     point in   a projection never reads a final known after its time
     time
     market     de-vig, the best fresh price at its own line, Edge, the
                reference (Pinnacle else consensus), thin and stale flags
     tiers      HIGH / MEDIUM / LOW / PASS as registered, angle tags
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const M = require('../model');
const MK = require('../market');
const PJ = require('../project');
const FE = require('../features');

let pass = 0, fail = 0; const fails = [];
const chk = (label, ok, detail) => { if (ok) pass++; else { fail++; fails.push(label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } };
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e || 1e-9);
const cfg = FE.loadConfig();
const engine = require('../../ncaam_forecast/config/selection_v1.json').chosen;
const state = { s2: 11000, lambda: 300 };

/* ── prior ─────────────────────────────────────────────────────────────── */
{
  const f = { roster_off: 4, roster_def: 2, coach_change: false, returning_minutes_share: 0.6, variance_multiplier: 1.5, coach_tempo_resid: null };
  const prev = { off: 6, allow: -3, tempo: 2 };
  const p = M.preseasonPrior(f, prev, state, cfg, engine);
  chk('prior: (1 - w) x carry x last season + w x roster build, w = 0.5', near(p.off, 0.5 * 0.9 * 6 + 0.5 * 4) && near(p.allow, 0.5 * 0.9 * -3 + 0.5 * -2));
  chk('prior: the roster\'s defence lowers points allowed (allow = -roster_def)', p.allow < 0.5 * 0.9 * -3);
  chk('prior: variance per side = s2 / lambda x the variance multiplier', near(p.var_side, (11000 / 300) * 1.5));
  chk('prior: tempo = carry_tempo x last season without a coach history', near(p.tempo, 0.9 * 2) && p.tempo_coach_shift === 0);
  const pc = M.preseasonPrior(Object.assign({}, f, { coach_change: true, coach_tempo_resid: 6 }), prev, state, cfg, engine);
  const w = 0.5 + 0.5 * 0.15;
  chk('prior: a coaching change shrinks the carried part further (coach_shrink 0.15)', near(pc.roster_weight, w) && near(pc.off, (1 - w) * 0.9 * 6 + w * 4));
  chk('prior: the coach\'s tempo history is blended by (1 - returning minutes)', near(pc.tempo, 0.6 * 1.8 + 0.4 * 6) && near(pc.tempo_coach_shift, pc.tempo - 1.8));
  const ro = M.preseasonPrior(f, null, state, cfg, engine);
  chk('prior: no last season -> the roster build alone, flagged', near(ro.off, 4) && ro.flags.some((x) => /NO_PRIOR_SEASON_RATING/.test(x)));
  chk('prior: neither -> no prior (null)', M.preseasonPrior({ roster_off: null }, null, state, cfg, engine) === null);
}

/* ── weights ───────────────────────────────────────────────────────────── */
{
  chk('weights: the registered table at its points (0:1, 3:0.65, 6:0.45, 9:0.25, 12:0.12, 15:0.05)', [[0, 1], [3, 0.65], [6, 0.45], [9, 0.25], [12, 0.12], [15, 0.05]].every(([g, w]) => near(M.priorWeight(g, 1, cfg).w, w)));
  chk('weights: linear between points; held at 0.05 after 15', near(M.priorWeight(4, 1, cfg).w, 0.65 - 0.2 / 3) && near(M.priorWeight(30, 1, cfg).w, 0.05));
  const a = M.priorWeight(3, 1, cfg).w_eff, b = M.priorWeight(3, 2, cfg).w_eff;
  chk('weights: a variance multiplier of 2 halves the prior\'s precision: w / (w + 2 (1 - w))', near(b, 0.65 / (0.65 + 2 * 0.35)) && b < a && near(a, 0.65));
  chk('weights: before any game the prior is all there is', M.priorWeight(0, 3, cfg).w_eff === 1);
}

/* ── fit ───────────────────────────────────────────────────────────────── */
function synthSeason(nTeams, gamesEach, seed, truth) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const L = { mu: 105, eta: 2, tau: 68 };
  const games = []; let t = Date.parse('2025-11-04T00:00:00Z');
  for (let r = 0; r < gamesEach; r++) for (let i = 0; i < nTeams; i++) {
    const j = (i + 1 + r * 7) % nTeams; if (i === j) continue;
    const h = truth[i], a = truth[j];
    const poss = 68 + h.tempo + a.tempo;
    const yH = L.mu + h.off + a.allow + L.eta + gauss() * 10, yA = L.mu + a.off + h.allow - L.eta + gauss() * 10;
    games.push({ home: i, away: j, neutral: false, yH, yA, poss, tempo: poss, start_ms: t, known_ms: t + 4 * 3600e3 }); t += 3600e3;
  }
  return { games, L };
}
{
  const N = 40; const truth = Array.from({ length: N }, (_, i) => ({ off: ((i * 37) % 17) - 8, allow: ((i * 23) % 13) - 6, tempo: ((i * 11) % 7) - 3 }));
  const { games, L } = synthSeason(N, 30, 7, truth);
  const priors = new Map(truth.map((t, i) => [i, { off: 0, allow: 0, tempo: 0, vm: 1, var_side: 36 }]));
  const R = M.fitSeason(priors, games, L, cfg);
  const err = truth.reduce((a, t, i) => a + Math.abs(R.get(i).off - t.off) + Math.abs(R.get(i).allow - t.allow), 0) / (2 * N);
  chk('fit: 30 games a team recover the true ratings from a flat prior (mean abs error < 2 points per 100)', err < 2, err);
  const corr = (() => { const x = truth.map((t) => t.off - t.allow), y = truth.map((_, i) => R.get(i).off - R.get(i).allow); const mx = x.reduce((a, b) => a + b) / N, my = y.reduce((a, b) => a + b) / N;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < N; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); })();
  chk('fit: the fitted net ratings track the truth (correlation > 0.95)', corr > 0.95, corr);
  chk('fit: tempo is recovered too', truth.every((t, i) => Math.abs(R.get(i).tempo - t.tempo) < 1.5));
  chk('fit: after 15+ games the prior keeps the registered 0.05 and the variance shrinks with it', near(R.get(0).w_prior, 0.05) && near(R.get(0).var_side, 0.05 * 36));
  const none = M.fitSeason(priors, [], L, cfg);
  chk('fit: with no games, the prior unchanged', none.get(3).off === 0 && none.get(3).w_prior === 1);
  /* a high-variance team leans on its games sooner */
  const few = games.filter((g) => g.home === 0 || g.away === 0).slice(0, 3).concat(games.filter((g) => g.home !== 0 && g.away !== 0));
  const lowV = new Map(priors); lowV.set(0, { off: 0, allow: 0, tempo: 0, vm: 1, var_side: 36 });
  const hiV = new Map(priors); hiV.set(0, { off: 0, allow: 0, tempo: 0, vm: 3, var_side: 108 });
  const r1 = M.fitSeason(lowV, few, L, cfg).get(0), r3 = M.fitSeason(hiV, few, L, cfg).get(0);
  chk('fit: after 3 games a high-variance (vm 3) team has moved further from its prior than a low-variance one', Math.abs(r3.off - r3.allow) > Math.abs(r1.off - r1.allow) && r3.w_prior < r1.w_prior, [r1.off - r1.allow, r3.off - r3.allow]);
}

/* ── project ───────────────────────────────────────────────────────────── */
{
  const L = { mu: 105, eta: 2.25, tau: 68 };
  const h = { off: 5, allow: -2, tempo: 1, var_side: 10 }, a = { off: 0, allow: 1, tempo: -1, var_side: 10 };
  const p = M.project(h, a, false, L, cfg);
  const yH = 105 + 5 + 1 + 2.25, yA = 105 + 0 - 2 - 2.25, poss = 68;
  chk('project: points per 100 x possessions, the home term on both sides', near(p.margin, ((yH - yA) * poss) / 100) && near(p.total, ((yH + yA) * poss) / 100) && near(p.possessions, 68));
  chk('project: fair spread is minus the margin', near(p.fair_spread_home, -p.margin));
  const n = M.project(h, a, true, L, cfg);
  chk('project: on a neutral floor the margin drops by 2 x eta x poss / 100', near(p.margin - n.margin, (2 * 2.25 * 68) / 100));
  chk('project: sd = sqrt(base^2 + 2 (var_h + var_a) (poss/100)^2), base 11 / 16', near(p.sd_margin, Math.sqrt(121 + 2 * 20 * 0.68 * 0.68)) && near(p.sd_total, Math.sqrt(256 + 2 * 20 * 0.68 * 0.68)));
  chk('project: win probability = Phi(margin / sd), and symmetric', near(p.win_prob_home, M.Phi(p.margin / p.sd_margin)) && near(M.project(a, h, true, L, cfg).win_prob_home, 1 - n.win_prob_home, 1e-6));
  const c = M.coverProb(p, -p.margin);
  chk('cover: at the fair spread both sides are 50%', near(c.home_cover, 0.5, 1e-6));
  const w = M.coverProb(p, -7);
  chk('cover: a whole-number line reports its push mass, and the sides add to 1 given no push', w.push > 0 && near(w.home_cover + w.away_cover, 1) && M.coverProb(p, -6.5).push === 0);
  const o = M.overProb(p, p.total - 5);
  chk('over: 5 points under the fair total the over is favoured', o.over > 0.5 && near(o.over + o.under, 1));
}

/* ── point in time ──────────────────────────────────────────────────────── */
{
  const N = 10; const truth = Array.from({ length: N }, (_, i) => ({ off: i - 5, allow: 0, tempo: 0 }));
  const { games, L } = synthSeason(N, 6, 3, truth);
  const priors = new Map(truth.map((t, i) => [i, { off: 0, allow: 0, tempo: 0, vm: 1, var_side: 36 }]));
  const target = games[30];
  const tgt = { game_id: 'x', home_team_id: target.home, away_team_id: target.away, neutral: false, start_utc: new Date(target.start_ms).toISOString() };
  const r1 = PJ.projectGames([tgt], { priors, finals: games, league: L }, cfg)[0];
  const r2 = PJ.projectGames([tgt], { priors, finals: games.filter((g) => g.known_ms <= target.start_ms - 30 * 60e3), league: L }, cfg)[0];
  chk('point in time: a projection is identical whether or not later finals exist (no leakage)', r1.status === 'PROJECTED' && near(r1.margin, r2.margin) && r1.finals_used === r2.finals_used);
  chk('point in time: inputs_known_through is before the projection time', Date.parse(r1.inputs_known_through) <= Date.parse(r1.projected_for));
  chk('point in time: the target game itself is never an input', r1.finals_used < games.indexOf(target) + 1);
  const np = PJ.projectGames([Object.assign({}, tgt, { home_team_id: 999 })], { priors, finals: games, league: L }, cfg)[0];
  chk('a team without a prior is not projected, with the reason', np.status === 'NOT_PROJECTED' && /home team has no prior/.test(np.reason));
}

/* ── market ────────────────────────────────────────────────────────────── */
{
  const d = MK.devig(-110, -110);
  chk('devig: -110/-110 is 50/50 with a 4.76% overround', near(d.a, 0.5) && near(d.overround, 2 * 110 / 210 - 1));
  const p = M.project({ off: 5, allow: -2, tempo: 0, var_side: 10 }, { off: 0, allow: 1, tempo: 0, var_side: 10 }, false, { mu: 105, eta: 2.25, tau: 68 }, cfg);
  const now = '2026-11-10T20:00:00Z';
  const q = (book, line, a, b, mins, extra) => Object.assign({ book, line, price_a: a, price_b: b, captured_at: new Date(Date.parse(now) - mins * 60e3).toISOString() }, extra || {});
  const quotes = [q('DraftKings', -4.5, -110, -110, 10), q('FanDuel', -5.5, -105, -115, 20), q('Pinnacle', -5, -108, -102, 5), q('Bovada', -3, -110, -110, 200)];
  const c = MK.compare('spread', p, quotes, now, cfg);
  const home = c.sides.find((s) => s.side === 'a');
  const expectEdge = (line, am) => M.coverProb(p, line).home_cover * MK.decimalFromAmerican(am) - 1;
  chk('compare: each side\'s best FRESH price, priced at its own line (the 200-minute quote is ignored)', home.book !== 'Bovada' && near(home.edge, Math.max(expectEdge(-4.5, -110), expectEdge(-5.5, -105), expectEdge(-5, -108))));
  chk('compare: the reference is Pinnacle when captured, with its capture time', c.reference.basis === 'pinnacle' && c.reference.book === 'Pinnacle' && c.reference.captured_at === quotes[2].captured_at);
  chk('compare: three fresh books is not thin', c.thin === false && c.flags.length === 0);
  const c2 = MK.compare('spread', p, quotes.filter((x) => x.book !== 'Pinnacle'), now, cfg);
  chk('compare: without Pinnacle, the consensus of the books at the modal line', c2.reference.basis === 'consensus' && /consensus of/.test(c2.reference.book));
  const c3 = MK.compare('spread', p, quotes.slice(0, 2), now, cfg);
  chk('compare: fewer than 3 fresh books is thin', c3.thin === true && c3.flags.includes('THIN_FEWER_THAN_3_BOOKS'));
  const c4 = MK.compare('spread', p, [quotes[3]], now, cfg);
  chk('compare: only stale prices -> no side, flagged STALE_PRICE', c4.sides.length === 0 && c4.flags.includes('STALE_PRICE'));
  const k = MK.compare('moneyline', p, [q('Kalshi', null, -200, 170, 5, { volume: 120 })], now, cfg);
  chk('compare: a Kalshi market under 500 contracts is thin', k.thin === true && k.flags.includes('THIN_KALSHI_VOLUME'));
  const ml = MK.compare('moneyline', p, [q('DraftKings', null, -200, 170, 5), q('FanDuel', null, -190, 160, 5), q('Pinnacle', null, -195, 175, 5)], now, cfg);
  chk('compare: moneyline uses the win probability', near(ml.sides.find((s) => s.side === 'a').p_model, p.win_prob_home));
}

/* ── tiers ─────────────────────────────────────────────────────────────── */
{
  const x = (o) => Object.assign({ var_home: 5, var_away: 5, cap: 10, angles: ['continuity_gap'], thin: false, stale: false }, o);
  chk('tier: edge 3% + both variances under the cap + a non-price angle -> HIGH', MK.conviction(0.031, x({}), cfg) === 'HIGH');
  chk('tier: edge 3% with a variance above the cap -> MEDIUM', MK.conviction(0.031, x({ var_home: 20 }), cfg) === 'MEDIUM');
  chk('tier: edge 3% price-only -> MEDIUM', MK.conviction(0.031, x({ angles: ['price_only'] }), cfg) === 'MEDIUM');
  chk('tier: edge 1.5-3% with an angle -> MEDIUM; price-only -> LOW (the conservative reading)', MK.conviction(0.02, x({}), cfg) === 'MEDIUM' && MK.conviction(0.02, x({ angles: ['price_only'] }), cfg) === 'LOW');
  chk('tier: edge 0.5-1.5% -> LOW', MK.conviction(0.01, x({}), cfg) === 'LOW');
  chk('tier: under 0.5%, a thin market or a stale price -> PASS', MK.conviction(0.004, x({}), cfg) === 'PASS' && MK.conviction(0.05, x({ thin: true }), cfg) === 'PASS' && MK.conviction(0.05, x({ stale: true }), cfg) === 'PASS');
  chk('variance cap: the 60th percentile', near(MK.varianceCap([1, 2, 3, 4, 5, 6]), 4));
  const f = (o) => Object.assign({ returning_minutes_share: 0.5, returning_value_share: 0.6, minutes_share_transfer_d1: 0, minutes_share_non_d1: 0, translation_shift: 0, coach_change: false, height_in_avg: 77 }, o);
  chk('angles: none of the registered conditions -> price_only', MK.angleTags(f({}), f({}), { tempo_coach_shift: 0 }, { tempo_coach_shift: 0 }).join() === 'price_only');
  const tags = MK.angleTags(f({ returning_minutes_share: 0.8, minutes_share_transfer_d1: 0.3, translation_shift: -2, coach_change: true, returning_value_share: 0.4, height_in_avg: 79 }), f({ returning_minutes_share: 0.4 }), { tempo_coach_shift: 2.5 }, null);
  chk('angles: every registered tag at its threshold', ['continuity_gap', 'transfer_translation', 'coach_change', 'departed_production', 'pace_coach_history', 'size_mismatch'].every((t) => tags.includes(t)) && !tags.includes('price_only'), tags);
}
const src = ['model.js', 'market.js', 'project.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
chk('scope: no stake or unit is returned anywhere, and the word "lock" appears nowhere', !/\bstake\s*:|units?\s*:/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')) && !/\block\b/i.test(src));

fails.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NCAAM-EARLY model — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
