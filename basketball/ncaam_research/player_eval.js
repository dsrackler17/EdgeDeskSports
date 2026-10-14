#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Does the player layer predict anything the team layer does not?

     node basketball/ncaam_research/player_eval.js          writes published/validation_player.json

   Possession data exists for 2026 only, so this validation is chronological
   INSIDE 2026, with fixed checkpoints:

     tuning   fit on games before 15 Jan 2026, score 15 Jan - 15 Feb
     holdout  fit on games before 15 Feb 2026, score 15 Feb - season end

   1. POSSESSION LEVEL. Each held-out possession is predicted from the ten
      players actually on the floor (known after the fact: this tests whether
      the impact estimates carry signal, not a pregame forecast):
        team_only        opponent-adjusted team offense/defense (same data)
        rapm_zero        ridge RAPM shrunk to zero
        rapm_box         ridge RAPM shrunk to the box-score prior
        rapm_box_prev    + last season's publisher RAPM as a prior feature
      Score: squared error per possession; paired differences against
      team_only with bootstrap intervals clustered by game. The penalty and the
      variant are chosen on the tuning window only.

   2. GAME LEVEL, availability known (ORACLE: after-the-fact box-score
      participation; there is no pregame availability feed). For games after
      15 Feb: the frozen team model's calibrated margin, then
        + scenario adjustment: absent rotation players' minutes redistributed
          (lib/ncaam_research.js) and priced with impacts fitted before 15 Feb
        + naive: subtract the absent players' points per game
      Also: how well the redistribution predicts teammates' actual minutes.

   3. STABILITY AND SENSITIVITY. Split-half (odd/even games) correlation of
      impact estimates; refits without disputed games, without garbage time
      and with half / double the penalty, compared with the primary fit.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const U = require('./lib/util');
const I = require('./ingest');
const ID = require('./identity');
const A = require('./audit');
const PM = require('./player_model');
const MN = require('./minutes');
const WF = require('./walkforward');
const TM = require('./team_model');
const { Additive } = require('./lib/additive');
const NR = require('../../lib/ncaam_research');

const T1 = Date.parse('2026-01-15T10:00:00Z');
const T2 = Date.parse('2026-02-15T10:00:00Z');
const LAMBDAS = [1000, 2000, 4000, 8000];

async function load() {
  const G = await I.loadGames(); const TG = await I.loadTeamGames(); const P = await I.loadPossessions(); const NP = await I.loadNcaaPlayerGames(); const PG = await I.loadPlayerGames(); const R = await I.loadRapm();
  const PQ = A.possessionGameQuality(P, TG); const X = ID.playerCrosswalk(NP.rows, PG.rows);
  const keep = (statuses, noGarbage) => (i) => {
    if (P.flags[i] || P.pts[i] < 0) return false; if (noGarbage && P.garbage[i]) return false;
    const g = G.byId.get(P.game[i]); if (!g || g.regime !== 'D1_D1') return false;
    const q = PQ.byGame.get(P.game[i]); return !!q && statuses.includes(q.status);
  };
  return { G, TG, P, NP, PG, R, PQ, X, keep };
}

/** last season's publisher RAPM for this season's NCAA ids: player_id -> person_id (2026 table, ids only) -> 2025 values */
function previousSeasonPrior(R, season) {
  const person = new Map(R[season].map((r) => [r.player_id, r.person_id]));
  const prev = new Map(R[season - 1].map((r) => [r.person_id, r]));
  const out = new Map();
  for (const [pid, per] of person) { const p = prev.get(per); if (p && p.off_poss > 0) out.set(pid, { o: p.orapm, d: p.drapm, poss: p.off_poss }); }
  return out;
}

function teamOnly(train) {
  const Ad = new Additive({ lambdaOff: 150, lambdaAllow: 150, kMu: 1e-6, kEta: 1e-6, sweeps: 30, center: true });
  const Ut = train.units;
  for (let u = 0; u < Ut.n; u++) Ad.add(Ut.offTeam[u], Ut.defTeam[u], Ut.pts[u] / Ut.cnt[u], Ut.cnt[u], Ut.v[u], 0);
  Ad.fit(0, null);
  return Ad;
}

