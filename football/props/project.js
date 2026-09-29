/* ===========================================================================
   PLAYER PROPS — one game, as of one timestamp, to projection records.
   docs/player-props/MODEL.md

   projectGame(data, ctx) reads the dataset strictly before ctx.asOfMs,
   builds both teams' engine inputs (football/props/model.js), runs the
   Monte Carlo (football/props/engine.js) and returns one projection record
   per (player, prop type): the stored distribution, its summary, the
   opportunity and efficiency estimates behind it, the drivers and risks in
   deterministic sentences, the inputs reliability is scored from, and the
   model version and input hash that make it reproducible.

   The same function serves the live build (ctx.env from EdgeDesk's NFL game
   model) and the walk-forward backtest (ctx.env from the leak-free points
   history), so what is validated is what ships.
   =========================================================================== */
'use strict';
const P = require('../../lib/edgedesk_props.js');
const E = require('./engine.js');
const M = require('./model.js');
const { isNum, clamp, r, ms, before, index, tgKey } = M;

const MODEL_VERSION = { NFL: 'NFL_PLAYER_PROPS_V1.0', CFB: 'CFB_PLAYER_PROPS_V1.0' };
const FEATURE_VERSION = { NFL: 'props_nfl_fv1', CFB: 'props_cfb_fv1' };
const PROPS_BY_POS = {
  QB: ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_int', 'rush_yds', 'rush_att', 'pass_rush_yds', 'longest_cmp', 'anytime_td'],
  RB: ['rush_yds', 'rush_att', 'receptions', 'rec_yds', 'targets', 'rush_rec_yds', 'anytime_td', 'longest_rush', 'longest_rec'],
  WR: ['rec_yds', 'receptions', 'targets', 'rush_rec_yds', 'anytime_td', 'longest_rec'],
  TE: ['rec_yds', 'receptions', 'targets', 'anytime_td', 'longest_rec']
};
const SIM_STAT = { pass_yds: 'pass_yds', pass_att: 'pass_att', pass_cmp: 'pass_cmp', pass_tds: 'pass_tds', pass_int: 'pass_int', rush_yds: 'rush_yds', rush_att: 'rush_att', pass_rush_yds: 'pass_rush_yds',
  longest_cmp: 'longest_cmp', anytime_td: 'anytime_td', receptions: 'receptions', rec_yds: 'rec_yds', targets: 'targets', rush_rec_yds: 'rush_rec_yds', longest_rush: 'longest_rush', longest_rec: 'longest_rec' };
/* the box-score value a prop settles on (grading and the baseline) */
const ACTUAL = {
  pass_yds: (x) => x.pass_yds, pass_att: (x) => x.att, pass_cmp: (x) => x.cmp, pass_tds: (x) => x.pass_td, pass_int: (x) => x.int,
  rush_yds: (x) => x.rush_yds, rush_att: (x) => x.car, pass_rush_yds: (x) => x.pass_yds + x.rush_yds, receptions: (x) => x.rec, rec_yds: (x) => x.rec_yds,
  targets: (x) => x.tgt, rush_rec_yds: (x) => x.rush_yds + x.rec_yds, anytime_td: (x) => (x.rush_td + x.rec_td) >= 1 ? 1 : 0,
  longest_rec: (x) => (x.rec > 0 ? x.long_rec : 0), longest_rush: (x) => (x.car > 0 ? x.long_rush : 0), longest_cmp: (x) => (x.cmp > 0 ? x.long_cmp : 0)
};
/* the sample a stable estimate of each prop needs (reliability's sample_size) */
const SAMPLE_NEED = { rec: 60, rush: 90, pass: 250 };
function sampleKind(prop) { return /^pass|longest_cmp/.test(prop) ? 'pass' : (/rush_att|rush_yds|longest_rush/.test(prop) ? 'rush' : 'rec'); }

function name(data, gsis) { const p = data.players.get(gsis); return p ? p.name : gsis; }
function pos(data, gsis, fallback) { const p = data.players.get(gsis); return (p && p.pos_group) || data.positions.get(gsis) || fallback || null; }
function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
function f1(x) { return isNum(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—'; }

/* ---------------------------------------------------------- candidates */
function candidates(data, team, asOfMs, season, lg) {
  const ix = index(data);
  const rows = before(ix.byTeam.get(team) || [], asOfMs);
  const curGames = [...new Set(rows.filter((x) => x.season === season).map((x) => x.game_id))];
  const recentGames = new Set((curGames.length >= 2 ? curGames : [...new Set(rows.map((x) => x.game_id))]).slice(0, 4));
  const c = new Map();
  rows.forEach((x) => {
    if (!recentGames.has(x.game_id)) return;
    const o = c.get(x.gsis) || { gsis: x.gsis, pos: pos(data, x.gsis, x.pos), recent_snaps: 0, recent_touches: 0, games: 0 };
    o.recent_snaps += x.snaps || 0; o.recent_touches += x.tgt + x.car + x.att; o.games++;
    c.set(x.gsis, o);
  });
  const D = require('./nfl_data.js');
  const snap = data.depth ? D.depthAsOf(data.depth, team, asOfMs) : null;
  const lim = { QB: 2, RB: 3, WR: 5, TE: 3 };
  if (snap) Object.keys(lim).forEach((p) => snap.ranks[p].slice(0, lim[p]).forEach((e) => { if (!c.has(e.g)) c.set(e.g, { gsis: e.g, pos: p, recent_snaps: 0, recent_touches: 0, games: 0, depth_only: true }); }));
  /* a player whose latest game was for another club, and who is not on this
     club's chart, has moved: he is not a candidate here */
  for (const [g, o] of [...c]) {
    if (!/^(QB|RB|WR|TE)$/.test(o.pos || '')) { c.delete(g); continue; }
    const last = before(ix.byPlayer.get(g) || [], asOfMs)[0];
    const onChart = snap && ['QB', 'RB', 'WR', 'TE'].some((p) => snap.ranks[p].some((e) => e.g === g));
    if (last && last.team !== team && !onChart) c.delete(g);
  }
  return { list: [...c.values()], depth_snapshot_at: snap ? new Date(snap.dt).toISOString() : null };
}

/* the quarterback expected to start: the game model's own starter when it
   names one, else the depth chart's QB1, else who took the snaps lately */
function startingQb(data, team, asOfMs, season, cands, hint) {
  const ix = index(data);
  const tgs = before(ix.tgByTeam.get(team) || [], asOfMs).slice(0, 2);
  const tally = new Map();
  tgs.forEach((t) => (ix.pgByGame.get(t.game_id) || []).forEach((x) => { if (x.team === team && x.pos === 'QB') tally.set(x.gsis, (tally.get(x.gsis) || 0) + x.att + x.sacks + (x.scr || 0)); }));
  const recent = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const D = require('./nfl_data.js');
  const snap = data.depth ? D.depthAsOf(data.depth, team, asOfMs) : null;
  const chart = snap && snap.ranks.QB[0] ? snap.ranks.QB[0].g : null;
  const id = hint || chart || (recent ? recent[0] : null);
  return { id, recent: recent ? recent[0] : null, chart, source: hint ? 'EdgeDesk game model starter' : (chart ? 'depth chart QB1' : 'most recent dropbacks'), changed: !!(id && recent && id !== recent[0]) };
}

/* QB passing quality for a QB-change factor: completion rate and yards per
   attempt, both shrunk toward the league */
function qbQuality(data, gsis, asOfMs, season, lg) {
  const h = before(index(data).byPlayer.get(gsis) || [], asOfMs).filter((x) => x.att > 0 && x.season >= season - 2);
  const w = M.weights(h, 12, season);
  let a = 0, c = 0, y = 0;
  h.forEach((x, i) => { a += w[i] * x.att; c += w[i] * x.cmp; y += w[i] * x.pass_yds; });
  const qbAll = data.playerGames.filter((x) => x.pos === 'QB' && x.att > 0 && x.season === season - 1);
  const lgC = qbAll.length ? qbAll.reduce((t, x) => t + x.cmp, 0) / Math.max(1, qbAll.reduce((t, x) => t + x.att, 0)) : 0.64;
  const lgY = qbAll.length ? qbAll.reduce((t, x) => t + x.pass_yds, 0) / Math.max(1, qbAll.reduce((t, x) => t + x.att, 0)) : 6.7, k = 300;
  return { cmp: (c + k * lgC) / (a + k), ypa: (y + k * lgY) / (a + k), att: a };
}

/* =============================================================== TEAM */
function teamInput(data, ctx, side) {
  const g = ctx.game, lg = ctx.lg, season = ctx.season, asOf = ctx.asOfMs;
  const team = side === 'home' ? g.home : g.away, opp = side === 'home' ? g.away : g.home;
  const env = ctx.env, sign = side === 'home' ? 1 : -1;
  const expM = sign * env.margin, pts = side === 'home' ? env.home_points : env.away_points;
  const cand = candidates(data, team, asOf, season, lg);
  const roles = M.roleOrder(data, team, asOf, season, cand.list);
  const qb = startingQb(data, team, asOf, season, cand.list, ctx.starters && ctx.starters[side]);
  const volPrior = M.teamVolumePrior(data, team, asOf, season) || { plays: lg.plays, neutral_pass_rate: lg.neutral_pass_rate, n: 0 };
  const oppPlays = M.defensePlaysPrior(data, opp, asOf, season) || { plays_allowed: lg.plays, n: 0 };
  const def = M.defenseFactors(data, opp, asOf, season, lg);
  const V = lg.volume;
  /* volume: the fitted regression, else the league (named in the drivers) */
  const playsMean = V.plays ? V.plays.coef[0] + V.plays.coef[1] * volPrior.plays + V.plays.coef[2] * oppPlays.plays_allowed + V.plays.coef[3] * env.total + V.plays.coef[4] * expM : lg.plays;
  const prMean = V.pass_rate ? V.pass_rate.coef[0] + V.pass_rate.coef[1] * volPrior.neutral_pass_rate + V.pass_rate.coef[2] * expM : lg.pass_rate;
  const prNeutral = V.pass_rate ? V.pass_rate.coef[0] + V.pass_rate.coef[1] * volPrior.neutral_pass_rate : lg.pass_rate;
  const prScript = V.pass_rate ? V.pass_rate.coef[3] : -0.004;
  const prSd = V.pass_rate ? Math.sqrt(Math.max(0.0004, V.pass_rate.resid_sd * V.pass_rate.resid_sd - prMean * (1 - prMean) / Math.max(40, playsMean))) : 0.04;
  const playsSd = V.plays ? V.plays.resid_sd : 7;
  const untargeted = volPrior.untargeted_raw != null ? (volPrior.att_w * volPrior.untargeted_raw + 150 * lg.untargeted_rate) / (volPrior.att_w + 150) : lg.untargeted_rate;
  const passTdShare = volPrior.pass_td_share_raw != null ? (volPrior.tds_w * volPrior.pass_td_share_raw + 8 * lg.pass_td_share) / (volPrior.tds_w + 8) : lg.pass_td_share;
  const wind = ctx.weather && ctx.weather.outdoor && (ctx.weather.windy || (isNum(ctx.weather.wind_mph) && ctx.weather.wind_mph >= 15)) ? lg.wind.factor : 1;

  /* ------------------------------------------------ every candidate */
  const people = cand.list.map((c) => {
    const hist = M.playerHistory(data, c.gsis, team, asOf, season);
    const role = roles.order[c.gsis] || { pos: c.pos, rank: 9, source: 'none' };
    const rp = lg.role[c.pos + Math.min(4, role.rank)] || lg.role[c.pos + '4'] || { tgt: 0.02, car: 0.01, snap: 0.2 };
    const tgt = M.shrinkShare(hist.team, data, (x) => x.tgt, 'targets', rp.tgt, season);
    const car = M.shrinkShare(hist.team, data, (x) => (x.des != null ? x.des : x.car), 'designed', rp.car, season);
    /* snap share: weighted mean shrunk to the role's snap share */
    const sw = M.weights(hist.team, 5, season);
    let sa = 0, sW = 0; hist.team.forEach((x, i) => { if (isNum(x.snap_pct)) { sa += sw[i] * x.snap_pct; sW += sw[i]; } });
    const snapShare = (sa + 2 * (rp.snap || 0.3)) / (sW + 2);
    /* red-zone shares, shrunk to the player's own overall share */
    let rzA = 0, rzB = 0, rcA = 0, rcB = 0;
    hist.team.forEach((x, i) => { const tg = data.teamGames.get(tgKey(x.game_id, team)); if (!tg) return; rzA += sw[i] * (x.rz_tgt || 0); rzB += sw[i] * (tg.rz_targets || 0); rcA += sw[i] * (x.rz_car || 0); rcB += sw[i] * (tg.rz_designed || 0); });
    const rzT = (rzA + 10 * tgt.mean) / (rzB + 10), rzC = (rcA + 8 * car.mean) / (rcB + 8);
    const L = lg.pos[c.pos] || lg.pos.WR;
    const catchR = M.shrinkRate(hist.all, (x) => x.rec, (x) => x.tgt, L.catch_rate || 0.62, M.CFG.prior_strength.catch_tgt, season);
    const ypr = M.shrinkMean(hist.all, (x) => x.rec_yds, (x) => x.rec, L.ypr || 10.5, M.CFG.prior_strength.ypr_catch, season, 9);
    const ypcPrior = c.pos === 'QB' ? (lg.pools.rush_qb_designed ? lg.pools.rush_qb_designed.mean : 4.5) : (c.pos === 'RB' ? (L.ypc || 4.3) : (lg.pools.rush_wr ? lg.pools.rush_wr.mean : 6.5));
    const ypc = M.shrinkMean(hist.all, (x) => (x.des_yds != null ? x.des_yds : x.rush_yds), (x) => (x.des != null ? x.des : x.car), ypcPrior, M.CFG.prior_strength.ypc_car, season, 5.5);
    const av = M.availability(data, season, g.week, team, c.gsis, lg, asOf);
    /* third-down and air-yard context for the opportunity panel */
    let td3 = 0, tgA = 0, air = 0; hist.team.forEach((x) => { td3 += x.third_tgt || 0; tgA += x.tgt; air += x.rec_air || 0; });
    /* career (all earlier games) efficiency, for "above career baseline" */
    const careerYpr = (() => { const h = hist.all.filter((x) => x.season < season); const a = h.reduce((t, x) => t + x.rec_yds, 0), b = h.reduce((t, x) => t + x.rec, 0); return b >= 15 ? a / b : null; })();
    const careerYpc = (() => { const h = hist.all.filter((x) => x.season < season); const a = h.reduce((t, x) => t + (x.des_yds != null ? x.des_yds : x.rush_yds), 0), b = h.reduce((t, x) => t + (x.des != null ? x.des : x.car), 0); return b >= 30 ? a / b : null; })();
    return { id: c.gsis, gsis: c.gsis, name: name(data, c.gsis), pos: c.pos, rank: role.rank, role_source: role.source, hist, rp,
      tgt, car, snap: snapShare, rz_tgt: rzT, rz_car: rzC, catch: catchR, ypr, ypc, avail: av, third_down_tgt_share: tgA ? td3 / tgA : null, adot: tgA ? air / tgA : null,
      new_to_team: hist.team.length === 0, games_team: hist.team.length, games_all: hist.all.length, career_ypr: careerYpr, career_ypc: careerYpc };
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  /* the quarterback */
  const qbP = qb.id ? byId.get(qb.id) || null : null;
  const qbHist = qb.id ? before(index(data).byPlayer.get(qb.id) || [], asOf).filter((x) => x.season >= season - 1) : [];
  const QK = M.CFG.prior_strength;
  const qbW = M.weights(qbHist, 9, season);
  let qa = 0, qdb = 0, qs = 0, qscr = 0, qi = 0, qsy = 0;
  qbHist.forEach((x, i) => { const db = x.att + x.sacks + (x.scr || 0); qa += qbW[i] * x.att; qdb += qbW[i] * db; qs += qbW[i] * x.sacks; qscr += qbW[i] * (x.scr || 0); qi += qbW[i] * x.int; qsy += qbW[i] * (x.scr_yds || 0); });
  const sackRate = (qs + QK.sack_db * lg.sack_rate) / (qdb + QK.sack_db) * (def.sack_factor || 1);
  const scrRate = (qscr + QK.scr_db * lg.scramble_rate) / (qdb + QK.scr_db);
  const intRate = (qi + QK.int_att * lg.int_rate) / (qa + QK.int_att) * (def.int_factor || 1);
  const scrYpc = (qsy + 40 * lg.scramble_ypc) / (qscr + 40);
  /* a quarterback change moves every receiver's catch rate and yards */
  let qbFactor = { catch: 1, yds: 1, text: null };
  if (qb.changed && qb.recent) {
    const nq = qbQuality(data, qb.id, asOf, season, lg), oq = qbQuality(data, qb.recent, asOf, season, lg);
    qbFactor = { catch: clamp(nq.cmp / oq.cmp, 0.8, 1.2), yds: clamp((nq.ypa / nq.cmp) / (oq.ypa / oq.cmp), 0.8, 1.2), text: name(data, qb.id) + ' projected to start instead of ' + name(data, qb.recent) };
  }

  /* ------------------------------------------ receivers and rushers */
  const isQbStarter = (p) => p.id === qb.id;
  let rec = people.filter((p) => p.pos !== 'QB' && (p.tgt.mean >= M.CFG.min_share.tgt || (p.pos === 'WR' && p.rank <= 3) || (p.pos === 'TE' && p.rank <= 2) || (p.pos === 'RB' && p.rank <= 2)));
  let rush = people.filter((p) => (p.pos === 'RB' && (p.car.mean >= M.CFG.min_share.car || p.rank <= 3)) || isQbStarter(p) || (p.pos === 'WR' && p.car.mean >= 0.03));
  if (qb.id && !byId.has(qb.id)) {
    /* a starter with no games for this club (a signing, a rookie): he rushes on a role prior */
    const rp = lg.role.QB1 || { car: 0.08 };
    const ghost = { id: qb.id, gsis: qb.id, name: name(data, qb.id), pos: 'QB', rank: 1, role_source: 'depth_chart', hist: { all: qbHist, team: [] }, rp,
      tgt: { mean: 0, sd: 0 }, car: { mean: rp.car || 0.08, sd: 0.04, raw: null, season: null, last3: null, n_eff: 0, cv: null }, snap: 0.99, rz_tgt: 0, rz_car: rp.car || 0.08,
      catch: { mean: 0 }, ypr: { mean: 0 }, ypc: M.shrinkMean(qbHist, (x) => x.des_yds || 0, (x) => x.des || 0, lg.pools.rush_qb_designed ? lg.pools.rush_qb_designed.mean : 4.5, 90, season, 5.5),
      avail: M.availability(data, season, g.week, team, qb.id, lg, asOf), new_to_team: true, games_team: 0, games_all: qbHist.length };
    people.push(ghost); byId.set(qb.id, ghost); rush.push(ghost);
  }
  const redis = [];
  function applyAbsences(list, kind) {
    const shareOf = (p) => (kind === 'tgt' ? p.tgt : p.car);
    const L = list.map((p) => ({ id: p.id, pos: p.pos, rank: p.rank, share: { mean: shareOf(p).mean, sd: shareOf(p).sd }, p_active: p.avail.p_active, person: p }));
    /* plans for every player who may not play */
    L.forEach((x, i) => {
      if (!(x.p_active < 1)) return;
      const emp = M.empiricalWithout(data, team, x.id, L, asOf, season, kind === 'tgt' ? (row) => row.tgt : (row) => (row.des != null ? row.des : row.car), kind === 'tgt' ? 'targets' : 'designed');
      const plan = M.redistributionPlan(L, i, kind, emp);
      x.plan = plan;
    });
    /* OUT players leave deterministically; their share goes where the plan says */
    const out = L.filter((x) => x.p_active === 0);
    out.forEach((x) => {
      const give = x.share.mean;
      const conf = { HIGH: 0.15, MEDIUM: 0.3, LOW: 0.5 }[x.plan.confidence];
      x.plan.plan.forEach(([j, f]) => {
        const y = L[j]; if (!y || y.p_active === 0) return;
        y.share.mean += give * f; y.share.sd = Math.sqrt(y.share.sd * y.share.sd + Math.pow(give * f * conf, 2));
        (y.gains = y.gains || []).push({ from: x.id, from_name: x.person.name, from_pos: x.pos, share: give * f, confidence: x.plan.confidence, basis: x.plan.basis });
      });
      redis.push({ kind, player_id: x.id, name: x.person.name, pos: x.pos, status: 'OUT', share: r(give, 4), confidence: x.plan.confidence, basis: x.plan.basis,
        recipients: x.plan.plan.filter(([j]) => L[j] && L[j].p_active !== 0).map(([j, f]) => ({ player_id: L[j].id, name: L[j].person.name, fraction: r(f, 3) })) });
    });
    const kept = L.filter((x) => x.p_active !== 0);
    /* in-simulation plans for the uncertain, re-indexed onto the kept list */
    kept.forEach((x) => {
      if (x.plan && x.p_active < 1) {
        x.redistribute = x.plan.plan.map(([j, f]) => [kept.indexOf(L[j]), f]).filter(([j]) => j >= 0);
        redis.push({ kind, player_id: x.id, name: x.person.name, pos: x.pos, status: x.person.avail.status, p_active: x.p_active, share: r(x.share.mean, 4), confidence: x.plan.confidence, basis: x.plan.basis,
          recipients: x.redistribute.map(([j, f]) => ({ player_id: kept[j].id, name: kept[j].person.name, fraction: r(f, 3) })) });
      }
    });
    return kept;
  }
  const recK = applyAbsences(rec, 'tgt');
  const rushK = applyAbsences(rush, 'car');
  const pos3 = (p) => (def.pos[p.pos] || { ypt_factor: 1, catch_factor: 1 });
  const receivers = recK.map((x) => {
    const p = x.person, d0 = pos3(p);
    const cm = clamp(p.catch.mean * d0.catch_factor, 0.25, 0.92);
    const yprM = p.ypr.mean * (d0.ypt_factor / Math.max(0.5, d0.catch_factor));
    return { id: x.id, pos: p.pos, share: x.share, catch: { mean: cm, sd: p.catch.sd }, ypr: { mean: yprM, sd: Math.min(0.2, p.ypr.sd / Math.max(1, p.ypr.mean) * 3) },
      pool: p.pos === 'TE' ? 'TE' : (p.pos === 'RB' ? 'RB' : 'WR'), rz_share: Math.max(0.001, p.rz_tgt), p_active: x.p_active, redistribute: x.redistribute || [], _gains: x.gains || [] };
  });
  const rushers = rushK.map((x) => {
    const p = x.person;
    return { id: x.id, pos: p.pos, share: x.share, ypc: { mean: p.ypc.mean, sd: Math.min(0.2, p.ypc.sd / Math.max(1, p.ypc.mean) * 2) },
      pool: p.pos === 'QB' ? 'rush_qb_designed' : (p.pos === 'WR' ? 'rush_wr' : 'rush_rb'), rz_share: Math.max(0.001, p.rz_car), p_active: x.p_active, redistribute: x.redistribute || [], _gains: x.gains || [] };
  });
  const tgtTracked = receivers.reduce((t, x) => t + x.share.mean, 0), carTracked = rushers.reduce((t, x) => t + x.share.mean, 0);
  const rzTracked = receivers.reduce((t, x) => t + x.rz_share, 0), rzcTracked = rushers.reduce((t, x) => t + x.rz_share, 0);
  const T = {
    team, side,
    plays: { mean: playsMean, sd: playsSd, script: 0, total: 0 },
    pass_rate: { mean: clamp(prMean, 0.3, 0.8), script: prScript, sd: prSd },
    sack_rate: clamp(sackRate, 0.02, 0.14), untargeted_rate: clamp(untargeted, 0.01, 0.12),
    eff: { pass: wind * qbFactor.yds, catch: qbFactor.catch, rush: def.rush.ypc_factor || 1, pass_sd: 0.08, rush_sd: 0.10 },
    qb: qb.id ? { id: qb.id, scramble_rate: clamp(scrRate, 0.005, 0.15), int_rate: clamp(intRate, 0.008, 0.05), scramble_ypc: scrYpc, rz_scramble_share: 0.02 } : null,
    receivers, rushers,
    other: { tgt_share: Math.max(0.03, 1 - tgtTracked), car_share: Math.max(0.01, 1 - carTracked), catch: (lg.pos.WR.catch_rate || 0.62) * 0.95, ypr: lg.pos.WR.ypr || 11, rz_tgt_share: Math.max(0.02, 1 - rzTracked), rz_car_share: Math.max(0.02, 1 - rzcTracked) },
    alpha: { tgt: lg.alpha.tgt, car: lg.alpha.car },
    td: { per_game: Math.max(0.3, pts * lg.td_per_point), yards_mean: null, elasticity: 1.0, pass_share: clamp(passTdShare, 0.3, 0.85), pass_share_script: 1.0 }
  };
  /* expected volume (analytic), for the drivers and the TD elasticity anchor */
  const eDb = T.plays.mean * T.pass_rate.mean, eSack = eDb * T.sack_rate, eScr = (eDb - eSack) * (T.qb ? T.qb.scramble_rate : 0);
  const eAtt = eDb - eSack - eScr, eTgt = eAtt * (1 - T.untargeted_rate), eDes = T.plays.mean - eDb;
  const eRecYds = receivers.reduce((t, x) => t + x.share.mean * eTgt * x.catch.mean * T.eff.catch * x.ypr.mean * T.eff.pass, 0) + T.other.tgt_share * eTgt * T.other.catch * T.other.ypr * T.eff.pass;
  const eRushYds = rushers.reduce((t, x) => t + x.share.mean * eDes * x.ypc.mean * T.eff.rush, 0) + T.other.car_share * eDes * 4.2 + eScr * scrYpc;
  T.td.yards_mean = Math.max(150, eRecYds + eRushYds);
  const expected = { plays: T.plays.mean, dropbacks: eDb, attempts: eAtt, targets: eTgt, designed_runs: eDes, sacks: eSack, scrambles: eScr, pass_rate: T.pass_rate.mean, neutral_pass_rate: prNeutral, team_points: pts, yards: T.td.yards_mean,
    team_avg_plays: volPrior.plays, team_avg_targets: null };
  /* the team's own average targets per game (for the volume driver) */
  const tgs = before(index(data).tgByTeam.get(team) || [], asOf).filter((t) => t.season >= season - 1).slice(0, 8);
  expected.team_avg_targets = tgs.length ? tgs.reduce((t, x) => t + x.targets, 0) / tgs.length : null;
  expected.team_avg_att = tgs.length ? tgs.reduce((t, x) => t + x.att, 0) / tgs.length : null;
  expected.team_avg_designed = tgs.length ? tgs.reduce((t, x) => t + x.designed, 0) / tgs.length : null;
  return { T, meta: { team, opp, side, exp_margin: expM, points: pts, qb, qbFactor, def, volPrior, oppPlays, wind, people, byId, redistribution: redis, expected, depth_snapshot_at: cand.depth_snapshot_at, n_team_games: tgs.length } };
}

/* ============================================================== GAME */
function stripT(T) { return { plays: T.plays, pass_rate: T.pass_rate, sack: T.sack_rate, eff: T.eff, rec: T.receivers.map((x) => [x.id, r(x.share.mean, 4), r(x.catch.mean, 3), r(x.ypr.mean, 2), x.p_active]), rush: T.rushers.map((x) => [x.id, r(x.share.mean, 4), r(x.ypc.mean, 2), x.p_active]) }; }

function baseRecord(ctx, league, mv, g, meta, p, prop, inputsHash) {
  const pl = ctx.data ? ctx.data.players.get(p.id) : null;
  const rec = { schema: 'edgedesk_prop_projection_v1', league, season: ctx.season, week: g.week, game_id: g.game_id, kickoff: g.kickoff,
    player_id: ctx.idOf ? ctx.idOf(p.id) : p.id, provider_ids: { gsis: league === 'NFL' ? p.id : null, espn: pl && pl.espn_id ? pl.espn_id : (league === 'CFB' ? p.id : null) },
    player_name: p.name, position: p.pos, team: meta.team, opponent: meta.opp, home_away: meta.side, prop_type: prop,
    tier: P.tierOf(prop, p.pos), model_version: mv, feature_version: FEATURE_VERSION[league], as_of: new Date(ctx.asOfMs).toISOString(), inputs_hash: inputsHash,
    status: null, missing: [], dist: null, summary: null,
    availability: { status: p.avail.status, p_active: p.avail.p_active, basis: p.avail.basis, conditional_on_playing: p.avail.p_active < 1 },
    qb_unconfirmed: !!(ctx.qb_unresolved && ctx.qb_unresolved[meta.side]) && (/^pass|longest_cmp/.test(prop) || p.pos === 'WR' || p.pos === 'TE' || (p.pos === 'RB' && /rec|targets/.test(prop))) };
  rec.projection_id = 'pp_' + P.hash([mv, league, g.game_id, rec.player_id, prop, inputsHash].join('|'), 16);
  return rec;
}
/* hard gaps block a projection (INSUFFICIENT DATA); soft ones lower reliability */
function missingFor(ctx, meta, p, prop) {
  const hard = [], soft = [];
  const recv = /rec|targets|receptions/.test(prop), rushP = /rush/.test(prop) && !/rec/.test(prop), pass = /^pass|longest_cmp/.test(prop);
  if (p.games_all === 0 && p.role_source !== 'depth_chart') hard.push('NO_USAGE_HISTORY');
  if (p.games_all === 0 && p.role_source === 'depth_chart') soft.push('NO_USAGE_HISTORY_DEPTH_ONLY');
  if (p.new_to_team && p.games_all > 0) soft.push('NEW_TO_TEAM');
  if (recv && p.tgt.n_eff < 20 && p.games_team > 0) soft.push('THIN_TARGET_SAMPLE');
  if (rushP && p.car.n_eff < 20 && p.games_team > 0) soft.push('THIN_CARRY_SAMPLE');
  if (meta.n_team_games < 2) soft.push('THIN_TEAM_HISTORY');
  if (!meta.depth_snapshot_at) soft.push('NO_DEPTH_CHART');
  if (ctx.env.source !== 'edgedesk_model') soft.push('ENVIRONMENT_NOT_EDGEDESK_MODEL');
  if (!ctx.weather || !ctx.weather.known) soft.push('NO_FORECAST');
  if (meta.def.n_games < 3) soft.push('THIN_OPPONENT_DATA');
  if (pass && !meta.qb.id) hard.push('NO_STARTING_QB');
  if (p.avail.status === 'QUESTIONABLE' || p.avail.status === 'DOUBTFUL' || p.avail.status === 'UNRESOLVED') soft.push('PLAYER_' + p.avail.status);
  return { hard, soft };
}

/* ------------------------------------------------ drivers and risks */
function attachExplanation(rec, ctx, meta, p, prop, lg) {
  const drivers = [], risks = [];
  const x = meta.expected, pt = P.propType(prop);
  const recv = /rec_yds|receptions|targets|longest_rec|rush_rec/.test(prop);
  const rushP = /^rush|longest_rush|rush_rec/.test(prop);
  const pass = /^pass|longest_cmp/.test(prop);
  const yards = pt.kind === 'yards' || pt.kind === 'longest';
  const sm = rec.summary;
  const tgtExp = p.tgt.mean * x.targets, carExp = p.car.mean * x.designed_runs;
  /* opportunity */
  if (recv) {
    const rp = (meta.people.find((q) => q.id === p.id) || p);
    drivers.push({ kind: 'opportunity', effect: 0, text: 'Target share projected at ' + pct(p.tgt.mean) + ' (season ' + pct(p.tgt.season) + ', last 3 ' + pct(p.tgt.last3) + '): ' + f1(tgtExp) + ' expected targets' });
    if (isNum(p.snap)) drivers.push({ kind: 'opportunity', effect: 0, text: 'Snap share projected at ' + pct(p.snap, 0) + (p.pos === 'WR' ? ' (route participation estimated from snaps)' : '') });
  }
  if (rushP && p.pos !== 'QB') drivers.push({ kind: 'opportunity', effect: 0, text: 'Carry share projected at ' + pct(p.car.mean) + ' of designed runs (season ' + pct(p.car.season) + ', last 3 ' + pct(p.car.last3) + '): ' + f1(carExp) + ' expected carries' });
  if (pass) drivers.push({ kind: 'opportunity', effect: 0, text: 'Projected ' + f1(x.attempts) + ' pass attempts on ' + f1(x.plays) + ' plays (' + pct(x.pass_rate, 0) + ' dropback rate)' });
  /* volume vs the team's own norm */
  if ((recv || pass) && isNum(x.team_avg_att)) {
    const d = x.attempts - x.team_avg_att;
    if (Math.abs(d) >= 1.5) drivers.push({ kind: 'volume', effect: d * (recv ? p.tgt.mean * (yards ? p.catch.mean * p.ypr.mean : 1) : (yards ? 6.5 : 0.62)), material: 1,
      text: 'Expected passing volume ' + (d > 0 ? 'above' : 'below') + ' the team norm: ' + f1(x.attempts) + ' attempts vs ' + f1(x.team_avg_att) + ' recently' });
  }
  if (rushP && isNum(x.team_avg_designed)) {
    const d = x.designed_runs - x.team_avg_designed;
    if (Math.abs(d) >= 1.5) drivers.push({ kind: 'volume', effect: d * p.car.mean * (yards ? p.ypc.mean : 1), material: 1, text: 'Expected designed runs ' + (d > 0 ? 'above' : 'below') + ' the team norm: ' + f1(x.designed_runs) + ' vs ' + f1(x.team_avg_designed) });
  }
  /* game script */
  const em = meta.exp_margin;
  if (Math.abs(em) >= 2.5) {
    const passDir = em < 0 ? 1 : -1;
    const eff = (recv || pass) ? passDir : (rushP ? -passDir : 0);
    drivers.push({ kind: 'script', effect: eff * 2, material: 1, text: 'Game script: ' + meta.team + ' projected to ' + (em > 0 ? 'lead' : 'trail') + ' by ' + f1(Math.abs(em)) + ' (EdgeDesk game model), which ' + (em > 0 ? 'tilts volume toward the run' : 'adds passing volume') });
  }
  if (Math.abs(em) >= 9 && em > 0) risks.push('Blowout risk: a ' + f1(em) + '-point projected lead can reduce fourth-quarter volume for starters');
  /* redistribution gains and pending absences */
  const recIn = (ctxTeam(meta).receivers || []).find((q) => q.id === p.id), rushIn = (ctxTeam(meta).rushers || []).find((q) => q.id === p.id);
  if (recv && recIn) recIn._gains.filter((gn) => gn.share * x.targets >= 0.3).forEach((gn) => drivers.push({ kind: 'availability', effect: gn.share * x.targets * (yards ? p.catch.mean * p.ypr.mean : 1), material: 0.5,
    text: gn.from_name + ' (' + gn.from_pos + ') out: +' + f1(gn.share * x.targets) + ' expected targets (' + gn.confidence.toLowerCase() + ' confidence: ' + gn.basis + ')' }));
  if (rushP && rushIn) rushIn._gains.filter((gn) => gn.share * x.designed_runs >= 0.3).forEach((gn) => drivers.push({ kind: 'availability', effect: gn.share * x.designed_runs * (yards ? p.ypc.mean : 1), material: 0.5,
    text: gn.from_name + ' (' + gn.from_pos + ') out: +' + f1(gn.share * x.designed_runs) + ' expected carries (' + gn.confidence.toLowerCase() + ' confidence)' }));
  meta.redistribution.filter((d) => d.status !== 'OUT' && d.player_id !== p.id && d.share >= 0.04 && d.recipients.some((q) => q.player_id === p.id && q.fraction >= 0.05)).forEach((d) => {
    risks.push(d.name + ' is ' + String(d.status).toLowerCase() + ' (' + pct(d.p_active, 0) + ' historical play-through): usage here rises if he sits');
  });
  if (p.avail.status === 'QUESTIONABLE' || p.avail.status === 'DOUBTFUL') risks.push(p.name + ' is listed ' + p.avail.status.toLowerCase() + ': the distribution is conditional on playing, and a limited snap count is possible');
  if (p.avail.status === 'UNRESOLVED') risks.push('Availability unresolved: ' + p.avail.basis + '. The distribution is conditional on playing');
  if (meta.redistribution.some((d) => d.status === 'OUT' && d.confidence === 'LOW' && d.share >= 0.04 && d.recipients.some((q) => q.player_id === p.id && q.fraction >= 0.05))) risks.push('Redistribution confidence is LOW: no games on file without the absent player');
  /* opponent */
  const dp = meta.def.pos[p.pos];
  if (recv && dp && isNum(dp.ypt_allowed) && Math.abs(dp.ypt_factor - 1) >= 0.04) drivers.push({ kind: 'matchup', effect: (dp.ypt_factor - 1) * (yards ? tgtExp * p.catch.mean * p.ypr.mean : tgtExp * 0.3), material: 1,
    text: meta.opp + ' allows ' + f1(dp.ypt_allowed) + ' yards per target to ' + p.pos + 's (league ' + f1(dp.lg_ypt) + '; shrunk factor ' + dp.ypt_factor.toFixed(2) + ')' });
  if (rushP && p.pos !== 'QB' && isNum(meta.def.rush.ypc_allowed) && Math.abs(meta.def.rush.ypc_factor - 1) >= 0.04) drivers.push({ kind: 'matchup', effect: (meta.def.rush.ypc_factor - 1) * carExp * p.ypc.mean, material: 1,
    text: meta.opp + ' allows ' + f1(meta.def.rush.ypc_allowed) + ' yards per RB carry (league ' + f1(meta.def.rush.lg_ypc) + '; shrunk factor ' + meta.def.rush.ypc_factor.toFixed(2) + ')' });
  if (pass && Math.abs((meta.def.sack_factor || 1) - 1) >= 0.08) drivers.push({ kind: 'matchup', effect: -(meta.def.sack_factor - 1) * 2, material: 1, text: meta.opp + ' sack rate ' + (meta.def.sack_factor > 1 ? 'above' : 'below') + ' league (factor ' + meta.def.sack_factor.toFixed(2) + ')' });
  /* weather and the quarterback */
  if (meta.wind !== 1 && (recv || pass) && ctx.weather && ctx.weather.wind_mph) drivers.push({ kind: 'weather', effect: (meta.wind - 1) * 10, material: 1, text: 'Wind ' + Math.round(ctx.weather.wind_mph) + ' mph forecast: passing yards factor ' + meta.wind.toFixed(2) + ' (measured in windy outdoor games)' });
  if (meta.qbFactor.text && (recv || pass)) drivers.push({ kind: 'qb', effect: (meta.qbFactor.yds * meta.qbFactor.catch - 1) * 10, material: 0.5, text: 'QB change: ' + meta.qbFactor.text + ' (catch factor ' + meta.qbFactor.catch.toFixed(2) + ', yards-per-catch factor ' + meta.qbFactor.yds.toFixed(2) + ')' });
  if (rec.qb_unconfirmed) risks.push('The starting quarterback is not confirmed');
  /* efficiency: shrinkage in plain words, and the career baseline */
  if (recv && p.pos !== 'QB') {
    drivers.push({ kind: 'context', effect: 0, text: 'Catch rate ' + pct(p.catch.mean, 0) + (isNum(p.catch.raw) ? ' (' + pct(p.catch.raw, 0) + ' observed on ' + Math.round(p.catch.n) + ' weighted targets, shrunk toward the ' + p.pos + ' prior)' : ' (position prior)') + '; ' + f1(p.ypr.mean) + ' yards per catch' + (isNum(p.adot) ? '; aDOT ' + f1(p.adot) : '') });
    if (isNum(p.career_ypr) && p.ypr.mean > p.career_ypr * 1.08 && /yds|longest/.test(prop)) risks.push('Yards-per-catch projection (' + f1(p.ypr.mean) + ') is above his earlier-season baseline (' + f1(p.career_ypr) + ')');
  }
  if (rushP && p.pos !== 'QB') {
    drivers.push({ kind: 'context', effect: 0, text: 'Yards per carry ' + f1(p.ypc.mean) + (isNum(p.ypc.raw) ? ' (' + f1(p.ypc.raw) + ' observed on ' + Math.round(p.ypc.n) + ' weighted carries, shrunk toward the league)' : '') });
    if (isNum(p.career_ypc) && p.ypc.mean > p.career_ypc * 1.08 && /yds|longest/.test(prop)) risks.push('Yards-per-carry projection (' + f1(p.ypc.mean) + ') is above his earlier-season baseline (' + f1(p.career_ypc) + ')');
  }
  /* recency: the last-3 figure next to the projection, never chased */
  const hist = p.hist.team.length ? p.hist.team : p.hist.all;
  const act = ACTUAL[prop];
  const l3 = hist.slice(0, 3).map(act).filter(isNum);
  if (l3.length === 3 && sm) {
    const avg = l3.reduce((t, v) => t + v, 0) / 3;
    rec.recent = { last3: r(avg, 1), season: r(seasonAvg(hist, act, ctx.season), 1), games: hist.slice(0, 5).map((x) => ({ week: x.week, season: x.season, opp: x.opp, value: act(x) })) };
    if (Math.abs(avg - sm.mean) > 0.25 * Math.max(1, sm.sd)) drivers.push({ kind: 'context', effect: 0, text: 'Last 3 games average ' + f1(avg) + ' against a projection of ' + f1(sm.mean) + ': recent form is shrunk toward the longer record rather than chased' });
  } else if (sm) rec.recent = { last3: l3.length ? r(l3.reduce((t, v) => t + v, 0) / l3.length, 1) : null, season: r(seasonAvg(hist, act, ctx.season), 1), games: hist.slice(0, 5).map((x) => ({ week: x.week, season: x.season, opp: x.opp, value: act(x) })) };
  if (p.games_team <= 2 && p.games_team > 0) risks.push('Small sample with this team: ' + p.games_team + ' game' + (p.games_team === 1 ? '' : 's'));
  if (p.new_to_team) risks.push('No games with ' + meta.team + ' on file: usage comes from the role prior');
  if (isNum(p.tgt.cv) && p.tgt.cv > 0.45 && recv) risks.push('Role volatility: weekly target share varies (CV ' + p.tgt.cv.toFixed(2) + ')');
  if (ctx.env.source !== 'edgedesk_model') risks.push('Game environment from ' + (ctx.env.source === 'market_reference' ? 'the market reference line' : 'EdgeDesk’s points history') + ', not EdgeDesk’s game model');
  rec.drivers = drivers;
  rec.risks = risks;
  /* opportunity panel: expected vs season / last 3 / last 5 */
  rec.opportunity = {
    team_plays: r(x.plays, 1), team_dropbacks: r(x.dropbacks, 1), team_attempts: r(x.attempts, 1), team_designed_runs: r(x.designed_runs, 1), pass_rate: r(x.pass_rate, 3),
    snap_share: r(p.snap, 3), expected_snaps: r(p.snap * x.plays, 1), route_estimate: p.pos === 'WR' || p.pos === 'TE' ? r(p.snap * x.dropbacks, 1) : null, route_basis: 'snap share × team dropbacks (participation data for this season is not yet published)',
    target_share: r(p.tgt.mean, 4), target_share_sd: r(p.tgt.sd, 4), expected_targets: r(tgtExp, 2), carry_share: r(p.car.mean, 4), expected_carries: r(carExp, 2),
    rz_target_share: r(p.rz_tgt, 4), rz_carry_share: r(p.rz_car, 4), third_down_target_share: r(p.third_down_tgt_share, 3),
    season: { target_share: r(p.tgt.season, 4), carry_share: r(p.car.season, 4) }, last3: { target_share: r(p.tgt.last3, 4), carry_share: r(p.car.last3, 4) },
    role: { rank: p.rank, source: p.role_source, prior_target_share: r(p.rp.tgt, 4), prior_carry_share: r(p.rp.car, 4) },
    expected_attempts: p.pos === 'QB' ? r(x.attempts, 1) : null
  };
  rec.efficiency = { catch_rate: r(p.catch.mean, 4), catch_rate_raw: r(p.catch.raw, 4), yards_per_catch: r(p.ypr.mean, 2), yards_per_catch_raw: r(p.ypr.raw, 2), yards_per_carry: r(p.ypc.mean, 2), yards_per_carry_raw: r(p.ypc.raw, 2), adot: r(p.adot, 2), targets_weighted: r(p.catch.n, 1), carries_weighted: r(p.ypc.n, 1) };
  /* the Marcel-style baseline and the reliability inputs */
  const rp = p.rp || {};
  const base = rec.baseline && isNum(rec.baseline.mean) ? rec.baseline.mean : M.baseline(hist, act, isNum(sm && sm.mean) ? sm.mean : 0, ctx.season);
  rec.baseline = { mean: r(base, 2), basis: 'recency-weighted per-game average shrunk toward the projection’s role mean (Marcel-style)' };
  const kind = sampleKind(prop);
  const sampleN = kind === 'rec' ? p.tgt.n_eff * p.tgt.mean : (kind === 'rush' ? p.car.n_eff * p.car.mean : p.hist.all.reduce((t, y) => t + y.att, 0));
  const teamUnc = meta.redistribution.filter((d) => d.status !== 'OUT' && d.player_id !== p.id).reduce((t, d) => t + d.share * (1 - d.p_active), 0);
  const affected = meta.redistribution.filter((d) => d.recipients.some((q) => q.player_id === p.id));
  const conf = affected.length ? Math.min.apply(null, affected.map((d) => ({ HIGH: 0.9, MEDIUM: 0.65, LOW: 0.4 }[d.confidence]))) : 1;
  const comp = [meta.n_team_games >= 2, !!meta.depth_snapshot_at, ctx.env.source === 'edgedesk_model' ? 1 : 0.5, ctx.weather && ctx.weather.known ? 1 : 0.5, meta.def.n_games >= 3 ? 1 : 0.5, p.games_all > 0 ? 1 : 0, !p.new_to_team ? 1 : 0.5];
  rec.reliability_inputs = { league: ctx.league || 'NFL', data_completeness: r(comp.reduce((t, v) => t + (v === true ? 1 : v === false ? 0 : v), 0) / comp.length, 3),
    sample_n: r(sampleN, 1), sample_needed: SAMPLE_NEED[kind], role_cv: r(kind === 'rush' ? p.car.cv : p.tgt.cv, 3), player_status: p.avail.status, teammate_uncertainty: r(clamp(teamUnc * 3, 0, 1), 3),
    qb_unconfirmed: rec.qb_unconfirmed, model_disagreement_z: sm && sm.sd > 0 ? r((sm.mean - base) / sm.sd, 3) : null, cv: sm && sm.mean > 0 ? r(sm.sd / sm.mean, 3) : null, redistribution_confidence: conf };
}
function ctxTeam(meta) { return meta._T || {}; }
function seasonAvg(hist, act, season) { const v = hist.filter((x) => x.season === season).map(act).filter(isNum); return v.length ? v.reduce((t, y) => t + y, 0) / v.length : null; }

function correlate(sim, records) {
  const PAIRS = [['pass_yds', 'rec_yds'], ['pass_cmp', 'receptions'], ['pass_att', 'rush_att'], ['rush_yds', 'pass_att'], ['pass_yds', 'rush_yds'], ['rec_yds', 'rec_yds'], ['rush_yds', 'rec_yds'], ['pass_tds', 'anytime_td']];
  const main = records.filter((x) => x.status === 'PROJECTED' && /^(pass_yds|pass_att|pass_cmp|pass_tds|rush_yds|rush_att|rec_yds|receptions|anytime_td)$/.test(x.prop_type));
  const top = {};
  main.forEach((x) => { const k = x.team + '|' + x.prop_type; (top[k] = top[k] || []).push(x); });
  Object.keys(top).forEach((k) => top[k].sort((a, b) => (b.summary.mean || 0) - (a.summary.mean || 0)).splice(3));
  const list = [].concat.apply([], Object.keys(top).map((k) => top[k]));
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.player_id === b.player_id && a.prop_type === b.prop_type) continue;
    const ok = PAIRS.some(([x, y]) => (a.prop_type === x && b.prop_type === y) || (a.prop_type === y && b.prop_type === x));
    if (!ok) continue;
    const sa = sim.players[a._sim_id], sb = sim.players[b._sim_id];
    if (!sa || !sb) continue;
    const rho = E.spearman(sa[SIM_STAT[a.prop_type]], sb[SIM_STAT[b.prop_type]]);
    if (rho == null || Math.abs(rho) < 0.05) continue;
    out.push({ a: a.projection_id, b: b.projection_id, a_label: a.player_name + ' ' + a.prop_type, b_label: b.player_name + ' ' + b.prop_type, rho: r(rho, 3), same_team: a.team === b.team });
  }
  return out.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho)).slice(0, 60);
}
function envSummary(ctx, h, a) {
  return { source: ctx.env.source, detail: ctx.env.detail || null, home_margin: r(ctx.env.margin, 2), total: r(ctx.env.total, 2), home_points: r(ctx.env.home_points, 2), away_points: r(ctx.env.away_points, 2),
    margin_sd: r(ctx.env.margin_sd, 2), total_sd: r(ctx.env.total_sd, 2), weather: ctx.weather || null, model_version: ctx.env.model_version || null };
}
function teamSummary(meta, T) {
  const x = meta.expected;
  return { team: meta.team, opponent: meta.opp, side: meta.side, points: r(meta.points, 2), expected_margin: r(meta.exp_margin, 2), plays: r(x.plays, 1), pass_rate: r(x.pass_rate, 3), neutral_pass_rate: r(x.neutral_pass_rate, 3),
    attempts: r(x.attempts, 1), targets: r(x.targets, 1), designed_runs: r(x.designed_runs, 1), sacks: r(x.sacks, 2), scrambles: r(x.scrambles, 2), yards: r(x.yards, 1),
    starting_qb: meta.qb.id ? { player_id: meta.qb.id, source: meta.qb.source, changed: meta.qb.changed } : null, qb_factor: meta.qbFactor,
    opponent_factors: { pos: meta.def.pos, rush: meta.def.rush, sack_factor: meta.def.sack_factor, int_factor: meta.def.int_factor, n_games: meta.def.n_games },
    redistribution: meta.redistribution, depth_snapshot_at: meta.depth_snapshot_at };
}