function fitVariant(train, variant, lambda, box, prev) {
  if (variant === 'rapm_zero') return { fit: PM.fitRidge(train, lambda, null) };
  const f0 = PM.fitRidge(train, lambda, null);
  const bp = PM.fitBoxPrior(f0, train, box, variant === 'rapm_box_prev' ? prev : null);
  const prior = PM.priorMeans(train, box, variant === 'rapm_box_prev' ? prev : null, bp);
  return { fit: PM.fitRidge(train, lambda, prior, { x0: f0.x }), box_prior: bp };
}

function scoreWindow(B, D, fromMs, toMs, variants) {
  const gameStart = (g) => { const x = D.G.byId.get(g); return x ? x.start_ms : NaN; };
  const train = PM.subset(B, (u) => gameStart(B.units.game[u]) + C.AVAILABLE_AFTER_MS < fromMs);
  const test = PM.subset(B, (u) => { const s = gameStart(B.units.game[u]); return s >= fromMs && s < toMs; });
  const box = PM.boxRates(D.NP, fromMs); const prev = previousSeasonPrior(D.R, 2026);
  const res = {}; const perGame = {};
  const team = teamOnly(train);
  const tScore = PM.scoreUnits(test, (u) => team.predict(test.units.offTeam[u], test.units.defTeam[u], test.units.v[u]));
  res.team_only = { mse: tScore.mse, possessions: tScore.possessions }; perGame.team_only = tScore.byGame;
  for (const [variant, lambdas] of Object.entries(variants)) {
    for (const lam of lambdas) {
      const f = fitVariant(train, variant, lam, box, prev);
      const P = train.players.length;
      const sc = PM.scoreUnits(test, (u) => PM.predictUnit(test.units, u, f.fit.x, P));
      const k = variant + '@' + lam; res[k] = { mse: sc.mse, possessions: sc.possessions, box_prior_r2: f.box_prior ? { o: f.box_prior.r2_o, d: f.box_prior.r2_d } : null }; perGame[k] = sc.byGame;
    }
  }
  return { res, perGame, train_possessions: U.sum(Array.from(train.units.cnt)), test_possessions: U.sum(Array.from(test.units.cnt)) };
}

/** per-possession MSE difference (a - b) over the same games, bootstrap over games */
function diffCI(pgA, pgB) {
  const rows = []; for (const [g, a] of pgA) { const b = pgB.get(g); if (b) rows.push({ d: a.e - b.e, n: a.n }); }
  const est = U.sum(rows.map((r) => r.d)) / U.sum(rows.map((r) => r.n));
  const rand = U.rng(11); const stats = [];
  for (let k = 0; k < 1000; k++) { let d = 0; let n = 0; for (let i = 0; i < rows.length; i++) { const r = rows[Math.floor(rand() * rows.length)]; d += r.d; n += r.n; } stats.push(d / n); }
  stats.sort((x, y) => x - y);
  return { games: rows.length, mean_diff_per_possession: U.r(est, 3), ci95: [U.r(U.quantile(stats, 0.025), 3), U.r(U.quantile(stats, 0.975), 3)] };
}