/* teamInput attaches T to meta so the explanation can read the lists */
function teamInputWithT(data, ctx, side) { const out = teamInput(data, ctx, side); out.meta._T = out.T; return out; }

function projectGame(data, ctx) {
  ctx.data = data;
  const league = ctx.league || 'NFL';
  const g = ctx.game;
  ctx.season = ctx.season || g.season;
  const H = teamInputWithT(data, ctx, 'home'), A = teamInputWithT(data, ctx, 'away');
  const modelVersion = ctx.model_version || MODEL_VERSION[league];
  /* DETERMINISTIC: the seed and every id are keyed on the inputs, never the
     clock, so identical inputs reproduce the identical distribution (and an
     unchanged slate rewrites nothing) */
  const inputsHash = P.hash(P.canonical({ env: ctx.env, home: stripT(H.T), away: stripT(A.T), lg: [ctx.lg.n_team_games, ctx.lg.n_player_games], sims: ctx.sims || M.CFG.sims }), 16);
  const input = { game_id: g.game_id, seed: g.game_id + '|' + modelVersion + '|' + inputsHash, sims: ctx.sims || M.CFG.sims,
    margin: { mean: ctx.env.margin, sd: ctx.env.margin_sd }, total: { mean: ctx.env.total, sd: ctx.env.total_sd }, teams: { home: H.T, away: A.T } };
  const t0 = Date.now();
  const sim = E.simulate(input, ctx.lg.pools_raw, { sims: input.sims });
  const records = [];
  [H, A].forEach((side) => {
    const meta = side.meta;
    meta.people.forEach((p) => {
      const simO = sim.players[p.id];
      const props = PROPS_BY_POS[p.pos] || [];
      if (p.pos === 'QB' && p.id !== meta.qb.id) return;
      const status = p.avail.status;
      props.forEach((prop) => {
        if (prop === 'rush_rec_yds' && p.pos === 'WR' && !(p.car.mean >= 0.03)) return;
        if (!simO && status !== 'OUT') return;
        const rec = baseRecord(ctx, league, modelVersion, g, meta, p, prop, inputsHash);
        rec._sim_id = p.id;
        if (status === 'OUT') { rec.status = 'PLAYER_OUT'; rec.missing = ['PLAYER_OUT']; records.push(rec); return; }
        const vals = simO[SIM_STAT[prop]];
        const arr = [];
        for (let i = 0; i < vals.length; i++) if (!isNaN(vals[i])) arr.push(prop === 'anytime_td' ? Math.min(1, vals[i]) : vals[i]);
        if (arr.length < 500) { rec.status = 'INSUFFICIENT_DATA'; rec.missing = [arr.length ? 'SIMULATION_SAMPLE' : 'NO_PROJECTED_ROLE']; records.push(rec); return; }
        rec.dist = P.encodeDist(arr);
        rec.summary = P.summarize(rec.dist);
        rec.sims_used = arr.length;
        if (ctx.calibration) {
          const hist0 = p.hist.team.length ? p.hist.team : p.hist.all;
          rec.baseline = { mean: r(M.baseline(hist0, ACTUAL[prop], rec.summary.mean, ctx.season), 2) };
          require('./calibrate.js').apply(rec, ctx.calibration);
        }
        const miss = missingFor(ctx, meta, p, prop);
        rec.missing = miss.hard; rec.soft_missing = miss.soft;
        rec.status = miss.hard.length ? 'INSUFFICIENT_DATA' : 'PROJECTED';
        attachExplanation(rec, ctx, meta, p, prop, ctx.lg);
        records.push(rec);
      });
    });
  });
  const correlations = correlate(sim, records);
  records.forEach((x) => { delete x._sim_id; });
  return { game_id: g.game_id, league, model_version: modelVersion, as_of: new Date(ctx.asOfMs).toISOString(), sims: input.sims, seed: sim.seed, sim_ms: Date.now() - t0, inputs_hash: inputsHash,
    environment: envSummary(ctx, H.meta, A.meta), teams: { home: teamSummary(H.meta, H.T), away: teamSummary(A.meta, A.T) }, records, correlations };
}

module.exports = { projectGame, MODEL_VERSION, FEATURE_VERSION, PROPS_BY_POS, ACTUAL, SIM_STAT, teamInput: teamInputWithT, startingQb, candidates, sampleKind };