/* ---------------------------------------------------------------- game-level availability test */
function availabilityTest(D, impacts, frozenRows, halfLife) {
  const byGame = new Map(frozenRows.filter((r) => r.season === 2026 && r.cal && r.start_ms >= T2).map((r) => [r.game_id, r]));
  const out = { games: 0, with_absence: 0 }; const rowsEval = [];
  const redistErr = { players: 0, ae_redistribute: 0, ae_no_redistribution: 0, ae_no_position: 0 };
  const book = MN.walkSeason(D.PG, 2026, halfLife, (rows, bk, team) => {
    const r = byGame.get(rows[0].game_id); if (!r) return;
    const rot = bk.rotation(team).filter((p) => p.games >= 3 && p.baseline_minutes > 0);
    if (!rot.length) return;
    const appeared = new Set(rows.filter((x) => !x.dnp && x.min > 0).map((x) => x.athlete));
    const actual = new Map(rows.map((x) => [x.athlete, x.dnp ? 0 : x.min || 0]));
    const rotation = rot.map((p) => {
      const pid = D.X.pidOf.get(p.athlete); const im = pid != null ? impacts.get(pid) : null;
      return { id: p.athlete, name: p.name, pos: p.pos, baseline: p.baseline_minutes, expected: p.expected_minutes, cap: p.cap, starter: p.start_rate > 0.5, o: im ? im.o : 0, d: im ? im.d : 0, sd_o: im ? im.sd_o : 2, sd_d: im ? im.sd_d : 2, ppg: p.per40.pts * p.season_mpg / 40, appearance_rate: p.appearance_rate };
    });
    const out_ = rotation.filter((p) => !appeared.has(p.id)).map((p) => p.id);
    const sc = NR.scenario(rotation, { out: out_ });
    const key = r.home === team ? 'home' : 'away';
    r.avail = r.avail || {}; r.avail[key] = { delta: sc.delta, out: out_, naive_ppg: U.sum(rotation.filter((p) => out_.includes(p.id)).map((p) => p.ppg || 0)), notable: rotation.some((p) => out_.includes(p.id) && p.expected >= 15 && p.appearance_rate >= 0.6) };
    if (rotation.some((p) => out_.includes(p.id) && p.expected >= 15 && p.appearance_rate >= 0.6)) {
      const flat = NR.redistribute(rotation.map((p) => Object.assign({}, p, { pos: null })), { out: out_ });
      const flatBy = new Map(flat.players.map((p) => [p.id, p.minutes]));
      for (const p of sc.minutes.players) {
        if (p.out || !appeared.has(p.id)) continue;
        const a = actual.get(p.id); const base = rotation.find((x) => x.id === p.id).expected;
        redistErr.players++; redistErr.ae_redistribute += Math.abs(a - p.minutes); redistErr.ae_no_redistribution += Math.abs(a - base); redistErr.ae_no_position += Math.abs(a - flatBy.get(p.id));
      }
    }
  });
  void book;
  for (const r of byGame.values()) {
    if (!r.avail || !r.avail.home || !r.avail.away) continue;
    out.games++;
    const h = r.avail.home; const a = r.avail.away; const poss = r.tempo || 68;
    const adj = ((h.delta.net - a.delta.net) * poss) / 100;
    const sdAdd = (poss / 100) * Math.sqrt(h.delta.sd_net ** 2 + a.delta.sd_net ** 2);
    const notable = h.notable || a.notable; if (notable) out.with_absence++;
    rowsEval.push({ game_id: r.game_id, day: Math.floor(r.day), notable, y: r.y.margin, base: { mu: r.cal.margin_mu, sd: r.cal.margin_sd }, scen: { mu: r.cal.margin_mu + adj, sd: Math.sqrt(r.cal.margin_sd ** 2 + sdAdd ** 2) }, naive: { mu: r.cal.margin_mu - h.naive_ppg + a.naive_ppg, sd: r.cal.margin_sd }, adj });
  }
  const summ = (rs) => {
    const f = (k) => ({ mae: U.r(U.mean(rs.map((x) => Math.abs(x.y - x[k].mu))), 3), crps: U.r(U.mean(rs.map((x) => U.crpsNormal(x[k].mu, x[k].sd, x.y))), 4), cov80: U.r(U.mean(rs.map((x) => (Math.abs(x.y - x[k].mu) <= 1.2816 * x[k].sd ? 1 : 0))), 4) });
    const cmp = (k) => U.clusteredDiffCI(rs, (x) => x.day, (x) => U.crpsNormal(x[k].mu, x[k].sd, x.y) - U.crpsNormal(x.base.mu, x.base.sd, x.y), { B: 1000 });
    return { n: rs.length, team_model: f('base'), with_scenario_adjustment: f('scen'), naive_ppg_subtraction: f('naive'), scenario_minus_team_crps: cmp('scen'), naive_minus_team_crps: cmp('naive'), mean_abs_adjustment: U.r(U.mean(rs.map((x) => Math.abs(x.adj))), 3) };
  };
  return {
    games_scored: out.games, all_games: summ(rowsEval), games_with_absent_rotation_player: summ(rowsEval.filter((x) => x.notable)),
    redistribution_minutes: { teammates_scored: redistErr.players, mae_redistribute_with_positions: U.r(redistErr.ae_redistribute / redistErr.players, 3), mae_redistribute_without_positions: U.r(redistErr.ae_no_position / redistErr.players, 3), mae_no_redistribution: U.r(redistErr.ae_no_redistribution / redistErr.players, 3) },
    caveat: 'availability is read from the box score after the game (oracle). No pregame availability feed exists, so this measures what correct availability would be worth, not what EdgeDesk could have known.',
  };
}

/* ---------------------------------------------------------------- stability and sensitivity */
function stability(D, B, lambda, box, prev) {
  const games = [...new Set(Array.from(B.units.game))].sort((a, b) => D.G.byId.get(a).start_ms - D.G.byId.get(b).start_ms);
  const odd = new Set(games.filter((_, i) => i % 2 === 0));
  const halves = [PM.subset(B, (u) => odd.has(B.units.game[u])), PM.subset(B, (u) => !odd.has(B.units.game[u]))];
  const out = {};
  const hb = [PM.boxRates(D.NP, null, (g) => odd.has(g)), PM.boxRates(D.NP, null, (g) => !odd.has(g))];
  for (const variant of ['rapm_zero', 'rapm_box']) {
    const fits = halves.map((h, k) => fitVariant(h, variant, lambda, hb[k], prev).fit);
    const ex = halves.map((h) => PM.exposure(h)); const P = B.players.length;
    const a = []; const b = [];
    for (let i = 0; i < P; i++) if (ex[0].offPoss[i] >= 400 && ex[1].offPoss[i] >= 400) { a.push(fits[0].x[i] + fits[0].x[P + i]); b.push(fits[1].x[i] + fits[1].x[P + i]); }
    out[variant] = { players: a.length, split_half_r_net: U.r(U.corr(a, b), 3) };
  }
  return out;
}

function sensitivity(D, primary, lambda, box, prev) {
  const P = primary.B.players.length; const base = primary.fit.x; const ex = PM.exposure(primary.B);
  const big = []; for (let i = 0; i < P; i++) if (ex.offPoss[i] >= 500) big.push(i);
  const top = (x) => new Set(big.slice().sort((i, j) => (x[j] + x[P + j]) - (x[i] + x[P + i])).slice(0, 50));
  const t0 = top(base);
  const compare = (name, B2, lam) => {
    const f = fitVariant(B2, 'rapm_box', lam, box, prev).fit;
    // align by NCAA id (B2 shares the player index when it is a subset; a rebuilt B2 may not)
    const idx = B2.index; const a = []; const b = []; const x2 = new Float64Array(2 * P);
    for (const i of big) { const j = idx.get(primary.B.players[i]); if (j == null) continue; a.push(base[i] + base[P + i]); b.push(f.x[j] + f.x[B2.players.length + j]); x2[i] = f.x[j]; x2[P + i] = f.x[B2.players.length + j]; }
    const t1 = top(x2); let ov = 0; for (const i of t0) if (t1.has(i)) ov++;
    return { name, players: a.length, corr_net_with_primary: U.r(U.corr(a, b), 4), top50_overlap: ov };
  };
  return [
    compare('exact_reconciled_games_only', PM.buildUnits(D.P, D.keep(['EXACT']), D.G.byId), lambda),
    compare('garbage_time_removed', PM.buildUnits(D.P, D.keep(['EXACT', 'WITHIN_3'], true), D.G.byId), lambda),
    compare('half_penalty', primary.B, lambda / 2),
    compare('double_penalty', primary.B, lambda * 2),
  ];
}

async function main() {
  const D = await load();
  const B = PM.buildUnits(D.P, D.keep(['EXACT', 'WITHIN_3']), D.G.byId);
  const variants = { rapm_zero: LAMBDAS, rapm_box: LAMBDAS, rapm_box_prev: LAMBDAS };
  console.log('units', B.units.n, 'players', B.players.length);
  const tuneW = scoreWindow(B, D, T1, T2, variants);
  const best = {}; for (const v of Object.keys(variants)) { let b = null; for (const lam of LAMBDAS) { const r = tuneW.res[v + '@' + lam]; if (!b || r.mse < b.mse) b = { lambda: lam, mse: r.mse }; } best[v] = b.lambda; }
  let chosen = null; for (const v of Object.keys(variants)) { const m = tuneW.res[v + '@' + best[v]].mse; if (!chosen || m < chosen.mse) chosen = { variant: v, lambda: best[v], mse: m }; }
  console.log('tuning', JSON.stringify(tuneW.res), 'chosen', JSON.stringify(chosen));
  const holdW = scoreWindow(B, D, T2, Infinity, Object.fromEntries(Object.entries(best).map(([v, l]) => [v, [l]])));
  const cmp = {};
  for (const v of Object.keys(best)) cmp[v + '_minus_team_only'] = diffCI(holdW.perGame[v + '@' + best[v]], holdW.perGame.team_only);
  cmp.rapm_box_minus_rapm_zero = diffCI(holdW.perGame['rapm_box@' + best.rapm_box], holdW.perGame['rapm_zero@' + best.rapm_zero]);
  cmp.rapm_box_prev_minus_rapm_box = diffCI(holdW.perGame['rapm_box_prev@' + best.rapm_box_prev], holdW.perGame['rapm_box@' + best.rapm_box]);
  console.log('holdout', JSON.stringify(holdW.res), JSON.stringify(cmp));

  // game-level test: impacts fitted before T2 with the chosen variant
  const train = PM.subset(B, (u) => D.G.byId.get(B.units.game[u]).start_ms + C.AVAILABLE_AFTER_MS < T2);
  const box = PM.boxRates(D.NP, T2); const prev = previousSeasonPrior(D.R, 2026);
  const f = fitVariant(train, chosen.variant, chosen.lambda, box, prev).fit;
  const teams = PM.playerTeams(train); const post = PM.teamBlocks(train, f, (pid) => teams[train.index.get(pid)]);
  const impacts = new Map(); const P = train.players.length;
  for (let i = 0; i < P; i++) { const s = post.get(i); impacts.set(train.players[i], { o: f.x[i], d: f.x[P + i], sd_o: s ? s.sd_o : 2, sd_d: s ? s.sd_d : 2 }); }
  const WD = await WF.prepare(); const frozen = JSON.parse(fs.readFileSync(C.PATHS.frozen, 'utf8'));
  const frozenRows = WF.scored(WF.runCandidate(WD, frozen.chosen, 'holdout').rows, 'D1_D1');
  const minutesCfg = MN.tune(D.PG, 2025);
  const avail = availabilityTest(D, impacts, frozenRows, minutesCfg.half_life);
  console.log('availability', JSON.stringify(avail));

  const fullBox = PM.boxRates(D.NP, null);
  const primary = { B, fit: fitVariant(B, chosen.variant, chosen.lambda, fullBox, prev).fit };
  const stab = stability(D, B, chosen.lambda, fullBox, prev);
  const sens = sensitivity(D, primary, chosen.lambda, fullBox, prev);
  console.log('stability', JSON.stringify(stab), 'sensitivity', JSON.stringify(sens));

  const minutesEval = { selection_2025: MN.evaluate(D.PG, 2025, minutesCfg), holdout_2026: MN.evaluate(D.PG, 2026, minutesCfg) };
  console.log('minutes', JSON.stringify(minutesCfg), JSON.stringify(minutesEval.holdout_2026));

  // publisher comparison (descriptive): my season fit vs the publisher's 2026 full-season RAPM
  const pub = new Map(D.R[2026].map((r) => [r.player_id, r])); const exF = PM.exposure(B); const a = []; const b = [];
  for (let i = 0; i < B.players.length; i++) { const p = pub.get(B.players[i]); if (p && exF.offPoss[i] >= 500) { a.push(primary.fit.x[i] + primary.fit.x[B.players.length + i]); b.push(p.rapm_net); } }

  const rec = {
    schema: 'edgedesk_ncaam_player_validation_v1', checkpoints: { tuning: ['2026-01-15', '2026-02-15'], holdout_from: '2026-02-15' },
    possession_level: { tuning: tuneW.res, chosen, holdout: holdW.res, holdout_comparisons: cmp, train_possessions: { tuning: tuneW.train_possessions, holdout: holdW.train_possessions }, test_possessions: { tuning: tuneW.test_possessions, holdout: holdW.test_possessions }, note: 'squared error per possession on the points-per-100 scale; lineups on the floor are known after the fact' },
    game_level_availability: avail,
    stability: stab, sensitivity: sens,
    minutes_and_rates: { chosen_on_2025: { half_life_games: minutesCfg.half_life, k_position_minutes: minutesCfg.k_pos, k_previous_season_minutes: minutesCfg.k_prev }, scores: minutesEval },
    publisher_rapm_2026_correlation: { players: a.length, corr_net: U.r(U.corr(a, b), 3), note: 'descriptive: the publisher fit uses the same possessions (full season)' },
  };
  fs.mkdirSync(C.PATHS.out, { recursive: true });
  fs.writeFileSync(C.PATHS.outFile('validation_player.json'), JSON.stringify(rec, null, 1) + '\n');
  console.log('wrote validation_player.json');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { load, previousSeasonPrior, fitVariant, teamOnly, T1, T2 };
